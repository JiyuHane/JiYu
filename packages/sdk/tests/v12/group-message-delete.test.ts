import { describe, expect, it, vi } from 'vitest';
import { OneBot12HttpClient } from '../../src/v12/http-client.js';
import {
    parseOneBot12Event,
    parseOneBot12EventJson,
    serializeOneBot12Event,
} from '../../src/v12/protocol.js';

const baseEvent = {
    id: 'notice-1',
    time: 1632847927.599013,
    type: 'notice',
    detail_type: 'group_message_delete',
    self: { platform: 'qq', user_id: '00123', 'x.self': true },
    group_id: '00456',
    user_id: '00042',
    message_id: '-123',
    'x.event': { nested: [true, 'extra', null] },
};

const events = [
    { ...baseEvent, sub_type: 'recall', operator_id: '00042' },
    { ...baseEvent, id: 'notice-2', sub_type: '', operator_id: '00099' },
    { ...baseEvent, id: 'notice-3', sub_type: 'vendor.future', operator_id: '00099' },
];

describe('OneBot 12 group message deletion notices', () => {
    it.each(events)(
        'preserves notice fields and unknown subtypes through both parsers',
        (event) => {
            const fromObject = parseOneBot12Event(event);
            const fromJson = parseOneBot12EventJson(JSON.stringify(event));

            expect(fromObject).toEqual(event);
            expect(fromJson).toEqual(event);
            expect(fromJson.time).toBe(1632847927.599013);
            expect(fromJson.self).toEqual(baseEvent.self);
            expect(fromJson.group_id).toBe('00456');
            expect(fromJson.user_id).toBe('00042');
            expect(fromJson.operator_id).toBe(event.operator_id);
            expect(fromJson.message_id).toBe('-123');
            expect(fromJson['x.event']).toEqual(baseEvent['x.event']);
            expect(parseOneBot12EventJson(serializeOneBot12Event(fromJson))).toEqual(event);
        },
    );

    it('preserves notice data and echo through an in-memory HTTP client', async () => {
        const envelope = {
            status: 'ok',
            retcode: 0,
            message: '',
            data: events,
            echo: 'request-echo',
            'x.response': { source: 'fixture' },
        };
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify(envelope)));
        const client = new OneBot12HttpClient({
            baseUrl: 'http://example.test/',
            fetch: fetchImpl,
        });
        const result = await client.getLatestEvents(
            { limit: 3, timeout: 0 },
            { self: baseEvent.self, echo: 'request-echo' },
        );

        expect(result).toEqual(envelope);
        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(JSON.parse(String(init.body))).toEqual({
            action: 'get_latest_events',
            params: { limit: 3, timeout: 0 },
            self: baseEvent.self,
            echo: 'request-echo',
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('keeps response echo matching independent of the notice', async () => {
        const client = new OneBot12HttpClient({
            baseUrl: 'http://example.test/',
            fetch: async () =>
                new Response(
                    JSON.stringify({
                        status: 'ok',
                        retcode: 0,
                        message: '',
                        data: [events[0]],
                        echo: 'other',
                    }),
                ),
        });

        await expect(client.getLatestEvents({}, { echo: 'request-echo' })).rejects.toMatchObject({
            code: 'invalid_response',
        });
    });
});
