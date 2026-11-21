import { addAbortListener } from 'node:events';
import { isProxy, isUint8Array } from 'node:util/types';
import { createLogger } from '@snowluma/common/logger';
import { encodeDirectSendMessageRequest } from './send-message-request';
import { isWtReferencePushProtocol, isWtReferencePushCommand } from './wt-reference-push-commands';
import type { SsoSendTextOutcome } from './sso-reference-send-text-flow';
import {
    prepareReferenceFriendInput,
    disposePreparedReferenceFriendInput,
    referenceFriendStepCommand,
    WtReferenceFriendError,
    type WtReferenceFriendInput,
    type WtReferenceFriendResult,
    type PreparedReferenceFriendInput,
    type ReferenceFriendProgress,
} from './wt-reference-friend-flow';
import {
    prepareReferencePacketInput,
    disposePreparedReferencePacket,
    disposeReferencePacketResult,
    WtReferencePacketError,
    type WtReferencePacketInput,
    type WtReferencePacketResult,
    type ReferencePacketProgress,
} from './wt-reference-packet-flow';
import type {
    RawMultiplexPushRoute,
    RawMultiplexResponseContinuation,
} from './raw-multiplex-client';
import {
    createRawMultiplexStream,
    type RawMultiplexByteStream,
    type RawMultiplexStreamClient,
} from './raw-multiplex-stream';
import { createRawSessionBrokerInternal, type RawSessionLease } from './raw-session-broker';
import { SSO_HEARTBEAT_COMMAND, SSO_INFO_SYNC_COMMAND } from './sso-register';
import { SSO_REFERENCE_ALIVE_COMMAND } from './sso-reference-alive-flow';
import {
    createWtReferenceSessionWithCapability,
    createWtRestoredSessionWithCapability,
    type WtReferenceSession,
    type WtReferenceSessionOptions,
    type WtRefreshTicketsOptions,
    type WtRestoredSession,
    type WtRestoredSessionOptions,
} from './wt-reference-session';
import {
    armReferenceTicketRefreshContinuation,
    createReferenceKeyCapability,
    consumeReferenceBusinessFailure,
    decodeReferenceFrame,
    decodeReferencePushBody,
    referenceExpectedUin,
    referenceKeyState,
    revokeReferenceKey,
    takeReferenceExactBusinessFailure,
    takeReferenceSessionSend,
    type ReferenceSessionSendHandle,
    type ReferenceSessionSendInput,
    referenceActiveFriendStep,
    type ReferenceFriendStep,
    referenceActivePacketOperation,
    type ReferencePacketOperation,
} from './wt-reference-session-private';
import type { Sso12CloseReason, Sso12RawClient } from './sso12-packet-client';
import { cloneWtPersistedSession, disposeWtPersistedSession } from './wt-persisted-session';
import { NATIVE_KEY_EXCHANGE_COMMAND } from './nt-native-key-exchange';
import { NATIVE_TICKET_REFRESH_COMMAND } from './nt-native-ticket-codec';

const MAX_TIMER = 0x7fffffff;
const log = createLogger('Direct.WT');
const nativeFill = Uint8Array.prototype.fill;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
type PushMeta = Readonly<{ uin: string; sequence: number; command: string }>;
type Operation =
    | 'fetch'
    | 'poll'
    | 'login-register'
    | 'restore-register'
    | 'heartbeat'
    | 'alive'
    | 'refresh-tickets'
    | 'send-text'
    | 'friend-request'
    | 'request-packet';

/** Snapshot only own data properties before any owner, clock, or callback is touched. */
function sendRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || isProxy(value)) {
        throw new TypeError('invalid send-text input');
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    const actual = Reflect.ownKeys(value);

    if ((prototype !== Object.prototype && prototype !== null) || actual.length !== keys.length) {
        throw new TypeError('invalid send-text input');
    }

    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of actual) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (
            typeof key !== 'string' ||
            !keys.includes(key) ||
            !descriptor ||
            !('value' in descriptor)
        ) {
            throw new TypeError('invalid send-text input');
        }

        snapshot[key] = descriptor.value;
    }

    return snapshot;
}

function snapshotRefreshOptions(input: unknown): WtRefreshTicketsOptions | undefined {
    if (input === undefined) {
        return undefined;
    }

    if (!input || typeof input !== 'object' || isProxy(input)) {
        throw new TypeError('invalid ticket refresh options');
    }

    const prototype = Object.getPrototypeOf(input) as unknown;
    const keys = Reflect.ownKeys(input);
    const snapshot: { signal?: AbortSignal; timeoutMs?: number } = Object.create(null) as {
        signal?: AbortSignal;
        timeoutMs?: number;
    };

    if ((prototype !== Object.prototype && prototype !== null) || keys.length > 2) {
        throw new TypeError('invalid ticket refresh options');
    }

    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);

        if (
            typeof key !== 'string' ||
            !['signal', 'timeoutMs'].includes(key) ||
            !descriptor ||
            !('value' in descriptor)
        ) {
            throw new TypeError('invalid ticket refresh options');
        }

        if (key === 'signal') {
            snapshot.signal = descriptor.value as AbortSignal | undefined;
        } else {
            snapshot.timeoutMs = descriptor.value as number | undefined;
        }
    }

    if (
        snapshot.timeoutMs !== undefined &&
        (!Number.isSafeInteger(snapshot.timeoutMs) ||
            snapshot.timeoutMs < 1 ||
            snapshot.timeoutMs > MAX_TIMER)
    ) {
        throw new TypeError('invalid ticket refresh options');
    }

    if (
        snapshot.signal !== undefined &&
        (isProxy(snapshot.signal) ||
            typeof snapshot.signal !== 'object' ||
            snapshot.signal === null ||
            Object.getPrototypeOf(snapshot.signal) !== AbortSignal.prototype ||
            Object.hasOwn(snapshot.signal, 'aborted') ||
            Object.hasOwn(snapshot.signal, 'addEventListener') ||
            Object.hasOwn(snapshot.signal, 'removeEventListener'))
    ) {
        throw new TypeError('invalid ticket refresh options');
    }

    if (snapshot.signal !== undefined && signalAborted.call(snapshot.signal)) {
        throw new Error('ticket refresh stopped');
    }

    return Object.freeze(snapshot);
}

function snapshotSendInput(input: unknown): ReferenceSessionSendInput {
    const outer = sendRecord(input, ['request', 'maxResponseBodyBytes']);
    const request = sendRecord(outer.request, ['route', 'text', 'clientSequence', 'random']);
    const routeValue = request.route;

    if (!routeValue || typeof routeValue !== 'object' || isProxy(routeValue)) {
        throw new TypeError('invalid send-text route');
    }

    const kind = Object.getOwnPropertyDescriptor(routeValue, 'kind');

    if (!kind || !('value' in kind)) {
        throw new TypeError('invalid send-text route');
    }

    const route = sendRecord(
        routeValue,
        kind.value === 'private' ? ['kind', 'peerUin', 'peerUid'] : ['kind', 'groupUin'],
    );
    request.route = route;
    const limit = outer.maxResponseBodyBytes;

    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0 || limit > 65536) {
        throw new TypeError('invalid send-text body limit');
    }

    // The real codec performs all field, Unicode and numeric checks before live().
    const stableRequest = request as unknown as ReferenceSessionSendInput['request'];
    const body = encodeDirectSendMessageRequest(stableRequest);
    const size = body.byteLength;
    nativeFill.call(body, 0);

    if (size > 65536) {
        throw new RangeError('send-text request exceeds size limit');
    }

    return { request: stableRequest, maxResponseBodyBytes: limit };
}

export interface WtMultiplexReferenceOptions {
    exclusiveConnected: true;
    transportUin: string;
    session: WtReferenceSessionOptions;
    initialSequence?: number;
    maxFrameBytes: number;
    maxBufferedBytes: number;
    maxFrames: number;
    maxPushFrames: number;
    maxPushBytes: number;
    maxWriteBufferBytes: number;
    /** Whole lease lifetime, measured from factory construction, including after registration. */
    leaseTimeoutMs: number;
    /** Independent caller policy over a temporary copy of the original encrypted frame. */
    verifyPushRaw(frame: Uint8Array, meta: PushMeta): boolean | Promise<boolean>;
    /** Invoked serially only after registration. The temporary copy is wiped at settlement
     * or earlier on termination; an outstanding callback must not rely on its contents then. */
    onPush(frame: Uint8Array, meta: PushMeta): void | Promise<void>;
    /** Required when onPushBody is set. Bounds the one in-flight delivered body,
     * separately from maxPushBytes; SSO inflation itself is capped at 16 MiB. */
    maxPushBodyBytes?: number;
    /** Runs after onPush settles successfully and the session is still live.
     * The independent body is wiped on settlement or earlier upon termination. */
    onPushBody?(
        body: Uint8Array,
        meta: Readonly<PushMeta & { retCode: number }>,
    ): void | Promise<void>;
}

export interface WtMultiplexReference extends WtReferenceSession {
    /** Stream logical closure; does not await listener release, physical closure or callbacks. */
    readonly whenClosed: Promise<Sso12CloseReason>;
    /** Synthetic reference response projection, not evidence of message delivery. */
    sendText(input: ReferenceSessionSendInput): Promise<SsoSendTextOutcome>;
    /** Inspect performs only the fixed Linux settings query. Apply requeries under one
     * gate after SSO/OIDB success, error=0/absent, an explicit matching expected setting,
     * and no questions. The query body's result is retained, not used as a gate: the
     * Linux UI checks the outer callback result instead. This conservative policy does
     * not automatically map settings to application fields; both sources and fields
     * stay caller-explicit.
     * The timeout is shared across both steps; write uncertainty is never retried.
     * A response does not establish friendship or recipient acceptance. */
    friendRequest(input: WtReferenceFriendInput): Promise<WtReferenceFriendResult>;
    /** Six fixed SSO12/D2 commands only, serialized with every other owner operation. */
    requestPacket(input: WtReferencePacketInput): Promise<WtReferencePacketResult>;
}

export interface WtRestoredMultiplexReferenceOptions extends Omit<
    WtMultiplexReferenceOptions,
    'session'
> {
    session: WtRestoredSessionOptions;
}

export interface WtRestoredMultiplexReference extends WtRestoredSession {
    readonly whenClosed: Promise<Sso12CloseReason>;
    sendText(input: ReferenceSessionSendInput): Promise<SsoSendTextOutcome>;
    friendRequest(input: WtReferenceFriendInput): Promise<WtReferenceFriendResult>;
    /** Six fixed SSO12/D2 commands only, serialized with every other owner operation. */
    requestPacket(input: WtReferencePacketInput): Promise<WtReferencePacketResult>;
}

/**
 * Owns an already-established injected stream. No connection is created or probed.
 * The fixed known push services are prioritized over sequence-only response routing.
 * See wt-reference-push-commands for the complete list and Core service references;
 * the original MsgPush routing reference is:
 * https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/Message/PushMessageService.cs
 * https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Context/PacketContext.cs
 * These static facts, local classification and QQ-TEA framing do not authenticate a peer.
 * WT and registration verifyRaw policies and verifyPushRaw remain caller responsibilities.
 * Options, session and profile are caller-controlled ordinary own-data records, kept
 * stable throughout construction; proxies and accessor properties are unsupported.
 * Callback effects and retained copies cannot be revoked; buffer wiping is best effort.
 * Temporary verification and delivery copies can be wiped on termination before an
 * outstanding callback settles. Independent stream closure is observed through the
 * whenClosed microtask or a subsequent liveness check, not necessarily in the same
 * stack as the close event. Timers and callback boundaries are not hard real time.
 * For an opted-in push: verify raw, decode and check metadata, deliver raw, then
 * recheck liveness and deliver body. Failure closes the session and skips subsequent
 * callbacks; effects of callbacks already invoked cannot be rolled back. The body
 * limit accounts for one in-flight independent body, in addition to the bounded raw
 * queue and verification copy. The SSO parser may allocate up to its own 16 MiB
 * inflation limit before the smaller body limit is checked.
 */
export function createWtMultiplexReference(
    stream: RawMultiplexByteStream,
    options: WtMultiplexReferenceOptions,
): WtMultiplexReference {
    return createMultiplexReference(stream, options);
}

function restoredRecord(input: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || isProxy(input)) {
        throw new TypeError('invalid restored options');
    }

    const prototype = Object.getPrototypeOf(input) as unknown;
    const keys = Reflect.ownKeys(input);

    if ((prototype !== Object.prototype && prototype !== null) || keys.length > allowed.length) {
        throw new TypeError('invalid restored options');
    }

    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);

        if (
            typeof key !== 'string' ||
            !allowed.includes(key) ||
            !descriptor ||
            !('value' in descriptor)
        ) {
            throw new TypeError('invalid restored options');
        }

        output[key] = descriptor.value;
    }

    return output;
}

/** Local import only. The new stream is registered only by an explicit restoreAndRegister call.
 * The caller must authenticate its stored account/device/profile binding before importing it. */
export function createWtRestoredMultiplexReference(
    stream: RawMultiplexByteStream,
    options: WtRestoredMultiplexReferenceOptions,
): WtRestoredMultiplexReference {
    const root = restoredRecord(options, [
        'exclusiveConnected',
        'transportUin',
        'session',
        'initialSequence',
        'maxFrameBytes',
        'maxBufferedBytes',
        'maxFrames',
        'maxPushFrames',
        'maxPushBytes',
        'maxWriteBufferBytes',
        'leaseTimeoutMs',
        'verifyPushRaw',
        'onPush',
        'maxPushBodyBytes',
        'onPushBody',
    ]);
    const session = restoredRecord(root.session, [
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
    ]);
    session.profile = restoredRecord(session.profile, ['subAppId', 'version']);
    session.registration = restoredRecord(session.registration, [
        'version',
        'deviceName',
        'deviceType',
        'vendorOs',
        'random',
    ]);

    if (session.checkpoint !== undefined) {
        session.checkpoint = restoredRecord(session.checkpoint, [
            'timeoutMs',
            'save',
            'invalidate',
        ]);
    }

    if (session.renewalCheckpoint !== undefined) {
        session.renewalCheckpoint = restoredRecord(session.renewalCheckpoint, [
            'timeoutMs',
            'save',
            'invalidate',
        ]);
    }

    const persisted = cloneWtPersistedSession(session.persisted);

    try {
        if (root.transportUin !== persisted.uin) {
            throw new TypeError('restored account mismatch');
        }

        session.persisted = persisted;
        root.session = session;
        return createMultiplexReference(
            stream,
            root as unknown as WtRestoredMultiplexReferenceOptions,
            true,
        );
    } finally {
        disposeWtPersistedSession(persisted);
    }
}

function createMultiplexReference(
    stream: RawMultiplexByteStream,
    options: WtMultiplexReferenceOptions,
    restored?: false,
): WtMultiplexReference;
function createMultiplexReference(
    stream: RawMultiplexByteStream,
    options: WtRestoredMultiplexReferenceOptions,
    restored: true,
): WtRestoredMultiplexReference;

function createMultiplexReference(
    stream: RawMultiplexByteStream,
    options: WtMultiplexReferenceOptions | WtRestoredMultiplexReferenceOptions,
    restored = false,
): WtMultiplexReference | WtRestoredMultiplexReference {
    const started = performance.now();
    const {
        exclusiveConnected,
        transportUin,
        session: sessionOptions,
        initialSequence,
        maxFrameBytes,
        maxBufferedBytes,
        maxFrames,
        maxPushFrames,
        maxPushBytes,
        maxWriteBufferBytes,
        leaseTimeoutMs,
        verifyPushRaw,
        onPush,
        maxPushBodyBytes,
        onPushBody,
    } = options;

    if (
        exclusiveConnected !== true ||
        typeof transportUin !== 'string' ||
        !/^[0-9]{1,20}$/.test(transportUin) ||
        !sessionOptions ||
        typeof sessionOptions !== 'object' ||
        !Number.isSafeInteger(leaseTimeoutMs) ||
        leaseTimeoutMs < 1 ||
        leaseTimeoutMs > MAX_TIMER ||
        !Number.isSafeInteger(maxPushFrames) ||
        maxPushFrames < 1 ||
        maxPushFrames > 65536 ||
        !Number.isSafeInteger(maxPushBytes) ||
        maxPushBytes < 14 ||
        maxPushBytes > 16 * 1024 * 1024 * 64 ||
        typeof verifyPushRaw !== 'function' ||
        typeof onPush !== 'function' ||
        (onPushBody !== undefined && typeof onPushBody !== 'function') ||
        (onPushBody !== undefined && maxPushBodyBytes === undefined) ||
        (maxPushBodyBytes !== undefined &&
            (!Number.isSafeInteger(maxPushBodyBytes) ||
                maxPushBodyBytes < 1 ||
                maxPushBodyBytes > 16 * 1024 * 1024))
    ) {
        throw new TypeError('invalid multiplex reference options');
    }

    const leaseDeadline = started + leaseTimeoutMs;
    const signal = sessionOptions.signal;
    const qrSessionOptions = restored ? undefined : (sessionOptions as WtReferenceSessionOptions);
    const restoredSessionOptions = restored
        ? (sessionOptions as WtRestoredSessionOptions)
        : undefined;
    const profileUin = restoredSessionOptions?.persisted.uin ?? qrSessionOptions!.profile.uin;
    const qrCommand = qrSessionOptions?.profile.qrCommand;
    const loginCommand = qrSessionOptions?.profile.loginCommand;
    const wtSigner = qrSessionOptions?.buildWtReserved;
    const registerSigner = sessionOptions.buildRegisterReserved;
    const registerVerifier = sessionOptions.verifyRegisterRaw;
    const token = createReferenceKeyCapability();
    let expected:
        | {
              uin: string;
              sequence: number;
              command: string;
              protocol: 12 | 13;
              encryption: 'zero' | 'd2' | 'none';
              hold: boolean | RawMultiplexResponseContinuation;
              friendStep?: ReferenceFriendStep;
              packetOperation?: ReferencePacketOperation;
          }
        | undefined;
    const currentExpected = () => expected;
    let friendVerified: typeof expected;
    const currentFriendVerified = () => friendVerified;
    let mux: RawMultiplexStreamClient | undefined;
    let lease: RawSessionLease | undefined;
    let owner: WtReferenceSession | WtRestoredSession | undefined;
    let sendHandle: ReferenceSessionSendHandle | undefined;
    let operation: Operation | undefined;
    let busy = false;
    let sendGate = false;
    let sendVerified = false;
    let refreshVerifiedStage: 0 | 1 | 2 = 0;
    let stopped = false;
    let externallyStopped = false;
    let registered = false;
    let generation = 0;
    let externalEpoch = 0;
    let runId: object | undefined;
    let claim:
        | {
              run: object;
              operation: Operation;
              generation: number;
              externalEpoch: number;
              preclosed?: boolean;
              selfRevoked: boolean;
              accepted: boolean;
              invalid: boolean;
          }
        | undefined;
    let delivering = false;
    let inCallback = false;
    let queuedBytes = 0;
    let activeCopy: Uint8Array | undefined;
    let activeBody: Uint8Array | undefined;
    const verificationCopies = new Set<Uint8Array>();
    let abortListener: ReturnType<typeof addAbortListener> | undefined;
    const queue: Array<{
        frame: Uint8Array;
        size: number;
        meta: PushMeta;
        decoded?: { body: Uint8Array; retCode: number };
    }> = [];

    const wipe = (value: Uint8Array | undefined): void => {
        try {
            if (value) {
                nativeFill.call(value, 0);
            }
        } catch {
            /* best effort */
        }
    };

    const disposeAbortListener = (): void => {
        const listener = abortListener;
        abortListener = undefined;

        try {
            listener?.[Symbol.dispose]();
        } catch {
            /* best effort */
        }
    };

    const revoke = (): void => {
        if (stopped) {
            return;
        }

        stopped = true;
        generation++;
        registered = false;
        expected = undefined;
        friendVerified = undefined;
        refreshVerifiedStage = 0;
        sendHandle = undefined;
        revokeReferenceKey(token);
        wipe(activeCopy);
        wipe(activeBody);

        for (const copy of verificationCopies) {
            wipe(copy);
        }

        verificationCopies.clear();

        for (const item of queue.splice(0)) {
            wipe(item.frame);
            wipe(item.decoded?.body);
        }

        queuedBytes = 0;

        // Keep observing an external abort until an in-flight result has been fenced.
        if (!busy) {
            disposeAbortListener();
        }
    };

    const closeAll = (propagated = false): void => {
        const candidate =
            propagated && claim?.accepted === true && claim.preclosed === false && !claim.invalid;

        if (claim) {
            if (candidate) {
                if (!stopped && generation === claim.generation) {
                    claim.selfRevoked = true;
                }
            } else {
                claim.invalid = true;
            }
        }

        revoke();

        if (candidate) {
            // A candidate still requires the owner's exact, single-use receipt. Defer
            // owner.close() until the in-flight result has settled and been checked.
            return;
        }

        try {
            owner?.close();
        } catch {
            /* close remaining owners */
        }

        try {
            lease?.poison();
        } catch {
            /* close remaining owners */
        }

        try {
            mux?.close();
        } catch {
            /* stream owns physical teardown */
        }
    };

    const stopExternally = (): void => {
        externalEpoch++;
        externallyStopped = true;
        closeAll();
    };

    const live = (expected = generation): boolean => {
        if (stopped || expected !== generation) {
            return false;
        }

        if (performance.now() >= leaseDeadline || signal?.aborted) {
            closeAll();
            return false;
        }

        if (mux?.closed || referenceKeyState(token) === 'revoked') {
            closeAll(true);
            return false;
        }

        return !stopped && expected === generation && !externallyStopped;
    };

    const makeExpected = (
        input: { uin: string; sequence: number; command: string },
        wt: boolean,
    ) => {
        if (
            !live() ||
            !Number.isInteger(input.sequence) ||
            input.sequence < 0 ||
            input.sequence > 0xffffffff
        ) {
            throw new Error('invalid request identity');
        }

        const confirmed = referenceExpectedUin(token);
        const keyState = referenceKeyState(token);
        let uin: string | undefined;
        let command: string;
        let protocol: 12 | 13 = 12;
        let encryption: 'zero' | 'd2' | 'none' = 'd2';
        let hold: boolean | RawMultiplexResponseContinuation = false;
        let ticketContinuation = false;
        let friendStep: ReferenceFriendStep | undefined;
        let packetOperation: ReferencePacketOperation | undefined;

        if (
            !restored &&
            wt &&
            (operation === 'fetch' || operation === 'poll') &&
            keyState === 'empty'
        ) {
            uin = profileUin;
            command = qrCommand!;
            encryption = 'zero';
            hold = operation === 'poll';
        } else if (!restored && wt && operation === 'login-register' && keyState === 'empty') {
            uin = confirmed;
            command = loginCommand!;
            encryption = 'zero';
            hold = true;
        } else if (
            !wt &&
            operation === (restored ? 'restore-register' : 'login-register') &&
            keyState === 'tentative'
        ) {
            uin = confirmed;
            command = SSO_INFO_SYNC_COMMAND;
        } else if (!wt && operation === 'heartbeat' && keyState === 'active') {
            uin = confirmed;
            command = SSO_HEARTBEAT_COMMAND;
        } else if (!wt && operation === 'refresh-tickets' && keyState === 'active') {
            if (!sendGate) {
                throw new Error('invalid ticket refresh gate');
            }

            if (
                input.command === NATIVE_KEY_EXCHANGE_COMMAND &&
                expected === undefined &&
                refreshVerifiedStage === 0
            ) {
                command = NATIVE_KEY_EXCHANGE_COMMAND;
            } else if (
                input.command === NATIVE_TICKET_REFRESH_COMMAND &&
                expected?.command === NATIVE_KEY_EXCHANGE_COMMAND &&
                refreshVerifiedStage === 1
            ) {
                command = NATIVE_TICKET_REFRESH_COMMAND;
                ticketContinuation = true;
            } else {
                throw new Error('invalid ticket refresh transition');
            }

            uin = confirmed;
        } else if (!wt && operation === 'send-text' && keyState === 'active') {
            uin = confirmed;
            command = 'MessageSvc.PbSendMsg';
        } else if (!wt && operation === 'friend-request' && keyState === 'active') {
            if (!owner || !lease || !runId || !sendGate) {
                throw new Error('invalid friend owner');
            }

            friendStep = referenceActiveFriendStep(token, owner, lease, runId);

            if (
                expected &&
                (friendVerified !== expected ||
                    expected.friendStep?.stepId !== 'settings' ||
                    friendStep.stepId !== 'application' ||
                    expected.friendStep.workflowRun !== friendStep.workflowRun ||
                    expected.friendStep.childRun === friendStep.childRun)
            ) {
                throw new Error('invalid friend step transition');
            }

            uin = confirmed;
            command = referenceFriendStepCommand(friendStep.stepId);
            sendVerified = false;
            friendVerified = undefined;
        } else if (!wt && operation === 'request-packet' && keyState === 'active') {
            if (!owner || !lease || !runId || !sendGate || expected) {
                throw new Error('invalid packet owner');
            }

            packetOperation = referenceActivePacketOperation(token, owner, lease, runId);
            uin = confirmed;
            command = packetOperation.command;
            sendVerified = false;
        } else if (!wt && operation === 'alive' && keyState === 'active') {
            uin = confirmed;
            command = SSO_REFERENCE_ALIVE_COMMAND;
            protocol = 13;
            encryption = 'none';
        } else {
            throw new Error('invalid request phase');
        }

        if (!uin || input.uin !== uin || input.command !== command) {
            throw new Error('invalid request binding');
        }

        if (ticketContinuation) {
            if (!owner || !lease) {
                throw new Error('invalid ticket refresh continuation owner');
            }

            let release!: () => void;
            const untilReleased = new Promise<void>((resolve) => {
                release = resolve;
            });
            armReferenceTicketRefreshContinuation(token, owner, lease, release);
            hold = Object.freeze({ untilReleased });
        }

        const next = {
            uin,
            sequence: input.sequence,
            command,
            protocol,
            encryption,
            hold,
            friendStep,
            packetOperation,
        };
        expected = next;
        return next;
    };

    const drain = (): void => {
        // live() consults caller-observable clock/signal state and may reenter sendText.
        if (sendGate || delivering || !registered || !live() || sendGate) {
            return;
        }

        delivering = true;
        const current = generation;
        setImmediate(() => {
            void (async () => {
                let turns = 0;

                try {
                    while (registered && !sendGate && live(current) && !sendGate && queue.length) {
                        if (++turns === 32) {
                            turns = 0;
                            await new Promise<void>((resolve) => setImmediate(resolve));

                            if (sendGate || !live(current) || sendGate) {
                                break;
                            }
                        }

                        if (sendGate) {
                            break;
                        }

                        const item = queue.shift()!;
                        activeCopy = item.frame;
                        inCallback = true;
                        const verificationCopy = Uint8Array.from(item.frame);
                        verificationCopies.add(verificationCopy);

                        try {
                            if (referenceKeyState(token) !== 'active' || !live(current)) {
                                break;
                            }

                            const verified = await verifyPushRaw(verificationCopy, item.meta);

                            if (!live(current) || referenceKeyState(token) !== 'active') {
                                break;
                            }

                            if (verified !== true) {
                                throw new Error('push verification failed');
                            }

                            let bodyMeta: Readonly<PushMeta & { retCode: number }> | undefined;

                            if (onPushBody) {
                                const decoded =
                                    item.decoded ??
                                    decodeReferencePushBody(
                                        token,
                                        item.frame,
                                        transportUin,
                                        item.meta,
                                        maxPushBodyBytes!,
                                    );
                                item.decoded = undefined;
                                activeBody = decoded.body;
                                bodyMeta = Object.freeze({
                                    ...item.meta,
                                    retCode: decoded.retCode,
                                });

                                if (!live(current) || referenceKeyState(token) !== 'active') {
                                    break;
                                }
                            }

                            await onPush(item.frame, item.meta);

                            if (onPushBody && activeBody && bodyMeta) {
                                if (!live(current) || referenceKeyState(token) !== 'active') {
                                    break;
                                }

                                await onPushBody(activeBody, bodyMeta);
                            }
                        } finally {
                            verificationCopies.delete(verificationCopy);
                            wipe(verificationCopy);
                            inCallback = false;
                            wipe(activeBody);
                            activeBody = undefined;
                            wipe(item.decoded?.body);
                            item.decoded = undefined;
                            wipe(item.frame);
                            activeCopy = undefined;

                            if (!stopped) {
                                queuedBytes -= item.size;
                            }
                        }
                    }
                } catch {
                    closeAll();
                } finally {
                    delivering = false;

                    if (!sendGate && registered && queue.length && live(current) && !sendGate) {
                        drain();
                    }
                }
            })();
        });
    };

    try {
        mux = createRawMultiplexStream(stream, {
            exclusiveConnected: true,
            uin: transportUin,
            initialSequence,
            maxFrameBytes,
            maxBufferedBytes,
            maxFrames,
            maxPushFrames,
            maxPushBytes,
            maxWriteBufferBytes,
            classify(frame, identity) {
                if (!live() || identity.uin !== transportUin) {
                    return { kind: 'reject' };
                }

                try {
                    const decoded = decodeReferenceFrame(token, frame, transportUin);

                    if (!live()) {
                        return { kind: 'reject' };
                    }

                    const protocol = decoded.protocol;
                    const confirmed = referenceExpectedUin(token);

                    if (isWtReferencePushCommand(decoded.command)) {
                        if (
                            !confirmed ||
                            decoded.uin !== confirmed ||
                            !isWtReferencePushProtocol(decoded.command, protocol) ||
                            decoded.encryption !== 'd2'
                        ) {
                            log.warn(
                                'rejected direct WT push envelope: command=%s protocol=%s encryption=%s accountMatch=%s registered=%s',
                                decoded.command,
                                protocol,
                                decoded.encryption,
                                confirmed !== undefined && decoded.uin === confirmed,
                                confirmed !== undefined,
                            );
                            return { kind: 'reject' };
                        }

                        return { kind: 'push', name: decoded.command, id: decoded.sequence };
                    }

                    const request = expected;
                    // Linux SsoInfoSync may use the fixed zero key for its response even
                    // though the associated request used D2. Keep the exception confined to
                    // this registration command; every push and other response stays exact.
                    const encryptionMatches =
                        request !== undefined &&
                        (decoded.encryption === request.encryption ||
                            (request.command === SSO_INFO_SYNC_COMMAND &&
                                request.encryption === 'd2' &&
                                decoded.encryption === 'zero'));
                    const accepted =
                        request !== undefined &&
                        identity.sequence === request.sequence &&
                        decoded.sequence === request.sequence &&
                        decoded.uin === request.uin &&
                        decoded.command === request.command &&
                        encryptionMatches &&
                        protocol === request.protocol;

                    if (!accepted) {
                        log.warn(
                            'rejected direct WT response envelope: expectedCommand=%s actualCommand=%s expectedProtocol=%s actualProtocol=%s expectedEncryption=%s actualEncryption=%s sequenceMatch=%s accountMatch=%s',
                            request?.command ?? 'none',
                            decoded.command,
                            request?.protocol ?? 'none',
                            protocol,
                            request?.encryption ?? 'none',
                            decoded.encryption,
                            request !== undefined &&
                                identity.sequence === request.sequence &&
                                decoded.sequence === request.sequence,
                            request !== undefined && decoded.uin === request.uin,
                        );
                    }

                    return accepted
                        ? { kind: 'response', sequence: decoded.sequence }
                        : { kind: 'reject' };
                } catch (error) {
                    log.warn(
                        'rejected undecodable direct WT frame: %s',
                        error instanceof Error ? error.message : String(error),
                    );
                    return { kind: 'reject' };
                }
            },
            holdFollowingFrames(identity) {
                if (!live() || identity.uin !== transportUin) {
                    throw new Error('stopped');
                }

                if (!expected || expected.sequence !== identity.sequence) {
                    throw new Error('invalid response identity');
                }

                return expected.hold;
            },
            verifyPush(_frame, route) {
                return (
                    live() &&
                    referenceExpectedUin(token) !== undefined &&
                    isWtReferencePushCommand(route.name) &&
                    referenceKeyState(token) !== 'empty'
                );
            },
            onPush(frame, route: RawMultiplexPushRoute) {
                const uin = referenceExpectedUin(token);

                if (
                    !live() ||
                    !uin ||
                    !isWtReferencePushCommand(route.name) ||
                    queue.length + (activeCopy ? 1 : 0) >= maxPushFrames ||
                    queuedBytes + frame.length > maxPushBytes
                ) {
                    throw new Error('push capacity or stopped');
                }

                const copy = Uint8Array.from(frame);
                const meta = Object.freeze({ uin, sequence: route.id, command: route.name });
                let decoded: { body: Uint8Array; retCode: number } | undefined;

                try {
                    if (sendGate && operation === 'refresh-tickets' && onPushBody) {
                        decoded = decodeReferencePushBody(
                            token,
                            frame,
                            transportUin,
                            meta,
                            maxPushBodyBytes!,
                        );
                    }

                    const size = copy.length + (decoded?.body.length ?? 0);

                    if (queuedBytes + size > maxPushBytes) {
                        throw new Error('push capacity or stopped');
                    }

                    queuedBytes += size;
                    queue.push({ frame: copy, size, meta, decoded });
                } catch (error) {
                    wipe(copy);
                    wipe(decoded?.body);
                    throw error;
                }

                drain();
            },
        });
        const streamClient = mux;
        // The broker retains this exact adapter; the stream client still owns its
        // original stream and its whenClosed promise keeps its original identity.
        const adapter: Sso12RawClient = {
            whenClosed: streamClient.whenClosed,
            transactRaw: (input) => streamClient.transactRaw(input),
            close() {
                if (claim) {
                    if (claim.preclosed !== undefined) {
                        claim.invalid = true;
                    } else {
                        claim.preclosed = streamClient.closed;
                    }
                }

                streamClient.close();
            },
        };
        const { broker, terminal } = createRawSessionBrokerInternal(adapter, {
            trustedSuccessQuiescence: true,
            isUsable: () => live() && !streamClient.closed,
        });
        const fence = {
            beforeClaim(): boolean {
                if (
                    !runId ||
                    !operation ||
                    claim ||
                    stopped ||
                    externallyStopped ||
                    streamClient.closed ||
                    referenceKeyState(token) === 'revoked'
                ) {
                    return false;
                }

                const current = {
                    run: runId,
                    operation,
                    generation,
                    externalEpoch,
                    selfRevoked: false,
                    accepted: false,
                    invalid: false,
                };
                claim = current;
                const valid =
                    performance.now() < leaseDeadline &&
                    !signal?.aborted &&
                    claim === current &&
                    runId === current.run &&
                    operation === current.operation &&
                    generation === current.generation &&
                    externalEpoch === current.externalEpoch &&
                    !stopped &&
                    !externallyStopped &&
                    !streamClient.closed &&
                    referenceKeyState(token) !== 'revoked';

                if (!valid) {
                    current.invalid = true;
                }

                return valid;
            },
            afterClaim(): boolean {
                const current = claim;

                if (!current) {
                    return false;
                }

                const valid =
                    performance.now() < leaseDeadline &&
                    !signal?.aborted &&
                    claim === current &&
                    runId === current.run &&
                    operation === current.operation &&
                    externalEpoch === current.externalEpoch &&
                    !externallyStopped &&
                    !current.invalid &&
                    current.preclosed === false &&
                    (stopped
                        ? current.accepted &&
                          current.selfRevoked &&
                          generation === current.generation + 1
                        : generation === current.generation) &&
                    streamClient.closed;
                current.accepted = valid;
                current.invalid ||= !valid;
                return valid;
            },
        };
        lease = broker.acquire({
            deadline: leaseDeadline,
            signal,
        });

        if (typeof registerVerifier !== 'function' || isProxy(registerVerifier)) {
            throw new TypeError('invalid register verifier');
        }

        const bindings: Pick<
            WtReferenceSessionOptions,
            'buildRegisterReserved' | 'verifyRegisterRaw'
        > = {
            buildRegisterReserved: async (input) => {
                const current = generation;
                const request = makeExpected(input, false);
                const result = await registerSigner(input);

                if (
                    !live(current) ||
                    expected !== request ||
                    (request.friendStep &&
                        (!owner ||
                            !lease ||
                            !runId ||
                            referenceActiveFriendStep(token, owner, lease, runId) !==
                                request.friendStep)) ||
                    (request.packetOperation &&
                        (!owner ||
                            !lease ||
                            !runId ||
                            referenceActivePacketOperation(token, owner, lease, runId) !==
                                request.packetOperation))
                ) {
                    throw new Error('signer stopped');
                }

                return result;
            },
            verifyRegisterRaw: (input) => {
                if (operation === 'refresh-tickets') {
                    return (async () => {
                        const current = generation;
                        const request = expected;
                        const expectedStage =
                            request?.command === NATIVE_KEY_EXCHANGE_COMMAND
                                ? 0
                                : request?.command === NATIVE_TICKET_REFRESH_COMMAND
                                  ? 1
                                  : undefined;

                        const check = (): void => {
                            if (
                                !sendGate ||
                                !busy ||
                                !request ||
                                expectedStage === undefined ||
                                refreshVerifiedStage !== expectedStage ||
                                !owner ||
                                !lease ||
                                !runId ||
                                operation !== 'refresh-tickets' ||
                                input.uin !== request.uin ||
                                input.sequence !== request.sequence ||
                                input.command !== request.command ||
                                !live(current) ||
                                expected !== request ||
                                referenceKeyState(token) !== 'active'
                            ) {
                                throw new Error('invalid ticket refresh verifier binding');
                            }
                        };

                        check();
                        const result = await registerVerifier(input);
                        check();

                        if (result === true) {
                            refreshVerifiedStage = ((expectedStage as 0 | 1) + 1) as 1 | 2;
                        }

                        return result;
                    })();
                }

                if (operation === 'request-packet') {
                    return (async () => {
                        const current = generation;
                        const request = expected;
                        const packet = request?.packetOperation;

                        const check = (): void => {
                            if (
                                !sendGate ||
                                !busy ||
                                !request ||
                                !packet ||
                                !owner ||
                                !lease ||
                                !runId ||
                                operation !== 'request-packet' ||
                                packet.run !== runId ||
                                input.uin !== request.uin ||
                                input.sequence !== request.sequence ||
                                input.command !== packet.command ||
                                request.command !== input.command ||
                                !live(current) ||
                                expected !== request ||
                                referenceActivePacketOperation(token, owner, lease, runId) !==
                                    packet
                            ) {
                                throw new Error('invalid packet verifier binding');
                            }
                        };

                        check();
                        const result = await registerVerifier(input);
                        check();

                        if (result === true) {
                            sendVerified = true;
                        }

                        return result;
                    })();
                }

                if (operation === 'friend-request') {
                    return (async () => {
                        const current = generation;
                        const request = expected;
                        const stage = request?.friendStep;

                        const check = (): void => {
                            if (
                                !sendGate ||
                                !busy ||
                                !request ||
                                !stage ||
                                !owner ||
                                !lease ||
                                !runId ||
                                operation !== 'friend-request' ||
                                stage.workflowRun !== runId ||
                                input.uin !== request.uin ||
                                input.sequence !== request.sequence ||
                                input.command !== referenceFriendStepCommand(stage.stepId) ||
                                request.command !== input.command ||
                                !live(current) ||
                                expected !== request ||
                                referenceActiveFriendStep(token, owner, lease, runId) !== stage
                            ) {
                                throw new Error('invalid friend verifier binding');
                            }
                        };

                        check();
                        const result = await registerVerifier(input);
                        check();

                        if (result === true) {
                            sendVerified = true;
                            friendVerified = request;
                        }

                        return result;
                    })();
                }

                if (operation !== 'send-text') {
                    return registerVerifier(input);
                }

                return (async () => {
                    const current = generation;
                    const request = expected;

                    if (
                        !sendGate ||
                        !request ||
                        request.command !== 'MessageSvc.PbSendMsg' ||
                        input.uin !== request.uin ||
                        input.sequence !== request.sequence ||
                        input.command !== request.command ||
                        !live(current) ||
                        expected !== request
                    ) {
                        throw new Error('invalid send verifier binding');
                    }

                    const result = await registerVerifier(input);

                    if (!live(current) || expected !== request || !sendGate) {
                        throw new Error('send verifier stopped');
                    }

                    if (result === true) {
                        sendVerified = true;
                    }

                    return result;
                })();
            },
        };

        if (restoredSessionOptions) {
            owner = createWtRestoredSessionWithCapability(
                lease,
                { ...restoredSessionOptions, ...bindings, signal },
                token,
            );
        } else {
            owner = createWtReferenceSessionWithCapability(
                lease,
                {
                    ...qrSessionOptions!,
                    ...bindings,
                    signal,
                    buildWtReserved: async (input) => {
                        const current = generation;
                        const request = makeExpected(input, true);
                        const result = await wtSigner!(input);

                        if (!live(current) || expected !== request) {
                            throw new Error('signer stopped');
                        }

                        return result;
                    },
                },
                token,
                terminal,
                fence,
            );
        }

        sendHandle = takeReferenceSessionSend(token, owner, lease);

        if (!sendHandle) {
            throw new Error('missing reference send binding');
        }

        if (signal) {
            abortListener = addAbortListener(signal, stopExternally);

            if (signal.aborted) {
                stopExternally();
            }
        }

        void streamClient.whenClosed.then(
            () => closeAll(true),
            () => closeAll(),
        );
        void lease.whenClosed.then(
            () => closeAll(true),
            () => closeAll(),
        );

        if (!live()) {
            throw new Error('session stopped');
        }

        const run = async <T>(next: Operation, action: () => Promise<T>): Promise<T> => {
            if (
                !live() ||
                busy ||
                sendGate ||
                inCallback ||
                (next === 'refresh-tickets' && queue.length > 0)
            ) {
                throw new Error('multiplex session busy or stopped');
            }

            busy = true;
            operation = next;

            if (next === 'refresh-tickets') {
                sendGate = true;
                refreshVerifiedStage = 0;
            }

            const current = generation;
            const currentRun = {};
            let pendingExactDelivery: { deadline: number; externalEpoch: number } | undefined;
            runId = currentRun;

            try {
                const result = await action();

                // Owner results are ordinary records; do not run an accessor while
                // deciding whether a terminal receipt matches this exact value.
                if (!result || typeof result !== 'object' || isProxy(result)) {
                    throw new Error('invalid session result');
                }

                const descriptor = Object.getOwnPropertyDescriptor(result, 'status');
                const status = descriptor && 'value' in descriptor ? descriptor.value : undefined;

                if (next === 'refresh-tickets') {
                    const networkResult =
                        expected?.command === NATIVE_TICKET_REFRESH_COMMAND &&
                        refreshVerifiedStage === 2;
                    const localDisabled =
                        status === 'disabled' &&
                        expected === undefined &&
                        refreshVerifiedStage === 0;
                    const committedNeedsLogin =
                        status === 'needs-login' &&
                        stopped &&
                        expected === undefined &&
                        refreshVerifiedStage === 0;

                    if (
                        ![
                            'refreshed',
                            'protocol-error',
                            'empty-a1',
                            'needs-login',
                            'disabled',
                        ].includes(status as string) ||
                        (!networkResult && !localDisabled && !committedNeedsLogin)
                    ) {
                        throw new Error('invalid ticket refresh result');
                    }
                }

                const businessFailure =
                    (next === 'poll' &&
                        (status === 'expired' ||
                            status === 'canceled' ||
                            status === 'invalid' ||
                            status === 'unknown')) ||
                    ((next === 'login-register' || next === 'restore-register') &&
                        (status === 'verification-required' ||
                            status === 'nonzero' ||
                            status === 'incomplete' ||
                            status === 'error' ||
                            status === 'rejected' ||
                            status === 'missing-result' ||
                            status === 'sso-error')) ||
                    ((next === 'heartbeat' || next === 'alive') && status === 'sso-error') ||
                    (next === 'refresh-tickets' && status === 'needs-login');

                if (businessFailure && typeof status === 'string') {
                    const exactReceipt =
                        next === 'poll' ||
                        (next === 'login-register' &&
                            (status === 'verification-required' ||
                                status === 'nonzero' ||
                                status === 'incomplete' ||
                                status === 'error'));

                    if (exactReceipt && (next === 'poll' || next === 'login-register')) {
                        const candidate = claim;

                        const candidateValid = (deadline: number): boolean => {
                            if (
                                !candidate ||
                                claim !== candidate ||
                                candidate.invalid ||
                                !candidate.accepted ||
                                candidate.preclosed !== false ||
                                candidate.run !== currentRun ||
                                candidate.operation !== next ||
                                candidate.generation !== current ||
                                candidate.externalEpoch !== externalEpoch ||
                                runId !== currentRun ||
                                operation !== next ||
                                externallyStopped ||
                                (stopped
                                    ? !candidate.selfRevoked || generation !== current + 1
                                    : generation !== current)
                            ) {
                                return false;
                            }

                            const now = performance.now();

                            if (now >= leaseDeadline || now >= deadline || signal?.aborted) {
                                return false;
                            }

                            return (
                                claim === candidate &&
                                !candidate.invalid &&
                                externalEpoch === candidate.externalEpoch &&
                                runId === currentRun &&
                                operation === next &&
                                !externallyStopped &&
                                (stopped
                                    ? candidate.selfRevoked && generation === current + 1
                                    : generation === current)
                            );
                        };

                        if (!candidateValid(leaseDeadline)) {
                            throw new Error('session stopped');
                        }

                        // The take burns its exact receipt even on a mismatch.
                        const receipt = takeReferenceExactBusinessFailure(
                            token,
                            next,
                            status,
                            result,
                        );

                        if (
                            !receipt ||
                            typeof receipt.deadline !== 'number' ||
                            !Number.isFinite(receipt.deadline) ||
                            !candidateValid(receipt.deadline)
                        ) {
                            throw new Error('session stopped');
                        }

                        // Completing cleanup can itself reenter public close/abort.
                        // The receipt is already consumed; never retry it.
                        closeAll();
                        const now = performance.now();

                        if (
                            now >= leaseDeadline ||
                            now >= receipt.deadline ||
                            signal?.aborted ||
                            externallyStopped ||
                            externalEpoch !== candidate!.externalEpoch ||
                            runId !== currentRun ||
                            operation !== next
                        ) {
                            throw new Error('session stopped');
                        }

                        pendingExactDelivery = {
                            deadline: receipt.deadline,
                            externalEpoch: candidate!.externalEpoch,
                        };
                        return result;
                    }

                    if (
                        externallyStopped ||
                        signal?.aborted ||
                        performance.now() >= leaseDeadline ||
                        !consumeReferenceBusinessFailure(token, next, status)
                    ) {
                        throw new Error('session stopped');
                    }

                    // No business delivery while determining why the stream stopped. The
                    // private tombstone survives key revocation but is consumed exactly once.
                    revoke();
                    const reason = await streamClient.whenClosed;

                    if (
                        externallyStopped ||
                        signal?.aborted ||
                        performance.now() >= leaseDeadline ||
                        reason.kind !== 'local' ||
                        reason.code !== 'local-close'
                    ) {
                        throw new Error('session stopped');
                    }

                    const stopEpoch = externalEpoch;
                    closeAll();

                    // The clock and cleanup can synchronously reenter close or abort.
                    // Timers and disposal of the listener in finally are not hard-real-time
                    // fences against modified intrinsics or arbitrary same-process effects.
                    if (
                        externallyStopped ||
                        externalEpoch !== stopEpoch ||
                        signal?.aborted ||
                        performance.now() >= leaseDeadline ||
                        signal?.aborted ||
                        externallyStopped ||
                        externalEpoch !== stopEpoch
                    ) {
                        throw new Error('session stopped');
                    }

                    return result;
                }

                if (!live(current)) {
                    throw new Error('session stopped');
                }

                if (next === 'login-register' || next === 'restore-register') {
                    if (status === 'success') {
                        if (referenceKeyState(token) !== 'active') {
                            throw new Error('key not committed');
                        }

                        registered = true;
                    } else {
                        closeAll();
                    }
                }

                if (owner!.getState() === 'failed' || owner!.getState() === 'closed') {
                    closeAll();
                }

                return result;
            } catch (error) {
                closeAll();
                throw error;
            } finally {
                expected = undefined;
                operation = undefined;
                runId = undefined;
                claim = undefined;
                busy = false;

                if (next === 'refresh-tickets') {
                    sendGate = false;
                    refreshVerifiedStage = 0;
                }

                if (stopped) {
                    disposeAbortListener();
                }

                if (registered && live(current)) {
                    drain();
                }

                // Only a pending WT failure may reach this fence. It runs after
                // listener disposal, which can synchronously reenter cancellation.
                // Existing thrown errors and other result paths are unchanged.
                if (pendingExactDelivery) {
                    const pending = pendingExactDelivery;

                    if (
                        externallyStopped ||
                        externalEpoch !== pending.externalEpoch ||
                        signal?.aborted
                    ) {
                        // eslint-disable-next-line no-unsafe-finally -- Reject pending WT delivery after cancellation during cleanup.
                        throw new Error('session stopped');
                    }

                    const finalNow = performance.now();

                    if (
                        finalNow >= leaseDeadline ||
                        finalNow >= pending.deadline ||
                        signal?.aborted ||
                        externallyStopped ||
                        externalEpoch !== pending.externalEpoch
                    ) {
                        // eslint-disable-next-line no-unsafe-finally -- Reject an expired pending WT terminal delivery.
                        throw new Error('session stopped');
                    }
                }
            }
        };

        const sendText = async (
            input: ReferenceSessionSendInput | undefined,
        ): Promise<SsoSendTextOutcome> => {
            if (busy || sendGate || inCallback) {
                throw new Error('multiplex session busy');
            }

            // Establish local ownership before validation, clocks, or other reentrant calls.
            busy = true;
            sendGate = true;
            operation = 'send-text';
            const currentRun = {};
            runId = currentRun;
            const current = generation;
            const startExternalEpoch = externalEpoch;
            let entered = false;
            let succeeded = false;

            try {
                const snapshot = snapshotSendInput(input);
                input = undefined;

                // A premature call is a caller-state error, not an owner failure.
                if (!registered && !stopped) {
                    throw new Error('multiplex session not registered');
                }

                entered = true;
                const handle = sendHandle;

                if (
                    !handle ||
                    !registered ||
                    expected !== undefined ||
                    claim !== undefined ||
                    !live(current) ||
                    !busy ||
                    !sendGate ||
                    runId !== currentRun ||
                    operation !== 'send-text' ||
                    sendHandle !== handle ||
                    owner!.getState() !== 'success' ||
                    referenceKeyState(token) !== 'active'
                ) {
                    throw new Error('invalid send session');
                }

                sendVerified = false;
                const result = await handle(snapshot);
                const responseExpected = currentExpected();

                if (
                    !result ||
                    typeof result !== 'object' ||
                    isProxy(result) ||
                    Object.getOwnPropertyDescriptor(result, 'status')?.value !== 'response' ||
                    !sendVerified ||
                    !responseExpected ||
                    responseExpected.command !== 'MessageSvc.PbSendMsg' ||
                    !live(current) ||
                    currentExpected() !== responseExpected ||
                    !busy ||
                    !sendGate ||
                    runId !== currentRun ||
                    operation !== 'send-text' ||
                    sendHandle !== handle ||
                    referenceKeyState(token) !== 'active' ||
                    owner!.getState() !== 'success'
                ) {
                    throw new Error('send session stopped');
                }

                succeeded = true;
                return result;
            } catch (error) {
                if (entered) {
                    closeAll();
                }

                throw error;
            } finally {
                const owned = runId === currentRun;

                if (owned) {
                    expected = undefined;
                    operation = undefined;
                    runId = undefined;
                    sendVerified = false;
                    busy = false;
                    sendGate = false;
                }

                if (stopped) {
                    disposeAbortListener();
                }

                if (succeeded) {
                    let fenceFailed = false;
                    let fenceError: unknown;

                    try {
                        if (owned && registered && queue.length && live(current)) {
                            drain();
                        }

                        // The wakeup and this clock/signal read may reenter close/abort.
                        // Do not inspect or clear runId again: a later operation may own it.
                        const now = performance.now();
                        const aborted = signal?.aborted === true;

                        if (
                            !owned ||
                            now >= leaseDeadline ||
                            aborted ||
                            stopped ||
                            generation !== current ||
                            externallyStopped ||
                            externalEpoch !== startExternalEpoch ||
                            streamClient.closed ||
                            referenceKeyState(token) !== 'active'
                        ) {
                            fenceFailed = true;
                            fenceError = new Error('send session stopped');
                        }
                    } catch (error) {
                        fenceFailed = true;
                        fenceError = error;
                    }

                    if (fenceFailed) {
                        closeAll();
                        // eslint-disable-next-line no-unsafe-finally -- A stopped result must not escape the final delivery fence.
                        throw fenceError;
                    }
                }
            }
        };

        const friendRequest = async (
            input: WtReferenceFriendInput | undefined,
        ): Promise<WtReferenceFriendResult> => {
            if (busy || sendGate || inCallback) {
                throw new Error('multiplex session busy');
            }

            busy = true;
            sendGate = true;
            operation = 'friend-request';
            const currentRun = {};
            runId = currentRun;
            const current = generation;
            const startExternalEpoch = externalEpoch;
            const progress: ReferenceFriendProgress = {
                stage: 'settings',
                applicationAttempted: false,
                applicationWriteState: 'not-written',
            };
            let prepared: PreparedReferenceFriendInput | undefined;
            let entered = false;
            let succeeded = false;
            let deadline = 0;

            try {
                // The fallback identity exists only for validation before registration;
                // an unregistered operation never reaches a signer or transport.
                prepared = prepareReferenceFriendInput(
                    input,
                    BigInt(referenceExpectedUin(token) ?? '1'),
                );
                input = undefined;

                if (!registered && !stopped) {
                    throw new Error('multiplex session not registered');
                }

                entered = true;
                const handle = sendHandle;
                deadline = Math.min(leaseDeadline, performance.now() + prepared.timeoutMs);

                if (
                    !handle ||
                    !registered ||
                    expected !== undefined ||
                    claim !== undefined ||
                    !live(current) ||
                    !busy ||
                    !sendGate ||
                    runId !== currentRun ||
                    operation !== 'friend-request' ||
                    sendHandle !== handle ||
                    owner!.getState() !== 'success' ||
                    referenceKeyState(token) !== 'active'
                ) {
                    throw new WtReferenceFriendError(progress, 'workflow-stopped');
                }

                sendVerified = false;
                friendVerified = undefined;
                const result = await handle.friendRequest(prepared, currentRun, deadline, progress);
                const responseExpected = currentExpected();
                const stage = responseExpected?.friendStep;
                const finalStep =
                    result.status === 'application-response' ? 'application' : 'settings';

                if (
                    !sendVerified ||
                    !responseExpected ||
                    currentFriendVerified() !== responseExpected ||
                    !stage ||
                    stage.workflowRun !== currentRun ||
                    stage.stepId !== finalStep ||
                    responseExpected.command !== referenceFriendStepCommand(finalStep) ||
                    !live(current) ||
                    currentExpected() !== responseExpected ||
                    !busy ||
                    !sendGate ||
                    runId !== currentRun ||
                    operation !== 'friend-request' ||
                    sendHandle !== handle ||
                    referenceKeyState(token) !== 'active' ||
                    owner!.getState() !== 'success' ||
                    performance.now() >= deadline
                ) {
                    throw new WtReferenceFriendError(progress, 'workflow-stopped');
                }

                succeeded = true;
                return result;
            } catch (error) {
                if (entered) {
                    closeAll();
                    throw error instanceof WtReferenceFriendError
                        ? error
                        : new WtReferenceFriendError(progress, 'workflow-stopped');
                }

                throw error;
            } finally {
                disposePreparedReferenceFriendInput(prepared);
                const owned = runId === currentRun;

                if (owned) {
                    expected = undefined;
                    operation = undefined;
                    runId = undefined;
                    sendVerified = false;
                    friendVerified = undefined;
                    busy = false;
                    sendGate = false;
                }

                if (stopped) {
                    disposeAbortListener();
                }

                if (succeeded) {
                    let failed = false;

                    try {
                        if (owned && registered && queue.length && live(current)) {
                            drain();
                        }

                        const now = performance.now();

                        if (
                            !owned ||
                            now >= deadline ||
                            now >= leaseDeadline ||
                            signal?.aborted ||
                            stopped ||
                            generation !== current ||
                            externallyStopped ||
                            externalEpoch !== startExternalEpoch ||
                            streamClient.closed ||
                            referenceKeyState(token) !== 'active'
                        ) {
                            failed = true;
                        }
                    } catch {
                        failed = true;
                    }

                    if (failed) {
                        closeAll();
                        // eslint-disable-next-line no-unsafe-finally -- Fence pending friend results after cleanup and push wakeup.
                        throw new WtReferenceFriendError(progress, 'workflow-stopped');
                    }
                }
            }
        };

        const requestPacket = async (
            input: WtReferencePacketInput | undefined,
        ): Promise<WtReferencePacketResult> => {
            if (busy || sendGate || inCallback) {
                throw new Error('multiplex session busy');
            }

            busy = true;
            sendGate = true;
            operation = 'request-packet';
            const currentRun = {};
            runId = currentRun;
            const current = generation;
            const startExternalEpoch = externalEpoch;
            const progress: ReferencePacketProgress = { writeState: 'not-written' };
            let prepared: WtReferencePacketInput | undefined;
            let response: WtReferencePacketResult | undefined;
            let entered = false;
            let deadline = 0;

            try {
                prepared = prepareReferencePacketInput(input);
                input = undefined;

                if (!registered && !stopped) {
                    throw new Error('multiplex session not registered');
                }

                entered = true;
                const handle = sendHandle;
                deadline = Math.min(leaseDeadline, performance.now() + prepared.timeoutMs);

                if (
                    !handle ||
                    typeof handle.requestPacket !== 'function' ||
                    !registered ||
                    expected !== undefined ||
                    claim !== undefined ||
                    !live(current) ||
                    !busy ||
                    !sendGate ||
                    runId !== currentRun ||
                    operation !== 'request-packet' ||
                    sendHandle !== handle ||
                    owner!.getState() !== 'success' ||
                    referenceKeyState(token) !== 'active'
                ) {
                    throw new WtReferencePacketError(
                        prepared.command,
                        progress,
                        'operation-stopped',
                    );
                }

                sendVerified = false;
                response = await handle.requestPacket(prepared, currentRun, deadline, progress);
                const fields = sendRecord(response, [
                    'status',
                    'command',
                    'sequence',
                    'retCode',
                    'body',
                    'writeState',
                ]);
                const responseExpected = currentExpected();

                if (
                    fields.status !== 'response' ||
                    fields.command !== prepared.command ||
                    fields.retCode !== 0 ||
                    fields.writeState !== 'written' ||
                    isProxy(fields.body) ||
                    !isUint8Array(fields.body) ||
                    !sendVerified ||
                    !responseExpected ||
                    responseExpected.command !== prepared.command ||
                    responseExpected.sequence !== fields.sequence ||
                    responseExpected.packetOperation?.run !== currentRun ||
                    responseExpected.packetOperation.command !== prepared.command ||
                    !live(current) ||
                    currentExpected() !== responseExpected ||
                    !busy ||
                    !sendGate ||
                    runId !== currentRun ||
                    operation !== 'request-packet' ||
                    sendHandle !== handle ||
                    referenceKeyState(token) !== 'active' ||
                    owner!.getState() !== 'success' ||
                    performance.now() >= deadline
                ) {
                    throw new WtReferencePacketError(
                        prepared.command,
                        progress,
                        'operation-stopped',
                    );
                }

                return response;
            } catch (error) {
                disposeReferencePacketResult(response);
                response = undefined;

                if (entered) {
                    closeAll();
                    throw error instanceof WtReferencePacketError
                        ? error
                        : new WtReferencePacketError(
                              prepared!.command,
                              progress,
                              'operation-stopped',
                          );
                }

                throw error;
            } finally {
                disposePreparedReferencePacket(prepared);
                const owned = runId === currentRun;

                if (owned) {
                    expected = undefined;
                    operation = undefined;
                    runId = undefined;
                    sendVerified = false;
                    busy = false;
                    sendGate = false;
                }

                if (stopped) {
                    disposeAbortListener();
                }

                if (response) {
                    let failed = false;

                    try {
                        if (owned && registered && queue.length && live(current)) {
                            drain();
                        }

                        const now = performance.now();

                        if (
                            !owned ||
                            now >= deadline ||
                            now >= leaseDeadline ||
                            signal?.aborted ||
                            stopped ||
                            generation !== current ||
                            externallyStopped ||
                            externalEpoch !== startExternalEpoch ||
                            streamClient.closed ||
                            referenceKeyState(token) !== 'active'
                        ) {
                            failed = true;
                        }
                    } catch {
                        failed = true;
                    }

                    if (failed) {
                        disposeReferencePacketResult(response);
                        closeAll();
                        // eslint-disable-next-line no-unsafe-finally -- Raw body ownership transfers only after the final delivery fence.
                        throw new WtReferencePacketError(
                            prepared!.command,
                            progress,
                            'operation-stopped',
                        );
                    }
                }
            }
        };

        const common = {
            whenClosed: streamClient.whenClosed,
            sendText,
            friendRequest,
            requestPacket,
            heartbeat: () => run('heartbeat', () => owner!.heartbeat()),
            alive: () => run('alive', () => owner!.alive()),
            refreshTickets: async (options?: WtRefreshTicketsOptions) => {
                const snapshot = snapshotRefreshOptions(options);
                return run('refresh-tickets', () => owner!.refreshTickets(snapshot));
            },
            close: stopExternally,
        };

        if (restored) {
            const restoredOwner = owner as WtRestoredSession;
            return Object.freeze({
                ...common,
                getState: () => {
                    live();
                    return restoredOwner.getState();
                },
                restoreAndRegister: () =>
                    run('restore-register', () => restoredOwner.restoreAndRegister()),
            });
        }

        const qrOwner = owner as WtReferenceSession;
        return Object.freeze({
            ...common,
            getState: () => {
                live();
                return qrOwner.getState();
            },
            fetch: (fields: Parameters<WtReferenceSession['fetch']>[0]) =>
                run('fetch', () => qrOwner.fetch(fields)),
            poll: () => run('poll', () => qrOwner.poll()),
            loginAndRegister: (fields: Parameters<WtReferenceSession['loginAndRegister']>[0]) =>
                run('login-register', () => qrOwner.loginAndRegister(fields)),
        });
    } catch (error) {
        closeAll();
        throw error;
    }
}
