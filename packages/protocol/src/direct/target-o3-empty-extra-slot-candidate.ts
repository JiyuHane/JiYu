import { isProxy, isUint8Array } from 'node:util/types';

const STRUCTURE_BYTES = 0x300;
const GLOBAL_BYTES = 160;
const GLOBAL_SLICE_OFFSET = 0x28;
const RAW_BYTES = 32;
const SLOT_OFFSET = 0x100;
const LENGTH_OFFSET = 0x1ff;
const WRAPPED_BYTES = 34;
const ERROR = 'target O3 empty extra slot candidate failed';

// Capture intrinsics without consulting properties, iterators, or species on inputs.
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

function sourceView(input: Uint8Array, length: number): Uint8Array {
    if (isProxy(input) || !isUint8Array(input)) {
        throw new TypeError();
    }

    apply(values, input, []); // Reject detached and out-of-bounds views.
    const buffer = apply(getBuffer, input, []) as ArrayBuffer;
    apply(getBufferLength, buffer, []); // Reject shared backing, including cross-realm SAB.
    const offset = apply(getOffset, input, []) as number;

    if ((apply(getLength, input, []) as number) !== length) {
        throw new TypeError();
    }

    return new Bytes(buffer, offset, length);
}

function clear(bytes: Uint8Array | undefined): void {
    if (bytes !== undefined) {
        try {
            apply(fill, bytes, [0]);
        } catch {
            // Every owned allocation receives a separate best-effort attempt.
        }
    }
}

/**
 * Offline model of one conditional O3 empty-body slot write, not a complete
 * signer. The caller asserts O3 dispatch, an empty body, the exact full-length
 * command match and both empty auxiliary fields; this function does not inspect
 * command or body or establish
 * branch reachability. A zero global state belongs to a different fallback and
 * is rejected here.
 *
 * Both inputs must be genuine, attached, in-bounds, nonshared Uint8Arrays of
 * the specified lengths and remain stable during their synchronous snapshots.
 * Subviews, Buffer instances, and aliased inputs are accepted. Intrinsics must
 * be intact at module import. The result has independent storage. All failures
 * use one input-free error; private snapshots and failed results are cleared
 * best effort, without a guarantee of complete memory erasure in JavaScript.
 */
export function placeTargetO3EmptyExtraSlotCandidate(
    output: Uint8Array,
    globalState: Uint8Array,
): Uint8Array {
    let outputSnapshot: Uint8Array | undefined;
    let globalSnapshot: Uint8Array | undefined;
    let result: Uint8Array | undefined;
    let complete = false;

    try {
        const outputSource = sourceView(output, STRUCTURE_BYTES);
        const globalSource = sourceView(globalState, GLOBAL_BYTES);

        outputSnapshot = new Bytes(STRUCTURE_BYTES);
        apply(set, outputSnapshot, [outputSource]);
        globalSnapshot = new Bytes(GLOBAL_BYTES);
        apply(set, globalSnapshot, [globalSource]);

        let nonzero = 0;

        for (let index = 0; index < GLOBAL_BYTES; index++) {
            nonzero |= globalSnapshot[index];
        }

        if (nonzero === 0) {
            throw new TypeError();
        }

        result = new Bytes(STRUCTURE_BYTES);
        apply(set, result, [outputSnapshot]);
        result[SLOT_OFFSET] = 0x0a;
        result[SLOT_OFFSET + 1] = 0x20;

        for (let index = 0; index < RAW_BYTES; index++) {
            result[SLOT_OFFSET + 2 + index] = globalSnapshot[GLOBAL_SLICE_OFFSET + index];
        }

        result[LENGTH_OFFSET] = WRAPPED_BYTES;
        complete = true;
        return result;
    } catch {
        throw new Error(ERROR);
    } finally {
        if (!complete) {
            clear(result);
        }

        clear(outputSnapshot);
        clear(globalSnapshot);
    }
}
