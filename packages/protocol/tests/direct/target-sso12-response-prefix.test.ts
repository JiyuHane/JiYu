import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
    decodeTargetSso12ResponsePrefix,
    MAX_TARGET_SSO12_RESPONSE_PREFIX_BYTES,
} from '../../src/direct/target-sso12-response-prefix';

const failure = 'target sso12 response prefix decoding failed';

describe('target-static SSO12 response prefix probe', () => {
    it('accepts only the minimum prefix even without trailing bytes', () => {
        const input = Uint8Array.of(0, 0, 0, 12, 0x80, 0, 0, 1, 0xff, 0xff, 0xff, 0xff);
        expect(decodeTargetSso12ResponsePrefix(input)).toEqual({
            headLength: 12,
            sequenceBits: 0x80000001,
            followingWord: 0xffffffff,
            remainingHead: new Uint8Array(),
            nextOffset: 12,
        });
    });

    it('reads a subview and offset, preserves trailing bytes, and copies remaining head', () => {
        const backing = Uint8Array.of(
            99,
            88,
            0,
            0,
            0,
            15,
            0xff,
            0xfe,
            0xfd,
            0xfc,
            1,
            2,
            3,
            4,
            10,
            11,
            12,
            42,
            77,
        );
        const input = backing.subarray(1, 18);
        const before = Uint8Array.from(backing);
        const result = decodeTargetSso12ResponsePrefix(input, 1);
        expect(result).toEqual({
            headLength: 15,
            sequenceBits: 0xfffefdfc,
            followingWord: 0x01020304,
            remainingHead: Uint8Array.of(10, 11, 12),
            nextOffset: 16,
        });
        expect(backing).toEqual(before);
        backing[14] = 30;
        expect(result.remainingHead[0]).toBe(10);
        result.remainingHead[1] = 31;
        expect(backing[15]).toBe(11);
        expect(backing[17]).toBe(42);
    });

    it('enforces the local minimum and remaining view independently of backing bytes', () => {
        for (let length = 0; length < 12; length++) {
            const input = new Uint8Array(12);
            new DataView(input.buffer).setUint32(0, length);
            expect(() => decodeTargetSso12ResponsePrefix(input)).toThrow(failure);
        }

        for (let length = 0; length < 12; length++) {
            expect(() => decodeTargetSso12ResponsePrefix(new Uint8Array(length))).toThrow(failure);
        }

        const backing = new Uint8Array(20);
        new DataView(backing.buffer).setUint32(0, 16);
        expect(() => decodeTargetSso12ResponsePrefix(backing.subarray(0, 15))).toThrow(failure);
        expect(() =>
            decodeTargetSso12ResponsePrefix(
                Uint8Array.of(255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0),
            ),
        ).toThrow(failure);

        for (const offset of [-1, 0.5, NaN, Infinity, 1, 13, Number.MAX_SAFE_INTEGER + 1, '0']) {
            expect(() =>
                decodeTargetSso12ResponsePrefix(new Uint8Array(12), offset as number),
            ).toThrow(failure);
        }
    });

    it('enforces the inclusive local cap while retaining unrelated trailing bytes', () => {
        const cap = MAX_TARGET_SSO12_RESPONSE_PREFIX_BYTES;
        const input = new Uint8Array(cap + 1);
        const view = new DataView(input.buffer);
        view.setUint32(0, cap);
        input[12] = 0xaa;
        input[cap - 1] = 0xbb;
        input[cap] = 0xcc;
        const result = decodeTargetSso12ResponsePrefix(input);
        expect(result.remainingHead.length).toBe(cap - 12);
        expect(result.remainingHead[0]).toBe(0xaa);
        expect(result.remainingHead[cap - 13]).toBe(0xbb);
        expect(result.nextOffset).toBe(cap);
        expect(input[cap]).toBe(0xcc);
        view.setUint32(0, cap + 1);
        expect(() => decodeTargetSso12ResponsePrefix(input)).toThrow(failure);
    });

    it('uses intrinsic slots instead of shadow getters and accepts a foreign Uint8Array', () => {
        const input = Uint8Array.of(0, 0, 0, 13, 0, 0, 0, 1, 0, 0, 0, 2, 3);
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

        expect(decodeTargetSso12ResponsePrefix(input).remainingHead).toEqual(Uint8Array.of(3));
        const foreign = runInNewContext('new Uint8Array([0,0,0,12,0,0,0,1,0,0,0,2])') as Uint8Array;
        expect(decodeTargetSso12ResponsePrefix(foreign).sequenceBits).toBe(1);
        expect(calls).toBe(0);
    });

    it('sanitizes invalid, proxied, shared, detached and out-of-bounds inputs', () => {
        let calls = 0;
        const proxy = new Proxy(new Uint8Array(12), {
            get() {
                calls++;
                throw new Error('SECRET');
            },
        });
        const revoked = Proxy.revocable(new Uint8Array(12), {});
        revoked.revoke();
        const fake = Object.defineProperty({}, 'byteLength', {
            get() {
                calls++;
                throw new Error('SECRET');
            },
        });
        const detached = new Uint8Array(12);
        structuredClone(detached, { transfer: [detached.buffer] });
        const resizable = new ArrayBuffer(16, { maxByteLength: 32 });
        const outOfBounds = new Uint8Array(resizable, 4, 12);
        resizable.resize(4);
        const foreignShared = runInNewContext(
            'new Uint8Array(new SharedArrayBuffer(12))',
        ) as Uint8Array;

        for (const value of [
            proxy,
            revoked.proxy,
            fake,
            new Uint8Array(new SharedArrayBuffer(12)),
            foreignShared,
            detached,
            outOfBounds,
            new Uint16Array(12),
            new DataView(new ArrayBuffer(12)),
            null,
        ]) {
            expect(() => decodeTargetSso12ResponsePrefix(value as never)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });
});
