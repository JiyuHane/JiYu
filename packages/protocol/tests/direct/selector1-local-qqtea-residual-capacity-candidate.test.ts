import { describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import {
    decodeSelector1LocalQqTeaResidualCapacityCandidate as decode,
    MAX_SELECTOR1_LOCAL_CANDIDATE_BYTES,
} from '../../src/direct/selector1-local-qqtea-residual-capacity-candidate';

const secondaryKey = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const random = (size: number) => new Uint8Array(size).fill(0x51);
const failure = 'selector 1 local candidate decoding failed';

// Fixed synthetic keys found with the real local QQ-TEA framing calculation;
// no target runtime, account or duplicated cipher implementation is involved.
// For this ciphertext the observed primary statuses are early, or late with
// nextCapacity 4/3/2/0 respectively. All keys are test-only.
const primaryIndices = { early: 20, late4: 0, late3: 2, late2: 5, late0: 1 } as const;

function fixture(size: 0 | 3, kind: keyof typeof primaryIndices | 'empty-early') {
    const plain = Uint8Array.from({ length: size }, (_, i) => i + 1);
    const ciphertext = qqTeaEncrypt(plain, secondaryKey, random);
    const primaryKey = new Uint8Array(16);
    new DataView(primaryKey.buffer).setUint32(0, kind === 'empty-early' ? 9 : primaryIndices[kind]);
    return { plain, ciphertext, primaryKey, secondaryKey: Uint8Array.from(secondaryKey) };
}

describe('selector 1 local residual-capacity candidate', () => {
    it.each([
        ['early', true],
        ['late4', true],
        ['late3', true],
        ['late2', false],
        ['late0', false],
    ] as const)('uses real framing fixture %s with bounded second result', (kind, success) => {
        const input = fixture(3, kind);
        const before = [
            input.primaryKey.slice(),
            input.secondaryKey.slice(),
            input.ciphertext.slice(),
        ];
        expect(() => qqTeaDecrypt(input.ciphertext, input.primaryKey)).toThrow(
            'invalid QQ-TEA ciphertext',
        );
        const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');

        try {
            if (success) {
                const result = decode(input);
                expect(result).toEqual({ kind: 'plaintext-candidate', data: input.plain });
                input.ciphertext.fill(0);
                expect(result.data).toEqual(input.plain);
            } else {
                expect(() => decode(input)).toThrow(failure);
                expect(input.ciphertext).toEqual(before[2]);
            }

            expect(
                descriptor.mock.calls.filter(
                    ([object, key]) => object === input && key === 'secondaryKey',
                ),
            ).toHaveLength(1);
        } finally {
            descriptor.mockRestore();
        }

        expect(input.primaryKey).toEqual(before[0]);
        expect(input.secondaryKey).toEqual(before[1]);
    });

    it.each([0, 3])(
        'does not inspect a secondary descriptor after primary plaintext length %i',
        (size) => {
            const plain = new Uint8Array(size).fill(7);
            const input = {
                primaryKey: secondaryKey,
                ciphertext: qqTeaEncrypt(plain, secondaryKey, random),
            };
            Object.defineProperty(input, 'secondaryKey', {
                get() {
                    throw new Error('must not read');
                },
            });
            const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');

            try {
                if (size === 0) {
                    expect(() => decode(input)).toThrow(failure);
                } else {
                    expect(decode(input)).toEqual({ kind: 'plaintext-candidate', data: plain });
                }

                expect(
                    descriptor.mock.calls.some(
                        ([object, key]) => object === input && key === 'secondaryKey',
                    ),
                ).toBe(false);
            } finally {
                descriptor.mockRestore();
            }
        },
    );

    it.each([24, 25, 26, 27, 28, 29, 30, 31])(
        'matches legacy multi-block decryption across padding at length %i',
        (size) => {
            const plain = Uint8Array.from({ length: size }, (_, index) => index + 1);
            const input = {
                primaryKey: Uint8Array.from(secondaryKey),
                secondaryKey: new Uint8Array(16).fill(0xa7),
                ciphertext: qqTeaEncrypt(plain, secondaryKey, random),
            };
            const beforeKey = input.primaryKey.slice();
            const beforeSecondary = input.secondaryKey.slice();
            const beforeCipher = input.ciphertext.slice();
            expect(input.ciphertext.length).toBeGreaterThan(16);
            const legacy = qqTeaDecrypt(input.ciphertext, input.primaryKey);
            const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');

            try {
                expect(decode(input)).toEqual({ kind: 'plaintext-candidate', data: legacy });
                expect(legacy).toEqual(plain);
                expect(
                    descriptor.mock.calls.some(
                        ([object, name]) => object === input && name === 'secondaryKey',
                    ),
                ).toBe(false);
            } finally {
                descriptor.mockRestore();
            }

            expect(input.primaryKey).toEqual(beforeKey);
            expect(input.secondaryKey).toEqual(beforeSecondary);
            expect(input.ciphertext).toEqual(beforeCipher);
        },
    );

    it('matches the independent MiraiGo 64-byte vector in the local candidate path', () => {
        // MiraiGo binary/tea.go at 2b2be6693df1219d867300c6f6cd0f804c59d620;
        // the same synthetic oracle vector is used by qq-tea.test.ts.
        const primaryKey = Uint8Array.from({ length: 16 }, (_, index) => index);
        const ciphertext = Uint8Array.from(
            Buffer.from(
                '1ac2675390c20356d73df63bea4384c7157f15dd9c5fb85036eaef697a32c2bc' +
                    'd68ada31632ead93b8bb268cfdbb51ac85a25a5195ca37ff4d450d2c6d1ee658' +
                    '901efe4ca6e4f5f6d2e1d8a5a87387be',
                'hex',
            ),
        );
        const input = { primaryKey, ciphertext, secondaryKey: new Uint8Array(16) };
        const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');

        try {
            expect(decode(input)).toEqual({
                kind: 'plaintext-candidate',
                data: Uint8Array.from({ length: 64 }, (_, index) => index),
            });
            expect(
                descriptor.mock.calls.some(
                    ([object, name]) => object === input && name === 'secondaryKey',
                ),
            ).toBe(false);
        } finally {
            descriptor.mockRestore();
        }
    });

    it('decodes a multi-block secondary candidate and keeps all inputs unchanged', () => {
        const plain = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
        const input = {
            primaryKey: new Uint8Array(16),
            secondaryKey: Uint8Array.from(secondaryKey),
            ciphertext: qqTeaEncrypt(plain, secondaryKey, random),
        };
        const beforePrimary = input.primaryKey.slice();
        const beforeSecondary = input.secondaryKey.slice();
        const beforeCipher = input.ciphertext.slice();
        expect(input.ciphertext.length).toBeGreaterThan(16);
        expect(() => qqTeaDecrypt(input.ciphertext, input.primaryKey)).toThrow(
            'invalid QQ-TEA ciphertext',
        );
        const legacy = qqTeaDecrypt(input.ciphertext, input.secondaryKey);
        const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');

        try {
            expect(decode(input)).toEqual({ kind: 'plaintext-candidate', data: legacy });
            expect(legacy).toEqual(plain);
            expect(
                descriptor.mock.calls.filter(
                    ([object, name]) => object === input && name === 'secondaryKey',
                ),
            ).toHaveLength(1);
        } finally {
            descriptor.mockRestore();
        }

        expect(input.primaryKey).toEqual(beforePrimary);
        expect(input.secondaryKey).toEqual(beforeSecondary);
        expect(input.ciphertext).toEqual(beforeCipher);
    });

    it('rejects a secondary empty plaintext and an identical failing key with the same failure', () => {
        const empty = fixture(0, 'empty-early');
        expect(() => decode(empty)).toThrow(failure);
        const f = fixture(3, 'late3');
        f.secondaryKey = Uint8Array.from(f.primaryKey);
        expect(() => decode(f)).toThrow(failure);
    });

    it('requires an own secondary data descriptor and never runs its accessor', () => {
        const f = fixture(3, 'early');
        let getterCalls = 0;
        Object.defineProperty(f, 'secondaryKey', {
            get() {
                getterCalls++;
                return secondaryKey;
            },
        });
        expect(() => decode(f)).toThrow(failure);
        expect(getterCalls).toBe(0);
        const absent = { primaryKey: f.primaryKey, ciphertext: f.ciphertext };
        expect(() => decode(absent)).toThrow(failure);
        Object.setPrototypeOf(absent, { secondaryKey });
        expect(() => decode(absent)).toThrow(failure);
    });

    it('propagates primitive implementation exceptions without consulting secondary', () => {
        const input = fixture(3, 'early');
        const failure = new RangeError('synthetic primitive failure');
        const original = DataView.prototype.getUint32;
        let reads = 0;
        const view = vi.spyOn(DataView.prototype, 'getUint32').mockImplementation(function (
            this: DataView,
            byteOffset: number,
            littleEndian?: boolean,
        ) {
            reads++;

            if (reads === 5) {
                throw failure;
            }

            return original.call(this, byteOffset, littleEndian);
        });
        const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');

        try {
            let caught: unknown;

            try {
                decode(input);
            } catch (error) {
                caught = error;
            }

            expect(caught).toBe(failure);
            expect(
                descriptor.mock.calls.some(
                    ([object, key]) => object === input && key === 'secondaryKey',
                ),
            ).toBe(false);
        } finally {
            view.mockRestore();
            descriptor.mockRestore();
        }
    });

    it('rejects invalid keys, shared, proxy, detached, accessors and oversize inputs', () => {
        const f = fixture(3, 'early');
        const detached = new Uint8Array(16);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const invalid = [
            null,
            new Uint8Array(15),
            new Uint8Array(17),
            new Uint8Array(new SharedArrayBuffer(16)),
            new Proxy(new Uint8Array(16), {}),
            detached,
            new Uint16Array(16),
        ];

        for (const key of invalid) {
            expect(() => decode({ ...f, primaryKey: key as never })).toThrow();
            expect(() => decode({ ...f, secondaryKey: key as never })).toThrow();
        }

        expect(() => decode(new Proxy(f, {}) as never)).toThrow();
        expect(() =>
            decode({ ...f, ciphertext: new Uint8Array(MAX_SELECTOR1_LOCAL_CANDIDATE_BYTES + 8) }),
        ).toThrow();
        expect(() => decode({ ...f, ciphertext: new Uint8Array(17) })).toThrow();
        const input = { ...f };
        Object.defineProperty(input, 'primaryKey', {
            get() {
                throw new Error('must not run');
            },
        });
        expect(() => decode(input)).toThrow(failure);
    });

    it.each([false, true])(
        'attempts independent snapshot cleanup after copy failure, cleanupThrows=%s',
        async (cleanupThrows) => {
            const input = fixture(3, 'early');
            const realSet = Uint8Array.prototype.set;
            const copies: Uint8Array[] = [];
            vi.resetModules();
            const realFill = Uint8Array.prototype.fill;
            let fills = 0;
            const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
                this: Uint8Array,
                value: number,
                start?: number,
                end?: number,
            ) {
                fills++;

                if (cleanupThrows && fills === 1) {
                    throw new Error('synthetic cleanup failure');
                }

                return realFill.call(this, value, start, end);
            });
            const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
                this: Uint8Array,
                source: ArrayLike<number>,
                offset?: number,
            ) {
                copies.push(this);
                realSet.call(this, source, offset);

                if (copies.length === 2) {
                    throw new Error('synthetic copy failure');
                }
            });

            try {
                const module =
                    await import('../../src/direct/selector1-local-qqtea-residual-capacity-candidate');
                expect(() =>
                    module.decodeSelector1LocalQqTeaResidualCapacityCandidate(input),
                ).toThrow('synthetic copy failure');
            } finally {
                spy.mockRestore();
                fillSpy.mockRestore();
            }

            expect(copies).toHaveLength(2);
            expect(fills).toBe(2);
            expect(copies[0].every((byte) => byte === 0)).toBe(true);
            expect(copies[1].every((byte) => byte === 0)).toBe(!cleanupThrows);
        },
    );
});
