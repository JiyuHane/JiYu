import { isProxy } from 'node:util/types';

/** Local inclusive frame and opaque payload limits, not native rejection rules. */
export const MAX_TARGET_WT_OICQ_BYTES = 0xffff;
export const MAX_TARGET_WT_OICQ_OPAQUE_BYTES = MAX_TARGET_WT_OICQ_BYTES - 29;

export interface TargetWtOicq {
    version: number;
    command: number;
    sequence: number;
    uin: number;
    /** Explicit unsigned 16-bit value, zero-extended into the 32-bit wire slot. */
    clientType: number;
    pubno: number;
    opaque: Uint8Array;
}

const Bytes = Uint8Array;
const View = DataView;
const typed = Object.getPrototypeOf(Bytes.prototype) as object;
const tag = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const length = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const offset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const values = Bytes.prototype.values;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;
const getPrototype = Object.getPrototypeOf;
const isView = ArrayBuffer.isView;

function clear(bytes: Uint8Array | undefined): void {
    if (bytes) {
        try {
            fill.call(bytes, 0);
        } catch {
            // Each private allocation gets an independent cleanup attempt.
        }
    }
}

function chain(value: object): void {
    let current: object | null = value;

    for (let depth = 0; current !== null; depth++) {
        if (depth >= 256 || isProxy(current)) {
            throw new TypeError();
        }

        current = getPrototype(current) as object | null;
    }
}

function data(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError();
    }

    return descriptor.value;
}

function uint(value: unknown, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
        throw new TypeError();
    }

    return value;
}

/**
 * Encode the statically observed successful target OICQ envelope, not the
 * reference implementation's envelope. The caller explicitly supplies the old
 * sequence value and all context fields; no counter, signing, key selection,
 * ECDH header, peer trust or login logic is implemented. Opaque bytes correspond
 * to the complete caller-provided intermediate output and are not identified as
 * ciphertext or authenticated data. The target writes the low 16 total bits;
 * this local encoder rejects totals above 65535 instead. Temporary copies are
 * cleared best effort; JS/runtime copies can remain. Output belongs to caller.
 */
export function encodeTargetWtOicq(input: TargetWtOicq): Uint8Array {
    let snapshot: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        if (typeof input !== 'object' || input === null || isProxy(input)) {
            throw new TypeError();
        }

        chain(input);

        for (const key of Reflect.ownKeys(input)) {
            const descriptor = Object.getOwnPropertyDescriptor(input, key);

            if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
                throw new TypeError();
            }
        }

        const version = uint(data(input, 'version'), 0xffff);
        const command = uint(data(input, 'command'), 0xffff);
        const sequence = uint(data(input, 'sequence'), 0xffff);
        const uin = uint(data(input, 'uin'), 0xffffffff);
        const clientType = uint(data(input, 'clientType'), 0xffff);
        const pubno = uint(data(input, 'pubno'), 0xffffffff);
        const opaque = data(input, 'opaque');

        if (isProxy(opaque) || !isView(opaque) || tag.call(opaque) !== 'Uint8Array') {
            throw new TypeError();
        }

        chain(opaque);
        const backing = buffer.call(opaque) as ArrayBuffer;
        arrayBufferLength.call(backing); // Reject shared backing, including foreign realms.
        values.call(opaque); // Reject detached and out-of-bounds resizable views.
        const size = length.call(opaque) as number;
        const start = offset.call(opaque) as number;

        if (size > MAX_TARGET_WT_OICQ_OPAQUE_BYTES) {
            throw new RangeError();
        }

        snapshot = new Bytes(size);
        set.call(snapshot, new Bytes(backing, start, size));
        output = new Bytes(29 + size);
        const view = new View(output.buffer, output.byteOffset, output.byteLength);
        view.setUint8(0, 0x02);
        view.setUint16(1, 29 + size, false);
        view.setUint16(3, version, false);
        view.setUint16(5, command, false);
        view.setUint16(7, sequence, false);
        view.setUint32(9, uin, false);
        view.setUint8(13, 0x03);
        view.setUint8(14, 0x87);
        view.setUint8(15, 0);
        view.setUint32(16, clientType, false);
        view.setUint32(20, pubno, false);
        view.setUint32(24, 0, false);
        set.call(output, snapshot, 28);
        view.setUint8(28 + size, 0x03);
        complete = true;
        return output;
    } catch {
        throw new Error('target WT OICQ construction failed');
    } finally {
        clear(snapshot);

        if (!complete) {
            clear(output);
        }
    }
}
