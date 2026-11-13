import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';

// Independent oracle: MiraiGo binary/tea.go at commit
// 2b2be6693df1219d867300c6f6cd0f804c59d620, run with the key below,
// messages 00..(length-1), its fixed F8 header and all-zero filler.
// https://github.com/Mrs4s/MiraiGo/blob/2b2be6693df1219d867300c6f6cd0f804c59d620/binary/tea.go
// These are synthetic bytes; no QQ runtime, capture, or account was used.
const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const vectors = [
    [0, '1ac2675390c203563a96b3c769074bb5'],
    [3, 'b619e9103a2640d8262b6860a4102374'],
    [
        64,
        '1ac2675390c20356d73df63bea4384c7157f15dd9c5fb85036eaef697a32c2bc' +
            'd68ada31632ead93b8bb268cfdbb51ac85a25a5195ca37ff4d450d2c6d1ee658' +
            '901efe4ca6e4f5f6d2e1d8a5a87387be',
    ],
    [
        256,
        '1ac2675390c20356d73df63bea4384c7157f15dd9c5fb85036eaef697a32c2bc' +
            'd68ada31632ead93b8bb268cfdbb51ac85a25a5195ca37ff4d450d2c6d1ee658' +
            '901efe4ca6e4f5f632f896d8cb39468591e1c5528212aa0942e6de8743ef1835' +
            '83b11e74e3370ec789347bfced58df7fbfdc4d75fafdf30af3ca6afbe6d4e68f' +
            '23f08ef29fcaa163d357bac14b7aac6d4d1b2f10e62b467e0a94dd47b259b61' +
            '2de01777fd09a5edc8c4d31da6787307a2046f8b27851b4922a44e03446d18' +
            'c2bd8454f204dfd8b65771bb1eabbc43e9e5e9ccf97cf8555a37031b4f87d09' +
            'fe36e51726c04d679f4a2e478fb3971548e82f2e86fac9999d582e36e13e605' +
            'e62fddcc63f0e79736cde80dec98c18c6fecb',
    ],
] as const;

function fixtureRandom(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    bytes[0] = 0xf8;
    return bytes;
}

function message(length: number): Uint8Array {
    return Uint8Array.from({ length }, (_, i) => i & 0xff);
}

describe('QQ-TEA', () => {
    it.each(vectors)(
        'matches the independent %i-byte wire vector in both directions',
        (length, expected) => {
            const plain = message(length);
            const cipher = Buffer.from(expected, 'hex');
            expect(Buffer.from(qqTeaEncrypt(plain, key, fixtureRandom))).toEqual(cipher);
            expect(qqTeaDecrypt(cipher, key)).toEqual(plain);
        },
    );

    it('round-trips every prefix alignment and larger messages without modifying inputs', () => {
        for (const length of [...Array.from({ length: 24 }, (_, i) => i), 4096]) {
            const plain = message(length);
            const original = plain.slice();
            const cipher = qqTeaEncrypt(plain, key);
            const originalCipher = cipher.slice();
            expect(cipher.length % 8).toBe(0);
            expect(qqTeaDecrypt(cipher, key)).toEqual(original);
            expect(plain).toEqual(original);
            expect(cipher).toEqual(originalCipher);
        }
    });

    it('uses all random prefix bytes and accepts sliced inputs and keys', () => {
        const slicedKey = Buffer.concat([Buffer.from([42]), key, Buffer.from([43])]).subarray(
            1,
            17,
        );
        const plain = Buffer.from([42, 1, 2, 3, 43]).subarray(1, 4);
        const first = qqTeaEncrypt(plain, slicedKey, (n) => new Uint8Array(n).fill(0x11));
        const second = qqTeaEncrypt(plain, slicedKey, (n) => new Uint8Array(n).fill(0x22));
        expect(first).not.toEqual(second);
        expect(qqTeaDecrypt(first, slicedKey)).toEqual(Uint8Array.from([1, 2, 3]));
        expect(qqTeaDecrypt(second, slicedKey)).toEqual(Uint8Array.from([1, 2, 3]));
    });

    it('rejects invalid key and ciphertext lengths', () => {
        for (const length of [0, 15, 17, 32]) {
            expect(() => qqTeaEncrypt(new Uint8Array(), new Uint8Array(length))).toThrow(/key/);
            expect(() => qqTeaDecrypt(new Uint8Array(16), new Uint8Array(length))).toThrow(/key/);
        }

        for (const length of [0, 1, 7, 8, 15, 17, 23]) {
            expect(() => qqTeaDecrypt(new Uint8Array(length), key)).toThrow(
                'invalid QQ-TEA ciphertext',
            );
        }
    });

    it('preserves legacy key-first error identity, framing error and empty output', () => {
        const invalidKey = new Uint8Array(15);
        const invalidCipher = new Uint8Array(1);
        let error: unknown;

        try {
            qqTeaDecrypt(invalidCipher, invalidKey);
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(RangeError);
        expect((error as Error).name).toBe('RangeError');
        expect((error as Error).message).toBe('QQ-TEA key must be exactly 16 bytes');

        try {
            qqTeaDecrypt(invalidCipher, key);
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).constructor).toBe(Error);
        expect((error as Error).message).toBe('invalid QQ-TEA ciphertext');
        const cipher = qqTeaEncrypt(new Uint8Array(), key, fixtureRandom);
        expect(qqTeaDecrypt(cipher, key)).toEqual(new Uint8Array());
    });

    it('rejects a short or long random source result', () => {
        expect(() => qqTeaEncrypt(new Uint8Array(), key, (n) => new Uint8Array(n - 1))).toThrow(
            /random/,
        );
        expect(() => qqTeaEncrypt(new Uint8Array(), key, (n) => new Uint8Array(n + 1))).toThrow(
            /random/,
        );
    });

    it('rejects a forged length without reading caller properties', () => {
        let accessed = false;
        expect(() =>
            qqTeaEncrypt(new Uint8Array(), key, (n) => {
                const bytes = new Uint8Array(n + 3).fill(0x41);
                Object.defineProperty(bytes, 'length', { value: n });
                Object.defineProperty(bytes, 'byteLength', {
                    get() {
                        accessed = true;
                        throw new Error('SECRET');
                    },
                });
                return bytes;
            }),
        ).toThrow('QQ-TEA random source returned an invalid prefix');
        expect(accessed).toBe(false);
    });

    it('copies cross-realm sliced prefixes without touching shadow properties or caller bytes', () => {
        const plain = Uint8Array.of(1, 2, 3);
        let caller: Uint8Array | undefined;
        let accesses = 0;
        let calls = 0;
        let requested = 0;
        const cipher = qqTeaEncrypt(plain, key, (n) => {
            calls++;
            requested = n;
            caller = runInNewContext(
                `new Uint8Array(${n + 2}).fill(0x34).subarray(1, ${n + 1})`,
            ) as Uint8Array;

            for (const name of [
                'length',
                'byteLength',
                'byteOffset',
                'buffer',
                'fill',
                Symbol.iterator,
                Symbol.toStringTag,
            ]) {
                Object.defineProperty(caller, name, {
                    get() {
                        accesses++;
                        throw new Error('SECRET');
                    },
                });
            }

            return caller;
        });
        expect(calls).toBe(1);
        expect(accesses).toBe(0);
        expect(qqTeaDecrypt(cipher, key)).toEqual(plain);
        expect(Array.from({ length: requested }, (_, index) => caller![index])).toEqual(
            Array(requested).fill(0x34),
        );
    });

    it('rejects proxies, shared buffers, detached views and other typed arrays with fixed errors', () => {
        let traps = 0;
        const cases: Array<(n: number) => Uint8Array> = [
            (n) =>
                new Proxy(new Uint8Array(n), {
                    get() {
                        traps++;
                        throw new Error('SECRET');
                    },
                }),
            (n) => new Uint8Array(new SharedArrayBuffer(n)),
            (n) => runInNewContext(`new Uint8Array(new SharedArrayBuffer(${n}))`) as Uint8Array,
            (n) => {
                const bytes = new Uint8Array(n);
                structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
                return bytes;
            },
            (n) => new Uint8ClampedArray(n) as unknown as Uint8Array,
        ];

        for (const source of cases) {
            try {
                qqTeaEncrypt(Uint8Array.of(1, 2), key, source);
                expect.fail('expected invalid prefix');
            } catch (error) {
                expect(String(error)).toBe(
                    'Error: QQ-TEA random source returned an invalid prefix',
                );
                expect(String(error)).not.toContain('SECRET');
            }
        }

        expect(traps).toBe(0);
    });

    it('preserves exceptions thrown by the random callback', () => {
        const failure = new Error('synthetic callback failure');
        expect(() =>
            qqTeaEncrypt(new Uint8Array(), key, () => {
                throw failure;
            }),
        ).toThrow(failure);

        try {
            qqTeaEncrypt(new Uint8Array(), key, () => {
                throw failure;
            });
        } catch (error) {
            expect(error).toBe(failure);
        }
    });

    it('rejects independently encoded impossible padding and a nonzero trailer', () => {
        // Generated with the same independent block oracle and feedback formula,
        // key = 16 zero bytes. Decoded frames are ff + 15 zeroes and
        // f6 + 14 zeroes + 01 respectively, not valid QQ-TEA messages.
        const zeroKey = new Uint8Array(16);
        expect(() =>
            qqTeaDecrypt(Buffer.from('7901fcd147d4b7da8537a4a39ddeceb0', 'hex'), zeroKey),
        ).toThrow('invalid QQ-TEA ciphertext');
        expect(() =>
            qqTeaDecrypt(Buffer.from('f50aba246a15eccf983ee1df08622946', 'hex'), zeroKey),
        ).toThrow('invalid QQ-TEA ciphertext');
    });

    it('rejects this corrupted ciphertext and this wrong key', () => {
        const cipher = Buffer.from(vectors[2][1], 'hex');
        cipher[cipher.length - 1] ^= 1;
        expect(() => qqTeaDecrypt(cipher, key)).toThrow(/QQ-TEA/);
        expect(() => qqTeaDecrypt(Buffer.from(vectors[2][1], 'hex'), new Uint8Array(16))).toThrow(
            /QQ-TEA/,
        );
    });
});
