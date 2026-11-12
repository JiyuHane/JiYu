import { isProxy } from 'node:util/types';

/** Local resource policy, not an observed protocol limit. */
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ITEMS = 4096;
// Protect ownership against replacement of this global after module initialization.
const ByteArray = Uint8Array;
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
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const isArray = Array.isArray;
const isView = ArrayBuffer.isView;
const isSafeInteger = Number.isSafeInteger;

function validateChain(value: object): void {
    let current: object | null = value;
    let depth = 0;

    while (current !== null) {
        if (isProxy(current) || depth++ >= 256) {
            throw new TypeError();
        }

        current = getPrototypeOf(current);
    }
}

/**
 * Select the observed skip only; this does not validate or authenticate a packet.
 * The caller must establish that field2 and headAfterBytes describe the same
 * plaintext, that collection has the intended origin, and that reserve parsing
 * really succeeded. headAfterBytes is the raw count after the declared head.
 * Collection extra properties are ignored; only its length and indexed own data
 * properties are inspected. All byte inputs, including duplicates, count toward
 * the inclusive 16 MiB local budget. A skip of four does not prove that a later
 * business wrapper is complete or valid.
 */
export function selectTargetResponseBusinessSkip(
    field2: Uint8Array,
    collection: readonly Uint8Array[],
    headAfterBytes: number,
): { matched: boolean; skip: 0 | 4 } {
    const owned: Uint8Array[] = [];
    let total = 0;

    try {
        if (
            typeof headAfterBytes !== 'number' ||
            !isSafeInteger(headAfterBytes) ||
            headAfterBytes < 0 ||
            headAfterBytes > MAX_BYTES ||
            isProxy(collection) ||
            !isArray(collection)
        ) {
            throw new TypeError();
        }

        validateChain(collection);
        const lengthDescriptor = getOwnPropertyDescriptor(collection, 'length');
        const count: unknown = lengthDescriptor?.value;

        if (typeof count !== 'number' || !isSafeInteger(count) || count < 0 || count > MAX_ITEMS) {
            throw new TypeError();
        }

        const snapshot = (value: unknown): Uint8Array => {
            if (isProxy(value) || !isView(value) || typedArrayTag.call(value) !== 'Uint8Array') {
                throw new TypeError();
            }

            validateChain(value);
            const buffer: ArrayBuffer = typedArrayBuffer.call(value);
            const length: number = typedArrayLength.call(value);
            const offset: number = typedArrayOffset.call(value);
            let shared = false;

            try {
                sharedBufferLength.call(buffer);
                shared = true;
            } catch {
                // The captured SharedArrayBuffer getter rejects ordinary buffers.
            }

            if (shared || length > MAX_BYTES - total) {
                throw new TypeError();
            }

            // This intrinsic rejects detached and out-of-bounds views, even empty ones.
            typedArrayValues.call(value);
            total += length;
            const copy = new ByteArray(length);
            owned.push(copy);
            copyBytes.call(copy, new ByteArray(buffer, offset, length));
            return copy;
        };

        const key = snapshot(field2);

        for (let index = 0; index < count; index++) {
            const descriptor = getOwnPropertyDescriptor(collection, String(index));

            if (!descriptor || !('value' in descriptor)) {
                throw new TypeError();
            }

            snapshot(descriptor.value);
        }

        let matched = false;

        for (let index = 1; index < owned.length; index++) {
            const candidate = owned[index];

            if (candidate.length !== key.length) {
                continue;
            }

            let equal = true;

            for (let byte = 0; byte < key.length; byte++) {
                if (key[byte] !== candidate[byte]) {
                    equal = false;
                    break;
                }
            }

            if (equal) {
                matched = true;
                break;
            }
        }

        return { matched, skip: matched && headAfterBytes >= 5 ? 4 : 0 };
    } catch {
        throw new Error('target sso12 lookup failed');
    } finally {
        for (let index = 0; index < owned.length; index++) {
            try {
                clearBytes.call(owned[index], 0);
            } catch {
                // Each independently owned snapshot gets its own cleanup attempt.
            }
        }
    }
}
