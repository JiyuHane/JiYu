import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import { guardBorrowedTransport } from '../../src/direct/guard-raw-transaction';
import { SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import {
    referenceRegisterOnTransport,
    type SsoReferenceRegisterBorrowedOptions,
} from '../../src/direct/sso-reference-register-flow';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

const key = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

const word = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    return b;
};

const field = (b: Uint8Array): Buffer => Buffer.concat([word(b.length + 4), b]);

// Only framing is synthetic. Both response protobuf and QQ-TEA use production implementations.
function reply(sequence: number, message = 'register success'): Buffer {
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
    const payload = qqTeaEncrypt(inner, key);
    return Buffer.concat([
        word(17 + payload.length),
        word(12),
        Buffer.of(1, 0),
        field(Buffer.from('123')),
        payload,
    ]);
}

function inspectRequest(bytes: Uint8Array) {
    const frame = Buffer.from(bytes);
    const ticketLength = frame.readUInt32BE(9);
    const dummy = 9 + ticketLength;
    const accountStart = dummy + 1;
    const accountEnd = accountStart + frame.readUInt32BE(accountStart);
    const inner = Buffer.from(qqTeaDecrypt(frame.subarray(accountEnd), key));
    const a2Offset = 28;
    const commandOffset = a2Offset + inner.readUInt32BE(a2Offset);
    const commandEnd = commandOffset + inner.readUInt32BE(commandOffset);
    return {
        length: frame.readUInt32BE(0),
        actualLength: frame.length,
        protocol: frame.readUInt32BE(4),
        flag: frame[8],
        dummy: frame[dummy],
        ticket: Array.from(frame.subarray(13, dummy)),
        account: frame.subarray(accountStart + 4, accountEnd).toString(),
        sequence: inner.readUInt32BE(4),
        command: inner.subarray(commandOffset + 4, commandEnd).toString(),
    };
}

const config = (): SsoReferenceRegisterBorrowedOptions => ({
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
    registration: {
        uid: 'fixture-uid',
        version: 'build-v',
        deviceName: 'name',
        deviceType: 'type',
        vendorOs: 'os',
        random: 4,
    },
    timeoutMs: 2000,
    buildReserved: () => Uint8Array.of(8),
    verifyRaw: () => true,
});

type Mode = 'normal' | 'rejected' | 'failure' | 'abort' | 'never' | 'swap' | 'token' | 'sequence';
class Fake implements Sso12RawClient {
    readonly closed = deferred<Sso12CloseReason>();
    readonly whenClosed = this.closed.promise;
    readonly entered = deferred<void>();
    readonly late = deferred<void>();
    readonly close = vi.fn(() => this.closed.resolve({ kind: 'local', code: 'fixture' }));
    readonly requests: ReturnType<typeof inspectRequest>[] = [];
    readonly transportUin = '0';
    calls = 0;
    sequence = 0xfffffffe;
    mode: Mode = 'normal';

    async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        this.calls++;
        const sequence = this.sequence >>> 0;
        this.sequence = (sequence + 1) >>> 0;
        const identity = { uin: this.transportUin, sequence };
        const built = await options.buildRequest(identity);
        this.requests.push(inspectRequest(built.frame));
        this.entered.resolve(); // From here the fake models a write having occurred.

        if (this.mode === 'failure') {
            return { kind: 'failure', code: 'synthetic-write-failure', writeState: 'unknown' };
        }

        if (this.mode === 'abort' || this.mode === 'never') {
            await this.late.promise;
            return { kind: 'response', sequence, value: {} as T, writeState: 'written' };
        }

        const candidate = reply(
            sequence,
            this.mode === 'rejected' ? 'register rejected' : 'register success',
        );
        const ok = await options.verifyCandidate(candidate, built.context, identity);

        if (!ok) {
            return { kind: 'failure', code: 'rejected-candidate', writeState: 'unknown' };
        }

        let token: T;

        try {
            const consumed =
                this.mode === 'swap' ? reply(sequence, 'different message') : candidate;
            token = await options.consumeCandidate(consumed, built.context, identity);
        } catch (error) {
            if (this.mode !== 'swap') {
                throw error;
            }

            // Dishonest fake conceals the callback failure and returns a syntactically valid response.
            token = {} as T;
        }

        return {
            kind: 'response',
            sequence: this.mode === 'sequence' ? (sequence + 1) >>> 0 : sequence,
            value: this.mode === 'token' ? ({} as T) : token,
            writeState: 'written',
        };
    }
}

function acquire(fake: Fake) {
    const broker = createRawSessionBroker(fake, {
        trustedSuccessQuiescence: true,
        isUsable: () => true,
    });
    return { broker, lease: broker.acquire({ deadline: performance.now() + 5000 }) };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('reference registration through guard and broker (in-memory fake)', () => {
    it('uses one lease for two registrations, then owner closes after release', async () => {
        const fake = new Fake();
        const { broker, lease } = acquire(fake);
        const signed: Array<{ uin: string; uid: string; sequence: number; command: string }> = [];
        const verified: number[] = [];
        const options = config();

        options.buildReserved = ({ uin, uid, sequence, command }) => {
            signed.push({ uin, uid, sequence, command });
            return Uint8Array.of(8);
        };

        options.verifyRaw = ({ uin, sequence, command, requestFrame, responseFrame }) => {
            expect(uin).toBe('123');
            expect(command).toBe(SSO_INFO_SYNC_COMMAND);
            expect(inspectRequest(requestFrame).sequence).toBe(sequence);
            expect(responseFrame.length).toBeGreaterThan(17);
            verified.push(sequence);
            return true;
        };

        for (const sequence of [0xfffffffe, 0xffffffff]) {
            expect(await referenceRegisterOnTransport(lease, options)).toEqual({
                kind: 'response',
                sequence,
                value: 'success',
                writeState: 'written',
            });
            expect(fake.close).not.toHaveBeenCalled();
        }

        expect(fake.calls).toBe(2);
        expect(signed).toEqual(
            [0xfffffffe, 0xffffffff].map((sequence) => ({
                uin: '123',
                uid: 'fixture-uid',
                sequence,
                command: SSO_INFO_SYNC_COMMAND,
            })),
        );
        expect(verified).toEqual([0xfffffffe, 0xffffffff]);
        expect(fake.requests).toEqual(
            [0xfffffffe, 0xffffffff].map((sequence) => ({
                length: fake.requests.find((r) => r.sequence === sequence)!.actualLength,
                actualLength: fake.requests.find((r) => r.sequence === sequence)!.actualLength,
                protocol: 12,
                flag: 1,
                dummy: 0,
                ticket: [3, 4],
                account: '123',
                sequence,
                command: SSO_INFO_SYNC_COMMAND,
            })),
        );
        expect(() => broker.acquire({ deadline: performance.now() + 1000 })).toThrow();
        lease.release();
        expect(await lease.whenClosed).toBe('released');
        expect(fake.close).not.toHaveBeenCalled();
        fake.close();
        expect(fake.close).toHaveBeenCalledTimes(1);
        expect(await fake.whenClosed).toEqual({ kind: 'local', code: 'fixture' });
    });

    it('keeps a business rejection distinct from a transport failure', async () => {
        const fake = new Fake();
        fake.mode = 'rejected';
        const { lease } = acquire(fake);
        expect(await referenceRegisterOnTransport(lease, config())).toEqual({
            kind: 'response',
            sequence: 0xfffffffe,
            value: 'rejected',
            writeState: 'written',
        });
        expect(fake.close).not.toHaveBeenCalled();
        lease.release();
        expect(await lease.whenClosed).toBe('released');
        fake.close();
    });

    it.each(['failure', 'abort', 'never'] as const)(
        'poisons after fake write on %s with no retry or revival',
        async (mode) => {
            const unhandled: unknown[] = [];

            const listener = (reason: unknown) => {
                unhandled.push(reason);
            };

            process.on('unhandledRejection', listener);

            try {
                const fake = new Fake();
                fake.mode = mode;
                const { lease } = acquire(fake);
                const abort = new AbortController();
                const options = {
                    ...config(),
                    timeoutMs: mode === 'never' ? 80 : 2000,
                    signal: abort.signal,
                };
                const work = referenceRegisterOnTransport(lease, options);
                await fake.entered.promise;

                if (mode === 'abort') {
                    abort.abort();
                }

                expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
                expect(await lease.whenClosed).toBe('poisoned');
                expect(fake.close).toHaveBeenCalledTimes(1);

                if (mode === 'abort') {
                    fake.late.reject(new Error('late synthetic failure'));
                }

                if (mode === 'never') {
                    fake.late.resolve();
                }

                await nextTurn();
                expect(await referenceRegisterOnTransport(lease, config())).toMatchObject({
                    kind: 'failure',
                });
                expect(fake.calls).toBe(1);
                lease.poison();
                lease.close();
                expect(fake.close).toHaveBeenCalledTimes(1);
                expect(unhandled).toEqual([]);
            } finally {
                process.off('unhandledRejection', listener);
            }
        },
    );

    it.each(['swap', 'token', 'sequence'] as const)(
        'owner explicitly poisons after outer guard rejects %s',
        async (mode) => {
            const fake = new Fake();
            fake.mode = mode;
            const { lease } = acquire(fake);
            const result = await referenceRegisterOnTransport(lease, config());
            expect(result).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            // Broker saw a syntactically valid response; the outer guard's post-check is invisible to it.
            expect(fake.close).not.toHaveBeenCalled();

            if (result.kind === 'failure') {
                lease.poison();
            }

            expect(await lease.whenClosed).toBe('poisoned');
            expect(fake.close).toHaveBeenCalledTimes(1);
            expect(fake.calls).toBe(1);
        },
    );
});

describe('guard and lease staged-token cancellation boundary', () => {
    it.each(['build', 'consume'] as const)(
        'disposes exactly once when %s promise resolves before broker fence',
        async (phase) => {
            const events: string[] = [];
            const unhandled: unknown[] = [];

            const listener = (reason: unknown) => {
                unhandled.push(reason);
            };

            process.on('unhandledRejection', listener);

            try {
                const closed = deferred<Sso12CloseReason>();
                const abort = new AbortController();
                const identity = { uin: '0', sequence: 7 };
                let finished!: Promise<void>;
                const close = vi.fn(() => {
                    events.push('close');
                    closed.resolve({ kind: 'local', code: 'fixture' });
                });
                const client: Sso12RawClient = {
                    whenClosed: closed.promise,
                    close,
                    async transactRaw<C, T>(o: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                        try {
                            const built = await o.buildRequest(identity);
                            events.push('fake-build-received');
                            await o.verifyCandidate(Uint8Array.of(9), built.context, identity);
                            const token = await o.consumeCandidate(
                                Uint8Array.of(9),
                                built.context,
                                identity,
                            );
                            events.push('fake-token-received');
                            return {
                                kind: 'response',
                                sequence: 7,
                                value: token,
                                writeState: 'written',
                            };
                        } catch {
                            events.push('fake-callback-rejected');
                            return { kind: 'failure', code: 'callback', writeState: 'unknown' };
                        }
                    },
                };
                const broker = createRawSessionBroker(client, {
                    trustedSuccessQuiescence: true,
                    isUsable: () => true,
                });
                const lease = broker.acquire({ deadline: performance.now() + 3000 });
                const shim: Sso12RawTransport = {
                    transactRaw<C, T>(o: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                        return lease.transactRaw({
                            ...o,
                            buildRequest: (id) => {
                                const p = Promise.resolve(o.buildRequest(id));

                                if (phase === 'build') {
                                    void p.then(() => {
                                        events.push('guard-build-staged');
                                        abort.abort();
                                    });
                                }

                                return p;
                            },
                            consumeCandidate: (bytes, context, id) => {
                                const p = Promise.resolve(o.consumeCandidate(bytes, context, id));

                                if (phase === 'consume') {
                                    void p.then(() => {
                                        events.push('guard-result-staged');
                                        abort.abort();
                                    });
                                }

                                return p;
                            },
                        });
                    },
                };
                const disposeContext = vi.fn(() => events.push('dispose-context'));
                const disposeResult = vi.fn(() => events.push('dispose-result'));
                const guarded = guardBorrowedTransport<{ secret: number }, { secret: number }>(
                    shim,
                    { disposeContext, disposeResult },
                );
                const pending = guarded({
                    signal: abort.signal,
                    timeoutMs: 2000,
                    buildRequest: () => {
                        events.push('build');
                        return { frame: Uint8Array.of(1), context: { secret: 1 } };
                    },
                    verifyCandidate: () => {
                        events.push('verify');
                        return true;
                    },
                    consumeCandidate: () => {
                        events.push('consume');
                        return { secret: 2 };
                    },
                });
                finished = pending.then(() => undefined);
                expect(await pending).toMatchObject({ kind: 'failure', writeState: 'unknown' });
                await finished;
                await nextTurn();
                const staged = phase === 'build' ? 'guard-build-staged' : 'guard-result-staged';
                expect(events.indexOf(staged)).toBeGreaterThan(events.indexOf(phase));
                expect(events.indexOf('close')).toBeGreaterThan(events.indexOf(staged));
                expect(events.indexOf('fake-callback-rejected')).toBeGreaterThan(
                    events.indexOf(staged),
                );
                expect(events).not.toContain('fake-token-received');

                if (phase === 'build') {
                    expect(events).not.toContain('fake-build-received');
                } else {
                    expect(events.indexOf('fake-build-received')).toBeLessThan(
                        events.indexOf('consume'),
                    );
                }

                expect(disposeContext).toHaveBeenCalledTimes(1);
                expect(disposeResult).toHaveBeenCalledTimes(phase === 'consume' ? 1 : 0);
                expect(close).toHaveBeenCalledTimes(1);
                expect(await lease.whenClosed).toBe('poisoned');
                expect(unhandled).toEqual([]);
            } finally {
                process.off('unhandledRejection', listener);
            }
        },
    );
});
