import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    extractTargetQr31Response,
    MAX_TARGET_QR31_RESPONSE_BYTES,
    MAX_TARGET_QR31_RESPONSE_ENTRIES,
} from '../../src/direct/target-qr31-response';

const error = 'target QR31 response extraction failed';
const emptyEntries = Buffer.from('0000010203040000000000', 'hex');
const entries = Buffer.from('000341004201020304020001ff000277770002abcd77770000', 'hex');
const other = Buffer.from('000001020304010000', 'hex');

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('target-static QR31 response local structural extraction', () => {
    it('extracts hand-assembled empty fields with unchanged target state', () => {
        expect(extractTargetQr31Response(emptyEntries)).toEqual({
            first: { raw: new Uint8Array(), nativeProjection: { kind: 'unchanged' } },
            wordBits: 0x01020304,
            statusByte: 0,
            kind: 'entries',
            rawSpan: new Uint8Array(),
            spanNativeWrite: false,
            declaredCount: 0,
            entries: [],
            consumed: 11,
        });
        expect(extractTargetQr31Response(other)).toEqual({
            first: { raw: new Uint8Array(), nativeProjection: { kind: 'unchanged' } },
            wordBits: 0x01020304,
            statusByte: 1,
            kind: 'other',
            field2: { raw: new Uint8Array(), nativeProjection: { kind: 'unchanged' } },
            consumed: 9,
        });
    });

    it('consumes the full NUL-containing field, retaining duplicate and unknown tags', () => {
        expect(extractTargetQr31Response(entries)).toEqual({
            first: {
                raw: Uint8Array.of(0x41, 0, 0x42),
                nativeProjection: { kind: 'assigned', bytes: Uint8Array.of(0x41) },
            },
            wordBits: 0x01020304,
            statusByte: 2,
            kind: 'entries',
            rawSpan: Uint8Array.of(0xff),
            spanNativeWrite: true,
            declaredCount: 2,
            entries: [
                { tag: 0x7777, value: Uint8Array.of(0xab, 0xcd) },
                { tag: 0x7777, value: new Uint8Array() },
            ],
            consumed: entries.length,
        });
    });

    it('distinguishes first-NUL assignment from zero-length unchanged for both fields', () => {
        const input = Buffer.from('000100fffffffffe0003004142', 'hex');
        const result = extractTargetQr31Response(input);
        expect(result.first).toEqual({
            raw: Uint8Array.of(0),
            nativeProjection: { kind: 'assigned', bytes: new Uint8Array() },
        });
        expect(result.wordBits).toBe(0xffffffff);
        expect(result.statusByte).toBe(0xfe);
        expect(result.kind).toBe('other');

        if (result.kind !== 'other') {
            throw new Error('unexpected branch');
        }

        expect(result.field2).toEqual({
            raw: Uint8Array.of(0, 0x41, 0x42),
            nativeProjection: { kind: 'assigned', bytes: new Uint8Array() },
        });
    });

    it('rejects every truncation and any trailing byte for each complete fixture', () => {
        for (const fixture of [emptyEntries, entries, other]) {
            for (let i = 0; i < fixture.length; i++) {
                expect(() => extractTargetQr31Response(fixture.subarray(0, i))).toThrow(error);
            }

            for (const extra of [0, 3, 255]) {
                expect(() =>
                    extractTargetQr31Response(Buffer.concat([fixture, Buffer.of(extra)])),
                ).toThrow(error);
            }
        }
    });

    it('rejects count and field lengths that exceed remaining bytes', () => {
        for (const fixture of [
            '0001010203040000000000',
            '0000010203040000010000',
            '0000010203040000000001',
            '000001020304000000000100010002ff',
            '000001020304010001',
        ]) {
            expect(() => extractTargetQr31Response(Buffer.from(fixture, 'hex'))).toThrow(error);
        }
    });

    it('enforces count policy after checking the available entry headers', () => {
        const count = MAX_TARGET_QR31_RESPONSE_ENTRIES;
        const frame = new Uint8Array(11 + (count + 1) * 4);
        const data = new DataView(frame.buffer);
        data.setUint8(6, 0);
        data.setUint16(9, count);
        expect(extractTargetQr31Response(frame.subarray(0, 11 + count * 4))).toMatchObject({
            kind: 'entries',
            declaredCount: count,
        });
        data.setUint16(9, count + 1);
        expect(() => extractTargetQr31Response(frame)).toThrow(error);
        data.setUint16(9, 0xffff);
        expect(() => extractTargetQr31Response(frame)).toThrow(error);
    });

    it('accepts the exact local byte cap and rejects one extra byte before snapshot', () => {
        const cap = MAX_TARGET_QR31_RESPONSE_BYTES;
        const frame = new Uint8Array(cap);
        const view = new DataView(frame.buffer);
        view.setUint16(9, 256);
        let cursor = 11;

        for (let i = 0; i < 255; i++) {
            view.setUint16(cursor, i);
            view.setUint16(cursor + 2, 0xffff);
            cursor += 4 + 0xffff;
        }

        view.setUint16(cursor, 0xffff);
        view.setUint16(cursor + 2, cap - cursor - 4);
        const result = extractTargetQr31Response(frame);
        expect(result.kind).toBe('entries');
        expect(result.consumed).toBe(cap);

        if (result.kind === 'entries') {
            expect(result.entries).toHaveLength(256);
            expect(result.entries[255].value.length).toBe(cap - cursor - 4);
        }

        expect(() => extractTargetQr31Response(new Uint8Array(cap + 1))).toThrow(error);
    });

    it('supports Buffer subviews and foreign arrays with independent output ownership', () => {
        const backing = Buffer.concat([Buffer.of(9), entries, Buffer.of(8)]);
        const input = backing.subarray(1, -1);
        const before = Buffer.from(backing);
        const result = extractTargetQr31Response(input);
        expect(backing).toEqual(before);
        expect(result.kind).toBe('entries');

        if (result.kind !== 'entries' || result.first.nativeProjection.kind !== 'assigned') {
            throw new Error('unexpected branch');
        }

        expect(
            new Set([
                result.first.raw.buffer,
                result.first.nativeProjection.bytes.buffer,
                result.rawSpan.buffer,
                ...result.entries.map((entry) => entry.value.buffer),
            ]).size,
        ).toBe(5);
        input.fill(0);
        expect(result.first.raw).toEqual(Uint8Array.of(0x41, 0, 0x42));
        result.first.raw[0] = 0;
        expect(result.first.nativeProjection.bytes).toEqual(Uint8Array.of(0x41));
        expect(result.entries[0].value).toEqual(Uint8Array.of(0xab, 0xcd));
        const foreign = runInNewContext('new Uint8Array([0,0,1,2,3,4,1,0,0])') as Uint8Array;
        expect(extractTargetQr31Response(foreign).consumed).toBe(9);
    });

    it('ignores shadow getters and rejects proxies, invalid backings and forged views', () => {
        let calls = 0;

        const fail = () => {
            calls++;
            throw new Error('SECRET');
        };

        const input = Uint8Array.from(entries);

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

        expect(extractTargetQr31Response(input).consumed).toBe(entries.length);
        const prototypeProxy = Uint8Array.from(entries);
        Object.setPrototypeOf(
            prototypeProxy,
            new Proxy(Uint8Array.prototype, { get: fail, getPrototypeOf: fail }),
        );
        const proxy = new Proxy(Uint8Array.from(entries), { get: fail, getPrototypeOf: fail });
        const revoked = Proxy.revocable(Uint8Array.from(entries), {});
        revoked.revoke();
        const detached = Uint8Array.from(entries);
        structuredClone(detached, { transfer: [detached.buffer] });
        const buffer = new ArrayBuffer(32, { maxByteLength: 64 });
        const outOfBounds = new Uint8Array(buffer, 8, 20);
        buffer.resize(8);
        const shared = runInNewContext('new Uint8Array(new SharedArrayBuffer(16))') as Uint8Array;
        const fake = Object.defineProperty({}, 'byteLength', { get: fail });

        for (const bad of [
            prototypeProxy,
            proxy,
            revoked.proxy,
            detached,
            outOfBounds,
            shared,
            new Uint8Array(new SharedArrayBuffer(16)),
            new Uint16Array(8),
            new DataView(new ArrayBuffer(16)),
            fake,
            null,
            undefined,
        ]) {
            expect(() => extractTargetQr31Response(bad as never)).toThrow(error);
        }

        expect(calls).toBe(0);
    });

    it('cleans all allocated outputs independently after a late failure', async () => {
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

            if (++count === 3) {
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
        const isolated = await import('../../src/direct/target-qr31-response');
        const before = Buffer.from(entries);
        let thrown: unknown;

        try {
            isolated.extractTargetQr31Response(entries);
        } catch (caught) {
            thrown = caught;
        }

        vi.restoreAllMocks();
        expect((thrown as Error).message).toBe(error);
        expect(cleared).toHaveLength(3);
        expect(cleared[1]).toEqual(new Uint8Array(3));
        expect(cleared[2]).toEqual(new Uint8Array(1));
        expect(entries).toEqual(before);
    });
});
