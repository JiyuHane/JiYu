import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
    createRawMultiplexStream,
    type RawMultiplexStreamOptions,
} from '../../src/direct/raw-multiplex-stream';
import type { Sso12RawOptions } from '../../src/direct/sso12-packet-client';
import type { RawMultiplexPushRoute } from '../../src/direct/raw-multiplex-client';

// In-memory EventEmitter only: no socket, connection factory, or peer.
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

function request(consume = () => 'accepted'): Sso12RawOptions<null, string> {
    return {
        buildRequest: ({ sequence }) => ({ frame: frame(1, sequence), context: null }),
        verifyCandidate: () => true,
        consumeCandidate: consume,
    };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function wrote(stream: FakeStream, count: number): Promise<void> {
    for (let i = 0; i < 20 && stream.writes.length < count; i++) {
        await turn();
    }

    expect(stream.writes).toHaveLength(count);
}

async function untilCalled(mock: { mock: { calls: unknown[][] } }): Promise<void> {
    for (let i = 0; i < 20 && mock.mock.calls.length === 0; i++) {
        await turn();
    }

    expect(mock).toHaveBeenCalled();
}

describe('raw multiplex stream: incomplete following frame on a fake stream', () => {
    it.each(['omitted', 'undefined', 'false'] as const)(
        '%s keeps a consumed response pending until the following frame drains',
        async (mode) => {
            const stream = new FakeStream();
            const consume = vi.fn(() => 'accepted');
            const onPush = vi.fn();
            const client = createRawMultiplexStream(
                stream,
                options({
                    onPush,
                    ...(mode === 'omitted'
                        ? {}
                        : { allowIncompleteFollowingFrame: mode === 'false' ? false : undefined }),
                }),
            );
            let settled = false;
            const result = client.transactRaw(request(consume));
            void result.then(() => {
                settled = true;
            });

            try {
                await wrote(stream, 1);
                const following = frame(2, 42);
                stream.emit('data', Buffer.concat([frame(1, 17), following.subarray(0, 3)]));
                await untilCalled(consume);
                await turn();
                expect(settled).toBe(false);
                stream.emit('data', following.subarray(3));
                expect(await result).toMatchObject({
                    kind: 'response',
                    sequence: 17,
                    value: 'accepted',
                });
                await untilCalled(onPush);
                expect(stream.writes).toHaveLength(1);
            } finally {
                client.close();
                stream.finishClose();
            }
        },
    );

    it.each([2, 7])(
        'true settles with %i bytes retained and preserves the old identity for a later push',
        async (split) => {
            const stream = new FakeStream();
            const identities: Array<{ uin: string; sequence?: number }> = [];
            const snapshots: { verified?: Uint8Array; pushed?: Uint8Array } = {};
            const onPush = vi.fn((bytes: Uint8Array, _route: RawMultiplexPushRoute) => {
                snapshots.pushed = Uint8Array.from(bytes);
            });
            const consume = vi.fn(() => 'accepted');
            const client = createRawMultiplexStream(
                stream,
                options({
                    allowIncompleteFollowingFrame: true,
                    classify: (bytes, identity) => {
                        identities.push(identity);
                        const id = new DataView(
                            bytes.buffer,
                            bytes.byteOffset,
                            bytes.byteLength,
                        ).getUint32(5);
                        return bytes[4] === 1
                            ? { kind: 'response', sequence: id }
                            : { kind: 'push', name: 'synthetic', id };
                    },
                    verifyPush: (bytes) => {
                        snapshots.verified = Uint8Array.from(bytes);
                        return true;
                    },
                    onPush,
                }),
            );

            try {
                const result = client.transactRaw(request(consume));
                await wrote(stream, 1);
                const following = frame(2, 42);
                stream.emit('data', Buffer.concat([frame(1, 17), following.subarray(0, split)]));
                expect(await result).toMatchObject({
                    kind: 'response',
                    sequence: 17,
                    value: 'accepted',
                });
                expect(consume).toHaveBeenCalledOnce();
                expect(onPush).not.toHaveBeenCalled();
                stream.emit('data', following.subarray(split));
                await untilCalled(onPush);
                expect(identities).toEqual([
                    { uin: '0', sequence: 17 },
                    { uin: '0', sequence: 17 },
                ]);
                expect(onPush.mock.calls[0][1]).toEqual({
                    kind: 'push',
                    name: 'synthetic',
                    id: 42,
                });
                expect(snapshots.verified && Array.from(snapshots.verified)).toEqual(
                    Array.from(following),
                );
                expect(snapshots.pushed && Array.from(snapshots.pushed)).toEqual(
                    Array.from(following),
                );
                expect(stream.writes).toHaveLength(1);
                expect(client.closed).toBe(false);
            } finally {
                snapshots.verified?.fill(0);
                snapshots.pushed?.fill(0);
                client.close();
                stream.finishClose();
            }
        },
    );

    it('rejects a retained old frame as the new transaction response', async () => {
        const stream = new FakeStream();
        const client = createRawMultiplexStream(
            stream,
            options({ allowIncompleteFollowingFrame: true }),
        );
        const consumeNew = vi.fn(() => 'new');

        try {
            const first = client.transactRaw(request());
            await wrote(stream, 1);
            const old = frame(1, 18);
            stream.emit('data', Buffer.concat([frame(1, 17), old.subarray(0, 2)]));
            expect(await first).toMatchObject({ kind: 'response', sequence: 17 });
            const second = client.transactRaw(request(consumeNew));
            await wrote(stream, 2);
            stream.emit('data', old.subarray(2));
            expect(await second).toMatchObject({ kind: 'failure', code: 'unexpected-response' });
            expect(await client.whenClosed).toMatchObject({
                kind: 'protocol-error',
                code: 'unexpected-response',
            });
            expect(consumeNew).not.toHaveBeenCalled();
            expect(client.closed).toBe(true);
            expect(await client.transactRaw(request())).toMatchObject({
                kind: 'failure',
                code: 'closed',
                writeState: 'not-written',
            });
            expect(stream.writes).toHaveLength(2);
        } finally {
            client.close();
            stream.finishClose();
        }
    });

    it.each([null, 0, 'true', {}, []])(
        'rejects non-boolean %s before listener registration',
        (value) => {
            const stream = new FakeStream();
            const classify = vi.fn();
            const config = options({
                classify,
                allowIncompleteFollowingFrame: value as unknown as boolean,
            });
            const registrations = vi.fn();
            stream.on('newListener', registrations);
            expect(() => createRawMultiplexStream(stream, config)).toThrow();
            expect(registrations).not.toHaveBeenCalled();
            expect(classify).not.toHaveBeenCalled();
            expect(stream.writes).toHaveLength(0);
            // Existing setup-failure cleanup destroys the already-claimed stream.
            expect(stream.destroyCalls).toBe(1);
        },
    );

    it('rejects getter and proxy options without invoking them or touching the stream', () => {
        const getter = vi.fn(() => true);
        const traps = vi.fn();
        const accessor = options();
        Object.defineProperty(accessor, 'allowIncompleteFollowingFrame', { get: getter });
        const proxy = new Proxy(options(), { ownKeys: traps, get: traps, getPrototypeOf: traps });
        const unknown = { ...options(), unknownOption: true };

        for (const config of [accessor, proxy, unknown]) {
            const stream = new FakeStream();
            const registrations = vi.fn();
            stream.on('newListener', registrations);
            const streamRead = vi.fn(() => EventEmitter.prototype.on);
            Object.defineProperty(stream, 'on', { get: streamRead });
            expect(() => createRawMultiplexStream(stream, config)).toThrow();
            expect(streamRead).not.toHaveBeenCalled();
            expect(registrations).not.toHaveBeenCalled();
            expect(stream.destroyCalls).toBe(0);
            expect(stream.writes).toHaveLength(0);
        }

        expect(getter).not.toHaveBeenCalled();
        expect(traps).not.toHaveBeenCalled();
    });

    it('rejects a proxy used as the option value without invoking its traps', () => {
        const traps = vi.fn();
        const value = new Proxy({}, { get: traps, ownKeys: traps, getPrototypeOf: traps });
        const stream = new FakeStream();
        const registrations = vi.fn();
        stream.on('newListener', registrations);
        expect(() =>
            createRawMultiplexStream(
                stream,
                options({ allowIncompleteFollowingFrame: value as unknown as boolean }),
            ),
        ).toThrow();
        expect(traps).not.toHaveBeenCalled();
        expect(registrations).not.toHaveBeenCalled();
        expect(stream.destroyCalls).toBe(1);
    });

    it('keeps end, finish, destroy and late-data behavior with a retained frame', async () => {
        const stream = new FakeStream();
        const onPush = vi.fn();
        const client = createRawMultiplexStream(
            stream,
            options({ allowIncompleteFollowingFrame: true, onPush }),
        );
        const result = client.transactRaw(request());
        await wrote(stream, 1);
        const following = frame(2, 42);
        stream.emit('data', Buffer.concat([frame(1, 17), following.subarray(0, 2)]));
        expect(await result).toMatchObject({ kind: 'response' });
        stream.emit('finish');
        expect(client.closed).toBe(false);
        stream.emit('end');
        expect(await client.whenClosed).toEqual({
            kind: 'protocol-error',
            code: 'truncated-stream',
        });
        expect(stream.destroyCalls).toBe(1);
        stream.emit('data', following.subarray(2));
        stream.finishClose();
        stream.emit('data', following);
        await turn();
        expect(onPush).not.toHaveBeenCalled();
        expect(await client.transactRaw(request())).toMatchObject({
            kind: 'failure',
            code: 'closed',
        });
        expect(stream.destroyCalls).toBe(1);
    });
});
