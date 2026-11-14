import type { DirectThirdPartyLoginResponse } from '@snowluma/proto-defs/direct-login';
import type { SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawSessionBroker, type RawSessionLease } from '../../src/direct/raw-session-broker';
import { SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
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

// Only the transport and framing peer are synthetic: this does not authenticate QQ,
// establish an online session, or test a real signer. Callback-owned copies remain external.
const key = new Uint8Array(16).fill(10);

const word = (n: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(n >>> 0);
    return bytes;
};

const field = (bytes: Uint8Array) => Buffer.concat([word(bytes.length + 4), bytes]);

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

type UidMode = 'present' | 'absent' | 'empty' | 'bad-protobuf' | 'outer-only';

function loginBody(uid: string, mode: UidMode) {
    const projection =
        mode === 'bad-protobuf'
            ? Uint8Array.of(0x4a, 0x80)
            : protobuf_encode<DirectThirdPartyLoginResponse>({
                  commonInfo: { rspNT: { uid: mode === 'empty' ? '' : uid } },
              });
    const inner = encodeWtTlv([
        { tag: 0x143, value: Uint8Array.of(9) },
        { tag: 0x305, value: key },
        { tag: 0x10a, value: Uint8Array.of(11) },
        { tag: 0x106, value: Uint8Array.of(12) },
        ...(mode === 'absent' || mode === 'outer-only' ? [] : [{ tag: 0x543, value: projection }]),
    ]);
    const result = Buffer.concat([
        Buffer.of(0, 9, 0),
        encodeWtTlv([
            { tag: 0x119, value: qqTeaEncrypt(inner, new Uint8Array(16).fill(4)) },
            ...(mode === 'outer-only' ? [{ tag: 0x543, value: projection }] : []),
        ]),
    ]);
    inner.fill(0);
    projection.fill(0);
    return result;
}

function registrationReply(sequence: number, message: string) {
    const body = protobuf_encode<SsoRegisterResponse>({ register: { message } });
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

type Request = {
    sequence: number;
    account: string;
    command: string;
    point?: string;
    kind?: number;
};

class MemoryClient implements Sso12RawClient {
    readonly closed = deferred<Sso12CloseReason>();
    readonly whenClosed = this.closed.promise;
    readonly close = vi.fn(() => this.closed.resolve({ kind: 'local', code: 'fixture' }));
    readonly entered = deferred<void>();
    readonly late = deferred<void>();
    readonly requests: Request[] = [];
    sequence = 50;
    calls = 0;
    uid = 'uid-only-from-inner-543';
    uidMode: UidMode = 'present';
    registerMessage = 'register success';
    stallCall = 0;
    rejectCall = 0;
    wrongIdentityCall = 0;
    wrongSequenceCall = 0;
    badFrameCall = 0;
    externalTransaction = false;

    async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        const call = ++this.calls;
        const sequence = this.sequence++;
        const identity = { uin: '0', sequence };

        try {
            const built = await options.buildRequest(identity);

            if (this.externalTransaction) {
                this.entered.resolve();
                await this.late.promise;
                const candidate = Uint8Array.of(3, 4);

                if (!(await options.verifyCandidate(candidate, built.context, identity))) {
                    return { kind: 'failure', code: 'synthetic-rejection', writeState: 'unknown' };
                }

                const value = await options.consumeCandidate(candidate, built.context, identity);
                return { kind: 'response', sequence, value, writeState: 'written' };
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
                        kind: wt.kind,
                    });
                    const body =
                        wt.kind === 0x31
                            ? fetchBody()
                            : wt.kind === 0x12
                              ? pollBody(0)
                              : loginBody(this.uid, this.uidMode);
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
                candidate = registrationReply(sequence, this.registerMessage);
            }

            if (call === this.stallCall) {
                this.entered.resolve();
                await this.late.promise;
            }

            if (call === this.rejectCall) {
                return { kind: 'failure', code: 'synthetic-failure', writeState: 'unknown' };
            }

            if (call === this.badFrameCall) {
                candidate = Uint8Array.of(1, 2, 3);
            }

            const candidateIdentity =
                call === this.wrongIdentityCall ? { ...identity, uin: '987' } : identity;

            if (!(await options.verifyCandidate(candidate, built.context, candidateIdentity))) {
                return { kind: 'failure', code: 'synthetic-rejection', writeState: 'unknown' };
            }

            const value = await options.consumeCandidate(candidate, built.context, identity);
            return {
                kind: 'response',
                sequence: call === this.wrongSequenceCall ? sequence + 1 : sequence,
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
    wrapLease: (lease: RawSessionLease) => RawSessionLease = (lease) => lease,
) {
    const client = new MemoryClient();
    const broker = createRawSessionBroker(client, {
        trustedSuccessQuiescence: true,
        isUsable: () => true,
    });
    const lease = broker.acquire({ deadline: performance.now() + 10000 });
    const signed: Array<{ uin: string; uid: string; sequence: number; command: string }> = [];
    const signerInputs: Uint8Array[] = [];
    const signerRetainedCopies: Uint8Array[] = [];
    const contexts: Array<{
        operation: string;
        transportUin: string;
        requestUin: string;
        responseUin: string;
        businessUin?: bigint;
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
        verifyContext: ({ operation, transportUin, requestUin, responseUin, businessUin }) => {
            contexts.push({ operation, transportUin, requestUin, responseUin, businessUin });
            return responseUin === requestUin;
        },
        sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
        registration: {
            version: 'build-v',
            deviceName: 'name',
            deviceType: 'type',
            vendorOs: 'os',
            random: 4,
        },
        buildRegisterReserved: ({ uin, uid, sequence, command, body }) => {
            signed.push({ uin, uid, sequence, command });
            signerInputs.push(body);
            signerRetainedCopies.push(Uint8Array.from(body));
            return Uint8Array.of(8);
        },
        verifyRegisterRaw: () => true,
    };
    configure?.(options);
    const session = createWtReferenceSession(wrapLease(lease), options);
    return {
        client,
        broker,
        lease,
        session,
        signed,
        signerInputs,
        signerRetainedCopies,
        contexts,
        options,
    };
}

async function confirm(session: ReturnType<typeof createWtReferenceSession>) {
    const result = await session.fetch(fetchFields);
    expect(result.qrUrl).toBe('https://example.invalid/qr');
    expect(await session.poll()).toEqual({ status: 'confirmed' });
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('WT reference session with a real broker and synthetic in-memory peer', () => {
    it('keeps all four stages on one lease and signs the confirmed inner UID', async () => {
        const fixture = setup();
        const {
            client,
            broker,
            lease,
            session,
            signed,
            signerInputs,
            signerRetainedCopies,
            contexts,
        } = fixture;

        try {
            await confirm(session);
            const result = await session.loginAndRegister(loginFields);
            expect(result).toEqual({ status: 'success' });
            expect(Object.keys(result)).toEqual(['status']);
            expect(
                client.requests.map(({ sequence, account, command }) => [
                    sequence,
                    account,
                    command,
                ]),
            ).toEqual([
                [50, '999', 'fixture.qr'],
                [51, '999', 'fixture.qr'],
                [52, '123', 'fixture.login'],
                [53, '123', SSO_INFO_SYNC_COMMAND],
            ]);
            expect(new Set(client.requests.slice(0, 3).map(({ point }) => point)).size).toBe(1);
            expect(contexts).toEqual([
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
            expect(signed).toEqual([
                { uin: '123', uid: client.uid, sequence: 53, command: SSO_INFO_SYNC_COMMAND },
            ]);
            expect(signerInputs[0].length).toBeGreaterThan(0);
            expect(signerInputs[0].every((byte) => byte === 0)).toBe(true);
            expect(signerRetainedCopies[0].some((byte) => byte !== 0)).toBe(true);
            expect(client.close).not.toHaveBeenCalled();
            expect(() => broker.acquire({ deadline: performance.now() + 1000 })).toThrow();
            session.close();
            expect(client.close).not.toHaveBeenCalled();
            lease.release();
            expect(await lease.whenClosed).toBe('released');
        } finally {
            session.close();
            lease.release();
            client.close();
            signerRetainedCopies.forEach((copy) => copy.fill(0));
        }
    });

    it('retains private login ticket buffers until close then wipes them (instrumented reference probe)', async () => {
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
        const fixture = setup();

        try {
            await confirm(fixture.session);
            expect(await fixture.session.loginAndRegister(loginFields)).toEqual({
                status: 'success',
            });
            expect(factory).toHaveBeenCalledTimes(1);
            expect(observed?.status).toBe('tickets');

            if (!observed || observed.status !== 'tickets') {
                throw new Error('missing instrumented real login result');
            }

            for (const bytes of Object.values(observed.tickets)) {
                expect(bytes.length).toBeGreaterThan(0);
                expect(bytes.some((byte) => byte !== 0)).toBe(true);
            }

            fixture.session.close();

            for (const bytes of Object.values(observed.tickets)) {
                expect(bytes.every((byte) => byte === 0)).toBe(true);
            }

            expect(observed.uidProjection).toBeUndefined();
        } finally {
            fixture.session.close();
            fixture.lease.release();
            fixture.client.close();
            fixture.signerRetainedCopies.forEach((copy) => copy.fill(0));
            factory.mockRestore();
        }
    });

    it('rechecks external abort during success cleanup with a foreign lease wrapper', async () => {
        const controller = new AbortController();
        const realFactory = wtModule.createBorrowedWtReferenceLoginAttempt;
        let cleanupSignals = 0;
        const factory = vi
            .spyOn(wtModule, 'createBorrowedWtReferenceLoginAttempt')
            .mockImplementation((lease, options) => {
                options.signal!.addEventListener(
                    'abort',
                    () => {
                        cleanupSignals++;
                        controller.abort();
                    },
                    { once: true },
                );
                return realFactory(lease, options);
            });
        const fixture = setup(controller.signal, 1000, undefined, (lease) => ({
            whenClosed: lease.whenClosed,
            release: () => lease.release(),
            poison: () => lease.poison(),
            close: () => lease.close(),
            transactRaw: (options) => lease.transactRaw(options),
        }));

        try {
            await confirm(fixture.session);
            await expect(fixture.session.loginAndRegister(loginFields)).rejects.toThrow();
            expect(cleanupSignals).toBe(1);
            expect(fixture.client.calls).toBe(4);
            expect(fixture.session.getState()).toBe('failed');
            expect(await fixture.lease.whenClosed).toBe('poisoned');
            expect(fixture.client.close).toHaveBeenCalledTimes(1);
            fixture.lease.poison();
            expect(fixture.client.close).toHaveBeenCalledTimes(1);
        } finally {
            fixture.session.close();
            fixture.lease.poison();
            fixture.signerRetainedCopies.forEach((copy) => copy.fill(0));
            factory.mockRestore();
        }
    });

    it.each(['absent', 'empty', 'bad-protobuf', 'outer-only'] as const)(
        'stops before registration for %s UID',
        async (mode) => {
            const { client, lease, session, signed } = setup();
            client.uidMode = mode;

            try {
                await confirm(session);
                await expect(session.loginAndRegister(loginFields)).rejects.toThrow();
                expect(client.calls).toBe(3);
                expect(signed).toEqual([]);
                expect(await lease.whenClosed).toBe('poisoned');
                expect(client.close).toHaveBeenCalledTimes(1);
                lease.poison();
                expect(client.close).toHaveBeenCalledTimes(1);
            } finally {
                session.close();
                lease.poison();
            }
        },
    );

    it('keeps business rejection separate from successful registration', async () => {
        const { client, lease, session, signerRetainedCopies } = setup();
        client.registerMessage = 'synthetic rejection';

        try {
            await confirm(session);
            expect(await session.loginAndRegister(loginFields)).toEqual({ status: 'rejected' });
            expect(session.getState()).not.toBe('online');
            expect(client.calls).toBe(4);
        } finally {
            session.close();
            lease.release();
            client.close();
            signerRetainedCopies.forEach((copy) => copy.fill(0));
        }
    });

    it.each(['rejectCall', 'wrongIdentityCall', 'wrongSequenceCall', 'badFrameCall'] as const)(
        'poisons once and never retries registration failure %s',
        async (mode) => {
            const { client, lease, session, signerRetainedCopies } = setup();
            client[mode] = 4;

            try {
                await confirm(session);
                await expect(session.loginAndRegister(loginFields)).rejects.toThrow();
                expect(await lease.whenClosed).toBe('poisoned');
                expect(client.calls).toBe(4);
                expect(client.close).toHaveBeenCalledTimes(1);
                lease.poison();
                expect(client.close).toHaveBeenCalledTimes(1);
            } finally {
                session.close();
                lease.poison();
                signerRetainedCopies.forEach((copy) => copy.fill(0));
            }
        },
    );

    it.each(['abort', 'timeout', 'close'] as const)(
        'fences a late registration after %s',
        async (reason) => {
            const controller = new AbortController();
            const { client, lease, session, signerRetainedCopies } = setup(
                controller.signal,
                reason === 'timeout' ? 100 : 1000,
            );
            client.stallCall = 4;

            try {
                await confirm(session);
                const pending = expect(session.loginAndRegister(loginFields)).rejects.toThrow();
                await client.entered.promise;

                if (reason === 'abort') {
                    controller.abort();
                } else if (reason === 'close') {
                    session.close();
                }

                await pending;
                expect(await lease.whenClosed).toBe('poisoned');
                client.late.resolve();
                await nextTurn();
                expect(client.calls).toBe(4);
                expect(client.close).toHaveBeenCalledTimes(1);
            } finally {
                client.late.resolve();
                session.close();
                lease.poison();
                signerRetainedCopies.forEach((copy) => copy.fill(0));
            }
        },
    );

    it('fences a late signer while preserving its independent copy and side effects', async () => {
        const controller = new AbortController();
        const entered = deferred<void>();
        const resume = deferred<void>();
        let input: Uint8Array | undefined;
        let externalCopy: Uint8Array | undefined;
        let sideEffects = 0;
        const { client, lease, session } = setup(controller.signal, 1000, (options) => {
            options.buildRegisterReserved = async ({ body }) => {
                input = body;
                externalCopy = Uint8Array.from(body);
                entered.resolve();
                await resume.promise;
                sideEffects++;
                return Uint8Array.of(8);
            };
        });

        try {
            await confirm(session);
            const pending = session.loginAndRegister(loginFields).then(
                () => 'resolved',
                () => 'rejected',
            );
            await entered.promise;
            controller.abort();
            expect(await pending).toBe('rejected');
            expect(await lease.whenClosed).toBe('poisoned');
            resume.resolve();
            await nextTurn();
            await nextTurn();
            expect(client.calls).toBe(4);
            expect(client.close).toHaveBeenCalledTimes(1);
            expect(input!.every((byte) => byte === 0)).toBe(true);
            expect(externalCopy!.some((byte) => byte !== 0)).toBe(true);
            expect(sideEffects).toBe(1);
        } finally {
            resume.resolve();
            session.close();
            lease.poison();
            externalCopy?.fill(0);
        }
    });

    it.each(['uid', 'socket', 'sequence'] as const)(
        'rejects registration option injection %s',
        (fieldName) => {
            const baseline = setup();
            const client = new MemoryClient();
            const broker = createRawSessionBroker(client, {
                trustedSuccessQuiescence: true,
                isUsable: () => true,
            });
            const lease = broker.acquire({ deadline: performance.now() + 10000 });

            try {
                const registration = {
                    ...baseline.options.registration,
                    [fieldName]: fieldName === 'sequence' ? 9999 : 'hostile',
                };
                expect(() =>
                    createWtReferenceSession(lease, { ...baseline.options, registration }),
                ).toThrow();
                expect(client.calls).toBe(0);
            } finally {
                baseline.session.close();
                baseline.lease.release();
                baseline.client.close();
                lease.poison();
            }
        },
    );

    it('rejects a registration proxy without executing its traps', () => {
        const baseline = setup();
        const client = new MemoryClient();
        const lease = createRawSessionBroker(client, {
            trustedSuccessQuiescence: true,
            isUsable: () => true,
        }).acquire({ deadline: performance.now() + 10000 });
        let traps = 0;
        const registration = new Proxy(baseline.options.registration, {
            ownKeys(target) {
                traps++;
                return Reflect.ownKeys(target);
            },
        });

        try {
            expect(() =>
                createWtReferenceSession(lease, { ...baseline.options, registration }),
            ).toThrow();
            expect(traps).toBe(0);
            expect(client.calls).toBe(0);
        } finally {
            baseline.session.close();
            baseline.lease.release();
            baseline.client.close();
            lease.poison();
        }
    });

    it('does not let caller-supplied login fields select UID, transport or sequence', async () => {
        const { client, lease, session, signed, signerRetainedCopies } = setup();
        const hostile = {
            ...loginFields,
            uid: 'caller-selected-uid',
            socket: { marker: 'caller-socket' },
            sequence: 9999,
            proxy: { marker: 'caller-proxy' },
        };

        try {
            await confirm(session);
            const outcome = await session.loginAndRegister(hostile).then(
                (value) => ({ value }),
                () => ({ error: true as const }),
            );

            if ('value' in outcome) {
                expect(outcome.value).toEqual({ status: 'success' });
                expect(signed).toEqual([
                    { uin: '123', uid: client.uid, sequence: 53, command: SSO_INFO_SYNC_COMMAND },
                ]);
                expect(client.requests.map(({ sequence }) => sequence)).toEqual([50, 51, 52, 53]);
            } else {
                expect(signed).toEqual([]);
            }
        } finally {
            session.close();
            lease.release();
            client.close();
            signerRetainedCopies.forEach((copy) => copy.fill(0));
        }
    });

    it('poisons on external lease loss before registration and does not switch leases', async () => {
        const { client, lease, session, signed } = setup();

        try {
            await confirm(session);
            lease.poison();
            await expect(session.loginAndRegister(loginFields)).rejects.toThrow();
            expect(await lease.whenClosed).toBe('poisoned');
            expect(client.calls).toBe(2);
            expect(signed).toEqual([]);
            expect(client.close).toHaveBeenCalledTimes(1);
        } finally {
            session.close();
            lease.poison();
        }
    });

    it('prevents concurrent login and registration from starting a second transaction', async () => {
        const { client, lease, session, signerRetainedCopies } = setup();
        client.stallCall = 4;

        try {
            await confirm(session);
            const first = session.loginAndRegister(loginFields).then(
                () => 'resolved',
                () => 'rejected',
            );
            await client.entered.promise;
            const second = session.loginAndRegister(loginFields).then(
                () => 'resolved',
                () => 'rejected',
            );
            expect(await second).toBe('rejected');
            expect(client.calls).toBe(4);
            client.late.resolve();
            await first;
            await nextTurn();
            expect(client.calls).toBe(4);
        } finally {
            client.late.resolve();
            session.close();
            lease.poison();
            signerRetainedCopies.forEach((copy) => copy.fill(0));
        }
    });

    it('blocks signer callback reentry before any second transaction', async () => {
        let session!: ReturnType<typeof createWtReferenceSession>;
        let reentry: Promise<string> | undefined;
        const fixture = setup(undefined, 1000, (options) => {
            options.buildRegisterReserved = () => {
                reentry = session.loginAndRegister(loginFields).then(
                    () => 'resolved',
                    () => 'rejected',
                );
                return Uint8Array.of(8);
            };
        });
        session = fixture.session;

        try {
            await confirm(session);
            await session.loginAndRegister(loginFields).then(
                () => undefined,
                () => undefined,
            );
            expect(reentry).toBeDefined();
            expect(await reentry).toBe('rejected');
            expect(fixture.client.calls).toBe(4);
        } finally {
            session.close();
            fixture.lease.poison();
        }
    });

    it.each(['new', 'success'] as const)(
        'old %s owner calls do not disrupt later transactions after idle close',
        async (initial) => {
            const { client, lease, session, signerRetainedCopies } = setup();
            const poison = vi.spyOn(lease, 'poison');

            try {
                if (initial === 'success') {
                    await confirm(session);
                    expect(await session.loginAndRegister(loginFields)).toEqual({
                        status: 'success',
                    });
                }

                session.close();
                expect(client.close).not.toHaveBeenCalled();
                client.externalTransaction = true;
                const transaction = lease.transactRaw({
                    timeoutMs: 1000,
                    buildRequest: () => ({ frame: Uint8Array.of(1), context: null }),
                    verifyCandidate: () => true,
                    consumeCandidate: () => 'external-result',
                });
                await client.entered.promise;
                const before = client.calls;
                await expect(session.fetch(fetchFields)).rejects.toThrow();
                await expect(session.poll()).rejects.toThrow();
                await expect(session.loginAndRegister(loginFields)).rejects.toThrow();
                expect(client.calls).toBe(before);
                expect(poison).not.toHaveBeenCalled();
                expect(client.close).not.toHaveBeenCalled();
                client.late.resolve();
                expect(await transaction).toMatchObject({
                    kind: 'response',
                    value: 'external-result',
                    writeState: 'written',
                });
                expect(client.close).not.toHaveBeenCalled();
                lease.release();
                expect(await lease.whenClosed).toBe('released');
            } finally {
                client.late.resolve();
                session.close();
                lease.release();
                client.close();
                poison.mockRestore();
                signerRetainedCopies.forEach((copy) => copy.fill(0));
            }
        },
    );

    it('keeps two owners and their projected UIDs separate', async () => {
        const a = setup();
        const b = setup();
        a.client.uid = 'owner-a-uid';
        b.client.uid = 'owner-b-uid';

        try {
            await Promise.all([confirm(a.session), confirm(b.session)]);
            expect(
                await Promise.all([
                    a.session.loginAndRegister(loginFields),
                    b.session.loginAndRegister(loginFields),
                ]),
            ).toEqual([{ status: 'success' }, { status: 'success' }]);
            expect(a.signed.map((item) => item.uid)).toEqual(['owner-a-uid']);
            expect(b.signed.map((item) => item.uid)).toEqual(['owner-b-uid']);
            expect(a.client.calls).toBe(4);
            expect(b.client.calls).toBe(4);
        } finally {
            for (const owner of [a, b]) {
                owner.session.close();
                owner.lease.release();
                owner.client.close();
                owner.signerRetainedCopies.forEach((copy) => copy.fill(0));
            }
        }
    });
});
