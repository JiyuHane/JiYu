import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventPollBuffer, type PollOptions } from '../../src/v12-runtime/event-poll-buffer';
import {
    activateOrderedPollOwner,
    activatePollOwner,
    createPollGate,
    pollOwnerStats,
    registerPollHost,
} from '../../src/v12-runtime/poll-owner';
import {
    PollCoordinator,
    PollTransaction,
    type PollSink,
} from '../../src/v12-runtime/poll-transaction';
import { SourceGeneration } from '../../src/v12-runtime/source-generation';

class Sink extends EventEmitter implements PollSink {
    body = '';
    head = vi.fn();
    writeHead(): void {
        this.head();
    }
    isOpen(): boolean {
        return true;
    }
    end(body: string): void {
        this.body = body;
        this.emit('finish');
    }
}

function fixture() {
    const generation = new SourceGeneration();
    generation.setOnline(true);
    const binding = {};
    const runtime = {};
    const gate = createPollGate();
    registerPollHost(
        runtime,
        {
            self: { platform: 'qq', user_id: '12345' },
            captureBinding: () => binding,
            captureSource: () => generation.capture(binding),
            verify: (source) => generation.isCurrent(source, binding),
        },
        gate,
    );
    return { generation, binding, runtime, gate, source: () => generation.capture(binding)! };
}

function owner(f: ReturnType<typeof fixture>) {
    const result = activateOrderedPollOwner(f.runtime);

    if (result.status !== 'ready') {
        throw new Error(`ordered owner ${result.status}`);
    }

    return result.owner;
}

function request(timeoutMs = 0) {
    return {
        limit: 0,
        timeoutMs,
        maxOutputBytes: 65536,
        responseDeadline: performance.now() + 12000,
    };
}

function event(id: number) {
    return {
        id: `event-${id}`,
        time: 1,
        type: 'message',
        detail_type: 'private',
        sub_type: '',
        self: { platform: 'qq', user_id: '12345' },
        message_id: String(id),
        message: [{ type: 'text', data: { text: 'hello' } }],
        alt_message: 'hello',
        user_id: '23456',
    };
}

async function settle() {
    for (let n = 0; n < 20; n++) {
        await Promise.resolve();
    }
}

async function enqueue(f: ReturnType<typeof fixture>, o: ReturnType<typeof owner>, id: number) {
    const p = o.begin(f.source())!;
    expect(p.child()!.resolve(event(id))).toBe(true);
    expect(p.seal()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('ordered owner token-only poll transactions (pure fakes)', () => {
    it('short empty returns explicit failure without write or token operations', async () => {
        const f = fixture();
        const o = owner(f);
        const sink = new Sink();
        const end = vi.spyOn(sink, 'end');
        const commit = vi.spyOn(EventPollBuffer.prototype, 'commit');
        const release = vi.spyOn(EventPollBuffer.prototype, 'release');
        expect(await o.start(request(), sink).result).toEqual({
            kind: 'empty_unresolved',
            reason: 'empty',
        });
        expect(sink.head).not.toHaveBeenCalled();
        expect(end).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        o.invalidate();
        await settle();
    });
    it('long empty timeout fails explicitly without writing or consuming', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const o = owner(f);
        const sink = new Sink();
        const end = vi.spyOn(sink, 'end');
        const commit = vi.spyOn(EventPollBuffer.prototype, 'commit');
        const release = vi.spyOn(EventPollBuffer.prototype, 'release');
        const task = o.start(request(40), sink).result;
        await settle();
        await vi.advanceTimersByTimeAsync(40);
        expect(await task).toEqual({ kind: 'empty_unresolved', reason: 'timeout' });
        expect(sink.head).not.toHaveBeenCalled();
        expect(end).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        o.invalidate();
        await settle();
    });
    it('an unresolved earlier admitted head never yields successful empty', async () => {
        const f = fixture();
        const o = owner(f);
        const parent = o.begin(f.source())!;
        parent.child();
        parent.seal();
        const sink = new Sink();
        expect(await o.start(request(), sink).result).toEqual({
            kind: 'empty_unresolved',
            reason: 'empty',
        });
        expect(sink.head).not.toHaveBeenCalled();
        o.invalidate();
        await settle();
    });
    it('serves the actual sequence-flushed FIFO with its original order', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const o = owner(f);
        const a = o.begin(f.source())!;
        const ac = a.child()!;
        a.seal();
        const b = o.begin(f.source())!;
        const bc = b.child()!;
        b.seal();
        bc.resolve(event(2));
        await vi.advanceTimersByTimeAsync(0);
        expect(pollOwnerStats(f.runtime)?.accepted).toBe(0);
        ac.resolve(event(1));
        await vi.advanceTimersByTimeAsync(0);
        const sink = new Sink();
        expect(await o.start(request(), sink).result).toEqual({
            kind: 'local_finish',
            response: 'events',
        });
        expect(JSON.parse(sink.body).data).toEqual([event(1), event(2)]);
        o.invalidate();
        await settle();
    });
    it('serves earlier queued event even if later sequencer head is pending', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const o = owner(f);
        await enqueue(f, o, 1);
        const pending = o.begin(f.source())!;
        pending.child();
        pending.seal();
        const sink = new Sink();
        expect(await o.start(request(), sink).result).toEqual({
            kind: 'local_finish',
            response: 'events',
        });
        expect(JSON.parse(sink.body).data).toEqual([event(1)]);
        o.invalidate();
        await settle();
    });
    it('applies limit while preserving the remaining queue', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const o = owner(f);
        await enqueue(f, o, 1);
        await enqueue(f, o, 2);
        const a = new Sink();
        const b = new Sink();
        expect((await o.start({ ...request(), limit: 1 }, a).result).kind).toBe('local_finish');
        expect((await o.start({ ...request(), limit: 1 }, b).result).kind).toBe('local_finish');
        expect(JSON.parse(a.body).data).toEqual([event(1)]);
        expect(JSON.parse(b.body).data).toEqual([event(2)]);
        o.invalidate();
        await settle();
    });
    it('does not let a short poll bypass an older waiter', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const o = owner(f);
        const first = new Sink();
        const short = new Sink();
        const waiting = o.start(request(100), first).result;
        await settle();
        expect(await o.start(request(), short).result).toEqual({ kind: 'contended' });
        await enqueue(f, o, 1);
        expect((await waiting).kind).toBe('local_finish');
        expect(JSON.parse(first.body).data).toEqual([event(1)]);
        expect(short.head).not.toHaveBeenCalled();
        o.invalidate();
        await settle();
    });
    it('a skip does not write empty or wake early; timeout is unresolved', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const o = owner(f);
        const sink = new Sink();
        const task = o.start(request(50), sink).result;
        await settle();
        const p = o.begin(f.source())!;
        p.child()!.skip();
        p.seal();
        await vi.advanceTimersByTimeAsync(0);
        expect(sink.head).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(50);
        expect(await task).toEqual({ kind: 'empty_unresolved', reason: 'timeout' });
        o.invalidate();
        await settle();
    });
    it('gap closes a long waiter promptly without a successful empty', async () => {
        const f = fixture();
        const o = owner(f);
        const sink = new Sink();
        const task = o.start(request(1000), sink).result;
        await settle();
        o.begin(f.source())!.child()!.fail();
        expect((await task).kind).toBe('closed');
        expect(sink.head).not.toHaveBeenCalled();
        await settle();
        expect(pollOwnerStats(f.runtime)?.ordering_gap).toBe(true);
    });
    it('releases a selected token when gap reenters before reserve continuation', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const o = owner(f);
        await enqueue(f, o, 1);
        const original = EventPollBuffer.prototype.reserve;
        let fired = false;
        vi.spyOn(EventPollBuffer.prototype, 'reserve').mockImplementation(function (
            this: EventPollBuffer,
            options: PollOptions,
        ) {
            const result = original.call(this, options);

            if (!fired) {
                fired = true;
                o.begin(f.source())!.child()!.fail();
            }

            return result;
        });
        const release = vi.spyOn(EventPollBuffer.prototype, 'release');
        const commit = vi.spyOn(EventPollBuffer.prototype, 'commit');
        const sink = new Sink();
        const outcome = await o.start(request(), sink).result;
        expect(outcome.kind).toBe('closed');
        expect(release).toHaveBeenCalledOnce();
        expect(commit).not.toHaveBeenCalled();
        expect(sink.head).not.toHaveBeenCalled();
        await settle();
        expect(pollOwnerStats(f.runtime)?.ordering_gap).toBe(true);
    });
    it('records already-consumed loss when gap reenters successful commit', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const o = owner(f);
        await enqueue(f, o, 1);
        const original = EventPollBuffer.prototype.commit;
        vi.spyOn(EventPollBuffer.prototype, 'commit').mockImplementation(function (
            this: EventPollBuffer,
            token: object,
        ) {
            const result = original.call(this, token);
            o.begin(f.source())!.child()!.fail();
            return result;
        });
        const sink = new Sink();
        const result = await o.start(request(), sink).result;
        expect(result.kind).toBe('committed_unsent');
        expect(sink.head).not.toHaveBeenCalled();
        await settle();
        expect(pollOwnerStats(f.runtime)?.postcommit_unknown).toBe(1);
    });
    it('limits simultaneous waiting transactions without writing on busy', async () => {
        const f = fixture();
        const o = owner(f);
        const waiters = Array.from({ length: 8 }, () => o.start(request(1000), new Sink()));
        const sink = new Sink();
        expect(await o.start(request(), sink).result).toEqual({ kind: 'busy' });
        expect(sink.head).not.toHaveBeenCalled();

        for (const waiter of waiters) {
            waiter.cancel();
        }

        const results = await Promise.all(waiters.map((waiter) => waiter.result));
        expect(results.every((result) => result.kind === 'cancelled')).toBe(true);
        o.invalidate();
        await settle();
    });
    it('rejects an invalid trusted empty policy at both constructors', () => {
        const queue = new EventPollBuffer({
            capacity: 1,
            maxQueueBytes: 128,
            maxEventBytes: 128,
            maxWaiters: 1,
            maxTimeoutMs: 100,
        });
        const now = () => performance.now();
        const valid = () => true;
        expect(() => new PollCoordinator(queue, 128, now, valid, 'invalid' as never)).toThrow(
            RangeError,
        );
        expect(
            () =>
                new PollTransaction(
                    queue,
                    128,
                    now,
                    valid,
                    request(),
                    new Sink(),
                    () => true,
                    () => {},
                    'invalid' as never,
                ),
        ).toThrow(RangeError);
        queue.close();
    });
    it('bad pre-reserve output budget is failure, not a successful empty', async () => {
        const f = fixture();
        const o = owner(f);
        const sink = new Sink();
        const result = await o.start({ ...request(), maxOutputBytes: 0 }, sink).result;
        expect(result.kind).toBe('fatal_budget');
        expect(sink.head).not.toHaveBeenCalled();
        o.invalidate();
        await settle();
    });
    it('abort before timeout follows the existing first-wins contract', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const o = owner(f);
        const abort = new AbortController();
        const sink = new Sink();
        const pending = o.start({ ...request(50), externalAbortSignal: abort.signal }, sink).result;
        await settle();
        abort.abort();
        await vi.advanceTimersByTimeAsync(50);
        expect((await pending).kind).toBe('aborted');
        expect(sink.head).not.toHaveBeenCalled();
        o.invalidate();
        await settle();
    });
    it('timeout selected before later abort remains unresolved', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const o = owner(f);
        const abort = new AbortController();
        const sink = new Sink();
        const pending = o.start({ ...request(50), externalAbortSignal: abort.signal }, sink).result;
        await settle();
        await vi.advanceTimersByTimeAsync(50);
        const outcome = await pending;
        abort.abort();
        expect(outcome).toEqual({ kind: 'empty_unresolved', reason: 'timeout' });
        expect(sink.head).not.toHaveBeenCalled();
        o.invalidate();
        await settle();
    });
    it('records sticky gap when isOpen invalidates after commit with no earlier gap', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const o = owner(f);
        await enqueue(f, o, 1);
        let committed = false;
        const original = EventPollBuffer.prototype.commit;
        const commit = vi.spyOn(EventPollBuffer.prototype, 'commit').mockImplementation(function (
            this: EventPollBuffer,
            token: object,
        ) {
            const result = original.call(this, token);
            committed = result;
            return result;
        });
        const sink = new Sink();
        const end = vi.spyOn(sink, 'end');
        let sawNoGap = false;

        sink.isOpen = () => {
            if (committed) {
                committed = false;
                sawNoGap = pollOwnerStats(f.runtime)?.ordering_gap === false;
                o.invalidate();
            }

            return true;
        };

        expect((await o.start(request(), sink).result).kind).toBe('committed_unsent');
        await settle();
        expect(sawNoGap).toBe(true);
        expect(commit).toHaveBeenCalledOnce();
        expect(sink.head).not.toHaveBeenCalled();
        expect(end).not.toHaveBeenCalled();
        expect(pollOwnerStats(f.runtime)?.ordering_reason).toBe('committed_unsent');
        expect(activateOrderedPollOwner(f.runtime).status).toBe('degraded');
        expect(activatePollOwner(f.runtime).status).toBe('degraded');
        f.generation.setOnline(false);
        f.generation.setOnline(true);
        const replacement = owner(f);
        const retry = new Sink();
        expect(await replacement.start(request(), retry).result).toEqual({
            kind: 'empty_unresolved',
            reason: 'empty',
        });
        expect(commit).toHaveBeenCalledOnce();
        replacement.invalidate();
        await settle();
    });
    it('local finish does not itself create a delivery gap', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const o = owner(f);
        await enqueue(f, o, 1);
        const sink = new Sink();
        expect((await o.start(request(), sink).result).kind).toBe('local_finish');
        await settle();
        expect(pollOwnerStats(f.runtime)?.ordering_gap).toBe(false);
        o.invalidate();
        await settle();
    });
    it('unknown after end error creates delivery_unknown without redelivery', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const o = owner(f);
        await enqueue(f, o, 1);
        const sink = new Sink();

        sink.end = () => {
            throw new Error('fake end failure');
        };

        expect(await o.start(request(), sink).result).toEqual({ kind: 'unknown', committed: true });
        await settle();
        expect(pollOwnerStats(f.runtime)?.ordering_reason).toBe('delivery_unknown');
        expect(activateOrderedPollOwner(f.runtime).status).toBe('degraded');
        expect(activatePollOwner(f.runtime).status).toBe('degraded');
    });
    it('stale original claim at unknown outcome locks gate uncertain', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const o = owner(f);
        await enqueue(f, o, 1);
        const sink = new Sink();
        const otherClaim = {};

        sink.end = () => {
            f.gate.claim = otherClaim;
            throw new Error('fake end failure');
        };

        expect((await o.start(request(), sink).result).kind).toBe('unknown');
        await settle();
        expect(f.gate.uncertain).toBe(true);
        expect(f.gate.claim).toBe(otherClaim);
        expect(pollOwnerStats(f.runtime)?.cleanup_uncertain).toBe(true);
        expect(activateOrderedPollOwner(f.runtime).status).toBe('cleanup_pending');
    });
    it('legacy coordinator still writes a successful empty response', async () => {
        const f = fixture();
        const activation = activatePollOwner(f.runtime);

        if (activation.status !== 'ready') {
            throw new Error('legacy unavailable');
        }

        const sink = new Sink();
        expect(await activation.owner.start(request(), sink).result).toEqual({
            kind: 'local_finish',
            response: 'empty',
            reason: 'empty',
        });
        expect(JSON.parse(sink.body).data).toEqual([]);
        activation.owner.invalidate();
        await settle();
    });
});
