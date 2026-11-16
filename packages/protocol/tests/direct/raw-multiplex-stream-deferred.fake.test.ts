import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
    createRawMultiplexStream,
    type RawMultiplexStreamOptions,
} from '../../src/direct/raw-multiplex-stream';
import { claimDirectSocket } from '../../src/direct/socket-ownership';
import type { Sso12RawOptions } from '../../src/direct/sso12-packet-client';

function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const events = ['data', 'error', 'end', 'close', 'pause'] as const;

// No sockets, listener endpoints, or external peers: only synthetic event delivery.
class FakeStream extends EventEmitter {
    readable = true;
    writable = true;
    destroyed = false;
    readableFlowing: boolean | null = null;
    writableLength = 0;
    writableNeedDrain = false;
    callbacks: Array<(error?: Error | null) => void> = [];
    borrowed: Uint8Array[] = [];
    destroyCalls = 0;

    write(bytes: Uint8Array, callback: (error?: Error | null) => void): boolean {
        this.borrowed.push(bytes);
        this.callbacks.push(callback);
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

function frame(kind: number, id: number): Buffer {
    const result = Buffer.alloc(14);
    result.writeUInt32BE(result.length, 0);
    result[4] = kind;
    result.writeUInt32BE(id, 5);
    return result;
}

function frameId(bytes: Uint8Array): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(5);
}

function options(extra: Partial<RawMultiplexStreamOptions> = {}): RawMultiplexStreamOptions {
    return {
        exclusiveConnected: true,
        maxWriteBufferBytes: 4096,
        uin: '123',
        initialSequence: 17,
        defaultTimeoutMs: 5000,
        maxFrameBytes: 1024,
        maxBufferedBytes: 4096,
        maxFrames: 8,
        maxPushFrames: 8,
        maxPushBytes: 4096,
        classify: (bytes) =>
            bytes[4] === 1
                ? { kind: 'response', sequence: frameId(bytes) }
                : { kind: 'push', name: 'synthetic', id: frameId(bytes) },
        verifyPush: () => true,
        onPush: () => {},
        ...extra,
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

function fixture(extra: Partial<RawMultiplexStreamOptions> = {}) {
    const stream = new FakeStream();
    const errorSink = vi.fn();
    stream.on('error', errorSink);
    const baseline = new Map(events.map((event) => [event, stream.listeners(event)]));
    const client = createRawMultiplexStream(stream, options(extra));
    return { stream, client, baseline };
}

async function waitFor(check: () => boolean): Promise<void> {
    for (let i = 0; i < 50 && !check(); i++) {
        await turn();
    }

    expect(check()).toBe(true);
}

async function cleanup(f: ReturnType<typeof fixture>): Promise<void> {
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

    for (const bytes of f.stream.borrowed) {
        expect(bytes.every((byte) => byte === 0)).toBe(true);
    }

    const release = claimDirectSocket(
        f.stream as unknown as Parameters<typeof claimDirectSocket>[0],
    );
    release();
}

describe('deferred multiplex frames through a synthetic EventEmitter stream', () => {
    it('replays A before parked B and following C after response consumption, without waiting for delivery', async () => {
        const consumeGate = gate();
        const verifyGate = gate();
        const deliveryGate = gate();
        const stages: string[] = [];
        const classified: Array<{
            bytes: number[];
            identity: { uin: string; sequence?: number };
            route: object;
        }> = [];
        const verified: Array<{ bytes: number[]; route: object }> = [];
        const delivered: Array<{ bytes: number[]; route: object }> = [];
        const responseVerified: Array<{ bytes: number[]; context: null; identity: object }> = [];
        const consumed: Array<{ bytes: number[]; context: null; identity: object }> = [];
        let ready = false;
        const f = fixture({
            allowDeferredFrames: true,
            classify: (bytes, identity) => {
                const id = frameId(bytes);
                stages.push(`classify-${id}`);
                const route =
                    bytes[4] === 1
                        ? { kind: 'response' as const, sequence: id }
                        : id === 1 && !ready
                          ? { kind: 'defer' as const }
                          : { kind: 'push' as const, name: 'synthetic', id };
                classified.push({
                    bytes: Array.from(bytes),
                    identity: { ...identity },
                    route: { ...route },
                });
                return route;
            },
            verifyPush: async (bytes, route) => {
                stages.push(`verify-${route.id}`);
                verified.push({ bytes: Array.from(bytes), route: { ...route } });

                if (route.id === 1) {
                    await verifyGate.promise;
                }

                return true;
            },
            onPush: async (bytes, route) => {
                stages.push(`deliver-${route.id}`);
                delivered.push({ bytes: Array.from(bytes), route: { ...route } });

                if (route.id === 1) {
                    await deliveryGate.promise;
                }
            },
        });
        let settled = false;
        const work = f.client.transactRaw(
            request({
                verifyCandidate: (bytes, context, identity) => {
                    stages.push(`response-verify-${frameId(bytes)}-${identity.sequence}`);
                    responseVerified.push({
                        bytes: Array.from(bytes),
                        context,
                        identity: { ...identity },
                    });
                    return true;
                },
                consumeCandidate: async (bytes, context, identity) => {
                    consumed.push({ bytes: Array.from(bytes), context, identity: { ...identity } });
                    stages.push('consume-start');
                    await consumeGate.promise;
                    ready = true;
                    stages.push('consume-end');
                    return 'accepted';
                },
            }),
        );
        void work.then(() => {
            settled = true;
        });
        const a = frame(2, 1);
        const b = frame(2, 2);
        const r = frame(1, 17);
        const c = frame(2, 3);

        try {
            await waitFor(() => f.stream.callbacks.length === 1);
            f.stream.callbacks[0]();
            f.stream.emit('data', Buffer.concat([a, b, r, c]));
            await waitFor(() => stages.includes('consume-start'));
            await turn();
            expect(stages).toEqual([
                'classify-1',
                'classify-2',
                'classify-17',
                'response-verify-17-17',
                'consume-start',
            ]);
            expect(verified).toEqual([]);
            expect(delivered).toEqual([]);
            expect(settled).toBe(false);

            consumeGate.resolve();
            await waitFor(() => verified.length === 1);
            await turn();
            expect(stages).toContain('consume-end');
            expect(settled).toBe(false);
            expect(verified).toEqual([
                { bytes: Array.from(a), route: { kind: 'push', name: 'synthetic', id: 1 } },
            ]);
            expect(delivered).toEqual([]);
            expect(stages).not.toContain('verify-2');
            expect(stages).not.toContain('verify-3');
            expect(stages).not.toContain('classify-3');

            verifyGate.resolve();
            await waitFor(() => settled && verified.length === 3 && delivered.length === 1);
            expect(await work).toEqual({
                kind: 'response',
                sequence: 17,
                value: 'accepted',
                writeState: 'written',
            });
            const identity = { uin: '123', sequence: 17 };
            const pushA = { kind: 'push', name: 'synthetic', id: 1 };
            const pushB = { kind: 'push', name: 'synthetic', id: 2 };
            const pushC = { kind: 'push', name: 'synthetic', id: 3 };
            expect(classified).toEqual([
                { bytes: Array.from(a), identity, route: { kind: 'defer' } },
                { bytes: Array.from(b), identity, route: pushB },
                { bytes: Array.from(r), identity, route: { kind: 'response', sequence: 17 } },
                { bytes: Array.from(a), identity, route: pushA },
                { bytes: Array.from(c), identity, route: pushC },
            ]);
            expect(responseVerified).toEqual([{ bytes: Array.from(r), context: null, identity }]);
            expect(consumed).toEqual([{ bytes: Array.from(r), context: null, identity }]);
            expect(stages.indexOf('classify-1', 1)).toBeGreaterThan(stages.indexOf('consume-end'));
            expect(verified).toEqual([
                { bytes: Array.from(a), route: pushA },
                { bytes: Array.from(b), route: pushB },
                { bytes: Array.from(c), route: pushC },
            ]);
            expect(delivered).toEqual([{ bytes: Array.from(a), route: pushA }]);
            deliveryGate.resolve();
            await waitFor(() => delivered.length === 3);
            expect(delivered).toEqual([
                { bytes: Array.from(a), route: pushA },
                { bytes: Array.from(b), route: pushB },
                { bytes: Array.from(c), route: pushC },
            ]);
        } finally {
            consumeGate.resolve();
            verifyGate.resolve();
            deliveryGate.resolve();
            await cleanup(f);
        }
    });

    it.each(['default', 'false'] as const)(
        'rejects defer with option %s and runs no business callbacks',
        async (mode) => {
            const verifyPush = vi.fn(() => true);
            const onPush = vi.fn();
            const verifyCandidate = vi.fn(() => true);
            const consumeCandidate = vi.fn(() => 'unexpected');
            const f = fixture({
                ...(mode === 'false' ? { allowDeferredFrames: false } : {}),
                classify: () => ({ kind: 'defer' }),
                verifyPush,
                onPush,
            });
            const work = f.client.transactRaw(request({ verifyCandidate, consumeCandidate }));

            try {
                await waitFor(() => f.stream.callbacks.length === 1);
                f.stream.callbacks[0]();
                f.stream.emit('data', frame(2, 1));
                expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
                expect(await f.client.whenClosed).toMatchObject({
                    kind: 'handler-error',
                    code: 'frame-handler-failed',
                });
                expect(verifyPush).not.toHaveBeenCalled();
                expect(onPush).not.toHaveBeenCalled();
                expect(verifyCandidate).not.toHaveBeenCalled();
                expect(consumeCandidate).not.toHaveBeenCalled();
            } finally {
                await cleanup(f);
            }
        },
    );

    it('rejects an extra property on the defer route before any business callback', async () => {
        const verifyPush = vi.fn(() => true);
        const onPush = vi.fn();
        const verifyCandidate = vi.fn(() => true);
        const consumeCandidate = vi.fn(() => 'unexpected');
        const f = fixture({
            allowDeferredFrames: true,
            classify: () => ({ kind: 'defer', id: 1 }) as unknown as { kind: 'defer' },
            verifyPush,
            onPush,
        });
        const work = f.client.transactRaw(request({ verifyCandidate, consumeCandidate }));

        try {
            await waitFor(() => f.stream.callbacks.length === 1);
            f.stream.callbacks[0]();
            f.stream.emit('data', frame(2, 1));
            expect(await work).toMatchObject({ kind: 'failure' });
            expect(await f.client.whenClosed).toMatchObject({
                kind: 'handler-error',
                code: 'frame-handler-failed',
            });
            expect(verifyPush).not.toHaveBeenCalled();
            expect(onPush).not.toHaveBeenCalled();
            expect(verifyCandidate).not.toHaveBeenCalled();
            expect(consumeCandidate).not.toHaveBeenCalled();
        } finally {
            await cleanup(f);
        }
    });

    it('rejects defer with no current written transaction', async () => {
        const verifyPush = vi.fn(() => true);
        const onPush = vi.fn();
        const f = fixture({
            allowDeferredFrames: true,
            classify: () => ({ kind: 'defer' }),
            verifyPush,
            onPush,
        });

        try {
            f.stream.emit('data', frame(2, 1));
            expect(await f.client.whenClosed).toMatchObject({
                kind: 'protocol-error',
                code: 'frame-rejected',
            });
            expect(verifyPush).not.toHaveBeenCalled();
            expect(onPush).not.toHaveBeenCalled();
        } finally {
            await cleanup(f);
        }
    });

    it('rejects defer captured before the pending request reaches write', async () => {
        const buildGate = gate();
        let buildEntered = false;
        const verifyPush = vi.fn(() => true);
        const onPush = vi.fn();
        const f = fixture({
            allowDeferredFrames: true,
            classify: () => ({ kind: 'defer' }),
            verifyPush,
            onPush,
        });
        const work = f.client.transactRaw(
            request({
                buildRequest: async ({ sequence }) => {
                    buildEntered = true;
                    await buildGate.promise;
                    return { frame: frame(1, sequence), context: null };
                },
            }),
        );

        try {
            await waitFor(() => buildEntered);
            f.stream.emit('data', frame(2, 1));
            expect(await work).toMatchObject({ kind: 'failure', writeState: 'not-written' });
            expect(await f.client.whenClosed).toMatchObject({
                kind: 'protocol-error',
                code: 'frame-rejected',
            });
            expect(f.stream.callbacks).toHaveLength(0);
            expect(verifyPush).not.toHaveBeenCalled();
            expect(onPush).not.toHaveBeenCalled();
        } finally {
            buildGate.resolve();
            await cleanup(f);
        }
    });

    it.each([null, 0, 1, 'true', {}, []])(
        'claims and destroys on non-boolean option %j',
        (value) => {
            const stream = new FakeStream();
            const sink = vi.fn();
            stream.on('error', sink);
            const baseline = new Map(events.map((event) => [event, stream.listeners(event)]));
            const config = {
                ...options(),
                allowDeferredFrames: value,
            } as unknown as RawMultiplexStreamOptions;
            expect(() => createRawMultiplexStream(stream, config)).toThrow('stream setup failed');
            expect(stream.destroyCalls).toBe(1);
            expect(stream.destroyed).toBe(true);
            expect(() =>
                claimDirectSocket(stream as unknown as Parameters<typeof claimDirectSocket>[0]),
            ).toThrow();
            stream.finishClose();

            for (const event of events) {
                expect(stream.listeners(event)).toEqual(baseline.get(event));
            }
        },
    );

    it('rejects accessor and proxy configuration without invoking their code', () => {
        const getter = vi.fn(() => true);
        const trap = vi.fn(() => {
            throw new Error('proxy trap');
        });
        const configs = [
            Object.defineProperty(options(), 'allowDeferredFrames', { get: getter }),
            new Proxy(options(), {
                getPrototypeOf: trap,
                ownKeys: trap,
                get: trap,
                getOwnPropertyDescriptor: trap,
            }),
        ];

        for (const config of configs) {
            const stream = new FakeStream();
            expect(() => createRawMultiplexStream(stream, config)).toThrow(
                'invalid stream configuration',
            );
            expect(stream.destroyCalls).toBe(0);
            const release = claimDirectSocket(
                stream as unknown as Parameters<typeof claimDirectSocket>[0],
            );
            release();
        }

        expect(getter).not.toHaveBeenCalled();
        expect(trap).not.toHaveBeenCalled();
    });

    it('keeps deferred replay and response callbacks pending until the write callback', async () => {
        const classified: number[] = [];
        const verifyPush = vi.fn(() => true);
        const onPush = vi.fn();
        const verifyCandidate = vi.fn(() => true);
        const consumeCandidate = vi.fn(() => 'accepted');
        let ready = false;
        let settled = false;
        const f = fixture({
            allowDeferredFrames: true,
            classify: (bytes) => {
                const id = frameId(bytes);
                classified.push(id);

                if (bytes[4] === 1) {
                    return { kind: 'response', sequence: id };
                }

                return ready ? { kind: 'push', name: 'synthetic', id } : { kind: 'defer' };
            },
            verifyPush,
            onPush,
        });
        const work = f.client.transactRaw(
            request({
                verifyCandidate,
                consumeCandidate: () => {
                    consumeCandidate();
                    ready = true;
                    return 'accepted';
                },
            }),
        );
        void work.then(() => {
            settled = true;
        });

        try {
            await waitFor(() => f.stream.callbacks.length === 1);
            f.stream.emit('data', Buffer.concat([frame(2, 1), frame(1, 17)]));
            await waitFor(() => classified.length === 2);
            await turn();
            expect(settled).toBe(false);
            expect(classified).toEqual([1, 17]);
            expect(verifyCandidate).not.toHaveBeenCalled();
            expect(consumeCandidate).not.toHaveBeenCalled();
            expect(verifyPush).not.toHaveBeenCalled();
            expect(onPush).not.toHaveBeenCalled();
            f.stream.callbacks[0]();
            expect(await work).toEqual({
                kind: 'response',
                sequence: 17,
                value: 'accepted',
                writeState: 'written',
            });
            await waitFor(() => onPush.mock.calls.length === 1);
            expect(classified).toEqual([1, 17, 1]);
            expect(verifyCandidate).toHaveBeenCalledOnce();
            expect(consumeCandidate).toHaveBeenCalledOnce();
            expect(verifyPush).toHaveBeenCalledOnce();
        } finally {
            await cleanup(f);
        }
    });

    it.each(['close', 'abort'] as const)(
        'cleans pending parked frames and fences a late consume gate after %s',
        async (mode) => {
            const consumeGate = gate();
            const controller = new AbortController();
            const classified: number[] = [];
            const verifyPush = vi.fn(() => true);
            const onPush = vi.fn();
            let consumeEntered = false;
            let lateReturned = false;
            const f = fixture({
                allowDeferredFrames: true,
                classify: (bytes) => {
                    const id = frameId(bytes);
                    classified.push(id);
                    return bytes[4] === 1 ? { kind: 'response', sequence: id } : { kind: 'defer' };
                },
                verifyPush,
                onPush,
            });
            const work = f.client.transactRaw(
                request({
                    signal: controller.signal,
                    consumeCandidate: async () => {
                        consumeEntered = true;
                        await consumeGate.promise;
                        lateReturned = true;
                        return 'late';
                    },
                }),
            );

            try {
                await waitFor(() => f.stream.callbacks.length === 1);
                f.stream.callbacks[0]();
                f.stream.emit(
                    'data',
                    Buffer.concat([frame(2, 1), frame(2, 2), frame(1, 17), frame(2, 3)]),
                );
                await waitFor(() => consumeEntered);

                if (mode === 'close') {
                    f.client.close();
                } else {
                    controller.abort();
                }

                expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
                expect(await f.client.whenClosed).toMatchObject({
                    kind: 'local',
                    code: mode === 'close' ? 'local-close' : 'raw-cancelled',
                });
                f.stream.finishClose();
                consumeGate.resolve();
                await waitFor(() => lateReturned);
                await turn();
                expect(classified).toEqual([1, 2, 17]);
                expect(verifyPush).not.toHaveBeenCalled();
                expect(onPush).not.toHaveBeenCalled();
                expect(f.client.closed).toBe(true);
            } finally {
                consumeGate.resolve();
                await cleanup(f);
            }
        },
    );
});
