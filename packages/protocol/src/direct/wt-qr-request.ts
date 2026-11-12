import { encodeWtTlv, type WtTlvEntry } from './wt-tlv';

// Static source references only; no live QQ packet validation has been performed.
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Login/WtLogin.cs#L22-L55
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Login/TlvQrCode.cs

const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

export interface WtQrFetchBody {
    appId: number;
    subAppId: number;
    guid: Uint8Array;
    packageName: string;
    ptVersion: string;
    miscBitMap: number;
    ssoVersion: number;
    /** Already serialized TLV 0xd1 value, supplied by the caller. */
    d1: Uint8Array;
    unusualSig?: Uint8Array;
}

export interface WtQrPollBody {
    appId: number;
    qrSig: Uint8Array;
}

function uint32(value: number, name: string): void {
    if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
        throw new RangeError(`invalid ${name}`);
    }
}

function bytes(value: Uint8Array, name: string): void {
    if (!(value instanceof Uint8Array) || value.length > MAX_U16) {
        throw new RangeError(`invalid ${name}`);
    }
}

function text(value: string, name: string): Buffer {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_U16) {
        throw new RangeError(`invalid ${name}`);
    }

    return Buffer.from(value, 'utf8');
}

function u32(value: number): Buffer {
    const output = Buffer.alloc(4);
    output.writeUInt32BE(value);
    return output;
}

function prefixed(value: Uint8Array): Buffer {
    const output = Buffer.alloc(2 + value.length);
    output.writeUInt16BE(value.length);
    output.set(value, 2);
    return output;
}

/** Encode only the command 0x31 QR fetch business body, without code2d/OICQ framing. */
export function encodeWtQrFetchBody(input: WtQrFetchBody): Uint8Array {
    uint32(input.appId, 'appId');
    uint32(input.subAppId, 'subAppId');
    uint32(input.miscBitMap, 'miscBitMap');
    uint32(input.ssoVersion, 'ssoVersion');
    bytes(input.guid, 'guid');
    bytes(input.d1, 'd1');

    if (input.unusualSig !== undefined) {
        bytes(input.unusualSig, 'unusualSig');
    }

    const packageName = text(input.packageName, 'packageName');
    const ptVersion = text(input.ptVersion, 'ptVersion');
    const tlv16Length =
        12 + input.guid.length + 2 * (2 + packageName.length) + 2 + ptVersion.length;

    if (tlv16Length > MAX_U16) {
        throw new RangeError('TLV 0x16 value exceeds length limit');
    }

    const tlv16 = Buffer.concat([
        u32(0),
        u32(input.appId),
        u32(input.subAppId),
        input.guid,
        prefixed(packageName),
        prefixed(ptVersion),
        prefixed(packageName),
    ]);
    const tlv1b = Buffer.alloc(30);
    [0, 0, 3, 4, 72, 2, 2].forEach((value, index) => tlv1b.writeUInt32BE(value, index * 4));
    const tlv1d = Buffer.alloc(10);
    tlv1d[0] = 1;
    tlv1d.writeUInt32BE(input.miscBitMap, 1);
    const entries: WtTlvEntry[] = [];

    if (input.unusualSig !== undefined) {
        entries.push({ tag: 0x11, value: input.unusualSig });
    }

    entries.push(
        { tag: 0x16, value: tlv16 },
        { tag: 0x1b, value: tlv1b },
        { tag: 0x1d, value: tlv1d },
        { tag: 0x33, value: input.guid },
        { tag: 0x35, value: u32(input.ssoVersion) },
        { tag: 0x66, value: u32(input.ssoVersion) },
        { tag: 0xd1, value: input.d1 },
    );
    const header = Buffer.alloc(17);
    header.writeUInt32BE(input.appId, 2);
    return Buffer.concat([header, encodeWtTlv(entries)]);
}

/** Encode only the command 0x12 QR poll business body, without code2d/OICQ framing. */
export function encodeWtQrPollBody(input: WtQrPollBody): Uint8Array {
    uint32(input.appId, 'appId');
    bytes(input.qrSig, 'qrSig');
    const header = Buffer.alloc(6);
    header.writeUInt32BE(input.appId, 2);
    // UIN, empty raw TGT, byte flag, empty length-prefixed field, TLV count.
    return Buffer.concat([header, prefixed(input.qrSig), Buffer.alloc(13)]);
}
