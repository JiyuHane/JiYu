import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { DirectThirdPartyLoginResponse } from '@snowluma/proto-defs/direct-login';
import type { DirectSendMessageResponse } from '@snowluma/proto-defs/direct-send-message';
import type { SsoRegisterResponse, SsoHeartbeatResponse } from '@snowluma/proto-defs/sso-register';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
    LinuxFriendSettingUinBody,
    LinuxFriendSettingUinResponseBody,
    LinuxFriendAddResponseBody,
} from '@snowluma/proto-defs/linux-friend';
import {
    createWtMultiplexReference,
    createWtRestoredMultiplexReference,
    type WtMultiplexReferenceOptions,
    type WtRestoredMultiplexReferenceOptions,
} from '../../src/direct/wt-multiplex-reference';
import {
    cloneWtPersistedSession,
    decodeWtPersistedSession,
    disposeWtPersistedSession,
    encodeWtPersistedSession,
    type WtPersistedSessionV1,
    type WtSessionCheckpoint,
    type WtSessionCheckpointContext,
} from '../../src/direct/wt-persisted-session';
import * as persistedModule from '../../src/direct/wt-persisted-session';
import type { WtActiveReferenceSession } from '../../src/direct/wt-reference-session';
import * as nativeRefresh from '../../src/direct/nt-native-ticket-refresh';
import * as privateSession from '../../src/direct/wt-reference-session-private';
import { NATIVE_KEY_EXCHANGE_COMMAND } from '../../src/direct/nt-native-key-exchange';
import { NATIVE_TICKET_REFRESH_COMMAND } from '../../src/direct/nt-native-ticket-codec';
import { createSsoReferenceExchange } from '../../src/direct/sso-reference-exchange-internal';
import * as attempts from '../../src/direct/wt-reference-login-attempt';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { decodeServiceResponse } from '../../src/direct/service-frame';
import { encodeWtTlv } from '../../src/direct/wt-tlv';
import {
    SSO_INFO_SYNC_COMMAND as REGISTER,
    SSO_HEARTBEAT_COMMAND as HEARTBEAT,
} from '../../src/direct/sso-register';
import { SSO_REFERENCE_ALIVE_COMMAND as ALIVE } from '../../src/direct/sso-reference-alive-flow';
import {
    LINUX_FRIEND_SETTING_COMMAND as QUERY,
    LINUX_FRIEND_ADD_COMMAND as ADD,
} from '../../src/direct/linux-friend-request';
import { fetchBody, parseWt, peer, pollBody, replyWt } from './fixtures/wt-sso-synthetic';
import {
    response,
    textBody,
    loginFields,
    deadline,
    deferred,
    turn,
    waitFor,
    COMMAND as PUSH,
} from './fixtures/wt-multiplex-pipeline-synthetic';

// Real codecs and owner gates; all transports, accounts, credentials and replies are synthetic.
const SEND = 'MessageSvc.PbSendMsg';
const target = 0xf123456789abcdefn;
const snapshot = (uin = '123', byte = 10): WtPersistedSessionV1 => ({
    version: 1,
    uin,
    uid: `synthetic-${uin}`,
    guid: new Uint8Array(16).fill(3),
    tickets: {
        d2: Uint8Array.of(9),
        d2Key: new Uint8Array(16).fill(byte),
        a1: Uint8Array.of(12),
        a2: Uint8Array.of(11),
    },
});
const zeroed = (value: WtPersistedSessionV1) =>
    [value.guid, ...Object.values(value.tickets)].every((bytes) =>
        bytes.every((byte) => byte === 0),
    );
const friendInput = () => ({
    mode: 'apply' as const,
    peerUin: target,
    sourceId: 0,
    sourceSub: 0,
    timeoutMs: 1000,
    maxResponseBodyBytes: 65536,
    expectedSetting: 2,
    application: { addSetting: 9, answer: 'synthetic', token: Uint8Array.of(7) },
});
const sendInput = () => ({
    request: {
        route: { kind: 'private' as const, peerUin: 456n, peerUid: 'synthetic-peer' },
        text: 'fixture',
        clientSequence: 9007199254740993n,
        random: 5,
    },
    maxResponseBodyBytes: 65536,
});

class MemoryStream extends EventEmitter {
    readable = true;
    writable = true;
    destroyed = false;
    readableFlowing: boolean | null = null;
    writableLength = 0;
    writableNeedDrain = false;
    writes = 0;
    onWrite: (bytes: Uint8Array) => void = () => {};
    write(bytes: Uint8Array, callback: (error?: Error | null) => void) {
        const copy = Uint8Array.from(bytes);
        this.writes++;
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

function inspectWire(frame: Uint8Array, key: Uint8Array) {
    const bytes = Buffer.from(frame);
    const protocol = bytes.readUInt32BE(4);
    const accountStart = protocol === 13 ? 14 : 10 + bytes.readUInt32BE(9);
    const accountEnd = accountStart + bytes.readUInt32BE(accountStart);
    const inner =
        protocol === 13
            ? Buffer.from(bytes.subarray(accountEnd))
            : Buffer.from(qqTeaDecrypt(bytes.subarray(accountEnd), key));
    let position = protocol === 13 ? 4 : 28;

    const field = () => {
        const end = position + inner.readUInt32BE(position);
        const value = Uint8Array.from(inner.subarray(position + 4, end));
        position = end;
        return value;
    };

    const a2 = protocol === 12 ? field() : undefined;
    const command = Buffer.from(field()).toString();
    field();
    const guid = protocol === 12 ? Buffer.from(field()).toString() : undefined;
    const result = {
        protocol,
        command,
        a2,
        guid,
        uin: bytes.subarray(accountStart + 4, accountEnd).toString(),
        sequence: protocol === 13 ? bytes.readUInt32BE(9) : inner.readUInt32BE(4),
        d2: protocol === 12 ? Uint8Array.from(bytes.subarray(13, accountStart - 1)) : undefined,
        body: Uint8Array.from(inner.subarray(inner.readUInt32BE(0) + 4)),
    };
    inner.fill(0);
    return result;
}

function loginBody(value: WtPersistedSessionV1) {
    const uid = protobuf_encode<DirectThirdPartyLoginResponse>({
        commonInfo: { rspNT: { uid: value.uid } },
    });
    const inner = encodeWtTlv([
        { tag: 0x143, value: value.tickets.d2 },
        { tag: 0x305, value: value.tickets.d2Key },
        { tag: 0x10a, value: value.tickets.a2 },
        { tag: 0x106, value: value.tickets.a1 },
        { tag: 0x543, value: uid },
    ]);
    const body = Buffer.concat([
        Buffer.of(0, 9, 0),
        encodeWtTlv([{ tag: 0x119, value: qqTeaEncrypt(inner, new Uint8Array(16).fill(4)) }]),
    ]);
    inner.fill(0);
    uid.fill(0);
    return body;
}

function aliveReply(sequence: number, uin: string, key: Uint8Array) {
    const frame = response(sequence, ALIVE, new Uint8Array(), uin, key);
    const outer = decodeServiceResponse(frame, key);
    const result = Buffer.alloc(14 + uin.length + outer.body.length);
    result.writeUInt32BE(result.length, 0);
    result.writeUInt32BE(13, 4);
    result.writeUInt32BE(uin.length + 4, 10);
    result.set(Buffer.from(uin), 14);
    result.set(outer.body, 14 + uin.length);
    outer.body.fill(0);
    frame.fill(0);
    return result;
}

// Inbound protocol 13 uses the same service-response envelope as protocol 12,
// independently of the protocol-13 request layout used by Heartbeat.Alive.
function restoredPush13(
    value: WtPersistedSessionV1,
    options: {
        command?: string;
        uin?: string;
        key?: Uint8Array;
        encryption?: 'd2' | 'zero' | 'none';
    } = {},
) {
    const key = options.key ?? value.tickets.d2Key;
    const uin = options.uin ?? value.uin;
    const body = textBody(889, value.uin, false, 'synthetic notification');
    const frame = response(889, options.command ?? PUSH, body, uin, key);
    body.fill(0);
    frame.writeUInt32BE(13, 4);

    if (options.encryption === undefined || options.encryption === 'd2') {
        return frame;
    }

    const decoded = decodeServiceResponse(frame, key);
    const payload =
        options.encryption === 'zero'
            ? qqTeaEncrypt(decoded.body, new Uint8Array(16))
            : decoded.body;
    const result = Buffer.concat([frame.subarray(0, 14 + Buffer.byteLength(uin)), payload]);
    result.writeUInt32BE(result.length, 0);
    result[8] = options.encryption === 'zero' ? 2 : 0;
    decoded.body.fill(0);
    payload.fill(0);
    frame.fill(0);
    return result;
}

type Sign = WtRestoredMultiplexReferenceOptions['session']['buildRegisterReserved'];
type Verify = WtRestoredMultiplexReferenceOptions['session']['verifyRegisterRaw'];
type Settings = {
    value?: WtPersistedSessionV1;
    checkpoint?: WtSessionCheckpoint;
    renewalCheckpoint?: WtSessionCheckpoint;
    result?: 'success' | 'rejected' | 'missing-result' | 'sso-error';
    verify?: Verify;
    sign?: Sign;
    noReply?: boolean;
    preRegisterPush?: boolean;
    replyUin?: string;
    replyKey?: Uint8Array;
    replySequenceDelta?: number;
    timeoutMs?: number;
    restoreTimeoutMs?: number;
    sameChunkRenewalPush?: boolean;
    renewalPushGeneration?: 'old' | 'new';
};

function fixture(settings: Settings = {}) {
    const value = settings.value ?? snapshot();
    const peerValue = cloneWtPersistedSession(value);
    const stream = new MemoryStream();
    const controller = new AbortController();
    const failures: unknown[] = [];
    const requests: ReturnType<typeof inspectWire>[] = [];
    const signed: Parameters<Sign>[0][] = [];
    const delivered: number[] = [];
    let qr = false;
    let qrCalls = 0;
    stream.on('error', (error) => failures.push(error));

    stream.onWrite = (bytes) => {
        try {
            if (qr && qrCalls++ < 3) {
                const request = parseWt(bytes);
                const body =
                    request.kind === 0x31
                        ? fetchBody()
                        : request.kind === 0x12
                          ? pollBody(0)
                          : loginBody(peerValue);
                stream.emit('data', replyWt(request, body));
                request.shared.fill(0);
                request.business.fill(0);
                body.fill(0);
                return;
            }

            const request = inspectWire(bytes, peerValue.tickets.d2Key);
            requests.push(request);

            if (settings.noReply) {
                return;
            }

            let body: Uint8Array;

            if (request.command === REGISTER) {
                body = protobuf_encode<SsoRegisterResponse>(
                    settings.result === 'missing-result'
                        ? {}
                        : {
                              register: {
                                  message:
                                      settings.result === 'rejected' ? 'no' : 'register success',
                              },
                          },
                );

                if (settings.preRegisterPush) {
                    stream.emit(
                        'data',
                        response(888, PUSH, Uint8Array.of(1), value.uin, peerValue.tickets.d2Key),
                    );
                }
            } else if (request.command === HEARTBEAT) {
                body = protobuf_encode<SsoHeartbeatResponse>({ interval: 37n });
            } else if (request.command === ALIVE) {
                stream.emit(
                    'data',
                    aliveReply(request.sequence, value.uin, peerValue.tickets.d2Key),
                );
                return;
            } else if (request.command === SEND) {
                body = protobuf_encode<DirectSendMessageResponse>({ result: 0 });
            } else if (
                request.command === NATIVE_KEY_EXCHANGE_COMMAND ||
                request.command === NATIVE_TICKET_REFRESH_COMMAND
            ) {
                body = Uint8Array.of(request.command === NATIVE_KEY_EXCHANGE_COMMAND ? 61 : 62);
            } else if (request.command === QUERY) {
                const query = protobuf_decode<OidbBase<LinuxFriendSettingUinBody>>(request.body);
                expect(query.body?.peerUin).toBe(target);
                body = protobuf_encode<OidbBase<LinuxFriendSettingUinResponseBody>>({
                    command: 0x7c1,
                    subCommand: 1,
                    errorCode: 0,
                    body: { peerUin: target, setting: 2, result: 0, errorCode: 0 },
                });
            } else if (request.command === ADD) {
                body = protobuf_encode<OidbBase<LinuxFriendAddResponseBody>>({
                    command: 0x7c2,
                    subCommand: 5,
                    errorCode: 0,
                    body: { friendSetting: 9, result: 0, errorCode: 0 },
                });
            } else {
                throw new Error('unexpected synthetic command');
            }

            const reply = response(
                request.sequence + (settings.replySequenceDelta ?? 0),
                request.command,
                body,
                settings.replyUin ?? value.uin,
                settings.replyKey ?? peerValue.tickets.d2Key,
                settings.result === 'sso-error' ? 5 : 0,
            );

            if (
                settings.sameChunkRenewalPush &&
                request.command === NATIVE_TICKET_REFRESH_COMMAND
            ) {
                const push = restoredPush13(value, {
                    key:
                        settings.renewalPushGeneration === 'old'
                            ? peerValue.tickets.d2Key
                            : renewedKey,
                });
                const combined = Buffer.concat([reply, push]);
                stream.emit('data', combined);
                combined.fill(0);
                push.fill(0);
            } else {
                stream.emit('data', reply);
            }

            reply.fill(0);
            body.fill(0);
        } catch (error) {
            failures.push(error);
            stream.emit('error', error);
        } finally {
            bytes.fill(0);
        }
    };

    const common: Omit<WtMultiplexReferenceOptions, 'session'> = {
        exclusiveConnected: true,
        transportUin: value.uin,
        initialSequence: 50,
        maxFrameBytes: 65536,
        maxBufferedBytes: 262144,
        maxFrames: 32,
        maxPushFrames: 8,
        maxPushBytes: 262144,
        maxWriteBufferBytes: 262144,
        leaseTimeoutMs: 10000,
        verifyPushRaw: () => true,
        onPush: (_bytes, meta) => {
            delivered.push(meta.sequence);
        },
    };
    const sessionCommon = {
        registration: {
            version: 'build-v',
            deviceName: 'name',
            deviceType: 'type',
            vendorOs: 'os',
            random: 4,
        },
        timeoutMs: settings.timeoutMs ?? 500,
        signal: controller.signal,
        checkpoint: settings.checkpoint,
        buildRegisterReserved: ((input) => {
            signed.push(input);
            return settings.sign?.(input) ?? Uint8Array.of(8);
        }) as Sign,
        verifyRegisterRaw: settings.verify ?? (() => true),
    };
    const restoredOptions: WtRestoredMultiplexReferenceOptions = {
        ...common,
        session: {
            ...sessionCommon,
            persisted: value,
            profile: { subAppId: 43, version: 'header-v' },
            restoreTimeoutMs: settings.restoreTimeoutMs ?? 7000,
            renewalCheckpoint: settings.renewalCheckpoint,
        },
    };
    const qrOptions: WtMultiplexReferenceOptions = {
        ...common,
        transportUin: '0',
        session: {
            ...sessionCommon,
            profile: {
                uin: '999',
                appId: 42,
                subAppId: 43,
                clientVersion: 44,
                guid: value.guid,
                unknown21: new Uint8Array(21),
                randomKey: new Uint8Array(16).fill(7),
                peerPublicKey: peer.publicKey,
                ssoVersion: 'header-v',
                qrCommand: 'fixture.qr',
                loginCommand: 'fixture.login',
            },
            attemptTimeoutMs: 7000,
            getTimestamp: () => 10,
            buildWtReserved: async () => new Uint8Array(),
            verifyRaw: () => true,
            verifyContext: ({ requestUin, responseUin }) => requestUin === responseUin,
            sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
        },
    };
    return {
        stream,
        controller,
        requests,
        signed,
        delivered,
        failures,
        value,
        restoredOptions,
        qrOptions,
        createRestored: () => createWtRestoredMultiplexReference(stream, restoredOptions),
        createQr: () => {
            qr = true;
            return createWtMultiplexReference(stream, qrOptions);
        },
        close: (session: WtActiveReferenceSession) => {
            session.close();
            stream.emit('close');
            disposeWtPersistedSession(peerValue);
        },
        push: () =>
            stream.emit(
                'data',
                response(889, PUSH, Uint8Array.of(1), value.uin, peerValue.tickets.d2Key),
            ),
    };
}

const renewedKey = new Uint8Array(16).fill(22);
type NativeRefreshOptions = Parameters<typeof nativeRefresh.refreshNativeTicketsOnTransport>[1];
type NativeRefreshCapability = Parameters<typeof nativeRefresh.refreshNativeTicketsOnTransport>[2];

async function exerciseNativeRefreshCallbacks(
    options: NativeRefreshOptions,
    capability: NativeRefreshCapability,
): Promise<void> {
    for (const [index, command] of [
        NATIVE_KEY_EXCHANGE_COMMAND,
        NATIVE_TICKET_REFRESH_COMMAND,
    ].entries()) {
        const sequence = 900 + index;
        const body = Uint8Array.of(index + 1, 7, 9);
        const request = Uint8Array.of(index + 11, 12);
        const responseBytes = Uint8Array.of(index + 21, 22);
        const run = {};
        let reserved: Uint8Array | undefined;
        let verified: boolean | undefined;

        if (capability) {
            privateSession.beginReferenceSend(
                capability.token,
                capability.attempt,
                capability.lease,
                run,
            );
        }

        try {
            reserved = await options.buildReserved({
                uin: options.persisted.uin,
                uid: options.persisted.uid,
                command,
                sequence,
                body,
            });
            verified = await options.verifyRaw({
                uin: options.persisted.uin,
                command,
                sequence,
                requestFrame: request,
                responseFrame: responseBytes,
            });
        } finally {
            if (capability) {
                privateSession.endReferenceSend(
                    capability.token,
                    capability.attempt,
                    capability.lease,
                    run,
                );
            }

            body.fill(0);
            reserved?.fill(0);
            request.fill(0);
            responseBytes.fill(0);
        }

        if (verified !== true) {
            throw new Error('synthetic native refresh verification failed');
        }
    }
}

function refreshedCandidate(
    options: NativeRefreshOptions,
    metadata = { nextRefreshAtSeconds: 1_700_000_900n, expiresAtSeconds: 1_700_003_600n },
) {
    return {
        kind: 'refreshed' as const,
        persisted: cloneWtPersistedSession({
            ...options.persisted,
            tickets: {
                d2: Uint8Array.of(31, 32),
                d2Key: renewedKey,
                a1: Uint8Array.of(33),
                a2: Uint8Array.of(34),
            },
        }),
        metadata,
    };
}

function syntheticNativeExchange(command: string) {
    return createSsoReferenceExchange<{ body: Uint8Array }, Uint8Array>({
        name: 'synthetic native continuation exchange',
        command,
        responseBodyLimit: 1024,
        snapshotRequest: (input, record) => ({
            body: Uint8Array.from(record(input, ['body']).body as Uint8Array),
        }),
        encodeRequest: (input) => Uint8Array.from(input.body),
        decodeResponse: (body) => Uint8Array.from(body),
        disposeResponse: (body) => body.fill(0),
    });
}

const syntheticNativeKeyExchange = syntheticNativeExchange(NATIVE_KEY_EXCHANGE_COMMAND);
const syntheticNativeTicketExchange = syntheticNativeExchange(NATIVE_TICKET_REFRESH_COMMAND);

async function exerciseNativeRefreshTransport(
    transport: Parameters<typeof nativeRefresh.refreshNativeTicketsOnTransport>[0],
    options: NativeRefreshOptions,
    capability: Parameters<typeof nativeRefresh.refreshNativeTicketsOnTransport>[2],
) {
    const base = {
        login: {
            status: 'tickets' as const,
            uin: options.persisted.uin,
            tickets: options.persisted.tickets,
        },
        profile: {
            guid: options.persisted.guid,
            subAppId: options.profile.subAppId,
            version: options.profile.version,
        },
        uid: options.persisted.uid,
        maxResponseBodyBytes: 1024,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        buildReserved: options.buildReserved,
        verifyRaw: options.verifyRaw,
    };

    for (const [index, exchange] of [
        syntheticNativeKeyExchange,
        syntheticNativeTicketExchange,
    ].entries()) {
        const result = await exchange(
            transport,
            { ...base, request: { body: Uint8Array.of(index + 1) } },
            capability ? { ...capability, run: {} } : undefined,
        );

        if (result.kind !== 'response' || result.value.status !== 'response') {
            throw new Error('synthetic native continuation exchange failed');
        }

        result.value.response.fill(0);
    }

    return refreshedCandidate(options);
}

async function qrReady(session: ReturnType<typeof createWtMultiplexReference>) {
    await deadline(
        session.fetch({
            packageName: 'p',
            ptVersion: 'v',
            miscBitMap: 1,
            ssoVersion: 1,
            d1: Uint8Array.of(1),
        }),
        'QR fetch',
    );
    expect(await deadline(session.poll(), 'QR poll')).toEqual({ status: 'confirmed' });
}

async function fails(operation: Promise<unknown>) {
    const result = await deadline(
        operation.then(
            () => ({ rejected: false }),
            (error: unknown) => ({ rejected: true, error }),
        ),
        'operation must settle itself',
    );
    expect(result.rejected).toBe(true);
    return result;
}

describe('WT checkpoint and explicit restored owner', () => {
    it('keeps checkpoint disabled by default', async () => {
        const f = fixture();
        const session = f.createQr();

        try {
            await qrReady(session);
            expect(await deadline(session.loginAndRegister(loginFields), 'register')).toEqual({
                status: 'success',
            });
            expect(f.requests.map((request) => request.command)).toEqual([REGISTER]);
            expect(session.getState()).toBe('success');
            expect(f.failures).toEqual([]);
        } finally {
            f.close(session);
        }
    });

    it('waits for durable callback, shields pushes, then restores the complete active path without QR', async () => {
        const entered = deferred<void>();
        const durable = deferred<void>();
        let saved: Uint8Array | undefined;
        let borrowed: WtPersistedSessionV1 | undefined;
        let context: WtSessionCheckpointContext | undefined;
        const f = fixture({
            preRegisterPush: true,
            checkpoint: {
                timeoutMs: 1000,
                async save(value, current) {
                    borrowed = value;
                    context = current;
                    expect(current.isCurrent()).toBe(true);
                    expect(current.signal.aborted).toBe(false);
                    saved = encodeWtPersistedSession(value);
                    entered.resolve();
                    await durable.promise;
                },
            },
        });
        const session = f.createQr();

        try {
            await qrReady(session);
            let settled = false;
            const pending = session.loginAndRegister(loginFields).then((result) => {
                settled = true;
                return result;
            });
            void pending.catch(() => {});
            await deadline(entered.promise, 'checkpoint entered');
            expect(settled).toBe(false);
            expect(f.delivered).toEqual([]);
            expect(session.getState()).toBe('login-register');
            durable.resolve();
            expect(await deadline(pending, 'checkpoint settled')).toEqual({ status: 'success' });
            expect(context!.isCurrent()).toBe(false);
            expect(zeroed(borrowed!)).toBe(true);
            await waitFor(() => f.delivered.length === 1, 'push after durability');
            expect(f.delivered).toEqual([888]);
        } finally {
            durable.resolve();
            f.close(session);
        }

        const hydrated = decodeWtPersistedSession(saved!);
        const g = fixture({ value: hydrated });
        const attemptSpy = vi.spyOn(attempts, 'createBorrowedWtReferenceLoginAttempt');
        const restored = g.createRestored();

        try {
            expect(Object.keys(restored).sort()).toEqual(
                [
                    'alive',
                    'close',
                    'friendRequest',
                    'getState',
                    'heartbeat',
                    'refreshTickets',
                    'restoreAndRegister',
                    'requestPacket',
                    'sendText',
                    'whenClosed',
                ].sort(),
            );
            expect(restored.getState()).toBe('new');
            expect(g.stream.writes).toBe(0);
            expect(attemptSpy).not.toHaveBeenCalled();
            expect(await deadline(restored.restoreAndRegister(), 'restore')).toEqual({
                status: 'success',
            });
            expect(await deadline(restored.heartbeat(), 'heartbeat')).toEqual({
                status: 'success',
                interval: 37n,
            });
            expect(await deadline(restored.alive(), 'alive')).toEqual({ status: 'success' });
            expect(await deadline(restored.sendText(sendInput()), 'send')).toMatchObject({
                status: 'response',
            });
            expect(await deadline(restored.friendRequest(friendInput()), 'friend')).toMatchObject({
                applicationAttempted: true,
            });
            expect(g.requests.map((request) => request.command)).toEqual([
                REGISTER,
                HEARTBEAT,
                ALIVE,
                SEND,
                QUERY,
                ADD,
            ]);
            expect(
                g.requests
                    .filter((request) => request.protocol === 12)
                    .every(
                        (request) => request.guid === Buffer.from(hydrated.guid).toString('hex'),
                    ),
            ).toBe(true);
            expect(g.requests[0].a2).toEqual(hydrated.tickets.a2);
            expect(g.requests[0].d2).toEqual(hydrated.tickets.d2);
            expect(
                g.signed.every(
                    (request) => request.uin === hydrated.uin && request.uid === hydrated.uid,
                ),
            ).toBe(true);
            expect(g.failures).toEqual([]);
        } finally {
            attemptSpy.mockRestore();
            g.close(restored);
            disposeWtPersistedSession(hydrated);
            saved!.fill(0);
        }
    });

    it.each(['qr', 'restored'] as const)(
        'erases %s checkpoint on close and fences its late durable result',
        async (mode) => {
            const entered = deferred<void>();
            const finish = deferred<void>();
            let borrowed!: WtPersistedSessionV1;
            let context!: WtSessionCheckpointContext;
            const f = fixture({
                checkpoint: {
                    timeoutMs: 1000,
                    async save(value, current) {
                        borrowed = value;
                        context = current;
                        entered.resolve();
                        await finish.promise;
                    },
                },
            });
            const session = mode === 'qr' ? f.createQr() : f.createRestored();

            try {
                const pending =
                    'loginAndRegister' in session
                        ? (await qrReady(session), session.loginAndRegister(loginFields))
                        : session.restoreAndRegister();
                const failure = fails(pending);
                await deadline(entered.promise, 'checkpoint entered');
                session.close();
                expect(context.signal.aborted).toBe(true);
                expect(context.isCurrent()).toBe(false);
                expect(zeroed(borrowed)).toBe(true);
                await failure;
                finish.resolve();
                await turn();
                expect(session.getState()).toBe('closed');
                expect(f.delivered).toEqual([]);
                expect(f.stream.writes).toBe(mode === 'qr' ? 4 : 1);
            } finally {
                finish.resolve();
                f.close(session);
            }
        },
    );

    it.each(['throw', 'reject', 'timeout'] as const)(
        'fails checkpoint %s without a success or retry',
        async (mode) => {
            let borrowed!: WtPersistedSessionV1;
            const late = deferred<void>();
            const f = fixture({
                preRegisterPush: true,
                checkpoint: {
                    timeoutMs: 20,
                    save(value) {
                        borrowed = value;

                        if (mode === 'throw') {
                            throw new Error('synthetic sink error');
                        }

                        if (mode === 'reject') {
                            return Promise.reject(new Error('synthetic sink error'));
                        }

                        return late.promise;
                    },
                },
            });
            const session = f.createRestored();

            try {
                await fails(session.restoreAndRegister());
                expect(zeroed(borrowed)).toBe(true);
                expect(f.stream.writes).toBe(1);
                expect(f.delivered).toEqual([]);
                expect(['failed', 'closed']).toContain(session.getState());
            } finally {
                late.resolve();
                f.close(session);
            }
        },
    );

    it.each(['rejected', 'missing-result', 'sso-error'] as const)(
        'returns registration outcome %s without checkpoint, QR or retry',
        async (result) => {
            const save = vi.fn();
            const f = fixture({ result, checkpoint: { timeoutMs: 500, save } });
            const session = f.createRestored();

            try {
                expect(
                    await deadline(session.restoreAndRegister(), 'failed registration result'),
                ).toEqual({ status: result });
                expect(save).not.toHaveBeenCalled();
                expect(f.stream.writes).toBe(1);
                expect(f.delivered).toEqual([]);
                await fails(session.friendRequest(friendInput()));
                expect(f.stream.writes).toBe(1);
            } finally {
                f.close(session);
            }
        },
    );

    it.each(['wrong-uin', 'wrong-key', 'wrong-sequence', 'verifier', 'deadline'] as const)(
        'rejects restored registration %s without entering active state',
        async (mode) => {
            const save = vi.fn();
            const f = fixture({
                checkpoint: { timeoutMs: 500, save },
                timeoutMs: 60,
                replyUin: mode === 'wrong-uin' ? '456' : undefined,
                replyKey: mode === 'wrong-key' ? new Uint8Array(16).fill(11) : undefined,
                replySequenceDelta: mode === 'wrong-sequence' ? 1 : 0,
                verify: mode === 'verifier' ? () => false : undefined,
                noReply: mode === 'deadline',
            });
            const session = f.createRestored();

            try {
                const failure = await fails(session.restoreAndRegister());
                expect(failure).toMatchObject({
                    error: {
                        message: 'session restore or registration failed',
                        cause: {
                            message: expect.stringContaining('registration transport failed ('),
                        },
                    },
                });
                expect(save).not.toHaveBeenCalled();
                expect(['failed', 'closed']).toContain(session.getState());
                expect(f.stream.writes).toBe(1);
            } finally {
                f.close(session);
            }
        },
    );

    it('snapshots caller bytes and isolates two restored owners with independent keys and cleanup', async () => {
        const a = fixture({ value: snapshot('123', 10) });
        const b = fixture({ value: snapshot('456', 11) });
        const first = a.createRestored();
        const second = b.createRestored();

        try {
            disposeWtPersistedSession(a.value);
            expect(await deadline(first.restoreAndRegister(), 'first restore')).toEqual({
                status: 'success',
            });
            expect(await deadline(second.restoreAndRegister(), 'second restore')).toEqual({
                status: 'success',
            });
            first.close();
            expect(await deadline(second.heartbeat(), 'surviving heartbeat')).toEqual({
                status: 'success',
                interval: 37n,
            });
            expect(
                await deadline(second.friendRequest(friendInput()), 'surviving friend'),
            ).toMatchObject({ applicationAttempted: true });
            expect(a.stream.writes).toBe(1);
            expect(b.requests.every((request) => request.uin === '456')).toBe(true);
            expect(a.failures).toEqual([]);
            expect(b.failures).toEqual([]);
        } finally {
            a.close(first);
            b.close(second);
        }
    });

    it('rejects mismatched transport binding and accessor records before any write', () => {
        const f = fixture();
        const trap = vi.fn(() => '123');

        try {
            expect(() =>
                createWtRestoredMultiplexReference(f.stream, {
                    ...f.restoredOptions,
                    transportUin: '456',
                }),
            ).toThrow('restored account mismatch');
            const bad = Object.defineProperty({ ...f.restoredOptions }, 'transportUin', {
                get: trap,
            });
            expect(() => createWtRestoredMultiplexReference(f.stream, bad)).toThrow(
                'invalid restored options',
            );
            expect(trap).not.toHaveBeenCalled();
            expect(f.stream.writes).toBe(0);
        } finally {
            f.stream.destroy();
        }
    });

    it('stops on abort while signing, with no write and no late resurrection', async () => {
        const entered = deferred<void>();
        const release = deferred<Uint8Array>();
        const f = fixture({
            sign: () => {
                entered.resolve();
                return release.promise;
            },
        });
        const session = f.createRestored();

        try {
            const failure = fails(session.restoreAndRegister());
            await deadline(entered.promise, 'signer entered');
            f.controller.abort();
            await failure;
            release.resolve(Uint8Array.of(5));
            await turn();
            expect(f.stream.writes).toBe(0);
            expect(session.getState()).toBe('closed');
        } finally {
            release.resolve(Uint8Array.of(5));
            f.close(session);
        }
    });

    it('rejects concurrent and repeated restore without a second registration', async () => {
        const entered = deferred<void>();
        const release = deferred<boolean>();
        const f = fixture({
            verify: () => {
                entered.resolve();
                return release.promise;
            },
        });
        const session = f.createRestored();

        try {
            const first = session.restoreAndRegister();
            await deadline(entered.promise, 'verifier entered');
            await fails(session.restoreAndRegister());
            release.resolve(true);
            expect(await deadline(first, 'initial restore')).toEqual({ status: 'success' });
            expect(f.stream.writes).toBe(1);
        } finally {
            release.resolve(true);
            f.close(session);
        }

        const g = fixture();
        const registered = g.createRestored();

        try {
            expect(await deadline(registered.restoreAndRegister(), 'restore once')).toEqual({
                status: 'success',
            });
            await fails(registered.restoreAndRegister());
            expect(g.stream.writes).toBe(1);
        } finally {
            g.close(registered);
        }
    });

    it('validates checkpoint GUID length before constructing a QR attempt', () => {
        const f = fixture({ checkpoint: { timeoutMs: 500, save: () => {} } });
        f.qrOptions.session.profile = { ...f.qrOptions.session.profile, guid: new Uint8Array(2) };
        const attempt = vi.spyOn(attempts, 'createBorrowedWtReferenceLoginAttempt');

        try {
            expect(() => f.createQr()).toThrow();
            expect(attempt).not.toHaveBeenCalled();
            expect(f.stream.writes).toBe(0);
        } finally {
            attempt.mockRestore();
            f.stream.destroy();
        }
    });

    it.each(['clock-after-copy', 'timer-disposal'] as const)(
        'erases checkpoint copies when %s throws',
        async (mode) => {
            const captured: WtPersistedSessionV1[] = [];
            let throwClock = false;
            let throwClear = false;
            let context: WtSessionCheckpointContext | undefined;
            const f = fixture({
                checkpoint: {
                    timeoutMs: 500,
                    save(_value, current) {
                        context = current;
                        throwClear = mode === 'timer-disposal';
                    },
                },
            });
            const originalClone = persistedModule.cloneWtPersistedSession;
            const originalClock = performance.now.bind(performance);
            const originalClear = globalThis.clearTimeout;
            const clone = vi
                .spyOn(persistedModule, 'cloneWtPersistedSession')
                .mockImplementation((input) => {
                    const value = originalClone(input);
                    captured.push(value);

                    if (captured.length === 3 && mode === 'clock-after-copy') {
                        throwClock = true;
                    }

                    return value;
                });
            const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
                if (throwClock) {
                    throwClock = false;
                    throw new Error('synthetic clock failure');
                }

                return originalClock();
            });
            const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
                originalClear(handle);

                if (throwClear) {
                    throwClear = false;
                    throw new Error('synthetic disposal failure');
                }
            });
            const session = f.createRestored();

            try {
                await fails(session.restoreAndRegister());
                expect(captured).toHaveLength(3);
                expect(captured.every(zeroed)).toBe(true);
                expect(context?.signal.aborted ?? true).toBe(true);
                expect(f.stream.writes).toBe(1);
            } finally {
                clear.mockRestore();
                clock.mockRestore();
                clone.mockRestore();
                f.close(session);
            }
        },
    );

    it('rejects pre-registration business calls without accessing inputs or creating a request', async () => {
        const f = fixture();
        const session = f.createRestored();
        const touched = vi.fn(() => {
            throw new Error('unexpected input access');
        });
        const send = Object.defineProperty(sendInput(), 'request', { get: touched });
        const friend = Object.defineProperty(friendInput(), 'peerUin', { get: touched });

        try {
            await fails(session.sendText(send));
            await fails(session.friendRequest(friend));
            expect(touched).not.toHaveBeenCalled();
            expect(f.stream.writes).toBe(0);
            expect(
                await deadline(session.restoreAndRegister(), 'restore after denied input'),
            ).toEqual({ status: 'success' });
        } finally {
            f.close(session);
        }
    });

    it('isolates mutable checkpoint bytes from retained credentials and wipes the imported owner on close', async () => {
        const captured: WtPersistedSessionV1[] = [];
        const f = fixture({
            checkpoint: {
                timeoutMs: 500,
                save(value, context) {
                    expect(context.isCurrent()).toBe(true);
                    expect(context.ticketMetadata).toBeUndefined();
                    value.guid.fill(0);
                    Object.values(value.tickets).forEach((bytes) => bytes.fill(0));
                },
            },
        });
        // Observe only independent DTO allocations, never production credentials.
        const original = persistedModule.cloneWtPersistedSession;
        const clone = vi
            .spyOn(persistedModule, 'cloneWtPersistedSession')
            .mockImplementation((input) => {
                const value = original(input);
                captured.push(value);
                return value;
            });
        const session = f.createRestored();

        try {
            expect(
                await deadline(session.restoreAndRegister(), 'restore with borrowed mutation'),
            ).toEqual({ status: 'success' });
            expect(await deadline(session.heartbeat(), 'retained key survived mutation')).toEqual({
                status: 'success',
                interval: 37n,
            });
            expect(captured.some((value) => value.tickets.d2Key.some((byte) => byte !== 0))).toBe(
                true,
            );
            session.close();
            expect(captured.every(zeroed)).toBe(true);
            expect(f.value.tickets.d2Key.every((byte) => byte === 10)).toBe(true);
        } finally {
            clone.mockRestore();
            f.close(session);
        }
    });

    it('requires the zero-metadata WAL checkpoint before any native transport write', async () => {
        let borrowed!: WtPersistedSessionV1;
        let context!: WtSessionCheckpointContext;
        const save = vi.fn((value: WtPersistedSessionV1, current: WtSessionCheckpointContext) => {
            borrowed = value;
            context = current;
            expect(current.ticketMetadata).toEqual({
                nextRefreshAtSeconds: 0n,
                expiresAtSeconds: 0n,
            });
            throw new Error('synthetic WAL failure');
        });
        const f = fixture({ renewalCheckpoint: { timeoutMs: 500, save } });
        const refresh = vi.spyOn(nativeRefresh, 'refreshNativeTicketsOnTransport');
        const session = f.createRestored();

        try {
            expect(await session.restoreAndRegister()).toEqual({ status: 'success' });
            await expect(session.refreshTickets()).rejects.toMatchObject({
                code: 'checkpoint-failed',
                writeState: 'not-written',
            });
            expect(save).toHaveBeenCalledOnce();
            expect(refresh).not.toHaveBeenCalled();
            expect(f.stream.writes).toBe(1);
            expect(context.isCurrent()).toBe(false);
            expect(context.signal.aborted).toBe(true);
            expect(zeroed(borrowed)).toBe(true);
            await deadline(session.whenClosed, 'WAL failure close');
        } finally {
            refresh.mockRestore();
            f.close(session);
        }
    });

    it('durably saves native renewal metadata, rotates the owner key, and drains a queued push afterward', async () => {
        const borrowed: WtPersistedSessionV1[] = [];
        const contexts: WtSessionCheckpointContext[] = [];
        let nativeCandidate!: WtPersistedSessionV1;
        let nativeInput!: WtPersistedSessionV1;
        const entered = deferred<void>();
        const finish = deferred<void>();
        const save = vi.fn(
            async (value: WtPersistedSessionV1, current: WtSessionCheckpointContext) => {
                borrowed.push(value);
                contexts.push(current);
                expect(current.isCurrent()).toBe(true);
                expect(Object.isFrozen(current)).toBe(true);
                expect(Object.isFrozen(current.ticketMetadata)).toBe(true);

                if (current.ticketMetadata?.nextRefreshAtSeconds === 0n) {
                    expect(current.ticketMetadata.expiresAtSeconds).toBe(0n);
                    expect(value.tickets.d2Key).toEqual(new Uint8Array(16).fill(10));
                    return;
                }

                expect(value.tickets.d2Key).toEqual(renewedKey);
                expect(current.ticketMetadata).toEqual({
                    nextRefreshAtSeconds: 1_700_000_900n,
                    expiresAtSeconds: 1_700_003_600n,
                });
                entered.resolve();
                await finish.promise;
            },
        );
        const f = fixture({ renewalCheckpoint: { timeoutMs: 500, save } });
        const refresh = vi
            .spyOn(nativeRefresh, 'refreshNativeTicketsOnTransport')
            .mockImplementation(async (_transport, options, capability) => {
                expect(capability).toMatchObject({ lease: expect.any(Object) });
                expect(options.serverNowSeconds).toBe(1_700_000_123n);
                expect(options.timeoutMs).toBeGreaterThan(0);
                expect(options.timeoutMs).toBeLessThanOrEqual(500);
                nativeInput = options.persisted;
                await exerciseNativeRefreshCallbacks(options, capability);
                const result = refreshedCandidate(options);
                nativeCandidate = result.persisted;
                return result;
            });
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_123_456);
        const session = f.createRestored();

        try {
            expect(await deadline(session.restoreAndRegister(), 'restore before renewal')).toEqual({
                status: 'success',
            });
            expect(save).not.toHaveBeenCalled();
            const pending = session.refreshTickets();
            await deadline(entered.promise, 'renewal checkpoint entered');
            await expect(session.heartbeat()).rejects.toThrow('multiplex session busy or stopped');
            f.stream.emit('data', restoredPush13(f.value, { key: renewedKey }));
            await turn();
            expect(f.delivered).toEqual([]);
            finish.resolve();
            expect(await deadline(pending, 'native refresh completion')).toEqual({
                status: 'refreshed',
                nextRefreshAtSeconds: 1_700_000_900n,
                expiresAtSeconds: 1_700_003_600n,
            });
            await vi.waitFor(() => expect(f.delivered).toEqual([889]));
            expect(save).toHaveBeenCalledTimes(2);
            expect(borrowed).toHaveLength(2);
            expect(borrowed.every((value) => value !== nativeCandidate)).toBe(true);
            expect(contexts.every((current) => !current.isCurrent())).toBe(true);
            expect(contexts.every((current) => current.signal.aborted)).toBe(true);
            expect(contexts.map((current) => current.ticketMetadata)).toEqual([
                { nextRefreshAtSeconds: 0n, expiresAtSeconds: 0n },
                {
                    nextRefreshAtSeconds: 1_700_000_900n,
                    expiresAtSeconds: 1_700_003_600n,
                },
            ]);
            expect(borrowed.every(zeroed)).toBe(true);
            expect(zeroed(nativeCandidate)).toBe(true);
            expect(zeroed(nativeInput)).toBe(true);
            expect(f.signed.slice(-2).map((input) => input.command)).toEqual([
                NATIVE_KEY_EXCHANGE_COMMAND,
                NATIVE_TICKET_REFRESH_COMMAND,
            ]);
            expect(session.getState()).toBe('success');
        } finally {
            finish.resolve();
            clock.mockRestore();
            refresh.mockRestore();
            f.close(session);
        }
    });

    it('holds a same-chunk ticket response/new-key push until candidate staging and activation', async () => {
        const entered = deferred<void>();
        const finish = deferred<void>();
        const events: string[] = [];
        const save = vi.fn(async (_value, context: WtSessionCheckpointContext) => {
            const metadata = context.ticketMetadata!;
            const label = `${metadata.nextRefreshAtSeconds}/${metadata.expiresAtSeconds}`;
            events.push(`save:${label}`);

            if (metadata.nextRefreshAtSeconds !== 0n || metadata.expiresAtSeconds !== 0n) {
                entered.resolve();
                await finish.promise;
            }
        });
        const f = fixture({
            sameChunkRenewalPush: true,
            renewalCheckpoint: { timeoutMs: 1000, save },
        });
        const refresh = vi
            .spyOn(nativeRefresh, 'refreshNativeTicketsOnTransport')
            .mockImplementation(async (transport, options, capability) => {
                events.push('network');
                return exerciseNativeRefreshTransport(transport, options, capability);
            });
        const session = f.createRestored();

        try {
            expect(await session.restoreAndRegister()).toEqual({ status: 'success' });
            const pending = session.refreshTickets();
            await deadline(entered.promise, 'candidate checkpoint after coalesced response');
            expect(events).toEqual(['save:0/0', 'network', 'save:1700000900/1700003600']);
            expect(f.requests.slice(-2).map((request) => request.command)).toEqual([
                NATIVE_KEY_EXCHANGE_COMMAND,
                NATIVE_TICKET_REFRESH_COMMAND,
            ]);
            expect(f.delivered).toEqual([]);
            expect(session.getState()).toBe('success');
            finish.resolve();
            expect(await deadline(pending, 'same-chunk renewal completion')).toEqual({
                status: 'refreshed',
                nextRefreshAtSeconds: 1_700_000_900n,
                expiresAtSeconds: 1_700_003_600n,
            });
            await vi.waitFor(() => expect(f.delivered).toEqual([889]));
            expect(save).toHaveBeenCalledTimes(2);
            expect(f.failures).toEqual([]);
        } finally {
            finish.resolve();
            refresh.mockRestore();
            f.close(session);
        }
    });

    it('wipes a held same-chunk new-key push when close wins candidate checkpoint', async () => {
        const entered = deferred<void>();
        const finish = deferred<void>();
        const verify = vi.fn(() => true);
        let saves = 0;
        const f = fixture({
            sameChunkRenewalPush: true,
            renewalCheckpoint: {
                timeoutMs: 1000,
                async save() {
                    saves++;

                    if (saves === 2) {
                        entered.resolve();
                        await finish.promise;
                    }
                },
            },
        });
        f.restoredOptions.verifyPushRaw = verify;
        const refresh = vi
            .spyOn(nativeRefresh, 'refreshNativeTicketsOnTransport')
            .mockImplementation(exerciseNativeRefreshTransport);
        const session = f.createRestored();

        try {
            expect(await session.restoreAndRegister()).toEqual({ status: 'success' });
            const pending = session.refreshTickets();
            await deadline(entered.promise, 'held push candidate checkpoint');
            expect(f.delivered).toEqual([]);
            expect(verify).not.toHaveBeenCalled();
            session.close();
            await expect(pending).rejects.toMatchObject({
                code: 'checkpoint-failed',
                writeState: 'written',
            });
            finish.resolve();
            await turn();
            expect(f.delivered).toEqual([]);
            expect(verify).not.toHaveBeenCalled();
        } finally {
            finish.resolve();
            refresh.mockRestore();
            f.close(session);
        }
    });

    it('settles a held response continuation when close wins before candidate staging', async () => {
        const entered = deferred<void>();
        const finish = deferred<void>();
        const verify = vi.fn(() => true);
        const save = vi.fn();
        const f = fixture({
            sameChunkRenewalPush: true,
            renewalCheckpoint: { timeoutMs: 1000, save },
        });
        f.restoredOptions.verifyPushRaw = verify;
        const refresh = vi
            .spyOn(nativeRefresh, 'refreshNativeTicketsOnTransport')
            .mockImplementation(async (transport, options, capability) => {
                const candidate = await exerciseNativeRefreshTransport(
                    transport,
                    options,
                    capability,
                );
                entered.resolve();
                await finish.promise;
                return candidate;
            });
        const session = f.createRestored();

        try {
            expect(await session.restoreAndRegister()).toEqual({ status: 'success' });
            const pending = session.refreshTickets();
            await deadline(entered.promise, 'held response before owner candidate stage');
            expect(save).toHaveBeenCalledOnce();
            expect(f.delivered).toEqual([]);
            expect(verify).not.toHaveBeenCalled();
            session.close();
            finish.resolve();
            await expect(deadline(pending, 'close before candidate stage')).rejects.toMatchObject({
                code: 'stopped',
                writeState: 'written',
            });
            await turn();
            expect(f.delivered).toEqual([]);
            expect(verify).not.toHaveBeenCalled();
        } finally {
            finish.resolve();
            refresh.mockRestore();
            f.close(session);
        }
    });

    it.each(['empty-a1', 'protocol-error'] as const)(
        'releases an old-key same-chunk push after %s and permits another manual refresh',
        async (kind) => {
            const save = vi.fn();
            const f = fixture({
                sameChunkRenewalPush: true,
                renewalPushGeneration: 'old',
                renewalCheckpoint: { timeoutMs: 1000, save },
            });
            const refresh = vi
                .spyOn(nativeRefresh, 'refreshNativeTicketsOnTransport')
                .mockImplementation(async (transport, options, capability) => {
                    const candidate = await exerciseNativeRefreshTransport(
                        transport,
                        options,
                        capability,
                    );
                    disposeWtPersistedSession(candidate.persisted);
                    return kind === 'empty-a1'
                        ? { kind: 'empty-a1' as const }
                        : { kind: 'protocol-error' as const, code: 73n, needsLogin: false };
                });
            const session = f.createRestored();

            try {
                expect(await session.restoreAndRegister()).toEqual({ status: 'success' });

                for (let attempt = 1; attempt <= 2; attempt++) {
                    const result = await deadline(
                        session.refreshTickets(),
                        `same-chunk ${kind} refresh ${attempt}`,
                    );
                    expect(result).toEqual(
                        kind === 'empty-a1'
                            ? { status: 'empty-a1' }
                            : {
                                  status: 'protocol-error',
                                  code: 73n,
                                  consecutiveProtocolErrors: attempt,
                              },
                    );
                    await vi.waitFor(() =>
                        expect(f.delivered).toEqual(Array.from({ length: attempt }, () => 889)),
                    );
                }

                expect(refresh).toHaveBeenCalledTimes(2);
                expect(save).toHaveBeenCalledTimes(2);
                expect(await session.heartbeat()).toEqual({ status: 'success', interval: 37n });
            } finally {
                refresh.mockRestore();
                f.close(session);
            }
        },
    );

    it.each([
        [0n, 0n],
        [0n, 49n],
        [91n, 7n],
    ] as const)(
        'preserves renewal metadata pair %s/%s verbatim',
        async (nextRefreshAtSeconds, expiresAtSeconds) => {
            let context!: WtSessionCheckpointContext;
            const metadata: Array<WtSessionCheckpointContext['ticketMetadata']> = [];
            const f = fixture({
                renewalCheckpoint: {
                    timeoutMs: 500,
                    save(_value, current) {
                        context = current;
                        metadata.push(current.ticketMetadata);
                    },
                },
            });
            const refresh = vi
                .spyOn(nativeRefresh, 'refreshNativeTicketsOnTransport')
                .mockImplementation(async (_transport, options, capability) => {
                    await exerciseNativeRefreshCallbacks(options, capability);
                    const candidate = refreshedCandidate(options);
                    return {
                        ...candidate,
                        metadata: { nextRefreshAtSeconds, expiresAtSeconds },
                    };
                });
            const session = f.createRestored();

            try {
                expect(await session.restoreAndRegister()).toEqual({ status: 'success' });
                expect(await session.refreshTickets()).toEqual({
                    status: 'refreshed',
                    nextRefreshAtSeconds,
                    expiresAtSeconds,
                });
                expect(context.ticketMetadata).toEqual({
                    nextRefreshAtSeconds,
                    expiresAtSeconds,
                });
                expect(metadata).toEqual([
                    { nextRefreshAtSeconds: 0n, expiresAtSeconds: 0n },
                    { nextRefreshAtSeconds, expiresAtSeconds },
                ]);
            } finally {
                refresh.mockRestore();
                f.close(session);
            }
        },
    );

    it('counts only non-login protocol errors and returns a local disabled marker after ten', async () => {
        const metadata: Array<WtSessionCheckpointContext['ticketMetadata']> = [];
        const save = vi.fn((_value, context: WtSessionCheckpointContext) => {
            metadata.push(context.ticketMetadata);
        });
        const f = fixture({ renewalCheckpoint: { timeoutMs: 500, save } });
        let calls = 0;
        const refresh = vi
            .spyOn(nativeRefresh, 'refreshNativeTicketsOnTransport')
            .mockImplementation(async (_transport, options, capability) => {
                await exerciseNativeRefreshCallbacks(options, capability);
                calls++;
                return calls === 2
                    ? { kind: 'empty-a1' as const }
                    : { kind: 'protocol-error' as const, code: 71n, needsLogin: false };
            });
        const session = f.createRestored();

        try {
            expect(await session.restoreAndRegister()).toEqual({ status: 'success' });
            expect(await session.refreshTickets()).toEqual({
                status: 'protocol-error',
                code: 71n,
                consecutiveProtocolErrors: 1,
            });
            expect(await session.refreshTickets()).toEqual({ status: 'empty-a1' });

            for (let count = 2; count < 10; count++) {
                expect(await session.refreshTickets()).toEqual({
                    status: 'protocol-error',
                    code: 71n,
                    consecutiveProtocolErrors: count,
                });
            }

            const disabled = await session.refreshTickets();
            expect(disabled).toEqual({
                status: 'disabled',
                reason: 'protocol-errors',
                consecutiveProtocolErrors: 10,
                lastCode: 71n,
            });
            expect(calls).toBe(11);
            expect(await session.refreshTickets()).toEqual(disabled);
            expect(calls).toBe(11);
            expect(save).toHaveBeenCalledTimes(11);
            expect(metadata).toEqual(
                Array.from({ length: 11 }, () => ({
                    nextRefreshAtSeconds: 0n,
                    expiresAtSeconds: 0n,
                })),
            );
            expect(await session.heartbeat()).toEqual({ status: 'success', interval: 37n });
        } finally {
            refresh.mockRestore();
            f.close(session);
        }
    });

    it('strictly snapshots refresh options before entering the multiplex owner gate', async () => {
        const f = fixture({
            renewalCheckpoint: { timeoutMs: 500, save: vi.fn() },
        });
        const refresh = vi.spyOn(nativeRefresh, 'refreshNativeTicketsOnTransport');
        const touched = vi.fn();
        const accessor = Object.defineProperty({}, 'timeoutMs', {
            get() {
                touched();
                return 500;
            },
        });
        const session = f.createRestored();

        try {
            expect(await session.restoreAndRegister()).toEqual({ status: 'success' });

            for (const input of [
                accessor,
                { timeoutMs: 0 },
                { timeoutMs: 500, extra: true },
                { signal: {} },
                new Proxy({ timeoutMs: 500 }, {}),
            ]) {
                await expect(session.refreshTickets(input as never)).rejects.toThrow(
                    'invalid ticket refresh options',
                );
            }

            const stopped = new AbortController();
            stopped.abort();
            await expect(session.refreshTickets({ signal: stopped.signal })).rejects.toThrow(
                'ticket refresh stopped',
            );
            expect(touched).not.toHaveBeenCalled();
            expect(refresh).not.toHaveBeenCalled();
            expect(session.getState()).toBe('success');
            expect(await session.heartbeat()).toEqual({ status: 'success', interval: 37n });
        } finally {
            refresh.mockRestore();
            f.close(session);
        }
    });

    it('awaits durable invalidation without renewal metadata before exposing needs-login', async () => {
        let context!: WtSessionCheckpointContext;
        const save = vi.fn();
        const invalidate = vi.fn(async (current: WtSessionCheckpointContext) => {
            context = current;
            expect(current.ticketMetadata).toBeUndefined();
            expect(current.isCurrent()).toBe(true);
            await turn();
            expect(current.isCurrent()).toBe(true);
        });
        const f = fixture({
            renewalCheckpoint: { timeoutMs: 500, save, invalidate },
        });
        const refresh = vi
            .spyOn(nativeRefresh, 'refreshNativeTicketsOnTransport')
            .mockImplementation(async (_transport, options, capability) => {
                await exerciseNativeRefreshCallbacks(options, capability);
                return { kind: 'protocol-error', code: 8n, needsLogin: true };
            });
        const session = f.createRestored();

        try {
            expect(await session.restoreAndRegister()).toEqual({ status: 'success' });
            expect(await session.refreshTickets()).toEqual({ status: 'needs-login', code: 8n });
            expect(save).toHaveBeenCalledTimes(1);
            expect(save.mock.calls[0]?.[1].ticketMetadata).toEqual({
                nextRefreshAtSeconds: 0n,
                expiresAtSeconds: 0n,
            });
            expect(invalidate).toHaveBeenCalledTimes(1);
            expect(context.ticketMetadata).toBeUndefined();
            expect(context.isCurrent()).toBe(false);
            expect(context.signal.aborted).toBe(true);
            await deadline(session.whenClosed, 'needs-login close');
        } finally {
            refresh.mockRestore();
            f.close(session);
        }
    });

    it.each(['missing', 'failed'] as const)(
        'closes and rejects needs-login when invalidation is %s',
        async (mode) => {
            const checkpoint: WtSessionCheckpoint = {
                timeoutMs: 500,
                save: vi.fn(),
                ...(mode === 'failed'
                    ? {
                          invalidate: vi.fn(() => {
                              throw new Error('synthetic invalidation failure');
                          }),
                      }
                    : {}),
            };
            const f = fixture({ renewalCheckpoint: checkpoint });
            const refresh = vi
                .spyOn(nativeRefresh, 'refreshNativeTicketsOnTransport')
                .mockImplementation(async (_transport, options, capability) => {
                    await exerciseNativeRefreshCallbacks(options, capability);
                    return { kind: 'protocol-error', code: 8n, needsLogin: true };
                });
            const session = f.createRestored();

            try {
                expect(await session.restoreAndRegister()).toEqual({ status: 'success' });
                await expect(session.refreshTickets()).rejects.toMatchObject({
                    code: 'invalidation-failed',
                    writeState: 'written',
                });
                await deadline(session.whenClosed, 'failed invalidation close');
            } finally {
                refresh.mockRestore();
                f.close(session);
            }
        },
    );

    it.each([
        ['exchange-failed', 'not-written', 'not-sent'],
        ['invalid-response', 'written', 'invalid-response'],
        ['operation-stopped', 'unknown', 'stopped'],
    ] as const)(
        'projects native %s/%s into fixed owner error %s',
        async (nativeCode, writeState, expectedCode) => {
            const save = vi.fn(
                (value: WtPersistedSessionV1, context: WtSessionCheckpointContext) => {
                    expect(value.tickets.d2Key).toEqual(new Uint8Array(16).fill(10));
                    expect(context.ticketMetadata).toEqual({
                        nextRefreshAtSeconds: 0n,
                        expiresAtSeconds: 0n,
                    });
                },
            );
            const f = fixture({
                renewalCheckpoint: { timeoutMs: 500, save },
            });
            const refresh = vi
                .spyOn(nativeRefresh, 'refreshNativeTicketsOnTransport')
                .mockRejectedValue(
                    new nativeRefresh.NativeTicketRefreshError('refresh', nativeCode, writeState),
                );
            const session = f.createRestored();

            try {
                expect(await session.restoreAndRegister()).toEqual({ status: 'success' });
                const failure = await session.refreshTickets().catch((error: unknown) => error);
                expect(failure).toMatchObject({ code: expectedCode, writeState });
                expect((failure as Error).message).toBe(`WT ticket refresh: ${expectedCode}`);
                expect(Object.hasOwn(failure as object, 'cause')).toBe(false);
                expect(save).toHaveBeenCalledOnce();
                expect(save.mock.calls[0]?.[1].ticketMetadata).toEqual({
                    nextRefreshAtSeconds: 0n,
                    expiresAtSeconds: 0n,
                });
                await deadline(session.whenClosed, 'native refresh error close');
            } finally {
                refresh.mockRestore();
                f.close(session);
            }
        },
    );

    it.each(['checkpoint', 'activation'] as const)(
        'reports a fixed %s failure after the native response',
        async (stage) => {
            let saves = 0;
            const save = vi.fn(() => {
                saves++;

                if (stage === 'checkpoint' && saves === 2) {
                    throw new Error('synthetic durable failure');
                }
            });
            const f = fixture({ renewalCheckpoint: { timeoutMs: 500, save } });
            const refresh = vi
                .spyOn(nativeRefresh, 'refreshNativeTicketsOnTransport')
                .mockImplementation(async (_transport, options, capability) => {
                    await exerciseNativeRefreshCallbacks(options, capability);
                    return refreshedCandidate(options);
                });
            const rotate =
                stage === 'activation'
                    ? vi
                          .spyOn(privateSession, 'rotateReferenceTicketKey')
                          .mockImplementation(() => {
                              throw new Error('synthetic activation failure');
                          })
                    : undefined;
            const session = f.createRestored();

            try {
                expect(await session.restoreAndRegister()).toEqual({ status: 'success' });
                await expect(session.refreshTickets()).rejects.toMatchObject({
                    code: stage === 'checkpoint' ? 'checkpoint-failed' : 'activation-failed',
                    writeState: 'written',
                });
                expect(save).toHaveBeenCalledTimes(2);
                await deadline(session.whenClosed, `${stage} failure close`);
            } finally {
                rotate?.mockRestore();
                refresh.mockRestore();
                f.close(session);
            }
        },
    );

    it('aborts and wipes a pending WAL save before native transport when close wins', async () => {
        const entered = deferred<void>();
        const finish = deferred<void>();
        let borrowed!: WtPersistedSessionV1;
        let context!: WtSessionCheckpointContext;
        const f = fixture({
            renewalCheckpoint: {
                timeoutMs: 1000,
                async save(value, current) {
                    borrowed = value;
                    context = current;
                    entered.resolve();
                    await finish.promise;
                },
            },
        });
        const refresh = vi
            .spyOn(nativeRefresh, 'refreshNativeTicketsOnTransport')
            .mockImplementation(async (_transport, options, capability) => {
                await exerciseNativeRefreshCallbacks(options, capability);
                return refreshedCandidate(options);
            });
        const session = f.createRestored();

        try {
            expect(await session.restoreAndRegister()).toEqual({ status: 'success' });
            const pending = session.refreshTickets();
            await deadline(entered.promise, 'renewal checkpoint entered');
            session.close();
            await expect(pending).rejects.toMatchObject({
                code: 'checkpoint-failed',
                writeState: 'not-written',
            });
            expect(refresh).not.toHaveBeenCalled();
            expect(context.ticketMetadata).toEqual({
                nextRefreshAtSeconds: 0n,
                expiresAtSeconds: 0n,
            });
            expect(context.isCurrent()).toBe(false);
            expect(context.signal.aborted).toBe(true);
            expect(zeroed(borrowed)).toBe(true);
        } finally {
            finish.resolve();
            refresh.mockRestore();
            f.close(session);
        }
    });

    it.each(['abort', 'stream-close', 'lease-timeout', 'restore-timeout'] as const)(
        'fences checkpoint during %s',
        async (mode) => {
            const entered = deferred<void>();
            const finish = deferred<void>();
            let borrowed!: WtPersistedSessionV1;
            let context!: WtSessionCheckpointContext;
            const f = fixture({
                restoreTimeoutMs: mode === 'restore-timeout' ? 70 : 7000,
                checkpoint: {
                    timeoutMs: 1000,
                    async save(value, current) {
                        borrowed = value;
                        context = current;
                        entered.resolve();
                        await finish.promise;
                    },
                },
            });

            if (mode === 'lease-timeout') {
                f.restoredOptions.leaseTimeoutMs = 70;
            }

            const session = f.createRestored();

            try {
                const pending = fails(session.restoreAndRegister());
                await deadline(entered.promise, 'checkpoint entered');
                expect(session.getState()).toBe('restore-register');

                if (mode === 'abort') {
                    f.controller.abort();
                } else if (mode === 'stream-close') {
                    f.stream.destroy();
                    f.stream.emit('close');
                }

                await pending;
                expect(context.isCurrent()).toBe(false);
                expect(context.signal.aborted).toBe(true);
                expect(zeroed(borrowed)).toBe(true);
                expect(f.stream.writes).toBe(1);
                finish.resolve();
                await turn();
                expect(['failed', 'closed']).toContain(session.getState());
            } finally {
                finish.resolve();
                f.close(session);
            }
        },
    );
});

describe('restored protocol-13 MsgPush notifications', () => {
    it('delivers an idle D2 MsgPush through raw and body gates and keeps the owner active', async () => {
        const f = fixture();
        const received = deferred<void>();
        const copies: Uint8Array[] = [];
        const borrowed: Uint8Array[] = [];
        const verify = vi.fn(() => true);
        f.restoredOptions.verifyPushRaw = verify;
        f.restoredOptions.maxPushBodyBytes = 65536;

        f.restoredOptions.onPushBody = (body, meta) => {
            expect(meta).toEqual({ command: PUSH, uin: '123', sequence: 889, retCode: 0 });
            copies.push(Uint8Array.from(body));
            borrowed.push(body);
            received.resolve();
        };

        const session = f.createRestored();
        const frame = restoredPush13(f.value);
        const original = Uint8Array.from(frame);

        try {
            expect(await deadline(session.restoreAndRegister(), 'restore')).toEqual({
                status: 'success',
            });
            expect(frame.readUInt32BE(4)).toBe(13);
            expect(frame[8]).toBe(1);
            f.stream.emit('data', frame);
            await deadline(
                Promise.race([
                    received.promise,
                    session.whenClosed.then(() => {
                        throw new Error('restored owner closed before MsgPush delivery');
                    }),
                ]),
                'MsgPush body',
            );
            await turn();
            expect(copies).toEqual([textBody(889, '123', false, 'synthetic notification')]);
            expect(borrowed[0].every((byte) => byte === 0)).toBe(true);
            expect(verify).toHaveBeenCalledTimes(1);
            expect(f.delivered).toEqual([889]);
            expect(Uint8Array.from(frame)).toEqual(original);
            expect(session.getState()).toBe('success');
            expect(await deadline(session.heartbeat(), 'heartbeat after MsgPush')).toEqual({
                status: 'success',
                interval: 37n,
            });
            expect(f.stream.writes).toBe(2);
            expect(f.failures).toEqual([]);
        } finally {
            f.close(session);
        }
    });

    it('holds protocol-13 MsgPush until the restored checkpoint commits', async () => {
        const entered = deferred<void>();
        const release = deferred<void>();
        const f = fixture({
            checkpoint: {
                timeoutMs: 1000,
                save: () => {
                    entered.resolve();
                    return release.promise;
                },
            },
        });
        const session = f.createRestored();
        const pending = session.restoreAndRegister();
        void pending.catch(() => {});

        try {
            await deadline(entered.promise, 'checkpoint');
            f.stream.emit('data', restoredPush13(f.value));
            await turn();
            expect(f.delivered).toEqual([]);
            expect(session.getState()).toBe('restore-register');
            release.resolve();
            expect(await deadline(pending, 'checkpoint committed')).toEqual({ status: 'success' });
            await waitFor(() => f.delivered.length === 1, 'queued MsgPush');
            expect(f.delivered).toEqual([889]);
            expect(f.stream.writes).toBe(1);
        } finally {
            release.resolve();
            f.close(session);
        }
    });

    it.each([
        ['wrong account', { uin: '456' }],
        ['wrong key', { key: new Uint8Array(16).fill(99) }],
        ['zero encryption', { encryption: 'zero' }],
        ['no encryption', { encryption: 'none' }],
        [
            'InfoSyncPush protocol 13',
            { command: 'trpc.msg.register_proxy.RegisterProxy.InfoSyncPush' },
        ],
        ['PushParams protocol 13', { command: 'trpc.msg.register_proxy.RegisterProxy.PushParams' }],
        ['near-match command', { command: PUSH + '.Other' }],
    ] as const)('still rejects %s after restoration', async (_name, options) => {
        const f = fixture();
        const verify = vi.fn(() => true);
        const body = vi.fn();
        f.restoredOptions.verifyPushRaw = verify;
        f.restoredOptions.maxPushBodyBytes = 65536;
        f.restoredOptions.onPushBody = body;
        const session = f.createRestored();

        try {
            expect(await deadline(session.restoreAndRegister(), 'restore')).toEqual({
                status: 'success',
            });
            f.stream.emit('data', restoredPush13(f.value, options));
            await deadline(session.whenClosed, 'invalid push closure');
            expect(session.getState()).toBe('closed');
            expect(f.delivered).toEqual([]);
            expect(verify).not.toHaveBeenCalled();
            expect(body).not.toHaveBeenCalled();
            expect(f.stream.writes).toBe(1);
        } finally {
            f.close(session);
        }
    });

    it('still requires independent raw verification for restored protocol-13 MsgPush', async () => {
        const f = fixture();
        const verify = vi.fn(() => false);
        f.restoredOptions.verifyPushRaw = verify;
        const session = f.createRestored();

        try {
            expect(await deadline(session.restoreAndRegister(), 'restore')).toEqual({
                status: 'success',
            });
            f.stream.emit('data', restoredPush13(f.value));
            await deadline(session.whenClosed, 'raw verification failure');
            expect(verify).toHaveBeenCalledTimes(1);
            expect(f.delivered).toEqual([]);
            expect(f.stream.writes).toBe(1);
        } finally {
            f.close(session);
        }
    });
});
