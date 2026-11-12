import { describe, expect, it } from 'vitest';
import { qqTeaEncrypt } from '../../src/direct/qq-tea';
import { decodeServiceResponse, encodeServiceRequest } from '../../src/direct/service-frame';
import { decodeSsoResponse } from '../../src/direct/sso';

// Manually derived synthetic vectors, not a capture or target-version proof.
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Struct/ServicePacker.cs
const uin = '123456';
const payload = Buffer.from('deadbeef', 'hex');
const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const response = Buffer.from('000000180000000c00000000000a313233343536deadbeef', 'hex');

function makeResponse(flag: number, data: Uint8Array): Buffer {
    const header = Buffer.from('000000000000000c00000000000a313233343536', 'hex');
    header.writeUInt32BE(header.length + data.length, 0);
    header.writeUInt8(flag, 8);
    return Buffer.concat([header, data]);
}

describe('QQ outer service frames', () => {
    it('encodes the unencrypted protocol-12 request vector', () => {
        const request = encodeServiceRequest({
            protocol: 12,
            encryption: { type: 'none' },
            d2: new Uint8Array(),
            uin,
            body: payload,
        });
        expect(Buffer.from(request).toString('hex')).toBe(
            '0000001c0000000c0000000004000000000a313233343536deadbeef',
        );
    });

    it('encodes the unencrypted protocol-13 request vector', () => {
        const request = encodeServiceRequest({
            protocol: 13,
            encryption: { type: 'none' },
            sequence: 0x01020304,
            uin,
            body: payload,
        });
        expect(Buffer.from(request).toString('hex')).toBe(
            '0000001c0000000d0001020304000000000a313233343536deadbeef',
        );
    });

    it('parses the different inbound header and an inner SSO response', () => {
        expect(decodeServiceResponse(response)).toEqual({
            protocol: 12,
            encryption: 'none',
            dummy: 0,
            uin,
            body: Uint8Array.from(payload),
        });
        const nested = Buffer.from(
            '0000003b0000000c00000000000a3132333435360000002101020304' +
                '00000000000000040000000578000000040000000000000004000000060011',
            'hex',
        );
        const decoded = decodeSsoResponse(decodeServiceResponse(nested).body);
        expect(decoded.sequence).toBe(0x01020304);
        expect(decoded.command).toBe('x');
        expect(decoded.body).toEqual(Uint8Array.of(0, 0x11));
    });

    it('encodes D2 requests with a ticket and uses distinct encryption flags', () => {
        const d2 = encodeServiceRequest({
            protocol: 12,
            encryption: { type: 'd2', key },
            d2: Uint8Array.of(0xaa, 0xbb),
            uin,
            body: payload,
        });
        const view = Buffer.from(d2);
        expect(view[8]).toBe(1);
        expect(view.readUInt32BE(9)).toBe(6);
        expect(view.subarray(13, 15)).toEqual(Buffer.from([0xaa, 0xbb]));
        const encrypted = view.subarray(26);
        expect(decodeServiceResponse(makeResponse(1, encrypted), key).body).toEqual(
            Uint8Array.from(payload),
        );

        const zero = encodeServiceRequest({
            protocol: 13,
            encryption: { type: 'zero' },
            sequence: 1,
            uin,
            body: payload,
        });
        expect(zero[8]).toBe(2);
        expect(decodeServiceResponse(makeResponse(2, zero.subarray(24))).body).toEqual(
            Uint8Array.from(payload),
        );
    });

    it('uses the exact QQ-TEA padded length for every block alignment', () => {
        for (let length = 0; length < 24; length++) {
            const frame = encodeServiceRequest({
                protocol: 13,
                encryption: { type: 'zero' },
                sequence: 1,
                uin,
                body: new Uint8Array(length),
            });
            expect(frame.length).toBe(24 + Math.ceil((length + 10) / 8) * 8);
        }
    });

    it('decodes synthetic zero-key and D2-key encrypted responses', () => {
        const zero = qqTeaEncrypt(payload, new Uint8Array(16));
        expect(decodeServiceResponse(makeResponse(2, zero)).body).toEqual(Uint8Array.from(payload));
        const d2 = qqTeaEncrypt(payload, key);
        expect(decodeServiceResponse(makeResponse(1, d2), key).body).toEqual(
            Uint8Array.from(payload),
        );
        expect(() => decodeServiceResponse(makeResponse(1, d2))).toThrow(/key/);
        expect(() => decodeServiceResponse(makeResponse(2, Buffer.alloc(8)))).toThrow(/ciphertext/);
    });

    it('rejects truncated or malformed frames without accepting a wrong account encoding', () => {
        for (let length = 0; length < response.length; length++) {
            expect(() => decodeServiceResponse(response.subarray(0, length))).toThrow();
        }

        const badUin = Buffer.from(response);
        badUin[14] = 0xb1;
        expect(() => decodeServiceResponse(badUin)).toThrow(/UIN/);
        const badLength = Buffer.from(response);
        badLength.writeUInt32BE(0xffffffff, 10);
        expect(() => decodeServiceResponse(badLength)).toThrow(/frame/);
        const badFlag = Buffer.from(response);
        badFlag[8] = 99;
        expect(() => decodeServiceResponse(badFlag)).toThrow(/encryption/);
    });

    it('validates UIN, sequence, D2 use, keys and frame bounds', () => {
        const base = {
            protocol: 13 as const,
            encryption: { type: 'none' as const },
            sequence: 1,
            uin,
            body: payload,
        };
        expect(() => encodeServiceRequest({ ...base, uin: '12x' })).toThrow(/UIN/);
        expect(() => encodeServiceRequest({ ...base, sequence: 2 ** 31 })).toThrow(/32 bits/);
        expect(() =>
            encodeServiceRequest({ ...base, body: new Uint8Array(16 * 1024 * 1024) }),
        ).toThrow(/limit/);
        expect(() =>
            encodeServiceRequest({
                protocol: 12,
                encryption: { type: 'none' },
                d2: Uint8Array.of(1),
                uin,
                body: payload,
            }),
        ).toThrow(/D2/);
        expect(() =>
            encodeServiceRequest({ ...base, encryption: { type: 'd2', key: new Uint8Array(15) } }),
        ).toThrow(/key/);
    });
});
