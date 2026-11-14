import type { DirectSsoReserve } from '@snowluma/proto-defs/sso-reserve';
import { protobuf_decode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { createSsoReserveBuilder } from '../../src/direct/sso-reserve';

const request = {
    uin: '123456',
    command: 'command',
    sequence: 0xffffffff,
    body: Buffer.from([1, 2]),
};

describe('SSO reserved metadata builder', () => {
    it('encodes a synthetic signed metadata vector with the full request body', async () => {
        const signer = vi.fn(async (input) => {
            expect(input).toMatchObject({
                uin: request.uin,
                command: request.command,
                sequence: 0xffffffff,
            });
            expect(input.body).toEqual(Uint8Array.of(1, 2));
            input.body.fill(9);
            return { sign: Uint8Array.of(1), token: Uint8Array.of(2), extra: Uint8Array.of(3) };
        });
        const builder = createSsoReserveBuilder({
            uin: request.uin,
            uid: 'b',
            classifySigning: () => 'sign',
            sign: signer,
            msgType: 32,
            ntCoreVersion: 100,
            createTraceParent: () => 'a',
        });
        const output = await builder(request);
        // Manually derived from the public field declarations, not a QQ capture.
        expect(Buffer.from(output).toString('hex')).toBe(
            '7a016182010162a80120c201090a01011201021a0103d00164',
        );
        expect(request.body).toEqual(Buffer.from([1, 2]));
        expect(signer).toHaveBeenCalledOnce();
        const parsed = protobuf_decode<DirectSsoReserve>(output);
        expect(parsed.traceParent).toBe('a');
        expect(parsed.uid).toBe('b');
        expect(parsed.secureInfo?.sign).toEqual(Uint8Array.of(1));
        expect(parsed.secureInfo?.token).toEqual(Uint8Array.of(2));
        expect(parsed.secureInfo?.extra).toEqual(Uint8Array.of(3));
    });

    it('emits unsigned metadata only when explicitly classified as unsigned', async () => {
        const signer = vi.fn();
        const builder = createSsoReserveBuilder({
            uin: request.uin,
            classifySigning: () => 'unsigned',
            sign: signer,
            createTraceParent: () => 'a',
        });
        expect(Buffer.from(await builder(request)).toString('hex')).toBe('7a0161');
        expect(signer).not.toHaveBeenCalled();
    });

    it.each(['trace', 'classifier'] as const)(
        'uses the pre-callback snapshot when %s mutates the request',
        async (stage) => {
            const originalBody = Buffer.from([1, 2]);
            const input = { uin: '123456', command: 'original', sequence: 42, body: originalBody };
            const mutate = () => {
                input.command = 'changed';
                input.sequence = 99;
                originalBody.fill(8);
                input.body = Buffer.from([9]);
            };
            const classify = vi.fn((command: string) => {
                if (stage === 'classifier') {
                    mutate();
                }

                return command === 'original' ? 'sign' : 'unsigned';
            });
            const sign = vi.fn(
                async (signed: { command: string; sequence: number; body: Uint8Array }) => {
                    expect(signed.command).toBe('original');
                    expect(signed.sequence).toBe(42);
                    expect(signed.body).toEqual(Uint8Array.of(1, 2));
                    signed.body.fill(7);
                    return {
                        sign: Uint8Array.of(1),
                        token: new Uint8Array(),
                        extra: new Uint8Array(),
                    };
                },
            );
            const builder = createSsoReserveBuilder({
                uin: input.uin,
                createTraceParent: () => {
                    if (stage === 'trace') {
                        mutate();
                    }

                    return 'a';
                },
                classifySigning: classify,
                sign,
            });

            await builder(input);
            expect(classify).toHaveBeenCalledExactlyOnceWith('original');
            expect(sign).toHaveBeenCalledOnce();
            expect(originalBody).toEqual(Buffer.from([8, 8]));
            expect(input.body).toEqual(Buffer.from([9]));
        },
    );

    it('keeps the snapshot while an asynchronous signer is waiting', async () => {
        const originalBody = Uint8Array.of(1, 2);
        const input = { uin: '123456', command: 'original', sequence: 42, body: originalBody };
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const classify = vi.fn(() => 'sign' as const);
        const sign = vi.fn(
            async (signed: { command: string; sequence: number; body: Uint8Array }) => {
                await gate;
                expect(signed.command).toBe('original');
                expect(signed.sequence).toBe(42);
                expect(signed.body).toEqual(Uint8Array.of(1, 2));
                signed.body.fill(7);
                return { sign: Uint8Array.of(1), token: new Uint8Array(), extra: new Uint8Array() };
            },
        );
        const builder = createSsoReserveBuilder({
            uin: input.uin,
            createTraceParent: () => 'a',
            classifySigning: classify,
            sign,
        });
        const pending = builder(input);
        expect(sign).toHaveBeenCalledOnce();
        input.command = 'changed';
        input.sequence = 99;
        originalBody.fill(8);
        input.body = Uint8Array.of(9);
        release();
        await pending;
        expect(classify).toHaveBeenCalledExactlyOnceWith('original');
        expect(originalBody).toEqual(Uint8Array.of(8, 8));
        expect(input.body).toEqual(Uint8Array.of(9));
    });

    it('does not sign an originally unsigned command mutated by the classifier', async () => {
        const input = { uin: '123456', command: 'unsigned', sequence: 42, body: Uint8Array.of(1) };
        const sign = vi.fn();
        const classify = vi.fn((command: string) => {
            input.command = 'requires-signature';
            input.sequence = 99;
            input.body.fill(8);
            return command === 'unsigned' ? 'unsigned' : 'sign';
        });
        const builder = createSsoReserveBuilder({
            uin: input.uin,
            classifySigning: classify,
            sign,
            createTraceParent: () => 'a',
        });
        expect(Buffer.from(await builder(input)).toString('hex')).toBe('7a0161');
        expect(classify).toHaveBeenCalledExactlyOnceWith('unsigned');
        expect(sign).not.toHaveBeenCalled();
    });

    it('reads each request field once and validates before callbacks', async () => {
        const reads = { uin: 0, command: 0, sequence: 0, body: 0 };
        const builder = createSsoReserveBuilder({
            uin: request.uin,
            classifySigning: () => 'unsigned',
            createTraceParent: () => 'a',
        });
        await builder({
            get uin() {
                reads.uin++;
                return request.uin;
            },
            get command() {
                reads.command++;
                return request.command;
            },
            get sequence() {
                reads.sequence++;
                return request.sequence;
            },
            get body() {
                reads.body++;
                return request.body;
            },
        });
        expect(reads).toEqual({ uin: 1, command: 1, sequence: 1, body: 1 });

        const trace = vi.fn(() => 'a');
        const classify = vi.fn(() => 'sign' as const);
        const sign = vi.fn();
        const checked = createSsoReserveBuilder({
            uin: request.uin,
            classifySigning: classify,
            createTraceParent: trace,
            sign,
        });
        for (const invalid of [
            { ...request, uin: '999' },
            { ...request, command: '' },
            { ...request, command: 'a'.repeat(64 * 1024 + 1) },
            { ...request, sequence: undefined as never },
            { ...request, sequence: -1 },
            { ...request, body: 'invalid' as never },
            { ...request, body: new Uint8Array(16 * 1024 * 1024 + 1) },
        ]) {
            await expect(checked(invalid)).rejects.toThrow();
        }

        expect(trace).not.toHaveBeenCalled();
        expect(classify).not.toHaveBeenCalled();
        expect(sign).not.toHaveBeenCalled();
    });

    it('preserves the request size boundaries for unsigned input', async () => {
        const classify = vi.fn(() => 'unsigned' as const);
        const builder = createSsoReserveBuilder({
            uin: request.uin,
            classifySigning: classify,
            createTraceParent: () => 'a',
        });
        await expect(
            builder({
                ...request,
                command: 'a'.repeat(64 * 1024),
                body: new Uint8Array(16 * 1024 * 1024),
            }),
        ).resolves.toBeInstanceOf(Uint8Array);
        expect(classify).toHaveBeenCalledOnce();
    });

    it('rejects an oversized body even if a subclass masks byteLength', async () => {
        const observedByteLength = vi.fn(() => 1);
        class MaskedBody extends Uint8Array {
            override get byteLength(): number {
                return observedByteLength();
            }
        }

        const trace = vi.fn(() => 'a');
        const classify = vi.fn(() => 'unsigned' as const);
        const builder = createSsoReserveBuilder({
            uin: request.uin,
            classifySigning: classify,
            createTraceParent: trace,
        });
        await expect(
            builder({ ...request, body: new MaskedBody(16 * 1024 * 1024 + 1) }),
        ).rejects.toThrow(/body/);
        expect(observedByteLength).not.toHaveBeenCalled();
        expect(trace).not.toHaveBeenCalled();
        expect(classify).not.toHaveBeenCalled();
    });

    it('generates an independent trace for each request by default', async () => {
        const builder = createSsoReserveBuilder({
            uin: request.uin,
            classifySigning: () => 'unsigned',
        });
        const first = protobuf_decode<DirectSsoReserve>(await builder(request)).traceParent;
        const second = protobuf_decode<DirectSsoReserve>(await builder(request)).traceParent;
        expect(first).toMatch(/^01-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
        expect(second).toMatch(/^01-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
        expect(first).not.toBe(second);
    });

    it('rejects missing or invalid required signatures without unsigned fallback', async () => {
        const missing = createSsoReserveBuilder({
            uin: request.uin,
            classifySigning: () => 'sign',
        });
        await expect(missing(request)).rejects.toThrow(/signer is missing/);

        for (const value of [
            null,
            {},
            { sign: new Uint8Array(), token: new Uint8Array(), extra: new Uint8Array() },
            { sign: Uint8Array.of(1), token: 'x', extra: new Uint8Array() },
        ]) {
            const builder = createSsoReserveBuilder({
                uin: request.uin,
                classifySigning: () => 'sign',
                sign: async () => value as never,
            });
            await expect(builder(request)).rejects.toThrow(/signature/);
        }

        const failing = createSsoReserveBuilder({
            uin: request.uin,
            classifySigning: () => 'sign',
            sign: async () => {
                throw new Error('signer failed');
            },
        });
        await expect(failing(request)).rejects.toThrow('signer failed');
    });

    it('validates real signature lengths rather than shadowed length properties', async () => {
        const disguise = (value: Uint8Array) => {
            const length = vi.fn(() => 1);
            const byteLength = vi.fn(() => 1);
            Object.defineProperties(value, {
                length: { get: length },
                byteLength: { get: byteLength },
            });
            return { value, length, byteLength };
        };

        for (const field of ['sign', 'token', 'extra'] as const) {
            for (const size of field === 'sign' ? [0, 64 * 1024 + 1] : [64 * 1024 + 1]) {
                const masked = disguise(new Uint8Array(size));
                const signature = {
                    sign: Uint8Array.of(1),
                    token: new Uint8Array(),
                    extra: new Uint8Array(),
                    [field]: masked.value,
                };
                const builder = createSsoReserveBuilder({
                    uin: request.uin,
                    classifySigning: () => 'sign',
                    sign: async () => signature,
                    createTraceParent: () => 'a',
                });
                await expect(builder(request)).rejects.toThrow(`invalid signature ${field}`);
                expect(masked.length).not.toHaveBeenCalled();
                expect(masked.byteLength).not.toHaveBeenCalled();
            }
        }
    });

    it('reads and snapshots each signature field once before the next getter', async () => {
        const signBytes = Buffer.from([1, 2]);
        const token = Uint8Array.of(3);
        const extra = Buffer.from([4]);
        const iterator = vi.fn(() => [99][Symbol.iterator]());
        for (const value of [signBytes, token, extra]) {
            Object.defineProperty(value, Symbol.iterator, { value: iterator });
        }

        const reads = { sign: 0, token: 0, extra: 0 };
        const signature = {
            get sign() {
                if (++reads.sign !== 1) {
                    throw new Error('sign was read twice');
                }
                return signBytes;
            },
            get token() {
                if (++reads.token !== 1) {
                    throw new Error('token was read twice');
                }
                signBytes.fill(9);
                return token;
            },
            get extra() {
                if (++reads.extra !== 1) {
                    throw new Error('extra was read twice');
                }
                token.fill(9);
                return extra;
            },
        };
        const builder = createSsoReserveBuilder({
            uin: request.uin,
            classifySigning: () => 'sign',
            sign: async () => signature,
            createTraceParent: () => 'a',
        });
        const parsed = protobuf_decode<DirectSsoReserve>(await builder(request));
        expect(parsed.secureInfo?.sign).toEqual(Uint8Array.of(1, 2));
        expect(parsed.secureInfo?.token).toEqual(Uint8Array.of(3));
        expect(parsed.secureInfo?.extra).toEqual(Uint8Array.of(4));
        expect(reads).toEqual({ sign: 1, token: 1, extra: 1 });
        expect(iterator).not.toHaveBeenCalled();
    });

    it('accepts boundary-sized signature fields and empty token and extra', async () => {
        for (const length of [0, 64 * 1024]) {
            const builder = createSsoReserveBuilder({
                uin: request.uin,
                classifySigning: () => 'sign',
                sign: async () => ({
                    sign: Buffer.alloc(64 * 1024, 1),
                    token: new Uint8Array(length),
                    extra: Buffer.alloc(length),
                }),
                createTraceParent: () => 'a',
            });
            const parsed = protobuf_decode<DirectSsoReserve>(await builder(request));
            expect(parsed.secureInfo?.sign?.byteLength).toBe(64 * 1024);
            expect(parsed.secureInfo?.token?.byteLength ?? 0).toBe(length);
            expect(parsed.secureInfo?.extra?.byteLength ?? 0).toBe(length);
        }
    });

    it('rejects wrong account, bad sequence, invalid mode and invalid input', async () => {
        expect(() =>
            createSsoReserveBuilder({ uin: 'x', classifySigning: () => 'unsigned' }),
        ).toThrow(/account/);
        expect(() =>
            createSsoReserveBuilder({ uin: request.uin, classifySigning: null as never }),
        ).toThrow(/classification/);
        expect(() =>
            createSsoReserveBuilder({
                uin: request.uin,
                classifySigning: () => 'unsigned',
                msgType: -1,
            }),
        ).toThrow(/msgType/);
        const builder = createSsoReserveBuilder({
            uin: request.uin,
            classifySigning: () => 'unsigned',
        });
        await expect(builder({ ...request, uin: '234567' })).rejects.toThrow(/account/);

        for (const sequence of [-1, 0x100000000, 1.5, NaN, undefined]) {
            await expect(builder({ ...request, sequence: sequence as number })).rejects.toThrow(
                /sequence/,
            );
        }

        await expect(builder({ ...request, command: '' })).rejects.toThrow(/command/);
        await expect(builder({ ...request, body: 'x' as never })).rejects.toThrow(/body/);
        const bad = createSsoReserveBuilder({
            uin: request.uin,
            classifySigning: () => 'maybe' as never,
        });
        await expect(bad(request)).rejects.toThrow(/classification/);
    });
});
