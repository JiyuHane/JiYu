import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
    encodeTargetSso12Reserve,
    MAX_TARGET_SSO12_RESERVE_BYTES,
    type TargetSso12ReserveInput,
} from '../../src/direct/target-sso12-reserve';

// Hand-assembled, synthetic protobuf bytes derived from target-static findings.
// Neither a target capture nor proof of live server compatibility.
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');
const fromHex = (value: string): Uint8Array => Buffer.from(value, 'hex');
const failure = 'target SSO12 reserve construction failed';

describe('target SSO12 reserve snapshot ownership', () => {
    it.each(['success', 'copy-throw', 'detach-during-copy', 'cleanup-throw'] as const)(
        'clears actual local snapshots on %s with real Proton output ownership',
        async (mode) => {
            const sources = Array.from({ length: 10 }, (_, index) => Uint8Array.of(index + 1));
            const before = sources.map((source) => Uint8Array.from(source));
            const input: TargetSso12ReserveInput = {
                field12: sources[5],
                field13: sources[6],
                field15: sources[7],
                field16: sources[8],
                field32: sources[9],
                field23: [{ field1: sources[0], field2: sources[1] }],
                field24: { field1: sources[2], field2: sources[3], field3: sources[4] },
            };
            const owned: Uint8Array[] = [];
            const actualSet = Uint8Array.prototype.set;
            const set = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
                this: Uint8Array,
                source,
                offset,
            ) {
                if (sources.includes(source as Uint8Array)) {
                    owned.push(this);

                    if (mode === 'detach-during-copy' && owned.length === 2) {
                        structuredClone(source, { transfer: [(source as Uint8Array).buffer] });
                    }

                    actualSet.call(this, source, offset);

                    if (mode === 'cleanup-throw' && owned.length === 1) {
                        Object.defineProperty(this, 'fill', {
                            value: () => {
                                throw new Error('fixture cleanup failure');
                            },
                        });
                    }

                    if (mode === 'copy-throw' && owned.length === 2) {
                        throw new Error('fixture copy failure');
                    }

                    return;
                }

                actualSet.call(this, source, offset);
            });

            try {
                vi.resetModules();
                const { encodeTargetSso12Reserve: encode } =
                    await import('../../src/direct/target-sso12-reserve');

                if (mode === 'copy-throw' || mode === 'detach-during-copy') {
                    expect(() => encode(input)).toThrow(failure);
                    expect(owned).toHaveLength(2);
                } else {
                    const output = encode(input);
                    expect(hex(output)).toBe(
                        '6201066a01077a010882010109ba01060a0101120102c201090a01031201041a01058202010a',
                    );
                    expect(owned).toHaveLength(10);
                    expect(owned.some((copy) => copy.buffer === output.buffer)).toBe(false);
                }

                for (const [index, copy] of owned.entries()) {
                    if (mode !== 'cleanup-throw' || index !== 0) {
                        expect(copy).toEqual(new Uint8Array(copy.length));
                    }
                }

                for (const [index, source] of sources.entries()) {
                    if (mode !== 'detach-during-copy' || index !== 1) {
                        expect(source).toEqual(before[index]);
                    }
                }
            } finally {
                set.mockRestore();
                vi.resetModules();
            }
        },
    );
});

describe('target-static SSO12 reserved protobuf subset', () => {
    it('emits all known tags in inferred ascending order and keeps explicit empty/zero', () => {
        const input: TargetSso12ReserveInput = {
            field32: fromHex('ff'),
            field26: 0,
            field24: { field3: fromHex('33'), field2: fromHex('2233'), field1: fromHex('11') },
            field21Enabled: true,
            field16: new Uint8Array(),
            field15: fromHex('0f'),
            field13: new Uint8Array(),
            field12: fromHex('aabb'),
        };
        expect(hex(encodeTargetSso12Reserve(input))).toBe(
            '6202aabb' +
                '6a00' +
                '7a010f' +
                '820100' +
                'a80120' +
                'c2010a0a0111120222331a0133' +
                'd00100' +
                '820201ff',
        );
    });

    it('models serialization gate and setter presence independently of data length', () => {
        expect(hex(encodeTargetSso12Reserve({}))).toBe('');
        expect(hex(encodeTargetSso12Reserve({ field12: fromHex('aabb') }))).toBe('');
        expect(
            hex(encodeTargetSso12Reserve({ field12: fromHex('aabb'), field21Enabled: false })),
        ).toBe('');
        expect(hex(encodeTargetSso12Reserve({ field13: new Uint8Array() }))).toBe('6a00');
        expect(hex(encodeTargetSso12Reserve({ field15: new Uint8Array() }))).toBe('7a00');
        expect(hex(encodeTargetSso12Reserve({ field16: new Uint8Array() }))).toBe('820100');
        expect(hex(encodeTargetSso12Reserve({ field26: 0 }))).toBe('d00100');
        expect(hex(encodeTargetSso12Reserve({ field21Enabled: true }))).toBe('a80120');
        expect(hex(encodeTargetSso12Reserve({ field12: fromHex('aa'), field26: 0 }))).toBe(
            '6201aad00100',
        );
        expect(
            hex(
                encodeTargetSso12Reserve({
                    field12: new Uint8Array(),
                    field26: 0,
                    field32: new Uint8Array(),
                }),
            ),
        ).toBe('d00100');
        expect(hex(encodeTargetSso12Reserve({ field32: fromHex('01') }))).toBe('82020101');
        expect(hex(encodeTargetSso12Reserve({ field26: 0xffffffff }))).toBe('d001ffffffff0f');
    });

    it('does not activate serialization for field 23 with empty child bytes alone', () => {
        expect(
            hex(
                encodeTargetSso12Reserve({
                    field23: [{ field1: new Uint8Array(), field2: new Uint8Array() }],
                }),
            ),
        ).toBe('');
    });

    it('emits both empty field 23 child bytes when field 13 activates serialization', () => {
        expect(
            hex(
                encodeTargetSso12Reserve({
                    field13: new Uint8Array(),
                    field23: [{ field1: new Uint8Array(), field2: new Uint8Array() }],
                }),
            ),
        ).toBe('6a00ba01040a001200');
    });

    it('preserves field 23 child order and explicit empty bytes across repeated entries', () => {
        expect(
            hex(
                encodeTargetSso12Reserve({
                    field13: new Uint8Array(),
                    field23: [
                        { field1: Uint8Array.of(1), field2: Uint8Array.of(2) },
                        { field1: Uint8Array.of(3), field2: new Uint8Array() },
                    ],
                }),
            ),
        ).toBe('6a00ba01060a0101120102ba01050a01031200');
    });

    it('creates field 24 only when at least one of the three children is nonempty', () => {
        expect(hex(encodeTargetSso12Reserve({ field24: {} }))).toBe('');
        expect(
            hex(
                encodeTargetSso12Reserve({
                    field24: {
                        field1: new Uint8Array(),
                        field2: new Uint8Array(),
                        field3: new Uint8Array(),
                    },
                }),
            ),
        ).toBe('');

        for (const [field, wire] of [
            ['field1', 'c201030a01aa'],
            ['field2', 'c201031201aa'],
            ['field3', 'c201031a01aa'],
        ] as const) {
            expect(hex(encodeTargetSso12Reserve({ field24: { [field]: fromHex('aa') } }))).toBe(
                wire,
            );
        }

        expect(
            hex(encodeTargetSso12Reserve({ field24: { field1: new Uint8Array() }, field26: 0 })),
        ).toBe('d00100');
    });

    it('enforces the local complete encoded size cap', () => {
        const value = new Uint8Array(MAX_TARGET_SSO12_RESERVE_BYTES - 5);
        value[value.length - 1] = 0xa5;
        const result = encodeTargetSso12Reserve({ field13: value });
        expect(result.length).toBe(MAX_TARGET_SSO12_RESERVE_BYTES);
        expect(result[result.length - 1]).toBe(0xa5);
        expect(() =>
            encodeTargetSso12Reserve({ field13: new Uint8Array(value.length + 1) }),
        ).toThrow(failure);
        expect(() =>
            encodeTargetSso12Reserve({ field13: value, field15: Uint8Array.of(1) }),
        ).toThrow(failure);
        expect(() =>
            encodeTargetSso12Reserve({
                field12: new Uint8Array(MAX_TARGET_SSO12_RESERVE_BYTES + 1),
            }),
        ).toThrow(failure);
    });

    it('rejects invalid types, out-of-range numbers, unknown fields, and field 23', () => {
        for (const value of [null, [], new Uint8Array(), 1, 'x']) {
            expect(() => encodeTargetSso12Reserve(value as never)).toThrow(failure);
        }

        for (const field of ['field12', 'field13', 'field15', 'field16', 'field32'] as const) {
            for (const value of [undefined, null, [], 'x', new DataView(new ArrayBuffer(1))]) {
                expect(() => encodeTargetSso12Reserve({ [field]: value } as never)).toThrow(
                    failure,
                );
            }
        }

        for (const value of [-1, 0x100000000, 1.5, NaN, Infinity, '1', undefined]) {
            expect(() => encodeTargetSso12Reserve({ field26: value } as never)).toThrow(failure);
        }

        for (const value of [null, 0, 1, undefined]) {
            expect(() => encodeTargetSso12Reserve({ field21Enabled: value } as never)).toThrow(
                failure,
            );
        }

        expect(() => encodeTargetSso12Reserve({ field23: new Uint8Array() } as never)).toThrow(
            failure,
        );
        expect(() =>
            encodeTargetSso12Reserve({ field24: { field4: new Uint8Array() } } as never),
        ).toThrow(failure);
        expect(() => encodeTargetSso12Reserve({ field24: null } as never)).toThrow(failure);
    });

    it('snapshots byte subviews and ignores shadow accessors or iterators', () => {
        const backing = Uint8Array.of(0, 0xaa, 0xbb, 0);
        const bytes = backing.subarray(1, 3);

        for (const name of ['byteLength', 'buffer'] as const) {
            Object.defineProperty(bytes, name, {
                get() {
                    throw new Error('secret');
                },
            });
        }

        Object.defineProperty(bytes, Symbol.iterator, {
            get() {
                throw new Error('secret');
            },
        });
        const output = encodeTargetSso12Reserve({ field13: bytes });
        expect(hex(output)).toBe('6a02aabb');
        backing.fill(0);
        expect(hex(output)).toBe('6a02aabb');
    });

    it('accepts foreign ordinary views but rejects shared buffers across realms', () => {
        const foreign = runInNewContext('new Uint8Array([0xaa])') as Uint8Array;
        expect(hex(encodeTargetSso12Reserve({ field13: foreign }))).toBe('6a01aa');
        const shared = runInNewContext('new Uint8Array(new SharedArrayBuffer(1))') as Uint8Array;
        expect(() => encodeTargetSso12Reserve({ field13: shared })).toThrow(failure);
        expect(() => encodeTargetSso12Reserve({ field13: new Uint8Array(shared.buffer) })).toThrow(
            failure,
        );
        expect(() =>
            encodeTargetSso12Reserve({
                field24: { field1: new Uint8Array(new SharedArrayBuffer(1)) },
            }),
        ).toThrow(failure);
    });

    it('rejects detached byte views without treating them as empty values', () => {
        const value = new Uint8Array([1]);
        structuredClone(value, { transfer: [value.buffer] });
        expect(() => encodeTargetSso12Reserve({ field13: value })).toThrow(failure);
        expect(() => encodeTargetSso12Reserve({ field24: { field1: value } })).toThrow(failure);
    });

    it('rejects accessors and proxies without invoking traps and sanitizes errors', () => {
        let calls = 0;
        const getter = { field13: Uint8Array.of(1) };
        Object.defineProperty(getter, 'field26', {
            get() {
                calls++;
                throw new Error('SECRET');
            },
        });
        expect(() => encodeTargetSso12Reserve(getter)).toThrow(failure);
        const nested = Object.defineProperty({}, 'field1', {
            get() {
                calls++;
                throw new Error('SECRET');
            },
        });
        expect(() => encodeTargetSso12Reserve({ field24: nested })).toThrow(failure);
        const proxy = new Proxy(
            {},
            {
                ownKeys() {
                    calls++;
                    throw new Error('SECRET');
                },
                getPrototypeOf() {
                    calls++;
                    throw new Error('SECRET');
                },
            },
        );
        expect(() => encodeTargetSso12Reserve(proxy)).toThrow(failure);
        expect(() => encodeTargetSso12Reserve({ field24: proxy })).toThrow(failure);
        expect(calls).toBe(0);
    });
});
