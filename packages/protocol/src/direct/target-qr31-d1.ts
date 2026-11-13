import { isProxy } from 'node:util/types';
import type { TargetQr31D1 } from '@snowluma/proto-defs/target-qr31-d1';
import { protobuf_encode } from '@snowluma/proton';

// Static observation at 0x34601d0 in wrapper.node SHA-256
// dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328.
// Empty-field wire presence is a single static observation and a local policy,
// not an independently confirmed wire fact. No target execution, packet capture,
// field meaning, or peer compatibility is implied.
const MAX_PAYLOAD = 0xffff;
const Bytes = Uint8Array;
const arrayPrototype = Object.getPrototypeOf(Bytes.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(arrayPrototype, 'byteLength')!.get!;
const byteBuffer = Object.getOwnPropertyDescriptor(arrayPrototype, 'buffer')!.get!;
const byteTag = Object.getOwnPropertyDescriptor(arrayPrototype, Symbol.toStringTag)!.get!;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const byteValues = Bytes.prototype.values;
const byteSet = Bytes.prototype.set;
const byteFill = Bytes.prototype.fill;

export interface TargetQr31D1Input {
    field1: Uint8Array;
    field2: Uint8Array;
}

interface ByteView {
    value: Uint8Array;
    length: number;
}

function inspect(value: unknown): ByteView {
    if (isProxy(value) || !ArrayBuffer.isView(value) || byteTag.call(value) !== 'Uint8Array') {
        throw new TypeError();
    }

    let current: object | null = value;
    let depth = 0;

    while (current !== null) {
        if (depth++ >= 256 || isProxy(current)) {
            throw new TypeError();
        }

        current = Object.getPrototypeOf(current) as object | null;
    }

    // ArrayBuffer intrinsic rejects SharedArrayBuffer even across realms.
    bufferLength.call(byteBuffer.call(value));
    byteValues.call(value); // Reject detached views without invoking instance methods.
    const length = byteLength.call(value) as number;

    if (length > MAX_PAYLOAD) {
        throw new RangeError();
    }

    return { value: value as Uint8Array, length };
}

function sizeOfVarint(value: number): number {
    let size = 1;

    while (value >= 128) {
        value = Math.floor(value / 128);
        size++;
    }

    return size;
}

function clear(value: Uint8Array | undefined): void {
    if (value !== undefined) {
        try {
            byteFill.call(value, 0);
        } catch {
            // Each local buffer is cleared independently, best effort.
        }
    }
}

/**
 * Build the target-static D1 child, including its BE16 tag and payload length.
 * The two opaque byte fields are explicit inputs, including when empty. This
 * implementation's length bound and input rejection are local policies.
 * Private snapshots and the returned Proton view are wiped best effort; other
 * JavaScript or Proton copies may persist. The returned TLV is caller-owned.
 */
export function encodeTargetQr31D1(input: TargetQr31D1Input): Uint8Array {
    let first: Uint8Array | undefined;
    let second: Uint8Array | undefined;
    let encoded: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        if (input === null || typeof input !== 'object' || isProxy(input)) {
            throw new TypeError();
        }

        const prototype: unknown = Object.getPrototypeOf(input);

        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError();
        }

        const descriptors = Object.getOwnPropertyDescriptors(input);
        const keys = Reflect.ownKeys(descriptors);

        if (
            keys.length !== 2 ||
            !Object.hasOwn(descriptors, 'field1') ||
            !Object.hasOwn(descriptors, 'field2')
        ) {
            throw new TypeError();
        }

        const d1 = descriptors.field1;
        const d2 = descriptors.field2;

        if (!Object.hasOwn(d1, 'value') || !Object.hasOwn(d2, 'value')) {
            throw new TypeError();
        }

        const a = inspect(d1.value);
        const b = inspect(d2.value);
        const inner = 1 + sizeOfVarint(a.length) + a.length + 1 + sizeOfVarint(b.length) + b.length;
        const payloadLength = 1 + sizeOfVarint(inner) + inner + 4;

        if (payloadLength > MAX_PAYLOAD) {
            throw new RangeError();
        }

        first = new Bytes(a.length);
        byteSet.call(first, a.value);
        second = new Bytes(b.length);
        byteSet.call(second, b.value);
        const message: TargetQr31D1 = {
            field1: { field1: first, field2: second },
            field4: { field6: 1 },
        };
        encoded = protobuf_encode<TargetQr31D1>(message);

        if (encoded.byteLength !== payloadLength) {
            throw new Error();
        }

        output = new Bytes(4 + payloadLength);
        const header = new DataView(output.buffer);
        header.setUint16(0, 0xd1, false);
        header.setUint16(2, payloadLength, false);
        byteSet.call(output, encoded, 4);
        complete = true;
        return output;
    } catch {
        throw new Error('target QR31 D1 encoding failed');
    } finally {
        clear(first);
        clear(second);
        clear(encoded);

        if (!complete) {
            clear(output);
        }
    }
}
