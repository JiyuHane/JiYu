import { isDeepStrictEqual } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OneBot12HttpClient } from '../../../sdk/src/v12/http-client.js';
import { parseMessage } from '../../src/message-parser';
import type { JsonObject } from '../../src/types';
import { V12Dispatcher } from '../../src/v12/dispatcher';

// This exercises only local projections and synthetic submissions; it says nothing
// about remote acceptance or display. The fake handler's parse-before-submit order
// is a fixture choice, not a claim about the real downstream runtime.
const selfA = { platform: 'qq', user_id: '10001' };
const selfB = { platform: 'qq', user_id: '10002' };
const params = {
    detail_type: 'group',
    group_id: '44',
    message: [
        { type: 'text', data: { text: 'before' } },
        { type: 'mention', data: { user_id: '42' } },
        { type: 'mention_all', data: {} },
        { type: 'text', data: { text: 'after' } },
    ],
};
const v11Message = [
    { type: 'text', data: { text: 'before' } },
    { type: 'at', data: { qq: '42' } },
    { type: 'at', data: { qq: 'all' } },
    { type: 'text', data: { text: 'after' } },
];
const request = (self: typeof selfA, echo: string) => ({
    action: 'send_message',
    params,
    echo,
    self,
});

function fixture(
    self: typeof selfA,
    id: number,
    time: number,
    expectedRequests: unknown[],
    resolve: (uin: number) => Promise<string | null>,
) {
    const resolveMentionUid = vi.fn(resolve);
    const submissions: Awaited<ReturnType<typeof parseMessage>>[] = [];
    const handle = vi.fn(async (_action: string, data: JsonObject) => {
        const elements = await parseMessage(data.message, false, { resolveMentionUid });
        submissions.push(elements);
        return { status: 'ok' as const, retcode: 0, data: { message_id: id } };
    });
    const getSentMessageTime = vi.fn(async (_id: number): Promise<number | null> => time);
    const dispatcher = new V12Dispatcher({
        self,
        version: { impl: 'fixture', version: '1' },
        api: { handle },
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime,
    });
    const requests: unknown[] = [];
    const violations: string[] = [];
    const url = 'http://fixture.invalid/';
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const expected = expectedRequests[requests.length];
        let body: unknown;

        try {
            if (
                input !== url ||
                init?.method !== 'POST' ||
                init.redirect !== 'error' ||
                typeof init.body !== 'string' ||
                !(init.headers instanceof Headers) ||
                init.headers.get('content-type') !== 'application/json' ||
                init.headers.get('accept') !== 'application/json'
            ) {
                throw new Error('unexpected fetch envelope');
            }

            body = JSON.parse(init.body);
            requests.push(body);

            if (expected === undefined || !isDeepStrictEqual(body, expected)) {
                throw new Error('unexpected fetch body');
            }
        } catch (error) {
            violations.push(error instanceof Error ? error.message : 'unexpected fetch');
            throw error;
        }

        const response = await dispatcher.handle(body);
        return new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    });
    const client = new OneBot12HttpClient({ baseUrl: url, fetch: fakeFetch });
    return {
        client,
        fakeFetch,
        requests,
        violations,
        handle,
        getSentMessageTime,
        resolveMentionUid,
        submissions,
    };
}

beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        throw new Error('unexpected default fetch');
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('SDK v12 group mentions via an in-memory dispatcher', () => {
    it('preserves ordered v11 segments, account-local results, empty echo and self mismatch', async () => {
        const a = fixture(
            selfA,
            -123,
            1700000000,
            [request(selfA, ''), request(selfB, 'wrong')],
            async () => 'fixture-uid-a',
        );
        const b = fixture(
            selfB,
            -456,
            1700000001,
            [request(selfB, 'b')],
            async () => 'fixture-uid-b',
        );
        const [resultA, resultB] = await Promise.all([
            a.client.request('send_message', params, { self: selfA, echo: '' }),
            b.client.request('send_message', params, { self: selfB, echo: 'b' }),
        ]);
        expect(resultA).toEqual({
            status: 'ok',
            retcode: 0,
            data: { message_id: '-123', time: 1700000000 },
            message: '',
            echo: '',
        });
        expect(resultB).toEqual({
            status: 'ok',
            retcode: 0,
            data: { message_id: '-456', time: 1700000001 },
            message: '',
            echo: 'b',
        });
        expect(
            await a.client.request('send_message', params, { self: selfB, echo: 'wrong' }),
        ).toEqual({
            status: 'failed',
            retcode: 10102,
            data: null,
            message: 'unknown self',
            echo: 'wrong',
        });
        expect(a.fakeFetch).toHaveBeenCalledTimes(2);
        expect(b.fakeFetch).toHaveBeenCalledTimes(1);
        expect(a.requests).toEqual([request(selfA, ''), request(selfB, 'wrong')]);
        expect(b.requests).toEqual([request(selfB, 'b')]);
        expect(a.violations).toEqual([]);
        expect(b.violations).toEqual([]);

        for (const f of [a, b]) {
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('send_group_msg', {
                group_id: 44,
                message: v11Message,
                auto_escape: false,
            });
            expect(f.resolveMentionUid).toHaveBeenCalledExactlyOnceWith(42);
        }

        expect(a.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(-123);
        expect(b.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(-456);
        expect(a.submissions).toEqual([
            [
                { type: 'text', text: 'before' },
                { type: 'at', targetUin: 42, uid: 'fixture-uid-a' },
                { type: 'at', targetUin: 0, uid: 'all', text: '@全体成员 ' },
                { type: 'text', text: 'after' },
            ],
        ]);
        expect(b.submissions).toEqual([
            [
                { type: 'text', text: 'before' },
                { type: 'at', targetUin: 42, uid: 'fixture-uid-b' },
                { type: 'at', targetUin: 0, uid: 'all', text: '@全体成员 ' },
                { type: 'text', text: 'after' },
            ],
        ]);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range mention before the downstream handler', async () => {
        const oversized = {
            detail_type: 'group',
            group_id: '44',
            message: [{ type: 'mention', data: { user_id: '4294967296' } }],
        };
        const expected = { action: 'send_message', params: oversized, echo: 'range', self: selfA };
        const f = fixture(selfA, -123, 1700000000, [expected], async () => 'fixture-uid');
        expect(
            await f.client.request('send_message', oversized, { self: selfA, echo: 'range' }),
        ).toEqual({
            status: 'failed',
            retcode: 10006,
            data: null,
            message: 'invalid mention segment',
            echo: 'range',
        });
        expect(f.fakeFetch).toHaveBeenCalledOnce();
        expect(f.requests).toEqual([expected]);
        expect(f.violations).toEqual([]);
        expect(f.handle).not.toHaveBeenCalled();
        expect(f.resolveMentionUid).not.toHaveBeenCalled();
        expect(f.getSentMessageTime).not.toHaveBeenCalled();
        expect(f.submissions).toEqual([]);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('propagates synthetic resolver absence or failure without retry', async () => {
        const missing = fixture(
            selfA,
            -123,
            1700000000,
            [request(selfA, 'missing')],
            async () => null,
        );
        const failure = fixture(selfA, -123, 1700000000, [request(selfA, 'failure')], async () => {
            throw new Error('fixture resolver failure');
        });
        const ok = await missing.client.request('send_message', params, {
            self: selfA,
            echo: 'missing',
        });
        const failed = await failure.client.request('send_message', params, {
            self: selfA,
            echo: 'failure',
        });
        expect(ok).toEqual({
            status: 'ok',
            retcode: 0,
            data: { message_id: '-123', time: 1700000000 },
            message: '',
            echo: 'missing',
        });
        expect(missing.submissions[0][1]).toEqual({ type: 'at', targetUin: 42 });
        expect(failed).toEqual({
            status: 'failed',
            retcode: 20002,
            data: null,
            message: 'message outcome unavailable; do not retry automatically',
            echo: 'failure',
        });
        expect(failure.submissions).toEqual([]);

        for (const f of [missing, failure]) {
            expect(f.fakeFetch).toHaveBeenCalledOnce();
            expect(f.violations).toEqual([]);
            expect(f.handle).toHaveBeenCalledExactlyOnceWith('send_group_msg', {
                group_id: 44,
                message: v11Message,
                auto_escape: false,
            });
            expect(f.resolveMentionUid).toHaveBeenCalledExactlyOnceWith(42);
        }

        expect(missing.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(-123);
        expect(failure.getSentMessageTime).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('keeps a synthetic resolver special value in the parsed element', async () => {
        // This value comes from the fake resolver, not from v12 mention.user_id.
        // Downstream code may interpret uid='all' specially; this checks the parsed
        // element only, not wire encoding or whether a real resolver emits it.
        const f = fixture(selfA, -123, 1700000000, [request(selfA, 'special')], async () => 'all');
        const result = await f.client.request('send_message', params, {
            self: selfA,
            echo: 'special',
        });
        expect(result).toEqual({
            status: 'ok',
            retcode: 0,
            data: { message_id: '-123', time: 1700000000 },
            message: '',
            echo: 'special',
        });
        expect(f.fakeFetch).toHaveBeenCalledOnce();
        expect(f.violations).toEqual([]);
        expect(f.handle).toHaveBeenCalledExactlyOnceWith('send_group_msg', {
            group_id: 44,
            message: v11Message,
            auto_escape: false,
        });
        expect(f.resolveMentionUid).toHaveBeenCalledExactlyOnceWith(42);
        expect(f.submissions[0][1]).toEqual({ type: 'at', targetUin: 42, uid: 'all' });
        expect(f.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(-123);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('reports timestamp failure after one synthetic submission and clears the SDK deadline', async () => {
        const timers = vi.spyOn(globalThis, 'setTimeout');
        const clear = vi.spyOn(globalThis, 'clearTimeout');
        const f = fixture(
            selfA,
            -123,
            1700000000,
            [request(selfA, 'time')],
            async () => 'fixture-uid',
        );
        f.getSentMessageTime.mockRejectedValue(new Error('fixture timestamp failure'));
        const result = await f.client.request('send_message', params, {
            self: selfA,
            echo: 'time',
        });
        expect(result).toEqual({
            status: 'failed',
            retcode: 20002,
            data: null,
            message: 'message sent but result metadata is unavailable; do not retry automatically',
            echo: 'time',
        });
        expect(f.fakeFetch).toHaveBeenCalledOnce();
        expect(f.violations).toEqual([]);
        expect(f.handle).toHaveBeenCalledExactlyOnceWith('send_group_msg', {
            group_id: 44,
            message: v11Message,
            auto_escape: false,
        });
        expect(f.submissions).toHaveLength(1);
        expect(f.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(-123);
        const timerIndex = timers.mock.calls.findIndex((call) => call[1] === 30000);
        expect(timerIndex).toBeGreaterThanOrEqual(0);
        expect(clear).toHaveBeenCalledWith(timers.mock.results[timerIndex].value);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
});
