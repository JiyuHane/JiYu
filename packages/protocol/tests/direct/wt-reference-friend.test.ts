import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode, type bytes } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
    LinuxFriendAddResponseBody,
    LinuxFriendAddUinBody,
    LinuxFriendSettingUinBody,
    LinuxFriendSettingUinResponseBody,
} from '@snowluma/proto-defs/linux-friend';
import type { DirectThirdPartyLoginResponse } from '@snowluma/proto-defs/direct-login';
import type { SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { createWtMultiplexReference } from '../../src/direct/wt-multiplex-reference';
import {
    WtReferenceFriendError,
    prepareReferenceFriendInput,
    disposePreparedReferenceFriendInput,
    type WtReferenceFriendInput,
} from '../../src/direct/wt-reference-friend-flow';
import {
    LINUX_FRIEND_ADD_COMMAND as ADD,
    LINUX_FRIEND_SETTING_COMMAND as QUERY,
} from '../../src/direct/linux-friend-request';
import * as responses from '../../src/direct/linux-friend-response';
import * as friendFlow from '../../src/direct/wt-reference-friend-flow';
import * as privateSession from '../../src/direct/wt-reference-session-private';
import type { WtReferenceSessionOptions } from '../../src/direct/wt-reference-session';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { encodeWtTlv } from '../../src/direct/wt-tlv';
import { SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import { fetchBody, parseWt, peer, pollBody, replyWt } from './fixtures/wt-sso-synthetic';

import {
    response,
    loginFields,
    deadline,
    deferred,
    turn,
} from './fixtures/wt-multiplex-pipeline-synthetic';

// Memory-only peer and synthetic UINs. The real codecs and owner pipeline run; no QQ/socket/native.
const account = '123';
const target = 0xf123456789abcdefn;
const key = new Uint8Array(16).fill(10);
const PUSH = 'trpc.msg.olpush.OlPushService.MsgPush';
type SignInput = Parameters<WtReferenceSessionOptions['buildRegisterReserved']>[0];
type VerifyInput = Parameters<WtReferenceSessionOptions['verifyRegisterRaw']>[0];
const inspect = (): WtReferenceFriendInput => ({
    mode: 'inspect',
    peerUin: target,
    sourceId: 0,
    sourceSub: 0,
    timeoutMs: 1500,
    maxResponseBodyBytes: 65536,
});
const apply = (): Extract<WtReferenceFriendInput, { mode: 'apply' }> => ({
    ...inspect(),
    mode: 'apply',
    expectedSetting: 2,
    application: { addSetting: 9, answer: 'synthetic 中🙂', token: Uint8Array.of(7, 8) },
});

function loginBody() {
    const projection = protobuf_encode<DirectThirdPartyLoginResponse>({
        commonInfo: { rspNT: { uid: 'synthetic-uid' } },
    });
    const inner = encodeWtTlv([
        { tag: 0x143, value: Uint8Array.of(9) },
        { tag: 0x305, value: key },
        { tag: 0x10a, value: Uint8Array.of(11) },
        { tag: 0x106, value: Uint8Array.of(12) },
        { tag: 0x543, value: projection },
    ]);
    const cipher = qqTeaEncrypt(inner, new Uint8Array(16).fill(4));
    inner.fill(0);
    projection.fill(0);
    return Buffer.concat([Buffer.of(0, 9, 0), encodeWtTlv([{ tag: 0x119, value: cipher }])]);
}

function inspectWire(frame: Uint8Array) {
    const wire = Buffer.from(frame);
    const accountStart = 10 + wire.readUInt32BE(9);
    const accountEnd = accountStart + wire.readUInt32BE(accountStart);
    const inner = Buffer.from(qqTeaDecrypt(wire.subarray(accountEnd), key));
    let position = 28;

    const field = () => {
        const end = position + inner.readUInt32BE(position);
        const result = inner.subarray(position + 4, end);
        position = end;
        return result;
    };

    field();
    const command = field().toString();
    const result = {
        command,
        sequence: inner.readUInt32BE(4),
        uin: wire.subarray(accountStart + 4, accountEnd).toString(),
        body: Uint8Array.from(inner.subarray(inner.readUInt32BE(0) + 4)),
    };
    inner.fill(0);
    return result;
}

class MemoryStream extends EventEmitter {
    readable = true;
    writable = true;
    destroyed = false;
    readableFlowing: boolean | null = null;
    writableLength = 0;
    writableNeedDrain = false;
    onWrite: (frame: Uint8Array) => void = () => {};
    write(bytes: Uint8Array, callback: (error?: Error | null) => void) {
        const copy = Uint8Array.from(bytes);
        queueMicrotask(() => {
            callback();
            this.onWrite(copy);
        });
        return true;
    }
    destroy(): this {
        this.destroyed = true;
        this.readable = false;
        this.writable = false;
        return this;
    }
}

function setup() {
    const stream = new MemoryStream();
    const controller = new AbortController();
    const failures: unknown[] = [];
    stream.on('error', (error) => failures.push(error));
    const requests: ReturnType<typeof inspectWire>[] = [];
    const signed: SignInput[] = [];
    const verified: VerifyInput[] = [];
    const delivered: number[] = [];
    const pending = new Set<Promise<unknown>>();
    const gates: Array<() => void> = [];
    let calls = 0;
    let setting: LinuxFriendSettingUinResponseBody = {
        peerUin: target,
        setting: 2,
        result: 0,
        errorCode: 0,
    };
    let application: LinuxFriendAddResponseBody = {
        friendSetting: 9,
        result: 6,
        errorCode: 7,
        sig: Uint8Array.of(11, 12),
        verify: new Uint8Array(),
    };
    let queryOuterError = 0;
    let addOuterError = 0;
    let retCode = 0;
    let replyCommand: string | undefined;
    let noApplicationReply = false;
    let signerHook: ((input: SignInput) => Uint8Array | Promise<Uint8Array>) | undefined;
    let verifierHook: ((input: VerifyInput) => boolean | Promise<boolean>) | undefined;

    const track = <T>(promise: Promise<T>): Promise<T> => {
        pending.add(promise);
        void promise.then(
            () => pending.delete(promise),
            () => pending.delete(promise),
        );
        return promise;
    };

    const session = createWtMultiplexReference(stream, {
        exclusiveConnected: true,
        transportUin: '0',
        initialSequence: 50,
        maxFrameBytes: 65536,
        maxBufferedBytes: 262144,
        maxFrames: 16,
        maxPushFrames: 8,
        maxPushBytes: 262144,
        maxWriteBufferBytes: 262144,
        maxPushBodyBytes: 65536,
        leaseTimeoutMs: 10000,
        session: {
            profile: {
                uin: '999',
                appId: 42,
                subAppId: 43,
                clientVersion: 44,
                guid: Uint8Array.of(1, 2),
                unknown21: new Uint8Array(21),
                randomKey: new Uint8Array(16).fill(7),
                peerPublicKey: peer.publicKey,
                ssoVersion: 'header-v',
                qrCommand: 'fixture.qr',
                loginCommand: 'fixture.login',
            },
            timeoutMs: 1500,
            attemptTimeoutMs: 7000,
            signal: controller.signal,
            getTimestamp: () => 10,
            buildWtReserved: async () => new Uint8Array(),
            verifyRaw: () => true,
            verifyContext: ({ requestUin, responseUin }) => requestUin === responseUin,
            sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
            registration: {
                version: 'build-v',
                deviceName: 'name',
                deviceType: 'type',
                vendorOs: 'os',
                random: 4,
            },
            buildRegisterReserved: (input) => {
                if (input.command === QUERY || input.command === ADD) {
                    signed.push(input);
                    return signerHook?.(input) ?? Uint8Array.of(8);
                }

                return Uint8Array.of(input.sequence);
            },
            verifyRegisterRaw: (input) => {
                if (input.command === QUERY || input.command === ADD) {
                    verified.push(input);
                    return verifierHook?.(input) ?? true;
                }

                return true;
            },
        },
        verifyPushRaw: () => true,
        onPush: () => {},
        onPushBody: (_body, meta) => {
            delivered.push(meta.sequence);
        },
    });

    stream.onWrite = (bytes) => {
        try {
            calls++;

            if (calls <= 3) {
                const request = parseWt(bytes);
                const body =
                    request.kind === 0x31
                        ? fetchBody()
                        : request.kind === 0x12
                          ? pollBody(0)
                          : loginBody();
                const candidate = replyWt(request, body);
                body.fill(0);
                request.shared.fill(0);
                request.business.fill(0);
                stream.emit('data', candidate);
                return;
            }

            const request = inspectWire(bytes);
            requests.push(request);
            let body: Uint8Array;

            if (request.command === SSO_INFO_SYNC_COMMAND) {
                body = protobuf_encode<SsoRegisterResponse>({
                    register: { message: 'register success' },
                });
            } else if (request.command === QUERY) {
                body = protobuf_encode<OidbBase<LinuxFriendSettingUinResponseBody>>({
                    command: 0x7c1,
                    subCommand: 1,
                    errorCode: queryOuterError,
                    body: setting,
                });
            } else if (request.command === ADD) {
                if (noApplicationReply) {
                    return;
                }

                body = protobuf_encode<OidbBase<LinuxFriendAddResponseBody>>({
                    command: 0x7c2,
                    subCommand: 5,
                    errorCode: addOuterError,
                    body: application,
                });
            } else {
                throw new Error('unexpected fixture command');
            }

            const command =
                request.command === SSO_INFO_SYNC_COMMAND
                    ? request.command
                    : (replyCommand ?? request.command);
            stream.emit(
                'data',
                response(
                    request.sequence,
                    command,
                    body,
                    account,
                    key,
                    request.command === SSO_INFO_SYNC_COMMAND ? 0 : retCode,
                ),
            );
            body.fill(0);
        } catch (error) {
            failures.push(error);
            stream.emit('error', error);
        } finally {
            bytes.fill(0);
        }
    };

    const register = async () => {
        await deadline(
            session.fetch({
                packageName: 'p',
                ptVersion: 'v',
                miscBitMap: 1,
                ssoVersion: 1,
                d1: Uint8Array.of(1),
            }),
            'fetch',
        );
        expect(await deadline(session.poll(), 'poll')).toEqual({ status: 'confirmed' });
        expect(await deadline(session.loginAndRegister(loginFields), 'register')).toEqual({
            status: 'success',
        });
    };

    const gate = <T>(value: T) => {
        const result = deferred<T>();
        gates.push(() => result.resolve(value));
        return result;
    };

    return {
        stream,
        session,
        controller,
        requests,
        signed,
        verified,
        delivered,
        failures,
        register,
        gate,
        track,
        friend: (input: WtReferenceFriendInput = apply()) => track(session.friendRequest(input)),
        push: (sequence: number) =>
            stream.emit('data', response(sequence, PUSH, Uint8Array.of(1), account, key)),
        setSetting: (value: LinuxFriendSettingUinResponseBody) => {
            setting = value;
        },
        setApplication: (value: LinuxFriendAddResponseBody) => {
            application = value;
        },
        setSigner: (value: typeof signerHook) => {
            signerHook = value;
        },
        setVerifier: (value: typeof verifierHook) => {
            verifierHook = value;
        },
        setOuterError: (query: number, add = 0) => {
            queryOuterError = query;
            addOuterError = add;
        },
        setRetCode: (value: number) => {
            retCode = value;
        },
        setReplyCommand: (value: string) => {
            replyCommand = value;
        },
        dropApplicationReply: () => {
            noApplicationReply = true;
        },
        async cleanup() {
            session.close();
            gates.forEach((release) => release());
            stream.emit('close');
            await deadline(session.whenClosed, 'close');
            await deadline(Promise.allSettled([...pending]), 'pending');
            await turn();
            expect(stream.listenerCount('data')).toBe(0);
        },
    };
}

type Fixture = ReturnType<typeof setup>;

async function fixture(test: (f: Fixture) => Promise<void>) {
    const f = setup();

    try {
        await test(f);
    } finally {
        await f.cleanup();
        vi.restoreAllMocks();
    }
}

async function errorOf(promise: Promise<unknown>): Promise<WtReferenceFriendError> {
    const value = await deadline(
        promise.then(
            () => undefined,
            (error: unknown) => error,
        ),
        'expected rejection',
    );
    expect(value).toBeInstanceOf(WtReferenceFriendError);
    return value as WtReferenceFriendError;
}

describe('same-owner explicit Linux friend workflow', () => {
    it('inspects with only one fixed query and preserves missing fields', () =>
        fixture(async (f) => {
            await f.register();
            f.setSetting({});
            expect(await f.friend(inspect())).toMatchObject({
                status: 'settings',
                applicationAttempted: false,
                applicationWriteState: 'not-written',
                settings: {
                    kind: 'settings',
                    setting: undefined,
                    result: undefined,
                    questions: [],
                },
            });
            expect(f.requests.slice(1).map((x) => x.command)).toEqual([QUERY]);
            const query = protobuf_decode<OidbBase<LinuxFriendSettingUinBody>>(f.requests[1].body);
            expect(query).toMatchObject({
                command: 0x7c1,
                subCommand: 1,
                reserved: 1,
                body: { selfUin: 123n, peerUin: target, sourceId: 0, sourceSub: 0 },
            });
        }));
    it('requeries before one application with fresh runs and no implicit setting mapping', () =>
        fixture(async (f) => {
            await f.register();
            const stages = vi.spyOn(privateSession, 'beginReferenceFriendStep');
            const ends = vi.spyOn(privateSession, 'endReferenceFriendStep');
            const dispose = vi.spyOn(responses, 'disposeLinuxFriendAddResponse');
            const result = await f.friend();
            expect(result).toMatchObject({
                status: 'application-response',
                applicationAttempted: true,
                applicationWriteState: 'written',
                response: {
                    kind: 'application',
                    result: 6,
                    errorCode: 7,
                    sigPresent: true,
                    sigLength: 2,
                    verifyPresent: true,
                    verifyLength: 0,
                },
            });
            expect(result).not.toHaveProperty('response.sig');
            expect(result).not.toHaveProperty('response.verify');
            expect(f.requests.slice(1).map((x) => [x.command, x.sequence, x.uin])).toEqual([
                [QUERY, 54, account],
                [ADD, 55, account],
            ]);
            const query = protobuf_decode<OidbBase<LinuxFriendSettingUinBody>>(f.requests[1].body);
            const added = protobuf_decode<OidbBase<LinuxFriendAddUinBody>>(f.requests[2].body);
            expect(query.body?.peerUin).toBe(target);
            expect(added).toMatchObject({
                command: 0x7c2,
                subCommand: 5,
                reserved: 1,
                body: {
                    selfUin: 123n,
                    peerUin: target,
                    addSetting: 9,
                    sourceId: 0,
                    sourceSub: 0,
                    token: Uint8Array.of(7, 8),
                },
            });
            expect(stages).toHaveBeenCalledTimes(2);
            expect(ends).toHaveBeenCalledTimes(2);
            expect(stages.mock.calls[0][4]).toBe(stages.mock.calls[1][4]);
            expect(stages.mock.calls[0][5]).not.toBe(stages.mock.calls[1][5]);
            const projection = dispose.mock.calls[0][0];
            expect(projection.kind).toBe('application');

            if (projection.kind === 'application') {
                expect(projection.sig).toEqual(new Uint8Array(2));
            }

            expect(f.signed.every((x) => x.body.every((b) => b === 0))).toBe(true);
            expect(
                f.verified.every(
                    (x) =>
                        x.requestFrame.every((b) => b === 0) &&
                        x.responseFrame.every((b) => b === 0),
                ),
            ).toBe(true);
            expect(f.failures).toEqual([]);
        }));
    it.each(
        (
            [
                [{ setting: 2, errorCode: 1 }, 'error-code'],
                [{}, 'setting-missing'],
                [{ setting: 3 }, 'setting-mismatch'],
                [{ setting: 2, questions: [Uint8Array.of(63)] }, 'questions-present'],
                [{ setting: 2, peerUin: target - 1n }, 'peer-mismatch'],
            ] satisfies Array<[LinuxFriendSettingUinResponseBody, string]>
        ).flatMap(([setting, reason]) =>
            [0, 1, undefined].map((result) => [{ ...setting, result }, reason] as const),
        ),
    )('applies no write on conservative query gate %#', (setting, reason) =>
        fixture(async (f) => {
            await f.register();
            f.setSetting({ ...setting });
            expect(await f.friend()).toMatchObject({
                status: 'not-applied',
                reason,
                applicationAttempted: false,
                applicationWriteState: 'not-written',
            });
            expect(f.requests.slice(1).map((x) => x.command)).toEqual([QUERY]);
            expect(f.session.getState()).toBe('success');
        }),
    );
    it.each([1, undefined])(
        'preserves inner query result %s without using it as an apply gate',
        (result) =>
            fixture(async (f) => {
                await f.register();
                f.setSetting({ peerUin: target, setting: 2, errorCode: 0, result });
                const outcome = await f.friend();
                expect(outcome.status).toBe('application-response');
                expect(outcome.settings).toMatchObject({ kind: 'settings', setting: 2, result });

                if (outcome.settings.kind === 'settings') {
                    expect(outcome.settings.result).toBe(result);
                }

                expect(f.requests.slice(1).map((request) => request.command)).toEqual([QUERY, ADD]);
            }),
    );
    it.each(
        [1, undefined].flatMap((result) =>
            (['sso', 'oidb'] as const).map((layer) => ({ result, layer })),
        ),
    )(
        'still makes zero applications on $layer error with inner result $result',
        ({ result, layer }) =>
            fixture(async (f) => {
                await f.register();
                f.setSetting({ peerUin: target, setting: 2, errorCode: 0, result });

                if (layer === 'sso') {
                    f.setRetCode(42);
                    expect(await errorOf(f.friend())).toMatchObject({
                        code: 'sso-error',
                        applicationAttempted: false,
                    });
                } else {
                    f.setOuterError(12);
                    expect(await f.friend()).toMatchObject({
                        status: 'not-applied',
                        reason: 'oidb-error',
                        applicationAttempted: false,
                    });
                }

                expect(f.requests.slice(1).map((request) => request.command)).toEqual([QUERY]);
            }),
    );
    it('accepts absent errorCode with an equal setting', () =>
        fixture(async (f) => {
            await f.register();
            f.setSetting({ setting: 2, result: 0 });
            expect(await f.friend()).toMatchObject({ status: 'application-response' });
        }));
    it('projects both OIDB error locations neutrally', () =>
        fixture(async (f) => {
            await f.register();
            f.setOuterError(12);
            expect(await f.friend()).toMatchObject({
                status: 'not-applied',
                reason: 'oidb-error',
                settings: { kind: 'oidb-error', errorCode: 12 },
            });
            f.setOuterError(0, 19);
            expect(await f.friend()).toMatchObject({
                status: 'application-response',
                response: { kind: 'oidb-error', errorCode: 19 },
            });
        }));
    it('snapshots all caller application bytes and fields before the first await', () =>
        fixture(async (f) => {
            await f.register();
            const entered = deferred<void>();
            const allow = f.gate(Uint8Array.of(8));
            f.setSigner((input) => {
                if (input.command === QUERY) {
                    entered.resolve();
                    return allow.promise;
                }

                return Uint8Array.of(8);
            });
            const token = Uint8Array.of(5, 6);
            const input = {
                ...apply(),
                application: {
                    addSetting: 11,
                    token,
                    sig: token,
                    verify: token,
                    ext: token,
                    bytesSig: token,
                    clientExt: token,
                },
            };
            const pending = f.friend(input);
            // Mutation is immediate, before the signer or any other awaited continuation.
            token.fill(99);
            input.peerUin = 1n;
            input.application.addSetting = 12;
            await deadline(entered.promise, 'query signer');
            allow.resolve(Uint8Array.of(8));
            await pending;
            const wire = protobuf_decode<OidbBase<LinuxFriendAddUinBody>>(f.requests[2].body);
            expect(wire.body).toMatchObject({
                peerUin: target,
                addSetting: 11,
                token: Uint8Array.of(5, 6),
                sig: Uint8Array.of(5, 6),
                verify: Uint8Array.of(5, 6),
                ext: Uint8Array.of(5, 6),
                bytesSig: Uint8Array.of(5, 6),
                clientExt: Uint8Array.of(5, 6),
            });
            expect(token).toEqual(Uint8Array.of(99, 99));
        }));
    it('holds the single gate across both stages and drains queued pushes afterwards', () =>
        fixture(async (f) => {
            await f.register();
            const queryEntered = deferred<void>();
            const addEntered = deferred<void>();
            const queryAllow = f.gate(true);
            const addAllow = f.gate(Uint8Array.of(8));
            f.setVerifier((input) => {
                if (input.command === QUERY) {
                    queryEntered.resolve();
                    return queryAllow.promise;
                }

                return true;
            });
            f.setSigner((input) => {
                if (input.command === ADD) {
                    addEntered.resolve();
                    return addAllow.promise;
                }

                return Uint8Array.of(8);
            });
            const pending = f.friend();
            await deadline(queryEntered.promise, 'query verifier');
            f.push(54);
            await turn();
            expect(f.delivered).toEqual([]);
            await expect(f.friend(inspect())).rejects.toThrow(/busy/);
            await expect(f.session.heartbeat()).rejects.toThrow(/busy/);
            await expect(
                f.session.sendText({
                    request: {
                        route: { kind: 'group', groupUin: 1n },
                        text: 'x',
                        clientSequence: 1n,
                        random: 1,
                    },
                    maxResponseBodyBytes: 1,
                }),
            ).rejects.toThrow(/busy/);
            queryAllow.resolve(true);
            await deadline(addEntered.promise, 'application signer');
            f.push(55);
            await turn();
            expect(f.delivered).toEqual([]);
            addAllow.resolve(Uint8Array.of(8));
            expect(await pending).toMatchObject({ status: 'application-response' });
            await turn();
            await turn();
            expect(f.delivered).toEqual([54, 55]);
        }));
    it.each(['settings', 'application'] as const)(
        'rejects a false %s verifier without stale verified reuse',
        (stage) =>
            fixture(async (f) => {
                await f.register();
                f.setVerifier((input) => input.command !== (stage === 'settings' ? QUERY : ADD));
                const error = await errorOf(f.friend());
                expect(error.stage).toBe(stage);
                expect(error.applicationAttempted).toBe(stage === 'application');
                expect(f.requests.slice(1).filter((x) => x.command === ADD)).toHaveLength(
                    stage === 'application' ? 1 : 0,
                );
                expect(f.stream.destroyed).toBe(true);
            }),
    );
    it.each(['command', 'body', 'uin', 'sequence'] as const)(
        'rejects signer mutation of %s without a query write',
        (field) =>
            fixture(async (f) => {
                await f.register();
                f.setSigner((input) => {
                    if (field === 'body') {
                        input.body.fill(0);
                    } else {
                        Reflect.set(
                            input,
                            field,
                            field === 'sequence' ? 8 : field === 'command' ? ADD : '456',
                        );
                    }

                    return Uint8Array.of(8);
                });
                const error = await errorOf(f.friend());
                expect(error.applicationAttempted).toBe(false);
                expect(f.requests).toHaveLength(1);
            }),
    );
    it.each(['close', 'abort'] as const)(
        'suppresses late application signer writes after %s',
        (mode) =>
            fixture(async (f) => {
                await f.register();
                const entered = deferred<void>();
                const allow = f.gate(Uint8Array.of(8));
                f.setSigner((input) => {
                    if (input.command === ADD) {
                        entered.resolve();
                        return allow.promise;
                    }

                    return Uint8Array.of(8);
                });
                const pending = f.friend();
                await deadline(entered.promise, 'application signer');

                if (mode === 'close') {
                    f.session.close();
                } else {
                    f.controller.abort();
                }

                const error = await errorOf(pending);
                expect(error.applicationAttempted).toBe(true);
                allow.resolve(Uint8Array.of(8));
                await turn();
                expect(f.requests.filter((x) => x.command === ADD)).toHaveLength(0);
                await expect(f.friend()).rejects.toBeInstanceOf(WtReferenceFriendError);
            }),
    );
    it('uses one total deadline rather than restarting the budget for application', async () => {
        let now = performance.now();
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);

        try {
            await fixture(async (f) => {
                await f.register();
                f.setVerifier((input) => {
                    if (input.command === QUERY) {
                        now += 60;
                    }

                    return true;
                });
                f.setSigner((input) => {
                    if (input.command === ADD) {
                        now += 60;
                    }

                    return Uint8Array.of(8);
                });
                const error = await errorOf(f.friend({ ...apply(), timeoutMs: 100 }));
                expect(error.applicationAttempted).toBe(true);
                expect(f.requests.filter((x) => x.command === ADD)).toHaveLength(0);
            });
        } finally {
            clock.mockRestore();
        }
    });
    it('continues after login attempt expiry but not after the lease lifetime', async () => {
        let now = performance.now();
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);

        try {
            await fixture(async (f) => {
                await f.register();
                now += 7100;
                expect(await f.friend(inspect())).toMatchObject({ status: 'settings' });
                now += 3000;
                const before = f.requests.length;
                await errorOf(f.friend());
                expect(f.requests).toHaveLength(before);
            });
        } finally {
            clock.mockRestore();
        }
    });
    it('retains write uncertainty without retry after an application reply is lost', () =>
        fixture(async (f) => {
            await f.register();
            f.dropApplicationReply();
            const error = await errorOf(f.friend({ ...apply(), timeoutMs: 100 }));
            expect(error.applicationAttempted).toBe(true);
            expect(error.applicationWriteState).not.toBe('not-written');
            expect(f.requests.filter((x) => x.command === ADD)).toHaveLength(1);
            await errorOf(f.friend());
            expect(f.requests.filter((x) => x.command === ADD)).toHaveLength(1);
        }));
    it.each([ADD, 'OidbSvc.0x7c1_1', 'MessageSvc.PbSendMsg'])(
        'rejects a wrong fixed response command %s',
        (command) =>
            fixture(async (f) => {
                await f.register();
                f.setReplyCommand(command);
                const error = await errorOf(f.friend());
                expect(error.applicationAttempted).toBe(false);
                expect(f.requests.filter((x) => x.command === ADD)).toHaveLength(0);
            }),
    );
    it('closes on SSO error and does not turn it into a business result', () =>
        fixture(async (f) => {
            await f.register();
            f.setRetCode(42);
            expect(await errorOf(f.friend())).toMatchObject({
                code: 'sso-error',
                applicationAttempted: false,
            });
        }));
    it('checks the per-response body acceptance cap', () =>
        fixture(async (f) => {
            await f.register();
            await errorOf(f.friend({ ...apply(), maxResponseBodyBytes: 0 }));
            expect(f.requests.filter((x) => x.command === ADD)).toHaveLength(0);
        }));
    it('clears unexposed application bytes even if a post-exchange stage fence closes', () =>
        fixture(async (f) => {
            await f.register();
            const original = privateSession.endReferenceFriendStep;
            const disposed = vi.spyOn(responses, 'disposeLinuxFriendAddResponse');
            vi.spyOn(privateSession, 'endReferenceFriendStep').mockImplementation((...args) => {
                original(...args);

                if (args[4].stepId === 'application') {
                    f.session.close();
                }
            });
            await errorOf(f.friend());
            const projection = disposed.mock.calls.find(([p]) => p.kind === 'application')?.[0];
            expect(projection?.kind).toBe('application');

            if (projection?.kind === 'application') {
                expect(projection.sig).toEqual(new Uint8Array(2));
            }
        }));
    it('rejects invalid fields and accessors before effects without poisoning the owner', () =>
        fixture(async (f) => {
            await f.register();
            let traps = 0;

            const trap = () => {
                traps++;
                throw new Error('trap');
            };

            const invalid: unknown[] = [
                { ...apply(), command: ADD },
                { ...apply(), selfUin: 456n },
                { ...apply(), sourceId: undefined },
                { ...apply(), timeoutMs: 0 },
                { ...apply(), maxResponseBodyBytes: 65537 },
                { ...apply(), expectedSetting: undefined },
                { ...inspect(), application: {} },
                { ...apply(), application: { sourceId: 1 } },
                { ...apply(), application: { body: Uint8Array.of(1) } },
                { ...apply(), application: Object.defineProperty({}, 'token', { get: trap }) },
                new Proxy(apply(), { getPrototypeOf: trap, ownKeys: trap }),
                { ...apply(), application: { token: new Uint8Array(new SharedArrayBuffer(1)) } },
                {
                    ...apply(),
                    application: {
                        token: new Uint8Array(new ArrayBuffer(1, { maxByteLength: 2 })),
                    },
                },
            ];

            for (const input of invalid) {
                await expect(f.friend(input as WtReferenceFriendInput)).rejects.toThrow();
            }

            expect(traps).toBe(0);
            expect(f.requests).toHaveLength(1);
            expect(f.signed).toHaveLength(0);
            expect(await f.friend(inspect())).toMatchObject({ status: 'settings' });
        }));
    it('returns no callbacks before registration and keeps the original callable handle compatible', () =>
        fixture(async (f) => {
            await expect(f.friend()).rejects.toThrow(/not registered/);
            expect(f.requests).toHaveLength(0);
            await f.register();
            expect(await f.friend(inspect())).toMatchObject({ status: 'settings' });
        }));
    it('keeps contact status uninterpreted and uses native-default addSetting rather than the queried setting', () =>
        fixture(async (f) => {
            await f.register();
            f.setSetting({ setting: 2, result: 0, isContactFriend: true });
            expect(await f.friend({ ...apply(), application: {} })).toMatchObject({
                status: 'application-response',
                settings: { isContactFriend: true },
            });
            const wire = protobuf_decode<OidbBase<LinuxFriendAddUinBody>>(f.requests[2].body);
            expect(wire.body?.addSetting).toBe(0); // Native missing-argument default, not queried setting 2.
        }));
    it.each(['application-response', 'not-applied'] as const)(
        'clears both prepared bodies after %s',
        (status) =>
            fixture(async (f) => {
                await f.register();
                const prepare = vi.spyOn(friendFlow, 'prepareReferenceFriendInput');

                if (status === 'not-applied') {
                    f.setSetting({ setting: 3, result: 0 });
                }

                expect(await f.friend()).toMatchObject({ status });
                const prepared = prepare.mock.results[0].value as ReturnType<
                    typeof prepareReferenceFriendInput
                >;
                expect(prepared.settingsBody.every((byte) => byte === 0)).toBe(true);
                expect(prepared.applicationBody!.every((byte) => byte === 0)).toBe(true);
            }),
    );
    it('keeps the same revocable handle for text and friend calls', async () => {
        const take = vi.spyOn(privateSession, 'takeReferenceSessionSend');

        try {
            await fixture(async (f) => {
                await f.register();
                const handle = take.mock.results[0]
                    .value as privateSession.ReferenceSessionSendHandle;
                const friend = handle.friendRequest;
                expect(typeof handle).toBe('function');
                expect(typeof friend).toBe('function');
                const prepared = prepareReferenceFriendInput(inspect(), 123n);

                try {
                    f.session.close();
                    await expect(
                        friend(prepared, {}, performance.now() + 100, {
                            stage: 'settings',
                            applicationAttempted: false,
                            applicationWriteState: 'not-written',
                        }),
                    ).rejects.toThrow(/revoked/);
                    expect(f.signed).toHaveLength(0);
                } finally {
                    disposePreparedReferenceFriendInput(prepared);
                }
            });
        } finally {
            take.mockRestore();
        }
    });
    it('rejects reused child runs and wrong private owner, lease or workflow identities', () =>
        fixture(async (f) => {
            await f.register();
            const original = privateSession.endReferenceFriendStep;
            let checks = 0;
            vi.spyOn(privateSession, 'endReferenceFriendStep').mockImplementation(
                (token, owner, lease, attempt, stage) => {
                    original(token, owner, lease, attempt, stage);
                    expect(() =>
                        privateSession.beginReferenceSend(token, attempt, lease, stage.childRun),
                    ).toThrow(/binding/);
                    expect(() =>
                        privateSession.beginReferenceFriendStep(
                            token,
                            owner,
                            lease,
                            attempt,
                            {},
                            {},
                            'application',
                        ),
                    ).toThrow(/binding/);
                    expect(() =>
                        privateSession.beginReferenceFriendStep(
                            token,
                            {} as typeof owner,
                            lease,
                            attempt,
                            stage.workflowRun,
                            {},
                            'application',
                        ),
                    ).toThrow(/binding/);
                    expect(() =>
                        privateSession.beginReferenceFriendStep(
                            token,
                            owner,
                            {} as typeof lease,
                            attempt,
                            stage.workflowRun,
                            {},
                            'application',
                        ),
                    ).toThrow(/binding/);
                    checks++;
                },
            );
            expect(await f.friend()).toMatchObject({ status: 'application-response' });
            expect(checks).toBe(2);
        }));
    it('never applies after closure at the exact query to application boundary', () =>
        fixture(async (f) => {
            await f.register();
            const original = privateSession.endReferenceFriendStep;
            vi.spyOn(privateSession, 'endReferenceFriendStep').mockImplementation((...args) => {
                original(...args);

                if (args[4].stepId === 'settings') {
                    f.session.close();
                }
            });
            expect(await errorOf(f.friend())).toMatchObject({
                applicationAttempted: false,
                applicationWriteState: 'not-written',
            });
            expect(f.signed.map((input) => input.command)).toEqual([QUERY]);
        }));
    it('suppresses late verifier completion and zeroes its borrowed frames', () =>
        fixture(async (f) => {
            await f.register();
            const entered = deferred<void>();
            const allow = f.gate(true);
            let held: VerifyInput | undefined;
            f.setVerifier((input) => {
                if (input.command === ADD) {
                    held = input;
                    entered.resolve();
                    return allow.promise;
                }

                return true;
            });
            const pending = f.friend();
            await deadline(entered.promise, 'application verifier');
            f.session.close();
            expect(await errorOf(pending)).toMatchObject({ applicationAttempted: true });
            allow.resolve(true);
            await turn();
            await turn();
            expect(held!.requestFrame.every((b) => b === 0)).toBe(true);
            expect(held!.responseFrame.every((b) => b === 0)).toBe(true);
            expect(f.requests.filter((x) => x.command === ADD)).toHaveLength(1);
        }));
    it('fences final delivery when queued push wakeup closes the owner', () =>
        fixture(async (f) => {
            await f.register();
            await turn();
            const entered = deferred<void>();
            const allow = f.gate(Uint8Array.of(8));
            f.setSigner((input) => {
                if (input.command === QUERY) {
                    entered.resolve();
                    return allow.promise;
                }

                return Uint8Array.of(8);
            });
            const pending = f.friend();
            await deadline(entered.promise, 'held query');
            f.push(54);
            await turn();
            const nativeImmediate = globalThis.setImmediate;
            let triggered = false;
            f.setVerifier((input) => {
                if (input.command === ADD) {
                    const wakeup = vi
                        .spyOn(globalThis, 'setImmediate')
                        .mockImplementation((callback, ...args) => {
                            wakeup.mockRestore();
                            triggered = true;
                            f.session.close();
                            return nativeImmediate(callback, ...args);
                        });
                }

                return true;
            });
            allow.resolve(Uint8Array.of(8));
            expect(await errorOf(pending)).toMatchObject({
                applicationAttempted: true,
                applicationWriteState: 'written',
            });
            expect(triggered).toBe(true);
            await turn();
            expect(f.delivered).toEqual([]);
        }));
    it('does not inspect a reentrant caller while either stage owns the gate', () =>
        fixture(async (f) => {
            await f.register();
            let traps = 0;
            const results: Promise<unknown>[] = [];
            const invalid = new Proxy(apply(), {
                ownKeys: () => {
                    traps++;
                    throw new Error('trap');
                },
            });
            f.setSigner(() => {
                results.push(f.friend(invalid).catch((error) => error));
                return Uint8Array.of(8);
            });
            expect(await f.friend()).toMatchObject({ status: 'application-response' });
            expect(await Promise.all(results)).toHaveLength(2);
            expect(traps).toBe(0);
        }));
    it('wipes prepared buffers on success, query denial and input encode failure', () => {
        const source = Uint8Array.of(4, 5);
        const prepared = prepareReferenceFriendInput(
            { ...apply(), application: { token: source } },
            123n,
        );
        const raw = protobuf_decode<OidbBase<bytes>>(prepared.applicationBody!);
        expect(raw.command).toBe(0x7c2);
        disposePreparedReferenceFriendInput(prepared);
        expect(prepared.settingsBody.every((b) => b === 0)).toBe(true);
        expect(prepared.applicationBody!.every((b) => b === 0)).toBe(true);
        expect(source).toEqual(Uint8Array.of(4, 5));
        expect(() =>
            prepareReferenceFriendInput(
                { ...apply(), application: { token: source, answer: '\ud800' } },
                123n,
            ),
        ).toThrow();
        expect(source).toEqual(Uint8Array.of(4, 5));
    });
});
