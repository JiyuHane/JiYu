import { addAbortListener } from 'node:events';
import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import type { SsoReferenceRegisterBorrowedOptions } from './sso-reference-register-flow';
import type { Sso12RawOptions, Sso12RawResult, Sso12RawTransport } from './sso12-packet-client';
import { guardBorrowedTransport } from './guard-raw-transaction';
import { decodeServiceResponse, encodeServiceRequest } from './service-frame';
import { decodeSsoResponse, encodeSso12Request } from './sso';
import {
    decodeSsoHeartbeatResponse,
    encodeSsoHeartbeatReference,
    SSO_HEARTBEAT_COMMAND,
} from './sso-register';

export interface SsoReferenceHeartbeatOptions {
    login: SsoReferenceRegisterBorrowedOptions['login'];
    profile: SsoReferenceRegisterBorrowedOptions['profile'];
    /** Internal owner-projected UID; never an external account selection. */
    uid: string;
    timeoutMs: number;
    signal?: AbortSignal;
    buildReserved: SsoReferenceRegisterBorrowedOptions['buildReserved'];
    verifyRaw: SsoReferenceRegisterBorrowedOptions['verifyRaw'];
}

export type SsoHeartbeatOutcome =
    | { status: 'success'; interval: bigint }
    | { status: 'missing-interval' }
    | { status: 'sso-error'; retCode: number };
export type SsoReferenceHeartbeatResult = Sso12RawResult<SsoHeartbeatOutcome>;

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
        throw new TypeError('invalid heartbeat configuration');
    }

    const prototype = Object.getPrototypeOf(value) as unknown;

    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('invalid heartbeat configuration');
    }

    const keys = Reflect.ownKeys(value);

    if (keys.length > 32) {
        throw new TypeError('invalid heartbeat configuration');
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
            throw new TypeError('invalid heartbeat configuration');
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

/** Validate field 3 even if Proton's bounded unknown-field diagnostics omit it. */
function validateIntervalWire(data: Uint8Array): void {
    let pos = 0;
    const groups: number[] = [];

    const varint = (max: number): bigint => {
        let result = 0n;

        for (let i = 0; i < max; i++) {
            if (pos >= data.length) {
                throw new Error('invalid heartbeat protobuf');
            }

            const byte = data[pos++];

            if (i === max - 1 && byte > (max === 10 ? 1 : 15)) {
                throw new Error('invalid heartbeat protobuf');
            }

            result |= BigInt(byte & 127) << BigInt(i * 7);

            if ((byte & 128) === 0) {
                return result;
            }
        }

        throw new Error('invalid heartbeat protobuf');
    };

    while (pos < data.length) {
        const tag = varint(5);
        const field = Number(tag >> 3n);
        const wire = Number(tag & 7n);

        if (!field || (groups.length === 0 && field === 3 && wire !== 0)) {
            throw new Error('invalid heartbeat protobuf');
        }

        if (wire === 0) {
            varint(10);
        } else if (wire === 1 || wire === 5) {
            pos += wire === 1 ? 8 : 4;
        } else if (wire === 2) {
            const size = varint(5);

            if (size > BigInt(data.length - pos)) {
                throw new Error('invalid heartbeat protobuf');
            }

            pos += Number(size);
        } else if (wire === 3) {
            if (groups.length >= 64) {
                throw new Error('invalid heartbeat protobuf');
            }

            groups.push(field);
        } else if (wire === 4) {
            if (groups.pop() !== field) {
                throw new Error('invalid heartbeat protobuf');
            }
        } else {
            throw new Error('invalid heartbeat protobuf');
        }

        if (pos > data.length) {
            throw new Error('invalid heartbeat protobuf');
        }
    }

    if (groups.length) {
        throw new Error('invalid heartbeat protobuf');
    }
}

/**
 * One borrowed, locally verified exchange. The owner retains exclusivity, transport
 * lifecycle and poisoning on failure, including a guard rejection after broker success.
 * Callbacks receive temporary copies; their outputs are opaque policy, not proof of
 * signature validity or server authentication. No timers, pushes, multi-account socket
 * ownership or online-state claims are implemented here. A stalled transport and its
 * external callback effects remain owner responsibilities.
 * PC service-level comparison only; it does not establish V2 wire compatibility:
 * https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/System/SsoHeartBeatService.cs#L7-L22
 */
export async function referenceHeartbeatOnTransport(
    transport: Sso12RawTransport,
    options: SsoReferenceHeartbeatOptions,
): Promise<SsoReferenceHeartbeatResult> {
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
        const signer = input.buildReserved as SsoReferenceHeartbeatOptions['buildReserved'];
        const verifier = input.verifyRaw as SsoReferenceHeartbeatOptions['verifyRaw'];

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
            typeof signer !== 'function' ||
            isProxy(signer) ||
            typeof verifier !== 'function' ||
            isProxy(verifier)
        ) {
            throw new TypeError('invalid heartbeat configuration');
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

        const result = await guardBorrowedTransport<null, SsoHeartbeatOutcome>(stable)({
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
                    body = encodeSsoHeartbeatReference();
                    owned.push(body);
                    signerInput = Uint8Array.from(body);
                    owned.push(signerInput);
                    const signed = await signer({
                        uin,
                        uid,
                        sequence: identity.sequence,
                        command: SSO_HEARTBEAT_COMMAND,
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
                        command: SSO_HEARTBEAT_COMMAND,
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
                        command: SSO_HEARTBEAT_COMMAND,
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
                            response.command !== SSO_HEARTBEAT_COMMAND
                        ) {
                            throw new Error('invalid binding');
                        }

                        if (response.retCode !== 0) {
                            return { status: 'sso-error', retCode: response.retCode };
                        }

                        validateIntervalWire(response.body);
                        const { interval } = decodeSsoHeartbeatResponse(response.body);

                        if (interval === undefined) {
                            return { status: 'missing-interval' };
                        }

                        if (
                            typeof interval !== 'bigint' ||
                            interval < 0n ||
                            interval > 0xffffffffffffffffn
                        ) {
                            throw new Error('invalid interval');
                        }

                        return { status: 'success', interval };
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
