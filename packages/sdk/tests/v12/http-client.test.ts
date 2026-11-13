import { describe, expect, it, vi } from 'vitest';
import { OneBot12HttpClient } from '../../src/v12/http-client.js';
import { OneBot12ClientError } from '../../src/v12/client-types.js';

const baseUrl = 'http://localhost/';
const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

describe('OneBot 12 HTTP application client', () => {
    it('posts the required envelope and preserves response extensions and failed status', async () => {
        const fetchImpl = vi.fn(async () =>
            json({
                status: 'failed',
                retcode: 10002,
                data: null,
                message: 'unsupported',
                'x.extra': 1,
            }),
        );
        const client = new OneBot12HttpClient({ baseUrl, accessToken: 'token', fetch: fetchImpl });
        const self = { platform: 'qq', user_id: '001' };
        expect(
            await client.request(
                'send_message',
                { detail_type: 'private', user_id: '22', message: [] },
                { self },
            ),
        ).toEqual({
            status: 'failed',
            retcode: 10002,
            data: null,
            message: 'unsupported',
            'x.extra': 1,
        });
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(baseUrl);
        expect(init.method).toBe('POST');
        expect(init.redirect).toBe('error');
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer token');
        expect(JSON.parse(String(init.body))).toEqual({
            action: 'send_message',
            params: { detail_type: 'private', user_id: '22', message: [] },
            self,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('preserves an explicitly supplied Authorization header', async () => {
        const fetchImpl = vi.fn(async () =>
            json({ status: 'ok', retcode: 0, data: null, message: '' }),
        );
        const client = new OneBot12HttpClient({
            baseUrl,
            fetch: fetchImpl,
            accessToken: 'unused',
            headers: { authorization: 'Bearer chosen' },
        });
        await client.call('get_status');
        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer chosen');
    });

    it.each([201, 302, 401, 415])(
        'distinguishes HTTP %i and never reveals response bodies',
        async (status) => {
            const client = new OneBot12HttpClient({
                baseUrl,
                fetch: async () => new Response('sensitive-response', { status }),
            });
            const error = await client.request('get_status').catch((cause: unknown) => cause);
            expect(error).toMatchObject({ code: 'http_status', status });
            expect(String(error)).not.toContain('sensitive-response');
        },
    );

    it('validates JSON response including mandatory fields and safe retcode', async () => {
        for (const body of [
            '{"status":"ok","retcode":0,"data":null}',
            '{"status":"ok","retcode":9007199254740993,"data":null,"message":""}',
            'sensitive-bad-json',
        ]) {
            const client = new OneBot12HttpClient({
                baseUrl,
                fetch: async () => new Response(body),
            });
            const error = await client.request('x').catch((cause: unknown) => cause);
            expect(error).toMatchObject({ code: 'invalid_response' });
            expect(String(error)).not.toContain('sensitive-bad-json');
        }
    });

    it('enforces byte limits across stream chunks and cancels reading', async () => {
        let canceled = false;
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('1234'));
                controller.enqueue(new TextEncoder().encode('5678'));
            },
            cancel() {
                canceled = true;
            },
        });
        const client = new OneBot12HttpClient({
            baseUrl,
            maxResponseBytes: 6,
            fetch: async () => new Response(stream),
        });
        await expect(client.request('x')).rejects.toMatchObject({ code: 'limit' });
        expect(canceled).toBe(true);
    });

    it('times out or cancels even if a custom fetch never settles', async () => {
        const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
        const client = new OneBot12HttpClient({ baseUrl, fetch: fetchImpl });
        await expect(client.request('x', {}, { timeoutMs: 10 })).rejects.toMatchObject({
            code: 'timeout',
        });
        const controller = new AbortController();
        const result = client.request('x', {}, { signal: controller.signal });
        controller.abort();
        await expect(result).rejects.toMatchObject({ code: 'aborted' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('cancels a late response body after abort even when fetch ignores the signal', async () => {
        let resolveFetch!: (response: Response) => void;
        let canceled = false;
        const client = new OneBot12HttpClient({
            baseUrl,
            fetch: () =>
                new Promise<Response>((resolve) => {
                    resolveFetch = resolve;
                }),
        });
        const controller = new AbortController();
        const request = client.request('x', {}, { signal: controller.signal });
        await Promise.resolve();
        controller.abort();
        await expect(request).rejects.toMatchObject({ code: 'aborted' });
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

    it('cancels an outstanding body read on timeout and enforces UTF-8 byte limits', async () => {
        let canceled = false;
        const client = new OneBot12HttpClient({
            baseUrl,
            fetch: async () =>
                new Response(
                    new ReadableStream({
                        cancel() {
                            canceled = true;
                        },
                    }),
                ),
        });
        await expect(client.request('x', {}, { timeoutMs: 5 })).rejects.toMatchObject({
            code: 'timeout',
        });
        expect(canceled).toBe(true);
        const limited = new OneBot12HttpClient({
            baseUrl,
            maxResponseBytes: 3,
            fetch: async () => new Response('你好'),
        });
        await expect(limited.request('x')).rejects.toMatchObject({ code: 'limit' });
    });

    it('sends requested echo and rejects missing, changed or duplicate echoes', async () => {
        const fetchImpl = vi.fn(async () =>
            json({ status: 'ok', retcode: 0, data: null, message: '', echo: 'abc' }),
        );
        const client = new OneBot12HttpClient({ baseUrl, fetch: fetchImpl });
        expect((await client.call('x', {}, { echo: 'abc' })).echo).toBe('abc');
        expect(
            JSON.parse(
                String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body),
            ).echo,
        ).toBe('abc');

        for (const text of [
            '{"status":"ok","retcode":0,"data":null,"message":""}',
            '{"status":"ok","retcode":0,"data":null,"message":"","echo":"wrong"}',
            '{"status":"ok","retcode":0,"data":null,"message":"","echo":"wrong","echo":"abc"}',
        ]) {
            const invalid = new OneBot12HttpClient({
                baseUrl,
                fetch: async () => new Response(text),
            });
            await expect(invalid.call('x', {}, { echo: 'abc' })).rejects.toMatchObject({
                code: 'invalid_response',
            });
        }
    });

    it('preserves response echo and rejects lossy numeric data without leaking transport errors', async () => {
        const echoed = new OneBot12HttpClient({
            baseUrl,
            fetch: async () =>
                json({ status: 'ok', retcode: 0, data: null, message: '', echo: 'server-echo' }),
        });
        expect((await echoed.request('x')).echo).toBe('server-echo');
        const lossy = new OneBot12HttpClient({
            baseUrl,
            fetch: async () =>
                new Response('{"status":"ok","retcode":0,"data":9007199254740993,"message":""}'),
        });
        await expect(lossy.request('x')).rejects.toMatchObject({ code: 'invalid_response' });
        const broken = new OneBot12HttpClient({
            baseUrl,
            accessToken: 'secret-token',
            fetch: async () => {
                throw new Error('secret-token');
            },
        });
        const error = await broken.request('x').catch((cause: unknown) => cause);
        expect(String(error)).not.toContain('secret-token');
    });

    it('rejects credentials and query in URLs without including them in errors', () => {
        expect(
            () =>
                new OneBot12HttpClient({
                    baseUrl: 'http://user:secret@localhost/?access_token=secret',
                }),
        ).toThrow(OneBot12ClientError);

        try {
            new OneBot12HttpClient({ baseUrl: 'http://user:secret@localhost/' });
        } catch (error) {
            expect(String(error)).not.toContain('secret');
        }
    });
});
