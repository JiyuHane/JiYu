import { isProxy } from 'node:util/types';
import { qqTeaEncrypt } from './qq-tea';
import {
    encodeTargetWtEncodeData,
    MAX_TARGET_WT_ENCODE_DATA_BYTES,
    MAX_TARGET_WT_ENCODE_DATA_COMPONENT_BYTES,
} from './target-wt-encode-data';

export interface TargetWtLocalData {
    ctxMode: number;
    ctx4: number;
    ctx5: number;
    field6: number;
    mode2Word: number | null;
    local16: Uint8Array;
    extra: Uint8Array;
    /** Required in encryption branches, ignored entirely in the empty branch. */
    plaintext?: Uint8Array;
    /** Required only when ctx5 != 0 and ctx4 == 0. */
    encryptionKey?: Uint8Array;
    /** Required in encryption branches: exactly p+3 caller-provided bytes. */
    paddingRandom?: Uint8Array;
}

const Bytes = Uint8Array;
const typed = Object.getPrototypeOf(Bytes.prototype) as object;
const tag = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const length = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const offset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const values = Bytes.prototype.values;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;
const getPrototype = Object.getPrototypeOf;
const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const isView = ArrayBuffer.isView;

type ByteSource = { backing: ArrayBuffer; start: number; size: number };

function chain(value: object): void {
    let current: object | null = value;

    for (let depth = 0; current !== null; depth++) {
        if (depth >= 256 || isProxy(current)) {
            throw new TypeError();
        }

        current = getPrototype(current) as object | null;
    }
}

function data(value: object, name: string): unknown {
    const descriptor = getOwnDescriptor(value, name);

    if (!descriptor || !hasOwn(descriptor, 'value')) {
        throw new TypeError();
    }

    return descriptor.value;
}

function uint(value: unknown, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
        throw new TypeError();
    }

    return value;
}

function inspect(value: unknown, maximum: number, exact?: number): ByteSource {
    if (isProxy(value) || !isView(value) || tag.call(value) !== 'Uint8Array') {
        throw new TypeError();
    }

    chain(value);
    const backing = buffer.call(value) as ArrayBuffer;
    arrayBufferLength.call(backing); // Exclude shared memory, including foreign realms.
    values.call(value); // Reject detached and out-of-bounds views.
    const size = length.call(value) as number;
    const start = offset.call(value) as number;

    if (size > maximum || (exact !== undefined && size !== exact)) {
        throw new RangeError();
    }

    return { backing, start, size };
}

function clear(value: Uint8Array | undefined): void {
    if (value) {
        try {
            fill.call(value, 0);
        } catch {
            // Each owned allocation gets its own best-effort cleanup attempt.
        }
    }
}

function snapshot(source: ByteSource): Uint8Array {
    const result = new Bytes(source.size);

    try {
        set.call(result, new Bytes(source.backing, source.start, source.size));
        return result;
    } catch (error) {
        clear(result);
        throw error;
    }
}

/**
 * Explicit offline composition candidate, not a live protocol encoder. The
 * same caller-provided random sequence models the statically observed block
 * structure, not the target's random source, runtime bytes, key choice, QR
 * branch or interoperability. No network, Hook, account or authentication is
 * involved. QQ-TEA is unauthenticated and its padding is not proof of validity.
 *
 * ctx5=0 uses local16 as the TEA key AND writes it into the returned bytes.
 * ctx5!=0 && ctx4=0 uses the separate caller key; both flags nonzero produce
 * an empty payload without accessing plaintext, encryptionKey or paddingRandom.
 * The target writes low 16-bit lengths; this local policy rejects oversized
 * components and output rather than truncating. Caller buffers stay owned by
 * the caller; returned bytes belong to the caller and include local16.
 *
 * Private snapshots and returned intermediate ciphertext are wiped best effort.
 * qqTeaEncrypt internally holds key words, padded plaintext and mixed blocks;
 * this wrapper has no access to them. JS/GC copies can remain, so this is not a
 * full-memory erasure or constant-time guarantee. Keep input views stable until
 * copied and do not send this experimental output to a real service.
 */
export function encodeTargetWtLocalDataCandidate(input: TargetWtLocalData): Uint8Array {
    let local: Uint8Array | undefined;
    let extra: Uint8Array | undefined;
    let plain: Uint8Array | undefined;
    let key: Uint8Array | undefined;
    let random: Uint8Array | undefined;
    let cipher: Uint8Array | undefined;

    try {
        if (typeof input !== 'object' || input === null || isProxy(input)) {
            throw new TypeError();
        }

        chain(input);
        const ctxMode = uint(data(input, 'ctxMode'), 0xffffffff);
        const ctx4 = uint(data(input, 'ctx4'), 0xff);
        const ctx5 = uint(data(input, 'ctx5'), 0xff);
        const field6 = uint(data(input, 'field6'), 0xff);
        const modeValue = data(input, 'mode2Word');
        const mode2Word = ctxMode === 2 ? uint(modeValue, 0xffff) : null;

        if (ctxMode !== 2 && modeValue !== null) {
            throw new TypeError();
        }

        const localSource = inspect(data(input, 'local16'), 16, 16);
        const extraSource = inspect(
            data(input, 'extra'),
            MAX_TARGET_WT_ENCODE_DATA_COMPONENT_BYTES,
        );
        const modeLength = ctxMode === 1 ? 2 : ctxMode === 2 ? 4 : 0;
        const baseLength = 20 + modeLength + extraSource.size;

        if (
            (ctx5 === 0 && extraSource.size !== 0) ||
            baseLength > MAX_TARGET_WT_ENCODE_DATA_BYTES
        ) {
            throw new RangeError();
        }

        const encrypt = ctx5 === 0 || ctx4 === 0;
        let plainSource: ByteSource | undefined;
        let keySource: ByteSource | undefined;
        let randomSource: ByteSource | undefined;
        let cipherLength = 0;

        if (encrypt) {
            // Bound before arithmetic, copying, encryption or reading randomness.
            plainSource = inspect(data(input, 'plaintext'), MAX_TARGET_WT_ENCODE_DATA_BYTES);
            cipherLength = 8 * Math.ceil((plainSource.size + 10) / 8);

            if (
                cipherLength > MAX_TARGET_WT_ENCODE_DATA_COMPONENT_BYTES ||
                baseLength + cipherLength > MAX_TARGET_WT_ENCODE_DATA_BYTES
            ) {
                throw new RangeError();
            }

            if (ctx5 !== 0) {
                keySource = inspect(data(input, 'encryptionKey'), 16, 16);
            }

            const padding = (8 - ((plainSource.size + 10) % 8)) % 8;
            randomSource = inspect(data(input, 'paddingRandom'), padding + 3, padding + 3);
        }

        local = snapshot(localSource);
        extra = snapshot(extraSource);

        if (encrypt) {
            plain = snapshot(plainSource!);
            key = keySource ? snapshot(keySource) : undefined;
            random = snapshot(randomSource!);
            const randomSnapshot = random;
            cipher = qqTeaEncrypt(plain, key ?? local, () => randomSnapshot);

            if (cipher.length !== cipherLength) {
                throw new Error();
            }
        } else {
            cipher = new Bytes(0);
        }

        return encodeTargetWtEncodeData({
            ctxMode,
            ctx4,
            ctx5,
            field6,
            mode2Word,
            local16: local,
            extra,
            payload: cipher,
        });
    } catch {
        throw new Error('target WT local data construction failed');
    } finally {
        clear(cipher);
        clear(random);
        clear(key);
        clear(plain);
        clear(extra);
        clear(local);
    }
}
