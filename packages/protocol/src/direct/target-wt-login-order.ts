import { isProxy } from 'node:util/types';
import { encodeTargetWtLoginNode016a, encodeTargetWtLoginNode0318 } from './target-wt-login-node';

// Target-static observations, not a complete login encoder:
// wrapper.node SHA-256 dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328
// 0x346a0cd..0x346a109 supplies the two ordered tables to 0x3467d50.
// The helper first looks up every required node, then calls each node's +0x10
// virtual slot, and conditionally calls present nodes from the second tree.
const REQUIRED = [0x106, 0x144, 0x116, 0x142, 0x145, 0x018, 0x141, 0x177, 0x191] as const;
const OPTIONAL = [
    0x154, 0x400, 0x104, 0x100, 0x107, 0x108, 0x11b, 0x112, 0x185, 0x008, 0x187, 0x190, 0x201,
    0x318, 0x16a, 0x166, 0x521, 0x516, 0x172,
] as const;
const MAX_OUTPUT = 16 * 1024 * 1024;
const U8 = Uint8Array;
const typed = Object.getPrototypeOf(U8.prototype) as object;
const typedTag = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const typedBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const typedLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const typedOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const typedValues = U8.prototype.values;
const setBytes = U8.prototype.set;
const fillBytes = U8.prototype.fill;
const getPrototype = Object.getPrototypeOf;
const descriptor = Object.getOwnPropertyDescriptor;
const isView = ArrayBuffer.isView;

/** For unverified node writers, tag is a caller assertion, not inferred from bytes. */
export interface TargetWtLoginOpaqueNode {
    tag: number;
    kind: 'opaque';
    bytes: Uint8Array;
}

/** Only these independently inspected nodes take an unencoded raw value. */
export interface TargetWtLoginKnownNode {
    tag: 0x318 | 0x16a;
    kind: 'raw';
    bytes: Uint8Array;
}

export type TargetWtLoginNode = TargetWtLoginOpaqueNode | TargetWtLoginKnownNode;

function clear(value: Uint8Array | undefined): void {
    if (value) {
        try {
            fillBytes.call(value, 0);
        } catch {
            // Independently attempt to clear every private allocation.
        }
    }
}

function plainChain(value: object): void {
    let current: object | null = value;

    for (let depth = 0; current !== null; depth++) {
        if (depth >= 256 || isProxy(current)) {
            throw new TypeError();
        }

        current = getPrototype(current) as object | null;
    }
}

function ownData(value: object, key: PropertyKey): unknown {
    const field = descriptor(value, key);

    if (!field || !('value' in field)) {
        throw new TypeError();
    }

    return field.value;
}

function snapshot(value: unknown): Uint8Array {
    if (isProxy(value) || !isView(value) || typedTag.call(value) !== 'Uint8Array') {
        throw new TypeError();
    }

    plainChain(value);
    const backing = typedBuffer.call(value) as ArrayBuffer;
    bufferLength.call(backing); // Reject SharedArrayBuffer, including other realms.
    typedValues.call(value); // Reject detached or out-of-bounds views.
    const size = typedLength.call(value) as number;
    const offset = typedOffset.call(value) as number;

    if (size > MAX_OUTPUT) {
        throw new RangeError();
    }

    const copy = new U8(size);

    try {
        setBytes.call(copy, new U8(backing, offset, size));
        return copy;
    } catch (error) {
        clear(copy);
        throw error;
    }
}

/**
 * Produce only ordered node-writer outputs, with no header or count.
 *
 * Required and optional inputs represent separate already-constructed node
 * trees. A caller's `opaque` bytes are complete writer outputs for its stated
 * tag; this function cannot verify their format or association. The two known
 * tags 0x0318 and 0x016a instead require `raw` values and use their examined
 * standalone writers. Empty opaque output is accepted as a caller assertion.
 * Duplicates, unsupported tags, wrong tree/kind, accessors, proxies and unsafe
 * views are rejected by local policy. A 16 MiB aggregate cap is also local.
 *
 * This does not model tree construction, virtual dispatch, counts, errors or
 * exception behavior, QR success, signer, keys, authentication, transport or
 * registration. Caller inputs must remain stable during the call. Private byte
 * copies are wiped best effort; output is independently owned by the caller.
 */
export function encodeTargetWtLoginOrder(
    required: readonly TargetWtLoginOpaqueNode[],
    optional: readonly TargetWtLoginNode[],
): Uint8Array {
    const owned: Uint8Array[] = [];
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        const fragments = new Map<number, Uint8Array>();
        let total = 0;

        function collect(input: readonly TargetWtLoginNode[], allowed: readonly number[]): void {
            if (isProxy(input) || !Array.isArray(input)) {
                throw new TypeError();
            }

            plainChain(input);
            const count = ownData(input, 'length');

            if (typeof count !== 'number' || count > allowed.length) {
                throw new RangeError();
            }

            for (let index = 0; index < count; index++) {
                const item = ownData(input, String(index));

                if (typeof item !== 'object' || item === null || isProxy(item)) {
                    throw new TypeError();
                }

                plainChain(item);
                const nodeTag = ownData(item, 'tag');
                const kind = ownData(item, 'kind');
                const bytes = ownData(item, 'bytes');

                if (
                    typeof nodeTag !== 'number' ||
                    !Number.isInteger(nodeTag) ||
                    !allowed.includes(nodeTag) ||
                    fragments.has(nodeTag)
                ) {
                    throw new TypeError();
                }

                const known = nodeTag === 0x318 || nodeTag === 0x16a;

                if (kind !== (known ? 'raw' : 'opaque')) {
                    throw new TypeError();
                }

                const copy = snapshot(bytes);
                owned.push(copy);
                let fragment = copy;

                if (known) {
                    fragment =
                        nodeTag === 0x318
                            ? encodeTargetWtLoginNode0318(copy)
                            : encodeTargetWtLoginNode016a(copy);
                    owned.push(fragment);
                }

                total += fragment.length;

                if (total > MAX_OUTPUT) {
                    throw new RangeError();
                }

                fragments.set(nodeTag, fragment);
            }
        }

        collect(required, REQUIRED);

        for (const nodeTag of REQUIRED) {
            if (!fragments.has(nodeTag)) {
                throw new Error();
            }
        }

        collect(optional, OPTIONAL);
        output = new U8(total);
        let position = 0;

        for (const nodeTag of [...REQUIRED, ...OPTIONAL]) {
            const fragment = fragments.get(nodeTag);

            if (fragment) {
                setBytes.call(output, fragment, position);
                position += fragment.length;
            }
        }

        complete = true;
        return output;
    } catch {
        throw new Error('target WT login ordered encoding failed');
    } finally {
        for (const bytes of owned) {
            clear(bytes);
        }

        if (!complete) {
            clear(output);
        }
    }
}
