import { isProxy, isUint8Array } from 'node:util/types';

// These are local model and work bounds, not limits established for the target.
const SLICE_BYTES = 32;
const OUTPUT_WORDS = 8;
const STATE_WORDS = 624;
const PERIOD_OFFSET = 397;
const INITIAL_MULTIPLIER = 1812433253;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;
const MATRIX_A = 0x9908b0df;
const INPUT_ERROR = 'invalid seeded MT slice-mix candidate input';
const INTERNAL_ERROR = 'seeded MT slice-mix candidate failed';

// Capture the intrinsics used after import. In particular, no input property,
// iterator, constructor, species or prototype chain is used to copy the view.
const Bytes = Uint8Array;
const Words = Uint32Array;
const InputTypeError = TypeError;
const InternalError = Error;
const inspectProxy = isProxy;
const inspectUint8Array = isUint8Array;
const apply = Reflect.apply;
const isInteger = Number.isInteger;
const imul = Math.imul;
const typedPrototype = Object.getPrototypeOf(Bytes.prototype) as object;
const bufferGetter = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset')!.get!;
const lengthGetter = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'resizable',
)?.get;
const typedValues = Bytes.prototype.values;
const typedSet = Bytes.prototype.set;
const typedFill = Bytes.prototype.fill;

interface ByteView {
    readonly buffer: ArrayBuffer;
    readonly offset: number;
}

function inspectInitial(value: unknown): ByteView {
    if (inspectProxy(value) || !inspectUint8Array(value)) {
        throw new InputTypeError();
    }

    // The captured builtin validates the view, including detached and
    // out-of-bounds views; it does not invoke the input's iterator property.
    apply(typedValues, value, []);
    const length = apply(lengthGetter, value, []) as number;

    if (length !== SLICE_BYTES) {
        throw new InputTypeError();
    }

    const buffer = apply(bufferGetter, value, []) as ArrayBuffer;
    // This intrinsic accepts ArrayBuffer but rejects SharedArrayBuffer. A
    // resizable backing buffer is also rejected as a conservative local rule.
    apply(arrayBufferLength, buffer, []);

    if (arrayBufferResizable !== undefined && apply(arrayBufferResizable, buffer, [])) {
        throw new InputTypeError();
    }

    const offset = apply(offsetGetter, value, []) as number;
    return { buffer, offset };
}

function generateWords(state: Uint32Array, seed: number, output: Uint32Array): void {
    state[0] = seed;

    for (let index = 1; index < STATE_WORDS; index++) {
        const previous = state[index - 1];
        state[index] = (imul(INITIAL_MULTIPLIER, previous ^ (previous >>> 30)) + index) >>> 0;
    }

    // The reference twist is in place: the wrapped positions intentionally
    // read words already updated during this same pass.
    for (let index = 0; index < STATE_WORDS; index++) {
        const joined =
            (state[index] & UPPER_MASK) | (state[(index + 1) % STATE_WORDS] & LOWER_MASK);
        const oddMatrix = (joined & 1) === 0 ? 0 : MATRIX_A;
        state[index] =
            (state[(index + PERIOD_OFFSET) % STATE_WORDS] ^ (joined >>> 1) ^ oddMatrix) >>> 0;
    }

    for (let index = 0; index < OUTPUT_WORDS; index++) {
        let word = state[index];
        word ^= word >>> 11;
        word ^= (word << 7) & 0x9d2c5680;
        word ^= (word << 15) & 0xefc60000;
        word ^= word >>> 18;
        output[index] = word >>> 0;
    }
}

function clear(value: Uint8Array | Uint32Array | undefined): void {
    if (value !== undefined) {
        try {
            apply(typedFill, value, [0]);
        } catch {
            // Attempt to clear each other owned buffer independently.
        }
    }
}

/**
 * An independent, bounded, synchronous and pure candidate for a finite slice
 * mix, not a signer or the complete helper. This is not connected to the
 * existing return candidate, production code or a signer.
 *
 * This hypothetical model requires the strict target branch, each supplied
 * seed matching the low 32 bits of its respective candidate call, the supplied
 * initial bytes representing G[0x28:0x48] after the random-word writes and before
 * the XOR, successful allocations for both candidate buffers, and no interfering
 * writes, destructive aliasing or later overwrites. It additionally requires the
 * P, random-word, Q and XOR states identified in static instruction windows to
 * run in that order and their MT output to match the supplied seeded streams.
 * Only under these conditions does it simulate that finite candidate path. The
 * initial bytes are caller input to the model, not a copy or assertion of real G.
 * The AArch64 static MT19937 candidate belongs to a different evidence domain;
 * its observations are not combined with or validated by this model. No runtime
 * reachability, real clock tick/inputs, signature or QQ interoperability is
 * established.
 *
 * Each independently seeded stream emits its first eight tempered uint32 words,
 * expanded low byte first. Their 32 bytes are XORed into a private snapshot of
 * initial, and the result has fresh storage. A statically traced target-loop
 * path makes a ninth call after the eighth output word; this model
 * returns no engine state and makes no claim about preserving the next random
 * word. The caller chooses all seeds and clock/random sources; this function
 * reads none itself.
 *
 * Seeds must be primitive integral numbers in [0, 0xffffffff]; -0 is accepted
 * and normalized to +0. Equal seeds are valid and create separate identical
 * streams. Initial must be a genuine, non-Proxy, non-shared, attached and
 * in-bounds 32-byte Uint8Array. Resizable ArrayBuffer backing is rejected even
 * when the view is in bounds, as a conservative local rule. Invalid inputs throw
 * a fixed TypeError. Missing resize-detection support or a later internal failure
 * throws a separate fixed Error; neither error exposes supplied values.
 * Owned snapshots, states and temporary words are cleared on a best-effort
 * basis; JavaScript does not guarantee complete memory erasure. Caller storage
 * is never cleared or modified. This assumes native intrinsics were intact at
 * module import and does not isolate arbitrary code or native memory changes.
 */
export function targetSeededMtSliceMixCandidate(
    initial: Uint8Array,
    pSeed: number,
    qSeed: number,
): Uint8Array {
    let initialCopy: Uint8Array | undefined;
    let pState: Uint32Array | undefined;
    let qState: Uint32Array | undefined;
    let pWords: Uint32Array | undefined;
    let qWords: Uint32Array | undefined;
    let result: Uint8Array | undefined;
    let validated = false;
    let delivered = false;

    // Without this intrinsic we cannot distinguish fixed and resizable backing
    // stores; the latter are outside this candidate's local input contract.
    if (arrayBufferResizable === undefined) {
        throw new InternalError(INTERNAL_ERROR);
    }

    try {
        if (
            typeof pSeed !== 'number' ||
            !isInteger(pSeed) ||
            pSeed < 0 ||
            pSeed > 0xffffffff ||
            typeof qSeed !== 'number' ||
            !isInteger(qSeed) ||
            qSeed < 0 ||
            qSeed > 0xffffffff
        ) {
            throw new InputTypeError();
        }

        const view = inspectInitial(initial);
        validated = true;
        initialCopy = new Bytes(SLICE_BYTES);
        apply(typedSet, initialCopy, [new Bytes(view.buffer, view.offset, SLICE_BYTES)]);
        pState = new Words(STATE_WORDS);
        qState = new Words(STATE_WORDS);
        pWords = new Words(OUTPUT_WORDS);
        qWords = new Words(OUTPUT_WORDS);

        // Unsigned conversion preserves every accepted bit pattern and turns
        // -0 into +0 without invoking user-defined coercion.
        generateWords(pState, pSeed >>> 0, pWords);
        generateWords(qState, qSeed >>> 0, qWords);

        result = new Bytes(SLICE_BYTES);

        for (let wordIndex = 0; wordIndex < OUTPUT_WORDS; wordIndex++) {
            for (let byteIndex = 0; byteIndex < 4; byteIndex++) {
                const index = wordIndex * 4 + byteIndex;
                const shift = byteIndex * 8;
                result[index] =
                    initialCopy[index] ^
                    ((pWords[wordIndex] >>> shift) & 0xff) ^
                    ((qWords[wordIndex] >>> shift) & 0xff);
            }
        }

        delivered = true;
        return result;
    } catch {
        throw validated ? new InternalError(INTERNAL_ERROR) : new InputTypeError(INPUT_ERROR);
    } finally {
        if (!delivered) {
            clear(result);
        }

        clear(initialCopy);
        clear(pState);
        clear(qState);
        clear(pWords);
        clear(qWords);
    }
}
