import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OneBot12ClientError } from '../../src/v12/client-types.js';
import { OneBot12HttpClient } from '../../src/v12/http-client.js';
import type { OneBot12HttpClientOptions } from '../../src/v12/http-client.js';

const baseUrl = 'https://fixture.invalid/';
const requestedEcho = 'fixture-echo';
const success = {
    status: 'ok',
    retcode: 0,
    data: { message_id: 'fixture-message-id', nested: { enabled: true } },
    message: '',
    'vendor.extra': { values: [1, null, { enabled: true }] },
};
const failure = {
    status: 'failed',
    retcode: 10002,
    data: { reason: 'synthetic', nested: [1, null] },
    message: 'unsupported',
    'vendor.extra': { values: ['preserved'] },
};

const forbiddenFetch = vi.fn(function (): never {
    throw new Error('Unexpected global fetch');
});
const forbiddenWebSocket = vi.fn(function (): never {
    throw new Error('Unexpected WebSocket');
});

function fakeFetch(body: string) {
    return vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => {
        return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    });
}

function fixture(body: string, policy?: 'reject' | 'allow') {
    const fetchImpl = fakeFetch(body);
    const client = new OneBot12HttpClient({
        baseUrl,
        fetch: fetchImpl,
        ...(policy === undefined ? {} : { missingEchoPolicy: policy }),
    });
    return { client, fetchImpl };
}

function response(value: unknown): Response {
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
    forbiddenFetch.mockClear();
    forbiddenWebSocket.mockClear();
    vi.stubGlobal('fetch', forbiddenFetch);
    vi.stubGlobal('WebSocket', forbiddenWebSocket);
});

afterEach(() => {
    try {
        expect(forbiddenFetch).not.toHaveBeenCalled();
        expect(forbiddenWebSocket).not.toHaveBeenCalled();
    } finally {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    }
});

describe('OneBot 12 HTTP missing echo policy (in-memory fetch)', () => {
    it.each([undefined, 'reject'] as const)(
        'rejects a missing echo under the default or explicit policy %s',
        async (policy) => {
            for (const envelope of [success, failure]) {
                const { client, fetchImpl } = fixture(JSON.stringify(envelope), policy);
                await expect(
                    client.request('custom.action', {}, { echo: requestedEcho }),
                ).rejects.toMatchObject({ code: 'invalid_response' });
                expect(fetchImpl).toHaveBeenCalledTimes(1);
            }
        },
    );

    it.each([success, failure])(
        'allows an omitted response echo while retaining the complete $status envelope',
        async (envelope) => {
            const fetchImpl = fakeFetch(JSON.stringify(envelope));
            const client = new OneBot12HttpClient({
                baseUrl,
                fetch: fetchImpl,
                missingEchoPolicy: 'allow',
                accessToken: 'fixture-token',
                headers: { 'X-Fixture': 'fixture-header' },
            });
            const result = await client.call(
                'custom.action',
                { sample: true },
                { echo: requestedEcho },
            );
            expect(result).toEqual(envelope);
            expect(Object.hasOwn(result, 'echo')).toBe(false);
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            const [url, init] = fetchImpl.mock.calls[0];
            expect(url).toBe(baseUrl);
            expect(init?.method).toBe('POST');
            expect(init?.redirect).toBe('error');
            expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-token');
            expect(new Headers(init?.headers).get('x-fixture')).toBe('fixture-header');
            expect(JSON.parse(String(init?.body))).toEqual({
                action: 'custom.action',
                params: { sample: true },
                echo: requestedEcho,
            });
            // Observing headers and correlation on this fake transport establishes no peer identity.
        },
    );

    it.each(['reject', 'allow'] as const)(
        'requires an exact present echo for non-empty request echo under %s',
        async (policy) => {
            for (const returnedEcho of [requestedEcho, 'fixture-Echo', '', `${requestedEcho} `]) {
                const envelope = { ...success, echo: returnedEcho };
                const { client, fetchImpl } = fixture(JSON.stringify(envelope), policy);
                const result = client.request('custom.action', {}, { echo: requestedEcho });

                if (returnedEcho === requestedEcho) {
                    await expect(result).resolves.toEqual(envelope);
                } else {
                    await expect(result).rejects.toMatchObject({ code: 'invalid_response' });
                }

                expect(fetchImpl).toHaveBeenCalledTimes(1);
            }

            const { client, fetchImpl } = fixture(
                JSON.stringify({ ...success, echo: 'e\u0301' }),
                policy,
            );
            await expect(client.request('x', {}, { echo: '\u00e9' })).rejects.toMatchObject({
                code: 'invalid_response',
            });
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        },
    );

    it.each(['reject', 'allow'] as const)(
        'keeps empty and absent request echo unchecked, without ignoring response validation under %s',
        async (policy) => {
            for (const requestEcho of [undefined, '']) {
                for (const returnedEcho of [undefined, '', 'independent-server-value']) {
                    const envelope = {
                        ...success,
                        ...(returnedEcho === undefined ? {} : { echo: returnedEcho }),
                    };
                    const { client, fetchImpl } = fixture(JSON.stringify(envelope), policy);
                    const options = requestEcho === undefined ? {} : { echo: requestEcho };
                    const result = await client.request('x', {}, options);
                    expect(result).toEqual(envelope);
                    expect(Object.hasOwn(result, 'echo')).toBe(returnedEcho !== undefined);
                    expect(fetchImpl).toHaveBeenCalledTimes(1);
                    const [, init] = fetchImpl.mock.calls[0];
                    const sent = JSON.parse(String(init?.body));
                    expect(Object.hasOwn(sent, 'echo')).toBe(requestEcho !== undefined);

                    if (requestEcho !== undefined) {
                        expect(sent.echo).toBe('');
                    }
                }
            }
        },
    );

    it.each(['reject', 'allow'] as const)(
        'rejects duplicate top-level echo keys, including escaped spellings under %s',
        async (policy) => {
            const bodies = [
                '{"status":"ok","retcode":0,"data":null,"message":"","echo":"fixture-echo","echo":"fixture-echo"}',
                '{"status":"ok","retcode":0,"data":null,"message":"","echo":"fixture-echo","\\u0065cho":"fixture-echo"}',
                '{"status":"ok","retcode":0,"data":null,"message":"","\\u0065cho":"wrong","echo":"fixture-echo"}',
                '{"status":"failed","retcode":10002,"data":null,"message":"failed","echo":null,"echo":"fixture-echo"}',
            ];

            for (const body of bodies) {
                for (const requestEcho of [undefined, '', requestedEcho]) {
                    const { client, fetchImpl } = fixture(body, policy);
                    await expect(
                        client.request(
                            'x',
                            {},
                            requestEcho === undefined ? {} : { echo: requestEcho },
                        ),
                    ).rejects.toMatchObject({ code: 'invalid_response' });
                    expect(fetchImpl).toHaveBeenCalledTimes(1);
                }
            }
        },
    );

    it.each(['reject', 'allow'] as const)(
        'rejects non-string top-level echo with any request echo under %s',
        async (policy) => {
            for (const invalidEcho of [null, false, true, 0, 42, [], {}]) {
                for (const requestEcho of [undefined, '', requestedEcho]) {
                    const { client, fetchImpl } = fixture(
                        JSON.stringify({ ...success, echo: invalidEcho }),
                        policy,
                    );
                    await expect(
                        client.request(
                            'x',
                            {},
                            requestEcho === undefined ? {} : { echo: requestEcho },
                        ),
                    ).rejects.toMatchObject({ code: 'invalid_response' });
                    expect(fetchImpl).toHaveBeenCalledTimes(1);
                }
            }
        },
    );

    it('ignores nested echo keys and echo-like text when the top-level echo is omitted', async () => {
        const body =
            '{"status":"ok","retcode":0,"data":{"echo":17,"deeper":{"echo":false,"\\u0065cho":"last"}},"message":"nested \\"echo\\" text","vendor.extra":{"echo":null}}';
        const expected = {
            status: 'ok',
            retcode: 0,
            data: { echo: 17, deeper: { echo: 'last' } },
            message: 'nested "echo" text',
            'vendor.extra': { echo: null },
        };
        const allowed = fixture(body, 'allow');
        const result = await allowed.client.request('x', {}, { echo: requestedEcho });
        expect(result).toEqual(expected);
        expect(Object.hasOwn(result, 'echo')).toBe(false);
        expect(allowed.fetchImpl).toHaveBeenCalledTimes(1);

        const rejected = fixture(body);
        await expect(
            rejected.client.request('x', {}, { echo: requestedEcho }),
        ).rejects.toMatchObject({ code: 'invalid_response' });
        expect(rejected.fetchImpl).toHaveBeenCalledTimes(1);

        const echoed = fixture(JSON.stringify({ ...expected, echo: requestedEcho }), 'allow');
        await expect(echoed.client.request('x', {}, { echo: requestedEcho })).resolves.toEqual({
            ...expected,
            echo: requestedEcho,
        });
        expect(echoed.fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('snapshots the option at construction in both directions, including the default', async () => {
        const allowFetch = fakeFetch(JSON.stringify(success));
        const options: OneBot12HttpClientOptions = {
            baseUrl,
            fetch: allowFetch,
            missingEchoPolicy: 'allow',
        };
        const allowed = new OneBot12HttpClient(options);
        options.missingEchoPolicy = 'reject';
        const result = await allowed.request('x', {}, { echo: requestedEcho });
        expect(result).toEqual(success);
        expect(Object.hasOwn(result, 'echo')).toBe(false);
        expect(allowFetch).toHaveBeenCalledTimes(1);

        const rejectFetch = fakeFetch(JSON.stringify(success));
        const initiallyDefault: OneBot12HttpClientOptions = { baseUrl, fetch: rejectFetch };
        const rejected = new OneBot12HttpClient(initiallyDefault);
        initiallyDefault.missingEchoPolicy = 'allow';
        await expect(rejected.request('x', {}, { echo: requestedEcho })).rejects.toMatchObject({
            code: 'invalid_response',
        });
        expect(rejectFetch).toHaveBeenCalledTimes(1);

        const undefinedFetch = fakeFetch(JSON.stringify(success));
        const explicitlyUndefined = new OneBot12HttpClient({
            baseUrl,
            fetch: undefinedFetch,
            missingEchoPolicy: undefined,
        });
        await expect(
            explicitlyUndefined.request('x', {}, { echo: requestedEcho }),
        ).rejects.toMatchObject({ code: 'invalid_response' });
        expect(undefinedFetch).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid policy values synchronously before any fetch', () => {
        const fetchImpl = fakeFetch(JSON.stringify(success));

        for (const policy of [null, '', 'ALLOW', 'optional', 0, false, {}, [], Symbol('policy')]) {
            let error: unknown;

            try {
                new OneBot12HttpClient({
                    baseUrl,
                    fetch: fetchImpl,
                    missingEchoPolicy: policy as OneBot12HttpClientOptions['missingEchoPolicy'],
                });
            } catch (cause) {
                error = cause;
            }

            expect(error).toBeInstanceOf(OneBot12ClientError);
            expect(error).toMatchObject({ code: 'invalid_options' });
        }

        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('correlates concurrent responses independently in reverse order, without retry', async () => {
        const pending = new Map<string, (value: Response) => void>();
        const fetchImpl = vi.fn((...[, init]: Parameters<typeof fetch>): Promise<Response> => {
            const sent = JSON.parse(String(init?.body)) as { echo: string };
            return new Promise((resolve) => pending.set(sent.echo, resolve));
        });
        const client = new OneBot12HttpClient({
            baseUrl,
            fetch: fetchImpl,
            missingEchoPolicy: 'allow',
        });
        const first = client.request('first', { sequence: 1 }, { echo: 'echo-first' });
        const second = client.request('second', { sequence: 2 }, { echo: 'echo-second' });
        const third = client.request('third', { sequence: 3 }, { echo: 'echo-third' });
        const thirdCheck = expect(third).rejects.toMatchObject({ code: 'invalid_response' });
        await Promise.resolve();
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect([...pending.keys()]).toEqual(['echo-first', 'echo-second', 'echo-third']);

        // A response carrying another in-flight request's echo must not be accepted.
        pending.get('echo-third')!(response({ ...success, echo: 'echo-second' }));
        await thirdCheck;
        const secondEnvelope = { ...failure, echo: 'echo-second' };
        pending.get('echo-second')!(response(secondEnvelope));
        await expect(second).resolves.toEqual(secondEnvelope);
        pending.get('echo-first')!(response(success));
        const firstResult = await first;
        expect(firstResult).toEqual(success);
        expect(Object.hasOwn(firstResult, 'echo')).toBe(false);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
            { action: 'first', params: { sequence: 1 }, echo: 'echo-first' },
            { action: 'second', params: { sequence: 2 }, echo: 'echo-second' },
            { action: 'third', params: { sequence: 3 }, echo: 'echo-third' },
        ]);
    });

    it('does not expose message IDs or echoed values in response and transport errors', async () => {
        const secret = 'fixture-private-message-id';
        const bodies = [
            JSON.stringify({ ...success, data: { message_id: secret }, echo: secret }),
            `{"status":"ok","retcode":0,"data":{"message_id":"${secret}"},"message":"${secret}","echo":"${secret}","echo":"${requestedEcho}"}`,
            JSON.stringify({
                ...success,
                data: { message_id: secret },
                echo: { message_id: secret },
            }),
        ];

        for (const body of bodies) {
            const { client, fetchImpl } = fixture(body, 'allow');
            const error = await client
                .request('x', {}, { echo: requestedEcho })
                .catch((cause: unknown) => cause);
            expect(error).toBeInstanceOf(OneBot12ClientError);
            expect(error).toMatchObject({ code: 'invalid_response' });
            const diagnostic = JSON.stringify(Object.getOwnPropertyDescriptors(error));

            for (const value of [secret, requestedEcho]) {
                expect(String(error)).not.toContain(value);
                expect(diagnostic).not.toContain(value);
            }

            expect(fetchImpl).toHaveBeenCalledTimes(1);
        }

        const fetchImpl = vi.fn(async (): Promise<Response> => {
            throw new Error(secret);
        });
        const client = new OneBot12HttpClient({
            baseUrl,
            fetch: fetchImpl,
            missingEchoPolicy: 'allow',
        });
        const error = await client
            .request('x', {}, { echo: requestedEcho })
            .catch((cause: unknown) => cause);
        expect(error).toMatchObject({ code: 'network' });
        const diagnostic = JSON.stringify(Object.getOwnPropertyDescriptors(error));

        for (const value of [secret, requestedEcho]) {
            expect(String(error)).not.toContain(value);
            expect(diagnostic).not.toContain(value);
        }

        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('applies the same policy to getLatestEvents success and failure envelopes', async () => {
        const event = {
            id: 'fixture-event',
            time: 1,
            type: 'notice',
            detail_type: 'vendor.notice',
            sub_type: '',
            self: { platform: 'fixture', user_id: 'fixture-user' },
            'vendor.event': { echo: 123 },
        };
        const latest = { ...success, data: [event] };

        for (const envelope of [latest, failure]) {
            const allowed = fixture(JSON.stringify(envelope), 'allow');
            const result = await allowed.client.getLatestEvents(
                { limit: 1 },
                { echo: requestedEcho },
            );
            expect(result).toEqual(envelope);
            expect(Object.hasOwn(result, 'echo')).toBe(false);
            expect(allowed.fetchImpl).toHaveBeenCalledTimes(1);
            const [, init] = allowed.fetchImpl.mock.calls[0];
            expect(JSON.parse(String(init?.body))).toEqual({
                action: 'get_latest_events',
                params: { limit: 1 },
                echo: requestedEcho,
            });

            const rejected = fixture(JSON.stringify(envelope));
            await expect(
                rejected.client.getLatestEvents({}, { echo: requestedEcho }),
            ).rejects.toMatchObject({ code: 'invalid_response' });
            expect(rejected.fetchImpl).toHaveBeenCalledTimes(1);

            const wrong = fixture(JSON.stringify({ ...envelope, echo: 'wrong' }), 'allow');
            await expect(
                wrong.client.getLatestEvents({}, { echo: requestedEcho }),
            ).rejects.toMatchObject({ code: 'invalid_response' });
            expect(wrong.fetchImpl).toHaveBeenCalledTimes(1);
        }
    });
});
