import { describe, expect, it, vi } from 'vitest';
import { ApiHandler, type ApiActionContext } from '../../src/api-handler';
import { V12Dispatcher } from '../../src/v12/dispatcher';
import type { V11ActionHandler, V12CoreOptions } from '../../src/v12/types';

const self = { platform: 'qq', user_id: '10001' };
const request = (params: unknown = {}, extra: object = {}) => ({
    action: 'get_self_info',
    params,
    ...extra,
});
const success = (data: unknown = { user_id: 10001, nickname: 'fixture' }) => ({
    status: 'ok',
    retcode: 0,
    data,
});

function setup(handler: (action: string, params: unknown) => Promise<unknown>, id = '10001') {
    const handle = vi.fn(handler);
    const getStatus = vi.fn(() => ({ good: true, online: true }));
    const options: V12CoreOptions = {
        self: { ...self, user_id: id },
        version: { impl: 'jiyu', version: '1.0' },
        api: { handle } as unknown as V11ActionHandler,
        getStatus,
        getSentMessageTime: () => null,
    };
    return { dispatcher: new V12Dispatcher(options), handle, getStatus };
}

function expectFailure(value: unknown, code: number, echo = 'e') {
    expect(value).toEqual({
        status: 'failed',
        retcode: code,
        data: null,
        message: code === 20001 ? 'invalid self info result' : 'self info unavailable',
        echo,
    });
    expect(JSON.stringify(value)).not.toContain('sensitive-marker');
}

describe('v12 get_self_info', () => {
    it('calls the same account once with exactly empty parameters and preserves empty nickname and echo', async () => {
        for (const nickname of ['fixture', '']) {
            const { dispatcher, handle, getStatus } = setup(async () =>
                success({ user_id: 10001, nickname }),
            );
            expect(await dispatcher.handle(request({}, { self, echo: '' }))).toEqual({
                status: 'ok',
                retcode: 0,
                data: { user_id: '10001', user_name: nickname, user_displayname: '' },
                message: '',
                echo: '',
            });
            expect(handle).toHaveBeenCalledExactlyOnceWith('get_login_info', {});
            expect(Reflect.ownKeys(handle.mock.calls[0]![1] as object)).toEqual([]);
            expect(getStatus).not.toHaveBeenCalled();
        }

        const { dispatcher } = setup(async () => success());
        expect(await dispatcher.handle(request())).not.toHaveProperty('echo');
    });

    it('rejects malformed requests, unsupported parameters and mismatched self before calling v11', async () => {
        const { dispatcher, handle } = setup(async () => success());

        for (const [input, code] of [
            [{ action: 'get_self_info', echo: '' }, 10001],
            [request(null, { echo: '' }), 10001],
            [request({ ignored: false }, { echo: '' }), 10004],
            [request({}, { self: { platform: 'qq', user_id: 10001 }, echo: '' }), 10001],
            [
                request(
                    { ignored: false },
                    { self: { platform: 'qq', user_id: '10002' }, echo: '' },
                ),
                10102,
            ],
            [request({}, { self: { platform: 'other', user_id: '10001' }, echo: '' }), 10102],
        ] as const) {
            expect(await dispatcher.handle(input)).toMatchObject({
                status: 'failed',
                retcode: code,
                echo: '',
            });
        }

        expect(handle).not.toHaveBeenCalled();
    });

    it('rejects invalid and forged envelopes and malformed account data', async () => {
        const inherited = Object.create({
            status: 'ok',
            retcode: 0,
            data: { user_id: 10001, nickname: 'fixture' },
        });
        const inheritedData = Object.create({ user_id: 10001, nickname: 'fixture' });
        const cases: unknown[] = [
            null,
            [],
            'bad',
            {},
            inherited,
            { status: 'ok' },
            { status: 'ok', retcode: '0', data: {} },
            { status: 'failed', retcode: 0 },
            { status: 'ok', retcode: 1400 },
            { status: 'failed', retcode: -1 },
            { status: 'failed', retcode: NaN },
            { status: 'failed', retcode: Number.MAX_SAFE_INTEGER + 1 },
            success(null),
            success([]),
            success('bad'),
            success(inheritedData),
            success({ user_id: 10001 }),
            success({ nickname: 'fixture' }),
            success({ user_id: '10001', nickname: 'fixture' }),
            success({ user_id: 10001, nickname: 1 }),
            ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 10002].map((user_id) =>
                success({ user_id, nickname: 'sensitive-marker' }),
            ),
        ];

        for (const result of cases) {
            const { dispatcher, handle } = setup(async () => result);
            expectFailure(await dispatcher.handle(request({}, { echo: 'e' })), 20001);
            expect(handle).toHaveBeenCalledExactlyOnceWith('get_login_info', {});
        }

        const other = setup(
            async () => success({ user_id: 10001, nickname: 'sensitive-marker' }),
            '10002',
        );
        expectFailure(await other.dispatcher.handle(request({}, { echo: 'e' })), 20001);
        const maximum = setup(
            async () => success({ user_id: Number.MAX_SAFE_INTEGER, nickname: 'max' }),
            String(Number.MAX_SAFE_INTEGER),
        );
        expect((await maximum.dispatcher.handle(request())).data).toEqual({
            user_id: String(Number.MAX_SAFE_INTEGER),
            user_name: 'max',
            user_displayname: '',
        });
    });

    it('maps formed v11 failures and thrown errors without disclosure', async () => {
        for (const [retcode, expected] of [
            [1400, 20001],
            [1404, 20001],
            [100, 20002],
            [1200, 20002],
        ] as const) {
            const { dispatcher, handle } = setup(async () => ({
                status: 'failed',
                retcode,
                data: null,
                wording: 'sensitive-marker',
            }));
            expectFailure(await dispatcher.handle(request({}, { echo: 'e' })), expected);
            expect(handle).toHaveBeenCalledTimes(1);
        }

        const { dispatcher, handle } = setup(async () => {
            throw new Error('sensitive-marker');
        });
        expectFailure(await dispatcher.handle(request({}, { echo: 'e' })), 20002);
        expect(handle).toHaveBeenCalledTimes(1);
    });

    it('does not execute response or data field accessors, inherited getters or proxy traps after await', async () => {
        let getters = 0;
        let traps = 0;

        const getter = () => {
            getters++;
            throw new Error('sensitive-marker');
        };

        const accessor = (source: object, key: string) => {
            const value = { ...source };
            Object.defineProperty(value, key, { enumerable: true, get: getter });
            return value;
        };

        const protoData = Object.create({
            get nickname() {
                return getter();
            },
        });
        Object.defineProperty(protoData, 'user_id', { value: 10001 });
        const trapsForData = {
            get: () => {
                traps++;
                throw new Error('sensitive-marker');
            },
            getOwnPropertyDescriptor: () => {
                traps++;
                throw new Error('sensitive-marker');
            },
            getPrototypeOf: () => {
                traps++;
                throw new Error('sensitive-marker');
            },
        };
        const cases = [
            accessor(success(), 'status'),
            accessor(success(), 'retcode'),
            accessor(success(), 'data'),
            success(accessor({ user_id: 10001, nickname: 'fixture' }, 'user_id')),
            success(accessor({ user_id: 10001, nickname: 'fixture' }, 'nickname')),
            success(protoData),
            success(new Proxy({ user_id: 10001, nickname: 'fixture' }, trapsForData)),
        ];

        for (const result of cases) {
            const { dispatcher } = setup(async () => result);
            expectFailure(await dispatcher.handle(request({}, { echo: 'e' })), 20001);
        }

        expect(getters).toBe(0);
        expect(traps).toBe(0);
    });

    it('rejects an awaited proxy envelope after the Promise then lookup, and sanitizes a throwing then', async () => {
        let thenReads = 0;
        let otherTraps = 0;
        const proxy = new Proxy(success(), {
            get(_target, key) {
                if (key === 'then') {
                    thenReads++;
                    return undefined;
                }

                otherTraps++;
                throw new Error('sensitive-marker');
            },
            getOwnPropertyDescriptor() {
                otherTraps++;
                throw new Error('sensitive-marker');
            },
        });
        const { dispatcher } = setup(async () => proxy);
        expectFailure(await dispatcher.handle(request({}, { echo: 'e' })), 20001);
        expect(thenReads).toBeGreaterThan(0);
        expect(otherTraps).toBe(0);
        const throwing = new Proxy(success(), {
            get() {
                throw new Error('sensitive-marker');
            },
        });
        const rejected = setup(async () => throwing);
        expectFailure(await rejected.dispatcher.handle(request({}, { echo: 'e' })), 20002);
    });

    it('integrates with real ApiHandler and a synthetic login context for success and failure', async () => {
        const getLoginInfo = vi.fn(() => ({ userId: 10001, nickname: 'fixture' }));
        const api = new ApiHandler({ getLoginInfo } as unknown as ApiActionContext);
        const handle = vi.spyOn(api, 'handle');
        const dispatcher = new V12Dispatcher({
            self,
            version: { impl: 'jiyu', version: '1.0' },
            api,
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
        });
        expect(await dispatcher.handle(request({}, { echo: 'e' }))).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: 'e',
            data: { user_id: '10001', user_name: 'fixture', user_displayname: '' },
        });
        expect(handle).toHaveBeenCalledExactlyOnceWith('get_login_info', {});
        expect(getLoginInfo).toHaveBeenCalledTimes(1);
        getLoginInfo.mockImplementationOnce(() => {
            throw new Error('sensitive-marker');
        });
        expectFailure(await dispatcher.handle(request({}, { echo: 'e' })), 20002);
        expect(handle).toHaveBeenCalledTimes(2);
        expect(getLoginInfo).toHaveBeenCalledTimes(2);
    });
});
