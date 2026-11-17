import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import { getEventListeners } from 'node:events';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    EventPollBuffer as BufferInstance,
    PollBufferConfig,
    PollResult,
} from '../../src/v12-runtime/event-poll-buffer';

// Only the buffer is imported at runtime, after the effects guards are installed.
// Events, timers and AbortControllers are synthetic and remain in this process.
let EventPollBuffer: typeof import('../../src/v12-runtime/event-poll-buffer').EventPollBuffer;
let guards: Array<{ mock: { calls: unknown[] } }> = [];
const buffers: BufferInstance[] = [];

function forbidden(): never {
    throw new Error('unexpected network, native or child-process operation in poll fixture');
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
    ({ EventPollBuffer } = await import('../../src/v12-runtime/event-poll-buffer'));
});

afterEach(() => {
    for (const buffer of buffers) {
        buffer.close();
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
    capacity: 4,
    maxQueueBytes: 2048,
    maxEventBytes: 2048,
    maxWaiters: 8,
    maxTimeoutMs: 1000,
};

type Policy = 'reject-new' | 'drop-oldest';
type Event = { type: string; id: string; text: string };

function event(id: string, text = ''): Event {
    return { type: 'message', id, text };
}

function wireBytes(events: unknown[]): number {
    return Buffer.byteLength(JSON.stringify(events), 'utf8');
}

function queue(overrides: Partial<PollBufferConfig> = {}, policy?: Policy): BufferInstance {
    const config = { ...defaults, ...overrides };
    const result =
        policy === undefined ? new EventPollBuffer(config) : new EventPollBuffer(config, policy);
    buffers.push(result);
    return result;
}

function reserved(result: PollResult): Extract<PollResult, { status: 'reserved' }> {
    if (result.status !== 'reserved') {
        throw new Error(`expected reservation, got ${result.status}`);
    }

    return result;
}

async function expectQueue(q: BufferInstance, expected: Event[]): Promise<void> {
    expect(q.stats().count).toBe(expected.length);
    expect(q.stats().queueBytes).toBe(wireBytes(expected));

    if (expected.length === 0) {
        expect(await q.reserve()).toEqual({ status: 'empty' });
        return;
    }

    const selection = reserved(await q.reserve());
    expect(selection.eventsJson).toBe(JSON.stringify(expected));
    expect(selection.count).toBe(expected.length);
    expect(selection.bytes).toBe(wireBytes(expected));
    expect(q.release(selection.token)).toBe(true);
}

describe('drop-oldest poll buffer with synthetic in-memory events', () => {
    it.each(['default', 'reject-new'] as const)(
        'keeps legacy reject-new behavior for %s policy at the count limit',
        async (mode) => {
            const q = queue({ capacity: 2 }, mode === 'default' ? undefined : mode);
            const a = event('A');
            const b = event('B');
            const c = event('C');
            expect(q.oldestDropCount()).toBe(0n);
            expect(q.enqueue(a)).toBe('accepted');
            expect(q.enqueue(b)).toBe('accepted');
            const before = q.stats();
            expect(q.enqueue(c)).toBe('full');
            expect(q.stats()).toEqual(before);
            expect(q.oldestDropCount()).toBe(0n);
            await expectQueue(q, [a, b]);
            const first = reserved(await q.reserve({ limit: 1 }));
            expect(first.eventsJson).toBe(JSON.stringify([a]));
            expect(q.commit(first.token)).toBe(true);
            expect(q.enqueue(c)).toBe('accepted');
            expect(q.oldestDropCount()).toBe(0n);
            await expectQueue(q, [b, c]);
        },
    );

    it.each(['default', 'reject-new'] as const)(
        'keeps legacy reject-new behavior for %s policy at the byte limit',
        async (mode) => {
            const a = event('A', '雪😀');
            const b = event('B', '羽😀');
            const limit = wireBytes([a, b]) - 1;
            expect(wireBytes([a])).toBeLessThanOrEqual(limit);
            expect(wireBytes([b])).toBeLessThanOrEqual(limit);
            const q = queue(
                { capacity: 4, maxQueueBytes: limit, maxEventBytes: limit },
                mode === 'default' ? undefined : mode,
            );
            expect(q.enqueue(a)).toBe('accepted');
            const before = q.stats();
            expect(q.enqueue(b)).toBe('full');
            expect(q.stats()).toEqual(before);
            expect(q.oldestDropCount()).toBe(0n);
            await expectQueue(q, [a]);
        },
    );

    it.each([1, 2, 3])('evicts exactly one oldest entry at capacity %i', async (capacity) => {
        const q = queue({ capacity }, 'drop-oldest');
        const inputs = ['A', 'B', 'C', 'D', 'E'].map((id) => event(id));

        for (let index = 0; index < inputs.length; index++) {
            expect(q.enqueue(inputs[index])).toBe('accepted');
            const expected = inputs.slice(Math.max(0, index + 1 - capacity), index + 1);
            expect(q.stats().count).toBe(expected.length);
            expect(q.stats().queueBytes).toBe(wireBytes(expected));
            expect(q.oldestDropCount()).toBe(BigInt(Math.max(0, index + 1 - capacity)));
        }

        const remaining = inputs.slice(-capacity);
        const first = reserved(await q.reserve({ limit: 1 }));
        expect(first.eventsJson).toBe(JSON.stringify(remaining.slice(0, 1)));
        expect(q.commit(first.token)).toBe(true);
        await expectQueue(q, remaining.slice(1));
        expect(q.oldestDropCount()).toBe(BigInt(inputs.length - capacity));
    });

    it('charges UTF-8 array brackets and the comma at the exact byte boundary', async () => {
        const a = event('A', '雪😀');
        const b = event('B', '羽😀');
        const c = event('C', '星😀');
        const limit = wireBytes([a, b]);
        expect(wireBytes([b, c])).toBe(limit);
        expect(wireBytes([a, b, c])).toBeGreaterThan(limit);
        expect(limit).toBe(
            Buffer.byteLength(JSON.stringify(a), 'utf8') +
                Buffer.byteLength(JSON.stringify(b), 'utf8') +
                3,
        );
        expect(Buffer.byteLength(JSON.stringify([a, b]), 'utf8')).toBeGreaterThan(
            JSON.stringify([a, b]).length,
        );

        const exact = queue(
            { capacity: 4, maxQueueBytes: limit, maxEventBytes: limit },
            'drop-oldest',
        );
        expect(exact.enqueue(a)).toBe('accepted');
        expect(exact.enqueue(b)).toBe('accepted');
        expect(exact.stats().queueBytes).toBe(limit);
        expect(exact.oldestDropCount()).toBe(0n);
        expect(exact.enqueue(c)).toBe('accepted');
        expect(exact.oldestDropCount()).toBe(1n);
        await expectQueue(exact, [b, c]);

        const short = queue(
            { capacity: 4, maxQueueBytes: limit - 1, maxEventBytes: limit - 1 },
            'drop-oldest',
        );
        expect(short.enqueue(a)).toBe('accepted');
        expect(short.enqueue(b)).toBe('accepted');
        expect(short.oldestDropCount()).toBe(1n);
        await expectQueue(short, [b]);
    });

    it('finds the minimal two-item prefix to evict for a Unicode and escaped payload', async () => {
        const a = event('A', '雪');
        const b = event('B', '😀');
        const c = event('C', '羽');
        const d = event('D', '雪😀\n"\\'.repeat(20));
        const limit = wireBytes([c, d]);
        expect(wireBytes([a, b, c])).toBeLessThanOrEqual(limit);
        expect(wireBytes([a, b, c, d])).toBeGreaterThan(limit);
        expect(wireBytes([b, c, d])).toBeGreaterThan(limit);
        expect(wireBytes([c, d])).toBe(limit);
        const q = queue({ capacity: 8, maxQueueBytes: limit, maxEventBytes: limit }, 'drop-oldest');
        expect(q.enqueue(a)).toBe('accepted');
        expect(q.enqueue(b)).toBe('accepted');
        expect(q.enqueue(c)).toBe('accepted');
        expect(q.oldestDropCount()).toBe(0n);
        expect(q.enqueue(d)).toBe('accepted');
        expect(q.oldestDropCount()).toBe(2n);
        expect(q.stats().queueBytes).toBe(limit);
        await expectQueue(q, [c, d]);
        expect(q.oldestDropCount()).toBe(2n);
    });

    it('never evicts on invalid, meta or individually oversize input', async () => {
        const a = event('A');
        const b = event('B');
        const c = event('C');
        const d = event('D');
        const q = queue(
            { capacity: 2, maxQueueBytes: wireBytes([a, b]), maxEventBytes: wireBytes([a]) },
            'drop-oldest',
        );
        expect(q.enqueue(a)).toBe('accepted');
        expect(q.enqueue(b)).toBe('accepted');
        expect(q.enqueue(c)).toBe('accepted');
        expect(q.oldestDropCount()).toBe(1n);
        const before = q.stats();

        for (const [input, outcome] of [
            [null, 'invalid'],
            [{}, 'invalid'],
            [{ type: 'meta' }, 'meta'],
            [event('Z', '雪😀'.repeat(100)), 'oversize'],
        ] as const) {
            expect(q.enqueue(input)).toBe(outcome);
            expect(q.stats()).toEqual(before);
            expect(q.oldestDropCount()).toBe(1n);
        }

        await expectQueue(q, [b, c]);
        expect(q.enqueue(d)).toBe('accepted');
        expect(q.oldestDropCount()).toBe(2n);
        await expectQueue(q, [c, d]);
    });

    it.each(['commit', 'release'] as const)(
        'protects an active prefix and preserves the correct FIFO after %s',
        async (action) => {
            const q = queue({ capacity: 3 }, 'drop-oldest');
            const a = event('A');
            const b = event('B');
            const c = event('C');
            const d = event('D');

            for (const input of [a, b, c]) {
                expect(q.enqueue(input)).toBe('accepted');
            }

            const hold = reserved(await q.reserve({ limit: 2 }));
            expect(hold.eventsJson).toBe(JSON.stringify([a, b]));
            expect(q.enqueue(d)).toBe('accepted');
            expect(q.oldestDropCount()).toBe(1n);
            expect(q.stats()).toMatchObject({
                count: 3,
                reserved: 2,
                queueBytes: wireBytes([a, b, d]),
            });
            expect(hold.eventsJson).toBe(JSON.stringify([a, b]));
            expect(q[action](hold.token)).toBe(true);
            expect(q.commit(hold.token)).toBe(false);
            expect(q.release(hold.token)).toBe(false);
            await expectQueue(q, action === 'commit' ? [d] : [a, b, d]);
            expect(q.oldestDropCount()).toBe(1n);
        },
    );

    it('evicts the minimum unreserved suffix prefix to meet a byte budget', async () => {
        const a = event('A', 'held');
        const b = event('B', '雪');
        const c = event('C', '羽');
        const d = event('D', '😀'.repeat(40));
        const limit = wireBytes([a, d]);
        expect(wireBytes([a, b, c])).toBeLessThanOrEqual(limit);
        expect(wireBytes([a, b, c, d])).toBeGreaterThan(limit);
        expect(wireBytes([a, c, d])).toBeGreaterThan(limit);
        const q = queue({ capacity: 5, maxQueueBytes: limit, maxEventBytes: limit }, 'drop-oldest');

        for (const input of [a, b, c]) {
            expect(q.enqueue(input)).toBe('accepted');
        }

        const hold = reserved(await q.reserve({ limit: 1 }));
        expect(q.enqueue(d)).toBe('accepted');
        expect(q.oldestDropCount()).toBe(2n);
        expect(q.stats()).toMatchObject({ count: 2, reserved: 1, queueBytes: limit });
        expect(q.release(hold.token)).toBe(true);
        await expectQueue(q, [a, d]);
    });

    it('leaves a fully reserved queue and its accumulated count unchanged on full', async () => {
        const q = queue({ capacity: 2 }, 'drop-oldest');
        const a = event('A');
        const b = event('B');
        const c = event('C');
        expect(q.enqueue(a)).toBe('accepted');
        expect(q.enqueue(b)).toBe('accepted');
        expect(q.enqueue(c)).toBe('accepted');
        expect(q.oldestDropCount()).toBe(1n);
        const hold = reserved(await q.reserve());
        expect(hold.eventsJson).toBe(JSON.stringify([b, c]));
        const before = q.stats();
        expect(q.enqueue(event('D'))).toBe('full');
        expect(q.stats()).toEqual(before);
        expect(q.oldestDropCount()).toBe(1n);
        expect(q.release(hold.token)).toBe(true);
        await expectQueue(q, [b, c]);
    });

    it('keeps every tail entry atomically when even removing all tails cannot fit', async () => {
        const z = event('Z');
        const a = event('A', 'a'.repeat(36));
        const b = event('B');
        const c = event('C');
        const d = event('D', 'd'.repeat(50));
        const limit = wireBytes([a, b, c]);
        expect(wireBytes([z, a, b])).toBeLessThanOrEqual(limit);
        expect(wireBytes([z, a, b, c])).toBeGreaterThan(limit);
        expect(wireBytes([d])).toBeLessThanOrEqual(limit);
        expect(wireBytes([a, d])).toBeGreaterThan(limit);
        const q = queue({ capacity: 4, maxQueueBytes: limit, maxEventBytes: limit }, 'drop-oldest');

        for (const input of [z, a, b, c]) {
            expect(q.enqueue(input)).toBe('accepted');
        }

        expect(q.oldestDropCount()).toBe(1n);
        const hold = reserved(await q.reserve({ limit: 1 }));
        expect(hold.eventsJson).toBe(JSON.stringify([a]));
        const before = q.stats();
        expect(q.enqueue(d)).toBe('full');
        expect(q.stats()).toEqual(before);
        expect(q.oldestDropCount()).toBe(1n);
        expect(q.release(hold.token)).toBe(true);
        await expectQueue(q, [a, b, c]);
    });

    it('keeps queue and watermark unchanged when replacement preparation throws', async () => {
        const q = queue({ capacity: 2 }, 'drop-oldest');
        const a = event('A');
        const b = event('B');
        const c = event('C');
        const d = event('D');
        expect(q.enqueue(a)).toBe('accepted');
        expect(q.enqueue(b)).toBe('accepted');
        expect(q.enqueue(c)).toBe('accepted');
        expect(q.oldestDropCount()).toBe(1n);
        const before = q.stats();
        const failure = new Error('synthetic replacement preparation failure');

        // Instrument just this fixture's backing array, not Array.prototype.
        const backing = (q as unknown as { queue: unknown[] }).queue;
        const slice = vi.spyOn(backing, 'slice').mockImplementationOnce(() => {
            throw failure;
        });

        try {
            expect(() => q.enqueue(d)).toThrow(failure);
            expect(slice).toHaveBeenCalledTimes(1);
        } finally {
            slice.mockRestore();
        }

        expect(q.stats()).toEqual(before);
        expect(q.oldestDropCount()).toBe(1n);
        await expectQueue(q, [b, c]);
        expect(q.enqueue(d)).toBe('accepted');
        expect(q.oldestDropCount()).toBe(2n);
        await expectQueue(q, [c, d]);
    });

    it('still reports a too-large unreserved head as blocked after an eviction', async () => {
        const q = queue({ capacity: 2 }, 'drop-oldest');
        const a = event('A');
        const b = event('B', '雪😀'.repeat(5));
        const c = event('C');
        expect(q.enqueue(a)).toBe('accepted');
        expect(q.enqueue(b)).toBe('accepted');
        expect(q.enqueue(c)).toBe('accepted');
        expect(q.oldestDropCount()).toBe(1n);
        const before = q.stats();
        const requiredBytes = wireBytes([b]);
        expect(await q.reserve({ maxBatchBytes: requiredBytes - 1 })).toEqual({
            status: 'blocked',
            requiredBytes,
        });
        expect(q.stats()).toEqual(before);
        expect(q.oldestDropCount()).toBe(1n);
        await expectQueue(q, [b, c]);
    });

    it('preserves waiter FIFO, abort/timeout/close cleanup, and protected drops', async () => {
        const q = queue({ capacity: 3 }, 'drop-oldest');
        const a = event('A');
        const b = event('B');
        const c = event('C');
        const d = event('D');

        for (const input of [a, b, c]) {
            expect(q.enqueue(input)).toBe('accepted');
        }

        const hold = reserved(await q.reserve({ limit: 2 }));
        const controllers = Array.from({ length: 5 }, () => new AbortController());
        const first = q.reserve({ limit: 1, timeoutMs: 100, signal: controllers[0].signal });
        const second = q.reserve({ limit: 1, timeoutMs: 100, signal: controllers[1].signal });
        const third = q.reserve({ limit: 1, timeoutMs: 100, signal: controllers[2].signal });
        expect(q.stats().waiters).toBe(3);
        expect(vi.getTimerCount()).toBe(3);
        expect(q.enqueue(d)).toBe('accepted');
        expect(q.oldestDropCount()).toBe(1n);
        expect(await q.reserve()).toEqual({ status: 'contended' });
        controllers[0].abort();
        expect(await first).toEqual({ status: 'aborted' });
        expect(getEventListeners(controllers[0].signal, 'abort')).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(2);
        expect(q.release(hold.token)).toBe(true);
        const secondResult = reserved(await second);
        expect(secondResult.eventsJson).toBe(JSON.stringify([a]));
        expect(getEventListeners(controllers[1].signal, 'abort')).toHaveLength(0);
        controllers[1].abort();
        expect(q.stats().reserved).toBe(1);
        expect(q.commit(secondResult.token)).toBe(true);
        const thirdResult = reserved(await third);
        expect(thirdResult.eventsJson).toBe(JSON.stringify([b]));
        expect(getEventListeners(controllers[2].signal, 'abort')).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);

        const fourth = q.reserve({ timeoutMs: 10, signal: controllers[3].signal });
        const fifth = q.reserve({ timeoutMs: 20, signal: controllers[4].signal });
        expect(q.stats().waiters).toBe(2);
        expect(vi.getTimerCount()).toBe(2);
        await vi.advanceTimersByTimeAsync(10);
        expect(await fourth).toEqual({ status: 'timeout' });
        expect(getEventListeners(controllers[3].signal, 'abort')).toHaveLength(0);
        expect(q.stats().waiters).toBe(1);
        expect(vi.getTimerCount()).toBe(1);
        expect(q.close()).toBe(true);
        expect(await fifth).toEqual({ status: 'closed' });
        expect(getEventListeners(controllers[4].signal, 'abort')).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(q.commit(thirdResult.token)).toBe(false);
        expect(q.enqueue(event('E'))).toBe('closed');
        expect(q.oldestDropCount()).toBe(1n);
    });

    it('serves a blocked older waiter before a later waiter without losing the head', async () => {
        const q = queue({ capacity: 2 }, 'drop-oldest');
        const a = event('A', '雪😀');
        const b = event('B');
        const c = event('C');
        expect(q.enqueue(a)).toBe('accepted');
        expect(q.enqueue(b)).toBe('accepted');
        const hold = reserved(await q.reserve({ limit: 1 }));
        const requiredBytes = wireBytes([a]);
        const small = q.reserve({ timeoutMs: 100, maxBatchBytes: requiredBytes - 1 });
        const large = q.reserve({ timeoutMs: 100 });
        expect(q.enqueue(c)).toBe('accepted');
        expect(q.oldestDropCount()).toBe(1n);
        expect(q.release(hold.token)).toBe(true);
        expect(await small).toEqual({ status: 'blocked', requiredBytes });
        const next = reserved(await large);
        expect(next.eventsJson).toBe(JSON.stringify([a, c]));
        expect(q.commit(next.token)).toBe(true);
        expect(q.oldestDropCount()).toBe(1n);
        expect(vi.getTimerCount()).toBe(0);
        await expectQueue(q, []);
    });

    it('records a committed drop before an actual drain throws', async () => {
        const q = queue({ capacity: 1 }, 'drop-oldest');
        const a = event('A');
        const b = event('B');
        expect(q.enqueue(a)).toBe('accepted');
        const hold = reserved(await q.reserve());
        const controller = new AbortController();
        const pending = q.reserve({ timeoutMs: 100, signal: controller.signal });
        expect(q.stats()).toMatchObject({ count: 1, reserved: 1, waiters: 1 });

        // Keep the queued waiter pending when releasing; the following enqueue
        // invokes the real drain, where its first clock read is made to fail.
        const deferred = vi.spyOn(q as unknown as { drain: () => void }, 'drain');
        deferred.mockImplementationOnce(() => {});

        try {
            expect(q.release(hold.token)).toBe(true);
        } finally {
            deferred.mockRestore();
        }

        expect(q.stats()).toMatchObject({ count: 1, reserved: 0, waiters: 1 });
        const failure = new Error('synthetic drain clock failure');
        const clock = vi.spyOn(performance, 'now').mockImplementationOnce(() => {
            throw failure;
        });

        try {
            expect(() => q.enqueue(b)).toThrow(failure);
        } finally {
            clock.mockRestore();
        }

        expect(q.oldestDropCount()).toBe(1n);
        expect(q.stats()).toMatchObject({ count: 1, reserved: 0, waiters: 1 });
        expect(q.stats().queueBytes).toBe(wireBytes([b]));
        controller.abort();
        expect(await pending).toEqual({ status: 'aborted' });
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
        await expectQueue(q, [b]);
        expect(q.oldestDropCount()).toBe(1n);
    });
});
