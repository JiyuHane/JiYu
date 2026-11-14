import { EventEmitter } from 'node:events';
import type { DirectThirdPartyLoginResponse } from '@snowluma/proto-defs/direct-login';
import type { PushMsg } from '@snowluma/proto-defs/message';
import type { SsoHeartbeatResponse, SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import type { RawSessionLease } from '../../src/direct/raw-session-broker';
import type { Sso12RawOptions, Sso12RawResult } from '../../src/direct/sso12-packet-client';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawMultiplexStream } from '../../src/direct/raw-multiplex-stream';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import { decodeSsoResponse } from '../../src/direct/sso';
import { decodeServiceResponse } from '../../src/direct/service-frame';
import { SSO_REFERENCE_ALIVE_COMMAND } from '../../src/direct/sso-reference-alive-flow';
import { SSO_HEARTBEAT_COMMAND, SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import { createWtMultiplexReference } from '../../src/direct/wt-multiplex-reference';
import {
    createReferenceKeyCapability,
    revokeReferenceKey,
} from '../../src/direct/wt-reference-session-private';
import {
    createWtReferenceSession,
    createWtReferenceSessionWithCapability,
} from '../../src/direct/wt-reference-session';
import { encodeWtTlv } from '../../src/direct/wt-tlv';
import { fetchBody, parseWt, peer, pollBody, replyWt } from './fixtures/wt-sso-synthetic';

// All peers, accounts, tickets and keys are synthetic. QQTEA is not authentication;
// these checks do not attach a bridge or establish trust in a remote server.
const pushCommand = 'trpc.msg.olpush.OlPushService.MsgPush';
const uid = 'synthetic-uid';
const zeroKey = new Uint8Array(16);
const ticketKey = new Uint8Array(16).fill(4);

const word = (n: number) => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(n >>> 0);
    return out;
};

const field = (bytes: Uint8Array) => Buffer.concat([word(bytes.length + 4), bytes]);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function deadline<T>(promise: PromiseLike<T>, label: string, ms = 3000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            Promise.resolve(promise),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`deadline: ${label}`)), ms);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
    const end = performance.now() + 3000;

    while (!check()) {
        if (performance.now() >= end) {
            throw new Error(`deadline: ${label}`);
        }

        await turn();
    }
}

function loginBody(d2Key: Uint8Array, mode: 'valid' | 'wrong-ticket' | 'missing-d2' = 'valid') {
    const projection = protobuf_encode<DirectThirdPartyLoginResponse>({
        commonInfo: { rspNT: { uid } },
    });
    const inner = encodeWtTlv([
        { tag: 0x143, value: Uint8Array.of(9) },
        ...(mode === 'missing-d2' ? [] : [{ tag: 0x305, value: d2Key }]),
        { tag: 0x10a, value: Uint8Array.of(11) },
        { tag: 0x106, value: Uint8Array.of(12) },
        { tag: 0x543, value: projection },
    ]);
    const cipher = qqTeaEncrypt(
        inner,
        mode === 'wrong-ticket' ? new Uint8Array(16).fill(5) : ticketKey,
    );
    const result = Buffer.concat([
        Buffer.of(0, 9, 0),
        encodeWtTlv([{ tag: 0x119, value: cipher }]),
    ]);
    inner.fill(0);
    projection.fill(0);
    return result;
}

function loginErrorBody() {
    return Buffer.concat([
        Buffer.of(0, 9, 1),
        encodeWtTlv([
            {
                tag: 0x146,
                value: Buffer.concat([
                    word(42),
                    Buffer.of(0, 5),
                    Buffer.from('title'),
                    Buffer.of(0, 6),
                    Buffer.from('detail'),
                ]),
            },
        ]),
    ]);
}

function response(
    sequence: number,
    command: string,
    body: Uint8Array,
    account: string,
    key: Uint8Array | undefined,
    retCode = 0,
) {
    const inner = Buffer.concat([
        field(
            Buffer.concat([
                word(sequence),
                word(retCode),
                field(Buffer.alloc(0)),
                field(Buffer.from(command)),
                field(Buffer.alloc(0)),
                word(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(body),
    ]);
    const payload = key ? qqTeaEncrypt(inner, key) : Buffer.from(inner);
    inner.fill(0);
    return Buffer.concat([
        word(14 + Buffer.byteLength(account) + payload.length),
        word(key ? 12 : 13),
        Buffer.of(key ? 1 : 0, 0),
        field(Buffer.from(account)),
        payload,
    ]);
}

function push(sequence: number, account: string, key: Uint8Array) {
    const body = protobuf_encode<PushMsg>({
        message: {
            responseHead: { fromUin: 456, fromUid: 'synthetic-sender', toUin: Number(account) },
            contentHead: { msgType: 166, sequence },
            body: { msgContent: Uint8Array.of(1, 2, 3) },
        },
    });
    return response(sequence, pushCommand, body, account, key);
}

// replyWt's login response hard-codes 123 in its OICQ header and outer service account.
function wtReply(request: ReturnType<typeof parseWt>, body: Uint8Array, account: string) {
    const original = replyWt(request, body);

    if (request.kind !== 0x810 || account === '123') {
        return original;
    }

    const oldEnd = 10 + original.readUInt32BE(10);
    const sso = Buffer.from(qqTeaDecrypt(original.subarray(oldEnd), zeroKey));
    const headerEnd = sso.readUInt32BE(0);
    const packet = Buffer.from(sso.subarray(headerEnd + 4));
    packet.writeUInt32BE(Number(account), 9);
    const rebuilt = Buffer.concat([sso.subarray(0, headerEnd), field(packet)]);
    const encrypted = qqTeaEncrypt(rebuilt, zeroKey);
    sso.fill(0);
    packet.fill(0);
    rebuilt.fill(0);
    return Buffer.concat([
        word(14 + Buffer.byteLength(account) + encrypted.length),
        word(12),
        Buffer.of(2, 0),
        field(Buffer.from(account)),
        encrypted,
    ]);
}

function inspectRequest(frame: Uint8Array, key: Uint8Array) {
    const bytes = Buffer.from(frame);
    const protocol = bytes.readUInt32BE(4);
    const accountStart = protocol === 13 ? 14 : 10 + bytes.readUInt32BE(9);
    const accountEnd = accountStart + bytes.readUInt32BE(accountStart);
    const account = bytes.subarray(accountStart + 4, accountEnd).toString();
    const inner =
        protocol === 13
            ? Buffer.from(bytes.subarray(accountEnd))
            : Buffer.from(qqTeaDecrypt(bytes.subarray(accountEnd), key));
    let position = protocol === 13 ? 4 : 28;

    const readField = () => {
        const end = position + inner.readUInt32BE(position);
        const result = inner.subarray(position + 4, end);
        position = end;
        return result;
    };

    if (protocol === 12) {
        readField();
    }

    const command = readField().toString();
    const sequence = protocol === 13 ? bytes.readUInt32BE(9) : inner.readUInt32BE(4);
    inner.fill(0);
    return { account, command, sequence, protocol };
}

class FakeStream extends EventEmitter {
    readable = true;
    writable = true;
    destroyed = false;
    readableFlowing: boolean | null = null;
    writableLength = 0;
    writableNeedDrain = false;
    onWrite: (bytes: Uint8Array) => void = () => {};

    write(bytes: Uint8Array, callback: (error?: Error | null) => void): boolean {
        const copy = Uint8Array.from(bytes);
        // Complete this write independently of any later input or private stage.
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

    finishClose() {
        this.destroy();
        this.emit('close');
    }
}

const fetchFields = {
    packageName: 'p',
    ptVersion: 'v',
    miscBitMap: 1,
    ssoVersion: 1,
    d1: Uint8Array.of(1),
};
const loginFields = {
    mainSigMap: 1,
    miscBitMap: 2,
    subSigMap: 3,
    packageName: 'p',
    ptVersion: 'v',
    sdkVersion: 's',
    os: 'x',
    deviceName: 'd',
    apkSignature: Uint8Array.of(3),
    tlv124Value: new Uint8Array(12),
};

type Settings = {
    account?: string;
    ticketD2?: Uint8Array;
    peerD2?: Uint8Array;
    suppliedPush?: Uint8Array;
    pushSequence?: 'same' | 'different';
    fragmented?: boolean;
    ticketMode?: 'valid' | 'wrong-ticket' | 'missing-d2';
    registerResult?: 'success' | 'rejected';
    verifyPush?: boolean;
    duringVerify?: () => void;
    verifyLogin?: boolean;
    verifyRegister?: boolean;
    holdRegister?: boolean;
    registrationPushes?: boolean;
    pushLimit?: number;
    pushBytes?: number;
    pollEarlyPush?: boolean;
    wrongRegistration?: 'uin' | 'command';
    pollCode?: number;
    loginBusinessError?: boolean;
    skipLoginPush?: boolean;
    postSsoError?: boolean;
    duringRegisterVerify?: () => void;
    signal?: AbortSignal;
};

function setup(settings: Settings = {}) {
    const account = settings.account ?? '123';
    const ticketD2 = settings.ticketD2 ?? new Uint8Array(16).fill(10);
    const peerD2 = settings.peerD2 ?? ticketD2;
    const stream = new FakeStream();
    const registerEntered = deferred<void>();
    const allowRegister = deferred<void>();
    const observed: Array<{ uin: string; sequence: number; command: string }> = [];
    const requests: Array<{
        account: string;
        command: string;
        sequence: number;
        protocol: number;
    }> = [];
    const failures: unknown[] = [];
    const delivery: string[] = [];
    let calls = 0;
    let verifyPushCalls = 0;
    stream.on('error', (error) => failures.push(error));
    const baseline = new Map(
        ['data', 'error', 'end', 'close', 'pause'].map((name) => [name, stream.listeners(name)]),
    );

    let sessionOptions!: Parameters<typeof createWtReferenceSession>[1];
    const session = createWtMultiplexReference(stream, {
        exclusiveConnected: true,
        transportUin: '0',
        initialSequence: 50,
        maxFrameBytes: 65536,
        maxBufferedBytes: 262144,
        maxFrames: 16,
        maxPushFrames: settings.pushLimit ?? 8,
        maxPushBytes: settings.pushBytes ?? 262144,
        maxWriteBufferBytes: 262144,
        leaseTimeoutMs: 10000,
        session: (sessionOptions = {
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
            signal: settings.signal,
            getTimestamp: () => 10,
            buildWtReserved: () => new Uint8Array(),
            verifyRaw: () => calls !== 3 || settings.verifyLogin !== false,
            verifyContext: ({ requestUin, responseUin }) => responseUin === requestUin,
            sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
            registration: {
                version: 'build-v',
                deviceName: 'name',
                deviceType: 'type',
                vendorOs: 'os',
                random: 4,
            },
            buildRegisterReserved: ({ sequence }) => Uint8Array.of(sequence),
            verifyRegisterRaw: async ({ command }) => {
                if (command === SSO_INFO_SYNC_COMMAND && settings.holdRegister) {
                    registerEntered.resolve();
                    await allowRegister.promise;
                }

                if (command === SSO_INFO_SYNC_COMMAND) {
                    settings.duringRegisterVerify?.();
                }

                return command !== SSO_INFO_SYNC_COMMAND || settings.verifyRegister !== false;
            },
        }),
        verifyPushRaw: (_frame, meta) => {
            verifyPushCalls++;
            delivery.push(`verify:${meta.sequence}`);
            settings.duringVerify?.();
            return settings.verifyPush !== false;
        },
        onPush: (_frame, meta) => {
            delivery.push(`push:${meta.sequence}`);
            observed.push({ ...meta });
        },
    });

    stream.onWrite = (bytes) => {
        try {
            calls++;
            let candidate: Uint8Array;

            if (calls <= 3) {
                const wt = parseWt(bytes);
                requests.push({
                    account: wt.account,
                    command: wt.command,
                    sequence: wt.seq,
                    protocol: 12,
                });
                const body =
                    wt.kind === 0x31
                        ? fetchBody()
                        : wt.kind === 0x12
                          ? pollBody(settings.pollCode ?? 0, BigInt(account))
                          : settings.loginBusinessError
                            ? loginErrorBody()
                            : loginBody(ticketD2, settings.ticketMode);
                candidate = wtReply(wt, body, account);
                body.fill(0);
                wt.shared.fill(0);
                wt.business.fill(0);

                if (calls === 2 && settings.pollEarlyPush) {
                    const early = push(wt.seq, account, zeroKey);
                    early[8] = 2;
                    stream.emit('data', Buffer.concat([candidate, early]));
                    return;
                }

                if (calls === 3 && !settings.loginBusinessError && !settings.skipLoginPush) {
                    const seq = settings.pushSequence === 'different' ? wt.seq + 100 : wt.seq;
                    const notification = settings.suppliedPush ?? push(seq, account, peerD2);
                    const joined = Buffer.concat([candidate, notification]);

                    if (settings.fragmented) {
                        stream.emit('data', joined.subarray(0, 2));
                        stream.emit('data', joined.subarray(2, 9));
                        stream.emit('data', joined.subarray(9));
                    } else {
                        stream.emit('data', joined);
                    }

                    return;
                }
            } else {
                const request = inspectRequest(bytes, peerD2);
                requests.push(request);
                const body =
                    request.command === SSO_INFO_SYNC_COMMAND
                        ? protobuf_encode<SsoRegisterResponse>({
                              register: {
                                  message:
                                      settings.registerResult === 'rejected'
                                          ? 'register rejected'
                                          : 'register success',
                              },
                          })
                        : request.command === SSO_HEARTBEAT_COMMAND
                          ? protobuf_encode<SsoHeartbeatResponse>({ interval: 270n })
                          : new Uint8Array();
                const isRegistration = request.command === SSO_INFO_SYNC_COMMAND;
                const responseCommand =
                    isRegistration && settings.wrongRegistration === 'command'
                        ? 'synthetic.wrong-command'
                        : request.command;
                const responseAccount =
                    isRegistration && settings.wrongRegistration === 'uin' ? '789' : account;
                candidate = response(
                    request.sequence,
                    responseCommand,
                    body,
                    responseAccount,
                    request.protocol === 13 ? undefined : peerD2,
                    !isRegistration && settings.postSsoError ? 42 : 0,
                );
                body.fill(0);

                if (isRegistration && settings.registrationPushes) {
                    // A known push precedes the response with the very same sequence.
                    stream.emit(
                        'data',
                        Buffer.concat([
                            push(request.sequence, account, peerD2),
                            push(request.sequence + 1, account, peerD2),
                            candidate,
                        ]),
                    );
                    return;
                }
            }

            stream.emit('data', candidate);
        } catch (error) {
            failures.push(error);
            stream.emit('error', error);
        } finally {
            bytes.fill(0);
        }
    };

    const confirm = async () => {
        expect((await deadline(session.fetch(fetchFields), 'fetch')).qrUrl).toBe(
            'https://example.invalid/qr',
        );
        expect(await deadline(session.poll(), 'poll')).toEqual({ status: 'confirmed' });
    };

    const cleanup = async () => {
        allowRegister.resolve();
        session.close();
        stream.finishClose();
        await deadline(session.whenClosed, 'close');
        await turn();

        for (const [name, listeners] of baseline) {
            expect(stream.listeners(name)).toEqual(listeners);
        }
    };

    return {
        session,
        sessionOptions,
        stream,
        observed,
        requests,
        failures,
        delivery,
        registerEntered,
        allowRegister,
        confirm,
        cleanup,
        getVerifyPushCalls: () => verifyPushCalls,
    };
}

async function oldOwnerTerminal(
    options: Parameters<typeof createWtReferenceSession>[1],
    scenario: 'expired' | 'canceled' | 'login-error',
) {
    const stream = new FakeStream();
    stream.on('error', () => {});
    const client = createRawMultiplexStream(stream, {
        exclusiveConnected: true,
        uin: '0',
        initialSequence: 50,
        defaultTimeoutMs: 1500,
        maxFrameBytes: 65536,
        maxBufferedBytes: 262144,
        maxFrames: 16,
        maxPushFrames: 8,
        maxPushBytes: 262144,
        maxWriteBufferBytes: 262144,
        classify: (frame) => ({
            kind: 'response',
            sequence: decodeSsoResponse(decodeServiceResponse(frame, zeroKey).body).sequence >>> 0,
        }),
        verifyPush: () => true,
        onPush: () => {},
    });
    const lease = createRawSessionBroker(client, {
        trustedSuccessQuiescence: true,
        isUsable: () => !client.closed,
    }).acquire({ deadline: performance.now() + 10000 });
    const owner = createWtReferenceSession(lease, options);

    stream.onWrite = (bytes) => {
        const wt = parseWt(bytes);
        const body =
            wt.kind === 0x31
                ? fetchBody()
                : wt.kind === 0x12
                  ? pollBody(scenario === 'expired' ? 17 : scenario === 'canceled' ? 54 : 0)
                  : loginErrorBody();
        const candidate = replyWt(wt, body);
        body.fill(0);
        wt.shared.fill(0);
        wt.business.fill(0);
        bytes.fill(0);
        stream.emit('data', candidate);
    };

    try {
        await deadline(owner.fetch(fetchFields), 'baseline fetch');

        if (scenario === 'login-error') {
            expect(await deadline(owner.poll(), 'baseline confirmed')).toEqual({
                status: 'confirmed',
            });
            return await deadline(
                owner.loginAndRegister(loginFields).then(
                    (value) => ({ kind: 'result' as const, value }),
                    () => ({ kind: 'error' as const }),
                ),
                'baseline login error',
            );
        }

        return await deadline(
            owner.poll().then(
                (value) => ({ kind: 'result' as const, value }),
                () => ({ kind: 'error' as const }),
            ),
            'baseline terminal poll',
        );
    } finally {
        owner.close();
        lease.release();
        client.close();
        stream.finishClose();
        await deadline(client.whenClosed, 'baseline close');
    }
}

describe('WT reference invalid capability regression', () => {
    it('rejects an invalid token before touching the lease, signal or timers; the old factory still works', async () => {
        const closed = deferred<'released' | 'poisoned'>();
        let sequence = 50;
        const touched: PropertyKey[] = [];
        const lease: RawSessionLease = {
            whenClosed: closed.promise,
            release: () => closed.resolve('released'),
            poison: () => closed.resolve('poisoned'),
            close: () => closed.resolve('poisoned'),
            async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                const identity = { uin: '0', sequence: sequence++ };
                const built = await options.buildRequest(identity);
                const request = parseWt(built.frame);
                const body = fetchBody();
                const candidate = replyWt(request, body);
                body.fill(0);
                request.shared.fill(0);
                request.business.fill(0);

                if (!(await options.verifyCandidate(candidate, built.context, identity))) {
                    return { kind: 'failure', code: 'synthetic-rejection', writeState: 'unknown' };
                }

                return {
                    kind: 'response',
                    sequence: identity.sequence,
                    value: await options.consumeCandidate(candidate, built.context, identity),
                    writeState: 'written',
                };
            },
        };
        const tracked: RawSessionLease = {
            get whenClosed() {
                touched.push('whenClosed');
                return lease.whenClosed;
            },
            get release() {
                touched.push('release');
                return lease.release;
            },
            get poison() {
                touched.push('poison');
                return lease.poison;
            },
            get close() {
                touched.push('close');
                return lease.close;
            },
            get transactRaw() {
                touched.push('transactRaw');
                return lease.transactRaw;
            },
        };
        const abort = new AbortController();
        const options: Parameters<typeof createWtReferenceSession>[1] = {
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
            signal: abort.signal,
            getTimestamp: () => 10,
            buildWtReserved: () => new Uint8Array(),
            verifyRaw: () => true,
            verifyContext: ({ requestUin, responseUin }) => responseUin === requestUin,
            sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
            registration: {
                version: 'build-v',
                deviceName: 'name',
                deviceType: 'type',
                vendorOs: 'os',
                random: 4,
            },
            buildRegisterReserved: ({ sequence: value }) => Uint8Array.of(value),
            verifyRegisterRaw: () => true,
        };
        const revoked = createReferenceKeyCapability();
        revokeReferenceKey(revoked);
        const timer = vi.spyOn(globalThis, 'setTimeout');
        const subscribe = vi.spyOn(abort.signal, 'addEventListener');

        try {
            expect(() => createWtReferenceSessionWithCapability(tracked, options, {})).toThrow();
            expect(() =>
                createWtReferenceSessionWithCapability(tracked, options, revoked),
            ).toThrow();
            expect(touched).toEqual([]);
            expect(timer).not.toHaveBeenCalled();
            expect(subscribe).not.toHaveBeenCalled();
        } finally {
            timer.mockRestore();
            subscribe.mockRestore();
        }

        // Bind a real owner, then attempt a second construction with that exact token.
        const boundClosed = deferred<'released' | 'poisoned'>();
        const boundLease: RawSessionLease = {
            ...lease,
            whenClosed: boundClosed.promise,
            release: () => boundClosed.resolve('released'),
            poison: () => boundClosed.resolve('poisoned'),
            close: () => boundClosed.resolve('poisoned'),
        };
        const token = createReferenceKeyCapability();
        const owner = createWtReferenceSessionWithCapability(boundLease, options, token);
        touched.length = 0;
        const boundTimer = vi.spyOn(globalThis, 'setTimeout');
        const boundSubscribe = vi.spyOn(abort.signal, 'addEventListener');

        try {
            expect(() => createWtReferenceSessionWithCapability(tracked, options, token)).toThrow();
            expect(touched).toEqual([]);
            expect(boundTimer).not.toHaveBeenCalled();
            expect(boundSubscribe).not.toHaveBeenCalled();
        } finally {
            boundTimer.mockRestore();
            boundSubscribe.mockRestore();
        }

        try {
            expect((await deadline(owner.fetch(fetchFields), 'bound owner fetch')).qrUrl).toBe(
                'https://example.invalid/qr',
            );
        } finally {
            owner.close();
            boundLease.release();
        }

        const session = createWtReferenceSession(tracked, options);

        try {
            expect((await deadline(session.fetch(fetchFields), 'old factory fetch')).qrUrl).toBe(
                'https://example.invalid/qr',
            );
            expect(sequence).toBe(52);
        } finally {
            session.close();
            lease.release();
        }
    });
});

describe('WT multiplex reference with a synthetic EventEmitter peer', () => {
    it.each([
        { pushSequence: 'same', fragmented: false },
        { pushSequence: 'different', fragmented: false },
        { pushSequence: 'same', fragmented: true },
        { pushSequence: 'different', fragmented: true },
    ] as const)(
        'stages the D2 key before the coalesced following push: $pushSequence fragmented=$fragmented',
        async (variant) => {
            const f = setup({ ...variant, holdRegister: true, registrationPushes: true });

            try {
                await f.confirm();
                const work = f.session.loginAndRegister(loginFields);
                await deadline(f.registerEntered.promise, 'register verification entered');
                await turn();
                expect(f.observed).toEqual([]);
                expect(f.getVerifyPushCalls()).toBe(0);
                f.allowRegister.resolve();
                expect(await deadline(work, 'login and register')).toEqual({ status: 'success' });
                await waitFor(() => f.observed.length === 3, 'queued push release');
                const first = variant.pushSequence === 'same' ? 52 : 152;
                expect(f.observed).toEqual(
                    [first, 53, 54].map((sequence) => ({
                        uin: '123',
                        sequence,
                        command: pushCommand,
                    })),
                );
                expect(f.delivery).toEqual(
                    [first, 53, 54].flatMap((sequence) => [
                        `verify:${sequence}`,
                        `push:${sequence}`,
                    ]),
                );
                expect(f.failures).toEqual([]);
                expect(await deadline(f.session.alive(), 'alive')).toEqual({ status: 'success' });
                expect(await deadline(f.session.heartbeat(), 'heartbeat')).toEqual({
                    status: 'success',
                    interval: 270n,
                });
                expect(
                    f.requests.map(({ sequence, command, protocol }) => [
                        sequence,
                        command,
                        protocol,
                    ]),
                ).toEqual([
                    [50, 'fixture.qr', 12],
                    [51, 'fixture.qr', 12],
                    [52, 'fixture.login', 12],
                    [53, SSO_INFO_SYNC_COMMAND, 12],
                    [54, SSO_REFERENCE_ALIVE_COMMAND, 13],
                    [55, SSO_HEARTBEAT_COMMAND, 12],
                ]);
            } finally {
                await f.cleanup();
            }
        },
    );

    it('accepts the same ciphertext with its ticket key and rejects this sample with a different ticket key', async () => {
        const a = new Uint8Array(16).fill(0x31);
        const b = new Uint8Array(16).fill(0x72);
        let sample = push(52, '123', a);

        // Select an actual malformed wrong-key decoding; QQTEA itself has no MAC.
        for (let i = 0; i < 32; i++) {
            try {
                decodeServiceResponse(sample, b);
                sample = push(52, '123', a);
            } catch {
                break;
            }
        }

        expect(() => decodeServiceResponse(sample, b)).toThrow();
        const good = setup({ ticketD2: a, peerD2: a, suppliedPush: sample });
        const bad = setup({ ticketD2: b, peerD2: b, suppliedPush: sample });

        try {
            await Promise.all([good.confirm(), bad.confirm()]);
            const goodWork = good.session.loginAndRegister(loginFields);
            const badWork = bad.session.loginAndRegister(loginFields).then(
                (value) => ({ kind: 'result' as const, value }),
                () => ({ kind: 'error' as const }),
            );
            expect(await deadline(goodWork, 'matching ticket')).toEqual({ status: 'success' });
            await waitFor(() => good.observed.length === 1, 'matching push');
            const result = await deadline(badWork, 'wrong key failure');
            expect(result).not.toEqual({ kind: 'result', value: { status: 'success' } });
            expect(bad.observed).toEqual([]);
        } finally {
            await Promise.all([good.cleanup(), bad.cleanup()]);
        }
    });

    it.each(['wrong-ticket', 'missing-d2'] as const)(
        'does not register or dispatch with %s',
        async (ticketMode) => {
            const f = setup({ ticketMode });

            try {
                await f.confirm();
                const result = await deadline(
                    f.session.loginAndRegister(loginFields).then(
                        (value) => ({ kind: 'result' as const, value }),
                        () => ({ kind: 'error' as const }),
                    ),
                    'invalid ticket',
                );
                expect(result).not.toEqual({ kind: 'result', value: { status: 'success' } });
                expect(f.requests).toHaveLength(3);
                expect(f.observed).toEqual([]);
            } finally {
                await f.cleanup();
            }
        },
    );

    it('closes on a zero-key push following the confirmed poll before D2 staging', async () => {
        const f = setup({ pollEarlyPush: true });

        try {
            expect((await deadline(f.session.fetch(fetchFields), 'fetch')).qrUrl).toBe(
                'https://example.invalid/qr',
            );
            await deadline(
                f.session.poll().then(
                    () => undefined,
                    () => undefined,
                ),
                'poll outcome',
            );
            await deadline(f.session.whenClosed, 'early push closes');
            expect(f.getVerifyPushCalls()).toBe(0);
            expect(f.observed).toEqual([]);
        } finally {
            await f.cleanup();
        }
    });

    it.each(['login', 'registration'] as const)(
        'does not release a queued push after %s verification returns false',
        async (phase) => {
            const f = setup({
                verifyLogin: phase !== 'login',
                verifyRegister: phase !== 'registration',
            });

            try {
                await f.confirm();
                const result = await deadline(
                    f.session.loginAndRegister(loginFields).then(
                        (value) => ({ kind: 'result' as const, value }),
                        () => ({ kind: 'error' as const }),
                    ),
                    'verification failure',
                );
                expect(result).not.toEqual({ kind: 'result', value: { status: 'success' } });
                await deadline(f.session.whenClosed, 'verification failure closes');
                expect(f.getVerifyPushCalls()).toBe(0);
                expect(f.observed).toEqual([]);
            } finally {
                await f.cleanup();
            }
        },
    );

    it('accepts queued synthetic frames exactly at the preregistration byte limit', async () => {
        const key = new Uint8Array(16).fill(10);
        const bytes = [52, 53, 54].reduce(
            (sum, sequence) => sum + push(sequence, '123', key).length,
            0,
        );
        const f = setup({
            pushBytes: bytes,
            pushLimit: 8,
            holdRegister: true,
            registrationPushes: true,
        });

        try {
            await f.confirm();
            const work = f.session.loginAndRegister(loginFields);
            await deadline(f.registerEntered.promise, 'byte limit register gate');
            expect(f.getVerifyPushCalls()).toBe(0);
            expect(f.observed).toEqual([]);
            f.allowRegister.resolve();
            expect(await deadline(work, 'exact byte budget register')).toEqual({
                status: 'success',
            });
            await waitFor(() => f.observed.length === 3, 'exact byte budget release');
            expect(f.observed.map(({ sequence }) => sequence)).toEqual([52, 53, 54]);
        } finally {
            await f.cleanup();
        }
    });

    it('fails closed one byte below the preregistration byte budget without hitting the frame limit', async () => {
        const key = new Uint8Array(16).fill(10);
        const bytes = [52, 53, 54].reduce(
            (sum, sequence) => sum + push(sequence, '123', key).length,
            0,
        );
        const f = setup({ pushBytes: bytes - 1, pushLimit: 8, registrationPushes: true });

        try {
            await f.confirm();
            const result = await deadline(
                f.session.loginAndRegister(loginFields).then(
                    (value) => ({ kind: 'result' as const, value }),
                    () => ({ kind: 'error' as const }),
                ),
                'byte queue overflow',
            );
            expect(result).not.toEqual({ kind: 'result', value: { status: 'success' } });
            await deadline(f.session.whenClosed, 'byte queue overflow closes');
            expect(f.getVerifyPushCalls()).toBe(0);
            expect(f.observed).toEqual([]);
        } finally {
            await f.cleanup();
        }
    });

    it('fails closed when the preregistration push queue exceeds its frame budget', async () => {
        const f = setup({ pushLimit: 1, registrationPushes: true });

        try {
            await f.confirm();
            const result = await deadline(
                f.session.loginAndRegister(loginFields).then(
                    (value) => ({ kind: 'result' as const, value }),
                    () => ({ kind: 'error' as const }),
                ),
                'queue overflow',
            );
            expect(result).not.toEqual({ kind: 'result', value: { status: 'success' } });
            await deadline(f.session.whenClosed, 'queue overflow closes');
            expect(f.getVerifyPushCalls()).toBe(0);
            expect(f.observed).toEqual([]);
        } finally {
            await f.cleanup();
        }
    });

    it.each(['uin', 'command'] as const)(
        'rejects a registration response with wrong %s',
        async (wrongRegistration) => {
            const f = setup({ wrongRegistration });

            try {
                await f.confirm();
                const result = await deadline(
                    f.session.loginAndRegister(loginFields).then(
                        (value) => ({ kind: 'result' as const, value }),
                        () => ({ kind: 'error' as const }),
                    ),
                    'wrong registration context',
                );
                expect(result).not.toEqual({ kind: 'result', value: { status: 'success' } });
                await deadline(f.session.whenClosed, 'wrong registration context closes');
                expect(f.getVerifyPushCalls()).toBe(0);
                expect(f.observed).toEqual([]);
            } finally {
                await f.cleanup();
            }
        },
    );

    it('closes when push verification returns false without executing the listener', async () => {
        const f = setup({ verifyPush: false });

        try {
            await f.confirm();
            await deadline(
                f.session.loginAndRegister(loginFields).then(
                    () => undefined,
                    () => undefined,
                ),
                'login before push verification',
            );
            await deadline(f.session.whenClosed, 'push verification failure closes');
            expect(f.getVerifyPushCalls()).toBe(1);
            expect(f.observed).toEqual([]);
        } finally {
            await f.cleanup();
        }
    });

    it('rechecks the lease clock after a push verifier crosses the deadline', async () => {
        let now = performance.now();
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
        const f = setup({
            duringVerify: () => {
                now += 20000;
            },
        });

        try {
            await f.confirm();
            await deadline(
                f.session.loginAndRegister(loginFields).then(
                    () => undefined,
                    () => undefined,
                ),
                'deadline race login',
            );
            await deadline(f.session.whenClosed, 'deadline race closes');
            expect(f.getVerifyPushCalls()).toBe(1);
            expect(f.observed).toEqual([]);
        } finally {
            try {
                await f.cleanup();
            } finally {
                clock.mockRestore();
            }
        }
    });

    it.each([
        { code: 17, status: 'expired' },
        { code: 54, status: 'canceled' },
    ] as const)('preserves the poll business result $status', async ({ code, status }) => {
        const f = setup({ pollCode: code });

        try {
            expect((await deadline(f.session.fetch(fetchFields), 'fetch')).qrUrl).toBe(
                'https://example.invalid/qr',
            );
            const baseline = await oldOwnerTerminal(f.sessionOptions, status);
            const actual = await deadline(
                f.session.poll().then(
                    (value) => ({ kind: 'result' as const, value }),
                    () => ({ kind: 'error' as const }),
                ),
                'terminal poll',
            );
            expect(actual).toEqual(baseline);
            expect(f.getVerifyPushCalls()).toBe(0);
            expect(f.observed).toEqual([]);
        } finally {
            await f.cleanup();
        }
    });

    it('preserves a verified login business error instead of inventing tickets', async () => {
        const f = setup({ loginBusinessError: true });

        try {
            await f.confirm();
            const baseline = await oldOwnerTerminal(f.sessionOptions, 'login-error');
            const actual = await deadline(
                f.session.loginAndRegister(loginFields).then(
                    (value) => ({ kind: 'result' as const, value }),
                    () => ({ kind: 'error' as const }),
                ),
                'login business error',
            );
            expect(actual).toEqual(baseline);
            expect(f.requests).toHaveLength(3);
            expect(f.getVerifyPushCalls()).toBe(0);
            expect(f.observed).toEqual([]);
        } finally {
            await f.cleanup();
        }
    });

    it.each(['alive', 'heartbeat'] as const)(
        'preserves a %s SSO business error',
        async (operation) => {
            const f = setup({ skipLoginPush: true, postSsoError: true });

            try {
                await f.confirm();
                expect(await deadline(f.session.loginAndRegister(loginFields), 'register')).toEqual(
                    { status: 'success' },
                );
                expect(await deadline(f.session[operation](), operation)).toEqual({
                    status: 'sso-error',
                    retCode: 42,
                });
                expect(f.getVerifyPushCalls()).toBe(0);
                expect(f.observed).toEqual([]);
            } finally {
                await f.cleanup();
            }
        },
    );

    it('snapshots the original signal and ignores a replacement already aborted signal', async () => {
        const original = new AbortController();
        const replacement = new AbortController();
        replacement.abort();
        const f = setup({ signal: original.signal });

        try {
            f.sessionOptions.signal = replacement.signal;
            await f.confirm();
            expect(
                await deadline(f.session.loginAndRegister(loginFields), 'original signal login'),
            ).toEqual({ status: 'success' });
            await waitFor(() => f.observed.length === 1, 'original signal push');
            original.abort();
            await deadline(f.session.whenClosed, 'original signal abort');
            const count = f.observed.length;
            f.stream.emit('data', push(200, '123', new Uint8Array(16).fill(10)));
            await turn();
            expect(f.observed).toHaveLength(count);
        } finally {
            await f.cleanup();
        }
    });

    it.each(['close', 'abort', 'deadline'] as const)(
        'does not return registration success when %s wins inside the verifier',
        async (mode) => {
            const abort = new AbortController();
            let now = performance.now();
            const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
            let f!: ReturnType<typeof setup>;
            let entered = 0;
            f = setup({
                signal: abort.signal,
                duringRegisterVerify: () => {
                    entered++;

                    if (mode === 'close') {
                        f.session.close();
                    } else if (mode === 'abort') {
                        abort.abort();
                    } else {
                        now += 20000;
                    }
                },
            });

            try {
                await f.confirm();
                const outcome = await deadline(
                    f.session.loginAndRegister(loginFields).then(
                        (value) => ({ kind: 'result' as const, value }),
                        () => ({ kind: 'error' as const }),
                    ),
                    'registration verifier race',
                );
                expect(entered).toBe(1);
                expect(outcome).not.toEqual({ kind: 'result', value: { status: 'success' } });
                expect(f.getVerifyPushCalls()).toBe(0);
                expect(f.observed).toEqual([]);
            } finally {
                try {
                    await f.cleanup();
                } finally {
                    clock.mockRestore();
                }
            }
        },
    );

    it('discards queued pushes after registration rejection', async () => {
        const f = setup({ registerResult: 'rejected', holdRegister: true });

        try {
            await f.confirm();
            const work = f.session.loginAndRegister(loginFields);
            await deadline(f.registerEntered.promise, 'rejected register entered');
            expect(f.observed).toEqual([]);
            f.allowRegister.resolve();
            expect(await deadline(work, 'register rejected')).toEqual({ status: 'rejected' });
            await turn();
            expect(f.observed).toEqual([]);
        } finally {
            await f.cleanup();
        }
    });

    it.each(['close', 'abort'] as const)(
        'fences pending registration and queued push after %s',
        async (mode) => {
            const abort = new AbortController();
            const f = setup({ holdRegister: true, signal: abort.signal });

            try {
                await f.confirm();
                const work = f.session.loginAndRegister(loginFields).then(
                    (value) => ({ kind: 'result' as const, value }),
                    () => ({ kind: 'error' as const }),
                );
                await deadline(f.registerEntered.promise, 'register gate');
                expect(f.observed).toEqual([]);

                if (mode === 'abort') {
                    abort.abort();
                } else {
                    f.session.close();
                }

                f.allowRegister.resolve();
                expect(await deadline(work, 'cancelled login')).not.toEqual({
                    kind: 'result',
                    value: { status: 'success' },
                });
                await turn();
                expect(f.observed).toEqual([]);
            } finally {
                await f.cleanup();
            }
        },
    );

    it('keeps two accounts with different synthetic D2 keys independent', async () => {
        const a = setup({
            account: '123',
            ticketD2: new Uint8Array(16).fill(0x21),
            holdRegister: true,
        });
        const b = setup({
            account: '456',
            ticketD2: new Uint8Array(16).fill(0x43),
            holdRegister: true,
        });

        try {
            await Promise.all([a.confirm(), b.confirm()]);
            const workA = a.session.loginAndRegister(loginFields);
            const workB = b.session.loginAndRegister(loginFields);
            await deadline(
                Promise.all([a.registerEntered.promise, b.registerEntered.promise]),
                'both register gates',
            );
            expect(a.observed).toEqual([]);
            expect(b.observed).toEqual([]);
            a.allowRegister.resolve();
            expect(await deadline(workA, 'account A')).toEqual({ status: 'success' });
            await waitFor(() => a.observed.length === 1, 'account A push');
            expect(b.observed).toEqual([]);
            b.allowRegister.resolve();
            expect(await deadline(workB, 'account B')).toEqual({ status: 'success' });
            await waitFor(() => b.observed.length === 1, 'account B push');
            expect(a.observed[0].uin).toBe('123');
            expect(b.observed[0].uin).toBe('456');
        } finally {
            await Promise.all([a.cleanup(), b.cleanup()]);
        }
    });
});
