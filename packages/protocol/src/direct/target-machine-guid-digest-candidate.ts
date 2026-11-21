import { createHash } from 'node:crypto';
import { isProxy, isUint8Array } from 'node:util/types';

const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const Bytes = Uint8Array;
const CandidateError = Error;
const apply = Reflect.apply;
const getPrototype = Object.getPrototypeOf;
const typed = getPrototype(Bytes.prototype) as object;
const getBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const getLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const getBackingLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const validateView = Bytes.prototype.values;
const copyBytes = Bytes.prototype.set;
const fillBytes = Bytes.prototype.fill;

type View = { backing: ArrayBuffer; offset: number; length: number };

function inspect(input: Uint8Array): View {
    if (isProxy(input) || !isUint8Array(input)) {
        throw new CandidateError();
    }

    let current: object | null = input;

    for (let depth = 0; current !== null; depth++) {
        if (depth >= 256 || isProxy(current)) {
            throw new CandidateError();
        }

        current = getPrototype(current) as object | null;
    }

    // Validates detached and out-of-bounds views, including zero-length views.
    apply(validateView, input, []);
    const backing = apply(getBuffer, input, []) as ArrayBuffer;
    // The ArrayBuffer getter rejects SharedArrayBuffer, including foreign realms.
    const backingLength = apply(getBackingLength, backing, []) as number;
    const offset = apply(getOffset, input, []) as number;
    const length = apply(getLength, input, []) as number;

    if (offset + length > backingLength) {
        throw new CandidateError();
    }

    return { backing, offset, length };
}

function clear(bytes: Uint8Array | undefined): void {
    if (bytes) {
        try {
            apply(fillBytes, bytes, [0]);
        } catch {
            // Attempt each private allocation independently, even after a failure.
        }
    }
}

/**
 * Offline candidate for the normal branch of static 0x8868c20. At 0x8868fe6,
 * initialization at 0x8b45610 precedes updates of the first and second processed
 * byte strings in order; 0x8b45e70 emits 16 bytes. The IV, constants, rotations
 * and padding strongly suggest MD5, but the Boolean operations have not all been
 * proven: this is a candidate, not established target equivalence.
 *
 * Both inputs are already processed bytes supplied by the caller. In particular,
 * the second must not be inferred directly from a raw machine-info file. Two
 * empty inputs indicate a different target fallback and fail locally. The 16 MiB
 * aggregate limit is a local policy, not an established target limit. This module
 * does not read machine files, devices, networks or real user data.
 *
 * Genuine non-proxy Uint8Array views with non-proxy prototype chains and attached,
 * non-shared backing are required. Prototype walks are locally limited to 256
 * non-null objects including the input. The caller must keep the inputs stable while
 * they are copied, and JS and Node intrinsics must be trusted. Caller-owned input
 * and returned output remain untouched; private snapshots, intermediate digest and
 * incomplete output are cleared best effort. Node crypto internals and runtime
 * copies cannot be guaranteed erased. All failures use one fixed local error.
 */
export function deriveTargetMachineGuidDigestCandidate(
    first: Uint8Array,
    second: Uint8Array,
): Uint8Array {
    let firstSnapshot: Uint8Array | undefined;
    let secondSnapshot: Uint8Array | undefined;
    let digest: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        const firstView = inspect(first);
        const secondView = inspect(second);
        const total = firstView.length + secondView.length;

        if (total === 0 || total > MAX_TOTAL_BYTES) {
            throw new CandidateError();
        }

        firstSnapshot = new Bytes(firstView.length);
        apply(copyBytes, firstSnapshot, [
            new Bytes(firstView.backing, firstView.offset, firstView.length),
        ]);
        secondSnapshot = new Bytes(secondView.length);
        apply(copyBytes, secondSnapshot, [
            new Bytes(secondView.backing, secondView.offset, secondView.length),
        ]);

        const hash = createHash('md5');
        hash.update(firstSnapshot);
        hash.update(secondSnapshot);
        digest = hash.digest();

        if (apply(getLength, digest, []) !== 16) {
            throw new CandidateError();
        }

        output = new Bytes(16);
        apply(copyBytes, output, [digest]);
        complete = true;
        return output;
    } catch {
        throw new CandidateError('target machine GUID digest candidate failed');
    } finally {
        clear(firstSnapshot);
        clear(secondSnapshot);
        clear(digest);

        if (!complete) {
            clear(output);
        }
    }
}
