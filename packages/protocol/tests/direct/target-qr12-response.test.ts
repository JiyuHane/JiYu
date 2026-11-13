import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    extractTargetQr12Response,
    MAX_TARGET_QR12_RESPONSE_BYTES,
    MAX_TARGET_QR12_RESPONSE_ENTRIES,
} from '../../src/direct/target-qr12-response';

// Hand-assembled synthetic data, not target traffic.
const zero = Buffer.from('000001020304008000000000000001ffffffff0000', 'hex');
const nonzero = Buffer.from(
    '0003410042112233447ffedcba987654321089abcdef000277770002abcd77770000',
    'hex',
);
const failure = 'target QR12 response extraction failed';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('strict local target QR12 response structure extraction', () => {
    it('reads the hand-assembled status zero fixture with lossless high-bit BE64', () => {
        expect(extractTargetQr12Response(zero)).toEqual({
            first: { raw: new Uint8Array(), nativeProjection: { kind: 'unchanged' } },
            word1Bits: 0x01020304,
            statusByte: 0,
            word2Bits: 0x8000000000000001n,
            word3Bits: 0xffffffff,
            declaredCount: 0,
            entries: [],
            consumed: 21,
        });
    });

    it('preserves nonzero status, embedded NUL, duplicate unknown tags and empty values', () => {
        expect(extractTargetQr12Response(nonzero)).toEqual({
            first: {
                raw: Uint8Array.of(0x41, 0, 0x42),
                nativeProjection: { kind: 'assigned', bytes: Uint8Array.of(0x41) },
            },
            word1Bits: 0x11223344,
            statusByte: 0x7f,
            word2Bits: 0xfedcba9876543210n,
            word3Bits: 0x89abcdef,
            declaredCount: 2,
            entries: [
                { tag: 0x7777, value: Uint8Array.of(0xab, 0xcd) },
                { tag: 0x7777, value: new Uint8Array() },
            ],
            consumed: nonzero.length,
        });
    });

    it('distinguishes assigned empty from unchanged when the first byte is NUL', () => {
        const input = Buffer.from('00010001020304ff8000000000000001ffffffff0000', 'hex');
        const parsed = extractTargetQr12Response(input);
        expect(parsed.first).toEqual({
            raw: Uint8Array.of(0),
            nativeProjection: { kind: 'assigned', bytes: new Uint8Array() },
        });
        expect(parsed.statusByte).toBe(255);
        expect(parsed.word2Bits).toBe(0x8000000000000001n);
    });

    it('strictly rejects every truncation on both statuses and trailing bytes', () => {
        for (const fixture of [zero, nonzero]) {
            for (let i = 0; i < fixture.length; i++) {
                expect(() => extractTargetQr12Response(fixture.subarray(0, i))).toThrow(failure);
            }

            for (const extra of [0, 3, 255]) {
                expect(() =>
                    extractTargetQr12Response(Buffer.concat([fixture, Buffer.of(extra)])),
                ).toThrow(failure);
            }
        }
    });

    it('rejects length and count mismatch, even if backing bytes exist outside the view', () => {
        const shortView = nonzero.subarray(0, nonzero.length - 1);
        Object.defineProperty(shortView, 'byteLength', { get: () => nonzero.length });
        expect(() => extractTargetQr12Response(shortView)).toThrow(failure);
        const tooMany = Buffer.from(nonzero);
        tooMany.writeUInt16BE(3, 22);
        expect(() => extractTargetQr12Response(tooMany)).toThrow(failure);
        const tooLong = Buffer.from(nonzero);
        tooLong.writeUInt16BE(3, 26);
        expect(() => extractTargetQr12Response(tooLong)).toThrow(failure);
        const badFirst = Buffer.from(zero);
        badFirst.writeUInt16BE(0xffff, 0);
        expect(() => extractTargetQr12Response(badFirst)).toThrow(failure);
    });

    it('enforces count limit and the available-header lower bound', () => {
        const count = MAX_TARGET_QR12_RESPONSE_ENTRIES;
        const frame = new Uint8Array(21 + (count + 1) * 4);
        const view = new DataView(frame.buffer);
        view.setUint16(19, count);
        expect(extractTargetQr12Response(frame.subarray(0, 21 + count * 4)).entries).toHaveLength(
            count,
        );
        view.setUint16(19, count + 1);
        expect(() => extractTargetQr12Response(frame)).toThrow(failure);
        view.setUint16(19, 0xffff);
        expect(() => extractTargetQr12Response(frame.subarray(0, 21))).toThrow(failure);
    });

    it('accepts exact local byte cap with maximum-length TLVs and rejects cap plus one', () => {
        const cap = MAX_TARGET_QR12_RESPONSE_BYTES;
        const frame = new Uint8Array(cap);
        const view = new DataView(frame.buffer);
        view.setUint16(19, 256);
        let cursor = 21;

        for (let i = 0; i < 255; i++) {
            view.setUint16(cursor, i);
            view.setUint16(cursor + 2, 0xffff);
            cursor += 4 + 0xffff;
        }

        view.setUint16(cursor, 0xffff);
        view.setUint16(cursor + 2, cap - cursor - 4);
        const parsed = extractTargetQr12Response(frame);
        expect(parsed.consumed).toBe(cap);
        expect(parsed.entries).toHaveLength(256);
        expect(parsed.entries[0].value.length).toBe(0xffff);
        expect(parsed.entries[255].value.length).toBe(cap - cursor - 4);
        expect(() => extractTargetQr12Response(new Uint8Array(cap + 1))).toThrow(failure);
    });

    it('copies a Buffer subview, with all outputs independent of each other and input', () => {
        const backing = Buffer.concat([Buffer.of(9), nonzero, Buffer.of(8)]);
        const input = backing.subarray(1, -1);
        const before = Buffer.from(backing);
        const result = extractTargetQr12Response(input);
        expect(backing).toEqual(before);

        if (result.first.nativeProjection.kind !== 'assigned') {
            throw new Error('unexpected branch');
        }

        expect(
            new Set([
                result.first.raw.buffer,
                result.first.nativeProjection.bytes.buffer,
                ...result.entries.map((entry) => entry.value.buffer),
            ]).size,
        ).toBe(4);
        result.entries[0].value[0] = 0;
        result.first.raw[0] = 0;
        expect(backing).toEqual(before);
        expect(result.first.nativeProjection.bytes).toEqual(Uint8Array.of(0x41));
        backing.fill(0);
        expect(result.entries[0].value[1]).toBe(0xcd);
        expect(result.first.raw[2]).toBe(0x42);
        const foreign = runInNewContext(`new Uint8Array([${[...zero].join(',')}])`) as Uint8Array;
        expect(extractTargetQr12Response(foreign).word2Bits).toBe(0x8000000000000001n);
    });

    it('ignores shadow accessors and rejects proxies, SAB, detached and stale views', () => {
        let calls = 0;

        const fail = () => {
            calls++;
            throw new Error('SECRET');
        };

        const input = Uint8Array.from(nonzero);

        for (const key of [
            'length',
            'byteLength',
            'byteOffset',
            'buffer',
            Symbol.iterator,
            Symbol.toStringTag,
        ]) {
            Object.defineProperty(input, key, { get: fail });
        }

        expect(extractTargetQr12Response(input).consumed).toBe(nonzero.length);
        const prototypeProxy = Uint8Array.from(zero);
        Object.setPrototypeOf(
            prototypeProxy,
            new Proxy(Uint8Array.prototype, { get: fail, getPrototypeOf: fail }),
        );
        const proxy = new Proxy(Uint8Array.from(zero), { get: fail, getPrototypeOf: fail });
        const revoked = Proxy.revocable(Uint8Array.from(zero), {});
        revoked.revoke();
        const detached = Uint8Array.from(zero);
        structuredClone(detached, { transfer: [detached.buffer] });
        const buffer = new ArrayBuffer(32, { maxByteLength: 64 });
        const stale = new Uint8Array(buffer, 8, 21);
        buffer.resize(8);
        const shared = runInNewContext('new Uint8Array(new SharedArrayBuffer(21))') as Uint8Array;
        const fake = Object.defineProperty({}, 'byteLength', { get: fail });

        for (const bad of [
            prototypeProxy,
            proxy,
            revoked.proxy,
            detached,
            stale,
            shared,
            new Uint8Array(new SharedArrayBuffer(21)),
            new Uint16Array(21),
            new DataView(new ArrayBuffer(21)),
            fake,
            null,
            undefined,
        ]) {
            expect(() => extractTargetQr12Response(bad as never)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it('independently clears snapshot and partial outputs after a late failure', async () => {
        vi.resetModules();
        const originalSet = Uint8Array.prototype.set;
        const originalFill = Uint8Array.prototype.fill;
        const cleared: Uint8Array[] = [];
        let count = 0;
        vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            offset,
        ) {
            originalSet.call(this, source, offset);

            if (++count === 4) {
                throw new Error('SECRET');
            }
        });
        vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value,
            start,
            end,
        ) {
            cleared.push(this);

            if (cleared.length === 1) {
                throw new Error('SECRET');
            }

            return originalFill.call(this, value, start, end);
        });
        const isolated = await import('../../src/direct/target-qr12-response');
        const before = Buffer.from(nonzero);
        let thrown: unknown;

        try {
            isolated.extractTargetQr12Response(nonzero);
        } catch (caught) {
            thrown = caught;
        }

        vi.restoreAllMocks();
        expect((thrown as Error).message).toBe(failure);
        expect(cleared).toHaveLength(4);
        expect(cleared[1]).toEqual(new Uint8Array(3));
        expect(cleared[2]).toEqual(new Uint8Array(1));
        expect(cleared[3]).toEqual(new Uint8Array(2));
        expect(nonzero).toEqual(before);
    });
});
