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
import { describe, expect, it, vi } from 'vitest';
import { KEY_EXCHANGE_COMMAND } from '../../src/direct/key-exchange-flow';
import {
    decodeKeyExchangeRequest,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
} from '../../src/direct/key-exchange-protobuf';
import {
    classifyLinuxEasyOwnerD2Candidate,
    createLinuxEasyAccountOwnerWithKeyCapability,
    extractLinuxEasyOwnerPushBody,
    isLinuxEasyOwnerPushActive,
} from '../../src/direct/linux-easy-account-owner';
import { createLinuxEasyPushProcessor } from '../../src/direct/linux-easy-push-processor';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import {
    createRawMultiplexClient,
    type RawMultiplexPushRoute,
} from '../../src/direct/raw-multiplex-client';
import { LINUX_EASY_LOGIN_COMMAND } from '../../src/direct/sso-reference-linux-easy-login-flow';
import { SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import { IdentityService } from '../../src/identity-service';
import { MSG_PUSH_CMD } from '../../src/msg-push';
import type { IncomingPacketPipeline } from '../../src/packet-pipeline';

// Synthetic local policy and peers only: no assertion of authentication or delivery.
const UIN = '123456';
const KE = 0x80000001;
const EASY = 0x80000002;
const REGISTER = 0x80000003;
const PUSH = 0xf000000a;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
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

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function waitUntil(predicate: () => boolean): Promise<void> {
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

function fixture(allowIncompleteFollowingFrame = false, deferSyntheticFirst = false) {
    const allocations: Uint8Array[] = [];

    const own = <T extends Uint8Array>(bytes: T): T => {
        allocations.push(bytes);
        return bytes;
    };

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
    const easyVerifyGate = deferred<boolean>();
    const firstClassified = deferred<void>();
    const deferredVerifyEntered = deferred<void>();
    const deferredVerifyGate = deferred<boolean>();
    const dispatched = deferred<void>();
    // A private synthetic test phase, not a claim about any peer's frame order.
    let syntheticPhase: 'awaiting-a' | 'awaiting-easy' | 'easy-seen' | 'a-replayed' = 'awaiting-a';
    const aAttempts: { phase: string; sequence: number | undefined; frame: Uint8Array }[] = [];
    const callbackFrames: { marker: string; frame: Uint8Array; route: RawMultiplexPushRoute }[] =
        [];
    const frames: Uint8Array[] = [];
    const classified: string[] = [];
    const pushOrigins: { id: number; sequence: number | undefined }[] = [];
    const held: number[] = [];
    const muxVerified: number[] = [];
    const fullVerified: number[] = [];
    const expectedFrames = new Map<number, Uint8Array>();
    const expectedBodies = new Map<number, Uint8Array>();
    let registeredSettled = false;
    let registeredSucceeded = false;
    let owner!: ReturnType<typeof createLinuxEasyAccountOwnerWithKeyCapability>;
    let processor!: ReturnType<typeof createLinuxEasyPushProcessor>;

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
                field(text(UIN)),
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
        expect(frame.subarray(accountStart + 4, accountEnd).toString()).toBe(UIN);
        const decrypted = own(qqTeaDecrypt(frame.subarray(accountEnd), useD2 ? d2Key : zero));
        const inner = own(Buffer.from(decrypted));
        const sequence = inner.readUInt32BE(4);
        let offset = 28;

        const take = (width: 2 | 4 = 4) => {
            const length = width === 2 ? inner.readUInt16BE(offset) : inner.readUInt32BE(offset);
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

    const meta = (sequence: number) => ({ uin: UIN, sequence, command: MSG_PUSH_CMD, retCode: 0 });
    const onPush = vi.fn((frame: Uint8Array, route: RawMultiplexPushRoute) => {
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
    });
    const mux = createRawMultiplexClient({
        uin: UIN,
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
        classify: (frame, identity) => {
            expect(identity.uin).toBe(UIN);

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
                    uin: UIN,
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
                expect(extractLinuxEasyOwnerPushBody(owner, frame, candidate!)).toBeUndefined();
            }

            classified.push(`push:${candidate!.sequence}`);
            pushOrigins.push({ id: candidate!.sequence, sequence: identity.sequence });
            firstClassified.resolve();
            return { kind: 'push', name: candidate!.command, id: candidate!.sequence };
        },
        verifyPush: (frame, route) => {
            const expected = expectedFrames.get(route.id);
            expect(expected).toBeDefined();
            expect(Array.from(frame)).toEqual(Array.from(expected!));
            muxVerified.push(route.id);

            if (deferSyntheticFirst && route.id === PUSH) {
                deferredVerifyEntered.resolve();
                return deferredVerifyGate.promise;
            }

            return true;
        },
        onPush,
    });
    owner = createLinuxEasyAccountOwnerWithKeyCapability();
    const identity = IdentityService.memory(UIN);
    let dispatchCount = 0;
    const dispatch = vi.fn(
        async (_meta: { serviceCmd: string; seqId: number }, _events: unknown[]) => {
            if (++dispatchCount === 2) {
                dispatched.resolve();
            }
        },
    );
    processor = createLinuxEasyPushProcessor({
        owner,
        uin: UIN,
        ingress: {
            uin: UIN,
            identity,
            pipeline: { processDecodedDirectEvents: dispatch } as unknown as IncomingPacketPipeline,
            pipelineIdentityBound: true,
            sourceAuthenticationHandled: true,
            maxBodyBytes: 65536,
            maxPendingBytes: 262144,
            maxPending: 8,
            maxEventsPerPush: 16,
        },
        queue: { maxFrameBytes: 65536, maxQueuedFrames: 8, maxQueuedBytes: 262144 },
        verifyRaw: (frame, candidate) => {
            expect(registeredSettled).toBe(true);
            const expected = expectedFrames.get(candidate.sequence);
            expect(expected).toBeDefined();
            expect(Array.from(frame)).toEqual(Array.from(expected!));
            expect(candidate).toEqual(meta(candidate.sequence));
            fullVerified.push(candidate.sequence);
            return true;
        },
    });
    const sign = vi.fn(() => own(Uint8Array.of(0xe1, 0xe2)));
    const options = {
        client: mux,
        trustedSuccessQuiescence: true as const,
        isUsable: () => !mux.closed,
        sessionTimeoutMs: 30000,
        login: {
            uin: UIN,
            guid,
            a2,
            version: 'header-v',
            subAppId: 42,
            serverPublicKey: own(Uint8Array.from(key(1).getPublicKey())),
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
                ({ uin, expiration }: { uin: string; expiration: number | undefined }) =>
                    uin === UIN && expiration === 300,
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
                ({ uin, uid, statusCode }: { uin: string; uid: string; statusCode: bigint }) =>
                    uin === UIN && uid === 'synthetic-uid' && statusCode === 0n,
            ),
        },
    };

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
        expectedBodies.set(sequence, body);
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
        expect(common.head.user.account).toBe(UIN);

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

    async function close() {
        const errors: unknown[] = [];

        try {
            easyVerifyGate.resolve(true);
            deferredVerifyGate.resolve(true);
        } catch (error) {
            errors.push(error);
        }

        try {
            processor.stop();
        } catch (error) {
            errors.push(error);
        }

        try {
            owner.close();
        } catch (error) {
            errors.push(error);
        }

        try {
            mux.close();
        } catch (error) {
            errors.push(error);
        }

        try {
            await bounded(processor.drain());
        } catch (error) {
            errors.push(error);
        }

        try {
            await bounded(identity.close());
        } catch (error) {
            errors.push(error);
        }

        for (const bytes of allocations) {
            try {
                bytes.fill(0);
            } catch (error) {
                errors.push(error);
            }
        }

        expectedFrames.clear();
        expectedBodies.clear();

        if (errors.length) {
            throw new AggregateError(errors, 'synthetic fixture cleanup failed');
        }
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

describe('synthetic raw multiplex + Linux Easy owner + push processor', () => {
    it.each(['success', 'register-failure', 'stop'] as const)(
        'holds the coalesced push through staged registration: %s',
        async (mode) => {
            const f = fixture();
            const pending = f.start();
            const errors: unknown[] = [];

            try {
                await bounded(f.written[0]!.promise);
                f.feedKey();
                await bounded(f.written[1]!.promise);
                const { first, second } = f.feedEasyAndPush();
                await bounded(f.easyVerifyEntered.promise);
                await bounded(turn());
                expect(f.classified).toEqual(['ke', 'easy']);
                expect(f.muxVerified).toEqual([]);
                expect(f.onPush).not.toHaveBeenCalled();
                expect(f.fullVerified).toEqual([]);
                expect(f.dispatch).not.toHaveBeenCalled();
                expect(f.settled()).toBe(false);
                expect(f.processor.activate()).toBe(false);
                f.easyVerifyGate.resolve(true);
                // Delivery and register write run independently: wait for both,
                // without asserting which occurs first or holding either worker.
                await Promise.all([
                    bounded(f.written[2]!.promise),
                    waitUntil(() => f.onPush.mock.calls.length >= 2),
                ]);
                expect(f.classified).toEqual(['ke', 'easy', `push:${PUSH}`, `push:${PUSH + 1}`]);
                expect(f.processor.status()).toBe('buffering');
                expect(f.settled()).toBe(false);
                expect(classifyLinuxEasyOwnerD2Candidate(f.owner, first.frame)).toEqual(
                    f.meta(PUSH),
                );
                expect(classifyLinuxEasyOwnerD2Candidate(f.owner, second.frame)).toEqual(
                    f.meta(PUSH + 1),
                );
                expect(
                    extractLinuxEasyOwnerPushBody(f.owner, first.frame, f.meta(PUSH)),
                ).toBeUndefined();
                expect(
                    extractLinuxEasyOwnerPushBody(f.owner, second.frame, f.meta(PUSH + 1)),
                ).toBeUndefined();
                expect(f.muxVerified).toEqual([PUSH, PUSH + 1]);
                expect(f.onPush.mock.results[0]).toMatchObject({
                    type: 'return',
                    value: undefined,
                });
                expect(f.onPush.mock.calls.map(([, route]) => route.id)).toEqual([PUSH, PUSH + 1]);
                expect(f.onPush.mock.results[1]).toMatchObject({
                    type: 'return',
                    value: undefined,
                });
                expect(f.fullVerified).toEqual([]);
                expect(f.dispatch).not.toHaveBeenCalled();

                if (mode === 'stop') {
                    f.processor.stop();
                    await bounded(f.processor.drain());
                    expect((await bounded(pending)).kind).toBe('failure');
                    expect(f.processor.activate()).toBe(false);
                } else {
                    f.feedRegister(mode === 'success');
                    const result = await bounded(pending);
                    expect(f.classified).toEqual([
                        'ke',
                        'easy',
                        `push:${PUSH}`,
                        `push:${PUSH + 1}`,
                        'register',
                    ]);
                    expect(f.options.register.verifyRaw).toHaveBeenCalledOnce();

                    if (mode === 'register-failure') {
                        expect(result).toMatchObject({ kind: 'failure', stage: 'register' });
                        f.processor.stop();
                        await bounded(f.processor.drain());
                        expect(f.processor.activate()).toBe(false);
                    } else {
                        expect(result).toEqual({ kind: 'registered', registerSequence: REGISTER });
                        expect(f.settled()).toBe(true);
                        expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(true);
                        expect(classifyLinuxEasyOwnerD2Candidate(f.owner, first.frame)).toEqual(
                            f.meta(PUSH),
                        );
                        const extracted = extractLinuxEasyOwnerPushBody(
                            f.owner,
                            first.frame,
                            f.meta(PUSH),
                        );

                        try {
                            expect(extracted).toBeDefined();
                            expect(Array.from(extracted!.body)).toEqual(Array.from(first.body));
                        } finally {
                            extracted?.body.fill(0);
                        }

                        expect(f.processor.activate()).toBe(true);
                        await bounded(f.dispatched.promise);
                        // The synchronous synthetic pipeline's local receipt chain
                        // settles after callback entry; this does not prove delivery.
                        await bounded(turn());
                        expect(f.processor.status()).toBe('active');
                        expect(f.onPush.mock.calls.map(([, route]) => route.id)).toEqual([
                            PUSH,
                            PUSH + 1,
                        ]);
                        expect(f.onPush.mock.results.map((result) => result.value)).toEqual([
                            undefined,
                            undefined,
                        ]);
                        expect(f.fullVerified).toEqual([PUSH, PUSH + 1]);
                        expect(f.dispatch).toHaveBeenCalledTimes(2);
                        expect(f.dispatch.mock.calls.map(([meta]) => meta)).toEqual([
                            { serviceCmd: MSG_PUSH_CMD, seqId: PUSH },
                            { serviceCmd: MSG_PUSH_CMD, seqId: PUSH + 1 },
                        ]);
                        // Check the relevant decoded event projection, not every field.
                        const third = f.push(PUSH + 2);
                        f.mux.feed(third.frame);
                        await bounded(waitUntil(() => f.dispatch.mock.calls.length >= 3));
                        await bounded(turn());
                        expect(f.classified).toEqual([
                            'ke',
                            'easy',
                            `push:${PUSH}`,
                            `push:${PUSH + 1}`,
                            'register',
                            `push:${PUSH + 2}`,
                        ]);
                        expect(f.muxVerified).toEqual([PUSH, PUSH + 1, PUSH + 2]);
                        expect(f.onPush.mock.calls.map(([, route]) => route.id)).toEqual([
                            PUSH,
                            PUSH + 1,
                            PUSH + 2,
                        ]);
                        expect(f.onPush.mock.results.map((result) => result.value)).toEqual([
                            undefined,
                            undefined,
                            undefined,
                        ]);
                        expect(f.fullVerified).toEqual([PUSH, PUSH + 1, PUSH + 2]);
                        expect(f.dispatch).toHaveBeenCalledTimes(3);
                        expect(f.dispatch.mock.calls.map(([meta]) => meta)).toEqual([
                            { serviceCmd: MSG_PUSH_CMD, seqId: PUSH },
                            { serviceCmd: MSG_PUSH_CMD, seqId: PUSH + 1 },
                            { serviceCmd: MSG_PUSH_CMD, seqId: PUSH + 2 },
                        ]);
                        expect(f.dispatch.mock.calls.map(([, events]) => events)).toMatchObject(
                            [PUSH, PUSH + 1, PUSH + 2].map((sequence) => [
                                {
                                    kind: 'friend_message',
                                    selfUin: Number(UIN),
                                    senderUin: 10001,
                                    elements: [{ type: 'text', text: `synthetic ${sequence}` }],
                                },
                            ]),
                        );
                        expect(f.processor.status()).toBe('active');
                        expect(f.mux.closed).toBe(false);
                    }
                }

                if (mode !== 'success') {
                    expect(f.fullVerified).toEqual([]);
                    expect(f.dispatch).not.toHaveBeenCalled();
                }

                expect(f.held.slice(0, 2)).toEqual([KE, EASY]);
                expect(f.frames).toHaveLength(3);
            } catch (error) {
                errors.push(error);
            } finally {
                try {
                    await f.close();
                } catch (error) {
                    errors.push(error);
                }

                try {
                    await bounded(pending.catch(() => undefined));
                } catch (error) {
                    errors.push(error);
                }
            }

            if (errors.length) {
                throw new AggregateError(errors, 'synthetic test or cleanup failed');
            }
        },
        20000,
    );

    it('replays a deferred synthetic D2 frame before a following push', async () => {
        const f = fixture(false, true);
        const pending = f.start();
        const errors: unknown[] = [];

        try {
            await bounded(f.written[0]!.promise);
            f.feedKey();
            await bounded(f.written[1]!.promise);
            // This is one synthetic feed, not an assertion about a real peer's order.
            const { first, second } = f.feedEasyAndPush();
            await bounded(f.easyVerifyEntered.promise);
            await bounded(turn());
            expect(f.classified).toEqual(['ke', 'easy']);
            expect(f.aAttempts).toHaveLength(1);
            expect(f.aAttempts[0]).toMatchObject({ phase: 'awaiting-a', sequence: EASY });
            expect(Array.from(f.aAttempts[0]!.frame)).toEqual(Array.from(first.frame));
            expect(f.frames).toHaveLength(2);
            expect(f.muxVerified).toEqual([]);
            expect(f.onPush).not.toHaveBeenCalled();
            expect(f.fullVerified).toEqual([]);
            expect(f.dispatch).not.toHaveBeenCalled();
            expect(f.settled()).toBe(false);
            expect(f.processor.status()).toBe('buffering');
            expect(f.processor.activate()).toBe(false);

            f.easyVerifyGate.resolve(true);
            await bounded(f.deferredVerifyEntered.promise);
            await bounded(turn());
            expect(f.aAttempts).toHaveLength(2);
            expect(f.aAttempts[1]).toMatchObject({ phase: 'easy-seen', sequence: EASY });
            expect(Array.from(f.aAttempts[1]!.frame)).toEqual(Array.from(first.frame));
            expect(f.classified).toEqual(['ke', 'easy', `push:${PUSH}`]);
            expect(f.muxVerified).toEqual([PUSH]);
            // A's independent raw verification has not returned; it is not in the FIFO yet.
            expect(f.frames).toHaveLength(2);
            expect(f.onPush).not.toHaveBeenCalled();
            expect(f.settled()).toBe(false);
            expect(f.fullVerified).toEqual([]);
            expect(f.dispatch).not.toHaveBeenCalled();

            f.deferredVerifyGate.resolve(true);
            await Promise.all([
                bounded(f.written[2]!.promise),
                bounded(waitUntil(() => f.onPush.mock.calls.length === 2)),
            ]);
            expect(f.classified).toEqual(['ke', 'easy', `push:${PUSH}`, `push:${PUSH + 1}`]);
            expect(f.pushOrigins).toEqual([
                { id: PUSH, sequence: EASY },
                { id: PUSH + 1, sequence: EASY },
            ]);
            expect(f.muxVerified).toEqual([PUSH, PUSH + 1]);
            expect(f.callbackFrames.map(({ marker }) => marker)).toEqual(['A', 'B']);
            expect(f.callbackFrames.map(({ route }) => route)).toEqual([
                { kind: 'push', name: MSG_PUSH_CMD, id: PUSH },
                { kind: 'push', name: MSG_PUSH_CMD, id: PUSH + 1 },
            ]);
            expect(Array.from(f.callbackFrames[0]!.frame)).toEqual(Array.from(first.frame));
            expect(Array.from(f.callbackFrames[1]!.frame)).toEqual(Array.from(second.frame));
            expect(f.onPush.mock.results.map((result) => result.value)).toEqual([
                undefined,
                undefined,
            ]);
            expect(f.frames).toHaveLength(3);
            expect(f.held.slice(0, 2)).toEqual([KE, EASY]);
            expect(f.settled()).toBe(false);
            expect(f.processor.status()).toBe('buffering');
            expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(false);

            for (const [frame, id] of [
                [first.frame, PUSH],
                [second.frame, PUSH + 1],
            ] as const) {
                expect(classifyLinuxEasyOwnerD2Candidate(f.owner, frame)).toEqual(f.meta(id));
                expect(extractLinuxEasyOwnerPushBody(f.owner, frame, f.meta(id))).toBeUndefined();
            }

            expect(f.fullVerified).toEqual([]);
            expect(f.dispatch).not.toHaveBeenCalled();
            expect(f.processor.activate()).toBe(false);

            f.feedRegister(true);
            expect(await bounded(pending)).toEqual({
                kind: 'registered',
                registerSequence: REGISTER,
            });
            expect(f.options.register.verifyRaw).toHaveBeenCalledOnce();
            expect(f.classified).toEqual([
                'ke',
                'easy',
                `push:${PUSH}`,
                `push:${PUSH + 1}`,
                'register',
            ]);
            expect(f.settled()).toBe(true);
            expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(true);

            for (const [item, id] of [
                [first, PUSH],
                [second, PUSH + 1],
            ] as const) {
                const extracted = extractLinuxEasyOwnerPushBody(f.owner, item.frame, f.meta(id));

                try {
                    expect(extracted).toBeDefined();
                    expect(extracted!.meta).toEqual(f.meta(id));
                    expect(Array.from(extracted!.body)).toEqual(Array.from(item.body));
                } finally {
                    extracted?.body.fill(0);
                }
            }

            expect(f.processor.activate()).toBe(true);
            await bounded(f.dispatched.promise);
            await bounded(turn());
            expect(f.fullVerified).toEqual([PUSH, PUSH + 1]);
            expect(f.dispatch.mock.calls.map(([meta]) => meta)).toEqual([
                { serviceCmd: MSG_PUSH_CMD, seqId: PUSH },
                { serviceCmd: MSG_PUSH_CMD, seqId: PUSH + 1 },
            ]);
            expect(f.dispatch.mock.calls.map(([, events]) => events)).toMatchObject(
                [PUSH, PUSH + 1].map((sequence) => [
                    {
                        kind: 'friend_message',
                        selfUin: Number(UIN),
                        senderUin: 10001,
                        elements: [{ type: 'text', text: `synthetic ${sequence}` }],
                    },
                ]),
            );
            expect(f.processor.status()).toBe('active');
            expect(f.mux.closed).toBe(false);
        } catch (error) {
            errors.push(error);
        } finally {
            try {
                await f.close();
            } catch (error) {
                errors.push(error);
            }

            try {
                await bounded(pending.catch(() => undefined));
            } catch (error) {
                errors.push(error);
            }
        }

        if (errors.length) {
            throw new AggregateError(errors, 'synthetic deferred-frame test or cleanup failed');
        }
    }, 20000);

    it('retains the Easy origin of a synthetic split push across registration', async () => {
        const f = fixture(true);
        const pending = f.start();
        const errors: unknown[] = [];

        try {
            await bounded(f.written[0]!.promise);
            f.feedKey();
            await bounded(f.written[1]!.promise);
            const { first } = f.feedEasyAndPush(true);
            await bounded(f.easyVerifyEntered.promise);
            expect(f.classified).toEqual(['ke', 'easy']);
            expect(f.frames).toHaveLength(2);
            expect(f.onPush).not.toHaveBeenCalled();
            f.easyVerifyGate.resolve(true);

            // No more input arrives until the next transaction has actually written.
            await bounded(f.written[2]!.promise);
            expect(f.frames).toHaveLength(3);
            expect(f.settled()).toBe(false);
            expect(f.mux.closed).toBe(false);
            expect(f.classified).toEqual(['ke', 'easy']);
            expect(f.dispatch).not.toHaveBeenCalled();
            f.mux.feed(first.frame.subarray(1));
            await bounded(waitUntil(() => f.onPush.mock.calls.length === 1));
            expect(f.pushOrigins).toEqual([{ id: PUSH, sequence: EASY }]);
            expect(f.classified).toEqual(['ke', 'easy', `push:${PUSH}`]);
            expect(f.muxVerified).toEqual([PUSH]);
            expect(f.onPush.mock.calls[0]![1]).toEqual({
                kind: 'push',
                name: MSG_PUSH_CMD,
                id: PUSH,
            });
            expect(f.onPush.mock.results[0]).toMatchObject({ type: 'return', value: undefined });
            expect(f.processor.status()).toBe('buffering');
            expect(f.settled()).toBe(false);
            expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(false);
            expect(classifyLinuxEasyOwnerD2Candidate(f.owner, first.frame)).toEqual(f.meta(PUSH));
            expect(
                extractLinuxEasyOwnerPushBody(f.owner, first.frame, f.meta(PUSH)),
            ).toBeUndefined();
            expect(f.fullVerified).toEqual([]);
            expect(f.dispatch).not.toHaveBeenCalled();

            f.feedRegister(true);
            expect(await bounded(pending)).toEqual({
                kind: 'registered',
                registerSequence: REGISTER,
            });
            expect(f.classified).toEqual(['ke', 'easy', `push:${PUSH}`, 'register']);
            expect(f.options.register.verifyRaw).toHaveBeenCalledOnce();
            expect(f.settled()).toBe(true);
            expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(true);
            expect(classifyLinuxEasyOwnerD2Candidate(f.owner, first.frame)).toEqual(f.meta(PUSH));
            const extracted = extractLinuxEasyOwnerPushBody(f.owner, first.frame, f.meta(PUSH));

            try {
                expect(extracted).toBeDefined();
                expect(extracted!.meta).toEqual(f.meta(PUSH));
                expect(Array.from(extracted!.body)).toEqual(Array.from(first.body));
            } finally {
                extracted?.body.fill(0);
            }

            expect(f.processor.activate()).toBe(true);
            await bounded(waitUntil(() => f.dispatch.mock.calls.length === 1));
            await bounded(turn());
            expect(f.fullVerified).toEqual([PUSH]);
            expect(f.dispatch).toHaveBeenCalledTimes(1);
            expect(f.dispatch.mock.calls[0]![0]).toEqual({
                serviceCmd: MSG_PUSH_CMD,
                seqId: PUSH,
            });
            expect(f.dispatch.mock.calls[0]![1]).toMatchObject([
                {
                    kind: 'friend_message',
                    selfUin: Number(UIN),
                    senderUin: 10001,
                    elements: [{ type: 'text', text: `synthetic ${PUSH}` }],
                },
            ]);
            expect(f.processor.status()).toBe('active');
            expect(f.mux.closed).toBe(false);
        } catch (error) {
            errors.push(error);
        } finally {
            try {
                await f.close();
            } catch (error) {
                errors.push(error);
            }

            try {
                await bounded(pending.catch(() => undefined));
            } catch (error) {
                errors.push(error);
            }
        }

        if (errors.length) {
            throw new AggregateError(errors, 'synthetic split-frame test or cleanup failed');
        }
    }, 20000);
});
