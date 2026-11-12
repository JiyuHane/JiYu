import { isProxy } from 'node:util/types';

// Static evidence for wrapper.node SHA-256
// dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328:
// class v12 EncodeReqHead at VA 0x6669490, reached by the vtable relocation at
// file offset 0x576ad0. This describes observed writes, not runtime reachability,
// actual wire compatibility, server acceptance, or a signing algorithm.

/** Local allocation limit, not a claim about the target's protocol limits. */
export const MAX_TARGET_SSO12_HEAD_BYTES = 16 * 1024 * 1024;

export interface TargetSso12Head {
    /** req[0x20], represented as the exact unsigned 32-bit bit pattern. */
    sequence: number;
    arg0: number;
    arg4: number;
    arg8: number;
    a2: Uint8Array;
    /** Raw bytes from req+0x28; no character encoding is imposed. */
    requestCommand: Uint8Array;
    this8: Uint8Array;
    arg28: Uint8Array;
    this20: Uint8Array;
    /** Raw bytes from arg+0x10; its inclusive two-byte length must fit u16. */
    versionArg10: Uint8Array;
    reserved: Uint8Array;
}

class HeadInputError extends RangeError {}

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
const copyBytes = Uint8Array.prototype.set;

function uint(value: unknown, maximum: number, name: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maximum) {
        throw new HeadInputError(`invalid ${name}`);
    }

    return value;
}

/**
 * Encode only the target-static SSO12 request head, including its BE32 total
 * length. All opaque fields are supplied as bytes. The result may contain
 * sensitive caller input and must not be logged. No body, outer frame, crypto,
 * signature, network, or account logic is implemented here. The target's
 * request+0x80 pointer and +0x88 nonzero preconditions are not modeled.
 * Rejecting an oversized inclusive u16 version is a local policy.
 *
 * Only plain records with own data properties are accepted; accessors and
 * proxies are rejected without invoking their traps. Byte arrays are copied
 * without their iterators or overridden instance methods. Shared backing
 * storage is rejected across realms because a concurrent writer could race.
 * Local snapshots are cleared on every outcome, best effort; returned bytes stay
 * caller-owned. This does not guarantee erasure of JavaScript-internal copies.
 */
export function encodeTargetSso12Head(input: TargetSso12Head): Uint8Array {
    const owned: Uint8Array[] = [];

    try {
        return encode(input, owned);
    } catch {
        // Never rethrow caller-controlled or previously exposed exception objects.
        throw new Error('target SSO12 head construction failed');
    } finally {
        for (const copy of owned) {
            try {
                copy.fill(0);
            } catch {
                // Best effort per local snapshot, preserving the construction outcome.
            }
        }
    }
}

function encode(input: TargetSso12Head, owned: Uint8Array[]): Uint8Array {
    if (input === null || typeof input !== 'object' || isProxy(input)) {
        throw new HeadInputError('invalid head input');
    }

    const prototype: unknown = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
        throw new HeadInputError('invalid head input');
    }

    const descriptors = Object.getOwnPropertyDescriptors(input);
    const record: Record<PropertyKey, unknown> = Object.create(null) as Record<
        PropertyKey,
        unknown
    >;

    for (const name of Reflect.ownKeys(descriptors)) {
        const descriptor = Reflect.get(descriptors, name) as PropertyDescriptor;

        if (!Object.hasOwn(descriptor, 'value')) {
            throw new HeadInputError('accessors are not supported');
        }

        record[name] = descriptor.value;
    }

    const sequence = uint(record.sequence, 0xffffffff, 'sequence');
    const arg0 = uint(record.arg0, 0xffffffff, 'arg0');
    const arg4 = uint(record.arg4, 0xffffffff, 'arg4');
    const arg8 = uint(record.arg8, 0xff, 'arg8');

    // Head length prefix, three u32 words, twelve fixed/mixed bytes, five
    // u32-inclusive field prefixes, a u16-inclusive prefix and reserved u32.
    let size = 54;

    function snapshot(value: unknown, name: string, max: number): Uint8Array {
        if (!ArrayBuffer.isView(value) || typedArrayTag.call(value) !== 'Uint8Array') {
            throw new HeadInputError(`invalid ${name}`);
        }

        const length = typedArrayLength.call(value) as number;
        const buffer: unknown = typedArrayBuffer.call(value);
        let shared = false;

        try {
            sharedBufferLength.call(buffer);
            shared = true;
        } catch {
            // The intrinsic rejects non-shared ArrayBuffer backing storage.
        }

        if (shared) {
            throw new HeadInputError(`invalid ${name}`);
        }

        if (length > max || length > MAX_TARGET_SSO12_HEAD_BYTES - size) {
            throw new HeadInputError('target SSO12 head exceeds size limit');
        }

        size += length;
        const copy = new Uint8Array(length);
        owned.push(copy);
        copyBytes.call(copy, value as Uint8Array);
        return copy;
    }

    const a2 = snapshot(record.a2, 'a2', MAX_TARGET_SSO12_HEAD_BYTES);
    const command = snapshot(record.requestCommand, 'requestCommand', MAX_TARGET_SSO12_HEAD_BYTES);
    const this8 = snapshot(record.this8, 'this8', MAX_TARGET_SSO12_HEAD_BYTES);
    const arg28 = snapshot(record.arg28, 'arg28', MAX_TARGET_SSO12_HEAD_BYTES);
    const this20 = snapshot(record.this20, 'this20', MAX_TARGET_SSO12_HEAD_BYTES);
    const version = snapshot(record.versionArg10, 'versionArg10', 0xffff - 2);
    const reserved = snapshot(record.reserved, 'reserved', MAX_TARGET_SSO12_HEAD_BYTES);
    const result = new Uint8Array(size);
    const view = new DataView(result.buffer);
    view.setUint32(0, size);
    view.setUint32(4, sequence);
    view.setUint32(8, arg0);
    view.setUint32(12, arg4);
    // Bytes 16..25 and byte 27 remain zero. Byte 26 is arg[8].
    result[26] = arg8;
    let offset = 28;

    function append(value: Uint8Array, width: 2 | 4): void {
        if (width === 2) {
            view.setUint16(offset, value.length + width);
        } else {
            view.setUint32(offset, value.length + width);
        }

        offset += width;
        copyBytes.call(result, value, offset);
        offset += value.length;
    }

    append(a2, 4);
    append(command, 4);
    append(this8, 4);
    append(arg28, 4);
    append(this20, 4);
    append(version, 2);
    append(reserved, 4);
    return result;
}
