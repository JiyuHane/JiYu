import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
    decodeTargetServiceBusinessResponse,
    MAX_TARGET_SERVICE_BUSINESS_RESPONSE_BYTES,
} from '../../src/direct/target-service-business-response';

const failure = 'target service business response decoding failed';

describe('target-static raw service business response wrapper', () => {
    it('accepts an empty inclusive wrapper', () => {
        const input = Uint8Array.of(0, 0, 0, 4);
        const result = decodeTargetServiceBusinessResponse(input);
        expect(result.body).toEqual(new Uint8Array());
        expect(result.nextOffset).toBe(4);
        expect(input).toEqual(Uint8Array.of(0, 0, 0, 4));
    });

    it('reads a subview at an offset, leaves trailing bytes, and copies in both directions', () => {
        const backing = Uint8Array.of(99, 88, 0, 0, 0, 7, 97, 98, 99, 42, 77);
        const input = backing.subarray(1, 10);
        const before = Uint8Array.from(backing);
        const result = decodeTargetServiceBusinessResponse(input, 1);
        expect(result.body).toEqual(Uint8Array.of(97, 98, 99));
        expect(result.nextOffset).toBe(8);
        expect(backing).toEqual(before);
        backing[6] = 0;
        expect(result.body[0]).toBe(97);
        result.body[1] = 0;
        expect(backing[7]).toBe(98);
        expect(backing[9]).toBe(42);
    });

    it('rejects truncated prefixes, too-small and incomplete lengths and invalid offsets', () => {
        for (const input of [
            Uint8Array.of(),
            Uint8Array.of(0, 0, 0),
            Uint8Array.of(0, 0, 0, 0),
            Uint8Array.of(0, 0, 0, 3),
            Uint8Array.of(0, 0, 0, 7, 97, 98),
            Uint8Array.of(255, 255, 255, 255),
        ]) {
            expect(() => decodeTargetServiceBusinessResponse(input)).toThrow(failure);
        }

        const valid = Uint8Array.of(0, 0, 0, 4);

        for (const offset of [-1, 0.5, NaN, Infinity, 1, 5, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => decodeTargetServiceBusinessResponse(valid, offset)).toThrow(failure);
        }
    });

    it('enforces the local inclusive cap before copying, allowing unrelated trailing data', () => {
        const cap = MAX_TARGET_SERVICE_BUSINESS_RESPONSE_BYTES;
        const frame = new Uint8Array(cap + 1);
        new DataView(frame.buffer).setUint32(0, cap, false);
        frame[4] = 0xaa;
        frame[cap - 1] = 0xbb;
        const result = decodeTargetServiceBusinessResponse(frame);
        expect(result.nextOffset).toBe(cap);
        expect(result.body.byteLength).toBe(cap - 4);
        expect(result.body[0]).toBe(0xaa);
        expect(result.body[cap - 5]).toBe(0xbb);
        new DataView(frame.buffer).setUint32(0, cap + 1, false);
        expect(() => decodeTargetServiceBusinessResponse(frame)).toThrow(failure);
    });

    it('uses intrinsic slots without invoking shadow properties or iterators', () => {
        const input = Uint8Array.of(0, 0, 0, 7, 97, 98, 99);
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

        expect(decodeTargetServiceBusinessResponse(input).body).toEqual(Uint8Array.of(97, 98, 99));
        const foreign = runInNewContext('new Uint8Array([0, 0, 0, 4])') as Uint8Array;
        expect(decodeTargetServiceBusinessResponse(foreign).nextOffset).toBe(4);
        expect(calls).toBe(0);
    });

    it('does not accept a forged byteLength or read beyond the actual view', () => {
        const backing = Uint8Array.of(0, 0, 0, 7, 97, 98, 99);
        const input = backing.subarray(0, 4);
        let calls = 0;
        Object.defineProperty(input, 'byteLength', {
            get() {
                calls++;
                return backing.byteLength;
            },
        });
        expect(() => decodeTargetServiceBusinessResponse(input)).toThrow(failure);
        expect(calls).toBe(0);
    });

    it('rejects proxies, shared buffers, detached views and forged inputs without callbacks', () => {
        let calls = 0;
        const proxy = new Proxy(Uint8Array.of(0, 0, 0, 4), {
            get() {
                calls++;
                throw new Error('SECRET');
            },
        });
        const revoked = Proxy.revocable(Uint8Array.of(0, 0, 0, 4), {});
        revoked.revoke();
        const fake = Object.defineProperty({}, 'byteLength', {
            get() {
                calls++;
                throw new Error('SECRET');
            },
        });
        const foreignShared = runInNewContext(
            'new Uint8Array(new SharedArrayBuffer(4))',
        ) as Uint8Array;
        const detached = Uint8Array.of(0, 0, 0, 4);
        structuredClone(detached, { transfer: [detached.buffer] });

        for (const value of [
            proxy,
            revoked.proxy,
            fake,
            new Uint8Array(new SharedArrayBuffer(4)),
            foreignShared,
            detached,
            new Uint16Array(4),
            new DataView(new ArrayBuffer(4)),
            null,
        ]) {
            expect(() => decodeTargetServiceBusinessResponse(value as never)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it('rejects an out-of-bounds resizable view and accepts it after regrowth', () => {
        const backing = new ArrayBuffer(8, { maxByteLength: 16 });
        const input = new Uint8Array(backing, 4, 4);
        input.set([0, 0, 0, 4]);
        backing.resize(4);
        expect(() => decodeTargetServiceBusinessResponse(input)).toThrow(failure);
        backing.resize(8);
        input.set([0, 0, 0, 4]);
        expect(decodeTargetServiceBusinessResponse(input).nextOffset).toBe(4);
    });
});
