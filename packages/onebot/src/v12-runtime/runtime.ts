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
import { V12ImageFileTokens } from '../v12/image-file-token';
import {
    convertV11Event,
    createConnectEvent,
    createHeartbeatEvent,
    createStatusUpdateEvent,
    V12UnsupportedEventError,
} from '../v12/events';
import type { V12Self } from '../v12/types';
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
    enqueuePollEvent,
    failOrderedPollIngress,
    hasOrderedPollOwner,
    invalidatePollOwner,
    invalidateStalePollOwner,
    recordPreparedScopeLoss,
    registerPollHost,
    type PollGate,
} from './poll-owner';

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
            pollGate?: PollGate;
        },
    ) {
        super(V12_ADAPTER_NAME, config, ctx);
        this.self = Object.freeze({ platform: 'qq', user_id: ctx.uin });
        registerPollHost(
            this,
            {
                self: this.self,
                captureBinding: () => this[captureBinding](),
                captureSource: () => this.options.captureCurrentSource?.(),
                verify: (source) => this[verifySource](source),
            },
            options.pollGate,
        );
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

        const token = {};
        const sourceAttempt = {};
        this.openingOwner = token;
        this.sourceAttempt = sourceAttempt;
        this.sourceBinding = null;
        this.currentStatusTransportToken = token;
        let transport: V12Transport;

        try {
            transport = new V12Transport({
                host: this.config.host,
                port: this.config.port,
                accessToken: this.config.accessToken,
                handle: (request) =>
                    this.options.trackAction('v12 action', () => this.dispatcher.handle(request)),
                getConnectEvent: () => createConnectEvent(this.version),
                subscribe: (listener) => this.subscribeStatus(listener),
                onError: (error) => {
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
                }
            }
        } catch (error) {
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
        this.cancelHeartbeat();
        this.revokePoll();
        this.closeRevision = {};
        this.openingOwner = null;
        this.sourceAttempt = null;
        this.sourceBinding = null;
        this.accepting = false;
        this.imageFileTokens?.revoke();
        this.imageFileTokens = null;
        this.cancelHeartbeat();
        this.cancelStatus();
        this.transport?.quiesce();
    }

    override forceClose(): void {
        this.cancelHeartbeat();
        this.revokePoll();
        this.closeRevision = {};
        this.openingOwner = null;
        this.sourceAttempt = null;
        this.sourceBinding = null;
        this.accepting = false;
        this.imageFileTokens?.revoke();
        this.imageFileTokens = null;
        this.cancelHeartbeat();
        this.cancelStatus();
        this.transport?.forceClose();
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
                let issuedImage = false;
                converted = convertV11Event(event, this.self, {
                    issueImageFileId: (url) => {
                        // Unlike legacy text input, an image capability is issued
                        // only while the supplied internal source epoch is current.
                        if (!sourceScopeCurrent()) {
                            throw new Error('v12 image source unavailable');
                        }

                        if (!this.imageFileTokens) {
                            const candidate = new V12ImageFileTokens(this.self.user_id);

                            if (!sourceScopeCurrent()) {
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

                        if (!issuer || !sourceScopeCurrent()) {
                            throw new Error('v12 image source unavailable');
                        }

                        const fileId = issuer.issue(url);
                        const current = sourceScopeCurrent();

                        if (!current || this.imageFileTokens !== issuer) {
                            throw new Error('v12 image source unavailable');
                        }

                        issuedImage = true;
                        return fileId;
                    },
                });

                // This must precede poll resolution: an already committed item
                // cannot be recalled by the later WebSocket fanout guard.
                if (issuedImage && !sourceScopeCurrent()) {
                    throw new Error('v12 image source unavailable');
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
                    } else if (admission) {
                        skipOrderedAdmission(admission);
                    }
                } else {
                    try {
                        if (admission?.kind === 'eligible' && admission.target === this) {
                            admission.lease.resolve(converted);
                        } else if (
                            (!admission || admission.kind === 'disabled') &&
                            !hasOrderedPollOwner(this)
                        ) {
                            // Only an unprepared legacy input may use completion-order FIFO.
                            // A proven pre-ready input never enters a later consumer group.
                            enqueuePollEvent(this, converted, source);
                        }
                    } catch {
                        failOrderedAdmission(admission);
                        // The optional poll path must never suppress existing fanout.
                    }

                    if (scope && source !== undefined) {
                        // Tickets identify an internal admission epoch; they do not
                        // authenticate the upstream event or same-process callers.
                        if (sourceScopeCurrent()) {
                            this.publish(converted, sourceScopeCurrent);
                        }
                    } else {
                        this.publish(converted);
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
