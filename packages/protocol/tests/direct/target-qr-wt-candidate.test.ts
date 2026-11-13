import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeTargetQr31GetPicture } from '../../src/direct/target-qr31-get-picture';
import { encodeTargetQr12Query } from '../../src/direct/target-qr12-query';
import { qqTeaDecrypt } from '../../src/direct/qq-tea';
import * as localModule from '../../src/direct/target-wt-local-data';
import * as oicqModule from '../../src/direct/target-wt-oicq';
import {
    encodeTargetQrWtCandidate as encode,
    type TargetQrWtCandidateInput,
} from '../../src/direct/target-qr-wt-candidate';

const failure = 'target QR WT candidate construction failed';
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');
const key = Uint8Array.from({ length: 16 }, (_, i) => i);

function source(channel: Uint8Array): TargetQrWtCandidateInput {
    const p = (8 - ((channel.length + 10) % 8)) % 8;
    const paddingRandom = new Uint8Array(p + 3);
    paddingRandom[0] = 0xf8;
    return {
        channel,
        key: key.slice(),
        extra: Uint8Array.of(0xaa, 0),
        local16: new Uint8Array(16).fill(0x55),
        paddingRandom,
        version: 0x123,
        sequence: 0x4567,
        clientType: 0x89ab,
        pubno: 0xcdef0123,
    };
}

function qr31(): Uint8Array {
    return encodeTargetQr31GetPicture({
        session0: 1,
        session4: 2,
        session28: 3,
        sessionC8: 4n,
        session38: Uint8Array.of(5),
        session50: Uint8Array.of(6),
        session68: Uint8Array.of(7),
        session80Words: [1, 2, 3, 4, 5, 6, 7],
        opaque16: new Uint8Array(16),
        d1Second: Uint8Array.of(8),
        optional11: null,
        channelEsi: 9,
        channelEcx: 10,
    });
}

function qr12(): Uint8Array {
    return encodeTargetQr12Query({
        session138: 1,
        session110: 2n,
        session1c0: Uint8Array.of(3, 4),
        clockWord: 5,
    });
}

afterEach(() => vi.restoreAllMocks());

describe('conditional offline QR-to-WT OICQ candidate', () => {
    it('matches independently assembled OICQ header and independent QQ-TEA vector', () => {
        // MiraiGo independent synthetic fixture, commit 2b2be6693df1219d867300c6f6cd0f804c59d620.
        const input = source(Uint8Array.of(0, 1, 2));
        const frame = encode(input);
        expect(hex(frame)).toBe(
            '02004501230812456700000000038700000089abcdef012300000000' +
                '0101' +
                '55'.repeat(16) +
                '01020002aa00' +
                'b619e9103a2640d8262b6860a4102374' +
                '03',
        );
        expect(qqTeaDecrypt(frame.subarray(52, -1), key)).toEqual(input.channel);
    });

    it.each([
        ['QR31', qr31],
        ['QR12', qr12],
    ] as const)('wraps real %s channel and recovers identical plaintext', (_name, makeChannel) => {
        const channel = makeChannel();
        const input = source(channel);
        const before = [
            input.channel.slice(),
            input.key.slice(),
            input.extra.slice(),
            input.local16.slice(),
            input.paddingRandom.slice(),
        ];
        const frame = Buffer.from(encode(input));
        expect(frame.readUInt16BE(1)).toBe(frame.length);
        expect(hex(frame.subarray(3, 28))).toBe(
            '01230812456700000000038700000089abcdef012300000000',
        );
        expect(hex(frame.subarray(28, 52))).toBe('0101' + '55'.repeat(16) + '01020002aa00');
        expect(frame.at(-1)).toBe(3);
        expect(qqTeaDecrypt(frame.subarray(52, -1), key)).toEqual(channel);
        expect([input.channel, input.key, input.extra, input.local16, input.paddingRandom]).toEqual(
            before,
        );
        const saved = Buffer.from(frame);
        input.channel.fill(0);
        input.key.fill(0);
        input.extra.fill(0);
        input.local16.fill(0);
        input.paddingRandom.fill(0);
        expect(frame).toEqual(saved);
    });

    it('covers all padding alignments and independent key/local16', () => {
        for (let n = 0; n < 16; n++) {
            const input = source(Uint8Array.from({ length: n }, (_, i) => i));
            const frame = encode(input);
            expect(frame.length).toBe(29 + 22 + 2 + 8 * Math.ceil((n + 10) / 8));
            expect(qqTeaDecrypt(frame.subarray(52, -1), key)).toEqual(input.channel);
            input.paddingRandom = new Uint8Array(input.paddingRandom.length + 1);
            expect(() => encode(input)).toThrow(failure);
        }
    });

    it('enforces exact cross-layer total and rejects one byte beyond before composing', () => {
        const input = source(new Uint8Array(65470));
        input.extra = new Uint8Array(4);
        expect(encode(input).length).toBe(65535);
        input.channel = new Uint8Array(65471);
        const spy = vi.spyOn(localModule, 'encodeTargetWtLocalDataCandidate');
        expect(() => encode(input)).toThrow(failure);
        expect(spy).not.toHaveBeenCalled();
        input.channel = new Uint8Array();
        input.extra = new Uint8Array(65535);
        expect(() => encode(input)).toThrow(failure);
        input.extra = new Uint8Array(65536);
        expect(() => encode(input)).toThrow(failure);
    });

    it('validates explicit integer fields and fixed-size inputs', () => {
        for (const name of ['version', 'sequence', 'clientType'] as const) {
            for (const value of [-1, 65536, 0.5, NaN, Infinity, '1']) {
                expect(() =>
                    encode({ ...source(new Uint8Array()), [name]: value } as never),
                ).toThrow(failure);
            }
        }

        for (const pubno of [-1, 0x100000000, 0.5, NaN]) {
            expect(() => encode({ ...source(new Uint8Array()), pubno })).toThrow(failure);
        }

        for (const size of [0, 15, 17]) {
            expect(() =>
                encode({ ...source(new Uint8Array()), key: new Uint8Array(size) }),
            ).toThrow(failure);
            expect(() =>
                encode({ ...source(new Uint8Array()), local16: new Uint8Array(size) }),
            ).toThrow(failure);
        }

        const frame = Buffer.from(
            encode({
                ...source(new Uint8Array()),
                version: 65535,
                sequence: 65535,
                clientType: 65535,
                pubno: 0xffffffff,
            }),
        );
        expect(frame.readUInt16BE(3)).toBe(65535);
        expect(frame.readUInt16BE(7)).toBe(65535);
        expect(frame.readUInt32BE(16)).toBe(65535);
        expect(frame.readUInt32BE(20)).toBe(0xffffffff);
        expect(() =>
            encode({ ...source(new Uint8Array()), paddingRandom: new Uint8Array() }),
        ).toThrow(failure);
    });

    it('accepts foreign ordinary views and overlapping input slices independently', () => {
        const input = source(Uint8Array.of(0, 1, 2));
        const backing = Uint8Array.from({ length: 32 }, (_, i) => i);
        input.channel = backing.subarray(0, 3);
        input.key = backing.subarray(0, 16);
        input.local16 = backing.subarray(0, 16);
        input.extra = runInNewContext('new Uint8Array([9,170,0,8]).subarray(1,3)') as Uint8Array;
        const before = backing.slice();
        const result = encode(input);
        expect(qqTeaDecrypt(result.subarray(52, -1), key)).toEqual(input.channel);
        expect(backing).toEqual(before);
        backing.fill(0);
        expect(hex(result.subarray(30, 46))).toBe(hex(key));
    });

    it('rejects getters and proxy/shared/detached/oob inputs without triggering traps', () => {
        let hits = 0;

        const trap = () => {
            hits++;
            throw new Error('SECRET');
        };

        const accessor = source(new Uint8Array());
        Object.defineProperty(accessor, 'sequence', { get: trap });
        const detached = Uint8Array.of(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const rab = new ArrayBuffer(8, { maxByteLength: 16 });
        const oob = new Uint8Array(rab, 4, 4);
        rab.resize(0);
        const shadow = Uint8Array.of(1);
        Object.defineProperty(shadow, 'length', { get: trap });
        const proto = Uint8Array.of(1);
        Object.setPrototypeOf(proto, new Proxy(Uint8Array.prototype, { getPrototypeOf: trap }));
        const rec = Object.assign(
            Object.create(new Proxy(Object.prototype, { getPrototypeOf: trap })),
            source(new Uint8Array()),
        );

        for (const bad of [
            accessor,
            rec,
            new Proxy(source(new Uint8Array()), { get: trap, ownKeys: trap, getPrototypeOf: trap }),
            ...[
                detached,
                oob,
                shadow,
                proto,
                new Uint8Array(new SharedArrayBuffer(1)),
                runInNewContext('new Uint8Array(new SharedArrayBuffer(1))'),
                new Proxy(Uint8Array.of(1), { get: trap }),
                new Uint16Array(1),
            ].map((channel) => ({ ...source(new Uint8Array()), channel })),
        ]) {
            expect(() => encode(bad as never)).toThrow(failure);
        }

        expect(hits).toBe(0);
    });

    it('snapshots all inputs before composition and clears private intermediate', () => {
        const input = source(Uint8Array.of(0, 1, 2));
        const expected = encode(input);
        const real = localModule.encodeTargetWtLocalDataCandidate;
        let snapshots: Uint8Array[] = [];
        let opaque!: Uint8Array;
        vi.spyOn(localModule, 'encodeTargetWtLocalDataCandidate').mockImplementation((args) => {
            snapshots = [
                args.plaintext!,
                args.encryptionKey!,
                args.extra,
                args.local16,
                args.paddingRandom!,
            ];
            input.channel.fill(0);
            input.key.fill(0);
            input.extra.fill(0);
            input.local16.fill(0);
            input.paddingRandom.fill(0);
            input.version = 0;
            input.sequence = 0;
            input.clientType = 0;
            input.pubno = 0;
            return (opaque = real(args));
        });
        expect(encode(input)).toEqual(expected);
        expect(snapshots.every((x) => x.every((b) => b === 0))).toBe(true);
        expect(opaque.every((b) => b === 0)).toBe(true);
    });

    it('clears real returned output if a postcondition fails', () => {
        const input = source(Uint8Array.of(0, 1, 2));
        const real = oicqModule.encodeTargetWtOicq;
        let output!: Uint8Array;
        vi.spyOn(oicqModule, 'encodeTargetWtOicq').mockImplementation((args) => {
            output = real(args);
            Object.defineProperty(output, 'length', { value: output.length - 1 });
            return output;
        });
        expect(() => encode(input)).toThrow(failure);
        expect(Uint8Array.prototype.every.call(output, (byte: number) => byte === 0)).toBe(true);
        expect(input.channel).toEqual(Uint8Array.of(0, 1, 2));
    });

    it('clears earlier snapshots and an interrupted new copy independently', async () => {
        const input = source(Uint8Array.of(0, 1, 2));
        const original = Uint8Array.prototype.set;
        const copies: Uint8Array[] = [];
        vi.resetModules();
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            data: ArrayLike<number>,
            offset?: number,
        ) {
            copies.push(this);
            original.call(this, data, offset);

            if (copies.length === 4) {
                throw new Error('SECRET');
            }
        });

        try {
            const module = await import('../../src/direct/target-qr-wt-candidate');
            expect(() => module.encodeTargetQrWtCandidate(input)).toThrow(failure);
        } finally {
            spy.mockRestore();
        }

        expect(copies).toHaveLength(4);
        expect(copies.every((value) => value.every((byte) => byte === 0))).toBe(true);
        expect(input.key).toEqual(key);
        expect(input.local16).toEqual(new Uint8Array(16).fill(0x55));
    });

    it('cleans real opaque and all snapshots on OICQ failure without exposing errors', () => {
        const input = source(Uint8Array.of(0, 1, 2));
        const real = localModule.encodeTargetWtLocalDataCandidate;
        let snapshots: Uint8Array[] = [];
        let opaque!: Uint8Array;
        vi.spyOn(localModule, 'encodeTargetWtLocalDataCandidate').mockImplementation((args) => {
            snapshots = [
                args.plaintext!,
                args.encryptionKey!,
                args.extra,
                args.local16,
                args.paddingRandom!,
            ];
            return (opaque = real(args));
        });
        vi.spyOn(oicqModule, 'encodeTargetWtOicq').mockImplementation(() => {
            throw new Error('SECRET');
        });
        expect(() => encode(input)).toThrow(failure);
        expect(snapshots.every((x) => x.every((b) => b === 0))).toBe(true);
        expect(opaque.every((b) => b === 0)).toBe(true);
        expect(input.channel).toEqual(Uint8Array.of(0, 1, 2));
    });
});
