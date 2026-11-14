import { EventEmitter } from 'node:events';
import { deflateSync } from 'node:zlib';
import type { DirectThirdPartyLoginResponse } from '@snowluma/proto-defs/direct-login';
import type { PushMsg } from '@snowluma/proto-defs/message';
import type { SsoHeartbeatResponse, SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { decodeServiceResponse } from '../../src/direct/service-frame';
import { SSO_HEARTBEAT_COMMAND, SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import { createWtMultiplexReference } from '../../src/direct/wt-multiplex-reference';
import {
    bindReferenceKeyAttempt,
    commitReferenceKey,
    createReferenceKeyCapability,
    decodeReferencePushBody,
    reserveReferenceKeyCapability,
    revokeReferenceKey,
    stageReferenceConfirmed,
    stageReferenceKey,
} from '../../src/direct/wt-reference-session-private';
import type { createWtReferenceSession } from '../../src/direct/wt-reference-session';
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
    dataFlag = 0,
) {
    const inner = Buffer.concat([
        field(
            Buffer.concat([
                word(sequence),
                word(retCode),
                field(Buffer.alloc(0)),
                field(Buffer.from(command)),
                field(Buffer.alloc(0)),
                word(dataFlag),
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

function pushBody(sequence: number, account: string) {
    return protobuf_encode<PushMsg>({
        message: {
            responseHead: { fromUin: 456, fromUid: 'synthetic-sender', toUin: Number(account) },
            contentHead: { msgType: 166, sequence },
            body: { msgContent: Uint8Array.of(1, 2, 3) },
        },
    });
}

function push(sequence: number, account: string, key: Uint8Array) {
    return response(sequence, pushCommand, pushBody(sequence, account), account, key);
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
    bodyHandler?: (
        body: Uint8Array,
        meta: { uin: string; sequence: number; command: string; retCode: number },
    ) => void | Promise<void>;
    bodyLimit?: number;
    omitBodyLimit?: boolean;
    verifyHook?: () => boolean | Promise<boolean>;
    rawHook?: (frame: Uint8Array) => void | Promise<void>;
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
            return settings.verifyHook ? settings.verifyHook() : settings.verifyPush !== false;
        },
        ...(settings.bodyHandler ? { onPushBody: settings.bodyHandler } : {}),
        ...(!settings.omitBodyLimit && (settings.bodyLimit !== undefined || settings.bodyHandler)
            ? { maxPushBodyBytes: settings.bodyLimit ?? 65536 }
            : {}),
        onPush: (frame, meta) => {
            delivery.push(`push:${meta.sequence}`);
            observed.push({ ...meta });
            return settings.rawHook?.(frame);
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

describe('WT multiplex body delivery through synthetic peers', () => {
    it('rejects body decoding when a deep-import expected.sequence getter revokes the capability', () => {
        const token = createReferenceKeyCapability();
        const attempt = {};
        const reservation = reserveReferenceKeyCapability(token);
        const key = new Uint8Array(16).fill(10);
        bindReferenceKeyAttempt(token, attempt, reservation);
        stageReferenceConfirmed(token, attempt, '0', '123', 51);
        stageReferenceKey(token, attempt, '0', '123', 52, key);
        commitReferenceKey(token);
        let reads = 0;
        const expected = {
            uin: '123',
            command: pushCommand,
            get sequence() {
                reads++;
                revokeReferenceKey(token);
                return 52;
            },
        };

        try {
            expect(() =>
                decodeReferencePushBody(token, push(52, '123', key), '0', expected, 65536),
            ).toThrow();
            expect(reads).toBe(1);
        } finally {
            revokeReferenceKey(token);
            key.fill(0);
        }
    });

    it('queues the coalesced ticket-key push until registration, then delivers the original protobuf bytes', async () => {
        const received: Array<{ body: Uint8Array; meta: unknown }> = [];
        const order: string[] = [];
        let borrowed: Uint8Array | undefined;
        const f = setup({
            holdRegister: true,
            rawHook: (frame) => {
                order.push('raw');
                frame.fill(0);
            },
            bodyHandler: (body, meta) => {
                order.push('body');
                borrowed = body;
                received.push({ body: Uint8Array.from(body), meta: { ...meta } });
            },
        });

        try {
            await f.confirm();
            const work = f.session.loginAndRegister(loginFields);
            await deadline(f.registerEntered.promise, 'registration gate');
            expect(f.observed).toEqual([]);
            expect(received).toEqual([]);
            expect(f.getVerifyPushCalls()).toBe(0);
            f.allowRegister.resolve();
            expect(await deadline(work, 'registration')).toEqual({ status: 'success' });
            await waitFor(() => received.length === 1, 'body delivery');
            expect(received).toEqual([
                {
                    body: pushBody(52, '123'),
                    meta: { uin: '123', sequence: 52, command: pushCommand, retCode: 0 },
                },
            ]);
            expect(order).toEqual(['raw', 'body']);
            await turn();
            expect(borrowed?.every((byte) => byte === 0)).toBe(true);
            expect(f.delivery).toEqual(['verify:52', 'push:52']);
            expect(f.failures).toEqual([]);
        } finally {
            await f.cleanup();
        }
    });

    it('wipes borrowed raw and body buffers even if a callback shadows their fill methods', async () => {
        let rawRef: Uint8Array | undefined;
        let bodyRef: Uint8Array | undefined;
        const delivered = deferred<void>();
        const f = setup({
            rawHook: (frame) => {
                rawRef = frame;
                Object.defineProperty(frame, 'fill', {
                    value: () => {
                        throw new Error('shadowed raw fill');
                    },
                });
            },
            bodyHandler: (body) => {
                bodyRef = body;
                Object.defineProperty(body, 'fill', { value: () => body });
                delivered.resolve();
            },
        });

        try {
            await f.confirm();
            expect(await deadline(f.session.loginAndRegister(loginFields), 'register')).toEqual({
                status: 'success',
            });
            await deadline(delivered.promise, 'body delivered');
            await turn();
            expect(rawRef?.some((value) => value !== 0)).toBe(false);
            expect(bodyRef?.some((value) => value !== 0)).toBe(false);
        } finally {
            await f.cleanup();
        }
    });

    it('preserves raw-only callbacks and forwards nonzero SSO retCode unchanged', async () => {
        const raw = setup();
        const bodies: Array<{ bytes: Uint8Array; retCode: number }> = [];
        const body = setup({
            skipLoginPush: true,
            bodyHandler: (value, meta) => {
                bodies.push({ bytes: Uint8Array.from(value), retCode: meta.retCode });
            },
        });

        try {
            await Promise.all([raw.confirm(), body.confirm()]);
            expect(
                await deadline(raw.session.loginAndRegister(loginFields), 'raw register'),
            ).toEqual({ status: 'success' });
            expect(
                await deadline(body.session.loginAndRegister(loginFields), 'body register'),
            ).toEqual({ status: 'success' });
            await waitFor(() => raw.observed.length === 1, 'raw push');
            const expected = pushBody(200, '123');
            body.stream.emit(
                'data',
                response(200, pushCommand, expected, '123', new Uint8Array(16).fill(10), 42),
            );
            await waitFor(() => bodies.length === 1, 'nonzero retCode');
            expect(bodies).toEqual([{ bytes: expected, retCode: 42 }]);
            expect(raw.observed).toEqual([{ uin: '123', sequence: 52, command: pushCommand }]);
        } finally {
            await Promise.all([raw.cleanup(), body.cleanup()]);
        }
    });

    it.each(['wrong-key', 'wrong-uin', 'wrong-command', 'corrupt'] as const)(
        'fails closed on %s without body delivery',
        async (mode) => {
            const key = new Uint8Array(16).fill(10);
            const other = new Uint8Array(16).fill(0x72);
            let ciphertext = push(201, '123', other);

            if (mode === 'wrong-key') {
                for (let i = 0; i < 32; i++) {
                    try {
                        decodeServiceResponse(ciphertext, key);
                        ciphertext = push(201, '123', other);
                    } catch {
                        break;
                    }
                }

                expect(() => decodeServiceResponse(ciphertext, key)).toThrow();
            } else if (mode === 'wrong-uin') {
                ciphertext = push(201, '456', key);
            } else if (mode === 'wrong-command') {
                ciphertext = response(201, 'synthetic.unknown', pushBody(201, '123'), '123', key);
            } else {
                // Valid outer envelope and encryption, malformed inner SSO payload.
                const malformed = response(201, pushCommand, pushBody(201, '123'), '123', key);
                const start = 10 + malformed.readUInt32BE(10);
                malformed.fill(0, start);
                ciphertext = malformed;
            }

            const delivered: Uint8Array[] = [];
            const f = setup({
                skipLoginPush: true,
                bodyHandler: (value) => {
                    delivered.push(Uint8Array.from(value));
                },
            });

            try {
                await f.confirm();
                expect(await deadline(f.session.loginAndRegister(loginFields), 'register')).toEqual(
                    { status: 'success' },
                );
                f.stream.emit('data', ciphertext);
                await deadline(f.session.whenClosed, `${mode} closes`);
                await turn();
                expect(delivered).toEqual([]);
            } finally {
                await f.cleanup();
            }
        },
    );

    it.each(['false', 'throw'] as const)(
        'withholds body when the external raw verifier %s',
        async (mode) => {
            const bodies: Uint8Array[] = [];
            const f = setup({
                skipLoginPush: true,
                verifyHook: () => {
                    if (mode === 'throw') {
                        throw new Error('synthetic verifier failure');
                    }

                    return false;
                },
                bodyHandler: (value) => {
                    bodies.push(Uint8Array.from(value));
                },
            });

            try {
                await f.confirm();
                expect(await deadline(f.session.loginAndRegister(loginFields), 'register')).toEqual(
                    { status: 'success' },
                );
                f.stream.emit('data', push(202, '123', new Uint8Array(16).fill(10)));
                await deadline(f.session.whenClosed, 'verifier closes');
                expect(f.getVerifyPushCalls()).toBe(1);
                expect(f.observed).toEqual([]);
                expect(bodies).toEqual([]);
            } finally {
                await f.cleanup();
            }
        },
    );

    it.each(['close', 'abort'] as const)(
        'fences a late accepted verifier after %s',
        async (mode) => {
            const abort = new AbortController();
            const entered = deferred<void>();
            const release = deferred<boolean>();
            const bodies: Uint8Array[] = [];
            const f = setup({
                signal: abort.signal,
                skipLoginPush: true,
                verifyHook: () => {
                    entered.resolve();
                    return release.promise;
                },
                bodyHandler: (body) => {
                    bodies.push(Uint8Array.from(body));
                },
            });

            try {
                await f.confirm();
                expect(await deadline(f.session.loginAndRegister(loginFields), 'register')).toEqual(
                    { status: 'success' },
                );
                f.stream.emit('data', push(203, '123', new Uint8Array(16).fill(10)));
                await deadline(entered.promise, 'verifier entered');

                if (mode === 'close') {
                    f.session.close();
                } else {
                    abort.abort();
                }

                release.resolve(true);
                await deadline(f.session.whenClosed, 'verifier race closes');
                await turn();
                expect(f.observed).toEqual([]);
                expect(bodies).toEqual([]);
            } finally {
                release.resolve(true);
                await f.cleanup();
            }
        },
    );

    it.each(['close', 'abort'] as const)(
        'wipes a borrowed body and fences later pushes when %s occurs during handler await',
        async (mode) => {
            const abort = new AbortController();
            const entered = deferred<void>();
            const release = deferred<void>();
            const handled: number[] = [];
            let borrowed: Uint8Array | undefined;
            let saved: Uint8Array | undefined;
            const f = setup({
                signal: abort.signal,
                skipLoginPush: true,
                bodyHandler: async (body, meta) => {
                    borrowed = body;
                    saved = Uint8Array.from(body);
                    handled.push(meta.sequence);
                    entered.resolve();
                    await release.promise;
                },
            });

            try {
                await f.confirm();
                expect(await deadline(f.session.loginAndRegister(loginFields), 'register')).toEqual(
                    { status: 'success' },
                );
                const key = new Uint8Array(16).fill(10);
                f.stream.emit(
                    'data',
                    Buffer.concat([push(204, '123', key), push(205, '123', key)]),
                );
                await deadline(entered.promise, 'handler entered');
                expect(saved).toEqual(pushBody(204, '123'));

                if (mode === 'close') {
                    f.session.close();
                } else {
                    abort.abort();
                }

                await deadline(f.session.whenClosed, 'handler race closes');
                expect(borrowed?.every((byte) => byte === 0)).toBe(true);
                release.resolve();
                await turn();
                expect(handled).toEqual([204]);
                expect(borrowed?.every((byte) => byte === 0)).toBe(true);
            } finally {
                release.resolve();
                await f.cleanup();
            }
        },
    );

    it('keeps pushes FIFO across the pending registration response with an equal sequence', async () => {
        const seen: number[] = [];
        const f = setup({
            holdRegister: true,
            registrationPushes: true,
            bodyHandler: (body, meta) => {
                expect(Uint8Array.from(body)).toEqual(pushBody(meta.sequence, '123'));
                seen.push(meta.sequence);
            },
        });

        try {
            await f.confirm();
            const work = f.session.loginAndRegister(loginFields);
            await deadline(f.registerEntered.promise, 'registration response verification');
            expect(seen).toEqual([]);
            f.allowRegister.resolve();
            expect(await deadline(work, 'registration response')).toEqual({ status: 'success' });
            await waitFor(() => seen.length === 3, 'queued bodies across pending response');
            expect(seen).toEqual([52, 53, 54]);
        } finally {
            await f.cleanup();
        }
    });

    it('keeps pushes FIFO and rejects concurrent heartbeat as busy without poisoning', async () => {
        const entered = deferred<void>();
        const release = deferred<void>();
        const seen: number[] = [];
        const f = setup({
            skipLoginPush: true,
            bodyHandler: async (body, meta) => {
                expect(Uint8Array.from(body)).toEqual(pushBody(meta.sequence, '123'));
                seen.push(meta.sequence);

                if (meta.sequence === 210) {
                    entered.resolve();
                    await release.promise;
                }
            },
        });

        try {
            await f.confirm();
            expect(await deadline(f.session.loginAndRegister(loginFields), 'register')).toEqual({
                status: 'success',
            });
            const key = new Uint8Array(16).fill(10);
            f.stream.emit('data', push(210, '123', key));
            await deadline(entered.promise, 'first body entered');
            f.stream.emit('data', Buffer.concat([push(211, '123', key), push(212, '123', key)]));
            await expect(f.session.heartbeat()).rejects.toThrow(/busy or stopped/);
            expect(seen).toEqual([210]);
            release.resolve();
            await waitFor(() => seen.length === 3, 'FIFO delivery');
            expect(seen).toEqual([210, 211, 212]);
            expect(await deadline(f.session.heartbeat(), 'heartbeat after delivery')).toEqual({
                status: 'success',
                interval: 270n,
            });
        } finally {
            release.resolve();
            await f.cleanup();
        }
    });

    it.each(['throw', 'reject'] as const)(
        'closes without delivering later bodies on handler %s',
        async (mode) => {
            const seen: number[] = [];
            let borrowed: Uint8Array | undefined;
            const f = setup({
                skipLoginPush: true,
                bodyHandler: (body, meta) => {
                    borrowed = body;
                    seen.push(meta.sequence);

                    if (mode === 'throw') {
                        throw new Error('synthetic handler failure');
                    }

                    return Promise.reject(new Error('synthetic handler rejection'));
                },
            });

            try {
                await f.confirm();
                expect(await deadline(f.session.loginAndRegister(loginFields), 'register')).toEqual(
                    { status: 'success' },
                );
                const key = new Uint8Array(16).fill(10);
                f.stream.emit(
                    'data',
                    Buffer.concat([push(220, '123', key), push(221, '123', key)]),
                );
                await deadline(f.session.whenClosed, 'handler failure closes');
                await turn();
                expect(seen).toEqual([220]);
                expect(borrowed?.every((byte) => byte === 0)).toBe(true);
            } finally {
                await f.cleanup();
            }
        },
    );

    it('isolates account keys and body byte copies', async () => {
        const bodiesA: Uint8Array[] = [];
        const bodiesB: Uint8Array[] = [];
        const a = setup({
            account: '123',
            ticketD2: new Uint8Array(16).fill(0x21),
            holdRegister: true,
            bodyHandler: (value) => {
                bodiesA.push(Uint8Array.from(value));
                value.fill(0);
            },
        });
        const b = setup({
            account: '456',
            ticketD2: new Uint8Array(16).fill(0x43),
            holdRegister: true,
            bodyHandler: (value) => {
                bodiesB.push(Uint8Array.from(value));
            },
        });

        try {
            await Promise.all([a.confirm(), b.confirm()]);
            const workA = a.session.loginAndRegister(loginFields);
            const workB = b.session.loginAndRegister(loginFields);
            await deadline(
                Promise.all([a.registerEntered.promise, b.registerEntered.promise]),
                'both registration gates',
            );
            a.allowRegister.resolve();
            expect(await deadline(workA, 'account A register')).toEqual({ status: 'success' });
            await waitFor(() => bodiesA.length === 1, 'account A delivery');
            expect(bodiesB).toEqual([]);
            b.allowRegister.resolve();
            expect(await deadline(workB, 'account B register')).toEqual({ status: 'success' });
            await waitFor(() => bodiesB.length === 1, 'account B delivery');
            expect(bodiesA).toEqual([pushBody(52, '123')]);
            expect(bodiesB).toEqual([pushBody(52, '456')]);
            a.stream.emit('data', push(230, '456', new Uint8Array(16).fill(0x43)));
            await deadline(a.session.whenClosed, 'cross-account closes');
            expect(bodiesA).toHaveLength(1);
            b.stream.emit('data', push(231, '456', new Uint8Array(16).fill(0x43)));
            await waitFor(() => bodiesB.length === 2, 'account B remains usable');
            expect(bodiesB[1]).toEqual(pushBody(231, '456'));
        } finally {
            await Promise.all([a.cleanup(), b.cleanup()]);
        }
    });

    it.each([0, -1, 1.5, NaN, Infinity, 16 * 1024 * 1024 + 1])(
        'rejects invalid body limit %s even without a body callback',
        (limit) => {
            expect(() => setup({ bodyLimit: limit })).toThrow();
        },
    );

    it('requires a limit when body delivery is enabled', () => {
        expect(() => setup({ omitBodyLimit: true, bodyHandler: () => {} })).toThrow();
    });

    it('accepts a compressed body at the 16 MiB decoded limit', async () => {
        const bytes = Buffer.alloc(16 * 1024 * 1024);
        bytes[0] = 0x35;
        bytes[bytes.length - 1] = 0x79;
        const compressed = deflateSync(bytes);
        let actual: { length: number; first: number; last: number } | undefined;
        const f = setup({
            skipLoginPush: true,
            bodyLimit: 16 * 1024 * 1024,
            bodyHandler: (body) => {
                actual = { length: body.length, first: body[0], last: body[body.length - 1] };
            },
        });

        try {
            await f.confirm();
            expect(await deadline(f.session.loginAndRegister(loginFields), 'register')).toEqual({
                status: 'success',
            });
            f.stream.emit(
                'data',
                response(239, pushCommand, compressed, '123', new Uint8Array(16).fill(10), 0, 1),
            );
            await waitFor(() => actual !== undefined, 'maximum decoded body');
            expect(actual).toEqual({ length: bytes.length, first: 0x35, last: 0x79 });
        } finally {
            await f.cleanup();
        }
    });

    it.each(['exact', 'one-less'] as const)(
        'enforces the decoded body size boundary: %s',
        async (mode) => {
            const expected = pushBody(240, '123');
            const seen: Uint8Array[] = [];
            const f = setup({
                skipLoginPush: true,
                bodyLimit: expected.length - (mode === 'one-less' ? 1 : 0),
                bodyHandler: (value) => {
                    seen.push(Uint8Array.from(value));
                },
            });

            try {
                await f.confirm();
                expect(await deadline(f.session.loginAndRegister(loginFields), 'register')).toEqual(
                    { status: 'success' },
                );
                f.stream.emit(
                    'data',
                    response(240, pushCommand, expected, '123', new Uint8Array(16).fill(10)),
                );

                if (mode === 'exact') {
                    await waitFor(() => seen.length === 1, 'exact boundary delivery');
                    expect(seen).toEqual([expected]);
                } else {
                    await deadline(f.session.whenClosed, 'oversized body closes');
                    expect(seen).toEqual([]);
                }
            } finally {
                await f.cleanup();
            }
        },
    );
});
