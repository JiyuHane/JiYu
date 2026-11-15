import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dgram from 'node:dgram';
import type {
    BridgeInterface,
    BridgeSessionListener,
    BridgeSessionSource,
} from '@snowluma/core/bridge-interface';
import type { OneBotInstance } from '../src/instance';
import { OneBotManager, type DatabaseMigrationCallbacks } from '../src/manager';

// Only the manager is real. No instance, Bridge, migration worker or network is started.
vi.mock('../src/instance', () => ({
    OneBotInstance: class {
        constructor() {
            throw new Error('unexpected real OneBotInstance');
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
    readonly listeners: BridgeSessionListener[] = [];
    readonly unsubscribe = vi.fn();
    subscribeSessions(listener: BridgeSessionListener) {
        this.listeners.push(listener);
        // Intentionally retain the listener to exercise the binding fence.
        return this.unsubscribe;
    }
}

function fakeBridge(pid: number): BridgeInterface {
    return {
        activePid: pid,
        identity: { nickname: `fixture-${pid}` },
        whenRosterWarmupSettled: async () => ({ friendsLoaded: false, groupsLoaded: false }),
    } as unknown as BridgeInterface;
}

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function makeFixture() {
    const gate = deferred();
    const gates = [gate];
    const source = new FakeSource();
    const tasks: Array<{
        uin: string;
        callbacks: DatabaseMigrationCallbacks | undefined;
        start: ReturnType<typeof vi.fn>;
        beginMigration: ReturnType<typeof vi.fn>;
        cancel: ReturnType<typeof vi.fn>;
        onCancel?: () => void;
    }> = [];
    const instances: Array<ReturnType<typeof makeInstance>> = [];
    let synchronousReady = false;
    let nextTaskCreate: (() => void) | undefined;

    function makeInstance(uin: string, bridge: BridgeInterface) {
        let disposePromise: Promise<{ closed: boolean; errors: never[] }> | undefined;
        const quiesce = vi.fn();
        return {
            uin,
            bridge,
            nickname: 'fixture',
            addPid: vi.fn(),
            receiveHealthChanged: vi.fn(),
            waitUntilNetworkReady: vi.fn(async () => ({ applied: true, statuses: [], errors: [] })),
            emitBotStatus: vi.fn(async (_status: 'online' | 'offline') => undefined),
            startLoginHistorySync: vi.fn(),
            getConnectionStatuses: vi.fn(() => []),
            quiesce,
            forceRelease: vi.fn(),
            // Mirror the instance's synchronous quiesce and idempotent dispose promise.
            dispose: vi.fn(() => {
                if (!disposePromise) {
                    quiesce();
                    disposePromise = gate.promise.then(() => ({ closed: true, errors: [] }));
                }

                return disposePromise;
            }),
        };
    }

    const createDatabaseMigrationTask = vi.fn((uin: string) => {
        const task = {
            uin,
            callbacks: undefined as DatabaseMigrationCallbacks | undefined,
            start: vi.fn((callbacks: DatabaseMigrationCallbacks) => {
                task.callbacks = callbacks;

                if (synchronousReady) {
                    callbacks.onReady();
                }
            }),
            beginMigration: vi.fn(),
            cancel: vi.fn(() => task.onCancel?.()),
            onCancel: undefined as (() => void) | undefined,
        };
        tasks.push(task);
        const hook = nextTaskCreate;
        nextTaskCreate = undefined;
        hook?.();
        return task;
    });
    const createInstance = vi.fn((uin: string, bridge: BridgeInterface) => {
        const instance = makeInstance(uin, bridge);
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
    const result = {
        manager,
        source,
        tasks,
        instances,
        createInstance,
        createDatabaseMigrationTask,
        pending,
        release: gate.resolve,
        releaseAll: () => gates.forEach((item) => item.resolve()),
        defer: () => {
            const item = deferred();
            gates.push(item);
            return item;
        },
        readySynchronously: () => {
            synchronousReady = true;
        },
        setSynchronousReady: (ready: boolean) => {
            synchronousReady = ready;
        },
        onNextTaskCreate: (hook: () => void) => {
            nextTaskCreate = hook;
        },
    };
    fixtures.push(result);
    return result;
}

type Fixture = ReturnType<typeof makeFixture>;
const fixtures: Fixture[] = [];
let fetchGuard: ReturnType<typeof vi.fn>;
let networkGuards: Array<{ mock: { calls: unknown[] } }>;

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('SNOWLUMA_SESSION_RELEASE_DEADLINE_MS', '');
    fetchGuard = vi.fn(() => {
        throw new Error('unexpected real fetch');
    });
    vi.stubGlobal('fetch', fetchGuard);

    const blocked = () => {
        throw new Error('unexpected real network operation');
    };

    networkGuards = [
        vi.spyOn(net, 'createServer').mockImplementation(blocked),
        vi.spyOn(net, 'createConnection').mockImplementation(blocked),
        vi.spyOn(net, 'connect').mockImplementation(blocked),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(blocked),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(http, 'createServer').mockImplementation(blocked),
        vi.spyOn(http, 'request').mockImplementation(blocked),
        vi.spyOn(http, 'get').mockImplementation(blocked),
        vi.spyOn(https, 'createServer').mockImplementation(blocked),
        vi.spyOn(https, 'request').mockImplementation(blocked),
        vi.spyOn(https, 'get').mockImplementation(blocked),
        vi.spyOn(tls, 'connect').mockImplementation(blocked),
        vi.spyOn(tls, 'createServer').mockImplementation(blocked),
        vi.spyOn(dgram, 'createSocket').mockImplementation(blocked),
    ];
});

afterEach(async () => {
    const active = fixtures.splice(0);

    try {
        // Release all deferred operations, including those reached after an assertion fails.
        for (const f of active) {
            f.releaseAll();
        }

        await vi.advanceTimersByTimeAsync(0);
        const cleanup = await Promise.allSettled(active.map((f) => f.manager.dispose()));
        expect.soft(cleanup.map((result) => result.status)).toEqual(active.map(() => 'fulfilled'));
        expect.soft(fetchGuard).not.toHaveBeenCalled();

        for (const guard of networkGuards) {
            expect.soft(guard.mock.calls).toHaveLength(0);
        }
    } finally {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.useRealTimers();
    }
});

describe('OneBotManager same-source Bridge generation fencing', () => {
    it('preserves B pending and active across duplicate close of retired A', async () => {
        const f = makeFixture();
        const listener = f.source.listeners[0];
        // Same PID deliberately: Bridge object identity, not PID, is the fence.
        const a = fakeBridge(7);
        const b = fakeBridge(7);
        listener.started!(UIN, a);
        expect(f.tasks).toHaveLength(1);
        f.tasks[0].callbacks!.onReady();
        expect(f.createInstance).toHaveBeenCalledTimes(1);
        expect(f.manager.getInstance(UIN)).toBe(f.instances[0]);
        expect(f.tasks[0].beginMigration).toHaveBeenCalledOnce();

        listener.closed!(UIN, a, 7);
        expect(f.tasks[0].cancel).toHaveBeenCalledTimes(1);
        expect(f.manager.getInstance(UIN)).toBeNull();
        listener.started!(UIN, b);
        expect(f.pending(UIN)?.bridge).toBe(b);
        expect(f.tasks).toHaveLength(1);
        const oldDisposeCount = f.instances[0].dispose.mock.calls.length;
        listener.closed!(UIN, a, 7);
        expect(f.pending(UIN)?.bridge).toBe(b);
        expect(f.tasks[0].cancel).toHaveBeenCalledTimes(1);
        expect(f.instances[0].dispose).toHaveBeenCalledTimes(oldDisposeCount);

        f.release();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.pending(UIN)).toBeUndefined();
        expect(f.tasks).toHaveLength(2);
        f.tasks[1].callbacks!.onReady();
        expect(f.createInstance).toHaveBeenCalledTimes(2);
        expect(f.createInstance).toHaveBeenLastCalledWith(
            UIN,
            b,
            expect.anything(),
            expect.anything(),
        );
        const next = f.instances[1];
        expect(f.manager.getInstance(UIN)).toBe(next);
        expect(f.tasks[1].beginMigration).toHaveBeenCalledTimes(1);
        listener.closed!(UIN, a, 7);
        expect(f.manager.getInstance(UIN)).toBe(next);
        expect(f.tasks[1].cancel).not.toHaveBeenCalled();
        expect(next.quiesce).not.toHaveBeenCalled();
        expect(next.dispose).not.toHaveBeenCalled();
        expect(next.emitBotStatus).not.toHaveBeenCalledWith('offline');

        listener.closed!(UIN, b, 7);
        expect(f.manager.getInstance(UIN)).toBeNull();
        expect(f.tasks[1].cancel).toHaveBeenCalledTimes(1);
        expect(next.emitBotStatus).toHaveBeenCalledWith('offline');
        await vi.advanceTimersByTimeAsync(0);
        expect(next.dispose).toHaveBeenCalledTimes(1);
        listener.closed!(UIN, b, 7);
        expect(f.tasks[1].cancel).toHaveBeenCalledTimes(1);
        expect(next.dispose).toHaveBeenCalledTimes(1);
    });

    it('preserves B preparation when A closes again before B becomes ready', () => {
        const f = makeFixture();
        const listener = f.source.listeners[0];
        const a = fakeBridge(21);
        const b = fakeBridge(22);
        listener.started!(UIN, a);
        expect(f.tasks).toHaveLength(1);
        listener.closed!(UIN, a, 21);
        expect(f.tasks[0].cancel).toHaveBeenCalledTimes(1);
        listener.started!(UIN, b);
        expect(f.tasks).toHaveLength(2);
        expect(
            f.manager.getConnectionStatuses().find((entry) => entry.uin === UIN)?.databaseMigration
                ?.phase,
        ).toBe('preparing');
        listener.closed!(UIN, a, 21);
        f.tasks[0].callbacks!.onFailed(new Error('stale migration rejection'));
        f.tasks[0].callbacks!.onReady();
        expect(f.tasks[0].beginMigration).not.toHaveBeenCalled();
        expect(f.tasks[0].cancel).toHaveBeenCalledTimes(1);
        expect(f.tasks[1].cancel).not.toHaveBeenCalled();
        expect(f.createInstance).not.toHaveBeenCalled();
        expect(
            f.manager.getConnectionStatuses().find((entry) => entry.uin === UIN)?.databaseMigration
                ?.phase,
        ).toBe('preparing');
        f.tasks[1].callbacks!.onReady();
        expect(f.createInstance).toHaveBeenCalledTimes(1);
        expect(f.createInstance).toHaveBeenLastCalledWith(
            UIN,
            b,
            expect.anything(),
            expect.anything(),
        );
        expect(f.manager.getInstance(UIN)).toBe(f.instances[0]);
        expect(f.tasks[1].beginMigration).toHaveBeenCalledTimes(1);
    });

    it('keeps synchronously reentered B migration and instance after cancelling A', () => {
        const f = makeFixture();
        const listener = f.source.listeners[0];
        const a = fakeBridge(31);
        const b = fakeBridge(32);
        listener.started!(UIN, a);
        expect(f.tasks).toHaveLength(1);
        f.readySynchronously();
        f.tasks[0].onCancel = () => listener.started!(UIN, b);
        listener.closed!(UIN, a, 31);
        expect(f.tasks[0].cancel).toHaveBeenCalledTimes(1);
        expect(f.tasks).toHaveLength(2);
        expect(f.tasks[1].start).toHaveBeenCalledTimes(1);
        expect(f.tasks[1].beginMigration).toHaveBeenCalledTimes(1);
        expect(f.tasks[1].cancel).not.toHaveBeenCalled();
        expect(f.createInstance).toHaveBeenCalledTimes(1);
        expect(f.createInstance).toHaveBeenLastCalledWith(
            UIN,
            b,
            expect.anything(),
            expect.anything(),
        );
        expect(f.manager.getInstance(UIN)).toBe(f.instances[0]);
        expect(f.instances[0].quiesce).not.toHaveBeenCalled();
        expect(f.instances[0].dispose).not.toHaveBeenCalled();
        expect(
            f.manager.getConnectionStatuses().find((entry) => entry.uin === UIN)?.databaseMigration
                ?.phase,
        ).toBe('migrating');
        listener.closed!(UIN, a, 31);
        expect(f.tasks[1].cancel).not.toHaveBeenCalled();
        expect(f.manager.getInstance(UIN)).toBe(f.instances[0]);
    });

    it('closes only the matching generation, with idempotent duplicate close', async () => {
        const f = makeFixture();
        const listener = f.source.listeners[0];
        const a = fakeBridge(41);
        const b = fakeBridge(42);
        listener.started!(UIN, a);
        listener.closed!(UIN, a, 41);
        listener.started!(UIN, b);
        expect(f.tasks).toHaveLength(2);
        f.tasks[1].callbacks!.onReady();
        const current = f.instances[0];
        expect(f.manager.getInstance(UIN)).toBe(current);
        expect(f.tasks[1].beginMigration).toHaveBeenCalledTimes(1);
        listener.closed!(UIN, b, 42);
        expect(f.tasks[1].cancel).toHaveBeenCalledTimes(1);
        expect(f.manager.getInstance(UIN)).toBeNull();
        expect(current.emitBotStatus).toHaveBeenCalledTimes(1);
        expect(current.emitBotStatus).toHaveBeenCalledWith('offline');
        await vi.advanceTimersByTimeAsync(0);
        expect(current.dispose).toHaveBeenCalledTimes(1);
        expect(current.quiesce).toHaveBeenCalledTimes(1);
        listener.closed!(UIN, b, 42);
        expect(f.tasks[1].cancel).toHaveBeenCalledTimes(1);
        expect(current.quiesce).toHaveBeenCalledTimes(1);
        expect(current.dispose).toHaveBeenCalledTimes(1);
    });

    it('uses the factory Bridge owner rather than a mutable fake instance property', async () => {
        const f = makeFixture();
        const listener = f.source.listeners[0];
        const a = fakeBridge(43);
        const b = fakeBridge(44);
        listener.started!(UIN, a);
        f.tasks[0].callbacks!.onReady();
        const old = f.instances[0];
        expect(f.createInstance).toHaveBeenCalledTimes(1);
        expect(f.createInstance).toHaveBeenLastCalledWith(
            UIN,
            a,
            expect.anything(),
            expect.anything(),
        );
        expect(f.manager.getInstance(UIN)).toBe(old);
        old.bridge = b;
        listener.closed!(UIN, b, 44);
        expect(f.manager.getInstance(UIN)).toBe(old);
        expect(f.tasks[0].cancel).not.toHaveBeenCalled();
        expect(old.quiesce).not.toHaveBeenCalled();
        expect(old.dispose).not.toHaveBeenCalled();
        listener.started!(UIN, b);
        expect(f.createDatabaseMigrationTask).toHaveBeenCalledTimes(1);
        expect(f.manager.getInstance(UIN)).toBe(old);
        listener.closed!(UIN, a, 43);
        expect(f.tasks[0].cancel).toHaveBeenCalledTimes(1);
        expect(f.manager.getInstance(UIN)).toBeNull();
        expect(old.emitBotStatus).toHaveBeenCalledWith('offline');
        listener.started!(UIN, b);
        expect(f.pending(UIN)?.bridge).toBe(b);
        f.release();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.tasks).toHaveLength(2);
        f.tasks[1].callbacks!.onReady();
        expect(f.createInstance).toHaveBeenCalledTimes(2);
        expect(f.createInstance).toHaveBeenLastCalledWith(
            UIN,
            b,
            expect.anything(),
            expect.anything(),
        );
        expect(f.manager.getInstance(UIN)).toBe(f.instances[1]);
    });

    it('detaches matching pending before a throwing migration cancel reenters callbacks', async () => {
        const f = makeFixture();
        const listener = f.source.listeners[0];
        const a = fakeBridge(45);
        const retiring = fakeBridge(46);
        const failure = new Error('synthetic cancel failure');
        // Reenter before A's migration is installed: retire another fake generation,
        // then queue A while the outer A factory is still on the stack.
        f.onNextTaskCreate(() => {
            f.setSynchronousReady(true);
            listener.started!(UIN, retiring);
            listener.closed!(UIN, retiring, 46);
            listener.started!(UIN, a);
            f.setSynchronousReady(false);
        });
        listener.started!(UIN, a);
        expect(f.tasks).toHaveLength(2);
        expect(f.tasks[0].start).toHaveBeenCalledTimes(1);
        expect(f.tasks[1].cancel).toHaveBeenCalledTimes(1);
        expect(f.createInstance).toHaveBeenCalledTimes(1);
        expect(f.pending(UIN)?.bridge).toBe(a);
        expect(f.manager.getInstance(UIN)).toBeNull();
        expect(
            f.manager.getConnectionStatuses().find((entry) => entry.uin === UIN)?.databaseMigration
                ?.phase,
        ).toBe('preparing');

        let pendingAtCancel: { bridge: BridgeInterface } | undefined;

        f.tasks[0].onCancel = () => {
            pendingAtCancel = f.pending(UIN);
            f.tasks[0].callbacks!.onReady();
            f.tasks[0].callbacks!.onFailed(failure);
            throw failure;
        };

        let thrown: unknown;

        try {
            listener.closed!(UIN, a, 45);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBe(failure);
        expect(pendingAtCancel).toBeUndefined();
        expect(f.pending(UIN)).toBeUndefined();
        expect(f.tasks[0].cancel).toHaveBeenCalledTimes(1);
        expect(f.tasks[0].beginMigration).not.toHaveBeenCalled();
        expect(f.createInstance).toHaveBeenCalledTimes(1);
        expect(f.manager.getInstance(UIN)).toBeNull();
        f.release();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.tasks).toHaveLength(2);
        expect(f.createInstance).toHaveBeenCalledTimes(1);
        expect(f.manager.getInstance(UIN)).toBeNull();
    });

    it('does not resume close after cancel reenters dispose and unsubscribe throws', async () => {
        const f = makeFixture();
        const listener = f.source.listeners[0];
        const a = fakeBridge(43);
        const failure = new Error('synthetic unsubscribe failure');
        listener.started!(UIN, a);
        f.tasks[0].callbacks!.onReady();
        const current = f.instances[0];
        expect(f.manager.getInstance(UIN)).toBe(current);
        f.source.unsubscribe.mockImplementationOnce(() => {
            throw failure;
        });
        let observed: unknown;

        f.tasks[0].onCancel = () => {
            try {
                void f.manager.dispose();
            } catch (error) {
                observed = error;
            }
        };

        listener.closed!(UIN, a, 43);
        expect(observed).toBe(failure);
        expect(f.source.unsubscribe).toHaveBeenCalledTimes(1);
        expect(f.tasks[0].cancel).toHaveBeenCalledTimes(1);
        expect(f.manager.getInstance(UIN)).toBe(current);
        expect(current.emitBotStatus).not.toHaveBeenCalledWith('offline');
        expect(current.quiesce).not.toHaveBeenCalled();
        expect(current.dispose).not.toHaveBeenCalled();
        const completion = f.manager.dispose();
        f.release();
        await expect(completion).resolves.toBeUndefined();
        expect(f.source.unsubscribe).toHaveBeenCalledTimes(2);
        expect(current.dispose).toHaveBeenCalledTimes(1);
        expect(current.emitBotStatus).not.toHaveBeenCalledWith('offline');
    });

    it('drops a pending B only when B itself closes', async () => {
        const f = makeFixture();
        const listener = f.source.listeners[0];
        const a = fakeBridge(45);
        const b = fakeBridge(46);
        listener.started!(UIN, a);
        f.tasks[0].callbacks!.onReady();
        expect(f.manager.getInstance(UIN)).toBe(f.instances[0]);
        listener.closed!(UIN, a, 45);
        listener.started!(UIN, b);
        expect(f.pending(UIN)?.bridge).toBe(b);
        listener.closed!(UIN, a, 45);
        expect(f.pending(UIN)?.bridge).toBe(b);
        listener.closed!(UIN, b, 46);
        expect(f.pending(UIN)).toBeUndefined();
        listener.closed!(UIN, b, 46);
        f.release();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.tasks).toHaveLength(1);
        expect(f.createInstance).toHaveBeenCalledTimes(1);
        expect(f.manager.getInstance(UIN)).toBeNull();
    });

    it('observes a rejected offline callback outside the callback and still disposes B', async () => {
        const f = makeFixture();
        const listener = f.source.listeners[0];
        const a = fakeBridge(47);
        const b = fakeBridge(48);
        listener.started!(UIN, a);
        listener.closed!(UIN, a, 47);
        listener.started!(UIN, b);
        f.tasks[1].callbacks!.onReady();
        await vi.advanceTimersByTimeAsync(0);
        const current = f.instances[0];
        expect(f.manager.getInstance(UIN)).toBe(current);
        expect(current.emitBotStatus).toHaveBeenCalledWith('online');
        const offline = f.defer();
        current.emitBotStatus.mockImplementationOnce(() => offline.promise.then(() => undefined));
        listener.closed!(UIN, a, 47);
        expect(current.emitBotStatus).toHaveBeenCalledTimes(1);
        listener.closed!(UIN, b, 48);
        expect(current.emitBotStatus).toHaveBeenCalledTimes(2);
        expect(current.emitBotStatus).toHaveBeenLastCalledWith('offline');
        expect(current.dispose).not.toHaveBeenCalled();
        const failure = new Error('synthetic offline failure');
        offline.reject(failure);
        await vi.advanceTimersByTimeAsync(0);
        expect(current.dispose).toHaveBeenCalledTimes(1);
        expect(f.tasks[1].cancel).toHaveBeenCalledTimes(1);
        expect(f.manager.getInstance(UIN)).toBeNull();
    });

    it('keeps another UIN and preserves the unbound-source callback fence', async () => {
        const f = makeFixture();
        const old = f.source.listeners[0];
        const replacementSource = new FakeSource();
        const a = fakeBridge(51);
        const b = fakeBridge(52);
        const other = fakeBridge(53);
        f.manager.bind(replacementSource);
        expect(f.source.unsubscribe).toHaveBeenCalledTimes(1);
        const current = replacementSource.listeners[0];
        current.started!(UIN, a);
        current.started!(OTHER, other);
        expect(f.tasks).toHaveLength(2);
        f.tasks[0].callbacks!.onReady();
        f.tasks[1].callbacks!.onReady();
        const otherInstance = f.instances[1];
        expect(f.manager.getInstance(OTHER)).toBe(otherInstance);
        current.closed!(UIN, a, 51);
        current.started!(UIN, b);
        expect(f.pending(UIN)?.bridge).toBe(b);
        old.closed!(UIN, a, 51);
        old.closed!(OTHER, other, 53);
        old.started!('stale', a);
        expect(f.pending(UIN)?.bridge).toBe(b);
        expect(f.tasks).toHaveLength(2);
        expect(f.tasks[1].cancel).not.toHaveBeenCalled();
        expect(f.manager.getInstance(OTHER)).toBe(otherInstance);
        expect(otherInstance.quiesce).not.toHaveBeenCalled();
        expect(otherInstance.dispose).not.toHaveBeenCalled();
        f.release();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.tasks).toHaveLength(3);
        f.tasks[2].callbacks!.onReady();
        expect(f.createInstance).toHaveBeenCalledTimes(3);
        expect(f.createInstance).toHaveBeenLastCalledWith(
            UIN,
            b,
            expect.anything(),
            expect.anything(),
        );
        current.closed!(UIN, a, 51);
        expect(f.manager.getInstance(UIN)).toBe(f.instances[2]);
        expect(f.manager.getInstance(OTHER)).toBe(otherInstance);
        expect(f.tasks[1].cancel).not.toHaveBeenCalled();
        expect(f.tasks[2].cancel).not.toHaveBeenCalled();
        expect(otherInstance.dispose).not.toHaveBeenCalled();
    });
});
