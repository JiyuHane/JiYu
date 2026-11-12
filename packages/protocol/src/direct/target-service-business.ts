import { isProxy } from 'node:util/types';

/** Local inclusive allocation limit, not a target protocol limit. */
export const MAX_TARGET_SERVICE_BUSINESS_BYTES = 16 * 1024 * 1024;

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayTag = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    Symbol.toStringTag,
)!.get!;
const sharedBufferLength = Object.getOwnPropertyDescriptor(
    SharedArrayBuffer.prototype,
    'byteLength',
)!.get!;
const typedArrayValues = Uint8Array.prototype.values;
const copyBytes = Uint8Array.prototype.set;

/**
 * Encode the nonempty business-body path as BE32(payload byte length + 4)
 * followed by copied payload bytes. This models length framing only, not
 * runtime reachability or wire compatibility. Intrinsic slots determine the
 * view and backing storage; caller accessors, iterators and methods are ignored.
 */
export function encodeTargetServiceBusiness(payload: Uint8Array): Uint8Array {
    try {
        if (
            isProxy(payload) ||
            !ArrayBuffer.isView(payload) ||
            typedArrayTag.call(payload) !== 'Uint8Array'
        ) {
            throw new TypeError('invalid payload');
        }

        const length = typedArrayLength.call(payload) as number;
        const buffer: unknown = typedArrayBuffer.call(payload);
        let shared = false;

        try {
            sharedBufferLength.call(buffer);
            shared = true;
        } catch {
            // The intrinsic rejects ordinary ArrayBuffers, including foreign realms.
        }

        if (shared || length === 0 || length > MAX_TARGET_SERVICE_BUSINESS_BYTES - 4) {
            throw new RangeError('invalid payload size or backing');
        }

        // Validate detachment before allocating or copying caller bytes.
        typedArrayValues.call(payload);
        const output = new Uint8Array(length + 4);
        new DataView(output.buffer).setUint32(0, length + 4, false);
        copyBytes.call(output, payload, 4);
        return output;
    } catch {
        // Do not expose caller-controlled exception objects or content.
        throw new Error('target service business construction failed');
    }
}
