import { isProxy, isUint8Array } from 'node:util/types';

const INVALID_INPUT = 'invalid SHA-256 schedule candidate input';
const UNAVAILABLE = 'SHA-256 schedule candidate unavailable';
const OPERATION_FAILED = 'SHA-256 schedule candidate failed';
const BLOCK_BYTES = 64;
const SCHEDULE_WORDS = 64;

// Capture intrinsics at initialization, assuming they are trusted at that point.
// This avoids input properties, iterators and species; it is not process isolation.
const intrinsicIsProxy = isProxy;
const intrinsicIsUint8Array = isUint8Array;
const InputError = TypeError;
const CandidateError = Error;
const Bytes = Uint8Array;
const Words = Uint32Array;
const apply = Reflect.apply;
const intrinsicHasInstance = Function.prototype[Symbol.hasInstance];
const typedArrayPrototype = Object.getPrototypeOf(Bytes.prototype) as object;
const getBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const getOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
const getLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const getBackingLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;
const getResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const validateView = Bytes.prototype.values;
const copyBytes = Bytes.prototype.set;
const clearTypedArray = Bytes.prototype.fill;

/**
 * Offline conditional local mathematical model of a selected binary branch.
 * The caller supplies one exact 64-byte block; this returns 64 numeric schedule
 * words, not a serialized digest or a complete algorithm. The returned typed
 * array's backing-byte order is platform-native. Runtime values, table loading, the
 * full algorithm and any SSO or signature relationship have not been observed
 * or established. No target process or sample file is opened by this module.
 *
 * Only genuine non-proxy byte views with fixed, non-shared, attached backing
 * are accepted. Resizable backing is rejected even when its view is in bounds;
 * if a required intrinsic is unavailable, validation fails closed. The caller
 * must prevent external writes, detachment, release or invalidation of backing
 * memory during the call; JavaScript cannot detect all external memory changes.
 * Successful cleanup overwrites the owned snapshot without promising physical
 * memory erasure. Input, availability and operation failures have distinct fixed
 * errors without their original causes.
 */
export function targetSha256ScheduleCandidate(input: Uint8Array): Uint32Array {
    if (
        typeof intrinsicIsProxy !== 'function' ||
        typeof intrinsicIsUint8Array !== 'function' ||
        typeof apply !== 'function' ||
        typeof intrinsicHasInstance !== 'function' ||
        typeof validateView !== 'function' ||
        typeof getLength !== 'function' ||
        typeof getOffset !== 'function' ||
        typeof getBuffer !== 'function' ||
        typeof getBackingLength !== 'function'
    ) {
        throw new CandidateError(UNAVAILABLE);
    }

    let buffer: ArrayBuffer;
    let offset: number;

    try {
        if (intrinsicIsProxy(input) || !intrinsicIsUint8Array(input)) {
            throw new InputError();
        }

        // This intrinsic validates detached and out-of-bounds typed-array views.
        apply(validateView, input, []);
        const length = apply(getLength, input, []) as number;
        offset = apply(getOffset, input, []) as number;
        buffer = apply(getBuffer, input, []) as ArrayBuffer;
        // The ArrayBuffer intrinsic rejects SharedArrayBuffer, including cross-realm ones.
        const backingLength = apply(getBackingLength, buffer, []) as number;

        if (length !== BLOCK_BYTES || offset + BLOCK_BYTES > backingLength) {
            throw new InputError();
        }
    } catch (error) {
        if (apply(intrinsicHasInstance, InputError, [error]) === true) {
            throw new InputError(INVALID_INPUT);
        }

        throw new CandidateError(OPERATION_FAILED);
    }

    if (
        typeof getResizable !== 'function' ||
        typeof copyBytes !== 'function' ||
        typeof clearTypedArray !== 'function' ||
        typeof Words !== 'function'
    ) {
        throw new CandidateError(UNAVAILABLE);
    }

    try {
        if (apply(getResizable, buffer, []) !== false) {
            throw new InputError();
        }
    } catch (error) {
        if (apply(intrinsicHasInstance, InputError, [error]) === true) {
            throw new InputError(INVALID_INPUT);
        }

        throw new CandidateError(OPERATION_FAILED);
    }

    let snapshot: Uint8Array | undefined;
    let output: Uint32Array | undefined;
    let operationSucceeded = false;
    let cleanupFailed = false;

    try {
        snapshot = new Bytes(BLOCK_BYTES);
        apply(copyBytes, snapshot, [new Bytes(buffer, offset, BLOCK_BYTES)]);
        output = new Words(SCHEDULE_WORDS);

        for (let index = 0; index < 16; index++) {
            const start = index * 4;
            output[index] =
                ((snapshot[start] << 24) |
                    (snapshot[start + 1] << 16) |
                    (snapshot[start + 2] << 8) |
                    snapshot[start + 3]) >>>
                0;
        }

        for (let index = 16; index < SCHEDULE_WORDS; index++) {
            const x = output[index - 2];
            const y = output[index - 15];
            const sigma1 = (((x >>> 17) | (x << 15)) ^ ((x >>> 19) | (x << 13)) ^ (x >>> 10)) >>> 0;
            const sigma0 = (((y >>> 7) | (y << 25)) ^ ((y >>> 18) | (y << 14)) ^ (y >>> 3)) >>> 0;
            output[index] = (sigma1 + output[index - 7] + sigma0 + output[index - 16]) >>> 0;
        }

        operationSucceeded = true;
    } catch {
        // Report a fixed, input-free error after cleanup.
    } finally {
        if (snapshot) {
            try {
                apply(clearTypedArray, snapshot, [0]);
            } catch {
                cleanupFailed = true;
            }
        }

        if (output && (!operationSucceeded || cleanupFailed)) {
            try {
                apply(clearTypedArray, output, [0]);
            } catch {
                cleanupFailed = true;
            }
        }
    }

    if (!operationSucceeded || cleanupFailed || !output) {
        throw new CandidateError(OPERATION_FAILED);
    }

    return output;
}
