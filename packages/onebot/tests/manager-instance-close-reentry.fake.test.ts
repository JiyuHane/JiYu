import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    BridgeInterface,
    BridgeSessionListener,
    BridgeSessionSource,
} from '@snowluma/core/bridge-interface';
import type { OneBotInstance } from '../src/instance';
import { OneBotManager, type DatabaseMigrationCallbacks } from '../src/manager';

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
const OTHER = '10002';

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

function fixture() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const source = new FakeSource();
    const instances: Array<{
        uin: string;
        bridge: BridgeInterface;
        emitBotStatus: ReturnType<typeof vi.fn>;
        dispose: ReturnType<typeof vi.fn>;
        forceRelease: ReturnType<typeof vi.fn>;
    }> = [];
    const tasks: Array<{
        uin: string;
        cancel: ReturnType<typeof vi.fn>;
        onCancel?: () => void;
    }> = [];
    const createDatabaseMigrationTask = vi.fn((uin: string) => {
        const task = {
            uin,
            start: vi.fn((callbacks: DatabaseMigrationCallbacks) => callbacks.onReady()),
            beginMigration: vi.fn(),
            cancel: vi.fn(() => task.onCancel?.()),
            onCancel: undefined as (() => void) | undefined,
        };
        tasks.push(task);
        return task;
    });
    const createInstance = vi.fn((uin: string, session: BridgeInterface) => {
        const instance = {
            uin,
            bridge: session,
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
                await gate;
                return { closed: true, errors: [] };
            }),
        };
        instances.push(instance);
        return instance as unknown as OneBotInstance;
    });
    const manager = new OneBotManager({
        createDatabaseMigrationTask,
        createInstance,
        sessionReleaseDeadlineMs: 100,
    });
    manager.bind(source);
    const pending = (uin: string) =>
        (
            manager as unknown as { pendingStarts: Map<string, { bridge: BridgeInterface }> }
        ).pendingStarts.get(uin);
    return { manager, source, instances, tasks, createInstance, pending, release };
}

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

describe('OneBotManager instance-present close cancellation reentry', () => {
    it('retains B pending through nested close of A until its disposal is released', async () => {
        await withFixture(async (f) => {
            const a = bridge(11);
            const b = bridge(12);
            const listener = f.source.listener;
            listener.started!(UIN, a);
            const old = f.instances[0];
            expect(f.manager.getInstance(UIN)).toBe(old);

            f.tasks[0].onCancel = () => {
                listener.closed!(UIN, a, 11);
                listener.started!(UIN, b);
                expect(f.pending(UIN)?.bridge).toBe(b);
            };

            listener.closed!(UIN, a, 11);
            expect(f.pending(UIN)?.bridge).toBe(b);
            expect(f.manager.getInstance(UIN)).toBeNull();
            expect(old.emitBotStatus).toHaveBeenCalledTimes(1);
            expect(old.emitBotStatus).toHaveBeenCalledWith('offline');
            expect(old.dispose).toHaveBeenCalled();
            expect(old.forceRelease).not.toHaveBeenCalled();
            expect(f.createInstance).toHaveBeenCalledTimes(1);
            f.release();
            await vi.advanceTimersByTimeAsync(0);

            expect(f.createInstance).toHaveBeenCalledTimes(2);
            expect(f.createInstance).toHaveBeenLastCalledWith(
                UIN,
                b,
                expect.anything(),
                expect.anything(),
            );
            const replacement = f.instances[1];
            expect(f.manager.getInstance(UIN)).toBe(replacement);
            expect(replacement.emitBotStatus).not.toHaveBeenCalledWith('offline');
            expect(replacement.dispose).not.toHaveBeenCalled();
            expect(
                old.emitBotStatus.mock.calls.filter(([status]) => status === 'offline'),
            ).toHaveLength(1);
        });
    });

    it('retires A normally and defers B until release when cancel returns normally', async () => {
        await withFixture(async (f) => {
            const a = bridge(21);
            const b = bridge(22);
            const listener = f.source.listener;
            listener.started!(UIN, a);
            const old = f.instances[0];
            listener.closed!(UIN, a, 21);
            listener.started!(UIN, b);
            expect(f.pending(UIN)?.bridge).toBe(b);
            expect(f.manager.getInstance(UIN)).toBeNull();
            expect(old.emitBotStatus).toHaveBeenCalledWith('offline');
            expect(old.dispose).toHaveBeenCalled();
            expect(f.createInstance).toHaveBeenCalledTimes(1);
            f.release();
            await vi.advanceTimersByTimeAsync(0);
            expect(f.manager.getInstance(UIN)).toBe(f.instances[1]);
            expect(f.instances[1].bridge).toBe(b);
            expect(f.instances[1].emitBotStatus).not.toHaveBeenCalledWith('offline');
        });
    });

    it('propagates the exact cancel error and leaves A active without nested events', async () => {
        await withFixture(async (f) => {
            const a = bridge(31);
            const failure = new Error('cancel failure');
            const listener = f.source.listener;
            listener.started!(UIN, a);
            const old = f.instances[0];

            f.tasks[0].onCancel = () => {
                throw failure;
            };

            let caught: unknown;

            try {
                listener.closed!(UIN, a, 31);
            } catch (error) {
                caught = error;
            }

            expect(caught).toBe(failure);
            expect(f.manager.getInstance(UIN)).toBe(old);
            expect(old.emitBotStatus).not.toHaveBeenCalledWith('offline');
            expect(old.dispose).not.toHaveBeenCalled();
        });
    });

    it('preserves B when nested close and start precede the exact cancel error', async () => {
        await withFixture(async (f) => {
            const a = bridge(41);
            const b = bridge(42);
            const failure = new Error('nested cancel failure');
            const listener = f.source.listener;
            listener.started!(UIN, a);
            const old = f.instances[0];

            f.tasks[0].onCancel = () => {
                listener.closed!(UIN, a, 41);
                listener.started!(UIN, b);
                throw failure;
            };

            let caught: unknown;

            try {
                listener.closed!(UIN, a, 41);
            } catch (error) {
                caught = error;
            }

            expect(caught).toBe(failure);
            expect(f.pending(UIN)?.bridge).toBe(b);
            expect(
                old.emitBotStatus.mock.calls.filter(([status]) => status === 'offline'),
            ).toHaveLength(1);
            expect(old.dispose).toHaveBeenCalled();
            f.release();
            await vi.advanceTimersByTimeAsync(0);
            expect(f.manager.getInstance(UIN)).toBe(f.instances[1]);
            expect(f.instances[1].bridge).toBe(b);
            expect(f.instances[1].emitBotStatus).not.toHaveBeenCalledWith('offline');
            expect(f.instances[1].dispose).not.toHaveBeenCalled();
        });
    });

    it('keeps another account active while A closes and B waits', async () => {
        await withFixture(async (f) => {
            const a = bridge(51);
            const b = bridge(52);
            const other = bridge(53);
            const listener = f.source.listener;
            listener.started!(UIN, a);
            listener.started!(OTHER, other);
            const otherInstance = f.instances[1];

            f.tasks[0].onCancel = () => {
                listener.closed!(UIN, a, 51);
                listener.started!(UIN, b);
            };

            listener.closed!(UIN, a, 51);
            expect(f.pending(UIN)?.bridge).toBe(b);
            expect(f.manager.getInstance(OTHER)).toBe(otherInstance);
            expect(f.tasks[1].cancel).not.toHaveBeenCalled();
            expect(otherInstance.emitBotStatus).not.toHaveBeenCalledWith('offline');
            expect(otherInstance.dispose).not.toHaveBeenCalled();
            f.release();
            await vi.advanceTimersByTimeAsync(0);
            expect(f.manager.getInstance(UIN)).toBe(f.instances[2]);
            expect(f.instances[2].bridge).toBe(b);
            expect(f.manager.getInstance(OTHER)).toBe(otherInstance);
            expect(otherInstance.emitBotStatus).not.toHaveBeenCalledWith('offline');
            expect(otherInstance.dispose).not.toHaveBeenCalled();
        });
    });
});
