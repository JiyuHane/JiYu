import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { selectTargetWtTgtgtStateCandidate as select } from '../../src/direct/target-wt-tgtgt-state-candidate';

const failure = 'target WT tgtgt state candidate failed';
const max64 = 0xffffffffffffffffn;
const base = 0x0123456789abcdefn;
const alternate = 0xfedcba9876543210n;
const bytes = (): Uint8Array => Uint8Array.of(0, 0xff, 0xc0, 0xaf, 0xe4, 0xb8, 0xad, 0);

// Synthetic bytes and values only; this suite never starts a login or transport.
describe('offline target WT tgtgt state candidate', () => {
    it.each([
        [0, 1, base, base],
        [1, 1, alternate, alternate],
        [2, 3, 0n, 0n],
        [3, 1, 0n, 0n],
        [0x80000000, 1, 0n, 0n],
        [0xffffffff, 1, 0n, 0n],
    ])('selects the static table for state %i', (state, field00, field50, derivationWord) => {
        const tail = bytes();
        const result = select(state, base, alternate, tail);
        expect(result).toEqual({
            field00,
            field14: 0,
            field18: 1,
            field19: 1,
            field50,
            derivationWord,
            tail38: state === 1 ? tail : new Uint8Array(),
        });
        expect(result.tail38).not.toBe(tail);
        expect(tail).toEqual(bytes());
    });

    it('keeps fallback field50 separate from a zero derivation word', () => {
        expect(select(1, base, 0n, Uint8Array.of(0))).toEqual({
            field00: 1,
            field14: 0,
            field18: 1,
            field19: 1,
            field50: base,
            derivationWord: 0n,
            tail38: Uint8Array.of(0),
        });
        expect(select(1, 0n, 0n, new Uint8Array()).field50).toBe(0n);
    });

    it('preserves the full unsigned 64-bit range in both word positions', () => {
        for (const value of [0n, 1n, 0x7fffffffffffffffn, 0x8000000000000000n, max64]) {
            expect(select(0, value, max64, bytes()).field50).toBe(value);
            expect(select(0, value, max64, bytes()).derivationWord).toBe(value);
            const result = select(1, max64, value, bytes());
            expect(result.field50).toBe(value === 0n ? max64 : value);
            expect(result.derivationWord).toBe(value);
            expect(select(2, value, value, bytes()).field50).toBe(0n);
        }
    });

    it('copies only the selected subview and isolates mutations in both directions', () => {
        const backing = Buffer.from([0x77, ...bytes(), 0x88]);
        const tail = backing.subarray(1, -1);
        const expected = bytes();
        const result = select(1, base, alternate, tail);
        expect(result.tail38).toEqual(expected);
        expect(result.tail38.buffer).not.toBe(backing.buffer);
        expect(backing).toEqual(Buffer.from([0x77, ...expected, 0x88]));
        tail.fill(0x55);
        expect(result.tail38).toEqual(expected);
        result.tail38.fill(0xaa);
        expect(backing).toEqual(
            Buffer.from([0x77, ...new Uint8Array(expected.length).fill(0x55), 0x88]),
        );
    });

    it('accepts empty, foreign-realm and all byte values without UTF-8 conversion', () => {
        const foreign = runInNewContext(
            'new Uint8Array([7, 0, 255, 128, 0xe4, 0xb8, 0xad, 0, 9]).subarray(1, 8)',
        ) as Uint8Array;
        const all = Uint8Array.from({ length: 256 }, (_, index) => index);

        for (const input of [new Uint8Array(), foreign, all, bytes()]) {
            const result = select(1, 0n, 0n, input);
            expect(Array.from(result.tail38)).toEqual(Array.from(input));
            expect(result.tail38).not.toBe(input);
            expect(result.tail38.buffer).not.toBe(input.buffer);
        }
    });

    it('applies the local 65535-byte tail threshold for every state', () => {
        const accepted = Uint8Array.from({ length: 65535 }, (_, index) => (index * 73 + 91) & 255);
        const rejected = new Uint8Array(65536).fill(0x81);

        for (const state of [0, 1, 2, 3, 0xffffffff]) {
            const result = select(state, base, alternate, accepted);
            expect(result.tail38).toEqual(state === 1 ? accepted : new Uint8Array());
            expect(() => select(state, base, alternate, rejected)).toThrow(failure);
            expect(rejected[0]).toBe(0x81);
            expect(rejected[65535]).toBe(0x81);
        }
    });

    it('rejects non-u32 states and non-u64 words without coercion in every branch', () => {
        let calls = 0;
        const coercible = {
            valueOf() {
                calls++;
                return 1;
            },
        };
        const badStates: unknown[] = [
            -1,
            0x100000000,
            0.5,
            NaN,
            Infinity,
            -Infinity,
            '1',
            1n,
            null,
            undefined,
            coercible,
        ];
        const badWords: unknown[] = [-1n, max64 + 1n, 0, 1, '1', null, undefined, coercible];

        for (const state of badStates) {
            expect(() => select(state as number, base, alternate, bytes())).toThrow(failure);
        }

        for (const state of [0, 1, 2, 3]) {
            for (const word of badWords) {
                expect(() => select(state, word as bigint, alternate, bytes())).toThrow(failure);
                expect(() => select(state, base, word as bigint, bytes())).toThrow(failure);
            }
        }

        expect(calls).toBe(0);
    });

    it('rejects invalid, proxy, shared, detached and out-of-bounds views without executing traps', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('private trap');
        };

        const detached = Uint8Array.of(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const resizable = new ArrayBuffer(8, { maxByteLength: 16 });
        const outOfBounds = new Uint8Array(resizable, 4, 4);
        resizable.resize(0);
        const proxyPrototype = Uint8Array.of(1);
        Object.setPrototypeOf(
            proxyPrototype,
            new Proxy(Uint8Array.prototype, { getPrototypeOf: trap }),
        );
        const revoked = Proxy.revocable(Uint8Array.of(1), {});
        revoked.revoke();
        const invalid: unknown[] = [
            null,
            undefined,
            'abc',
            [1],
            {},
            new Uint16Array(1),
            new Uint8ClampedArray(1),
            new DataView(new ArrayBuffer(1)),
            detached,
            outOfBounds,
            proxyPrototype,
            revoked.proxy,
            new Proxy(Uint8Array.of(1), { get: trap, getPrototypeOf: trap }),
            new Uint8Array(new SharedArrayBuffer(1)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(1))'),
        ];

        for (const state of [0, 1, 2, 3]) {
            for (const value of invalid) {
                expect(() => select(state, base, alternate, value as Uint8Array)).toThrow(failure);
            }
        }

        expect(calls).toBe(0);
    });

    it('does not invoke shadow accessors on genuine byte views', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('private accessor');
        };

        const input = bytes();

        for (const name of [
            'length',
            'byteLength',
            'byteOffset',
            'buffer',
            'set',
            'fill',
            Symbol.iterator,
            Symbol.toStringTag,
        ]) {
            Object.defineProperty(input, name, { get: trap, set: trap });
        }

        for (const state of [0, 1, 2, 3]) {
            expect(select(state, base, alternate, input).tail38).toEqual(
                state === 1 ? bytes() : new Uint8Array(),
            );
        }

        expect(calls).toBe(0);
    });

    it('wipes a partially copied owned buffer and masks copy failures', async () => {
        vi.resetModules();
        const original = Uint8Array.prototype.set;
        const source = bytes();
        const copies: Uint8Array[] = [];
        let active = false;
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            value,
            offset,
        ) {
            original.call(this, value, offset);

            if (active) {
                copies.push(this);
                throw new Error('private copy failure');
            }
        });

        try {
            const isolated = await import('../../src/direct/target-wt-tgtgt-state-candidate');
            active = true;
            expect(() =>
                isolated.selectTargetWtTgtgtStateCandidate(1, base, alternate, source),
            ).toThrow(failure);
            active = false;
        } finally {
            active = false;
            spy.mockRestore();
            vi.resetModules();
        }

        expect(copies).toHaveLength(1);
        expect(copies[0]).not.toBe(source);
        expect(Array.from(copies[0])).toEqual(new Array(source.length).fill(0));
        expect(source).toEqual(bytes());
    });

    it('preserves the fixed copy error even when best-effort cleanup throws', async () => {
        vi.resetModules();
        const originalSet = Uint8Array.prototype.set;
        const source = bytes();
        let active = false;
        let copied: Uint8Array | undefined;
        let cleanupAttempts = 0;
        const setSpy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            value,
            offset,
        ) {
            originalSet.call(this, value, offset);

            if (active) {
                copied = this;
                throw new Error('private copy failure');
            }
        });
        const originalFill = Uint8Array.prototype.fill;
        const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value,
            start,
            end,
        ) {
            if (active && this === copied) {
                cleanupAttempts++;
                throw new Error('private cleanup failure');
            }

            return originalFill.call(this, value, start, end);
        });

        try {
            const isolated = await import('../../src/direct/target-wt-tgtgt-state-candidate');
            active = true;
            expect(() =>
                isolated.selectTargetWtTgtgtStateCandidate(1, base, alternate, source),
            ).toThrow(failure);
            active = false;
        } finally {
            active = false;
            setSpy.mockRestore();
            fillSpy.mockRestore();
            vi.resetModules();
        }

        expect(cleanupAttempts).toBeGreaterThan(0);
        expect(source).toEqual(bytes());
    });
});
