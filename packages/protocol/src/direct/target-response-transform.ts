import { isProxy } from 'node:util/types';
import { decodeTargetServiceBusinessResponse } from './target-service-business-response';
import { decodeTargetSso12ResponseHead } from './target-sso12-response-head';
import { inflateTargetZlibCandidate } from './target-zlib-candidate';

/** Inclusive local resource policy, not a target protocol limit. */
export const MAX_TARGET_RESPONSE_TRANSFORM_BYTES = 16 * 1024 * 1024;

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayTag = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    Symbol.toStringTag,
)!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const sharedBufferLength = Object.getOwnPropertyDescriptor(
    SharedArrayBuffer.prototype,
    'byteLength',
)!.get!;
const typedArrayValues = Uint8Array.prototype.values;
const copyBytes = Uint8Array.prototype.set;
const clearBytes = Uint8Array.prototype.fill;
const getPrototypeOf = Object.getPrototypeOf;

/**
 * Transform a caller-accepted raw head-start view. Skip is the caller's final
 * choice, not a lookup inferred from the head. The local input cap covers the
 * whole view, including unconsumed bytes after the business wrapper; independently
 * valid layers can therefore exceed it in combination. The output budget applies
 * to both compressed and uncompressed bodies. Neither limit is a native limit.
 * This stage performs no authentication, binding or compatibility verification.
 */
export function transformTargetResponse(
    input: Uint8Array,
    skip: 0 | 4,
    compressed: 'reject' | 'node-zlib-strict',
    maxOutputBytes: number,
): {
    head: ReturnType<typeof decodeTargetSso12ResponseHead>;
    body: Uint8Array;
    businessOffset: number;
    nextOffset: number;
    compression: 'none' | 'node-zlib-strict';
} {
    let snapshot: Uint8Array | undefined;
    let head: ReturnType<typeof decodeTargetSso12ResponseHead> | undefined;
    let raw: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let success = false;

    try {
        if (
            (skip !== 0 && skip !== 4) ||
            (compressed !== 'reject' && compressed !== 'node-zlib-strict') ||
            typeof maxOutputBytes !== 'number' ||
            !Number.isSafeInteger(maxOutputBytes) ||
            maxOutputBytes < 0 ||
            maxOutputBytes > MAX_TARGET_RESPONSE_TRANSFORM_BYTES ||
            isProxy(input) ||
            !ArrayBuffer.isView(input) ||
            typedArrayTag.call(input) !== 'Uint8Array'
        ) {
            throw new TypeError('invalid input');
        }

        let current: object | null = input;
        let depth = 0;

        while (current !== null) {
            if (isProxy(current) || depth++ >= 256) {
                throw new TypeError('invalid prototype chain');
            }

            current = getPrototypeOf(current);
        }

        const buffer: ArrayBuffer = typedArrayBuffer.call(input);
        const byteLength: number = typedArrayLength.call(input);
        const byteOffset: number = typedArrayOffset.call(input);
        let shared = false;

        try {
            sharedBufferLength.call(buffer);
            shared = true;
        } catch {
            // Ordinary ArrayBuffers are rejected by this intrinsic.
        }

        if (shared || byteLength > MAX_TARGET_RESPONSE_TRANSFORM_BYTES) {
            throw new RangeError('invalid backing or size');
        }

        typedArrayValues.call(input);
        snapshot = new Uint8Array(byteLength);
        copyBytes.call(snapshot, new Uint8Array(buffer, byteOffset, byteLength));
        head = decodeTargetSso12ResponseHead(snapshot);

        if (skip === 4 && byteLength - head.nextOffset < 5) {
            throw new RangeError('insufficient post-head bytes');
        }

        const businessOffset = head.nextOffset + skip;
        const business = decodeTargetServiceBusinessResponse(snapshot, businessOffset);
        raw = business.body;
        let compression: 'none' | 'node-zlib-strict' = 'none';

        if ((head.flagsWord & 1) !== 0) {
            if (compressed === 'reject') {
                throw new Error('compressed body rejected');
            }

            output = inflateTargetZlibCandidate(raw, maxOutputBytes);
            compression = 'node-zlib-strict';
        } else {
            if (raw.byteLength > maxOutputBytes) {
                throw new RangeError('output limit');
            }

            output = new Uint8Array(raw.byteLength);
            copyBytes.call(output, raw);
        }

        const result = {
            head,
            body: output,
            businessOffset,
            nextOffset: business.nextOffset,
            compression,
        };
        success = true;
        return result;
    } catch {
        throw new Error('target response transform failed');
    } finally {
        const clear = (bytes: Uint8Array | undefined): void => {
            if (bytes) {
                try {
                    clearBytes.call(bytes, 0);
                } catch {
                    // Best effort only, independently for each owned byte array.
                }
            }
        };

        clear(snapshot);
        clear(raw);

        if (!success) {
            clear(output);
            clear(head?.field1);
            clear(head?.field2);
            clear(head?.field3);
            clear(head?.reserve);
            clear(head?.tail);
        }
    }
}
