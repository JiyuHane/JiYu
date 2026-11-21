import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    BridgeInterface,
    BridgeSessionListener,
    BridgeSessionSource,
} from '@snowluma/core/bridge-interface';
import type { OneBotInstance } from '../src/instance';
import { OneBotManager, type DatabaseMigrationCallbacks } from '../src/manager';

vi.mock('../src/instance', () => ({ OneBotInstance: class {} }));
vi.mock('../src/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/config')>();
    return { ...actual, loadOneBotConfig: () => actual.makeDefaultOneBotConfig() };
});
vi.mock('../src/global-config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/global-config')>();
    return { ...actual, loadGlobalSettings: () => actual.defaultGlobalSettings() };
});
vi.mock('../src/message-store-migration-task', () => ({
    createMessageStoreMigrationTask: () => {
        throw new Error('unexpected default worker');
    },
    estimateRemainingSeconds: () => null,
}));

const uin = '10001';

function bridge(): BridgeInterface {
    return {
        activePid: null,
        identity: { nickname: 'synthetic' },
        whenRosterWarmupSettled: async () => ({ friendsLoaded: false, groupsLoaded: false }),
    } as unknown as BridgeInterface;
}

const releases: Array<() => void> = [];

function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    releases.push(resolve);
    return { promise, resolve };
}

class Source implements BridgeSessionSource {
    listener!: BridgeSessionListener;
    unsubscribe = vi.fn<() => void>(() => undefined);
    subscribeSessions(listener: BridgeSessionListener) {
        this.listener = listener;
        return this.unsubscribe;
    }
    start(account: string, session: BridgeInterface) {
        this.listener.started!(account, session);
    }
    close(account: string, session: BridgeInterface) {
        this.listener.closed!(account, session, null);
    }
}

function makeInstance(account: string, session: BridgeInterface) {
    return {
        uin: account,
        bridge: session,
        nickname: 'synthetic',
        addPid: vi.fn(),
        waitUntilNetworkReady: vi.fn(async () => ({ applied: true, statuses: [], errors: [] })),
        emitBotStatus: vi.fn(async (_status: 'online' | 'offline') => undefined),
        startLoginHistorySync: vi.fn(),
        getConnectionStatuses: vi.fn(() => []),
        quiesce: vi.fn(),
        forceRelease: vi.fn(),
        dispose: vi.fn(async () => ({ closed: true, errors: [] })),
    };
}

function makeTask(ready: boolean) {
    const task = {
        callbacks: undefined as DatabaseMigrationCallbacks | undefined,
        start: vi.fn((callbacks: DatabaseMigrationCallbacks) => {
            task.callbacks = callbacks;

            if (ready) {
                callbacks.onReady();
            }
        }),
        beginMigration: vi.fn(),
        cancel: vi.fn<() => void | Promise<void>>(() => undefined),
    };
    return task;
}

interface Fixture {
    source: Source;
    manager: OneBotManager;
    instances: Array<ReturnType<typeof makeInstance>>;
    tasks: Array<ReturnType<typeof makeTask>>;
    allowCleanupFailure: boolean;
    configure(configure: ((instance: ReturnType<typeof makeInstance>) => void) | undefined): void;
}
const fixtures: Fixture[] = [];

function fixture(ready = true): Fixture {
    const source = new Source();
    const instances: Array<ReturnType<typeof makeInstance>> = [];
    const tasks: Array<ReturnType<typeof makeTask>> = [];
    let configureInstance: ((instance: ReturnType<typeof makeInstance>) => void) | undefined;
    const manager = new OneBotManager({
        sessionReleaseDeadlineMs: 100,
        createDatabaseMigrationTask: () => {
            const task = makeTask(ready);
            tasks.push(task);
            return task;
        },
        createInstance: (account, session) => {
            const instance = makeInstance(account, session);
            configureInstance?.(instance);
            instances.push(instance);
            return instance as unknown as OneBotInstance;
        },
    });
    manager.bind(source);
    const f = {
        source,
        manager,
        instances,
        tasks,
        allowCleanupFailure: false,
        configure: (configure: typeof configureInstance) => {
            configureInstance = configure;
        },
    };
    fixtures.push(f);
    return f;
}

async function turn() {
    for (let index = 0; index < 12; index++) {
        await Promise.resolve();
    }
}

function observe(promise: Promise<void>) {
    const state = { settled: false };
    void promise.then(
        () => {
            state.settled = true;
        },
        () => {
            state.settled = true;
        },
    );
    return state;
}

afterEach(async () => {
    releases.splice(0).forEach((release) => release());

    for (const f of fixtures.splice(0)) {
        for (const task of f.tasks) {
            task.cancel.mockImplementation(() => undefined);
        }

        for (const instance of f.instances) {
            instance.dispose.mockImplementation(async () => ({ closed: true, errors: [] }));
        }

        const result = await Promise.allSettled([f.manager.dispose()]);

        if (!f.allowCleanupFailure && result[0].status === 'rejected') {
            throw result[0].reason;
        }
    }

    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('OneBot exact-generation retirement barrier', () => {
    it('gets only the exact published Bridge owner, independent of mutable instance properties', async () => {
        const f = fixture();
        const a = bridge();
        const b = bridge();
        f.source.start(uin, a);
        expect(f.manager.getInstanceForSession(uin, a)).toBe(f.instances[0]);
        expect(f.manager.getInstanceForSession(uin, b)).toBeNull();
        f.instances[0].bridge = b;
        expect(f.manager.getInstanceForSession(uin, a)).toBe(f.instances[0]);
        expect(f.manager.getInstanceForSession(uin, b)).toBeNull();
        const internals = f.manager as unknown as { instances: Map<string, OneBotInstance> };
        const original = internals.instances.get(uin)!;
        internals.instances.set(uin, makeInstance(uin, b) as unknown as OneBotInstance);
        expect(f.manager.getInstanceForSession(uin, a)).toBeNull();
        internals.instances.set(uin, original);
        const disposing = f.manager.dispose();
        expect(f.manager.getInstanceForSession(uin, a)).toBeNull();
        await disposing;
    });

    it('observes later cleanup failure even after startup rejection was handled', async () => {
        const f = fixture();
        f.allowCleanupFailure = true;
        const a = bridge();
        const startupFailure = new Error('synthetic startup failed');
        const cleanupFailure = new Error('synthetic cleanup failed later');
        const cleanup = gate();
        f.configure((instance) => {
            instance.waitUntilNetworkReady.mockRejectedValue(startupFailure);
            instance.dispose.mockImplementation(async () => {
                await cleanup.promise;
                throw cleanupFailure;
            });
        });
        f.source.start(uin, a);
        await turn();
        f.source.close(uin, a);
        const pending = f.manager.waitForSessionRetirement(uin, a);
        const state = observe(pending);
        await turn();
        expect(state.settled).toBe(false);
        cleanup.resolve();
        await expect(pending).rejects.toMatchObject({ errors: [startupFailure, cleanupFailure] });
    });

    it('records a synchronous manager shutdown failure instead of claiming retirement', async () => {
        const f = fixture();
        const a = bridge();
        const failure = new Error('synthetic unsubscribe failed');
        f.source.start(uin, a);
        f.source.unsubscribe.mockImplementationOnce(() => {
            throw failure;
        });
        expect(() => f.manager.dispose()).toThrow(failure);
        expect(f.manager.getInstanceForSession(uin, a)).toBeNull();
        await expect(f.manager.waitForSessionRetirement(uin, a)).rejects.toBe(failure);
        await f.manager.dispose();
        await f.manager.waitForSessionRetirement(uin, a);
    });

    it('exposes manager instance-disposal failure to the exact generation', async () => {
        const f = fixture();
        const a = bridge();
        const failure = new Error('synthetic dispose failure');
        f.source.start(uin, a);
        f.instances[0].dispose.mockRejectedValue(failure);
        const disposing = f.manager.dispose();
        const result = expect(disposing).rejects.toThrow(/dispose OneBot manager/);
        await expect(f.manager.waitForSessionRetirement(uin, a)).rejects.toBe(failure);
        await result;
    });

    it('rejects active and unobserved generations without starting cleanup', async () => {
        const f = fixture();
        const a = bridge();
        f.source.start(uin, a);
        await expect(f.manager.waitForSessionRetirement(uin, a)).rejects.toThrow(/not.*closed/i);
        await expect(f.manager.waitForSessionRetirement(uin, bridge())).rejects.toThrow(
            /not.*closed/i,
        );
        expect(f.instances[0].dispose).not.toHaveBeenCalled();
        expect(f.tasks[0].cancel).not.toHaveBeenCalled();
    });

    it('accepts an observed close that owned no OneBot resources', async () => {
        const f = fixture();
        const a = bridge();
        f.source.close(uin, a);
        await f.manager.waitForSessionRetirement(uin, a);
        expect(f.instances).toHaveLength(0);
    });

    it('waits for offline delivery and then real disposal, including repeated queries', async () => {
        const f = fixture();
        const a = bridge();
        const offline = gate();
        const disposal = gate();
        f.source.start(uin, a);
        f.instances[0].emitBotStatus.mockImplementation(async (status) => {
            if (status === 'offline') {
                await offline.promise;
            }
        });
        f.instances[0].dispose.mockImplementation(async () => {
            await disposal.promise;
            return { closed: true, errors: [] };
        });
        f.source.close(uin, a);
        const pending = f.manager.waitForSessionRetirement(uin, a);
        const state = observe(pending);
        await turn();
        expect(state.settled).toBe(false);
        expect(f.instances[0].dispose).not.toHaveBeenCalled();
        offline.resolve();
        await turn();
        expect(f.instances[0].dispose).toHaveBeenCalledOnce();
        expect(state.settled).toBe(false);
        disposal.resolve();
        await pending;
        await f.manager.waitForSessionRetirement(uin, a);
        expect(f.instances[0].dispose).toHaveBeenCalledOnce();
    });

    it('propagates the exact cleanup failure', async () => {
        const f = fixture();
        const a = bridge();
        const failure = new Error('synthetic storage close failure');
        f.source.start(uin, a);
        f.instances[0].dispose.mockRejectedValue(failure);
        f.source.close(uin, a);
        await expect(f.manager.waitForSessionRetirement(uin, a)).rejects.toBe(failure);
    });

    it('does not confuse the replacement deadline with retirement or stop a newer generation', async () => {
        vi.useFakeTimers();
        vi.stubEnv('SNOWLUMA_SESSION_RELEASE_DEADLINE_MS', '');
        const f = fixture();
        const a = bridge();
        const b = bridge();
        const disposal = gate();
        f.source.start(uin, a);
        f.instances[0].dispose.mockImplementation(async () => {
            await disposal.promise;
            return { closed: true, errors: [] };
        });
        f.source.close(uin, a);
        const pending = f.manager.waitForSessionRetirement(uin, a);
        const state = observe(pending);
        f.source.start(uin, b);
        await vi.advanceTimersByTimeAsync(101);
        expect(f.instances).toHaveLength(2);
        expect(f.instances[0].forceRelease).toHaveBeenCalledOnce();
        expect(state.settled).toBe(false);
        disposal.resolve();
        await pending;
        expect(f.manager.getInstance(uin)).toBe(f.instances[1]);
        expect(f.instances[1].dispose).not.toHaveBeenCalled();
        expect(f.instances[1].emitBotStatus).not.toHaveBeenCalledWith('offline');
    });

    it('does not block an unrelated account on another account cleanup', async () => {
        const f = fixture();
        const a = bridge();
        const b = bridge();
        const disposal = gate();
        f.source.start(uin, a);
        f.source.start('10002', b);
        f.instances[0].dispose.mockImplementation(async () => {
            await disposal.promise;
            return { closed: true, errors: [] };
        });
        f.source.close(uin, a);
        f.source.close('10002', b);
        const old = f.manager.waitForSessionRetirement(uin, a);
        const state = observe(old);
        await f.manager.waitForSessionRetirement('10002', b);
        expect(state.settled).toBe(false);
        disposal.resolve();
        await old;
    });

    it('publishes the barrier before a cancellation reenters close and queries it', async () => {
        const f = fixture();
        const a = bridge();
        const disposal = gate();
        f.source.start(uin, a);
        f.instances[0].dispose.mockImplementation(async () => {
            await disposal.promise;
            return { closed: true, errors: [] };
        });
        let nested: Promise<void> | undefined;
        f.tasks[0].cancel.mockImplementation(() => {
            f.source.close(uin, a);
            nested = f.manager.waitForSessionRetirement(uin, a);
        });
        f.source.close(uin, a);
        expect(nested).toBeDefined();
        const state = observe(nested!);
        await turn();
        expect(state.settled).toBe(false);
        disposal.resolve();
        await nested;
        expect(
            f.instances[0].emitBotStatus.mock.calls.filter(([status]) => status === 'offline'),
        ).toHaveLength(1);
    });

    it('waits for a preparing worker cancellation and ignores late callbacks', async () => {
        const f = fixture(false);
        const a = bridge();
        const cancellation = gate();
        f.source.start(uin, a);
        f.tasks[0].cancel.mockReturnValue(cancellation.promise);
        f.source.close(uin, a);
        const pending = f.manager.waitForSessionRetirement(uin, a);
        const state = observe(pending);
        f.tasks[0].callbacks!.onReady();
        f.tasks[0].callbacks!.onFailed(new Error('late callback'));
        await turn();
        expect(state.settled).toBe(false);
        expect(f.instances).toHaveLength(0);
        cancellation.resolve();
        await pending;
        f.tasks[0].callbacks!.onReady();
        expect(f.instances).toHaveLength(0);
    });

    it('propagates asynchronous worker cleanup failure', async () => {
        const f = fixture(false);
        f.allowCleanupFailure = true;
        const a = bridge();
        const failure = new Error('synthetic worker close failure');
        f.source.start(uin, a);
        f.tasks[0].cancel.mockImplementation(() => Promise.reject(failure));
        f.source.close(uin, a);
        await expect(f.manager.waitForSessionRetirement(uin, a)).rejects.toBe(failure);
        await expect(f.manager.dispose()).rejects.toThrow(/dispose OneBot manager/);
    });

    it('records synchronous cancel failure without changing its legacy propagation', async () => {
        const f = fixture();
        const a = bridge();
        const failure = new Error('synthetic synchronous cancel failure');
        f.source.start(uin, a);
        f.tasks[0].cancel.mockImplementation(() => {
            throw failure;
        });
        expect(() => f.source.close(uin, a)).toThrow(failure);
        await expect(f.manager.waitForSessionRetirement(uin, a)).rejects.toBe(failure);
        expect(f.manager.getInstance(uin)).toBe(f.instances[0]);
    });

    it('waits for the same-generation startup continuation to retire', async () => {
        const f = fixture();
        const a = bridge();
        const startup = gate();
        f.configure((instance) => {
            instance.waitUntilNetworkReady.mockImplementation(async () => {
                await startup.promise;
                return { applied: true, statuses: [], errors: [] };
            });
        });
        f.source.start(uin, a);
        f.source.close(uin, a);
        const pending = f.manager.waitForSessionRetirement(uin, a);
        const state = observe(pending);
        await turn();
        expect(state.settled).toBe(false);
        startup.resolve();
        await pending;
        expect(f.instances[0].emitBotStatus).not.toHaveBeenCalledWith('online');
    });

    it('includes workers and instance cleanup when manager disposal initiates retirement', async () => {
        const f = fixture();
        const a = bridge();
        const cancellation = gate();
        const disposal = gate();
        f.source.start(uin, a);
        f.tasks[0].cancel.mockReturnValue(cancellation.promise);
        f.instances[0].dispose.mockImplementation(async () => {
            await disposal.promise;
            return { closed: true, errors: [] };
        });
        const disposing = f.manager.dispose();
        const pending = f.manager.waitForSessionRetirement(uin, a);
        const state = observe(pending);
        await turn();
        expect(state.settled).toBe(false);
        cancellation.resolve();
        await turn();
        expect(state.settled).toBe(false);
        disposal.resolve();
        await Promise.all([disposing, pending]);
    });

    it('settles each account independently during manager-wide disposal', async () => {
        const f = fixture();
        const a = bridge();
        const b = bridge();
        const cleanup = gate();
        f.source.start(uin, a);
        f.source.start('10002', b);
        f.instances[0].dispose.mockImplementation(async () => {
            await cleanup.promise;
            return { closed: true, errors: [] };
        });
        const disposing = f.manager.dispose();
        const old = f.manager.waitForSessionRetirement(uin, a);
        const state = observe(old);
        await f.manager.waitForSessionRetirement('10002', b);
        expect(state.settled).toBe(false);
        cleanup.resolve();
        await Promise.all([disposing, old]);
    });

    it('retires an instance whose factory reenters close before it is published', async () => {
        const f = fixture();
        const a = bridge();
        const cleanup = gate();
        let nested: Promise<void> | undefined;
        f.configure((instance) => {
            instance.dispose.mockImplementation(async () => {
                await cleanup.promise;
                return { closed: true, errors: [] };
            });
            f.source.close(uin, a);
            nested = f.manager.waitForSessionRetirement(uin, a);
        });
        f.source.start(uin, a);
        expect(f.manager.getInstanceForSession(uin, a)).toBeNull();
        expect(f.manager.getInstance(uin)).toBeNull();
        expect(f.tasks[0].beginMigration).not.toHaveBeenCalled();
        const state = observe(nested!);
        await turn();
        expect(state.settled).toBe(false);
        cleanup.resolve();
        await nested;
        expect(f.instances[0].dispose).toHaveBeenCalledOnce();
    });

    it('retains earlier worker cancellation through a same-generation retry', async () => {
        vi.useFakeTimers();
        const f = fixture(false);
        const a = bridge();
        const oldWorker = gate();
        f.source.start(uin, a);
        f.tasks[0].cancel.mockReturnValue(oldWorker.promise);
        f.tasks[0].callbacks!.onFailed(new Error('retryable migration failure'));
        await vi.advanceTimersByTimeAsync(5000);
        expect(f.tasks).toHaveLength(2);
        f.source.close(uin, a);
        const pending = f.manager.waitForSessionRetirement(uin, a);
        const state = observe(pending);
        await turn();
        expect(state.settled).toBe(false);
        oldWorker.resolve();
        await pending;
    });

    it('cancels a resource-free pending replacement without waiting for the older generation', async () => {
        vi.useFakeTimers();
        vi.stubEnv('SNOWLUMA_SESSION_RELEASE_DEADLINE_MS', '');
        const f = fixture();
        const a = bridge();
        const b = bridge();
        const disposal = gate();
        f.source.start(uin, a);
        f.instances[0].dispose.mockImplementation(async () => {
            await disposal.promise;
            return { closed: true, errors: [] };
        });
        f.source.close(uin, a);
        f.source.start(uin, b);
        f.source.close(uin, b);
        await f.manager.waitForSessionRetirement(uin, b);
        await vi.advanceTimersByTimeAsync(101);
        expect(f.instances).toHaveLength(1);
        disposal.resolve();
        await f.manager.waitForSessionRetirement(uin, a);
    });
});
