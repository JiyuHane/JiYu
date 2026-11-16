import { createDecipheriv } from 'node:crypto';
import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import type {
    LinuxNTLoginReferenceResponseCommon,
    LinuxNTLoginReferenceResponseForward,
} from '@snowluma/proto-defs/direct-login';
import { protobuf_decode } from '@snowluma/proton';

export interface LinuxNTLoginReferenceResponseInput {
    forward: Uint8Array;
    sessionKey: Uint8Array;
}

export type LinuxNTLoginReferenceResponseStatus =
    | { kind: 'missing-head' }
    | { kind: 'missing-error-info' }
    | { kind: 'code'; code: bigint; codePresent: boolean };

export interface LinuxNTLoginReferenceResponse {
    status: LinuxNTLoginReferenceResponseStatus;
    body: Uint8Array | null;
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
type Field = { span?: Span; value?: bigint };
type Budget = { fields: number };

function inspectView(value: unknown): View {
    if (isProxy(value) || !isUint8Array(value)) {
        throw new Error();
    }

    // Unlike byteLength alone, the intrinsic validates detached views of length zero.
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
    const copy = new Uint8Array(view.length);
    copy.set(new Uint8Array(view.buffer, view.offset, view.length));
    return copy;
}

function wipe(value: Uint8Array | null | undefined): void {
    if (value) {
        try {
            fill.call(value, 0);
        } catch {
            // Best effort; never replace the original outcome.
        }
    }
}

function readVarint(
    data: Uint8Array,
    cursor: { at: number },
    end: number,
    shortest: boolean,
): bigint {
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
            if (shortest && index > 0 && byte === 0) {
                throw new Error();
            }

            return result;
        }
    }

    throw new Error();
}

// Only selected field numbers carry semantics. Unknown payloads are never traversed.
function scan(
    data: Uint8Array,
    frame: Span,
    selected: Readonly<Record<number, number>>,
    budget: Budget,
): Map<number, Field> {
    const result = new Map<number, Field>();
    const cursor = { at: frame.start };
    let count = 0;

    while (cursor.at < frame.end) {
        if (++count > 256 || ++budget.fields > 1024) {
            throw new Error();
        }

        const tag = readVarint(data, cursor, frame.end, true);
        const fieldNumber = tag >> 3n;
        const wire = Number(tag & 7n);

        if (fieldNumber === 0n || fieldNumber > 0x1fffffffn || ![0, 1, 2, 5].includes(wire)) {
            throw new Error();
        }

        const number = Number(fieldNumber);
        const expected = Object.hasOwn(selected, number) ? selected[number] : undefined;

        if (expected !== undefined && (expected !== wire || result.has(number))) {
            throw new Error();
        }

        let value: bigint | undefined;
        let span: Span | undefined;

        if (wire === 0) {
            // Local policy also requires shortest-form unsigned value varints.
            value = readVarint(data, cursor, frame.end, true);
        } else if (wire === 2) {
            const length = readVarint(data, cursor, frame.end, true);

            if (length > BigInt(frame.end - cursor.at)) {
                throw new Error();
            }

            const end = cursor.at + Number(length);
            span = { start: cursor.at, end };
            cursor.at = end;
        } else {
            const size = wire === 1 ? 8 : 4;

            if (size > frame.end - cursor.at) {
                throw new Error();
            }

            cursor.at += size;
        }

        if (expected !== undefined) {
            result.set(number, { value, span });
        }
    }

    return result;
}

function sameBytes(value: Uint8Array, data: Uint8Array, span: Span): boolean {
    if (value.length !== span.end - span.start) {
        return false;
    }

    for (let i = 0; i < value.length; i++) {
        if (value[i] !== data[span.start + i]) {
            return false;
        }
    }

    return true;
}

/**
 * Offline response-body projection, not a login success classifier. The strict
 * local policy rejects duplicates/wrong wires on selected fields and non-shortest
 * tag, length and value varints; it is stricter than upstream last-wins decoding.
 * Body and all unselected fields remain opaque. Outer metadata is unauthenticated.
 * Nonce uniqueness, replay, identity, binding and expiry are outside this helper.
 * The 1 MiB input/plaintext limits are not RSS or peak-allocation limits; snapshots,
 * crypto buffers, codec copies and the result can coexist in one invocation.
 * Reachable internal payload buffers are cleared best-effort; caller and output
 * buffers, runtime/crypto-internal copies and detached storage are not covered.
 *
 * Reference field layouts: NTEcdh.cs:53-61, NTLogin.cs:76-94, 167-182, 538-544,
 * NTLoginCommon.cs:55-76 at LagrangeV2 revision 7011cdf87368cc0fb77273c1508e779a52328165.
 */
export function decodeLinuxNTLoginReferenceResponse(
    input: LinuxNTLoginReferenceResponseInput,
): LinuxNTLoginReferenceResponse {
    let key: Uint8Array | undefined;
    let forward: Uint8Array | undefined;
    let encrypted: Uint8Array | null | undefined;
    let update: Buffer | undefined;
    let final: Buffer | undefined;
    let plain: Uint8Array | undefined;
    let decodedBody: Uint8Array | null | undefined;
    let outputBody: Uint8Array | null = null;
    let succeeded = false;
    let authenticationFailed = false;

    try {
        if (input === null || typeof input !== 'object' || isProxy(input)) {
            throw new Error();
        }

        const prototype = Object.getPrototypeOf(input) as unknown;

        if (prototype !== Object.prototype && prototype !== null) {
            throw new Error();
        }

        const keys = Reflect.ownKeys(input);

        if (keys.length !== 2 || !keys.includes('forward') || !keys.includes('sessionKey')) {
            throw new Error();
        }

        const forwardDescriptor = Object.getOwnPropertyDescriptor(input, 'forward');
        const keyDescriptor = Object.getOwnPropertyDescriptor(input, 'sessionKey');

        if (
            !forwardDescriptor ||
            !('value' in forwardDescriptor) ||
            !keyDescriptor ||
            !('value' in keyDescriptor)
        ) {
            throw new Error();
        }

        const forwardView = inspectView(forwardDescriptor.value);
        const keyView = inspectView(keyDescriptor.value);

        if (forwardView.length > LIMIT || ![16, 24, 32].includes(keyView.length)) {
            throw new Error();
        }

        forward = copyView(forwardView);
        key = copyView(keyView);
        const budget = { fields: 0 };
        const outer = scan(
            forward,
            { start: 0, end: forward.length },
            { 1: 2, 3: 2, 4: 0, 5: 2 },
            budget,
        );
        const bufferSpan = outer.get(3)?.span;
        const type = outer.get(4)?.value;

        if (!bufferSpan || (type !== undefined && type > 0xffffffffn)) {
            throw new Error();
        }

        const outerDecoded = protobuf_decode<LinuxNTLoginReferenceResponseForward>(forward);
        encrypted = outerDecoded.buffer;

        if (!encrypted || !sameBytes(encrypted, forward, bufferSpan) || encrypted.length < 28) {
            throw new Error();
        }

        const algorithm =
            key.length === 16 ? 'aes-128-gcm' : key.length === 24 ? 'aes-192-gcm' : 'aes-256-gcm';
        const decipher = createDecipheriv(algorithm, key, encrypted.subarray(0, 12), {
            authTagLength: 16,
        });
        decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
        update = decipher.update(encrypted.subarray(12, encrypted.length - 16));

        try {
            final = decipher.final();
        } catch {
            authenticationFailed = true;
            throw new Error();
        }

        if (update.length + final.length > LIMIT) {
            throw new Error();
        }

        // Do not scan or decode update's unauthenticated bytes before final succeeds.
        plain = new Uint8Array(update.length + final.length);
        plain.set(update);
        plain.set(final, update.length);
        const common = scan(plain, { start: 0, end: plain.length }, { 1: 2, 2: 2 }, budget);
        const headSpan = common.get(1)?.span;
        const bodySpan = common.get(2)?.span;
        const head = headSpan ? scan(plain, headSpan, { 4: 2 }, budget) : undefined;
        const errorSpan = head?.get(4)?.span;
        const error = errorSpan ? scan(plain, errorSpan, { 1: 0 }, budget) : undefined;
        const code = error?.get(1)?.value;
        const decoded = protobuf_decode<LinuxNTLoginReferenceResponseCommon>(plain);
        decodedBody = decoded.body;

        if (
            Boolean(headSpan) !== (decoded.head != null) ||
            Boolean(errorSpan) !== (decoded.head?.errorInfo != null) ||
            Boolean(bodySpan) !== (decodedBody != null) ||
            (bodySpan && (!decodedBody || !sameBytes(decodedBody, plain, bodySpan))) ||
            (errorSpan &&
                ((code !== undefined) !== (decoded.head?.errorInfo?.code != null) ||
                    (code !== undefined && decoded.head?.errorInfo?.code !== code)))
        ) {
            throw new Error();
        }

        const status: LinuxNTLoginReferenceResponseStatus = !headSpan
            ? { kind: 'missing-head' }
            : !errorSpan
              ? { kind: 'missing-error-info' }
              : { kind: 'code', code: code ?? 0n, codePresent: code !== undefined };

        if (decodedBody != null) {
            outputBody = new Uint8Array(decodedBody.length);
            outputBody.set(decodedBody);
        }

        const result: LinuxNTLoginReferenceResponse = { status, body: outputBody };
        succeeded = true;
        return result;
    } catch {
        throw new Error(
            authenticationFailed
                ? 'invalid reference authentication'
                : 'invalid reference response',
        );
    } finally {
        if (!succeeded) {
            wipe(outputBody);
        }

        wipe(decodedBody);
        wipe(plain);
        wipe(update);
        wipe(final);
        wipe(encrypted);
        wipe(key);
        wipe(forward);
    }
}
