import { isProxy } from 'node:util/types';

/** Local inclusive frame limit, not an observed target protocol limit. */
export const MAX_TARGET_SERVICE_BUSINESS_RESPONSE_BYTES = 16 * 1024 * 1024;

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

/**
 * Read only the raw inclusive-length business wrapper, not a complete response.
 * The selected target's head flag low bit leads to UncompressBuffer, whose
 * mechanism is unknown. When that flag is set, body remains compressed here;
 * this function performs no decompression, identity, sequence or trust checks.
 * The returned body is an independent copy and trailing input is left unread.
 */
export function decodeTargetServiceBusinessResponse(
    input: Uint8Array,
    offset = 0,
): { body: Uint8Array; nextOffset: number } {
    let body: Uint8Array | undefined;
    let transferred = false;

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
            // The intrinsic rejects ordinary ArrayBuffers across realms as well.
        }

        if (shared) {
            throw new TypeError('shared backing');
        }

        // Validates detached and out-of-bounds resizable views before reading.
        typedArrayValues.call(input);

        if (offset > byteLength || byteLength - offset < 4) {
            throw new RangeError('truncated length');
        }

        // This view exposes exactly the four-byte prefix, not the full backing.
        const length = new DataView(buffer, byteOffset + offset, 4).getUint32(0, false);

        if (
            length < 4 ||
            length > MAX_TARGET_SERVICE_BUSINESS_RESPONSE_BYTES ||
            length > byteLength - offset
        ) {
            throw new RangeError('invalid length');
        }

        body = new Uint8Array(length - 4);
        const source = new Uint8Array(buffer, byteOffset + offset + 4, length - 4);
        copyBytes.call(body, source);
        const result = { body, nextOffset: offset + length };
        transferred = true;
        return result;
    } catch {
        // Do not expose input-dependent exceptions or caller-controlled objects.
        throw new Error('target service business response decoding failed');
    } finally {
        try {
            if (body && !transferred) {
                clearBytes.call(body, 0);
            }
        } catch {
            // Best effort only; preserve the fixed error.
        }
    }
}
