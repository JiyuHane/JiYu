import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentRequestId, runWithRequestId, subscribeLogs } from '@snowluma/common/logger';
import type {
    BridgeInterface,
    BridgeSessionListener,
    BridgeSessionSource,
} from '@snowluma/core/bridge-interface';
import { OneBotInstance } from '../../src/instance';
import { OneBotManager, type DatabaseMigrationCallbacks } from '../../src/manager';
import type { V12TransportOptions } from '../../src/v12-network';
import type { V12Runtime } from '../../src/v12-runtime/runtime';

vi.mock('../../src/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/config')>();
    return { ...actual, loadOneBotConfig: () => actual.makeDefaultOneBotConfig() };
});
vi.mock('../../src/global-config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/global-config')>();
    return { ...actual, loadGlobalSettings: () => actual.defaultGlobalSettings() };
});
const captured = vi.hoisted(() => ({ transports: [] as V12TransportOptions[] }));
vi.mock('../../src/v12-network', () => ({
    V12Transport: class {
        constructor(options: V12TransportOptions) {
            captured.transports.push(options);
        }
        async open() {}
        async close() {}
        quiesce() {}
        forceClose() {}
    },
}));

type HealthListener = BridgeSessionListener & {
    receiveHealthChanged?: (uin: string, bridge: BridgeInterface) => void;
};
type StatusEvent = {
    detail_type: string;
    status: { good: boolean; bots: { self: { user_id: string }; online: boolean }[] };
};

function source() {
    let listener!: HealthListener;

    let onUnsubscribe = () => {};

    const value: BridgeSessionSource = {
        subscribeSessions: (next) => {
            listener = next;
            return () => onUnsubscribe();
        },
    };
    return {
        value,
        get listener() {
            return listener;
        },
        duringUnsubscribe: (callback: () => void) => {
            onUnsubscribe = callback;
        },
    };
}

function bridge() {
    return {
        receiveHealthy: true,
        activePid: null,
        identity: { nickname: 'fixture' },
        whenRosterWarmupSettled: async () => ({ friendsLoaded: false, groupsLoaded: false }),
    };
}

async function account(uin: string, peer: ReturnType<typeof bridge>) {
    const instance = Object.create(OneBotInstance.prototype) as OneBotInstance;
    const dispatch = vi.fn(async () => undefined);
    Object.assign(instance, {
        uin,
        bridge: peer,
        v12Online: false,
        disposeRequested: false,
        v12Adapter: null,
        dispatchEvent: dispatch,
        trackAction: <T>(_label: string, start: () => Promise<T>) => start(),
        waitUntilNetworkReady: async () => ({ applied: true, statuses: [], errors: [] }),
        quiesce: () => {
            Object.assign(instance, { disposeRequested: true, v12Online: false });
            runtime.quiesce();
        },
        dispose: async () => {
            runtime.quiesce();
            await runtime.close();
            return { closed: true, errors: [] };
        },
        startLoginHistorySync: () => {},
    });
    const internal = instance as unknown as {
        createNetworkAdapter(desired: unknown, ctx: unknown): V12Runtime;
        v12Online: boolean;
        v12Adapter: V12Runtime | null;
        disposeRequested: boolean;
    };
    const runtime = Reflect.apply(Reflect.get(instance, 'createNetworkAdapter'), instance, [
        {
            kind: 'v12Server',
            name: 'OneBot v12',
            config: {
                name: 'OneBot v12',
                enabled: true,
                host: '127.0.0.1',
                port: 1,
                allowNonLoopback: false,
            },
        },
        { uin, api: {}, buildLifecycleEvent: () => ({}), buildHeartbeatEvent: () => ({}) },
    ]) as V12Runtime;
    await runtime.open();
    const options = captured.transports.at(-1)!;
    return { instance, internal, runtime, options, peer, dispatch };
}

function connect(options: V12TransportOptions) {
    const events: unknown[] = [options.getConnectEvent()];
    const release = options.subscribe((event) => events.push(event));
    return { events, release };
}

function status(events: unknown[]) {
    return events.slice(1).map((event) => (event as StatusEvent).status);
}

function slots(manager: OneBotManager) {
    return (manager as unknown as { instances: Map<string, OneBotInstance> }).instances;
}

function caught(action: () => void): unknown {
    try {
        action();
    } catch (error) {
        return error;
    }

    throw new Error('expected failure');
}

afterEach(() => {
    captured.transports.length = 0;
});

describe('OneBot v12 receive health notification (in-memory transport)', () => {
    it('reads current aggregate health for status events and get_status without v11 notice', async () => {
        const f = await account('10001', bridge());
        const manager = new OneBotManager();
        const session = source();
        slots(manager).set('10001', f.instance);
        manager.bind(session.value);
        f.internal.v12Online = true;
        const client = connect(f.options);
        expect((client.events[0] as { detail_type: string }).detail_type).toBe('connect');
        expect(status(client.events)).toEqual([
            { good: true, bots: [{ self: { platform: 'qq', user_id: '10001' }, online: true }] },
        ]);
        f.peer.receiveHealthy = false;
        session.listener.receiveHealthChanged!('10001', f.peer as unknown as BridgeInterface);
        const response = await f.options.handle({ action: 'get_status', params: {} });
        expect(response.data).toEqual(status(client.events).at(-1));
        f.peer.receiveHealthy = true;
        session.listener.receiveHealthChanged!('10001', f.peer as unknown as BridgeInterface);
        session.listener.receiveHealthChanged!('10001', f.peer as unknown as BridgeInterface);
        expect(status(client.events).map((s) => [s.good, s.bots[0].online])).toEqual([
            [true, true],
            [false, true],
            [true, true],
            [true, true],
        ]);
        expect(f.dispatch).not.toHaveBeenCalled();
        client.release();
        await manager.dispose();
    });

    it('isolates account and bridge identities and retires old sources before unsubscribe', async () => {
        const a = await account('10001', bridge());
        const b = await account('10002', bridge());
        const manager = new OneBotManager();
        const first = source();
        const second = source();
        slots(manager).set('10001', a.instance);
        slots(manager).set('10002', b.instance);
        manager.bind(first.value);
        a.internal.v12Online = true;
        b.internal.v12Online = true;
        const ca = connect(a.options);
        const cb = connect(b.options);
        a.peer.receiveHealthy = false;
        first.listener.receiveHealthChanged!('10001', b.peer as unknown as BridgeInterface);
        first.listener.receiveHealthChanged!('missing', a.peer as unknown as BridgeInterface);
        expect(ca.events).toHaveLength(2);
        first.duringUnsubscribe(() =>
            first.listener.receiveHealthChanged!('10001', a.peer as unknown as BridgeInterface),
        );
        manager.bind(second.value);
        first.listener.receiveHealthChanged!('10001', a.peer as unknown as BridgeInterface);
        expect(ca.events).toHaveLength(2);
        second.listener.receiveHealthChanged!('10001', a.peer as unknown as BridgeInterface);
        expect(status(ca.events).map((s) => s.good)).toEqual([true, false]);
        expect(status(cb.events).map((s) => s.good)).toEqual([true]);
        expect(a.dispatch).not.toHaveBeenCalled();
        expect(b.dispatch).not.toHaveBeenCalled();
        ca.release();
        cb.release();
        await manager.dispose();
        second.listener.receiveHealthChanged!('10001', a.peer as unknown as BridgeInterface);
        expect(ca.events).toHaveLength(3);
    });

    it('invalidates the old health callback when binding the same source again', async () => {
        const f = await account('10001', bridge());
        const manager = new OneBotManager();
        const session = source();
        slots(manager).set('10001', f.instance);
        manager.bind(session.value);
        const old = session.listener;
        f.internal.v12Online = true;
        const client = connect(f.options);
        f.peer.receiveHealthy = false;
        session.duringUnsubscribe(() =>
            old.receiveHealthChanged!('10001', f.peer as unknown as BridgeInterface),
        );
        manager.bind(session.value);
        old.receiveHealthChanged!('10001', f.peer as unknown as BridgeInterface);
        expect(client.events).toHaveLength(2);
        session.listener.receiveHealthChanged!('10001', f.peer as unknown as BridgeInterface);
        expect(status(client.events).map((s) => s.good)).toEqual([true, false]);
        client.release();
        await manager.dispose();
    });

    // Synthetic sources exercise the interface under reentry. The current real
    // BridgeManager subscribes/unsubscribes with Set operations; these fakes do
    // not establish that the real source reenters in production.
    it('cleans the superseded subscription when subscribe synchronously rebinds', async () => {
        const manager = new OneBotManager();
        const offA = vi.fn();
        const offB = vi.fn();
        const b: BridgeSessionSource = { subscribeSessions: () => offB };
        const a: BridgeSessionSource = {
            subscribeSessions: () => {
                manager.bind(b);
                return offA;
            },
        };
        manager.bind(a);
        expect(offA).toHaveBeenCalledOnce();
        expect(offB).not.toHaveBeenCalled();
        await manager.dispose();
        expect(offB).toHaveBeenCalledOnce();
    });

    it('detaches the old handle before calling an unsubscribe that rebinds', async () => {
        const manager = new OneBotManager();
        const offB = vi.fn();
        const b: BridgeSessionSource = { subscribeSessions: () => offB };
        const offOld = vi.fn(() => manager.bind(b));
        const laterSubscribe = vi.fn(() => vi.fn());
        manager.bind({ subscribeSessions: () => offOld });
        manager.bind({ subscribeSessions: laterSubscribe });
        expect(offOld).toHaveBeenCalledOnce();
        expect(laterSubscribe).not.toHaveBeenCalled();
        await manager.dispose();
        expect(offB).toHaveBeenCalledOnce();
    });

    it('cleans a subscribe that synchronously disposes the manager', async () => {
        const manager = new OneBotManager();
        const off = vi.fn();
        let disposal!: Promise<void>;
        let listener!: HealthListener;
        manager.bind({
            subscribeSessions: (value) => {
                listener = value;
                disposal = manager.dispose();
                return off;
            },
        });
        expect(off).toHaveBeenCalledOnce();
        await disposal;
        expect(() =>
            listener.receiveHealthChanged!('10001', bridge() as unknown as BridgeInterface),
        ).not.toThrow();
    });

    it('invalidates an unreturned callback when subscribe throws', async () => {
        const manager = new OneBotManager();
        const failure = new Error('subscribe fixture');
        let listener!: HealthListener;
        const receive = vi.fn();
        slots(manager).set('10001', { receiveHealthChanged: receive } as unknown as OneBotInstance);
        expect(
            caught(() =>
                manager.bind({
                    subscribeSessions: (value) => {
                        listener = value;
                        throw failure;
                    },
                }),
            ),
        ).toBe(failure);
        listener.receiveHealthChanged!('10001', bridge() as unknown as BridgeInterface);
        expect(receive).not.toHaveBeenCalled();
        slots(manager).clear();
        await manager.dispose();
    });

    it('retains a throwing old handle for a later bind retry', async () => {
        const manager = new OneBotManager();
        const failure = new Error('unsubscribe fixture');
        const offOld = vi.fn().mockImplementationOnce(() => {
            throw failure;
        });
        const offNext = vi.fn();
        manager.bind({ subscribeSessions: () => offOld });
        const next: BridgeSessionSource = { subscribeSessions: () => offNext };
        expect(caught(() => manager.bind(next))).toBe(failure);
        expect(offOld).toHaveBeenCalledTimes(1);
        manager.bind(next);
        expect(offOld).toHaveBeenCalledTimes(2);
        await manager.dispose();
        expect(offNext).toHaveBeenCalledOnce();
    });

    it('preserves a reentrant newer handle when the old unsubscribe throws', async () => {
        const manager = new OneBotManager();
        const failure = new Error('old unsubscribe fixture');
        const offB = vi.fn();
        const b: BridgeSessionSource = { subscribeSessions: () => offB };
        const offOld = vi.fn(() => {
            manager.bind(b);
            throw failure;
        });
        const subscribeA = vi.fn(() => vi.fn());
        manager.bind({ subscribeSessions: () => offOld });
        expect(caught(() => manager.bind({ subscribeSessions: subscribeA }))).toBe(failure);
        expect(offOld).toHaveBeenCalledOnce();
        expect(subscribeA).not.toHaveBeenCalled();
        await manager.dispose();
        expect(offB).toHaveBeenCalledOnce();
    });

    it('propagates superseded unsubscribe failure without replacing the new handle', async () => {
        const manager = new OneBotManager();
        const failure = new Error('superseded unsubscribe fixture');
        const offB = vi.fn();
        const offA = vi.fn(() => {
            throw failure;
        });
        const b: BridgeSessionSource = { subscribeSessions: () => offB };
        expect(
            caught(() =>
                manager.bind({
                    subscribeSessions: () => {
                        manager.bind(b);
                        return offA;
                    },
                }),
            ),
        ).toBe(failure);
        expect(offA).toHaveBeenCalledOnce();
        expect(offB).not.toHaveBeenCalled();
        await manager.dispose();
        expect(offB).toHaveBeenCalledOnce();
    });

    it('does not publish before online, after dispose request, or without a v12 adapter', async () => {
        const f = await account('10001', bridge());
        const manager = new OneBotManager();
        const session = source();
        manager.bind(session.value);
        slots(manager).set('10001', f.instance);
        const client = connect(f.options);
        f.peer.receiveHealthy = false;
        session.listener.receiveHealthChanged!('10001', f.peer as unknown as BridgeInterface);
        expect(client.events).toHaveLength(2);
        f.internal.v12Online = true;
        session.listener.receiveHealthChanged!('10001', f.peer as unknown as BridgeInterface);
        expect(status(client.events).at(-1)).toMatchObject({
            good: false,
            bots: [{ online: true }],
        });
        f.internal.disposeRequested = true;
        session.listener.receiveHealthChanged!('10001', f.peer as unknown as BridgeInterface);
        f.internal.disposeRequested = false;
        f.internal.v12Adapter = null;
        session.listener.receiveHealthChanged!('10001', f.peer as unknown as BridgeInterface);
        expect(client.events).toHaveLength(3);
        client.release();
        await manager.dispose();
    });

    it('uses current health after migration preparation and network startup', async () => {
        const f = await account('10001', bridge());
        let callbacks!: DatabaseMigrationCallbacks;
        const manager = new OneBotManager({
            createDatabaseMigrationTask: () => ({
                start: (value) => {
                    callbacks = value;
                },
                beginMigration: () => {},
                cancel: () => {},
            }),
            createInstance: () => f.instance,
        });
        const session = source();
        manager.bind(session.value);
        session.listener.started!('10001', f.peer as unknown as BridgeInterface);
        f.peer.receiveHealthy = false;
        session.listener.receiveHealthChanged!('10001', f.peer as unknown as BridgeInterface);
        expect(manager.getInstance('10001')).toBeNull();
        callbacks.onReady();
        await vi.waitFor(() => expect(f.internal.v12Online).toBe(true));
        const client = connect(f.options);
        expect(status(client.events)).toMatchObject([{ good: false, bots: [{ online: true }] }]);
        expect(f.dispatch).toHaveBeenCalledTimes(1);
        client.release();
        await manager.dispose();
    });

    it('samples current health across a simulated adapter replacement through reloadConfig', async () => {
        const f = await account('10001', bridge());
        const manager = new OneBotManager();
        const session = source();
        manager.bind(session.value);
        slots(manager).set('10001', f.instance);
        f.internal.v12Online = true;
        const previous = connect(f.options);
        let nextRuntime!: V12Runtime;
        Object.assign(f.instance, {
            ctx: { config: {} },
            lifecycleTail: Promise.resolve(),
            networkManager: {
                compileDesiredPlan: () => {},
                reconcile: async () => {
                    await f.runtime.close();
                    f.peer.receiveHealthy = false;
                    session.listener.receiveHealthChanged!(
                        '10001',
                        f.peer as unknown as BridgeInterface,
                    );
                    nextRuntime = Reflect.apply(
                        Reflect.get(f.instance, 'createNetworkAdapter'),
                        f.instance,
                        [
                            {
                                kind: 'v12Server',
                                name: 'OneBot v12',
                                config: {
                                    name: 'OneBot v12',
                                    enabled: true,
                                    host: '127.0.0.1',
                                    port: 2,
                                    allowNonLoopback: false,
                                },
                            },
                            {
                                uin: '10001',
                                api: {},
                                buildLifecycleEvent: () => ({}),
                                buildHeartbeatEvent: () => ({}),
                            },
                        ],
                    ) as V12Runtime;
                    await nextRuntime.open();
                    return { applied: true, statuses: [], errors: [] };
                },
            },
        });
        await f.instance.reloadConfig({} as never);
        const next = connect(captured.transports.at(-1)!);
        expect(status(previous.events).map((s) => s.good)).toEqual([true]);
        expect(status(next.events)).toMatchObject([{ good: false, bots: [{ online: true }] }]);
        f.peer.receiveHealthy = true;
        session.listener.receiveHealthChanged!('10001', f.peer as unknown as BridgeInterface);
        expect(status(next.events).map((s) => s.good)).toEqual([false, true]);
        expect(f.dispatch).not.toHaveBeenCalled();
        previous.release();
        next.release();
        await nextRuntime.close();
        await manager.dispose();
    });

    it('isolates request context from health notification delivery', async () => {
        const f = await account('10001', bridge());
        const manager = new OneBotManager();
        const session = source();
        manager.bind(session.value);
        slots(manager).set('10001', f.instance);
        f.internal.v12Online = true;
        const contexts: Array<number | undefined> = [];
        const release = f.options.subscribe(() => contexts.push(currentRequestId()));
        f.peer.receiveHealthy = false;
        runWithRequestId(5201, () =>
            session.listener.receiveHealthChanged!('10001', f.peer as unknown as BridgeInterface),
        );
        expect(contexts).toEqual([undefined, undefined]);
        release();
        await manager.dispose();
    });

    it('ignores an old bridge after a same-account instance is replaced', async () => {
        const old = await account('10001', bridge());
        const replacement = await account('10001', bridge());
        const manager = new OneBotManager();
        const session = source();
        manager.bind(session.value);
        slots(manager).set('10001', old.instance);
        old.internal.v12Online = true;
        const oldClient = connect(old.options);
        session.listener.closed!('10001', old.peer as unknown as BridgeInterface, 1);
        expect(manager.getInstance('10001')).toBeNull();
        await vi.waitFor(() => expect(old.dispatch).toHaveBeenCalledOnce());
        slots(manager).set('10001', replacement.instance);
        replacement.internal.v12Online = true;
        const nextClient = connect(replacement.options);
        replacement.peer.receiveHealthy = false;
        session.listener.receiveHealthChanged!('10001', old.peer as unknown as BridgeInterface);
        expect(nextClient.events).toHaveLength(2);
        session.listener.receiveHealthChanged!(
            '10001',
            replacement.peer as unknown as BridgeInterface,
        );
        expect(status(nextClient.events).map((s) => s.good)).toEqual([true, false]);
        expect(replacement.dispatch).not.toHaveBeenCalled();
        oldClient.release();
        nextClient.release();
        await manager.dispose();
    });

    it('isolates an instance callback exception from the session source and logs no detail', async () => {
        const f = await account('10001', bridge());
        const manager = new OneBotManager();
        const session = source();
        manager.bind(session.value);
        slots(manager).set('10001', f.instance);
        const logs: string[] = [];
        const stop = subscribeLogs((entry) => logs.push(entry.message));
        const failure = vi.spyOn(f.instance, 'receiveHealthChanged').mockImplementation(() => {
            throw new Error('secret input');
        });
        expect(() =>
            session.listener.receiveHealthChanged!('10001', f.peer as unknown as BridgeInterface),
        ).not.toThrow();
        expect(logs.join(' ')).toContain('OneBot v12 receive health notification failed');
        expect(logs.join(' ')).not.toContain('secret input');
        failure.mockRestore();
        stop();
        await manager.dispose();
    });
});
