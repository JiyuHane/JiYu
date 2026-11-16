import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
    encodeTargetSso12ReserveFromNativeSlots as encode,
    MAX_TARGET_SSO12_RESERVE_BYTES,
    type NativeSignResultPayloads,
} from '../../src/direct/target-sso12-reserve';

// Synthetic payload bytes exercise the real target-subset Proton encoder only.
// They are not native object headers, a target capture or a signature.
const failure = 'target SSO12 reserve construction failed';
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');
const empty = (): Uint8Array => new Uint8Array();
const slots = (): NativeSignResultPayloads => ({
    at00: Uint8Array.of(0x11),
    at18: Uint8Array.of(0x22),
    at30: Uint8Array.of(0x33),
});
const emptySlots = (): NativeSignResultPayloads => ({
    at00: empty(),
    at18: empty(),
    at30: empty(),
});

describe('target SSO12 synthetic native result slots', () => {
    it('maps three distinct offsets to child fields 2, 3 and 1', () => {
        expect(hex(encode({}, slots()))).toBe('c201090a01331201111a0122');
    });

    it.each([
        ['at00', 0x11, 'c20103120111'],
        ['at18', 0x22, 'c201031a0122'],
        ['at30', 0x33, 'c201030a0133'],
    ] as const)('maps only nonempty %s and omits empty children', (name, value, expected) => {
        expect(hex(encode({}, { ...emptySlots(), [name]: Uint8Array.of(value) }))).toBe(expected);
    });

    it('passes opaque bytes through without text decoding', () => {
        expect(hex(encode({}, { ...emptySlots(), at00: Uint8Array.of(0, 0x80, 0xff) }))).toBe(
            'c2010512030080ff',
        );
    });

    it('omits an entirely empty field24 even when another field is active', () => {
        expect(hex(encode({}, emptySlots()))).toBe('');
        expect(hex(encode({ field26: 0 }, emptySlots()))).toBe('d00100');
        expect(hex(encode({ field12: Uint8Array.of(0xaa) }, emptySlots()))).toBe('');
        expect(hex(encode({ field23: [{ field1: empty(), field2: empty() }] }, emptySlots()))).toBe(
            '',
        );
        expect(
            hex(
                encode(
                    {
                        field12: Uint8Array.of(0xaa),
                        field13: empty(),
                        field23: [{ field1: empty(), field2: empty() }],
                    },
                    emptySlots(),
                ),
            ),
        ).toBe('6201aa6a00ba01040a001200');
    });

    it('composes other caller-selected fields without changing their existing wire rules', () => {
        const output = encode(
            {
                field12: Uint8Array.of(0xaa),
                field13: empty(),
                field23: [{ field1: empty(), field2: Uint8Array.of(0x44) }],
                field26: 0,
                field32: Uint8Array.of(0xcc),
            },
            slots(),
        );
        expect(hex(output)).toBe(
            '6201aa6a00ba01050a00120144c201090a01331201111a0122d00100820201cc',
        );
        expect(hex(encode({ field21Enabled: true }, emptySlots()))).toBe('a80120');
    });

    it('rejects field24 in the base even when its value is undefined', () => {
        for (const field24 of [undefined, {}, { field1: Uint8Array.of(1) }]) {
            expect(() => encode({ field24 } as never, slots())).toThrow(failure);
        }
    });

    it('requires exactly three own data byte properties and rejects extra keys', () => {
        const valid = slots();
        const withSymbol = { ...valid, [Symbol('extra')]: 1 };
        const inherited = Object.create(valid) as NativeSignResultPayloads;

        for (const value of [
            null,
            [],
            {},
            { at00: valid.at00, at18: valid.at18 },
            { ...valid, at00: undefined },
            { ...valid, at18: '22' },
            { ...valid, at30: new DataView(new ArrayBuffer(1)) },
            { ...valid, another: Uint8Array.of(1) },
            withSymbol,
            inherited,
        ]) {
            expect(() => encode({}, value as NativeSignResultPayloads)).toThrow(failure);
        }

        expect(() => encode({ other: 1 } as never, valid)).toThrow(failure);
        expect(() => encode({ field26: undefined } as never, valid)).toThrow(failure);
    });

    it('rejects record accessors and proxies without invoking their traps', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('synthetic secret');
        };

        const getterSlot = Object.defineProperty({ ...slots() }, 'at30', { get: trap });
        const getterBase = Object.defineProperty({}, 'field13', { get: trap });
        const field24Getter = Object.defineProperty({}, 'field24', { get: trap });
        const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
        const revoked = Proxy.revocable({}, {});
        revoked.revoke();

        expect(() => encode({}, getterSlot)).toThrow(failure);
        expect(() => encode(getterBase, slots())).toThrow(failure);
        expect(() => encode(field24Getter, slots())).toThrow(failure);
        expect(() => encode({}, proxy as NativeSignResultPayloads)).toThrow(failure);
        expect(() => encode(proxy, slots())).toThrow(failure);
        expect(() => encode({}, revoked.proxy as NativeSignResultPayloads)).toThrow(failure);
        expect(calls).toBe(0);
    });

    it('snapshots subviews, accepts cross-realm bytes and keeps caller/output ownership separate', () => {
        const backing = Uint8Array.of(0xff, 0x11, 0x22, 0x33, 0xee);
        const foreign = runInNewContext(
            'new Uint8Array([0xff, 0x22, 0xee]).subarray(1, 2)',
        ) as Uint8Array;
        const result = encode(
            {},
            {
                at00: backing.subarray(1, 2),
                at18: foreign,
                at30: backing.subarray(3, 4),
            },
        );
        expect(hex(result)).toBe('c201090a01331201111a0122');
        expect(backing).toEqual(Uint8Array.of(0xff, 0x11, 0x22, 0x33, 0xee));
        expect(Array.from(foreign)).toEqual([0x22]);
        expect(result.buffer).not.toBe(backing.buffer);
        backing.fill(0);
        foreign.fill(0);
        expect(hex(result)).toBe('c201090a01331201111a0122');
        result.fill(0);
        expect(backing).toEqual(new Uint8Array(5));
        expect(Array.from(foreign)).toEqual([0]);
    });

    it('rejects shared, detached and proxy byte views with the same sanitized error', () => {
        const detached = empty();
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const shared = new Uint8Array(new SharedArrayBuffer(1));
        const foreignShared = runInNewContext(
            'new Uint8Array(new SharedArrayBuffer(1))',
        ) as Uint8Array;
        const proxy = new Proxy(Uint8Array.of(1), {
            get() {
                throw new Error('synthetic secret');
            },
        });

        for (const value of [detached, shared, foreignShared, proxy]) {
            expect(() => encode({}, { ...emptySlots(), at00: value })).toThrow(failure);
        }
    });

    it('enforces the existing total wire size cap, including field24 prefixes', () => {
        const over = new Uint8Array(MAX_TARGET_SSO12_RESERVE_BYTES - 10);
        const fit = over.subarray(0, over.length - 1);
        fit[fit.length - 1] = 0xa5;
        const result = encode({}, { ...emptySlots(), at30: fit });
        expect(result.length).toBe(MAX_TARGET_SSO12_RESERVE_BYTES);
        expect(result[result.length - 1]).toBe(0xa5);
        expect(() => encode({}, { ...emptySlots(), at30: over })).toThrow(failure);
        expect(over[fit.length - 1]).toBe(0xa5);
    });

    it.each(['success', 'copy-throw', 'cleanup-throw'] as const)(
        'uses and clears the existing encoder snapshots on %s',
        async (mode) => {
            const source = slots();
            const sources = [source.at30, source.at00, source.at18];
            const before = sources.map((value) => Uint8Array.from(value));
            const owned: Uint8Array[] = [];
            const actualSet = Uint8Array.prototype.set;
            const set = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
                this: Uint8Array,
                value,
                offset,
            ) {
                if (sources.includes(value as Uint8Array)) {
                    owned.push(this);
                    actualSet.call(this, value, offset);

                    if (mode === 'cleanup-throw' && owned.length === 1) {
                        Object.defineProperty(this, 'fill', {
                            value: () => {
                                throw new Error('synthetic cleanup failure');
                            },
                        });
                    }

                    if (mode === 'copy-throw' && owned.length === 2) {
                        throw new Error('synthetic copy failure');
                    }

                    return;
                }

                actualSet.call(this, value, offset);
            });

            try {
                vi.resetModules();
                const { encodeTargetSso12ReserveFromNativeSlots: freshEncode } =
                    await import('../../src/direct/target-sso12-reserve');

                if (mode === 'copy-throw') {
                    expect(() => freshEncode({}, source)).toThrow(failure);
                    expect(owned).toHaveLength(2);
                } else {
                    const result = freshEncode({}, source);
                    expect(hex(result)).toBe('c201090a01331201111a0122');
                    expect(owned).toHaveLength(3);
                    expect(owned.some((copy) => copy.buffer === result.buffer)).toBe(false);
                }

                for (const [index, copy] of owned.entries()) {
                    if (mode !== 'cleanup-throw' || index !== 0) {
                        expect(copy).toEqual(new Uint8Array(copy.length));
                    }
                }

                expect(sources).toEqual(before);
            } finally {
                set.mockRestore();
                vi.resetModules();
            }
        },
    );
});
