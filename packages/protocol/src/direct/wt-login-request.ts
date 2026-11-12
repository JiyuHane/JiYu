import { qqTeaEncrypt } from './qq-tea';
import { encodeWtTlv, type WtTlvEntry } from './wt-tlv';

// Static reference only; neither live compatibility nor server acceptance is established.
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Login/WtLogin.cs#L141-L161
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Login/Tlv.cs
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

export interface WtLoginRequestBody {
    /** UIN must fit the u32 fields of this business body; truncation is rejected. */
    uin: number;
    appId: number;
    subAppId: number;
    appClientVersion: number;
    mainSigMap: number;
    miscBitMap: number;
    subSigMap: number;
    packageName: string;
    ptVersion: string;
    sdkVersion: string;
    os: string;
    deviceName: string;
    guid: Uint8Array;
    /** Bytes of ApkSignatureMd5 as named by the reference; not necessarily a digest. */
    apkSignature: Uint8Array;
    /** 0x12 response TLV 0x18; this is the temporary A1, not the returned A1. */
    temporaryA1: Uint8Array;
    /** 0x12 response TLV 0x19. */
    noPicSig: Uint8Array;
    /** 0x12 response TLV 0x1e, used to encrypt the nested TLVs. */
    tgtgtKey: Uint8Array;
    /** Exactly 12 caller-selected bytes: upstream Skip(12) does not initialize them. */
    tlv124Value: Uint8Array;
    /** Optional deterministic source for offline fixtures only; production uses crypto randomness. */
    randomSource?: (length: number) => Uint8Array;
}

function uint(value: number, max: number, name: string): void {
    if (!Number.isInteger(value) || value < 0 || value > max) {
        throw new RangeError(`invalid ${name}`);
    }
}

function bytes(value: Uint8Array, name: string, min = 0, max = MAX_U16): Buffer {
    if (!(value instanceof Uint8Array) || value.length < min || value.length > max) {
        throw new RangeError(`invalid ${name} length`);
    }

    return Buffer.from(value);
}

function text(value: string, name: string): Buffer {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_U16) {
        throw new RangeError(`invalid ${name} length`);
    }

    return Buffer.from(value, 'utf8');
}

function u32(value: number): Buffer {
    const output = Buffer.alloc(4);
    output.writeUInt32BE(value);
    return output;
}

function prefix(value: Uint8Array): Buffer {
    const output = Buffer.alloc(2 + value.length);
    output.writeUInt16BE(value.length);
    output.set(value, 2);
    return output;
}

function valueLength(value: Uint8Array, tag: string): void {
    if (value.length > MAX_U16) {
        throw new RangeError(`TLV ${tag} exceeds length limit`);
    }
}

/**
 * Encode the PC wtlogin.login subcommand 9 business payload only: u16 command,
 * u16 count and 15 ordered TLVs. The returned bytes include temporary secrets;
 * callers must not log them. No OICQ, SSO, signer, transport, or login is done.
 *
 * QQ-TEA's zero trailer is the local codec's policy; upstream does not explicitly
 * initialize all seven trailing bytes. The format is not authenticated.
 */
export function encodeWtLoginRequestBody(input: WtLoginRequestBody): Uint8Array {
    if (!input || typeof input !== 'object') {
        throw new TypeError('invalid login request');
    }

    uint(input.uin, MAX_U32, 'uin');
    uint(input.appId, MAX_U32, 'appId');
    uint(input.subAppId, MAX_U32, 'subAppId');
    uint(input.appClientVersion, MAX_U16, 'appClientVersion');
    uint(input.mainSigMap, MAX_U32, 'mainSigMap');
    uint(input.miscBitMap, MAX_U32, 'miscBitMap');
    uint(input.subSigMap, MAX_U32, 'subSigMap');

    if (input.randomSource !== undefined && typeof input.randomSource !== 'function') {
        throw new TypeError('invalid random source');
    }

    // Snapshot mutable caller bytes before invoking the random source.
    const guid = bytes(input.guid, 'guid', 1);
    const signature = bytes(input.apkSignature, 'apkSignature');
    const a1 = bytes(input.temporaryA1, 'temporaryA1', 1);
    const noPicSig = bytes(input.noPicSig, 'noPicSig', 1);
    const tgtgtKey = bytes(input.tgtgtKey, 'tgtgtKey', 16, 16);
    const tlv124 = bytes(input.tlv124Value, 'tlv124Value', 12, 12);
    const packageName = text(input.packageName, 'packageName');
    const ptVersion = text(input.ptVersion, 'ptVersion');
    const sdkVersion = text(input.sdkVersion, 'sdkVersion');
    const os = text(input.os, 'os');
    const deviceName = text(input.deviceName, 'deviceName');

    const tlv147 = Buffer.concat([u32(input.appId), prefix(ptVersion), prefix(signature)]);
    const tlv128 = Buffer.concat([
        Buffer.alloc(9),
        prefix(os),
        prefix(guid),
        prefix(Buffer.alloc(0)),
    ]);
    const tlv142 = Buffer.concat([Buffer.alloc(2), prefix(packageName)]);
    const tlv177 = Buffer.concat([Buffer.from([1]), Buffer.alloc(4), prefix(sdkVersion)]);

    for (const [tag, value] of [
        ['0x147', tlv147],
        ['0x128', tlv128],
        ['0x142', tlv142],
        ['0x177', tlv177],
    ] as const) {
        valueLength(value, tag);
    }

    const inner = encodeWtTlv([
        { tag: 0x16e, value: deviceName },
        { tag: 0x147, value: tlv147 },
        { tag: 0x128, value: tlv128 },
        { tag: 0x124, value: tlv124 },
    ]);
    const cipherLength = Math.ceil((inner.length + 10) / 8) * 8;
    uint(cipherLength, MAX_U16, 'TLV 0x144 length');

    // Snapshot all numerical fields before the callback can mutate the input object.
    const tlv116 = Buffer.concat([
        Buffer.from([0]),
        u32(input.miscBitMap),
        u32(input.subSigMap),
        Buffer.from([0]),
    ]);
    const tlv018 = Buffer.concat([
        Buffer.alloc(2),
        u32(5),
        u32(0),
        u32(8001),
        u32(input.uin),
        Buffer.alloc(4),
    ]);
    const tlv100 = Buffer.concat([
        Buffer.alloc(2),
        u32(5),
        u32(input.appId),
        u32(input.subAppId),
        u32(input.appClientVersion),
        u32(input.mainSigMap),
    ]);
    const randomSource = input.randomSource;
    const encrypted = qqTeaEncrypt(inner, tgtgtKey, randomSource);
    const entries: WtTlvEntry[] = [
        { tag: 0x106, value: a1 },
        { tag: 0x144, value: encrypted },
        { tag: 0x116, value: tlv116 },
        { tag: 0x142, value: tlv142 },
        { tag: 0x145, value: guid },
        { tag: 0x018, value: tlv018 },
        {
            tag: 0x141,
            value: Buffer.concat([
                Buffer.alloc(2),
                prefix(Buffer.from('Unknown')),
                Buffer.alloc(4),
            ]),
        },
        { tag: 0x177, value: tlv177 },
        { tag: 0x191, value: Buffer.from([0]) },
        { tag: 0x100, value: tlv100 },
        { tag: 0x107, value: Buffer.from([0, 1, 13, 0, 0, 1]) },
        { tag: 0x318, value: Buffer.alloc(0) },
        { tag: 0x16a, value: noPicSig },
        { tag: 0x166, value: Buffer.from([5]) },
        { tag: 0x521, value: Buffer.concat([u32(0x13), prefix(Buffer.from('basicim'))]) },
    ];
    return Buffer.concat([Buffer.from([0, 9]), encodeWtTlv(entries)]);
}
