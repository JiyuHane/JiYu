import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestDeadline } from '../../src/v12/client-types.js';

const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
afterEach(() => {
    if (anyDescriptor) {
        Object.defineProperty(AbortSignal, 'any', anyDescriptor);
    } else {
        Reflect.deleteProperty(AbortSignal, 'any');
    }
    vi.useRealTimers();
});

function withoutAny(): void {
    Object.defineProperty(AbortSignal, 'any', {
        configurable: true,
        writable: true,
        value: undefined,
    });
}

describe('OneBot 12 request deadline', () => {
    it('observes native source cancellation despite stopped source propagation and preserves the reason', () => {
        const source = new AbortController();
        source.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
        const deadline = requestDeadline(0, source.signal);
        const reason = { secret: 'never in errors' };
        let observed = 0;
        deadline.signal.addEventListener('abort', () => {
            observed++;
        });
        source.abort(reason);
        expect(deadline.signal.aborted).toBe(true);
        expect(deadline.signal.reason).toBe(reason);
        expect(observed).toBe(1);
        expect(deadline.failure()).toMatchObject({ code: 'aborted' });
        expect(String(deadline.failure())).not.toContain('never in errors');
        deadline.cleanup();
    });

    it('honors a signal aborted before construction without scheduling a timer', () => {
        vi.useFakeTimers();
        const source = new AbortController();
        const reason = { secret: 1 };
        source.abort(reason);
        const deadline = requestDeadline(50, source.signal);
        expect(deadline.signal.aborted).toBe(true);
        expect(deadline.signal.reason).toBe(reason);
        expect(deadline.failure()).toMatchObject({ code: 'aborted' });
        expect(vi.getTimerCount()).toBe(0);
        deadline.cleanup();
    });

    it('keeps the first cause when external cancellation happens before the timer', async () => {
        vi.useFakeTimers();
        const source = new AbortController();
        source.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
        const deadline = requestDeadline(20, source.signal);
        const reason = { external: true };
        source.abort(reason);
        await vi.advanceTimersByTimeAsync(20);
        expect(deadline.signal.reason).toBe(reason);
        expect(deadline.failure()).toMatchObject({ code: 'aborted' });
        deadline.cleanup();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps external cancellation if its first listener reentrantly fires the timer', () => {
        vi.useFakeTimers();
        const source = new AbortController();
        source.signal.addEventListener('abort', (event) => {
            vi.advanceTimersByTime(20);
            event.stopImmediatePropagation();
        });
        const deadline = requestDeadline(20, source.signal);
        const reason = { external: true };
        source.abort(reason);
        expect(deadline.signal.aborted).toBe(true);
        expect(deadline.signal.reason).toBe(reason);
        expect(deadline.failure()).toMatchObject({ code: 'aborted' });
        deadline.cleanup();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps timeout when the timer fires before external cancellation', async () => {
        vi.useFakeTimers();
        const source = new AbortController();
        const deadline = requestDeadline(20, source.signal);
        await vi.advanceTimersByTimeAsync(20);
        expect(deadline.failure()).toMatchObject({ code: 'timeout' });
        const reason = deadline.signal.reason;
        source.abort('later');
        expect(deadline.signal.reason).toBe(reason);
        expect(deadline.failure()).toMatchObject({ code: 'timeout' });
        deadline.cleanup();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects bad signals without leaking their errors and without leaving timers', () => {
        vi.useFakeTimers();
        const evil = new Proxy(
            {},
            {
                get() {
                    throw new Error('sensitive-signal');
                },
            },
        );
        for (const signal of [null, {}, evil]) {
            let error: unknown;
            try {
                requestDeadline(50, signal as AbortSignal);
            } catch (cause) {
                error = cause;
            }
            expect(error).toMatchObject({ code: 'invalid_options' });
            expect(String(error)).not.toContain('sensitive-signal');
            expect(vi.getTimerCount()).toBe(0);
        }
    });

    it('uses and cleans the listener fallback when AbortSignal.any is missing', () => {
        withoutAny();
        const source = new AbortController();
        const remove = vi.spyOn(source.signal, 'removeEventListener');
        const deadline = requestDeadline(0, source.signal);
        source.abort();
        expect(deadline.signal.aborted).toBe(true);
        expect(deadline.failure()).toMatchObject({ code: 'aborted' });
        deadline.cleanup();
        deadline.cleanup();
        expect(remove).toHaveBeenCalledTimes(1);
    });

    it('honors already-aborted source and timeout classification in the fallback', async () => {
        withoutAny();
        vi.useFakeTimers();
        const source = new AbortController();
        source.abort();
        const already = requestDeadline(50, source.signal);
        expect(already.signal.aborted).toBe(true);
        expect(already.failure()).toMatchObject({ code: 'aborted' });
        expect(vi.getTimerCount()).toBe(0);
        already.cleanup();
        const pending = requestDeadline(20, new AbortController().signal);
        await vi.advanceTimersByTimeAsync(20);
        expect(pending.failure()).toMatchObject({ code: 'timeout' });
        pending.cleanup();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not promise propagation through a stopped source listener in the fallback', () => {
        withoutAny();
        const source = new AbortController();
        source.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
        const deadline = requestDeadline(0, source.signal);
        source.abort();
        expect(source.signal.aborted).toBe(true);
        expect(deadline.signal.aborted).toBe(false);
        deadline.cleanup();
    });

    it('cleans a fallback subscription even if signal setup throws after subscribing', () => {
        withoutAny();
        const source = new AbortController();
        const realAdd = source.signal.addEventListener.bind(source.signal);
        const remove = vi.spyOn(source.signal, 'removeEventListener');
        vi.spyOn(source.signal, 'addEventListener').mockImplementation((...args) => {
            realAdd(...args);
            throw new Error('sensitive-subscribe');
        });
        let error: unknown;
        try {
            requestDeadline(50, source.signal);
        } catch (cause) {
            error = cause;
        }
        expect(error).toMatchObject({ code: 'invalid_options' });
        expect(String(error)).not.toContain('sensitive-subscribe');
        expect(remove).toHaveBeenCalledTimes(1);
    });
});
