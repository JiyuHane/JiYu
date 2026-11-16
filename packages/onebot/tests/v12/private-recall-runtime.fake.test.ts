import { EventEmitter } from 'node:events';
import type { FriendRecall as RecallWire } from '@snowluma/proto-defs/notify';
import { protobuf_encode } from '@snowluma/proton';
import type { MsgPushContext } from '@snowluma/protocol/msg-push/context';
import { decodeEvent0x210 } from '@snowluma/protocol/msg-push/decoders/event-0x210';
import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DispatchPayload } from '../../src/event-filter';
import type { JsonObject, NetworkBase } from '../../src/types';

// The only mocked module owns the listener. No real socket or connect is created.
const transports = vi.hoisted(() => ({
    options: [] as Array<{ subscribe: (listener: (event: unknown) => void) => () => void }>,
}));
vi.mock('../../src/v12-network', () => ({
    V12Transport: class {
        constructor(options: { subscribe: (listener: (event: unknown) => void) => () => void }) {
            transports.options.push(options);
        }
        async open() {}
        async close() {}
        quiesce() {}
        forceClose() {}
    },
}));

import { buildDispatchPayload } from '../../src/event-filter';
import { registerEventPipeline } from '../../src/event-pipeline';
import type { OneBotInstanceContext } from '../../src/instance-context';
import { PRIVATE_MESSAGE_EVENT } from '../../src/message-id';
import { MessageStore } from '../../src/message-store';
import { IOneBotNetworkAdapter } from '../../src/network/adapter';
import { OneBotNetworkManager } from '../../src/network/network-manager';
import { TempSessionStore } from '../../src/temp-session-store';
import { V12_ADAPTER_NAME } from '../../src/v12-runtime/identity';
import {
    activateOrderedPollOwner,
    activatePollOwner,
    pollOwnerStats,
} from '../../src/v12-runtime/poll-owner';
import {
    capturePrivateRecallSource,
    getPrivateRecallSource,
} from '../../src/v12-runtime/private-recall-source';
import { V12Runtime } from '../../src/v12-runtime/runtime';
import {
    bindOrderedContext,
    captureBinding,
    captureSource,
    claimOrderedScope,
    installOrderedReady,
    prepareOrderedContext,
    receiveSourceEvent,
    reserveOrderedContext,
    sameSourceEpoch,
    SourceGeneration,
    withOrderedScope,
    type OrderedAdmission,
    type V12Source,
} from '../../src/v12-runtime/source-generation';

const SELF = 10001;
const PEER = 20002;
const TIME = 1700000100;
type Recall = Extract<QQEventVariant, { kind: 'friend_recall' }>;

function recall(sequence: number, direction: boolean | undefined): Recall {
    return {
        kind: 'friend_recall',
        time: TIME,
        selfUin: SELF,
        userUin: PEER,
        msgSeq: sequence,
        clientSeq: sequence,
        recalledBySelf: direction,
    };
}

// A schema-generated protocol fixture, not a packet from a QQ session.
function decodedRecall(direction: boolean, identity: IdentityService): Recall {
    const subtype = direction ? 139 : 138;
    const content = protobuf_encode<RecallWire>({
        info: {
            fromUid: direction ? 'synthetic-self' : 'synthetic-peer',
            toUid: direction ? 'synthetic-peer' : 'synthetic-self',
            clientSequence: 444,
            time: TIME,
        },
    });
    const input: MsgPushContext = {
        head: {
            msgType: 0x210,
            subType: subtype,
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
    const events = decodeEvent0x210(input);

    if (events.length !== 1 || events[0].kind !== 'friend_recall') {
        throw new Error('synthetic recall did not decode');
    }

    return events[0];
}

// A legacy adapter is a pure in-memory fanout observer.
class LegacySink extends IOneBotNetworkAdapter<NetworkBase> {
    readonly messages: string[] = [];
    constructor() {
        super(
            'synthetic-v11',
            {
                name: 'synthetic-v11',
                enabled: true,
                messageFormat: 'array',
                reportSelfMessage: false,
            },
            {
                uin: String(SELF),
                api: {} as never,
                buildLifecycleEvent: () => ({}),
                buildHeartbeatEvent: () => ({}),
            },
        );
    }
    open() {
        this.isEnabled = true;
    }
    close() {
        this.isEnabled = false;
    }
    onEvent(_event: JsonObject, payload: DispatchPayload) {
        this.messages.push(payload.arrayJson);
    }
    describeStatus() {
        return {
            name: this.name,
            kind: 'httpClient' as const,
            status: 'ok' as const,
            detail: 'in-memory',
        };
    }
}

async function fixture(subscribeObserver = true) {
    const identity = IdentityService.memory(String(SELF));
    identity.rememberRequestIdentity({ uid: 'synthetic-peer', uin: PEER });
    const store = new MessageStore(':memory:');
    await store.initialization;
    const errors: unknown[] = [];
    const bus = new BridgeEventBus({ onError: (_kind, error) => errors.push(error) });
    const manager = new OneBotNetworkManager();
    const legacy = new LegacySink();
    legacy.open();
    const generation = new SourceGeneration();
    generation.setOnline(true);
    let ctx!: OneBotInstanceContext;
    let runtime!: V12Runtime;
    let onVerify: (() => void) | undefined;
    let onLookup: ((event: JsonObject) => void) | undefined;
    runtime = new V12Runtime(
        {
            name: V12_ADAPTER_NAME,
            enabled: true,
            host: 'fake',
            port: 1,
            allowNonLoopback: false,
            messageFormat: 'array',
            reportSelfMessage: true,
        },
        {
            uin: String(SELF),
            api: {} as never,
            buildLifecycleEvent: () => ({}),
            buildHeartbeatEvent: () => ({}),
        },
        {
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: async () => null,
            trackAction: (_label, start) => start(),
            canAccept: () => true,
            captureCurrentSource: () => generation.capture(runtime[captureBinding]()),
            isSourceCurrent: (source, binding) => {
                const current =
                    manager.get(V12_ADAPTER_NAME) === runtime &&
                    generation.isCurrent(source, binding);
                onVerify?.();
                return current;
            },
            getPrivateRecallSource: (event) => {
                onLookup?.(event);
                return getPrivateRecallSource(ctx, event);
            },
        },
    );
    manager.register(runtime);
    manager.register(legacy);
    await runtime.open();
    const options = transports.options.at(-1);

    if (!options) {
        throw new Error('fake transport did not construct');
    }

    const published: any[] = [];

    if (subscribeObserver) {
        options.subscribe((event) => published.push(event));
        published.length = 0;
    }

    const v11: JsonObject[] = [];
    const tickets: Array<V12Source | undefined> = [];
    ctx = {
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
        [captureSource]: () => generation.capture(runtime[captureBinding]()),
        dispatchEvent: (event, _source, _startedAt, ticket) => {
            v11.push(event);
            tickets.push(ticket);
            const admission = claimOrderedScope(ctx, 'context', event);
            const emit = () => manager.emitEvent(event, ticket);
            return admission
                ? withOrderedScope(manager, 'manager', event, admission, emit)
                : emit();
        },
    };
    const pipeline = registerEventPipeline(ctx);
    return {
        identity,
        store,
        bus,
        manager,
        legacy,
        generation,
        runtime,
        ctx,
        v11,
        tickets,
        published,
        errors,
        subscribe: options.subscribe,
        captureOnly() {
            const previous = ctx.dispatchEvent;

            ctx.dispatchEvent = (event, _source, _startedAt, ticket) => {
                v11.push(event);
                tickets.push(ticket);
            };

            return () => {
                ctx.dispatchEvent = previous;
            };
        },
        onVerify(callback: (() => void) | undefined) {
            onVerify = callback;
        },
        onLookup(callback: ((event: JsonObject) => void) | undefined) {
            onLookup = callback;
        },
        async seed(id: number, sequence: number, selfSent: boolean, peer = PEER) {
            await store.storeMeta(id, {
                isGroup: false,
                targetId: peer,
                sequence: 63214,
                sequenceAuthoritative: true,
                eventName: PRIVATE_MESSAGE_EVENT,
                clientSequence: sequence,
                privateDirection: selfSent ? 'outgoing' : 'incoming',
                random: 1,
                timestamp: TIME - 10,
            });
        },
        async close() {
            pipeline.stop();
            await pipeline.drain();
            bus.clear();
            await runtime.close();
            legacy.close();
            await store.close();
            await identity.close();
        },
    };
}

class Sink extends EventEmitter {
    body = '';
    isOpen() {
        return true;
    }
    writeHead() {}
    end(body: string) {
        this.body = body;
        this.emit('finish');
    }
}

async function settle() {
    for (let i = 0; i < 12; i++) {
        await Promise.resolve();
    }
}

type FakeFixture = Awaited<ReturnType<typeof fixture>>;
type EligibleAdmission = Extract<OrderedAdmission, { kind: 'eligible' }>;

function installFakeOrderedOwner(f: FakeFixture) {
    const active = activateOrderedPollOwner(f.runtime);

    if (active.status !== 'ready') {
        throw new Error('fake owner was not ready');
    }

    prepareOrderedContext(f.ctx, f.runtime);

    if (!installOrderedReady(f.ctx, f.runtime, active.owner)) {
        active.owner.invalidate();
        throw new Error('fake ordered context was not ready');
    }

    return active.owner;
}

function reserveEligible(f: FakeFixture, source: V12Source): EligibleAdmission {
    const admission = bindOrderedContext(f.ctx, reserveOrderedContext(f.ctx), source, true);
    expect(admission.kind).toBe('eligible');

    if (admission.kind !== 'eligible') {
        throw new Error('fake input was not admitted');
    }

    return admission;
}

function deliverAdmitted(
    f: FakeFixture,
    event: JsonObject,
    admission: EligibleAdmission,
    source: V12Source | null,
    payload = buildDispatchPayload(event),
) {
    return withOrderedScope(f.runtime, 'runtime', event, admission, () =>
        source === null
            ? f.runtime.onEvent(event, payload)
            : f.runtime[receiveSourceEvent](event, payload, source),
    );
}

function pollRequest() {
    return {
        limit: 0,
        timeoutMs: 0,
        maxOutputBytes: 65536,
        responseDeadline: performance.now() + 5000,
    };
}

afterEach(() => {
    vi.useRealTimers();
    transports.options.length = 0;
});

describe('private recall: real pipeline, manager and V12Runtime with fake transport', () => {
    it.each([
        [false, -2147483648, String(PEER)],
        [true, -123456789, String(SELF)],
        [false, 1, String(PEER)],
        [true, 2147483647, String(SELF)],
    ] as const)(
        'publishes direction=%s and signed message ID %s without changing v11',
        async (direction, id, sender) => {
            const f = await fixture();

            try {
                await f.seed(id, 444, direction);
                const nativeEvent = decodedRecall(direction, f.identity);
                expect(nativeEvent).toEqual(recall(444, direction));
                await f.bus.emit(nativeEvent);
                const v11 = {
                    time: TIME,
                    self_id: SELF,
                    post_type: 'notice',
                    notice_type: 'friend_recall',
                    user_id: PEER,
                    message_id: id,
                };
                expect(f.v11).toEqual([v11]);
                expect(f.legacy.messages).toEqual([JSON.stringify(v11)]);
                expect(f.published).toEqual([
                    {
                        id: expect.any(String),
                        time: TIME,
                        type: 'notice',
                        detail_type: 'private_message_delete',
                        sub_type: '',
                        self: { platform: 'qq', user_id: String(SELF) },
                        message_id: String(id),
                        user_id: sender,
                    },
                ]);
                expect(getPrivateRecallSource(f.ctx, f.v11[0])?.sourceTicket).toBe(f.tickets[0]);
                expect(f.errors).toEqual([]);
            } finally {
                await f.close();
            }
        },
    );

    it('requires the original event and exact ticket, not a same-generation or missing ticket', async () => {
        const f = await fixture();

        try {
            await f.seed(-100, 444, false);
            await f.bus.emit(recall(444, false));
            expect(f.published).toHaveLength(1);
            const event = f.v11[0];
            const original = f.tickets[0]!;
            const other = f.generation.capture(f.runtime[captureBinding]())!;
            expect(original).not.toBe(other);
            expect(sameSourceEpoch(original, other)).toBe('same');
            expect(f.generation.isCurrent(other, f.runtime[captureBinding]())).toBe(true);
            await f.manager.emitEvent(event, other);
            await f.manager.emitEvent(event);
            await f.manager.emitEvent({ ...event }, original);
            expect(f.published).toHaveLength(1);
            expect(f.legacy.messages).toHaveLength(4);
            expect(f.legacy.messages.every((text) => text === JSON.stringify(event))).toBe(true);
        } finally {
            await f.close();
        }
    });

    it('publishes at most once when source verification reenters the same receive scope', async () => {
        const f = await fixture();

        try {
            await f.seed(-110, 444, false);
            const restore = f.captureOnly();

            try {
                await f.bus.emit(recall(444, false));
            } finally {
                restore();
            }

            expect(f.published).toEqual([]);
            const event = f.v11[0];
            const payload = buildDispatchPayload(event);
            const ticket = f.tickets[0]!;
            let reentered = false;
            f.onVerify(() => {
                if (!reentered) {
                    reentered = true;
                    void f.runtime.onEvent(event, payload);
                }
            });
            await f.runtime[receiveSourceEvent](event, payload, ticket);
            expect(reentered).toBe(true);
            expect(f.published).toHaveLength(1);
            expect(f.published[0]).toMatchObject({
                detail_type: 'private_message_delete',
                message_id: '-110',
                user_id: String(PEER),
            });
        } finally {
            f.onVerify(undefined);
            await f.close();
        }
    });

    it('blocks reentrant receive scopes and replay for the same recall object and ticket', async () => {
        const f = await fixture();

        try {
            await f.seed(-113, 444, false);
            const restore = f.captureOnly();

            try {
                await f.bus.emit(recall(444, false));
            } finally {
                restore();
            }

            expect(f.published).toEqual([]);
            const event = f.v11[0];
            const payload = buildDispatchPayload(event);
            const ticket = f.tickets[0]!;
            let reentered = false;
            f.onVerify(() => {
                if (!reentered) {
                    reentered = true;
                    void f.runtime[receiveSourceEvent](event, payload, ticket);
                }
            });
            await f.runtime[receiveSourceEvent](event, payload, ticket);
            expect(reentered).toBe(true);
            expect(f.published).toHaveLength(1);
            expect(f.published[0]).toMatchObject({
                detail_type: 'private_message_delete',
                message_id: '-113',
            });
            // A later replay of this exact event/ticket pair is also skipped.
            f.onVerify(undefined);
            await f.runtime[receiveSourceEvent](event, payload, ticket);
            expect(f.published).toHaveLength(1);
        } finally {
            f.onVerify(undefined);
            await f.close();
        }
    });

    it('does not deduplicate distinct recorded events with the same visible v11 fields', async () => {
        const f = await fixture();

        try {
            await f.seed(-115, 441, false);
            await f.bus.emit(recall(441, false));
            await f.seed(-115, 442, false);
            await f.bus.emit(recall(442, false));
            expect(f.v11).toHaveLength(2);
            expect(f.v11[0]).not.toBe(f.v11[1]);
            expect(f.v11[0]).toEqual(f.v11[1]);
            expect(f.tickets[0]).not.toBe(f.tickets[1]);
            expect(f.published).toHaveLength(2);
            expect(f.published.map((value) => value.message_id)).toEqual(['-115', '-115']);
        } finally {
            await f.close();
        }
    });

    it('publishes once when lookup restores a mutated type and reenters with the same source', async () => {
        const f = await fixture();

        try {
            await f.seed(-118, 444, false);
            const restore = f.captureOnly();

            try {
                await f.bus.emit(recall(444, false));
            } finally {
                restore();
            }

            const event = f.v11[0];
            const ticket = f.tickets[0]!;
            expect(getPrivateRecallSource(f.ctx, event)?.sourceTicket).toBe(ticket);
            expect(f.published).toEqual([]);
            event.notice_type = 'friend_add';
            const payload = buildDispatchPayload(event);
            const observed: Array<{ sameObject: boolean; initialType: unknown }> = [];
            let reentered = false;
            // A trusted in-process injection exercises synchronous reentry; it is
            // not a claim that a remote caller can perform this mutation.
            f.onLookup((input) => {
                if (!reentered) {
                    reentered = true;
                    observed.push({ sameObject: input === event, initialType: input.notice_type });
                    input.notice_type = 'friend_recall';
                    void f.runtime[receiveSourceEvent](input, payload, ticket);
                }
            });
            await f.runtime[receiveSourceEvent](event, payload, ticket);
            expect(reentered).toBe(true);
            expect(observed).toEqual([{ sameObject: true, initialType: 'friend_add' }]);
            expect(event.notice_type).toBe('friend_recall');
            expect(f.published).toHaveLength(1);
            expect(f.published[0]).toMatchObject({
                type: 'notice',
                detail_type: 'private_message_delete',
                sub_type: '',
                message_id: '-118',
                user_id: String(PEER),
            });
        } finally {
            f.onLookup(undefined);
            await f.close();
        }
    });

    it('keeps ordinary event reentrant delivery unchanged', async () => {
        const f = await fixture();
        const event: JsonObject = {
            time: TIME,
            self_id: SELF,
            post_type: 'notice',
            notice_type: 'friend_add',
            user_id: PEER,
        };
        const payload = buildDispatchPayload(event);
        const ticket = f.generation.capture(f.runtime[captureBinding]())!;
        let reentered = false;
        const unsubscribe = f.subscribe((value: any) => {
            if (value?.detail_type === 'friend_increase' && !reentered) {
                reentered = true;
                void f.runtime[receiveSourceEvent](event, payload, ticket);
            }
        });

        try {
            await f.runtime[receiveSourceEvent](event, payload, ticket);
            expect(reentered).toBe(true);
            expect(f.published).toHaveLength(2);
            expect(f.published.map((value) => value.detail_type)).toEqual([
                'friend_increase',
                'friend_increase',
            ]);
        } finally {
            unsubscribe();
            await f.close();
        }
    });

    it('rechecks the recall source before each subscriber after a synchronous quiesce', async () => {
        const f = await fixture();
        const first: unknown[] = [];
        const second: unknown[] = [];
        const unsubscribeFirst = f.subscribe((value: any) => {
            if (value?.detail_type === 'private_message_delete') {
                first.push(value);
                f.runtime.quiesce();
            }
        });
        const unsubscribeSecond = f.subscribe((value: any) => {
            if (value?.detail_type === 'private_message_delete') {
                second.push(value);
            }
        });

        try {
            await f.seed(-111, 444, true);
            await f.bus.emit(recall(444, true));
            expect(first).toHaveLength(1);
            expect(first[0]).toMatchObject({ message_id: '-111', user_id: String(SELF) });
            expect(second).toEqual([]);
            expect(f.published).toHaveLength(1);
            expect(f.legacy.messages).toHaveLength(1);
        } finally {
            unsubscribeFirst();
            unsubscribeSecond();
            await f.close();
        }
    });

    it.each([false, true])(
        'keeps the private notice immutable across subscribers, first throws=%s',
        async (throwAfterMutation) => {
            const f = await fixture();
            const observations: Array<{ eventFrozen: boolean; selfFrozen: boolean }> = [];
            const later: unknown[] = [];
            const unsubscribeFirst = f.subscribe((value: any) => {
                if (value?.detail_type !== 'private_message_delete') {
                    return;
                }

                observations.push({
                    eventFrozen: Object.isFrozen(value),
                    selfFrozen: Object.isFrozen(value.self),
                });

                try {
                    value.user_id = '3';
                } catch {
                    /* sample failed mutation */
                }

                try {
                    value.message_id = '4';
                } catch {
                    /* sample failed mutation */
                }

                try {
                    value.self.user_id = '5';
                } catch {
                    /* sample failed mutation */
                }

                if (throwAfterMutation) {
                    throw new Error('synthetic subscriber failure');
                }
            });
            const unsubscribeLater = f.subscribe((value: any) => {
                if (value?.detail_type === 'private_message_delete') {
                    later.push(value);
                }
            });

            try {
                await f.seed(-112, 444, false);
                await f.bus.emit(recall(444, false));
                expect(observations).toEqual([{ eventFrozen: true, selfFrozen: true }]);
                expect(later).toEqual([
                    {
                        id: expect.any(String),
                        time: TIME,
                        type: 'notice',
                        detail_type: 'private_message_delete',
                        sub_type: '',
                        self: { platform: 'qq', user_id: String(SELF) },
                        message_id: '-112',
                        user_id: String(PEER),
                    },
                ]);
                expect(f.legacy.messages).toHaveLength(1);
            } finally {
                unsubscribeFirst();
                unsubscribeLater();
                await f.close();
            }
        },
    );

    it('does not redeliver the same private notice when a subscriber resubscribes itself', async () => {
        const f = await fixture();
        const first: unknown[] = [];
        const second: unknown[] = [];

        let unsubscribeFirst = () => {};

        const listener = (value: any) => {
            if (value?.detail_type !== 'private_message_delete') {
                return;
            }

            first.push(value);
            unsubscribeFirst();
            unsubscribeFirst = f.subscribe(listener);
        };

        unsubscribeFirst = f.subscribe(listener);
        const unsubscribeSecond = f.subscribe((value: any) => {
            if (value?.detail_type === 'private_message_delete') {
                second.push(value);
            }
        });

        try {
            await f.seed(-116, 444, false);
            await f.bus.emit(recall(444, false));
            expect(first).toHaveLength(1);
            expect(second).toHaveLength(1);
            expect(f.published).toHaveLength(1);
            expect(f.legacy.messages).toHaveLength(1);
        } finally {
            unsubscribeFirst();
            unsubscribeSecond();
            await f.close();
        }
    });

    it('isolates same-account contexts and rejects expired tickets for recall and ordinary events', async () => {
        const a = await fixture();
        const b = await fixture();

        try {
            await a.seed(-101, 444, false);
            await b.seed(-102, 444, false);
            await a.bus.emit(recall(444, false));
            await b.bus.emit(recall(444, false));
            expect(a.published).toHaveLength(1);
            expect(b.published).toHaveLength(1);
            await b.manager.emitEvent(a.v11[0], b.tickets[0]);
            await a.manager.emitEvent(a.v11[0], b.tickets[0]);
            expect(a.published).toHaveLength(1);
            expect(b.published).toHaveLength(1);
            const old = a.tickets[0]!;
            a.generation.setOnline(false);
            a.generation.setOnline(true);
            expect(a.generation.isCurrent(old, a.runtime[captureBinding]())).toBe(false);
            await a.manager.emitEvent(a.v11[0], old);
            await a.manager.emitEvent(a.v11[0], a.generation.capture(a.runtime[captureBinding]()));
            expect(a.published).toHaveLength(1);
            await a.manager.emitEvent(
                {
                    time: TIME,
                    self_id: SELF,
                    post_type: 'notice',
                    notice_type: 'friend_add',
                    user_id: PEER,
                },
                old,
            );
            expect(a.published).toHaveLength(1);
        } finally {
            await a.close();
            await b.close();
        }
    });

    it('drops a previously undispatched recall whose exact ticket has expired', async () => {
        const f = await fixture();

        try {
            await f.seed(-117, 444, false);
            const restore = f.captureOnly();

            try {
                await f.bus.emit(recall(444, false));
            } finally {
                restore();
            }

            const old = f.tickets[0]!;
            expect(f.generation.isCurrent(old, f.runtime[captureBinding]())).toBe(true);
            f.generation.setOnline(false);
            f.generation.setOnline(true);
            expect(f.generation.isCurrent(old, f.runtime[captureBinding]())).toBe(false);
            await f.manager.emitEvent(f.v11[0], old);
            expect(f.published).toEqual([]);
            expect(f.legacy.messages).toEqual([JSON.stringify(f.v11[0])]);
        } finally {
            await f.close();
        }
    });

    it.each([
        [
            'self',
            (event: JsonObject) => {
                event.self_id = SELF + 1;
            },
        ],
        [
            'peer',
            (event: JsonObject) => {
                event.user_id = PEER + 1;
            },
        ],
        [
            'time',
            (event: JsonObject) => {
                event.time = TIME + 1;
            },
        ],
        [
            'message id',
            (event: JsonObject) => {
                event.message_id = -102;
            },
        ],
        [
            'string message id',
            (event: JsonObject) => {
                event.message_id = '-101';
            },
        ],
        [
            'post type',
            (event: JsonObject) => {
                event.post_type = 'request';
            },
        ],
        [
            'notice type',
            (event: JsonObject) => {
                event.notice_type = 'synthetic_unknown';
            },
        ],
        [
            'extra property',
            (event: JsonObject) => {
                event.extra = true;
            },
        ],
    ] as const)('does not publish a changed original v11 %s field', async (_name, mutate) => {
        const f = await fixture();

        try {
            await f.seed(-101, 444, false);
            const restore = f.captureOnly();

            try {
                await f.bus.emit(recall(444, false));
            } finally {
                restore();
            }

            expect(f.published).toEqual([]);
            const event = f.v11[0];
            mutate(event);
            await f.manager.emitEvent(event, f.tickets[0]);
            expect(f.published).toEqual([]);
            expect(f.legacy.messages.at(-1)).toBe(JSON.stringify(event));
        } finally {
            await f.close();
        }
    });

    it('keeps v11 for unknown direction, missing source and cache miss but publishes no recall', async () => {
        const f = await fixture();

        try {
            await f.seed(-11, 441, false);
            await f.bus.emit(recall(441, undefined));
            await f.seed(-12, 442, false);
            f.ctx[captureSource] = () => undefined;
            await f.bus.emit(recall(442, false));
            f.ctx[captureSource] = () => f.generation.capture(f.runtime[captureBinding]());
            await f.bus.emit(recall(443, false));
            expect(f.v11.map((event) => event.message_id)).toEqual([-11, -12, 443]);
            expect(f.legacy.messages.map((text) => JSON.parse(text).message_id)).toEqual([
                -11, -12, 443,
            ]);
            expect(f.published).toEqual([]);
            expect(f.errors).toEqual([]);
        } finally {
            await f.close();
        }
    });

    it.each(['direction', 'peer-and-time'] as const)(
        'rejects evidence when store receiver getter changes the actual %s arguments',
        async (mode) => {
            const f = await fixture();
            const peer = mode === 'peer-and-time' ? PEER + 1 : PEER;
            const time = mode === 'peer-and-time' ? TIME + 1 : TIME;

            try {
                await f.seed(-23, 441, true, peer);
                const event = recall(441, false);
                const record = vi.spyOn(f.store, 'recordPrivateRecall');
                let receiverReads = 0;
                Object.defineProperty(f.ctx, 'messageStore', {
                    configurable: true,
                    get: () => {
                        receiverReads++;
                        event.recalledBySelf = true;
                        event.userUin = peer;
                        event.time = time;
                        return f.store;
                    },
                });
                await f.bus.emit(event);
                expect(receiverReads).toBe(1);
                expect(record.mock.calls).toEqual([[peer, 441, true, time]]);
                expect(await record.mock.results[0]!.value).toBe(-23);
                expect(f.v11).toEqual([
                    {
                        time,
                        self_id: SELF,
                        post_type: 'notice',
                        notice_type: 'friend_recall',
                        user_id: peer,
                        message_id: -23,
                    },
                ]);
                expect(f.legacy.messages).toEqual([JSON.stringify(f.v11[0])]);
                expect(f.published).toEqual([]);
                record.mockRestore();
            } finally {
                await f.close();
            }
        },
    );

    it('never uses changing direction or sequence getters as provenance or reads them extra times', async () => {
        const previousLevel = getLogLevel();
        setLogLevel('debug');
        const f = await fixture();

        try {
            await f.seed(-24, 441, false);
            const event = recall(441, false);
            let directionReads = 0;
            let sequenceReads = 0;
            Object.defineProperty(event, 'recalledBySelf', {
                enumerable: true,
                configurable: true,
                get: () => ++directionReads !== 1,
            });
            Object.defineProperty(event, 'clientSeq', {
                enumerable: true,
                configurable: true,
                get: () => (++sequenceReads === 1 ? 441 : 442),
            });
            const ticket = f.generation.capture(f.runtime[captureBinding]());
            const candidate = capturePrivateRecallSource(f.ctx, event, ticket);
            expect(candidate).toBeUndefined();
            expect([directionReads, sequenceReads]).toEqual([0, 0]);
            await f.bus.emit(event);
            // Existing v11 calls direction once for the store and once for conversion;
            // it reads the client sequence once. Provenance adds no getter invocation.
            expect([directionReads, sequenceReads]).toEqual([2, 1]);
            expect(f.v11).toEqual([
                {
                    time: TIME,
                    self_id: SELF,
                    post_type: 'notice',
                    notice_type: 'friend_recall',
                    user_id: PEER,
                    message_id: -24,
                },
            ]);
            expect(f.legacy.messages).toEqual([JSON.stringify(f.v11[0])]);
            expect(f.published).toEqual([]);
        } finally {
            await f.close();
            setLogLevel(previousLevel);
        }
    });

    it('preserves a valid ordinary message with a friend_recall-named extension', async () => {
        const f = await fixture();

        try {
            const message: JsonObject = {
                time: TIME,
                self_id: SELF,
                post_type: 'message',
                message_type: 'private',
                sub_type: 'friend',
                message_id: -31,
                user_id: PEER,
                message: [{ type: 'text', data: { text: 'synthetic' } }],
                raw_message: 'synthetic',
                notice_type: 'friend_recall',
            };
            await f.manager.emitEvent(message, f.generation.capture(f.runtime[captureBinding]()));
            expect(f.legacy.messages).toEqual([JSON.stringify(message)]);
            expect(f.published).toEqual([
                {
                    id: expect.any(String),
                    time: TIME,
                    type: 'message',
                    detail_type: 'private',
                    sub_type: '',
                    self: { platform: 'qq', user_id: String(SELF) },
                    message_id: '-31',
                    user_id: String(PEER),
                    message: [{ type: 'text', data: { text: 'synthetic' } }],
                    alt_message: 'synthetic',
                },
            ]);
        } finally {
            await f.close();
        }
    });

    it('skips v12 for a mismatched raw account while preserving the normal v11 result', async () => {
        const f = await fixture();

        try {
            await f.seed(-25, 441, false);
            await f.bus.emit({ ...recall(441, false), selfUin: SELF + 1 });
            expect(f.v11).toEqual([
                {
                    time: TIME,
                    self_id: SELF,
                    post_type: 'notice',
                    notice_type: 'friend_recall',
                    user_id: PEER,
                    message_id: -25,
                },
            ]);
            expect(f.legacy.messages).toEqual([JSON.stringify(f.v11[0])]);
            expect(f.published).toEqual([]);
        } finally {
            await f.close();
        }
    });

    it('exposes the existing store failure without dispatching either version', async () => {
        const f = await fixture();
        const entries: LogEntry[] = [];
        const unsubscribe = subscribeLogs((entry) => entries.push(entry));

        try {
            await f.bus.emit(recall(0, false));
            expect(f.v11).toEqual([]);
            expect(f.legacy.messages).toEqual([]);
            expect(f.published).toEqual([]);
            expect(
                entries.some(
                    (entry) =>
                        entry.level === 'error' &&
                        entry.message.includes('invalid private recall client sequence'),
                ),
            ).toBe(true);
        } finally {
            unsubscribe();
            await f.close();
        }
    });

    it.each([false, true])(
        'fails an eligible recall closed with a WS observer present=%s',
        async (subscribeObserver) => {
            vi.useFakeTimers();
            const f = await fixture(subscribeObserver);
            let owner: ReturnType<typeof installFakeOrderedOwner> | undefined;

            let unsubscribe = () => {};

            try {
                owner = installFakeOrderedOwner(f);
                await f.seed(-21, 441, false);
                await f.bus.emit(recall(441, false));
                expect(f.v11[0].message_id).toBe(-21);
                expect(f.legacy.messages).toHaveLength(1);
                expect(f.published).toHaveLength(subscribeObserver ? 1 : 0);

                if (subscribeObserver) {
                    expect(f.published[0]).toMatchObject({
                        detail_type: 'private_message_delete',
                        message_id: '-21',
                    });
                }

                expect(pollOwnerStats(f.runtime)).toMatchObject({
                    accepted: 0,
                    active: false,
                    ordering_gap: true,
                    ordering_reason: 'child_failed',
                });
                await settle();
                expect(activateOrderedPollOwner(f.runtime).status).toBe('degraded');
                const sink = new Sink();
                expect((await owner.start(pollRequest(), sink).result).kind).toBe('epoch_invalid');
                expect(sink.body).toBe('');

                // A second current source still publishes independently after poll revocation.
                const later: unknown[] = [];
                unsubscribe = f.subscribe((value: any) => {
                    if (value?.detail_type === 'private_message_delete') {
                        later.push(value);
                    }
                });
                await f.seed(-22, 442, true);
                await f.bus.emit(recall(442, true));
                expect(later).toHaveLength(1);
                expect(later[0]).toMatchObject({
                    detail_type: 'private_message_delete',
                    message_id: '-22',
                    user_id: String(SELF),
                });

                // Later ordinary data in this epoch cannot be polled as a success either.
                await f.bus.emit({ kind: 'friend_add', selfUin: SELF, userUin: PEER, time: TIME });
                await vi.advanceTimersByTimeAsync(0);
                expect(pollOwnerStats(f.runtime)).toMatchObject({
                    accepted: 0,
                    ordering_gap: true,
                    ordering_reason: 'child_failed',
                });
                const laterSink = new Sink();
                expect((await owner.start(pollRequest(), laterSink).result).kind).toBe(
                    'epoch_invalid',
                );
                expect(laterSink.body).toBe('');
                expect(activateOrderedPollOwner(f.runtime).status).toBe('degraded');
            } finally {
                unsubscribe();
                owner?.invalidate();
                await settle();
                await f.close();
            }
        },
    );

    it('skips unknown direction and cache misses without a new ordered gap', async () => {
        vi.useFakeTimers();
        const f = await fixture();
        let owner: ReturnType<typeof installFakeOrderedOwner> | undefined;

        try {
            owner = installFakeOrderedOwner(f);
            await f.seed(-23, 443, false);
            await f.bus.emit(recall(443, undefined));
            await f.bus.emit(recall(444, false));
            expect(f.v11.map((event) => event.message_id)).toEqual([-23, 444]);
            expect(f.published).toEqual([]);
            expect(pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 0,
                active: true,
                ordering_gap: false,
            });
            await f.bus.emit({ kind: 'friend_add', selfUin: SELF, userUin: PEER, time: TIME });
            await vi.advanceTimersByTimeAsync(0);
            const sink = new Sink();
            expect((await owner.start(pollRequest(), sink).result).kind).toBe('local_finish');
            expect(JSON.parse(sink.body).data).toEqual([f.published[0]]);
            expect(pollOwnerStats(f.runtime)).toMatchObject({ accepted: 1, ordering_gap: false });
        } finally {
            owner?.invalidate();
            await settle();
            await f.close();
        }
    });

    it.each([
        'missing provenance',
        'missing receive scope',
        'different ticket',
        'expired ticket',
        'changed event',
    ] as const)('skips an eligible recall with %s without a new ordered gap', async (mode) => {
        vi.useFakeTimers();
        const f = await fixture();
        let owner: ReturnType<typeof installFakeOrderedOwner> | undefined;

        try {
            await f.seed(-24, 445, false);
            const restore = f.captureOnly();

            try {
                await f.bus.emit(recall(445, false));
            } finally {
                restore();
            }

            const original = f.v11[0];
            const originalTicket = f.tickets[0]!;

            if (mode === 'expired ticket') {
                f.generation.setOnline(false);
                f.generation.setOnline(true);
            }

            owner = installFakeOrderedOwner(f);
            // Keep the reservation current to isolate runtime projection from
            // the owner's existing missing/expired admission-source failure.
            const currentTicket = f.generation.capture(f.runtime[captureBinding]())!;
            const event = mode === 'missing provenance' ? { ...original } : original;

            if (mode === 'changed event') {
                event.user_id = PEER + 1;
            }

            const admission = reserveEligible(f, currentTicket);
            const receivedTicket =
                mode === 'missing receive scope'
                    ? null
                    : mode === 'different ticket'
                      ? currentTicket
                      : originalTicket;
            await deliverAdmitted(f, event, admission, receivedTicket);
            expect(f.published).toEqual([]);
            expect(pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 0,
                active: true,
                ordering_gap: false,
            });

            // The current admitted owner is still usable by a normal event.
            await f.bus.emit({ kind: 'friend_add', selfUin: SELF, userUin: PEER, time: TIME });
            await vi.advanceTimersByTimeAsync(0);
            const sink = new Sink();
            expect((await owner.start(pollRequest(), sink).result).kind).toBe('local_finish');
            expect(JSON.parse(sink.body).data).toEqual([f.published[0]]);
            expect(pollOwnerStats(f.runtime)?.ordering_gap).toBe(false);
        } finally {
            owner?.invalidate();
            await settle();
            await f.close();
        }
    });

    it('keeps pre-ready and duplicate event/ticket attempts as skips', async () => {
        vi.useFakeTimers();
        const f = await fixture();
        const active = activateOrderedPollOwner(f.runtime);

        if (active.status !== 'ready') {
            await f.close();
            throw new Error('fake owner was not ready');
        }

        try {
            prepareOrderedContext(f.ctx, f.runtime);
            await f.seed(-25, 446, false);
            await f.bus.emit(recall(446, false));
            expect(f.published).toHaveLength(1);
            expect(pollOwnerStats(f.runtime)).toMatchObject({ accepted: 0, ordering_gap: false });
            expect(installOrderedReady(f.ctx, f.runtime, active.owner)).not.toBeNull();
            const event = f.v11[0];
            const ticket = f.tickets[0]!;
            const admission = reserveEligible(f, ticket);
            await deliverAdmitted(f, event, admission, ticket);
            expect(f.published).toHaveLength(1);
            expect(pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 0,
                active: true,
                ordering_gap: false,
            });
            await f.bus.emit({ kind: 'friend_add', selfUin: SELF, userUin: PEER, time: TIME });
            await vi.advanceTimersByTimeAsync(0);
            const sink = new Sink();
            expect((await active.owner.start(pollRequest(), sink).result).kind).toBe(
                'local_finish',
            );
            expect(JSON.parse(sink.body).data).toEqual([f.published[1]]);
            expect(pollOwnerStats(f.runtime)?.ordering_gap).toBe(false);
        } finally {
            active.owner.invalidate();
            await settle();
            await f.close();
        }
    });

    it('rechecks the original event after conversion before failing an admission', async () => {
        vi.useFakeTimers();
        const f = await fixture();
        let owner: ReturnType<typeof installFakeOrderedOwner> | undefined;

        try {
            await f.seed(-28, 449, false);
            const restore = f.captureOnly();

            try {
                await f.bus.emit(recall(449, false));
            } finally {
                restore();
            }

            const event = f.v11[0];
            const ticket = f.tickets[0]!;
            const payload = buildDispatchPayload(event);
            owner = installFakeOrderedOwner(f);
            const admission = reserveEligible(f, ticket);
            let checks = 0;
            f.onVerify(() => {
                // Conversion and its first post-conversion check already succeeded.
                if (++checks === 3) {
                    event.user_id = PEER + 1;
                }
            });
            await deliverAdmitted(f, event, admission, ticket, payload);
            f.onVerify(undefined);
            expect(checks).toBeGreaterThanOrEqual(3);
            expect(f.published).toEqual([]);
            expect(pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 0,
                active: true,
                ordering_gap: false,
            });
            await f.bus.emit({ kind: 'friend_add', selfUin: SELF, userUin: PEER, time: TIME });
            await vi.advanceTimersByTimeAsync(0);
            const sink = new Sink();
            expect((await owner.start(pollRequest(), sink).result).kind).toBe('local_finish');
            expect(JSON.parse(sink.body).data).toEqual([f.published[0]]);
        } finally {
            f.onVerify(undefined);
            owner?.invalidate();
            await settle();
            await f.close();
        }
    });

    it.each(['source expires', 'event changes'] as const)(
        'rechecks fanout after fail reenters and the %s',
        async (mode) => {
            vi.useFakeTimers();
            const f = await fixture();
            let owner: ReturnType<typeof installFakeOrderedOwner> | undefined;

            try {
                await f.seed(-26, 447, false);
                const restore = f.captureOnly();

                try {
                    await f.bus.emit(recall(447, false));
                } finally {
                    restore();
                }

                const event = f.v11[0];
                const ticket = f.tickets[0]!;
                const payload = buildDispatchPayload(event);
                owner = installFakeOrderedOwner(f);
                const admission = reserveEligible(f, ticket);
                let checks = 0;
                let reentered = false;
                f.onVerify(() => {
                    checks++;

                    // The first three checks belong to conversion/final eligibility;
                    // the fourth is the lease.fail() source verification.
                    if (checks === 4) {
                        reentered = true;

                        if (mode === 'source expires') {
                            f.generation.setOnline(false);
                            f.generation.setOnline(true);
                        } else {
                            event.user_id = PEER + 1;
                        }

                        void f.runtime[receiveSourceEvent](event, payload, ticket);
                    }
                });
                await deliverAdmitted(f, event, admission, ticket, payload);
                f.onVerify(undefined);
                expect(reentered).toBe(true);
                expect(checks).toBeGreaterThanOrEqual(4);
                expect(f.published).toEqual([]);
                expect(pollOwnerStats(f.runtime)).toMatchObject({
                    accepted: 0,
                    active: false,
                    ordering_gap: true,
                    ordering_reason: 'child_failed',
                });
                const sink = new Sink();
                expect((await owner.start(pollRequest(), sink).result).kind).toBe('epoch_invalid');
                expect(sink.body).toBe('');
            } finally {
                f.onVerify(undefined);
                owner?.invalidate();
                await settle();
                await f.close();
            }
        },
    );

    it('leaves the legacy completion-order owner policy unchanged', async () => {
        const f = await fixture();
        const active = activatePollOwner(f.runtime);

        if (active.status !== 'ready') {
            await f.close();
            throw new Error('fake legacy owner was not ready');
        }

        try {
            await f.seed(-27, 448, false);
            await f.bus.emit(recall(448, false));
            expect(f.published[0]).toMatchObject({
                detail_type: 'private_message_delete',
                message_id: '-27',
            });
            expect(pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 0,
                active: true,
                ordering_gap: false,
            });
            await f.bus.emit({ kind: 'friend_add', selfUin: SELF, userUin: PEER, time: TIME });
            const sink = new Sink();
            expect((await active.owner.start(pollRequest(), sink).result).kind).toBe(
                'local_finish',
            );
            expect(JSON.parse(sink.body).data).toEqual([f.published[1]]);
            expect(pollOwnerStats(f.runtime)).toMatchObject({ accepted: 1, ordering_gap: false });
        } finally {
            active.owner.invalidate();
            await settle();
            await f.close();
        }
    });
});
