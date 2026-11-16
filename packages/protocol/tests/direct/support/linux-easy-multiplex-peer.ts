import { createCipheriv, createDecipheriv, createECDH } from 'node:crypto';
import type {
    LinuxNTEasyLoginReferenceRequestBody,
    LinuxNTEasyLoginReferenceResponseBody,
    LinuxNTLoginReferenceCommon,
    LinuxNTLoginReferenceForward,
    LinuxNTLoginReferenceResponseCommon,
    NTLoginForwardRequest,
} from '@snowluma/proto-defs/direct-login';
import type { PushMsg } from '@snowluma/proto-defs/message';
import type { SsoRegisterRequest, SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { expect, vi } from 'vitest';
import { KEY_EXCHANGE_COMMAND } from '../../../src/direct/key-exchange-flow';
import {
    decodeKeyExchangeRequest,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
} from '../../../src/direct/key-exchange-protobuf';
import {
    classifyLinuxEasyOwnerD2Candidate,
    createLinuxEasyAccountOwnerWithKeyCapability,
    extractLinuxEasyOwnerPushBody,
    isLinuxEasyOwnerPushActive,
} from '../../../src/direct/linux-easy-account-owner';
import {
    createLinuxEasyPushProcessor,
    type LinuxEasyPushProcessor,
    type LinuxEasyPushProcessorOptions,
} from '../../../src/direct/linux-easy-push-processor';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../../src/direct/qq-tea';
import {
    createRawMultiplexClient,
    type RawMultiplexPushRoute,
} from '../../../src/direct/raw-multiplex-client';
import { LINUX_EASY_LOGIN_COMMAND } from '../../../src/direct/sso-reference-linux-easy-login-flow';
import { SSO_INFO_SYNC_COMMAND } from '../../../src/direct/sso-register';
import { IdentityService } from '../../../src/identity-service';
import { MSG_PUSH_CMD } from '../../../src/msg-push';
import type { IncomingPacketPipeline } from '../../../src/packet-pipeline';

// Synthetic local policy and peers only: no assertion of authentication or delivery.
export const UIN = '123456';
export const KE = 0x80000001;
export const EASY = 0x80000002;
export const REGISTER = 0x80000003;
export const PUSH = 0xf000000a;

export type PeerProcessorInput = Pick<
    LinuxEasyPushProcessorOptions,
    'owner' | 'queue' | 'verifyRaw'
> & {
    ingress: Pick<
        LinuxEasyPushProcessorOptions['ingress'],
        | 'sourceAuthenticationHandled'
        | 'maxBodyBytes'
        | 'maxPendingBytes'
        | 'maxPending'
        | 'maxEventsPerPush'
    >;
};

export interface PeerFixtureOptions {
    uin?: string;
    createProcessor?: (input: PeerProcessorInput) => LinuxEasyPushProcessor;
}

/** An initialization failure carries the promise for teardown of any created resources. */
export class PeerFixtureInitializationError extends Error {
    readonly cleanup: Promise<void>;

    constructor(cause: unknown, cleanup: Promise<void>) {
        super('synthetic fixture initialization failed', { cause });
        this.cleanup = cleanup;
    }
}

export function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

export async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('synthetic multiplex watchdog')), 4000);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

export const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

export function waitUntil(predicate: () => boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let immediate: ReturnType<typeof setImmediate> | undefined;
        const timer = setTimeout(() => {
            if (immediate !== undefined) {
                clearImmediate(immediate);
            }

            reject(new Error('synthetic push delivery watchdog'));
        }, 4000);

        const check = () => {
            try {
                if (predicate()) {
                    clearTimeout(timer);
                    resolve();
                } else {
                    immediate = setImmediate(check);
                }
            } catch (error) {
                clearTimeout(timer);
                reject(error);
            }
        };

        check();
    });
}

export function fixture(
    allowIncompleteFollowingFrame = false,
    deferSyntheticFirst = false,
    fixtureOptions: PeerFixtureOptions = {},
) {
    const uin = fixtureOptions.uin ?? UIN;
    const createProcessor = fixtureOptions.createProcessor;
    const allocations: Uint8Array[] = [];
    const callbackErrors: unknown[] = [];
    const expectedFrames = new Map<number, Uint8Array>();
    const expectedBodies = new Map<number, Uint8Array>();
    const easyVerifyGate = deferred<boolean>();
    const deferredVerifyGate = deferred<boolean>();
    const starts: Promise<unknown>[] = [];
    let owner!: ReturnType<typeof createLinuxEasyAccountOwnerWithKeyCapability>;
    let mux!: ReturnType<typeof createRawMultiplexClient>;
    let processor!: LinuxEasyPushProcessor;
    let identity: IdentityService | undefined;
    let closePromise: Promise<void> | undefined;
    let closing = false;

    const own = <T extends Uint8Array>(bytes: T): T => {
        if (closing) {
            bytes.fill(0);
            throw new Error('synthetic fixture is closed');
        }

        allocations.push(bytes);
        return bytes;
    };

    const captureCallbackError = <T>(run: () => T): T => {
        try {
            return run();
        } catch (error) {
            callbackErrors.push(error);
            throw error;
        }
    };

    async function cleanupResources(): Promise<void> {
        const errors: unknown[] = [];

        try {
            easyVerifyGate.resolve(true);
            deferredVerifyGate.resolve(true);
        } catch (error) {
            errors.push(error);
        }

        try {
            processor?.stop();
        } catch (error) {
            errors.push(error);
        }

        try {
            owner?.close();
        } catch (error) {
            errors.push(error);
        }

        try {
            mux?.close();
        } catch (error) {
            errors.push(error);
        }

        try {
            if (processor) {
                await bounded(processor.drain());
            }
        } catch (error) {
            errors.push(error);
        }

        try {
            if (mux) {
                await bounded(mux.whenClosed);
            }
        } catch (error) {
            errors.push(error);
        }

        try {
            await bounded(Promise.all(starts.map((pending) => pending.catch(() => undefined))));
        } catch (error) {
            errors.push(error);
        }

        try {
            if (identity) {
                await bounded(identity.close());
            }
        } catch (error) {
            errors.push(error);
        }

        // Timed-out synthetic work may still be pending. Wiping our allocations is
        // best effort and does not prove that an uncooperative callback settled.
        for (const bytes of allocations) {
            try {
                bytes.fill(0);
            } catch (error) {
                errors.push(error);
            }
        }

        allocations.length = 0;
        expectedFrames.clear();
        expectedBodies.clear();

        if (callbackErrors.length) {
            errors.push(new AggregateError(callbackErrors, 'synthetic callback failed'));
        }

        if (errors.length) {
            throw new AggregateError(errors, 'synthetic fixture cleanup failed');
        }
    }

    function close(): Promise<void> {
        if (closePromise) {
            return closePromise;
        }

        closing = true;
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        closePromise = new Promise<void>((done, fail) => {
            resolve = done;
            reject = fail;
        });
        void cleanupResources().then(resolve, reject);
        return closePromise;
    }

    function initialize() {
        const word = (value: number) => {
            const bytes = own(Buffer.alloc(4));
            bytes.writeUInt32BE(value >>> 0);
            return bytes;
        };

        const field = (bytes: Uint8Array) => own(Buffer.concat([word(bytes.length + 4), bytes]));
        const text = (value: string) => own(Buffer.from(value));
        const empty = () => own(Buffer.alloc(0));
        const zero = own(new Uint8Array(16));
        const sessionKey = own(Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i));
        const sessionTicket = own(Uint8Array.from({ length: 24 }, (_, i) => 0x60 + i));
        const d2Key = own(Uint8Array.from({ length: 16 }, (_, i) => 0x80 + i));
        const d2 = own(Uint8Array.of(0x31, 0, 0x33));
        const a1 = own(Uint8Array.of(0x11, 0, 0x12));
        const a2 = own(Uint8Array.of(0x21, 0, 0x22));
        const guid = own(Uint8Array.of(0xab, 0xcd));
        const nonce = own(Uint8Array.from({ length: 12 }, (_, i) => i));
        const written = [deferred<void>(), deferred<void>(), deferred<void>()];
        const easyVerifyEntered = deferred<void>();
        const firstClassified = deferred<void>();
        const deferredVerifyEntered = deferred<void>();
        const dispatched = deferred<void>();
        // A private synthetic test phase, not a claim about any peer's frame order.
        let syntheticPhase: 'awaiting-a' | 'awaiting-easy' | 'easy-seen' | 'a-replayed' =
            'awaiting-a';
        const aAttempts: { phase: string; sequence: number | undefined; frame: Uint8Array }[] = [];
        const callbackFrames: {
            marker: string;
            frame: Uint8Array;
            route: RawMultiplexPushRoute;
        }[] = [];
        const frames: Uint8Array[] = [];
        const classified: string[] = [];
        const pushOrigins: { id: number; sequence: number | undefined }[] = [];
        const held: number[] = [];
        const muxVerified: number[] = [];
        const fullVerified: number[] = [];
        let registeredSettled = false;
        let registeredSucceeded = false;

        function key(scalar: number) {
            const result = createECDH('prime256v1');
            const privateKey = own(Buffer.alloc(32));
            privateKey[31] = scalar;
            result.setPrivateKey(privateKey);
            return result;
        }

        function seal(plain: Uint8Array, secret: Uint8Array, ivByte: number) {
            const iv = own(Buffer.alloc(12, ivByte));
            const cipher = createCipheriv(
                secret.length === 32 ? 'aes-256-gcm' : 'aes-128-gcm',
                secret,
                iv,
            );
            return own(
                Buffer.concat([
                    iv,
                    own(cipher.update(plain)),
                    own(cipher.final()),
                    own(cipher.getAuthTag()),
                ]),
            );
        }

        function response(sequence: number, command: string, body: Uint8Array, useD2: boolean) {
            const header = own(
                Buffer.concat([
                    word(sequence),
                    word(0),
                    field(empty()),
                    field(text(command)),
                    field(empty()),
                    word(0),
                    field(empty()),
                ]),
            );
            const inner = own(Buffer.concat([field(header), field(body)]));
            const encrypted = own(qqTeaEncrypt(inner, useD2 ? d2Key : zero));
            const frame = own(
                Buffer.concat([
                    word(0),
                    word(12),
                    own(Buffer.of(useD2 ? 1 : 2, 0)),
                    field(text(uin)),
                    encrypted,
                ]),
            );
            frame.writeUInt32BE(frame.length);
            return frame;
        }

        // Inspect the actual captured write, including SSO sequence and command.
        function unpack(input: Uint8Array, useD2: boolean) {
            const frame = own(Buffer.from(input));
            expect(frame.readUInt32BE(0)).toBe(frame.length);
            const d2End = 9 + frame.readUInt32BE(9);
            const accountStart = d2End + 1;
            const accountEnd = accountStart + frame.readUInt32BE(accountStart);
            expect(frame.subarray(accountStart + 4, accountEnd).toString()).toBe(uin);
            const decrypted = own(qqTeaDecrypt(frame.subarray(accountEnd), useD2 ? d2Key : zero));
            const inner = own(Buffer.from(decrypted));
            const sequence = inner.readUInt32BE(4);
            let offset = 28;

            const take = (width: 2 | 4 = 4) => {
                const length =
                    width === 2 ? inner.readUInt16BE(offset) : inner.readUInt32BE(offset);
                expect(length).toBeGreaterThanOrEqual(width);
                expect(offset + length).toBeLessThanOrEqual(inner.length);
                const value = inner.subarray(offset + width, offset + length);
                offset += length;
                return value;
            };

            take();
            const command = take().toString();
            take();
            take();
            take();
            take(2);
            take();
            expect(offset).toBe(inner.readUInt32BE(0));
            const body = take();
            expect(offset).toBe(inner.length);
            return { sequence, command, body };
        }

        const meta = (sequence: number) => ({ uin, sequence, command: MSG_PUSH_CMD, retCode: 0 });
        const onPush = vi.fn((frame: Uint8Array, route: RawMultiplexPushRoute) =>
            captureCallbackError(() => {
                const expected = expectedFrames.get(route.id);
                expect(expected).toBeDefined();
                expect(Array.from(frame)).toEqual(Array.from(expected!));

                if (deferSyntheticFirst) {
                    const marker = [PUSH, PUSH + 1].find((id) => {
                        const snapshot = expectedFrames.get(id);
                        return (
                            snapshot !== undefined &&
                            frame.length === snapshot.length &&
                            frame.every((value, index) => value === snapshot[index])
                        );
                    });
                    expect(marker).toBeDefined();
                    callbackFrames.push({
                        marker: marker === PUSH ? 'A' : 'B',
                        frame: own(Uint8Array.from(frame)),
                        route: { ...route },
                    });
                }

                return processor.onPush(frame, route);
            }),
        );
        mux = createRawMultiplexClient({
            uin,
            initialSequence: KE,
            defaultTimeoutMs: 5000,
            maxFrameBytes: 65536,
            maxBufferedBytes: 262144,
            maxFrames: 8,
            maxPushFrames: 8,
            maxPushBytes: 262144,
            ...(allowIncompleteFollowingFrame ? { allowIncompleteFollowingFrame: true } : {}),
            ...(deferSyntheticFirst ? { allowDeferredFrames: true } : {}),
            write: (bytes) => {
                const index = frames.length;
                frames.push(own(Uint8Array.from(bytes)));
                written[index]?.resolve();
            },
            holdFollowingFrames: ({ sequence }) => {
                held.push(sequence);
                return sequence === EASY;
            },
            classify: (frame, identity) =>
                captureCallbackError(() => {
                    expect(identity.uin).toBe(uin);

                    if (frame[8] === 2) {
                        expect(identity.sequence === KE || identity.sequence === EASY).toBe(true);
                        classified.push(identity.sequence === KE ? 'ke' : 'easy');

                        if (deferSyntheticFirst && identity.sequence === EASY) {
                            expect(syntheticPhase).toBe('awaiting-easy');
                            syntheticPhase = 'easy-seen';
                        }

                        return { kind: 'response', sequence: identity.sequence! };
                    }

                    const candidate = classifyLinuxEasyOwnerD2Candidate(owner, frame);
                    const firstFrame = expectedFrames.get(PUSH);
                    const isSyntheticA =
                        deferSyntheticFirst &&
                        firstFrame !== undefined &&
                        frame.length === firstFrame.length &&
                        frame.every((value, index) => value === firstFrame[index]);

                    if (isSyntheticA) {
                        aAttempts.push({
                            phase: syntheticPhase,
                            sequence: identity.sequence,
                            frame: own(Uint8Array.from(frame)),
                        });

                        if (syntheticPhase === 'awaiting-a') {
                            expect(candidate).toBeUndefined();
                            expect(isLinuxEasyOwnerPushActive(owner)).toBe(false);
                            syntheticPhase = 'awaiting-easy';
                            return { kind: 'defer' };
                        }

                        expect(syntheticPhase).toBe('easy-seen');
                        expect(candidate).toEqual(meta(PUSH));
                        syntheticPhase = 'a-replayed';
                    }

                    expect(candidate).toBeDefined();

                    if (candidate!.command === SSO_INFO_SYNC_COMMAND) {
                        expect(candidate).toEqual({
                            uin,
                            sequence: REGISTER,
                            command: SSO_INFO_SYNC_COMMAND,
                            retCode: 0,
                        });
                        classified.push('register');
                        return { kind: 'response', sequence: candidate!.sequence };
                    }

                    expect(candidate).toEqual(meta(candidate!.sequence));

                    if (registeredSucceeded) {
                        expect(registeredSettled).toBe(true);
                        expect(isLinuxEasyOwnerPushActive(owner)).toBe(true);
                        const expected = expectedBodies.get(candidate!.sequence);
                        expect(expected).toBeDefined();
                        const extracted = extractLinuxEasyOwnerPushBody(owner, frame, candidate!);

                        try {
                            expect(extracted).toBeDefined();
                            expect(extracted!.meta).toEqual(meta(candidate!.sequence));
                            expect(Array.from(extracted!.body)).toEqual(Array.from(expected!));
                        } finally {
                            extracted?.body.fill(0);
                        }
                    } else {
                        expect(registeredSettled).toBe(false);
                        expect(isLinuxEasyOwnerPushActive(owner)).toBe(false);
                        expect(
                            extractLinuxEasyOwnerPushBody(owner, frame, candidate!),
                        ).toBeUndefined();
                    }

                    classified.push(`push:${candidate!.sequence}`);
                    pushOrigins.push({ id: candidate!.sequence, sequence: identity.sequence });
                    firstClassified.resolve();
                    return { kind: 'push', name: candidate!.command, id: candidate!.sequence };
                }),
            verifyPush: (frame, route) =>
                captureCallbackError(() => {
                    const expected = expectedFrames.get(route.id);
                    expect(expected).toBeDefined();
                    expect(Array.from(frame)).toEqual(Array.from(expected!));
                    muxVerified.push(route.id);

                    if (deferSyntheticFirst && route.id === PUSH) {
                        deferredVerifyEntered.resolve();
                        return deferredVerifyGate.promise;
                    }

                    return true;
                }),
            onPush,
        });
        owner = createLinuxEasyAccountOwnerWithKeyCapability();
        let dispatchCount = 0;
        const dispatch = vi.fn(
            async (_meta: { serviceCmd: string; seqId: number }, _events: unknown[]) => {
                if (++dispatchCount === 2) {
                    dispatched.resolve();
                }
            },
        );
        const processorInput: PeerProcessorInput = {
            owner,
            queue: { maxFrameBytes: 65536, maxQueuedFrames: 8, maxQueuedBytes: 262144 },
            verifyRaw: (frame, candidate) =>
                captureCallbackError(() => {
                    expect(registeredSettled).toBe(true);
                    const expected = expectedFrames.get(candidate.sequence);
                    expect(expected).toBeDefined();
                    expect(Array.from(frame)).toEqual(Array.from(expected!));
                    expect(candidate).toEqual(meta(candidate.sequence));
                    fullVerified.push(candidate.sequence);
                    return true;
                }),
            ingress: {
                sourceAuthenticationHandled: true,
                maxBodyBytes: 65536,
                maxPendingBytes: 262144,
                maxPending: 8,
                maxEventsPerPush: 16,
            },
        };
        const sign = vi.fn(() => own(Uint8Array.of(0xe1, 0xe2)));
        const options = {
            client: mux,
            trustedSuccessQuiescence: true as const,
            isUsable: () => !mux.closed,
            sessionTimeoutMs: 30000,
            login: {
                uin,
                guid,
                a2,
                version: 'header-v',
                subAppId: 42,
                serverPublicKey: own(Uint8Array.from(own(key(1).getPublicKey()))),
                verifyKey: own(Uint8Array.from({ length: 32 }, (_, i) => i + 1)),
                timestamp: 1700000000,
                a1,
                nonce,
                deviceName: 'synthetic-device',
                deviceType: 'synthetic-type',
                appId: 42,
                appName: 'synthetic-app',
                qua: 'synthetic-qua',
                cookie: 'synthetic-cookie',
                timeoutMs: 5000,
                buildReserved: sign,
                verifyRaw: async ({ sequence }: { sequence: number }) => {
                    if (sequence === EASY) {
                        easyVerifyEntered.resolve();
                        return await easyVerifyGate.promise;
                    }

                    expect(sequence).toBe(KE);
                    return true;
                },
                verifyServerResponse: vi.fn(() => true),
                acceptKeyExchange: vi.fn(
                    ({
                        uin: account,
                        expiration,
                    }: {
                        uin: string;
                        expiration: number | undefined;
                    }) => account === uin && expiration === 300,
                ),
            },
            register: {
                profile: { guid: own(Uint8Array.from(guid)), version: 'header-v', subAppId: 42 },
                registration: {
                    uid: 'synthetic-uid',
                    version: 'build-v',
                    deviceName: 'synthetic-device',
                    deviceType: 'synthetic-type',
                    vendorOs: 'synthetic-os',
                    random: 4,
                },
                timeoutMs: 5000,
                buildReserved: sign,
                verifyRaw: vi.fn(() => true),
                acceptLogin: vi.fn(
                    ({
                        uin: account,
                        uid,
                        statusCode,
                    }: {
                        uin: string;
                        uid: string;
                        statusCode: bigint;
                    }) => account === uin && uid === 'synthetic-uid' && statusCode === 0n,
                ),
            },
        };

        if (createProcessor) {
            processor = createProcessor(processorInput);
        } else {
            identity = IdentityService.memory(uin);
            processor = createLinuxEasyPushProcessor({
                owner: processorInput.owner,
                uin,
                queue: processorInput.queue,
                verifyRaw: processorInput.verifyRaw,
                ingress: {
                    uin,
                    identity,
                    pipeline: {
                        processDecodedDirectEvents: dispatch,
                    } as unknown as IncomingPacketPipeline,
                    pipelineIdentityBound: true,
                    ...processorInput.ingress,
                },
            });
        }

        function feedKey() {
            const request = unpack(frames[0]!, false);
            expect(request.sequence).toBe(KE);
            expect(request.command).toBe(KEY_EXCHANGE_COMMAND);
            const decoded = decodeKeyExchangeRequest(request.body);

            if (!decoded.publicKey) {
                throw new Error('missing synthetic public key');
            }

            own(decoded.publicKey);

            if (decoded.secret) {
                own(decoded.secret);
            }

            if (decoded.verifyHash) {
                own(decoded.verifyHash);
            }

            const server = key(2);
            const shared = own(server.computeSecret(decoded.publicKey));
            const secret = own(
                encodeKeyExchangeResponseSecret({ sessionKey, sessionTicket, expiration: 300 }),
            );
            const body = own(
                encodeKeyExchangeResponse({
                    publicKey: own(server.getPublicKey()),
                    secret: seal(secret, shared, 0x42),
                }),
            );
            mux.feed(response(KE, request.command, body, false));
        }

        function push(sequence: number) {
            const body = own(
                protobuf_encode<PushMsg>({
                    message: {
                        responseHead: { fromUin: 10001, fromUid: 'synthetic_peer' },
                        contentHead: {
                            msgType: 166,
                            sequence: sequence & 0xffff,
                            ntMsgSeq: 63214 + (sequence & 0xffff),
                            timestamp: 1700000000,
                            msgId: sequence & 0xffff,
                        },
                        body: { richText: { elems: [{ text: { str: `synthetic ${sequence}` } }] } },
                    },
                }),
            );
            const frame = response(sequence, MSG_PUSH_CMD, body, true);
            expectedFrames.set(sequence, own(Uint8Array.from(frame)));
            expectedBodies.set(sequence, own(Uint8Array.from(body)));
            return { body, frame };
        }

        function feedEasyAndPush(incomplete = false) {
            const request = unpack(frames[1]!, false);
            expect(request.sequence).toBe(EASY);
            expect(request.command).toBe(LINUX_EASY_LOGIN_COMMAND);
            const forward = protobuf_decode<LinuxNTLoginReferenceForward>(request.body);
            own(forward.sessionTicket);
            own(forward.buffer);
            expect(Array.from(forward.sessionTicket)).toEqual(Array.from(sessionTicket));
            expect(forward.type).toBe(1);
            expect(forward.buffer.length).toBeGreaterThan(28);
            const encrypted = Buffer.from(forward.buffer);
            own(encrypted);
            const decipher = createDecipheriv('aes-128-gcm', sessionKey, encrypted.subarray(0, 12));
            decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
            const clear = own(
                Buffer.concat([
                    own(decipher.update(encrypted.subarray(12, encrypted.length - 16))),
                    own(decipher.final()),
                ]),
            );
            const common = protobuf_decode<LinuxNTLoginReferenceCommon>(clear);
            expect(common.head.user.account).toBe(uin);

            if (!common.body) {
                throw new Error('missing synthetic EasyLogin body');
            }

            own(common.body);
            const easyRequest = protobuf_decode<LinuxNTEasyLoginReferenceRequestBody>(common.body);

            if (!easyRequest.a1) {
                throw new Error('missing synthetic a1');
            }

            own(easyRequest.a1);
            expect(Array.from(easyRequest.a1)).toEqual(Array.from(a1));
            const tickets = own(
                protobuf_encode<LinuxNTEasyLoginReferenceResponseBody>({
                    tickets: { a1, a2, d2, d2Key },
                }),
            );
            const plain = own(
                protobuf_encode<LinuxNTLoginReferenceResponseCommon>({
                    head: { errorInfo: { code: 0n } },
                    body: tickets,
                }),
            );
            const body = own(
                protobuf_encode<NTLoginForwardRequest>({
                    sessionTicket: own(Uint8Array.of(0x42)),
                    buffer: seal(plain, sessionKey, 0x51),
                    type: 1,
                }),
            );
            const first = push(PUSH);
            const second = push(PUSH + 1);
            mux.feed(
                own(
                    Buffer.concat([
                        ...(deferSyntheticFirst ? [first.frame] : []),
                        response(EASY, request.command, body, false),
                        ...(incomplete
                            ? [first.frame.subarray(0, 1)]
                            : deferSyntheticFirst
                              ? [second.frame]
                              : [first.frame, second.frame]),
                    ]),
                ),
            );
            return { first, second };
        }

        function feedRegister(success: boolean) {
            const request = unpack(frames[2]!, true);
            expect(request.sequence).toBe(REGISTER);
            expect(request.command).toBe(SSO_INFO_SYNC_COMMAND);
            const decoded = protobuf_decode<SsoRegisterRequest>(request.body);
            expect(decoded.register?.buildVersion).toBe('build-v');
            expect(decoded.register?.guid).toBe('ABCD');
            expect(decoded.random).toBe(4);
            const body = own(
                protobuf_encode<SsoRegisterResponse>({
                    register: { message: success ? 'register success' : 'synthetic rejected' },
                }),
            );
            mux.feed(response(REGISTER, request.command, body, true));
        }

        function start() {
            const pending = owner.start(options);
            starts.push(pending);
            void pending.then(
                (result) => {
                    registeredSucceeded = result.kind === 'registered';
                    registeredSettled = true;
                },
                () => {
                    registeredSettled = true;
                },
            );
            return pending;
        }

        return {
            mux,
            owner,
            processor,
            options,
            frames,
            written,
            easyVerifyEntered,
            easyVerifyGate,
            firstClassified,
            deferredVerifyEntered,
            deferredVerifyGate,
            dispatched,
            aAttempts,
            callbackFrames,
            classified,
            pushOrigins,
            held,
            muxVerified,
            fullVerified,
            dispatch,
            onPush,
            feedKey,
            feedEasyAndPush,
            feedRegister,
            push,
            start,
            close,
            meta,
            settled: () => registeredSettled,
        };
    }

    try {
        return initialize();
    } catch (error) {
        const cleanup = close();
        // Keep teardown failures observable through error.cleanup even when the
        // caller has not attached its own rejection handler yet.
        void cleanup.catch(() => undefined);
        throw new PeerFixtureInitializationError(error, cleanup);
    }
}
