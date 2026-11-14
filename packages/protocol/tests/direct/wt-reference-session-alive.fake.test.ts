import type { DirectThirdPartyLoginResponse } from '@snowluma/proto-defs/direct-login';
import type { SsoHeartbeatResponse, SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import {
    createSsoHeartbeatScheduler,
    type SsoHeartbeatSchedulerEvent,
    type SsoHeartbeatSchedulerTimer,
} from '../../src/direct/sso-heartbeat-scheduler';
import { SSO_REFERENCE_ALIVE_COMMAND } from '../../src/direct/sso-reference-alive-flow';
import {
    SSO_HEARTBEAT_COMMAND,
    SSO_INFO_SYNC_COMMAND,
    encodeSsoHeartbeatReference,
} from '../../src/direct/sso-register';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
} from '../../src/direct/sso12-packet-client';
import { encodeWtTlv } from '../../src/direct/wt-tlv';
import { createWtReferenceSession } from '../../src/direct/wt-reference-session';
import * as wtModule from '../../src/direct/wt-reference-login-attempt';
import { fetchBody, parseWt, peer, pollBody, replyWt } from './fixtures/wt-sso-synthetic';

// All bytes and identities are synthetic. The broker, WT and SSO codecs are real;
// this peer says nothing about a live service, a signature, or online state.
const key = new Uint8Array(16).fill(10);

const word = (n: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(n >>> 0);
    return bytes;
};

const field = (bytes: Uint8Array) => Buffer.concat([word(bytes.length + 4), bytes]);
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function loginBody(uid: string) {
    const projection = protobuf_encode<DirectThirdPartyLoginResponse>({
        commonInfo: { rspNT: { uid } },
    });
    const inner = encodeWtTlv([
        { tag: 0x143, value: Uint8Array.of(9) },
        { tag: 0x305, value: key },
        { tag: 0x10a, value: Uint8Array.of(11) },
        { tag: 0x106, value: Uint8Array.of(12) },
        { tag: 0x543, value: projection },
    ]);
    const body = Buffer.concat([
        Buffer.of(0, 9, 0),
        encodeWtTlv([{ tag: 0x119, value: qqTeaEncrypt(inner, new Uint8Array(16).fill(4)) }]),
    ]);
    inner.fill(0);
    projection.fill(0);
    return body;
}

function replySso(
    sequence: number,
    command: string,
    body: Uint8Array,
    retCode = 0,
    account = '123',
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
    const cipher = qqTeaEncrypt(inner, key);
    inner.fill(0);
    return Buffer.concat([
        word(14 + Buffer.byteLength(account) + cipher.length),
        word(12),
        Buffer.of(1, 0),
        field(Buffer.from(account)),
        cipher,
    ]);
}

function replyAlive(
    sequence: number,
    account: string,
    retCode = 0,
    command = SSO_REFERENCE_ALIVE_COMMAND,
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
        field(Buffer.alloc(0)),
    ]);
    return Buffer.concat([
        word(14 + Buffer.byteLength(account) + inner.length),
        word(13),
        Buffer.of(0, 0),
        field(Buffer.from(account)),
        inner,
    ]);
}

// Adapt the synthetic WT peer response to a second confirmed UIN without changing its fixture.
function replyWtForAccount(wt: ReturnType<typeof parseWt>, body: Uint8Array, account: string) {
    const response = replyWt(wt, body);

    if (wt.kind !== 0x810 || account === '123') {
        return response;
    }

    const oldEnd = 10 + response.readUInt32BE(10);
    const sso = Buffer.from(qqTeaDecrypt(response.subarray(oldEnd), new Uint8Array(16)));
    const headerEnd = sso.readUInt32BE(0);
    const packet = Buffer.from(sso.subarray(headerEnd + 4));
    packet.writeUInt32BE(Number(account), 9);
    const rebuilt = Buffer.concat([sso.subarray(0, headerEnd), field(packet)]);
    const cipher = qqTeaEncrypt(rebuilt, new Uint8Array(16));
    sso.fill(0);
    packet.fill(0);
    rebuilt.fill(0);
    return Buffer.concat([
        word(14 + Buffer.byteLength(account) + cipher.length),
        word(12),
        Buffer.of(2, 0),
        field(Buffer.from(account)),
        cipher,
    ]);
}

type Request = {
    sequence: number;
    account: string;
    command: string;
    body?: Uint8Array;
    reserved?: Uint8Array;
    point?: string;
    protocol?: number;
    encryption?: number;
};
type FailureMode =
    | 'none'
    | 'sso-error'
    | 'missing-interval'
    | 'zero-interval'
    | 'wrong-wire'
    | 'wrong-wire-after-unknowns'
    | 'wrong-sequence'
    | 'wrong-result-sequence'
    | 'verify-false'
    | 'read-expired';

class MemoryClient implements Sso12RawClient {
    readonly closed = deferred<Sso12CloseReason>();
    readonly whenClosed = this.closed.promise;
    readonly close = vi.fn(() => this.closed.resolve({ kind: 'local', code: 'fixture' }));
    readonly started = deferred<void>();
    readonly late = deferred<void>();
    readonly requests: Request[] = [];
    sequence = 50;
    calls = 0;
    uid = 'uid-from-inner-543';
    account = '123';
    mode: FailureMode = 'none';
    stall = false;
    external = false;

    async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        const call = ++this.calls;
        const sequence = this.sequence++;
        const identity = { uin: '0', sequence };

        try {
            const built = await options.buildRequest(identity);

            if (this.external) {
                this.started.resolve();
                await this.late.promise;
                const candidate = Uint8Array.of(3, 4);

                if (!(await options.verifyCandidate(candidate, built.context, identity))) {
                    return { kind: 'failure', code: 'external-rejected', writeState: 'unknown' };
                }

                return {
                    kind: 'response',
                    sequence,
                    value: await options.consumeCandidate(candidate, built.context, identity),
                    writeState: 'written',
                };
            }

            let candidate: Uint8Array;

            if (call <= 3) {
                const wt = parseWt(built.frame);

                try {
                    this.requests.push({
                        sequence: wt.seq,
                        account: wt.account,
                        command: wt.command,
                        point: wt.point.toString('hex'),
                    });
                    const body =
                        wt.kind === 0x31
                            ? fetchBody()
                            : wt.kind === 0x12
                              ? pollBody(0, BigInt(this.account))
                              : loginBody(this.uid);
                    candidate = replyWtForAccount(wt, body, this.account);
                    body.fill(0);
                } finally {
                    wt.shared.fill(0);
                    wt.business.fill(0);
                }
            } else {
                const frame = Buffer.from(built.frame);
                const protocol = frame.readUInt32BE(4);
                const encryption = frame[8];
                const accountStart = protocol === 13 ? 14 : 9 + frame.readUInt32BE(9) + 1;
                const accountEnd = accountStart + frame.readUInt32BE(accountStart);
                const inner =
                    protocol === 13
                        ? Buffer.from(frame.subarray(accountEnd))
                        : Buffer.from(qqTeaDecrypt(frame.subarray(accountEnd), key));
                const headerEnd = inner.readUInt32BE(0);
                let position = protocol === 13 ? 4 : 28;

                const readField = () => {
                    const end = position + inner.readUInt32BE(position);
                    const result = Uint8Array.from(inner.subarray(position + 4, end));
                    position = end;
                    return result;
                };

                if (protocol === 12) {
                    readField();
                }

                const command = Buffer.from(readField()).toString();
                readField();

                if (protocol === 12) {
                    readField();
                    readField();
                    position += inner.readUInt16BE(position);
                }

                const reserved = readField();
                const bodyLength = inner.readUInt32BE(headerEnd);
                const body = Uint8Array.from(inner.subarray(headerEnd + 4, headerEnd + bodyLength));
                this.requests.push({
                    sequence: protocol === 13 ? frame.readUInt32BE(9) : inner.readUInt32BE(4),
                    account: frame.subarray(accountStart + 4, accountEnd).toString(),
                    command,
                    body,
                    reserved,
                    protocol,
                    encryption,
                });
                const responseBody =
                    command === SSO_INFO_SYNC_COMMAND
                        ? protobuf_encode<SsoRegisterResponse>({
                              register: { message: 'register success' },
                          })
                        : this.mode === 'zero-interval'
                          ? Uint8Array.of(0x18, 0)
                          : this.mode === 'wrong-wire'
                            ? Uint8Array.of(0x1a, 0)
                            : this.mode === 'wrong-wire-after-unknowns'
                              ? Buffer.concat([
                                    ...Array.from({ length: 65 }, () => Buffer.from([0x48, 1])),
                                    Buffer.from([0x1a, 0]),
                                ])
                              : protobuf_encode<SsoHeartbeatResponse>(
                                    this.mode === 'missing-interval' ? {} : { interval: 270n },
                                );
                const responseSequence =
                    sequence + (call > 4 && this.mode === 'wrong-sequence' ? 1 : 0);
                const retCode = call > 4 && this.mode === 'sso-error' ? 42 : 0;
                candidate =
                    protocol === 13
                        ? replyAlive(responseSequence, this.account, retCode)
                        : replySso(responseSequence, command, responseBody, retCode, this.account);
                inner.fill(0);
                responseBody.fill(0);
            }

            if (call > 4 && (this.stall || this.mode === 'read-expired')) {
                this.started.resolve();
                await this.late.promise;
            }

            if (!(await options.verifyCandidate(candidate, built.context, identity))) {
                return { kind: 'failure', code: 'synthetic-rejection', writeState: 'unknown' };
            }

            const value = await options.consumeCandidate(candidate, built.context, identity);
            return {
                kind: 'response',
                sequence: sequence + (call > 4 && this.mode === 'wrong-result-sequence' ? 1 : 0),
                value,
                writeState: 'written',
            };
        } catch {
            return { kind: 'failure', code: 'synthetic-callback-failure', writeState: 'unknown' };
        }
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

function setup(
    signal?: AbortSignal,
    timeoutMs = 1000,
    configure?: (options: Parameters<typeof createWtReferenceSession>[1]) => void,
) {
    const client = new MemoryClient();
    const broker = createRawSessionBroker(client, {
        trustedSuccessQuiescence: true,
        isUsable: () => true,
    });
    const lease = broker.acquire({ deadline: performance.now() + 10000 });
    const signed: Array<{
        uin: string;
        uid: string;
        sequence: number;
        command: string;
        body: Uint8Array;
        input: Uint8Array;
    }> = [];
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
        timeoutMs,
        attemptTimeoutMs: 5000,
        signal,
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
        buildRegisterReserved: ({ uin, uid, sequence, command, body }) => {
            signed.push({ uin, uid, sequence, command, body: Uint8Array.from(body), input: body });
            return Uint8Array.of(sequence);
        },
        verifyRegisterRaw: ({ command }) =>
            command !== SSO_REFERENCE_ALIVE_COMMAND || client.mode !== 'verify-false',
    };
    configure?.(options);
    const session = createWtReferenceSession(lease, options);

    const cleanup = () => {
        client.late.resolve();
        session.close();
        lease.release();
        client.close();
        signed.forEach(({ body }) => body.fill(0));
        client.requests.forEach(({ body, reserved }) => {
            body?.fill(0);
            reserved?.fill(0);
        });
    };

    return { client, broker, lease, session, signed, cleanup };
}

async function confirm(session: ReturnType<typeof createWtReferenceSession>) {
    expect((await session.fetch(fetchFields)).qrUrl).toBe('https://example.invalid/qr');
    expect(await session.poll()).toEqual({ status: 'confirmed' });
}

async function success(session: ReturnType<typeof createWtReferenceSession>) {
    await confirm(session);
    expect(await session.loginAndRegister(loginFields)).toEqual({ status: 'success' });
}

describe('manual alive with the real WT session and borrowed broker', () => {
    it('explicitly schedules real owner heartbeats without alive or overlapping exchanges', async () => {
        let now = 0;
        let nextId = 0;
        const pending = new Map<number, { due: number; callback: () => void }>();
        const timer: SsoHeartbeatSchedulerTimer = {
            now: () => now,
            setTimeout: (callback, delayMs) => {
                const id = ++nextId;
                pending.set(id, { due: now + delayMs, callback });
                return id;
            },
            clearTimeout: (handle) => {
                if (typeof handle !== 'number') {
                    throw new Error('invalid fake timer');
                }

                pending.delete(handle);
            },
        };

        const advance = (time: number) => {
            now = time;
            const due = [...pending.entries()].filter(([, task]) => task.due <= now);
            expect(due).toHaveLength(1);
            pending.delete(due[0][0]);
            due[0][1].callback();
        };

        const events: SsoHeartbeatSchedulerEvent[] = [];
        const firstResult = deferred<void>();
        const secondResult = deferred<void>();
        const f = setup();
        const poison = vi.spyOn(f.lease, 'poison');
        const scheduler = createSsoHeartbeatScheduler(f.session, {
            timer,
            onEvent: (event) => {
                events.push(event);

                if (event.type === 'result') {
                    if (events.filter((item) => item.type === 'result').length === 1) {
                        firstResult.resolve();
                    } else {
                        secondResult.resolve();
                    }
                }
            },
        });

        try {
            await success(f.session);
            expect(f.client.calls).toBe(4);
            expect(pending.size).toBe(0);
            scheduler.start();
            await firstResult.promise;
            expect(f.client.requests.at(-1)).toMatchObject({
                sequence: 54,
                protocol: 12,
                command: SSO_HEARTBEAT_COMMAND,
            });
            expect(events).toContainEqual({
                type: 'result',
                outcome: { status: 'success', interval: 270n },
            });
            f.client.stall = true;
            advance(270_000);
            await f.client.started.promise;
            expect(f.client.requests.at(-1)).toMatchObject({
                sequence: 55,
                protocol: 12,
                command: SSO_HEARTBEAT_COMMAND,
            });
            expect(f.client.calls).toBe(6);
            advance(540_000);
            expect(f.client.calls).toBe(6);
            expect(events).toContainEqual({ type: 'skipped', count: 1, reason: 'busy' });
            f.client.late.resolve();
            await secondResult.promise;
            expect(events.filter((event) => event.type === 'result')).toHaveLength(2);
            expect(
                f.client.requests.some(({ command }) => command === SSO_REFERENCE_ALIVE_COMMAND),
            ).toBe(false);
            await scheduler.stop();
            expect(scheduler.getState()).toBe('stopped');
            expect(pending.size).toBe(0);
            expect(f.session.getState()).toBe('success');
            expect(poison).not.toHaveBeenCalled();
            expect(f.client.close).not.toHaveBeenCalled();
            f.session.close();
            f.lease.release();
            expect(await f.lease.whenClosed).toBe('released');
        } finally {
            f.client.late.resolve();
            await scheduler.stop();
            poison.mockRestore();
            f.cleanup();
        }
    });

    it('runs WT fetch, poll, login and registration, then alive and heartbeat in sequence', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        const factory = vi.spyOn(wtModule, 'createBorrowedWtReferenceLoginAttempt');
        const f = setup();

        try {
            await success(f.session);
            const attemptSignal = factory.mock.calls[0][1].signal;
            expect(attemptSignal?.aborted).toBe(true);
            await vi.advanceTimersByTimeAsync(5001);
            expect(f.client.calls).toBe(4); // No automatic alive, even after the original attempt deadline.
            expect(await f.session.alive()).toEqual({ status: 'success' });
            expect(await f.session.heartbeat()).toEqual({ status: 'success', interval: 270n });
            expect(await f.session.alive()).toEqual({ status: 'success' });
            expect(f.session.getState()).toBe('success');
            expect(
                f.client.requests.map(({ sequence, account, command }) => [
                    sequence,
                    account,
                    command,
                ]),
            ).toEqual([
                [50, '999', 'fixture.qr'],
                [51, '999', 'fixture.qr'],
                [52, '123', 'fixture.login'],
                [53, '123', SSO_INFO_SYNC_COMMAND],
                [54, '123', SSO_REFERENCE_ALIVE_COMMAND],
                [55, '123', SSO_HEARTBEAT_COMMAND],
                [56, '123', SSO_REFERENCE_ALIVE_COMMAND],
            ]);
            expect(new Set(f.client.requests.slice(0, 3).map(({ point }) => point)).size).toBe(1);
            expect(f.client.requests.slice(4)).toMatchObject([
                {
                    protocol: 13,
                    encryption: 0,
                    body: Uint8Array.of(0, 0, 0, 4),
                    reserved: Uint8Array.of(54),
                },
                {
                    protocol: 12,
                    encryption: 1,
                    body: encodeSsoHeartbeatReference(),
                    reserved: Uint8Array.of(55),
                },
                {
                    protocol: 13,
                    encryption: 0,
                    body: Uint8Array.of(0, 0, 0, 4),
                    reserved: Uint8Array.of(56),
                },
            ]);
            expect(
                f.signed.map(({ uin, uid, sequence, command, body }) => ({
                    uin,
                    uid,
                    sequence,
                    command,
                    body,
                })),
            ).toEqual([
                expect.objectContaining({
                    uin: '123',
                    uid: f.client.uid,
                    sequence: 53,
                    command: SSO_INFO_SYNC_COMMAND,
                }),
                {
                    uin: '123',
                    uid: f.client.uid,
                    sequence: 54,
                    command: SSO_REFERENCE_ALIVE_COMMAND,
                    body: Uint8Array.of(0, 0, 0, 4),
                },
                {
                    uin: '123',
                    uid: f.client.uid,
                    sequence: 55,
                    command: SSO_HEARTBEAT_COMMAND,
                    body: encodeSsoHeartbeatReference(),
                },
                {
                    uin: '123',
                    uid: f.client.uid,
                    sequence: 56,
                    command: SSO_REFERENCE_ALIVE_COMMAND,
                    body: Uint8Array.of(0, 0, 0, 4),
                },
            ]);
            expect(f.signed.every(({ input }) => input.every((b) => b === 0))).toBe(true);
            expect(f.client.close).not.toHaveBeenCalled();
        } finally {
            f.cleanup();
            factory.mockRestore();
            vi.useRealTimers();
        }
    });

    it('isolates two confirmed accounts and never accepts caller-selected identity', async () => {
        const a = setup();
        const b = setup();
        a.client.uid = 'inner-uid-a';
        b.client.uid = 'inner-uid-b';
        b.client.account = '456';

        try {
            await Promise.all([success(a.session), success(b.session)]);
            const hostile = a.session.alive as unknown as (
                x: object,
            ) => ReturnType<typeof a.session.alive>;
            expect(
                await Promise.all([hostile({ uin: '456', uid: b.client.uid }), b.session.alive()]),
            ).toEqual([{ status: 'success' }, { status: 'success' }]);
            expect(a.signed.at(-1)).toMatchObject({ uin: '123', uid: 'inner-uid-a', sequence: 54 });
            expect(b.signed.at(-1)).toMatchObject({ uin: '456', uid: 'inner-uid-b', sequence: 54 });
            expect(a.client.requests.at(-1)).toMatchObject({
                account: '123',
                command: SSO_REFERENCE_ALIVE_COMMAND,
            });
            expect(b.client.requests.at(-1)).toMatchObject({
                account: '456',
                command: SSO_REFERENCE_ALIVE_COMMAND,
            });
        } finally {
            a.cleanup();
            b.cleanup();
        }
    });

    it.each(['new', 'failed'] as const)(
        'rejects alive in %s without a transaction',
        async (state) => {
            const f = setup();

            try {
                if (state === 'failed') {
                    await expect(f.session.poll()).rejects.toThrow();
                }

                const before = f.client.calls;
                await expect(f.session.alive()).rejects.toThrow();
                expect(f.client.calls).toBe(before);
                expect(f.session.getState()).toBe('failed');
                expect(await f.lease.whenClosed).toBe('poisoned');
            } finally {
                f.cleanup();
            }
        },
    );

    it.each(['close', 'abort', 'alive', 'heartbeat', 'timeout'] as const)(
        'fences a stalled alive and a late candidate after %s',
        async (reason) => {
            if (reason === 'timeout') {
                vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
            }

            const controller = new AbortController();
            const f = setup(controller.signal, 50);

            try {
                await success(f.session);
                f.client.stall = true;
                const pending = f.session.alive().then(
                    () => 'resolved',
                    () => 'rejected',
                );
                await f.client.started.promise;

                if (reason === 'close') {
                    f.session.close();
                } else if (reason === 'abort') {
                    controller.abort();
                } else if (reason === 'timeout') {
                    await vi.advanceTimersByTimeAsync(51);
                } else {
                    await expect(
                        reason === 'alive' ? f.session.alive() : f.session.heartbeat(),
                    ).rejects.toThrow();
                }

                expect(await pending).toBe('rejected');
                expect(await f.lease.whenClosed).toBe('poisoned');
                f.client.late.resolve();
                await Promise.resolve();
                await Promise.resolve();
                expect(f.session.getState()).toBe(reason === 'close' ? 'closed' : 'failed');
                expect(f.client.calls).toBe(5);
                expect(f.client.close).toHaveBeenCalledTimes(1);
            } finally {
                f.cleanup();

                if (reason === 'timeout') {
                    vi.useRealTimers();
                }
            }
        },
    );

    it('rejects alive reentry from the opaque signer and poisons once', async () => {
        let session!: ReturnType<typeof createWtReferenceSession>;
        let reentry: Promise<string> | undefined;
        const f = setup(undefined, 1000, (options) => {
            options.buildRegisterReserved = ({ command }) => {
                if (command === SSO_REFERENCE_ALIVE_COMMAND) {
                    reentry = session.alive().then(
                        () => 'resolved',
                        () => 'rejected',
                    );
                }

                return Uint8Array.of(8);
            };
        });
        session = f.session;

        try {
            await success(session);
            expect(
                await session.alive().then(
                    () => 'resolved',
                    () => 'rejected',
                ),
            ).toBe('rejected');
            expect(await reentry).toBe('rejected');
            expect(f.client.calls).toBe(5);
            expect(await f.lease.whenClosed).toBe('poisoned');
            expect(session.getState()).toBe('failed');
        } finally {
            f.cleanup();
        }
    });

    it.each(['sso-error', 'wrong-sequence', 'wrong-result-sequence', 'verify-false'] as const)(
        'fails closed on %s',
        async (mode) => {
            const f = setup();

            try {
                await success(f.session);
                f.client.mode = mode;

                if (mode === 'sso-error') {
                    expect(await f.session.alive()).toEqual({ status: 'sso-error', retCode: 42 });
                } else {
                    await expect(f.session.alive()).rejects.toThrow();
                }

                expect(f.session.getState()).toBe('failed');
                expect(await f.lease.whenClosed).toBe('poisoned');
                expect(f.client.close).toHaveBeenCalledTimes(1);
            } finally {
                f.cleanup();
            }
        },
    );

    it('fences a late verifier after abort while its independent copy and effect remain external', async () => {
        const controller = new AbortController();
        const entered = deferred<void>();
        const resume = deferred<void>();
        let input: Uint8Array | undefined;
        let copy: Uint8Array | undefined;
        let effects = 0;
        const f = setup(controller.signal, 1000, (options) => {
            options.verifyRegisterRaw = async ({ command, responseFrame }) => {
                if (command === SSO_REFERENCE_ALIVE_COMMAND) {
                    input = responseFrame;
                    copy = Uint8Array.from(responseFrame);
                    entered.resolve();
                    await resume.promise;
                    effects++;
                }

                return true;
            };
        });

        try {
            await success(f.session);
            const pending = f.session.alive().then(
                () => 'resolved',
                () => 'rejected',
            );
            await entered.promise;
            controller.abort();
            expect(await pending).toBe('rejected');
            expect(await f.lease.whenClosed).toBe('poisoned');
            resume.resolve();
            await nextTurn();
            await nextTurn();
            expect(input!.every((byte) => byte === 0)).toBe(true);
            expect(copy!.some((byte) => byte !== 0)).toBe(true); // External copies cannot be wiped by the owner.
            expect(effects).toBe(1);
            expect(f.session.getState()).toBe('failed');
            expect(f.client.calls).toBe(5);
        } finally {
            resume.resolve();
            copy?.fill(0);
            f.cleanup();
        }
    });

    it.each(['signer', 'verifier'] as const)('fails when the %s throws', async (which) => {
        const f = setup(undefined, 1000, (options) => {
            if (which === 'signer') {
                options.buildRegisterReserved = ({ command }) => {
                    if (command === SSO_REFERENCE_ALIVE_COMMAND) {
                        throw new Error('synthetic signer failure');
                    }

                    return Uint8Array.of(8);
                };
            } else {
                options.verifyRegisterRaw = ({ command }) => {
                    if (command === SSO_REFERENCE_ALIVE_COMMAND) {
                        throw new Error('synthetic verifier failure');
                    }

                    return true;
                };
            }
        });

        try {
            await success(f.session);
            await expect(f.session.alive()).rejects.toThrow();
            expect(f.session.getState()).toBe('failed');
            expect(await f.lease.whenClosed).toBe('poisoned');
            expect(f.client.close).toHaveBeenCalledTimes(1);
        } finally {
            f.cleanup();
        }
    });

    it('blocks alive while heartbeat is in flight', async () => {
        const f = setup();

        try {
            await success(f.session);
            f.client.stall = true;
            const pending = f.session.heartbeat().then(
                () => 'resolved',
                () => 'rejected',
            );
            await f.client.started.promise;
            await expect(f.session.alive()).rejects.toThrow();
            expect(await pending).toBe('rejected');
            expect(await f.lease.whenClosed).toBe('poisoned');
            f.client.late.resolve();
            await nextTurn();
            expect(f.client.calls).toBe(5);
            expect(f.session.getState()).toBe('failed');
        } finally {
            f.cleanup();
        }
    });

    it('leaves a future caller transaction on the lease alone after idle close', async () => {
        const f = setup();
        const poison = vi.spyOn(f.lease, 'poison');

        try {
            await success(f.session);
            f.session.close();
            f.client.external = true;
            const external = f.lease.transactRaw({
                timeoutMs: 1000,
                buildRequest: () => ({ frame: Uint8Array.of(1), context: null }),
                verifyCandidate: () => true,
                consumeCandidate: () => 'caller-result',
            });
            await f.client.started.promise;
            await expect(f.session.alive()).rejects.toThrow();
            expect(poison).not.toHaveBeenCalled();
            expect(f.client.close).not.toHaveBeenCalled();
            f.client.late.resolve();
            expect(await external).toMatchObject({ kind: 'response', value: 'caller-result' });
            f.lease.release();
            expect(await f.lease.whenClosed).toBe('released');
        } finally {
            poison.mockRestore();
            f.cleanup();
        }
    });
});
