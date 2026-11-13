import { describe, expect, it, vi } from 'vitest';
import { OneBot12HttpClient } from '../../src/v12/http-client.js';
import {
    parseOneBot12Event,
    parseOneBot12EventJson,
    serializeOneBot12Event,
} from '../../src/v12/protocol.js';

const event = {
    id: 'message-event-1',
    time: 1632847927.599013,
    type: 'message',
    detail_type: 'group',
    sub_type: '',
    self: { platform: 'qq', user_id: '000900719925474099300', 'x.self': true },
    message_id: '-42',
    user_id: '00042',
    group_id: '00123',
    message: [
        { type: 'text', data: { text: 'Hello ' } },
        { type: 'mention', data: { user_id: '42', 'x.target': { source: 'fixture' } } },
        { type: 'text', data: { text: ' and ' } },
        { type: 'mention_all', data: {}, 'x.segment': ['extension', 1] },
        { type: 'text', data: { text: '!' } },
        { type: 'vendor.segment', data: { nested: [true, null, 'value'] } },
    ],
    alt_message: 'Hello @42 and @all!',
    echo: 'event-extension-echo',
    'x.event': { nested: ['preserved', 1] },
};

describe('OneBot 12 incoming mention events', () => {
    it('parses JSON and object events without changing segments, identity, time or extensions', () => {
        const fromJson = parseOneBot12EventJson(JSON.stringify(event));
        const fromObject = parseOneBot12Event(event);

        expect(fromJson).toEqual(event);
        expect(fromObject).toEqual(event);
        expect(fromJson.message).toEqual(event.message);
        expect(fromJson.alt_message).toBe('Hello @42 and @all!');
        expect(fromJson.time).toBe(1632847927.599013);
        expect(fromJson.self).toEqual(event.self);
        expect(fromJson.echo).toBe('event-extension-echo');
        expect(parseOneBot12EventJson(serializeOneBot12Event(fromJson))).toEqual(event);
    });

    it('retains existing event and segment validation for mention-containing messages', () => {
        for (const invalid of [
            { ...event, time: '1632847927.599013' },
            { ...event, self: { platform: 'qq', user_id: 42 } },
            { ...event, message: [{ type: 'mention', data: null }] },
            { ...event, message: [{ type: 'mention_all', data: { type: 'invalid' } }] },
        ]) {
            expect(() => parseOneBot12EventJson(JSON.stringify(invalid))).toThrow();
        }
    });

    it('preserves mention events and response echo through an in-memory HTTP client', async () => {
        const envelope = {
            status: 'ok',
            retcode: 0,
            message: '',
            data: [event],
            echo: 'request-echo',
            'x.response': { source: 'fixture' },
        };
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify(envelope)));
        const client = new OneBot12HttpClient({
            baseUrl: 'http://example.test/',
            fetch: fetchImpl,
        });
        const result = await client.getLatestEvents(
            { limit: 1, timeout: 0 },
            { self: event.self, echo: 'request-echo' },
        );

        expect(result).toEqual(envelope);
        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(JSON.parse(String(init.body))).toEqual({
            action: 'get_latest_events',
            params: { limit: 1, timeout: 0 },
            self: event.self,
            echo: 'request-echo',
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('still rejects a mismatched response echo even when the event is valid', async () => {
        const client = new OneBot12HttpClient({
            baseUrl: 'http://example.test/',
            fetch: async () =>
                new Response(
                    JSON.stringify({
                        status: 'ok',
                        retcode: 0,
                        message: '',
                        data: [event],
                        echo: 'other',
                    }),
                ),
        });

        await expect(client.getLatestEvents({}, { echo: 'request-echo' })).rejects.toMatchObject({
            code: 'invalid_response',
        });
    });
});
