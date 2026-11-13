import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractTargetQr12Selected } from '../../src/direct/target-qr12-selected';
import * as parser from '../../src/direct/target-qr12-response';

const failure = 'target QR12 selected fields extraction failed';
// Hand-assembled synthetic responses; no live data.
const empty = Buffer.from('000001020304000000000000000000000000000000', 'hex');
const full = Buffer.from(
    '00034100421122334400010203040506070899aabbcc000700180002aa0000190001ff001e0002008000180001bb99990001120065000200fe003f000180',
    'hex',
);
const finalEmpty = Buffer.from(
    '000001020304000000000000000000000000000002001e0001ff001e0000',
    'hex',
);

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('selected raw QR12 status-zero fields', () => {
    it('distinguishes absent fields from final present empty field', () => {
        expect(extractTargetQr12Selected(empty)).toEqual({
            field18: { kind: 'absent' },
            field19: { kind: 'absent' },
            field1e: { kind: 'absent' },
            field65: { kind: 'absent' },
            field3f: { kind: 'absent' },
        });
        expect(extractTargetQr12Selected(finalEmpty)).toEqual({
            field18: { kind: 'absent' },
            field19: { kind: 'absent' },
            field1e: { kind: 'present', bytes: new Uint8Array() },
            field65: { kind: 'absent' },
            field3f: { kind: 'absent' },
        });
    });

    it('keeps raw NUL and non-UTF8 bytes, applies last-wins and ignores unknown tags', () => {
        const before = Buffer.from(full);
        const result = extractTargetQr12Selected(full);
        expect(result).toEqual({
            field18: { kind: 'present', bytes: Uint8Array.of(0xbb) },
            field19: { kind: 'present', bytes: Uint8Array.of(0xff) },
            field1e: { kind: 'present', bytes: Uint8Array.of(0, 0x80) },
            field65: { kind: 'present', bytes: Uint8Array.of(0, 0xfe) },
            field3f: { kind: 'present', bytes: Uint8Array.of(0x80) },
        });
        expect(full).toEqual(before);

        if (
            result.field18.kind !== 'present' ||
            result.field19.kind !== 'present' ||
            result.field1e.kind !== 'present' ||
            result.field65.kind !== 'present' ||
            result.field3f.kind !== 'present'
        ) {
            throw new Error('unexpected absent field');
        }

        expect(
            new Set([
                result.field18.bytes.buffer,
                result.field19.bytes.buffer,
                result.field1e.bytes.buffer,
                result.field65.bytes.buffer,
                result.field3f.bytes.buffer,
            ]).size,
        ).toBe(5);
        result.field18.bytes[0] = 1;
        expect(full).toEqual(before);
        const a = Buffer.from(full);
        const output = extractTargetQr12Selected(a);
        a.fill(0);
        expect(output.field1e).toEqual({ kind: 'present', bytes: Uint8Array.of(0, 0x80) });
    });

    it('keeps the final raw or empty value independently for both new tags', () => {
        const prefix = empty.subarray(0, 19);
        const a = Buffer.concat([
            prefix,
            Buffer.from('000400650001ff003f0001aa006500020080003f0000', 'hex'),
        ]);
        const b = Buffer.concat([
            prefix,
            Buffer.from('0004003f0001ff00650001aa003f000200fe00650000', 'hex'),
        ]);
        expect(extractTargetQr12Selected(a)).toMatchObject({
            field65: { kind: 'present', bytes: Uint8Array.of(0, 0x80) },
            field3f: { kind: 'present', bytes: new Uint8Array() },
        });
        expect(extractTargetQr12Selected(b)).toMatchObject({
            field3f: { kind: 'present', bytes: Uint8Array.of(0, 0xfe) },
            field65: { kind: 'present', bytes: new Uint8Array() },
        });
    });

    it('uses the real parser and wipes every parsed field and entry on success', () => {
        const real = parser.extractTargetQr12Response;
        let captured!: ReturnType<typeof real>;
        vi.spyOn(parser, 'extractTargetQr12Response').mockImplementation(
            (value) => (captured = real(value)),
        );
        const result = extractTargetQr12Selected(full);
        expect(captured.first.raw).toEqual(new Uint8Array(3));
        expect(captured.first.nativeProjection.kind).toBe('assigned');

        if (captured.first.nativeProjection.kind !== 'assigned') {
            throw new Error('unexpected projection');
        }

        expect(captured.first.nativeProjection.bytes).toEqual(new Uint8Array(1));

        for (const entry of captured.entries) {
            expect(entry.value).toEqual(new Uint8Array(entry.value.length));
        }

        expect(result.field18).toEqual({ kind: 'present', bytes: Uint8Array.of(0xbb) });
        expect(result.field1e).toEqual({ kind: 'present', bytes: Uint8Array.of(0, 0x80) });
        expect(result.field65).toEqual({ kind: 'present', bytes: Uint8Array.of(0, 0xfe) });
        expect(result.field3f).toEqual({ kind: 'present', bytes: Uint8Array.of(0x80) });
    });

    it('wipes parser fields when a nonzero status is rejected', () => {
        const real = parser.extractTargetQr12Response;
        let captured!: ReturnType<typeof real>;
        vi.spyOn(parser, 'extractTargetQr12Response').mockImplementation(
            (value) => (captured = real(value)),
        );
        const input = Buffer.from(full);
        input[9] = 1;
        expect(() => extractTargetQr12Selected(input)).toThrow(failure);
        expect(captured.first.raw).toEqual(new Uint8Array(3));

        if (captured.first.nativeProjection.kind !== 'assigned') {
            throw new Error('unexpected projection');
        }

        expect(captured.first.nativeProjection.bytes).toEqual(new Uint8Array(1));

        for (const entry of captured.entries) {
            expect(entry.value).toEqual(new Uint8Array(entry.value.length));
        }
    });

    it('rejects all truncations and trailing bytes without exposing parser errors', () => {
        for (let i = 0; i < full.length; i++) {
            expect(() => extractTargetQr12Selected(full.subarray(0, i))).toThrow(failure);
        }

        expect(() => extractTargetQr12Selected(Buffer.concat([full, Buffer.of(0)]))).toThrow(
            failure,
        );
        const tooLarge = new Uint8Array(parser.MAX_TARGET_QR12_RESPONSE_BYTES + 1);
        expect(() => extractTargetQr12Selected(tooLarge)).toThrow(failure);
        const count = parser.MAX_TARGET_QR12_RESPONSE_ENTRIES;
        const limit = new Uint8Array(21 + (count + 1) * 4);
        const view = new DataView(limit.buffer);
        view.setUint16(19, count);
        expect(extractTargetQr12Selected(limit.subarray(0, 21 + count * 4)).field18).toEqual({
            kind: 'absent',
        });
        view.setUint16(19, count + 1);
        expect(() => extractTargetQr12Selected(limit)).toThrow(failure);
    });

    it('inherits real parser view, foreign, accessor and invalid backing behavior', () => {
        const foreign = runInNewContext(`new Uint8Array([${[...full].join(',')}])`) as Uint8Array;
        expect(extractTargetQr12Selected(foreign).field18).toEqual({
            kind: 'present',
            bytes: Uint8Array.of(0xbb),
        });
        const backing = Buffer.concat([Buffer.of(1), full, Buffer.of(2)]);
        expect(extractTargetQr12Selected(backing.subarray(1, -1)).field19).toEqual({
            kind: 'present',
            bytes: Uint8Array.of(0xff),
        });
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('SECRET');
        };

        const shadow = Uint8Array.from(full);
        Object.defineProperty(shadow, 'byteLength', { get: trap });
        expect(extractTargetQr12Selected(shadow).field18).toEqual({
            kind: 'present',
            bytes: Uint8Array.of(0xbb),
        });
        const proto = Uint8Array.from(full);
        Object.setPrototypeOf(proto, new Proxy(Uint8Array.prototype, { getPrototypeOf: trap }));
        const detached = Uint8Array.from(full);
        structuredClone(detached, { transfer: [detached.buffer] });
        const rab = new ArrayBuffer(128, { maxByteLength: 256 });
        const oob = new Uint8Array(rab, 16, full.length);
        rab.resize(0);
        const shared = runInNewContext('new Uint8Array(new SharedArrayBuffer(32))') as Uint8Array;
        const revoked = Proxy.revocable(Uint8Array.from(full), {});
        revoked.revoke();

        for (const value of [
            null,
            {},
            proto,
            detached,
            oob,
            shared,
            new Uint8Array(new SharedArrayBuffer(32)),
            new Proxy(Uint8Array.from(full), { get: trap }),
            revoked.proxy,
        ]) {
            expect(() => extractTargetQr12Selected(value as never)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it('attempts each cleanup independently after the last copy and first wipe fail', async () => {
        vi.resetModules();
        const realModule = await import('../../src/direct/target-qr12-response');
        const real = realModule.extractTargetQr12Response;
        let captured!: ReturnType<typeof real>;
        let active = false;
        vi.spyOn(realModule, 'extractTargetQr12Response').mockImplementation((value) => {
            captured = real(value);
            active = true;
            return captured;
        });
        const originalSet = Uint8Array.prototype.set;
        const originalFill = Uint8Array.prototype.fill;
        const selected: Uint8Array[] = [];
        const wipes: Uint8Array[] = [];
        vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            offset,
        ) {
            originalSet.call(this, source, offset);

            if (active) {
                selected.push(this);

                if (selected.length === 5) {
                    throw new Error('SECRET COPY');
                }
            }
        });
        vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value,
            start,
            end,
        ) {
            if (active) {
                wipes.push(this);

                if (wipes.length === 1) {
                    throw new Error('SECRET WIPE');
                }
            }

            return originalFill.call(this, value, start, end);
        });
        const isolated = await import('../../src/direct/target-qr12-selected');
        const before = Buffer.from(full);
        let thrown: unknown;

        try {
            isolated.extractTargetQr12Selected(full);
        } catch (error) {
            thrown = error;
        } finally {
            active = false;
        }

        vi.restoreAllMocks();
        expect((thrown as Error).message).toBe(failure);
        expect((thrown as Error).stack).not.toContain('SECRET');
        expect(Object.hasOwn(thrown as object, 'cause')).toBe(false);
        expect(wipes[0]).toBe(captured.first.raw);

        if (captured.first.nativeProjection.kind !== 'assigned') {
            throw new Error('unexpected projection');
        }

        expect(wipes).toContain(captured.first.nativeProjection.bytes);

        for (const entry of captured.entries) {
            expect(wipes).toContain(entry.value);
            expect(entry.value).toEqual(new Uint8Array(entry.value.length));
        }

        expect(selected).toHaveLength(5);

        for (const output of selected) {
            expect(wipes).toContain(output);
            expect(output).toEqual(new Uint8Array(output.length));
        }

        expect(full).toEqual(before);
    });
});
