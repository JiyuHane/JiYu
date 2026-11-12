import { isProxy } from 'node:util/types';

/** Inclusive local resource limit; not an observed target limit. */
export const MAX_TARGET_SSO12_RESPONSE_HEAD_BYTES = 16 * 1024 * 1024;

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayTag = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    Symbol.toStringTag,
)!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const sharedBufferLength = Object.getOwnPropertyDescriptor(
    SharedArrayBuffer.prototype,
    'byteLength',
)!.get!;
const typedArrayValues = Uint8Array.prototype.values;
const copyBytes = Uint8Array.prototype.set;
const clearBytes = Uint8Array.prototype.fill;
const getPrototypeOf = Object.getPrototypeOf;

type Span = { start: number; length: number };

/**
 * Parse the observed response-head fields strictly inside the declared head.
 * All byte fields and the unparsed tail are independent copies. This local parser
 * does not interpret flags, decompress, authenticate, or bind a sequence.
 */
export function decodeTargetSso12ResponseHead(
    input: Uint8Array,
    offset = 0,
): {
    headLength: number;
    sequenceBits: number;
    followingWord: number;
    field1: Uint8Array;
    field2: Uint8Array;
    field3: Uint8Array;
    flagsWord: number;
    reserve: Uint8Array;
    tail: Uint8Array;
    nextOffset: number;
} {
    const owned: Uint8Array[] = [];

    try {
        if (
            isProxy(input) ||
            !ArrayBuffer.isView(input) ||
            typedArrayTag.call(input) !== 'Uint8Array' ||
            typeof offset !== 'number' ||
            !Number.isSafeInteger(offset) ||
            offset < 0
        ) {
            throw new TypeError('invalid input');
        }

        // Do not traverse a proxy, and bound pathological prototype chains.
        let current: object | null = input;
        let depth = 0;

        while (current !== null) {
            if (isProxy(current) || depth++ >= 256) {
                throw new TypeError('invalid prototype chain');
            }

            current = getPrototypeOf(current);
        }

        const buffer: ArrayBuffer = typedArrayBuffer.call(input);
        const byteLength: number = typedArrayLength.call(input);
        const byteOffset: number = typedArrayOffset.call(input);
        let shared = false;

        try {
            sharedBufferLength.call(buffer);
            shared = true;
        } catch {
            // The intrinsic rejects ordinary ArrayBuffers, including foreign ones.
        }

        if (shared) {
            throw new TypeError('shared backing');
        }

        // Detect detached and out-of-bounds resizable views without input getters.
        typedArrayValues.call(input);

        if (offset > byteLength || byteLength - offset < 12) {
            throw new RangeError('truncated prefix');
        }

        const headStart = byteOffset + offset;
        const prefix = new DataView(buffer, headStart, 12);
        const headLength = prefix.getUint32(0, false);

        if (
            headLength < 12 ||
            headLength > MAX_TARGET_SSO12_RESPONSE_HEAD_BYTES ||
            headLength > byteLength - offset
        ) {
            throw new RangeError('invalid head length');
        }

        const sequenceBits = prefix.getUint32(4, false);
        const followingWord = prefix.getUint32(8, false);
        const head = new DataView(buffer, headStart, headLength);
        let cursor = 12;

        const readWord = (): number => {
            if (headLength - cursor < 4) {
                throw new RangeError('truncated head word');
            }

            const value = head.getUint32(cursor, false);
            cursor += 4;
            return value;
        };

        const readSpan = (): Span => {
            const start = cursor;
            const length = readWord();

            if (length < 4 || length > headLength - start) {
                throw new RangeError('invalid head field');
            }

            cursor = start + length;
            return { start: start + 4, length: length - 4 };
        };

        const span1 = readSpan();
        const span2 = readSpan();
        const span3 = readSpan();
        const flagsWord = readWord();
        const reserveSpan = readSpan();
        const tailSpan = { start: cursor, length: headLength - cursor };

        // Validate every field before allocating; never duplicate the full head.
        const copy = (span: Span): Uint8Array => {
            const output = new Uint8Array(span.length);
            owned.push(output);
            copyBytes.call(output, new Uint8Array(buffer, headStart + span.start, span.length));
            return output;
        };

        return {
            headLength,
            sequenceBits,
            followingWord,
            field1: copy(span1),
            field2: copy(span2),
            field3: copy(span3),
            flagsWord,
            reserve: copy(reserveSpan),
            tail: copy(tailSpan),
            nextOffset: offset + headLength,
        };
    } catch {
        for (const bytes of owned) {
            try {
                clearBytes.call(bytes, 0);
            } catch {
                // Best-effort cleanup of independent outputs only.
            }
        }

        throw new Error('target sso12 response head decoding failed');
    }
}
