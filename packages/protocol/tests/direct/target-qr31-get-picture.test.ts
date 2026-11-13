import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    encodeTargetQr31GetPicture as encode,
    type TargetQr31GetPictureInput,
} from '../../src/direct/target-qr31-get-picture';
import * as tlv from '../../src/direct/target-qr31-tlv';
import * as d1 from '../../src/direct/target-qr31-d1';
import * as bodyModule from '../../src/direct/target-qr31-body';
import * as frameModule from '../../src/direct/target-qr31-frame';
import * as wrapperModule from '../../src/direct/target-qr31-channel-wrapper';

const failure = 'target QR31 get-picture construction failed';
const input = (): TargetQr31GetPictureInput => ({
    session0: 0x11223344,
    session4: 0x55667788,
    session28: 0x89abcdef,
    sessionC8: 0xf123456789abcdefn,
    session38: Uint8Array.of(0xbb, 0),
    session50: Uint8Array.of(0xaa, 0xff),
    session68: Uint8Array.of(0xff, 0),
    session80Words: [1, 2, 3, 4, 5, 6, 7],
    opaque16: Uint8Array.from({ length: 16 }, (_, i) => i),
    d1Second: Uint8Array.of(0x80),
    optional11: null,
    channelEsi: 0xaabbccdd,
    channelEcx: 0x76543210,
});
const hex = (v: Uint8Array) => Buffer.from(v).toString('hex');
// Manually derived from independent field/length tables, not from encoder output.
const goldenChildren =
    '00160028' +
    '000000001122334455667788' +
    '000102030405060708090a0b0c0d0e0f' +
    '0002aaff0002bb000002aaff' +
    '001b001e000000010000000200000003000000040000000500000006000000070000' +
    '001d000a0000007ffc0000000000' +
    '00330010000102030405060708090a0b0c0d0e0f' +
    '0035000489abcdef0066000489abcdef' +
    '00d1000d0a070a02ff0012018022023001';
const goldenBodyPrefix = '000011223344f123456789abcdef0000000007';

afterEach(() => vi.restoreAllMocks());

describe('selected static QR31 get-picture composition', () => {
    it('matches hand-derived body and wrapper bytes with real child encoders', () => {
        const result = Buffer.from(encode(input()));
        const inner = result.subarray(18);
        expect(result[0]).toBe(0);
        expect(result.readUInt16BE(1)).toBe(inner.length + 4);
        expect(result.readUInt16BE(1)).not.toBe(result.length);
        expect(hex(result.subarray(3, 18))).toBe('aabbccdd0000007200000076543210');
        expect(inner[0]).toBe(2);
        expect(inner.readUInt16BE(1)).toBe(inner.length);
        expect(inner.readUInt16BE(3)).toBe(0x31);
        expect(hex(inner.subarray(5, 26))).toBe('00'.repeat(21));
        expect(inner[26]).toBe(3);
        expect(inner.readUInt16BE(29)).toBe(0x32);
        expect(hex(inner.subarray(31, 43))).toBe('00'.repeat(12));
        expect(inner.at(-1)).toBe(3);
        expect(hex(inner.subarray(43, -1))).toBe(goldenBodyPrefix + goldenChildren);
        const childBodies = inner.subarray(43 + 19, -1);
        let offset = 0;
        const tags: number[] = [];

        while (offset < childBodies.length) {
            tags.push(childBodies.readUInt16BE(offset));
            offset += 4 + childBodies.readUInt16BE(offset + 2);
        }

        expect(offset).toBe(childBodies.length);
        expect(tags).toEqual([0x16, 0x1b, 0x1d, 0x33, 0x35, 0x66, 0xd1]);
    });
    it('includes optional 11 even when empty and changes count to eight', () => {
        const a = input();
        a.optional11 = new Uint8Array();
        const body = Buffer.from(encode(a)).subarray(18 + 43, -1);
        expect(body.readUInt16BE(17)).toBe(8);
        expect(hex(body.subarray(19))).toBe('00110000' + goldenChildren);
    });
    it('encodes a nonempty optional 11 span in the first child', () => {
        const a = input();
        a.optional11 = Uint8Array.of(0xfa, 0, 0xfb);
        const body = Buffer.from(encode(a)).subarray(18 + 43, -1);
        expect(body.readUInt16BE(17)).toBe(8);
        expect(hex(body.subarray(19))).toBe('00110003fa00fb' + goldenChildren);
    });
    it('does not invoke a getter on a custom byte-view prototype', () => {
        let hits = 0;
        const a = input();
        const proto = Object.create(Uint8Array.prototype) as object;
        Object.defineProperty(proto, 'arbitrary', {
            get() {
                hits++;
                throw new Error('secret');
            },
        });
        Object.setPrototypeOf(a.session38, proto);
        expect(hex(encode(a))).toBe(hex(encode(input())));
        expect(hits).toBe(0);
    });
    it('composes real children/body/frame/wrapper in exact order', () => {
        const a = input();
        const children = [
            tlv.encodeTargetQr31Tlv16({
                field0c: 0,
                field10: a.session0,
                field14: a.session4,
                vector: a.opaque16,
                field30: a.session50,
                field48: a.session38,
                field60: a.session50,
            }),
            tlv.encodeTargetQr31Tlv1b({ words: a.session80Words, x: new Uint8Array() }),
            tlv.encodeTargetQr31Tlv1d({ field0a: 0, field0c: 0x7ffc, field10: 0, values: [] }),
            tlv.encodeTargetQr31Tlv33(a.opaque16),
            tlv.encodeTargetQr31Tlv35(a.session28),
            tlv.encodeTargetQr31Tlv66(a.session28),
            d1.encodeTargetQr31D1({ field1: a.session68, field2: a.d1Second }),
        ];
        const body = bodyModule.encodeTargetQr31Body({
            field38: new Uint8Array(),
            field50: a.session0,
            field30: a.sessionC8,
            field54: 0,
            field58: new Uint8Array(),
            field80: 7,
            children,
        });
        const frame = frameModule.encodeTargetQr31Frame(body);
        expect(encode(a)).toEqual(
            wrapperModule.encodeTargetQr31ChannelWrapper({
                inner: frame,
                fieldEsi: a.channelEsi,
                fieldEcx: a.channelEcx,
            }),
        );
    });
    it('snapshots every caller field before invoking any encoder', () => {
        const a = input();
        const expected = encode(a);
        const real = tlv.encodeTargetQr31Tlv16;
        vi.spyOn(tlv, 'encodeTargetQr31Tlv16').mockImplementation((fields) => {
            a.session38.fill(0);
            a.session50.fill(0);
            a.session68.fill(0);
            a.opaque16.fill(0);
            a.d1Second.fill(0);
            (a.session80Words as number[]).fill(0);
            a.session0 = 0;
            a.sessionC8 = 0n;
            a.channelEsi = 0;
            return real(fields);
        });
        expect(encode(a)).toEqual(expected);
    });
    it('enforces the full channel inner length without wrapping its 16-bit field', () => {
        const a = input();
        const baselineInner = encode(a).length - 18;
        const maximum = 65531 - baselineInner - 4;
        a.optional11 = new Uint8Array(maximum);
        const result = Buffer.from(encode(a));
        expect(result.readUInt16BE(1)).toBe(65535);
        a.optional11 = new Uint8Array(maximum + 1);
        expect(() => encode(a)).toThrow(failure);
    });
    it('keeps overlapping source views and repeated 50 input isolated from the returned packet', () => {
        const backing = Uint8Array.from({ length: 32 }, (_, i) => i);
        const a = input();
        a.opaque16 = backing.subarray(0, 16);
        a.session38 = backing.subarray(3, 6);
        a.session50 = backing.subarray(4, 7);
        a.session68 = backing.subarray(5, 8);
        a.d1Second = backing.subarray(6, 9);
        const before = backing.slice();
        const result = encode(a);
        const saved = result.slice();
        expect(backing).toEqual(before);
        backing.fill(0);
        expect(result).toEqual(saved);
    });
    it('passes independent 50 snapshots and cleans intermediate buffers', () => {
        const fn = tlv.encodeTargetQr31Tlv16;
        let x!: Uint8Array;
        let y!: Uint8Array;
        let produced!: Uint8Array;
        vi.spyOn(tlv, 'encodeTargetQr31Tlv16').mockImplementation((fields) => {
            x = fields.field30;
            y = fields.field60;
            expect(x).not.toBe(y);
            expect(x).toEqual(y);
            produced = fn(fields);
            return produced;
        });
        const result = encode(input());
        expect(x).toEqual(new Uint8Array(2));
        expect(y).toEqual(new Uint8Array(2));
        expect(produced).toEqual(new Uint8Array(produced.length));
        expect(result.some((b) => b !== 0)).toBe(true);
    });
    it('cleans body and frame without clearing the caller-owned wrapper', () => {
        const bodyFn = bodyModule.encodeTargetQr31Body;
        const frameFn = frameModule.encodeTargetQr31Frame;
        let temporaryBody!: Uint8Array;
        let temporaryFrame!: Uint8Array;
        vi.spyOn(bodyModule, 'encodeTargetQr31Body').mockImplementation(
            (x) => (temporaryBody = bodyFn(x)),
        );
        vi.spyOn(frameModule, 'encodeTargetQr31Frame').mockImplementation(
            (x) => (temporaryFrame = frameFn(x)),
        );
        const result = encode(input());
        expect(temporaryBody).toEqual(new Uint8Array(temporaryBody.length));
        expect(temporaryFrame).toEqual(new Uint8Array(temporaryFrame.length));
        expect(result.some((byte) => byte !== 0)).toBe(true);
    });
    it('wipes a real child if registering it in owned allocations fails', () => {
        const value = input();
        value.optional11 = Uint8Array.of(0xc1);
        const originalInputs = [
            value.optional11.slice(),
            value.session38.slice(),
            value.session50.slice(),
            value.session68.slice(),
            value.opaque16.slice(),
            value.d1Second.slice(),
        ];
        const oneOne = tlv.encodeTargetQr31Tlv11;
        const oneSix = tlv.encodeTargetQr31Tlv16;
        const originalPush = Array.prototype.push;
        let prior!: Uint8Array;
        let returned!: Uint8Array;
        let copies!: Uint8Array[];
        let injected = false;
        vi.spyOn(tlv, 'encodeTargetQr31Tlv11').mockImplementation(
            (bytes) => (prior = oneOne(bytes)),
        );
        vi.spyOn(tlv, 'encodeTargetQr31Tlv16').mockImplementation((fields) => {
            copies = [fields.vector, fields.field30, fields.field48, fields.field60];
            returned = oneSix(fields);

            Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
                if (items.length === 1 && items[0] === returned) {
                    injected = true;
                    Array.prototype.push = originalPush;
                    throw new Error('injected private allocation detail');
                }

                return originalPush.apply(this, items);
            };

            return returned;
        });
        let failureCaught: unknown;

        try {
            encode(value);
        } catch (error) {
            failureCaught = error;
        } finally {
            Array.prototype.push = originalPush;
        }

        expect(injected).toBe(true);
        expect(failureCaught).toBeInstanceOf(Error);
        expect((failureCaught as Error).message).toBe(failure);
        expect((failureCaught as Error).cause).toBeUndefined();
        expect(returned).toEqual(new Uint8Array(returned.length));
        expect(prior).toEqual(new Uint8Array(prior.length));

        for (const copy of copies) {
            expect(copy).toEqual(new Uint8Array(copy.length));
        }

        expect([
            value.optional11,
            value.session38,
            value.session50,
            value.session68,
            value.opaque16,
            value.d1Second,
        ]).toEqual(originalInputs);
    });
    it('cleans already-created children after a later encoder throws without leaking exception', () => {
        const original = tlv.encodeTargetQr31Tlv16;
        let captured!: Uint8Array;
        vi.spyOn(tlv, 'encodeTargetQr31Tlv16').mockImplementation(
            (fields) => (captured = original(fields)),
        );
        vi.spyOn(d1, 'encodeTargetQr31D1').mockImplementation(() => {
            throw new Error('sensitive synthetic error');
        });
        expect(() => encode(input())).toThrow(failure);
        expect(captured).toEqual(new Uint8Array(captured.length));
    });
    it('accepts empty and binary strings without interpreting them', () => {
        const a = input();
        a.session38 = new Uint8Array();
        a.session50 = new Uint8Array();
        a.session68 = new Uint8Array();
        a.d1Second = new Uint8Array();
        const result = Buffer.from(encode(a));
        expect(result.includes(Buffer.from('00d1000a0a040a00120022023001', 'hex'))).toBe(true);
        expect(result.includes(Buffer.from('001d000a0000007ffc0000000000', 'hex'))).toBe(true);
    });
    it('rejects oversized byte views before enumerating their own properties', () => {
        const huge = new Uint8Array(1024 * 1024);
        const ownKeys = vi.spyOn(Reflect, 'ownKeys');
        expect(() => encode({ ...input(), session38: huge })).toThrow(failure);
        expect(ownKeys.mock.calls.some(([value]) => value === huge)).toBe(false);
    });
    it('rejects invalid integer and byte lengths with one sanitized error', () => {
        const bad = [
            { session0: -1 },
            { session4: 0x100000000 },
            { session28: 1.5 },
            { sessionC8: -1n },
            { sessionC8: 0x10000000000000000n },
            { sessionC8: 1 },
            { channelEsi: -1 },
            { channelEcx: NaN },
            { opaque16: new Uint8Array(15) },
            { session80Words: [1, 2] },
            { session80Words: [1, 2, 3, 4, 5, 6, -1] },
            { optional11: undefined },
            { session50: new Uint8Array(65536) },
            { session38: new Uint8Array(65535), session50: new Uint8Array(1) },
            { session68: new Uint8Array(65535) },
            { optional11: new Uint8Array(65535) },
        ];

        for (const item of bad) {
            expect(() => encode({ ...input(), ...item } as never)).toThrow(failure);
        }
    });
    it('accepts genuine foreign ordinary byte views and rejects foreign shared memory', () => {
        const a = input();
        a.session38 = runInNewContext(
            'new Uint8Array([9, 187, 0, 8]).subarray(1, 3)',
        ) as Uint8Array;
        expect(hex(encode(a))).toBe(hex(encode(input())));
        a.session38 = runInNewContext('new Uint8Array(new SharedArrayBuffer(2))') as Uint8Array;
        expect(() => encode(a)).toThrow(failure);
    });
    it('rejects getters, proxies and unsafe byte views without traps', () => {
        let hits = 0;

        const trap = () => {
            hits++;
            throw new Error('secret');
        };

        const accessor = input();
        Object.defineProperty(accessor, 'session0', { get: trap });
        const extra = input();
        Object.defineProperty(extra, 'extra', { get: trap });
        const arr = [1, 2, 3, 4, 5, 6, 7];
        Object.defineProperty(arr, '2', { get: trap });
        const detached = Uint8Array.of(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const rab = new ArrayBuffer(8, { maxByteLength: 16 });
        const oob = new Uint8Array(rab, 4, 4);
        rab.resize(0);
        const shadow = Uint8Array.of(1);
        Object.defineProperty(shadow, 'byteLength', { get: trap });
        const altered = Uint8Array.of(1);
        Object.setPrototypeOf(altered, new Proxy(Uint8Array.prototype, { getPrototypeOf: trap }));

        for (const value of [
            accessor,
            extra,
            new Proxy(input(), { ownKeys: trap, getPrototypeOf: trap }),
            { ...input(), session80Words: arr },
            { ...input(), session80Words: new Proxy([1, 2, 3, 4, 5, 6, 7], { get: trap }) },
            ...[
                detached,
                oob,
                shadow,
                altered,
                new Uint8Array(new SharedArrayBuffer(1)),
                new Proxy(Uint8Array.of(1), { get: trap }),
            ].map((bytes) => ({ ...input(), session38: bytes })),
        ]) {
            expect(() => encode(value as never)).toThrow(failure);
        }

        expect(hits).toBe(0);
    });
});
