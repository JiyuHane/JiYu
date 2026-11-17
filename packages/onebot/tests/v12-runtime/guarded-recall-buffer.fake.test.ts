import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import { getEventListeners } from 'node:events';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '../../src/types';
import type {
    EventPollBuffer as BufferInstance,
    PollBufferConfig,
} from '../../src/v12-runtime/event-poll-buffer';

// Same-ID, same-JSON twins remain distinct converter objects and proofs.
vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();
    return { ...actual, randomUUID: () => '11111111-1111-4111-8111-111111111111' };
});

// SourceGeneration's unrelated ordered-owner import is not part of this fixture.
vi.mock('../../src/v12-runtime/poll-owner', () => ({
    isCurrentOrderedFacade: () => false,
}));

let EventPollBuffer: typeof import('../../src/v12-runtime/event-poll-buffer').EventPollBuffer;
let SourceGeneration: typeof import('../../src/v12-runtime/source-generation').SourceGeneration;
let recall: typeof import('../../src/v12-runtime/private-recall-source');
let guards: Array<{ mock: { calls: unknown[] } }> = [];
const buffers: BufferInstance[] = [];

function forbidden(): never {
    throw new Error('unexpected network, native or child-process operation in guarded fixture');
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
        vi.spyOn(process, 'dlopen').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawn').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawnSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'exec').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFile').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFileSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'fork').mockImplementation(forbidden),
    ];
    // Load only pure queue, local generation and local conversion/proof code,
    // and only after the process, native and network guards are armed.
    ({ EventPollBuffer } = await import('../../src/v12-runtime/event-poll-buffer'));
    ({ SourceGeneration } = await import('../../src/v12-runtime/source-generation'));
    recall = await import('../../src/v12-runtime/private-recall-source');
});

afterEach(() => {
    for (const q of buffers) {
        q.close();
    }

    const calls = guards.map((guard) => guard.mock.calls.length);
    const timers = vi.getTimerCount();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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

type RecallOptions = {
    selfUin?: number;
    peerUin?: number;
    messageId?: number;
    recalledBySelf?: boolean;
    time?: number;
};

function fixture(options: RecallOptions = {}) {
    const selfUin = options.selfUin ?? SELF;
    const peerUin = options.peerUin ?? PEER;
    const messageId = options.messageId ?? -42;
    const time = options.time ?? TIME;
    const recalledBySelf = options.recalledBySelf ?? false;
    const context = { uin: String(selfUin), selfId: selfUin };
    const self = { platform: 'qq', user_id: String(selfUin) };
    const generation = new SourceGeneration();
    const binding = {};
    generation.setOnline(true);
    const ticket = generation.capture(binding);

    if (!ticket) {
        throw new Error('synthetic source ticket missing');
    }

    const raw: Recall = {
        kind: 'friend_recall',
        selfUin,
        userUin: peerUin,
        msgSeq: 445,
        clientSeq: 446,
        time,
        recalledBySelf,
    };
    const event: JsonObject = {
        time,
        self_id: selfUin,
        post_type: 'notice',
        notice_type: 'friend_recall',
        user_id: peerUin,
        message_id: messageId,
    };
    const snapshot = recall.capturePrivateRecallSource(context, raw, ticket);

    if (!snapshot || !recall.rememberPrivateRecallSource(context, event, snapshot, messageId)) {
        throw new Error('synthetic recall provenance missing');
    }

    const source = recall.getPrivateRecallSource(context, event);

    if (!source) {
        throw new Error('synthetic remembered source missing');
    }

    const candidate = recall.convertPrivateRecallEvent(event, self, source);

    if (!candidate) {
        throw new Error('synthetic recall conversion failed');
    }

    const proof = recall.createPrivateRecallPollProof(event, source, ticket, self, candidate);

    if (!proof) {
        throw new Error('synthetic recall proof missing');
    }

    return { context, self, generation, binding, ticket, raw, event, source, candidate, proof };
}

function ordinary(id: string, text = '', time = TIME) {
    return { type: 'message', id, text, time };
}

function wireBytes(events: unknown[]): number {
    return Buffer.byteLength(JSON.stringify(events), 'utf8');
}

function guarded(overrides: Partial<PollBufferConfig> = {}, policy: Policy = 'reject-new') {
    const q = new EventPollBuffer({ ...defaults, ...overrides }, policy, 'guarded-recall');
    buffers.push(q);
    return q;
}

function legacy(overrides: Partial<PollBufferConfig> = {}, policy?: Policy) {
    const q = new EventPollBuffer({ ...defaults, ...overrides }, policy);
    buffers.push(q);
    return q;
}

function reserved(result: GuardedResult): Reserved {
    if (result.status !== 'reserved') {
        throw new Error(`expected guarded reservation, got ${result.status}`);
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

function admit(q: BufferInstance, f: ReturnType<typeof fixture>): void {
    expect(q.enqueueGuarded(f.candidate, f.proof)).toBe('accepted');
}

// Keep the exact returned object, not a copied status/value projection. The
// receipt belongs to one queue and to just one outstanding drain barrier.
const pendingReceipts = new WeakMap<BufferInstance, object>();

function recordReceipt<T extends object>(q: BufferInstance, receipt: T, expected: object): T {
    expect(receipt).toEqual(expected);
    expect(Object.isFrozen(receipt)).toBe(true);
    pendingReceipts.set(q, receipt);
    return receipt;
}

function resume(q: BufferInstance, receipt = pendingReceipts.get(q)): void {
    if (!receipt) {
        throw new Error('missing exact no-drain receipt');
    }

    expect(q.resumeGuardedDrain(receipt)).toEqual({ status: 'resumed' });

    if (pendingReceipts.get(q) === receipt) {
        pendingReceipts.delete(q);
    }
}

async function expectQueue(q: BufferInstance, expected: unknown[]): Promise<void> {
    expect(q.stats()).toMatchObject({ count: expected.length, queueBytes: wireBytes(expected) });

    if (expected.length === 0) {
        expect(await q.reserveGuarded()).toEqual({ status: 'empty' });
        return;
    }

    const selection = reserved(await q.reserveGuarded());
    expect(selection.count).toBe(expected.length);
    expect(selection.eventsJson).toBe(JSON.stringify(expected));
    expect(selection.bytes).toBe(wireBytes(expected));
    recordReceipt(q, q.releaseGuardedNoDrain(selection.token), { status: 'released' });
    resume(q);
}

describe('guarded recall queue with synthetic in-process evidence', () => {
    it('admits ordinary events and both recall directions, freezes the selection, and commits only through its guarded receipt', async () => {
        const q = guarded();
        const text = ordinary('普通', '雪😀\n');
        const peer = fixture({ messageId: -2147483648 });
        const own = fixture({ recalledBySelf: true, messageId: 2147483647 });
        expect(peer.candidate.user_id).toBe(String(PEER));
        expect(own.candidate.user_id).toBe(String(SELF));
        expect(q.enqueue(text)).toBe('accepted');
        admit(q, peer);
        admit(q, own);
        const expected = [text, peer.candidate, own.candidate];
        const selection = reserved(await q.reserveGuarded());
        expect(selection.eventsJson).toBe(JSON.stringify(expected));
        expect(selection.count).toBe(3);
        expect(selection.bytes).toBe(wireBytes(expected));
        expect(selection.bytes).toBeGreaterThan(selection.eventsJson.length);
        expect(q.stats()).toMatchObject({ count: 3, reserved: 3, queueBytes: selection.bytes });

        expect(await q.reserve()).toEqual({ status: 'invalid' });
        expect(q.commit(selection.token)).toBe(false);
        expect(q.release(selection.token)).toBe(false);
        expect(await q.reserveGuarded()).toEqual({ status: 'contended' });
        expect(q.stats().count).toBe(3);
        recordReceipt(q, q.commitGuardedNoDrain(selection.token, selection), {
            status: 'committed',
        });
        expect(q.stats()).toMatchObject({ count: 0, queueBytes: 2, reserved: 0 });
        expect(await q.reserveGuarded()).toEqual({ status: 'contended' });
        resume(q);
        expect(await q.reserveGuarded()).toEqual({ status: 'empty' });
        expect(q.oldestDropCount()).toBe(0n);
    });

    it('binds the exact selection and token, even for identical event ids and identical JSON', async () => {
        const a = fixture();
        const b = fixture();
        expect(a.candidate).toEqual(b.candidate);
        expect(a.candidate).not.toBe(b.candidate);
        expect(a.proof).not.toBe(b.proof);
        const qa = guarded();
        const qb = guarded();
        admit(qa, a);
        admit(qb, b);
        const ra = reserved(await qa.reserveGuarded());
        const rb = reserved(await qb.reserveGuarded());
        expect(ra.eventsJson).toBe(rb.eventsJson);
        expect(ra.token).not.toBe(rb.token);
        expect(Reflect.set(ra, 'eventsJson', 'changed')).toBe(false);
        expect(Reflect.defineProperty(ra, 'count', { value: 0 })).toBe(false);
        expect(Reflect.defineProperty(ra.token, 'newField', { value: true })).toBe(false);
        const clone = Object.freeze({ ...ra });
        const getter = vi.fn(() => {
            throw new Error('untrusted receipt getter must not run');
        });
        const forged = Object.defineProperty({ ...ra }, 'eventsJson', { get: getter });
        const trap = vi.fn(() => {
            throw new Error('untrusted receipt proxy trap must not run');
        });
        const proxied = new Proxy(ra, { get: trap, ownKeys: trap, getPrototypeOf: trap });

        expect(qa.commitGuardedNoDrain(rb.token, ra)).toEqual({ status: 'stale' });
        expect(qa.commitGuardedNoDrain(ra.token, rb)).toEqual({ status: 'stale' });
        expect(qa.commitGuardedNoDrain(ra.token, clone)).toEqual({ status: 'stale' });
        expect(qa.commitGuardedNoDrain(ra.token, forged as never)).toEqual({ status: 'stale' });
        expect(qa.commitGuardedNoDrain(ra.token, proxied)).toEqual({ status: 'stale' });
        expect(getter).not.toHaveBeenCalled();
        expect(trap).not.toHaveBeenCalled();
        expect(qa.stats()).toMatchObject({ count: 1, reserved: 1 });
        expect(qb.stats()).toMatchObject({ count: 1, reserved: 1 });
        recordReceipt(qa, qa.commitGuardedNoDrain(ra.token, ra), { status: 'committed' });
        recordReceipt(qb, qb.commitGuardedNoDrain(rb.token, rb), { status: 'committed' });
        resume(qa);
        resume(qb);
    });

    it('ignores sorting of a consumer copy and still commits the exact physical prefix', async () => {
        const q = guarded();
        const late = ordinary('late', '', TIME + 5);
        const recallEvent = fixture({ time: TIME });
        const early = ordinary('early', '', TIME - 5);
        const tail = ordinary('tail', '', TIME - 10);
        expect(q.enqueue(late)).toBe('accepted');
        admit(q, recallEvent);
        expect(q.enqueue(early)).toBe('accepted');
        expect(q.enqueue(tail)).toBe('accepted');
        const selection = reserved(await q.reserveGuarded({ limit: 3 }));
        const sorted = (JSON.parse(selection.eventsJson) as Array<{ time: number }>).sort(
            (a, b) => a.time - b.time,
        );
        expect(sorted.map((event) => event.time)).toEqual([TIME - 5, TIME, TIME + 5]);
        expect(selection.eventsJson).toBe(JSON.stringify([late, recallEvent.candidate, early]));
        const changed = Object.freeze({ ...selection, eventsJson: JSON.stringify(sorted) });
        expect(q.commitGuardedNoDrain(selection.token, changed)).toEqual({ status: 'stale' });
        expect(q.stats().count).toBe(4);
        recordReceipt(q, q.commitGuardedNoDrain(selection.token, selection), {
            status: 'committed',
        });
        resume(q);
        await expectQueue(q, [tail]);
    });

    it('accepts reordered v11 keys and unchanged values when only writable/configurable flags differ', async () => {
        const q = guarded();
        const f = fixture();
        admit(q, f);
        const selection = reserved(await q.reserveGuarded());
        const before = Object.keys(f.event);
        expect(Reflect.deleteProperty(f.event, 'user_id')).toBe(true);
        Object.defineProperty(f.event, 'user_id', {
            value: PEER,
            enumerable: true,
            writable: false,
            configurable: false,
        });
        expect(Object.keys(f.event)).not.toEqual(before);
        // The current local proof compares the exact keys, enumerable data
        // descriptors and values, not their order or writable/configurable flags.
        expect(recall.isPrivateRecallPollProofCurrent(f.proof)).toBe(true);
        recordReceipt(q, q.commitGuardedNoDrain(selection.token, selection), {
            status: 'committed',
        });
        resume(q);
        await expectQueue(q, []);
    });

    it('prunes all invalid recalls only, retaining normal entries, a valid recall and the physical tail in order', async () => {
        const q = guarded();
        const first = ordinary('首', '雪');
        const invalidAccessor = fixture({ messageId: -1 });
        const valid = fixture({ messageId: -2, recalledBySelf: true });
        const invalidSymbol = fixture({ messageId: -3 });
        const tail = ordinary('尾', '😀\n');
        expect(q.enqueue(first)).toBe('accepted');
        admit(q, invalidAccessor);
        admit(q, valid);
        admit(q, invalidSymbol);
        expect(q.enqueue(tail)).toBe('accepted');
        const selection = reserved(await q.reserveGuarded({ limit: 4 }));
        expect(selection.eventsJson).toBe(
            JSON.stringify([
                first,
                invalidAccessor.candidate,
                valid.candidate,
                invalidSymbol.candidate,
            ]),
        );
        const getter = vi.fn(() => {
            throw new Error('mutated v11 accessor must not run');
        });
        Object.defineProperty(invalidAccessor.event, 'message_id', {
            configurable: true,
            enumerable: true,
            get: getter,
        });
        Object.defineProperty(invalidSymbol.event, Symbol('unexpected'), {
            configurable: true,
            get: getter,
        });
        recordReceipt(q, q.commitGuardedNoDrain(selection.token, selection), {
            status: 'pruned',
            count: 2,
        });
        expect(getter).not.toHaveBeenCalled();
        expect(q.oldestDropCount()).toBe(0n);
        expect(q.stats()).toMatchObject({
            count: 3,
            reserved: 0,
            queueBytes: wireBytes([first, valid.candidate, tail]),
        });
        expect(await q.reserveGuarded()).toEqual({ status: 'contended' });
        resume(q);
        await expectQueue(q, [first, valid.candidate, tail]);

        // Releasing the new selection retained the surviving entry's proof.
        const again = reserved(await q.reserveGuarded());
        valid.event.message_id = -99;
        recordReceipt(q, q.commitGuardedNoDrain(again.token, again), {
            status: 'pruned',
            count: 1,
        });
        expect(q.oldestDropCount()).toBe(0n);
        resume(q);
        await expectQueue(q, [first, tail]);
    });

    it('consumes each exact receipt once and never lets an older or foreign receipt clear a new barrier', async () => {
        const q = guarded();
        const other = guarded();
        expect(q.enqueue(ordinary('A'))).toBe('accepted');
        expect(q.enqueue(ordinary('B'))).toBe('accepted');
        const a = reserved(await q.reserveGuarded({ limit: 1 }));
        const aReceipt = recordReceipt(q, q.commitGuardedNoDrain(a.token, a), {
            status: 'committed',
        });
        resume(q, aReceipt);
        const b = reserved(await q.reserveGuarded());
        expect(b.eventsJson).toBe(JSON.stringify([ordinary('B')]));
        const bReceipt = recordReceipt(q, q.commitGuardedNoDrain(b.token, b), {
            status: 'committed',
        });
        expect(aReceipt).not.toBe(bReceipt);
        expect(Reflect.set(bReceipt, 'status', 'changed')).toBe(false);

        expect(other.enqueue(ordinary('other'))).toBe('accepted');
        const foreignSelection = reserved(await other.reserveGuarded());
        const foreignReceipt = recordReceipt(
            other,
            other.commitGuardedNoDrain(foreignSelection.token, foreignSelection),
            { status: 'committed' },
        );
        expect(foreignReceipt).toEqual(bReceipt);
        expect(foreignReceipt).not.toBe(bReceipt);
        const clone = Object.freeze({ ...bReceipt });
        const getter = vi.fn(() => {
            throw new Error('forged receipt getter must not run');
        });
        const forged = Object.defineProperty({}, 'status', { enumerable: true, get: getter });
        const trap = vi.fn(() => {
            throw new Error('receipt proxy trap must not run');
        });
        const proxied = new Proxy(bReceipt, {
            get: trap,
            ownKeys: trap,
            getPrototypeOf: trap,
            getOwnPropertyDescriptor: trap,
        });
        const before = q.stats();

        for (const stale of [aReceipt, clone, forged, proxied, foreignReceipt, null, undefined]) {
            expect(q.resumeGuardedDrain(stale)).toEqual({ status: 'stale' });
            expect(await q.reserveGuarded()).toEqual({ status: 'contended' });
            expect(q.stats()).toEqual(before);
        }

        expect(other.resumeGuardedDrain(bReceipt)).toEqual({ status: 'stale' });
        expect(await other.reserveGuarded()).toEqual({ status: 'contended' });
        expect(getter).not.toHaveBeenCalled();
        expect(trap).not.toHaveBeenCalled();
        resume(q, bReceipt);
        expect(await q.reserveGuarded()).toEqual({ status: 'empty' });
        expect(q.resumeGuardedDrain(bReceipt)).toEqual({ status: 'stale' });
        resume(other, foreignReceipt);
        expect(other.resumeGuardedDrain(foreignReceipt)).toEqual({ status: 'stale' });
        expect(await other.reserveGuarded()).toEqual({ status: 'empty' });
    });

    it('does not drain or let enqueue and a short poll bypass waiting FIFO polls until resume', async () => {
        const q = guarded();
        const firstEvent = ordinary('held');
        const secondEvent = ordinary('second');
        const thirdEvent = ordinary('third');
        expect(q.enqueue(firstEvent)).toBe('accepted');
        const held = reserved(await q.reserveGuarded());
        const a = new AbortController();
        const b = new AbortController();
        const firstDone = vi.fn();
        const secondDone = vi.fn();
        const first = q.reserveGuarded({ limit: 1, timeoutMs: 500, signal: a.signal });
        const second = q.reserveGuarded({ limit: 1, timeoutMs: 500, signal: b.signal });
        void first.then(firstDone);
        void second.then(secondDone);
        expect(q.stats().waiters).toBe(2);
        recordReceipt(q, q.commitGuardedNoDrain(held.token, held), { status: 'committed' });
        expect(q.enqueue(secondEvent)).toBe('accepted');
        await Promise.resolve();
        expect(firstDone).not.toHaveBeenCalled();
        expect(secondDone).not.toHaveBeenCalled();
        expect(await q.reserveGuarded()).toEqual({ status: 'contended' });
        expect(q.stats()).toMatchObject({ count: 1, reserved: 0, waiters: 2 });

        resume(q);
        const firstSelection = reserved(await first);
        expect(firstSelection.eventsJson).toBe(JSON.stringify([secondEvent]));
        expect(getEventListeners(a.signal, 'abort')).toHaveLength(0);
        expect(q.enqueue(thirdEvent)).toBe('accepted');
        expect(await q.reserveGuarded()).toEqual({ status: 'contended' });
        expect(secondDone).not.toHaveBeenCalled();
        recordReceipt(q, q.commitGuardedNoDrain(firstSelection.token, firstSelection), {
            status: 'committed',
        });
        await Promise.resolve();
        expect(secondDone).not.toHaveBeenCalled();
        resume(q);
        const secondSelection = reserved(await second);
        expect(secondSelection.eventsJson).toBe(JSON.stringify([thirdEvent]));
        expect(getEventListeners(b.signal, 'abort')).toHaveLength(0);
        recordReceipt(q, q.commitGuardedNoDrain(secondSelection.token, secondSelection), {
            status: 'committed',
        });
        resume(q);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cleans up abort, timeout and close while drain is deferred', async () => {
        const q = guarded();
        expect(q.enqueue(ordinary('held'))).toBe('accepted');
        const held = reserved(await q.reserveGuarded());
        const aborted = new AbortController();
        const timed = new AbortController();
        const closed = new AbortController();
        const a = q.reserveGuarded({ timeoutMs: 100, signal: aborted.signal });
        const b = q.reserveGuarded({ timeoutMs: 10, signal: timed.signal });
        const c = q.reserveGuarded({ timeoutMs: 100, signal: closed.signal });
        const closedReceipt = recordReceipt(q, q.commitGuardedNoDrain(held.token, held), {
            status: 'committed',
        });
        expect(q.enqueue(ordinary('pending'))).toBe('accepted');
        aborted.abort();
        expect(await a).toEqual({ status: 'aborted' });
        expect(getEventListeners(aborted.signal, 'abort')).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(10);
        expect(await b).toEqual({ status: 'timeout' });
        expect(getEventListeners(timed.signal, 'abort')).toHaveLength(0);
        expect(q.stats()).toMatchObject({ count: 1, reserved: 0, waiters: 1 });
        expect(q.close()).toBe(true);
        expect(q.resumeGuardedDrain(closedReceipt)).toEqual({ status: 'stale' });
        expect(await c).toEqual({ status: 'closed' });
        expect(getEventListeners(closed.signal, 'abort')).toHaveLength(0);
        expect(q.stats()).toMatchObject({ count: 0, queueBytes: 2, waiters: 0, closed: true });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('returns ordinary blocked without a token and preserves the head for a larger budget', async () => {
        const q = guarded();
        const head = ordinary('ordinary', '雪😀');
        const tail = fixture();
        expect(q.enqueue(head)).toBe('accepted');
        admit(q, tail);
        const before = q.stats();
        const requiredBytes = wireBytes([head]);
        const result = await q.reserveGuarded({ maxBatchBytes: requiredBytes - 1 });
        expect(result).toEqual({ status: 'blocked', requiredBytes });
        expect(Object.hasOwn(result, 'token')).toBe(false);
        expect(q.stats()).toEqual(before);
        const selection = reserved(await q.reserveGuarded({ maxBatchBytes: requiredBytes }));
        expect(selection.eventsJson).toBe(JSON.stringify([head]));
        expect(selection.bytes).toBe(requiredBytes);
        recordReceipt(q, q.commitGuardedNoDrain(selection.token, selection), {
            status: 'committed',
        });
        resume(q);
        await expectQueue(q, [tail.candidate]);
    });

    it('settles a valid guarded blocked head without consuming it', async () => {
        const q = guarded();
        const head = fixture();
        const tail = ordinary('tail', '雪');
        admit(q, head);
        expect(q.enqueue(tail)).toBe('accepted');
        const requiredBytes = wireBytes([head.candidate]);
        const selection = blocked(await q.reserveGuarded({ maxBatchBytes: requiredBytes - 1 }));
        expect(selection.requiredBytes).toBe(requiredBytes);
        expect(await q.reserveGuarded()).toEqual({ status: 'contended' });
        const before = q.stats();
        expect(q.settleBlockedGuardedNoDrain({}, selection)).toEqual({ status: 'stale' });
        expect(q.settleBlockedGuardedNoDrain(selection.token, { ...selection })).toEqual({
            status: 'stale',
        });
        expect(q.stats()).toEqual(before);
        recordReceipt(q, q.settleBlockedGuardedNoDrain(selection.token, selection), {
            status: 'blocked',
            requiredBytes,
        });
        expect(q.stats()).toMatchObject({
            count: 2,
            queueBytes: wireBytes([head.candidate, tail]),
        });
        expect(q.oldestDropCount()).toBe(0n);
        expect(await q.reserveGuarded()).toEqual({ status: 'contended' });
        resume(q);
        await expectQueue(q, [head.candidate, tail]);
    });

    it('releases a valid blocked head and rejects late blocked receipts against a new selection', async () => {
        const q = guarded();
        const head = fixture();
        const tail = ordinary('tail');
        admit(q, head);
        expect(q.enqueue(tail)).toBe('accepted');
        const budget = wireBytes([head.candidate]) - 1;
        const first = blocked(await q.reserveGuarded({ maxBatchBytes: budget }));
        recordReceipt(q, q.releaseGuardedNoDrain(first.token), { status: 'released' });
        expect(q.stats()).toMatchObject({
            count: 2,
            queueBytes: wireBytes([head.candidate, tail]),
        });
        resume(q);
        const second = blocked(await q.reserveGuarded({ maxBatchBytes: budget }));
        expect(second.requiredBytes).toBe(first.requiredBytes);
        expect(second.token).not.toBe(first.token);
        expect(q.settleBlockedGuardedNoDrain(first.token, first)).toEqual({ status: 'stale' });
        expect(q.settleBlockedGuardedNoDrain(second.token, first)).toEqual({ status: 'stale' });
        expect(q.releaseGuardedNoDrain(first.token)).toEqual({ status: 'stale' });
        expect(q.stats()).toMatchObject({
            count: 2,
            queueBytes: wireBytes([head.candidate, tail]),
        });
        expect(q.close()).toBe(true);
        expect(q.settleBlockedGuardedNoDrain(second.token, second)).toEqual({ status: 'stale' });
        expect(q.releaseGuardedNoDrain(second.token)).toEqual({ status: 'stale' });
    });

    it('prunes only an invalid blocked head without reading its getter or deleting the tail', async () => {
        const q = guarded();
        const head = fixture();
        const tailRecall = fixture({ recalledBySelf: true, messageId: -3 });
        const tail = ordinary('尾', '😀');
        admit(q, head);
        admit(q, tailRecall);
        expect(q.enqueue(tail)).toBe('accepted');
        const selection = blocked(
            await q.reserveGuarded({ maxBatchBytes: wireBytes([head.candidate]) - 1 }),
        );
        const getter = vi.fn(() => {
            throw new Error('blocked v11 getter must not run');
        });
        Object.defineProperty(head.event, 'user_id', { configurable: true, get: getter });
        recordReceipt(q, q.settleBlockedGuardedNoDrain(selection.token, selection), {
            status: 'pruned',
            count: 1,
        });
        expect(getter).not.toHaveBeenCalled();
        expect(q.oldestDropCount()).toBe(0n);
        expect(q.stats()).toMatchObject({
            count: 2,
            queueBytes: wireBytes([tailRecall.candidate, tail]),
        });
        resume(q);
        await expectQueue(q, [tailRecall.candidate, tail]);
    });

    it.each(['reserved', 'blocked'] as const)(
        'release after abort and elapsed timeout preserves an invalid %s selection until explicit revalidation',
        async (kind) => {
            const q = guarded();
            const head = fixture();
            const tail = ordinary('tail');
            admit(q, head);
            expect(q.enqueue(tail)).toBe('accepted');
            const controller = new AbortController();
            const result = await q.reserveGuarded({
                timeoutMs: 10,
                signal: controller.signal,
                ...(kind === 'blocked' ? { maxBatchBytes: wireBytes([head.candidate]) - 1 } : {}),
            });
            const selection = kind === 'blocked' ? blocked(result) : reserved(result);
            head.event.message_id = -99;
            await vi.advanceTimersByTimeAsync(20);
            controller.abort();
            recordReceipt(q, q.releaseGuardedNoDrain(selection.token), { status: 'released' });
            expect(q.stats()).toMatchObject({
                count: 2,
                queueBytes: wireBytes([head.candidate, tail]),
            });
            expect(q.oldestDropCount()).toBe(0n);
            resume(q);
            const retry = reserved(await q.reserveGuarded());
            expect(retry.eventsJson).toBe(JSON.stringify([head.candidate, tail]));
            recordReceipt(q, q.commitGuardedNoDrain(retry.token, retry), {
                status: 'pruned',
                count: 1,
            });
            resume(q);
            await expectQueue(q, [tail]);
            expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        },
    );

    it('releases a delayed selection already aborted before its caller resumes, without pruning', async () => {
        const q = guarded();
        const pendingRecall = fixture();
        expect(q.enqueue(ordinary('held'))).toBe('accepted');
        const held = reserved(await q.reserveGuarded());
        const controller = new AbortController();
        const pending = q.reserveGuarded({ timeoutMs: 100, signal: controller.signal });
        admit(q, pendingRecall);
        recordReceipt(q, q.commitGuardedNoDrain(held.token, held), { status: 'committed' });
        resume(q);
        // resume selects synchronously; abort occurs before the waiting caller
        // observes the resolved Promise, and must not turn release into prune.
        pendingRecall.event.message_id = -99;
        controller.abort();
        const selected = reserved(await pending);
        expect(selected.eventsJson).toBe(JSON.stringify([pendingRecall.candidate]));
        recordReceipt(q, q.releaseGuardedNoDrain(selected.token), { status: 'released' });
        expect(q.stats()).toMatchObject({
            count: 1,
            queueBytes: wireBytes([pendingRecall.candidate]),
        });
        resume(q);
        const retry = reserved(await q.reserveGuarded());
        recordReceipt(q, q.commitGuardedNoDrain(retry.token, retry), {
            status: 'pruned',
            count: 1,
        });
        resume(q);
        await expectQueue(q, []);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });

    it('protects the active physical prefix while evicting only the oldest unreserved entries', async () => {
        const q = guarded({ capacity: 4 }, 'drop-oldest');
        const first = ordinary('first');
        const heldRecall = fixture();
        const evicted = ordinary('evicted');
        const retained = fixture({ messageId: -2, recalledBySelf: true });
        const incoming = ordinary('incoming', '雪😀');
        expect(q.enqueue(first)).toBe('accepted');
        admit(q, heldRecall);
        expect(q.enqueue(evicted)).toBe('accepted');
        admit(q, retained);
        const selection = reserved(await q.reserveGuarded({ limit: 2 }));
        expect(q.enqueue(incoming)).toBe('accepted');
        expect(q.oldestDropCount()).toBe(1n);
        expect(q.stats()).toMatchObject({
            count: 4,
            reserved: 2,
            queueBytes: wireBytes([first, heldRecall.candidate, retained.candidate, incoming]),
        });
        expect(selection.eventsJson).toBe(JSON.stringify([first, heldRecall.candidate]));
        recordReceipt(q, q.releaseGuardedNoDrain(selection.token), { status: 'released' });
        resume(q);
        const all = reserved(await q.reserveGuarded());
        expect(all.eventsJson).toBe(
            JSON.stringify([first, heldRecall.candidate, retained.candidate, incoming]),
        );
        const before = q.stats();
        expect(q.enqueue(ordinary('full'))).toBe('full');
        expect(q.stats()).toEqual(before);
        expect(q.oldestDropCount()).toBe(1n);
        recordReceipt(q, q.commitGuardedNoDrain(all.token, all), { status: 'committed' });
        resume(q);
        expect(q.oldestDropCount()).toBe(1n);
    });

    it('keeps an unreserved tail atomically when no eviction can fit beside a protected prefix', async () => {
        const head = fixture();
        const tail = ordinary('tail');
        const incoming = ordinary('larger', '雪😀'.repeat(20));
        const budget = wireBytes([head.candidate, tail]);
        expect(wireBytes([incoming])).toBeLessThanOrEqual(budget);
        expect(wireBytes([head.candidate, incoming])).toBeGreaterThan(budget);
        const q = guarded(
            { capacity: 4, maxQueueBytes: budget, maxEventBytes: budget },
            'drop-oldest',
        );
        admit(q, head);
        expect(q.enqueue(tail)).toBe('accepted');
        const selection = reserved(await q.reserveGuarded({ limit: 1 }));
        const before = q.stats();
        expect(q.enqueue(incoming)).toBe('full');
        expect(q.stats()).toEqual(before);
        expect(q.oldestDropCount()).toBe(0n);
        recordReceipt(q, q.releaseGuardedNoDrain(selection.token), { status: 'released' });
        resume(q);
        const again = reserved(await q.reserveGuarded());
        expect(again.eventsJson).toBe(JSON.stringify([head.candidate, tail]));
        head.event.message_id = -99;
        recordReceipt(q, q.commitGuardedNoDrain(again.token, again), {
            status: 'pruned',
            count: 1,
        });
        resume(q);
        await expectQueue(q, [tail]);
    });

    it('rejects oversize, fabricated/mismatched proofs, cloned DTOs and unproved private-delete bypass without eviction', async () => {
        const q = guarded({ capacity: 2 }, 'drop-oldest');
        const a = fixture();
        const b = fixture({ selfUin: SELF + 1 });
        const item = ordinary('first');
        expect(q.enqueue(item)).toBe('accepted');
        admit(q, a);
        const before = q.stats();
        const clone = { ...a.candidate, self: { ...a.candidate.self } };
        expect(clone).toEqual(a.candidate);
        expect(q.enqueueGuarded(clone, a.proof)).toBe('invalid');
        expect(q.enqueueGuarded(a.candidate, {} as never)).toBe('invalid');
        // This is a proof/DTO mismatch, not a claim of account isolation.
        expect(q.enqueueGuarded(b.candidate, a.proof)).toBe('invalid');
        expect(q.enqueueGuarded(a.candidate, b.proof)).toBe('invalid');
        expect(q.enqueue(a.candidate)).toBe('invalid');
        expect(q.enqueue(clone)).toBe('invalid');
        expect(q.enqueue(ordinary('too-large', '😀'.repeat(4096)))).toBe('oversize');
        expect(q.stats()).toEqual(before);
        expect(q.oldestDropCount()).toBe(0n);
        await expectQueue(q, [item, a.candidate]);
    });

    it('rejects an individually oversize proved recall without dropping an existing entry', async () => {
        const recallEvent = fixture();
        const eventLimit = wireBytes([recallEvent.candidate]) - 1;
        const q = guarded(
            { capacity: 2, maxEventBytes: eventLimit, maxQueueBytes: eventLimit + 128 },
            'drop-oldest',
        );
        const existing = ordinary('existing');
        expect(wireBytes([existing])).toBeLessThanOrEqual(eventLimit);
        expect(q.enqueue(existing)).toBe('accepted');
        const before = q.stats();
        expect(q.enqueueGuarded(recallEvent.candidate, recallEvent.proof)).toBe('oversize');
        expect(q.stats()).toEqual(before);
        expect(q.oldestDropCount()).toBe(0n);
        await expectQueue(q, [existing]);
    });

    it('retains proof per entry across eviction and permits locally valid cross-account pairs without implying owner authentication', async () => {
        const q = guarded({ capacity: 2 }, 'drop-oldest');
        const evicted = fixture();
        const survivor = fixture();
        expect(evicted.candidate).toEqual(survivor.candidate);
        admit(q, evicted);
        admit(q, survivor);
        expect(q.enqueue(ordinary('replacement'))).toBe('accepted');
        expect(q.oldestDropCount()).toBe(1n);
        evicted.event.message_id = -99;
        const selected = reserved(await q.reserveGuarded());
        expect(selected.eventsJson).toBe(
            JSON.stringify([survivor.candidate, ordinary('replacement')]),
        );
        recordReceipt(q, q.commitGuardedNoDrain(selected.token, selected), { status: 'committed' });
        resume(q);

        // The queue validates local candidate/proof consistency, not an owner/account
        // or live epoch. The future owner must make those separate checks.
        const other = fixture({ selfUin: SELF + 1 });
        other.generation.setOnline(false);
        expect(other.generation.isCurrent(other.ticket, other.binding)).toBe(false);
        expect(recall.isPrivateRecallPollProofFor(other.proof, other.candidate)).toBe(true);
        admit(q, other);
        const independent = reserved(await q.reserveGuarded());
        recordReceipt(q, q.commitGuardedNoDrain(independent.token, independent), {
            status: 'committed',
        });
        resume(q);
    });

    it('keeps repeated references as distinct physical entries, without claiming global deduplication', async () => {
        const q = guarded();
        const repeated = fixture();
        const twin = fixture();
        admit(q, repeated);
        admit(q, repeated);
        admit(q, twin);
        const first = reserved(await q.reserveGuarded({ limit: 1 }));
        expect(first.eventsJson).toBe(JSON.stringify([repeated.candidate]));
        recordReceipt(q, q.commitGuardedNoDrain(first.token, first), { status: 'committed' });
        resume(q);
        const rest = reserved(await q.reserveGuarded());
        expect(rest.eventsJson).toBe(JSON.stringify([repeated.candidate, twin.candidate]));
        expect(rest.token).not.toBe(first.token);
        expect(q.commitGuardedNoDrain(first.token, first)).toEqual({ status: 'stale' });
        repeated.event.message_id = -99;
        recordReceipt(q, q.commitGuardedNoDrain(rest.token, rest), { status: 'pruned', count: 1 });
        resume(q);
        await expectQueue(q, [twin.candidate]);
    });

    it('makes old tokens stale after release, re-reservation and close without deleting current entries', async () => {
        const q = guarded();
        const a = fixture();
        const b = ordinary('tail');
        admit(q, a);
        expect(q.enqueue(b)).toBe('accepted');
        const old = reserved(await q.reserveGuarded({ limit: 1 }));
        recordReceipt(q, q.releaseGuardedNoDrain(old.token), { status: 'released' });
        expect(q.releaseGuardedNoDrain(old.token)).toEqual({ status: 'stale' });
        expect(q.commitGuardedNoDrain(old.token, old)).toEqual({ status: 'stale' });
        resume(q);
        const current = reserved(await q.reserveGuarded());
        expect(current.eventsJson).toBe(JSON.stringify([a.candidate, b]));
        expect(current.token).not.toBe(old.token);
        expect(q.commitGuardedNoDrain(old.token, current)).toEqual({ status: 'stale' });
        expect(q.commitGuardedNoDrain(current.token, old)).toEqual({ status: 'stale' });
        expect(q.releaseGuardedNoDrain(old.token)).toEqual({ status: 'stale' });
        expect(q.stats()).toMatchObject({ count: 2, reserved: 2 });
        expect(q.close()).toBe(true);
        expect(q.commitGuardedNoDrain(current.token, current)).toEqual({ status: 'stale' });
        expect(q.releaseGuardedNoDrain(current.token)).toEqual({ status: 'stale' });
        expect(q.stats()).toMatchObject({ count: 0, queueBytes: 2, reserved: 0, closed: true });
    });
});

describe('legacy mode regression in the same in-process fixture', () => {
    it('preserves reject-new, blocked budgets, exact UTF-8 accounting, release and commit', async () => {
        const q = legacy({ capacity: 2 });
        const a = ordinary('A', '雪😀');
        const b = ordinary('B');
        expect(q.enqueue(a)).toBe('accepted');
        expect(q.enqueue(b)).toBe('accepted');
        expect(q.enqueue(ordinary('C'))).toBe('full');
        const requiredBytes = wireBytes([a]);
        expect(await q.reserve({ maxBatchBytes: requiredBytes - 1 })).toEqual({
            status: 'blocked',
            requiredBytes,
        });
        const first = await q.reserve({ limit: 1 });

        if (first.status !== 'reserved') {
            throw new Error(`expected legacy reservation, got ${first.status}`);
        }

        expect(first.eventsJson).toBe(JSON.stringify([a]));
        expect(first.bytes).toBe(requiredBytes);
        expect(q.release(first.token)).toBe(true);
        expect(q.release(first.token)).toBe(false);
        const again = await q.reserve();

        if (again.status !== 'reserved') {
            throw new Error(`expected legacy reservation, got ${again.status}`);
        }

        expect(again.eventsJson).toBe(JSON.stringify([a, b]));
        expect(q.commit(again.token)).toBe(true);
        expect(q.commit(again.token)).toBe(false);
        expect(await q.reserve()).toEqual({ status: 'empty' });
        expect(q.stats()).toMatchObject({ count: 0, queueBytes: 2 });
        expect(q.oldestDropCount()).toBe(0n);
    });

    it('preserves legacy drop-oldest protection, FIFO waiters, timeout and close', async () => {
        const q = legacy({ capacity: 3 }, 'drop-oldest');
        const a = ordinary('A');
        const b = ordinary('B');
        const c = ordinary('C');
        const d = ordinary('D');
        expect(q.enqueue(a)).toBe('accepted');
        expect(q.enqueue(b)).toBe('accepted');
        expect(q.enqueue(c)).toBe('accepted');
        const held = await q.reserve({ limit: 1 });

        if (held.status !== 'reserved') {
            throw new Error(`expected legacy reservation, got ${held.status}`);
        }

        const first = q.reserve({ timeoutMs: 100, limit: 1 });
        const second = q.reserve({ timeoutMs: 100, limit: 1 });
        expect(q.enqueue(d)).toBe('accepted');
        expect(q.oldestDropCount()).toBe(1n);
        expect(await q.reserve()).toEqual({ status: 'contended' });
        expect(q.release(held.token)).toBe(true);
        const r1 = await first;

        if (r1.status !== 'reserved') {
            throw new Error(`expected first legacy waiter, got ${r1.status}`);
        }

        expect(r1.eventsJson).toBe(JSON.stringify([a]));
        expect(q.commit(r1.token)).toBe(true);
        const r2 = await second;

        if (r2.status !== 'reserved') {
            throw new Error(`expected second legacy waiter, got ${r2.status}`);
        }

        expect(r2.eventsJson).toBe(JSON.stringify([c]));
        expect(q.commit(r2.token)).toBe(true);
        const last = await q.reserve();

        if (last.status !== 'reserved') {
            throw new Error(`expected last legacy entry, got ${last.status}`);
        }

        expect(last.eventsJson).toBe(JSON.stringify([d]));
        expect(q.commit(last.token)).toBe(true);
        const timeout = q.reserve({ timeoutMs: 10 });
        await vi.advanceTimersByTimeAsync(10);
        expect(await timeout).toEqual({ status: 'timeout' });
        const pending = q.reserve({ timeoutMs: 100 });
        expect(q.close()).toBe(true);
        expect(await pending).toEqual({ status: 'closed' });
        expect(q.commit(last.token)).toBe(false);
        expect(q.oldestDropCount()).toBe(1n);
    });
});

// These fixtures neither prove production HTTP behavior nor authenticate an
// owner, a real account or an online epoch. No global-GC or RSS bound is asserted.
