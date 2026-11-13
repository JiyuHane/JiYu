import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
    encodeTargetWtLoginNode016a,
    encodeTargetWtLoginNode0318,
} from '../../src/direct/target-wt-login-node';

const failure = 'target WT login node encoding failed';
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const nodes = [
    ['016a', encodeTargetWtLoginNode016a],
    ['0318', encodeTargetWtLoginNode0318],
] as const;

describe('standalone target-static WT login node writers', () => {
    it.each(nodes)(
        '%s encodes hand-assembled empty and binary vectors with no nested length',
        (tag, encode) => {
            expect(hex(encode(new Uint8Array()))).toBe(tag + '0000');
            expect(hex(encode(Uint8Array.of(0, 0xff, 0x80, 0x41, 0)))).toBe(tag + '000500ff804100');
        },
    );

    it.each(nodes)(
        '%s accepts 65535 raw bytes and rejects 65536 without truncating',
        (tag, encode) => {
            const input = new Uint8Array(65535);
            input[0] = 0x81;
            input[input.length - 1] = 0xfe;
            const output = encode(input);
            expect(output.length).toBe(65539);
            expect(hex(output.subarray(0, 5))).toBe(tag + 'ffff81');
            expect(output.at(-1)).toBe(0xfe);
            expect(input[0]).toBe(0x81);
            expect(() => encode(new Uint8Array(65536))).toThrow(failure);
        },
    );

    it.each(nodes)('%s copies deterministic binary inputs without aliasing', (tag, encode) => {
        for (const size of [1, 7, 8, 31, 256, 1023]) {
            const data = Uint8Array.from({ length: size }, (_, i) => (i * 73 + 91) & 0xff);
            const before = data.slice();
            const output = encode(data);
            expect(hex(output.subarray(0, 2))).toBe(tag);
            expect(
                new DataView(output.buffer, output.byteOffset, output.byteLength).getUint16(2),
            ).toBe(size);
            expect(output.subarray(4)).toEqual(before);
            expect(data).toEqual(before);
            data.fill(0);
            expect(output.subarray(4)).toEqual(before);
            output.fill(0);
            expect(data.every((byte) => byte === 0)).toBe(true);
        }
    });

    it.each(nodes)(
        '%s accepts Buffer and foreign slices while ignoring shadow getters',
        (_tag, encode) => {
            const foreign = runInNewContext(
                'new Uint8Array([9,0,255,128,8]).subarray(1,4)',
            ) as Uint8Array;
            const source = Buffer.from([9, 0, 255, 128, 8]);
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
                        throw new Error('SECRET');
                    },
                });
            }

            expect(hex(encode(foreign)).slice(4)).toBe('000300ff80');
            expect(hex(encode(source.subarray(1, 4))).slice(4)).toBe('000300ff80');
            expect(source).toEqual(Buffer.from([9, 0, 255, 128, 8]));
            expect(calls).toBe(0);
        },
    );

    it.each(nodes)(
        '%s rejects proxies, unsafe buffers and non-U8 without traps',
        (_tag, encode) => {
            let calls = 0;

            const trap = () => {
                calls++;
                throw new Error('SECRET');
            };

            const detached = Uint8Array.of(1);
            structuredClone(detached.buffer, { transfer: [detached.buffer] });
            const rab = new ArrayBuffer(8, { maxByteLength: 16 });
            const outOfBounds = new Uint8Array(rab, 4, 4);
            rab.resize(0);
            const proto = Uint8Array.of(1);
            Object.setPrototypeOf(proto, new Proxy(Uint8Array.prototype, { getPrototypeOf: trap }));
            const revoked = Proxy.revocable(Uint8Array.of(1), {});
            revoked.revoke();
            const invalid = [
                null,
                {},
                new Uint16Array(1),
                new Uint8ClampedArray(1),
                new DataView(new ArrayBuffer(1)),
                detached,
                outOfBounds,
                proto,
                revoked.proxy,
                new Proxy(Uint8Array.of(1), { get: trap, getPrototypeOf: trap }),
                new Uint8Array(new SharedArrayBuffer(1)),
                runInNewContext('new Uint8Array(new SharedArrayBuffer(1))'),
            ];

            for (const value of invalid) {
                expect(() => encode(value as Uint8Array)).toThrow(failure);
            }

            expect(calls).toBe(0);
        },
    );

    it('uses its snapshot even when source changes after the snapshot copy', async () => {
        const input = Uint8Array.of(0x80, 0xff, 1);
        const originalSet = Uint8Array.prototype.set;
        let count = 0;
        vi.resetModules();
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            value: ArrayLike<number>,
            at?: number,
        ) {
            originalSet.call(this, value, at);

            if (++count === 1) {
                input.fill(0);
            }
        });
        let output: Uint8Array;

        try {
            const module = await import('../../src/direct/target-wt-login-node');
            output = module.encodeTargetWtLoginNode016a(input);
        } finally {
            spy.mockRestore();
        }

        expect(hex(output)).toBe('016a000380ff01');
    });

    it.each([1, 2])(
        'clears owned allocations on copy %i failure with sanitized error',
        async (failAt) => {
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
                    throw new Error('SECRET');
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
                expect(() => module.encodeTargetWtLoginNode0318(input)).toThrow(failure);
            } finally {
                setSpy.mockRestore();
                fillSpy.mockRestore();
            }

            expect(copies).toHaveLength(failAt);
            expect(wipes).toHaveLength(failAt);
            expect(copies.every((copy) => copy.every((byte) => byte === 0))).toBe(true);
            expect(input).toEqual(Uint8Array.of(0x81, 0x82, 0x83));
        },
    );

    it('attempts to wipe failed output even when private snapshot wiping throws', async () => {
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
                throw new Error('SECRET');
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
                throw new Error('SECRET');
            }

            return originalFill.call(this, byte, start, end);
        });

        try {
            const module = await import('../../src/direct/target-wt-login-node');
            expect(() => module.encodeTargetWtLoginNode016a(input)).toThrow(failure);
        } finally {
            setSpy.mockRestore();
            fillSpy.mockRestore();
        }

        expect(wipes).toHaveLength(2);
        expect(wipes[1]).toBe(copies[1]);
        expect(copies[1].every((byte) => byte === 0)).toBe(true);
        expect(input).toEqual(Uint8Array.of(1, 2, 3));
    });
});
