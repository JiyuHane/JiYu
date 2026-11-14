import { protobuf_decode } from '@snowluma/proton';
import type { DirectSsoReserve } from '@snowluma/proto-defs/sso-reserve';
import { describe, expect, it, vi } from 'vitest';
import {
    createLagrangeV2MilkySigner,
    LagrangeV2MilkySignerError,
    type LagrangeV2MilkyRequest,
    type LagrangeV2MilkySignerOptions,
} from '../../src/direct/lagrange-v2-milky-signer';
import { createSsoReserveBuilder, type SsoSigningRequest } from '../../src/direct/sso-reserve';

// Hand-written synthetic fixtures based on the fixed upstream field declarations;
// no upstream code, command list, captured traffic or signing values are copied.
const guid = Uint8Array.from({ length: 16 }, (_, index) => index);
const success = () => ({
    code: 0,
    message: null,
    value: { sec_sign: '00aBff', sec_token: '', sec_extra: '' },
});
const request = (): SsoSigningRequest => ({
    uin: '123456',
    command: 'test.command',
    sequence: 0xffffffff,
    body: Uint8Array.of(0, 15, 255),
});

function options(
    transport: LagrangeV2MilkySignerOptions['transport'],
): LagrangeV2MilkySignerOptions {
    return { uin: '123456', guid: Uint8Array.from(guid), qua: 'test-qua', transport };
}

async function errorAt(promise: Promise<unknown>, stage: string): Promise<void> {
    try {
        await promise;
        throw new Error('expected rejection');
    } catch (error) {
        expect(error).toBeInstanceOf(LagrangeV2MilkySignerError);
        expect((error as LagrangeV2MilkySignerError).stage).toBe(stage);
    }
}

describe('fixed-version Milky injected transport adapter', () => {
    it('maps the exact synthetic request and returns independent decoded bytes', async () => {
        const transport = vi.fn(async (_payload: LagrangeV2MilkyRequest) => success());
        const sign = createLagrangeV2MilkySigner(options(transport));
        const result = await sign(request());
        expect(transport).toHaveBeenCalledExactlyOnceWith({
            uin: 123456,
            command: 'test.command',
            seq: -1,
            body: '000fff',
            guid: '000102030405060708090a0b0c0d0e0f',
            qua: 'test-qua',
        });
        expect(result).toEqual({
            sign: Uint8Array.of(0, 171, 255),
            token: new Uint8Array(),
            extra: new Uint8Array(),
        });
        result.sign[0] = 7;
        expect((await sign(request())).sign).toEqual(Uint8Array.of(0, 171, 255));
    });

    it.each([
        [0, 0],
        [0x7fffffff, 2147483647],
        [0x80000000, -2147483648],
        [0xffffffff, -1],
    ])('preserves unsigned sequence bit pattern %#', async (sequence, expected) => {
        const transport = vi.fn(async (_payload: LagrangeV2MilkyRequest) => success());
        const sign = createLagrangeV2MilkySigner({
            ...options(transport),
            uin: '9007199254740991',
        });
        await sign({ ...request(), uin: '9007199254740991', sequence, body: new Uint8Array() });
        expect(transport.mock.calls[0]![0]).toMatchObject({
            uin: Number.MAX_SAFE_INTEGER,
            seq: expected,
            body: '',
        });
    });

    it('accepts boundary-sized text and signature fields and snapshots responses', async () => {
        const response = {
            code: 0,
            message: 'm'.repeat(65536),
            value: { sec_sign: 'ab'.repeat(65536), sec_token: 'ff', sec_extra: '00' },
        };
        const transport = vi.fn(async () => response);
        const sign = createLagrangeV2MilkySigner({ ...options(transport), qua: 'q'.repeat(65536) });
        const result = await sign({ ...request(), command: 'c'.repeat(65536) });
        response.value.sec_sign = 'ff';
        response.value.sec_token = '';
        expect(result.sign.length).toBe(65536);
        expect(result.sign[0]).toBe(0xab);
        expect(result.token).toEqual(Uint8Array.of(0xff));
        expect(result.extra).toEqual(Uint8Array.of(0));
    });

    it('works directly as the reserve builder callback with a pure fake', async () => {
        const transport = vi.fn(async (_payload: LagrangeV2MilkyRequest) => ({
            code: 0,
            message: '',
            value: { sec_sign: '01', sec_token: '02', sec_extra: '03' },
        }));
        const signer = createLagrangeV2MilkySigner(options(transport));
        const builder = createSsoReserveBuilder({
            uin: '123456',
            classifySigning: () => 'sign',
            sign: signer,
            createTraceParent: () => 't',
        });
        const reserve = protobuf_decode<DirectSsoReserve>(await builder(request()));
        expect(reserve.secureInfo).toMatchObject({
            sign: Uint8Array.of(1),
            token: Uint8Array.of(2),
            extra: Uint8Array.of(3),
        });
        expect(transport).toHaveBeenCalledExactlyOnceWith({
            uin: 123456,
            command: 'test.command',
            seq: -1,
            body: '000fff',
            guid: '000102030405060708090a0b0c0d0e0f',
            qua: 'test-qua',
        });
    });

    it('snapshots configuration and request before invoking external transport', async () => {
        const input = request();
        const conf = options(async (payload) => {
            input.body.fill(99);
            conf.guid.fill(99);
            conf.qua = 'changed';
            expect(payload).toEqual({
                uin: 123456,
                command: 'test.command',
                seq: -1,
                body: '000fff',
                guid: '000102030405060708090a0b0c0d0e0f',
                qua: 'test-qua',
            });
            expect(Object.isFrozen(payload)).toBe(true);
            return success();
        });
        const sign = createLagrangeV2MilkySigner(conf);
        conf.guid.fill(88);
        conf.qua = 'replaced';
        await sign(input);
    });

    it('keeps concurrent accounts isolated and rejects mismatches before transport', async () => {
        const aTransport = vi.fn(async (_payload: LagrangeV2MilkyRequest) => success());
        const bTransport = vi.fn(async (_payload: LagrangeV2MilkyRequest) => success());
        const a = createLagrangeV2MilkySigner(options(aTransport));
        const b = createLagrangeV2MilkySigner({
            ...options(bTransport),
            uin: '999',
            qua: 'second',
        });
        await errorAt(a({ ...request(), uin: '999' }), 'request');
        await errorAt(b(request()), 'request');
        expect(aTransport).not.toHaveBeenCalled();
        expect(bTransport).not.toHaveBeenCalled();
        await Promise.all([a(request()), b({ ...request(), uin: '999' })]);
        expect(aTransport.mock.calls[0]![0]).toMatchObject({ uin: 123456, qua: 'test-qua' });
        expect(bTransport.mock.calls[0]![0]).toMatchObject({ uin: 999, qua: 'second' });
    });

    it('rejects noncanonical and unsafe accounts, invalid configuration and text limits', () => {
        for (const uin of [
            '',
            '0',
            '01',
            '+1',
            ' 1',
            '9007199254740992',
            '9223372036854775807',
            '999999999999999999999999',
        ]) {
            expect(() =>
                createLagrangeV2MilkySigner({ ...options(async () => success()), uin }),
            ).toThrow(/configuration/);
        }

        for (const qua of ['', 'é'.repeat(32769)]) {
            expect(() =>
                createLagrangeV2MilkySigner({ ...options(async () => success()), qua }),
            ).toThrow(/configuration/);
        }

        for (const badGuid of [new Uint8Array(15), new Uint8Array(17), '00']) {
            expect(() =>
                createLagrangeV2MilkySigner({
                    ...options(async () => success()),
                    guid: badGuid as never,
                }),
            ).toThrow(/configuration/);
        }

        expect(() =>
            createLagrangeV2MilkySigner({
                ...options(async () => success()),
                transport: null as never,
            }),
        ).toThrow(/configuration/);
    });

    it('rejects invalid request values before calling transport', async () => {
        const transport = vi.fn(async () => success());
        const sign = createLagrangeV2MilkySigner(options(transport));

        for (const bad of [
            { ...request(), uin: '0123456' },
            { ...request(), command: '' },
            { ...request(), command: 'é'.repeat(32769) },
            { ...request(), body: 'bad' },
            { ...request(), body: new Uint8Array(16 * 1024 * 1024 + 1) },
            ...[-1, -0, 0x100000000, 0.5, NaN, Infinity, '1', undefined].map((sequence) => ({
                ...request(),
                sequence,
            })),
        ]) {
            await errorAt(sign(bad as SsoSigningRequest), 'request');
        }

        expect(transport).not.toHaveBeenCalled();
    });

    it('rejects accessors, proxies, shared and detached byte views without invoking getters', async () => {
        const get = vi.fn(() => 'secret');
        const conf = options(async () => success());
        expect(() => createLagrangeV2MilkySigner(new Proxy(conf, {}))).toThrow(/configuration/);
        expect(() =>
            createLagrangeV2MilkySigner(Object.defineProperty(conf, 'surprise', { get })),
        ).toThrow(/configuration/);
        const transport = vi.fn(async () => success());
        const sign = createLagrangeV2MilkySigner(options(transport));
        await errorAt(sign(new Proxy(request(), {})), 'request');
        await errorAt(sign(Object.defineProperty(request(), 'command', { get })), 'request');
        await errorAt(sign(Object.defineProperty(request(), Symbol('extra'), { get })), 'request');
        await errorAt(
            sign({ ...request(), body: new Uint8Array(new SharedArrayBuffer(1)) }),
            'request',
        );
        const detached = new Uint8Array(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        await errorAt(sign({ ...request(), body: detached }), 'request');
        const resizable = new ArrayBuffer(4, { maxByteLength: 8 });
        const outOfBounds = new Uint8Array(resizable, 2, 2);
        resizable.resize(1);
        await errorAt(sign({ ...request(), body: outOfBounds }), 'request');
        expect(get).not.toHaveBeenCalled();
        expect(transport).not.toHaveBeenCalled();
    });

    it('strictly rejects malformed responses and permits extra plain data fields', async () => {
        const valid = success();
        const bad: unknown[] = [
            null,
            [],
            {},
            new Proxy(valid, {}),
            { ...valid, code: undefined },
            { ...valid, code: -1 },
            { ...valid, code: -0 },
            { ...valid, code: 1 },
            { ...valid, code: 0.1 },
            { ...valid, code: '0' },
            { ...valid, code: 2147483648 },
            { ...valid, message: undefined },
            { ...valid, message: 0 },
            { ...valid, message: 'x'.repeat(65537) },
            { ...valid, value: null },
            { ...valid, value: new Proxy(valid.value, {}) },
            { ...valid, value: {} },
            { ...valid, value: { ...valid.value, sec_sign: '' } },
            ...['a', 'gg', '0x01', '12 '.repeat(2), 'ab'.repeat(65537), 12].map((sec_sign) => ({
                ...valid,
                value: { ...valid.value, sec_sign },
            })),
            { ...valid, value: { ...valid.value, sec_token: 'a' } },
            { ...valid, value: { ...valid.value, sec_extra: null } },
        ];

        for (const response of bad) {
            await errorAt(
                createLagrangeV2MilkySigner(options(async () => response))(request()),
                'response',
            );
        }

        const get = vi.fn(() => 'hidden');
        await errorAt(
            createLagrangeV2MilkySigner(
                options(async () => Object.defineProperty(success(), 'unknown', { get })),
            )(request()),
            'response',
        );
        expect(get).not.toHaveBeenCalled();
        const sign = createLagrangeV2MilkySigner(
            options(async () => ({
                ...success(),
                future: 1,
                value: { ...success().value, future: true },
            })),
        );
        expect((await sign(request())).sign).toEqual(Uint8Array.of(0, 171, 255));
    });

    it('reads then during await of a synchronously returned exotic response before rejecting it', async () => {
        const then = vi.fn(() => undefined);
        const other = vi.fn(() => 'unused');
        const response = Object.defineProperties(success(), {
            then: { get: then },
            other: { get: other },
        });
        // Deliberately violate the Promise return type to exercise runtime assimilation.
        const signer = createLagrangeV2MilkySigner(options(() => response as never));
        const result = signer(request());
        expect(then).toHaveBeenCalledOnce();
        expect(other).not.toHaveBeenCalled();
        await errorAt(result, 'response');
        expect(then).toHaveBeenCalledOnce();
        expect(other).not.toHaveBeenCalled();
    });

    it('can assimilate a response inside async transport before returning its Promise', async () => {
        const events: string[] = [];
        const other = vi.fn(() => 'unused');
        const response = Object.defineProperties(success(), {
            then: {
                get: () => {
                    events.push('then');
                    return undefined;
                },
            },
            other: { get: other },
        });
        const signer = createLagrangeV2MilkySigner(
            options(async () => {
                events.push('before resolve');
                const pending = Promise.resolve(response);
                events.push('after resolve');
                return pending;
            }),
        );
        const result = signer(request());
        expect(events).toEqual(['before resolve', 'then', 'after resolve']);
        await errorAt(result, 'response');
        expect(events).toEqual(['before resolve', 'then', 'after resolve', 'then']);
        expect(other).not.toHaveBeenCalled();
    });

    it('sanitizes a second then getter failure as a transport error', async () => {
        const secret = 'second-then-fixture-secret';
        let reads = 0;
        const response = Object.defineProperty(success(), 'then', {
            get: () => {
                reads++;

                if (reads === 2) {
                    throw new Error(secret);
                }

                return undefined;
            },
        });
        const signer = createLagrangeV2MilkySigner(options(async () => Promise.resolve(response)));

        try {
            await signer(request());
            throw new Error('expected rejection');
        } catch (error) {
            expect(error).toBeInstanceOf(LagrangeV2MilkySignerError);
            expect((error as LagrangeV2MilkySignerError).stage).toBe('transport');
            expect(String(error)).not.toContain(secret);
            expect((error as Error).stack).not.toContain(secret);
            expect((error as Error).cause).toBeUndefined();
        }

        expect(reads).toBe(2);
    });

    it('assimilates resolving and rejecting thenables through the transport boundary', async () => {
        const resolveSigner = createLagrangeV2MilkySigner(
            options(
                () =>
                    ({ then: (resolve: (value: unknown) => void) => resolve(success()) }) as never,
            ),
        );
        expect((await resolveSigner(request())).sign).toEqual(Uint8Array.of(0, 171, 255));
        const secret = 'thenable-rejection-fixture-secret';
        const rejectSigner = createLagrangeV2MilkySigner(
            options(
                () =>
                    ({
                        then: (_resolve: unknown, reject: (reason: unknown) => void) =>
                            reject(new Error(secret)),
                    }) as never,
            ),
        );

        try {
            await rejectSigner(request());
            throw new Error('expected rejection');
        } catch (error) {
            expect(error).toBeInstanceOf(LagrangeV2MilkySignerError);
            expect((error as LagrangeV2MilkySignerError).stage).toBe('transport');
            expect(String(error)).not.toContain(secret);
            expect((error as Error).stack).not.toContain(secret);
            expect((error as Error).cause).toBeUndefined();
        }
    });

    it('can trigger a proxy then trap before rejecting the response proxy', async () => {
        const accessed: PropertyKey[] = [];
        const response = new Proxy(success(), {
            get(target, key, receiver) {
                accessed.push(key);
                return Reflect.get(target, key, receiver);
            },
        });
        const signer = createLagrangeV2MilkySigner(options(() => response as never));
        await errorAt(signer(request()), 'response');
        expect(accessed).toEqual(['then']);
    });

    it('sanitizes transport failures and response messages while retaining stage context', async () => {
        const secret = 'fixture-secret-do-not-include';

        for (const response of [false, true]) {
            const sign = createLagrangeV2MilkySigner(
                options(async () => {
                    if (response) {
                        return { code: 9, message: secret, value: {} };
                    }

                    throw new Error(secret);
                }),
            );

            try {
                await sign(request());
                throw new Error('expected rejection');
            } catch (error) {
                expect(error).toBeInstanceOf(LagrangeV2MilkySignerError);
                expect((error as LagrangeV2MilkySignerError).stage).toBe(
                    response ? 'response' : 'transport',
                );
                expect(String(error)).not.toContain(secret);
                expect((error as Error).stack).not.toContain(secret);
                expect((error as Error).cause).toBeUndefined();
            }
        }
    });
});
