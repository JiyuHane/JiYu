import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
    encodeTargetServiceBusiness,
    MAX_TARGET_SERVICE_BUSINESS_BYTES,
} from '../../src/direct/target-service-business';

const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');
const failure = 'target service business construction failed';

describe('target-static nonempty service business length framing', () => {
    it('emits the manually assembled inclusive BE32 length and copies the input subview', () => {
        const backing = Uint8Array.of(0, 0xaa, 0xbb, 0xcc, 0);
        const payload = backing.subarray(1, 4);
        const output = encodeTargetServiceBusiness(payload);
        expect(hex(output)).toBe('00000007aabbcc');
        backing.fill(0);
        expect(hex(output)).toBe('00000007aabbcc');
    });

    it('uses intrinsic slots without invoking shadow getters, iterators or copy methods', () => {
        const payload = Uint8Array.of(0xaa, 0xbb, 0xcc);
        let calls = 0;

        for (const name of ['length', 'byteLength', 'buffer', 'set', Symbol.iterator]) {
            Object.defineProperty(payload, name, {
                get() {
                    calls++;
                    throw new Error('SECRET');
                },
            });
        }

        expect(hex(encodeTargetServiceBusiness(payload))).toBe('00000007aabbcc');
        const foreign = runInNewContext('new Uint8Array([0xaa, 0xbb, 0xcc])') as Uint8Array;
        expect(hex(encodeTargetServiceBusiness(foreign))).toBe('00000007aabbcc');
        expect(calls).toBe(0);
    });

    it('accepts the exact inclusive size cap with independent copies and rejects one extra byte', () => {
        const payload = new Uint8Array(MAX_TARGET_SERVICE_BUSINESS_BYTES - 4);
        payload[0] = 0xaa;
        payload[payload.length - 1] = 0xcc;
        const output = encodeTargetServiceBusiness(payload);
        expect(output.byteLength).toBe(MAX_TARGET_SERVICE_BUSINESS_BYTES);
        expect(new DataView(output.buffer).getUint32(0, false)).toBe(
            MAX_TARGET_SERVICE_BUSINESS_BYTES,
        );
        expect(output[4]).toBe(0xaa);
        expect(output[output.length - 1]).toBe(0xcc);
        payload[0] = 0xbb;
        expect(output[4]).toBe(0xaa);
        output[output.length - 1] = 0xdd;
        expect(payload[payload.length - 1]).toBe(0xcc);

        const oversized = new Uint8Array(MAX_TARGET_SERVICE_BUSINESS_BYTES - 3);
        let calls = 0;
        Object.defineProperty(oversized, 'byteLength', {
            get() {
                calls++;
                return 1;
            },
        });
        expect(() => encodeTargetServiceBusiness(oversized)).toThrow(new Error(failure));
        expect(calls).toBe(0);
    });

    it('copies Buffer subviews independently and rejects revoked proxies', () => {
        const backing = Buffer.from([0, 0xaa, 0xbb, 0xcc, 0]);
        const payload = backing.subarray(1, 4);
        const output = encodeTargetServiceBusiness(payload);
        expect(hex(output)).toBe('00000007aabbcc');
        payload[0] = 0xdd;
        expect(output[4]).toBe(0xaa);
        output[6] = 0xee;
        expect(payload[2]).toBe(0xcc);

        const { proxy, revoke } = Proxy.revocable(Uint8Array.of(1), {});
        revoke();
        expect(() => encodeTargetServiceBusiness(proxy)).toThrow(new Error(failure));
    });

    it('rejects out-of-bounds resizable-buffer views and accepts them after regrowth', () => {
        const backing = new ArrayBuffer(8, { maxByteLength: 16 });
        const payload = new Uint8Array(backing, 4, 3);
        payload.set([0xaa, 0xbb, 0xcc]);
        backing.resize(4);
        expect(() => encodeTargetServiceBusiness(payload)).toThrow(new Error(failure));
        backing.resize(8);
        expect(hex(encodeTargetServiceBusiness(payload))).toBe('00000007000000');
        payload.set([0xaa, 0xbb, 0xcc]);
        const output = encodeTargetServiceBusiness(payload);
        expect(hex(output)).toBe('00000007aabbcc');
        backing.resize(4);
        expect(hex(output)).toBe('00000007aabbcc');
    });

    it('rejects invalid, empty, oversized, proxy, shared and detached inputs with fixed errors', () => {
        let calls = 0;
        const fake = Object.defineProperty({}, 'byteLength', {
            get() {
                calls++;
                throw new Error('SECRET');
            },
        });
        const proxy = new Proxy(Uint8Array.of(1), {
            get() {
                calls++;
                throw new Error('SECRET');
            },
            getPrototypeOf() {
                calls++;
                throw new Error('SECRET');
            },
        });
        const shared = runInNewContext('new Uint8Array(new SharedArrayBuffer(1))') as Uint8Array;
        const detached = Uint8Array.of(1);
        structuredClone(detached, { transfer: [detached.buffer] });

        for (const value of [
            undefined,
            null,
            1,
            'x',
            [],
            fake,
            proxy,
            new Uint8Array(),
            new Uint16Array(1),
            new DataView(new ArrayBuffer(1)),
            new Uint8Array(MAX_TARGET_SERVICE_BUSINESS_BYTES - 3),
            new Uint8Array(new SharedArrayBuffer(1)),
            shared,
            detached,
        ]) {
            expect(() => encodeTargetServiceBusiness(value as never)).toThrow(new Error(failure));
        }

        expect(calls).toBe(0);
    });
});
