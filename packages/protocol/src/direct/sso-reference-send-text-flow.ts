import { addAbortListener } from 'node:events';
import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import type { SsoReferenceRegisterBorrowedOptions } from './sso-reference-register-flow';
import type { Sso12RawOptions, Sso12RawResult, Sso12RawTransport } from './sso12-packet-client';
import { guardBorrowedTransport } from './guard-raw-transaction';
import { decodeServiceResponse, encodeServiceRequest } from './service-frame';
import { decodeSsoResponse, encodeSso12Request } from './sso';
import {
    encodeDirectSendMessageRequest,
    type DirectSendMessageRequestInput,
} from './send-message-request';
import {
    decodeDirectSendMessageResponse,
    type DirectSendMessageResponseProjection,
} from './send-message-response';

export interface SsoReferenceSendTextOptions {
    login: SsoReferenceRegisterBorrowedOptions['login'];
    profile: SsoReferenceRegisterBorrowedOptions['profile'];
    uid: string;
    request: DirectSendMessageRequestInput;
    /** Post-decompression response business-body acceptance limit, 0 through 65536. */
    maxResponseBodyBytes: number;
    timeoutMs: number;
    signal?: AbortSignal;
    buildReserved: SsoReferenceRegisterBorrowedOptions['buildReserved'];
    verifyRaw: SsoReferenceRegisterBorrowedOptions['verifyRaw'];
}

export type SsoSendTextOutcome =
    | { status: 'response'; response: DirectSendMessageResponseProjection }
    | { status: 'sso-error'; retCode: number };
export type SsoReferenceSendTextResult = Sso12RawResult<SsoSendTextOutcome>;

const MAX_FIELD = 65535;
const MAX_BODY = 64 * 1024;
const COMMAND = 'MessageSvc.PbSendMsg';
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const length = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const offset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const values = Uint8Array.prototype.values;
const fill = Uint8Array.prototype.fill;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;

function wipe(value: Uint8Array | undefined): void {
    if (value) {
        try {
            fill.call(value, 0);
        } catch {
            /* Detached callback copies are best effort. */
        }
    }
}

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        throw new TypeError('invalid send-text configuration');
    }

    const prototype = Object.getPrototypeOf(value) as unknown;

    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('invalid send-text configuration');
    }

    const keys = Reflect.ownKeys(value);

    if (keys.length > 32) {
        throw new TypeError('invalid send-text configuration');
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
            throw new TypeError('invalid send-text configuration');
        }

        result[key] = descriptor.value;
    }

    return result;
}

// Inspect a capability signal without consulting caller-provided accessors or proxy traps.
function preflightSignal(value: unknown): boolean {
    if (
        isProxy(value) ||
        typeof value !== 'object' ||
        value === null ||
        Object.getPrototypeOf(value) !== AbortSignal.prototype ||
        Object.hasOwn(value, 'aborted') ||
        Object.hasOwn(value, 'addEventListener') ||
        Object.hasOwn(value, 'removeEventListener')
    ) {
        throw new TypeError('invalid signal');
    }

    try {
        return aborted.call(value) as boolean;
    } catch {
        throw new TypeError('invalid signal');
    }
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

function nonemptyText(value: unknown, max: number): value is string {
    return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max;
}

/**
 * Reference-only borrowed transaction for synthetic transports and login fixtures.
 * Transport allocates the outer sequence; the protobuf clientSequence is independent.
 * This flow requires transport identity UIN to exactly equal login UIN as local policy;
 * unlike borrowed registration it does not accept a transport UIN of '0' for another
 * account. Callers must supply a transport bound to the target account; this local
 * equality check does not authenticate the peer.
 * Callback metadata is opaque local policy, not proof of signing or binding. The
 * verification policy does not authenticate a peer. A response, including result zero,
 * is not evidence of delivery or acceptance. Response errMsg is untrusted text and may
 * contain sensitive data; callers own its confidentiality. This function does not log it.
 * Response projection uses Proton's UTF-8 replacement decoding for errMsg, not raw wire
 * bytes, and known field numbers with wrong wire types are discarded as unknown fields.
 * The response clientSequence is not compared to the request's clientSequence.
 * maxResponseBodyBytes is a post-decompression acceptance limit: decodeSsoResponse can
 * first inflate up to its fixed 16 MiB limit, even for a nonzero SSO return code.
 * On this public entry, reading transport.transactRaw happens before the options
 * snapshot and can invoke a getter with side effects, including mutation of options.
 * The owner controls exclusivity, transport settlement and poisoning, including an outer
 * guard rejection after a broker reports success. Non-settling transports and callbacks
 * may outlive the deadline; external callback effects and retained copies remain theirs.
 * Cleanup is best effort and does not promise erasure of codec-internal pooled allocations.
 */
export function referenceSendTextOnTransport(
    transport: Sso12RawTransport,
    options: SsoReferenceSendTextOptions,
): Promise<SsoReferenceSendTextResult> {
    if (new.target) {
        throw new TypeError('referenceSendTextOnTransport is not a constructor');
    }

    return sendTextCore(transport, options);
}

/** Deep internal composition only; capability coordination is not peer authentication. */
export function referenceSendTextWithCapability(
    capability: { token: object; attempt: object; lease: Sso12RawTransport; run: object },
    options: SsoReferenceSendTextOptions,
): Promise<SsoReferenceSendTextResult> {
    return sendTextCore(undefined, options, capability);
}

async function sendTextCore(
    suppliedTransport: Sso12RawTransport | undefined,
    options: SsoReferenceSendTextOptions,
    capability?: { token: object; attempt: object; lease: Sso12RawTransport; run: object },
): Promise<SsoReferenceSendTextResult> {
    const started = performance.now();
    let binding:
        { token: object; attempt: object; lease: Sso12RawTransport; run: object } | undefined;
    let transport = suppliedTransport;
    let capabilityInput: Record<string, unknown> | undefined;

    if (capability !== undefined) {
        const input = record(capability, ['token', 'attempt', 'lease', 'run']);
        binding = {
            token: input.token as object,
            attempt: input.attempt as object,
            lease: input.lease as Sso12RawTransport,
            run: input.run as object,
        };
        transport = binding.lease;
        const preflight = record(options, [
            'login',
            'profile',
            'uid',
            'request',
            'maxResponseBodyBytes',
            'timeoutMs',
            'signal',
            'buildReserved',
            'verifyRaw',
        ]);

        // The clock can synchronously close the owner and abort its signal.
        // This early result precedes capability ownership validation.
        if (preflight.signal !== undefined) {
            if (preflightSignal(preflight.signal)) {
                return { kind: 'failure', code: 'raw-cancelled', writeState: 'not-written' };
            }

            capabilityInput = preflight;
        }
    }

    let method: Sso12RawTransport['transactRaw'];

    try {
        if (!transport || isProxy(transport)) {
            throw new TypeError();
        }

        method = transport.transactRaw;

        if (typeof method !== 'function' || isProxy(method)) {
            throw new TypeError();
        }
    } catch {
        throw new TypeError('invalid borrowed transport');
    }

    // The getter itself may abort or alter the caller's options. Check the
    // captured signal again before any transaction or callback is entered.
    if (capabilityInput?.signal !== undefined && preflightSignal(capabilityInput.signal)) {
        return { kind: 'failure', code: 'raw-cancelled', writeState: 'not-written' };
    }

    const stable: Sso12RawTransport = {
        transactRaw<C, T>(rawOptions: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
            return Reflect.apply(method, transport, [rawOptions]) as Promise<Sso12RawResult<T>>;
        },
    };
    const owned: Uint8Array[] = [];
    let requestFrame: Uint8Array | undefined;
    let signal: AbortSignal | undefined;
    let abortListener: ReturnType<typeof addAbortListener> | undefined;
    let active = true;
    let timeout = 0;
    let privateSession: typeof import('./wt-reference-session-private') | undefined;
    let begun = false;
    let actualUin: string | undefined;
    const controller = new AbortController();
    const abort = (): void => controller.abort();

    const assertActive = (): void => {
        if (
            !active ||
            controller.signal.aborted ||
            (signal && aborted.call(signal)) ||
            performance.now() >= started + timeout
        ) {
            throw new Error('transaction stopped');
        }

        // The clock above can synchronously abort while still returning an
        // in-range time. Do not enter a capability callback after that reentry.
        if (binding && (!active || controller.signal.aborted || (signal && aborted.call(signal)))) {
            throw new Error('transaction stopped');
        }
    };

    try {
        const input =
            capabilityInput ??
            record(options, [
                'login',
                'profile',
                'uid',
                'request',
                'maxResponseBodyBytes',
                'timeoutMs',
                'signal',
                'buildReserved',
                'verifyRaw',
            ]);
        const login = record(input.login, ['status', 'uin', 'tickets', 'uidProjection']);
        const tickets = record(login.tickets, ['d2', 'd2Key', 'a1', 'a2']);
        const profile = record(input.profile, ['subAppId', 'guid', 'version']);
        const request = record(input.request, ['route', 'text', 'clientSequence', 'random']);
        request.route = record(request.route, ['kind', 'peerUin', 'peerUid', 'groupUin']);
        const maxResponseBodyBytes = input.maxResponseBodyBytes;

        const take = (value: unknown, max: number): Uint8Array => {
            const copy = copyBytes(value, max);
            owned.push(copy);
            return copy;
        };

        const guid = take(profile.guid, MAX_FIELD);
        const d2 = take(tickets.d2, MAX_FIELD);
        const key = take(tickets.d2Key, 16);
        const a2 = take(tickets.a2, MAX_FIELD);
        const a1 = take(tickets.a1, MAX_FIELD);
        wipe(a1);
        const uin = login.uin;
        const uid = input.uid;
        const version = profile.version;
        const subAppId = profile.subAppId;
        timeout = input.timeoutMs as number;
        const signer = input.buildReserved as SsoReferenceSendTextOptions['buildReserved'];
        const verifier = input.verifyRaw as SsoReferenceSendTextOptions['verifyRaw'];

        if (
            login.status !== 'tickets' ||
            typeof uin !== 'string' ||
            !/^[1-9][0-9]{0,18}$/.test(uin) ||
            BigInt(uin) > 0xffffffffn ||
            !guid.length ||
            !d2.length ||
            key.length !== 16 ||
            !nonemptyText(uid, 4096) ||
            !nonemptyText(version, 0xfffd) ||
            !Number.isInteger(subAppId) ||
            (subAppId as number) < 0 ||
            (subAppId as number) > 0x7fffffff ||
            !Number.isInteger(timeout) ||
            timeout < 1 ||
            timeout > 0x7fffffff ||
            typeof maxResponseBodyBytes !== 'number' ||
            !Number.isSafeInteger(maxResponseBodyBytes) ||
            maxResponseBodyBytes < 0 ||
            maxResponseBodyBytes > MAX_BODY ||
            typeof signer !== 'function' ||
            isProxy(signer) ||
            typeof verifier !== 'function' ||
            isProxy(verifier)
        ) {
            throw new TypeError('invalid send-text configuration');
        }

        if (input.signal !== undefined) {
            if (
                isProxy(input.signal) ||
                typeof input.signal !== 'object' ||
                input.signal === null ||
                Object.getPrototypeOf(input.signal) !== AbortSignal.prototype ||
                Object.hasOwn(input.signal, 'aborted') ||
                Object.hasOwn(input.signal, 'addEventListener') ||
                Object.hasOwn(input.signal, 'removeEventListener')
            ) {
                throw new TypeError('invalid signal');
            }

            try {
                aborted.call(input.signal);
            } catch {
                throw new TypeError('invalid signal');
            }

            signal = input.signal as AbortSignal;
            abortListener = addAbortListener(signal, abort);

            if (aborted.call(signal)) {
                abort();
            }
        }

        if (performance.now() >= started + timeout) {
            controller.abort();
        }

        if (controller.signal.aborted) {
            return {
                kind: 'failure',
                code: signal && aborted.call(signal) ? 'raw-cancelled' : 'raw-timeout',
                writeState: 'not-written',
            };
        }

        let body: Uint8Array;

        try {
            body = encodeDirectSendMessageRequest(
                request as unknown as DirectSendMessageRequestInput,
            );
        } catch {
            throw new TypeError('invalid send-text request');
        }

        owned.push(body);

        if (body.byteLength > MAX_BODY) {
            throw new RangeError('send-text request exceeds size limit');
        }

        if (binding) {
            privateSession = await import('./wt-reference-session-private');

            if (performance.now() >= started + timeout) {
                controller.abort();
            }

            if (controller.signal.aborted) {
                return {
                    kind: 'failure',
                    code: signal && aborted.call(signal) ? 'raw-cancelled' : 'raw-timeout',
                    writeState: 'not-written',
                };
            }

            privateSession.beginReferenceSend(
                binding.token,
                binding.attempt,
                binding.lease,
                binding.run,
            );
            begun = true;
        }

        const assertBinding = (identityUin: string): void => {
            if (binding && privateSession) {
                privateSession.assertReferenceSendIdentity(
                    binding.token,
                    binding.attempt,
                    binding.lease,
                    binding.run,
                    identityUin,
                    uin,
                );
                privateSession.assertReferenceSendKey(
                    binding.token,
                    binding.attempt,
                    binding.lease,
                    binding.run,
                    key,
                );
            } else if (identityUin !== uin) {
                throw new Error('invalid transport identity');
            }
        };

        const remaining = Math.max(1, Math.ceil(started + timeout - performance.now()));

        if (performance.now() >= started + timeout) {
            controller.abort();
        }

        if (controller.signal.aborted) {
            return {
                kind: 'failure',
                code: signal && aborted.call(signal) ? 'raw-cancelled' : 'raw-timeout',
                writeState: 'not-written',
            };
        }

        const result = await guardBorrowedTransport<null, SsoSendTextOutcome>(stable)({
            timeoutMs: remaining,
            signal: controller.signal,
            buildRequest: async (identity) => {
                let signerInput: Uint8Array | undefined;
                let metadata: Uint8Array | undefined;
                let inner: Uint8Array | undefined;
                const local: Uint8Array[] = [];

                const copy = (source: Uint8Array): Uint8Array => {
                    const result = Uint8Array.from(source);
                    local.push(result);
                    return result;
                };

                try {
                    assertActive();

                    assertBinding(identity.uin);
                    actualUin = identity.uin;
                    signerInput = Uint8Array.from(body);
                    owned.push(signerInput);
                    let signed: Uint8Array;

                    try {
                        signed = await signer({
                            uin,
                            uid,
                            sequence: identity.sequence,
                            command: COMMAND,
                            body: signerInput,
                        });
                    } finally {
                        if (binding) {
                            assertBinding(identity.uin);
                        }
                    }

                    assertActive();
                    metadata = copyBytes(signed, MAX_FIELD);
                    const localGuid = copy(guid),
                        localKey = copy(key),
                        localD2 = copy(d2),
                        localA2 = copy(a2);
                    assertActive();
                    inner = encodeSso12Request({
                        sequence: identity.sequence | 0,
                        subAppId: subAppId as number,
                        a2: localA2,
                        command: COMMAND,
                        guid: localGuid,
                        version,
                        reserved: metadata,
                        body,
                    });
                    requestFrame = encodeServiceRequest({
                        protocol: 12,
                        uin,
                        encryption: { type: 'd2', key: localKey },
                        d2: localD2,
                        body: inner,
                    });
                    assertActive();

                    if (binding) {
                        assertBinding(identity.uin);
                    }

                    return { frame: requestFrame, context: null };
                } finally {
                    [body, signerInput, metadata, inner, ...local].forEach(wipe);
                }
            },
            verifyCandidate: async (candidate, _context, identity) => {
                let requestCopy: Uint8Array | undefined;
                let responseCopy: Uint8Array | undefined;

                try {
                    assertActive();
                    requestCopy = Uint8Array.from(requestFrame!);
                    owned.push(requestCopy);
                    responseCopy = Uint8Array.from(candidate);
                    owned.push(responseCopy);

                    if (binding) {
                        assertBinding(identity.uin);
                    }

                    let accepted: boolean;

                    try {
                        accepted = await verifier({
                            uin,
                            sequence: identity.sequence,
                            command: COMMAND,
                            requestFrame: requestCopy,
                            responseFrame: responseCopy,
                        });
                    } finally {
                        if (binding) {
                            assertBinding(identity.uin);
                        }
                    }

                    assertActive();
                    return accepted === true;
                } finally {
                    wipe(requestCopy);
                    wipe(responseCopy);
                }
            },
            consumeCandidate: (candidate, _context, identity) => {
                assertActive();

                if (binding) {
                    assertBinding(identity.uin);
                }

                const outer = decodeServiceResponse(candidate, key);

                try {
                    if (outer.protocol !== 12 || outer.encryption !== 'd2' || outer.uin !== uin) {
                        throw new Error('invalid envelope');
                    }

                    const response = decodeSsoResponse(outer.body);

                    try {
                        if (
                            response.sequence >>> 0 !== identity.sequence ||
                            response.command !== COMMAND
                        ) {
                            throw new Error('invalid binding');
                        }

                        if (response.retCode !== 0) {
                            return { status: 'sso-error', retCode: response.retCode };
                        }

                        if (response.body.byteLength > maxResponseBodyBytes) {
                            throw new Error('response body exceeds size limit');
                        }

                        return {
                            status: 'response',
                            response: decodeDirectSendMessageResponse(response.body),
                        };
                    } finally {
                        [
                            response.body,
                            response.cookie,
                            response.reserved,
                            response.headerExtension,
                        ].forEach(wipe);
                    }
                } finally {
                    wipe(outer.body);

                    if (binding) {
                        assertBinding(identity.uin);
                    }
                }
            },
        });

        if (
            result.kind === 'response' &&
            (controller.signal.aborted ||
                (signal && aborted.call(signal)) ||
                performance.now() >= started + timeout)
        ) {
            return { kind: 'failure', code: 'borrowed-transaction-failed', writeState: 'unknown' };
        }

        if (binding && result.kind === 'response') {
            // The final clock read above may synchronously abort after the
            // preceding signal checks. Preserve uncertainty after a write.
            if (controller.signal.aborted || (signal && aborted.call(signal))) {
                return {
                    kind: 'failure',
                    code: 'borrowed-transaction-failed',
                    writeState: 'unknown',
                };
            }

            try {
                if (actualUin === undefined) {
                    throw new Error('invalid reference send binding');
                }

                assertBinding(actualUin);
            } catch {
                return {
                    kind: 'failure',
                    code: 'borrowed-transaction-failed',
                    writeState: 'unknown',
                };
            }
        }

        return result;
    } finally {
        active = false;

        if (abortListener) {
            try {
                abortListener[Symbol.dispose]();
            } catch {
                /* best effort */
            }
        }

        wipe(requestFrame);
        owned.forEach(wipe);

        if (begun && binding && privateSession) {
            try {
                privateSession.endReferenceSend(
                    binding.token,
                    binding.attempt,
                    binding.lease,
                    binding.run,
                );
            } catch {
                // A different run may now own the slot. Preserve it and deliberately
                // override any prior result or exception: after losing ownership the
                // caller must treat a write as uncertain. This is capability-only.
                // eslint-disable-next-line no-unsafe-finally -- uncertainty takes precedence over a prior result
                return {
                    kind: 'failure',
                    code: 'borrowed-transaction-failed',
                    writeState: 'unknown',
                };
            }
        }
    }
}
