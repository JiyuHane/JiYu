import { addAbortListener } from 'node:events';
import { isPromise, isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import { MSG_PUSH_CMD } from '../msg-push';
import { decodeSsoResponse } from './sso';
import {
    runLinuxEasyLoginSession,
    runLinuxEasyLoginSessionWithKeyCapability,
    type LinuxEasyLoginSessionOptions,
    type LinuxEasyLoginSessionResult,
} from './linux-easy-login-session';
import {
    assertLinuxEasyKeyTentative,
    commitLinuxEasyKey,
    createLinuxEasyKeyCapability,
    decodeLinuxEasyServiceResponse,
    linuxEasyKeyState,
    revokeLinuxEasyKey,
    type LinuxEasyKeyToken,
} from './linux-easy-key-capability';
import {
    registerLinuxEasyReference,
    type LinuxEasyReferenceRegisterOptions,
} from './linux-easy-reference-register';
import { decodeLinuxNTEasyLoginReferenceResponse } from './nt-linux-easy-login-reference';
import {
    createRawSessionBroker,
    createRawSessionBrokerInternal,
    type RawSessionLease,
} from './raw-session-broker';
import type {
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from './sso12-packet-client';
import {
    encodeDirectSendMessageRequest,
    type DirectSendMessageRequestInput,
} from './send-message-request';
import {
    referenceSendTextOnTransport,
    type SsoReferenceSendTextOptions,
    type SsoReferenceSendTextResult,
} from './sso-reference-send-text-flow';

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

export interface LinuxEasyAccountOwnerSendTextOptions {
    request: DirectSendMessageRequestInput;
    maxResponseBodyBytes: number;
    timeoutMs: number;
    signal?: AbortSignal;
}

export interface LinuxEasyAccountOwner {
    start(options: LinuxEasyAccountOwnerOptions): Promise<LinuxEasyAccountOwnerResult>;
    sendText(options: LinuxEasyAccountOwnerSendTextOptions): Promise<SsoReferenceSendTextResult>;
    close(): void;
}

type D2Candidate = Readonly<{ uin: string; sequence: number; command: string; retCode: number }>;
const classifiers = new WeakMap<
    LinuxEasyAccountOwner,
    (frame: Uint8Array) => D2Candidate | undefined
>();
type OwnerPushBody = { meta: D2Candidate; body: Uint8Array };
const pushBodyExtractors = new WeakMap<
    LinuxEasyAccountOwner,
    (frame: Uint8Array, expected: D2Candidate) => OwnerPushBody | undefined
>();
const weakMapGet = WeakMap.prototype.get;
const weakMapSet = WeakMap.prototype.set;
const weakMapDelete = WeakMap.prototype.delete;

/**
 * Deep internal extraction only; expected is a trusted routing snapshot, not
 * authentication. Before calling, a trusted verifier must independently return
 * strictly true for the same stable complete encrypted frame, and the caller
 * must check whether verification modified its copy. Ingress then synchronously
 * snapshots the returned body. No key, lease or token is exposed to callbacks;
 * deep imports are not same-process isolation. The caller owns and must wipe the
 * returned sensitive body. Never log it or its metadata. This is not delivery or
 * production wiring; pre-login unknown frames remain unhandled.
 */
export function extractLinuxEasyOwnerPushBody(
    owner: LinuxEasyAccountOwner,
    frame: Uint8Array,
    expected: Readonly<{ uin: string; sequence: number; command: string; retCode: number }>,
):
    | {
          meta: Readonly<{ uin: string; sequence: number; command: string; retCode: number }>;
          body: Uint8Array;
      }
    | undefined {
    try {
        if (typeof owner !== 'object' || owner === null || isProxy(owner)) {
            return undefined;
        }

        const extract = Reflect.apply(weakMapGet, pushBodyExtractors, [owner]) as
            ((value: Uint8Array, route: D2Candidate) => OwnerPushBody | undefined) | undefined;
        return extract?.(frame, expected);
    } catch {
        return undefined;
    }
}

/** Trusted internal callers only: metadata is sensitive; do not log it. Parsing is not
 * peer authentication, payload validation, message delivery, or an online assertion. */
export function classifyLinuxEasyOwnerD2Candidate(
    owner: LinuxEasyAccountOwner,
    frame: Uint8Array,
): D2Candidate | undefined {
    try {
        if (typeof owner !== 'object' || owner === null || isProxy(owner)) {
            return undefined;
        }

        const classify = Reflect.apply(weakMapGet, classifiers, [owner]) as
            ((value: Uint8Array) => D2Candidate | undefined) | undefined;
        return classify?.(frame);
    } catch {
        return undefined;
    }
}

const MAX_TIMER = 0x7fffffff;
const LIMIT = 1024 * 1024;
const Bytes = Uint8Array;
const apply = Reflect.apply;
const freeze = Object.freeze;
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const getBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const getLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const getResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const getAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const values = Uint8Array.prototype.values;
const set = Uint8Array.prototype.set;
const fill = Uint8Array.prototype.fill;
const getPrototypeOf = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const ownKeys = Reflect.ownKeys;
const hasOwn = Object.hasOwn;
const isInteger = Number.isInteger;

// Exact own data fields only. Neither input getters nor inherited setters run.
function snapshotPushRoute(value: unknown, uin: string): D2Candidate {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        throw new TypeError('invalid route');
    }

    const proto = getPrototypeOf(value);

    if ((proto !== Object.prototype && proto !== null) || ownKeys(value).length !== 4) {
        throw new TypeError('invalid route');
    }

    const account = getDescriptor(value, 'uin');
    const sequence = getDescriptor(value, 'sequence');
    const command = getDescriptor(value, 'command');
    const retCode = getDescriptor(value, 'retCode');

    if (
        !account ||
        !hasOwn(account, 'value') ||
        account.value !== uin ||
        !sequence ||
        !hasOwn(sequence, 'value') ||
        typeof sequence.value !== 'number' ||
        !isInteger(sequence.value) ||
        sequence.value < 0 ||
        sequence.value > 0xffffffff ||
        !command ||
        !hasOwn(command, 'value') ||
        command.value !== MSG_PUSH_CMD ||
        !retCode ||
        !hasOwn(retCode, 'value') ||
        retCode.value !== 0
    ) {
        throw new TypeError('invalid route');
    }

    return freeze({ uin, sequence: sequence.value, command: command.value, retCode: 0 });
}

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
            !Object.hasOwn(descriptor, 'value')
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

    apply(values, value, []);
    const storage = apply(getBuffer, value, []) as ArrayBufferLike;
    const offset = apply(getOffset, value, []) as number;
    const length = apply(getLength, value, []) as number;

    if (
        length > max ||
        isSharedArrayBuffer(storage) ||
        (getResizable && apply(getResizable, storage, []))
    ) {
        throw new TypeError('invalid bytes');
    }

    const output = new Bytes(length);
    apply(set, output, [new Bytes(storage, offset, length)]);
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
 * retain copies, reenter, and have arbitrary effects. Neither registration nor a send
 * response proves online state, peer authentication, acceptance or delivery. This is not
 * push, a real connection, or production wiring. The caller remains responsible for
 * client exclusivity and successful transport quiescence.
 *
 * The owner acquires exactly one private broker lease and passes the original login
 * response directly to registration on that lease with the same UIN. The separately
 * supplied login and registration profiles may differ; this establishes no same-device
 * relationship. It decodes the body once for its private four ticket copies; the existing registration composition
 * independently decodes its own body snapshot. Its reference field projection is
 * attributed in nt-linux-easy-login-reference.ts to LagrangeV2 revision
 * 7011cdf87368cc0fb77273c1508e779a52328165 (overall upstream license undetermined).
 *
 * Registration signer and transport callbacks can also observe the D2 wire header.
 * whenClosed is asynchronous observation, not a synchronous transport fence: broker
 * terminal transitions can precede the owner's capability revocation. Timers
 * depend on event-loop progress. Close marks state first, then aborts and poisons; it
 * cannot stop uncooperative transport/callbacks or erase copies held elsewhere. Late
 * login results are observed and their reachable body wiped best effort. Callers must
 * retain standard unmodified signals/intrinsics and ensure their callbacks clean up
 * any late values the broker discards before they reach this owner.
 */
export function createLinuxEasyAccountOwner(): LinuxEasyAccountOwner {
    return createOwner(false);
}

/**
 * Internal reference composition; not wired into production or a public callback.
 * After exact-lease binding, broker-local finish synchronously invokes the fixed key
 * revocation before abort, cancellation or client close. This includes broker close,
 * release, timeout and upstream abort when they actively finish the lease. A throwing
 * revocation does not guarantee actual erasure. This guarantee begins at local finish:
 * whenClosed observes underlying closure asynchronously, not at the instant a network
 * disconnect occurs. Capability phases and results do not authenticate a peer or prove
 * online state. Copies held elsewhere and uncooperative callbacks remain outside it.
 */
export function createLinuxEasyAccountOwnerWithKeyCapability(): LinuxEasyAccountOwner {
    return createOwner(true);
}

function createOwner(withKeyCapability: boolean): LinuxEasyAccountOwner {
    const controller = new AbortController();
    const owned = new Set<Uint8Array>();
    let state: 'new' | 'starting' | 'registered' | 'closed' = 'new';
    let epoch = 0;
    let busy = false;
    let lease: RawSessionLease | undefined;
    let capability: LinuxEasyKeyToken | undefined;
    let session:
        | {
              uin: string;
              uid: string;
              profile: SsoReferenceSendTextOptions['profile'];
              tickets: SsoReferenceSendTextOptions['login']['tickets'];
              buildReserved: SsoReferenceSendTextOptions['buildReserved'];
              verifyRaw: SsoReferenceSendTextOptions['verifyRaw'];
          }
        | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: ReturnType<typeof addAbortListener> | undefined;
    let deadline = Infinity;
    let stopReason = 'closed';
    const currentState = (): typeof state => state;
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolve) => {
        resolveStopped = resolve;
    });
    const stopSubscribers = new Set<() => void>();

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
        // Revoke before abort, poison, classifier removal or other cleanup.
        const currentCapability = capability;
        capability = undefined;

        if (currentCapability) {
            try {
                revokeLinuxEasyKey(currentCapability);
            } catch {
                /* continue teardown */
            }
        }

        Reflect.apply(weakMapDelete, classifiers, [owner]);
        Reflect.apply(weakMapDelete, pushBodyExtractors, [owner]);

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
        session = undefined;
        const currentLease = lease;
        lease = undefined;
        resolveStopped();

        for (const notify of stopSubscribers) {
            notify();
        }

        stopSubscribers.clear();

        try {
            controller.abort();
        } catch {
            /* best effort */
        }

        try {
            currentLease?.poison();
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

    // Final clock sample is followed by a non-clock state/epoch fence; check() itself
    // samples the clock and may consume the remaining operation budget.
    const nowChecked = (generation: number): number => {
        check(generation);
        const now = performance.now();

        if (currentState() === 'closed' || epoch !== generation || controller.signal.aborted) {
            throw new Error('stopped');
        }

        if (now >= deadline) {
            stop('timeout');
            throw new Error('stopped');
        }

        return now;
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

    const owner: LinuxEasyAccountOwner = {
        close(): void {
            stop('closed');
        },
        async sendText(options): Promise<SsoReferenceSendTextResult> {
            const failure = (
                code: string,
                writeState: 'not-written' | 'unknown',
            ): SsoReferenceSendTextResult => ({ kind: 'failure', code, writeState });

            // A competing call must not inspect its arguments or disturb the winner.
            if (busy) {
                return failure('busy', 'not-written');
            }

            if (state !== 'registered' || !session || !lease) {
                return failure('closed', 'not-written');
            }

            busy = true;
            const generation = epoch;
            let committed = false;
            let opActive = true;
            let opTimedOut = false;
            let opCancelled = false;
            let opTimer: ReturnType<typeof setTimeout> | undefined;
            let opListener: ReturnType<typeof addAbortListener> | undefined;
            let onStopped: (() => void) | undefined;
            const copies: Uint8Array[] = [];

            try {
                // Start the budget immediately after reserving this operation's slot.
                const started = performance.now();
                check(generation);
                // No caller accessor or proxy trap is invoked while taking this snapshot.
                const input = record(options, [
                    'request',
                    'maxResponseBodyBytes',
                    'timeoutMs',
                    'signal',
                ]);
                const request = record(input.request, [
                    'route',
                    'text',
                    'clientSequence',
                    'random',
                ]);
                const route = record(request.route, ['kind', 'peerUin', 'peerUid', 'groupUin']);
                request.route = route;
                const timeout = input.timeoutMs;
                const maxResponseBodyBytes = input.maxResponseBodyBytes;
                const signal = input.signal;

                if (
                    typeof timeout !== 'number' ||
                    !Number.isInteger(timeout) ||
                    timeout < 1 ||
                    timeout > MAX_TIMER ||
                    typeof maxResponseBodyBytes !== 'number' ||
                    !Number.isSafeInteger(maxResponseBodyBytes) ||
                    maxResponseBodyBytes < 0 ||
                    maxResponseBodyBytes > 65536 ||
                    (signal !== undefined && !validSignal(signal))
                ) {
                    return failure('invalid-options', 'not-written');
                }

                const opDeadline = started + timeout;

                const checkOperation = (): number => {
                    // Late callbacks from this operation must never affect a later one.
                    if (!opActive) {
                        throw new Error('stopped');
                    }

                    // nowChecked takes its final sample after check's reentrant clock.
                    const now = nowChecked(generation);
                    const aborted = signal !== undefined && getAborted.call(signal);

                    // Signal inspection and the final clock may synchronously reenter close.
                    if (
                        !opActive ||
                        currentState() === 'closed' ||
                        epoch !== generation ||
                        controller.signal.aborted
                    ) {
                        throw new Error('stopped');
                    }

                    if (opTimedOut || now >= opDeadline) {
                        opTimedOut = true;

                        if (committed) {
                            stop('timeout');
                        }

                        throw new Error('stopped');
                    }

                    if (opCancelled || aborted) {
                        opCancelled = true;

                        if (committed) {
                            stop('cancelled');
                        }

                        throw new Error('stopped');
                    }

                    return Math.min(MAX_TIMER, Math.max(1, Math.ceil(opDeadline - now)));
                };

                checkOperation();

                // Use the actual encoder for the same validation as the borrowed flow.
                // Its internal pooled allocations are not covered by this best-effort wipe.
                let encoded: Uint8Array | undefined;

                try {
                    encoded = encodeDirectSendMessageRequest(
                        request as unknown as DirectSendMessageRequestInput,
                    );

                    if (encoded.byteLength > 65536) {
                        return failure('invalid-options', 'not-written');
                    }
                } finally {
                    wipe(encoded);
                }

                checkOperation();

                if (signal !== undefined) {
                    opListener = addAbortListener(signal as AbortSignal, () => {
                        if (!opActive) {
                            return;
                        }

                        opCancelled = true;

                        if (committed) {
                            stop('cancelled');
                        }
                    });
                }

                const initialRemaining = checkOperation();
                opTimer = setTimeout(() => {
                    if (!opActive) {
                        return;
                    }

                    opTimedOut = true;

                    if (committed) {
                        stop('timeout');
                    }
                }, initialRemaining);
                checkOperation();
                const saved = session;
                const transport = lease;

                if (!saved || !transport || currentState() !== 'registered') {
                    throw new Error('stopped');
                }

                const copy = (bytes: Uint8Array): Uint8Array => {
                    checkOperation();
                    const result = copyBytes(bytes, 65535);
                    owned.add(result);
                    copies.push(result);
                    checkOperation();
                    return result;
                };

                const profile = { ...saved.profile, guid: copy(saved.profile.guid) };
                const tickets = {
                    a1: new Uint8Array(0),
                    a2: copy(saved.tickets.a2),
                    d2: copy(saved.tickets.d2),
                    d2Key: copy(saved.tickets.d2Key),
                };
                const interrupted = new Promise<undefined>((resolve) => {
                    onStopped = () => resolve(undefined);
                    stopSubscribers.add(onStopped);
                });
                const guardedTransport: Sso12RawTransport = {
                    transactRaw<C, T>(
                        rawOptions: Sso12RawOptions<C, T>,
                    ): Promise<Sso12RawResult<T>> {
                        checkOperation();
                        const fencedOptions: Sso12RawOptions<C, T> = {
                            ...rawOptions,
                            buildRequest: async (identity) => {
                                checkOperation();
                                const built = await rawOptions.buildRequest(identity);

                                try {
                                    checkOperation();
                                } catch (error) {
                                    // This frame is the guard's private output, not a caller's copy.
                                    wipe(built.frame);
                                    throw error;
                                }

                                return built;
                            },
                            verifyCandidate: async (candidate, context, identity) => {
                                checkOperation();
                                const result = await rawOptions.verifyCandidate(
                                    candidate,
                                    context,
                                    identity,
                                );
                                checkOperation();
                                return result;
                            },
                            consumeCandidate: async (candidate, context, identity) => {
                                checkOperation();
                                const result = await rawOptions.consumeCandidate(
                                    candidate,
                                    context,
                                    identity,
                                );
                                checkOperation();
                                return result;
                            },
                        };
                        checkOperation();
                        // Crossing into the lease makes every subsequent failure uncertain.
                        committed = true;
                        return transport.transactRaw(fencedOptions);
                    },
                };
                const remaining = checkOperation();
                // The flow synchronously snapshots its inputs before the first await. Its
                // own late values and callback copies remain the producers' responsibility.
                let pending: Promise<SsoReferenceSendTextResult>;

                try {
                    pending = referenceSendTextOnTransport(guardedTransport, {
                        login: { status: 'tickets', uin: saved.uin, tickets },
                        profile,
                        uid: saved.uid,
                        request: request as unknown as DirectSendMessageRequestInput,
                        maxResponseBodyBytes,
                        timeoutMs: remaining,
                        signal: controller.signal,
                        buildReserved: async (input) => {
                            checkOperation();
                            const signer = saved.buildReserved;
                            const result = await signer(input);
                            checkOperation();
                            return result;
                        },
                        verifyRaw: async (input) => {
                            checkOperation();
                            const verifier = saved.verifyRaw;
                            const result = await verifier(input);
                            checkOperation();
                            return result;
                        },
                    });
                } finally {
                    for (const bytes of copies) {
                        wipe(bytes);
                        owned.delete(bytes);
                    }
                }

                const observed = pending.then(
                    (result) => result,
                    () => undefined,
                );
                const result = await Promise.race([observed, interrupted]);
                checkOperation();

                if (
                    !committed &&
                    result?.kind === 'failure' &&
                    result.writeState === 'not-written'
                ) {
                    if (result.code === 'raw-timeout') {
                        return failure('timeout', 'not-written');
                    }

                    if (result.code === 'raw-cancelled') {
                        return failure('cancelled', 'not-written');
                    }
                }

                if (!result || result.kind !== 'response' || !committed) {
                    stop('send-failed');
                    return failure('send-failed', 'unknown');
                }

                return result;
            } catch {
                if (committed) {
                    stop('send-failed');
                    return failure('send-failed', 'unknown');
                }

                return failure(
                    currentState() === 'closed'
                        ? 'closed'
                        : opTimedOut
                          ? 'timeout'
                          : opCancelled
                            ? 'cancelled'
                            : 'invalid-options',
                    'not-written',
                );
            } finally {
                opActive = false;

                if (onStopped) {
                    stopSubscribers.delete(onStopped);
                }

                if (opTimer !== undefined) {
                    clearTimeout(opTimer);
                }

                try {
                    opListener?.[Symbol.dispose]();
                } catch {
                    /* best effort */
                }

                for (const bytes of copies) {
                    wipe(bytes);
                    owned.delete(bytes);
                }

                busy = false;
            }
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
            let loginCapability: LinuxEasyKeyToken | undefined;

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
                const brokerConfig = {
                    trustedSuccessQuiescence: true as const,
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
                };
                const internal = withKeyCapability
                    ? createRawSessionBrokerInternal(input.client as Sso12RawClient, brokerConfig)
                    : undefined;
                const broker = internal
                    ? internal.broker
                    : createRawSessionBroker(input.client as Sso12RawClient, brokerConfig);
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

                if (withKeyCapability) {
                    // Creation can reenter close through runtime hooks. A capability created
                    // after stop must still be explicitly revoked even though stop is idempotent.
                    const created = createLinuxEasyKeyCapability({
                        lease: acquired,
                        uin,
                        generation: {},
                    });
                    // Own the returned token immediately: stop may reenter during bind.
                    // The catch also revokes this exact token if close already ran before
                    // creation returned or during binding, when stop is now idempotent.
                    capability = created;

                    try {
                        if (
                            !internal ||
                            currentState() !== 'starting' ||
                            epoch !== generation ||
                            lease !== acquired ||
                            controller.signal.aborted
                        ) {
                            throw new Error('stopped');
                        }

                        // No login, classifier registration or other owner callback may
                        // run before the broker accepts this exact lease/token/account.
                        if (!internal.keyBinding.bind(acquired, created, uin)) {
                            throw new Error('binding failed');
                        }

                        check(generation);

                        if (
                            currentState() !== 'starting' ||
                            lease !== acquired ||
                            capability !== created
                        ) {
                            throw new Error('stopped');
                        }

                        loginCapability = created;
                        Reflect.apply(weakMapSet, classifiers, [
                            owner,
                            (frame: Uint8Array): D2Candidate | undefined => {
                                let frameCopy: Uint8Array | undefined;
                                let decoded:
                                    ReturnType<typeof decodeLinuxEasyServiceResponse> | undefined;

                                const fence = (): void => {
                                    check(generation);

                                    if (
                                        (currentState() !== 'starting' &&
                                            currentState() !== 'registered') ||
                                        lease !== acquired ||
                                        capability !== created
                                    ) {
                                        throw new Error('stopped');
                                    }

                                    const phase = linuxEasyKeyState(created);

                                    if (phase !== 'tentative' && phase !== 'active') {
                                        throw new Error('unavailable');
                                    }

                                    check(generation);

                                    if (lease !== acquired || capability !== created) {
                                        throw new Error('stopped');
                                    }
                                };

                                try {
                                    // Snapshot before the clock/phase fence, which may
                                    // reenter and mutate the caller's frame. Already-closed
                                    // or mismatched owners do not inspect the input at all.
                                    if (
                                        (currentState() !== 'starting' &&
                                            currentState() !== 'registered') ||
                                        epoch !== generation ||
                                        controller.signal.aborted ||
                                        lease !== acquired ||
                                        capability !== created
                                    ) {
                                        return undefined;
                                    }

                                    frameCopy = copyBytes(frame, 65536);
                                    fence();
                                    decoded = decodeLinuxEasyServiceResponse({
                                        token: created,
                                        lease: acquired,
                                        uin,
                                        frame: frameCopy,
                                        // Local resource limit, not a protocol maximum.
                                        maxSsoBodyBytes: 65536,
                                    });
                                    const candidate = freeze({
                                        uin: decoded.uin,
                                        sequence: decoded.sequence,
                                        command: decoded.command,
                                        retCode: decoded.retCode,
                                    });
                                    fence();
                                    return candidate;
                                } catch {
                                    return undefined;
                                } finally {
                                    wipe(decoded?.body);
                                    wipe(frameCopy);
                                }
                            },
                        ]);
                        Reflect.apply(weakMapSet, pushBodyExtractors, [
                            owner,
                            (
                                frame: Uint8Array,
                                expected: D2Candidate,
                            ): OwnerPushBody | undefined => {
                                let frameCopy: Uint8Array | undefined;
                                let decoded:
                                    ReturnType<typeof decodeLinuxEasyServiceResponse> | undefined;
                                let sso: ReturnType<typeof decodeSsoResponse> | undefined;
                                let output: Uint8Array | undefined;
                                let transferred = false;

                                // No clock here: in particular, inspect no caller input when
                                // the exact owner generation, lease or capability is inactive.
                                const localFence = (): void => {
                                    if (
                                        currentState() !== 'registered' ||
                                        epoch !== generation ||
                                        controller.signal.aborted ||
                                        lease !== acquired ||
                                        capability !== created ||
                                        !session ||
                                        session.uin !== uin ||
                                        linuxEasyKeyState(created) !== 'active'
                                    ) {
                                        throw new Error('stopped');
                                    }

                                    // Phase lookup itself must not weaken the final state fence.
                                    if (
                                        currentState() !== 'registered' ||
                                        epoch !== generation ||
                                        controller.signal.aborted ||
                                        lease !== acquired ||
                                        capability !== created ||
                                        !session ||
                                        session.uin !== uin
                                    ) {
                                        throw new Error('stopped');
                                    }
                                };

                                try {
                                    localFence();
                                    frameCopy = copyBytes(frame, 65536);
                                    const route = snapshotPushRoute(expected, uin);
                                    nowChecked(generation);
                                    localFence();
                                    decoded = decodeLinuxEasyServiceResponse({
                                        token: created,
                                        lease: acquired,
                                        uin,
                                        frame: frameCopy,
                                        maxSsoBodyBytes: 65536,
                                    });
                                    sso = decodeSsoResponse(decoded.body, 65536);

                                    if (
                                        decoded.uin !== route.uin ||
                                        decoded.sequence !== route.sequence ||
                                        decoded.command !== route.command ||
                                        decoded.retCode !== route.retCode ||
                                        sso.sequence >>> 0 !== route.sequence ||
                                        sso.command !== route.command ||
                                        sso.retCode !== route.retCode
                                    ) {
                                        return undefined;
                                    }

                                    output = copyBytes(sso.body, 65536);
                                    const result: OwnerPushBody = { meta: route, body: output };
                                    nowChecked(generation);
                                    localFence();
                                    transferred = true;
                                    return result;
                                } catch {
                                    return undefined;
                                } finally {
                                    if (!transferred) {
                                        wipe(output);
                                    }

                                    wipe(sso?.body);
                                    wipe(sso?.cookie);
                                    wipe(sso?.reserved);
                                    wipe(sso?.headerExtension);
                                    wipe(decoded?.body);
                                    wipe(frameCopy);
                                }
                            },
                        ]);
                        check(generation);
                    } catch (error) {
                        // Only the token created by this owner is ours to revoke, including
                        // when close reentered before the returned token was assigned.
                        try {
                            revokeLinuxEasyKey(created);
                        } catch {
                            /* Continue local teardown even if erasure failed. */
                        }

                        if (capability === created) {
                            capability = undefined;
                        }

                        try {
                            Reflect.apply(weakMapDelete, classifiers, [owner]);
                            Reflect.apply(weakMapDelete, pushBodyExtractors, [owner]);
                        } catch {
                            /* Continue teardown if internal extractor removal fails. */
                        }

                        try {
                            stop('failed');
                        } finally {
                            // A reentrant close may already have made stop a no-op.
                            try {
                                acquired.poison();
                            } catch {
                                /* best effort */
                            }
                        }

                        throw error;
                    }
                }

                stage = 'login';
                const loginOptions: LinuxEasyLoginSessionOptions = {
                    ...(login as unknown as Omit<LinuxEasyLoginSessionOptions, 'signal'>),
                    signal: controller.signal,
                };
                const pendingLogin = loginCapability
                    ? runLinuxEasyLoginSessionWithKeyCapability(
                          acquired,
                          loginOptions,
                          loginCapability,
                      )
                    : runLinuxEasyLoginSession(acquired, loginOptions);
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

                if (loginCapability) {
                    if (lease !== acquired || capability !== loginCapability) {
                        throw new Error('stopped');
                    }

                    assertLinuxEasyKeyTentative({
                        token: loginCapability,
                        lease: acquired,
                        uin,
                        sequence: loginResult.easyLoginSequence,
                    });
                    check(generation);
                }

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

                check(generation);

                if (loginCapability) {
                    if (lease !== acquired || capability !== loginCapability) {
                        throw new Error('stopped');
                    }

                    // Keep the owner's decoded key for send; commit uses a separate,
                    // plain comparison copy that is wiped on every outcome.
                    let comparisonKey: Uint8Array | undefined;

                    try {
                        comparisonKey = Uint8Array.from(decoded.d2Key);
                        check(generation);
                        commitLinuxEasyKey({
                            token: loginCapability,
                            lease: acquired,
                            uin,
                            sequence: loginResult.easyLoginSequence,
                            comparisonKey,
                        });
                    } finally {
                        wipe(comparisonKey);
                    }

                    check(generation);

                    if (
                        lease !== acquired ||
                        capability !== loginCapability ||
                        linuxEasyKeyState(loginCapability) !== 'active'
                    ) {
                        throw new Error('stopped');
                    }
                }

                // Keep only the registration profile and tickets used by the send flow.
                // Its a1 input is copied then wiped without use, so retain no original a1.
                const guid = profile.guid as Uint8Array;
                const keep = new Set([guid, decoded.a2, decoded.d2, decoded.d2Key]);

                for (const bytes of owned) {
                    if (!keep.has(bytes)) {
                        wipe(bytes);
                        owned.delete(bytes);
                    }
                }

                check(generation);
                session = {
                    uin,
                    uid: details.uid as string,
                    profile: {
                        guid,
                        version: profile.version as string,
                        subAppId: profile.subAppId as number,
                    },
                    tickets: {
                        a1: new Uint8Array(0),
                        a2: decoded.a2,
                        d2: decoded.d2,
                        d2Key: decoded.d2Key,
                    },
                    buildReserved:
                        registration.buildReserved as SsoReferenceSendTextOptions['buildReserved'],
                    verifyRaw: registration.verifyRaw as SsoReferenceSendTextOptions['verifyRaw'],
                };

                if (loginCapability) {
                    // Last clock/reentry fence follows cleanup and session construction.
                    check(generation);

                    if (
                        currentState() !== 'starting' ||
                        lease !== acquired ||
                        capability !== loginCapability ||
                        linuxEasyKeyState(loginCapability) !== 'active'
                    ) {
                        throw new Error('stopped');
                    }
                }

                state = 'registered';
                succeeded = true;
                return { kind: 'registered', registerSequence: result.sequence };
            } catch {
                return fail(currentState() === 'closed' ? stopReason : 'invalid-or-failed');
            } finally {
                if (!succeeded && withKeyCapability) {
                    stop('failed');
                }

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
    return owner;
}
