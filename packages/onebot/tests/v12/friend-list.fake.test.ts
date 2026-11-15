import { describe, expect, it, vi } from 'vitest';
import { ApiHandler, type ApiActionContext } from '../../src/api-handler';
import { V12Dispatcher } from '../../src/v12/dispatcher';
import type { V11ActionHandler, V12CoreOptions } from '../../src/v12/types';

// The real v11 roster may fall back to a cached roster and append device pseudo-contacts.
// These fixtures exercise neither that implementation nor a real QQ account.
const selfA = { platform: 'qq', user_id: '10001' };
const selfB = { platform: 'qq', user_id: '10002' };
const row = (user_id = 42, nickname = 'name', remark = 'note') => ({ user_id, nickname, remark });
const ok = (data: unknown) => ({ status: 'ok', retcode: 0, data });
const request = (params: unknown = {}, extra: object = {}) => ({
    action: 'get_friend_list',
    params,
    ...extra,
});
const mapped = (user_id: number, user_name: string, user_remark: string) => ({
    user_id: String(user_id),
    user_name,
    user_displayname: '',
    user_remark,
});

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

function failure(
    result: { status: string; retcode: number; data: unknown; message: string; echo?: string },
    code: number,
    echo = 'e',
) {
    expect(result).toMatchObject({ status: 'failed', retcode: code, data: null, echo });
    expect(JSON.stringify(result)).not.toContain('sensitive-marker');
}

function accessor(value: object, key: string, get: () => never): object {
    const result = { ...value };
    Object.defineProperty(result, key, { enumerable: true, get });
    return result;
}

describe('v12 get_friend_list: synthetic v11 handler', () => {
    it('keeps order, duplicates, empty names and per-instance accounts with exact echo', async () => {
        const a = setup(async () =>
            ok([
                row(9, '', ''),
                row(2, '🪶', ' x '),
                row(9, 'again', ''),
                row(10001, 'self row', ''),
            ]),
        );
        const b = setup(async () => ok([row(3, 'other', 'B')]), selfB);
        const [ra, rb] = await Promise.all([
            a.dispatcher.handle(request({}, { self: selfA, echo: '' })),
            b.dispatcher.handle(request({}, { self: selfB, echo: 'b' })),
        ]);
        expect(ra).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: '',
            data: [
                mapped(9, '', ''),
                mapped(2, '🪶', ' x '),
                mapped(9, 'again', ''),
                mapped(10001, 'self row', ''),
            ],
        });
        expect(rb).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: 'b',
            data: [mapped(3, 'other', 'B')],
        });

        for (const fixture of [a, b]) {
            expect(fixture.handle).toHaveBeenCalledExactlyOnceWith('get_friend_list', {});
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
    });

    it('ignores all extra result properties without touching extra getters', async () => {
        let reads = 0;

        const extra = () => {
            reads++;
            throw new Error('sensitive-marker');
        };

        const friend = Object.assign(row(Number.MAX_SAFE_INTEGER, '', 'r'), { sex: 'x' });
        Object.defineProperty(friend, 'extra', { enumerable: true, get: extra });
        const envelope = ok([friend]);
        Object.defineProperty(envelope, 'extra', { enumerable: true, get: extra });
        const f = setup(async () => envelope);
        expect((await f.dispatcher.handle(request({}, { echo: 'e' }))).data).toEqual([
            mapped(Number.MAX_SAFE_INTEGER, '', 'r'),
        ]);
        expect(reads).toBe(0);
        expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_friend_list', {});
    });

    it('rejects unsupported params, malformed snapshot and wrong or invalid self before effects', async () => {
        const f = setup(async () => ok([]));
        const cases: Array<[unknown, number]> = [
            [request({ with_profile: false }, { echo: '' }), 10004],
            [request({ extra: 1 }, { echo: '' }), 10004],
            [request({ extra: undefined }, { echo: '' }), 10001],
            [request({ extra: NaN }, { echo: '' }), 10001],
            [request(null, { echo: '' }), 10001],
            [{ action: 'get_friend_list', echo: '' }, 10001],
            [request({}, { self: { platform: 'qq', user_id: 1 }, echo: '' }), 10001],
            [request({}, { self: selfB, echo: '' }), 10102],
            [request({ extra: 1 }, { self: selfB, echo: '' }), 10102],
            [request({}, { self: { ...selfA, platform: 'other' }, echo: '' }), 10102],
        ];

        for (const [input, code] of cases) {
            expect(await f.dispatcher.handle(input)).toMatchObject({
                status: 'failed',
                retcode: code,
                data: null,
                echo: '',
            });
        }

        expect(f.handle).not.toHaveBeenCalled();
    });

    it('classifies malformed envelopes and well-formed v11 failures without partial data or retry', async () => {
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
            [{ status: 'failed', retcode: 0 }, 20001],
            [{ status: 'failed', retcode: -1 }, 20001],
            [{ status: 'failed', retcode: NaN }, 20001],
            [{ status: 'failed', retcode: Infinity }, 20001],
            [{ status: 'failed', retcode: Number.MAX_SAFE_INTEGER + 1 }, 20001],
            [{ status: 'failed', retcode: 1400, wording: 'sensitive-marker' }, 20001],
            [{ status: 'failed', retcode: 1404, wording: 'sensitive-marker' }, 20001],
            [{ status: 'failed', retcode: 100, wording: 'sensitive-marker' }, 20002],
            [{ status: 'failed', retcode: 1200, wording: 'sensitive-marker' }, 20002],
        ];

        for (const [envelope, code] of cases) {
            const f = setup(async () => envelope);
            failure(await f.dispatcher.handle(request({}, { echo: 'e' })), code);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_friend_list', {});
        }

        const f = setup(async () => {
            throw new Error('sensitive-marker');
        });
        failure(await f.dispatcher.handle(request({}, { echo: 'e' })), 20002);
        expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_friend_list', {});
    });

    it('rejects each malformed row even after a valid row', async () => {
        const invalid: unknown[] = [
            null,
            [],
            1,
            'x',
            {},
            Object.create({ user_id: 42, nickname: 'n', remark: 'r' }),
            { nickname: 'n', remark: 'r' },
            { user_id: 1, remark: 'r' },
            { user_id: 1, nickname: 'n' },
            ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '42', null].map(
                (user_id) => ({ user_id, nickname: 'n', remark: 'r' }),
            ),
            ...[null, 1, false, {}, []].flatMap((value) => [
                { user_id: 1, nickname: value, remark: 'r' },
                { user_id: 1, nickname: 'n', remark: value },
            ]),
        ];

        for (const bad of invalid) {
            const f = setup(async () => ok([row(), bad]));
            failure(await f.dispatcher.handle(request({}, { echo: 'e' })), 20001);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_friend_list', {});
        }
    });

    it('enforces inclusive row and UTF-16 limits without returning a partial list', async () => {
        const many = Array.from({ length: 10000 }, (_, i) => row(i + 1, '', ''));
        const boundary = Array.from({ length: 128 }, (_, i) =>
            row(i + 1, 'x'.repeat(1024), '🪶'.repeat(512)),
        );

        for (const rows of [many, boundary, [row(1, '🪶'.repeat(512), '')]]) {
            const f = setup(async () => ok(rows));
            const result = await f.dispatcher.handle(request({}, { echo: 'e' }));
            expect(result).toMatchObject({ status: 'ok', retcode: 0, echo: 'e' });
            expect(result.data).toHaveLength(rows.length);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_friend_list', {});
        }

        for (const rows of [
            [...many, row()],
            [row(), row(2, 'x'.repeat(1025), '')],
            [row(), row(2, '', '🪶'.repeat(513))],
            [...boundary, row(129, 'x', '')],
        ]) {
            const f = setup(async () => ok(rows));
            failure(await f.dispatcher.handle(request({}, { echo: 'e' })), 20001);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_friend_list', {});
        }
    });

    it('does not assimilate a nested array or row with an extra then getter', async () => {
        let thenReads = 0;

        const get = () => {
            thenReads++;
            throw new Error('sensitive-marker');
        };

        const friend = row();
        Object.defineProperty(friend, 'then', { enumerable: true, get });
        const friends = [friend];
        Object.defineProperty(friends, 'then', { enumerable: true, get });
        const f = setup(async () => ok(friends));
        expect((await f.dispatcher.handle(request({}, { echo: 'e' }))).data).toEqual([
            mapped(42, 'name', 'note'),
        ]);
        expect(thenReads).toBe(0);
        expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_friend_list', {});
    });

    it('rejects sparse arrays, index accessors, required field accessors and nested proxies after await without traps', async () => {
        let reads = 0;
        let traps = 0;

        const get = (): never => {
            reads++;
            throw new Error('sensitive-marker');
        };

        const trap = (): never => {
            traps++;
            throw new Error('sensitive-marker');
        };

        const trapsFor = {
            get: trap,
            ownKeys: trap,
            getPrototypeOf: trap,
            getOwnPropertyDescriptor: trap,
            has: trap,
        };
        const sparse = [row(), row()];
        delete sparse[1];
        const indexAccessor = [row(), row()];
        Object.defineProperty(indexAccessor, '1', { enumerable: true, get });
        const inheritedIndex = [row(), row()];
        delete inheritedIndex[1];
        const prototype = Object.create(Array.prototype);
        Object.defineProperty(prototype, '1', { get });
        Object.setPrototypeOf(inheritedIndex, prototype);
        const inherited = Object.create({
            get nickname() {
                return get();
            },
        });
        Object.assign(inherited, { user_id: 1, remark: 'r' });
        const cases: unknown[] = [
            ...['status', 'retcode', 'data'].map((key) => accessor(ok([row()]), key, get)),
            ...['user_id', 'nickname', 'remark'].map((key) =>
                ok([row(), accessor(row(), key, get)]),
            ),
            ok([row(), inherited]),
            ok(sparse),
            ok(inheritedIndex),
            ok(indexAccessor),
            ok(new Proxy([row()], trapsFor)),
            ok([row(), new Proxy(row(), trapsFor)]),
        ];

        for (const envelope of cases) {
            // Only the outer plain envelope is resolved by the async handler. Nested
            // array and row proxies are not assimilated as promises.
            const f = setup(async () => envelope);
            failure(await f.dispatcher.handle(request({}, { echo: 'e' })), 20001);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_friend_list', {});
        }

        expect(reads).toBe(0);
        expect(traps).toBe(0);
    });

    it('separates outer Promise then assimilation from post-await proxy rejection', async () => {
        let thenReads = 0;
        let otherTraps = 0;
        const proxy = new Proxy(ok([row()]), {
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
            getPrototypeOf() {
                otherTraps++;
                throw new Error('sensitive-marker');
            },
            ownKeys() {
                otherTraps++;
                throw new Error('sensitive-marker');
            },
        });
        const f = setup(async () => proxy);
        failure(await f.dispatcher.handle(request({}, { echo: 'e' })), 20001);
        expect(thenReads).toBeGreaterThan(0);
        expect(otherTraps).toBe(0);
        expect(f.handle).toHaveBeenCalledExactlyOnceWith('get_friend_list', {});

        let throwingThen = 0;
        const envelope = ok([]);
        Object.defineProperty(envelope, 'then', {
            get() {
                throwingThen++;
                throw new Error('sensitive-marker');
            },
        });
        const rejected = setup(async () => envelope);
        failure(await rejected.dispatcher.handle(request({}, { echo: 'e' })), 20002);
        expect(throwingThen).toBe(1);
        expect(rejected.handle).toHaveBeenCalledExactlyOnceWith('get_friend_list', {});
    });

    it('routes through real ApiHandler to per-account fake contexts with default with_profile=false', async () => {
        const getFriendListA = vi.fn(async () => [row(3, '', ''), row(3, 'A', 'remark')]);
        const getFriendListB = vi.fn(async () => [row(8, 'B', '')]);
        const apiA = new ApiHandler({
            getFriendList: getFriendListA,
        } as unknown as ApiActionContext);
        const apiB = new ApiHandler({
            getFriendList: getFriendListB,
        } as unknown as ApiActionContext);
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
        const a = make(selfA, apiA);
        const b = make(selfB, apiB);
        const [ra, rb] = await Promise.all([
            a.handle(request({}, { self: selfA, echo: '' })),
            b.handle(request({}, { self: selfB, echo: 'b' })),
        ]);
        expect(ra).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: '',
            data: [mapped(3, '', ''), mapped(3, 'A', 'remark')],
        });
        expect(rb).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: 'b',
            data: [mapped(8, 'B', '')],
        });
        expect(handleA).toHaveBeenCalledExactlyOnceWith('get_friend_list', {});
        expect(handleB).toHaveBeenCalledExactlyOnceWith('get_friend_list', {});
        expect(getFriendListA).toHaveBeenCalledExactlyOnceWith(false);
        expect(getFriendListB).toHaveBeenCalledExactlyOnceWith(false);
        getFriendListA.mockRejectedValueOnce(new Error('sensitive-marker'));
        failure(await a.handle(request({}, { echo: 'e' })), 20002);
        expect(getFriendListA).toHaveBeenCalledTimes(2);
        expect(handleA).toHaveBeenCalledTimes(2);
    });
});
