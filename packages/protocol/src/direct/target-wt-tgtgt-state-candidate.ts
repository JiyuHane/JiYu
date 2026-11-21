import { isProxy, isUint8Array } from 'node:util/types';

export interface TargetWtTgtgtStateCandidate {
    field00: number;
    field14: number;
    field18: number;
    field19: number;
    field50: bigint;
    derivationWord: bigint;
    tail38: Uint8Array;
}

const Bytes = Uint8Array;
const typed = Object.getPrototypeOf(Bytes.prototype) as object;
const getBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const getLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const getBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const getPrototype = Object.getPrototypeOf;
const values = Bytes.prototype.values;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;

/**
 * Offline candidate for the static branch path at 0x34ff681–0x34ff78b,
 * assuming stable receiver fields and successful string helper and logging.
 * Non-state-1 branches use the observed empty target constant. The 65535-byte
 * input limit and uniform error are local policies; no meaning of the states
 * or live login behavior is inferred here.
 * Inputs must remain stable during the call and intrinsics must be trusted.
 * Caller-owned input and successful output are never cleared; an incomplete
 * private snapshot is cleared best effort, subject to runtime copies and GC.
 */
export function selectTargetWtTgtgtStateCandidate(
    state: number,
    base: bigint,
    alternate: bigint,
    stateOneTail: Uint8Array,
): TargetWtTgtgtStateCandidate {
    let tail: Uint8Array | undefined;
    let complete = false;

    try {
        if (
            typeof state !== 'number' ||
            !Number.isInteger(state) ||
            state < 0 ||
            state > 0xffffffff ||
            typeof base !== 'bigint' ||
            base < 0n ||
            base > 0xffffffffffffffffn ||
            typeof alternate !== 'bigint' ||
            alternate < 0n ||
            alternate > 0xffffffffffffffffn ||
            isProxy(stateOneTail) ||
            !isUint8Array(stateOneTail)
        ) {
            throw new TypeError();
        }

        let current: object | null = stateOneTail;

        for (let depth = 0; current !== null; depth++) {
            if (depth >= 256 || isProxy(current)) {
                throw new TypeError();
            }

            current = getPrototype(current) as object | null;
        }

        values.call(stateOneTail); // Reject detached and out-of-bounds views, including empty views.
        const backing = getBuffer.call(stateOneTail) as ArrayBuffer;
        const backingSize = getBufferLength.call(backing) as number; // Reject shared backing.
        const size = getLength.call(stateOneTail) as number;
        const start = getOffset.call(stateOneTail) as number;

        if (size > 0xffff || start + size > backingSize) {
            throw new RangeError();
        }

        tail = new Bytes(state === 1 ? size : 0);

        if (state === 1) {
            set.call(tail, new Bytes(backing, start, size));
        }

        const result: TargetWtTgtgtStateCandidate = {
            field00: state === 2 ? 3 : 1,
            field14: 0,
            field18: 1,
            field19: 1,
            field50: state === 0 ? base : state === 1 ? (alternate !== 0n ? alternate : base) : 0n,
            derivationWord: state === 0 ? base : state === 1 ? alternate : 0n,
            tail38: tail,
        };
        complete = true;
        return result;
    } catch {
        throw new Error('target WT tgtgt state candidate failed');
    } finally {
        if (!complete && tail) {
            try {
                fill.call(tail, 0);
            } catch {
                // An incomplete private allocation receives a best-effort wipe.
            }
        }
    }
}
