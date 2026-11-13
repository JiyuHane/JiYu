import { isProxy } from 'node:util/types';
import {
    encodeTargetQr31Tlv11,
    encodeTargetQr31Tlv16,
    encodeTargetQr31Tlv1b,
    encodeTargetQr31Tlv1d,
    encodeTargetQr31Tlv33,
    encodeTargetQr31Tlv35,
    encodeTargetQr31Tlv66,
} from './target-qr31-tlv';
import { encodeTargetQr31D1 } from './target-qr31-d1';
import { encodeTargetQr31Body } from './target-qr31-body';
import { encodeTargetQr31Frame } from './target-qr31-frame';
import { encodeTargetQr31ChannelWrapper } from './target-qr31-channel-wrapper';

export interface TargetQr31GetPictureInput {
    session0: number;
    session4: number;
    session28: number;
    sessionC8: bigint;
    session38: Uint8Array;
    session50: Uint8Array;
    session68: Uint8Array;
    session80Words: readonly number[];
    /** Opaque 16 bytes; identity semantics have not been established. */
    opaque16: Uint8Array;
    d1Second: Uint8Array;
    /** null omits 0x11; even a zero-length byte span includes it. */
    optional11: Uint8Array | null;
    channelEsi: number;
    channelEcx: number;
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
const keys = [
    'session0',
    'session4',
    'session28',
    'sessionC8',
    'session38',
    'session50',
    'session68',
    'session80Words',
    'opaque16',
    'd1Second',
    'optional11',
    'channelEsi',
    'channelEcx',
] as const;

function clear(value: Uint8Array | undefined): void {
    if (value) {
        try {
            fill.call(value, 0);
        } catch {
            /* Independently attempt each cleanup. */
        }
    }
}

function uint32(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new TypeError();
    }

    return value;
}

function data(value: object, name: PropertyKey): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);

    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError();
    }

    return descriptor.value;
}

function noAccessors(value: object): void {
    for (const name of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);

        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError();
        }
    }
}

function words(input: unknown): number[] {
    if (
        isProxy(input) ||
        !Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Array.prototype
    ) {
        throw new TypeError();
    }

    if (data(input, 'length') !== 7) {
        throw new TypeError();
    }

    noAccessors(input);

    const output: number[] = [];

    for (let i = 0; i < 7; i++) {
        output.push(uint32(data(input, String(i))));
    }

    return output;
}

function snapshot(input: unknown, owned: Uint8Array[], exact?: number): Uint8Array {
    if (isProxy(input) || !ArrayBuffer.isView(input) || tag.call(input) !== 'Uint8Array') {
        throw new TypeError();
    }

    let current: object | null = input;

    for (let depth = 0; current !== null; depth++) {
        if (depth >= 256 || isProxy(current)) {
            throw new TypeError();
        }

        current = Object.getPrototypeOf(current) as object | null;
    }

    const backing = buffer.call(input) as ArrayBuffer;
    arrayBufferLength.call(backing); // Reject SharedArrayBuffer, including foreign shared buffers.
    values.call(input); // Reject detached or out-of-bounds views.
    const size = length.call(input) as number;
    const start = offset.call(input) as number;

    if (size > 0xffff || (exact !== undefined && size !== exact)) {
        throw new RangeError();
    }

    noAccessors(input);
    const copy = new Bytes(size);
    owned.push(copy);
    set.call(copy, new Bytes(backing, start, size));
    return copy;
}

/**
 * Compose only the selected target-static get-picture construction through
 * an initially empty tree with unique, successfully encoded children. Inputs
 * are opaque caller values. No network, login, signing, server identity or
 * peer compatibility is implied. Returned bytes belong to the caller.
 * Private buffers are cleared best effort; Proton, GC and engine copies may persist.
 */
export function encodeTargetQr31GetPicture(input: TargetQr31GetPictureInput): Uint8Array {
    const owned: Uint8Array[] = [];
    let wordSnapshot: number[] | undefined;
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        if (typeof input !== 'object' || input === null || isProxy(input)) {
            throw new TypeError();
        }

        const prototype = Object.getPrototypeOf(input);

        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError();
        }

        noAccessors(input);
        const own = Reflect.ownKeys(input);

        if (own.length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) {
            throw new TypeError();
        }

        // Every caller value is read as an own data descriptor before sub-encoder calls.
        const session0 = uint32(data(input, 'session0'));
        const session4 = uint32(data(input, 'session4'));
        const session28 = uint32(data(input, 'session28'));
        const sessionC8 = data(input, 'sessionC8');

        if (typeof sessionC8 !== 'bigint' || sessionC8 < 0n || sessionC8 > 0xffffffffffffffffn) {
            throw new TypeError();
        }

        const channelEsi = uint32(data(input, 'channelEsi'));
        const channelEcx = uint32(data(input, 'channelEcx'));
        const session80Words = words(data(input, 'session80Words'));
        wordSnapshot = session80Words;
        const session38 = snapshot(data(input, 'session38'), owned);
        const session50 = snapshot(data(input, 'session50'), owned);
        const session68 = snapshot(data(input, 'session68'), owned);
        const opaque16 = snapshot(data(input, 'opaque16'), owned, 16);
        const d1Second = snapshot(data(input, 'd1Second'), owned);
        const optionalValue = data(input, 'optional11');
        const optional11 = optionalValue === null ? null : snapshot(optionalValue, owned);
        // Distinct owned copies prevent downstream aliases, including repeated session+0x50.
        const field30 = snapshot(session50, owned);
        const field60 = snapshot(session50, owned);

        const child = (bytes: Uint8Array): Uint8Array => {
            try {
                owned.push(bytes);
            } catch (error) {
                clear(bytes);
                throw error;
            }

            return bytes;
        };

        const children: Uint8Array[] = [];

        if (optional11 !== null) {
            children.push(child(encodeTargetQr31Tlv11(optional11)));
        }

        children.push(
            child(
                encodeTargetQr31Tlv16({
                    field0c: 0,
                    field10: session0,
                    field14: session4,
                    vector: opaque16,
                    field30,
                    field48: session38,
                    field60,
                }),
            ),
        );
        children.push(child(encodeTargetQr31Tlv1b({ words: session80Words, x: new Bytes() })));
        children.push(
            child(encodeTargetQr31Tlv1d({ field0a: 0, field0c: 0x7ffc, field10: 0, values: [] })),
        );
        children.push(child(encodeTargetQr31Tlv33(opaque16)));
        children.push(child(encodeTargetQr31Tlv35(session28)));
        children.push(child(encodeTargetQr31Tlv66(session28)));
        children.push(child(encodeTargetQr31D1({ field1: session68, field2: d1Second })));
        const body = child(
            encodeTargetQr31Body({
                field38: new Bytes(),
                field50: session0,
                field30: sessionC8,
                field54: 0,
                field58: new Bytes(),
                field80: children.length,
                children,
            }),
        );
        const inner = child(encodeTargetQr31Frame(body));
        output = encodeTargetQr31ChannelWrapper({
            inner,
            fieldEsi: channelEsi,
            fieldEcx: channelEcx,
        });
        complete = true;
        return output;
    } catch {
        throw new Error('target QR31 get-picture construction failed');
    } finally {
        if (wordSnapshot) {
            try {
                Array.prototype.fill.call(wordSnapshot, 0);
            } catch {
                /* Best effort. */
            }
        }

        for (const item of owned) {
            clear(item);
        }

        if (!complete) {
            clear(output);
        }
    }
}
