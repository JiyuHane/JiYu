import { isProxy } from 'node:util/types';

/** Local inclusive limit, not an observed target protocol limit. */
export const MAX_TARGET_SSO12_RESPONSE_PREFIX_BYTES = 16 * 1024 * 1024;

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

/**
 * Probe only the first three words of an inclusive-length response head. The
 * local minimum of 12 is deliberately stricter than the observed native L >= 5;
 * native reads may cross the declared head boundary into the following bytes.
 * Remaining head fields are opaque. This is not a complete DecodeRspHead, nor
 * does it authenticate a peer, bind a request, decompress or parse a body.
 */
export function decodeTargetSso12ResponsePrefix(
    input: Uint8Array,
    offset = 0,
): {
    headLength: number;
    sequenceBits: number;
    followingWord: number;
    remainingHead: Uint8Array;
    nextOffset: number;
} {
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

        const buffer: ArrayBuffer = typedArrayBuffer.call(input);
        const byteLength: number = typedArrayLength.call(input);
        const byteOffset: number = typedArrayOffset.call(input);
        let shared = false;

        try {
            sharedBufferLength.call(buffer);
            shared = true;
        } catch {
            // Intrinsic branding also handles backing buffers from other realms.
        }

        if (shared) {
            throw new TypeError('shared backing');
        }

        // Validate detached or out-of-bounds resizable views without input getters.
        typedArrayValues.call(input);

        if (offset > byteLength || byteLength - offset < 12) {
            throw new RangeError('truncated prefix');
        }

        const view = new DataView(buffer, byteOffset + offset, 12);
        const headLength = view.getUint32(0, false);

        if (
            headLength < 12 ||
            headLength > MAX_TARGET_SSO12_RESPONSE_PREFIX_BYTES ||
            headLength > byteLength - offset
        ) {
            throw new RangeError('invalid head length');
        }

        const sequenceBits = view.getUint32(4, false);
        const followingWord = view.getUint32(8, false);
        const remainingHead = new Uint8Array(headLength - 12);
        const source = new Uint8Array(buffer, byteOffset + offset + 12, headLength - 12);
        copyBytes.call(remainingHead, source);
        return {
            headLength,
            sequenceBits,
            followingWord,
            remainingHead,
            nextOffset: offset + headLength,
        };
    } catch {
        throw new Error('target sso12 response prefix decoding failed');
    }
}
