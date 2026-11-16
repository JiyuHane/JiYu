import { isProxy } from 'node:util/types';
import type {
    TargetSso12ReserveField23,
    TargetSso12ReserveField24,
    TargetSso12ReserveMessage,
} from '@snowluma/proto-defs/target-sso12-reserve';
import { protobuf_encode } from '@snowluma/proton';

// Partial static observations at 0x666a1d0 / 0x666a660 in the selected
// wrapper.node (SHA-256 dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328).
// Field 23 follows 0x6669da0 and serializer 0x8b47f10. Parent serialization
// order is inferred as ascending; runtime behavior, semantics and interoperability
// remain unverified. Other possible fields are outside this subset.
/** Local caps; neither is a target protocol limit. */
export const MAX_TARGET_SSO12_RESERVE_BYTES = 16 * 1024 * 1024;
export const MAX_TARGET_SSO12_FIELD23_ITEMS = 4096;

export interface TargetSso12ReserveInput {
    field12?: Uint8Array;
    /** Presence of this own property represents the native setter flag. */
    field13?: Uint8Array;
    /** Presence of this own property represents the native setter flag. */
    field15?: Uint8Array;
    /** Presence of this own property represents the native setter flag. */
    field16?: Uint8Array;
    /** Caller combines the two native conditions; true emits field 21 as 32. */
    field21Enabled?: boolean;
    /** Collection alone does not trigger serialization. Both child bytes are always present. */
    field23?: readonly { field1: Uint8Array; field2: Uint8Array }[];
    field24?: {
        field1?: Uint8Array;
        field2?: Uint8Array;
        field3?: Uint8Array;
    };
    /** Presence of this own property represents the setter flag, including zero. */
    field26?: number;
    field32?: Uint8Array;
}

/**
 * Caller-supplied opaque contents associated with native string-like objects at
 * these result offsets. The values are not the 0x18-byte object headers, and no
 * character encoding or string decoding is assumed. Static log length labels are
 * candidate names, not proof of dynamic origin or signing semantics; this type
 * does not equate these slots with the sign/token/extra API fields.
 */
export interface NativeSignResultPayloads {
    readonly at00: Uint8Array;
    readonly at18: Uint8Array;
    readonly at30: Uint8Array;
}

const reserveFieldNames = [
    'field12',
    'field13',
    'field15',
    'field16',
    'field21Enabled',
    'field23',
    'field24',
    'field26',
    'field32',
] as const;

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayTag = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    Symbol.toStringTag,
)!.get!;
const typedArrayValues = Uint8Array.prototype.values;
const sharedBufferLength = Object.getOwnPropertyDescriptor(
    SharedArrayBuffer.prototype,
    'byteLength',
)!.get!;
const copyBytes = Uint8Array.prototype.set;
const fillBytes = Uint8Array.prototype.fill;

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || isProxy(value)) {
        throw new TypeError('invalid record');
    }

    const prototype: unknown = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('invalid record prototype');
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;

        if (
            typeof key !== 'string' ||
            !allowed.includes(key) ||
            !Object.hasOwn(descriptor, 'value')
        ) {
            throw new TypeError('invalid property');
        }

        result[key] = descriptor.value;
    }

    return result;
}

function varintSize(n: number): number {
    let size = 1;

    while (n >= 128) {
        n = Math.floor(n / 128);
        size++;
    }

    return size;
}

interface ByteView {
    value: Uint8Array;
    length: number;
}

function inspectBytes(value: unknown): ByteView {
    if (!ArrayBuffer.isView(value) || typedArrayTag.call(value) !== 'Uint8Array') {
        throw new TypeError('invalid bytes');
    }

    const length = typedArrayLength.call(value) as number;
    const buffer: unknown = typedArrayBuffer.call(value);
    let shared = false;

    try {
        sharedBufferLength.call(buffer);
        shared = true;
    } catch {
        // The intrinsic rejects ordinary ArrayBuffers, including across realms.
    }

    if (shared || length > MAX_TARGET_SSO12_RESERVE_BYTES) {
        throw new RangeError('invalid bytes');
    }

    // The intrinsic validates detachment without reading content or caller methods.
    typedArrayValues.call(value);
    return { value: value as Uint8Array, length };
}

function snapshot(view: ByteView | undefined, owned: Uint8Array[]): Uint8Array | undefined {
    if (view === undefined) {
        return undefined;
    }

    const copy = new Uint8Array(view.length);
    owned.push(copy);
    copyBytes.call(copy, view.value);
    return copy;
}

function lengthDelimitedSize(tag: number, length: number | undefined): number {
    return length === undefined ? 0 : varintSize(tag * 8 + 2) + varintSize(length) + length;
}

function clearMsfSignBytes(value: Uint8Array | undefined): boolean {
    if (value === undefined) {
        return true;
    }

    try {
        fillBytes.call(value, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Decode caller-supplied bytes using only the successful 0x300-byte output model.
 * The caller-supplied Linux x64 QQ 3.2.35 wrapper.node static observations link
 * 0x352329a to 0x6856284, use of the output to eax == 0, and copying into the
 * three result slots to 0x3523301–0x3523346. The model reads lengths at 0xff,
 * 0x1ff and 0x2ff and opaque payloads at 0, 0x100 and 0x200, respectively.
 *
 * This function reads no binary, process or network, calls no target function,
 * and generates or verifies no signature. It establishes no QQ authenticity;
 * whether the target function is called dynamically remains unknown. Its three
 * separate caller-owned results can be passed to
 * encodeTargetSso12ReserveFromNativeSlots. Local snapshots and undelivered
 * results are cleared best effort; the caller owns cleanup of delivered results.
 */
export function decodeTargetMsfSignOutput(
    status: number,
    bytes: Uint8Array,
): NativeSignResultPayloads {
    const snapshots: Uint8Array[] = [];
    let at00: Uint8Array | undefined;
    let at18: Uint8Array | undefined;
    let at30: Uint8Array | undefined;
    let result: NativeSignResultPayloads | undefined;
    let snapshotsCleared = true;

    try {
        const view = inspectBytes(bytes);

        if (status !== 0 || view.length !== 0x300) {
            throw new TypeError('invalid output');
        }

        const copy = snapshot(view, snapshots);

        if (copy === undefined) {
            throw new TypeError('invalid output');
        }

        const length00 = copy[0xff];
        const length18 = copy[0x1ff];
        const length30 = copy[0x2ff];
        at00 = new Uint8Array(length00);

        for (let index = 0; index < length00; index++) {
            at00[index] = copy[index];
        }

        at18 = new Uint8Array(length18);

        for (let index = 0; index < length18; index++) {
            at18[index] = copy[0x100 + index];
        }

        at30 = new Uint8Array(length30);

        for (let index = 0; index < length30; index++) {
            at30[index] = copy[0x200 + index];
        }

        result = { at00, at18, at30 };
    } catch {
        // Sanitize errors after cleanup without exposing input or native details.
    } finally {
        for (const copy of snapshots) {
            if (!clearMsfSignBytes(copy)) {
                snapshotsCleared = false;
            }
        }

        if (result === undefined || !snapshotsCleared) {
            clearMsfSignBytes(at00);
            clearMsfSignBytes(at18);
            clearMsfSignBytes(at30);
        }
    }

    if (result === undefined || !snapshotsCleared) {
        throw new Error('target msf sign output decoding failed');
    }

    return result;
}

/**
 * Construct only the target-static subset. Inputs and output can be sensitive.
 * No data is logged. The field23 collection alone does not trigger serialization.
 * Plain records and own data properties are required; structure and total size
 * are checked before copying. Shared backing, proxies and accessors are rejected.
 * Limits are local policy; errors are sanitized. Local snapshots are cleared on
 * every outcome, best effort; encoded output stays caller-owned. JavaScript and
 * Proton-internal copies are not guaranteed to be erased.
 */
export function encodeTargetSso12Reserve(input: TargetSso12ReserveInput): Uint8Array {
    const owned: Uint8Array[] = [];

    try {
        return encode(input, owned);
    } catch {
        throw new Error('target SSO12 reserve construction failed');
    } finally {
        for (const copy of owned) {
            try {
                copy.fill(0);
            } catch {
                // Best effort per local snapshot, preserving the construction outcome.
            }
        }
    }
}

/**
 * Compose caller-supplied slot contents with the target-static reserve subset.
 * The offset permutation is conditional on the observed result retaining its
 * layout when transferred into the request. This function does not extract
 * native memory, decode strings, generate signatures, or perform I/O. Slot and
 * base records must remain stable until the synchronous encoder snapshots them.
 * The returned encoded bytes belong to the caller; cleanup follows the existing
 * encoder's best-effort snapshot policy.
 */
export function encodeTargetSso12ReserveFromNativeSlots(
    base: Omit<TargetSso12ReserveInput, 'field24'>,
    slots: NativeSignResultPayloads,
): Uint8Array {
    try {
        const fields = record(base, reserveFieldNames);
        const values = record(slots, ['at00', 'at18', 'at30']);

        if (
            Object.hasOwn(fields, 'field24') ||
            !Object.hasOwn(values, 'at00') ||
            !Object.hasOwn(values, 'at18') ||
            !Object.hasOwn(values, 'at30')
        ) {
            throw new TypeError('invalid native slots');
        }

        fields.field24 = {
            field1: values.at30,
            field2: values.at00,
            field3: values.at18,
        };
        // The encoder validates the assembled byte fields before copying them.
        return encodeTargetSso12Reserve(fields as TargetSso12ReserveInput);
    } catch {
        throw new Error('target SSO12 reserve construction failed');
    }
}

function encode(input: TargetSso12ReserveInput, owned: Uint8Array[]): Uint8Array {
    const fields = record(input, reserveFieldNames);

    function optionalBytes(name: string): ByteView | undefined {
        return Object.hasOwn(fields, name) ? inspectBytes(fields[name]) : undefined;
    }

    const field12 = optionalBytes('field12');
    const field13 = optionalBytes('field13');
    const field15 = optionalBytes('field15');
    const field16 = optionalBytes('field16');

    if (Object.hasOwn(fields, 'field21Enabled') && typeof fields.field21Enabled !== 'boolean') {
        throw new TypeError('invalid flag');
    }

    const field21 = fields.field21Enabled === true ? 32 : undefined;

    const entries23: { field1: ByteView; field2: ByteView }[] = [];
    let size23 = 0;

    if (Object.hasOwn(fields, 'field23')) {
        const list = fields.field23;

        if (isProxy(list) || !Array.isArray(list)) {
            throw new TypeError('invalid field23');
        }

        const lengthDescriptor = Object.getOwnPropertyDescriptor(list, 'length');
        const count = lengthDescriptor?.value as unknown;

        if (
            typeof count !== 'number' ||
            !Number.isInteger(count) ||
            count < 0 ||
            count > MAX_TARGET_SSO12_FIELD23_ITEMS
        ) {
            throw new RangeError('invalid field23 count');
        }

        const keys = Reflect.ownKeys(list);

        if (keys.length !== count + 1) {
            throw new TypeError('invalid field23 properties');
        }

        for (let index = 0; index < count; index++) {
            const item = Object.getOwnPropertyDescriptor(list, String(index));

            if (!item || !Object.hasOwn(item, 'value')) {
                throw new TypeError('invalid field23 entry');
            }

            const child = record(item.value, ['field1', 'field2']);

            if (!Object.hasOwn(child, 'field1') || !Object.hasOwn(child, 'field2')) {
                throw new TypeError('missing field23 bytes');
            }

            const field1 = inspectBytes(child.field1);
            const field2 = inspectBytes(child.field2);
            const childSize =
                lengthDelimitedSize(1, field1.length) + lengthDelimitedSize(2, field2.length);
            size23 += lengthDelimitedSize(23, childSize);

            if (size23 > MAX_TARGET_SSO12_RESERVE_BYTES) {
                throw new RangeError('reserve too large');
            }

            entries23.push({ field1, field2 });
        }
    }

    const values24: { field1?: ByteView; field2?: ByteView; field3?: ByteView } = {};
    let innerSize = 0;

    if (Object.hasOwn(fields, 'field24')) {
        const inner = record(fields.field24, ['field1', 'field2', 'field3']);

        for (const name of ['field1', 'field2', 'field3'] as const) {
            if (Object.hasOwn(inner, name)) {
                const value = inspectBytes(inner[name]);

                if (value.length !== 0) {
                    values24[name] = value;
                    innerSize += lengthDelimitedSize(1, value.length);
                }
            }
        }
    }

    let field26: number | undefined;

    if (Object.hasOwn(fields, 'field26')) {
        const value = fields.field26;

        if (
            typeof value !== 'number' ||
            !Number.isInteger(value) ||
            value < 0 ||
            value > 0xffffffff
        ) {
            throw new RangeError('invalid uint32');
        }

        field26 = value;
    }

    const field32 = optionalBytes('field32');
    const active =
        field13 !== undefined ||
        field15 !== undefined ||
        field16 !== undefined ||
        field21 !== undefined ||
        innerSize !== 0 ||
        field26 !== undefined ||
        (field32 !== undefined && field32.length !== 0);
    const visible12 = field12?.length ? field12 : undefined;
    const visible32 = field32?.length ? field32 : undefined;
    const size =
        lengthDelimitedSize(12, visible12?.length) +
        lengthDelimitedSize(13, field13?.length) +
        lengthDelimitedSize(15, field15?.length) +
        lengthDelimitedSize(16, field16?.length) +
        (field21 === undefined ? 0 : 2 + varintSize(field21)) +
        size23 +
        (innerSize === 0 ? 0 : lengthDelimitedSize(24, innerSize)) +
        (field26 === undefined ? 0 : 2 + varintSize(field26)) +
        lengthDelimitedSize(32, visible32?.length);

    if (size > MAX_TARGET_SSO12_RESERVE_BYTES) {
        throw new RangeError('reserve too large');
    }

    if (!active) {
        return new Uint8Array();
    }

    const field23: TargetSso12ReserveField23[] = entries23.map((item) => ({
        field1: snapshot(item.field1, owned),
        field2: snapshot(item.field2, owned),
    }));
    const field24: TargetSso12ReserveField24 | undefined =
        innerSize === 0
            ? undefined
            : {
                  field1: snapshot(values24.field1, owned),
                  field2: snapshot(values24.field2, owned),
                  field3: snapshot(values24.field3, owned),
              };
    const message: TargetSso12ReserveMessage = {
        field12: snapshot(visible12, owned),
        field13: snapshot(field13, owned),
        field15: snapshot(field15, owned),
        field16: snapshot(field16, owned),
        field21,
        field23,
        field24,
        field26,
        field32: snapshot(visible32, owned),
    };
    return protobuf_encode<TargetSso12ReserveMessage>(message);
}
