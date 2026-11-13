import { isProxy } from 'node:util/types';

/** Local limits for subsequent OICQ composition; not native rejection rules. */
export const MAX_TARGET_WT_ENCODE_DATA_BYTES = 65506;
export const MAX_TARGET_WT_ENCODE_DATA_COMPONENT_BYTES = 65535;

export interface TargetWtEncodeData {
    ctxMode: number;
    ctx4: number;
    ctx5: number;
    field6: number;
    local16: Uint8Array;
    /** Explicit word only for mode 2; caller may supply 1 for its own null case. */
    mode2Word: number | null;
    extra: Uint8Array;
    /** Precomputed opaque output for the selected target branch, never encrypted here. */
    payload: Uint8Array;
}

const Bytes = Uint8Array;
const View = DataView;
const typed = Object.getPrototypeOf(Bytes.prototype) as object;
const tag = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const length = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const offset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const values = Bytes.prototype.values;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;

function clear(bytes: Uint8Array | undefined): void {
    if (bytes) {
        try {
            fill.call(bytes, 0);
        } catch {
            /* Independently best-effort cleanup. */
        }
    }
}

function chain(value: object): void {
    let current: object | null = value;

    for (let depth = 0; current !== null; depth++) {
        if (depth >= 256 || isProxy(current)) {
            throw new TypeError();
        }

        current = Object.getPrototypeOf(current) as object | null;
    }
}

function data(value: object, name: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);

    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
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

/**
 * A local, precomputed-payload model of the observed 0x34f9170 success path,
 * assuming non-destructive aliases and successful writes. It neither encrypts,
 * selects keys, generates randomness nor computes checksums. Callers supply
 * payload bytes appropriate to the relevant target branch, including external
 * encryption where needed; this module does not establish target QQ-TEA
 * equivalence, signing, network behavior, authentication or interoperability.
 * mode2Word is explicit; the caller may choose 1 for its own null-object case.
 * Local policy rejects nonempty extra when ctx5=0, nonempty payload when both
 * ctx5 and ctx4 are nonzero, and oversized inputs/output rather than truncating
 * or silently discarding bytes. Other modes require mode2Word=null. Inputs must
 * remain stable through their individual snapshots. Owned temporary buffers and
 * failed output are independently wiped best effort; runtime copies can remain.
 */
export function encodeTargetWtEncodeData(input: TargetWtEncodeData): Uint8Array {
    const owned: Uint8Array[] = [];
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        if (typeof input !== 'object' || input === null || isProxy(input)) {
            throw new TypeError();
        }

        chain(input);

        for (const name of Reflect.ownKeys(input)) {
            const descriptor = Object.getOwnPropertyDescriptor(input, name);

            if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
                throw new TypeError();
            }
        }

        const ctxMode = uint(data(input, 'ctxMode'), 0xffffffff);
        const ctx4 = uint(data(input, 'ctx4'), 0xff);
        const ctx5 = uint(data(input, 'ctx5'), 0xff);
        const field6 = uint(data(input, 'field6'), 0xff);
        const modeValue = data(input, 'mode2Word');
        let mode2Word = 0;

        if (ctxMode === 2) {
            mode2Word = uint(modeValue, 0xffff);
        } else if (modeValue !== null) {
            throw new TypeError();
        }

        const snapshot = (value: unknown, max: number, exact?: number): Uint8Array => {
            if (isProxy(value) || !ArrayBuffer.isView(value) || tag.call(value) !== 'Uint8Array') {
                throw new TypeError();
            }

            chain(value);
            const backing = buffer.call(value) as ArrayBuffer;
            bufferLength.call(backing);
            values.call(value);
            const size = length.call(value) as number;
            const start = offset.call(value) as number;

            if (size > max || (exact !== undefined && size !== exact)) {
                throw new RangeError();
            }

            const result = new Bytes(size);
            owned.push(result);
            set.call(result, new Bytes(backing, start, size));
            return result;
        };

        const local16 = snapshot(data(input, 'local16'), 16, 16);
        const extra = snapshot(data(input, 'extra'), MAX_TARGET_WT_ENCODE_DATA_COMPONENT_BYTES);
        const payload = snapshot(data(input, 'payload'), MAX_TARGET_WT_ENCODE_DATA_COMPONENT_BYTES);

        if (
            (ctx5 === 0 && extra.length !== 0) ||
            (ctx5 !== 0 && ctx4 !== 0 && payload.length !== 0)
        ) {
            throw new TypeError();
        }

        const modeLength = ctxMode === 1 ? 2 : ctxMode === 2 ? 4 : 0;
        const size = 20 + modeLength + extra.length + payload.length;

        if (size > MAX_TARGET_WT_ENCODE_DATA_BYTES) {
            throw new RangeError();
        }

        output = new Bytes(size);
        const view = new View(output.buffer);
        view.setUint8(0, ctxMode === 2 ? 2 : 1);
        view.setUint8(1, field6);
        set.call(output, local16, 2);
        let at = 18;

        if (ctxMode === 1) {
            view.setUint16(at, 0x0102, false);
            at += 2;
        } else if (ctxMode === 2) {
            view.setUint16(at, ctx4 === 0 ? 0x0131 : 0x0132, false);
            at += 2;
            view.setUint16(at, mode2Word, false);
            at += 2;
        }

        view.setUint16(at, extra.length, false);
        at += 2;
        set.call(output, extra, at);
        at += extra.length;
        set.call(output, payload, at);
        complete = true;
        return output;
    } catch {
        throw new Error('target WT encode-data construction failed');
    } finally {
        for (const bytes of owned) {
            clear(bytes);
        }

        if (!complete) {
            clear(output);
        }
    }
}
