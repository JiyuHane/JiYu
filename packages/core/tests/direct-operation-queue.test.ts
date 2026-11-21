import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectOperationQueue, DirectQueueError } from '../src/direct/operation-queue';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((ok, fail) => {
        resolve = ok;
        reject = fail;
    });
    return { promise, resolve, reject };
}

describe('direct account operation queue', () => {
    beforeEach(() => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'performance'],
        });
    });
    afterEach(() => vi.useRealTimers());

    it('leaves the push callback stack and runs one call at a time', async () => {
        const queue = new DirectOperationQueue();
        const gate = deferred<number>();
        const firstWork = vi.fn(() => gate.promise);
        const secondWork = vi.fn(async () => 2);
        const first = queue.enqueue({ timeoutMs: 1000, cost: 9 }, firstWork);
        const second = queue.enqueue({ timeoutMs: 1000, cost: 7 }, secondWork);
        expect(firstWork).not.toHaveBeenCalled();
        expect(secondWork).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(0);
        expect(firstWork).toHaveBeenCalledTimes(1);
        expect(secondWork).not.toHaveBeenCalled();
        expect(queue.size).toBe(2);
        expect(queue.retainedBytes).toBe(16);
        gate.resolve(1);
        await expect(first).resolves.toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(second).resolves.toBe(2);
        expect(secondWork).toHaveBeenCalledTimes(1);
        expect(queue.size).toBe(0);
        expect(queue.retainedBytes).toBe(0);
        await queue.close();
    });

    it('subtracts queue waiting from the original deadline', async () => {
        const queue = new DirectOperationQueue();
        const gate = deferred<void>();
        const first = queue.enqueue({ timeoutMs: 1000, cost: 0 }, () => gate.promise);
        const next = vi.fn(async (remaining: number) => remaining);
        const second = queue.enqueue({ timeoutMs: 1000, cost: 0 }, next);
        await vi.advanceTimersByTimeAsync(400);
        gate.resolve();
        await first;
        await vi.advanceTimersByTimeAsync(1);
        const remaining = await second;
        expect(remaining).toBeGreaterThanOrEqual(599);
        expect(remaining).toBeLessThanOrEqual(600);
        await queue.close();
    });

    it('expires queued work without ever invoking or replaying it', async () => {
        const queue = new DirectOperationQueue();
        const gate = deferred<void>();
        const first = queue.enqueue({ timeoutMs: 1000, cost: 4 }, () => gate.promise);
        const work = vi.fn(async () => 1);
        const second = queue.enqueue({ timeoutMs: 50, cost: 6 }, work);
        const rejection = expect(second).rejects.toMatchObject({ code: 'operation-queue-expired' });
        await vi.advanceTimersByTimeAsync(51);
        await rejection;
        expect(queue.size).toBe(1);
        expect(queue.retainedBytes).toBe(4);
        gate.resolve();
        await first;
        await vi.advanceTimersByTimeAsync(1000);
        expect(work).not.toHaveBeenCalled();
        await queue.close();
    });

    it('closes pending work but drains the real active promise', async () => {
        const queue = new DirectOperationQueue();
        const gate = deferred<void>();
        const first = queue.enqueue({ timeoutMs: 1000, cost: 4 }, () => gate.promise);
        const never = vi.fn(async () => 1);
        const second = queue.enqueue({ timeoutMs: 1000, cost: 6 }, never);
        const rejected = expect(second).rejects.toMatchObject({ code: 'operation-queue-closed' });
        await vi.advanceTimersByTimeAsync(0);
        const close = queue.close();
        const done = vi.fn();
        void close.then(done);
        expect(queue.close()).toBe(close);
        await rejected;
        await Promise.resolve();
        expect(done).not.toHaveBeenCalled();
        expect(queue.retainedBytes).toBe(4);
        gate.resolve();
        await first;
        await close;
        expect(never).not.toHaveBeenCalled();
        expect(queue.retainedBytes).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        await expect(queue.enqueue({ timeoutMs: 10, cost: 0 }, never)).rejects.toMatchObject({
            code: 'operation-queue-closed',
        });
    });

    it('closes before scheduled dispatch and does no work', async () => {
        const queue = new DirectOperationQueue();
        const work = vi.fn(async () => 1);
        const result = queue.enqueue({ timeoutMs: 1000, cost: 4 }, work);
        const rejected = expect(result).rejects.toBeInstanceOf(DirectQueueError);
        await queue.close();
        await rejected;
        await vi.runAllTimersAsync();
        expect(work).not.toHaveBeenCalled();
        expect(queue.size).toBe(0);
        expect(queue.retainedBytes).toBe(0);
    });

    it('does not release active ownership just because its original timeout elapses', async () => {
        const queue = new DirectOperationQueue();
        const gate = deferred<void>();
        const first = queue.enqueue({ timeoutMs: 10, cost: 0 }, () => gate.promise);
        await vi.advanceTimersByTimeAsync(0);
        const work = vi.fn(async () => 2);
        const second = queue.enqueue({ timeoutMs: 1000, cost: 0 }, work);
        await vi.advanceTimersByTimeAsync(100);
        expect(work).not.toHaveBeenCalled();
        gate.resolve();
        await first;
        await vi.advanceTimersByTimeAsync(1);
        await expect(second).resolves.toBe(2);
        await queue.close();
    });

    it('accounts for the active entry in both capacity limits', async () => {
        const queue = new DirectOperationQueue({ maxPending: 2, maxBytes: 10 });
        const gate = deferred<void>();
        const first = queue.enqueue({ timeoutMs: 1000, cost: 6 }, () => gate.promise);
        await vi.advanceTimersByTimeAsync(0);
        await expect(
            queue.enqueue({ timeoutMs: 1000, cost: 5 }, async () => 0),
        ).rejects.toMatchObject({
            code: 'operation-queue-full',
        });
        const second = queue.enqueue({ timeoutMs: 1000, cost: 4 }, async () => 2);
        await expect(
            queue.enqueue({ timeoutMs: 1000, cost: 0 }, async () => 0),
        ).rejects.toMatchObject({
            code: 'operation-queue-full',
        });
        gate.resolve();
        await first;
        await vi.advanceTimersByTimeAsync(1);
        await expect(second).resolves.toBe(2);
        await queue.close();
    });

    it('cancels a queued signal without affecting another generation of work', async () => {
        const queue = new DirectOperationQueue();
        const gate = deferred<void>();
        const first = queue.enqueue({ timeoutMs: 1000, cost: 1 }, () => gate.promise);
        const abort = new AbortController();
        const work = vi.fn(async () => 2);
        const second = queue.enqueue({ timeoutMs: 1000, cost: 3, signal: abort.signal }, work);
        const rejected = expect(second).rejects.toMatchObject({
            code: 'operation-queue-cancelled',
        });
        await vi.advanceTimersByTimeAsync(0);
        abort.abort();
        await rejected;
        expect(queue.retainedBytes).toBe(1);
        gate.resolve();
        await first;
        await queue.close();
        expect(work).not.toHaveBeenCalled();
    });

    it('rejects a pre-aborted signal without retaining work', async () => {
        const queue = new DirectOperationQueue();
        const abort = new AbortController();
        abort.abort();
        const work = vi.fn(async () => 1);
        await expect(
            queue.enqueue({ timeoutMs: 1, cost: 0, signal: abort.signal }, work),
        ).rejects.toMatchObject({ code: 'operation-queue-cancelled' });
        expect(queue.size).toBe(0);
        expect(work).not.toHaveBeenCalled();
        await queue.close();
    });

    it('propagates an active failure exactly once and continues to the next call', async () => {
        const queue = new DirectOperationQueue();
        const failure = new Error('synthetic failure');
        const work = vi.fn(async () => {
            throw failure;
        });
        const first = queue.enqueue({ timeoutMs: 1000, cost: 2 }, work);
        const rejected = expect(first).rejects.toBe(failure);
        const second = queue.enqueue({ timeoutMs: 1000, cost: 3 }, async () => 8);
        await vi.advanceTimersByTimeAsync(2);
        await rejected;
        await expect(second).resolves.toBe(8);
        expect(work).toHaveBeenCalledTimes(1);
        expect(queue.retainedBytes).toBe(0);
        await queue.close();
    });

    it.each([
        { maxPending: 0 },
        { maxPending: 1025 },
        { maxPending: NaN },
        { maxBytes: -1 },
        { maxBytes: Infinity },
        { maxBytes: 16 * 1024 * 1024 + 1 },
    ])('rejects invalid queue limits %j', (limits) => {
        expect(() => new DirectOperationQueue(limits)).toThrow(TypeError);
    });

    it.each([
        { timeoutMs: 0, cost: 0 },
        { timeoutMs: 120001, cost: 0 },
        { timeoutMs: NaN, cost: 0 },
        { timeoutMs: 1, cost: -1 },
        { timeoutMs: 1, cost: Infinity },
        { timeoutMs: 1.2, cost: 0 },
    ])('rejects invalid operation limits %j', (options) => {
        const queue = new DirectOperationQueue();
        expect(() => queue.enqueue(options, async () => 1)).toThrow(TypeError);
        expect(queue.size).toBe(0);
    });
});
