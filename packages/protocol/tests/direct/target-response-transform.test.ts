import { runInNewContext } from 'node:vm';
import { deflateRawSync, deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
    MAX_TARGET_RESPONSE_TRANSFORM_BYTES as cap,
    transformTargetResponse,
} from '../../src/direct/target-response-transform';

const failure = 'target response transform failed';

// Synthetic fields and wrapper; no identity or wire-compatibility meaning.
function fixture(
    body: Uint8Array = Uint8Array.of(1, 2, 3),
    flags = 0,
    skip: 0 | 4 = 0,
    outerTail: number[] = [],
): Uint8Array {
    const headLength = 38;
    const bytes = new Uint8Array(headLength + skip + 4 + body.length + outerTail.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, headLength);
    view.setUint32(4, 0x80000001);
    view.setUint32(8, 0xffffffff);
    view.setUint32(12, 5);
    bytes[16] = 0xa1;
    view.setUint32(17, 5);
    bytes[21] = 0xb2;
    view.setUint32(22, 5);
    bytes[26] = 0xc3;
    view.setUint32(27, flags);
    view.setUint32(31, 5);
    bytes[35] = 0xd4;
    bytes.set([0xe5, 0xf6], 36);
    bytes.fill(0x89, headLength, headLength + skip);
    view.setUint32(headLength + skip, body.length + 4);
    bytes.set(body, headLength + skip + 4);
    bytes.set(outerTail, headLength + skip + 4 + body.length);
    return bytes;
}

const run = (bytes: Uint8Array, skip: 0 | 4 = 0, limit = cap) =>
    transformTargetResponse(bytes, skip, 'node-zlib-strict', limit);

describe('local strict target response transform', () => {
    it('preserves head fields and opaque tail, offsets, flags and outer trailing bytes', () => {
        for (const flags of [0, 2, 0xfffffffe]) {
            for (const skip of [0, 4] as const) {
                const input = fixture(Uint8Array.of(10, 11), flags, skip, [90, 91]);
                const result = run(input, skip, 2);
                expect(result.head).toEqual({
                    headLength: 38,
                    sequenceBits: 0x80000001,
                    followingWord: 0xffffffff,
                    field1: Uint8Array.of(0xa1),
                    field2: Uint8Array.of(0xb2),
                    field3: Uint8Array.of(0xc3),
                    flagsWord: flags,
                    reserve: Uint8Array.of(0xd4),
                    tail: Uint8Array.of(0xe5, 0xf6),
                    nextOffset: 38,
                });
                expect(result.body).toEqual(Uint8Array.of(10, 11));
                expect(result.compression).toBe('none');
                expect(result.businessOffset).toBe(38 + skip);
                expect(result.nextOffset).toBe(input.length - 2);
                expect(input.slice(result.nextOffset)).toEqual(Uint8Array.of(90, 91));
            }
        }
    });

    it('keeps independent results even for a bounded subview and never mutates the input', () => {
        const bytes = fixture();
        const backing = Uint8Array.from([17, 18, ...bytes, 19]);
        const original = backing.slice();
        const result = run(backing.subarray(2, -1));
        expect(backing).toEqual(original);
        result.head.field1[0] = 42;
        result.body[0] = 43;
        expect(backing).toEqual(original);
        backing.fill(0);
        expect(result.head.field2).toEqual(Uint8Array.of(0xb2));
        expect(result.head.tail).toEqual(Uint8Array.of(0xe5, 0xf6));
        expect(result.body).toEqual(Uint8Array.of(43, 2, 3));
    });

    it('applies explicit skip, requiring at least five post-head bytes plus a valid wrapper', () => {
        const good = fixture(new Uint8Array(), 0, 4);
        expect(run(good, 4, 0).body).toEqual(new Uint8Array());
        expect(run(fixture(new Uint8Array()), 0, 0).body).toEqual(new Uint8Array());

        for (let n = 0; n < 8; n++) {
            expect(() => run(good.subarray(0, 38 + n), 4)).toThrow(failure);
        }

        expect(() => run(good, 0)).toThrow(failure);
    });

    it('rejects all truncations and incomplete or undersized wrappers with one error', () => {
        const good = fixture();

        for (let n = 0; n < good.length; n++) {
            expect(() => run(good.subarray(0, n))).toThrow(failure);
        }

        for (const length of [0, 1, 2, 3, 8, 0xffffffff]) {
            const bad = good.slice();
            new DataView(bad.buffer).setUint32(38, length);
            expect(() => run(bad)).toThrow(failure);
        }

        const badHead = good.slice();
        new DataView(badHead.buffer).setUint32(12, 31);
        expect(() => run(badHead)).toThrow(failure);
    });

    it('uses only bit zero for compression, and rejects it explicitly when requested', () => {
        const encoded = deflateSync(Uint8Array.of(7, 8));
        expect(transformTargetResponse(fixture(encoded, 0), 0, 'reject', cap).body).toEqual(
            Uint8Array.from(encoded),
        );
        expect(run(fixture(encoded, 0), 0).body).toEqual(Uint8Array.from(encoded));

        for (const flags of [1, 3, 0xffffffff]) {
            const input = fixture(encoded, flags);
            expect(() => transformTargetResponse(input, 0, 'reject', cap)).toThrow(failure);
            const result = run(input, 0, 2);
            expect(result.head.flagsWord).toBe(flags);
            expect(result.compression).toBe('node-zlib-strict');
            expect(result.body).toEqual(Uint8Array.of(7, 8));
        }
    });

    it('requires one complete zlib member within the wrapper, excluding its outer tail', () => {
        const z = deflateSync(Uint8Array.of(1, 2, 3));
        const input = fixture(z, 1, 0, [0, 42]);
        const decoded = run(input, 0, 3);
        expect(decoded.body).toEqual(Uint8Array.of(1, 2, 3));
        expect(input.slice(decoded.nextOffset)).toEqual(Uint8Array.of(0, 42));

        for (const bad of [
            Buffer.concat([z, Buffer.of(0)]),
            Buffer.concat([z, z]),
            gzipSync(Uint8Array.of(1, 2, 3)),
            deflateRawSync(Uint8Array.of(1, 2, 3)),
            new Uint8Array(),
        ]) {
            expect(() => run(fixture(bad, 1))).toThrow(failure);
        }

        for (let n = 0; n < z.length; n++) {
            expect(() => run(fixture(z.subarray(0, n), 1))).toThrow(failure);
        }
    });

    it('enforces the output budget for both branches including zero and 16 MiB', () => {
        expect(run(fixture(new Uint8Array()), 0, 0).body.length).toBe(0);
        expect(run(fixture(deflateSync(new Uint8Array()), 1), 0, 0).body.length).toBe(0);
        expect(() => run(fixture(Uint8Array.of(1)), 0, 0)).toThrow(failure);
        expect(() => run(fixture(deflateSync(Uint8Array.of(1)), 1), 0, 0)).toThrow(failure);
        expect(() => run(fixture(Uint8Array.of(1, 2)), 0, 1)).toThrow(failure);
        expect(() => run(fixture(deflateSync(Uint8Array.of(1, 2)), 1), 0, 1)).toThrow(failure);
        const expanded = new Uint8Array(cap);
        expanded[cap - 1] = 7;
        const compressed = fixture(deflateSync(expanded), 1);
        const result = run(compressed, 0, cap);
        expect(result.body.length).toBe(cap);
        expect(result.body[cap - 1]).toBe(7);
        expect(() => run(compressed, 0, cap - 1)).toThrow(failure);
        expect(() => run(new Uint8Array(cap + 1))).toThrow(failure);
        const atCap = new Uint8Array(cap);
        atCap.set(fixture());
        expect(run(atCap).body).toEqual(Uint8Array.of(1, 2, 3));
    });

    it('validates every required argument even when flags bit zero is clear', () => {
        const input = fixture();

        for (const value of [-1, 1, 5, NaN, undefined, '0']) {
            expect(() => transformTargetResponse(input, value as 0, 'reject', cap)).toThrow(
                failure,
            );
        }

        for (const value of [undefined, '', 'none', {}, 'SECRET']) {
            expect(() => transformTargetResponse(input, 0, value as 'reject', cap)).toThrow(
                failure,
            );
        }

        for (const value of [-1, 0.5, NaN, Infinity, cap + 1, undefined, '3', {}]) {
            expect(() => transformTargetResponse(input, 0, 'reject', value as number)).toThrow(
                failure,
            );
        }
    });

    it('rejects proxy chains, shared, detached and out-of-bounds views without callbacks', () => {
        let calls = 0;
        const input = fixture();
        const handler = {
            get() {
                calls++;
                throw new Error('SECRET');
            },
            getPrototypeOf() {
                calls++;
                throw new Error('SECRET');
            },
        };
        const proxy = new Proxy(input, handler);
        const revoked = Proxy.revocable(input, {});
        revoked.revoke();
        const proxyPrototype = input.slice();
        Object.setPrototypeOf(proxyPrototype, new Proxy(Uint8Array.prototype, handler));
        const detached = input.slice();
        structuredClone(detached, { transfer: [detached.buffer] });
        const resizable = new ArrayBuffer(input.length + 4, { maxByteLength: input.length + 8 });
        const outOfBounds = new Uint8Array(resizable, 4, input.length);
        resizable.resize(4);
        const foreignShared = runInNewContext(
            'new Uint8Array(new SharedArrayBuffer(50))',
        ) as Uint8Array;

        for (const value of [
            proxy,
            revoked.proxy,
            proxyPrototype,
            detached,
            outOfBounds,
            foreignShared,
            new Uint8Array(new SharedArrayBuffer(50)),
            new Uint16Array(50),
            new DataView(new ArrayBuffer(50)),
            null,
            {},
        ]) {
            expect(() => run(value as Uint8Array)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it('uses intrinsic slots and accepts ordinary foreign views without shadow callbacks', () => {
        const input = fixture();
        let calls = 0;

        for (const key of [
            'length',
            'byteLength',
            'byteOffset',
            'buffer',
            Symbol.iterator,
            Symbol.toStringTag,
        ]) {
            Object.defineProperty(input, key, {
                get() {
                    calls++;
                    throw new Error('SECRET');
                },
            });
        }

        expect(run(input).body).toEqual(Uint8Array.of(1, 2, 3));
        const foreign = runInNewContext(
            `new Uint8Array([${[...fixture()].join(',')}])`,
        ) as Uint8Array;
        expect(run(foreign).head.sequenceBits).toBe(0x80000001);
        expect(calls).toBe(0);
    });

    it('clears owned head and snapshot allocations after a late failure', () => {
        const input = fixture(Uint8Array.of(1), 1);
        const before = input.slice();
        const NativeUint8Array = Uint8Array;
        const allocations: Uint8Array[] = [];
        vi.stubGlobal(
            'Uint8Array',
            new Proxy(NativeUint8Array, {
                construct(target, args) {
                    const result = Reflect.construct(target, args, target) as Uint8Array;

                    if (typeof args[0] === 'number') {
                        allocations.push(result);
                    }

                    return result;
                },
            }),
        );

        try {
            expect(() => transformTargetResponse(input, 0, 'reject', cap)).toThrow(failure);
        } finally {
            vi.unstubAllGlobals();
        }

        expect(allocations.length).toBeGreaterThanOrEqual(7);
        expect(allocations.every((array) => array.every((byte) => byte === 0))).toBe(true);
        expect(input).toEqual(before);
    });
});
