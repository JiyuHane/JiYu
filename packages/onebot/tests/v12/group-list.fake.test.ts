import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OneBot12HttpClient } from '../../../sdk/src/v12/http-client.js';
import { ApiHandler, type ApiActionContext } from '../../src/api-handler';
import { V12Dispatcher } from '../../src/v12/dispatcher';
import type { V11ActionHandler, V12CoreOptions } from '../../src/v12/types';

// Keep the real group-info/info actions; unrelated registry modules are inert.
vi.mock('../../src/actions/message', () => ({ actions: [] }));
vi.mock('../../src/actions/friend', () => ({ actions: [] }));
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
// group-info itself remains real; its unrelated web implementation is never loaded.
vi.mock('@snowluma/protocol/web/group-honor', () => ({ WebHonorType: { ALL: 'all' } }));

const selfA = { platform: 'qq', user_id: '10001' };
const selfB = { platform: 'qq', user_id: '10002' };
const marker = 'synthetic-sensitive-marker';
const row = (group_id = 42, group_name = 'name') => ({ group_id, group_name });
const ok = (data: unknown) => ({ status: 'ok', retcode: 0, data });
const request = (params: unknown = {}, extra: object = {}) => ({
    action: 'get_group_list',
    params,
    ...extra,
});
const mapped = (id: number, name: string) => ({ group_id: String(id), group_name: name });

function setup(handler: (action: string, params: unknown) => Promise<unknown>, self = selfA) {
    const handle = vi.fn(handler);
    const getStatus = vi.fn(() => ({ good: true, online: true }));
    const options: V12CoreOptions = {
        self,
        version: { impl: 'fixture', version: '1' },
        api: { handle } as unknown as V11ActionHandler,
        getStatus,
        getSentMessageTime: () => null,
    };
    return { dispatcher: new V12Dispatcher(options), handle, getStatus };
}

function expectFailure(result: unknown, retcode: number) {
    expect(result).toMatchObject({ status: 'failed', retcode, data: null, echo: 'e' });
    expect(JSON.stringify(result)).not.toContain(marker);
}

function accessor(value: object, key: string, get: () => never) {
    const copy = { ...value };
    Object.defineProperty(copy, key, { enumerable: true, get });
    return copy;
}

const defaultFetch = vi.fn(async () => {
    throw new Error('unexpected global fetch');
});
beforeEach(() => {
    defaultFetch.mockClear();
    vi.stubGlobal('fetch', defaultFetch);
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(defaultFetch).not.toHaveBeenCalled();
});

describe('v12 group list, fake v11 response seam', () => {
    it('projects exact fields, preserving order, duplicate IDs, empty names and accounts', async () => {
        const a = setup(async () =>
            ok([row(1, ''), row(Number.MAX_SAFE_INTEGER, '🪶'), row(1, 'again')]),
        );
        const b = setup(async () => ok([row(3, 'B')]), selfB);
        const [ra, rb] = await Promise.all([
            a.dispatcher.handle(request({}, { self: selfA, echo: '' })),
            b.dispatcher.handle(request({}, { self: selfB, echo: 'b' })),
        ]);
        expect(ra).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: '',
            data: [mapped(1, ''), mapped(Number.MAX_SAFE_INTEGER, '🪶'), mapped(1, 'again')],
        });
        expect(rb).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: 'b',
            data: [mapped(3, 'B')],
        });

        for (const fixture of [a, b]) {
            expect(fixture.handle).toHaveBeenCalledExactlyOnceWith('get_group_list', {});
            expect(Reflect.ownKeys(fixture.handle.mock.calls[0]![1] as object)).toEqual([]);
            expect(fixture.getStatus).not.toHaveBeenCalled();
        }

        const empty = setup(async () => ok([]));
        expect(await empty.dispatcher.handle(request())).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: [],
        });
        expect(empty.handle).toHaveBeenCalledExactlyOnceWith('get_group_list', {});
    });

    it('rejects invalid self, unsupported extras and malformed requests before any downstream call', async () => {
        let reads = 0;
        let traps = 0;

        const getter = () => {
            reads++;
            throw new Error(marker);
        };

        const proxy = new Proxy(
            {},
            {
                ownKeys() {
                    traps++;
                    throw new Error(marker);
                },
                get() {
                    traps++;
                    throw new Error(marker);
                },
                getOwnPropertyDescriptor() {
                    traps++;
                    throw new Error(marker);
                },
                getPrototypeOf() {
                    traps++;
                    throw new Error(marker);
                },
            },
        );
        const f = setup(async () => ok([]));
        const cases: Array<[unknown, number]> = [
            [request({ no_cache: false }, { echo: '' }), 10004],
            [request({ extra: 1 }, { echo: '' }), 10004],
            [request({ extra: undefined }, { echo: '' }), 10001],
            [request({ extra: NaN }, { echo: '' }), 10001],
            [request(null, { echo: '' }), 10001],
            [{ action: 'get_group_list', echo: '' }, 10001],
            [request({}, { self: { platform: 'qq', user_id: 1 }, echo: '' }), 10001],
            [request({}, { self: selfB, echo: '' }), 10102],
            [request({ extra: 1 }, { self: selfB, echo: '' }), 10102],
            [request({}, { self: { ...selfA, extra: 1 }, echo: '' }), 10004],
            [request({}, { extra: 1, echo: '' }), 10004],
            [request(accessor({}, 'extra', getter), { echo: '' }), 10001],
            [request(proxy, { echo: '' }), 10001],
            [accessor(request({}, { echo: '' }), 'self', getter), 10001],
        ];

        for (const [input, retcode] of cases) {
            expect(await f.dispatcher.handle(input)).toMatchObject({
                status: 'failed',
                retcode,
                data: null,
                echo: '',
            });
        }

        expect(reads).toBe(0);
        expect(traps).toBe(0);
        expect(f.handle).not.toHaveBeenCalled();
        expect(f.getStatus).not.toHaveBeenCalled();
    });

    it('classifies all envelope and failure cases without leaks or retries', async () => {
        const cases: Array<[unknown, number]> = [
            [null, 20001],
            [[], 20001],
            ['bad', 20001],
            [{}, 20001],
            [Object.create({ status: 'ok', retcode: 0, data: [] }), 20001],
            [{ status: 'ok', retcode: 0 }, 20001],
            [{ status: 'ok', retcode: 0, data: null }, 20001],
            [{ status: 'ok', retcode: 0, data: {} }, 20001],
            [{ status: 'ok', retcode: '0', data: [] }, 20001],
            [{ status: 'ok', retcode: 100, data: [] }, 20001],
            ...[0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '100'].map(
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
            expectFailure(await f.dispatcher.handle(request({}, { echo: 'e' })), code);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_group_list', {});
        }

        const thrown = setup(async () => {
            throw new Error(marker);
        });
        expectFailure(await thrown.dispatcher.handle(request({}, { echo: 'e' })), 20002);
        expect(thrown.handle).toHaveBeenCalledExactlyOnceWith('get_group_list', {});
    });

    it('rejects every invalid row atomically even after an otherwise valid row', async () => {
        const invalid: unknown[] = [
            null,
            [],
            1,
            'x',
            {},
            Object.create({ group_id: 1, group_name: 'name' }),
            { group_name: 'name' },
            { group_id: 1 },
            ...[
                0,
                -0,
                -1,
                1.5,
                NaN,
                Infinity,
                -Infinity,
                Number.MAX_SAFE_INTEGER + 1,
                '42',
                null,
                true,
            ].map((group_id) => ({ group_id, group_name: 'name' })),
            ...[null, undefined, 1, false, {}, []].map((group_name) => ({
                group_id: 1,
                group_name,
            })),
        ];

        for (const bad of invalid) {
            const f = setup(async () => ok([row(), bad]));
            expectFailure(await f.dispatcher.handle(request({}, { echo: 'e' })), 20001);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_group_list', {});
        }
    });

    it('enforces inclusive row, per-name and aggregate UTF-16 limits', async () => {
        const many = Array.from({ length: 10000 }, (_, i) => row(i + 1, ''));
        const units = Array.from({ length: 256 }, (_, i) => row(i + 1, '🪶'.repeat(512)));

        for (const rows of [many, units, [row(1, 'x'.repeat(1024))]]) {
            const f = setup(async () => ok(rows));
            const result = await f.dispatcher.handle(request({}, { echo: 'e' }));
            expect(result).toMatchObject({ status: 'ok', retcode: 0, echo: 'e' });
            expect(result.data).toHaveLength(rows.length);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_group_list', {});
        }

        for (const rows of [
            [...many, row()],
            [row(), row(2, 'x'.repeat(1025))],
            [row(), row(2, '🪶'.repeat(513))],
            [...units, row(257, 'x')],
        ]) {
            const f = setup(async () => ok(rows));
            expectFailure(await f.dispatcher.handle(request({}, { echo: 'e' })), 20001);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_group_list', {});
        }
    });

    it('uses only own descriptors on rows and dense arrays; ignores extra accessors and nested then', async () => {
        let reads = 0;
        let traps = 0;

        const get = (): never => {
            reads++;
            throw new Error(marker);
        };

        const trap = (): never => {
            traps++;
            throw new Error(marker);
        };

        const trapSet = {
            get: trap,
            ownKeys: trap,
            getPrototypeOf: trap,
            getOwnPropertyDescriptor: trap,
            has: trap,
        };
        const good = row();
        Object.defineProperty(good, 'extra', { enumerable: true, get });
        Object.defineProperty(good, 'then', { enumerable: true, get });
        const goodRows = [good];
        Object.defineProperty(goodRows, 'then', { enumerable: true, get });
        Object.defineProperty(goodRows, 'extra', { enumerable: true, get });
        const goodEnvelope = ok(goodRows);
        Object.defineProperty(goodEnvelope, 'extra', { enumerable: true, get });
        const goodFixture = setup(async () => goodEnvelope);
        expect((await goodFixture.dispatcher.handle(request())).data).toEqual([mapped(42, 'name')]);
        expect(goodFixture.handle).toHaveBeenCalledExactlyOnceWith('get_group_list', {});
        const sparse = [row(), row()];
        delete sparse[1];
        const inheritedIndex = [row(), row()];
        delete inheritedIndex[1];
        const proto = Object.create(Array.prototype);
        Object.defineProperty(proto, '1', { get });
        Object.setPrototypeOf(inheritedIndex, proto);
        const indexAccessor = [row(), row()];
        Object.defineProperty(indexAccessor, '1', { enumerable: true, get });
        const inheritedRow = Object.create({
            get group_name() {
                return get();
            },
        });
        inheritedRow.group_id = 1;
        const cases: unknown[] = [
            ...['status', 'retcode', 'data'].map((key) => accessor(ok([row()]), key, get)),
            ...['group_id', 'group_name'].map((key) => ok([row(), accessor(row(), key, get)])),
            ok([row(), inheritedRow]),
            ok(sparse),
            ok(inheritedIndex),
            ok(indexAccessor),
            ok(new Proxy([row()], trapSet)),
            ok([row(), new Proxy(row(), trapSet)]),
        ];

        for (const value of cases) {
            const f = setup(async () => value);
            expectFailure(await f.dispatcher.handle(request({}, { echo: 'e' })), 20001);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_group_list', {});
        }

        expect(reads).toBe(0);
        expect(traps).toBe(0);
    });

    it('distinguishes outer await then assimilation from post-await proxy checks', async () => {
        let thenReads = 0;
        let otherTraps = 0;
        const proxy = new Proxy(ok([row()]), {
            get(_target, key) {
                if (key === 'then') {
                    thenReads++;
                    return undefined;
                }

                otherTraps++;
                throw new Error(marker);
            },
            ownKeys() {
                otherTraps++;
                throw new Error(marker);
            },
            getOwnPropertyDescriptor() {
                otherTraps++;
                throw new Error(marker);
            },
            getPrototypeOf() {
                otherTraps++;
                throw new Error(marker);
            },
        });
        const f = setup(async () => proxy);
        expectFailure(await f.dispatcher.handle(request({}, { echo: 'e' })), 20001);
        expect(thenReads).toBeGreaterThan(0);
        expect(otherTraps).toBe(0);
        expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_group_list', {});
        let reads = 0;
        const envelope = ok([]);
        Object.defineProperty(envelope, 'then', {
            get() {
                reads++;
                throw new Error(marker);
            },
        });
        const rejected = setup(async () => envelope);
        expectFailure(await rejected.dispatcher.handle(request({}, { echo: 'e' })), 20002);
        expect(reads).toBe(1);
        expect(rejected.handle).toHaveBeenCalledExactlyOnceWith('get_group_list', {});
    });
});

describe('SDK and real v11 handler with fake per-account providers', () => {
    it('round-trips through fake fetch and never falls back to global fetch', async () => {
        const providerA = vi.fn(async () => [row(7, ''), row(7, 'again')]);
        const providerB = vi.fn(async () => [row(8, 'B')]);
        const apiA = new ApiHandler({ getGroupList: providerA } as unknown as ApiActionContext);
        const apiB = new ApiHandler({ getGroupList: providerB } as unknown as ApiActionContext);
        const handleA = vi.spyOn(apiA, 'handle');
        const handleB = vi.spyOn(apiB, 'handle');
        const make = (self: typeof selfA, api: ApiHandler) =>
            new V12Dispatcher({
                self,
                api,
                version: { impl: 'fixture', version: '1' },
                getStatus: () => ({ good: true, online: true }),
                getSentMessageTime: () => null,
            });
        const dispatcherA = make(selfA, apiA);
        const dispatcherB = make(selfB, apiB);
        const url = 'http://fixture.invalid/';
        const observed: Array<{ input: RequestInfo | URL; init?: RequestInit; body: unknown }> = [];
        const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(init?.body as string) as { self?: { user_id?: string } };
            observed.push({ input, init, body });
            const dispatcher = body.self?.user_id === selfB.user_id ? dispatcherB : dispatcherA;
            return new Response(JSON.stringify(await dispatcher.handle(body)), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });
        const client = new OneBot12HttpClient({ baseUrl: url, fetch: fakeFetch });
        expect(await dispatcherA.handle(request({}, { self: selfB, echo: '' }))).toMatchObject({
            status: 'failed',
            retcode: 10102,
            echo: '',
        });
        expect(await dispatcherB.handle(request({ no_cache: false }, { echo: '' }))).toMatchObject({
            status: 'failed',
            retcode: 10004,
            echo: '',
        });
        expect(handleA).not.toHaveBeenCalled();
        expect(handleB).not.toHaveBeenCalled();
        expect(providerA).not.toHaveBeenCalled();
        expect(providerB).not.toHaveBeenCalled();
        const a = await client.request('get_group_list', {}, { self: selfA, echo: '' });
        const b = await client.request('get_group_list', {}, { self: selfB, echo: 'b' });
        expect(a).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: '',
            data: [mapped(7, ''), mapped(7, 'again')],
        });
        expect(b).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: 'b',
            data: [mapped(8, 'B')],
        });
        expect(fakeFetch).toHaveBeenCalledTimes(2);
        expect(observed.map((item) => item.body)).toEqual([
            { action: 'get_group_list', params: {}, self: selfA, echo: '' },
            { action: 'get_group_list', params: {}, self: selfB, echo: 'b' },
        ]);

        for (const item of observed) {
            expect(item.input).toBe(url);
            expect(item.init?.method).toBe('POST');
            expect(item.init?.redirect).toBe('error');
            expect(item.init?.headers).toBeInstanceOf(Headers);
            expect((item.init?.headers as Headers).get('content-type')).toBe('application/json');
            expect((item.init?.headers as Headers).get('accept')).toBe('application/json');
        }

        expect(defaultFetch).not.toHaveBeenCalled();
        expect(handleA).toHaveBeenCalledExactlyOnceWith('get_group_list', {});
        expect(handleB).toHaveBeenCalledExactlyOnceWith('get_group_list', {});
        expect(providerA).toHaveBeenCalledExactlyOnceWith(false);
        expect(providerB).toHaveBeenCalledExactlyOnceWith(false);
    });
});
