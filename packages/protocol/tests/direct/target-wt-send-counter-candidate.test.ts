import { describe, expect, it } from 'vitest';
import { targetWtSendCounterCandidate as candidate } from '../../src/direct/target-wt-send-counter-candidate';

const failure = 'target WT send counter candidate failed';

describe('offline target WT send counter value candidate', () => {
    it('uses the explicitly supplied old sequence and exact constants', () => {
        expect(candidate(0n, 0x810, 0)).toEqual({
            keyLow32: 0,
            commandLow16: 0x810,
            sequence: 0,
            nextSequence: 1,
            marker: 0x87,
        });
        expect(candidate(0x123456789abcdef0n, 0x12345678, 0x1234)).toEqual({
            keyLow32: 0x9abcdef0,
            commandLow16: 0x5678,
            sequence: 0x1234,
            nextSequence: 0x1235,
            marker: 0x87,
        });
    });

    it('handles unsigned maxima and wraps the 16-bit old value', () => {
        expect(candidate(0xffffffffffffffffn, 0xffffffff, 0xffff)).toEqual({
            keyLow32: 0xffffffff,
            commandLow16: 0xffff,
            sequence: 0xffff,
            nextSequence: 0,
            marker: 0x87,
        });
        expect(candidate(0n, -0, -0).sequence).toBe(0);
    });

    it('does not infer node or counter equivalence from matching low 32 bits', () => {
        const firstKey = 0x0000000100000002n;
        const secondKey = 0x0000000200000002n;
        expect(firstKey).not.toBe(secondKey);
        const first = candidate(firstKey, 0x810, 5);
        const second = candidate(secondKey, 0x810, 100);
        expect(first.keyLow32).toBe(second.keyLow32);
        expect(first.sequence).toBe(5);
        expect(second.sequence).toBe(100);
        expect(candidate(firstKey, 0x810, 5)).toEqual(first);
        // Identical projections cannot establish that distinct full keys select the same node.
        expect(candidate(secondKey, 0x810, 5)).toEqual(first);
    });

    it('returns fresh immutable pure-value objects', () => {
        const first = candidate(1n, 2, 3);
        const second = candidate(1n, 2, 3);
        expect(first).toEqual(second);
        expect(first).not.toBe(second);
        expect(Object.isFrozen(first)).toBe(true);
        expect(Reflect.set(first, 'nextSequence', 0)).toBe(false);
        expect(first.nextSequence).toBe(4);
    });

    it('uses a fixed error for invalid primitives in every position', () => {
        const badCommon: unknown[] = [
            Symbol('private data'),
            null,
            undefined,
            'private data',
            NaN,
            Infinity,
            -Infinity,
            1.5,
            -1,
            Number.MAX_SAFE_INTEGER + 1,
        ];
        const invalidKeys = [...badCommon, 0, 1, -1n, 0x10000000000000000n];
        const invalidCommands = [...badCommon, 0x100000000, 0n, 1n];
        const invalidSequences = [...badCommon, 0x10000, 0n, 1n];

        for (const value of invalidKeys) {
            expect(() => candidate(value as bigint, 0, 0)).toThrowError(failure);
        }

        for (const value of invalidCommands) {
            expect(() => candidate(0n, value as number, 0)).toThrowError(failure);
        }

        for (const value of invalidSequences) {
            expect(() => candidate(0n, 0, value as number)).toThrowError(failure);
        }
    });

    it('rejects objects and proxies without coercion, traps or secret leakage', () => {
        let calls = 0;

        const hostile = () => {
            calls++;
            throw new Error('plugin-private-data');
        };

        const value = { [Symbol.toPrimitive]: hostile, valueOf: hostile, toString: hostile };
        const proxy = new Proxy(value, { get: hostile, getPrototypeOf: hostile });
        const revoked = Proxy.revocable(value, {});
        revoked.revoke();

        for (const input of [value, proxy, revoked.proxy, Object(1n), Object(1)]) {
            for (const invoke of [
                () => candidate(input as bigint, 0, 0),
                () => candidate(0n, input as number, 0),
                () => candidate(0n, 0, input as number),
            ]) {
                let thrown: unknown;

                try {
                    invoke();
                } catch (error) {
                    thrown = error;
                }

                expect(thrown).toBeInstanceOf(Error);
                expect((thrown as Error).message).toBe(failure);
                expect((thrown as Error).cause).toBeUndefined();
            }
        }

        expect(calls).toBe(0);
    });
});
