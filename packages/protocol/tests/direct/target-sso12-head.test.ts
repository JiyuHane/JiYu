import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
    encodeTargetSso12Head,
    MAX_TARGET_SSO12_HEAD_BYTES,
    type TargetSso12Head,
} from '../../src/direct/target-sso12-head';

// Hand-assembled synthetic data based on the stated native static write order;
// not a capture, execution of the target, or a wire interoperability result.
const vector = Buffer.from(
    [
        '00000043', // inclusive head length: 67
        '01020304', // sequence
        'a1a2a3a4', // arg0
        '11223344', // arg4
        '000000000000000000007f00', // 10 zero bytes, arg8, zero
        '00000006aabb', // A2
        '0000000700ff41', // opaque command
        '0000000580', // this+8
        '00000004', // arg+0x28
        '000000061122', // this+0x20
        '00040001', // arg+0x10 version
        '00000007deadbe', // reserved
    ].join(''),
    'hex',
);

function fixture(): TargetSso12Head {
    return {
        sequence: 0x01020304,
        arg0: 0xa1a2a3a4,
        arg4: 0x11223344,
        arg8: 0x7f,
        a2: Uint8Array.of(0xaa, 0xbb),
        requestCommand: Uint8Array.of(0, 0xff, 0x41),
        this8: Uint8Array.of(0x80),
        arg28: new Uint8Array(),
        this20: Uint8Array.of(0x11, 0x22),
        versionArg10: Uint8Array.of(0, 1),
        reserved: Uint8Array.of(0xde, 0xad, 0xbe),
    };
}

function empty(): TargetSso12Head {
    return {
        sequence: 0,
        arg0: 0,
        arg4: 0,
        arg8: 0,
        a2: new Uint8Array(),
        requestCommand: new Uint8Array(),
        this8: new Uint8Array(),
        arg28: new Uint8Array(),
        this20: new Uint8Array(),
        versionArg10: new Uint8Array(),
        reserved: new Uint8Array(),
    };
}

describe('target SSO12 head snapshot ownership', () => {
    it.each(['success', 'late-validation', 'copy-throw', 'cleanup-throw'] as const)(
        'clears actual local snapshots on %s and retains caller/output bytes',
        async (mode) => {
            const input = fixture();
            const sources = [
                input.a2,
                input.requestCommand,
                input.this8,
                input.arg28,
                input.this20,
                input.versionArg10,
                input.reserved,
            ];
            const before = sources.map((source) => Uint8Array.from(source));
            const owned: Uint8Array[] = [];
            const actualSet = Uint8Array.prototype.set;
            const set = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
                this: Uint8Array,
                source,
                offset,
            ) {
                if (sources.includes(source as Uint8Array)) {
                    owned.push(this);
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
                const { encodeTargetSso12Head: encode } =
                    await import('../../src/direct/target-sso12-head');

                if (mode === 'late-validation') {
                    input.this8 = null as never;
                }

                if (mode === 'late-validation' || mode === 'copy-throw') {
                    expect(() => encode(input)).toThrow('target SSO12 head construction failed');
                    expect(owned).toHaveLength(2);
                } else {
                    const output = encode(input);
                    expect(Buffer.from(output)).toEqual(vector);
                    expect(owned).toHaveLength(7);
                    expect(owned.some((copy) => copy.buffer === output.buffer)).toBe(false);
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

describe('target-static SSO12 request head', () => {
    it('matches every byte of the manually assembled synthetic vector', () => {
        expect(Buffer.from(encodeTargetSso12Head(fixture()))).toEqual(vector);
        expect(vector.readUInt32BE()).toBe(vector.length);
        expect(vector[0x10]).toBe(0);
        expect(vector[0x1a]).toBe(0x7f);
    });

    it('encodes inclusive empty fields and both integer endpoints', () => {
        const result = Buffer.from(encodeTargetSso12Head(empty()));
        expect(result.toString('hex')).toBe(
            '00000036' +
                '00000000'.repeat(3) +
                '000000000000000000000000' +
                '00000004'.repeat(5) +
                '0002' +
                '00000004',
        );
        const allOnes = encodeTargetSso12Head({
            ...empty(),
            sequence: 0xffffffff,
            arg0: 0xffffffff,
            arg4: 0xffffffff,
            arg8: 0xff,
        });
        expect(Buffer.from(allOnes.subarray(4, 16)).toString('hex')).toBe(
            'ffffffffffffffffffffffff',
        );
        expect(allOnes[0x1a]).toBe(0xff);
    });

    it('allows the largest inclusive u16 version and rejects overflow', () => {
        const version = new Uint8Array(65533).fill(0xc3);
        const result = encodeTargetSso12Head({ ...empty(), versionArg10: version });
        expect(result.length).toBe(54 + version.length);
        expect(Buffer.from(result.subarray(48, 50)).toString('hex')).toBe('ffff');
        expect(result.subarray(50, 50 + version.length)).toEqual(version);
        expect(() =>
            encodeTargetSso12Head({ ...empty(), versionArg10: new Uint8Array(65534) }),
        ).toThrow('target SSO12 head construction failed');
    });

    it('bounds the complete head before output allocation, including prefixes', () => {
        const bytes = new Uint8Array(MAX_TARGET_SSO12_HEAD_BYTES - 54);
        bytes[bytes.length - 1] = 0xa7;
        const result = encodeTargetSso12Head({ ...empty(), reserved: bytes });
        expect(result.length).toBe(MAX_TARGET_SSO12_HEAD_BYTES);
        expect(new DataView(result.buffer, result.byteOffset).getUint32(0)).toBe(result.length);
        expect(result[result.length - 1]).toBe(0xa7);
        expect(() =>
            encodeTargetSso12Head({ ...empty(), reserved: new Uint8Array(bytes.length + 1) }),
        ).toThrow('target SSO12 head construction failed');
        expect(() =>
            encodeTargetSso12Head({ ...empty(), a2: bytes, reserved: Uint8Array.of(1) }),
        ).toThrow('target SSO12 head construction failed');
    });

    it('handles subviews, copies outputs and leaves inputs unchanged', () => {
        const backing = Uint8Array.of(7, 0xaa, 0xbb, 8);
        const input = { ...fixture(), a2: backing.subarray(1, 3) };
        const output = encodeTargetSso12Head(input);
        expect(backing).toEqual(Uint8Array.of(7, 0xaa, 0xbb, 8));
        backing.fill(0);
        expect(Buffer.from(output)).toEqual(vector);
        output.fill(0);
        expect(backing).toEqual(new Uint8Array(4));
    });

    it('rejects request accessors before invoking them or changing earlier fields', () => {
        const input = fixture();
        let reads = 0;
        Object.defineProperty(input, 'requestCommand', {
            get() {
                reads++;
                input.a2.fill(0);
                input.sequence = 0;
                return Uint8Array.of(0, 0xff, 0x41);
            },
        });
        expect(() => encodeTargetSso12Head(input)).toThrow('target SSO12 head construction failed');
        expect(reads).toBe(0);
        expect(input.a2).toEqual(Uint8Array.of(0xaa, 0xbb));
        expect(input.sequence).toBe(0x01020304);
    });

    it('ignores caller-provided iterators and shadow length or buffer getters', () => {
        const data = Uint8Array.of(0xaa, 0xbb);
        Object.defineProperty(data, Symbol.iterator, {
            get() {
                throw new Error('iterator');
            },
        });
        Object.defineProperty(data, 'byteLength', {
            get() {
                throw new Error('length');
            },
        });
        Object.defineProperty(data, 'buffer', {
            get() {
                throw new Error('buffer');
            },
        });
        expect(Buffer.from(encodeTargetSso12Head({ ...fixture(), a2: data }))).toEqual(vector);
    });

    it('rejects invalid numeric values and invalid byte types', () => {
        const input = fixture();

        for (const field of ['sequence', 'arg0', 'arg4'] as const) {
            for (const n of [-1, 0x100000000, 1.5, NaN, Infinity, '1']) {
                expect(() => encodeTargetSso12Head({ ...input, [field]: n as number })).toThrow();
            }
        }

        for (const n of [-1, 256, 0.5, NaN, Infinity, '1']) {
            expect(() => encodeTargetSso12Head({ ...input, arg8: n as number })).toThrow();
        }

        for (const field of [
            'a2',
            'requestCommand',
            'this8',
            'arg28',
            'this20',
            'versionArg10',
            'reserved',
        ] as const) {
            for (const invalid of [null, undefined, 'abc', [], new DataView(new ArrayBuffer(2))]) {
                expect(() =>
                    encodeTargetSso12Head({ ...input, [field]: invalid as Uint8Array }),
                ).toThrow();
            }
        }

        expect(() => encodeTargetSso12Head(null as unknown as TargetSso12Head)).toThrow();
    });

    it('handles ordinary byte views from other realms while rejecting shared backing', () => {
        const foreign = runInNewContext('new Uint8Array([0xaa, 0xbb])') as Uint8Array;
        expect(foreign instanceof Uint8Array).toBe(false);
        expect(Buffer.from(encodeTargetSso12Head({ ...fixture(), a2: foreign }))).toEqual(vector);

        const foreignShared = runInNewContext(
            'new Uint8Array(new SharedArrayBuffer(2))',
        ) as Uint8Array;
        expect(foreignShared.buffer instanceof SharedArrayBuffer).toBe(false);
        expect(() => encodeTargetSso12Head({ ...fixture(), a2: foreignShared })).toThrow(
            'target SSO12 head construction failed',
        );

        const foreignSharedWithLocalView = new Uint8Array(foreignShared.buffer);
        expect(() =>
            encodeTargetSso12Head({ ...fixture(), a2: foreignSharedWithLocalView }),
        ).toThrow('target SSO12 head construction failed');
    });

    it('rejects proxies and accessors without invoking traps, including error reuse', () => {
        let captured: Error | undefined;

        try {
            encodeTargetSso12Head({ ...fixture(), sequence: -1 });
        } catch (error) {
            captured = error as Error;
        }

        expect(captured).toBeDefined();
        captured!.message = 'SECRET-DO-NOT-LOG';
        const input = fixture();
        let called = 0;
        Object.defineProperty(input, 'arg4', {
            get() {
                called++;
                throw captured;
            },
        });
        let received = '';

        try {
            encodeTargetSso12Head(input);
        } catch (error) {
            received = (error as Error).message;
        }

        expect(received).toBe('target SSO12 head construction failed');
        expect(called).toBe(0);
        let traps = 0;
        const proxy = new Proxy(fixture(), {
            get() {
                traps++;
                throw captured;
            },
            getPrototypeOf() {
                traps++;
                throw captured;
            },
            ownKeys() {
                traps++;
                throw captured;
            },
            getOwnPropertyDescriptor() {
                traps++;
                throw captured;
            },
        });
        expect(() => encodeTargetSso12Head(proxy)).toThrow('target SSO12 head construction failed');
        expect(traps).toBe(0);
        const symbols = fixture();
        Object.defineProperty(symbols, Symbol('unused'), {
            get() {
                called++;
                throw captured;
            },
        });
        expect(() => encodeTargetSso12Head(symbols)).toThrow(
            'target SSO12 head construction failed',
        );
        expect(called).toBe(0);
    });

    it('rejects shared backing storage and sanitizes exceptions thrown by getters', () => {
        const input = fixture();
        const shared = new Uint8Array(new SharedArrayBuffer(2));
        expect(() => encodeTargetSso12Head({ ...input, a2: shared })).toThrow(
            'target SSO12 head construction failed',
        );
        Object.defineProperty(input, 'arg28', {
            get() {
                throw new Error('SECRET-DO-NOT-LOG');
            },
        });

        try {
            encodeTargetSso12Head(input);
            throw new Error('expected failure');
        } catch (error) {
            expect(String(error)).not.toContain('SECRET-DO-NOT-LOG');
            expect(String(error)).toContain('construction failed');
        }
    });
});
