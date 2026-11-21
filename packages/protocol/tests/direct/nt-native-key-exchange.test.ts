import { createECDH, createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import {
    createNativeKeyExchange,
    disposeNativeKeyExchangeSession,
    type NativeKeyExchangeRequestWire,
    type NativeKeyExchangeResponseWire,
    type NativeKeyExchangeSecretWire,
} from '../../src/direct/nt-native-key-exchange';
import { decryptKeyExchangeBytes, encryptKeyExchangeBytes } from '../../src/direct/key-exchange';

const trust = vi.hoisted(() => ({
    fixtureKey: undefined as KeyObject | undefined,
    nativeKeys: [] as KeyObject[],
    messages: [] as Uint8Array[],
}));
vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();
    return {
        ...actual,
        verify: (
            algorithm: string | null,
            data: Uint8Array,
            key: { key: KeyObject; dsaEncoding: 'der' },
            signature: Uint8Array,
        ) => {
            trust.nativeKeys.push(key.key);
            trust.messages.push(Uint8Array.from(data));
            return actual.verify(
                algorithm,
                data,
                { ...key, key: trust.fixtureKey ?? key.key },
                signature,
            );
        },
    };
});
afterEach(() => {
    trust.fixtureKey = undefined;
    trust.nativeKeys.length = 0;
    trust.messages.length = 0;
});
const options = () => ({
    uin: '123',
    guid: new Uint8Array(16).fill(3),
    timestampSeconds: 1700000000n,
});
const expectedSigningPoint =
    '04453977b048d0b72c1a7d50c36ebe881b69bbdd51a5c662d08a1baf1236ce92cbb95460f573fe7a5b0ed9ccfee01eb4dfb6e6ecfa16a090e3ed8f5847a9daf984';

function fixture(
    config: {
        substituteTrust?: boolean;
        secret?: NativeKeyExchangeSecretWire;
        corruptGcm?: boolean;
    } = {},
) {
    const flow = createNativeKeyExchange(options());
    const request = protobuf_decode<NativeKeyExchangeRequestWire>(flow.request);
    const ephemeral = createECDH('prime256v1');
    ephemeral.generateKeys();
    const signing = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

    if (config.substituteTrust) {
        trust.fixtureKey = signing.publicKey;
    }

    const sessionKey = new Uint8Array(32).fill(7);
    const sessionTicket = new Uint8Array(24).fill(8);
    const plain = protobuf_encode<NativeKeyExchangeSecretWire>(
        config.secret ?? { sessionKey, sessionTicket, expiresInSeconds: 1800n },
    );
    const secret = encryptKeyExchangeBytes(plain, ephemeral.computeSecret(request.publicKey));

    if (config.corruptGcm) {
        secret[secret.length - 1]! ^= 1;
    }

    const publicKey = ephemeral.getPublicKey();
    const signedInput = Buffer.concat([request.publicKey, publicKey, secret]);
    const signature = sign('sha256', signedInput, signing.privateKey);
    const reply = { secret, signature, publicKey };
    return {
        flow,
        request,
        reply,
        signedInput,
        sessionKey,
        sessionTicket,
        wire: () => protobuf_encode<NativeKeyExchangeResponseWire>(reply),
    };
}

// Positive fixtures explicitly substitute ONLY the crypto provider's test trust key;
// real ECDSA, P-256, AES-GCM and production codecs still run. The production API has
// no trust injection. These fixtures are not native-server interoperability evidence.
describe('fixed native KeyExchange authentication', () => {
    it('uses a fresh uncompressed key and fixed verifyHash key with BE32 type / BE64 seconds', () => {
        const time = (1n << 40n) + 29n;
        const first = createNativeKeyExchange({ ...options(), timestampSeconds: time });
        const second = createNativeKeyExchange(options());
        const request = protobuf_decode<NativeKeyExchangeRequestWire>(first.request);
        const other = protobuf_decode<NativeKeyExchangeRequestWire>(second.request);
        expect(request.type).toBe(1);
        expect(request.timestamp).toBe(time);
        expect(request.publicKey.length).toBe(65);
        expect(request.publicKey[0]).toBe(4);
        expect(request.publicKey).not.toEqual(other.publicKey);
        expect(request.secret.subarray(0, 12)).not.toEqual(other.secret.subarray(0, 12));
        const type = Buffer.alloc(4);
        type.writeUInt32BE(1);
        const timestamp = Buffer.alloc(8);
        timestamp.writeBigUInt64BE(time);
        const expected = createHash('sha256')
            .update(request.publicKey)
            .update(type)
            .update(request.secret)
            .update(timestamp)
            .digest();
        expect(
            decryptKeyExchangeBytes(
                request.verifyHash,
                Buffer.from(
                    'e2733bf403149913cbf80c7a95168bd4ca6935ee53cd39764beebe2e007e3aee',
                    'hex',
                ),
            ),
        ).toEqual(Uint8Array.from(expected));
        first.cancel();
        second.cancel();
        expect(first.request.every((byte) => byte === 0)).toBe(true);
        expect(() => first.complete(new Uint8Array())).toThrow('consumed');
    });

    it('rejects locally signed proof with the actual pinned native signing key', () => {
        const f = fixture();
        expect(() => f.flow.complete(f.wire())).toThrow('signature mismatch');
        const jwk = trust.nativeKeys[0]!.export({ format: 'jwk' });
        expect(
            Buffer.concat([
                Buffer.of(4),
                Buffer.from(jwk.x!, 'base64url'),
                Buffer.from(jwk.y!, 'base64url'),
            ]).toString('hex'),
        ).toBe(expectedSigningPoint);
        expect(trust.messages[0]).toEqual(Uint8Array.from(f.signedInput));
        expect(f.flow.request.every((byte) => byte === 0)).toBe(true);
        expect(() => f.flow.complete(f.wire())).toThrow('consumed');
    });

    it('authenticates the original three-field concatenation once and returns owned secret bytes', () => {
        const f = fixture({ substituteTrust: true });
        const wire = f.wire();
        const before = Uint8Array.from(wire);
        const result = f.flow.complete(wire);
        expect(trust.messages[0]).toEqual(Uint8Array.from(f.signedInput));
        expect(result).toEqual({
            sessionKey: f.sessionKey,
            sessionTicket: f.sessionTicket,
            expiresInSeconds: 1800n,
        });
        expect(wire).toEqual(before);
        wire.fill(0);
        expect(result.sessionKey).toEqual(f.sessionKey);
        disposeNativeKeyExchangeSession(result);
        disposeNativeKeyExchangeSession(result);
        expect(result.sessionKey).toEqual(new Uint8Array(32));
        expect(result.sessionTicket).toEqual(new Uint8Array(24));
    });

    it.each(['secret', 'publicKey', 'signature'] as const)(
        'rejects tampered %s even under fixture trust',
        (field) => {
            const f = fixture({ substituteTrust: true });
            f.reply[field][f.reply[field].length - 1]! ^= 1;
            expect(() => f.flow.complete(f.wire())).toThrow();
            expect(f.flow.request.every((byte) => byte === 0)).toBe(true);
        },
    );

    it('rejects a response bound to another request public key', () => {
        const f = fixture({ substituteTrust: true });
        const other = createNativeKeyExchange(options());
        expect(() => other.complete(f.wire())).toThrow('signature mismatch');
        f.flow.cancel();
    });

    it('checks GCM after a valid fixture signature and wipes the consumed request on failure', () => {
        const f = fixture({ substituteTrust: true, corruptGcm: true });
        expect(() => f.flow.complete(f.wire())).toThrow();
        expect(trust.messages).toHaveLength(1);
        expect(f.flow.request.every((byte) => byte === 0)).toBe(true);
    });

    it.each([0n, -1n, undefined])('rejects expired/missing signed expireIn %s', (expiry) => {
        const f = fixture({
            substituteTrust: true,
            secret: {
                sessionKey: new Uint8Array(32),
                sessionTicket: Uint8Array.of(1),
                expiresInSeconds: expiry,
            },
        });
        expect(() => f.flow.complete(f.wire())).toThrow();
    });

    it('accepts int64 lifetime rather than truncating at uint32 and requires AES256 session key', () => {
        const good = fixture({
            substituteTrust: true,
            secret: {
                sessionKey: new Uint8Array(32),
                sessionTicket: Uint8Array.of(1),
                expiresInSeconds: (1n << 40n) + 5n,
            },
        });
        const result = good.flow.complete(good.wire());
        expect(result.expiresInSeconds).toBe((1n << 40n) + 5n);
        disposeNativeKeyExchangeSession(result);
        const bad = fixture({
            substituteTrust: true,
            secret: {
                sessionKey: new Uint8Array(16),
                sessionTicket: Uint8Array.of(1),
                expiresInSeconds: 300n,
            },
        });
        expect(() => bad.flow.complete(bad.wire())).toThrow();
    });

    it('rejects missing proof, DER trailing bytes, blob length28, and malformed PB', () => {
        const f = fixture({ substituteTrust: true });
        const cases = [
            protobuf_encode<NativeKeyExchangeResponseWire>({ ...f.reply, signature: undefined }),
            protobuf_encode<NativeKeyExchangeResponseWire>({
                ...f.reply,
                signature: Buffer.concat([f.reply.signature, Buffer.of(0)]),
            }),
            protobuf_encode<NativeKeyExchangeResponseWire>({
                ...f.reply,
                secret: new Uint8Array(28),
            }),
            Uint8Array.of(10, 255),
        ];

        for (const wire of cases) {
            const flow = createNativeKeyExchange(options());
            expect(() => flow.complete(wire)).toThrow();
            expect(() => flow.complete(wire)).toThrow('consumed');
        }

        f.flow.cancel();
        expect(trust.messages).toHaveLength(0);
    });

    it('offers no optional trust callback, deterministic private key or malformed input path', () => {
        for (const extra of [
            { verifyServerResponse: () => true },
            { privateKey: new Uint8Array(32) },
            { signingKey: new Uint8Array(65) },
        ]) {
            expect(() => createNativeKeyExchange({ ...options(), ...extra } as never)).toThrow(
                'invalid native message input',
            );
        }

        expect(() =>
            createNativeKeyExchange({ ...options(), timestampSeconds: 1 as never }),
        ).toThrow();
        expect(() =>
            createNativeKeyExchange({ ...options(), timestampSeconds: 1n << 64n }),
        ).toThrow();
        expect(() => createNativeKeyExchange({ ...options(), guid: new Uint8Array(15) })).toThrow();
    });
});
