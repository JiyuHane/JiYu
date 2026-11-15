import { addAbortListener } from 'node:events';
import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import type { SsoReferenceRegisterBorrowedOptions } from './sso-reference-register-flow';
import type { Sso12RawOptions, Sso12RawResult, Sso12RawTransport } from './sso12-packet-client';
import { guardBorrowedTransport } from './guard-raw-transaction';
import { decodeServiceResponse, encodeServiceRequest } from './service-frame';
import { decodeSsoResponse, encodeSso12Request } from './sso';
import {
    decodeSsoUnregisterReference,
    encodeSsoUnregisterReference,
    SSO_UNREGISTER_REFERENCE_COMMAND,
    type SsoUnregisterObservation,
} from './sso-unregister';

export interface SsoReferenceUnregisterOptions {
    login: SsoReferenceRegisterBorrowedOptions['login'];
    profile: SsoReferenceRegisterBorrowedOptions['profile'];
    /** Internal owner-projected UID; never an external account selection. */
    uid: string;
    timeoutMs: number;
    /** Limit only the decoded retCode-zero protobuf body, not frame size or peak memory. */
    maxResponseBodyBytes: number;
    signal?: AbortSignal;
    buildReserved: SsoReferenceRegisterBorrowedOptions['buildReserved'];
    verifyRaw: SsoReferenceRegisterBorrowedOptions['verifyRaw'];
}

export type SsoUnregisterOutcome =
    | { status: 'sso-error'; retCode: number }
    | { status: 'observed'; message: SsoUnregisterObservation };
export type SsoReferenceUnregisterResult = Sso12RawResult<SsoUnregisterOutcome>;

const MAX_FIELD = 65535;
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
        throw new TypeError('invalid unregister configuration');
    }

    const prototype = Object.getPrototypeOf(value) as unknown;

    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('invalid unregister configuration');
    }

    const keys = Reflect.ownKeys(value);

    if (keys.length > 32) {
        throw new TypeError('invalid unregister configuration');
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
            throw new TypeError('invalid unregister configuration');
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

function nonemptyText(value: unknown, max: number): value is string {
    return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max;
}

/**
 * One borrowed exchange, with callback order and candidate bytes checked locally.
 * The owner supplies exclusive transport, cross-call single-flight, lifecycle and
 * poisoning on failure, including guard rejection after broker success. This helper
 * has no cross-call lock; even the transport getter can reenter. Broker quiescence
 * is an owner contract, not a fact established here. The signer returns complete
 * opaque reserved bytes. The verifier is local policy, not proof of signature,
 * peer authentication or an actual write. Local policy requires login.uin to be a
 * canonical positive decimal at most 0xffffffff and to exactly match the transport's
 * self-reported UIN. This match does not authenticate a peer; the WT raw UIN-zero
 * capability is not wired here. An observed message is not business success or online
 * state. A never-settling
 * transport can leave this helper pending indefinitely; deadlines and abort do not
 * forcibly stop transport or callback effects. An owner broker may bound its own
 * wait and poison its lease, not cancel external effects.
 * RetCode-zero protobuf decoding alone uses maxResponseBodyBytes. Framing and SSO
 * decompression happen first under their own limits, including on nonzero retCode;
 * the protobuf cap is neither a total frame nor peak-memory bound. Wiping of bytes
 * owned and reachable by this flow is best effort: callback-owned copies, codec
 * intermediates, strings, runtime memory and arbitrary same-process effects remain
 * outside its guarantees. JavaScript intrinsics are assumed trustworthy.
 */
export async function referenceUnregisterOnTransport(
    transport: Sso12RawTransport,
    options: SsoReferenceUnregisterOptions,
): Promise<SsoReferenceUnregisterResult> {
    const started = performance.now();
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
    };

    try {
        const input = record(options, [
            'login',
            'profile',
            'uid',
            'timeoutMs',
            'maxResponseBodyBytes',
            'signal',
            'buildReserved',
            'verifyRaw',
        ]);
        const login = record(input.login, ['status', 'uin', 'tickets', 'uidProjection']);
        const tickets = record(login.tickets, ['d2', 'd2Key', 'a1', 'a2']);
        const profile = record(input.profile, ['subAppId', 'guid', 'version']);

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
        const signer = input.buildReserved as SsoReferenceUnregisterOptions['buildReserved'];
        const verifier = input.verifyRaw as SsoReferenceUnregisterOptions['verifyRaw'];
        const maxResponseBodyBytes = input.maxResponseBodyBytes;

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
            !Number.isInteger(maxResponseBodyBytes) ||
            (maxResponseBodyBytes as number) < 0 ||
            (maxResponseBodyBytes as number) > 65536 ||
            typeof signer !== 'function' ||
            isProxy(signer) ||
            typeof verifier !== 'function' ||
            isProxy(verifier)
        ) {
            throw new TypeError('invalid unregister configuration');
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

        const result = await guardBorrowedTransport<null, SsoUnregisterOutcome>(stable)({
            timeoutMs: remaining,
            signal: controller.signal,
            buildRequest: async (identity) => {
                let body: Uint8Array | undefined;
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

                    if (identity.uin !== uin) {
                        throw new Error('invalid transaction identity');
                    }

                    body = encodeSsoUnregisterReference();
                    owned.push(body);
                    signerInput = Uint8Array.from(body);
                    owned.push(signerInput);
                    const signed = await signer({
                        uin,
                        uid,
                        sequence: identity.sequence,
                        command: SSO_UNREGISTER_REFERENCE_COMMAND,
                        body: signerInput,
                    });
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
                        command: SSO_UNREGISTER_REFERENCE_COMMAND,
                        guid: localGuid,
                        version,
                        reserved: copy(metadata),
                        body: copy(body),
                    });
                    assertActive();
                    requestFrame = encodeServiceRequest({
                        protocol: 12,
                        uin,
                        encryption: { type: 'd2', key: localKey },
                        d2: localD2,
                        body: copy(inner),
                    });
                    assertActive();
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
                    const accepted = await verifier({
                        uin,
                        sequence: identity.sequence,
                        command: SSO_UNREGISTER_REFERENCE_COMMAND,
                        requestFrame: requestCopy,
                        responseFrame: responseCopy,
                    });
                    assertActive();
                    return accepted === true;
                } finally {
                    wipe(requestCopy);
                    wipe(responseCopy);
                }
            },
            consumeCandidate: (candidate, _context, identity) => {
                assertActive();
                const outer = decodeServiceResponse(candidate, key);

                try {
                    const response = decodeSsoResponse(outer.body);

                    try {
                        if (
                            outer.protocol !== 12 ||
                            outer.encryption !== 'd2' ||
                            outer.uin !== uin ||
                            response.sequence >>> 0 !== identity.sequence ||
                            response.command !== SSO_UNREGISTER_REFERENCE_COMMAND
                        ) {
                            throw new Error('invalid binding');
                        }

                        if (response.retCode !== 0) {
                            return { status: 'sso-error', retCode: response.retCode };
                        }

                        return {
                            status: 'observed',
                            message: decodeSsoUnregisterReference(
                                response.body,
                                maxResponseBodyBytes as number,
                            ),
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
    }
}
