import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
    decodeTargetSso12ResponseFinal,
    MAX_TARGET_SSO12_RESPONSE_FINAL_BYTES,
} from '../../src/direct/target-sso12-response-final';
import { decodeTargetSso12ResponseHead } from '../../src/direct/target-sso12-response-head';

const failure = 'target sso12 response final decoding failed';

// Synthetic head fields: each inclusive field contains one distinct byte.
function fixture(tail: number[] = [], after: number[] = []): Uint8Array {
    const bytes = new Uint8Array(36 + tail.length + after.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 36 + tail.length);
    view.setUint32(4, 0x80000001);
    view.setUint32(8, 0xffffffff);
    view.setUint32(12, 5);
    bytes[16] = 0x11;
    view.setUint32(17, 5);
    bytes[21] = 0x22;
    view.setUint32(22, 5);
    bytes[26] = 0x33;
    view.setUint32(27, 0xfedcba98);
    view.setUint32(31, 5);
    bytes[35] = 0x44;
    bytes.set(tail, 36);
    bytes.set(after, 36 + tail.length);
    return bytes;
}

describe('strict-subset target SSO12 final word', () => {
    it('retains prior for zero to three available bytes and reads four or five unsigned bytes', () => {
        const data = [0x80, 0x23, 0x45, 0x67, 0x89];

        for (let n = 0; n <= data.length; n++) {
            const input = fixture(data.slice(0, n));
            const before = input.slice();
            const prior = 0xfedcba98;
            const result = decodeTargetSso12ResponseFinal(input, 0, prior);
            expect(result.finalWordRead).toBe(n >= 4);
            expect(result.finalWord).toBe(n >= 4 ? 0x80234567 : prior);
            expect(result.head).toEqual(decodeTargetSso12ResponseHead(input));
            expect(result.head.tail).toEqual(Uint8Array.from(data.slice(0, n)));
            expect(result.head.nextOffset).toBe(input.length);
            expect(input).toEqual(before);
        }
    });

    it('reads across the declared head boundary without consuming or changing tail', () => {
        for (let n = 0; n <= 3; n++) {
            const data = [0xfe, 0xdc, 0xba, 0x98, 0x12];
            const input = fixture(data.slice(0, n), data.slice(n));
            const result = decodeTargetSso12ResponseFinal(input, 0, 7);
            expect(result.finalWordRead).toBe(true);
            expect(result.finalWord).toBe(0xfedcba98);
            expect(result.head.tail).toEqual(Uint8Array.from(data.slice(0, n)));
            expect(result.head.nextOffset).toBe(36 + n);
        }
    });

    it('uses view-relative offsets and excludes backing-store decoys', () => {
        const packet = fixture([0x80, 1, 2]);
        const backing = Uint8Array.from([0xaa, 0xbb, 0xcc, ...packet, 0xff, 0xee, 0xdd, 0xcc]);
        const input = backing.subarray(1, backing.length - 4);
        const before = backing.slice();
        const result = decodeTargetSso12ResponseFinal(input, 2, 0xffffffff);
        expect(result.finalWordRead).toBe(false);
        expect(result.finalWord).toBe(0xffffffff);
        expect(result.head.nextOffset).toBe(2 + packet.length);
        expect(result.head.tail).toEqual(Uint8Array.of(0x80, 1, 2));
        expect(backing).toEqual(before);
        backing.fill(0);
        expect(result.head.field1).toEqual(Uint8Array.of(0x11));
        expect(result.head.tail).toEqual(Uint8Array.of(0x80, 1, 2));
        result.head.field1[0] = 0x77;
        expect(result.head.field2).toEqual(Uint8Array.of(0x22));
        expect(backing.every((value) => value === 0)).toBe(true);
    });

    it('rejects strict-head boundary crossings even where following bytes exist', () => {
        const input = fixture([], [1, 2, 3, 4]);
        new DataView(input.buffer).setUint32(0, 35);
        expect(() => decodeTargetSso12ResponseFinal(input, 0, 0)).toThrow(failure);
    });

    it('validates primitive offsets and unsigned prior without coercion', () => {
        const input = fixture();

        for (const offset of [-1, 0.5, NaN, Infinity, 37, Number.MAX_SAFE_INTEGER + 1, '0', 0n]) {
            expect(() => decodeTargetSso12ResponseFinal(input, offset as number, 0)).toThrow(
                failure,
            );
        }

        for (const prior of [-1, 0.5, NaN, Infinity, 0x100000000, '0', 0n, null]) {
            expect(() => decodeTargetSso12ResponseFinal(input, 0, prior as number)).toThrow(
                failure,
            );
        }

        expect(decodeTargetSso12ResponseFinal(input, 0, 0).finalWord).toBe(0);
        expect(decodeTargetSso12ResponseFinal(input, 0, 0xffffffff).finalWord).toBe(0xffffffff);
    });

    it('enforces the whole-view local 16 MiB limit even outside the parsed head', () => {
        const cap = MAX_TARGET_SSO12_RESPONSE_FINAL_BYTES;
        const backing = new Uint8Array(cap + 2);
        backing.set(fixture(), 1);
        const withinCap = backing.subarray(1, cap + 1);
        const result = decodeTargetSso12ResponseFinal(withinCap, 0, 9);
        expect(result.finalWordRead).toBe(true);
        expect(result.head.nextOffset).toBe(36);
        expect(() => decodeTargetSso12ResponseFinal(backing.subarray(0, cap + 1), 1, 9)).toThrow(
            failure,
        );
        expect(() => decodeTargetSso12ResponseFinal(backing, 1, 9)).toThrow(failure);
    });

    it('uses intrinsic slots without invoking shadow getters and accepts foreign views', () => {
        const input = fixture([1, 2, 3, 4]);
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

        expect(decodeTargetSso12ResponseFinal(input, 0, 0).finalWord).toBe(0x01020304);
        const inherited = fixture([1, 2, 3, 4]);
        const prototype = Object.create(Uint8Array.prototype) as object;
        Object.defineProperty(prototype, 'buffer', {
            get() {
                calls++;
                throw new Error('SECRET');
            },
        });
        Object.setPrototypeOf(inherited, prototype);
        expect(decodeTargetSso12ResponseFinal(inherited, 0, 0).finalWord).toBe(0x01020304);
        const foreign = runInNewContext(
            `new Uint8Array([${[...fixture([1, 2, 3, 4])].join(',')}])`,
        ) as Uint8Array;
        expect(decodeTargetSso12ResponseFinal(foreign, 0, 0).finalWord).toBe(0x01020304);
        expect(calls).toBe(0);
    });

    it('rejects proxy, shared, detached, out-of-bounds and forged inputs without callbacks', () => {
        const sample = fixture();
        let calls = 0;
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
        const proxy = new Proxy(sample, handler);
        const revoked = Proxy.revocable(sample, {});
        revoked.revoke();
        const proxyPrototype = sample.slice();
        Object.setPrototypeOf(proxyPrototype, new Proxy(Uint8Array.prototype, handler));
        const detached = sample.slice();
        structuredClone(detached, { transfer: [detached.buffer] });
        const resizable = new ArrayBuffer(48, { maxByteLength: 64 });
        const outOfBounds = new Uint8Array(resizable, 8, 40);
        resizable.resize(8);
        const foreignShared = runInNewContext('new Uint8Array(new SharedArrayBuffer(40))');

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
            expect(() => decodeTargetSso12ResponseFinal(value as never, 0, 0)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it('clears the snapshot and every returned head array on later failure', () => {
        const input = fixture([1, 2, 3, 4]);
        const before = input.slice();
        const NativeUint8Array = Uint8Array;
        const NativeDataView = DataView;
        const allocations: Uint8Array[] = [];
        let dataViews = 0;
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
        vi.stubGlobal(
            'DataView',
            new Proxy(NativeDataView, {
                construct(target, args) {
                    if (++dataViews === 3) {
                        throw new Error('SECRET');
                    }

                    return Reflect.construct(target, args, target);
                },
            }),
        );

        try {
            expect(() => decodeTargetSso12ResponseFinal(input, 0, 0)).toThrow(failure);
        } finally {
            vi.unstubAllGlobals();
        }

        expect(dataViews).toBe(3);
        expect(allocations.map((bytes) => bytes.length)).toEqual([40, 1, 1, 1, 1, 4]);
        expect(allocations.every((bytes) => bytes.every((value) => value === 0))).toBe(true);
        expect(input).toEqual(before);
    });
});
