import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OneBot12HttpClient } from '../../../sdk/src/v12/http-client.js';
import { ApiHandler, type ApiActionContext } from '../../src/api-handler';
import { actions as groupActions } from '../../src/actions/group-info';
import { V12Dispatcher } from '../../src/v12/dispatcher';
import type { V11ActionHandler } from '../../src/v12/types';

// The actual group-info and info registry remains active; unrelated actions are inert.
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
vi.mock('@snowluma/protocol/web/group-honor', () => ({ WebHonorType: { ALL: 'all' } }));

const marker = 'synthetic-private-marker-97fd';
const selfA = { platform: 'qq', user_id: '10001' };
const selfB = { platform: 'qq', user_id: '10002' };
const request = (params: unknown = { group_id: '42' }, extra: object = {}) => ({
    action: 'get_group_info',
    params,
    ...extra,
});
const ok = (data: unknown) => ({ status: 'ok', retcode: 0, data });
const row = (group_id = 42, group_name = 'group') => ({ group_id, group_name });
const defaultFetch = vi.fn(async () => {
    throw new Error('unexpected global fetch');
});

beforeEach(() => {
    defaultFetch.mockClear();
    vi.stubGlobal('fetch', defaultFetch);
});
afterEach(() => {
    const calls = defaultFetch.mock.calls.length;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(calls).toBe(0);
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

function setup(fn: () => Promise<unknown>, self = selfA) {
    const handle = vi.fn(fn);
    return { handle, subject: dispatcher({ handle } as unknown as V11ActionHandler, self) };
}

function failure(result: unknown, code: number) {
    expect(result).toEqual({
        status: 'failed',
        retcode: code,
        message: code === 20001 ? 'invalid group info result' : 'group info unavailable',
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

describe('get_group_info dispatcher, synthetic v11 seam', () => {
    it('is a read-only action and maps boundary IDs, empty and Unicode names', async () => {
        expect(
            groupActions.find((action) => action.names.includes('get_group_info'))?.describe()
                .readOnly,
        ).toBe(true);

        for (const [id, name] of [
            [1, ''],
            [Number.MAX_SAFE_INTEGER, '羽🪶'],
            [42, '🪶'.repeat(512)],
        ] as const) {
            const f = setup(async () => ok(row(id, name)));
            expect(
                await f.subject.handle(
                    request({ group_id: String(id) }, { self: selfA, echo: '' }),
                ),
            ).toEqual({
                status: 'ok',
                retcode: 0,
                message: '',
                echo: '',
                data: { group_id: String(id), group_name: name },
            });
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_group_info', { group_id: id });
        }
    });

    it('preflight and parameter errors take priority without downstream calls', async () => {
        let reads = 0;

        const getter = (): never => {
            reads++;
            throw new Error(marker);
        };

        const f = setup(async () => ok(row()));
        const badIds: unknown[] = [
            undefined,
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
            '9007199254740992',
        ];

        for (const id of badIds) {
            // Undefined is not JSON; a missing group_id is valid JSON but an invalid parameter.
            const params = id === undefined ? {} : { group_id: id };
            expect(await f.subject.handle(request(params, { echo: '' }))).toMatchObject({
                status: 'failed',
                retcode: 10003,
                data: null,
                echo: '',
            });
        }

        const cases: Array<[unknown, number]> = [
            [request({ group_id: '0', extra: 1 }, { echo: '' }), 10004],
            [request({ group_id: '42', no_cache: false }, { echo: '' }), 10004],
            [request({ group_id: '42', extra: undefined }, { echo: '' }), 10001],
            [request({ group_id: NaN }, { echo: '' }), 10001],
            [request(null, { echo: '' }), 10001],
            [{ action: 'get_group_info', echo: '' }, 10001],
            [
                request({ group_id: '42' }, { self: { platform: 'qq', user_id: 1 }, echo: '' }),
                10001,
            ],
            [request({ group_id: '42' }, { self: selfB, echo: '' }), 10102],
            [request({ group_id: '0', extra: 1 }, { self: selfB, echo: '' }), 10102],
            [request({ group_id: '42' }, { self: { ...selfA, extra: 1 }, echo: '' }), 10004],
            [request(accessor({ group_id: '42' }, 'extra', getter), { echo: '' }), 10001],
            [
                request(new Proxy({ group_id: '42' }, { ownKeys: getter, get: getter }), {
                    echo: '',
                }),
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

    it('classifies malformed envelopes, v11 failures and throws with fixed messages and no retry', async () => {
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
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_group_info', { group_id: 42 });
        }

        const f = setup(async () => {
            throw new Error(marker);
        });
        failure(await f.subject.handle(request(undefined, { echo: 'e' })), 20002);
        expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_group_info', { group_id: 42 });
    });

    it('rejects mismatched, missing and malformed own fields including UTF-16 overflow', async () => {
        const values: unknown[] = [
            null,
            [],
            {},
            Object.create(row()),
            { group_name: 'n' },
            { group_id: 42 },
            ...[1, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '42', null].map(
                (id) => ({ group_id: id, group_name: marker }),
            ),
            ...[null, undefined, 1, false, {}, [], 'x'.repeat(1025), '🪶'.repeat(513)].map(
                (name) => ({ group_id: 42, group_name: name }),
            ),
        ];

        for (const value of values) {
            const f = setup(async () => ok(value));
            failure(await f.subject.handle(request(undefined, { echo: 'e' })), 20001);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_group_info', { group_id: 42 });
        }
    });

    it('uses descriptors, ignores extra getters and rejects nested proxies without invoking traps', async () => {
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
            group_id: '42',
            group_name: 'group',
        });
        expect(accepted.handle).toHaveBeenCalledExactlyOnceWith('get_group_info', { group_id: 42 });
        const traps = {
            get: trap,
            ownKeys: trap,
            getPrototypeOf: trap,
            getOwnPropertyDescriptor: trap,
        };
        const bad = [
            ...['status', 'retcode', 'data'].map((key) => accessor(ok(row()), key, trap)),
            ...['group_id', 'group_name'].map((key) => ok(accessor(row(), key, trap))),
            ok(new Proxy(row(), traps)),
        ];

        for (const value of bad) {
            const f = setup(async () => value);
            failure(await f.subject.handle(request(undefined, { echo: 'e' })), 20001);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_group_info', { group_id: 42 });
        }

        expect(reads).toBe(0);
    });

    it('recognizes that await assimilates outer then before rejecting outer proxies', async () => {
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
        expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_group_info', { group_id: 42 });
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
        expect(g.handle).toHaveBeenCalledExactlyOnceWith('get_group_info', { group_id: 42 });
    });
});

describe('real SDK and real v11 registry over explicit fake fetch', () => {
    it('routes per account and applies the v11 no_cache=false default', async () => {
        const providerA = vi.fn(async (id: number) => row(id, 'A🪶'));
        const providerB = vi.fn(async (id: number) => row(id, 'B'));
        const apiA = new ApiHandler({ getGroupInfo: providerA } as unknown as ApiActionContext);
        const apiB = new ApiHandler({ getGroupInfo: providerB } as unknown as ApiActionContext);
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
        // Fake routing models only dispatch, not a real network or listener.
        const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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

            const result = await target.handle(body);
            return new Response(JSON.stringify(result), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });
        const client = new OneBot12HttpClient({ baseUrl: url, fetch });
        const a = await client.request(
            'get_group_info',
            { group_id: '1' },
            { self: selfA, echo: '' },
        );
        const b = await client.request(
            'get_group_info',
            { group_id: '42' },
            { self: selfB, echo: 'b' },
        );
        expect(a).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: { group_id: '1', group_name: 'A🪶' },
            echo: '',
        });
        expect(b).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: { group_id: '42', group_name: 'B' },
            echo: 'b',
        });
        expect(seen.map((x) => x.body)).toEqual([
            { action: 'get_group_info', params: { group_id: '1' }, self: selfA, echo: '' },
            { action: 'get_group_info', params: { group_id: '42' }, self: selfB, echo: 'b' },
        ]);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(violations).toEqual([]);

        for (const item of seen) {
            expect(item.input).toBe(url);
            expect(item.init?.method).toBe('POST');
            expect(item.init?.redirect).toBe('error');
            expect((item.init?.headers as Headers).get('content-type')).toBe('application/json');
            expect((item.init?.headers as Headers).get('accept')).toBe('application/json');
        }

        expect(hA).toHaveBeenCalledExactlyOnceWith('get_group_info', { group_id: 1 });
        expect(hB).toHaveBeenCalledExactlyOnceWith('get_group_info', { group_id: 42 });
        expect(providerA).toHaveBeenCalledExactlyOnceWith(1, false);
        expect(providerB).toHaveBeenCalledExactlyOnceWith(42, false);
    });

    it('maps missing and null providers to the v11 fallback, not proof of group existence', async () => {
        const nullProvider = vi.fn(async () => null);
        const without = new ApiHandler({} as ApiActionContext);
        const withNull = new ApiHandler({
            getGroupInfo: nullProvider,
        } as unknown as ApiActionContext);

        for (const [api, id] of [
            [without, 51],
            [withNull, 52],
        ] as const) {
            const handle = vi.spyOn(api, 'handle');
            const result = await dispatcher(api).handle(
                request({ group_id: String(id) }, { echo: 'e' }),
            );
            expect(result).toEqual({
                status: 'ok',
                retcode: 0,
                message: '',
                data: { group_id: String(id), group_name: '' },
                echo: 'e',
            });
            expect(handle).toHaveBeenCalledExactlyOnceWith('get_group_info', { group_id: id });
        }

        expect(nullProvider).toHaveBeenCalledExactlyOnceWith(52, false);
    });
});
