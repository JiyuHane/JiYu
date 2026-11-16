import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
    createRawMultiplexClient,
    type RawMultiplexClientOptions,
    type RawMultiplexPushRoute,
} from '../../src/direct/raw-multiplex-client';
import {
    createRawMultiplexStream,
    type RawMultiplexStreamOptions,
} from '../../src/direct/raw-multiplex-stream';
import type { Sso12RawOptions } from '../../src/direct/sso12-packet-client';

// The fixture is entirely in memory. The watchdog below is bounded by microtask
// turns rather than a timer, so it also works while all timeout clocks are fake.
async function flush(): Promise<void> {
    for (let i = 0; i < 80; i++) {
        await Promise.resolve();
    }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
    let state: { value: T } | { error: unknown } | undefined;
    void promise.then(
        (value) => {
            state = { value };
        },
        (error: unknown) => {
            state = { error };
        },
    );
    await flush();

    if (!state) {
        throw new Error('synthetic microtask watchdog expired');
    }

    if ('error' in state) {
        throw state.error;
    }

    return state.value;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function frame(kind: number, id: number): Uint8Array {
    const bytes = new Uint8Array(14);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, bytes.length);
    bytes[4] = kind;
    view.setUint32(5, id);
    return bytes;
}

function join(...parts: Uint8Array[]): Uint8Array {
    const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let offset = 0;

    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }

    return result;
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

function options(overrides: Partial<RawMultiplexClientOptions> = {}): RawMultiplexClientOptions {
    return {
        uin: '0',
        initialSequence: 17,
        defaultTimeoutMs: 5000,
        maxFrameBytes: 1024,
        maxBufferedBytes: 4096,
        maxFrames: 8,
        maxPushFrames: 8,
        maxPushBytes: 4096,
        allowIncompleteFollowingFrame: true,
        write: () => {},
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

class FakeStream extends EventEmitter {
    readable = true;
    writable = true;
    destroyed = false;
    readableFlowing: boolean | null = null;
    writableLength = 0;
    writableNeedDrain = false;
    write(_bytes: Uint8Array, callback: (error?: Error | null) => void): boolean {
        callback();
        return true;
    }
    destroy(): this {
        this.destroyed = true;
        this.emit('close');
        return this;
    }
}

function streamOptions(
    overrides: Partial<RawMultiplexStreamOptions> = {},
): RawMultiplexStreamOptions {
    const { write: _write, ...rest } = options();
    return { ...rest, exclusiveConnected: true, maxWriteBufferBytes: 4096, ...overrides };
}

// Restore the fake clock even when a constructor fails before its test's body.
function makeClient(config: RawMultiplexClientOptions) {
    try {
        return createRawMultiplexClient(config);
    } catch (error) {
        vi.useRealTimers();
        throw error;
    }
}

function makeStream(stream: FakeStream, config: RawMultiplexStreamOptions) {
    try {
        return createRawMultiplexStream(stream, config);
    } catch (error) {
        vi.useRealTimers();
        throw error;
    }
}

const timeoutReason = { kind: 'protocol-error', code: 'frame-assembly-timeout' };

describe('raw multiplex frame assembly deadline (synthetic memory only)', () => {
    it.each(['omitted', 'undefined'] as const)('%s disables the timer', async (mode) => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        const client = makeClient(
            options(mode === 'undefined' ? { frameAssemblyTimeoutMs: undefined } : {}),
        );

        try {
            expect(vi.getTimerCount()).toBe(0);
            client.feed(frame(2, 1).subarray(0, 1));
            expect(vi.getTimerCount()).toBe(0);
            vi.advanceTimersByTime(100000);
            await flush();
            expect(client.closed).toBe(false);
        } finally {
            client.close();
            vi.useRealTimers();
        }
    });

    it.each([0, -1, 1.5, NaN, Infinity, 0x80000000, '100', null, {}, true])(
        'rejects invalid deadline %# before returning a client',
        (value) => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });

            try {
                const write = vi.fn();
                expect(() =>
                    createRawMultiplexClient(
                        options({
                            write,
                            frameAssemblyTimeoutMs: value as number,
                        }),
                    ),
                ).toThrowError(new Error('invalid multiplex configuration'));
                expect(write).not.toHaveBeenCalled();
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                vi.useRealTimers();
            }
        },
    );

    it('accepts the maximum timer value without advancing the clock', () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });

        try {
            const client = makeClient(options({ frameAssemblyTimeoutMs: 0x7fffffff }));
            client.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([1, 2, 3, 4, 7])(
        'expires from the first byte with %i bytes assembled; further bytes do not renew',
        async (split) => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
            const verify = vi.fn(() => true);
            const consume = vi.fn(() => 'accepted');
            const client = makeClient(options({ frameAssemblyTimeoutMs: 100 }));

            try {
                const result = client.transactRaw(
                    request({ verifyCandidate: verify, consumeCandidate: consume }),
                );
                await flush();
                const response = frame(1, 17);
                client.feed(response.subarray(0, 1));
                vi.advanceTimersByTime(20);

                if (split > 1) {
                    client.feed(response.subarray(1, split));
                }

                vi.advanceTimersByTime(30);
                client.feed(response.subarray(split, split + 1));
                vi.advanceTimersByTime(49);
                await flush();
                expect(client.closed).toBe(false);
                vi.advanceTimersByTime(1);
                expect(await bounded(client.whenClosed)).toEqual(timeoutReason);
                expect(await bounded(result)).toMatchObject({
                    kind: 'failure',
                    code: 'frame-assembly-timeout',
                    writeState: 'unknown',
                });
                expect(verify).not.toHaveBeenCalled();
                expect(consume).not.toHaveBeenCalled();
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                client.close();
                vi.useRealTimers();
            }
        },
    );

    it('keeps the original deadline after success and across a new written transaction', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        const calls: string[] = [];
        const client = makeClient(options({ frameAssemblyTimeoutMs: 100 }));

        try {
            const first = client.transactRaw(
                request({
                    verifyCandidate: () => {
                        calls.push('verify');
                        return true;
                    },
                    consumeCandidate: () => {
                        calls.push('consume');
                        return 'first';
                    },
                }),
            );
            await flush();
            const following = frame(2, 42);
            client.feed(join(frame(1, 17), following.subarray(0, 1)));
            const success = await bounded(first);
            expect(success).toMatchObject({
                kind: 'response',
                sequence: 17,
                value: 'first',
                writeState: 'written',
            });
            expect(calls).toEqual(['verify', 'consume']);
            vi.advanceTimersByTime(70);
            const second = client.transactRaw(request());
            await flush();
            client.feed(following.subarray(1, 2));
            vi.advanceTimersByTime(29);
            await flush();
            expect(client.closed).toBe(false);
            vi.advanceTimersByTime(1);
            expect(await bounded(client.whenClosed)).toEqual(timeoutReason);
            expect(await bounded(second)).toMatchObject({
                kind: 'failure',
                code: 'frame-assembly-timeout',
                writeState: 'unknown',
            });
            expect(success).toMatchObject({ kind: 'response', value: 'first' });
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            client.close();
            vi.useRealTimers();
        }
    });

    it('settles a held builder as not-written, and its late continuation cannot write', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        const gate = deferred<void>();
        const writes = vi.fn();
        const builderStages: string[] = [];
        const client = makeClient(options({ frameAssemblyTimeoutMs: 100, write: writes }));

        try {
            let settled = false;
            const result = client.transactRaw(
                request({
                    buildRequest: async ({ sequence }) => {
                        builderStages.push('entered');
                        await gate.promise;
                        builderStages.push('continued');
                        return { frame: frame(1, sequence), context: null };
                    },
                }),
            );
            void result.then(() => {
                settled = true;
            });
            client.feed(frame(2, 3).subarray(0, 1));
            expect(builderStages).toEqual(['entered']);
            expect(client.closed).toBe(false);
            expect(vi.getTimerCount()).toBe(2);
            vi.advanceTimersByTime(99);
            await flush();
            expect(client.closed).toBe(false);
            expect(settled).toBe(false);
            expect(vi.getTimerCount()).toBe(2);
            vi.advanceTimersByTime(1);
            expect(await bounded(client.whenClosed)).toEqual(timeoutReason);
            expect(await bounded(result)).toMatchObject({
                kind: 'failure',
                code: 'frame-assembly-timeout',
                writeState: 'not-written',
            });
            gate.resolve();
            await flush();
            expect(builderStages).toEqual(['entered', 'continued']);
            expect(writes).not.toHaveBeenCalled();
        } finally {
            gate.resolve();
            client.close();
            vi.useRealTimers();
        }
    });

    it('releases a completed frame timer, copies borrowed input, and starts the next deadline independently', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        const verified: number[][] = [];
        const pushed: number[][] = [];
        const client = makeClient(
            options({
                frameAssemblyTimeoutMs: 100,
                verifyPush: (bytes) => {
                    verified.push(Array.from(bytes));
                    return true;
                },
                onPush: (bytes, _route: RawMultiplexPushRoute) => {
                    pushed.push(Array.from(bytes));
                },
            }),
        );

        try {
            const original = frame(2, 42);
            const expected = Array.from(original);
            const prefix = original.slice(0, 4);
            const tail = original.slice(4);
            client.feed(prefix);
            expect(Array.from(prefix)).toEqual(expected.slice(0, 4));
            prefix.fill(0xee);
            vi.advanceTimersByTime(90);
            client.feed(tail);
            expect(Array.from(tail)).toEqual(expected.slice(4));
            tail.fill(0xee);
            await flush();
            expect(verified).toEqual([expected]);
            expect(pushed).toEqual([expected]);
            expect(vi.getTimerCount()).toBe(0);
            client.feed(frame(2, 43).subarray(0, 1));
            vi.advanceTimersByTime(10);
            await flush();
            expect(client.closed).toBe(false);
            vi.advanceTimersByTime(89);
            await flush();
            expect(client.closed).toBe(false);
            vi.advanceTimersByTime(1);
            expect(await bounded(client.whenClosed)).toEqual(timeoutReason);
            expect(verified).toEqual([expected]);
            expect(pushed).toEqual([expected]);
        } finally {
            client.close();
            vi.useRealTimers();
        }
    });

    it('handles two complete frames in one chunk without a stale timer', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        const verified: number[] = [];
        const pushed: number[] = [];
        const client = makeClient(
            options({
                frameAssemblyTimeoutMs: 100,
                verifyPush: (_bytes, route) => {
                    verified.push(route.id);
                    return true;
                },
                onPush: (_bytes, route) => {
                    pushed.push(route.id);
                },
            }),
        );

        try {
            client.feed(join(frame(2, 1), frame(2, 2)));
            await flush();
            expect(verified).toEqual([1, 2]);
            expect(pushed).toEqual([1, 2]);
            expect(vi.getTimerCount()).toBe(0);
            vi.advanceTimersByTime(200);
            await flush();
            expect(client.closed).toBe(false);
        } finally {
            client.close();
            vi.useRealTimers();
        }
    });

    it.each(['close', 'end', 'malformed'] as const)(
        '%s cancels the pending timer and prevents late delivery',
        async (mode) => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
            const push = vi.fn();
            const client = makeClient(options({ frameAssemblyTimeoutMs: 100, onPush: push }));

            try {
                client.feed(Uint8Array.of(0));

                if (mode === 'close') {
                    client.close();
                } else if (mode === 'end') {
                    client.end();
                } else {
                    client.feed(Uint8Array.of(0, 0, 13));
                }

                const reason = await bounded(client.whenClosed);
                expect(reason).toEqual(
                    mode === 'close'
                        ? { kind: 'local', code: 'local-close' }
                        : {
                              kind: 'protocol-error',
                              code: mode === 'end' ? 'truncated-stream' : 'invalid-stream',
                          },
                );
                expect(vi.getTimerCount()).toBe(0);
                vi.advanceTimersByTime(200);
                await flush();
                expect(await bounded(client.whenClosed)).toEqual(reason);
                expect(push).not.toHaveBeenCalled();
            } finally {
                client.close();
                vi.useRealTimers();
            }
        },
    );

    it('checks the monotonic deadline when a tail arrives before the timer callback executes', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        let now = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
        const verify = vi.fn(() => true);
        const push = vi.fn();
        const client = makeClient(
            options({ frameAssemblyTimeoutMs: 100, verifyPush: verify, onPush: push }),
        );

        try {
            const data = frame(2, 4);
            client.feed(data.subarray(0, 1));
            expect(vi.getTimerCount()).toBe(1);
            now = 100; // Deliberately do not advance the fake timer queue.
            client.feed(data.subarray(1));
            expect(await bounded(client.whenClosed)).toEqual(timeoutReason);
            await flush();
            expect(verify).not.toHaveBeenCalled();
            expect(push).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            client.close();
            clock.mockRestore();
            vi.useRealTimers();
        }
    });

    it('fences a new transaction when performance time has expired before its timer runs', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        let now = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
        const writes = vi.fn();
        const client = makeClient(options({ frameAssemblyTimeoutMs: 100, write: writes }));

        try {
            client.feed(frame(2, 8).subarray(0, 1));
            now = 100;
            const later = client.transactRaw(request());
            expect(await bounded(client.whenClosed)).toEqual(timeoutReason);
            expect(await bounded(later)).toMatchObject({
                kind: 'failure',
                writeState: 'not-written',
            });
            expect(writes).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            client.close();
            clock.mockRestore();
            vi.useRealTimers();
        }
    });

    it('fences late verification before consume when the timer callback is delayed', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        let now = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
        const gate = deferred<boolean>();
        const calls: string[] = [];
        const client = makeClient(options({ frameAssemblyTimeoutMs: 100 }));

        try {
            const result = client.transactRaw(
                request({
                    verifyCandidate: () => {
                        calls.push('verify');
                        return gate.promise;
                    },
                    consumeCandidate: () => {
                        calls.push('consume');
                        return 'accepted';
                    },
                }),
            );
            await flush();
            client.feed(join(frame(1, 17), frame(2, 9).subarray(0, 1)));
            await flush();
            expect(calls).toEqual(['verify']);
            now = 100;
            gate.resolve(true);
            expect(await bounded(client.whenClosed)).toEqual(timeoutReason);
            expect(await bounded(result)).toMatchObject({
                kind: 'failure',
                code: 'frame-assembly-timeout',
                writeState: 'unknown',
            });
            expect(calls).toEqual(['verify']);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            gate.resolve(true);
            client.close();
            clock.mockRestore();
            vi.useRealTimers();
        }
    });

    it.each(['classify', 'verifyPush', 'onPush'] as const)(
        'gives an expired assembly deadline priority over a throwing %s callback',
        async (stage) => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
            let now = 0;
            const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
            const reached: string[] = [];
            const client = makeClient(
                options({
                    frameAssemblyTimeoutMs: 100,
                    classify: () => {
                        reached.push('classify');

                        if (stage === 'classify') {
                            now = 100;
                            throw new Error('synthetic classifier error');
                        }

                        return { kind: 'push', name: 'synthetic', id: 20 };
                    },
                    verifyPush: () => {
                        reached.push('verifyPush');

                        if (stage === 'verifyPush') {
                            now = 100;
                            throw new Error('synthetic verify error');
                        }

                        return true;
                    },
                    onPush: () => {
                        reached.push('onPush');
                        now = 100;
                        throw new Error('synthetic push error');
                    },
                }),
            );

            try {
                client.feed(join(frame(2, 20), frame(2, 21).subarray(0, 1)));
                expect(await bounded(client.whenClosed)).toEqual(timeoutReason);
                expect(reached).toEqual(
                    stage === 'classify'
                        ? ['classify']
                        : stage === 'verifyPush'
                          ? ['classify', 'verifyPush']
                          : ['classify', 'verifyPush', 'onPush'],
                );
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                client.close();
                clock.mockRestore();
                vi.useRealTimers();
            }
        },
    );

    it('preserves handler-error when a callback throws before the assembly deadline', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        let now = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
        const reached: string[] = [];
        const client = makeClient(
            options({
                frameAssemblyTimeoutMs: 100,
                classify: () => {
                    reached.push('classify');
                    now = 99;
                    throw new Error('synthetic classifier error');
                },
            }),
        );

        try {
            client.feed(join(frame(2, 20), frame(2, 21).subarray(0, 1)));
            expect(await bounded(client.whenClosed)).toEqual({
                kind: 'handler-error',
                code: 'frame-handler-failed',
            });
            expect(reached).toEqual(['classify']);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            client.close();
            clock.mockRestore();
            vi.useRealTimers();
        }
    });

    it('reports timer scheduling failure as a local error without exposing its details', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => {
            throw new Error('private synthetic timer detail');
        });
        const verify = vi.fn(() => true);
        const push = vi.fn();
        const client = makeClient(
            options({ frameAssemblyTimeoutMs: 100, verifyPush: verify, onPush: push }),
        );

        try {
            client.feed(frame(2, 12).subarray(0, 1));
            expect(timer).toHaveBeenCalledOnce();
            expect(await bounded(client.whenClosed)).toEqual({
                kind: 'local',
                code: 'frame-assembly-timer-failed',
            });
            expect(verify).not.toHaveBeenCalled();
            expect(push).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            client.close();
            timer.mockRestore();
            vi.useRealTimers();
        }
    });

    it('rearms an early timer without refreshing the absolute deadline', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        let now = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
        const client = makeClient(options({ frameAssemblyTimeoutMs: 100 }));

        try {
            client.feed(frame(2, 11).subarray(0, 1));
            expect(vi.getTimerCount()).toBe(1);
            // Advance the timer queue while the independently controlled monotonic
            // clock remains at zero: this callback must rearm, not close.
            vi.advanceTimersByTime(100);
            await flush();
            expect(client.closed).toBe(false);
            expect(vi.getTimerCount()).toBe(1);
            now = 99;
            vi.advanceTimersByTime(100);
            await flush();
            expect(client.closed).toBe(false);
            expect(vi.getTimerCount()).toBe(1);
            // The remaining delay is one millisecond, based on the original
            // deadline, not a fresh 100 ms interval from the early callback.
            now = 100;
            vi.advanceTimersByTime(1);
            expect(await bounded(client.whenClosed)).toEqual(timeoutReason);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            client.close();
            clock.mockRestore();
            vi.useRealTimers();
        }
    });

    it('fences publication when the final clock sample reaches the deadline', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        let tailPhase = false;
        let tailSamples = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
            if (tailPhase) {
                tailSamples++;
                return tailSamples >= 5 ? 100 : 0;
            }

            return 0;
        });
        const classify = vi.fn(() => ({ kind: 'push' as const, name: 'synthetic', id: 10 }));
        const verify = vi.fn(() => true);
        const push = vi.fn();
        const client = makeClient(
            options({ frameAssemblyTimeoutMs: 100, classify, verifyPush: verify, onPush: push }),
        );

        try {
            const pending = client.transactRaw(request());
            await flush();
            const data = frame(2, 10);
            client.feed(data.subarray(0, 1));
            // Tail feed samples at entry, loop, completed prefix, completed body,
            // and finally after incoming.push; only the last sample reaches 100.
            tailPhase = true;
            client.feed(data.subarray(1));
            expect(tailSamples).toBe(5);
            expect(await bounded(client.whenClosed)).toEqual(timeoutReason);
            expect(await bounded(pending)).toMatchObject({
                kind: 'failure',
                code: 'frame-assembly-timeout',
                writeState: 'unknown',
            });
            await flush();
            expect(classify).not.toHaveBeenCalled();
            expect(verify).not.toHaveBeenCalled();
            expect(push).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
            expect(() => client.feed(data)).toThrow('closed');
        } finally {
            client.close();
            clock.mockRestore();
            vi.useRealTimers();
        }
    });

    it('passes the deadline through the in-memory stream adapter', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        const stream = new FakeStream();
        const push = vi.fn();
        const client = makeStream(
            stream,
            streamOptions({ frameAssemblyTimeoutMs: 100, onPush: push }),
        );

        try {
            stream.emit('data', frame(2, 5).subarray(0, 1));
            vi.advanceTimersByTime(99);
            await flush();
            expect(client.closed).toBe(false);
            vi.advanceTimersByTime(1);
            expect(await bounded(client.whenClosed)).toEqual(timeoutReason);
            expect(stream.destroyed).toBe(true);
            expect(push).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            client.close();
            vi.useRealTimers();
        }
    });
});
