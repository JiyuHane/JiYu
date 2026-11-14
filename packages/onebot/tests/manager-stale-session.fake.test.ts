import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    BridgeInterface,
    BridgeSessionListener,
    BridgeSessionSource,
} from '@snowluma/core/bridge-interface';
import type { OneBotInstance } from '../src/instance';
import { OneBotManager, type DatabaseMigrationCallbacks } from '../src/manager';

// The manager is real; its instance, migration worker and configuration are not.
// A real OneBotInstance keeps its bridge private, so identity is observed at the
// injected factory boundary rather than by adding a bridge property to the fake.
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

class CapturingSource implements BridgeSessionSource {
    readonly listeners: BridgeSessionListener[] = [];
    onSubscribe?: (listener: BridgeSessionListener) => void;
    onUnsubscribe?: (listener: BridgeSessionListener) => void;
    readonly unsubscribe = vi.fn((listener: BridgeSessionListener) => {
        this.onUnsubscribe?.(listener);
    });
    readonly subscribeSessions = vi.fn((listener: BridgeSessionListener) => {
        this.listeners.push(listener);
        this.onSubscribe?.(listener);
        // Deliberately retain captured callbacks after unsubscribe.
        return () => this.unsubscribe(listener);
    });
}

function bridge(pid: number): BridgeInterface {
    return {
        activePid: pid,
        identity: { nickname: `fixture-${pid}` },
        whenRosterWarmupSettled: async () => ({ friendsLoaded: false, groupsLoaded: false }),
    } as unknown as BridgeInterface;
}

function makeInstance(uin: string, disposeGate?: Promise<void>) {
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

function fixture(firstDisposeGate?: Promise<void>) {
    const tasks: Array<{
        callbacks: DatabaseMigrationCallbacks;
        beginMigration: ReturnType<typeof vi.fn>;
        cancel: ReturnType<typeof vi.fn>;
    }> = [];
    const instances: Array<ReturnType<typeof makeInstance>> = [];
    const createDatabaseMigrationTask = vi.fn(() => {
        const task = {
            callbacks: undefined as unknown as DatabaseMigrationCallbacks,
            start: (callbacks: DatabaseMigrationCallbacks) => {
                task.callbacks = callbacks;
            },
            beginMigration: vi.fn(),
            cancel: vi.fn(),
        };
        tasks.push(task);
        return task;
    });
    const createInstance = vi.fn((uin: string, _bridge: BridgeInterface) => {
        const instance = makeInstance(uin, instances.length === 0 ? firstDisposeGate : undefined);
        instances.push(instance);
        return instance as unknown as OneBotInstance;
    });
    const manager = new OneBotManager({
        createDatabaseMigrationTask,
        createInstance,
        sessionReleaseDeadlineMs: 100,
    });
    return { manager, tasks, instances, createInstance, createDatabaseMigrationTask };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('SNOWLUMA_SESSION_RELEASE_DEADLINE_MS', '');
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('OneBotManager stale source listeners', () => {
    it('ignores captured old started, closed and health callbacks after rebind while current close works', async () => {
        const f = fixture();
        const a = new CapturingSource();
        const b = new CapturingSource();
        const oldBridge = bridge(11);
        const currentBridge = bridge(22);
        f.manager.bind(a);
        const old = a.listeners[0];
        f.manager.bind(b);
        const current = b.listeners[0];

        try {
            expect(a.unsubscribe).toHaveBeenCalledOnce();
            old.started!(UIN, oldBridge);
            expect(f.createDatabaseMigrationTask).not.toHaveBeenCalled();
            current.started!(UIN, currentBridge);
            expect(f.tasks).toHaveLength(1);
            const migrationBefore = f.manager.getConnectionStatuses()[0].databaseMigration;
            old.closed!(UIN, oldBridge, 11);
            expect(f.tasks[0].cancel).not.toHaveBeenCalled();
            expect(f.manager.getConnectionStatuses()[0].databaseMigration).toBe(migrationBefore);
            f.tasks[0].callbacks.onReady();
            const instance = f.instances[0];
            expect(f.createInstance).toHaveBeenCalledWith(
                UIN,
                currentBridge,
                expect.anything(),
                expect.anything(),
            );
            expect(instance.addPid).toHaveBeenCalledWith(22);
            old.closed!(UIN, oldBridge, 11);
            old.receiveHealthChanged!(UIN, currentBridge);
            expect(f.manager.getInstance(UIN)).toBe(instance);
            expect(instance.receiveHealthChanged).not.toHaveBeenCalled();
            expect(instance.emitBotStatus).not.toHaveBeenCalledWith('offline');
            expect(instance.forceRelease).not.toHaveBeenCalled();
            expect(f.tasks[0].cancel).not.toHaveBeenCalled();
            current.receiveHealthChanged!(UIN, currentBridge);
            expect(instance.receiveHealthChanged).toHaveBeenCalledOnce();
            expect(instance.receiveHealthChanged).toHaveBeenCalledWith(currentBridge);
            current.closed!(UIN, currentBridge, 22);
            expect(f.manager.getInstance(UIN)).toBeNull();
            expect(f.tasks[0].cancel).toHaveBeenCalledOnce();
            expect(instance.emitBotStatus).toHaveBeenCalledWith('offline');
            await vi.advanceTimersByTimeAsync(0);
            expect(instance.dispose).toHaveBeenCalledOnce();
        } finally {
            await f.manager.dispose();
        }
    });

    it('keeps a current pending handoff when a superseded source closes', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const f = fixture(gate);
        const a = new CapturingSource();
        const b = new CapturingSource();
        const firstBridge = bridge(31);
        const nextBridge = bridge(32);
        f.manager.bind(a);
        const old = a.listeners[0];
        f.manager.bind(b);
        const current = b.listeners[0];

        try {
            current.started!(UIN, firstBridge);
            f.tasks[0].callbacks.onReady();
            const first = f.instances[0];
            current.closed!(UIN, firstBridge, 31);
            current.started!(UIN, nextBridge);
            expect(f.manager.getInstance(UIN)).toBeNull();
            expect(f.tasks).toHaveLength(1);
            old.closed!(UIN, firstBridge, 31);
            old.started!('other', firstBridge);
            expect(f.tasks).toHaveLength(1);
            expect(first.forceRelease).not.toHaveBeenCalled();
            release();
            await vi.advanceTimersByTimeAsync(0);
            expect(f.tasks).toHaveLength(2);
            f.tasks[1].callbacks.onReady();
            expect(f.createInstance).toHaveBeenLastCalledWith(
                UIN,
                nextBridge,
                expect.anything(),
                expect.anything(),
            );
            expect(f.manager.getInstance(UIN)).toBe(f.instances[1]);
            expect(first.forceRelease).not.toHaveBeenCalled();
        } finally {
            release();
            await f.manager.dispose();
        }
    });

    it('invalidates captured callbacks synchronously before dispose unsubscribe', async () => {
        const f = fixture();
        const source = new CapturingSource();
        const peer = bridge(41);
        f.manager.bind(source);
        const listener = source.listeners[0];

        source.onUnsubscribe = () => {
            listener.started!('other', peer);
            listener.closed!(UIN, peer, 41);
            listener.receiveHealthChanged!(UIN, peer);
        };

        listener.started!(UIN, peer);
        f.tasks[0].callbacks.onReady();
        const instance = f.instances[0];
        await f.manager.dispose();
        listener.started!('late', peer);
        listener.closed!(UIN, peer, 41);
        listener.receiveHealthChanged!(UIN, peer);
        expect(f.createDatabaseMigrationTask).toHaveBeenCalledOnce();
        expect(f.tasks[0].cancel).toHaveBeenCalledOnce();
        expect(instance.emitBotStatus).not.toHaveBeenCalledWith('offline');
        expect(instance.receiveHealthChanged).not.toHaveBeenCalled();
        expect(instance.dispose).toHaveBeenCalledOnce();
        expect(instance.forceRelease).not.toHaveBeenCalled();
    });

    it('recognizes the new binding during synchronous subscribe reentry', async () => {
        const f = fixture();
        const a = new CapturingSource();
        const b = new CapturingSource();
        const peer = bridge(51);

        a.onSubscribe = (old) => {
            f.manager.bind(b);
            old.started!('stale', peer);
            old.closed!(UIN, peer, 51);
            b.listeners[0].started!(UIN, peer);
        };

        try {
            f.manager.bind(a);
            expect(a.unsubscribe).toHaveBeenCalledOnce();
            expect(f.tasks).toHaveLength(1);
            f.tasks[0].callbacks.onReady();
            a.listeners[0].closed!(UIN, peer, 51);
            expect(f.manager.getInstance(UIN)).toBe(f.instances[0]);
            expect(f.tasks[0].cancel).not.toHaveBeenCalled();
            b.listeners[0].closed!(UIN, peer, 51);
            expect(f.tasks[0].cancel).toHaveBeenCalledOnce();
            expect(f.manager.getInstance(UIN)).toBeNull();
        } finally {
            await f.manager.dispose();
        }

        expect(b.unsubscribe).toHaveBeenCalledOnce();
    });

    it('fails closed after unsubscribe throws and resumes on a successful bind', async () => {
        const f = fixture();
        const a = new CapturingSource();
        const b = new CapturingSource();
        const peer = bridge(71);
        const failure = new Error('unsubscribe fixture');
        f.manager.bind(a);
        const old = a.listeners[0];
        old.started!(UIN, peer);
        f.tasks[0].callbacks.onReady();
        const instance = f.instances[0];
        a.onUnsubscribe = vi.fn().mockImplementationOnce(() => {
            throw failure;
        });

        try {
            let thrown: unknown;

            try {
                f.manager.bind(b);
            } catch (error) {
                thrown = error;
            }

            expect(thrown).toBe(failure);
            expect(a.unsubscribe).toHaveBeenCalledOnce();
            expect(b.subscribeSessions).not.toHaveBeenCalled();
            old.started!('other', peer);
            old.closed!(UIN, peer, 71);
            old.receiveHealthChanged!(UIN, peer);
            expect(f.tasks).toHaveLength(1);
            expect(f.tasks[0].cancel).not.toHaveBeenCalled();
            expect(f.manager.getInstance(UIN)).toBe(instance);
            expect(instance.receiveHealthChanged).not.toHaveBeenCalled();
            expect(instance.emitBotStatus).not.toHaveBeenCalledWith('offline');
            expect(instance.forceRelease).not.toHaveBeenCalled();

            f.manager.bind(b);
            expect(a.unsubscribe).toHaveBeenCalledTimes(2);
            expect(b.subscribeSessions).toHaveBeenCalledOnce();
            old.closed!(UIN, peer, 71);
            expect(f.manager.getInstance(UIN)).toBe(instance);
            b.listeners[0].receiveHealthChanged!(UIN, peer);
            expect(instance.receiveHealthChanged).toHaveBeenCalledWith(peer);
            b.listeners[0].closed!(UIN, peer, 71);
            expect(f.manager.getInstance(UIN)).toBeNull();
            expect(f.tasks[0].cancel).toHaveBeenCalledOnce();
            expect(instance.emitBotStatus).toHaveBeenCalledWith('offline');
        } finally {
            await f.manager.dispose();
        }
    });

    it('invalidates the old callback before unsubscribe reenters bind', async () => {
        const f = fixture();
        const a = new CapturingSource();
        const superseded = new CapturingSource();
        const c = new CapturingSource();
        const peer = bridge(61);
        f.manager.bind(a);
        const old = a.listeners[0];

        a.onUnsubscribe = () => {
            old.started!('stale', peer);
            old.closed!(UIN, peer, 61);
            f.manager.bind(c);
            c.listeners[0].started!(UIN, peer);
            old.closed!(UIN, peer, 61);
        };

        try {
            f.manager.bind(superseded);
            expect(superseded.subscribeSessions).not.toHaveBeenCalled();
            expect(f.tasks).toHaveLength(1);
            expect(f.tasks[0].cancel).not.toHaveBeenCalled();
            f.tasks[0].callbacks.onReady();
            expect(f.manager.getInstance(UIN)).toBe(f.instances[0]);
            c.listeners[0].closed!(UIN, peer, 61);
            expect(f.tasks[0].cancel).toHaveBeenCalledOnce();
        } finally {
            await f.manager.dispose();
        }

        expect(c.unsubscribe).toHaveBeenCalledOnce();
    });
});
