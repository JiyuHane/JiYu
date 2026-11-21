import { isProxy, isUint8Array } from 'node:util/types';
import { encodeTargetMsfLengthPrefixedFieldCandidate } from './target-msf-length-prefixed-field-candidate';

/** Local allocation cap, not an observed limit of the native protocol. */
export const MAX_TARGET_MSF_TRIMMED_HEAD_BYTES = 16 * 1024 * 1024;

export interface TargetMsfTrimmedHeadCandidateInput {
    field50: Uint8Array;
    field68: Uint8Array;
    fieldE0: Uint8Array;
}

const NAMES = ['field50', 'field68', 'fieldE0'] as const;
const ERROR = 'target MSF trimmed head construction failed';
const Bytes = Uint8Array;
const View = DataView;
const Failure = Error;
const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const getPrototype = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const create = Object.create;
const plainPrototype = Object.prototype;
const includes = Array.prototype.includes;
const typed = getPrototype(Bytes.prototype) as object;
const getLength = getDescriptor(typed, 'byteLength')!.get!;
const getBuffer = getDescriptor(typed, 'buffer')!.get!;
const getBufferLength = getDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const values = Bytes.prototype.values;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;
const setUint32 = View.prototype.setUint32;

function capture(input: unknown): Record<string, unknown> {
    if (input === null || typeof input !== 'object' || isProxy(input)) {
        throw new Failure();
    }

    const prototype: unknown = getPrototype(input);

    if (prototype !== plainPrototype && prototype !== null) {
        throw new Failure();
    }

    const keys = ownKeys(input);

    if (keys.length !== NAMES.length) {
        throw new Failure();
    }

    const fields = create(null) as Record<string, unknown>;

    for (let index = 0; index < keys.length; index++) {
        const key = keys[index];

        if (typeof key !== 'string' || !apply(includes, NAMES, [key])) {
            throw new Failure();
        }

        const descriptor = getDescriptor(input, key);

        if (descriptor === undefined || !hasOwn(descriptor, 'value')) {
            throw new Failure();
        }

        fields[key] = descriptor.value;
    }

    return fields;
}

function bytes(input: unknown): Uint8Array {
    if (isProxy(input) || !isUint8Array(input)) {
        throw new Failure();
    }

    apply(values, input, []);
    apply(getBufferLength, apply(getBuffer, input, []), []);
    return input;
}

function clear(input: Uint8Array | undefined): void {
    if (input !== undefined) {
        try {
            apply(fill, input, [0]);
        } catch {
            // Best effort for owned temporary or failed-output storage only.
        }
    }
}

/**
 * Offline pre-transform head shared by modes 13 and 21 at native 0x67b4f86.
 * H = BE32(16 + sum(lengths)) || LP4(field50) || LP4(field68) || LP4(fieldE0).
 * Each LP4 length includes its four prefix bytes; all payload bytes are opaque.
 *
 * This does not decide whether trimming is permitted. Native shouldTrim has
 * stateful prerequisites; the caller must establish the applicable mode. No
 * body, compression, encryption, registry, signing, socket or default key is
 * implemented. Offsets are labels, not native-memory accesses.
 *
 * Inputs are exact plain/null-prototype own-data records. Attached, in-bounds,
 * nonshared Uint8Array views (including Buffer and foreign-realm views) are
 * accepted without consulting their instance accessors or iterators. The
 * local total cap is checked before framing allocations. Storage is owned by
 * the result; temporary framed fields and a failed result are cleared best
 * effort. Built-ins must remain intact; this is not a memory-erasure guarantee
 * or proof of native runtime values or server acceptance.
 */
export function encodeTargetMsfTrimmedHeadCandidate(
    input: TargetMsfTrimmedHeadCandidateInput,
): Uint8Array {
    const framed: Uint8Array[] = [];
    let result: Uint8Array | undefined;
    let complete = false;

    try {
        const fields = capture(input);
        const sources: Uint8Array[] = [];
        let total = 16;

        for (let index = 0; index < NAMES.length; index++) {
            const source = bytes(fields[NAMES[index]]);
            sources[index] = source;
            total += apply(getLength, source, []) as number;

            if (total > MAX_TARGET_MSF_TRIMMED_HEAD_BYTES) {
                throw new Failure();
            }
        }

        for (let index = 0; index < sources.length; index++) {
            framed[index] = encodeTargetMsfLengthPrefixedFieldCandidate(sources[index]);
        }

        result = new Bytes(total);
        const writer = new View(apply(getBuffer, result, []) as ArrayBuffer);
        apply(setUint32, writer, [0, total, false]);
        let offset = 4;

        for (let index = 0; index < framed.length; index++) {
            apply(set, result, [framed[index], offset]);
            offset += apply(getLength, framed[index], []) as number;
        }

        complete = true;
        return result;
    } catch {
        throw new Failure(ERROR);
    } finally {
        for (let index = 0; index < framed.length; index++) {
            clear(framed[index]);
        }

        if (!complete) {
            clear(result);
        }
    }
}
