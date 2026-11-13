import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
    encodeTargetQr31ChannelWrapper as encode,
    MAX_TARGET_QR31_CHANNEL_INNER_BYTES as max,
    type TargetQr31ChannelWrapper,
} from '../../src/direct/target-qr31-channel-wrapper';
import { encodeTargetQr31Frame } from '../../src/direct/target-qr31-frame';

const failure = 'target QR31 channel wrapper construction failed';
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const input = (): TargetQr31ChannelWrapper => ({
    inner: Uint8Array.of(0xaa, 0xbb, 0xcc),
    fieldEsi: 0x12345678,
    fieldEcx: 0x89abcdef,
});

describe('selected QR31 caller local channel wrapper', () => {
    it('matches independently grouped synthetic bytes and distinct u32s', () => {
        const value = input();
        const result = encode(value);
        expect(hex(result)).toBe(
            '00' + '0007' + '12345678' + '00000072' + '0000' + '00' + '89abcdef' + 'aabbcc',
        );
        expect(result.length).toBe(21);
        expect(new DataView(result.buffer).getUint16(1)).toBe(7); // inner + 4, not 21
        expect(value.inner).toEqual(Uint8Array.of(0xaa, 0xbb, 0xcc));
        value.inner.fill(0);
        expect(hex(result.subarray(18))).toBe('aabbcc');
    });

    it('encodes empty bytes and full unsigned endpoint values', () => {
        expect(hex(encode({ inner: new Uint8Array(), fieldEsi: 0, fieldEcx: 0xffffffff }))).toBe(
            '00' + '0004' + '00000000' + '00000072' + '0000' + '00' + 'ffffffff',
        );
        expect(hex(encode({ inner: new Uint8Array(), fieldEsi: 0xffffffff, fieldEcx: 0 }))).toBe(
            '00' + '0004' + 'ffffffff' + '00000072' + '0000' + '00' + '00000000',
        );
    });

    it.each(['fieldEsi', 'fieldEcx'] as const)('rejects invalid %s without coercion', (name) => {
        let calls = 0;

        for (const bad of [
            -1,
            0x100000000,
            0.5,
            NaN,
            Infinity,
            '1',
            1n,
            {
                valueOf() {
                    calls++;
                    return 1;
                },
            },
        ]) {
            const value = input();
            Object.assign(value, { [name]: bad });
            expect(() => encode(value)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it('accepts maximum inner length, rejects one more and preserves input', () => {
        const inner = new Uint8Array(max);
        inner[0] = 0xaa;
        inner[max - 1] = 0xbb;
        const result = encode({ inner, fieldEsi: 7, fieldEcx: 8 });
        expect(result.length).toBe(18 + max);
        expect(new DataView(result.buffer).getUint16(1)).toBe(65535);
        expect(result[18]).toBe(0xaa);
        expect(result[result.length - 1]).toBe(0xbb);
        expect(inner[0]).toBe(0xaa);
        expect(inner[inner.length - 1]).toBe(0xbb);
        expect(() => encode({ inner: new Uint8Array(max + 1), fieldEsi: 7, fieldEcx: 8 })).toThrow(
            failure,
        );
    });

    it('accepts foreign and Buffer subviews without reading shadow properties', () => {
        let calls = 0;
        const foreign = runInNewContext(
            'new Uint8Array([9,170,187,204,8]).subarray(1,4)',
        ) as Uint8Array;

        for (const name of [
            'length',
            'buffer',
            'byteLength',
            'byteOffset',
            Symbol.iterator,
            Symbol.toStringTag,
        ]) {
            Object.defineProperty(foreign, name, {
                get() {
                    calls++;
                    throw new Error('unexpected');
                },
            });
        }

        expect(hex(encode({ ...input(), inner: foreign }).subarray(18))).toBe('aabbcc');
        const backing = Buffer.from([9, 0xaa, 0xbb, 0xcc, 8]);
        const out = encode({ ...input(), inner: backing.subarray(1, 4) });
        expect(backing).toEqual(Buffer.from([9, 0xaa, 0xbb, 0xcc, 8]));
        backing.fill(0);
        expect(hex(out.subarray(18))).toBe('aabbcc');
        expect(calls).toBe(0);
    });

    it('rejects accessor records, proxy records/views and invalid backing without traps', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('fixture');
        };

        const proxies = new Proxy(input(), { get: trap, ownKeys: trap, getPrototypeOf: trap });
        const extra = input();
        Object.defineProperty(extra, 'extra', { get: trap });
        const getter = input();
        Object.defineProperty(getter, 'fieldEsi', { get: trap });
        const badPrototype = Uint8Array.of(1);
        Object.setPrototypeOf(
            badPrototype,
            new Proxy(Uint8Array.prototype, { getPrototypeOf: trap }),
        );
        const detached = Uint8Array.of(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const backing = new ArrayBuffer(8, { maxByteLength: 16 });
        const oob = new Uint8Array(backing, 4, 4);
        backing.resize(4);
        const inner = [
            new Proxy(Uint8Array.of(1), { get: trap, getPrototypeOf: trap }),
            badPrototype,
            detached,
            oob,
            new Uint8Array(new SharedArrayBuffer(1)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(1))'),
            new Uint16Array(1),
            new DataView(new ArrayBuffer(1)),
            null,
        ];

        for (const record of [
            proxies,
            extra,
            getter,
            ...inner.map((bytes) => ({ ...input(), inner: bytes })),
        ]) {
            expect(() => encode(record as TargetQr31ChannelWrapper)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it('wraps the real local QR31 frame without treating it as authenticated or online', () => {
        const body = Uint8Array.of(0xa1, 0, 0xff, 2);
        const frame = encodeTargetQr31Frame(body);
        const before = frame.slice();
        const result = encode({ inner: frame, fieldEsi: 0x10203040, fieldEcx: 0x50607080 });
        expect(result.subarray(0, 18)).toEqual(
            Uint8Array.from(Buffer.from('000034102030400000007200000050607080', 'hex')),
        );
        expect(result.subarray(18)).toEqual(before);
        expect(new DataView(result.buffer).getUint16(1)).toBe(frame.length + 4);
        expect(frame).toEqual(before);
    });

    it('enforces the intersection of frame and wrapper local length limits', () => {
        // 44 bytes of frame overhead, then the wrapper requires inner + 4 <= 65535.
        const body = new Uint8Array(65487);
        body[0] = 0xa1;
        body[body.length - 1] = 0xb2;
        const original = body.slice();
        const frame = encodeTargetQr31Frame(body);
        const frameBefore = frame.slice();
        expect(frame.length).toBe(65531);
        const result = encode({ inner: frame, fieldEsi: 1, fieldEcx: 2 });
        expect(new DataView(result.buffer).getUint16(1)).toBe(65535);
        expect(Buffer.from(result.subarray(18)).equals(Buffer.from(frameBefore))).toBe(true);
        expect(Buffer.from(body).equals(Buffer.from(original))).toBe(true);
        expect(Buffer.from(frame).equals(Buffer.from(frameBefore))).toBe(true);

        const largerBody = new Uint8Array(65488);
        largerBody[0] = 0xc1;
        largerBody[largerBody.length - 1] = 0xd2;
        const largerBefore = largerBody.slice();
        const largerFrame = encodeTargetQr31Frame(largerBody);
        const largerFrameBefore = largerFrame.slice();
        expect(largerFrame.length).toBe(65532); // Valid for the frame alone.
        expect(() => encode({ inner: largerFrame, fieldEsi: 1, fieldEcx: 2 })).toThrow(failure);
        expect(Buffer.from(largerBody).equals(Buffer.from(largerBefore))).toBe(true);
        expect(Buffer.from(largerFrame).equals(Buffer.from(largerFrameBefore))).toBe(true);
    });

    it.each([false, true])(
        'attempts every private cleanup on output copy failure, wipeThrows=%s',
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

                if (copies.length === 2) {
                    throw new Error('synthetic copy');
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
                    throw new Error('synthetic wipe');
                }

                return originalFill.call(this, byte, start, end);
            });

            try {
                const module = await import('../../src/direct/target-qr31-channel-wrapper');
                expect(() => module.encodeTargetQr31ChannelWrapper(value)).toThrow(failure);
            } finally {
                setSpy.mockRestore();
                fillSpy.mockRestore();
            }

            expect(copies).toHaveLength(2);
            expect(wipes).toHaveLength(2);
            expect(wipes[0].every((byte) => byte === 0)).toBe(!wipeThrows);
            expect(wipes[1].every((byte) => byte === 0)).toBe(true);
            expect(value.inner).toEqual(Uint8Array.of(0xaa, 0xbb, 0xcc));
        },
    );
});
