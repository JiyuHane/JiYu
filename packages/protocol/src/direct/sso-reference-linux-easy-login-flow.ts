import { addAbortListener } from 'node:events';
import { isProxy } from 'node:util/types';
import { guardBorrowedTransport } from './guard-raw-transaction';
import { encodeLinuxNTEasyLoginReferenceRequest } from './nt-linux-easy-login-reference';
import {
    encodeLinuxNTLoginReferenceRequest,
    type LinuxNTLoginReferenceInput,
} from './nt-linux-login-reference';
import {
    decodeLinuxNTLoginReferenceResponse,
    type LinuxNTLoginReferenceResponse,
} from './nt-linux-login-response-reference';
import {
    decodeServiceResponse,
    encodeServiceRequest,
    MAX_SERVICE_FRAME_BYTES,
} from './service-frame';
import { decodeSsoResponse, encodeSso12Request } from './sso';
import type { Sso12RawOptions, Sso12RawResult, Sso12RawTransport } from './sso12-packet-client';

export const LINUX_EASY_LOGIN_COMMAND = 'trpc.login.ecdh.EcdhService.SsoNTLoginEasyLogin';

export interface SsoReferenceLinuxEasyLoginOptions extends Omit<
    LinuxNTLoginReferenceInput,
    'account' | 'loginBody'
> {
    uin: string;
    a1: Uint8Array;
    a2?: Uint8Array;
    subAppId: number;
    timeoutMs: number;
    signal?: AbortSignal;
    buildReserved: (input: {
        uin: string;
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

const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const lengthGetter = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const tagGetter = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const values = Uint8Array.prototype.values;
const set = Uint8Array.prototype.set;
const fill = Uint8Array.prototype.fill;
const LIMIT = 1024 * 1024;

function wipe(bytes: Uint8Array | null | undefined): void {
    if (bytes) {
        try {
            fill.call(bytes, 0);
        } catch {
            // Detached buffers and runtime-internal copies are outside this cleanup.
        }
    }
}

function snapshot(value: unknown, max: number): Uint8Array {
    if (isProxy(value) || !ArrayBuffer.isView(value) || tagGetter.call(value) !== 'Uint8Array') {
        throw new TypeError('invalid bytes');
    }

    const proto = Object.getPrototypeOf(value) as object | null;

    if (proto !== Uint8Array.prototype && proto !== Buffer.prototype) {
        throw new TypeError('invalid bytes');
    }

    values.call(value);
    const storage = bufferGetter.call(value) as ArrayBuffer;
    arrayBufferLength.call(storage);

    if (resizable?.call(storage)) {
        throw new TypeError('invalid bytes');
    }

    const length = lengthGetter.call(value) as number;
    const offset = offsetGetter.call(value) as number;

    if (length > max) {
        throw new TypeError('invalid bytes');
    }

    const copy = new Uint8Array(length);
    set.call(copy, new Uint8Array(storage, offset, length));
    return copy;
}

function configuration(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        throw new TypeError('invalid EasyLogin configuration');
    }

    const proto = Object.getPrototypeOf(value) as object | null;

    if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('invalid EasyLogin configuration');
    }

    const allowed = new Set([
        'uin',
        'sessionKey',
        'sessionTicket',
        'a1',
        'a2',
        'nonce',
        'guid',
        'version',
        'subAppId',
        'deviceName',
        'deviceType',
        'appId',
        'appName',
        'qua',
        'cookie',
        'timeoutMs',
        'signal',
        'buildReserved',
        'verifyRaw',
    ]);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (
            typeof key !== 'string' ||
            !allowed.has(key) ||
            !descriptor ||
            !('value' in descriptor)
        ) {
            throw new TypeError('invalid EasyLogin configuration');
        }

        result[key] = descriptor.value;
    }

    return result;
}

function disposeResult(result: LinuxNTLoginReferenceResponse | undefined): void {
    if (result) {
        wipe(result.body);
    }
}

/**
 * One synthetic reference transaction on a borrowed transport, with no retry or
 * nonce allocator. The caller must use a nonce unique under this session key across
 * all stages and enforce session/ticket expiry, account binding and replay policy.
 * The transport owner provides exclusivity and must close or otherwise
 * resolve a transport whose state is unknown; settlement does not prove quiescence.
 * A verifier is caller policy, not peer authentication. Comparing a signer's input
 * detects lasting mutation only, not which bytes it actually signed. Response status
 * and body remain opaque; no tickets are decoded, persisted or promoted. The returned
 * body belongs to the caller. Timeout cannot interrupt synchronous crypto. Buffer
 * wiping is best effort and excludes provider, codec, runtime and callback copies.
 * Reference: LagrangeV2 rev 7011cdf, EasyLoginService.cs and NTLoginCommon.cs.
 */
export async function referenceLinuxEasyLoginOnTransport(
    transport: Sso12RawTransport,
    options: SsoReferenceLinuxEasyLoginOptions,
): Promise<Sso12RawResult<LinuxNTLoginReferenceResponse>> {
    const started = performance.now();
    const owned = new Set<Uint8Array>();
    const controller = new AbortController();
    let active = true;
    let invoked = false;
    let deadline = Infinity;
    let stopCode: 'raw-cancelled' | 'raw-timeout' | undefined;
    let signal: AbortSignal | undefined;
    let listener: ReturnType<typeof addAbortListener> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requestFrame: Uint8Array | undefined;
    let observedResponse: LinuxNTLoginReferenceResponse | undefined;
    let resolveStopped!: (result: Sso12RawResult<LinuxNTLoginReferenceResponse>) => void;
    const stopped = new Promise<Sso12RawResult<LinuxNTLoginReferenceResponse>>((resolve) => {
        resolveStopped = resolve;
    });

    const track = (bytes: Uint8Array): Uint8Array => {
        owned.add(bytes);
        return bytes;
    };

    const release = (bytes: Uint8Array | undefined): void => {
        wipe(bytes);

        if (bytes) {
            owned.delete(bytes);
        }
    };

    const clear = (): void => {
        for (const bytes of owned) {
            wipe(bytes);
        }

        owned.clear();
    };

    const stop = (code: 'raw-cancelled' | 'raw-timeout'): void => {
        if (!active) {
            return;
        }

        active = false;
        stopCode = code;
        clear();
        controller.abort();
        resolveStopped({ kind: 'failure', code, writeState: invoked ? 'unknown' : 'not-written' });
    };

    const assertActive = (): void => {
        if (active && signal && aborted.call(signal)) {
            stop('raw-cancelled');
        }

        if (active && performance.now() >= deadline) {
            stop('raw-timeout');
        }

        if (!active) {
            throw new Error('transaction stopped');
        }
    };

    try {
        const input = configuration(options);
        const { uin, version, subAppId, deviceName, deviceType, appId, appName, qua, cookie } =
            input;
        const signer = input.buildReserved;
        const verifier = input.verifyRaw;
        const timeout = input.timeoutMs;
        const text = (value: unknown): value is string =>
            typeof value === 'string' &&
            value.length <= LIMIT &&
            !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);

        if (
            typeof uin !== 'string' ||
            !/^[1-9][0-9]{0,18}$/.test(uin) ||
            (uin.length === 19 && uin > '9223372036854775807') ||
            !text(version) ||
            !version.length ||
            Buffer.byteLength(version) > 0xfffd ||
            !text(deviceName) ||
            !text(deviceType) ||
            !text(appName) ||
            !text(qua) ||
            (cookie !== undefined && !text(cookie)) ||
            typeof subAppId !== 'number' ||
            !Number.isInteger(subAppId) ||
            subAppId < 0 ||
            subAppId > 0x7fffffff ||
            typeof appId !== 'number' ||
            !Number.isInteger(appId) ||
            appId < 0 ||
            appId > 0x7fffffff ||
            typeof timeout !== 'number' ||
            !Number.isInteger(timeout) ||
            timeout < 1 ||
            timeout > 0x7fffffff ||
            typeof signer !== 'function' ||
            isProxy(signer) ||
            typeof verifier !== 'function' ||
            isProxy(verifier)
        ) {
            throw new TypeError('invalid EasyLogin configuration');
        }

        deadline = started + timeout;

        if (input.signal !== undefined) {
            if (isProxy(input.signal)) {
                throw new TypeError('invalid signal');
            }

            try {
                aborted.call(input.signal);
                signal = input.signal as AbortSignal;
                listener = addAbortListener(signal, () => stop('raw-cancelled'));
            } catch {
                throw new TypeError('invalid signal');
            }
        }

        if (signal && aborted.call(signal)) {
            stop('raw-cancelled');
        }

        if (active && performance.now() >= deadline) {
            stop('raw-timeout');
        }

        if (!active) {
            return await stopped;
        }

        const key = track(snapshot(input.sessionKey, LIMIT));
        const ticket = track(snapshot(input.sessionTicket, LIMIT));
        const nonce = track(snapshot(input.nonce, LIMIT));
        const guid = track(snapshot(input.guid, LIMIT));
        const a1 = track(snapshot(input.a1, LIMIT));
        const a2 = track(
            input.a2 === undefined
                ? new Uint8Array(0)
                : snapshot(input.a2, MAX_SERVICE_FRAME_BYTES),
        );

        if (
            ![16, 24, 32].includes(key.length) ||
            !ticket.length ||
            nonce.length !== 12 ||
            !guid.length ||
            !a1.length ||
            guid.length * 3 + a2.length + Buffer.byteLength(version) + 512 > MAX_SERVICE_FRAME_BYTES
        ) {
            throw new TypeError('invalid EasyLogin configuration');
        }

        if (active && signal && aborted.call(signal)) {
            stop('raw-cancelled');
        }

        if (active && performance.now() >= deadline) {
            stop('raw-timeout');
        }

        if (!active) {
            return await stopped;
        }

        let forward: Uint8Array;

        try {
            const easyBody = track(encodeLinuxNTEasyLoginReferenceRequest(a1));
            forward = track(
                encodeLinuxNTLoginReferenceRequest({
                    sessionKey: key,
                    sessionTicket: ticket,
                    nonce,
                    loginBody: easyBody,
                    account: uin,
                    deviceName,
                    deviceType,
                    guid,
                    version,
                    appId,
                    appName,
                    qua,
                    cookie,
                }),
            );
            release(easyBody);
        } catch {
            throw new TypeError('invalid EasyLogin configuration');
        }

        release(ticket);
        release(nonce);
        release(a1);

        if (active && signal && aborted.call(signal)) {
            stop('raw-cancelled');
        }

        if (active && performance.now() >= deadline) {
            stop('raw-timeout');
        }

        if (!active) {
            return await stopped;
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

        if (signal && aborted.call(signal)) {
            stop('raw-cancelled');
        }

        if (active && performance.now() >= deadline) {
            stop('raw-timeout');
        }

        if (!active) {
            return await stopped;
        }

        timer = setTimeout(
            () => stop('raw-timeout'),
            Math.max(1, Math.ceil(deadline - performance.now())),
        );
        const stable: Sso12RawTransport = {
            transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                assertActive();
                invoked = true;
                return Reflect.apply(method, transport, [raw]) as Promise<Sso12RawResult<T>>;
            },
        };
        const context = Object.freeze({});
        const guarded = guardBorrowedTransport<object, LinuxNTLoginReferenceResponse>(stable, {
            disposeResult,
        });
        const operation = guarded({
            timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())),
            signal: controller.signal,
            buildRequest: async (identity) => {
                let signerBody: Uint8Array | undefined;
                let reserved: Uint8Array | undefined;
                let sso: Uint8Array | undefined;
                let frame: Uint8Array | undefined;
                let handedOff = false;

                try {
                    assertActive();

                    if (identity.uin !== uin) {
                        throw new Error('identity mismatch');
                    }

                    signerBody = track(snapshot(forward, MAX_SERVICE_FRAME_BYTES));
                    const signed = await signer({
                        uin,
                        sequence: identity.sequence,
                        command: LINUX_EASY_LOGIN_COMMAND,
                        body: signerBody,
                    });
                    assertActive();
                    // Snapshot before releasing signerBody: signer output may alias it.
                    reserved = track(snapshot(signed, MAX_SERVICE_FRAME_BYTES));

                    if (
                        signerBody.length !== forward.length ||
                        Buffer.compare(signerBody, forward) !== 0
                    ) {
                        throw new Error('signer input changed');
                    }

                    sso = track(
                        encodeSso12Request({
                            sequence: identity.sequence | 0,
                            subAppId,
                            a2,
                            command: LINUX_EASY_LOGIN_COMMAND,
                            guid,
                            version,
                            reserved,
                            body: forward,
                        }),
                    );
                    frame = track(
                        encodeServiceRequest({
                            protocol: 12,
                            encryption: { type: 'zero' },
                            d2: new Uint8Array(0),
                            uin,
                            body: sso,
                        }),
                    );
                    assertActive();
                    requestFrame = track(snapshot(frame, MAX_SERVICE_FRAME_BYTES));
                    assertActive();
                    handedOff = true;
                    return { frame, context };
                } finally {
                    release(signerBody);
                    release(reserved);
                    release(sso);

                    if (!handedOff) {
                        release(frame);
                    }
                }
            },
            verifyCandidate: async (candidate, suppliedContext, identity) => {
                let requestCopy: Uint8Array | undefined;
                let responseCopy: Uint8Array | undefined;

                try {
                    assertActive();

                    if (suppliedContext !== context || identity.uin !== uin || !requestFrame) {
                        throw new Error('identity mismatch');
                    }

                    requestCopy = track(snapshot(requestFrame, MAX_SERVICE_FRAME_BYTES));
                    responseCopy = track(snapshot(candidate, MAX_SERVICE_FRAME_BYTES));
                    const accepted = await verifier({
                        uin,
                        sequence: identity.sequence,
                        command: LINUX_EASY_LOGIN_COMMAND,
                        requestFrame: requestCopy,
                        responseFrame: responseCopy,
                    });
                    assertActive();
                    return accepted === true;
                } finally {
                    release(requestCopy);
                    release(responseCopy);
                }
            },
            consumeCandidate: (candidate, suppliedContext, identity) => {
                assertActive();

                if (suppliedContext !== context || identity.uin !== uin) {
                    throw new Error('identity mismatch');
                }

                let service: ReturnType<typeof decodeServiceResponse> | undefined;
                let parsed: ReturnType<typeof decodeSsoResponse> | undefined;
                let temporary: LinuxNTLoginReferenceResponse | undefined;
                let output: LinuxNTLoginReferenceResponse | undefined;
                let committed = false;

                try {
                    service = decodeServiceResponse(candidate);

                    if (
                        service.protocol !== 12 ||
                        service.encryption !== 'zero' ||
                        service.dummy !== 0 ||
                        service.uin !== uin
                    ) {
                        throw new Error('invalid service response');
                    }

                    parsed = decodeSsoResponse(service.body);

                    if (
                        parsed.sequence !== (identity.sequence | 0) ||
                        parsed.command !== LINUX_EASY_LOGIN_COMMAND ||
                        parsed.retCode !== 0
                    ) {
                        throw new Error('invalid SSO response');
                    }

                    temporary = decodeLinuxNTLoginReferenceResponse({
                        forward: parsed.body,
                        sessionKey: key,
                    });
                    assertActive();
                    output = {
                        status: temporary.status,
                        // Retain independent ownership even if an intermediate transport
                        // discards this result before the guard can observe it.
                        body:
                            temporary.body === null ? null : track(snapshot(temporary.body, LIMIT)),
                    };
                    assertActive();
                    committed = true;
                    return output;
                } finally {
                    wipe(service?.body);
                    wipe(parsed?.body);
                    wipe(parsed?.cookie);
                    wipe(parsed?.reserved);
                    wipe(parsed?.headerExtension);
                    disposeResult(temporary);

                    if (!committed) {
                        disposeResult(output);
                    }
                }
            },
        });
        const observed = operation.then(
            (result) => {
                if (result.kind === 'response') {
                    if (active) {
                        observedResponse = result.value;
                    } else {
                        disposeResult(result.value);
                    }
                }

                return result;
            },
            () =>
                ({
                    kind: 'failure',
                    code: 'borrowed-transaction-failed',
                    writeState: 'unknown',
                }) as const,
        );
        const result = await Promise.race([observed, stopped]);

        if (active && signal && aborted.call(signal)) {
            stop('raw-cancelled');
        }

        if (result.kind === 'response') {
            if (!active || performance.now() >= deadline) {
                return { kind: 'failure', code: stopCode ?? 'raw-timeout', writeState: 'unknown' };
            }

            observedResponse = undefined;

            if (result.value.body !== null) {
                owned.delete(result.value.body);
            }

            return result;
        }

        if (stopCode) {
            return {
                kind: 'failure',
                code: stopCode,
                writeState: invoked ? 'unknown' : 'not-written',
            };
        }

        return invoked
            ? { kind: 'failure', code: 'borrowed-transaction-failed', writeState: 'unknown' }
            : result;
    } finally {
        active = false;

        if (timer !== undefined) {
            clearTimeout(timer);
        }

        listener?.[Symbol.dispose]();
        clear();
        disposeResult(observedResponse);
        controller.abort();
    }
}
