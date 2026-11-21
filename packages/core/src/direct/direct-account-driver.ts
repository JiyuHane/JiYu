import type {
    DirectAccountPhase,
    DirectAccountStatus,
    DirectOperationKind,
} from '@snowluma/common/direct-account';
import type { PacketSender, SendPacketResult } from '@snowluma/common/packet-sender';
import { createLogger } from '@snowluma/common/logger';
import type { OneBotManager } from '@snowluma/onebot/manager';
import type { DirectPushIngress } from '@snowluma/protocol/direct/direct-push-ingress';
import {
    isWtReferencePacketCommand,
    type WtReferencePacketResult,
} from '@snowluma/protocol/direct/wt-reference-packet-flow';
import { WtTicketRefreshError } from '@snowluma/protocol/direct/wt-reference-session';
import { MSG_PUSH_CMD } from '@snowluma/protocol/msg-push';
import type { DirectSessionHandle, BridgeManager } from '../bridge/manager';
import {
    restoreManagedDirectLogin,
    startManagedDirectLogin,
    type DirectLoginController,
    type DirectRestoredLoginController,
    type LoginEvent,
} from './runner';
import {
    readManagedQr,
    readManagedSelector,
    saveManagedSelector,
    type ManagedFileError,
} from './managed-selector';
import { DirectOperationQueue } from './operation-queue';
import type { ManagedAccountConfig } from './managed-config';
import {
    ManagedDirectAccountDriverError,
    type ManagedDirectAccountDriver,
    type ManagedDirectAccountDriverCallbacks,
    type ManagedDirectAccountErrorCode,
    type ManagedDirectAccountQr,
} from './managed-service';

const log = createLogger('Direct.AccountDriver');
const EMPTY_REVISION = '00000000000000000000000000000000';
const MAX_OWNER_LEASE_MS = 0x7fffffff;
const MAX_PUSH_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PUSH_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_PUSH_PENDING = 32;
const MAX_EVENTS_PER_PUSH = 1024;
const MAX_PACKET_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PACKET_TIMEOUT_MS = 120_000;
const DEFAULT_PACKET_TIMEOUT_MS = 15_000;
const ALIVE_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 270_000;
const ONEBOT_READY_POLL_MS = 25;
const DEFAULT_ONEBOT_READY_TIMEOUT_MS = 10 * 60_000;
const RESTORE_BACKOFF_MIN_MS = 5_000;
const RESTORE_BACKOFF_MAX_MS = 5 * 60_000;
const MAX_RESTORE_ATTEMPTS = 10;
const MAX_TIMER_MS = 0x7fffffff;

export type DirectManagedController = DirectLoginController | DirectRestoredLoginController;

export interface DirectRenewalMetadata {
    readonly nextRefreshAtSeconds: bigint;
    readonly expiresAtSeconds: bigint;
}

export interface DirectRenewSessionResult {
    readonly renewAt: number | null;
    readonly lastRenewedAt: number;
}

export type DirectRenewSession = (
    controller: DirectManagedController,
    signal: AbortSignal,
    generation: string,
) => Promise<DirectRenewSessionResult>;

export type DirectReadRenewalMetadata = (
    controller: DirectManagedController,
) => DirectRenewalMetadata | null;

export interface DirectAccountDriverManagers {
    readonly bridgeManager: Pick<BridgeManager, 'openDirectSession'>;
    readonly oneBotManager: Pick<
        OneBotManager,
        'getInstanceForSession' | 'waitForSessionRetirement'
    >;
}

interface QueueLike {
    enqueue<T>(
        options: { timeoutMs: number; cost: number; signal?: AbortSignal },
        work: (remainingMs: number) => Promise<T>,
    ): Promise<T>;
    close(): Promise<void>;
}

interface TimerHandle {
    readonly value: ReturnType<typeof setTimeout>;
}

interface ImmediateHandle {
    readonly value: ReturnType<typeof setImmediate>;
}

export interface DirectAccountDriverOverrides {
    readonly startManagedDirectLogin?: typeof startManagedDirectLogin;
    readonly restoreManagedDirectLogin?: typeof restoreManagedDirectLogin;
    readonly readManagedSelector?: typeof readManagedSelector;
    readonly saveManagedSelector?: typeof saveManagedSelector;
    readonly readManagedQr?: typeof readManagedQr;
    readonly createOperationQueue?: () => QueueLike;
    /** undefined selects the production adapter; null explicitly disables renewal. */
    readonly renewSession?: DirectRenewSession | null;
    readonly readRenewalMetadata?: DirectReadRenewalMetadata;
    readonly now?: () => number;
    readonly monotonicNow?: () => number;
    readonly setTimeout?: (
        callback: () => void,
        milliseconds: number,
    ) => ReturnType<typeof setTimeout>;
    readonly clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
    readonly setImmediate?: (callback: () => void) => ReturnType<typeof setImmediate>;
    readonly clearImmediate?: (handle: ReturnType<typeof setImmediate>) => void;
    readonly oneBotReadyTimeoutMs?: number;
}

interface Runtime {
    readonly startLogin: typeof startManagedDirectLogin;
    readonly restoreLogin: typeof restoreManagedDirectLogin;
    readonly readSelector: typeof readManagedSelector;
    readonly saveSelector: typeof saveManagedSelector;
    readonly readQr: typeof readManagedQr;
    readonly createQueue: () => QueueLike;
    readonly renewSession?: DirectRenewSession;
    readonly readRenewalMetadata: DirectReadRenewalMetadata;
    readonly now: () => number;
    readonly monotonicNow: () => number;
    readonly setTimeout: (
        callback: () => void,
        milliseconds: number,
    ) => ReturnType<typeof setTimeout>;
    readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
    readonly setImmediate: (callback: () => void) => ReturnType<typeof setImmediate>;
    readonly clearImmediate: (handle: ReturnType<typeof setImmediate>) => void;
    readonly oneBotReadyTimeoutMs: number;
}

interface SessionResources {
    readonly state: GenerationState;
    readonly mode: 'qr' | 'restore';
    readonly abort: AbortController;
    readonly queue: QueueLike;
    handle?: DirectSessionHandle;
    ingress?: DirectPushIngress;
    controller?: DirectManagedController;
    qrFile?: string;
    accepting: boolean;
    activated: boolean;
    ready: boolean;
    blocked: boolean;
    unexpectedClose: boolean;
    receiveHealthy: boolean;
    livenessFailures: number;
    renewalMetadataRead: boolean;
    renewalMetadataKnown: boolean;
    aliveTimer?: TimerHandle;
    heartbeatTimer?: TimerHandle;
    renewTimer?: TimerHandle;
    renewImmediate?: ImmediateHandle;
    renewController?: AbortController;
    renewFlight?: Promise<DirectRenewSessionResult>;
    ownerClose?: Promise<void>;
    queueClose?: Promise<void>;
    readonly blockErrors: unknown[];
    teardown?: Promise<void>;
}

interface GenerationState {
    readonly generation: string;
    readonly callbacks: ManagedDirectAccountDriverCallbacks;
    readonly abort: AbortController;
    readonly onCallbackAbort: () => void;
    session?: SessionResources;
    uin: string | null;
    initialPending: boolean;
    recovery?: Promise<void>;
    restoreAttempts: number;
    renewBootstrapAttempted: boolean;
    lastRenewalError: ManagedDirectAccountErrorCode | null;
    terminalNeedsLogin: boolean;
    recoveryPauseAbort?: AbortController;
}

interface ManualRenewal {
    readonly generation: string;
    readonly controller: AbortController;
    readonly callbacks: ManagedDirectAccountDriverCallbacks;
    readonly priorPhase: DirectAccountPhase;
    readonly priorError: ManagedDirectAccountErrorCode | null;
    promise: Promise<void>;
}

function asErrorCode(
    error: unknown,
    fallback: ManagedDirectAccountErrorCode,
): ManagedDirectAccountErrorCode {
    return error instanceof ManagedDirectAccountDriverError ? error.code : fallback;
}

function driverError(code: ManagedDirectAccountErrorCode): ManagedDirectAccountDriverError {
    return new ManagedDirectAccountDriverError(code);
}

function aggregate(errors: unknown[], message: string): unknown | undefined {
    if (errors.length === 0) {
        return undefined;
    }

    if (errors.length === 1) {
        return errors[0];
    }

    return new AggregateError(errors, message);
}

function describeError(error: unknown, depth = 0): string {
    if (error instanceof AggregateError && depth < 2) {
        const details = Array.from(error.errors, (entry) => describeError(entry, depth + 1));
        return `${error.message}: ${details.join('; ')}`;
    }

    if (error instanceof Error) {
        const detail = error.stack ?? `${error.name}: ${error.message}`;
        return error.cause !== undefined && depth < 2
            ? `${detail}; caused by ${describeError(error.cause, depth + 1)}`
            : detail;
    }

    return String(error);
}

function promiseFrom(effect: () => void | Promise<void>): Promise<void> {
    try {
        return Promise.resolve(effect());
    } catch (error) {
        return Promise.reject(error);
    }
}

function unref(value: unknown): void {
    if (value && typeof value === 'object' && 'unref' in value) {
        const method = value.unref;

        if (typeof method === 'function') {
            method.call(value);
        }
    }
}

function validTimestamp(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function renewalError(error: unknown, signal: AbortSignal): ManagedDirectAccountDriverError {
    if (error instanceof ManagedDirectAccountDriverError) {
        return error;
    }

    if (signal.aborted) {
        return driverError('renewal-cancelled');
    }

    const record = error && typeof error === 'object' ? error : undefined;
    const code =
        error instanceof WtTicketRefreshError
            ? error.code
            : record && 'code' in record
              ? record.code
              : undefined;
    const writeState =
        error instanceof WtTicketRefreshError
            ? error.writeState
            : record && 'writeState' in record
              ? record.writeState
              : undefined;

    switch (code) {
        case 'not-sent':
            return driverError('renewal-not-sent');
        case 'write-unknown':
            return driverError('renewal-write-unknown');
        case 'invalid-response':
            return driverError('renewal-invalid-receipt');
        case 'checkpoint-failed':
            return driverError('renewal-checkpoint-failed');
        case 'invalidation-failed':
            return driverError('renewal-invalidation-failed');
        case 'activation-failed':
            return driverError('renewal-activation-failed');
        case 'stopped':
            return driverError(signal.aborted ? 'renewal-cancelled' : 'renewal-closed');
    }

    if (writeState === 'not-written') {
        return driverError('renewal-not-sent');
    }

    if (writeState === 'unknown' || writeState === 'written') {
        return driverError('renewal-write-unknown');
    }

    return driverError('renewal-protocol-error');
}

function createDefaultRenewSession(now: () => number): DirectRenewSession {
    return async (controller, signal) => {
        try {
            const result = await controller.owner.refreshTickets({
                signal,
                timeoutMs: MAX_PACKET_TIMEOUT_MS,
            });
            const lastRenewedAt = now();

            if (!validTimestamp(lastRenewedAt)) {
                throw driverError('internal-error');
            }

            switch (result.status) {
                case 'refreshed': {
                    const limit = BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000));
                    const renewAt =
                        result.nextRefreshAtSeconds > 0n &&
                        result.nextRefreshAtSeconds <= limit &&
                        result.expiresAtSeconds > result.nextRefreshAtSeconds &&
                        Number(result.nextRefreshAtSeconds) * 1000 > lastRenewedAt
                            ? Number(result.nextRefreshAtSeconds) * 1000
                            : null;
                    return { renewAt, lastRenewedAt };
                }

                case 'protocol-error':
                    throw driverError('renewal-protocol-error');
                case 'empty-a1':
                    throw driverError('renewal-empty-a1');
                case 'needs-login':
                    throw driverError('needs-login');
                case 'disabled':
                    throw driverError('renewal-disabled');
            }
        } catch (error) {
            throw renewalError(error, signal);
        }
    };
}

function defaultReadRenewalMetadata(
    controller: DirectManagedController,
): DirectRenewalMetadata | null {
    const candidate = controller as DirectManagedController & {
        getRenewalMetadata?: () => DirectRenewalMetadata | null;
    };
    return candidate.getRenewalMetadata?.() ?? null;
}

function normalizeRuntime(overrides: DirectAccountDriverOverrides): Runtime {
    const oneBotReadyTimeoutMs = overrides.oneBotReadyTimeoutMs ?? DEFAULT_ONEBOT_READY_TIMEOUT_MS;
    const now = overrides.now ?? Date.now;

    if (
        !Number.isSafeInteger(oneBotReadyTimeoutMs) ||
        oneBotReadyTimeoutMs < 1 ||
        oneBotReadyTimeoutMs > MAX_TIMER_MS
    ) {
        throw new TypeError('invalid OneBot readiness timeout');
    }

    return {
        startLogin: overrides.startManagedDirectLogin ?? startManagedDirectLogin,
        restoreLogin: overrides.restoreManagedDirectLogin ?? restoreManagedDirectLogin,
        readSelector: overrides.readManagedSelector ?? readManagedSelector,
        saveSelector: overrides.saveManagedSelector ?? saveManagedSelector,
        readQr: overrides.readManagedQr ?? readManagedQr,
        createQueue: overrides.createOperationQueue ?? (() => new DirectOperationQueue()),
        renewSession:
            overrides.renewSession === null
                ? undefined
                : (overrides.renewSession ?? createDefaultRenewSession(now)),
        readRenewalMetadata: overrides.readRenewalMetadata ?? defaultReadRenewalMetadata,
        now,
        monotonicNow: overrides.monotonicNow ?? (() => performance.now()),
        setTimeout: overrides.setTimeout ?? setTimeout,
        clearTimeout: overrides.clearTimeout ?? clearTimeout,
        setImmediate: overrides.setImmediate ?? setImmediate,
        clearImmediate: overrides.clearImmediate ?? clearImmediate,
        oneBotReadyTimeoutMs,
    };
}

function publicPhase(event: LoginEvent, mode: 'qr' | 'restore'): DirectAccountPhase | undefined {
    switch (event.state) {
        case 'qr-ready':
        case 'waiting-scan':
        case 'waiting-confirmation':
        case 'registering':
        case 'online':
            return event.state;
        case 'restoring':
        case 'loading-account':
            return 'restoring';
        case 'confirmed':
            return 'registering';
        case 'starting':
        case 'opening-account-store':
        case 'saving-account':
        case 'account-saved':
        case 'connecting':
        case 'fetching':
            return mode === 'restore' ? 'restoring' : 'starting';
        default:
            return undefined;
    }
}

class DirectAccountDriver implements ManagedDirectAccountDriver {
    private readonly managers: DirectAccountDriverManagers;
    private readonly runtime: Runtime;
    private readonly renewCapable: boolean;
    private readonly capabilities: readonly string[];
    private storedUin: string | null;
    private current: GenerationState | undefined;
    private manualRenewal: ManualRenewal | undefined;
    private shutdown: Promise<void> | undefined;
    private disposed = false;
    private phase: DirectAccountPhase = 'stopped';
    private generation: string | null = null;
    private uin: string | null;
    private online = false;
    private onebotReady = false;
    private receiveHealthy = false;
    private hasStoredAccount: boolean;
    private renewAt: number | null = null;
    private lastRenewedAt: number | null = null;
    private retryAt: number | null = null;
    private error: ManagedDirectAccountErrorCode | null = null;

    constructor(
        private readonly account: ManagedAccountConfig,
        managers: DirectAccountDriverManagers,
        runtime: Runtime,
        storedUin: string | null,
    ) {
        this.managers = managers;
        this.runtime = runtime;
        this.storedUin = storedUin;
        this.uin = storedUin;
        this.hasStoredAccount = storedUin !== null;
        this.renewCapable = runtime.renewSession !== undefined;
        this.capabilities = Object.freeze([
            'qr',
            'restore',
            'stop',
            ...(this.renewCapable ? ['renew'] : []),
        ]);
    }

    snapshot(): DirectAccountStatus {
        return {
            id: this.account.id,
            label: this.account.label,
            protocol: 'linux',
            revision: EMPTY_REVISION,
            generation: this.generation,
            uin: this.uin,
            phase: this.phase,
            online: this.online,
            onebotReady: this.onebotReady,
            receiveHealthy: this.receiveHealthy,
            hasStoredAccount: this.hasStoredAccount,
            autoRestore: this.account.autoRestore,
            autoRenew: this.account.autoRenew,
            canRenew: this.renewCapable,
            renewAt: this.renewAt,
            lastRenewedAt: this.lastRenewedAt,
            retryAt: this.retryAt,
            error: this.error,
            operationId: null,
            capabilities: [...this.capabilities],
        };
    }

    async begin(
        kind: DirectOperationKind,
        generation: string,
        callbacks: ManagedDirectAccountDriverCallbacks,
    ): Promise<void> {
        if (this.disposed) {
            throw driverError('cleanup-failed');
        }

        if (kind === 'stop') {
            return this.beginStop(generation, callbacks);
        }

        if (kind === 'renew') {
            return this.beginRenew(generation, callbacks);
        }

        if (this.shutdown || this.current) {
            throw driverError('internal-error');
        }

        if (kind === 'restore' && this.storedUin === null) {
            throw driverError('needs-login');
        }

        const abort = new AbortController();
        let state!: GenerationState;
        const onCallbackAbort = () => this.cancel(generation);
        state = {
            generation,
            callbacks,
            abort,
            onCallbackAbort,
            uin: kind === 'restore' ? this.storedUin : null,
            initialPending: true,
            restoreAttempts: 0,
            renewBootstrapAttempted: false,
            lastRenewalError: null,
            terminalNeedsLogin: false,
        };
        this.current = state;
        this.generation = generation;
        this.uin = state.uin;
        this.online = false;
        this.onebotReady = false;
        this.receiveHealthy = false;
        this.retryAt = null;
        this.error = null;
        callbacks.signal.addEventListener('abort', onCallbackAbort, { once: true });

        if (callbacks.signal.aborted) {
            onCallbackAbort();
        }

        this.publish(state, kind === 'restore' ? 'restoring' : 'starting', false, null);

        try {
            await this.establish(state, kind);
            state.initialPending = false;
        } catch (error) {
            state.initialPending = false;
            const code = this.loginFailureCode(error, kind);
            const cleanupErrors: unknown[] = [];

            if (state.session) {
                try {
                    await this.teardownSession(state.session);
                } catch (cleanupError) {
                    cleanupErrors.push(cleanupError);
                }
            }

            if (this.current === state) {
                this.current = undefined;
                this.online = false;
                this.onebotReady = false;
                this.receiveHealthy = false;
                this.retryAt = null;
                this.publishDetached(
                    callbacks,
                    code === 'needs-login' ? 'needs-login' : 'failed',
                    false,
                    cleanupErrors.length > 0 ? 'cleanup-failed' : code,
                );
            }

            this.releaseGeneration(state);
            const combined = aggregate([error, ...cleanupErrors], 'direct account start failed');
            log.error(
                'direct account start failed: account=%s mode=%s code=%s error=%s',
                this.account.id,
                kind,
                cleanupErrors.length > 0 ? 'cleanup-failed' : code,
                describeError(combined),
            );
            throw driverError(cleanupErrors.length > 0 ? 'cleanup-failed' : code);
        }
    }

    cancel(generation: string): void {
        const renewal = this.manualRenewal;

        if (renewal?.generation === generation) {
            renewal.controller.abort();
            return;
        }

        const state = this.current;

        if (!state || state.generation !== generation || !state.initialPending || this.shutdown) {
            return;
        }

        this.blockGeneration(state);
        this.shutdown = this.shutdownGeneration(state, false).finally(() => {
            this.shutdown = undefined;
        });
        void this.shutdown.catch(() => {});
    }

    async qr(generation: string): Promise<ManagedDirectAccountQr> {
        const state = this.current;
        const session = state?.session;

        if (!state || !session?.qrFile) {
            throw driverError('protocol-or-transport');
        }

        const guard = () =>
            this.current === state &&
            state.generation === generation &&
            !state.abort.signal.aborted &&
            state.session === session &&
            !session.blocked &&
            ['qr-ready', 'waiting-scan', 'waiting-confirmation'].includes(this.phase) &&
            !!session.qrFile;

        if (!guard()) {
            throw driverError('protocol-or-transport');
        }

        const result = await this.runtime.readQr(this.account.config.outDir, session.qrFile, guard);

        if (!guard()) {
            result.bytes.fill(0);
            throw driverError('protocol-or-transport');
        }

        return result;
    }

    dispose(): Promise<void> {
        if (this.disposed) {
            return this.shutdown ?? Promise.resolve();
        }

        this.disposed = true;
        const state = this.current;

        if (state) {
            this.blockGeneration(state);
        }

        this.manualRenewal?.controller.abort();
        this.shutdown ??= (async () => {
            const errors: unknown[] = [];

            if (state) {
                try {
                    await this.shutdownGeneration(state, false);
                } catch (error) {
                    errors.push(error);
                }
            }

            if (this.manualRenewal) {
                try {
                    await this.manualRenewal.promise;
                } catch (error) {
                    if (!(
                        error instanceof ManagedDirectAccountDriverError &&
                        error.code === 'renewal-cancelled'
                    )) {
                        errors.push(error);
                    }
                }
            }

            const failure = aggregate(errors, 'direct account driver disposal failed');

            if (failure) {
                throw failure;
            }
        })();
        return this.shutdown;
    }

    private publish(
        state: GenerationState,
        phase: DirectAccountPhase,
        qrAvailable: boolean,
        error: ManagedDirectAccountErrorCode | null,
    ): void {
        if (this.current !== state || state.abort.signal.aborted) {
            throw driverError('protocol-or-transport');
        }

        this.phase = phase;
        this.error = error;
        state.callbacks.update({ phase, qrAvailable, error });
    }

    private publishDetached(
        callbacks: ManagedDirectAccountDriverCallbacks,
        phase: DirectAccountPhase,
        qrAvailable: boolean,
        error: ManagedDirectAccountErrorCode | null,
    ): void {
        this.phase = phase;
        this.error = error;
        callbacks.update({ phase, qrAvailable, error });
    }

    private safePublish(
        state: GenerationState,
        phase: DirectAccountPhase,
        qrAvailable: boolean,
        error: ManagedDirectAccountErrorCode | null,
    ): boolean {
        try {
            this.publish(state, phase, qrAvailable, error);
            return true;
        } catch {
            return false;
        }
    }

    private loginFailureCode(
        error: unknown,
        mode: 'qr' | 'restore',
    ): ManagedDirectAccountErrorCode {
        if (error instanceof ManagedDirectAccountDriverError) {
            return error.code;
        }

        const code =
            error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                ? error.code
                : '';

        if (mode === 'restore' && code.startsWith('account-store-')) {
            return 'needs-login';
        }

        if (code.startsWith('managed-selector-') || code.startsWith('account-store-')) {
            return 'persistence-failed';
        }

        return 'protocol-or-transport';
    }

    private createSession(state: GenerationState, mode: 'qr' | 'restore'): SessionResources {
        const session: SessionResources = {
            state,
            mode,
            abort: new AbortController(),
            queue: this.runtime.createQueue(),
            accepting: false,
            activated: false,
            ready: false,
            blocked: false,
            unexpectedClose: false,
            receiveHealthy: false,
            livenessFailures: 0,
            renewalMetadataRead: false,
            renewalMetadataKnown: false,
            blockErrors: [],
        };
        state.session = session;
        return session;
    }

    private async establish(state: GenerationState, mode: 'qr' | 'restore'): Promise<void> {
        const session = this.createSession(state, mode);
        const onEvent = (event: LoginEvent) => this.onLoginEvent(state, session, event);
        const beforeRegister = (uin: string) => this.beforeRegister(state, session, uin);
        const onPushBody = (
            body: Uint8Array,
            meta: Readonly<{ uin: string; sequence: number; command: string; retCode: number }>,
        ) => this.onPushBody(state, session, body, meta);

        try {
            const controller =
                mode === 'qr'
                    ? await this.runtime.startLogin(this.account.config, {
                          leaseTimeoutMs: MAX_OWNER_LEASE_MS,
                          persistence: this.account.persistence,
                          beforeRegister,
                          onEvent,
                          signal: session.abort.signal,
                          push: { maxPushBodyBytes: MAX_PUSH_BODY_BYTES, onPushBody },
                      })
                    : await this.runtime.restoreLogin(this.account.config, {
                          leaseTimeoutMs: MAX_OWNER_LEASE_MS,
                          persistence: { ...this.account.persistence, uin: state.uin! },
                          beforeRegister,
                          onEvent,
                          signal: session.abort.signal,
                          push: { maxPushBodyBytes: MAX_PUSH_BODY_BYTES, onPushBody },
                      });
            session.controller = controller;

            if (
                session.blocked ||
                session.abort.signal.aborted ||
                !this.isSessionCurrent(state, session)
            ) {
                const errors: unknown[] = [driverError('protocol-or-transport')];

                try {
                    await controller.close();
                } catch (error) {
                    errors.push(error);
                }

                throw aggregate(errors, 'late direct account controller cleanup failed')!;
            }

            this.observeController(state, session, controller);
            this.assertSession(state, session);

            if (!session.handle || !session.ingress || controller.confirmedUin !== state.uin) {
                throw driverError('protocol-or-transport');
            }

            if (mode === 'qr') {
                await this.runtime.saveSelector(
                    this.account.selectorFile,
                    controller.confirmedUin,
                    () =>
                        this.isSessionCurrent(state, session) &&
                        !session.blocked &&
                        !session.abort.signal.aborted,
                );
                this.assertSession(state, session);
                this.storedUin = controller.confirmedUin;
                this.hasStoredAccount = true;
            }

            if (!session.ingress.activate()) {
                throw driverError('internal-error');
            }

            session.accepting = true;
            session.receiveHealthy = true;
            session.activated = true;
            session.handle.activate(this.packetSender(state, session));
            this.online = true;
            this.receiveHealthy = true;
            this.onebotReady = false;
            this.publish(state, 'online', false, state.lastRenewalError);
            await this.waitForOneBot(state, session);
            this.assertSession(state, session);
            session.ready = true;
            this.onebotReady = true;
            this.publish(state, 'online', false, state.lastRenewalError);
            this.scheduleLiveness(state, session);
            this.scheduleRenewalAfterOnline(state, session);
        } catch (error) {
            const errors = [error];

            try {
                await this.teardownSession(session);
            } catch (cleanupError) {
                errors.push(cleanupError);
            }

            throw aggregate(errors, 'direct account establishment failed')!;
        }
    }

    private beforeRegister(state: GenerationState, session: SessionResources, uin: string): void {
        this.assertSession(state, session);

        if (session.handle || (state.uin !== null && state.uin !== uin)) {
            throw driverError('protocol-or-transport');
        }

        state.uin = uin;
        this.uin = uin;
        const handle = this.managers.bridgeManager.openDirectSession(uin);
        session.handle = handle;
        session.ingress = handle.bridge.openDirectPushIngress({
            sourceAuthenticationHandled: true,
            maxBodyBytes: MAX_PUSH_BODY_BYTES,
            maxPendingBytes: MAX_PUSH_PENDING_BYTES,
            maxPending: MAX_PUSH_PENDING,
            maxEventsPerPush: MAX_EVENTS_PER_PUSH,
        });
        this.assertSession(state, session);
    }

    private onLoginEvent(
        state: GenerationState,
        session: SessionResources,
        event: LoginEvent,
    ): void {
        if (!this.isSessionCurrent(state, session) || session.blocked) {
            return;
        }

        if (event.state === 'failed') {
            log.error(
                'direct login failed: account=%s mode=%s phase=%s code=%s worker=%s sso=%s close=%s writes=%s frames=%s bytesOut=%s bytesIn=%s',
                this.account.id,
                session.mode,
                event.phase ?? 'unknown',
                event.code ?? 'unknown',
                event.workerCode ?? 'none',
                event.ssoCode ?? 'none',
                event.transportClose ?? 'none',
                event.io?.writeCalls ?? 'none',
                event.io?.receivedFrames ?? 'none',
                event.io?.socketBytesWritten ?? 'none',
                event.io?.socketBytesRead ?? 'none',
            );
        }

        if (
            (session.activated || session.ready) &&
            (event.state === 'saving-account' || event.state === 'account-saved')
        ) {
            return;
        }

        if (event.state === 'qr-ready' && event.qrImage) {
            session.qrFile = event.qrImage;
        }

        const phase = publicPhase(event, session.mode);

        if (!phase || phase === 'online') {
            return;
        }

        const qrAvailable =
            session.mode === 'qr' &&
            !!session.qrFile &&
            ['qr-ready', 'waiting-scan', 'waiting-confirmation'].includes(phase);
        this.publish(state, phase, qrAvailable, null);
    }

    private async onPushBody(
        state: GenerationState,
        session: SessionResources,
        body: Uint8Array,
        meta: Readonly<{ uin: string; sequence: number; command: string; retCode: number }>,
    ): Promise<void> {
        if (
            meta.command !== MSG_PUSH_CMD ||
            meta.uin !== state.uin ||
            !this.isSessionCurrent(state, session) ||
            !session.accepting ||
            session.blocked
        ) {
            return;
        }

        try {
            const result = await session.ingress?.submit(body, meta);

            if (result === undefined || result.kind === 'failed' || result.kind === 'rejected') {
                this.setReceiveHealthy(state, session, false);
            } else {
                this.setReceiveHealthy(state, session, true);
            }
        } catch {
            this.setReceiveHealthy(state, session, false);
        }
    }

    private packetSender(state: GenerationState, session: SessionResources): PacketSender {
        return Object.freeze({
            sendPacket: async (command: string, body: Buffer, timeoutMs?: number) => {
                if (
                    !this.isSessionCurrent(state, session) ||
                    !session.accepting ||
                    !isWtReferencePacketCommand(command)
                ) {
                    return this.packetFailure('unsupported-or-closed');
                }

                if (!Buffer.isBuffer(body) || body.byteLength > 65_536) {
                    return this.packetFailure('invalid-request');
                }

                const selectedTimeout = timeoutMs ?? DEFAULT_PACKET_TIMEOUT_MS;

                if (!Number.isSafeInteger(selectedTimeout) || selectedTimeout < 1) {
                    return this.packetFailure('invalid-timeout');
                }

                const owned = Uint8Array.from(body);

                try {
                    return await session.queue.enqueue(
                        {
                            timeoutMs: Math.min(selectedTimeout, MAX_PACKET_TIMEOUT_MS),
                            cost: owned.byteLength,
                            signal: session.abort.signal,
                        },
                        async (remainingMs) => {
                            this.assertSession(state, session, true);
                            const controller = session.controller;

                            if (!controller) {
                                throw driverError('protocol-or-transport');
                            }

                            const result = await controller.owner.requestPacket({
                                command,
                                body: owned,
                                timeoutMs: remainingMs,
                                maxResponseBodyBytes: MAX_PACKET_RESPONSE_BYTES,
                            });
                            this.assertSession(state, session, true);
                            this.setReceiveHealthy(state, session, true);
                            return this.packetSuccess(result);
                        },
                    );
                } catch {
                    this.setReceiveHealthy(state, session, false);
                    return this.packetFailure('request-failed');
                } finally {
                    owned.fill(0);
                }
            },
        });
    }

    private packetSuccess(result: WtReferencePacketResult): SendPacketResult {
        try {
            return {
                success: true,
                gotResponse: true,
                errorCode: 0,
                errorMessage: '',
                responseData: Buffer.from(result.body),
            };
        } finally {
            result.body.fill(0);
        }
    }

    private packetFailure(message: string): SendPacketResult {
        return {
            success: false,
            gotResponse: false,
            errorCode: -1,
            errorMessage: message,
            responseData: null,
        };
    }

    private async waitForOneBot(state: GenerationState, session: SessionResources): Promise<void> {
        const deadline = this.runtime.monotonicNow() + this.runtime.oneBotReadyTimeoutMs;

        while (this.runtime.monotonicNow() < deadline) {
            this.assertSession(state, session);
            const handle = session.handle;

            if (
                handle &&
                this.managers.oneBotManager.getInstanceForSession(state.uin!, handle.bridge)
            ) {
                return;
            }

            await this.pause(ONEBOT_READY_POLL_MS, session.abort.signal);
        }

        throw driverError('internal-error');
    }

    private pause(milliseconds: number, signal: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;

            const onAbort = () => {
                if (timer !== undefined) {
                    this.runtime.clearTimeout(timer);
                }

                signal.removeEventListener('abort', onAbort);
                reject(driverError('protocol-or-transport'));
            };

            timer = this.runtime.setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            }, milliseconds);
            unref(timer);
            signal.addEventListener('abort', onAbort, { once: true });

            if (signal.aborted) {
                onAbort();
            }
        });
    }

    private async pauseRecovery(state: GenerationState, milliseconds: number): Promise<void> {
        const controller = new AbortController();
        const onGenerationAbort = () => controller.abort();
        state.recoveryPauseAbort = controller;
        state.abort.signal.addEventListener('abort', onGenerationAbort, { once: true });

        if (state.abort.signal.aborted || state.terminalNeedsLogin) {
            controller.abort();
        }

        try {
            await this.pause(milliseconds, controller.signal);
        } finally {
            state.abort.signal.removeEventListener('abort', onGenerationAbort);

            if (state.recoveryPauseAbort === controller) {
                state.recoveryPauseAbort = undefined;
            }
        }
    }

    private observeController(
        state: GenerationState,
        session: SessionResources,
        controller: DirectManagedController,
    ): void {
        void controller.whenClosed.then(
            () => this.controllerClosed(state, session),
            () => this.controllerClosed(state, session),
        );
    }

    private controllerClosed(state: GenerationState, session: SessionResources): void {
        if (!this.isSessionCurrent(state, session) || session.blocked) {
            return;
        }

        session.unexpectedClose = true;

        if (!session.ready) {
            session.abort.abort();
            return;
        }

        void this.recover(state, session).catch((error) => {
            log.error(
                'automatic direct account recovery failed: account=%s error=%s',
                this.account.id,
                error instanceof Error ? error.message : String(error),
            );
        });
    }

    private scheduleLiveness(state: GenerationState, session: SessionResources): void {
        this.scheduleLivenessKind(state, session, 'alive', ALIVE_INTERVAL_MS);
        this.scheduleLivenessKind(state, session, 'heartbeat', HEARTBEAT_INTERVAL_MS);
    }

    private scheduleLivenessKind(
        state: GenerationState,
        session: SessionResources,
        kind: 'alive' | 'heartbeat',
        delay: number,
    ): void {
        if (!this.isSessionCurrent(state, session) || session.blocked || !session.ready) {
            return;
        }

        const timer = this.runtime.setTimeout(() => {
            if (kind === 'alive') {
                session.aliveTimer = undefined;
            } else {
                session.heartbeatTimer = undefined;
            }

            void this.runLiveness(state, session, kind).finally(() => {
                if (
                    this.isSessionCurrent(state, session) &&
                    !session.blocked &&
                    session.livenessFailures < 3
                ) {
                    this.scheduleLivenessKind(state, session, kind, delay);
                }
            });
        }, delay);
        unref(timer);
        const wrapped = { value: timer };

        if (kind === 'alive') {
            session.aliveTimer = wrapped;
        } else {
            session.heartbeatTimer = wrapped;
        }
    }

    private async runLiveness(
        state: GenerationState,
        session: SessionResources,
        kind: 'alive' | 'heartbeat',
    ): Promise<void> {
        let success = false;

        try {
            success = await session.queue.enqueue(
                { timeoutMs: MAX_PACKET_TIMEOUT_MS, cost: 0, signal: session.abort.signal },
                async () => {
                    this.assertSession(state, session, true);
                    const controller = session.controller;

                    if (!controller) {
                        return false;
                    }

                    const result =
                        kind === 'alive'
                            ? await controller.owner.alive()
                            : await controller.owner.heartbeat();
                    this.assertSession(state, session, true);
                    return result.status === 'success';
                },
            );
        } catch {
            success = false;
        }

        if (!this.isSessionCurrent(state, session) || session.blocked) {
            return;
        }

        if (success) {
            session.livenessFailures = 0;
            this.setReceiveHealthy(state, session, true);
            return;
        }

        session.livenessFailures += 1;
        this.setReceiveHealthy(state, session, false);

        if (session.livenessFailures >= 3) {
            await this.recover(state, session);
        }
    }

    private setReceiveHealthy(
        state: GenerationState,
        session: SessionResources,
        healthy: boolean,
    ): void {
        if (!this.isSessionCurrent(state, session) || session.blocked) {
            return;
        }

        if (session.receiveHealthy === healthy && this.receiveHealthy === healthy) {
            return;
        }

        session.receiveHealthy = healthy;
        this.receiveHealthy = healthy;

        if (session.activated) {
            try {
                session.handle?.setReceiveHealthy(healthy);
            } catch {
                return;
            }
        }

        this.safePublish(state, this.phase, false, this.error);
    }

    private async recover(state: GenerationState, lost: SessionResources): Promise<void> {
        if (state.recovery) {
            return state.recovery;
        }

        state.recovery = this.runRecovery(state, lost).finally(() => {
            state.recovery = undefined;
        });
        return state.recovery;
    }

    private async runRecovery(state: GenerationState, lost: SessionResources): Promise<void> {
        if (!this.isSessionCurrent(state, lost) || lost.blocked) {
            return;
        }

        this.blockSession(lost);
        this.online = false;
        this.onebotReady = false;
        this.receiveHealthy = false;

        try {
            await this.teardownSession(lost);
        } catch {
            this.finishRecovery(state, 'failed', 'cleanup-failed');
            return;
        }

        if (!this.isGenerationCurrent(state)) {
            return;
        }

        if (state.terminalNeedsLogin) {
            this.finishRecovery(state, 'needs-login', 'needs-login');
            return;
        }

        if (!this.account.autoRestore || this.storedUin === null) {
            this.finishRecovery(state, 'failed', state.lastRenewalError ?? 'protocol-or-transport');
            return;
        }

        let lastError: ManagedDirectAccountErrorCode =
            state.lastRenewalError ?? 'protocol-or-transport';

        while (
            state.restoreAttempts < MAX_RESTORE_ATTEMPTS &&
            this.isGenerationCurrent(state) &&
            !state.terminalNeedsLogin
        ) {
            const delay = Math.min(
                RESTORE_BACKOFF_MIN_MS * 2 ** state.restoreAttempts,
                RESTORE_BACKOFF_MAX_MS,
            );
            state.restoreAttempts += 1;
            this.retryAt = this.runtime.now() + delay;
            this.safePublish(state, 'backoff', false, lastError);

            try {
                await this.pauseRecovery(state, delay);
            } catch {
                if (state.terminalNeedsLogin && this.isGenerationCurrent(state)) {
                    this.finishRecovery(state, 'needs-login', 'needs-login');
                }

                return;
            }

            if (!this.isGenerationCurrent(state)) {
                return;
            }

            if (state.terminalNeedsLogin) {
                this.finishRecovery(state, 'needs-login', 'needs-login');
                return;
            }

            this.retryAt = null;
            state.uin = this.storedUin;
            this.safePublish(state, 'restoring', false, state.lastRenewalError);

            try {
                await this.establish(state, 'restore');

                if (state.terminalNeedsLogin) {
                    const restored = state.session;

                    if (restored) {
                        try {
                            await this.teardownSession(restored);
                        } catch {
                            this.finishRecovery(state, 'failed', 'cleanup-failed');
                            return;
                        }
                    }

                    this.finishRecovery(state, 'needs-login', 'needs-login');
                    return;
                }

                state.restoreAttempts = 0;
                return;
            } catch (error) {
                lastError = this.loginFailureCode(error, 'restore');

                if (lastError === 'needs-login' || lastError === 'persistence-failed') {
                    break;
                }
            }
        }

        if (state.terminalNeedsLogin && this.isGenerationCurrent(state)) {
            this.finishRecovery(state, 'needs-login', 'needs-login');
            return;
        }

        if (this.isGenerationCurrent(state)) {
            this.finishRecovery(
                state,
                lastError === 'needs-login' || lastError === 'persistence-failed'
                    ? 'needs-login'
                    : 'failed',
                lastError,
            );
        }
    }

    private finishRecovery(
        state: GenerationState,
        phase: 'failed' | 'needs-login',
        error: ManagedDirectAccountErrorCode,
    ): void {
        this.retryAt = null;
        this.safePublish(state, phase, false, error);

        if (this.current === state) {
            this.current = undefined;
            this.releaseGeneration(state);
        }
    }

    private markStoredAccountInvalid(state: GenerationState): void {
        state.terminalNeedsLogin = true;
        state.recoveryPauseAbort?.abort();
        this.storedUin = null;
        this.hasStoredAccount = false;
    }

    private scheduleRenewalAfterOnline(state: GenerationState, session: SessionResources): void {
        if (!this.renewCapable || !this.account.autoRenew || !session.controller) {
            return;
        }

        if (!session.renewalMetadataRead) {
            session.renewalMetadataRead = true;
            const metadata = this.runtime.readRenewalMetadata(session.controller);
            session.renewalMetadataKnown = metadata !== null;

            if (metadata !== null) {
                this.renewAt = this.renewAtFromMetadata(metadata);
            }
        }

        // Once any refresh fails, this generation remains fail-closed for automatic renewal.
        // Metadata is still projected for status, but only explicit manual success may clear
        // the error and arm another schedule; a new generation/process may also start fresh.
        if (state.lastRenewalError !== null) {
            return;
        }

        if (this.renewAt !== null) {
            this.scheduleRenewAt(state, session, this.renewAt);
            return;
        }

        if (session.renewalMetadataKnown || state.renewBootstrapAttempted) {
            return;
        }

        state.renewBootstrapAttempted = true;
        const handle = this.runtime.setImmediate(() => {
            session.renewImmediate = undefined;
            void this.runAutomaticRenewal(state, session);
        });
        unref(handle);
        session.renewImmediate = { value: handle };
    }

    private renewAtFromMetadata(metadata: DirectRenewalMetadata): number | null {
        const limit = BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000));

        if (
            typeof metadata.nextRefreshAtSeconds !== 'bigint' ||
            typeof metadata.expiresAtSeconds !== 'bigint' ||
            metadata.nextRefreshAtSeconds <= 0n ||
            metadata.nextRefreshAtSeconds > limit ||
            metadata.expiresAtSeconds <= metadata.nextRefreshAtSeconds
        ) {
            return null;
        }

        return Number(metadata.nextRefreshAtSeconds) * 1000;
    }

    private scheduleRenewAt(
        state: GenerationState,
        session: SessionResources,
        renewAt: number,
    ): void {
        if (!this.isSessionCurrent(state, session) || session.blocked) {
            return;
        }

        this.clearRenewSchedule(session);
        const delay = Math.max(0, Math.min(renewAt - this.runtime.now(), MAX_TIMER_MS));
        const timer = this.runtime.setTimeout(() => {
            session.renewTimer = undefined;

            if (this.runtime.now() < renewAt) {
                this.scheduleRenewAt(state, session, renewAt);
                return;
            }

            void this.runAutomaticRenewal(state, session);
        }, delay);
        unref(timer);
        session.renewTimer = { value: timer };
    }

    private async runAutomaticRenewal(
        state: GenerationState,
        session: SessionResources,
    ): Promise<void> {
        if (
            !this.isSessionCurrent(state, session) ||
            session.blocked ||
            !session.controller ||
            this.manualRenewal ||
            session.renewFlight ||
            session.renewController
        ) {
            return;
        }

        this.safePublish(state, 'renewing', false, null);

        try {
            const result = await this.renew(state, session, state.generation, state.abort.signal);
            this.applyRenewalResult(result);
            session.renewalMetadataKnown = true;
            state.lastRenewalError = null;
            this.safePublish(state, 'online', false, null);

            if (result.renewAt !== null) {
                this.scheduleRenewAt(state, session, result.renewAt);
            }
        } catch (error) {
            if (!this.isGenerationCurrent(state)) {
                return;
            }

            const code = asErrorCode(error, 'internal-error');
            state.lastRenewalError = code;
            this.renewAt = null;

            if (code === 'needs-login') {
                this.markStoredAccountInvalid(state);
                this.safePublish(state, 'needs-login', false, code);
                await this.recover(state, session);
                return;
            }

            this.safePublish(state, 'failed', false, code);
        }
    }

    private async beginRenew(
        generation: string,
        callbacks: ManagedDirectAccountDriverCallbacks,
    ): Promise<void> {
        const state = this.current;
        const session = state?.session;

        if (
            !state ||
            state.generation !== generation ||
            !session?.ready ||
            session.blocked ||
            !session.controller ||
            !this.renewCapable ||
            this.phase === 'needs-login' ||
            this.manualRenewal
        ) {
            throw driverError('renewal-unavailable');
        }

        if (session.renewFlight || session.renewController) {
            throw driverError('renewal-backoff');
        }

        this.clearRenewSchedule(session);
        const controller = new AbortController();
        const priorPhase = this.phase;
        const priorError = this.error;
        const onAbort = () => controller.abort();
        callbacks.signal.addEventListener('abort', onAbort, { once: true });

        if (callbacks.signal.aborted) {
            controller.abort();
        }

        this.phase = 'renewing';
        this.error = null;
        callbacks.update({ phase: 'renewing', qrAvailable: false, error: null });
        const renewal: ManualRenewal = {
            generation,
            controller,
            callbacks,
            priorPhase,
            priorError,
            promise: Promise.resolve(),
        };
        this.manualRenewal = renewal;
        renewal.promise = (async () => {
            try {
                const result = await this.renew(state, session, generation, controller.signal);
                this.applyRenewalResult(result);
                session.renewalMetadataKnown = true;
                state.lastRenewalError = null;
                this.phase = 'online';
                this.error = null;
                callbacks.update({ phase: 'online', qrAvailable: false, error: null });

                if (this.account.autoRenew && result.renewAt !== null) {
                    this.scheduleRenewAt(state, session, result.renewAt);
                }
            } catch (error) {
                if (controller.signal.aborted || callbacks.signal.aborted) {
                    if (
                        !this.shutdown &&
                        this.isSessionCurrent(state, session) &&
                        !session.blocked
                    ) {
                        this.phase = priorPhase;
                        this.error = priorError;
                    }

                    throw driverError('renewal-cancelled');
                }

                const code = asErrorCode(error, 'internal-error');
                state.lastRenewalError = code;
                this.renewAt = null;
                this.phase = code === 'needs-login' ? 'needs-login' : 'failed';
                this.error = code;
                callbacks.update({
                    phase: this.phase,
                    qrAvailable: false,
                    error: code,
                });

                if (code === 'needs-login') {
                    this.markStoredAccountInvalid(state);
                    await this.recover(state, session);
                }

                throw error instanceof ManagedDirectAccountDriverError ? error : driverError(code);
            } finally {
                callbacks.signal.removeEventListener('abort', onAbort);

                if (this.manualRenewal === renewal) {
                    this.manualRenewal = undefined;
                }
            }
        })();
        return renewal.promise;
    }

    private async renew(
        state: GenerationState,
        session: SessionResources,
        generation: string,
        signal: AbortSignal,
    ): Promise<DirectRenewSessionResult> {
        const hook = this.runtime.renewSession;
        const controller = session.controller;

        if (!hook || !controller) {
            throw driverError('renewal-unavailable');
        }

        if (session.renewFlight || session.renewController) {
            throw driverError('renewal-backoff');
        }

        const renewController = new AbortController();
        const abort = () => renewController.abort();
        signal.addEventListener('abort', abort, { once: true });
        session.abort.signal.addEventListener('abort', abort, { once: true });

        if (signal.aborted || session.abort.signal.aborted) {
            renewController.abort();
        }

        session.renewController = renewController;
        const flight = session.queue.enqueue(
            {
                timeoutMs: MAX_PACKET_TIMEOUT_MS,
                cost: 0,
                signal: renewController.signal,
            },
            async () => {
                this.assertSession(state, session, true);
                return hook(controller, renewController.signal, generation);
            },
        );
        session.renewFlight = flight;

        try {
            return await flight;
        } finally {
            signal.removeEventListener('abort', abort);
            session.abort.signal.removeEventListener('abort', abort);

            if (session.renewFlight === flight) {
                session.renewFlight = undefined;
                session.renewController = undefined;
            }
        }
    }

    private applyRenewalResult(result: DirectRenewSessionResult): void {
        const now = this.runtime.now();

        if (
            !result ||
            typeof result !== 'object' ||
            !validTimestamp(result.lastRenewedAt) ||
            result.lastRenewedAt > now ||
            (result.renewAt !== null &&
                (!validTimestamp(result.renewAt) ||
                    result.renewAt <= now ||
                    result.renewAt <= result.lastRenewedAt))
        ) {
            throw driverError('renewal-invalid-receipt');
        }

        this.lastRenewedAt = result.lastRenewedAt;
        this.renewAt = result.renewAt;
    }

    private async beginStop(
        generation: string,
        callbacks: ManagedDirectAccountDriverCallbacks,
    ): Promise<void> {
        if (this.shutdown) {
            return this.shutdown;
        }

        const state = this.current;

        if (state && state.generation !== generation) {
            throw driverError('internal-error');
        }

        this.phase = 'stopping';
        this.error = null;
        callbacks.update({ phase: 'stopping', qrAvailable: false, error: null });

        if (state) {
            this.blockGeneration(state);
        }

        this.manualRenewal?.controller.abort();
        this.shutdown = (async () => {
            const errors: unknown[] = [];

            if (state) {
                try {
                    await this.shutdownGeneration(state, true);
                } catch (error) {
                    errors.push(error);
                }
            }

            if (this.manualRenewal) {
                try {
                    await this.manualRenewal.promise;
                } catch (error) {
                    if (!(
                        error instanceof ManagedDirectAccountDriverError &&
                        error.code === 'renewal-cancelled'
                    )) {
                        errors.push(error);
                    }
                }
            }

            this.online = false;
            this.onebotReady = false;
            this.receiveHealthy = false;
            this.retryAt = null;
            this.generation = null;
            this.uin = this.storedUin;

            const failure = aggregate(errors, 'direct account stop failed');

            if (failure) {
                this.phase = 'failed';
                this.error = 'cleanup-failed';
                callbacks.update({
                    phase: 'failed',
                    qrAvailable: false,
                    error: 'cleanup-failed',
                });
                throw failure;
            }

            this.phase = 'stopped';
            this.error = null;
            callbacks.update({ phase: 'stopped', qrAvailable: false, error: null });
        })().finally(() => {
            this.shutdown = undefined;
        });
        return this.shutdown;
    }

    private blockGeneration(state: GenerationState): void {
        if (!state.abort.signal.aborted) {
            state.abort.abort();
        }

        if (state.session) {
            this.blockSession(state.session);
        }

        this.manualRenewal?.controller.abort();
    }

    private blockSession(session: SessionResources): void {
        if (session.blocked) {
            return;
        }

        session.blocked = true;
        session.accepting = false;
        this.clearSessionTimers(session);

        try {
            session.ingress?.stop();
        } catch (error) {
            session.blockErrors.push(error);
        }

        session.renewController?.abort();
        session.abort.abort();
        // Both barriers are started in this synchronous stop frame. The queue closes
        // admission immediately; the owner abort prevents a dispatched write replay.
        session.ownerClose ??= session.controller
            ? promiseFrom(() => session.controller!.close())
            : undefined;
        session.queueClose ??= promiseFrom(() => session.queue.close());
        void session.ownerClose?.catch(() => {});
        void session.queueClose.catch(() => {});
    }

    private clearRenewSchedule(session: SessionResources): void {
        if (session.renewTimer) {
            this.runtime.clearTimeout(session.renewTimer.value);
            session.renewTimer = undefined;
        }

        if (session.renewImmediate) {
            this.runtime.clearImmediate(session.renewImmediate.value);
            session.renewImmediate = undefined;
        }
    }

    private clearSessionTimers(session: SessionResources): void {
        for (const timer of [session.aliveTimer, session.heartbeatTimer]) {
            if (timer) {
                this.runtime.clearTimeout(timer.value);
            }
        }

        this.clearRenewSchedule(session);
        session.aliveTimer = undefined;
        session.heartbeatTimer = undefined;
    }

    private async teardownSession(session: SessionResources): Promise<void> {
        if (session.teardown) {
            return session.teardown;
        }

        this.blockSession(session);
        session.teardown = (async () => {
            const errors: unknown[] = [...session.blockErrors];
            const ownerClose =
                session.ownerClose ??
                (session.controller
                    ? promiseFrom(() => session.controller!.close())
                    : Promise.resolve());
            const queueClose = session.queueClose ?? promiseFrom(() => session.queue.close());
            session.ownerClose = ownerClose;
            session.queueClose = queueClose;
            const ownerAndQueue = await Promise.allSettled([ownerClose, queueClose]);

            for (const result of ownerAndQueue) {
                if (result.status === 'rejected') {
                    errors.push(result.reason);
                }
            }

            if (session.ingress) {
                try {
                    await session.ingress.drain();
                } catch (error) {
                    errors.push(error);
                }
            }

            if (session.handle) {
                try {
                    await session.handle.close();
                } catch (error) {
                    errors.push(error);
                }
            }

            if (session.activated && session.handle && session.state.uin) {
                try {
                    await this.managers.oneBotManager.waitForSessionRetirement(
                        session.state.uin,
                        session.handle.bridge,
                    );
                } catch (error) {
                    errors.push(error);
                }
            }

            session.accepting = false;
            session.ready = false;

            if (session.state.session === session) {
                session.state.session = undefined;
            }

            const failure = aggregate(errors, 'direct account session teardown failed');

            if (failure) {
                throw failure;
            }
        })();
        return session.teardown;
    }

    private async shutdownGeneration(
        state: GenerationState,
        publishStopped: boolean,
    ): Promise<void> {
        const errors: unknown[] = [];
        const recovery = state.recovery;
        const session = state.session;

        if (session) {
            try {
                await this.teardownSession(session);
            } catch (error) {
                errors.push(error);
            }
        }

        if (recovery) {
            try {
                await recovery;
            } catch (error) {
                errors.push(error);
            }
        }

        if (this.current === state) {
            this.current = undefined;
        }

        this.releaseGeneration(state);

        if (!publishStopped) {
            this.online = false;
            this.onebotReady = false;
            this.receiveHealthy = false;
        }

        const failure = aggregate(errors, 'direct account generation shutdown failed');

        if (failure) {
            throw failure;
        }
    }

    private releaseGeneration(state: GenerationState): void {
        state.callbacks.signal.removeEventListener('abort', state.onCallbackAbort);

        if (!state.abort.signal.aborted) {
            state.abort.abort();
        }
    }

    private isGenerationCurrent(state: GenerationState): boolean {
        return this.current === state && !state.abort.signal.aborted && !this.disposed;
    }

    private isSessionCurrent(state: GenerationState, session: SessionResources): boolean {
        return this.isGenerationCurrent(state) && state.session === session;
    }

    private assertSession(
        state: GenerationState,
        session: SessionResources,
        requireAccepting = false,
    ): void {
        if (
            !this.isSessionCurrent(state, session) ||
            session.blocked ||
            session.abort.signal.aborted ||
            session.unexpectedClose ||
            (requireAccepting && !session.accepting)
        ) {
            throw driverError('protocol-or-transport');
        }
    }
}

/**
 * Constructs the production driver around real managers and real runner/selector functions.
 * Tests inject every external effect through overrides; construction only reads the selector.
 */
export async function createDirectAccountDriver(
    account: ManagedAccountConfig,
    managers: DirectAccountDriverManagers,
    overrides: DirectAccountDriverOverrides = {},
): Promise<ManagedDirectAccountDriver> {
    const runtime = normalizeRuntime(overrides);
    let storedUin: string | null;

    try {
        storedUin = await runtime.readSelector(account.selectorFile);
    } catch (error) {
        const code =
            error && typeof error === 'object' && 'code' in error
                ? String((error as ManagedFileError).code)
                : '';

        if (code === 'managed-selector-invalid' || code === 'managed-selector-io') {
            throw driverError('persistence-failed');
        }

        throw error;
    }

    return new DirectAccountDriver(account, managers, runtime, storedUin);
}
