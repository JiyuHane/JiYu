import { describe, expect, it, vi } from 'vitest';
import {
    OneBot12HttpClient,
    parseOneBot12Event,
    parseOneBot12EventJson,
    serializeOneBot12Event,
} from '../../src/v12/index.js';

function makeEvent() {
    return {
        id: 'member-increase-invited-1',
        time: 1632847927.599013,
        type: 'notice',
        detail_type: 'group_member_increase',
        sub_type: '',
        self: { platform: 'qq', user_id: '900719925474099301', 'x.self': { active: true } },
        group_id: '900719925474099302',
        user_id: '900719925474099303',
        operator_id: '900719925474099304',
        'qq.invitor_id': '900719925474099305',
        'x.fixture': { nested: ['original', true, null] },
    };
}

describe('OneBot 12 invited member extension from a synthetic service event', () => {
    it('preserves the flat extension, identities and other fields in object and JSON round trips', () => {
        const input = makeEvent();
        const original = structuredClone(input);
        const parsed = parseOneBot12Event(input);
        const fromJson = parseOneBot12EventJson(JSON.stringify(input));

        expect(input).toEqual(original);
        expect(parsed).toEqual(original);
        expect(fromJson).toEqual(original);
        expect(parsed.id).toBe('member-increase-invited-1');
        expect(parsed.time).toBe(1632847927.599013);
        expect(parsed.self).toEqual(original.self);
        expect(parsed.group_id).toBe('900719925474099302');
        expect(parsed.user_id).toBe('900719925474099303');
        expect(parsed.operator_id).toBe('900719925474099304');
        expect(parsed['qq.invitor_id']).toBe('900719925474099305');
        expect(parsed['x.fixture']).toEqual(original['x.fixture']);
        expect(parseOneBot12EventJson(serializeOneBot12Event(parsed))).toEqual(original);

        expect(parsed).not.toBe(input);
        expect(parsed.self).not.toBe(input.self);
        expect(parsed['x.fixture']).not.toBe(input['x.fixture']);
        const parsedExtension = parsed['x.fixture'] as { nested: (string | boolean | null)[] };
        parsedExtension.nested[0] = 'output-changed';
        input.self['x.self'].active = false;
        input['x.fixture'].nested[1] = false;
        expect(input['x.fixture'].nested[0]).toBe('original');
        expect(parsedExtension.nested[1]).toBe(true);
        expect(parsed.self).toEqual(original.self);
        expect(fromJson).toEqual(original);
    });

    it('accepts an ordinary notice without an inviter extension', () => {
        const { 'qq.invitor_id': _omitted, ...unknownInviter } = makeEvent();
        const parsed = parseOneBot12Event(unknownInviter);

        expect(parsed).toEqual(unknownInviter);
        expect(Object.hasOwn(parsed, 'qq.invitor_id')).toBe(false);
        expect(parseOneBot12EventJson(serializeOneBot12Event(parsed))).toEqual(unknownInviter);
    });

    it.each(['not-a-canonical-uin', '', 42, null, { arbitrary: [true, 'value'] }])(
        'preserves JSON extension value %j without claiming inviter semantics',
        (value) => {
            const event = { ...makeEvent(), 'qq.invitor_id': value };
            const parsed = parseOneBot12Event(event);

            expect(parsed['qq.invitor_id']).toEqual(value);
            expect(parseOneBot12EventJson(serializeOneBot12Event(parsed))).toEqual(event);
        },
    );

    it('retains both extensions and event identities through a fake HTTP poll', async () => {
        const event = makeEvent();
        const envelope = {
            status: 'ok',
            retcode: 0,
            message: '',
            data: [event],
            echo: 'synthetic-echo',
            'x.response': { source: 'memory' },
        };
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify(envelope)));
        const client = new OneBot12HttpClient({
            baseUrl: 'http://example.test/',
            fetch: fetchImpl,
        });
        const result = await client.getLatestEvents(
            { limit: 1, timeout: 0 },
            { self: event.self, echo: 'synthetic-echo' },
        );

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(result).toEqual(envelope);

        if (result.status !== 'ok') {
            throw new Error('Expected the synthetic successful response');
        }

        expect(result.data[0]['qq.invitor_id']).toBe('900719925474099305');
        expect(result.data[0].operator_id).toBe('900719925474099304');
        expect(result.data[0]['x.fixture']).toEqual(event['x.fixture']);
        const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(JSON.parse(String(init.body))).toEqual({
            action: 'get_latest_events',
            params: { limit: 1, timeout: 0 },
            self: event.self,
            echo: 'synthetic-echo',
        });
    });
});
