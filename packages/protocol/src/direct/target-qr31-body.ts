import { isProxy } from 'node:util/types';

/** Local policies, not target limits. The byte cap is not a peak-memory bound. */
export const MAX_TARGET_QR31_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_TARGET_QR31_CHILDREN = 4096;
export const MAX_TARGET_QR31_COMPONENT_BYTES = 0xffff;

export interface TargetQr31Body {
    field38: Uint8Array;
    field50: number;
    field30: bigint;
    field54: number;
    field58: Uint8Array;
    /** The observed u16 bit pattern; it is not inferred from children.length. */
    field80: number;
    /** Already encoded bytes for non-null child virtual outputs in observed traversal order. */
    children: readonly Uint8Array[];
}

const Bytes = Uint8Array;
const View = DataView;
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const tag = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const backingBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const byteLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(
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
            // Each owned buffer is independently cleared, best effort.
        }
    }
}

function boundedChain(value: object): void {
    let current: object | null = value;

    for (let depth = 0; current !== null; depth++) {
        if (depth >= 256 || isProxy(current)) {
            throw new TypeError();
        }

        current = Object.getPrototypeOf(current) as object | null;
    }
}

function numberValue(value: unknown, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
        throw new TypeError();
    }

    return value;
}

function data(object: object, name: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);

    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError();
    }

    return descriptor.value;
}

/**
 * Encode only the target-static 0x31 body skeleton, not a QR login flow. The
 * two u16-prefixed fields contain their byte lengths excluding the prefixes.
 * The target's observed oversized-field path truncates the prefix but continues
 * writing bytes; this local API instead rejects components above 65535 bytes.
 * field80 is copied independently, with no known relationship to child count.
 * Children are caller-provided virtual outputs for non-null tree nodes, already
 * encoded in caller-selected observed traversal order; no tag or length is added.
 * The caller owns child construction, WT envelope, signing and session logic.
 * There is no network, QR state, authentication or proof of target compatibility.
 * Inputs must stay stable until individually snapshotted. Temporary byte copies
 * and failed outputs are wiped best effort; JS/runtime copies can remain.
 */
export function encodeTargetQr31Body(input: TargetQr31Body): Uint8Array {
    const owned: Uint8Array[] = [];
    let output: Uint8Array | undefined;
    let transferred = false;

    try {
        if (input === null || typeof input !== 'object' || isProxy(input)) {
            throw new TypeError();
        }

        const prototype = Object.getPrototypeOf(input);

        if (prototype !== null && prototype !== Object.prototype) {
            throw new TypeError();
        }

        // Reject unrelated accessors too, without ever invoking them.
        for (const name of Reflect.ownKeys(input)) {
            const descriptor = Object.getOwnPropertyDescriptor(input, name);

            if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
                throw new TypeError();
            }
        }

        const field38Input = data(input, 'field38');
        const field50 = numberValue(data(input, 'field50'), 0xffffffff);
        const field30 = data(input, 'field30');
        const field54 = numberValue(data(input, 'field54'), 0xff);
        const field58Input = data(input, 'field58');
        const field80 = numberValue(data(input, 'field80'), 0xffff);
        const childInput = data(input, 'children');

        if (typeof field30 !== 'bigint' || field30 < 0n || field30 > 0xffffffffffffffffn) {
            throw new TypeError();
        }

        if (isProxy(childInput) || !Array.isArray(childInput)) {
            throw new TypeError();
        }

        boundedChain(childInput);
        const count = numberValue(data(childInput, 'length'), MAX_TARGET_QR31_CHILDREN);

        for (const name of Reflect.ownKeys(childInput)) {
            const descriptor = Object.getOwnPropertyDescriptor(childInput, name);

            if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
                throw new TypeError();
            }
        }

        let size = 19;

        const snapshot = (value: unknown): Uint8Array => {
            if (isProxy(value) || !ArrayBuffer.isView(value) || tag.call(value) !== 'Uint8Array') {
                throw new TypeError();
            }

            boundedChain(value);
            const buffer = backingBuffer.call(value) as ArrayBuffer;
            arrayBufferLength.call(buffer); // Also rejects shared backing in other realms.
            values.call(value); // Reject detached and out-of-bounds resizable views.
            const length = byteLength.call(value) as number;
            const offset = byteOffset.call(value) as number;

            if (
                length > MAX_TARGET_QR31_COMPONENT_BYTES ||
                length > MAX_TARGET_QR31_BODY_BYTES - size
            ) {
                throw new RangeError();
            }

            size += length;
            const copy = new Bytes(length);
            owned.push(copy);
            set.call(copy, new Bytes(buffer, offset, length));
            return copy;
        };

        const field38 = snapshot(field38Input);
        const field58 = snapshot(field58Input);
        const children: Uint8Array[] = [];

        for (let i = 0; i < count; i++) {
            children.push(snapshot(data(childInput, String(i))));
        }

        output = new Bytes(size);
        const view = new View(output.buffer, output.byteOffset, output.byteLength);
        let offset = 0;
        view.setUint16(offset, field38.length, false);
        offset += 2;
        set.call(output, field38, offset);
        offset += field38.length;
        view.setUint32(offset, field50, false);
        offset += 4;
        view.setBigUint64(offset, field30, false);
        offset += 8;
        view.setUint8(offset, field54);
        offset++;
        view.setUint16(offset, field58.length, false);
        offset += 2;
        set.call(output, field58, offset);
        offset += field58.length;
        view.setUint16(offset, field80, false);
        offset += 2;

        for (const child of children) {
            set.call(output, child, offset);
            offset += child.length;
        }

        transferred = true;
        return output;
    } catch {
        throw new Error('target QR31 body construction failed');
    } finally {
        for (const bytes of owned) {
            clear(bytes);
        }

        if (!transferred) {
            clear(output);
        }
    }
}
