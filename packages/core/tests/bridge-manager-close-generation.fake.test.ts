import type { PacketSender } from '@snowluma/common/packet-sender';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { describe, expect, it, vi } from 'vitest';
import { BridgeManager } from '../src/bridge/manager';

// Manager is real; all account, Bridge, logging and transport dependencies are
// synthetic. In particular, importing this test never imports SQLite or contacts.
vi.mock('@snowluma/common/logger', () => ({
    createLogger: () => ({ trace: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    renderTraceBytes: vi.fn(),
    runWithTraceRequest: <T>(work: () => T): T => work(),
}));

vi.mock('@snowluma/protocol/identity-service', () => ({
    IdentityService: class {
        constructor(readonly uin: string) {}
        static memory(uin: string) {
            return new this(uin);
        }
        static openForUin(uin: string, _root: string, _beforeOpen?: Promise<void>) {
            return this.memory(uin);
        }
    },
}));

vi.mock('../src/bridge/bridge', () => ({
    Bridge: class {
        private readonly pids = new Map<number, PacketSender>();
        private disposal: Promise<void> | undefined;
        constructor(readonly identity: { uin: string }) {}
        get empty() {
            return this.pids.size === 0;
        }
        get activePid() {
            return [...this.pids.keys()].at(-1) ?? null;
        }
        get receiveHealthy() {
            return true;
        }
        hasPid(pid: number) {
            return this.pids.has(pid);
        }
        bindPid(pid: number, sender: PacketSender) {
            this.pids.set(pid, sender);
        }
        detachPid(pid: number) {
            this.pids.delete(pid);
        }
        packetClientForPid(pid: number) {
            return this.pids.get(pid) ?? null;
        }
        dispose() {
            return (this.disposal ??= Promise.resolve());
        }
    },
}));

const UIN = '2000000001'; // Synthetic identifier, not an account.

function deferred() {
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('synthetic close watchdog')), 2000);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

async function nextTurn() {
    await bounded(new Promise<void>((resolve) => setImmediate(resolve)));
}

function fixture() {
    const open = vi
        .spyOn(IdentityService, 'openForUin')
        .mockImplementation((uin) => IdentityService.memory(uin));
    const sendPacket = vi.fn<PacketSender['sendPacket']>(async () => {
        throw new Error('unexpected synthetic sender call');
    });
    const sender: PacketSender = { sendPacket };
    return { manager: new BridgeManager(), open, sender, sendPacket };
}

function watch(promise: Promise<void>) {
    let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
    const settled = promise.then(
        () => {
            state = 'fulfilled';
        },
        () => {
            state = 'rejected';
        },
    );
    return { settled, state: () => state };
}

describe('BridgeManager close generations (synthetic memory only)', () => {
    it('reserves the old close before a synchronous closed observer reopens the UIN', async () => {
        const f = fixture();
        const oldClose = deferred();

        try {
            f.manager.onHookLogin(101, UIN, f.sender);
            const old = f.manager.getBridge(UIN)!;
            const oldIdentity = old.identity;
            const dispose = vi.spyOn(old, 'dispose').mockReturnValue(oldClose.promise);
            let observedIdentity: unknown;
            let observedDisposeCalls = -1;
            let observedPid = -1;
            f.manager.subscribeSessions({
                closed: (_uin, bridge, pid) => {
                    observedIdentity = bridge.identity;
                    observedDisposeCalls = dispose.mock.calls.length;
                    observedPid = pid;
                    f.manager.onHookLogin(202, UIN, f.sender);
                },
            });
            f.manager.onPidDisconnected(101);
            expect(observedIdentity).toBe(oldIdentity);
            expect(observedIdentity).toMatchObject({ uin: UIN });
            expect(observedDisposeCalls).toBe(0);
            expect(observedPid).toBe(101);
            expect(dispose).toHaveBeenCalledOnce();
            expect(old.dispose()).toBe(oldClose.promise);
            expect(f.open).toHaveBeenCalledTimes(2);
            const gate = f.open.mock.calls[1][2];
            expect(gate).toBeInstanceOf(Promise);
            const opening = watch(gate!);
            await nextTurn();
            expect(opening.state()).toBe('pending');
            oldClose.resolve();
            await bounded(opening.settled);
            expect(opening.state()).toBe('fulfilled');
            expect(f.manager.getBridge(UIN)).not.toBe(old);
            expect(f.manager.getBridge(UIN)?.activePid).toBe(202);
            expect(f.sendPacket).not.toHaveBeenCalled();
        } finally {
            oldClose.resolve();

            try {
                await bounded(f.manager.dispose());
            } finally {
                vi.restoreAllMocks();
            }
        }
    });

    it('fulfills the reentrant open gate after a rejected close and reports that failure on shutdown', async () => {
        const f = fixture();
        const oldClose = deferred();
        const failure = new Error('synthetic close failure');

        try {
            f.manager.onHookLogin(101, UIN, f.sender);
            const old = f.manager.getBridge(UIN)!;
            const dispose = vi.spyOn(old, 'dispose').mockReturnValue(oldClose.promise);
            let identityAtClosed: unknown;
            let disposeCallsAtClosed = -1;
            f.manager.subscribeSessions({
                closed: (_uin, bridge) => {
                    identityAtClosed = bridge.identity;
                    disposeCallsAtClosed = dispose.mock.calls.length;
                    f.manager.onHookLogin(202, UIN, f.sender);
                },
            });
            f.manager.onPidDisconnected(101);
            expect(identityAtClosed).toBe(old.identity);
            expect(disposeCallsAtClosed).toBe(0);
            expect(dispose).toHaveBeenCalledOnce();
            const gate = f.open.mock.calls[1][2];
            expect(gate).toBeInstanceOf(Promise);
            const opening = watch(gate!);
            await nextTurn();
            expect(opening.state()).toBe('pending');
            const shutdown = f.manager.dispose().then(
                () => null,
                (error: unknown) => error,
            );
            oldClose.reject(failure);
            await bounded(opening.settled);
            expect(opening.state()).toBe('fulfilled');
            const error = await bounded(shutdown);
            expect(error).toBeInstanceOf(AggregateError);
            expect((error as AggregateError).errors).toEqual([failure]);
            expect(f.sendPacket).not.toHaveBeenCalled();
        } finally {
            oldClose.resolve();

            try {
                await bounded(f.manager.dispose().catch(() => undefined));
            } finally {
                vi.restoreAllMocks();
            }
        }
    });

    it('waits for both reentrantly closed generations when they settle in reverse order', async () => {
        const f = fixture();
        const firstClose = deferred();
        const secondClose = deferred();

        try {
            f.manager.onHookLogin(101, UIN, f.sender);
            const first = f.manager.getBridge(UIN)!;
            const firstDispose = vi.spyOn(first, 'dispose').mockReturnValue(firstClose.promise);
            const refs: { second?: typeof first; secondDisposeCalls?: () => number } = {};
            const observations: Array<[number, unknown, number]> = [];
            f.manager.subscribeSessions({
                closed: (_uin, bridge, pid) => {
                    if (pid === 101) {
                        observations.push([pid, bridge.identity, firstDispose.mock.calls.length]);
                        f.manager.onHookLogin(202, UIN, f.sender);
                        refs.second = f.manager.getBridge(UIN)!;
                        const dispose = vi
                            .spyOn(refs.second, 'dispose')
                            .mockReturnValue(secondClose.promise);
                        refs.secondDisposeCalls = () => dispose.mock.calls.length;
                        f.manager.onPidDisconnected(202);
                    } else if (pid === 202) {
                        observations.push([pid, bridge.identity, refs.secondDisposeCalls!()]);
                        f.manager.onHookLogin(303, UIN, f.sender);
                    }
                },
            });
            f.manager.onPidDisconnected(101);
            expect(refs.second).toBeDefined();
            expect(observations).toEqual([
                [101, first.identity, 0],
                [202, refs.second!.identity, 0],
            ]);
            expect(firstDispose).toHaveBeenCalledOnce();
            expect(refs.secondDisposeCalls!()).toBe(1);
            expect(f.open).toHaveBeenCalledTimes(3);
            const gate = f.open.mock.calls[2][2];
            expect(gate).toBeInstanceOf(Promise);
            const opening = watch(gate!);
            const latest = f.manager.getBridge(UIN);
            expect(latest).not.toBe(first);
            expect(latest).not.toBe(refs.second);
            expect(latest?.activePid).toBe(303);
            await nextTurn();
            expect(opening.state()).toBe('pending');
            secondClose.resolve();
            await nextTurn();
            expect(opening.state()).toBe('pending');
            expect(f.manager.getBridge(UIN)).toBe(latest);
            firstClose.resolve();
            await bounded(opening.settled);
            expect(opening.state()).toBe('fulfilled');
            expect(f.manager.getBridge(UIN)).toBe(latest);
            expect(latest?.activePid).toBe(303);
            expect(f.sendPacket).not.toHaveBeenCalled();
        } finally {
            secondClose.resolve();
            firstClose.resolve();

            try {
                await bounded(f.manager.dispose());
            } finally {
                vi.restoreAllMocks();
            }
        }
    });
});
