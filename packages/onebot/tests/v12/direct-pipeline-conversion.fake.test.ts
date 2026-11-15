import type { PushMsg, PushMsgBody } from '@snowluma/proto-defs/message';
import { protobuf_encode } from '@snowluma/proton';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { GroupInviteTracker } from '@snowluma/protocol/group-invite-tracker';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { parseDirectMsgPushOrThrow } from '@snowluma/protocol/msg-push';
import { IncomingPacketPipeline } from '@snowluma/protocol/packet-pipeline';
import { describe, expect, it, vi } from 'vitest';

import { convertEvent, type ConverterContext } from '../../src/event-converter';
import { convertV11Event } from '../../src/v12/events';

const COMMAND = 'trpc.msg.olpush.OlPushService.MsgPush';
const ACCOUNT_A = '2000000001';
const ACCOUNT_B = '2000000002';
const PEER = 10001;
const GROUP = 9999;
const MEMBER = 222;

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

// Schema-generated synthetic messages, not captured traffic.
function body(message: PushMsgBody): Uint8Array {
    return protobuf_encode<PushMsg>({ message });
}

function friendBody(): Uint8Array {
    return body({
        responseHead: { fromUin: PEER, fromUid: 'synthetic_peer' },
        contentHead: {
            msgType: 166,
            sequence: 32743,
            ntMsgSeq: 63214,
            timestamp: 1700000000,
            msgId: 1,
        },
        body: { richText: { elems: [{ text: { str: 'friend synthetic text' } }] } },
    });
}

function groupBody(): Uint8Array {
    return body({
        responseHead: { fromUin: MEMBER, grp: { groupUin: GROUP, memberName: 'Synthetic' } },
        contentHead: { msgType: 82, sequence: 120, timestamp: 1700000120, msgId: 5120 },
        body: { richText: { elems: [{ text: { str: 'group synthetic text' } }] } },
    });
}

function account(uin: string, gate: Promise<void>) {
    const identity = IdentityService.memory(uin);
    const errors: unknown[] = [];
    const events = new BridgeEventBus({ onError: (_kind, error) => errors.push(error) });
    const messageIdResolver = vi.fn(() => -123);
    const context: ConverterContext = {
        selfId: Number(identity.uin),
        imageUrlResolver: null,
        mediaUrlResolver: null,
        messageIdResolver,
        mediaSegmentSink: null,
    };
    const pending: Promise<void>[] = [];
    const v11: Awaited<ReturnType<typeof convertEvent>>[] = [];
    const v12: ReturnType<typeof convertV11Event>[] = [];
    let entered = 0;
    let completed = 0;

    events.onAny((event: QQEventVariant) => {
        entered += 1;
        const task = (async () => {
            await gate;
            const converted = await convertEvent(context, event);
            v11.push(converted);
            v12.push(convertV11Event(converted, { platform: 'qq', user_id: identity.uin }));
            completed += 1;
        })();
        pending.push(task);
        return task;
    });

    const pipeline = new IncomingPacketPipeline({
        identity,
        events,
        fetchGroupList: async () => {},
        fetchGroupMemberList: async () => {},
        resolveGroupJoinRequest: async () => null,
        groupInvites: new GroupInviteTracker(),
    });
    return {
        identity,
        pipeline,
        messageIdResolver,
        pending,
        v11,
        v12,
        errors,
        counts: () => ({ entered, completed }),
    };
}

describe('direct synthetic text through the account bus and v12 conversion', () => {
    it('keeps two accounts isolated after caller-owned bodies are wiped before async conversion', async () => {
        const gate = deferred();
        const a = account(ACCOUNT_A, gate.promise);
        const b = account(ACCOUNT_B, gate.promise);
        const friend = friendBody();
        const group = groupBody();
        let settled: PromiseSettledResult<void>[] = [];

        try {
            const parsedFriend = parseDirectMsgPushOrThrow(
                { uin: ACCOUNT_A, sequence: 91, command: COMMAND, retCode: 0, body: friend },
                a.identity,
            );
            expect(parsedFriend).toMatchObject([
                { kind: 'friend_message', selfUin: Number(ACCOUNT_A) },
            ]);
            await a.pipeline.processDecodedDirectEvents(
                { serviceCmd: COMMAND, seqId: 91 },
                parsedFriend,
            );
            // This models only later asynchronous consumption, not synchronous parser
            // reentry or a callback wiping the buffer before parsing completes.
            friend.fill(0);
            expect(friend.every((value) => value === 0)).toBe(true);
            expect(a.counts()).toEqual({ entered: 1, completed: 0 });
            expect(b.counts()).toEqual({ entered: 0, completed: 0 });

            const parsedGroup = parseDirectMsgPushOrThrow(
                { uin: ACCOUNT_B, sequence: 92, command: COMMAND, retCode: 0, body: group },
                b.identity,
            );
            expect(parsedGroup).toMatchObject([
                { kind: 'group_message', selfUin: Number(ACCOUNT_B) },
            ]);
            await b.pipeline.processDecodedDirectEvents(
                { serviceCmd: COMMAND, seqId: 92 },
                parsedGroup,
            );
            group.fill(0);
            expect(group.every((value) => value === 0)).toBe(true);
            expect(a.counts()).toEqual({ entered: 1, completed: 0 });
            expect(b.counts()).toEqual({ entered: 1, completed: 0 });
            expect(a.v12).toEqual([]);
            expect(b.v12).toEqual([]);
        } finally {
            gate.resolve();
            // The pipeline promise does not drain subscribers; settle every tracked task
            // without masking an earlier assertion or parse error.
            settled = await Promise.allSettled([...a.pending, ...b.pending]);
        }

        expect(settled).toHaveLength(2);
        expect(settled.filter((result) => result.status === 'rejected')).toEqual([]);
        expect(a.counts()).toEqual({ entered: 1, completed: 1 });
        expect(b.counts()).toEqual({ entered: 1, completed: 1 });
        expect(a.errors).toEqual([]);
        expect(b.errors).toEqual([]);
        expect(a.identity.findUinByUid('synthetic_peer')).toBe(PEER);
        expect(b.identity.findUinByUid('synthetic_peer')).toBeNull();
        expect(a.messageIdResolver).toHaveBeenCalledExactlyOnceWith(
            false,
            PEER,
            63214,
            'private_message_nt',
            undefined,
        );
        expect(b.messageIdResolver).toHaveBeenCalledExactlyOnceWith(
            true,
            GROUP,
            120,
            'group_message',
            undefined,
        );
        expect(a.v11).toMatchObject([
            {
                self_id: Number(ACCOUNT_A),
                user_id: PEER,
                message_id: -123,
                message: [{ type: 'text', data: { text: 'friend synthetic text' } }],
            },
        ]);
        expect(b.v11).toMatchObject([
            {
                self_id: Number(ACCOUNT_B),
                user_id: MEMBER,
                group_id: GROUP,
                message_id: -123,
                message: [{ type: 'text', data: { text: 'group synthetic text' } }],
            },
        ]);
        expect(a.v12).toEqual([
            {
                id: expect.any(String),
                time: 1700000000,
                type: 'message',
                detail_type: 'private',
                sub_type: '',
                self: { platform: 'qq', user_id: ACCOUNT_A },
                user_id: String(PEER),
                message_id: '-123',
                message: [{ type: 'text', data: { text: 'friend synthetic text' } }],
                alt_message: 'friend synthetic text',
            },
        ]);
        expect(b.v12).toEqual([
            {
                id: expect.any(String),
                time: 1700000120,
                type: 'message',
                detail_type: 'group',
                sub_type: '',
                self: { platform: 'qq', user_id: ACCOUNT_B },
                user_id: String(MEMBER),
                group_id: String(GROUP),
                message_id: '-123',
                message: [{ type: 'text', data: { text: 'group synthetic text' } }],
                alt_message: 'group synthetic text',
            },
        ]);
    });
});
