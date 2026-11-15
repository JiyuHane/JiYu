import { subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import type { NotifyMessageBody, RecallMessage } from '@snowluma/proto-defs/notify';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { decodeEvent0x2DC } from '@snowluma/protocol/msg-push/decoders/event-0x2dc';
import type { MsgPushContext } from '@snowluma/protocol/msg-push/context';
import { describe, expect, it, vi } from 'vitest';
import { convertEvent } from '../../src/event-converter';
import { createMessageIdResolver } from '../../src/message-id-resolver';
import { GROUP_MESSAGE_EVENT } from '../../src/message-id';
import { convertV11Event } from '../../src/v12/events';

const groupId = 43;
const headTime = 1700000100;
const self = { platform: 'qq', user_id: '10001' };
const messages: RecallMessage[] = [
    { sequence: 101, time: 1700000001, authorUid: 'u_operator' },
    { sequence: 202, time: 1700000002, authorUid: 'u_author' },
];

function identity(account = '10001', operator = 42, author = 44) {
    const result = IdentityService.memory(account);
    result.rememberGroups([
        {
            groupId,
            groupName: 'fixture',
            remark: '',
            memberCount: 2,
            memberMax: 100,
            members: new Map(),
        },
    ]);
    result.rememberRequestIdentity({ uid: 'u_operator', uin: operator });
    result.rememberRequestIdentity({ uid: 'u_author', uin: author });
    return result;
}

function content(notify: NotifyMessageBody): Uint8Array {
    const payload = protobuf_encode<NotifyMessageBody>(notify);

    if (payload.length > 0xffff) {
        throw new Error('fixture payload is too long');
    }

    const result = new Uint8Array(7 + payload.length);
    result[5] = payload.length >>> 8;
    result[6] = payload.length & 0xff;
    result.set(payload, 7);
    return result;
}

function ctx(bytes: Uint8Array, account = '10001', id = identity(account)): MsgPushContext {
    return {
        head: {
            msgType: 0x2dc,
            subType: 17,
            c2cCmd: 0,
            sequence: 0,
            ntMsgSeq: 0,
            timestamp: headTime,
            msgId: 0,
        },
        fromUin: groupId,
        fromUid: '',
        selfUin: Number(account),
        content: bytes,
        body: undefined,
        responseHead: undefined,
        identity: id,
        isHistorical: false,
    };
}

function notify(items: RecallMessage[], operatorUid = 'u_operator'): NotifyMessageBody {
    return { groupUin: groupId, recall: { operatorUid, recallMessages: items } };
}

function converter(account = 10001) {
    const privateLookup = vi.fn(async () => null);
    const resolver = createMessageIdResolver({ resolvePrivateReplyMessageId: privateLookup });
    return {
        privateLookup,
        resolver,
        context: {
            selfId: account,
            imageUrlResolver: null,
            mediaUrlResolver: null,
            messageIdResolver: resolver,
            mediaSegmentSink: null,
        },
    };
}

describe('synthetic multi group recall: protobuf to OneBot', () => {
    it('decodes two occurrences in order and converts each without extra fields or mutation', async () => {
        const bytes = content(notify(messages));
        expect((bytes[5] << 8) | bytes[6]).toBe(bytes.length - 7);
        const beforeBytes = [...bytes];
        const decoded = decodeEvent0x2DC(ctx(bytes));
        expect(decoded).toEqual([
            {
                kind: 'group_recall',
                time: 1700000001,
                selfUin: 10001,
                groupId,
                operatorUin: 42,
                authorUin: 42,
                msgSeq: 101,
            },
            {
                kind: 'group_recall',
                time: 1700000002,
                selfUin: 10001,
                groupId,
                operatorUin: 42,
                authorUin: 44,
                msgSeq: 202,
            },
        ]);
        const beforeEvents = structuredClone(decoded);
        const { context, resolver, privateLookup } = converter();
        const outputs = [];

        for (const [index, event] of decoded.entries()) {
            const v11 = await convertEvent(context, event);
            const expectedId = await resolver(
                true,
                groupId,
                messages[index].sequence!,
                GROUP_MESSAGE_EVENT,
            );
            expect(expectedId).toEqual(expect.any(Number));
            expect(expectedId).not.toBe(0);
            expect(v11).toEqual({
                time: messages[index].time,
                self_id: 10001,
                post_type: 'notice',
                notice_type: 'group_recall',
                group_id: groupId,
                operator_id: 42,
                user_id: index === 0 ? 42 : 44,
                message_id: expectedId,
            });
            const beforeV11 = structuredClone(v11);
            const v12 = convertV11Event(v11, self);
            expect(v12).toEqual({
                id: expect.any(String),
                time: messages[index].time,
                type: 'notice',
                detail_type: 'group_message_delete',
                sub_type: index === 0 ? 'recall' : '',
                self,
                group_id: '43',
                operator_id: '42',
                user_id: index === 0 ? '42' : '44',
                message_id: String(expectedId),
            });
            expect(v12!.self).not.toBe(self);
            expect(v11).toEqual(beforeV11);
            expect(() => convertV11Event({ ...v11, extra: false }, self)).toThrow();
            expect(() => convertV11Event(v11, { ...self, user_id: '10002' })).toThrow();
            outputs.push(v12);
        }

        expect(outputs[0]!.id).not.toBe(outputs[1]!.id);
        expect(privateLookup).not.toHaveBeenCalled();
        expect(decoded).toEqual(beforeEvents);
        expect([...bytes]).toEqual(beforeBytes);
        expect(self).toEqual({ platform: 'qq', user_id: '10001' });
    });

    it('preserves empty, single and many occurrences and the original single semantics', () => {
        expect(decodeEvent0x2DC(ctx(content(notify([]))))).toEqual([]);
        expect(decodeEvent0x2DC(ctx(content({ groupUin: groupId })))).toEqual([]);
        const single = decodeEvent0x2DC(ctx(content(notify(messages.slice(0, 1)))));
        expect(single).toEqual([
            {
                kind: 'group_recall',
                time: 1700000001,
                selfUin: 10001,
                groupId,
                operatorUin: 42,
                authorUin: 42,
                msgSeq: 101,
            },
        ]);
        const many = [
            ...messages,
            { sequence: 303, time: 1700000003, authorUid: 'u_author' },
            { sequence: 404, time: 1700000004, authorUid: 'u_operator' },
        ];
        expect(decodeEvent0x2DC(ctx(content(notify(many))))).toEqual([
            ...single,
            {
                kind: 'group_recall',
                time: 1700000002,
                selfUin: 10001,
                groupId,
                operatorUin: 42,
                authorUin: 44,
                msgSeq: 202,
            },
            {
                kind: 'group_recall',
                time: 1700000003,
                selfUin: 10001,
                groupId,
                operatorUin: 42,
                authorUin: 44,
                msgSeq: 303,
            },
            {
                kind: 'group_recall',
                time: 1700000004,
                selfUin: 10001,
                groupId,
                operatorUin: 42,
                authorUin: 42,
                msgSeq: 404,
            },
        ]);
    });

    it('uses outer operator only when the recall operator is absent or empty', () => {
        for (const operatorUid of [undefined, '']) {
            const body: NotifyMessageBody = {
                groupUin: groupId,
                operatorUid: 'u_author',
                recall: { operatorUid, recallMessages: messages },
            };
            expect(
                decodeEvent0x2DC(ctx(content(body))).map(
                    (event) => event.kind === 'group_recall' && event.operatorUin,
                ),
            ).toEqual([44, 44]);
        }

        const body: NotifyMessageBody = {
            groupUin: groupId,
            operatorUid: 'u_author',
            recall: { operatorUid: 'u_unknown', recallMessages: messages },
        };
        expect(
            decodeEvent0x2DC(ctx(content(body))).map(
                (event) => event.kind === 'group_recall' && event.operatorUin,
            ),
        ).toEqual([0, 0]);
    });

    it('does not invent a missing author; the other event can be converted separately', async () => {
        const decoded = decodeEvent0x2DC(
            ctx(content(notify([{ sequence: 101, time: 1 }, messages[1]]))),
        );
        expect(decoded).toHaveLength(2);
        expect(decoded[0]).toMatchObject({ authorUin: 0, msgSeq: 101 });
        const { context } = converter();
        const invalid = await convertEvent(context, decoded[0]);
        expect(invalid).toMatchObject({ user_id: 0 });
        expect(() => convertV11Event(invalid, self)).toThrow();
        // This is an independent call, not a claim that the live pipeline continues after an error.
        const valid = await convertEvent(context, decoded[1]);
        expect(convertV11Event(valid, self)).toMatchObject({ user_id: '44', sub_type: '' });
    });

    it('preserves the zero-sequence fallback as a generated OneBot ID, not a real QQ ID', async () => {
        const input = ctx(content(notify([{ time: 1, authorUid: 'u_author' }, messages[0]])));
        const captured: LogEntry[] = [];
        const unsubscribe = subscribeLogs((entry) => captured.push(entry));
        let decoded;

        try {
            decoded = decodeEvent0x2DC(input);
        } finally {
            unsubscribe();
        }

        expect(captured).toEqual([]);
        expect(decoded).toHaveLength(2);
        expect(decoded[0]).toMatchObject({ msgSeq: 0, authorUin: 44 });
        const { context, resolver } = converter();
        const v11 = await convertEvent(context, decoded[0]);
        const generated = await resolver(true, groupId, 0, GROUP_MESSAGE_EVENT);
        expect(v11).toMatchObject({ message_id: generated });
        expect(convertV11Event(v11, self)).toMatchObject({ message_id: String(generated) });
        expect(convertV11Event(await convertEvent(context, decoded[1]), self)).toMatchObject({
            user_id: '42',
        });
    });

    it('skips a later missing sequence once, preserving the valid neighbors through v11 and v12', async () => {
        const bytes = content(
            notify([messages[0], { time: 77, authorUid: 'u_author' }, messages[1]]),
        );
        const input = ctx(bytes);
        const captured: LogEntry[] = [];
        const unsubscribe = subscribeLogs((entry) => captured.push(entry));
        let decoded;

        try {
            decoded = decodeEvent0x2DC(input);
        } finally {
            unsubscribe();
        }

        expect(decoded).toEqual([
            {
                kind: 'group_recall',
                time: 1700000001,
                selfUin: 10001,
                groupId,
                operatorUin: 42,
                authorUin: 42,
                msgSeq: 101,
            },
            {
                kind: 'group_recall',
                time: 1700000002,
                selfUin: 10001,
                groupId,
                operatorUin: 42,
                authorUin: 44,
                msgSeq: 202,
            },
        ]);
        expect(captured.map(({ level, scope, message }) => ({ level, scope, message }))).toEqual([
            {
                level: 'warn',
                scope: 'MsgPush.Unknown',
                message: 'group recall skipped additional entries with missing sequence count=1',
            },
        ]);
        const { context, resolver, privateLookup } = converter();
        const tracked = vi.fn(resolver);

        for (const [index, event] of decoded.entries()) {
            const v11 = await convertEvent({ ...context, messageIdResolver: tracked }, event);
            const expectedId = await resolver(
                true,
                groupId,
                messages[index].sequence!,
                GROUP_MESSAGE_EVENT,
            );
            expect(v11).toMatchObject({ message_id: expectedId, user_id: index === 0 ? 42 : 44 });
            expect(convertV11Event(v11, self)).toMatchObject({
                message_id: String(expectedId),
                user_id: index === 0 ? '42' : '44',
                sub_type: index === 0 ? 'recall' : '',
            });
        }

        expect(tracked.mock.calls.map((args) => args[2])).toEqual([101, 202]);
        expect(privateLookup).not.toHaveBeenCalled();
    });

    it('aggregates multiple later missing sequences into one warning', () => {
        const input = ctx(
            content(
                notify([
                    messages[0],
                    { authorUid: 'u_author' },
                    { authorUid: 'u_operator' },
                    messages[1],
                ]),
            ),
        );
        const captured: LogEntry[] = [];
        const unsubscribe = subscribeLogs((entry) => captured.push(entry));
        let decoded;

        try {
            decoded = decodeEvent0x2DC(input);
        } finally {
            unsubscribe();
        }

        expect(decoded.map((event) => event.kind === 'group_recall' && event.msgSeq)).toEqual([
            101, 202,
        ]);
        expect(captured.map(({ level, scope, message }) => ({ level, scope, message }))).toEqual([
            {
                level: 'warn',
                scope: 'MsgPush.Unknown',
                message: 'group recall skipped additional entries with missing sequence count=2',
            },
        ]);
    });

    it('returns the valid events if a warning subscriber throws', async () => {
        const input = ctx(content(notify([messages[0], { authorUid: 'u_author' }, messages[1]])));
        const subscriber = vi.fn((entry: LogEntry) => {
            if (entry.scope === 'MsgPush.Unknown' && entry.level === 'warn') {
                throw new Error('synthetic log subscriber failure');
            }
        });
        const unsubscribe = subscribeLogs(subscriber);
        let decoded;

        try {
            decoded = decodeEvent0x2DC(input);
        } finally {
            unsubscribe();
        }

        expect(subscriber).toHaveBeenCalledOnce();
        expect(decoded.map((event) => event.kind === 'group_recall' && event.msgSeq)).toEqual([
            101, 202,
        ]);
        const { context } = converter();

        for (const event of decoded) {
            expect(convertV11Event(await convertEvent(context, event), self)).toMatchObject({
                detail_type: 'group_message_delete',
            });
        }
    });

    it('distinguishes account-local identity mappings and validates each self', async () => {
        const bytes = content(notify(messages));
        const first = decodeEvent0x2DC(ctx(bytes));
        const second = decodeEvent0x2DC(ctx(bytes, '10002', identity('10002', 142, 144)));
        expect(second).toMatchObject([
            { selfUin: 10002, operatorUin: 142, authorUin: 142 },
            { selfUin: 10002, operatorUin: 142, authorUin: 144 },
        ]);
        expect(first).toMatchObject([
            { selfUin: 10001, operatorUin: 42, authorUin: 42 },
            { selfUin: 10001, operatorUin: 42, authorUin: 44 },
        ]);
        const v11 = await convertEvent(converter(10002).context, second[1]);
        expect(() => convertV11Event(v11, self)).toThrow();
        expect(convertV11Event(v11, { platform: 'qq', user_id: '10002' })).toMatchObject({
            user_id: '144',
            operator_id: '142',
            sub_type: '',
        });
    });

    it('documents Proton zero omission separately from missing-time decoder behavior', () => {
        const zero = content(notify([{ sequence: 1, time: 0, authorUid: 'u_author' }]));
        const missing = content(notify([{ sequence: 1, authorUid: 'u_author' }]));
        // Proton's ordinary encoder omits scalar zero; this is not an explicit-zero wire test.
        expect([...zero]).toEqual([...missing]);
        expect(
            protobuf_decode<NotifyMessageBody>(zero.subarray(7)).recall?.recallMessages?.[0].time,
        ).toBeNull();
        expect(decodeEvent0x2DC(ctx(missing))).toMatchObject([{ time: headTime }]);
        // For an explicitly present decoded zero, nullish fallback preserves zero.
        const decodedStruct: RecallMessage = { time: 0 };
        expect(decodedStruct.time ?? headTime).toBe(0);
        expect(({} as RecallMessage).time ?? headTime).toBe(headTime);
    });

    it('distinguishes explicit wire zero time and skips a later explicit wire zero sequence', () => {
        // Fixed protobuf fixture: group=43; recall occurrences: (seq=101,time=0),
        // (seq=0), (seq=102). Tags follow notify.ts; Proton normally omits scalar zero.
        const bytes = Uint8Array.from([
            0, 0, 0, 0, 0, 0, 18, 0x20, 0x2b, 0x5a, 0x0e, 0x1a, 0x04, 0x08, 0x65, 0x10, 0x00, 0x1a,
            0x02, 0x08, 0x00, 0x1a, 0x02, 0x08, 0x66,
        ]);
        const parsed = protobuf_decode<NotifyMessageBody>(bytes.subarray(7));
        expect(parsed.recall?.recallMessages?.map((item) => item.sequence)).toEqual([101, 0, 102]);
        expect(parsed.recall?.recallMessages?.[0].time).toBe(0);
        expect(parsed.recall?.recallMessages?.[2].time).toBeNull();
        const input = ctx(bytes);
        const captured: LogEntry[] = [];
        const unsubscribe = subscribeLogs((entry) => captured.push(entry));
        let decoded;

        try {
            decoded = decodeEvent0x2DC(input);
        } finally {
            unsubscribe();
        }

        expect(decoded).toMatchObject([
            { msgSeq: 101, time: 0 },
            { msgSeq: 102, time: headTime },
        ]);
        expect(captured.map(({ level, scope, message }) => ({ level, scope, message }))).toEqual([
            {
                level: 'warn',
                scope: 'MsgPush.Unknown',
                message: 'group recall skipped additional entries with missing sequence count=1',
            },
        ]);
    });

    it('propagates malformed protobuf errors rather than dropping occurrences', () => {
        const bytes = new Uint8Array([0, 0, 0, 0, 0, 0, 2, 0x5a, 0x80]);
        expect(() => decodeEvent0x2DC(ctx(bytes))).toThrow();
    });
});
