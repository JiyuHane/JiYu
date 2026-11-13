import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    encodeTargetQr12Body as encode,
    encodeTargetQr12QueryBody as query,
    type TargetQr12Body,
} from '../../src/direct/target-qr12-body';

const failure = 'target QR12 body construction failed';
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function fixture(): TargetQr12Body {
    return {
        field38: Uint8Array.of(0xaa, 0xbb),
        field50: 0x01020304,
        field58: Uint8Array.of(0, 0xff, 0x80),
        field30: 0xfedcba9876543210n,
        field70: 0x81,
        field78: Uint8Array.of(0x11, 0x22),
        values: [0, 0x1234, 0xffff],
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('target-static QR12 body encoders', () => {
    it('matches a hand-assembled fully populated synthetic body with no tags', () => {
        const input = fixture();
        expect(hex(encode(input))).toBe(
            '0002aabb01020304000300ff80fedcba98765432108100021122000300001234ffff',
        );
        expect(input.field58).toEqual(Uint8Array.of(0, 0xff, 0x80));
        expect(input.values).toEqual([0, 0x1234, 0xffff]);
    });

    it('matches query path with caller-supplied opaque bytes and high u64', () => {
        const input = {
            field50: 0x11223344,
            field30: 0xf123456789abcdefn,
            field58: Uint8Array.of(0, 0xff, 1),
        };
        const output = query(input);
        expect(hex(output)).toBe('000011223344000300ff01f123456789abcdef0000000000');
        const expected = encode({
            field38: new Uint8Array(),
            field50: input.field50,
            field58: input.field58,
            field30: input.field30,
            field70: 0,
            field78: new Uint8Array(),
            values: [],
        });
        expect(output).toEqual(expected);
        expect(output.buffer).not.toBe(input.field58.buffer);
        input.field58[0] = 1;
        expect(output[8]).toBe(0);
    });

    it('preserves all-empty fields and unsigned max values without coercion', () => {
        const input = {
            field38: new Uint8Array(),
            field50: 0xffffffff,
            field58: new Uint8Array(),
            field30: 0xffffffffffffffffn,
            field70: 0xff,
            field78: new Uint8Array(),
            values: [0xffff],
        };
        expect(hex(encode(input))).toBe('0000ffffffff0000ffffffffffffffffff00000001ffff');
        expect(hex(query({ field50: 0, field30: 0n, field58: new Uint8Array() }))).toBe(
            '00'.repeat(21),
        );
    });

    it('enforces u8, u16, u32 and bigint u64 exactly', () => {
        for (const [name, value] of [
            ['field50', -1],
            ['field50', 0x100000000],
            ['field50', 1.5],
            ['field50', NaN],
            ['field50', '1'],
            ['field70', -1],
            ['field70', 256],
            ['field70', Infinity],
            ['field30', -1n],
            ['field30', 0x10000000000000000n],
            ['field30', 1],
            ['field30', '1'],
        ] as const) {
            const input = fixture();
            Object.assign(input, { [name]: value });
            expect(() => encode(input)).toThrow(failure);
        }

        for (const value of [-1, 65536, 1.5, NaN, Infinity, '1']) {
            const input = fixture();
            input.values = [value as number];
            expect(() => encode(input)).toThrow(failure);
        }

        expect(() =>
            query({ field50: 1, field30: 3 as unknown as bigint, field58: new Uint8Array() }),
        ).toThrow(failure);
    });

    it('bounds every byte span and the ordered value vector', () => {
        for (const name of ['field38', 'field58', 'field78'] as const) {
            const input = fixture();
            input[name] = new Uint8Array(65535).fill(0xa5);
            expect(encode(input).length).toBe(
                21 + 65535 + (name === 'field38' ? 3 + 2 : name === 'field58' ? 2 + 2 : 2 + 3) + 6,
            );
            input[name] = new Uint8Array(65536);
            expect(() => encode(input)).toThrow(failure);
        }

        const input = fixture();
        input.values = Array.from({ length: 4096 }, (_, i) => i);
        const result = Buffer.from(encode(input));
        expect(result.length).toBe(21 + 2 + 3 + 2 + 8192);
        expect(result.readUInt16BE(result.length - 8192 - 2)).toBe(4096);
        expect(result.readUInt16BE(result.length - 2)).toBe(4095);
        input.values = Array(4097).fill(0);
        expect(() => encode(input)).toThrow(failure);
    });

    it('uses actual byte slots on subviews and foreign arrays without calling shadow getters', () => {
        const input = fixture();
        let calls = 0;

        const bad = () => {
            calls++;
            throw new Error('secret');
        };

        input.field38 = runInNewContext(
            'new Uint8Array([9,170,187,9]).subarray(1,3)',
        ) as Uint8Array;
        input.values = runInNewContext('[0,0x1234,0xffff]') as number[];

        for (const name of [
            'buffer',
            'byteLength',
            'byteOffset',
            'length',
            Symbol.iterator,
            Symbol.toStringTag,
        ]) {
            Object.defineProperty(input.field38, name, { get: bad });
        }

        const out = encode(input);
        expect(hex(out)).toBe(
            '0002aabb01020304000300ff80fedcba98765432108100021122000300001234ffff',
        );
        expect(calls).toBe(0);
        out[2] = 0;
        expect(input.field38[0]).toBe(0xaa);
    });

    it('rejects proxies, holes, array accessors and proxy prototypes without traps', () => {
        const input = fixture();
        let calls = 0;

        const bad = () => {
            calls++;
            throw new Error('secret');
        };

        const extra = fixture();
        Object.defineProperty(extra, 'extra', { get: bad });
        const array = [1, 2];
        Object.defineProperty(array, '1', { get: bad });
        const withArray = { ...input, values: array };
        const proxyArray = { ...input, values: new Proxy([1], { get: bad, getPrototypeOf: bad }) };
        const hole = { ...input, values: new Array(1) };
        const hostileByte = Uint8Array.of(1);
        Object.setPrototypeOf(
            hostileByte,
            new Proxy(Uint8Array.prototype, { get: bad, getPrototypeOf: bad }),
        );
        const recordProto = Object.create(new Proxy(Object.prototype, { getPrototypeOf: bad }));

        for (const badInput of [
            new Proxy(input, { get: bad, getPrototypeOf: bad }),
            extra,
            withArray,
            proxyArray,
            hole,
            { ...input, field78: hostileByte },
            recordProto,
        ]) {
            expect(() => encode(badInput)).toThrow(failure);
        }

        const queryInput = { field50: 1, field30: 2n, field58: new Uint8Array() };
        Object.defineProperty(queryInput, 'field50', { get: bad });
        expect(() => query(queryInput)).toThrow(failure);
        expect(calls).toBe(0);
    });

    it('rejects shared, detached, out-of-bounds and non-byte views', () => {
        const detached = Uint8Array.of(1);
        structuredClone(detached, { transfer: [detached.buffer] });
        const rab = new ArrayBuffer(2, { maxByteLength: 4 });
        const oob = new Uint8Array(rab, 1, 1);
        rab.resize(0);
        const foreignShared = runInNewContext(
            'new Uint8Array(new SharedArrayBuffer(1))',
        ) as Uint8Array;

        for (const invalid of [
            new Uint8Array(new SharedArrayBuffer(1)),
            foreignShared,
            detached,
            oob,
            new Uint16Array(1),
            new DataView(new ArrayBuffer(1)),
            null,
        ]) {
            for (const name of ['field38', 'field58', 'field78'] as const) {
                expect(() => encode({ ...fixture(), [name]: invalid } as TargetQr12Body)).toThrow(
                    failure,
                );
            }
        }
    });

    it('clears all snapshots and late failed output despite one cleanup throw', async () => {
        vi.resetModules();
        const input = fixture();
        const originalSet = Uint8Array.prototype.set;
        const originalFill = Uint8Array.prototype.fill;
        const cleaned: Uint8Array[] = [];
        let count = 0;
        vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            offset,
        ) {
            originalSet.call(this, source, offset);

            if (++count === 6) {
                throw new Error('secret');
            }
        });
        vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value,
            start,
            end,
        ) {
            cleaned.push(this);

            if (cleaned.length === 1) {
                throw new Error('secret cleanup');
            }

            return originalFill.call(this, value, start, end);
        });
        const isolated = await import('../../src/direct/target-qr12-body');
        let caught: unknown;

        try {
            isolated.encodeTargetQr12Body(input);
        } catch (error) {
            caught = error;
        }

        vi.restoreAllMocks();
        expect((caught as Error).message).toBe(failure);
        expect(cleaned).toHaveLength(4);
        expect(cleaned.slice(1).every((entry) => entry.every((b) => b === 0))).toBe(true);
        expect(input.field38).toEqual(Uint8Array.of(0xaa, 0xbb));
        expect(input.field58).toEqual(Uint8Array.of(0, 0xff, 0x80));
    });

    it('uses captured constructors even if a global is replaced later', () => {
        const input = fixture();
        const hostile = vi.fn(function () {
            return input.field58;
        });
        vi.stubGlobal('Uint8Array', hostile);
        let output: Uint8Array;

        try {
            output = encode(input);
        } finally {
            vi.unstubAllGlobals();
        }

        expect(hostile).not.toHaveBeenCalled();
        expect(hex(output)).toBe(
            '0002aabb01020304000300ff80fedcba98765432108100021122000300001234ffff',
        );
        expect(input.field58).toEqual(Uint8Array.of(0, 0xff, 0x80));
    });
});
