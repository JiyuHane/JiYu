import { addAbortListener } from 'node:events';
import { isProxy } from 'node:util/types';
import {
    createSsoReferenceExchange,
    type SsoReferenceExchangeCapability,
    type SsoReferenceExchangeOptions,
    type SsoReferenceExchangeResult,
} from './sso-reference-exchange-internal';
import type { Sso12RawResult, Sso12RawTransport } from './sso12-packet-client';
import {
    cloneWtPersistedSession,
    disposeWtPersistedSession,
    type WtPersistedSessionV1,
} from './wt-persisted-session';
import {
    createNativeKeyExchange,
    disposeNativeKeyExchangeSession,
    NATIVE_KEY_EXCHANGE_COMMAND,
    type NativeKeyExchange,
    type NativeKeyExchangeSession,
} from './nt-native-key-exchange';
import {
    decodeNativeTicketForward,
    disposeNativeTicketResponse,
    encodeNativeTicketForward,
    encodeNativeTicketRefresh,
    NATIVE_MESSAGE_LIMIT,
    NATIVE_TICKET_REFRESH_COMMAND,
    nativeRecord,
    nativeSeconds,
    nativeText,
    wipeNativeBytes,
    type NativeTicketMetadata,
    type NativeTicketResponse,
} from './nt-native-ticket-codec';

type ByteRequest = { body: Uint8Array };
type WireOptions = SsoReferenceExchangeOptions<ByteRequest>;
type WriteState = Sso12RawResult<unknown>['writeState'];
export type NativeTicketRefreshStage = 'key-exchange' | 'refresh';
export type NativeTicketRefreshBinding = Omit<SsoReferenceExchangeCapability, 'run'>;
export interface NativeTicketRefreshOptions {
    /** Synchronously cloned. Never mutated, persisted, or activated by this function. */
    readonly persisted: WtPersistedSessionV1;
    readonly profile: { readonly subAppId: number; readonly version: string };
    readonly deviceName: string;
    readonly serverNowSeconds: bigint;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly buildReserved: WireOptions['buildReserved'];
    readonly verifyRaw: WireOptions['verifyRaw'];
}
export type NativeTicketRefreshResult =
    | {
          readonly kind: 'refreshed';
          /** Independently owned candidate. Durable save THEN activate belongs to the WT owner. */
          readonly persisted: WtPersistedSessionV1;
          readonly metadata: NativeTicketMetadata;
      }
    | Exclude<NativeTicketResponse, { kind: 'tickets' }>;

export class NativeTicketRefreshError extends Error {
    constructor(
        readonly stage: NativeTicketRefreshStage,
        readonly code:
            | 'invalid-input'
            | 'exchange-failed'
            | 'sso-error'
            | 'invalid-response'
            | 'operation-stopped',
        readonly writeState: WriteState,
        readonly transportCode?: string,
        readonly retCode?: number,
    ) {
        super(`native ticket refresh ${stage}: ${code}`);
        this.name = 'NativeTicketRefreshError';
    }
}

// The two exact code-owned commands bypass no generic requestPacket policy. These
// exchanges use existing SSO12/D2 framing, signer and raw verifier. That OUTER framing
// remains a reference composition pending live native interoperability validation.
function fixedExchange(command: string) {
    return createSsoReferenceExchange<ByteRequest, Uint8Array>({
        name: 'native ticket exchange',
        command,
        responseBodyLimit: NATIVE_MESSAGE_LIMIT,
        snapshotRequest: (input, record) => ({ body: record(input, ['body']).body as Uint8Array }),
        encodeRequest: (input) => Uint8Array.from(input.body),
        decodeResponse: (body) => Uint8Array.from(body),
        disposeResponse: wipeNativeBytes,
    });
}

const keyExchange = fixedExchange(NATIVE_KEY_EXCHANGE_COMMAND);
const ticketExchange = fixedExchange(NATIVE_TICKET_REFRESH_COMMAND);
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;

export function disposeNativeTicketRefreshResult(
    result: NativeTicketRefreshResult | undefined,
): void {
    if (result?.kind === 'refreshed') {
        disposeWtPersistedSession(result.persisted);
    }
}

/** Two exchanges, one monotonic deadline; never replay, reconnect, save, rotate, or schedule.
 * As in the existing borrowed exchange, the raw client owns I/O settlement and must
 * settle on timeout/abort. Aborting this operation does not close a caller-owned lease.
 * The registered WT owner must hold its single-flight lock through candidate checkpoint and
 * activation. With a capability each step gets a fresh child run; no capability is returned. */
export async function refreshNativeTicketsOnTransport(
    transport: Sso12RawTransport,
    options: NativeTicketRefreshOptions,
    capability?: NativeTicketRefreshBinding,
): Promise<NativeTicketRefreshResult> {
    const started = performance.now();
    let deadline = started;
    let stepDeadline = started;
    let stage: NativeTicketRefreshStage = 'key-exchange';
    let writeState: WriteState = 'not-written';
    let parsed = false;
    let ended = false;
    let input: WtPersistedSessionV1 | undefined;
    let candidate: WtPersistedSessionV1 | undefined;
    let flow: NativeKeyExchange | undefined;
    let session: NativeKeyExchangeSession | undefined;
    let plain: Uint8Array | undefined;
    let forward: Uint8Array | undefined;
    let keyReply: Uint8Array | undefined;
    let ticketReply: Uint8Array | undefined;
    let decoded: NativeTicketResponse | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: ReturnType<typeof addAbortListener> | undefined;
    let signal: AbortSignal | undefined;
    let binding: NativeTicketRefreshBinding | undefined;
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    let delivered = false;
    let completed = false;

    const remaining = (): number => {
        if (ended || controller.signal.aborted || (signal && aborted.call(signal))) {
            throw new NativeTicketRefreshError(stage, 'operation-stopped', writeState);
        }

        const now = performance.now();

        if (now >= stepDeadline || controller.signal.aborted || (signal && aborted.call(signal))) {
            throw new NativeTicketRefreshError(stage, 'operation-stopped', writeState);
        }

        return Math.max(1, Math.ceil(stepDeadline - now));
    };

    const response = (result: SsoReferenceExchangeResult<Uint8Array>): Uint8Array => {
        if (result.writeState === 'unknown' || writeState === 'unknown') {
            writeState = 'unknown';
        } else if (result.writeState === 'written') {
            writeState = 'written';
        }

        if (result.kind !== 'response') {
            throw new NativeTicketRefreshError(stage, 'exchange-failed', writeState, result.code);
        }

        if (result.value.status !== 'response') {
            throw new NativeTicketRefreshError(
                stage,
                'sso-error',
                writeState,
                undefined,
                result.value.retCode,
            );
        }

        return result.value.response;
    };

    try {
        const value = nativeRecord(options, [
            'persisted',
            'profile',
            'deviceName',
            'serverNowSeconds',
            'timeoutMs',
            'signal',
            'buildReserved',
            'verifyRaw',
        ]);
        const profile = nativeRecord(value.profile, ['subAppId', 'version']);
        const version = nativeText(profile.version);
        const subAppId = profile.subAppId;
        const deviceName = nativeText(value.deviceName);
        const timestamp = nativeSeconds(value.serverNowSeconds);
        const timeout = value.timeoutMs;

        if (
            typeof timeout !== 'number' ||
            !Number.isInteger(timeout) ||
            timeout < 1 ||
            timeout > 0x7fffffff ||
            typeof subAppId !== 'number' ||
            !Number.isInteger(subAppId) ||
            subAppId < 0 ||
            subAppId > 0x7fffffff ||
            typeof value.buildReserved !== 'function' ||
            isProxy(value.buildReserved) ||
            typeof value.verifyRaw !== 'function' ||
            isProxy(value.verifyRaw)
        ) {
            throw new TypeError('invalid native refresh configuration');
        }

        if (value.signal !== undefined) {
            if (
                isProxy(value.signal) ||
                typeof value.signal !== 'object' ||
                value.signal === null ||
                Object.getPrototypeOf(value.signal) !== AbortSignal.prototype ||
                Object.hasOwn(value.signal, 'aborted') ||
                Object.hasOwn(value.signal, 'addEventListener') ||
                Object.hasOwn(value.signal, 'removeEventListener')
            ) {
                throw new TypeError('invalid native refresh signal');
            }

            aborted.call(value.signal);
            signal = value.signal as AbortSignal;
            listener = addAbortListener(signal, stop);

            if (aborted.call(signal)) {
                stop();
            }
        }

        if (capability !== undefined) {
            const slot = nativeRecord(capability, ['token', 'attempt', 'lease']);

            if (slot.lease !== transport || !slot.token || !slot.attempt) {
                throw new TypeError('invalid native refresh owner');
            }

            binding = {
                token: slot.token as object,
                attempt: slot.attempt as object,
                lease: transport,
            };
        }

        deadline = started + timeout;
        stepDeadline = deadline;
        remaining();
        input = cloneWtPersistedSession(value.persisted);
        parsed = true;
        const signer = value.buildReserved as WireOptions['buildReserved'];
        const verifier = value.verifyRaw as WireOptions['verifyRaw'];
        timer = setTimeout(stop, remaining());
        flow = createNativeKeyExchange({
            uin: input.uin,
            guid: input.guid,
            timestampSeconds: timestamp,
        });
        const base = {
            login: { status: 'tickets' as const, uin: input.uin, tickets: input.tickets },
            profile: { guid: input.guid, subAppId, version },
            uid: input.uid,
            maxResponseBodyBytes: NATIVE_MESSAGE_LIMIT,
            signal: controller.signal,
            buildReserved: async (request: Parameters<WireOptions['buildReserved']>[0]) => {
                remaining();
                const result = await signer(request);
                remaining();
                return result;
            },
            verifyRaw: async (request: Parameters<WireOptions['verifyRaw']>[0]) => {
                remaining();
                const result = await verifier(request);
                remaining();
                return result;
            },
        };
        const nextBinding = (): SsoReferenceExchangeCapability | undefined =>
            binding ? { ...binding, run: {} } : undefined;
        keyReply = response(
            await keyExchange(
                transport,
                { ...base, request: { body: flow.request }, timeoutMs: remaining() },
                nextBinding(),
            ),
        );
        remaining();
        session = flow.complete(keyReply);
        wipeNativeBytes(keyReply);
        keyReply = undefined;
        remaining();
        stage = 'refresh';
        // Expiry is a relative SECOND count, separate from the server's absolute ticket dates.
        // Capping before Number conversion keeps huge int64 lifetimes exact enough for this deadline.
        const sessionBudgetMs =
            Number(session.expiresInSeconds > 2147483n ? 2147483n : session.expiresInSeconds) *
            1000;
        stepDeadline = Math.min(deadline, performance.now() + sessionBudgetMs);
        plain = encodeNativeTicketRefresh({
            uin: input.uin,
            guid: input.guid,
            version,
            deviceName,
            a1: input.tickets.a1,
        });
        forward = encodeNativeTicketForward(session.sessionKey, session.sessionTicket, plain);
        wipeNativeBytes(plain);
        plain = undefined;
        ticketReply = response(
            await ticketExchange(
                transport,
                { ...base, request: { body: forward }, timeoutMs: remaining() },
                nextBinding(),
            ),
        );
        remaining();
        decoded = decodeNativeTicketForward(session.sessionKey, ticketReply);
        remaining();

        if (decoded.kind !== 'tickets') {
            completed = true;
            return decoded;
        }

        if (
            (decoded.account?.uin !== undefined && decoded.account.uin !== BigInt(input.uin)) ||
            (decoded.account?.uid !== undefined && decoded.account.uid !== input.uid)
        ) {
            throw new Error('native response account mismatch');
        }

        candidate = cloneWtPersistedSession({
            version: 1,
            uin: input.uin,
            uid: input.uid,
            guid: input.guid,
            tickets: decoded.tickets,
        });
        remaining();
        delivered = true;
        completed = true;
        return Object.freeze({
            kind: 'refreshed',
            persisted: candidate,
            metadata: decoded.metadata,
        });
    } catch (error) {
        if (error instanceof NativeTicketRefreshError) {
            throw error;
        }

        throw new NativeTicketRefreshError(
            stage,
            parsed ? 'invalid-response' : 'invalid-input',
            writeState,
        );
    } finally {
        flow?.cancel();
        disposeNativeKeyExchangeSession(session);
        disposeNativeTicketResponse(decoded);
        [plain, forward, keyReply, ticketReply].forEach(wipeNativeBytes);

        if (input) {
            disposeWtPersistedSession(input);
        }

        if (!delivered && candidate) {
            disposeWtPersistedSession(candidate);
        }

        let finalizationFailed = false;

        try {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        } catch {
            finalizationFailed = true;
        }

        try {
            listener?.[Symbol.dispose]();

            if (completed) {
                remaining();
            }
        } catch {
            finalizationFailed = true;
        }

        ended = true;

        try {
            stop();

            if (
                completed &&
                ((signal && aborted.call(signal)) ||
                    performance.now() >= stepDeadline ||
                    (signal && aborted.call(signal)))
            ) {
                finalizationFailed = true;
            }
        } catch {
            finalizationFailed = true;
        }

        if (finalizationFailed && completed) {
            if (candidate) {
                disposeWtPersistedSession(candidate);
            }

            // eslint-disable-next-line no-unsafe-finally -- A stopped owner never receives new credentials.
            throw new NativeTicketRefreshError(stage, 'operation-stopped', writeState);
        }
    }
}
