import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    encodeTargetQr31Tlv35 as tlv35,
    encodeTargetQr31Tlv66 as tlv66,
    encodeTargetQr31Tlv33 as tlv33,
    encodeTargetQr31Tlv11 as tlv11,
    encodeTargetQr31Tlv16 as tlv16,
    encodeTargetQr31Tlv1d as tlv1d,
    encodeTargetQr31Tlv1b as tlv1b,
} from '../../src/direct/target-qr31-tlv';

const error = 'target QR31 TLV encoding failed';
const words = [0x01020304, 0x11223344, 0x55667788, 0x90abcdef, 0xfedcba98, 0x76543210, 0xaabbccdd];

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('synthetic target-static QR31 child TLV encoders', () => {
    it('encodes the hand-assembled 0x35 and 0x1d golden fixtures including tags', () => {
        expect(Buffer.from(tlv35(0x89abcdef)).toString('hex')).toBe('0035000489abcdef');
        expect(
            Buffer.from(
                tlv1d({
                    field0a: 0xa1,
                    field0c: 0x01020304,
                    field10: 0xa0b0c0d0,
                    values: [0x11223344, 0xdeadbeef],
                }),
            ).toString('hex'),
        ).toBe('001d0012a101020304a0b0c0d00211223344deadbeef');
    });

    it('encodes a hand-assembled 0x16 with distinct binary fields', () => {
        const input = {
            field0c: 0x01020304,
            field10: 0x11223344,
            field14: 0xaabbccdd,
            vector: Uint8Array.from({ length: 16 }, (_, i) => i),
            field30: Uint8Array.of(0, 0xff),
            field48: new Uint8Array(),
            field60: Uint8Array.of(0x51, 0, 0x52),
        };
        const result = tlv16(input);
        expect(Buffer.from(result).toString('hex')).toBe(
            '001600270102030411223344aabbccdd000102030405060708090a0b0c0d0e0f000200ff00000003510052',
        );
        expect(input.vector).toEqual(Uint8Array.from({ length: 16 }, (_, i) => i));
        expect(input.field30).toEqual(Uint8Array.of(0, 0xff));
        result[34] = 0xff;
        expect(input.field30).toEqual(Uint8Array.of(0, 0xff));
    });

    it('enforces 0x16 value size, 16-byte vector and independent overlapping snapshots', () => {
        const source = Uint8Array.of(8, 9, 10, 11);
        const vector = new Uint8Array(16).fill(0x77);
        const input = {
            field0c: 0,
            field10: 0xffffffff,
            field14: 1,
            vector,
            field30: source.subarray(0, 3),
            field48: source.subarray(1, 4),
            field60: source.subarray(0, 3),
        };
        const result = tlv16(input);
        expect(Buffer.from(result.subarray(32)).toString('hex')).toBe(
            '000308090a0003090a0b000308090a',
        );
        expect(source).toEqual(Uint8Array.of(8, 9, 10, 11));
        source[0] = 0;
        expect(result[34]).toBe(8);
        const max = new Uint8Array(65501).fill(0xa5);
        const largest = tlv16({
            ...input,
            field30: max,
            field48: new Uint8Array(),
            field60: new Uint8Array(),
        });
        expect(largest.length).toBe(65539);
        expect(Buffer.from(largest).readUInt16BE(2)).toBe(65535);
        expect(max[0]).toBe(0xa5);
        expect(() =>
            tlv16({ ...input, field30: max, field48: Uint8Array.of(1), field60: new Uint8Array() }),
        ).toThrow(error);

        for (const length of [0, 15, 17]) {
            expect(() => tlv16({ ...input, vector: new Uint8Array(length) })).toThrow(error);
        }

        expect(
            Buffer.from(
                tlv16({
                    ...input,
                    vector,
                    field30: new Uint8Array(),
                    field48: new Uint8Array(),
                    field60: new Uint8Array(),
                }),
            ).readUInt16BE(2),
        ).toBe(34);
    });

    it('rejects 0x16 input accessors, proxies, shared or invalid byte views', () => {
        const empty = new Uint8Array();
        const input = {
            field0c: 0,
            field10: 1,
            field14: 2,
            vector: new Uint8Array(16),
            field30: empty,
            field48: empty,
            field60: empty,
        };
        let calls = 0;

        const fail = () => {
            calls++;
            throw new Error('secret');
        };

        const getter = { ...input };
        Object.defineProperty(getter, 'field60', { get: fail });
        expect(() => tlv16(getter)).toThrow(error);
        expect(() => tlv16(new Proxy(input, { get: fail, getPrototypeOf: fail }))).toThrow(error);
        const detached = Uint8Array.of(1);
        structuredClone(detached, { transfer: [detached.buffer] });
        const rab = new ArrayBuffer(2, { maxByteLength: 4 });
        const outOfBounds = new Uint8Array(rab, 1, 1);
        rab.resize(0);

        for (const bad of [
            new Uint8Array(new SharedArrayBuffer(1)),
            detached,
            outOfBounds,
            new Proxy(Uint8Array.of(1), { get: fail, getPrototypeOf: fail }),
            new Uint16Array(1),
        ]) {
            expect(() => tlv16({ ...input, field48: bad as Uint8Array })).toThrow(error);
        }

        const foreign = runInNewContext('new Uint8Array([7,0,255,8]).subarray(1,3)') as Uint8Array;
        expect(
            Buffer.from(tlv16({ ...input, field48: foreign }).subarray(32)).toString('hex'),
        ).toBe('0000000200ff0000');
        expect(calls).toBe(0);
    });

    it('clears all 0x16 snapshots and partial output independently on late failure', async () => {
        vi.resetModules();
        const originalSet = Uint8Array.prototype.set;
        const originalFill = Uint8Array.prototype.fill;
        const cleaned: Uint8Array[] = [];
        const vector = new Uint8Array(16).fill(3);
        const source = Uint8Array.of(7);
        let copies = 0;
        vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            offset,
        ) {
            originalSet.call(this, source, offset);

            if (++copies === 7) {
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
        const isolated = await import('../../src/direct/target-qr31-tlv');
        let thrown: unknown;

        try {
            isolated.encodeTargetQr31Tlv16({
                field0c: 0,
                field10: 1,
                field14: 2,
                vector,
                field30: source,
                field48: source,
                field60: source,
            });
        } catch (caught) {
            thrown = caught;
        }

        vi.restoreAllMocks();
        expect((thrown as Error).message).toBe(error);
        expect(cleaned).toHaveLength(5);

        for (const bytes of cleaned.slice(1)) {
            expect(bytes.every((b) => b === 0)).toBe(true);
        }

        expect(vector).toEqual(new Uint8Array(16).fill(3));
        expect(source).toEqual(Uint8Array.of(7));
    });

    it('encodes 0x11 empty and binary spans with a strict local u16 limit', () => {
        expect(Buffer.from(tlv11(new Uint8Array())).toString('hex')).toBe('00110000');
        const input = Uint8Array.of(0, 255, 1, 0);
        const output = tlv11(input);
        expect(Buffer.from(output).toString('hex')).toBe('0011000400ff0100');
        expect(output.buffer).not.toBe(input.buffer);
        input[1] = 2;
        expect(output[5]).toBe(255);
        output[4] = 9;
        expect(input[0]).toBe(0);
        const max = new Uint8Array(65535).fill(0xa5);
        const result = Buffer.from(tlv11(max));
        expect(result.length).toBe(65539);
        expect(result.subarray(0, 4).toString('hex')).toBe('0011ffff');
        expect(result[result.length - 1]).toBe(0xa5);
        expect(max[0]).toBe(0xa5);
        expect(() => tlv11(new Uint8Array(65536))).toThrow(error);
        expect(() => tlv11(new Uint8Array(new SharedArrayBuffer(1)))).toThrow(error);
        const foreign = runInNewContext(
            'new Uint8Array([9,0,255,1,9]).subarray(1,4)',
        ) as Uint8Array;
        expect(Buffer.from(tlv11(foreign)).toString('hex')).toBe('0011000300ff01');
    });

    it('encodes the opaque 0x66 and 0x33 child fixtures independently', () => {
        expect(Buffer.from(tlv66(0x12345678)).toString('hex')).toBe('0066000412345678');
        expect(Buffer.from(tlv66(0xffffffff)).toString('hex')).toBe('00660004ffffffff');

        for (const invalid of [-1, 0x100000000, 0.5, NaN, Infinity, '1']) {
            expect(() => tlv66(invalid as number)).toThrow(error);
        }

        const backing = Buffer.from('aa00112233445566778899aabbccddeeffbb', 'hex');
        const input = backing.subarray(1, 17);
        const output = tlv33(input);
        expect(Buffer.from(output).toString('hex')).toBe(
            '0033001000112233445566778899aabbccddeeff',
        );
        expect(output.buffer).not.toBe(input.buffer);
        input[0] = 0xfe;
        expect(output[4]).toBe(0);
        output[5] = 0xff;
        expect(input[1]).toBe(0x11);
        const foreign = runInNewContext(
            'new Uint8Array([9,...Array.from({length:16}, (_,i)=>i),9]).subarray(1,17)',
        ) as Uint8Array;
        expect(Buffer.from(tlv33(foreign)).toString('hex')).toBe(
            '00330010000102030405060708090a0b0c0d0e0f',
        );
    });

    it('rejects 0x33 wrong sizes, proxy, shared and invalid views', () => {
        let calls = 0;

        const bad = () => {
            calls++;
            throw new Error('secret');
        };

        const detached = new Uint8Array(16);
        structuredClone(detached, { transfer: [detached.buffer] });
        const rab = new ArrayBuffer(16, { maxByteLength: 32 });
        const outOfBounds = new Uint8Array(rab, 0, 16);
        rab.resize(0);

        for (const value of [
            new Uint8Array(),
            new Uint8Array(15),
            new Uint8Array(17),
            new Uint8Array(new SharedArrayBuffer(16)),
            detached,
            outOfBounds,
            new Proxy(new Uint8Array(16), { get: bad, getPrototypeOf: bad }),
            new Uint16Array(16),
        ]) {
            expect(() => tlv33(value as Uint8Array)).toThrow(error);
        }

        expect(calls).toBe(0);
    });

    it('encodes the hand-assembled 0x1b golden fixture including its nested length', () => {
        const x = Uint8Array.of(0xfe, 0x00, 0xff);
        const result = tlv1b({ words, x });
        expect(Buffer.from(result).toString('hex')).toBe(
            '001b0021' + '01020304112233445566778890abcdeffedcba9876543210aabbccdd' + '0003fe00ff',
        );
        expect(x).toEqual(Uint8Array.of(0xfe, 0, 0xff));
    });

    it('encodes endpoint count 0 and 255 with exact BE16 body lengths', () => {
        const empty = tlv1d({ field0a: 0, field0c: 0, field10: 0, values: [] });
        expect(Buffer.from(empty).toString('hex')).toBe('001d000a00000000000000000000');
        const input = Array.from({ length: 255 }, (_, index) =>
            index === 254 ? 0xffffffff : index,
        );
        const result = Buffer.from(
            tlv1d({ field0a: 0xff, field0c: 0xffffffff, field10: 0, values: input }),
        );
        expect(result.length).toBe(1034);
        expect(result.readUInt16BE(0)).toBe(0x1d);
        expect(result.readUInt16BE(2)).toBe(1030);
        expect(result[13]).toBe(255);
        expect(result.readUInt32BE(14)).toBe(0);
        expect(result.readUInt32BE(14 + 254 * 4)).toBe(0xffffffff);
        expect(input[254]).toBe(0xffffffff);
    });

    it('handles seven minimum/maximum words and empty or largest X', () => {
        for (const n of [0, 0xffffffff]) {
            const result = Buffer.from(tlv1b({ words: Array(7).fill(n), x: new Uint8Array() }));
            expect(result.length).toBe(34);
            expect(result.readUInt16BE(0)).toBe(0x1b);
            expect(result.readUInt16BE(2)).toBe(30);
            expect(result.readUInt16BE(32)).toBe(0);

            for (let i = 0; i < 7; i++) {
                expect(result.readUInt32BE(4 + 4 * i)).toBe(n);
            }
        }

        const x = new Uint8Array(65505).fill(0xa5);
        const result = tlv1b({ words, x });
        expect(result.length).toBe(65539);
        const wire = Buffer.from(result);
        expect(wire.readUInt16BE(2)).toBe(65535);
        expect(wire.readUInt16BE(32)).toBe(65505);
        expect(wire[wire.length - 1]).toBe(0xa5);
        expect(() => tlv1b({ words, x: new Uint8Array(65506) })).toThrow(error);
    });

    it('preserves subview and foreign inputs while returning independent output', () => {
        const x = runInNewContext('new Uint8Array([9, 1, 2, 3, 8]).subarray(1,4)') as Uint8Array;
        const foreignWords = runInNewContext('[1,2,3,4,5,6,7]') as number[];
        const field = runInNewContext(
            '({field0a:1,field0c:2,field10:3,values:[4,5]})',
        ) as Parameters<typeof tlv1d>[0];
        expect(Buffer.from(tlv1d(field)).toString('hex')).toBe(
            '001d0012010000000200000003020000000400000005',
        );
        const result = tlv1b({ words: foreignWords, x });
        expect(result.buffer).not.toBe(x.buffer);
        expect(Array.from(x)).toEqual([1, 2, 3]);
        x[0] = 9;
        expect(result[34]).toBe(1);
        result[35] = 7;
        expect(x[1]).toBe(2);
        expect(foreignWords).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it('rejects numbers with non-exact types, ranges and wrong list lengths', () => {
        for (const invalid of [-1, 0x100000000, 1.5, NaN, Infinity, '1', null, undefined]) {
            expect(() => tlv35(invalid as number)).toThrow(error);
            expect(() =>
                tlv1d({ field0a: 0, field0c: invalid as number, field10: 0, values: [] }),
            ).toThrow(error);
            expect(() =>
                tlv1d({ field0a: 0, field0c: 0, field10: 0, values: [invalid as number] }),
            ).toThrow(error);
        }

        for (const value of [-1, 256, 0.1, NaN]) {
            expect(() => tlv1d({ field0a: value, field0c: 0, field10: 0, values: [] })).toThrow(
                error,
            );
        }

        expect(() =>
            tlv1d({ field0a: 0, field0c: 0, field10: 0, values: Array(256).fill(0) }),
        ).toThrow(error);

        for (const bad of [[], Array(6).fill(0), Array(8).fill(0), [0, 0, 0, 0, 0, 0, -1]]) {
            expect(() => tlv1b({ words: bad, x: new Uint8Array() })).toThrow(error);
        }
    });

    it('rejects sparse, accessor and proxy records, arrays and proxy prototype chains', () => {
        let calls = 0;

        const fail = () => {
            calls++;
            throw new Error('secret');
        };

        const fields = { field0a: 1, field0c: 2, field10: 3, values: [4] };
        const accessor = { ...fields };
        Object.defineProperty(accessor, 'field0c', { get: fail });
        const list = [4];
        Object.defineProperty(list, '0', { get: fail });
        const chain = [4];
        Object.setPrototypeOf(
            chain,
            new Proxy(Array.prototype, { getPrototypeOf: fail, get: fail }),
        );
        const recordProto = Object.create(
            new Proxy(Object.prototype, { getPrototypeOf: fail }),
        ) as typeof fields;
        Object.assign(recordProto, fields);

        for (const bad of [
            new Proxy(fields, { get: fail, getPrototypeOf: fail }),
            accessor,
            recordProto,
        ]) {
            expect(() => tlv1d(bad)).toThrow(error);
        }

        for (const bad of [
            new Array(1),
            list,
            chain,
            new Proxy([4], { get: fail, getPrototypeOf: fail }),
        ]) {
            expect(() => tlv1d({ ...fields, values: bad })).toThrow(error);
        }

        expect(calls).toBe(0);
    });

    it('ignores byte-view shadow getters and rejects bad buffer ownership', () => {
        let calls = 0;

        const bad = () => {
            calls++;
            throw new Error('secret');
        };

        const input = Uint8Array.of(1, 2, 3);

        for (const property of [
            'buffer',
            'byteLength',
            'byteOffset',
            'length',
            Symbol.toStringTag,
            Symbol.iterator,
        ]) {
            Object.defineProperty(input, property, { get: bad });
        }

        expect(Buffer.from(tlv1b({ words, x: input })).subarray(34)).toEqual(Buffer.of(1, 2, 3));
        const prototypeProxy = Uint8Array.of(1);
        Object.setPrototypeOf(
            prototypeProxy,
            new Proxy(Uint8Array.prototype, { get: bad, getPrototypeOf: bad }),
        );
        const detached = Uint8Array.of(1);
        structuredClone(detached, { transfer: [detached.buffer] });
        const rab = new ArrayBuffer(2, { maxByteLength: 4 });
        const outOfBounds = new Uint8Array(rab, 1, 1);
        rab.resize(0);
        const foreignShared = runInNewContext(
            'new Uint8Array(new SharedArrayBuffer(1))',
        ) as Uint8Array;

        for (const value of [
            new Proxy(Uint8Array.of(1), { get: bad }),
            prototypeProxy,
            detached,
            outOfBounds,
            new Uint8Array(new SharedArrayBuffer(1)),
            foreignShared,
            new Uint16Array(1),
            new DataView(new ArrayBuffer(1)),
            null,
        ]) {
            expect(() => tlv1b({ words, x: value as Uint8Array })).toThrow(error);
        }

        expect(calls).toBe(0);
    });

    it('cleans output independently after late failure even if snapshot cleanup throws', async () => {
        vi.resetModules();
        const originalSet = Uint8Array.prototype.set;
        const originalFill = Uint8Array.prototype.fill;
        const cleaned: Uint8Array[] = [];
        let copies = 0;
        vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            offset,
        ) {
            originalSet.call(this, source, offset);

            if (++copies === 2) {
                throw new Error('secret payload');
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
        const isolated = await import('../../src/direct/target-qr31-tlv');
        const input = Uint8Array.of(1, 2, 3);
        let thrown: unknown;

        try {
            isolated.encodeTargetQr31Tlv1b({ words, x: input });
        } catch (caught) {
            thrown = caught;
        }

        vi.restoreAllMocks();
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe(error);
        expect(cleaned).toHaveLength(2);
        expect(cleaned[1]).toEqual(new Uint8Array(37));
        expect(input).toEqual(Uint8Array.of(1, 2, 3));
    });

    it('does not use a replacement global byte constructor after module load', () => {
        const source = Uint8Array.of(1, 2);
        const hostile = vi.fn(function () {
            return source;
        });
        vi.stubGlobal('Uint8Array', hostile);
        let output: Uint8Array;

        try {
            output = tlv1b({ words, x: source });
        } finally {
            vi.unstubAllGlobals();
        }

        expect(hostile).not.toHaveBeenCalled();
        expect(source).toEqual(Uint8Array.of(1, 2));
        expect(Array.from(output.subarray(34))).toEqual([1, 2]);
    });
});
