import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { encodeTargetWtLoginNode0128 as encode } from '../../src/direct/target-wt-node-0128-candidate';

type Input = Parameters<typeof encode>[0];
type ByteField = 'prefix' | 'first' | 'second';
const byteFields: ByteField[] = ['prefix', 'first', 'second'];
const empty = (): Input => ({
    prefix: new Uint8Array(9),
    first: new Uint8Array(),
    second: new Uint8Array(),
});
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const failure = 'target WT login node encoding failed';

// Hand-assembled synthetic bytes, not a runtime capture or evidence of text semantics.
describe('offline target WT login node 0128 candidate', () => {
    it('matches the exact synthetic Linux and binary second oracle', () => {
        expect(
            hex(
                encode({
                    prefix: new Uint8Array(9),
                    first: Uint8Array.of(0x4c, 0x69, 0x6e, 0x75, 0x78),
                    second: Uint8Array.of(0xaa, 0xbb),
                }),
            ),
        ).toBe('0128001600000000000000000000054c696e75780002aabb0000');
    });

    it('preserves empty and arbitrary binary bytes without text conversion', () => {
        expect(hex(encode(empty()))).toBe('0128000f000000000000000000000000000000');
        expect(
            hex(
                encode({
                    prefix: Uint8Array.of(0x12, 0x34, 0x00, 0xff, 0x80, 0xc0, 0xaf, 0xfe, 0x01),
                    first: Uint8Array.of(0xed, 0xa0, 0x80, 0x00),
                    second: Uint8Array.of(0xff, 0xc0, 0xaf),
                }),
            ),
        ).toBe('01280016123400ff80c0affe010004eda080000003ffc0af0000');
    });

    it('treats the encoded word and seven subsequent bytes as opaque caller bytes', () => {
        // The word is not derived from either payload or interpreted as text.
        const prefixA = Uint8Array.of(0xab, 0xcd, 1, 2, 3, 4, 5, 6, 7);
        const prefixB = Uint8Array.of(0x00, 0x01, 1, 2, 3, 4, 5, 6, 7);
        expect(hex(encode({ ...empty(), prefix: prefixA, first: Uint8Array.of(0xff) }))).toBe(
            '01280010abcd010203040506070001ff00000000',
        );
        expect(hex(encode({ ...empty(), prefix: prefixB, first: Uint8Array.of(0xff) }))).toBe(
            '012800100001010203040506070001ff00000000',
        );
    });

    it('copies each selected subview and keeps every input and the result independent', () => {
        const prefixBacking = Buffer.from([0xfe, 0x12, 0x34, 0, 1, 2, 3, 4, 5, 6, 0xfd]);
        const firstBacking = Buffer.from([0x77, 0x00, 0xff, 0x80, 0x66]);
        const second = runInNewContext(
            'new Uint8Array([9, 0xc0, 0xaf, 8]).subarray(1, 3)',
        ) as Uint8Array;
        const prefix = prefixBacking.subarray(1, 10);
        const first = firstBacking.subarray(1, 4);
        const output = encode({ prefix, first, second });
        const expected = '01280014123400010203040506000300ff800002c0af0000';
        expect(hex(output)).toBe(expected);
        expect(prefixBacking).toEqual(Buffer.from([0xfe, 0x12, 0x34, 0, 1, 2, 3, 4, 5, 6, 0xfd]));
        expect(firstBacking).toEqual(Buffer.from([0x77, 0x00, 0xff, 0x80, 0x66]));

        for (const part of [prefix, first, second]) {
            expect(output.buffer).not.toBe(part.buffer);
        }

        prefixBacking.fill(0x55);
        firstBacking.fill(0x44);
        second.fill(0x33);
        expect(hex(output)).toBe(expected);
        output.fill(0xaa);
        expect(prefixBacking).toEqual(Buffer.alloc(11, 0x55));
        expect(firstBacking).toEqual(Buffer.alloc(5, 0x44));
        expect(Array.from(second)).toEqual([0x33, 0x33]);
    });

    it('uses BE16 for both field lengths and the aggregate value length', () => {
        const first = Uint8Array.from({ length: 256 }, (_, i) => i);
        const second = Uint8Array.from({ length: 257 }, (_, i) => 255 - (i % 256));
        const output = encode({
            prefix: Uint8Array.of(0xab, 0xcd, 1, 2, 3, 4, 5, 6, 7),
            first,
            second,
        });
        // 15 + 256 + 257 = 528 (0x0210).
        expect(hex(output.subarray(0, 15))).toBe('01280210abcd010203040506070100');
        expect(output.subarray(15, 271)).toEqual(first);
        expect(hex(output.subarray(271, 273))).toBe('0101');
        expect(output.subarray(273, 530)).toEqual(second);
        expect(hex(output.subarray(530))).toBe('0000');
    });

    it('accepts total value length 65535 and rejects 65536 without truncation', () => {
        const payload = Uint8Array.from({ length: 65520 }, (_, i) => (i * 73 + 91) & 0xff);
        const original = payload.slice();
        const output = encode({ ...empty(), first: payload });
        expect(output.length).toBe(65539);
        expect(hex(output.subarray(0, 15))).toBe('0128ffff000000000000000000fff0');
        expect(output.subarray(15, 65535)).toEqual(original);
        expect(hex(output.subarray(65535))).toBe('00000000');
        expect(payload).toEqual(original);
        expect(() => encode({ ...empty(), first: payload, second: Uint8Array.of(1) })).toThrow();
        expect(() => encode({ ...empty(), first: new Uint8Array(65521) })).toThrow();
        expect(() => encode({ ...empty(), second: new Uint8Array(65521) })).toThrow();
        expect(() => encode({ ...empty(), second: new Uint8Array(65536) })).toThrow();
        expect(hex(encode({ ...empty(), second: payload }).subarray(0, 17))).toBe(
            '0128ffff0000000000000000000000fff0',
        );
    });

    it('rejects every non-nine-byte prefix and missing or extra fields', () => {
        for (const size of [0, 1, 8, 10, 65535]) {
            expect(() => encode({ ...empty(), prefix: new Uint8Array(size) })).toThrow();
        }

        expect(() =>
            encode({ first: new Uint8Array(), second: new Uint8Array() } as Input),
        ).toThrow();
        expect(() => encode({ ...empty(), word: 1 } as Input)).toThrow();
    });

    it('rejects invalid, proxy, shared, detached and out-of-bounds views without traps', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('synthetic trap');
        };

        const detached = Uint8Array.of(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const resizable = new ArrayBuffer(16, { maxByteLength: 32 });
        const outOfBounds = new Uint8Array(resizable, 4, 9);
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
            new Uint16Array(9),
            new Uint8ClampedArray(9),
            new DataView(new ArrayBuffer(9)),
            detached,
            outOfBounds,
            proxyPrototype,
            revoked.proxy,
            new Proxy(new Uint8Array(9), { get: trap, getPrototypeOf: trap }),
            new Uint8Array(new SharedArrayBuffer(9)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(9))'),
        ];

        for (const field of byteFields) {
            for (const value of invalid) {
                expect(() => encode({ ...empty(), [field]: value } as Input)).toThrow();
            }
        }

        expect(calls).toBe(0);
    });

    it('rejects input proxies and accessor fields without invoking any traps', () => {
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
        const prototype = empty();
        Object.setPrototypeOf(prototype, new Proxy(Object.prototype, { getPrototypeOf: trap }));
        expect(() => encode(prototype)).toThrow();

        for (const field of byteFields) {
            const input = empty();
            Object.defineProperty(input, field, { get: trap, set: trap, enumerable: true });
            expect(() => encode(input)).toThrow();
            const setterOnly = empty();
            Object.defineProperty(setterOnly, field, { set: trap, enumerable: true });
            expect(() => encode(setterOnly)).toThrow();
        }

        expect(calls).toBe(0);
    });

    it('reads real byte views without invoking shadow accessors', () => {
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
            '01280012000000000000000000000300ff8000000000',
        );
        expect(calls).toBe(0);
    });

    it.each([1, 2, 3, 4, 5, 6])(
        'clears owned buffers when copy operation %i fails',
        async (failAt) => {
            vi.resetModules();
            const original = Uint8Array.prototype.set;
            const destinations: Uint8Array[] = [];
            const input: Input = {
                prefix: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
                first: Uint8Array.of(10),
                second: Uint8Array.of(11),
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
                const isolated = await import('../../src/direct/target-wt-node-0128-candidate');
                expect(() => isolated.encodeTargetWtLoginNode0128(input)).toThrow(failure);
            } finally {
                spy.mockRestore();
                vi.resetModules();
            }

            expect(destinations).toHaveLength(failAt);
            expect(destinations.every((value) => value.every((byte) => byte === 0))).toBe(true);
            expect(byteFields.map((field) => input[field][0])).toEqual([1, 10, 11]);
        },
    );

    it('attempts every snapshot wipe even when one cleanup throws', async () => {
        vi.resetModules();
        const originalSet = Uint8Array.prototype.set;
        const originalFill = Uint8Array.prototype.fill;
        const copies: Uint8Array[] = [];
        const attempts: Uint8Array[] = [];
        const input: Input = {
            prefix: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
            first: Uint8Array.of(10),
            second: Uint8Array.of(11),
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
                throw new Error('synthetic cleanup failure');
            }

            return originalFill.call(this, value, start, end);
        });
        let output: Uint8Array;

        try {
            const isolated = await import('../../src/direct/target-wt-node-0128-candidate');
            output = isolated.encodeTargetWtLoginNode0128(input);
        } finally {
            setSpy.mockRestore();
            fillSpy.mockRestore();
            vi.resetModules();
        }

        expect(copies).toHaveLength(6);
        expect(attempts).toEqual(copies.slice(0, 3));
        expect(attempts[0][0]).toBe(1);
        expect(attempts.slice(1).every((value) => value.every((byte) => byte === 0))).toBe(true);
        expect(hex(output)).toBe('0128001101020304050607080900010a00010b0000');
        expect(byteFields.map((field) => input[field][0])).toEqual([1, 10, 11]);
    });

    it('still wipes incomplete output when one snapshot cleanup fails', async () => {
        vi.resetModules();
        const originalSet = Uint8Array.prototype.set;
        const originalFill = Uint8Array.prototype.fill;
        const copies: Uint8Array[] = [];
        const attempts: Uint8Array[] = [];
        const input: Input = {
            prefix: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
            first: Uint8Array.of(10),
            second: Uint8Array.of(11),
        };
        const setSpy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            offset,
        ) {
            copies.push(this);
            originalSet.call(this, source, offset);

            if (copies.length === 4) {
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
            const isolated = await import('../../src/direct/target-wt-node-0128-candidate');
            expect(() => isolated.encodeTargetWtLoginNode0128(input)).toThrow(failure);
        } finally {
            setSpy.mockRestore();
            fillSpy.mockRestore();
            vi.resetModules();
        }

        expect(attempts).toEqual(copies);
        expect(copies.slice(1).every((value) => value.every((byte) => byte === 0))).toBe(true);
        expect(byteFields.map((field) => input[field][0])).toEqual([1, 10, 11]);
    });
});
