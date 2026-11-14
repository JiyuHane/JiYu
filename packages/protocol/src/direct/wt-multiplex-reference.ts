import { addAbortListener } from 'node:events';
import { isProxy } from 'node:util/types';
import type { RawMultiplexPushRoute } from './raw-multiplex-client';
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
    type WtReferenceSession,
    type WtReferenceSessionOptions,
} from './wt-reference-session';
import {
    createReferenceKeyCapability,
    consumeReferenceBusinessFailure,
    decodeReferenceFrame,
    decodeReferencePushBody,
    referenceExpectedUin,
    referenceKeyState,
    revokeReferenceKey,
    takeReferenceExactBusinessFailure,
} from './wt-reference-session-private';
import type { Sso12CloseReason, Sso12RawClient } from './sso12-packet-client';

const PUSH_COMMAND = 'trpc.msg.olpush.OlPushService.MsgPush';
const MAX_TIMER = 0x7fffffff;
const nativeFill = Uint8Array.prototype.fill;
type PushMeta = Readonly<{ uin: string; sequence: number; command: string }>;
type Operation = 'fetch' | 'poll' | 'login-register' | 'heartbeat' | 'alive';

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
}

/**
 * Owns an already-established injected stream. No connection is created or probed.
 * V2's known push service command is prioritized over sequence-only response routing:
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
    const profileUin = sessionOptions.profile.uin;
    const qrCommand = sessionOptions.profile.qrCommand;
    const loginCommand = sessionOptions.profile.loginCommand;
    const wtSigner = sessionOptions.buildWtReserved;
    const registerSigner = sessionOptions.buildRegisterReserved;
    const token = createReferenceKeyCapability();
    let expected:
        | {
              uin: string;
              sequence: number;
              command: string;
              protocol: 12 | 13;
              encryption: 'zero' | 'd2' | 'none';
              hold: boolean;
          }
        | undefined;
    let mux: RawMultiplexStreamClient | undefined;
    let lease: RawSessionLease | undefined;
    let owner: WtReferenceSession | undefined;
    let operation: Operation | undefined;
    let busy = false;
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
    const queue: Array<{ frame: Uint8Array; size: number; meta: PushMeta }> = [];

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
        revokeReferenceKey(token);
        wipe(activeCopy);
        wipe(activeBody);

        for (const copy of verificationCopies) {
            wipe(copy);
        }

        verificationCopies.clear();

        for (const item of queue.splice(0)) {
            wipe(item.frame);
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
        let hold = false;

        if (wt && (operation === 'fetch' || operation === 'poll') && keyState === 'empty') {
            uin = profileUin;
            command = qrCommand;
            encryption = 'zero';
            hold = operation === 'poll';
        } else if (wt && operation === 'login-register' && keyState === 'empty') {
            uin = confirmed;
            command = loginCommand;
            encryption = 'zero';
            hold = true;
        } else if (!wt && operation === 'login-register' && keyState === 'tentative') {
            uin = confirmed;
            command = SSO_INFO_SYNC_COMMAND;
        } else if (!wt && operation === 'heartbeat' && keyState === 'active') {
            uin = confirmed;
            command = SSO_HEARTBEAT_COMMAND;
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

        const next = { uin, sequence: input.sequence, command, protocol, encryption, hold };
        expected = next;
        return next;
    };

    const drain = (): void => {
        if (delivering || !registered || !live()) {
            return;
        }

        delivering = true;
        const current = generation;
        setImmediate(() => {
            void (async () => {
                let turns = 0;

                try {
                    while (registered && live(current) && queue.length) {
                        if (++turns === 32) {
                            turns = 0;
                            await new Promise<void>((resolve) => setImmediate(resolve));

                            if (!live(current)) {
                                break;
                            }
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
                                const decoded = decodeReferencePushBody(
                                    token,
                                    item.frame,
                                    transportUin,
                                    item.meta,
                                    maxPushBodyBytes!,
                                );
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

                    if (registered && queue.length && live(current)) {
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

                    if (decoded.command === PUSH_COMMAND) {
                        if (
                            !confirmed ||
                            decoded.uin !== confirmed ||
                            protocol !== 12 ||
                            decoded.encryption !== 'd2'
                        ) {
                            return { kind: 'reject' };
                        }

                        return { kind: 'push', name: PUSH_COMMAND, id: decoded.sequence };
                    }

                    const request = expected;
                    return request !== undefined &&
                        identity.sequence === request.sequence &&
                        decoded.sequence === request.sequence &&
                        decoded.uin === request.uin &&
                        decoded.command === request.command &&
                        decoded.encryption === request.encryption &&
                        protocol === request.protocol
                        ? { kind: 'response', sequence: decoded.sequence }
                        : { kind: 'reject' };
                } catch {
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
                    route.name === PUSH_COMMAND &&
                    referenceKeyState(token) !== 'empty'
                );
            },
            onPush(frame, route: RawMultiplexPushRoute) {
                const uin = referenceExpectedUin(token);

                if (
                    !live() ||
                    !uin ||
                    route.name !== PUSH_COMMAND ||
                    queue.length + (activeCopy ? 1 : 0) >= maxPushFrames ||
                    queuedBytes + frame.length > maxPushBytes
                ) {
                    throw new Error('push capacity or stopped');
                }

                const copy = Uint8Array.from(frame);
                queuedBytes += copy.length;
                queue.push({
                    frame: copy,
                    size: copy.length,
                    meta: Object.freeze({ uin, sequence: route.id, command: route.name }),
                });
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
        owner = createWtReferenceSessionWithCapability(
            lease,
            {
                ...sessionOptions,
                signal,
                buildWtReserved: async (input) => {
                    const current = generation;
                    const request = makeExpected(input, true);
                    const result = await wtSigner(input);

                    if (!live(current) || expected !== request) {
                        throw new Error('signer stopped');
                    }

                    return result;
                },
                buildRegisterReserved: async (input) => {
                    const current = generation;
                    const request = makeExpected(input, false);
                    const result = await registerSigner(input);

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
            if (!live() || busy || inCallback) {
                throw new Error('multiplex session busy or stopped');
            }

            busy = true;
            operation = next;
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
                const businessFailure =
                    (next === 'poll' &&
                        (status === 'expired' ||
                            status === 'canceled' ||
                            status === 'invalid' ||
                            status === 'unknown')) ||
                    (next === 'login-register' &&
                        (status === 'verification-required' ||
                            status === 'nonzero' ||
                            status === 'incomplete' ||
                            status === 'error' ||
                            status === 'rejected' ||
                            status === 'missing-result' ||
                            status === 'sso-error')) ||
                    ((next === 'heartbeat' || next === 'alive') && status === 'sso-error');

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

                if (next === 'login-register') {
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

        return Object.freeze({
            whenClosed: streamClient.whenClosed,
            getState: () => {
                live();
                return owner!.getState();
            },
            fetch: (fields: Parameters<WtReferenceSession['fetch']>[0]) =>
                run('fetch', () => owner!.fetch(fields)),
            poll: () => run('poll', () => owner!.poll()),
            loginAndRegister: (fields: Parameters<WtReferenceSession['loginAndRegister']>[0]) =>
                run('login-register', () => owner!.loginAndRegister(fields)),
            heartbeat: () => run('heartbeat', () => owner!.heartbeat()),
            alive: () => run('alive', () => owner!.alive()),
            close: stopExternally,
        });
    } catch (error) {
        closeAll();
        throw error;
    }
}
