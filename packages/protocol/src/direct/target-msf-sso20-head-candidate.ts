import { isProxy, isUint8Array } from 'node:util/types';
import { encodeTargetMsfLengthPrefixedFieldCandidate } from './target-msf-length-prefixed-field-candidate';

/** Local allocation policy, not an observed native protocol limit. */
export const MAX_TARGET_MSF_SSO20_HEAD_BYTES = 16 * 1024 * 1024;

export interface TargetMsfSso20HeadCandidateInput {
    field08: number;
    /** A u32 bit pattern, emitted as the decimal text of its signed i32 value. */
    field0c: number;
    field20: Uint8Array;
    field50: Uint8Array;
    field68: Uint8Array;
    field98: Uint8Array;
    fieldE0: Uint8Array;
}

const BYTE_NAMES = ['field20', 'field50', 'field68', 'field98', 'fieldE0'] as const;
const NAMES = ['field08', 'field0c', ...BYTE_NAMES] as const;
const ERROR = 'target MSF SSO20 head construction failed';
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
const integer = Number.isInteger;
const toString = Number.prototype.toString;
const charCodeAt = String.prototype.charCodeAt;
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

function uint(value: unknown): number {
    if (typeof value !== 'number' || !integer(value) || value < 0 || value > 0xffffffff) {
        throw new Failure();
    }

    return value;
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
            // Best effort for owned temporary and failed-output storage only.
        }
    }
}

/**
 * Offline mode-20 pre-transform head at native 0x67b50aa. Unlike mode 12,
 * field0c is signed decimal text, and there is no mixed prefix or B0/C8 field.
 * H = BE32(L) || BE32(field08) || LP4(decimal(i32(field0c))) ||
 *     LP4(field20) || LP4(field50) || LP4(field68) || LP4(field98) || LP4(fieldE0).
 * L = 32 + decimal length + the five byte lengths, excluding any body.
 *
 * Both numeric inputs are explicit u32 bit patterns. All byte inputs are
 * opaque attached, in-bounds, nonshared Uint8Array views. Only exact plain or
 * null-prototype own-data records are accepted; input accessors, iterators and
 * coercion hooks are not consulted. The local total cap is checked before
 * field-framing allocations. Returned storage is independent; owned temporary
 * bytes and failed output are cleared best effort, not with an erasure guarantee.
 *
 * This does not choose a mode or construct a body, encryption, signature,
 * registry, transport or login session. Built-ins must remain intact. Static
 * byte-layout agreement does not establish target runtime values or acceptance.
 */
export function encodeTargetMsfSso20HeadCandidate(
    input: TargetMsfSso20HeadCandidateInput,
): Uint8Array {
    const framed: Uint8Array[] = [];
    let decimal: Uint8Array | undefined;
    let result: Uint8Array | undefined;
    let complete = false;

    try {
        const fields = capture(input);
        const field08 = uint(fields.field08);
        const text = apply(toString, uint(fields.field0c) | 0, [10]) as string;
        decimal = new Bytes(text.length);

        for (let index = 0; index < text.length; index++) {
            decimal[index] = apply(charCodeAt, text, [index]) as number;
        }

        const sources: Uint8Array[] = [decimal];
        let total = 32 + text.length;

        for (let index = 0; index < BYTE_NAMES.length; index++) {
            const source = bytes(fields[BYTE_NAMES[index]]);
            sources[index + 1] = source;
            total += apply(getLength, source, []) as number;

            if (total > MAX_TARGET_MSF_SSO20_HEAD_BYTES) {
                throw new Failure();
            }
        }

        for (let index = 0; index < sources.length; index++) {
            framed[index] = encodeTargetMsfLengthPrefixedFieldCandidate(sources[index]);
        }

        result = new Bytes(total);
        const writer = new View(apply(getBuffer, result, []) as ArrayBuffer);
        apply(setUint32, writer, [0, total, false]);
        apply(setUint32, writer, [4, field08, false]);
        let offset = 8;

        for (let index = 0; index < framed.length; index++) {
            apply(set, result, [framed[index], offset]);
            offset += apply(getLength, framed[index], []) as number;
        }

        complete = true;
        return result;
    } catch {
        throw new Failure(ERROR);
    } finally {
        clear(decimal);

        for (let index = 0; index < framed.length; index++) {
            clear(framed[index]);
        }

        if (!complete) {
            clear(result);
        }
    }
}
