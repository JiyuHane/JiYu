import { isProxy, isUint8Array } from 'node:util/types';

/** Local inclusive frame cap, not an observed target protocol limit. */
export const MAX_TARGET_MSF_REQUEST_BASE_BYTES = 16 * 1024 * 1024;

interface CommonFields {
    flagA1: number;
    field0c: number;
    field60: number;
    field68: Uint8Array;
    field28: Uint8Array;
}

export type TargetMsfRequestBaseCandidateInput = CommonFields &
    (
        | { mode: 12 | 20; field10: Uint8Array; fieldA4?: never }
        | { mode: 13 | 21; fieldA4: number; field10?: never }
    );

const ERROR = 'target MSF request-base construction failed';
const Bytes = Uint8Array;
const View = DataView;
const Failure = Error;
const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const getPrototype = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const create = Object.create;
const recordPrototype = Object.prototype;
const isInteger = Number.isInteger;
const typedPrototype = getPrototype(Bytes.prototype) as object;
const getBuffer = getDescriptor(typedPrototype, 'buffer')!.get!;
const getLength = getDescriptor(typedPrototype, 'byteLength')!.get!;
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

    if (prototype !== recordPrototype && prototype !== null) {
        throw new Failure();
    }

    const keys = ownKeys(input);

    if (keys.length !== 7) {
        throw new Failure();
    }

    const fields = create(null) as Record<string, unknown>;

    // Array and typed-array iterators share a prototype; do not advance either.
    for (let index = 0; index < keys.length; index++) {
        const key = keys[index];

        if (
            key !== 'mode' &&
            key !== 'flagA1' &&
            key !== 'field0c' &&
            key !== 'field60' &&
            key !== 'field68' &&
            key !== 'field28' &&
            key !== 'field10' &&
            key !== 'fieldA4'
        ) {
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
    if (typeof value !== 'number' || !isInteger(value) || value < 0 || value > maximum) {
        throw new Failure();
    }

    return value;
}

function inspect(input: unknown): { value: Uint8Array; length: number } {
    if (isProxy(input) || !isUint8Array(input)) {
        throw new Failure();
    }

    // Creating the iterator validates detached/OOB views; never advance it.
    apply(values, input, []);
    const buffer: unknown = apply(getBuffer, input, []);
    apply(getBufferLength, buffer, []); // Ordinary ArrayBuffer only, including cross-realm.
    return { value: input, length: apply(getLength, input, []) as number };
}

/**
 * Offline candidate for CRequestBase's normal writer at 0x67b4440, restricted
 * to the observed 12/20 and 13/21 branches. The leading BE32 includes itself;
 * field10 (12/20 only) and field68 have self-inclusive BE32 lengths. field28 is
 * appended unchanged, without encryption or another length prefix.
 *
 * A nonzero flagA1 ORs 0x40000000 into the mode word. field0c and field60 are
 * caller-supplied bytes: no command, account, class or UIN meaning is inferred.
 * This does not implement flagA0's distinct 0x67b4680 wrapper, a signer, a
 * complete network protocol, or evidence of native/runtime compatibility.
 *
 * Input must be a local plain or null-prototype record with exactly the seven
 * own data fields for its branch. Accessors, symbol/unknown keys and the other
 * branch's field are rejected without invoking user code. Byte inputs must be
 * attached, in-bounds, nonshared Uint8Arrays; Buffer and cross-realm views work.
 * Captured intrinsics read slots and copy directly into one independent output;
 * they do not consult view properties, species, iterators or caller methods.
 * Built-ins must be intact at module initialization. No user callback occurs
 * between validation and copying. Inputs are not changed or retained; a partial
 * output is cleared on failure, best effort rather than guaranteed memory erasure.
 */
export function encodeTargetMsfRequestBaseCandidate(
    input: TargetMsfRequestBaseCandidateInput,
): Uint8Array {
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        const fields = capture(input);
        const mode = fields.mode;
        const spanBranch = mode === 12 || mode === 20;

        if (
            (!spanBranch && mode !== 13 && mode !== 21) ||
            hasOwn(fields, 'field10') !== spanBranch ||
            hasOwn(fields, 'fieldA4') === spanBranch
        ) {
            throw new Failure();
        }

        const flagA1 = uint(fields.flagA1, 0xff);
        const field0c = uint(fields.field0c, 0xff);
        const field60 = uint(fields.field60, 0xff);
        const field10 = spanBranch ? inspect(fields.field10) : undefined;
        const fieldA4 = spanBranch ? 0 : uint(fields.fieldA4, 0xffffffff);
        const field68 = inspect(fields.field68);
        const field28 = inspect(fields.field28);
        const total = 18 + (field10?.length ?? 0) + field68.length + field28.length;

        if (total > MAX_TARGET_MSF_REQUEST_BASE_BYTES) {
            throw new Failure();
        }

        output = new Bytes(total);
        const view = new View(apply(getBuffer, output, []) as ArrayBuffer);
        apply(setUint32, view, [0, total, false]);
        apply(setUint32, view, [4, (mode as number) | (flagA1 === 0 ? 0 : 0x40000000), false]);
        output[8] = field0c;
        let offset = 13;

        if (field10 !== undefined) {
            apply(setUint32, view, [9, field10.length + 4, false]);
            apply(set, output, [field10.value, offset]);
            offset += field10.length;
        } else {
            apply(setUint32, view, [9, fieldA4, false]);
        }

        output[offset++] = field60;
        apply(setUint32, view, [offset, field68.length + 4, false]);
        offset += 4;
        apply(set, output, [field68.value, offset]);
        offset += field68.length;
        apply(set, output, [field28.value, offset]);
        complete = true;
        return output;
    } catch {
        throw new Failure(ERROR);
    } finally {
        if (!complete && output !== undefined) {
            try {
                apply(fill, output, [0]);
            } catch {
                // Preserve the fixed failure even if best-effort cleanup also fails.
            }
        }
    }
}
