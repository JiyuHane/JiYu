import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { encodeTargetWtLoginNode0106 as encode } from '../../src/direct/target-wt-login-node';

const failure = 'target WT login node encoding failed';
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');

// These are synthetic byte vectors, not account data or observed target output.
describe('standalone target WT login 0106 node writer', () => {
    it('encodes empty and opaque non-UTF8 bytes with no nested length', () => {
        expect(hex(encode(new Uint8Array()))).toBe('01060000');
        expect(hex(encode(Uint8Array.of(0, 0xff, 0x80, 0x41, 0)))).toBe('0106000500ff804100');
        expect(hex(encode(Uint8Array.of(0xc0, 0xaf, 0xed, 0xa0, 0x80)))).toBe('01060005c0afeda080');
    });

    it('encodes lengths in big-endian and copies deterministic byte vectors', () => {
        for (const size of [1, 255, 256, 257, 1023]) {
            const input = Uint8Array.from({ length: size }, (_, i) => (i * 73 + 91) & 255);
            const before = input.slice();
            const output = encode(input);
            expect(output.length).toBe(size + 4);
            expect(Array.from(output.subarray(0, 4))).toEqual([
                0x01,
                0x06,
                Math.floor(size / 256),
                size % 256,
            ]);
            expect(output.subarray(4)).toEqual(before);
            expect(input).toEqual(before);
        }
    });

    it('accepts 65535 bytes and rejects 65536 under local policy', () => {
        const input = Uint8Array.from({ length: 65535 }, (_, i) => (i * 73 + 91) & 255);
        const before = input.slice();
        const output = encode(input);
        expect(output.length).toBe(65539);
        expect(hex(output.subarray(0, 4))).toBe('0106ffff');
        expect(output.subarray(4)).toEqual(before);
        expect(input).toEqual(before);
        expect(() => encode(new Uint8Array(65536))).toThrowError(new Error(failure));
    });

    it('accepts subviews, Buffer and foreign views without consulting shadow getters', () => {
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
        expect(hex(first)).toBe('0106000300ff80');
        expect(hex(second)).toBe('0106000300ff80');
        expect(calls).toBe(0);
        expect(source).toEqual(Buffer.from([9, 0, 255, 128, 8]));
        source.fill(0xaa);
        expect(hex(first)).toBe('0106000300ff80');
        first.fill(0);
        expect(source).toEqual(Buffer.alloc(5, 0xaa));
        expect(hex(second)).toBe('0106000300ff80');
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

    it('uses and clears a private snapshot even if the source changes after copying', async () => {
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
            output = module.encodeTargetWtLoginNode0106(input);
        } finally {
            setSpy.mockRestore();
            fillSpy.mockRestore();
        }

        expect(hex(output)).toBe('0106000380ff01');
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
            expect(() => module.encodeTargetWtLoginNode0106(input)).toThrowError(
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

    it('attempts to clear failed output even if snapshot cleanup throws', async () => {
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
            expect(() => module.encodeTargetWtLoginNode0106(input)).toThrowError(
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
