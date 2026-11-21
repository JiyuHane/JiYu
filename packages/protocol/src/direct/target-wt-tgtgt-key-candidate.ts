import { createHash } from 'node:crypto';
import { isProxy, isUint8Array } from 'node:util/types';

const Bytes = Uint8Array;
const typed = Object.getPrototypeOf(Bytes.prototype) as object;
const getBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const getLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const getBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const getPrototype = Object.getPrototypeOf;
const values = Bytes.prototype.values;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;

function clear(bytes: Uint8Array | undefined): void {
    if (bytes) {
        try {
            fill.call(bytes, 0);
        } catch {
            // Each owned allocation receives an independent best-effort attempt.
        }
    }
}

/**
 * Offline candidate for the normal path at static 0x3504ca0 with n <= 24.
 * Hashes the first min(n, 16) bytes, zero-padded to 16, followed by word as
 * BE64. The constants, rotations, IV and finalization strongly suggest MD5,
 * but not all compression indices and Boolean functions have been established;
 * target equivalence is therefore not proven. Rejecting n > 24 is a local
 * policy, not a model of the target's undefined out-of-bounds stack write.
 *
 * The source must stay stable while copied and intrinsics must be trusted.
 * Caller-owned input and the returned digest are not cleared. Private message,
 * intermediate digest and incomplete output are cleared best effort; Node
 * crypto internals and runtime copies cannot be cleared or guaranteed erased.
 * No account data, network, hooks or target process are accessed.
 */
export function deriveTargetWtTgtgtKeyCandidate(source: Uint8Array, word: bigint): Uint8Array {
    let message: Uint8Array | undefined;
    let digest: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        if (
            typeof word !== 'bigint' ||
            word < 0n ||
            word > 0xffffffffffffffffn ||
            isProxy(source) ||
            !isUint8Array(source)
        ) {
            throw new TypeError();
        }

        let current: object | null = source;

        for (let depth = 0; current !== null; depth++) {
            if (depth >= 256 || isProxy(current)) {
                throw new TypeError();
            }

            current = getPrototype(current) as object | null;
        }

        values.call(source); // Reject detached and out-of-bounds views, even empty ones.
        const backing = getBuffer.call(source) as ArrayBuffer;
        const backingSize = getBufferLength.call(backing) as number; // Reject shared backing.
        const size = getLength.call(source) as number;
        const start = getOffset.call(source) as number;

        if (size > 24 || start + size > backingSize) {
            throw new RangeError();
        }

        message = new Bytes(24);
        set.call(message, new Bytes(backing, start, Math.min(size, 16)));

        for (let index = 0; index < 8; index++) {
            message[16 + index] = Number((word >> BigInt((7 - index) * 8)) & 0xffn);
        }

        digest = createHash('md5').update(message).digest();
        output = new Bytes(16);
        set.call(output, digest);
        complete = true;
        return output;
    } catch {
        throw new Error('target WT tgtgt key candidate failed');
    } finally {
        clear(message);
        clear(digest);

        if (!complete) {
            clear(output);
        }
    }
}
