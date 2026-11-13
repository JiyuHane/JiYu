import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
    encodeTargetWtEncodeData as encode,
    MAX_TARGET_WT_ENCODE_DATA_BYTES as cap,
    type TargetWtEncodeData,
} from '../../src/direct/target-wt-encode-data';

const failure = 'target WT encode-data construction failed';
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const local = Uint8Array.from({ length: 16 }, (_, i) => i);

function input(): TargetWtEncodeData {
    return {
        ctxMode: 1,
        ctx4: 0,
        ctx5: 1,
        field6: 0x7f,
        local16: Uint8Array.from(local),
        mode2Word: null,
        extra: Uint8Array.of(0xaa, 0),
        payload: Uint8Array.of(0xbb, 0xcc),
    };
}

describe('target WT precomputed-payload local wrapper', () => {
    it('writes hand-assembled mode 1 bytes including a NUL in extra', () => {
        const value = input();
        expect(hex(encode(value))).toBe(
            '017f' + '000102030405060708090a0b0c0d0e0f' + '0102' + '0002aa00' + 'bbcc',
        );
    });

    it('writes mode 2 words for both ctx4 conditions and a caller-provided null-case value', () => {
        const value = input();
        value.ctxMode = 2;
        value.mode2Word = 0x3344;
        expect(hex(encode(value))).toBe(
            '027f' + '000102030405060708090a0b0c0d0e0f' + '01313344' + '0002aa00' + 'bbcc',
        );
        value.ctx4 = 7;
        value.payload = new Uint8Array();
        expect(hex(encode(value))).toBe(
            '027f' + '000102030405060708090a0b0c0d0e0f' + '01323344' + '0002aa00',
        );
        value.mode2Word = 1;
        expect(hex(encode(value))).toBe(
            '027f' + '000102030405060708090a0b0c0d0e0f' + '01320001' + '0002aa00',
        );
    });

    it('handles other u32 modes without mode fields and ctx5=0 with explicit empty extra', () => {
        const value = input();
        value.ctxMode = 0xffffffff;
        value.ctx4 = 9;
        value.ctx5 = 0;
        value.extra = new Uint8Array();
        expect(hex(encode(value))).toBe(
            '017f' + '000102030405060708090a0b0c0d0e0f' + '0000' + 'bbcc',
        );
        value.ctxMode = 0;
        expect(hex(encode(value))).toBe(
            '017f' + '000102030405060708090a0b0c0d0e0f' + '0000' + 'bbcc',
        );
        value.ctxMode = 1;
        expect(hex(encode(value))).toBe(
            '017f' + '000102030405060708090a0b0c0d0e0f' + '0102' + '0000' + 'bbcc',
        );
    });

    it('rejects combinations that would silently discard extra, payload or a mode word', () => {
        const value = input();
        value.ctx5 = 0;
        expect(() => encode(value)).toThrow(failure);
        expect(value.extra).toEqual(Uint8Array.of(0xaa, 0));
        value.ctx5 = 1;
        value.ctx4 = 1;
        expect(() => encode(value)).toThrow(failure);
        expect(value.payload).toEqual(Uint8Array.of(0xbb, 0xcc));
        value.ctx4 = 0;
        value.mode2Word = 1;
        expect(() => encode(value)).toThrow(failure);
        value.ctxMode = 2;
        value.mode2Word = null;
        expect(() => encode(value)).toThrow(failure);
    });

    it.each(['ctx4', 'ctx5', 'field6'] as const)('validates %s as an explicit u8', (name) => {
        for (const number of [-1, 256, 1.5, NaN, Infinity, '1']) {
            const value = input();
            Object.assign(value, { [name]: number });
            expect(() => encode(value)).toThrow(failure);
        }
    });

    it('validates u32 mode, mode2 u16 and exact 16-byte local value', () => {
        for (const mode of [-1, 0x100000000, 0.1, Infinity, '2']) {
            const value = input();
            Object.assign(value, { ctxMode: mode });
            expect(() => encode(value)).toThrow(failure);
        }

        for (const word of [-1, 65536, 0.1, '1', null]) {
            const value = input();
            value.ctxMode = 2;
            Object.assign(value, { mode2Word: word });
            expect(() => encode(value)).toThrow(failure);
        }

        for (const size of [0, 15, 17]) {
            const value = input();
            value.local16 = new Uint8Array(size);
            expect(() => encode(value)).toThrow(failure);
        }

        const maxWord = input();
        maxWord.ctxMode = 2;
        maxWord.mode2Word = 65535;
        expect(hex(encode(maxWord).subarray(18, 22))).toBe('0131ffff');
    });

    it('enforces the full output and per-component caps without truncation', () => {
        const value = input();
        value.extra = new Uint8Array(cap - 22);
        value.payload = new Uint8Array();
        const result = encode(value);
        expect(result.length).toBe(cap);
        expect(new DataView(result.buffer).getUint16(20)).toBe(cap - 22);
        value.extra = new Uint8Array(cap - 21);
        expect(() => encode(value)).toThrow(failure);
        value.extra = new Uint8Array(65535);
        expect(() => encode(value)).toThrow(failure);
        value.extra = new Uint8Array(65536);
        expect(() => encode(value)).toThrow(failure);
        value.extra = new Uint8Array();
        value.payload = new Uint8Array(cap - 22);
        expect(encode(value).length).toBe(cap);
        value.payload = new Uint8Array(cap - 21);
        expect(() => encode(value)).toThrow(failure);
        value.payload = new Uint8Array(65536);
        expect(() => encode(value)).toThrow(failure);
    });

    it('copies foreign and Buffer subviews without reading shadow methods/getters', () => {
        const value = input();
        const backing = Buffer.from([9, 0xaa, 0, 8]);
        value.extra = backing.subarray(1, 3);
        value.payload = runInNewContext(
            'new Uint8Array([9,187,204,8]).subarray(1,3)',
        ) as Uint8Array;
        let calls = 0;

        for (const name of [
            'length',
            'byteLength',
            'byteOffset',
            'buffer',
            'set',
            Symbol.iterator,
            Symbol.toStringTag,
        ]) {
            Object.defineProperty(value.payload, name, {
                get() {
                    calls++;
                    throw new Error('fixture');
                },
            });
        }

        const result = encode(value);
        expect(calls).toBe(0);
        expect(backing).toEqual(Buffer.from([9, 0xaa, 0, 8]));
        backing.fill(0);
        value.local16.fill(0);
        expect(hex(result)).toBe(
            '017f' + '000102030405060708090a0b0c0d0e0f' + '0102' + '0002aa00' + 'bbcc',
        );
    });

    it('rejects proxies, accessors, shared, detached and out-of-bounds views without traps', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('fixture');
        };

        const proxied = new Proxy(input(), { ownKeys: trap, get: trap, getPrototypeOf: trap });
        const accessor = input();
        Object.defineProperty(accessor, 'ctx5', { get: trap });
        const detached = Uint8Array.of(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const backing = new ArrayBuffer(8, { maxByteLength: 16 });
        const oob = new Uint8Array(backing, 4, 4);
        backing.resize(4);
        const badProto = Uint8Array.of(1);
        Object.setPrototypeOf(badProto, new Proxy(Uint8Array.prototype, { getPrototypeOf: trap }));
        const values = [
            new Proxy(Uint8Array.of(1), { get: trap }),
            badProto,
            detached,
            oob,
            new Uint8Array(new SharedArrayBuffer(1)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(1))'),
            new Uint16Array(1),
            null,
        ];

        for (const value of [
            proxied,
            accessor,
            ...values.map((payload) => ({ ...input(), payload })),
        ]) {
            expect(() => encode(value as TargetWtEncodeData)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it.each([false, true])(
        'independently wipes all owned buffers on a late copy failure, wipeThrows=%s',
        async (wipeThrows) => {
            const value = input();
            const originalSet = Uint8Array.prototype.set;
            const originalFill = Uint8Array.prototype.fill;
            const copies: Uint8Array[] = [];
            const wipes: Uint8Array[] = [];
            vi.resetModules();
            const setSpy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
                this: Uint8Array,
                source: ArrayLike<number>,
                offset?: number,
            ) {
                copies.push(this);
                originalSet.call(this, source, offset);

                if (copies.length === 5) {
                    throw new Error('fixture');
                }
            });
            const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
                this: Uint8Array,
                byte: number,
                start?: number,
                end?: number,
            ) {
                wipes.push(this);

                if (wipeThrows && wipes.length === 1) {
                    throw new Error('fixture');
                }

                return originalFill.call(this, byte, start, end);
            });

            try {
                const module = await import('../../src/direct/target-wt-encode-data');
                expect(() => module.encodeTargetWtEncodeData(value)).toThrow(failure);
            } finally {
                setSpy.mockRestore();
                fillSpy.mockRestore();
            }

            expect(wipes).toHaveLength(4);
            expect(wipes[0].every((byte) => byte === 0)).toBe(!wipeThrows);
            expect(wipes.slice(1).every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
            expect(value.local16).toEqual(local);
            expect(value.extra).toEqual(Uint8Array.of(0xaa, 0));
        },
    );
});
