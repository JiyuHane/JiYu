import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import type {
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
    Sso12CloseReason,
} from '../../src/direct/sso12-packet-client';

function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((a, b) => {
        resolve = a;
        reject = b;
    });
    return { promise, resolve, reject };
}

const config = () => ({ trustedSuccessQuiescence: true as const, isUsable: () => true });
const options = (
    extra: Partial<Sso12RawOptions<number, string>> = {},
): Sso12RawOptions<number, string> => ({
    buildRequest: () => ({ frame: Uint8Array.of(1), context: 1 }),
    verifyCandidate: () => true,
    consumeCandidate: () => 'ok',
    ...extra,
});
const success = { kind: 'response', sequence: 1, value: 'ok', writeState: 'written' } as const;
class Fake implements Sso12RawClient {
    closed = deferred<Sso12CloseReason>();
    whenClosed = this.closed.promise;
    close = vi.fn();
    calls = 0;
    seen: Sso12RawOptions<unknown, unknown>[] = [];
    impl: (o: Sso12RawOptions<unknown, unknown>) => Promise<Sso12RawResult<unknown>> = async () =>
        success;
    transactRaw<C, T>(o: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        this.calls++;
        this.seen.push(o as Sso12RawOptions<unknown, unknown>);
        return this.impl(o as Sso12RawOptions<unknown, unknown>) as Promise<Sso12RawResult<T>>;
    }
}
const acquire = (f: Fake, duration = 1000, signal?: AbortSignal) =>
    createRawSessionBroker(f, config()).acquire({ deadline: performance.now() + duration, signal });
afterEach(() => vi.useRealTimers());

describe('raw session broker: in-memory fakes only', () => {
    it('observes late rejection of a native transport promise with a throwing then getter', async () => {
        const events: unknown[] = [];

        const listener = (reason: unknown): void => {
            events.push(reason);
        };

        process.on('unhandledRejection', listener);

        try {
            const f = new Fake();
            const pending = deferred<Sso12RawResult<unknown>>();
            Object.defineProperty(pending.promise, 'then', {
                get() {
                    throw Error('secret getter');
                },
            });
            f.impl = () => pending.promise;
            const lease = acquire(f);
            const abort = new AbortController();
            const work = lease.transactRaw(options({ signal: abort.signal }));
            abort.abort();
            expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            pending.reject(Error('secret rejection'));
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(events).toEqual([]);
            expect(await lease.whenClosed).toBe('poisoned');
            expect(f.close).toHaveBeenCalledTimes(1);
        } finally {
            process.off('unhandledRejection', listener);
        }
    });
    it('observes late rejection of native whenClosed with a throwing then getter', async () => {
        const events: unknown[] = [];

        const listener = (reason: unknown): void => {
            events.push(reason);
        };

        process.on('unhandledRejection', listener);

        try {
            const f = new Fake();
            Object.defineProperty(f.closed.promise, 'then', {
                get() {
                    throw Error('secret getter');
                },
            });
            const lease = acquire(f);
            lease.release();
            f.closed.reject(Error('secret rejection'));
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(events).toEqual([]);
            expect(await lease.whenClosed).toBe('released');
            expect(f.close).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', listener);
        }
    });
    it.each(['session idle', 'session inflight', 'operation inflight'] as const)(
        'handles stopImmediatePropagation before %s cancellation',
        async (mode) => {
            const events: unknown[] = [];

            const onUnhandled = (reason: unknown): void => {
                events.push(reason);
            };

            process.on('unhandledRejection', onUnhandled);

            try {
                const abort = new AbortController();
                abort.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
                const f = new Fake();
                const late = deferred<Sso12RawResult<unknown>>();
                f.impl = () => late.promise;
                const sessionSignal = mode.startsWith('session') ? abort.signal : undefined;
                const lease = acquire(f, 1000, sessionSignal);
                const work =
                    mode === 'session idle'
                        ? undefined
                        : lease.transactRaw(
                              options({
                                  signal: mode === 'operation inflight' ? abort.signal : undefined,
                              }),
                          );
                abort.abort();
                expect(f.close).toHaveBeenCalledTimes(1);
                expect(await lease.whenClosed).toBe('poisoned');

                if (work) {
                    expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
                } else {
                    expect(await lease.transactRaw(options())).toMatchObject({
                        writeState: 'not-written',
                    });
                }

                late.reject(Error('secret'));

                if (!work) {
                    await late.promise.catch(() => {});
                }

                await new Promise<void>((resolve) => setImmediate(resolve));
                expect(events).toEqual([]);
                expect(f.close).toHaveBeenCalledTimes(1);
            } finally {
                process.off('unhandledRejection', onUnhandled);
            }
        },
    );
    it.each(['aborted', 'addEventListener', 'removeEventListener'] as const)(
        'rejects signal own %s shadows before session or operation transport',
        async (key) => {
            const secret = vi.fn(() => {
                throw Error('shadow secret');
            });

            const makeSignal = (): AbortSignal => {
                const signal = new AbortController().signal;
                Object.defineProperty(
                    signal,
                    key,
                    key === 'aborted' ? { get: secret } : { value: secret },
                );
                return signal;
            };

            const first = new Fake();
            expect(() => acquire(first, 1000, makeSignal())).toThrow();
            expect(first.calls).toBe(0);
            expect(first.close).not.toHaveBeenCalled();
            const second = new Fake();
            const lease = acquire(second);
            const result = await lease.transactRaw(options({ signal: makeSignal() }));
            expect(result).toMatchObject({ kind: 'failure', writeState: 'not-written' });
            expect(JSON.stringify(result)).not.toContain('secret');
            expect(second.calls).toBe(0);
            expect(secret).not.toHaveBeenCalled();
            expect(second.close).toHaveBeenCalledTimes(1);
        },
    );
    it('rejects custom signal prototypes without mutating the signal', async () => {
        const signal = new AbortController().signal;
        const custom = Object.create(AbortSignal.prototype);
        Object.setPrototypeOf(signal, custom);
        const f = new Fake();
        expect(() => acquire(f, 1000, signal)).toThrow();
        expect(Object.getPrototypeOf(signal)).toBe(custom);
        expect(Object.isFrozen(signal)).toBe(false);
        expect(f.calls).toBe(0);
    });
    it('poisons on release called by an earlier session abort listener', async () => {
        const f = new Fake();
        const abort = new AbortController();
        let lease!: ReturnType<typeof acquire>;
        abort.signal.addEventListener('abort', () => lease.release());
        lease = acquire(f, 1000, abort.signal);
        abort.abort();
        expect(await lease.whenClosed).toBe('poisoned');
        lease.release();
        expect(f.close).toHaveBeenCalledTimes(1);
    });
    it('poisons on release after deadline even before timer callback', async () => {
        const now = vi.spyOn(performance, 'now').mockReturnValue(1000);

        try {
            const f = new Fake();
            const lease = acquire(f, 100);
            now.mockReturnValue(1101);
            lease.release();
            expect(await lease.whenClosed).toBe('poisoned');
            lease.close();
            expect(f.close).toHaveBeenCalledTimes(1);
        } finally {
            now.mockRestore();
        }
    });
    it('retires client across brokers and release, and preserves serial successes', async () => {
        const f = new Fake();
        const a = createRawSessionBroker(f, config());
        const b = createRawSessionBroker(f, config());
        const lease = a.acquire({ deadline: performance.now() + 1000 });
        expect(() => b.acquire({ deadline: performance.now() + 1000 })).toThrow();
        expect(await lease.transactRaw(options())).toEqual(success);
        expect(await lease.transactRaw(options())).toEqual(success);
        lease.release();
        expect(await lease.whenClosed).toBe('released');
        expect(f.close).not.toHaveBeenCalled();
        expect(() => a.acquire({ deadline: performance.now() + 1000 })).toThrow();
    });
    it('handles busy reentry and fences callbacks by operation epoch', async () => {
        const f = new Fake();
        const pending = deferred<Sso12RawResult<unknown>>();
        f.impl = () => pending.promise;
        const lease = acquire(f);
        const first = lease.transactRaw(options());
        expect(await lease.transactRaw(options())).toMatchObject({
            code: 'busy',
            writeState: 'not-written',
        });
        const old = f.seen[0];
        pending.resolve(success);
        expect(await first).toEqual(success);
        const next = deferred<Sso12RawResult<unknown>>();
        f.impl = () => next.promise;
        const second = lease.transactRaw(options());
        await expect(old.buildRequest({ uin: '0', sequence: 1 })).rejects.toThrow();
        next.resolve(success);
        expect(await second).toEqual(success);
        lease.release();
    });
    it('validates config and pre-cancelled signals before entering transport', async () => {
        const f = new Fake();
        expect(() =>
            createRawSessionBroker(f, { ...config(), trustedSuccessQuiescence: false } as never),
        ).toThrow();
        expect(() => createRawSessionBroker(f, { ...config(), isUsable: 4 } as never)).toThrow();
        const pre = new AbortController();
        pre.abort();
        expect(() => acquire(f, 1000, pre.signal)).toThrow();
        const lease = acquire(f);
        expect(await lease.transactRaw(options({ signal: pre.signal }))).toMatchObject({
            writeState: 'not-written',
        });
        expect(f.calls).toBe(0);
        lease.release();
    });
    it.each(['operation', 'session'])('%s timeout races a non-settling transport', async (kind) => {
        vi.useFakeTimers();
        const f = new Fake();
        f.impl = () => new Promise(() => {});
        const lease = acquire(f, kind === 'session' ? 20 : 1000);
        const result = lease.transactRaw(options({ timeoutMs: kind === 'operation' ? 20 : 1000 }));
        await vi.advanceTimersByTimeAsync(25);
        expect(await result).toMatchObject({ kind: 'failure', writeState: 'unknown' });
        expect(await lease.whenClosed).toBe('poisoned');
        lease.close();
        lease.poison();
        expect(f.close).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['resolve', 'reject'])('late %s is observed without revival', async (mode) => {
        const f = new Fake();
        const d = deferred<Sso12RawResult<unknown>>();
        f.impl = () => d.promise;
        const lease = acquire(f);
        const abort = new AbortController();
        const work = lease.transactRaw(options({ signal: abort.signal }));
        abort.abort();
        expect(await work).toMatchObject({ writeState: 'unknown' });

        if (mode === 'resolve') {
            d.resolve(success);
        } else {
            d.reject(new Error('secret'));
        }

        await Promise.resolve();
        await Promise.resolve();
        expect(await lease.transactRaw(options())).toMatchObject({ writeState: 'not-written' });
        expect(f.close).toHaveBeenCalledTimes(1);
    });
    it('poisons on failure, throw, malformed results without retries or secret leakage', async () => {
        for (const impl of [
            () => Promise.resolve({ kind: 'failure', code: 'secret', writeState: 'not-written' }),
            () => {
                throw Error('secret');
            },
            () => Promise.resolve({ kind: 'response', sequence: -1 }),
        ]) {
            const f = new Fake();
            f.impl = impl as Fake['impl'];
            const lease = acquire(f);
            const result = await lease.transactRaw(options());
            expect(result).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            expect(JSON.stringify(result)).not.toContain('secret');
            expect(f.calls).toBe(1);
            expect(f.close).toHaveBeenCalledTimes(1);
        }
    });
    it('races client whenClosed and session abort without double close', async () => {
        const f = new Fake();
        f.impl = () => new Promise(() => {});
        const abort = new AbortController();
        const lease = acquire(f, 1000, abort.signal);
        const work = lease.transactRaw(options());
        f.closed.resolve({ kind: 'remote', code: 'fixture' });
        abort.abort();
        expect(await work).toMatchObject({ writeState: 'unknown' });
        expect(await lease.whenClosed).toBe('poisoned');
        expect(f.close).toHaveBeenCalledTimes(1);
    });
    it('handles throwing or reentrant usability checks and throwing close observation', async () => {
        const f = new Fake();
        let broker: ReturnType<typeof createRawSessionBroker>;
        broker = createRawSessionBroker(f, {
            trustedSuccessQuiescence: true,
            isUsable: () => {
                expect(() => broker.acquire({ deadline: performance.now() + 1000 })).toThrow();
                throw Error('secret');
            },
        });
        const lease = broker.acquire({ deadline: performance.now() + 1000 });
        expect(await lease.whenClosed).toBe('poisoned');
        expect(f.close).toHaveBeenCalledTimes(1);
        const g = new Fake();
        Object.defineProperty(g, 'whenClosed', {
            get() {
                throw Error('secret');
            },
        });
        const bad = acquire(g);
        expect(await bad.whenClosed).toBe('poisoned');
        expect(g.close).toHaveBeenCalledTimes(1);
    });
    it('explicitly performs no socket operations in a fake exchange', async () => {
        const connect = vi.spyOn(net, 'connect');
        const createConnection = vi.spyOn(net, 'createConnection');
        const listen = vi.spyOn(net.Server.prototype, 'listen');
        const tlsConnect = vi.spyOn(tls, 'connect');
        const datagram = vi.spyOn(dgram, 'createSocket');

        try {
            const f = new Fake();
            const lease = acquire(f);
            expect(await lease.transactRaw(options())).toEqual(success);
            lease.release();
            expect(connect).not.toHaveBeenCalled();
            expect(createConnection).not.toHaveBeenCalled();
            expect(listen).not.toHaveBeenCalled();
            expect(tlsConnect).not.toHaveBeenCalled();
            expect(datagram).not.toHaveBeenCalled();
        } finally {
            vi.restoreAllMocks();
        }
    });
    it('prevents usability reentry from turning a poisoned operation into success', async () => {
        const f = new Fake();
        let lease: ReturnType<typeof acquire>;
        let checks = 0;
        const broker = createRawSessionBroker(f, {
            trustedSuccessQuiescence: true,
            isUsable: () => {
                if (++checks > 1) {
                    lease.release();
                }

                return true;
            },
        });
        lease = broker.acquire({ deadline: performance.now() + 1000 });
        expect(await lease.transactRaw(options())).toMatchObject({ writeState: 'not-written' });
        expect(await lease.whenClosed).toBe('poisoned');
        expect(f.calls).toBe(0);
    });
    it('ignores closed observation that never settles and observes rejected thenables', async () => {
        const f = new Fake();
        const lease = acquire(f);
        lease.release();
        expect(await lease.whenClosed).toBe('released');
        const g = new Fake();
        Object.defineProperty(g, 'whenClosed', {
            value: {
                then(_resolve: unknown, reject: (e: unknown) => void) {
                    reject(Error('secret'));
                },
            },
        });
        const other = acquire(g);
        await Promise.resolve();
        await Promise.resolve();
        expect(await other.whenClosed).toBe('poisoned');
    });
    it('rejects callback result getters without exposing their side effects', async () => {
        const f = new Fake();
        f.impl = async () =>
            Object.defineProperty(
                { kind: 'response', sequence: 1, writeState: 'written' },
                'value',
                {
                    enumerable: true,
                    get() {
                        throw Error('secret');
                    },
                },
            ) as never;
        const lease = acquire(f);
        const result = await lease.transactRaw(options());
        expect(result).toMatchObject({ kind: 'failure', writeState: 'unknown' });
        expect(JSON.stringify(result)).not.toContain('secret');
    });
    it('rechecks usability before committing a successful transport result', async () => {
        const f = new Fake();
        let checks = 0;
        const broker = createRawSessionBroker(f, {
            trustedSuccessQuiescence: true,
            isUsable: () => ++checks < 3,
        });
        const lease = broker.acquire({ deadline: performance.now() + 1000 });
        expect(await lease.transactRaw(options())).toMatchObject({
            kind: 'failure',
            writeState: 'unknown',
        });
        expect(await lease.whenClosed).toBe('poisoned');
        expect(f.close).toHaveBeenCalledTimes(1);
    });
    it.each(['verifyCandidate', 'consumeCandidate'] as const)(
        'revokes %s after await',
        async (name) => {
            const f = new Fake();
            f.impl = () => new Promise(() => {});
            const d = deferred<never>();
            const abort = new AbortController();
            const callback = vi.fn(() => d.promise);
            const lease = acquire(f);
            const work = lease.transactRaw(options({ [name]: callback, signal: abort.signal }));
            const wrapper = f.seen[0];
            const pending = wrapper[name](Uint8Array.of(1), 1, { uin: '0', sequence: 1 });
            abort.abort();
            d.resolve(true as never);
            await expect(pending).rejects.toThrow();
            await expect(
                wrapper[name](Uint8Array.of(1), 1, { uin: '0', sequence: 1 }),
            ).rejects.toThrow();
            expect(callback).toHaveBeenCalledTimes(1);
            expect(await work).toMatchObject({ writeState: 'unknown' });
        },
    );
    it('revokes async callback before and after cancellation', async () => {
        const f = new Fake();
        const d = deferred<{ frame: Uint8Array; context: number }>();
        f.impl = () => new Promise(() => {});
        const lease = acquire(f);
        const abort = new AbortController();
        const build = vi.fn(() => d.promise);
        const result = lease.transactRaw(options({ buildRequest: build, signal: abort.signal }));
        const wrapper = f.seen[0];
        const entered = wrapper.buildRequest({ uin: '0', sequence: 1 });
        abort.abort();
        d.resolve({ frame: Uint8Array.of(1), context: 1 });
        await expect(entered).rejects.toThrow();
        await expect(wrapper.buildRequest({ uin: '0', sequence: 1 })).rejects.toThrow();
        expect(build).toHaveBeenCalledTimes(1);
        expect(await result).toMatchObject({ writeState: 'unknown' });
    });
});
