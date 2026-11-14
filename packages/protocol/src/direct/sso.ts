import { inflateSync } from 'node:zlib';

// These codecs cover the inner SSO message, not the TCP service envelope.
// Field order was derived from the public Lagrange.Core SSO format:
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Struct/SsoPacker.cs
// Reserved metadata, signing, login, and compatibility with any QQ build are
// outside this module. The limits below are local resource limits, not wire facts.
const MAX_SSO_BYTES = 16 * 1024 * 1024;
const FIXED_12 = Uint8Array.of(2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const fillBytes = Uint8Array.prototype.fill;

function wipe(bytes: Uint8Array | undefined): void {
    try {
        if (bytes !== undefined) {
            fillBytes.call(bytes, 0);
        }
    } catch {
        // Best effort: preserve the parse result or original error and continue cleanup.
    }
}

function decodeText(bytes: Uint8Array): string {
    try {
        return utf8.decode(bytes);
    } finally {
        wipe(bytes);
    }
}

export interface Sso12Request {
    sequence: number;
    subAppId: number;
    a2: Uint8Array;
    command: string;
    guid: Uint8Array;
    version: string;
    reserved: Uint8Array;
    body: Uint8Array;
}

export interface Sso13Request {
    command: string;
    reserved: Uint8Array;
    body: Uint8Array;
}

export interface SsoResponse {
    sequence: number;
    retCode: number;
    extra: string;
    command: string;
    cookie: Uint8Array;
    dataFlag: number;
    reserved: Uint8Array;
    body: Uint8Array;
    /** Uninterpreted header bytes, if any, after the known fields. */
    headerExtension: Uint8Array;
}

function i32(value: number): Buffer {
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
        throw new RangeError('SSO integer must fit in signed 32 bits');
    }

    const result = Buffer.allocUnsafe(4);
    result.writeInt32BE(value);
    return result;
}

function prefixed(data: Uint8Array, width: 2 | 4): Buffer {
    const length = data.byteLength + width;

    if (length > MAX_SSO_BYTES || (width === 2 && length > 0xffff)) {
        throw new RangeError('SSO field exceeds size limit');
    }

    const result = Buffer.allocUnsafe(length);

    if (width === 2) {
        result.writeUInt16BE(length);
    } else {
        result.writeUInt32BE(length);
    }

    result.set(data, width);
    return result;
}

function encode(headParts: readonly Uint8Array[], body: Uint8Array): Uint8Array {
    const headLength = headParts.reduce((total, part) => total + part.byteLength, 0);

    if (headLength + body.byteLength + 8 > MAX_SSO_BYTES) {
        throw new RangeError('SSO message exceeds size limit');
    }

    return Buffer.concat([prefixed(Buffer.concat(headParts), 4), prefixed(body, 4)]);
}

/** Encode the inner protocol-12 request; `reserved` is already serialized. */
export function encodeSso12Request(request: Sso12Request): Uint8Array {
    return encode(
        [
            i32(request.sequence),
            i32(request.subAppId),
            i32(2052),
            FIXED_12,
            prefixed(request.a2, 4),
            prefixed(Buffer.from(request.command, 'utf8'), 4),
            prefixed(new Uint8Array(0), 4),
            prefixed(Buffer.from(Buffer.from(request.guid).toString('hex'), 'utf8'), 4),
            prefixed(new Uint8Array(0), 4),
            prefixed(Buffer.from(request.version, 'utf8'), 2),
            prefixed(request.reserved, 4),
        ],
        request.body,
    );
}

/** Encode the inner protocol-13 request; sequence is in the outer service layer. */
export function encodeSso13Request(request: Sso13Request): Uint8Array {
    return encode(
        [
            prefixed(Buffer.from(request.command, 'utf8'), 4),
            prefixed(new Uint8Array(0), 4),
            prefixed(request.reserved, 4),
        ],
        request.body,
    );
}

class Reader {
    private position = 0;

    constructor(private readonly bytes: Uint8Array) {}

    readInt32(): number {
        if (this.position + 4 > this.bytes.length) {
            throw new Error('truncated SSO integer');
        }

        const value = new DataView(
            this.bytes.buffer,
            this.bytes.byteOffset + this.position,
            4,
        ).getInt32(0);
        this.position += 4;
        return value;
    }

    readField(): Uint8Array {
        if (this.position + 4 > this.bytes.length) {
            throw new Error('truncated SSO length');
        }

        const length = new DataView(
            this.bytes.buffer,
            this.bytes.byteOffset + this.position,
            4,
        ).getUint32(0);

        if (length < 4 || length > this.bytes.length - this.position) {
            throw new Error('invalid SSO field length');
        }

        const start = this.position + 4;
        this.position += length;
        return Uint8Array.from(this.bytes.subarray(start, this.position));
    }

    rest(): Uint8Array {
        return Uint8Array.from(this.bytes.subarray(this.position));
    }
}

/**
 * Parse a complete inner SSO response. Compressed bodies are zlib streams.
 * Limits are enforced before and during decompression. Nonzero return codes
 * remain visible when parsing succeeds; invalid data still raises an error.
 */
export function decodeSsoResponse(bytes: Uint8Array): SsoResponse {
    if (bytes.byteLength > MAX_SSO_BYTES) {
        throw new RangeError('SSO message exceeds size limit');
    }

    const outer = new Reader(bytes);
    let headerBytes: Uint8Array | undefined;
    let encodedBody: Uint8Array | undefined;
    let trailing: Uint8Array | undefined;
    let cookie: Uint8Array | undefined;
    let reserved: Uint8Array | undefined;
    let headerExtension: Uint8Array | undefined;
    let body: Uint8Array | undefined;
    let transferred = false;

    try {
        headerBytes = outer.readField();
        const header = new Reader(headerBytes);
        encodedBody = outer.readField();
        trailing = outer.rest();

        if (trailing.length !== 0) {
            throw new Error('unexpected trailing SSO data');
        }

        const sequence = header.readInt32();
        const retCode = header.readInt32();
        const extra = decodeText(header.readField());
        const command = decodeText(header.readField());
        cookie = header.readField();
        const dataFlag = header.readInt32();
        reserved = header.readField();
        headerExtension = header.rest();

        if (dataFlag === 0 || dataFlag === 4) {
            body = encodedBody;
        } else if (dataFlag === 1) {
            body = inflateSync(encodedBody, { maxOutputLength: MAX_SSO_BYTES });
        } else {
            throw new Error(`unsupported SSO data flag: ${dataFlag}`);
        }

        const result = {
            sequence,
            retCode,
            extra,
            command,
            cookie,
            dataFlag,
            reserved,
            body,
            headerExtension,
        };
        transferred = true;
        return result;
    } finally {
        // The input is borrowed; only independently allocated copies are wiped here.
        wipe(headerBytes);
        wipe(trailing);

        if (!transferred || encodedBody !== body) {
            wipe(encodedBody);
        }

        if (!transferred) {
            wipe(cookie);
            wipe(reserved);
            wipe(headerExtension);

            if (body !== encodedBody) {
                wipe(body);
            }
        }
    }
}
