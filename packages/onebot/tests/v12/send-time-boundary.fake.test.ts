import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OneBot12HttpClient } from '../../../sdk/src/v12/http-client.js';
import type { JsonObject } from '../../src/types';
import { V12Dispatcher } from '../../src/v12/dispatcher';
import type { V12Response, V12Self } from '../../src/v12/types';

// The SDK talks only to an injected in-memory fetch and synthetic action handler.
// These observations are not evidence of real message delivery or QQ timestamps.
const selfA: V12Self = { platform: 'qq', user_id: '10001' };
const selfB: V12Self = { platform: 'qq', user_id: '10002' };
const params = {
    detail_type: 'group',
    group_id: '44',
    message: [{ type: 'text', data: { text: 'synthetic' } }],
};
const v11Params = {
    group_id: 44,
    message: [{ type: 'text', data: { text: 'synthetic' } }],
    auto_escape: false,
};
const metadataUnavailable =
    'message sent but result metadata is unavailable; do not retry automatically';
const request = (self: V12Self, echo: string) => ({
    action: 'send_message',
    params,
    echo,
    self,
});

function success(id: number, time: number, echo: string) {
    return {
        status: 'ok',
        retcode: 0,
        data: { message_id: String(id), time },
        message: '',
        echo,
    };
}

function failure(retcode: number, echo: string) {
    return { status: 'failed', retcode, data: null, message: metadataUnavailable, echo };
}

function fixture(self: V12Self, id: number, time: () => number | null | Promise<number | null>) {
    const handle = vi.fn(async (_action: string, _params: JsonObject) => ({
        status: 'ok' as const,
        retcode: 0,
        data: { message_id: id },
    }));
    const getSentMessageTime = vi.fn((_id: number) => time());
    const dispatcher = new V12Dispatcher({
        self,
        version: { impl: 'fixture', version: '1' },
        api: { handle },
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime,
    });
    const requests: unknown[] = [];
    const responses: V12Response[] = [];
    const url = 'http://fixture.invalid/';
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (
            input !== url ||
            init?.method !== 'POST' ||
            init.redirect !== 'error' ||
            typeof init.body !== 'string' ||
            !(init.headers instanceof Headers) ||
            init.headers.get('content-type') !== 'application/json' ||
            init.headers.get('accept') !== 'application/json'
        ) {
            throw new Error('unexpected synthetic fetch envelope');
        }

        const body: unknown = JSON.parse(init.body);
        requests.push(body);
        const response = await dispatcher.handle(body);
        responses.push(response);
        return new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    });
    const client = new OneBot12HttpClient({ baseUrl: url, fetch: fakeFetch, requestTimeoutMs: 0 });
    return { client, fakeFetch, requests, responses, handle, getSentMessageTime };
}

function expectOneSend(f: ReturnType<typeof fixture>, self: V12Self, echo: string, id: number) {
    expect(f.fakeFetch).toHaveBeenCalledOnce();
    expect(f.requests).toEqual([request(self, echo)]);
    expect(f.handle).toHaveBeenCalledExactlyOnceWith('send_group_msg', v11Params);
    expect(f.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(id);
    expect(f.handle.mock.invocationCallOrder[0]).toBeLessThan(
        f.getSentMessageTime.mock.invocationCallOrder[0],
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
}

beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        throw new Error('unexpected default fetch');
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('V12 synthetic send time boundaries through the SDK', () => {
    it.each([
        { name: 'one second', time: 1, echo: '' },
        { name: 'smallest positive number', time: Number.MIN_VALUE, echo: 'smallest' },
        { name: 'positive fraction', time: 0.5, echo: 'fraction' },
        { name: 'large positive fraction', time: 2 ** 51 + 0.5, echo: 'large-fraction' },
        { name: 'maximum safe integer', time: Number.MAX_SAFE_INTEGER, echo: 'maximum' },
    ])('returns $name unchanged after one send', async ({ time, echo }) => {
        const id = -123;
        const f = fixture(selfA, id, () => time);
        const result = await f.client.request('send_message', params, { self: selfA, echo });
        const expected = success(id, time, echo);
        expect(result).toEqual(expected);
        expect(f.responses).toEqual([expected]);
        expectOneSend(f, selfA, echo, id);
    });

    it.each([
        { name: 'maximum safe integer plus one', time: Number.MAX_SAFE_INTEGER + 1, echo: 'max+1' },
        { name: 'positive infinity', time: Infinity, echo: 'infinity' },
        { name: 'negative infinity', time: -Infinity, echo: 'negative-infinity' },
        { name: 'NaN', time: NaN, echo: 'nan' },
        { name: 'zero', time: 0, echo: '' },
        { name: 'negative zero', time: -0, echo: 'negative-zero' },
        { name: 'negative value', time: -1, echo: 'negative' },
        { name: 'smallest negative magnitude', time: -Number.MIN_VALUE, echo: 'negative-min' },
        { name: 'missing metadata', time: null, echo: 'missing' },
    ])('returns 20001 for $name after one send and no re-send', async ({ time, echo }) => {
        const id = -123;
        const f = fixture(selfA, id, () => time);
        const result = await f.client.request('send_message', params, { self: selfA, echo });
        const expected = failure(20001, echo);
        expect(result).toEqual(expected);
        expect(f.responses).toEqual([expected]);
        expectOneSend(f, selfA, echo, id);
    });

    it.each([
        {
            name: 'synchronous throw',
            echo: 'sync-throw',
            time: () => {
                throw new Error('private synthetic metadata failure');
            },
        },
        {
            name: 'rejected promise',
            echo: 'async-rejection',
            time: () => Promise.reject(new Error('private synthetic metadata failure')),
        },
    ])('returns 20002 for a $name after one send and no re-send', async ({ time, echo }) => {
        const id = -123;
        const f = fixture(selfA, id, time);
        const result = await f.client.request('send_message', params, { self: selfA, echo });
        const expected = failure(20002, echo);
        expect(result).toEqual(expected);
        expect(f.responses).toEqual([expected]);
        expect(JSON.stringify(result)).not.toContain('private synthetic metadata failure');
        expectOneSend(f, selfA, echo, id);
    });

    it.each([
        {
            name: 'independent successful metadata',
            aTime: 0.5,
            bTime: Number.MAX_SAFE_INTEGER,
            bExpected: success(-2147483648, Number.MAX_SAFE_INTEGER, 'account-b'),
        },
        {
            name: 'one invalid result does not affect the other account',
            aTime: 1,
            bTime: Number.MAX_SAFE_INTEGER + 1,
            bExpected: failure(20001, 'account-b'),
        },
    ])('isolates two account bindings with $name', async ({ aTime, bTime, bExpected }) => {
        // The same valid signed message ID is intentional: metadata is account-local.
        const id = -2147483648;
        const a = fixture(selfA, id, () => aTime);
        const b = fixture(selfB, id, () => bTime);
        const [aResult, bResult] = await Promise.all([
            a.client.request('send_message', params, { self: selfA, echo: '' }),
            b.client.request('send_message', params, { self: selfB, echo: 'account-b' }),
        ]);
        const aExpected = success(id, aTime, '');
        expect(aResult).toEqual(aExpected);
        expect(bResult).toEqual(bExpected);
        expect(a.responses).toEqual([aExpected]);
        expect(b.responses).toEqual([bExpected]);
        expectOneSend(a, selfA, '', id);
        expectOneSend(b, selfB, 'account-b', id);

        const [crossA, crossB] = await Promise.all([
            a.client.request('send_message', params, { self: selfB, echo: 'cross-a' }),
            b.client.request('send_message', params, { self: selfA, echo: 'cross-b' }),
        ]);
        expect(crossA).toEqual({
            status: 'failed',
            retcode: 10102,
            data: null,
            message: 'unknown self',
            echo: 'cross-a',
        });
        expect(crossB).toEqual({
            status: 'failed',
            retcode: 10102,
            data: null,
            message: 'unknown self',
            echo: 'cross-b',
        });
        expect(a.fakeFetch).toHaveBeenCalledTimes(2);
        expect(b.fakeFetch).toHaveBeenCalledTimes(2);
        expect(a.requests).toEqual([request(selfA, ''), request(selfB, 'cross-a')]);
        expect(b.requests).toEqual([request(selfB, 'account-b'), request(selfA, 'cross-b')]);
        expect(a.handle).toHaveBeenCalledExactlyOnceWith('send_group_msg', v11Params);
        expect(b.handle).toHaveBeenCalledExactlyOnceWith('send_group_msg', v11Params);
        expect(a.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(id);
        expect(b.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(id);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
});
