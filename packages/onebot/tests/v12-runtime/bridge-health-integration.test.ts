import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { Bridge } from '../../../core/src/bridge/bridge';
import { BridgeManager } from '../../../core/src/bridge/manager';
import { OneBotInstance } from '../../src/instance';
import { OneBotManager } from '../../src/manager';
import type { V12TransportOptions } from '../../src/v12-network';
import type { V12Runtime } from '../../src/v12-runtime/runtime';

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

type StatusFrame = {
    detail_type: string;
    status: {
        good: boolean;
        bots: { self: { platform: string; user_id: string }; online: boolean }[];
    };
};

function sender() {
    return {
        sendPacket: vi.fn(async () => ({
            success: false,
            gotResponse: false,
            errorCode: -1,
            errorMessage: '',
            responseData: Buffer.alloc(0),
        })),
    };
}

async function account(uin: string, peer: Bridge) {
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
        quiesce: () => {
            Object.assign(instance, { disposeRequested: true, v12Online: false });
            runtime.quiesce();
        },
        dispose: async () => {
            runtime.quiesce();
            await runtime.close();
            return { closed: true, errors: [] };
        },
    });
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
    return { instance, runtime, options, dispatch };
}

function connect(options: V12TransportOptions) {
    // Simulate the transport's connect-before-subscribe contract; no WS is opened.
    const frames: unknown[] = [options.getConnectEvent()];
    const release = options.subscribe((frame) => frames.push(frame));
    return { frames, release };
}

function statuses(frames: unknown[]) {
    return frames.slice(1).map((frame) => (frame as StatusFrame).status);
}

afterEach(() => {
    captured.transports.length = 0;
    vi.restoreAllMocks();
});

describe('BridgeManager to OneBot v12 health integration (no I/O)', () => {
    it('routes account aggregate health to current status and preserves offline lifecycle', async () => {
        vi.spyOn(IdentityService, 'openForUin').mockImplementation((uin) =>
            IdentityService.memory(uin),
        );
        const warmup = vi
            .spyOn(
                Bridge.prototype as unknown as {
                    runRosterWarmup(): Promise<{ friendsLoaded: boolean; groupsLoaded: boolean }>;
                },
                'runRosterWarmup',
            )
            .mockResolvedValue({ friendsLoaded: false, groupsLoaded: false });
        const core = new BridgeManager();
        const manager = new OneBotManager();
        const s1 = sender();
        const s2 = sender();
        const s3 = sender();
        core.onHookLogin(101, '10001', s1);
        core.onHookLogin(201, '10002', s3);
        const aBridge = core.getBridge('10001')!;
        const bBridge = core.getBridge('10002')!;
        const a = await account('10001', aBridge);
        const b = await account('10002', bBridge);
        const instances = (manager as unknown as { instances: Map<string, OneBotInstance> })
            .instances;
        instances.set('10001', a.instance);
        instances.set('10002', b.instance);
        manager.bind(core);
        await a.instance.emitBotStatus('online');
        await b.instance.emitBotStatus('online');
        a.dispatch.mockClear();
        b.dispatch.mockClear();
        const ca = connect(a.options);
        const cb = connect(b.options);

        try {
            expect((ca.frames[0] as { detail_type: string }).detail_type).toBe('connect');
            expect(statuses(ca.frames)).toEqual([
                {
                    good: true,
                    bots: [{ self: { platform: 'qq', user_id: '10001' }, online: true }],
                },
            ]);
            expect(statuses(cb.frames)).toEqual([
                {
                    good: true,
                    bots: [{ self: { platform: 'qq', user_id: '10002' }, online: true }],
                },
            ]);
            core.onPidReceiveHealthChanged(101, false);
            expect(statuses(ca.frames).map((value) => value.good)).toEqual([true, false]);
            expect(statuses(cb.frames).map((value) => value.good)).toEqual([true]);
            expect((await a.options.handle({ action: 'get_status', params: {} })).data).toEqual(
                statuses(ca.frames).at(-1),
            );
            core.onPidReceiveHealthChanged(101, true);
            expect(statuses(ca.frames).map((value) => value.good)).toEqual([true, false, true]);
            core.onHookLogin(102, '10001', s2);
            const before = ca.frames.length;
            core.onPidReceiveHealthChanged(101, false);
            expect(ca.frames).toHaveLength(before);
            core.onPidReceiveHealthChanged(102, false);
            expect(statuses(ca.frames).at(-1)).toMatchObject({
                good: false,
                bots: [{ online: true }],
            });
            expect(ca.frames).toHaveLength(before + 1);
            core.onPidReceiveHealthChanged(101, true);
            expect(statuses(ca.frames).at(-1)).toMatchObject({
                good: true,
                bots: [{ online: true }],
            });
            core.onPidReceiveHealthChanged(201, false);
            expect(statuses(cb.frames).at(-1)).toMatchObject({
                good: false,
                bots: [{ online: true }],
            });
            expect((await b.options.handle({ action: 'get_status', params: {} })).data).toEqual(
                statuses(cb.frames).at(-1),
            );
            expect(a.dispatch).not.toHaveBeenCalled();
            expect(b.dispatch).not.toHaveBeenCalled();
            core.onPidDisconnected(101);
            expect(statuses(ca.frames).at(-1)).toMatchObject({
                good: false,
                bots: [{ online: true }],
            });
            const beforeFinal = ca.frames.length;
            core.onPidDisconnected(102);
            expect(ca.frames).toHaveLength(beforeFinal + 1);
            expect(statuses(ca.frames).at(-1)).toMatchObject({
                good: false,
                bots: [{ online: false }],
            });
            expect(a.dispatch).toHaveBeenCalledOnce();
            expect(a.dispatch).toHaveBeenCalledWith(
                expect.objectContaining({
                    post_type: 'notice',
                    notice_type: 'bot_status',
                    sub_type: 'offline',
                }),
            );
            expect(b.dispatch).not.toHaveBeenCalled();
            expect(manager.getInstance('10001')).toBeNull();
            expect(core.getBridge('10001')).toBeNull();
            expect(warmup).toHaveBeenCalledTimes(2);
            expect(s1.sendPacket).not.toHaveBeenCalled();
            expect(s2.sendPacket).not.toHaveBeenCalled();
            expect(s3.sendPacket).not.toHaveBeenCalled();
        } finally {
            ca.release();
            cb.release();
            await manager.dispose();
            await core.dispose();
        }
    });
});
