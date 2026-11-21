import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { placeTargetSignedDecimalMd5SlotCandidate as place } from '../../src/direct/target-signed-decimal-md5-slot-candidate';

const state = vi.hoisted(() => ({
    calls: [] as number[],
    digest: undefined as Uint8Array | undefined,
    fail: false,
}));

// Delegate to the real candidate; its fixed standard vectors below are the oracle.
vi.mock('../../src/direct/target-signed-decimal-md5-candidate', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('../../src/direct/target-signed-decimal-md5-candidate')
        >();
    return {
        ...actual,
        targetSignedDecimalMd5Candidate(bits: number) {
            state.calls.push(bits);

            if (state.fail) {
                throw new Error('private backend failure 4294967295');
            }

            state.digest = actual.targetSignedDecimalMd5Candidate(bits);
            return state.digest;
        },
    };
});

// Synthetic bytes only: target branch conditions and reachability are unknown;
// this does not establish a login result, target output, or a final signature.
// Independently computed offline by Node crypto and .NET MD5 over the literals.
const vectors = [
    { bits: 0, md5: 'cfcd208495d565ef66e7dff9f98764da' }, // "0"
    { bits: 0x80000000, md5: '034ff5946105f089278eea60c488a90b' }, // "-2147483648"
    { bits: 0xffffffff, md5: '6bb61e3b7bce0931da574d19d1d82c88' }, // "-1"
    { bits: 0x7fffffff, md5: 'c588c0a459f4ccc6f3dd26518d24707a' }, // "2147483647"
] as const;
const failure = 'target signed decimal MD5 slot candidate failed';
const length = 0x300;
const originalSet = Uint8Array.prototype.set;
const originalFill = Uint8Array.prototype.fill;
let guards: Array<{ mock: { calls: readonly unknown[] } }> = [];

function syntheticBytes(): Uint8Array {
    return Uint8Array.from({ length }, (_, index) => (index * 73 + 0x81) & 0xff);
}

function expectedBytes(source: Uint8Array, hex: string): Uint8Array {
    const expected = Uint8Array.from(source);
    expected.set(Buffer.from(hex, 'hex'), 0x200);
    expected[0x2ff] = 16;
    return expected;
}

function errorFrom(operation: () => unknown): Error {
    let caught: unknown;

    try {
        operation();
    } catch (error) {
        caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toBe(failure);
    expect(error.cause).toBeUndefined();
    expect(error.stack ?? '').not.toMatch(/private|4294967295|synthetic secret/);
    return error;
}

function blocked(): never {
    throw new Error('unexpected effect');
}

beforeEach(() => {
    state.calls.length = 0;
    state.digest = undefined;
    state.fail = false;
    guards = [
        vi.spyOn(net, 'connect').mockImplementation(blocked),
        vi.spyOn(net, 'createConnection').mockImplementation(blocked),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(blocked),
        vi.spyOn(http, 'request').mockImplementation(blocked),
        vi.spyOn(http, 'get').mockImplementation(blocked),
        vi.spyOn(https, 'request').mockImplementation(blocked),
        vi.spyOn(https, 'get').mockImplementation(blocked),
        vi.spyOn(tls, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram, 'createSocket').mockImplementation(blocked),
        vi.spyOn(process, 'dlopen').mockImplementation(blocked),
        vi.spyOn(console, 'log').mockImplementation(() => {}),
        vi.spyOn(console, 'warn').mockImplementation(() => {}),
        vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];
    const fetch = vi.fn(blocked);
    const webSocket = vi.fn(blocked);
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('WebSocket', webSocket);
    guards.push(fetch, webSocket);
    syncBuiltinESMExports();
});

afterEach(() => {
    try {
        for (const guard of guards) {
            expect(guard.mock.calls).toHaveLength(0);
        }
    } finally {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        syncBuiltinESMExports();
        guards = [];
    }
});

describe('offline signed-decimal MD5 slot candidate', () => {
    it.each(vectors)(
        'copies the exact snapshot and places the raw vector for $bits',
        ({ bits, md5 }) => {
            const source = syntheticBytes();
            const before = Uint8Array.from(source);
            const result = place(source, bits);
            expect(result).toBeInstanceOf(Uint8Array);
            expect(Buffer.isBuffer(result)).toBe(false);
            expect(result).toHaveLength(length);
            expect(result).toEqual(expectedBytes(before, md5));
            expect(source).toEqual(before);
            expect(result).not.toBe(source);
            expect(result.buffer).not.toBe(source.buffer);
            expect(state.calls).toEqual([bits]);
            expect(state.digest).toEqual(new Uint8Array(16));
        },
    );

    it('snapshots an unaligned Buffer subview with non-UTF8 bytes and preserves sentinels', () => {
        const backing = Buffer.alloc(length + 8, 0xed);
        const source = backing.subarray(3, 3 + length);
        source.set(syntheticBytes());
        const before = Buffer.from(backing);
        const result = place(source, 0xffffffff);
        const expected = expectedBytes(Uint8Array.from(source), vectors[2].md5);
        expect(result).toEqual(expected);
        expect(backing).toEqual(before);
        expect(result.buffer).not.toBe(backing.buffer);
        source.fill(0x11);
        expect(result).toEqual(expected);
        result.fill(0x22);
        expect(Array.from(source)).toEqual(new Array(length).fill(0x11));
        expect(Array.from(backing.subarray(0, 3))).toEqual([0xed, 0xed, 0xed]);
        expect(Array.from(backing.subarray(3 + length))).toEqual(new Array(5).fill(0xed));
    });

    it('accepts a cross-realm readonly-shadow subview without consulting its properties', () => {
        const foreign = runInNewContext(
            `new Uint8Array(${length + 2}).map((_, i) => (i * 31 + 0x80) & 255).subarray(1, ${length + 1})`,
        ) as Uint8Array;
        const before = Uint8Array.from(foreign);
        const accessed = vi.fn(() => {
            throw new Error('synthetic secret');
        });

        for (const key of [
            'length',
            'byteLength',
            'byteOffset',
            'buffer',
            'set',
            'fill',
            Symbol.iterator,
            Symbol.toStringTag,
        ]) {
            Object.defineProperty(foreign, key, { get: accessed, configurable: false });
        }

        Object.preventExtensions(foreign);
        const result = place(foreign, 0x80000000);
        expect(result).toEqual(expectedBytes(before, vectors[1].md5));
        expect(Array.from({ length }, (_, i) => foreign[i])).toEqual(Array.from(before));
        expect(accessed).not.toHaveBeenCalled();
    });

    it('returns distinct snapshots for repeated calls and never aliases its inputs or temporary digest', () => {
        const source = syntheticBytes();
        const expected = expectedBytes(source, vectors[0].md5);
        const a = place(source, 0);
        const firstDigest = state.digest;
        const b = place(source, 0);
        expect(a).toEqual(expected);
        expect(b).toEqual(expected);
        expect(a.buffer).not.toBe(b.buffer);
        expect(a.buffer).not.toBe(source.buffer);
        expect(a.buffer).not.toBe(firstDigest?.buffer);
        a.fill(0xaa);
        expect(b).toEqual(expected);
        expect(source).toEqual(syntheticBytes());
        source.fill(0xbb);
        expect(b).toEqual(expected);
    });

    it('rejects invalid bit patterns without coercion, leakage, mutation, or hashing', () => {
        const coerce = vi.fn(() => {
            throw new Error('synthetic secret');
        });
        const hostile = { valueOf: coerce, toString: coerce, [Symbol.toPrimitive]: coerce };
        const proxy = new Proxy(hostile, { get: coerce, getPrototypeOf: coerce });
        const revoked = Proxy.revocable(hostile, {});
        revoked.revoke();
        const invalid: unknown[] = [
            -1,
            -0,
            -0.5,
            0.5,
            NaN,
            Infinity,
            -Infinity,
            0x100000000,
            Number.MAX_SAFE_INTEGER,
            '0',
            0n,
            Object(1),
            null,
            undefined,
            true,
            Symbol('private'),
            hostile,
            proxy,
            revoked.proxy,
        ];
        const source = syntheticBytes();
        const before = Uint8Array.from(source);

        for (const bits of invalid) {
            errorFrom(() => place(source, bits as number));
            expect(source).toEqual(before);
        }

        expect(coerce).not.toHaveBeenCalled();
        expect(state.calls).toHaveLength(invalid.length);
        expect(state.digest).toBeUndefined();
    });

    it('rejects wrong-sized and wrong-typed output, including hostile proxies, before hashing', () => {
        const trap = vi.fn(() => {
            throw new Error('synthetic secret');
        });
        const proxy = new Proxy(syntheticBytes(), {
            get: trap,
            getPrototypeOf: trap,
            ownKeys: trap,
        });
        const revoked = Proxy.revocable(syntheticBytes(), {});
        revoked.revoke();
        const invalid: unknown[] = [
            null,
            undefined,
            {},
            [],
            'private',
            new ArrayBuffer(length),
            new DataView(new ArrayBuffer(length)),
            new Uint8ClampedArray(length),
            new Int8Array(length),
            new Uint8Array(length - 1),
            new Uint8Array(length + 1),
            proxy,
            revoked.proxy,
        ];

        for (const output of invalid) {
            errorFrom(() => place(output as Uint8Array, 0));
        }

        expect(trap).not.toHaveBeenCalled();
        expect(state.calls).toHaveLength(0);
    });

    it('rejects shared, detached and out-of-bounds storage without hashing', () => {
        const detached = syntheticBytes();
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const oobBuffer = new ArrayBuffer(length, { maxByteLength: length + 1 });
        const oob = new Uint8Array(oobBuffer, 0, length);
        oobBuffer.resize(length - 1);
        const values = [
            new Uint8Array(new SharedArrayBuffer(length)),
            runInNewContext(`new Uint8Array(new SharedArrayBuffer(${length}))`) as Uint8Array,
            detached,
            oob,
        ];

        for (const output of values) {
            errorFrom(() => place(output, 0));
        }

        expect(state.calls).toHaveLength(0);
    });

    it('sanitizes a digest provider failure and preserves the original bytes', () => {
        const source = syntheticBytes();
        const before = Uint8Array.from(source);
        state.fail = true;
        errorFrom(() => place(source, 0xffffffff));
        expect(state.calls).toEqual([0xffffffff]);
        expect(source).toEqual(before);
    });

    it('clears both private allocations when the second snapshot copy throws', async () => {
        const source = syntheticBytes();
        const before = Uint8Array.from(source);
        const owned: Uint8Array[] = [];
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            bytes,
            offset,
        ) {
            originalSet.call(this, bytes, offset);

            if (this.length === length && this !== source) {
                owned.push(this);

                if (owned.length === 2) {
                    throw new Error('private copy failure');
                }
            }
        });

        try {
            vi.resetModules();
            const fresh = await import('../../src/direct/target-signed-decimal-md5-slot-candidate');
            errorFrom(() => fresh.placeTargetSignedDecimalMd5SlotCandidate(source, 0xffffffff));
        } finally {
            spy.mockRestore();
        }

        expect(owned).toHaveLength(2);
        expect(owned[0]).toEqual(new Uint8Array(length));
        expect(owned[1]).toEqual(new Uint8Array(length));
        expect(source).toEqual(before);
    });

    it('keeps the successful snapshot when digest cleanup throws', async () => {
        const source = syntheticBytes();
        const expected = expectedBytes(source, vectors[0].md5);
        let attempted = 0;
        const spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value,
            start,
            end,
        ) {
            if (this === state.digest) {
                attempted++;
                throw new Error('private cleanup failure');
            }

            return originalFill.call(this, value, start, end);
        });

        try {
            vi.resetModules();
            const fresh = await import('../../src/direct/target-signed-decimal-md5-slot-candidate');
            expect(fresh.placeTargetSignedDecimalMd5SlotCandidate(source, 0)).toEqual(expected);
        } finally {
            spy.mockRestore();

            if (state.digest) {
                originalFill.call(state.digest, 0);
            }
        }

        expect(attempted).toBe(1);
        expect(source).toEqual(syntheticBytes());
    });
});
