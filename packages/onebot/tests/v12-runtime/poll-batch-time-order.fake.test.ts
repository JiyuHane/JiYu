import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    EventPollBuffer as BufferInstance,
    PollOptions,
} from '../../src/v12-runtime/event-poll-buffer';
import type { PollQueue, PollRequest, PollSink } from '../../src/v12-runtime/poll-transaction';

// Import the two source modules only after the local network/native guards are armed.
// No runtime owner, transport, account, plugin, or actual socket is constructed.
let EventPollBuffer: typeof import('../../src/v12-runtime/event-poll-buffer').EventPollBuffer;
let PollCoordinator: typeof import('../../src/v12-runtime/poll-transaction').PollCoordinator;
let guards: Array<{ mock: { calls: unknown[] } }>;
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;

function forbidden(): never {
    throw new Error('unexpected network or native operation in poll fixture');
}

beforeEach(async () => {
    vi.useFakeTimers();
    fetchGuard = vi.fn(forbidden);
    webSocketGuard = vi.fn(function ForbiddenWebSocket() {
        return forbidden();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    guards = [
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
    ];
    ({ EventPollBuffer } = await import('../../src/v12-runtime/event-poll-buffer'));
    ({ PollCoordinator } = await import('../../src/v12-runtime/poll-transaction'));
});

afterEach(() => {
    const calls = guards.map((guard) => guard.mock.calls.length);
    const fetchCalls = fetchGuard.mock.calls.length;
    const webSocketCalls = webSocketGuard.mock.calls.length;
    const timerCount = vi.getTimerCount();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    expect(calls).toEqual(calls.map(() => 0));
    expect(fetchCalls).toBe(0);
    expect(webSocketCalls).toBe(0);
    expect(timerCount).toBe(0);
});

const config = {
    capacity: 16,
    maxQueueBytes: 8192,
    maxEventBytes: 4096,
    maxWaiters: 4,
    maxTimeoutMs: 1000,
};

type BatchOrder = 'fifo' | 'event-time';
type EmptyPolicy = 'legacy' | 'unavailable';

class MemorySink extends EventEmitter implements PollSink {
    body: string | undefined;
    headCalls = 0;
    endCalls = 0;
    openCheck?: () => void;

    isOpen(): boolean {
        this.openCheck?.();
        return true;
    }

    writeHead(): void {
        this.headCalls++;
    }

    end(body: string): void {
        this.endCalls++;
        this.body = body;
        // The real transaction observes finish after end has started, and only
        // completes the synchronous-finish path once end has returned.
        this.emit('finish');
    }
}

function event(id: string, time: number) {
    return { type: 'message', id, time };
}

function buffer(...events: unknown[]): BufferInstance {
    const queue = new EventPollBuffer(config);

    for (const value of events) {
        expect(queue.enqueue(value)).toBe('accepted');
    }

    return queue;
}

function tracked(queue: BufferInstance, select?: PollQueue['reserve']) {
    const reserve = vi.fn((options: PollOptions) =>
        select ? select(options) : queue.reserve(options),
    );
    const commit = vi.fn((token: object) => queue.commit(token));
    const release = vi.fn((token: object) => queue.release(token));
    const pollQueue: PollQueue = { reserve, commit, release };
    return { pollQueue, reserve, commit, release };
}

function coordinator(
    queue: PollQueue,
    order: BatchOrder = 'event-time',
    emptyPolicy: EmptyPolicy = 'legacy',
) {
    // This synthetic millisecond clock and the response deadline share one scale.
    return new PollCoordinator(
        queue,
        config.maxQueueBytes,
        () => 0,
        () => true,
        emptyPolicy,
        order,
    );
}

function request(overrides: Partial<PollRequest> = {}): PollRequest {
    return {
        limit: 0,
        timeoutMs: 0,
        maxOutputBytes: config.maxQueueBytes,
        responseDeadline: 10_000,
        ...overrides,
    };
}

function response(data: unknown[], echo?: string): string {
    return JSON.stringify({
        status: 'ok',
        retcode: 0,
        data,
        message: '',
        ...(echo === undefined ? {} : { echo }),
    });
}

function rawResponse(eventsJson: string, echo?: string): string {
    return `{"status":"ok","retcode":0,"data":${eventsJson},"message":""${
        echo === undefined ? '' : `,"echo":${JSON.stringify(echo)}`
    }}`;
}

function payload(sink: MemorySink): unknown {
    expect(sink.body).toBeDefined();

    if (sink.body === undefined) {
        throw new Error('expected a synchronous in-memory response');
    }

    return JSON.parse(sink.body);
}

async function peekFifo(queue: BufferInstance): Promise<unknown[]> {
    const selected = await queue.reserve({ limit: 0, timeoutMs: 0 });

    if (selected.status !== 'reserved') {
        throw new Error(`expected FIFO reservation, got ${selected.status}`);
    }

    const events: unknown[] = JSON.parse(selected.eventsJson);
    expect(queue.release(selected.token)).toBe(true);
    return events;
}

describe('poll event-time batches with an in-memory queue and sink', () => {
    it('sorts a reverse-time batch without changing event payloads', async () => {
        const a = event('A', 30);
        const b = event('B', 20);
        const c = event('C', 10);
        const q = buffer(a, b, c);
        const calls = tracked(q);
        const sink = new MemorySink();
        const req = request();
        expect(await coordinator(calls.pollQueue).create(req, sink).run()).toEqual({
            kind: 'local_finish',
            response: 'events',
        });
        expect(payload(sink)).toEqual(JSON.parse(response([c, b, a])));
        expect(Buffer.byteLength(sink.body!, 'utf8')).toBeLessThanOrEqual(req.maxOutputBytes);
        expect(calls.commit).toHaveBeenCalledTimes(1);
        expect(calls.release).not.toHaveBeenCalled();
        expect(q.stats()).toMatchObject({ count: 0, reserved: 0, waiters: 0 });
    });

    it('stably preserves FIFO within several equal-time groups and compares fractional times', async () => {
        const a = event('A', 10.5);
        const b = event('B', 2.25);
        const c = event('C', 10.5);
        const d = event('D', 2.25);
        const e = event('E', 2.125);
        const f = event('F', 2.25);
        const q = buffer(a, b, c, d, e, f);
        const sink = new MemorySink();
        const req = request();
        expect(await coordinator(q).create(req, sink).run()).toEqual({
            kind: 'local_finish',
            response: 'events',
        });
        expect(payload(sink)).toEqual(JSON.parse(response([e, b, d, f, a, c])));
        expect(Buffer.byteLength(sink.body!, 'utf8')).toBeLessThanOrEqual(req.maxOutputBytes);
    });

    it.each(['default', 'fifo'] as const)(
        'keeps the original FIFO ordering with %s policy',
        async (mode) => {
            const a = event('A', 30);
            const b = event('B', 10);
            const c = event('C', 20);
            // Legacy FIFO accepts the buffer's existing non-meta shapes even
            // when time is absent; event-time validation must not change that.
            const d = { type: 'message', id: 'D' };
            const q = buffer(a, b, c, d);
            const sink = new MemorySink();
            const owner =
                mode === 'default'
                    ? new PollCoordinator(
                          q,
                          config.maxQueueBytes,
                          () => 0,
                          () => true,
                      )
                    : coordinator(q, 'fifo');
            expect(await owner.create(request(), sink).run()).toEqual({
                kind: 'local_finish',
                response: 'events',
            });
            expect(payload(sink)).toEqual(JSON.parse(response([a, b, c, d])));
            expect(q.stats()).toMatchObject({ count: 0, reserved: 0 });
        },
    );

    it('selects the FIFO limit prefix, then sorts it and commits exactly that prefix', async () => {
        const a = event('A', 30);
        const b = event('B', 10);
        const c = event('C', 20);
        const q = buffer(a, b, c);
        const calls = tracked(q);
        const owner = coordinator(calls.pollQueue);
        const first = new MemorySink();
        expect(await owner.create(request({ limit: 2 }), first).run()).toEqual({
            kind: 'local_finish',
            response: 'events',
        });
        expect(payload(first)).toEqual(JSON.parse(response([b, a])));
        expect(calls.commit).toHaveBeenCalledTimes(1);
        expect(calls.release).not.toHaveBeenCalled();
        expect(q.stats()).toMatchObject({ count: 1, reserved: 0 });
        expect(await peekFifo(q)).toEqual([c]);
        const next = new MemorySink();
        expect(await owner.create(request(), next).run()).toEqual({
            kind: 'local_finish',
            response: 'events',
        });
        expect(payload(next)).toEqual(JSON.parse(response([c])));
        expect(q.stats()).toMatchObject({ count: 0, reserved: 0 });
    });

    it('applies the exact UTF-8 response budget to the FIFO prefix before sorting', async () => {
        const a = {
            ...event('A', 30.5),
            content: { text: '雪😀\n"\\', list: [{ time: 999, text: '第一' }, null, false] },
        };
        const b = {
            ...event('B', 10.25),
            content: { text: '羽🪶', list: [{ time: -3, text: '第二' }, true] },
        };
        const c = event('C', 1);
        const echo = '回声😀\n"\\\ud800';
        const q = buffer(a, b, c);
        const calls = tracked(q);
        const sink = new MemorySink();
        const expectedBody = response([b, a], echo);
        const maxOutputBytes = Buffer.byteLength(expectedBody, 'utf8');
        expect(Buffer.byteLength(response([a, b, c], echo), 'utf8')).toBeGreaterThan(
            maxOutputBytes,
        );
        expect(
            await coordinator(calls.pollQueue)
                .create(request({ echo, maxOutputBytes }), sink)
                .run(),
        ).toEqual({ kind: 'local_finish', response: 'events' });
        expect(sink.body).toBe(expectedBody);
        expect(payload(sink)).toEqual({
            status: 'ok',
            retcode: 0,
            data: [b, a],
            message: '',
            echo,
        });
        expect(Buffer.byteLength(sink.body!, 'utf8')).toBe(maxOutputBytes);
        expect(calls.commit).toHaveBeenCalledTimes(1);
        expect(calls.release).not.toHaveBeenCalled();
        expect(q.stats()).toMatchObject({ count: 1, reserved: 0 });
        expect(await peekFifo(q)).toEqual([c]);
    });

    it('does not claim that a one-item prefix contains the globally oldest queued event', async () => {
        const a = event('A', 30);
        const b = event('B', 10);
        const q = buffer(a, b);
        const owner = coordinator(q);
        const first = new MemorySink();
        expect(await owner.create(request({ limit: 1 }), first).run()).toEqual({
            kind: 'local_finish',
            response: 'events',
        });
        expect(payload(first)).toEqual(JSON.parse(response([a])));
        expect(await peekFifo(q)).toEqual([b]);
        const second = new MemorySink();
        expect((await owner.create(request({ limit: 1 }), second).run()).kind).toBe('local_finish');
        expect(payload(second)).toEqual(JSON.parse(response([b])));
    });

    it('releases a prepared reservation on abort and retains the exact FIFO sequence', async () => {
        const a = event('A', 30);
        const b = event('B', 10);
        const c = event('C', 20);
        const q = buffer(a, b, c);
        const abort = new AbortController();
        let selected = false;
        let checksAfterSelection = 0;
        const calls = tracked(q, (options) => {
            const result = q.reserve(options);
            selected = true;
            return result;
        });
        const sink = new MemorySink();

        sink.openCheck = () => {
            if (selected && ++checksAfterSelection === 2) {
                abort.abort();
            }
        };

        expect(
            await coordinator(calls.pollQueue)
                .create(request({ limit: 2, externalAbortSignal: abort.signal }), sink)
                .run(),
        ).toEqual({ kind: 'aborted' });
        expect(checksAfterSelection).toBe(2);
        expect(calls.commit).not.toHaveBeenCalled();
        expect(calls.release).toHaveBeenCalledTimes(1);
        expect(sink.headCalls).toBe(0);
        expect(sink.endCalls).toBe(0);
        expect(q.stats()).toMatchObject({ count: 3, reserved: 0 });
        expect(await peekFifo(q)).toEqual([a, b, c]);
    });

    it('keeps release independent of the returned sorted representation', async () => {
        const a = event('A', 30);
        const b = event('B', 10);
        const c = event('C', 20);
        const q = buffer(a, b, c);
        const reservation = await q.reserve({ limit: 2 });

        if (reservation.status !== 'reserved') {
            throw new Error('expected FIFO prefix');
        }

        expect(JSON.parse(reservation.eventsJson)).toEqual([a, b]);
        expect(q.release(reservation.token)).toBe(true);
        expect(await peekFifo(q)).toEqual([a, b, c]);
        const sink = new MemorySink();
        expect(
            (
                await coordinator(q)
                    .create(request({ limit: 2 }), sink)
                    .run()
            ).kind,
        ).toBe('local_finish');
        expect(payload(sink)).toEqual(JSON.parse(response([b, a])));
        expect(await peekFifo(q)).toEqual([c]);
    });

    it('does not enqueue meta events or include them in a sorted response', async () => {
        const a = event('A', 9);
        const b = event('B', 2);
        const q = buffer(a);
        expect(q.enqueue({ type: 'meta', id: 'ignored', time: 0 })).toBe('meta');
        expect(q.enqueue(b)).toBe('accepted');
        expect(q.stats()).toMatchObject({ count: 2, reserved: 0 });
        const sink = new MemorySink();
        expect((await coordinator(q).create(request(), sink).run()).kind).toBe('local_finish');
        expect(payload(sink)).toEqual(JSON.parse(response([b, a])));
        expect(q.stats()).toMatchObject({ count: 0, reserved: 0 });
    });

    it.each(['legacy', 'unavailable'] as const)(
        'preserves the %s empty policy under event-time ordering',
        async (policy) => {
            const q = buffer();
            const calls = tracked(q);
            const sink = new MemorySink();
            const outcome = await coordinator(calls.pollQueue, 'event-time', policy)
                .create(request({ echo: '空😀' }), sink)
                .run();
            expect(outcome).toEqual(
                policy === 'legacy'
                    ? { kind: 'local_finish', response: 'empty', reason: 'empty' }
                    : { kind: 'empty_unresolved', reason: 'empty' },
            );

            if (policy === 'legacy') {
                expect(sink.body).toBe(response([], '空😀'));
            } else {
                expect(sink.headCalls).toBe(0);
                expect(sink.endCalls).toBe(0);
            }

            expect(calls.commit).not.toHaveBeenCalled();
            expect(calls.release).not.toHaveBeenCalled();
            expect(q.stats()).toMatchObject({ count: 0, reserved: 0, waiters: 0 });
        },
    );

    it('leaves a timed-out empty response unchanged', async () => {
        const q = buffer();
        const calls = tracked(q);
        const sink = new MemorySink();
        const task = coordinator(calls.pollQueue)
            .create(request({ timeoutMs: 20 }), sink)
            .run();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(20);
        expect(await task).toEqual({ kind: 'local_finish', response: 'empty', reason: 'timeout' });
        expect(sink.body).toBe(response([]));
        expect(calls.commit).not.toHaveBeenCalled();
        expect(calls.release).not.toHaveBeenCalled();
        expect(q.stats()).toMatchObject({ count: 0, reserved: 0, waiters: 0 });
    });

    it('leaves an over-budget FIFO head queued without a write', async () => {
        const a = { ...event('A', 30), text: '雪😀' };
        const b = event('B', 1);
        const q = buffer(a, b);
        const calls = tracked(q);
        const sink = new MemorySink();
        const tooSmall = Buffer.byteLength(response([a]), 'utf8') - 1;
        expect(
            await coordinator(calls.pollQueue)
                .create(request({ maxOutputBytes: tooSmall }), sink)
                .run(),
        ).toEqual({ kind: 'blocked' });
        expect(calls.commit).not.toHaveBeenCalled();
        expect(calls.release).not.toHaveBeenCalled();
        expect(sink.headCalls).toBe(0);
        expect(sink.endCalls).toBe(0);
        expect(await peekFifo(q)).toEqual([a, b]);
    });

    it.each([
        ['missing', 'pair'],
        ['nan-as-null', 'pair'],
        ['string', 'pair'],
        ['missing', 'single'],
        ['nan-as-null', 'single'],
    ] as const)(
        'releases a fake %s-time reservation in a %s batch before fallback',
        async (mode, size) => {
            const a = event('A', 30);
            const b = event('B', 10);
            const source = size === 'single' ? [b] : [a, b];
            const q = buffer(...source);
            const bad =
                mode === 'missing'
                    ? { type: 'message', id: 'bad' }
                    : { type: 'message', id: 'bad', time: mode === 'nan-as-null' ? NaN : '10' };
            const eventsJson = JSON.stringify(size === 'single' ? [bad] : [a, bad]);

            if (mode === 'nan-as-null') {
                expect(JSON.parse(eventsJson).at(-1).time).toBeNull();
            }

            const calls = tracked(q, async (options) => {
                const selected = await q.reserve(options);
                return selected.status === 'reserved'
                    ? { ...selected, eventsJson, bytes: Buffer.byteLength(eventsJson, 'utf8') }
                    : selected;
            });
            const sink = new MemorySink();
            const req = request({ echo: '回声' });
            expect(await coordinator(calls.pollQueue).create(req, sink).run()).toEqual({
                kind: 'local_finish',
                response: 'fallback',
            });
            expect(payload(sink)).toMatchObject({
                status: 'failed',
                retcode: 20001,
                data: null,
                echo: '回声',
            });
            expect(Buffer.byteLength(sink.body!, 'utf8')).toBeLessThanOrEqual(req.maxOutputBytes);
            expect(calls.commit).not.toHaveBeenCalled();
            expect(calls.release).toHaveBeenCalledTimes(1);
            expect(q.stats()).toMatchObject({ count: source.length, reserved: 0 });
            expect(await peekFifo(q)).toEqual(source);
        },
    );

    it('releases before reporting fatal budget when even fallback does not fit', async () => {
        const a = event('A', 30);
        const q = buffer(a);
        const eventsJson = JSON.stringify([{ type: 'message', id: 'A' }]);
        const calls = tracked(q, async (options) => {
            const selected = await q.reserve(options);
            return selected.status === 'reserved'
                ? { ...selected, eventsJson, bytes: Buffer.byteLength(eventsJson, 'utf8') }
                : selected;
        });
        const sink = new MemorySink();
        const req = request({ maxOutputBytes: Buffer.byteLength(response([a]), 'utf8') });
        expect(await coordinator(calls.pollQueue).create(req, sink).run()).toEqual({
            kind: 'fatal_budget',
        });
        expect(calls.commit).not.toHaveBeenCalled();
        expect(calls.release).toHaveBeenCalledTimes(1);
        expect(sink.headCalls).toBe(0);
        expect(sink.endCalls).toBe(0);
        expect(q.stats()).toMatchObject({ count: 1, reserved: 0 });
        expect(await peekFifo(q)).toEqual([a]);
    });

    it('releases a fake reservation that itself exceeds the selected array budget', async () => {
        const a = event('A', 30);
        const b = event('B', 10);
        const q = buffer(a, b);
        const eventsJson = JSON.stringify([a, { ...b, content: 'x'.repeat(512) }]);
        const calls = tracked(q, async (options) => {
            const selected = await q.reserve(options);
            expect(Buffer.byteLength(eventsJson, 'utf8')).toBeGreaterThan(options.maxBatchBytes!);
            return selected.status === 'reserved'
                ? { ...selected, eventsJson, bytes: Buffer.byteLength(eventsJson, 'utf8') }
                : selected;
        });
        const sink = new MemorySink();
        const req = request({ maxOutputBytes: 220 });
        expect(await coordinator(calls.pollQueue).create(req, sink).run()).toEqual({
            kind: 'local_finish',
            response: 'fallback',
        });
        expect(payload(sink)).toMatchObject({ status: 'failed', retcode: 20001, data: null });
        expect(Buffer.byteLength(sink.body!, 'utf8')).toBeLessThanOrEqual(req.maxOutputBytes);
        expect(calls.commit).not.toHaveBeenCalled();
        expect(calls.release).toHaveBeenCalledTimes(1);
        expect(q.stats()).toMatchObject({ count: 2, reserved: 0 });
        expect(await peekFifo(q)).toEqual([a, b]);
    });

    it.each(['fits-reencoded', 'only-fits-original'] as const)(
        'checks actual response bytes after array re-encoding: %s',
        async (mode) => {
            const a = {
                ...event('A', 30.5),
                content: { amount: 10000000, text: '雪😀'.repeat(50), values: [null, true, '羽'] },
            };
            const b = { ...event('B', 10.25), content: { nested: { time: 999, text: '原样' } } };
            const echo = 'echo-🐇';
            const q = buffer(a, b);
            // Both encodings parse to exactly the same values. 1e7 is shorter than
            // JSON.stringify's 10000000, so response re-encoding can expand it.
            const original = JSON.stringify([a, b]).replace('10000000', '1e7');
            expect(JSON.parse(original)).toEqual([a, b]);
            const originalBody = rawResponse(original, echo);
            const sortedBody = response([b, a], echo);
            const originalBytes = Buffer.byteLength(originalBody, 'utf8');
            const sortedBytes = Buffer.byteLength(sortedBody, 'utf8');
            expect(sortedBytes).toBeGreaterThan(originalBytes);
            const calls = tracked(q, async (options) => {
                // This fake exposes compact, valid JSON while its backing queue
                // retains the same values in the ordinary JSON representation.
                const selected = await q.reserve({
                    ...options,
                    maxBatchBytes: config.maxQueueBytes,
                });
                expect(Buffer.byteLength(original, 'utf8')).toBeLessThanOrEqual(
                    options.maxBatchBytes!,
                );
                return selected.status === 'reserved'
                    ? {
                          ...selected,
                          eventsJson: original,
                          bytes: Buffer.byteLength(original, 'utf8'),
                      }
                    : selected;
            });
            const sink = new MemorySink();
            const req = request({
                echo,
                maxOutputBytes: mode === 'fits-reencoded' ? sortedBytes : originalBytes,
            });
            const outcome = await coordinator(calls.pollQueue).create(req, sink).run();

            if (outcome.kind === 'local_finish' && outcome.response === 'events') {
                // A serializer that preserves the compact numeric encoding can
                // legitimately fit the smaller budget; the actual body decides.
                expect(payload(sink)).toEqual(JSON.parse(response([b, a], echo)));
                expect(calls.commit).toHaveBeenCalledTimes(1);
                expect(calls.release).not.toHaveBeenCalled();
                expect(q.stats()).toMatchObject({ count: 0, reserved: 0 });
            } else {
                // If re-encoding expands the candidate past the budget, the
                // reservation must be released before the fallback is written.
                expect(mode).toBe('only-fits-original');
                expect(outcome).toEqual({ kind: 'local_finish', response: 'fallback' });
                expect(payload(sink)).toMatchObject({
                    status: 'failed',
                    retcode: 20001,
                    data: null,
                    echo,
                });
                expect(calls.commit).not.toHaveBeenCalled();
                expect(calls.release).toHaveBeenCalledTimes(1);
                expect(q.stats()).toMatchObject({ count: 2, reserved: 0 });
                expect(await peekFifo(q)).toEqual([a, b]);
            }

            expect(Buffer.byteLength(sink.body!, 'utf8')).toBeLessThanOrEqual(req.maxOutputBytes);
        },
    );
});
