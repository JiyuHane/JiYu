import { describe, expect, it } from 'vitest';
import { convertEvent } from '../../src/event-converter';
import { GROUP_MESSAGE_EVENT, hashMessageIdInt32 } from '../../src/message-id';
import { createMessageIdResolver } from '../../src/message-id-resolver';
import { convertV11Event } from '../../src/v12/events';

const self = { platform: 'qq', user_id: '10001' };
const groupRecall = {
    time: 1700000000.5,
    self_id: 10001,
    post_type: 'notice',
    notice_type: 'group_recall',
    group_id: 43,
    operator_id: 42,
    user_id: 42,
    message_id: -123,
};

const context = {
    selfId: 10001,
    imageUrlResolver: null,
    mediaUrlResolver: null,
    messageIdResolver: () => -123,
    mediaSegmentSink: null,
};

describe('v11 group recall to v12 group message deletion', () => {
    it('maps the real v11 converter output with both actors and no input mutation', async () => {
        const v11 = await convertEvent(context, {
            kind: 'group_recall',
            time: 1700000000.5,
            selfUin: 10001,
            groupId: 43,
            operatorUin: 42,
            authorUin: 42,
            msgSeq: 1,
        });
        expect(v11).toEqual(groupRecall);
        const before = structuredClone(v11);
        const result = convertV11Event(v11, self);
        expect(result).toEqual({
            id: expect.any(String),
            time: 1700000000.5,
            type: 'notice',
            detail_type: 'group_message_delete',
            sub_type: 'recall',
            self,
            group_id: '43',
            message_id: '-123',
            user_id: '42',
            operator_id: '42',
        });
        expect(result!.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(convertV11Event(v11, self)!.id).not.toBe(result!.id);
        expect(v11).toEqual(before);
    });

    it('does not infer administrator status from a different operator', () => {
        expect(convertV11Event({ ...groupRecall, operator_id: '44' }, self)).toMatchObject({
            type: 'notice',
            detail_type: 'group_message_delete',
            sub_type: '',
            user_id: '42',
            operator_id: '44',
        });
        expect(convertV11Event({ ...groupRecall, operator_id: '42' }, self)).toMatchObject({
            sub_type: 'recall',
        });
    });

    it('preserves canonical signed int32 message IDs and canonical safe account IDs', () => {
        for (const value of [
            -2147483648,
            '-2147483648',
            -1,
            '-1',
            1,
            '1',
            2147483647,
            '2147483647',
        ]) {
            expect(convertV11Event({ ...groupRecall, message_id: value }, self)).toMatchObject({
                message_id: String(value),
            });
        }

        for (const value of [1, '1', Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) {
            expect(
                convertV11Event(
                    { ...groupRecall, group_id: value, user_id: value, operator_id: value },
                    self,
                ),
            ).toMatchObject({
                group_id: String(value),
                user_id: String(value),
                operator_id: String(value),
                sub_type: 'recall',
            });
        }

        expect(convertV11Event({ ...groupRecall, self_id: '10001', time: 0 }, self)).toMatchObject({
            self,
            time: 0,
        });
    });

    it('rejects missing, noncanonical, unsafe or otherwise invalid identifiers', () => {
        const invalidAccounts = [
            undefined,
            null,
            0,
            '0',
            -1,
            '-1',
            '01',
            ' 42',
            '42 ',
            '1e3',
            1.5,
            NaN,
            Infinity,
            Number.MAX_SAFE_INTEGER + 1,
            '9007199254740992',
            false,
            {},
        ];

        for (const field of ['group_id', 'user_id', 'operator_id'] as const) {
            for (const value of invalidAccounts) {
                expect(() => convertV11Event({ ...groupRecall, [field]: value }, self)).toThrow();
            }
        }

        for (const value of [
            undefined,
            null,
            0,
            '0',
            '-0',
            '01',
            '-01',
            -2147483649,
            2147483648,
            '2147483648',
            1.5,
            NaN,
            Infinity,
            '1e3',
            false,
            {},
        ]) {
            expect(() => convertV11Event({ ...groupRecall, message_id: value }, self)).toThrow();
        }

        for (const value of [
            undefined,
            null,
            0,
            '010001',
            10002,
            '10002',
            Number.MAX_SAFE_INTEGER + 1,
        ]) {
            expect(() => convertV11Event({ ...groupRecall, self_id: value }, self)).toThrow();
        }

        expect(() => convertV11Event(groupRecall, { ...self, user_id: '010001' })).toThrow();
        expect(() => convertV11Event(groupRecall, { ...self, user_id: '10002' })).toThrow();
    });

    it('rejects invalid time, all v11 subtype extensions and unknown fields', () => {
        for (const time of [undefined, null, -1, NaN, Infinity, -Infinity, '1700000000']) {
            expect(() => convertV11Event({ ...groupRecall, time }, self)).toThrow();
        }

        // The production v11 group_recall converter emits no sub_type at all.
        for (const sub_type of [undefined, '', 'recall', 'delete', 'unknown', null, 0]) {
            expect(() => convertV11Event({ ...groupRecall, sub_type }, self)).toThrow();
        }

        expect(() => convertV11Event({ ...groupRecall, extra: false }, self)).toThrow();
        expect(() => convertV11Event({ ...groupRecall, [Symbol('extra')]: 1 }, self)).toThrow();
    });

    it('keeps other notices unsupported and checks account before ignoring them', () => {
        for (const notice_type of [
            'friend_recall',
            'group_increase',
            'group_decrease',
            'notify',
            'future',
        ]) {
            expect(convertV11Event({ ...groupRecall, notice_type }, self)).toBeNull();
        }

        expect(convertV11Event({ self_id: 10001, post_type: 'notice' }, self)).toBeNull();
        expect(() =>
            convertV11Event({ ...groupRecall, notice_type: 'friend_recall', self_id: 10002 }, self),
        ).toThrow();
    });

    it('only preserves the v11-visible ID even when the source sequence is missing', async () => {
        const resolver = createMessageIdResolver({
            resolvePrivateReplyMessageId: async () => null,
        });
        const v11 = await convertEvent(
            { ...context, messageIdResolver: resolver },
            {
                kind: 'group_recall',
                time: 1,
                selfUin: 10001,
                groupId: 43,
                operatorUin: 42,
                authorUin: 42,
                // The decoder uses zero when the upstream sequence is absent.
                msgSeq: 0,
            },
        );
        const id = hashMessageIdInt32(0, 43, GROUP_MESSAGE_EVENT);
        expect(v11).toMatchObject({ message_id: id });
        expect(convertV11Event(v11, self)).toMatchObject({ message_id: String(id) });
    });
});
