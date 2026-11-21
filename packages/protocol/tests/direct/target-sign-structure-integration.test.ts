import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleTargetSignStructureCandidate } from '../../src/direct/target-sign-structure-candidate';
import { placeTargetO3EmptyExtraSlotCandidate } from '../../src/direct/target-o3-empty-extra-slot-candidate';
import { placeTargetSignedDecimalMd5SlotCandidate } from '../../src/direct/target-signed-decimal-md5-slot-candidate';
import { targetSignedDecimalMd5Candidate } from '../../src/direct/target-signed-decimal-md5-candidate';

// Synthetic cross-validation only. This file reconciles three independently
// reverse-engineered offline candidates over the same 0x300-byte sign-structure
// layout: the memcpy-style assembler, the signed-decimal MD5 slot writer, and
// the O3 empty-body extra slot writer. It asserts that the slot layouts the
// three models agree on are identical, using the real implementations to compute
// every value. It claims no real login, no real signature, no target
// reachability, and no QQ interoperability or SSO semantics. All inputs are
// fabricated local fixtures.
const OUTPUT_LENGTH = 0x300;
const GLOBAL_LENGTH = 160;
const SLOT_CAPACITY = 255;
const ASSEMBLE_ERROR = 'target sign structure candidate failed';

// Slot geometry shared by all three models.
const TOKEN_OFFSET = 0x000;
const TOKEN_LENGTH_OFFSET = 0x0ff;
const EXTRA_OFFSET = 0x100;
const EXTRA_LENGTH_OFFSET = 0x1ff;
const SIGN_OFFSET = 0x200;
const SIGN_LENGTH_OFFSET = 0x2ff;
const DIGEST_BYTES = 0x10;
const EXTRA_WRAPPED_BYTES = 0x22; // 34: 0a20 header + 32-byte global slice.
const GLOBAL_SLICE_OFFSET = 0x28;
const GLOBAL_SLICE_BYTES = 32;

// Independently precomputed offline with Node crypto and cross-checked with a
// second MD5 implementation; these are oracles, not a replay of the candidate.
//   bits 0x00000000 -> "0"  -> cfcd208495d565ef66e7dff9f98764da
//   bits 0xffffffff -> "-1" -> 6bb61e3b7bce0931da574d19d1d82c88
const SIGN_VECTORS = [
    { bits: 0x00000000, md5: 'cfcd208495d565ef66e7dff9f98764da' },
    { bits: 0xffffffff, md5: '6bb61e3b7bce0931da574d19d1d82c88' },
] as const;

let guards: Array<{ mock: { calls: readonly unknown[] } }> = [];

function blocked(): never {
    throw new Error('unexpected effect');
}

// A fixed synthetic token (<= 255 bytes, every value <= 255).
function tokenFixture(): Uint8Array {
    return Uint8Array.from({ length: 40 }, (_, index) => (index * 29 + 0x13) & 0xff);
}

// A fixed synthetic 160-byte global state with a precisely known 0x28..0x48
// slice (00..1f) and a nonzero gate byte so the O3 model accepts it.
function globalFixture(): Uint8Array {
    const globalState = new Uint8Array(GLOBAL_LENGTH);
    globalState[0] = 1;

    for (let index = 0; index < GLOBAL_SLICE_BYTES; index++) {
        globalState[GLOBAL_SLICE_OFFSET + index] = index;
    }

    return globalState;
}

// extra = 0a20 || globalState[0x28:0x48]  (34 bytes).
function extraFromGlobal(globalState: Uint8Array): Uint8Array {
    return Uint8Array.of(
        0x0a,
        0x20,
        ...globalState.subarray(GLOBAL_SLICE_OFFSET, GLOBAL_SLICE_OFFSET + GLOBAL_SLICE_BYTES),
    );
}

function snapshot(bytes: Uint8Array): Uint8Array {
    return Uint8Array.from(bytes);
}

function expectAssembleFailure(operation: () => unknown): void {
    let caught: unknown;

    try {
        operation();
    } catch (error) {
        caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(ASSEMBLE_ERROR);
    expect((caught as Error).cause).toBeUndefined();
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

describe('offline target sign-structure cross-validation', () => {
    it('assembles token/extra/sign into the exact 0x300 layout with zero elsewhere', () => {
        const bits = 0x12345678;
        const token = tokenFixture();
        const globalState = globalFixture();
        const extra = extraFromGlobal(globalState);
        // sign is computed by the real candidate, not copied from a literal here.
        const sign = targetSignedDecimalMd5Candidate(bits);

        const tokenBefore = snapshot(token);
        const extraBefore = snapshot(extra);
        const signBefore = snapshot(sign);

        const result = assembleTargetSignStructureCandidate({ token, extra, sign });

        expect(result).toBeInstanceOf(Uint8Array);
        expect(Buffer.isBuffer(result)).toBe(false);
        expect(result).toHaveLength(OUTPUT_LENGTH);
        expect(sign).toHaveLength(DIGEST_BYTES);
        expect(extra).toHaveLength(EXTRA_WRAPPED_BYTES);

        // sign slot
        expect(result.subarray(SIGN_OFFSET, SIGN_OFFSET + DIGEST_BYTES)).toEqual(sign);
        expect(result[SIGN_LENGTH_OFFSET]).toBe(DIGEST_BYTES);

        // extra slot: 0a20 + the 32 selected global bytes
        expect(result.subarray(EXTRA_OFFSET, EXTRA_OFFSET + EXTRA_WRAPPED_BYTES)).toEqual(extra);
        expect(result[EXTRA_LENGTH_OFFSET]).toBe(EXTRA_WRAPPED_BYTES);

        // token slot
        expect(result.subarray(TOKEN_OFFSET, TOKEN_OFFSET + token.length)).toEqual(token);
        expect(result[TOKEN_LENGTH_OFFSET]).toBe(token.length);

        // Every other byte is zero. Build the full expectation and compare.
        const expected = new Uint8Array(OUTPUT_LENGTH);
        expected.set(token, TOKEN_OFFSET);
        expected.set(extra, EXTRA_OFFSET);
        expected.set(sign, SIGN_OFFSET);
        expected[TOKEN_LENGTH_OFFSET] = token.length;
        expected[EXTRA_LENGTH_OFFSET] = EXTRA_WRAPPED_BYTES;
        expected[SIGN_LENGTH_OFFSET] = DIGEST_BYTES;
        expect(result).toEqual(expected);

        // Inputs are never mutated.
        expect(token).toEqual(tokenBefore);
        expect(extra).toEqual(extraBefore);
        expect(sign).toEqual(signBefore);
    });

    it('agrees with the two independent slot writers on the extra and sign slots', () => {
        const bits = 0x9abcdef0;
        const token = tokenFixture();
        const globalState = globalFixture();
        const extra = extraFromGlobal(globalState);
        const sign = targetSignedDecimalMd5Candidate(bits);

        // Path 1: memcpy-style assembler.
        const assembled = assembleTargetSignStructureCandidate({ token, extra, sign });

        // Path 2: start from an all-zero structure and apply the two slot writers
        // in sequence. placeMd5 writes the sign slot; placeO3 writes the extra
        // slot. Neither writer touches the token slot.
        const zero = new Uint8Array(OUTPUT_LENGTH);
        const globalBefore = snapshot(globalState);
        const afterMd5 = placeTargetSignedDecimalMd5SlotCandidate(zero, bits);
        const afterBoth = placeTargetO3EmptyExtraSlotCandidate(afterMd5, globalState);

        // The two independently reverse-engineered paths coincide on the sign slot...
        expect(afterBoth.subarray(SIGN_OFFSET, SIGN_OFFSET + DIGEST_BYTES)).toEqual(
            assembled.subarray(SIGN_OFFSET, SIGN_OFFSET + DIGEST_BYTES),
        );
        // ...and on the extra slot...
        expect(afterBoth.subarray(EXTRA_OFFSET, EXTRA_OFFSET + EXTRA_WRAPPED_BYTES)).toEqual(
            assembled.subarray(EXTRA_OFFSET, EXTRA_OFFSET + EXTRA_WRAPPED_BYTES),
        );
        // ...and on both low-byte length markers.
        expect(afterBoth[SIGN_LENGTH_OFFSET]).toBe(DIGEST_BYTES);
        expect(assembled[SIGN_LENGTH_OFFSET]).toBe(DIGEST_BYTES);
        expect(afterBoth[EXTRA_LENGTH_OFFSET]).toBe(EXTRA_WRAPPED_BYTES);
        expect(assembled[EXTRA_LENGTH_OFFSET]).toBe(EXTRA_WRAPPED_BYTES);

        // The token slot exists only in the assembler path; the slot-writer path
        // leaves the token region and its length byte zero, because neither slot
        // writer models that copy.
        expect(assembled.subarray(TOKEN_OFFSET, TOKEN_OFFSET + token.length)).toEqual(token);
        expect(assembled[TOKEN_LENGTH_OFFSET]).toBe(token.length);
        expect(afterBoth.subarray(TOKEN_OFFSET, EXTRA_OFFSET)).toEqual(
            new Uint8Array(EXTRA_OFFSET),
        );

        // Outside the token slot the two paths are byte-identical.
        expect(afterBoth.subarray(EXTRA_OFFSET)).toEqual(assembled.subarray(EXTRA_OFFSET));

        // Fixtures remained untouched across the whole cross-check.
        expect(globalState).toEqual(globalBefore);
    });

    it('matches independently precomputed MD5 constants in the sign slot', () => {
        const globalState = globalFixture();
        const extra = extraFromGlobal(globalState);
        const token = tokenFixture();

        for (const vector of SIGN_VECTORS) {
            const sign = targetSignedDecimalMd5Candidate(vector.bits);
            const constant = Uint8Array.from(Buffer.from(vector.md5, 'hex'));

            // The real candidate reproduces the external constant...
            expect(sign).toEqual(constant);

            // ...and the assembler places exactly that constant into the sign slot.
            const assembled = assembleTargetSignStructureCandidate({ token, extra, sign });
            expect(assembled.subarray(SIGN_OFFSET, SIGN_OFFSET + DIGEST_BYTES)).toEqual(constant);
            expect(assembled[SIGN_LENGTH_OFFSET]).toBe(DIGEST_BYTES);

            // The slot-writer path lands the same constant at the same offset.
            const viaSlot = placeTargetSignedDecimalMd5SlotCandidate(
                new Uint8Array(OUTPUT_LENGTH),
                vector.bits,
            );
            expect(viaSlot.subarray(SIGN_OFFSET, SIGN_OFFSET + DIGEST_BYTES)).toEqual(constant);
        }
    });

    it('accepts a 255-byte token and rejects a 256-byte token with the fixed error', () => {
        const globalState = globalFixture();
        const extra = extraFromGlobal(globalState);
        const sign = targetSignedDecimalMd5Candidate(0);

        const token255 = Uint8Array.from({ length: SLOT_CAPACITY }, (_, i) => (i + 1) & 0xff);
        const result = assembleTargetSignStructureCandidate({ token: token255, extra, sign });
        expect(result.subarray(TOKEN_OFFSET, TOKEN_OFFSET + SLOT_CAPACITY)).toEqual(token255);
        expect(result[TOKEN_LENGTH_OFFSET]).toBe(SLOT_CAPACITY);

        const token256 = new Uint8Array(SLOT_CAPACITY + 1);
        expectAssembleFailure(() =>
            assembleTargetSignStructureCandidate({ token: token256, extra, sign }),
        );
    });

    it('returns independent, non-aliased outputs and never mutates its inputs', () => {
        const bits = 0x0f0f0f0f;
        const token = tokenFixture();
        const globalState = globalFixture();
        const extra = extraFromGlobal(globalState);
        const sign = targetSignedDecimalMd5Candidate(bits);

        const tokenBefore = snapshot(token);
        const extraBefore = snapshot(extra);
        const signBefore = snapshot(sign);
        const globalBefore = snapshot(globalState);

        const assembled = assembleTargetSignStructureCandidate({ token, extra, sign });
        const viaMd5 = placeTargetSignedDecimalMd5SlotCandidate(
            new Uint8Array(OUTPUT_LENGTH),
            bits,
        );
        const viaO3 = placeTargetO3EmptyExtraSlotCandidate(
            new Uint8Array(OUTPUT_LENGTH),
            globalState,
        );

        // The three outputs are mutually distinct buffers, not aliases.
        expect(assembled.buffer).not.toBe(viaMd5.buffer);
        expect(assembled.buffer).not.toBe(viaO3.buffer);
        expect(viaMd5.buffer).not.toBe(viaO3.buffer);
        expect(assembled.buffer).not.toBe(token.buffer);
        expect(assembled.buffer).not.toBe(extra.buffer);
        expect(assembled.buffer).not.toBe(sign.buffer);
        expect(viaO3.buffer).not.toBe(globalState.buffer);

        // Mutating any output must not reach back into another output or an input.
        const assembledBefore = snapshot(assembled);
        viaMd5.fill(0x55);
        viaO3.fill(0x66);
        expect(assembled).toEqual(assembledBefore);

        // Inputs are all intact.
        expect(token).toEqual(tokenBefore);
        expect(extra).toEqual(extraBefore);
        expect(sign).toEqual(signBefore);
        expect(globalState).toEqual(globalBefore);
    });
});
