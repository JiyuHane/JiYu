import { addAbortListener } from 'node:events';
import { isProxy, isPromise, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import type { RawSessionLease } from './raw-session-broker';
import {
    createBorrowedWtReferenceLoginAttempt,
    type BorrowedWtReferenceLoginAttempt,
    type BorrowedWtReferenceLoginAttemptOptions,
    type WtReferenceLoginResult,
} from './wt-reference-login-attempt';
import {
    referenceRegisterOnTransport,
    type SsoReferenceRegisterBorrowedOptions,
} from './sso-reference-register-flow';
import type { SsoRegisterOutcome } from './sso-register';

type AttemptOptions = BorrowedWtReferenceLoginAttemptOptions;
type RegisterOptions = SsoReferenceRegisterBorrowedOptions;
type Registration = Omit<RegisterOptions['registration'], 'uid'>;
type FetchFields = Parameters<BorrowedWtReferenceLoginAttempt['fetch']>[0];
type LoginFields = Parameters<BorrowedWtReferenceLoginAttempt['login']>[0];
type LoginFailure = Exclude<WtReferenceLoginResult, { status: 'tickets' }>;

export interface WtReferenceSessionOptions extends Omit<
    AttemptOptions,
    'enableUidProjection' | 'buildReserved'
> {
    buildWtReserved: AttemptOptions['buildReserved'];
    registration: Registration;
    buildRegisterReserved: RegisterOptions['buildReserved'];
    verifyRegisterRaw: RegisterOptions['verifyRaw'];
}

export type WtReferenceSessionState =
    'new' | 'qr-ready' | 'confirmed' | 'login-register' | 'success' | 'failed' | 'closed';
export type WtReferenceSessionResult = LoginFailure | { status: SsoRegisterOutcome };
export interface WtReferenceSession {
    getState(): WtReferenceSessionState;
    fetch(fields: FetchFields): ReturnType<BorrowedWtReferenceLoginAttempt['fetch']>;
    poll(): ReturnType<BorrowedWtReferenceLoginAttempt['poll']>;
    loginAndRegister(fields: LoginFields): Promise<WtReferenceSessionResult>;
    close(): void;
}

const claimed = new WeakSet<object>();
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const length = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const offset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const values = Uint8Array.prototype.values;
const fill = Uint8Array.prototype.fill;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const then = Promise.prototype.then;

function wipe(bytes: Uint8Array | undefined): void {
    if (bytes) {
        try {
            fill.call(bytes, 0);
        } catch {
            /* best effort */
        }
    }
}

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || isProxy(value)) {
        throw new TypeError('invalid session configuration');
    }

    const proto = Object.getPrototypeOf(value) as unknown;

    if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('invalid session configuration');
    }

    const keys = Reflect.ownKeys(value);

    if (keys.length > 32) {
        throw new TypeError('invalid session configuration');
    }

    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (
            typeof key !== 'string' ||
            !allowed.includes(key) ||
            !descriptor ||
            !('value' in descriptor)
        ) {
            throw new TypeError('invalid session configuration');
        }

        result[key] = descriptor.value;
    }

    return result;
}

function copyBytes(value: unknown, max: number): Uint8Array {
    if (isProxy(value) || !isUint8Array(value)) {
        throw new TypeError('invalid bytes');
    }

    values.call(value);
    const size = length.call(value) as number;
    const storage = buffer.call(value) as ArrayBufferLike;

    if (size > max || isSharedArrayBuffer(storage) || (resizable && resizable.call(storage))) {
        throw new TypeError('invalid bytes');
    }

    const keys = Reflect.ownKeys(value);

    if (keys.length > size + 16) {
        throw new TypeError('invalid bytes');
    }

    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (!descriptor || !('value' in descriptor)) {
            throw new TypeError('invalid bytes');
        }
    }

    return Uint8Array.from(new Uint8Array(storage, offset.call(value) as number, size));
}

function text(value: unknown, nonempty: boolean, max = 4096): value is string {
    return (
        typeof value === 'string' &&
        (!nonempty || value.length > 0) &&
        Buffer.byteLength(value) <= max
    );
}

/**
 * A single local owner coordinates a borrowed lease. The caller must not use or
 * release it behind this object and must trust successful transport quiescence.
 * whenClosed is asynchronous, not a synchronous revocation fence; no protection
 * against arbitrary same-process effects, peer authentication, or online state is
 * implied. Signer/verifier callbacks can retain data or cause external effects.
 * UID is passed to the registration signer; its opaque output is not proof the
 * UID was encoded or the signature is valid. JS strings cannot be erased.
 * Success is only the local response classification. The internal ticket and
 * profile snapshots remain owned until close, cancellation or lease termination,
 * for future operations; this API exposes no ticket access or message operation.
 * Idle close after success leaves the lease with its caller, which should close
 * this owner before releasing it. In-flight or abandoned post-write close,
 * failure and cancellation poison the lease. Erasure is best effort.
 */
export function createWtReferenceSession(
    lease: RawSessionLease,
    options: WtReferenceSessionOptions,
): WtReferenceSession {
    if (!lease || typeof lease !== 'object' || isProxy(lease) || claimed.has(lease)) {
        throw new TypeError('invalid or already claimed lease');
    }

    claimed.add(lease);
    let attempt: BorrowedWtReferenceLoginAttempt | undefined;
    let state: WtReferenceSessionState = 'new';
    let busy = false;
    let poisoned = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: ReturnType<typeof addAbortListener> | undefined;
    let retained: Extract<WtReferenceLoginResult, { status: 'tickets' }> | undefined;
    const controller = new AbortController();
    const owned: Uint8Array[] = [];

    const wipeAll = (): void => {
        for (const value of owned) {
            wipe(value);
        }

        owned.length = 0;
    };

    const poison = (): void => {
        if (!poisoned) {
            poisoned = true;

            try {
                lease.poison();
            } catch {
                /* lease owns its teardown */
            }
        }
    };

    const stopAttempt = (): void => {
        const stoppedAttempt = attempt;
        attempt = undefined;

        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }

        stoppedAttempt?.close();
        controller.abort();
    };

    const cleanup = (): void => {
        if (abortListener) {
            try {
                abortListener[Symbol.dispose]();
            } catch {
                /* best effort */
            }

            abortListener = undefined;
        }

        stopAttempt();

        if (retained) {
            wipe(retained.tickets.d2);
            wipe(retained.tickets.d2Key);
            wipe(retained.tickets.a1);
            wipe(retained.tickets.a2);
            delete retained.uidProjection;
            retained = undefined;
        }

        wipeAll();
    };

    const fail = (): void => {
        if (state !== 'closed') {
            state = 'failed';
        }

        poison();
        cleanup();
    };

    try {
        const input = record(options, [
            'profile',
            'timeoutMs',
            'attemptTimeoutMs',
            'signal',
            'getTimestamp',
            'buildWtReserved',
            'verifyRaw',
            'verifyContext',
            'sliceBusiness',
            'registration',
            'buildRegisterReserved',
            'verifyRegisterRaw',
        ]);
        const p = record(input.profile, [
            'uin',
            'appId',
            'subAppId',
            'clientVersion',
            'ssoVersion',
            'qrCommand',
            'loginCommand',
            'guid',
            'unknown21',
            'randomKey',
            'peerPublicKey',
        ]);
        const reg = record(input.registration, [
            'version',
            'deviceName',
            'deviceType',
            'vendorOs',
            'random',
        ]);

        const take = (value: unknown, max: number): Uint8Array => {
            const result = copyBytes(value, max);
            owned.push(result);
            return result;
        };

        const guid = take(p.guid, 0xffff);
        const unknown21 = take(p.unknown21, 21);
        const randomKey = take(p.randomKey, 16);
        const peerPublicKey = take(p.peerPublicKey, 0xffff);
        const registration = {
            version: reg.version,
            deviceName: reg.deviceName,
            deviceType: reg.deviceType,
            vendorOs: reg.vendorOs,
            random: reg.random,
        };
        const timeout = input.timeoutMs;
        const lifetime = input.attemptTimeoutMs;

        if (
            !text(registration.version, true) ||
            !text(registration.deviceName, false) ||
            !text(registration.deviceType, false) ||
            !text(registration.vendorOs, false) ||
            !Number.isInteger(registration.random) ||
            (registration.random as number) < 0 ||
            (registration.random as number) >= 0x7fffffff ||
            !text(p.ssoVersion, true, 0xfffd) ||
            !guid.length ||
            !Number.isInteger(timeout) ||
            (timeout as number) < 1 ||
            (timeout as number) > 0x7fffffff ||
            !Number.isInteger(lifetime) ||
            (lifetime as number) < 1 ||
            (lifetime as number) > 0x7fffffff ||
            [
                input.getTimestamp,
                input.buildWtReserved,
                input.verifyRaw,
                input.verifyContext,
                input.sliceBusiness,
            ].some((callback) => typeof callback !== 'function' || isProxy(callback)) ||
            typeof input.buildRegisterReserved !== 'function' ||
            isProxy(input.buildRegisterReserved) ||
            typeof input.verifyRegisterRaw !== 'function' ||
            isProxy(input.verifyRegisterRaw)
        ) {
            throw new TypeError('invalid session configuration');
        }

        const signal = input.signal as AbortSignal | undefined;

        if (
            signal !== undefined &&
            (isProxy(signal) ||
                Object.getPrototypeOf(signal) !== AbortSignal.prototype ||
                Object.hasOwn(signal, 'aborted') ||
                Object.hasOwn(signal, 'addEventListener') ||
                Object.hasOwn(signal, 'removeEventListener'))
        ) {
            throw new TypeError('invalid signal');
        }

        if (signal !== undefined) {
            aborted.call(signal);
        }

        const deadline = performance.now() + (lifetime as number);

        const active = (): void => {
            if (
                state === 'failed' ||
                state === 'closed' ||
                controller.signal.aborted ||
                (signal && aborted.call(signal)) ||
                performance.now() >= deadline
            ) {
                throw new Error('session stopped');
            }
        };

        const enter = (expected: WtReferenceSessionState): void => {
            if (state === 'closed') {
                throw new Error('session closed');
            }

            if (busy || state !== expected) {
                fail();
                throw new Error('session single-flight or state violation');
            }

            try {
                active();
            } catch {
                fail();
                throw new Error('session stopped');
            }

            busy = true;
        };

        const profile = {
            uin: p.uin,
            appId: p.appId,
            subAppId: p.subAppId,
            clientVersion: p.clientVersion,
            ssoVersion: p.ssoVersion,
            qrCommand: p.qrCommand,
            loginCommand: p.loginCommand,
            guid,
            unknown21,
            randomKey,
            peerPublicKey,
        } as AttemptOptions['profile'];
        attempt = createBorrowedWtReferenceLoginAttempt(lease, {
            profile,
            timeoutMs: timeout as number,
            attemptTimeoutMs: lifetime as number,
            signal: controller.signal,
            enableUidProjection: true,
            getTimestamp: input.getTimestamp as AttemptOptions['getTimestamp'],
            buildReserved: input.buildWtReserved as AttemptOptions['buildReserved'],
            verifyRaw: input.verifyRaw as AttemptOptions['verifyRaw'],
            verifyContext: input.verifyContext as AttemptOptions['verifyContext'],
            sliceBusiness: input.sliceBusiness as AttemptOptions['sliceBusiness'],
        });
        wipe(unknown21);
        wipe(randomKey);
        wipe(peerPublicKey);

        if (signal) {
            abortListener = addAbortListener(signal, fail);
        }

        timer = setTimeout(fail, Math.max(1, Math.ceil(deadline - performance.now())));
        const closed = lease.whenClosed;
        const observed = isPromise(closed) ? closed : Promise.resolve(closed);
        void then.call(
            observed,
            () => {
                if (state !== 'closed') {
                    fail();
                }
            },
            () => {
                if (state !== 'closed') {
                    fail();
                }
            },
        );
        active();
        const signer = input.buildRegisterReserved as RegisterOptions['buildReserved'];
        const verifier = input.verifyRegisterRaw as RegisterOptions['verifyRaw'];
        return {
            getState: () => state,
            async fetch(fields) {
                enter('new');

                try {
                    const result = await attempt!.fetch(fields);
                    active();
                    state = 'qr-ready';
                    return result;
                } catch {
                    fail();
                    throw new Error('session fetch failed');
                } finally {
                    busy = false;
                }
            },
            async poll() {
                enter('qr-ready');

                try {
                    const result = await attempt!.poll();
                    active();

                    if (result.status === 'confirmed') {
                        state = 'confirmed';
                    } else if (result.status !== 'wait' && result.status !== 'confirm') {
                        fail();
                    }

                    return result;
                } catch {
                    fail();
                    throw new Error('session poll failed');
                } finally {
                    busy = false;
                }
            },
            async loginAndRegister(fields) {
                enter('confirmed');
                state = 'login-register';
                let login: WtReferenceLoginResult | undefined;

                try {
                    login = await attempt!.login(fields);
                    active();

                    if (login.status !== 'tickets') {
                        fail();
                        return login;
                    }

                    if (
                        login.uidProjection?.status !== 'present' ||
                        !text(login.uidProjection.uid, true)
                    ) {
                        throw new Error('missing UID');
                    }

                    const uid = login.uidProjection.uid;
                    const result = await referenceRegisterOnTransport(lease, {
                        login,
                        profile: { guid, subAppId: profile.subAppId, version: profile.ssoVersion },
                        registration: { ...registration, uid } as RegisterOptions['registration'],
                        timeoutMs: timeout as number,
                        signal: controller.signal,
                        buildReserved: signer,
                        verifyRaw: verifier,
                    });
                    active();

                    if (result.kind !== 'response') {
                        throw new Error('registration transport failed');
                    }

                    if (result.value !== 'success') {
                        fail();
                        return { status: result.value };
                    }

                    retained = login;
                    state = 'success';
                    stopAttempt();

                    if (
                        state !== 'success' ||
                        (signal !== undefined && aborted.call(signal)) ||
                        performance.now() >= deadline
                    ) {
                        throw new Error('session stopped');
                    }

                    return { status: 'success' };
                } catch {
                    fail();
                    throw new Error('session login or registration failed');
                } finally {
                    if (login?.status === 'tickets' && retained !== login) {
                        wipe(login.tickets.d2);
                        wipe(login.tickets.d2Key);
                        wipe(login.tickets.a1);
                        wipe(login.tickets.a2);
                        delete login.uidProjection;
                    }

                    busy = false;
                }
            },
            close() {
                if (state === 'closed') {
                    return;
                }

                if (busy || (state !== 'new' && state !== 'success')) {
                    poison();
                }

                state = 'closed';
                cleanup();
            },
        };
    } catch {
        fail();
        throw new Error('invalid or stopped session');
    }
}
