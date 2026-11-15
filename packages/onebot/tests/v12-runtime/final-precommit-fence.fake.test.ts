import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { EventPollBuffer } from '../../src/v12-runtime/event-poll-buffer';
import { PollCoordinator, type PollSink } from '../../src/v12-runtime/poll-transaction';

const config = {
    capacity: 8,
    maxQueueBytes: 4096,
    maxEventBytes: 2048,
    maxWaiters: 4,
    maxTimeoutMs: 1000,
};
const event = { type: 'message', id: 42 };

class Sink extends EventEmitter implements PollSink {
    openCalls = 0;
    headCalls = 0;
    endCalls = 0;
    body = '';
    open = true;

    constructor(private readonly onThirdOpen: () => void) {
        super();
    }

    isOpen(): boolean {
        this.openCalls++;

        if (this.openCalls === 3) {
            this.onThirdOpen();
        }

        return this.open;
    }

    writeHead(): void {
        this.headCalls++;
    }

    end(body: string): void {
        this.endCalls++;
        this.body = body;
        this.emit('finish');
    }
}

describe('final pre-commit fence (in-memory fixtures)', () => {
    it.each(['deadline', 'epoch', 'cancel', 'none'] as const)(
        'rechecks %s changes from the third isOpen before committing',
        async (mode) => {
            let now = 0;
            let valid = true;
            const q = new EventPollBuffer(config);
            const commit = vi.fn((token: object) => q.commit(token));
            const release = vi.fn((token: object) => q.release(token));
            const coordinator = new PollCoordinator(
                { reserve: (options) => q.reserve(options), commit, release },
                config.maxQueueBytes,
                () => now,
                () => valid,
            );
            const sink = new Sink(() => {
                if (mode === 'deadline') {
                    now = 100;
                } else if (mode === 'epoch') {
                    valid = false;
                } else if (mode === 'cancel') {
                    tx.cancel();
                    now = 100;
                    valid = false;
                }
            });
            const setTimer = vi.spyOn(globalThis, 'setTimeout');
            const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
            const tx = coordinator.create(
                { limit: 0, timeoutMs: 0, maxOutputBytes: 4096, responseDeadline: 100 },
                sink,
            );

            try {
                expect(q.enqueue(event)).toBe('accepted');
                const outcome = await tx.run();

                if (mode !== 'none') {
                    expect(commit).not.toHaveBeenCalled();
                    expect(outcome).toEqual({
                        kind:
                            mode === 'deadline'
                                ? 'deadline'
                                : mode === 'epoch'
                                  ? 'epoch_invalid'
                                  : 'cancelled',
                    });
                    expect(release).toHaveBeenCalledOnce();
                    expect(sink.openCalls).toBe(3);
                    expect(sink.headCalls).toBe(0);
                    expect(sink.endCalls).toBe(0);
                    expect(q.stats()).toMatchObject({ count: 1, reserved: 0, waiters: 0 });
                    const retained = await q.reserve();
                    expect(retained.status).toBe('reserved');

                    if (retained.status !== 'reserved') {
                        throw new Error('expected retained event');
                    }

                    expect(JSON.parse(retained.eventsJson)).toEqual([event]);
                    expect(q.release(retained.token)).toBe(true);
                } else {
                    expect(outcome).toEqual({ kind: 'local_finish', response: 'events' });
                    expect(commit).toHaveBeenCalledOnce();
                    expect(release).not.toHaveBeenCalled();
                    expect(sink.headCalls).toBe(1);
                    expect(sink.endCalls).toBe(1);
                    expect(JSON.parse(sink.body).data).toEqual([event]);
                    expect(q.stats()).toMatchObject({ count: 0, reserved: 0, waiters: 0 });
                }

                const deadlineIndex = setTimer.mock.calls.findIndex(([, delay]) => delay === 100);
                expect(deadlineIndex).toBeGreaterThanOrEqual(0);
                const timer = setTimer.mock.results[deadlineIndex].value;
                expect(clearTimer).toHaveBeenCalledWith(timer);
                expect(Reflect.get(tx, 'timer')).toBeUndefined();
                expect(Reflect.get(tx, 'state')).toBe('terminal');
                expect((Reflect.get(coordinator, 'transactions') as Set<unknown>).size).toBe(0);
                expect(sink.listenerCount('close')).toBe(0);
                expect(sink.listenerCount('error')).toBe(0);
                expect(sink.listenerCount('finish')).toBe(0);
            } finally {
                tx.cancel();
                coordinator.close();
                q.close();
                setTimer.mockRestore();
                clearTimer.mockRestore();
            }
        },
        3000,
    );

    it('negative control: a reentrant final clock sample can still close the sink', async () => {
        const q = new EventPollBuffer(config);
        const sink = new Sink(() => {});
        let clockCalls = 0;
        let commitAtClockCall = 0;
        const commit = vi.fn((token: object) => {
            commitAtClockCall = clockCalls;
            return q.commit(token);
        });
        const release = vi.fn((token: object) => q.release(token));
        const coordinator = new PollCoordinator(
            { reserve: (options) => q.reserve(options), commit, release },
            config.maxQueueBytes,
            () => {
                clockCalls++;

                // The first call arms the timer; call 5 is the fourth check sample,
                // made by the final check(false) after the third isOpen().
                if (clockCalls === 5) {
                    sink.open = false;
                }

                return 0;
            },
            () => true,
        );
        const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
        const tx = coordinator.create(
            { limit: 0, timeoutMs: 0, maxOutputBytes: 4096, responseDeadline: 100 },
            sink,
        );

        try {
            expect(q.enqueue(event)).toBe('accepted');
            expect(await tx.run()).toEqual({ kind: 'committed_unsent' });
            expect(commit).toHaveBeenCalledOnce();
            expect(commitAtClockCall).toBe(5);
            expect(clockCalls).toBe(6);
            expect(sink.openCalls).toBe(4);
            expect(release).not.toHaveBeenCalled();
            expect(q.stats()).toMatchObject({ count: 0, reserved: 0, waiters: 0 });
            expect(sink.headCalls).toBe(0);
            expect(sink.endCalls).toBe(0);
            expect(clearTimer).toHaveBeenCalledOnce();
            expect(Reflect.get(tx, 'timer')).toBeUndefined();
            expect(Reflect.get(tx, 'state')).toBe('terminal');
            expect((Reflect.get(coordinator, 'transactions') as Set<unknown>).size).toBe(0);
            expect(sink.listenerCount('close')).toBe(0);
            expect(sink.listenerCount('error')).toBe(0);
            expect(sink.listenerCount('finish')).toBe(0);
        } finally {
            tx.cancel();
            coordinator.close();
            q.close();
            clearTimer.mockRestore();
        }
    }, 3000);
});
