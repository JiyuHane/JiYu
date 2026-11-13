import { isProxy } from 'node:util/types';

const Bytes = Uint8Array;
const View = DataView;
const typedArrayPrototype = Object.getPrototypeOf(Bytes.prototype) as object;
const byteTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const byteBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const byteValues = Bytes.prototype.values;
const byteSet = Bytes.prototype.set;
const byteFill = Bytes.prototype.fill;
const getPrototype = Object.getPrototypeOf;
const ownDescriptor = Object.getOwnPropertyDescriptor;
const isView = ArrayBuffer.isView;
const isArray = Array.isArray;

function chain(value: object): void {
    let current: object | null = value;
    let depth = 0;

    while (current !== null) {
        if (depth++ >= 256 || isProxy(current)) {
            throw new TypeError();
        }

        current = getPrototype(current) as object | null;
    }
}

function record(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        throw new TypeError();
    }

    chain(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Object.create(null) as Record<string, unknown>;

    for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;

        if (!Object.hasOwn(descriptor, 'value')) {
            throw new TypeError();
        }

        if (typeof key === 'string') {
            result[key] = descriptor.value;
        }
    }

    return result;
}

function unsigned(value: unknown, maximum: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maximum) {
        throw new TypeError();
    }

    return value;
}

function numbers(value: unknown, maximumCount: number, exact?: number): number[] {
    if (isProxy(value) || !isArray(value)) {
        throw new TypeError();
    }

    chain(value);
    const count = unsigned(ownDescriptor(value, 'length')?.value, maximumCount);

    if (exact !== undefined && count !== exact) {
        throw new TypeError();
    }

    const result: number[] = [];

    for (let i = 0; i < count; i++) {
        const item = ownDescriptor(value, String(i));

        if (!item || !Object.hasOwn(item, 'value')) {
            throw new TypeError();
        }

        result.push(unsigned(item.value, 0xffffffff));
    }

    return result;
}

function snapshot(value: unknown, maximum = 65505, exact?: number): Uint8Array {
    if (isProxy(value) || !isView(value) || byteTag.call(value) !== 'Uint8Array') {
        throw new TypeError();
    }

    chain(value);
    const backing = byteBuffer.call(value) as ArrayBuffer;
    bufferLength.call(backing);
    byteValues.call(value);
    const length = byteLength.call(value) as number;
    const offset = byteOffset.call(value) as number;

    if (length > maximum || (exact !== undefined && length !== exact)) {
        throw new RangeError();
    }

    const copy = new Bytes(length);

    try {
        byteSet.call(copy, new Bytes(backing, offset, length));
        return copy;
    } catch (error) {
        clear(copy);
        throw error;
    }
}

function clear(value: Uint8Array | undefined): void {
    if (value) {
        try {
            byteFill.call(value, 0);
        } catch {
            // Independently attempt cleanup for each private allocation.
        }
    }
}

/**
 * Experimental target-static child encoders. Each return value contains a BE16
 * tag, a BE16 body length excluding both words, and the body bytes.
 * Field meanings, object construction, call conditions and peer acceptance are
 * unknown. These are standalone local encoders, not proof of QQ interoperability.
 */
export function encodeTargetQr31Tlv35(field0c: number): Uint8Array {
    return encodeWordTlv(0x35, field0c);
}

/** The caller supplies the opaque value observed at session+0x28. */
export function encodeTargetQr31Tlv66(field0c: number): Uint8Array {
    return encodeWordTlv(0x66, field0c);
}

function encodeWordTlv(tag: number, field0c: number): Uint8Array {
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        const value = unsigned(field0c, 0xffffffff);
        output = new Bytes(8);
        const view = new View(output.buffer);
        view.setUint16(0, tag, false);
        view.setUint16(2, 4, false);
        view.setUint32(4, value, false);
        complete = true;
        return output;
    } catch {
        throw new Error('target QR31 TLV encoding failed');
    } finally {
        if (!complete) {
            clear(output);
        }
    }
}

/**
 * Encode the observed 0x33 construction path with an opaque 16-byte value.
 * Its origin is unknown. Exactly 16 bytes is a local policy for this path,
 * not a claim about all uses of the generic target child encoder.
 */
export function encodeTargetQr31Tlv33(input: Uint8Array): Uint8Array {
    let bytes: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        bytes = snapshot(input, 16, 16);
        output = new Bytes(20);
        const view = new View(output.buffer);
        view.setUint16(0, 0x33, false);
        view.setUint16(2, 16, false);
        byteSet.call(output, bytes, 4);
        complete = true;
        return output;
    } catch {
        throw new Error('target QR31 TLV encoding failed');
    } finally {
        clear(bytes);

        if (!complete) {
            clear(output);
        }
    }
}

/**
 * Encode an opaque 0x11 child span. The caller decides whether the separately
 * observed session+0xb8 condition holds; an empty span is still encodable.
 * The child span is at +0x08/+0x10, populated from session+0xa0/+0xa8 in the
 * inspected construction path. The target backfills the low 16 bits of length;
 * rejecting lengths above 65535 is a stricter local policy, not native behavior.
 */
export function encodeTargetQr31Tlv11(input: Uint8Array): Uint8Array {
    let bytes: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        bytes = snapshot(input, 65535);
        output = new Bytes(4 + bytes.length);
        const view = new View(output.buffer);
        view.setUint16(0, 0x11, false);
        view.setUint16(2, bytes.length, false);
        byteSet.call(output, bytes, 4);
        complete = true;
        return output;
    } catch {
        throw new Error('target QR31 TLV encoding failed');
    } finally {
        clear(bytes);

        if (!complete) {
            clear(output);
        }
    }
}

export interface TargetQr31Tlv16 {
    field0c: number;
    field10: number;
    field14: number;
    vector: Uint8Array;
    field30: Uint8Array;
    field48: Uint8Array;
    field60: Uint8Array;
}

/**
 * Encode the target-static 0x16 child, without inferring identity or device
 * semantics. Exactly 16 vector bytes is a local policy for the inspected
 * construction path; the caller supplies every field and their relationship.
 * The target's 16-bit length truncation is not reproduced: the local encoder
 * rejects any value length above 65535. No peer acceptance is established.
 */
export function encodeTargetQr31Tlv16(input: TargetQr31Tlv16): Uint8Array {
    let vector: Uint8Array | undefined;
    let field30: Uint8Array | undefined;
    let field48: Uint8Array | undefined;
    let field60: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        const fields = record(input);
        const field0c = unsigned(fields.field0c, 0xffffffff);
        const field10 = unsigned(fields.field10, 0xffffffff);
        const field14 = unsigned(fields.field14, 0xffffffff);
        vector = snapshot(fields.vector, 16, 16);
        field30 = snapshot(fields.field30, 65535);
        field48 = snapshot(fields.field48, 65535);
        field60 = snapshot(fields.field60, 65535);
        const size = 34 + field30.length + field48.length + field60.length;

        if (size > 65535) {
            throw new RangeError();
        }

        output = new Bytes(4 + size);
        const view = new View(output.buffer);
        view.setUint16(0, 0x16, false);
        view.setUint16(2, size, false);
        view.setUint32(4, field0c, false);
        view.setUint32(8, field10, false);
        view.setUint32(12, field14, false);
        byteSet.call(output, vector, 16);
        let offset = 32;

        for (const bytes of [field30, field48, field60]) {
            view.setUint16(offset, bytes.length, false);
            offset += 2;
            byteSet.call(output, bytes, offset);
            offset += bytes.length;
        }

        complete = true;
        return output;
    } catch {
        throw new Error('target QR31 TLV encoding failed');
    } finally {
        clear(vector);
        clear(field30);
        clear(field48);
        clear(field60);

        if (!complete) {
            clear(output);
        }
    }
}

export interface TargetQr31Tlv1d {
    field0a: number;
    field0c: number;
    field10: number;
    values: readonly number[];
}

/** The encoded count is values.length; matching the target's separate count is a caller precondition and local policy. */
export function encodeTargetQr31Tlv1d(input: TargetQr31Tlv1d): Uint8Array {
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        const fields = record(input);
        const field0a = unsigned(fields.field0a, 0xff);
        const field0c = unsigned(fields.field0c, 0xffffffff);
        const field10 = unsigned(fields.field10, 0xffffffff);
        const values = numbers(fields.values, 255);
        output = new Bytes(14 + 4 * values.length);
        const view = new View(output.buffer);
        view.setUint16(0, 0x1d, false);
        view.setUint16(2, 10 + 4 * values.length, false);
        view.setUint8(4, field0a);
        view.setUint32(5, field0c, false);
        view.setUint32(9, field10, false);
        view.setUint8(13, values.length);

        for (let i = 0; i < values.length; i++) {
            view.setUint32(14 + 4 * i, values[i], false);
        }

        complete = true;
        return output;
    } catch {
        throw new Error('target QR31 TLV encoding failed');
    } finally {
        if (!complete) {
            clear(output);
        }
    }
}

export interface TargetQr31Tlv1b {
    words: readonly number[];
    x: Uint8Array;
}

/** The seven opaque words are ordered by object offsets +0x10 through +0x28; the span cap is local. */
export function encodeTargetQr31Tlv1b(input: TargetQr31Tlv1b): Uint8Array {
    let bytes: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        const fields = record(input);
        const words = numbers(fields.words, 7, 7);
        bytes = snapshot(fields.x);
        output = new Bytes(34 + bytes.length);
        const view = new View(output.buffer);
        view.setUint16(0, 0x1b, false);
        view.setUint16(2, 30 + bytes.length, false);

        for (let i = 0; i < words.length; i++) {
            view.setUint32(4 + i * 4, words[i], false);
        }

        view.setUint16(32, bytes.length, false);
        byteSet.call(output, bytes, 34);
        complete = true;
        return output;
    } catch {
        throw new Error('target QR31 TLV encoding failed');
    } finally {
        clear(bytes);

        if (!complete) {
            clear(output);
        }
    }
}
