import { createCipheriv } from 'node:crypto';
import type {
    LinuxNTEasyLoginReferenceSecurityBody,
    NTLoginForwardRequest,
} from '@snowluma/proto-defs/direct-login';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';
import { decodeLinuxNTEasyLoginReferenceResponse } from '../../src/direct/nt-linux-easy-login-reference';
import { decodeLinuxNTLoginReferenceResponse } from '../../src/direct/nt-linux-login-response-reference';
import { decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse } from '../../src/direct/nt-linux-easy-unusual-device-reference';
import { encodeWtQrFetchBody } from '../../src/direct/wt-qr-request';
import { decodeWtTlv } from '../../src/direct/wt-tlv';

// Hand-derived synthetic reference shapes only. No QQ response, signature service,
// real account or transport participates in these fixtures.
const hex = (value: string): Buffer => Buffer.from(value, 'hex');
const join = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);
const limit = 1024 * 1024;
const absent = { secProtectPresent: false, unusualDeviceCheckSig: null };
const emptyProtect = { secProtectPresent: true, unusualDeviceCheckSig: null };

function varint(value: number): Buffer {
    const output: number[] = [];

    do {
        const low = value % 128;
        value = Math.floor(value / 128);
        output.push(low | (value ? 0x80 : 0));
    } while (value);

    return Buffer.from(output);
}

function field(number: number, value: Uint8Array): Buffer {
    return join(varint(number * 8 + 2), varint(value.length), value);
}

function expectRejected(input: Uint8Array): void {
    const before = Uint8Array.from(input);
    expect(() => decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse(input)).toThrow(
        'invalid EasyLogin unusual-device reference response',
    );
    expect(Uint8Array.from(input)).toEqual(before);
}

describe('Linux NT EasyLogin unusual-device reference projection', () => {
    it('distinguishes absent protect, absent child, empty child and bytes', () => {
        expect(decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse(hex(''))).toEqual(absent);
        expect(decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse(hex('1a00'))).toEqual(
            emptyProtect,
        );
        expect(decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse(hex('1a021200'))).toEqual({
            secProtectPresent: true,
            unusualDeviceCheckSig: new Uint8Array(),
        });
        expect(decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse(hex('1a041202aabb'))).toEqual({
            secProtectPresent: true,
            unusualDeviceCheckSig: Uint8Array.of(0xaa, 0xbb),
        });
    });

    it('compares literal vectors with the actual Proton schema and explicit presence', () => {
        const cases: Array<[LinuxNTEasyLoginReferenceSecurityBody, string]> = [
            [{}, ''],
            [{ secProtect: {} }, '1a00'],
            [{ secProtect: { unusualDeviceCheckSig: new Uint8Array() } }, '1a021200'],
            [{ secProtect: { unusualDeviceCheckSig: Uint8Array.of(0xaa, 0xbb) } }, '1a041202aabb'],
        ];

        for (const [value, wire] of cases) {
            const encoded = protobuf_encode<LinuxNTEasyLoginReferenceSecurityBody>(value);
            expect(Buffer.from(encoded)).toEqual(hex(wire));
            const decoded = protobuf_decode<LinuxNTEasyLoginReferenceSecurityBody>(encoded);
            const projected = decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse(encoded);
            expect(projected.secProtectPresent).toBe(decoded.secProtect != null);
            expect(projected.unusualDeviceCheckSig).toEqual(
                decoded.secProtect?.unusualDeviceCheckSig ?? null,
            );
        }
    });

    it('skips repeated unknown fields without interpreting their opaque payloads', () => {
        const nested = join(
            field(1, hex('ff00')),
            field(1, hex('0b')),
            field(2, hex('aabb')),
            field(3, hex('c328')),
            hex('2801'),
        );
        const wire = join(field(8, hex('ff')), field(3, nested), field(8, hex('0b00')));
        expect(decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse(wire)).toEqual({
            secProtectPresent: true,
            unusualDeviceCheckSig: Uint8Array.of(0xaa, 0xbb),
        });
    });

    it('skips well-formed unknown varint, fixed-width and byte fields at both levels', () => {
        const unknown = join(
            hex('3801'),
            hex('410102030405060708'),
            field(9, hex('ff00')),
            hex('5501020304'),
        );
        const value = field(2, hex('aa'));
        const wire = join(unknown, field(3, join(unknown, value)));
        expect(decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse(wire)).toEqual({
            secProtectPresent: true,
            unusualDeviceCheckSig: Uint8Array.of(0xaa),
        });

        for (const truncated of [hex('4101020304050607'), hex('55010203')]) {
            expectRejected(truncated);
            expectRejected(field(3, truncated));
        }
    });

    it('does not change the old ticket-only decoder or inspect its unknown field 3', () => {
        const opaqueInvalidProtect = hex('1a0112');
        expect(decodeLinuxNTEasyLoginReferenceResponse(opaqueInvalidProtect)).toEqual({
            ticketsPresent: false,
            a1: null,
            a2: null,
            d2: null,
            d2Key: null,
        });
        expectRejected(opaqueInvalidProtect);
        expect(decodeLinuxNTEasyLoginReferenceResponse(hex('1a001a00'))).toMatchObject({
            ticketsPresent: false,
        });
        expectRejected(hex('1a001a00'));
    });

    it('rejects duplicate selected fields and selected fields with wrong wire types', () => {
        for (const wire of [
            '1801',
            '190000000000000000',
            '1d00000000',
            '1a001a00',
            '1a001801',
            '18011a00',
        ]) {
            expectRejected(hex(wire));
        }

        const proper = field(2, hex('aabb'));
        const wrong = hex('1001');

        for (const value of [
            wrong,
            hex('110000000000000000'),
            hex('1500000000'),
            join(proper, proper),
            join(proper, wrong),
            join(wrong, proper),
        ]) {
            expectRejected(field(3, value));
        }
    });

    it('rejects malformed and noncanonical framing even in unknown fields', () => {
        for (const wire of [
            '00',
            '03',
            '0b',
            '0c',
            '0f',
            '8a0000',
            '1a800000',
            '388000',
            '38ffffffffffffffffff02',
            'ffffffffffffffffffff02',
            '80',
            '1a',
            '1a01',
            '1a0112',
            '1a021201',
            '1a031202aa',
            '1a020b0c',
            '1a020000',
            '1a023880',
        ]) {
            expectRejected(hex(wire));
        }
    });

    it('enforces separate 256-field limits at the outer and nested levels', () => {
        const unknown = (count: number) => hex('3800'.repeat(count));
        expect(decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse(unknown(256))).toEqual(absent);
        expectRejected(unknown(257));
        expect(
            decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse(field(3, unknown(256))),
        ).toEqual(emptyProtect);
        expectRejected(field(3, unknown(257)));
        expect(
            decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse(
                join(field(3, unknown(256)), unknown(255)),
            ),
        ).toEqual(emptyProtect);
        expectRejected(join(field(3, unknown(256)), unknown(256)));
    });

    it('accepts exactly one MiB of input and rejects a larger view', () => {
        const atLimit = field(7, new Uint8Array(limit - 4));
        expect(atLimit.length).toBe(limit);
        expect(decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse(atLimit)).toEqual(absent);
        expectRejected(join(atLimit, hex('3800')));
    }, 20_000);

    it('rejects proxy, shared, detached and resizable views without proxy traps', () => {
        let traps = 0;
        const proxy = new Proxy(Uint8Array.of(1), {
            get() {
                traps++;
                throw new Error('unexpected proxy trap');
            },
        });
        const shared = new Uint8Array(new SharedArrayBuffer(4));
        const detachedBuffer = new ArrayBuffer(4);
        const detached = new Uint8Array(detachedBuffer);
        structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
        const resizable = new Uint8Array(new ArrayBuffer(4, { maxByteLength: 8 }));

        for (const input of [proxy, shared, detached, resizable]) {
            expect(() => decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse(input)).toThrow();
        }

        expect(traps).toBe(0);
        expect(decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse(hex('1a00'))).toEqual(
            emptyProtect,
        );
    });

    it('honors input offsets and returns independent arrays without modifying caller bytes', () => {
        const backing = hex('cc1a041202aabbdd');
        const view = backing.subarray(1, -1);
        const before = Buffer.from(backing);
        const first = decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse(view);
        const second = decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse(view);
        expect(backing).toEqual(before);
        expect(first.unusualDeviceCheckSig).toEqual(Uint8Array.of(0xaa, 0xbb));
        expect(second.unusualDeviceCheckSig).toEqual(Uint8Array.of(0xaa, 0xbb));
        expect(first.unusualDeviceCheckSig!.buffer).not.toBe(second.unusualDeviceCheckSig!.buffer);
        expect(first.unusualDeviceCheckSig!.buffer).not.toBe(backing.buffer);
        first.unusualDeviceCheckSig![0] = 0;
        expect(second.unusualDeviceCheckSig).toEqual(Uint8Array.of(0xaa, 0xbb));
        expect(backing).toEqual(before);
        backing.fill(0);
        expect(second.unusualDeviceCheckSig).toEqual(Uint8Array.of(0xaa, 0xbb));
        expectRejected(hex('cc1a021201dd').subarray(1, -1));
    });

    it('explicitly composes a synthetic GCM response with a local QR body', () => {
        const key = Uint8Array.from({ length: 16 }, (_, index) => 0x30 + index);
        const nonce = hex('000102030405060708090a0b');
        // Common #1 -> Head #4 -> Error #1 is 140022011; Common #2 is
        // the separate EasyLogin body. These bytes are hand-derived fixtures.
        const common = hex('0a07220508fba1e24212061a041202aabb');
        const cipher = createCipheriv('aes-128-gcm', key, nonce);
        const encrypted = join(nonce, cipher.update(common), cipher.final(), cipher.getAuthTag());
        const forward = protobuf_encode<NTLoginForwardRequest>({ buffer: encrypted });
        const result = decodeLinuxNTLoginReferenceResponse({ forward, sessionKey: key });
        expect(result.status).toEqual({ kind: 'code', code: 140022011n, codePresent: true });
        expect(result.body).toEqual(Uint8Array.from(hex('1a041202aabb')));
        const changed = Uint8Array.from(encrypted);
        changed[changed.length - 1] ^= 1;
        const badForward = protobuf_encode<NTLoginForwardRequest>({ buffer: changed });
        expect(() =>
            decodeLinuxNTLoginReferenceResponse({ forward: badForward, sessionKey: key }),
        ).toThrow('invalid reference authentication');

        if (result.status.kind !== 'code' || result.status.code !== 140022011n || !result.body) {
            throw new Error('invalid synthetic fixture');
        }

        const projected = decodeLinuxNTEasyLoginUnusualDeviceReferenceResponse(result.body);
        expect(projected.unusualDeviceCheckSig).toEqual(Uint8Array.of(0xaa, 0xbb));

        if (projected.unusualDeviceCheckSig === null) {
            throw new Error('synthetic value is absent');
        }

        // Explicit caller composition only: the decoder itself does not start QR.
        const qr = encodeWtQrFetchBody({
            appId: 1,
            subAppId: 2,
            guid: Uint8Array.of(3, 4),
            packageName: 'fixture',
            ptVersion: 'fixture',
            miscBitMap: 0,
            ssoVersion: 0,
            d1: new Uint8Array(),
            unusualSig: projected.unusualDeviceCheckSig,
        });
        const entries = decodeWtTlv(qr.subarray(17));
        expect(entries[0]).toEqual({ tag: 0x11, value: Uint8Array.of(0xaa, 0xbb) });
        result.body.fill(0);
        expect(projected.unusualDeviceCheckSig).toEqual(Uint8Array.of(0xaa, 0xbb));
        projected.unusualDeviceCheckSig.fill(0);
        qr.fill(0);
        key.fill(0);
    });
});
