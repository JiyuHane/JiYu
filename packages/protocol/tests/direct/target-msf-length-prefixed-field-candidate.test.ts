import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeTargetMsfLengthPrefixedFieldCandidate as encode } from '../../src/direct/target-msf-length-prefixed-field-candidate';

// Synthetic model only: this asserts an offline length-prefixed framing of a
// single payload field, BE32(payload.length + 4) || payload, where the 32-bit
// big-endian prefix is the total frame length and therefore includes its own
// four bytes. It does not claim a real login, a real MSF/SSO packet, target
// reachability, QQ interoperability, or any branch condition of a production
// encoder. Every input below is a fabricated local fixture.
const PREFIX_BYTES = 4;
const ERROR = 'target MSF length-prefixed field candidate failed';
const PRIVATE = 'synthetic-private-marker';
const originalSet = Uint8Array.prototype.set;

let guards: Array<{ mock: { calls: readonly unknown[] } }> = [];

function bytes(values: number[]): Uint8Array {
    return Uint8Array.from(values);
}

function ramp(length: number, seed = 1): Uint8Array {
    // Deterministic nonzero fill so copied bytes are visible against the prefix.
    return Uint8Array.from({ length }, (_, index) => (index * 37 + seed * 11) & 0xff || 0xa5);
}

// Independent oracle: build BE32(total) || payload where total = length + 4.
function encodeOracle(payload: Uint8Array): Uint8Array {
    const total = payload.length + PREFIX_BYTES;
    const out = new Uint8Array(total);
    out[0] = (total >>> 24) & 0xff;
    out[1] = (total >>> 16) & 0xff;
    out[2] = (total >>> 8) & 0xff;
    out[3] = total & 0xff;
    out.set(payload, PREFIX_BYTES);
    return out;
}

function readPrefix(frame: Uint8Array): number {
    return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
}

function expectFailure(operation: () => unknown): void {
    let caught: unknown;

    try {
        operation();
    } catch (error) {
        caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toBe(ERROR);
    expect(error.cause).toBeUndefined();
    expect(error.stack ?? '').not.toContain(PRIVATE);
}

function blocked(): never {
    throw new Error('unexpected effect');
}

beforeEach(() => {
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

describe('offline target MSF length-prefixed field candidate', () => {
    it('frames fixed vectors byte for byte, prefix included in its own count', () => {
        // Empty payload -> total 4 -> 00 00 00 04, no body.
        const empty = encode(new Uint8Array(0));
        expect(empty).toBeInstanceOf(Uint8Array);
        expect(Buffer.isBuffer(empty)).toBe(false);
        expect(empty).toHaveLength(PREFIX_BYTES);
        expect(Array.from(empty)).toEqual([0x00, 0x00, 0x00, 0x04]);

        // "abc" -> total 7 -> 00 00 00 07 61 62 63.
        const abc = encode(bytes([0x61, 0x62, 0x63]));
        expect(abc).toHaveLength(7);
        expect(Array.from(abc)).toEqual([0x00, 0x00, 0x00, 0x07, 0x61, 0x62, 0x63]);

        // Arbitrary binary payload including 0x00 and 0xff: prefix = len + 4 BE,
        // body is the original bytes verbatim. Assert every byte individually.
        const binary = bytes([0x00, 0xff, 0x00, 0xff, 0x7f, 0x80, 0x01, 0x00]);
        const framed = encode(binary);
        const total = binary.length + PREFIX_BYTES;
        expect(framed).toHaveLength(total);
        expect(framed[0]).toBe((total >>> 24) & 0xff);
        expect(framed[1]).toBe((total >>> 16) & 0xff);
        expect(framed[2]).toBe((total >>> 8) & 0xff);
        expect(framed[3]).toBe(total & 0xff);

        for (let index = 0; index < binary.length; index++) {
            expect(framed[PREFIX_BYTES + index]).toBe(binary[index]);
        }

        expect(framed).toEqual(encodeOracle(binary));
    });

    it('writes the prefix big-endian when the total crosses byte boundaries', () => {
        // len 252 -> total 256 = 0x00000100 -> exact prefix 00 00 01 00.
        const a = encode(ramp(252, 3));
        expect(Array.from(a.subarray(0, PREFIX_BYTES))).toEqual([0x00, 0x00, 0x01, 0x00]);

        // len 65532 -> total 65536 = 0x00010000 -> exact prefix 00 01 00 00.
        const b = encode(ramp(65532, 5));
        expect(Array.from(b.subarray(0, PREFIX_BYTES))).toEqual([0x00, 0x01, 0x00, 0x00]);

        // len 74561 -> total 74565 = 0x00012345 -> three distinct nonzero bytes.
        const c = encode(ramp(74561, 7));
        expect(Array.from(c.subarray(0, PREFIX_BYTES))).toEqual([0x00, 0x01, 0x23, 0x45]);

        for (const frame of [a, b, c]) {
            expect(readPrefix(frame)).toBe(frame.length);
        }
    });

    it('round-trips: the decoded prefix equals len+4 and the body equals the payload', () => {
        const cases: Uint8Array[] = [
            new Uint8Array(0),
            bytes([0x11]),
            bytes([0x00, 0xff, 0x7f, 0x80]),
            ramp(1, 1),
            ramp(255, 2),
            ramp(256, 3),
            ramp(1000, 4),
        ];

        for (const payload of cases) {
            const frame = encode(payload);

            expect(frame).toBeInstanceOf(Uint8Array);
            expect(Buffer.isBuffer(frame)).toBe(false);
            expect(frame).toHaveLength(payload.length + PREFIX_BYTES);

            // Parse the big-endian prefix straight out of the output bytes.
            expect(readPrefix(frame)).toBe(payload.length + PREFIX_BYTES);

            // The trailing region is the original payload, byte for byte.
            const body = frame.subarray(PREFIX_BYTES);
            expect(body).toHaveLength(payload.length);

            for (let index = 0; index < payload.length; index++) {
                expect(body[index]).toBe(payload[index]);
            }

            expect(Uint8Array.from(body)).toEqual(Uint8Array.from(payload));
            expect(frame).toEqual(encodeOracle(payload));
        }
    });

    it('returns an independent result that does not alias the input payload', () => {
        const payload = ramp(24, 1);
        const before = Uint8Array.from(payload);
        const expected = encodeOracle(before);

        const frame = encode(payload);
        expect(frame).toEqual(expected);
        expect(frame.buffer).not.toBe(payload.buffer);

        // Mutating the input after the call must not change the returned frame.
        payload.fill(0xee);
        expect(frame).toEqual(expected);

        // Mutating the result must not reach back into the input.
        const second = encode(before);
        const inputSnapshot = Uint8Array.from(before);
        second.fill(0x55);
        expect(before).toEqual(inputSnapshot);
    });

    it('returns distinct non-aliased buffers for repeated calls', () => {
        const payload = ramp(16, 4);
        const a = encode(payload);
        const b = encode(payload);
        expect(a.buffer).not.toBe(b.buffer);
        a.fill(0x77);
        expect(b).toEqual(encodeOracle(payload));
    });

    it('accepts an unaligned Buffer subview, reading only the selected range', () => {
        const backing = Buffer.alloc(3 + 10 + 4, 0xd7);
        const payload = backing.subarray(3, 3 + 10);
        payload.set(ramp(10, 2));
        const backingBefore = Buffer.from(backing);

        const frame = encode(payload);
        expect(frame).toEqual(encodeOracle(Uint8Array.from(payload)));
        expect(frame.buffer).not.toBe(backing.buffer);
        expect(Buffer.isBuffer(frame)).toBe(false);
        // The bytes outside the selected window are untouched.
        expect(backing).toEqual(backingBefore);
    });

    it('accepts an unaligned Uint8Array subview over a dirty backing store', () => {
        const backing = new Uint8Array(5 + 12 + 6).fill(0xc3);
        const payload = backing.subarray(5, 5 + 12);
        payload.set(ramp(12, 6));
        const backingBefore = Uint8Array.from(backing);

        const frame = encode(payload);
        expect(frame).toEqual(encodeOracle(Uint8Array.from(payload)));
        expect(backing).toEqual(backingBefore);
        expect(frame.buffer).not.toBe(backing.buffer);
    });

    it('accepts a cross-realm subview and reads only its own range', () => {
        const payload = runInNewContext(
            `new Uint8Array(2 + 14 + 2).map((_, i) => (i * 17 + 1) & 255).subarray(2, 2 + 14)`,
        ) as Uint8Array;
        const expected = encodeOracle(Uint8Array.from(payload));

        const frame = encode(payload);
        expect(frame).toEqual(expected);
        expect(readPrefix(frame)).toBe(payload.length + PREFIX_BYTES);
    });

    it('accepts a cross-realm subview without reading hostile own accessors', () => {
        const payload = runInNewContext(
            `new Uint8Array(1 + 9 + 1).map((_, i) => (i * 29 + 3) & 255).subarray(1, 1 + 9)`,
        ) as Uint8Array;
        const expected = encodeOracle(Uint8Array.from(payload));
        const trap = vi.fn(() => {
            throw new Error(PRIVATE);
        });

        for (const key of [
            'length',
            'byteLength',
            'byteOffset',
            'buffer',
            'constructor',
            'set',
            'fill',
            'slice',
            'subarray',
            Symbol.iterator,
            Symbol.toStringTag,
        ]) {
            Object.defineProperty(payload, key, { get: trap, configurable: false });
        }

        Object.preventExtensions(payload);

        expect(encode(payload)).toEqual(expected);
        expect(trap).not.toHaveBeenCalled();
        expect(trap.mock.calls).toHaveLength(0);
    });

    it('ignores shadow accessors defined on an otherwise-valid payload', () => {
        const payload = ramp(18, 3);
        const expected = encodeOracle(Uint8Array.from(payload));
        const trap = vi.fn(() => {
            throw new Error(PRIVATE);
        });

        for (const key of [
            'length',
            'byteLength',
            'byteOffset',
            'buffer',
            'set',
            'fill',
            'slice',
        ]) {
            Object.defineProperty(payload, key, { get: trap, configurable: false });
        }

        expect(encode(payload)).toEqual(expected);
        expect(trap).not.toHaveBeenCalled();
        expect(trap.mock.calls).toHaveLength(0);
    });

    it('rejects wrong-typed, proxy and revoked inputs with the fixed error', () => {
        const trap = vi.fn(() => {
            throw new Error(PRIVATE);
        });
        const proxy = new Proxy(new Uint8Array(4), {
            get: trap,
            getPrototypeOf: trap,
            ownKeys: trap,
        });
        const revoked = Proxy.revocable(new Uint8Array(4), {});
        revoked.revoke();

        const invalidValues: unknown[] = [
            null,
            undefined,
            {},
            [],
            'private',
            0,
            new ArrayBuffer(16),
            new DataView(new ArrayBuffer(16)),
            new Uint8ClampedArray(16),
            new Int8Array(16),
            proxy,
            revoked.proxy,
        ];

        for (const value of invalidValues) {
            expectFailure(() => encode(value as unknown as Uint8Array));
        }

        expect(trap).not.toHaveBeenCalled();
        expect(trap.mock.calls).toHaveLength(0);
    });

    it('rejects shared, detached and out-of-bounds views with the fixed error', () => {
        const detached = new Uint8Array(4);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });

        const resizable = new ArrayBuffer(4, { maxByteLength: 5 });
        const oob = new Uint8Array(resizable, 0, 4);
        resizable.resize(3);

        const hostile: unknown[] = [
            new Uint8Array(new SharedArrayBuffer(4)),
            runInNewContext(`new Uint8Array(new SharedArrayBuffer(4))`) as Uint8Array,
            detached,
            oob,
        ];

        for (const value of hostile) {
            expectFailure(() => encode(value as unknown as Uint8Array));
        }
    });

    it('rejects a payload whose reported length exceeds the 0xffffffff-4 ceiling', async () => {
        // A >4 GiB payload cannot be allocated, so model an over-ceiling length
        // by temporarily replacing the %TypedArray%.prototype `byteLength` getter
        // that the module captures at import time. A sentinel array reports a
        // length above the documented local cap (0xffffffff - 4); every other
        // array delegates to the genuine getter. Number.MAX_SAFE_INTEGER both
        // exceeds the cap and exceeds the maximum typed-array length, so any path
        // -- the pre-allocation cap check or an allocation attempt -- surfaces the
        // same fixed error without reserving any real memory.
        const typedProto = Object.getPrototypeOf(Uint8Array.prototype) as object;
        const original = Object.getOwnPropertyDescriptor(typedProto, 'byteLength')!;
        const sentinel = new Uint8Array(8);
        const OVER = Number.MAX_SAFE_INTEGER;
        Object.defineProperty(typedProto, 'byteLength', {
            configurable: true,
            enumerable: original.enumerable,
            get(this: unknown) {
                if (this === sentinel) {
                    return OVER;
                }

                return original.get!.call(this);
            },
        });

        try {
            vi.resetModules();
            const fresh =
                await import('../../src/direct/target-msf-length-prefixed-field-candidate');
            expectFailure(() => fresh.encodeTargetMsfLengthPrefixedFieldCandidate(sentinel));
        } finally {
            Object.defineProperty(typedProto, 'byteLength', original);
        }
    });

    it('clears owned private allocations and leaves the input intact when a copy throws', async () => {
        const payload = ramp(20, 1);
        const before = Uint8Array.from(payload);
        const owned: Uint8Array[] = [];
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            offset,
        ) {
            originalSet.call(this, source, offset);

            if (this !== payload && this instanceof Uint8Array) {
                owned.push(this);

                if (owned.length === 1) {
                    throw new Error(PRIVATE);
                }
            }
        });

        try {
            vi.resetModules();
            const fresh =
                await import('../../src/direct/target-msf-length-prefixed-field-candidate');
            expectFailure(() => fresh.encodeTargetMsfLengthPrefixedFieldCandidate(payload));
        } finally {
            spy.mockRestore();
        }

        // At least one owned allocation was produced and every one was zeroed.
        expect(owned.length).toBeGreaterThanOrEqual(1);

        for (const allocation of owned) {
            expect(allocation).toEqual(new Uint8Array(allocation.length));
        }

        // The input payload is never written during a failed encode.
        expect(payload).toEqual(before);
    });
});
