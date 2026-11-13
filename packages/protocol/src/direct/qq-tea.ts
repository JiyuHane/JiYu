import { randomBytes } from 'node:crypto';
import { isProxy } from 'node:util/types';

const BLOCK_SIZE = 8;
const KEY_SIZE = 16;
const DELTA = 0x9e3779b9;
const ROUNDS = 16;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayTag = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    Symbol.toStringTag,
)!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const typedArrayFill = Uint8Array.prototype.fill;

function randomPrefix(randomSource: (length: number) => Uint8Array, length: number): Uint8Array {
    const value = randomSource(length);

    try {
        if (typedArrayTag.call(value) !== 'Uint8Array' || typedArrayLength.call(value) !== length) {
            throw new Error();
        }

        const buffer: ArrayBuffer = typedArrayBuffer.call(value);
        // The ArrayBuffer intrinsic rejects SharedArrayBuffer, including across realms.
        arrayBufferLength.call(buffer);
        const offset: number = typedArrayOffset.call(value);
        // Constructing this view also rejects detached buffers. It avoids all
        // caller-defined properties, iterators and methods when copying bytes.
        return new Uint8Array(new Uint8Array(buffer, offset, length));
    } catch {
        throw new Error('QQ-TEA random source returned an invalid prefix');
    }
}

/**
 * QQ-TEA wire format: big-endian TEA words, 16 cycles, and two feedback
 * chains. The header's low three bits encode the 0..7 alignment bytes;
 * two more random bytes precede the message and seven zero bytes follow it.
 * See https://github.com/hzruandd/python-qq/blob/master/socket-qq/tea.py
 * and https://github.com/Mrs4s/MiraiGo/blob/2b2be6693df1219d867300c6f6cd0f804c59d620/binary/tea.go.
 *
 * This is a legacy format, not authenticated encryption. A valid zero trailer
 * is not proof of authenticity or the correct key. Do not expose decryption
 * failure details to a network peer. It does not implement any account,
 * transport, session, or protocol negotiation behavior.
 */

function keyWords(key: Uint8Array): number[] {
    if (key.length !== KEY_SIZE) {
        throw new RangeError('QQ-TEA key must be exactly 16 bytes');
    }

    const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
    return [view.getUint32(0), view.getUint32(4), view.getUint32(8), view.getUint32(12)];
}

function teaBlock(block: Uint8Array, key: number[], decrypt: boolean, wipe = false): Uint8Array {
    const view = new DataView(block.buffer, block.byteOffset, BLOCK_SIZE);
    let left = view.getUint32(0);
    let right = view.getUint32(4);
    let sum = decrypt ? Math.imul(DELTA, ROUNDS) >>> 0 : 0;

    for (let cycle = 0; cycle < ROUNDS; cycle++) {
        if (decrypt) {
            right =
                (right - (((left << 4) + key[2]) ^ (left + sum) ^ ((left >>> 5) + key[3]))) >>> 0;
            left =
                (left - (((right << 4) + key[0]) ^ (right + sum) ^ ((right >>> 5) + key[1]))) >>> 0;
            sum = (sum - DELTA) >>> 0;
        } else {
            sum = (sum + DELTA) >>> 0;
            left =
                (left + (((right << 4) + key[0]) ^ (right + sum) ^ ((right >>> 5) + key[1]))) >>> 0;
            right =
                (right + (((left << 4) + key[2]) ^ (left + sum) ^ ((left >>> 5) + key[3]))) >>> 0;
        }
    }

    const result = new Uint8Array(BLOCK_SIZE);

    try {
        const output = new DataView(result.buffer);
        output.setUint32(0, left);
        output.setUint32(4, right);
        return result;
    } catch (error) {
        if (wipe) {
            clearLocal(result);
        }

        throw error;
    }
}

/** Encrypt bytes using a fresh secure random prefix by default.
 * The optional random source is for reproducible test vectors; it must return
 * exactly the requested number of bytes. Never use a fixed source in production.
 */
export function qqTeaEncrypt(
    plaintext: Uint8Array,
    key: Uint8Array,
    randomSource: (length: number) => Uint8Array = randomBytes,
): Uint8Array {
    const words = keyWords(key);
    const padding = (8 - ((plaintext.length + 10) % 8)) % 8;
    const prefix = randomPrefix(randomSource, padding + 3);
    let padded: Uint8Array;

    try {
        padded = new Uint8Array(plaintext.length + padding + 10);
        padded.set(prefix);
    } finally {
        typedArrayFill.call(prefix, 0);
    }

    padded[0] = (padded[0] & 0xf8) | padding;
    padded.set(plaintext, padding + 3);

    const result = new Uint8Array(padded.length);
    let previousCipher: Uint8Array = new Uint8Array(BLOCK_SIZE);
    let previousMixed: Uint8Array = new Uint8Array(BLOCK_SIZE);

    for (let offset = 0; offset < padded.length; offset += BLOCK_SIZE) {
        const mixed = new Uint8Array(BLOCK_SIZE);

        for (let i = 0; i < BLOCK_SIZE; i++) {
            mixed[i] = padded[offset + i] ^ previousCipher[i];
        }

        const encrypted = teaBlock(mixed, words, false);

        for (let i = 0; i < BLOCK_SIZE; i++) {
            encrypted[i] ^= previousMixed[i];
        }

        result.set(encrypted, offset);
        previousCipher = encrypted;
        previousMixed = mixed;
    }

    return result;
}

function clearLocal(bytes: Uint8Array | undefined): void {
    if (bytes) {
        try {
            typedArrayFill.call(bytes, 0);
        } catch {
            // Best effort, independently of other owned allocations.
        }
    }
}

// The legacy path deliberately keeps its historical property access and allocation
// behavior. Only the new local-candidate path requests temporary-buffer cleanup.
function decryptPadded(ciphertext: Uint8Array, words: number[], wipe: boolean): Uint8Array {
    const padded = new Uint8Array(ciphertext.length);
    let initialCipher: Uint8Array | undefined;
    let previousCipher: Uint8Array | undefined;
    let previousMixed: Uint8Array | undefined;
    let completed = false;

    try {
        initialCipher = new Uint8Array(BLOCK_SIZE);
        previousCipher = initialCipher;
        previousMixed = new Uint8Array(BLOCK_SIZE);

        for (let offset = 0; offset < ciphertext.length; offset += BLOCK_SIZE) {
            const block = ciphertext.subarray(offset, offset + BLOCK_SIZE);
            const encrypted = new Uint8Array(BLOCK_SIZE);
            let mixed: Uint8Array | undefined;

            try {
                for (let i = 0; i < BLOCK_SIZE; i++) {
                    encrypted[i] = block[i] ^ previousMixed[i];
                }

                mixed = teaBlock(encrypted, words, true, wipe);

                for (let i = 0; i < BLOCK_SIZE; i++) {
                    padded[offset + i] = mixed[i] ^ previousCipher[i];
                }

                previousCipher = block;

                if (wipe) {
                    clearLocal(previousMixed);
                }

                previousMixed = mixed;
                mixed = undefined;
            } finally {
                if (wipe) {
                    clearLocal(encrypted);
                    clearLocal(mixed);
                }
            }
        }

        completed = true;
        return padded;
    } finally {
        if (wipe) {
            clearLocal(initialCipher);
            clearLocal(previousMixed);

            if (!completed) {
                clearLocal(padded);
            }
        }
    }
}

/** Decrypt one complete QQ-TEA ciphertext, rejecting malformed framing. */
export function qqTeaDecrypt(ciphertext: Uint8Array, key: Uint8Array): Uint8Array {
    const words = keyWords(key);

    if (ciphertext.length < 16 || ciphertext.length % BLOCK_SIZE !== 0) {
        throw new Error('invalid QQ-TEA ciphertext');
    }

    const padded = decryptPadded(ciphertext, words, false);
    const start = (padded[0] & 7) + 3;
    const end = padded.length - 7;

    let invalidTrailer = 0;

    for (let i = end; i < padded.length; i++) {
        invalidTrailer |= padded[i];
    }

    if (start > end || invalidTrailer !== 0) {
        throw new Error('invalid QQ-TEA ciphertext');
    }

    return padded.slice(start, end);
}

/** @internal Local framing observations, not native equivalence or authentication. */
type LocalQqTeaResidualResult =
    | { kind: 'success'; data: Uint8Array }
    | { kind: 'framing-invalid'; stage: 'early' | 'late'; nextCapacity: number }
    | { kind: 'capacity-exceeded' };

/** @internal Inputs must already be private snapshots; unexpected exceptions propagate. */
function qqTeaDecryptLocalResidual(
    ciphertext: Uint8Array,
    key: Uint8Array,
    capacity: number,
): LocalQqTeaResidualResult {
    const words = keyWords(key);
    let padded: Uint8Array | undefined;

    try {
        if (ciphertext.length < 16 || ciphertext.length % BLOCK_SIZE !== 0) {
            throw new Error('invalid QQ-TEA ciphertext');
        }

        padded = decryptPadded(ciphertext, words, true);
        const start = (padded[0] & 7) + 3;
        const end = padded.length - 7;

        if (start > end) {
            return { kind: 'framing-invalid', stage: 'early', nextCapacity: ciphertext.length };
        }

        const size = end - start;

        if (size > capacity) {
            return { kind: 'capacity-exceeded' };
        }

        let invalidTrailer = 0;

        for (let i = end; i < padded.length; i++) {
            invalidTrailer |= padded[i];
        }

        if (invalidTrailer !== 0) {
            return { kind: 'framing-invalid', stage: 'late', nextCapacity: size };
        }

        return { kind: 'success', data: padded.slice(start, end) };
    } finally {
        clearLocal(padded);

        try {
            words.fill(0);
        } catch {
            // Number values and engine copies cannot be reliably erased.
        }
    }
}

/** Local per-input limit; this is not a peak-memory limit or a target rule. */
export const MAX_SELECTOR1_LOCAL_CANDIDATE_BYTES = 16 * 1024 * 1024;

export interface Selector1LocalQqTeaResidualCapacityOptions {
    primaryKey: Uint8Array;
    ciphertext: Uint8Array;
    /** Read only after a primary framing failure. Keep it stable until then. */
    secondaryKey?: Uint8Array;
}

export type Selector1LocalQqTeaResidualCapacityResult = {
    kind: 'plaintext-candidate';
    data: Uint8Array;
};

function candidateFailure(): never {
    throw new Error('selector 1 local candidate decoding failed');
}

const Bytes = Uint8Array;
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const tag = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const length = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const offset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const candidateArrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const values = Uint8Array.prototype.values;
const set = Uint8Array.prototype.set;
const fill = Uint8Array.prototype.fill;

function clear(bytes: Uint8Array | undefined): void {
    if (bytes) {
        try {
            fill.call(bytes, 0);
        } catch {
            // Every owned allocation receives an independent best-effort attempt.
        }
    }
}

function dataProperty(object: object, name: string, optional = false): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);

    if (!descriptor && optional) {
        return undefined;
    }

    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        return candidateFailure();
    }

    return descriptor.value;
}

function snapshot(value: unknown, minimum: number, maximum: number): Uint8Array {
    if (isProxy(value) || !ArrayBuffer.isView(value) || tag.call(value) !== 'Uint8Array') {
        return candidateFailure();
    }

    let next: object | null = value;

    for (let depth = 0; next !== null; depth++) {
        if (depth >= 256 || isProxy(next)) {
            return candidateFailure();
        }

        next = Object.getPrototypeOf(next) as object | null;
    }

    const backing = buffer.call(value) as ArrayBuffer;

    try {
        candidateArrayBufferLength.call(backing);
        values.call(value);
    } catch (error) {
        if (error instanceof TypeError) {
            return candidateFailure();
        }

        throw error;
    }

    const size = length.call(value) as number;
    const start = offset.call(value) as number;

    if (size < minimum || size > maximum) {
        return candidateFailure();
    }

    const result = new Bytes(size);

    try {
        set.call(result, new Bytes(backing, start, size));
        return result;
    } catch (error) {
        clear(result);
        throw error;
    }
}

/**
 * Explicit local selector-1 two-key experiment, not target equivalence or peer
 * authentication. Only a local QQ-TEA framing failure permits a second attempt.
 * Verify the original frame independently before use. Do not expose any failure,
 * timing or key-selection observation to a peer or log; this is not constant-time.
 * No network, downstream parsing, key discovery or automatic integration occurs.
 * Each synchronous attempt is O(ciphertext length), with per-block allocations;
 * the input cap is not a peak-memory or deadline guarantee. Callers must bound
 * their trusted inputs and execution time. Secondary input is read lazily and
 * must stay isolated and stable until read.
 * Caller inputs and successful output stay owned by the caller. Cleanup is best
 * effort and cannot erase JavaScript number values, GC copies or native copies.
 */
export function decodeSelector1LocalQqTeaResidualCapacityCandidate(
    options: Selector1LocalQqTeaResidualCapacityOptions,
): Selector1LocalQqTeaResidualCapacityResult {
    let primaryKey: Uint8Array | undefined;
    let secondaryKey: Uint8Array | undefined;
    let ciphertext: Uint8Array | undefined;
    let plaintext: Uint8Array | undefined;

    try {
        if (typeof options !== 'object' || options === null || isProxy(options)) {
            return candidateFailure();
        }

        primaryKey = snapshot(dataProperty(options, 'primaryKey'), 16, 16);
        ciphertext = snapshot(
            dataProperty(options, 'ciphertext'),
            16,
            MAX_SELECTOR1_LOCAL_CANDIDATE_BYTES,
        );

        if (ciphertext.length % 8 !== 0) {
            return candidateFailure();
        }

        const first = qqTeaDecryptLocalResidual(ciphertext, primaryKey, ciphertext.length);

        if (first.kind === 'success') {
            plaintext = first.data;

            if (plaintext.length === 0) {
                return candidateFailure();
            }

            const result = plaintext;
            plaintext = undefined;
            return { kind: 'plaintext-candidate', data: result };
        }

        if (first.kind !== 'framing-invalid') {
            return candidateFailure();
        }

        const secondary = dataProperty(options, 'secondaryKey', true);

        if (secondary === undefined) {
            return candidateFailure();
        }

        secondaryKey = snapshot(secondary, 16, 16);
        const second = qqTeaDecryptLocalResidual(ciphertext, secondaryKey, first.nextCapacity);

        if (second.kind === 'framing-invalid') {
            return candidateFailure();
        }

        if (second.kind === 'capacity-exceeded') {
            return candidateFailure();
        }

        plaintext = second.data;

        if (plaintext.length === 0) {
            return candidateFailure();
        }

        const result = plaintext;
        plaintext = undefined;
        return { kind: 'plaintext-candidate', data: result };
    } finally {
        clear(plaintext);
        clear(secondaryKey);
        clear(ciphertext);
        clear(primaryKey);
    }
}
