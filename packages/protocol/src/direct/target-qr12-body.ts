import { isProxy } from 'node:util/types';

/** Local limits; none claims the target's truncation or allocation behavior. */
export const MAX_TARGET_QR12_COMPONENT_BYTES = 0xffff;
export const MAX_TARGET_QR12_VALUES = 4096;
export const MAX_TARGET_QR12_BODY_BYTES = 16 * 1024 * 1024;

export interface TargetQr12Body {
    field38: Uint8Array;
    field50: number;
    field58: Uint8Array;
    field30: bigint;
    field70: number;
    field78: Uint8Array;
    values: readonly number[];
}

export interface TargetQr12QueryBody {
    field50: number;
    field30: bigint;
    field58: Uint8Array;
}

const Bytes = Uint8Array;
const View = DataView;
const typed = Object.getPrototypeOf(Bytes.prototype) as object;
const tag = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const byteBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const byteLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const valuesIntrinsic = Bytes.prototype.values;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;

function clear(bytes: Uint8Array | undefined): void {
    if (bytes) {
        try {
            fill.call(bytes, 0);
        } catch {
            // Each allocation receives a separate best-effort cleanup attempt.
        }
    }
}

function chain(value: object): void {
    let current: object | null = value;

    for (let depth = 0; current !== null; depth++) {
        if (depth >= 256 || isProxy(current)) {
            throw new TypeError();
        }

        current = Object.getPrototypeOf(current) as object | null;
    }
}

function assertDataObject(value: unknown): asserts value is object {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        throw new TypeError();
    }

    chain(value);

    for (const name of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);

        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError();
        }
    }
}

function data(value: object, name: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);

    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError();
    }

    return descriptor.value;
}

function uint(value: unknown, maximum: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maximum) {
        throw new TypeError();
    }

    return value;
}

/**
 * Encode the statically observed 0x12 body skeleton with caller-selected fields.
 * Component and count limits are local policies, not target behavior. Values are
 * BE16 entries without TLV tags. This does not establish peer identity, field
 * semantics, signing, QQ compatibility or a complete login/scan flow. Byte inputs
 * are snapshotted; temporary copies and unsuccessful output are cleared best effort,
 * while JavaScript, crypto providers and GC may retain other copies.
 */
export function encodeTargetQr12Body(input: TargetQr12Body): Uint8Array {
    const owned: Uint8Array[] = [];
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        assertDataObject(input);
        const field38Input = data(input, 'field38');
        const field50 = uint(data(input, 'field50'), 0xffffffff);
        const field58Input = data(input, 'field58');
        const field30 = data(input, 'field30');
        const field70 = uint(data(input, 'field70'), 0xff);
        const field78Input = data(input, 'field78');
        const valuesInput = data(input, 'values');

        if (
            typeof field30 !== 'bigint' ||
            field30 < 0n ||
            field30 > 0xffffffffffffffffn ||
            isProxy(valuesInput) ||
            !Array.isArray(valuesInput)
        ) {
            throw new TypeError();
        }

        assertDataObject(valuesInput);
        const count = uint(data(valuesInput, 'length'), MAX_TARGET_QR12_VALUES);
        const values: number[] = [];

        for (let i = 0; i < count; i++) {
            values.push(uint(data(valuesInput, String(i)), 0xffff));
        }

        let size = 21 + 2 * count;

        const snapshot = (value: unknown): Uint8Array => {
            if (isProxy(value) || !ArrayBuffer.isView(value) || tag.call(value) !== 'Uint8Array') {
                throw new TypeError();
            }

            chain(value);
            const backing = byteBuffer.call(value) as ArrayBuffer;
            bufferLength.call(backing);
            valuesIntrinsic.call(value);
            const length = byteLength.call(value) as number;
            const offset = byteOffset.call(value) as number;

            if (
                length > MAX_TARGET_QR12_COMPONENT_BYTES ||
                length > MAX_TARGET_QR12_BODY_BYTES - size
            ) {
                throw new RangeError();
            }

            size += length;
            const copy = new Bytes(length);
            owned.push(copy);
            set.call(copy, new Bytes(backing, offset, length));
            return copy;
        };

        const field38 = snapshot(field38Input);
        const field58 = snapshot(field58Input);
        const field78 = snapshot(field78Input);
        output = new Bytes(size);
        const view = new View(output.buffer, output.byteOffset, output.byteLength);
        let offset = 0;
        view.setUint16(offset, field38.length, false);
        offset += 2;
        set.call(output, field38, offset);
        offset += field38.length;
        view.setUint32(offset, field50, false);
        offset += 4;
        view.setUint16(offset, field58.length, false);
        offset += 2;
        set.call(output, field58, offset);
        offset += field58.length;
        view.setBigUint64(offset, field30, false);
        offset += 8;
        view.setUint8(offset++, field70);
        view.setUint16(offset, field78.length, false);
        offset += 2;
        set.call(output, field78, offset);
        offset += field78.length;
        view.setUint16(offset, count, false);
        offset += 2;

        for (let i = 0; i < count; i++) {
            view.setUint16(offset, values[i], false);
            offset += 2;
        }

        complete = true;
        return output;
    } catch {
        throw new Error('target QR12 body construction failed');
    } finally {
        for (const bytes of owned) {
            clear(bytes);
        }

        if (!complete) {
            clear(output);
        }
    }
}

/**
 * Encode the observed query-construction subset, assuming normal target returns
 * and no modifying aliases. Empty fields and zero are local projections of that
 * constructor path; the caller supplies the remaining values and trust policy.
 * No semantic identity is assigned to field58.
 */
export function encodeTargetQr12QueryBody(input: TargetQr12QueryBody): Uint8Array {
    try {
        assertDataObject(input);
        const field50 = uint(data(input, 'field50'), 0xffffffff);
        const field30 = data(input, 'field30');
        const field58 = data(input, 'field58');
        return encodeTargetQr12Body({
            field38: new Bytes(0),
            field50,
            field58: field58 as Uint8Array,
            field30: field30 as bigint,
            field70: 0,
            field78: new Bytes(0),
            values: [],
        });
    } catch {
        throw new Error('target QR12 body construction failed');
    }
}
