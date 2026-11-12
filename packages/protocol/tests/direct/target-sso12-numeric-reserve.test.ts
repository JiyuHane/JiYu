import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { decodeTargetSso12NumericReserveCandidate as decode } from '../../src/direct/target-sso12-numeric-reserve';

// Hand-assembled synthetic values, not a captured or accepted target reserve.
const bytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));
const failure = 'target sso12 numeric reserve candidate decoding failed';

describe('local numeric reserve candidate', () => {
    it.each([
        ['', null, null],
        ['4800', 0, null],
        ['4801', 1, null],
        ['487f', 127, null],
        ['c80100', null, 0],
        ['c80101', null, 1],
        ['c8017f', null, 127],
        ['4800c8017f', 0, 127],
        ['c8017f4800', 0, 127],
        ['487fc80100', 127, 0],
        ['c80100487f', 127, 0],
        ['48ffffffff0fc801ffffffff0f', 4294967295, 4294967295],
        ['c801ffffffff0f48ffffffff0f', 4294967295, 4294967295],
    ] as const)('decodes literal %s with explicit presence', (hex, field9, field25) => {
        const input = bytes(hex);
        const before = Uint8Array.from(input);
        const result = decode(input);
        expect(result).toEqual({ kind: 'numeric-reserve-candidate', field9, field25 });
        expect(input).toEqual(before);
        input.fill(0xff);
        expect(result).toEqual({ kind: 'numeric-reserve-candidate', field9, field25 });
    });

    it.each([
        ['00', 0],
        ['7f', 127],
        ['8001', 128],
        ['ff7f', 16383],
        ['808001', 16384],
        ['ffff7f', 2097151],
        ['80808001', 2097152],
        ['ffffff7f', 268435455],
        ['8080808001', 268435456],
        ['ffffffff07', 2147483647],
        ['8080808008', 2147483648],
        ['ffffffff0f', 4294967295],
    ] as const)('decodes canonical uint32 literal %s in either field', (hex, value) => {
        expect(decode(bytes(`48${hex}`))).toEqual({
            kind: 'numeric-reserve-candidate',
            field9: value,
            field25: null,
        });
        expect(decode(bytes(`c801${hex}`))).toEqual({
            kind: 'numeric-reserve-candidate',
            field9: null,
            field25: value,
        });
    });

    it.each([
        '48014802',
        'c80100c80101',
        '48000801',
        '490000000000000000',
        '4a00',
        'c9010000000000000000',
        'ca0100',
        '488000',
        '488100',
        '4880',
        '48808000',
        '4880808000',
        '488080808000',
        '48ffffffff10',
        '488080808010',
        '48808080808000',
        '48ffffffff8f00',
        '48feffffffffffffffff01',
        '4880808080808080808000',
        'c8018000',
        'c801ffffffff10',
        'c801808080808000',
        'c8810001',
        '480100',
        'b20100',
        'ba0100',
        '48',
        'c8',
        'c801',
        'c80180',
        '4801c80100ff',
        '48ffffffff0fc801ffffffff0f00',
        '00',
    ])('rejects unsupported local shape %s with a fixed error', (hex) => {
        const input = bytes(hex);
        const before = Uint8Array.from(input);
        expect(() => decode(input)).toThrowError(new Error(failure));
        expect(input).toEqual(before);
    });

    it('uses intrinsic slots for subviews and ignores caller getters', () => {
        const backing = Uint8Array.of(0xff, 0x48, 0x01, 0xff);
        const input = backing.subarray(1, 3);
        let calls = 0;

        for (const key of ['buffer', 'byteLength', 'byteOffset', 'length', Symbol.iterator]) {
            Object.defineProperty(input, key, {
                get: () => {
                    calls++;
                    throw new Error('secret');
                },
            });
        }

        expect(decode(input)).toEqual({
            kind: 'numeric-reserve-candidate',
            field9: 1,
            field25: null,
        });
        expect(backing).toEqual(Uint8Array.of(0xff, 0x48, 0x01, 0xff));
        expect(calls).toBe(0);
    });

    it('accepts ordinary foreign views and rejects shared backing across realms', () => {
        const foreign = runInNewContext('new Uint8Array([0x48, 0])') as Uint8Array;
        expect(decode(foreign)).toEqual({
            kind: 'numeric-reserve-candidate',
            field9: 0,
            field25: null,
        });

        for (const value of [
            new Uint8Array(new SharedArrayBuffer(0)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(2))') as Uint8Array,
        ]) {
            expect(() => decode(value)).toThrow(failure);
        }
    });

    it('rejects proxies, hostile prototype chains, other views and primitives without traps', () => {
        let calls = 0;
        const handler = {
            get() {
                calls++;
                throw new Error('secret');
            },
            getPrototypeOf() {
                calls++;
                throw new Error('secret');
            },
        };
        const proxy = new Proxy(Uint8Array.of(0x48, 1), handler);
        const input = Uint8Array.of(0x48, 1);
        Object.setPrototypeOf(input, new Proxy(Uint8Array.prototype, handler));

        for (const value of [
            proxy,
            input,
            null,
            undefined,
            1,
            {},
            [0x48, 1],
            new DataView(new ArrayBuffer(2)),
            new Uint16Array(1),
        ]) {
            expect(() => decode(value as Uint8Array)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it('rejects detached and out-of-bounds views instead of treating them as empty', () => {
        const detached = Uint8Array.of(0x48, 1);
        structuredClone(detached, { transfer: [detached.buffer] });
        expect(() => decode(detached)).toThrow(failure);
        const buffer = new ArrayBuffer(4, { maxByteLength: 8 });
        const outOfBounds = new Uint8Array(buffer, 2, 2);
        buffer.resize(1);
        expect(() => decode(outOfBounds)).toThrow(failure);
        const empty = new Uint8Array(new ArrayBuffer(0));
        expect(decode(empty)).toEqual({
            kind: 'numeric-reserve-candidate',
            field9: null,
            field25: null,
        });
    });

    it.each([
        ['48ffffffff0f', '48ffffffff10', 4294967295],
        ['48ffffffff10', '48ffffffff0f', null],
    ] as const)(
        'validates and decodes the same private snapshot of %s',
        async (initial, replacement, value) => {
            const input = bytes(initial);
            const actualSet = Uint8Array.prototype.set;
            const set = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
                this: Uint8Array,
                source,
                offset,
            ) {
                actualSet.call(this, source, offset);

                if (ArrayBuffer.isView(source) && source.buffer === input.buffer) {
                    actualSet.call(input, bytes(replacement));
                }
            });

            try {
                vi.resetModules();
                const { decodeTargetSso12NumericReserveCandidate } =
                    await import('../../src/direct/target-sso12-numeric-reserve');

                if (value === null) {
                    expect(() => decodeTargetSso12NumericReserveCandidate(input)).toThrow(failure);
                } else {
                    expect(decodeTargetSso12NumericReserveCandidate(input)).toEqual({
                        kind: 'numeric-reserve-candidate',
                        field9: value,
                        field25: null,
                    });
                }

                expect(input).toEqual(bytes(replacement));
            } finally {
                set.mockRestore();
                vi.resetModules();
            }
        },
    );

    it.each(['success', 'invalid', 'copy-error'] as const)(
        'best-effort wipes the private snapshot on %s',
        async (mode) => {
            const input = bytes(mode === 'invalid' ? '480100' : '4801');
            const initial = Uint8Array.from(input);
            const actualSet = Uint8Array.prototype.set;
            let owned: Uint8Array | undefined;
            const set = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
                this: Uint8Array,
                source,
                offset,
            ) {
                if (ArrayBuffer.isView(source) && source.buffer === input.buffer) {
                    owned = this;
                    actualSet.call(this, source, offset);

                    if (mode === 'copy-error') {
                        throw new Error('secret');
                    }

                    return;
                }

                actualSet.call(this, source, offset);
            });

            try {
                vi.resetModules();
                const { decodeTargetSso12NumericReserveCandidate } =
                    await import('../../src/direct/target-sso12-numeric-reserve');

                if (mode === 'success') {
                    expect(decodeTargetSso12NumericReserveCandidate(input).field9).toBe(1);
                } else {
                    expect(() => decodeTargetSso12NumericReserveCandidate(input)).toThrow(failure);
                }

                expect(owned).toBeDefined();
                expect(owned).toEqual(new Uint8Array(input.length));
                expect(input).toEqual(initial);
            } finally {
                set.mockRestore();
                vi.resetModules();
            }
        },
    );
});
