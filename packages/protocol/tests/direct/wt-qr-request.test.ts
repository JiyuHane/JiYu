import { describe, expect, it } from 'vitest';
import {
    encodeWtQrFetchBody,
    encodeWtQrPollBody,
    type WtQrFetchBody,
} from '../../src/direct/wt-qr-request';
import { decodeWtTlv } from '../../src/direct/wt-tlv';

// Hand-derived synthetic fixtures, not captured packets. Lengths cover values only.
const fetchVector = Buffer.from(
    [
        '0000',
        '01020304',
        '0000000000000000',
        '00',
        '0000',
        '0007',
        '0016',
        '0019',
        '00000000',
        '01020304',
        'a1a2a3a4',
        'abcd',
        '0002c3a9',
        '000178',
        '0002c3a9',
        '001b',
        '001e',
        '00000000',
        '00000000',
        '00000003',
        '00000004',
        '00000048',
        '00000002',
        '00000002',
        '0000',
        '001d',
        '000a',
        '01',
        '11223344',
        '00000000',
        '00',
        '0033',
        '0002',
        'abcd',
        '0035',
        '0004',
        '55667788',
        '0066',
        '0004',
        '55667788',
        '00d1',
        '0003',
        '080196',
    ].join(''),
    'hex',
);
const pollVector = Buffer.from('0000010203040003aabbcc00000000000000000000000000', 'hex');

function fetchInput(): WtQrFetchBody {
    return {
        appId: 0x01020304,
        subAppId: 0xa1a2a3a4,
        guid: Uint8Array.of(0xab, 0xcd),
        packageName: 'é',
        ptVersion: 'x',
        miscBitMap: 0x11223344,
        ssoVersion: 0x55667788,
        d1: Uint8Array.of(8, 1, 0x96),
    };
}

describe('WT QR request business bodies', () => {
    it('encodes every byte of the independently assembled 0x31 vector', () => {
        const actual = encodeWtQrFetchBody(fetchInput());
        expect(Buffer.from(actual)).toEqual(fetchVector);
        expect(decodeWtTlv(actual.subarray(17)).map((entry) => entry.tag)).toEqual([
            0x16, 0x1b, 0x1d, 0x33, 0x35, 0x66, 0xd1,
        ]);
    });

    it('encodes the independently assembled 0x12 vector and empty signature', () => {
        expect(
            Buffer.from(
                encodeWtQrPollBody({ appId: 0x01020304, qrSig: Uint8Array.of(0xaa, 0xbb, 0xcc) }),
            ),
        ).toEqual(pollVector);
        expect(
            Buffer.from(encodeWtQrPollBody({ appId: 0, qrSig: new Uint8Array() })).toString('hex'),
        ).toBe('000000000000000000000000000000000000000000');
    });

    it('omits undefined unusualSig, but includes an empty or nonempty one first', () => {
        const input = fetchInput();
        expect(Buffer.from(encodeWtQrFetchBody({ ...input, unusualSig: undefined }))).toEqual(
            fetchVector,
        );

        for (const signature of [new Uint8Array(), Uint8Array.of(0xff, 0, 0x80)]) {
            const actual = encodeWtQrFetchBody({ ...input, unusualSig: signature });
            expect(Buffer.from(actual.subarray(0, 17))).toEqual(fetchVector.subarray(0, 17));
            expect(Buffer.from(actual.subarray(17))).toEqual(
                Buffer.concat([
                    Buffer.from('00080011', 'hex'),
                    Buffer.from([signature.length >>> 8, signature.length & 255]),
                    signature,
                    fetchVector.subarray(19),
                ]),
            );
        }
    });

    it('accepts u32 endpoints and u16-sized byte values', () => {
        const input = {
            ...fetchInput(),
            appId: 0xffffffff,
            subAppId: 0,
            miscBitMap: 0xffffffff,
            ssoVersion: 0,
        };
        const fields = decodeWtTlv(
            encodeWtQrFetchBody({
                ...input,
                d1: new Uint8Array(0xffff),
                unusualSig: new Uint8Array(0xffff),
            }).subarray(17),
        );
        expect(fields[0].value).toHaveLength(0xffff);
        expect(fields[7].value).toHaveLength(0xffff);
        const sig = new Uint8Array(0xffff).fill(0xa5);
        const poll = encodeWtQrPollBody({ appId: 0xffffffff, qrSig: sig });
        expect(Buffer.from(poll.subarray(0, 8)).toString('hex')).toBe('0000ffffffffffff');
        expect(poll.subarray(8, 8 + sig.length)).toEqual(Buffer.from(sig));
        expect(poll.subarray(8 + sig.length)).toEqual(Buffer.alloc(13));
        const maxGuid = new Uint8Array(0xffff - 18);
        const max16 = encodeWtQrFetchBody({
            ...input,
            guid: maxGuid,
            packageName: '',
            ptVersion: '',
        });
        expect(decodeWtTlv(max16.subarray(17))[0].value).toHaveLength(0xffff);
        expect(() =>
            encodeWtQrFetchBody({
                ...input,
                guid: new Uint8Array(maxGuid.length + 1),
                packageName: '',
                ptVersion: '',
            }),
        ).toThrow(/0x16/);
    });

    it('validates all numeric, byte and UTF-8 length inputs', () => {
        const input = fetchInput();

        for (const field of ['appId', 'subAppId', 'miscBitMap', 'ssoVersion'] as const) {
            for (const invalid of [-1, 0x100000000, 0.5, NaN, Infinity]) {
                expect(() => encodeWtQrFetchBody({ ...input, [field]: invalid })).toThrow();
            }
        }

        for (const invalid of [-1, 0x100000000, 0.5, NaN, Infinity]) {
            expect(() => encodeWtQrPollBody({ appId: invalid, qrSig: new Uint8Array() })).toThrow();
        }

        for (const field of ['guid', 'd1', 'unusualSig'] as const) {
            expect(() =>
                encodeWtQrFetchBody({ ...input, [field]: new Uint8Array(0x10000) }),
            ).toThrow();
            expect(() =>
                encodeWtQrFetchBody({ ...input, [field]: null as unknown as Uint8Array }),
            ).toThrow();
        }

        expect(() => encodeWtQrPollBody({ appId: 0, qrSig: new Uint8Array(0x10000) })).toThrow();
        expect(() =>
            encodeWtQrPollBody({ appId: 0, qrSig: [] as unknown as Uint8Array }),
        ).toThrow();

        for (const field of ['packageName', 'ptVersion'] as const) {
            expect(() => encodeWtQrFetchBody({ ...input, [field]: 'é'.repeat(32768) })).toThrow();
            expect(() =>
                encodeWtQrFetchBody({ ...input, [field]: null as unknown as string }),
            ).toThrow();
        }

        // Each string fits u16, but the complete tag 0x16 does not.
        expect(() => encodeWtQrFetchBody({ ...input, packageName: 'x'.repeat(32760) })).toThrow(
            /0x16/,
        );
    });

    it('copies caller-owned sliced bytes and leaves inputs untouched', () => {
        const backing = Uint8Array.of(0xee, 0xab, 0xcd, 0xff);
        const d1 = Uint8Array.of(1, 2, 3);
        const unusualSig = Uint8Array.of(4, 5);
        const qrSig = Uint8Array.of(6, 7);
        const input = { ...fetchInput(), guid: backing.subarray(1, 3), d1, unusualSig };
        const before = [
            Uint8Array.from(backing),
            Uint8Array.from(d1),
            Uint8Array.from(unusualSig),
            Uint8Array.from(qrSig),
        ];
        const fetch = encodeWtQrFetchBody(input);
        const poll = encodeWtQrPollBody({ appId: 1, qrSig });
        expect([backing, d1, unusualSig, qrSig]).toEqual(before);
        backing.fill(0);
        d1.fill(0);
        unusualSig.fill(0);
        qrSig.fill(0);
        expect(
            decodeWtTlv(fetch.subarray(17)).map((entry) =>
                Buffer.from(entry.value).toString('hex'),
            ),
        ).toMatchObject([
            '0405',
            expect.any(String),
            expect.any(String),
            expect.any(String),
            'abcd',
            expect.any(String),
            expect.any(String),
            '010203',
        ]);
        expect(Buffer.from(poll.subarray(8, 10)).toString('hex')).toBe('0607');
        fetch.fill(0);
        poll.fill(0);
        expect([backing, d1, unusualSig, qrSig]).toEqual(
            before.map((value) => new Uint8Array(value.length)),
        );
    });
});
