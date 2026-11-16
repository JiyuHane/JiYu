import { isProxy, isUint8Array } from 'node:util/types';

// These are local input/work bounds, not limits inferred for the target.
const MAX_COMMAND_BYTES = 4096;
const GLOBAL_BLOCK_BYTES = 160;
const SLICE_START = 0x28;
const SLICE_BYTES = 32;
const INPUT_ERROR = 'invalid empty-body global-slice candidate input';

// Capture intrinsics once. Input properties, iterators, constructors, species
// and prototype chains are never consulted to read or copy the byte views.
const Bytes = Uint8Array;
const apply = Reflect.apply;
const safeInteger = Number.isSafeInteger;
const typedPrototype = Object.getPrototypeOf(Bytes.prototype) as object;
const bufferGetter = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset')!.get!;
const lengthGetter = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const typedValues = Bytes.prototype.values;
const typedSet = Bytes.prototype.set;
const typedFill = Bytes.prototype.fill;

interface ByteView {
    readonly buffer: ArrayBuffer;
    readonly offset: number;
    readonly length: number;
}

function inspect(value: unknown, maximum: number, exact?: number): ByteView {
    if (isProxy(value) || !isUint8Array(value)) {
        throw new TypeError();
    }

    // Values rejects detached and out-of-bounds views, even when their apparent
    // byte length is zero. The ArrayBuffer intrinsic rejects shared memory.
    apply(typedValues, value, []);
    const length = apply(lengthGetter, value, []) as number;

    if (length > maximum || (exact !== undefined && length !== exact)) {
        throw new TypeError();
    }

    const buffer = apply(bufferGetter, value, []) as ArrayBuffer;
    apply(arrayBufferLength, buffer, []);
    const offset = apply(offsetGetter, value, []) as number;
    return { buffer, offset, length };
}

function snapshot(view: ByteView): Uint8Array {
    const result = new Bytes(view.length);
    apply(typedSet, result, [new Bytes(view.buffer, view.offset, view.length)]);
    return result;
}

function clear(value: Uint8Array | undefined): void {
    if (value) {
        try {
            apply(typedFill, value, [0]);
        } catch {
            // Each independent owned snapshot still gets a cleanup attempt.
        }
    }
}

/**
 * A narrowly conditional, offline candidate for one branch of helper 0x6be3c6c
 * in the supplier-identified ELF (SHA-256 prefix dc5209). This is not the full
 * helper or a signature algorithm. No upstream command reachability is implied:
 * some upstream paths use strlen, whereas this models the supplied bytes with
 * memcmp semantics, including NUL and an empty command.
 *
 * Equal byte strings, zero body length and any nonzero byte in the supplied
 * 160-byte block yield a fresh copy of block offsets 0x28 through 0x47 inclusive.
 * Every other valid case is unresolved and yields null. Invalid inputs throw
 * one fixed error; input getters, including custom accessors, are never called.
 */
export function targetEmptyBodyGlobalSliceCandidate(
    command: Uint8Array,
    expected: Uint8Array,
    bodyLength: number,
    block: Uint8Array,
): Uint8Array | null {
    let commandCopy: Uint8Array | undefined;
    let expectedCopy: Uint8Array | undefined;
    let blockCopy: Uint8Array | undefined;

    try {
        if (typeof bodyLength !== 'number' || !safeInteger(bodyLength) || bodyLength < 0) {
            throw new TypeError();
        }

        // Validate all arguments, including on branches that will return null.
        const commandView = inspect(command, MAX_COMMAND_BYTES);
        const expectedView = inspect(expected, MAX_COMMAND_BYTES);
        const blockView = inspect(block, GLOBAL_BLOCK_BYTES, GLOBAL_BLOCK_BYTES);
        commandCopy = snapshot(commandView);
        expectedCopy = snapshot(expectedView);
        blockCopy = snapshot(blockView);

        if (bodyLength !== 0 || commandView.length !== expectedView.length) {
            return null;
        }

        for (let index = 0; index < commandView.length; index++) {
            if (commandCopy[index] !== expectedCopy[index]) {
                return null;
            }
        }

        let nonzero = false;

        for (let index = 0; index < GLOBAL_BLOCK_BYTES; index++) {
            if (blockCopy[index] !== 0) {
                nonzero = true;
                break;
            }
        }

        if (!nonzero) {
            return null;
        }

        const result = new Bytes(SLICE_BYTES);

        for (let index = 0; index < SLICE_BYTES; index++) {
            result[index] = blockCopy[SLICE_START + index];
        }

        return result;
    } catch {
        throw new TypeError(INPUT_ERROR);
    } finally {
        clear(commandCopy);
        clear(expectedCopy);
        clear(blockCopy);
    }
}
