import type {
    DirectSendMessageRequest,
    DirectSendMessageResponse,
} from '@snowluma/proto-defs/direct-send-message';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { createRawMultiplexClient } from '../../src/direct/raw-multiplex-client';
import type { RawSessionLease } from '../../src/direct/raw-session-broker';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import {
    referenceSendTextOnTransport,
    referenceSendTextWithCapability,
    type SsoReferenceSendTextOptions,
} from '../../src/direct/sso-reference-send-text-flow';
import type { Sso12RawOptions, Sso12RawResult } from '../../src/direct/sso12-packet-client';
import { createWtEcdh } from '../../src/direct/wt-ecdh';
import {
    bindReferenceKeyCapability,
    createBorrowedWtReferenceLoginAttempt,
} from '../../src/direct/wt-reference-login-attempt';
import {
    assertReferenceSendIdentity,
    beginReferenceSend,
    commitReferenceKey,
    createReferenceKeyCapability,
    endReferenceSend,
    reserveReferenceKeyCapability,
    revokeReferenceKey,
    stageReferenceConfirmed,
    stageReferenceKey,
} from '../../src/direct/wt-reference-session-private';

// Synthetic local policy only: a result is a local projection, not peer
// authentication, server receipt, or business delivery. No network is opened.
const key = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const sequence = 0xf0000001;
const command = 'MessageSvc.PbSendMsg';
const clientSequence = 9007199254740993n;
const peer = createWtEcdh(Buffer.concat([Buffer.alloc(23), Buffer.of(2)]));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function word(value: number): Buffer {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value >>> 0);
    return bytes;
}

const field = (value: Uint8Array) => Buffer.concat([word(value.length + 4), value]);

function syntheticResponse(): Uint8Array {
    const body = protobuf_encode<DirectSendMessageResponse>({
        result: 0,
        sequence: 99n,
        clientSequence: 88n,
    });
    const header = Buffer.concat([
        word(sequence),
        word(0),
        field(Buffer.alloc(0)),
        field(Buffer.from(command)),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    const cipher = qqTeaEncrypt(Buffer.concat([field(header), field(body)]), key);
    const uin = Buffer.from('123');
    return Buffer.concat([
        word(14 + uin.length + cipher.length),
        word(12),
        Buffer.of(1, 0),
        field(uin),
        cipher,
    ]);
}

function inspectWritten(frame: Uint8Array) {
    const wire = Buffer.from(frame);
    const ticketEnd = 9 + wire.readUInt32BE(9);
    const accountStart = ticketEnd + 1;
    const accountEnd = accountStart + wire.readUInt32BE(accountStart);
    const inner = Buffer.from(qqTeaDecrypt(wire.subarray(accountEnd), key));
    const headerEnd = inner.readUInt32BE(0);
    let position = 28;

    const readField = () => {
        const end = position + inner.readUInt32BE(position);
        const value = inner.subarray(position + 4, end);
        position = end;
        return value;
    };

    const a2 = Uint8Array.from(readField());
    const actualCommand = readField().toString();
    readField();
    const guid = Uint8Array.from(readField());
    readField();
    position += inner.readUInt16BE(position);
    const reserved = Uint8Array.from(readField());
    return {
        uin: wire.subarray(accountStart + 4, accountEnd).toString(),
        sequence: inner.readUInt32BE(4),
        command: actualCommand,
        d2: Uint8Array.from(wire.subarray(13, ticketEnd)),
        a2,
        guid,
        reserved,
        body: Uint8Array.from(inner.subarray(headerEnd + 4)),
    };
}

function options(kind: 'private' | 'group' = 'private'): SsoReferenceSendTextOptions {
    return {
        login: {
            status: 'tickets',
            uin: '123',
            tickets: {
                d2: Uint8Array.of(3, 4),
                d2Key: Uint8Array.from(key),
                a1: Uint8Array.of(5),
                a2: Uint8Array.of(6, 7),
            },
        },
        profile: { subAppId: 42, guid: Uint8Array.of(0xab, 0xcd), version: 'header-v' },
        uid: 'fixture-uid',
        request: {
            route:
                kind === 'private'
                    ? { kind: 'private', peerUin: 456n, peerUid: 'fixture-peer' }
                    : { kind: 'group', groupUin: 789n },
            text: 'synthetic text 中🙂',
            clientSequence,
            random: 0x12345678,
        },
        maxResponseBodyBytes: 65536,
        timeoutMs: 3000,
        buildReserved: () => Uint8Array.of(8),
        verifyRaw: () => true,
    };
}

type IdentityObservation = { phase: 'build' | 'verify' | 'consume'; uin: string; sequence: number };

function fixture() {
    const writes: Uint8Array[] = [];
    const identities: IdentityObservation[] = [];
    const wrote = deferred<void>();
    const consumed = deferred<void>();
    const consumeEntered = deferred<void>();
    const releaseConsume = deferred<void>();
    const releaseResult = deferred<void>();
    const resultReady = deferred<void>();
    const pending = new Set<Promise<unknown>>();
    const gates: Array<() => void> = [];

    const track = <T>(work: Promise<T>): Promise<T> => {
        pending.add(work);
        void work.then(
            () => pending.delete(work),
            () => pending.delete(work),
        );
        return work;
    };

    const gate = <T>(releaseValue: T) => {
        const value = deferred<T>();
        gates.push(() => value.resolve(releaseValue));
        return value;
    };

    let holdResult = false;
    let holdConsume = false;
    const client = createRawMultiplexClient({
        uin: '0',
        initialSequence: sequence,
        defaultTimeoutMs: 3000,
        maxFrameBytes: 131072,
        maxBufferedBytes: 262144,
        maxFrames: 8,
        maxPushFrames: 8,
        maxPushBytes: 262144,
        write: (frame) => {
            writes.push(Uint8Array.from(frame));
            wrote.resolve();
        },
        classify: () => ({ kind: 'response', sequence }),
        verifyPush: () => false,
        onPush: () => {
            throw new Error('unexpected synthetic push');
        },
    });
    const lease: RawSessionLease = {
        whenClosed: new Promise(() => {}),
        release: vi.fn(),
        poison: vi.fn(),
        close: vi.fn(),
        async transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
            const result = await client.transactRaw({
                ...raw,
                buildRequest: (identity) => {
                    identities.push({ phase: 'build', ...identity });
                    return track(Promise.resolve().then(() => raw.buildRequest(identity)));
                },
                verifyCandidate: (bytes, context, identity) => {
                    identities.push({ phase: 'verify', ...identity });
                    return track(
                        Promise.resolve().then(() => raw.verifyCandidate(bytes, context, identity)),
                    );
                },
                consumeCandidate: (bytes, context, identity) => {
                    identities.push({ phase: 'consume', ...identity });
                    return track(
                        Promise.resolve().then(async () => {
                            consumeEntered.resolve();

                            if (holdConsume) {
                                await releaseConsume.promise;
                            }

                            const value = await raw.consumeCandidate(bytes, context, identity);
                            consumed.resolve();
                            return value;
                        }),
                    );
                },
            });
            resultReady.resolve();

            if (holdResult) {
                await releaseResult.promise;
            }

            return result;
        },
    };
    const attempt = createBorrowedWtReferenceLoginAttempt(lease, {
        profile: {
            uin: '999',
            appId: 42,
            subAppId: 43,
            clientVersion: 44,
            guid: Uint8Array.of(1, 2),
            unknown21: new Uint8Array(21),
            randomKey: new Uint8Array(16).fill(7),
            peerPublicKey: peer.publicKey,
            ssoVersion: 'fixture',
            qrCommand: 'fixture.qr',
            loginCommand: 'fixture.login',
        },
        timeoutMs: 3000,
        attemptTimeoutMs: 30000,
        getTimestamp: () => 10,
        buildReserved: () => new Uint8Array(),
        verifyRaw: () => true,
        verifyContext: () => true,
        sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
    });
    const token = createReferenceKeyCapability();
    const reservation = reserveReferenceKeyCapability(token);
    bindReferenceKeyCapability(attempt, token, reservation);

    const stage = () => {
        stageReferenceConfirmed(token, attempt, '0', '123', 41);
        const stagedKey = Uint8Array.from(key);
        stageReferenceKey(token, attempt, '0', '123', 42, stagedKey);
        stagedKey.fill(0);
    };

    const activate = () => {
        stage();
        commitReferenceKey(token);
    };

    const feed = () => {
        const response = syntheticResponse();
        client.feed(response.subarray(0, 3));
        client.feed(response.subarray(3));
    };

    return {
        client,
        lease,
        attempt,
        token,
        writes,
        identities,
        wrote,
        consumed,
        releaseResult,
        consumeEntered,
        releaseConsume,
        resultReady,
        gate,
        track,
        pending,
        stage,
        activate,
        feed,
        holdResult: () => {
            holdResult = true;
        },
        holdConsume: () => {
            holdConsume = true;
        },
        close: () => {
            gates.forEach((release) => release());
            releaseConsume.resolve();
            releaseResult.resolve();
            client.close();
            attempt.close();
            revokeReferenceKey(token);
        },
    };
}

type Fixture = ReturnType<typeof fixture>;

async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('fixture watchdog')), 5000);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

// Test-owned gates are always released and tracked operations settled, including
// late callbacks. A noncooperative external owner may still never settle; this
// fixture makes no general cancellation or erasure guarantee for such an owner.
async function withFixture(test: (f: Fixture) => Promise<void>): Promise<void> {
    const f = fixture();
    let failed = false;
    let failure: unknown;

    try {
        await test(f);
    } catch (error) {
        failed = true;
        failure = error;
    } finally {
        const recordCleanupError = (error: unknown) => {
            if (!failed) {
                failed = true;
                failure = error;
            } else {
                console.error('fixture cleanup failed after test failure', error);
            }
        };

        try {
            f.close();
        } catch (error) {
            recordCleanupError(error);
        }

        try {
            await bounded(Promise.allSettled([...f.pending]));
        } catch (error) {
            recordCleanupError(error);
        }
    }

    if (failed) {
        throw failure;
    }
}

function send(f: Fixture, input: SsoReferenceSendTextOptions, run: object = {}) {
    return f.track(
        referenceSendTextWithCapability(
            {
                token: f.token,
                attempt: f.attempt,
                lease: f.lease,
                run,
            },
            input,
        ),
    );
}

async function reached(gate: Promise<void>, pending: Promise<unknown>): Promise<void> {
    await bounded(
        Promise.race([
            gate,
            pending.then(() => {
                throw new Error('operation ended before fixture gate');
            }),
        ]),
    );
}

async function expectRejected(pending: Promise<unknown>): Promise<void> {
    const result = await bounded(
        pending.then(
            (value) => ({ kind: 'returned' as const, value }),
            () => ({ kind: 'threw' as const }),
        ),
    );

    if (result.kind === 'returned') {
        expect(result.value).toMatchObject({ kind: 'failure' });
    }
}

describe('capability-bound reference send (synthetic memory only)', () => {
    it('keeps the public transport helper strict on 0 versus 123', () =>
        withFixture(async (f) => {
            const input = options();
            input.buildReserved = vi.fn(input.buildReserved);
            input.verifyRaw = vi.fn(input.verifyRaw);
            const result = await f.track(referenceSendTextOnTransport(f.lease, input));
            expect(result.kind).toBe('failure');
            expect(f.identities).toEqual([{ phase: 'build', uin: '0', sequence }]);
            expect(input.buildReserved).not.toHaveBeenCalled();
            expect(input.verifyRaw).not.toHaveBeenCalled();
            expect(f.writes).toHaveLength(0);
        }));

    it('keeps the public entry async if its initial clock read throws', () =>
        withFixture(async (f) => {
            const clock = vi.spyOn(performance, 'now').mockImplementationOnce(() => {
                throw new Error('synthetic clock failure');
            });
            let promise: ReturnType<typeof referenceSendTextOnTransport> | undefined;

            try {
                promise = referenceSendTextOnTransport(f.lease, options());
            } finally {
                clock.mockRestore();
            }

            expect(promise).toBeInstanceOf(Promise);
            await expect(promise).rejects.toThrow('synthetic clock failure');
            expect(f.writes).toHaveLength(0);
        }));

    it('keeps direct construction of the public helper a synchronous TypeError', () =>
        withFixture(async (f) => {
            expect(() =>
                Reflect.construct(referenceSendTextOnTransport, [f.lease, options()]),
            ).toThrow(TypeError);
            expect(f.identities).toHaveLength(0);
            expect(f.writes).toHaveLength(0);
        }));

    it('reads the public transport getter before taking the options snapshot', () =>
        withFixture(async (f) => {
            const input = options();
            input.buildReserved = vi.fn(input.buildReserved);
            let reads = 0;
            let receiver: unknown;
            const transport = {
                get transactRaw() {
                    reads++;
                    Reflect.set(input.login, 'uin', '456');

                    return function <C, T>(this: unknown, raw: Sso12RawOptions<C, T>) {
                        receiver = this;
                        return f.lease.transactRaw(raw);
                    };
                },
            };
            await expectRejected(f.track(referenceSendTextOnTransport(transport, input)));
            expect(reads).toBe(1);
            expect(receiver).toBe(transport);
            expect(input.buildReserved).not.toHaveBeenCalled();
            expect(f.writes).toHaveLength(0);
        }));

    it.each(['private', 'group'] as const)(
        'binds %s route, actual identity and one sequence to a local projected response',
        (kind) =>
            withFixture(async (f) => {
                f.activate();
                const input = options(kind);
                let signerBody!: Uint8Array;
                input.buildReserved = vi.fn((evidence) => {
                    expect(evidence).toMatchObject({
                        uin: '123',
                        uid: 'fixture-uid',
                        sequence,
                        command,
                    });
                    signerBody = Uint8Array.from(evidence.body);
                    return Uint8Array.of(8);
                });
                input.verifyRaw = vi.fn((evidence) => {
                    expect(evidence).toMatchObject({ uin: '123', sequence, command });
                    return true;
                });
                const pending = send(f, input);
                await reached(f.wrote.promise, pending);
                f.feed();
                expect(await bounded(pending)).toMatchObject({
                    kind: 'response',
                    sequence,
                    writeState: 'written',
                    value: {
                        status: 'response',
                        response: {
                            result: 0,
                            sequence: 99n,
                            clientSequence: 88n,
                            selectedSequence: 88n,
                        },
                    },
                });
                expect(f.identities).toEqual(
                    ['build', 'verify', 'consume'].map((phase) => ({
                        phase,
                        uin: '0',
                        sequence,
                    })),
                );
                expect(f.writes).toHaveLength(1);
                const written = inspectWritten(f.writes[0]);
                expect(written).toMatchObject({
                    uin: '123',
                    sequence,
                    command,
                    reserved: Uint8Array.of(8),
                });
                expect(written.body).toEqual(signerBody);
                const decoded = protobuf_decode<DirectSendMessageRequest>(written.body);
                expect(decoded.clientSequence).toBe(clientSequence);
                expect(decoded.random).toBe(0x12345678);
                expect(decoded.messageBody.richText.elems[0].text.text).toBe('synthetic text 中🙂');

                if (kind === 'private') {
                    expect(decoded.routingHead.c2c).toEqual({
                        peerUin: 456n,
                        peerUid: 'fixture-peer',
                    });
                    expect(decoded.routingHead.group).toBeNull();
                } else {
                    expect(decoded.routingHead.group).toEqual({ groupUin: 789n });
                    expect(decoded.routingHead.c2c).toBeNull();
                }

                expect(input.buildReserved).toHaveBeenCalledOnce();
                expect(input.verifyRaw).toHaveBeenCalledOnce();
            }),
    );

    it('rejects a key different from the active staged D2 key before sign or write', () =>
        withFixture(async (f) => {
            f.activate();
            const input = options();
            input.login.tickets.d2Key[0] ^= 0xff;
            input.buildReserved = vi.fn(input.buildReserved);
            input.verifyRaw = vi.fn(input.verifyRaw);
            await expectRejected(send(f, input));
            expect(input.buildReserved).not.toHaveBeenCalled();
            expect(input.verifyRaw).not.toHaveBeenCalled();
            expect(f.writes).toHaveLength(0);
        }));

    it.each(['empty', 'tentative', 'revoked'] as const)(
        'rejects %s capability without signing or writing',
        (state) =>
            withFixture(async (f) => {
                if (state === 'tentative') {
                    f.stage();
                }

                if (state === 'revoked') {
                    f.activate();
                    revokeReferenceKey(f.token);
                }

                const input = options();
                input.buildReserved = vi.fn(input.buildReserved);
                await expectRejected(send(f, input));
                expect(input.buildReserved).not.toHaveBeenCalled();
                expect(f.writes).toHaveLength(0);
            }),
    );

    it('rejects substituted token, attempt and lease without damaging another active run', () =>
        withFixture(async (a) =>
            withFixture(async (b) => {
                a.activate();
                b.activate();
                const liveRun = {};
                beginReferenceSend(a.token, a.attempt, a.lease, liveRun);
                const input = options();
                input.buildReserved = vi.fn(input.buildReserved);

                for (const binding of [
                    { token: {}, attempt: a.attempt, lease: a.lease, run: {} },
                    { token: a.token, attempt: b.attempt, lease: a.lease, run: {} },
                    { token: a.token, attempt: a.attempt, lease: b.lease, run: {} },
                    { token: b.token, attempt: a.attempt, lease: a.lease, run: {} },
                    { token: a.token, attempt: a.attempt, lease: a.lease, run: {} },
                ]) {
                    await expectRejected(a.track(referenceSendTextWithCapability(binding, input)));
                    expect(
                        assertReferenceSendIdentity(
                            a.token,
                            a.attempt,
                            a.lease,
                            liveRun,
                            '0',
                            '123',
                        ),
                    ).toBeUndefined();
                }

                endReferenceSend(a.token, a.attempt, a.lease, liveRun);
                expect(input.buildReserved).not.toHaveBeenCalled();
                expect(a.writes).toHaveLength(0);
                expect(b.writes).toHaveLength(0);
            }),
        ));

    it('rejects a previously used run while preserving a different active run', () =>
        withFixture(async (f) => {
            f.activate();
            const used = {};
            const live = {};
            beginReferenceSend(f.token, f.attempt, f.lease, used);
            endReferenceSend(f.token, f.attempt, f.lease, used);
            beginReferenceSend(f.token, f.attempt, f.lease, live);
            const input = options();
            input.buildReserved = vi.fn(input.buildReserved);
            await expectRejected(send(f, input, used));
            expect(
                assertReferenceSendIdentity(f.token, f.attempt, f.lease, live, '0', '123'),
            ).toBeUndefined();
            endReferenceSend(f.token, f.attempt, f.lease, live);
            await expectRejected(send(f, input, used));
            expect(input.buildReserved).not.toHaveBeenCalled();
            expect(f.writes).toHaveLength(0);
        }));

    it('snapshots caller tickets, request, route, uid and guid before a pending signer resumes', () =>
        withFixture(async (f) => {
            f.activate();
            const input = options('private');
            const entered = deferred<void>();
            const gate = f.gate(Uint8Array.of(8));
            let signerBody!: Uint8Array;
            input.buildReserved = vi.fn((evidence) => {
                expect(evidence).toMatchObject({
                    uin: '123',
                    uid: 'fixture-uid',
                    sequence,
                    command,
                });
                signerBody = Uint8Array.from(evidence.body);
                entered.resolve();
                return gate.promise;
            });
            const pending = send(f, input);
            await reached(entered.promise, pending);
            const tickets = input.login.tickets;
            tickets.d2.fill(0x31);
            tickets.d2Key.fill(0x32);
            tickets.a1.fill(0x33);
            tickets.a2.fill(0x34);
            input.profile.guid.fill(0x35);
            input.uid = 'changed-uid';
            const originalRoute = input.request.route;
            Reflect.set(originalRoute, 'peerUin', 999n);
            Reflect.set(originalRoute, 'peerUid', 'changed-peer');
            Reflect.set(input.request, 'text', 'changed text');
            Reflect.set(input.request, 'random', 7);
            Reflect.set(input.request, 'clientSequence', 2n);
            Reflect.set(input.request, 'route', { kind: 'group', groupUin: 999n });
            const retained = [
                tickets.d2,
                tickets.d2Key,
                tickets.a1,
                tickets.a2,
                input.profile.guid,
            ];
            const snapshots = retained.map((bytes) => Uint8Array.from(bytes));
            gate.resolve(Uint8Array.of(8));
            await reached(f.wrote.promise, pending);
            f.feed();
            expect(await bounded(pending)).toMatchObject({ kind: 'response' });
            const written = inspectWritten(f.writes[0]);
            expect(written).toMatchObject({
                uin: '123',
                sequence,
                d2: Uint8Array.of(3, 4),
                a2: Uint8Array.of(6, 7),
                guid: Uint8Array.from(Buffer.from('abcd')),
            });
            expect(written.body).toEqual(signerBody);
            const decoded = protobuf_decode<DirectSendMessageRequest>(written.body);
            expect(decoded.routingHead.c2c).toEqual({ peerUin: 456n, peerUid: 'fixture-peer' });
            expect(decoded.messageBody.richText.elems[0].text.text).toBe('synthetic text 中🙂');
            expect(decoded.random).toBe(0x12345678);
            retained.forEach((bytes, i) => expect(bytes).toEqual(snapshots[i]));
        }));

    it('revocation during pending signer prevents a later write and response', () =>
        withFixture(async (f) => {
            f.activate();
            const input = options();
            const entered = deferred<void>();
            const gate = f.gate(Uint8Array.of(8));
            input.buildReserved = vi.fn(() => {
                entered.resolve();
                return gate.promise;
            });
            input.verifyRaw = vi.fn(input.verifyRaw);
            const pending = send(f, input);
            await reached(entered.promise, pending);
            revokeReferenceKey(f.token);
            gate.resolve(Uint8Array.of(8));
            expect(await bounded(pending)).toEqual({
                kind: 'failure',
                code: 'borrowed-transaction-failed',
                writeState: 'unknown',
            });
            expect(f.writes).toHaveLength(0);
            expect(input.verifyRaw).not.toHaveBeenCalled();
            expect(f.identities).toEqual([{ phase: 'build', uin: '0', sequence }]);
        }));

    it('revocation during pending local verification suppresses consumption and response', () =>
        withFixture(async (f) => {
            f.activate();
            const input = options();
            const entered = deferred<void>();
            const gate = f.gate(true);
            input.verifyRaw = vi.fn(() => {
                entered.resolve();
                return gate.promise;
            });
            const pending = send(f, input);
            await reached(f.wrote.promise, pending);
            f.feed();
            await reached(entered.promise, pending);
            revokeReferenceKey(f.token);
            gate.resolve(true);
            expect(await bounded(pending)).toEqual({
                kind: 'failure',
                code: 'borrowed-transaction-failed',
                writeState: 'unknown',
            });
            expect(f.writes).toHaveLength(1);
            expect(f.identities).toEqual(
                ['build', 'verify'].map((phase) => ({ phase, uin: '0', sequence })),
            );
        }));

    it('rechecks revocation after verifier returns but before consume', () =>
        withFixture(async (f) => {
            f.activate();
            f.holdConsume();
            const input = options();
            input.verifyRaw = vi.fn(input.verifyRaw);
            const pending = send(f, input);
            await reached(f.wrote.promise, pending);
            f.feed();
            await reached(f.consumeEntered.promise, pending);
            expect(input.verifyRaw).toHaveBeenCalledOnce();
            revokeReferenceKey(f.token);
            f.releaseConsume.resolve();
            expect(await bounded(pending)).toEqual({
                kind: 'failure',
                code: 'borrowed-transaction-failed',
                writeState: 'unknown',
            });
            expect(f.writes).toHaveLength(1);
            expect(f.identities).toEqual(
                ['build', 'verify', 'consume'].map((phase) => ({ phase, uin: '0', sequence })),
            );
        }));

    it.each(['signer', 'verifier'] as const)(
        'preserves a replacement active run on %s reentry',
        (phase) =>
            withFixture(async (f) => {
                f.activate();
                const first = {};
                const replacement = {};
                const input = options();

                const reenter = () => {
                    endReferenceSend(f.token, f.attempt, f.lease, first);
                    beginReferenceSend(f.token, f.attempt, f.lease, replacement);
                };

                if (phase === 'signer') {
                    input.buildReserved = vi.fn(() => {
                        reenter();
                        return Uint8Array.of(8);
                    });
                } else {
                    input.verifyRaw = vi.fn(() => {
                        reenter();
                        return true;
                    });
                }

                const pending = send(f, input, first);

                if (phase === 'verifier') {
                    await reached(f.wrote.promise, pending);
                    f.feed();
                }

                expect(await bounded(pending)).toEqual({
                    kind: 'failure',
                    code: 'borrowed-transaction-failed',
                    writeState: 'unknown',
                });
                expect(f.writes).toHaveLength(phase === 'signer' ? 0 : 1);
                expect(
                    assertReferenceSendIdentity(
                        f.token,
                        f.attempt,
                        f.lease,
                        replacement,
                        '0',
                        '123',
                    ),
                ).toBeUndefined();
                endReferenceSend(f.token, f.attempt, f.lease, replacement);
                const fresh = {};
                beginReferenceSend(f.token, f.attempt, f.lease, fresh);
                endReferenceSend(f.token, f.attempt, f.lease, fresh);
            }),
    );

    it('rechecks revocation after consume and before the lease returns success', () =>
        withFixture(async (f) => {
            f.activate();
            f.holdResult();
            const pending = send(f, options());
            await reached(f.wrote.promise, pending);
            f.feed();
            await reached(f.resultReady.promise, pending);
            expect(f.identities).toEqual(
                ['build', 'verify', 'consume'].map((phase) => ({ phase, uin: '0', sequence })),
            );
            revokeReferenceKey(f.token);
            f.releaseResult.resolve();
            expect(await bounded(pending)).toEqual({
                kind: 'failure',
                code: 'borrowed-transaction-failed',
                writeState: 'unknown',
            });
            expect(f.writes).toHaveLength(1);
        }));
});
