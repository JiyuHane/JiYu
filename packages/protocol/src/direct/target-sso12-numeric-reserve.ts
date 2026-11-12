import { isProxy } from 'node:util/types';
import type { TargetSso12NumericReserveResponse } from '@snowluma/proto-defs/target-sso12-reserve';
import { protobuf_decode } from '@snowluma/proton';

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayTag = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    Symbol.toStringTag,
)!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const typedArrayValues = Uint8Array.prototype.values;
const copyBytes = Uint8Array.prototype.set;
const clearBytes = Uint8Array.prototype.fill;
const getPrototypeOf = Object.getPrototypeOf;
const isView = ArrayBuffer.isView;
const apply = Reflect.apply;
const Bytes = Uint8Array;

/**
 * Local strict candidate based on selected static numeric observations only.
 * Null means the field was not written, not a native default. Successful local
 * decoding does not establish target acceptance, server format, or authentication.
 * Unsupported shapes are rejected locally without implying target rejection.
 * The private snapshot is cleared best effort; runtime-internal copies may remain.
 */
export function decodeTargetSso12NumericReserveCandidate(input: Uint8Array): {
    kind: 'numeric-reserve-candidate';
    field9: number | null;
    field25: number | null;
} {
    let snapshot: Uint8Array | undefined;

    try {
        if (isProxy(input) || !isView(input) || apply(typedArrayTag, input, []) !== 'Uint8Array') {
            throw new TypeError();
        }

        let current: object | null = input;
        let depth = 0;

        while (current !== null) {
            if (isProxy(current) || depth++ >= 256) {
                throw new TypeError();
            }

            current = getPrototypeOf(current);
        }

        const buffer = apply(typedArrayBuffer, input, []) as ArrayBuffer;
        // The ordinary ArrayBuffer getter rejects shared backing across realms.
        apply(arrayBufferLength, buffer, []);
        // Validate detached and out-of-bounds resizable views, including empty views.
        apply(typedArrayValues, input, []);
        const length = apply(typedArrayLength, input, []) as number;
        const offset = apply(typedArrayOffset, input, []) as number;

        if (length > 5) {
            throw new RangeError();
        }

        snapshot = new Bytes(length);
        apply(copyBytes, snapshot, [new Bytes(buffer, offset, length)]);
        let seen9 = false;
        let seen25 = false;
        let cursor = 0;

        while (cursor < length) {
            const key = snapshot[cursor++];

            if (key === 0x48 && !seen9) {
                seen9 = true;
            } else if (key === 0xc8 && snapshot[cursor++] === 0x01 && !seen25) {
                seen25 = true;
            } else {
                throw new TypeError();
            }

            if (cursor >= length || snapshot[cursor++] > 0x7f) {
                throw new TypeError();
            }
        }

        const decoded = protobuf_decode<TargetSso12NumericReserveResponse>(snapshot);

        if (
            (seen9 && typeof decoded.field9 !== 'number') ||
            (seen25 && typeof decoded.field25 !== 'number')
        ) {
            throw new TypeError();
        }

        return {
            kind: 'numeric-reserve-candidate',
            field9: seen9 ? decoded.field9! : null,
            field25: seen25 ? decoded.field25! : null,
        };
    } catch {
        throw new Error('target sso12 numeric reserve candidate decoding failed');
    } finally {
        if (snapshot !== undefined) {
            try {
                apply(clearBytes, snapshot, [0]);
            } catch {
                // Best effort without changing the decoding outcome.
            }
        }
    }
}
