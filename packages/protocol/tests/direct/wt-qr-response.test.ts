import { describe, expect, it } from 'vitest';
import { decodeWtQrFetchResponse, decodeWtQrPollResponse } from '../../src/direct/wt-qr-response';

// Independently hand-assembled synthetic business bodies, never QQ traffic.
const fetch = Buffer.from('fffe89abcdef000003aabbcc000200170002112200d10003080103', 'hex');
const confirmed = Buffer.from(
    'fffe89abcdef000020000000000001fffffffe0003001e0010000102030405060708090a0b0c0d0e0f001900020304001800020506',
    'hex',
);
const header = Buffer.from('fffe89abcdef', 'hex');

function pollState(code: number, remaining: number[] = []): Buffer {
    return Buffer.concat([header, Buffer.from([code, ...remaining])]);
}

describe('WT QR response business bodies', () => {
    it('parses a complete fetch result and retains raw D1 ending in 03', () => {
        expect(decodeWtQrFetchResponse(fetch)).toEqual({
            dummy: -2,
            appId: -1985229329,
            retCode: 0,
            status: 'success',
            qrSig: Uint8Array.of(0xaa, 0xbb, 0xcc),
            image: Uint8Array.of(0x11, 0x22),
            d1: Uint8Array.of(8, 1, 3),
        });
    });

    it('parses confirmed UIN losslessly and retains the three named tickets', () => {
        expect(decodeWtQrPollResponse(confirmed)).toEqual({
            dummy: -2,
            appId: -1985229329,
            retCode: 0,
            status: 'confirmed',
            uin: 0x0020000000000001n,
            retry: -2,
            tickets: {
                tgtgtKey: Uint8Array.from({ length: 16 }, (_, i) => i),
                noPicSig: Uint8Array.of(3, 4),
                tempPassword: Uint8Array.of(5, 6),
            },
        });
    });

    it.each([
        [17, 'expired'],
        [48, 'wait'],
        [53, 'confirm'],
        [54, 'canceled'],
        [144, 'invalid'],
        [1, 'unknown'],
        [255, 'unknown'],
    ])('preserves poll status %i and any uninterpreted bytes', (code, status) => {
        expect(decodeWtQrPollResponse(pollState(code, [0xaa, 3]))).toEqual({
            dummy: -2,
            appId: -1985229329,
            retCode: code,
            status,
            remaining: Uint8Array.of(0xaa, 3),
        });
    });

    it('reports every nonzero fetch retCode as failure even with success-looking bytes', () => {
        for (const code of [1, 17, 255]) {
            const failed = Buffer.from(fetch);
            failed[6] = code;
            expect(decodeWtQrFetchResponse(failed)).toEqual({
                dummy: -2,
                appId: -1985229329,
                retCode: code,
                status: 'failure',
                remaining: Uint8Array.from(fetch.subarray(7)),
            });
        }
    });

    it('rejects every truncation of complete success vectors', () => {
        for (let i = 0; i < fetch.length; i++) {
            expect(() => decodeWtQrFetchResponse(fetch.subarray(0, i))).toThrow();
        }

        for (let i = 0; i < confirmed.length; i++) {
            expect(() => decodeWtQrPollResponse(confirmed.subarray(0, i))).toThrow();
        }
    });

    it('requires an exact success body slice and never guesses a 03 trailer', () => {
        for (const extra of [0, 3, 255]) {
            expect(() =>
                decodeWtQrFetchResponse(Buffer.concat([fetch, Buffer.from([extra])])),
            ).toThrow(/trailing/);
            expect(() =>
                decodeWtQrPollResponse(Buffer.concat([confirmed, Buffer.from([extra])])),
            ).toThrow(/trailing/);
        }

        const framed = Buffer.concat([Buffer.from([0x99]), fetch, Buffer.from([3])]);
        expect(decodeWtQrFetchResponse(framed.subarray(1, -1)).status).toBe('success');
    });

    it('rejects malformed signature lengths and size limits', () => {
        for (const prefix of ['0000', '8000', 'ffff', '7fff']) {
            const malformed = Buffer.from(fetch);
            malformed.write(prefix, 7, 'hex');
            expect(() => decodeWtQrFetchResponse(malformed)).toThrow(/signature/);
        }

        expect(() => decodeWtQrFetchResponse(new Uint8Array(0x10000))).toThrow(/size/);
        expect(() => decodeWtQrPollResponse(new Uint8Array(0x10000))).toThrow(/size/);
        expect(() => decodeWtQrPollResponse([] as unknown as Uint8Array)).toThrow(/size/);
    });

    it('accepts the maximum complete body and signed signature length', () => {
        const sig = Buffer.alloc(0x7fff, 0x42);
        const d1 = Buffer.alloc(65535 - 7 - 2 - sig.length - 2 - 5 - 4, 0x03);
        const d1Length = Buffer.alloc(2);
        d1Length.writeUInt16BE(d1.length);
        const input = Buffer.concat([
            header,
            Buffer.from('007fff', 'hex'),
            sig,
            Buffer.from('0002001700010100d1', 'hex'),
            d1Length,
            d1,
        ]);
        expect(input).toHaveLength(65535);
        const result = decodeWtQrFetchResponse(input);
        expect(result.status).toBe('success');

        if (result.status !== 'success') {
            throw new Error('unexpected status');
        }

        expect(result.qrSig).toHaveLength(0x7fff);
        expect(result.d1).toHaveLength(d1.length);
    });

    it('rejects malformed, missing and empty mandatory TLVs', () => {
        const fetchPrefix = fetch.subarray(0, 12);
        const confirmedPrefix = confirmed.subarray(0, 19);

        for (const tlvs of [
            '0001001700021122',
            '00020017000000d1000101',
            '0002001700010100d10000',
            '0002001700050100d1000101',
            '0003001700010100d1000101',
        ]) {
            expect(() =>
                decodeWtQrFetchResponse(Buffer.concat([fetchPrefix, Buffer.from(tlvs, 'hex')])),
            ).toThrow();
        }

        for (const tlvs of [
            '0002001e0010000102030405060708090a0b0c0d0e0f0019000102',
            '0003001e000000190001020018000103',
            '0003001e0010000102030405060708090a0b0c0d0e0f001900000018000103',
            '0003001e0010000102030405060708090a0b0c0d0e0f001900010200180000',
        ]) {
            expect(() =>
                decodeWtQrPollResponse(Buffer.concat([confirmedPrefix, Buffer.from(tlvs, 'hex')])),
            ).toThrow();
        }
    });

    it('rejects duplicate tags including unknown tags, rather than silently picking a winner', () => {
        const repeat = Buffer.from('7777000101', 'hex');

        for (const [vector, countOffset, parser] of [
            [fetch, 12, decodeWtQrFetchResponse],
            [confirmed, 19, decodeWtQrPollResponse],
        ] as const) {
            const twice = Buffer.concat([vector, repeat, repeat]);
            twice.writeUInt16BE(twice.readUInt16BE(countOffset) + 2, countOffset);
            expect(() => parser(twice)).toThrow(/duplicate/);
        }

        const duplicateRequired = Buffer.concat([fetch, Buffer.from('0017000100', 'hex')]);
        duplicateRequired.writeUInt16BE(3, 12);
        expect(() => decodeWtQrFetchResponse(duplicateRequired)).toThrow(/duplicate/);
    });

    it('rejects nonempty tgtgt keys with the wrong QQ-TEA length', () => {
        for (const length of [1, 15, 17]) {
            const key = Buffer.alloc(length, 0x42);
            const tlvs = Buffer.concat([
                Buffer.from('0003001e', 'hex'),
                Buffer.from([0, length]),
                key,
                Buffer.from('00190001010018000102', 'hex'),
            ]);
            expect(() =>
                decodeWtQrPollResponse(Buffer.concat([confirmed.subarray(0, 19), tlvs])),
            ).toThrow(/key length/);
        }
    });

    it('rejects zero and negative signed UINs', () => {
        for (const value of [0n, -1n, -0x8000000000000000n]) {
            const bad = Buffer.from(confirmed);
            bad.writeBigInt64BE(value, 7);
            expect(() => decodeWtQrPollResponse(bad)).toThrow(/UIN/);
        }
    });

    it('supports offset views and independent returned bytes without mutating input', () => {
        const source = Buffer.concat([Buffer.of(9), fetch, Buffer.of(9)]);
        const before = Buffer.from(source);
        const parsed = decodeWtQrFetchResponse(source.subarray(1, -1));
        expect(parsed.status).toBe('success');

        if (parsed.status !== 'success') {
            throw new Error('unexpected status');
        }

        parsed.qrSig.fill(0);
        parsed.image.fill(0);
        parsed.d1.fill(0);
        expect(source).toEqual(before);
        const result = decodeWtQrPollResponse(confirmed);

        if (result.status !== 'confirmed') {
            throw new Error('unexpected status');
        }

        const saved = Buffer.from(confirmed);
        result.tickets.tgtgtKey.fill(0);
        result.tickets.noPicSig.fill(0);
        result.tickets.tempPassword.fill(0);
        expect(confirmed).toEqual(saved);
    });
});
