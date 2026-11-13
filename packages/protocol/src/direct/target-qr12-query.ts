import { isProxy } from 'node:util/types';
import { encodeTargetQr12QueryBody } from './target-qr12-body';
import { encodeTargetQr12Frame } from './target-qr12-frame';
import { encodeTargetQr31ChannelWrapper } from './target-qr31-channel-wrapper';

/** Local cross-layer bound imposed by the selected wrapper's 16-bit length. */
export const MAX_TARGET_QR12_QUERY_BLOB_BYTES = 65466;

export interface TargetQr12QueryInput {
    session138: number;
    session110: bigint;
    session1c0: Uint8Array;
    /** Caller-supplied opaque runtime word; no clock is read here. */
    clockWord: number;
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
const isView = ArrayBuffer.isView;

function clear(value: Uint8Array | undefined): void {
    if (value) {
        try {
            fill.call(value, 0);
        } catch {
            // Each private buffer gets a separate best-effort cleanup attempt.
        }
    }
}

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
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError();
        }
    }
}

function data(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError();
    }

    return descriptor.value;
}

function uint32(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new TypeError();
    }

    return value;
}

/**
 * Compose only the selected target-static QR12 query body, frame and channel
 * wrapper. The caller supplies stable opaque inputs through snapshotting; no
 * system clock is consulted. This performs no network, login, signing, identity
 * or authentication checks and does not establish server interoperability.
 * Private allocations are cleared best effort; runtime or GC copies may persist.
 * The returned output belongs to the caller.
 */
export function encodeTargetQr12Query(input: TargetQr12QueryInput): Uint8Array {
    let snapshot: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    const owned: Uint8Array[] = [];
    let complete = false;

    const retain = (bytes: Uint8Array): Uint8Array => {
        try {
            owned.push(bytes);
        } catch (error) {
            clear(bytes);
            throw error;
        }

        return bytes;
    };

    try {
        if (typeof input !== 'object' || input === null || isProxy(input)) {
            throw new TypeError();
        }

        chain(input);
        noAccessors(input);
        const session138 = uint32(data(input, 'session138'));
        const session110 = data(input, 'session110');
        const clockWord = uint32(data(input, 'clockWord'));
        const blob = data(input, 'session1c0');

        if (typeof session110 !== 'bigint' || session110 < 0n || session110 > 0xffffffffffffffffn) {
            throw new TypeError();
        }

        if (isProxy(blob) || !isView(blob) || tag.call(blob) !== 'Uint8Array') {
            throw new TypeError();
        }

        chain(blob);
        const backing = buffer.call(blob) as ArrayBuffer;
        bufferLength.call(backing);
        values.call(blob);
        const size = length.call(blob) as number;
        const start = offset.call(blob) as number;

        if (size > MAX_TARGET_QR12_QUERY_BLOB_BYTES) {
            throw new RangeError();
        }

        noAccessors(blob);
        snapshot = new Bytes(size);
        set.call(snapshot, new Bytes(backing, start, size));

        const body = retain(
            encodeTargetQr12QueryBody({
                field50: session138,
                field30: session110,
                field58: snapshot,
            }),
        );
        const frame = retain(encodeTargetQr12Frame(body));
        output = encodeTargetQr31ChannelWrapper({
            inner: frame,
            fieldEsi: session138,
            fieldEcx: clockWord,
        });
        complete = true;
        return output;
    } catch {
        throw new Error('target QR12 query construction failed');
    } finally {
        clear(snapshot);

        for (const item of owned) {
            clear(item);
        }

        if (!complete) {
            clear(output);
        }
    }
}
