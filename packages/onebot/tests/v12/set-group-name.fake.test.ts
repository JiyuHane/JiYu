import { describe, expect, it, vi } from 'vitest';
import { ApiHandler, type ApiActionContext } from '../../src/api-handler';
import { V12Dispatcher } from '../../src/v12/dispatcher';
import type { V11ActionHandler, V12CoreOptions } from '../../src/v12/types';

const self = { platform: 'qq', user_id: '10001' };
const request = (params: unknown, extra: object = {}) => ({
    action: 'set_group_name',
    params,
    ...extra,
});
const valid = { group_id: '42', group_name: 'fixture' };
const ok = () => ({ status: 'ok', retcode: 0, data: null });

function setup(handler: (action: string, params: unknown) => Promise<unknown>) {
    const handle = vi.fn(handler);
    const getStatus = vi.fn(() => ({ good: true, online: true }));
    const options: V12CoreOptions = {
        self,
        version: { impl: 'jiyu', version: '1.0' },
        api: { handle } as unknown as V11ActionHandler,
        getStatus,
        getSentMessageTime: () => null,
    };
    return { dispatcher: new V12Dispatcher(options), handle, getStatus };
}

function expectUncertain(
    result: { status: string; retcode: number; data: unknown; message: string },
    code: number,
) {
    expect(result).toMatchObject({ status: 'failed', retcode: code, data: null });
    expect(result.message).toMatch(/outcome (?:may be uncertain|unavailable)/);
    expect(result.message).toContain('do not retry automatically');
    expect(JSON.stringify(result)).not.toContain('sensitive-marker');
}

describe('v12 set_group_name with synthetic v11 responses', () => {
    it('forwards canonical IDs, exact names, self and echo once per request', async () => {
        for (const [group_id, group_name, echo] of [
            ['42', 'fixture', 'reply'],
            ['1', '', ''],
            ['9007199254740991', ' 群🪶e\u0301 ', 'unicode'],
        ] as const) {
            const { dispatcher, handle, getStatus } = setup(async () => ok());
            expect(
                await dispatcher.handle(request({ group_id, group_name }, { self, echo })),
            ).toEqual({
                status: 'ok',
                retcode: 0,
                data: null,
                message: '',
                echo,
            });
            expect(handle).toHaveBeenCalledExactlyOnceWith('set_group_name', {
                group_id: Number(group_id),
                group_name,
            });
            expect(getStatus).not.toHaveBeenCalled();
        }

        const { dispatcher } = setup(async () => ok());
        expect(await dispatcher.handle(request(valid))).not.toHaveProperty('echo');
    });

    it('rejects noncanonical, unsafe or non-string group IDs before effects', async () => {
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
            '9007199254740992',
            '99999999999999999999999',
            42,
            null,
            true,
        ]) {
            expect(
                await dispatcher.handle(request({ group_id, group_name: 'x' }, { echo: '' })),
            ).toMatchObject({
                status: 'failed',
                retcode: 10003,
                echo: '',
            });
        }

        expect((await dispatcher.handle(request({ group_name: 'x' }))).retcode).toBe(10003);
        expect(handle).not.toHaveBeenCalled();
    });

    it('rejects non-string or missing names and unknown parameters before effects', async () => {
        const { dispatcher, handle } = setup(async () => ok());

        for (const group_name of [42, false, null, {}, []]) {
            expect((await dispatcher.handle(request({ group_id: '42', group_name }))).retcode).toBe(
                10003,
            );
        }

        expect((await dispatcher.handle(request({ group_id: '42' }))).retcode).toBe(10003);
        expect(
            await dispatcher.handle(request({ ...valid, extra: false }, { echo: '' })),
        ).toMatchObject({
            status: 'failed',
            retcode: 10004,
            echo: '',
        });
        expect(handle).not.toHaveBeenCalled();
    });

    it('rejects a different self during preflight and retains empty echo', async () => {
        const { dispatcher, handle } = setup(async () => ok());

        for (const other of [
            { ...self, user_id: '10002' },
            { ...self, platform: 'other' },
        ]) {
            expect(
                await dispatcher.handle(request(valid, { self: other, echo: '' })),
            ).toMatchObject({
                status: 'failed',
                retcode: 10102,
                echo: '',
            });
        }

        expect(handle).not.toHaveBeenCalled();
    });

    it('fails conservatively for failed, contradictory, missing or malformed envelopes', async () => {
        const cases: Array<[unknown, number]> = [
            [{ status: 'failed', retcode: 1400, data: null, wording: 'sensitive-marker' }, 10003],
            [{ status: 'failed', retcode: 1404, data: null }, 20001],
            [{ status: 'failed', retcode: 100, data: null }, 20002],
            [{ status: 'failed', retcode: 0, data: null }, 20001],
            [{ status: 'failed', retcode: -1, data: null }, 20001],
            [{ status: 'failed', retcode: NaN, data: null }, 20001],
            [{ status: 'failed', retcode: Infinity, data: null }, 20001],
            [{ status: 'ok', retcode: 100, data: null }, 20001],
            [{ status: 'ok', retcode: 0 }, 20001],
            [{ status: 'ok', retcode: 0, data: undefined }, 20001],
            [Object.assign(Object.create({ data: null }), { status: 'ok', retcode: 0 }), 20001],
            [{ status: 'ok', retcode: 0, data: {} }, 20001],
            [{ status: 'ok', retcode: 0, data: false }, 20001],
            [{ status: 'ok', data: null }, 20001],
            [{ retcode: 0, data: null }, 20001],
            [Object.create({ status: 'ok', retcode: 0, data: null }), 20001],
            [null, 20001],
            [[], 20001],
        ];

        for (const [envelope, code] of cases) {
            const { dispatcher, handle } = setup(async () => envelope);
            const result = await dispatcher.handle(request(valid, { echo: '' }));
            expectUncertain(result, code);
            expect(result.echo).toBe('');
            expect(handle).toHaveBeenCalledExactlyOnceWith('set_group_name', {
                group_id: 42,
                group_name: 'fixture',
            });
        }
    });

    it('reports a thrown v11 error as an uncertain outcome without retry or leakage', async () => {
        const { dispatcher, handle } = setup(async () => {
            throw new Error('sensitive-marker');
        });
        const result = await dispatcher.handle(request(valid, { echo: '' }));
        expectUncertain(result, 20002);
        expect(result.echo).toBe('');
        expect(handle).toHaveBeenCalledTimes(1);
    });

    it('never reads response status, retcode, or data getters and does not retry', async () => {
        let getterCalls = 0;

        for (const key of ['status', 'retcode', 'data']) {
            const envelope = ok();
            Object.defineProperty(envelope, key, {
                enumerable: true,
                get() {
                    getterCalls++;
                    throw new Error('sensitive-marker');
                },
            });
            const { dispatcher, handle } = setup(async () => envelope);
            expectUncertain(await dispatcher.handle(request(valid)), 20001);
            expect(handle).toHaveBeenCalledTimes(1);
        }

        expect(getterCalls).toBe(0);
    });

    it('rejects proxy replies without post-await traps; Promise resolution necessarily reads then', async () => {
        let thenReads = 0;
        let otherTraps = 0;
        const envelope = new Proxy(ok(), {
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
            ownKeys() {
                otherTraps++;
                throw new Error('sensitive-marker');
            },
            getPrototypeOf() {
                otherTraps++;
                throw new Error('sensitive-marker');
            },
        });
        const { dispatcher, handle } = setup(async () => envelope);
        expectUncertain(await dispatcher.handle(request(valid)), 20001);
        expect(handle).toHaveBeenCalledTimes(1);
        expect(thenReads).toBeGreaterThan(0);
        expect(otherTraps).toBe(0);
    });

    it('reports a throwing then getter without leaking it or retrying the v11 action', async () => {
        let thenReads = 0;
        const envelope = ok();
        Object.defineProperty(envelope, 'then', {
            get() {
                thenReads++;
                throw new Error('sensitive-marker');
            },
        });
        const { dispatcher, handle } = setup(async () => envelope);
        const result = await dispatcher.handle(request(valid, { echo: '' }));
        expectUncertain(result, 20002);
        expect(result.echo).toBe('');
        expect(thenReads).toBe(1);
        expect(handle).toHaveBeenCalledTimes(1);
    });

    it('rejects non-finite request numbers during snapshot before any v11 call', async () => {
        const { dispatcher, handle } = setup(async () => ok());

        for (const value of [NaN, Infinity, -Infinity]) {
            for (const key of ['group_id', 'group_name']) {
                const result = await dispatcher.handle(
                    request({ ...valid, [key]: value }, { echo: '' }),
                );
                expect(result).toMatchObject({ status: 'failed', retcode: 10001, echo: '' });
            }
        }

        for (const extra of [undefined, NaN, Infinity]) {
            expect(
                await dispatcher.handle(request({ ...valid, extra }, { echo: '' })),
            ).toMatchObject({
                status: 'failed',
                retcode: 10001,
                echo: '',
            });
        }

        expect(handle).not.toHaveBeenCalled();
    });

    it('routes through the real v11 handler to a fake group-admin method', async () => {
        const setName = vi.fn(async (_groupId: number, _name: string): Promise<void> => {});
        const context = {
            bridge: { apis: { groupAdmin: { setName } } },
        } as unknown as ApiActionContext;
        const api = new ApiHandler(context);
        const handle = vi.spyOn(api, 'handle');
        const dispatcher = new V12Dispatcher({
            self,
            version: { impl: 'jiyu', version: '1.0' },
            api,
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
        });

        expect(await dispatcher.handle(request(valid, { echo: '' }))).toEqual({
            status: 'ok',
            retcode: 0,
            data: null,
            message: '',
            echo: '',
        });
        expect(handle).toHaveBeenCalledExactlyOnceWith('set_group_name', {
            group_id: 42,
            group_name: 'fixture',
        });
        expect(setName).toHaveBeenCalledExactlyOnceWith(42, 'fixture');
        await expect(handle.mock.results[0]!.value).resolves.toEqual({
            status: 'ok',
            retcode: 0,
            data: null,
        });

        setName.mockRejectedValueOnce(new Error('sensitive-marker'));
        const result = await dispatcher.handle(request(valid, { echo: '' }));
        expectUncertain(result, 20002);
        expect(result.echo).toBe('');
        expect(handle).toHaveBeenCalledTimes(2);
        expect(setName).toHaveBeenCalledTimes(2);
        await expect(handle.mock.results[1]!.value).resolves.toMatchObject({
            status: 'failed',
            data: null,
        });
    });

    it('consumes an ordinary prepared token at most once, even for concurrent callers', async () => {
        const { dispatcher, handle } = setup(async () => ok());
        const prepared = dispatcher
            .createInternalHttpPreflight()
            .classify(request(valid, { echo: '' }));
        expect(prepared.kind).toBe('ordinary');

        if (prepared.kind !== 'ordinary') {
            throw new Error('expected ordinary token');
        }

        const [first, second] = await Promise.all([
            dispatcher.handlePreparedOrdinary(prepared.token),
            dispatcher.handlePreparedOrdinary(prepared.token),
        ]);
        expect(first).toEqual({ status: 'ok', retcode: 0, data: null, message: '', echo: '' });
        expect(second).toMatchObject({ status: 'failed', retcode: 10001 });
        expect(handle).toHaveBeenCalledExactlyOnceWith('set_group_name', {
            group_id: 42,
            group_name: 'fixture',
        });
    });
});
