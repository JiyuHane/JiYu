import { addAbortListener } from 'node:events';
import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import type { SsoReferenceRegisterBorrowedOptions } from './sso-reference-register-flow';
import type { Sso12RawOptions, Sso12RawResult, Sso12RawTransport } from './sso12-packet-client';
import { guardBorrowedTransport } from './guard-raw-transaction';
import { decodeServiceResponse, encodeServiceRequest } from './service-frame';
import { decodeSsoResponse, encodeSso13Request } from './sso';

export const SSO_REFERENCE_ALIVE_COMMAND = 'Heartbeat.Alive';

export interface SsoReferenceAliveOptions {
    /** Owner-projected UIN, possibly '0' before login, independent of transport identity. */
    uin: string;
    uid: string;
    timeoutMs: number;
    signal?: AbortSignal;
    buildReserved: SsoReferenceRegisterBorrowedOptions['buildReserved'];
    verifyRaw: SsoReferenceRegisterBorrowedOptions['verifyRaw'];
}

export type SsoAliveOutcome = { status: 'success' } | { status: 'sso-error'; retCode: number };
export type SsoReferenceAliveResult = Sso12RawResult<SsoAliveOutcome>;
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
        throw new TypeError('invalid alive configuration');
    }

    const prototype = Object.getPrototypeOf(value) as unknown;

    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('invalid alive configuration');
    }

    const keys = Reflect.ownKeys(value);

    if (keys.length > 32) {
        throw new TypeError('invalid alive configuration');
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
            throw new TypeError('invalid alive configuration');
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

function boundedText(value: unknown, max: number): value is string {
    return typeof value === 'string' && Buffer.byteLength(value) <= max;
}

/**
 * A single borrowed reference exchange, not login or server authentication.
 * The caller owns exclusivity, cleanup, and poisoning on failure. A transport
 * that stalls or changes its own lifecycle remains the owner's responsibility.
 * buildReserved produces opaque metadata; it need not provide a signature.
 * V2's default PC signing allowlist does not include this command; a custom
 * provider can apply a different policy. The callback here is not a signer claim.
 * https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Common/BotSignProvider.cs
 * Request-only reference:
 * https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/System/AliveService.cs
 * Requiring response protocol 13 and no encryption is conservative local policy,
 * not a claim about the upstream server's response envelope. Verification is an
 * explicit caller policy; neither plaintext nor QQ-TEA authenticates a peer.
 */
export async function referenceAliveOnTransport(
    transport: Sso12RawTransport,
    options: SsoReferenceAliveOptions,
): Promise<SsoReferenceAliveResult> {
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
            'uin',
            'uid',
            'timeoutMs',
            'signal',
            'buildReserved',
            'verifyRaw',
        ]);
        const uin = input.uin;
        const uid = input.uid;
        timeout = input.timeoutMs as number;
        const buildReserved = input.buildReserved as SsoReferenceAliveOptions['buildReserved'];
        const verifyRaw = input.verifyRaw as SsoReferenceAliveOptions['verifyRaw'];

        if (
            typeof uin !== 'string' ||
            !/^(?:0|[1-9][0-9]{0,9})$/.test(uin) ||
            BigInt(uin) > 0xffffffffn ||
            !boundedText(uid, 4096) ||
            !Number.isInteger(timeout) ||
            timeout < 1 ||
            timeout > 0x7fffffff ||
            typeof buildReserved !== 'function' ||
            isProxy(buildReserved) ||
            typeof verifyRaw !== 'function' ||
            isProxy(verifyRaw)
        ) {
            throw new TypeError('invalid alive configuration');
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

        const result = await guardBorrowedTransport<null, SsoAliveOutcome>(stable)({
            timeoutMs: remaining,
            signal: controller.signal,
            buildRequest: async (identity) => {
                let body: Uint8Array | undefined;
                let callbackBody: Uint8Array | undefined;
                let metadata: Uint8Array | undefined;
                let inner: Uint8Array | undefined;

                try {
                    assertActive();
                    body = Uint8Array.of(0, 0, 0, 4);
                    owned.push(body);
                    callbackBody = Uint8Array.from(body);
                    owned.push(callbackBody);
                    const built = await buildReserved({
                        uin,
                        uid,
                        sequence: identity.sequence,
                        command: SSO_REFERENCE_ALIVE_COMMAND,
                        body: callbackBody,
                    });
                    assertActive();
                    metadata = copyBytes(built, MAX_FIELD);
                    assertActive();
                    inner = encodeSso13Request({
                        command: SSO_REFERENCE_ALIVE_COMMAND,
                        reserved: metadata,
                        body,
                    });
                    requestFrame = encodeServiceRequest({
                        protocol: 13,
                        uin,
                        sequence: identity.sequence | 0,
                        encryption: { type: 'none' },
                        body: inner,
                    });
                    assertActive();
                    return { frame: requestFrame, context: null };
                } finally {
                    [body, callbackBody, metadata, inner].forEach(wipe);
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
                    const accepted = await verifyRaw({
                        uin,
                        sequence: identity.sequence,
                        command: SSO_REFERENCE_ALIVE_COMMAND,
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
                const outer = decodeServiceResponse(candidate);

                try {
                    if (outer.protocol !== 13 || outer.encryption !== 'none' || outer.uin !== uin) {
                        throw new Error('invalid envelope');
                    }

                    const response = decodeSsoResponse(outer.body);

                    try {
                        if (
                            response.sequence >>> 0 !== identity.sequence ||
                            response.command !== SSO_REFERENCE_ALIVE_COMMAND
                        ) {
                            throw new Error('invalid binding');
                        }

                        return response.retCode === 0
                            ? { status: 'success' }
                            : { status: 'sso-error', retCode: response.retCode };
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
