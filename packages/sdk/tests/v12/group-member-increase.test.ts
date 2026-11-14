import { describe, expect, it, vi } from 'vitest';
import { OneBot12HttpClient } from '../../src/v12/http-client.js';
import {
    parseOneBot12Event,
    parseOneBot12EventJson,
    serializeOneBot12Event,
} from '../../src/v12/protocol.js';

const baseEvent = {
    id: 'member-increase-1',
    time: 1632847927.599013,
    type: 'notice',
    detail_type: 'group_member_increase',
    self: { platform: 'qq', user_id: '900719925474099301', 'x.self': true },
    group_id: '900719925474099302',
    user_id: '900719925474099303',
    operator_id: '900719925474099304',
    'x.event': { nested: [true, 'extra', null] },
};
const events = [
    { ...baseEvent, sub_type: '' },
    { ...baseEvent, id: 'member-increase-2', sub_type: 'vendor.future' },
];

describe('OneBot 12 group member increase notices', () => {
    it.each(events)(
        'preserves identifiers, fractional time, subtype and extensions through both parsers',
        (event) => {
            const fromObject = parseOneBot12Event(event);
            const fromJson = parseOneBot12EventJson(JSON.stringify(event));

            expect(fromObject).toEqual(event);
            expect(fromJson).toEqual(event);
            expect(fromJson.time).toBe(1632847927.599013);
            expect(fromJson.self).toEqual(baseEvent.self);
            expect(fromJson.group_id).toBe('900719925474099302');
            expect(fromJson.user_id).toBe('900719925474099303');
            expect(fromJson.operator_id).toBe('900719925474099304');
            expect(fromJson.sub_type).toBe(event.sub_type);
            expect(fromJson['x.event']).toEqual(baseEvent['x.event']);
            expect(parseOneBot12EventJson(serializeOneBot12Event(fromJson))).toEqual(event);
        },
    );

    it('preserves multiple notices and echo through an in-memory HTTP client', async () => {
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
            { limit: 2, timeout: 0 },
            { self: baseEvent.self, echo: 'request-echo' },
        );

        expect(result).toEqual(envelope);
        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(JSON.parse(String(init.body))).toEqual({
            action: 'get_latest_events',
            params: { limit: 2, timeout: 0 },
            self: baseEvent.self,
            echo: 'request-echo',
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('rejects a mismatched response echo', async () => {
        const client = new OneBot12HttpClient({
            baseUrl: 'http://example.test/',
            fetch: async () =>
                new Response(
                    JSON.stringify({
                        status: 'ok',
                        retcode: 0,
                        message: '',
                        data: events,
                        echo: 'other',
                    }),
                ),
        });

        await expect(client.getLatestEvents({}, { echo: 'request-echo' })).rejects.toMatchObject({
            code: 'invalid_response',
        });
    });
});
