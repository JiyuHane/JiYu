import { APP_VERSION } from '@snowluma/common/version';
import { isProxy } from 'node:util/types';
import {
    IOneBotNetworkAdapter,
    type AdapterStatus,
    type NetworkAdapterContext,
    type NetworkReloadType,
} from '../network';
import { V12Transport } from '../v12-network';
import { V12Dispatcher } from '../v12/dispatcher';
import {
    isV12SealableFileUrl,
    V12ImageFileTokens,
    V12VideoFileTokens,
    V12VoiceFileTokens,
} from '../v12/image-file-token';
import {
    convertV11Event,
    createConnectEvent,
    createHeartbeatEvent,
    createStatusUpdateEvent,
    V12UnsupportedEventError,
} from '../v12/events';
import { V12UploadedDataStore } from '../v12/uploaded-data-store';
import type { V12FileLease, V12Self } from '../v12/types';
import type { JsonObject } from '../types';
import { safeV12Error, V12_ADAPTER_NAME, type V12ManagedConfig } from './identity';
import {
    convertPrivateRecallEvent,
    matchesPrivateRecallEvent,
    type PrivateRecallProvenance,
} from './private-recall-source';
import {
    captureBinding,
    claimOrderedScope,
    failOrderedAdmission,
    receiveSourceEvent,
    registerOrderedRuntime,
    revokeOrderedTarget,
    skipOrderedAdmission,
    verifySource,
    type V12Source,
} from './source-generation';
import type { DispatchPayload } from '../event-filter';
import {
    activateHttpPollOwner,
    enqueuePollEvent,
    failOrderedPollIngress,
    hasHttpPollOwner,
    hasOrderedPollOwner,
    invalidatePollOwner,
    invalidateStalePollOwner,
    pollOwnerStats,
    recordPreparedScopeLoss,
    registerPollHost,
    type PollActivation,
    type PollGate,
} from './poll-owner';

const apply = Reflect.apply;

// Local per-event admission limits, not QQ or OneBot protocol limits.
const MAX_INBOUND_MEDIA_SEGMENTS = 128;
const MAX_INBOUND_MEDIA_URL_BYTES = 256 * 1024;

type HttpPollDiagnostic =
    | 'unavailable'
    | 'cleanup_pending'
    | 'degraded'
    | 'full'
    | 'dropped_oldest'
    | 'too_large'
    | 'invalid'
    | 'private_recall'
    | 'transport_error'
    | 'delivery_uncertain'
    | 'closing_discard';

type UploadGeneration = { readonly token: object; valid: boolean };
type UploadSlot = {
    readonly generation: UploadGeneration;
    readonly transport: V12Transport;
    readonly store: V12UploadedDataStore;
};

function hasFriendRecallType(event: JsonObject): boolean {
    try {
        if (isProxy(event)) {
            return false;
        }

        const post = Object.getOwnPropertyDescriptor(event, 'post_type');
        const notice = Object.getOwnPropertyDescriptor(event, 'notice_type');
        return (
            post !== undefined &&
            'value' in post &&
            post.value === 'notice' &&
            notice !== undefined &&
            'value' in notice &&
            notice.value === 'friend_recall'
        );
    } catch {
        return false;
    }
}

/** A v12 listener participates in the same network manager FIFO as v11. */
export class V12Runtime extends IOneBotNetworkAdapter<V12ManagedConfig> {
    private readonly self: V12Self;
    private readonly version = { impl: 'jiyu', version: APP_VERSION };
    private readonly dispatcher: V12Dispatcher;
    private imageFileTokens: V12ImageFileTokens | null = null;
    #voiceFileTokens: V12VoiceFileTokens | null = null;
    #videoFileTokens: V12VideoFileTokens | null = null;
    #uploadGeneration: UploadGeneration | null = null;
    #uploadSlot: UploadSlot | null = null;
    private readonly subscribers = new Set<(event: unknown) => void>();
    private readonly subscriberGenerations = new Map<(event: unknown) => void, object>();
    private readonly heartbeatEnableReloadScopes = new Set<{
        readonly transport: V12Transport | null;
        readonly token: object | null;
    }>();
    readonly #sourceScopes: Array<{
        event: JsonObject;
        payload: DispatchPayload;
        source: V12Source;
        privateRecallOwner?: object;
    }> = [];
    readonly #privateRecallInFlight = new WeakSet<object>();
    readonly #privateRecallPublished = new WeakMap<object, V12Source>();
    private statusEmitting = false;
    private statusPending = false;
    private statusImmediate: ReturnType<typeof setImmediate> | null = null;
    private heartbeatEmitting = false;
    private heartbeat: {
        transport: V12Transport;
        token: object;
        epoch: object;
        timer: ReturnType<typeof setInterval>;
    } | null = null;
    private transport: V12Transport | null = null;
    private currentStatusTransportToken: object | null = null;
    private openingOwner: object | null = null;
    private closeRevision: object = {};
    private sourceAttempt: object | null = null;
    private sourceBinding: object | null = null;
    private accepting = true;
    private pollActivationChecking = false;
    // Fixed diagnostic categories bound logging work even under repeated loss.
    private readonly pollDiagnostics = new Set<HttpPollDiagnostic>();

    constructor(
        config: V12ManagedConfig,
        ctx: NetworkAdapterContext,
        private readonly options: {
            getStatus: () => { good: boolean; online: boolean };
            getSentMessageTime: (id: number) => Promise<number | null>;
            trackAction: <T>(label: string, start: () => Promise<T>) => Promise<T>;
            canAccept: () => boolean;
            isSourceCurrent?: (source: V12Source | undefined, binding: object | null) => boolean;
            captureCurrentSource?: () => V12Source | undefined;
            getPrivateRecallSource?: (event: JsonObject) => PrivateRecallProvenance | undefined;
            pollGate?: PollGate | null;
        },
    ) {
        super(V12_ADAPTER_NAME, config, ctx);
        this.self = Object.freeze({ platform: 'qq', user_id: ctx.uin });

        // Explicit null means the manager could not allocate a shared gate.
        // Do not fall back to a new per-instance gate in that case.
        if (options.pollGate !== null) {
            registerPollHost(
                this,
                {
                    self: this.self,
                    captureBinding: () => this[captureBinding](),
                    captureSource: () => this.options.captureCurrentSource?.(),
                    verify: (source) => this[verifySource](source),
                    onClosingDiscard: () => this.warnHttpPoll('closing_discard'),
                },
                options.pollGate,
            );
        }

        this.dispatcher = new V12Dispatcher({
            self: this.self,
            version: this.version,
            api: ctx.api,
            getStatus: options.getStatus,
            getSentMessageTime: options.getSentMessageTime,
            resolveImageFileUrl: (fileId) => {
                const tokens = this.imageFileTokens;

                if (!tokens || !this.isEnabled || !this.accepting) {
                    return null;
                }

                const url = tokens.redeem(fileId);
                return this.imageFileTokens === tokens && this.isEnabled && this.accepting
                    ? url
                    : null;
            },
            resolveVoiceFileUrl: (fileId) => {
                const tokens = this.#voiceFileTokens;

                if (!tokens || !this.isEnabled || !this.accepting) {
                    return null;
                }

                const url = tokens.redeem(fileId);
                return this.#voiceFileTokens === tokens && this.isEnabled && this.accepting
                    ? url
                    : null;
            },
            resolveVideoFileUrl: (fileId) => {
                const tokens = this.#videoFileTokens;

                if (!tokens || !this.isEnabled || !this.accepting) {
                    return null;
                }

                const url = tokens.redeem(fileId);
                return this.#videoFileTokens === tokens && this.isEnabled && this.accepting
                    ? url
                    : null;
            },
            isUploadDataSupported: (lease) => {
                const generation = this.#uploadGeneration;
                const transport = this.transport;

                // A failed close can leave a listener running, but its retired
                // file lease must never be recreated for that same generation.
                return (
                    generation !== null &&
                    transport !== null &&
                    this.isUploadLeaseCurrent(lease, generation, transport)
                );
            },
            uploadDataFile: (name, data, sha256, lease) => {
                const slot = this.acquireUploadSlot(lease);

                if (!slot) {
                    return { kind: 'unavailable' };
                }

                const current = () => this.isUploadSlotCurrent(slot, lease);

                try {
                    if (!current()) {
                        return { kind: 'unavailable' };
                    }

                    const result = slot.store.upload(name, data, sha256, current);
                    return current() ? result : { kind: 'unavailable' };
                } catch {
                    return { kind: 'unavailable' };
                }
            },
            getUploadedDataFile: (fileId, lease) => {
                const slot = this.acquireUploadSlot(lease);

                if (!slot) {
                    return { kind: 'unavailable' };
                }

                const current = () => this.isUploadSlotCurrent(slot, lease);

                try {
                    if (!current()) {
                        return { kind: 'unavailable' };
                    }

                    const result = slot.store.get(fileId, current);
                    return current() ? result : { kind: 'unavailable' };
                } catch {
                    return { kind: 'unavailable' };
                }
            },
            getUploadedDataFileMetadata: (fileId, lease) => {
                const slot = this.acquireUploadSlot(lease);

                if (!slot) {
                    return { kind: 'unavailable' };
                }

                const current = () => this.isUploadSlotCurrent(slot, lease);

                try {
                    if (!current()) {
                        return { kind: 'unavailable' };
                    }

                    const result = slot.store.getMetadata(fileId, current);
                    return current() ? result : { kind: 'unavailable' };
                } catch {
                    return { kind: 'unavailable' };
                }
            },
            getUploadedDataFileChunk: (fileId, offset, size, lease) => {
                const slot = this.acquireUploadSlot(lease);

                if (!slot) {
                    return { kind: 'unavailable' };
                }

                const current = () => this.isUploadSlotCurrent(slot, lease);

                try {
                    if (!current()) {
                        return { kind: 'unavailable' };
                    }

                    const result = slot.store.getChunk(fileId, offset, size, current);
                    return current() ? result : { kind: 'unavailable' };
                } catch {
                    return { kind: 'unavailable' };
                }
            },
        });
        registerOrderedRuntime(this, (source) => recordPreparedScopeLoss(this, source));
    }

    protected bindingSignature(config: V12ManagedConfig): string {
        return JSON.stringify([
            config.host,
            config.port,
            config.accessToken,
            config.heartbeat?.enabled === true ? config.heartbeat.interval : null,
        ]);
    }

    override reload(next: V12ManagedConfig): Promise<NetworkReloadType> {
        if (next.heartbeat?.enabled !== true) {
            return super.reload(next);
        }

        return this.withHeartbeatEnableReloadScope(() => super.reload(next));
    }

    override closeForReload(next: V12ManagedConfig): void | Promise<void> {
        if (next.heartbeat?.enabled !== true) {
            return super.closeForReload(next);
        }

        return this.withHeartbeatEnableReloadScope(() => super.closeForReload(next));
    }

    private async withHeartbeatEnableReloadScope<T>(action: () => T | Promise<T>): Promise<T> {
        // Close operates on the old config before the desired config is published.
        // Keep each attempt bound to its original transport, including on failure.
        const scope = { transport: this.transport, token: this.currentStatusTransportToken };
        this.heartbeatEnableReloadScopes.add(scope);

        try {
            return await action();
        } finally {
            this.heartbeatEnableReloadScopes.delete(scope);
        }
    }

    async open(): Promise<void> {
        if (!this.accepting || !this.options.canAccept()) {
            throw new Error('v12 instance is disposing');
        }

        if (this.transport) {
            throw new Error('v12 listener has not been released');
        }

        this.pollDiagnostics.clear();
        const token = {};
        const sourceAttempt = {};
        const uploadGeneration: UploadGeneration = { token, valid: true };
        this.openingOwner = token;
        this.sourceAttempt = sourceAttempt;
        this.sourceBinding = null;
        this.currentStatusTransportToken = token;
        this.#uploadGeneration = uploadGeneration;
        let transport: V12Transport;

        const fileLease = (): boolean => {
            const owns = (): boolean =>
                uploadGeneration.valid &&
                this.#uploadGeneration === uploadGeneration &&
                this.transport !== null &&
                this.transport === transport &&
                this.currentStatusTransportToken === token &&
                this.isEnabled &&
                this.accepting;

            if (!this.uploadTransportReady(transport, owns)) {
                return false;
            }

            try {
                // This callback may synchronously close or replace the listener.
                return (
                    this.options.canAccept() === true && this.uploadTransportReady(transport, owns)
                );
            } catch {
                return false;
            }
        };

        // Capture this exact listener and source attempt, rather than whichever
        // listener happens to be current when a waiting poll resumes.
        const pollLease = (): boolean => {
            const owns = (): boolean =>
                this.transport === transport &&
                this.currentStatusTransportToken === token &&
                this.openingOwner === token &&
                this.sourceAttempt === sourceAttempt &&
                this.sourceBinding === sourceAttempt &&
                this.isEnabled &&
                this.accepting;

            try {
                return owns() && fileLease() && owns();
            } catch {
                return false;
            }
        };

        try {
            transport = new V12Transport({
                host: this.config.host,
                port: this.config.port,
                accessToken: this.config.accessToken,
                handle: (request) =>
                    this.options.trackAction('v12 action', () =>
                        this.dispatcher.handle(request, fileLease),
                    ),
                // HTTP only. supported_actions discovery does not yet advertise polling.
                httpPoll: {
                    run: (input, context) => {
                        if (!fileLease()) {
                            return { kind: 'unavailable' };
                        }

                        try {
                            const checked = this.dispatcher
                                .createInternalHttpPreflight(fileLease)
                                .classify(input);

                            // Preflight can invoke callbacks that retire this listener.
                            if (!fileLease()) {
                                return { kind: 'unavailable' };
                            }

                            if (checked.kind === 'error') {
                                switch (checked.response.message) {
                                    case 'invalid action request':
                                        return { kind: 'preflight', error: 'invalid_request' };
                                    case 'unknown self':
                                        return { kind: 'preflight', error: 'unknown_self' };
                                    case 'invalid poll parameters':
                                        return { kind: 'preflight', error: 'invalid_params' };
                                    case 'unsupported request field':
                                        return { kind: 'preflight', error: 'unsupported_field' };
                                    case 'unsupported parameter':
                                        return {
                                            kind: 'preflight',
                                            error: 'unsupported_parameter',
                                        };
                                    default:
                                        return { kind: 'unavailable' };
                                }
                            }

                            if (checked.kind !== 'poll') {
                                return { kind: 'unavailable' };
                            }

                            // The owner uses a tighter local echo limit than general actions.
                            if (checked.echo !== undefined && checked.echo.length > 4096) {
                                return { kind: 'preflight', error: 'invalid_request' };
                            }

                            const activation = this.activateHttpPoll(fileLease);

                            if (activation.status !== 'ready') {
                                return { kind: 'unavailable' };
                            }

                            // Track the actual transaction through settlement, including
                            // cleanup; no timeout race may release its accounting early.
                            return this.options.trackAction('v12 http poll', async () => {
                                const current = this.activateHttpPoll(fileLease);

                                if (
                                    current.status !== 'ready' ||
                                    current.owner !== activation.owner ||
                                    !fileLease()
                                ) {
                                    return { kind: 'unavailable' } as const;
                                }

                                const outcome = await current.owner.start(
                                    {
                                        limit: checked.limit,
                                        timeoutMs: checked.timeoutSeconds * 1000,
                                        echo: checked.echo,
                                        maxOutputBytes: context.maxOutputBytes,
                                        responseDeadline: context.responseDeadline,
                                        externalAbortSignal: context.signal,
                                    },
                                    context.sink,
                                    pollLease,
                                ).result;

                                // A committed prefix is not requeued after an ambiguous
                                // write. Keep this observable without logging event data.
                                if (
                                    outcome.kind === 'commit_unknown' ||
                                    outcome.kind === 'committed_unsent' ||
                                    (outcome.kind === 'unknown' && outcome.committed) ||
                                    (outcome.kind === 'cleanup_uncertain' &&
                                        outcome.committed !== false)
                                ) {
                                    this.warnHttpPoll('delivery_uncertain');
                                }

                                return { kind: 'outcome', outcome } as const;
                            });
                        } catch {
                            return { kind: 'unavailable' };
                        }
                    },
                },
                getConnectEvent: () => createConnectEvent(this.version),
                subscribe: (listener) => this.subscribeStatus(listener),
                onPollError: () => this.warnHttpPoll('transport_error'),
                onError: (error) => {
                    // A stale error must not revoke a replacement listener's store.
                    if (
                        this.#uploadGeneration === uploadGeneration &&
                        this.currentStatusTransportToken === token
                    ) {
                        this.retireUploadGeneration(uploadGeneration);
                    }

                    // Retire only this transport's timer before any reentrant cleanup.
                    this.cancelHeartbeat(token);

                    if (this.sourceAttempt === sourceAttempt) {
                        this.revokePoll();
                        this.sourceAttempt = null;
                        this.sourceBinding = null;
                    }

                    if (this.currentStatusTransportToken !== token) {
                        return;
                    }

                    this.cancelStatus();
                    this.isEnabled = false;
                    this.recordTransportFailure(new Error(this.cleanError(error)));
                    this.log.error('v12 listener failed: %s', this.cleanError(error));
                },
            });
        } catch (error) {
            this.retireUploadGeneration(uploadGeneration);
            this.cancelHeartbeat(token);

            if (this.sourceAttempt === sourceAttempt) {
                this.sourceAttempt = null;
                this.sourceBinding = null;
            }

            if (this.openingOwner === token) {
                this.openingOwner = null;
            }

            if (this.currentStatusTransportToken === token) {
                this.currentStatusTransportToken = null;
            }

            throw error;
        }

        // Construction can invoke callbacks synchronously. Never publish an
        // abandoned transport over a newer owner created by a reentrant callback.
        if (
            this.openingOwner !== token ||
            this.currentStatusTransportToken !== token ||
            this.transport
        ) {
            this.retireUploadGeneration(uploadGeneration);
            this.cancelHeartbeat(token);

            try {
                await transport.close();
            } catch (error) {
                throw new Error(this.cleanError(error));
            }

            throw new Error('v12 listener opening superseded');
        }

        this.transport = transport;
        const ownsOpening = () =>
            this.transport === transport &&
            this.currentStatusTransportToken === token &&
            this.openingOwner === token;

        try {
            await transport.open();

            if (!this.accepting || !this.options.canAccept()) {
                this.retireUploadGeneration(uploadGeneration);
                this.cancelHeartbeat(token);
                await transport.close();

                if (ownsOpening()) {
                    this.transport = null;
                    this.currentStatusTransportToken = null;
                    this.openingOwner = null;
                }

                throw new Error('v12 instance is disposing');
            }

            // An error during bind can revoke sourceAttempt without changing the
            // opening owner. A heartbeat-enabled binding must not appear active
            // when its timer generation can no longer be established.
            if (
                this.config.heartbeat?.enabled === true &&
                (!ownsOpening() || !this.accepting || this.sourceAttempt !== sourceAttempt)
            ) {
                throw new Error('v12 heartbeat opening superseded');
            }

            if (ownsOpening()) {
                this.isEnabled = true;

                if (this.sourceAttempt === sourceAttempt) {
                    this.sourceBinding = sourceAttempt;
                }

                if (
                    this.isEnabled &&
                    this.accepting &&
                    this.sourceAttempt === sourceAttempt &&
                    this.sourceBinding === sourceAttempt
                ) {
                    this.startHeartbeat(transport, token, sourceAttempt);
                    // Source and listener must both be current. If retirement is
                    // still pending, later events or polls retry without a new gate.
                    this.activateHttpPoll(fileLease);

                    // Poll activation invokes host callbacks. If one closes or replaces
                    // this listener, opening must not report a successful stale binding.
                    if (
                        !ownsOpening() ||
                        !this.accepting ||
                        !this.isEnabled ||
                        this.sourceAttempt !== sourceAttempt ||
                        this.sourceBinding !== sourceAttempt
                    ) {
                        throw new Error('v12 listener opening superseded');
                    }
                }
            }
        } catch (error) {
            this.retireUploadGeneration(uploadGeneration);
            this.cancelHeartbeat(token);

            if (this.sourceAttempt === sourceAttempt) {
                this.sourceAttempt = null;
                this.sourceBinding = null;
            }

            if (ownsOpening()) {
                this.cancelStatus();
                this.isEnabled = false;
            }

            try {
                await transport.close();

                if (ownsOpening()) {
                    this.transport = null;
                    this.currentStatusTransportToken = null;
                    this.openingOwner = null;
                }
            } catch (closeError) {
                throw new Error(
                    `v12 open failed: ${this.cleanError(error)}; cleanup failed: ${this.cleanError(closeError)}`,
                );
            }

            throw new Error(this.cleanError(error));
        }
    }

    async close(): Promise<void> {
        const initialTransport = this.transport;
        const initialToken = this.currentStatusTransportToken;
        const uploadGeneration = this.#uploadGeneration;

        if (uploadGeneration?.token === initialToken) {
            this.retireUploadGeneration(uploadGeneration);
        }

        // Store cleanup and its diagnostic can reenter and install a new listener.
        if (
            this.transport !== initialTransport ||
            this.currentStatusTransportToken !== initialToken
        ) {
            return;
        }

        const heartbeatEnabled =
            this.config.heartbeat?.enabled === true ||
            [...this.heartbeatEnableReloadScopes].some(
                (scope) => scope.transport === initialTransport && scope.token === initialToken,
            );

        if (initialTransport) {
            this.cancelHeartbeat(initialToken);
        } else {
            this.cancelHeartbeat();
        }

        this.revokePoll();

        // Revocation can reenter. An older heartbeat-enabled close must never
        // take ownership of a replacement transport created during that work.
        if (
            heartbeatEnabled &&
            (this.transport !== initialTransport ||
                this.currentStatusTransportToken !== initialToken)
        ) {
            return;
        }

        const transport = this.transport;
        const token = this.currentStatusTransportToken;
        const previousOpeningOwner = this.openingOwner;
        const closeRevision = this.closeRevision;
        this.openingOwner = null;
        this.sourceAttempt = null;
        this.sourceBinding = null;

        if (!transport) {
            this.closeRevision = {};
            this.currentStatusTransportToken = null;
            this.cancelStatus();
            this.isEnabled = false;
            this.subscribers.clear();
            this.subscriberGenerations.clear();
            return;
        }

        const ownsTransport = () =>
            this.transport === transport && this.currentStatusTransportToken === token;

        try {
            transport.quiesce();
        } catch (error) {
            // Source admission remains revoked even when quiesce throws. With
            // heartbeat enabled, quiesce may already have taken partial effect;
            // retain the transport for cleanup without claiming it is active.
            if (ownsTransport()) {
                if (heartbeatEnabled && !this.accepting) {
                    // A nested quiesce/forceClose already revoked acceptance,
                    // even if it also advanced the close revision.
                    this.isEnabled = false;
                    this.cancelStatus();
                } else if (this.closeRevision === closeRevision && this.openingOwner === null) {
                    if (heartbeatEnabled) {
                        this.isEnabled = false;
                        this.cancelStatus();
                    } else if (this.accepting) {
                        this.openingOwner = previousOpeningOwner;
                    }
                }
            }

            throw error;
        }

        if (ownsTransport()) {
            this.closeRevision = {};
            this.cancelHeartbeat(token);
            this.isEnabled = false;
            this.cancelStatus();
        }

        try {
            await transport.close();

            if (ownsTransport()) {
                this.transport = null;
                this.currentStatusTransportToken = null;
                this.subscribers.clear();
                this.subscriberGenerations.clear();
            }
        } catch (error) {
            throw new Error(this.cleanError(error));
        }
    }

    quiesce(): void {
        this.accepting = false;
        const uploadGeneration = this.#uploadGeneration;

        if (uploadGeneration) {
            this.retireUploadGeneration(uploadGeneration);
        }

        this.cancelHeartbeat();
        this.revokePoll();
        this.closeRevision = {};
        this.openingOwner = null;
        this.sourceAttempt = null;
        this.sourceBinding = null;

        this.revokeMediaTokens();
        this.cancelHeartbeat();
        this.cancelStatus();
        this.transport?.quiesce();
    }

    override forceClose(): void {
        this.accepting = false;
        const uploadGeneration = this.#uploadGeneration;

        if (uploadGeneration) {
            this.retireUploadGeneration(uploadGeneration);
        }

        this.cancelHeartbeat();
        this.revokePoll();
        this.closeRevision = {};
        this.openingOwner = null;
        this.sourceAttempt = null;
        this.sourceBinding = null;

        this.revokeMediaTokens();
        this.cancelHeartbeat();
        this.cancelStatus();
        this.transport?.forceClose();
    }

    /** Activate only through this runtime's registered gate and current listener. */
    private activateHttpPoll(guard: () => boolean): PollActivation {
        if (this.pollActivationChecking) {
            return { status: 'unavailable' };
        }

        this.pollActivationChecking = true;

        try {
            const transport = this.transport;
            const token = this.currentStatusTransportToken;
            const attempt = this.sourceAttempt;

            const unavailable = (): PollActivation => {
                this.warnHttpPoll('unavailable');
                return { status: 'unavailable' };
            };

            if (!transport || !token || !attempt) {
                return unavailable();
            }

            const owns = (): boolean =>
                this.transport === transport &&
                this.currentStatusTransportToken === token &&
                this.openingOwner === token &&
                this.sourceAttempt === attempt &&
                this.sourceBinding === attempt &&
                this.isEnabled &&
                this.accepting;
            const usable = (): boolean =>
                owns() &&
                guard() &&
                owns() &&
                this.uploadTransportReady(transport, owns) &&
                this.options.canAccept() === true &&
                owns() &&
                guard() &&
                owns();

            if (!usable()) {
                return unavailable();
            }

            // The registered host captures and verifies the source; the production
            // verifier requires it to be online for this exact binding.
            const activation = activateHttpPollOwner(this);

            // Host callbacks during activation may retire or replace this binding.
            if (!usable()) {
                return unavailable();
            }

            if (activation.status !== 'ready') {
                this.warnHttpPoll(activation.status);
            }

            return activation;
        } catch {
            this.warnHttpPoll('unavailable');
            return { status: 'unavailable' };
        } finally {
            this.pollActivationChecking = false;
        }
    }

    [captureBinding](): object | null {
        return this.isEnabled && this.accepting && this.options.canAccept()
            ? this.sourceBinding
            : null;
    }

    private isSourceCurrent(source: V12Source | undefined): boolean {
        try {
            return this.options.isSourceCurrent?.(source, this[captureBinding]()) ?? false;
        } catch {
            return false;
        }
    }

    [verifySource](source: V12Source | undefined): boolean {
        return this.isSourceCurrent(source);
    }

    override [receiveSourceEvent](
        event: JsonObject,
        payload: DispatchPayload,
        source: V12Source,
    ): void | Promise<void> {
        this.#sourceScopes.push({ event, payload, source });

        try {
            return this.onEvent(event, payload);
        } finally {
            this.#sourceScopes.pop();
        }
    }

    onEvent(event: JsonObject, payload?: DispatchPayload): void {
        if (this.#privateRecallInFlight.has(event)) {
            const duplicate = claimOrderedScope(this, 'runtime', event);

            if (duplicate) {
                skipOrderedAdmission(duplicate);
            }

            return;
        }

        let owned = false;

        const claimPrivateRecall = (): boolean => {
            if (owned) {
                return true;
            }

            if (this.#privateRecallInFlight.has(event)) {
                return false;
            }

            this.#privateRecallInFlight.add(event);
            owned = true;
            return true;
        };

        const friendRecall = hasFriendRecallType(event);

        if (friendRecall && !claimPrivateRecall()) {
            const duplicate = claimOrderedScope(this, 'runtime', event);

            if (duplicate) {
                skipOrderedAdmission(duplicate);
            }

            return;
        }

        try {
            this.handleEvent(event, payload, friendRecall, claimPrivateRecall);
        } finally {
            if (owned) {
                this.#privateRecallInFlight.delete(event);
            }
        }
    }

    private handleEvent(
        event: JsonObject,
        payload: DispatchPayload | undefined,
        friendRecall: boolean,
        claimPrivateRecall: () => boolean,
    ): void {
        const currentScope = this.#sourceScopes.at(-1);
        const scope =
            currentScope?.event === event && currentScope.payload === payload
                ? currentScope
                : undefined;
        let privateRecallOwner: object | undefined;

        if (scope?.privateRecallOwner !== undefined) {
            const duplicate = claimOrderedScope(this, 'runtime', event);

            if (duplicate) {
                skipOrderedAdmission(duplicate);
            }

            return;
        }

        if (friendRecall && scope) {
            privateRecallOwner = {};
            scope.privateRecallOwner = privateRecallOwner;
        }

        if (!friendRecall && scope) {
            const eventSource = scope.source;
            const ownsSourceScope = (): boolean =>
                this.#sourceScopes.at(-1) === scope &&
                scope.event === event &&
                scope.payload === payload &&
                scope.source === eventSource &&
                this.isEnabled &&
                this.accepting;

            // Capture and verify this event's source before activation. The first
            // event can activate its owner and be enqueued; while an old owner is
            // cleanup_pending this event can instead be lost. Only a later event
            // or poll retries, so no continuity across that wait is implied.
            this.activateHttpPoll(
                () => ownsSourceScope() && this.isSourceCurrent(eventSource) && ownsSourceScope(),
            );
        }

        const admission = claimOrderedScope(this, 'runtime', event);

        if (!admission || admission.kind === 'failed') {
            failOrderedPollIngress(this);
        } else if (admission.kind === 'eligible' && admission.target !== this) {
            failOrderedAdmission(admission);
            failOrderedPollIngress(this);
        }

        if (!this.isEnabled || !this.accepting) {
            failOrderedAdmission(admission);
            return;
        }

        const source = scope?.source;

        const sourceScopeCurrent = (): boolean => {
            const ownsScope = (): boolean =>
                scope !== undefined &&
                source !== undefined &&
                this.#sourceScopes.at(-1) === scope &&
                scope.event === event &&
                scope.payload === payload &&
                scope.source === source &&
                this.isEnabled &&
                this.accepting;

            if (!ownsScope()) {
                return false;
            }

            // This verifier correlates the local source epoch, not QQ identity.
            return this.isSourceCurrent(source) && ownsScope();
        };

        try {
            let recallSource: PrivateRecallProvenance | undefined;

            try {
                // Looking up the original object also detects a notice whose type was
                // changed after provenance was recorded. Other event paths remain intact.
                recallSource = this.options.getPrivateRecallSource?.(event);
            } catch (error) {
                if (friendRecall) {
                    throw error;
                }
            }

            const privateRecall = friendRecall || recallSource !== undefined;

            if (privateRecall && !claimPrivateRecall()) {
                if (admission) {
                    skipOrderedAdmission(admission);
                }

                return;
            }

            if (privateRecall && scope && !privateRecallOwner) {
                if (scope.privateRecallOwner !== undefined) {
                    if (admission) {
                        skipOrderedAdmission(admission);
                    }

                    return;
                }

                privateRecallOwner = {};
                scope.privateRecallOwner = privateRecallOwner;
            }

            const recallScopeCurrent = (): boolean => {
                if (
                    !scope ||
                    !privateRecallOwner ||
                    scope.privateRecallOwner !== privateRecallOwner ||
                    source === undefined ||
                    recallSource?.sourceTicket !== source ||
                    this.#sourceScopes.at(-1) !== scope ||
                    scope.event !== event ||
                    scope.payload !== payload ||
                    scope.source !== source ||
                    !this.isEnabled ||
                    !this.accepting
                ) {
                    return false;
                }

                return (
                    this.isSourceCurrent(source) &&
                    this.#sourceScopes.at(-1) === scope &&
                    scope.privateRecallOwner === privateRecallOwner &&
                    this.isEnabled &&
                    this.accepting
                );
            };

            let converted: ReturnType<typeof convertV11Event>;
            let issuedImageIssuer: V12ImageFileTokens | null = null;
            let issuedVoiceIssuer: V12VoiceFileTokens | null = null;
            let issuedVideoIssuer: V12VideoFileTokens | null = null;

            const mediaIssuersCurrent = (): boolean => {
                if (issuedImageIssuer !== null) {
                    // The TS-private image slot is an ordinary own property at
                    // runtime; do not invoke a substituted accessor here.
                    const image = Object.getOwnPropertyDescriptor(this, 'imageFileTokens');

                    if (!image || !('value' in image) || image.value !== issuedImageIssuer) {
                        return false;
                    }
                }

                return (
                    (issuedVoiceIssuer === null || this.#voiceFileTokens === issuedVoiceIssuer) &&
                    (issuedVideoIssuer === null || this.#videoFileTokens === issuedVideoIssuer)
                );
            };

            if (privateRecall) {
                converted =
                    recallSource && recallScopeCurrent()
                        ? convertPrivateRecallEvent(event, this.self, recallSource)
                        : null;

                // Verification may synchronously reenter. Check the same live scope,
                // epoch and original event again after it returns.
                if (
                    converted &&
                    (!recallScopeCurrent() || !matchesPrivateRecallEvent(event, recallSource!))
                ) {
                    converted = null;
                }
            } else {
                // Each synchronous conversion owns its own mixed-media budget.
                let mediaSegments = 0;
                let mediaUrlBytes = 0;
                converted = convertV11Event(event, this.self, {
                    validateMediaFileUrl: (url) => {
                        if (!isV12SealableFileUrl(url)) {
                            return false;
                        }

                        const bytes = Buffer.byteLength(url, 'utf8');

                        if (
                            mediaSegments >= MAX_INBOUND_MEDIA_SEGMENTS ||
                            bytes > MAX_INBOUND_MEDIA_URL_BYTES - mediaUrlBytes
                        ) {
                            return false;
                        }

                        mediaSegments += 1;
                        mediaUrlBytes += bytes;
                        return true;
                    },
                    issueImageFileId: (url) => {
                        // Unlike legacy text input, an image capability is issued
                        // only while the supplied internal source epoch is current.
                        if (!sourceScopeCurrent() || !mediaIssuersCurrent()) {
                            throw new Error('v12 image source unavailable');
                        }

                        if (!this.imageFileTokens) {
                            const candidate = new V12ImageFileTokens(this.self.user_id);

                            if (!sourceScopeCurrent() || !mediaIssuersCurrent()) {
                                candidate.revoke();
                                throw new Error('v12 image source unavailable');
                            }

                            // Verification may reenter and install a different issuer.
                            if (this.imageFileTokens) {
                                candidate.revoke();
                            } else {
                                this.imageFileTokens = candidate;
                            }
                        }

                        const issuer = this.imageFileTokens;

                        if (
                            !issuer ||
                            !sourceScopeCurrent() ||
                            this.imageFileTokens !== issuer ||
                            !mediaIssuersCurrent()
                        ) {
                            throw new Error('v12 image source unavailable');
                        }

                        const fileId = issuer.issue(url);
                        const current = sourceScopeCurrent();

                        if (!current || this.imageFileTokens !== issuer || !mediaIssuersCurrent()) {
                            throw new Error('v12 image source unavailable');
                        }

                        issuedImageIssuer ??= issuer;
                        return fileId;
                    },
                    issueVoiceFileId: (url) => {
                        // Voice uses its own account-instance issuer, but the same
                        // internal source epoch and synchronous scope as images.
                        if (!sourceScopeCurrent() || !mediaIssuersCurrent()) {
                            throw new Error('v12 voice source unavailable');
                        }

                        if (!this.#voiceFileTokens) {
                            const candidate = new V12VoiceFileTokens(this.self.user_id);

                            if (!sourceScopeCurrent() || !mediaIssuersCurrent()) {
                                candidate.revoke();
                                throw new Error('v12 voice source unavailable');
                            }

                            // Verification may reenter and install a different issuer.
                            if (this.#voiceFileTokens) {
                                candidate.revoke();
                            } else {
                                this.#voiceFileTokens = candidate;
                            }
                        }

                        const issuer = this.#voiceFileTokens;

                        if (
                            !issuer ||
                            !sourceScopeCurrent() ||
                            this.#voiceFileTokens !== issuer ||
                            !mediaIssuersCurrent()
                        ) {
                            throw new Error('v12 voice source unavailable');
                        }

                        const fileId = issuer.issue(url);
                        const current = sourceScopeCurrent();

                        if (
                            !current ||
                            this.#voiceFileTokens !== issuer ||
                            !mediaIssuersCurrent()
                        ) {
                            throw new Error('v12 voice source unavailable');
                        }

                        issuedVoiceIssuer ??= issuer;
                        return fileId;
                    },
                    issueVideoFileId: (url) => {
                        // Video uses its own account-instance issuer and the same
                        // internal source epoch and synchronous scope as other media.
                        if (!sourceScopeCurrent() || !mediaIssuersCurrent()) {
                            throw new Error('v12 video source unavailable');
                        }

                        if (!this.#videoFileTokens) {
                            const candidate = new V12VideoFileTokens(this.self.user_id);

                            if (!sourceScopeCurrent() || !mediaIssuersCurrent()) {
                                candidate.revoke();
                                throw new Error('v12 video source unavailable');
                            }

                            // Verification may reenter and install a different issuer.
                            if (this.#videoFileTokens) {
                                candidate.revoke();
                            } else {
                                this.#videoFileTokens = candidate;
                            }
                        }

                        const issuer = this.#videoFileTokens;

                        if (
                            !issuer ||
                            !sourceScopeCurrent() ||
                            this.#videoFileTokens !== issuer ||
                            !mediaIssuersCurrent()
                        ) {
                            throw new Error('v12 video source unavailable');
                        }

                        const fileId = issuer.issue(url);
                        const current = sourceScopeCurrent();

                        if (
                            !current ||
                            this.#videoFileTokens !== issuer ||
                            !mediaIssuersCurrent()
                        ) {
                            throw new Error('v12 video source unavailable');
                        }

                        issuedVideoIssuer ??= issuer;
                        return fileId;
                    },
                });

                // This must precede poll resolution: an already committed item
                // cannot be recalled by the later WebSocket fanout guard.
                if (
                    (issuedImageIssuer !== null ||
                        issuedVoiceIssuer !== null ||
                        issuedVideoIssuer !== null) &&
                    (!sourceScopeCurrent() || !mediaIssuersCurrent())
                ) {
                    throw new Error(
                        issuedImageIssuer !== null
                            ? 'v12 image source unavailable'
                            : issuedVoiceIssuer !== null
                              ? 'v12 voice source unavailable'
                              : 'v12 video source unavailable',
                    );
                }
            }

            if (converted) {
                if (privateRecall) {
                    if (
                        recallSource &&
                        source !== undefined &&
                        recallScopeCurrent() &&
                        matchesPrivateRecallEvent(event, recallSource) &&
                        this.#privateRecallPublished.get(event) !== source
                    ) {
                        const verifiedSource = recallSource;
                        // Mark this local event/ticket attempt before any admission,
                        // subscriber or guard callback can reenter.
                        this.#privateRecallPublished.set(event, source);

                        // The legacy HTTP owner does not enqueue this projection.
                        // Capture the diagnostic before, but log only after WS fanout.
                        const pollMissesRecall = hasHttpPollOwner(this);

                        // Poll delivery has no final guard on the original v11 object.
                        // A genuinely admitted projection must not disappear silently.
                        if (admission?.kind === 'eligible' && admission.target === this) {
                            failOrderedAdmission(admission);
                        } else if (admission) {
                            skipOrderedAdmission(admission);
                        }

                        this.publish(
                            converted,
                            () =>
                                recallScopeCurrent() &&
                                matchesPrivateRecallEvent(event, verifiedSource),
                        );

                        if (pollMissesRecall) {
                            this.warnHttpPoll('private_recall');
                        }
                    } else if (admission) {
                        skipOrderedAdmission(admission);
                    }
                } else {
                    let pollLosses: HttpPollDiagnostic[] = [];

                    try {
                        if (admission?.kind === 'eligible' && admission.target === this) {
                            admission.lease.resolve(converted);
                        } else if (
                            (!admission || admission.kind === 'disabled') &&
                            !hasOrderedPollOwner(this)
                        ) {
                            // Only an unprepared legacy input may use completion-order FIFO.
                            // A proven pre-ready input never enters a later consumer group.
                            pollLosses =
                                issuedImageIssuer !== null ||
                                issuedVoiceIssuer !== null ||
                                issuedVideoIssuer !== null
                                    ? this.enqueuePollWithDiagnostics(
                                          converted,
                                          source,
                                          mediaIssuersCurrent,
                                      )
                                    : this.enqueuePollWithDiagnostics(converted, source);
                        }
                    } catch {
                        failOrderedAdmission(admission);
                        // The optional poll path must never suppress existing fanout.
                    }

                    if (scope && source !== undefined) {
                        // Tickets identify an internal admission epoch; they do not
                        // authenticate the upstream event or same-process callers.
                        const mediaSourceCurrent = (): boolean =>
                            sourceScopeCurrent() && mediaIssuersCurrent();

                        if (mediaSourceCurrent()) {
                            this.publish(converted, mediaSourceCurrent);
                        }
                    } else {
                        this.publish(converted);
                    }

                    // Logger callbacks must not precede the established WS fanout.
                    for (const loss of pollLosses) {
                        this.warnHttpPoll(loss);
                    }
                }
            } else if (admission) {
                skipOrderedAdmission(admission);
            }
        } catch (error) {
            if (error instanceof V12UnsupportedEventError) {
                if (admission) {
                    skipOrderedAdmission(admission);
                }

                this.log.warn('v12 unsupported event: self_sent_message');
            } else {
                failOrderedAdmission(admission);
                this.log.warn('v12 event conversion failed: %s', this.cleanError(error));
            }
        }
    }

    statusUpdate(): void {
        try {
            invalidateStalePollOwner(this);
        } catch {
            // Poll cleanup is independent of the established status path.
        }

        if (!this.isEnabled || !this.accepting) {
            return;
        }

        // A source may become online after the listener opened. Pending cleanup
        // is retried only on a later status, event or poll; it is not bypassed.
        this.activateHttpPoll(() => true);

        if (!this.isEnabled || !this.accepting) {
            return;
        }

        this.statusPending = true;

        if (!this.statusEmitting && !this.statusImmediate) {
            this.flushStatus();
        }
    }

    describeStatus(): AdapterStatus {
        return {
            name: this.name,
            kind: 'httpServer',
            status: this.isEnabled ? 'ok' : 'down',
            detail: this.isEnabled ? 'OneBot v12 HTTP + WebSocket' : 'OneBot v12 未启动',
        };
    }

    override markApplyFailure(error: unknown, at = Date.now()): void {
        super.markApplyFailure(new Error(safeV12Error(error)), at);
    }

    private subscribeStatus(listener: (event: unknown) => void): () => void {
        if (!this.subscribers.has(listener)) {
            this.subscribers.add(listener);
            this.subscriberGenerations.set(listener, {});
        }

        const generation = this.subscriberGenerations.get(listener);
        const ownsLock = !this.statusEmitting;

        if (ownsLock) {
            this.statusEmitting = true;
        }

        try {
            // The transport sends connect before invoking this callback.
            listener(createStatusUpdateEvent(this.self, this.options.getStatus()));
        } catch (error) {
            if (this.subscriberGenerations.get(listener) === generation) {
                this.subscribers.delete(listener);
                this.subscriberGenerations.delete(listener);
            }

            this.warnStatus('v12 initial status unavailable');
            throw error;
        } finally {
            if (ownsLock) {
                this.statusEmitting = false;

                if (this.statusPending && !this.statusImmediate) {
                    this.flushStatus();
                }
            }
        }

        return () => {
            if (this.subscriberGenerations.get(listener) === generation) {
                this.subscribers.delete(listener);
                this.subscriberGenerations.delete(listener);
            }
        };
    }

    private flushStatus(): void {
        if (this.statusEmitting) {
            return;
        }

        this.statusEmitting = true;

        try {
            // Two rounds allow a synchronous trailing offline update, while an
            // adversarial reentrant subscriber cannot monopolize the event loop.
            for (let round = 0; round < 2 && this.statusPending; round++) {
                if (!this.isEnabled || !this.accepting) {
                    this.statusPending = false;
                    break;
                }

                this.statusPending = false;
                const subscribers = [...this.subscribers].map(
                    (listener) => [listener, this.subscriberGenerations.get(listener)] as const,
                );

                try {
                    const event = createStatusUpdateEvent(this.self, this.options.getStatus());

                    for (const [listener, generation] of subscribers) {
                        if (!this.isEnabled || !this.accepting) {
                            break;
                        }

                        if (this.subscriberGenerations.get(listener) !== generation) {
                            continue;
                        }

                        try {
                            listener({
                                ...event,
                                status: {
                                    ...event.status,
                                    bots: event.status.bots.map((bot) => ({
                                        ...bot,
                                        self: { ...bot.self },
                                    })),
                                },
                            });
                        } catch {
                            this.warnStatus('v12 event subscriber failed');
                        }
                    }
                } catch {
                    this.warnStatus('v12 status update unavailable');
                }
            }
        } finally {
            this.statusEmitting = false;
        }

        if (this.statusPending && !this.statusImmediate) {
            this.statusImmediate = setImmediate(() => {
                this.statusImmediate = null;
                this.flushStatus();
            });
            this.statusImmediate.unref();
        }
    }

    private startHeartbeat(transport: V12Transport, token: object, sourceAttempt: object): void {
        const config = this.config.heartbeat;

        if (config?.enabled !== true) {
            return;
        }

        const interval = config.interval;

        if (!Number.isInteger(interval) || interval < 1 || interval > 2_147_483_647) {
            throw new Error('invalid v12 heartbeat interval');
        }

        // A unique epoch invalidates even an already-queued callback after cancel.
        this.cancelHeartbeat();
        const epoch = {};
        const timer = setInterval(
            () => this.emitHeartbeat(transport, token, sourceAttempt, epoch, interval),
            interval,
        );
        this.heartbeat = { transport, token, epoch, timer };
        timer.unref();
    }

    private cancelHeartbeat(token?: object | null): void {
        const heartbeat = this.heartbeat;

        if (!heartbeat || (token !== undefined && heartbeat.token !== token)) {
            return;
        }

        this.heartbeat = null;
        clearInterval(heartbeat.timer);
    }

    private isHeartbeatCurrent(
        transport: V12Transport,
        token: object,
        sourceAttempt: object,
        epoch: object,
    ): boolean {
        const owns = (): boolean =>
            this.heartbeat?.transport === transport &&
            this.heartbeat.token === token &&
            this.heartbeat.epoch === epoch &&
            this.transport === transport &&
            this.currentStatusTransportToken === token &&
            this.openingOwner === token &&
            this.sourceAttempt === sourceAttempt &&
            this.sourceBinding === sourceAttempt &&
            this.isEnabled &&
            this.accepting;

        if (!owns()) {
            return false;
        }

        try {
            // canAccept is an injected callback and can itself reenter teardown.
            return this.options.canAccept() && owns();
        } catch {
            this.warnStatus('v12 heartbeat unavailable');
            return false;
        }
    }

    private emitHeartbeat(
        transport: V12Transport,
        token: object,
        sourceAttempt: object,
        epoch: object,
        interval: number,
    ): void {
        // Initial status is registered before its delivery; do not overtake it
        // or let a nested timer dispatch recursively interrupt another tick.
        if (this.statusEmitting || this.heartbeatEmitting) {
            return;
        }

        this.heartbeatEmitting = true;

        try {
            if (
                !this.isHeartbeatCurrent(transport, token, sourceAttempt, epoch) ||
                this.subscribers.size === 0
            ) {
                return;
            }

            const event = createHeartbeatEvent(interval);
            const subscribers = [...this.subscribers].map(
                (listener) => [listener, this.subscriberGenerations.get(listener)] as const,
            );

            for (const [listener, generation] of subscribers) {
                if (
                    !this.isHeartbeatCurrent(transport, token, sourceAttempt, epoch) ||
                    this.statusEmitting
                ) {
                    return;
                }

                if (
                    generation === undefined ||
                    this.subscriberGenerations.get(listener) !== generation
                ) {
                    continue;
                }

                try {
                    // All heartbeat fields are primitive; isolate each consumer.
                    listener({ ...event });
                } catch {
                    this.warnStatus('v12 event subscriber failed');
                }

                if (
                    !this.isHeartbeatCurrent(transport, token, sourceAttempt, epoch) ||
                    this.statusEmitting
                ) {
                    return;
                }
            }
        } catch {
            this.warnStatus('v12 heartbeat unavailable');
        } finally {
            this.heartbeatEmitting = false;
        }
    }

    private cancelStatus(): void {
        this.statusPending = false;

        if (this.statusImmediate) {
            clearImmediate(this.statusImmediate);
            this.statusImmediate = null;
        }
    }

    /** Preserve legacy admission while collecting bounded HTTP queue loss diagnostics. */
    private enqueuePollWithDiagnostics(
        event: unknown,
        source: V12Source | undefined,
        mediaGuard?: () => boolean,
    ): HttpPollDiagnostic[] {
        let before: ReturnType<typeof pollOwnerStats> = null;
        let httpOwner = false;
        const losses: HttpPollDiagnostic[] = [];

        try {
            httpOwner = hasHttpPollOwner(this);

            if (httpOwner) {
                before = pollOwnerStats(this);
            }
        } catch {
            // An optional diagnostic must not prevent admission or WS fanout.
        }

        if (httpOwner && mediaGuard !== undefined) {
            enqueuePollEvent(this, event, source, mediaGuard);
        } else {
            enqueuePollEvent(this, event, source);
        }

        if (!before) {
            return losses;
        }

        try {
            const after = pollOwnerStats(this);

            if (after && after.full > before.full) {
                losses.push('full');
            }

            if (after && after.dropped_oldest !== before.dropped_oldest) {
                losses.push('dropped_oldest');
            }

            if (after && after.too_large > before.too_large) {
                losses.push('too_large');
            }

            if (after && after.invalid > before.invalid) {
                losses.push('invalid');
            }
        } catch {
            // Admission has already completed; diagnostics remain best-effort.
        }

        return losses;
    }

    private warnHttpPoll(kind: HttpPollDiagnostic): void {
        if (this.pollDiagnostics.has(kind)) {
            return;
        }

        this.pollDiagnostics.add(kind);
        const messages: Record<HttpPollDiagnostic, string> = {
            unavailable: 'v12 http poll unavailable',
            cleanup_pending: 'v12 http poll cleanup pending; events may be missed',
            degraded: 'v12 http poll source degraded',
            full: 'v12 http poll queue full; new event dropped',
            dropped_oldest: 'v12 http poll queue full; oldest unreserved events dropped',
            too_large: 'v12 http poll event too large; event dropped',
            invalid: 'v12 http poll event invalid; event dropped',
            private_recall: 'v12 http poll omits private recall events',
            transport_error: 'v12 http poll response failed',
            delivery_uncertain: 'v12 http poll delivery outcome unknown; events may be missed',
            closing_discard: 'v12 http poll retired with undelivered buffered events',
        };
        this.warnStatus(messages[kind]);
    }

    private warnStatus(message: string): void {
        try {
            this.log.warn(message);
        } catch {
            // Diagnostic failures must not break fanout or replace the initial error.
            try {
                process.emitWarning('v12 status diagnostic failed');
            } catch {
                // Both diagnostic channels failed; retain delivery semantics.
            }
        }
    }

    /** The transport can be quiesced before its owner receives onError. */
    private uploadTransportReady(transport: V12Transport, owns: () => boolean): boolean {
        if (!owns()) {
            return false;
        }

        try {
            const ready = transport.isAcceptingActions;
            // A test transport's method/getter may reenter or be absent.
            return (
                typeof ready === 'function' &&
                owns() &&
                apply(ready, transport, []) === true &&
                owns()
            );
        } catch {
            return false;
        }
    }

    /** The lease correlates one listener, not an inbound source or an identity. */
    private isUploadLeaseCurrent(
        lease: V12FileLease | undefined,
        generation: UploadGeneration,
        transport: V12Transport,
    ): boolean {
        const owns = (): boolean =>
            generation.valid &&
            this.#uploadGeneration === generation &&
            this.currentStatusTransportToken === generation.token &&
            this.transport === transport &&
            this.isEnabled &&
            this.accepting;

        if (!lease || !this.uploadTransportReady(transport, owns)) {
            return false;
        }

        try {
            // The readiness check, canAccept and lease may all reenter lifecycle code.
            return (
                this.options.canAccept() === true &&
                this.uploadTransportReady(transport, owns) &&
                lease() === true &&
                this.uploadTransportReady(transport, owns)
            );
        } catch {
            return false;
        }
    }

    private isUploadSlotCurrent(slot: UploadSlot, lease: V12FileLease | undefined): boolean {
        return (
            this.#uploadSlot === slot &&
            this.isUploadLeaseCurrent(lease, slot.generation, slot.transport) &&
            this.#uploadSlot === slot
        );
    }

    /** Lazily allocate only for the exact listener generation requesting data. */
    private acquireUploadSlot(lease: V12FileLease | undefined): UploadSlot | null {
        const generation = this.#uploadGeneration;
        const transport = this.transport;

        if (!generation || !transport || !this.isUploadLeaseCurrent(lease, generation, transport)) {
            return null;
        }

        let slot = this.#uploadSlot;

        if (slot) {
            return this.isUploadSlotCurrent(slot, lease) ? slot : null;
        }

        let candidate: V12UploadedDataStore;

        try {
            candidate = new V12UploadedDataStore();
        } catch {
            return null;
        }

        if (!this.isUploadLeaseCurrent(lease, generation, transport)) {
            this.closeUploadStore(candidate);
            return null;
        }

        // Construction or the lease can reenter and install another store.
        if (this.#uploadSlot === null) {
            this.#uploadSlot = { generation, transport, store: candidate };
        } else {
            this.closeUploadStore(candidate);
        }

        slot = this.#uploadSlot;
        return slot && this.isUploadSlotCurrent(slot, lease) ? slot : null;
    }

    private retireUploadGeneration(generation: UploadGeneration): void {
        // Invalidate before detach or any cleanup: close/diagnostics can reenter.
        generation.valid = false;

        if (this.#uploadGeneration === generation) {
            this.#uploadGeneration = null;
        }

        const slot = this.#uploadSlot;

        if (!slot || slot.generation !== generation) {
            return;
        }

        this.#uploadSlot = null;
        this.closeUploadStore(slot.store);
    }

    private closeUploadStore(store: V12UploadedDataStore): void {
        try {
            store.close();
        } catch {
            // Never expose provider details or allow diagnostics to block teardown.
            const message = 'v12 upload store close failed';

            try {
                this.log.warn(message);
            } catch {
                try {
                    process.emitWarning(message);
                } catch {
                    // Both diagnostic channels failed; continue the lifecycle.
                }
            }
        }
    }

    private revokeMediaTokens(): void {
        const imageTokens = this.imageFileTokens;
        const voiceTokens = this.#voiceFileTokens;
        const videoTokens = this.#videoFileTokens;
        // Remove all references before any reentrant revocation or diagnostic.
        this.imageFileTokens = null;
        this.#voiceFileTokens = null;
        this.#videoFileTokens = null;

        const revoke = (
            tokens: V12ImageFileTokens | V12VoiceFileTokens | V12VideoFileTokens | null,
            kind: 'image' | 'voice' | 'video',
        ): void => {
            if (!tokens) {
                return;
            }

            try {
                tokens.revoke();
            } catch {
                // Revocation is best-effort; never report the exception or URL.
                const message = `v12 ${kind} token revocation failed`;

                try {
                    this.log.warn(message);
                } catch {
                    try {
                        process.emitWarning(message);
                    } catch {
                        // Diagnostic failures must not block the remaining cleanup.
                    }
                }
            }
        };

        revoke(imageTokens, 'image');
        revoke(voiceTokens, 'voice');
        revoke(videoTokens, 'video');
    }

    private revokePoll(): void {
        revokeOrderedTarget(this);

        try {
            invalidatePollOwner(this);
        } catch {
            // Poll cleanup must not change the transport lifecycle contract.
        }
    }

    private cleanError(error: unknown): string {
        return safeV12Error(error);
    }

    private publish(event: unknown, guard?: () => boolean): void {
        if (guard) {
            const subscribers = [...this.subscribers].map(
                (subscriber) => [subscriber, this.subscriberGenerations.get(subscriber)] as const,
            );

            for (const [subscriber, generation] of subscribers) {
                try {
                    if (!guard()) {
                        break;
                    }
                } catch {
                    break;
                }

                // The guard may reenter and replace this exact subscription.
                if (
                    generation === undefined ||
                    this.subscriberGenerations.get(subscriber) !== generation
                ) {
                    continue;
                }

                try {
                    subscriber(event);
                } catch {
                    this.warnStatus('v12 event subscriber failed');
                }
            }

            return;
        }

        for (const subscriber of this.subscribers) {
            try {
                subscriber(event);
            } catch {
                this.log.warn('v12 event subscriber failed');
            }
        }
    }
}
