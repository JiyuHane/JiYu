import { runInNewContext } from 'node:vm';
import type { TargetSso12ReserveMessage } from '@snowluma/proto-defs/target-sso12-reserve';
import { protobuf_decode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import {
    decodeTargetMsfSignOutput as decode,
    encodeTargetSso12ReserveFromNativeSlots as encode,
} from '../../src/direct/target-sso12-reserve';

// All bytes are synthetic local fixtures, not signatures or captured output.
const failure = 'target msf sign output decoding failed';
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');

function smallFixture(): Uint8Array {
    const bytes = new Uint8Array(768).fill(0xa5);
    bytes[0x000] = 0x11;
    bytes[0x0ff] = 1;
    bytes[0x100] = 0x22;
    bytes[0x1ff] = 1;
    bytes[0x200] = 0x33;
    bytes[0x2ff] = 1;
    return bytes;
}

function expectFailure(status: unknown, bytes: unknown): void {
    let failureValue: unknown;

    try {
        decode(status as number, bytes as Uint8Array);
    } catch (error) {
        failureValue = error;
    }

    expect(failureValue).toBeInstanceOf(Error);
    expect((failureValue as Error).message).toBe(failure);
}

describe('synthetic MSF sign output projection', () => {
    it('copies each partition and composes its three slots with the real Proton encoder', () => {
        const input = smallFixture();
        const before = Uint8Array.from(input);
        const result = decode(0, input);

        expect(result).toEqual({
            at00: Uint8Array.of(0x11),
            at18: Uint8Array.of(0x22),
            at30: Uint8Array.of(0x33),
        });
        expect(input).toEqual(before);
        expect(hex(encode({}, result))).toBe('c201090a01331201111a0122');
        expect(new Set([result.at00, result.at18, result.at30]).size).toBe(3);
        expect(new Set([result.at00.buffer, result.at18.buffer, result.at30.buffer]).size).toBe(3);

        for (const value of [result.at00, result.at18, result.at30]) {
            expect(value.buffer).not.toBe(input.buffer);
        }
    });

    it('omits all empty children, even when unused partition bytes are nonzero', () => {
        const input = new Uint8Array(768).fill(0xa5);
        input[0x0ff] = 0;
        input[0x1ff] = 0;
        input[0x2ff] = 0;
        const before = Uint8Array.from(input);
        const result = decode(0, input);

        expect(result).toEqual({
            at00: new Uint8Array(),
            at18: new Uint8Array(),
            at30: new Uint8Array(),
        });
        expect(new Set([result.at00, result.at18, result.at30]).size).toBe(3);
        expect(new Set([result.at00.buffer, result.at18.buffer, result.at30.buffer]).size).toBe(3);
        expect(hex(encode({}, result))).toBe('');
        expect(hex(encode({ field26: 0 }, result))).toBe('d00100');
        expect(input).toEqual(before);
    });

    it.each([
        ['at00', 0x000, 0x0ff, 0x11, 'c20103120111'],
        ['at18', 0x100, 0x1ff, 0x22, 'c201031a0122'],
        ['at30', 0x200, 0x2ff, 0x33, 'c201030a0133'],
    ] as const)('omits empty children when only %s is present', (name, start, end, byte, wire) => {
        const input = new Uint8Array(768);
        input[start] = byte;
        input[end] = 1;
        const result = decode(0, input);

        expect(result[name]).toEqual(Uint8Array.of(byte));
        expect(hex(encode({}, result))).toBe(wire);
    });

    it('keeps all 255 bytes per partition, including NUL and 0xff, as opaque bytes', () => {
        const at00 = Uint8Array.from({ length: 255 }, (_, index) => index);
        const at18 = Uint8Array.from({ length: 255 }, (_, index) => 255 - index);
        const at30 = Uint8Array.from({ length: 255 }, (_, index) => (index * 73) & 0xff);
        const input = new Uint8Array(768);
        input.set(at00, 0x000);
        input.set(at18, 0x100);
        input.set(at30, 0x200);
        input[0x0ff] = 0xff;
        input[0x1ff] = 0xff;
        input[0x2ff] = 0xff;
        const before = Uint8Array.from(input);
        const result = decode(0, input);

        expect(result).toEqual({ at00, at18, at30 });
        expect(result.at00).toHaveLength(255);
        expect(result.at18).toHaveLength(255);
        expect(result.at30).toHaveLength(255);
        expect(input).toEqual(before);

        const encoded = encode({}, result);
        expect(hex(encoded)).toBe(`c20186060aff01${hex(at30)}12ff01${hex(at00)}1aff01${hex(at18)}`);
        const decoded = protobuf_decode<TargetSso12ReserveMessage>(encoded);
        expect(decoded.field24).toMatchObject({ field1: at30, field2: at00, field3: at18 });
    });

    it('keeps the input, each returned array and the encoded bytes independent under mutation', () => {
        const input = smallFixture();
        const original = Uint8Array.from(input);
        const result = decode(0, input);
        const encoded = encode({}, result);
        result.at00[0] = 0x44;
        expect(result.at18).toEqual(Uint8Array.of(0x22));
        expect(result.at30).toEqual(Uint8Array.of(0x33));
        expect(input).toEqual(original);
        result.at18[0] = 0x55;
        expect(result.at00).toEqual(Uint8Array.of(0x44));
        expect(result.at30).toEqual(Uint8Array.of(0x33));
        result.at30[0] = 0x66;
        expect(result.at00).toEqual(Uint8Array.of(0x44));
        expect(result.at18).toEqual(Uint8Array.of(0x55));
        expect(input).toEqual(original);
        expect(hex(encoded)).toBe('c201090a01331201111a0122');

        input.fill(0);
        expect(result).toEqual({
            at00: Uint8Array.of(0x44),
            at18: Uint8Array.of(0x55),
            at30: Uint8Array.of(0x66),
        });
        encoded.fill(0);
        expect(input).toEqual(new Uint8Array(768));
        expect(result.at00).toEqual(Uint8Array.of(0x44));
        expect(result.at18).toEqual(Uint8Array.of(0x55));
        expect(result.at30).toEqual(Uint8Array.of(0x66));
    });

    it('accepts exact-length Uint8Array subarrays, Buffers and cross-realm views', () => {
        const backing = new Uint8Array(800).fill(0xee);
        const subarray = backing.subarray(13, 13 + 768);
        subarray.set(smallFixture());
        const bufferBacking = Buffer.alloc(800, 0xdd);
        const buffer = bufferBacking.subarray(19, 19 + 768);
        buffer.set(smallFixture());
        const foreign = runInNewContext('new Uint8Array(768)') as Uint8Array;
        foreign.set(smallFixture());

        for (const input of [subarray, buffer, foreign]) {
            const before = Uint8Array.from(input);
            const result = decode(0, input);
            expect(hex(encode({}, result))).toBe('c201090a01331201111a0122');
            expect(Uint8Array.from(input)).toEqual(before);
            expect(result.at00.buffer).not.toBe(input.buffer);
            expect(result.at18.buffer).not.toBe(input.buffer);
            expect(result.at30.buffer).not.toBe(input.buffer);
        }

        expect(backing.slice(0, 13)).toEqual(new Uint8Array(13).fill(0xee));
        expect(backing.slice(13 + 768)).toEqual(new Uint8Array(19).fill(0xee));
        expect(bufferBacking.subarray(0, 19)).toEqual(Buffer.alloc(19, 0xdd));
        expect(bufferBacking.subarray(19 + 768)).toEqual(Buffer.alloc(13, 0xdd));
    });

    it('accepts an in-bounds resizable ordinary buffer and rejects its out-of-bounds view', () => {
        const backing = new ArrayBuffer(768, { maxByteLength: 1024 });
        const input = new Uint8Array(backing, 0, 768);
        input.set(smallFixture());
        expect(hex(encode({}, decode(0, input)))).toBe('c201090a01331201111a0122');
        backing.resize(767);
        const before = Uint8Array.from(new Uint8Array(backing));
        expectFailure(0, input);
        expect(new Uint8Array(backing)).toEqual(before);
    });

    it('accepts both numeric zero representations and rejects other statuses without changing bytes', () => {
        const input = smallFixture();
        const before = Uint8Array.from(input);
        expect(decode(-0, input).at00).toEqual(Uint8Array.of(0x11));
        let calls = 0;
        const statusObject = {
            valueOf() {
                calls++;
                throw new Error('synthetic status secret');
            },
        };

        for (const status of [
            NaN,
            -1,
            1,
            Infinity,
            -Infinity,
            0.5,
            '0',
            null,
            undefined,
            false,
            0n,
            statusObject,
        ]) {
            expectFailure(status, input);
            expect(input).toEqual(before);
        }

        expect(calls).toBe(0);
    });

    it('requires the visible input length to be exactly 768 bytes', () => {
        for (const length of [0, 1, 255, 256, 767, 769, 1024]) {
            const input = new Uint8Array(length).fill(0x7b);
            const before = Uint8Array.from(input);
            expectFailure(0, input);
            expect(input).toEqual(before);
        }

        const backing = new Uint8Array(770).fill(0x7b);
        const tooShort = backing.subarray(1, 768);
        const tooLong = backing.subarray(0, 769);
        const before = Uint8Array.from(backing);
        expectFailure(0, tooShort);
        expectFailure(0, tooLong);
        expect(backing).toEqual(before);
    });

    it('rejects invalid views and shared storage without modifying their bytes', () => {
        const ordinary = smallFixture();
        const shared = new Uint8Array(new SharedArrayBuffer(768));
        shared.set(ordinary);
        const foreignShared = runInNewContext(
            'new Uint8Array(new SharedArrayBuffer(768))',
        ) as Uint8Array;
        foreignShared.set(ordinary);
        const ordinaryBefore = Uint8Array.from(ordinary);
        const sharedBefore = Uint8Array.from(shared);
        const foreignBefore = Uint8Array.from(foreignShared);
        const wrongViews = [
            new DataView(ordinary.buffer),
            new Uint16Array(ordinary.buffer),
            new Int8Array(ordinary.buffer),
            new Uint8ClampedArray(ordinary.buffer),
            ordinary.buffer,
            shared.buffer,
            shared,
            foreignShared,
            null,
            undefined,
            {},
            [],
            'synthetic secret',
        ];

        for (const value of wrongViews) {
            expectFailure(0, value);
        }

        expect(ordinary).toEqual(ordinaryBefore);
        expect(shared).toEqual(sharedBefore);
        expect(Uint8Array.from(foreignShared)).toEqual(foreignBefore);
    });

    it('rejects live and revoked proxies without invoking traps', () => {
        const input = smallFixture();
        const before = Uint8Array.from(input);
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('synthetic proxy secret');
        };

        const proxy = new Proxy(input, {
            get: trap,
            set: trap,
            getPrototypeOf: trap,
            ownKeys: trap,
        });
        const revoked = Proxy.revocable(input, {});
        revoked.revoke();

        expectFailure(0, proxy);
        expectFailure(0, revoked.proxy);
        expect(calls).toBe(0);
        expect(input).toEqual(before);
    });

    it('rejects detached views without affecting transferred bytes or other inputs', () => {
        const input = smallFixture();
        const before = Uint8Array.from(input);
        const transferred = structuredClone(input, { transfer: [input.buffer] });
        const other = smallFixture();
        const otherBefore = Uint8Array.from(other);

        expectFailure(0, input);
        expect(input.byteLength).toBe(0);
        expect(transferred).toEqual(before);
        expect(other).toEqual(otherBefore);
    });

    it('clears the private full input snapshot after producing independent results', async () => {
        const input = smallFixture();
        const before = Uint8Array.from(input);
        const owned: Uint8Array[] = [];
        const actualSet = Uint8Array.prototype.set;
        const set = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            offset,
        ) {
            if (
                ArrayBuffer.isView(source) &&
                source.buffer === input.buffer &&
                this.length === 768
            ) {
                owned.push(this);
            }

            actualSet.call(this, source, offset);
        });

        try {
            vi.resetModules();
            const { decodeTargetMsfSignOutput: freshDecode } =
                await import('../../src/direct/target-sso12-reserve');
            const result = freshDecode(0, input);
            expect(result).toEqual({
                at00: Uint8Array.of(0x11),
                at18: Uint8Array.of(0x22),
                at30: Uint8Array.of(0x33),
            });
            expect(owned.length).toBeGreaterThan(0);

            for (const snapshot of owned) {
                expect(snapshot).toEqual(new Uint8Array(768));
                expect(snapshot.buffer).not.toBe(input.buffer);
                expect(snapshot.buffer).not.toBe(result.at00.buffer);
                expect(snapshot.buffer).not.toBe(result.at18.buffer);
                expect(snapshot.buffer).not.toBe(result.at30.buffer);
            }

            expect(input).toEqual(before);
        } finally {
            set.mockRestore();
            vi.resetModules();
        }
    });

    it('clears the private snapshot when its input copy partially writes and throws', async () => {
        const input = smallFixture();
        const before = Uint8Array.from(input);
        const owned: Uint8Array[] = [];
        const actualSet = Uint8Array.prototype.set;
        let copiedFirstByte: number | undefined;
        const set = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            offset,
        ) {
            if (
                ArrayBuffer.isView(source) &&
                source.buffer === input.buffer &&
                this.length === 768
            ) {
                owned.push(this);
                actualSet.call(this, (source as Uint8Array).subarray(0, 17), offset);
                copiedFirstByte = this[0];
                throw new Error('synthetic secret: partial copy');
            }

            actualSet.call(this, source, offset);
        });

        try {
            vi.resetModules();
            const { decodeTargetMsfSignOutput: freshDecode } =
                await import('../../src/direct/target-sso12-reserve');
            let caught: unknown;

            try {
                freshDecode(0, input);
            } catch (error) {
                caught = error;
            }

            expect(caught).toBeInstanceOf(Error);
            expect((caught as Error).message).toBe(failure);
            expect((caught as Error).message).not.toContain('synthetic secret');
            expect(copiedFirstByte).toBe(0x11);
            expect(owned).toHaveLength(1);
            expect(owned[0]).toEqual(new Uint8Array(768));
            expect(owned[0].buffer).not.toBe(input.buffer);
            expect(input).toEqual(before);
        } finally {
            set.mockRestore();
            vi.resetModules();
        }
    });

    it('clears each undelivered result if snapshot cleanup fails', async () => {
        const input = smallFixture();
        const before = Uint8Array.from(input);
        const actualSet = Uint8Array.prototype.set;
        const actualFill = Uint8Array.prototype.fill;
        let snapshot: Uint8Array | undefined;
        const results: Uint8Array[] = [];
        const resultBytesBeforeWipe: number[] = [];
        const set = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            offset,
        ) {
            if (
                ArrayBuffer.isView(source) &&
                source.buffer === input.buffer &&
                this.length === 768
            ) {
                snapshot = this;
            }

            actualSet.call(this, source, offset);
        });
        const fill = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value,
            start,
            end,
        ) {
            if (this === snapshot) {
                throw new Error('synthetic secret: snapshot cleanup');
            }

            if (this !== input && this.length === 1 && value === 0) {
                results.push(this);
                resultBytesBeforeWipe.push(this[0]);
            }

            return actualFill.call(this, value, start, end);
        });

        try {
            vi.resetModules();
            const { decodeTargetMsfSignOutput: freshDecode } =
                await import('../../src/direct/target-sso12-reserve');
            let caught: unknown;

            try {
                freshDecode(0, input);
            } catch (error) {
                caught = error;
            }

            expect(caught).toBeInstanceOf(Error);
            expect((caught as Error).message).toBe(failure);
            expect((caught as Error).message).not.toContain('synthetic secret');
            expect(snapshot).toBeDefined();
            expect(results).toHaveLength(3);
            expect(new Set(results).size).toBe(3);
            expect(resultBytesBeforeWipe).toEqual([0x11, 0x22, 0x33]);

            for (const result of results) {
                expect(result).toEqual(Uint8Array.of(0));
                expect(result.buffer).not.toBe(input.buffer);
            }

            expect(input).toEqual(before);
        } finally {
            fill.mockRestore();
            set.mockRestore();
            vi.resetModules();
        }
    });
});
