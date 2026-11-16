import { addAbortListener } from 'node:events';
import { isPromise, isProxy } from 'node:util/types';
import type { KeyExchangeFlowResult } from './key-exchange-flow';
import {
    assertLinuxEasyKeyTentative,
    linuxEasyKeyState,
    reserveLinuxEasyKeyForSession,
    revokeLinuxEasyKey,
    type LinuxEasyKeySessionReservation,
    type LinuxEasyKeyToken,
} from './linux-easy-key-capability';
import type { LinuxNTLoginReferenceResponse } from './nt-linux-login-response-reference';
import type { RawSessionLease } from './raw-session-broker';
import { MAX_SERVICE_FRAME_BYTES } from './service-frame';
import {
    referenceKeyExchangeOnTransport,
    type SsoReferenceKeyExchangeOptions,
} from './sso-reference-key-exchange-flow';
import {
    referenceLinuxEasyLoginOnTransport,
    referenceLinuxEasyLoginWithReservedKeyCapability,
    type SsoReferenceLinuxEasyLoginOptions,
} from './sso-reference-linux-easy-login-flow';
import type { Sso12RawOptions, Sso12RawResult, Sso12RawTransport } from './sso12-packet-client';

export interface LinuxEasyLoginSessionOptions {
    uin: string;
    guid: Uint8Array;
    version: string;
    subAppId: number;
    a2?: Uint8Array;
    a1: Uint8Array;
    nonce: Uint8Array;
    deviceName: string;
    deviceType: string;
    appId: number;
    appName: string;
    qua: string;
    cookie?: string;
    serverPublicKey: Uint8Array;
    verifyKey: Uint8Array;
    timestamp: number;
    timeoutMs: number;
    signal?: AbortSignal;
    buildReserved: SsoReferenceKeyExchangeOptions['buildReserved'];
    verifyRaw: SsoReferenceKeyExchangeOptions['verifyRaw'];
    verifyServerResponse: SsoReferenceKeyExchangeOptions['verifyServerResponse'];
    acceptKeyExchange: (input: { uin: string; expiration: number | undefined }) => boolean;
}

export type LinuxEasyLoginSessionWrite = 'not-started' | 'not-written' | 'unknown' | 'written';
export type LinuxEasyLoginSessionResult =
    | {
          kind: 'response';
          keyExchangeSequence: number;
          easyLoginSequence: number;
          value: LinuxNTLoginReferenceResponse;
      }
    | {
          kind: 'failure';
          stage: 'session' | 'key-exchange' | 'key-policy' | 'easy-login';
          code:
              | 'invalid-input'
              | 'lease-unavailable'
              | 'cancelled'
              | 'timeout'
              | 'key-exchange-failed'
              | 'key-policy-rejected'
              | 'easy-login-failed'
              | 'session-failed';
          keyExchangeWrite: LinuxEasyLoginSessionWrite;
          easyLoginWrite: LinuxEasyLoginSessionWrite;
          poison: 'not-requested' | 'requested' | 'uncertain';
      };

type Failure = Extract<LinuxEasyLoginSessionResult, { kind: 'failure' }>;
const claimed = new WeakSet<object>();
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const getLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const getBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const getTag = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const getArrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const getResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const getAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const values = Uint8Array.prototype.values;
const setBytes = Uint8Array.prototype.set;
const fillBytes = Uint8Array.prototype.fill;
const promiseThen = Promise.prototype.then;
const LIMIT = 1024 * 1024;

// Synchronous policy/teardown callbacks must not return promises. Observe the
// rejection of genuine promises without treating them as successful decisions.
function observeUnexpectedPromise(value: unknown): boolean {
    if (isProxy(value) || !isPromise(value)) {
        return false;
    }

    try {
        void promiseThen.call(
            value,
            () => undefined,
            () => undefined,
        );
    } catch {
        // Mutated Promise internals or species remain outside this local boundary.
    }

    return true;
}

function wipe(value: Uint8Array | null | undefined): void {
    if (value) {
        try {
            fillBytes.call(value, 0);
        } catch {
            // Detached storage and copies outside this layer are not covered.
        }
    }
}

function copyBytes(value: unknown, max: number): Uint8Array {
    if (isProxy(value) || !ArrayBuffer.isView(value) || getTag.call(value) !== 'Uint8Array') {
        throw new TypeError('invalid bytes');
    }

    const proto = Object.getPrototypeOf(value);

    if (proto !== Uint8Array.prototype && proto !== Buffer.prototype) {
        throw new TypeError('invalid bytes');
    }

    // Only intrinsics inspect byte views: no per-index ownKeys enumeration or user getters.
    values.call(value);
    const storage = getBuffer.call(value) as ArrayBuffer;
    getArrayBufferLength.call(storage); // Rejects SharedArrayBuffer and detached storage.

    if (getResizable?.call(storage)) {
        throw new TypeError('invalid bytes');
    }

    const length = getLength.call(value) as number;
    const offset = getOffset.call(value) as number;

    if (length > max) {
        throw new TypeError('invalid bytes');
    }

    const result = new Uint8Array(length);
    setBytes.call(result, new Uint8Array(storage, offset, length));
    return result;
}

function plainOptions(value: unknown): LinuxEasyLoginSessionOptions {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        throw new TypeError('invalid options');
    }

    const proto = Object.getPrototypeOf(value);

    if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('invalid options');
    }

    const allowed = new Set([
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
        'signal',
        'buildReserved',
        'verifyRaw',
        'verifyServerResponse',
        'acceptKeyExchange',
    ]);
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (
            typeof key !== 'string' ||
            !allowed.has(key) ||
            !descriptor ||
            !Object.hasOwn(descriptor, 'value')
        ) {
            throw new TypeError('invalid options');
        }

        out[key] = descriptor.value;
    }

    return out as unknown as LinuxEasyLoginSessionOptions;
}

function validSignal(signal: unknown): signal is AbortSignal {
    if (
        typeof signal !== 'object' ||
        signal === null ||
        isProxy(signal) ||
        Object.getPrototypeOf(signal) !== AbortSignal.prototype ||
        Object.hasOwn(signal, 'aborted') ||
        Object.hasOwn(signal, 'addEventListener') ||
        Object.hasOwn(signal, 'removeEventListener')
    ) {
        return false;
    }

    try {
        getAborted.call(signal);
        return true;
    } catch {
        return false;
    }
}

function disposeKey(value: KeyExchangeFlowResult | undefined): void {
    if (value) {
        wipe(value.sessionKey);
        wipe(value.sessionTicket);
    }
}

/**
 * One local reference composition. The exact lease is claimed once in this module;
 * this is not branding, peer authentication, cross-module coordination or a way to
 * prevent direct use by its owner. The owner must retain exclusivity and must not
 * release or use it during this call. Success leaves it with the owner, who must
 * establish actual quiescence; whenClosed is asynchronous, not a synchronous fence.
 * Verifiers and the key policy are caller policy. Key provenance, peer authentication,
 * expiry, replay and nonce uniqueness remain caller responsibilities; expiration is
 * opaque. The policy is evaluated once between stages and is not a guarantee that
 * it remains valid through the final response. A response status is not interpreted
 * as login or online status.
 *
 * Timeout depends on event-loop progress. Stop/poison and wiping are best effort:
 * already-running transport, guards, callbacks, crypto and runtime copies can outlive
 * settlement. It does not allocate nonces, retry, integrate production, or prove closure.
 */
export function runLinuxEasyLoginSession(
    lease: RawSessionLease,
    options: LinuxEasyLoginSessionOptions,
): Promise<LinuxEasyLoginSessionResult> {
    return runSession(lease, options);
}

/**
 * Internal composition only: the token is reserved for this exact raw lease and
 * account before any external callback. A response transfers only tentative state;
 * registration, key comparison, commit, delivery and eventual revocation remain
 * the owner's responsibility. whenClosed is observed asynchronously.
 */
export async function runLinuxEasyLoginSessionWithKeyCapability(
    lease: RawSessionLease,
    options: LinuxEasyLoginSessionOptions,
    token: LinuxEasyKeyToken,
): Promise<LinuxEasyLoginSessionResult> {
    const cleanupState: { failure?: Failure } = Object.create(null) as { failure?: Failure };

    try {
        const result = await runSession(lease, options, { token }, cleanupState);
        return cleanupState.failure ?? result;
    } catch (error) {
        if (cleanupState.failure) {
            return cleanupState.failure;
        }

        throw error;
    }
}

async function runSession(
    lease: RawSessionLease,
    options: LinuxEasyLoginSessionOptions,
    capability?: { token: LinuxEasyKeyToken },
    cleanupState?: { failure?: Failure },
): Promise<LinuxEasyLoginSessionResult> {
    const started = performance.now();
    let stage: Failure['stage'] = 'session';
    let keyWrite: LinuxEasyLoginSessionWrite = 'not-started';
    let easyWrite: LinuxEasyLoginSessionWrite = 'not-started';
    // The transport callback changes these across await; read through functions
    // because TypeScript does not model those callback-side assignments.
    const currentKeyWrite = (): LinuxEasyLoginSessionWrite => keyWrite;
    const currentEasyWrite = (): LinuxEasyLoginSessionWrite => easyWrite;
    let poison: Failure['poison'] = 'not-requested';
    let poisonMethod: (() => void) | undefined;
    let hasClaim = false;
    let active = true;
    let deadline = Infinity;
    let stopCode: 'cancelled' | 'timeout' | 'lease-unavailable' | undefined;
    let leaseWatch: (() => void) | undefined;
    let listener: ReturnType<typeof addAbortListener> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let signal: AbortSignal | undefined;
    let keyResult: KeyExchangeFlowResult | undefined;
    let easyResult: LinuxNTLoginReferenceResponse | undefined;
    let reservation: LinuxEasyKeySessionReservation | undefined;
    let capabilityOwned = false;
    let leaseClosed = false;
    let capabilityOutput: Extract<LinuxEasyLoginSessionResult, { kind: 'response' }> | undefined;
    let capabilityUin: string | undefined;
    const owned = new Set<Uint8Array>();
    const controller = new AbortController();
    let resolveStop!: () => void;
    const stopped = new Promise<void>((resolve) => {
        resolveStop = resolve;
    });

    const track = (value: Uint8Array): Uint8Array => {
        owned.add(value);
        return value;
    };

    const fail = (code: Failure['code']): Failure => ({
        kind: 'failure',
        stage,
        code,
        keyExchangeWrite: keyWrite,
        easyLoginWrite: easyWrite,
        poison,
    });

    const revokeCapability = (): void => {
        if (capability && capabilityOwned) {
            capabilityOwned = false;
            revokeLinuxEasyKey(capability.token);
        }
    };

    const requestPoison = (): void => {
        if (capability) {
            active = false;

            try {
                revokeCapability();
            } catch {
                // Teardown continues if the capability implementation fails.
            }
        }

        if (!hasClaim || poison !== 'not-requested') {
            return;
        }

        // Set before calling external code to prevent duplicate calls on reentry.
        poison = 'uncertain';

        try {
            const returned: unknown = Reflect.apply(poisonMethod!, lease, []);

            // A Promise violates the synchronous poison contract; observing it
            // avoids an unhandled rejection but does not prove teardown occurred.
            if (!observeUnexpectedPromise(returned)) {
                poison = 'requested';
            }
        } catch {
            // Invocation was attempted; closure remains unknown.
        }
    };

    const stop = (code: 'cancelled' | 'timeout' | 'lease-unavailable'): void => {
        if (!active) {
            return;
        }

        active = false;
        stopCode = code;
        requestPoison();
        controller.abort();
        resolveStop();
    };

    const check = (): void => {
        if (active && signal && getAborted.call(signal)) {
            stop('cancelled');
        }

        if (active && performance.now() >= deadline) {
            stop('timeout');
        }

        if (active && capability && capabilityOwned) {
            try {
                const state = linuxEasyKeyState(capability.token);

                if (state !== 'empty' && !(stage === 'easy-login' && state === 'tentative')) {
                    stop('lease-unavailable');
                }
            } catch {
                stop('lease-unavailable');
            }
        }

        if (!active) {
            throw new Error('stopped');
        }
    };

    const remaining = (): number => {
        check();
        return Math.min(0x7fffffff, Math.max(1, Math.ceil(deadline - performance.now())));
    };

    try {
        const input = plainOptions(options);
        const text = (value: unknown): value is string =>
            typeof value === 'string' &&
            value.length <= LIMIT &&
            !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
        const int = (value: unknown, max: number): value is number =>
            typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

        if (
            typeof input.uin !== 'string' ||
            !/^[1-9][0-9]{0,18}$/.test(input.uin) ||
            (input.uin.length === 19 && input.uin > '9223372036854775807') ||
            !text(input.version) ||
            !input.version.length ||
            Buffer.byteLength(input.version) > 0xfffd ||
            !text(input.deviceName) ||
            !text(input.deviceType) ||
            !text(input.appName) ||
            !text(input.qua) ||
            (input.cookie !== undefined && !text(input.cookie)) ||
            !int(input.subAppId, 0x7fffffff) ||
            !int(input.appId, 0x7fffffff) ||
            !int(input.timestamp, 0xffffffff) ||
            !int(input.timeoutMs, 0x7fffffff) ||
            input.timeoutMs < 1 ||
            [
                input.buildReserved,
                input.verifyRaw,
                input.verifyServerResponse,
                input.acceptKeyExchange,
            ].some((fn) => typeof fn !== 'function' || isProxy(fn)) ||
            (input.signal !== undefined && !validSignal(input.signal))
        ) {
            return fail('invalid-input');
        }

        deadline = started + input.timeoutMs;
        signal = input.signal;
        // Snapshot *all* byte inputs before any callback, transport call, or await.
        const guid = track(copyBytes(input.guid, LIMIT));
        const a2 = track(
            input.a2 === undefined
                ? new Uint8Array(0)
                : copyBytes(input.a2, MAX_SERVICE_FRAME_BYTES),
        );
        const a1 = track(copyBytes(input.a1, LIMIT));
        const nonce = track(copyBytes(input.nonce, LIMIT));
        const serverPublicKey = track(copyBytes(input.serverPublicKey, 65));
        const verifyKey = track(copyBytes(input.verifyKey, 32));
        // The local descriptor projection may be retained by outstanding callbacks.
        // Point it only at our wipeable snapshots, never at caller byte arrays.
        input.guid = guid;
        input.a2 = a2;
        input.a1 = a1;
        input.nonce = nonce;
        input.serverPublicKey = serverPublicKey;
        input.verifyKey = verifyKey;

        if (
            !guid.length ||
            !a1.length ||
            nonce.length !== 12 ||
            serverPublicKey.length !== 65 ||
            serverPublicKey[0] !== 4 ||
            verifyKey.length !== 32 ||
            guid.length * 3 + a2.length + Buffer.byteLength(input.version) + 512 >
                MAX_SERVICE_FRAME_BYTES
        ) {
            return fail('invalid-input');
        }

        if (
            (typeof lease !== 'object' && typeof lease !== 'function') ||
            lease === null ||
            isProxy(lease)
        ) {
            return fail('lease-unavailable');
        }

        const transactDescriptor = Object.getOwnPropertyDescriptor(lease, 'transactRaw');
        const poisonDescriptor = Object.getOwnPropertyDescriptor(lease, 'poison');
        const closedDescriptor = Object.getOwnPropertyDescriptor(lease, 'whenClosed');

        if (
            !transactDescriptor ||
            !Object.hasOwn(transactDescriptor, 'value') ||
            typeof transactDescriptor.value !== 'function' ||
            isProxy(transactDescriptor.value) ||
            !poisonDescriptor ||
            !Object.hasOwn(poisonDescriptor, 'value') ||
            typeof poisonDescriptor.value !== 'function' ||
            isProxy(poisonDescriptor.value) ||
            !closedDescriptor ||
            !Object.hasOwn(closedDescriptor, 'value') ||
            isProxy(closedDescriptor.value) ||
            !isPromise(closedDescriptor.value) ||
            claimed.has(lease)
        ) {
            return fail('lease-unavailable');
        }

        const transact = transactDescriptor.value as Sso12RawTransport['transactRaw'];
        poisonMethod = poisonDescriptor.value as () => void;

        // Reservation and the local lease claim are synchronous, with no external
        // callback or await between the duplicate check and the two claims.
        if (capability) {
            reservation = reserveLinuxEasyKeyForSession({
                token: capability.token,
                lease,
                uin: input.uin,
            });
            capabilityOwned = true;
            capabilityUin = input.uin;
        }

        claimed.add(lease);
        hasClaim = true;
        leaseWatch = () => stop('lease-unavailable');

        const leaseSettled = (): void => {
            leaseClosed = true;

            try {
                leaseWatch?.();
            } catch {
                // External lifecycle reporting cannot create an unhandled rejection.
            }
        };

        // This observes termination asynchronously; it is not a synchronous fence.
        void promiseThen.call(closedDescriptor.value, leaseSettled, leaseSettled);

        if (signal) {
            listener = addAbortListener(signal, () => stop('cancelled'));
        }

        check();
        timer = setTimeout(() => stop('timeout'), remaining());
        const stable: Sso12RawTransport = {
            transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                check();

                if (stage === 'key-exchange') {
                    keyWrite = 'unknown';
                } else if (stage === 'easy-login') {
                    easyWrite = 'unknown';
                } else {
                    throw new Error('invalid stage');
                }

                let transaction = raw;

                if (capability && stage === 'easy-login') {
                    transaction = {
                        ...raw,
                        consumeCandidate: async (candidate, context, identity) => {
                            try {
                                check();
                                const result = await raw.consumeCandidate(
                                    candidate,
                                    context,
                                    identity,
                                );
                                check();
                                return result;
                            } catch {
                                // Recognize a deadline or cancellation reached during a
                                // throwing consume without mislabeling other failures.
                                try {
                                    check();
                                } catch {
                                    // check has already stopped and revoked the session.
                                }

                                // The mux must not release its hold while a failed or
                                // expired consume still leaves a tentative key usable.
                                requestPoison();
                                controller.abort();
                                resolveStop();
                                throw new Error('session consume failed');
                            }
                        },
                    };
                }

                const pending = Promise.resolve(
                    Reflect.apply(transact, lease, [transaction]) as Promise<Sso12RawResult<T>>,
                );
                // If the synchronous method reenters cancellation, check() can
                // throw before the child receives the promise; observe rejection first.
                void promiseThen.call(
                    pending,
                    () => undefined,
                    () => undefined,
                );
                check();
                return pending;
            },
        };

        const buildReserved: SsoReferenceKeyExchangeOptions['buildReserved'] = async (args) => {
            check();

            try {
                const result = await input.buildReserved(args);
                check();
                return result;
            } finally {
                check();
            }
        };

        const verifyRaw: SsoReferenceKeyExchangeOptions['verifyRaw'] = async (args) => {
            check();

            try {
                const result = await input.verifyRaw(args);
                check();
                return result;
            } finally {
                check();
            }
        };

        const verifyServerResponse: SsoReferenceKeyExchangeOptions['verifyServerResponse'] = (
            args,
        ) => {
            check();

            try {
                const result: unknown = input.verifyServerResponse(args);
                observeUnexpectedPromise(result);
                check();
                return result === true;
            } finally {
                check();
            }
        };

        stage = 'key-exchange';
        const keyPromise = referenceKeyExchangeOnTransport(stable, {
            uin: input.uin,
            guid,
            version: input.version,
            subAppId: input.subAppId,
            a2,
            serverPublicKey,
            verifyKey,
            timestamp: input.timestamp,
            buildReserved,
            verifyRaw,
            verifyServerResponse,
            timeoutMs: remaining(),
            signal: controller.signal,
        });
        const keyObserved = keyPromise.then(
            (result) => {
                if (result.kind === 'response') {
                    if (active) {
                        keyWrite = 'written';
                        keyResult = result.value;
                    } else {
                        disposeKey(result.value);
                    }
                }

                return result;
            },
            () => undefined,
        );
        const keyOutcome = await Promise.race([keyObserved, stopped.then(() => undefined)]);
        check();

        if (!keyOutcome || keyOutcome.kind !== 'response') {
            if (keyOutcome && currentKeyWrite() !== 'unknown') {
                keyWrite = keyOutcome.writeState;
            } else if (keyWrite === 'not-started') {
                keyWrite = 'not-written';
            }

            requestPoison();
            return fail('key-exchange-failed');
        }

        keyWrite = 'written';
        const keySequence = keyOutcome.sequence;
        stage = 'key-policy';
        const key = track(copyBytes(keyOutcome.value.sessionKey, LIMIT));
        const ticket = track(copyBytes(keyOutcome.value.sessionTicket, LIMIT));

        if (![16, 24, 32].includes(key.length) || !ticket.length) {
            requestPoison();
            return fail('key-policy-rejected');
        }

        check();
        const accepted: unknown = input.acceptKeyExchange({
            uin: input.uin,
            expiration: keyOutcome.value.expiration,
        });
        observeUnexpectedPromise(accepted);
        check();

        if (accepted !== true) {
            requestPoison();
            return fail('key-policy-rejected');
        }

        stage = 'easy-login';
        let easyPromise: Promise<Sso12RawResult<LinuxNTLoginReferenceResponse>>;

        try {
            const easyOptions: SsoReferenceLinuxEasyLoginOptions = {
                uin: input.uin,
                guid,
                version: input.version,
                subAppId: input.subAppId,
                a2,
                sessionKey: key,
                sessionTicket: ticket,
                a1,
                nonce,
                deviceName: input.deviceName,
                deviceType: input.deviceType,
                appId: input.appId,
                appName: input.appName,
                qua: input.qua,
                cookie: input.cookie,
                buildReserved,
                verifyRaw,
                timeoutMs: remaining(),
                signal: controller.signal,
            };

            if (capability) {
                if (!reservation || !capabilityOwned) {
                    throw new Error('missing capability reservation');
                }

                easyPromise = referenceLinuxEasyLoginWithReservedKeyCapability(
                    stable,
                    easyOptions,
                    {
                        token: capability.token,
                        lease,
                        reservation,
                    },
                );
            } else {
                easyPromise = referenceLinuxEasyLoginOnTransport(stable, easyOptions);
            }
        } finally {
            disposeKey(keyResult);
            keyResult = undefined;
            wipe(key);
            wipe(ticket);
            owned.delete(key);
            owned.delete(ticket);
        }

        const easyObserved = easyPromise.then(
            (result) => {
                if (result.kind === 'response') {
                    if (active) {
                        easyWrite = 'written';
                        easyResult = result.value;
                    } else {
                        wipe(result.value.body);
                    }
                }

                return result;
            },
            () => undefined,
        );
        const easyOutcome = await Promise.race([easyObserved, stopped.then(() => undefined)]);
        check();

        if (!easyOutcome || easyOutcome.kind !== 'response') {
            if (easyOutcome && currentEasyWrite() !== 'unknown') {
                easyWrite = easyOutcome.writeState;
            } else if (easyWrite === 'not-started') {
                easyWrite = 'not-written';
            }

            requestPoison();
            return fail('easy-login-failed');
        }

        easyWrite = 'written';
        const body =
            easyOutcome.value.body === null
                ? null
                : track(copyBytes(easyOutcome.value.body, LIMIT));
        check();
        const output: LinuxEasyLoginSessionResult = {
            kind: 'response',
            keyExchangeSequence: keySequence,
            easyLoginSequence: easyOutcome.sequence,
            value: { status: easyOutcome.value.status, body },
        };

        if (capability) {
            capabilityOutput = output;
        } else if (body) {
            owned.delete(body);
        }

        return output;
    } catch {
        requestPoison();

        if (stopCode) {
            return fail(stopCode);
        }

        return fail(
            hasClaim
                ? stage === 'key-exchange'
                    ? 'key-exchange-failed'
                    : stage === 'key-policy'
                      ? 'key-policy-rejected'
                      : stage === 'easy-login'
                        ? 'easy-login-failed'
                        : 'session-failed'
                : 'invalid-input',
        );
    } finally {
        active = false;
        leaseWatch = undefined;

        if (capability) {
            if (!capabilityOutput) {
                requestPoison();
            }

            let cleanupSucceeded = true;

            try {
                if (timer !== undefined) {
                    clearTimeout(timer);
                }

                listener?.[Symbol.dispose]();
            } catch {
                cleanupSucceeded = false;
            }

            disposeKey(keyResult);
            wipe(easyResult?.body);

            for (const value of owned) {
                if (value !== capabilityOutput?.value.body) {
                    wipe(value);
                }
            }

            owned.clear();

            const canTransfer = (): boolean => {
                try {
                    if (signal && getAborted.call(signal)) {
                        stopCode = 'cancelled';
                    } else if (performance.now() >= deadline) {
                        stopCode = 'timeout';
                    } else if (leaseClosed) {
                        stopCode = 'lease-unavailable';
                    }

                    if (
                        !cleanupSucceeded ||
                        stopCode ||
                        !capabilityOwned ||
                        capabilityUin === undefined ||
                        !capabilityOutput ||
                        capabilityOutput.value.status.kind !== 'code' ||
                        capabilityOutput.value.status.codePresent !== true ||
                        capabilityOutput.value.status.code !== 0n ||
                        capabilityOutput.value.body === null
                    ) {
                        return false;
                    }

                    assertLinuxEasyKeyTentative({
                        token: capability.token,
                        lease,
                        uin: capabilityUin,
                        sequence: capabilityOutput.easyLoginSequence,
                    });
                    return true;
                } catch {
                    return false;
                }
            };

            if (capabilityOutput && !canTransfer()) {
                requestPoison();
            }

            try {
                controller.abort();
            } catch {
                cleanupSucceeded = false;
            }

            if (capabilityOutput && !canTransfer()) {
                requestPoison();
                wipe(capabilityOutput.value.body);
                cleanupState!.failure = fail(stopCode ?? 'easy-login-failed');
            }
        } else {
            if (timer !== undefined) {
                clearTimeout(timer);
            }

            try {
                listener?.[Symbol.dispose]();
            } catch {
                /* best effort */
            }

            controller.abort();
            disposeKey(keyResult);
            wipe(easyResult?.body);

            for (const value of owned) {
                wipe(value);
            }

            owned.clear();
        }
    }
}
