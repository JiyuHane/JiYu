import { describe, expect, it, vi } from 'vitest';
import { V12Dispatcher } from '../../src/v12/dispatcher';
import type { V12CoreOptions } from '../../src/v12/types';

const self = { platform: 'qq', user_id: '10001' };
const request = (action: string, params: unknown = {}, extra: object = {}) => ({
    action,
    params,
    ...extra,
});

function setup(identity: V12CoreOptions['self'] = self) {
    const api = { handle: vi.fn(async () => ({ status: 'ok' as const, retcode: 0, data: null })) };
    const dispatcher = new V12Dispatcher({
        self: identity,
        version: { impl: 'jiyu', version: '1' },
        api,
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime: () => 1,
    });
    return { dispatcher, http: dispatcher.createInternalHttpPreflight(), api };
}

function error(
    result: ReturnType<ReturnType<V12Dispatcher['createInternalHttpPreflight']>['classify']>,
) {
    expect(result.kind).toBe('error');

    if (result.kind !== 'error') {
        throw new Error('expected error');
    }

    return result.response;
}

describe('future HTTP poll shared preflight (no transport)', () => {
    it('preserves constructor identity from one bounded snapshot and rejects accessors/proxies', async () => {
        let getters = 0;
        const identity = { ...self, extra: { label: 'original' } };
        const { dispatcher, http } = setup(identity);
        identity.user_id = '10002';
        identity.extra.label = 'changed';
        const status = await dispatcher.handle(request('get_status'));
        expect(status.data).toEqual({
            good: true,
            bots: [{ self: { ...self, extra: { label: 'original' } }, online: true }],
        });
        expect(http.classify(request('get_latest_events', {}, { self })).kind).toBe('poll');
        expect(
            error(http.classify(request('get_latest_events', {}, { self: identity }))).retcode,
        ).toBe(10102);
        const bad = { ...self };
        Object.defineProperty(bad, 'user_id', {
            enumerable: true,
            get() {
                getters++;
                return '10001';
            },
        });
        expect(() => setup(bad)).toThrow('invalid V12 core identity or version');
        const proxy = new Proxy(self, {
            get() {
                getters++;
                throw new Error('secret');
            },
        });
        expect(() => setup(proxy)).toThrow('invalid V12 core identity or version');
        expect(getters).toBe(0);
        const bot = (status.data as { bots: Array<{ self: { extra: object } }> }).bots[0]!;
        expect(Object.isFrozen(bot.self.extra)).toBe(true);
    });

    it('accepts default zero, bounds, safe integers and echo as immutable primitives', () => {
        const { http } = setup();
        expect(http.classify(request('get_latest_events'))).toEqual({
            kind: 'poll',
            limit: 0,
            timeoutSeconds: 0,
        });
        const poll = http.classify(
            request(
                'get_latest_events',
                { limit: Number.MAX_SAFE_INTEGER, timeout: 10 },
                { self, echo: '' },
            ),
        );
        expect(poll).toEqual({
            kind: 'poll',
            limit: Number.MAX_SAFE_INTEGER,
            timeoutSeconds: 10,
            echo: '',
        });
        expect(Object.isFrozen(poll)).toBe(true);
        expect(
            http.classify(request('get_latest_events', { limit: 0, timeout: 0 }, { echo: 'x' })),
        ).toEqual({ kind: 'poll', limit: 0, timeoutSeconds: 0, echo: 'x' });
    });

    it('rejects invalid numeric values with existing snapshot priority and extra fields first', () => {
        const { http } = setup();

        for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null, true]) {
            for (const key of ['limit', 'timeout']) {
                expect(
                    error(
                        http.classify(request('get_latest_events', { [key]: value }, { echo: '' })),
                    ),
                ).toMatchObject({ retcode: 10003, data: null, echo: '' });
            }
        }

        expect(error(http.classify(request('get_latest_events', { timeout: 11 }))).retcode).toBe(
            10003,
        );
        expect(
            error(http.classify(request('get_latest_events', { timeout: Number.MAX_SAFE_INTEGER })))
                .retcode,
        ).toBe(10003);

        for (const value of [NaN, Infinity, -Infinity]) {
            expect(
                error(http.classify(request('get_latest_events', { timeout: value }, { echo: '' })))
                    .retcode,
            ).toBe(10001);
        }

        expect(
            error(
                http.classify(
                    request('get_latest_events', { timeout: -1, secret: 'sensitive-marker' }),
                ),
            ).retcode,
        ).toBe(10004);
        expect(
            error(
                http.classify(
                    request('get_latest_events', { timeout: NaN, secret: 'sensitive-marker' }),
                ),
            ).retcode,
        ).toBe(10001);
    });

    it('retains all common errors and priorities of ordinary handle', async () => {
        const { dispatcher, http, api } = setup();
        const inputs: unknown[] = [
            null,
            [],
            {},
            { action: 'get_latest_events', echo: '' },
            request('get_latest_events', null, { echo: '' }),
            request(
                'get_latest_events',
                {},
                { self: { platform: 'qq', user_id: 10001 }, echo: '' },
            ),
            request(
                'get_latest_events',
                { extra: 1 },
                { self: { platform: 'qq', user_id: '10002' }, top: 1, echo: '' },
            ),
            request('get_latest_events', {}, { top: 1, echo: '' }),
            request('get_latest_events', {}, { self: { ...self, extra: 1 }, echo: '' }),
            request('get_latest_events', {}, { echo: 1 }),
        ];

        for (const input of inputs) {
            const classified = http.classify(input);
            expect(classified.kind).toBe('error');
            expect(error(classified)).toEqual(await dispatcher.handle(input));
            expect(JSON.stringify(classified)).not.toContain('sensitive-marker');
        }

        expect(api.handle).not.toHaveBeenCalled();
    });

    it('rejects getters, proxies, cycles, excessive shapes with the ordinary fallback echo', async () => {
        const { dispatcher, http } = setup();
        let calls = 0;
        const getter = request('get_latest_events', {}, { echo: '' });
        Object.defineProperty(getter.params, 'limit', {
            enumerable: true,
            get() {
                calls++;
                throw Error('sensitive-marker');
            },
        });
        const echoGetter = request('get_latest_events');
        Object.defineProperty(echoGetter, 'echo', {
            enumerable: true,
            get() {
                calls++;
                throw Error('sensitive-marker');
            },
        });
        const traps = {
            get() {
                calls++;
                throw Error('sensitive-marker');
            },
            ownKeys() {
                calls++;
                throw Error('sensitive-marker');
            },
        };
        const proxy = new Proxy(request('get_latest_events', {}, { echo: '' }), traps);
        const nested = request('get_latest_events', new Proxy({}, traps), { echo: '' });
        const cycle: Record<string, unknown> = {};
        cycle.x = cycle;

        for (const input of [
            getter,
            echoGetter,
            proxy,
            nested,
            request('get_latest_events', cycle),
            request('get_latest_events', { tooBig: new Array(4097).fill(0) }),
        ]) {
            const result = http.classify(input);
            expect(error(result)).toEqual(await dispatcher.handle(input));
            expect(JSON.stringify(result)).not.toContain('sensitive-marker');
        }

        expect(calls).toBe(0);
    });

    it('routes ordinary actions through a single private snapshot and rejects replay, forgery and cross-account tokens', async () => {
        const { dispatcher, http } = setup();
        const other = setup({ ...self, user_id: '10002' });
        const input = request('delete_message', { message_id: '-123' }, { echo: '' });
        const result = http.classify(input);
        expect(result.kind).toBe('ordinary');

        if (result.kind !== 'ordinary') {
            throw new Error('expected ordinary');
        }

        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.token)).toBe(true);
        input.params.message_id = '1';
        input.echo = 'changed';
        expect(await other.dispatcher.handlePreparedOrdinary(result.token)).toMatchObject({
            retcode: 10001,
        });
        expect(await dispatcher.handlePreparedOrdinary({})).toMatchObject({ retcode: 10001 });
        expect(await dispatcher.handlePreparedOrdinary(result.token)).toEqual({
            status: 'ok',
            retcode: 0,
            data: null,
            message: '',
            echo: '',
        });
        expect(await dispatcher.handlePreparedOrdinary(result.token)).toMatchObject({
            retcode: 10001,
        });
    });

    it('accepts frozen inputs and observes JSON duplicate keys only after JSON parsing', () => {
        const { http } = setup();
        const frozen = Object.freeze({
            action: 'get_latest_events',
            params: Object.freeze({ limit: 0, timeout: 10 }),
            self: Object.freeze({ ...self }),
        });
        expect(http.classify(frozen)).toEqual({ kind: 'poll', limit: 0, timeoutSeconds: 10 });
        const duplicate: unknown = JSON.parse(
            '{"action":"get_latest_events","params":{"timeout":11,"timeout":0}}',
        );
        expect(http.classify(duplicate)).toEqual({ kind: 'poll', limit: 0, timeoutSeconds: 0 });
    });

    it('consumes the token before reentrant action execution', async () => {
        let replay: Promise<unknown> | undefined;
        let token: object = {};
        let dispatcher: V12Dispatcher;
        const api = {
            handle: vi.fn(async () => {
                replay = dispatcher.handlePreparedOrdinary(token);
                return { status: 'ok' as const, retcode: 0, data: null };
            }),
        };
        dispatcher = new V12Dispatcher({
            self,
            version: { impl: 'jiyu', version: '1' },
            api,
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => 1,
        });
        const classified = dispatcher
            .createInternalHttpPreflight()
            .classify(request('delete_message', { message_id: '-1' }));

        if (classified.kind !== 'ordinary') {
            throw new Error('expected ordinary');
        }

        token = classified.token;
        expect((await dispatcher.handlePreparedOrdinary(token)).retcode).toBe(0);
        expect(await replay).toMatchObject({ retcode: 10001 });
        expect(api.handle).toHaveBeenCalledTimes(1);
    });

    it('matches direct get_status success and failure including echo', async () => {
        for (const shouldThrow of [false, true]) {
            const make = () => {
                const getStatus = vi.fn(() => {
                    if (shouldThrow) {
                        throw new Error('private-status');
                    }

                    return { good: true, online: false };
                });
                const dispatcher = new V12Dispatcher({
                    self,
                    version: { impl: 'jiyu', version: '1' },
                    api: {
                        handle: vi.fn(async () => ({
                            status: 'ok' as const,
                            retcode: 0,
                            data: null,
                        })),
                    },
                    getStatus,
                    getSentMessageTime: () => 1,
                });
                return { dispatcher, getStatus };
            };

            const direct = make();
            const prepared = make();
            const input = request('get_status', {}, { echo: '' });
            const classified = prepared.dispatcher.createInternalHttpPreflight().classify(input);

            if (classified.kind !== 'ordinary') {
                throw new Error('expected ordinary');
            }

            const actual = await prepared.dispatcher.handlePreparedOrdinary(classified.token);
            expect(actual).toEqual(await direct.dispatcher.handle(input));
            expect(actual).toMatchObject({ retcode: shouldThrow ? 20002 : 0, echo: '' });
            expect(JSON.stringify(actual)).not.toContain('private-status');
            expect(prepared.getStatus).toHaveBeenCalledTimes(1);
            expect(direct.getStatus).toHaveBeenCalledTimes(1);
            expect(
                (await prepared.dispatcher.handlePreparedOrdinary(classified.token)).retcode,
            ).toBe(10001);
            expect(prepared.getStatus).toHaveBeenCalledTimes(1);
        }
    });

    it('matches direct send effects and responses, including failed metadata and thrown fake calls', async () => {
        for (const scenario of ['success', 'missing-time', 'throw-time', 'throw-send'] as const) {
            const make = () => {
                const handle = vi.fn(async () => {
                    if (scenario === 'throw-send') {
                        throw new Error('private-send');
                    }

                    return { status: 'ok' as const, retcode: 0, data: { message_id: -123 } };
                });
                const getSentMessageTime = vi.fn(() => {
                    if (scenario === 'throw-time') {
                        throw new Error('private-time');
                    }

                    return scenario === 'missing-time' ? null : 1700000000;
                });
                const dispatcher = new V12Dispatcher({
                    self,
                    version: { impl: 'jiyu', version: '1' },
                    api: { handle },
                    getStatus: () => ({ good: true, online: true }),
                    getSentMessageTime,
                });
                return { dispatcher, handle, getSentMessageTime };
            };

            const direct = make();
            const prepared = make();
            const input = request(
                'send_message',
                { detail_type: 'private', user_id: '42', message: 'hello' },
                { echo: '' },
            );
            const classified = prepared.dispatcher.createInternalHttpPreflight().classify(input);

            if (classified.kind !== 'ordinary') {
                throw new Error('expected ordinary');
            }

            const actual = await prepared.dispatcher.handlePreparedOrdinary(classified.token);
            expect(actual).toEqual(await direct.dispatcher.handle(input));
            expect(actual).toMatchObject({
                retcode: scenario === 'success' ? 0 : scenario === 'missing-time' ? 20001 : 20002,
                echo: '',
            });
            expect(JSON.stringify(actual)).not.toContain('private-');
            expect(prepared.handle).toHaveBeenCalledExactlyOnceWith('send_private_msg', {
                user_id: 42,
                message: [{ type: 'text', data: { text: 'hello' } }],
                auto_escape: false,
            });
            expect(prepared.handle.mock.calls).toEqual(direct.handle.mock.calls);
            expect(prepared.getSentMessageTime).toHaveBeenCalledTimes(
                scenario === 'throw-send' ? 0 : 1,
            );
            expect(prepared.getSentMessageTime.mock.calls).toEqual(
                direct.getSentMessageTime.mock.calls,
            );
            expect(
                (await prepared.dispatcher.handlePreparedOrdinary(classified.token)).retcode,
            ).toBe(10001);
            expect(prepared.handle).toHaveBeenCalledTimes(1);
        }
    });

    it('consumes the token before a reentrant fake send throws', async () => {
        let replay: Promise<unknown> | undefined;
        let token: object = {};
        let dispatcher: V12Dispatcher;
        const handle = vi.fn(async () => {
            replay = dispatcher.handlePreparedOrdinary(token);
            throw new Error('private-send');
        });
        dispatcher = new V12Dispatcher({
            self,
            version: { impl: 'jiyu', version: '1' },
            api: { handle },
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => 1,
        });
        const classified = dispatcher.createInternalHttpPreflight().classify(
            request(
                'send_message',
                {
                    detail_type: 'private',
                    user_id: '42',
                    message: 'hello',
                },
                { echo: '' },
            ),
        );

        if (classified.kind !== 'ordinary') {
            throw new Error('expected ordinary');
        }

        token = classified.token;
        expect(await dispatcher.handlePreparedOrdinary(token)).toMatchObject({
            retcode: 20002,
            echo: '',
        });
        expect(await replay).toMatchObject({ retcode: 10001 });
        expect((await dispatcher.handlePreparedOrdinary(token)).retcode).toBe(10001);
        expect(handle).toHaveBeenCalledTimes(1);
    });

    it('preserves ordinary result, v11 handler arguments and unsupported get_latest_events on direct handle', async () => {
        for (const input of [
            request('get_version', {}, { echo: '' }),
            request('get_supported_actions'),
            request('missing'),
            request('get_version', { unknown: 1 }),
            request('delete_message', { message_id: '-42' }, { echo: 'e' }),
        ]) {
            const direct = setup();
            const indirect = setup();
            const result = indirect.http.classify(input);
            expect(result.kind).toBe('ordinary');

            if (result.kind !== 'ordinary') {
                throw new Error('expected ordinary');
            }

            expect(await indirect.dispatcher.handlePreparedOrdinary(result.token)).toEqual(
                await direct.dispatcher.handle(input),
            );
            expect(indirect.api.handle.mock.calls).toEqual(direct.api.handle.mock.calls);
        }

        const { dispatcher, http } = setup();
        expect(http.classify(request('get_latest_events')).kind).toBe('poll');
        expect(await dispatcher.handle(request('get_latest_events', {}, { echo: '' }))).toEqual({
            status: 'failed',
            retcode: 10002,
            data: null,
            message: 'unsupported action',
            echo: '',
        });
        expect((await dispatcher.handle(request('get_supported_actions'))).data).not.toContain(
            'get_latest_events',
        );
    });
});
