import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
    encodeTargetWtInnerWriterCandidate as encode,
    MAX_TARGET_WT_INNER_WRITER_BYTES as MAX_BYTES,
} from '../../src/direct/target-wt-inner-writer-candidate';

const failure = 'target WT inner writer candidate failed';
const empty = () => new Uint8Array();
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describe('offline target WT four-writer candidate', () => {
    it('prefixes four and concatenates opaque synthetic outputs in argument order', () => {
        const a = Uint8Array.of(0xaa, 0);
        const b = empty();
        const c = Uint8Array.of(0xbb);
        const d = Uint8Array.of(0, 0xff);
        expect(hex(encode(a, b, c, d))).toBe('0004aa00bb00ff');
        expect(hex(encode(c, b, a, d))).toBe('0004bbaa0000ff');
        expect(hex(encode(empty(), empty(), empty(), empty()))).toBe('0004');
    });

    it('copies subviews, Buffer and foreign arrays without mutating or aliasing them', () => {
        const backing = Buffer.from([9, 0, 0xff, 9]);
        const foreign = runInNewContext(
            'new Uint8Array([8, 1, 2, 8]).subarray(1, 3)',
        ) as Uint8Array;
        const output = encode(backing.subarray(1, 3), foreign, backing.subarray(1, 3), empty());
        expect(hex(output)).toBe('000400ff010200ff');
        expect(backing).toEqual(Buffer.from([9, 0, 0xff, 9]));
        expect(output.buffer).not.toBe(backing.buffer);
        expect(output.buffer).not.toBe(foreign.buffer);
        backing.fill(0);
        foreign.fill(0);
        expect(hex(output)).toBe('000400ff010200ff');
        output.fill(0);
        expect(backing).toEqual(Buffer.alloc(4));
    });

    it('bounds aggregate output including the count', () => {
        const input = new Uint8Array(MAX_BYTES - 2);
        input[0] = 0xa5;
        input[input.length - 1] = 0x5a;
        const output = encode(input, empty(), empty(), empty());
        expect(output.length).toBe(MAX_BYTES);
        expect([...output.subarray(0, 3)]).toEqual([0, 4, 0xa5]);
        expect(output.at(-1)).toBe(0x5a);
        expect(() => encode(input, Uint8Array.of(1), empty(), empty())).toThrow(failure);
        expect(() => encode(new Uint8Array(MAX_BYTES - 1), empty(), empty(), empty())).toThrow(
            failure,
        );
    });

    it('rejects invalid views without invoking proxy or shadow getter traps', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('private synthetic diagnostic');
        };

        const shadow = Uint8Array.of(0x42);
        Object.defineProperty(shadow, 'byteLength', { get: trap });
        expect(hex(encode(shadow, empty(), empty(), empty()))).toBe('000442');
        const proto = Uint8Array.of(1);
        Object.setPrototypeOf(proto, new Proxy(Uint8Array.prototype, { getPrototypeOf: trap }));
        const detached = Uint8Array.of(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const rab = new ArrayBuffer(8, { maxByteLength: 16 });
        const outOfBounds = new Uint8Array(rab, 4, 4);
        rab.resize(0);
        const revoked = Proxy.revocable(Uint8Array.of(1), {});
        revoked.revoke();
        const invalid: unknown[] = [
            null,
            {},
            new Uint16Array(1),
            new Uint8Array(new SharedArrayBuffer(1)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(1))'),
            detached,
            outOfBounds,
            proto,
            new Proxy(Uint8Array.of(1), { get: trap, getPrototypeOf: trap }),
            revoked.proxy,
        ];

        for (const value of invalid) {
            for (let index = 0; index < 4; index++) {
                const args = [empty(), empty(), empty(), empty()];
                args[index] = value as Uint8Array;
                expect(() => encode(args[0], args[1], args[2], args[3])).toThrow(failure);
            }
        }

        expect(calls).toBe(0);
    });

    it('independently attempts cleanup after a late output-copy failure', async () => {
        vi.resetModules();
        const original = Uint8Array.prototype.set;
        const allocations: Uint8Array[] = [];
        const inputs = [Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3), Uint8Array.of(4)];
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            offset,
        ) {
            allocations.push(this);
            original.call(this, source, offset);

            if (allocations.length === 7) {
                throw new Error('private synthetic diagnostic');
            }
        });

        try {
            const isolated = await import('../../src/direct/target-wt-inner-writer-candidate');
            expect(() =>
                isolated.encodeTargetWtInnerWriterCandidate(
                    ...(inputs as [Uint8Array, Uint8Array, Uint8Array, Uint8Array]),
                ),
            ).toThrow(failure);
        } finally {
            spy.mockRestore();
        }

        expect(allocations).toHaveLength(7);
        expect(allocations.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
        expect(inputs.map((bytes) => bytes[0])).toEqual([1, 2, 3, 4]);
    });
});
