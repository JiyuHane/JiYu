import { isProxy } from 'node:util/types';

/** Local strict limit for innerLen + 4 in the selected 16-bit length field. */
export const MAX_TARGET_QR31_CHANNEL_INNER_BYTES = 0xffff - 4;

export interface TargetQr31ChannelWrapper {
    inner: Uint8Array;
    fieldEsi: number;
    fieldEcx: number;
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

function clear(bytes: Uint8Array | undefined): void {
    if (bytes) {
        try {
            fill.call(bytes, 0);
        } catch {
            /* Independent best-effort cleanup. */
        }
    }
}

function data(input: object, name: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);

    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError();
    }

    return descriptor.value;
}

function uint32(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new TypeError();
    }

    return value;
}

/**
 * Selected target-static QR31 caller's 18-byte channel wrapper. Its BE16 word
 * is inner length + 4, not total wrapper length. The target writes low 16 bits
 * while copying a low-32-bit length; this API strictly rejects inner > 65531.
 * The zeros and 0x72 describe this caller only. Both u32 fields are explicit
 * unknown bit patterns, not asserted time/account semantics. Inner is arbitrary
 * bytes and is not validated as a QR31 frame. Caller inputs must stay stable
 * through snapshotting. This does not implement wtlogin64 connectivity,
 * signatures, encryption, peer authentication, or prove interoperability.
 * Temporary buffers and failed outputs are cleared best-effort independently;
 * JavaScript/runtime copies can remain. Returned bytes belong to the caller.
 */
export function encodeTargetQr31ChannelWrapper(input: TargetQr31ChannelWrapper): Uint8Array {
    let snapshot: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        if (typeof input !== 'object' || input === null || isProxy(input)) {
            throw new TypeError();
        }

        const prototype = Object.getPrototypeOf(input);

        if (prototype !== null && prototype !== Object.prototype) {
            throw new TypeError();
        }

        for (const name of Reflect.ownKeys(input)) {
            const descriptor = Object.getOwnPropertyDescriptor(input, name);

            if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
                throw new TypeError();
            }
        }

        const inner = data(input, 'inner');
        const fieldEsi = uint32(data(input, 'fieldEsi'));
        const fieldEcx = uint32(data(input, 'fieldEcx'));

        if (isProxy(inner) || !ArrayBuffer.isView(inner) || tag.call(inner) !== 'Uint8Array') {
            throw new TypeError();
        }

        let current: object | null = inner;

        for (let depth = 0; current !== null; depth++) {
            if (depth >= 256 || isProxy(current)) {
                throw new TypeError();
            }

            current = Object.getPrototypeOf(current) as object | null;
        }

        const backing = buffer.call(inner) as ArrayBuffer;
        arrayBufferLength.call(backing);
        values.call(inner);
        const byteLength = length.call(inner) as number;
        const byteOffset = offset.call(inner) as number;

        if (byteLength > MAX_TARGET_QR31_CHANNEL_INNER_BYTES) {
            throw new RangeError();
        }

        snapshot = new Bytes(byteLength);
        set.call(snapshot, new Bytes(backing, byteOffset, byteLength));
        output = new Bytes(18 + byteLength);
        const view = new View(output.buffer);
        view.setUint16(1, byteLength + 4, false);
        view.setUint32(3, fieldEsi, false);
        view.setUint32(7, 0x72, false);
        view.setUint32(14, fieldEcx, false);
        set.call(output, snapshot, 18);
        complete = true;
        return output;
    } catch {
        throw new Error('target QR31 channel wrapper construction failed');
    } finally {
        clear(snapshot);

        if (!complete) {
            clear(output);
        }
    }
}
