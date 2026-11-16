import type { PacketSender } from '@snowluma/common/packet-sender';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { describe, expect, it, vi } from 'vitest';
import { BridgeManager } from '../src/bridge/manager';

// All account, bridge, logger and sender dependencies are synthetic; only the
// manager is real. No Hook, native transport, account or network is started.
const log = vi.hoisted(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
}));

vi.mock('@snowluma/common/logger', () => ({
    createLogger: () => log,
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
        dispose(): Promise<void> {
            return Promise.resolve();
        }
    },
}));

const UIN = '2000000001';
const OTHER_UIN = '2000000002';

function deferred() {
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    // A failure path in a test must never leave this promise unobserved.
    void promise.catch(() => undefined);
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
    log.debug.mockReset();
    log.warn.mockReset();
    log.error.mockReset();
    log.trace.mockReset();
    const open = vi
        .spyOn(IdentityService, 'openForUin')
        .mockImplementation((uin) => IdentityService.memory(uin));
    const sendPacket = vi.fn<PacketSender['sendPacket']>(() => {
        throw new Error('unexpected synthetic sender call');
    });
    const sender: PacketSender = { sendPacket };
    return { manager: new BridgeManager(), open, sender, sendPacket };
}

function thrownBy(work: () => void): unknown {
    try {
        work();
    } catch (error) {
        return error;
    }

    return undefined;
}

function observe<T>(promise: Promise<T>) {
    let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
    const settled = promise.then(
        (value) => {
            state = 'fulfilled';
            return { value, error: undefined };
        },
        (error: unknown) => {
            state = 'rejected';
            return { value: undefined, error };
        },
    );
    return { settled, state: () => state };
}

async function cleanup(manager: BridgeManager) {
    try {
        await bounded(manager.dispose().catch(() => undefined));
        await nextTurn();
    } finally {
        vi.restoreAllMocks();
        log.debug.mockReset();
        log.warn.mockReset();
        log.error.mockReset();
        log.trace.mockReset();
    }
}

describe('BridgeManager close errors (synthetic memory only)', () => {
    it('keeps a synchronous disposal error despite a throwing error observer', async () => {
        const f = fixture();
        const closeErr = new Error('synthetic close error');
        const logErr = new Error('synthetic error logger failure');

        try {
            f.manager.onHookLogin(101, UIN, f.sender);
            const old = f.manager.getBridge(UIN)!;
            const dispose = vi.spyOn(old, 'dispose').mockImplementation(() => {
                throw closeErr;
            });
            log.error.mockImplementation(() => {
                throw logErr;
            });
            expect(thrownBy(() => f.manager.onPidDisconnected(101))).toBe(closeErr);
            expect(dispose).toHaveBeenCalledOnce();
            await nextTurn();
            expect(log.error).toHaveBeenCalledOnce();
            const shutdown = observe(f.manager.dispose());
            const result = await bounded(shutdown.settled);
            expect(result.error).toBeInstanceOf(AggregateError);
            expect((result.error as AggregateError).errors).toEqual([closeErr]);
            expect(f.sendPacket).not.toHaveBeenCalled();
            await nextTurn();
        } finally {
            await cleanup(f.manager);
        }
    });

    it('reserves a reentrant open before observers and starts disposal after a throwing warning', async () => {
        const f = fixture();
        const oldClose = deferred();
        const listenerErr = new Error('synthetic listener failure');
        const warnErr = new Error('synthetic warning failure');
        const traceErr = new Error('synthetic terminal trace failure');

        try {
            f.manager.onHookLogin(101, UIN, f.sender);
            const old = f.manager.getBridge(UIN)!;
            const dispose = vi.spyOn(old, 'dispose').mockReturnValue(oldClose.promise);
            const order: string[] = [];
            f.manager.subscribeSessions({
                closed: () => {
                    order.push('reopen');
                    expect(dispose).not.toHaveBeenCalled();
                    f.manager.onHookLogin(202, UIN, f.sender);
                },
            });
            f.manager.subscribeSessions({
                closed: () => {
                    order.push('throwing observer');
                    expect(dispose).not.toHaveBeenCalled();
                    throw listenerErr;
                },
            });
            log.warn.mockImplementation(() => {
                order.push('warning');
                throw warnErr;
            });
            log.trace.mockImplementation((message: unknown) => {
                if (
                    typeof message === 'string' &&
                    message.includes('bridge_detach_terminal') &&
                    message.includes('outcome=failed')
                ) {
                    throw traceErr;
                }
            });
            expect(thrownBy(() => f.manager.onPidDisconnected(101))).toBe(warnErr);
            expect(order).toEqual(['reopen', 'throwing observer', 'warning']);
            expect(log.warn).toHaveBeenCalledWith(
                'session-closed listener threw: %s',
                listenerErr.message,
            );
            expect(dispose).toHaveBeenCalledOnce();
            expect(f.open).toHaveBeenCalledTimes(2);
            const gate = f.open.mock.calls[1][2];
            expect(gate).toBeInstanceOf(Promise);
            const opening = observe(gate!);
            await nextTurn();
            expect(opening.state()).toBe('pending');
            const shutdown = observe(f.manager.dispose());
            await nextTurn();
            expect(shutdown.state()).toBe('pending');
            oldClose.resolve();
            await bounded(opening.settled);
            expect(opening.state()).toBe('fulfilled');
            expect((await bounded(shutdown.settled)).error).toBeUndefined();
            expect(f.sendPacket).not.toHaveBeenCalled();
        } finally {
            oldClose.resolve();
            await cleanup(f.manager);
        }
    });

    it('starts and drains disposal when the session-closed debug call throws', async () => {
        const f = fixture();
        const oldClose = deferred();
        const debugErr = new Error('synthetic debug failure');

        try {
            f.manager.onHookLogin(101, UIN, f.sender);
            const old = f.manager.getBridge(UIN)!;
            const dispose = vi.spyOn(old, 'dispose').mockReturnValue(oldClose.promise);
            const closed = vi.fn();
            f.manager.subscribeSessions({ closed });
            log.debug.mockImplementation((message: unknown) => {
                if (typeof message === 'string' && message.startsWith('session closed:')) {
                    throw debugErr;
                }
            });
            expect(thrownBy(() => f.manager.onPidDisconnected(101))).toBe(debugErr);
            expect(dispose).toHaveBeenCalledOnce();
            expect(closed).not.toHaveBeenCalled();
            const shutdown = observe(f.manager.dispose());
            await nextTurn();
            expect(shutdown.state()).toBe('pending');
            oldClose.resolve();
            expect((await bounded(shutdown.settled)).error).toBeUndefined();
            expect(f.sendPacket).not.toHaveBeenCalled();
        } finally {
            oldClose.resolve();
            await cleanup(f.manager);
        }
    });

    it('continues shutting down other accounts after a synchronous dispose failure', async () => {
        const f = fixture();
        const secondClose = deferred();
        const closeErr = new Error('synthetic first close failure');
        const logErr = new Error('synthetic error logger failure');

        try {
            f.manager.onHookLogin(101, UIN, f.sender);
            f.manager.onHookLogin(202, OTHER_UIN, f.sender);
            const first = f.manager.getBridge(UIN)!;
            const second = f.manager.getBridge(OTHER_UIN)!;
            const firstDispose = vi.spyOn(first, 'dispose').mockImplementation(() => {
                throw closeErr;
            });
            const secondDispose = vi.spyOn(second, 'dispose').mockReturnValue(secondClose.promise);
            log.error.mockImplementation(() => {
                throw logErr;
            });
            const shutdown = observe(f.manager.dispose());
            await nextTurn();
            expect(firstDispose).toHaveBeenCalledOnce();
            expect(secondDispose).toHaveBeenCalledOnce();
            expect(log.error).toHaveBeenCalledOnce();
            expect(shutdown.state()).toBe('pending');
            secondClose.resolve();
            const result = await bounded(shutdown.settled);
            expect(result.error).toBeInstanceOf(AggregateError);
            expect((result.error as AggregateError).errors).toEqual([closeErr]);
            expect(f.sendPacket).not.toHaveBeenCalled();
            await nextTurn();
        } finally {
            secondClose.resolve();
            await cleanup(f.manager);
        }
    });

    it('ignores a disconnect after shutdown begins and disposes the bridge once', async () => {
        const f = fixture();
        const close = deferred();

        try {
            f.manager.onHookLogin(101, UIN, f.sender);
            const bridge = f.manager.getBridge(UIN)!;
            const dispose = vi.spyOn(bridge, 'dispose').mockReturnValue(close.promise);
            const shutdown = observe(f.manager.dispose());
            const closed = vi.fn();
            f.manager.subscribeSessions({ closed });
            f.manager.onPidDisconnected(101);
            expect(closed).not.toHaveBeenCalled();
            await nextTurn();
            expect(dispose).toHaveBeenCalledOnce();
            expect(shutdown.state()).toBe('pending');
            close.resolve();
            expect((await bounded(shutdown.settled)).error).toBeUndefined();
            expect(closed).not.toHaveBeenCalled();
            expect(dispose).toHaveBeenCalledOnce();
            expect(f.sendPacket).not.toHaveBeenCalled();
        } finally {
            close.resolve();
            await cleanup(f.manager);
        }
    });
});
