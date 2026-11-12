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

function encode(input: TargetSso12ReserveInput, owned: Uint8Array[]): Uint8Array {
    const fields = record(input, [
        'field12',
        'field13',
        'field15',
        'field16',
        'field21Enabled',
        'field23',
        'field24',
        'field26',
        'field32',
    ]);

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
