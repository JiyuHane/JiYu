import { describe, expect, it, vi } from 'vitest';
import {
    createRawMultiplexClient,
    type RawMultiplexClientOptions,
    type RawMultiplexRoute,
} from '../../src/direct/raw-multiplex-client';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import { guardBorrowedTransport } from '../../src/direct/guard-raw-transaction';
import type { Sso12RawIdentity, Sso12RawOptions } from '../../src/direct/sso12-packet-client';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

// These bytes and route rules are synthetic; classification does not authenticate a peer.
function frame(kind: number, id: number): Buffer {
    const bytes = Buffer.alloc(14);
    bytes.writeUInt32BE(bytes.length, 0);
    bytes[4] = kind;
    bytes.writeUInt32BE(id, 5);
    return bytes;
}

function route(bytes: Uint8Array): RawMultiplexRoute {
    const id = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(5);
    return bytes[4] === 1
        ? { kind: 'response', sequence: id }
        : { kind: 'push', name: 'synthetic', id };
}

function request(
    overrides: Partial<Sso12RawOptions<null, string>> = {},
): Sso12RawOptions<null, string> {
    return {
        buildRequest: ({ sequence }) => ({ frame: frame(1, sequence), context: null }),
        verifyCandidate: () => true,
        consumeCandidate: () => 'accepted',
        ...overrides,
    };
}

function fixture(overrides: Partial<RawMultiplexClientOptions> = {}) {
    const wrote = deferred<void>();
    const classified: number[] = [];
    const delivered: number[] = [];
    const client = createRawMultiplexClient({
        uin: '123',
        initialSequence: 17,
        defaultTimeoutMs: 2000,
        maxFrameBytes: 1024,
        maxBufferedBytes: 4096,
        maxFrames: 8,
        maxPushFrames: 8,
        maxPushBytes: 4096,
        write: () => wrote.resolve(),
        classify: (bytes) => {
            classified.push(bytes[4]);
            return route(bytes);
        },
        verifyPush: () => true,
        onPush: (_bytes, item) => {
            delivered.push(item.id);
        },
        ...overrides,
    });
    return { client, wrote, classified, delivered };
}

describe('raw response barrier with in-memory synthetic frames', () => {
    it('waits for write, verify and private stage before classifying coalesced following frames', async () => {
        const writeGate = deferred<void>();
        const wrote = deferred<void>();
        const verifyGate = deferred<boolean>();
        const verifyEntered = deferred<void>();
        const stageGate = deferred<void>();
        const stageEntered = deferred<void>();
        const stage = { ready: false };
        const events: string[] = [];
        const hold = vi.fn((identity: Sso12RawIdentity) => {
            expect(identity).toEqual({ uin: '123', sequence: 17 });
            expect(Object.isFrozen(identity)).toBe(true);
            return true;
        });
        const f = fixture({
            holdFollowingFrames: hold,
            write: () => {
                wrote.resolve();
                return writeGate.promise;
            },
            classify: (bytes) => {
                if (bytes[4] === 1) {
                    events.push('candidate');
                } else {
                    expect(stage.ready).toBe(true);
                    events.push(`classify:${bytes[8]}`);
                }

                return route(bytes);
            },
            onPush: (_bytes, item) => {
                events.push(`push:${item.id}`);
            },
        });
        const lease = createRawSessionBroker(f.client, {
            trustedSuccessQuiescence: true,
            isUsable: () => !f.client.closed,
        }).acquire({ deadline: performance.now() + 5000 });
        const verify = vi.fn(() => {
            events.push('verify');
            verifyEntered.resolve();
            return verifyGate.promise;
        });
        const consume = vi.fn(async () => {
            events.push('consume');
            stageEntered.resolve();
            await stageGate.promise;
            stage.ready = true;
            events.push('staged');
            return 'accepted';
        });
        const work = guardBorrowedTransport<null, string>(lease)(
            request({ verifyCandidate: verify, consumeCandidate: consume }),
        );

        try {
            await wrote.promise;
            f.client.feed(Buffer.concat([frame(1, 17), frame(2, 41), frame(2, 42)]));
            await turn();
            expect(events).toEqual(['candidate']);
            expect(hold).toHaveBeenCalledOnce();
            expect(verify).not.toHaveBeenCalled();
            expect(consume).not.toHaveBeenCalled();
            writeGate.resolve();
            await verifyEntered.promise;
            await turn();
            expect(events).toEqual(['candidate', 'verify']);
            expect(consume).not.toHaveBeenCalled();
            verifyGate.resolve(true);
            await stageEntered.promise;
            await turn();
            expect(events).toEqual(['candidate', 'verify', 'consume']);
            stageGate.resolve();
            expect(await work).toEqual({
                kind: 'response',
                sequence: 17,
                value: 'accepted',
                writeState: 'written',
            });
            await turn();
            expect(events).toEqual([
                'candidate',
                'verify',
                'consume',
                'staged',
                'classify:41',
                'push:41',
                'classify:42',
                'push:42',
            ]);
            lease.release();
            expect(await lease.whenClosed).toBe('released');
        } finally {
            writeGate.resolve();
            verifyGate.resolve(true);
            stageGate.resolve();
            lease.release();
            f.client.close();
        }
    });

    it.each(['absent', 'false'] as const)(
        'keeps following push concurrent with a pending write when policy is %s',
        async (mode) => {
            const writeGate = deferred<void>();
            const wrote = deferred<void>();
            const pushed = deferred<void>();
            const verify = vi.fn(() => true);
            const consume = vi.fn(() => 'accepted');
            const f = fixture({
                ...(mode === 'false' ? { holdFollowingFrames: () => false } : {}),
                write: () => {
                    wrote.resolve();
                    return writeGate.promise;
                },
                onPush: () => pushed.resolve(),
            });
            const work = f.client.transactRaw(
                request({ verifyCandidate: verify, consumeCandidate: consume }),
            );

            try {
                await wrote.promise;
                f.client.feed(Buffer.concat([frame(1, 17), frame(2, 1)]));
                await pushed.promise;
                expect(verify).not.toHaveBeenCalled();
                expect(consume).not.toHaveBeenCalled();
                writeGate.resolve();
                expect(await work).toMatchObject({ kind: 'response', value: 'accepted' });
            } finally {
                writeGate.resolve();
                f.client.close();
            }
        },
    );

    it.each([
        'throw',
        'nonboolean',
        'mismatch',
        'invalid-route',
        'route-accessor',
        'route-proxy',
    ] as const)(
        'fails closed for %s without classifying or dispatching the next frame',
        async (mode) => {
            const hold = vi.fn(() => {
                if (mode === 'throw') {
                    throw Error('synthetic policy failure');
                }

                return (mode === 'nonboolean' ? 1 : true) as boolean;
            });
            const getter = vi.fn(() => 'response');
            const classify = vi.fn((bytes: Uint8Array) => {
                if (mode === 'route-accessor') {
                    return Object.defineProperty({ sequence: 17 }, 'kind', {
                        get: getter,
                    }) as RawMultiplexRoute;
                }

                if (mode === 'route-proxy') {
                    return new Proxy({ kind: 'response' as const, sequence: 17 }, {});
                }

                if (mode === 'invalid-route') {
                    return { kind: 'response', sequence: 17, extra: true } as RawMultiplexRoute;
                }

                return route(bytes);
            });
            const onPush = vi.fn();
            const verify = vi.fn(() => true);
            const f = fixture({ holdFollowingFrames: hold, classify, onPush });
            const work = f.client.transactRaw(request({ verifyCandidate: verify }));

            try {
                await f.wrote.promise;
                f.client.feed(
                    Buffer.concat([frame(1, mode === 'mismatch' ? 18 : 17), frame(2, 9)]),
                );
                expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
                await f.client.whenClosed;
                await turn();
                expect(classify).toHaveBeenCalledOnce();
                expect(onPush).not.toHaveBeenCalled();
                expect(verify).not.toHaveBeenCalled();

                expect(getter).not.toHaveBeenCalled();

                if (
                    mode === 'mismatch' ||
                    mode === 'invalid-route' ||
                    mode === 'route-accessor' ||
                    mode === 'route-proxy'
                ) {
                    expect(hold).not.toHaveBeenCalled();
                } else {
                    expect(hold).toHaveBeenCalledOnce();
                }
            } finally {
                f.client.close();
            }
        },
    );

    it('observes a rejected native policy promise without reading its own throwing then getter', async () => {
        const late = deferred<boolean>();
        const getter = vi.fn(() => {
            throw Error('synthetic then getter');
        });
        Object.defineProperty(late.promise, 'then', { get: getter });
        const unhandled: unknown[] = [];

        const listener = (reason: unknown) => {
            unhandled.push(reason);
        };

        process.on('unhandledRejection', listener);
        const verify = vi.fn(() => true);
        const f = fixture({ holdFollowingFrames: () => late.promise as unknown as boolean });
        const work = f.client.transactRaw(request({ verifyCandidate: verify }));

        try {
            await f.wrote.promise;
            f.client.feed(Buffer.concat([frame(1, 17), frame(2, 9)]));
            expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            await f.client.whenClosed;
            expect(getter).not.toHaveBeenCalled();
            expect(verify).not.toHaveBeenCalled();
            late.reject(Error('late synthetic policy rejection'));
            await turn();
            await turn();
            expect(getter).not.toHaveBeenCalled();
            expect(unhandled).toEqual([]);
            expect(f.classified).toEqual([1]);
            expect(f.delivered).toEqual([]);
        } finally {
            late.resolve(true);
            f.client.close();
            process.off('unhandledRejection', listener);
        }
    });

    it.each(['abort', 'close', 'timeout'] as const)(
        'does not restart a held queue after %s while write is pending',
        async (mode) => {
            const abort = new AbortController();
            const gate = deferred<void>();
            const wrote = deferred<void>();
            const verify = vi.fn(() => true);
            const consume = vi.fn(() => 'accepted');
            const f = fixture({
                holdFollowingFrames: () => true,
                write: () => {
                    wrote.resolve();
                    return gate.promise;
                },
            });
            const work = f.client.transactRaw(
                request({
                    signal: abort.signal,
                    timeoutMs: mode === 'timeout' ? 80 : 2000,
                    verifyCandidate: verify,
                    consumeCandidate: consume,
                }),
            );

            try {
                await wrote.promise;
                f.client.feed(Buffer.concat([frame(1, 17), frame(2, 9)]));
                await turn();
                expect(f.classified).toEqual([1]);

                if (mode === 'abort') {
                    abort.abort();
                } else if (mode === 'close') {
                    f.client.close();
                }

                expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
                await f.client.whenClosed;
                gate.resolve();
                await turn();
                expect(f.classified).toEqual([1]);
                expect(f.delivered).toEqual([]);
                expect(verify).not.toHaveBeenCalled();
                expect(consume).not.toHaveBeenCalled();
            } finally {
                gate.resolve();
                f.client.close();
            }
        },
    );

    it.each(['verify', 'consume'] as const)(
        'fences a late %s worker after cancellation',
        async (phase) => {
            const abort = new AbortController();
            const entered = deferred<void>();
            const gate = deferred<void>();
            const consume = vi.fn(async () => {
                if (phase === 'consume') {
                    entered.resolve();
                    await gate.promise;
                }

                return 'accepted';
            });
            const f = fixture({ holdFollowingFrames: () => true });
            const work = f.client.transactRaw(
                request({
                    signal: abort.signal,
                    verifyCandidate: async () => {
                        if (phase === 'verify') {
                            entered.resolve();
                            await gate.promise;
                        }

                        return true;
                    },
                    consumeCandidate: consume,
                }),
            );

            try {
                await f.wrote.promise;
                f.client.feed(Buffer.concat([frame(1, 17), frame(2, 9)]));
                await entered.promise;
                expect(f.classified).toEqual([1]);
                abort.abort();
                expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
                gate.resolve();
                await turn();
                expect(f.classified).toEqual([1]);
                expect(f.delivered).toEqual([]);
                expect(consume).toHaveBeenCalledTimes(phase === 'verify' ? 0 : 1);
            } finally {
                gate.resolve();
                f.client.close();
            }
        },
    );

    it.each(['verify-false', 'verify-reject', 'consume-reject'] as const)(
        'does not dispatch held frames when the response worker ends with %s',
        async (mode) => {
            const gate = deferred<void>();
            const entered = deferred<void>();
            const f = fixture({ holdFollowingFrames: () => true });
            const work = f.client.transactRaw(
                request({
                    verifyCandidate: async () => {
                        if (mode !== 'consume-reject') {
                            entered.resolve();
                            await gate.promise;

                            if (mode === 'verify-reject') {
                                throw Error('synthetic verify rejection');
                            }

                            return false;
                        }

                        return true;
                    },
                    consumeCandidate: async () => {
                        entered.resolve();
                        await gate.promise;
                        throw Error('synthetic consume rejection');
                    },
                }),
            );

            try {
                await f.wrote.promise;
                f.client.feed(Buffer.concat([frame(1, 17), frame(2, 9)]));
                await entered.promise;
                expect(f.classified).toEqual([1]);
                gate.resolve();
                expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
                await f.client.whenClosed;
                await turn();
                expect(f.classified).toEqual([1]);
                expect(f.delivered).toEqual([]);
            } finally {
                gate.resolve();
                f.client.close();
            }
        },
    );

    it.each(['frames', 'bytes'] as const)(
        'charges fragmented and coalesced held frames to the %s budget',
        async (budget) => {
            const gate = deferred<void>();
            const wrote = deferred<void>();
            const f = fixture({
                holdFollowingFrames: () => true,
                maxFrames: budget === 'frames' ? 2 : 8,
                maxBufferedBytes: budget === 'bytes' ? 28 : 4096,
                write: () => {
                    wrote.resolve();
                    return gate.promise;
                },
            });
            const work = f.client.transactRaw(request());

            try {
                await wrote.promise;
                f.client.feed(frame(1, 17));
                await turn();
                const following = Buffer.concat([frame(2, 1), frame(2, 2)]);
                f.client.feed(following.subarray(0, 2));
                f.client.feed(following.subarray(2, 14));
                expect(f.client.closed).toBe(false);
                f.client.feed(following.subarray(14, 18));
                expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
                expect(await f.client.whenClosed).toMatchObject({
                    kind: 'protocol-error',
                    code: 'invalid-stream',
                });
                gate.resolve();
                await turn();
                expect(f.classified).toEqual([1]);
                expect(f.delivered).toEqual([]);
            } finally {
                gate.resolve();
                f.client.close();
            }
        },
    );

    it('handles synchronous policy reentry without bypassing the held queue or issuing a second write', async () => {
        const gate = deferred<void>();
        const wrote = deferred<void>();
        let client!: ReturnType<typeof createRawMultiplexClient>;
        let nested!: ReturnType<typeof client.transactRaw>;
        const f = fixture({
            holdFollowingFrames: () => {
                client.feed(frame(2, 2));
                nested = client.transactRaw(request());
                return true;
            },
            write: () => {
                wrote.resolve();
                return gate.promise;
            },
        });
        client = f.client;
        const work = client.transactRaw(request());

        try {
            await wrote.promise;
            client.feed(Buffer.concat([frame(1, 17), frame(2, 1)]));
            await turn();
            expect(await nested).toMatchObject({ kind: 'failure', code: 'busy' });
            expect(f.classified).toEqual([1]);
            gate.resolve();
            expect(await work).toMatchObject({ kind: 'response' });
            await turn();
            expect(f.delivered).toEqual([1, 2]);
        } finally {
            gate.resolve();
            client.close();
        }
    });

    it.each(['complete', 'partial'] as const)(
        'ends held queues as %s stream without waking after the write',
        async (mode) => {
            const gate = deferred<void>();
            const wrote = deferred<void>();
            const f = fixture({
                holdFollowingFrames: () => true,
                write: () => {
                    wrote.resolve();
                    return gate.promise;
                },
            });
            const work = f.client.transactRaw(request());

            try {
                await wrote.promise;
                const following = frame(2, 9);
                f.client.feed(Buffer.concat([frame(1, 17), following]));
                await turn();

                if (mode === 'partial') {
                    f.client.feed(frame(2, 10).subarray(0, 3));
                }

                f.client.end();
                expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
                expect(await f.client.whenClosed).toMatchObject(
                    mode === 'partial'
                        ? { kind: 'protocol-error', code: 'truncated-stream' }
                        : { kind: 'remote', code: 'remote-end' },
                );
                gate.resolve();
                await turn();
                expect(f.classified).toEqual([1]);
                expect(f.delivered).toEqual([]);
            } finally {
                gate.resolve();
                f.client.close();
            }
        },
    );

    it('isolates same-sequence generations across independent account clients', async () => {
        const gateA = deferred<void>();
        const gateB = deferred<void>();
        const gateNew = deferred<void>();
        const enteredA = deferred<void>();
        const enteredB = deferred<void>();
        const enteredNew = deferred<void>();
        const abort = new AbortController();
        const a = fixture({ uin: '111', holdFollowingFrames: () => true });
        const b = fixture({ uin: '222', holdFollowingFrames: () => true });
        const replacement = fixture({ uin: '111', holdFollowingFrames: () => true });
        const workA = a.client.transactRaw(
            request({
                signal: abort.signal,
                consumeCandidate: async () => {
                    enteredA.resolve();
                    await gateA.promise;
                    return 'a';
                },
            }),
        );
        const workB = b.client.transactRaw(
            request({
                consumeCandidate: async () => {
                    enteredB.resolve();
                    await gateB.promise;
                    return 'b';
                },
            }),
        );

        try {
            await Promise.all([a.wrote.promise, b.wrote.promise]);
            a.client.feed(Buffer.concat([frame(1, 17), frame(2, 11)]));
            b.client.feed(Buffer.concat([frame(1, 17), frame(2, 22)]));
            await Promise.all([enteredA.promise, enteredB.promise]);
            abort.abort();
            expect(await workA).toMatchObject({ kind: 'failure' });
            const workNew = replacement.client.transactRaw(
                request({
                    consumeCandidate: async () => {
                        enteredNew.resolve();
                        await gateNew.promise;
                        return 'replacement';
                    },
                }),
            );
            await replacement.wrote.promise;
            replacement.client.feed(Buffer.concat([frame(1, 17), frame(2, 33)]));
            await enteredNew.promise;
            gateA.resolve();
            await turn();
            expect(a.delivered).toEqual([]);
            expect(b.classified).toEqual([1]);
            expect(replacement.classified).toEqual([1]);
            gateB.resolve();
            expect(await workB).toMatchObject({ kind: 'response', sequence: 17, value: 'b' });
            expect(replacement.classified).toEqual([1]);
            gateNew.resolve();
            expect(await workNew).toMatchObject({
                kind: 'response',
                sequence: 17,
                value: 'replacement',
            });
            await turn();
            expect(a.classified).toEqual([1]);
            expect(b.delivered).toEqual([22]);
            expect(replacement.delivered).toEqual([33]);
        } finally {
            gateA.resolve();
            gateB.resolve();
            gateNew.resolve();
            a.client.close();
            b.client.close();
            replacement.client.close();
        }
    });
});
