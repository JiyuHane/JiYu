import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    EventPollBuffer,
    type PollBufferConfig,
    type PollResult,
} from '../../src/v12-runtime/event-poll-buffer';

const config: PollBufferConfig = {
    capacity: 4,
    maxQueueBytes: 512,
    maxEventBytes: 256,
    maxWaiters: 3,
    maxTimeoutMs: 1000,
};
const event = (id: number, extra: Record<string, unknown> = {}) => ({
    type: 'message',
    id,
    ...extra,
});

function reserved(result: PollResult): Extract<PollResult, { status: 'reserved' }> {
    if (result.status !== 'reserved') {
        throw new Error(`expected reservation: ${result.status}`);
    }

    return result;
}

afterEach(() => vi.useRealTimers());

describe('offline event poll buffer', () => {
    it('reserves old to new, commits only the prefix, and detects stale tokens', async () => {
        const q = new EventPollBuffer(config);
        expect(q.enqueue(event(1))).toBe('accepted');
        expect(q.enqueue(event(2))).toBe('accepted');
        expect(q.enqueue(event(3))).toBe('accepted');
        const first = reserved(await q.reserve({ limit: 2 }));
        expect(JSON.parse(first.eventsJson)).toEqual([event(1), event(2)]);
        expect(first.count).toBe(2);
        expect(first.bytes).toBe(Buffer.byteLength(first.eventsJson));
        expect(q.stats().reserved).toBe(2);
        expect(q.commit({})).toBe(false);
        expect(q.commit(first.token)).toBe(true);
        expect(q.commit(first.token)).toBe(false);
        expect(q.release(first.token)).toBe(false);
        expect(q.stats().count).toBe(1);
        const last = reserved(await q.reserve());
        expect(JSON.parse(last.eventsJson)).toEqual([event(3)]);
        expect(q.commit(last.token)).toBe(true);
        expect(await q.reserve()).toEqual({ status: 'empty' });
        expect(q.stats().queueBytes).toBe(2);
    });

    it('release preserves prefix and active reservations count against both limits', async () => {
        const q = new EventPollBuffer({ ...config, capacity: 2 });
        q.enqueue(event(1));
        q.enqueue(event(2));
        const r = reserved(await q.reserve({ limit: 1 }));
        expect(q.enqueue(event(3))).toBe('full');
        expect(q.stats().count).toBe(2);
        expect(q.release(r.token)).toBe(true);
        expect(q.release(r.token)).toBe(false);
        const again = reserved(await q.reserve());
        expect(JSON.parse(again.eventsJson)).toEqual([event(1), event(2)]);
        expect(q.commit(again.token)).toBe(true);
        expect(q.enqueue(event(3))).toBe('accepted');
    });

    it('isolates source and consumers through immutable serialized snapshots', async () => {
        const q = new EventPollBuffer(config);
        const original = event(1, { nested: { data: ['x'] } });
        expect(q.enqueue(original)).toBe('accepted');
        original.nested.data[0] = 'changed';
        const first = reserved(await q.reserve());
        const data = JSON.parse(first.eventsJson);
        data[0].nested.data[0] = 'polluted';
        expect(q.release(first.token)).toBe(true);
        const second = reserved(await q.reserve());
        expect(JSON.parse(second.eventsJson)[0].nested.data).toEqual(['x']);
        expect(second.eventsJson).toBe(first.eventsJson);
        expect(q.stats().queueBytes).toBe(second.bytes);
    });

    it('bounds batches, blocks a large head without loss, and permits a larger budget', async () => {
        const q = new EventPollBuffer(config);
        q.enqueue(event(1, { text: 'abcdef' }));
        q.enqueue(event(2));
        const needed = Buffer.byteLength(JSON.stringify([event(1, { text: 'abcdef' })]));
        expect(await q.reserve({ maxBatchBytes: needed - 1 })).toEqual({
            status: 'blocked',
            requiredBytes: needed,
        });
        expect(q.stats().count).toBe(2);
        const r = reserved(await q.reserve({ maxBatchBytes: needed }));
        expect(r.count).toBe(1);
        expect(r.bytes).toBe(needed);
        expect(q.commit(r.token)).toBe(true);
        expect(reserved(await q.reserve()).count).toBe(1);
    });

    it('honors byte and count capacity with reject-new and delimiters', async () => {
        const one = Buffer.byteLength(JSON.stringify(event(1)));
        const q = new EventPollBuffer({
            ...config,
            maxEventBytes: one + 2,
            maxQueueBytes: one * 2 + 2,
        });
        expect(q.enqueue(event(1))).toBe('accepted');
        expect(q.stats().queueBytes).toBe(one + 2);
        expect(q.enqueue(event(2))).toBe('full');
        expect(q.stats().count).toBe(1);
        expect(q.enqueue(event(3, { text: 'a' }))).toBe('oversize');
        expect(JSON.parse(reserved(await q.reserve()).eventsJson)).toEqual([event(1)]);
    });

    it('rejects invalid JSON shapes without invoking accessors, proxies, or toJSON', () => {
        const q = new EventPollBuffer(config);
        const getter = vi.fn(() => 1);
        const proxyTrap = vi.fn(() => []);
        const toJSON = vi.fn(() => 'bad');
        const cyclic: Record<string, unknown> = event(1);
        cyclic.loop = cyclic;
        const sparse = new Array(2);
        sparse[1] = 3;
        const symbol = { ...event(1), [Symbol('s')]: 1 };

        for (const value of [
            null,
            [],
            {},
            event(1, { bad: NaN }),
            event(1, { bad: Infinity }),
            event(1, { bad: Number.MAX_SAFE_INTEGER + 1 }),
            event(1, { bad: undefined }),
            event(1, { bad: cyclic }),
            event(1, { bad: sparse }),
            symbol,
            Object.assign(Object.create({ x: 1 }), event(1)),
            event(1, { toJSON }),
            new Proxy(event(1), { ownKeys: proxyTrap }),
            event(1, { bad: new Proxy({}, { ownKeys: proxyTrap }) }),
            Object.defineProperty(event(1), 'secret', { enumerable: true, get: getter }),
        ]) {
            expect(q.enqueue(value)).toBe('invalid');
        }

        expect(getter).not.toHaveBeenCalled();
        expect(proxyTrap).not.toHaveBeenCalled();
        expect(toJSON).not.toHaveBeenCalled();
        expect(q.enqueue({ type: 'meta' })).toBe('meta');
        expect(q.stats().count).toBe(0);
    });

    it('bounds string bytes, depth, nodes and escaped wire size', () => {
        const q = new EventPollBuffer({ ...config, maxEventBytes: 100 });
        expect(q.enqueue(event(1, { text: '😀'.repeat(30) }))).toBe('oversize');
        expect(q.enqueue(event(1, { text: '\n'.repeat(70) }))).toBe('oversize');
        let deep: unknown = 0;

        for (let i = 0; i < 35; i++) {
            deep = { x: deep };
        }

        expect(q.enqueue(event(1, { deep }))).toBe('oversize');
        expect(q.enqueue(event(1, { list: Array.from({ length: 8193 }, () => 0) }))).toBe(
            'oversize',
        );
        expect(q.enqueue(event(1, { text: 'é' }))).toBe('accepted');
    });

    it('serves waiters FIFO and prevents short-poll bypass', async () => {
        vi.useFakeTimers();
        const q = new EventPollBuffer(config);
        const a = q.reserve({ timeoutMs: 100 });
        const b = q.reserve({ timeoutMs: 100 });
        expect(q.stats().waiters).toBe(2);
        q.enqueue(event(1));
        const first = reserved(await a);
        q.enqueue(event(2));
        expect(await q.reserve()).toEqual({ status: 'empty' });
        expect(q.release(first.token)).toBe(true);
        const second = reserved(await b);
        expect(JSON.parse(second.eventsJson)).toEqual([event(1), event(2)]);
        expect(q.stats().waiters).toBe(0);
        expect(q.commit(second.token)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('enforces max waiters, timeout and automatic cleanup', async () => {
        vi.useFakeTimers();
        const q = new EventPollBuffer({ ...config, maxWaiters: 1 });
        const first = q.reserve({ timeoutMs: 10 });
        expect(await q.reserve({ timeoutMs: 10 })).toEqual({ status: 'busy' });
        expect(q.stats().waiters).toBe(1);
        await vi.advanceTimersByTimeAsync(10);
        expect(await first).toEqual({ status: 'timeout' });
        expect(q.stats().waiters).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(await q.reserve()).toEqual({ status: 'empty' });
    });

    it('handles abort before/during wait and ignores abort after reservation', async () => {
        vi.useFakeTimers();
        const q = new EventPollBuffer(config);
        const a = new AbortController();
        a.abort();
        expect(await q.reserve({ signal: a.signal, timeoutMs: 10 })).toEqual({ status: 'aborted' });
        const b = new AbortController();
        const pending = q.reserve({ signal: b.signal, timeoutMs: 10 });
        b.abort();
        expect(await pending).toEqual({ status: 'aborted' });
        expect(q.stats().waiters).toBe(0);
        const c = new AbortController();
        const next = q.reserve({ signal: c.signal, timeoutMs: 10 });
        q.enqueue(event(1));
        const r = reserved(await next);
        c.abort();
        await vi.advanceTimersByTimeAsync(100);
        expect(q.stats().reserved).toBe(1);
        expect(q.commit(r.token)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('determines same-tick abort, timeout and enqueue winners without stealing', async () => {
        vi.useFakeTimers();
        const q = new EventPollBuffer(config);
        const a = new AbortController();
        const p = q.reserve({ timeoutMs: 10, signal: a.signal });
        a.abort();
        q.enqueue(event(1));
        expect(await p).toEqual({ status: 'aborted' });
        const r = reserved(await q.reserve());
        expect(q.commit(r.token)).toBe(true);
        const b = new AbortController();
        const p2 = q.reserve({ timeoutMs: 10, signal: b.signal });
        await vi.advanceTimersByTimeAsync(10);
        b.abort();
        q.enqueue(event(2));
        expect(await p2).toEqual({ status: 'timeout' });
        expect(JSON.parse(reserved(await q.reserve()).eventsJson)).toEqual([event(2)]);
    });

    it('prefers an elapsed deadline when an earlier abort listener enqueues synchronously', async () => {
        vi.useFakeTimers();
        let clock = 0;
        const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);

        try {
            const q = new EventPollBuffer(config);
            const controller = new AbortController();
            controller.signal.addEventListener('abort', () => {
                expect(q.enqueue(event(42))).toBe('accepted');
            });
            const pending = q.reserve({ timeoutMs: 10, signal: controller.signal });
            expect(vi.getTimerCount()).toBe(1);
            clock = 10;
            controller.abort();
            expect(await pending).toEqual({ status: 'timeout' });
            expect(vi.getTimerCount()).toBe(0);
            expect(q.stats().count).toBe(1);
            expect(JSON.parse(reserved(await q.reserve()).eventsJson)).toEqual([event(42)]);
        } finally {
            now.mockRestore();
        }
    });

    it('fits short array elements without charging non-wire indexes, but counts escaped bytes', async () => {
        const item = event(1, { list: Array.from({ length: 500 }, () => 0) });
        const bytes = Buffer.byteLength(JSON.stringify([item]));
        const q = new EventPollBuffer({ ...config, maxQueueBytes: bytes, maxEventBytes: bytes });
        expect(q.enqueue(item)).toBe('accepted');
        expect(q.stats().queueBytes).toBe(bytes);
        const r = reserved(await q.reserve());
        expect(r.bytes).toBe(bytes);
        expect(JSON.parse(r.eventsJson)).toEqual([item]);
        const escaped = event(2, { text: '😀\n'.repeat(20) });
        const escapedBytes = Buffer.byteLength(JSON.stringify([escaped]));
        const tight = new EventPollBuffer({
            ...config,
            maxQueueBytes: escapedBytes - 1,
            maxEventBytes: escapedBytes - 1,
        });
        expect(tight.enqueue(escaped)).toBe('oversize');
        expect(tight.stats().count).toBe(0);
    });

    it('close clears data, invalidates token and wakes every waiter', async () => {
        vi.useFakeTimers();
        const q = new EventPollBuffer(config);
        q.enqueue(event(1));
        const r = reserved(await q.reserve());
        const a = q.reserve({ timeoutMs: 10 });
        const b = q.reserve({ timeoutMs: 10 });
        expect(q.close()).toBe(true);
        expect(q.close()).toBe(false);
        expect(await a).toEqual({ status: 'closed' });
        expect(await b).toEqual({ status: 'closed' });
        expect(q.commit(r.token)).toBe(false);
        expect(q.release(r.token)).toBe(false);
        expect(q.enqueue(event(2))).toBe('closed');
        expect(await q.reserve()).toEqual({ status: 'closed' });
        expect(q.stats()).toEqual({
            count: 0,
            queueBytes: 2,
            reserved: 0,
            waiters: 0,
            closed: true,
        });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps separate account buffers independent', async () => {
        const a = new EventPollBuffer(config);
        const b = new EventPollBuffer(config);
        a.enqueue(event(1));
        b.enqueue(event(2));
        const ra = reserved(await a.reserve());
        const rb = reserved(await b.reserve());
        expect(a.commit(rb.token)).toBe(false);
        expect(JSON.parse(ra.eventsJson)).toEqual([event(1)]);
        expect(JSON.parse(rb.eventsJson)).toEqual([event(2)]);
        expect(a.close()).toBe(true);
        expect(b.commit(rb.token)).toBe(true);
    });

    it('validates hard caps and request arguments without evaluating getters', async () => {
        for (const patch of [
            { capacity: 0 },
            { capacity: 10001 },
            { maxWaiters: 0 },
            { maxWaiters: 1025 },
            { maxTimeoutMs: 3600001 },
            { maxEventBytes: 1048577 },
            { maxQueueBytes: 1 },
            { maxEventBytes: 513 },
            { capacity: 1.1 },
            { capacity: Infinity },
        ]) {
            expect(() => new EventPollBuffer({ ...config, ...patch })).toThrow();
        }

        const q = new EventPollBuffer(config);

        for (const options of [
            { limit: -1 },
            { limit: 0.5 },
            { timeoutMs: 1001 },
            { maxBatchBytes: 1 },
            { maxBatchBytes: 513 },
            { signal: {} },
            { signal: new Proxy(new AbortController().signal, {}) },
            { extra: 1 },
        ]) {
            expect(await q.reserve(options as never)).toEqual({ status: 'invalid' });
        }

        const getter = vi.fn(() => 1);
        expect(
            await q.reserve(Object.defineProperty({}, 'limit', { enumerable: true, get: getter })),
        ).toEqual({ status: 'invalid' });
        expect(getter).not.toHaveBeenCalled();
        expect(q.stats().waiters).toBe(0);
    });

    it('does not expire active reservations and times out queued polls', async () => {
        vi.useFakeTimers();
        const q = new EventPollBuffer(config);
        q.enqueue(event(1));
        const r = reserved(await q.reserve({ timeoutMs: 10 }));
        const pending = q.reserve({ timeoutMs: 20 });
        await vi.advanceTimersByTimeAsync(25);
        expect(await pending).toEqual({ status: 'timeout' });
        expect(q.stats().reserved).toBe(1);
        expect(q.release(r.token)).toBe(true);
        expect(reserved(await q.reserve()).count).toBe(1);
    });

    it('keeps UTF-8, escaping, ordinary __proto__ and JSON number semantics', async () => {
        const item = JSON.parse(
            '{"type":"message","__proto__":{"x":1},"text":"😀\\n","time":1632847927.599013,"n":-0}',
        );
        const bytes = Buffer.byteLength(JSON.stringify([item]));
        const q = new EventPollBuffer({ ...config, maxEventBytes: bytes, maxQueueBytes: bytes });
        expect(q.enqueue(item)).toBe('accepted');
        expect(q.stats().queueBytes).toBe(bytes);
        expect(await q.reserve({ maxBatchBytes: bytes - 1 })).toEqual({
            status: 'blocked',
            requiredBytes: bytes,
        });
        const r = reserved(await q.reserve());
        expect(r.bytes).toBe(bytes);
        const result = JSON.parse(r.eventsJson)[0];
        expect(Object.hasOwn(result, '__proto__')).toBe(true);
        expect(result.__proto__).toEqual({ x: 1 });
        expect(result.text).toBe('😀\n');
        expect(result.time).toBe(1632847927.599013);
        expect(Object.is(result.n, -0)).toBe(false);
    });

    it('removes native listeners for abort, reservation, timeout and close', async () => {
        vi.useFakeTimers();

        for (const reason of ['abort', 'reservation', 'timeout', 'close'] as const) {
            const q = new EventPollBuffer(config);
            const controller = new AbortController();
            const before = getEventListeners(controller.signal, 'abort').length;
            const pending = q.reserve({ timeoutMs: 20, signal: controller.signal });
            expect(getEventListeners(controller.signal, 'abort').length).toBe(before + 1);

            if (reason === 'abort') {
                controller.abort();
            }

            if (reason === 'reservation') {
                q.enqueue(event(1));
            }

            if (reason === 'timeout') {
                await vi.advanceTimersByTimeAsync(20);
            }

            if (reason === 'close') {
                q.close();
            }

            expect((await pending).status).toBe(
                reason === 'reservation'
                    ? 'reserved'
                    : reason === 'abort'
                      ? 'aborted'
                      : reason === 'close'
                        ? 'closed'
                        : 'timeout',
            );
            expect(getEventListeners(controller.signal, 'abort').length).toBe(before);
            expect(vi.getTimerCount()).toBe(0);
        }
    });

    it('rejects forged signal getters and handles stopped abort propagation', async () => {
        const q = new EventPollBuffer(config);
        const overridden = new AbortController();
        const getter = vi.fn(() => false);
        Object.defineProperty(overridden.signal, 'aborted', { get: getter });
        expect(await q.reserve({ signal: overridden.signal, timeoutMs: 10 })).toEqual({
            status: 'invalid',
        });
        expect(getter).not.toHaveBeenCalled();
        const controller = new AbortController();
        controller.signal.addEventListener('abort', (e) => e.stopImmediatePropagation());
        const pending = q.reserve({ signal: controller.signal, timeoutMs: 100 });
        controller.abort();
        expect(await pending).toEqual({ status: 'aborted' });
        expect(q.stats().waiters).toBe(0);
    });

    it('uses an actual timer for a waiting empty poll', async () => {
        const q = new EventPollBuffer(config);
        const begin = performance.now();
        expect(await q.reserve({ timeoutMs: 15 })).toEqual({ status: 'timeout' });
        expect(performance.now() - begin).toBeGreaterThanOrEqual(8);
        expect(q.stats().waiters).toBe(0);
    });
});
