import { addAbortListener } from 'node:events';
import { isPromise, isProxy } from 'node:util/types';
import type { SsoHeartbeatOutcome } from './sso-reference-heartbeat-flow';
import type { WtReferenceSession } from './wt-reference-session';

export type SsoHeartbeatSchedulerEvent =
    | { type: 'started' }
    | { type: 'result'; outcome: SsoHeartbeatOutcome }
    | { type: 'skipped'; count: number; reason: 'busy' | 'late' }
    | {
          type: 'failed';
          reason:
              'heartbeat-error' | 'sso-error' | 'invalid-outcome' | 'timer-error' | 'clock-error';
      }
    | { type: 'interrupt-error' }
    | { type: 'timer-cleanup-error' }
    | { type: 'stopped' };

export interface SsoHeartbeatSchedulerTimer {
    now(): number;
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}

export interface SsoHeartbeatSchedulerOptions {
    periodMs?: number;
    timer?: SsoHeartbeatSchedulerTimer;
    signal?: AbortSignal;
    onInterrupt?: (signal: AbortSignal) => void;
    onEvent?: (event: SsoHeartbeatSchedulerEvent) => void;
}

export type SsoHeartbeatSchedulerState = 'new' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface SsoHeartbeatScheduler {
    getState(): SsoHeartbeatSchedulerState;
    start(): void;
    stop(): Promise<void>;
    close(): Promise<void>;
}

const DEFAULT_PERIOD_MS = 270_000;
const MAX_DELAY_MS = 0x7fffffff;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const then = Promise.prototype.then;

/**
 * Explicitly started, caller-owned scheduler; construction has no session effects.
 * The default fixed period follows the V2 timer, not the response interval:
 * https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Logic/WtExchangeLogic.cs#L384-L422
 * Single-flight and skipped ticks are conservative local policies, not V2 timer
 * equivalence. The separate Heartbeat.Alive is outside this scheduler. A locally
 * classified response, including missing-interval, does not establish online state.
 *
 * The injected timer must defer callbacks and use a nondecreasing millisecond clock.
 * The caller must exclusively coordinate other uses of the session. heartbeat()
 * does not accept an AbortSignal. On stop, an optional caller-owned onInterrupt is
 * passed an already-aborted signal; it may decide to close its owner. The scheduler
 * never closes or poisons the owner itself. stop()/close() wait for in-flight work;
 * a permanently pending heartbeat leaves them pending. Monitor and interrupt
 * callbacks must synchronously return void; synchronous exceptions are contained,
 * while asynchronous effects and rejected promises remain caller-owned. Standard
 * Promise species and untampered intrinsics are assumed; foreign thenables can
 * execute code during assimilation and can hide another promise.
 */
export function createSsoHeartbeatScheduler(
    session: Pick<WtReferenceSession, 'heartbeat'>,
    options: SsoHeartbeatSchedulerOptions = {},
): SsoHeartbeatScheduler {
    const period = options.periodMs === undefined ? DEFAULT_PERIOD_MS : options.periodMs;
    const timer: SsoHeartbeatSchedulerTimer = options.timer ?? {
        now: () => performance.now(),
        setTimeout: (callback, delay) => setTimeout(callback, delay),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    const { signal, onInterrupt, onEvent } = options;

    if (
        !session ||
        typeof session.heartbeat !== 'function' ||
        !Number.isInteger(period) ||
        period < 1 ||
        period > MAX_DELAY_MS ||
        !timer ||
        typeof timer.now !== 'function' ||
        typeof timer.setTimeout !== 'function' ||
        typeof timer.clearTimeout !== 'function' ||
        (signal !== undefined &&
            (isProxy(signal) ||
                typeof signal !== 'object' ||
                signal === null ||
                Object.getPrototypeOf(signal) !== AbortSignal.prototype ||
                Object.hasOwn(signal, 'aborted') ||
                Object.hasOwn(signal, 'addEventListener') ||
                Object.hasOwn(signal, 'removeEventListener'))) ||
        (onInterrupt !== undefined && typeof onInterrupt !== 'function') ||
        (onEvent !== undefined && typeof onEvent !== 'function')
    ) {
        throw new TypeError('invalid heartbeat scheduler configuration');
    }

    if (signal !== undefined) {
        try {
            aborted.call(signal);
        } catch {
            throw new TypeError('invalid heartbeat scheduler signal');
        }
    }

    let state: SsoHeartbeatSchedulerState = 'new';
    let lastNow = -1;
    let nextAt = 0;
    type TimerSlot = { handle: unknown; valid: boolean; registered: boolean; cleared: boolean };
    let activeTimer: TimerSlot | undefined;
    let busy = false;
    let heartbeatPending = false;
    let inFlight: Promise<void> | undefined;
    let finishFlight: (() => void) | undefined;
    let interruptCalled = false;
    let abortListener: ReturnType<typeof addAbortListener> | undefined;
    const controller = new AbortController();

    const emit = (event: SsoHeartbeatSchedulerEvent): void => {
        try {
            onEvent?.(event);
        } catch {
            // Monitoring is not allowed to alter scheduler transitions.
        }
    };

    const detachSignal = (): void => {
        const listener = abortListener;
        abortListener = undefined;

        if (listener) {
            try {
                listener[Symbol.dispose]();
            } catch {
                // A stale listener is harmless after the state fence.
            }
        }
    };

    const releaseTimer = (slot: TimerSlot): boolean => {
        slot.valid = false;

        if (!slot.registered || slot.cleared) {
            return true;
        }

        // Mark first: an injected clearTimeout can synchronously reenter stop().
        slot.cleared = true;

        try {
            timer.clearTimeout(slot.handle);
            return true;
        } catch {
            return false;
        }
    };

    const clearTimer = (): boolean => {
        const current = activeTimer;
        activeTimer = undefined;
        return current ? releaseTimer(current) : true;
    };

    const interrupt = (pending = true): void => {
        controller.abort();

        if (pending && heartbeatPending && !interruptCalled && onInterrupt) {
            interruptCalled = true;

            try {
                onInterrupt(controller.signal);
            } catch {
                emit({ type: 'interrupt-error' });
            }
        }
    };

    const fail = (
        reason: Extract<SsoHeartbeatSchedulerEvent, { type: 'failed' }>['reason'],
        pending = true,
    ): void => {
        if (state !== 'running') {
            return;
        }

        state = 'failed';

        if (!clearTimer()) {
            emit({ type: 'timer-cleanup-error' });
        }

        detachSignal();
        interrupt(pending);
        emit({ type: 'failed', reason });
    };

    const readNow = (): number | undefined => {
        try {
            const value = timer.now();

            if (
                !Number.isFinite(value) ||
                value < 0 ||
                value < lastNow ||
                value > Number.MAX_SAFE_INTEGER - 2 * period
            ) {
                throw new Error('invalid monotonic time');
            }

            lastNow = value;
            return value;
        } catch {
            fail('clock-error');
            return undefined;
        }
    };

    const advance = (now: number, reason: 'busy' | 'late', leaveOne: boolean): void => {
        const due = Math.floor((now - nextAt) / period) + 1;
        const skipped = due - (leaveOne ? 1 : 0);

        if (
            !Number.isSafeInteger(due) ||
            due < 1 ||
            !Number.isFinite(nextAt + due * period) ||
            nextAt + due * period > Number.MAX_SAFE_INTEGER - period
        ) {
            fail('clock-error');
            return;
        }

        nextAt += due * period;

        if (skipped > 0) {
            emit({ type: 'skipped', count: skipped, reason });
        }
    };

    const arm = (): void => {
        if (state !== 'running' || activeTimer) {
            return;
        }

        const now = readNow();

        if (now === undefined || state !== 'running') {
            return;
        }

        const slot: TimerSlot = {
            handle: undefined,
            valid: true,
            registered: false,
            cleared: false,
        };
        activeTimer = slot;
        let registering = true;
        let synchronous = false;

        try {
            slot.handle = timer.setTimeout(
                () => {
                    if (registering) {
                        synchronous = true;
                        return;
                    }

                    if (!slot.valid || activeTimer !== slot || state !== 'running') {
                        return;
                    }

                    slot.valid = false;
                    activeTimer = undefined;
                    tick();
                },
                Math.max(1, Math.ceil(nextAt - now)),
            );
            slot.registered = true;
            registering = false;

            // A timer adapter may synchronously stop us before it returns the handle.
            // Only now can that handle be released; stale callbacks were fenced already.
            if (!slot.valid || activeTimer !== slot || state !== 'running') {
                if (!releaseTimer(slot)) {
                    emit({ type: 'timer-cleanup-error' });
                }
            } else if (synchronous) {
                fail('timer-error');
            }
        } catch {
            registering = false;
            fail('timer-error');
        }
    };

    const settle = (value: unknown, rejected: boolean): void => {
        // The owner's operation has settled, but busy/inFlight still fence all
        // result observers and scheduler cleanup until this continuation finishes.
        heartbeatPending = false;

        if (state === 'running') {
            if (rejected) {
                fail('heartbeat-error', false);
            } else {
                let outcome: SsoHeartbeatOutcome | undefined;

                try {
                    if (value && typeof value === 'object' && !isProxy(value)) {
                        const ownValue = (key: string): unknown => {
                            const descriptor = Object.getOwnPropertyDescriptor(value, key);
                            return descriptor && 'value' in descriptor
                                ? descriptor.value
                                : undefined;
                        };

                        const status = ownValue('status');

                        if (status === 'success') {
                            const interval = ownValue('interval');

                            if (
                                typeof interval === 'bigint' &&
                                interval >= 0n &&
                                interval <= 0xffffffffffffffffn
                            ) {
                                outcome = { status: 'success', interval };
                            }
                        } else if (status === 'missing-interval') {
                            outcome = { status: 'missing-interval' };
                        } else if (status === 'sso-error') {
                            const retCode = ownValue('retCode');

                            if (
                                typeof retCode === 'number' &&
                                Number.isInteger(retCode) &&
                                retCode >= -0x80000000 &&
                                retCode <= 0x7fffffff &&
                                retCode !== 0
                            ) {
                                outcome = { status: 'sso-error', retCode };
                            }
                        }
                    }
                } catch {
                    // Invalid caller-supplied outcomes fail closed.
                }

                if (!outcome) {
                    fail('invalid-outcome', false);
                } else if (outcome.status === 'sso-error') {
                    fail('sso-error', false);
                    emit({ type: 'result', outcome });
                } else {
                    emit({ type: 'result', outcome });
                }
            }
        }

        if (state === 'running') {
            const now = readNow();

            if (now !== undefined && state === 'running' && now >= nextAt) {
                if (!clearTimer()) {
                    fail('timer-error');
                } else {
                    advance(now, 'busy', false);
                }
            }
        }

        busy = false;
        const done = finishFlight;
        finishFlight = undefined;
        inFlight = undefined;
        done?.();

        if (state === 'running') {
            arm();
        } else if (state === 'stopping') {
            state = 'stopped';
            emit({ type: 'stopped' });
        }
    };

    const launch = (): void => {
        if (state !== 'running' || busy) {
            return;
        }

        busy = true;
        heartbeatPending = true;
        inFlight = new Promise<void>((resolve) => {
            finishFlight = resolve;
        });

        try {
            const result = session.heartbeat();
            const observed = isPromise(result) ? result : Promise.resolve(result);
            void then.call(
                observed,
                (value: unknown) => settle(value, false),
                () => settle(undefined, true),
            );
        } catch {
            settle(undefined, true);
        }
    };

    const tick = (): void => {
        const now = readNow();

        if (now === undefined || state !== 'running') {
            return;
        }

        if (now < nextAt) {
            arm();
            return;
        }

        const wasBusy = busy;
        advance(now, wasBusy ? 'busy' : 'late', !wasBusy);

        if (state !== 'running') {
            return;
        }

        if (!wasBusy) {
            launch();
        }

        arm();
    };

    const stop = (): Promise<void> => {
        if (state === 'new' || state === 'running') {
            state = busy ? 'stopping' : 'stopped';

            if (!clearTimer()) {
                emit({ type: 'timer-cleanup-error' });
            }

            detachSignal();
            interrupt();

            if (state === 'stopped') {
                emit({ type: 'stopped' });
            }
        }

        return inFlight ?? Promise.resolve();
    };

    function onAbort(): void {
        void stop();
    }

    return {
        getState: () => state,
        start() {
            if (state !== 'new') {
                throw new Error('heartbeat scheduler already started or stopped');
            }

            state = 'running';

            if (signal) {
                abortListener = addAbortListener(signal, onAbort);

                if (aborted.call(signal)) {
                    void stop();
                    return;
                }
            }

            const now = readNow();

            if (now === undefined || state !== 'running') {
                return;
            }

            nextAt = now + period;
            emit({ type: 'started' });

            if (state === 'running') {
                launch();
                arm();
            }
        },
        stop,
        close: stop,
    };
}
