import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildLinuxQQAppSignatureCheckEnvelope as build } from '../../src/direct/linux-qq-app-signature-check-envelope';

// These are synthetic opaque bytes. The tests cover the local envelope only,
// not a JCE schema, native ABI, signature algorithm, or real-target interoperability.
const localMaxInputBytes = 1024 * 1024;

function syntheticBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);

    for (let index = 0; index < length; index++) {
        bytes[index] = (index * 37 + 0xa5) & 0xff;
    }

    return bytes;
}

describe('synthetic Linux app-signature check envelope', () => {
    it.each([
        [0, [0x00, 0x00, 0x00, 0x04]],
        [1, [0x00, 0x00, 0x00, 0x05]],
        [255, [0x00, 0x00, 0x01, 0x03]],
        [256, [0x00, 0x00, 0x01, 0x04]],
        [65535, [0x00, 0x01, 0x00, 0x03]],
        [65536, [0x00, 0x01, 0x00, 0x04]],
        [localMaxInputBytes, [0x00, 0x10, 0x00, 0x04]],
    ] as const)('prefixes the total length in big-endian for %i input bytes', (length, prefix) => {
        const source = syntheticBytes(length);
        const before = source.slice();
        const result = build(source);

        expect(result.command).toBe('PhSigLcId.Check');
        expect(result.field38).toBe('0');
        expect(result.commandNumber).toBe(75);
        expect(result.body).toBeInstanceOf(Uint8Array);
        expect(result.body.length).toBe(length + 4);
        expect(Array.from(result.body.subarray(0, 4))).toEqual(prefix);
        expect(
            new DataView(result.body.buffer, result.body.byteOffset, 4).getUint32(0, false),
        ).toBe(length + 4);
        expect(Buffer.from(result.body.subarray(4)).equals(Buffer.from(before))).toBe(true);
        expect(Buffer.from(source).equals(Buffer.from(before))).toBe(true);
        expect(result.body.buffer).not.toBe(source.buffer);
    });

    it('copies only the selected Uint8Array, Buffer, and cross-realm subviews', () => {
        const local = Uint8Array.of(0xee, 0x01, 0x00, 0xff, 0xdd);
        const buffer = Buffer.from([0xee, 0x01, 0x00, 0xff, 0xdd]);
        const foreign = runInNewContext(
            'new Uint8Array([238, 1, 0, 255, 221]).subarray(1, 4)',
        ) as Uint8Array;
        const views = [local.subarray(1, 4), buffer.subarray(1, 4), foreign];
        const expected = Uint8Array.of(0, 0, 0, 7, 1, 0, 0xff);

        for (const view of views) {
            const result = build(view);
            expect(result.body).toEqual(expected);
            expect(result.body.buffer).not.toBe(view.buffer);
        }

        expect(local).toEqual(Uint8Array.of(0xee, 1, 0, 0xff, 0xdd));
        expect(buffer).toEqual(Buffer.from([0xee, 1, 0, 0xff, 0xdd]));
        expect(Array.from(foreign)).toEqual([1, 0, 0xff]);
        expect(build(local.subarray(2, 2)).body).toEqual(Uint8Array.of(0, 0, 0, 4));
    });

    it('isolates source and results in both directions while retaining a wipeable body', () => {
        const backing = Uint8Array.of(0xee, 0x10, 0x20, 0x30, 0xdd);
        const source = backing.subarray(1, 4);
        const first = build(source);
        const second = build(source);
        expect(Object.isFrozen(first)).toBe(true);
        expect(Reflect.set(first, 'command', 'other')).toBe(false);
        expect(Reflect.set(first, 'body', new Uint8Array())).toBe(false);
        expect(first.command).toBe('PhSigLcId.Check');
        expect(first.body.buffer).not.toBe(second.body.buffer);

        source[0] = 0x99;
        expect(first.body).toEqual(Uint8Array.of(0, 0, 0, 7, 0x10, 0x20, 0x30));
        first.body.fill(0);
        expect(backing).toEqual(Uint8Array.of(0xee, 0x99, 0x20, 0x30, 0xdd));
        expect(second.body).toEqual(Uint8Array.of(0, 0, 0, 7, 0x10, 0x20, 0x30));
        expect(first.body).toEqual(new Uint8Array(7));
    });

    it('rejects an input over the local 1 MiB limit without modifying it', () => {
        const oversized = syntheticBytes(localMaxInputBytes + 1);
        const before = oversized.slice();
        expect(() => build(oversized)).toThrow(TypeError);
        expect(Buffer.from(oversized).equals(Buffer.from(before))).toBe(true);
    });

    it('rejects invalid types and proxy views without accessing their traps', () => {
        let trapCalls = 0;

        const trap = () => {
            trapCalls++;
            throw new Error('synthetic trap');
        };

        const revoked = Proxy.revocable(Uint8Array.of(1), {});
        revoked.revoke();
        const invalid: unknown[] = [
            undefined,
            null,
            false,
            1,
            'bytes',
            [1, 2],
            {},
            new ArrayBuffer(4),
            new DataView(new ArrayBuffer(4)),
            new Int8Array(4),
            new Uint16Array(4),
            new Proxy(Uint8Array.of(1), { get: trap, getPrototypeOf: trap }),
            revoked.proxy,
        ];

        for (const value of invalid) {
            expect(() => build(value as Uint8Array)).toThrow(TypeError);
        }

        expect(trapCalls).toBe(0);
    });

    it('rejects shared, resizable, out-of-bounds and detached byte views', () => {
        const detached = Uint8Array.of(1, 2);
        const detachedEmpty = new Uint8Array(0);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        structuredClone(detachedEmpty.buffer, { transfer: [detachedEmpty.buffer] });
        const resizable = new ArrayBuffer(8, { maxByteLength: 16 });
        const resizableView = new Uint8Array(resizable, 0, 2);
        const outOfBoundsBacking = new ArrayBuffer(8, { maxByteLength: 16 });
        const outOfBounds = new Uint8Array(outOfBoundsBacking, 4, 4);
        outOfBoundsBacking.resize(0);
        const invalid = [
            new Uint8Array(new SharedArrayBuffer(4)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(4))') as Uint8Array,
            resizableView,
            outOfBounds,
            detached,
            detachedEmpty,
        ];

        for (const value of invalid) {
            expect(() => build(value)).toThrow(TypeError);
        }
    });
});
