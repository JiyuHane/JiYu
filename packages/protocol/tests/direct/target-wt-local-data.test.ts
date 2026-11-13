import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt } from '../../src/direct/qq-tea';
import {
    encodeTargetWtLocalDataCandidate as encode,
    type TargetWtLocalData,
} from '../../src/direct/target-wt-local-data';

const failure = 'target WT local data construction failed';
const key = Uint8Array.from({ length: 16 }, (_, i) => i);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

// Synthetic independent MiraiGo oracle from qq-tea.test.ts, commit
// 2b2be6693df1219d867300c6f6cd0f804c59d620, zero filler and F8 header.
const vector = 'b619e9103a2640d8262b6860a4102374';

function input(): TargetWtLocalData {
    return {
        ctxMode: 1,
        ctx4: 0,
        ctx5: 0,
        field6: 0x7f,
        mode2Word: null,
        local16: key.slice(),
        extra: new Uint8Array(),
        plaintext: Uint8Array.of(0, 1, 2),
        paddingRandom: Uint8Array.of(0xf8, 0, 0, 0, 0, 0),
    };
}

describe('target WT local QQ-TEA composition candidate', () => {
    it('matches independently sourced cipher and hand-assembled mode 1 wrapper', () => {
        const value = input();
        const encoded = encode(value);
        expect(hex(encoded)).toBe('017f000102030405060708090a0b0c0d0e0f01020000' + vector);
        expect(qqTeaDecrypt(encoded.subarray(22), key)).toEqual(value.plaintext);
        expect(value.local16).toEqual(key);
        expect(value.paddingRandom).toEqual(Uint8Array.of(0xf8, 0, 0, 0, 0, 0));
        value.local16.fill(0);
        expect(hex(encoded.subarray(2, 18))).toBe(hex(key));
    });

    it('selects explicit key for ctx5 nonzero, not the transmitted local16', () => {
        const value = input();
        value.ctxMode = 2;
        value.mode2Word = 0x3344;
        value.ctx5 = 2;
        value.local16 = new Uint8Array(16).fill(0xa5);
        value.encryptionKey = key.slice();
        value.extra = Uint8Array.of(0xaa, 0);
        const encoded = encode(value);
        expect(hex(encoded)).toBe('027f' + 'a5'.repeat(16) + '013133440002aa00' + vector);
        expect(qqTeaDecrypt(encoded.subarray(26), key)).toEqual(value.plaintext);
        expect(value.encryptionKey).toEqual(key);
        delete value.encryptionKey;
        expect(() => encode(value)).toThrow(failure);
    });

    it('handles mode 0 and other modes without adding mode fields', () => {
        for (const mode of [0, 3, 0xffffffff]) {
            const value = input();
            value.ctxMode = mode;
            expect(hex(encode(value))).toBe('017f000102030405060708090a0b0c0d0e0f0000' + vector);
        }
    });

    it('uses local16 when ctx5=0 regardless of ctx4 without reading encryptionKey', () => {
        const value = input();
        value.ctxMode = 2;
        value.ctx4 = 7;
        value.mode2Word = 1;
        Object.defineProperty(value, 'encryptionKey', {
            get: () => {
                throw new Error('secret');
            },
        });
        expect(hex(encode(value))).toBe(
            '027f000102030405060708090a0b0c0d0e0f013200010000' + vector,
        );
    });

    it('never reads ignored branch properties or invokes their proxies', () => {
        const value = input();
        value.ctx5 = 1;
        value.ctx4 = 1;
        value.extra = Uint8Array.of(7);
        let traps = 0;

        const trap = () => {
            traps++;
            throw new Error('secret');
        };

        Object.defineProperty(value, 'plaintext', { get: trap });
        Object.defineProperty(value, 'encryptionKey', { get: trap });
        Object.defineProperty(value, 'paddingRandom', {
            value: new Proxy({}, { get: trap, getPrototypeOf: trap }),
        });
        expect(hex(encode(value))).toBe('017f000102030405060708090a0b0c0d0e0f0102000107');
        expect(traps).toBe(0);
    });

    it('handles all eight padding lengths and plaintext boundaries', () => {
        for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 15, 16, 257]) {
            const value = input();
            value.plaintext = Uint8Array.from({ length: n }, (_, i) => i);
            const p = (8 - ((n + 10) % 8)) % 8;
            value.paddingRandom = new Uint8Array(p + 3).fill(0x71);
            const encoded = encode(value);
            expect(encoded.length).toBe(22 + 8 * Math.ceil((n + 10) / 8));
            expect(qqTeaDecrypt(encoded.subarray(22), key)).toEqual(value.plaintext);
            value.paddingRandom = new Uint8Array(p + 2);
            expect(() => encode(value)).toThrow(failure);
        }
    });

    it('checks exact wrapper budget before reading random or allocating plaintext copies', () => {
        const value = input();
        value.ctx5 = 1;
        value.encryptionKey = key;
        value.extra = new Uint8Array(4);
        value.plaintext = new Uint8Array(65470);
        value.paddingRandom = new Uint8Array(3);
        expect(encode(value).length).toBe(65506);
        value.plaintext = new Uint8Array(65471);
        let accessed = 0;
        Object.defineProperty(value, 'paddingRandom', {
            get: () => {
                accessed++;
                throw new Error('secret');
            },
        });
        expect(() => encode(value)).toThrow(failure);
        expect(accessed).toBe(0);
        const empty = input();
        empty.ctx5 = 1;
        empty.ctx4 = 1;
        empty.extra = new Uint8Array(65506 - 22);
        expect(encode(empty).length).toBe(65506);
        empty.extra = new Uint8Array(65506 - 21);
        expect(() => encode(empty)).toThrow(failure);
    });

    it('validates numeric fields, key sizes, branch constraints and explicit random', () => {
        for (const name of ['ctx4', 'ctx5', 'field6'] as const) {
            for (const invalid of [-1, 256, NaN, 1.5, '0']) {
                expect(() => encode({ ...input(), [name]: invalid } as TargetWtLocalData)).toThrow(
                    failure,
                );
            }
        }

        for (const ctxMode of [-1, 0x100000000, NaN, 1.5]) {
            expect(() => encode({ ...input(), ctxMode })).toThrow(failure);
        }

        expect(() => encode({ ...input(), ctxMode: 2, mode2Word: null })).toThrow(failure);
        expect(() => encode({ ...input(), mode2Word: 1 })).toThrow(failure);
        expect(() => encode({ ...input(), local16: new Uint8Array(15) })).toThrow(failure);
        expect(() => encode({ ...input(), extra: Uint8Array.of(1) })).toThrow(failure);
        expect(() => encode({ ...input(), paddingRandom: new Uint8Array(7) })).toThrow(failure);
        expect(() => encode({ ...input(), ctx5: 1, encryptionKey: new Uint8Array(17) })).toThrow(
            failure,
        );
    });

    it('copies foreign and overlapping slices without invoking shadow accessors', () => {
        const value = input();
        const backing = Uint8Array.from({ length: 32 }, (_, i) => i);
        value.local16 = backing.subarray(0, 16);
        value.plaintext = backing.subarray(0, 3);
        value.paddingRandom = runInNewContext('new Uint8Array([248,0,0,0,0,0])') as Uint8Array;
        let calls = 0;

        for (const name of [
            'length',
            'buffer',
            'byteLength',
            'byteOffset',
            'set',
            Symbol.iterator,
            Symbol.toStringTag,
        ]) {
            Object.defineProperty(value.paddingRandom, name, {
                get() {
                    calls++;
                    throw new Error('secret');
                },
            });
        }

        expect(hex(encode(value))).toBe('017f000102030405060708090a0b0c0d0e0f01020000' + vector);
        expect(calls).toBe(0);
        expect(backing).toEqual(Uint8Array.from({ length: 32 }, (_, i) => i));
    });

    it('rejects proxies, accessors, shared, detached and out-of-bounds views without traps', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('secret');
        };

        const detached = Uint8Array.of(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const rab = new ArrayBuffer(8, { maxByteLength: 16 });
        const oob = new Uint8Array(rab, 4, 4);
        rab.resize(4);
        const proto = Uint8Array.of(1);
        Object.setPrototypeOf(proto, new Proxy(Uint8Array.prototype, { getPrototypeOf: trap }));

        for (const bad of [
            new Proxy(Uint8Array.of(1), { get: trap }),
            proto,
            detached,
            oob,
            new Uint8Array(new SharedArrayBuffer(1)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(1))'),
            new Uint16Array(1),
            null,
        ]) {
            expect(() => encode({ ...input(), plaintext: bad } as TargetWtLocalData)).toThrow(
                failure,
            );
        }

        const accessor = input();
        Object.defineProperty(accessor, 'ctx5', { get: trap });
        expect(() => encode(accessor)).toThrow(failure);
        expect(() => encode(new Proxy(input(), { get: trap, getPrototypeOf: trap }))).toThrow(
            failure,
        );
        expect(calls).toBe(0);
    });

    it.each([false, true])(
        'wipes private snapshots and ciphertext after wrapper completion or failure: %s',
        async (fail) => {
            const value = input();
            const original = Uint8Array.prototype.set;
            const snapshots: Uint8Array[] = [];
            let cipher: Uint8Array | undefined;
            let localCopies = 0;
            vi.resetModules();
            const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
                this: Uint8Array,
                source: ArrayLike<number>,
                at?: number,
            ) {
                if (snapshots.length < 4) {
                    snapshots.push(this);
                }

                original.call(this, source, at);

                if (this.length === 16 && source.length === 8) {
                    cipher = this;
                }

                if (this.length === 16 && source.length === 16 && ++localCopies === 2 && fail) {
                    throw new Error('synthetic secret');
                }
            });
            let output: Uint8Array | undefined;

            try {
                const module = await import('../../src/direct/target-wt-local-data');

                if (fail) {
                    expect(() => module.encodeTargetWtLocalDataCandidate(value)).toThrow(failure);
                } else {
                    output = module.encodeTargetWtLocalDataCandidate(value);
                }
            } finally {
                spy.mockRestore();
            }

            expect(snapshots).toHaveLength(4);
            expect(snapshots.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
            expect(cipher).toBeDefined();
            expect(Array.from(cipher!)).toEqual(new Array(16).fill(0));
            expect(value.local16).toEqual(key);
            expect(value.plaintext).toEqual(Uint8Array.of(0, 1, 2));

            if (output) {
                expect(hex(output)).toBe('017f000102030405060708090a0b0c0d0e0f01020000' + vector);
            }
        },
    );

    it('wipes the separate encryption-key snapshot while preserving caller key', async () => {
        const value = input();
        value.ctx5 = 1;
        value.encryptionKey = key.slice();
        const original = Uint8Array.prototype.set;
        const copies: Uint8Array[] = [];
        vi.resetModules();
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source: ArrayLike<number>,
            at?: number,
        ) {
            if (copies.length < 5) {
                copies.push(this);
            }

            original.call(this, source, at);
        });

        try {
            const module = await import('../../src/direct/target-wt-local-data');
            const result = module.encodeTargetWtLocalDataCandidate(value);
            expect(qqTeaDecrypt(result.subarray(22), key)).toEqual(value.plaintext);
        } finally {
            spy.mockRestore();
        }

        expect(copies).toHaveLength(5);
        expect(copies.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
        expect(value.encryptionKey).toEqual(key);
    });

    it('uses completed snapshots when caller bytes change during later work', async () => {
        const value = input();
        const original = Uint8Array.prototype.set;
        let copies = 0;
        vi.resetModules();
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source: ArrayLike<number>,
            at?: number,
        ) {
            original.call(this, source, at);

            if (++copies === 4) {
                value.local16.fill(0);
                value.plaintext!.fill(0);
                value.paddingRandom!.fill(0);
            }
        });
        let output: Uint8Array;

        try {
            const module = await import('../../src/direct/target-wt-local-data');
            output = module.encodeTargetWtLocalDataCandidate(value);
        } finally {
            spy.mockRestore();
        }

        expect(hex(output)).toBe('017f000102030405060708090a0b0c0d0e0f01020000' + vector);
    });

    it('wipes an owned snapshot even when its copy throws', async () => {
        const value = input();
        const original = Uint8Array.prototype.set;
        const copies: Uint8Array[] = [];
        vi.resetModules();
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source: ArrayLike<number>,
            at?: number,
        ) {
            copies.push(this);
            original.call(this, source, at);
            throw new Error('secret');
        });

        try {
            const module = await import('../../src/direct/target-wt-local-data');
            expect(() => module.encodeTargetWtLocalDataCandidate(value)).toThrow(failure);
        } finally {
            spy.mockRestore();
        }

        expect(copies).toHaveLength(1);
        expect(Array.from(copies[0])).toEqual(new Array(16).fill(0));
        expect(value.local16).toEqual(key);
    });
});
