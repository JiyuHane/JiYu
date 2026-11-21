import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { deriveTargetWtTgtgtKeyCandidate as derive } from '../../src/direct/target-wt-tgtgt-key-candidate';

const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');
const word = 0x0123456789abcdefn;

// Independently calculated once with Node crypto MD5 over explicitly assembled
// 24-byte synthetic messages: 16-byte padded prefix followed by BE64 word.
// These fixtures make no claim about an input's identity or business meaning.
const prefixVectors = [
    '52603059a22dc911f7e987950d113446',
    '52603059a22dc911f7e987950d113446',
    'e6ded0435ca6674de0ab32a6b7ce36f9',
    '99340940708d3bbb50d1de1f19bbab71',
    '9156106af3a92f244ffc5a80be57d914',
    'f7ceb91dcb169bb89a278cc20d73c894',
    '77010b504131ab133ee7d36f79a3d0ea',
    '88a8527c4b7a287a4dd035bb48a01f09',
    'cf7520939cd9dbdac4deb3d34e27c199',
    'd60086a6c959f58b2875a2ef5abff15c',
    'ff9eeeb21688b1a49909878ba2df5a57',
    '0356e3ff0aa88081c62b2bb4606dd102',
    'd7f6ea499e7e902d8b42a36514bae1a0',
    '1a10cb72e6c9b1883d6e485ddd078036',
    '91f09da8139c6bd7a1479b2d267fa7fa',
    '5632465f8c57b22cf6b14673ea5d45da',
    'bfb2ad3f64569d86ddd86477fcf67880',
] as const;

describe('offline target WT tgtgt key candidate', () => {
    it('matches fixed independent MD5 vectors for every source length 0 through 24', () => {
        for (let length = 0; length <= 24; length++) {
            const source = Uint8Array.from({ length }, (_, index) => index);
            const before = source.slice();
            const result = derive(source, word);
            expect(result).toBeInstanceOf(Uint8Array);
            expect(result.byteLength).toBe(16);
            expect(hex(result)).toBe(prefixVectors[Math.min(length, 16)]);
            expect(source).toEqual(before);
        }
    });

    it('overwrites all bytes at positions 16 through 23 rather than hashing them', () => {
        const prefix = Uint8Array.from({ length: 16 }, (_, index) => index);

        for (let length = 16; length <= 24; length++) {
            const source = new Uint8Array(length).fill(0xff);
            source.set(prefix);
            expect(hex(derive(source, word))).toBe('bfb2ad3f64569d86ddd86477fcf67880');
        }

        for (const length of [25, 26, 32, 256]) {
            expect(() => derive(new Uint8Array(length), word)).toThrow();
        }
    });

    it.each([
        ['', 0n, '1681ffc6e046c7af98c9e6c232a3fe0a'],
        ['', 0xffffffffffffffffn, '00eb11fa1cad5042eaa2aefd6cf92615'],
        ['00ff80', 0n, 'c53e868b6f82c0d6d0a0a79ddea40675'],
        ['00ff80', 1n, '6cd8c450393152d5912bc2d9bfd24134'],
        ['00ff80', 0x8000000000000000n, '7396e305958e1751bacbf635025ea2dd'],
        ['00ff80', 0xffffffffffffffffn, '7c7db16ba19e5ac0d370d859234fda67'],
    ] as const)('encodes unsigned BE64 boundary %# exactly', (source, value, expected) => {
        expect(hex(derive(Buffer.from(source, 'hex'), value))).toBe(expected);
    });

    it('copies only a Buffer subview and foreign-realm subview, with independent output', () => {
        const backing = Buffer.from([0x91, 0x00, 0xff, 0x80, 0x92]);
        const slice = backing.subarray(1, 4);
        const foreign = runInNewContext(
            'new Uint8Array([0x91, 0x00, 0xff, 0x80, 0x92]).subarray(1, 4)',
        ) as Uint8Array;
        const expected = 'c53e868b6f82c0d6d0a0a79ddea40675';
        const first = derive(slice, 0n);
        const second = derive(foreign, 0n);
        expect(hex(first)).toBe(expected);
        expect(hex(second)).toBe(expected);
        expect(backing).toEqual(Buffer.from([0x91, 0, 0xff, 0x80, 0x92]));
        expect(first.buffer).not.toBe(slice.buffer);
        expect(second.buffer).not.toBe(foreign.buffer);
        backing.fill(0x55);
        foreign.fill(0x66);
        expect(hex(first)).toBe(expected);
        expect(hex(second)).toBe(expected);
        first.fill(0xaa);
        expect(backing).toEqual(Buffer.alloc(5, 0x55));
        expect(Array.from(foreign)).toEqual([0x66, 0x66, 0x66]);
        expect(hex(second)).toBe(expected);
    });

    it('reads genuine views without invoking shadow accessor properties', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('synthetic accessor');
        };

        const source = runInNewContext('new Uint8Array([0, 255, 128])') as Uint8Array;

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
            Object.defineProperty(source, name, { get: trap, set: trap });
        }

        expect(hex(derive(source, 0n))).toBe('c53e868b6f82c0d6d0a0a79ddea40675');
        expect(calls).toBe(0);
    });

    it('rejects non-U8, proxy, shared, detached and out-of-bounds views without traps', () => {
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
        const proto = Uint8Array.of(1);
        Object.setPrototypeOf(proto, new Proxy(Uint8Array.prototype, { getPrototypeOf: trap }));
        const revoked = Proxy.revocable(Uint8Array.of(1), {});
        revoked.revoke();
        const invalid: unknown[] = [
            null,
            undefined,
            'abc',
            [1],
            {},
            new ArrayBuffer(1),
            new Uint16Array(1),
            new Uint8ClampedArray(1),
            new DataView(new ArrayBuffer(1)),
            detached,
            outOfBounds,
            proto,
            revoked.proxy,
            new Proxy(Uint8Array.of(1), { get: trap, getPrototypeOf: trap }),
            new Uint8Array(new SharedArrayBuffer(1)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(1))'),
        ];

        for (const value of invalid) {
            expect(() => derive(value as Uint8Array, 0n)).toThrow();
        }

        expect(calls).toBe(0);
    });

    it('rejects out-of-range and non-primitive bigint words without coercion', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('synthetic coercion');
        };

        const object = { valueOf: trap, [Symbol.toPrimitive]: trap };
        const invalid: unknown[] = [
            -1n,
            -(1n << 64n),
            1n << 64n,
            (1n << 128n) - 1n,
            undefined,
            null,
            0,
            1,
            -1,
            NaN,
            Infinity,
            '0',
            true,
            Object(1n),
            object,
            new Proxy(object, { get: trap, getPrototypeOf: trap }),
        ];

        for (const value of invalid) {
            expect(() => derive(new Uint8Array(), value as bigint)).toThrow();
        }

        expect(calls).toBe(0);
    });

    it('uses the source snapshot even if the caller changes after the copy', async () => {
        const source = Uint8Array.of(0x80, 0xff, 1);
        const originalSet = Uint8Array.prototype.set;
        let copies = 0;
        vi.resetModules();
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            value: ArrayLike<number>,
            offset?: number,
        ) {
            originalSet.call(this, value, offset);

            if (++copies === 1) {
                source.fill(0);
            }
        });

        try {
            const isolated = await import('../../src/direct/target-wt-tgtgt-key-candidate');
            expect(hex(isolated.deriveTargetWtTgtgtKeyCandidate(source, 0n))).toBe(
                'dcc3b2e0ae5da23a28a31aeef58fc3ce',
            );
            expect(copies).toBeGreaterThan(0);
            expect(source).toEqual(new Uint8Array(3));
        } finally {
            spy.mockRestore();
            vi.resetModules();
        }
    });
});
