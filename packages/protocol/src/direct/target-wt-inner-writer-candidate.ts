import { isProxy } from 'node:util/types';

/** Local output limit, including the two-byte count; not a target limit. */
export const MAX_TARGET_WT_INNER_WRITER_BYTES = 16 * 1024 * 1024;

const Bytes = Uint8Array;
const typed = Object.getPrototypeOf(Bytes.prototype) as object;
const tag = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const length = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const offset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const values = Bytes.prototype.values;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;
const getPrototype = Object.getPrototypeOf;
const isView = ArrayBuffer.isView;

function clear(bytes: Uint8Array | undefined): void {
    if (bytes !== undefined) {
        try {
            fill.call(bytes, 0);
        } catch {
            // Independently attempt to clear every private allocation.
        }
    }
}

/**
 * Offline candidate for the four-writer sequence described at 0x3469090 and
 * 0x3468660. Each argument is an entire opaque caller-asserted writer output;
 * this function neither executes a writer nor validates tags or node formats.
 * The count is writer invocations, not a verified count of encoded TLVs.
 * Empty fragments are a local simulation policy. Successful target calls,
 * selected nodes, runtime reachability and all business semantics remain unknown.
 *
 * The 16 MiB aggregate cap, snapshotting, unsafe-view rejection and bounded
 * prototype traversal are local policies. Callers must keep inputs stable until
 * snapshotted and supply honest opaque fragments. The result is independent of
 * the inputs. Private copies and failed output are cleared best effort; runtime
 * and caller copies may remain. No encryption, signing, send or login occurs.
 */
export function encodeTargetWtInnerWriterCandidate(
    first: Uint8Array,
    second: Uint8Array,
    third: Uint8Array,
    fourth: Uint8Array,
): Uint8Array {
    const snapshots: Uint8Array[] = [];
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        let total = 2;

        for (const input of [first, second, third, fourth]) {
            if (isProxy(input) || !isView(input) || tag.call(input) !== 'Uint8Array') {
                throw new TypeError();
            }

            let current: object | null = input;

            for (let depth = 0; current !== null; depth++) {
                if (depth >= 256 || isProxy(current)) {
                    throw new TypeError();
                }

                current = getPrototype(current) as object | null;
            }

            const backing = buffer.call(input) as ArrayBuffer;
            bufferLength.call(backing); // Reject shared backing, including other realms.
            values.call(input); // Reject detached and out-of-bounds views.
            const size = length.call(input) as number;
            const start = offset.call(input) as number;

            if (size > MAX_TARGET_WT_INNER_WRITER_BYTES - total) {
                throw new RangeError();
            }

            total += size;
            const copy = new Bytes(size);
            snapshots.push(copy);
            set.call(copy, new Bytes(backing, start, size));
        }

        output = new Bytes(total);
        output[0] = 0;
        output[1] = 4;
        let cursor = 2;

        for (const copy of snapshots) {
            set.call(output, copy, cursor);
            cursor += copy.length;
        }

        complete = true;
        return output;
    } catch {
        throw new Error('target WT inner writer candidate failed');
    } finally {
        for (const copy of snapshots) {
            clear(copy);
        }

        if (!complete) {
            clear(output);
        }
    }
}
