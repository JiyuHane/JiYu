import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
    decodeTargetSso12ResponseHead,
    MAX_TARGET_SSO12_RESPONSE_HEAD_BYTES,
} from '../../src/direct/target-sso12-response-head';

const failure = 'target sso12 response head decoding failed';

// Synthetic values: no encoding, identity or protocol semantics are inferred.
const fixture = Uint8Array.of(
    0,
    0,
    0,
    40,
    0x80,
    0,
    0,
    1,
    0xff,
    0xff,
    0xff,
    0xff,
    0,
    0,
    0,
    6,
    0xff,
    0,
    0,
    0,
    0,
    5,
    0x80,
    0,
    0,
    0,
    7,
    1,
    2,
    3,
    0xfe,
    0xdc,
    0xba,
    0x99,
    0,
    0,
    0,
    6,
    0x81,
    0x82,
);

function minimum(tail: number[] = []): Uint8Array {
    const bytes = new Uint8Array(32 + tail.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, bytes.length);
    view.setUint32(12, 4);
    view.setUint32(16, 4);
    view.setUint32(20, 4);
    view.setUint32(28, 4);
    bytes.set(tail, 32);
    return bytes;
}

describe('strict local target SSO12 response head', () => {
    it('reads opaque bytes and unsigned words at a subview-relative offset', () => {
        const backing = Uint8Array.from([0xaa, 0xbb, ...fixture, 0xcc, 0xdd]);
        const input = backing.subarray(1, backing.length - 1);
        const before = backing.slice();
        const result = decodeTargetSso12ResponseHead(input, 1);
        expect(result).toEqual({
            headLength: 40,
            sequenceBits: 0x80000001,
            followingWord: 0xffffffff,
            field1: Uint8Array.of(0xff, 0),
            field2: Uint8Array.of(0x80),
            field3: Uint8Array.of(1, 2, 3),
            flagsWord: 0xfedcba99,
            reserve: Uint8Array.of(0x81, 0x82),
            tail: new Uint8Array(),
            nextOffset: 41,
        });
        expect(input[result.nextOffset]).toBe(0xcc);
        expect(backing).toEqual(before);
        result.field1[0] = 1;
        result.field2[0] = 2;
        result.field3[0] = 3;
        result.reserve[0] = 4;
        expect(backing).toEqual(before);
        backing.fill(0);
        expect(result.field1).toEqual(Uint8Array.of(1, 0));
        expect(result.field2).toEqual(Uint8Array.of(2));
        expect(result.field3).toEqual(Uint8Array.of(3, 2, 3));
        expect(result.reserve).toEqual(Uint8Array.of(4, 0x82));
    });

    it('accepts all empty spans at the exact 32-byte minimum', () => {
        const result = decodeTargetSso12ResponseHead(minimum());
        expect(result.headLength).toBe(32);
        expect(result.nextOffset).toBe(32);
        expect([result.field1, result.field2, result.field3, result.reserve, result.tail]).toEqual([
            new Uint8Array(),
            new Uint8Array(),
            new Uint8Array(),
            new Uint8Array(),
            new Uint8Array(),
        ]);
        expect(
            new Set([result.field1, result.field2, result.field3, result.reserve, result.tail])
                .size,
        ).toBe(5);
    });

    it('preserves every tail byte, including incomplete or complete potential words', () => {
        for (const tail of [[], [1], [1, 2], [1, 2, 3], [1, 2, 3, 4], [1, 2, 3, 4, 5]]) {
            const input = minimum(tail);
            const result = decodeTargetSso12ResponseHead(input);
            expect(result.tail).toEqual(Uint8Array.from(tail));
            expect(result.nextOffset).toBe(input.length);
            input.fill(0);
            expect(result.tail).toEqual(Uint8Array.from(tail));

            if (tail.length) {
                result.tail[0] ^= 0xff;
                expect(input[32]).toBe(0);
            }
        }
    });

    it('rejects each truncated head boundary even when bytes exist afterward', () => {
        for (let length = 0; length < 40; length++) {
            const input = Uint8Array.from([...fixture, 1, 2, 3, 4]);
            new DataView(input.buffer).setUint32(0, length);
            const before = input.slice();
            expect(() => decodeTargetSso12ResponseHead(input)).toThrow(failure);
            expect(input).toEqual(before);
        }

        for (let length = 0; length < fixture.length; length++) {
            expect(() => decodeTargetSso12ResponseHead(fixture.subarray(0, length))).toThrow(
                failure,
            );
        }
    });

    it('rejects each small, oversized, and boundary-crossing inclusive field length', () => {
        for (const position of [12, 18, 23, 34]) {
            for (const length of [0, 1, 2, 3, 0xffffffff, 41 - position]) {
                const input = Uint8Array.from([...fixture, ...new Uint8Array(16)]);
                new DataView(input.buffer).setUint32(position, length);
                expect(() => decodeTargetSso12ResponseHead(input)).toThrow(failure);
            }
        }
    });

    it('treats every flags word as opaque and never requires an interpretation of tail', () => {
        for (const flags of [0, 1, 2, 0xffffffff]) {
            const input = minimum([0xff, 0x00]);
            new DataView(input.buffer).setUint32(24, flags);
            const result = decodeTargetSso12ResponseHead(input);
            expect(result.flagsWord).toBe(flags);
            expect(result.tail).toEqual(Uint8Array.of(0xff, 0));
        }
    });

    it('enforces the inclusive 16 MiB local head cap, independent of trailing input', () => {
        const cap = MAX_TARGET_SSO12_RESPONSE_HEAD_BYTES;
        const input = new Uint8Array(cap + 1);
        input.set(minimum());
        const view = new DataView(input.buffer);
        view.setUint32(0, cap);
        input[32] = 0xaa;
        input[cap - 1] = 0xbb;
        input[cap] = 0xcc;
        const result = decodeTargetSso12ResponseHead(input);
        expect(result.tail.length).toBe(cap - 32);
        expect(result.tail[0]).toBe(0xaa);
        expect(result.tail[cap - 33]).toBe(0xbb);
        expect(result.nextOffset).toBe(cap);
        expect(input[cap]).toBe(0xcc);
        view.setUint32(0, cap + 1);
        expect(() => decodeTargetSso12ResponseHead(input)).toThrow(failure);
    });

    it('uses intrinsic slots without invoking shadow getters and accepts foreign views', () => {
        const input = fixture.slice();
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

        expect(decodeTargetSso12ResponseHead(input).field1).toEqual(Uint8Array.of(0xff, 0));
        const foreign = runInNewContext(
            `new Uint8Array([${[...fixture].join(',')}])`,
        ) as Uint8Array;
        expect(decodeTargetSso12ResponseHead(foreign).sequenceBits).toBe(0x80000001);
        expect(calls).toBe(0);
    });

    it('rejects proxies, shared, detached, out-of-bounds and forged views without callbacks', () => {
        let calls = 0;
        const proxy = new Proxy(fixture, {
            get() {
                calls++;
                throw new Error('SECRET');
            },
        });
        const revoked = Proxy.revocable(fixture, {});
        revoked.revoke();
        const protoProxy = new Proxy(Uint8Array.prototype, {
            getPrototypeOf() {
                calls++;
                throw new Error('SECRET');
            },
            get() {
                calls++;
                throw new Error('SECRET');
            },
        });
        const proxyPrototype = fixture.slice();
        Object.setPrototypeOf(proxyPrototype, protoProxy);
        const detached = fixture.slice();
        structuredClone(detached, { transfer: [detached.buffer] });
        const resizable = new ArrayBuffer(48, { maxByteLength: 64 });
        const outOfBounds = new Uint8Array(resizable, 8, 40);
        resizable.resize(8);
        const foreignShared = runInNewContext(
            'new Uint8Array(new SharedArrayBuffer(40))',
        ) as Uint8Array;

        for (const value of [
            proxy,
            revoked.proxy,
            proxyPrototype,
            detached,
            outOfBounds,
            foreignShared,
            new Uint8Array(new SharedArrayBuffer(40)),
            new Uint16Array(40),
            new DataView(new ArrayBuffer(40)),
            null,
            {},
        ]) {
            expect(() => decodeTargetSso12ResponseHead(value as never)).toThrow(failure);
        }

        for (const offset of [-1, 0.5, NaN, Infinity, 1, 41, Number.MAX_SAFE_INTEGER + 1, '0']) {
            expect(() => decodeTargetSso12ResponseHead(fixture, offset as number)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it('clears allocated outputs on a later copy failure and leaves input unchanged', () => {
        const input = fixture.slice();
        const before = input.slice();
        const NativeUint8Array = Uint8Array;
        const allocations: Uint8Array[] = [];
        let count = 0;
        const constructor = new Proxy(NativeUint8Array, {
            construct(target, args) {
                count++;

                if (count === 3) {
                    throw new Error('SECRET');
                }

                const value = Reflect.construct(target, args, target) as Uint8Array;

                if (count === 1) {
                    allocations.push(value);
                }

                return value;
            },
        });
        vi.stubGlobal('Uint8Array', constructor);

        try {
            expect(() => decodeTargetSso12ResponseHead(input)).toThrow(failure);
        } finally {
            vi.unstubAllGlobals();
        }

        expect(allocations).toHaveLength(1);
        expect(allocations[0]).toEqual(Uint8Array.of(0, 0));
        expect(input).toEqual(before);
    });
});
