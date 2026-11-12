import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { qqTeaEncrypt } from '../../src/direct/qq-tea';
import {
    decodeTargetServiceDecryptCandidate,
    MAX_TARGET_SERVICE_DECRYPT_CANDIDATE_BYTES,
} from '../../src/direct/target-service-decrypt-candidate';

const failure = 'target service decrypt candidate decoding failed';
const key = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const random = (length: number): Uint8Array => new Uint8Array(length).fill(0xa8);

function encrypt(plain: Uint8Array): Uint8Array {
    return qqTeaEncrypt(plain, key, random);
}

describe('local target service plaintext candidate', () => {
    it('copies a nonempty selector 0 body, rejecting an extra key as local policy', () => {
        const backing = Uint8Array.of(9, 1, 2, 3, 8);
        const body = backing.subarray(1, 4);
        const result = decodeTargetServiceDecryptCandidate(0, body);
        expect(result).toEqual({ kind: 'plaintext-candidate', data: Uint8Array.of(1, 2, 3) });
        expect(backing).toEqual(Uint8Array.of(9, 1, 2, 3, 8));
        backing[1] = 5;
        expect(result.data[0]).toBe(1);
        result.data[1] = 7;
        expect(backing[2]).toBe(2);
        expect(() => decodeTargetServiceDecryptCandidate(0, body, key)).toThrow(failure);
        expect(() => decodeTargetServiceDecryptCandidate(0, new Uint8Array())).toThrow(failure);
    });

    it.each([1, 2])('decrypts exactly one explicitly keyed selector %i candidate', (selector) => {
        const plain = Uint8Array.of(0, 255, 1, 42, 128);
        const cipher = encrypt(plain);
        const cipherBacking = new Uint8Array(cipher.length + 2);
        cipherBacking.set(cipher, 1);
        const keyBacking = new Uint8Array(18);
        keyBacking.set(key, 1);
        const cipherBefore = cipherBacking.slice();
        const keyBefore = keyBacking.slice();
        const result = decodeTargetServiceDecryptCandidate(
            selector,
            cipherBacking.subarray(1, -1),
            keyBacking.subarray(1, -1),
        );
        expect(result).toEqual({ kind: 'plaintext-candidate', data: plain });
        expect(cipherBacking).toEqual(cipherBefore);
        expect(keyBacking).toEqual(keyBefore);
        cipherBacking.fill(0);
        keyBacking.fill(0);
        expect(result.data).toEqual(plain);
        result.data[0] = 10;
        expect(cipherBacking).toEqual(new Uint8Array(cipherBacking.length));
        expect(keyBacking).toEqual(new Uint8Array(keyBacking.length));
    });

    it('rejects encrypted empty plaintext and malformed framing uniformly', () => {
        const empty = encrypt(new Uint8Array());
        const malformed = Uint8Array.from(Buffer.from('7901fcd147d4b7da8537a4a39ddeceb0', 'hex'));

        for (const selector of [1, 2]) {
            expect(() => decodeTargetServiceDecryptCandidate(selector, empty, key)).toThrow(
                failure,
            );
            expect(() =>
                decodeTargetServiceDecryptCandidate(selector, malformed, new Uint8Array(16)),
            ).toThrow(failure);
            expect(empty).toEqual(encrypt(new Uint8Array()));
        }
    });

    it('rejects invalid selectors, key sizes and ciphertext sizes with the same error', () => {
        const cipher = encrypt(Uint8Array.of(1));

        for (const selector of [-1, 3, 255, 0.5, NaN, Infinity, '1', null]) {
            expect(() =>
                decodeTargetServiceDecryptCandidate(selector as number, cipher, key),
            ).toThrow(failure);
        }

        for (const selector of [1, 2]) {
            expect(() => decodeTargetServiceDecryptCandidate(selector, cipher)).toThrow(failure);

            for (const size of [0, 15, 17, 32]) {
                expect(() =>
                    decodeTargetServiceDecryptCandidate(selector, cipher, new Uint8Array(size)),
                ).toThrow(failure);
            }

            for (const size of [0, 1, 8, 15, 17, 23]) {
                expect(() =>
                    decodeTargetServiceDecryptCandidate(selector, new Uint8Array(size), key),
                ).toThrow(failure);
            }
        }
    });

    it('enforces the input cap independently of forged lengths', () => {
        const cap = MAX_TARGET_SERVICE_DECRYPT_CANDIDATE_BYTES;
        const input = new Uint8Array(cap);
        input[0] = 3;
        input[cap - 1] = 4;
        const result = decodeTargetServiceDecryptCandidate(0, input);
        expect(result.data.length).toBe(cap);
        expect(result.data[0]).toBe(3);
        expect(result.data[cap - 1]).toBe(4);
        const tooLarge = new Uint8Array(cap + 8);
        Object.defineProperty(tooLarge, 'byteLength', { value: 16 });
        Object.defineProperty(tooLarge, 'length', { value: 16 });
        expect(() => decodeTargetServiceDecryptCandidate(0, tooLarge)).toThrow(failure);
        expect(() => decodeTargetServiceDecryptCandidate(1, tooLarge, key)).toThrow(failure);
        const shortKey = new Uint8Array(15);
        Object.defineProperty(shortKey, 'length', { value: 16 });
        Object.defineProperty(shortKey, 'byteLength', { value: 16 });
        expect(() => decodeTargetServiceDecryptCandidate(1, new Uint8Array(16), shortKey)).toThrow(
            failure,
        );
    });

    it('wipes both private snapshots when the second copy throws', async () => {
        const cipher = encrypt(Uint8Array.of(1, 2, 3));
        const originalSet = Uint8Array.prototype.set;
        const copies: Uint8Array[] = [];
        vi.resetModules();
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source: ArrayLike<number>,
            offset?: number,
        ) {
            copies.push(this);
            originalSet.call(this, source, offset);

            if (copies.length === 2) {
                throw new Error('synthetic copy failure');
            }
        });

        try {
            const module = await import('../../src/direct/target-service-decrypt-candidate');
            expect(() => module.decodeTargetServiceDecryptCandidate(1, cipher, key)).toThrow(
                failure,
            );
        } finally {
            spy.mockRestore();
        }

        expect(copies).toHaveLength(2);
        expect(copies[0]).toEqual(new Uint8Array(cipher.length));
        expect(copies[1]).toEqual(new Uint8Array(16));
        expect(cipher).toEqual(encrypt(Uint8Array.of(1, 2, 3)));
        expect(key).toEqual(Uint8Array.from({ length: 16 }, (_, i) => i + 1));
    });

    it('uses intrinsic slots without reading shadow properties, accepting foreign arrays', () => {
        const plain = Uint8Array.of(3, 4, 5);
        const cipher = encrypt(plain);
        const foreignCipher = runInNewContext(
            `new Uint8Array([${Array.from(cipher)}])`,
        ) as Uint8Array;
        const foreignKey = runInNewContext(`new Uint8Array([${Array.from(key)}])`) as Uint8Array;
        let calls = 0;

        for (const value of [foreignCipher, foreignKey]) {
            for (const name of [
                'length',
                'byteLength',
                'byteOffset',
                'buffer',
                'subarray',
                Symbol.iterator,
                Symbol.toStringTag,
            ]) {
                Object.defineProperty(value, name, {
                    get() {
                        calls++;
                        throw new Error('SECRET');
                    },
                });
            }
        }

        expect(decodeTargetServiceDecryptCandidate(1, foreignCipher, foreignKey).data).toEqual(
            plain,
        );
        expect(decodeTargetServiceDecryptCandidate(0, foreignKey).data).toEqual(key);
        expect(calls).toBe(0);
    });

    it('rejects invalid input and key views without triggering getters or leaking errors', () => {
        let calls = 0;
        const proxy = new Proxy(new Uint8Array(16), {
            get() {
                calls++;
                throw new Error('SECRET');
            },
        });
        const revoked = Proxy.revocable(new Uint8Array(16), {});
        revoked.revoke();
        const fake = Object.defineProperty({}, 'byteLength', {
            get() {
                calls++;
                throw new Error('SECRET');
            },
        });
        const detached = new Uint8Array(16);
        structuredClone(detached, { transfer: [detached.buffer] });
        const resize = new ArrayBuffer(20, { maxByteLength: 32 });
        const outOfBounds = new Uint8Array(resize, 4, 16);
        resize.resize(4);
        const values = [
            proxy,
            revoked.proxy,
            fake,
            detached,
            outOfBounds,
            new Uint8Array(new SharedArrayBuffer(16)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(16))'),
            new Uint16Array(16),
            new Uint8ClampedArray(16),
            new DataView(new ArrayBuffer(16)),
            null,
        ];
        const cipher = encrypt(Uint8Array.of(1));

        for (const value of values) {
            expect(() => decodeTargetServiceDecryptCandidate(0, value as never)).toThrow(failure);
            expect(() => decodeTargetServiceDecryptCandidate(1, value as never, key)).toThrow(
                failure,
            );
            expect(() => decodeTargetServiceDecryptCandidate(1, cipher, value as never)).toThrow(
                failure,
            );
        }

        expect(calls).toBe(0);
    });
});
