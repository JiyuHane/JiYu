import { addAbortListener } from 'node:events';
import { isProxy, isPromise, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import type { RawSessionLease, RawSessionTerminalAuthority } from './raw-session-broker';
import {
    cancelReferenceTerminal,
    createReferenceTerminalPort,
    hasReferenceTerminal,
    takeReferenceTerminal,
    type ReferenceTerminalFence,
} from './wt-reference-terminal-private';
import {
    createBorrowedWtReferenceLoginAttempt,
    bindReferenceKeyCapability,
    bindReferenceTerminalPort,
    type BorrowedWtReferenceLoginAttempt,
    type BorrowedWtReferenceLoginAttemptOptions,
    type WtReferenceLoginResult,
} from './wt-reference-login-attempt';
import {
    referenceRegisterOnTransport,
    type SsoReferenceRegisterBorrowedOptions,
} from './sso-reference-register-flow';
import type { SsoRegisterOutcome } from './sso-register';
import {
    referenceHeartbeatOnTransport,
    type SsoHeartbeatOutcome,
} from './sso-reference-heartbeat-flow';
import { referenceAliveOnTransport, type SsoAliveOutcome } from './sso-reference-alive-flow';
import { encodeDirectSendMessageRequest } from './send-message-request';
import { referenceFriendWithCapability, WtReferenceFriendError } from './wt-reference-friend-flow';
import {
    referencePacketWithCapability,
    disposeReferencePacketResult,
    WtReferencePacketError,
    type WtReferencePacketResult,
} from './wt-reference-packet-flow';
import {
    assertReferenceKeyCapabilityAvailable,
    assertReferenceKeyReservation,
    assertReferenceTicketRefresh,
    beginReferenceTicketRefresh,
    bindReferenceRestoredOwnerLease,
    stageReferenceRestoredKey,
    assertReferenceSessionSendActive,
    publishReferenceSessionSend,
    type ReferenceSessionSendInput,
    type ReferenceSessionSendImplementation,
    type ReferenceSessionFriendImplementation,
    type ReferenceSessionPacketImplementation,
    type ReferencePacketOperation,
    beginReferencePacketOperation,
    assertReferencePacketOperation,
    endReferencePacketOperation,
    beginReferenceFriendWorkflow,
    endReferenceFriendWorkflow,
    endReferenceTicketRefresh,
    commitReferenceKey,
    discardReferenceBusinessFailure,
    reserveReferenceKeyCapability,
    referenceKeyState,
    revokeReferenceKey,
    rotateReferenceTicketKey,
    stageReferenceBusinessFailure,
    stageReferenceTicketRefreshCandidate,
} from './wt-reference-session-private';

import {
    cloneWtPersistedSession,
    disposeWtPersistedSession,
    type WtPersistedSessionV1,
    type WtSessionCheckpoint,
    type WtSessionCheckpointContext,
} from './wt-persisted-session';
import {
    disposeNativeTicketRefreshResult,
    refreshNativeTicketsOnTransport,
    NativeTicketRefreshError,
    type NativeTicketRefreshResult,
} from './nt-native-ticket-refresh';

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
    /** Explicit opt-in; absent preserves the original private, memory-only tickets. */
    checkpoint?: WtSessionCheckpoint;
}

export interface WtRestoredSessionOptions {
    persisted: WtPersistedSessionV1;
    profile: { subAppId: number; version: string };
    registration: Registration;
    timeoutMs: number;
    restoreTimeoutMs: number;
    signal?: AbortSignal;
    buildRegisterReserved: RegisterOptions['buildReserved'];
    verifyRegisterRaw: RegisterOptions['verifyRaw'];
    /** Preserves the legacy restored-registration save when explicitly supplied. */
    checkpoint?: WtSessionCheckpoint;
    /** Used only by later ticket renewal; omitted falls back to checkpoint. */
    renewalCheckpoint?: WtSessionCheckpoint;
}

export interface WtRefreshTicketsOptions {
    readonly signal?: AbortSignal;
    /** Whole refresh, durable checkpoint and activation deadline in milliseconds. */
    readonly timeoutMs?: number;
}

export type WtRefreshTicketsResult =
    | {
          readonly status: 'refreshed';
          /** Absolute Unix seconds, including zero when omitted by the protocol response. */
          readonly nextRefreshAtSeconds: bigint;
          /** Absolute Unix seconds, including zero when omitted by the protocol response. */
          readonly expiresAtSeconds: bigint;
      }
    | {
          readonly status: 'protocol-error';
          readonly code: bigint;
          readonly consecutiveProtocolErrors: number;
      }
    | { readonly status: 'empty-a1' }
    | { readonly status: 'needs-login'; readonly code: bigint }
    | {
          readonly status: 'disabled';
          readonly reason: 'protocol-errors';
          readonly consecutiveProtocolErrors: number;
          readonly lastCode: bigint;
      };

export type WtTicketRefreshErrorCode =
    | 'not-sent'
    | 'write-unknown'
    | 'checkpoint-failed'
    | 'invalidation-failed'
    | 'activation-failed'
    | 'stopped'
    | 'invalid-response';

export class WtTicketRefreshError extends Error {
    constructor(
        readonly code: WtTicketRefreshErrorCode,
        readonly writeState: 'not-written' | 'written' | 'unknown',
    ) {
        super(`WT ticket refresh: ${code}`);
        this.name = 'WtTicketRefreshError';
    }
}

export type WtReferenceSessionState =
    'new' | 'qr-ready' | 'confirmed' | 'login-register' | 'success' | 'failed' | 'closed';
export type WtRestoredSessionState = 'new' | 'restore-register' | 'success' | 'failed' | 'closed';
export type WtReferenceSessionResult = LoginFailure | { status: SsoRegisterOutcome };
export interface WtActiveReferenceSession {
    getState(): WtReferenceSessionState | WtRestoredSessionState;
    heartbeat(): Promise<SsoHeartbeatOutcome>;
    alive(): Promise<SsoAliveOutcome>;
    /** Fixed native NT ticket rotation; it never exposes credential bytes. */
    refreshTickets(options?: WtRefreshTicketsOptions): Promise<WtRefreshTicketsResult>;
    close(): void;
}
export interface WtRestoredSession extends WtActiveReferenceSession {
    getState(): WtRestoredSessionState;
    restoreAndRegister(): Promise<{ status: SsoRegisterOutcome }>;
}
export interface WtReferenceSession extends WtActiveReferenceSession {
    getState(): WtReferenceSessionState;
    fetch(fields: FetchFields): ReturnType<BorrowedWtReferenceLoginAttempt['fetch']>;
    poll(): ReturnType<BorrowedWtReferenceLoginAttempt['poll']>;
    loginAndRegister(fields: LoginFields): Promise<WtReferenceSessionResult>;
    /** A single explicit exchange; a missing interval is not a zero interval. */
    heartbeat(): Promise<SsoHeartbeatOutcome>;
    /** One explicit alive exchange after successful registration. */
    alive(): Promise<SsoAliveOutcome>;
    close(): void;
}

const claimed = new WeakSet<object>();
const RENEWAL_WAL_METADATA = Object.freeze({
    nextRefreshAtSeconds: 0n,
    expiresAtSeconds: 0n,
});
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const length = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const offset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const values = Uint8Array.prototype.values;
const fill = Uint8Array.prototype.fill;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const then = Promise.prototype.then;

// A retained timer callback owns only this revocable box, not the session.
function createTimerDispatch(gate: { run?: () => void }): () => void {
    return () => gate.run?.();
}

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
 * UID is passed to the registration, heartbeat and alive signer; its output is not
 * proof the UID was encoded or the signature is valid. JS strings cannot be erased.
 * Success is only the local response classification. The internal ticket and
 * profile snapshots remain owned until close, cancellation or lease termination.
 * Heartbeat and alive are caller-driven. No alive timer is started: V2 schedules
 * its two-second alive after socket connect, not after login; without a long-lived
 * push multiplexer this post-registration exchange is only a conservative subset.
 * No heartbeat interval unit is inferred, and missing remains distinct from zero.
 * This API exposes no tickets or messaging.
 * Idle close after success leaves the lease with its caller, which should close
 * this owner before releasing it. In-flight or abandoned post-write close,
 * failure and cancellation poison the lease. Erasure is best effort.
 */
export function createWtReferenceSession(
    lease: RawSessionLease,
    options: WtReferenceSessionOptions,
): WtReferenceSession {
    return createSession(lease, options);
}

/** Internal factory for a composite owner; capability is never returned by this session. */
export function createWtReferenceSessionWithCapability(
    lease: RawSessionLease,
    options: WtReferenceSessionOptions,
    capability: object,
    terminal?: RawSessionTerminalAuthority,
    fence?: ReferenceTerminalFence,
): WtReferenceSession {
    assertReferenceKeyCapabilityAvailable(capability);
    return createSession(lease, options, capability, terminal, fence);
}

/** Internal restored owner. The factory only validates and binds; registration is explicit. */
export function createWtRestoredSessionWithCapability(
    lease: RawSessionLease,
    options: WtRestoredSessionOptions,
    capability: object,
): WtRestoredSession {
    assertReferenceKeyCapabilityAvailable(capability);
    return createSession(lease, options, capability, undefined, undefined, true);
}

function createSession(
    lease: RawSessionLease,
    options: WtReferenceSessionOptions,
    capability?: object,
    terminal?: RawSessionTerminalAuthority,
    fence?: ReferenceTerminalFence,
    restored?: false,
): WtReferenceSession;
function createSession(
    lease: RawSessionLease,
    options: WtRestoredSessionOptions,
    capability: object,
    terminal: undefined,
    fence: undefined,
    restored: true,
): WtRestoredSession;

function createSession(
    lease: RawSessionLease,
    options: WtReferenceSessionOptions | WtRestoredSessionOptions,
    capability?: object,
    terminal?: RawSessionTerminalAuthority,
    fence?: ReferenceTerminalFence,
    restored = false,
): WtReferenceSession | WtRestoredSession {
    if (!lease || typeof lease !== 'object' || isProxy(lease) || claimed.has(lease)) {
        throw new TypeError('invalid or already claimed lease');
    }

    const reservation = capability ? reserveReferenceKeyCapability(capability) : undefined;
    claimed.add(lease);
    let attempt: BorrowedWtReferenceLoginAttempt | undefined;
    // QR attempts and restored origins share only opaque identity, never a fake QR lifecycle.
    let sendAttempt: object | undefined;
    let imported: WtPersistedSessionV1 | undefined;
    let checkpointRun: { cancel(): void } | undefined;
    let checkpointPending = false;
    let state: WtReferenceSessionState | WtRestoredSessionState = 'new';
    let busy = false;
    let poisoned = false;
    let epoch = 0;
    let terminalPort: object | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timerGate: { run?: () => void } | undefined;
    let abortListener: ReturnType<typeof addAbortListener> | undefined;
    let retained: Extract<WtReferenceLoginResult, { status: 'tickets' }> | undefined;
    let consecutiveProtocolErrors = 0;
    let refreshDisabledLastCode: bigint | undefined;
    const controller = new AbortController();
    // The attempt controller is aborted on login success; later operations need
    // their own lifetime, which ends only with this owner.
    const sessionController = new AbortController();
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

        if (timerGate) {
            timerGate.run = undefined;
            timerGate = undefined;
        }

        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }

        try {
            stoppedAttempt?.close();
        } finally {
            controller.abort();
        }
    };

    const revoke = (): void => {
        if (capability) {
            revokeReferenceKey(capability);
        }

        sendAttempt = undefined;
    };

    const cleanup = (): void => {
        checkpointPending = false;
        checkpointRun?.cancel();

        if (imported) {
            disposeWtPersistedSession(imported);
            imported = undefined;
        }

        try {
            revoke();
        } finally {
            try {
                sessionController.abort();
            } finally {
                if (abortListener) {
                    try {
                        abortListener[Symbol.dispose]();
                    } catch {
                        /* best effort */
                    }

                    abortListener = undefined;
                }

                try {
                    stopAttempt();
                } finally {
                    if (retained) {
                        wipe(retained.tickets.d2);
                        wipe(retained.tickets.d2Key);
                        wipe(retained.tickets.a1);
                        wipe(retained.tickets.a2);
                        delete retained.uidProjection;
                        retained = undefined;
                    }

                    wipeAll();
                }
            }
        }
    };

    const fail = (): void => {
        epoch++;

        if (terminalPort) {
            cancelReferenceTerminal(terminalPort);
        }

        try {
            revoke();
        } finally {
            if (state !== 'closed') {
                state = 'failed';
            }

            try {
                poison();
            } finally {
                cleanup();
            }
        }
    };

    try {
        const input = record(
            options,
            restored
                ? [
                      'persisted',
                      'profile',
                      'registration',
                      'timeoutMs',
                      'restoreTimeoutMs',
                      'signal',
                      'buildRegisterReserved',
                      'verifyRegisterRaw',
                      'checkpoint',
                      'renewalCheckpoint',
                  ]
                : [
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
                      'checkpoint',
                  ],
        );
        const p = record(
            input.profile,
            restored
                ? ['subAppId', 'version']
                : [
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
                  ],
        );

        if (restored) {
            imported = cloneWtPersistedSession(input.persisted);
            p.uin = imported.uin;
            p.guid = imported.guid;
            p.ssoVersion = p.version;

            if (!text(imported.uid, true)) {
                throw new TypeError('invalid restored UID');
            }
        }

        const checkpointOption = (value: unknown): WtSessionCheckpoint | undefined => {
            if (value === undefined) {
                return undefined;
            }

            const cp = record(value, ['timeoutMs', 'save', 'invalidate']);

            if (
                !Number.isSafeInteger(cp.timeoutMs) ||
                (cp.timeoutMs as number) < 1 ||
                (cp.timeoutMs as number) > 0x7fffffff ||
                typeof cp.save !== 'function' ||
                isProxy(cp.save) ||
                (cp.invalidate !== undefined &&
                    (typeof cp.invalidate !== 'function' || isProxy(cp.invalidate)))
            ) {
                throw new TypeError('invalid checkpoint configuration');
            }

            return Object.freeze({
                timeoutMs: cp.timeoutMs as number,
                save: cp.save as WtSessionCheckpoint['save'],
                ...(cp.invalidate === undefined
                    ? {}
                    : { invalidate: cp.invalidate as WtSessionCheckpoint['invalidate'] }),
            });
        };

        const checkpoint = checkpointOption(input.checkpoint);
        const renewalCheckpoint = restored
            ? (checkpointOption(input.renewalCheckpoint) ?? checkpoint)
            : checkpoint;
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
        const unknown21 = restored ? undefined : take(p.unknown21, 21);
        const randomKey = restored ? undefined : take(p.randomKey, 16);
        const peerPublicKey = restored ? undefined : take(p.peerPublicKey, 0xffff);
        const registration = {
            version: reg.version,
            deviceName: reg.deviceName,
            deviceType: reg.deviceType,
            vendorOs: reg.vendorOs,
            random: reg.random,
        };
        const timeout = input.timeoutMs;
        const lifetime = restored ? input.restoreTimeoutMs : input.attemptTimeoutMs;

        if (
            !text(registration.version, true) ||
            !text(registration.deviceName, false) ||
            !text(registration.deviceType, false) ||
            !text(registration.vendorOs, false) ||
            !Number.isInteger(registration.random) ||
            (registration.random as number) < 0 ||
            (registration.random as number) >= 0x7fffffff ||
            !text(p.ssoVersion, true, 0xfffd) ||
            (restored &&
                (!Number.isInteger(p.subAppId) ||
                    (p.subAppId as number) < 0 ||
                    (p.subAppId as number) > 0x7fffffff)) ||
            !guid.length ||
            ((checkpoint !== undefined || renewalCheckpoint !== undefined) && guid.length !== 16) ||
            !Number.isInteger(timeout) ||
            (timeout as number) < 1 ||
            (timeout as number) > 0x7fffffff ||
            !Number.isInteger(lifetime) ||
            (lifetime as number) < 1 ||
            (lifetime as number) > 0x7fffffff ||
            (!restored &&
                [
                    input.getTimestamp,
                    input.buildWtReserved,
                    input.verifyRaw,
                    input.verifyContext,
                    input.sliceBusiness,
                ].some((callback) => typeof callback !== 'function' || isProxy(callback))) ||
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

        let deadline: number;

        if (capability) {
            const startingEpoch = epoch;

            const checkBeforeAttempt = (): void => {
                if (
                    epoch !== startingEpoch ||
                    state !== 'new' ||
                    (signal && aborted.call(signal))
                ) {
                    throw new Error('session stopped during construction');
                }

                assertReferenceKeyReservation(capability, reservation!);

                if (epoch !== startingEpoch || state !== 'new') {
                    throw new Error('session stopped during construction');
                }
            };

            checkBeforeAttempt();
            deadline = performance.now() + (lifetime as number);
            checkBeforeAttempt();
        } else {
            deadline = performance.now() + (lifetime as number);
        }

        const active = (): void => {
            if (
                state === 'failed' ||
                state === 'closed' ||
                sessionController.signal.aborted ||
                (state !== 'success' &&
                    (controller.signal.aborted || performance.now() >= deadline)) ||
                (signal && aborted.call(signal))
            ) {
                throw new Error('session stopped');
            }
        };

        const enter = (expected: WtReferenceSessionState | WtRestoredSessionState): void => {
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

        const profile = { subAppId: p.subAppId as number, ssoVersion: p.ssoVersion as string };

        if (restored) {
            if (!capability || !imported) {
                throw new Error('missing restored capability');
            }

            sendAttempt = bindReferenceRestoredOwnerLease(
                capability,
                reservation!,
                lease,
                imported.uin,
            );
        } else {
            const attemptProfile = {
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
                profile: attemptProfile,
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

            if (capability) {
                bindReferenceKeyCapability(attempt, capability, reservation!);
                sendAttempt = attempt;
            }
        }

        if (terminal && capability && attempt) {
            terminalPort = createReferenceTerminalPort(
                lease,
                terminal,
                (operation) => {
                    try {
                        active();
                        return (
                            busy && state === (operation === 'poll' ? 'qr-ready' : 'login-register')
                        );
                    } catch {
                        return false;
                    }
                },
                fence,
            );
            bindReferenceTerminalPort(attempt, terminalPort);
        }

        wipe(unknown21);
        wipe(randomKey);
        wipe(peerPublicKey);

        if (signal) {
            abortListener = addAbortListener(signal, fail);
        }

        let checkConstruction: (() => void) | undefined;

        if (capability) {
            const previousEpoch = epoch;
            const originalAttempt = sendAttempt;

            checkConstruction = (): void => {
                const same = (): boolean =>
                    epoch === previousEpoch &&
                    state === 'new' &&
                    !!originalAttempt &&
                    (restored ? attempt === undefined : attempt === originalAttempt) &&
                    sendAttempt === originalAttempt &&
                    referenceKeyState(capability) === 'empty';

                if (
                    !same() ||
                    aborted.call(sessionController.signal) ||
                    (signal && aborted.call(signal)) ||
                    !same()
                ) {
                    throw new Error('session stopped during construction');
                }
            };

            checkConstruction();
            const delay = Math.max(1, Math.ceil(deadline - performance.now()));
            checkConstruction();
            const gate = { run: fail as (() => void) | undefined };
            timerGate = gate;

            try {
                timer = setTimeout(createTimerDispatch(gate), delay);
                checkConstruction();
            } catch (error) {
                // Even a foreign timer function that retains its callback and
                // throws before returning a handle loses the owner reference.
                gate.run = undefined;
                throw error;
            }
        } else {
            timer = setTimeout(fail, Math.max(1, Math.ceil(deadline - performance.now())));
        }

        const closed = lease.whenClosed;
        checkConstruction?.();

        if (
            capability &&
            (!isPromise(closed) ||
                isProxy(closed) ||
                Object.getPrototypeOf(closed) !== Promise.prototype ||
                Object.hasOwn(closed, 'constructor'))
        ) {
            throw new TypeError('invalid lease closure promise');
        }

        const observed = isPromise(closed) ? closed : Promise.resolve(closed);
        void then.call(
            observed,
            () => {
                if (terminalPort && hasReferenceTerminal(terminalPort, attempt)) {
                    revoke();
                    wipeAll();
                } else if (state !== 'closed') {
                    fail();
                }
            },
            () => {
                if (terminalPort && hasReferenceTerminal(terminalPort, attempt)) {
                    revoke();
                    wipeAll();
                } else if (state !== 'closed') {
                    fail();
                }
            },
        );
        checkConstruction?.();
        const constructionEpoch = epoch;
        active();

        if (
            capability &&
            (epoch !== constructionEpoch ||
                state !== 'new' ||
                (restored ? !sendAttempt || attempt !== undefined : attempt !== sendAttempt))
        ) {
            throw new Error('session stopped during construction');
        }

        const finishBusiness = (
            operation: 'poll' | 'login-register',
            result: { status: string },
        ): void => {
            const currentAttempt = attempt;

            if (!terminalPort || !currentAttempt || !capability) {
                throw new Error('missing terminal binding');
            }

            const receipt = takeReferenceTerminal(terminalPort, currentAttempt, operation, result);

            if (!receipt) {
                throw new Error('missing terminal receipt');
            }

            const previousEpoch = epoch;
            const valid = (
                expectedEpoch: number,
                expectedState: WtReferenceSessionState,
            ): boolean =>
                epoch === expectedEpoch &&
                state === expectedState &&
                (!signal || !aborted.call(signal)) &&
                performance.now() < deadline &&
                performance.now() < receipt.attemptDeadline &&
                performance.now() < receipt.transactionDeadline &&
                (!signal || !aborted.call(signal)) &&
                epoch === expectedEpoch &&
                state === expectedState;

            if (
                !valid(previousEpoch, operation === 'poll' ? 'qr-ready' : 'login-register') ||
                !receipt.afterClaim() ||
                !valid(previousEpoch, operation === 'poll' ? 'qr-ready' : 'login-register')
            ) {
                throw new Error('terminal stopped');
            }

            fail();

            if (
                !valid(previousEpoch + 1, 'failed') ||
                !receipt.afterClaim() ||
                !valid(previousEpoch + 1, 'failed')
            ) {
                throw new Error('terminal stopped');
            }

            const resultDeadline = Math.min(
                deadline,
                receipt.attemptDeadline,
                receipt.transactionDeadline,
            );
            stageReferenceBusinessFailure(
                capability,
                operation,
                result.status,
                result,
                resultDeadline,
            );

            if (!valid(previousEpoch + 1, 'failed')) {
                discardReferenceBusinessFailure(capability, true);
                throw new Error('terminal stopped');
            }
        };

        const signer = input.buildRegisterReserved as RegisterOptions['buildReserved'];
        const verifier = input.verifyRegisterRaw as RegisterOptions['verifyRaw'];
        let owner!: WtReferenceSession | WtRestoredSession;

        const saveCheckpoint = async (): Promise<void> => {
            if (!checkpoint) {
                return;
            }

            const login = retained;
            const startEpoch = epoch;
            const origin = sendAttempt;

            if (!login || login.uidProjection?.status !== 'present') {
                throw new Error('missing checkpoint credentials');
            }

            // Evaluate the observable clock before allocating independent credential bytes.
            const checkpointController = new AbortController();
            const checkpointDeadline = Math.min(deadline, performance.now() + checkpoint.timeoutMs);
            const snapshot = cloneWtPersistedSession({
                version: 1,
                uin: login.uin,
                uid: login.uidProjection.uid,
                guid,
                tickets: login.tickets,
            });
            let running = true;
            let rejectStopped!: (error: Error) => void;
            const stopped = new Promise<never>((_, reject) => {
                rejectStopped = reject;
            });
            void stopped.catch(() => {});
            let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
            let listener: ReturnType<typeof addAbortListener> | undefined;
            const same = (): boolean =>
                running &&
                epoch === startEpoch &&
                state === 'success' &&
                busy &&
                retained === login &&
                sendAttempt === origin &&
                !aborted.call(sessionController.signal) &&
                (!signal || !aborted.call(signal)) &&
                (!capability || referenceKeyState(capability) === 'active');

            const isCurrent = (): boolean => {
                try {
                    return same() && performance.now() < checkpointDeadline && same();
                } catch {
                    return false;
                }
            };

            const cancel = (): void => {
                if (!running) {
                    return;
                }

                running = false;
                disposeWtPersistedSession(snapshot);
                rejectStopped(new Error('checkpoint stopped'));
                checkpointController.abort();
            };

            const run = { cancel };
            checkpointRun = run;

            try {
                listener = addAbortListener(sessionController.signal, cancel);
                checkpointTimer = setTimeout(
                    cancel,
                    Math.max(1, Math.ceil(checkpointDeadline - performance.now())),
                );

                if (!isCurrent()) {
                    throw new Error('checkpoint stopped');
                }

                const result: unknown = checkpoint.save(
                    snapshot,
                    Object.freeze({
                        signal: checkpointController.signal,
                        isCurrent,
                    }),
                );
                let pending: Promise<unknown> = Promise.resolve();

                if (result !== undefined) {
                    if (
                        !isPromise(result) ||
                        isProxy(result) ||
                        Object.getPrototypeOf(result) !== Promise.prototype ||
                        Object.hasOwn(result, 'constructor') ||
                        Object.hasOwn(result, 'then')
                    ) {
                        throw new Error('invalid checkpoint completion');
                    }

                    pending = new Promise((resolve, reject) => {
                        then.call(result, resolve, reject);
                    });
                }

                await Promise.race([pending, stopped]);

                if (!isCurrent()) {
                    throw new Error('checkpoint stopped');
                }
            } finally {
                running = false;

                if (checkpointRun === run) {
                    checkpointRun = undefined;
                }

                // Erase before disposal callbacks/clocks can reenter or throw.
                disposeWtPersistedSession(snapshot);

                try {
                    if (checkpointTimer !== undefined) {
                        clearTimeout(checkpointTimer);
                    }
                } finally {
                    try {
                        listener?.[Symbol.dispose]();
                    } finally {
                        checkpointController.abort();
                    }
                }
            }
        };

        const runRenewalCheckpoint = async (
            checkpointOwner: WtSessionCheckpoint,
            operation: 'save' | 'invalidate',
            snapshot: WtPersistedSessionV1 | undefined,
            ticketMetadata: WtSessionCheckpointContext['ticketMetadata'],
            login: Extract<WtReferenceLoginResult, { status: 'tickets' }>,
            origin: object,
            refreshRun: object,
            startEpoch: number,
            operationDeadline: number,
            operationSignal: AbortSignal,
        ): Promise<void> => {
            const callback =
                operation === 'save' ? checkpointOwner.save : checkpointOwner.invalidate;

            if (!callback) {
                throw new Error('missing checkpoint invalidation');
            }

            const checkpointController = new AbortController();
            const checkpointDeadline = Math.min(
                operationDeadline,
                performance.now() + checkpointOwner.timeoutMs,
            );
            let running = true;
            let rejectStopped!: (error: Error) => void;
            const stopped = new Promise<never>((_, reject) => {
                rejectStopped = reject;
            });
            void stopped.catch(() => {});
            let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
            let listener: ReturnType<typeof addAbortListener> | undefined;

            const same = (): boolean => {
                if (
                    !running ||
                    epoch !== startEpoch ||
                    state !== 'success' ||
                    !busy ||
                    retained !== login ||
                    sendAttempt !== origin ||
                    aborted.call(sessionController.signal) ||
                    aborted.call(operationSignal) ||
                    (signal && aborted.call(signal))
                ) {
                    return false;
                }

                if (capability) {
                    try {
                        assertReferenceTicketRefresh(capability, owner, lease, origin, refreshRun);
                    } catch {
                        return false;
                    }
                }

                return true;
            };

            const isCurrent = (): boolean => {
                try {
                    return same() && performance.now() < checkpointDeadline && same();
                } catch {
                    return false;
                }
            };

            const cancel = (): void => {
                if (!running) {
                    return;
                }

                running = false;

                if (snapshot) {
                    disposeWtPersistedSession(snapshot);
                }

                rejectStopped(new Error('checkpoint stopped'));
                checkpointController.abort();
            };

            const run = { cancel };

            if (checkpointRun) {
                throw new Error('checkpoint already active');
            }

            checkpointRun = run;

            try {
                listener = addAbortListener(operationSignal, cancel);
                checkpointTimer = setTimeout(
                    cancel,
                    Math.max(1, Math.ceil(checkpointDeadline - performance.now())),
                );

                if (!isCurrent()) {
                    throw new Error('checkpoint stopped');
                }

                const metadata = ticketMetadata
                    ? Object.freeze({
                          nextRefreshAtSeconds: ticketMetadata.nextRefreshAtSeconds,
                          expiresAtSeconds: ticketMetadata.expiresAtSeconds,
                      })
                    : undefined;
                const context: WtSessionCheckpointContext = Object.freeze({
                    signal: checkpointController.signal,
                    ...(metadata ? { ticketMetadata: metadata } : {}),
                    isCurrent,
                });
                const result: unknown =
                    operation === 'save'
                        ? checkpointOwner.save(snapshot!, context)
                        : checkpointOwner.invalidate!(context);
                let pending: Promise<unknown> = Promise.resolve();

                if (result !== undefined) {
                    if (
                        !isPromise(result) ||
                        isProxy(result) ||
                        Object.getPrototypeOf(result) !== Promise.prototype ||
                        Object.hasOwn(result, 'constructor') ||
                        Object.hasOwn(result, 'then')
                    ) {
                        throw new Error('invalid checkpoint completion');
                    }

                    pending = new Promise((resolve, reject) => {
                        then.call(result, resolve, reject);
                    });
                }

                await Promise.race([pending, stopped]);

                if (!isCurrent()) {
                    throw new Error('checkpoint stopped');
                }
            } finally {
                running = false;

                if (checkpointRun === run) {
                    checkpointRun = undefined;
                }

                if (snapshot) {
                    disposeWtPersistedSession(snapshot);
                }

                try {
                    if (checkpointTimer !== undefined) {
                        clearTimeout(checkpointTimer);
                    }
                } finally {
                    try {
                        listener?.[Symbol.dispose]();
                    } finally {
                        checkpointController.abort();
                    }
                }
            }
        };

        const registerLogin = async (
            login: Extract<WtReferenceLoginResult, { status: 'tickets' }>,
            operation: 'login-register' | 'restore-register',
        ): Promise<{ status: SsoRegisterOutcome }> => {
            if (login.uidProjection?.status !== 'present' || !text(login.uidProjection.uid, true)) {
                throw new Error('missing UID');
            }

            const result = await referenceRegisterOnTransport(lease, {
                login,
                profile: { guid, subAppId: profile.subAppId, version: profile.ssoVersion },
                registration: {
                    ...registration,
                    uid: login.uidProjection.uid,
                } as RegisterOptions['registration'],
                timeoutMs: timeout as number,
                signal: controller.signal,
                buildReserved: signer,
                verifyRaw: verifier,
            });

            if (result.kind !== 'response') {
                throw new Error(
                    `registration transport failed (${result.code}, ${result.writeState})`,
                );
            }

            active();

            if (result.value !== 'success') {
                if (capability) {
                    stageReferenceBusinessFailure(capability, operation, result.value);
                }

                fail();
                return { status: result.value };
            }

            retained = login;
            checkpointPending = checkpoint !== undefined;
            state = 'success';
            stopAttempt();

            if (
                state !== 'success' ||
                (signal && aborted.call(signal)) ||
                performance.now() >= deadline
            ) {
                throw new Error('session stopped');
            }

            if (capability) {
                commitReferenceKey(capability);
            }

            if (checkpoint) {
                const checkpointEpoch = epoch;
                await saveCheckpoint();
                active();

                if (
                    epoch !== checkpointEpoch ||
                    state !== 'success' ||
                    retained !== login ||
                    (capability && referenceKeyState(capability) !== 'active')
                ) {
                    throw new Error('session stopped');
                }
            }

            checkpointPending = false;
            return { status: 'success' };
        };

        const qrMethods = {
            async fetch(fields: FetchFields) {
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
                        if (terminalPort) {
                            finishBusiness('poll', result);
                        } else {
                            if (capability) {
                                stageReferenceBusinessFailure(capability, 'poll', result.status);
                            }

                            fail();
                        }
                    }

                    return result;
                } catch {
                    fail();
                    throw new Error('session poll failed');
                } finally {
                    busy = false;
                }
            },
            async loginAndRegister(fields: LoginFields): Promise<WtReferenceSessionResult> {
                enter('confirmed');
                state = 'login-register';
                let login: WtReferenceLoginResult | undefined;

                try {
                    login = await attempt!.login(fields);
                    active();

                    if (login.status !== 'tickets') {
                        if (terminalPort) {
                            finishBusiness('login-register', login);
                        } else {
                            if (capability) {
                                stageReferenceBusinessFailure(
                                    capability,
                                    'login-register',
                                    login.status,
                                );
                            }

                            fail();
                        }

                        return login;
                    }

                    if (
                        login.uidProjection?.status !== 'present' ||
                        !text(login.uidProjection.uid, true)
                    ) {
                        throw new Error('missing UID');
                    }

                    return await registerLogin(login, 'login-register');
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
        };
        const commonMethods = {
            async refreshTickets(
                supplied?: WtRefreshTicketsOptions,
            ): Promise<WtRefreshTicketsResult> {
                const refreshInput =
                    supplied === undefined
                        ? Object.create(null)
                        : record(supplied, ['signal', 'timeoutMs']);
                const refreshTimeout = refreshInput.timeoutMs ?? timeout;
                const refreshSignal = refreshInput.signal;

                if (
                    !Number.isSafeInteger(refreshTimeout) ||
                    (refreshTimeout as number) < 1 ||
                    (refreshTimeout as number) > 0x7fffffff
                ) {
                    throw new TypeError('invalid ticket refresh timeout');
                }

                if (
                    refreshSignal !== undefined &&
                    (isProxy(refreshSignal) ||
                        typeof refreshSignal !== 'object' ||
                        refreshSignal === null ||
                        Object.getPrototypeOf(refreshSignal) !== AbortSignal.prototype ||
                        Object.hasOwn(refreshSignal, 'aborted') ||
                        Object.hasOwn(refreshSignal, 'addEventListener') ||
                        Object.hasOwn(refreshSignal, 'removeEventListener'))
                ) {
                    throw new TypeError('invalid ticket refresh signal');
                }

                if (refreshSignal !== undefined && aborted.call(refreshSignal as AbortSignal)) {
                    throw new Error('ticket refresh stopped');
                }

                enter('success');
                const operationController = new AbortController();
                const stopOperation = (): void => operationController.abort();
                let sessionListener: ReturnType<typeof addAbortListener> | undefined;
                let refreshListener: ReturnType<typeof addAbortListener> | undefined;
                let persistedInput: WtPersistedSessionV1 | undefined;
                let nativeResult: NativeTicketRefreshResult | undefined;
                let replacement: WtPersistedSessionV1 | undefined;
                let checkpointSnapshot: WtPersistedSessionV1 | undefined;
                let replacementTransferred = false;
                let refreshBound = false;
                let failureCode: WtTicketRefreshErrorCode = 'not-sent';
                let failureWriteState: WtTicketRefreshError['writeState'] = 'not-written';
                const refreshRun = {};
                const startEpoch = epoch;
                const login = retained;
                const origin = sendAttempt;
                const operationDeadline = performance.now() + (refreshTimeout as number);

                const check = (): void => {
                    const identity = (): void => {
                        if (
                            epoch !== startEpoch ||
                            state !== 'success' ||
                            !busy ||
                            retained !== login ||
                            sendAttempt !== origin ||
                            !origin ||
                            login?.uidProjection?.status !== 'present' ||
                            aborted.call(operationController.signal) ||
                            performance.now() >= operationDeadline
                        ) {
                            throw new Error('ticket refresh stopped');
                        }

                        if (capability) {
                            assertReferenceTicketRefresh(
                                capability,
                                owner,
                                lease,
                                origin,
                                refreshRun,
                            );
                        }
                    };

                    identity();
                    active();
                    identity();
                };

                const remaining = (): number => {
                    check();
                    return Math.max(1, Math.ceil(operationDeadline - performance.now()));
                };

                try {
                    if (!renewalCheckpoint) {
                        throw new Error('missing renewal checkpoint');
                    }

                    if (
                        !login ||
                        login.uidProjection?.status !== 'present' ||
                        !text(login.uidProjection.uid, true) ||
                        !origin
                    ) {
                        throw new Error('missing retained login');
                    }

                    if (refreshDisabledLastCode !== undefined) {
                        return Object.freeze({
                            status: 'disabled',
                            reason: 'protocol-errors',
                            consecutiveProtocolErrors,
                            lastCode: refreshDisabledLastCode,
                        });
                    }

                    sessionListener = addAbortListener(sessionController.signal, stopOperation);

                    if (refreshSignal !== undefined) {
                        refreshListener = addAbortListener(
                            refreshSignal as AbortSignal,
                            stopOperation,
                        );
                    }

                    if (
                        aborted.call(sessionController.signal) ||
                        (refreshSignal !== undefined && aborted.call(refreshSignal as AbortSignal))
                    ) {
                        stopOperation();
                    }

                    if (capability) {
                        beginReferenceTicketRefresh(capability, owner, lease, origin, refreshRun);
                        refreshBound = true;
                    }

                    check();
                    checkpointSnapshot = cloneWtPersistedSession({
                        version: 1,
                        uin: login.uin,
                        uid: login.uidProjection.uid,
                        guid,
                        tickets: login.tickets,
                    });
                    failureCode = 'checkpoint-failed';
                    failureWriteState = 'not-written';
                    await runRenewalCheckpoint(
                        renewalCheckpoint,
                        'save',
                        checkpointSnapshot,
                        RENEWAL_WAL_METADATA,
                        login,
                        origin,
                        refreshRun,
                        startEpoch,
                        operationDeadline,
                        operationController.signal,
                    );
                    checkpointSnapshot = undefined;
                    failureCode = 'write-unknown';
                    failureWriteState = 'unknown';
                    check();
                    persistedInput = cloneWtPersistedSession({
                        version: 1,
                        uin: login.uin,
                        uid: login.uidProjection.uid,
                        guid,
                        tickets: login.tickets,
                    });
                    const unixMilliseconds = Date.now();

                    if (!Number.isSafeInteger(unixMilliseconds) || unixMilliseconds < 0) {
                        throw new Error('invalid local time');
                    }

                    const serverNowSeconds = BigInt(Math.floor(unixMilliseconds / 1000));
                    nativeResult = await refreshNativeTicketsOnTransport(
                        lease,
                        {
                            persisted: persistedInput,
                            profile: {
                                subAppId: profile.subAppId,
                                version: profile.ssoVersion,
                            },
                            deviceName: registration.deviceName as string,
                            serverNowSeconds,
                            timeoutMs: remaining(),
                            signal: operationController.signal,
                            buildReserved: signer,
                            verifyRaw: verifier,
                        },
                        capability ? { token: capability, attempt: origin, lease } : undefined,
                    );
                    failureCode = 'stopped';
                    failureWriteState = 'written';
                    check();

                    if (nativeResult.kind === 'empty-a1') {
                        return Object.freeze({ status: 'empty-a1' });
                    }

                    if (nativeResult.kind === 'protocol-error') {
                        if (nativeResult.needsLogin) {
                            failureCode = 'invalidation-failed';
                            await runRenewalCheckpoint(
                                renewalCheckpoint,
                                'invalidate',
                                undefined,
                                undefined,
                                login,
                                origin,
                                refreshRun,
                                startEpoch,
                                operationDeadline,
                                operationController.signal,
                            );
                            failureCode = 'stopped';
                            check();
                            const result = Object.freeze({
                                status: 'needs-login' as const,
                                code: nativeResult.code,
                            });

                            if (capability) {
                                stageReferenceBusinessFailure(
                                    capability,
                                    'refresh-tickets',
                                    result.status,
                                );
                            }

                            fail();
                            return result;
                        }

                        consecutiveProtocolErrors++;

                        if (consecutiveProtocolErrors >= 10) {
                            refreshDisabledLastCode = nativeResult.code;
                            return Object.freeze({
                                status: 'disabled',
                                reason: 'protocol-errors',
                                consecutiveProtocolErrors,
                                lastCode: nativeResult.code,
                            });
                        }

                        return Object.freeze({
                            status: 'protocol-error',
                            code: nativeResult.code,
                            consecutiveProtocolErrors,
                        });
                    }

                    replacement = cloneWtPersistedSession(nativeResult.persisted);
                    wipe(replacement.guid);
                    checkpointSnapshot = cloneWtPersistedSession(nativeResult.persisted);
                    const nextLogin: Extract<WtReferenceLoginResult, { status: 'tickets' }> = {
                        status: 'tickets',
                        uin: login.uin,
                        uidProjection: {
                            status: 'present',
                            uid: login.uidProjection.uid,
                        },
                        tickets: replacement.tickets,
                    };
                    const success = Object.freeze({
                        status: 'refreshed' as const,
                        nextRefreshAtSeconds: nativeResult.metadata.nextRefreshAtSeconds,
                        expiresAtSeconds: nativeResult.metadata.expiresAtSeconds,
                    });

                    if (capability) {
                        stageReferenceTicketRefreshCandidate(
                            capability,
                            owner,
                            lease,
                            origin,
                            refreshRun,
                            login.tickets.d2Key,
                            replacement.tickets.d2Key,
                        );
                    }

                    failureCode = 'checkpoint-failed';
                    await runRenewalCheckpoint(
                        renewalCheckpoint,
                        'save',
                        checkpointSnapshot,
                        nativeResult.metadata,
                        login,
                        origin,
                        refreshRun,
                        startEpoch,
                        operationDeadline,
                        operationController.signal,
                    );
                    checkpointSnapshot = undefined;
                    failureCode = 'activation-failed';
                    check();

                    if (capability) {
                        rotateReferenceTicketKey(
                            capability,
                            owner,
                            lease,
                            origin,
                            refreshRun,
                            login.tickets.d2Key,
                            replacement.tickets.d2Key,
                        );
                    }

                    retained = nextLogin;
                    replacementTransferred = true;
                    wipe(login.tickets.d2);
                    wipe(login.tickets.d2Key);
                    wipe(login.tickets.a1);
                    wipe(login.tickets.a2);
                    delete login.uidProjection;
                    consecutiveProtocolErrors = 0;
                    return success;
                } catch (error) {
                    if (error instanceof NativeTicketRefreshError) {
                        failureWriteState = error.writeState;
                        failureCode =
                            error.code === 'operation-stopped'
                                ? 'stopped'
                                : error.code === 'invalid-response' || error.code === 'sso-error'
                                  ? 'invalid-response'
                                  : error.writeState === 'not-written'
                                    ? 'not-sent'
                                    : 'write-unknown';
                    } else if (error instanceof WtTicketRefreshError) {
                        failureCode = error.code;
                        failureWriteState = error.writeState;
                    }

                    fail();
                    throw new WtTicketRefreshError(failureCode, failureWriteState);
                } finally {
                    if (persistedInput) {
                        disposeWtPersistedSession(persistedInput);
                    }

                    if (checkpointSnapshot) {
                        disposeWtPersistedSession(checkpointSnapshot);
                    }

                    disposeNativeTicketRefreshResult(nativeResult);

                    if (replacement && !replacementTransferred) {
                        disposeWtPersistedSession(replacement);
                    }

                    try {
                        if (refreshBound && capability && origin) {
                            endReferenceTicketRefresh(capability, owner, lease, origin, refreshRun);
                        }
                    } catch {
                        fail();
                        // eslint-disable-next-line no-unsafe-finally -- A lost refresh binding invalidates any pending result.
                        throw new WtTicketRefreshError(failureCode, failureWriteState);
                    } finally {
                        try {
                            sessionListener?.[Symbol.dispose]();
                        } finally {
                            try {
                                refreshListener?.[Symbol.dispose]();
                            } finally {
                                stopOperation();
                                busy = false;
                            }
                        }
                    }
                }
            },
            async heartbeat(): Promise<SsoHeartbeatOutcome> {
                enter('success');

                try {
                    const login = retained;

                    if (
                        login?.uidProjection?.status !== 'present' ||
                        !text(login.uidProjection.uid, true)
                    ) {
                        throw new Error('missing retained login');
                    }

                    const uid = login.uidProjection.uid;
                    const result = await referenceHeartbeatOnTransport(lease, {
                        login,
                        profile: { guid, subAppId: profile.subAppId, version: profile.ssoVersion },
                        uid,
                        timeoutMs: timeout as number,
                        signal: sessionController.signal,
                        buildReserved: signer,
                        verifyRaw: verifier,
                    });
                    active();

                    if (
                        state !== 'success' ||
                        retained !== login ||
                        login.uidProjection?.status !== 'present' ||
                        login.uidProjection.uid !== uid
                    ) {
                        throw new Error('session stopped');
                    }

                    if (result.kind !== 'response') {
                        throw new Error('heartbeat transport failed');
                    }

                    if (result.value.status === 'sso-error') {
                        if (capability) {
                            stageReferenceBusinessFailure(
                                capability,
                                'heartbeat',
                                result.value.status,
                            );
                        }

                        fail();
                        return result.value;
                    }

                    if (
                        result.value.status !== 'success' &&
                        result.value.status !== 'missing-interval'
                    ) {
                        throw new Error('invalid heartbeat outcome');
                    }

                    return result.value;
                } catch {
                    fail();
                    throw new Error('session heartbeat failed');
                } finally {
                    busy = false;
                }
            },
            async alive() {
                enter('success');

                try {
                    const login = retained;

                    if (
                        login?.uidProjection?.status !== 'present' ||
                        !text(login.uidProjection.uid, true) ||
                        !text(login.uin, true)
                    ) {
                        throw new Error('missing retained login');
                    }

                    const uin = login.uin;
                    const uid = login.uidProjection.uid;
                    const result = await referenceAliveOnTransport(lease, {
                        uin,
                        uid,
                        timeoutMs: timeout as number,
                        signal: sessionController.signal,
                        buildReserved: signer,
                        verifyRaw: verifier,
                    });
                    active();

                    if (
                        state !== 'success' ||
                        retained !== login ||
                        login.uin !== uin ||
                        login.uidProjection?.status !== 'present' ||
                        login.uidProjection.uid !== uid
                    ) {
                        throw new Error('session stopped');
                    }

                    if (result.kind !== 'response') {
                        throw new Error('alive transport failed');
                    }

                    if (result.value.status === 'sso-error') {
                        if (capability) {
                            stageReferenceBusinessFailure(capability, 'alive', result.value.status);
                        }

                        fail();
                        return result.value;
                    }

                    if (result.value.status !== 'success') {
                        throw new Error('invalid alive outcome');
                    }

                    return result.value;
                } catch {
                    fail();
                    throw new Error('session alive failed');
                } finally {
                    busy = false;
                }
            },
            close() {
                epoch++;

                if (terminalPort) {
                    cancelReferenceTerminal(terminalPort);
                }

                if (capability) {
                    discardReferenceBusinessFailure(capability, true);
                }

                if (state === 'closed') {
                    return;
                }

                const mustPoison = busy || (state !== 'new' && state !== 'success');

                try {
                    revoke();
                } finally {
                    state = 'closed';

                    try {
                        if (mustPoison) {
                            poison();
                        }
                    } finally {
                        cleanup();
                    }
                }
            },
        };

        // Keep the owners as distinct runtime shapes. A conditional receiver literal also
        // confuses the real Proton wrapper-specialization analysis in QR consumers.
        if (restored) {
            owner = {
                ...commonMethods,
                getState: () =>
                    state === 'success' && checkpointPending
                        ? 'restore-register'
                        : (state as WtRestoredSessionState),
                async restoreAndRegister(): Promise<{ status: SsoRegisterOutcome }> {
                    enter('new');
                    state = 'restore-register';
                    let login: Extract<WtReferenceLoginResult, { status: 'tickets' }> | undefined;

                    try {
                        if (!imported || !capability || !sendAttempt) {
                            throw new Error('missing restored origin');
                        }

                        login = {
                            status: 'tickets',
                            uin: imported.uin,
                            uidProjection: { status: 'present', uid: imported.uid },
                            tickets: imported.tickets,
                        };
                        wipe(imported.guid);
                        imported = undefined;
                        active();
                        stageReferenceRestoredKey(
                            capability,
                            sendAttempt,
                            lease,
                            owner,
                            login.tickets.d2Key,
                        );
                        active();
                        return await registerLogin(login, 'restore-register');
                    } catch (error) {
                        fail();
                        throw new Error('session restore or registration failed', { cause: error });
                    } finally {
                        if (login && retained !== login) {
                            wipe(login.tickets.d2);
                            wipe(login.tickets.d2Key);
                            wipe(login.tickets.a1);
                            wipe(login.tickets.a2);
                            delete login.uidProjection;
                        }

                        busy = false;
                    }
                },
            };
        } else {
            owner = {
                ...commonMethods,
                ...qrMethods,
                getState: () =>
                    state === 'success' && checkpointPending
                        ? 'login-register'
                        : (state as WtReferenceSessionState),
            };
        }

        if (capability) {
            const originalAttempt = sendAttempt!;
            let sendRun: object | undefined;

            const send: ReferenceSessionSendImplementation = async (
                supplied: ReferenceSessionSendInput | undefined,
            ) => {
                // Gate before touching inputs, clocks, signals or transport accessors.
                if (state !== 'success') {
                    throw new Error('session not registered');
                }

                if (busy) {
                    throw new Error('session single-flight violation');
                }

                busy = true;
                const run = {};
                sendRun = run;
                const startEpoch = epoch;
                const login = retained;
                let uid: string | undefined;
                let borrowed = false;

                const check = (): void => {
                    const identity = (): void => {
                        if (
                            epoch !== startEpoch ||
                            state !== 'success' ||
                            !busy ||
                            sendRun !== run ||
                            retained !== login ||
                            sendAttempt !== originalAttempt ||
                            login?.uidProjection?.status !== 'present' ||
                            login.uidProjection.uid !== uid ||
                            !text(uid, true)
                        ) {
                            throw new Error('session stopped');
                        }

                        assertReferenceSessionSendActive(capability, owner, lease, originalAttempt);
                    };

                    try {
                        identity();
                        active();
                        identity();
                    } catch {
                        fail();
                        throw new Error('session stopped');
                    }
                };

                try {
                    const input = record(supplied, ['request', 'maxResponseBodyBytes']);
                    supplied = undefined;
                    const request = record(input.request, [
                        'route',
                        'text',
                        'clientSequence',
                        'random',
                    ]);
                    input.request = undefined;
                    const route = record(request.route, ['kind', 'peerUin', 'peerUid', 'groupUin']);
                    request.route = route;
                    const maxResponseBodyBytes = input.maxResponseBodyBytes;

                    // Drop all foreign object references before the first await. The
                    // real codec below still validates UTF-16 and encoded byte limits.
                    if (
                        Object.keys(input).length !== 2 ||
                        Object.keys(request).length !== 4 ||
                        typeof request.text !== 'string' ||
                        request.text.length > 65536 ||
                        typeof request.clientSequence !== 'bigint' ||
                        request.clientSequence < 0n ||
                        request.clientSequence > 0xffffffffffffffffn ||
                        typeof request.random !== 'number' ||
                        !Number.isInteger(request.random) ||
                        request.random < 0 ||
                        request.random > 0xffffffff ||
                        (route.kind === 'private'
                            ? Object.keys(route).length !== 3 ||
                              typeof route.peerUin !== 'bigint' ||
                              route.peerUin < 1n ||
                              route.peerUin > 0x7fffffffffffffffn ||
                              typeof route.peerUid !== 'string' ||
                              route.peerUid.length > 1024
                            : route.kind === 'group'
                              ? Object.keys(route).length !== 2 ||
                                typeof route.groupUin !== 'bigint' ||
                                route.groupUin < 1n ||
                                route.groupUin > 0x7fffffffffffffffn
                              : true)
                    ) {
                        throw new TypeError('invalid send-text request');
                    }

                    if (
                        typeof maxResponseBodyBytes !== 'number' ||
                        !Number.isSafeInteger(maxResponseBodyBytes) ||
                        maxResponseBodyBytes < 0 ||
                        maxResponseBodyBytes > 65536
                    ) {
                        throw new TypeError('invalid response body limit');
                    }

                    const stableRequest =
                        request as unknown as ReferenceSessionSendInput['request'];
                    // Complete codec validation before the first suspension, so an
                    // invalid request cannot leave the owner busy across a turn.
                    const encoded = encodeDirectSendMessageRequest(stableRequest);
                    let size: number;

                    try {
                        size = length.call(encoded) as number;
                    } finally {
                        wipe(encoded);
                    }

                    if (size > 65536) {
                        throw new RangeError('send-text request exceeds size limit');
                    }

                    uid =
                        login?.uidProjection?.status === 'present'
                            ? login.uidProjection.uid
                            : undefined;
                    check();
                    const sender = await import('./sso-reference-send-text-flow');
                    check();
                    const sendSignal = sessionController.signal;
                    check();
                    borrowed = true;
                    const result = await sender.referenceSendTextWithCapability(
                        { token: capability, attempt: originalAttempt, lease, run },
                        {
                            login: login!,
                            profile: {
                                guid,
                                subAppId: profile.subAppId,
                                version: profile.ssoVersion,
                            },
                            uid: uid!,
                            request: stableRequest,
                            maxResponseBodyBytes,
                            timeoutMs: timeout as number,
                            signal: sendSignal,
                            buildReserved: signer,
                            verifyRaw: verifier,
                        },
                    );
                    check();

                    if (result.kind !== 'response') {
                        throw new Error('send transport failed');
                    }

                    if (result.value.status !== 'response') {
                        throw new Error('send SSO failed');
                    }

                    return result.value;
                } catch (error) {
                    if (borrowed) {
                        fail();
                        throw new Error('session send failed');
                    }

                    throw error;
                } finally {
                    if (sendRun === run) {
                        sendRun = undefined;
                        busy = false;
                    }
                }
            };

            if (
                epoch !== constructionEpoch ||
                state !== 'new' ||
                (restored ? attempt !== undefined : attempt !== originalAttempt) ||
                sendAttempt !== originalAttempt
            ) {
                throw new Error('session stopped during construction');
            }

            const friend: ReferenceSessionFriendImplementation = async (
                prepared,
                run,
                deadline,
                progress,
            ) => {
                // Same owner gate and retained credentials as text; only the fixed workflow differs.
                if (state !== 'success') {
                    throw new Error('session not registered');
                }

                if (busy) {
                    throw new Error('session single-flight violation');
                }

                busy = true;
                sendRun = run;
                const startEpoch = epoch;
                const login = retained;
                const uid =
                    login?.uidProjection?.status === 'present'
                        ? login.uidProjection.uid
                        : undefined;
                let borrowed = false;
                let succeeded = false;

                const check = (): void => {
                    const identity = (): void => {
                        if (
                            epoch !== startEpoch ||
                            state !== 'success' ||
                            !busy ||
                            sendRun !== run ||
                            retained !== login ||
                            sendAttempt !== originalAttempt ||
                            login?.uidProjection?.status !== 'present' ||
                            login.uidProjection.uid !== uid ||
                            !text(uid, true)
                        ) {
                            throw new WtReferenceFriendError(progress, 'workflow-stopped');
                        }

                        assertReferenceSessionSendActive(capability, owner, lease, originalAttempt);
                    };

                    identity();
                    active();
                    identity();
                };

                try {
                    check();
                    beginReferenceFriendWorkflow(capability, owner, lease, originalAttempt, run);
                    borrowed = true;
                    const result = await referenceFriendWithCapability(
                        {
                            token: capability,
                            attempt: originalAttempt,
                            lease,
                            owner,
                            workflowRun: run,
                        },
                        prepared,
                        {
                            login: login!,
                            profile: {
                                guid,
                                subAppId: profile.subAppId,
                                version: profile.ssoVersion,
                            },
                            uid: uid!,
                            signal: sessionController.signal,
                            buildReserved: signer,
                            verifyRaw: verifier,
                        },
                        deadline,
                        progress,
                        check,
                    );
                    check();
                    succeeded = true;
                    return result;
                } catch (error) {
                    if (borrowed) {
                        fail();
                    }

                    throw error instanceof WtReferenceFriendError
                        ? error
                        : new WtReferenceFriendError(progress, 'workflow-stopped');
                } finally {
                    try {
                        if (borrowed) {
                            endReferenceFriendWorkflow(
                                capability,
                                owner,
                                lease,
                                originalAttempt,
                                run,
                            );
                        }

                        if (succeeded) {
                            check();
                        }
                    } catch {
                        fail();
                        // eslint-disable-next-line no-unsafe-finally -- Preserve uncertainty after a failed workflow cleanup.
                        throw new WtReferenceFriendError(progress, 'workflow-stopped');
                    } finally {
                        if (sendRun === run) {
                            sendRun = undefined;
                            busy = false;
                        }
                    }
                }
            };

            const packet: ReferenceSessionPacketImplementation = async (
                prepared,
                run,
                deadline,
                progress,
            ) => {
                if (state !== 'success') {
                    throw new Error('session not registered');
                }

                if (busy) {
                    throw new Error('session single-flight violation');
                }

                busy = true;
                sendRun = run;
                const startEpoch = epoch;
                const login = retained;
                const uid =
                    login?.uidProjection?.status === 'present'
                        ? login.uidProjection.uid
                        : undefined;
                let binding: ReferencePacketOperation | undefined;
                let response: WtReferencePacketResult | undefined;

                const check = (): void => {
                    const identity = (): void => {
                        if (
                            epoch !== startEpoch ||
                            state !== 'success' ||
                            !busy ||
                            sendRun !== run ||
                            retained !== login ||
                            sendAttempt !== originalAttempt ||
                            login?.uidProjection?.status !== 'present' ||
                            login.uidProjection.uid !== uid ||
                            !text(uid, true)
                        ) {
                            throw new WtReferencePacketError(
                                prepared.command,
                                progress,
                                'operation-stopped',
                            );
                        }

                        assertReferenceSessionSendActive(capability, owner, lease, originalAttempt);
                    };

                    identity();
                    active();
                    identity();
                };

                try {
                    check();
                    binding = beginReferencePacketOperation(
                        capability,
                        owner,
                        lease,
                        originalAttempt,
                        run,
                        prepared.command,
                    );
                    response = await referencePacketWithCapability(
                        { token: capability, attempt: originalAttempt, lease, run },
                        prepared,
                        {
                            login: login!,
                            profile: {
                                guid,
                                subAppId: profile.subAppId,
                                version: profile.ssoVersion,
                            },
                            uid: uid!,
                            signal: sessionController.signal,
                            buildReserved: signer,
                            verifyRaw: verifier,
                        },
                        deadline,
                        progress,
                        () => {
                            check();
                            assertReferencePacketOperation(
                                capability,
                                owner,
                                lease,
                                originalAttempt,
                                binding!,
                            );
                        },
                    );
                    check();
                } catch (error) {
                    disposeReferencePacketResult(response);
                    response = undefined;

                    if (binding) {
                        fail();
                    }

                    throw error instanceof WtReferencePacketError
                        ? error
                        : new WtReferencePacketError(
                              prepared.command,
                              progress,
                              'operation-stopped',
                          );
                } finally {
                    try {
                        if (binding) {
                            endReferencePacketOperation(
                                capability,
                                owner,
                                lease,
                                originalAttempt,
                                binding,
                            );
                        }

                        if (response) {
                            check();
                        }
                    } catch {
                        disposeReferencePacketResult(response);
                        fail();
                        // eslint-disable-next-line no-unsafe-finally -- Retain response ownership through owner cleanup.
                        throw new WtReferencePacketError(
                            prepared.command,
                            progress,
                            'operation-stopped',
                        );
                    } finally {
                        if (sendRun === run) {
                            sendRun = undefined;
                            busy = false;
                        }
                    }
                }

                return response!;
            };

            publishReferenceSessionSend(
                capability,
                reservation!,
                originalAttempt,
                lease,
                owner,
                send,
                friend,
                packet,
            );
        }

        return owner;
    } catch {
        fail();
        throw new Error('invalid or stopped session');
    }
}
