import { constants, createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    LINUX_QQ_APP_SIGNATURE_MAX_DATA_BYTES,
    LINUX_QQ_APP_SIGNATURE_MAX_PUBLIC_KEY_DER_BYTES,
    verifyLinuxQQAppSignatureReference as verifyFile,
} from '../../src/direct/linux-qq-app-signature-verify';

// Synthetic keys and bytes exercise a local primitive only. They establish
// neither compatibility with a real target nor the identity or trust of a key.
const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keyPair.publicKey.export({ format: 'der', type: 'spki' });
const otherPublicKey = otherKeyPair.publicKey.export({ format: 'der', type: 'spki' });

function signMessage(message: Uint8Array, saltLength = 32): Buffer {
    return sign('sha256', message, {
        key: keyPair.privateKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength,
    });
}

function signData(data: Uint8Array, saltLength = 32): Buffer {
    const hex = createHash('sha256').update(data).digest('hex');
    return signMessage(Buffer.from(hex, 'ascii'), saltLength);
}

describe('offline synthetic Linux file-signature reference', () => {
    it.each([Buffer.alloc(0), Buffer.from([0, 1, 2, 0xfe, 0xff])])(
        'verifies a synthetic signature of lowercase hash ASCII without changing inputs',
        (data) => {
            const key = Buffer.from(publicKey);
            const signature = signData(data);
            const snapshots = [Buffer.from(data), Buffer.from(key), Buffer.from(signature)];
            expect(signature).toHaveLength(256);
            expect(verifyFile(data, key, signature)).toBe(true);
            expect([data, key, signature]).toEqual(snapshots);
        },
    );

    it('uses only the specified views and leaves surrounding bytes unchanged', () => {
        const dataBacking = Buffer.from([0xaa, 1, 2, 3, 0xbb]);
        const keyBacking = Buffer.concat([Buffer.of(0xaa), publicKey, Buffer.of(0xbb)]);
        const data = dataBacking.subarray(1, -1);
        const key = keyBacking.subarray(1, -1);
        const signatureBacking = Buffer.concat([Buffer.of(0xaa), signData(data), Buffer.of(0xbb)]);
        const signature = signatureBacking.subarray(1, -1);
        const snapshots = [
            Buffer.from(dataBacking),
            Buffer.from(keyBacking),
            Buffer.from(signatureBacking),
        ];
        expect(verifyFile(data, key, signature)).toBe(true);
        expect([dataBacking, keyBacking, signatureBacking]).toEqual(snapshots);
    });

    it('returns false for changed data, changed signature, or another RSA-2048 key', () => {
        const data = Buffer.from('synthetic file contents');
        const signature = signData(data);
        const changedData = Buffer.from(data);
        const changedSignature = Buffer.from(signature);
        changedData[0] ^= 1;
        changedSignature[0] ^= 1;
        expect(verifyFile(changedData, publicKey, signature)).toBe(false);
        expect(verifyFile(data, publicKey, changedSignature)).toBe(false);
        expect(verifyFile(data, otherPublicKey, signature)).toBe(false);
    });

    it('rejects different PSS salt and different constructions of the signed message', () => {
        const data = Buffer.from('synthetic file contents');
        const digest = createHash('sha256').update(data).digest();
        const upper = Buffer.from(digest.toString('hex').toUpperCase(), 'ascii');
        expect(verifyFile(data, publicKey, signData(data, 20))).toBe(false);
        expect(verifyFile(data, publicKey, signMessage(digest))).toBe(false);
        expect(verifyFile(data, publicKey, signMessage(upper))).toBe(false);
        expect(verifyFile(data, publicKey, signMessage(data))).toBe(false);
    });

    it('throws for malformed DER, a wrong key type or RSA modulus size', () => {
        const data = Buffer.of(1, 2, 3);
        const signature = signData(data);
        const smallKey = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey;
        const ecKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
        const pssKey = generateKeyPairSync('rsa-pss', { modulusLength: 2048 }).publicKey;

        for (const key of [
            Buffer.alloc(0),
            Buffer.from([0x30, 0x01, 0x00]),
            Buffer.concat([publicKey, Buffer.of(0)]),
            smallKey.export({ format: 'der', type: 'spki' }),
            ecKey.export({ format: 'der', type: 'spki' }),
            pssKey.export({ format: 'der', type: 'spki' }),
            new Uint8Array(LINUX_QQ_APP_SIGNATURE_MAX_PUBLIC_KEY_DER_BYTES + 1),
        ]) {
            expect(() => verifyFile(data, key, signature)).toThrow();
        }
    });

    it('throws for signature lengths other than 256 bytes', () => {
        const data = Buffer.of(1, 2, 3);

        for (const length of [0, 1, 255, 257]) {
            expect(() => verifyFile(data, publicKey, new Uint8Array(length))).toThrow();
        }
    });

    it('throws on invalid, proxied, shared, resizable or detached byte views in every position', () => {
        const data = Buffer.of(1, 2, 3);
        const signature = signData(data);
        const detached = new Uint8Array(256);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const invalid: unknown[] = [
            null,
            new Error('synthetic invalid input'),
            {},
            new DataView(new ArrayBuffer(256)),
            new Proxy(new Uint8Array(256), {}),
            new Uint8Array(new SharedArrayBuffer(256)),
            new Uint8Array(new ArrayBuffer(256, { maxByteLength: 512 })),
            detached,
        ];

        for (const value of invalid) {
            const bytes = value as Uint8Array;
            expect(() => verifyFile(bytes, publicKey, signature)).toThrow();
            expect(() => verifyFile(data, bytes, signature)).toThrow();
            expect(() => verifyFile(data, publicKey, bytes)).toThrow();
        }
    });

    it('rejects data exceeding the local size limit before processing it', () => {
        const oversized = new Uint8Array(LINUX_QQ_APP_SIGNATURE_MAX_DATA_BYTES + 1);
        expect(() => verifyFile(oversized, publicKey, Buffer.alloc(256))).toThrow();
    });
});
