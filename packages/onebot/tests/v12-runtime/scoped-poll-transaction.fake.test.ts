import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
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
    GuardedPollResult,
    GuardedSelection,
} from '../../src/v12-runtime/event-poll-buffer';
import type { PrivateRecallPollEpochAccountScope } from '../../src/v12-runtime/private-recall-source';
import type {
    PollCoordinator as CoordinatorInstance,
    PollOutcome,
    PollRequest,
    PollSink,
    PollTransaction,
    ScopedPollStatus,
} from '../../src/v12-runtime/poll-transaction';

// Only real in-memory primitives are loaded, after the effect guards are armed.
// No production runtime, account, plugin, native library or socket is started.
vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();
    return { ...actual, randomUUID: () => '11111111-1111-4111-8111-111111111111' };
});
vi.mock('@snowluma/sqlite', () => {
    throw new Error('SQLite is outside this in-memory fixture');
});
vi.mock('@snowluma/websocket', () => {
    throw new Error('WebSocket is outside this in-memory fixture');
});

let EventPollBuffer: typeof import('../../src/v12-runtime/event-poll-buffer').EventPollBuffer;
let PollCoordinator: typeof import('../../src/v12-runtime/poll-transaction').PollCoordinator;
let tickets: typeof import('../../src/v12-runtime/source-ticket');
let recall: typeof import('../../src/v12-runtime/private-recall-source');
let effects: Array<{ mock: { calls: unknown[] } }> = [];
const queues: BufferInstance[] = [];
const scopes: PrivateRecallPollEpochAccountScope[] = [];
const coordinators: CoordinatorInstance[] = [];

function forbidden(): never {
    throw new Error('unexpected network, native or child-process operation in poll fixture');
}

beforeEach(async () => {
    vi.useFakeTimers();
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
    effects = [
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
        vi.spyOn(dns, 'lookup').mockImplementation(forbidden),
        vi.spyOn(dns, 'resolve').mockImplementation(forbidden),
        vi.spyOn(process, 'dlopen').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawn').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawnSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'exec').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFile').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFileSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'fork').mockImplementation(forbidden),
    ];
    // Also block named Node imports before loading the subjects.
    syncBuiltinESMExports();
    tickets = await import('../../src/v12-runtime/source-ticket');
    recall = await import('../../src/v12-runtime/private-recall-source');
    ({ EventPollBuffer } = await import('../../src/v12-runtime/event-poll-buffer'));
    ({ PollCoordinator } = await import('../../src/v12-runtime/poll-transaction'));
});

async function flush(): Promise<void> {
    for (let i = 0; i < 24; i++) {
        await Promise.resolve();
    }
}

afterEach(async () => {
    let cleanupFailed = false;

    for (const coordinator of coordinators.splice(0)) {
        try {
            coordinator.close();
        } catch {
            cleanupFailed = true;
        }
    }

    for (const queue of queues.splice(0)) {
        try {
            queue.close();
        } catch {
            cleanupFailed = true;
        }
    }

    for (const scope of scopes.splice(0)) {
        recall.retirePrivateRecallPollEpochAccountScope(scope);
    }

    await flush();
    const calls = effects.map((effect) => effect.mock.calls.length);
    const timers = vi.getTimerCount();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    effects = [];
    expect(cleanupFailed).toBe(false);
    expect(calls).toEqual(calls.map(() => 0));
    expect(timers).toBe(0);
});

const config = {
    capacity: 12,
    maxQueueBytes: 8192,
    maxEventBytes: 4096,
    maxWaiters: 8,
    maxTimeoutMs: 1000,
};
const SELF = 10001;
const PEER = 20002;
type RawRecall = Extract<QQEventVariant, { kind: 'friend_recall' }>;

function required<T>(value: T | null | undefined, label: string): T {
    if (value === null || value === undefined) {
        throw new Error(`synthetic ${label} missing`);
    }

    return value;
}

function setup() {
    const generation = new tickets.SourceGeneration();
    generation.setOnline(true);
    const binding = {};
    const ownerTicket = required(generation.capture(binding), 'owner ticket');
    const self = Object.freeze({ platform: 'qq', user_id: String(SELF) });
    const context = { uin: String(SELF), selfId: SELF };
    const scope = required(
        recall.createPrivateRecallPollEpochAccountScope(ownerTicket, self),
        'scope',
    );
    const queue = EventPollBuffer.scoped(config, 'drop-oldest', scope);
    scopes.push(scope);
    queues.push(queue);
    return { generation, binding, ownerTicket, self, context, scope, queue };
}

type Fixture = ReturnType<typeof setup>;

/** Build real local proof evidence, with no account or protocol service. */
function makeRecall(fixture: Fixture, messageId = -42, time = 20) {
    const eventTicket = required(fixture.generation.capture(fixture.binding), 'event ticket');
    const raw: RawRecall = {
        kind: 'friend_recall',
        selfUin: SELF,
        userUin: PEER,
        msgSeq: 445,
        clientSeq: 446,
        time,
        recalledBySelf: false,
    };
    const event: JsonObject = {
        time,
        self_id: SELF,
        post_type: 'notice',
        notice_type: 'friend_recall',
        user_id: PEER,
        message_id: messageId,
    };
    const snapshot = required(
        recall.capturePrivateRecallSource(fixture.context, raw, eventTicket),
        'snapshot',
    );

    if (!recall.rememberPrivateRecallSource(fixture.context, event, snapshot, messageId)) {
        throw new Error('synthetic provenance not remembered');
    }

    const source = required(recall.getPrivateRecallSource(fixture.context, event), 'provenance');
    const candidate = required(
        recall.convertPrivateRecallEvent(event, fixture.self, source),
        'candidate',
    );
    const proof = required(
        recall.createPrivateRecallPollProof(event, source, eventTicket, fixture.self, candidate),
        'proof',
    );
    return { eventTicket, raw, event, source, candidate, proof };
}

function admit(fixture: Fixture, value: ReturnType<typeof makeRecall>): void {
    expect(fixture.queue.enqueueScopedRecall(value.candidate, value.proof, value.eventTicket)).toBe(
        'accepted',
    );
}

function ordinary(id: string, time: number, text = '') {
    return { type: 'message', id, time, text };
}

function makeCoordinator(
    fixture: Fixture,
    now: () => number = () => 0,
    isEpochValid: () => boolean = () => true,
    batchOrder: 'fifo' | 'event-time' = 'event-time',
    onScopedStatus?: (status: ScopedPollStatus) => void,
): CoordinatorInstance {
    const args = [
        fixture.queue,
        config.maxQueueBytes,
        now,
        isEpochValid,
        'legacy',
        batchOrder,
    ] as const;
    const coordinator =
        onScopedStatus === undefined
            ? PollCoordinator.scoped(...args)
            : PollCoordinator.scoped(...args, onScopedStatus);
    coordinators.push(coordinator);
    return coordinator;
}

function coreOutcome(outcome: PollOutcome) {
    return outcome.kind === 'cleanup_uncertain' ? outcome.outcome : outcome;
}

class MemorySink extends EventEmitter implements PollSink {
    headCalls = 0;
    endCalls = 0;
    body: string | undefined;

    constructor(
        private readonly onOpen: () => void = () => {},
        private readonly fail: 'none' | 'head' | 'end' = 'none',
        private readonly autoFinish = true,
    ) {
        super();
    }

    isOpen(): boolean {
        this.onOpen();
        return true;
    }

    writeHead(): void {
        this.headCalls++;

        if (this.fail === 'head') {
            throw new Error('synthetic header failure');
        }
    }

    end(body: string): void {
        this.endCalls++;

        if (this.fail === 'end') {
            throw new Error('synthetic body failure');
        }

        this.body = body;

        if (this.autoFinish) {
            this.emit('finish');
        }
    }
}

function request(patch: Partial<PollRequest> = {}): PollRequest {
    return {
        limit: 0,
        timeoutMs: 0,
        maxOutputBytes: config.maxQueueBytes,
        responseDeadline: 1000,
        echo: 'echo-😺-"fixture"',
        ...patch,
    };
}

function headBudget(value: unknown, echo: string): number {
    const overhead =
        Buffer.byteLength(
            JSON.stringify({ status: 'ok', retcode: 0, data: [], message: '', echo }),
            'utf8',
        ) - 2;
    const eventBytes = Buffer.byteLength(JSON.stringify([value]), 'utf8');
    return overhead + eventBytes - 1;
}

function isSelection(result: GuardedPollResult): result is GuardedSelection {
    return result.status === 'reserved' || result.status === 'blocked_guarded';
}

/** Delay the original fulfilled selection without copying its token or identity. */
function holdFirstSelection(queue: BufferInstance) {
    const original = queue.reserveGuarded.bind(queue);
    let first = true;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
        resume = resolve;
    });
    const state: { selection?: GuardedSelection } = {};
    const reserve = vi.spyOn(queue, 'reserveGuarded').mockImplementation((options) => {
        const result = original(options);

        if (!first) {
            return result;
        }

        first = false;
        return result.then(async (selected) => {
            if (isSelection(selected)) {
                state.selection = selected;
                await gate;
            }

            return selected;
        });
    });
    return { state, reserve, resume };
}

function selected(value: GuardedSelection | undefined): GuardedSelection {
    const selection = required(value, 'guarded selection');
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.token)).toBe(true);
    return selection;
}

function expectNoWrites(sink: MemorySink): void {
    expect(sink.headCalls).toBe(0);
    expect(sink.endCalls).toBe(0);
    expect(sink.body).toBeUndefined();
}

/** Observe the actual writer entry; the spy delegates without changing its result. */
function observeWriterEntry(tx: PollTransaction, onEntry: () => void): void {
    const target = tx as unknown as { write: (...args: unknown[]) => unknown };
    const original = target.write;
    vi.spyOn(target, 'write').mockImplementation((...args) => {
        onEntry();
        return Reflect.apply(original, tx, args);
    });
}

function expectReleasedReferences(tx: PollTransaction, sink: MemorySink): void {
    expect(Reflect.get(tx, 'listenerGuard')).toBeUndefined();
    expect(Reflect.get(tx, 'scopedBackend')).toBeUndefined();
    expect(sink.listenerCount('close')).toBe(0);
    expect(sink.listenerCount('error')).toBe(0);
    expect(sink.listenerCount('finish')).toBe(0);
}

async function retainedEvents(queue: BufferInstance): Promise<unknown[]> {
    const result = await queue.reserveGuarded();

    if (result.status !== 'reserved') {
        throw new Error(`expected retained reservation, got ${result.status}`);
    }

    const data: unknown = JSON.parse(result.eventsJson);

    if (!Array.isArray(data)) {
        throw new Error('expected retained event array');
    }

    const receipt = queue.releaseGuardedNoDrain(result.token);
    expect(receipt).toEqual({ status: 'released' });
    expect(queue.resumeGuardedDrain(receipt)).toEqual({ status: 'resumed' });
    return data;
}

describe('scoped production-style poll transaction (in-memory)', () => {
    it('commits the exact selected FIFO prefix, sorts that batch and preserves echo', async () => {
        const f = setup();
        const a = ordinary('A', 30, '雪');
        const b = ordinary('B', 10, '😀');
        const c = ordinary('C', 1, 'later FIFO entry');
        expect(f.queue.enqueue(a)).toBe('accepted');
        expect(f.queue.enqueue(b)).toBe('accepted');
        expect(f.queue.enqueue(c)).toBe('accepted');
        const held = holdFirstSelection(f.queue);
        const commit = vi.spyOn(f.queue, 'commitGuardedNoDrain');
        const resume = vi.spyOn(f.queue, 'resumeGuardedDrain');
        const legacyCommit = vi.spyOn(f.queue, 'commit');
        const coordinator = makeCoordinator(f);
        const sink = new MemorySink();
        const tx = coordinator.create(request({ limit: 2 }), sink, () => true);
        const pending = tx.run();

        try {
            await flush();
            const selection = selected(held.state.selection);
            expect(selection.status).toBe('reserved');

            if (selection.status !== 'reserved') {
                throw new Error('expected reserved FIFO prefix');
            }

            expect(JSON.parse(selection.eventsJson)).toEqual([a, b]);
            held.resume();
            expect(await pending).toEqual({ kind: 'local_finish', response: 'events' });
            expect(commit).toHaveBeenCalledOnce();
            expect(commit.mock.calls[0]![0]).toBe(selection.token);
            expect(commit.mock.calls[0]![1]).toBe(selection);
            const receipt = commit.mock.results[0]!.value;
            expect(receipt).toEqual({ status: 'committed' });
            expect(Object.isFrozen(receipt)).toBe(true);
            expect(resume).toHaveBeenCalledOnce();
            expect(resume.mock.calls[0]![0]).toBe(receipt);
            expect(legacyCommit).not.toHaveBeenCalled();
            expect(JSON.parse(sink.body!)).toEqual({
                status: 'ok',
                retcode: 0,
                data: [b, a],
                message: '',
                echo: 'echo-😺-"fixture"',
            });
            expect(f.queue.stats()).toMatchObject({ count: 1, reserved: 0, waiters: 0 });
            expectReleasedReferences(tx, sink);
            expect(await retainedEvents(f.queue)).toEqual([c]);
        } finally {
            held.resume();
            tx.cancel();
        }
    });

    it('keeps the original order when the scoped coordinator is configured for FIFO', async () => {
        const f = setup();
        const later = ordinary('first', 30);
        const earlier = ordinary('second', 10);
        expect(f.queue.enqueue(later)).toBe('accepted');
        expect(f.queue.enqueue(earlier)).toBe('accepted');
        const commit = vi.spyOn(f.queue, 'commitGuardedNoDrain');
        const resume = vi.spyOn(f.queue, 'resumeGuardedDrain');
        const coordinator = makeCoordinator(
            f,
            () => 0,
            () => true,
            'fifo',
        );
        const sink = new MemorySink();
        const tx = coordinator.create(request(), sink, () => true);
        expect(await tx.run()).toEqual({ kind: 'local_finish', response: 'events' });
        expect(JSON.parse(sink.body!)).toMatchObject({
            data: [later, earlier],
            echo: 'echo-😺-"fixture"',
        });
        expect(commit).toHaveBeenCalledOnce();
        const receipt = commit.mock.results[0]!.value;
        expect(receipt).toEqual({ status: 'committed' });
        expect(resume.mock.calls[0]![0]).toBe(receipt);
        expect(f.queue.stats()).toMatchObject({ count: 0, reserved: 0 });
        expectReleasedReferences(tx, sink);
    });

    it('settles a valid blocked recall by exact identity without deleting its head', async () => {
        const f = setup();
        const value = makeRecall(f);
        admit(f, value);
        const held = holdFirstSelection(f.queue);
        const settle = vi.spyOn(f.queue, 'settleBlockedGuardedNoDrain');
        const resume = vi.spyOn(f.queue, 'resumeGuardedDrain');
        const commit = vi.spyOn(f.queue, 'commitGuardedNoDrain');
        const coordinator = makeCoordinator(f);
        const sink = new MemorySink();
        const echo = 'blocked-😺';
        const tx = coordinator.create(
            request({ limit: 1, echo, maxOutputBytes: headBudget(value.candidate, echo) }),
            sink,
            () => true,
        );
        const pending = tx.run();

        try {
            await flush();
            const selection = selected(held.state.selection);
            expect(selection.status).toBe('blocked_guarded');
            held.resume();
            expect(await pending).toMatchObject({ kind: 'blocked' });
            expect(settle).toHaveBeenCalledOnce();
            expect(settle.mock.calls[0]![0]).toBe(selection.token);
            expect(settle.mock.calls[0]![1]).toBe(selection);
            const receipt = settle.mock.results[0]!.value;
            expect(receipt).toEqual({
                status: 'blocked',
                requiredBytes: Buffer.byteLength(JSON.stringify([value.candidate]), 'utf8'),
            });
            expect(resume.mock.calls[0]![0]).toBe(receipt);
            expect(commit).not.toHaveBeenCalled();
            expectNoWrites(sink);
            expect(f.queue.stats()).toMatchObject({ count: 1, reserved: 0 });
            expect(await retainedEvents(f.queue)).toEqual([value.candidate]);
        } finally {
            held.resume();
            tx.cancel();
        }
    });

    it('prunes a stale blocked recall only after the final listener guard', async () => {
        const f = setup();
        const value = makeRecall(f);
        admit(f, value);
        const held = holdFirstSelection(f.queue);
        const settle = vi.spyOn(f.queue, 'settleBlockedGuardedNoDrain');
        const resume = vi.spyOn(f.queue, 'resumeGuardedDrain');
        const coordinator = makeCoordinator(f);
        const sink = new MemorySink();
        const echo = 'blocked-stale';
        let changed = false;
        const tx = coordinator.create(
            request({ limit: 1, echo, maxOutputBytes: headBudget(value.candidate, echo) }),
            sink,
            () => {
                if (!changed) {
                    changed = true;
                    value.event.message_id = -43;
                }

                return true;
            },
        );
        const pending = tx.run();

        try {
            await flush();
            const selection = selected(held.state.selection);
            expect(selection.status).toBe('blocked_guarded');
            held.resume();
            expect(await pending).toEqual({ kind: 'pruned', count: 1 });
            expect(changed).toBe(true);
            expect(settle).toHaveBeenCalledOnce();
            expect(settle.mock.calls[0]![0]).toBe(selection.token);
            expect(settle.mock.calls[0]![1]).toBe(selection);
            const receipt = settle.mock.results[0]!.value;
            expect(receipt).toEqual({ status: 'pruned', count: 1 });
            expect(resume.mock.calls[0]![0]).toBe(receipt);
            expect(f.queue.stats()).toMatchObject({ count: 0, reserved: 0 });
            expectNoWrites(sink);
        } finally {
            held.resume();
            tx.cancel();
        }
    });

    it('prunes only a stale recall from a mixed selection and retains the other FIFO entries', async () => {
        const f = setup();
        const a = ordinary('A', 30);
        const r1 = makeRecall(f);
        const b = ordinary('B', 10);
        const r2 = makeRecall(f);
        expect(r1.eventTicket).not.toBe(f.ownerTicket);
        expect(tickets.sameSourceEpoch(r1.eventTicket, f.ownerTicket)).toBe('same');
        expect(r1.candidate).not.toBe(r2.candidate);
        expect(r1.candidate).toEqual(r2.candidate);
        expect(f.queue.enqueue(a)).toBe('accepted');
        admit(f, r1);
        expect(f.queue.enqueue(b)).toBe('accepted');
        admit(f, r2);
        const held = holdFirstSelection(f.queue);
        const commit = vi.spyOn(f.queue, 'commitGuardedNoDrain');
        const resume = vi.spyOn(f.queue, 'resumeGuardedDrain');
        const coordinator = makeCoordinator(f);
        const sink = new MemorySink();
        let changed = false;
        const tx = coordinator.create(request(), sink, () => {
            if (!changed) {
                changed = true;
                r1.event.message_id = -43;
            }

            return true;
        });
        const pending = tx.run();

        try {
            await flush();
            const selection = selected(held.state.selection);
            expect(selection.status).toBe('reserved');
            held.resume();
            expect(await pending).toEqual({ kind: 'pruned', count: 1 });
            expect(changed).toBe(true);
            expect(commit).toHaveBeenCalledOnce();
            expect(commit.mock.calls[0]![0]).toBe(selection.token);
            expect(commit.mock.calls[0]![1]).toBe(selection);
            const receipt = commit.mock.results[0]!.value;
            expect(receipt).toEqual({ status: 'pruned', count: 1 });
            expect(resume.mock.calls[0]![0]).toBe(receipt);
            expectNoWrites(sink);
            expect(f.queue.stats()).toMatchObject({ count: 3, reserved: 0 });
            expect(await retainedEvents(f.queue)).toEqual([a, b, r2.candidate]);
        } finally {
            held.resume();
            tx.cancel();
        }
    });

    it.each(['normal', 'cancel', 'close', 'throw'] as const)(
        'reports a known prune once when its status hook does %s',
        async (mode) => {
            const f = setup();
            const stale = makeRecall(f);
            const keep = ordinary('keep-after-hook', 1);
            admit(f, stale);
            expect(f.queue.enqueue(keep)).toBe('accepted');
            const held = holdFirstSelection(f.queue);
            const commit = vi.spyOn(f.queue, 'commitGuardedNoDrain');
            const resume = vi.spyOn(f.queue, 'resumeGuardedDrain');
            const statuses: ScopedPollStatus[] = [];
            let tx: PollTransaction;
            let coordinator: CoordinatorInstance;
            const onStatus = vi.fn((status: ScopedPollStatus) => {
                statuses.push(status);

                if (status.kind !== 'pruned') {
                    return;
                }

                if (mode === 'cancel') {
                    tx.cancel();
                } else if (mode === 'close') {
                    coordinator.close();
                } else if (mode === 'throw') {
                    throw new Error('synthetic status hook failure');
                }
            });
            coordinator = makeCoordinator(
                f,
                () => 0,
                () => true,
                'event-time',
                onStatus,
            );
            const sink = new MemorySink();
            let mutated = false;
            tx = coordinator.create(request(), sink, () => {
                if (!mutated) {
                    mutated = true;
                    stale.event.message_id = -43;
                }

                return true;
            });
            const pending = tx.run();

            try {
                await flush();
                const selection = selected(held.state.selection);
                expect(selection.status).toBe('reserved');
                held.resume();
                const outcome = await pending;

                if (mode === 'throw') {
                    expect(coreOutcome(outcome)).toMatchObject({
                        kind: 'scoped_uncertain',
                        effect: { kind: 'pruned', count: 1 },
                        committed: false,
                    });
                    expect(statuses).toEqual([{ kind: 'pruned', count: 1 }, { kind: 'uncertain' }]);

                    if (outcome.kind === 'cleanup_uncertain') {
                        expect(outcome.committed).toBe(false);
                    }
                } else {
                    expect(coreOutcome(outcome)).toEqual({ kind: 'pruned', count: 1 });
                    expect(statuses).toEqual([{ kind: 'pruned', count: 1 }]);
                }

                expect(
                    onStatus.mock.calls.filter(([status]) => status.kind === 'pruned'),
                ).toHaveLength(1);
                expect(commit).toHaveBeenCalledOnce();
                expect(commit.mock.calls[0]![0]).toBe(selection.token);
                expect(commit.mock.calls[0]![1]).toBe(selection);
                const receipt = commit.mock.results[0]!.value;
                expect(receipt).toEqual({ status: 'pruned', count: 1 });

                if (mode === 'throw') {
                    // A failed status notification may leave the barrier for
                    // owner retirement; any attempted resume must use this receipt.
                    expect(resume.mock.calls.length).toBeLessThanOrEqual(1);
                } else {
                    expect(resume).toHaveBeenCalledOnce();
                }

                if (resume.mock.calls.length) {
                    expect(resume.mock.calls[0]![0]).toBe(receipt);
                }

                expectNoWrites(sink);
                expect(f.queue.stats()).toMatchObject({ count: 1, reserved: 0 });
            } finally {
                held.resume();
                tx.cancel();
            }
        },
    );

    it('retains a reported prune if resume throws after the real drain completed', async () => {
        const f = setup();
        const stale = makeRecall(f);
        const keep = ordinary('after-resume-throw', 1);
        admit(f, stale);
        expect(f.queue.enqueue(keep)).toBe('accepted');
        const held = holdFirstSelection(f.queue);
        const commit = vi.spyOn(f.queue, 'commitGuardedNoDrain');
        const originalResume = f.queue.resumeGuardedDrain.bind(f.queue);
        let actualResume: ReturnType<BufferInstance['resumeGuardedDrain']> | undefined;
        const resume = vi.spyOn(f.queue, 'resumeGuardedDrain').mockImplementation((receipt) => {
            actualResume = originalResume(receipt);
            throw new Error('synthetic throw after the real resume');
        });
        const statuses = vi.fn<(status: ScopedPollStatus) => void>();
        const coordinator = makeCoordinator(
            f,
            () => 0,
            () => true,
            'event-time',
            statuses,
        );
        const sink = new MemorySink();
        let mutated = false;
        const tx = coordinator.create(request(), sink, () => {
            if (!mutated) {
                mutated = true;
                stale.event.message_id = -43;
            }

            return true;
        });
        const pending = tx.run();

        try {
            await flush();
            const selection = selected(held.state.selection);
            held.resume();
            const outcome = await pending;
            expect(coreOutcome(outcome)).toMatchObject({
                kind: 'scoped_uncertain',
                effect: { kind: 'pruned', count: 1 },
                committed: false,
            });

            if (outcome.kind === 'cleanup_uncertain') {
                expect(outcome.committed).toBe(false);
            }

            expect(statuses.mock.calls.map(([status]) => status)).toEqual([
                { kind: 'pruned', count: 1 },
                { kind: 'uncertain' },
            ]);
            expect(commit).toHaveBeenCalledOnce();
            expect(commit.mock.calls[0]![0]).toBe(selection.token);
            expect(commit.mock.calls[0]![1]).toBe(selection);
            const receipt = commit.mock.results[0]!.value;
            expect(receipt).toEqual({ status: 'pruned', count: 1 });
            expect(resume).toHaveBeenCalledOnce();
            expect(resume.mock.calls[0]![0]).toBe(receipt);
            expect(actualResume).toEqual({ status: 'resumed' });
            expect(f.queue.stats()).toMatchObject({ count: 1, reserved: 0 });
            expectNoWrites(sink);
        } finally {
            held.resume();
            tx.cancel();
        }
    });

    it.each(['reserved', 'blocked_guarded'] as const)(
        'releases a late %s token after abort, close or deadline without pruning',
        async (selectionKind) => {
            for (const stop of ['abort', 'close', 'deadline'] as const) {
                const f = setup();
                const value =
                    selectionKind === 'reserved' ? ordinary('retained', 1) : makeRecall(f);

                if (selectionKind === 'reserved') {
                    expect(f.queue.enqueue(value)).toBe('accepted');
                } else {
                    admit(f, value as ReturnType<typeof makeRecall>);
                }

                const held = holdFirstSelection(f.queue);
                const release = vi.spyOn(f.queue, 'releaseGuardedNoDrain');
                const commit = vi.spyOn(f.queue, 'commitGuardedNoDrain');
                const settle = vi.spyOn(f.queue, 'settleBlockedGuardedNoDrain');
                const resume = vi.spyOn(f.queue, 'resumeGuardedDrain');
                const abort = new AbortController();
                const clock = { now: 0 };
                const coordinator = makeCoordinator(f, () => clock.now);
                const sink = new MemorySink();
                const echo = 'late-😺';
                const budget =
                    selectionKind === 'reserved'
                        ? config.maxQueueBytes
                        : headBudget((value as ReturnType<typeof makeRecall>).candidate, echo);
                const tx = coordinator.create(
                    request({
                        limit: 1,
                        echo,
                        maxOutputBytes: budget,
                        responseDeadline: 50,
                        externalAbortSignal: abort.signal,
                    }),
                    sink,
                    () => true,
                );
                const pending = tx.run();

                try {
                    await flush();
                    const selection = selected(held.state.selection);
                    expect(selection.status).toBe(selectionKind);
                    expect(f.queue.stats()).toMatchObject({ count: 1, reserved: 1 });

                    if (stop === 'abort') {
                        abort.abort();
                    } else if (stop === 'close') {
                        coordinator.close();
                    } else {
                        clock.now = 51;
                        await vi.advanceTimersByTimeAsync(50);
                    }

                    expect(release).not.toHaveBeenCalled();
                    held.resume();
                    expect(await pending).toEqual({
                        kind:
                            stop === 'abort' ? 'aborted' : stop === 'close' ? 'closed' : 'deadline',
                    });
                    expect(release).toHaveBeenCalledExactlyOnceWith(selection.token);
                    const receipt = release.mock.results[0]!.value;
                    expect(receipt).toEqual({ status: 'released' });
                    expect(resume.mock.calls[0]![0]).toBe(receipt);
                    expect(commit).not.toHaveBeenCalled();
                    expect(settle).not.toHaveBeenCalled();
                    expectNoWrites(sink);
                    expect(f.queue.stats()).toMatchObject({ count: 1, reserved: 0 });
                    expectReleasedReferences(tx, sink);
                } finally {
                    held.resume();
                    tx.cancel();
                }
            }
        },
    );

    it('releases the exact late token when its scope is retired, without claiming gate release', async () => {
        const f = setup();
        const item = ordinary('scope-retired', 1);
        expect(f.queue.enqueue(item)).toBe('accepted');
        const held = holdFirstSelection(f.queue);
        const release = vi.spyOn(f.queue, 'releaseGuardedNoDrain');
        const resume = vi.spyOn(f.queue, 'resumeGuardedDrain');
        const coordinator = makeCoordinator(f);
        const sink = new MemorySink();
        const tx = coordinator.create(request(), sink, () => true);
        const pending = tx.run();

        try {
            await flush();
            const selection = selected(held.state.selection);
            expect(recall.retirePrivateRecallPollEpochAccountScope(f.scope)).toBe(true);
            held.resume();
            const outcome = await pending;
            expect(coreOutcome(outcome)).toMatchObject({
                kind: 'scope_revoked',
                effect: { kind: 'released' },
                committed: false,
            });

            if (outcome.kind === 'cleanup_uncertain') {
                expect(outcome.committed).toBe(false);
            }

            expect(release).toHaveBeenCalledExactlyOnceWith(selection.token);
            const receipt = release.mock.results[0]!.value;
            expect(receipt).toEqual({ status: 'released' });

            if (resume.mock.calls.length) {
                expect(resume.mock.calls[0]![0]).toBe(receipt);
                expect(resume.mock.results[0]!.value).toEqual({ status: 'scope_revoked' });
            }

            expectNoWrites(sink);
            expect(f.queue.stats()).toMatchObject({ count: 1, reserved: 0 });
            expect(await f.queue.reserveGuarded()).toEqual({ status: 'scope_revoked' });
            // This isolated coordinator does not own a production gate. Its
            // owner must retire and close the old queue before releasing a gate.
            expect(f.queue.close()).toBe(true);
            expect(f.queue.guardedCleanupState()).toBe('closed');
        } finally {
            held.resume();
            tx.cancel();
        }
    });

    it.each(['timeout', 'abort'] as const)(
        'does not turn an old waiter %s during quarantine into an empty success',
        async (mode) => {
            const f = setup();
            let queueNow = 100;
            const clock = vi.spyOn(performance, 'now').mockImplementation(() => queueNow);
            const coordinator = makeCoordinator(f);
            const sink = new MemorySink();
            const abort = new AbortController();
            const tx = coordinator.create(
                request({ timeoutMs: 20, externalAbortSignal: abort.signal }),
                sink,
                () => true,
            );
            const pending = tx.run();

            try {
                await flush();
                expect(f.queue.stats()).toMatchObject({ waiters: 1, count: 0 });
                clock.mockImplementationOnce(() => {
                    throw new Error('synthetic guarded clock failure');
                });
                expect(await f.queue.reserveGuarded()).toEqual({ status: 'uncertain' });
                expect(f.queue.guardedCleanupState()).toBe('uncertain');

                if (mode === 'abort') {
                    abort.abort();
                } else {
                    queueNow = 121;
                    await vi.advanceTimersByTimeAsync(20);
                }

                const outcome = await pending;
                expect(coreOutcome(outcome)).toMatchObject({
                    kind: 'scoped_uncertain',
                    effect: { kind: 'none' },
                    committed: false,
                });

                if (outcome.kind === 'cleanup_uncertain') {
                    expect(outcome.committed).toBe(false);
                }

                expectNoWrites(sink);
                expect(f.queue.guardedCleanupState()).toBe('uncertain');
            } finally {
                tx.cancel();
                clock.mockRestore();
            }
        },
    );

    it.each(['committed', 'pruned', 'released'] as const)(
        'preserves a known %s effect when the real deferred drain quarantines',
        async (effect) => {
            const f = setup();
            const a = ordinary('first', 30, 'first payload');
            const b = ordinary('remaining', 10, 'a different remaining payload');
            let stale: ReturnType<typeof makeRecall> | undefined;

            if (effect === 'pruned') {
                stale = makeRecall(f);
                admit(f, stale);
            } else {
                expect(f.queue.enqueue(a)).toBe('accepted');
            }

            expect(f.queue.enqueue(b)).toBe('accepted');
            const held = holdFirstSelection(f.queue);
            const commit = vi.spyOn(f.queue, 'commitGuardedNoDrain');
            const release = vi.spyOn(f.queue, 'releaseGuardedNoDrain');
            const originalResume = f.queue.resumeGuardedDrain.bind(f.queue);
            const resume = vi.spyOn(f.queue, 'resumeGuardedDrain').mockImplementation((receipt) => {
                const clock = vi.spyOn(performance, 'now').mockImplementationOnce(() => {
                    throw new Error('synthetic deferred drain failure');
                });

                try {
                    return originalResume(receipt);
                } finally {
                    clock.mockRestore();
                }
            });
            const statuses = vi.fn<(status: ScopedPollStatus) => void>();
            const coordinator =
                effect === 'pruned'
                    ? makeCoordinator(
                          f,
                          () => 0,
                          () => true,
                          'event-time',
                          statuses,
                      )
                    : makeCoordinator(f);
            const sink = new MemorySink();
            let mutated = false;
            const tx = coordinator.create(
                request({ limit: effect === 'pruned' ? 2 : 1 }),
                sink,
                () => {
                    if (stale && !mutated) {
                        mutated = true;
                        stale.event.message_id = -43;
                    }

                    return true;
                },
            );
            const pending = tx.run();

            try {
                await flush();
                const selection = selected(held.state.selection);
                expect(selection.status).toBe('reserved');
                const waiting = f.queue.reserveGuarded({ timeoutMs: 500 });
                expect(f.queue.stats()).toMatchObject({ waiters: 1 });

                if (effect === 'released') {
                    tx.cancel();
                }

                held.resume();
                const outcome = await pending;
                expect(coreOutcome(outcome)).toMatchObject({
                    kind: 'scoped_uncertain',
                    effect: effect === 'pruned' ? { kind: 'pruned', count: 1 } : { kind: effect },
                    committed: effect === 'committed',
                });

                if (outcome.kind === 'cleanup_uncertain') {
                    expect(outcome.committed).toBe(effect === 'committed');
                }

                if (effect === 'pruned') {
                    expect(statuses.mock.calls.map(([status]) => status)).toEqual([
                        { kind: 'pruned', count: 1 },
                        { kind: 'uncertain' },
                    ]);
                }

                expect(await waiting).toEqual({ status: 'uncertain' });
                expect(f.queue.guardedCleanupState()).toBe('uncertain');
                expect(resume).toHaveBeenCalledOnce();
                expect(resume.mock.results[0]!.value).toEqual({ status: 'uncertain' });
                expectNoWrites(sink);

                if (effect === 'released') {
                    expect(release).toHaveBeenCalledExactlyOnceWith(selection.token);
                    const receipt = release.mock.results[0]!.value;
                    expect(receipt).toEqual({ status: 'released' });
                    expect(resume.mock.calls[0]![0]).toBe(receipt);
                    expect(commit).not.toHaveBeenCalled();
                    expect(f.queue.stats()).toMatchObject({
                        count: 2,
                        queueBytes: Buffer.byteLength(JSON.stringify([a, b]), 'utf8'),
                    });
                } else {
                    expect(commit).toHaveBeenCalledOnce();
                    expect(commit.mock.calls[0]![0]).toBe(selection.token);
                    expect(commit.mock.calls[0]![1]).toBe(selection);
                    const receipt = commit.mock.results[0]!.value;
                    expect(receipt).toEqual(
                        effect === 'pruned'
                            ? { status: 'pruned', count: 1 }
                            : { status: 'committed' },
                    );
                    expect(resume.mock.calls[0]![0]).toBe(receipt);
                    expect(release).not.toHaveBeenCalled();
                    expect(f.queue.stats()).toMatchObject({
                        count: 1,
                        queueBytes: Buffer.byteLength(JSON.stringify([b]), 'utf8'),
                    });
                }

                // Gate stickiness belongs to the owner integration. This fixture
                // asserts only the real queue's retained uncertainty and effects.
                expect(await f.queue.reserveGuarded()).toEqual({ status: 'uncertain' });
            } finally {
                held.resume();
                tx.cancel();
            }
        },
    );

    it('does not start writing a committed batch when writer isOpen revokes the listener', async () => {
        const f = setup();
        expect(f.queue.enqueue(ordinary('committed-before-writer', 1))).toBe('accepted');
        const commit = vi.spyOn(f.queue, 'commitGuardedNoDrain');
        const release = vi.spyOn(f.queue, 'releaseGuardedNoDrain');
        const resume = vi.spyOn(f.queue, 'resumeGuardedDrain');
        const coordinator = makeCoordinator(f);
        let ready = true;
        let armedAfterCommit = false;
        let enteredWriter = false;
        let changedInsideWriter = false;
        const guard = vi.fn(() => {
            const observed = commit.mock.results[0];

            if (ready && observed?.type === 'return' && observed.value.status === 'committed') {
                armedAfterCommit = true;
            }

            // The callback always reports actual readiness, including after revocation.
            return ready;
        });
        const sink = new MemorySink(() => {
            if (enteredWriter && armedAfterCommit && !changedInsideWriter) {
                changedInsideWriter = true;
                ready = false;
            }
        });
        const tx = coordinator.create(request(), sink, guard);
        observeWriterEntry(tx, () => {
            enteredWriter = true;
        });
        const outcome = await tx.run();
        const core = coreOutcome(outcome);
        expect(
            core.kind === 'committed_unsent' ||
                (core.kind === 'unknown' && core.committed === true),
        ).toBe(true);

        if (outcome.kind === 'cleanup_uncertain') {
            expect(outcome.committed).toBe(true);
        }

        expect(commit).toHaveBeenCalledOnce();
        const receipt = commit.mock.results[0]!.value;
        expect(receipt).toEqual({ status: 'committed' });
        expect(resume.mock.calls[0]![0]).toBe(receipt);
        expect(armedAfterCommit).toBe(true);
        expect(enteredWriter).toBe(true);
        expect(changedInsideWriter).toBe(true);
        expect(
            guard.mock.results.some((result) => result.type === 'return' && result.value === false),
        ).toBe(true);
        expectNoWrites(sink);
        expect(release).not.toHaveBeenCalled();
        expect(f.queue.stats()).toMatchObject({ count: 0, reserved: 0 });
        expect(await f.queue.reserveGuarded()).toEqual({ status: 'empty' });
        expectReleasedReferences(tx, sink);
    });

    it('suppresses end when headers revoke the listener after commit', async () => {
        const f = setup();
        expect(f.queue.enqueue(ordinary('revoked-after-head', 1))).toBe('accepted');
        const commit = vi.spyOn(f.queue, 'commitGuardedNoDrain');
        const release = vi.spyOn(f.queue, 'releaseGuardedNoDrain');
        const resume = vi.spyOn(f.queue, 'resumeGuardedDrain');
        const coordinator = makeCoordinator(f);
        let ready = true;
        const guard = vi.fn(() => ready);
        const sink = new MemorySink();
        const originalHead = sink.writeHead.bind(sink);
        vi.spyOn(sink, 'writeHead').mockImplementation(() => {
            originalHead();
            ready = false;
        });
        const tx = coordinator.create(request(), sink, guard);
        const outcome = await tx.run();
        expect(coreOutcome(outcome)).toEqual({ kind: 'unknown', committed: true });

        if (outcome.kind === 'cleanup_uncertain') {
            expect(outcome.committed).toBe(true);
        }

        expect(sink.headCalls).toBe(1);
        expect(sink.endCalls).toBe(0);
        expect(sink.body).toBeUndefined();
        expect(
            guard.mock.results.some((result) => result.type === 'return' && result.value === false),
        ).toBe(true);
        expect(commit).toHaveBeenCalledOnce();
        const receipt = commit.mock.results[0]!.value;
        expect(receipt).toEqual({ status: 'committed' });
        expect(resume.mock.calls[0]![0]).toBe(receipt);
        expect(release).not.toHaveBeenCalled();
        expect(f.queue.stats()).toMatchObject({ count: 0, reserved: 0 });
        expect(await f.queue.reserveGuarded()).toEqual({ status: 'empty' });
        expectReleasedReferences(tx, sink);
    });

    it.each(['empty', 'timeout'] as const)(
        'does not write a scoped %s response if its writer check revokes the listener',
        async (mode) => {
            const f = setup();
            let queueNow = 100;
            const queueClock = vi.spyOn(performance, 'now').mockImplementation(() => queueNow);
            const commit = vi.spyOn(f.queue, 'commitGuardedNoDrain');
            const release = vi.spyOn(f.queue, 'releaseGuardedNoDrain');
            const settle = vi.spyOn(f.queue, 'settleBlockedGuardedNoDrain');
            const resume = vi.spyOn(f.queue, 'resumeGuardedDrain');
            const coordinator = makeCoordinator(f);
            let ready = true;
            let enteredWriter = false;
            let changedInsideWriter = false;
            const guard = vi.fn(() => ready);
            const sink = new MemorySink(() => {
                if (enteredWriter && !changedInsideWriter) {
                    changedInsideWriter = true;
                    ready = false;
                }
            });
            const tx = coordinator.create(
                request({ timeoutMs: mode === 'empty' ? 0 : 20 }),
                sink,
                guard,
            );
            observeWriterEntry(tx, () => {
                enteredWriter = true;
            });
            const pending = tx.run();

            try {
                if (mode === 'timeout') {
                    await flush();
                    expect(f.queue.stats()).toMatchObject({ waiters: 1 });
                    queueNow = 121;
                    await vi.advanceTimersByTimeAsync(20);
                }

                const outcome = await pending;
                const core = coreOutcome(outcome);
                expect(
                    core.kind === 'epoch_invalid' ||
                        (core.kind === 'unknown' && core.committed === false),
                ).toBe(true);

                if (outcome.kind === 'cleanup_uncertain') {
                    expect(outcome.committed).toBe(false);
                }

                expect(enteredWriter).toBe(true);
                expect(changedInsideWriter).toBe(true);
                expect(
                    guard.mock.results.some(
                        (result) => result.type === 'return' && result.value === false,
                    ),
                ).toBe(true);
                expectNoWrites(sink);
                expect(commit).not.toHaveBeenCalled();
                expect(release).not.toHaveBeenCalled();
                expect(settle).not.toHaveBeenCalled();
                expect(resume).not.toHaveBeenCalled();
                expect(f.queue.stats()).toMatchObject({ count: 0, reserved: 0, waiters: 0 });
                expectReleasedReferences(tx, sink);
            } finally {
                tx.cancel();
                queueClock.mockRestore();
            }
        },
    );

    it.each(['head', 'end'] as const)(
        'does not requeue a committed event after a synthetic %s write failure',
        async (failure) => {
            const f = setup();
            expect(f.queue.enqueue(ordinary('already-committed', 1))).toBe('accepted');
            const commit = vi.spyOn(f.queue, 'commitGuardedNoDrain');
            const release = vi.spyOn(f.queue, 'releaseGuardedNoDrain');
            const resume = vi.spyOn(f.queue, 'resumeGuardedDrain');
            const coordinator = makeCoordinator(f);
            const sink = new MemorySink(() => {}, failure);
            const tx = coordinator.create(request(), sink, () => true);
            expect(await tx.run()).toEqual({ kind: 'unknown', committed: true });
            expect(commit).toHaveBeenCalledOnce();
            const receipt = commit.mock.results[0]!.value;
            expect(receipt).toEqual({ status: 'committed' });
            expect(resume.mock.calls[0]![0]).toBe(receipt);
            expect(release).not.toHaveBeenCalled();
            expect(f.queue.stats()).toMatchObject({ count: 0, reserved: 0 });
        },
    );

    it.each(['false', 'throw', 'cancel'] as const)(
        'keeps an asynchronous recursive finish from succeeding when its final guard does %s',
        async (mode) => {
            const f = setup();
            expect(f.queue.enqueue(ordinary('async-finish', 1))).toBe('accepted');
            const commit = vi.spyOn(f.queue, 'commitGuardedNoDrain');
            const release = vi.spyOn(f.queue, 'releaseGuardedNoDrain');
            const resume = vi.spyOn(f.queue, 'resumeGuardedDrain');
            const coordinator = makeCoordinator(f);
            const sink = new MemorySink(() => {}, 'none', false);
            let ready = true;
            let armed = false;
            let reentered = false;
            let nestedOutcome: string | undefined;
            let tx: PollTransaction;
            const guard = vi.fn(() => {
                if (!armed || reentered) {
                    return ready;
                }

                reentered = true;
                sink.emit('finish');
                const observed = Reflect.get(tx, 'writeOutcome') as { kind?: string } | undefined;
                nestedOutcome = observed?.kind ?? 'pending';

                if (mode === 'false') {
                    ready = false;
                    return ready;
                }

                if (mode === 'throw') {
                    throw new Error('synthetic asynchronous final guard failure');
                }

                tx.cancel();
                return ready;
            });
            tx = coordinator.create(request(), sink, guard);
            const pending = tx.run();
            let settled = false;
            void pending.then(() => {
                settled = true;
            });

            try {
                await flush();
                expect(sink.headCalls).toBe(1);
                expect(sink.endCalls).toBe(1);
                expect(sink.body).toBeDefined();
                expect(Reflect.get(tx, 'endReturned')).toBe(true);
                expect(settled).toBe(false);
                expect(commit).toHaveBeenCalledOnce();
                const receipt = commit.mock.results[0]!.value;
                expect(receipt).toEqual({ status: 'committed' });
                expect(resume.mock.calls[0]![0]).toBe(receipt);
                expect(f.queue.stats()).toMatchObject({ count: 0, reserved: 0 });

                armed = true;
                expect(sink.emit('finish')).toBe(true);
                const outcome = await pending;
                expect(coreOutcome(outcome)).toEqual({ kind: 'unknown', committed: true });

                if (outcome.kind === 'cleanup_uncertain') {
                    expect(outcome.committed).toBe(true);
                }

                expect(reentered).toBe(true);
                expect(nestedOutcome).toBe('pending');
                expect(sink.headCalls).toBe(1);
                expect(sink.endCalls).toBe(1);
                expect(release).not.toHaveBeenCalled();
                expect(f.queue.stats()).toMatchObject({ count: 0, reserved: 0 });
                expect(await f.queue.reserveGuarded()).toEqual({ status: 'empty' });
                expectReleasedReferences(tx, sink);
            } finally {
                tx.cancel();
            }
        },
    );

    it.each(['false', 'cancel', 'cancel-throw'] as const)(
        'rechecks the listener after sink reentry and preserves first stop for %s',
        async (mode) => {
            const f = setup();
            expect(f.queue.enqueue(ordinary('guarded', 1))).toBe('accepted');
            const release = vi.spyOn(f.queue, 'releaseGuardedNoDrain');
            const commit = vi.spyOn(f.queue, 'commitGuardedNoDrain');
            const resume = vi.spyOn(f.queue, 'resumeGuardedDrain');
            const coordinator = makeCoordinator(f);
            let ready = true;
            let changed = false;
            let tx: PollTransaction;
            const guard = vi.fn(() => {
                if (ready) {
                    return true;
                }

                if (mode !== 'false') {
                    tx.cancel();
                }

                if (mode === 'cancel-throw') {
                    throw new Error('synthetic listener failure after cancellation');
                }

                return false;
            });
            const sink = new MemorySink(() => {
                if (!changed && guard.mock.calls.length > 0) {
                    changed = true;
                    ready = false;
                }
            });
            tx = coordinator.create(request(), sink, guard);
            expect(await tx.run()).toEqual({
                kind: mode === 'false' ? 'epoch_invalid' : 'cancelled',
            });
            expect(changed).toBe(true);
            expect(guard).toHaveBeenCalledTimes(2);
            expect(commit).not.toHaveBeenCalled();
            expect(release).toHaveBeenCalledOnce();
            const receipt = release.mock.results[0]!.value;
            expect(receipt).toEqual({ status: 'released' });
            expect(resume.mock.calls[0]![0]).toBe(receipt);
            expect(f.queue.stats()).toMatchObject({ count: 1, reserved: 0 });
            expectNoWrites(sink);
            expectReleasedReferences(tx, sink);
        },
    );
});

// The final listener/epoch samples are trusted synchronous dependencies. A
// final callback that mutates its own authority but returns stale true is not
// disproved by an opaque scope or by this in-memory test suite.
