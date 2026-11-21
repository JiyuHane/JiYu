import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt } from '../../src/direct/qq-tea';
import { encodeTargetWtInnerEncryptedCandidate as encode } from '../../src/direct/target-wt-inner-encrypted-candidate';

type Parts = [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
const key = Uint8Array.from({ length: 16 }, (_, i) => i);
const bytes = (hex: string) => Buffer.from(hex, 'hex');
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const emptyParts = (): Parts => [
    new Uint8Array(),
    new Uint8Array(),
    new Uint8Array(),
    new Uint8Array(),
];

function fixtureRandom(size: number): Uint8Array {
    const result = new Uint8Array(size);
    result[0] = 0xf8;
    return result;
}

// Independently generated standalone 16-cycle TEA/feedback vector, also used
// by wt-login-request.test.ts. All four writer outputs are synthetic opaque bytes.
const parts: Parts = [
    bytes('016e000144'),
    bytes('0147000b112233440001760002ccdd'),
    bytes('0128001200000000000000000000014c0002aabb0000'),
    bytes('0124000c000102030405060708090a0b'),
];
const plaintextHex =
    '0004016e0001440147000b112233440001760002ccdd' +
    '0128001200000000000000000000014c0002aabb0000' +
    '0124000c000102030405060708090a0b';
const ciphertextHex =
    '955abf5506096bacac66692532a868cf9a458f0e4e1550f29969d3780269e28c' +
    '901f9640f813df993361ec495f4aecbbd7fd0ce9b7c5b05dd6bc3d261f9a2abb' +
    '06b497ce0a6cf78a';

describe('offline target WT inner encrypted candidate', () => {
    it('matches an independent complete synthetic vector without an outer wrapper', () => {
        const random = vi.fn(fixtureRandom);
        const result = encode(parts, key, random);
        expect(hex(result)).toBe(ciphertextHex);
        expect(hex(qqTeaDecrypt(result, key))).toBe(plaintextHex);
        expect(random).toHaveBeenCalledTimes(1);
        expect(random).toHaveBeenCalledWith(5);
        expect(parts.map(hex)).toEqual([
            '016e000144',
            '0147000b112233440001760002ccdd',
            '0128001200000000000000000000014c0002aabb0000',
            '0124000c000102030405060708090a0b',
        ]);
    });

    it('exercises all eight padding alignments, empty parts, and ordered opaque concatenation', () => {
        const observed = new Set<number>();

        for (let length = 0; length < 24; length++) {
            const payload = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 255);
            const input: Parts = [
                payload.subarray(0, 1),
                new Uint8Array(),
                payload.subarray(1),
                Uint8Array.of(0xff),
            ];
            const expected = Buffer.concat([bytes('0004'), Buffer.from(payload), bytes('ff')]);
            const padding = (8 - ((expected.length + 10) % 8)) % 8;
            const random = vi.fn((size: number) => new Uint8Array(size).fill(0xa8));
            const result = encode(input, key, random);
            expect(random).toHaveBeenCalledTimes(1);
            expect(random).toHaveBeenCalledWith(padding + 3);
            expect(result.length).toBe(8 * Math.ceil((expected.length + 10) / 8));
            expect(Buffer.from(qqTeaDecrypt(result, key))).toEqual(expected);
            observed.add(padding);
        }

        expect([...observed].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(hex(qqTeaDecrypt(encode(emptyParts(), key, fixtureRandom), key))).toBe('0004');
        const a = encode([parts[0], parts[1], parts[2], parts[3]], key, fixtureRandom);
        const b = encode([parts[1], parts[0], parts[2], parts[3]], key, fixtureRandom);
        expect(a).not.toEqual(b);
    });

    it('snapshots sliced, foreign, overlapping inputs and key before invoking randomness', () => {
        const backing = Buffer.from('ee000102030405060708090a0b0c0d0e0f', 'hex');
        const keyView = backing.subarray(1, 17);
        const originalKey = Uint8Array.from(keyView);
        const foreign = runInNewContext(
            'new Uint8Array([9, 0xaa, 0xbb, 9]).subarray(1, 3)',
        ) as Uint8Array;
        const input: Parts = [
            backing.subarray(1, 4),
            foreign,
            new Uint8Array(),
            backing.subarray(4, 6),
        ];
        const expected = bytes('0004000102aabb0304');
        let returnedRandom: Uint8Array | undefined;
        const output = encode(input, keyView, (size) => {
            backing.fill(0);
            foreign.fill(0);
            returnedRandom = fixtureRandom(size);
            return returnedRandom;
        });
        expect(Buffer.from(qqTeaDecrypt(output, originalKey))).toEqual(expected);
        expect(returnedRandom![0]).toBe(0xf8);
        const originalOutput = Uint8Array.from(output);
        backing.fill(0xff);
        foreign.fill(0xff);
        returnedRandom!.fill(0xff);
        expect(output).toEqual(originalOutput);
        output.fill(0);
        expect(backing.every((v) => v === 0xff)).toBe(true);
    });

    it('keeps caller bytes intact on success and random-source failure', () => {
        const input = parts.map((part) => Uint8Array.from(part)) as Parts;
        const inputKey = key.slice();
        const before = input.map((part) => part.slice());
        const randomPrefix = new Uint8Array(5).fill(0x68);
        const output = encode(input, inputKey, () => randomPrefix);
        expect(input).toEqual(before);
        expect(inputKey).toEqual(key);
        expect(randomPrefix).toEqual(new Uint8Array(5).fill(0x68));
        expect(hex(qqTeaDecrypt(output, key))).toBe(plaintextHex);
        expect(() =>
            encode(input, inputKey, () => {
                throw new Error('synthetic private failure');
            }),
        ).toThrow();
        expect(input).toEqual(before);
        expect(inputKey).toEqual(key);
    });

    it('rejects invalid keys, invalid callbacks and random outputs without disclosing exception text', () => {
        for (const length of [0, 15, 17, 32]) {
            const random = vi.fn(fixtureRandom);
            expect(() => encode(emptyParts(), new Uint8Array(length), random)).toThrow();
            expect(random).not.toHaveBeenCalled();
        }

        for (const source of [
            null,
            1,
            (n: number) => new Uint8Array(n - 1),
            (n: number) => new Uint8Array(n + 1),
            (n: number) => new Uint8Array(new SharedArrayBuffer(n)),
            (n: number) => new Uint16Array(n),
            () => {
                throw new Error('synthetic private failure');
            },
        ]) {
            let thrown: unknown;

            try {
                encode(emptyParts(), key, source as (size: number) => Uint8Array);
            } catch (error) {
                thrown = error;
            }

            expect(thrown).toBeInstanceOf(Error);
            expect(String(thrown)).not.toContain('synthetic private failure');
        }
    });

    it('rejects invalid byte views for every part and the key without running traps', () => {
        let traps = 0;

        const trap = () => {
            traps++;
            throw new Error('private');
        };

        const detached = Uint8Array.of(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const rab = new ArrayBuffer(8, { maxByteLength: 16 });
        const oob = new Uint8Array(rab, 4, 4);
        rab.resize(0);
        const prototype = Uint8Array.of(1);
        Object.setPrototypeOf(prototype, new Proxy(Uint8Array.prototype, { getPrototypeOf: trap }));
        const invalid: unknown[] = [
            null,
            {},
            new Uint16Array(1),
            detached,
            oob,
            prototype,
            new Uint8Array(new SharedArrayBuffer(16)),
            new Proxy(Uint8Array.of(1), { get: trap, getPrototypeOf: trap }),
        ];

        for (const bad of invalid) {
            for (let index = 0; index < 4; index++) {
                const input = emptyParts();
                input[index] = bad as Uint8Array;
                const random = vi.fn(fixtureRandom);
                expect(() => encode(input, key, random)).toThrow();
                expect(random).not.toHaveBeenCalled();
            }

            expect(() => encode(emptyParts(), bad as Uint8Array, fixtureRandom)).toThrow();
        }

        expect(traps).toBe(0);
    });

    it('rejects missing, extra, sparse, accessor and proxied part collections', () => {
        let traps = 0;

        const trap = () => {
            traps++;
            throw new Error('private');
        };

        const accessor = emptyParts();
        Object.defineProperty(accessor, '2', { get: trap });
        const sparse = emptyParts();
        delete (sparse as unknown as Array<Uint8Array | undefined>)[1];
        const invalid: unknown[] = [
            null,
            {},
            [],
            [new Uint8Array()],
            [...emptyParts(), new Uint8Array()],
            sparse,
            accessor,
            new Proxy(emptyParts(), { get: trap, getPrototypeOf: trap }),
        ];

        for (const input of invalid) {
            const random = vi.fn(fixtureRandom);
            expect(() => encode(input as Parts, key, random)).toThrow();
            expect(random).not.toHaveBeenCalled();
        }

        expect(traps).toBe(0);
    });

    it('rejects an oversized four-writer plaintext before randomness', () => {
        const random = vi.fn(fixtureRandom);
        const input = emptyParts();
        input[0] = new Uint8Array(16 * 1024 * 1024 - 2);
        input[3] = Uint8Array.of(1);
        expect(() => encode(input, key, random)).toThrow();
        expect(random).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        'clears private plaintext and key on success or late callback error: %s',
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
                        secret: Uint8Array,
                        random: (n: number) => Uint8Array,
                    ) => {
                        plaintext = plain;
                        privateKey = secret;
                        return actual.qqTeaEncrypt(plain, secret, random);
                    },
                };
            });
            const input = parts.map((part) => Uint8Array.from(part)) as Parts;
            const inputKey = key.slice();
            let result: Uint8Array | undefined;

            try {
                const isolated =
                    await import('../../src/direct/target-wt-inner-encrypted-candidate');

                if (fail) {
                    expect(() =>
                        isolated.encodeTargetWtInnerEncryptedCandidate(input, inputKey, () => {
                            throw new Error('synthetic private failure');
                        }),
                    ).toThrow();
                } else {
                    result = isolated.encodeTargetWtInnerEncryptedCandidate(
                        input,
                        inputKey,
                        fixtureRandom,
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
            expect(input.map(hex)).toEqual(parts.map(hex));
            expect(inputKey).toEqual(key);

            if (result) {
                expect(hex(result)).toBe(ciphertextHex);
            }
        },
    );
});
