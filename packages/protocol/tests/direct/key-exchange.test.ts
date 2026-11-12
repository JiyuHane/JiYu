import { describe, expect, it } from 'vitest';
import {
    buildKeyExchange,
    createP256KeyExchange,
    decryptKeyExchangeBytes,
    encryptKeyExchangeBytes,
    keyExchangeVerifyDigest,
} from '../../src/direct/key-exchange';

// Synthetic vector independently generated with Node and .NET AES, not reference runtime.
const bytes = (hex: string) => Buffer.from(hex, 'hex');
const scalar = bytes('0000000000000000000000000000000000000000000000000000000000000001');
const server = bytes(
    '049d1423332735980edabe7e9ea451b3395b6f35250db8fc56f25889f628cbae3e' +
        '8e73077914071eeebc108f4e0170057792bb17aa303af652313d17c1ac815e79',
);
const shared = bytes('9d1423332735980edabe7e9ea451b3395b6f35250db8fc56f25889f628cbae3e');
const inner = bytes('0a0130120400010203');
const secretNonce = bytes('000102030405060708090a0b');
const secret = bytes('000102030405060708090a0b8b808eb03ee2c4151cc380c7b1b36e7c602fa9e5e05911c9eb');
const verifyKey = bytes('e2733bf403149913cbf80c7a95168bd4ca6935ee53cd39764beebe2e007e3aee');
const verifyNonce = bytes('101112131415161718191a1b');
const verify = bytes(
    '101112131415161718191a1be39360d333c674395e7cd76d08cee071a6732cf1' +
        '639f6433ff9d507874c14ce711f10c9e3b87398e3c107e216d785648',
);
const timestamp = 0x01020304;

function buffer(value: Uint8Array): Buffer {
    return Buffer.from(value);
}

describe('standalone key exchange primitives', () => {
    it('matches independently generated fixed values for every composed field', () => {
        const result = buildKeyExchange(inner, server, verifyKey, timestamp, {
            privateKey: scalar,
            secretNonce,
            verifyNonce,
        });
        expect(buffer(result.publicKey)).toEqual(
            bytes(
                '046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296' +
                    '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5',
            ),
        );
        expect(buffer(result.sharedSecret)).toEqual(shared);
        expect(buffer(result.secret)).toEqual(secret);
        expect(buffer(result.verifyHash)).toEqual(verify);
        expect(result.timestamp).toBe(timestamp);
        expect(buffer(decryptKeyExchangeBytes(secret, shared))).toEqual(inner);
        expect(buffer(decryptKeyExchangeBytes(verify, verifyKey))).toEqual(
            buffer(keyExchangeVerifyDigest(result.publicKey, secret, timestamp)),
        );
    });

    it('derives the response secret with the request key pair and a new server key', () => {
        const responsePeer = createP256KeyExchange();
        const request = buildKeyExchange(inner, server, verifyKey, timestamp);
        const responseSecret = request.deriveResponseSecret(responsePeer.publicKey);
        expect(responseSecret).toEqual(responsePeer.sharedSecret(request.publicKey));
        expect(responseSecret).not.toEqual(request.sharedSecret);
        expect(() => request.deriveResponseSecret(new Uint8Array(65))).toThrow();
    });

    it('generates fresh key pairs and nonces by default and derives matching secrets', () => {
        const a = createP256KeyExchange();
        const b = createP256KeyExchange();
        expect(a.publicKey).not.toEqual(b.publicKey);
        expect(a.sharedSecret(b.publicKey)).toEqual(b.sharedSecret(a.publicKey));
        const first = encryptKeyExchangeBytes(inner, shared);
        const second = encryptKeyExchangeBytes(inner, shared);
        expect(first.subarray(0, 12)).not.toEqual(second.subarray(0, 12));
        expect(buffer(decryptKeyExchangeBytes(first, shared))).toEqual(inner);
        expect(buffer(decryptKeyExchangeBytes(second, shared))).toEqual(inner);
    });

    it('handles empty data, sliced inputs, and leaves all supplied bytes untouched', () => {
        const originals = [scalar, server, verifyKey, inner, secretNonce, verifyNonce].map((v) =>
            Buffer.from(v),
        );
        const sliced = (v: Buffer) =>
            Buffer.concat([bytes('ff'), v, bytes('ff')]).subarray(1, v.length + 1);
        const result = buildKeyExchange(
            sliced(inner),
            sliced(server),
            sliced(verifyKey),
            timestamp,
            {
                privateKey: sliced(scalar),
                secretNonce: sliced(secretNonce),
                verifyNonce: sliced(verifyNonce),
            },
        );
        expect(buffer(result.secret)).toEqual(secret);
        expect(buffer(result.verifyHash)).toEqual(verify);
        const empty = encryptKeyExchangeBytes(new Uint8Array(), shared, secretNonce);
        expect(empty.length).toBe(28);
        expect(decryptKeyExchangeBytes(empty, shared)).toHaveLength(0);
        expect([scalar, server, verifyKey, inner, secretNonce, verifyNonce]).toEqual(originals);
    });

    it('rejects malformed public points and private scalars', () => {
        const ecdh = createP256KeyExchange(scalar);

        for (const bad of [
            new Uint8Array(),
            server.subarray(0, 64),
            Buffer.concat([server, bytes('00')]),
            Buffer.concat([bytes('02'), server.subarray(1)]),
            Buffer.concat([bytes('04'), Buffer.alloc(64)]),
        ]) {
            expect(() => ecdh.sharedSecret(bad)).toThrow();
            expect(() => keyExchangeVerifyDigest(bad, secret, timestamp)).toThrow();
        }

        for (const bad of [
            new Uint8Array(),
            new Uint8Array(31),
            new Uint8Array(32),
            new Uint8Array(33),
            new Uint8Array(32).fill(255),
        ]) {
            expect(() => createP256KeyExchange(bad)).toThrow();
        }
    });

    it('rejects malformed keys, nonce and missing nonce/tag bytes', () => {
        for (const key of [new Uint8Array(), new Uint8Array(31), new Uint8Array(33)]) {
            expect(() => encryptKeyExchangeBytes(inner, key)).toThrow();
            expect(() => decryptKeyExchangeBytes(secret, key)).toThrow();
        }

        for (const nonce of [new Uint8Array(), new Uint8Array(11), new Uint8Array(13)]) {
            expect(() => encryptKeyExchangeBytes(inner, shared, nonce)).toThrow(/nonce/);
        }

        for (let length = 0; length < 28; length++) {
            expect(() => decryptKeyExchangeBytes(new Uint8Array(length), shared)).toThrow();
            expect(() =>
                keyExchangeVerifyDigest(
                    createP256KeyExchange(scalar).publicKey,
                    new Uint8Array(length),
                    timestamp,
                ),
            ).toThrow();
        }
    });

    it('authenticates nonce, ciphertext and every tag byte before returning plaintext', () => {
        for (let i = 0; i < secret.length; i++) {
            const mutated = Buffer.from(secret);
            mutated[i] ^= 1;
            expect(() => decryptKeyExchangeBytes(mutated, shared)).toThrow();
        }

        expect(() => decryptKeyExchangeBytes(secret, Buffer.alloc(32))).toThrow();
        expect(() =>
            decryptKeyExchangeBytes(secret.subarray(0, secret.length - 1), shared),
        ).toThrow();
    });

    it('requires exact uint32 timestamps, accepting both endpoints', () => {
        const pub = createP256KeyExchange(scalar).publicKey;

        for (const value of [-1, 0x100000000, 1.5, NaN, Infinity, -Infinity]) {
            expect(() => keyExchangeVerifyDigest(pub, secret, value)).toThrow(/uint32/);
        }

        expect(keyExchangeVerifyDigest(pub, secret, 0)).toHaveLength(32);
        expect(keyExchangeVerifyDigest(pub, secret, 0xffffffff)).toHaveLength(32);
        expect(keyExchangeVerifyDigest(pub, secret, 0)).not.toEqual(
            keyExchangeVerifyDigest(pub, secret, 0xffffffff),
        );
    });
});
