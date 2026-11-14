import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
    createRawMultiplexStream,
    type RawMultiplexByteStream,
    type RawMultiplexStreamOptions,
} from '../../src/direct/raw-multiplex-stream';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import { claimDirectSocket } from '../../src/direct/socket-ownership';
import { guardBorrowedTransport } from '../../src/direct/guard-raw-transaction';
import type { Sso12RawOptions } from '../../src/direct/sso12-packet-client';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const events = ['data', 'drain', 'error', 'end', 'close', 'pause'] as const;

type WriteCallback = (error?: Error | null) => void;

// Scripted EventEmitter only: there is no socket, connection, or real peer.
class FakeStream extends EventEmitter {
    readable = true;
    writable = true;
    destroyed = false;
    writableLength = 0;
    writableNeedDrain = false;
    readableFlowing: boolean | null = null;
    writes: Uint8Array[] = [];
    callbacks: WriteCallback[] = [];
    borrowed: Uint8Array[] = [];
    accept = true;
    throwWrite = false;
    duringWrite?: (callback: WriteCallback) => void;
    duringDestroy?: () => void;
    destroyCalls = 0;

    write(frame: Uint8Array, callback: WriteCallback): boolean {
        this.writes.push(Uint8Array.from(frame));
        this.borrowed.push(frame);
        this.callbacks.push(callback);

        if (this.throwWrite) {
            throw new Error('synthetic write failure');
        }

        this.writableNeedDrain = !this.accept;
        this.duringWrite?.(callback);
        return this.accept;
    }

    destroy(): this {
        this.destroyCalls++;
        this.destroyed = true;
        this.readable = false;
        this.writable = false;
        this.duringDestroy?.();
        return this;
    }

    drain(): void {
        this.writableNeedDrain = false;
        this.emit('drain');
    }

    finishClose(): void {
        this.destroyed = true;
        this.readable = false;
        this.writable = false;
        this.emit('close');
    }
}

// Four-byte big-endian frame length, followed by synthetic kind and identifier.
function frame(kind: number, id: number): Uint8Array {
    const result = Buffer.alloc(14);
    result.writeUInt32BE(result.length, 0);
    result[4] = kind;
    result.writeUInt32BE(id, 5);
    return result;
}

function options(overrides: Partial<RawMultiplexStreamOptions> = {}): RawMultiplexStreamOptions {
    return {
        exclusiveConnected: true,
        maxWriteBufferBytes: 4096,
        uin: '0',
        initialSequence: 17,
        defaultTimeoutMs: 1000,
        maxFrameBytes: 1024,
        maxBufferedBytes: 4096,
        maxFrames: 8,
        maxPushFrames: 8,
        maxPushBytes: 4096,
        classify: (bytes) => {
            const id = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(5);
            return bytes[4] === 1
                ? { kind: 'response', sequence: id }
                : { kind: 'push', name: 'synthetic', id };
        },
        verifyPush: () => true,
        onPush: () => {},
        ...overrides,
    };
}

function request(
    extra: Partial<Sso12RawOptions<null, string>> = {},
): Sso12RawOptions<null, string> {
    return {
        buildRequest: ({ sequence }) => ({ frame: frame(1, sequence), context: null }),
        verifyCandidate: () => true,
        consumeCandidate: () => 'accepted',
        ...extra,
    };
}

function fixture(overrides: Partial<RawMultiplexStreamOptions> = {}) {
    const stream = new FakeStream();
    const userError = vi.fn();
    stream.on('error', userError);

    for (const event of events) {
        if (event !== 'error') {
            stream.on(event, vi.fn());
        }
    }

    const baseline = new Map(events.map((event) => [event, stream.listeners(event)]));
    const registrations: string[] = [];
    stream.on('newListener', (event) => {
        if (typeof event === 'string' && events.some((name) => name === event)) {
            registrations.push(event);
        }
    });
    const client = createRawMultiplexStream(stream, options(overrides));
    return { stream, client, baseline, userError, registrations };
}

async function wrote(stream: FakeStream, count = 1): Promise<void> {
    for (let i = 0; i < 20 && stream.writes.length < count; i++) {
        await turn();
    }

    expect(stream.writes).toHaveLength(count);
}

function expectRestored(
    stream: FakeStream,
    baseline: Map<string, ReturnType<FakeStream['listeners']>>,
): void {
    for (const event of events) {
        expect(stream.listeners(event)).toEqual(baseline.get(event));
    }
}

describe('raw multiplex byte stream: synthetic EventEmitter only', () => {
    it('accepts Node Socket in the stream interface at the type level', () => {
        expectTypeOf<Socket>().toExtend<RawMultiplexByteStream>();
    });

    it.each([true, false])(
        'holds candidate verification until the real write callback (write returns %s)',
        async (accepted) => {
            const pushed = deferred<void>();
            const verify = vi.fn(() => true);
            const consume = vi.fn(() => 'accepted');
            const f = fixture({ onPush: () => pushed.resolve() });
            f.stream.accept = accepted;
            const lease = createRawSessionBroker(f.client, {
                trustedSuccessQuiescence: true,
                isUsable: () => !f.client.closed,
            }).acquire({ deadline: performance.now() + 5000 });
            const work = guardBorrowedTransport<null, string>(lease)(
                request({ verifyCandidate: verify, consumeCandidate: consume }),
            );

            try {
                await wrote(f.stream);
                const peerBytes = Uint8Array.from(f.stream.writes[0]);
                f.stream.emit('data', Buffer.concat([frame(2, 17), frame(1, 17)]));
                await pushed.promise;
                await turn();
                expect(verify).not.toHaveBeenCalled();
                expect(consume).not.toHaveBeenCalled();
                f.stream.callbacks[0]();
                expect(await work).toMatchObject({
                    kind: 'response',
                    sequence: 17,
                    value: 'accepted',
                    writeState: 'written',
                });
                expect(verify).toHaveBeenCalledOnce();
                expect(consume).toHaveBeenCalledOnce();
                expect(f.stream.writes[0]).toEqual(peerBytes);
                f.stream.callbacks[0]();
                f.stream.drain();
                f.stream.drain();
                await turn();
                expect(verify).toHaveBeenCalledOnce();
                expect(consume).toHaveBeenCalledOnce();
            } finally {
                lease.release();
                f.client.close();
                f.stream.finishClose();
            }

            expectRestored(f.stream, f.baseline);
        },
    );

    it('fails closed instead of writing a second request while backpressured', async () => {
        const f = fixture();
        f.stream.accept = false;
        const first = f.client.transactRaw(request());
        await wrote(f.stream);
        f.stream.emit('data', frame(1, 17));
        f.stream.callbacks[0]();
        expect(await first).toMatchObject({ kind: 'response' });
        const second = await f.client.transactRaw(request());
        expect(second).toMatchObject({ kind: 'failure', writeState: 'unknown' });
        expect(f.stream.writes).toHaveLength(1);
        await f.client.whenClosed;
        f.stream.drain();
        f.stream.callbacks[0]();
        f.stream.finishClose();
        expectRestored(f.stream, f.baseline);
    });

    it.each(['callback-error', 'throw'] as const)(
        'closes on %s without consuming a staged response',
        async (mode) => {
            const consume = vi.fn(() => 'unexpected');
            const f = fixture();
            f.stream.throwWrite = mode === 'throw';
            const work = f.client.transactRaw(request({ consumeCandidate: consume }));
            await wrote(f.stream);

            if (mode === 'callback-error') {
                f.stream.emit('data', frame(1, 17));
                await turn();
                f.stream.callbacks[0](new Error('synthetic callback failure'));
            }

            expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            await f.client.whenClosed;
            f.stream.callbacks[0]();
            await turn();
            expect(consume).not.toHaveBeenCalled();
            f.stream.finishClose();
            expectRestored(f.stream, f.baseline);
        },
    );

    it.each(['error', 'end', 'close'] as const)(
        'settles an in-flight transaction on stream %s and removes adapter listeners',
        async (event) => {
            const f = fixture();
            const work = f.client.transactRaw(request());
            await wrote(f.stream);

            if (event === 'error') {
                f.stream.emit('error', new Error('synthetic stream error'));
            } else if (event === 'close') {
                f.stream.finishClose();
            } else {
                f.stream.emit('end');
            }

            expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            await f.client.whenClosed;
            f.stream.callbacks[0]();

            if (event !== 'close') {
                f.stream.finishClose();
            }

            await turn();
            expectRestored(f.stream, f.baseline);
        },
    );

    it.each([1, 3, 4, 10])('reports a truncated frame on end after %i bytes', async (length) => {
        const f = fixture();
        f.stream.emit('data', frame(2, 8).subarray(0, length));
        f.stream.emit('end');
        expect(await f.client.whenClosed).toMatchObject({
            kind: 'protocol-error',
            code: 'truncated-stream',
        });
        f.stream.finishClose();
        expectRestored(f.stream, f.baseline);
    });

    it('closes idempotently, preserves caller listeners and retires the stream object', async () => {
        const f = fixture();
        expect(f.registrations[0]).toBe('error');
        expect(() => createRawMultiplexStream(f.stream, options())).toThrow();
        f.client.close();
        f.client.close();
        await f.client.whenClosed;
        expect(f.stream.destroyCalls).toBe(1);
        expect(f.stream.listeners('error')).toContain(f.userError);
        expect(f.stream.listenerCount('error')).toBeGreaterThan(f.baseline.get('error')!.length);
        f.stream.emit('error', new Error('late synthetic error before physical close'));
        f.stream.finishClose();
        expectRestored(f.stream, f.baseline);
        expect(() => createRawMultiplexStream(f.stream, options())).toThrow();
    });

    it.each(['abort', 'timeout'] as const)('fences a callback arriving after %s', async (mode) => {
        const f = fixture();
        const abort = new AbortController();
        const verify = vi.fn(() => true);
        const consume = vi.fn(() => 'unexpected');
        const work = f.client.transactRaw(
            request({
                signal: abort.signal,
                timeoutMs: mode === 'timeout' ? 40 : 1000,
                verifyCandidate: verify,
                consumeCandidate: consume,
            }),
        );
        await wrote(f.stream);
        f.stream.emit('data', frame(1, 17));

        if (mode === 'abort') {
            abort.abort();
        }

        expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
        await f.client.whenClosed;
        f.stream.callbacks[0]();
        f.stream.callbacks[0](new Error('late synthetic error'));
        await turn();
        expect(verify).not.toHaveBeenCalled();
        expect(consume).not.toHaveBeenCalled();
        f.stream.finishClose();
        expectRestored(f.stream, f.baseline);
    });

    it('rolls back registration when close reenters before a listener is added', async () => {
        const stream = new FakeStream();
        const userError = vi.fn();
        stream.on('error', userError);
        const baseline = new Map(events.map((event) => [event, stream.listeners(event)]));
        let triggered = false;
        stream.on('newListener', (event) => {
            if (event === 'data' && !triggered) {
                triggered = true;
                stream.finishClose();
            }
        });
        let client: ReturnType<typeof createRawMultiplexStream> | undefined;

        try {
            client = createRawMultiplexStream(stream, options());
        } catch {
            // A synchronous constructor failure is also a valid closed outcome.
        }

        expect(triggered).toBe(true);
        client?.close();
        stream.finishClose();
        await turn();
        expectRestored(stream, baseline);
    });

    it('keeps the error sink and claim through asynchronous close after partial listener installation fails', async () => {
        const stream = new FakeStream();
        const userError = vi.fn();
        stream.on('error', userError);
        const baseline = new Map(events.map((event) => [event, stream.listeners(event)]));
        const on = stream.on.bind(stream);
        stream.on = ((event: string, listener: (...args: unknown[]) => void) => {
            on(event, listener);

            if (event === 'data') {
                throw new Error('synthetic install failure');
            }

            return stream;
        }) as typeof stream.on;
        expect(() => createRawMultiplexStream(stream, options())).toThrow();
        expect(stream.destroyCalls).toBe(1);
        expect(stream.listenerCount('error')).toBeGreaterThan(baseline.get('error')!.length);
        const key = stream as unknown as Parameters<typeof claimDirectSocket>[0];
        expect(() => claimDirectSocket(key)).toThrow();
        await turn();
        expect(() => stream.emit('error', new Error('late synthetic error'))).not.toThrow();
        expect(userError).toHaveBeenCalledOnce();
        stream.finishClose();
        expectRestored(stream, baseline);
        const release = claimDirectSocket(key);
        release();
    });

    it('quarantines the claim when even the first error listener cannot be installed', async () => {
        const stream = new FakeStream();
        const userError = vi.fn();
        stream.on('error', userError);
        const baseline = new Map(events.map((event) => [event, stream.listeners(event)]));
        stream.on = (() => {
            throw new Error('synthetic install failure');
        }) as typeof stream.on;
        expect(() => createRawMultiplexStream(stream, options())).toThrow();
        const key = stream as unknown as Parameters<typeof claimDirectSocket>[0];
        await turn();
        expect(() => stream.emit('error', new Error('late synthetic error'))).not.toThrow();
        expect(userError).toHaveBeenCalledOnce();
        stream.finishClose();
        expectRestored(stream, baseline);
        expect(() => claimDirectSocket(key)).toThrow();
    });

    it('keeps the stream write buffer stable after cancellation until the physical callback', async () => {
        const f = fixture();
        const abort = new AbortController();
        const work = f.client.transactRaw(request({ signal: abort.signal }));
        await wrote(f.stream);
        const peerSnapshot = Uint8Array.from(f.stream.borrowed[0]);
        expect(peerSnapshot.some((byte) => byte !== 0)).toBe(true);
        abort.abort();
        expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
        await f.client.whenClosed;
        expect(f.stream.borrowed[0]).toEqual(peerSnapshot);
        const ownershipKey = f.stream as unknown as Parameters<typeof claimDirectSocket>[0];
        expect(() => claimDirectSocket(ownershipKey)).toThrow();
        f.stream.callbacks[0]();
        await turn();
        expect(f.stream.borrowed[0].every((byte) => byte === 0)).toBe(true);
        f.stream.finishClose();
        expectRestored(f.stream, f.baseline);
        const release = claimDirectSocket(ownershipKey);
        release();
    });

    it.each(['throw', 'error'] as const)(
        'does not commit when write synchronously calls back then %s',
        async (mode) => {
            const f = fixture();
            const consume = vi.fn(() => 'unexpected');

            f.stream.duringWrite = (callback) => {
                f.stream.emit('data', frame(1, 17));
                callback();

                if (mode === 'throw') {
                    throw new Error('after callback');
                }

                f.stream.emit('error', new Error('after callback'));
            };

            expect(
                await f.client.transactRaw(request({ consumeCandidate: consume })),
            ).toMatchObject({
                kind: 'failure',
                writeState: 'unknown',
            });
            expect(consume).not.toHaveBeenCalled();
            await f.client.whenClosed;
            f.stream.finishClose();
            expectRestored(f.stream, f.baseline);
        },
    );

    it('preserves raw-cancelled when callback then abort reenters data synchronously', async () => {
        const onPush = vi.fn();
        const f = fixture({ onPush });
        const abort = new AbortController();
        const verify = vi.fn(() => true);
        const consume = vi.fn(() => 'unexpected');

        f.stream.duringWrite = (callback) => {
            callback();
            abort.abort();
            f.stream.emit('data', frame(2, 1));
            expect(f.stream.destroyCalls).toBe(1);
        };

        const work = f.client.transactRaw(
            request({
                signal: abort.signal,
                verifyCandidate: verify,
                consumeCandidate: consume,
            }),
        );
        expect(await work).toMatchObject({
            kind: 'failure',
            code: 'raw-cancelled',
            writeState: 'unknown',
        });
        expect(await f.client.whenClosed).toMatchObject({ kind: 'local', code: 'raw-cancelled' });
        expect(verify).not.toHaveBeenCalled();
        expect(consume).not.toHaveBeenCalled();
        expect(onPush).not.toHaveBeenCalled();
        expect(await f.client.transactRaw(request())).toMatchObject({
            kind: 'failure',
            writeState: 'not-written',
        });
        f.stream.finishClose();
        expectRestored(f.stream, f.baseline);
    });

    it.each(['write', 'destroy'] as const)(
        'holds the shared claim until reentrant close unwinds from %s',
        async (method) => {
            const f = fixture();
            const key = f.stream as unknown as Parameters<typeof claimDirectSocket>[0];
            let attempted = false;

            const closeAndReenter = () => {
                f.stream.finishClose();
                expect(() => claimDirectSocket(key)).toThrow();
                attempted = true;
            };

            if (method === 'write') {
                f.stream.duringWrite = closeAndReenter;
                expect(await f.client.transactRaw(request())).toMatchObject({ kind: 'failure' });
            } else {
                f.stream.duringDestroy = closeAndReenter;
                f.client.close();
            }

            expect(attempted).toBe(true);
            await f.client.whenClosed;
            const release = claimDirectSocket(key);
            release();
            expectRestored(f.stream, f.baseline);
        },
    );

    it('handles synchronous data and callback reentry inside write', async () => {
        const push = deferred<void>();
        const f = fixture({ onPush: () => push.resolve() });

        f.stream.duringWrite = (callback) => {
            f.stream.emit('data', Buffer.concat([frame(2, 9), frame(1, 17)]));
            callback();
            callback();
        };

        const result = await f.client.transactRaw(request());
        await push.promise;
        expect(result).toMatchObject({ kind: 'response', sequence: 17 });
        expect(f.stream.writes).toHaveLength(1);
        f.client.close();
        f.stream.finishClose();
        expectRestored(f.stream, f.baseline);
    });

    it('does not wait for an async push handler before committing the response', async () => {
        const entered = deferred<void>();
        const release = deferred<void>();
        const f = fixture({
            onPush: async () => {
                entered.resolve();
                await release.promise;
            },
        });
        const work = f.client.transactRaw(request());
        await wrote(f.stream);
        f.stream.emit('data', Buffer.concat([frame(2, 4), frame(1, 17)]));
        await entered.promise;
        f.stream.callbacks[0]();
        expect(await work).toMatchObject({ kind: 'response', sequence: 17 });
        release.resolve();
        f.client.close();
        f.stream.finishClose();
        expectRestored(f.stream, f.baseline);
    });

    it.each(['verify-false', 'handler-throw'] as const)('closes on push %s', async (mode) => {
        const f = fixture({
            verifyPush: () => mode !== 'verify-false',
            onPush: () => {
                throw new Error('synthetic handler failure');
            },
        });
        f.stream.emit('data', frame(2, 1));
        expect((await f.client.whenClosed).kind).toBe(
            mode === 'verify-false' ? 'protocol-error' : 'handler-error',
        );
        f.stream.finishClose();
        expectRestored(f.stream, f.baseline);
    });

    it.each(['verify-false', 'verify-throw', 'consume-throw'] as const)(
        'closes on response %s without returning a success',
        async (mode) => {
            const f = fixture();
            const consume = vi.fn(() => {
                if (mode === 'consume-throw') {
                    throw new Error('synthetic consume error');
                }

                return 'accepted';
            });
            const work = f.client.transactRaw(
                request({
                    verifyCandidate: () => {
                        if (mode === 'verify-throw') {
                            throw new Error('synthetic verify error');
                        }

                        return mode !== 'verify-false';
                    },
                    consumeCandidate: consume,
                }),
            );
            await wrote(f.stream);
            f.stream.emit('data', frame(1, 17));
            f.stream.callbacks[0]();
            expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            await f.client.whenClosed;

            if (mode !== 'consume-throw') {
                expect(consume).not.toHaveBeenCalled();
            }

            f.stream.finishClose();
            expectRestored(f.stream, f.baseline);
        },
    );

    it('snapshots incoming peer bytes despite later mutation', async () => {
        const entered = deferred<void>();
        const resume = deferred<void>();
        const observed = deferred<Uint8Array>();
        const f = fixture({
            classify: async (bytes) => {
                entered.resolve();
                await resume.promise;
                return { kind: 'push', name: 'synthetic', id: bytes[8] };
            },
            onPush: (bytes) => observed.resolve(Uint8Array.from(bytes)),
        });
        const input = frame(2, 7);
        const original = Uint8Array.from(input);
        f.stream.emit('data', input);
        await entered.promise;
        input.fill(0);
        resume.resolve();
        expect(await observed.promise).toEqual(original);
        f.client.close();
        f.stream.finishClose();
        expectRestored(f.stream, f.baseline);
    });

    it('closes when a blocked push exceeds capacity', async () => {
        const entered = deferred<void>();
        const resume = deferred<void>();
        const f = fixture({
            maxPushFrames: 1,
            onPush: async () => {
                entered.resolve();
                await resume.promise;
            },
        });
        f.stream.emit('data', frame(2, 1));
        await entered.promise;
        f.stream.emit('data', frame(2, 2));
        expect(await f.client.whenClosed).toMatchObject({
            kind: 'protocol-error',
            code: 'push-capacity',
        });
        resume.resolve();
        f.stream.finishClose();
        expectRestored(f.stream, f.baseline);
    });
});
