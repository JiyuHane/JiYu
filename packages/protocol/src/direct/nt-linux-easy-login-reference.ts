import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import type {
    LinuxNTEasyLoginReferenceRequestBody,
    LinuxNTEasyLoginReferenceResponseBody,
} from '@snowluma/proto-defs/direct-login';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';

// Independent field projection from LagrangeV2 rev 7011cdf87368cc0fb77273c1508e779a52328165;
// its overall license is undetermined. Only the documented field numbers are used.
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/Login/EasyLoginService.cs#L13-L25
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Packets/Login/NTLogin.cs#L306-L315
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Packets/Login/NTLogin.cs#L455-L464

export interface LinuxNTEasyLoginReferenceResponse {
    ticketsPresent: boolean;
    a1: Uint8Array | null;
    a2: Uint8Array | null;
    d2: Uint8Array | null;
    d2Key: Uint8Array | null;
}

const LIMIT = 1024 * 1024;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferGetter = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset')!.get!;
const lengthGetter = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get!;
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const values = Uint8Array.prototype.values;
const fill = Uint8Array.prototype.fill;

type View = { buffer: ArrayBuffer; offset: number; length: number };
type Span = { start: number; end: number };

function inspectView(value: unknown): View {
    if (isProxy(value) || !isUint8Array(value)) {
        throw new Error();
    }

    // Validates detached views, including zero-length ones, without invoking properties.
    values.call(value);
    const buffer = bufferGetter.call(value) as ArrayBufferLike;
    const offset = offsetGetter.call(value) as number;
    const length = lengthGetter.call(value) as number;

    if (isSharedArrayBuffer(buffer) || (resizableGetter && resizableGetter.call(buffer))) {
        throw new Error();
    }

    return { buffer: buffer as ArrayBuffer, offset, length };
}

function copyView(view: View): Uint8Array {
    const output = new Uint8Array(view.length);
    output.set(new Uint8Array(view.buffer, view.offset, view.length));
    return output;
}

function wipe(value: Uint8Array | null | undefined): void {
    if (value) {
        try {
            fill.call(value, 0);
        } catch {
            // Best effort, preserving the original outcome.
        }
    }
}

function varintSize(value: number): number {
    let length = 1;

    while (value >= 128) {
        value = Math.floor(value / 128);
        length++;
    }

    return length;
}

function readVarint(data: Uint8Array, cursor: { at: number }, end: number): bigint {
    let result = 0n;

    for (let index = 0; index < 10; index++) {
        if (cursor.at >= end) {
            throw new Error();
        }

        const byte = data[cursor.at++];

        if (index === 9 && byte > 1) {
            throw new Error();
        }

        result |= BigInt(byte & 0x7f) << BigInt(index * 7);

        if ((byte & 0x80) === 0) {
            if (index > 0 && byte === 0) {
                throw new Error();
            }

            return result;
        }
    }

    throw new Error();
}

// Unknown payloads remain opaque; only selected field numbers have semantics.
function scan(data: Uint8Array, frame: Span, selected: ReadonlySet<number>): Map<number, Span> {
    const found = new Map<number, Span>();
    const cursor = { at: frame.start };
    let count = 0;

    while (cursor.at < frame.end) {
        if (++count > 256) {
            throw new Error();
        }

        const tag = readVarint(data, cursor, frame.end);
        const number = tag >> 3n;
        const wire = Number(tag & 7n);

        if (number === 0n || number > 0x1fffffffn || ![0, 1, 2, 5].includes(wire)) {
            throw new Error();
        }

        const field = Number(number);
        const isSelected = selected.has(field);

        if (isSelected && (wire !== 2 || found.has(field))) {
            throw new Error();
        }

        if (wire === 0) {
            readVarint(data, cursor, frame.end);
        } else if (wire === 2) {
            const length = readVarint(data, cursor, frame.end);

            if (length > BigInt(frame.end - cursor.at)) {
                throw new Error();
            }

            const end = cursor.at + Number(length);

            if (isSelected) {
                found.set(field, { start: cursor.at, end });
            }

            cursor.at = end;
        } else {
            const length = wire === 1 ? 8 : 4;

            if (length > frame.end - cursor.at) {
                throw new Error();
            }

            cursor.at += length;
        }
    }

    return found;
}

function matches(
    value: Uint8Array | null | undefined,
    input: Uint8Array,
    span: Span | undefined,
): boolean {
    if (!span) {
        return value == null;
    }

    if (value == null || value.length !== span.end - span.start) {
        return false;
    }

    for (let index = 0; index < value.length; index++) {
        if (value[index] !== input[span.start + index]) {
            return false;
        }
    }

    return true;
}

/**
 * Encode only the opaque EasyLogin request body; it can be supplied as loginBody to
 * encodeLinuxNTLoginReferenceRequest. Input is never modified. A1 must be nonempty;
 * both input and complete encoded output are limited to 1 MiB. No login is performed.
 * The caller owns and must clear both its input and returned bytes. Internal snapshots
 * and the reachable Proton buffer are wiped synchronously on a best-effort basis.
 */
export function encodeLinuxNTEasyLoginReferenceRequest(a1: Uint8Array): Uint8Array {
    let snapshot: Uint8Array | undefined;
    let encoded: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let succeeded = false;

    try {
        const view = inspectView(a1);

        if (
            view.length === 0 ||
            view.length > LIMIT ||
            1 + varintSize(view.length) + view.length > LIMIT
        ) {
            throw new Error();
        }

        snapshot = copyView(view);
        encoded = protobuf_encode<LinuxNTEasyLoginReferenceRequestBody>({ a1: snapshot });

        if (encoded.length !== 1 + varintSize(view.length) + view.length) {
            throw new Error();
        }

        output = new Uint8Array(encoded.length);
        output.set(encoded);
        succeeded = true;
        return output;
    } catch {
        throw new Error('invalid EasyLogin reference request');
    } finally {
        if (!succeeded) {
            wipe(output);
        }

        wipe(encoded);
        wipe(snapshot);
    }
}

/**
 * Decode only an opaque EasyLogin response body, for example the non-null body
 * from decodeLinuxNTLoginReferenceResponse. Presence is separate from empty bytes.
 * Unknown fields carry no interpretation. This does not authenticate a peer or
 * account, classify login success, validate tickets, or persist anything.
 * Input and each returned ticket belong to the caller, who must clear them. Internal
 * snapshots and reachable Proton decoded bytes are wiped synchronously best-effort;
 * runtime allocations or temporaries inaccessible after an exception are not covered.
 * The 1 MiB input limit is not a peak-memory limit.
 */
export function decodeLinuxNTEasyLoginReferenceResponse(
    body: Uint8Array,
): LinuxNTEasyLoginReferenceResponse {
    let snapshot: Uint8Array | undefined;
    let decoded: LinuxNTEasyLoginReferenceResponseBody | undefined;
    const result: LinuxNTEasyLoginReferenceResponse = {
        ticketsPresent: false,
        a1: null,
        a2: null,
        d2: null,
        d2Key: null,
    };
    let succeeded = false;

    try {
        const view = inspectView(body);

        if (view.length > LIMIT) {
            throw new Error();
        }

        snapshot = copyView(view);
        const outer = scan(snapshot, { start: 0, end: snapshot.length }, new Set([1]));
        const ticketsSpan = outer.get(1);
        const tickets = ticketsSpan
            ? scan(snapshot, ticketsSpan, new Set([3, 4, 5, 6]))
            : undefined;
        decoded = protobuf_decode<LinuxNTEasyLoginReferenceResponseBody>(snapshot);
        const decodedTickets = decoded.tickets;

        if (
            Boolean(ticketsSpan) !== (decodedTickets != null) ||
            !matches(decodedTickets?.a1, snapshot, tickets?.get(3)) ||
            !matches(decodedTickets?.a2, snapshot, tickets?.get(4)) ||
            !matches(decodedTickets?.d2, snapshot, tickets?.get(5)) ||
            !matches(decodedTickets?.d2Key, snapshot, tickets?.get(6))
        ) {
            throw new Error();
        }

        result.ticketsPresent = ticketsSpan !== undefined;
        result.a1 = decodedTickets?.a1 == null ? null : new Uint8Array(decodedTickets.a1);
        result.a2 = decodedTickets?.a2 == null ? null : new Uint8Array(decodedTickets.a2);
        result.d2 = decodedTickets?.d2 == null ? null : new Uint8Array(decodedTickets.d2);
        result.d2Key = decodedTickets?.d2Key == null ? null : new Uint8Array(decodedTickets.d2Key);
        succeeded = true;
        return result;
    } catch {
        throw new Error('invalid EasyLogin reference response');
    } finally {
        if (!succeeded) {
            wipe(result.a1);
            wipe(result.a2);
            wipe(result.d2);
            wipe(result.d2Key);
        }

        wipe(decoded?.tickets?.a1);
        wipe(decoded?.tickets?.a2);
        wipe(decoded?.tickets?.d2);
        wipe(decoded?.tickets?.d2Key);
        wipe(snapshot);
    }
}
