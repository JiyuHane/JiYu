import { types as utilTypes } from 'node:util';
import { addAbortListener } from 'node:events';
import type {
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from './sso12-packet-client';

export interface RawSessionLease extends Sso12RawTransport {
    readonly whenClosed: Promise<'released' | 'poisoned'>;
    release(): void;
    poison(): void;
    close(): void;
}
export interface RawSessionBroker {
    acquire(options: { deadline: number; signal?: AbortSignal }): RawSessionLease;
}

// This registry covers only this module instance and this exact client object.
const retired = new WeakMap<object, true>();
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const nativeThen = Promise.prototype.then;
const maxTimer = 0x7fffffff;

/** Attach to genuine promises without consulting a potentially overridden own `then`.
 * The returned native child remains fulfilled because both callbacks return undefined.
 * Promise species/constructor machinery still executes; arbitrary modified species,
 * global intrinsics, or promises hidden inside foreign thenables are not controlled here.
 */
function observe<T>(value: T | PromiseLike<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const parent = utilTypes.isPromise(value) ? value : Promise.resolve(value);
        nativeThen.call(
            parent,
            (result: T) => {
                resolve(result);
            },
            (error: unknown) => {
                reject(error);
            },
        );
    });
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) {
        throw new Error('invalid arguments');
    }

    const proto = Object.getPrototypeOf(value);

    if (proto !== Object.prototype && proto !== null) {
        throw new Error('invalid arguments');
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);

    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string' || !keys.includes(key) || !('value' in descriptors[key])) {
            throw new Error('invalid arguments');
        }
    }

    return Object.fromEntries(Object.entries(descriptors).map(([key, d]) => [key, d.value]));
}

function signalState(signal: unknown): boolean {
    if (
        typeof signal !== 'object' ||
        signal === null ||
        utilTypes.isProxy(signal) ||
        Object.getPrototypeOf(signal) !== AbortSignal.prototype ||
        Object.hasOwn(signal, 'aborted') ||
        Object.hasOwn(signal, 'addEventListener') ||
        Object.hasOwn(signal, 'removeEventListener')
    ) {
        throw new Error('invalid signal');
    }

    return aborted.call(signal) as boolean;
}

function failure(code: string, writeState: 'not-written' | 'unknown'): Sso12RawResult<never> {
    return { kind: 'failure', code, writeState };
}

/**
 * Local scheduling only: callers assert successful transport quiescence and usability.
 * This does not control other wrappers, module instances or direct client use, authenticate
 * peers, validate callback ordering, or stop side effects already inside callbacks.
 * All concurrent calls, including callback reentry, return busy without disturbing the
 * in-flight operation. Timers are not hard real time; callbacks own their own data.
 * Callbacks must arrange cleanup of any late-produced context or result: a revoked
 * wrapper discards its return, so an outer guard may never receive it.
 * Signals must be genuine same-realm AbortSignal instances with the standard prototype
 * and no own aborted/addEventListener/removeEventListener shadows at validation. The
 * caller must not change their prototype or shadow these properties, or modify the
 * intrinsics, during their lifetime. Calling AbortController.abort() remains supported.
 * Signals are neither frozen nor protected against later modifications.
 * Reading whenClosed may throw; thenable assimilation may run arbitrary code asynchronously,
 * never settle, or settle late. Local termination never waits for that observation.
 */
export function createRawSessionBroker(
    client: Sso12RawClient,
    config: { trustedSuccessQuiescence: true; isUsable: () => boolean },
): RawSessionBroker {
    const cfg = record(config, ['trustedSuccessQuiescence', 'isUsable']);

    if (
        cfg.trustedSuccessQuiescence !== true ||
        typeof cfg.isUsable !== 'function' ||
        typeof client !== 'object' ||
        client === null ||
        utilTypes.isProxy(client)
    ) {
        throw new Error('invalid broker configuration');
    }

    const isUsable = cfg.isUsable as () => boolean;
    return {
        acquire(input) {
            const args = record(input, ['deadline', 'signal']);
            const deadline = args.deadline;
            const signal = args.signal as AbortSignal | undefined;

            if (
                typeof deadline !== 'number' ||
                !Number.isFinite(deadline) ||
                deadline <= performance.now() ||
                (signal !== undefined && signalState(signal))
            ) {
                throw new Error('invalid or expired session');
            }

            if (retired.has(client)) {
                throw new Error('client retired');
            }

            // Claim before any user-controlled call, including isUsable and whenClosed.
            retired.set(client, true);
            let terminal: 'released' | 'poisoned' | undefined;
            let busy = false;
            let closedClient = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let abortListener: ReturnType<typeof addAbortListener> | undefined;
            let cancelOperation: (() => void) | undefined;
            let resolveClosed!: (value: 'released' | 'poisoned') => void;
            const whenClosed = new Promise<'released' | 'poisoned'>((resolve) => {
                resolveClosed = resolve;
            });
            const controller = new AbortController();

            const finish = (reason: 'released' | 'poisoned'): void => {
                if (terminal) {
                    return;
                }

                terminal = reason;

                if (timer !== undefined) {
                    clearTimeout(timer);
                }

                if (abortListener) {
                    try {
                        abortListener[Symbol.dispose]();
                    } catch {
                        /* best effort */
                    }
                }

                controller.abort();
                cancelOperation?.();

                if (reason === 'poisoned' && !closedClient) {
                    closedClient = true;

                    try {
                        client.close();
                    } catch {
                        /* sanitized */
                    }
                }

                resolveClosed(reason);
            };

            const sessionExpired = (): boolean =>
                performance.now() >= deadline || (signal !== undefined && signalState(signal));

            const tick = (): void => {
                if (terminal) {
                    return;
                }

                try {
                    const remaining = deadline - performance.now();

                    if (remaining <= 0 || (signal !== undefined && signalState(signal))) {
                        finish('poisoned');
                        return;
                    }

                    timer = setTimeout(tick, Math.min(maxTimer, Math.max(1, Math.ceil(remaining))));
                } catch {
                    finish('poisoned');
                }
            };

            const lease: RawSessionLease = {
                whenClosed,
                release() {
                    try {
                        finish(busy || sessionExpired() ? 'poisoned' : 'released');
                    } catch {
                        finish('poisoned');
                    }
                },
                poison() {
                    finish('poisoned');
                },
                close() {
                    finish('poisoned');
                },
                async transactRaw<C, T>(
                    inputOptions: Sso12RawOptions<C, T>,
                ): Promise<Sso12RawResult<T>> {
                    if (terminal) {
                        return failure('closed', 'not-written');
                    }

                    try {
                        if (sessionExpired()) {
                            finish('poisoned');
                            return failure('interrupted', 'not-written');
                        }
                    } catch {
                        finish('poisoned');
                        return failure('invalid-session', 'not-written');
                    }

                    if (busy) {
                        return failure('busy', 'not-written');
                    }

                    busy = true;
                    let values: Record<string, unknown>;
                    let opSignal: AbortSignal | undefined;
                    let opDeadline: number;
                    const start = performance.now();

                    try {
                        values = record(inputOptions, [
                            'buildRequest',
                            'verifyCandidate',
                            'consumeCandidate',
                            'timeoutMs',
                            'signal',
                        ]);
                        const timeout = values.timeoutMs;
                        opSignal = values.signal as AbortSignal | undefined;

                        if (
                            typeof values.buildRequest !== 'function' ||
                            typeof values.verifyCandidate !== 'function' ||
                            typeof values.consumeCandidate !== 'function' ||
                            (timeout !== undefined &&
                                (!Number.isInteger(timeout) ||
                                    (timeout as number) < 1 ||
                                    (timeout as number) > maxTimer))
                        ) {
                            throw new Error('invalid');
                        }

                        if (opSignal && signalState(opSignal)) {
                            busy = false;
                            return failure('cancelled', 'not-written');
                        }

                        if (opSignal !== undefined) {
                            signalState(opSignal);
                        }

                        opDeadline = Math.min(
                            deadline,
                            timeout === undefined ? deadline : start + (timeout as number),
                        );

                        if (performance.now() >= opDeadline) {
                            finish('poisoned');
                            busy = false;
                            return failure('expired', 'not-written');
                        }

                        if (isUsable() !== true || terminal) {
                            finish('poisoned');
                            busy = false;
                            return failure('unusable', 'not-written');
                        }

                        if (
                            sessionExpired() ||
                            performance.now() >= opDeadline ||
                            (opSignal && signalState(opSignal))
                        ) {
                            finish('poisoned');
                            busy = false;
                            return failure('cancelled', 'not-written');
                        }
                    } catch {
                        busy = false;

                        if (terminal) {
                            return failure('closed', 'not-written');
                        }

                        finish('poisoned');
                        return failure('invalid-or-unusable', 'not-written');
                    }

                    const opController = new AbortController();
                    let active = true;
                    let opTimer: ReturnType<typeof setTimeout> | undefined;
                    let opAbort: ReturnType<typeof addAbortListener> | undefined;
                    let resolveCancelled!: (r: Sso12RawResult<T>) => void;
                    const cancelled = new Promise<Sso12RawResult<T>>((resolve) => {
                        resolveCancelled = resolve;
                    });

                    const stop = (): void => {
                        if (!active) {
                            return;
                        }

                        active = false;
                        opController.abort();
                        resolveCancelled(failure('interrupted', 'unknown'));
                    };

                    cancelOperation = stop;

                    const check = (): void => {
                        if (!active || terminal) {
                            throw new Error('inactive callback');
                        }

                        try {
                            if (
                                sessionExpired() ||
                                performance.now() >= opDeadline ||
                                (opSignal && signalState(opSignal))
                            ) {
                                throw new Error('inactive callback');
                            }
                        } catch {
                            finish('poisoned');
                            throw new Error('inactive callback');
                        }
                    };

                    const fenced = async <A extends unknown[], R>(
                        fn: (...args: A) => R | Promise<R>,
                        ...args: A
                    ): Promise<R> => {
                        check();
                        const result = await fn(...args);
                        check();
                        return result;
                    };

                    const opTick = (): void => {
                        if (!active) {
                            return;
                        }

                        const remaining = opDeadline - performance.now();

                        if (remaining <= 0) {
                            finish('poisoned');
                            return;
                        }

                        opTimer = setTimeout(
                            opTick,
                            Math.min(maxTimer, Math.max(1, Math.ceil(remaining))),
                        );
                    };

                    try {
                        if (opSignal) {
                            opAbort = addAbortListener(opSignal, () => finish('poisoned'));
                        }

                        opTick();

                        // All failures before invoking client are known local non-writes.
                        if (
                            terminal ||
                            sessionExpired() ||
                            (opSignal && signalState(opSignal)) ||
                            performance.now() >= opDeadline
                        ) {
                            finish('poisoned');
                            return failure('interrupted', 'not-written');
                        }

                        const build = values.buildRequest as Sso12RawOptions<C, T>['buildRequest'];
                        const verify = values.verifyCandidate as Sso12RawOptions<
                            C,
                            T
                        >['verifyCandidate'];
                        const consume = values.consumeCandidate as Sso12RawOptions<
                            C,
                            T
                        >['consumeCandidate'];
                        const options: Sso12RawOptions<C, T> = {
                            buildRequest: (...a) => fenced(build, ...a),
                            verifyCandidate: (...a) => fenced(verify, ...a),
                            consumeCandidate: (...a) => fenced(consume, ...a),
                            timeoutMs: Math.min(
                                maxTimer,
                                Math.max(1, Math.ceil(opDeadline - performance.now())),
                            ),
                            signal: opController.signal,
                        };
                        let underlying: Promise<Sso12RawResult<T>>;

                        try {
                            underlying = observe(client.transactRaw(options));
                        } catch {
                            finish('poisoned');
                            return failure('transport-failed', 'unknown');
                        }

                        // Attach both handlers immediately, including for late rejection.
                        const settled = underlying.then(
                            (result): Sso12RawResult<T> => {
                                try {
                                    if (
                                        !active ||
                                        terminal ||
                                        sessionExpired() ||
                                        performance.now() >= opDeadline ||
                                        (opSignal && signalState(opSignal))
                                    ) {
                                        finish('poisoned');
                                        return failure('interrupted', 'unknown');
                                    }

                                    const response = record(result, [
                                        'kind',
                                        'sequence',
                                        'value',
                                        'writeState',
                                    ]);

                                    if (
                                        response.kind !== 'response' ||
                                        response.writeState !== 'written' ||
                                        typeof response.sequence !== 'number' ||
                                        !Number.isInteger(response.sequence) ||
                                        response.sequence < 0 ||
                                        response.sequence > 0xffffffff ||
                                        !Object.hasOwn(response, 'value')
                                    ) {
                                        finish('poisoned');
                                        return failure('transport-failed', 'unknown');
                                    }

                                    if (
                                        isUsable() !== true ||
                                        !active ||
                                        terminal ||
                                        sessionExpired() ||
                                        performance.now() >= opDeadline ||
                                        (opSignal && signalState(opSignal))
                                    ) {
                                        finish('poisoned');
                                        return failure('interrupted', 'unknown');
                                    }

                                    return {
                                        kind: 'response',
                                        sequence: response.sequence,
                                        value: response.value as T,
                                        writeState: 'written',
                                    };
                                } catch {
                                    finish('poisoned');
                                    return failure('transport-failed', 'unknown');
                                }
                            },
                            () => {
                                finish('poisoned');
                                return failure('transport-failed', 'unknown');
                            },
                        );
                        return await Promise.race([settled, cancelled]);
                    } catch {
                        finish('poisoned');
                        return failure('interrupted', 'unknown');
                    } finally {
                        active = false;
                        cancelOperation = undefined;

                        if (opTimer !== undefined) {
                            clearTimeout(opTimer);
                        }

                        if (opAbort) {
                            try {
                                opAbort[Symbol.dispose]();
                            } catch {
                                /* best effort */
                            }
                        }

                        busy = false;
                    }
                },
            };

            try {
                if (signal) {
                    abortListener = addAbortListener(signal, () => finish('poisoned'));

                    if (signalState(signal)) {
                        finish('poisoned');
                    }
                }

                tick();
                // Native promises are observed without consulting an own `then` getter.
                const closed = client.whenClosed;
                void observe(closed).then(
                    () => finish('poisoned'),
                    () => finish('poisoned'),
                );

                if (!terminal && (isUsable() !== true || terminal || sessionExpired())) {
                    finish('poisoned');
                }
            } catch {
                finish('poisoned');
            }

            return lease;
        },
    };
}
