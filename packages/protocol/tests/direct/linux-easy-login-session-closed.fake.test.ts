import { createCipheriv, createECDH } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { KEY_EXCHANGE_COMMAND } from '../../src/direct/key-exchange-flow';
import {
    decodeKeyExchangeRequest,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
} from '../../src/direct/key-exchange-protobuf';
import { runLinuxEasyLoginSession } from '../../src/direct/linux-easy-login-session';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawSessionBroker, type RawSessionLease } from '../../src/direct/raw-session-broker';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
} from '../../src/direct/sso12-packet-client';

// Synthetic crypto and local objects only; no network or peer authentication is implied.
const UIN = '123456';
const ZERO = new Uint8Array(16);
const KEY = Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i);
const TICKET = Uint8Array.from({ length: 24 }, (_, i) => 0x60 + i);
type Options = Parameters<typeof runLinuxEasyLoginSession>[1];

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>, ms = 800): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('fixture watchdog')), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function eventTurns(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function peer(scalar: number) {
    const ecdh = createECDH('prime256v1');
    const secret = Buffer.alloc(32);
    secret[31] = scalar;
    ecdh.setPrivateKey(secret);
    return ecdh;
}

function seal(plain: Uint8Array, key: Uint8Array): Buffer {
    const nonce = Buffer.alloc(12, 0x42);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function word(value: number): Buffer {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value >>> 0);
    return bytes;
}

const field = (bytes: Uint8Array): Buffer => Buffer.concat([word(bytes.length + 4), bytes]);

function requestBody(frame: Uint8Array): Uint8Array {
    const bytes = Buffer.from(frame);
    const end = 14 + bytes.readUInt32BE(14);
    const sso = Buffer.from(qqTeaDecrypt(bytes.subarray(end), ZERO));
    const headerLength = sso.readUInt32BE(0);
    const bodyLength = sso.readUInt32BE(headerLength);
    return sso.subarray(headerLength + 4, headerLength + bodyLength);
}

function response(sequence: number, body: Uint8Array): Uint8Array {
    const header = Buffer.concat([
        word(sequence),
        word(0),
        field(Buffer.alloc(0)),
        field(Buffer.from(KEY_EXCHANGE_COMMAND)),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    const frame = Buffer.concat([
        word(0),
        word(12),
        Buffer.of(2, 0),
        field(Buffer.from(UIN)),
        Buffer.from(qqTeaEncrypt(Buffer.concat([field(header), field(body)]), ZERO)),
    ]);
    frame.writeUInt32BE(frame.length);
    return Uint8Array.from(frame);
}

class FakeClient implements Sso12RawClient {
    readonly whenClosed = new Promise<Sso12CloseReason>(() => {});
    readonly close = vi.fn();
    readonly completed = deferred<void>();
    calls = 0;
    frames = 0;
    consumes = 0;

    async transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        this.calls++;

        try {
            if (this.calls !== 1) {
                throw new Error('unexpected EasyLogin');
            }

            const identity = { uin: UIN, sequence: 123 };
            const built = await raw.buildRequest(identity);
            this.frames++;
            const request = decodeKeyExchangeRequest(requestBody(built.frame));

            if (!request.publicKey) {
                throw new Error('missing fixture key');
            }

            const ephemeral = peer(2);
            const body = encodeKeyExchangeResponse({
                publicKey: ephemeral.getPublicKey(),
                secret: seal(
                    encodeKeyExchangeResponseSecret({
                        sessionKey: KEY,
                        sessionTicket: TICKET,
                        expiration: 300,
                    }),
                    ephemeral.computeSecret(request.publicKey),
                ),
            });
            const candidate = response(identity.sequence, body);

            if (!(await raw.verifyCandidate(candidate, built.context, identity))) {
                return { kind: 'failure', code: 'rejected', writeState: 'unknown' };
            }

            this.consumes++;
            const value = await raw.consumeCandidate(candidate, built.context, identity);
            return { kind: 'response', sequence: identity.sequence, value, writeState: 'written' };
        } catch {
            return { kind: 'failure', code: 'fixture-failed', writeState: 'unknown' };
        } finally {
            this.completed.resolve();
        }
    }
}

function options(): Options {
    return {
        uin: UIN,
        guid: Uint8Array.of(1, 2, 3, 4),
        version: 'fixture-version',
        subAppId: 1234,
        a2: Uint8Array.of(0x81, 0xfe),
        a1: Uint8Array.of(0x10, 0xff),
        nonce: Uint8Array.from({ length: 12 }, (_, i) => i),
        deviceName: 'fixture-device',
        deviceType: 'fixture-pc',
        appId: 42,
        appName: 'fixture-app',
        qua: 'fixture-qua',
        cookie: 'fixture-cookie',
        serverPublicKey: Uint8Array.from(peer(1).getPublicKey()),
        verifyKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
        timestamp: 1700000000,
        timeoutMs: 10000,
        buildReserved: () => Uint8Array.of(0xaa),
        verifyRaw: () => true,
        verifyServerResponse: () => true,
        acceptKeyExchange: () => true,
    };
}

function brokerFixture() {
    const client = new FakeClient();
    const lease = createRawSessionBroker(client, {
        trustedSuccessQuiescence: true,
        isUsable: () => true,
    }).acquire({ deadline: performance.now() + 30000 });
    return { client, lease, poison: vi.spyOn(lease, 'poison') };
}

// The contract deliberately says void/boolean. Cast only the individual malicious
// return values to exercise JavaScript callers violating those synchronous contracts.
function asyncBoolean(): () => boolean {
    return vi.fn(async () => {
        throw new Error('synthetic');
    }) as unknown as () => boolean;
}

async function withUnhandledCheck(action: (events: unknown[]) => Promise<void>): Promise<void> {
    const events: unknown[] = [];

    const listener = (reason: unknown): void => {
        events.push(reason);
    };

    process.on('unhandledRejection', listener);

    try {
        await action(events);
        await eventTurns();
        expect(events).toEqual([]);
    } finally {
        process.removeListener('unhandledRejection', listener);
    }
}

describe('Linux EasyLogin lease termination and unexpected promises', () => {
    it.each(['poison', 'close'] as const)(
        'settles after external broker %s during the pending signer',
        async (method) => {
            const { client, lease, poison } = brokerFixture();
            const gate = deferred<Uint8Array>();
            const entered = deferred<void>();
            const controller = new AbortController();
            const input = options();
            input.signal = controller.signal;

            input.buildReserved = () => {
                entered.resolve();
                return gate.promise;
            };

            const pending = runLinuxEasyLoginSession(lease, input);
            void pending.catch(() => {});

            try {
                await bounded(entered.promise);
                lease[method]();
                expect(await bounded(lease.whenClosed)).toBe('poisoned');
                const result = await bounded(pending);
                expect(result).toMatchObject({
                    kind: 'failure',
                    stage: 'key-exchange',
                    easyLoginWrite: 'not-started',
                });
                expect(client.calls).toBe(1);
                expect(client.frames).toBe(0);
                expect(client.close).toHaveBeenCalledTimes(1);
                // A coordinator may observe an already closed lease and poison again.
                expect(poison.mock.calls.length).toBeLessThanOrEqual(method === 'poison' ? 2 : 1);
                gate.resolve(Uint8Array.of(0xaa));
                await bounded(client.completed.promise);
                expect(client.frames).toBe(0);
                expect(client.consumes).toBe(0);
            } finally {
                controller.abort();
                gate.resolve(Uint8Array.of(0xaa));
                lease.close();
            }
        },
    );

    it('observes closure independently of a transport that never settles', async () => {
        const closed = deferred<'released' | 'poisoned'>();
        const entered = deferred<void>();
        const controller = new AbortController();
        const operation = deferred<Sso12RawResult<never>>();
        const transactRaw = vi.fn(() => {
            entered.resolve();
            return operation.promise;
        });
        const poison = vi.fn();
        const lease = {
            whenClosed: closed.promise,
            transactRaw,
            poison,
            release() {},
            close() {},
        } as unknown as RawSessionLease;
        const input = options();
        input.signal = controller.signal;
        const pending = runLinuxEasyLoginSession(lease, input);
        void pending.catch(() => {});

        try {
            await bounded(entered.promise);
            closed.resolve('poisoned');
            const result = await bounded(pending);
            expect(result).toMatchObject({
                kind: 'failure',
                stage: 'key-exchange',
                easyLoginWrite: 'not-started',
            });
            expect(transactRaw).toHaveBeenCalledTimes(1);
            expect(poison.mock.calls.length).toBeLessThanOrEqual(1);
        } finally {
            controller.abort();
            operation.resolve({ kind: 'failure', code: 'fixture-cleanup', writeState: 'unknown' });
        }
    });

    it.each(['verifyServerResponse', 'acceptKeyExchange'] as const)(
        'fails and observes a rejected async %s result',
        async (name) => {
            await withUnhandledCheck(async () => {
                const { client, lease, poison } = brokerFixture();
                const input = options();
                const callback = asyncBoolean();
                input[name] = callback;

                try {
                    const result = await bounded(runLinuxEasyLoginSession(lease, input));
                    expect(result).toMatchObject({
                        kind: 'failure',
                        easyLoginWrite: 'not-started',
                    });
                    expect(result).not.toHaveProperty('value');
                    expect(callback).toHaveBeenCalledOnce();
                    expect(client.calls).toBe(1);
                    expect(client.frames).toBe(1);
                    expect(poison).toHaveBeenCalledTimes(1);
                    expect(await bounded(lease.whenClosed)).toBe('poisoned');
                    expect(client.close).toHaveBeenCalledTimes(1);
                    await eventTurns();
                } finally {
                    lease.close();
                }
            });
        },
    );

    it('observes a rejected poison promise and reports uncertain rather than closure', async () => {
        await withUnhandledCheck(async () => {
            const closed = deferred<'released' | 'poisoned'>();
            const poison = vi.fn(() => Promise.reject(new Error('synthetic poison')));
            const transactRaw = vi.fn(() =>
                Promise.resolve({ kind: 'failure', code: 'synthetic', writeState: 'unknown' }),
            );
            const lease = {
                whenClosed: closed.promise,
                transactRaw,
                poison,
                release() {},
                close() {},
            } as unknown as RawSessionLease;
            const result = await bounded(runLinuxEasyLoginSession(lease, options()));
            expect(result).toMatchObject({
                kind: 'failure',
                stage: 'key-exchange',
                easyLoginWrite: 'not-started',
                poison: 'uncertain',
            });
            expect(transactRaw).toHaveBeenCalledTimes(1);
            expect(poison).toHaveBeenCalledTimes(1);
            let closedObserved = false;
            void closed.promise.then(() => {
                closedObserved = true;
            });
            await eventTurns();
            expect(closedObserved).toBe(false);
        });
    });

    it('observes a delayed transport rejection after synchronous abort', async () => {
        await withUnhandledCheck(async () => {
            const controller = new AbortController();
            const delayed = deferred<Sso12RawResult<never>>();
            const poison = vi.fn();
            const transactRaw = vi.fn(() => {
                controller.abort();
                return delayed.promise;
            });
            const lease = {
                whenClosed: new Promise<'released' | 'poisoned'>(() => {}),
                transactRaw,
                poison,
                release() {},
                close() {},
            } as unknown as RawSessionLease;
            const input = options();
            input.signal = controller.signal;
            const result = await bounded(runLinuxEasyLoginSession(lease, input));
            expect(result).toMatchObject({
                kind: 'failure',
                stage: 'key-exchange',
                easyLoginWrite: 'not-started',
            });
            expect(transactRaw).toHaveBeenCalledTimes(1);
            expect(poison).toHaveBeenCalledTimes(1);
            delayed.reject(new Error('synthetic delayed transport'));
            await eventTurns();
        });
    });
});
