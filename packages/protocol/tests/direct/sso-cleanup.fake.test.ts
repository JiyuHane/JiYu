import { deflateSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeSsoResponse, encodeSso12Request, encodeSso13Request } from '../../src/direct/sso';

// All packets and payloads in this file are synthetic. The real zlib algorithm
// still runs; the wrapper observes only the buffer passed to inflateSync.
const observed = vi.hoisted(() => ({
    calls: [] as { input: unknown; before: number[]; threw: boolean }[],
}));

vi.mock('node:zlib', async () => {
    const actual = await vi.importActual<typeof import('node:zlib')>('node:zlib');

    return {
        ...actual,
        inflateSync(
            input: Parameters<typeof actual.inflateSync>[0],
            options?: Parameters<typeof actual.inflateSync>[1],
        ) {
            const call = {
                input,
                before: input instanceof Uint8Array ? [...input] : [],
                threw: false,
            };
            observed.calls.push(call);

            try {
                return actual.inflateSync(input, options);
            } catch (error) {
                call.threw = true;
                throw error;
            }
        },
    };
});

function int32(value: number): Buffer {
    const result = Buffer.alloc(4);
    result.writeInt32BE(value);
    return result;
}

function field(value: Uint8Array): Buffer {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(value.length + 4);
    return Buffer.concat([size, value]);
}

function response(flag: number, body: Uint8Array, emptyText = false): Buffer {
    const header = Buffer.concat([
        int32(123),
        int32(-12),
        field(Buffer.from(emptyText ? '' : 'extra')),
        field(Buffer.from(emptyText ? '' : 'Synthetic.Command')),
        field(Buffer.from([0x21, 0x22])),
        int32(flag),
        field(Buffer.from([0x31, 0x32])),
        Buffer.from([0x41, 0x42]),
    ]);

    return Buffer.concat([int32(header.length + 4), header, field(body)]);
}

function expectInflateInputErased(expected: Uint8Array, threw: boolean): void {
    expect(observed.calls).toHaveLength(1);
    const call = observed.calls[0]!;
    expect(call.input).toBeInstanceOf(Uint8Array);
    expect(call.before).toEqual([...expected]);
    expect(call.before.some((byte) => byte !== 0)).toBe(true);
    expect(call.threw).toBe(threw);
    expect(call.input).toEqual(new Uint8Array(expected.length));
}

beforeEach(() => {
    observed.calls.length = 0;
});

describe('synthetic SSO response ownership', () => {
    it('erases the compressed copy after real inflation, preserving result and input', () => {
        const body = Buffer.from('synthetic body survives inflation');
        const compressed = deflateSync(body);
        const input = response(1, compressed);
        const original = Buffer.from(input);

        const parsed = decodeSsoResponse(input);

        expectInflateInputErased(compressed, false);
        expect(input).toEqual(original);
        expect(parsed).toEqual({
            sequence: 123,
            retCode: -12,
            extra: 'extra',
            command: 'Synthetic.Command',
            cookie: Uint8Array.of(0x21, 0x22),
            dataFlag: 1,
            reserved: Uint8Array.of(0x31, 0x32),
            body,
            headerExtension: Uint8Array.of(0x41, 0x42),
        });
        input.fill(0);
        expect(Buffer.from(parsed.body)).toEqual(body);
    });

    it.each([0, 4])('preserves flag %i fields and separates returned byte arrays', (flag) => {
        const body = Buffer.from([0x51, 0x52, 0x53]);
        const input = response(flag, body);
        const original = Buffer.from(input);
        const parsed = decodeSsoResponse(input);
        const fields = [parsed.cookie, parsed.reserved, parsed.headerExtension, parsed.body];
        const expected = [
            Buffer.from([0x21, 0x22]),
            Buffer.from([0x31, 0x32]),
            Buffer.from([0x41, 0x42]),
            body,
        ];

        expect(observed.calls).toHaveLength(0);
        expect(input).toEqual(original);
        expect(parsed.extra).toBe('extra');
        expect(parsed.command).toBe('Synthetic.Command');
        expect(parsed.dataFlag).toBe(flag);
        fields.forEach((value, index) => expect(Buffer.from(value)).toEqual(expected[index]));

        for (let index = 0; index < fields.length; index++) {
            const old = fields[index]![0]!;
            fields[index]![0] = old ^ 0xff;
            fields.forEach((value, other) => {
                if (other !== index) {
                    expect(Buffer.from(value)).toEqual(expected[other]);
                }
            });
            expect(input).toEqual(original);
            fields[index]![0] = old;
        }

        input.fill(0);
        fields.forEach((value, index) => expect(Buffer.from(value)).toEqual(expected[index]));
    });

    it('erases the compressed copy when real inflation throws', () => {
        const invalid = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
        const input = response(1, invalid);
        const original = Buffer.from(input);

        expect(() => decodeSsoResponse(input)).toThrow();
        expectInflateInputErased(invalid, true);
        expect(input).toEqual(original);
    });

    it('preserves the inflated-output limit and erases the rejected compressed copy', () => {
        const compressed = deflateSync(Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
        const input = response(1, compressed);
        const original = Buffer.from(input);

        expect(() => decodeSsoResponse(input)).toThrow();
        expectInflateInputErased(compressed, true);
        expect(input).toEqual(original);
    });

    it('retains explicit errors for trailing data, truncation and unsupported flags', () => {
        const good = response(0, Buffer.from([0x51, 0x52]));
        const trailing = Buffer.concat([good, Buffer.of(0x7f)]);
        const wrongFlag = response(7, Buffer.from([0x51]));
        const trailingBefore = Buffer.from(trailing);
        const wrongFlagBefore = Buffer.from(wrongFlag);

        expect(() => decodeSsoResponse(trailing)).toThrow(/trailing/);
        expect(() => decodeSsoResponse(wrongFlag)).toThrow(/flag/);
        expect(trailing).toEqual(trailingBefore);
        expect(wrongFlag).toEqual(wrongFlagBefore);

        for (let length = 0; length < good.length; length++) {
            const truncated = Buffer.from(good.subarray(0, length));
            const original = Buffer.from(truncated);
            expect(() => decodeSsoResponse(truncated)).toThrow();
            expect(truncated).toEqual(original);
        }
    });

    it('handles empty text and rejects empty or truncated headers', () => {
        const input = response(0, Buffer.alloc(0), true);
        const original = Buffer.from(input);
        const parsed = decodeSsoResponse(input);
        expect(parsed.extra).toBe('');
        expect(parsed.command).toBe('');
        expect(parsed.body).toEqual(new Uint8Array());
        expect(input).toEqual(original);
        expect(() => decodeSsoResponse(Buffer.alloc(0))).toThrow();
        expect(() => decodeSsoResponse(Buffer.from([0, 0, 0, 4]))).toThrow();
    });

    it('rejects invalid UTF-8 and independently truncated headers without changing input', () => {
        const invalidText = response(0, Buffer.of(0x51));
        invalidText[16] = 0xff;
        const valid = response(0, Buffer.of(0x51));
        const headerLength = valid.readUInt32BE(0);
        const truncatedHeader = Buffer.from(valid.subarray(0, headerLength - 1));

        for (const input of [invalidText, truncatedHeader]) {
            const original = Buffer.from(input);
            expect(() => decodeSsoResponse(input)).toThrow();
            expect(input).toEqual(original);
        }
    });

    it('keeps the error classification on consecutive real inflate failures', () => {
        const invalid = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
        const errors: { name: string; message: string }[] = [];

        for (let index = 0; index < 2; index++) {
            observed.calls.length = 0;
            const input = response(1, invalid);
            const original = Buffer.from(input);
            let caught: unknown;

            try {
                decodeSsoResponse(input);
            } catch (error) {
                caught = error;
            }

            expect(caught).toBeInstanceOf(Error);
            const error = caught as Error;
            errors.push({ name: error.name, message: error.message });
            expectInflateInputErased(invalid, true);
            expect(input).toEqual(original);
        }

        expect(errors[1]).toEqual(errors[0]);
    });

    it('keeps both existing request encoders available with empty binary fields', () => {
        const body = new Uint8Array();
        const reserved = new Uint8Array();
        expect(
            encodeSso12Request({
                sequence: 1,
                subAppId: 2,
                a2: new Uint8Array(),
                command: 'A',
                guid: Uint8Array.of(0xab),
                version: 'V',
                reserved,
                body,
            }),
        ).toBeInstanceOf(Uint8Array);
        expect(encodeSso13Request({ command: 'A', reserved, body })).toBeInstanceOf(Uint8Array);
        expect(body).toEqual(new Uint8Array());
        expect(reserved).toEqual(new Uint8Array());
    });
});
