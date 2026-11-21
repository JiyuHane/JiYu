import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { encodeTargetWtInnerEncryptedCandidate } from '../../src/direct/target-wt-inner-encrypted-candidate';
import { encodeTargetWtLoginNode0144 as encode } from '../../src/direct/target-wt-login-node';

const failure = 'target WT login node encoding failed';
const bytes = (hex: string) => Buffer.from(hex, 'hex');
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');

// Independent synthetic ciphertext oracle from the existing inner-candidate tests.
// Static evidence concerns normal success only; the size limit is local policy.
const ciphertext =
    '955abf5506096bacac66692532a868cf9a458f0e4e1550f29969d3780269e28c' +
    '901f9640f813df993361ec495f4aecbbd7fd0ce9b7c5b05dd6bc3d261f9a2abb' +
    '06b497ce0a6cf78a';

describe('standalone target WT login 0144 node writer', () => {
    it('matches independent empty and binary templates without a nested length', () => {
        expect(hex(encode(new Uint8Array()))).toBe('01440000');
        expect(hex(encode(Uint8Array.of(0, 0xff, 0x80, 0x41, 0)))).toBe('0144000500ff804100');
        expect(hex(encode(bytes(ciphertext)))).toBe('01440048' + ciphertext);
    });

    it('composes the existing synthetic encrypted candidate as opaque value', () => {
        const parts = [
            bytes('016e000144'),
            bytes('0147000b112233440001760002ccdd'),
            bytes('0128001200000000000000000000014c0002aabb0000'),
            bytes('0124000c000102030405060708090a0b'),
        ] as const;
        const key = Uint8Array.from({ length: 16 }, (_, i) => i);
        const random = vi.fn((size: number) => {
            const value = new Uint8Array(size);
            value[0] = 0xf8;
            return value;
        });
        const encrypted = encodeTargetWtInnerEncryptedCandidate(parts, key, random);
        expect(hex(encrypted)).toBe(ciphertext);
        const node = encode(encrypted);
        expect(hex(node)).toBe('01440048' + ciphertext);
        expect(random).toHaveBeenCalledOnce();
        expect(random).toHaveBeenCalledWith(5);
        encrypted.fill(0);
        expect(hex(node)).toBe('01440048' + ciphertext);
    });

    it('accepts 65535 bytes and rejects 65536 as local policy', () => {
        const input = Uint8Array.from({ length: 65535 }, (_, i) => (i * 73 + 91) & 255);
        const before = input.slice();
        const output = encode(input);
        expect(output.length).toBe(65539);
        expect(hex(output.subarray(0, 4))).toBe('0144ffff');
        expect(output.subarray(4)).toEqual(before);
        expect(input).toEqual(before);
        expect(() => encode(new Uint8Array(65536))).toThrowError(new Error(failure));
    });

    it('accepts subviews, Buffer and foreign views and keeps storage independent', () => {
        const source = Buffer.from([9, 0, 255, 128, 8]);
        const foreign = runInNewContext(
            'new Uint8Array([9,0,255,128,8]).subarray(1,4)',
        ) as Uint8Array;
        let calls = 0;

        for (const name of [
            'length',
            'byteLength',
            'byteOffset',
            'buffer',
            'set',
            'fill',
            Symbol.iterator,
            Symbol.toStringTag,
        ]) {
            Object.defineProperty(foreign, name, {
                get() {
                    calls++;
                    throw new Error('private getter');
                },
            });
        }

        const first = encode(source.subarray(1, 4));
        const second = encode(foreign);
        expect(hex(first)).toBe('0144000300ff80');
        expect(hex(second)).toBe('0144000300ff80');
        expect(calls).toBe(0);
        expect(source).toEqual(Buffer.from([9, 0, 255, 128, 8]));
        source.fill(0xaa);
        expect(hex(first)).toBe('0144000300ff80');
        first.fill(0);
        expect(source).toEqual(Buffer.alloc(5, 0xaa));
        expect(hex(second)).toBe('0144000300ff80');
    });

    it('rejects invalid, proxy, shared, detached and out-of-bounds views with a fixed error', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('private trap');
        };

        const detached = Uint8Array.of(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const backing = new ArrayBuffer(8, { maxByteLength: 16 });
        const outOfBounds = new Uint8Array(backing, 4, 4);
        backing.resize(0);
        const prototype = Uint8Array.of(1);
        Object.setPrototypeOf(prototype, new Proxy(Uint8Array.prototype, { getPrototypeOf: trap }));
        const revoked = Proxy.revocable(Uint8Array.of(1), {});
        revoked.revoke();

        for (const value of [
            null,
            {},
            new Uint16Array(1),
            new Uint8ClampedArray(1),
            new DataView(new ArrayBuffer(1)),
            detached,
            outOfBounds,
            prototype,
            revoked.proxy,
            new Proxy(Uint8Array.of(1), { get: trap, getPrototypeOf: trap }),
            new Uint8Array(new SharedArrayBuffer(1)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(1))'),
        ]) {
            expect(() => encode(value as Uint8Array)).toThrowError(new Error(failure));
        }

        expect(calls).toBe(0);
    });

    it('uses a snapshot and clears it after successful encoding', async () => {
        const input = Uint8Array.of(0x80, 0xff, 1);
        const originalSet = Uint8Array.prototype.set;
        const originalFill = Uint8Array.prototype.fill;
        const copies: Uint8Array[] = [];
        const wipes: Uint8Array[] = [];
        vi.resetModules();
        const setSpy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            value: ArrayLike<number>,
            at?: number,
        ) {
            copies.push(this);
            originalSet.call(this, value, at);

            if (copies.length === 1) {
                originalFill.call(input, 0);
            }
        });
        const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            byte: number,
            start?: number,
            end?: number,
        ) {
            wipes.push(this);
            return originalFill.call(this, byte, start, end);
        });
        let output: Uint8Array;

        try {
            const module = await import('../../src/direct/target-wt-login-node');
            output = module.encodeTargetWtLoginNode0144(input);
        } finally {
            setSpy.mockRestore();
            fillSpy.mockRestore();
        }

        expect(hex(output)).toBe('0144000380ff01');
        expect(copies).toHaveLength(2);
        expect(wipes).toEqual([copies[0]]);
        expect(copies[0]).toEqual(new Uint8Array(3));
        expect(wipes).not.toContain(output);
    });

    it.each([1, 2])('clears owned allocations on copy %i failure', async (failAt) => {
        const input = Uint8Array.of(0x81, 0x82, 0x83);
        const originalSet = Uint8Array.prototype.set;
        const originalFill = Uint8Array.prototype.fill;
        const copies: Uint8Array[] = [];
        const wipes: Uint8Array[] = [];
        vi.resetModules();
        const setSpy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            value: ArrayLike<number>,
            at?: number,
        ) {
            copies.push(this);
            originalSet.call(this, value, at);

            if (copies.length === failAt) {
                throw new Error('private copy failure');
            }
        });
        const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            byte: number,
            start?: number,
            end?: number,
        ) {
            wipes.push(this);
            return originalFill.call(this, byte, start, end);
        });

        try {
            const module = await import('../../src/direct/target-wt-login-node');
            expect(() => module.encodeTargetWtLoginNode0144(input)).toThrowError(
                new Error(failure),
            );
        } finally {
            setSpy.mockRestore();
            fillSpy.mockRestore();
        }

        expect(copies).toHaveLength(failAt);
        expect(wipes).toEqual(copies);
        expect(copies.every((copy) => copy.every((byte) => byte === 0))).toBe(true);
        expect(input).toEqual(Uint8Array.of(0x81, 0x82, 0x83));
    });

    it('attempts to clear the output even if snapshot cleanup throws', async () => {
        const input = Uint8Array.of(1, 2, 3);
        const originalSet = Uint8Array.prototype.set;
        const originalFill = Uint8Array.prototype.fill;
        const copies: Uint8Array[] = [];
        const wipes: Uint8Array[] = [];
        vi.resetModules();
        const setSpy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            value: ArrayLike<number>,
            at?: number,
        ) {
            copies.push(this);
            originalSet.call(this, value, at);

            if (copies.length === 2) {
                throw new Error('private copy failure');
            }
        });
        const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            byte: number,
            start?: number,
            end?: number,
        ) {
            wipes.push(this);

            if (wipes.length === 1) {
                throw new Error('private cleanup failure');
            }

            return originalFill.call(this, byte, start, end);
        });

        try {
            const module = await import('../../src/direct/target-wt-login-node');
            expect(() => module.encodeTargetWtLoginNode0144(input)).toThrowError(
                new Error(failure),
            );
        } finally {
            setSpy.mockRestore();
            fillSpy.mockRestore();
        }

        expect(wipes).toHaveLength(2);
        expect(wipes[0]).toBe(copies[0]);
        expect(wipes[1]).toBe(copies[1]);
        expect(copies[1].every((byte) => byte === 0)).toBe(true);
        expect(input).toEqual(Uint8Array.of(1, 2, 3));
    });
});
