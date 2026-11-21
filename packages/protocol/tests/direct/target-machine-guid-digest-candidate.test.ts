import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { deriveTargetMachineGuidDigestCandidate as derive } from '../../src/direct/target-machine-guid-digest-candidate';

const bytes = (text: string): Uint8Array => Buffer.from(text, 'ascii');
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');
const empty = (): Uint8Array => new Uint8Array(0);
const limit = 16 * 1024 * 1024;

// Fixed independently with Node crypto on the specified synthetic byte strings.
// These are local model vectors, not observations of any host or target.
describe('offline target machine GUID digest candidate', () => {
    it.each([
        ['alpha', '', '2c1743a391305fbf367df8e4f069f9f9'],
        ['', 'beta', '987bcab01b929eb2c07877b224215c92'],
        ['alpha', 'beta', '66bebefb99d3d4ddae3331821c07dccc'],
        ['alph', 'abeta', '66bebefb99d3d4ddae3331821c07dccc'],
        ['', 'alphabeta', '66bebefb99d3d4ddae3331821c07dccc'],
        ['alphabeta', '', '66bebefb99d3d4ddae3331821c07dccc'],
        ['beta', 'alpha', '4c459be99e5aebb13cad7ba5a3dd6359'],
    ])('hashes ordered synthetic byte segments %#', (firstText, secondText, expected) => {
        const first = bytes(firstText);
        const second = bytes(secondText);
        const firstBefore = Buffer.from(first);
        const secondBefore = Buffer.from(second);
        const result = derive(first, second);
        expect(result).toBeInstanceOf(Uint8Array);
        expect(result.byteLength).toBe(16);
        expect(hex(result)).toBe(expected);
        expect(first).toEqual(firstBefore);
        expect(second).toEqual(secondBefore);
    });

    it('hashes embedded NUL and non-UTF8 bytes without text conversion or separators', () => {
        const first = Uint8Array.of(0, 0xff, 0x80);
        const second = Uint8Array.of(0, 0x41, 0xfe);
        expect(hex(derive(first, second))).toBe('8b3cb124bae893d0f29971d80b6159fd');
        expect(hex(derive(empty(), Uint8Array.of(0, 0xff, 0x80, 0, 0x41, 0xfe)))).toBe(
            '8b3cb124bae893d0f29971d80b6159fd',
        );
    });

    it('rejects the double-empty fallback instead of inventing a digest', () => {
        expect(() => derive(empty(), empty())).toThrow();
    });

    it('uses only the specified Buffer and cross-realm views and returns independent bytes', () => {
        const backing = Buffer.from([0x77, 0x00, 0xff, 0x80, 0x88]);
        const first = backing.subarray(1, 4);
        const second = runInNewContext(
            'new Uint8Array([0x99, 0, 0x41, 0xfe, 0xaa]).subarray(1, 4)',
        ) as Uint8Array;
        const result = derive(first, second);
        const another = derive(first, second);
        expect(hex(result)).toBe('8b3cb124bae893d0f29971d80b6159fd');
        expect(result.buffer).not.toBe(first.buffer);
        expect(result.buffer).not.toBe(second.buffer);
        expect(result.buffer).not.toBe(another.buffer);
        expect(backing).toEqual(Buffer.from([0x77, 0, 0xff, 0x80, 0x88]));
        first.fill(0x55);
        second.fill(0x66);
        expect(hex(result)).toBe('8b3cb124bae893d0f29971d80b6159fd');
        result.fill(0x33);
        expect(Array.from(first)).toEqual([0x55, 0x55, 0x55]);
        expect(Array.from(second)).toEqual([0x66, 0x66, 0x66]);
        expect(hex(another)).toBe('8b3cb124bae893d0f29971d80b6159fd');
    });

    it('snapshots repeated and overlapping byte views without modifying their backing', () => {
        const backing = Uint8Array.of(1, 2, 3, 4);
        const first = backing.subarray(0, 3);
        const second = backing.subarray(1, 4);
        expect(hex(derive(first, second))).toBe('9464cd32904b7af14ffb40e5bf294973');
        expect(hex(derive(first, first))).toBe('e634c05f3435d8abe31f8e2d46173ad5');
        expect(Array.from(backing)).toEqual([1, 2, 3, 4]);
    });

    it('bounds prototype walks as a local input policy', () => {
        const deepView = (levels: number): Uint8Array => {
            let prototype: object = Uint8Array.prototype;

            for (let index = 0; index < levels; index++) {
                prototype = Object.create(prototype) as object;
            }

            const value = Uint8Array.of(1);
            Object.setPrototypeOf(value, prototype);
            return value;
        };

        expect(derive(deepView(252), empty())).toHaveLength(16);
        expect(() => derive(deepView(253), empty())).toThrow(
            'target machine GUID digest candidate failed',
        );
    });

    it('ignores shadow accessors on genuine foreign views', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('synthetic accessor');
        };

        const first = runInNewContext('new Uint8Array([0, 255, 128])') as Uint8Array;
        const second = runInNewContext('new Uint8Array([0, 65, 254])') as Uint8Array;

        for (const view of [first, second]) {
            for (const key of [
                'length',
                'byteLength',
                'byteOffset',
                'buffer',
                'set',
                'fill',
                Symbol.iterator,
                Symbol.toStringTag,
            ]) {
                Object.defineProperty(view, key, { get: trap, set: trap });
            }
        }

        expect(hex(derive(first, second))).toBe('8b3cb124bae893d0f29971d80b6159fd');
        expect(calls).toBe(0);
    });

    it('rejects invalid, proxy, shared, detached and out-of-bounds inputs in either slot', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('synthetic proxy trap');
        };

        const detached = Uint8Array.of(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const rab = new ArrayBuffer(8, { maxByteLength: 16 });
        const outOfBounds = new Uint8Array(rab, 4, 4);
        rab.resize(0);
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
            'a',
            [1],
            {},
            new ArrayBuffer(1),
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

        for (const value of invalid) {
            expect(() => derive(value as Uint8Array, Uint8Array.of(1))).toThrow();
            expect(() => derive(Uint8Array.of(1), value as Uint8Array)).toThrow();
        }

        expect(calls).toBe(0);
    });

    it('accepts exactly 16 MiB across either segment and rejects the next byte', () => {
        const full = new Uint8Array(limit).fill(0x61);
        const beforeLimit = full.subarray(0, limit - 1);
        const last = full.subarray(limit - 1);
        expect(hex(derive(beforeLimit, empty()))).toBe('59bc7c3cf08fcff32cf523fcd58df01d');
        expect(hex(derive(beforeLimit, last))).toBe('f4820540fc0ac02750739896fe028d56');
        expect(hex(derive(empty(), full))).toBe('f4820540fc0ac02750739896fe028d56');
        expect(() => derive(full, Uint8Array.of(0x61))).toThrow();
        expect(() => derive(Uint8Array.of(0x61), full)).toThrow();
        expect(() => derive(new Uint8Array(limit + 1), empty())).toThrow();
        expect(full[0]).toBe(0x61);
        expect(full[limit - 1]).toBe(0x61);
    });

    it('continues cleanup when set and an earlier cleanup both throw', async () => {
        const first = Uint8Array.of(1, 2, 3);
        const second = Uint8Array.of(4, 5);
        const digest = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
        const originalSet = Uint8Array.prototype.set;
        const originalFill = Uint8Array.prototype.fill;
        const destinations: Uint8Array[] = [];
        const attempted: Uint8Array[] = [];
        let active = false;
        const hash = { update: vi.fn(), digest: vi.fn(() => digest) };
        hash.update.mockReturnValue(hash);
        vi.resetModules();
        vi.doMock('node:crypto', () => ({ createHash: vi.fn(() => hash) }));
        const setSpy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source: ArrayLike<number>,
            offset?: number,
        ) {
            originalSet.call(this, source, offset);

            if (active) {
                destinations.push(this);

                if (destinations.length === 3) {
                    throw new Error('synthetic output copy failure');
                }
            }
        });
        const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value: number,
            start?: number,
            end?: number,
        ) {
            if (active && (destinations.includes(this) || this === digest)) {
                attempted.push(this);

                if (this === destinations[0]) {
                    throw new Error('synthetic cleanup failure');
                }
            }

            return originalFill.call(this, value, start, end);
        });

        try {
            const isolated = await import('../../src/direct/target-machine-guid-digest-candidate');
            active = true;
            expect(() => isolated.deriveTargetMachineGuidDigestCandidate(first, second)).toThrow(
                'target machine GUID digest candidate failed',
            );
            active = false;
            expect(destinations).toHaveLength(3);
            expect(attempted).toEqual([destinations[0], destinations[1], digest, destinations[2]]);
            expect(Array.from(destinations[0])).toEqual([1, 2, 3]);
            expect(Array.from(destinations[1])).toEqual([0, 0]);
            expect(Array.from(digest)).toEqual(new Array(16).fill(0));
            expect(Array.from(destinations[2])).toEqual(new Array(16).fill(0));
            expect(Array.from(first)).toEqual([1, 2, 3]);
            expect(Array.from(second)).toEqual([4, 5]);
        } finally {
            active = false;
            fillSpy.mockRestore();
            setSpy.mockRestore();
            vi.doUnmock('node:crypto');
            vi.resetModules();
        }
    });

    it('clears a partially copied private allocation when set throws', async () => {
        const first = Uint8Array.of(1, 2, 3);
        const second = Uint8Array.of(4, 5);
        const originalSet = Uint8Array.prototype.set;
        let privateCopy: Uint8Array | undefined;
        let active = false;
        vi.resetModules();
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source: ArrayLike<number>,
            offset?: number,
        ) {
            originalSet.call(this, source, offset);

            if (active && !privateCopy) {
                privateCopy = this;
                throw new Error('synthetic set failure');
            }
        });

        try {
            const isolated = await import('../../src/direct/target-machine-guid-digest-candidate');
            active = true;
            expect(() => isolated.deriveTargetMachineGuidDigestCandidate(first, second)).toThrow();
            active = false;
            expect(privateCopy).toBeDefined();
            expect(privateCopy).not.toBe(first);
            expect(privateCopy).not.toBe(second);
            expect(Array.from(privateCopy!)).toEqual(new Array(privateCopy!.byteLength).fill(0));
            expect(Array.from(first)).toEqual([1, 2, 3]);
            expect(Array.from(second)).toEqual([4, 5]);
        } finally {
            active = false;
            spy.mockRestore();
            vi.resetModules();
        }
    });
});
