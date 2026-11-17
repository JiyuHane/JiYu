import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import { getEventListeners } from 'node:events';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '../../src/types';
import type {
    EventPollBuffer as BufferInstance,
    PollBufferConfig,
} from '../../src/v12-runtime/event-poll-buffer';
import type { PollQueue, PollSink } from '../../src/v12-runtime/poll-transaction';
import type { SourceGeneration, V12Source } from '../../src/v12-runtime/source-ticket';

// Distinct conversions can have identical public IDs and JSON.
vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();
    return { ...actual, randomUUID: () => '11111111-1111-4111-8111-111111111111' };
});
vi.mock('../../src/v12-runtime/poll-owner', () => ({ isCurrentOrderedFacade: () => false }));
vi.mock('@snowluma/sqlite', () => {
    throw new Error('SQLite is outside this in-memory fixture');
});
vi.mock('@snowluma/websocket', () => {
    throw new Error('WebSocket is outside this in-memory fixture');
});

let EventPollBuffer: typeof import('../../src/v12-runtime/event-poll-buffer').EventPollBuffer;
let PollCoordinator: typeof import('../../src/v12-runtime/poll-transaction').PollCoordinator;
let ticketApi: typeof import('../../src/v12-runtime/source-ticket');
let recall: typeof import('../../src/v12-runtime/private-recall-source');
let guards: Array<{ mock: { calls: unknown[] } }> = [];
const buffers: BufferInstance[] = [];

function forbidden(): never {
    throw new Error('unexpected network, child process, or native operation in pure fixture');
}

beforeEach(async () => {
    vi.useFakeTimers();
    buffers.length = 0;
    const fetchGuard = vi.fn(forbidden);
    const webSocketGuard = vi.fn(function ForbiddenWebSocket() {
        return forbidden();
    });
    const eventSourceGuard = vi.fn(function ForbiddenEventSource() {
        return forbidden();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    vi.stubGlobal('EventSource', eventSourceGuard);
    guards = [
        fetchGuard,
        webSocketGuard,
        eventSourceGuard,
        vi.spyOn(net, 'createServer').mockImplementation(forbidden),
        vi.spyOn(net, 'createConnection').mockImplementation(forbidden),
        vi.spyOn(net, 'connect').mockImplementation(forbidden),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(forbidden),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(forbidden),
        vi.spyOn(http, 'createServer').mockImplementation(forbidden),
        vi.spyOn(http, 'request').mockImplementation(forbidden),
        vi.spyOn(http, 'get').mockImplementation(forbidden),
        vi.spyOn(https, 'createServer').mockImplementation(forbidden),
        vi.spyOn(https, 'request').mockImplementation(forbidden),
        vi.spyOn(https, 'get').mockImplementation(forbidden),
        vi.spyOn(http2, 'createServer').mockImplementation(forbidden),
        vi.spyOn(http2, 'createSecureServer').mockImplementation(forbidden),
        vi.spyOn(http2, 'connect').mockImplementation(forbidden),
        vi.spyOn(tls, 'createServer').mockImplementation(forbidden),
        vi.spyOn(tls, 'connect').mockImplementation(forbidden),
        vi.spyOn(dgram, 'createSocket').mockImplementation(forbidden),
        vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(forbidden),
        vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(forbidden),
        vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawn').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawnSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'exec').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFile').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFileSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'fork').mockImplementation(forbidden),
        vi.spyOn(process, 'dlopen').mockImplementation(forbidden),
    ];
    // Guard named built-in imports too, before importing the subjects.
    syncBuiltinESMExports();
    ticketApi = await import('../../src/v12-runtime/source-ticket');
    recall = await import('../../src/v12-runtime/private-recall-source');
    ({ EventPollBuffer } = await import('../../src/v12-runtime/event-poll-buffer'));
    ({ PollCoordinator } = await import('../../src/v12-runtime/poll-transaction'));
});

afterEach(() => {
    for (const q of buffers) {
        q.close();
    }

    const calls = guards.map((guard) => guard.mock.calls.length);
    const timers = vi.getTimerCount();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    guards = [];
    expect(calls).toEqual(calls.map(() => 0));
    expect(timers).toBe(0);
});

const defaults: PollBufferConfig = {
    capacity: 12,
    maxQueueBytes: 8192,
    maxEventBytes: 4096,
    maxWaiters: 8,
    maxTimeoutMs: 1000,
};
const SELF = 10001;
const PEER = 20002;
const TIME = 1_700_000_100;
type Policy = 'reject-new' | 'drop-oldest';
type Recall = Extract<QQEventVariant, { kind: 'friend_recall' }>;
type GuardedResult = Awaited<ReturnType<BufferInstance['reserveGuarded']>>;
type Reserved = Extract<GuardedResult, { status: 'reserved' }>;
type Blocked = Extract<GuardedResult, { status: 'blocked_guarded' }>;
type Options = {
    generation?: SourceGeneration;
    binding?: object;
    ticket?: V12Source;
    selfUin?: number;
    messageId?: number;
    time?: number;
    recalledBySelf?: boolean;
};

function required<T>(value: T | null | undefined, name: string): T {
    if (value === null || value === undefined) {
        throw new Error(`synthetic ${name} missing`);
    }

    return value;
}

// Use the real generation, capture, remembered v11 provenance, conversion and proof.
function fixture(options: Options = {}) {
    const selfUin = options.selfUin ?? SELF;
    const messageId = options.messageId ?? -42;
    const time = options.time ?? TIME;
    const generation = options.generation ?? new ticketApi.SourceGeneration();

    if (!options.generation) {
        generation.setOnline(true);
    }

    const binding = options.binding ?? {};
    const ticket = required(options.ticket ?? generation.capture(binding), 'event ticket');
    const context = { uin: String(selfUin), selfId: selfUin };
    const self = { platform: 'qq', user_id: String(selfUin) };
    const raw: Recall = {
        kind: 'friend_recall',
        selfUin,
        userUin: PEER,
        msgSeq: 445,
        clientSeq: 446,
        time,
        recalledBySelf: options.recalledBySelf ?? false,
    };
    const event: JsonObject = {
        time,
        self_id: selfUin,
        post_type: 'notice',
        notice_type: 'friend_recall',
        user_id: PEER,
        message_id: messageId,
    };
    const snapshot = required(recall.capturePrivateRecallSource(context, raw, ticket), 'snapshot');

    if (!recall.rememberPrivateRecallSource(context, event, snapshot, messageId)) {
        throw new Error('synthetic provenance not remembered');
    }

    const source = required(recall.getPrivateRecallSource(context, event), 'source');
    const candidate = required(recall.convertPrivateRecallEvent(event, self, source), 'candidate');
    const proof = required(
        recall.createPrivateRecallPollProof(event, source, ticket, self, candidate),
        'proof',
    );
    return { generation, binding, ticket, context, self, raw, event, source, candidate, proof };
}

type Fixture = ReturnType<typeof fixture>;

function ownerTicket(f: Fixture): V12Source {
    return required(f.generation.capture(f.binding), 'owner ticket');
}

function scope(source: unknown, self: unknown) {
    return required(recall.createPrivateRecallPollEpochAccountScope(source, self), 'scope');
}

type Scope = ReturnType<typeof scope>;

function scoped(
    ownerScope: Scope,
    patch: Partial<PollBufferConfig> = {},
    policy: Policy = 'reject-new',
) {
    const q = EventPollBuffer.scoped({ ...defaults, ...patch }, policy, ownerScope);
    buffers.push(q);
    return q;
}

function admit(q: BufferInstance, f: Fixture): void {
    expect(q.enqueueScopedRecall(f.candidate, f.proof, f.ticket)).toBe('accepted');
}

function ordinary(id: string, text = '', time = TIME) {
    return { type: 'message', id, text, time };
}

function wireBytes(events: unknown[]): number {
    return Buffer.byteLength(JSON.stringify(events), 'utf8');
}

function reserved(result: GuardedResult): Reserved {
    if (result.status !== 'reserved') {
        throw new Error(`expected reservation, got ${result.status}`);
    }

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.token)).toBe(true);
    expect(result.bytes).toBe(Buffer.byteLength(result.eventsJson, 'utf8'));
    return result;
}

function blocked(result: GuardedResult): Blocked {
    if (result.status !== 'blocked_guarded') {
        throw new Error(`expected guarded blocked head, got ${result.status}`);
    }

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.token)).toBe(true);
    return result;
}

function assertQueue(q: BufferInstance, events: unknown[], reservedCount = 0): void {
    expect(q.stats()).toMatchObject({
        count: events.length,
        queueBytes: wireBytes(events),
        reserved: reservedCount,
    });
}

function resume(q: BufferInstance, receipt: object): void {
    expect(q.resumeGuardedDrain(receipt)).toEqual({ status: 'resumed' });
}

describe('scoped recall poll buffer (pure local epoch/account associations)', () => {
    it('admits an exact event ticket with a distinct same-epoch owner and commits a guarded receipt', async () => {
        const f = fixture({ messageId: -2147483648 });
        const owner = ownerTicket(f);
        const ownerScope = scope(owner, { ...f.self });
        const q = scoped(ownerScope);
        const text = ordinary('雪', '羽😀\n');
        expect(owner).not.toBe(f.ticket);
        expect(ticketApi.sameSourceEpoch(f.ticket, owner)).toBe('same');
        expect(recall.isPrivateRecallPollProofFor(f.proof, f.candidate)).toBe(true);
        expect(
            recall.isPrivateRecallPollProofInEpochAccountScope(f.proof, f.ticket, ownerScope),
        ).toBe(true);
        expect(q.enqueue(text)).toBe('accepted');
        admit(q, f);
        const expected = [text, f.candidate];
        const selection = reserved(await q.reserveGuarded());
        expect(selection.eventsJson).toBe(JSON.stringify(expected));
        expect(selection.bytes).toBeGreaterThan(selection.eventsJson.length);
        assertQueue(q, expected, 2);
        const receipt = q.commitGuardedNoDrain(selection.token, selection);
        expect(receipt).toEqual({ status: 'committed' });
        expect(Object.isFrozen(receipt)).toBe(true);
        assertQueue(q, []);
        expect(await q.reserveGuarded()).toEqual({ status: 'contended' });
        resume(q, receipt);
        expect(await q.reserveGuarded()).toEqual({ status: 'empty' });
        expect(q.oldestDropCount()).toBe(0n);
    });

    it('rejects a substituted same-epoch event ticket and all bypasses before capacity or eviction changes', async () => {
        const f = fixture();
        const owner = ownerTicket(f);
        const q = scoped(scope(owner, f.self), { capacity: 2 }, 'drop-oldest');
        const first = ordinary('first');
        expect(q.enqueue(first)).toBe('accepted');
        admit(q, f);
        const before = q.stats();
        const clone = { ...f.candidate, self: { ...f.candidate.self } };
        expect(clone).toEqual(f.candidate);
        expect(q.enqueueScopedRecall(f.candidate, f.proof, owner)).toBe('invalid');
        expect(q.enqueueScopedRecall(f.candidate, f.proof, {})).toBe('invalid');
        expect(q.enqueueScopedRecall(clone, f.proof, f.ticket)).toBe('invalid');
        expect(q.enqueueScopedRecall(f.candidate, {}, f.ticket)).toBe('invalid');
        expect(q.enqueue(f.candidate)).toBe('invalid');
        expect(q.enqueue(clone)).toBe('invalid');
        expect(q.enqueueGuarded(f.candidate, f.proof)).toBe('invalid');
        expect(q.stats()).toEqual(before);
        expect(q.oldestDropCount()).toBe(0n);
        const selection = reserved(await q.reserveGuarded());
        expect(selection.eventsJson).toBe(JSON.stringify([first, f.candidate]));
    });

    it('rejects wrong accounts, bindings, generation instances, later epochs and fabricated tickets', () => {
        const f = fixture();
        const owner = ownerTicket(f);
        const ownerScope = scope(owner, f.self);
        const q = scoped(ownerScope, { capacity: 2 }, 'drop-oldest');
        const seed = ordinary('seed');
        expect(q.enqueue(seed)).toBe('accepted');
        admit(q, f);
        const before = q.stats();
        const otherAccount = fixture({
            generation: f.generation,
            binding: f.binding,
            selfUin: SELF + 1,
        });
        const otherBinding = fixture({ generation: f.generation, binding: {} });
        const otherGeneration = new ticketApi.SourceGeneration();
        otherGeneration.setOnline(true);
        const otherInstance = fixture({ generation: otherGeneration, binding: f.binding });
        const fakeTicket = {} as V12Source;
        const fake = fixture({ generation: f.generation, binding: f.binding, ticket: fakeTicket });
        f.generation.setOnline(false);
        f.generation.setOnline(true);
        const later = fixture({ generation: f.generation, binding: f.binding });
        expect(recall.isPrivateRecallPollProofFor(fake.proof, fake.candidate)).toBe(true);
        expect(ticketApi.sameSourceEpoch(fake.ticket, owner)).toBe('invalid');

        for (const invalid of [otherAccount, otherBinding, otherInstance, fake, later]) {
            expect(recall.isPrivateRecallPollProofFor(invalid.proof, invalid.candidate)).toBe(true);
            expect(q.enqueueScopedRecall(invalid.candidate, invalid.proof, invalid.ticket)).toBe(
                'invalid',
            );
            expect(q.stats()).toEqual(before);
            expect(q.oldestDropCount()).toBe(0n);
        }
    });

    it('requires proof for the exact candidate, including same-ID and same-JSON twins', async () => {
        const first = fixture();
        const twin = fixture({
            generation: first.generation,
            binding: first.binding,
            ticket: first.ticket,
        });
        const q = scoped(scope(ownerTicket(first), first.self));
        expect(first.candidate).not.toBe(twin.candidate);
        expect(first.candidate.id).toBe(twin.candidate.id);
        expect(JSON.stringify(first.candidate)).toBe(JSON.stringify(twin.candidate));
        expect(q.enqueueScopedRecall(first.candidate, twin.proof, first.ticket)).toBe('invalid');
        expect(q.enqueueScopedRecall(twin.candidate, first.proof, twin.ticket)).toBe('invalid');
        assertQueue(q, []);
        admit(q, first);
        admit(q, twin);
        const selection = reserved(await q.reserveGuarded());
        expect(selection.eventsJson).toBe(JSON.stringify([first.candidate, twin.candidate]));
        expect(q.commitGuardedNoDrain(selection.token, selection)).toEqual({ status: 'committed' });
    });

    it('throws for missing, retired, cloned, fabricated or proxied scopes without traps or fallback', () => {
        const f = fixture();
        const active = scope(ownerTicket(f), f.self);
        const retired = scope(ownerTicket(f), f.self);
        expect(recall.retirePrivateRecallPollEpochAccountScope(retired)).toBe(true);
        const trap = vi.fn(() => {
            throw new Error('scope proxy trap must not run');
        });
        const proxy = new Proxy(active, {
            get: trap,
            getPrototypeOf: trap,
            ownKeys: trap,
            getOwnPropertyDescriptor: trap,
            has: trap,
        });
        const revoked = Proxy.revocable(active, {});
        revoked.revoke();
        const clone = Object.freeze(Object.assign(Object.create(null) as object, active));

        for (const invalid of [undefined, null, {}, clone, retired, proxy, revoked.proxy]) {
            expect(() =>
                EventPollBuffer.scoped(defaults, 'reject-new', invalid as never),
            ).toThrow();
            expect(
                () =>
                    new EventPollBuffer(defaults, 'reject-new', 'guarded-recall', invalid as never),
            ).toThrow();
        }

        const withoutScope = EventPollBuffer.scoped as unknown as (
            config: PollBufferConfig,
            policy: Policy,
        ) => BufferInstance;
        expect(() => withoutScope(defaults, 'reject-new')).toThrow();
        expect(() => new EventPollBuffer(defaults, 'reject-new', 'legacy', active)).toThrow();
        expect(trap).not.toHaveBeenCalled();
        const direct = new EventPollBuffer(defaults, 'reject-new', 'guarded-recall', active);
        buffers.push(direct);
        admit(direct, f);
    });

    it('keeps legacy and unscoped guarded behavior separate from scoped admission', async () => {
        const f = fixture();
        const legacy = new EventPollBuffer(defaults);
        const unscoped = new EventPollBuffer(defaults, 'reject-new', 'guarded-recall');
        buffers.push(legacy, unscoped);
        expect(legacy.enqueue(f.candidate)).toBe('accepted');
        expect((await legacy.reserve()).status).toBe('reserved');
        expect(unscoped.enqueueGuarded(f.candidate, f.proof)).toBe('accepted');
        expect((await unscoped.reserveGuarded()).status).toBe('reserved');
    });

    it('prunes only the invalid physical selected twin, retaining UTF-8 entries and the FIFO tail', async () => {
        const invalid = fixture();
        const twin = fixture({
            generation: invalid.generation,
            binding: invalid.binding,
            ticket: invalid.ticket,
        });
        const q = scoped(scope(ownerTicket(invalid), invalid.self));
        const first = ordinary('首', '雪😀\n', TIME + 20);
        const tail = ordinary('尾', '羽😀', TIME - 20);
        expect(q.enqueue(first)).toBe('accepted');
        admit(q, invalid);
        admit(q, twin);
        expect(q.enqueue(tail)).toBe('accepted');
        const selection = reserved(await q.reserveGuarded({ limit: 3 }));
        expect(selection.eventsJson).toBe(
            JSON.stringify([first, invalid.candidate, twin.candidate]),
        );
        // A consumer may present the selected FIFO prefix by time, but this copy
        // does not replace the queue's exact selection or establish global ordering.
        const selectedCopy = JSON.parse(selection.eventsJson) as Array<{ time: number }>;
        const timeView = [selectedCopy[1], selectedCopy[2], selectedCopy[0]];
        expect(timeView.map((item) => item.time)).toEqual([TIME, TIME, TIME + 20]);
        invalid.event.message_id = -99;
        const receipt = q.commitGuardedNoDrain(selection.token, selection);
        expect(receipt).toEqual({ status: 'pruned', count: 1 });
        assertQueue(q, [first, twin.candidate, tail]);
        expect(q.oldestDropCount()).toBe(0n);
        expect(await q.reserveGuarded()).toEqual({ status: 'contended' });
        resume(q, receipt);
        // This second transition distinguishes the surviving exact twin even
        // though the two immutable wire snapshots have identical bytes.
        invalid.event.message_id = -42;
        twin.event.message_id = -100;
        const second = reserved(await q.reserveGuarded());
        expect(second.eventsJson).toBe(JSON.stringify([first, twin.candidate, tail]));
        const secondReceipt = q.commitGuardedNoDrain(second.token, second);
        expect(secondReceipt).toEqual({ status: 'pruned', count: 1 });
        assertQueue(q, [first, tail]);
        resume(q, secondReceipt);
        const remaining = reserved(await q.reserveGuarded());
        expect(remaining.eventsJson).toBe(JSON.stringify([first, tail]));
    });

    it('keeps physical proof identity when the real poll coordinator orders mixed-time copies', async () => {
        const firstRecall = fixture();
        const twin = fixture({
            generation: firstRecall.generation,
            binding: firstRecall.binding,
            ticket: firstRecall.ticket,
        });
        const q = scoped(scope(ownerTicket(firstRecall), firstRecall.self));
        const late = ordinary('晚', '雪😀', TIME + 20);
        const early = ordinary('早', '羽', TIME - 20);
        expect(q.enqueue(late)).toBe('accepted');
        admit(q, firstRecall);
        admit(q, twin);
        expect(q.enqueue(early)).toBe('accepted');
        let current: Reserved | undefined;

        let beforeCommit = () => {};

        let lastReceipt: ReturnType<BufferInstance['commitGuardedNoDrain']> | undefined;
        // This adapter is a local test seam, not a production owner or a live gate.
        const queue: PollQueue = {
            reserve: async (options) => {
                const result = await q.reserveGuarded(options);

                if (result.status === 'reserved') {
                    current = result;
                    return result;
                }

                // This fixture expects reservations only; it makes no claim about
                // production mappings for blocked, revoked, or uncertain results.
                throw new Error(`unexpected fixture reservation: ${result.status}`);
            },
            commit: (token) => {
                if (current === undefined) {
                    throw new Error('synthetic selected prefix missing');
                }

                const selected = current;
                expect(token).toBe(selected.token);
                beforeCommit();
                const receipt = q.commitGuardedNoDrain(token, selected);
                lastReceipt = receipt;

                if (receipt.status !== 'committed' && receipt.status !== 'pruned') {
                    throw new Error(`unexpected fixture commit: ${receipt.status}`);
                }

                resume(q, receipt);
                current = undefined;
                return receipt.status === 'committed';
            },
            release: (token) => {
                const receipt = q.releaseGuardedNoDrain(token);

                if (receipt.status !== 'released') {
                    return false;
                }

                resume(q, receipt);
                current = undefined;
                return true;
            },
        };
        const owner = new PollCoordinator(
            queue,
            defaults.maxQueueBytes,
            () => 0,
            () => true,
            'legacy',
            'event-time',
        );

        const run = async () => {
            let body: string | undefined;
            const listeners = new Map<string, () => void>();
            const sink: PollSink = {
                isOpen: () => true,
                on: (name, listener) => {
                    listeners.set(name, listener);
                },
                off: (name, listener) => {
                    if (listeners.get(name) === listener) {
                        listeners.delete(name);
                    }
                },
                writeHead: () => {},
                end: (value) => {
                    body = value;
                    listeners.get('finish')?.();
                },
            };
            const outcome = await owner
                .create(
                    {
                        limit: 3,
                        timeoutMs: 0,
                        maxOutputBytes: defaults.maxQueueBytes,
                        responseDeadline: 10_000,
                    },
                    sink,
                )
                .run();
            expect(listeners.size).toBe(0);
            return { outcome, body };
        };

        // PollCoordinator reaches commit only after preparing its sorted copy.
        beforeCommit = () => {
            firstRecall.event.message_id = -99;
        };

        const rejected = await run();
        expect(rejected.outcome).toEqual({ kind: 'commit_rejected' });
        expect(rejected.body).toBeUndefined();
        expect(lastReceipt).toEqual({ status: 'pruned', count: 1 });
        assertQueue(q, [late, twin.candidate, early]);
        firstRecall.event.message_id = -42;

        beforeCommit = () => {
            twin.event.message_id = -100;
        };

        const rejectedTwin = await run();
        expect(rejectedTwin.outcome).toEqual({ kind: 'commit_rejected' });
        expect(lastReceipt).toEqual({ status: 'pruned', count: 1 });
        assertQueue(q, [late, early]);

        beforeCommit = () => {};

        const committed = await run();
        expect(committed.outcome).toEqual({ kind: 'local_finish', response: 'events' });
        expect(JSON.parse(required(committed.body, 'in-memory response')).data).toEqual([
            early,
            late,
        ]);
        assertQueue(q, []);
        const validRecall = fixture({
            generation: firstRecall.generation,
            binding: firstRecall.binding,
            messageId: -3,
        });
        expect(q.enqueue(late)).toBe('accepted');
        admit(q, validRecall);
        expect(q.enqueue(early)).toBe('accepted');
        const mixed = await run();
        expect(mixed.outcome).toEqual({ kind: 'local_finish', response: 'events' });
        expect(JSON.parse(required(mixed.body, 'mixed in-memory response')).data).toEqual([
            early,
            validRecall.candidate,
            late,
        ]);
        assertQueue(q, []);
        expect(q.oldestDropCount()).toBe(0n);
    });

    it('revocation before selection blocks both event classes without pruning and close clears them', async () => {
        const f = fixture();
        const ownerScope = scope(ownerTicket(f), f.self);
        const q = scoped(ownerScope);
        const first = ordinary('ordinary', '雪');
        expect(q.enqueue(first)).toBe('accepted');
        admit(q, f);
        const before = q.stats();
        expect(recall.retirePrivateRecallPollEpochAccountScope(ownerScope)).toBe(true);
        expect(q.enqueue(ordinary('later'))).toBe('scope_revoked');
        expect(q.enqueueScopedRecall(f.candidate, f.proof, f.ticket)).toBe('scope_revoked');
        expect(await q.reserveGuarded()).toEqual({ status: 'scope_revoked' });
        expect(q.stats()).toEqual(before);
        expect(q.oldestDropCount()).toBe(0n);
        expect(q.close()).toBe(true);
        expect(q.stats()).toMatchObject({ count: 0, queueBytes: 2, reserved: 0, closed: true });
        expect(await q.reserveGuarded()).toEqual({ status: 'closed' });
    });

    it.each(['ordinary', 'recall'] as const)(
        'revocation with an active %s reservation prevents commit but permits release without drain',
        async (kind) => {
            const f = fixture();
            const ownerScope = scope(ownerTicket(f), f.self);
            const q = scoped(ownerScope);
            const head = ordinary('head');
            const expected = kind === 'ordinary' ? [head] : [f.candidate];

            if (kind === 'ordinary') {
                expect(q.enqueue(head)).toBe('accepted');
            } else {
                admit(q, f);
            }

            const selected = reserved(await q.reserveGuarded());
            const waiting = q.reserveGuarded({ timeoutMs: 100 });
            const delivered = vi.fn();
            void waiting.then(delivered);
            const before = q.stats();
            expect(recall.retirePrivateRecallPollEpochAccountScope(ownerScope)).toBe(true);
            expect(q.commitGuardedNoDrain(selected.token, selected)).toEqual({
                status: 'scope_revoked',
            });
            expect(q.stats()).toEqual(before);
            const release = q.releaseGuardedNoDrain(selected.token);
            expect(release).toEqual({ status: 'released' });
            expect(Object.isFrozen(release)).toBe(true);
            assertQueue(q, expected);
            expect(q.resumeGuardedDrain(release)).toEqual({ status: 'scope_revoked' });
            expect(await q.reserveGuarded()).toEqual({ status: 'scope_revoked' });
            await Promise.resolve();
            expect(delivered).not.toHaveBeenCalled();
            expect(q.stats()).toMatchObject({ count: 1, waiters: 1, reserved: 0 });
            expect(q.oldestDropCount()).toBe(0n);
            expect(q.close()).toBe(true);
            expect(await waiting).toEqual({ status: 'closed' });
        },
    );

    it('does not undo a committed receipt or requeue committed data when its scope retires', async () => {
        const f = fixture();
        const ownerScope = scope(ownerTicket(f), f.self);
        const q = scoped(ownerScope);
        const head = ordinary('committed');
        const tail = ordinary('tail');
        expect(q.enqueue(head)).toBe('accepted');
        expect(q.enqueue(tail)).toBe('accepted');
        const selected = reserved(await q.reserveGuarded({ limit: 1 }));
        const waiting = q.reserveGuarded({ timeoutMs: 100 });
        const receipt = q.commitGuardedNoDrain(selected.token, selected);
        expect(receipt).toEqual({ status: 'committed' });
        expect(Object.isFrozen(receipt)).toBe(true);
        assertQueue(q, [tail]);
        expect(recall.retirePrivateRecallPollEpochAccountScope(ownerScope)).toBe(true);
        expect(q.resumeGuardedDrain(receipt)).toEqual({ status: 'scope_revoked' });
        expect(receipt).toEqual({ status: 'committed' });
        assertQueue(q, [tail]);
        expect(q.stats().waiters).toBe(1);
        expect(q.oldestDropCount()).toBe(0n);
        expect(q.close()).toBe(true);
        expect(await waiting).toEqual({ status: 'closed' });
    });

    it('does not wake existing waiters merely on retirement; abort, deadline and close still settle them', async () => {
        const f = fixture();
        const scopes = [
            scope(ownerTicket(f), f.self),
            scope(ownerTicket(f), f.self),
            scope(ownerTicket(f), f.self),
        ];
        const queues = scopes.map((ownerScope) => scoped(ownerScope));
        const controller = new AbortController();
        const aborted = queues[0].reserveGuarded({ timeoutMs: 100, signal: controller.signal });
        const timed = queues[1].reserveGuarded({ timeoutMs: 10 });
        const closed = queues[2].reserveGuarded({ timeoutMs: 100 });
        const delivered = [vi.fn(), vi.fn(), vi.fn()];
        void aborted.then(delivered[0]);
        void timed.then(delivered[1]);
        void closed.then(delivered[2]);

        for (const ownerScope of scopes) {
            expect(recall.retirePrivateRecallPollEpochAccountScope(ownerScope)).toBe(true);
        }

        await Promise.resolve();
        delivered.forEach((callback) => expect(callback).not.toHaveBeenCalled());
        queues.forEach((q) => expect(q.stats().waiters).toBe(1));
        controller.abort();
        expect(await aborted).toEqual({ status: 'aborted' });
        await vi.advanceTimersByTimeAsync(10);
        expect(await timed).toEqual({ status: 'timeout' });
        expect(queues[2].close()).toBe(true);
        expect(await closed).toEqual({ status: 'closed' });
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['valid', 'invalid'] as const)(
        'settles a %s guarded blocked head with its physical tail intact',
        async (state) => {
            const f = fixture();
            const tail = ordinary('尾', '雪😀');
            const q = scoped(scope(ownerTicket(f), f.self));
            admit(q, f);
            expect(q.enqueue(tail)).toBe('accepted');
            const needed = wireBytes([f.candidate]);
            const selected = blocked(await q.reserveGuarded({ maxBatchBytes: needed - 1 }));
            expect(selected.requiredBytes).toBe(needed);
            const getter = vi.fn(() => {
                throw new Error('v11 accessor must not run');
            });

            if (state === 'invalid') {
                Object.defineProperty(f.event, 'message_id', { configurable: true, get: getter });
            }

            const receipt = q.settleBlockedGuardedNoDrain(selected.token, selected);
            expect(receipt).toEqual(
                state === 'valid'
                    ? { status: 'blocked', requiredBytes: needed }
                    : { status: 'pruned', count: 1 },
            );
            expect(getter).not.toHaveBeenCalled();
            assertQueue(q, state === 'valid' ? [f.candidate, tail] : [tail]);
            expect(q.oldestDropCount()).toBe(0n);
            resume(q, receipt);
        },
    );

    it.each(['valid', 'invalid', 'retired'] as const)(
        'late abort releases a %s blocked head without pruning',
        async (state) => {
            const f = fixture();
            const ownerScope = scope(ownerTicket(f), f.self);
            const q = scoped(ownerScope);
            const tail = ordinary('tail', '雪');
            admit(q, f);
            expect(q.enqueue(tail)).toBe('accepted');
            const controller = new AbortController();
            const selected = blocked(
                await q.reserveGuarded({
                    timeoutMs: 10,
                    signal: controller.signal,
                    maxBatchBytes: wireBytes([f.candidate]) - 1,
                }),
            );

            if (state !== 'valid') {
                f.event.message_id = -99;
            }

            if (state === 'retired') {
                expect(recall.retirePrivateRecallPollEpochAccountScope(ownerScope)).toBe(true);
                expect(q.settleBlockedGuardedNoDrain(selected.token, selected)).toEqual({
                    status: 'scope_revoked',
                });
            }

            await vi.advanceTimersByTimeAsync(20);
            controller.abort();
            const release = q.releaseGuardedNoDrain(selected.token);
            expect(release).toEqual({ status: 'released' });
            assertQueue(q, [f.candidate, tail]);
            expect(q.oldestDropCount()).toBe(0n);
            expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);

            if (state === 'retired') {
                expect(q.resumeGuardedDrain(release)).toEqual({ status: 'scope_revoked' });
                assertQueue(q, [f.candidate, tail]);
            } else {
                resume(q, release);
                const retry = blocked(
                    await q.reserveGuarded({ maxBatchBytes: wireBytes([f.candidate]) - 1 }),
                );
                const receipt = q.settleBlockedGuardedNoDrain(retry.token, retry);
                expect(receipt).toEqual(
                    state === 'valid'
                        ? { status: 'blocked', requiredBytes: wireBytes([f.candidate]) }
                        : { status: 'pruned', count: 1 },
                );
                assertQueue(q, state === 'valid' ? [f.candidate, tail] : [tail]);
                resume(q, receipt);
            }
        },
    );

    it('rechecks scope after a clock callback retires it before a short-poll selection', async () => {
        const f = fixture();
        const ownerScope = scope(ownerTicket(f), f.self);
        const q = scoped(ownerScope);
        admit(q, f);
        const before = q.stats();
        const clock = vi.spyOn(performance, 'now').mockImplementationOnce(() => {
            expect(recall.retirePrivateRecallPollEpochAccountScope(ownerScope)).toBe(true);
            return 0;
        });
        expect(await q.reserveGuarded()).toEqual({ status: 'scope_revoked' });
        clock.mockRestore();
        expect(q.stats()).toEqual(before);
        expect(q.oldestDropCount()).toBe(0n);
    });

    it.each(['timeout', 'abort', 'close'] as const)(
        'retires on the second clock read after waiter registration and cleans up by %s',
        async (finish) => {
            const f = fixture();
            const ownerScope = scope(ownerTicket(f), f.self);
            const q = scoped(ownerScope, { capacity: 1 }, 'drop-oldest');
            admit(q, f);
            const before = q.stats();
            const controller = new AbortController();
            const clock = vi
                .spyOn(performance, 'now')
                .mockImplementationOnce(() => 0)
                .mockImplementationOnce(() => {
                    expect(q.stats().waiters).toBe(1);
                    expect(recall.retirePrivateRecallPollEpochAccountScope(ownerScope)).toBe(true);
                    return 0;
                });
            let waiting: Promise<GuardedResult>;

            try {
                waiting = q.reserveGuarded({ timeoutMs: 10, signal: controller.signal });
            } finally {
                clock.mockRestore();
            }

            const delivered = vi.fn();
            void waiting.then(delivered);
            await Promise.resolve();
            expect(delivered).not.toHaveBeenCalled();
            expect(q.stats()).toMatchObject({
                count: before.count,
                queueBytes: before.queueBytes,
                reserved: 0,
                waiters: 1,
            });
            expect(q.oldestDropCount()).toBe(0n);
            expect(q.enqueue(ordinary('no eviction'))).toBe('scope_revoked');
            expect(q.oldestDropCount()).toBe(0n);

            if (finish === 'timeout') {
                await vi.advanceTimersByTimeAsync(10);
            } else if (finish === 'abort') {
                controller.abort();
            } else {
                expect(q.close()).toBe(true);
            }

            expect(await waiting).toEqual({
                status:
                    finish === 'timeout' ? 'timeout' : finish === 'abort' ? 'aborted' : 'closed',
            });
            expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it('rechecks scope inside resume after a clock callback, retaining the barrier and withholding new tokens', async () => {
        const f = fixture();
        const ownerScope = scope(ownerTicket(f), f.self);
        const q = scoped(ownerScope);
        const held = ordinary('held');
        expect(q.enqueue(held)).toBe('accepted');
        const selected = reserved(await q.reserveGuarded());
        const waiting = q.reserveGuarded({ timeoutMs: 100 });
        const delivered = vi.fn();
        void waiting.then(delivered);
        admit(q, f);
        const receipt = q.commitGuardedNoDrain(selected.token, selected);
        expect(receipt).toEqual({ status: 'committed' });
        const clock = vi.spyOn(performance, 'now').mockImplementationOnce(() => {
            expect(recall.retirePrivateRecallPollEpochAccountScope(ownerScope)).toBe(true);
            return 0;
        });
        expect(q.resumeGuardedDrain(receipt)).toEqual({ status: 'scope_revoked' });
        clock.mockRestore();
        await Promise.resolve();
        expect(delivered).not.toHaveBeenCalled();
        assertQueue(q, [f.candidate]);
        expect(q.stats()).toMatchObject({ waiters: 1, reserved: 0 });
        expect(q.resumeGuardedDrain(receipt)).toEqual({ status: 'scope_revoked' });
        expect(q.close()).toBe(true);
        expect(await waiting).toEqual({ status: 'closed' });
    });

    it('preserves a decided ordinary blocked result if waiter cleanup retires the scope', async () => {
        const f = fixture();
        const ownerScope = scope(ownerTicket(f), f.self);
        const q = scoped(ownerScope);
        expect(q.enqueue(ordinary('held'))).toBe('accepted');
        const held = reserved(await q.reserveGuarded());
        const head = ordinary('blocked', '雪😀'.repeat(8));
        const needed = wireBytes([head]);
        const firstController = new AbortController();
        const secondController = new AbortController();
        const first = q.reserveGuarded({
            timeoutMs: 100,
            maxBatchBytes: needed - 1,
            signal: firstController.signal,
        });
        const second = q.reserveGuarded({ timeoutMs: 100, signal: secondController.signal });
        const secondDelivered = vi.fn();
        void second.then(secondDelivered);
        expect(q.enqueue(head)).toBe('accepted');
        const receipt = q.commitGuardedNoDrain(held.token, held);
        expect(receipt).toEqual({ status: 'committed' });
        const clear = globalThis.clearTimeout;
        const cleanup = vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce((timer) => {
            clear(timer);
            expect(recall.retirePrivateRecallPollEpochAccountScope(ownerScope)).toBe(true);
        });
        let result: ReturnType<BufferInstance['resumeGuardedDrain']>;

        try {
            result = q.resumeGuardedDrain(receipt);
        } finally {
            cleanup.mockRestore();
        }

        expect(result).toEqual({ status: 'scope_revoked' });
        const decided = await first;
        expect(decided).toEqual({ status: 'blocked', requiredBytes: needed });
        expect(Object.hasOwn(decided, 'token')).toBe(false);
        expect(getEventListeners(firstController.signal, 'abort')).toHaveLength(0);
        // The blocked result is a past local decision; the owner still checks
        // scope and all external lifecycle conditions before using that result.
        expect(recall.isPrivateRecallPollEpochAccountScopeActive(ownerScope)).toBe(false);
        await Promise.resolve();
        expect(secondDelivered).not.toHaveBeenCalled();
        assertQueue(q, [head]);
        expect(q.stats().waiters).toBe(1);
        expect(q.oldestDropCount()).toBe(0n);
        expect(q.resumeGuardedDrain(receipt)).toEqual({ status: 'scope_revoked' });
        expect(q.close()).toBe(true);
        expect(await second).toEqual({ status: 'closed' });
        expect(getEventListeners(secondController.signal, 'abort')).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reports uncertain when reentrant close fails cleanup during resume, retaining the committed receipt', async () => {
        const f = fixture();
        const q = scoped(scope(ownerTicket(f), f.self));
        expect(q.enqueue(ordinary('held'))).toBe('accepted');
        const selected = reserved(await q.reserveGuarded());
        const controller = new AbortController();
        const waiting = q.reserveGuarded({ timeoutMs: 100, signal: controller.signal });
        admit(q, f);
        const receipt = q.commitGuardedNoDrain(selected.token, selected);
        expect(receipt).toEqual({ status: 'committed' });
        expect(Object.isFrozen(receipt)).toBe(true);
        expect(q.stats()).toMatchObject({ count: 1, waiters: 1, reserved: 0 });
        const clear = globalThis.clearTimeout;
        const closeErrors: unknown[] = [];
        // Deliberate built-in fault injection: this is not a claim about real Node cleanup.
        // Clear the physical fake timer first, then make the cleanup outcome uncertain.
        const cleanup = vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce((timer) => {
            clear(timer);
            throw new Error('synthetic clearTimeout failure after clearing');
        });
        const clock = vi.spyOn(performance, 'now').mockImplementationOnce(() => {
            try {
                q.close();
            } catch (error) {
                closeErrors.push(error);
            }

            return 0;
        });
        let result: ReturnType<BufferInstance['resumeGuardedDrain']>;
        let cleanupCalls = 0;

        try {
            result = q.resumeGuardedDrain(receipt);
            cleanupCalls = cleanup.mock.calls.length;
        } finally {
            clock.mockRestore();
            cleanup.mockRestore();
        }

        expect(closeErrors).toHaveLength(1);
        expect(cleanupCalls).toBe(1);
        expect(result).toEqual({ status: 'uncertain' });
        expect(q.guardedCleanupState()).toBe('uncertain');
        expect(receipt).toEqual({ status: 'committed' });
        expect(await waiting).toEqual({ status: 'closed' });
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        expect(q.stats()).toMatchObject({ count: 0, queueBytes: 2, waiters: 0, closed: true });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('preserves an already selected token when timer cleanup retires the scope', async () => {
        const f = fixture();
        const ownerScope = scope(ownerTicket(f), f.self);
        const q = scoped(ownerScope);
        expect(q.enqueue(ordinary('held'))).toBe('accepted');
        const held = reserved(await q.reserveGuarded());
        const waiting = q.reserveGuarded({ timeoutMs: 100 });
        admit(q, f);
        const receipt = q.commitGuardedNoDrain(held.token, held);
        expect(receipt).toEqual({ status: 'committed' });
        const clear = globalThis.clearTimeout;
        const cleanup = vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce((timer) => {
            expect(recall.retirePrivateRecallPollEpochAccountScope(ownerScope)).toBe(true);
            clear(timer);
        });
        expect(q.resumeGuardedDrain(receipt)).toEqual({ status: 'scope_revoked' });
        cleanup.mockRestore();
        const selected = reserved(await waiting);
        expect(selected.eventsJson).toBe(JSON.stringify([f.candidate]));
        expect(q.commitGuardedNoDrain(selected.token, selected)).toEqual({
            status: 'scope_revoked',
        });
        const release = q.releaseGuardedNoDrain(selected.token);
        expect(release).toEqual({ status: 'released' });
        expect(q.resumeGuardedDrain(release)).toEqual({ status: 'scope_revoked' });
        assertQueue(q, [f.candidate]);
    });

    it('binds exact scopes while closing one queue leaves shared and equal-valued scopes active', async () => {
        const f = fixture();
        const owner = ownerTicket(f);
        const firstScope = scope(owner, f.self);
        const sameValueScope = scope(owner, { ...f.self });
        expect(firstScope).not.toBe(sameValueScope);
        const old = scoped(firstScope);
        const shared = scoped(firstScope);
        const independent = scoped(sameValueScope);
        admit(old, f);
        admit(shared, f);
        admit(independent, f);
        const oldSelected = reserved(await old.reserveGuarded());
        const sharedSelected = reserved(await shared.reserveGuarded());
        const independentSelected = reserved(await independent.reserveGuarded());
        expect(shared.commitGuardedNoDrain(oldSelected.token, oldSelected)).toEqual({
            status: 'stale',
        });
        expect(independent.commitGuardedNoDrain(sharedSelected.token, sharedSelected)).toEqual({
            status: 'stale',
        });
        expect(old.close()).toBe(true);
        expect(recall.isPrivateRecallPollEpochAccountScopeActive(firstScope)).toBe(true);
        const receipt = shared.commitGuardedNoDrain(sharedSelected.token, sharedSelected);
        expect(receipt).toEqual({ status: 'committed' });
        resume(shared, receipt);
        expect(recall.retirePrivateRecallPollEpochAccountScope(firstScope)).toBe(true);
        expect(await shared.reserveGuarded()).toEqual({ status: 'scope_revoked' });
        expect(recall.isPrivateRecallPollEpochAccountScopeActive(sameValueScope)).toBe(true);
        const independentReceipt = independent.commitGuardedNoDrain(
            independentSelected.token,
            independentSelected,
        );
        expect(independentReceipt).toEqual({ status: 'committed' });
        resume(independent, independentReceipt);
        expect(await independent.reserveGuarded()).toEqual({ status: 'empty' });
    });

    it('keeps proof, ticket and scope off selections and receipts and rejects proxy forgeries without traps', async () => {
        const f = fixture();
        const ownerScope = scope(ownerTicket(f), f.self);
        const q = scoped(ownerScope);
        const trap = vi.fn(() => {
            throw new Error('proxy trap must not run');
        });
        const proxy = (target: object) =>
            new Proxy(target, {
                get: trap,
                ownKeys: trap,
                getPrototypeOf: trap,
                getOwnPropertyDescriptor: trap,
                has: trap,
            });
        const getter = vi.fn(() => {
            throw new Error('getter must not run');
        });
        const forged = Object.defineProperty({}, 'status', { enumerable: true, get: getter });
        const before = q.stats();
        expect(q.enqueueScopedRecall(proxy(f.candidate), f.proof, f.ticket)).toBe('invalid');
        expect(q.enqueueScopedRecall(f.candidate, proxy(f.proof), f.ticket)).toBe('invalid');
        expect(q.enqueueScopedRecall(f.candidate, f.proof, proxy(f.ticket))).toBe('invalid');
        expect(q.enqueue(forged)).toBe('invalid');
        expect(q.stats()).toEqual(before);
        admit(q, f);
        const selected = reserved(await q.reserveGuarded());
        expect(Reflect.ownKeys(selected).sort()).toEqual([
            'bytes',
            'count',
            'eventsJson',
            'status',
            'token',
        ]);
        expect(Reflect.ownKeys(selected.token)).toEqual([]);
        expect(JSON.parse(selected.eventsJson)).toEqual([f.candidate]);
        expect(q.commitGuardedNoDrain(proxy(selected.token), selected)).toEqual({
            status: 'stale',
        });
        expect(q.commitGuardedNoDrain(selected.token, proxy(selected))).toEqual({
            status: 'stale',
        });
        const receipt = q.commitGuardedNoDrain(selected.token, selected);
        expect(receipt).toEqual({ status: 'committed' });
        expect(Reflect.ownKeys(receipt)).toEqual(['status']);
        expect(q.resumeGuardedDrain(proxy(receipt))).toEqual({ status: 'stale' });
        expect(q.resumeGuardedDrain(forged)).toEqual({ status: 'stale' });
        expect(q.resumeGuardedDrain({ ...receipt })).toEqual({ status: 'stale' });
        expect(trap).not.toHaveBeenCalled();
        expect(getter).not.toHaveBeenCalled();
        resume(q, receipt);
    });

    it('retains guarded barrier and protected prefix semantics under drop-oldest and byte accounting', async () => {
        const f = fixture();
        const sibling = fixture({ generation: f.generation, binding: f.binding, messageId: -2 });
        const q = scoped(scope(ownerTicket(f), f.self), { capacity: 4 }, 'drop-oldest');
        const head = ordinary('head');
        const evicted = ordinary('evicted');
        const incoming = ordinary('incoming', '雪😀\n');
        expect(q.enqueue(head)).toBe('accepted');
        admit(q, f);
        expect(q.enqueue(evicted)).toBe('accepted');
        admit(q, sibling);
        const held = reserved(await q.reserveGuarded({ limit: 2 }));
        expect(q.enqueue(incoming)).toBe('accepted');
        expect(q.oldestDropCount()).toBe(1n);
        assertQueue(q, [head, f.candidate, sibling.candidate, incoming], 2);
        const release = q.releaseGuardedNoDrain(held.token);
        expect(release).toEqual({ status: 'released' });
        expect(await q.reserveGuarded()).toEqual({ status: 'contended' });
        resume(q, release);
        const selected = reserved(await q.reserveGuarded());
        expect(selected.eventsJson).toBe(
            JSON.stringify([head, f.candidate, sibling.candidate, incoming]),
        );
        const before = q.stats();
        expect(q.enqueue(ordinary('full'))).toBe('full');
        expect(q.stats()).toEqual(before);
        expect(q.oldestDropCount()).toBe(1n);
        const receipt = q.commitGuardedNoDrain(selected.token, selected);
        expect(receipt).toEqual({ status: 'committed' });
        assertQueue(q, []);
        resume(q, receipt);
    });

    it('evicts by exact UTF-8 byte budget without touching a protected prefix or an unfit tail', async () => {
        const f = fixture();
        const head = ordinary('held', '雪');
        const evicted = ordinary('evicted', '😀'.repeat(10));
        const incoming = ordinary('incoming', '雪'.repeat(10));
        const tooLargeBesideHead = ordinary('larger', '💖'.repeat(20));
        const budget = wireBytes([head, evicted]);
        expect(wireBytes([head, incoming])).toBeLessThanOrEqual(budget);
        expect(wireBytes([head, evicted, incoming])).toBeGreaterThan(budget);
        expect(wireBytes([tooLargeBesideHead])).toBeLessThanOrEqual(budget);
        expect(wireBytes([head, tooLargeBesideHead])).toBeGreaterThan(budget);
        const q = scoped(
            scope(ownerTicket(f), f.self),
            {
                capacity: 8,
                maxQueueBytes: budget,
                maxEventBytes: budget,
            },
            'drop-oldest',
        );
        expect(q.enqueue(head)).toBe('accepted');
        expect(q.enqueue(evicted)).toBe('accepted');
        const selected = reserved(await q.reserveGuarded({ limit: 1 }));
        expect(q.enqueue(incoming)).toBe('accepted');
        expect(q.oldestDropCount()).toBe(1n);
        assertQueue(q, [head, incoming], 1);
        const before = q.stats();
        expect(q.enqueue(tooLargeBesideHead)).toBe('full');
        expect(q.stats()).toEqual(before);
        expect(q.oldestDropCount()).toBe(1n);
        const release = q.releaseGuardedNoDrain(selected.token);
        expect(release).toEqual({ status: 'released' });
        resume(q, release);
        const next = reserved(await q.reserveGuarded());
        expect(next.eventsJson).toBe(JSON.stringify([head, incoming]));
    });

    it('compares retained local tickets offline and relies on trusted account/ticket capture', async () => {
        const a = fixture();
        const owner = ownerTicket(a);
        const aScope = scope(owner, a.self);
        const b = fixture({
            generation: a.generation,
            binding: a.binding,
            ticket: a.ticket,
            selfUin: SELF + 1,
        });
        const bScope = scope(owner, b.self);
        const qa = scoped(aScope);
        const qb = scoped(bScope);
        a.generation.setOnline(false);
        expect(a.generation.isCurrent(a.ticket, a.binding)).toBe(false);
        expect(ticketApi.sameSourceEpoch(a.ticket, owner)).toBe('same');
        expect(qa.enqueueScopedRecall(b.candidate, b.proof, b.ticket)).toBe('invalid');
        admit(qa, a);
        // The genuine A ticket paired with synthetic B is accepted only as a
        // locally consistent association, not as proof of B, online or manager state.
        admit(qb, b);
        const selectedA = reserved(await qa.reserveGuarded());
        const selectedB = reserved(await qb.reserveGuarded());
        expect(qa.commitGuardedNoDrain(selectedA.token, selectedA)).toEqual({
            status: 'committed',
        });
        expect(qb.commitGuardedNoDrain(selectedB.token, selectedB)).toEqual({
            status: 'committed',
        });
    });
});
