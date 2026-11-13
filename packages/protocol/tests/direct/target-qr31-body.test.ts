import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
    encodeTargetQr31Body,
    MAX_TARGET_QR31_BODY_BYTES,
    MAX_TARGET_QR31_CHILDREN,
    type TargetQr31Body,
} from '../../src/direct/target-qr31-body';

const failure = 'target QR31 body construction failed';
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function input(): TargetQr31Body {
    return {
        field38: Uint8Array.of(0xaa, 0xbb),
        field50: 0x12345678,
        field30: 0x0123456789abcdefn,
        field54: 0x9a,
        field58: Uint8Array.of(0x10, 0x20, 0x30),
        field80: 0x7788,
        children: [Uint8Array.of(0xde, 0xad), Uint8Array.of(0xbe, 0xef, 1)],
    };
}

describe('target-static partial 0x31 body skeleton', () => {
    it('matches a manually assembled big-endian fixture without framing children', () => {
        const value = input();
        expect(hex(encodeTargetQr31Body(value))).toBe(
            '0002aabb123456780123456789abcdef9a00031020307788deadbeef01',
        );
        expect(value.field80).not.toBe(value.children.length);
    });

    it('encodes empty fields, no children and independent field80', () => {
        const value: TargetQr31Body = {
            field38: new Uint8Array(),
            field50: 0,
            field30: 0n,
            field54: 0,
            field58: new Uint8Array(),
            field80: 0xffff,
            children: [],
        };
        expect(hex(encodeTargetQr31Body(value))).toBe('0000000000000000000000000000000000ffff');
        value.field80 = 0;
        value.children = [Uint8Array.of(0xff), new Uint8Array(), Uint8Array.of(0, 1)];
        expect(hex(encodeTargetQr31Body(value))).toBe(
            '00000000000000000000000000000000000000ff0001',
        );
    });

    it('retains maximum unsigned values and exact field bit patterns', () => {
        const value: TargetQr31Body = {
            field38: Uint8Array.of(0, 0xff),
            field50: 0xffffffff,
            field30: 0xffffffffffffffffn,
            field54: 255,
            field58: Uint8Array.of(0xff),
            field80: 65535,
            children: [],
        };
        expect(hex(encodeTargetQr31Body(value))).toBe(
            '0002' + '00ff' + 'ffffffff' + 'ffffffffffffffff' + 'ff' + '0001' + 'ff' + 'ffff',
        );
    });

    it.each([
        ['field50', -1],
        ['field50', 0x100000000],
        ['field50', 0.5],
        ['field50', NaN],
        ['field50', '1'],
        ['field54', -1],
        ['field54', 256],
        ['field54', Infinity],
        ['field80', -1],
        ['field80', 65536],
        ['field30', -1n],
        ['field30', 0x10000000000000000n],
        ['field30', 1],
        ['field30', '1'],
    ] as const)('rejects invalid numeric %s without coercion', (name, invalid) => {
        const value = input();
        Object.assign(value, { [name]: invalid });
        expect(() => encodeTargetQr31Body(value)).toThrow(failure);
    });

    it('accepts Buffer, subviews and cross-realm views and returns independent bytes', () => {
        const value = input();
        const backing = Buffer.from([0, 0xaa, 0xbb, 0]);
        value.field38 = backing.subarray(1, 3);
        value.field58 = runInNewContext(
            'new Uint8Array([0,16,32,48,0]).subarray(1,4)',
        ) as Uint8Array;
        const before = Buffer.from(backing);
        const output = encodeTargetQr31Body(value);
        expect(backing).toEqual(before);
        backing.fill(0);
        value.field58.fill(0);
        value.children[0].fill(0);
        expect(hex(output)).toBe('0002aabb123456780123456789abcdef9a00031020307788deadbeef01');
    });

    it('ignores shadow view methods/getters and caller iterators', () => {
        const value = input();
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
            Object.defineProperty(value.field38, name, {
                get() {
                    calls++;
                    throw new Error('fixture');
                },
            });
        }

        Object.defineProperty(value.children, Symbol.iterator, {
            value() {
                calls++;
                throw new Error('fixture');
            },
        });
        expect(hex(encodeTargetQr31Body(value))).toBe(
            '0002aabb123456780123456789abcdef9a00031020307788deadbeef01',
        );
        expect(calls).toBe(0);
    });

    it('rejects proxy records, arrays, byte views and accessors without invoking traps', () => {
        let calls = 0;
        const traps = {
            get() {
                calls++;
                throw new Error('fixture');
            },
            getPrototypeOf() {
                calls++;
                throw new Error('fixture');
            },
            ownKeys() {
                calls++;
                throw new Error('fixture');
            },
        };
        const records: unknown[] = [new Proxy(input(), traps)];
        const extra = input();
        Object.defineProperty(extra, 'extra', {
            get() {
                calls++;
                throw new Error('fixture');
            },
        });
        records.push(extra);
        const accessor = input();
        Object.defineProperty(accessor, 'field50', {
            get() {
                calls++;
                throw new Error('fixture');
            },
        });
        records.push(accessor);
        const arrayProxy = input();
        arrayProxy.children = new Proxy([...arrayProxy.children], traps);
        records.push(arrayProxy);
        const bytesProxy = input();
        bytesProxy.field38 = new Proxy(bytesProxy.field38, traps);
        records.push(bytesProxy);
        const hole = input();
        hole.children = new Array(1);
        records.push(hole);
        const arrayAccessor = input();
        const children = [Uint8Array.of(1)];
        Object.defineProperty(children, '0', {
            get() {
                calls++;
                throw new Error('fixture');
            },
        });
        arrayAccessor.children = children;
        records.push(arrayAccessor);
        const inheritedProxy = input();
        const bytes = Uint8Array.of(1);
        Object.setPrototypeOf(bytes, new Proxy(Uint8Array.prototype, traps));
        inheritedProxy.field58 = bytes;
        records.push(inheritedProxy);
        const revoked = Proxy.revocable(new Uint8Array(1), traps);
        revoked.revoke();
        const bad = input();
        bad.field58 = revoked.proxy;
        records.push(bad);

        for (const record of records) {
            expect(() => encodeTargetQr31Body(record as TargetQr31Body)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it('rejects shared, detached, out-of-bounds and invalid byte views', () => {
        const detached = Uint8Array.of(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const buffer = new ArrayBuffer(8, { maxByteLength: 16 });
        const outOfBounds = new Uint8Array(buffer, 4, 4);
        buffer.resize(4);
        const badViews = [
            new Uint8Array(new SharedArrayBuffer(1)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(1))'),
            detached,
            outOfBounds,
            new Uint16Array(1),
            new DataView(new ArrayBuffer(1)),
            null,
        ];

        for (const bad of badViews) {
            const value = input();
            value.field38 = bad as Uint8Array;
            expect(() => encodeTargetQr31Body(value)).toThrow(failure);
        }

        buffer.resize(8);
        const valid = input();
        valid.field58 = outOfBounds;
        expect(encodeTargetQr31Body(valid)).toBeInstanceOf(Uint8Array);
    });

    it('enforces component and child-count limits without truncation', () => {
        for (const name of ['field38', 'field58'] as const) {
            const value = input();
            value[name] = new Uint8Array(65535);
            expect(encodeTargetQr31Body(value).length).toBe(
                19 + 65535 + (name === 'field38' ? 3 : 2) + 5,
            );
            value[name] = new Uint8Array(65536);
            expect(() => encodeTargetQr31Body(value)).toThrow(failure);
        }

        const value = input();
        value.children = [new Uint8Array(65535)];
        expect(encodeTargetQr31Body(value).length).toBe(19 + 2 + 3 + 65535);
        value.children = [new Uint8Array(65536)];
        expect(() => encodeTargetQr31Body(value)).toThrow(failure);
        value.children = Array.from({ length: MAX_TARGET_QR31_CHILDREN }, () => new Uint8Array());
        expect(encodeTargetQr31Body(value).length).toBe(24);
        value.children = [...value.children, new Uint8Array()];
        expect(() => encodeTargetQr31Body(value)).toThrow(failure);
    });

    it('enforces aggregate byte cap independently of child count', () => {
        const value = input();
        value.field38 = new Uint8Array();
        value.field58 = new Uint8Array();
        const part = new Uint8Array(65535);
        value.children = [...Array.from({ length: 256 }, () => part), new Uint8Array(237)];
        expect(encodeTargetQr31Body(value).length).toBe(MAX_TARGET_QR31_BODY_BYTES);
        value.children = [...value.children, Uint8Array.of(1)];
        expect(() => encodeTargetQr31Body(value)).toThrow(failure);
    });

    it.each([false, true])(
        'wipes all independently owned buffers on copy failure, cleanupThrows=%s',
        async (cleanupThrows) => {
            const value = input();
            const originalSet = Uint8Array.prototype.set;
            const originalFill = Uint8Array.prototype.fill;
            const copies: Uint8Array[] = [];
            const wipes: Uint8Array[] = [];
            vi.resetModules();
            const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
                this: Uint8Array,
                value: number,
                start?: number,
                end?: number,
            ) {
                wipes.push(this);

                if (cleanupThrows && wipes.length === 1) {
                    throw new Error('cleanup fixture');
                }

                return originalFill.call(this, value, start, end);
            });
            const setSpy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
                this: Uint8Array,
                source: ArrayLike<number>,
                offset?: number,
            ) {
                copies.push(this);
                originalSet.call(this, source, offset);

                if (copies.length === 5) {
                    throw new Error('copy fixture');
                }
            });

            try {
                const module = await import('../../src/direct/target-qr31-body');
                expect(() => module.encodeTargetQr31Body(value)).toThrow(failure);
            } finally {
                setSpy.mockRestore();
                fillSpy.mockRestore();
            }

            expect(copies.length).toBe(5);
            expect(wipes.length).toBe(5);
            expect(wipes.slice(1).every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
            expect(wipes[0].every((byte) => byte === 0)).toBe(!cleanupThrows);
            expect(value.field38).toEqual(Uint8Array.of(0xaa, 0xbb));
        },
    );
});
