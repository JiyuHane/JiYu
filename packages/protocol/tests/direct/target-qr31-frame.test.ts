import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    encodeTargetQr31Frame,
    MAX_TARGET_QR31_FRAME_BODY_BYTES,
} from '../../src/direct/target-qr31-frame';

const failure = 'target QR31 frame construction failed';
const originalSet = Uint8Array.prototype.set;
const originalFill = Uint8Array.prototype.fill;
const setDescriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'set');
const fillDescriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'fill');

function restoreIntrinsic(name: 'set' | 'fill', descriptor: PropertyDescriptor | undefined): void {
    if (descriptor) {
        Object.defineProperty(Uint8Array.prototype, name, descriptor);
    } else {
        Reflect.deleteProperty(Uint8Array.prototype, name);
    }
}

afterEach(() => {
    restoreIntrinsic('set', setDescriptor);
    restoreIntrinsic('fill', fillDescriptor);
    vi.resetModules();
});

// Capture only the encoder's private allocations. The real set/fill methods
// still perform the copy and cleanup; selected failures happen afterwards or
// at the first cleanup to exercise the encoder's actual error paths.
async function inspectCleanup(mode: 'success' | 'copy-failure' | 'cleanup-failure') {
    vi.resetModules();
    let active = false;
    const destinations: Uint8Array[] = [];
    const cleared: Uint8Array[] = [];

    Object.defineProperty(Uint8Array.prototype, 'set', {
        configurable: true,
        writable: true,
        value(this: Uint8Array, source: ArrayLike<number>, offset?: number) {
            originalSet.call(this, source, offset);

            if (active) {
                destinations.push(this);

                if (mode !== 'success' && destinations.length === 2) {
                    throw new Error('SECRET copy failure');
                }
            }
        },
    });
    Object.defineProperty(Uint8Array.prototype, 'fill', {
        configurable: true,
        writable: true,
        value(this: Uint8Array, value: number, start?: number, end?: number) {
            if (active) {
                cleared.push(this);

                if (mode === 'cleanup-failure' && cleared.length === 1) {
                    throw new Error('SECRET cleanup failure');
                }
            }

            return originalFill.call(this, value, start, end);
        },
    });

    try {
        const { encodeTargetQr31Frame: encode } =
            await import('../../src/direct/target-qr31-frame');
        const input = Uint8Array.of(0xa1, 0xb2);
        let output: Uint8Array | undefined;
        let error: unknown;
        active = true;

        try {
            output = encode(input);
        } catch (caught) {
            error = caught;
        } finally {
            active = false;
        }

        return { destinations, cleared, output, error, input };
    } finally {
        restoreIntrinsic('set', setDescriptor);
        restoreIntrinsic('fill', fillDescriptor);
    }
}

describe('target QR31 zero-initialized frame candidate', () => {
    it('writes the observed header, inclusive total and trailer around synthetic bytes', () => {
        const body = Uint8Array.of(0xa1, 0x00, 0xff, 0x02);
        const frame = encodeTargetQr31Frame(body);
        const expected = Buffer.concat([
            Buffer.from('0200300031', 'hex'),
            Buffer.alloc(21),
            Buffer.from('0300000032', 'hex'),
            Buffer.alloc(12),
            Buffer.from(body),
            Buffer.from([3]),
        ]);
        expect(frame).toEqual(Uint8Array.from(expected));
        expect(frame).toHaveLength(48);
        expect(new DataView(frame.buffer).getUint16(1, false)).toBe(48);
        expect(body).toEqual(Uint8Array.of(0xa1, 0, 0xff, 2));
        frame[43] = 0;
        expect(body[0]).toBe(0xa1);
    });

    it('allows empty and maximum bodies and rejects an inclusive length overflow', () => {
        const empty = encodeTargetQr31Frame(new Uint8Array());
        expect(empty).toHaveLength(44);
        expect(new DataView(empty.buffer).getUint16(1, false)).toBe(44);
        expect(empty[43]).toBe(3);
        const maxBody = new Uint8Array(MAX_TARGET_QR31_FRAME_BODY_BYTES);
        maxBody[0] = 0xa1;
        maxBody[maxBody.length - 1] = 0xb2;
        const max = encodeTargetQr31Frame(maxBody);
        expect(max).toHaveLength(65535);
        expect(new DataView(max.buffer).getUint16(1, false)).toBe(65535);
        expect(max[43]).toBe(0xa1);
        expect(max[65533]).toBe(0xb2);
        expect(max[65534]).toBe(3);
        expect(() =>
            encodeTargetQr31Frame(new Uint8Array(MAX_TARGET_QR31_FRAME_BODY_BYTES + 1)),
        ).toThrow(failure);
    });

    it('copies foreign-realm subviews without invoking shadow getters', () => {
        const input = runInNewContext('new Uint8Array([9,1,2,3,8]).subarray(1,4)') as Uint8Array;
        let calls = 0;

        for (const name of ['buffer', 'byteLength', 'byteOffset', Symbol.iterator]) {
            Object.defineProperty(input, name, {
                get() {
                    calls++;
                    throw new Error('unexpected access');
                },
            });
        }

        const frame = encodeTargetQr31Frame(input);
        expect(frame.subarray(43, 46)).toEqual(Uint8Array.of(1, 2, 3));
        expect(calls).toBe(0);
    });

    it('rejects proxies, proxy prototype chains, shared and invalid views without traps', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('unexpected trap');
        };

        const input = Uint8Array.of(1);
        const proxy = new Proxy(input, { get: trap, getPrototypeOf: trap });
        const revoked = Proxy.revocable(input, { get: trap, getPrototypeOf: trap });
        revoked.revoke();
        const badPrototype = Uint8Array.of(1);
        Object.setPrototypeOf(
            badPrototype,
            new Proxy(Uint8Array.prototype, { getPrototypeOf: trap }),
        );
        const detached = Uint8Array.of(1);
        structuredClone(detached, { transfer: [detached.buffer] });
        const backing = new ArrayBuffer(4, { maxByteLength: 8 });
        const outOfBounds = new Uint8Array(backing, 1, 2);
        backing.resize(0);
        const shared = new Uint8Array(new SharedArrayBuffer(1));
        const foreignShared = runInNewContext(
            'new Uint8Array(new SharedArrayBuffer(1))',
        ) as Uint8Array;

        for (const candidate of [
            proxy,
            revoked.proxy,
            badPrototype,
            detached,
            outOfBounds,
            shared,
            foreignShared,
            new DataView(new ArrayBuffer(1)),
            null,
        ]) {
            expect(() => encodeTargetQr31Frame(candidate as Uint8Array)).toThrow(failure);
        }

        expect(calls).toBe(0);
        backing.resize(4);
        expect(encodeTargetQr31Frame(outOfBounds).subarray(43, 45)).toEqual(Uint8Array.of(0, 0));
    });

    it('clears the private snapshot while preserving the independently owned output', async () => {
        const { destinations, cleared, output, error, input } = await inspectCleanup('success');
        expect(error).toBeUndefined();
        expect(destinations).toHaveLength(2);
        expect(cleared).toHaveLength(1);
        expect(cleared[0]).toBe(destinations[0]);
        expect(destinations[0]).toEqual(Uint8Array.of(0, 0));
        expect(destinations[1]).toBe(output);
        expect(output?.subarray(43, 45)).toEqual(Uint8Array.of(0xa1, 0xb2));
        expect(input).toEqual(Uint8Array.of(0xa1, 0xb2));
    });

    it('clears both private buffers after an output-copy failure', async () => {
        const { destinations, cleared, output, error } = await inspectCleanup('copy-failure');
        expect(output).toBeUndefined();
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(failure);
        expect((error as Error).stack).not.toContain('SECRET');
        expect(Object.hasOwn(error as Error, 'cause')).toBe(false);
        expect(destinations).toHaveLength(2);
        expect(cleared).toEqual([destinations[0], destinations[1]]);
        expect(destinations[0].every((byte) => byte === 0)).toBe(true);
        expect(destinations[1].every((byte) => byte === 0)).toBe(true);
    });

    it('still attempts output cleanup when snapshot cleanup throws', async () => {
        const { destinations, cleared, output, error } = await inspectCleanup('cleanup-failure');
        expect(output).toBeUndefined();
        expect((error as Error).message).toBe(failure);
        expect(destinations).toHaveLength(2);
        expect(cleared).toHaveLength(2);
        expect(cleared[0]).toBe(destinations[0]);
        expect(cleared[1]).toBe(destinations[1]);
        expect(destinations[0]).toEqual(Uint8Array.of(0xa1, 0xb2));
        expect(destinations[1].every((byte) => byte === 0)).toBe(true);
    });
});
