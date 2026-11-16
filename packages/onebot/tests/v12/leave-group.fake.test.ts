import { describe, expect, it, vi } from 'vitest';
import { OneBot12HttpClient } from '../../../sdk/src/v12/http-client.js';
import { ApiHandler, type ApiActionContext } from '../../src/api-handler';
import { V12Dispatcher } from '../../src/v12/dispatcher';
import type { V11ActionHandler } from '../../src/v12/types';

const self = { platform: 'qq', user_id: '10001' };
const request = (params: unknown, extra: object = {}) => ({
    action: 'leave_group',
    params,
    ...extra,
});
const ok = () => ({ status: 'ok', retcode: 0, data: null });

function setup(handler: (action: string, params: unknown) => Promise<unknown>) {
    const handle = vi.fn(handler);
    const getStatus = vi.fn(() => ({ good: true, online: true }));
    const dispatcher = new V12Dispatcher({
        self,
        version: { impl: 'fixture', version: '1' },
        api: { handle } as unknown as V11ActionHandler,
        getStatus,
        getSentMessageTime: () => null,
    });
    return { dispatcher, handle, getStatus };
}

function expectUncertain(
    result: { status: string; retcode: number; data: unknown; message: string },
    code: number,
) {
    expect(result).toMatchObject({ status: 'failed', retcode: code, data: null });
    expect(result.message).toMatch(/outcome (?:may be uncertain|unavailable)/);
    expect(result.message).toContain('do not retry automatically');
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
}

describe('v12 leave_group with synthetic v11 handlers', () => {
    it('passes only a canonical numeric group ID once and preserves account and echo', async () => {
        for (const [groupId, echo] of [
            ['1', ''],
            ['42', 'fixture-echo'],
            ['4294967295', '🪶'],
        ] as const) {
            const { dispatcher, handle, getStatus } = setup(async () => ok());
            const result = await dispatcher.handle(request({ group_id: groupId }, { self, echo }));
            expect(result).toEqual({ status: 'ok', retcode: 0, data: null, message: '', echo });
            expect(handle).toHaveBeenCalledExactlyOnceWith('set_group_leave', {
                group_id: Number(groupId),
            });
            expect(getStatus).not.toHaveBeenCalled();
        }

        const { dispatcher } = setup(async () => ok());
        expect(await dispatcher.handle(request({ group_id: '42' }))).not.toHaveProperty('echo');
    });

    it('rejects invalid IDs and unsupported parameters before any handler call', async () => {
        const { dispatcher, handle } = setup(async () => ok());

        for (const group_id of [
            '',
            '0',
            '01',
            '+1',
            '-1',
            '1.0',
            '1e2',
            ' 42',
            '42 ',
            '4294967296',
            '9007199254740991',
            '9007199254740992',
            '99999999999999999999999',
            42,
            null,
            true,
            {},
            [],
        ]) {
            expect(await dispatcher.handle(request({ group_id }, { echo: '' }))).toEqual({
                status: 'failed',
                retcode: 10003,
                data: null,
                message: 'invalid group_id',
                echo: '',
            });
        }

        expect((await dispatcher.handle(request({}))).retcode).toBe(10003);

        for (const extra of [{ extra: true }, { is_dismiss: true }, { is_dismiss: false }]) {
            for (const group_id of ['42', '4294967296']) {
                expect(
                    await dispatcher.handle(request({ group_id, ...extra }, { echo: 'priority' })),
                ).toEqual({
                    status: 'failed',
                    retcode: 10004,
                    data: null,
                    message: 'unsupported parameter',
                    echo: 'priority',
                });
            }
        }

        expect(await dispatcher.handle(request({ group_id: '42' }, { extra: true }))).toMatchObject(
            {
                retcode: 10004,
                message: 'unsupported request field',
            },
        );
        expect(handle).not.toHaveBeenCalled();
    });

    it('applies shared self and JSON snapshot validation without calling the handler', async () => {
        const { dispatcher, handle } = setup(async () => ok());

        for (const other of [
            { platform: 'qq', user_id: '10002' },
            { platform: 'other', user_id: '10001' },
        ]) {
            expect(
                await dispatcher.handle(request({ group_id: '42' }, { self: other, echo: '' })),
            ).toMatchObject({ status: 'failed', retcode: 10102, echo: '' });
        }

        expect(
            await dispatcher.handle(
                request({ group_id: '42' }, { self: { platform: 'qq', user_id: 10001 }, echo: '' }),
            ),
        ).toMatchObject({ status: 'failed', retcode: 10001, echo: '' });

        for (const group_id of [undefined, NaN, Infinity, -Infinity]) {
            expect(await dispatcher.handle(request({ group_id }, { echo: '' }))).toMatchObject({
                status: 'failed',
                retcode: 10001,
                echo: '',
            });
        }

        expect(handle).not.toHaveBeenCalled();
    });

    it('uses a private snapshot and consumes an ordinary token before a pending effect settles', async () => {
        let release!: (value: { status: 'ok'; retcode: number; data: null }) => void;
        const pending = new Promise<{ status: 'ok'; retcode: number; data: null }>((resolve) => {
            release = resolve;
        });
        const { dispatcher, handle } = setup(() => pending);
        const input = {
            action: 'leave_group',
            params: { group_id: '42' },
            self: { ...self },
            echo: 'original',
        };
        const prepared = dispatcher.createInternalHttpPreflight().classify(input);
        expect(prepared.kind).toBe('ordinary');

        if (prepared.kind !== 'ordinary') {
            throw new Error('expected ordinary token');
        }

        input.params.group_id = '43';
        input.self.user_id = '10002';
        input.echo = 'changed';
        const first = dispatcher.handlePreparedOrdinary(prepared.token);
        const second = await dispatcher.handlePreparedOrdinary(prepared.token);
        expect(second).toMatchObject({ status: 'failed', retcode: 10001 });
        expect(handle).toHaveBeenCalledExactlyOnceWith('set_group_leave', { group_id: 42 });
        release({ status: 'ok', retcode: 0, data: null });
        expect(await first).toEqual({
            status: 'ok',
            retcode: 0,
            data: null,
            message: '',
            echo: 'original',
        });
        expect((await dispatcher.handlePreparedOrdinary(prepared.token)).retcode).toBe(10001);
        expect(handle).toHaveBeenCalledTimes(1);
    });

    it('maps failed and contradictory v11 envelopes to fixed uncertain results without retry', async () => {
        const cases: Array<[unknown, number]> = [
            [{ status: 'failed', retcode: 1400, data: null, wording: 'fixture-secret' }, 10003],
            [{ status: 'failed', retcode: 1404, data: null }, 20001],
            [{ status: 'failed', retcode: 100, data: null }, 20002],
            // Own defined data values are accepted for a failed envelope.
            [{ status: 'failed', retcode: 1400, data: undefined }, 20001],
            [{ status: 'failed', retcode: 1404, data: undefined }, 20001],
            [{ status: 'failed', retcode: 100, data: undefined }, 20001],
            [{ status: 'failed', retcode: 1400, data: false }, 10003],
            [{ status: 'failed', retcode: 1404, data: { detail: 'fixture-secret' } }, 20001],
            [{ status: 'failed', retcode: 100, data: 0 }, 20002],
            [{ status: 'failed', retcode: 100, data: 'fixture-secret' }, 20002],
            // Missing or inherited data is malformed before retcode mapping.
            [{ status: 'failed', retcode: 1400 }, 20001],
            [{ status: 'failed', retcode: 1404 }, 20001],
            [{ status: 'failed', retcode: 100 }, 20001],
            [
                Object.assign(Object.create({ data: null }), { status: 'failed', retcode: 1400 }),
                20001,
            ],
            [
                Object.assign(Object.create({ data: null }), { status: 'failed', retcode: 100 }),
                20001,
            ],
            [{ status: 'failed', retcode: 0, data: null }, 20001],
            [{ status: 'failed', retcode: -1, data: null }, 20001],
            [{ status: 'failed', retcode: NaN, data: null }, 20001],
            [{ status: 'failed', retcode: Infinity, data: null }, 20001],
            [{ status: 'ok', retcode: 100, data: null }, 20001],
            [{ status: 'ok', retcode: 0 }, 20001],
            [{ status: 'ok', retcode: 0, data: undefined }, 20001],
            [{ status: 'ok', retcode: 0, data: false }, 20001],
            [{ status: 'ok', retcode: 0, data: {} }, 20001],
            [Object.assign(Object.create({ data: null }), { status: 'ok', retcode: 0 }), 20001],
            [Object.create({ status: 'ok', retcode: 0, data: null }), 20001],
            [null, 20001],
            [[], 20001],
        ];

        for (const [envelope, code] of cases) {
            const { dispatcher, handle } = setup(async () => envelope);
            const result = await dispatcher.handle(request({ group_id: '42' }, { echo: '' }));
            expectUncertain(result, code);
            expect(result.echo).toBe('');
            expect(handle).toHaveBeenCalledExactlyOnceWith('set_group_leave', { group_id: 42 });
        }
    });

    it('does not replay a synthetic effect when the handler throws afterward', async () => {
        const effects: string[] = [];
        const { dispatcher, handle } = setup(async () => {
            effects.push('synthetic-effect');
            throw new Error('fixture-secret');
        });
        expect(await dispatcher.handle(request({ group_id: '42' }, { echo: '' }))).toEqual({
            status: 'failed',
            retcode: 20002,
            data: null,
            message: 'action outcome unavailable; do not retry automatically',
            echo: '',
        });
        expect(handle).toHaveBeenCalledExactlyOnceWith('set_group_leave', { group_id: 42 });
        expect(effects).toEqual(['synthetic-effect']);
    });

    it('keeps defined failed data opaque without traversing nested getters or proxies', async () => {
        let nestedReads = 0;
        const data = {};
        Object.defineProperty(data, 'detail', {
            enumerable: true,
            get() {
                nestedReads++;
                throw new Error('fixture-secret');
            },
        });

        const trap = () => {
            nestedReads++;
            throw new Error('fixture-secret');
        };

        const nestedProxy = new Proxy(
            {},
            { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap },
        );

        for (const opaque of [data, nestedProxy]) {
            for (const [retcode, expected] of [
                [1400, 10003],
                [1404, 20001],
                [100, 20002],
            ] as const) {
                const { dispatcher, handle } = setup(async () => ({
                    status: 'failed',
                    retcode,
                    data: opaque,
                }));
                const result = await dispatcher.handle(request({ group_id: '42' }, { echo: '' }));
                expectUncertain(result, expected);
                expect(result.echo).toBe('');
                expect(handle).toHaveBeenCalledExactlyOnceWith('set_group_leave', { group_id: 42 });
            }
        }

        expect(nestedReads).toBe(0);
    });

    it('does not inspect response accessors, proxy traps or leak thrown thenables', async () => {
        let getters = 0;

        for (const key of ['status', 'retcode', 'data']) {
            const envelope = ok();
            Object.defineProperty(envelope, key, {
                enumerable: true,
                get() {
                    getters++;
                    throw new Error('fixture-secret');
                },
            });
            const { dispatcher, handle } = setup(async () => envelope);
            expectUncertain(await dispatcher.handle(request({ group_id: '42' })), 20001);
            expect(handle).toHaveBeenCalledTimes(1);
        }

        // A failed envelope also requires own data, but its accessor is not invoked.
        for (const retcode of [1400, 1404, 100]) {
            const failure = { status: 'failed', retcode };
            Object.defineProperty(failure, 'data', {
                get() {
                    getters++;
                    throw new Error('fixture-secret');
                },
            });
            const failed = setup(async () => failure);
            const result = await failed.dispatcher.handle(
                request({ group_id: '42' }, { echo: '' }),
            );
            expectUncertain(result, 20001);
            expect(result.echo).toBe('');
            expect(failed.handle).toHaveBeenCalledExactlyOnceWith('set_group_leave', {
                group_id: 42,
            });
        }

        let thenReads = 0;
        let otherTraps = 0;
        const proxy = new Proxy(ok(), {
            get(_target, key) {
                if (key === 'then') {
                    thenReads++;
                    return undefined;
                }

                otherTraps++;
                throw new Error('fixture-secret');
            },
            getOwnPropertyDescriptor() {
                otherTraps++;
                throw new Error('fixture-secret');
            },
            ownKeys() {
                otherTraps++;
                throw new Error('fixture-secret');
            },
        });
        const proxied = setup(async () => proxy);
        expectUncertain(await proxied.dispatcher.handle(request({ group_id: '42' })), 20001);
        expect(proxied.handle).toHaveBeenCalledTimes(1);
        expect(thenReads).toBeGreaterThan(0);
        expect(otherTraps).toBe(0);

        let throwingThenReads = 0;
        const thenable = ok();
        Object.defineProperty(thenable, 'then', {
            get() {
                throwingThenReads++;
                throw new Error('fixture-secret');
            },
        });
        const throwsThen = setup(async () => thenable);
        expectUncertain(await throwsThen.dispatcher.handle(request({ group_id: '42' })), 20002);
        expect(throwsThen.handle).toHaveBeenCalledTimes(1);
        expect(throwingThenReads).toBe(1);

        const throws = setup(async () => {
            throw new Error('fixture-secret');
        });
        expectUncertain(await throws.dispatcher.handle(request({ group_id: '42' })), 20002);
        expect(throws.handle).toHaveBeenCalledTimes(1);
        expect(getters).toBe(0);
    });
});

describe('v12 leave_group through real ApiHandler and fake SDK transport', () => {
    it('forwards success and failure through the in-memory HTTP client once per request', async () => {
        const leave = vi.fn(async (_groupId: number): Promise<void> => {});
        const api = new ApiHandler({
            bridge: { apis: { groupAdmin: { leave } } },
        } as unknown as ApiActionContext);
        const handle = vi.spyOn(api, 'handle');
        const dispatcher = new V12Dispatcher({
            self,
            version: { impl: 'fixture', version: '1' },
            api,
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
        });
        const seen: unknown[] = [];
        const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            if (typeof init?.body !== 'string') {
                throw new Error('expected JSON body');
            }

            const body: unknown = JSON.parse(init.body);
            seen.push(body);
            const response = await dispatcher.handle(body);
            return new Response(JSON.stringify(response), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });
        const client = new OneBot12HttpClient({
            baseUrl: 'http://fixture.invalid/',
            fetch: fakeFetch,
        });

        expect(
            await client.request('leave_group', { group_id: '42' }, { self, echo: 'fixture-echo' }),
        ).toEqual({
            status: 'ok',
            retcode: 0,
            data: null,
            message: '',
            echo: 'fixture-echo',
        });
        expect(seen).toEqual([request({ group_id: '42' }, { self, echo: 'fixture-echo' })]);
        expect(fakeFetch).toHaveBeenCalledTimes(1);
        expect(handle).toHaveBeenCalledExactlyOnceWith('set_group_leave', { group_id: 42 });
        expect(leave).toHaveBeenCalledExactlyOnceWith(42);

        leave.mockRejectedValueOnce(new Error('fixture-secret'));
        const failure = await client.request(
            'leave_group',
            { group_id: '43' },
            { self, echo: 'failed-echo' },
        );
        expectUncertain(failure, 20002);
        expect(failure.echo).toBe('failed-echo');
        expect(fakeFetch).toHaveBeenCalledTimes(2);
        expect(handle.mock.calls).toEqual([
            ['set_group_leave', { group_id: 42 }],
            ['set_group_leave', { group_id: 43 }],
        ]);
        expect(leave.mock.calls).toEqual([[42], [43]]);
        handle.mockRestore();
    });

    it('does not retry after an aborted caller while an uncooperative fake effect is pending', async () => {
        let signalEntered!: () => void;
        let release!: () => void;
        let signalFetchDone!: () => void;
        const entered = new Promise<void>((resolve) => {
            signalEntered = resolve;
        });
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const fetchDone = new Promise<void>((resolve) => {
            signalFetchDone = resolve;
        });
        const leave = vi.fn(async (_groupId: number) => {
            signalEntered();
            await pending;
        });
        const api = new ApiHandler({
            bridge: { apis: { groupAdmin: { leave } } },
        } as unknown as ApiActionContext);
        const handle = vi.spyOn(api, 'handle');
        const dispatcher = new V12Dispatcher({
            self,
            version: { impl: 'fixture', version: '1' },
            api,
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
        });
        const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            if (typeof init?.body !== 'string') {
                throw new Error('expected JSON body');
            }

            // Deliberately ignore the signal until the already-started fake effect settles.
            const response = await dispatcher.handle(JSON.parse(init.body));
            const result = new Response(JSON.stringify(response), { status: 200 });
            signalFetchDone();
            return result;
        });
        const client = new OneBot12HttpClient({
            baseUrl: 'http://fixture.invalid/',
            fetch: fakeFetch,
        });
        const controller = new AbortController();
        const result = client.request(
            'leave_group',
            { group_id: '42' },
            { echo: 'pending', signal: controller.signal },
        );
        await Promise.race([
            entered,
            result.then(
                () => {
                    throw new Error('request completed before the fake effect was entered');
                },
                () => {
                    throw new Error('request failed before the fake effect was entered');
                },
            ),
        ]);

        try {
            const rejected = expect(result).rejects.toMatchObject({ code: 'aborted' });
            controller.abort();
            await rejected;
            expect(fakeFetch).toHaveBeenCalledTimes(1);
            expect(handle).toHaveBeenCalledExactlyOnceWith('set_group_leave', { group_id: 42 });
            expect(leave).toHaveBeenCalledExactlyOnceWith(42);
        } finally {
            release();
        }

        await fetchDone;
        await Promise.resolve();
        expect(fakeFetch).toHaveBeenCalledTimes(1);
        expect(handle).toHaveBeenCalledTimes(1);
        expect(leave).toHaveBeenCalledTimes(1);
        handle.mockRestore();
    });
});
