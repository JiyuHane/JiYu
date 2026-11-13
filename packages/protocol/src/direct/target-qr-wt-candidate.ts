import { isProxy } from 'node:util/types';
import { encodeTargetWtLocalDataCandidate } from './target-wt-local-data';
import { MAX_TARGET_WT_ENCODE_DATA_BYTES } from './target-wt-encode-data';
import { encodeTargetWtOicq, MAX_TARGET_WT_OICQ_BYTES } from './target-wt-oicq';

export interface TargetQrWtCandidateInput {
    channel: Uint8Array;
    key: Uint8Array;
    extra: Uint8Array;
    local16: Uint8Array;
    paddingRandom: Uint8Array;
    version: number;
    sequence: number;
    clientType: number;
    pubno: number;
}

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
const getDescriptor = Object.getOwnPropertyDescriptor;
const ownKeys = Reflect.ownKeys;
const hasOwn = Object.hasOwn;
const isView = ArrayBuffer.isView;

type Source = { backing: ArrayBuffer; start: number; size: number };

function chain(value: object): void {
    let current: object | null = value;

    for (let depth = 0; current !== null; depth++) {
        if (depth >= 256 || isProxy(current)) {
            throw new TypeError();
        }

        current = getPrototype(current) as object | null;
    }
}

function noAccessors(value: object): void {
    for (const name of ownKeys(value)) {
        const descriptor = getDescriptor(value, name);

        if (!descriptor || !hasOwn(descriptor, 'value')) {
            throw new TypeError();
        }
    }
}

function data(value: object, name: string): unknown {
    const descriptor = getDescriptor(value, name);

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

function inspect(value: unknown, max: number, exact?: number): Source {
    if (isProxy(value) || !isView(value) || tag.call(value) !== 'Uint8Array') {
        throw new TypeError();
    }

    chain(value);
    const backing = buffer.call(value) as ArrayBuffer;
    bufferLength.call(backing); // Reject SharedArrayBuffer, including foreign shared memory.
    values.call(value); // Reject detached and out-of-bounds views.
    const size = length.call(value) as number;
    const start = offset.call(value) as number;

    if (size > max || (exact !== undefined && size !== exact)) {
        throw new RangeError();
    }

    noAccessors(value);
    return { backing, start, size };
}

function clear(value: Uint8Array | undefined): void {
    if (value) {
        try {
            fill.call(value, 0);
        } catch {
            // Independently attempt each owned buffer.
        }
    }
}

function snapshot(source: Source): Uint8Array {
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
 * Offline, conditional target QR-to-OICQ candidate for the observed empty-cache,
 * normal factory/self-binding and successful weak-reference promotion path.
 * The explicitly supplied key is a candidate, not an established derivation;
 * initializer fallback and other cache paths remain unknown. The target static
 * sender parameters describe this condition, not every QR request. No network,
 * account, Hook, clock, key selection, signature or authentication is performed.
 * The returned OICQ is not an SSO service frame and does not prove QR success or
 * peer interoperability. Do not send these experimental bytes to a real service.
 *
 * QQ-TEA is unauthenticated; valid padding does not prove authenticity. Each
 * input is snapshotted before either composition call, and must remain stable
 * until copied. Local limits reject lengths instead of the target's low-16-bit
 * truncation. The output contains caller local16 and belongs to the caller.
 * Private snapshots and intermediate output are independently cleared best effort.
 * qqTeaEncrypt retains inaccessible key words, padded plaintext and mixed blocks;
 * engine, GC and other copies can remain, so no full-memory wipe is guaranteed.
 */
export function encodeTargetQrWtCandidate(input: TargetQrWtCandidateInput): Uint8Array {
    let channel: Uint8Array | undefined;
    let key: Uint8Array | undefined;
    let extra: Uint8Array | undefined;
    let local16: Uint8Array | undefined;
    let random: Uint8Array | undefined;
    let opaque: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        if (typeof input !== 'object' || input === null || isProxy(input)) {
            throw new TypeError();
        }

        chain(input);
        noAccessors(input);
        const version = uint(data(input, 'version'), 0xffff);
        const sequence = uint(data(input, 'sequence'), 0xffff);
        const clientType = uint(data(input, 'clientType'), 0xffff);
        const pubno = uint(data(input, 'pubno'), 0xffffffff);
        const channelSource = inspect(data(input, 'channel'), MAX_TARGET_WT_ENCODE_DATA_BYTES);
        const keySource = inspect(data(input, 'key'), 16, 16);
        const extraSource = inspect(data(input, 'extra'), 0xffff);
        const localSource = inspect(data(input, 'local16'), 16, 16);
        const cipherLength = 8 * Math.ceil((channelSource.size + 10) / 8);
        const opaqueLength = 22 + extraSource.size + cipherLength;
        const totalLength = 29 + opaqueLength;

        if (
            cipherLength > 0xffff ||
            opaqueLength > MAX_TARGET_WT_ENCODE_DATA_BYTES ||
            totalLength > MAX_TARGET_WT_OICQ_BYTES
        ) {
            throw new RangeError();
        }

        const padding = (8 - ((channelSource.size + 10) % 8)) % 8;
        const randomSource = inspect(data(input, 'paddingRandom'), padding + 3, padding + 3);
        channel = snapshot(channelSource);
        key = snapshot(keySource);
        extra = snapshot(extraSource);
        local16 = snapshot(localSource);
        random = snapshot(randomSource);
        opaque = encodeTargetWtLocalDataCandidate({
            ctxMode: 1,
            ctx4: 0,
            ctx5: 1,
            field6: 1,
            mode2Word: null,
            local16,
            extra,
            plaintext: channel,
            encryptionKey: key,
            paddingRandom: random,
        });

        if (opaque.length !== opaqueLength) {
            throw new Error();
        }

        output = encodeTargetWtOicq({
            version,
            command: 0x812,
            sequence,
            uin: 0,
            clientType,
            pubno,
            opaque,
        });

        if (output.length !== totalLength) {
            throw new Error();
        }

        complete = true;
        return output;
    } catch {
        throw new Error('target QR WT candidate construction failed');
    } finally {
        if (!complete) {
            clear(output);
        }

        clear(opaque);
        clear(random);
        clear(local16);
        clear(extra);
        clear(key);
        clear(channel);
    }
}
