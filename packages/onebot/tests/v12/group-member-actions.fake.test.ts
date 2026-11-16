import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OneBot12HttpClient } from '../../../sdk/src/v12/http-client.js';
import { ApiHandler, type ApiActionContext } from '../../src/api-handler';
import { V12Dispatcher } from '../../src/v12/dispatcher';
import type { V11ActionHandler, V12Response } from '../../src/v12/types';

// Keep the actual group-info registry; all unrelated action modules are inert.
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

// These are synthetic projections. Empty strings, cached data and a successful
// response make no claim about a real QQ account or current group membership.
const selfA = { platform: 'qq', user_id: '10001' };
const selfB = { platform: 'qq', user_id: '10002' };
const marker = 'synthetic-member-private-marker';
const list = 'get_group_member_list' as const;
const info = 'get_group_member_info' as const;
type MemberAction = typeof list | typeof info;
const actions: readonly MemberAction[] = [list, info];
const row = (user_id = 7, nickname = 'name', card = 'card', group_id = 42) => ({
    group_id,
    user_id,
    nickname,
    card,
    role: 'member',
    extra: 'v11-only',
});
const mapped = (user_id: number, user_name: string, user_displayname: string) => ({
    user_id: String(user_id),
    user_name,
    user_displayname,
});
const ok = (data: unknown) => ({ status: 'ok', retcode: 0, data });
const paramsFor = (action: MemberAction) =>
    action === list ? { group_id: '42' } : { group_id: '42', user_id: '7' };
const request = (
    action: MemberAction,
    params: unknown = paramsFor(action),
    extra: object = {},
) => ({
    action,
    params,
    ...extra,
});

function dispatcher(api: V11ActionHandler, self = selfA) {
    const getStatus = vi.fn(() => ({ good: true, online: true }));
    const subject = new V12Dispatcher({
        api,
        self,
        version: { impl: 'fixture', version: '1' },
        getStatus,
        getSentMessageTime: () => null,
    });
    return { subject, getStatus };
}

function setup(handler: (action: string, params: unknown) => Promise<unknown>, self = selfA) {
    const handle = vi.fn(handler);
    return {
        ...dispatcher({ handle } as unknown as V11ActionHandler, self),
        handle,
    };
}

function expectListCall(fixture: ReturnType<typeof setup>, group_id = 42) {
    expect(fixture.handle).toHaveBeenCalledExactlyOnceWith(list, { group_id });
    expect(fixture.getStatus).not.toHaveBeenCalled();
}

function failure(result: V12Response, code: number, echo = 'e') {
    expect(result).toMatchObject({ status: 'failed', retcode: code, data: null, echo });
    expect(typeof result.message).toBe('string');
    expect(Object.keys(result).sort()).toEqual(['data', 'echo', 'message', 'retcode', 'status']);
    expect(JSON.stringify(result)).not.toContain(marker);
}

function accessor(value: object, key: string, get: () => never): object {
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
    const calls = defaultFetch.mock.calls.length;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(calls).toBe(0);
});

describe('v12 group member actions with a synthetic v11 handler', () => {
    it('projects exact fields without changing v11 rows, preserving order, duplicates and empties', async () => {
        const rows = [row(1, '', ''), row(0xffffffff, '🪶', '名片'), row(1, 'again', '')];
        const original = rows.map((item) => ({ ...item }));
        const a = setup(async () => ok(rows));
        const b = setup(async () => ok([row(8, 'B', 'other')]), selfB);
        expect(await a.subject.handle(request(list, undefined, { self: selfA, echo: '' }))).toEqual(
            {
                status: 'ok',
                retcode: 0,
                message: '',
                echo: '',
                data: [mapped(1, '', ''), mapped(0xffffffff, '🪶', '名片'), mapped(1, 'again', '')],
            },
        );
        expect(
            await b.subject.handle(request(list, undefined, { self: selfB, echo: 'b' })),
        ).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: 'b',
            data: [mapped(8, 'B', 'other')],
        });
        expect(rows).toEqual(original);
        expectListCall(a);
        expectListCall(b);

        const empty = setup(async () => ok([]));
        expect(await empty.subject.handle(request(list))).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: [],
        });
        expectListCall(empty);
    });

    it('requires exactly one info match in the fully validated list', async () => {
        const single = setup(async () =>
            ok([row(3, 'other', ''), row(7, '', 'display'), row(3, 'duplicate other', '')]),
        );
        expect(await single.subject.handle(request(info, undefined, { echo: '' }))).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: '',
            data: mapped(7, '', 'display'),
        });
        expectListCall(single);

        for (const rows of [[], [row(8)], [row(7), row(8), row(7, 'again')]]) {
            const f = setup(async () => ok(rows));
            const result = await f.subject.handle(request(info, undefined, { echo: 'e' }));
            failure(result, 35000);
            expect(result.message).toBe('group member match unavailable or ambiguous');
            expectListCall(f);
        }

        // A later invalid row must not be skipped after a matching row was found.
        const invalidAfterMatch = setup(async () => ok([row(7), { ...row(8), group_id: 43 }]));
        failure(
            await invalidAfterMatch.subject.handle(request(info, undefined, { echo: 'e' })),
            20001,
        );
        expectListCall(invalidAfterMatch);
    });

    it('accepts both inclusive uint32 boundaries for each applicable ID', async () => {
        for (const groupId of [1, 0xffffffff]) {
            for (const userId of [1, 0xffffffff]) {
                for (const action of actions) {
                    const f = setup(async () => ok([row(userId, '', '名', groupId)]));
                    const params =
                        action === list
                            ? { group_id: String(groupId) }
                            : { group_id: String(groupId), user_id: String(userId) };
                    const result = await f.subject.handle(request(action, params, { echo: '' }));
                    expect(result).toEqual({
                        status: 'ok',
                        retcode: 0,
                        message: '',
                        echo: '',
                        data:
                            action === list ? [mapped(userId, '', '名')] : mapped(userId, '', '名'),
                    });
                    expectListCall(f, groupId);
                }
            }
        }
    });

    it('rejects invalid identifiers, extras, wrong self and non-JSON snapshots before v11', async () => {
        const f = setup(async () => ok([row()]));
        const badIds: unknown[] = [
            null,
            0,
            1,
            true,
            '',
            '0',
            '-0',
            '-1',
            '+1',
            '01',
            '1.0',
            '1e0',
            ' 1',
            '1 ',
            '4294967296',
            '9007199254740992',
            '١',
        ];

        for (const action of actions) {
            for (const key of action === list ? ['group_id'] : ['group_id', 'user_id']) {
                for (const id of badIds) {
                    const params = { ...paramsFor(action), [key]: id };
                    failure(await f.subject.handle(request(action, params, { echo: 'e' })), 10003);
                }

                const missing: Record<string, unknown> = { ...paramsFor(action) };
                delete missing[key];
                failure(await f.subject.handle(request(action, missing, { echo: 'e' })), 10003);
            }

            const params = paramsFor(action);
            const cases: Array<[unknown, number]> = [
                [request(action, { ...params, group_id: '0', extra: 1 }, { echo: 'e' }), 10004],
                [request(action, { ...params, no_cache: false }, { echo: 'e' }), 10004],
                [request(action, { ...params, extra: undefined }, { echo: 'e' }), 10001],
                [request(action, { ...params, group_id: NaN }, { echo: 'e' }), 10001],
                [request(action, null, { echo: 'e' }), 10001],
                [{ action, echo: 'e' }, 10001],
                [request(action, params, { self: selfB, echo: 'e' }), 10102],
                [request(action, { ...params, extra: 1 }, { self: selfB, echo: 'e' }), 10102],
                [
                    request(action, params, { self: { platform: 'qq', user_id: 1 }, echo: 'e' }),
                    10001,
                ],
                [request(action, params, { self: { ...selfA, extra: 1 }, echo: 'e' }), 10004],
                [request(action, params, { extra: 1, echo: 'e' }), 10004],
            ];

            for (const [input, code] of cases) {
                failure(await f.subject.handle(input), code);
            }

            if (action === list) {
                failure(
                    await f.subject.handle(
                        request(action, { ...params, user_id: '7' }, { echo: 'e' }),
                    ),
                    10004,
                );
            }

            expect(
                await f.subject.handle(request(action, { ...params, group_id: '0' }, { echo: '' })),
            ).toEqual({
                status: 'failed',
                retcode: 10003,
                data: null,
                message: 'invalid group_id or user_id',
                echo: '',
            });
            const withoutEcho = await f.subject.handle(request(action, params, { self: selfB }));
            expect(withoutEcho).toEqual({
                status: 'failed',
                retcode: 10102,
                data: null,
                message: 'unknown self',
            });
            expect(withoutEcho).not.toHaveProperty('echo');
        }

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

        const proxy = new Proxy(paramsFor(info), {
            get: trap,
            ownKeys: trap,
            getPrototypeOf: trap,
            getOwnPropertyDescriptor: trap,
        });

        for (const input of [
            request(info, accessor(paramsFor(info), 'group_id', get), { echo: 'e' }),
            request(info, accessor(paramsFor(info), 'user_id', get), { echo: 'e' }),
            request(info, proxy, { echo: 'e' }),
            accessor(request(info, undefined, { echo: 'e' }), 'self', get),
        ]) {
            failure(await f.subject.handle(input), 10001);
        }

        expect(reads).toBe(0);
        expect(traps).toBe(0);
        expect(f.handle).not.toHaveBeenCalled();
        expect(f.getStatus).not.toHaveBeenCalled();
    });

    it('dispatches the immutable preflight snapshot rather than later caller mutations', async () => {
        for (const action of actions) {
            const f = setup(async () => ok([row()]));
            const input = {
                action,
                params: { ...paramsFor(action) },
                self: { ...selfA },
                echo: 'e',
            };
            const prepared = f.subject.createInternalHttpPreflight().classify(input);
            expect(prepared.kind).toBe('ordinary');

            if (prepared.kind !== 'ordinary') {
                throw new Error('expected an ordinary preflight token');
            }

            expect(f.handle).not.toHaveBeenCalled();
            input.action = action === list ? info : list;
            input.params.group_id = '99';

            if ('user_id' in input.params) {
                input.params.user_id = '8';
            }

            input.self.user_id = selfB.user_id;
            input.echo = 'changed';
            const result = await f.subject.handlePreparedOrdinary(prepared.token);
            expect(result).toEqual({
                status: 'ok',
                retcode: 0,
                message: '',
                echo: 'e',
                data: action === list ? [mapped(7, 'name', 'card')] : mapped(7, 'name', 'card'),
            });
            expectListCall(f);
            expect(await f.subject.handlePreparedOrdinary(prepared.token)).toEqual({
                status: 'failed',
                retcode: 10001,
                message: 'invalid action request',
                data: null,
            });
            expectListCall(f);
        }
    });

    it('classifies v11 envelopes and exceptions without leaking details or retrying', async () => {
        const cases: Array<[unknown, number]> = [
            [null, 20001],
            [[], 20001],
            ['bad', 20001],
            [{}, 20001],
            [Object.create({ status: 'ok', retcode: 0, data: [] }), 20001],
            [{ status: 'ok', retcode: 0 }, 20001],
            [ok(null), 20001],
            [ok({}), 20001],
            [{ status: 'ok', retcode: '0', data: [] }, 20001],
            [{ status: 'ok', retcode: 100, data: [] }, 20001],
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

        for (const action of actions) {
            const kind = action === list ? 'group member list' : 'group member info';

            for (const [value, code] of cases) {
                const f = setup(async () => value);
                const result = await f.subject.handle(request(action, undefined, { echo: 'e' }));
                failure(result, code);
                expect(result.message).toBe(
                    code === 20001 ? `invalid ${kind} result` : `${kind} unavailable`,
                );
                expectListCall(f);
            }

            const thrown = setup(async () => {
                throw new Error(marker);
            });
            const result = await thrown.subject.handle(request(action, undefined, { echo: 'e' }));
            failure(result, 20002);
            expect(result.message).toBe(`${kind} unavailable`);
            expectListCall(thrown);
        }
    });

    it('rejects every malformed row atomically, including rows after an info match', async () => {
        const invalid: unknown[] = [
            null,
            [],
            1,
            'x',
            {},
            Object.create(row()),
            { user_id: 8, nickname: 'n', card: 'c' },
            { group_id: 42, nickname: 'n', card: 'c' },
            { group_id: 42, user_id: 8, card: 'c' },
            { group_id: 42, user_id: 8, nickname: 'n' },
            ...[0, -0, -1, 1, 43, 1.5, NaN, Infinity, 0x100000000, '42', null, true].map(
                (group_id) => ({ ...row(8), group_id }),
            ),
            ...[0, -0, -1, 1.5, NaN, Infinity, 0x100000000, '8', null, true].map((user_id) => ({
                ...row(8),
                user_id,
            })),
            ...[undefined, null, 1, false, {}, []].flatMap((value) => [
                { ...row(8), nickname: value },
                { ...row(8), card: value },
            ]),
        ];

        for (const action of actions) {
            for (const bad of invalid) {
                const f = setup(async () => ok([row(7), bad]));
                failure(await f.subject.handle(request(action, undefined, { echo: 'e' })), 20001);
                expectListCall(f);
            }
        }
    });

    it('enforces inclusive row, individual field and aggregate UTF-16 limits on the full list', async () => {
        const many = Array.from({ length: 10000 }, (_, i) => row(i + 1, '', ''));
        const aggregate = Array.from({ length: 128 }, (_, i) =>
            row(i + 1, 'x'.repeat(1024), '🪶'.repeat(512)),
        );
        const valid = [
            { rows: many, user: 10000 },
            { rows: aggregate, user: 128 },
            { rows: [row(7, '🪶'.repeat(512), 'x'.repeat(1024))], user: 7 },
        ];

        for (const action of actions) {
            for (const sample of valid) {
                const f = setup(async () => ok(sample.rows));
                const params =
                    action === list
                        ? { group_id: '42' }
                        : { group_id: '42', user_id: String(sample.user) };
                const result = await f.subject.handle(request(action, params, { echo: 'e' }));
                expect(result).toMatchObject({ status: 'ok', retcode: 0, echo: 'e' });

                if (action === list) {
                    expect(result.data).toHaveLength(sample.rows.length);
                } else {
                    const match = sample.rows.find((item) => item.user_id === sample.user)!;
                    expect(result.data).toEqual(mapped(match.user_id, match.nickname, match.card));
                }

                expectListCall(f);
            }

            for (const sample of [
                { rows: [...many, row(10001, '', '')], user: 1 },
                { rows: [row(7), row(8, 'x'.repeat(1025), '')], user: 7 },
                { rows: [row(7), row(8, '', '🪶'.repeat(513))], user: 7 },
                { rows: [...aggregate, row(129, 'x', '')], user: 1 },
            ]) {
                const f = setup(async () => ok(sample.rows));
                // Every info case has a match before the invalid tail or limit.
                const params =
                    action === list
                        ? { group_id: '42' }
                        : { group_id: '42', user_id: String(sample.user) };
                failure(await f.subject.handle(request(action, params, { echo: 'e' })), 20001);
                expectListCall(f);
            }
        }
    });

    it('reads required own data without touching unrelated getters or nested then', async () => {
        let reads = 0;

        const get = (): never => {
            reads++;
            throw new Error(marker);
        };

        for (const action of actions) {
            const member = row(7, 'name', 'card');
            // A required non-enumerable own data property is still an own data property.
            Object.defineProperty(member, 'card', { value: 'card', enumerable: false });
            Object.defineProperty(member, 'extra', { enumerable: true, get });
            Object.defineProperty(member, 'then', { enumerable: true, get });
            const rows = [member];
            Object.defineProperty(rows, 'then', { enumerable: true, get });
            const envelope = ok(rows);
            Object.defineProperty(envelope, 'extra', { enumerable: true, get });
            const f = setup(async () => envelope);
            expect((await f.subject.handle(request(action))).data).toEqual(
                action === list ? [mapped(7, 'name', 'card')] : mapped(7, 'name', 'card'),
            );
            expectListCall(f);
        }

        expect(reads).toBe(0);
    });

    it('checks own data descriptors and rejects sparse arrays, accessors and nested proxies without invoking them', async () => {
        let reads = 0;
        let trapCalls = 0;

        const get = (): never => {
            reads++;
            throw new Error(marker);
        };

        const trap = (): never => {
            trapCalls++;
            throw new Error(marker);
        };

        const traps = {
            get: trap,
            ownKeys: trap,
            getPrototypeOf: trap,
            getOwnPropertyDescriptor: trap,
            has: trap,
        };
        const sparse = [row(7), row(8)];
        delete sparse[1];
        const inheritedIndex = [row(7), row(8)];
        delete inheritedIndex[1];
        const prototype = Object.create(Array.prototype);
        Object.defineProperty(prototype, '1', { get });
        Object.setPrototypeOf(inheritedIndex, prototype);
        const indexAccessor = [row(7), row(8)];
        Object.defineProperty(indexAccessor, '1', { enumerable: true, get });
        const inherited = Object.create({
            get nickname() {
                return get();
            },
        });
        Object.assign(inherited, { group_id: 42, user_id: 8, card: 'card' });
        const revoked = Proxy.revocable(row(8), traps);
        revoked.revoke();
        const cases: unknown[] = [
            ...['status', 'retcode', 'data'].map((key) => accessor(ok([row(7)]), key, get)),
            ...['group_id', 'user_id', 'nickname', 'card'].map((key) =>
                ok([row(7), accessor(row(8), key, get)]),
            ),
            ok([row(7), inherited]),
            ok(sparse),
            ok(inheritedIndex),
            ok(indexAccessor),
            ok(new Proxy([row(7)], traps)),
            ok([row(7), new Proxy(row(8), traps)]),
            ok([row(7), revoked.proxy]),
        ];

        for (const action of actions) {
            for (const envelope of cases) {
                const f = setup(async () => envelope);
                failure(await f.subject.handle(request(action, undefined, { echo: 'e' })), 20001);
                expectListCall(f);
            }
        }

        expect(reads).toBe(0);
        expect(trapCalls).toBe(0);
    });

    it('separates outer Promise then assimilation from post-await proxy checks', async () => {
        for (const action of actions) {
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
            });
            const f = setup(async () => proxy);
            failure(await f.subject.handle(request(action, undefined, { echo: 'e' })), 20001);
            expect(thenReads).toBeGreaterThan(0);
            expect(otherTraps).toBe(0);
            expectListCall(f);

            let reads = 0;
            const envelope = ok([]);
            Object.defineProperty(envelope, 'then', {
                get() {
                    reads++;
                    throw new Error(marker);
                },
            });
            const rejected = setup(async () => envelope);
            failure(
                await rejected.subject.handle(request(action, undefined, { echo: 'e' })),
                20002,
            );
            expect(reads).toBe(1);
            expectListCall(rejected);
        }
    });
});

describe('SDK and real v11 ApiHandler over in-memory fake providers', () => {
    it('round-trips both actions through fake fetch, routing each to one v11 list call', async () => {
        const rows = [row(7, '', 'card'), row(8, 'other', '')];
        const original = rows.map((item) => ({ ...item }));
        const getGroupMemberList = vi.fn(async () => rows);
        const getGroupMemberInfo = vi.fn(async () => row(7, 'must-not-be-called', ''));
        const api = new ApiHandler({
            getGroupMemberList,
            getGroupMemberInfo,
        } as unknown as ApiActionContext);
        const handle = vi.spyOn(api, 'handle');
        const { subject } = dispatcher(api);
        const url = 'http://fixture.invalid/';
        const seen: unknown[] = [];
        const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(input).toBe(url);
            expect(init?.method).toBe('POST');
            expect(init?.redirect).toBe('error');
            expect(init?.headers).toBeInstanceOf(Headers);
            expect((init?.headers as Headers).get('content-type')).toBe('application/json');
            expect((init?.headers as Headers).get('accept')).toBe('application/json');
            const body = JSON.parse(init?.body as string);
            seen.push(body);
            return new Response(JSON.stringify(await subject.handle(body)), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });
        const client = new OneBot12HttpClient({ baseUrl: url, fetch: fakeFetch });
        expect(await client.request(list, { group_id: '42' }, { self: selfA, echo: '' })).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: '',
            data: [mapped(7, '', 'card'), mapped(8, 'other', '')],
        });
        expect(
            await client.request(
                info,
                { group_id: '42', user_id: '7' },
                { self: selfA, echo: 'i' },
            ),
        ).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: 'i',
            data: mapped(7, '', 'card'),
        });
        expect(seen).toEqual([
            { action: list, params: { group_id: '42' }, self: selfA, echo: '' },
            { action: info, params: { group_id: '42', user_id: '7' }, self: selfA, echo: 'i' },
        ]);
        expect(fakeFetch).toHaveBeenCalledTimes(2);
        expect(handle).toHaveBeenCalledTimes(2);
        expect(handle).toHaveBeenNthCalledWith(1, list, { group_id: 42 });
        expect(handle).toHaveBeenNthCalledWith(2, list, { group_id: 42 });
        expect(getGroupMemberList).toHaveBeenCalledTimes(2);
        expect(getGroupMemberList).toHaveBeenNthCalledWith(1, 42, false);
        expect(getGroupMemberList).toHaveBeenNthCalledWith(2, 42, false);
        expect(getGroupMemberInfo).not.toHaveBeenCalled();
        expect(rows).toEqual(original);
    });

    it('keeps v11 list and synthetic v11 info fallback unchanged, while v12 info does not use it', async () => {
        const rows = [row(8, 'source', 'original')];
        const getGroupMemberList = vi.fn(async () => rows);
        const getGroupMemberInfo = vi.fn(async () => null);
        const api = new ApiHandler({
            getGroupMemberList,
            getGroupMemberInfo,
        } as unknown as ApiActionContext);
        expect(await api.handle(list, { group_id: 42, no_cache: true })).toEqual({
            status: 'ok',
            retcode: 0,
            data: rows,
        });
        expect(getGroupMemberList).toHaveBeenCalledExactlyOnceWith(42, true);
        const fallback = await api.handle(info, { group_id: 42, user_id: 7 });
        expect(fallback).toEqual({
            status: 'ok',
            retcode: 0,
            data: {
                group_id: 42,
                user_id: 7,
                nickname: '',
                card: '',
                is_robot: false,
                sex: 'unknown',
                age: 0,
                join_time: 0,
                last_sent_time: 0,
                shut_up_timestamp: 0,
                level: '0',
                role: 'member',
                title: '',
                qidian_master_flag: 0,
                qidian_crew_flag: 0,
                qidian_crew_flag_2: 0,
            },
        });
        expect(getGroupMemberInfo).toHaveBeenCalledExactlyOnceWith(42, 7, false);
        getGroupMemberList.mockClear();
        getGroupMemberInfo.mockClear();
        const handle = vi.spyOn(api, 'handle');
        const { subject } = dispatcher(api);
        failure(await subject.handle(request(info, undefined, { echo: 'e' })), 35000);
        expect(handle).toHaveBeenCalledExactlyOnceWith(list, { group_id: 42 });
        expect(getGroupMemberList).toHaveBeenCalledExactlyOnceWith(42, false);
        expect(getGroupMemberInfo).not.toHaveBeenCalled();

        const absent = new ApiHandler({} as ApiActionContext);
        const absentHandle = vi.spyOn(absent, 'handle');
        const empty = dispatcher(absent).subject;
        expect((await empty.handle(request(list))).data).toEqual([]);
        failure(await empty.handle(request(info, undefined, { echo: 'e' })), 35000);
        expect(absentHandle).toHaveBeenCalledTimes(2);
        expect(absentHandle).toHaveBeenNthCalledWith(1, list, { group_id: 42 });
        expect(absentHandle).toHaveBeenNthCalledWith(2, list, { group_id: 42 });
    });
});
