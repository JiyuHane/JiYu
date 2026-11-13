import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    encodeTargetQr12Query,
    MAX_TARGET_QR12_QUERY_BLOB_BYTES,
    type TargetQr12QueryInput,
} from '../../src/direct/target-qr12-query';
import * as bodyModule from '../../src/direct/target-qr12-body';
import * as frameModule from '../../src/direct/target-qr12-frame';
import * as wrapperModule from '../../src/direct/target-qr31-channel-wrapper';

const failure = 'target QR12 query construction failed';
const input = (): TargetQr12QueryInput => ({
    session138: 0x11223344,
    session110: 0xf123456789abcdefn,
    session1c0: Uint8Array.of(0xaa, 0, 0xff),
    clockWord: 0x89abcdef,
});

// Independent synthetic bytes, assembled from the selected field/length layout.
const golden =
    '000048112233440000007200000089abcdef' +
    '0200440012' +
    '00'.repeat(21) +
    '0300000032' +
    '00'.repeat(12) +
    '0000112233440003aa00fff123456789abcdef0000000000' +
    '03';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('selected target-static QR12 query composition', () => {
    it('matches the independently assembled body, frame and wrapper byte for byte', () => {
        const source = input();
        const before = source.session1c0.slice();
        const result = Buffer.from(encodeTargetQr12Query(source));
        expect(result.toString('hex')).toBe(golden);
        const inner = result.subarray(18);
        expect(result.readUInt16BE(1)).toBe(inner.length + 4);
        expect(result.readUInt16BE(1)).not.toBe(result.length);
        expect(result.readUInt32BE(3)).toBe(source.session138);
        expect(inner.readUInt16BE(1)).toBe(inner.length);
        expect(inner.readUInt16BE(3)).toBe(0x12);
        expect(inner.readBigUInt64BE(35)).toBe(0n);
        expect(inner.readUInt32BE(45)).toBe(source.session138);
        expect(inner.readBigUInt64BE(54)).toBe(source.session110);
        expect(source.session1c0).toEqual(before);
        source.session1c0.fill(0);
        expect(result.toString('hex')).toBe(golden);
    });

    it('composes the actual body, frame and wrapper implementations', () => {
        const a = input();
        const body = bodyModule.encodeTargetQr12QueryBody({
            field50: a.session138,
            field30: a.session110,
            field58: a.session1c0,
        });
        const frame = frameModule.encodeTargetQr12Frame(body);
        const expected = wrapperModule.encodeTargetQr31ChannelWrapper({
            inner: frame,
            fieldEsi: a.session138,
            fieldEcx: a.clockWord,
        });
        expect(encodeTargetQr12Query(a)).toEqual(expected);
    });

    it('snapshots all fields before the first subencoder and clears private outputs', () => {
        const a = input();
        const expected = encodeTargetQr12Query(a);
        const realBody = bodyModule.encodeTargetQr12QueryBody;
        const realFrame = frameModule.encodeTargetQr12Frame;
        let snapshot!: Uint8Array;
        let body!: Uint8Array;
        let frame!: Uint8Array;
        vi.spyOn(bodyModule, 'encodeTargetQr12QueryBody').mockImplementation((fields) => {
            snapshot = fields.field58;
            a.session1c0.fill(0);
            a.session138 = 0;
            a.session110 = 0n;
            a.clockWord = 0;
            return (body = realBody(fields));
        });
        vi.spyOn(frameModule, 'encodeTargetQr12Frame').mockImplementation(
            (bytes) => (frame = realFrame(bytes)),
        );
        const result = encodeTargetQr12Query(a);
        expect(result).toEqual(expected);
        expect(snapshot).toEqual(new Uint8Array(3));
        expect(body).toEqual(new Uint8Array(body.length));
        expect(frame).toEqual(new Uint8Array(frame.length));
        expect(result.some((byte) => byte !== 0)).toBe(true);
    });

    it('enforces the cross-layer boundary before invoking subencoders', () => {
        const max = MAX_TARGET_QR12_QUERY_BLOB_BYTES;
        const a = { ...input(), session1c0: new Uint8Array(max) };
        a.session1c0[0] = 0xaa;
        a.session1c0[max - 1] = 0xbb;
        const result = Buffer.from(encodeTargetQr12Query(a));
        expect(result.readUInt16BE(1)).toBe(0xffff);
        expect(result.length).toBe(18 + 65531);
        expect(a.session1c0[0]).toBe(0xaa);
        expect(a.session1c0[max - 1]).toBe(0xbb);
        const tooBig = new Uint8Array(max + 1);
        const body = bodyModule.encodeTargetQr12QueryBody({
            field50: 1,
            field30: 2n,
            field58: tooBig,
        });
        const frame = frameModule.encodeTargetQr12Frame(body);
        expect(frame.length).toBe(65532);
        expect(() =>
            wrapperModule.encodeTargetQr31ChannelWrapper({
                inner: frame,
                fieldEsi: 1,
                fieldEcx: 2,
            }),
        ).toThrow();
        const spy = vi.spyOn(bodyModule, 'encodeTargetQr12QueryBody');
        expect(() => encodeTargetQr12Query({ ...a, session1c0: tooBig })).toThrow(failure);
        expect(spy).not.toHaveBeenCalled();
    });

    it('supports foreign and Buffer subviews, including empty blobs', () => {
        const foreign = runInNewContext(
            'new Uint8Array([9,170,0,255,8]).subarray(1,4)',
        ) as Uint8Array;
        expect(
            Buffer.from(encodeTargetQr12Query({ ...input(), session1c0: foreign })).toString('hex'),
        ).toBe(golden);
        const buffer = Buffer.from([9, 170, 0, 255, 8]);
        expect(
            Buffer.from(
                encodeTargetQr12Query({ ...input(), session1c0: buffer.subarray(1, 4) }),
            ).toString('hex'),
        ).toBe(golden);
        expect(encodeTargetQr12Query({ ...input(), session1c0: new Uint8Array() })).toHaveLength(
            18 + 65,
        );
        expect(buffer).toEqual(Buffer.from([9, 170, 0, 255, 8]));
    });

    it('rejects invalid scalar and byte forms with a fixed error', () => {
        const bad = [
            { session138: -1 },
            { session138: 0x100000000 },
            { session138: 0.5 },
            { clockWord: -1 },
            { clockWord: NaN },
            { clockWord: Infinity },
            { session110: -1n },
            { session110: 0x10000000000000000n },
            { session110: 0 },
            { session1c0: new Uint16Array(1) },
            { session1c0: null },
            { session1c0: new DataView(new ArrayBuffer(1)) },
        ];

        for (const value of bad) {
            expect(() => encodeTargetQr12Query({ ...input(), ...value } as never)).toThrow(failure);
        }

        expect(() => encodeTargetQr12Query(null as never)).toThrow(failure);
        expect(() => encodeTargetQr12Query({ ...input(), session110: undefined } as never)).toThrow(
            failure,
        );
    });

    it('rejects accessors, proxies, shared, detached and stale views without callbacks', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('SECRET');
        };

        const accessor = input();
        Object.defineProperty(accessor, 'session138', { get: trap });
        const extra = input();
        Object.defineProperty(extra, 'extra', { get: trap });
        const badRecord = Object.create(
            new Proxy(Object.prototype, { getPrototypeOf: trap }),
        ) as TargetQr12QueryInput;
        Object.assign(badRecord, input());
        const shadow = Uint8Array.of(1);
        Object.defineProperty(shadow, 'byteLength', { get: trap });
        const badPrototype = Uint8Array.of(1);
        Object.setPrototypeOf(
            badPrototype,
            new Proxy(Uint8Array.prototype, { getPrototypeOf: trap }),
        );
        const detached = Uint8Array.of(1);
        structuredClone(detached, { transfer: [detached.buffer] });
        const rab = new ArrayBuffer(8, { maxByteLength: 16 });
        const stale = new Uint8Array(rab, 4, 4);
        rab.resize(0);
        const shared = runInNewContext('new Uint8Array(new SharedArrayBuffer(1))') as Uint8Array;
        const revoked = Proxy.revocable(Uint8Array.of(1), {});
        revoked.revoke();

        for (const value of [
            accessor,
            extra,
            badRecord,
            new Proxy(input(), { ownKeys: trap, getPrototypeOf: trap }),
            ...[
                shadow,
                badPrototype,
                detached,
                stale,
                shared,
                new Uint8Array(new SharedArrayBuffer(1)),
                new Proxy(Uint8Array.of(1), { get: trap }),
                revoked.proxy,
            ].map((blob) => ({ ...input(), session1c0: blob })),
        ]) {
            expect(() => encodeTargetQr12Query(value as never)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it.each(['body', 'frame'] as const)(
        'clears an actual %s suboutput if ownership registration fails',
        (stage) => {
            const bodyFn = bodyModule.encodeTargetQr12QueryBody;
            const frameFn = frameModule.encodeTargetQr12Frame;
            const originalPush = Array.prototype.push;
            let snapshot!: Uint8Array;
            let body!: Uint8Array;
            let frame!: Uint8Array;
            let injected = false;

            const inject = (output: Uint8Array): Uint8Array => {
                Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
                    if (items.length === 1 && items[0] === output) {
                        injected = true;
                        Array.prototype.push = originalPush;
                        throw new Error('SECRET');
                    }

                    return originalPush.apply(this, items);
                };

                return output;
            };

            vi.spyOn(bodyModule, 'encodeTargetQr12QueryBody').mockImplementation((fields) => {
                snapshot = fields.field58;
                body = bodyFn(fields);
                return stage === 'body' ? inject(body) : body;
            });
            vi.spyOn(frameModule, 'encodeTargetQr12Frame').mockImplementation((data) => {
                frame = frameFn(data);
                return stage === 'frame' ? inject(frame) : frame;
            });
            const a = input();
            const before = a.session1c0.slice();
            let thrown: unknown;

            try {
                encodeTargetQr12Query(a);
            } catch (error) {
                thrown = error;
            } finally {
                Array.prototype.push = originalPush;
            }

            expect(injected).toBe(true);
            expect((thrown as Error).message).toBe(failure);
            expect((thrown as Error).stack).not.toContain('SECRET');
            expect(body).toEqual(new Uint8Array(body.length));

            if (stage === 'frame') {
                expect(frame).toEqual(new Uint8Array(frame.length));
            }

            expect(snapshot).toEqual(new Uint8Array(snapshot.length));
            expect(a.session1c0).toEqual(before);
        },
    );

    it('cleans snapshot, body and frame when the wrapper fails', () => {
        const bodyFn = bodyModule.encodeTargetQr12QueryBody;
        const frameFn = frameModule.encodeTargetQr12Frame;
        let snapshot!: Uint8Array;
        let body!: Uint8Array;
        let frame!: Uint8Array;
        vi.spyOn(bodyModule, 'encodeTargetQr12QueryBody').mockImplementation((fields) => {
            snapshot = fields.field58;
            return (body = bodyFn(fields));
        });
        vi.spyOn(frameModule, 'encodeTargetQr12Frame').mockImplementation(
            (bytes) => (frame = frameFn(bytes)),
        );
        vi.spyOn(wrapperModule, 'encodeTargetQr31ChannelWrapper').mockImplementation(() => {
            throw new Error('SECRET');
        });
        const a = input();
        expect(() => encodeTargetQr12Query(a)).toThrow(failure);
        expect(snapshot).toEqual(new Uint8Array(snapshot.length));
        expect(body).toEqual(new Uint8Array(body.length));
        expect(frame).toEqual(new Uint8Array(frame.length));
        expect(a.session1c0).toEqual(Uint8Array.of(0xaa, 0, 0xff));
    });
});
