import { describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt } from '../../src/direct/qq-tea';
import { encodeTargetWtLoginNode0106 } from '../../src/direct/target-wt-login-node';
import { encodeTargetWtTgtgtEncryptedCandidate as encode } from '../../src/direct/target-wt-tgtgt-encrypted-candidate';
import { encodeTargetWtTgtgtPlainCandidate } from '../../src/direct/target-wt-tgtgt-plain-candidate';
import { deriveTargetWtTgtgtKeyCandidate } from '../../src/direct/target-wt-tgtgt-key-candidate';
import type { TargetWtTgtgtPlainInput } from '../../src/direct/target-wt-tgtgt-plain-candidate';

const bytes = (hex: string) => Buffer.from(hex, 'hex');
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const word = 0x0123456789abcdefn;
const source = () => Uint8Array.from({ length: 16 }, (_, index) => index);

const randomFixture = (size: number) => {
    const result = new Uint8Array(size);
    result[0] = 0xf8;
    return result;
};

function fixture(): TargetWtTgtgtPlainInput {
    return {
        arg3: 0x11223344,
        field04: 0x55667788,
        field08: 0x99aabbcc,
        field0c: 0xddeeff00,
        field50: 0x0123456789abcdefn,
        arg4: 0x10203040,
        field14: 0x50607080,
        field18: 0x91,
        raw5: bytes('a1a2a3'),
        raw7: bytes('b1b2'),
        field19: 0xc1,
        raw20: bytes('d1d2d3d4'),
        field10: 0x12345678,
        field00: 0x9abcdef0,
        tail38: bytes('e1e2e3'),
    };
}

// Precomputed outside the test with standalone Python struct/hashlib and a
// separately written 16-cycle TEA + two-feedback-chain implementation.
// Every source byte, scalar, prefix and resulting output is synthetic.
const plainHex =
    '0004112233445566778899aabbccddeeff000123456789abcdef1020304050607080' +
    '91a1a2a3b1b200000000c1d1d2d3d4123456789abcdef00003e1e2e3';
const keyHex = 'bfb2ad3f64569d86ddd86477fcf67880';
const cipherHex =
    'e87a61b20db4d45d427c1dc397ad6782ef54e6ae3b498f92ef92aca96cc3dddc' +
    'efbf35e70e6a8033478507ac500296808986b5db5565446aebf9335c6ab93e8f' +
    '0d4db31748625b33';
const failure = 'target WT tgtgt encrypted candidate failed';

describe('offline target WT tgtgt encrypted candidate', () => {
    it('matches an independently precomputed complete ciphertext and decrypts every visible byte', () => {
        const input = fixture();
        const keySource = source();
        const random = vi.fn(randomFixture);
        const output = encode(input, keySource, word, random);
        expect(hex(encodeTargetWtTgtgtPlainCandidate(input))).toBe(plainHex);
        expect(hex(deriveTargetWtTgtgtKeyCandidate(keySource, word))).toBe(keyHex);
        expect(hex(output)).toBe(cipherHex);
        expect(hex(encodeTargetWtLoginNode0106(output))).toBe('01060048' + cipherHex);
        expect(hex(qqTeaDecrypt(output, bytes(keyHex)))).toBe(plainHex);
        expect(random).toHaveBeenCalledTimes(1);
        expect(random).toHaveBeenCalledWith(3);
        expect(hex(keySource)).toBe('000102030405060708090a0b0c0d0e0f');
        expect(input).toEqual(fixture());
    });

    it('snapshots key and every plaintext field before a callback mutates caller state', () => {
        const input = fixture();
        const keySource = source();
        const random = vi.fn((size: number) => {
            keySource.fill(0xff);
            input.raw5.fill(0xff);
            input.raw7.fill(0xff);
            input.raw20.fill(0xff);
            input.tail38.fill(0xff);
            input.arg3 = 0;
            input.field50 = 0n;
            return randomFixture(size);
        });
        const output = encode(input, keySource, word, random);
        expect(hex(output)).toBe(cipherHex);
        expect(hex(qqTeaDecrypt(output, bytes(keyHex)))).toBe(plainHex);
        expect(random).toHaveBeenCalledTimes(1);
        expect(keySource.every((byte) => byte === 0xff)).toBe(true);
        expect(input.raw5.every((byte) => byte === 0xff)).toBe(true);
    });

    it('handles all padding alignments and both empty and nonempty tails', () => {
        const seen = new Set<number>();

        for (let size = 0; size < 16; size++) {
            const input = fixture();
            input.tail38 = Uint8Array.from({ length: size }, (_, index) => index + 1);
            const expected = encodeTargetWtTgtgtPlainCandidate(input);
            const key = deriveTargetWtTgtgtKeyCandidate(source(), word);
            const padding = (8 - ((expected.length + 10) % 8)) % 8;
            const random = vi.fn(randomFixture);
            const output = encode(input, source(), word, random);
            expect(random).toHaveBeenCalledExactlyOnceWith(padding + 3);
            expect(qqTeaDecrypt(output, key)).toEqual(expected);
            seen.add(padding);
        }

        expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('rejects invalid plaintext, key source, and key word before randomness', () => {
        const invalidInputs: unknown[] = [
            null,
            { ...fixture(), field18: 256 },
            { ...fixture(), field50: -1n },
            { ...fixture(), tail38: new Uint8Array(65536) },
            { ...fixture(), raw5: new Uint16Array(1) },
            { ...fixture(), extra: 1 },
        ];

        for (const input of invalidInputs) {
            const random = vi.fn(randomFixture);
            expect(() => encode(input as TargetWtTgtgtPlainInput, source(), word, random)).toThrow(
                failure,
            );
            expect(random).not.toHaveBeenCalled();
        }

        const invalidSources: unknown[] = [
            null,
            new Uint8Array(25),
            new Uint16Array(3),
            new Uint8Array(new SharedArrayBuffer(16)),
        ];

        for (const keySource of invalidSources) {
            const random = vi.fn(randomFixture);
            expect(() => encode(fixture(), keySource as Uint8Array, word, random)).toThrow(failure);
            expect(random).not.toHaveBeenCalled();
        }

        for (const keyWord of [-1n, 1n << 64n, 1, '1']) {
            const random = vi.fn(randomFixture);
            expect(() => encode(fixture(), source(), keyWord as bigint, random)).toThrow(failure);
            expect(random).not.toHaveBeenCalled();
        }
    });

    it('normalizes synchronous callback exceptions and invalid callback output', () => {
        const random = vi.fn(() => {
            throw new Error('synthetic secret callback detail');
        });
        expect(() => encode(fixture(), source(), word, random)).toThrowError(
            /^target WT tgtgt encrypted candidate failed$/,
        );
        expect(random).toHaveBeenCalledTimes(1);

        for (const callback of [null, 42, () => new Uint8Array(0), () => new Uint16Array(3)]) {
            expect(() =>
                encode(fixture(), source(), word, callback as (size: number) => Uint8Array),
            ).toThrowError(/^target WT tgtgt encrypted candidate failed$/);
        }
    });

    it.each([false, true])(
        'clears private plain and derived key after success or callback failure: %s',
        async (fail) => {
            vi.resetModules();
            let plaintext: Uint8Array | undefined;
            let privateKey: Uint8Array | undefined;
            vi.doMock('../../src/direct/qq-tea', async (importOriginal) => {
                const actual = await importOriginal<typeof import('../../src/direct/qq-tea')>();
                return {
                    ...actual,
                    qqTeaEncrypt: (
                        plain: Uint8Array,
                        key: Uint8Array,
                        random: (n: number) => Uint8Array,
                    ) => {
                        plaintext = plain;
                        privateKey = key;
                        expect(hex(plain)).toBe(plainHex);
                        expect(hex(key)).toBe(keyHex);
                        return actual.qqTeaEncrypt(plain, key, random);
                    },
                };
            });
            const input = fixture();
            const keySource = source();
            const randomPrefix = randomFixture(3);
            let result: Uint8Array | undefined;

            try {
                const isolated =
                    await import('../../src/direct/target-wt-tgtgt-encrypted-candidate');

                if (fail) {
                    expect(() =>
                        isolated.encodeTargetWtTgtgtEncryptedCandidate(
                            input,
                            keySource,
                            word,
                            () => {
                                throw new Error('synthetic private failure');
                            },
                        ),
                    ).toThrowError(/^target WT tgtgt encrypted candidate failed$/);
                } else {
                    result = isolated.encodeTargetWtTgtgtEncryptedCandidate(
                        input,
                        keySource,
                        word,
                        () => randomPrefix,
                    );
                }
            } finally {
                vi.doUnmock('../../src/direct/qq-tea');
                vi.resetModules();
            }

            expect(plaintext).toBeDefined();
            expect(privateKey).toBeDefined();
            expect(plaintext!.every((byte) => byte === 0)).toBe(true);
            expect(privateKey!.every((byte) => byte === 0)).toBe(true);
            expect(input).toEqual(fixture());
            expect(keySource).toEqual(source());
            expect(randomPrefix).toEqual(randomFixture(3));

            if (result) {
                expect(hex(result)).toBe(cipherHex);
            }
        },
    );

    it('normalizes shared, detached and proxied random outputs and clears private values', async () => {
        vi.resetModules();
        let plaintext: Uint8Array | undefined;
        let privateKey: Uint8Array | undefined;
        vi.doMock('../../src/direct/qq-tea', async (importOriginal) => {
            const actual = await importOriginal<typeof import('../../src/direct/qq-tea')>();
            return {
                ...actual,
                qqTeaEncrypt: (
                    plain: Uint8Array,
                    key: Uint8Array,
                    random: (size: number) => Uint8Array,
                ) => {
                    plaintext = plain;
                    privateKey = key;
                    return actual.qqTeaEncrypt(plain, key, random);
                },
            };
        });
        const detached = new Uint8Array(3);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const values = [
            new Uint8Array(new SharedArrayBuffer(3)),
            detached,
            new Proxy(new Uint8Array(3), {}),
        ];

        try {
            const isolated = await import('../../src/direct/target-wt-tgtgt-encrypted-candidate');

            for (const value of values) {
                plaintext = undefined;
                privateKey = undefined;
                const random = vi.fn(() => value);
                expect(() =>
                    isolated.encodeTargetWtTgtgtEncryptedCandidate(
                        fixture(),
                        source(),
                        word,
                        random,
                    ),
                ).toThrowError(/^target WT tgtgt encrypted candidate failed$/);
                expect(random).toHaveBeenCalledExactlyOnceWith(3);
                expect(plaintext).toBeDefined();
                expect(privateKey).toBeDefined();
                expect(plaintext!.every((byte) => byte === 0)).toBe(true);
                expect(privateKey!.every((byte) => byte === 0)).toBe(true);
            }
        } finally {
            vi.doUnmock('../../src/direct/qq-tea');
            vi.resetModules();
        }
    });

    it('clears allocated plaintext when key derivation fails before encryption', async () => {
        vi.resetModules();
        let plaintext: Uint8Array | undefined;
        vi.doMock('../../src/direct/target-wt-tgtgt-plain-candidate', async (importOriginal) => {
            const actual =
                await importOriginal<
                    typeof import('../../src/direct/target-wt-tgtgt-plain-candidate')
                >();
            return {
                ...actual,
                encodeTargetWtTgtgtPlainCandidate: (input: TargetWtTgtgtPlainInput) => {
                    plaintext = actual.encodeTargetWtTgtgtPlainCandidate(input);
                    return plaintext;
                },
            };
        });
        const random = vi.fn(randomFixture);

        try {
            const isolated = await import('../../src/direct/target-wt-tgtgt-encrypted-candidate');
            expect(() =>
                isolated.encodeTargetWtTgtgtEncryptedCandidate(
                    fixture(),
                    new Uint8Array(25),
                    word,
                    random,
                ),
            ).toThrowError(/^target WT tgtgt encrypted candidate failed$/);
        } finally {
            vi.doUnmock('../../src/direct/target-wt-tgtgt-plain-candidate');
            vi.resetModules();
        }

        expect(random).not.toHaveBeenCalled();
        expect(plaintext).toBeDefined();
        expect(plaintext!.every((byte) => byte === 0)).toBe(true);
    });
});
