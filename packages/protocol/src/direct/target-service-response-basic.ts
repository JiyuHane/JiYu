import { isProxy } from 'node:util/types';

/** Local cap on all basic bytes, including the fixed prefix and length word. */
export const MAX_TARGET_SERVICE_RESPONSE_BASIC_BYTES = 16 * 1024 * 1024;

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
 * Parse only the statically observed basic fields, with local bounds. Exact-end
 * input is accepted here; the observed packet caller requires a remainder.
 * The local cap covers only 10 + L basic bytes, excluding any trailing bytes.
 * Neither word is treated as a frame length; flag9 has unknown semantics and is
 * not a response-head decompression flag. Opaque bytes are not interpreted,
 * decrypted, authenticated or associated with an account.
 */
export function decodeTargetServiceResponseBasic(
    input: Uint8Array,
    offset = 0,
): {
    word0: number;
    word4: number;
    selector: number;
    flag9: number;
    opaque: Uint8Array;
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
            // Intrinsic branding handles shared backing buffers from other realms.
        }

        if (shared) {
            throw new TypeError('shared backing');
        }

        // Also validate detached and out-of-bounds resizable views.
        typedArrayValues.call(input);

        if (offset > byteLength || byteLength - offset < 14) {
            throw new RangeError('truncated basic prefix');
        }

        const view = new DataView(buffer, byteOffset + offset, 14);
        const word0 = view.getUint32(0, false);
        const word4 = view.getUint32(4, false);
        const selector = view.getUint8(8);
        const flag9 = view.getUint8(9);
        const length = view.getUint32(10, false);
        const total = 10 + length;

        if (
            length < 4 ||
            total > MAX_TARGET_SERVICE_RESPONSE_BASIC_BYTES ||
            total > byteLength - offset
        ) {
            throw new RangeError('invalid basic length');
        }

        const opaque = new Uint8Array(length - 4);
        const source = new Uint8Array(buffer, byteOffset + offset + 14, length - 4);
        copyBytes.call(opaque, source);
        return { word0, word4, selector, flag9, opaque, nextOffset: offset + total };
    } catch {
        throw new Error('target service response basic decoding failed');
    }
}
