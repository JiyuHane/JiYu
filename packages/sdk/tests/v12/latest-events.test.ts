import { afterEach, describe, expect, it, vi } from 'vitest';
import { OneBot12HttpClient } from '../../src/v12/http-client.js';
import type { OneBot12LatestEventsParams } from '../../src/v12/types.js';

const baseUrl = 'http://localhost/';
const self = { platform: 'qq', user_id: '123', 'x.self': true };
const event = {
    id: '',
    time: -1.25,
    type: 'message',
    detail_type: 'private',
    sub_type: 'vendor.unknown',
    self,
    'x.extension': { nested: [true, 1] },
};
const response = (data: unknown, extra: Record<string, unknown> = {}) => ({
    status: 'ok',
    retcode: 0,
    data,
    message: '',
    ...extra,
});
const json = (value: unknown) => new Response(JSON.stringify(value));
afterEach(() => vi.useRealTimers());

describe('OneBot 12 HTTP getLatestEvents', () => {
    it('preserves optional wire parameters, self, echo, envelope and unknown event details', async () => {
        const fetchImpl = vi.fn(async () =>
            json(
                response(
                    [
                        event,
                        {
                            ...event,
                            id: '2',
                            type: 'notice',
                            detail_type: 'vendor.notice',
                            'x.n': 4,
                        },
                        { ...event, id: '3', type: 'request', detail_type: 'vendor.request' },
                    ],
                    {
                        echo: 'echo',
                        'x.envelope': { a: 1 },
                    },
                ),
            ),
        );
        const client = new OneBot12HttpClient({ baseUrl, fetch: fetchImpl });
        const result = await client.getLatestEvents(
            { limit: 2, timeout: 40, 'x.option': { enabled: true } },
            { echo: 'echo', self, timeoutMs: 50_000 },
        );
        expect(result).toEqual(
            response(
                [
                    event,
                    {
                        ...event,
                        id: '2',
                        type: 'notice',
                        detail_type: 'vendor.notice',
                        'x.n': 4,
                    },
                    { ...event, id: '3', type: 'request', detail_type: 'vendor.request' },
                ],
                {
                    echo: 'echo',
                    'x.envelope': { a: 1 },
                },
            ),
        );
        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(JSON.parse(String(init.body))).toEqual({
            action: 'get_latest_events',
            params: { limit: 2, timeout: 40, 'x.option': { enabled: true } },
            self,
            echo: 'echo',
        });
    });

    it('omits defaults and explicitly undefined optional fields, while preserving zeros', async () => {
        const fetchImpl = vi.fn(async () => json(response([])));
        const client = new OneBot12HttpClient({ baseUrl, fetch: fetchImpl });
        await client.getLatestEvents();
        await client.getLatestEvents({ limit: undefined, timeout: undefined });
        await client.getLatestEvents({ limit: 0, timeout: 0 });
        await client.getLatestEvents({
            limit: Number.MAX_SAFE_INTEGER,
            timeout: Number.MAX_SAFE_INTEGER,
        });
        const params = fetchImpl.mock.calls.map(
            (call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)).params,
        );
        expect(params).toEqual([
            {},
            {},
            { limit: 0, timeout: 0 },
            {
                limit: Number.MAX_SAFE_INTEGER,
                timeout: Number.MAX_SAFE_INTEGER,
            },
        ]);
    });

    it.each(['limit', 'timeout'] as const)('rejects invalid %s before fetch', async (field) => {
        const fetchImpl = vi.fn(async () => json(response([])));
        const client = new OneBot12HttpClient({ baseUrl, fetch: fetchImpl });
        for (const value of [-1, 0.5, NaN, Infinity, 2 ** 53, '1', null]) {
            await expect(
                client.getLatestEvents({ [field]: value } as OneBot12LatestEventsParams),
            ).rejects.toMatchObject({ code: 'invalid_options' });
        }
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects accessors, prototypes and throwing proxy traps without leaking errors', async () => {
        const fetchImpl = vi.fn(async () => json(response([])));
        const client = new OneBot12HttpClient({ baseUrl, fetch: fetchImpl });
        let calls = 0;
        const getter = Object.defineProperty({}, 'limit', {
            enumerable: true,
            get() {
                calls++;
                return 1;
            },
        });
        const nestedGetter = Object.defineProperty({}, 'bad', {
            enumerable: true,
            get() {
                calls++;
                return 1;
            },
        });
        const proxy = new Proxy(
            {},
            {
                ownKeys() {
                    throw new Error('private trap');
                },
            },
        );
        for (const params of [
            getter,
            { 'x.nested': nestedGetter },
            Object.create({ limit: 1 }),
            proxy,
            { x: undefined },
        ]) {
            const error = await client.getLatestEvents(params).catch((cause: unknown) => cause);
            expect(error).toMatchObject({ code: 'invalid_options' });
            expect(String(error)).not.toContain('private trap');
        }
        expect(calls).toBe(0);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('returns failed business envelopes with arbitrary data and extensions unchanged', async () => {
        const failure = {
            status: 'failed',
            retcode: 10002,
            message: 'unsupported',
            data: { explanation: 'x' },
            'x.error': true,
        };
        const client = new OneBot12HttpClient({ baseUrl, fetch: async () => json(failure) });
        expect(await client.getLatestEvents()).toEqual(failure);
    });

    it('rejects invalid or meta success events and does not turn bad data into an empty array', async () => {
        const invalid = [
            null,
            {},
            [null],
            [1],
            [{ ...event, type: 'meta' }],
            [{ ...event, type: 'future' }],
            [{ ...event, id: null }],
            [{ ...event, time: '1' }],
            [{ ...event, detail_type: 1 }],
            [{ ...event, sub_type: null }],
            [{ ...event, self: null }],
            [{ ...event, self: { platform: 'qq' } }],
            [{ ...event, self: { platform: 1, user_id: 'x' } }],
        ];
        for (const data of invalid) {
            const client = new OneBot12HttpClient({
                baseUrl,
                fetch: async () => json(response(data)),
            });
            await expect(client.getLatestEvents()).rejects.toMatchObject({
                code: 'invalid_response',
            });
        }
    });

    it('preserves extension keys including __proto__ as data without polluting prototypes', async () => {
        const wire =
            '{"status":"ok","retcode":0,"message":"","data":[{"id":"id","time":0,"type":"notice","detail_type":"","sub_type":"","self":{"platform":"qq","user_id":"1"},"__proto__":{"polluted":true}}]}';
        const client = new OneBot12HttpClient({ baseUrl, fetch: async () => new Response(wire) });
        const result = await client.getLatestEvents();
        expect(result.status).toBe('ok');
        if (result.status === 'ok') {
            expect(Object.hasOwn(result.data[0], '__proto__')).toBe(true);
            expect(result.data[0].__proto__).toEqual({ polluted: true });
        }
        expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    });

    it('retains the transport body limit, number checks and echo matching', async () => {
        const large = new OneBot12HttpClient({
            baseUrl,
            maxResponseBytes: 64,
            fetch: async () => json(response([event])),
        });
        await expect(large.getLatestEvents()).rejects.toMatchObject({ code: 'limit' });
        const unsafe = new OneBot12HttpClient({
            baseUrl,
            fetch: async () =>
                new Response('{"status":"ok","retcode":0,"message":"","data":[9007199254740992]}'),
        });
        await expect(unsafe.getLatestEvents()).rejects.toMatchObject({ code: 'invalid_response' });
        const echo = new OneBot12HttpClient({
            baseUrl,
            fetch: async () => json(response([], { echo: 'wrong' })),
        });
        await expect(echo.getLatestEvents({}, { echo: 'wanted' })).rejects.toMatchObject({
            code: 'invalid_response',
        });
    });

    it('uses the normal default deadline independently of server timeout and supports zero deadline', async () => {
        vi.useFakeTimers();
        const client = new OneBot12HttpClient({
            baseUrl,
            fetch: () => new Promise<Response>(() => {}),
        });
        const timed = client.getLatestEvents({ timeout: 60 });
        const timedCheck = expect(timed).rejects.toMatchObject({ code: 'timeout' });
        await vi.advanceTimersByTimeAsync(30_000);
        await timedCheck;
        const aborter = new AbortController();
        const waiting = client.getLatestEvents(
            { timeout: 60 },
            { timeoutMs: 0, signal: aborter.signal },
        );
        let settled = false;
        void waiting.catch(() => {
            settled = true;
        });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(settled).toBe(false);
        aborter.abort();
        await expect(waiting).rejects.toMatchObject({ code: 'aborted' });
    });

    it('cancels a late fetch response body after a caller aborts', async () => {
        let resolveFetch!: (value: Response) => void;
        let canceled = false;
        const client = new OneBot12HttpClient({
            baseUrl,
            fetch: () =>
                new Promise((resolve) => {
                    resolveFetch = resolve;
                }),
        });
        const aborter = new AbortController();
        aborter.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
        const waiting = client.getLatestEvents(
            { timeout: 30 },
            { signal: aborter.signal, timeoutMs: 0 },
        );
        await Promise.resolve();
        aborter.abort();
        await expect(waiting).rejects.toMatchObject({ code: 'aborted' });
        resolveFetch(
            new Response(
                new ReadableStream({
                    cancel() {
                        canceled = true;
                    },
                }),
            ),
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(canceled).toBe(true);
    });
});
