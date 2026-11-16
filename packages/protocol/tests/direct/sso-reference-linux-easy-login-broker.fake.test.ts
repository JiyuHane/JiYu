import { createCipheriv } from 'node:crypto';
import type { NTLoginForwardRequest } from '@snowluma/proto-defs/direct-login';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import type { RawTransactionDisposers } from '../../src/direct/guard-raw-transaction';
import { qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import { referenceLinuxEasyLoginOnTransport } from '../../src/direct/sso-reference-linux-easy-login-flow';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';

const observed = vi.hoisted(() => ({
    body: undefined as Uint8Array | undefined,
    before: undefined as Uint8Array | undefined,
    disposeCalls: 0,
}));

// Observe the real producer's return, not the guard's opaque transport token.
vi.mock('../../src/direct/guard-raw-transaction', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/direct/guard-raw-transaction')>();
    return {
        ...actual,
        guardBorrowedTransport<C, T>(
            transport: Sso12RawTransport,
            disposers: RawTransactionDisposers<C, T> = {},
        ) {
            const guarded = actual.guardBorrowedTransport<C, T>(transport, {
                ...disposers,
                disposeResult: (value) => {
                    observed.disposeCalls++;
                    disposers.disposeResult?.(value);
                },
            });
            return (options: Sso12RawOptions<C, T>) =>
                guarded({
                    ...options,
                    consumeCandidate: (...args) => {
                        const result = options.consumeCandidate(...args);

                        if (result && typeof result === 'object' && 'body' in result) {
                            const body = result.body;

                            if (body instanceof Uint8Array) {
                                observed.body = body;
                                observed.before = Uint8Array.from(body);
                            }
                        }

                        return result;
                    },
                });
        },
    };
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const word = (value: number): Buffer => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value >>> 0);
    return bytes;
};

const field = (value: Uint8Array): Buffer => Buffer.concat([word(value.length + 4), value]);
const UIN = '123456';
const SEQUENCE = 123;
const COMMAND = 'trpc.login.ecdh.EcdhService.SsoNTLoginEasyLogin';

// Synthetic response framing mirrors the existing EasyLogin fixture; production
// protobuf and QQ-TEA encoders are used without importing that test module.
function response(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array): Uint8Array {
    const cipher = createCipheriv('aes-128-gcm', key, nonce);
    const encrypted = Buffer.concat([
        nonce,
        cipher.update(plain),
        cipher.final(),
        cipher.getAuthTag(),
    ]);
    const forward = protobuf_encode<NTLoginForwardRequest>({
        sessionTicket: Uint8Array.of(0x42),
        buffer: encrypted,
        type: 1,
    });
    const header = Buffer.concat([
        word(SEQUENCE),
        word(0),
        field(Buffer.alloc(0)),
        field(Buffer.from(COMMAND)),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    const inner = Buffer.concat([field(header), field(forward)]);
    const frame = Buffer.concat([
        word(0),
        word(12),
        Buffer.of(2, 0),
        field(Buffer.from(UIN)),
        qqTeaEncrypt(inner, new Uint8Array(16)),
    ]);
    frame.writeUInt32BE(frame.length);
    return Uint8Array.from(frame);
}

describe('Linux EasyLogin broker staged result', () => {
    it('wipes the producer-owned body when session abort wins the broker postcheck', async () => {
        observed.body = undefined;
        observed.before = undefined;
        observed.disposeCalls = 0;
        const events: string[] = [];
        const session = new AbortController();
        const operation = new AbortController();
        const closed = deferred<Sso12CloseReason>();
        const fakeFinished = deferred<void>();
        const brokerSettled = deferred<void>();
        const releaseGuard = deferred<void>();
        const key = Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i);
        const nonce = Uint8Array.from({ length: 12 }, (_, i) => i);
        const responseNonce = Uint8Array.from({ length: 12 }, (_, i) => 0x10 + i);
        const plain = Uint8Array.from(Buffer.from('0a04220208001204ff00c328', 'hex'));
        const ticket = Uint8Array.of(0, 0x91, 0xff, 0x81);
        const a1 = Uint8Array.of(0x10, 0, 0xff, 0x20);
        const a2 = Uint8Array.of(0x81, 0, 0xfe);
        const guid = Uint8Array.of(1, 2, 3, 4);
        const reserved = Uint8Array.of(0xaa, 0, 0xfe);
        const candidate = response(key, responseNonce, plain);
        const inputs = [
            key,
            nonce,
            responseNonce,
            plain,
            ticket,
            a1,
            a2,
            guid,
            reserved,
            candidate,
        ];
        const originals = inputs.map((bytes) => Uint8Array.from(bytes));
        const close = vi.fn(() => {
            events.push('close');
            closed.resolve({ kind: 'local', code: 'fixture' });
        });
        const client: Sso12RawClient = {
            whenClosed: closed.promise,
            close,
            async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                const identity = { uin: UIN, sequence: SEQUENCE };

                try {
                    const built = await options.buildRequest(identity);
                    events.push('built');
                    const accepted = await options.verifyCandidate(
                        candidate,
                        built.context,
                        identity,
                    );

                    if (!accepted) {
                        return { kind: 'failure', code: 'rejected', writeState: 'unknown' };
                    }

                    events.push('verified');
                    const value = await options.consumeCandidate(
                        candidate,
                        built.context,
                        identity,
                    );
                    events.push('fake-token-received');
                    return { kind: 'response', sequence: SEQUENCE, value, writeState: 'written' };
                } catch {
                    events.push('fake-callback-rejected');
                    return { kind: 'failure', code: 'callback', writeState: 'unknown' };
                } finally {
                    fakeFinished.resolve();
                }
            },
        };
        const broker = createRawSessionBroker(client, {
            trustedSuccessQuiescence: true,
            isUsable: () => true,
        });
        const lease = broker.acquire({
            deadline: performance.now() + 5000,
            signal: session.signal,
        });
        const shim: Sso12RawTransport = {
            transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                return lease
                    .transactRaw({
                        ...options,
                        consumeCandidate: (bytes, context, identity) => {
                            const staged = Promise.resolve(
                                options.consumeCandidate(bytes, context, identity),
                            );
                            void staged.then(
                                () => {
                                    events.push('guard-token-staged');
                                    session.abort();
                                },
                                () => {},
                            );
                            return staged;
                        },
                    })
                    .then(async (result) => {
                        brokerSettled.resolve();
                        // Keep the guard awaiting the transport until after the outer
                        // flow clears its own staged allocation on operation abort.
                        await releaseGuard.promise;
                        return result;
                    });
            },
        };

        try {
            const pending = referenceLinuxEasyLoginOnTransport(shim, {
                uin: UIN,
                sessionKey: key,
                sessionTicket: ticket,
                a1,
                a2,
                nonce,
                guid,
                version: 'synthetic-version',
                subAppId: 1234,
                deviceName: 'fixture-device',
                deviceType: 'fixture-pc',
                appId: 42,
                appName: 'fixture-app',
                qua: 'fixture-qua',
                cookie: 'fixture-cookie',
                timeoutMs: 4000,
                signal: operation.signal,
                buildReserved: () => reserved,
                verifyRaw: () => true,
            });
            await fakeFinished.promise;
            await brokerSettled.promise;
            expect(events).toContain('verified');
            expect(events.indexOf('guard-token-staged')).toBeGreaterThan(
                events.indexOf('verified'),
            );
            expect(events.indexOf('close')).toBeGreaterThan(events.indexOf('guard-token-staged'));
            expect(events).toContain('fake-callback-rejected');
            expect(events).not.toContain('fake-token-received');
            expect(observed.body).toBeInstanceOf(Uint8Array);
            expect(observed.before).toEqual(Uint8Array.of(0xff, 0, 0xc3, 0x28));
            expect(observed.body).toEqual(observed.before);
            expect(observed.disposeCalls).toBe(0);
            expect(await lease.whenClosed).toBe('poisoned');
            expect(close).toHaveBeenCalledTimes(1);

            operation.abort();
            const result = await pending.catch(() => ({ kind: 'rejected' as const }));
            expect(result.kind).not.toBe('response');
            expect(observed.disposeCalls).toBe(0);
            expect(observed.body).toEqual(new Uint8Array(4));
            inputs.forEach((bytes, index) => expect(bytes).toEqual(originals[index]));
        } finally {
            operation.abort();
            session.abort();
            releaseGuard.resolve();
        }
    });
});
