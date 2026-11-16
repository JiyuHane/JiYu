import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import type { LinuxNTEasyLoginReferenceSecurityBody } from '@snowluma/proto-defs/direct-login';
import { protobuf_decode } from '@snowluma/proton';

// Independent reference projection; upstream authors retain their rights.
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Packets/Login/NTLogin.cs#L368-L378
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Packets/Login/NTLogin.cs#L461-L469
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/Login/EasyLoginService.cs#L22-L33

export interface LinuxNTEasyLoginUnusualDeviceReferenceResponse {
    secProtectPresent: boolean;
    unusualDeviceCheckSig: Uint8Array | null;
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

    // Validate detached views, including zero-length views, through an intrinsic.
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
            // Best effort; preserve the original outcome.
        }
    }
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

// Only the selected field has semantics; unknown length-delimited values are opaque.
function scan(data: Uint8Array, frame: Span, selected: number): Span | undefined {
    let found: Span | undefined;
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

        const isSelected = number === BigInt(selected);

        if (isSelected && (wire !== 2 || found !== undefined)) {
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
                found = { start: cursor.at, end };
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
    data: Uint8Array,
    span: Span | undefined,
): boolean {
    if (!span) {
        return value == null;
    }

    if (value == null || value.length !== span.end - span.start) {
        return false;
    }

    for (let index = 0; index < value.length; index++) {
        if (value[index] !== data[span.start + index]) {
            return false;
        }
    }

    return true;
}

/**
 * Project only the reference EasyLogin body field 3 and its child field 2.
 * Missing SecProtect, missing child, and a present empty child remain distinct.
 * Unknown fields are skipped without interpretation. Duplicate selected fields,
 * wrong wire types, non-minimal varints and protobuf groups are rejected by local
 * policy, not asserted to match the reference or QQ. The 1 MiB input limit and
 * 256-field-per-message limit do not bound total memory or CPU.
 *
 * This function does not inspect the response status, authenticate a peer, bind
 * an account, validate the returned bytes, initiate a QR flow, or establish login.
 * Input and the returned byte array belong to the caller. Reachable internal
 * copies are cleared best effort; inaccessible codec and runtime copies remain
 * outside that guarantee. Input bytes must stay stable until snapshotted, and the
 * implementation assumes ordinary untampered JavaScript intrinsics.
 */
export function decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse(
    body: Uint8Array,
): LinuxNTEasyLoginUnusualDeviceReferenceResponse {
    let snapshot: Uint8Array | undefined;
    let decoded: LinuxNTEasyLoginReferenceSecurityBody | undefined;
    let output: Uint8Array | null = null;
    let succeeded = false;

    try {
        const view = inspectView(body);

        if (view.length > LIMIT) {
            throw new Error();
        }

        snapshot = copyView(view);
        const protectSpan = scan(snapshot, { start: 0, end: snapshot.length }, 3);
        const sigSpan = protectSpan ? scan(snapshot, protectSpan, 2) : undefined;
        decoded = protobuf_decode<LinuxNTEasyLoginReferenceSecurityBody>(snapshot);
        const protect = decoded.secProtect;
        const signature = protect?.unusualDeviceCheckSig;

        if (
            (protectSpan !== undefined) !== (protect != null) ||
            !matches(signature, snapshot, sigSpan)
        ) {
            throw new Error();
        }

        if (signature != null) {
            output = new Uint8Array(signature);
        }

        const result: LinuxNTEasyLoginUnusualDeviceReferenceResponse = {
            secProtectPresent: protectSpan !== undefined,
            unusualDeviceCheckSig: output,
        };
        succeeded = true;
        return result;
    } catch {
        throw new Error('invalid EasyLogin unusual-device reference response');
    } finally {
        if (!succeeded) {
            wipe(output);
        }

        wipe(decoded?.secProtect?.unusualDeviceCheckSig);
        wipe(snapshot);
    }
}
