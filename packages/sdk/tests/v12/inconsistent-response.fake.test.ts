import { describe, expect, it, vi } from 'vitest';
import { OneBot12ClientError } from '../../src/v12/client-types.js';
import { OneBot12HttpClient } from '../../src/v12/http-client.js';
import {
    isOneBot12ActionResponse,
    parseOneBot12ActionResponse,
    parseOneBot12ActionResponseJson,
    parseOneBot12Event,
    serializeOneBot12ActionResponse,
} from '../../src/v12/protocol.js';

const baseUrl = 'http://localhost/';
const echo = 'synthetic-echo';
const data = { nested: [{ text: 'unchanged', count: 3 }, null], enabled: true };
const extra = { vendor: ['extension', { flag: true }] };

function response(status: string, retcode: number, message = '') {
    return { status, retcode, data, message, echo, 'vendor.extra': extra };
}

function clientReturning(body: string) {
    const fetchImpl = vi.fn(
        async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }),
    );
    return { client: new OneBot12HttpClient({ baseUrl, fetch: fetchImpl }), fetchImpl };
}

describe('OneBot 12 inconsistent action responses with synthetic transports', () => {
    it.each([1, -1, 10002, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])(
        'rejects ok with nonzero retcode %s in object and JSON parsers',
        (retcode) => {
            const input = response('ok', retcode, 'not actually successful');
            const before = JSON.stringify(input);
            expect(isOneBot12ActionResponse(input)).toBe(false);
            expect(() => parseOneBot12ActionResponse(input)).toThrow(TypeError);
            expect(() => parseOneBot12ActionResponseJson(before)).toThrow(TypeError);
            expect(() => serializeOneBot12ActionResponse(input)).toThrow(TypeError);
            expect(JSON.stringify(input)).toBe(before);
        },
    );

    it.each([1, -1, 10002, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])(
        'reports ok/%s as HTTP invalid_response with matching echo and no retry',
        async (retcode) => {
            const { client, fetchImpl } = clientReturning(
                JSON.stringify(response('ok', retcode, 'not actually successful')),
            );
            const error = await client
                .request('custom.action', { payload: data }, { echo })
                .catch((cause: unknown) => cause);
            expect(error).toBeInstanceOf(OneBot12ClientError);
            expect(error).toMatchObject({ code: 'invalid_response' });
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
            expect(JSON.parse(String(init.body))).toEqual({
                action: 'custom.action',
                params: { payload: data },
                echo,
            });
        },
    );

    it.each([
        ['ok', 0, ''],
        ['ok', 0, 'success with an informative message'],
        ['failed', 10002, 'unsupported'],
        ['failed', 0, 'failure with zero code'],
        ['failed', Number.MAX_SAFE_INTEGER, 'upper boundary'],
        ['failed', Number.MIN_SAFE_INTEGER, 'lower boundary'],
    ])(
        'preserves accepted %s/%s response, data, message, echo and extensions',
        async (status, retcode, message) => {
            const input = response(status, retcode, message);
            const wire = JSON.stringify(input);
            expect(parseOneBot12ActionResponse(input)).toEqual(input);
            expect(parseOneBot12ActionResponseJson(wire)).toEqual(input);
            expect(JSON.parse(serializeOneBot12ActionResponse(input))).toEqual(input);
            const { client, fetchImpl } = clientReturning(wire);
            expect(await client.call('custom.action', {}, { echo })).toEqual(input);
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            expect(input.data).toEqual(data);
            expect(input['vendor.extra']).toEqual(extra);
        },
    );

    it('snapshots response data and extensions without modifying the supplied object', () => {
        const input = response('ok', 0);
        const before = JSON.stringify(input);
        const parsed = parseOneBot12ActionResponse(input);
        expect(JSON.stringify(input)).toBe(before);
        expect(parsed.data).toEqual(data);
        expect(parsed.data).not.toBe(input.data);
        expect(parsed['vendor.extra']).not.toBe(input['vendor.extra']);
        (parsed.data as { nested: { text: string }[] }).nested[0].text = 'changed copy';
        expect(JSON.stringify(input)).toBe(before);
    });

    it.each(['0', '-0', '0.0', '0e1001'])('accepts existing zero spelling %s', async (literal) => {
        const wire = `{"status":"ok","retcode":${literal},"data":{"nested":[-0,1]},"message":"message","echo":"${echo}","vendor.extra":{"present":true}}`;
        const parsed = parseOneBot12ActionResponseJson(wire);
        expect(Object.is(parsed.retcode, literal === '-0' ? -0 : 0)).toBe(true);
        expect(Object.is((parsed.data as { nested: number[] }).nested[0], -0)).toBe(true);
        const { client, fetchImpl } = clientReturning(wire);
        const received = await client.request('custom.action', {}, { echo });
        expect(received).toEqual(parsed);
        expect(Object.is(received.retcode, parsed.retcode)).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('retains echo checks for otherwise valid responses and does not retry', async () => {
        for (const returnedEcho of ['wrong', undefined]) {
            const { client, fetchImpl } = clientReturning(
                JSON.stringify({ ...response('ok', 0), echo: returnedEcho }),
            );
            const error = await client
                .request('custom.action', {}, { echo })
                .catch((cause: unknown) => cause);
            expect(error).toBeInstanceOf(OneBot12ClientError);
            expect(error).toMatchObject({ code: 'invalid_response' });
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        }
    });

    it('keeps event extension fields independent from response validity', () => {
        const event = {
            id: 'synthetic-event',
            time: 1,
            type: 'meta',
            detail_type: 'connect',
            sub_type: '',
            status: 'ok',
            retcode: 10002,
            data,
            message: 'an event extension',
            'vendor.extra': extra,
        };
        expect(parseOneBot12Event(event)).toEqual(event);
        expect(isOneBot12ActionResponse(event)).toBe(false);
        expect(() => parseOneBot12ActionResponse(event)).toThrow(TypeError);
        const partial = { ...event, status: 'vendor-specific-status' };
        expect(parseOneBot12Event(partial)).toEqual(partial);
    });
});
