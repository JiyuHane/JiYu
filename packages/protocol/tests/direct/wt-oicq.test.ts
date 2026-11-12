import { describe, expect, it } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createWtEcdh } from '../../src/direct/wt-ecdh';
import {
    decodeWtCode2dResponse,
    decodeWtOicqResponse,
    encodeWtCode2dRequest,
    encodeWtPcLoginOicqRequest,
} from '../../src/direct/wt-oicq';

// Synthetic vectors, not QQ client traffic. The ciphertexts for 00..02 and
// 00..3f come from the independent MiraiGo oracle documented in qq-tea.test.ts.
const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const cipher3 = Buffer.from('b619e9103a2640d8262b6860a4102374', 'hex');
const cipher64 = Buffer.from(
    '1ac2675390c20356d73df63bea4384c7157f15dd9c5fb85036eaef697a32c2bc' +
        'd68ada31632ead93b8bb268cfdbb51ac85a25a5195ca37ff4d450d2c6d1ee658' +
        '901efe4ca6e4f5f6d2e1d8a5a87387be',
    'hex',
);

const fixtureRandom = (n: number): Uint8Array => {
    const value = new Uint8Array(n);
    value[0] = 0xf8;
    return value;
};

const scalar = (n: number): Uint8Array => {
    const b = Buffer.alloc(24);
    b[23] = n;
    return b;
};

const alice = createWtEcdh(scalar(1));
const bob = createWtEcdh(scalar(2));
const unknown = Buffer.from('0102030405060708090a0b0c0d0e0f101112131415', 'hex');
const base = () => ({
    timestamp: 0x01020304,
    command: 0x31,
    unknown21: Uint8Array.from(unknown),
    uin: 0x0102030405060708n,
    body: Uint8Array.from([0xaa, 0xbb]),
    appId: 0x11223344,
    clientVersion: 0x7788,
    innerEncryption: { type: 'none' as const },
    encryption: { method: 0x45 as const, key },
    head: { type: 'session' as const, ticket: Uint8Array.from([0x99, 0x88]) },
    randomSource: fixtureRandom,
});

function response(cipher: Uint8Array, type = 0, state = 0): Buffer {
    const b = Buffer.alloc(17 + cipher.length);
    b[0] = 2;
    b.writeUInt16BE(b.length, 1);
    b.writeUInt16BE(8001, 3);
    b.writeUInt16BE(0x812, 5);
    b.writeUInt16BE(0x1234, 7);
    b.writeUInt32BE(0x01020304, 9);
    b[13] = 3;
    b[14] = type;
    b[15] = state;
    b.set(cipher, 16);
    b[b.length - 1] = 3;
    return b;
}

function layer(body: Uint8Array, encrypted = false): Buffer {
    const b = Buffer.alloc(5 + body.length);
    b[0] = 0xa1;
    b[1] = Number(encrypted);
    b.writeUInt16BE(body.length, 2);
    b[4] = 0xb2;
    b.set(body, 5);
    return b;
}

describe('reference PC OICQ 0x810 framing', () => {
    const login = () => ({
        uin: 0x0102030405060708n,
        clientVersion: 0x7788,
        body: Uint8Array.of(0, 1, 2),
        randomKey: Uint8Array.from(key),
        ecdh: createWtEcdh(scalar(1)),
        peerPublicKey: createWtEcdh(scalar(1)).publicKey,
        randomSource: fixtureRandom,
    });

    it('matches a manually assembled envelope and independent MiraiGo QQ-TEA vector', () => {
        // Synthetic only: scalar 1 with the secp192k1 generator yields TEA key
        // eac0f2871a65d3e4712830f89e57f02a, independently covered in wt-ecdh.test.
        // Ciphertext is from MiraiGo tea.go fixed revision with F8/zero padding;
        // the complete header is manually derived from WtLogin and BinaryPacket.
        const actual = Buffer.from(encodeWtPcLoginOicqRequest(login()));
        expect(actual.toString('hex')).toBe(
            '02005a1f41081000000506070803870000000002000077880000' +
                '0101000102030405060708090a0b0c0d0e0f01020019' +
                '03db4ff10ec057e9ae26b07d0280b7f4341da5d1b1eae06c7d' +
                '2ca8df5e470d27345d036004e01c70be03',
        );
        expect(actual.readUInt16BE(1)).toBe(actual.length);
        expect(
            qqTeaDecrypt(
                actual.subarray(73, -1),
                Buffer.from('eac0f2871a65d3e4712830f89e57f02a', 'hex'),
            ),
        ).toEqual(Uint8Array.of(0, 1, 2));
    });

    it('keeps input slices, return bytes and factory public key isolated', () => {
        const input = login();
        const bodyBacking = Buffer.from([0xaa, 0, 1, 2, 0xbb]);
        const keyBacking = Buffer.concat([Buffer.of(0xaa), key, Buffer.of(0xbb)]);
        const peerBacking = Buffer.concat([
            Buffer.of(0xaa),
            Buffer.from(input.peerPublicKey),
            Buffer.of(0xbb),
        ]);
        const bodyBefore = Buffer.from(bodyBacking),
            keyBefore = Buffer.from(keyBacking),
            peerBefore = Buffer.from(peerBacking);
        input.body = bodyBacking.subarray(1, 4);
        input.randomKey = keyBacking.subarray(1, 17);
        input.peerPublicKey = peerBacking.subarray(1, 26);
        const changedCopy = input.ecdh.publicKey;
        changedCopy.fill(0);
        expect(Reflect.set(input.ecdh, 'publicKey', new Uint8Array(25))).toBe(false);
        const packet = encodeWtPcLoginOicqRequest(input);
        const output = Uint8Array.from(packet);
        expect(bodyBacking).toEqual(bodyBefore);
        expect(keyBacking).toEqual(keyBefore);
        expect(peerBacking).toEqual(peerBefore);
        bodyBacking.fill(0xff);
        keyBacking.fill(0xff);
        peerBacking.fill(0xff);
        expect(Uint8Array.from(packet)).toEqual(output);
        expect(Buffer.from(packet).subarray(48, 73)).toEqual(Buffer.from(input.ecdh.publicKey));
        packet.fill(0);
        expect(bodyBacking).toEqual(Buffer.alloc(bodyBacking.length, 0xff));
    });

    it('snapshots login body and context bytes before the random source runs', () => {
        const input = login();

        input.randomSource = (n) => {
            input.body.fill(0xff);
            input.randomKey.fill(0xff);
            input.peerPublicKey.fill(0);
            return fixtureRandom(n);
        };

        const packet = Buffer.from(encodeWtPcLoginOicqRequest(input));
        expect(packet.subarray(28, 44)).toEqual(key);
        expect(
            qqTeaDecrypt(
                packet.subarray(73, -1),
                Buffer.from('eac0f2871a65d3e4712830f89e57f02a', 'hex'),
            ),
        ).toEqual(Uint8Array.of(0, 1, 2));
    });

    it('handles its maximal u16 envelope and rejects overflow before encryption', () => {
        const request = login();
        const empty = Buffer.from(
            encodeWtPcLoginOicqRequest({ ...request, body: new Uint8Array() }),
        );
        expect(empty.length).toBe(90);
        expect(
            qqTeaDecrypt(empty.subarray(73, -1), request.ecdh.deriveTeaKey(request.peerPublicKey)),
        ).toEqual(new Uint8Array());
        const packet = Buffer.from(
            encodeWtPcLoginOicqRequest({ ...request, body: new Uint8Array(65446) }),
        );
        expect(packet.length).toBe(65530);
        expect(packet.readUInt16BE(1)).toBe(65530);
        expect(() =>
            encodeWtPcLoginOicqRequest({ ...request, body: new Uint8Array(65447) }),
        ).toThrow(/length/);
        expect(() =>
            encodeWtPcLoginOicqRequest({ ...request, body: new Uint8Array(65536) }),
        ).toThrow(/body/);
    });

    it('rejects invalid UIN, version, key, context, point and random source', () => {
        const request = login();

        for (const uin of [-1n, 0x8000000000000000n, 1 as unknown as bigint]) {
            expect(() => encodeWtPcLoginOicqRequest({ ...request, uin })).toThrow(/UIN/);
        }

        for (const clientVersion of [-1, 0x10000, 1.5, NaN]) {
            expect(() => encodeWtPcLoginOicqRequest({ ...request, clientVersion })).toThrow(
                /client version/,
            );
        }

        expect(() =>
            encodeWtPcLoginOicqRequest({ ...request, body: [] as unknown as Uint8Array }),
        ).toThrow(/body/);
        expect(() =>
            encodeWtPcLoginOicqRequest({ ...request, randomKey: new Uint8Array(15) }),
        ).toThrow(/key/);
        expect(() => encodeWtPcLoginOicqRequest({ ...request, ecdh: null as never })).toThrow(
            /ECDH/,
        );
        const ecdh = request.ecdh;

        for (const publicKey of [
            new Uint8Array(24),
            new Uint8Array(25),
            Buffer.concat([Buffer.of(2), Buffer.alloc(24, 0xff)]),
        ]) {
            expect(() =>
                encodeWtPcLoginOicqRequest({ ...request, ecdh: { ...ecdh, publicKey } }),
            ).toThrow();
        }

        expect(() =>
            encodeWtPcLoginOicqRequest({ ...request, peerPublicKey: new Uint8Array(25) }),
        ).toThrow();
        expect(() =>
            encodeWtPcLoginOicqRequest({ ...request, randomSource: (n) => new Uint8Array(n - 1) }),
        ).toThrow(/random/);
    });

    it('preserves randomized padding and supports alternate valid structural contexts', () => {
        const request = login();
        const custom = {
            publicKey: request.ecdh.publicKey,
            deriveTeaKey: request.ecdh.deriveTeaKey,
            sharedSecret: request.ecdh.sharedSecret,
        };
        const first = encodeWtPcLoginOicqRequest({
            ...request,
            ecdh: custom,
            randomSource: (n) => new Uint8Array(n).fill(0x11),
        });
        const second = encodeWtPcLoginOicqRequest({
            ...request,
            ecdh: custom,
            randomSource: (n) => new Uint8Array(n).fill(0x22),
        });
        expect(first).not.toEqual(second);

        for (const packet of [first, second]) {
            expect(
                qqTeaDecrypt(
                    packet.subarray(73, -1),
                    request.ecdh.deriveTeaKey(request.peerPublicKey),
                ),
            ).toEqual(request.body);
        }
    });
});

describe('reference OICQ 0x812 framing', () => {
    it('encodes independently specified request fields and inclusive lengths', () => {
        const packet = Buffer.from(encodeWtCode2dRequest(base()));
        expect(packet.subarray(0, 30).toString('hex')).toBe(
            '02006f1f4108120000050607080345000000000200007788000000029988',
        );
        expect(packet.readUInt16BE(1)).toBe(packet.length);
        expect(packet.at(-1)).toBe(3);
        // MiraiGo TEA oracle with the hand-encoded payload below, fixed F8 prefix.
        expect(packet.subarray(30, -1).toString('hex')).toBe(
            '1ac2675390c20356da758bd889bc65bfd1503c07daf6d8c2ed711d455847f0e3' +
                'b6a5abe430019adcbc1626f6fcf03489dbb53bfe0013c3366c444e8c55b9400c' +
                '774f4436b3003b0961d19837e989d2ae',
        );
        const payload = Buffer.from(qqTeaDecrypt(packet.subarray(30, -1), key));
        // Hand-written source-derived layout: body length excludes its 2-byte prefix;
        // inner 0x2e length counts from 02 marker through the trailing 03.
        expect(payload.toString('hex')).toBe(
            '0000321122334400000072000000' +
                '0102030402002e0031' +
                unknown.toString('hex') +
                '0300000032000000000102030405060708aabb03',
        );
    });

    it('honors both ECDH methods and independently selected heads and inner ST layer', () => {
        for (const method of [0x07, 0x87] as const) {
            const request = {
                ...base(),
                encryption: { method, ecdh: alice, peerPublicKey: bob.publicKey },
                head: { type: 'ecdh' as const, randomKey: key, publicKey: alice.publicKey },
                innerEncryption: {
                    type: 'st' as const,
                    key,
                    ticket: Buffer.from([0x91, 0x92, 0x93]),
                },
            };
            const packet = Buffer.from(encodeWtCode2dRequest(request));
            expect(packet[14]).toBe(method);
            expect(packet.subarray(26, 48).toString('hex')).toBe(
                '0101000102030405060708090a0b0c0d0e0f01020019',
            );
            expect(packet.subarray(48, 73)).toEqual(Buffer.from(alice.publicKey));
            const payload = Buffer.from(
                qqTeaDecrypt(packet.subarray(73, -1), bob.deriveTeaKey(alice.publicKey)),
            );
            expect(payload.subarray(0, 17).toString('hex')).toBe(
                '0100401122334400000072000391929300',
            );
            const inner = Buffer.from(qqTeaDecrypt(payload.subarray(17), key));
            expect(inner.subarray(9, 30)).toEqual(unknown);
            expect(inner.readUInt16BE(5)).toBe(inner.length - 4);
            expect(inner.subarray(-3).toString('hex')).toBe('aabb03');
        }
    });

    it('rejects invalid fields and length overflow without defaulting unknown bytes', () => {
        for (const unknown21 of [new Uint8Array(20), new Uint8Array(22)]) {
            expect(() => encodeWtCode2dRequest({ ...base(), unknown21 })).toThrow(/unknown/);
        }

        expect(() => encodeWtCode2dRequest({ ...base(), body: new Uint8Array(65500) })).toThrow(
            /length/,
        );
        expect(() => encodeWtCode2dRequest({ ...base(), timestamp: -1 })).toThrow(/timestamp/);
        expect(() => encodeWtCode2dRequest({ ...base(), uin: -1n })).toThrow(/UIN/);
        expect(() =>
            encodeWtCode2dRequest({
                ...base(),
                encryption: { method: 0x45, key: new Uint8Array(15) },
            }),
        ).toThrow(/key/);
    });

    it('accepts the largest complete request and rejects one byte over the wire limit', () => {
        const largest = {
            ...base(),
            body: new Uint8Array(65432),
            head: { type: 'session' as const, ticket: new Uint8Array() },
        };
        const packet = encodeWtCode2dRequest(largest);
        expect(packet.length).toBe(65533);
        expect(new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint16(1)).toBe(
            65533,
        );
        expect(() => encodeWtCode2dRequest({ ...largest, body: new Uint8Array(65433) })).toThrow(
            /length/,
        );
    });

    it('decodes independent ciphertext with the context-specific 0 and 3 keys', () => {
        const expected = {
            version: 8001,
            command: 0x812,
            sequence: 0x1234,
            uin: 0x01020304,
            flag: 3,
            body: Uint8Array.from([0, 1, 2]),
        };
        expect(decodeWtOicqResponse(response(cipher3), { sharedKey: key })).toEqual({
            ...expected,
            encryptType: 0,
            state: 0,
        });
        expect(decodeWtOicqResponse(response(cipher3, 0, 180), { randomKey: key })).toEqual({
            ...expected,
            encryptType: 0,
            state: 180,
        });
        expect(decodeWtOicqResponse(response(cipher3, 3), { sessionKey: key })).toEqual({
            ...expected,
            encryptType: 3,
            state: 0,
        });
        expect(() => decodeWtOicqResponse(response(cipher3, 0, 180), { sharedKey: key })).toThrow(
            /random/,
        );
        expect(() => decodeWtOicqResponse(response(cipher3, 3), { sharedKey: key })).toThrow(
            /session/,
        );
        expect(() =>
            decodeWtOicqResponse(response(cipher3), { sharedKey: new Uint8Array(16) }),
        ).toThrow(/QQ-TEA/);
    });

    it('decodes type 4 via a separate temporary peer public key', () => {
        const sharedKey = Uint8Array.from({ length: 16 }, (_, i) => 0xf0 + i);
        const inner = qqTeaEncrypt(
            Uint8Array.from([9, 8, 7]),
            bob.deriveTeaKey(alice.publicKey),
            fixtureRandom,
        );
        const envelope = Buffer.concat([
            Buffer.from([0, bob.publicKey.length]),
            Buffer.from(bob.publicKey),
            Buffer.from(inner),
        ]);
        const frame = response(qqTeaEncrypt(envelope, sharedKey, fixtureRandom), 4);
        expect(decodeWtOicqResponse(frame, { sharedKey, ecdh: alice }).body).toEqual(
            Uint8Array.from([9, 8, 7]),
        );
        expect(() =>
            decodeWtOicqResponse(frame, { sharedKey, ecdh: createWtEcdh(scalar(3)) }),
        ).toThrow(/QQ-TEA/);
        expect(() => decodeWtOicqResponse(frame, { sharedKey })).toThrow(/public key/);
        const bad = response(qqTeaEncrypt(Buffer.from([0, 25, 1]), sharedKey, fixtureRandom), 4);
        expect(() => decodeWtOicqResponse(bad, { sharedKey, ecdh: alice })).toThrow(/public key/);
    });

    it('parses the distinct response layout with independent 64-byte cipher vector', () => {
        const encryptedLayer = layer(cipher64, true);
        const decoded = decodeWtCode2dResponse(encryptedLayer, key);
        expect(decoded).toEqual({
            prefix: 0xa1,
            marker: 0xb2,
            encrypted: true,
            header: 0,
            declaredLength: 0x0102,
            command: 0x0304,
            unknown21: Uint8Array.from({ length: 21 }, (_, i) => i + 5),
            flag: 26,
            retryTime: 0x1b1c,
            version: 0x1d1e,
            sequence: 0x1f202122,
            uin: 0x232425262728292an,
            body: Uint8Array.from({ length: 21 }, (_, i) => i + 43),
        });
        const plain = Uint8Array.from({ length: 64 }, (_, i) => i);
        expect(decodeWtCode2dResponse(layer(plain)).body).toEqual(decoded.body);
        expect(() => decodeWtCode2dResponse(encryptedLayer)).toThrow(/ST/);
    });

    it('rejects truncation, bad lengths, markers, unknown types and damaged ciphertext', () => {
        const good = response(cipher3);

        for (let i = 0; i < good.length; i++) {
            expect(() => decodeWtOicqResponse(good.subarray(0, i), { sharedKey: key })).toThrow();
        }

        for (const offset of [0, 1, good.length - 1]) {
            const bad = Buffer.from(good);
            bad[offset] ^= 1;
            expect(() => decodeWtOicqResponse(bad, { sharedKey: key })).toThrow();
        }

        expect(() => decodeWtOicqResponse(response(cipher3, 2), { sharedKey: key })).toThrow(
            /encryption/,
        );
        const badCipher = Buffer.from(good);
        badCipher[badCipher.length - 2] ^= 1;
        expect(() => decodeWtOicqResponse(badCipher, { sharedKey: key })).toThrow(/QQ-TEA/);
        const validLayer = layer(Uint8Array.from({ length: 64 }, (_, i) => i));

        for (let i = 0; i < validLayer.length; i++) {
            expect(() => decodeWtCode2dResponse(validLayer.subarray(0, i))).toThrow();
        }

        const badFlag = Buffer.from(validLayer);
        badFlag[1] = 2;
        expect(() => decodeWtCode2dResponse(badFlag)).toThrow(/layer/);
        expect(() => decodeWtCode2dResponse(layer(new Uint8Array(42)))).toThrow(/body/);
    });

    it('accepts offset views, does not mutate inputs, and returns independent copies', () => {
        const source = Buffer.concat([Buffer.from([0xff]), response(cipher3), Buffer.from([0xee])]);
        const before = Buffer.from(source);
        const keyView = Buffer.concat([Buffer.from([9]), key, Buffer.from([9])]);
        const originalKey = Buffer.from(keyView);
        const result = decodeWtOicqResponse(source.subarray(1, -1), {
            sharedKey: keyView.subarray(1, 17),
        });
        result.body.fill(0xff);
        expect(source).toEqual(before);
        expect(keyView).toEqual(originalKey);
        expect(
            decodeWtOicqResponse(source.subarray(1, -1), { sharedKey: keyView.subarray(1, 17) })
                .body,
        ).toEqual(Uint8Array.from([0, 1, 2]));
        const raw = layer(Uint8Array.from({ length: 64 }, (_, i) => i));
        const copy = Buffer.from(raw);
        const parsed = decodeWtCode2dResponse(raw);
        parsed.unknown21.fill(0);
        parsed.body.fill(0);
        expect(raw).toEqual(copy);
        const req = base();
        const saved = Buffer.from(req.unknown21);
        encodeWtCode2dRequest(req);
        expect(req.unknown21).toEqual(Uint8Array.from(saved));
    });
});
