import { setVideoUploadConcurrency } from '@snowluma/protocol/highway/upload-settings';
import { createLogger, runWithoutRequestContext } from '@snowluma/common/logger';
import type { BridgeInterface, BridgeSessionSource } from '@snowluma/core/bridge-interface';
import { loadOneBotConfig, OneBotConfigValidationError } from './config';
import { loadGlobalSettings } from './global-config';
import { OneBotInstance } from './instance';
import type { MessageStoreMigrationStatus } from './message-store-migration';
import {
    createMessageStoreMigrationTask,
    estimateRemainingSeconds,
} from './message-store-migration-task';
import type { AdapterStatus, NetworkApplyError, NetworkShutdownResult } from './network';
import type { OneBotConfig } from './types';
import { createPollGateRegistry } from './v12-runtime/poll-owner';

const log = createLogger('OneBot');

// Retain gates for this manager's lifetime without eviction: retiring instances
// may still use them. Different managers and processes remain independent.
const POLL_GATE_REGISTRY_CAPACITY = 1024;

class InstanceLifecycleError extends Error {
    constructor(
        readonly instance: OneBotInstance,
        readonly rootCause: unknown,
    ) {
        super(rootCause instanceof Error ? rootCause.message : String(rootCause));
        this.name = 'InstanceLifecycleError';
    }
}

export interface AccountDatabaseMigration {
    phase: 'preparing' | 'migrating' | 'complete' | 'failed';
    usable: boolean;
    processed: number;
    total: number | null;
    progress: number | null;
    estimatedRemainingSeconds: number | null;
    error?: string;
}

export interface DatabaseMigrationCallbacks {
    onReady(): void;
    onProgress(status: MessageStoreMigrationStatus, elapsedMs: number): void;
    onFailed(error: unknown): void;
}

export interface DatabaseMigrationTask {
    start(callbacks: DatabaseMigrationCallbacks): void;
    beginMigration(): void;
    /** Synchronous tasks own no work after return; asynchronous tasks resolve only
     *  after their worker and storage handles have actually closed. */
    cancel(): void | Promise<void>;
}

interface SessionRetirement {
    started: boolean;
    closed: boolean;
    pending: Set<Promise<void>>;
    failures: Map<object, unknown>;
}

/** A peer that never finishes a close handshake must not keep the next
 *  account session offline. Ten seconds covers a normal drain.
 *  SNOWLUMA_SESSION_RELEASE_DEADLINE_MS overrides the configured value. */
const DEFAULT_SESSION_RELEASE_DEADLINE_MS = 10_000;
const SESSION_RELEASE_DEADLINE_ENV = 'SNOWLUMA_SESSION_RELEASE_DEADLINE_MS';
const MAX_SESSION_RELEASE_DEADLINE_MS = 2_147_483_647;

/** Positive integer milliseconds, or `undefined` when the raw value is absent
 *  or not usable. Callers decide the fallback. */
export function parseSessionReleaseDeadlineMs(raw: string | undefined): number | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const value = raw.trim();

    if (!/^[1-9]\d*$/.test(value)) {
        return undefined;
    }

    const parsed = Number(value);

    if (!Number.isSafeInteger(parsed) || parsed > MAX_SESSION_RELEASE_DEADLINE_MS) {
        return undefined;
    }

    return parsed;
}

/** Env wins over an explicit deadline. An unusable env value is ignored. */
export function resolveSessionReleaseDeadlineMs(configured?: number, envRaw?: string): number {
    const fromEnv = parseSessionReleaseDeadlineMs(envRaw);

    if (fromEnv !== undefined) {
        return fromEnv;
    }

    if (
        configured !== undefined &&
        Number.isSafeInteger(configured) &&
        configured > 0 &&
        configured <= MAX_SESSION_RELEASE_DEADLINE_MS
    ) {
        return configured;
    }

    return DEFAULT_SESSION_RELEASE_DEADLINE_MS;
}

export interface OneBotManagerOptions {
    /** How long a retiring instance may block the replacement session.
     *  SNOWLUMA_SESSION_RELEASE_DEADLINE_MS overrides this when it is set. */
    sessionReleaseDeadlineMs?: number;
    createDatabaseMigrationTask?: (uin: string) => DatabaseMigrationTask;
    createInstance?: (
        uin: string,
        bridge: BridgeInterface,
        config: OneBotConfig,
        globalSettings: ReturnType<typeof loadGlobalSettings>,
    ) => OneBotInstance;
}

/** Per-account OneBot connection health, surfaced to the WebUI dashboard. */
export interface AccountConnections {
    uin: string;
    nickname: string;
    adapters: AdapterStatus[];
    databaseMigration?: AccountDatabaseMigration;
}

export interface ConfigApplyResult {
    online: boolean;
    applied: boolean;
    errors: NetworkApplyError[];
    adapters: AdapterStatus[];
}

export class OneBotManager {
    private readonly pollGateRegistry = createPollGateRegistry(POLL_GATE_REGISTRY_CAPACITY);
    private readonly instances = new Map<string, OneBotInstance>();
    // Keep the factory argument, rather than reading mutable instance properties,
    // as the authority for the active generation.
    private readonly instanceBindings = new Map<
        string,
        { bridge: BridgeInterface; instance: OneBotInstance }
    >();
    private readonly pendingLifecycle = new Set<Promise<void>>();
    private readonly retiringInstances = new Set<OneBotInstance>();
    // A Bridge is the generation token. Weak ownership retains completed results
    // for its callers without keeping every historical session alive forever.
    private readonly sessionRetirements = new WeakMap<
        BridgeInterface,
        Map<string, SessionRetirement>
    >();
    private readonly instanceRetirements = new WeakMap<OneBotInstance, SessionRetirement>();

    private readonly lifecycleFailures: Array<{
        label: string;
        error: unknown;
        instances?: Set<OneBotInstance>;
    }> = [];

    private readonly pendingStarts = new Map<string, { bridge: BridgeInterface }>();

    private readonly databaseMigrations = new Map<
        string,
        {
            bridge: BridgeInterface;
            task: DatabaseMigrationTask;
            state: AccountDatabaseMigration;
            rowsPerSecond: number | null;
            retryTimer: NodeJS.Timeout | null;
        }
    >();

    private readonly createDatabaseMigrationTask: (uin: string) => DatabaseMigrationTask;
    private readonly createInstance: NonNullable<OneBotManagerOptions['createInstance']>;

    private disposePromise: Promise<void> | null = null;
    private disposed = false;
    private unsubscribeSessions: (() => void) | null = null;
    private sessionBinding: object | null = null;
    private readonly sessionReleaseDeadlineMs: number;

    constructor(options: OneBotManagerOptions = {}) {
        setVideoUploadConcurrency(loadGlobalSettings().videoUploadConcurrency ?? 1);
        const envRaw = process.env[SESSION_RELEASE_DEADLINE_ENV];

        if (
            envRaw !== undefined &&
            envRaw.trim() &&
            parseSessionReleaseDeadlineMs(envRaw) === undefined
        ) {
            log.warn(
                '%s=%j is ignored; expected a positive integer number of milliseconds',
                SESSION_RELEASE_DEADLINE_ENV,
                envRaw,
            );
        }

        this.sessionReleaseDeadlineMs = resolveSessionReleaseDeadlineMs(
            options.sessionReleaseDeadlineMs,
            envRaw,
        );

        this.createDatabaseMigrationTask =
            options.createDatabaseMigrationTask ?? createMessageStoreMigrationTask;
        this.createInstance =
            options.createInstance ??
            ((uin, bridge, config, globalSettings) => {
                const result = this.pollGateRegistry.getOrCreate(uin);

                if (result.kind !== 'ready') {
                    try {
                        log.warn('OneBot v12 HTTP poll gate unavailable: %s', result.kind);
                    } catch {
                        // Diagnostics must not block the ordinary instance lifecycle.
                    }
                }

                return new OneBotInstance(
                    uin,
                    bridge,
                    config,
                    globalSettings,
                    result.kind === 'ready' ? result.gate : null,
                );
            });
    }

    bind(bridgeManager: BridgeSessionSource): void {
        if (this.disposed) {
            return;
        }

        const binding = {};
        this.sessionBinding = binding;
        // Detach the stored handle before calling it: a source may reenter bind.
        const previousUnsubscribe = this.unsubscribeSessions;
        this.unsubscribeSessions = null;

        try {
            previousUnsubscribe?.();
        } catch (error) {
            if (this.sessionBinding === binding) {
                this.sessionBinding = null;
                this.unsubscribeSessions ??= previousUnsubscribe;
            }

            throw error;
        }

        if (this.disposed || this.sessionBinding !== binding) {
            return;
        }

        const listener = {
            started: (uin: string, bridge: BridgeInterface) => {
                if (this.disposed || this.sessionBinding !== binding) {
                    return;
                }

                runWithoutRequestContext(() => {
                    if (this.disposed || this.sessionBinding !== binding) {
                        return;
                    }

                    this.onSessionStarted(uin, bridge);
                });
            },
            closed: (uin: string, bridge: BridgeInterface) => {
                if (this.disposed || this.sessionBinding !== binding) {
                    return;
                }

                this.onSessionClosed(uin, bridge);
            },
            receiveHealthChanged: (uin: string, bridge: BridgeInterface) => {
                if (this.disposed || this.sessionBinding !== binding) {
                    return;
                }

                try {
                    runWithoutRequestContext(() =>
                        this.instances.get(uin)?.receiveHealthChanged(bridge),
                    );
                } catch {
                    try {
                        log.warn('OneBot v12 receive health notification failed');
                    } catch {
                        // A diagnostic failure must not escape to the session source.
                    }
                }
            },
        };

        try {
            const unsubscribe = bridgeManager.subscribeSessions(listener);

            if (this.disposed || this.sessionBinding !== binding) {
                unsubscribe();
            } else {
                this.unsubscribeSessions = unsubscribe;
            }
        } catch (error) {
            if (this.sessionBinding === binding) {
                this.sessionBinding = null;
            }

            throw error;
        }
    }

    getInstance(uin: string): OneBotInstance | null {
        return this.instances.get(uin) ?? null;
    }

    /** Return only the currently published instance owned by this exact Bridge. */
    getInstanceForSession(uin: string, bridge: BridgeInterface): OneBotInstance | null {
        if (this.disposed) {
            return null;
        }

        const binding = this.instanceBindings.get(uin);
        return binding?.bridge === bridge && this.instances.get(uin) === binding.instance
            ? binding.instance
            : null;
    }

    getInstances(): OneBotInstance[] {
        return [...this.instances.values()];
    }

    /** Observe the exact generation after its close notification (or manager
     * disposal). This never starts cleanup and never treats a replacement
     * deadline/forceRelease as completed retirement. Unknown/live sessions reject. */
    async waitForSessionRetirement(uin: string, bridge: BridgeInterface): Promise<void> {
        const retirement = this.sessionRetirements.get(bridge)?.get(uin);

        if (!retirement?.closed) {
            throw new Error(`OneBot session has not been closed: UIN=${uin}`);
        }

        // close/cancel hooks can query reentrantly before the outer close frame
        // has registered its disposal. Let all synchronous frames publish first.
        await Promise.resolve();

        while (retirement.pending.size > 0) {
            await Promise.all(retirement.pending);
        }

        const failures = [...new Set(retirement.failures.values())];

        if (failures.length === 1) {
            throw failures[0];
        }

        if (failures.length > 1) {
            throw new AggregateError(failures, `OneBot session retirement failed: UIN=${uin}`);
        }
    }

    /** Live OneBot adapter status for active accounts plus failed retiring
     *  generations. A zombie that still owns a port must remain observable. */
    getConnectionStatuses(): AccountConnections[] {
        const visible = new Set([...this.instances.values(), ...this.retiringInstances]);
        const connections = [...visible].map((instance) => {
            const migration = this.databaseMigrations.get(instance.uin);
            return {
                uin: instance.uin,
                nickname: instance.nickname,
                adapters: instance.getConnectionStatuses(),
                ...(migration ? { databaseMigration: migration.state } : {}),
            };
        });

        const activeUins = new Set(this.instances.keys());

        for (const [uin, migration] of this.databaseMigrations) {
            if (activeUins.has(uin)) {
                continue;
            }

            connections.push({
                uin,
                nickname: migration.bridge.identity?.nickname || uin,
                adapters: [],
                databaseMigration: migration.state,
            });
        }

        return connections;
    }

    async reloadConfig(uin: string, config: OneBotConfig): Promise<ConfigApplyResult> {
        const instance = this.instances.get(uin);

        if (!instance) {
            return { online: false, applied: false, errors: [], adapters: [] };
        }

        const result = await runWithoutRequestContext(() => instance.reloadConfig(config));

        if (result.applied) {
            log.info('configuration applied: UIN=%s adapters=%d', uin, result.statuses.length);
        } else {
            log.warn(
                'configuration saved but not fully applied: UIN=%s failures=%d',
                uin,
                result.errors.length,
            );
        }

        return {
            online: true,
            applied: result.applied,
            errors: result.errors,
            adapters: result.statuses,
        };
    }

    /** Re-read global (all-accounts) settings from config/snowluma.json and push
     *  them to every live instance. Called after the WebUI saves global config. */
    reloadGlobalSettings(): void {
        const globalSettings = loadGlobalSettings();
        setVideoUploadConcurrency(globalSettings.videoUploadConcurrency ?? 1);

        for (const instance of this.instances.values()) {
            instance.applyGlobalSettings(globalSettings);
        }

        log.info('global settings reloaded for %d instance(s)', this.instances.size);
    }

    dispose(): Promise<void> {
        if (this.disposePromise) {
            return this.disposePromise;
        }

        const retirements = new Set<SessionRetirement>();

        for (const [uin, binding] of this.instanceBindings) {
            const retirement = this.retirementFor(uin, binding.bridge);
            this.instanceRetirements.set(binding.instance, retirement);
            retirements.add(retirement);
        }

        for (const [uin, pending] of this.pendingStarts) {
            retirements.add(this.retirementFor(uin, pending.bridge));
        }

        for (const [uin, migration] of this.databaseMigrations) {
            retirements.add(this.retirementFor(uin, migration.bridge));
        }

        for (const instance of this.retiringInstances) {
            const retirement = this.instanceRetirements.get(instance);

            if (retirement) {
                retirements.add(retirement);
            }
        }

        for (const retirement of retirements) {
            retirement.closed = true;
        }

        try {
            const attempt = this.disposeSessions();

            for (const retirement of retirements) {
                retirement.failures.delete(this);
            }

            return attempt;
        } catch (error) {
            // Unsubscribe, quiesce and injected cancellation can throw before
            // the asynchronous attempt exists. Such a frame is not retirement.
            for (const retirement of retirements) {
                retirement.failures.set(this, error);
            }

            throw error;
        }
    }

    private disposeSessions(): Promise<void> {
        this.disposed = true;
        this.sessionBinding = null;
        this.unsubscribeSessions?.();
        this.unsubscribeSessions = null;

        const migrations = [...this.databaseMigrations];
        this.databaseMigrations.clear();

        for (const [uin, migration] of migrations) {
            if (migration.retryTimer) {
                clearTimeout(migration.retryTimer);
            }

            this.cancelMigration(uin, migration.bridge, migration.task);
        }

        for (const instance of this.instances.values()) {
            this.retiringInstances.add(instance);
        }

        // Quiesce every live generation before awaiting older startup/shutdown
        // work. A deferred lifecycle operation must not leave Action ingress open
        // during process teardown.
        for (const instance of this.retiringInstances) {
            instance.quiesce();
        }

        this.instances.clear();
        this.instanceBindings.clear();

        const priorLifecycle = [...this.pendingLifecycle];
        const targets = [...this.retiringInstances];
        const disposing = targets.map((instance) => {
            const retirement = this.instanceRetirements.get(instance);
            const prior = retirement ? [...retirement.pending] : priorLifecycle;
            const operation = (async () => {
                // A different account's startup/drain must not hold this account's
                // barrier. Legacy injected instances without an owner keep the
                // original manager-wide ordering.
                await Promise.all(prior);

                if (!this.retiringInstances.has(instance)) {
                    if (retirement?.failures.has(instance)) {
                        throw retirement.failures.get(instance);
                    }

                    return;
                }

                await instance.dispose();
            })();
            return retirement ? this.watchRetirement(retirement, operation, instance) : operation;
        });
        const outcomes = Promise.allSettled(disposing);

        const attempt = (async () => {
            // Handle late work published by synchronous lifecycle reentry, too.
            while (this.pendingLifecycle.size > 0) {
                await Promise.all(this.pendingLifecycle);
            }

            let failures = this.lifecycleFailures.splice(0);
            const settled = await outcomes;

            for (let index = 0; index < settled.length; index += 1) {
                const instance = targets[index];
                const result = settled[index];
                const shutdownLabel = `network shutdown UIN=${instance.uin}`;

                if (result.status === 'rejected') {
                    failures.push({
                        label: shutdownLabel,
                        error: result.reason,
                        instances: new Set([instance]),
                    });
                    continue;
                }

                this.retirementSucceeded(instance);

                // A later successful retry supersedes failures only for this exact
                // generation. Same-UIN instances must never clear one another.
                failures = failures.flatMap((failure) => {
                    if (!failure.instances?.has(instance)) {
                        return [failure];
                    }

                    const remaining = new Set(failure.instances);
                    remaining.delete(instance);
                    return remaining.size > 0 ? [{ ...failure, instances: remaining }] : [];
                });
            }

            if (failures.length > 0) {
                throw new AggregateError(
                    failures.map(
                        ({ label, error }) =>
                            new Error(
                                `${label}: ${error instanceof Error ? error.message : String(error)}`,
                            ),
                    ),
                    'failed to dispose OneBot manager cleanly',
                );
            }

            this.pendingStarts.clear();
        })();

        this.disposePromise = attempt;
        void attempt.then(
            () => undefined,
            () => {
                if (this.disposePromise === attempt) {
                    this.disposePromise = null;
                }
            },
        );

        return attempt;
    }

    private retirementFor(uin: string, bridge: BridgeInterface): SessionRetirement {
        let sessions = this.sessionRetirements.get(bridge);

        if (!sessions) {
            sessions = new Map();
            this.sessionRetirements.set(bridge, sessions);
        }

        let retirement = sessions.get(uin);

        if (!retirement) {
            retirement = { started: false, closed: false, pending: new Set(), failures: new Map() };
            sessions.set(uin, retirement);
        }

        return retirement;
    }

    private watchRetirement<T>(
        retirement: SessionRetirement,
        operation: Promise<T>,
        owner: object = operation,
    ): Promise<T> {
        const watched = operation.then(
            () => {
                retirement.failures.delete(owner);
            },
            (error: unknown) => {
                retirement.failures.set(owner, error);
            },
        );
        retirement.pending.add(watched);
        void watched.then(() => {
            retirement.pending.delete(watched);
        });
        return operation;
    }

    private cancelMigration(
        uin: string,
        bridge: BridgeInterface,
        task: DatabaseMigrationTask,
    ): void {
        const retirement = this.retirementFor(uin, bridge);

        try {
            const stopped = task.cancel();

            if (stopped) {
                this.trackLifecycle(
                    `database worker shutdown UIN=${uin}`,
                    this.watchRetirement(retirement, stopped, task),
                );
            }
        } catch (error) {
            retirement.failures.set(task, error);
            throw error;
        }
    }

    private onSessionStarted(uin: string, bridge: BridgeInterface): void {
        if (this.disposed || this.instances.has(uin) || this.pendingStarts.has(uin)) {
            return;
        }

        let retirement = this.retirementFor(uin, bridge);

        if (retirement.closed) {
            if (retirement.started) {
                return;
            }

            // A close for an unowned Bridge must not poison its later genuine
            // start (for example a stale mutable instance.bridge in an adapter).
            this.sessionRetirements.get(bridge)!.delete(uin);
            retirement = this.retirementFor(uin, bridge);
        }

        retirement.started = true;
        const retiring = [...this.retiringInstances].filter((instance) => instance.uin === uin);

        if (retiring.length > 0) {
            const pending = { bridge };
            this.pendingStarts.set(uin, pending);
            this.trackLifecycle(
                `session handoff UIN=${uin}`,
                this.finishRetiringBeforeStart(uin, pending, retiring),
            );
            return;
        }

        this.prepareDatabase(uin, bridge);
    }

    private prepareDatabase(uin: string, bridge: BridgeInterface): void {
        const retirement = this.retirementFor(uin, bridge);

        if (
            this.disposed ||
            retirement.closed ||
            this.instances.has(uin) ||
            this.databaseMigrations.has(uin)
        ) {
            return;
        }

        const migration = {
            bridge,
            task: this.createDatabaseMigrationTask(uin),
            state: preparingMigrationState(),
            rowsPerSecond: null as number | null,
            retryTimer: null as NodeJS.Timeout | null,
        };

        if (this.disposed || retirement.closed) {
            this.cancelMigration(uin, bridge, migration.task);
            return;
        }

        this.databaseMigrations.set(uin, migration);

        const startTask = (): void => {
            const task = migration.task;
            const isCurrent = () =>
                this.databaseMigrations.get(uin) === migration &&
                migration.task === task &&
                migration.state.phase !== 'failed' &&
                migration.state.phase !== 'complete';

            const handleFailure = (error: unknown, stage = 'database migration'): void => {
                if (!isCurrent()) {
                    return;
                }

                const retryable = !(error instanceof OneBotConfigValidationError);
                const detail = error instanceof Error ? error.message : String(error);
                const label = stage === 'session startup' ? '账号启动失败' : '数据库迁移失败';
                migration.state = {
                    ...migration.state,
                    phase: 'failed',
                    estimatedRemainingSeconds: null,
                    error: `${label}：${detail}${retryable ? '；将自动重试' : '；请修正配置后重启'}`,
                };
                log.error(
                    '%s failed: UIN=%s retryable=%s error=%s',
                    stage,
                    uin,
                    retryable,
                    error instanceof Error ? (error.stack ?? error.message) : String(error),
                );

                this.cancelMigration(uin, bridge, task);

                if (!retryable || migration.retryTimer) {
                    return;
                }

                migration.retryTimer = setTimeout(() => {
                    migration.retryTimer = null;

                    if (this.databaseMigrations.get(uin) !== migration) {
                        return;
                    }

                    const replacement = this.createDatabaseMigrationTask(uin);

                    if (this.disposed || this.databaseMigrations.get(uin) !== migration) {
                        this.cancelMigration(uin, bridge, replacement);
                        return;
                    }

                    migration.task = replacement;
                    migration.state = migration.state.usable
                        ? { ...migration.state, phase: 'migrating', usable: true, error: undefined }
                        : preparingMigrationState();
                    startTask();
                }, 5_000);
                migration.retryTimer.unref();
            };

            try {
                task.start({
                    onReady: () => {
                        if (!isCurrent()) {
                            return;
                        }

                        try {
                            this.startSession(uin, bridge);
                        } catch (error) {
                            handleFailure(error, 'session startup');
                            return;
                        }

                        if (!isCurrent()) {
                            return;
                        }

                        migration.state = {
                            ...migration.state,
                            phase: 'migrating',
                            usable: true,
                            error: undefined,
                        };

                        try {
                            task.beginMigration();
                        } catch (error) {
                            handleFailure(error);
                        }
                    },

                    onProgress: (status, elapsedMs) => {
                        if (!isCurrent()) {
                            return;
                        }

                        const previousProcessed = migration.state.processed;
                        const processedDelta = Math.max(0, status.processed - previousProcessed);

                        if (processedDelta > 0 && elapsedMs > 0) {
                            const observed = processedDelta / (elapsedMs / 1000);
                            migration.rowsPerSecond =
                                migration.rowsPerSecond === null
                                    ? observed
                                    : migration.rowsPerSecond * 0.7 + observed * 0.3;
                        }

                        migration.state = migrationPublicState(status, migration.rowsPerSecond);

                        if (status.phase === 'complete') {
                            this.cancelMigration(uin, bridge, task);
                        }
                    },

                    onFailed: handleFailure,
                });
            } catch (error) {
                handleFailure(error);
            }
        };

        startTask();
    }

    private startSession(uin: string, bridge: BridgeInterface): void {
        const retirement = this.retirementFor(uin, bridge);

        if (this.disposed || retirement.closed || this.instances.has(uin)) {
            return;
        }

        const config = loadOneBotConfig(uin, { persistDefaults: true });
        const instance = this.createInstance(uin, bridge, config, loadGlobalSettings());
        this.instanceRetirements.set(instance, retirement);

        if (this.disposed || retirement.closed) {
            this.retiringInstances.add(instance);
            this.trackLifecycle(
                `network shutdown UIN=${uin}`,
                this.watchRetirement(retirement, this.emitOfflineThenDispose(instance), instance),
                [instance],
            );
            return;
        }

        const activePid = bridge.activePid;

        if (activePid !== null) {
            instance.addPid(activePid);
        }

        if (!bridge.identity.nickname) {
            bridge.identity.nickname = uin;
        }

        this.instances.set(uin, instance);
        this.instanceBindings.set(uin, { bridge, instance });
        log.info('session started: UIN=%s', uin);

        this.trackLifecycle(
            `network startup UIN=${uin}`,
            this.watchRetirement(
                retirement,
                instance.waitUntilNetworkReady().then(async (result) => {
                    if (result.applied) {
                        log.info(
                            'network startup applied: UIN=%s adapters=%d',
                            uin,
                            result.statuses.length,
                        );
                    } else {
                        log.warn(
                            'network startup degraded: UIN=%s failures=%d',
                            uin,
                            result.errors.length,
                        );
                    }

                    if (this.disposed || this.instances.get(uin) !== instance) {
                        return;
                    }

                    try {
                        await instance.emitBotStatus('online');
                    } catch (error) {
                        log.warn(
                            'bot_status online failed: UIN=%s: %s',
                            uin,
                            error instanceof Error ? (error.stack ?? error.message) : String(error),
                        );
                    }
                }),
            ),
        );

        void this.armLoginHistorySync(uin, instance, bridge);
    }

    private async armLoginHistorySync(
        uin: string,
        instance: OneBotInstance,
        bridge: BridgeInterface,
    ): Promise<void> {
        let warmup;

        try {
            warmup = await bridge.whenRosterWarmupSettled();
        } catch (err) {
            log.warn(
                'warmup error for UIN %s: %s',
                uin,
                err instanceof Error ? (err.stack ?? err.message) : String(err),
            );
            return;
        }

        if (this.disposed || this.instances.get(uin) !== instance) {
            return;
        }

        if (warmup.friendsLoaded && warmup.groupsLoaded) {
            instance.startLoginHistorySync();
            return;
        }

        log.warn(
            'login history sync skipped because roster warmup was incomplete: ' +
                'UIN=%s friendsLoaded=%s groupsLoaded=%s',
            uin,
            String(warmup.friendsLoaded),
            String(warmup.groupsLoaded),
        );
    }

    private onSessionClosed(uin: string, bridge: BridgeInterface): void {
        if (this.disposed) {
            return;
        }

        const retirement = this.retirementFor(uin, bridge);
        retirement.closed = true;
        const bindingAtEntry = this.instanceBindings.get(uin);
        const pendingAtEntry = this.pendingStarts.get(uin);
        const migrationAtEntry = this.databaseMigrations.get(uin);

        if (bindingAtEntry?.bridge === bridge) {
            this.instanceRetirements.set(bindingAtEntry.instance, retirement);
        }

        // Different generations can coexist in these slots. Detach only the
        // matching snapshots before cancel, which may synchronously reenter.
        if (pendingAtEntry?.bridge === bridge && this.pendingStarts.get(uin) === pendingAtEntry) {
            this.pendingStarts.delete(uin);
        }

        if (
            migrationAtEntry?.bridge === bridge &&
            this.databaseMigrations.get(uin) === migrationAtEntry
        ) {
            this.databaseMigrations.delete(uin);

            if (migrationAtEntry.retryTimer) {
                clearTimeout(migrationAtEntry.retryTimer);
            }

            this.cancelMigration(uin, bridge, migrationAtEntry.task);
        }

        if (
            this.disposed ||
            !bindingAtEntry ||
            bindingAtEntry.bridge !== bridge ||
            this.instanceBindings.get(uin) !== bindingAtEntry ||
            this.instances.get(uin) !== bindingAtEntry.instance
        ) {
            return;
        }

        // A nested close may already have retired this exact instance and
        // installed or queued another generation while cancel was running.
        this.instances.delete(uin);
        this.instanceBindings.delete(uin);
        this.retiringInstances.add(bindingAtEntry.instance);
        this.trackLifecycle(
            `network shutdown UIN=${uin}`,
            this.watchRetirement(
                retirement,
                this.emitOfflineThenDispose(bindingAtEntry.instance),
                bindingAtEntry.instance,
            ),
            [bindingAtEntry.instance],
        );
        log.info('session closed: UIN=%s', uin);
    }

    private async emitOfflineThenDispose(instance: OneBotInstance): Promise<NetworkShutdownResult> {
        try {
            await instance.emitBotStatus('offline');
        } catch (error) {
            log.warn(
                'bot_status offline failed: UIN=%s: %s',
                instance.uin,
                error instanceof Error ? (error.stack ?? error.message) : String(error),
            );
        }

        const result = await instance.dispose();
        this.retirementSucceeded(instance);

        return result;
    }

    private async releaseRetiringInstance(
        uin: string,
        pending: { bridge: BridgeInterface },
        instance: OneBotInstance,
    ): Promise<void> {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), this.sessionReleaseDeadlineMs);
            timer.unref();
        });

        // Map rejection here so a dispose() that fails after the deadline still
        // has a handler. The race may already have moved on.
        const retirement = this.instanceRetirements.get(instance);
        const disposal = instance.dispose();
        const releasing = (
            retirement ? this.watchRetirement(retirement, disposal, instance) : disposal
        ).then(
            () => 'released' as const,
            (error: unknown) => ({ failed: error }),
        );

        try {
            const outcome = await Promise.race([releasing, timeout]);

            if (outcome === 'timeout') {
                log.error(
                    'session release timed out; forcing adapters closed and starting the replacement: UIN=%s',
                    uin,
                );

                try {
                    instance.forceRelease();
                } catch (error) {
                    log.error(
                        'forced session release failed: UIN=%s: %s',
                        uin,
                        error instanceof Error ? error.message : String(error),
                    );
                }

                return;
            }

            if (typeof outcome === 'object') {
                // Do not leave this UIN permanently guarded by a failed handoff. A
                // later session-start observation may retry the still-visible retire.
                if (this.pendingStarts.get(uin) === pending) {
                    this.pendingStarts.delete(uin);
                }

                throw new InstanceLifecycleError(instance, outcome.failed);
            }
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    private async finishRetiringBeforeStart(
        uin: string,
        pending: { bridge: BridgeInterface },
        retiring: OneBotInstance[],
    ): Promise<void> {
        for (const instance of retiring) {
            await this.releaseRetiringInstance(uin, pending, instance);
            this.retirementSucceeded(instance);
        }

        if (this.pendingStarts.get(uin) !== pending) {
            return;
        }

        this.pendingStarts.delete(uin);

        if (this.disposed) {
            return;
        }

        this.prepareDatabase(uin, pending.bridge);
    }

    private trackLifecycle(
        label: string,
        operation: Promise<unknown>,
        instances?: OneBotInstance[],
    ): void {
        const tracked = operation.then(
            () => undefined,
            (error) => {
                const rootCause = error instanceof InstanceLifecycleError ? error.rootCause : error;
                const relatedInstances =
                    error instanceof InstanceLifecycleError ? [error.instance] : instances;

                log.error(
                    '%s failed: %s',
                    label,
                    rootCause instanceof Error
                        ? (rootCause.stack ?? rootCause.message)
                        : String(rootCause),
                );
                this.lifecycleFailures.push({
                    label,
                    error: rootCause,
                    ...(relatedInstances && relatedInstances.length > 0
                        ? { instances: new Set(relatedInstances) }
                        : {}),
                });
            },
        );

        this.pendingLifecycle.add(tracked);
        void tracked.then(() => {
            this.pendingLifecycle.delete(tracked);
        });
    }

    private retirementSucceeded(instance: OneBotInstance): void {
        this.retiringInstances.delete(instance);

        for (let index = this.lifecycleFailures.length - 1; index >= 0; index -= 1) {
            const failure = this.lifecycleFailures[index];

            if (!failure.instances?.has(instance)) {
                continue;
            }

            failure.instances.delete(instance);

            if (failure.instances.size === 0) {
                this.lifecycleFailures.splice(index, 1);
            }
        }
    }
}

function preparingMigrationState(): AccountDatabaseMigration {
    return {
        phase: 'preparing',
        usable: false,
        processed: 0,
        total: null,
        progress: null,
        estimatedRemainingSeconds: null,
    };
}

function migrationPublicState(
    status: MessageStoreMigrationStatus,
    rowsPerSecond: number | null,
): AccountDatabaseMigration {
    const progress = status.total === 0 ? 1 : Math.min(1, status.processed / status.total);

    return {
        phase: status.phase,
        usable: true,
        processed: status.processed,
        total: status.total,
        progress,
        estimatedRemainingSeconds: estimateRemainingSeconds(status, rowsPerSecond),
    };
}
