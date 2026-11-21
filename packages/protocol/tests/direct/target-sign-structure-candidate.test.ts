import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleTargetSignStructureCandidate as place } from '../../src/direct/target-sign-structure-candidate';

// Synthetic model only: this asserts an offline 0x300-byte sign-structure layout.
// It does not claim a real login, a real signature, target reachability, or any
// branch condition of the production signer. All inputs below are fabricated.
const OUTPUT_LENGTH = 0x300;
const SLOT_CAPACITY = 255;
const ERROR = 'target sign structure candidate failed';
const PRIVATE = 'synthetic-private-marker';
const originalSet = Uint8Array.prototype.set;
const originalFill = Uint8Array.prototype.fill;

// Each slot: a data region of at most 255 bytes, then a length low byte.
const SLOTS = [
    { name: 'token', data: 0x000, len: 0x0ff },
    { name: 'extra', data: 0x100, len: 0x1ff },
    { name: 'sign', data: 0x200, len: 0x2ff },
] as const;

type SlotName = (typeof SLOTS)[number]['name'];
type Input = { token: Uint8Array; extra: Uint8Array; sign: Uint8Array };

let guards: Array<{ mock: { calls: readonly unknown[] } }> = [];

function bytes(values: number[]): Uint8Array {
    return Uint8Array.from(values);
}

function ramp(length: number, seed = 1): Uint8Array {
    // Deterministic nonzero fill so copied bytes are visible against the zero field.
    return Uint8Array.from({ length }, (_, index) => (index * 37 + seed * 11) & 0xff || 0xa5);
}

function makeInput(token: Uint8Array, extra: Uint8Array, sign: Uint8Array): Input {
    return { token, extra, sign };
}

function expectedStructure(input: Input): Uint8Array {
    const out = new Uint8Array(OUTPUT_LENGTH);
    out.set(input.token, 0x000);
    out.set(input.extra, 0x100);
    out.set(input.sign, 0x200);
    // Each length is <= 255, so the low byte equals the length exactly.
    out[0x0ff] = input.token.length;
    out[0x1ff] = input.extra.length;
    out[0x2ff] = input.sign.length;
    return out;
}

function snapshotInput(input: Input): Input {
    return makeInput(
        Uint8Array.from(input.token),
        Uint8Array.from(input.extra),
        Uint8Array.from(input.sign),
    );
}

function expectInputUnchanged(input: Input, before: Input): void {
    expect(input.token).toEqual(before.token);
    expect(input.extra).toEqual(before.extra);
    expect(input.sign).toEqual(before.sign);
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

function withSlot(base: Input, name: SlotName, value: unknown): Input {
    return { ...base, [name]: value } as unknown as Input;
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

describe('offline target sign structure candidate', () => {
    it('places the exact fixed vector and zeroes every other byte', () => {
        const input = makeInput(
            bytes([0x11, 0x22, 0x33]),
            bytes([0xaa, 0xbb]),
            bytes([0x01, 0x02, 0x03, 0x04]),
        );
        const before = snapshotInput(input);
        const result = place(input);

        expect(result).toBeInstanceOf(Uint8Array);
        expect(Buffer.isBuffer(result)).toBe(false);
        expect(result).toHaveLength(OUTPUT_LENGTH);

        // Enumerate every nonzero byte the structure is permitted to contain.
        const nonzero = new Map<number, number>([
            [0x000, 0x11],
            [0x001, 0x22],
            [0x002, 0x33],
            [0x0ff, 3],
            [0x100, 0xaa],
            [0x101, 0xbb],
            [0x1ff, 2],
            [0x200, 0x01],
            [0x201, 0x02],
            [0x202, 0x03],
            [0x203, 0x04],
            [0x2ff, 4],
        ]);

        for (let index = 0; index < OUTPUT_LENGTH; index++) {
            expect(result[index]).toBe(nonzero.get(index) ?? 0);
        }

        expect(result).toEqual(expectedStructure(before));
        expectInputUnchanged(input, before);
    });

    it('produces an all-zero structure with zero length bytes for empty inputs', () => {
        const input = makeInput(new Uint8Array(0), new Uint8Array(0), new Uint8Array(0));
        const result = place(input);

        expect(result).toEqual(new Uint8Array(OUTPUT_LENGTH));
        expect(result[0x0ff]).toBe(0);
        expect(result[0x1ff]).toBe(0);
        expect(result[0x2ff]).toBe(0);
    });

    it('accepts exactly 255 bytes and rejects 256 for each slot independently', () => {
        for (const slot of SLOTS) {
            const base = makeInput(bytes([1]), bytes([2]), bytes([3]));

            const full = withSlot(base, slot.name, ramp(SLOT_CAPACITY, 3));
            const before = snapshotInput(full);
            const result = place(full);
            expect(result).toEqual(expectedStructure(before));
            // The 255th data byte sits just below the length byte; length == 255.
            expect(result[slot.data + SLOT_CAPACITY - 1]).toBe(
                (full[slot.name] as Uint8Array)[SLOT_CAPACITY - 1],
            );
            expect(result[slot.len]).toBe(SLOT_CAPACITY);
            expectInputUnchanged(full, before);

            const over = withSlot(base, slot.name, new Uint8Array(SLOT_CAPACITY + 1));
            const overBefore = snapshotInput(over);
            expectFailure(() => place(over));
            expectInputUnchanged(over, overBefore);
        }
    });

    it('returns an independent result that does not alias any input buffer', () => {
        const input = makeInput(ramp(10, 1), ramp(12, 2), ramp(14, 3));
        const before = snapshotInput(input);
        const expected = expectedStructure(before);

        const result = place(input);
        expect(result).toEqual(expected);
        expect(result.buffer).not.toBe(input.token.buffer);
        expect(result.buffer).not.toBe(input.extra.buffer);
        expect(result.buffer).not.toBe(input.sign.buffer);

        // Mutating inputs after the call must not change the returned structure.
        input.token.fill(0xee);
        input.extra.fill(0xdd);
        input.sign.fill(0xcc);
        expect(result).toEqual(expected);

        // Mutating a fresh result must not reach back into any input.
        const second = place(makeInput(before.token, before.extra, before.sign));
        second.fill(0x55);
        expect(before.token).toEqual(snapshotInput(before).token);
    });

    it('returns distinct non-aliased buffers for repeated calls', () => {
        const input = makeInput(ramp(8, 4), ramp(9, 5), ramp(10, 6));
        const a = place(input);
        const b = place(input);
        expect(a.buffer).not.toBe(b.buffer);
        a.fill(0x77);
        expect(b).toEqual(expectedStructure(input));
    });

    it('accepts unaligned Buffer and Uint8Array subviews, reading only the selected range', () => {
        const tokenBacking = Buffer.alloc(10 + 5, 0xe1);
        const extraBacking = new Uint8Array(12 + 7).fill(0xe2);
        const signBacking = Buffer.alloc(9 + 3, 0xe3);
        const token = tokenBacking.subarray(3, 3 + 10);
        const extra = extraBacking.subarray(5, 5 + 12);
        const sign = signBacking.subarray(2, 2 + 9);
        token.set(ramp(10, 1));
        extra.set(ramp(12, 2));
        sign.set(ramp(9, 3));

        const beforeTokenBacking = Buffer.from(tokenBacking);
        const beforeExtraBacking = Uint8Array.from(extraBacking);
        const beforeSignBacking = Buffer.from(signBacking);
        const input = makeInput(token, extra, sign);

        const result = place(input);
        expect(result).toEqual(expectedStructure(input));
        expect(tokenBacking).toEqual(beforeTokenBacking);
        expect(extraBacking).toEqual(beforeExtraBacking);
        expect(signBacking).toEqual(beforeSignBacking);
        expect(result.buffer).not.toBe(tokenBacking.buffer);
        expect(result.buffer).not.toBe(extraBacking.buffer);
        expect(result.buffer).not.toBe(signBacking.buffer);
    });

    it('accepts cross-realm subviews without reading hostile own accessors', () => {
        const token = runInNewContext(
            `new Uint8Array(10 + 2).map((_, i) => (i * 17 + 1) & 255).subarray(1, 11)`,
        ) as Uint8Array;
        const extra = runInNewContext(
            `new Uint8Array(12 + 2).map((_, i) => (i * 29 + 3) & 255).subarray(1, 13)`,
        ) as Uint8Array;
        const sign = runInNewContext(
            `new Uint8Array(9 + 2).map((_, i) => (i * 13 + 5) & 255).subarray(1, 10)`,
        ) as Uint8Array;

        const input = makeInput(token, extra, sign);
        const expected = expectedStructure(input);
        const trap = vi.fn(() => {
            throw new Error(PRIVATE);
        });

        for (const value of [token, extra, sign]) {
            for (const key of [
                'length',
                'byteLength',
                'byteOffset',
                'buffer',
                'constructor',
                'set',
                'fill',
                Symbol.iterator,
                Symbol.toStringTag,
            ]) {
                Object.defineProperty(value, key, { get: trap, configurable: false });
            }

            Object.preventExtensions(value);
        }

        expect(place(input)).toEqual(expected);
        expect(trap).not.toHaveBeenCalled();
        expect(trap.mock.calls).toHaveLength(0);
    });

    it('ignores shadow accessors defined on otherwise-valid inputs', () => {
        const input = makeInput(ramp(10, 1), ramp(12, 2), ramp(14, 3));
        const expected = expectedStructure(input);
        const trap = vi.fn(() => {
            throw new Error(PRIVATE);
        });

        for (const value of [input.token, input.extra, input.sign]) {
            for (const key of ['length', 'byteLength', 'byteOffset', 'buffer', 'set', 'fill']) {
                Object.defineProperty(value, key, { get: trap, configurable: false });
            }
        }

        expect(place(input)).toEqual(expected);
        expect(trap.mock.calls).toHaveLength(0);
    });

    it('rejects wrong-typed, proxy, revoked, missing-field and oversized values in any slot', () => {
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
            new Uint8Array(SLOT_CAPACITY + 1),
            proxy,
            revoked.proxy,
        ];

        const base = makeInput(bytes([1]), bytes([2]), bytes([3]));

        for (const slot of SLOTS) {
            for (const value of invalidValues) {
                const input = withSlot(base, slot.name, value);
                const before = { ...base };
                expectFailure(() => place(input));

                // The healthy slots must be left untouched.
                for (const other of SLOTS) {
                    if (other.name !== slot.name) {
                        expect(input[other.name]).toEqual(before[other.name]);
                    }
                }
            }
        }

        // Missing fields and non-object inputs are rejected uniformly.
        expectFailure(() => place({ extra: bytes([1]), sign: bytes([2]) } as unknown as Input));
        expectFailure(() => place({ token: bytes([1]), sign: bytes([2]) } as unknown as Input));
        expectFailure(() => place({ token: bytes([1]), extra: bytes([2]) } as unknown as Input));
        expectFailure(() => place(null as unknown as Input));
        expectFailure(() => place(undefined as unknown as Input));
        expectFailure(() => place('private' as unknown as Input));

        expect(trap).not.toHaveBeenCalled();
    });

    it('rejects shared, detached and out-of-bounds views in any slot', () => {
        const base = makeInput(bytes([1]), bytes([2]), bytes([3]));

        for (const slot of SLOTS) {
            const detached = new Uint8Array(4);
            structuredClone(detached.buffer, { transfer: [detached.buffer] });
            const resizable = new ArrayBuffer(4, { maxByteLength: 5 });
            const oob = new Uint8Array(resizable, 0, 4);
            resizable.resize(3);

            const hostile = [
                new Uint8Array(new SharedArrayBuffer(4)),
                runInNewContext(`new Uint8Array(new SharedArrayBuffer(4))`) as Uint8Array,
                detached,
                oob,
            ];

            for (const value of hostile) {
                expectFailure(() => place(withSlot(base, slot.name, value)));
            }
        }
    });

    it('clears owned private allocations and leaves inputs intact when a copy throws', async () => {
        const input = makeInput(ramp(5, 1), ramp(7, 2), ramp(9, 3));
        const before = snapshotInput(input);
        const owned: Uint8Array[] = [];
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            offset,
        ) {
            originalSet.call(this, source, offset);

            if (
                this !== input.token &&
                this !== input.extra &&
                this !== input.sign &&
                this instanceof Uint8Array
            ) {
                owned.push(this);

                if (owned.length === 2) {
                    throw new Error(PRIVATE);
                }
            }
        });

        try {
            vi.resetModules();
            const fresh = await import('../../src/direct/target-sign-structure-candidate');
            expectFailure(() => fresh.assembleTargetSignStructureCandidate(input));
        } finally {
            spy.mockRestore();
        }

        expect(owned).toHaveLength(2);

        for (const allocation of owned) {
            expect(allocation).toEqual(new Uint8Array(allocation.length));
        }

        expectInputUnchanged(input, before);
    });

    it('still attempts the remaining cleanups and keeps the uniform error when one cleanup fails', async () => {
        const input = makeInput(ramp(5, 1), ramp(7, 2), ramp(9, 3));
        const before = snapshotInput(input);
        const owned: Uint8Array[] = [];
        const attempted: Uint8Array[] = [];
        const setSpy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            offset,
        ) {
            originalSet.call(this, source, offset);

            if (
                this !== input.token &&
                this !== input.extra &&
                this !== input.sign &&
                this instanceof Uint8Array
            ) {
                owned.push(this);

                if (owned.length === 2) {
                    throw new Error(PRIVATE);
                }
            }
        });
        const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value,
            start,
            end,
        ) {
            if (owned.includes(this)) {
                attempted.push(this);

                if (this === owned[0]) {
                    throw new Error(PRIVATE);
                }
            }

            return originalFill.call(this, value, start, end);
        });

        try {
            vi.resetModules();
            const fresh = await import('../../src/direct/target-sign-structure-candidate');
            expectFailure(() => fresh.assembleTargetSignStructureCandidate(input));
        } finally {
            setSpy.mockRestore();
            fillSpy.mockRestore();

            for (const allocation of owned) {
                originalFill.call(allocation, 0);
            }
        }

        expect(owned).toHaveLength(2);
        // Every owned allocation received its own best-effort cleanup attempt.
        expect(attempted).toContain(owned[0]);
        expect(attempted).toContain(owned[1]);
        expectInputUnchanged(input, before);
    });

    it('returns the successful structure even if an owned temporary cleanup throws', async () => {
        const input = makeInput(ramp(6, 1), ramp(8, 2), ramp(10, 3));
        const expected = expectedStructure(input);
        const attempted: Uint8Array[] = [];
        const spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value,
            start,
            end,
        ) {
            if (this !== input.token && this !== input.extra && this !== input.sign) {
                attempted.push(this);

                if (attempted.length === 1) {
                    throw new Error(PRIVATE);
                }
            }

            return originalFill.call(this, value, start, end);
        });

        try {
            vi.resetModules();
            const fresh = await import('../../src/direct/target-sign-structure-candidate');
            expect(fresh.assembleTargetSignStructureCandidate(input)).toEqual(expected);
        } finally {
            spy.mockRestore();

            for (const allocation of attempted) {
                originalFill.call(allocation, 0);
            }
        }

        expect(attempted.length).toBeGreaterThanOrEqual(1);
        expectInputUnchanged(input, snapshotInput(input));
    });
});
