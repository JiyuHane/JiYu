import type { Socket } from 'node:net';
import { isProxy } from 'node:util/types';
import { Sso12PacketClient, type Sso12RawResult } from './sso12-packet-client';
import { decodeServiceResponse, encodeServiceRequest } from './service-frame';
import { decodeSsoResponse, encodeSso12Request } from './sso';
import {
    classifySsoRegisterResponse,
    encodeSsoRegisterReference,
    SSO_INFO_SYNC_COMMAND,
    type SsoRegisterOutcome,
} from './sso-register';
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

export type SsoReferenceRegisterResult = Sso12RawResult<SsoRegisterOutcome>;
const MAX_FIELD = 65535;
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
    const started = performance.now();
    // On settlement every outstanding callback copy is wiped; callbacks still running
    // may observe that cleanup. External callback side effects cannot be cancelled.
    const owned: Uint8Array[] = [];
    let client: Sso12PacketClient | undefined;
    let active = true;
    let requestFrame: Uint8Array | undefined;
    let signal: AbortSignal | undefined;
    const controller = new AbortController();
    const abort = (): void => controller.abort();

    const assertActive = (): void => {
        if (!active || controller.signal.aborted || performance.now() >= started + timeout) {
            throw new Error('transaction stopped');
        }
    };

    let timeout = 0;

    try {
        const input = record(options);
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
            !Number.isInteger(sequence) ||
            (sequence as number) < 0 ||
            (sequence as number) > 0xffffffff ||
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

        if (signal) {
            EventTarget.prototype.addEventListener.call(signal, 'abort', abort, { once: true });

            if (abortedGetter.call(signal)) {
                abort();
            }
        }

        const remaining = Math.max(1, Math.ceil(started + timeout - performance.now()));

        if (performance.now() >= started + timeout) {
            controller.abort();
        }

        const result = await client.transactRaw<null, SsoRegisterOutcome>({
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
                    const signed = await signer({
                        uin,
                        uid,
                        sequence: identity.sequence,
                        command: SSO_INFO_SYNC_COMMAND,
                        body: signerInput,
                    });
                    assertActive();
                    // Take the output snapshot before clearing any aliased callback input.
                    metadata = bytes(signed, MAX_FIELD);
                    const localGuid = copy(guid),
                        localKey = copy(key);
                    const localD2 = copy(d2),
                        localA2 = copy(a2);
                    assertActive();
                    inner = encodeSso12Request({
                        sequence: identity.sequence | 0,
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
                    return { frame: requestFrame, context: null };
                } finally {
                    [body, signerInput, metadata, inner, ...local].forEach(wipe);
                }
            },
            verifyCandidate: async (candidate, _context, identity) => {
                let requestCopy: Uint8Array | undefined;
                let responseCopy: Uint8Array | undefined;

                try {
                    requestCopy = Uint8Array.from(requestFrame!);
                    owned.push(requestCopy);
                    responseCopy = Uint8Array.from(candidate);
                    owned.push(responseCopy);
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
        return result;
    } finally {
        active = false;

        if (signal) {
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
