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
