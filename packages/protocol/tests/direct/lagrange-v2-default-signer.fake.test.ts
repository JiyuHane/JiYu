import type { DirectSsoReserve } from '@snowluma/proto-defs/sso-reserve';
import { protobuf_decode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import {
    createLagrangeV2DefaultSigner,
    LagrangeV2DefaultSignerError,
} from '../../src/direct/lagrange-v2-default-signer';
import { createSsoReserveBuilder, type SsoSigningRequest } from '../../src/direct/sso-reserve';

// All inputs and results are invented; the transport is an in-process fake.
const request = (): SsoSigningRequest => ({
    uin: '123456',
    command: 'test.command',
    sequence: 0xffffffff,
    body: Uint8Array.of(0, 15, 171, 255),
});
const success = () => ({ value: { sign: '00aBff', token: '', extra: '' } });

async function expectStage(promise: Promise<unknown>, stage: string): Promise<void> {
    let caught: unknown;

    try {
        await promise;
    } catch (error) {
        caught = error;
    }

    expect(caught).toBeInstanceOf(LagrangeV2DefaultSignerError);
    expect((caught as LagrangeV2DefaultSignerError).stage).toBe(stage);
}

describe('Lagrange V2 default signer fake transport', () => {
    it('maps only cmd, signed seq and uppercase src and leaves the input unchanged', async () => {
        const transport = vi.fn(async (_payload: { cmd: string; seq: number; src: string }) =>
            success(),
        );
        const signer = createLagrangeV2DefaultSigner({ uin: '123456', transport });
        const input = request();
        const body = input.body;
        const result = await signer(input);

        expect(transport).toHaveBeenCalledExactlyOnceWith({
            cmd: 'test.command',
            seq: -1,
            src: '000FABFF',
        });
        expect(Reflect.ownKeys(transport.mock.calls[0]![0]).sort()).toEqual(['cmd', 'seq', 'src']);
        expect(Object.isFrozen(transport.mock.calls[0]![0])).toBe(true);
        expect(result).toEqual({
            sign: Uint8Array.of(0, 171, 255),
            token: new Uint8Array(),
            extra: new Uint8Array(),
        });
        expect(input).toEqual(request());
        expect(input.body).toBe(body);
    });

    it.each([
        [0, 0],
        [0x7fffffff, 0x7fffffff],
        [0x80000000, -2147483648],
        [0xffffffff, -1],
    ])('preserves the uint32 sequence bits in the signed int32 DTO (%s)', async (sequence, seq) => {
        const transport = vi.fn(async (_payload: { cmd: string; seq: number; src: string }) =>
            success(),
        );
        const signer = createLagrangeV2DefaultSigner({ uin: '123456', transport });
        await signer({ ...request(), sequence, body: new Uint8Array() });
        expect(transport).toHaveBeenCalledExactlyOnceWith({ cmd: 'test.command', seq, src: '' });
    });

    it('returns independent decoded arrays across fields and calls', async () => {
        const response = { value: { sign: '0102', token: '0102', extra: '0102' } };
        const transport = vi.fn(async () => response);
        const signer = createLagrangeV2DefaultSigner({ uin: '123456', transport });
        const first = await signer(request());
        const second = await signer(request());
        first.sign[0] = 9;
        first.token[1] = 8;
        expect(first.extra).toEqual(Uint8Array.of(1, 2));
        expect(second).toEqual({
            sign: Uint8Array.of(1, 2),
            token: Uint8Array.of(1, 2),
            extra: Uint8Array.of(1, 2),
        });
        response.value.sign = 'ff';
        expect(second.sign).toEqual(Uint8Array.of(1, 2));
    });

    it('validates account configuration without contacting the transport', () => {
        const transport = vi.fn(async () => success());

        for (const uin of ['', '0', '01', '+1', ' 1', '9007199254740992']) {
            try {
                createLagrangeV2DefaultSigner({ uin, transport });
                expect.fail('expected configuration rejection');
            } catch (error) {
                expect(error).toBeInstanceOf(LagrangeV2DefaultSignerError);
                expect((error as LagrangeV2DefaultSignerError).stage).toBe('configuration');
            }
        }

        expect(transport).not.toHaveBeenCalled();
    });

    it('accepts boundary-sized response fields and unknown own data', async () => {
        const transport = vi.fn(async () => ({
            future: null,
            value: { sign: 'ab'.repeat(65536), token: '', extra: 'Ff', future: true },
        }));
        const signer = createLagrangeV2DefaultSigner({ uin: '123456', transport });
        const result = await signer({ ...request(), command: 'c'.repeat(65536) });
        expect(result.sign.byteLength).toBe(65536);
        expect(result.sign[0]).toBe(0xab);
        expect(result.token).toEqual(new Uint8Array());
        expect(result.extra).toEqual(Uint8Array.of(255));
    });

    it('rejects wrong accounts and invalid sequences before calling transport', async () => {
        const transport = vi.fn(async () => success());
        const signer = createLagrangeV2DefaultSigner({ uin: '123456', transport });
        await expectStage(signer({ ...request(), uin: '654321' }), 'request');

        for (const sequence of [-1, -0, 0x100000000, 0.5, NaN, Infinity, undefined, '1']) {
            await expectStage(signer({ ...request(), sequence } as SsoSigningRequest), 'request');
        }

        for (const command of ['', 'é'.repeat(32769)]) {
            await expectStage(signer({ ...request(), command }), 'request');
        }

        expect(transport).not.toHaveBeenCalled();
    });

    it('rejects malformed, nonhex, odd and oversized response fields', async () => {
        const invalid: unknown[] = [
            null,
            undefined,
            {},
            { value: null },
            { value: {} },
            ...['', 'a', 'gg', '0x01', '01 ', 'ab'.repeat(65537), 12].map((sign) => ({
                value: { sign, token: '', extra: '' },
            })),
            { value: { sign: '01', token: 'f', extra: '' } },
            { value: { sign: '01', token: '', extra: 'zz' } },
            { value: { sign: '01', token: 'aa'.repeat(65537), extra: '' } },
            { value: { sign: '01', token: '', extra: 'aa'.repeat(65537) } },
        ];

        for (const response of invalid) {
            const transport = vi.fn(async (): Promise<unknown> => response);
            const signer = createLagrangeV2DefaultSigner({ uin: '123456', transport });
            await expectStage(signer(request()), 'response');
            expect(transport).toHaveBeenCalledOnce();
        }
    });

    it('rejects an oversized body without allocating or comparing an expected large buffer', async () => {
        const transport = vi.fn(async () => success());
        const signer = createLagrangeV2DefaultSigner({ uin: '123456', transport });
        const body = new Uint8Array(16 * 1024 * 1024 + 1);
        await expect(signer({ ...request(), body })).rejects.toThrow();
        expect(transport).not.toHaveBeenCalled();
    });

    it('rejects custom prototypes and accessors without calling their getters', async () => {
        const get = vi.fn(() => '01');
        const transport = vi.fn(async () => success());
        const signer = createLagrangeV2DefaultSigner({ uin: '123456', transport });
        const inherited = Object.assign(Object.create({ inherited: true }), request());
        await expect(signer(inherited as SsoSigningRequest)).rejects.toThrow();
        await expect(
            signer(Object.defineProperty(request(), 'command', { get }) as SsoSigningRequest),
        ).rejects.toThrow();
        expect(transport).not.toHaveBeenCalled();

        for (const response of [
            Object.assign(Object.create({ inherited: true }), success()),
            { value: Object.assign(Object.create({ inherited: true }), success().value) },
            Object.defineProperty(success(), 'other', { get }),
            { value: Object.defineProperty(success().value, 'sign', { get }) },
        ]) {
            const fake = vi.fn(async (): Promise<unknown> => response);
            await expect(
                createLagrangeV2DefaultSigner({ uin: '123456', transport: fake })(request()),
            ).rejects.toThrow();
        }

        expect(get).not.toHaveBeenCalled();
    });

    it('snapshots the body before invoking an asynchronous transport callback', async () => {
        const input = request();
        const originalBody = input.body;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const transport = vi.fn(async (payload: { cmd: string; seq: number; src: string }) => {
            originalBody.fill(9);
            input.command = 'changed';
            input.sequence = 3;
            await gate;
            expect(payload).toEqual({ cmd: 'test.command', seq: -1, src: '000FABFF' });
            return success();
        });
        const signer = createLagrangeV2DefaultSigner({ uin: '123456', transport });
        const pending = signer(input);
        expect(transport).toHaveBeenCalledOnce();
        release();
        await expect(pending).resolves.toEqual({
            sign: Uint8Array.of(0, 171, 255),
            token: new Uint8Array(),
            extra: new Uint8Array(),
        });
    });

    it('does not leak a private transport exception', async () => {
        const secret = 'private-fixture-transport-exception';
        const transport = vi.fn(async (): Promise<unknown> => {
            throw new Error(secret);
        });
        const signer = createLagrangeV2DefaultSigner({ uin: '123456', transport });
        let caught: unknown;

        try {
            await signer(request());
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(LagrangeV2DefaultSignerError);
        expect((caught as LagrangeV2DefaultSignerError).stage).toBe('transport');
        expect(String(caught)).not.toContain(secret);
        expect((caught as Error).stack).not.toContain(secret);
        expect((caught as Error).cause).toBeUndefined();
    });

    it('links through a synthetic buildReserved callback and encodes its signature', async () => {
        const input = request();
        const transport = vi.fn(async (_payload: { cmd: string; seq: number; src: string }) => ({
            value: { sign: '01', token: '02', extra: '03' },
        }));
        const sign = createLagrangeV2DefaultSigner({ uin: '123456', transport });
        const buildReserved = createSsoReserveBuilder({
            uin: '123456',
            classifySigning: () => 'sign',
            createTraceParent: () => 'synthetic',
            sign,
        });
        const result = protobuf_decode<DirectSsoReserve>(await buildReserved(input));
        expect(result.secureInfo).toMatchObject({
            sign: Uint8Array.of(1),
            token: Uint8Array.of(2),
            extra: Uint8Array.of(3),
        });
        expect(transport).toHaveBeenCalledExactlyOnceWith({
            cmd: 'test.command',
            seq: -1,
            src: '000FABFF',
        });
        expect(input).toEqual(request());
    });
});
