import { qqTeaDecrypt, qqTeaEncrypt } from './qq-tea';
import { createWtEcdh } from './wt-ecdh';

// Source-level reference only; not validated against the target QQ client:
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Login/WtLogin.cs
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Utility/Binary/BinaryPacket.cs
// QQ-TEA is unauthenticated: a valid trailer does not authenticate the peer.

type WtEcdh = ReturnType<typeof createWtEcdh>;
type RandomSource = (length: number) => Uint8Array;

export type WtOicqRequestEncryption =
    | { method: 0x07 | 0x87; ecdh: WtEcdh; peerPublicKey: Uint8Array }
    | { method: 0x45; key: Uint8Array };

export type WtOicqRequestHead =
    | { type: 'ecdh'; randomKey: Uint8Array; publicKey: Uint8Array }
    | { type: 'session'; ticket: Uint8Array };

export interface WtCode2dRequest {
    timestamp: number;
    command: number;
    unknown21: Uint8Array;
    uin: bigint;
    body: Uint8Array;
    appId: number;
    innerEncryption: { type: 'none' } | { type: 'st'; key: Uint8Array; ticket: Uint8Array };
    clientVersion: number;
    encryption: WtOicqRequestEncryption;
    head: WtOicqRequestHead;
    randomSource?: RandomSource;
}

export interface WtOicqResponseKeys {
    sharedKey?: Uint8Array;
    randomKey?: Uint8Array;
    sessionKey?: Uint8Array;
    ecdh?: WtEcdh;
}

function integer(value: number, max: number, name: string): void {
    if (!Number.isInteger(value) || value < 0 || value > max) {
        throw new RangeError(`invalid ${name}`);
    }
}

function bytes(value: Uint8Array, name: string, max = 0xffff): void {
    if (!(value instanceof Uint8Array) || value.length > max) {
        throw new RangeError(`invalid ${name}`);
    }
}

function key(value: Uint8Array | undefined, name: string): Uint8Array {
    if (!(value instanceof Uint8Array) || value.length !== 16) {
        throw new RangeError(`invalid ${name} key`);
    }

    return value;
}

function view(input: Uint8Array): DataView {
    return new DataView(input.buffer, input.byteOffset, input.byteLength);
}

/** Build the complete 0x812 request. Unknown skipped bytes are always caller supplied. */
export function encodeWtCode2dRequest(request: WtCode2dRequest): Uint8Array {
    integer(request.timestamp, 0xffffffff, 'timestamp');
    integer(request.command, 0xffff, 'command');
    integer(request.appId, 0xffffffff, 'app id');
    integer(request.clientVersion, 0xffff, 'client version');

    if (typeof request.uin !== 'bigint' || request.uin < 0n || request.uin > 0x7fffffffffffffffn) {
        throw new RangeError('invalid UIN');
    }

    bytes(request.unknown21, 'unknown 21 bytes', 21);

    if (request.unknown21.length !== 21) {
        throw new RangeError('unknown bytes must be exactly 21 bytes');
    }

    bytes(request.body, 'code2d body');

    const innerLength = 48 + request.body.length;

    if (innerLength - 4 > 0xffff) {
        throw new RangeError('code2d request exceeds length limit');
    }

    const inner = Buffer.alloc(innerLength);
    inner.writeUInt32BE(request.timestamp, 0);
    inner[4] = 2;
    inner.writeUInt16BE(innerLength - 4, 5); // from marker through end, includes prefix
    inner.writeUInt16BE(request.command, 7);
    inner.set(request.unknown21, 9);
    inner[30] = 3;
    inner.writeUInt16BE(0x32, 33);
    inner.writeBigUInt64BE(request.uin, 39);
    inner.set(request.body, 47);
    inner[inner.length - 1] = 3;

    const innerEncryption = request.innerEncryption;
    let st: Uint8Array;
    let wrapped: Uint8Array;

    if (innerEncryption.type === 'none') {
        st = new Uint8Array();
        wrapped = inner;
    } else if (innerEncryption.type === 'st') {
        bytes(innerEncryption.ticket, 'ST ticket');
        st = innerEncryption.ticket;
        wrapped = qqTeaEncrypt(inner, key(innerEncryption.key, 'ST'), request.randomSource);
    } else {
        throw new Error('unknown code2d encryption');
    }

    if (wrapped.length > 0xffff) {
        throw new RangeError('code2d layer exceeds length limit');
    }

    const payloadLength = 14 + st.length + wrapped.length;
    const payload = Buffer.alloc(payloadLength);
    payload[0] = innerEncryption.type === 'st' ? 1 : 0;
    payload.writeUInt16BE(wrapped.length, 1); // body length excludes its prefix
    payload.writeUInt32BE(request.appId, 3);
    payload.writeUInt32BE(0x72, 7);
    payload.writeUInt16BE(st.length, 11);
    payload.set(st, 13);
    // Empty rollback has its one-byte length immediately before wrapped.
    payload.set(wrapped, 14 + st.length);

    let teaKey: Uint8Array;
    const encryption = request.encryption;

    if (encryption.method === 0x07 || encryption.method === 0x87) {
        teaKey = encryption.ecdh.deriveTeaKey(encryption.peerPublicKey);
    } else if (encryption.method === 0x45) {
        teaKey = key(encryption.key, 'request');
    } else {
        throw new Error('unknown request encryption');
    }

    let head: Buffer;

    if (request.head.type === 'session') {
        bytes(request.head.ticket, 'WT session ticket');
        head = Buffer.alloc(2 + request.head.ticket.length);
        head.writeUInt16BE(request.head.ticket.length, 0);
        head.set(request.head.ticket, 2);
    } else if (request.head.type === 'ecdh') {
        key(request.head.randomKey, 'random');
        bytes(request.head.publicKey, 'public key');
        head = Buffer.alloc(22 + request.head.publicKey.length);
        head[0] = 1;
        head[1] = 1;
        head.set(request.head.randomKey, 2);
        head.writeUInt16BE(0x102, 18);
        head.writeUInt16BE(request.head.publicKey.length, 20);
        head.set(request.head.publicKey, 22);
    } else {
        throw new Error('unknown request encryption head');
    }

    const cipherLength = Math.ceil((payload.length + 10) / 8) * 8;
    const length = 27 + head.length + cipherLength;

    if (length > 0xffff) {
        throw new RangeError('OICQ request exceeds length limit');
    }

    const cipher = qqTeaEncrypt(payload, teaKey, request.randomSource);
    const packet = Buffer.alloc(length);
    packet[0] = 2;
    packet.writeUInt16BE(length, 1); // inclusive: marker + prefix + remainder
    packet.writeUInt16BE(8001, 3);
    packet.writeUInt16BE(0x812, 5);
    packet.writeUInt32BE(Number(request.uin & 0xffffffffn), 9);
    packet[13] = 3;
    packet[14] = encryption.method;
    packet[19] = 2;
    packet.writeUInt16BE(request.clientVersion, 22);
    packet.set(head, 26);
    packet.set(cipher, 26 + head.length);
    packet[length - 1] = 3;
    return packet;
}

/** Decode the asymmetric inbound OICQ envelope. Caller must bind UIN/sequence to its context. */
export function decodeWtOicqResponse(
    input: Uint8Array,
    keys: WtOicqResponseKeys,
): {
    version: number;
    command: number;
    sequence: number;
    uin: number;
    flag: number;
    encryptType: number;
    state: number;
    body: Uint8Array;
} {
    bytes(input, 'OICQ response');

    if (
        input.length < 33 ||
        input[0] !== 2 ||
        input[input.length - 1] !== 3 ||
        view(input).getUint16(1) !== input.length
    ) {
        throw new Error('invalid OICQ response frame');
    }

    const data = view(input);
    const encryptType = input[14];
    const state = input[15];
    let cipher = input.subarray(16, input.length - 1);
    let decryptKey: Uint8Array;

    if (encryptType === 0) {
        decryptKey = state === 180 ? key(keys.randomKey, 'random') : key(keys.sharedKey, 'shared');
    } else if (encryptType === 3) {
        decryptKey = key(keys.sessionKey, 'session');
    } else if (encryptType === 4) {
        const outer = qqTeaDecrypt(cipher, key(keys.sharedKey, 'shared'));

        if (outer.length < 2) {
            throw new Error('truncated OICQ temporary public key');
        }

        // BinaryPacket.ReadLength uses signed Int16 for the public key prefix.
        const length = view(outer).getInt16(0);

        if (length <= 0 || length > outer.length - 2 || !keys.ecdh) {
            throw new Error('invalid OICQ temporary public key');
        }

        decryptKey = keys.ecdh.deriveTeaKey(outer.subarray(2, 2 + length));
        cipher = outer.subarray(2 + length);
    } else {
        throw new Error('unknown OICQ response encryption');
    }

    const body = qqTeaDecrypt(cipher, decryptKey);
    return {
        version: data.getUint16(3),
        command: data.getUint16(5),
        sequence: data.getUint16(7),
        uin: data.getUint32(9),
        flag: input[13],
        encryptType,
        state,
        body,
    };
}

/** Decode the response-only code2d layer; byte 0 and byte 4 retain unknown meaning. */
export function decodeWtCode2dResponse(
    input: Uint8Array,
    stKey?: Uint8Array,
): {
    prefix: number;
    marker: number;
    encrypted: boolean;
    header: number;
    declaredLength: number;
    command: number;
    unknown21: Uint8Array;
    flag: number;
    retryTime: number;
    version: number;
    sequence: number;
    uin: bigint;
    body: Uint8Array;
} {
    bytes(input, 'code2d response');

    if (input.length < 5) {
        throw new Error('truncated code2d response');
    }

    const length = view(input).getInt16(2);

    if (length < 0 || length !== input.length - 5 || (input[1] !== 0 && input[1] !== 1)) {
        throw new Error('invalid code2d response layer');
    }

    const layer =
        input[1] === 0
            ? Uint8Array.from(input.subarray(5))
            : qqTeaDecrypt(input.subarray(5), key(stKey, 'ST'));

    if (layer.length < 43) {
        throw new Error('truncated code2d response body');
    }

    const data = view(layer);
    // The reference reads but never checks this inner length; preserve it as opaque.
    return {
        prefix: input[0],
        marker: input[4],
        encrypted: input[1] === 1,
        header: layer[0],
        declaredLength: data.getUint16(1),
        command: data.getUint16(3),
        unknown21: Uint8Array.from(layer.subarray(5, 26)),
        flag: layer[26],
        retryTime: data.getUint16(27),
        version: data.getUint16(29),
        sequence: data.getUint32(31),
        uin: data.getBigInt64(35),
        body: Uint8Array.from(layer.subarray(43)),
    };
}
