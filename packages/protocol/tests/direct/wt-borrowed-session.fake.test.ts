import type { DirectThirdPartyLoginResponse } from '@snowluma/proto-defs/direct-login';
import type { SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawSessionBroker, type RawSessionLease } from '../../src/direct/raw-session-broker';
import { SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import { referenceRegisterOnTransport } from '../../src/direct/sso-reference-register-flow';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
} from '../../src/direct/sso12-packet-client';
import { encodeWtTlv } from '../../src/direct/wt-tlv';
import * as qrDecoder from '../../src/direct/wt-qr-response';
import * as loginDecoder from '../../src/direct/wt-login-response';
import {
    createBorrowedWtReferenceLoginAttempt,
    type BorrowedWtReferenceLoginAttemptOptions,
} from '../../src/direct/wt-reference-login-attempt';
import { fetchBody, parseWt, peer, pollBody, replyWt } from './fixtures/wt-sso-synthetic';

// Entire exchange is synthetic. Parsing and successful registration do not establish
// peer authentication, QQ interoperability, an authenticated session or online state.
const key = new Uint8Array(16).fill(10);
const targetUid = 'synthetic-uid-from-543';

const word = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    return b;
};

const field = (b: Uint8Array) => Buffer.concat([word(b.length + 4), b]);

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function loginBody() {
    const uid = protobuf_encode<DirectThirdPartyLoginResponse>({
        commonInfo: { rspNT: { uid: targetUid } },
    });
    const inner = encodeWtTlv([
        { tag: 0x143, value: Uint8Array.of(9) },
        { tag: 0x305, value: key },
        { tag: 0x10a, value: Uint8Array.of(11) },
        { tag: 0x106, value: Uint8Array.of(12) },
        { tag: 0x543, value: uid },
    ]);
    const result = Buffer.concat([
        Buffer.of(0, 9, 0),
        encodeWtTlv([{ tag: 0x119, value: qqTeaEncrypt(inner, new Uint8Array(16).fill(4)) }]),
    ]);
    inner.fill(0);
    uid.fill(0);
    return result;
}

function registrationReply(sequence: number) {
    const body = protobuf_encode<SsoRegisterResponse>({
        register: { message: 'register success' },
    });
    const inner = Buffer.concat([
        field(
            Buffer.concat([
                word(sequence),
                word(0),
                field(Buffer.alloc(0)),
                field(Buffer.from(SSO_INFO_SYNC_COMMAND)),
                field(Buffer.alloc(0)),
                word(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(body),
    ]);
    const cipher = qqTeaEncrypt(inner, key);
    inner.fill(0);
    body.fill(0);
    return Buffer.concat([
        word(17 + cipher.length),
        word(12),
        Buffer.of(1, 0),
        field(Buffer.from('123')),
        cipher,
    ]);
}

type Observation = {
    sequence: number;
    account: string;
    command: string;
    point?: string;
    kind?: number;
};
type Mode =
    'normal' | 'bad-frame' | 'wrong-account' | 'identity' | 'swapped' | 'sequence' | 'stall';

class MemoryClient implements Sso12RawClient {
    readonly closed = deferred<Sso12CloseReason>();
    readonly whenClosed = this.closed.promise;
    readonly close = vi.fn(() => this.closed.resolve({ kind: 'local', code: 'fixture' }));
    readonly loginEntered = deferred<void>();
    readonly late = deferred<void>();
    readonly requests: Observation[] = [];
    sequence = 50;
    calls = 0;
    verifyCalls = 0;
    consumeCalls = 0;
    mode: Mode = 'normal';
    targetCall = 3;

    async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        const call = ++this.calls;
        const sequence = this.sequence++;
        const identity = { uin: '0', sequence };

        try {
            const built = await options.buildRequest(identity);
            let candidate: Uint8Array;

            if (call <= 3) {
                const wt = parseWt(built.frame);

                try {
                    this.requests.push({
                        sequence: wt.seq,
                        account: wt.account,
                        command: wt.command,
                        point: wt.point.toString('hex'),
                        kind: wt.kind,
                    });
                    const body =
                        wt.kind === 0x31
                            ? fetchBody()
                            : wt.kind === 0x12
                              ? pollBody(0)
                              : loginBody();
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
                const commandStart = 28 + inner.readUInt32BE(28);
                const commandEnd = commandStart + inner.readUInt32BE(commandStart);
                this.requests.push({
                    sequence: inner.readUInt32BE(4),
                    account: frame.subarray(accountStart + 4, accountEnd).toString(),
                    command: inner.subarray(commandStart + 4, commandEnd).toString(),
                });
                inner.fill(0);
                candidate = registrationReply(sequence);
            }

            if (call === 3) {
                this.loginEntered.resolve();
            }

            if (this.mode === 'stall' && call === this.targetCall) {
                await this.late.promise;
            }

            if (this.mode === 'bad-frame' && call === this.targetCall) {
                candidate = Uint8Array.of(1, 2, 3);
            }

            if (this.mode === 'wrong-account' && call === this.targetCall) {
                candidate = Uint8Array.from(candidate);
                candidate.set(Buffer.from('456'), 14);
            }

            const verifyIdentity =
                this.mode === 'identity' && call === this.targetCall
                    ? { ...identity, uin: '987' }
                    : identity;

            this.verifyCalls++;

            if (!(await options.verifyCandidate(candidate, built.context, verifyIdentity))) {
                return { kind: 'failure', code: 'synthetic-rejection', writeState: 'unknown' };
            }

            let consumed = candidate;

            if (this.mode === 'swapped' && call === this.targetCall) {
                consumed = Uint8Array.from(candidate);
                consumed[consumed.length - 1] ^= 1;
            }

            this.consumeCalls++;
            const value = await options.consumeCandidate(consumed, built.context, identity);
            return {
                kind: 'response',
                sequence:
                    this.mode === 'sequence' && call === this.targetCall ? sequence + 1 : sequence,
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
    overrides: Partial<BorrowedWtReferenceLoginAttemptOptions> = {},
    wrapLease: (lease: RawSessionLease) => RawSessionLease = (lease) => lease,
) {
    const client = new MemoryClient();
    const broker = createRawSessionBroker(client, {
        trustedSuccessQuiescence: true,
        isUsable: () => true,
    });
    const lease = broker.acquire({ deadline: performance.now() + 10000 });
    const verified: Array<{
        operation: string;
        transportUin: string;
        requestUin: string;
        responseUin: string;
        businessUin?: bigint;
    }> = [];
    const options: BorrowedWtReferenceLoginAttemptOptions = {
        profile: {
            uin: '999',
            appId: 42,
            subAppId: 43,
            clientVersion: 44,
            guid: Uint8Array.of(1, 2),
            unknown21: new Uint8Array(21),
            randomKey: new Uint8Array(16).fill(7),
            peerPublicKey: peer.publicKey,
            ssoVersion: 'v',
            qrCommand: 'fixture.qr',
            loginCommand: 'fixture.login',
        },
        timeoutMs: 1000,
        attemptTimeoutMs: 5000,
        enableUidProjection: true,
        getTimestamp: () => 10,
        buildReserved: () => new Uint8Array(),
        verifyRaw: () => true,
        verifyContext: ({ operation, transportUin, requestUin, responseUin, businessUin }) => {
            verified.push({ operation, transportUin, requestUin, responseUin, businessUin });
            return responseUin === requestUin;
        },
        sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
        ...overrides,
    };
    const attempt = createBorrowedWtReferenceLoginAttempt(wrapLease(lease), options);
    return { client, broker, lease, attempt, verified };
}

async function confirm(attempt: ReturnType<typeof createBorrowedWtReferenceLoginAttempt>) {
    const qr = await attempt.fetch(fetchFields);
    expect(qr.qrUrl).toBe('https://example.invalid/qr');
    expect(await attempt.poll()).toEqual({ status: 'confirmed' });
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('borrowed WT session through an in-memory broker', () => {
    it('uses one lease and distinct sequences for QR, login and registration', async () => {
        const { client, broker, lease, attempt, verified } = setup();
        await confirm(attempt);
        const login = await attempt.login(loginFields);
        expect(login).toMatchObject({
            status: 'tickets',
            uin: '123',
            uidProjection: { status: 'present', uid: targetUid },
        });

        if (login.status !== 'tickets' || login.uidProjection?.status !== 'present') {
            throw new Error('expected synthetic ticket projection');
        }

        const signed: Array<{ uin: string; uid: string; sequence: number; command: string }> = [];
        const register = await referenceRegisterOnTransport(lease, {
            login,
            profile: { subAppId: 43, guid: Uint8Array.of(1, 2), version: 'header-v' },
            registration: {
                uid: login.uidProjection.uid,
                version: 'build-v',
                deviceName: 'name',
                deviceType: 'type',
                vendorOs: 'os',
                random: 4,
            },
            timeoutMs: 1000,
            buildReserved: ({ uin, uid, sequence, command }) => {
                signed.push({ uin, uid, sequence, command });
                return Uint8Array.of(8);
            },
            verifyRaw: () => true,
        });
        expect(register).toEqual({
            kind: 'response',
            sequence: 53,
            value: 'success',
            writeState: 'written',
        });
        expect(signed).toEqual([
            { uin: '123', uid: targetUid, sequence: 53, command: SSO_INFO_SYNC_COMMAND },
        ]);
        expect(client.requests.map(({ sequence, account }) => [sequence, account])).toEqual([
            [50, '999'],
            [51, '999'],
            [52, '123'],
            [53, '123'],
        ]);
        expect(client.requests.map(({ command }) => command)).toEqual([
            'fixture.qr',
            'fixture.qr',
            'fixture.login',
            SSO_INFO_SYNC_COMMAND,
        ]);
        const points = client.requests.slice(0, 3).map(({ point }) => point);
        expect(points[0]).toHaveLength(50);
        expect(new Set(points).size).toBe(1);
        expect(verified).toEqual([
            {
                operation: 'fetch',
                transportUin: '0',
                requestUin: '999',
                responseUin: '999',
                businessUin: undefined,
            },
            {
                operation: 'poll',
                transportUin: '0',
                requestUin: '999',
                responseUin: '999',
                businessUin: 123n,
            },
            {
                operation: 'login',
                transportUin: '0',
                requestUin: '123',
                responseUin: '123',
                businessUin: undefined,
            },
        ]);
        expect(client.close).not.toHaveBeenCalled();
        attempt.close();
        expect(client.close).not.toHaveBeenCalled();
        expect(() => broker.acquire({ deadline: performance.now() + 1000 })).toThrow();
        lease.release();
        expect(await lease.whenClosed).toBe('released');
        expect(client.close).not.toHaveBeenCalled();
        client.close();
        expect(client.close).toHaveBeenCalledTimes(1);
        Object.values(login.tickets).forEach((v) => v.fill(0));
    });

    it('wipes parsed fetch buffers without wiping the returned QR image', async () => {
        const decode = qrDecoder.decodeWtQrFetchResponse;
        let parsed: ReturnType<typeof decode> | undefined;
        const spy = vi.spyOn(qrDecoder, 'decodeWtQrFetchResponse').mockImplementation((...args) => {
            parsed = decode(...args);
            return parsed;
        });
        const { client, lease, attempt } = setup();

        try {
            const qr = await attempt.fetch(fetchFields);
            expect(qr.image).toEqual(Uint8Array.of(7, 8));
            expect(parsed?.status).toBe('success');

            if (parsed?.status !== 'success') {
                throw new Error('expected parsed synthetic QR');
            }

            for (const buffer of [parsed.image, parsed.d1, parsed.qrSig]) {
                expect(buffer.length).toBeGreaterThan(0);
                expect(buffer.every((byte) => byte === 0)).toBe(true);
            }

            expect(qr.image).not.toBe(parsed.image);
            expect(qr.image).toEqual(Uint8Array.of(7, 8));
        } finally {
            spy.mockRestore();
            attempt.close();
            lease.release();
            client.close();
        }
    });

    it('rejects a first-frame policy denial before login and poisons before returning', async () => {
        const { client, lease, attempt } = setup({ verifyRaw: () => false });
        await expect(attempt.fetch(fetchFields)).rejects.toThrow();
        expect(await lease.whenClosed).toBe('poisoned');
        expect(client.close).toHaveBeenCalledTimes(1);
        expect(client.calls).toBe(1);
        lease.poison();
        expect(client.close).toHaveBeenCalledTimes(1);
        attempt.close();
    });

    it.each(['bad-frame', 'wrong-account', 'identity', 'swapped', 'sequence'] as const)(
        'does not return tickets for %s',
        async (mode) => {
            const { client, lease, attempt } = setup();
            await confirm(attempt);
            client.mode = mode;
            await expect(attempt.login(loginFields)).rejects.toThrow();
            expect(await lease.whenClosed).toBe('poisoned');
            expect(client.close).toHaveBeenCalledTimes(1);
            lease.poison();
            expect(client.close).toHaveBeenCalledTimes(1);
            expect(client.calls).toBe(3);
            attempt.close();
        },
    );

    it.each(['raw', 'context', 'sign'] as const)(
        'fails login closed on synthetic %s error',
        async (phase) => {
            const { client, lease, attempt } = setup({
                buildReserved: ({ command }) => {
                    if (phase === 'sign' && command === 'fixture.login') {
                        throw new Error('fixture sign error');
                    }

                    return new Uint8Array();
                },
                verifyRaw: ({ operation }) => {
                    if (phase === 'raw' && operation === 'login') {
                        throw new Error('fixture verify error');
                    }

                    return true;
                },
                verifyContext: ({ operation }) => {
                    if (phase === 'context' && operation === 'login') {
                        return false;
                    }

                    return true;
                },
            });
            await confirm(attempt);
            await expect(attempt.login(loginFields)).rejects.toThrow();
            expect(await lease.whenClosed).toBe('poisoned');
            expect(client.close).toHaveBeenCalledTimes(1);
            lease.poison();
            expect(client.close).toHaveBeenCalledTimes(1);
            attempt.close();
        },
    );

    it.each(['timeout', 'abort'] as const)(
        'revokes a stalled login on %s and ignores late callbacks',
        async (mode) => {
            const controller = new AbortController();
            const { client, lease, attempt } = setup({
                timeoutMs: mode === 'timeout' ? 100 : 1000,
                signal: controller.signal,
            });
            await confirm(attempt);
            client.mode = 'stall';
            const rejection = expect(attempt.login(loginFields)).rejects.toThrow();
            await client.loginEntered.promise;
            expect(client.calls).toBe(3);

            if (mode === 'abort') {
                controller.abort();
            }

            await rejection;
            expect(await lease.whenClosed).toBe('poisoned');
            expect(client.close).toHaveBeenCalledTimes(1);
            lease.poison();
            client.late.resolve();
            await nextTurn();
            expect(client.close).toHaveBeenCalledTimes(1);
            expect(client.calls).toBe(3);
            attempt.close();
        },
    );

    it.each(['sign', 'context'] as const)(
        'aborts a pending %s despite an earlier stopImmediatePropagation listener',
        async (phase) => {
            const controller = new AbortController();
            controller.signal.addEventListener('abort', (event) =>
                event.stopImmediatePropagation(),
            );
            const waiting = deferred<void>();
            const started = deferred<void>();
            const { client, lease, attempt } = setup({
                signal: controller.signal,
                timeoutMs: 3000,
                buildReserved: async ({ command }) => {
                    if (phase === 'sign' && command === 'fixture.login') {
                        started.resolve();
                        await waiting.promise;
                    }

                    return new Uint8Array();
                },
                verifyContext: async ({ operation }) => {
                    if (phase === 'context' && operation === 'login') {
                        started.resolve();
                        await waiting.promise;
                    }

                    return true;
                },
            });
            await confirm(attempt);
            const pending = attempt.login(loginFields).then(
                () => 'ticket',
                () => 'failed',
            );
            await started.promise;
            controller.abort();
            let timer: ReturnType<typeof setTimeout> | undefined;

            try {
                const settled = await Promise.race([
                    pending,
                    new Promise<'late'>((resolve) => {
                        timer = setTimeout(() => resolve('late'), 500);
                    }),
                ]);
                expect(settled).toBe('failed');
                expect(await lease.whenClosed).toBe('poisoned');
                expect(client.close).toHaveBeenCalledTimes(1);
                lease.poison();
                expect(client.close).toHaveBeenCalledTimes(1);
            } finally {
                if (timer) {
                    clearTimeout(timer);
                }

                waiting.resolve();
                lease.poison();
                await pending;
                await nextTurn();
                attempt.close();
            }
        },
    );

    it.each([true, false])(
        'rejects tickets when the signal aborts and login context returns %s',
        async (verdict) => {
            const controller = new AbortController();
            controller.signal.addEventListener('abort', (event) =>
                event.stopImmediatePropagation(),
            );
            const { client, lease, attempt } = setup({
                signal: controller.signal,
                verifyContext: ({ operation }) => {
                    if (operation === 'login') {
                        controller.abort();
                        return verdict;
                    }

                    return true;
                },
            });
            await confirm(attempt);
            await expect(attempt.login(loginFields)).rejects.toThrow();
            expect(await lease.whenClosed).toBe('poisoned');
            expect(client.close).toHaveBeenCalledTimes(1);
            lease.poison();
            expect(client.close).toHaveBeenCalledTimes(1);
            attempt.close();
        },
    );

    it.each(['late-sign-reject', 'late-verify-resolve'] as const)(
        'does not expose late callbacks or unhandled rejections for %s',
        async (phase) => {
            const unhandled: unknown[] = [];

            const onUnhandled = (reason: unknown) => {
                unhandled.push(reason);
            };

            process.on('unhandledRejection', onUnhandled);
            const decode = loginDecoder.decodeWtLoginResponse;
            const decoder = vi
                .spyOn(loginDecoder, 'decodeWtLoginResponse')
                .mockImplementation((...args) => decode(...args));
            const controller = new AbortController();
            const waiting = deferred<void>();
            const started = deferred<void>();
            let rawLoginCalls = 0;
            let contextLoginCalls = 0;
            const { client, lease, attempt } = setup({
                signal: controller.signal,
                buildReserved: async ({ command }) => {
                    if (phase === 'late-sign-reject' && command === 'fixture.login') {
                        started.resolve();
                        await waiting.promise;
                    }

                    return new Uint8Array();
                },
                verifyRaw: async ({ operation }) => {
                    if (operation === 'login') {
                        rawLoginCalls++;

                        if (phase === 'late-verify-resolve') {
                            started.resolve();
                            await waiting.promise;
                        }
                    }

                    return true;
                },
                verifyContext: ({ operation }) => {
                    if (operation === 'login') {
                        contextLoginCalls++;
                    }

                    return true;
                },
            });

            try {
                await confirm(attempt);
                const pending = expect(attempt.login(loginFields)).rejects.toThrow();
                await started.promise;
                controller.abort();
                await pending;
                expect(await lease.whenClosed).toBe('poisoned');
                expect(client.close).toHaveBeenCalledTimes(1);
                expect(rawLoginCalls).toBe(phase === 'late-sign-reject' ? 0 : 1);
                expect(contextLoginCalls).toBe(0);
                expect(decoder).not.toHaveBeenCalled();
                expect(client.verifyCalls).toBe(phase === 'late-sign-reject' ? 2 : 3);
                expect(client.consumeCalls).toBe(2);

                if (phase === 'late-sign-reject') {
                    waiting.reject(new Error('synthetic late sign rejection'));
                } else {
                    waiting.resolve();
                }

                await nextTurn();
                await nextTurn();
                expect(rawLoginCalls).toBe(phase === 'late-sign-reject' ? 0 : 1);
                expect(contextLoginCalls).toBe(0);
                expect(decoder).not.toHaveBeenCalled();
                expect(client.verifyCalls).toBe(phase === 'late-sign-reject' ? 2 : 3);
                expect(client.consumeCalls).toBe(2);
                expect(unhandled).toEqual([]);
            } finally {
                waiting.resolve();
                lease.poison();
                attempt.close();
                decoder.mockRestore();
                process.off('unhandledRejection', onUnhandled);
            }
        },
    );

    it.each(['fetch', 'poll', 'login'] as const)(
        'blocks reentrant %s during borrowed login cleanup',
        async (operation) => {
            let attempt!: ReturnType<typeof createBorrowedWtReferenceLoginAttempt>;
            let observedSignal: AbortSignal | undefined;
            let listener: (() => void) | undefined;
            let reentered = 0;
            let decodedTickets = false;
            let decodedBeforeReentry = false;
            const decode = loginDecoder.decodeWtLoginResponse;
            const decoder = vi
                .spyOn(loginDecoder, 'decodeWtLoginResponse')
                .mockImplementation((...args) => {
                    const result = decode(...args);
                    decodedTickets = result.status === 'tickets';
                    return result;
                });
            let reentry: Promise<string> | undefined;
            let transactionCount = 0;
            const fixture = setup({}, (lease) => ({
                whenClosed: lease.whenClosed,
                release: () => lease.release(),
                poison: () => lease.poison(),
                close: () => lease.close(),
                transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                    transactionCount++;

                    if (transactionCount === 3) {
                        observedSignal = options.signal;

                        listener = () => {
                            reentered++;
                            decodedBeforeReentry = decodedTickets;
                            const result =
                                operation === 'fetch'
                                    ? attempt.fetch(fetchFields)
                                    : operation === 'poll'
                                      ? attempt.poll()
                                      : attempt.login(loginFields);
                            reentry = result.then(
                                () => 'resolved',
                                () => 'rejected',
                            );
                        };

                        observedSignal?.addEventListener('abort', listener, { once: true });
                    }

                    return lease.transactRaw(options);
                },
            }));
            attempt = fixture.attempt;

            try {
                await confirm(attempt);
                await expect(attempt.login(loginFields)).rejects.toThrow();
                expect(reentered).toBe(1);
                expect(decodedBeforeReentry).toBe(true);
                expect(reentry).toBeDefined();
                expect(await reentry).toBe('rejected');
                expect(transactionCount).toBe(3);
                expect(attempt.getState()).toBe('failed');
                expect(await fixture.lease.whenClosed).toBe('poisoned');
                expect(fixture.client.close).toHaveBeenCalledTimes(1);
                fixture.lease.poison();
                expect(fixture.client.close).toHaveBeenCalledTimes(1);
            } finally {
                if (observedSignal && listener) {
                    observedSignal.removeEventListener('abort', listener);
                }

                fixture.lease.poison();
                attempt.close();
                await reentry;
                decoder.mockRestore();
            }
        },
    );

    it('cancels a pending signer on single-flight violation and wipes its input', async () => {
        const waiting = deferred<Uint8Array>();
        const started = deferred<void>();
        let input: Uint8Array | undefined;
        const { client, lease, attempt } = setup({
            buildReserved: async ({ command, body }) => {
                if (command === 'fixture.login') {
                    input = body;
                    started.resolve();
                    return waiting.promise;
                }

                return new Uint8Array();
            },
        });
        await confirm(attempt);
        const pending = expect(attempt.login(loginFields)).rejects.toThrow();
        await started.promise;
        await expect(attempt.login(loginFields)).rejects.toThrow();
        expect(await lease.whenClosed).toBe('poisoned');
        expect(client.close).toHaveBeenCalledTimes(1);
        lease.poison();
        waiting.resolve(Uint8Array.of(7));
        await pending;
        await nextTurn();
        expect(input).toBeDefined();
        expect(input!.every((v) => v === 0)).toBe(true);
        expect(await lease.whenClosed).toBe('poisoned');
        expect(client.close).toHaveBeenCalledTimes(1);
        attempt.close();
    });
});
