import { describe, expect, it } from 'vitest';
import { qqTeaDecrypt } from '../../src/direct/qq-tea';
import {
    encodeWtLoginRequestBody,
    type WtLoginRequestBody,
} from '../../src/direct/wt-login-request';
import { decodeWtTlv } from '../../src/direct/wt-tlv';

// Entirely synthetic. The encrypted 0x144 value was calculated separately with
// a standalone 16-cycle TEA/feedback implementation and fixed f8/zero prefix.
// This is not an upstream capture or evidence of server acceptance.
const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const innerVector = Buffer.from(
    '0004016e0001440147000b112233440001760002ccdd' +
        '0128001200000000000000000000014c0002aabb0000' +
        '0124000c000102030405060708090a0b',
    'hex',
);
const cipherVector =
    '955abf5506096bacac66692532a868cf9a458f0e4e1550f29969d3780269e28c' +
    '901f9640f813df993361ec495f4aecbbd7fd0ce9b7c5b05dd6bc3d261f9a2abb' +
    '06b497ce0a6cf78a';
const requestVector = Buffer.from(
    [
        '0009000f',
        '01060002dead',
        '01440048' + cipherVector,
        '0116000a00010203040506070800',
        '014200050000000170',
        '01450002aabb',
        '001800160000000000050000000000001f410102030400000000',
        '0141000f00000007556e6b6e6f776e00000000',
        '017700080100000000000173',
        '0191000100',
        '01000016000000000005112233445566778800001234090a0b0c',
        '0107000600010d000001',
        '03180000',
        '016a0002beef',
        '0166000105',
        '0521000d0000001300076261736963696d',
    ].join(''),
    'hex',
);

function fixtureRandom(length: number): Uint8Array {
    const result = new Uint8Array(length);
    result[0] = 0xf8;
    return result;
}

function fixture(): WtLoginRequestBody {
    return {
        uin: 0x01020304,
        appId: 0x11223344,
        subAppId: 0x55667788,
        appClientVersion: 0x1234,
        mainSigMap: 0x090a0b0c,
        miscBitMap: 0x01020304,
        subSigMap: 0x05060708,
        packageName: 'p',
        ptVersion: 'v',
        sdkVersion: 's',
        os: 'L',
        deviceName: 'D',
        guid: Buffer.from('aabb', 'hex'),
        apkSignature: Buffer.from('ccdd', 'hex'),
        temporaryA1: Buffer.from('dead', 'hex'),
        noPicSig: Buffer.from('beef', 'hex'),
        tgtgtKey: Buffer.from(key),
        tlv124Value: Buffer.from('000102030405060708090a0b', 'hex'),
        randomSource: fixtureRandom,
    };
}

function tlvs(request: Uint8Array) {
    return decodeWtTlv(request.subarray(2));
}

describe('PC WT login subcommand 9 business body', () => {
    it('matches an independently assembled complete 15-TLV fixture', () => {
        const actual = encodeWtLoginRequestBody(fixture());
        expect(Buffer.from(actual)).toEqual(requestVector);
        expect(Buffer.from(actual.subarray(0, 4)).toString('hex')).toBe('0009000f');
        const fields = tlvs(actual);
        expect(fields.map(({ tag }) => tag)).toEqual([
            0x106, 0x144, 0x116, 0x142, 0x145, 0x018, 0x141, 0x177, 0x191, 0x100, 0x107, 0x318,
            0x16a, 0x166, 0x521,
        ]);
        const inner = qqTeaDecrypt(fields[1].value, key);
        expect(Buffer.from(inner)).toEqual(innerVector);
        expect(decodeWtTlv(inner).map(({ tag }) => tag)).toEqual([0x16e, 0x147, 0x128, 0x124]);
    });

    it('preserves utf8 byte lengths and arbitrary caller-provided 0x124 bytes', () => {
        const input = {
            ...fixture(),
            packageName: '包',
            ptVersion: 'é',
            sdkVersion: 'é',
            os: 'é',
            deviceName: '设备',
            tlv124Value: new Uint8Array(12).fill(0xa5),
        };
        const fields = tlvs(encodeWtLoginRequestBody(input));
        expect(Buffer.from(fields[3].value).toString('hex')).toBe('00000003e58c85');
        expect(Buffer.from(fields[7].value).toString('hex')).toBe('01000000000002c3a9');
        const nested = decodeWtTlv(qqTeaDecrypt(fields[1].value, key));
        expect(Buffer.from(nested[0].value).toString('hex')).toBe('e8aebee5a487');
        expect(Buffer.from(nested[1].value).toString('hex')).toBe('112233440002c3a90002ccdd');
        expect(Buffer.from(nested[3].value)).toEqual(Buffer.alloc(12, 0xa5));
    });

    it('uses a fresh random prefix by default and accepts injected randomness', () => {
        const input = fixture();
        const first = encodeWtLoginRequestBody({
            ...input,
            randomSource: (n) => new Uint8Array(n),
        });
        const second = encodeWtLoginRequestBody({
            ...input,
            randomSource: (n) => new Uint8Array(n).fill(0x55),
        });
        expect(first).not.toEqual(second);
        expect(Buffer.from(qqTeaDecrypt(tlvs(first)[1].value, key))).toEqual(innerVector);
        expect(Buffer.from(qqTeaDecrypt(tlvs(second)[1].value, key))).toEqual(innerVector);
        const random = encodeWtLoginRequestBody({ ...input, randomSource: undefined });
        expect(Buffer.from(qqTeaDecrypt(tlvs(random)[1].value, key))).toEqual(innerVector);
    });

    it('takes independent copies even if the callback mutates the input', () => {
        const input = fixture();
        const arrays = [
            input.guid,
            input.apkSignature,
            input.temporaryA1,
            input.noPicSig,
            input.tgtgtKey,
            input.tlv124Value,
        ];
        const originals = arrays.map((item) => Uint8Array.from(item));

        input.randomSource = (n) => {
            arrays.forEach((item) => item.fill(0));
            input.uin = 0;
            input.appId = 0;
            input.mainSigMap = 0;
            return fixtureRandom(n);
        };

        const result = encodeWtLoginRequestBody(input);
        expect(Buffer.from(result)).toEqual(requestVector);
        result.fill(0);
        expect(arrays.map((item) => Uint8Array.from(item))).toEqual(
            originals.map((item) => new Uint8Array(item.length)),
        );
    });

    it('rejects key, byte-field and callback lengths without echoing secrets', () => {
        const input = fixture();

        for (const length of [0, 15, 17]) {
            expect(() =>
                encodeWtLoginRequestBody({ ...input, tgtgtKey: new Uint8Array(length) }),
            ).toThrow(/tgtgtKey/);
        }

        for (const field of ['guid', 'temporaryA1', 'noPicSig'] as const) {
            expect(() =>
                encodeWtLoginRequestBody({ ...input, [field]: new Uint8Array() }),
            ).toThrow();
            expect(() =>
                encodeWtLoginRequestBody({ ...input, [field]: new Uint8Array(65536) }),
            ).toThrow();
            expect(() =>
                encodeWtLoginRequestBody({ ...input, [field]: null as unknown as Uint8Array }),
            ).toThrow();
        }

        for (const length of [0, 11, 13]) {
            expect(() =>
                encodeWtLoginRequestBody({ ...input, tlv124Value: new Uint8Array(length) }),
            ).toThrow();
        }

        expect(() =>
            encodeWtLoginRequestBody({ ...input, apkSignature: new Uint8Array(65536) }),
        ).toThrow();
        expect(() =>
            encodeWtLoginRequestBody({ ...input, randomSource: (n) => new Uint8Array(n - 1) }),
        ).toThrow(/random/);
        expect(() =>
            encodeWtLoginRequestBody({
                ...input,
                randomSource: null as unknown as (n: number) => Uint8Array,
            }),
        ).toThrow(/random/);

        try {
            encodeWtLoginRequestBody({ ...input, tgtgtKey: Buffer.from('secret', 'utf8') });
            throw new Error('expected failure');
        } catch (error) {
            expect(String(error)).not.toContain('secret');
            expect(String(error)).not.toContain('dead');
        }
    });

    it('rejects integer truncation, oversize UTF-8 and oversized compound TLVs', () => {
        const input = fixture();

        for (const field of [
            'uin',
            'appId',
            'subAppId',
            'mainSigMap',
            'miscBitMap',
            'subSigMap',
        ] as const) {
            for (const invalid of [-1, 0x100000000, 0.5, NaN, Infinity]) {
                expect(() => encodeWtLoginRequestBody({ ...input, [field]: invalid })).toThrow();
            }
        }

        for (const invalid of [-1, 65536, 0.5, NaN]) {
            expect(() =>
                encodeWtLoginRequestBody({ ...input, appClientVersion: invalid }),
            ).toThrow();
        }

        for (const field of [
            'packageName',
            'ptVersion',
            'sdkVersion',
            'os',
            'deviceName',
        ] as const) {
            expect(() =>
                encodeWtLoginRequestBody({ ...input, [field]: 'é'.repeat(32768) }),
            ).toThrow();
            expect(() =>
                encodeWtLoginRequestBody({ ...input, [field]: null as unknown as string }),
            ).toThrow();
        }

        expect(() =>
            encodeWtLoginRequestBody({ ...input, packageName: 'x'.repeat(65532) }),
        ).toThrow(/0x142/);
        expect(() => encodeWtLoginRequestBody({ ...input, ptVersion: 'x'.repeat(65530) })).toThrow(
            /0x147/,
        );
        expect(() => encodeWtLoginRequestBody({ ...input, deviceName: 'x'.repeat(65500) })).toThrow(
            /0x144/,
        );
        expect(() => encodeWtLoginRequestBody({ ...input, os: 'x'.repeat(65525) })).toThrow(
            /0x128/,
        );
    });

    it('enforces the exact nested encrypted TLV size boundary', () => {
        const input = fixture();
        // Fixture inner length is 60 bytes with a one-byte device name. At
        // 65518 inner bytes the QQ-TEA cipher is 65528 bytes (largest multiple
        // of eight that fits a u16 value length).
        const max = encodeWtLoginRequestBody({ ...input, deviceName: 'x'.repeat(65459) });
        expect(tlvs(max)[1].value).toHaveLength(65528);
        expect(() => encodeWtLoginRequestBody({ ...input, deviceName: 'x'.repeat(65460) })).toThrow(
            /0x144/,
        );
    });

    it('rejects truncated and trailing TLV bodies rather than accepting partial output', () => {
        for (let length = 0; length < requestVector.length - 2; length++) {
            expect(() => decodeWtTlv(requestVector.subarray(2, 2 + length))).toThrow();
        }

        expect(() =>
            decodeWtTlv(Buffer.concat([requestVector.subarray(2), Buffer.from([0])])),
        ).toThrow(/trailing/);
    });
});
