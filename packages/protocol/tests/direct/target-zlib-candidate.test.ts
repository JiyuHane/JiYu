import { runInNewContext } from 'node:vm';
import { deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
    inflateTargetZlibCandidate,
    MAX_TARGET_ZLIB_CANDIDATE_BYTES,
} from '../../src/direct/target-zlib-candidate';

const failure = 'target zlib candidate decoding failed';

describe('local bounded zlib candidate', () => {
    it('decodes a known static zlib vector and independent binary output', () => {
        const vector = Uint8Array.of(
            0x78,
            0x9c,
            0x4b,
            0x4c,
            0x4a,
            0x06,
            0x00,
            0x02,
            0x4d,
            0x01,
            0x27,
        );
        expect(inflateTargetZlibCandidate(vector, 3)).toEqual(Uint8Array.of(97, 98, 99));
        const original = Uint8Array.of(0, 255, 42, 128, 0, 1);
        const compressed = deflateSync(original);
        const backing = new Uint8Array(compressed.length + 2);
        backing.set(compressed, 1);
        const before = backing.slice();
        const output = inflateTargetZlibCandidate(backing.subarray(1, -1), original.length);
        expect(output).toEqual(original);
        expect(backing).toEqual(before);
        output[0] = 99;
        expect(backing).toEqual(before);
        backing.fill(0);
        expect(output.subarray(1)).toEqual(original.subarray(1));
    });

    it('permits a valid empty stream with a zero limit but no nonempty output', () => {
        expect(inflateTargetZlibCandidate(deflateSync(new Uint8Array()), 0)).toEqual(
            new Uint8Array(),
        );
        expect(() => inflateTargetZlibCandidate(deflateSync(Uint8Array.of(1)), 0)).toThrow(failure);
        expect(() => inflateTargetZlibCandidate(new Uint8Array(), 0)).toThrow(failure);
    });

    it('enforces exact output boundaries and rejects expansion beyond the cap', () => {
        const output = new Uint8Array(MAX_TARGET_ZLIB_CANDIDATE_BYTES);
        output[0] = 1;
        output[output.length - 1] = 2;
        const compressed = deflateSync(output);
        const result = inflateTargetZlibCandidate(compressed, output.length);
        expect(Buffer.compare(result, output)).toBe(0);
        expect(() => inflateTargetZlibCandidate(compressed, output.length - 1)).toThrow(failure);
        expect(() =>
            inflateTargetZlibCandidate(deflateSync(new Uint8Array(1024 * 1024)), 1024),
        ).toThrow(failure);
        expect(() =>
            inflateTargetZlibCandidate(new Uint8Array(MAX_TARGET_ZLIB_CANDIDATE_BYTES + 1), 1),
        ).toThrow(failure);
    });

    it('rejects truncated, corrupt, non-zlib, gzip and raw-deflate bytes with one error', () => {
        const good = deflateSync(Uint8Array.of(1, 2, 3, 4));
        const corrupt = Uint8Array.from(good);
        corrupt[corrupt.length - 1] ^= 0xff;

        for (const value of [
            good.subarray(0, good.length - 1),
            good.subarray(0, 2),
            corrupt,
            Uint8Array.of(1, 2, 3),
            gzipSync(Uint8Array.of(1, 2, 3)),
            deflateRawSync(Uint8Array.of(1, 2, 3)),
        ]) {
            const before = Uint8Array.from(value);
            expect(() => inflateTargetZlibCandidate(value, 100)).toThrow(failure);
            expect(Buffer.compare(value, before)).toBe(0);
        }
    });

    it('rejects all trailing bytes, including zero and a second zlib member', () => {
        const good = deflateSync(Uint8Array.of(1, 2, 3));

        for (const suffix of [Uint8Array.of(0), Uint8Array.of(255, 0, 7), good]) {
            const input = Buffer.concat([good, suffix]);
            expect(() => inflateTargetZlibCandidate(input, 100)).toThrow(failure);
        }
    });

    it('validates explicit integer limits without conversion', () => {
        const good = deflateSync(Uint8Array.of(1));

        for (const limit of [
            -1,
            0.5,
            NaN,
            Infinity,
            MAX_TARGET_ZLIB_CANDIDATE_BYTES + 1,
            undefined,
            '5',
            {},
        ]) {
            expect(() => inflateTargetZlibCandidate(good, limit as number)).toThrow(failure);
        }
    });

    it('reads intrinsic typed-array slots without invoking shadow getters or iterators', () => {
        const input = Uint8Array.from(deflateSync(Uint8Array.of(7, 8)));
        let calls = 0;

        for (const name of [
            'length',
            'byteLength',
            'byteOffset',
            'buffer',
            Symbol.iterator,
            Symbol.toStringTag,
        ]) {
            Object.defineProperty(input, name, {
                get() {
                    calls++;
                    throw new Error('SECRET');
                },
            });
        }

        expect(inflateTargetZlibCandidate(input, 2)).toEqual(Uint8Array.of(7, 8));
        const foreign = runInNewContext(
            'new Uint8Array([120,156,75,76,74,6,0,2,77,1,39])',
        ) as Uint8Array;
        expect(inflateTargetZlibCandidate(foreign, 3)).toEqual(Uint8Array.of(97, 98, 99));
        expect(calls).toBe(0);
    });

    it('rejects proxy, shared, detached, forged and other views without callbacks', () => {
        let calls = 0;
        const proxy = new Proxy(Uint8Array.of(1), {
            get() {
                calls++;
                throw new Error('SECRET');
            },
        });
        const revoked = Proxy.revocable(Uint8Array.of(1), {});
        revoked.revoke();
        const fake = Object.defineProperty({}, 'byteLength', {
            get() {
                calls++;
                throw new Error('SECRET');
            },
        });
        const detached = Uint8Array.of(1);
        structuredClone(detached, { transfer: [detached.buffer] });
        const foreignShared = runInNewContext(
            'new Uint8Array(new SharedArrayBuffer(8))',
        ) as Uint8Array;

        for (const value of [
            proxy,
            revoked.proxy,
            fake,
            detached,
            new Uint8Array(new SharedArrayBuffer(8)),
            foreignShared,
            new Uint16Array(4),
            new DataView(new ArrayBuffer(4)),
            null,
        ]) {
            expect(() => inflateTargetZlibCandidate(value as never, 10)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it('rejects out-of-bounds resizable views and accepts valid regrown views', () => {
        const compressed = deflateSync(Uint8Array.of(7));
        const backing = new ArrayBuffer(compressed.length + 4, {
            maxByteLength: compressed.length + 8,
        });
        const input = new Uint8Array(backing, 4, compressed.length);
        input.set(compressed);
        backing.resize(4);
        expect(() => inflateTargetZlibCandidate(input, 1)).toThrow(failure);
        backing.resize(compressed.length + 4);
        input.set(compressed);
        expect(inflateTargetZlibCandidate(input, 1)).toEqual(Uint8Array.of(7));
    });
});
