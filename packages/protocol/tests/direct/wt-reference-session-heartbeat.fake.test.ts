import type { DirectThirdPartyLoginResponse } from '@snowluma/proto-defs/direct-login';
import type { SsoHeartbeatResponse, SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
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

function replySso(sequence: number, command: string, body: Uint8Array, retCode = 0) {
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
        word(17 + cipher.length),
        word(12),
        Buffer.of(1, 0),
        field(Buffer.from('123')),
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
                              ? pollBody(0)
                              : loginBody(this.uid);
                    candidate = replyWt(wt, body);
                    body.fill(0);
                } finally {
                    wt.shared.fill(0);
                    wt.business.fill(0);
                }
            } else {
                const frame = Buffer.from(built.frame);
                const ticketEnd = 9 + frame.readUInt32BE(9);
                const accountStart = ticketEnd + 1;
                const accountEnd = accountStart + frame.readUInt32BE(accountStart);
                const inner = Buffer.from(qqTeaDecrypt(frame.subarray(accountEnd), key));
                const headerEnd = inner.readUInt32BE(0);
                let position = 28;

                const readField = () => {
                    const end = position + inner.readUInt32BE(position);
                    const result = Uint8Array.from(inner.subarray(position + 4, end));
                    position = end;
                    return result;
                };

                readField();
                const command = Buffer.from(readField()).toString();
                readField();
                readField();
                readField();
                position += inner.readUInt16BE(position);
                const reserved = readField();
                const bodyLength = inner.readUInt32BE(headerEnd);
                const body = Uint8Array.from(inner.subarray(headerEnd + 4, headerEnd + bodyLength));
                this.requests.push({
                    sequence: inner.readUInt32BE(4),
                    account: frame.subarray(accountStart + 4, accountEnd).toString(),
                    command,
                    body,
                    reserved,
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
                candidate = replySso(
                    sequence + (call > 4 && this.mode === 'wrong-sequence' ? 1 : 0),
                    command,
                    responseBody,
                    call > 4 && this.mode === 'sso-error' ? 42 : 0,
                );
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
            command !== SSO_HEARTBEAT_COMMAND || client.mode !== 'verify-false',
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

describe('manual WT session heartbeat over the real broker and synthetic peer', () => {
    it('submits two heartbeats after login cleanup on the same lease and binds both signers to the projected UID', async () => {
        const f = setup();

        try {
            await success(f.session);
            expect(f.client.calls).toBe(4);
            expect(await f.session.heartbeat()).toEqual({ status: 'success', interval: 270n });
            expect(await f.session.heartbeat()).toEqual({ status: 'success', interval: 270n });
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
                [54, '123', SSO_HEARTBEAT_COMMAND],
                [55, '123', SSO_HEARTBEAT_COMMAND],
            ]);
            expect(new Set(f.client.requests.slice(0, 3).map(({ point }) => point)).size).toBe(1);
            expect(
                f.signed.map(({ uin, uid, sequence, command }) => ({
                    uin,
                    uid,
                    sequence,
                    command,
                })),
            ).toEqual([
                { uin: '123', uid: f.client.uid, sequence: 53, command: SSO_INFO_SYNC_COMMAND },
                { uin: '123', uid: f.client.uid, sequence: 54, command: SSO_HEARTBEAT_COMMAND },
                { uin: '123', uid: f.client.uid, sequence: 55, command: SSO_HEARTBEAT_COMMAND },
            ]);
            expect(f.client.requests.slice(4).map(({ body }) => body)).toEqual([
                encodeSsoHeartbeatReference(),
                encodeSsoHeartbeatReference(),
            ]);
            expect(f.client.requests.slice(4).map(({ reserved }) => reserved)).toEqual([
                Uint8Array.of(54),
                Uint8Array.of(55),
            ]);
            expect(f.signed.every(({ input }) => input.every((byte) => byte === 0))).toBe(true);
            expect(f.client.close).not.toHaveBeenCalled();
            f.session.close();
            f.lease.release();
            expect(await f.lease.whenClosed).toBe('released');
        } finally {
            f.cleanup();
        }
    });

    it('submits after the login attempt deadline without inheriting its timer', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        const f = setup();

        try {
            await success(f.session);
            await vi.advanceTimersByTimeAsync(5001);
            expect(f.session.getState()).toBe('success');
            expect(await f.session.heartbeat()).toEqual({ status: 'success', interval: 270n });
            expect(f.client.calls).toBe(5);
        } finally {
            f.cleanup();
            vi.useRealTimers();
        }
    });

    it('retains tickets privately through heartbeat and wipes them on idle close', async () => {
        const realFactory = wtModule.createBorrowedWtReferenceLoginAttempt;
        let observed: wtModule.WtReferenceLoginResult | undefined;
        let attemptSignal: AbortSignal | undefined;
        const factory = vi
            .spyOn(wtModule, 'createBorrowedWtReferenceLoginAttempt')
            .mockImplementation((lease, options) => {
                attemptSignal = options.signal;
                const attempt = realFactory(lease, options);
                return {
                    getState: () => attempt.getState(),
                    fetch: (fields) => attempt.fetch(fields),
                    poll: () => attempt.poll(),
                    login: async (fields) => {
                        observed = await attempt.login(fields);
                        return observed;
                    },
                    close: () => attempt.close(),
                };
            });
        const f = setup();

        try {
            await confirm(f.session);
            const result = await f.session.loginAndRegister(loginFields);
            expect(result).toEqual({ status: 'success' });
            expect(Object.keys(result)).toEqual(['status']);
            expect(attemptSignal?.aborted).toBe(true);

            if (!observed || observed.status !== 'tickets') {
                throw new Error('missing instrumented login result');
            }

            for (const bytes of Object.values(observed.tickets)) {
                expect(bytes.length).toBeGreaterThan(0);
                expect(bytes.some((byte) => byte !== 0)).toBe(true);
            }

            expect(await f.session.heartbeat()).toEqual({ status: 'success', interval: 270n });
            expect(f.client.calls).toBe(5);
            f.session.close();

            for (const bytes of Object.values(observed.tickets)) {
                expect(bytes.every((byte) => byte === 0)).toBe(true);
            }

            expect(observed.uidProjection).toBeUndefined();
            expect(f.client.close).not.toHaveBeenCalled();
        } finally {
            f.cleanup();
            factory.mockRestore();
        }
    });

    it('wipes retained tickets when heartbeat verification fails', async () => {
        const realFactory = wtModule.createBorrowedWtReferenceLoginAttempt;
        let observed: wtModule.WtReferenceLoginResult | undefined;
        const factory = vi
            .spyOn(wtModule, 'createBorrowedWtReferenceLoginAttempt')
            .mockImplementation((lease, options) => {
                const attempt = realFactory(lease, options);
                return {
                    getState: () => attempt.getState(),
                    fetch: (fields) => attempt.fetch(fields),
                    poll: () => attempt.poll(),
                    login: async (fields) => {
                        observed = await attempt.login(fields);
                        return observed;
                    },
                    close: () => attempt.close(),
                };
            });
        const f = setup();

        try {
            await success(f.session);

            if (!observed || observed.status !== 'tickets') {
                throw new Error('missing instrumented login result');
            }

            expect(
                Object.values(observed.tickets).every((bytes) => bytes.some((byte) => byte !== 0)),
            ).toBe(true);
            f.client.mode = 'verify-false';
            await expect(f.session.heartbeat()).rejects.toThrow();
            expect(await f.lease.whenClosed).toBe('poisoned');
            expect(f.session.getState()).toBe('failed');
            expect(
                Object.values(observed.tickets).every((bytes) => bytes.every((byte) => byte === 0)),
            ).toBe(true);
            expect(observed.uidProjection).toBeUndefined();
        } finally {
            f.cleanup();
            factory.mockRestore();
        }
    });

    it('keeps distinct owners and UIDs separate and does not let call arguments replace private identity', async () => {
        const a = setup();
        const b = setup();
        a.client.uid = 'fixture-owner-a';
        b.client.uid = 'fixture-owner-b';

        try {
            await Promise.all([success(a.session), success(b.session)]);
            const hostileCall = a.session.heartbeat as unknown as (
                input: object,
            ) => ReturnType<typeof a.session.heartbeat>;
            const outcomes = await Promise.all([
                hostileCall({
                    uid: b.client.uid,
                    uin: '777',
                    sequence: 999,
                    body: Uint8Array.of(88),
                }),
                b.session.heartbeat(),
            ]);
            expect(outcomes).toEqual([
                { status: 'success', interval: 270n },
                { status: 'success', interval: 270n },
            ]);
            expect(a.signed.map(({ uid }) => uid)).toEqual([a.client.uid, a.client.uid]);
            expect(b.signed.map(({ uid }) => uid)).toEqual([b.client.uid, b.client.uid]);
            expect(a.client.requests.at(-1)).toMatchObject({
                sequence: 54,
                account: '123',
                command: SSO_HEARTBEAT_COMMAND,
                body: encodeSsoHeartbeatReference(),
            });
            expect(b.client.requests.at(-1)).toMatchObject({
                sequence: 54,
                account: '123',
                command: SSO_HEARTBEAT_COMMAND,
                body: encodeSsoHeartbeatReference(),
            });
        } finally {
            a.cleanup();
            b.cleanup();
        }
    });

    it.each(['new', 'confirmed', 'failed'] as const)(
        'rejects heartbeat in %s state without a transaction',
        async (state) => {
            const f = setup();

            try {
                if (state !== 'new') {
                    await confirm(f.session);
                }

                if (state === 'failed') {
                    await expect(f.session.fetch(fetchFields)).rejects.toThrow();
                }

                const before = f.client.calls;
                await expect(f.session.heartbeat()).rejects.toThrow();
                expect(f.client.calls).toBe(before);
                expect(f.session.getState()).toBe('failed');
                expect(await f.lease.whenClosed).toBe('poisoned');
                expect(f.client.close).toHaveBeenCalledTimes(1);
            } finally {
                f.cleanup();
            }
        },
    );

    it('closed owner heartbeat leaves a caller transaction on the lease alone', async () => {
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
            const before = f.client.calls;
            await expect(f.session.heartbeat()).rejects.toThrow();
            expect(f.client.calls).toBe(before);
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

    it.each(['close', 'abort', 'concurrent'] as const)(
        'fences a late in-flight heartbeat after %s',
        async (reason) => {
            const controller = new AbortController();
            const f = setup(controller.signal);

            try {
                await success(f.session);
                f.client.stall = true;
                const first = f.session.heartbeat().then(
                    () => 'resolved',
                    () => 'rejected',
                );
                await f.client.started.promise;

                if (reason === 'close') {
                    f.session.close();
                } else if (reason === 'abort') {
                    controller.abort();
                } else {
                    await expect(f.session.heartbeat()).rejects.toThrow();
                }

                expect(await first).toBe('rejected');
                expect(await f.lease.whenClosed).toBe('poisoned');
                expect(f.client.close).toHaveBeenCalledTimes(1);
                f.client.late.resolve();
                await nextTurn();
                await nextTurn();
                expect(f.client.calls).toBe(5);
                expect(f.session.getState()).toBe(reason === 'close' ? 'closed' : 'failed');
                f.lease.poison();
                expect(f.client.close).toHaveBeenCalledTimes(1);
            } finally {
                f.cleanup();
            }
        },
    );

    it('blocks recursive heartbeat from the signer before a second transaction', async () => {
        let session!: ReturnType<typeof createWtReferenceSession>;
        let reentry: Promise<string> | undefined;
        const f = setup(undefined, 1000, (options) => {
            options.buildRegisterReserved = ({ command }) => {
                if (command === SSO_HEARTBEAT_COMMAND) {
                    reentry = session.heartbeat().then(
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
            const first = session.heartbeat().then(
                () => 'resolved',
                () => 'rejected',
            );
            expect(await first).toBe('rejected');
            expect(reentry).toBeDefined();
            expect(await reentry).toBe('rejected');
            expect(f.client.calls).toBe(5);
            expect(await f.lease.whenClosed).toBe('poisoned');
            expect(f.client.close).toHaveBeenCalledTimes(1);
        } finally {
            f.cleanup();
        }
    });

    it('fences a late signer while its independent copy and side effect remain external', async () => {
        const controller = new AbortController();
        const entered = deferred<void>();
        const resume = deferred<void>();
        let input: Uint8Array | undefined;
        let copy: Uint8Array | undefined;
        let effects = 0;
        const f = setup(controller.signal, 1000, (options) => {
            options.buildRegisterReserved = async ({ command, body }) => {
                if (command === SSO_HEARTBEAT_COMMAND) {
                    input = body;
                    copy = Uint8Array.from(body);
                    entered.resolve();
                    await resume.promise;
                    effects++;
                }

                return Uint8Array.of(8);
            };
        });

        try {
            await success(f.session);
            const pending = f.session.heartbeat().then(
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
            expect(f.client.calls).toBe(5);
            expect(f.client.close).toHaveBeenCalledTimes(1);
            expect(input!.every((byte) => byte === 0)).toBe(true);
            expect(copy!.some((byte) => byte !== 0)).toBe(true);
            expect(effects).toBe(1);
        } finally {
            resume.resolve();
            copy?.fill(0);
            f.cleanup();
        }
    });

    it('fences a pending verifier after abort, without claiming its retained copy is erased', async () => {
        const controller = new AbortController();
        const entered = deferred<void>();
        const resume = deferred<void>();
        let callbackInput: Uint8Array | undefined;
        let retainedCopy: Uint8Array | undefined;
        let effects = 0;
        const f = setup(controller.signal, 1000, (options) => {
            options.verifyRegisterRaw = async ({ command, responseFrame }) => {
                if (command === SSO_HEARTBEAT_COMMAND) {
                    callbackInput = responseFrame;
                    retainedCopy = Uint8Array.from(responseFrame);
                    entered.resolve();
                    await resume.promise;
                    effects++;
                }

                return true;
            };
        });

        try {
            await success(f.session);
            const pending = f.session.heartbeat().then(
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
            expect(callbackInput!.every((byte) => byte === 0)).toBe(true);
            expect(retainedCopy!.some((byte) => byte !== 0)).toBe(true);
            expect(effects).toBe(1);
            expect(f.session.getState()).toBe('failed');
            expect(f.client.calls).toBe(5);
            expect(f.client.close).toHaveBeenCalledTimes(1);
        } finally {
            resume.resolve();
            retainedCopy?.fill(0);
            f.cleanup();
        }
    });

    it.each([
        'sso-error',
        'missing-interval',
        'zero-interval',
        'wrong-wire',
        'wrong-wire-after-unknowns',
        'wrong-sequence',
        'wrong-result-sequence',
        'verify-false',
        'read-expired',
    ] as const)('classifies or fences heartbeat %s', async (mode) => {
        const f = setup(undefined, mode === 'read-expired' ? 50 : 1000);

        try {
            await success(f.session);
            f.client.mode = mode;
            const pending = f.session.heartbeat();

            if (mode === 'read-expired') {
                await f.client.started.promise;
            }

            if (mode === 'missing-interval') {
                expect(await pending).toEqual({ status: 'missing-interval' });
                expect(f.session.getState()).toBe('success');
                f.client.mode = 'none';
                expect(await f.session.heartbeat()).toEqual({ status: 'success', interval: 270n });
            } else if (mode === 'zero-interval') {
                expect(await pending).toEqual({ status: 'success', interval: 0n });
                expect(f.session.getState()).toBe('success');
            } else {
                if (mode === 'sso-error') {
                    expect(await pending).toEqual({ status: 'sso-error', retCode: 42 });
                } else {
                    await expect(pending).rejects.toThrow();
                }

                expect(await f.lease.whenClosed).toBe('poisoned');
                expect(f.session.getState()).toBe('failed');
                expect(f.client.close).toHaveBeenCalledTimes(1);
                f.client.late.resolve();
                await nextTurn();
                expect(f.client.calls).toBe(5);
            }
        } finally {
            f.cleanup();
        }
    });
});
