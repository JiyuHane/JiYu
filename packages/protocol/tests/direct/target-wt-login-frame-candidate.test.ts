import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import * as localEncoder from '../../src/direct/target-wt-local-data';
import * as oicqEncoder from '../../src/direct/target-wt-oicq';
import {
    encodeTargetWtLoginFrameCandidate as encode,
    type TargetWtLoginFrameCandidate,
} from '../../src/direct/target-wt-login-frame-candidate';

const failure = 'target WT login frame candidate construction failed';
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function input(): TargetWtLoginFrameCandidate {
    return {
        version: 0x1234,
        sequence: 0x5678,
        uin: 0x11223344,
        clientType: 0x9abc,
        pubno: 0xddeeff00,
        localData: {
            ctxMode: 1,
            ctx4: 0,
            ctx5: 0,
            field6: 0x7f,
            mode2Word: null,
            local16: Uint8Array.from({ length: 16 }, (_, i) => i),
            extra: new Uint8Array(),
            plaintext: Uint8Array.of(0, 1, 2),
            paddingRandom: Uint8Array.of(0xf8, 0, 0, 0, 0, 0),
        },
    };
}

// Hand-assembled target header and existing independent synthetic TEA oracle.
const golden =
    '0200431234081056781122334403870000009abcddeeff0000000000' +
    '017f000102030405060708090a0b0c0d0e0f01020000' +
    'b619e9103a2640d8262b6860a4102374' +
    '03';

describe('target WT 0x810 explicit login frame candidate', () => {
    it('matches exact synthetic bytes and composes the two real encoders', () => {
        const value = input();
        const intermediate = localEncoder.encodeTargetWtLocalDataCandidate(value.localData);
        const expected = oicqEncoder.encodeTargetWtOicq({
            version: value.version,
            command: 0x810,
            sequence: value.sequence,
            uin: value.uin,
            clientType: value.clientType,
            pubno: value.pubno,
            opaque: intermediate,
        });
        const frame = encode(value);
        expect(hex(frame)).toBe(golden);
        expect(frame).toEqual(expected);
        expect(new DataView(frame.buffer).getUint16(1)).toBe(frame.length);
        intermediate.fill(0);
        expect(hex(frame)).toBe(golden);
    });

    it('supports explicit alternate-key and empty branches without inventing defaults', () => {
        const value = input();
        value.localData.ctxMode = 2;
        value.localData.mode2Word = 0x3344;
        value.localData.ctx5 = 2;
        value.localData.encryptionKey = value.localData.local16.slice();
        value.localData.local16.fill(0xa5);
        value.localData.extra = Uint8Array.of(0xaa, 0);
        expect(hex(encode(value).subarray(28, -1))).toBe(
            '027f' + 'a5'.repeat(16) + '013133440002aa00b619e9103a2640d8262b6860a4102374',
        );
        value.localData.ctx4 = 1;
        delete value.localData.plaintext;
        delete value.localData.encryptionKey;
        delete value.localData.paddingRandom;
        expect(hex(encode(value).subarray(28, -1))).toBe(
            '027f' + 'a5'.repeat(16) + '013233440002aa00',
        );
    });

    it('preserves caller buffers and accepts Buffer, subviews and foreign Uint8Arrays', () => {
        const value = input();
        value.localData.local16 = runInNewContext('Uint8Array.from({length:16}, (_,i)=>i)');
        value.localData.plaintext = Buffer.from([0, 1, 2]);
        value.localData.paddingRandom = Uint8Array.of(99, 0xf8, 0, 0, 0, 0, 0, 99).subarray(1, 7);

        const shadow = () => {
            throw new Error('shadow getter must stay unobserved');
        };

        for (const name of ['byteLength', 'buffer', Symbol.toStringTag]) {
            Object.defineProperty(value.localData.local16, name, {
                get: shadow,
                configurable: true,
            });
        }

        const before = [
            value.localData.local16.slice(),
            value.localData.plaintext.slice(),
            value.localData.paddingRandom.slice(),
        ];
        const frame = encode(value);

        for (const name of ['byteLength', 'buffer', Symbol.toStringTag]) {
            Reflect.deleteProperty(value.localData.local16, name);
        }

        expect(hex(frame)).toBe(golden);
        expect(value.localData.local16).toEqual(before[0]);
        expect(value.localData.plaintext).toEqual(before[1]);
        expect(value.localData.paddingRandom).toEqual(before[2]);
        value.localData.local16.fill(0);
        frame.fill(0);
        expect(value.localData.plaintext).toEqual(before[1]);
        expect(value.localData.paddingRandom).toEqual(before[2]);
    });

    it('rejects malformed records, accessors and proxies without invoking their hooks', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('synthetic private diagnostic');
        };

        const getter = input();
        Object.defineProperty(getter.localData, 'plaintext', { get: trap });
        const topGetter = input();
        Object.defineProperty(topGetter, 'version', { get: trap });
        const inherited = input();
        Object.setPrototypeOf(inherited.localData, new Proxy({}, { getPrototypeOf: trap }));
        const byteProxy = input();
        byteProxy.localData.local16 = new Proxy(new Uint8Array(16), { get: trap });

        for (const value of [
            null,
            {},
            new Proxy(input(), { ownKeys: trap, getPrototypeOf: trap }),
            getter,
            topGetter,
            inherited,
            byteProxy,
        ]) {
            expect(() => encode(value as TargetWtLoginFrameCandidate)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it('validates header ranges, missing parameters, shared, detached and OOB views', () => {
        for (const field of ['version', 'sequence', 'uin', 'clientType', 'pubno'] as const) {
            for (const number of [-1, 0.5, NaN, Infinity, 0x100000000]) {
                const value = input();
                value[field] = number;
                expect(() => encode(value)).toThrow(failure);
            }
        }

        const value = input();
        value.clientType = 0x10000;
        expect(() => encode(value)).toThrow(failure);
        value.clientType = 0;
        delete value.localData.paddingRandom;
        expect(() => encode(value)).toThrow(failure);

        for (const bytes of [
            new Uint8Array(new SharedArrayBuffer(16)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(16))'),
            new Uint16Array(16),
        ]) {
            expect(() =>
                encode({ ...input(), localData: { ...input().localData, local16: bytes } }),
            ).toThrow(failure);
        }

        const detached = new Uint8Array(16);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        value.localData.local16 = detached;
        expect(() => encode(value)).toThrow(failure);
        value.localData.local16 = runInNewContext(`
            const backing = new ArrayBuffer(16, { maxByteLength: 32 });
            const view = new Uint8Array(backing, 0, 16);
            backing.resize(0);
            view;
        `);
        expect(() => encode(value)).toThrow(failure);
    });

    it('enforces inclusive OICQ budget and clears the real intermediate on success/failure', () => {
        const original = localEncoder.encodeTargetWtLocalDataCandidate;
        let captured: Uint8Array | undefined;
        const spy = vi
            .spyOn(localEncoder, 'encodeTargetWtLocalDataCandidate')
            .mockImplementation((value) => {
                captured = original(value);
                return captured;
            });

        try {
            const value = input();
            const result = encode(value);
            expect(captured).toEqual(new Uint8Array(38));
            expect(hex(result)).toBe(golden);
            const outer = vi.spyOn(oicqEncoder, 'encodeTargetWtOicq').mockImplementationOnce(() => {
                throw new Error('synthetic private diagnostic');
            });

            try {
                expect(() => encode(value)).toThrow(failure);
                expect(captured).toEqual(new Uint8Array(38));
            } finally {
                outer.mockRestore();
            }

            value.localData.ctx4 = 1;
            value.localData.ctx5 = 1;
            value.localData.extra = new Uint8Array(65484);
            expect(encode(value).length).toBe(65535);
            value.localData.extra = new Uint8Array(65485);
            expect(() => encode(value)).toThrow(failure);
        } finally {
            spy.mockRestore();
        }
    });
});
