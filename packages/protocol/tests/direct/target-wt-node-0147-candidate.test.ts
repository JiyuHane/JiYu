import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { encodeTargetWtLoginNode0147 as encode } from '../../src/direct/target-wt-node-0147-candidate';

type Input = Parameters<typeof encode>[0];
type ByteField = 'first' | 'second';
const byteFields: ByteField[] = ['first', 'second'];
const empty = (): Input => ({ word: 0, first: new Uint8Array(), second: new Uint8Array() });
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const failure = 'target WT login node encoding failed';

// Hand-assembled synthetic fixtures; fields are opaque bytes, not text.
describe('offline target WT login node 0147 candidate', () => {
    it('writes empty and asymmetric binary vectors in big-endian', () => {
        expect(hex(encode(empty()))).toBe('014700080000000000000000');
        expect(
            hex(
                encode({
                    word: 0x12345678,
                    first: Uint8Array.of(0x00, 0xff, 0x80),
                    second: Uint8Array.of(0xc0, 0xaf),
                }),
            ),
        ).toBe('0147000d12345678000300ff800002c0af');
        expect(hex(encode({ ...empty(), word: 0xffffffff, second: Uint8Array.of(0xfe) }))).toBe(
            '01470009ffffffff00000001fe',
        );
    });

    it('clamps each field separately at 32 raw bytes', () => {
        const prefix = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
        const full32 = Uint8Array.from({ length: 32 }, (_, i) => i);
        const full33 = Uint8Array.from({ length: 33 }, (_, i) => i);
        expect(hex(encode({ word: 0x01020304, first: full32, second: new Uint8Array() }))).toBe(
            `01470028010203040020${prefix}0000`,
        );
        expect(hex(encode({ word: 0x01020304, first: new Uint8Array(), second: full33 }))).toBe(
            `014700280102030400000020${prefix}`,
        );
        expect(hex(encode({ word: 0xffffffff, first: full33, second: full32 }))).toBe(
            `01470048ffffffff0020${prefix}0020${prefix}`,
        );
    });

    it('clamps very long inputs and preserves invalid or split UTF-8 bytes', () => {
        const first = new Uint8Array(1024 * 1024).fill(0x77);
        const second = new Uint8Array(65536).fill(0x88);
        first.set(Uint8Array.from({ length: 32 }, (_, i) => i));
        second.set(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));
        expect(hex(encode({ word: 0x80000000, first, second }))).toBe(
            '01470048800000000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' +
                '0020fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0efeeedecebeae9e8e7e6e5e4e3e2e1e0',
        );
        const split = Uint8Array.from([...new Uint8Array(30).fill(0x80), 0xf0, 0x9f, 0x92, 0xa9]);
        expect(hex(encode({ ...empty(), first: split }))).toBe(
            `01470028000000000020${'80'.repeat(30)}f09f0000`,
        );
    });

    it('accepts all u32 endpoints and rejects invalid words without coercion', () => {
        for (const [word, expected] of [
            [0, '00000000'],
            [0x7fffffff, '7fffffff'],
            [0x80000000, '80000000'],
            [0xffffffff, 'ffffffff'],
        ] as const) {
            expect(hex(encode({ ...empty(), word }))).toBe(`01470008${expected}00000000`);
        }

        let calls = 0;
        const coercible = {
            valueOf() {
                calls++;
                return 1;
            },
        };

        for (const word of [
            -1,
            0x100000000,
            0.5,
            NaN,
            Infinity,
            -Infinity,
            '1',
            1n,
            null,
            undefined,
            coercible,
        ]) {
            expect(() => encode({ ...empty(), word } as Input)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it('copies selected subviews and keeps inputs and output independent', () => {
        const backing = Buffer.from([0x77, 0x00, 0xff, 0x80, 0x66]);
        const foreign = runInNewContext(
            'new Uint8Array([9, 0xc0, 0xaf, 8]).subarray(1, 3)',
        ) as Uint8Array;
        const input: Input = { word: 0x01020304, first: backing.subarray(1, 4), second: foreign };
        const output = encode(input);
        const expected = '0147000d01020304000300ff800002c0af';
        expect(hex(output)).toBe(expected);
        expect(backing).toEqual(Buffer.from([0x77, 0x00, 0xff, 0x80, 0x66]));
        expect(output.buffer).not.toBe(backing.buffer);
        expect(output.buffer).not.toBe(foreign.buffer);
        backing.fill(0x55);
        foreign.fill(0x44);
        expect(hex(output)).toBe(expected);
        output.fill(0xaa);
        expect(backing).toEqual(Buffer.alloc(5, 0x55));
        expect(Array.from(foreign)).toEqual([0x44, 0x44]);
    });

    it('rejects invalid, proxy, shared, detached and out-of-bounds byte fields without traps', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('synthetic trap');
        };

        const detached = Uint8Array.of(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const resizable = new ArrayBuffer(8, { maxByteLength: 16 });
        const outOfBounds = new Uint8Array(resizable, 4, 4);
        resizable.resize(0);
        const proxyPrototype = Uint8Array.of(1);
        Object.setPrototypeOf(
            proxyPrototype,
            new Proxy(Uint8Array.prototype, { getPrototypeOf: trap }),
        );
        const revoked = Proxy.revocable(Uint8Array.of(1), {});
        revoked.revoke();
        const invalid: unknown[] = [
            null,
            undefined,
            'abc',
            [1],
            {},
            new Uint16Array(1),
            new Uint8ClampedArray(1),
            new DataView(new ArrayBuffer(1)),
            detached,
            outOfBounds,
            proxyPrototype,
            revoked.proxy,
            new Proxy(Uint8Array.of(1), { get: trap, getPrototypeOf: trap }),
            new Uint8Array(new SharedArrayBuffer(1)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(1))'),
        ];

        for (const field of byteFields) {
            for (const value of invalid) {
                expect(() => encode({ ...empty(), [field]: value } as Input)).toThrow(failure);
            }
        }

        expect(calls).toBe(0);
    });

    it('rejects proxy records and accessor fields without executing traps', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('synthetic trap');
        };

        const revoked = Proxy.revocable(empty(), {});
        revoked.revoke();
        expect(() =>
            encode(
                new Proxy(empty(), {
                    get: trap,
                    getPrototypeOf: trap,
                    getOwnPropertyDescriptor: trap,
                    ownKeys: trap,
                }),
            ),
        ).toThrow(failure);
        expect(() => encode(revoked.proxy)).toThrow(failure);

        for (const field of [...byteFields, 'word'] as const) {
            const input = empty();
            Object.defineProperty(input, field, { get: trap, set: trap, enumerable: true });
            expect(() => encode(input)).toThrow(failure);
            const setterOnly = empty();
            Object.defineProperty(setterOnly, field, { set: trap, enumerable: true });
            expect(() => encode(setterOnly)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it('reads genuine byte views without invoking shadow getters', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('synthetic accessor');
        };

        const view = Uint8Array.of(0x00, 0xff, 0x80);

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
            Object.defineProperty(view, name, { get: trap, set: trap });
        }

        expect(hex(encode({ ...empty(), first: view }))).toBe('0147000b00000000000300ff800000');
        expect(calls).toBe(0);
    });

    it.each([1, 2, 3, 4])('clears owned buffers after copy operation %i fails', async (failAt) => {
        vi.resetModules();
        const original = Uint8Array.prototype.set;
        const destinations: Uint8Array[] = [];
        const input: Input = {
            word: 0x12345678,
            first: Uint8Array.of(1),
            second: Uint8Array.of(2),
        };
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            offset,
        ) {
            destinations.push(this);
            original.call(this, source, offset);

            if (destinations.length === failAt) {
                throw new Error('synthetic private failure');
            }
        });

        try {
            const isolated = await import('../../src/direct/target-wt-node-0147-candidate');
            expect(() => isolated.encodeTargetWtLoginNode0147(input)).toThrow(failure);
        } finally {
            spy.mockRestore();
            vi.resetModules();
        }

        expect(destinations).toHaveLength(failAt);
        expect(destinations.every((value) => value.every((byte) => byte === 0))).toBe(true);
        expect(byteFields.map((field) => input[field][0])).toEqual([1, 2]);
    });

    it('attempts both snapshot wipes even when one cleanup throws', async () => {
        vi.resetModules();
        const originalSet = Uint8Array.prototype.set;
        const originalFill = Uint8Array.prototype.fill;
        const copies: Uint8Array[] = [];
        const attempts: Uint8Array[] = [];
        const input: Input = {
            word: 0x12345678,
            first: Uint8Array.of(1),
            second: Uint8Array.of(2),
        };
        const setSpy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            offset,
        ) {
            copies.push(this);
            originalSet.call(this, source, offset);
        });
        const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value,
            start,
            end,
        ) {
            attempts.push(this);

            if (attempts.length === 1) {
                throw new Error('synthetic private cleanup failure');
            }

            return originalFill.call(this, value, start, end);
        });
        let output: Uint8Array;

        try {
            const isolated = await import('../../src/direct/target-wt-node-0147-candidate');
            output = isolated.encodeTargetWtLoginNode0147(input);
        } finally {
            setSpy.mockRestore();
            fillSpy.mockRestore();
            vi.resetModules();
        }

        expect(copies).toHaveLength(4);
        expect(attempts).toEqual(copies.slice(0, 2));
        expect(attempts[0][0]).toBe(1);
        expect(attempts[1].every((byte) => byte === 0)).toBe(true);
        expect(hex(output)).toBe('0147000a12345678000101000102');
        expect(byteFields.map((field) => input[field][0])).toEqual([1, 2]);
    });

    it('still wipes the failed output when snapshot cleanup throws', async () => {
        vi.resetModules();
        const originalSet = Uint8Array.prototype.set;
        const originalFill = Uint8Array.prototype.fill;
        const copies: Uint8Array[] = [];
        const attempts: Uint8Array[] = [];
        const input: Input = { word: 0, first: Uint8Array.of(1), second: Uint8Array.of(2) };
        const setSpy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            offset,
        ) {
            copies.push(this);
            originalSet.call(this, source, offset);

            if (copies.length === 3) {
                throw new Error('synthetic copy failure');
            }
        });
        const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value,
            start,
            end,
        ) {
            attempts.push(this);

            if (attempts.length === 1) {
                throw new Error('synthetic cleanup failure');
            }

            return originalFill.call(this, value, start, end);
        });

        try {
            const isolated = await import('../../src/direct/target-wt-node-0147-candidate');
            expect(() => isolated.encodeTargetWtLoginNode0147(input)).toThrow(failure);
        } finally {
            setSpy.mockRestore();
            fillSpy.mockRestore();
            vi.resetModules();
        }

        expect(attempts).toEqual(copies);
        expect(copies[1].every((byte) => byte === 0)).toBe(true);
        expect(copies[2].every((byte) => byte === 0)).toBe(true);
        expect(byteFields.map((field) => input[field][0])).toEqual([1, 2]);
    });
});
