import { describe, expect, it, vi } from 'vitest';
import { ApiHandler, type ApiActionContext } from '../../src/api-handler';
import { V12Dispatcher } from '../../src/v12/dispatcher';
import type { V11ActionHandler } from '../../src/v12/types';

const self = { platform: 'qq', user_id: '10001' };
const request = { action: 'delete_message', params: { message_id: '-123' }, self, echo: '' };
const ok = () => ({ status: 'ok', retcode: 0, data: null });
const unknownMessage = 'action outcome unavailable; do not retry automatically';

function setup(makeResult: () => unknown) {
    const effects: string[] = [];
    const handle = vi.fn((_action: string, _params: unknown): Promise<unknown> => {
        effects.push('delete attempted');
        return Promise.resolve(makeResult());
    });
    const dispatcher = new V12Dispatcher({
        self,
        version: { impl: 'jiyu', version: '1.0' },
        api: { handle } as unknown as V11ActionHandler,
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime: () => null,
    });
    return { dispatcher, effects, handle };
}

async function check(makeResult: () => unknown, code: number) {
    const { dispatcher, effects, handle } = setup(makeResult);
    const result = await dispatcher.handle(request);
    expect(handle).toHaveBeenCalledExactlyOnceWith('delete_msg', { message_id: -123 });
    expect(effects).toEqual(['delete attempted']);
    expect(result).toMatchObject({ status: 'failed', retcode: code, data: null, echo: '' });
    expect(result.message).toContain('do not retry automatically');
    expect(JSON.stringify(result)).not.toContain('sensitive-marker');
    return result;
}

describe('delete_message v11 envelope ownership', () => {
    it('preserves signed ID, valid self and empty echo in a successful response', async () => {
        const { dispatcher, handle, effects } = setup(ok);
        expect(await dispatcher.handle(request)).toEqual({
            status: 'ok',
            retcode: 0,
            data: null,
            message: '',
            echo: '',
        });
        expect(handle).toHaveBeenCalledExactlyOnceWith('delete_msg', { message_id: -123 });
        expect(effects).toEqual(['delete attempted']);
        const noEcho = await setup(ok).dispatcher.handle({
            action: request.action,
            params: request.params,
            self,
        });
        expect(noEcho).not.toHaveProperty('echo');
    });

    it('waits for the one backend effect before reporting an uncertain outcome', async () => {
        const events: string[] = [];
        let finish!: (value: unknown) => void;
        const pending = new Promise<unknown>((resolve) => {
            finish = resolve;
        });
        const { dispatcher, handle, effects } = setup(() => {
            events.push('backend effect');
            return pending;
        });
        const result = dispatcher.handle(request).then((value) => {
            events.push('response');
            return value;
        });
        expect(events).toEqual(['backend effect']);
        expect(effects).toEqual(['delete attempted']);
        expect(handle).toHaveBeenCalledExactlyOnceWith('delete_msg', { message_id: -123 });
        finish(Object.create({ status: 'ok', retcode: 0, data: null }));
        const response = await result;
        expect(events).toEqual(['backend effect', 'response']);
        expect(JSON.parse(JSON.stringify(response))).toEqual({
            status: 'failed',
            retcode: 20001,
            data: null,
            message: unknownMessage,
            echo: '',
        });
        expect(handle).toHaveBeenCalledTimes(1);
    });

    it.each([
        [1400, 10003],
        [1404, 20001],
        [100, 20002],
        [1200, 20002],
        [9999, 20002],
    ])('preserves failed retcode %i mapping to %i', async (retcode, expected) => {
        await check(() => ({ status: 'failed', retcode, wording: 'sensitive-marker' }), expected);
    });

    it.each([
        { status: 'failed', retcode: 0, data: null },
        { status: 'ok', retcode: 100, data: null },
        { status: 'failed', retcode: -1, data: null },
        { status: 'failed', retcode: NaN, data: null },
        { status: 'failed', retcode: Infinity, data: null },
        { status: 'ok', retcode: 0, data: {} },
        { status: 'ok', retcode: 0, data: false },
        { status: 'ok', retcode: 0, data: undefined },
        null,
        [],
        'ok',
    ])('rejects malformed or contradictory envelope %#', async (value) => {
        expect((await check(() => value, 20001)).message).toBe(unknownMessage);
    });

    for (const key of ['status', 'retcode', 'data'] as const) {
        it(`rejects missing ${key}`, async () => {
            const envelope: Partial<ReturnType<typeof ok>> = ok();
            delete envelope[key];
            await check(() => envelope, 20001);
        });

        it(`rejects inherited ${key}`, async () => {
            const own: Partial<ReturnType<typeof ok>> = ok();
            const inherited = { [key]: own[key] };
            delete own[key];
            await check(() => Object.assign(Object.create(inherited) as object, own), 20001);
        });

        it(`rejects accessor ${key} without executing it`, async () => {
            let reads = 0;
            const envelope = ok();
            Object.defineProperty(envelope, key, {
                get() {
                    reads++;
                    return key === 'status' ? 'ok' : key === 'retcode' ? 0 : null;
                },
            });
            await check(() => envelope, 20001);
            expect(reads).toBe(0);
        });
    }

    it('rejects inherited status and retcode on a failed response', async () => {
        for (const key of ['status', 'retcode'] as const) {
            const envelope: { status?: string; retcode?: number } = {
                status: 'failed',
                retcode: 1400,
            };
            const inherited = { [key]: envelope[key] };
            delete envelope[key];
            await check(() => Object.assign(Object.create(inherited) as object, envelope), 20001);
        }
    });

    it('rejects proxy after await without reading response fields or descriptor traps', async () => {
        let thenReads = 0;
        let otherTraps = 0;
        const proxy = new Proxy(ok(), {
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
        await check(() => proxy, 20001);
        expect(thenReads).toBeGreaterThan(0);
        expect(otherTraps).toBe(0);
    });

    it('reports synchronous throws and rejections once without leaking details', async () => {
        await check(() => {
            throw new Error('sensitive-marker');
        }, 20002);
        await check(() => Promise.reject(new Error('sensitive-marker')), 20002);
    });

    it('maps a throwing then getter to 20002 after the backend effect', async () => {
        let reads = 0;
        const envelope = ok();
        Object.defineProperty(envelope, 'then', {
            get() {
                reads++;
                throw new Error('sensitive-marker');
            },
        });
        await check(() => envelope, 20002);
        expect(reads).toBe(1);
    });

    it('runs v12 through the real v11 handler with fake delete effects', async () => {
        const meta = { sequenceAuthoritative: true, sequence: 42 };
        const getMessageMeta = vi.fn(async () => meta);
        const deleteMessage = vi.fn(async (_id: number, _meta: typeof meta): Promise<void> => {});
        const api = new ApiHandler({
            getMessageMeta,
            deleteMessage,
        } as unknown as ApiActionContext);
        const handle = vi.spyOn(api, 'handle');
        const dispatcher = new V12Dispatcher({
            self,
            version: { impl: 'jiyu', version: '1.0' },
            api,
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
        });

        expect(await dispatcher.handle(request)).toEqual({
            status: 'ok',
            retcode: 0,
            data: null,
            message: '',
            echo: '',
        });
        expect(handle).toHaveBeenCalledExactlyOnceWith('delete_msg', { message_id: -123 });
        expect(getMessageMeta).toHaveBeenCalledExactlyOnceWith(-123);
        expect(deleteMessage).toHaveBeenCalledExactlyOnceWith(-123, meta);
        await expect(handle.mock.results[0]!.value).resolves.toEqual({
            status: 'ok',
            retcode: 0,
            data: null,
        });

        deleteMessage.mockRejectedValueOnce(new Error('sensitive-marker'));
        const result = await dispatcher.handle(request);
        expect(result).toEqual({
            status: 'failed',
            retcode: 20002,
            data: null,
            message: unknownMessage,
            echo: '',
        });
        expect(JSON.stringify(result)).not.toContain('sensitive-marker');
        expect(handle).toHaveBeenCalledTimes(2);
        expect(handle).toHaveBeenNthCalledWith(2, 'delete_msg', { message_id: -123 });
        expect(getMessageMeta).toHaveBeenCalledTimes(2);
        expect(getMessageMeta).toHaveBeenNthCalledWith(2, -123);
        expect(deleteMessage).toHaveBeenCalledTimes(2);
        expect(deleteMessage).toHaveBeenNthCalledWith(2, -123, meta);
        await expect(handle.mock.results[1]!.value).resolves.toMatchObject({
            status: 'failed',
            retcode: 100,
            data: null,
        });
    });

    it('retains the real v11 delete response using fake message dependencies', async () => {
        const meta = { sequenceAuthoritative: true, sequence: 42 };
        const getMessageMeta = vi.fn(async () => meta);
        const deleteMessage = vi.fn(async () => {});
        const api = new ApiHandler({
            getMessageMeta,
            deleteMessage,
        } as unknown as ApiActionContext);
        expect(await api.handle('delete_msg', { message_id: -123 })).toEqual({
            status: 'ok',
            retcode: 0,
            data: null,
        });
        expect(getMessageMeta).toHaveBeenCalledExactlyOnceWith(-123);
        expect(deleteMessage).toHaveBeenCalledExactlyOnceWith(-123, meta);
    });
});
