import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OneBot12HttpClient } from '../../../sdk/src/v12/http-client.js';
import { ApiHandler, type ApiActionContext } from '../../src/api-handler';
import { actions as friendActions } from '../../src/actions/friend';
import { V12Dispatcher } from '../../src/v12/dispatcher';
import type { V11ActionHandler } from '../../src/v12/types';

// Only the actual friend and info action registries are relevant to this fixture.
vi.mock('../../src/actions/message', () => ({ actions: [] }));
vi.mock('../../src/actions/group-info', () => ({ actions: [] }));
vi.mock('../../src/actions/group-admin', () => ({ actions: [] }));
vi.mock('../../src/actions/group-file', () => ({ actions: [] }));
vi.mock('../../src/actions/request', () => ({ actions: [] }));
vi.mock('../../src/actions/extended', () => ({ actions: [] }));
vi.mock('../../src/actions/group-album', () => ({ actions: [] }));
vi.mock('../../src/actions/qzone', () => ({ actions: [] }));
vi.mock('../../src/actions/qzone-public', () => ({ actions: [] }));
vi.mock('../../src/actions/stream-download', () => ({ actions: [] }));
vi.mock('../../src/actions/stream-file', () => ({ actions: [] }));
vi.mock('../../src/actions/system-face', () => ({ actions: [] }));

const marker = 'private-synthetic-user-marker';
const selfA = { platform: 'qq', user_id: '10001' };
const selfB = { platform: 'qq', user_id: '10002' };
const request = (params: unknown = { user_id: '42' }, extra: object = {}) => ({
    action: 'get_user_info',
    params,
    ...extra,
});
const row = (user_id = 42, nickname = 'name', remark = 'remark') => ({ user_id, nickname, remark });
const ok = (data: unknown) => ({ status: 'ok', retcode: 0, data });
let injectedFetch: ReturnType<typeof vi.fn> | undefined;
let expectedFetchCalls = 0;
const defaultFetch = vi.fn(async () => {
    throw new Error('unexpected global fetch');
});

beforeEach(() => {
    defaultFetch.mockClear();
    vi.stubGlobal('fetch', defaultFetch);
});
afterEach(() => {
    const defaultCalls = defaultFetch.mock.calls.length;
    const calls = injectedFetch?.mock.calls.length ?? 0;
    const expected = expectedFetchCalls;
    injectedFetch = undefined;
    expectedFetchCalls = 0;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(defaultCalls).toBe(0);
    expect(calls).toBe(expected);
});

function dispatcher(api: V11ActionHandler, self = selfA) {
    return new V12Dispatcher({
        api,
        self,
        version: { impl: 'fixture', version: '1' },
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime: () => null,
    });
}

function setup(fn: () => Promise<unknown>) {
    const handle = vi.fn(fn);
    return { handle, subject: dispatcher({ handle } as unknown as V11ActionHandler) };
}

function failure(result: unknown, code: number) {
    expect(result).toEqual({
        status: 'failed',
        retcode: code,
        message: code === 20001 ? 'invalid user info result' : 'user info unavailable',
        data: null,
        echo: 'e',
    });
    expect(JSON.stringify(result)).not.toContain(marker);
}

function accessor(value: object, key: string, get: () => never) {
    const copy = { ...value };
    Object.defineProperty(copy, key, { enumerable: true, get });
    return copy;
}

describe('get_user_info: synthetic v11 seam', () => {
    it('projects exact uint32 boundaries and preserves empty fields and echo', async () => {
        expect(
            friendActions.find((action) => action.names.includes('get_stranger_info'))?.describe()
                .readOnly,
        ).toBe(true);

        for (const [id, name, remark] of [
            [1, '', ''],
            [42, '🪶'.repeat(512), 'x'.repeat(1024)],
            [0xffffffff, 'x'.repeat(1024), '🪶'.repeat(512)],
        ] as const) {
            const f = setup(async () => ok(row(id, name, remark)));
            expect(
                await f.subject.handle(request({ user_id: String(id) }, { self: selfA, echo: '' })),
            ).toEqual({
                status: 'ok',
                retcode: 0,
                message: '',
                echo: '',
                data: {
                    user_id: String(id),
                    user_name: name,
                    user_displayname: '',
                    user_remark: remark,
                },
            });
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_stranger_info', { user_id: id });
        }
    });

    it('validates self and JSON first, then extra keys before ID, with no calls', async () => {
        const f = setup(async () => ok(row()));
        const badIds: unknown[] = [
            null,
            0,
            42,
            true,
            '',
            '0',
            '-1',
            '+1',
            '01',
            '1.0',
            ' 1',
            '1 ',
            '1e2',
            '4294967296',
            '9007199254740992',
        ];

        for (const id of badIds) {
            expect(await f.subject.handle(request({ user_id: id }, { echo: '' }))).toMatchObject({
                status: 'failed',
                retcode: 10003,
                data: null,
                echo: '',
            });
        }

        expect(await f.subject.handle(request({}, { echo: '' }))).toMatchObject({
            retcode: 10003,
            data: null,
        });
        let reads = 0;

        const trap = (): never => {
            reads++;
            throw new Error(marker);
        };

        const cases: Array<[unknown, number]> = [
            [request({ user_id: '0', extra: 1 }, { echo: '' }), 10004],
            [request({ user_id: '42', extra: undefined }, { echo: '' }), 10001],
            [request({ user_id: NaN }, { echo: '' }), 10001],
            [request(null, { echo: '' }), 10001],
            [{ action: 'get_user_info', echo: '' }, 10001],
            [request({ user_id: '42' }, { self: { platform: 'qq', user_id: 1 }, echo: '' }), 10001],
            [request({ user_id: '42' }, { self: selfB, echo: '' }), 10102],
            [request({ user_id: '0', extra: 1 }, { self: selfB, echo: '' }), 10102],
            [request({ user_id: '42' }, { self: { ...selfA, extra: 1 }, echo: '' }), 10004],
            [request(accessor({ user_id: '42' }, 'extra', trap), { echo: '' }), 10001],
            [
                request(new Proxy({ user_id: '42' }, { ownKeys: trap, get: trap }), { echo: '' }),
                10001,
            ],
        ];

        for (const [input, code] of cases) {
            const result = await f.subject.handle(input);
            expect(result).toMatchObject({ status: 'failed', retcode: code, data: null, echo: '' });
            expect(JSON.stringify(result)).not.toContain(marker);
        }

        expect(reads).toBe(0);
        expect(f.handle).not.toHaveBeenCalled();
    });

    it('classifies malformed envelopes and failures without retries or partial data', async () => {
        const cases: Array<[unknown, number]> = [
            [null, 20001],
            [[], 20001],
            [{}, 20001],
            [Object.create({ status: 'ok', retcode: 0, data: row() }), 20001],
            [{ status: 'ok', retcode: 0 }, 20001],
            [ok(null), 20001],
            [ok([]), 20001],
            [{ status: 'ok', retcode: '0', data: row() }, 20001],
            ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100'].map(
                (retcode): [unknown, number] => [
                    { status: 'failed', retcode, wording: marker },
                    20001,
                ],
            ),
            ...[1400, 1404].map((retcode): [unknown, number] => [
                { status: 'failed', retcode, wording: marker },
                20001,
            ]),
            ...[1, 100, 1200, Number.MAX_SAFE_INTEGER].map((retcode): [unknown, number] => [
                { status: 'failed', retcode, wording: marker },
                20002,
            ]),
        ];

        for (const [value, code] of cases) {
            const f = setup(async () => value);
            failure(await f.subject.handle(request(undefined, { echo: 'e' })), code);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_stranger_info', { user_id: 42 });
        }

        const f = setup(async () => {
            throw new Error(marker);
        });
        failure(await f.subject.handle(request(undefined, { echo: 'e' })), 20002);
        expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_stranger_info', { user_id: 42 });
    });

    it('requires matching own numeric ID and bounded own string fields', async () => {
        const values: unknown[] = [
            null,
            [],
            {},
            Object.create(row()),
            { nickname: 'n', remark: 'r' },
            { user_id: 42, remark: 'r' },
            { user_id: 42, nickname: 'n' },
            ...[1, 0, -1, 1.5, NaN, Infinity, 4294967296, '42', null].map((id) =>
                row(id as number, marker),
            ),
            ...[null, undefined, 1, false, {}, [], 'x'.repeat(1025), '🪶'.repeat(513)].flatMap(
                (s) => [
                    { user_id: 42, nickname: s, remark: marker },
                    { user_id: 42, nickname: marker, remark: s },
                ],
            ),
        ];

        for (const value of values) {
            const f = setup(async () => ok(value));
            failure(await f.subject.handle(request(undefined, { echo: 'e' })), 20001);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_stranger_info', { user_id: 42 });
        }
    });

    it('inspects own descriptors, ignores extra and nested then getters, rejects proxies without traps', async () => {
        let reads = 0;

        const trap = (): never => {
            reads++;
            throw new Error(marker);
        };

        const good = row();
        Object.defineProperty(good, 'extra', { enumerable: true, get: trap });
        Object.defineProperty(good, 'then', { enumerable: true, get: trap });
        const envelope = ok(good);
        Object.defineProperty(envelope, 'extra', { enumerable: true, get: trap });
        const accepted = setup(async () => envelope);
        expect((await accepted.subject.handle(request())).data).toEqual({
            user_id: '42',
            user_name: 'name',
            user_displayname: '',
            user_remark: 'remark',
        });
        expect(accepted.handle).toHaveBeenCalledExactlyOnceWith('get_stranger_info', {
            user_id: 42,
        });
        const traps = {
            get: trap,
            ownKeys: trap,
            getPrototypeOf: trap,
            getOwnPropertyDescriptor: trap,
        };
        const bad = [
            ...['status', 'retcode', 'data'].map((key) => accessor(ok(row()), key, trap)),
            ...['user_id', 'nickname', 'remark'].map((key) => ok(accessor(row(), key, trap))),
            ok(new Proxy(row(), traps)),
        ];

        for (const value of bad) {
            const f = setup(async () => value);
            failure(await f.subject.handle(request(undefined, { echo: 'e' })), 20001);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_stranger_info', { user_id: 42 });
        }

        expect(reads).toBe(0);
    });

    it('distinguishes outer await then assimilation from nested inspection', async () => {
        let thenReads = 0;
        let traps = 0;
        const proxy = new Proxy(ok(row()), {
            get(_target, key) {
                if (key === 'then') {
                    thenReads++;
                    return undefined;
                }

                traps++;
                throw new Error(marker);
            },
            ownKeys() {
                traps++;
                throw new Error(marker);
            },
            getOwnPropertyDescriptor() {
                traps++;
                throw new Error(marker);
            },
        });
        const f = setup(async () => proxy);
        failure(await f.subject.handle(request(undefined, { echo: 'e' })), 20001);
        expect(thenReads).toBeGreaterThan(0);
        expect(traps).toBe(0);
        expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_stranger_info', { user_id: 42 });
        let reads = 0;
        const throwing = ok(row());
        Object.defineProperty(throwing, 'then', {
            get() {
                reads++;
                throw new Error(marker);
            },
        });
        const g = setup(async () => throwing);
        failure(await g.subject.handle(request(undefined, { echo: 'e' })), 20002);
        expect(reads).toBe(1);
        expect(g.handle).toHaveBeenCalledExactlyOnceWith('get_stranger_info', { user_id: 42 });
    });
});

describe('actual registry and SDK with isolated fake fetch', () => {
    it('documents the v11 missing/null fallback, not proof that a user exists', async () => {
        const provider = vi.fn(async () => null);
        const without = new ApiHandler({} as ApiActionContext);
        const withNull = new ApiHandler({
            getStrangerInfo: provider,
        } as unknown as ApiActionContext);

        for (const [api, id] of [
            [without, 51],
            [withNull, 52],
        ] as const) {
            const handle = vi.spyOn(api, 'handle');
            expect(
                await dispatcher(api).handle(request({ user_id: String(id) }, { echo: 'e' })),
            ).toEqual({
                status: 'ok',
                retcode: 0,
                message: '',
                echo: 'e',
                data: { user_id: String(id), user_name: '', user_displayname: '', user_remark: '' },
            });
            expect(handle).toHaveBeenCalledExactlyOnceWith('get_stranger_info', { user_id: id });
        }

        expect(provider).toHaveBeenCalledExactlyOnceWith(52);
    });

    it('routes whitelisted accounts through injected fake fetch only', async () => {
        const providerA = vi.fn(async (id: number) => row(id, 'A', 'a'));
        const providerB = vi.fn(async (id: number) => row(id, 'B', 'b'));
        const apiA = new ApiHandler({ getStrangerInfo: providerA } as unknown as ApiActionContext);
        const apiB = new ApiHandler({ getStrangerInfo: providerB } as unknown as ApiActionContext);
        const hA = vi.spyOn(apiA, 'handle');
        const hB = vi.spyOn(apiB, 'handle');
        const dA = dispatcher(apiA, selfA);
        const dB = dispatcher(apiB, selfB);
        const url = 'http://fixture.invalid/';
        const seen: Array<{
            input: RequestInfo | URL;
            init?: RequestInit;
            body: { self?: { platform?: string; user_id?: string } };
        }> = [];
        const violations: string[] = [];
        const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(init?.body as string) as {
                self?: { platform?: string; user_id?: string };
            };
            seen.push({ input, init, body });
            let target: V12Dispatcher;

            if (body.self?.platform === selfA.platform && body.self.user_id === selfA.user_id) {
                target = dA;
            } else if (
                body.self?.platform === selfB.platform &&
                body.self.user_id === selfB.user_id
            ) {
                target = dB;
            } else {
                violations.push('unknown self');
                throw new Error('unknown fake route');
            }

            return new Response(JSON.stringify(await target.handle(body)), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });
        injectedFetch = fakeFetch;
        expectedFetchCalls = 2;
        const client = new OneBot12HttpClient({ baseUrl: url, fetch: fakeFetch });
        const a = await client.request(
            'get_user_info',
            { user_id: '1' },
            { self: selfA, echo: '' },
        );
        const b = await client.request(
            'get_user_info',
            { user_id: '4294967295' },
            { self: selfB, echo: 'b' },
        );
        expect(a).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: '',
            data: { user_id: '1', user_name: 'A', user_displayname: '', user_remark: 'a' },
        });
        expect(b).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: 'b',
            data: { user_id: '4294967295', user_name: 'B', user_displayname: '', user_remark: 'b' },
        });
        expect(seen.map((x) => x.body)).toEqual([
            { action: 'get_user_info', params: { user_id: '1' }, self: selfA, echo: '' },
            { action: 'get_user_info', params: { user_id: '4294967295' }, self: selfB, echo: 'b' },
        ]);
        expect(violations).toEqual([]);

        for (const item of seen) {
            expect(item.input).toBe(url);
            expect(item.init?.method).toBe('POST');
            expect(item.init?.redirect).toBe('error');
            expect((item.init?.headers as Headers).get('content-type')).toBe('application/json');
            expect((item.init?.headers as Headers).get('accept')).toBe('application/json');
        }

        expect(hA).toHaveBeenCalledExactlyOnceWith('get_stranger_info', { user_id: 1 });
        expect(hB).toHaveBeenCalledExactlyOnceWith('get_stranger_info', { user_id: 4294967295 });
        expect(providerA).toHaveBeenCalledExactlyOnceWith(1);
        expect(providerB).toHaveBeenCalledExactlyOnceWith(4294967295);
    });
});
