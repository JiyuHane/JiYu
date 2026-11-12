import { isProxy } from 'node:util/types';
import { inflateSync } from 'node:zlib';

/** Local resource policy, not a recovered target limit. */
export const MAX_TARGET_ZLIB_CANDIDATE_BYTES = 16 * 1024 * 1024;

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

/**
 * Explicit local zlib candidate only: no parser/runtime integration, authentication,
 * target compatibility, or emulation of the target's capacity retry policy.
 * Both input and caller-selected output limit are bounded by the local 16 MiB cap.
 * A zero output limit permits only a valid stream producing zero bytes.
 * Node's info mode reports consumed input; any bytes after the first stream fail.
 */
export function inflateTargetZlibCandidate(input: Uint8Array, maxOutputBytes: number): Uint8Array {
    let snapshot: Uint8Array | undefined;
    let decoded: Buffer | undefined;

    try {
        if (
            isProxy(input) ||
            !ArrayBuffer.isView(input) ||
            typedArrayTag.call(input) !== 'Uint8Array' ||
            typeof maxOutputBytes !== 'number' ||
            !Number.isSafeInteger(maxOutputBytes) ||
            maxOutputBytes < 0 ||
            maxOutputBytes > MAX_TARGET_ZLIB_CANDIDATE_BYTES
        ) {
            throw new TypeError('invalid input');
        }

        const buffer: ArrayBuffer = typedArrayBuffer.call(input);
        const byteLength: number = typedArrayLength.call(input);
        const byteOffset: number = typedArrayOffset.call(input);
        let shared = false;

        try {
            sharedBufferLength.call(buffer);
            shared = true;
        } catch {
            // The intrinsic rejects ordinary ArrayBuffers, including across realms.
        }

        if (shared || byteLength > MAX_TARGET_ZLIB_CANDIDATE_BYTES) {
            throw new RangeError('invalid backing or length');
        }

        // Validate detached and out-of-bounds resizable views before copying.
        typedArrayValues.call(input);
        snapshot = new Uint8Array(byteLength);
        copyBytes.call(snapshot, new Uint8Array(buffer, byteOffset, byteLength));

        // The installed Node typings declare Buffer even for info:true; validate
        // the documented runtime shape rather than asserting a fictional overload.
        const info: unknown = inflateSync(snapshot, {
            info: true,
            maxOutputLength: Math.max(1, maxOutputBytes),
        });

        if (
            typeof info !== 'object' ||
            info === null ||
            !('buffer' in info) ||
            !('engine' in info)
        ) {
            throw new TypeError('invalid inflater result');
        }

        if (!Buffer.isBuffer(info.buffer)) {
            throw new TypeError('invalid inflater output');
        }

        decoded = info.buffer;
        const engine: unknown = info.engine;

        if (
            typeof engine !== 'object' ||
            engine === null ||
            !('bytesWritten' in engine) ||
            engine.bytesWritten !== byteLength ||
            decoded.byteLength > maxOutputBytes
        ) {
            throw new RangeError('invalid output or trailing input');
        }

        const output = new Uint8Array(decoded.byteLength);
        copyBytes.call(output, decoded);
        return output;
    } catch {
        // A fixed message avoids exposing content or Node's input-dependent errors.
        throw new Error('target zlib candidate decoding failed');
    } finally {
        try {
            if (snapshot) {
                clearBytes.call(snapshot, 0);
            }
        } catch {
            // Best effort only; preserve the operation's result or fixed error.
        }

        try {
            if (decoded) {
                clearBytes.call(decoded, 0);
            }
        } catch {
            // Best effort only; native zlib and runtime copies are outside our control.
        }
    }
}
