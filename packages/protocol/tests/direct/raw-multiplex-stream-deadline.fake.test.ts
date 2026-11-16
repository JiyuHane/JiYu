import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createRawMultiplexStream,
    type RawMultiplexStreamOptions,
} from '../../src/direct/raw-multiplex-stream';
import type { Sso12RawOptions } from '../../src/direct/sso12-packet-client';

// Synthetic in-memory byte stream: events never involve a network connection.
class FakeStream extends EventEmitter {
    readable = true;
    writable = true;
    destroyed = false;
    readableFlowing: boolean | null = null;
    writableLength = 0;
    writableNeedDrain = false;
    writes: Uint8Array[] = [];
    destroyCalls = 0;

    write(bytes: Uint8Array, callback: (error?: Error | null) => void): boolean {
        this.writes.push(Uint8Array.from(bytes));
        callback();
        return true;
    }

    destroy(): this {
        this.destroyCalls++;
        this.destroyed = true;
        this.readable = false;
        this.writable = false;
        return this;
    }

    finishClose(): void {
        this.emit('close');
    }
}

function frame(kind: number, id: number): Uint8Array {
    const bytes = Buffer.alloc(14);
    bytes.writeUInt32BE(bytes.length, 0);
    bytes[4] = kind;
    bytes.writeUInt32BE(id, 5);
    return bytes;
}

function options(overrides: Partial<RawMultiplexStreamOptions> = {}): RawMultiplexStreamOptions {
    return {
        exclusiveConnected: true,
        maxWriteBufferBytes: 4096,
        uin: '0',
        initialSequence: 17,
        defaultTimeoutMs: 5000,
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

function request(): Sso12RawOptions<null, string> {
    return {
        buildRequest: ({ sequence }) => ({ frame: frame(1, sequence), context: null }),
        verifyCandidate: () => true,
        consumeCandidate: () => 'accepted',
    };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function wrote(stream: FakeStream): Promise<void> {
    for (let i = 0; i < 20 && stream.writes.length === 0; i++) {
        await turn();
    }

    expect(stream.writes).toHaveLength(1);
}

async function waitForCount(values: unknown[], count: number): Promise<void> {
    for (let i = 0; i < 20 && values.length < count; i++) {
        await turn();
    }

    expect(values).toHaveLength(count);
}

describe('raw multiplex stream: synthetic frame assembly deadlines', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it.each(['omitted', 'undefined'] as const)(
        '%s leaves partial assembly without a deadline',
        async (mode) => {
            const stream = new FakeStream();
            const pushed: Uint8Array[] = [];
            const client = createRawMultiplexStream(
                stream,
                options({
                    ...(mode === 'undefined' ? { frameAssemblyTimeoutMs: undefined } : {}),
                    onPush: (bytes) => {
                        pushed.push(Uint8Array.from(bytes));
                    },
                }),
            );
            const following = frame(2, 42);

            try {
                stream.emit('data', following.subarray(0, 2));
                await vi.advanceTimersByTimeAsync(10000);
                expect(client.closed).toBe(false);
                expect(stream.destroyCalls).toBe(0);
                stream.emit('data', following.subarray(2));
                await waitForCount(pushed, 1);
                expect(Array.from(pushed[0])).toEqual(Array.from(following));
            } finally {
                client.close();
                stream.finishClose();
            }
        },
    );

    it.each([1, 0x7fffffff])('accepts valid deadline boundary %i', (deadline) => {
        const stream = new FakeStream();
        const client = createRawMultiplexStream(
            stream,
            options({ frameAssemblyTimeoutMs: deadline }),
        );

        try {
            expect(client.closed).toBe(false);
        } finally {
            client.close();
            stream.finishClose();
        }
    });

    it.each([0, -1, 0.5, 1.5, 0x80000000, NaN, Infinity, -Infinity, '100', true, false, null])(
        'rejects invalid deadline %s with existing setup cleanup',
        (value) => {
            const stream = new FakeStream();
            const registrations = vi.fn();
            stream.on('newListener', registrations);
            const classify = vi.fn();
            const config = options({ classify, frameAssemblyTimeoutMs: value as number });
            const baselineStream = new FakeStream();
            const baseline = createRawMultiplexStream(baselineStream, {
                ...config,
                frameAssemblyTimeoutMs: 100,
            });
            let unexpected: ReturnType<typeof createRawMultiplexStream> | undefined;

            try {
                expect(baseline.closed).toBe(false);
                expect(() => {
                    unexpected = createRawMultiplexStream(stream, config);
                }).toThrow('stream setup failed');
                expect(registrations).not.toHaveBeenCalled();
                expect(classify).not.toHaveBeenCalled();
                expect(stream.writes).toHaveLength(0);
                // Value validation happens after the stream is claimed and inspected.
                expect(stream.destroyCalls).toBe(1);
            } finally {
                unexpected?.close();
                stream.finishClose();
                stream.removeAllListeners();
                baseline.close();
                baselineStream.finishClose();
            }
        },
    );

    it('rejects accessor and proxy option records before reading the stream', () => {
        const getter = vi.fn(() => 100);
        const traps = vi.fn();
        const accessor = options();
        Object.defineProperty(accessor, 'frameAssemblyTimeoutMs', { get: getter });
        const proxy = new Proxy(options(), { ownKeys: traps, get: traps, getPrototypeOf: traps });

        for (const config of [accessor, proxy]) {
            const stream = new FakeStream();
            const streamRead = vi.fn(() => EventEmitter.prototype.on);
            Object.defineProperty(stream, 'on', { get: streamRead });
            let unexpected: ReturnType<typeof createRawMultiplexStream> | undefined;

            try {
                expect(() => {
                    unexpected = createRawMultiplexStream(stream, config);
                }).toThrow('invalid stream configuration');
                expect(streamRead).not.toHaveBeenCalled();
                expect(stream.destroyCalls).toBe(0);
                expect(stream.writes).toHaveLength(0);
            } finally {
                unexpected?.close();
                stream.finishClose();
                stream.removeAllListeners();
            }
        }

        expect(getter).not.toHaveBeenCalled();
        expect(traps).not.toHaveBeenCalled();
    });

    it('does not invoke traps on a proxy deadline value and destroys after setup validation', () => {
        const traps = vi.fn();
        const value = new Proxy({}, { get: traps, ownKeys: traps, getPrototypeOf: traps });
        const stream = new FakeStream();
        const config = options({ frameAssemblyTimeoutMs: value as unknown as number });
        const baselineStream = new FakeStream();
        const baseline = createRawMultiplexStream(baselineStream, {
            ...config,
            frameAssemblyTimeoutMs: 100,
        });
        let unexpected: ReturnType<typeof createRawMultiplexStream> | undefined;

        try {
            expect(baseline.closed).toBe(false);
            expect(() => {
                unexpected = createRawMultiplexStream(stream, config);
            }).toThrow('stream setup failed');
            expect(traps).not.toHaveBeenCalled();
            expect(stream.destroyCalls).toBe(1);
            expect(stream.writes).toHaveLength(0);
        } finally {
            unexpected?.close();
            stream.finishClose();
            stream.removeAllListeners();
            baseline.close();
            baselineStream.finishClose();
        }
    });

    it.each([1, 3, 7])(
        'preserves an absolute deadline across a settled transaction and incremental progress (split %i)',
        async (split) => {
            const stream = new FakeStream();
            const pushed: Uint8Array[] = [];
            const client = createRawMultiplexStream(
                stream,
                options({
                    frameAssemblyTimeoutMs: 100,
                    allowIncompleteFollowingFrame: true,
                    onPush: (bytes) => {
                        pushed.push(Uint8Array.from(bytes));
                    },
                }),
            );
            const following = frame(2, 42);

            try {
                const result = client.transactRaw(request());
                await wrote(stream);
                stream.emit('data', Buffer.concat([frame(1, 17), following.subarray(0, split)]));
                expect(await result).toEqual({
                    kind: 'response',
                    sequence: 17,
                    value: 'accepted',
                    writeState: 'written',
                });
                await vi.advanceTimersByTimeAsync(60);
                stream.emit('data', following.subarray(split, split + 1));
                await vi.advanceTimersByTimeAsync(39);
                expect(client.closed).toBe(false);
                expect(stream.destroyCalls).toBe(0);
                await vi.advanceTimersByTimeAsync(1);
                expect(await client.whenClosed).toEqual({
                    kind: 'protocol-error',
                    code: 'frame-assembly-timeout',
                });
                expect(stream.destroyCalls).toBe(1);
                expect(stream.destroyed).toBe(true);
                stream.emit('data', following.subarray(split + 1));
                await turn();
                expect(pushed).toEqual([]);
            } finally {
                client.close();
                stream.finishClose();
            }
        },
    );

    it('expires the retained frame on its original clock during a new transaction', async () => {
        const stream = new FakeStream();
        const pushed: Uint8Array[] = [];
        const client = createRawMultiplexStream(
            stream,
            options({
                frameAssemblyTimeoutMs: 100,
                allowIncompleteFollowingFrame: true,
                onPush: (bytes) => {
                    pushed.push(Uint8Array.from(bytes));
                },
            }),
        );
        const following = frame(2, 42);

        try {
            const first = client.transactRaw(request());
            await wrote(stream);
            stream.emit('data', Buffer.concat([frame(1, 17), following.subarray(0, 2)]));
            expect(await first).toMatchObject({ kind: 'response', sequence: 17 });
            await vi.advanceTimersByTimeAsync(60);
            const second = client.transactRaw(request());

            for (let i = 0; i < 20 && stream.writes.length < 2; i++) {
                await turn();
            }

            expect(stream.writes).toHaveLength(2);
            stream.emit('data', following.subarray(2, 4));
            await vi.advanceTimersByTimeAsync(40);
            expect(await second).toEqual({
                kind: 'failure',
                code: 'frame-assembly-timeout',
                writeState: 'unknown',
            });
            expect(await client.whenClosed).toEqual({
                kind: 'protocol-error',
                code: 'frame-assembly-timeout',
            });
            expect(stream.destroyCalls).toBe(1);
            expect(pushed).toEqual([]);
        } finally {
            client.close();
            stream.finishClose();
        }
    });

    it('starts a fresh deadline for the next frame, not the previous frame', async () => {
        const stream = new FakeStream();
        const pushed: Uint8Array[] = [];
        const verified: Uint8Array[] = [];
        const client = createRawMultiplexStream(
            stream,
            options({
                frameAssemblyTimeoutMs: 100,
                verifyPush: (bytes) => {
                    verified.push(Uint8Array.from(bytes));
                    return true;
                },
                onPush: (bytes) => {
                    pushed.push(Uint8Array.from(bytes));
                },
            }),
        );
        const first = frame(2, 41);
        const second = frame(2, 42);

        try {
            stream.emit('data', first.subarray(0, 1));
            await vi.advanceTimersByTimeAsync(70);
            stream.emit('data', first.subarray(1));
            await waitForCount(pushed, 1);
            expect(Array.from(verified[0])).toEqual(Array.from(first));
            expect(Array.from(pushed[0])).toEqual(Array.from(first));
            await vi.advanceTimersByTimeAsync(20);
            stream.emit('data', second.subarray(0, 2));
            await vi.advanceTimersByTimeAsync(10);
            expect(client.closed).toBe(false);
            await vi.advanceTimersByTimeAsync(89);
            expect(client.closed).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(await client.whenClosed).toEqual({
                kind: 'protocol-error',
                code: 'frame-assembly-timeout',
            });
            expect(stream.destroyCalls).toBe(1);
            expect(pushed).toHaveLength(1);
        } finally {
            client.close();
            stream.finishClose();
        }
    });

    it.each(['close', 'end'] as const)(
        '%s cancels the frame timer and fences late data',
        async (mode) => {
            const stream = new FakeStream();
            const pushed: Uint8Array[] = [];
            const client = createRawMultiplexStream(
                stream,
                options({
                    frameAssemblyTimeoutMs: 100,
                    onPush: (bytes) => {
                        pushed.push(Uint8Array.from(bytes));
                    },
                }),
            );
            const following = frame(2, 42);

            try {
                stream.emit('data', following.subarray(0, 2));
                expect(vi.getTimerCount()).toBe(1);

                if (mode === 'close') {
                    client.close();
                } else {
                    stream.emit('end');
                }

                expect(await client.whenClosed).toEqual(
                    mode === 'close'
                        ? { kind: 'local', code: 'local-close' }
                        : { kind: 'protocol-error', code: 'truncated-stream' },
                );
                expect(vi.getTimerCount()).toBe(0);
                expect(stream.destroyCalls).toBe(1);
                stream.emit('data', following.subarray(2));
                stream.finishClose();
                stream.emit('data', following);
                await vi.advanceTimersByTimeAsync(200);
                await turn();
                expect(pushed).toEqual([]);
                expect(stream.destroyCalls).toBe(1);
            } finally {
                client.close();
                stream.finishClose();
                stream.removeAllListeners();
                following.fill(0);

                for (const bytes of pushed) {
                    bytes.fill(0);
                }
            }
        },
    );
});
