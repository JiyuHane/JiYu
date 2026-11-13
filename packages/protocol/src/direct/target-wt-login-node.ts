import { isProxy } from 'node:util/types';

const Bytes = Uint8Array;
const View = DataView;
const typed = Object.getPrototypeOf(Bytes.prototype) as object;
const tag = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const length = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const offset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
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
            // Each owned allocation gets an independent best-effort attempt.
        }
    }
}

function encodeNode(nodeTag: number, input: Uint8Array): Uint8Array {
    let snapshot: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        if (isProxy(input) || !isView(input) || tag.call(input) !== 'Uint8Array') {
            throw new TypeError();
        }

        let current: object | null = input;

        for (let depth = 0; current !== null; depth++) {
            if (depth >= 256 || isProxy(current)) {
                throw new TypeError();
            }

            current = getPrototype(current) as object | null;
        }

        const backing = buffer.call(input) as ArrayBuffer;
        bufferLength.call(backing); // Reject shared backing, including foreign realms.
        values.call(input); // Reject detached and out-of-bounds views.
        const size = length.call(input) as number;
        const start = offset.call(input) as number;

        if (size > 0xffff) {
            throw new RangeError();
        }

        snapshot = new Bytes(size);
        set.call(snapshot, new Bytes(backing, start, size));
        output = new Bytes(size + 4);
        const view = new View(output.buffer);
        view.setUint16(0, nodeTag, false);
        view.setUint16(2, size, false);
        set.call(output, snapshot, 4);
        complete = true;
        return output;
    } catch {
        throw new Error('target WT login node encoding failed');
    } finally {
        clear(snapshot);

        if (!complete) {
            clear(output);
        }
    }
}

/**
 * Standalone local model of target writer 0x35051e0 (vtable slot +0x10):
 * BE16(tag), BE16(value length), then the caller's raw bytes. There is no count
 * or inner length. The normal QR success path statically copies tag 0x19 raw
 * bytes into this 0x016a node and tag 0x65 raw bytes into the separate 0x0318
 * node, with independent presence even for empty values. This function neither
 * obtains nor interprets those values and does not establish whether a later
 * login request uses the node or whether a server accepts it.
 *
 * The target stores the low 16 length bits and does not check each writer
 * failure; this local implementation instead rejects values over 65535 bytes.
 * A maximum-size value produces 65539 bytes; an enclosing container may impose
 * a smaller limit. Caller input remains owned by the caller and must stay stable through the
 * snapshot. Returned bytes belong to the caller. Private copies and incomplete
 * output are cleared best effort; JavaScript/runtime copies may remain. No
 * network, account, authentication, Hook or login is performed.
 */
export function encodeTargetWtLoginNode016a(value: Uint8Array): Uint8Array {
    return encodeNode(0x016a, value);
}

/** Encode a caller-supplied 0x0318 node under the same local contract. */
export function encodeTargetWtLoginNode0318(value: Uint8Array): Uint8Array {
    return encodeNode(0x0318, value);
}
