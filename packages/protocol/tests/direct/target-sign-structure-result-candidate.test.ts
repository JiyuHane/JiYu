import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractTargetSignStructureResultCandidate as extract } from '../../src/direct/target-sign-structure-result-candidate';
import { assembleTargetSignStructureCandidate as assemble } from '../../src/direct/target-sign-structure-candidate';

// Synthetic model only: this asserts an offline parse of the 0x300-byte
// sign-structure layout back into its three length-prefixed slots. It does not
// claim a real login, a real signature, target reachability, QQ interoperability,
// or SSO semantics, and it exercises no branch condition of a production signer.
// Every structure below is a fabricated local fixture.
const STRUCTURE_LENGTH = 0x300;
const SLOT_CAPACITY = 255;
const ERROR = 'target sign structure result candidate failed';
const PRIVATE = 'synthetic-private-marker';
const originalSet = Uint8Array.prototype.set;

type Result = { token: Uint8Array; extra: Uint8Array; sign: Uint8Array };

let guards: Array<{ mock: { calls: readonly unknown[] } }> = [];

function bytes(values: number[]): Uint8Array {
    return Uint8Array.from(values);
}

function ramp(length: number, seed = 1): Uint8Array {
    // Deterministic nonzero fill so copied bytes are visible against the zero field.
    return Uint8Array.from({ length }, (_, index) => (index * 37 + seed * 11) & 0xff || 0xa5);
}

// Build a canonical 0x300 structure from three slot bodies (each <= 255 bytes),
// writing each length low byte and leaving every other byte zero. This mirrors
// the assembler layout without depending on it.
function encode(token: Uint8Array, extra: Uint8Array, sign: Uint8Array): Uint8Array {
    const out = new Uint8Array(STRUCTURE_LENGTH);
    out.set(token, 0x000);
    out.set(extra, 0x100);
    out.set(sign, 0x200);
    out[0x0ff] = token.length & 0xff;
    out[0x1ff] = extra.length & 0xff;
    out[0x2ff] = sign.length & 0xff;
    return out;
}

// Independent oracle: slice each slot to its declared length using copying slice.
function decode(structure: Uint8Array): Result {
    const tokenLen = structure[0x0ff];
    const extraLen = structure[0x1ff];
    const signLen = structure[0x2ff];
    return {
        token: structure.slice(0x000, 0x000 + tokenLen),
        extra: structure.slice(0x100, 0x100 + extraLen),
        sign: structure.slice(0x200, 0x200 + signLen),
    };
}

function expectExtractFailure(operation: () => unknown): void {
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

describe('offline target sign structure result candidate', () => {
    it('round-trips every assembled structure back to its exact slot bodies', () => {
        const cases: Result[] = [
            { token: new Uint8Array(0), extra: new Uint8Array(0), sign: new Uint8Array(0) },
            { token: bytes([0x11]), extra: bytes([0x22]), sign: bytes([0x33]) },
            {
                token: ramp(SLOT_CAPACITY, 1),
                extra: ramp(SLOT_CAPACITY, 2),
                sign: ramp(SLOT_CAPACITY, 3),
            },
            {
                token: bytes([0x00, 0xff, 0x00, 0xff, 0x7f, 0x80, 0x01]),
                extra: bytes([0xff, 0x00]),
                sign: bytes([0x00]),
            },
            { token: new Uint8Array(0), extra: ramp(SLOT_CAPACITY, 7), sign: bytes([0xff]) },
            {
                token: bytes([0xff, 0xfe, 0x00, 0x01]),
                extra: new Uint8Array(0),
                sign: ramp(128, 9),
            },
        ];

        for (const input of cases) {
            const structure = assemble(input);
            const before = Uint8Array.from(structure);
            const result = extract(structure);

            expect(result.token).toBeInstanceOf(Uint8Array);
            expect(result.extra).toBeInstanceOf(Uint8Array);
            expect(result.sign).toBeInstanceOf(Uint8Array);
            expect(Buffer.isBuffer(result.token)).toBe(false);
            expect(Buffer.isBuffer(result.extra)).toBe(false);
            expect(Buffer.isBuffer(result.sign)).toBe(false);

            expect(result.token).toEqual(input.token);
            expect(result.extra).toEqual(input.extra);
            expect(result.sign).toEqual(input.sign);
            expect(result.token).toHaveLength(input.token.length);
            expect(result.extra).toHaveLength(input.extra.length);
            expect(result.sign).toHaveLength(input.sign.length);

            // Extraction never mutates the source structure.
            expect(structure).toEqual(before);
        }
    });

    it('extracts the exact bytes and lengths from a fixed hand-built structure', () => {
        const structure = new Uint8Array(STRUCTURE_LENGTH);
        structure[0x000] = 0x11;
        structure[0x001] = 0x22;
        structure[0x002] = 0x33;
        structure[0x0ff] = 3;
        structure[0x100] = 0xaa;
        structure[0x101] = 0xbb;
        structure[0x1ff] = 2;
        structure[0x200] = 0x01;
        structure[0x201] = 0x02;
        structure[0x202] = 0x03;
        structure[0x203] = 0x04;
        structure[0x2ff] = 4;

        const result = extract(structure);

        expect(result.token).toEqual(bytes([0x11, 0x22, 0x33]));
        expect(result.extra).toEqual(bytes([0xaa, 0xbb]));
        expect(result.sign).toEqual(bytes([0x01, 0x02, 0x03, 0x04]));
        expect(result.token).toHaveLength(3);
        expect(result.extra).toHaveLength(2);
        expect(result.sign).toHaveLength(4);
    });

    it('honours each length byte at its boundary and never reads past the declared length', () => {
        // Fill everything with 0xff dirt, then pin three distinct length bytes:
        //   token = 3   -> three 0xff bytes, ignoring the dirty tail of the slot;
        //   extra = 0   -> empty, ignoring a full slot of dirt;
        //   sign  = 255 -> the maximum, reading 0x200..0x2fe and stopping before
        //                  the 0x2ff length byte, never crossing a slot boundary.
        const structure = new Uint8Array(STRUCTURE_LENGTH).fill(0xff);
        structure[0x0ff] = 3;
        structure[0x1ff] = 0;
        structure[0x2ff] = SLOT_CAPACITY;

        const result = extract(structure);

        expect(result.token).toEqual(bytes([0xff, 0xff, 0xff]));
        expect(result.token).toHaveLength(3);

        expect(result.extra).toEqual(new Uint8Array(0));
        expect(result.extra).toHaveLength(0);

        expect(result.sign).toEqual(new Uint8Array(SLOT_CAPACITY).fill(0xff));
        expect(result.sign).toHaveLength(SLOT_CAPACITY);
        // The 0x2ff length byte itself is excluded from the 255-byte sign body.
        expect(result.sign[SLOT_CAPACITY - 1]).toBe(structure[0x200 + SLOT_CAPACITY - 1]);

        // Agreement with the independent slice oracle.
        const oracle = decode(structure);
        expect(result.token).toEqual(oracle.token);
        expect(result.extra).toEqual(oracle.extra);
        expect(result.sign).toEqual(oracle.sign);
    });

    it('keeps a short slot body from reaching the dirty bytes after it', () => {
        // token length 2, but the slot keeps garbage at 0x002..0x0fe; the body
        // must stop at exactly two bytes and never include the trailing dirt.
        const structure = new Uint8Array(STRUCTURE_LENGTH).fill(0x5a);
        structure[0x000] = 0xa1;
        structure[0x001] = 0xa2;
        structure[0x0ff] = 2;
        structure[0x1ff] = 0;
        structure[0x2ff] = 0;

        const result = extract(structure);
        expect(result.token).toEqual(bytes([0xa1, 0xa2]));
        expect(result.extra).toEqual(new Uint8Array(0));
        expect(result.sign).toEqual(new Uint8Array(0));
    });

    it('returns three independent buffers that do not alias each other or the input', () => {
        const structure = encode(ramp(10, 1), ramp(12, 2), ramp(14, 3));
        const result = extract(structure);
        const tokenBefore = Uint8Array.from(result.token);
        const extraBefore = Uint8Array.from(result.extra);
        const signBefore = Uint8Array.from(result.sign);

        // No output aliases the input structure or another output.
        expect(result.token.buffer).not.toBe(structure.buffer);
        expect(result.extra.buffer).not.toBe(structure.buffer);
        expect(result.sign.buffer).not.toBe(structure.buffer);
        expect(result.token.buffer).not.toBe(result.extra.buffer);
        expect(result.token.buffer).not.toBe(result.sign.buffer);
        expect(result.extra.buffer).not.toBe(result.sign.buffer);

        // Mutating the input after extraction must not change the results.
        structure.fill(0x00);
        expect(result.token).toEqual(tokenBefore);
        expect(result.extra).toEqual(extraBefore);
        expect(result.sign).toEqual(signBefore);

        // Mutating a result must not reach back into the input or another result.
        const structureAfterFill = Uint8Array.from(structure);
        result.token.fill(0xee);
        result.extra.fill(0xdd);
        result.sign.fill(0xcc);
        expect(structure).toEqual(structureAfterFill);
    });

    it('returns distinct non-aliased buffers for repeated extractions', () => {
        const structure = encode(ramp(8, 4), ramp(9, 5), ramp(10, 6));
        const a = extract(structure);
        const b = extract(structure);
        expect(a.token.buffer).not.toBe(b.token.buffer);
        expect(a.extra.buffer).not.toBe(b.extra.buffer);
        expect(a.sign.buffer).not.toBe(b.sign.buffer);
        const bToken = Uint8Array.from(b.token);
        a.token.fill(0x77);
        expect(b.token).toEqual(bToken);
    });

    it('accepts a cross-realm 0x300 structure without reading hostile own accessors', () => {
        const structure = runInNewContext(
            `const s = new Uint8Array(0x300); s[0]=0x11; s[1]=0x22; s[0xff]=2;` +
                ` s[0x100]=0xaa; s[0x1ff]=1; s[0x200]=0x01; s[0x201]=0x02; s[0x202]=0x03; s[0x2ff]=3; s`,
        ) as Uint8Array;
        const expected = decode(Uint8Array.from(structure));
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
            Object.defineProperty(structure, key, { get: trap, configurable: false });
        }

        Object.preventExtensions(structure);

        const result = extract(structure);
        expect(result.token).toEqual(expected.token);
        expect(result.extra).toEqual(expected.extra);
        expect(result.sign).toEqual(expected.sign);
        expect(trap).not.toHaveBeenCalled();
        expect(trap.mock.calls).toHaveLength(0);
    });

    it('ignores shadow accessors defined on an otherwise-valid structure', () => {
        const structure = encode(ramp(10, 1), ramp(12, 2), ramp(14, 3));
        const expected = decode(Uint8Array.from(structure));
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
            Object.defineProperty(structure, key, { get: trap, configurable: false });
        }

        const result = extract(structure);
        expect(result.token).toEqual(expected.token);
        expect(result.extra).toEqual(expected.extra);
        expect(result.sign).toEqual(expected.sign);
        expect(trap).not.toHaveBeenCalled();
        expect(trap.mock.calls).toHaveLength(0);
    });

    it('rejects wrong-length, wrong-typed, proxy and revoked inputs with the fixed error', () => {
        const trap = vi.fn(() => {
            throw new Error(PRIVATE);
        });
        const valid = encode(bytes([1, 2, 3]), bytes([4, 5]), bytes([6]));
        const proxy = new Proxy(encode(bytes([1]), bytes([2]), bytes([3])), {
            get: trap,
            getPrototypeOf: trap,
            ownKeys: trap,
        });
        const revoked = Proxy.revocable(valid, {});
        revoked.revoke();

        const invalidValues: unknown[] = [
            null,
            undefined,
            {},
            [],
            'private',
            0,
            new ArrayBuffer(STRUCTURE_LENGTH),
            new DataView(new ArrayBuffer(STRUCTURE_LENGTH)),
            new Uint8ClampedArray(STRUCTURE_LENGTH),
            new Int8Array(STRUCTURE_LENGTH),
            new Uint8Array(STRUCTURE_LENGTH - 1), // 0x2ff
            new Uint8Array(STRUCTURE_LENGTH + 1), // 0x301
            new Uint8Array(0),
            proxy,
            revoked.proxy,
        ];

        for (const value of invalidValues) {
            expectExtractFailure(() => extract(value as unknown as Uint8Array));
        }

        expect(trap).not.toHaveBeenCalled();
        expect(trap.mock.calls).toHaveLength(0);
    });

    it('rejects shared, detached and out-of-bounds 0x300 views with the fixed error', () => {
        const detached = new Uint8Array(STRUCTURE_LENGTH);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });

        const resizable = new ArrayBuffer(STRUCTURE_LENGTH, { maxByteLength: STRUCTURE_LENGTH });
        const oob = new Uint8Array(resizable, 0, STRUCTURE_LENGTH);
        resizable.resize(STRUCTURE_LENGTH - 1);

        const hostile: unknown[] = [
            new Uint8Array(new SharedArrayBuffer(STRUCTURE_LENGTH)),
            runInNewContext(`new Uint8Array(new SharedArrayBuffer(0x300))`) as Uint8Array,
            detached,
            oob,
        ];

        for (const value of hostile) {
            expectExtractFailure(() => extract(value as unknown as Uint8Array));
        }
    });

    it('rejects a slot-backed subview whose own byteLength is not 0x300', () => {
        // A 0x300-byte slice carved out of a larger buffer is still valid; a view
        // shorter or longer than 0x300 over the same backing must be rejected.
        const backing = new Uint8Array(STRUCTURE_LENGTH + 0x40);
        backing.set(encode(bytes([1, 2]), bytes([3]), bytes([4, 5, 6])), 0x10);

        const exact = backing.subarray(0x10, 0x10 + STRUCTURE_LENGTH);
        const result = extract(exact);
        expect(result.token).toEqual(bytes([1, 2]));
        expect(result.extra).toEqual(bytes([3]));
        expect(result.sign).toEqual(bytes([4, 5, 6]));

        expectExtractFailure(() => extract(backing.subarray(0x10, 0x10 + STRUCTURE_LENGTH - 1)));
        expectExtractFailure(() => extract(backing.subarray(0x00, STRUCTURE_LENGTH + 1)));
    });

    it('clears owned private allocations and leaves the input intact when a copy throws', async () => {
        const structure = encode(ramp(10, 1), ramp(12, 2), ramp(14, 3));
        const before = Uint8Array.from(structure);
        const owned: Uint8Array[] = [];
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            offset,
        ) {
            originalSet.call(this, source, offset);

            if (this !== structure && this instanceof Uint8Array) {
                owned.push(this);

                if (owned.length === 1) {
                    throw new Error(PRIVATE);
                }
            }
        });

        try {
            vi.resetModules();
            const fresh = await import('../../src/direct/target-sign-structure-result-candidate');
            expectExtractFailure(() => fresh.extractTargetSignStructureResultCandidate(structure));
        } finally {
            spy.mockRestore();
        }

        // At least one owned allocation was produced and every one was zeroed.
        expect(owned.length).toBeGreaterThanOrEqual(1);

        for (const allocation of owned) {
            expect(allocation).toEqual(new Uint8Array(allocation.length));
        }

        // The input structure is never written during a failed extraction.
        expect(structure).toEqual(before);
    });
});
