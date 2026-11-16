import { describe, expect, it } from 'vitest';
import { parseOneBot12Event, parseOneBot12EventJson } from '../../../sdk/src/v12/protocol';
import { convertEvent } from '../../src/event-converter';
import {
    convertV11Event,
    createConnectEvent,
    createHeartbeatEvent,
    createStatusUpdateEvent,
} from '../../src/v12/events';

const self = { platform: 'qq', user_id: '10001' };
const message = {
    self_id: 10001,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: -123,
    group_id: 43,
    user_id: 42,
    message: [{ type: 'text', data: { text: 'synthetic' } }],
    raw_message: 'synthetic',
};
const privateMessage = { ...message, message_type: 'private', sub_type: 'friend' };
const notice = { self_id: 10001, post_type: 'notice', user_id: 42 };
const sources = [
    { name: 'group received', value: message, error: 'invalid V11 message event' },
    {
        name: 'group self-sent',
        value: { ...message, post_type: 'message_sent', user_id: 10001 },
        error: 'invalid V11 message event',
    },
    { name: 'private received', value: privateMessage, error: 'invalid V11 message event' },
    {
        name: 'private self-sent',
        value: { ...privateMessage, post_type: 'message_sent', user_id: 10001, target_id: 42 },
        error: 'invalid V11 message event',
    },
    {
        name: 'friend increase',
        value: { ...notice, notice_type: 'friend_add' },
        error: 'invalid or unsupported V11 friend add event',
    },
    {
        name: 'group increase',
        value: {
            ...notice,
            notice_type: 'group_increase',
            sub_type: 'invite',
            group_id: 43,
            operator_id: 44,
            invitor_id: 0,
            invitor_status: 'unknown',
        },
        error: 'invalid or unsupported V11 group increase event',
    },
    {
        name: 'group decrease',
        value: {
            ...notice,
            notice_type: 'group_decrease',
            sub_type: 'leave',
            group_id: 43,
            operator_id: 44,
        },
        error: 'invalid or unsupported V11 group decrease event',
    },
    {
        name: 'group recall',
        value: {
            ...notice,
            notice_type: 'group_recall',
            group_id: 43,
            operator_id: 44,
            message_id: -123,
        },
        error: 'invalid or unsupported V11 group recall event',
    },
];
const validTimes = [
    0,
    Number.MIN_VALUE,
    0.5,
    1700000000.25,
    2 ** 51 + 0.5,
    Number.MAX_SAFE_INTEGER,
];
const invalidTimes = [
    -1,
    -Number.MIN_VALUE,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    1e20,
];

function expectSdkRoundTrip(event: unknown, time: number) {
    expect(event).toMatchObject({ time });
    expect(parseOneBot12Event(event)).toEqual(event);
    expect(parseOneBot12EventJson(JSON.stringify(event))).toEqual(event);
}

describe('synthetic V12 event time JSON compatibility', () => {
    it.each(sources)('accepts and serializes valid times for $name', ({ value }) => {
        for (const time of validTimes) {
            const input = { ...value, time };
            const event = convertV11Event(input, self);
            expectSdkRoundTrip(event, time);
            expect(input.time).toBe(time);
        }
    });

    it.each(sources)(
        'rejects invalid times with the existing error for $name',
        ({ value, error }) => {
            for (const time of invalidTimes) {
                expect(() => convertV11Event({ ...value, time }, self)).toThrow(error);
            }

            for (const time of [undefined, null, '1']) {
                expect(() => convertV11Event({ ...value, time }, self)).toThrow(error);
            }
        },
    );

    it('shows that the SDK rejects the original unsafe JSON number', () => {
        const event = convertV11Event({ ...message, time: 1 }, self)!;
        const unsafe = { ...event, time: 1e20 };
        expect(() => parseOneBot12Event(unsafe)).toThrow(TypeError);
        expect(() => parseOneBot12EventJson(JSON.stringify(unsafe))).toThrow(TypeError);
    });

    it('applies the same time policy to independently constructed meta events', () => {
        const factories = [
            {
                make: (time: number) => createConnectEvent({ impl: 'fake', version: '1' }, time),
                error: 'invalid V12 connect event inputs',
            },
            {
                make: (time: number) => createHeartbeatEvent(1000, time),
                error: 'invalid V12 heartbeat event inputs',
            },
            {
                make: (time: number) =>
                    createStatusUpdateEvent(self, { good: true, online: true }, time),
                error: 'invalid V12 status event inputs',
            },
        ];

        for (const { make, error } of factories) {
            for (const time of validTimes) {
                expectSdkRoundTrip(make(time), time);
            }

            for (const time of invalidTimes) {
                expect(() => make(time)).toThrow(error);
            }
        }
    });

    it('preserves the independent V11 conversion for synthetic oversized timestamps', async () => {
        const context = {
            selfId: 10001,
            imageUrlResolver: null,
            mediaUrlResolver: null,
            messageIdResolver: () => -123,
            mediaSegmentSink: null,
        };
        const event = {
            kind: 'group_message' as const,
            time: 1e20,
            selfUin: 10001,
            groupId: 43,
            groupName: 'synthetic group',
            senderUin: 42,
            senderNick: 'synthetic sender',
            senderCard: '',
            senderRole: 'member',
            msgSeq: 1,
            msgId: 1,
            elements: [{ type: 'text' as const, text: 'synthetic' }],
        };
        const v11 = await convertEvent(context, event);
        expect(v11).toMatchObject({ time: 1e20, post_type: 'message' });
        expect(() => convertV11Event(v11, self)).toThrow('invalid V11 message event');
        expect(v11).toMatchObject({ time: 1e20, post_type: 'message' });

        const v11Notice = await convertEvent(context, {
            kind: 'friend_add',
            time: 1e20,
            selfUin: 10001,
            userUin: 42,
        });
        expect(v11Notice).toMatchObject({ time: 1e20, notice_type: 'friend_add' });
        expect(() => convertV11Event(v11Notice, self)).toThrow(
            'invalid or unsupported V11 friend add event',
        );
        expect(v11Notice).toMatchObject({ time: 1e20, notice_type: 'friend_add' });
    });
});
