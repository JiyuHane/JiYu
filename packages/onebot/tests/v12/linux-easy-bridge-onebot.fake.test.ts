import dgram from 'node:dgram';
import net from 'node:net';
import { Bridge } from '@snowluma/core/bridge';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { describe, expect, it, vi } from 'vitest';

import {
    bounded,
    deferred,
    fixture,
    PUSH,
    REGISTER,
    PeerFixtureInitializationError,
    turn,
    waitUntil,
    type PeerProcessorInput,
} from '../../../protocol/tests/direct/support/linux-easy-multiplex-peer';
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

// Independent fixed expectations for the existing SHA-1 signed-int32 scheme.
const SAMPLES = [
    { push: PUSH, ntSequence: 63224, id: -1311643833 },
    { push: PUSH + 1, ntSequence: 63225, id: -1314980507 },
    { push: PUSH + 2, ntSequence: 63226, id: -690358027 },
    { push: PUSH + 3, ntSequence: 63227, id: -107191150 },
] as const;

type Sample = (typeof SAMPLES)[number];
type Peer = ReturnType<typeof fixture>;
type Start = ReturnType<Peer['start']>;
type Publication = { event: JsonObject; source: string | undefined };

class SessionInitializationError extends Error {
    constructor(
        cause: unknown,
        readonly cleanup: Promise<void>,
    ) {
        super('synthetic OneBot session initialization failed', { cause });
    }
}

function session(uin: string) {
    const identity = IdentityService.memory(uin);
    let bridge: Bridge | undefined;

    try {
        bridge = new Bridge(identity);
        return sessionWithBridge(uin, identity, bridge);
    } catch (error) {
        const cleanup = Promise.resolve().then(() =>
            bridge ? bridge.dispose() : identity.close(),
        );
        void cleanup.catch(() => undefined);
        throw new SessionInitializationError(error, cleanup);
    }
}

function sessionWithBridge(uin: string, identity: IdentityService, bridge: Bridge) {
    const unexpected = (): never => {
        throw new Error('unexpected synthetic external activity');
    };

    const bindPid = vi.spyOn(bridge, 'bindPid').mockImplementation(unexpected);
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
    const gate = deferred<void>();
    const observed: QQEventVariant[] = [];
    const entered: Publication[] = [];
    const published: Publication[] = [];
    const metas: Array<{ id: number; meta: MessageMeta }> = [];
    const resolver = createMessageIdResolver({ resolvePrivateReplyMessageId: async () => null });

    // All event subscribers record snapshots; assertions run in the test body.
    const unsubscribe = bridge.events.onAny((event) => {
        observed.push(structuredClone(event));
    });
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
        cacheMessageMeta: (id, meta) => {
            metas.push({ id, meta: structuredClone(meta) });
        },
        dispatchEvent: async (event, source) => {
            const publication = { event: structuredClone(event), source };
            entered.push(publication);
            await gate.promise;
            published.push(publication);
        },
    };
    const handle = registerEventPipeline(ctx);
    const createProcessor = vi.fn((options: PeerProcessorInput) =>
        bridge.openLinuxEasyPushProcessor(options),
    );
    return {
        uin,
        identity,
        bridge,
        gate,
        observed,
        entered,
        published,
        metas,
        handle,
        unsubscribe,
        createProcessor,
        peer: undefined as Peer | undefined,
        pending: undefined as Start | undefined,
        bindPid,
        send,
        friends,
        groups,
        members,
        profile,
        profileByUid,
    };
}

type Session = ReturnType<typeof session>;

function expectNoExternalActivity(f: Session): void {
    expect(f.bridge.empty).toBe(true);
    expect(f.bridge.activePid).toBeNull();
    expect(f.bindPid).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.friends).not.toHaveBeenCalled();
    expect(f.groups).not.toHaveBeenCalled();
    expect(f.members).not.toHaveBeenCalled();
    expect(f.profile).not.toHaveBeenCalled();
    expect(f.profileByUid).not.toHaveBeenCalled();
}

async function stage(f: Session, peer: Peer): Promise<void> {
    const pending = peer.start();
    f.pending = pending;
    // Observe early rejection even if a later stage fails before awaiting start.
    void pending.catch(() => undefined);
    await bounded(peer.written[0]!.promise);
    peer.feedKey();
    await bounded(peer.written[1]!.promise);
    peer.feedEasyAndPush();
    await bounded(peer.easyVerifyEntered.promise);
}

function expectPublished(f: Session, samples: readonly Sample[]): void {
    expect(f.observed).toHaveLength(samples.length);
    expect(f.entered).toHaveLength(samples.length);
    expect(f.published).toHaveLength(samples.length);
    expect(f.metas).toHaveLength(samples.length);

    for (const sample of samples) {
        const text = `synthetic ${sample.push}`;
        const observed = f.observed.filter(
            (event) =>
                event.kind === 'friend_message' &&
                event.elements.some((element) => element.type === 'text' && element.text === text),
        );
        expect(observed).toHaveLength(1);
        expect(observed[0]).toMatchObject({
            kind: 'friend_message',
            selfUin: Number(f.uin),
            senderUin: PEER,
            senderUid: 'synthetic_peer',
            ntMsgSeq: sample.ntSequence,
            elements: [{ type: 'text', text }],
        });

        const matches = f.published.filter(({ event }) => event.raw_message === text);
        expect(matches).toHaveLength(1);
        const publication = matches[0]!;
        expect(publication.source).toBe('bridge');
        expect(publication.event).toEqual(
            expect.objectContaining({
                self_id: Number(f.uin),
                post_type: 'message',
                message_type: 'private',
                sub_type: 'friend',
                user_id: PEER,
                sender: expect.objectContaining({ user_id: PEER }),
                message_id: sample.id,
                raw_message: text,
                message: [{ type: 'text', data: { text } }],
            }),
        );
        const id = publication.event.message_id;

        if (typeof id !== 'number') {
            throw new Error('synthetic v11 message_id is not a number');
        }

        expect(Number.isInteger(id)).toBe(true);
        expect(id | 0).toBe(id);
        expect(id).toBeLessThan(0);
        expect(id).toBe(hashMessageIdInt32(sample.ntSequence, PEER, 'private_message_nt'));
        expect(f.metas.filter((item) => item.id === sample.id)).toEqual([
            {
                id: sample.id,
                meta: expect.objectContaining({
                    isGroup: false,
                    targetId: PEER,
                    sequence: sample.ntSequence,
                    sequenceAuthoritative: true,
                    eventName: 'private_message_nt',
                }),
            },
        ]);

        // Conversion is invoked in the test body so failures cannot be swallowed
        // by the Bridge event bus or the asynchronous OneBot handler.
        expect(convertV11Event(publication.event, { platform: 'qq', user_id: f.uin })).toEqual(
            expect.objectContaining({
                type: 'message',
                detail_type: 'private',
                self: { platform: 'qq', user_id: f.uin },
                user_id: String(PEER),
                message_id: String(sample.id),
                message: [{ type: 'text', data: { text } }],
                alt_message: text,
            }),
        );
    }
}

async function cleanup(f: Session): Promise<void> {
    const errors: unknown[] = [];

    const attempt = async (work: () => void | Promise<void>) => {
        try {
            await work();
        } catch (error) {
            errors.push(error);
        }
    };

    // close() releases the fixture gates, stops the mux/processor and drains
    // admitted processor work. It does not drain OneBot subscribers.
    if (f.peer) {
        await attempt(() => f.peer!.close());
    }

    if (f.pending) {
        await attempt(async () => {
            await bounded(f.pending!.catch(() => undefined));
        });
    }

    await attempt(() => f.handle.stop());
    await attempt(() => bounded(f.handle.drain()));
    await attempt(() => f.unsubscribe());
    await attempt(() => bounded(f.bridge.dispose()));
    await attempt(() => expectNoExternalActivity(f));

    if (errors.length) {
        throw new AggregateError(errors, 'synthetic session cleanup failed');
    }
}

describe('synthetic Linux Easy multiplex to real Bridge and OneBot', () => {
    it('isolates accounts and drains asynchronous OneBot subscribers separately', async () => {
        // Fail before any actual TCP, pipe listener/connect or UDP socket exists.
        const unexpectedSocket = (): never => {
            throw new Error('unexpected socket operation');
        };

        const socketGuards: Array<{ mockRestore(): void }> = [];
        const sessions: Session[] = [];
        const initializationCleanups: Promise<void>[] = [];
        const errors: unknown[] = [];

        try {
            socketGuards.push(
                vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(unexpectedSocket),
            );
            socketGuards.push(
                vi.spyOn(net.Server.prototype, 'listen').mockImplementation(unexpectedSocket),
            );
            socketGuards.push(vi.spyOn(dgram, 'createSocket').mockImplementation(unexpectedSocket));
            const a = session(A);
            sessions.push(a);
            const b = session(B);
            sessions.push(b);
            // Both Bridge observers and OneBot subscriptions exist before either
            // owner starts. The factory receives only the fixture's ordinary data.
            const peerA = fixture(false, false, { uin: A, createProcessor: a.createProcessor });
            a.peer = peerA;
            const peerB = fixture(false, false, { uin: B, createProcessor: b.createProcessor });
            b.peer = peerB;
            expect(a.createProcessor).toHaveBeenCalledOnce();
            expect(b.createProcessor).toHaveBeenCalledOnce();

            // Synthetic encrypted frames, fake policy callbacks and in-memory
            // writes exercise local composition; they do not authenticate a peer.
            await stage(a, peerA);
            await stage(b, peerB);
            const pendingA = a.pending!;
            const pendingB = b.pending!;
            expect(peerA.processor.activate()).toBe(false);
            expect(peerB.processor.activate()).toBe(false);
            expect(a.observed).toEqual([]);
            expect(b.observed).toEqual([]);
            expect(a.entered).toEqual([]);
            expect(b.entered).toEqual([]);
            peerA.easyVerifyGate.resolve(true);
            peerB.easyVerifyGate.resolve(true);
            await bounded(Promise.all([peerA.written[2]!.promise, peerB.written[2]!.promise]));
            await waitUntil(
                () => peerA.onPush.mock.calls.length === 2 && peerB.onPush.mock.calls.length === 2,
            );
            expect(peerA.processor.status()).toBe('buffering');
            expect(peerB.processor.status()).toBe('buffering');
            expect(peerA.fullVerified).toEqual([]);
            expect(peerB.fullVerified).toEqual([]);
            expect(a.observed).toEqual([]);
            expect(b.observed).toEqual([]);

            // Both registrations settle, but B's local processor stays buffered.
            peerA.feedRegister(true);
            peerB.feedRegister(true);
            expect(await bounded(Promise.all([pendingA, pendingB]))).toEqual([
                { kind: 'registered', registerSequence: REGISTER },
                { kind: 'registered', registerSequence: REGISTER },
            ]);
            expect(peerA.processor.activate()).toBe(true);
            await waitUntil(() => a.entered.length === 2 && a.observed.length === 2);
            expect(b.observed).toEqual([]);
            expect(b.entered).toEqual([]);
            expect(b.identity.findUinByUid('synthetic_peer')).toBeNull();
            expect(a.identity.findUinByUid('synthetic_peer')).toBe(PEER);
            expect(peerB.settled()).toBe(true);
            expect(peerB.processor.status()).toBe('buffering');

            const onlyA = peerA.push(PUSH + 2);
            peerA.mux.feed(onlyA.frame);
            await waitUntil(() => a.entered.length === 3 && a.observed.length === 3);
            expect(b.observed).toEqual([]);
            expect(b.entered).toEqual([]);

            expect(peerB.processor.activate()).toBe(true);
            await waitUntil(() => b.entered.length === 2 && b.observed.length === 2);
            const onlyB = peerB.push(PUSH + 3);
            peerB.mux.feed(onlyB.frame);
            await waitUntil(() => b.entered.length === 3 && b.observed.length === 3);
            expect(a.observed).toHaveLength(3);
            expect(a.entered).toHaveLength(3);
            expect(b.identity.findUinByUid('synthetic_peer')).toBe(PEER);
            expect(peerA.processor.status()).toBe('active');
            expect(peerB.processor.status()).toBe('active');
            expect(peerA.muxVerified).toEqual([PUSH, PUSH + 1, PUSH + 2]);
            expect(peerB.muxVerified).toEqual([PUSH, PUSH + 1, PUSH + 3]);
            expect(peerA.fullVerified).toEqual([PUSH, PUSH + 1, PUSH + 2]);
            expect(peerB.fullVerified).toEqual([PUSH, PUSH + 1, PUSH + 3]);
            expect(peerA.onPush.mock.results).toEqual([
                { type: 'return', value: undefined },
                { type: 'return', value: undefined },
                { type: 'return', value: undefined },
            ]);
            expect(peerB.onPush.mock.results).toEqual([
                { type: 'return', value: undefined },
                { type: 'return', value: undefined },
                { type: 'return', value: undefined },
            ]);
            expect(a.published).toEqual([]);
            expect(b.published).toEqual([]);
            expectNoExternalActivity(a);
            expectNoExternalActivity(b);

            // Every expected event has entered OneBot before stopping the input.
            // Processor drain is not the same as draining async subscribers.
            peerA.processor.stop();
            peerB.processor.stop();
            await bounded(Promise.all([peerA.processor.drain(), peerB.processor.drain()]));
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
            await turn();
            expect(drainedA).toBe(false);
            expect(drainedB).toBe(false);
            a.gate.resolve();
            await bounded(drainA);
            expect(drainedB).toBe(false);
            expect(b.published).toEqual([]);
            b.gate.resolve();
            await bounded(drainB);

            // Match each message by content rather than claiming a global FIFO
            // across independent event-bus subscribers or account pipelines.
            expectPublished(a, [SAMPLES[0], SAMPLES[1], SAMPLES[2]]);
            expectPublished(b, [SAMPLES[0], SAMPLES[1], SAMPLES[3]]);
        } catch (error) {
            errors.push(error);

            if (
                error instanceof PeerFixtureInitializationError ||
                error instanceof SessionInitializationError
            ) {
                initializationCleanups.push(error.cleanup);
            }
        } finally {
            // Release every gate even after a timeout, then close the input before
            // stopping/draining OneBot and finally disposing each Bridge.
            for (const f of sessions) {
                f.gate.resolve();
                f.peer?.easyVerifyGate.resolve(true);
                f.peer?.deferredVerifyGate.resolve(true);
            }

            const initResults = await Promise.allSettled(initializationCleanups);

            for (const result of initResults) {
                if (result.status === 'rejected') {
                    errors.push(result.reason);
                }
            }

            const results = await Promise.allSettled(sessions.map(cleanup));

            for (const result of results) {
                if (result.status === 'rejected') {
                    errors.push(result.reason);
                }
            }

            for (const guard of socketGuards) {
                try {
                    expect(guard).not.toHaveBeenCalled();
                } catch (error) {
                    errors.push(error);
                }

                try {
                    guard.mockRestore();
                } catch (error) {
                    errors.push(error);
                }
            }
        }

        if (errors.length) {
            throw new AggregateError(errors, 'synthetic Linux Easy to OneBot test failed');
        }
    }, 60000);
});
