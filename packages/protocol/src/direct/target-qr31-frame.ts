import { isProxy } from 'node:util/types';

/** Local limit: the 16-bit total includes the entire envelope and its trailer. */
export const MAX_TARGET_QR31_FRAME_BYTES = 0xffff;
export const MAX_TARGET_QR31_FRAME_BODY_BYTES = MAX_TARGET_QR31_FRAME_BYTES - 44;

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
            // Each private allocation is independently cleared on a best-effort basis.
        }
    }
}

/**
 * Encode the target-static QR31 envelope for the inspected zero-initialized
 * constructor path. The caller supplies an already encoded body in the target's
 * observed order; it must remain stable until snapshotted. The native code
 * writes low 16 bits of the total length, whereas this local policy rejects an
 * oversized frame. Other target call paths may use different header values.
 * This neither validates the body nor establishes signing, peer authentication,
 * an online session, or interoperability. Temporary cleanup is best effort and
 * cannot guarantee erasure of runtime copies. Returned bytes are caller-owned.
 */
export function encodeTargetQr31Frame(body: Uint8Array): Uint8Array {
    let snapshot: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        if (isProxy(body) || !isView(body) || tag.call(body) !== 'Uint8Array') {
            throw new TypeError();
        }

        let current: object | null = body;
        let depth = 0;

        while (current !== null) {
            if (depth++ >= 256 || isProxy(current)) {
                throw new TypeError();
            }

            current = getPrototype(current) as object | null;
        }

        const backing = buffer.call(body) as ArrayBuffer;
        arrayBufferLength.call(backing); // Reject shared backing, including cross-realm views.
        values.call(body); // Reject detached and out-of-bounds resizable views.
        const bodyLength = length.call(body) as number;
        const bodyOffset = offset.call(body) as number;

        if (bodyLength > MAX_TARGET_QR31_FRAME_BODY_BYTES) {
            throw new RangeError();
        }

        snapshot = new Bytes(bodyLength);
        set.call(snapshot, new Bytes(backing, bodyOffset, bodyLength));
        output = new Bytes(bodyLength + 44);
        const header = new View(output.buffer);
        header.setUint8(0, 0x02);
        header.setUint16(1, bodyLength + 44, false);
        header.setUint16(3, 0x31, false);
        header.setUint8(26, 0x03);
        header.setUint16(29, 0x32, false);
        set.call(output, snapshot, 43);
        header.setUint8(bodyLength + 43, 0x03);
        complete = true;
        return output;
    } catch {
        throw new Error('target QR31 frame construction failed');
    } finally {
        clear(snapshot);

        if (!complete) {
            clear(output);
        }
    }
}
