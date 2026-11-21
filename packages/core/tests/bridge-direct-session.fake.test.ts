import { subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import type { PacketSender, SendPacketResult } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { IdentityService } from '@snowluma/protocol/identity-service';
import type { UserProfileInfo } from '@snowluma/protocol/qq-info';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Bridge } from '../src/bridge/bridge';
import { BridgeManager } from '../src/bridge/manager';

// Synthetic, in-memory fixtures only: no QQ process, account, socket or database.
// A fake sender records calls; nothing here shows that a real login works.
const A = '3000000001';
const B = '3000000002';
const NO_SENDER = {
    success: false,
    gotResponse: false,
    errorCode: -1,
    errorMessage: 'no packet sender attached',
};

function makeSender(tag: string) {
    const result: SendPacketResult = {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: tag,
        responseData: Buffer.alloc(0),
    };
    const sendPacket = vi.fn<PacketSender['sendPacket']>(async () => result);
    return { client: { sendPacket } satisfies PacketSender, sendPacket, result };
}

function testSends(sendPacket: ReturnType<typeof makeSender>['sendPacket']): unknown[][] {
    return sendPacket.mock.calls.filter(([cmd]) => cmd.startsWith('Test.'));
}

function profile(uin: string): UserProfileInfo {
    return {
        uin: Number(uin),
        uid: `u_${uin}`,
        nickname: 'synthetic',
        remark: '',
        qid: '',
        sex: 'unknown',
        age: 0,
        sign: '',
        avatar: '',
        level: 0,
        qidianMasterFlag: 0,
        qidianCrewFlag: 0,
        qidianCrewFlag2: 0,
    };
}

/** Keeps the roster warm-up off the fake sender so send assertions stay exact. */
function stubRoster(bridge: Bridge) {
    const friends = vi.spyOn(bridge.apis.contacts, 'fetchFriendList').mockResolvedValue([]);
    const groups = vi.spyOn(bridge.apis.contacts, 'fetchGroupList').mockResolvedValue([]);
    vi.spyOn(bridge.apis.contacts, 'fetchUserProfile').mockResolvedValue(
        profile(bridge.identity.uin),
    );
    return { friends, groups };
}

function packet(pid: number, uin: string): PacketInfo {
    return {
        pid,
        uin,
        serviceCmd: 'Test.Unhandled',
        seqId: 1,
        retCode: 0,
        fromClient: false,
        body: Buffer.alloc(0),
    };
}

describe('Bridge direct sender (synthetic memory only)', () => {
    it('sends through the direct sender without a PID and stops when it is detached', async () => {
        const bridge = new Bridge(IdentityService.memory(A));
        stubRoster(bridge);
        const sender = makeSender('direct');

        expect(bridge.empty).toBe(true);
        expect(bridge.receiveHealthy).toBe(false);

        bridge.attachDirectSender(sender.client);

        expect(bridge.empty).toBe(false);
        expect(bridge.activePid).toBeNull();
        expect(bridge.receiveHealthy).toBe(true);
        await bridge.whenRosterWarmupSettled();
        expect(sender.sendPacket).not.toHaveBeenCalled();

        const body = new Uint8Array([1, 2, 3]);
        await expect(bridge.sendRawPacket('Test.Direct', body, 4321)).resolves.toBe(sender.result);
        expect(sender.sendPacket).toHaveBeenCalledOnce();
        expect(sender.sendPacket).toHaveBeenCalledWith('Test.Direct', Buffer.from(body), 4321);

        bridge.detachDirectSender();
        bridge.detachDirectSender();

        expect(bridge.empty).toBe(true);
        expect(bridge.receiveHealthy).toBe(false);
        await expect(bridge.sendRawPacket('Test.Detached', body)).resolves.toMatchObject(NO_SENDER);
        expect(sender.sendPacket).toHaveBeenCalledOnce();
        await bridge.dispose();
    });

    it('allows exactly one kind of owner per Bridge', async () => {
        const direct = new Bridge(IdentityService.memory(A));
        stubRoster(direct);
        direct.attachDirectSender(makeSender('first').client);

        expect(() => direct.attachDirectSender(makeSender('second').client)).toThrow(
            'Direct sender already attached',
        );
        expect(() => direct.bindPid(101, makeSender('hook').client)).toThrow(
            /owned by a direct session and cannot bind PID=101/,
        );
        expect(direct.hasPid(101)).toBe(false);
        expect(direct.activePid).toBeNull();

        const hooked = new Bridge(IdentityService.memory(B));
        stubRoster(hooked);
        hooked.bindPid(202, makeSender('hook').client);

        expect(() => hooked.attachDirectSender(makeSender('direct').client)).toThrow(
            /bound to a QQ process and cannot attach a direct sender/,
        );
        expect(hooked.activePid).toBe(202);

        await Promise.all([direct.dispose(), hooked.dispose()]);
    });

    it('tracks direct receive health only while a sender is attached', async () => {
        const bridge = new Bridge(IdentityService.memory(A));
        stubRoster(bridge);

        expect(() => bridge.setDirectReceiveHealthy(true)).toThrow(
            'Bridge receive-health invariant violated: no direct sender is attached',
        );
        expect(bridge.receiveHealthy).toBe(false);

        bridge.attachDirectSender(makeSender('first').client);
        bridge.setDirectReceiveHealthy(false);
        expect(bridge.receiveHealthy).toBe(false);
        bridge.setDirectReceiveHealthy(true);
        expect(bridge.receiveHealthy).toBe(true);
        bridge.setDirectReceiveHealthy(false);

        bridge.detachDirectSender();
        expect(() => bridge.setDirectReceiveHealthy(true)).toThrow(/no direct sender is attached/);

        // A new sender starts healthy, exactly like a new PID login.
        bridge.attachDirectSender(makeSender('second').client);
        expect(bridge.receiveHealthy).toBe(true);
        await bridge.dispose();
    });

    it('detaches the direct sender on dispose and refuses a later attach', async () => {
        const bridge = new Bridge(IdentityService.memory(A));
        stubRoster(bridge);
        const sender = makeSender('direct');
        bridge.attachDirectSender(sender.client);

        const disposal = bridge.dispose();

        expect(bridge.empty).toBe(true);
        expect(bridge.receiveHealthy).toBe(false);
        await disposal;
        await expect(
            bridge.sendRawPacket('Test.Disposed', new Uint8Array([9])),
        ).resolves.toMatchObject(NO_SENDER);
        expect(testSends(sender.sendPacket)).toHaveLength(0);
        expect(() => bridge.attachDirectSender(sender.client)).toThrow('Bridge is disposed');
        expect(() => bridge.setDirectReceiveHealthy(true)).toThrow(/no direct sender is attached/);
    });

    it('starts the roster warm-up once and settles its waiters', async () => {
        const bridge = new Bridge(IdentityService.memory(A));
        const roster = stubRoster(bridge);
        const beforeAttach = bridge.whenRosterWarmupSettled();

        expect(roster.friends).not.toHaveBeenCalled();
        bridge.attachDirectSender(makeSender('first').client);

        const expected = { friendsLoaded: true, groupsLoaded: true };
        await expect(beforeAttach).resolves.toEqual(expected);
        await expect(bridge.whenRosterWarmupSettled()).resolves.toEqual(expected);
        expect(roster.friends).toHaveBeenCalledOnce();
        expect(roster.groups).toHaveBeenCalledOnce();
        expect(bridge.identity.nickname).toBe('synthetic');

        bridge.detachDirectSender();
        bridge.attachDirectSender(makeSender('second').client);
        await bridge.whenRosterWarmupSettled();
        expect(roster.friends).toHaveBeenCalledOnce();
        await bridge.dispose();
    });
});

describe('BridgeManager direct sessions (synthetic memory only)', () => {
    let manager: BridgeManager;
    let warnings: LogEntry[];
    let unsubscribeLogs: () => void;

    beforeEach(() => {
        vi.spyOn(IdentityService, 'openForUin').mockImplementation((uin) =>
            IdentityService.memory(uin),
        );
        manager = new BridgeManager();
        warnings = [];
        unsubscribeLogs = subscribeLogs((entry) => {
            if (entry.level === 'warn' && entry.scope === 'Bridge') {
                warnings.push(entry);
            }
        });
    });

    afterEach(async () => {
        unsubscribeLogs();
        await manager.dispose();
        vi.restoreAllMocks();
    });

    function open(uin: string) {
        const handle = manager.openDirectSession(uin);
        stubRoster(handle.bridge);
        return handle;
    }

    function observe() {
        const lifecycle: string[] = [];
        const health: string[] = [];
        manager.subscribeSessions({
            started: (uin) => lifecycle.push(`started:${uin}`),
            closed: (uin, _bridge, pid) => lifecycle.push(`closed:${uin}:${String(pid)}`),
            receiveHealthChanged: (uin, bridge) =>
                health.push(`${uin}:${String(bridge.receiveHealthy)}`),
        });
        return { lifecycle, health };
    }

    it('announces nothing until activation, then starts once with the sender attached', async () => {
        const { lifecycle } = observe();
        const sender = makeSender('direct');
        const seen: unknown[] = [];
        let sentFromObserver: Promise<SendPacketResult> | undefined;
        manager.subscribeSessions({
            started: (uin, bridge) => {
                // Listeners see the public interface; sending below verifies sender readiness.
                seen.push([uin, bridge, bridge.activePid, bridge.receiveHealthy]);
                sentFromObserver = bridge.sendRawPacket('Test.FromStarted', new Uint8Array([7]));
            },
        });

        const handle = open(A);

        expect(manager.getBridge(A)).toBe(handle.bridge);
        expect(handle.bridge.empty).toBe(true);
        expect(lifecycle).toEqual([]);

        handle.activate(sender.client);

        expect(lifecycle).toEqual([`started:${A}`]);
        expect(seen).toEqual([[A, handle.bridge, null, true]]);
        await expect(sentFromObserver).resolves.toBe(sender.result);
        expect(testSends(sender.sendPacket)).toHaveLength(1);

        expect(() => handle.activate(makeSender('again').client)).toThrow(
            `Direct session is already activated: UIN=${A}`,
        );
        expect(lifecycle).toEqual([`started:${A}`]);
    });

    it('reports receive health with the same de-duplication as a PID session', () => {
        const { health } = observe();
        const handle = open(A);

        expect(() => handle.setReceiveHealthy(false)).toThrow(/inactive direct session/);
        expect(health).toEqual([]);

        handle.activate(makeSender('direct').client);
        // Same first edge a hook login reports for a new session.
        expect(health).toEqual([`${A}:true`]);

        handle.setReceiveHealthy(true);
        expect(health).toEqual([`${A}:true`]);
        handle.setReceiveHealthy(false);
        handle.setReceiveHealthy(false);
        expect(health).toEqual([`${A}:true`, `${A}:false`]);
        expect(handle.bridge.receiveHealthy).toBe(false);
        handle.setReceiveHealthy(true);
        expect(health).toEqual([`${A}:true`, `${A}:false`, `${A}:true`]);
    });

    it('closes once with a null PID and tears the Bridge down', async () => {
        const { lifecycle, health } = observe();
        const sender = makeSender('direct');
        const handle = open(A);
        const bridge = handle.bridge;
        const dispose = vi.spyOn(bridge, 'dispose');
        const seen: unknown[] = [];
        manager.subscribeSessions({
            closed: (uin, closing, pid) => {
                seen.push([uin, closing, pid, closing.identity.uin, dispose.mock.calls.length]);
            },
        });
        handle.activate(sender.client);
        health.length = 0;

        const closing = handle.close();

        expect(lifecycle).toEqual([`started:${A}`, `closed:${A}:null`]);
        expect(seen).toEqual([[A, bridge, null, A, 0]]);
        expect(manager.getBridge(A)).toBeNull();
        expect(bridge.empty).toBe(true);
        expect(handle.close()).toBe(closing);
        await closing;

        expect(dispose).toHaveBeenCalled();
        expect(() => bridge.attachDirectSender(sender.client)).toThrow('Bridge is disposed');
        await expect(
            bridge.sendRawPacket('Test.Closed', new Uint8Array([1])),
        ).resolves.toMatchObject(NO_SENDER);
        expect(testSends(sender.sendPacket)).toHaveLength(0);
        expect(() => handle.activate(sender.client)).toThrow(`Direct session is closed: UIN=${A}`);
        expect(() => handle.setReceiveHealthy(false)).toThrow(/inactive direct session/);
        await handle.close();
        expect(lifecycle).toEqual([`started:${A}`, `closed:${A}:null`]);
        expect(health).toEqual([]);

        // The account is free again and gets a new Bridge generation.
        const reopened = open(A);
        expect(reopened.bridge).not.toBe(bridge);
    });

    it('closes a never-activated session without any session event', async () => {
        const { lifecycle, health } = observe();
        const handle = open(A);
        const dispose = vi.spyOn(handle.bridge, 'dispose');

        await handle.close();

        expect(lifecycle).toEqual([]);
        expect(health).toEqual([]);
        expect(dispose).toHaveBeenCalled();
        expect(manager.getBridge(A)).toBeNull();
        expect(() => handle.activate(makeSender('late').client)).toThrow(
            `Direct session is closed: UIN=${A}`,
        );
        expect(lifecycle).toEqual([]);
    });

    it('rejects duplicate, invalid and post-shutdown opens', async () => {
        const handle = open(A);

        expect(() => manager.openDirectSession(A)).toThrow(
            `Bridge session already exists: UIN=${A}`,
        );
        expect(() => manager.openDirectSession('0')).toThrow(/requires a real UIN/);
        expect(manager.getBridge('0')).toBeNull();
        expect(manager.getBridge(A)).toBe(handle.bridge);

        await manager.dispose();
        expect(() => manager.openDirectSession(B)).toThrow('BridgeManager is disposed');
    });

    it('refuses to open a direct session for a hook-owned account', async () => {
        const { lifecycle } = observe();
        const hook = makeSender('hook');
        manager.onHookLogin(101, A, hook.client);
        const bridge = manager.getBridge(A)!;

        expect(() => manager.openDirectSession(A)).toThrow(
            `Bridge session already exists: UIN=${A}`,
        );

        expect(manager.getBridge(A)).toBe(bridge);
        expect(bridge.activePid).toBe(101);
        await bridge.sendRawPacket('Test.StillHook', new Uint8Array([1]));
        expect(testSends(hook.sendPacket)).toHaveLength(1);
        expect(lifecycle).toEqual([`started:${A}`]);
    });

    it('refuses a hook login for a direct-owned account without throwing', async () => {
        const { lifecycle, health } = observe();
        const direct = makeSender('direct');
        const hook = makeSender('hook');
        const handle = open(A);
        const bridge = handle.bridge;
        const onPacket = vi.spyOn(bridge, 'onPacket');

        // Refused in both phases: before the direct login completes, and after.
        expect(() => manager.onHookLogin(101, A, hook.client)).not.toThrow();
        expect(lifecycle).toEqual([]);
        expect(bridge.empty).toBe(true);

        handle.activate(direct.client);
        health.length = 0;
        expect(() => manager.onHookLogin(101, A, hook.client)).not.toThrow();

        expect(warnings.map((entry) => entry.message)).toEqual([
            `hook login refused: UIN=${A} is owned by a direct session; PID=101 stays unbound`,
            `hook login refused: UIN=${A} is owned by a direct session; PID=101 stays unbound`,
        ]);
        expect(manager.getBridge(A)).toBe(bridge);
        expect(bridge.hasPid(101)).toBe(false);
        expect(bridge.activePid).toBeNull();
        expect(lifecycle).toEqual([`started:${A}`]);
        await bridge.sendRawPacket('Test.Owner', new Uint8Array([1]));
        expect(testSends(direct.sendPacket)).toHaveLength(1);
        expect(hook.sendPacket).not.toHaveBeenCalled();

        // The refused process still reports to the manager; none of it reaches the session.
        expect(() => manager.onPidReceiveHealthChanged(101, false)).not.toThrow();
        expect(bridge.receiveHealthy).toBe(true);
        manager.onPacket(packet(101, A));
        expect(onPacket).not.toHaveBeenCalled();
        manager.onPidDisconnected(101);
        expect(lifecycle).toEqual([`started:${A}`]);
        expect(health).toEqual([]);
        expect(warnings).toHaveLength(2);
    });

    it('releases a hook PID from its old account when it reports a direct-owned one', () => {
        const { lifecycle } = observe();
        const hook = makeSender('hook');
        const handle = open(A);
        handle.activate(makeSender('direct').client);
        manager.onHookLogin(101, B, hook.client);
        const old = manager.getBridge(B)!;

        manager.onPacket(packet(101, A));

        expect(lifecycle).toEqual([`started:${A}`, `started:${B}`, `closed:${B}:101`]);
        expect(manager.getBridge(B)).toBeNull();
        expect(old.hasPid(101)).toBe(false);
        expect(handle.bridge.hasPid(101)).toBe(false);
        expect(warnings.map((entry) => entry.message)).toEqual([
            `PID ownership changed: PID=101 UIN=${B} -> UIN=${A} source=packet`,
            `hook packet refused: UIN=${A} is owned by a direct session; PID=101 stays unbound`,
        ]);

        // Further packets of the same refused process are dropped quietly.
        manager.onPacket(packet(101, A));
        expect(warnings).toHaveLength(2);
    });

    it('keeps a refused hook PID unbound until the hook layer logs it in again', async () => {
        const { lifecycle } = observe();
        const hook = makeSender('hook');
        const handle = open(A);
        handle.activate(makeSender('direct').client);
        manager.onHookLogin(101, A, hook.client);
        await handle.close();
        lifecycle.length = 0;

        // The hook layer still believes PID 101 is logged in; no senderless session appears.
        manager.onPacket(packet(101, A));
        expect(() => manager.onPidReceiveHealthChanged(101, false)).not.toThrow();
        expect(manager.getBridge(A)).toBeNull();
        expect(lifecycle).toEqual([]);

        manager.onPidDisconnected(101);
        manager.onHookLogin(101, A, hook.client);

        expect(lifecycle).toEqual([`started:${A}`]);
        expect(manager.getBridge(A)!.activePid).toBe(101);
        manager.onPidDisconnected(101);
        expect(lifecycle).toEqual([`started:${A}`, `closed:${A}:101`]);
    });

    it('keeps two direct accounts isolated', async () => {
        const { lifecycle, health } = observe();
        const senderA = makeSender('a');
        const senderB = makeSender('b');
        const a = open(A);
        const b = open(B);
        a.activate(senderA.client);
        b.activate(senderB.client);
        health.length = 0;

        expect(a.bridge).not.toBe(b.bridge);
        await expect(a.bridge.sendRawPacket('Test.A', new Uint8Array([1]))).resolves.toBe(
            senderA.result,
        );
        await expect(b.bridge.sendRawPacket('Test.B', new Uint8Array([2]))).resolves.toBe(
            senderB.result,
        );
        expect(testSends(senderA.sendPacket).map(([cmd]) => cmd)).toEqual(['Test.A']);
        expect(testSends(senderB.sendPacket).map(([cmd]) => cmd)).toEqual(['Test.B']);

        a.setReceiveHealthy(false);
        expect(health).toEqual([`${A}:false`]);
        expect(b.bridge.receiveHealthy).toBe(true);

        await a.close();

        expect(lifecycle).toEqual([`started:${A}`, `started:${B}`, `closed:${A}:null`]);
        expect(manager.getBridge(B)).toBe(b.bridge);
        expect(b.bridge.empty).toBe(false);
        await b.bridge.sendRawPacket('Test.B2', new Uint8Array([3]));
        expect(testSends(senderB.sendPacket)).toHaveLength(2);
        expect(testSends(senderA.sendPacket)).toHaveLength(1);
    });

    it('lets manager shutdown dispose an open direct session without a closed event', async () => {
        const { lifecycle } = observe();
        const handle = open(A);
        const dispose = vi.spyOn(handle.bridge, 'dispose');
        handle.activate(makeSender('direct').client);

        await manager.dispose();

        expect(dispose).toHaveBeenCalled();
        expect(lifecycle).toEqual([`started:${A}`]);
        expect(() => handle.setReceiveHealthy(false)).not.toThrow();
        await expect(handle.close()).resolves.toBeUndefined();
        expect(lifecycle).toEqual([`started:${A}`]);
    });

    it('leaves the hook path unchanged next to a direct session', async () => {
        const { lifecycle, health } = observe();
        const closed = vi.fn();
        manager.subscribeSessions({ closed });
        const direct = open(A);
        direct.activate(makeSender('direct').client);
        lifecycle.length = 0;
        health.length = 0;
        const hook = makeSender('hook');

        manager.onHookLogin(101, B, hook.client);
        const bridge = manager.getBridge(B)!;

        expect(lifecycle).toEqual([`started:${B}`]);
        expect(health).toEqual([`${B}:true`]);
        expect(bridge.activePid).toBe(101);
        expect(bridge.hasPid(101)).toBe(true);
        await bridge.sendRawPacket('Test.Hook', new Uint8Array([1]));
        expect(testSends(hook.sendPacket)).toHaveLength(1);

        manager.onPidReceiveHealthChanged(101, false);
        expect(health).toEqual([`${B}:true`, `${B}:false`]);
        expect(() => manager.onPidReceiveHealthChanged(999, false)).toThrow(
            'BridgeManager invariant violated: receive health for unmapped PID=999',
        );

        manager.onPidDisconnected(101);
        expect(closed).toHaveBeenCalledOnce();
        expect(closed).toHaveBeenCalledWith(B, bridge, 101);

        // An unmapped PID's packet still creates and announces a session, as before.
        manager.onPacket(packet(0, '30003'));
        expect(lifecycle).toEqual([`started:${B}`, `closed:${B}:101`, 'started:30003']);
        expect(manager.getBridge('30003')!.empty).toBe(true);
        expect(warnings).toEqual([]);
        expect(manager.getBridge(A)).toBe(direct.bridge);
    });
});
