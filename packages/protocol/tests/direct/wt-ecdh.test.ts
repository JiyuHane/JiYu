import { describe, expect, it } from 'vitest';
import { createWtEcdh, referenceWtServerPublicKey } from '../../src/direct/wt-ecdh';
import { buildWtQrFrame } from '../../src/direct/wt-qr-frame';
import { qqTeaDecrypt } from '../../src/direct/qq-tea';

// Synthetic fixtures only. Generator coordinates are from SEC 2 secp192k1;
// the server point is the complete point in the cited WtLogin source.
const generatorX = 'db4ff10ec057e9ae26b07d0280b7f4341da5d1b1eae06c7d';
const generatorY = '9b2f2f6d9c5628a7844163d015be86344082aa88d95e2f9d';
const generator = Buffer.from(`04${generatorX}${generatorY}`, 'hex');
const compressedGenerator = Buffer.from(`03${generatorX}`, 'hex');
const server = Buffer.from(
    '04928d8850673088b343264e0c6bacb8496d697799f37211de' +
        'b25bb73906cb089fea9639b4e0260498b51a992d50813da8',
    'hex',
);
const order = Buffer.from('fffffffffffffffffffffffe26f2fc170f69466a74defd8d', 'hex');

function scalar(value: number): Buffer {
    const result = Buffer.alloc(24);
    result.writeUInt32BE(value, 20);
    return result;
}

function hex(value: Uint8Array): string {
    return Buffer.from(value).toString('hex');
}

describe('OICQ secp192k1 ECDH', () => {
    it('matches the generator and complete shared X and MD5 for scalar 1', () => {
        const alice = createWtEcdh(scalar(1));
        expect(Buffer.from(alice.publicKey)).toEqual(compressedGenerator);
        expect(alice.publicKey).toHaveLength(25);
        expect(hex(alice.sharedSecret(generator))).toBe(generatorX);
        expect(hex(alice.sharedSecret(compressedGenerator))).toBe(generatorX);
        expect(hex(alice.deriveTeaKey(generator))).toBe('eac0f2871a65d3e4712830f89e57f02a');
        expect(alice.deriveTeaKey(generator)).toHaveLength(16);
    });

    it('accepts the complete reference server point explicitly', () => {
        const alice = createWtEcdh(scalar(1));
        expect(Buffer.from(referenceWtServerPublicKey())).toEqual(server);
        expect(server).toHaveLength(49);
        expect(hex(alice.sharedSecret(server))).toBe(
            '928d8850673088b343264e0c6bacb8496d697799f37211de',
        );
        expect(hex(alice.deriveTeaKey(server))).toBe('52b1df46e3a22e9a441140d7b0e91d9a');
        expect(alice.deriveTeaKey(referenceWtServerPublicKey())).toEqual(
            alice.deriveTeaKey(server),
        );
    });

    it('rejects a missing peer at runtime', () => {
        const alice = createWtEcdh(scalar(1));
        // @ts-expect-error Exercise an untyped caller omitting the required peer.
        expect(() => alice.sharedSecret()).toThrow(/public key/);
        // @ts-expect-error Exercise an untyped caller omitting the required peer.
        expect(() => alice.deriveTeaKey()).toThrow(/public key/);
    });

    it('derives matching secrets and tea keys across independent pairs', () => {
        const alice = createWtEcdh(scalar(2));
        const bob = createWtEcdh(scalar(3));
        expect(alice.sharedSecret(bob.publicKey)).toHaveLength(24);
        expect(alice.sharedSecret(bob.publicKey)).toEqual(bob.sharedSecret(alice.publicKey));
        expect(alice.deriveTeaKey(bob.publicKey)).toEqual(bob.deriveTeaKey(alice.publicKey));
        const randomA = createWtEcdh();
        const randomB = createWtEcdh();
        expect(randomA.publicKey).not.toEqual(randomB.publicKey);
        expect(randomA.deriveTeaKey(randomB.publicKey)).toEqual(
            randomB.deriveTeaKey(randomA.publicKey),
        );
    });

    it('preserves and hashes the leading zero in a 24-byte shared X', () => {
        // Public point 269*G; with scalar 1, its X is the shared X.
        const peer = Buffer.from('0200b6ce05383eb0aaff23e6b5eff338fa97df3c2d9bf3d34e', 'hex');
        const alice = createWtEcdh(scalar(1));
        expect(createWtEcdh(scalar(269)).publicKey).toEqual(Uint8Array.from(peer));
        expect(hex(alice.sharedSecret(peer))).toBe(
            '00b6ce05383eb0aaff23e6b5eff338fa97df3c2d9bf3d34e',
        );
        expect(hex(alice.deriveTeaKey(peer))).toBe('c7537c91968a380a5d8a2eed10e0b1f9');
    });

    it('rejects invalid scalar lengths and values including the group order', () => {
        for (const length of [0, 1, 23, 25, 32]) {
            expect(() => createWtEcdh(new Uint8Array(length))).toThrow(/scalar/);
        }
        expect(() => createWtEcdh(new Uint8Array(24))).toThrow(/scalar/);
        expect(() => createWtEcdh(order)).toThrow(/scalar/);
        expect(() => createWtEcdh(Buffer.alloc(24, 0xff))).toThrow(/scalar/);
        const lastValid = Buffer.from(order);
        lastValid[23]--;
        expect(createWtEcdh(lastValid).publicKey).toHaveLength(25);
    });

    it('rejects invalid lengths, prefixes, off-curve points and infinity', () => {
        const alice = createWtEcdh(scalar(1));
        const invalid = [
            new Uint8Array(0),
            new Uint8Array(1),
            new Uint8Array(24),
            new Uint8Array(26),
            new Uint8Array(48),
            new Uint8Array(50),
            Buffer.concat([Buffer.from([4]), compressedGenerator.subarray(1)]),
            Buffer.concat([Buffer.from([2]), generator.subarray(1)]),
            Buffer.alloc(49),
            Buffer.concat([Buffer.from([4]), Buffer.alloc(48)]),
            Buffer.concat([Buffer.from([2]), Buffer.alloc(24, 0xff)]),
            Buffer.concat([Buffer.from([6]), generator.subarray(1)]),
        ];
        for (const point of invalid) {
            expect(() => alice.sharedSecret(point)).toThrow();
            expect(() => alice.deriveTeaKey(point)).toThrow();
        }
    });

    it('returns isolated public-key copies and prevents property replacement', () => {
        const alice = createWtEcdh(scalar(1));
        const first = alice.publicKey;
        const second = alice.publicKey;
        expect(first).not.toBe(second);
        expect(first).toEqual(second);
        first.fill(0);
        expect(second).toEqual(Uint8Array.from(compressedGenerator));
        expect(alice.publicKey).toEqual(Uint8Array.from(compressedGenerator));
        expect(Object.isFrozen(alice)).toBe(true);
        expect(Reflect.set(alice, 'publicKey', new Uint8Array(25))).toBe(false);
        expect(() =>
            Object.defineProperty(alice, 'publicKey', { value: new Uint8Array(25) }),
        ).toThrow();
        expect(alice.publicKey).toEqual(Uint8Array.from(compressedGenerator));
    });

    it('keeps the QR head consistent with the ECDH scalar after a caller changes a copy', async () => {
        const alice = createWtEcdh(scalar(1));
        const bob = createWtEcdh(scalar(2));
        alice.publicKey.fill(0);
        expect(Reflect.set(alice, 'publicKey', new Uint8Array(25))).toBe(false);
        let signedBody: Uint8Array | undefined;
        await buildWtQrFrame(
            {
                uin: '0',
                sequence: 1,
                timestamp: 1234,
                appId: 1,
                subAppId: 2,
                clientVersion: 3,
                ssoVersion: 'test',
                guid: Uint8Array.of(1),
                unknown21: new Uint8Array(21),
                randomKey: new Uint8Array(16),
                ecdh: alice,
                peerPublicKey: bob.publicKey,
                serviceCommand: 'test',
                buildReserved: async ({ body }) => {
                    signedBody = Uint8Array.from(body);
                    return new Uint8Array();
                },
            },
            { type: 'poll', qrSig: Uint8Array.of(1) },
        );
        expect(signedBody).toBeDefined();
        const oicq = Buffer.from(signedBody!);
        expect(oicq.readUInt16BE(46)).toBe(25);
        const transmitted = oicq.subarray(48, 73);
        expect(transmitted).toEqual(compressedGenerator);
        const decoded = Buffer.from(
            qqTeaDecrypt(oicq.subarray(73, -1), bob.deriveTeaKey(transmitted)),
        );
        expect(decoded.readUInt32BE(14)).toBe(1234);
        expect(decoded.readUInt16BE(21)).toBe(0x12);
    });

    it('does not mutate input views or retain mutable output aliases', () => {
        const privateBacking = Buffer.concat([Buffer.from([0xaa]), scalar(1), Buffer.from([0xbb])]);
        const publicBacking = Buffer.concat([Buffer.from([0xcc]), server, Buffer.from([0xdd])]);
        const privateOriginal = Buffer.from(privateBacking);
        const publicOriginal = Buffer.from(publicBacking);
        const privateView = privateBacking.subarray(1, 25);
        const publicView = publicBacking.subarray(1, 50);
        const alice = createWtEcdh(privateView);
        const originalPublic = Uint8Array.from(alice.publicKey);
        const originalKey = alice.deriveTeaKey(publicView);
        expect(privateBacking).toEqual(privateOriginal);
        expect(publicBacking).toEqual(publicOriginal);
        privateView.fill(0);
        alice.publicKey.fill(0);
        referenceWtServerPublicKey().fill(0);
        originalKey.fill(0);
        expect(alice.deriveTeaKey(publicView)).toEqual(
            createWtEcdh(scalar(1)).deriveTeaKey(server),
        );
        expect(createWtEcdh(scalar(1)).publicKey).toEqual(originalPublic);
        expect(Buffer.from(referenceWtServerPublicKey())).toEqual(server);
        expect(publicBacking).toEqual(publicOriginal);
    });
});
