import { describe, expect, it, vi } from 'vitest';
import {
    createSsoHeartbeatScheduler,
    type SsoHeartbeatSchedulerEvent,
    type SsoHeartbeatSchedulerTimer,
} from '../../src/direct/sso-heartbeat-scheduler';
import type { SsoHeartbeatOutcome } from '../../src/direct/sso-reference-heartbeat-flow';

// Purely local scheduling policy: unlike potentially overlapping V2 behavior,
// this fixture enforces single flight. It proves neither authentication nor online state.
const PERIOD = 270_000;
const success = (interval = 270n): SsoHeartbeatOutcome => ({ status: 'success', interval });

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

async function flush() {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
}

class FakeTimer implements SsoHeartbeatSchedulerTimer {
    time = 1000;
    private nextId = 0;
    readonly pending = new Map<number, { callback: () => void; due: number }>();
    readonly callbacks = new Map<number, () => void>();
    readonly cleared: number[] = [];
    readonly delays: number[] = [];

    now = () => this.time;

    setTimeout = (callback: () => void, delayMs: number): number => {
        if (!Number.isFinite(delayMs) || delayMs < 0) {
            throw new Error('invalid fake timer delay');
        }

        const id = ++this.nextId;
        this.delays.push(delayMs);
        this.pending.set(id, { callback, due: this.time + delayMs });
        this.callbacks.set(id, callback);
        return id;
    };

    clearTimeout = (handle: unknown): void => {
        if (typeof handle !== 'number') {
            throw new Error('invalid fake timer handle');
        }

        this.cleared.push(handle);
        this.pending.delete(handle);
    };

    fire(id: number): void {
        const task = this.pending.get(id);

        if (!task) {
            throw new Error('missing virtual timer');
        }

        this.pending.delete(id);
        task.callback();
    }

    // A clock leap dispatches each already-due timer at the new time, not once per
    // missed period. A bounded dispatch count detects zero-delay rescheduling loops.
    leapTo(time: number, limit = 20): number {
        this.time = time;
        let dispatched = 0;

        while (true) {
            const item = [...this.pending.entries()]
                .filter(([, task]) => task.due <= this.time)
                .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];

            if (!item) {
                return dispatched;
            }

            if (++dispatched > limit) {
                throw new Error('virtual timer dispatch storm');
            }

            this.pending.delete(item[0]);
            item[1].callback();
        }
    }
}

function fixture() {
    const timer = new FakeTimer();
    const requests: Array<ReturnType<typeof deferred<SsoHeartbeatOutcome>>> = [];
    const calls: number[] = [];
    const events: SsoHeartbeatSchedulerEvent[] = [];
    const heartbeat = vi.fn(() => {
        calls.push(timer.time);
        const request = deferred<SsoHeartbeatOutcome>();
        requests.push(request);
        return request.promise;
    });
    const scheduler = createSsoHeartbeatScheduler(
        { heartbeat },
        { timer, onEvent: (event) => events.push(event) },
    );
    return { timer, requests, calls, events, heartbeat, scheduler };
}

describe('conservative single-flight heartbeat scheduler with virtual time', () => {
    it.each([
        ['zero', success(0n)],
        ['one', success(1n)],
        ['uint64 max', success(0xffffffffffffffffn)],
        ['missing', { status: 'missing-interval' } as SsoHeartbeatOutcome],
    ])(
        'starts explicitly, immediately and stays aligned independently of %s interval',
        async (_, outcome) => {
            const f = fixture();
            expect(f.scheduler.getState()).toBe('new');
            expect(f.heartbeat).not.toHaveBeenCalled();
            expect(f.timer.pending.size).toBe(0);
            f.scheduler.start();
            expect(f.scheduler.getState()).toBe('running');
            expect(f.calls).toEqual([1000]);
            f.timer.time = 1000 + 1234;
            f.requests[0]!.resolve(outcome);
            await flush();
            f.timer.leapTo(1000 + PERIOD - 1);
            await flush();
            expect(f.calls).toEqual([1000]);
            f.timer.leapTo(1000 + PERIOD);
            await flush();
            expect(f.calls).toEqual([1000, 1000 + PERIOD]);
            f.requests[1]!.resolve(success());
            await flush();
            await f.scheduler.stop();
            expect(f.timer.pending.size).toBe(0);
            expect(f.scheduler.getState()).toBe('stopped');
        },
    );

    it('skips fixed-rate slots while busy instead of overlapping or queueing a catch-up', async () => {
        const f = fixture();
        f.scheduler.start();

        for (let i = 1; i <= 3; i++) {
            f.timer.leapTo(1000 + PERIOD * i);
            await flush();
            expect(f.heartbeat).toHaveBeenCalledTimes(1);
        }

        const skips = f.events.filter((event) => event.type === 'skipped');
        expect(skips.reduce((sum, event) => sum + event.count, 0)).toBe(3);
        expect(skips.every((event) => event.reason === 'busy')).toBe(true);
        f.timer.time += 17;
        f.requests[0]!.resolve(success());
        await flush();
        expect(f.heartbeat).toHaveBeenCalledTimes(1);
        f.timer.leapTo(1000 + PERIOD * 4);
        await flush();
        expect(f.calls).toEqual([1000, 1000 + PERIOD * 4]);
        f.requests[1]!.resolve(success());
        await flush();
        await f.scheduler.stop();
        expect(f.timer.pending.size).toBe(0);
    });

    it('reschedules an early timer against the original fixed deadline', async () => {
        const f = fixture();
        f.scheduler.start();
        f.requests[0]!.resolve(success());
        await flush();
        const id = [...f.timer.pending.keys()][0];
        expect(id).toBeDefined();
        f.timer.time = 1000 + 500;
        f.timer.fire(id!);
        await flush();
        expect(f.heartbeat).toHaveBeenCalledTimes(1);
        expect(f.timer.pending.size).toBe(1);
        f.timer.callbacks.get(id!)!();
        await flush();
        expect(f.heartbeat).toHaveBeenCalledTimes(1);
        f.timer.leapTo(1000 + PERIOD);
        await flush();
        expect(f.calls).toEqual([1000, 1000 + PERIOD]);
        f.requests[1]!.resolve(success());
        await flush();
        await f.scheduler.stop();
    });

    it('handles a large leap with bounded timer work and finite skipped counts', async () => {
        const f = fixture();
        f.scheduler.start();
        f.requests[0]!.resolve(success());
        await flush();
        const target = 1000 + PERIOD * 1_000_000;
        expect(f.timer.leapTo(target)).toBeLessThanOrEqual(2);
        await flush();
        expect(f.heartbeat.mock.calls.length).toBeLessThanOrEqual(2);
        expect(f.timer.pending.size).toBeLessThanOrEqual(1);

        for (const event of f.events) {
            if (event.type === 'skipped') {
                expect(Number.isSafeInteger(event.count)).toBe(true);
                expect(event.count).toBeGreaterThan(0);
            }
        }

        for (const request of f.requests) {
            request.resolve(success());
        }

        await flush();
        await f.scheduler.stop();
        expect(f.timer.pending.size).toBe(0);
    });

    it('accounts for more than uint32 missed periods without truncation or a timer storm', async () => {
        const timer = new FakeTimer();
        const events: SsoHeartbeatSchedulerEvent[] = [];
        const request = deferred<SsoHeartbeatOutcome>();
        const heartbeat = vi
            .fn()
            .mockResolvedValueOnce(success())
            .mockReturnValueOnce(request.promise);
        const scheduler = createSsoHeartbeatScheduler(
            { heartbeat },
            { timer, periodMs: 1, onEvent: (event) => events.push(event) },
        );
        scheduler.start();
        await flush();
        const elapsed = 4_294_967_300;
        expect(timer.leapTo(1000 + elapsed)).toBeLessThanOrEqual(2);
        await flush();
        const skipped = events.filter((event) => event.type === 'skipped');
        expect(skipped.reduce((sum, event) => sum + event.count, 0)).toBe(elapsed - 1);
        expect(skipped.every((event) => Number.isSafeInteger(event.count))).toBe(true);
        expect(heartbeat).toHaveBeenCalledTimes(2);
        request.resolve(success());
        await flush();
        await scheduler.stop();
        expect(timer.pending.size).toBe(0);
    });

    it.each([0, -1, 1.5, Number.NaN, Infinity, 2_147_483_648])(
        'rejects invalid period %s at construction',
        (periodMs) => {
            const timer = new FakeTimer();
            expect(() =>
                createSsoHeartbeatScheduler(
                    { heartbeat: async () => success() },
                    { timer, periodMs },
                ),
            ).toThrow(TypeError);
            expect(timer.pending.size).toBe(0);
        },
    );

    it.each([1, 2_147_483_647])('accepts period boundary %s', async (periodMs) => {
        const timer = new FakeTimer();
        const calls: number[] = [];
        const heartbeat = vi.fn(async () => {
            calls.push(timer.time);
            return success();
        });
        const scheduler = createSsoHeartbeatScheduler({ heartbeat }, { timer, periodMs });
        scheduler.start();
        await flush();
        timer.leapTo(1000 + periodMs);
        await flush();
        expect(calls).toEqual([1000, 1000 + periodMs]);
        await scheduler.stop();
        expect(timer.pending.size).toBe(0);
    });

    it.each([Number.NaN, Infinity, -1, Number.MAX_SAFE_INTEGER])(
        'reports an invalid initial clock value %s',
        async (time) => {
            const timer = new FakeTimer();
            timer.time = time;
            const heartbeat = vi.fn(async () => success());
            const events: SsoHeartbeatSchedulerEvent[] = [];
            const scheduler = createSsoHeartbeatScheduler(
                { heartbeat },
                { timer, onEvent: (event) => events.push(event) },
            );
            scheduler.start();
            await flush();
            expect(scheduler.getState()).toBe('failed');
            expect(events).toContainEqual({ type: 'failed', reason: 'clock-error' });
            expect(heartbeat).not.toHaveBeenCalled();
            expect(timer.pending.size).toBe(0);
            await scheduler.stop();
        },
    );

    it('detects a backwards clock rather than allowing another heartbeat', async () => {
        const f = fixture();
        f.scheduler.start();
        f.requests[0]!.resolve(success());
        await flush();
        const id = [...f.timer.pending.keys()][0];
        expect(id).toBeDefined();
        f.timer.time = 999;
        f.timer.fire(id!);
        await flush();
        expect(f.scheduler.getState()).toBe('failed');
        expect(f.events).toContainEqual({ type: 'failed', reason: 'clock-error' });
        expect(f.heartbeat).toHaveBeenCalledTimes(1);
        expect(f.timer.pending.size).toBe(0);
        await f.scheduler.stop();
    });

    it.each(['throw', 'synchronous callback'] as const)(
        'fails explicitly on timer %s',
        async (mode) => {
            const timer = new FakeTimer();
            const events: SsoHeartbeatSchedulerEvent[] = [];
            const heartbeat = vi.fn(async () => success());
            const scheduler = createSsoHeartbeatScheduler(
                { heartbeat },
                {
                    timer: {
                        now: timer.now,
                        setTimeout: (callback) => {
                            if (mode === 'throw') {
                                throw new Error('fixture timer failure');
                            }

                            callback();
                            return 1;
                        },
                        clearTimeout: timer.clearTimeout,
                    },
                    onEvent: (event) => events.push(event),
                },
            );
            scheduler.start();
            await flush();
            expect(scheduler.getState()).toBe('failed');
            expect(events).toContainEqual({ type: 'failed', reason: 'timer-error' });
            expect(heartbeat.mock.calls.length).toBeLessThanOrEqual(1);
            expect(timer.pending.size).toBe(0);
            await scheduler.stop();
        },
    );

    it('interrupts an in-flight request after timer failure and waits for its settlement', async () => {
        const timer = new FakeTimer();
        const request = deferred<SsoHeartbeatOutcome>();
        const events: SsoHeartbeatSchedulerEvent[] = [];
        const interrupt = vi.fn((_signal: AbortSignal) => {});
        const heartbeat = vi.fn(() => request.promise);
        const scheduler = createSsoHeartbeatScheduler(
            { heartbeat },
            {
                timer: {
                    now: timer.now,
                    setTimeout: () => {
                        throw new Error('fixture timer failure');
                    },
                    clearTimeout: timer.clearTimeout,
                },
                onInterrupt: interrupt,
                onEvent: (event) => events.push(event),
            },
        );
        scheduler.start();
        expect(scheduler.getState()).toBe('failed');
        expect(events).toContainEqual({ type: 'failed', reason: 'timer-error' });
        expect(interrupt).toHaveBeenCalledOnce();
        expect(interrupt.mock.calls[0]![0].aborted).toBe(true);
        let drained = false;
        const stopped = scheduler.stop().then(() => {
            drained = true;
        });
        await flush();
        expect(drained).toBe(false);
        request.reject(new Error('late fixture rejection'));
        await stopped;
        expect(scheduler.getState()).toBe('failed');
        expect(heartbeat).toHaveBeenCalledOnce();
    });

    it('honors stop reentered from the started event before launching a heartbeat', async () => {
        const timer = new FakeTimer();
        const heartbeat = vi.fn(async () => success());
        let stopping: Promise<void> | undefined;
        const scheduler = createSsoHeartbeatScheduler(
            { heartbeat },
            {
                timer,
                onEvent: (event) => {
                    if (event.type === 'started') {
                        stopping = scheduler.stop();
                    }
                },
            },
        );
        scheduler.start();
        await stopping;
        await flush();
        expect(scheduler.getState()).toBe('stopped');
        expect(heartbeat).not.toHaveBeenCalled();
        expect(timer.pending.size).toBe(0);
    });

    it('stops before start and retains no timer or heartbeat', async () => {
        const f = fixture();
        await f.scheduler.stop();
        expect(f.scheduler.getState()).toBe('stopped');
        expect(f.heartbeat).not.toHaveBeenCalled();
        expect(f.timer.pending.size).toBe(0);
        await f.scheduler.stop();
    });

    it.each(['resolve', 'reject'] as const)(
        'waits for an in-flight heartbeat and never revives after its late %s',
        async (ending) => {
            const f = fixture();
            f.scheduler.start();
            const stale = [...f.timer.callbacks.values()];
            let stopped = false;
            const stop = f.scheduler.stop().then(() => {
                stopped = true;
            });
            await flush();
            expect(stopped).toBe(false);
            expect(f.scheduler.getState()).toBe('stopping');
            expect(f.timer.pending.size).toBe(0);

            if (ending === 'resolve') {
                f.requests[0]!.resolve(success());
            } else {
                f.requests[0]!.reject(new Error('late fixture rejection'));
            }

            await stop;
            await flush();
            expect(f.scheduler.getState()).toBe('stopped');

            for (const callback of stale) {
                callback();
            }

            f.timer.leapTo(1000 + PERIOD * 10);
            await flush();
            expect(f.heartbeat).toHaveBeenCalledTimes(1);
            expect(f.timer.pending.size).toBe(0);
            expect(f.scheduler.getState()).toBe('stopped');
            expect(new Set(f.timer.cleared).size).toBe(f.timer.cleared.length);
            await f.scheduler.close();
        },
    );

    it.each(['clear succeeds', 'clear throws'] as const)(
        'cleans a handle returned after reentrant stop when %s',
        async (mode) => {
            const timer = new FakeTimer();
            const request = deferred<SsoHeartbeatOutcome>();
            const heartbeat = vi.fn(() => request.promise);
            const events: SsoHeartbeatSchedulerEvent[] = [];
            const cleared: unknown[] = [];
            let handle: number | undefined;
            let stopping: Promise<void> | undefined;
            const scheduler = createSsoHeartbeatScheduler(
                { heartbeat },
                {
                    timer: {
                        now: timer.now,
                        setTimeout: (callback, delay) => {
                            stopping = scheduler.stop();
                            handle = timer.setTimeout(callback, delay);
                            return handle;
                        },
                        clearTimeout: (value) => {
                            cleared.push(value);

                            if (mode === 'clear throws') {
                                throw new Error('fixture clear failure');
                            }

                            timer.clearTimeout(value);
                        },
                    },
                    onEvent: (event) => events.push(event),
                },
            );
            scheduler.start();
            expect(handle).toBeDefined();
            expect(stopping).toBeDefined();
            expect(cleared).toEqual([handle]);

            if (mode === 'clear succeeds') {
                expect(timer.pending.size).toBe(0);
                expect(events.filter((event) => event.type === 'timer-cleanup-error')).toEqual([]);
            } else {
                expect(timer.pending.size).toBe(1);
                expect(events.filter((event) => event.type === 'timer-cleanup-error')).toEqual([
                    { type: 'timer-cleanup-error' },
                ]);
            }

            timer.time = 1000 + PERIOD;
            timer.callbacks.get(handle!)!();
            await flush();
            expect(heartbeat).toHaveBeenCalledOnce();
            request.resolve(success());
            await stopping;
            expect(scheduler.getState()).toBe('stopped');
            expect(events.filter((event) => event.type === 'stopped')).toEqual([
                { type: 'stopped' },
            ]);
            expect(cleared).toEqual([handle]);
        },
    );

    it('reports clearTimeout failure and fences the surviving callback', async () => {
        const timer = new FakeTimer();
        const request = deferred<SsoHeartbeatOutcome>();
        const heartbeat = vi.fn(() => request.promise);
        const events: SsoHeartbeatSchedulerEvent[] = [];
        const scheduler = createSsoHeartbeatScheduler(
            { heartbeat },
            {
                timer: {
                    now: timer.now,
                    setTimeout: timer.setTimeout,
                    clearTimeout: () => {
                        throw new Error('fixture clear failure');
                    },
                },
                onEvent: (event) => events.push(event),
            },
        );
        scheduler.start();
        const stopping = scheduler.stop();
        expect(events).toContainEqual({ type: 'timer-cleanup-error' });
        timer.leapTo(1000 + PERIOD);
        await flush();
        expect(heartbeat).toHaveBeenCalledOnce();
        request.resolve(success());
        await stopping;
        expect(scheduler.getState()).toBe('stopped');
    });

    it('observes external abort despite an earlier stopImmediatePropagation listener', async () => {
        const controller = new AbortController();
        controller.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
        const timer = new FakeTimer();
        const request = deferred<SsoHeartbeatOutcome>();
        const heartbeat = vi.fn(() => request.promise);
        const interrupt = vi.fn();
        const events: SsoHeartbeatSchedulerEvent[] = [];
        const scheduler = createSsoHeartbeatScheduler(
            { heartbeat },
            {
                timer,
                signal: controller.signal,
                onInterrupt: interrupt,
                onEvent: (e) => events.push(e),
            },
        );
        scheduler.start();
        controller.abort();
        expect(scheduler.getState()).toBe('stopping');
        expect(interrupt).toHaveBeenCalledOnce();
        expect(timer.pending.size).toBe(0);
        request.resolve(success());
        await scheduler.stop();
        expect(scheduler.getState()).toBe('stopped');
        expect(events).toContainEqual({ type: 'stopped' });
        timer.leapTo(1000 + PERIOD * 10);
        await flush();
        expect(heartbeat).toHaveBeenCalledOnce();
    });

    it('reports an interrupt callback exception and still drains the in-flight operation', async () => {
        const timer = new FakeTimer();
        const request = deferred<SsoHeartbeatOutcome>();
        const events: SsoHeartbeatSchedulerEvent[] = [];
        const interrupt = vi.fn((signal: AbortSignal) => {
            expect(signal.aborted).toBe(true);
            throw new Error('fixture interrupt failure');
        });
        const scheduler = createSsoHeartbeatScheduler(
            { heartbeat: () => request.promise },
            { timer, onInterrupt: interrupt, onEvent: (event) => events.push(event) },
        );
        scheduler.start();
        let drained = false;
        const stopped = scheduler.stop().then(() => {
            drained = true;
        });
        await flush();
        expect(interrupt).toHaveBeenCalledOnce();
        expect(events).toContainEqual({ type: 'interrupt-error' });
        expect(drained).toBe(false);
        request.resolve(success());
        await stopped;
        expect(scheduler.getState()).toBe('stopped');
        expect(timer.pending.size).toBe(0);
        await scheduler.stop();
        expect(interrupt).toHaveBeenCalledOnce();
    });

    it('isolates synchronous observer exceptions from scheduling and stop', async () => {
        const timer = new FakeTimer();
        const heartbeat = vi.fn(async () => success());
        const observed: string[] = [];
        const scheduler = createSsoHeartbeatScheduler(
            { heartbeat },
            {
                timer,
                onEvent: (event) => {
                    observed.push(event.type);
                    throw new Error('fixture observer error');
                },
            },
        );
        scheduler.start();
        await flush();
        timer.leapTo(1000 + PERIOD);
        await flush();
        expect(heartbeat).toHaveBeenCalledTimes(2);
        await scheduler.stop();
        expect(scheduler.getState()).toBe('stopped');
        expect(observed).toContain('started');
        expect(observed).toContain('result');
        expect(observed).toContain('stopped');
        expect(timer.pending.size).toBe(0);
    });

    it('stops from a settled result event without interrupting the idle owner', async () => {
        const timer = new FakeTimer();
        const request = deferred<SsoHeartbeatOutcome>();
        const events: SsoHeartbeatSchedulerEvent[] = [];
        let idle = false;
        let idleWhenResult = false;
        let drains = 0;
        const heartbeat = vi.fn(() =>
            request.promise.finally(() => {
                idle = true;
            }),
        );
        const owner = { heartbeat, close: vi.fn() };
        const interrupt = vi.fn(() => owner.close());
        let stopping: Promise<void> | undefined;
        const scheduler = createSsoHeartbeatScheduler(owner, {
            timer,
            onInterrupt: interrupt,
            onEvent: (event) => {
                events.push(event);

                if (event.type === 'result') {
                    idleWhenResult = idle;
                    stopping = scheduler.stop().then(() => {
                        drains++;
                    });
                }
            },
        });
        scheduler.start();
        request.resolve(success());
        await flush();
        expect(idleWhenResult).toBe(true);
        expect(stopping).toBeDefined();
        await stopping;
        expect(drains).toBe(1);
        expect(interrupt).not.toHaveBeenCalled();
        expect(owner.close).not.toHaveBeenCalled();
        expect(events.filter((event) => event.type === 'result')).toEqual([
            { type: 'result', outcome: success() },
        ]);
        expect(events.filter((event) => event.type === 'stopped')).toEqual([{ type: 'stopped' }]);
        expect(scheduler.getState()).toBe('stopped');
        timer.leapTo(1000 + PERIOD * 10);
        await flush();
        expect(heartbeat).toHaveBeenCalledTimes(1);
        expect(timer.pending.size).toBe(0);
    });

    it('fails on a malformed heartbeat outcome without interrupting a settled request', async () => {
        const timer = new FakeTimer();
        const request = deferred<SsoHeartbeatOutcome>();
        const events: SsoHeartbeatSchedulerEvent[] = [];
        const interrupt = vi.fn();
        const scheduler = createSsoHeartbeatScheduler(
            { heartbeat: () => request.promise },
            { timer, onInterrupt: interrupt, onEvent: (event) => events.push(event) },
        );
        scheduler.start();
        request.resolve({ status: 'success', interval: '270' } as unknown as SsoHeartbeatOutcome);
        await flush();
        expect(scheduler.getState()).toBe('failed');
        expect(events).toContainEqual({ type: 'failed', reason: 'invalid-outcome' });
        expect(interrupt).not.toHaveBeenCalled();
        expect(timer.pending.size).toBe(0);
        await scheduler.stop();
    });

    it.each([
        ['rejection', 'heartbeat-error'],
        ['sso error', 'sso-error'],
    ] as const)('stops and reports %s without another heartbeat', async (kind, reason) => {
        const f = fixture();
        f.scheduler.start();

        if (kind === 'rejection') {
            f.requests[0]!.reject(new Error('fixture heartbeat failure'));
        } else {
            f.requests[0]!.resolve({ status: 'sso-error', retCode: 42 });
        }

        await flush();
        expect(f.scheduler.getState()).toBe('failed');
        expect(f.events).toContainEqual({ type: 'failed', reason });
        expect(f.timer.pending.size).toBe(0);
        f.timer.leapTo(1000 + PERIOD * 10);
        await flush();
        expect(f.heartbeat).toHaveBeenCalledTimes(1);
        expect(new Set(f.timer.cleared).size).toBe(f.timer.cleared.length);
        await f.scheduler.stop();
    });
});
