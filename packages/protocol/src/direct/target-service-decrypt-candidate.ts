import { isProxy } from 'node:util/types';
import { qqTeaDecrypt } from './qq-tea';

/** Local input limit, not a recovered target limit. */
export const MAX_TARGET_SERVICE_DECRYPT_CANDIDATE_BYTES = 16 * 1024 * 1024;

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

function inspectBytes(value: Uint8Array): { buffer: ArrayBuffer; offset: number; length: number } {
    if (
        isProxy(value) ||
        !ArrayBuffer.isView(value) ||
        typedArrayTag.call(value) !== 'Uint8Array'
    ) {
        throw new TypeError('invalid bytes');
    }

    const buffer: ArrayBuffer = typedArrayBuffer.call(value);
    // This intrinsic rejects shared buffers in all realms. values() also rejects
    // detached and out-of-bounds resizable views, including zero-length views.
    arrayBufferLength.call(buffer);
    typedArrayValues.call(value);
    return {
        buffer,
        offset: typedArrayOffset.call(value),
        length: typedArrayLength.call(value),
    };
}

function copyInput(view: { buffer: ArrayBuffer; offset: number; length: number }): Uint8Array {
    const copy = new Uint8Array(view.length);

    try {
        copyBytes.call(copy, new Uint8Array(view.buffer, view.offset, view.length));
        return copy;
    } catch (error) {
        try {
            clearBytes.call(copy, 0);
        } catch {
            // Best effort if copying fails before ownership can transfer.
        }

        throw error;
    }
}

/**
 * Produces an unauthenticated plaintext candidate, never a verified response.
 * The caller must independently verify the original frame before invoking this
 * function; it performs no identity, sequence, business or decompression checks.
 * Selector 0 requires no key. Selectors 1 and 2 each try exactly one explicit
 * caller-provided key; no defaults, key selection or automatic fallback occur.
 * The reference QQ-TEA primitive's framing check is not authentication and is
 * not a claim of byte-equivalence with the target. Do not use decryption success
 * to select keys. Private input copies are wiped best-effort; JavaScript and the
 * primitive may retain other copies. Caller inputs and the returned data remain intact.
 */
export function decodeTargetServiceDecryptCandidate(
    selector: number,
    bytes: Uint8Array,
    key?: Uint8Array,
): { kind: 'plaintext-candidate'; data: Uint8Array } {
    let cipherCopy: Uint8Array | undefined;
    let keyCopy: Uint8Array | undefined;

    try {
        if (selector !== 0 && selector !== 1 && selector !== 2) {
            throw new TypeError('invalid selector');
        }

        const input = inspectBytes(bytes);

        if (input.length === 0 || input.length > MAX_TARGET_SERVICE_DECRYPT_CANDIDATE_BYTES) {
            throw new RangeError('invalid input length');
        }

        if (selector === 0) {
            if (key !== undefined) {
                throw new TypeError('unexpected key');
            }

            return { kind: 'plaintext-candidate', data: copyInput(input) };
        }

        if (key === undefined || input.length < 16 || input.length % 8 !== 0) {
            throw new TypeError('invalid ciphertext or key');
        }

        const keyView = inspectBytes(key);

        if (keyView.length !== 16) {
            throw new RangeError('invalid key length');
        }

        cipherCopy = copyInput(input);
        keyCopy = copyInput(keyView);
        const plaintext = qqTeaDecrypt(cipherCopy, keyCopy);

        if (plaintext.length === 0) {
            throw new Error('empty candidate');
        }

        return { kind: 'plaintext-candidate', data: plaintext };
    } catch {
        throw new Error('target service decrypt candidate decoding failed');
    } finally {
        try {
            if (cipherCopy) {
                clearBytes.call(cipherCopy, 0);
            }
        } catch {
            // Preserve the original result or fixed error if clearing fails.
        }

        try {
            if (keyCopy) {
                clearBytes.call(keyCopy, 0);
            }
        } catch {
            // Best effort only; other runtime and primitive copies may remain.
        }
    }
}
