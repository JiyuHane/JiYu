import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { PushMsg, PushMsgBody } from '@snowluma/proto-defs/message';
import type { GroupChange } from '@snowluma/proto-defs/notify';
import { protobuf_encode } from '@snowluma/proton';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BridgeEventBus } from '../src/event-bus';
import type { QQEventVariant } from '../src/events';
import { GroupInviteTracker } from '../src/group-invite-tracker';
import { IdentityService } from '../src/identity-service';
import { parseDirectMsgPushOrThrow } from '../src/msg-push';
import { IncomingPacketPipeline } from '../src/packet-pipeline';
import type { QQGroupInfo } from '../src/qq-info';

// These accounts, messages and all dependencies are synthetic and memory-only.
const COMMAND = 'trpc.msg.olpush.OlPushService.MsgPush';
const A = '2000000001';
const B = '2000000002';
const GROUP = 9999;
const PEER = 10001;
type DirectInput = Parameters<typeof parseDirectMsgPushOrThrow>[0];

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function input(uin: string, body: Uint8Array, sequence = 77): DirectInput {
    return { uin, sequence, command: COMMAND, retCode: 0, body };
}

function encode(message: PushMsgBody): Uint8Array {
    return protobuf_encode<PushMsg>({ message });
}

function friendBody(text: string): Uint8Array {
    return encode({
        responseHead: { fromUin: PEER, fromUid: 'synthetic_peer' },
        contentHead: {
            msgType: 166,
            sequence: 32743,
            ntMsgSeq: 63214,
            timestamp: 1700000000,
            msgId: 1,
        },
        body: { richText: { elems: [{ text: { str: text } }] } },
    });
}

function groupBody(text: string): Uint8Array {
    return encode({
        responseHead: { fromUin: 222, grp: { groupUin: GROUP, memberName: 'Synthetic Bob' } },
        contentHead: { msgType: 82, sequence: 120, timestamp: 1700000120, msgId: 5120 },
        body: { richText: { elems: [{ text: { str: text } }] } },
    });
}

function joinBody(): Uint8Array {
    return encode({
        responseHead: { fromUin: GROUP, fromUid: '' },
        contentHead: { msgType: 33, subType: 0, sequence: 800, timestamp: 1700000000, msgId: 555 },
        body: { msgContent: protobuf_encode<GroupChange>({ groupUin: GROUP, memberUid: 'u_new' }) },
    });
}

function group(): QQGroupInfo {
    return {
        groupId: GROUP,
        groupName: 'synthetic group',
        remark: '',
        memberCount: 0,
        memberMax: 500,
        members: new Map(),
    };
}

function setup(uin = A) {
    const identity = IdentityService.memory(uin);
    const events = new BridgeEventBus();
    const captured: QQEventVariant[] = [];
    events.onAny((event) => {
        captured.push(event);
    });
    const fetchGroupList = vi.fn(async () => {});
    const fetchGroupMemberList = vi.fn(async (_groupId: number) => {});
    const resolveGroupJoinRequest = vi.fn(async () => null);
    const pipeline = new IncomingPacketPipeline({
        identity,
        events,
        fetchGroupList,
        fetchGroupMemberList,
        resolveGroupJoinRequest,
        groupInvites: new GroupInviteTracker(),
    });
    return { identity, events, captured, pipeline, fetchGroupList, fetchGroupMemberList };
}

function direct(f: ReturnType<typeof setup>, value: DirectInput): Promise<void> {
    const parsed = parseDirectMsgPushOrThrow(value, f.identity);
    return f.pipeline.processDecodedDirectEvents(
        { serviceCmd: value.command, seqId: value.sequence },
        parsed,
    );
}

// Only the legacy contract needs a full PacketInfo. The direct path never uses it.
function legacyPacket(): PacketInfo {
    return {
        pid: 1,
        uin: A,
        serviceCmd: COMMAND,
        seqId: 77,
        retCode: 0,
        fromClient: false,
        body: new Uint8Array(),
    };
}

const previousLogLevel = getLogLevel();
afterEach(() => {
    setLogLevel(previousLogLevel);
    vi.restoreAllMocks();
});

describe('direct protobuf through the memory-only packet pipeline', () => {
    it('delivers friend and group events to the correct account bus and preserves caller-owned bytes', async () => {
        const a = setup(A);
        const b = setup(B);
        const friend = input(A, friendBody('synthetic friend A'), 91);
        const groupPush = input(B, groupBody('synthetic group B'), 92);
        const friendBytes = Uint8Array.from(friend.body);
        const groupBytes = Uint8Array.from(groupPush.body);
        const aDispatch = vi.spyOn(a.pipeline, 'processDecodedDirectEvents');
        const bDispatch = vi.spyOn(b.pipeline, 'processDecodedDirectEvents');

        // Parse must finish successfully before any pipeline call is made.
        expect(() => parseDirectMsgPushOrThrow(friend, b.identity)).toThrow(
            /identity UIN mismatch/,
        );
        expect(aDispatch).not.toHaveBeenCalled();
        expect(bDispatch).not.toHaveBeenCalled();
        expect(a.captured).toEqual([]);
        expect(b.captured).toEqual([]);

        await direct(a, friend);
        expect(b.captured).toEqual([]);
        await direct(b, groupPush);
        expect(aDispatch.mock.calls[0]?.[0]).toEqual({ serviceCmd: COMMAND, seqId: 91 });
        expect(bDispatch.mock.calls[0]?.[0]).toEqual({ serviceCmd: COMMAND, seqId: 92 });
        expect(a.captured).toMatchObject([
            {
                kind: 'friend_message',
                selfUin: Number(A),
                senderUin: PEER,
                senderUid: 'synthetic_peer',
                msgSeq: 32743,
                elements: [{ type: 'text', text: 'synthetic friend A' }],
            },
        ]);
        expect(b.captured).toMatchObject([
            {
                kind: 'group_message',
                selfUin: Number(B),
                groupId: GROUP,
                senderUin: 222,
                senderNick: 'Synthetic Bob',
                msgSeq: 120,
                elements: [{ type: 'text', text: 'synthetic group B' }],
            },
        ]);
        expect(a.identity.findUinByUid('synthetic_peer')).toBe(PEER);
        expect(b.identity.findUinByUid('synthetic_peer')).toBeNull();
        expect(friend.body).toEqual(friendBytes);
        expect(groupPush.body).toEqual(groupBytes);

        // The caller may clear its own body; decoded strings observed here survive.
        friend.body.fill(0);
        expect(a.captured).toMatchObject([
            {
                elements: [{ type: 'text', text: 'synthetic friend A' }],
            },
        ]);
    });

    it('resolves after synchronous bus dispatch but before an async subscriber settles', async () => {
        const f = setup();
        const gate = deferred<void>();
        const entered = deferred<void>();
        let settled = false;
        f.events.on('friend_message', async () => {
            entered.resolve();
            await gate.promise;
            settled = true;
        });

        try {
            const work = direct(f, input(A, friendBody('synthetic async subscriber')));
            await entered.promise;
            await work;
            expect(f.captured).toHaveLength(1);
            expect(settled).toBe(false);
        } finally {
            gate.resolve();
        }

        await gate.promise;
        await Promise.resolve();
        expect(settled).toBe(true);
    });

    it('waits for direct join enrichment while detached roster refresh remains pending', async () => {
        const f = setup();
        f.identity.rememberGroups([group()]);
        const enrichment = deferred<number | null>();
        const refresh = deferred<void>();
        vi.spyOn(f.identity, 'resolveUin').mockReturnValue(enrichment.promise);
        f.fetchGroupMemberList.mockImplementation(() => refresh.promise);
        const value = input(A, joinBody());
        const decoded = parseDirectMsgPushOrThrow(value, f.identity);
        expect(decoded).toMatchObject([
            { kind: 'group_member_join', userUid: 'u_new', userUin: 0 },
        ]);
        let completed = false;
        const work = f.pipeline
            .processDecodedDirectEvents(
                { serviceCmd: value.command, seqId: value.sequence },
                decoded,
            )
            .then(() => {
                completed = true;
            });

        try {
            await Promise.resolve();
            expect(completed).toBe(false);
            expect(f.captured).toEqual([]);
            enrichment.resolve(23456);
            await work;
            expect(f.captured).toMatchObject([
                {
                    kind: 'group_member_join',
                    selfUin: Number(A),
                    groupId: GROUP,
                    userUid: 'u_new',
                    userUin: 23456,
                },
            ]);
            expect(f.identity.findUinByUid('u_new', GROUP)).toBe(23456);
            expect(f.fetchGroupMemberList).toHaveBeenCalledExactlyOnceWith(GROUP);
            expect(completed).toBe(true);
        } finally {
            enrichment.resolve(null);
            refresh.resolve();
        }

        await refresh.promise;
    });

    it('shares pending roster-refresh state between legacy and direct entry points', async () => {
        const f = setup();
        f.identity.rememberGroups([group()]);
        const refresh = deferred<void>();
        f.fetchGroupMemberList.mockImplementation(() => refresh.promise);
        const event = (): QQEventVariant => ({
            kind: 'group_admin',
            time: 1,
            selfUin: Number(A),
            groupId: GROUP,
            userUin: 222,
            set: true,
        });

        try {
            await f.pipeline.processEvents(legacyPacket(), [event()]);
            await f.pipeline.processDecodedDirectEvents({ serviceCmd: COMMAND, seqId: 78 }, [
                event(),
            ]);
            expect(f.captured).toHaveLength(2);
            expect(f.fetchGroupMemberList).toHaveBeenCalledExactlyOnceWith(GROUP);
        } finally {
            refresh.resolve();
        }

        await refresh.promise;
    });

    it('snapshots trace getter values before asynchronous enrichment resumes', async () => {
        const f = setup();
        const gate = deferred<number | null>();
        vi.spyOn(f.identity, 'resolveUin').mockReturnValue(gate.promise);
        const value = input(A, joinBody());
        const decoded = parseDirectMsgPushOrThrow(value, f.identity);
        const entries: LogEntry[] = [];
        let command = COMMAND;
        let sequence = 77;
        let commandReads = 0;
        let sequenceReads = 0;
        const trace = {
            get serviceCmd() {
                commandReads++;
                return command;
            },
            get seqId() {
                sequenceReads++;
                return sequence;
            },
        };
        setLogLevel('trace');
        const unsubscribe = subscribeLogs((entry) => entries.push(entry));

        try {
            const work = f.pipeline.processDecodedDirectEvents(trace, decoded);
            command = 'synthetic.changed';
            sequence = 999;
            gate.resolve(23456);
            await work;
            expect(commandReads).toBe(1);
            expect(sequenceReads).toBe(1);
            const terminal = entries.filter(
                (entry) =>
                    entry.scope === 'Protocol.Packet' && entry.message.includes('packet_terminal'),
            );
            expect(terminal).toHaveLength(1);
            expect(terminal[0]?.message).toContain(`serviceCmd="${COMMAND}" seqId=77`);
        } finally {
            gate.resolve(null);
            unsubscribe();
        }
    });

    it('propagates a throwing trace getter before dispatch without inventing an event', () => {
        const f = setup();
        const value = input(A, friendBody('getter fixture'));
        const decoded = parseDirectMsgPushOrThrow(value, f.identity);
        const marker = new Error('synthetic trace getter failure');
        const trace = {
            get serviceCmd(): string {
                throw marker;
            },
            seqId: value.sequence,
        };
        expect(() => f.pipeline.processDecodedDirectEvents(trace, decoded)).toThrow(marker);
        expect(f.captured).toEqual([]);
        expect(f.identity.findUinByUid('synthetic_peer')).toBeNull();
    });

    it('reports a bounded parser failure if the synthetic trace logger throws once', async () => {
        const f = setup();
        const value = input(A, friendBody('log failure fixture'));
        const decoded = parseDirectMsgPushOrThrow(value, f.identity);
        const entries: LogEntry[] = [];
        let throws = 0;
        setLogLevel('trace');
        const unsubscribe = subscribeLogs((entry) => {
            entries.push(entry);

            if (
                entry.scope === 'Protocol.Packet' &&
                entry.message.includes('branch=parser_events') &&
                throws++ === 0
            ) {
                throw new Error('synthetic log failure');
            }
        });

        try {
            await f.pipeline.processDecodedDirectEvents(
                { serviceCmd: value.command, seqId: value.sequence },
                decoded,
            );
            expect(throws).toBe(1);
            expect(f.captured).toEqual([]);
            expect(f.identity.findUinByUid('synthetic_peer')).toBeNull();
            expect(
                entries.filter(
                    (entry) =>
                        entry.scope === 'Protocol.Packet' &&
                        entry.message.includes('packet_terminal'),
                ),
            ).toEqual([
                expect.objectContaining({
                    message: expect.stringMatching(/outcome=failed reason=parser_exception/),
                }),
            ]);
        } finally {
            unsubscribe();
        }
    });

    it('matches legacy PacketInfo dispatch including mutable events, getters and identity effects', async () => {
        const old = setup();
        const directPath = setup();

        const makeEvents = () => {
            let reads = 0;
            const first: QQEventVariant = {
                kind: 'friend_message',
                time: 1,
                selfUin: Number(A),
                senderUin: PEER,
                senderUid: 'synthetic_peer',
                senderNick: '',
                msgSeq: 1,
                msgId: 2,
                elements: [{ type: 'text', text: 'first' }],
            };
            const second: QQEventVariant = {
                kind: 'friend_message',
                time: 2,
                selfUin: Number(A),
                senderUin: PEER + 1,
                senderUid: 'synthetic_peer_two',
                senderNick: '',
                msgSeq: 2,
                msgId: 3,
                elements: [{ type: 'text', text: 'before' }],
            };
            Object.defineProperty(second, 'senderUid', {
                configurable: true,
                enumerable: true,
                get() {
                    reads++;
                    return 'synthetic_peer_two';
                },
            });
            return { events: [first, second], getReads: () => reads };
        };

        const oldFixture = makeEvents();
        const directFixture = makeEvents();

        const mutate = (fixture: ReturnType<typeof makeEvents>) => (event: QQEventVariant) => {
            if (event === fixture.events[0]) {
                const second = fixture.events[1];

                if (second.kind === 'friend_message') {
                    second.elements = [{ type: 'text', text: 'after' }];
                }
            }
        };

        old.events.onAny(mutate(oldFixture));
        directPath.events.onAny(mutate(directFixture));
        const entries: LogEntry[] = [];
        setLogLevel('trace');
        const unsubscribe = subscribeLogs((entry) => entries.push(entry));
        const messages = () =>
            entries
                .filter((entry) => entry.scope === 'Protocol.Packet')
                .map((entry) => entry.message.replace(/elapsedMs=\d+/, 'elapsedMs=<elapsed>'));

        try {
            await old.pipeline.processEvents(legacyPacket(), oldFixture.events);
            const oldTrace = messages();
            entries.length = 0;
            await directPath.pipeline.processDecodedDirectEvents(
                { serviceCmd: COMMAND, seqId: 77 },
                directFixture.events,
            );
            const oldReads = oldFixture.getReads();
            const directReads = directFixture.getReads();
            expect(directReads).toBe(oldReads);
            expect(directReads).toBeGreaterThan(0);
            expect(messages()).toEqual(oldTrace);
            expect(directPath.captured).toEqual(old.captured);
            expect(directPath.captured[1]).toMatchObject({
                elements: [{ type: 'text', text: 'after' }],
            });
            expect(directPath.identity.findUinByUid('synthetic_peer')).toBe(
                old.identity.findUinByUid('synthetic_peer'),
            );
            expect(directPath.identity.findUinByUid('synthetic_peer_two')).toBe(
                old.identity.findUinByUid('synthetic_peer_two'),
            );
        } finally {
            unsubscribe();
        }
    });
});
