import type { PushMsg, PushMsgBody } from '@snowluma/proto-defs/message';
import type { GroupChange } from '@snowluma/proto-defs/notify';
import { protobuf_encode } from '@snowluma/proton';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import { GroupInviteTracker } from '@snowluma/protocol/group-invite-tracker';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { parseDirectMsgPushOrThrow, SysMsgDedup } from '@snowluma/protocol/msg-push';
import { IncomingPacketPipeline } from '@snowluma/protocol/packet-pipeline';
import { describe, expect, it } from 'vitest';

import { registerEventPipeline } from '../../src/event-pipeline';
import type { OneBotInstanceContext } from '../../src/instance-context';
import { hashMessageIdInt32 } from '../../src/message-id';
import { createMessageIdResolver } from '../../src/message-id-resolver';
import { TempSessionStore } from '../../src/temp-session-store';
import type { JsonObject, MessageMeta } from '../../src/types';
import { convertV11Event } from '../../src/v12/events';

const COMMAND = 'trpc.msg.olpush.OlPushService.MsgPush';
const A = '2000000001';
const B = '2000000002';
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

// Generated from workspace schemas; no traffic or authenticated peer is involved.
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

function systemBody(): Uint8Array {
    return body({
        responseHead: { fromUin: 700, fromUid: '' },
        contentHead: { msgType: 33, subType: 0, sequence: 800, timestamp: 1700000000, msgId: 555 },
        body: {
            msgContent: protobuf_encode<GroupChange>({ groupUin: 700, memberUid: '2854207029' }),
        },
    });
}

function session(uin: string, gate: Promise<void>) {
    const identity = IdentityService.memory(uin);
    const dedup = new SysMsgDedup();
    const errors: unknown[] = [];
    const bus = new BridgeEventBus({ onError: (_kind, error) => errors.push(error) });
    const entered = deferred();
    const published: JsonObject[] = [];
    const v12: ReturnType<typeof convertV11Event>[] = [];
    const metas: Array<{ id: number; meta: MessageMeta }> = [];
    const sources: Array<string | undefined> = [];
    const ctx: OneBotInstanceContext = {
        uin,
        selfId: Number(uin),
        bridge: { events: bus } as never,
        messageStore: { isPrivateMessageRecalled: () => false } as never,
        mediaStore: {} as never,
        reactionStore: {} as never,
        tempSessions: new TempSessionStore(),
        converterCtx: {
            selfId: Number(uin),
            imageUrlResolver: null,
            mediaUrlResolver: null,
            messageIdResolver: createMessageIdResolver({
                resolvePrivateReplyMessageId: async () => null,
            }),
            mediaSegmentSink: null,
        },
        config: {
            networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
        } as never,
        getUptimeMs: () => 0,
        cacheMessageMeta: (id, meta) => {
            metas.push({ id, meta });
        },
        dispatchEvent: async (event, source) => {
            entered.resolve();
            await gate;
            sources.push(source);
            published.push(event);
            v12.push(convertV11Event(event, { platform: 'qq', user_id: uin }));
        },
    };
    const handle = registerEventPipeline(ctx);
    const pipeline = new IncomingPacketPipeline({
        identity,
        events: bus,
        fetchGroupList: async () => {},
        fetchGroupMemberList: async () => {},
        resolveGroupJoinRequest: async () => null,
        groupInvites: new GroupInviteTracker(),
    });
    const parse = (bytes: Uint8Array, account = uin) =>
        parseDirectMsgPushOrThrow(
            { uin: account, sequence: 91, command: COMMAND, retCode: 0, body: bytes },
            identity,
            dedup,
        );
    return {
        identity,
        bus,
        entered,
        published,
        v12,
        metas,
        sources,
        errors,
        handle,
        pipeline,
        parse,
    };
}

describe('direct decoded pushes through the real OneBot event pipeline', () => {
    it('isolates account buses and drains in-flight friend and group dispatches', async () => {
        const gate = deferred();
        const a = session(A, gate.promise);
        const b = session(B, gate.promise);
        const friend = friendBody();
        const group = groupBody();
        const system = systemBody();
        const trace = { serviceCmd: COMMAND, seqId: 91 };
        let aDrain: Promise<void> | undefined;
        let bDrain: Promise<void> | undefined;

        try {
            // Mismatch is rejected before decoding or dispatch. It does not consume B's dedup.
            expect(() => b.parse(friend, A)).toThrow('direct push identity UIN mismatch');
            expect(() => a.parse(friend, `0${A}`)).toThrow();
            expect(a.published).toEqual([]);
            expect(b.published).toEqual([]);

            const aEvents = a.parse(friend);
            const bEvents = b.parse(group);
            expect(aEvents).toMatchObject([{ kind: 'friend_message', selfUin: Number(A) }]);
            expect(bEvents).toMatchObject([{ kind: 'group_message', selfUin: Number(B) }]);
            await a.pipeline.processDecodedDirectEvents(trace, aEvents);
            await b.pipeline.processDecodedDirectEvents(trace, bEvents);
            friend.fill(0);
            group.fill(0);

            // System dedup keys exclude self UIN; each session must own its own tracker.
            expect(() => b.parse(system, A)).toThrow('direct push identity UIN mismatch');
            expect(a.parse(system)).toMatchObject([{ kind: 'group_member_join' }]);
            expect(a.parse(system)).toEqual([]);
            expect(b.parse(system)).toMatchObject([{ kind: 'group_member_join' }]);
            expect(b.parse(system)).toEqual([]);

            // The packet pipeline does not await its bus subscribers. Wait for the
            // actual OneBot dispatch to enter, then explicitly stop and drain it.
            await Promise.all([a.entered.promise, b.entered.promise]);
            expect(a.published).toEqual([]);
            expect(b.published).toEqual([]);
            await expect(a.handle.drain()).rejects.toThrow('must be stopped');
            a.handle.stop();
            b.handle.stop();
            let drained = false;
            aDrain = a.handle.drain().then(() => {
                drained = true;
            });
            bDrain = b.handle.drain();
            await Promise.resolve();
            expect(drained).toBe(false);
            gate.resolve();
            await Promise.all([aDrain, bDrain]);

            const friendId = hashMessageIdInt32(63214, PEER, 'private_message_nt');
            const groupId = hashMessageIdInt32(120, GROUP, 'group_message');
            expect(a.published).toEqual([
                {
                    time: 1700000000,
                    self_id: Number(A),
                    post_type: 'message',
                    message_type: 'private',
                    sub_type: 'friend',
                    message_id: friendId,
                    message_seq: 32743,
                    user_id: PEER,
                    message: [{ type: 'text', data: { text: 'friend synthetic text' } }],
                    raw_message: 'friend synthetic text',
                    font: 0,
                    sender: { user_id: PEER, nickname: '', sex: 'unknown', age: 0 },
                },
            ]);
            expect(b.published).toEqual([
                {
                    time: 1700000120,
                    self_id: Number(B),
                    post_type: 'message',
                    message_type: 'group',
                    sub_type: 'normal',
                    message_id: groupId,
                    message_seq: 120,
                    group_id: GROUP,
                    group_name: '',
                    user_id: MEMBER,
                    message: [{ type: 'text', data: { text: 'group synthetic text' } }],
                    raw_message: 'group synthetic text',
                    font: 0,
                    sender: {
                        user_id: MEMBER,
                        nickname: 'Synthetic',
                        card: '',
                        role: 'member',
                        sex: 'unknown',
                        age: 0,
                    },
                    anonymous: null,
                },
            ]);
            expect(a.v12).toEqual([
                {
                    id: expect.any(String),
                    time: 1700000000,
                    type: 'message',
                    detail_type: 'private',
                    sub_type: '',
                    self: { platform: 'qq', user_id: A },
                    user_id: String(PEER),
                    message_id: String(friendId),
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
                    self: { platform: 'qq', user_id: B },
                    user_id: String(MEMBER),
                    group_id: String(GROUP),
                    message_id: String(groupId),
                    message: [{ type: 'text', data: { text: 'group synthetic text' } }],
                    alt_message: 'group synthetic text',
                },
            ]);
            expect(a.metas).toEqual([
                {
                    id: friendId,
                    meta: expect.objectContaining({
                        isGroup: false,
                        targetId: PEER,
                        sequence: 63214,
                        sequenceAuthoritative: true,
                        eventName: 'private_message_nt',
                        clientSequence: 32743,
                        random: 1,
                        privateDirection: 'incoming',
                        timestamp: 1700000000,
                    }),
                },
            ]);
            expect(b.metas).toEqual([
                {
                    id: groupId,
                    meta: expect.objectContaining({
                        isGroup: true,
                        targetId: GROUP,
                        sequence: 120,
                        sequenceAuthoritative: true,
                        eventName: 'group_message',
                        random: 5120,
                        timestamp: 1700000120,
                    }),
                },
            ]);
            expect(a.sources).toEqual(['bridge']);
            expect(b.sources).toEqual(['bridge']);
            expect(a.identity.findUinByUid('synthetic_peer')).toBe(PEER);
            expect(b.identity.findUinByUid('synthetic_peer')).toBeNull();
            expect(a.errors).toEqual([]);
            expect(b.errors).toEqual([]);

            // stop removed the real registrations, independently of the packet path.
            await a.pipeline.processDecodedDirectEvents(trace, aEvents);
            await b.pipeline.processDecodedDirectEvents(trace, bEvents);
            expect(a.published).toHaveLength(1);
            expect(b.published).toHaveLength(1);
        } finally {
            gate.resolve();
            a.handle.stop();
            b.handle.stop();
            await Promise.all([aDrain ?? a.handle.drain(), bDrain ?? b.handle.drain()]);
            a.bus.clear();
            b.bus.clear();
            await Promise.all([a.identity.close(), b.identity.close()]);
            friend.fill(0);
            group.fill(0);
            system.fill(0);
        }
    });
});
