import { isProxy } from 'node:util/types';
import { decodeTargetSso12ResponseHead } from './target-sso12-response-head';

/** Inclusive local limit for the entire supplied view, not a target limit. */
export const MAX_TARGET_SSO12_RESPONSE_FINAL_BYTES = 16 * 1024 * 1024;

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
 * Inspect the final word for heads accepted by the strict local parser. Input
 * must be the complete plaintext span, not the original encrypted frame. The
 * read may cross the declared head into subsequent bytes; it does not consume
 * or modify head.tail or head.nextOffset. The prior value models caller state
 * when fewer than four bytes remain; it is not a known native default. Strict
 * head parsing rejects some spans accepted by the target and a successful read
 * does not establish that the complete packet succeeds. The outer caller's
 * whole-span-greater-than-declared-head requirement is not enforced here.
 */
export function decodeTargetSso12ResponseFinal(
    input: Uint8Array,
    offset: number,
    prior: number,
): {
    head: ReturnType<typeof decodeTargetSso12ResponseHead>;
    finalWord: number;
    finalWordRead: boolean;
} {
    let snapshot: Uint8Array | undefined;
    let head: ReturnType<typeof decodeTargetSso12ResponseHead> | undefined;
    let success = false;

    try {
        if (
            typeof offset !== 'number' ||
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            typeof prior !== 'number' ||
            !Number.isInteger(prior) ||
            prior < 0 ||
            prior > 0xffffffff ||
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
            // The intrinsic rejects ordinary ArrayBuffers, including foreign ones.
        }

        if (shared || byteLength > MAX_TARGET_SSO12_RESPONSE_FINAL_BYTES || offset > byteLength) {
            throw new RangeError('invalid backing, size or offset');
        }

        typedArrayValues.call(input);
        snapshot = new Uint8Array(byteLength);
        copyBytes.call(snapshot, new Uint8Array(buffer, byteOffset, byteLength));
        head = decodeTargetSso12ResponseHead(snapshot, offset);
        const finalOffset = head.nextOffset - head.tail.length;
        const finalWordRead = byteLength - finalOffset >= 4;
        const finalWord = finalWordRead
            ? new DataView(snapshot.buffer, finalOffset, 4).getUint32(0, false)
            : prior;
        const result = { head, finalWord, finalWordRead };
        success = true;
        return result;
    } catch {
        throw new Error('target sso12 response final decoding failed');
    } finally {
        const clear = (bytes: Uint8Array | undefined): void => {
            if (bytes) {
                try {
                    clearBytes.call(bytes, 0);
                } catch {
                    // Best effort for each independent private allocation.
                }
            }
        };

        clear(snapshot);

        if (!success) {
            clear(head?.field1);
            clear(head?.field2);
            clear(head?.field3);
            clear(head?.reserve);
            clear(head?.tail);
        }
    }
}
