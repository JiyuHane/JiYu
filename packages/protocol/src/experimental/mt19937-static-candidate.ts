/**
 * Pure, restricted model of a static AArch64 instruction candidate.
 * This is not a signing implementation or an established QQ algorithm.
 * Inputs are caller-supplied synthetic values; no native code is executed.
 * The 32-bit domain and validation are model restrictions, not native checks.
 */
export interface Mt19937StaticCandidateState {
    readonly words: readonly number[];
    readonly index: number;
}

export interface Mt19937StaticCandidateStep {
    readonly state: Mt19937StaticCandidateState;
    readonly value: number;
}

const STATE_SIZE = 624;
const INVALID = 'invalid synthetic MT candidate state';

function isUint32(value: unknown): value is number {
    return (
        typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff
    );
}

function immutableState(words: number[], index: number): Mt19937StaticCandidateState {
    return Object.freeze({ words: Object.freeze(words), index });
}

/** Initialize 624 unsigned words from an explicitly supplied synthetic seed. */
export function initializeMt19937StaticCandidate(seed: number): Mt19937StaticCandidateState {
    if (!isUint32(seed)) {
        throw new Error(INVALID);
    }

    const words = new Array<number>(STATE_SIZE);
    words[0] = seed >>> 0;

    for (let index = 1; index < STATE_SIZE; index++) {
        const previous = words[index - 1];
        words[index] = (Math.imul(previous ^ (previous >>> 30), 0x6c078965) + index) >>> 0;
    }

    return immutableState(words, 0);
}

/**
 * Compute one candidate step. The returned plain array and enclosing objects
 * are frozen fresh copies; the caller's array is neither mutated nor retained.
 * The input must be a trusted ordinary object and array without getters or
 * proxies. Property and element access can execute caller code; this function
 * is not an in-process sandbox for untrusted values.
 */
export function stepMt19937StaticCandidate(
    state: Mt19937StaticCandidateState,
): Mt19937StaticCandidateStep {
    if (state === null || typeof state !== 'object') {
        throw new Error(INVALID);
    }

    const inputWords = state.words;
    const index = state.index;

    if (
        !Array.isArray(inputWords) ||
        inputWords.length !== STATE_SIZE ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= STATE_SIZE
    ) {
        throw new Error(INVALID);
    }

    const words = new Array<number>(STATE_SIZE);

    for (let position = 0; position < STATE_SIZE; position++) {
        const value: unknown = inputWords[position];

        if (!isUint32(value)) {
            throw new Error(INVALID);
        }

        words[position] = value >>> 0;
    }

    const next = (index + 1) % STATE_SIZE;
    const other = (index + 397) % STATE_SIZE;
    const combined = ((words[index] & 0x80000000) | (words[next] & 0x7ffffffe)) >>> 0;
    const updated =
        (words[other] ^ (combined >>> 1) ^ ((words[next] & 1) === 0 ? 0 : 0x9908b0df)) >>> 0;
    words[index] = updated;

    let value = (updated ^ (updated >>> 11)) >>> 0;
    value = (value ^ ((value << 7) & 0x9d2c5680)) >>> 0;
    value = (value ^ ((value << 15) & 0xefc60000)) >>> 0;
    value = (value ^ (value >>> 18)) >>> 0;

    return Object.freeze({ state: immutableState(words, next), value });
}
