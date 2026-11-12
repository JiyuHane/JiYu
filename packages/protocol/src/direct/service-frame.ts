import { qqTeaDecrypt, qqTeaEncrypt } from './qq-tea';

// The outer service framing here follows the public static reference below;
// it has not been validated against the selected QQ build or a live server.
// Request and response header layouts intentionally differ.
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Struct/ServicePacker.cs
export const MAX_SERVICE_FRAME_BYTES = 16 * 1024 * 1024;
const ZERO_KEY = new Uint8Array(16);

export type ServiceEncryption =
    { type: 'none' } | { type: 'zero' } | { type: 'd2'; key: Uint8Array };

type ServiceRequestBase = {
    uin: string;
    encryption: ServiceEncryption;
    body: Uint8Array;
};

export type ServiceRequest = ServiceRequestBase &
    ({ protocol: 12; d2: Uint8Array } | { protocol: 13; sequence: number });

export interface ServiceResponse {
    protocol: 12 | 13;
    encryption: 'none' | 'zero' | 'd2';
    dummy: number;
    uin: string;
    body: Uint8Array;
}

function encodeUin(uin: string): Buffer {
    if (!/^[0-9]{1,20}$/.test(uin)) {
        throw new Error('invalid service UIN');
    }

    return Buffer.from(uin, 'ascii');
}

function encryptionFlag(encryption: ServiceEncryption): number {
    switch (encryption.type) {
        case 'none':
            return 0;
        case 'd2':
            return 1;
        case 'zero':
            return 2;
    }
}

/** Encode one complete outbound service frame, including its four-byte length. */
export function encodeServiceRequest(request: ServiceRequest): Uint8Array {
    const uin = encodeUin(request.uin);

    if (request.protocol === 12 && request.encryption.type !== 'd2' && request.d2.length !== 0) {
        throw new Error('D2 ticket requires D2 encryption');
    }

    if (
        request.protocol === 13 &&
        (!Number.isInteger(request.sequence) ||
            request.sequence < -0x80000000 ||
            request.sequence > 0x7fffffff)
    ) {
        throw new RangeError('service sequence must fit in signed 32 bits');
    }

    const d2 = request.protocol === 12 && request.encryption.type === 'd2' ? request.d2 : null;
    const plainLength = request.body.length;
    const cipherLength =
        request.encryption.type === 'none' ? plainLength : Math.ceil((plainLength + 10) / 8) * 8;
    const headerLength = 4 + 4 + 1 + 4 + (d2?.length ?? 0) + 1 + 4 + uin.length;

    if (headerLength + cipherLength > MAX_SERVICE_FRAME_BYTES) {
        throw new RangeError('service frame exceeds size limit');
    }

    const body =
        request.encryption.type === 'none'
            ? request.body
            : qqTeaEncrypt(
                  request.body,
                  request.encryption.type === 'zero' ? ZERO_KEY : request.encryption.key,
              );
    const frame = Buffer.allocUnsafe(headerLength + body.length);
    let offset = 0;
    frame.writeUInt32BE(frame.length, offset);
    offset += 4;
    frame.writeInt32BE(request.protocol, offset);
    offset += 4;
    frame.writeUInt8(encryptionFlag(request.encryption), offset++);

    if (request.protocol === 12) {
        frame.writeUInt32BE(4 + (d2?.length ?? 0), offset);
        offset += 4;

        if (d2) {
            frame.set(d2, offset);
            offset += d2.length;
        }
    } else {
        frame.writeInt32BE(request.sequence, offset);
        offset += 4;
    }

    frame.writeUInt8(0, offset++);
    frame.writeUInt32BE(uin.length + 4, offset);
    offset += 4;
    frame.set(uin, offset);
    offset += uin.length;
    frame.set(body, offset);
    return frame;
}

/**
 * Parse one complete inbound service frame. Compare its UIN with the account
 * owning the connection before dispatching the decoded payload. QQ-TEA has no
 * authentication and must not be used as proof of message integrity.
 */
export function decodeServiceResponse(frame: Uint8Array, d2Key?: Uint8Array): ServiceResponse {
    if (frame.length < 14 || frame.length > MAX_SERVICE_FRAME_BYTES) {
        throw new Error('invalid service frame');
    }

    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const length = view.getUint32(0);
    const protocol = view.getInt32(4);
    const flag = view.getUint8(8);
    const dummy = view.getUint8(9);
    const uinFieldLength = view.getUint32(10);

    if (
        length !== frame.length ||
        (protocol !== 12 && protocol !== 13) ||
        uinFieldLength < 4 ||
        uinFieldLength > frame.length - 10
    ) {
        throw new Error('invalid service frame');
    }

    const bodyOffset = 10 + uinFieldLength;
    const uinBytes = frame.subarray(14, bodyOffset);

    if (uinBytes.some((byte) => byte < 0x30 || byte > 0x39)) {
        throw new Error('invalid service UIN');
    }

    const uin = Buffer.from(uinBytes).toString('ascii');
    encodeUin(uin);
    const payload = frame.subarray(bodyOffset);
    let encryption: ServiceResponse['encryption'];
    let body: Uint8Array;

    if (flag === 0) {
        encryption = 'none';
        body = Uint8Array.from(payload);
    } else if (flag === 1) {
        if (!d2Key) {
            throw new Error('missing D2 key');
        }

        encryption = 'd2';
        body = qqTeaDecrypt(payload, d2Key);
    } else if (flag === 2) {
        encryption = 'zero';
        body = qqTeaDecrypt(payload, ZERO_KEY);
    } else {
        throw new Error('unknown service encryption');
    }

    return { protocol, encryption, dummy, uin, body };
}
