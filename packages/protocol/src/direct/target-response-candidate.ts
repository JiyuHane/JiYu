import { isProxy } from 'node:util/types';
import { transformTargetResponse } from './target-response-transform';
import { decodeTargetServiceDecryptCandidate } from './target-service-decrypt-candidate';
import { decodeTargetServiceResponseBasic } from './target-service-response-basic';

/** Local limit on the entire supplied frame view, not a target framing rule. */
export const MAX_TARGET_RESPONSE_CANDIDATE_BYTES = 16 * 1024 * 1024;

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

function inspectBytes(value: Uint8Array): { buffer: ArrayBuffer; offset: number; length: number } {
    if (
        isProxy(value) ||
        !ArrayBuffer.isView(value) ||
        typedArrayTag.call(value) !== 'Uint8Array'
    ) {
        throw new TypeError('invalid bytes');
    }

    let current: object | null = value;
    let depth = 0;

    while (current !== null) {
        if (isProxy(current) || depth++ >= 256) {
            throw new TypeError('invalid prototype chain');
        }

        current = getPrototypeOf(current);
    }

    const buffer: ArrayBuffer = typedArrayBuffer.call(value);
    // These intrinsics reject shared backing, detached and out-of-bounds views.
    arrayBufferLength.call(buffer);
    typedArrayValues.call(value);
    return { buffer, offset: typedArrayOffset.call(value), length: typedArrayLength.call(value) };
}

function clear(bytes: Uint8Array | undefined): void {
    if (bytes) {
        try {
            clearBytes.call(bytes, 0);
        } catch {
            // Independently best effort; runtime and primitive private copies may remain.
        }
    }
}

/**
 * Compose a locally bounded, unverified response candidate from one complete frame.
 * The caller must isolate and independently verify the same bytes supplied here;
 * changes between external verification and this snapshot break that binding.
 * This function neither authenticates nor implements target trust or key selection.
 * The observed decoded span starts directly at the head, at plaintext offset zero.
 * basic.nextOffset is relative to the input view; head.nextOffset, businessOffset,
 * and nextOffset are relative to the plaintext candidate, never wire offsets.
 * basic.opaque and head.tail have unknown semantics; trailing is a separate copy
 * of plaintext after the business wrapper for caller inspection. The first BE32
 * basic word is preserved, not treated as a frame length. The full-view cap and
 * strict zlib mode are local policies, not claims about the target implementation.
 * Selector 0 requires no key; selectors 1/2 require one explicit 16-byte key.
 * Owned temporary arrays are cleared best-effort; primitive/zlib private memory
 * and external copies are outside this guarantee. Returned arrays are caller-owned.
 */
export function composeTargetResponseCandidate(
    frame: Uint8Array,
    skip: 0 | 4,
    compression: 'reject' | 'node-zlib-strict',
    maxOutputBytes: number,
    key?: Uint8Array,
): {
    kind: 'unverified-response-candidate';
    basic: ReturnType<typeof decodeTargetServiceResponseBasic>;
    head: ReturnType<typeof transformTargetResponse>['head'];
    body: Uint8Array;
    trailing: Uint8Array;
    businessOffset: number;
    nextOffset: number;
    compression: 'none' | 'node-zlib-strict';
} {
    let snapshot: Uint8Array | undefined;
    let keyCopy: Uint8Array | undefined;
    let basic: ReturnType<typeof decodeTargetServiceResponseBasic> | undefined;
    let candidate: Uint8Array | undefined;
    let transformed: ReturnType<typeof transformTargetResponse> | undefined;
    let trailing: Uint8Array | undefined;
    let success = false;

    try {
        if (
            (skip !== 0 && skip !== 4) ||
            (compression !== 'reject' && compression !== 'node-zlib-strict') ||
            typeof maxOutputBytes !== 'number' ||
            !Number.isSafeInteger(maxOutputBytes) ||
            maxOutputBytes < 0 ||
            maxOutputBytes > MAX_TARGET_RESPONSE_CANDIDATE_BYTES
        ) {
            throw new TypeError('invalid options');
        }

        const input = inspectBytes(frame);

        if (input.length > MAX_TARGET_RESPONSE_CANDIDATE_BYTES) {
            throw new RangeError('frame limit');
        }

        snapshot = new Uint8Array(input.length);
        copyBytes.call(snapshot, new Uint8Array(input.buffer, input.offset, input.length));
        basic = decodeTargetServiceResponseBasic(snapshot);

        if (basic.nextOffset >= input.length) {
            throw new RangeError('missing remainder');
        }

        if (basic.selector === 0) {
            if (key !== undefined) {
                throw new TypeError('unexpected key');
            }
        } else if (basic.selector === 1 || basic.selector === 2) {
            if (key === undefined) {
                throw new TypeError('missing key');
            }

            const keyView = inspectBytes(key);

            if (keyView.length !== 16) {
                throw new RangeError('invalid key');
            }

            keyCopy = new Uint8Array(16);
            copyBytes.call(keyCopy, new Uint8Array(keyView.buffer, keyView.offset, 16));
        } else {
            throw new TypeError('invalid selector');
        }

        const remainder = new Uint8Array(
            snapshot.buffer,
            basic.nextOffset,
            input.length - basic.nextOffset,
        );
        candidate = decodeTargetServiceDecryptCandidate(basic.selector, remainder, keyCopy).data;
        transformed = transformTargetResponse(candidate, skip, compression, maxOutputBytes);
        trailing = new Uint8Array(candidate.length - transformed.nextOffset);
        copyBytes.call(
            trailing,
            new Uint8Array(
                candidate.buffer,
                candidate.byteOffset + transformed.nextOffset,
                trailing.length,
            ),
        );
        const result = {
            kind: 'unverified-response-candidate' as const,
            basic,
            head: transformed.head,
            body: transformed.body,
            trailing,
            businessOffset: transformed.businessOffset,
            nextOffset: transformed.nextOffset,
            compression: transformed.compression,
        };
        success = true;
        return result;
    } catch {
        throw new Error('target response candidate decoding failed');
    } finally {
        clear(snapshot);
        clear(keyCopy);
        clear(candidate);

        if (!success) {
            clear(basic?.opaque);
            clear(transformed?.head.field1);
            clear(transformed?.head.field2);
            clear(transformed?.head.field3);
            clear(transformed?.head.reserve);
            clear(transformed?.head.tail);
            clear(transformed?.body);
            clear(trailing);
        }
    }
}
