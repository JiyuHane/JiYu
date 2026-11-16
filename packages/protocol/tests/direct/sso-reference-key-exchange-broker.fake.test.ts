import { createCipheriv, createECDH } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { RawTransactionDisposers } from '../../src/direct/guard-raw-transaction';
import { KEY_EXCHANGE_COMMAND } from '../../src/direct/key-exchange-flow';
import {
    decodeKeyExchangeRequest,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
} from '../../src/direct/key-exchange-protobuf';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import { referenceKeyExchangeOnTransport } from '../../src/direct/sso-reference-key-exchange-flow';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';

const observed = vi.hoisted(() => ({
    key: undefined as Uint8Array | undefined,
    ticket: undefined as Uint8Array | undefined,
    keyBefore: undefined as Uint8Array | undefined,
    ticketBefore: undefined as Uint8Array | undefined,
    disposeCalls: 0,
    onDispose: undefined as (() => void) | undefined,
}));

// Wrap the real guard and observe its producer result, not its opaque token.
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
                    observed.onDispose?.();
                },
            });
            return (options: Sso12RawOptions<C, T>) =>
                guarded({
                    ...options,
                    consumeCandidate: (...args) => {
                        const result = options.consumeCandidate(...args);

                        if (
                            result &&
                            typeof result === 'object' &&
                            'sessionKey' in result &&
                            'sessionTicket' in result &&
                            result.sessionKey instanceof Uint8Array &&
                            result.sessionTicket instanceof Uint8Array
                        ) {
                            observed.key = result.sessionKey;
                            observed.ticket = result.sessionTicket;
                            observed.keyBefore = Uint8Array.from(result.sessionKey);
                            observed.ticketBefore = Uint8Array.from(result.sessionTicket);
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

const UIN = '123456';
const SEQUENCE = 123;
const zeroKey = new Uint8Array(16);
const expectedKey = Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i);
const expectedTicket = Uint8Array.from({ length: 24 }, (_, i) => 0x60 + i);

const word = (value: number): Buffer => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value >>> 0);
    return bytes;
};

const field = (value: Uint8Array): Buffer => Buffer.concat([word(value.length + 4), value]);

function peer(scalar: number) {
    const ecdh = createECDH('prime256v1');
    const key = Buffer.alloc(32);
    key[31] = scalar;
    ecdh.setPrivateKey(key);
    return ecdh;
}

// Extract the production request body from the synthetic service frame.
function requestBody(frameBytes: Uint8Array): Uint8Array {
    const frame = Buffer.from(frameBytes);
    expect(frame.readUInt32BE(0)).toBe(frame.length);
    expect(frame.readUInt32BE(4)).toBe(12);
    const accountEnd = 14 + frame.readUInt32BE(14);
    expect(frame.subarray(18, accountEnd).toString()).toBe(UIN);
    const sso = Buffer.from(qqTeaDecrypt(frame.subarray(accountEnd), zeroKey));
    let offset = 4 + 4 + 4 + 4 + 12;

    const take = (width: 2 | 4 = 4): Buffer => {
        const size = width === 2 ? sso.readUInt16BE(offset) : sso.readUInt32BE(offset);
        expect(size).toBeGreaterThanOrEqual(width);
        expect(offset + size).toBeLessThanOrEqual(sso.length);
        const value = sso.subarray(offset + width, offset + size);
        offset += size;
        return value;
    };

    take();
    expect(take().toString()).toBe(KEY_EXCHANGE_COMMAND);
    take();
    take();
    take();
    take(2);
    take();
    expect(offset).toBe(sso.readUInt32BE(0));
    const body = take();
    expect(offset).toBe(sso.length);
    return body;
}

// Synthetic ECDH peer and in-memory response only; this is not authentication.
function response(request: Uint8Array): Uint8Array {
    const decoded = decodeKeyExchangeRequest(request);
    const responsePeer = peer(2);
    const shared = responsePeer.computeSecret(decoded.publicKey!);
    const secret = encodeKeyExchangeResponseSecret({
        sessionKey: expectedKey,
        sessionTicket: expectedTicket,
        expiration: 300,
    });
    const nonce = Buffer.alloc(12, 0x42);
    const cipher = createCipheriv('aes-256-gcm', shared, nonce);
    const encrypted = Buffer.concat([
        nonce,
        cipher.update(secret),
        cipher.final(),
        cipher.getAuthTag(),
    ]);
    const body = encodeKeyExchangeResponse({
        publicKey: responsePeer.getPublicKey(),
        secret: encrypted,
    });
    const header = Buffer.concat([
        word(SEQUENCE),
        word(0),
        field(Buffer.alloc(0)),
        field(Buffer.from(KEY_EXCHANGE_COMMAND)),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    const inner = Buffer.concat([field(header), field(body)]);
    const frame = Buffer.concat([
        word(0),
        word(12),
        Buffer.of(2, 0),
        field(Buffer.from(UIN)),
        qqTeaEncrypt(inner, zeroKey),
    ]);
    frame.writeUInt32BE(frame.length);
    return Uint8Array.from(frame);
}

function fixture() {
    const closed = deferred<Sso12CloseReason>();
    const fakeFinished = deferred<void>();
    const events: string[] = [];
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
                const candidate = response(requestBody(built.frame));
                const accepted = await options.verifyCandidate(candidate, built.context, identity);

                if (!accepted) {
                    return { kind: 'failure', code: 'rejected', writeState: 'unknown' };
                }

                events.push('verified');
                const value = await options.consumeCandidate(candidate, built.context, identity);
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
    const session = new AbortController();
    const operation = new AbortController();
    const lease = broker.acquire({ deadline: performance.now() + 5000, signal: session.signal });
    const inputs = {
        guid: Uint8Array.of(1, 2, 3, 4),
        a2: Uint8Array.of(0, 0xff, 0x80, 3),
        serverPublicKey: Uint8Array.from(peer(1).getPublicKey()),
        verifyKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
        reserved: Uint8Array.of(0xaa, 0, 0xfe),
    };
    const options: Parameters<typeof referenceKeyExchangeOnTransport>[1] = {
        uin: UIN,
        guid: inputs.guid,
        a2: inputs.a2,
        version: 'synthetic-version',
        subAppId: 1234,
        serverPublicKey: inputs.serverPublicKey,
        verifyKey: inputs.verifyKey,
        timestamp: 1700000000,
        timeoutMs: 4000,
        signal: operation.signal,
        buildReserved: () => inputs.reserved,
        verifyRaw: () => true,
        verifyServerResponse: () => true,
    };
    return { close, events, fakeFinished, inputs, lease, operation, options, session };
}

function resetObserved(): void {
    observed.key = undefined;
    observed.ticket = undefined;
    observed.keyBefore = undefined;
    observed.ticketBefore = undefined;
    observed.disposeCalls = 0;
    observed.onDispose = undefined;
}

describe('key exchange broker staged result with synthetic transport', () => {
    it('wipes both outputs on outer abort before a delayed guard disposer runs', async () => {
        resetObserved();
        const f = fixture();
        const originals = Object.values(f.inputs).map((bytes) => Uint8Array.from(bytes));
        const brokerSettled = deferred<void>();
        const releaseGuard = deferred<void>();
        const disposed = deferred<void>();
        observed.onDispose = () => disposed.resolve();
        const shim: Sso12RawTransport = {
            transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                return f.lease
                    .transactRaw({
                        ...options,
                        consumeCandidate: (bytes, context, identity) => {
                            const staged = Promise.resolve(
                                options.consumeCandidate(bytes, context, identity),
                            );
                            void staged.then(
                                () => {
                                    f.events.push('guard-token-staged');
                                    f.session.abort();
                                },
                                () => {},
                            );
                            return staged;
                        },
                    })
                    .then(async (result) => {
                        brokerSettled.resolve();
                        await releaseGuard.promise;
                        return result;
                    });
            },
        };

        try {
            const pending = referenceKeyExchangeOnTransport(shim, f.options);
            await f.fakeFinished.promise;
            await brokerSettled.promise;
            expect(f.events).toContain('verified');
            expect(f.events.indexOf('guard-token-staged')).toBeGreaterThan(
                f.events.indexOf('verified'),
            );
            expect(f.events.indexOf('close')).toBeGreaterThan(
                f.events.indexOf('guard-token-staged'),
            );
            expect(f.events).toContain('fake-callback-rejected');
            expect(f.events).not.toContain('fake-token-received');
            expect(observed.key).toBeInstanceOf(Uint8Array);
            expect(observed.ticket).toBeInstanceOf(Uint8Array);
            expect(observed.keyBefore).toEqual(expectedKey);
            expect(observed.ticketBefore).toEqual(expectedTicket);
            expect(observed.key).toEqual(expectedKey);
            expect(observed.ticket).toEqual(expectedTicket);
            expect(observed.disposeCalls).toBe(0);
            expect(await f.lease.whenClosed).toBe('poisoned');
            expect(f.close).toHaveBeenCalledTimes(1);

            f.operation.abort();
            const result = await pending.catch(() => ({ kind: 'rejected' as const }));
            expect(result.kind).not.toBe('response');
            expect(observed.disposeCalls).toBe(0);
            expect(observed.key).toEqual(new Uint8Array(expectedKey.length));
            expect(observed.ticket).toEqual(new Uint8Array(expectedTicket.length));
            Object.values(f.inputs).forEach((bytes, index) =>
                expect(bytes).toEqual(originals[index]),
            );
        } finally {
            f.operation.abort();
            f.session.abort();
            releaseGuard.resolve();

            if (f.events.includes('guard-token-staged')) {
                await disposed.promise;
            }

            observed.onDispose = undefined;
        }
    });

    it('transfers distinct, retained outputs to the caller on success', async () => {
        resetObserved();
        const f = fixture();
        const originals = Object.values(f.inputs).map((bytes) => Uint8Array.from(bytes));

        try {
            const result = await referenceKeyExchangeOnTransport(f.lease, f.options);
            expect(result.kind).toBe('response');

            if (result.kind !== 'response') {
                return;
            }

            expect(result.sequence).toBe(SEQUENCE);
            expect(result.value.expiration).toBe(300);
            expect(result.value.sessionKey).toBe(observed.key);
            expect(result.value.sessionTicket).toBe(observed.ticket);
            expect(result.value.sessionKey).toEqual(expectedKey);
            expect(result.value.sessionTicket).toEqual(expectedTicket);
            expect(result.value.sessionKey.buffer).not.toBe(result.value.sessionTicket.buffer);

            for (const input of Object.values(f.inputs)) {
                expect(result.value.sessionKey.buffer).not.toBe(input.buffer);
                expect(result.value.sessionTicket.buffer).not.toBe(input.buffer);
            }

            expect(observed.disposeCalls).toBe(0);
            expect(f.close).not.toHaveBeenCalled();
            Object.values(f.inputs).forEach((bytes, index) =>
                expect(bytes).toEqual(originals[index]),
            );
            result.value.sessionKey.fill(0x7b);
            expect(result.value.sessionTicket).toEqual(expectedTicket);
            expect(result.value.sessionKey).toEqual(new Uint8Array(expectedKey.length).fill(0x7b));
        } finally {
            f.lease.release();
        }
    });
});
