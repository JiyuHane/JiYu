import { protobuf_getUnknownFields } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';
import { decodeWtTlv } from '../../src/direct/wt-tlv';
import { encodeWtQrFetchBody } from '../../src/direct/wt-qr-request';
import {
    decodeWtQrD1,
    decodeWtQrD1Response,
    encodeWtQrD1,
    encodeWtQrD1Request,
} from '../../src/direct/wt-qr-protobuf';

// Hand-assembled synthetic bytes from the pinned schema, not captured traffic.
const bytes = (hex: string): Uint8Array => Buffer.from(hex, 'hex');
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');

describe('offline WT QR D1 protobuf', () => {
    it('encodes a request from explicit device strings and integrates with TLV 0x31', () => {
        const request = { deviceType: 'pc', deviceName: 'é' };
        const d1 = encodeWtQrD1Request(request);
        expect(hex(d1)).toBe('0a080a0270631202c3a922023001');
        expect(decodeWtQrD1(d1)).toMatchObject({
            deviceInfo: request,
            genInfo: { field6: 1 },
        });
        const body = encodeWtQrFetchBody({
            appId: 1,
            subAppId: 2,
            guid: bytes('01'),
            packageName: 'p',
            ptVersion: 'v',
            miscBitMap: 0,
            ssoVersion: 0,
            d1,
        });
        const entry = decodeWtTlv(body.subarray(17)).find((item) => item.tag === 0xd1);
        expect(hex(entry!.value)).toBe('0a080a0270631202c3a922023001');
    });

    it('decodes a synthetic response URL and leaves unknown metadata visible', () => {
        // Unknown tag 9 at top level and tag 7 inside device info.
        const wire = bytes('0a050a01703801120968747470733a2f2f784807');
        const result = decodeWtQrD1Response(wire);
        expect(result.qrUrl).toBe('https://x');
        expect(result.deviceInfo?.deviceType).toBe('p');
        expect(protobuf_getUnknownFields(result)).toEqual([
            { fieldNumber: 9, wireType: 0, count: 1, totalByteLength: 1 },
        ]);
        expect(protobuf_getUnknownFields(result.deviceInfo)).toEqual([
            { fieldNumber: 7, wireType: 0, count: 1, totalByteLength: 1 },
        ]);
        expect(hex(encodeWtQrD1(result))).toBe('0a030a0170120968747470733a2f2f78');
    });

    it('uses exact tag numbers for all known fields and roundtrips', () => {
        const data = {
            deviceInfo: { deviceType: 'a', deviceName: 'b' },
            qrUrl: 'u',
            qrSig: 's',
            genInfo: { clientType: 1, clientVersion: 2, clientAppId: 3, field6: 4 },
        };
        const wire = '0a060a01611201621201751a017322080801100218033004';
        expect(hex(encodeWtQrD1(data))).toBe(wire);
        expect(decodeWtQrD1(bytes(wire))).toMatchObject(data);
        expect(hex(encodeWtQrD1(decodeWtQrD1(bytes(wire))))).toBe(wire);
    });

    it('validates request and decoded boundaries without assuming a profile', () => {
        for (const value of [null, 5, [], {}]) {
            expect(() => encodeWtQrD1Request(value as never)).toThrow();
        }

        expect(() => encodeWtQrD1Request({ deviceType: 'x', deviceName: 3 as never })).toThrow();
        expect(() =>
            encodeWtQrD1Request({ deviceType: 'x'.repeat(65536), deviceName: '' }),
        ).toThrow();
        expect(encodeWtQrD1Request({ deviceType: 'x'.repeat(65523), deviceName: '' })).toHaveLength(
            65535,
        );
        expect(() =>
            encodeWtQrD1Request({ deviceType: 'x'.repeat(65524), deviceName: '' }),
        ).toThrow();
        expect(() => decodeWtQrD1(null as never)).toThrow();
        expect(() => decodeWtQrD1(new Uint8Array(65536))).toThrow();
        expect(() => decodeWtQrD1Response(bytes(''))).toThrow(/qrUrl/);
        expect(() => decodeWtQrD1Response(bytes('1200'))).toThrow(/qrUrl/);
        expect(() => encodeWtQrD1({ deviceInfo: [] as never })).toThrow();

        for (const bad of [-1, 0x100000000, 0.5, NaN, Infinity, '1']) {
            expect(() => encodeWtQrD1({ genInfo: { clientAppId: bad as never } })).toThrow();
        }

        const edge = { genInfo: { clientType: 0xffffffff } };
        expect(decodeWtQrD1(encodeWtQrD1(edge)).genInfo?.clientType).toBe(0xffffffff);
    });

    it('rejects malformed protobuf frames using the real Proton plugin', () => {
        for (const wire of ['00', '0a02ff', '0a80', '0880', '0b14', '120261']) {
            expect(() => decodeWtQrD1(bytes(wire))).toThrow();
        }
    });
});
