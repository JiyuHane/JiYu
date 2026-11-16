import { addAbortListener } from 'node:events';
import { isPromise, isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import {
    runLinuxEasyLoginSession,
    type LinuxEasyLoginSessionOptions,
    type LinuxEasyLoginSessionResult,
} from './linux-easy-login-session';
import {
    registerLinuxEasyReference,
    type LinuxEasyReferenceRegisterOptions,
} from './linux-easy-reference-register';
import { decodeLinuxNTEasyLoginReferenceResponse } from './nt-linux-easy-login-reference';
import { createRawSessionBroker, type RawSessionLease } from './raw-session-broker';
import type { Sso12RawClient } from './sso12-packet-client';

export interface LinuxEasyAccountOwnerOptions {
    client: Sso12RawClient;
    trustedSuccessQuiescence: true;
    isUsable: () => boolean;
    /** One lifetime deadline, measured from start using performance.now(). */
    sessionTimeoutMs: number;
    signal?: AbortSignal;
    login: Omit<LinuxEasyLoginSessionOptions, 'signal'>;
    register: Omit<LinuxEasyReferenceRegisterOptions, 'session' | 'uin' | 'signal'>;
}

export type LinuxEasyAccountOwnerResult =
    | { kind: 'registered'; registerSequence: number }
    | { kind: 'failure'; stage: 'owner' | 'login' | 'register'; code: string };

export interface LinuxEasyAccountOwner {
    start(options: LinuxEasyAccountOwnerOptions): Promise<LinuxEasyAccountOwnerResult>;
    close(): void;
}

const MAX_TIMER = 0x7fffffff;
const LIMIT = 1024 * 1024;
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const getBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const getLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const getResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const getAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const values = Uint8Array.prototype.values;
const set = Uint8Array.prototype.set;
const fill = Uint8Array.prototype.fill;

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        throw new TypeError('invalid options');
    }

    const proto = Object.getPrototypeOf(value);

    if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('invalid options');
    }

    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (
            typeof key !== 'string' ||
            !allowed.includes(key) ||
            !descriptor ||
            !('value' in descriptor)
        ) {
            throw new TypeError('invalid options');
        }

        output[key] = descriptor.value;
    }

    return output;
}

function copyBytes(value: unknown, max: number): Uint8Array {
    if (isProxy(value) || !isUint8Array(value)) {
        throw new TypeError('invalid bytes');
    }

    values.call(value);
    const storage = getBuffer.call(value) as ArrayBufferLike;
    const offset = getOffset.call(value) as number;
    const length = getLength.call(value) as number;

    if (
        length > max ||
        isSharedArrayBuffer(storage) ||
        (getResizable && getResizable.call(storage))
    ) {
        throw new TypeError('invalid bytes');
    }

    const output = new Uint8Array(length);
    set.call(output, new Uint8Array(storage, offset, length));
    return output;
}

function wipe(value: Uint8Array | null | undefined): void {
    if (value) {
        try {
            fill.call(value, 0);
        } catch {
            // Detached or externally retained copies are outside this best effort.
        }
    }
}

function validSignal(value: unknown): value is AbortSignal {
    if (
        typeof value !== 'object' ||
        value === null ||
        isProxy(value) ||
        Object.getPrototypeOf(value) !== AbortSignal.prototype ||
        Object.hasOwn(value, 'aborted') ||
        Object.hasOwn(value, 'addEventListener') ||
        Object.hasOwn(value, 'removeEventListener')
    ) {
        return false;
    }

    try {
        getAborted.call(value);
        return true;
    } catch {
        return false;
    }
}

/**
 * Experimental, one-shot, per-account local composition for an injected raw client;
 * creates no socket and is not a production entry. The exact client must not be used
 * elsewhere, and the caller asserts usability and success quiescence. There is no
 * same-process isolation: callbacks can observe encrypted frames and signing bodies,
 * retain copies, reenter, and have arbitrary effects. A successful classification is
 * neither online state nor peer authentication. There is deliberately no send API.
 *
 * The owner acquires exactly one private broker lease and passes the original login
 * response directly to registration on that lease with the same UIN. The separately
 * supplied login and registration profiles may differ; this establishes no same-device
 * relationship. It decodes the body once for its private four ticket copies; the existing registration composition
 * independently decodes its own body snapshot. Its reference field projection is
 * attributed in nt-linux-easy-login-reference.ts to LagrangeV2 revision
 * 7011cdf87368cc0fb77273c1508e779a52328165 (overall upstream license undetermined).
 *
 * whenClosed is asynchronous observation, not a synchronous transport fence. Timers
 * depend on event-loop progress. Close marks state first, then aborts and poisons; it
 * cannot stop uncooperative transport/callbacks or erase copies held elsewhere. Late
 * login results are observed and their reachable body wiped best effort. Callers must
 * retain standard unmodified signals/intrinsics and ensure their callbacks clean up
 * any late values the broker discards before they reach this owner.
 */
export function createLinuxEasyAccountOwner(): LinuxEasyAccountOwner {
    const controller = new AbortController();
    const owned = new Set<Uint8Array>();
    let state: 'new' | 'starting' | 'registered' | 'closed' = 'new';
    let epoch = 0;
    let busy = false;
    let lease: RawSessionLease | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: ReturnType<typeof addAbortListener> | undefined;
    let deadline = Infinity;
    let stopReason = 'closed';
    const currentState = (): typeof state => state;
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolve) => {
        resolveStopped = resolve;
    });

    const clear = (): void => {
        for (const bytes of owned) {
            wipe(bytes);
        }

        owned.clear();
    };

    const stop = (reason: string): void => {
        if (state === 'closed') {
            return;
        }

        state = 'closed';
        epoch++;
        stopReason = reason;

        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }

        try {
            listener?.[Symbol.dispose]();
        } catch {
            /* best effort */
        }

        listener = undefined;
        clear();
        resolveStopped();

        try {
            controller.abort();
        } catch {
            /* best effort */
        }

        try {
            lease?.poison();
        } catch {
            /* best effort */
        }
    };

    const check = (generation: number): void => {
        if (state === 'closed' || epoch !== generation || controller.signal.aborted) {
            throw new Error('stopped');
        }

        const now = performance.now();

        // The clock call can reenter close even though TS narrows the earlier read.
        if (currentState() === 'closed' || epoch !== generation || controller.signal.aborted) {
            throw new Error('stopped');
        }

        if (now >= deadline) {
            stop('timeout');
            throw new Error('stopped');
        }
    };

    const tick = (generation: number): void => {
        try {
            check(generation);
            const remaining = deadline - performance.now();
            check(generation);
            timer = setTimeout(
                () => tick(generation),
                Math.min(MAX_TIMER, Math.max(1, Math.ceil(remaining))),
            );
        } catch {
            stop('timeout');
        }
    };

    return {
        close(): void {
            stop('closed');
        },
        async start(options): Promise<LinuxEasyAccountOwnerResult> {
            // Reserve before inspecting any caller argument, including its descriptors.
            if (busy) {
                return { kind: 'failure', stage: 'owner', code: 'busy' };
            }

            if (state !== 'new') {
                return { kind: 'failure', stage: 'owner', code: 'closed' };
            }

            busy = true;
            state = 'starting';
            const generation = ++epoch;
            let stage: 'owner' | 'login' | 'register' = 'owner';
            let succeeded = false;
            let body: Uint8Array | null | undefined;

            const own = (bytes: Uint8Array): Uint8Array => {
                owned.add(bytes);
                return bytes;
            };

            const fail = (code: string): LinuxEasyAccountOwnerResult => ({
                kind: 'failure',
                stage,
                code,
            });

            try {
                const started = performance.now();
                check(generation);
                const input = record(options, [
                    'client',
                    'trustedSuccessQuiescence',
                    'isUsable',
                    'sessionTimeoutMs',
                    'signal',
                    'login',
                    'register',
                ]);
                const login = record(input.login, [
                    'uin',
                    'guid',
                    'version',
                    'subAppId',
                    'a2',
                    'a1',
                    'nonce',
                    'deviceName',
                    'deviceType',
                    'appId',
                    'appName',
                    'qua',
                    'cookie',
                    'serverPublicKey',
                    'verifyKey',
                    'timestamp',
                    'timeoutMs',
                    'buildReserved',
                    'verifyRaw',
                    'verifyServerResponse',
                    'acceptKeyExchange',
                ]);
                const registration = record(input.register, [
                    'profile',
                    'registration',
                    'timeoutMs',
                    'buildReserved',
                    'verifyRaw',
                    'acceptLogin',
                ]);
                const profile = record(registration.profile, ['guid', 'version', 'subAppId']);
                const details = record(registration.registration, [
                    'uid',
                    'version',
                    'deviceName',
                    'deviceType',
                    'vendorOs',
                    'random',
                ]);
                const sessionTimeout = input.sessionTimeoutMs;

                if (
                    input.trustedSuccessQuiescence !== true ||
                    typeof input.isUsable !== 'function' ||
                    isProxy(input.isUsable) ||
                    typeof sessionTimeout !== 'number' ||
                    !Number.isInteger(sessionTimeout) ||
                    sessionTimeout < 1 ||
                    sessionTimeout > MAX_TIMER ||
                    (input.signal !== undefined && !validSignal(input.signal))
                ) {
                    throw new TypeError('invalid options');
                }

                deadline = started + sessionTimeout;
                const uin = login.uin;

                // Keep this preflight aligned with linux-easy-reference-register.ts.
                // Extracting a shared validator later would avoid policy drift.
                const text = (value: unknown, nonempty: boolean, max: number): value is string =>
                    typeof value === 'string' &&
                    (!nonempty || value.length > 0) &&
                    value.length <= max &&
                    Buffer.byteLength(value) <= max &&
                    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
                        value,
                    );
                const integer = (value: unknown, min: number, max: number): value is number =>
                    typeof value === 'number' &&
                    Number.isInteger(value) &&
                    value >= min &&
                    value <= max;
                const callback = (value: unknown): boolean =>
                    typeof value === 'function' && !isProxy(value);

                if (
                    typeof uin !== 'string' ||
                    !/^[1-9][0-9]{0,9}$/.test(uin) ||
                    BigInt(uin) > 0xffffffffn ||
                    !text(profile.version, true, 0xfffd) ||
                    !integer(profile.subAppId, 0, 0x7fffffff) ||
                    !text(details.uid, true, 4096) ||
                    !text(details.version, true, 4096) ||
                    !text(details.deviceName, false, 4096) ||
                    !text(details.deviceType, false, 4096) ||
                    !text(details.vendorOs, false, 4096) ||
                    !integer(details.random, 0, 0x7ffffffe) ||
                    !integer(registration.timeoutMs, 1, MAX_TIMER) ||
                    !callback(registration.buildReserved) ||
                    !callback(registration.verifyRaw) ||
                    !callback(registration.acceptLogin)
                ) {
                    throw new TypeError('invalid registration options');
                }

                // Snapshot all byte arrays and nested records before acquiring or invoking callbacks.
                login.guid = own(copyBytes(login.guid, LIMIT));
                login.a1 = own(copyBytes(login.a1, LIMIT));

                if (login.a2 !== undefined) {
                    login.a2 = own(copyBytes(login.a2, 16 * LIMIT));
                }

                login.nonce = own(copyBytes(login.nonce, LIMIT));
                login.serverPublicKey = own(copyBytes(login.serverPublicKey, 65));
                login.verifyKey = own(copyBytes(login.verifyKey, 32));
                profile.guid = own(copyBytes(profile.guid, 65535));

                if ((profile.guid as Uint8Array).length === 0) {
                    throw new TypeError('invalid registration guid');
                }

                registration.profile = profile;
                registration.registration = details;
                const signal = input.signal as AbortSignal | undefined;

                if (signal) {
                    listener = addAbortListener(signal, () => stop('cancelled'));

                    if (getAborted.call(signal)) {
                        stop('cancelled');
                    }
                }

                check(generation);
                tick(generation);
                check(generation);
                const usable = input.isUsable as () => boolean;
                const broker = createRawSessionBroker(input.client as Sso12RawClient, {
                    trustedSuccessQuiescence: true,
                    isUsable: () => {
                        check(generation);
                        const result: unknown = usable();

                        if (!isProxy(result) && isPromise(result)) {
                            try {
                                void Promise.prototype.then.call(
                                    result,
                                    () => undefined,
                                    () => undefined,
                                );
                            } catch {
                                /* promise species mutation is outside this boundary */
                            }
                        }

                        check(generation);
                        return result === true;
                    },
                });
                check(generation);
                // acquire may call arbitrary getters and callbacks before it returns.
                const acquired = broker.acquire({ deadline, signal: controller.signal });
                lease = acquired;

                if (
                    currentState() === 'closed' ||
                    epoch !== generation ||
                    controller.signal.aborted
                ) {
                    try {
                        acquired.poison();
                    } catch {
                        /* best effort */
                    }

                    throw new Error('stopped');
                }

                check(generation);
                void acquired.whenClosed.then(
                    () => stop('lease-closed'),
                    () => stop('lease-closed'),
                );
                check(generation);
                stage = 'login';
                const pendingLogin = runLinuxEasyLoginSession(acquired, {
                    ...(login as unknown as Omit<LinuxEasyLoginSessionOptions, 'signal'>),
                    signal: controller.signal,
                });
                const observedLogin = pendingLogin.then(
                    (result) => {
                        if (
                            result.kind === 'response' &&
                            (state === 'closed' || epoch !== generation)
                        ) {
                            wipe(result.value.body);
                        }

                        return result;
                    },
                    () => undefined,
                );
                const loginResult = await Promise.race([
                    observedLogin,
                    stopped.then(() => undefined),
                ]);

                if (loginResult?.kind === 'response') {
                    body = loginResult.value.body;

                    if (body) {
                        owned.add(body);
                    }
                }

                check(generation);

                if (!loginResult || loginResult.kind !== 'response') {
                    return fail('login-failed');
                }

                if (body === null || body === undefined) {
                    return fail('login-rejected');
                }

                const status = loginResult.value.status;

                if (status.kind !== 'code' || status.codePresent !== true || status.code !== 0n) {
                    return fail('login-rejected');
                }

                const decoded = decodeLinuxNTEasyLoginReferenceResponse(body);

                if (decoded.a1) {
                    own(decoded.a1);
                }

                if (decoded.a2) {
                    own(decoded.a2);
                }

                if (decoded.d2) {
                    own(decoded.d2);
                }

                if (decoded.d2Key) {
                    own(decoded.d2Key);
                }

                if (
                    !decoded.ticketsPresent ||
                    decoded.a1 === null ||
                    decoded.a2 === null ||
                    decoded.d2 === null ||
                    decoded.d2Key === null ||
                    decoded.a1.length > 65535 ||
                    decoded.a2.length > 65535 ||
                    decoded.d2.length === 0 ||
                    decoded.d2.length > 65535 ||
                    decoded.d2Key.length !== 16
                ) {
                    return fail('invalid-tickets');
                }

                check(generation);
                stage = 'register';
                const pendingRegister = registerLinuxEasyReference(acquired, {
                    ...(registration as unknown as Omit<
                        LinuxEasyReferenceRegisterOptions,
                        'session' | 'uin' | 'signal'
                    >),
                    uin,
                    session: loginResult as Extract<
                        LinuxEasyLoginSessionResult,
                        { kind: 'response' }
                    >,
                    signal: controller.signal,
                });
                // Registration snapshots its input synchronously; this copy belongs to us.
                wipe(body);
                owned.delete(body);
                body = undefined;
                const observedRegister = pendingRegister.then(
                    (result) => result,
                    () => undefined,
                );
                const result = await Promise.race([
                    observedRegister,
                    stopped.then(() => undefined),
                ]);
                check(generation);

                if (
                    !result ||
                    result.kind !== 'response' ||
                    result.value !== 'success' ||
                    result.poison !== 'not-requested'
                ) {
                    return fail('register-failed');
                }

                // This experimental owner exposes no send or receive operation yet,
                // so retaining credentials after classification has no current use.
                clear();
                check(generation);
                state = 'registered';
                succeeded = true;
                return { kind: 'registered', registerSequence: result.sequence };
            } catch {
                return fail(currentState() === 'closed' ? stopReason : 'invalid-or-failed');
            } finally {
                wipe(body);

                if (!succeeded) {
                    stop('failed');
                    // Close may have reentered before a later snapshot was tracked.
                    clear();
                }

                busy = false;
            }
        },
    };
}
