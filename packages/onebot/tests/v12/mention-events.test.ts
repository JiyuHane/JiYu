import { describe, expect, it } from 'vitest';
import { convertEvent } from '../../src/event-converter';
import { convertV11Event, V12UnsupportedEventError } from '../../src/v12/events';

const self = { platform: 'qq', user_id: '10001' };
const text = (value: string) => ({ type: 'text', data: { text: value } });
const at = (qq: unknown) => ({ type: 'at', data: { qq } });
const event = {
    time: 1700000000,
    self_id: 10001,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: -123,
    group_id: 43,
    user_id: 42,
    message: [text('hello')],
    raw_message: 'hello',
};

describe('v11 incoming mentions to v12', () => {
    it('keeps segment boundaries and order with an explicitly rendered alt_message', () => {
        const input = {
            ...event,
            message: [text('你好['), at('42'), text('] '), at('all'), text('!')],
            raw_message: 'ignored CQ encoding',
        };
        const before = structuredClone(input);
        const result = convertV11Event(input, self);

        expect(result).toMatchObject({
            detail_type: 'group',
            self,
            message_id: '-123',
            group_id: '43',
            user_id: '42',
            message: [
                text('你好['),
                { type: 'mention', data: { user_id: '42' } },
                text('] '),
                { type: 'mention_all', data: {} },
                text('!'),
            ],
            alt_message: '你好[@42] @全体成员!',
        });
        expect(input).toEqual(before);
    });

    it('handles private and group events, numeric IDs, canonical strings and all independently', () => {
        for (const [qq, expected] of [
            [42, '42'],
            ['42', '42'],
            [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)],
            [String(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER)],
        ] as const) {
            for (const privateEvent of [false, true]) {
                const input = {
                    ...event,
                    ...(privateEvent ? { message_type: 'private', sub_type: 'friend' } : {}),
                    message: [at(qq)],
                };
                expect(convertV11Event(input, self)).toMatchObject({
                    detail_type: privateEvent ? 'private' : 'group',
                    message: [{ type: 'mention', data: { user_id: expected } }],
                    alt_message: `@${expected}`,
                });
            }
        }

        expect(convertV11Event({ ...event, message: [at('all')] }, self)).toMatchObject({
            message: [{ type: 'mention_all', data: {} }],
            alt_message: '@全体成员',
        });
    });

    it('preserves text literally, even when it resembles CQ, and supports empty arrays', () => {
        const literal = '[CQ:at,qq=42] & &#91;,]';
        expect(
            convertV11Event(
                { ...event, message: [text(literal), text(' end')], raw_message: 'different' },
                self,
            ),
        ).toMatchObject({ message: [text(literal), text(' end')], alt_message: `${literal} end` });
        expect(convertV11Event({ ...event, message: [] }, self)).toMatchObject({
            message: [],
            alt_message: '',
        });
    });

    it('fails closed on unknown, ambiguous or noncanonical mention identifiers', () => {
        for (const qq of [
            undefined,
            null,
            '',
            '0',
            0,
            -1,
            '01',
            ' 42',
            '42 ',
            'ALL',
            ' all',
            '1e3',
            1.5,
            NaN,
            Infinity,
            Number.MAX_SAFE_INTEGER + 1,
            '9007199254740992',
            'u_unknown',
            false,
            {},
        ]) {
            expect(() =>
                convertV11Event({ ...event, message: [text('before'), at(qq)] }, self),
            ).toThrow('unsupported or invalid V11 message segment');
        }
    });

    it('rejects unknown segment and data fields without dropping a partial message', () => {
        const invalid = [
            { type: 'at', data: { qq: '42', name: 'peer' } },
            { type: 'at', data: { qq: '42', uid: 'u_peer' } },
            { type: 'at', data: { qq: 'all', extra: false } },
            { type: 'at', data: { qq: '42' }, extra: false },
            { type: 'text', data: { text: 'hello', extra: false } },
            { type: 'image', data: { file: 'x' } },
            { type: 'at', data: {} },
            { type: 'at', data: null },
        ];

        for (const segment of invalid) {
            expect(() =>
                convertV11Event({ ...event, message: [at('42'), segment, text('after')] }, self),
            ).toThrow();
        }
    });

    it('keeps identity, message and subtype validation and self-sent behavior', () => {
        for (const invalid of [
            { ...event, self_id: 10002 },
            { ...event, user_id: undefined },
            { ...event, user_id: 0 },
            { ...event, user_id: '042' },
            { ...event, group_id: 0 },
            { ...event, message_id: 0 },
            { ...event, message_id: -2147483649 },
            { ...event, raw_message: undefined },
            { ...event, message_type: 'private', sub_type: 'group' },
        ]) {
            expect(() => convertV11Event({ ...invalid, message: [at('42')] }, self)).toThrow();
        }

        expect(() =>
            convertV11Event({ ...event, post_type: 'message_sent', message: [at('42')] }, self),
        ).toThrow(V12UnsupportedEventError);
        expect(convertV11Event({ ...event, post_type: 'notice' }, self)).toBeNull();
        expect(() => convertV11Event(event, { ...self, user_id: '010001' })).toThrow();
    });

    it('maps synthetic real v11 converter output without a store or network', async () => {
        const ctx = {
            selfId: 10001,
            imageUrlResolver: null,
            mediaUrlResolver: null,
            messageIdResolver: () => -123,
            mediaSegmentSink: null,
        };
        const v11 = await convertEvent(ctx, {
            kind: 'group_message',
            time: 1700000000,
            selfUin: 10001,
            groupId: 43,
            groupName: 'fixture',
            senderUin: 42,
            senderNick: 'peer',
            senderCard: '',
            senderRole: 'member',
            msgSeq: 1,
            msgId: 1,
            elements: [
                { type: 'text', text: '[A]&,' },
                { type: 'at', targetUin: 123, uid: 'u_target', text: '@display ' },
                { type: 'text', text: ' ' },
                { type: 'at', targetUin: 0, uid: 'all' },
            ],
        });
        expect(v11).toMatchObject({
            message: [text('[A]&,'), at('123'), text(' '), at('all')],
            raw_message: '&#91;A&#93;&amp;&#44;[CQ:at,qq=123] [CQ:at,qq=all]',
        });
        const before = structuredClone(v11);
        expect(convertV11Event(v11, self)).toMatchObject({
            message: [
                text('[A]&,'),
                { type: 'mention', data: { user_id: '123' } },
                text(' '),
                { type: 'mention_all', data: {} },
            ],
            alt_message: '[A]&,@123 @全体成员',
        });
        expect(v11).toEqual(before);
    });

    it('documents the upstream zero-UIN ambiguity rather than inventing a user ID', async () => {
        const v11 = await convertEvent(
            {
                selfId: 10001,
                imageUrlResolver: null,
                mediaUrlResolver: null,
                messageIdResolver: () => -123,
                mediaSegmentSink: null,
            },
            {
                kind: 'friend_message',
                time: 1700000000,
                selfUin: 10001,
                senderUin: 42,
                senderNick: 'peer',
                msgSeq: 1,
                msgId: 1,
                elements: [{ type: 'at', targetUin: 0, uid: 'u_unresolved' }],
            },
        );
        // The v11 codec has already collapsed zero UIN to `all`, losing the UID.
        expect(v11).toMatchObject({ message: [at('all')] });
        expect(convertV11Event(v11, self)).toMatchObject({
            message: [{ type: 'mention_all', data: {} }],
        });
    });
});
