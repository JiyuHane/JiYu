import { isProxy, isUint8Array } from 'node:util/types';

const ERROR = 'target sign presence mask candidate failed';

// Capture the intrinsics at module initialization; never consult an input's
// own properties, prototype methods, iterator, constructor, or species.
const apply = Reflect.apply;
const isInteger = Number.isInteger;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const getBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!;
const getByteLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get!;
const getArrayBufferByteLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const values = Uint8Array.prototype.values;

function byteLength(input: Uint8Array): number {
    if (isProxy(input) || !isUint8Array(input)) {
        throw new TypeError();
    }

    // Creating, but not advancing, the iterator validates detached/OOB views.
    apply(values, input, []);
    const buffer = apply(getBuffer, input, []);
    apply(getArrayBufferByteLength, buffer, []); // Reject shared backing, including cross-realm SAB.
    return apply(getByteLength, input, []) as number;
}

/**
 * Offline candidate for three presence bits; this does not implement a signer,
 * protobuf or network tags, a wire protocol, or real QQ interoperability.
 *
 * Static observations at 0x670e201–0x670e293 construct temporary fields at
 * +0xb8/+0xd0/+0xe8 from request members +0xf8/+0x110/+0x128. At 0x676c540 a
 * temporary pointer is saved in r12; later, the corresponding nonempty cases OR
 * 0x01/0x02/0x04 into [r14+0x10], while empty cases preserve the existing bits.
 * Helpers also copy to target +0x18/+0x20/+0x28. The candidate names
 * sign/token/extra and their mapping are conditional on the callback type and
 * on no replacement or aliasing between the relevant target objects. This
 * function models only the resulting mask under those assumptions; it does not
 * model the native objects, helper copies, or their side effects.
 *
 * Each argument must be a genuine, attached, in-bounds, nonshared Uint8Array;
 * Buffer instances, subviews, and cross-realm arrays are accepted. Initial mask
 * must be an integer in 0..255. Each nonempty view ORs its respective bit into
 * the supplied mask, without clearing any bit or examining any element. Input
 * views may overlap in this JavaScript model and are never mutated or retained;
 * the return value is a number. Every failure has the same input-free error.
 * Captured built-ins must be intact when this module is initialized.
 */
export function targetSignPresenceMaskCandidate(
    sign: Uint8Array,
    token: Uint8Array,
    extra: Uint8Array,
    initialMask: number,
): number {
    try {
        if (
            typeof initialMask !== 'number' ||
            !isInteger(initialMask) ||
            initialMask < 0 ||
            initialMask > 0xff
        ) {
            throw new TypeError();
        }

        const signLength = byteLength(sign);
        const tokenLength = byteLength(token);
        const extraLength = byteLength(extra);

        return (
            initialMask |
            (signLength > 0 ? 0x01 : 0) |
            (tokenLength > 0 ? 0x02 : 0) |
            (extraLength > 0 ? 0x04 : 0)
        );
    } catch {
        throw new Error(ERROR);
    }
}
