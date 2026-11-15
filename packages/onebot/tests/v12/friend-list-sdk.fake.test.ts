import { afterEach, describe, expect, it, vi } from 'vitest';
import { OneBot12HttpClient } from '../../../sdk/src/v12/http-client.js';
import { ApiHandler, type ApiActionContext } from '../../src/api-handler';
import { V12Dispatcher } from '../../src/v12/dispatcher';

// All requests terminate at the injected fake fetch; no server is started.
// The real roster's cache fallback and device pseudo-contacts are not exercised.
afterEach(() => {
    vi.restoreAllMocks();
});

describe('v12 friend list through the SDK and an in-memory fake fetch', () => {
    it('uses the real client, dispatcher and v11 handler with one fake roster', async () => {
        const defaultFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            throw new Error('unexpected default fetch');
        });
        const self = { platform: 'qq', user_id: '10001' };
        const getFriendList = vi.fn(async () => [
            { user_id: 7, nickname: '', remark: 'fixture' },
            { user_id: 7, nickname: 'again', remark: '' },
        ]);
        const api = new ApiHandler({ getFriendList } as unknown as ApiActionContext);
        const handle = vi.spyOn(api, 'handle');
        const dispatcher = new V12Dispatcher({
            self,
            api,
            version: { impl: 'fixture', version: '1' },
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
        });
        const url = 'http://fixture.invalid/';
        const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(input).toBe(url);
            expect(init?.method).toBe('POST');
            expect(init?.redirect).toBe('error');
            expect(init?.headers).toBeInstanceOf(Headers);
            expect((init?.headers as Headers).get('content-type')).toBe('application/json');
            expect((init?.headers as Headers).get('accept')).toBe('application/json');
            expect(typeof init?.body).toBe('string');
            const body = JSON.parse(init!.body as string);
            expect(body).toEqual({ action: 'get_friend_list', params: {}, self, echo: '' });
            return new Response(JSON.stringify(await dispatcher.handle(body)), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });
        const client = new OneBot12HttpClient({ baseUrl: url, fetch: fakeFetch });
        expect(await client.request('get_friend_list', {}, { self, echo: '' })).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: '',
            data: [
                { user_id: '7', user_name: '', user_displayname: '', user_remark: 'fixture' },
                { user_id: '7', user_name: 'again', user_displayname: '', user_remark: '' },
            ],
        });
        expect(fakeFetch).toHaveBeenCalledOnce();
        expect(defaultFetch).not.toHaveBeenCalled();
        expect(handle).toHaveBeenCalledExactlyOnceWith('get_friend_list', {});
        expect(getFriendList).toHaveBeenCalledExactlyOnceWith(false);
    });
});
