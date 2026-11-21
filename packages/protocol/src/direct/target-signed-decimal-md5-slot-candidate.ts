import { isProxy, isUint8Array } from 'node:util/types';
import { targetSignedDecimalMd5Candidate } from './target-signed-decimal-md5-candidate';

const STRUCTURE_BYTES = 0x300;
const SLOT_OFFSET = 0x200;
const DIGEST_BYTES = 0x10;
const LENGTH_OFFSET = 0x2ff;
const ERROR = 'target signed decimal MD5 slot candidate failed';

// Do not consult input properties, iterators, constructors, or species.
const Bytes = Uint8Array;
const apply = Reflect.apply;
const typedPrototype = Object.getPrototypeOf(Bytes.prototype) as object;
const getBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset')!.get!;
const getLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get!;
const getBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const values = Bytes.prototype.values;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;

function clear(bytes: Uint8Array | undefined): void {
    if (bytes !== undefined) {
        try {
            apply(fill, bytes, [0]);
        } catch {
            // Each owned allocation receives its own best-effort cleanup attempt.
        }
    }
}

/**
 * Offline model of the single conditional slot write, not a complete signature,
 * login, verification, or server behavior. The caller asserts that the static
 * gates for the signed-decimal MD5 branch hold and that no aliasing or later
 * writes overwrite this local result. The supplied bits are the value formatted
 * by the existing signed-decimal candidate; target reachability is not implied.
 *
 * Input must be a genuine, attached, in-bounds, nonshared 0x300-byte Uint8Array;
 * subviews and Buffer instances are accepted. The source must remain stable
 * during the synchronous snapshot, and built-in intrinsics must be intact at
 * module import. The returned storage is independent of the caller. All failures
 * use the same input-free error. Owned temporary bytes and failed outputs are
 * cleared best effort; JavaScript does not guarantee complete memory erasure.
 */
export function placeTargetSignedDecimalMd5SlotCandidate(
    output: Uint8Array,
    bits: number,
): Uint8Array {
    let snapshot: Uint8Array | undefined;
    let result: Uint8Array | undefined;
    let digest: Uint8Array | undefined;
    let complete = false;

    try {
        if (isProxy(output) || !isUint8Array(output)) {
            throw new TypeError();
        }

        apply(values, output, []); // Reject detached and out-of-bounds views.
        const sourceBuffer = apply(getBuffer, output, []) as ArrayBuffer;
        apply(getBufferLength, sourceBuffer, []); // Reject shared backing.
        const sourceOffset = apply(getOffset, output, []) as number;

        if ((apply(getLength, output, []) as number) !== STRUCTURE_BYTES) {
            throw new TypeError();
        }

        snapshot = new Bytes(STRUCTURE_BYTES);
        apply(set, snapshot, [new Bytes(sourceBuffer, sourceOffset, STRUCTURE_BYTES)]);
        result = new Bytes(STRUCTURE_BYTES);
        apply(set, result, [snapshot]);

        const candidate = targetSignedDecimalMd5Candidate(bits);

        if (isProxy(candidate) || !isUint8Array(candidate)) {
            throw new TypeError();
        }

        apply(values, candidate, []);
        const digestBuffer = apply(getBuffer, candidate, []) as ArrayBuffer;
        apply(getBufferLength, digestBuffer, []);

        // Never clear a caller-owned or otherwise aliased buffer on failure.
        if (
            digestBuffer === sourceBuffer ||
            digestBuffer === apply(getBuffer, snapshot, []) ||
            digestBuffer === apply(getBuffer, result, [])
        ) {
            throw new TypeError();
        }

        digest = candidate;

        if ((apply(getLength, digest, []) as number) !== DIGEST_BYTES) {
            throw new TypeError();
        }

        for (let index = 0; index < DIGEST_BYTES; index++) {
            result[SLOT_OFFSET + index] = digest[index];
        }

        result[LENGTH_OFFSET] = DIGEST_BYTES;

        // Compare with the private snapshot, never with mutable caller storage.
        for (let index = 0; index < STRUCTURE_BYTES; index++) {
            const expected =
                index >= SLOT_OFFSET && index < SLOT_OFFSET + DIGEST_BYTES
                    ? digest[index - SLOT_OFFSET]
                    : index === LENGTH_OFFSET
                      ? DIGEST_BYTES
                      : snapshot[index];

            if (result[index] !== expected) {
                throw new Error();
            }
        }

        complete = true;
        return result;
    } catch {
        throw new Error(ERROR);
    } finally {
        if (!complete) {
            clear(result);
        }

        clear(snapshot);
        clear(digest);
    }
}
