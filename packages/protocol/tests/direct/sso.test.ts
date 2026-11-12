import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeSsoResponse, encodeSso12Request, encodeSso13Request } from '../../src/direct/sso';

// Synthetic fixtures derived by reading the field order in the public reference.
// These are not captures or verified interoperability with the specified QQ build.
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Struct/SsoPacker.cs
const response = Buffer.from(
    '00000021000000010000000000000004000000054100000004000000000000000400000006dead',
    'hex',
);

describe('inner SSO codec', () => {
    it('encodes a protocol-12 request with inclusive length prefixes', () => {
        const result = encodeSso12Request({
            sequence: 1,
            subAppId: 2,
            a2: new Uint8Array(),
            command: 'A',
            guid: Uint8Array.of(0xab),
            version: 'V',
            reserved: new Uint8Array(),
            body: Uint8Array.of(0xde, 0xad),
        });
        expect(Buffer.from(result).toString('hex')).toBe(
            '0000003a000000010000000200000804020000000000000000000000' +
                '00000004000000054100000004000000066162000000040003560000000400000006dead',
        );
    });

    it('encodes a protocol-13 request without inserting a sequence', () => {
        expect(
            Buffer.from(
                encodeSso13Request({
                    command: 'A',
                    reserved: new Uint8Array(),
                    body: Uint8Array.of(0xde, 0xad),
                }),
            ).toString('hex'),
        ).toBe('000000110000000541000000040000000400000006dead');
    });

    it('decodes a response independently of the request format', () => {
        const actual = decodeSsoResponse(response);
        expect(actual).toEqual({
            sequence: 1,
            retCode: 0,
            extra: '',
            command: 'A',
            cookie: new Uint8Array(),
            dataFlag: 0,
            reserved: new Uint8Array(),
            body: Uint8Array.of(0xde, 0xad),
            headerExtension: new Uint8Array(),
        });
        const copy = Buffer.from(response);
        const parsed = decodeSsoResponse(copy);
        copy.fill(0);
        expect(parsed.body).toEqual(Uint8Array.of(0xde, 0xad));
    });

    it('handles compressed responses and retains error codes', () => {
        const body = deflateSync(Buffer.from('hello'));
        const header = Buffer.from(response.subarray(0, 33));
        header.writeInt32BE(-12, 8);
        header.writeInt32BE(1, 25);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(body.length + 4);
        const parsed = decodeSsoResponse(Buffer.concat([header, length, body]));
        expect(parsed.retCode).toBe(-12);
        expect(Buffer.from(parsed.body).toString()).toBe('hello');
    });

    it('accepts the uncompressed flag 4 and preserves header extension bytes', () => {
        const baseHeader = Buffer.from(response.subarray(0, 33));
        baseHeader.writeUInt32BE(35, 0);
        baseHeader.writeInt32BE(4, 25);
        const parsed = decodeSsoResponse(
            Buffer.concat([baseHeader, Buffer.from([8, 9]), response.subarray(33)]),
        );
        expect(parsed.dataFlag).toBe(4);
        expect(parsed.headerExtension).toEqual(Uint8Array.of(8, 9));
        expect(parsed.body).toEqual(Uint8Array.of(0xde, 0xad));
    });

    it('rejects truncation, invalid lengths, extra data and unsupported flags', () => {
        for (let length = 0; length < response.length; length++) {
            expect(() => decodeSsoResponse(response.subarray(0, length))).toThrow();
        }

        const badLength = Buffer.from(response);
        badLength.writeUInt32BE(3, 0);
        expect(() => decodeSsoResponse(badLength)).toThrow(/length/);

        for (const offset of [12, 16, 21, 29]) {
            for (const length of [0, 1, 2, 3, 0xffffffff]) {
                const badField = Buffer.from(response);
                badField.writeUInt32BE(length, offset);
                expect(() => decodeSsoResponse(badField)).toThrow();
            }
        }

        const badUtf8 = Buffer.from(response);
        badUtf8[20] = 0xff;
        expect(() => decodeSsoResponse(badUtf8)).toThrow();
        const badFlag = Buffer.from(response);
        badFlag.writeInt32BE(7, 25);
        expect(() => decodeSsoResponse(badFlag)).toThrow(/flag/);
        expect(() => decodeSsoResponse(Buffer.concat([response, Buffer.of(0)]))).toThrow(
            /trailing/,
        );
    });

    it('rejects malformed compressed bodies and bounds inflated output', () => {
        const header = Buffer.from(response.subarray(0, 33));
        header.writeInt32BE(1, 25);
        expect(() => decodeSsoResponse(Buffer.concat([header, response.subarray(33)]))).toThrow();
        const compressed = deflateSync(Buffer.alloc(16 * 1024 * 1024 + 1));
        const size = Buffer.alloc(4);
        size.writeUInt32BE(compressed.length + 4);
        expect(() => decodeSsoResponse(Buffer.concat([header, size, compressed]))).toThrow();
    });

    it('validates numeric and field bounds', () => {
        const base = {
            sequence: 1,
            subAppId: 2,
            a2: new Uint8Array(),
            command: 'A',
            guid: Uint8Array.of(0xab),
            version: 'V',
            reserved: new Uint8Array(),
            body: new Uint8Array(),
        };
        expect(() => encodeSso12Request({ ...base, sequence: 0x80000000 })).toThrow(/32 bits/);
        expect(() => encodeSso12Request({ ...base, version: 'A'.repeat(65534) })).toThrow(/limit/);
        expect(() =>
            encodeSso13Request({
                command: 'A',
                reserved: new Uint8Array(),
                body: new Uint8Array(16 * 1024 * 1024),
            }),
        ).toThrow(/limit/);
    });
});
