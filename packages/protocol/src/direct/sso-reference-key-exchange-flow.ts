import { addAbortListener } from 'node:events';
import { isProxy } from 'node:util/types';
import { guardBorrowedTransport } from './guard-raw-transaction';
import {
    KEY_EXCHANGE_COMMAND,
    prepareKeyExchangeFlow,
    type KeyExchangeFlow,
    type KeyExchangeFlowInput,
    type KeyExchangeFlowResult,
    type PreparedKeyExchangeFlow,
} from './key-exchange-flow';
import { MAX_SERVICE_FRAME_BYTES } from './service-frame';
import type { Sso12RawOptions, Sso12RawResult, Sso12RawTransport } from './sso12-packet-client';

export interface SsoReferenceKeyExchangeOptions {
    uin: string;
    guid: Uint8Array;
    version: string;
    subAppId: number;
    a2?: Uint8Array;
    serverPublicKey: Uint8Array;
    verifyKey: Uint8Array;
    timestamp: number;
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
    verifyServerResponse: KeyExchangeFlowInput['verifyServerResponse'];
    timeoutMs: number;
    signal?: AbortSignal;
}

const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const tag = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const values = Uint8Array.prototype.values;
const fill = Uint8Array.prototype.fill;
const set = Uint8Array.prototype.set;

function wipe(value: Uint8Array | undefined): void {
    if (value) {
        try {
            fill.call(value, 0);
        } catch {
            // Detached storage and runtime/provider copies are outside this cleanup.
        }
    }
}

function snapshot(value: unknown, max: number): Uint8Array {
    if (isProxy(value) || !ArrayBuffer.isView(value) || tag.call(value) !== 'Uint8Array') {
        throw new TypeError('invalid bytes');
    }

    const proto = Object.getPrototypeOf(value) as object | null;

    if (proto !== Uint8Array.prototype && proto !== Buffer.prototype) {
        throw new TypeError('invalid bytes');
    }

    const storage = buffer.call(value) as ArrayBuffer;
    arrayBufferLength.call(storage);
    values.call(value);

    if (resizable?.call(storage)) {
        throw new TypeError('invalid bytes');
    }

    const length = byteLength.call(value) as number;
    const offset = byteOffset.call(value) as number;

    if (length > max) {
        throw new TypeError('invalid bytes');
    }

    // Only captured TypedArray intrinsics touch this value; extra own properties
    // are ignored rather than enumerating every byte as a property key.
    const copy = new Uint8Array(length);
    set.call(copy, new Uint8Array(storage, offset, length));
    return copy;
}

function configuration(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        throw new TypeError('invalid key exchange configuration');
    }

    const proto = Object.getPrototypeOf(value) as object | null;

    if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('invalid key exchange configuration');
    }

    const allowed = new Set([
        'uin',
        'guid',
        'version',
        'subAppId',
        'a2',
        'serverPublicKey',
        'verifyKey',
        'timestamp',
        'buildReserved',
        'verifyRaw',
        'verifyServerResponse',
        'timeoutMs',
        'signal',
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
            throw new TypeError('invalid key exchange configuration');
        }

        result[key] = descriptor.value;
    }

    return result;
}

function disposeResult(result: KeyExchangeFlowResult): void {
    wipe(result.sessionKey);
    wipe(result.sessionTicket);
}

/**
 * A single reference transaction on a borrowed transport. The transport owns I/O,
 * exclusivity and any work that outlives settlement; this function neither closes
 * it nor establishes that it has stopped. Callback policy is not proof of peer
 * identity, unique sequence numbers or cross-transaction replay protection.
 * Requiring a zero outer dummy byte is a local strict policy, not a claim about
 * a real server. Cleanup covers tracked buffers and cancellation only; internal
 * decoder, callback, runtime and crypto-provider copies may remain. Cancellation
 * is cooperative within this process, not isolation or a hard real-time interrupt.
 * There are no retries or production-runtime integration. Invalid configuration
 * rejects with TypeError; transaction failures use fixed codes.
 */
export async function referenceKeyExchangeOnTransport(
    transport: Sso12RawTransport,
    options: SsoReferenceKeyExchangeOptions,
): Promise<Sso12RawResult<KeyExchangeFlowResult>> {
    const started = performance.now();
    const owned = new Set<Uint8Array>();
    let prepared: PreparedKeyExchangeFlow | undefined;
    let flow: KeyExchangeFlow | undefined;
    let requestFrame: Uint8Array | undefined;
    let signal: AbortSignal | undefined;
    let abortListener: ReturnType<typeof addAbortListener> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    let invoked = false;
    let stopCode: 'raw-cancelled' | 'raw-timeout' | undefined;
    let observedResponse: KeyExchangeFlowResult | undefined;
    const controller = new AbortController();
    let resolveStopped!: (result: Sso12RawResult<KeyExchangeFlowResult>) => void;
    const stopped = new Promise<Sso12RawResult<KeyExchangeFlowResult>>((resolve) => {
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
        prepared?.cancel();
        flow?.cancel();

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

    let deadline = Infinity;

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

    const onAbort = (): void => stop('raw-cancelled');

    try {
        const input = configuration(options);
        const uin = input.uin;
        const version = input.version;
        const subAppId = input.subAppId;
        const timestamp = input.timestamp;
        const timeout = input.timeoutMs;
        const signer = input.buildReserved;
        const verifier = input.verifyRaw;
        const serverVerifier = input.verifyServerResponse;

        if (
            typeof uin !== 'string' ||
            !/^[0-9]{1,20}$/.test(uin) ||
            typeof version !== 'string' ||
            !version.length ||
            Buffer.byteLength(version) > 0xfffd ||
            typeof subAppId !== 'number' ||
            !Number.isInteger(subAppId) ||
            subAppId < 0 ||
            subAppId > 0x7fffffff ||
            typeof timestamp !== 'number' ||
            !Number.isInteger(timestamp) ||
            timestamp < 0 ||
            timestamp > 0xffffffff ||
            typeof timeout !== 'number' ||
            !Number.isInteger(timeout) ||
            timeout < 1 ||
            timeout > 0x7fffffff ||
            typeof signer !== 'function' ||
            isProxy(signer) ||
            typeof verifier !== 'function' ||
            isProxy(verifier) ||
            typeof serverVerifier !== 'function' ||
            isProxy(serverVerifier)
        ) {
            throw new TypeError('invalid key exchange configuration');
        }

        deadline = started + timeout;

        if (input.signal !== undefined) {
            if (isProxy(input.signal)) {
                throw new TypeError('invalid signal');
            }

            try {
                aborted.call(input.signal);
            } catch {
                throw new TypeError('invalid signal');
            }

            signal = input.signal as AbortSignal;
            abortListener = addAbortListener(signal, onAbort);

            if (aborted.call(signal)) {
                stop('raw-cancelled');
            }
        }

        if (active && performance.now() >= deadline) {
            stop('raw-timeout');
        }

        if (!active) {
            return await stopped;
        }

        const guid = track(snapshot(input.guid, MAX_SERVICE_FRAME_BYTES));
        const a2 = track(
            input.a2 === undefined
                ? new Uint8Array(0)
                : snapshot(input.a2, MAX_SERVICE_FRAME_BYTES),
        );
        const serverKey = track(snapshot(input.serverPublicKey, 65));
        const verifyKey = track(snapshot(input.verifyKey, 32));

        if (
            !guid.length ||
            serverKey.length !== 65 ||
            serverKey[0] !== 4 ||
            verifyKey.length !== 32 ||
            guid.length * 3 + a2.length + Buffer.byteLength(version) + 512 > MAX_SERVICE_FRAME_BYTES
        ) {
            throw new TypeError('invalid key exchange configuration');
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

        if (active && signal && aborted.call(signal)) {
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
        const guarded = guardBorrowedTransport<KeyExchangeFlow, KeyExchangeFlowResult>(stable, {
            disposeContext: (context) => context.cancel(),
            disposeResult,
        });
        const operation = guarded({
            timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())),
            signal: controller.signal,
            buildRequest: async (identity) => {
                let signerBody: Uint8Array | undefined;
                let reserved: Uint8Array | undefined;
                let returnedFrame: Uint8Array | undefined;
                let handedOff = false;

                try {
                    assertActive();

                    if (identity.uin !== uin) {
                        throw new Error('identity mismatch');
                    }

                    prepared = prepareKeyExchangeFlow({
                        uin,
                        guid,
                        version,
                        subAppId,
                        a2,
                        serverPublicKey: serverKey,
                        verifyKey,
                        timestamp,
                        sequence: identity.sequence | 0,
                        verifyServerResponse: (response) => {
                            assertActive();
                            const accepted = (
                                serverVerifier as KeyExchangeFlowInput['verifyServerResponse']
                            )({
                                ...response,
                                sequence: identity.sequence,
                            });
                            assertActive();
                            return accepted === true;
                        },
                    });
                    assertActive();
                    signerBody = track(snapshot(prepared.body, MAX_SERVICE_FRAME_BYTES));
                    const signed = await signer({
                        uin,
                        sequence: identity.sequence,
                        command: KEY_EXCHANGE_COMMAND,
                        body: signerBody,
                    });
                    assertActive();

                    if (
                        signerBody.length !== prepared.body.length ||
                        Buffer.compare(signerBody, prepared.body) !== 0
                    ) {
                        throw new Error('signer input changed');
                    }

                    reserved = track(snapshot(signed, MAX_SERVICE_FRAME_BYTES));
                    flow = prepared.finish(reserved);
                    returnedFrame = track(flow.request);
                    assertActive();
                    requestFrame = track(snapshot(returnedFrame, MAX_SERVICE_FRAME_BYTES));
                    assertActive();
                    handedOff = true;
                    return { frame: returnedFrame, context: flow };
                } finally {
                    release(signerBody);
                    release(reserved);

                    if (!handedOff) {
                        release(returnedFrame);
                        flow?.cancel();
                        prepared?.cancel();
                    }
                }
            },
            verifyCandidate: async (candidate, context, identity) => {
                let requestCopy: Uint8Array | undefined;
                let responseCopy: Uint8Array | undefined;

                try {
                    assertActive();

                    if (context !== flow || !requestFrame || identity.uin !== uin) {
                        throw new Error('identity mismatch');
                    }

                    requestCopy = track(snapshot(requestFrame, MAX_SERVICE_FRAME_BYTES));
                    responseCopy = track(snapshot(candidate, MAX_SERVICE_FRAME_BYTES));
                    const accepted = await verifier({
                        uin,
                        sequence: identity.sequence,
                        command: KEY_EXCHANGE_COMMAND,
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
            consumeCandidate: (candidate, context, identity) => {
                assertActive();

                if (context !== flow || identity.uin !== uin) {
                    throw new Error('identity mismatch');
                }

                // In a service response the dummy is byte 9; complete() performs
                // the full frame validation and decryption once after this check.
                if (candidate.length < 14 || candidate[9] !== 0) {
                    throw new Error('invalid service header');
                }

                assertActive();
                const temporary = context.complete(candidate);
                let key: Uint8Array | undefined;
                let ticket: Uint8Array | undefined;
                let committed = false;

                try {
                    assertActive();
                    key = snapshot(temporary.sessionKey, MAX_SERVICE_FRAME_BYTES);
                    ticket = snapshot(temporary.sessionTicket, MAX_SERVICE_FRAME_BYTES);
                    assertActive();
                    const result = {
                        sessionKey: key,
                        sessionTicket: ticket,
                        expiration: temporary.expiration,
                    };
                    committed = true;
                    return result;
                } finally {
                    disposeResult(temporary);

                    if (!committed) {
                        wipe(key);
                        wipe(ticket);
                    }
                }
            },
        });
        // Observe and dispose a late committed result after the local race has stopped.
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
            return result;
        }

        if (stopCode) {
            return {
                kind: 'failure',
                code: stopCode,
                writeState: invoked ? 'unknown' : 'not-written',
            };
        }

        return invoked ? { kind: 'failure', code: result.code, writeState: 'unknown' } : result;
    } finally {
        active = false;

        if (timer !== undefined) {
            clearTimeout(timer);
        }

        abortListener?.[Symbol.dispose]();

        clear();
        disposeResultIfPresent(observedResponse);
        controller.abort();
    }
}

function disposeResultIfPresent(result: KeyExchangeFlowResult | undefined): void {
    if (result) {
        disposeResult(result);
    }
}
