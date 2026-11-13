import { APP_VERSION } from '@snowluma/common/version';
import { IOneBotNetworkAdapter, type AdapterStatus, type NetworkAdapterContext } from '../network';
import { V12Transport } from '../v12-network';
import { V12Dispatcher } from '../v12/dispatcher';
import {
    convertV11Event,
    createConnectEvent,
    createStatusUpdateEvent,
    V12UnsupportedEventError,
} from '../v12/events';
import type { V12Self } from '../v12/types';
import type { JsonObject } from '../types';
import { safeV12Error, V12_ADAPTER_NAME, type V12ManagedConfig } from './identity';
import {
    captureBinding,
    receiveSourceEvent,
    verifySource,
    type V12Source,
} from './source-generation';
import type { DispatchPayload } from '../event-filter';

/** A v12 listener participates in the same network manager FIFO as v11. */
export class V12Runtime extends IOneBotNetworkAdapter<V12ManagedConfig> {
    private readonly self: V12Self;
    private readonly version = { impl: 'jiyu', version: APP_VERSION };
    private readonly dispatcher: V12Dispatcher;
    private readonly subscribers = new Set<(event: unknown) => void>();
    private readonly subscriberGenerations = new Map<(event: unknown) => void, object>();
    private statusEmitting = false;
    private statusPending = false;
    private statusImmediate: ReturnType<typeof setImmediate> | null = null;
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
        },
    ) {
        super(V12_ADAPTER_NAME, config, ctx);
        this.self = { platform: 'qq', user_id: ctx.uin };
        this.dispatcher = new V12Dispatcher({
            self: this.self,
            version: this.version,
            api: ctx.api,
            getStatus: options.getStatus,
            getSentMessageTime: options.getSentMessageTime,
        });
    }

    protected bindingSignature(config: V12ManagedConfig): string {
        return JSON.stringify([config.host, config.port, config.accessToken]);
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
                    if (this.sourceAttempt === sourceAttempt) {
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
                await transport.close();

                if (ownsOpening()) {
                    this.transport = null;
                    this.currentStatusTransportToken = null;
                    this.openingOwner = null;
                }

                throw new Error('v12 instance is disposing');
            }

            if (ownsOpening()) {
                this.isEnabled = true;

                if (this.sourceAttempt === sourceAttempt) {
                    this.sourceBinding = sourceAttempt;
                }
            }
        } catch (error) {
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
            // Restore status ownership only if no nested close or teardown won.
            // Source admission remains revoked even when quiesce throws.
            if (
                ownsTransport() &&
                this.closeRevision === closeRevision &&
                this.openingOwner === null &&
                this.accepting
            ) {
                this.openingOwner = previousOpeningOwner;
            }

            throw error;
        }

        if (ownsTransport()) {
            this.closeRevision = {};
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
        this.closeRevision = {};
        this.openingOwner = null;
        this.sourceAttempt = null;
        this.sourceBinding = null;
        this.accepting = false;
        this.cancelStatus();
        this.transport?.quiesce();
    }

    override forceClose(): void {
        this.closeRevision = {};
        this.openingOwner = null;
        this.sourceAttempt = null;
        this.sourceBinding = null;
        this.accepting = false;
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
        _source: V12Source,
    ): void {
        // Metadata is carried separately; today's WS broadcast is unchanged.
        this.onEvent(event, payload);
    }

    onEvent(event: JsonObject, _payload?: DispatchPayload): void {
        if (!this.isEnabled || !this.accepting) {
            return;
        }

        try {
            const converted = convertV11Event(event, this.self);

            if (converted) {
                this.publish(converted);
            }
        } catch (error) {
            if (error instanceof V12UnsupportedEventError) {
                this.log.warn('v12 unsupported event: self_sent_message');
            } else {
                this.log.warn('v12 event conversion failed: %s', this.cleanError(error));
            }
        }
    }

    statusUpdate(): void {
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

    private cleanError(error: unknown): string {
        return safeV12Error(error);
    }

    private publish(event: unknown): void {
        for (const subscriber of this.subscribers) {
            try {
                subscriber(event);
            } catch {
                this.log.warn('v12 event subscriber failed');
            }
        }
    }
}
