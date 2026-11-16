import { timingSafeEqual } from 'node:crypto';
import { addAbortListener } from 'node:events';
import type { Socket } from 'node:net';
import { isProxy } from 'node:util/types';
import {
    Sso12PacketClient,
    type Sso12RawResult,
    type Sso12RawTransport,
    type Sso12RawOptions,
} from './sso12-packet-client';
import { decodeServiceResponse, encodeServiceRequest } from './service-frame';
import { decodeSsoResponse, encodeSso12Request } from './sso';
import {
    classifySsoRegisterResponse,
    encodeSsoRegisterReference,
    SSO_INFO_SYNC_COMMAND,
    type SsoRegisterOutcome,
} from './sso-register';
import { guardBorrowedTransport } from './guard-raw-transaction';
import type { WtReferenceLoginResult } from './wt-reference-login-attempt';

/** Synthetic reference exchange; neither the callback policy nor QQ-TEA authenticates a server. */
export interface SsoReferenceRegisterOptions {
    socket: Socket;
    login: Extract<WtReferenceLoginResult, { status: 'tickets' }>;
    profile: { subAppId: number; guid: Uint8Array; version: string };
    /** Registration build version is distinct from the SSO header version. GUID comes from profile. */
    registration: {
        uid: string;
        version: string;
        deviceName: string;
        deviceType: string;
        vendorOs: string;
        random: number;
    };
    sequence: number;
    timeoutMs: number;
    signal?: AbortSignal;
    buildReserved: (input: {
        uin: string;
        uid: string;
        sequence: number;
        command: string;
        body: Uint8Array;
    }) => Uint8Array | Promise<Uint8Array>;
    verifyRaw: (input: {
        uin: string;
        sequence: number;
        command: string;
        requestFrame: Uint8Array;
        responseFrame: Uint8Array;
    }) => boolean | Promise<boolean>;
}

/** Borrowed transports allocate the sequence; callers supply neither socket nor sequence. */
export type SsoReferenceRegisterBorrowedOptions = Omit<
    SsoReferenceRegisterOptions,
    'socket' | 'sequence'
>;

export type SsoReferenceRegisterResult = Sso12RawResult<SsoRegisterOutcome>;
const MAX_FIELD = 65535;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const lengthGetter = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const tagGetter = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const sharedGetter = Object.getOwnPropertyDescriptor(
    SharedArrayBuffer.prototype,
    'byteLength',
)!.get!;
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const values = Uint8Array.prototype.values;
const fill = Uint8Array.prototype.fill;

function assertSignerRequestUnchanged(
    request: Parameters<SsoReferenceRegisterOptions['buildReserved']>[0],
    uin: string,
    uid: string,
    sequence: number,
    body: Uint8Array,
    baseline: Uint8Array,
): void {
    const matches = (key: keyof typeof request, expected: unknown): boolean => {
        const descriptor = getOwnPropertyDescriptor(request, key);
        return !!descriptor && hasOwn(descriptor, 'value') && descriptor.value === expected;
    };

    try {
        if (
            !matches('uin', uin) ||
            !matches('uid', uid) ||
            !matches('command', SSO_INFO_SYNC_COMMAND) ||
            !matches('sequence', sequence) ||
            !matches('body', body)
        ) {
            throw new Error();
        }

        values.call(body);
        values.call(baseline);

        if (
            lengthGetter.call(body) !== lengthGetter.call(baseline) ||
            !timingSafeEqual(body, baseline)
        ) {
            throw new Error();
        }
    } catch {
        throw new Error('signer input changed');
    }
}

function wipe(value: Uint8Array | undefined): void {
    if (value) {
        try {
            fill.call(value, 0);
        } catch {
            /* Detached callback buffers are best effort. */
        }
    }
}

function record(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        throw new TypeError('invalid configuration');
    }

    const prototype = Object.getPrototypeOf(value) as unknown;

    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('invalid configuration');
    }

    const keys = Reflect.ownKeys(value);

    if (keys.length > 32) {
        throw new TypeError('invalid configuration');
    }

    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (typeof key !== 'string' || !descriptor || !('value' in descriptor)) {
            throw new TypeError('invalid configuration');
        }

        result[key] = descriptor.value;
    }

    return result;
}

function bytes(value: unknown, max: number): Uint8Array {
    if (isProxy(value) || !ArrayBuffer.isView(value) || tagGetter.call(value) !== 'Uint8Array') {
        throw new TypeError('invalid bytes');
    }

    values.call(value); // Throws on detached or out-of-bounds views.
    const size = lengthGetter.call(value) as number;

    if (size > max) {
        throw new TypeError('invalid bytes');
    }

    const storage = bufferGetter.call(value) as ArrayBuffer;

    try {
        sharedGetter.call(storage);
        throw new TypeError('shared bytes');
    } catch (error) {
        if (error instanceof TypeError && error.message === 'shared bytes') {
            throw error;
        }
    }

    const keys = Reflect.ownKeys(value);

    if (keys.length > size + 16) {
        throw new TypeError('invalid bytes');
    }

    for (const key of keys) {
        const d = Object.getOwnPropertyDescriptor(value, key);

        if (!d || !('value' in d)) {
            throw new TypeError('invalid bytes');
        }
    }

    return Uint8Array.from(new Uint8Array(storage, offsetGetter.call(value) as number, size));
}

function text(value: unknown, nonempty: boolean, max = 4096): value is string {
    return (
        typeof value === 'string' &&
        (!nonempty || value.length > 0) &&
        Buffer.byteLength(value) <= max
    );
}

/** One newly connected socket per call. Input validation precedes ownership transfer. */
export async function referenceRegister(
    options: SsoReferenceRegisterOptions,
): Promise<SsoReferenceRegisterResult> {
    return registerFlow(options, undefined, performance.now());
}

/**
 * Borrows a raw transport without closing or draining it. Its implementation owns
 * single-flight, actual writes and their effects. The local deadline and cancellation
 * settle this call, but do not establish that the underlying operation has stopped.
 * An untrusted transport can stall indefinitely, close itself on abort, or
 * misrepresent identity, candidate choice, writes and their effects. The observed
 * transport UIN need not match the login UIN; it is pinned across callbacks.
 * Session connection binding, sequence uniqueness and cross-transaction mutual
 * exclusion depend on the transport; no protection from arbitrary same-process
 * side effects is claimed. A stalled operation remains transport-owned and must
 * not be treated as released for another owner. Reuse requires the owner to
 * trust successful settlement means callbacks have ceased, and to enforce
 * exclusivity and sequence/write semantics. Late external effects remain the
 * transport's responsibility. Borrowed transport failure codes are normalized;
 * ordinary transport failures retain their validated writeState. Local cancellation
 * or timeout after invocation conservatively reports unknown, not transport silence.
 * Callback and byte binding is checked
 * locally, not server authentication or a claim about any real server or runtime.
 * Reading the transport method can run a getter; awaiting its result can access
 * a thenable's `then`. These and their external effects belong to the transport
 * trust boundary. No automatic retry is performed.
 */
export async function referenceRegisterOnTransport(
    transport: Sso12RawTransport,
    options: SsoReferenceRegisterBorrowedOptions,
): Promise<SsoReferenceRegisterResult> {
    const started = performance.now();

    let method: Sso12RawTransport['transactRaw'];

    try {
        if (!transport || isProxy(transport)) {
            throw new TypeError();
        }

        method = transport.transactRaw;

        if (typeof method !== 'function') {
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

    return registerFlow(options, stable, started);
}

async function registerFlow(
    options: SsoReferenceRegisterOptions | SsoReferenceRegisterBorrowedOptions,
    borrowed: Sso12RawTransport | undefined,
    started: number,
): Promise<SsoReferenceRegisterResult> {
    // On settlement every outstanding callback copy is wiped; callbacks still running
    // may observe that cleanup. External callback side effects cannot be cancelled.
    const owned: Uint8Array[] = [];
    let client: Sso12PacketClient | undefined;
    let active = true;
    let requestFrame: Uint8Array | undefined;
    let signal: AbortSignal | undefined;
    let abortListener: ReturnType<typeof addAbortListener> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let invoked = false;
    let stopCode: 'raw-cancelled' | 'raw-timeout' | undefined;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    let resolveStopped!: (result: SsoReferenceRegisterResult) => void;
    const stopped = new Promise<SsoReferenceRegisterResult>((resolve) => {
        resolveStopped = resolve;
    });

    const stop = (code: 'raw-cancelled' | 'raw-timeout'): void => {
        if (!active || stopCode) {
            return;
        }

        active = false;
        stopCode = code;
        // Resolve before abort dispatch: a transport may synchronously reenter here.
        resolveStopped({
            kind: 'failure',
            code: invoked ? 'borrowed-transaction-failed' : code,
            writeState: invoked ? 'unknown' : 'not-written',
        });
        controller.abort();
    };

    const assertActive = (): void => {
        if (borrowed !== undefined && active) {
            if (signal && abortedGetter.call(signal)) {
                stop('raw-cancelled');
            } else if (performance.now() >= started + timeout) {
                stop('raw-timeout');
            }
        }

        if (
            !active ||
            (borrowed !== undefined
                ? abortedGetter.call(controller.signal)
                : controller.signal.aborted) ||
            performance.now() >= started + timeout
        ) {
            throw new Error('transaction stopped');
        }
    };

    let timeout = 0;

    try {
        const input = record(options);

        if (
            borrowed !== undefined &&
            (Object.hasOwn(input, 'socket') || Object.hasOwn(input, 'sequence'))
        ) {
            throw new TypeError('invalid borrowed registration configuration');
        }

        const login = record(input.login);
        const tickets = record(login.tickets);
        const profile = record(input.profile);
        const reg = record(input.registration);

        const take = (v: unknown, max: number): Uint8Array => {
            const copy = bytes(v, max);
            owned.push(copy);
            return copy;
        };

        const guid = take(profile.guid, MAX_FIELD);
        const d2 = take(tickets.d2, MAX_FIELD);
        const key = take(tickets.d2Key, 16);
        const a2 = take(tickets.a2, MAX_FIELD);
        // Validate the complete WT ticket object without retaining its unused A1.
        const a1 = take(tickets.a1, MAX_FIELD);
        wipe(a1);
        const uin = login.uin;
        const sequence = input.sequence;
        timeout = input.timeoutMs as number;
        const signer = input.buildReserved as SsoReferenceRegisterOptions['buildReserved'];
        const verifier = input.verifyRaw as SsoReferenceRegisterOptions['verifyRaw'];
        const version = profile.version;
        const registrationVersion = reg.version;
        const uid = reg.uid;
        const deviceName = reg.deviceName;
        const deviceType = reg.deviceType;
        const vendorOs = reg.vendorOs;
        const random = reg.random;
        const subAppId = profile.subAppId;

        if (
            login.status !== 'tickets' ||
            typeof uin !== 'string' ||
            !/^[1-9][0-9]{0,18}$/.test(uin) ||
            BigInt(uin) > 0xffffffffn ||
            !guid.length ||
            !d2.length ||
            key.length !== 16 ||
            !text(version, true, 0xfffd) ||
            !text(registrationVersion, true) ||
            !text(uid, true) ||
            !text(deviceName, false) ||
            !text(deviceType, false) ||
            !text(vendorOs, false) ||
            !Number.isInteger(random) ||
            (random as number) < 0 ||
            (random as number) >= 0x7fffffff ||
            !Number.isInteger(subAppId) ||
            (subAppId as number) < 0 ||
            (subAppId as number) > 0x7fffffff ||
            (borrowed === undefined &&
                (!Number.isInteger(sequence) ||
                    (sequence as number) < 0 ||
                    (sequence as number) > 0xffffffff)) ||
            !Number.isInteger(timeout) ||
            timeout < 1 ||
            timeout > 0x7fffffff ||
            typeof signer !== 'function' ||
            isProxy(signer) ||
            typeof verifier !== 'function' ||
            isProxy(verifier)
        ) {
            throw new TypeError('invalid registration configuration');
        }

        if (input.signal !== undefined) {
            if (isProxy(input.signal)) {
                throw new TypeError('invalid signal');
            }

            try {
                abortedGetter.call(input.signal);
            } catch {
                throw new TypeError('invalid signal');
            }

            signal = input.signal as AbortSignal;
        }

        if (borrowed === undefined) {
            const socket = input.socket as Socket;

            if (isProxy(socket)) {
                throw new TypeError('invalid socket');
            }

            client = new Sso12PacketClient({
                socket,
                uin,
                encryption: { type: 'd2', key, d2 },
                subAppId: subAppId as number,
                guid,
                version,
                a2,
                initialSequence: sequence as number,
                defaultTimeoutMs: timeout,
                buildReserved: async () => {
                    throw new Error('unused');
                },
                classifyIncoming: () => 'response',
            });
        }

        if (signal) {
            if (borrowed !== undefined) {
                abortListener = addAbortListener(signal, () => stop('raw-cancelled'));

                if (abortedGetter.call(signal)) {
                    stop('raw-cancelled');
                }
            } else {
                EventTarget.prototype.addEventListener.call(signal, 'abort', abort, { once: true });

                if (abortedGetter.call(signal)) {
                    abort();
                }
            }
        }

        const remaining = Math.max(1, Math.ceil(started + timeout - performance.now()));

        if (performance.now() >= started + timeout) {
            if (borrowed !== undefined) {
                stop('raw-timeout');
            } else {
                controller.abort();
            }
        }

        if (borrowed !== undefined && !active) {
            return await stopped;
        }

        if (borrowed !== undefined) {
            const onDeadline = (): void => {
                if (!active) {
                    return;
                }

                const delay = started + timeout - performance.now();

                if (delay <= 0) {
                    stop('raw-timeout');
                } else {
                    timer = setTimeout(onDeadline, Math.max(1, Math.ceil(delay)));
                }
            };

            timer = setTimeout(onDeadline, remaining);
        }

        const transport: Sso12RawTransport =
            borrowed === undefined
                ? client!
                : {
                      transactRaw<C, T>(
                          rawOptions: Sso12RawOptions<C, T>,
                      ): Promise<Sso12RawResult<T>> {
                          const tracked: Sso12RawTransport = {
                              transactRaw<A, B>(
                                  raw: Sso12RawOptions<A, B>,
                              ): Promise<Sso12RawResult<B>> {
                                  assertActive();
                                  invoked = true;
                                  return borrowed.transactRaw(raw);
                              },
                          };
                          return guardBorrowedTransport<C, T>(tracked)(rawOptions);
                      },
                  };
        const operation = runRegistration(transport, {
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
                    body = encodeSsoRegisterReference({
                        uid,
                        version: registrationVersion,
                        guid,
                        deviceName,
                        deviceType,
                        vendorOs,
                        random: random as number,
                    });
                    owned.push(body);
                    signerInput = Uint8Array.from(body);
                    owned.push(signerInput);

                    if (borrowed !== undefined) {
                        assertActive();
                    }

                    const signerSequence = identity.sequence;
                    const signerRequest = {
                        uin,
                        uid,
                        sequence: signerSequence,
                        command: SSO_INFO_SYNC_COMMAND,
                        body: signerInput,
                    };
                    const signed = await signer(signerRequest);
                    assertActive();
                    // Lasting scalar changes are also rejected; restored changes and
                    // the bytes actually used by the signer remain outside this check.
                    assertSignerRequestUnchanged(
                        signerRequest,
                        uin,
                        uid,
                        signerSequence,
                        signerInput,
                        body,
                    );

                    assertActive();
                    // Take the output snapshot before clearing any aliased callback input.
                    metadata = bytes(signed, MAX_FIELD);
                    const localGuid = copy(guid),
                        localKey = copy(key);
                    const localD2 = copy(d2),
                        localA2 = copy(a2);
                    assertActive();
                    assertSignerRequestUnchanged(
                        signerRequest,
                        uin,
                        uid,
                        signerSequence,
                        signerInput,
                        body,
                    );
                    inner = encodeSso12Request({
                        sequence: signerSequence | 0,
                        subAppId: subAppId as number,
                        a2: localA2,
                        command: SSO_INFO_SYNC_COMMAND,
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
                    assertSignerRequestUnchanged(
                        signerRequest,
                        uin,
                        uid,
                        signerSequence,
                        signerInput,
                        body,
                    );
                    return { frame: requestFrame, context: null };
                } finally {
                    [body, signerInput, metadata, inner, ...local].forEach(wipe);
                }
            },
            verifyCandidate: async (candidate, _context, identity) => {
                let requestCopy: Uint8Array | undefined;
                let responseCopy: Uint8Array | undefined;

                try {
                    if (borrowed !== undefined) {
                        assertActive();
                    }

                    requestCopy = Uint8Array.from(requestFrame!);
                    owned.push(requestCopy);
                    responseCopy = Uint8Array.from(candidate);
                    owned.push(responseCopy);

                    if (borrowed !== undefined) {
                        assertActive();
                    }

                    const accepted = await verifier({
                        uin,
                        sequence: identity.sequence,
                        command: SSO_INFO_SYNC_COMMAND,
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
                    if (outer.protocol !== 12 || outer.encryption !== 'd2' || outer.uin !== uin) {
                        throw new Error('invalid envelope');
                    }

                    const response = decodeSsoResponse(outer.body);

                    try {
                        if (
                            response.sequence >>> 0 !== identity.sequence ||
                            response.command !== SSO_INFO_SYNC_COMMAND
                        ) {
                            throw new Error('invalid binding');
                        }

                        return classifySsoRegisterResponse(response);
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

        // Install both observers even if synchronous reentry already stopped the call.
        // A late guarded response is ignored; its callback/transport copies remain
        // their respective owners' responsibility until their work settles.
        const observed =
            borrowed === undefined
                ? operation
                : operation.then(
                      (value) => value,
                      () =>
                          ({
                              kind: 'failure',
                              code: 'borrowed-transaction-failed',
                              writeState: 'unknown',
                          }) as const,
                  );
        const result =
            borrowed === undefined ? await observed : await Promise.race([observed, stopped]);

        if (borrowed !== undefined) {
            if (active && signal && abortedGetter.call(signal)) {
                stop('raw-cancelled');
            }

            if (active && performance.now() >= started + timeout) {
                stop('raw-timeout');
            }

            if (stopCode) {
                return await stopped;
            }
        }

        return result;
    } finally {
        active = false;

        if (timer !== undefined) {
            clearTimeout(timer);
        }

        if (borrowed !== undefined) {
            abortListener?.[Symbol.dispose]();
            controller.abort();
        } else if (signal) {
            try {
                EventTarget.prototype.removeEventListener.call(signal, 'abort', abort);
            } catch {
                /* best effort */
            }
        }

        client?.close();
        wipe(requestFrame);
        owned.forEach(wipe);

        if (client) {
            await client.whenClosed;
        }
    }
}

function runRegistration(
    transport: Sso12RawTransport,
    options: Sso12RawOptions<null, SsoRegisterOutcome>,
): Promise<Sso12RawResult<SsoRegisterOutcome>> {
    return transport.transactRaw(options);
}
