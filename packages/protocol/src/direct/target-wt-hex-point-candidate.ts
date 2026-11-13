import { isProxy } from 'node:util/types';

const Bytes = Uint8Array;
const typedArrayPrototype = Object.getPrototypeOf(Bytes.prototype) as object;
const byteTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const byteBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const byteValues = Bytes.prototype.values;
const copyBytes = Bytes.prototype.set;
const clearBytes = Bytes.prototype.fill;
const getPrototypeOf = Object.getPrototypeOf;
const isView = ArrayBuffer.isView;

function clear(bytes: Uint8Array | undefined): void {
    if (bytes) {
        try {
            clearBytes.call(bytes, 0);
        } catch {
            // A failed cleanup must not prevent clearing the other allocation.
        }
    }
}

function nibble(value: number): number {
    if (value >= 0x30 && value <= 0x39) {
        return value - 0x30;
    }

    if (value >= 0x41 && value <= 0x46) {
        return value - 0x41 + 10;
    }

    if (value >= 0x61 && value <= 0x66) {
        return value - 0x61 + 10;
    }

    throw new TypeError();
}

/**
 * Decode a locally strict, unverified WT point-format candidate. The caller
 * independently selects the coordinate width and establishes trust in the input.
 * This checks only even-length ASCII hex, 04 prefix and 1 + 2*w decoded size;
 * it does not validate a curve point, authenticate a peer, or establish native
 * equivalence. The inspected native path ignores a trailing odd character; this
 * local policy rejects it. Native invalid-character behavior remains unknown.
 * Width 1..256 and the resulting 1026-byte input limit are local caps, not
 * evidence of the target's dynamic group width or peer source. No default curve
 * is selected. Temporary snapshots are cleared best-effort; JavaScript engines
 * and GC may retain other copies. Success transfers only independent output.
 */
export function decodeTargetWtHexPointCandidate(
    ascii: Uint8Array,
    coordinateBytes: number,
): { kind: 'unverified-wt-point-candidate'; bytes: Uint8Array } {
    let snapshot: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let success = false;

    try {
        if (
            typeof coordinateBytes !== 'number' ||
            !Number.isSafeInteger(coordinateBytes) ||
            coordinateBytes < 1 ||
            coordinateBytes > 256 ||
            isProxy(ascii) ||
            !isView(ascii) ||
            byteTag.call(ascii) !== 'Uint8Array'
        ) {
            throw new TypeError();
        }

        let current: object | null = ascii;
        let depth = 0;

        while (current !== null) {
            if (depth++ >= 256 || isProxy(current)) {
                throw new TypeError();
            }

            current = getPrototypeOf(current) as object | null;
        }

        const backing = byteBuffer.call(ascii) as ArrayBuffer;
        arrayBufferLength.call(backing); // Rejects SharedArrayBuffer, including foreign realms.
        byteValues.call(ascii); // Rejects detached and out-of-bounds resizable views.
        const size = byteLength.call(ascii) as number;
        const offset = byteOffset.call(ascii) as number;
        const expected = 2 * (1 + 2 * coordinateBytes);

        if (size !== expected) {
            throw new RangeError();
        }

        snapshot = new Bytes(size);
        copyBytes.call(snapshot, new Bytes(backing, offset, size));
        output = new Bytes(expected / 2);

        for (let index = 0; index < expected / 2; index++) {
            output[index] = (nibble(snapshot[index * 2]) << 4) | nibble(snapshot[index * 2 + 1]);
        }

        if (output[0] !== 0x04) {
            throw new TypeError();
        }

        const result = { kind: 'unverified-wt-point-candidate' as const, bytes: output };
        success = true;
        return result;
    } catch {
        throw new Error('target WT hex point candidate failed');
    } finally {
        clear(snapshot);

        if (!success) {
            clear(output);
        }
    }
}
