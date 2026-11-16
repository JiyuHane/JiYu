import type { FriendRecall as RecallWire } from '@snowluma/proto-defs/notify';
import { protobuf_encode } from '@snowluma/proton';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { IdentityService } from '@snowluma/protocol/identity-service';
import type { MsgPushContext } from '@snowluma/protocol/msg-push/context';
import { decodeEvent0x210 } from '@snowluma/protocol/msg-push/decoders/event-0x210';
import { subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import { describe, expect, it } from 'vitest';
import { registerEventPipeline } from '../../src/event-pipeline';
import type { OneBotInstanceContext } from '../../src/instance-context';
import { PRIVATE_MESSAGE_EVENT } from '../../src/message-id';
import { MessageStore } from '../../src/message-store';
import { TempSessionStore } from '../../src/temp-session-store';
import type { JsonObject } from '../../src/types';
import { convertV11Event } from '../../src/v12/events';
import {
    capturePrivateRecallSource,
    convertPrivateRecallEvent,
    getPrivateRecallSource,
    rememberPrivateRecallSource,
} from '../../src/v12-runtime/private-recall-source';
import {
    captureSource,
    SourceGeneration,
    type V12Source,
} from '../../src/v12-runtime/source-generation';

const SELF = 10001;
const PEER = 20002;
const TIME = 1700000100;
type Recall = Extract<QQEventVariant, { kind: 'friend_recall' }>;

// Generated from workspace schemas. These identifiers and events are synthetic.
function decode(subType: 138 | 139, identity: IdentityService): Recall {
    const content = protobuf_encode<RecallWire>({
        info: {
            fromUid: subType === 138 ? 'synthetic-peer' : 'synthetic-self',
            toUid: subType === 138 ? 'synthetic-self' : 'synthetic-peer',
            clientSequence: 444,
            time: TIME,
        },
    });
    const context: MsgPushContext = {
        head: {
            msgType: 0x210,
            subType,
            c2cCmd: 0,
            sequence: 1,
            ntMsgSeq: 0,
            timestamp: TIME,
            msgId: 0,
        },
        fromUin: PEER,
        fromUid: 'synthetic-peer',
        selfUin: SELF,
        content,
        body: undefined,
        responseHead: undefined,
        identity,
        isHistorical: false,
    };
    const decoded = decodeEvent0x210(context);

    if (decoded.length !== 1 || decoded[0].kind !== 'friend_recall') {
        throw new Error('synthetic recall did not decode');
    }

    return decoded[0];
}

async function fixture() {
    const identity = IdentityService.memory(String(SELF));
    identity.rememberRequestIdentity({ uid: 'synthetic-peer', uin: PEER });
    const store = new MessageStore(':memory:');
    await store.initialization;
    const errors: unknown[] = [];
    const bus = new BridgeEventBus({ onError: (_kind, error) => errors.push(error) });
    const generation = new SourceGeneration();
    generation.setOnline(true);
    const binding = {};
    const v11: JsonObject[] = [];
    const tickets: Array<V12Source | undefined> = [];
    const ctx: OneBotInstanceContext = {
        uin: String(SELF),
        selfId: SELF,
        bridge: { events: bus } as never,
        messageStore: store,
        mediaStore: {} as never,
        reactionStore: {} as never,
        tempSessions: new TempSessionStore(),
        converterCtx: {
            selfId: SELF,
            imageUrlResolver: null,
            mediaUrlResolver: null,
            messageIdResolver: null,
            mediaSegmentSink: null,
        },
        config: {
            networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
        } as never,
        getUptimeMs: () => 0,
        cacheMessageMeta: () => {},
        [captureSource]: () => generation.capture(binding),
        dispatchEvent: (event, _source, _startedAt, ticket) => {
            v11.push(event);
            tickets.push(ticket);
        },
    };
    const pipeline = registerEventPipeline(ctx);
    return {
        identity,
        store,
        bus,
        ctx,
        binding,
        generation,
        v11,
        tickets,
        errors,
        async seed(messageId: number, clientSequence: number, selfSent: boolean, peer = PEER) {
            await store.storeMeta(messageId, {
                isGroup: false,
                targetId: peer,
                sequence: 63214,
                sequenceAuthoritative: true,
                eventName: PRIVATE_MESSAGE_EVENT,
                clientSequence,
                privateDirection: selfSent ? 'outgoing' : 'incoming',
                random: 1,
                timestamp: TIME - 10,
            });
        },
        async close() {
            pipeline.stop();
            await pipeline.drain();
            bus.clear();
            await store.close();
            await identity.close();
        },
    };
}

describe('private recall provenance through the real decoded event pipeline', () => {
    it('binds each exact v11 object and ticket after the real store finds both directions', async () => {
        const a = await fixture();
        const b = await fixture();

        try {
            await a.seed(-2147483648, 444, false);
            await a.seed(2147483647, 444, true);
            const incoming = decode(138, a.identity);
            const outgoing = decode(139, a.identity);
            expect(incoming).toEqual({
                kind: 'friend_recall',
                time: TIME,
                selfUin: SELF,
                userUin: PEER,
                msgSeq: 444,
                clientSeq: 444,
                recalledBySelf: false,
            });
            expect(outgoing).toEqual({
                kind: 'friend_recall',
                time: TIME,
                selfUin: SELF,
                userUin: PEER,
                msgSeq: 444,
                clientSeq: 444,
                recalledBySelf: true,
            });
            await a.bus.emit(incoming);
            await a.bus.emit(outgoing);
            expect(a.v11).toEqual([
                {
                    time: TIME,
                    self_id: SELF,
                    post_type: 'notice',
                    notice_type: 'friend_recall',
                    user_id: PEER,
                    message_id: -2147483648,
                },
                {
                    time: TIME,
                    self_id: SELF,
                    post_type: 'notice',
                    notice_type: 'friend_recall',
                    user_id: PEER,
                    message_id: 2147483647,
                },
            ]);
            expect(a.errors).toEqual([]);
            expect(a.tickets[0]).toBeDefined();
            expect(a.tickets[1]).toBeDefined();
            expect(a.tickets[0]).not.toBe(a.tickets[1]);
            const first = getPrivateRecallSource(a.ctx, a.v11[0]);
            const second = getPrivateRecallSource(a.ctx, a.v11[1]);
            expect(first).toMatchObject({
                selfUin: SELF,
                peerUin: PEER,
                msgSeq: 444,
                clientSequence: 444,
                time: TIME,
                recalledBySelf: false,
                messageId: -2147483648,
            });
            expect(second).toMatchObject({
                selfUin: SELF,
                peerUin: PEER,
                msgSeq: 444,
                clientSequence: 444,
                time: TIME,
                recalledBySelf: true,
                messageId: 2147483647,
            });
            expect(first?.sourceTicket).toBe(a.tickets[0]);
            expect(second?.sourceTicket).toBe(a.tickets[1]);
            expect(getPrivateRecallSource(a.ctx, { ...a.v11[0] })).toBeUndefined();
            expect(getPrivateRecallSource(b.ctx, a.v11[0])).toBeUndefined();
            expect(Reflect.ownKeys(a.v11[0])).toEqual([
                'time',
                'self_id',
                'post_type',
                'notice_type',
                'user_id',
                'message_id',
            ]);
            expect(convertV11Event(a.v11[0], { platform: 'qq', user_id: String(SELF) })).toBeNull();
            expect(
                convertPrivateRecallEvent(
                    a.v11[0],
                    { platform: 'qq', user_id: String(SELF) },
                    first!,
                ),
            ).toEqual({
                id: expect.any(String),
                time: TIME,
                type: 'notice',
                detail_type: 'private_message_delete',
                sub_type: '',
                self: { platform: 'qq', user_id: String(SELF) },
                message_id: '-2147483648',
                user_id: String(PEER),
            });
            expect(
                convertPrivateRecallEvent(
                    a.v11[1],
                    { platform: 'qq', user_id: String(SELF) },
                    second!,
                ),
            ).toEqual({
                id: expect.any(String),
                time: TIME,
                type: 'notice',
                detail_type: 'private_message_delete',
                sub_type: '',
                self: { platform: 'qq', user_id: String(SELF) },
                message_id: '2147483647',
                user_id: String(SELF),
            });
        } finally {
            await a.close();
            await b.close();
        }
    });

    it('captures primitive direction and both sequences before awaiting the store', async () => {
        const f = await fixture();

        try {
            await f.seed(-7654321, 444, false);
            const event: Recall = { ...decode(138, f.identity), msgSeq: 777 };
            const pending = f.bus.emit(event);
            event.recalledBySelf = true;
            event.clientSeq = 999;
            await pending;
            expect(f.v11).toEqual([
                {
                    time: TIME,
                    self_id: SELF,
                    post_type: 'notice',
                    notice_type: 'friend_recall',
                    user_id: PEER,
                    message_id: -7654321,
                },
            ]);
            const evidence = getPrivateRecallSource(f.ctx, f.v11[0]);
            expect(evidence).toMatchObject({
                msgSeq: 777,
                clientSequence: 444,
                recalledBySelf: false,
                messageId: -7654321,
            });
            expect(evidence?.sourceTicket).toBe(f.tickets[0]);
            expect(
                convertPrivateRecallEvent(
                    f.v11[0],
                    { platform: 'qq', user_id: String(SELF) },
                    evidence!,
                ),
            ).toMatchObject({ user_id: String(PEER), message_id: '-7654321' });
        } finally {
            await f.close();
        }
    });

    it('keeps legacy v11 for missing direction, missing ticket and cache miss, without evidence', async () => {
        const f = await fixture();

        try {
            await f.seed(-1, 444, false);
            const unknown: Recall = { ...decode(138, f.identity), recalledBySelf: undefined };
            await f.bus.emit(unknown);
            expect(f.v11[0]).toEqual({
                time: TIME,
                self_id: SELF,
                post_type: 'notice',
                notice_type: 'friend_recall',
                user_id: PEER,
                message_id: -1,
            });
            expect(getPrivateRecallSource(f.ctx, f.v11[0])).toBeUndefined();
            await f.seed(-2, 445, false);
            f.ctx[captureSource] = () => undefined;
            await f.bus.emit({ ...decode(138, f.identity), msgSeq: 445, clientSeq: 445 });
            expect(f.v11[1]).toEqual({
                time: TIME,
                self_id: SELF,
                post_type: 'notice',
                notice_type: 'friend_recall',
                user_id: PEER,
                message_id: -2,
            });
            expect(getPrivateRecallSource(f.ctx, f.v11[1])).toBeUndefined();
            f.ctx[captureSource] = () => f.generation.capture(f.binding);
            await f.bus.emit({ ...decode(138, f.identity), msgSeq: 446, clientSeq: 446 });
            expect(f.v11[2]).toEqual({
                time: TIME,
                self_id: SELF,
                post_type: 'notice',
                notice_type: 'friend_recall',
                user_id: PEER,
                message_id: 446,
            });
            expect(getPrivateRecallSource(f.ctx, f.v11[2])).toBeUndefined();
        } finally {
            await f.close();
        }
    });

    it('preserves the existing store-error behavior and records the pipeline failure', async () => {
        const f = await fixture();
        const entries: LogEntry[] = [];
        const unsubscribe = subscribeLogs((entry) => entries.push(entry));

        try {
            await f.bus.emit({ ...decode(138, f.identity), msgSeq: 0, clientSeq: 0 });
            expect(f.v11).toEqual([]);
            expect(
                entries.some(
                    (entry) =>
                        entry.level === 'error' &&
                        entry.message.includes('invalid private recall client sequence'),
                ),
            ).toBe(true);
            expect(f.errors).toEqual([]);
        } finally {
            unsubscribe();
            await f.close();
        }
    });
});

describe('private recall source primitive boundaries', () => {
    it.each([
        [0, PEER, false],
        [-1, PEER, false],
        [1.5, PEER, false],
        [Number.NaN, PEER, false],
        [Number.POSITIVE_INFINITY, PEER, false],
        [Number.MAX_SAFE_INTEGER + 1, PEER, false],
        [SELF, 0, false],
        [SELF, -1, false],
        [SELF, 1.5, false],
        [SELF, Number.NaN, false],
        [SELF, Number.POSITIVE_INFINITY, false],
        [SELF, Number.MAX_SAFE_INTEGER + 1, false],
        [Number.MAX_SAFE_INTEGER, 1, true],
        [SELF, Number.MAX_SAFE_INTEGER, true],
        [SELF, SELF, true],
    ] as const)('validates self %s and peer %s without numeric aliases', (self, peer, valid) => {
        const generation = new SourceGeneration();
        generation.setOnline(true);
        const ticket = generation.capture({})!;
        const ctx = { selfId: self, uin: String(self) } as OneBotInstanceContext;
        const event: Recall = {
            kind: 'friend_recall',
            selfUin: self,
            userUin: peer,
            msgSeq: 444,
            clientSeq: 444,
            time: TIME,
            recalledBySelf: false,
        };
        expect(capturePrivateRecallSource(ctx, event, ticket) !== undefined).toBe(valid);
    });

    it.each([
        [-1, false],
        [Number.NaN, false],
        [Number.POSITIVE_INFINITY, false],
        [Number.MAX_SAFE_INTEGER + 1, false],
        [0, true],
        [TIME + 0.5, true],
        [Number.MAX_SAFE_INTEGER, true],
    ] as const)('validates candidate time %s without rounding', (time, valid) => {
        const generation = new SourceGeneration();
        generation.setOnline(true);
        const ticket = generation.capture({})!;
        const ctx = { selfId: SELF, uin: String(SELF) } as OneBotInstanceContext;
        const event: Recall = {
            kind: 'friend_recall',
            selfUin: SELF,
            userUin: PEER,
            msgSeq: 444,
            clientSeq: 444,
            time,
            recalledBySelf: false,
        };
        const snapshot = capturePrivateRecallSource(ctx, event, ticket);
        expect(snapshot !== undefined).toBe(valid);

        if (snapshot) {
            expect(snapshot.time).toBe(time);
            expect(Object.isFrozen(snapshot)).toBe(true);
        }
    });

    it('preserves fractional candidate time through the private converter, separately from the integer-only store', () => {
        const generation = new SourceGeneration();
        generation.setOnline(true);
        const ticket = generation.capture({})!;
        const ctx = { selfId: SELF, uin: String(SELF) } as OneBotInstanceContext;
        const time = TIME + 0.5;
        const event: Recall = {
            kind: 'friend_recall',
            selfUin: SELF,
            userUin: PEER,
            msgSeq: 444,
            clientSeq: 444,
            time,
            recalledBySelf: true,
        };
        const converted: JsonObject = {
            time,
            self_id: SELF,
            post_type: 'notice',
            notice_type: 'friend_recall',
            user_id: PEER,
            message_id: -33,
        };
        const snapshot = capturePrivateRecallSource(ctx, event, ticket);
        expect(snapshot).toBeDefined();
        expect(rememberPrivateRecallSource(ctx, converted, snapshot, -33)).toBe(true);
        const source = getPrivateRecallSource(ctx, converted);
        expect(source).toBeDefined();
        expect(
            convertPrivateRecallEvent(
                converted,
                { platform: 'qq', user_id: String(SELF) },
                source!,
            ),
        ).toMatchObject({ time, user_id: String(SELF), message_id: '-33', sub_type: '' });
    });

    it('rejects a context/account mismatch and noncanonical context identity', () => {
        const generation = new SourceGeneration();
        generation.setOnline(true);
        const ticket = generation.capture({})!;
        const event: Recall = {
            kind: 'friend_recall',
            selfUin: SELF,
            userUin: PEER,
            msgSeq: 444,
            time: TIME,
            recalledBySelf: true,
        };
        expect(
            capturePrivateRecallSource(
                { selfId: SELF + 1, uin: String(SELF + 1) } as OneBotInstanceContext,
                event,
                ticket,
            ),
        ).toBeUndefined();
        expect(
            capturePrivateRecallSource(
                { selfId: SELF, uin: `0${SELF}` } as OneBotInstanceContext,
                event,
                ticket,
            ),
        ).toBeUndefined();
    });
});
