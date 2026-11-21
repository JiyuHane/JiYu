import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { encodeTargetWtLoginNode0124 as encode } from '../../src/direct/target-wt-node-0124-candidate';

type Input = Parameters<typeof encode>[0];
type ByteField = 'first' | 'second' | 'third' | 'fourth';

const byteFields: ByteField[] = ['first', 'second', 'third', 'fourth'];
const empty = (): Input => ({
    first: new Uint8Array(),
    second: new Uint8Array(),
    word: 0,
    third: new Uint8Array(),
    fourth: new Uint8Array(),
});
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

// The expected bytes below are hand-assembled synthetic fixtures, not runtime captures.
describe('offline target WT login node 0124 candidate', () => {
    it('writes the empty value and a binary, asymmetric big-endian vector', () => {
        expect(hex(encode(empty()))).toBe('0124000c000000000000000000000000');
        expect(
            hex(
                encode({
                    first: Uint8Array.of(0x00, 0xff, 0x80),
                    second: Uint8Array.of(0xc0, 0xaf),
                    word: 0x1234,
                    third: Uint8Array.of(0xed, 0xa0, 0x80, 0x00),
                    fourth: Uint8Array.of(0xfe),
                }),
            ),
        ).toBe('01240016000300ff800002c0af12340004eda080000001fe0000');
    });

    it('writes all field lengths and the outer value length in big-endian', () => {
        const first = Uint8Array.from({ length: 256 }, (_, i) => i);
        const second = Uint8Array.from({ length: 257 }, (_, i) => 255 - (i % 256));
        const output = encode({
            first,
            second,
            word: 0xabcd,
            third: Uint8Array.of(0x80),
            fourth: new Uint8Array(),
        });
        // 12 bytes of fixed overhead + 256 + 257 + 1 = 526 (0x020e).
        expect(hex(output.subarray(0, 6))).toBe('0124020e0100');
        expect(output.subarray(6, 262)).toEqual(first);
        expect(hex(output.subarray(262, 264))).toBe('0101');
        expect(output.subarray(264, 521)).toEqual(second);
        expect(hex(output.subarray(521))).toBe('abcd00018000000000');
        expect(hex(encode({ ...empty(), word: 0xffff }))).toBe('0124000c00000000ffff000000000000');
    });

    it('copies only the selected subviews and keeps output and inputs independent', () => {
        const backing = Buffer.from([0x77, 0x00, 0xff, 0x80, 0x66]);
        const foreign = runInNewContext(
            'new Uint8Array([9, 0xc0, 0xaf, 8]).subarray(1, 3)',
        ) as Uint8Array;
        const input: Input = {
            first: backing.subarray(1, 4),
            second: foreign,
            word: 0x0102,
            third: backing.subarray(2, 3),
            fourth: new Uint8Array(backing.buffer, backing.byteOffset + 3, 1),
        };
        const output = encode(input);
        const expected = '01240013000300ff800002c0af01020001ff0001800000';
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

    it('accepts value length 65535 and rejects larger aggregate values', () => {
        const payload = Uint8Array.from({ length: 65523 }, (_, i) => (i * 73 + 91) & 0xff);
        const original = payload.slice();
        const output = encode({ ...empty(), first: payload, word: 0x3456 });
        expect(output.length).toBe(65539);
        expect(hex(output.subarray(0, 6))).toBe('0124fffffff3');
        expect(output.subarray(6, 6 + payload.length)).toEqual(original);
        expect(hex(output.subarray(6 + payload.length))).toBe('00003456000000000000');
        expect(payload).toEqual(original);
        expect(() => encode({ ...empty(), first: payload, fourth: Uint8Array.of(1) })).toThrow();
        expect(() => encode({ ...empty(), first: new Uint8Array(65524) })).toThrow();
        expect(() => encode({ ...empty(), first: new Uint8Array(65535) })).toThrow();
        expect(() => encode({ ...empty(), first: new Uint8Array(65536) })).toThrow();
    });

    it('rejects non-u16 word values without coercion', () => {
        let calls = 0;
        const coercible = {
            valueOf() {
                calls++;
                return 1;
            },
        };

        for (const word of [
            -1,
            65536,
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
            expect(() => encode({ ...empty(), word } as Input)).toThrow();
        }

        expect(calls).toBe(0);
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
                expect(() => encode({ ...empty(), [field]: value } as Input)).toThrow();
            }
        }

        expect(calls).toBe(0);
    });

    it('rejects input proxies and accessor fields without invoking their traps or accessors', () => {
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
        ).toThrow();
        expect(() => encode(revoked.proxy)).toThrow();

        for (const field of [...byteFields, 'word'] as const) {
            const input = empty();
            Object.defineProperty(input, field, { get: trap, set: trap, enumerable: true });
            expect(() => encode(input)).toThrow();

            const setterOnly = empty();
            Object.defineProperty(setterOnly, field, { set: trap, enumerable: true });
            expect(() => encode(setterOnly)).toThrow();
        }

        expect(calls).toBe(0);
    });

    it.each([1, 2, 3, 4, 5, 6, 7, 8])(
        'clears owned buffers after a copy fails at operation %i',
        async (failAt) => {
            vi.resetModules();
            const original = Uint8Array.prototype.set;
            const destinations: Uint8Array[] = [];
            const input: Input = {
                first: Uint8Array.of(1),
                second: Uint8Array.of(2),
                word: 0x1234,
                third: Uint8Array.of(3),
                fourth: Uint8Array.of(4),
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
                const isolated = await import('../../src/direct/target-wt-node-0124-candidate');
                expect(() => isolated.encodeTargetWtLoginNode0124(input)).toThrow(
                    'target WT login node encoding failed',
                );
            } finally {
                spy.mockRestore();
                vi.resetModules();
            }

            expect(destinations).toHaveLength(failAt);
            expect(destinations.every((value) => value.every((byte) => byte === 0))).toBe(true);
            expect(byteFields.map((field) => input[field][0])).toEqual([1, 2, 3, 4]);
        },
    );

    it('attempts independent snapshot cleanup even when one wipe fails', async () => {
        vi.resetModules();
        const originalSet = Uint8Array.prototype.set;
        const originalFill = Uint8Array.prototype.fill;
        const copies: Uint8Array[] = [];
        const attempts: Uint8Array[] = [];
        const input: Input = {
            first: Uint8Array.of(1),
            second: Uint8Array.of(2),
            word: 0,
            third: Uint8Array.of(3),
            fourth: Uint8Array.of(4),
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
            const isolated = await import('../../src/direct/target-wt-node-0124-candidate');
            output = isolated.encodeTargetWtLoginNode0124(input);
        } finally {
            setSpy.mockRestore();
            fillSpy.mockRestore();
            vi.resetModules();
        }

        expect(attempts).toEqual(copies.slice(0, 4));
        expect(attempts[0][0]).toBe(1);
        expect(attempts.slice(1).every((value) => value.every((byte) => byte === 0))).toBe(true);
        expect(hex(output)).toBe('0124001000010100010200000001030001040000');
        expect(byteFields.map((field) => input[field][0])).toEqual([1, 2, 3, 4]);
    });

    it('reads genuine byte views without executing shadow getters or setters', () => {
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

        expect(hex(encode({ ...empty(), first: view }))).toBe(
            '0124000f000300ff8000000000000000000000',
        );
        expect(calls).toBe(0);
    });
});
