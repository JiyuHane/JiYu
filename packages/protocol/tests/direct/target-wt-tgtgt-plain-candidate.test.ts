import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { encodeTargetWtTgtgtPlainCandidate as encode } from '../../src/direct/target-wt-tgtgt-plain-candidate';

type Input = Parameters<typeof encode>[0];
const byteFields = ['raw5', 'raw7', 'raw20', 'tail38'] as const;
const u32Fields = [
    'arg3',
    'field04',
    'field08',
    'field0c',
    'arg4',
    'field14',
    'field10',
    'field00',
] as const;
const u8Fields = ['field18', 'field19'] as const;
const allFields = [...u32Fields, 'field50', ...u8Fields, ...byteFields] as const;
const empty = (): Input => ({
    arg3: 0,
    field04: 0,
    field08: 0,
    field0c: 0,
    field50: 0n,
    arg4: 0,
    field14: 0,
    field18: 0,
    raw5: new Uint8Array(),
    raw7: new Uint8Array(),
    field19: 0,
    raw20: new Uint8Array(),
    field10: 0,
    field00: 0,
    tail38: new Uint8Array(),
});
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

// Hand-assembled synthetic vectors; none are account data or captured traffic.
describe('offline target WT tgtgt plaintext candidate', () => {
    it('writes the empty 48-byte value without an empty tail length', () => {
        expect(hex(encode(empty()))).toBe(
            '0004' +
                '00000000'.repeat(4) +
                '0000000000000000' +
                '00000000'.repeat(2) +
                '00' +
                '00000000' +
                '00' +
                '00000000'.repeat(2),
        );
        expect(encode(empty())).toHaveLength(48);
    });

    it('matches an independent asymmetric binary vector in exact field order', () => {
        const input: Input = {
            arg3: 0x01020304,
            field04: 0x11223344,
            field08: 0x89abcdef,
            field0c: 0xfedcba98,
            field50: 0x0123456789abcdefn,
            arg4: 0x10203040,
            field14: 0xf1e2d3c4,
            field18: 0x80,
            raw5: Uint8Array.of(0, 0xff, 0xc0),
            raw7: Uint8Array.of(0x7f, 0x81),
            field19: 0xfe,
            raw20: Uint8Array.of(0xed, 0xa0, 0x80, 0),
            field10: 0x76543210,
            field00: 0xa1b2c3d4,
            tail38: Uint8Array.of(0xff, 0, 0x90),
        };
        expect(hex(encode(input))).toBe(
            '0004' +
                '01020304' +
                '11223344' +
                '89abcdef' +
                'fedcba98' +
                '0123456789abcdef' +
                '10203040' +
                'f1e2d3c4' +
                '80' +
                '00ffc0' +
                '7f81' +
                '00000000' +
                'fe' +
                'eda08000' +
                '76543210' +
                'a1b2c3d4' +
                '0003ff0090',
        );
    });

    it('writes unsigned extrema without narrowing or signed conversion', () => {
        const input = empty();

        for (const field of u32Fields) {
            input[field] = 0xffffffff;
        }

        input.field50 = 0xffffffffffffffffn;
        input.field18 = 0xff;
        input.field19 = 0xff;
        expect(hex(encode(input))).toBe(
            '0004' +
                'ffffffff'.repeat(4) +
                'ffffffffffffffff' +
                'ffffffff'.repeat(2) +
                'ff' +
                '00000000' +
                'ff' +
                'ffffffff'.repeat(2),
        );
    });

    it('copies exact selected subviews, including foreign and overlapping views', () => {
        const backing = Buffer.from([0x99, 0x00, 0xff, 0x80, 0x88]);
        const foreign = runInNewContext(
            'new Uint8Array([9, 0xc0, 0xaf, 8]).subarray(1, 3)',
        ) as Uint8Array;
        const input: Input = {
            ...empty(),
            raw5: backing.subarray(1, 4),
            raw7: foreign,
            raw20: backing.subarray(2, 3),
            tail38: new Uint8Array(backing.buffer, backing.byteOffset + 3, 1),
        };
        const output = encode(input);
        const expected =
            '0004' +
            '00000000'.repeat(4) +
            '0000000000000000' +
            '00000000'.repeat(2) +
            '00' +
            '00ff80c0af' +
            '00000000' +
            '00ff' +
            '00000000'.repeat(2) +
            '000180';
        expect(hex(output)).toBe(expected);
        expect(output.buffer).not.toBe(backing.buffer);
        expect(output.buffer).not.toBe(foreign.buffer);
        expect(backing).toEqual(Buffer.from([0x99, 0x00, 0xff, 0x80, 0x88]));
        backing.fill(0x55);
        foreign.fill(0x44);
        expect(hex(output)).toBe(expected);
        output.fill(0xaa);
        expect(backing).toEqual(Buffer.alloc(5, 0x55));
        expect(Array.from(foreign)).toEqual([0x44, 0x44]);
    });

    it('emits raw fields without length prefixes and changes the tail length prefix at 256', () => {
        const raw5 = Uint8Array.from({ length: 256 }, (_, i) => i);
        const raw7 = Uint8Array.from({ length: 257 }, (_, i) => 255 - (i & 255));
        const tail = Uint8Array.from({ length: 256 }, (_, i) => (i * 73 + 91) & 255);
        const out = encode({
            ...empty(),
            raw5,
            raw7,
            field19: 0x7b,
            raw20: Uint8Array.of(0xe1),
            tail38: tail,
        });
        expect(out.subarray(35, 291)).toEqual(raw5);
        expect(out.subarray(291, 548)).toEqual(raw7);
        expect(hex(out.subarray(548, 564))).toBe('000000007be100000000000000000100');
        expect(out.subarray(564)).toEqual(tail);
        expect(out).toHaveLength(48 + 256 + 257 + 1 + 2 + 256);
    });

    it('accepts a 65535-byte tail and rejects 65536', () => {
        const tail = Uint8Array.from({ length: 65535 }, (_, i) => (i * 73 + 91) & 255);
        const out = encode({ ...empty(), tail38: tail });
        expect(out).toHaveLength(48 + 2 + 65535);
        expect(hex(out.subarray(48, 50))).toBe('ffff');
        expect(out.subarray(50)).toEqual(tail);
        expect(() => encode({ ...empty(), tail38: new Uint8Array(65536) })).toThrow();
    });

    it('enforces the complete 16 MiB output limit including optional tail framing', () => {
        const limit = 16 * 1024 * 1024;
        const payload = new Uint8Array(limit - 48);
        payload[0] = 0x91;
        payload[payload.length - 1] = 0x37;
        const out = encode({ ...empty(), raw5: payload });
        expect(out).toHaveLength(limit);
        expect(out[35]).toBe(0x91);
        expect(out[35 + payload.length - 1]).toBe(0x37);
        expect(() => encode({ ...empty(), raw5: payload, raw20: Uint8Array.of(1) })).toThrow();
        expect(() => encode({ ...empty(), raw5: payload, tail38: Uint8Array.of(1) })).toThrow();
        const withTail = encode({
            ...empty(),
            raw5: payload.subarray(0, payload.length - 3),
            tail38: Uint8Array.of(0x42),
        });
        expect(withTail).toHaveLength(limit);
        expect(hex(withTail.subarray(limit - 3))).toBe('000142');
    }, 30000);

    it('rejects out-of-range, wrong-type and coercible scalar values without coercion', () => {
        let calls = 0;
        const coercible = {
            valueOf() {
                calls++;
                return 1;
            },
        };

        for (const field of u32Fields) {
            for (const value of [
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
                expect(() => encode({ ...empty(), [field]: value } as Input)).toThrow();
            }
        }

        for (const field of u8Fields) {
            for (const value of [
                -1,
                256,
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
                expect(() => encode({ ...empty(), [field]: value } as Input)).toThrow();
            }
        }

        for (const value of [-1n, 0x10000000000000000n, 0, 1, '1', null, undefined, coercible]) {
            expect(() => encode({ ...empty(), field50: value } as Input)).toThrow();
        }

        expect(calls).toBe(0);
    });

    it('requires exactly fifteen own data properties, without executing accessors or proxy traps', () => {
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
                    ownKeys: trap,
                    getOwnPropertyDescriptor: trap,
                }),
            ),
        ).toThrow();
        expect(() => encode(revoked.proxy)).toThrow();
        expect(() => encode(null as unknown as Input)).toThrow();
        expect(() => encode({ ...empty(), extra: 1 } as Input)).toThrow();
        expect(() => encode({ ...empty(), [Symbol('extra')]: 1 } as Input)).toThrow();

        for (const field of allFields) {
            const missing = { ...empty() } as Partial<Input>;
            delete missing[field];
            expect(() => encode(missing as Input)).toThrow();
            const getter = empty();
            Object.defineProperty(getter, field, { get: trap, set: trap, enumerable: true });
            expect(() => encode(getter)).toThrow();
            const setter = empty();
            Object.defineProperty(setter, field, { set: trap, enumerable: true });
            expect(() => encode(setter)).toThrow();
        }

        expect(calls).toBe(0);
    });

    it('rejects invalid views, proxies, shared, detached and out-of-bounds views without traps', () => {
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

    it('reads genuine views without invoking shadow accessors', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('synthetic accessor');
        };

        const view = Uint8Array.of(0, 0xff, 0x80);

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

        const output = encode({ ...empty(), raw5: view });
        expect(hex(output.subarray(35, 38))).toBe('00ff80');
        expect(calls).toBe(0);
    });

    it.each([1, 2, 3, 4, 5, 6, 7, 8])(
        'wipes owned buffers when copy operation %i fails',
        async (failAt) => {
            vi.resetModules();
            const original = Uint8Array.prototype.set;
            const destinations: Uint8Array[] = [];
            const input = {
                ...empty(),
                raw5: Uint8Array.of(1),
                raw7: Uint8Array.of(2),
                raw20: Uint8Array.of(3),
                tail38: Uint8Array.of(4),
            };
            const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
                this: Uint8Array,
                source,
                offset,
            ) {
                destinations.push(this);
                original.call(this, source, offset);

                if (destinations.length === failAt) {
                    throw new Error('synthetic private copy failure');
                }
            });

            try {
                const isolated = await import('../../src/direct/target-wt-tgtgt-plain-candidate');
                expect(() => isolated.encodeTargetWtTgtgtPlainCandidate(input)).toThrow();
            } finally {
                spy.mockRestore();
                vi.resetModules();
            }

            expect(destinations).toHaveLength(failAt);
            expect(destinations.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
            expect(byteFields.map((field) => input[field][0])).toEqual([1, 2, 3, 4]);
        },
    );

    it('attempts independent cleanup when a snapshot wipe fails', async () => {
        vi.resetModules();
        const originalSet = Uint8Array.prototype.set;
        const originalFill = Uint8Array.prototype.fill;
        const copies: Uint8Array[] = [];
        const attempts: Uint8Array[] = [];
        const input = {
            ...empty(),
            raw5: Uint8Array.of(1),
            raw7: Uint8Array.of(2),
            raw20: Uint8Array.of(3),
            tail38: Uint8Array.of(4),
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
                throw new Error('synthetic private wipe failure');
            }

            return originalFill.call(this, value, start, end);
        });
        let output: Uint8Array;

        try {
            const isolated = await import('../../src/direct/target-wt-tgtgt-plain-candidate');
            output = isolated.encodeTargetWtTgtgtPlainCandidate(input);
        } finally {
            setSpy.mockRestore();
            fillSpy.mockRestore();
            vi.resetModules();
        }

        expect(attempts).toEqual(copies.slice(0, 4));
        expect(attempts[0][0]).toBe(1);
        expect(attempts.slice(1).every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
        expect(hex(output.subarray(output.length - 3))).toBe('000104');
        expect(byteFields.map((field) => input[field][0])).toEqual([1, 2, 3, 4]);
    });
});
