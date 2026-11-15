import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    BridgeInterface,
    BridgeSessionListener,
    BridgeSessionSource,
} from '@snowluma/core/bridge-interface';
import type { OneBotInstance } from '../src/instance';
import { OneBotManager, type DatabaseMigrationCallbacks } from '../src/manager';

// Exercise the real manager through its injected interfaces only. In particular,
// synchronous cancel reentry is a deliberate fake, not a claim about the default worker.
vi.mock('../src/instance', () => ({
    OneBotInstance: class {
        constructor() {
            throw new Error('unexpected real instance construction');
        }
    },
}));
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
        throw new Error('unexpected real migration task');
    },
    estimateRemainingSeconds: () => null,
}));

const UIN = '10001';

class FakeSource implements BridgeSessionSource {
    listener!: BridgeSessionListener;
    subscribeSessions(listener: BridgeSessionListener) {
        this.listener = listener;
        return () => undefined;
    }
}

function bridge(pid: number): BridgeInterface {
    return {
        activePid: pid,
        identity: { nickname: `fixture-${pid}` },
        whenRosterWarmupSettled: async () => ({ friendsLoaded: false, groupsLoaded: false }),
    } as unknown as BridgeInterface;
}

function makeInstance(uin: string, disposeGate: Promise<void>) {
    return {
        uin,
        nickname: 'fixture',
        addPid: vi.fn(),
        receiveHealthChanged: vi.fn(),
        waitUntilNetworkReady: vi.fn(async () => ({ applied: true, statuses: [], errors: [] })),
        emitBotStatus: vi.fn(async (_status: 'online' | 'offline') => undefined),
        startLoginHistorySync: vi.fn(),
        getConnectionStatuses: vi.fn(() => []),
        quiesce: vi.fn(),
        forceRelease: vi.fn(),
        dispose: vi.fn(async () => {
            await disposeGate;
            return { closed: true, errors: [] };
        }),
    };
}

function fixture() {
    let release!: () => void;
    const disposeGate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const source = new FakeSource();
    const instances: Array<ReturnType<typeof makeInstance>> = [];
    const tasks: Array<{
        callbacks: DatabaseMigrationCallbacks | undefined;
        start: ReturnType<typeof vi.fn>;
        beginMigration: ReturnType<typeof vi.fn>;
        cancel: ReturnType<typeof vi.fn>;
        onCancel?: () => void;
    }> = [];
    let onNextTaskCreate: (() => void) | undefined;
    const createDatabaseMigrationTask = vi.fn(() => {
        const task = {
            callbacks: undefined as DatabaseMigrationCallbacks | undefined,
            start: vi.fn((callbacks: DatabaseMigrationCallbacks) => {
                task.callbacks = callbacks;

                // Task A is intentionally left preparing. Later tasks become ready synchronously.
                if (tasks.indexOf(task) > 0) {
                    callbacks.onReady();
                }
            }),
            beginMigration: vi.fn(),
            cancel: vi.fn(() => task.onCancel?.()),
            onCancel: undefined as (() => void) | undefined,
        };
        tasks.push(task);
        const onCreate = onNextTaskCreate;
        onNextTaskCreate = undefined;
        onCreate?.();
        return task;
    });
    const createInstance = vi.fn((uin: string, _bridge: BridgeInterface) => {
        const instance = makeInstance(uin, disposeGate);
        instances.push(instance);
        return instance as unknown as OneBotInstance;
    });
    const manager = new OneBotManager({
        createDatabaseMigrationTask,
        createInstance,
        sessionReleaseDeadlineMs: 100,
    });
    manager.bind(source);
    return {
        manager,
        source,
        instances,
        tasks,
        createInstance,
        release,
        setNextTaskCreateHook: (hook: () => void) => {
            onNextTaskCreate = hook;
        },
    };
}

// Release any gated operation and wait for disposal even when an assertion fails.
// A cleanup error must not replace the original test error.
async function withFixture(run: (f: ReturnType<typeof fixture>) => Promise<void>) {
    const f = fixture();
    let failed = false;
    let originalError: unknown;
    let cleanupError: unknown;
    let cleanupFailed = false;

    try {
        await run(f);
    } catch (error) {
        failed = true;
        originalError = error;
    } finally {
        f.release();
        const [result] = await Promise.allSettled([
            Promise.resolve().then(() => f.manager.dispose()),
        ]);

        if (result.status === 'rejected') {
            cleanupFailed = true;
            cleanupError = result.reason;
        }
    }

    if (failed) {
        throw originalError;
    }

    if (cleanupFailed) {
        throw cleanupError;
    }
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('SNOWLUMA_SESSION_RELEASE_DEADLINE_MS', '');
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('OneBotManager close reentry through migration cancellation', () => {
    it('retains a replacement instance and migration created synchronously by cancel', async () => {
        await withFixture(async (f) => {
            const a = bridge(11);
            const b = bridge(22);
            const listener = f.source.listener;
            listener.started!(UIN, a);
            expect(f.tasks).toHaveLength(1);
            f.tasks[0].onCancel = () => listener.started!(UIN, b);

            listener.closed!(UIN, a, 11);
            expect(f.tasks).toHaveLength(2);
            expect(f.instances).toHaveLength(1);
            const replacement = f.instances[0];
            // Drain the shutdown continuation before inspecting calls, without releasing the gate.
            await vi.advanceTimersByTimeAsync(0);

            expect.soft(f.tasks[0].cancel).toHaveBeenCalledOnce();
            expect.soft(f.tasks[1].cancel).not.toHaveBeenCalled();
            expect.soft(f.tasks[1].beginMigration).toHaveBeenCalledOnce();
            expect.soft(f.createInstance).toHaveBeenCalledOnce();
            expect
                .soft(f.createInstance)
                .toHaveBeenCalledWith(UIN, b, expect.anything(), expect.anything());
            expect.soft(f.manager.getInstance(UIN)).toBe(replacement);
            expect.soft(replacement.emitBotStatus).not.toHaveBeenCalledWith('offline');
            expect.soft(replacement.dispose).not.toHaveBeenCalled();
            const visibleMigration = f.manager
                .getConnectionStatuses()
                .find((item) => item.uin === UIN);
            expect.soft(visibleMigration?.databaseMigration?.phase).toBe('migrating');
        });
    });

    it('retains a replacement pending start created during cancellation', async () => {
        await withFixture(async (f) => {
            const a = bridge(31);
            const retiring = bridge(32);
            const b = bridge(33);
            const listener = f.source.listener;
            listener.started!(UIN, a);

            f.tasks[0].onCancel = () => {
                // A temporary generation retires and holds its dispose promise open;
                // B is therefore represented by the manager's real pending handoff.
                listener.started!(UIN, retiring);
                listener.closed!(UIN, retiring, 32);
                listener.started!(UIN, b);
            };

            listener.closed!(UIN, a, 31);
            expect(f.tasks).toHaveLength(2);
            expect(f.instances).toHaveLength(1);
            expect.soft(f.tasks[0].cancel).toHaveBeenCalledOnce();
            expect.soft(f.tasks[1].cancel).toHaveBeenCalledOnce();
            await Promise.resolve();
            await Promise.resolve();
            expect(f.createInstance).toHaveBeenCalledTimes(1);
            expect(f.instances[0].forceRelease).not.toHaveBeenCalled();
            f.release();
            await vi.advanceTimersByTimeAsync(0);

            expect.soft(f.tasks).toHaveLength(3);
            expect.soft(f.createInstance).toHaveBeenCalledTimes(2);
            expect
                .soft(f.createInstance)
                .toHaveBeenLastCalledWith(UIN, b, expect.anything(), expect.anything());
            const replacement = f.instances[1];
            expect.soft(replacement).toBeDefined();
            expect.soft(f.manager.getInstance(UIN)).toBe(replacement);

            if (replacement) {
                expect.soft(replacement.emitBotStatus).not.toHaveBeenCalledWith('offline');
                expect.soft(replacement.dispose).not.toHaveBeenCalled();
            }
        });
    });

    it('keeps a different-bridge pending start during cancel reentry', async () => {
        await withFixture(async (f) => {
            const a = bridge(41);
            const retiring = bridge(42);
            const older = bridge(43);
            const b = bridge(44);
            const listener = f.source.listener;
            // The injected factory deliberately reenters before the outer A migration
            // is registered. A real pending handoff and A migration then coexist.
            f.setNextTaskCreateHook(() => {
                listener.started!(UIN, retiring);
                listener.closed!(UIN, retiring, 42);
                listener.started!(UIN, older);
            });
            listener.started!(UIN, a);
            expect(f.tasks).toHaveLength(2);
            expect(f.instances).toHaveLength(1);
            expect(f.manager.getInstance(UIN)).toBeNull();
            const visibleMigration = f.manager
                .getConnectionStatuses()
                .find((item) => item.uin === UIN);
            expect(visibleMigration?.databaseMigration?.phase).toBe('preparing');
            f.tasks[0].onCancel = () => listener.started!(UIN, b);

            listener.closed!(UIN, a, 41);
            expect(f.tasks[0].cancel).toHaveBeenCalledOnce();
            expect(f.tasks).toHaveLength(2);
            f.release();
            await vi.advanceTimersByTimeAsync(0);

            expect(f.tasks).toHaveLength(3);
            expect(f.createInstance).toHaveBeenCalledTimes(2);
            expect(f.createInstance).toHaveBeenLastCalledWith(
                UIN,
                older,
                expect.anything(),
                expect.anything(),
            );
            expect(f.createInstance).not.toHaveBeenCalledWith(
                UIN,
                b,
                expect.anything(),
                expect.anything(),
            );
            expect(f.manager.getInstance(UIN)).toBe(f.instances[1]);
            expect(f.instances[1].emitBotStatus).not.toHaveBeenCalledWith('offline');
            expect(f.instances[1].dispose).not.toHaveBeenCalled();
            expect(f.tasks[2].cancel).not.toHaveBeenCalled();
        });
    });

    it('propagates the original cancel error while retaining another bridge pending start', async () => {
        await withFixture(async (f) => {
            const a = bridge(51);
            const retiring = bridge(52);
            const older = bridge(53);
            const b = bridge(54);
            const failure = new Error('synthetic cancel failure');
            const listener = f.source.listener;
            f.setNextTaskCreateHook(() => {
                listener.started!(UIN, retiring);
                listener.closed!(UIN, retiring, 52);
                listener.started!(UIN, older);
            });
            listener.started!(UIN, a);
            expect(f.tasks).toHaveLength(2);
            expect(f.manager.getInstance(UIN)).toBeNull();

            f.tasks[0].onCancel = () => {
                throw failure;
            };

            let caught: unknown;

            try {
                listener.closed!(UIN, a, 51);
            } catch (error) {
                caught = error;
            }

            expect(caught).toBe(failure);
            expect(f.tasks[0].cancel).toHaveBeenCalledOnce();
            // The pending start belongs to another bridge; B remains unaccepted.
            listener.started!(UIN, b);
            f.release();
            await vi.advanceTimersByTimeAsync(0);

            expect(f.tasks).toHaveLength(3);
            expect(f.createInstance).toHaveBeenCalledTimes(2);
            expect(f.createInstance).toHaveBeenLastCalledWith(
                UIN,
                older,
                expect.anything(),
                expect.anything(),
            );
            expect(f.createInstance).not.toHaveBeenCalledWith(
                UIN,
                b,
                expect.anything(),
                expect.anything(),
            );
            expect(f.manager.getInstance(UIN)).toBe(f.instances[1]);
        });
    });
});
