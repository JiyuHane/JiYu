import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    encodeTargetQr12Frame,
    MAX_TARGET_QR12_FRAME_BODY_BYTES,
} from '../../src/direct/target-qr12-frame';

const failure = 'target QR12 frame construction failed';
const setDescriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'set');
const originalSet = Uint8Array.prototype.set;

function restoreSet(): void {
    if (setDescriptor) {
        Object.defineProperty(Uint8Array.prototype, 'set', setDescriptor);
    } else {
        Reflect.deleteProperty(Uint8Array.prototype, 'set');
    }
}

afterEach(() => {
    restoreSet();
    vi.resetModules();
});

describe('target QR12 selected zero-initialized inner frame', () => {
    it('matches independent golden bytes for empty and nonempty synthetic bodies', () => {
        const empty = Uint8Array.from([
            0x02,
            0x00,
            0x2c,
            0x00,
            0x12,
            ...Array(21).fill(0),
            0x03,
            0x00,
            0x00,
            0x00,
            0x32,
            ...Array(12).fill(0),
            0x03,
        ]);
        expect(encodeTargetQr12Frame(new Uint8Array())).toEqual(empty);

        const body = Uint8Array.of(0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x17, 0x28, 0x39);
        const expected = Uint8Array.from([
            0x02,
            0x00,
            0x35,
            0x00,
            0x12,
            ...Array(21).fill(0),
            0x03,
            0x00,
            0x00,
            0x00,
            0x32,
            ...Array(12).fill(0),
            0xa1,
            0xb2,
            0xc3,
            0xd4,
            0xe5,
            0xf6,
            0x17,
            0x28,
            0x39,
            0x03,
        ]);
        const result = encodeTargetQr12Frame(body);
        expect(result).toEqual(expected);
        expect(new DataView(result.buffer).getUint16(1, false)).toBe(result.length);
        expect(new DataView(result.buffer).getBigUint64(35, false)).toBe(0n);
        expect(body).toEqual(Uint8Array.of(0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x17, 0x28, 0x39));
        body[0] = 0;
        expect(result[43]).toBe(0xa1);
        result[44] = 0;
        expect(body[1]).toBe(0xb2);
    });

    it('accepts the inclusive maximum and rejects one byte above it', () => {
        const body = new Uint8Array(MAX_TARGET_QR12_FRAME_BODY_BYTES);
        body[0] = 0xa1;
        body[body.length - 1] = 0xb2;
        const result = encodeTargetQr12Frame(body);
        expect(result).toHaveLength(0xffff);
        expect(Array.from(result.subarray(0, 5))).toEqual([2, 0xff, 0xff, 0, 0x12]);
        expect(result[43]).toBe(0xa1);
        expect(result[65533]).toBe(0xb2);
        expect(result[65534]).toBe(3);
        expect(body[0]).toBe(0xa1);
        expect(body[body.length - 1]).toBe(0xb2);
        expect(() => encodeTargetQr12Frame(new Uint8Array(body.length + 1))).toThrow(failure);
    });

    it('inherits actual-view validation and ignores foreign shadow accessors', () => {
        const body = runInNewContext('new Uint8Array([7, 8, 9, 10]).subarray(1, 3)') as Uint8Array;
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('SECRET');
        };

        for (const key of [
            'length',
            'byteLength',
            'byteOffset',
            'buffer',
            Symbol.iterator,
            Symbol.toStringTag,
        ]) {
            Object.defineProperty(body, key, { get: trap });
        }

        expect(encodeTargetQr12Frame(body).subarray(43, 45)).toEqual(Uint8Array.of(8, 9));

        const proxy = new Proxy(Uint8Array.of(1), { get: trap, getPrototypeOf: trap });
        const revoked = Proxy.revocable(Uint8Array.of(1), { get: trap, getPrototypeOf: trap });
        revoked.revoke();
        const badPrototype = Uint8Array.of(1);
        Object.setPrototypeOf(
            badPrototype,
            new Proxy(Uint8Array.prototype, { getPrototypeOf: trap }),
        );
        const detached = Uint8Array.of(1);
        structuredClone(detached, { transfer: [detached.buffer] });
        const rab = new ArrayBuffer(4, { maxByteLength: 8 });
        const outOfBounds = new Uint8Array(rab, 1, 2);
        rab.resize(0);
        const shared = runInNewContext('new Uint8Array(new SharedArrayBuffer(1))') as Uint8Array;

        for (const invalid of [
            proxy,
            revoked.proxy,
            badPrototype,
            detached,
            outOfBounds,
            shared,
            new Uint16Array(1),
            new Uint8ClampedArray(1),
            new DataView(new ArrayBuffer(1)),
            null,
        ]) {
            let error: unknown;

            try {
                encodeTargetQr12Frame(invalid as Uint8Array);
            } catch (caught) {
                error = caught;
            }

            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toBe(failure);
            expect((error as Error).stack).not.toContain('SECRET');
            expect(Object.hasOwn(error as Error, 'cause')).toBe(false);
        }

        expect(calls).toBe(0);
        rab.resize(4);
        expect(encodeTargetQr12Frame(outOfBounds).subarray(43, 45)).toEqual(Uint8Array.of(0, 0));
    });

    it('wipes a private output if changing the command throws', async () => {
        vi.resetModules();
        let active = false;
        const destinations: Uint8Array[] = [];
        Object.defineProperty(Uint8Array.prototype, 'set', {
            configurable: true,
            writable: true,
            value(this: Uint8Array, source: ArrayLike<number>, offset?: number) {
                originalSet.call(this, source, offset);

                if (active) {
                    destinations.push(this);

                    if (destinations.length === 3) {
                        throw new Error('SECRET command write');
                    }
                }
            },
        });

        try {
            const { encodeTargetQr12Frame: encode } =
                await import('../../src/direct/target-qr12-frame');
            const body = Uint8Array.of(0xaa, 0xbb);
            let error: unknown;
            active = true;

            try {
                encode(body);
            } catch (caught) {
                error = caught;
            } finally {
                active = false;
            }

            expect(destinations).toHaveLength(3);
            expect(destinations[1]).toBe(destinations[2]);
            expect(destinations[0].every((byte) => byte === 0)).toBe(true);
            expect(destinations[1].every((byte) => byte === 0)).toBe(true);
            expect(body).toEqual(Uint8Array.of(0xaa, 0xbb));
            expect((error as Error).message).toBe(failure);
            expect((error as Error).stack).not.toContain('SECRET');
            expect(Object.hasOwn(error as Error, 'cause')).toBe(false);
        } finally {
            active = false;
            restoreSet();
        }
    });
});
