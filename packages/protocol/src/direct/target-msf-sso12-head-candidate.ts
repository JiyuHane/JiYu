import { isProxy, isUint8Array } from 'node:util/types';
import { encodeTargetSso12Head, MAX_TARGET_SSO12_HEAD_BYTES } from './target-sso12-head';

/** Shares the existing local cap; this is not a native protocol limit. */
export const MAX_TARGET_MSF_SSO12_HEAD_BYTES = MAX_TARGET_SSO12_HEAD_BYTES;

export interface TargetMsfSso12HeadCandidateInput {
    field08: number;
    field0c: number;
    field10: number;
    field14: number;
    /** Caller-supplied snapshot of the writable global's first nine bytes. */
    globalPrefix9: Uint8Array;
    field15: number;
    /** Only the low byte of field16 << 2 is written. */
    field16: number;
    field20: Uint8Array;
    field50: Uint8Array;
    field68: Uint8Array;
    field98: Uint8Array;
    fieldB0: Uint8Array;
    fieldC8: Uint8Array;
    fieldE0: Uint8Array;
}

const NAMES = [
    'field08',
    'field0c',
    'field10',
    'field14',
    'globalPrefix9',
    'field15',
    'field16',
    'field20',
    'field50',
    'field68',
    'field98',
    'fieldB0',
    'fieldC8',
    'fieldE0',
] as const;
const ERROR = 'target MSF SSO12 head construction failed';
const Bytes = Uint8Array;
const Failure = Error;
const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const getPrototype = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const create = Object.create;
const plainPrototype = Object.prototype;
const includes = Array.prototype.includes;
const integer = Number.isInteger;
const typed = getPrototype(Bytes.prototype) as object;
const getLength = getDescriptor(typed, 'byteLength')!.get!;
const getBuffer = getDescriptor(typed, 'buffer')!.get!;
const getBufferLength = getDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const values = Bytes.prototype.values;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;

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

function uint(value: unknown, maximum: number): number {
    if (typeof value !== 'number' || !integer(value) || value < 0 || value > maximum) {
        throw new Failure();
    }

    return value;
}

function bytes(value: unknown): Uint8Array {
    if (isProxy(value) || !isUint8Array(value)) {
        throw new Failure();
    }

    apply(values, value, []); // Validate attachment and bounds without advancing an iterator.
    apply(getBufferLength, apply(getBuffer, value, []), []); // Reject shared backing.
    return value;
}

function clear(value: Uint8Array | undefined): void {
    if (value !== undefined) {
        try {
            apply(fill, value, [0]);
        } catch {
            // Cleanup is best effort and must not replace the construction result.
        }
    }
}

/**
 * Model only the pre-transform mode-12 SDK head at 0x67b4fc2. The seven
 * length-delimited fields share the earlier CPB head's layout, so the existing
 * encoder handles them; only the separately observed mixed block is replaced.
 * No body, compression, encryption, signing or runtime object is constructed.
 *
 * Unlike the native constructor, this API requires every mixed-block value.
 * It neither assumes the writable global stays zero nor supplies a value for
 * the native object's uninitialized field16. The old CPB encoder is unchanged.
 * Native offsets are labels, not memory reads or inferred semantic field names.
 *
 * Inputs are plain/null-prototype own-data records. Byte views must be attached,
 * in bounds and nonshared. The existing codec's local total cap and inclusive
 * u16 overflow rejection apply. Outputs are independent; local temporary bytes
 * are cleared best effort. This reuses the existing codec, with its requirement
 * that built-ins remain intact; it does not promise isolation from global
 * monkey-patching. Static layout/model agreement is not QQ interoperability.
 */
export function encodeTargetMsfSso12HeadCandidate(
    input: TargetMsfSso12HeadCandidateInput,
): Uint8Array {
    let prefix: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        const fields = capture(input);
        const field14 = uint(fields.field14, 0xff);
        const field15 = uint(fields.field15, 0xff);
        const field16 = uint(fields.field16, 0xff);
        const globalPrefix9 = bytes(fields.globalPrefix9);

        if (apply(getLength, globalPrefix9, []) !== 9) {
            throw new Failure();
        }

        prefix = new Bytes(12);
        prefix[0] = field14;
        apply(set, prefix, [globalPrefix9, 1]);
        prefix[10] = field15;
        prefix[11] = (field16 << 2) & 0xff;

        output = encodeTargetSso12Head({
            sequence: uint(fields.field08, 0xffffffff),
            arg0: uint(fields.field0c, 0xffffffff),
            arg4: uint(fields.field10, 0xffffffff),
            arg8: field15,
            a2: bytes(fields.field20),
            requestCommand: bytes(fields.field50),
            this8: bytes(fields.field68),
            arg28: bytes(fields.field98),
            this20: bytes(fields.fieldB0),
            versionArg10: bytes(fields.fieldC8),
            reserved: bytes(fields.fieldE0),
        });
        apply(set, output, [prefix, 16]);
        complete = true;
        return output;
    } catch {
        throw new Failure(ERROR);
    } finally {
        clear(prefix);

        if (!complete) {
            clear(output);
        }
    }
}
