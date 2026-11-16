import type { PushMsg, PushMsgBody } from '@snowluma/proto-defs/message';
import { protobuf_encode } from '@snowluma/proton';
import { createDirectPushIngress } from '@snowluma/protocol/direct/direct-push-ingress';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import { GroupInviteTracker } from '@snowluma/protocol/group-invite-tracker';
import { IdentityService } from '@snowluma/protocol/identity-service';
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

async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('synthetic ingress watchdog')), 2000);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

// These bytes come from schemas, not a peer or a captured account.
function encode(message: PushMsgBody): Uint8Array {
    return protobuf_encode<PushMsg>({ message });
}

function friendBody(): Uint8Array {
    return encode({
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
    return encode({
        responseHead: { fromUin: MEMBER, grp: { groupUin: GROUP, memberName: 'Synthetic' } },
        contentHead: { msgType: 82, sequence: 120, timestamp: 1700000120, msgId: 5120 },
        body: { richText: { elems: [{ text: { str: 'group synthetic text' } }] } },
    });
}

function session(uin: string) {
    const identity = IdentityService.memory(uin);
    const errors: unknown[] = [];
    const bus = new BridgeEventBus({ onError: (_kind, error) => errors.push(error) });
    const entered = deferred();
    const gate = deferred();
    const published: JsonObject[] = [];
    const v12: ReturnType<typeof convertV11Event>[] = [];
    const metas: Array<{ id: number; meta: MessageMeta }> = [];
    const sources: Array<string | undefined> = [];
    const resolver = createMessageIdResolver({ resolvePrivateReplyMessageId: async () => null });
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
            messageIdResolver: resolver,
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
            await gate.promise;
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
    // These two flags are fixture caller commitments, not authentication evidence.
    const ingress = createDirectPushIngress({
        uin,
        identity,
        pipeline,
        pipelineIdentityBound: true,
        sourceAuthenticationHandled: true,
        maxBodyBytes: 65536,
        maxPendingBytes: 262144,
        maxPending: 8,
        maxEventsPerPush: 16,
    });
    return {
        identity,
        bus,
        entered,
        gate,
        published,
        v12,
        metas,
        sources,
        errors,
        resolver,
        handle,
        ingress,
    };
}

function meta(uin: string) {
    return { uin, sequence: 91, command: COMMAND, retCode: 0 };
}

describe('synthetic direct ingress through the OneBot event pipeline', () => {
    it('isolates accounts and drains ingress independently of gated subscribers', async () => {
        const a = session(A);
        const b = session(B);
        const friend = friendBody();
        const group = groupBody();

        try {
            expect(a.ingress.activate()).toBe(true);
            expect(b.ingress.activate()).toBe(true);
            // UIN is caller-supplied metadata; checking it does not authenticate a peer.
            expect(await bounded(b.ingress.submit(friend, meta(A)))).toEqual({
                kind: 'rejected',
                reason: 'invalid',
            });
            expect(await bounded(a.ingress.submit(group, meta(`0${A}`)))).toEqual({
                kind: 'rejected',
                reason: 'invalid',
            });
            expect(a.published).toEqual([]);
            expect(b.published).toEqual([]);

            const aReceipt = a.ingress.submit(friend, meta(A));
            friend.fill(0);
            const bReceipt = b.ingress.submit(group, meta(B));
            group.fill(0);
            expect(await bounded(Promise.all([aReceipt, bReceipt]))).toEqual([
                { kind: 'settled', events: 1 },
                { kind: 'settled', events: 1 },
            ]);
            await bounded(Promise.all([a.entered.promise, b.entered.promise]));
            expect(a.published).toEqual([]);
            expect(b.published).toEqual([]);

            // settled/drain describe packet pipeline work, not subscriber delivery.
            a.ingress.stop();
            b.ingress.stop();
            await bounded(Promise.all([a.ingress.drain(), b.ingress.drain()]));
            expect(a.published).toEqual([]);
            expect(b.published).toEqual([]);
            await expect(a.handle.drain()).rejects.toThrow('must be stopped');
            a.handle.stop();
            b.handle.stop();
            let aDrained = false;
            let bDrained = false;
            const aDrain = a.handle.drain().then(() => {
                aDrained = true;
            });
            const bDrain = b.handle.drain().then(() => {
                bDrained = true;
            });
            await Promise.resolve();
            expect(aDrained).toBe(false);
            expect(bDrained).toBe(false);

            a.gate.resolve();
            await bounded(aDrain);
            expect(bDrained).toBe(false);
            expect(b.published).toEqual([]);
            b.gate.resolve();
            await bounded(bDrain);

            const friendId = hashMessageIdInt32(63214, PEER, 'private_message_nt');
            const groupId = hashMessageIdInt32(120, GROUP, 'group_message');
            expect(await a.resolver(false, PEER, 63214, 'private_message_nt')).toBe(friendId);
            expect(await b.resolver(true, GROUP, 120, 'group_message')).toBe(groupId);
            expect(a.published).toEqual([
                expect.objectContaining({
                    self_id: Number(A),
                    post_type: 'message',
                    message_type: 'private',
                    user_id: PEER,
                    message_id: friendId,
                    raw_message: 'friend synthetic text',
                    message: [{ type: 'text', data: { text: 'friend synthetic text' } }],
                }),
            ]);
            expect(b.published).toEqual([
                expect.objectContaining({
                    self_id: Number(B),
                    post_type: 'message',
                    message_type: 'group',
                    user_id: MEMBER,
                    group_id: GROUP,
                    message_id: groupId,
                    raw_message: 'group synthetic text',
                    message: [{ type: 'text', data: { text: 'group synthetic text' } }],
                }),
            ]);
            expect(a.v12).toEqual([
                expect.objectContaining({
                    type: 'message',
                    detail_type: 'private',
                    self: { platform: 'qq', user_id: A },
                    user_id: String(PEER),
                    message_id: String(friendId),
                    message: [{ type: 'text', data: { text: 'friend synthetic text' } }],
                }),
            ]);
            expect(b.v12).toEqual([
                expect.objectContaining({
                    type: 'message',
                    detail_type: 'group',
                    self: { platform: 'qq', user_id: B },
                    user_id: String(MEMBER),
                    group_id: String(GROUP),
                    message_id: String(groupId),
                    message: [{ type: 'text', data: { text: 'group synthetic text' } }],
                }),
            ]);
            expect(a.metas).toEqual([
                {
                    id: friendId,
                    meta: expect.objectContaining({
                        isGroup: false,
                        targetId: PEER,
                        sequence: 63214,
                        eventName: 'private_message_nt',
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
                        eventName: 'group_message',
                    }),
                },
            ]);
            expect(a.sources).toEqual(['bridge']);
            expect(b.sources).toEqual(['bridge']);
            expect(a.identity.findUinByUid('synthetic_peer')).toBe(PEER);
            expect(b.identity.findUinByUid('synthetic_peer')).toBeNull();
            expect(a.errors).toEqual([]);
            expect(b.errors).toEqual([]);
            expect(a.bus.has('friend_message')).toBe(false);
            expect(b.bus.has('group_message')).toBe(false);
        } finally {
            friend.fill(0);
            group.fill(0);
            a.gate.resolve();
            b.gate.resolve();
            a.ingress.stop();
            b.ingress.stop();
            a.handle.stop();
            b.handle.stop();

            try {
                await bounded(
                    Promise.all([
                        a.ingress.drain(),
                        b.ingress.drain(),
                        a.handle.drain(),
                        b.handle.drain(),
                    ]),
                );
            } finally {
                a.bus.clear();
                b.bus.clear();
                await bounded(Promise.all([a.identity.close(), b.identity.close()]));
            }
        }
    });
});
