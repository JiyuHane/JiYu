import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
    createRawMultiplexStream,
    type RawMultiplexStreamOptions,
} from '../../src/direct/raw-multiplex-stream';
import type { Sso12RawIdentity } from '../../src/direct/sso12-packet-client';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const events = ['data', 'error', 'end', 'close', 'pause'] as const;

// An EventEmitter byte stream; no socket or connection is created.
class FakeStream extends EventEmitter {
    readable = true;
    writable = true;
    destroyed = false;
    readableFlowing: boolean | null = null;
    writableLength = 0;
    writableNeedDrain = false;
    writes: Uint8Array[] = [];
    borrowed: Uint8Array[] = [];
    callbacks: Array<(error?: Error | null) => void> = [];

    write(bytes: Uint8Array, callback: (error?: Error | null) => void): boolean {
        this.writes.push(Uint8Array.from(bytes));
        this.borrowed.push(bytes);
        this.callbacks.push(callback);
        return true;
    }

    destroy(): this {
        this.destroyed = true;
        this.readable = false;
        this.writable = false;
        return this;
    }

    finishClose(): void {
        this.destroy();
        this.emit('close');
    }
}

function frame(kind: number, id: number): Buffer {
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
        uin: '123',
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

function setup(overrides: Partial<RawMultiplexStreamOptions> = {}) {
    const stream = new FakeStream();
    const errorSink = vi.fn();
    stream.on('error', errorSink);
    const baseline = new Map(events.map((event) => [event, stream.listeners(event)]));
    const client = createRawMultiplexStream(stream, options(overrides));
    return { stream, client, baseline, errorSink };
}

async function waitFor(check: () => boolean): Promise<void> {
    for (let i = 0; i < 30 && !check(); i++) {
        await turn();
    }

    expect(check()).toBe(true);
}

async function cleanup(f: ReturnType<typeof setup>): Promise<void> {
    f.client.close();

    for (const callback of f.stream.callbacks) {
        callback();
    }

    f.stream.finishClose();
    await f.client.whenClosed;
    await turn();

    for (const event of events) {
        expect(f.stream.listeners(event)).toEqual(f.baseline.get(event));
    }

    expect(f.stream.listeners('error')).toContain(f.errorSink);

    for (const bytes of f.stream.borrowed) {
        expect(bytes.every((byte) => byte === 0)).toBe(true);
    }
}

describe('raw multiplex stream response barrier with fake bytes', () => {
    it.each([true, false])(
        'holds following classification only when configured: %s',
        async (hold) => {
            const entered = deferred<void>();
            const release = deferred<void>();
            const pushed = deferred<void>();
            const stage: string[] = [];
            const identities: Sso12RawIdentity[] = [];
            const f = setup({
                ...(hold
                    ? {
                          holdFollowingFrames: (identity: Sso12RawIdentity) => {
                              identities.push(identity);
                              return true;
                          },
                      }
                    : {}),
                classify: (bytes) => {
                    const id = new DataView(
                        bytes.buffer,
                        bytes.byteOffset,
                        bytes.byteLength,
                    ).getUint32(5);
                    stage.push(bytes[4] === 1 ? 'classify-response' : `classify-push-${id}`);
                    return bytes[4] === 1
                        ? { kind: 'response', sequence: id }
                        : { kind: 'push', name: 'synthetic', id };
                },
                onPush: (_bytes, identity) => {
                    if (identity.id === 2) {
                        pushed.resolve();
                    }
                },
            });
            const work = f.client.transactRaw({
                buildRequest: ({ sequence }) => ({ frame: frame(1, sequence), context: null }),
                verifyCandidate: () => true,
                consumeCandidate: async () => {
                    stage.push('consume-start');
                    entered.resolve();
                    await release.promise;
                    stage.push('consume-end');
                    return 'accepted';
                },
            });

            try {
                await waitFor(() => f.stream.callbacks.length === 1);
                const snapshot = Uint8Array.from(f.stream.writes[0]);
                f.stream.callbacks[0]();
                expect(f.stream.borrowed[0].every((byte) => byte === 0)).toBe(true);
                expect(f.stream.writes[0]).toEqual(snapshot);
                f.stream.emit('data', Buffer.concat([frame(2, 1), frame(1, 17), frame(2, 2)]));
                await entered.promise;
                await turn();
                expect(stage).toContain('classify-push-1');
                expect(stage).toContain('classify-response');
                expect(stage.includes('classify-push-2')).toBe(!hold);

                if (hold) {
                    expect(identities).toHaveLength(1);
                    expect(identities[0]).toEqual({ uin: '123', sequence: 17 });
                    expect(Reflect.ownKeys(identities[0]).sort()).toEqual(['sequence', 'uin']);
                } else {
                    expect(identities).toHaveLength(0);
                }

                release.resolve();
                expect(await work).toMatchObject({
                    kind: 'response',
                    sequence: 17,
                    value: 'accepted',
                });
                await pushed.promise;

                if (hold) {
                    expect(stage.indexOf('classify-push-2')).toBeGreaterThan(
                        stage.indexOf('consume-end'),
                    );
                }
            } finally {
                release.resolve();
                await cleanup(f);
            }
        },
    );

    it.each(['throw', 'invalid-return'] as const)(
        'fails closed when the hold policy produces %s',
        async (mode) => {
            const classified: number[] = [];
            const consume = vi.fn(() => 'unexpected');
            const f = setup({
                holdFollowingFrames: () => {
                    if (mode === 'throw') {
                        throw new Error('synthetic policy failure');
                    }

                    return 'invalid' as unknown as boolean;
                },
                classify: (bytes) => {
                    classified.push(bytes[4]);
                    return bytes[4] === 1
                        ? { kind: 'response', sequence: 17 }
                        : { kind: 'push', name: 'synthetic', id: 2 };
                },
            });
            const work = f.client.transactRaw({
                buildRequest: ({ sequence }) => ({ frame: frame(1, sequence), context: null }),
                verifyCandidate: () => true,
                consumeCandidate: consume,
            });

            try {
                await waitFor(() => f.stream.callbacks.length === 1);
                f.stream.callbacks[0]();
                f.stream.emit('data', Buffer.concat([frame(1, 17), frame(2, 2)]));
                expect(await work).toMatchObject({ kind: 'failure' });
                expect(await f.client.whenClosed).toMatchObject({
                    kind: 'handler-error',
                    code: 'frame-handler-failed',
                });
                expect(f.client.closed).toBe(true);
                expect(consume).not.toHaveBeenCalled();
                expect(classified).toEqual([1]);
            } finally {
                await cleanup(f);
            }
        },
    );

    it('rejects unknown, accessor, and invalid callback options without invoking accessors', () => {
        const getter = vi.fn(() => () => true);
        const variants: unknown[] = [
            { ...options(), unknownField: true },
            Object.defineProperty(options(), 'holdFollowingFrames', { get: getter }),
            { ...options(), holdFollowingFrames: 1 },
        ];

        for (const value of variants) {
            const stream = new FakeStream();
            const errorSink = vi.fn();
            stream.on('error', errorSink);
            const baseline = new Map(events.map((event) => [event, stream.listeners(event)]));
            expect(() =>
                createRawMultiplexStream(stream, value as RawMultiplexStreamOptions),
            ).toThrow();
            stream.finishClose();

            for (const event of events) {
                expect(stream.listeners(event)).toEqual(baseline.get(event));
            }

            expect(stream.listeners('error')).toContain(errorSink);
        }

        expect(getter).not.toHaveBeenCalled();
    });
});
