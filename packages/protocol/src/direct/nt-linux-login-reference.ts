import { createCipheriv } from 'node:crypto';
import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import type {
    LinuxNTLoginReferenceCommon,
    LinuxNTLoginReferenceForward,
} from '@snowluma/proto-defs/direct-login';
import { protobuf_encode } from '@snowluma/proton';

// Independent implementation of request-body structure, not a copy of upstream code.
// The overall license of the reference source is undetermined.
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/Login/NTLoginCommon.cs#L11-L25
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/Login/NTLoginCommon.cs#L94-L124
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Packets/Login/NTLogin.cs

export interface LinuxNTLoginReferenceInput {
    sessionKey: Uint8Array;
    sessionTicket: Uint8Array;
    /** Exactly 12 bytes; caller is responsible for uniqueness under each key. */
    nonce: Uint8Array;
    /** Already encoded and opaque; an empty body is still present on the wire. */
    loginBody: Uint8Array;
    account: string;
    deviceName: string;
    deviceType: string;
    guid: Uint8Array;
    version: string;
    appId: number;
    appName: string;
    qua: string;
    cookie?: string;
}

const LIMIT = 1024 * 1024;
const FIELDS = [
    'sessionKey',
    'sessionTicket',
    'nonce',
    'loginBody',
    'account',
    'deviceName',
    'deviceType',
    'guid',
    'version',
    'appId',
    'appName',
    'qua',
    'cookie',
] as const;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const arrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const typedValues = Uint8Array.prototype.values;
const typedFill = Uint8Array.prototype.fill;

function inputFields(input: unknown): Record<string, unknown> {
    if (input === null || typeof input !== 'object' || isProxy(input)) {
        throw new TypeError('invalid reference input');
    }

    const prototype = Object.getPrototypeOf(input) as unknown;

    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('invalid reference input');
    }

    const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== 'string' || !(FIELDS as readonly string[]).includes(key)) {
            throw new TypeError('invalid reference input');
        }

        const descriptor = Object.getOwnPropertyDescriptor(input, key);

        if (!descriptor || !('value' in descriptor)) {
            throw new TypeError('invalid reference input');
        }

        fields[key] = descriptor.value;
    }

    return fields;
}

type ByteView = { buffer: ArrayBuffer; offset: number; length: number };

function inspectBytes(value: unknown): ByteView {
    if (isProxy(value) || !isUint8Array(value)) {
        throw new TypeError('invalid reference bytes');
    }

    // The intrinsic detects detached views even when their reported length is zero.
    typedValues.call(value);
    const buffer = arrayBufferGetter.call(value) as ArrayBufferLike;
    const offset = byteOffsetGetter.call(value) as number;
    const length = byteLengthGetter.call(value) as number;

    if (
        isSharedArrayBuffer(buffer) ||
        (resizableGetter && resizableGetter.call(buffer)) ||
        length > LIMIT
    ) {
        throw new TypeError('invalid reference bytes');
    }

    return { buffer: buffer as ArrayBuffer, offset, length };
}

function copyBytes(value: ByteView): Uint8Array {
    return Uint8Array.from(new Uint8Array(value.buffer, value.offset, value.length));
}

function text(value: unknown): string {
    if (
        typeof value !== 'string' ||
        value.length > LIMIT ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
    ) {
        throw new TypeError('invalid reference text');
    }

    return value;
}

function wipe(value: Uint8Array | undefined): void {
    if (value) {
        typedFill.call(value, 0);
    }
}

/**
 * Synchronous Linux reference request body only. Caller supplies a unique nonce for
 * every encryption under a given synthetic key; this helper generates no randomness.
 * It does not decode responses, connect, sign, authenticate a server, or perform login.
 * This reference is not evidence for a native signing path or actual AES behavior.
 * Output contains a ticket and must be treated as sensitive. Snapshots and byte
 * temporaries are wiped best-effort; JS strings and crypto runtime memory are not.
 */
export function encodeLinuxNTLoginReferenceRequest(input: LinuxNTLoginReferenceInput): Uint8Array {
    const f = inputFields(input);
    const keyView = inspectBytes(f.sessionKey);
    const ticketView = inspectBytes(f.sessionTicket);
    const nonceView = inspectBytes(f.nonce);
    const bodyView = inspectBytes(f.loginBody);
    const guidView = inspectBytes(f.guid);

    if (
        ![16, 24, 32].includes(keyView.length) ||
        ticketView.length === 0 ||
        nonceView.length !== 12 ||
        guidView.length === 0
    ) {
        throw new RangeError('invalid reference byte lengths');
    }

    const account = text(f.account);
    const deviceName = text(f.deviceName);
    const deviceType = text(f.deviceType);
    const version = text(f.version);
    const appName = text(f.appName);
    const qua = text(f.qua);
    const cookie = f.cookie === undefined ? undefined : text(f.cookie);

    if (
        !/^[1-9][0-9]{0,18}$/.test(account) ||
        (account.length === 19 && account > '9223372036854775807')
    ) {
        throw new RangeError('invalid reference account');
    }

    const appId = f.appId;

    if (typeof appId !== 'number' || !Number.isInteger(appId) || appId < 0 || appId > 0x7fffffff) {
        throw new RangeError('invalid reference app id');
    }

    // A conservative 256-byte framing allowance bounds both encoded messages and
    // all intermediate allocations before any byte snapshots or encryption.
    const textSize = [account, deviceName, deviceType, version, appName, qua, cookie ?? ''].reduce(
        (sum, value) => sum + Buffer.byteLength(value, 'utf8'),
        0,
    );

    if (textSize + ticketView.length + bodyView.length + guidView.length + 256 > LIMIT) {
        throw new RangeError('reference body exceeds size limit');
    }

    let key: Uint8Array | undefined;
    let ticket: Uint8Array | undefined;
    let nonce: Uint8Array | undefined;
    let body: Uint8Array | undefined;
    let guid: Uint8Array | undefined;
    let plain: Uint8Array | undefined;
    let encrypted: Buffer | undefined;
    let tail: Buffer | undefined;
    let tag: Buffer | undefined;
    let wrapped: Buffer | undefined;

    try {
        key = copyBytes(keyView);
        ticket = copyBytes(ticketView);
        nonce = copyBytes(nonceView);
        body = copyBytes(bodyView);
        guid = copyBytes(guidView);
        plain = protobuf_encode<LinuxNTLoginReferenceCommon>({
            head: {
                user: { account },
                client: { deviceType, deviceName, platform: 7, guid },
                app: { version, appId, appName, qua },
                cookie: cookie === undefined ? {} : { cookieContent: cookie },
                sdk: { version: 1 },
            },
            body,
        });

        if (plain.byteLength + 28 > LIMIT) {
            throw new RangeError('reference encrypted body exceeds size limit');
        }

        const algorithm =
            key.length === 16 ? 'aes-128-gcm' : key.length === 24 ? 'aes-192-gcm' : 'aes-256-gcm';
        const cipher = createCipheriv(algorithm, key, nonce, { authTagLength: 16 });
        encrypted = cipher.update(plain);
        tail = cipher.final();
        tag = cipher.getAuthTag();
        wrapped = Buffer.concat([nonce, encrypted, tail, tag]);

        if (wrapped.length > LIMIT) {
            throw new RangeError('reference encrypted body exceeds size limit');
        }

        return protobuf_encode<LinuxNTLoginReferenceForward>({
            sessionTicket: ticket,
            buffer: wrapped,
            type: 1,
        });
    } finally {
        wipe(key);
        wipe(ticket);
        wipe(nonce);
        wipe(body);
        wipe(guid);
        wipe(plain);
        wipe(encrypted);
        wipe(tail);
        wipe(tag);
        wipe(wrapped);
    }
}
