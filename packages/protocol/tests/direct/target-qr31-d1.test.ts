import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeTargetQr31D1 } from '../../src/direct/target-qr31-d1';
import { encodeWtQrD1Request } from '../../src/direct/wt-qr-protobuf';

// Hand-derived synthetic target-static vectors, not captures or live packets.
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const empty = (): Uint8Array => new Uint8Array();
const failure = 'target QR31 D1 encoding failed';

afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('target-static QR31 D1 TLV', () => {
    it('encodes both empty child byte fields with explicit Proton presence', () => {
        expect(hex(encodeTargetQr31D1({ field1: empty(), field2: empty() }))).toBe(
            '00d1000a0a040a00120022023001',
        );
        // Reference schema uses ordinary strings and omits both empty child fields.
        expect(hex(encodeWtQrD1Request({ deviceType: '', deviceName: '' }))).toBe('0a0022023001');
    });

    it('preserves arbitrary binary, NUL and independent byte sequences', () => {
        expect(
            hex(
                encodeTargetQr31D1({ field1: Uint8Array.of(0xff, 0), field2: Uint8Array.of(0x80) }),
            ),
        ).toBe('00d1000d0a070a02ff0012018022023001');
        expect(hex(encodeTargetQr31D1({ field1: empty(), field2: Uint8Array.of(0) }))).toBe(
            '00d1000b0a050a0012010022023001',
        );
    });

    it.each([
        [123, '0085', '7f', '7b'],
        [124, '0087', '8001', '7c'],
        [127, '008a', '8301', '7f'],
        [128, '008c', '8501', '8001'],
        [16378, '4006', 'ff7f', 'fa7f'],
        [16379, '4008', '808001', 'fb7f'],
        [16383, '400c', '848001', 'ff7f'],
        [16384, '400e', '868001', '808001'],
    ])(
        'encodes nested and field varint boundaries for %i bytes',
        (length, payloadLength, innerLength, fieldLength) => {
            const value = new Uint8Array(length).fill(0xab);
            const prefix = `00d1${payloadLength}0a${innerLength}`;
            const tail = '22023001';
            expect(hex(encodeTargetQr31D1({ field1: value, field2: empty() }))).toBe(
                `${prefix}0a${fieldLength}${'ab'.repeat(length)}1200${tail}`,
            );
            expect(hex(encodeTargetQr31D1({ field1: empty(), field2: value }))).toBe(
                `${prefix}0a0012${fieldLength}${'ab'.repeat(length)}${tail}`,
            );
            expect(value.every((byte) => byte === 0xab)).toBe(true);
        },
    );

    it('checks total encoded payload size, including nested framing, before copying', () => {
        const value = new Uint8Array(65521);
        value[value.length - 1] = 0xa5;
        const output = encodeTargetQr31D1({ field1: value, field2: empty() });
        expect(output.length).toBe(65539);
        expect(hex(output.subarray(0, 4))).toBe('00d1ffff');
        expect(output[output.length - 7]).toBe(0xa5);
        expect(() =>
            encodeTargetQr31D1({ field1: new Uint8Array(65522), field2: empty() }),
        ).toThrow(failure);
        expect(() =>
            encodeTargetQr31D1({ field1: new Uint8Array(32760), field2: new Uint8Array(32760) }),
        ).toThrow(failure);
    });

    it('copies overlapping views and leaves inputs and returned bytes independent', () => {
        const backing = Uint8Array.of(0, 0xff, 0x80, 0);
        const input = { field1: backing.subarray(1, 3), field2: backing.subarray(2, 4) };
        const output = encodeTargetQr31D1(input);
        const expected = hex(output);
        expect(backing).toEqual(Uint8Array.of(0, 0xff, 0x80, 0));
        backing.fill(0);
        expect(hex(output)).toBe(expected);
        output.fill(0);
        expect(backing).toEqual(new Uint8Array(4));
    });

    it('accepts foreign byte arrays and ignores shadowed array properties', () => {
        const bytes = runInNewContext('new Uint8Array([255,0])') as Uint8Array;

        for (const property of ['byteLength', 'buffer'] as const) {
            Object.defineProperty(bytes, property, {
                get() {
                    throw new Error('SECRET');
                },
            });
        }

        Object.defineProperty(bytes, Symbol.iterator, {
            get() {
                throw new Error('SECRET');
            },
        });
        expect(hex(encodeTargetQr31D1({ field1: bytes, field2: empty() }))).toBe(
            '00d1000c0a060a02ff00120022023001',
        );
    });

    it('rejects missing/extra fields, invalid bytes, proxies and shared or detached buffers', () => {
        for (const value of [
            null,
            [],
            {},
            { field1: empty() },
            { field1: empty(), field2: empty(), extra: 1 },
        ]) {
            expect(() => encodeTargetQr31D1(value as never)).toThrow(failure);
        }

        for (const value of [
            null,
            undefined,
            'x',
            [],
            new Uint16Array(1),
            new DataView(new ArrayBuffer(1)),
            new Uint8Array(new SharedArrayBuffer(1)),
            new Proxy(Uint8Array.of(1), {}),
        ]) {
            expect(() => encodeTargetQr31D1({ field1: value, field2: empty() } as never)).toThrow(
                failure,
            );
        }

        const foreignShared = runInNewContext(
            'new Uint8Array(new SharedArrayBuffer(1))',
        ) as Uint8Array;
        expect(() => encodeTargetQr31D1({ field1: foreignShared, field2: empty() })).toThrow(
            failure,
        );
        const detached = Uint8Array.of(1);
        structuredClone(detached, { transfer: [detached.buffer] });
        expect(() => encodeTargetQr31D1({ field1: detached, field2: empty() })).toThrow(failure);
        const resizable = new ArrayBuffer(4, { maxByteLength: 8 });
        const outOfBounds = new Uint8Array(resizable, 2, 2);
        resizable.resize(1);
        expect(() => encodeTargetQr31D1({ field1: outOfBounds, field2: empty() })).toThrow(failure);
    });

    it('rejects getters and proxy traps without running caller code', () => {
        let calls = 0;
        const input = { field1: empty(), field2: empty() };
        Object.defineProperty(input, 'field2', {
            get() {
                calls++;
                throw new Error('SECRET');
            },
        });
        expect(() => encodeTargetQr31D1(input)).toThrow(failure);
        const proxy = new Proxy(input, {
            ownKeys() {
                calls++;
                throw new Error('SECRET');
            },
            getPrototypeOf() {
                calls++;
                throw new Error('SECRET');
            },
        });
        expect(() => encodeTargetQr31D1(proxy)).toThrow(failure);
        const bytes = Uint8Array.of(1);
        Object.setPrototypeOf(
            bytes,
            new Proxy(Uint8Array.prototype, {
                getPrototypeOf() {
                    calls++;
                    throw new Error('SECRET');
                },
                get() {
                    calls++;
                    throw new Error('SECRET');
                },
            }),
        );
        expect(() => encodeTargetQr31D1({ field1: bytes, field2: empty() })).toThrow(failure);
        expect(calls).toBe(0);
    });

    it.each(['success', 'copy-throw'] as const)('clears private snapshots on %s', async (mode) => {
        const first = Uint8Array.of(0xaa);
        const second = Uint8Array.of(0xbb);
        const snapshots: Uint8Array[] = [];
        let encoded: Uint8Array | undefined;
        const actualSet = Uint8Array.prototype.set;
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            value,
            offset,
        ) {
            if (value === first || value === second) {
                snapshots.push(this);
                actualSet.call(this, value, offset);

                if (mode === 'copy-throw' && value === second) {
                    throw new Error('SECRET');
                }

                return;
            }

            if (offset === 4 && value instanceof Uint8Array) {
                encoded = value;
            }

            actualSet.call(this, value, offset);
        });

        try {
            vi.resetModules();
            const { encodeTargetQr31D1: encode } = await import('../../src/direct/target-qr31-d1');

            if (mode === 'copy-throw') {
                expect(() => encode({ field1: first, field2: second })).toThrow(failure);
            } else {
                const output = encode({ field1: first, field2: second });
                expect(hex(output)).toBe('00d1000c0a060a01aa1201bb22023001');
                expect(encoded).toBeDefined();
                expect(encoded).toEqual(new Uint8Array(encoded!.length));
            }

            expect(snapshots).toHaveLength(2);
            expect(snapshots).toEqual([Uint8Array.of(0), Uint8Array.of(0)]);
            expect(first).toEqual(Uint8Array.of(0xaa));
            expect(second).toEqual(Uint8Array.of(0xbb));
        } finally {
            spy.mockRestore();
            vi.resetModules();
        }
    });

    it('continues cleaning every buffer when the first cleanup fails after the final copy throws', async () => {
        const first = Uint8Array.of(0xaa);
        const second = Uint8Array.of(0xbb);
        const cleared: Uint8Array[] = [];
        const actualSet = Uint8Array.prototype.set;
        const actualFill = Uint8Array.prototype.fill;
        let finalCopies = 0;

        vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            offset,
        ) {
            actualSet.call(this, source, offset);

            // Match only the final TLV copy for this exact synthetic fixture.
            if (
                offset === 4 &&
                this.length === 16 &&
                this[0] === 0 &&
                this[1] === 0xd1 &&
                this[2] === 0 &&
                this[3] === 12 &&
                source.length === 12 &&
                source[0] === 0x0a
            ) {
                finalCopies++;
                throw new Error('fixture copy failure');
            }
        });
        vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value,
            start,
            end,
        ) {
            cleared.push(this);

            if (cleared.length === 1) {
                throw new Error('fixture cleanup failure');
            }

            return actualFill.call(this, value, start, end);
        });
        vi.resetModules();
        const { encodeTargetQr31D1: encode } = await import('../../src/direct/target-qr31-d1');
        expect(() => encode({ field1: first, field2: second })).toThrowError(new Error(failure));
        expect(finalCopies).toBe(1);
        expect(cleared.map((value) => value.length)).toEqual([1, 1, 12, 16]);

        for (const value of cleared.slice(1)) {
            expect(value.every((byte) => byte === 0)).toBe(true);
        }

        expect(first).toEqual(Uint8Array.of(0xaa));
        expect(second).toEqual(Uint8Array.of(0xbb));
    });

    it('checks getters and combined length before any snapshot copies', async () => {
        const source = Uint8Array.of(1);
        const actualSet = Uint8Array.prototype.set;
        let copied = 0;
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            value,
            offset,
        ) {
            if (value === source) {
                copied++;
            }

            actualSet.call(this, value, offset);
        });

        try {
            vi.resetModules();
            const { encodeTargetQr31D1: encode } = await import('../../src/direct/target-qr31-d1');
            const bad = { field1: source, field2: empty() };
            Object.defineProperty(bad, 'field2', {
                get() {
                    throw new Error('SECRET');
                },
            });
            expect(() => encode(bad)).toThrow(failure);
            expect(() => encode({ field1: source, field2: new Uint8Array(65530) })).toThrow(
                failure,
            );
            expect(copied).toBe(0);
        } finally {
            spy.mockRestore();
            vi.resetModules();
        }
    });
});
