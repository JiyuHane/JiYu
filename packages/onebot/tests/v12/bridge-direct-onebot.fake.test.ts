import { Bridge } from '@snowluma/core/bridge';
import type { PushMsg } from '@snowluma/proto-defs/message';
import { protobuf_encode } from '@snowluma/proton';
import type { DirectPushMeta } from '@snowluma/protocol/direct/direct-push-ingress';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { describe, expect, it, vi } from 'vitest';

import { registerEventPipeline } from '../../src/event-pipeline';
import type { OneBotInstanceContext } from '../../src/instance-context';
import { hashMessageIdInt32 } from '../../src/message-id';
import { createMessageIdResolver } from '../../src/message-id-resolver';
import { TempSessionStore } from '../../src/temp-session-store';
import type { JsonObject, MessageMeta } from '../../src/types';
import { convertV11Event } from '../../src/v12/events';

const A = '2000000001';
const B = '2000000002';
const PEER = 10001;
const COMMAND = 'trpc.msg.olpush.OlPushService.MsgPush';
const OPTIONS = {
    sourceAuthenticationHandled: true,
    maxBodyBytes: 65536,
    maxPendingBytes: 262144,
    maxPending: 8,
    maxEventsPerPush: 16,
} as const;

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
                timer = setTimeout(() => reject(new Error('synthetic fixture watchdog')), 2000);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

// Schema-generated synthetic bytes; no captured data or external source.
function friend(text: string): Uint8Array {
    return protobuf_encode<PushMsg>({
        message: {
            responseHead: { fromUin: PEER, fromUid: 'synthetic_peer' },
            contentHead: {
                msgType: 166,
                sequence: 32743,
                ntMsgSeq: 63214,
                timestamp: 1700000000,
                msgId: 1,
            },
            body: { richText: { elems: [{ text: { str: text } }] } },
        },
    });
}

function meta(uin: string): DirectPushMeta {
    return { uin, sequence: 91, command: COMMAND, retCode: 0 };
}

function session(uin: string) {
    const identity = IdentityService.memory(uin);
    const bridge = new Bridge(identity);

    const unexpected = async (): Promise<never> => {
        throw new Error('unexpected synthetic external activity');
    };

    const send = vi.spyOn(bridge, 'sendRawPacket').mockImplementation(unexpected);
    const friends = vi
        .spyOn(bridge.apis.contacts, 'fetchFriendList')
        .mockImplementation(unexpected);
    const groups = vi.spyOn(bridge.apis.contacts, 'fetchGroupList').mockImplementation(unexpected);
    const members = vi
        .spyOn(bridge.apis.contacts, 'fetchGroupMemberList')
        .mockImplementation(unexpected);
    const profile = vi
        .spyOn(bridge.apis.contacts, 'fetchUserProfile')
        .mockImplementation(unexpected);
    const profileByUid = vi
        .spyOn(bridge.apis.contacts, 'fetchUserProfileByUid')
        .mockImplementation(unexpected);
    const entered = deferred();
    const gate = deferred();
    const observed: QQEventVariant[] = [];
    const published: JsonObject[] = [];
    const v12: ReturnType<typeof convertV11Event>[] = [];
    const sources: Array<string | undefined> = [];
    const metas: Array<{ id: number; meta: MessageMeta }> = [];
    const resolver = createMessageIdResolver({ resolvePrivateReplyMessageId: async () => null });
    bridge.events.onAny((event) => {
        observed.push(event);
    });

    // A deliberately partial virtual context, not a running OneBot instance.
    const ctx: OneBotInstanceContext = {
        uin,
        selfId: Number(uin),
        bridge,
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
        cacheMessageMeta: (id, value) => {
            metas.push({ id, meta: value });
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
    // This is a caller commitment, not peer authentication or online state.
    const ingress = bridge.openDirectPushIngress(OPTIONS);
    return {
        bridge,
        identity,
        ingress,
        handle,
        entered,
        gate,
        observed,
        published,
        v12,
        sources,
        metas,
        resolver,
        send,
        friends,
        groups,
        members,
        profile,
        profileByUid,
    };
}

type Session = ReturnType<typeof session>;

function expectNoExternalActivity(f: Session) {
    expect(f.bridge.empty).toBe(true);
    expect(f.bridge.activePid).toBeNull();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.friends).not.toHaveBeenCalled();
    expect(f.groups).not.toHaveBeenCalled();
    expect(f.members).not.toHaveBeenCalled();
    expect(f.profile).not.toHaveBeenCalled();
    expect(f.profileByUid).not.toHaveBeenCalled();
}

async function cleanup(f: Session): Promise<void> {
    f.gate.resolve();
    f.ingress.stop();

    try {
        await bounded(f.ingress.drain());
    } finally {
        f.handle.stop();

        try {
            await bounded(f.handle.drain());
        } finally {
            await bounded(f.bridge.dispose());
        }
    }
}

async function cleanupBoth(a: Session, b: Session): Promise<void> {
    const results = await Promise.allSettled([cleanup(a), cleanup(b)]);
    const failures = results.filter((result) => result.status === 'rejected');

    if (failures.length > 0) {
        throw new AggregateError(
            failures.map((failure) => failure.reason),
            'cleanup failed',
        );
    }
}

describe('real Bridge direct ingress to synthetic OneBot contexts', () => {
    it('isolates two accounts and snapshots inputs before asynchronous conversion', async () => {
        const a = session(A);
        const b = session(B);
        const bodyA = friend('synthetic A');
        const bodyB = friend('synthetic B');

        try {
            expect(await bounded(a.ingress.submit(bodyA, meta(A)))).toEqual({
                kind: 'rejected',
                reason: 'not-active',
            });
            expect(await bounded(b.ingress.submit(bodyB, meta(B)))).toEqual({
                kind: 'rejected',
                reason: 'not-active',
            });
            expect(a.ingress.activate()).toBe(true);
            expect(b.ingress.activate()).toBe(true);
            expect(await bounded(a.ingress.submit(bodyA, meta(B)))).toEqual({
                kind: 'rejected',
                reason: 'invalid',
            });
            expect(await bounded(b.ingress.submit(bodyB, meta(A)))).toEqual({
                kind: 'rejected',
                reason: 'invalid',
            });
            expect(a.observed).toEqual([]);
            expect(b.observed).toEqual([]);
            expect(a.published).toEqual([]);
            expect(b.published).toEqual([]);

            const receiptA = a.ingress.submit(bodyA, meta(A));
            bodyA.fill(0);
            const receiptB = b.ingress.submit(bodyB, meta(B));
            bodyB.fill(0);
            expect(await bounded(Promise.all([receiptA, receiptB]))).toEqual([
                { kind: 'settled', events: 1 },
                { kind: 'settled', events: 1 },
            ]);
            await bounded(Promise.all([a.entered.promise, b.entered.promise]));
            expect(a.observed).toMatchObject([
                {
                    kind: 'friend_message',
                    selfUin: Number(A),
                    senderUin: PEER,
                    elements: [{ type: 'text', text: 'synthetic A' }],
                },
            ]);
            expect(b.observed).toMatchObject([
                {
                    kind: 'friend_message',
                    selfUin: Number(B),
                    senderUin: PEER,
                    elements: [{ type: 'text', text: 'synthetic B' }],
                },
            ]);

            // Ingress settlement/drain does not await asynchronous OneBot dispatch.
            a.ingress.stop();
            b.ingress.stop();
            await bounded(Promise.all([a.ingress.drain(), b.ingress.drain()]));
            expect(a.published).toEqual([]);
            expect(b.published).toEqual([]);
            a.handle.stop();
            b.handle.stop();
            let drainedA = false;
            let drainedB = false;
            const drainA = a.handle.drain().then(() => {
                drainedA = true;
            });
            const drainB = b.handle.drain().then(() => {
                drainedB = true;
            });
            await Promise.resolve();
            expect(drainedA).toBe(false);
            expect(drainedB).toBe(false);
            a.gate.resolve();
            await bounded(drainA);
            expect(drainedB).toBe(false);
            expect(b.published).toEqual([]);
            b.gate.resolve();
            await bounded(drainB);

            const id = hashMessageIdInt32(63214, PEER, 'private_message_nt');

            for (const [f, uin, text] of [
                [a, A, 'synthetic A'],
                [b, B, 'synthetic B'],
            ] as const) {
                expect(f.published).toEqual([
                    expect.objectContaining({
                        self_id: Number(uin),
                        post_type: 'message',
                        message_type: 'private',
                        user_id: PEER,
                        message_id: id,
                        raw_message: text,
                        message: [{ type: 'text', data: { text } }],
                    }),
                ]);
                expect(f.v12).toEqual([
                    expect.objectContaining({
                        type: 'message',
                        detail_type: 'private',
                        self: { platform: 'qq', user_id: uin },
                        user_id: String(PEER),
                        message_id: String(id),
                        message: [{ type: 'text', data: { text } }],
                    }),
                ]);
                expect(f.sources).toEqual(['bridge']);
                expect(f.metas).toEqual([
                    {
                        id,
                        meta: expect.objectContaining({
                            isGroup: false,
                            targetId: PEER,
                            sequence: 63214,
                            eventName: 'private_message_nt',
                        }),
                    },
                ]);
                expect(f.identity.findUinByUid('synthetic_peer')).toBe(PEER);
                expectNoExternalActivity(f);
            }

            await bounded(Promise.all([a.bridge.dispose(), b.bridge.dispose()]));
        } finally {
            bodyA.fill(0);
            bodyB.fill(0);
            await cleanupBoth(a, b);
        }
    });

    it('shows Bridge disposal does not wait for an already gated OneBot subscriber', async () => {
        const f = session(A);
        const body = friend('disposal boundary');

        try {
            expect(f.ingress.activate()).toBe(true);
            const receipt = f.ingress.submit(body, meta(A));
            body.fill(0);
            expect(await bounded(receipt)).toEqual({ kind: 'settled', events: 1 });
            await bounded(f.entered.promise);
            f.ingress.stop();
            await bounded(f.ingress.drain());
            f.handle.stop();
            let drained = false;
            const drain = f.handle.drain().then(() => {
                drained = true;
            });
            // Deliberate lifecycle inversion in this isolated boundary probe only:
            // production-style cleanup drains OneBot before disposing Bridge.
            await bounded(f.bridge.dispose());
            expect(drained).toBe(false);
            expect(f.published).toEqual([]);
            expectNoExternalActivity(f);
            f.gate.resolve();
            await bounded(drain);
            expect(f.sources).toEqual(['bridge']);
            expect(f.published).toEqual([
                expect.objectContaining({
                    self_id: Number(A),
                    user_id: PEER,
                    raw_message: 'disposal boundary',
                }),
            ]);
        } finally {
            body.fill(0);
            await cleanup(f);
        }
    });
});
