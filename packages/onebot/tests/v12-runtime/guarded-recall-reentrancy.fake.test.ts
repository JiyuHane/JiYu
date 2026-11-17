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
    GuardedPollResult,
    PollBufferConfig,
} from '../../src/v12-runtime/event-poll-buffer';

// Ordinary message JSON is enough for these queue tests. No recall proof or
// source/account machinery is loaded or created by this fixture.
vi.mock('../../src/v12-runtime/private-recall-source', () => ({
    isPrivateRecallPollProofCurrent: () => false,
    isPrivateRecallPollProofFor: () => false,
}));

let EventPollBuffer: typeof import('../../src/v12-runtime/event-poll-buffer').EventPollBuffer;
let guards: Array<{ mock: { calls: unknown[] } }> = [];
const buffers: BufferInstance[] = [];
const signals: AbortSignal[] = [];

function forbidden(): never {
    throw new Error('unexpected network, native, or child-process operation in in-memory fixture');
}

beforeEach(async () => {
    vi.useFakeTimers();
    buffers.length = 0;
    signals.length = 0;

    // Keep these guards usable in Node environments with no built-in WebSocket.
    if (typeof globalThis.fetch !== 'function') {
        vi.stubGlobal('fetch', forbidden);
    }

    if (typeof globalThis.WebSocket !== 'function') {
        vi.stubGlobal('WebSocket', function ForbiddenWebSocket() {
            return forbidden();
        });
    }

    guards = [
        vi.spyOn(globalThis, 'fetch').mockImplementation(forbidden),
        vi.spyOn(globalThis, 'WebSocket').mockImplementation(forbidden),
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
        vi.spyOn(childProcess, 'spawn').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawnSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'exec').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFile').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFileSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'fork').mockImplementation(forbidden),
        vi.spyOn(process, 'dlopen').mockImplementation(forbidden),
    ];

    // The subject is imported only after all network, process and native guards.
    ({ EventPollBuffer } = await import('../../src/v12-runtime/event-poll-buffer'));
});

afterEach(() => {
    // Record resources before emergency close as well: cleanup must not conceal a
    // timer or abort listener left behind by an already-settled waiter.
    const beforeTimers = vi.getTimerCount();
    const beforeListeners = signals.map((signal) => getEventListeners(signal, 'abort').length);
    const cleanupErrors: unknown[] = [];

    for (const q of buffers) {
        try {
            q.close();
        } catch (error) {
            cleanupErrors.push(error);
        }
    }

    const afterTimers = vi.getTimerCount();
    const afterListeners = signals.map((signal) => getEventListeners(signal, 'abort').length);
    const calls = guards.map((guard) => guard.mock.calls.length);
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();

    expect(cleanupErrors).toEqual([]);
    expect(beforeTimers).toBe(0);
    expect(afterTimers).toBe(0);
    expect(beforeListeners).toEqual(beforeListeners.map(() => 0));
    expect(afterListeners).toEqual(afterListeners.map(() => 0));
    expect(calls).toEqual(calls.map(() => 0));
});

const config: PollBufferConfig = {
    capacity: 8,
    maxQueueBytes: 4096,
    maxEventBytes: 2048,
    maxWaiters: 4,
    maxTimeoutMs: 1000,
};

function guarded(): BufferInstance {
    const q = new EventPollBuffer(config, 'reject-new', 'guarded-recall');
    buffers.push(q);
    return q;
}

function controller(): AbortController {
    const c = new AbortController();
    signals.push(c.signal);
    return c;
}

function message(id: string) {
    return { type: 'message', id, text: 'synthetic JSON' };
}

type Observation =
    { kind: 'fulfilled'; value: GuardedPollResult } | { kind: 'rejected'; reason: unknown };

function observe(promise: Promise<GuardedPollResult>): Observation[] {
    const observations: Observation[] = [];
    void promise.then(
        (value) => observations.push({ kind: 'fulfilled', value }),
        (reason: unknown) => observations.push({ kind: 'rejected', reason }),
    );
    return observations;
}

// A single microtask observes an already-settled promise without ever waiting on
// a broken pending waiter or using a real timer.
async function settled(observations: Observation[]): Promise<GuardedPollResult> {
    await Promise.resolve();
    expect(observations).toHaveLength(1);
    const observed = observations[0];

    if (!observed || observed.kind !== 'fulfilled') {
        throw new Error('expected one fulfilled guarded poll');
    }

    return observed.value;
}

function reserved(result: GuardedPollResult): Extract<GuardedPollResult, { status: 'reserved' }> {
    if (result.status !== 'reserved') {
        throw new Error(`expected a guarded reservation, got ${result.status}`);
    }

    return result;
}

function expectCleanWaiter(q: BufferInstance, signal: AbortSignal): void {
    expect(q.stats()).toMatchObject({ waiters: 0, reserved: 0 });
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
}

// These deliberate replacements of performance.now and a legacy instance
// method are synthetic fault injection, beyond the queue's trusted-builtins
// assumption; they are not claims about a production clock or environment.
describe('guarded in-memory waiter reentrancy with synthetic faults', () => {
    it('never calls the replaceable legacy waiter splice while handing a token to a guarded waiter', async () => {
        const q = guarded();
        const c = controller();
        const legacyWaiters = (q as unknown as { waiters: unknown[] }).waiters;
        const originalSplice = legacyWaiters.splice;
        const splice = vi.spyOn(legacyWaiters, 'splice').mockImplementation((...args) => {
            c.abort();
            return Reflect.apply(originalSplice, legacyWaiters, args);
        });
        const observation = observe(q.reserveGuarded({ timeoutMs: 100, signal: c.signal }));
        expect(q.stats()).toMatchObject({ waiters: 1, reserved: 0 });
        expect(getEventListeners(c.signal, 'abort')).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(1);

        const event = message('selected');
        expect(q.enqueue(event)).toBe('accepted');
        expect(splice).not.toHaveBeenCalled();
        const selection = reserved(await settled(observation));
        expect(selection.eventsJson).toBe(JSON.stringify([event]));
        expect(selection.count).toBe(1);
        expect(q.stats()).toMatchObject({ count: 1, waiters: 0, reserved: 1 });
        expect(getEventListeners(c.signal, 'abort')).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);

        // An abort after delivery does not take ownership away from the caller.
        c.abort();
        expect(q.stats().reserved).toBe(1);
        expect(q.releaseGuardedNoDrain(selection.token)).toEqual({ status: 'released' });
        expect(q.releaseGuardedNoDrain(selection.token)).toEqual({ status: 'stale' });
        expect(q.stats()).toMatchObject({ count: 1, waiters: 0, reserved: 0 });
        expect(q.close()).toBe(true);
        expect(q.close()).toBe(false);
        expect(q.releaseGuardedNoDrain(selection.token)).toEqual({ status: 'stale' });
        expect(q.stats()).toMatchObject({ count: 0, waiters: 0, reserved: 0, closed: true });
        expect(splice).not.toHaveBeenCalled();
    });

    it('expires the first guarded waiter before reserving for the second after a synthetic clock jump under a receipt barrier', async () => {
        const q = guarded();
        const firstController = controller();
        const secondController = controller();
        let now = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);

        try {
            const consumed = message('previously-consumed');
            const next = message('next-event');
            expect(q.enqueue(consumed)).toBe('accepted');
            const selected = reserved(await settled(observe(q.reserveGuarded())));
            expect(selected.eventsJson).toBe(JSON.stringify([consumed]));
            const receipt = q.commitGuardedNoDrain(selected.token, selected);
            expect(receipt).toEqual({ status: 'committed' });
            expect(Object.isFrozen(receipt)).toBe(true);

            const first = observe(
                q.reserveGuarded({ timeoutMs: 10, signal: firstController.signal }),
            );
            const second = observe(
                q.reserveGuarded({ timeoutMs: 100, signal: secondController.signal }),
            );
            expect(q.stats()).toMatchObject({ count: 0, waiters: 2, reserved: 0 });
            expect(vi.getTimerCount()).toBe(2);
            expect(getEventListeners(firstController.signal, 'abort')).toHaveLength(1);
            expect(getEventListeners(secondController.signal, 'abort')).toHaveLength(1);

            // Move only the synthetic monotonic reading: do not fire or advance
            // fake timers. The receipt barrier still prevents selection.
            now = 10;
            expect(q.enqueue(next)).toBe('accepted');
            await Promise.resolve();
            expect(first).toHaveLength(0);
            expect(second).toHaveLength(0);
            expect(q.stats()).toMatchObject({ count: 1, waiters: 2, reserved: 0 });
            expect(vi.getTimerCount()).toBe(2);

            expect(q.resumeGuardedDrain(receipt)).toEqual({ status: 'resumed' });
            expect(await settled(first)).toEqual({ status: 'timeout' });
            const nextSelection = reserved(await settled(second));
            expect(nextSelection.eventsJson).toBe(JSON.stringify([next]));
            expect(q.stats()).toMatchObject({ count: 1, waiters: 0, reserved: 1 });
            expect(getEventListeners(firstController.signal, 'abort')).toHaveLength(0);
            expect(getEventListeners(secondController.signal, 'abort')).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(0);
            expect(q.releaseGuardedNoDrain(nextSelection.token)).toEqual({ status: 'released' });
            expect(q.close()).toBe(true);
            expectCleanWaiter(q, firstController.signal);
        } finally {
            clock.mockRestore();
        }
    });

    it('preserves a known commit when a synthetic clock throws during receipt resume', async () => {
        const q = guarded();
        const firstController = controller();
        const secondController = controller();
        const consumed = message('committed-event-with-distinct-length');
        const next = message('next');
        expect(q.enqueue(consumed)).toBe('accepted');
        const selected = reserved(await settled(observe(q.reserveGuarded())));
        expect(selected.eventsJson).toBe(JSON.stringify([consumed]));
        const receipt = q.commitGuardedNoDrain(selected.token, selected);
        expect(receipt).toEqual({ status: 'committed' });
        expect(Object.isFrozen(receipt)).toBe(true);
        expect(q.stats()).toMatchObject({ count: 0, queueBytes: 2, reserved: 0 });

        const first = observe(q.reserveGuarded({ timeoutMs: 100, signal: firstController.signal }));
        const second = observe(
            q.reserveGuarded({ timeoutMs: 100, signal: secondController.signal }),
        );
        expect(q.enqueue(next)).toBe('accepted');
        const nextBytes = Buffer.byteLength(JSON.stringify([next]), 'utf8');
        expect(nextBytes).not.toBe(Buffer.byteLength(JSON.stringify([consumed]), 'utf8'));
        expect(q.stats()).toMatchObject({
            count: 1,
            queueBytes: nextBytes,
            waiters: 2,
            reserved: 0,
        });
        expect(vi.getTimerCount()).toBe(2);
        const clock = vi.spyOn(performance, 'now').mockImplementationOnce(() => {
            throw new Error('synthetic clock failure during receipt resume');
        });
        let resumed: ReturnType<BufferInstance['resumeGuardedDrain']>;

        try {
            resumed = q.resumeGuardedDrain(receipt);
        } finally {
            clock.mockRestore();
        }

        expect(resumed).toEqual({ status: 'uncertain' });
        expect(receipt).toEqual({ status: 'committed' });
        expect(q.commitGuardedNoDrain(selected.token, selected)).toEqual({ status: 'stale' });
        expect(await settled(first)).toEqual({ status: 'uncertain' });
        expect(await settled(observe(q.reserveGuarded()))).toEqual({ status: 'uncertain' });
        expect(q.enqueue(message('retry'))).toBe('uncertain');
        expect(q.stats()).toMatchObject({ count: 1, queueBytes: nextBytes, reserved: 0 });
        expect(q.guardedCleanupState()).toBe('uncertain');

        // A future implementation may settle all waiters at quarantine; if a
        // waiter remains, explicit close must settle it without a real wait.
        await Promise.resolve();

        if (second.length === 0) {
            expect(q.stats().waiters).toBe(1);
        }

        expect(q.close()).toBe(true);
        const secondResult = await settled(second);
        expect(['closed', 'uncertain']).toContain(secondResult.status);
        expect(q.guardedCleanupState()).toBe('uncertain');
        expect(q.stats()).toMatchObject({ count: 0, waiters: 0, reserved: 0, closed: true });
        expectCleanWaiter(q, firstController.signal);
        expect(getEventListeners(secondController.signal, 'abort')).toHaveLength(0);
    });

    it.each([false, true])(
        'keeps reentrant close pending through selected waiter cleanup (clear throws: %s)',
        async (throwAfterClear) => {
            const q = guarded();
            const c = controller();
            const observation = observe(q.reserveGuarded({ timeoutMs: 100, signal: c.signal }));
            expect(q.stats()).toMatchObject({ waiters: 1, reserved: 0 });
            expect(getEventListeners(c.signal, 'abort')).toHaveLength(1);
            expect(vi.getTimerCount()).toBe(1);
            const event = message('close-during-cleanup');
            const fakeClear = globalThis.clearTimeout;
            let calls = 0;
            let nestedClose: boolean | undefined;
            let beforeClose: { waiters: number; reserved: number; timers: number } | undefined;
            let afterClose: { state: string; timers: number } | undefined;
            const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timer) => {
                calls++;

                if (calls === 1) {
                    beforeClose = {
                        waiters: q.stats().waiters,
                        reserved: q.stats().reserved,
                        timers: vi.getTimerCount(),
                    };
                    nestedClose = q.close();
                    afterClose = { state: q.guardedCleanupState(), timers: vi.getTimerCount() };
                    fakeClear(timer);

                    if (throwAfterClear) {
                        throw new Error('synthetic clearTimeout failure after physical clear');
                    }

                    return;
                }

                fakeClear(timer);
            });
            let admission: ReturnType<BufferInstance['enqueue']> | undefined;
            let threw = false;

            try {
                admission = q.enqueue(event);
            } catch {
                threw = true;
            } finally {
                clear.mockRestore();
            }

            expect(calls).toBeGreaterThanOrEqual(1);
            expect(beforeClose).toEqual({ waiters: 0, reserved: 1, timers: 1 });
            expect(nestedClose).toBe(true);
            expect(afterClose).toEqual({ state: 'closing', timers: 1 });

            if (!throwAfterClear) {
                expect(threw).toBe(false);
                expect(admission).toBe('accepted');
            }

            // Closing may revoke the token, but the selected caller still owns
            // the returned result even when the synthetic cleanup call throws.
            const selection = reserved(await settled(observation));
            expect(selection.eventsJson).toBe(JSON.stringify([event]));
            expect(q.stats()).toMatchObject({ count: 0, waiters: 0, reserved: 0, closed: true });
            expect(q.releaseGuardedNoDrain(selection.token)).toEqual({ status: 'stale' });
            expect(q.guardedCleanupState()).toBe(throwAfterClear ? 'uncertain' : 'closed');
            expect(q.close()).toBe(false);
            expect(q.guardedCleanupState()).toBe(throwAfterClear ? 'uncertain' : 'closed');
            expectCleanWaiter(q, c.signal);
        },
    );

    it('keeps reentrant close pending until a synthetic setTimeout returns and its timer is cleared', async () => {
        const q = guarded();
        const c = controller();
        const fakeSet = globalThis.setTimeout;
        let calls = 0;
        let nestedClose: boolean | undefined;
        let beforeClose: { waiters: number; listeners: number; timers: number } | undefined;
        let afterClose: { state: string; timers: number } | undefined;
        const set = vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args) => {
            const timer = Reflect.apply(fakeSet, globalThis, args) as ReturnType<typeof setTimeout>;
            calls++;

            if (calls === 1) {
                beforeClose = {
                    waiters: q.stats().waiters,
                    listeners: getEventListeners(c.signal, 'abort').length,
                    timers: vi.getTimerCount(),
                };
                nestedClose = q.close();
                afterClose = { state: q.guardedCleanupState(), timers: vi.getTimerCount() };
            }

            return timer;
        });
        let observation: Observation[];

        try {
            observation = observe(q.reserveGuarded({ timeoutMs: 100, signal: c.signal }));
        } finally {
            set.mockRestore();
        }

        expect(calls).toBe(1);
        expect(beforeClose).toEqual({ waiters: 1, listeners: 1, timers: 1 });
        expect(nestedClose).toBe(true);
        expect(afterClose).toEqual({ state: 'closing', timers: 1 });
        expect(await settled(observation)).toEqual({ status: 'closed' });
        expect(q.guardedCleanupState()).toBe('closed');
        expect(q.close()).toBe(false);
        expectCleanWaiter(q, c.signal);
    });

    it('keeps cleanup uncertainty sticky while settling other waiters after one synthetic clear failure', async () => {
        const q = guarded();
        const first = controller();
        const second = controller();
        const a = observe(q.reserveGuarded({ timeoutMs: 100, signal: first.signal }));
        const b = observe(q.reserveGuarded({ timeoutMs: 100, signal: second.signal }));
        expect(q.stats().waiters).toBe(2);
        expect(vi.getTimerCount()).toBe(2);
        const fakeClear = globalThis.clearTimeout;
        let intercepted = false;
        let retainedTimer: Parameters<typeof clearTimeout>[0] | undefined;
        const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timer) => {
            if (!intercepted) {
                intercepted = true;
                retainedTimer = timer;
                throw new Error('synthetic clearTimeout failure before physical clear');
            }

            fakeClear(timer);
        });

        try {
            q.close();
        } catch {
            // A failed close may surface an exception; the sticky state and
            // every waiter's settlement are checked independently below.
        } finally {
            clear.mockRestore();
        }

        const timersBeforeExplicitClear = vi.getTimerCount();
        const cleanupState = q.guardedCleanupState();
        const firstListeners = getEventListeners(first.signal, 'abort').length;
        const secondListeners = getEventListeners(second.signal, 'abort').length;

        // The injected failure deliberately prevented the first clear. Remove
        // exactly that captured fake timer after restoring the spy, not in
        // afterEach, while retaining the pre-clear count as evidence.
        if (intercepted && retainedTimer !== undefined) {
            fakeClear(retainedTimer);
        }

        expect(intercepted).toBe(true);
        expect(timersBeforeExplicitClear).toBe(1);
        expect(cleanupState).toBe('uncertain');
        expect(firstListeners).toBe(0);
        expect(secondListeners).toBe(0);
        expect(await settled(a)).toEqual({ status: 'closed' });
        expect(await settled(b)).toEqual({ status: 'closed' });
        expect(q.stats()).toMatchObject({ count: 0, waiters: 0, reserved: 0, closed: true });
        expect(q.close()).toBe(false);
        expect(q.guardedCleanupState()).toBe('uncertain');
        expectCleanWaiter(q, first.signal);
        expect(getEventListeners(second.signal, 'abort')).toHaveLength(0);
    });

    it.each(['close', 'abort'] as const)(
        'does not create a timer when a synthetic second clock read synchronously invokes %s',
        async (action) => {
            const q = guarded();
            const c = controller();
            const setTimer = vi.spyOn(globalThis, 'setTimeout');
            let reads = 0;
            let atReentry: { waiters: number; listeners: number; timers: number } | undefined;
            const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
                reads++;

                if (reads === 2) {
                    atReentry = {
                        waiters: q.stats().waiters,
                        listeners: getEventListeners(c.signal, 'abort').length,
                        timers: vi.getTimerCount(),
                    };

                    if (action === 'close') {
                        q.close();
                    } else {
                        c.abort();
                    }
                }

                return 0;
            });
            let observation: Observation[];

            try {
                observation = observe(q.reserveGuarded({ timeoutMs: 100, signal: c.signal }));
            } finally {
                clock.mockRestore();
            }

            expect(atReentry).toEqual({ waiters: 1, listeners: 1, timers: 0 });
            expect(await settled(observation)).toEqual({
                status: action === 'close' ? 'closed' : 'aborted',
            });
            expect(setTimer).not.toHaveBeenCalled();
            expectCleanWaiter(q, c.signal);
            expect(q.close()).toBe(action === 'abort');
            expectCleanWaiter(q, c.signal);
        },
    );

    it('does not rearm an early synthetic expiry after its clock callback closes the queue', async () => {
        const q = guarded();
        const c = controller();
        const setTimer = vi.spyOn(globalThis, 'setTimeout');
        let expiring = false;
        let sawExpiry = false;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
            if (expiring) {
                expiring = false;
                sawExpiry = true;
                q.close();
            }

            // The fake timer advances but this separately controlled clock does
            // not, so the expiry sees a strictly positive remaining deadline.
            return 0;
        });
        const observation = observe(q.reserveGuarded({ timeoutMs: 100, signal: c.signal }));
        expect(q.stats().waiters).toBe(1);
        expect(getEventListeners(c.signal, 'abort')).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(1);
        expect(setTimer).toHaveBeenCalledTimes(1);
        expiring = true;

        try {
            vi.advanceTimersByTime(100);
        } finally {
            clock.mockRestore();
        }

        expect(sawExpiry).toBe(true);
        expect(await settled(observation)).toEqual({ status: 'closed' });
        expect(setTimer).toHaveBeenCalledTimes(1);
        expectCleanWaiter(q, c.signal);
        expect(q.stats().closed).toBe(true);
    });

    it('prioritizes guarded closed or uncertain state over invalid and aborted inputs without changing legacy precedence', async () => {
        const closed = guarded();
        const alreadyAborted = controller();
        alreadyAborted.abort();
        expect(closed.close()).toBe(true);
        expect(await settled(observe(closed.reserveGuarded({ timeoutMs: -1 })))).toEqual({
            status: 'closed',
        });
        expect(
            await settled(observe(closed.reserveGuarded({ signal: alreadyAborted.signal }))),
        ).toEqual({
            status: 'closed',
        });
        expect(
            await settled(
                observe(
                    closed.reserveGuarded({
                        timeoutMs: -1,
                        signal: alreadyAborted.signal,
                    }),
                ),
            ),
        ).toEqual({ status: 'closed' });

        const uncertain = guarded();
        const active = controller();
        const clock = vi.spyOn(performance, 'now').mockImplementationOnce(() => {
            throw new Error('synthetic first clock failure for input precedence');
        });
        let failed: Observation[];

        try {
            failed = observe(uncertain.reserveGuarded({ timeoutMs: 100, signal: active.signal }));
        } finally {
            clock.mockRestore();
        }

        expect(await settled(failed)).toEqual({ status: 'uncertain' });
        expect(await settled(observe(uncertain.reserveGuarded({ timeoutMs: -1 })))).toEqual({
            status: 'uncertain',
        });
        expect(
            await settled(observe(uncertain.reserveGuarded({ signal: alreadyAborted.signal }))),
        ).toEqual({
            status: 'uncertain',
        });
        expect(
            await settled(
                observe(
                    uncertain.reserveGuarded({
                        timeoutMs: 100,
                        signal: active.signal,
                    }),
                ),
            ),
        ).toEqual({ status: 'uncertain' });
        expect(uncertain.stats()).toMatchObject({ waiters: 0, reserved: 0 });
        expect(getEventListeners(active.signal, 'abort')).toHaveLength(0);
        expect(getEventListeners(alreadyAborted.signal, 'abort')).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(uncertain.close()).toBe(true);

        const legacy = new EventPollBuffer(config);
        buffers.push(legacy);
        expect(legacy.close()).toBe(true);
        expect(await settled(observe(legacy.reserve({ timeoutMs: -1 })))).toEqual({
            status: 'invalid',
        });
        expect(await settled(observe(legacy.reserve({ signal: alreadyAborted.signal })))).toEqual({
            status: 'aborted',
        });
        expect(
            await settled(
                observe(
                    legacy.reserve({
                        timeoutMs: -1,
                        signal: alreadyAborted.signal,
                    }),
                ),
            ),
        ).toEqual({ status: 'invalid' });
        expect(legacy.stats()).toMatchObject({ waiters: 0, reserved: 0, closed: true });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps first-clock reentrant close closing until a subsequent synthetic throw makes it uncertain', async () => {
        const q = guarded();
        const c = controller();
        let nestedClose: boolean | undefined;
        let during: string | undefined;
        const clock = vi.spyOn(performance, 'now').mockImplementationOnce(() => {
            nestedClose = q.close();
            during = q.guardedCleanupState();
            throw new Error('synthetic first clock failure after reentrant close');
        });
        let observation: Observation[];

        try {
            observation = observe(q.reserveGuarded({ timeoutMs: 100, signal: c.signal }));
        } finally {
            clock.mockRestore();
        }

        expect(nestedClose).toBe(true);
        expect(during).toBe('closing');
        const result = await settled(observation);
        expect(['closed', 'uncertain']).toContain(result.status);
        expect(q.guardedCleanupState()).toBe('uncertain');
        expect(q.close()).toBe(false);
        expect(q.guardedCleanupState()).toBe('uncertain');
        expectCleanWaiter(q, c.signal);
    });

    it('retains an already-published event when a synthetic enqueue drain clock throws', async () => {
        const q = guarded();
        const c = controller();
        const observation = observe(q.reserveGuarded({ timeoutMs: 100, signal: c.signal }));
        expect(q.stats()).toMatchObject({ count: 0, waiters: 1, reserved: 0 });
        expect(getEventListeners(c.signal, 'abort')).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(1);
        const event = message('published-before-drain-failure');
        const clock = vi.spyOn(performance, 'now').mockImplementationOnce(() => {
            throw new Error('synthetic clock failure after enqueue publication');
        });
        let admission: ReturnType<BufferInstance['enqueue']> | undefined;
        let threw = false;

        try {
            admission = q.enqueue(event);
        } catch {
            threw = true;
        } finally {
            clock.mockRestore();
        }

        expect(threw || admission === 'accepted' || admission === 'uncertain').toBe(true);
        expect(await settled(observation)).toEqual({ status: 'uncertain' });
        expect(q.stats()).toMatchObject({
            count: 1,
            queueBytes: Buffer.byteLength(JSON.stringify([event]), 'utf8'),
            waiters: 0,
            reserved: 0,
        });
        expect(q.guardedCleanupState()).toBe('uncertain');
        expectCleanWaiter(q, c.signal);
        // A retry is explicitly quarantined; it cannot insert a duplicate of A.
        expect(q.enqueue(event)).toBe('uncertain');
        expect(q.stats().count).toBe(1);
        expect(q.close()).toBe(true);
        expect(q.guardedCleanupState()).toBe('uncertain');
        expect(q.stats()).toMatchObject({ count: 0, waiters: 0, reserved: 0, closed: true });
        expectCleanWaiter(q, c.signal);
    });

    it('quarantines a synthetic clock throw before timer creation without a rejected phantom waiter', async () => {
        const q = guarded();
        const c = controller();
        const setTimer = vi.spyOn(globalThis, 'setTimeout');
        let reads = 0;
        let atFailure: { waiters: number; listeners: number; timers: number } | undefined;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
            reads++;

            if (reads === 2) {
                atFailure = {
                    waiters: q.stats().waiters,
                    listeners: getEventListeners(c.signal, 'abort').length,
                    timers: vi.getTimerCount(),
                };
                throw new Error('synthetic scheduling clock failure');
            }

            return 0;
        });
        let observation: Observation[];

        try {
            observation = observe(q.reserveGuarded({ timeoutMs: 100, signal: c.signal }));
        } finally {
            clock.mockRestore();
        }

        expect(atFailure).toEqual({ waiters: 1, listeners: 1, timers: 0 });
        expect(await settled(observation)).toEqual({ status: 'uncertain' });
        expect(setTimer).not.toHaveBeenCalled();
        expectCleanWaiter(q, c.signal);
        expect(q.enqueue(message('after-failure'))).toBe('uncertain');
        expect(await settled(observe(q.reserveGuarded()))).toEqual({ status: 'uncertain' });
        expect(q.stats()).toMatchObject({ count: 0, waiters: 0, reserved: 0 });
        expect(q.close()).toBe(true);
        expectCleanWaiter(q, c.signal);
    });

    it('quarantines a synthetic first drain clock throw after registering timer and listener', async () => {
        const q = guarded();
        const c = controller();
        let reads = 0;
        let atFailure: { waiters: number; listeners: number; timers: number } | undefined;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
            reads++;

            if (reads === 3) {
                atFailure = {
                    waiters: q.stats().waiters,
                    listeners: getEventListeners(c.signal, 'abort').length,
                    timers: vi.getTimerCount(),
                };
                throw new Error('synthetic drain clock failure');
            }

            return 0;
        });
        let observation: Observation[];

        try {
            observation = observe(q.reserveGuarded({ timeoutMs: 100, signal: c.signal }));
        } finally {
            clock.mockRestore();
        }

        expect(atFailure).toEqual({ waiters: 1, listeners: 1, timers: 1 });
        expect(await settled(observation)).toEqual({ status: 'uncertain' });
        expectCleanWaiter(q, c.signal);
        expect(q.enqueue(message('after-drain-failure'))).toBe('uncertain');
        expect(await settled(observe(q.reserveGuarded()))).toEqual({ status: 'uncertain' });
        expect(q.close()).toBe(true);
        expectCleanWaiter(q, c.signal);
    });

    it('delivers an already-selected token even if its synthetic outer clock callback then throws', async () => {
        const q = guarded();
        const c = controller();
        const event = message('nested-selection');
        let reads = 0;
        let admission: string | undefined;
        let selectedBeforeThrow: { waiters: number; reserved: number } | undefined;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
            reads++;

            if (reads === 2) {
                // The nested enqueue drains using a third, successful clock read.
                admission = q.enqueue(event);
                selectedBeforeThrow = {
                    waiters: q.stats().waiters,
                    reserved: q.stats().reserved,
                };
                throw new Error('synthetic outer clock failure after selection');
            }

            return 0;
        });
        let observation: Observation[];

        try {
            observation = observe(q.reserveGuarded({ timeoutMs: 100, signal: c.signal }));
        } finally {
            clock.mockRestore();
        }

        expect(admission).toBe('accepted');
        expect(selectedBeforeThrow).toEqual({ waiters: 0, reserved: 1 });
        const selection = reserved(await settled(observation));
        expect(selection.eventsJson).toBe(JSON.stringify([event]));
        expect(getEventListeners(c.signal, 'abort')).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
        // The synthetic fault may quarantine an already-delivered token. Either
        // local release or explicit uncertainty preserves its caller ownership.
        const release = q.releaseGuardedNoDrain(selection.token);
        expect(['released', 'uncertain']).toContain(release.status);
        expect(q.close()).toBe(true);
        expect(q.releaseGuardedNoDrain(selection.token)).toEqual({ status: 'stale' });
        expectCleanWaiter(q, c.signal);
    });

    it('settles rather than stranding a timerless waiter when a synthetic expiry clock throws', async () => {
        const q = guarded();
        const c = controller();
        let expiring = false;
        let atFailure: { waiters: number; listeners: number } | undefined;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
            if (expiring) {
                expiring = false;
                atFailure = {
                    waiters: q.stats().waiters,
                    listeners: getEventListeners(c.signal, 'abort').length,
                };
                throw new Error('synthetic expiry clock failure');
            }

            return 0;
        });
        const observation = observe(q.reserveGuarded({ timeoutMs: 100, signal: c.signal }));
        expect(q.stats().waiters).toBe(1);
        expect(vi.getTimerCount()).toBe(1);
        expiring = true;

        try {
            vi.advanceTimersByTime(100);
        } finally {
            clock.mockRestore();
        }

        expect(atFailure).toEqual({ waiters: 1, listeners: 1 });
        expect(await settled(observation)).toEqual({ status: 'uncertain' });
        expectCleanWaiter(q, c.signal);
        expect(q.enqueue(message('after-expiry-failure'))).toBe('uncertain');
        expect(q.close()).toBe(true);
        expectCleanWaiter(q, c.signal);
    });
});
