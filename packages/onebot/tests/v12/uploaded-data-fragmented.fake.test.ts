import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StoreModule = typeof import('../../src/v12/uploaded-data-store');
type Store = InstanceType<StoreModule['V12UploadedDataStore']>;
type Options = ConstructorParameters<StoreModule['V12UploadedDataStore']>[0];
type ReadKind = 'metadata' | 'chunk';

const MAX_BYTES = 256 * 1024;
const TTL_MS = 10 * 60 * 1000;
const INITIAL_TIME = 1_000_000;
const BINARY = new Uint8Array([0, 255, 128, 1, 2, 3, 10, 13, 47, 92, 127, 254, 0]);

let api: StoreModule;
let stores: Store[] = [];
let guards: Array<{ mock: { calls: unknown[] } }> = [];
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;

function blocked(): never {
    throw new Error('unexpected network or native operation in synthetic store test');
}

beforeEach(async () => {
    stores = [];
    fetchGuard = vi.fn(blocked);
    webSocketGuard = vi.fn(function ForbiddenWebSocket() {
        return blocked();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    guards = [
        vi.spyOn(net, 'createServer').mockImplementation(blocked),
        vi.spyOn(net, 'createConnection').mockImplementation(blocked),
        vi.spyOn(net, 'connect').mockImplementation(blocked),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(blocked),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(http, 'createServer').mockImplementation(blocked),
        vi.spyOn(http, 'request').mockImplementation(blocked),
        vi.spyOn(http, 'get').mockImplementation(blocked),
        vi.spyOn(https, 'createServer').mockImplementation(blocked),
        vi.spyOn(https, 'request').mockImplementation(blocked),
        vi.spyOn(https, 'get').mockImplementation(blocked),
        vi.spyOn(http2, 'createServer').mockImplementation(blocked),
        vi.spyOn(http2, 'createSecureServer').mockImplementation(blocked),
        vi.spyOn(http2, 'connect').mockImplementation(blocked),
        vi.spyOn(tls, 'createServer').mockImplementation(blocked),
        vi.spyOn(tls, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram, 'createSocket').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(blocked),
        vi.spyOn(process, 'dlopen').mockImplementation(blocked),
    ];

    // Only the real in-memory store is imported; guards are installed first.
    api = await import('../../src/v12/uploaded-data-store');
});

afterEach(() => {
    let closeFailures = 0;

    try {
        for (const store of stores) {
            try {
                store.close();
            } catch {
                closeFailures++;
            }
        }
    } finally {
        const calls = guards.map((guard) => guard.mock.calls.length);
        const fetchCalls = fetchGuard.mock.calls.length;
        const webSocketCalls = webSocketGuard.mock.calls.length;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        expect(closeFailures).toBe(0);
        expect(calls).toEqual(calls.map(() => 0));
        expect(fetchCalls).toBe(0);
        expect(webSocketCalls).toBe(0);
    }
});

function sequence(seed = 1): (size: number) => Uint8Array {
    let serial = seed;

    return (size) => {
        const bytes = new Uint8Array(size);
        const current = serial++;

        if (size >= 4) {
            new DataView(bytes.buffer).setUint32(0, current);
        }

        return bytes;
    };
}

function createStore(options: Options = {}): Store {
    const store = new api.V12UploadedDataStore({
        now: () => INITIAL_TIME,
        randomBytes: sequence(),
        ...options,
    });
    stores.push(store);
    return store;
}

function base64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function upload(store: Store, name: string, bytes: Uint8Array, digest?: string): string {
    const result = store.upload(name, base64(bytes), digest);

    if (result.kind !== 'ok') {
        throw new Error(`synthetic upload failed: ${result.kind}`);
    }

    return result.fileId;
}

function expectMetadata(store: Store, id: string, name: string, bytes: Uint8Array): void {
    const result = store.getMetadata(id);
    expect(result).toStrictEqual({
        kind: 'ok',
        name,
        totalSize: bytes.length,
        sha256: sha256(bytes),
    });
    expect(Reflect.ownKeys(result).sort()).toEqual(['kind', 'name', 'sha256', 'totalSize']);
}

function expectChunk(
    store: Store,
    id: string,
    bytes: Uint8Array,
    offset: number,
    size: number,
): string {
    const result = store.getChunk(id, offset, size);
    const expected = base64(bytes.subarray(offset, offset + size));
    expect(result).toStrictEqual({ kind: 'ok', data: expected });
    expect(Reflect.ownKeys(result).sort()).toEqual(['data', 'kind']);

    if (result.kind !== 'ok') {
        throw new Error(`synthetic chunk read failed: ${result.kind}`);
    }

    expect(typeof result.data).toBe('string');
    expect(Buffer.from(result.data, 'base64').toString('base64')).toBe(result.data);
    return result.data;
}

function guardedRead(store: Store, id: string, kind: ReadKind, guard: () => boolean) {
    return kind === 'metadata' ? store.getMetadata(id, guard) : store.getChunk(id, 1, 2, guard);
}

describe('V12 uploaded data fragments (isolated synthetic memory)', () => {
    it('returns exact metadata and empty-range shapes without exposing bytes or mutable buffers', () => {
        const store = createStore();
        const empty = new Uint8Array();
        const emptyId = upload(store, '', empty, sha256(empty));
        const name = '非ASCII-🪶.bin';
        const id = upload(store, name, BINARY, sha256(BINARY));

        expectMetadata(store, emptyId, '', empty);
        expectChunk(store, emptyId, empty, 0, 0);
        expectMetadata(store, id, name, BINARY);
        expectChunk(store, id, BINARY, 0, 0);
        expectChunk(store, id, BINARY, 4, 0);
        expectChunk(store, id, BINARY, BINARY.length, 0);
        expectChunk(store, id, BINARY, 1, 3);

        const metadata = store.getMetadata(id);
        const chunk = store.getChunk(id, 1, 3);

        if (metadata.kind !== 'ok' || chunk.kind !== 'ok') {
            throw new Error('synthetic reads unexpectedly failed');
        }

        metadata.name = 'caller mutation';
        metadata.totalSize = 0;
        metadata.sha256 = 'changed';
        chunk.data = 'changed';
        expectMetadata(store, id, name, BINARY);
        expectChunk(store, id, BINARY, 1, 3);
        expect(store.get(id)).toStrictEqual({
            kind: 'ok',
            name,
            data: base64(BINARY),
            sha256: sha256(BINARY),
        });
    });

    it.each([1, 2, 3])('reassembles %i-byte chunks across Base64 boundaries', (size) => {
        const store = createStore();
        const id = upload(store, 'binary', BINARY);
        const pieces: Buffer[] = [];

        for (let offset = 0; offset < BINARY.length; offset += size) {
            const count = Math.min(size, BINARY.length - offset);
            const encoded = expectChunk(store, id, BINARY, offset, count);
            pieces.push(Buffer.from(encoded, 'base64'));
        }

        const restored = Buffer.concat(pieces);
        expect(restored.equals(Buffer.from(BINARY))).toBe(true);
        expect(sha256(restored)).toBe(sha256(BINARY));
    });

    it('permits arbitrary ordering and repeated chunks without changing subsequent reads', () => {
        const store = createStore();
        const id = upload(store, 'out-of-order', BINARY);
        const ranges = [
            [9, 4],
            [0, 2],
            [5, 3],
            [2, 3],
            [9, 4],
            [8, 1],
            [0, 2],
        ];

        for (const [offset, size] of ranges) {
            expectChunk(store, id, BINARY, offset, size);
        }

        expectMetadata(store, id, 'out-of-order', BINARY);
        expect(store.get(id)).toStrictEqual({
            kind: 'ok',
            name: 'out-of-order',
            data: base64(BINARY),
            sha256: sha256(BINARY),
        });
    });

    it('accepts exactly 256 KiB, reconstructs it, and quantifies the last-byte and overrun boundaries', () => {
        const store = createStore();
        const bytes = new Uint8Array(MAX_BYTES);

        for (let index = 0; index < bytes.length; index++) {
            bytes[index] = (index * 73 + 11) & 0xff;
        }

        const id = upload(store, 'maximum', bytes);
        expectMetadata(store, id, 'maximum', bytes);
        expectChunk(store, id, bytes, 0, MAX_BYTES);
        expectChunk(store, id, bytes, MAX_BYTES - 1, 1);
        expectChunk(store, id, bytes, MAX_BYTES, 0);
        expectChunk(store, id, bytes, MAX_BYTES - 3, 3);

        const restored: Buffer[] = [];
        const stride = 8191;

        for (let offset = 0; offset < MAX_BYTES; offset += stride) {
            const size = Math.min(stride, MAX_BYTES - offset);
            restored.push(Buffer.from(expectChunk(store, id, bytes, offset, size), 'base64'));
        }

        const joined = Buffer.concat(restored);
        expect(joined.length).toBe(MAX_BYTES);
        expect(joined.equals(Buffer.from(bytes))).toBe(true);
        expect(sha256(joined)).toBe(sha256(bytes));

        for (const [offset, size] of [
            [0, MAX_BYTES + 1],
            [1, MAX_BYTES],
            [MAX_BYTES - 1, 2],
            [MAX_BYTES, 1],
            [MAX_BYTES + 1, 0],
            [Number.MAX_SAFE_INTEGER, 0],
            [0, Number.MAX_SAFE_INTEGER],
            [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
        ]) {
            expect(store.getChunk(id, offset, size)).toStrictEqual({ kind: 'invalid_range' });
        }

        expect(
            store.upload('one-byte-too-large', base64(new Uint8Array(MAX_BYTES + 1))),
        ).toStrictEqual({
            kind: 'invalid',
        });
        expectMetadata(store, id, 'maximum', bytes);
        expectChunk(store, id, bytes, MAX_BYTES - 1, 1);
        expect(store.get(id)).toStrictEqual({
            kind: 'ok',
            name: 'maximum',
            data: base64(bytes),
            sha256: sha256(bytes),
        });
    });

    it('checks zero-length ranges at both ends and rejects strictly out-of-bounds ranges', () => {
        const store = createStore();
        const empty = new Uint8Array();
        const emptyId = upload(store, 'empty', empty);
        const id = upload(store, 'binary', BINARY);
        const allow = vi.fn(() => true);

        expect(store.getChunk(emptyId, 0, 0, allow)).toStrictEqual({ kind: 'ok', data: '' });
        expect(allow).toHaveBeenCalledTimes(1);
        expect(store.getChunk(emptyId, 0, 0, () => false)).toStrictEqual({ kind: 'unavailable' });
        expect(store.getChunk(emptyId, 0, 1)).toStrictEqual({ kind: 'invalid_range' });
        expect(store.getChunk(emptyId, 1, 0)).toStrictEqual({ kind: 'invalid_range' });
        expectChunk(store, id, BINARY, -0, 0);
        expectChunk(store, id, BINARY, BINARY.length, 0);
        expect(store.getChunk(id, BINARY.length, 1)).toStrictEqual({ kind: 'invalid_range' });
        expect(store.getChunk(id, BINARY.length + 1, 0)).toStrictEqual({ kind: 'invalid_range' });
        expect(store.getChunk(id, BINARY.length - 1, 2)).toStrictEqual({ kind: 'invalid_range' });
        expectMetadata(store, emptyId, 'empty', empty);
        expectMetadata(store, id, 'binary', BINARY);
    });

    it('rejects non-primitive, non-finite, fractional, negative and unsafe ranges without coercion', () => {
        const store = createStore();
        const id = upload(store, 'traps', BINARY);
        const trap = vi.fn((): never => {
            throw new Error('numeric input was inspected or coerced');
        });
        const object = Object.create(null) as object;
        Object.defineProperties(object, {
            toString: { get: trap },
            valueOf: { get: trap },
            [Symbol.toPrimitive]: { get: trap },
        });
        const proxy = new Proxy(
            {},
            {
                get: trap,
                has: trap,
                ownKeys: trap,
                getPrototypeOf: trap,
                getOwnPropertyDescriptor: trap,
            },
        );
        const revoked = Proxy.revocable({}, {});
        revoked.revoke();
        const invalid: unknown[] = [
            undefined,
            null,
            false,
            true,
            '0',
            '',
            0n,
            Symbol('zero'),
            new Number(0),
            object,
            proxy,
            revoked.proxy,
            NaN,
            Infinity,
            -Infinity,
            0.5,
            -0.5,
            -1,
            Number.MAX_SAFE_INTEGER + 1,
            Number.MIN_SAFE_INTEGER - 1,
        ];

        for (const value of invalid) {
            expect(store.getChunk(id, value as number, 1)).toStrictEqual({ kind: 'invalid_range' });
            expect(store.getChunk(id, 0, value as number)).toStrictEqual({ kind: 'invalid_range' });
        }

        expect(trap).not.toHaveBeenCalled();
        expectChunk(store, id, BINARY, 0, 1);
        expectMetadata(store, id, 'traps', BINARY);
        expect(store.get(id).kind).toBe('ok');
        const next = upload(store, 'after-invalid', new Uint8Array([33]));
        expectChunk(store, next, new Uint8Array([33]), 0, 1);
    });

    it('distinguishes unknown, foreign and closed handles without coercing inputs', () => {
        const first = createStore({ randomBytes: sequence(1) });
        const second = createStore({ randomBytes: sequence(100) });
        const firstId = upload(first, 'first', BINARY);
        const secondId = upload(second, 'second', new Uint8Array([42]));
        const trap = vi.fn((): never => {
            throw new Error('file identifier was coerced');
        });
        const hostile = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });
        const revoked = Proxy.revocable({}, {});
        revoked.revoke();
        const missing: unknown[] = [
            '',
            'foreign-id',
            api.V12_UPLOAD_TOKEN_PREFIX,
            null,
            undefined,
            1,
            hostile,
            revoked.proxy,
        ];

        for (const value of missing) {
            expect(first.getMetadata(value as string)).toStrictEqual({ kind: 'not_found' });
            expect(first.getChunk(value as string, 0, 1)).toStrictEqual({ kind: 'not_found' });
        }

        expect(trap).not.toHaveBeenCalled();
        expect(first.getMetadata(secondId)).toStrictEqual({ kind: 'not_found' });
        expect(first.getChunk(secondId, 0, 1)).toStrictEqual({ kind: 'not_found' });
        expect(second.getMetadata(firstId)).toStrictEqual({ kind: 'not_found' });
        expect(second.getChunk(firstId, 0, 1)).toStrictEqual({ kind: 'not_found' });
        first.close();
        expect(first.getMetadata(firstId)).toStrictEqual({ kind: 'unavailable' });
        expect(first.getChunk(firstId, 0, 1)).toStrictEqual({ kind: 'unavailable' });
        expect(first.getMetadata('unknown')).toStrictEqual({ kind: 'unavailable' });
        expect(first.getChunk('unknown', 0, 0)).toStrictEqual({ kind: 'unavailable' });
        expect(first.get(firstId)).toStrictEqual({ kind: 'unavailable' });
        expect(first.upload('closed', '')).toStrictEqual({ kind: 'unavailable' });
        expectMetadata(second, secondId, 'second', new Uint8Array([42]));
    });

    it('checks a disclosure guard for hits, unknown IDs, and malformed IDs alike', () => {
        const store = createStore({ randomBytes: sequence(12) });
        const id = upload(store, 'guarded-miss', BINARY);
        const unknown = api.V12_UPLOAD_TOKEN_PREFIX + 'A'.repeat(43);
        expect(unknown).not.toBe(id);
        const revoked = Proxy.revocable({}, {});
        revoked.revoke();

        for (const candidate of [id, unknown, 'malformed', null, revoked.proxy]) {
            for (const kind of ['metadata', 'chunk'] as const) {
                const call = (guard: () => boolean) =>
                    kind === 'metadata'
                        ? store.getMetadata(candidate as string, guard)
                        : store.getChunk(candidate as string, 0, 1, guard);
                const deny = vi.fn(() => false);
                expect(call(deny)).toStrictEqual({ kind: 'unavailable' });
                expect(deny).toHaveBeenCalledOnce();
                const throws = vi.fn((): boolean => {
                    throw new Error('PRIVATE_SYNTHETIC_GUARD');
                });
                expect(call(throws)).toStrictEqual({ kind: 'unavailable' });
                expect(throws).toHaveBeenCalledOnce();
            }
        }

        const permit = vi.fn(() => true);
        expect(store.getMetadata(unknown, permit)).toStrictEqual({ kind: 'not_found' });
        expect(permit).toHaveBeenCalledOnce();
        const closeOnMiss = vi.fn(() => {
            store.close();
            return true;
        });
        expect(store.getChunk('malformed', 0, 1, closeOnMiss)).toStrictEqual({
            kind: 'unavailable',
        });
        expect(closeOnMiss).toHaveBeenCalledOnce();
    });

    it('keeps equal deterministic IDs local to their respective stores', () => {
        const first = createStore({ randomBytes: sequence(7) });
        const second = createStore({ randomBytes: sequence(7) });
        const firstBytes = new Uint8Array([0, 1, 255]);
        const secondBytes = new Uint8Array([128, 2, 3, 4]);
        const firstId = upload(first, 'first-content', firstBytes);
        const secondId = upload(second, 'second-content', secondBytes);

        expect(firstId).toBe(secondId);
        expectMetadata(first, firstId, 'first-content', firstBytes);
        expectMetadata(second, firstId, 'second-content', secondBytes);
        expectChunk(first, secondId, firstBytes, 0, firstBytes.length);
        expectChunk(second, firstId, secondBytes, 0, secondBytes.length);
        first.close();
        expect(first.getMetadata(firstId)).toStrictEqual({ kind: 'unavailable' });
        expectChunk(second, secondId, secondBytes, 1, 2);
        expectMetadata(second, secondId, 'second-content', secondBytes);
    });

    it('expires exactly at ten minutes without extending TTL on metadata or chunk reads', () => {
        let now = INITIAL_TIME;
        const store = createStore({ now: () => now });
        const metadataId = upload(store, 'old-metadata', BINARY);
        const chunkId = upload(store, 'old-chunk', BINARY);
        now++;
        const newer = upload(store, 'newer', new Uint8Array([99]));

        now = INITIAL_TIME + TTL_MS - 1;
        expectMetadata(store, metadataId, 'old-metadata', BINARY);
        expectChunk(store, chunkId, BINARY, 0, 1);
        now++;
        expect(store.getMetadata(metadataId)).toStrictEqual({ kind: 'not_found' });
        expect(store.getChunk(chunkId, 0, 1)).toStrictEqual({ kind: 'not_found' });
        expect(store.get(metadataId)).toStrictEqual({ kind: 'not_found' });
        expectMetadata(store, newer, 'newer', new Uint8Array([99]));
        now++;
        expect(store.getMetadata(newer)).toStrictEqual({ kind: 'not_found' });
        expect(store.getChunk(newer, 0, 1)).toStrictEqual({ kind: 'not_found' });
    });

    it('treats a stale true disclosure guard as a trusted-callback limitation', () => {
        const store = createStore();
        const id = upload(store, 'stale-guard', BINARY);
        let current = true;

        const stale = () => {
            current = false;
            return true;
        };

        expect(store.getChunk(id, 0, 1, stale)).toStrictEqual({
            kind: 'ok',
            data: Buffer.from(BINARY.subarray(0, 1)).toString('base64'),
        });
        expect(current).toBe(false);
        expect(store.getChunk(id, 0, 1, () => current)).toStrictEqual({ kind: 'unavailable' });
    });

    it('samples TTL at read entry, even if the synchronous guard crosses expiry', () => {
        let now = INITIAL_TIME;
        const store = createStore({ now: () => now });
        const id = upload(store, 'entry-sampled-ttl', BINARY);
        now = INITIAL_TIME + TTL_MS - 1;
        const crossing = vi.fn(() => {
            now = INITIAL_TIME + TTL_MS;
            return true;
        });
        expect(store.getChunk(id, 0, 1, crossing)).toStrictEqual({
            kind: 'ok',
            data: Buffer.from(BINARY.subarray(0, 1)).toString('base64'),
        });
        expect(crossing).toHaveBeenCalledOnce();
        expect(store.getMetadata(id)).toStrictEqual({ kind: 'not_found' });
    });

    it('fails closed for rollback or faulty clocks and recovers without losing retained data', () => {
        let now = INITIAL_TIME;
        let throws = false;
        const store = createStore({
            now: () => {
                if (throws) {
                    throw new Error('synthetic clock failure');
                }

                return now;
            },
        });
        const id = upload(store, 'clock', BINARY);

        for (const bad of [INITIAL_TIME - 1, NaN, Infinity, -Infinity, -1]) {
            now = bad;
            expect(store.getMetadata(id)).toStrictEqual({ kind: 'unavailable' });
            expect(store.getChunk(id, 0, 1)).toStrictEqual({ kind: 'unavailable' });
            expect(store.get(id)).toStrictEqual({ kind: 'unavailable' });
            expect(store.upload('clock-fault', '')).toStrictEqual({ kind: 'unavailable' });
        }

        now = INITIAL_TIME;
        throws = true;
        expect(store.getMetadata(id)).toStrictEqual({ kind: 'unavailable' });
        expect(store.getChunk(id, 0, 1)).toStrictEqual({ kind: 'unavailable' });
        throws = false;
        expectMetadata(store, id, 'clock', BINARY);
        expectChunk(store, id, BINARY, 0, 1);
        expect(store.get(id).kind).toBe('ok');
        const next = upload(store, 'clock-recovered', new Uint8Array([77]));
        expectMetadata(store, next, 'clock-recovered', new Uint8Array([77]));
    });

    it.each(['metadata', 'chunk'] as const)(
        'requires a true %s guard and never returns data for false, truthy or thrown guards',
        (kind) => {
            const store = createStore();
            const id = upload(store, 'guarded', BINARY);
            const allowed = vi.fn(() => true);
            const allowedResult = guardedRead(store, id, kind, allowed);
            expect(allowed).toHaveBeenCalledTimes(1);

            if (kind === 'metadata') {
                expect(allowedResult).toStrictEqual({
                    kind: 'ok',
                    name: 'guarded',
                    totalSize: BINARY.length,
                    sha256: sha256(BINARY),
                });
            } else {
                expect(allowedResult).toStrictEqual({
                    kind: 'ok',
                    data: base64(BINARY.subarray(1, 3)),
                });
            }

            const trap = vi.fn((): never => {
                throw new Error('guard result was inspected');
            });
            const truthyProxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });

            for (const outcome of [
                false,
                undefined,
                null,
                0,
                1,
                'true',
                new Boolean(true),
                truthyProxy,
            ]) {
                // A mock wrapper may inspect returned thenables itself. Count
                // calls without touching the untrusted result in the fixture.
                let calls = 0;

                const guard = () => {
                    calls += 1;
                    return outcome as boolean;
                };

                expect(guardedRead(store, id, kind, guard)).toStrictEqual({ kind: 'unavailable' });
                expect(calls).toBe(1);
            }

            const throwing = vi.fn((): never => {
                throw new Error('synthetic guard failure');
            });
            expect(guardedRead(store, id, kind, throwing)).toStrictEqual({ kind: 'unavailable' });
            expect(throwing).toHaveBeenCalledTimes(1);
            expect(trap).not.toHaveBeenCalled();
            expectMetadata(store, id, 'guarded', BINARY);
            expectChunk(store, id, BINARY, 1, 2);
            expect(store.get(id).kind).toBe('ok');
        },
    );

    it.each(['metadata', 'chunk'] as const)(
        'enforces busy against nested get, upload and both fragment reads inside a %s guard',
        (kind) => {
            const store = createStore();
            const id = upload(store, 'outer', BINARY);
            const nested: unknown[] = [];
            const guard = vi.fn(() => {
                nested.push(store.get(id));
                nested.push(store.upload('nested', 'AQ=='));
                nested.push(store.getMetadata(id));
                nested.push(store.getChunk(id, 0, 1));
                return true;
            });
            const result = guardedRead(store, id, kind, guard);

            expect(guard).toHaveBeenCalledTimes(1);
            expect(result.kind).toBe('ok');
            expect(nested).toStrictEqual([
                { kind: 'unavailable' },
                { kind: 'unavailable' },
                { kind: 'unavailable' },
                { kind: 'unavailable' },
            ]);
            expectMetadata(store, id, 'outer', BINARY);
            expectChunk(store, id, BINARY, 1, 2);
            const next = upload(store, 'after-busy', new Uint8Array([8]));
            expectChunk(store, next, new Uint8Array([8]), 0, 1);
        },
    );

    it.each(['metadata', 'chunk'] as const)(
        'discards a %s result if its guard closes the store before returning true',
        (kind) => {
            const store = createStore();
            const id = upload(store, 'closing', BINARY);
            const guard = vi.fn(() => {
                store.close();
                return true;
            });

            expect(guardedRead(store, id, kind, guard)).toStrictEqual({ kind: 'unavailable' });
            expect(guard).toHaveBeenCalledTimes(1);
            expect(store.getMetadata(id)).toStrictEqual({ kind: 'unavailable' });
            expect(store.getChunk(id, 0, 1)).toStrictEqual({ kind: 'unavailable' });
            expect(store.get(id)).toStrictEqual({ kind: 'unavailable' });
            expect(store.upload('closed', '')).toStrictEqual({ kind: 'unavailable' });
        },
    );

    it.each(['metadata', 'chunk'] as const)(
        'discards a %s result if the injected clock closes the store',
        (kind) => {
            let armed = false;
            let store!: Store;
            store = createStore({
                now: () => {
                    if (armed) {
                        armed = false;
                        store.close();
                    }

                    return INITIAL_TIME;
                },
            });
            const id = upload(store, 'clock-close', BINARY);
            armed = true;
            const result = kind === 'metadata' ? store.getMetadata(id) : store.getChunk(id, 0, 1);
            expect(armed).toBe(false);
            expect(result).toStrictEqual({ kind: 'unavailable' });
            expect(store.getMetadata(id)).toStrictEqual({ kind: 'unavailable' });
            expect(store.getChunk(id, 0, 1)).toStrictEqual({ kind: 'unavailable' });
        },
    );

    it('encodes only requested byte ranges, including 1/2/3-byte slices of a 256 KiB file', async () => {
        const bytes = new Uint8Array(MAX_BYTES);

        for (let index = 0; index < bytes.length; index++) {
            bytes[index] = (index * 17 + 3) & 0xff;
        }

        const ranges = [
            [1, 1],
            [2, 2],
            [3, 3],
            [MAX_BYTES - 3, 3],
        ];
        const expected = ranges.map(([offset, size]) =>
            base64(bytes.subarray(offset, offset + size)),
        );
        const originalToString = Buffer.prototype.toString;
        const encodings: Array<{ byteLength: number; start: number; end: number }> = [];
        const results: unknown[] = [];
        let metadata: unknown;
        let armed = false;
        const spy = vi.spyOn(Buffer.prototype, 'toString').mockImplementation(function (
            this: Buffer,
            ...args: Parameters<typeof Buffer.prototype.toString>
        ) {
            if (armed && args[0] === 'base64') {
                encodings.push({
                    byteLength: this.length,
                    start: args[1] ?? 0,
                    end: args[2] ?? this.length,
                });
            }

            return Reflect.apply(originalToString, this, args) as string;
        });

        try {
            // The store captures Buffer.prototype.toString during module evaluation.
            // Isolate the fresh import and restore the global intrinsic immediately.
            vi.resetModules();
            const fresh = await import('../../src/v12/uploaded-data-store');
            const store = new fresh.V12UploadedDataStore({
                now: () => INITIAL_TIME,
                randomBytes: sequence(),
            });
            stores.push(store);
            const id = upload(store, 'bounded-encoding', bytes);
            armed = true;
            metadata = store.getMetadata(id);

            for (const [offset, size] of ranges) {
                results.push(store.getChunk(id, offset, size));
            }

            armed = false;
            store.close();
        } finally {
            armed = false;
            spy.mockRestore();
            vi.resetModules();
        }

        expect(metadata).toStrictEqual({
            kind: 'ok',
            name: 'bounded-encoding',
            totalSize: MAX_BYTES,
            sha256: sha256(bytes),
        });
        expect(results).toStrictEqual(expected.map((data) => ({ kind: 'ok', data })));
        expect(encodings.length).toBe(ranges.length);

        for (let index = 0; index < ranges.length; index++) {
            const [offset, size] = ranges[index];
            const call = encodings[index];
            expect(call.end - call.start).toBe(size);
            expect(
                call.byteLength === size || (call.start === offset && call.end === offset + size),
            ).toBe(true);
        }
    });

    it('seals immediately and attempts to erase all retained buffers after a wipe fault', async () => {
        const originalFill = Uint8Array.prototype.fill;
        const attempted: number[] = [];
        const wiped: number[][] = [];
        let armed = false;
        let injected = false;
        let store!: Store;
        let ids: string[] = [];
        const spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            ...args: Parameters<typeof Uint8Array.prototype.fill>
        ) {
            if (armed && args[0] === 0 && (this.length === 17 || this.length === 23)) {
                attempted.push(this.length);

                if (!injected) {
                    injected = true;
                    throw new Error('synthetic wipe fault');
                }

                const result = Reflect.apply(originalFill, this, args) as Uint8Array;
                wiped.push(Array.from(this));
                return result;
            }

            return Reflect.apply(originalFill, this, args) as Uint8Array;
        });

        try {
            // As with Base64 encoding, capture the observer at module load time.
            vi.resetModules();
            const fresh = await import('../../src/v12/uploaded-data-store');
            store = new fresh.V12UploadedDataStore({
                now: () => INITIAL_TIME,
                randomBytes: sequence(),
            });
            stores.push(store);
            const first = new Uint8Array(17);
            const second = new Uint8Array(23);
            first[0] = 255;
            second[0] = 128;
            ids = [upload(store, 'wipe-17', first), upload(store, 'wipe-23', second)];
            armed = true;
            store.close();
        } finally {
            armed = false;
            spy.mockRestore();
            vi.resetModules();
        }

        expect(injected).toBe(true);
        expect(attempted.sort((a, b) => a - b)).toEqual([17, 23]);
        expect(wiped.length).toBe(1);
        expect(wiped[0].every((byte) => byte === 0)).toBe(true);

        for (const id of ids) {
            expect(store.getMetadata(id)).toStrictEqual({ kind: 'unavailable' });
            expect(store.getChunk(id, 0, 1)).toStrictEqual({ kind: 'unavailable' });
            expect(store.get(id)).toStrictEqual({ kind: 'unavailable' });
        }
    });
});
