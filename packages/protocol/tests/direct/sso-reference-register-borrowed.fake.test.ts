import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import {
    referenceRegister,
    referenceRegisterOnTransport,
    type SsoReferenceRegisterOptions,
    type SsoReferenceRegisterBorrowedOptions,
} from '../../src/direct/sso-reference-register-flow';
import type {
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';

const key = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const seq = 0xf0000001;

const word = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    return b;
};

const field = (b: Uint8Array): Buffer => Buffer.concat([word(b.length + 4), b]);

function reply(
    uin = '123',
    sequence = seq,
    command = SSO_INFO_SYNC_COMMAND,
    message = 'register success',
): Buffer {
    const body = protobuf_encode<SsoRegisterResponse>({
        register: { message },
    });
    const inner = Buffer.concat([
        field(
            Buffer.concat([
                word(sequence),
                word(0),
                field(Buffer.alloc(0)),
                field(Buffer.from(command)),
                field(Buffer.alloc(0)),
                word(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(body),
    ]);
    const payload = qqTeaEncrypt(inner, key);
    const account = Buffer.from(uin);
    return Buffer.concat([
        word(14 + account.length + payload.length),
        word(12),
        Buffer.of(1, 0),
        field(account),
        payload,
    ]);
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
    timeoutMs: 1000,
    buildReserved: () => Uint8Array.of(8),
    verifyRaw: () => true,
});

class Fake implements Sso12RawTransport {
    calls = 0;
    close = vi.fn();
    frame?: Uint8Array;
    candidate = reply();
    mode:
        | 'normal'
        | 'reject'
        | 'swap'
        | 'identity'
        | 'identityUin'
        | 'context'
        | 'skip'
        | 'value'
        | 'sequence'
        | 'timeout'
        | 'abort'
        | 'duplicate' = 'normal';
    async transactRaw<C, T>(o: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        this.calls++;
        const identity = { uin: '0', sequence: seq };

        if (this.mode === 'skip') {
            return {
                kind: 'response',
                sequence: seq,
                value: 'success' as T,
                writeState: 'written',
            };
        }

        try {
            const built = await o.buildRequest(identity);
            this.frame = Uint8Array.from(built.frame);

            if (this.mode === 'duplicate') {
                await o.buildRequest(identity);
            }

            if (this.mode === 'timeout' || this.mode === 'abort') {
                return {
                    kind: 'failure',
                    code: this.mode === 'timeout' ? 'raw-timeout' : 'raw-cancelled',
                    writeState: 'not-written',
                };
            }

            const context = this.mode === 'context' ? (null as C) : built.context;
            const other =
                this.mode === 'identity'
                    ? { ...identity, sequence: 4 }
                    : this.mode === 'identityUin'
                      ? { ...identity, uin: '123' }
                      : identity;
            const ok = await o.verifyCandidate(Uint8Array.from(this.candidate), context, other);

            if (!ok) {
                return { kind: 'failure', code: 'raw-rejected', writeState: 'unknown' };
            }

            const frame = this.mode === 'swap' ? reply('456') : this.candidate;
            const value = await o.consumeCandidate(Uint8Array.from(frame), built.context, identity);
            return {
                kind: 'response',
                sequence: this.mode === 'sequence' ? 3 : seq,
                value: this.mode === 'value' ? ('success' as T) : value,
                writeState: 'written',
            };
        } catch {
            return { kind: 'failure', code: 'raw-callback-failed', writeState: 'unknown' };
        }
    }
}

describe('borrowed reference registration (pure memory)', () => {
    it('legacy entry converts a synchronous clock exception into a rejected promise', async () => {
        const failure = new Error('clock fixture');
        const original = Object.getOwnPropertyDescriptor(performance, 'now');
        let pending: Promise<unknown> | undefined;

        try {
            Object.defineProperty(performance, 'now', {
                configurable: true,
                value: () => {
                    throw failure;
                },
            });
            pending = referenceRegister({} as SsoReferenceRegisterOptions);
        } finally {
            if (original) {
                Object.defineProperty(performance, 'now', original);
            } else {
                delete (performance as { now?: typeof performance.now }).now;
            }
        }

        expect(pending).toBeInstanceOf(Promise);
        await expect(pending).rejects.toBe(failure);
    });
    it('sanitizes a throwing transport method getter', async () => {
        const transport = Object.defineProperty({}, 'transactRaw', {
            get() {
                throw new Error('transport-secret');
            },
        }) as Sso12RawTransport;

        const result = await referenceRegisterOnTransport(transport, config()).then(
            () => undefined,
            (error: unknown) => error,
        );
        expect(result).toBeInstanceOf(TypeError);
        expect((result as Error).message).toBe('invalid borrowed transport');
        expect((result as Error).cause).toBeUndefined();
        expect(String(result)).not.toContain('transport-secret');
    });
    it('reads the transport method once and preserves its receiver', async () => {
        let reads = 0;
        let receiver: unknown;
        const transport = Object.defineProperty({}, 'transactRaw', {
            get() {
                reads++;

                if (reads !== 1) {
                    throw new Error('second read');
                }

                return function (this: unknown) {
                    receiver = this;
                    return Promise.resolve({
                        kind: 'failure',
                        code: 'fixture',
                        writeState: 'not-written',
                    });
                };
            },
        }) as Sso12RawTransport;

        expect(await referenceRegisterOnTransport(transport, config())).toEqual({
            kind: 'failure',
            code: 'borrowed-transaction-failed',
            writeState: 'not-written',
        });
        expect(reads).toBe(1);
        expect(receiver).toBe(transport);
    });
    it('preserves this on ordinary class transport methods', async () => {
        const transport = new Fake();
        expect(await referenceRegisterOnTransport(transport, config())).toMatchObject({
            kind: 'response',
            value: 'success',
            sequence: seq,
        });
        expect(transport.calls).toBe(1);
    });
    it('uses login account and transport sequence; wipes callback copies and does not close', async () => {
        const fake = new Fake();
        const options = config();
        let signing!: Uint8Array;
        let verifying!: Uint8Array;
        let request!: Uint8Array;

        options.buildReserved = (input) => {
            expect(input).toMatchObject({
                uin: '123',
                uid: 'fixture-uid',
                sequence: seq,
                command: SSO_INFO_SYNC_COMMAND,
            });
            signing = input.body;
            return input.body;
        };

        options.verifyRaw = (input) => {
            expect(input).toMatchObject({
                uin: '123',
                sequence: seq,
                command: SSO_INFO_SYNC_COMMAND,
            });
            verifying = input.responseFrame;
            request = input.requestFrame;
            input.responseFrame.fill(0);
            return true;
        };

        expect(await referenceRegisterOnTransport(fake, options)).toEqual({
            kind: 'response',
            sequence: seq,
            value: 'success',
            writeState: 'written',
        });
        const frame = Buffer.from(fake.frame!);
        const ticketLength = frame.readUInt32BE(9);
        const start = 10 + ticketLength;
        const end = start + frame.readUInt32BE(start);
        expect(frame.subarray(start + 4, end).toString()).toBe('123');
        const inner = qqTeaDecrypt(frame.subarray(end), key);
        expect(Buffer.from(inner).readUInt32BE(4)).toBe(seq);
        expect([signing, verifying, request].every((b) => b.every((v) => v === 0))).toBe(true);
        expect(options.login.tickets.d2Key).toEqual(key);
        expect(fake.close).not.toHaveBeenCalled();
        expect(fake.calls).toBe(1);
    });
    it.each([
        'skip',
        'swap',
        'identity',
        'identityUin',
        'context',
        'value',
        'sequence',
        'duplicate',
    ] as const)('rejects malicious transport mode %s', async (mode) => {
        const fake = new Fake();
        fake.mode = mode;
        expect(await referenceRegisterOnTransport(fake, config())).toMatchObject({
            kind: 'failure',
            writeState: 'unknown',
        });
        expect(fake.close).not.toHaveBeenCalled();
        expect(fake.calls).toBe(1);
    });
    it.each([
        ['account', reply('456')],
        ['sequence', reply('123', 9)],
        ['command', reply('123', seq, 'wrong')],
    ] as const)('rejects response %s mismatch', async (_, candidate) => {
        const fake = new Fake();
        fake.candidate = candidate;
        expect(await referenceRegisterOnTransport(fake, config())).toMatchObject({
            kind: 'failure',
            writeState: 'unknown',
        });
    });
    it('stops rejected verifier before consume', async () => {
        const fake = new Fake();
        const options = config();
        options.verifyRaw = vi.fn(() => false);
        expect(await referenceRegisterOnTransport(fake, options)).toMatchObject({
            kind: 'failure',
            code: 'borrowed-transaction-failed',
            writeState: 'unknown',
        });
        expect(options.verifyRaw).toHaveBeenCalledOnce();
    });
    it.each(['timeout', 'abort'] as const)(
        'propagates transport %s without retry or close',
        async (mode) => {
            const fake = new Fake();
            fake.mode = mode;
            expect(await referenceRegisterOnTransport(fake, config())).toMatchObject({
                kind: 'failure',
                code: 'borrowed-transaction-failed',
                writeState: 'not-written',
            });
            expect(fake.calls).toBe(1);
            expect(fake.close).not.toHaveBeenCalled();
        },
    );
    it('rejects bad input and injected sequence/socket before transport', async () => {
        const fake = new Fake();
        await expect(
            referenceRegisterOnTransport(fake, {
                ...config(),
                sequence: 1,
            } as SsoReferenceRegisterBorrowedOptions),
        ).rejects.toThrow();
        await expect(
            referenceRegisterOnTransport(fake, {
                ...config(),
                socket: {},
            } as SsoReferenceRegisterBorrowedOptions),
        ).rejects.toThrow();
        await expect(
            referenceRegisterOnTransport(fake, {
                ...config(),
                login: { ...config().login, uin: '0' },
            }),
        ).rejects.toThrow();
        expect(fake.calls).toBe(0);
    });
    it.each(['timeout', 'abort'] as const)('wipes stalled signer after %s', async (mode) => {
        let release!: (value: Uint8Array) => void;
        let entered!: () => void;
        let body!: Uint8Array;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const controller = new AbortController();
        const options = config();
        options.timeoutMs = mode === 'timeout' ? 25 : 1000;
        options.signal = controller.signal;

        options.buildReserved = (input) => {
            body = input.body;
            entered();
            return new Promise((resolve) => {
                release = resolve;
            });
        };

        const fake = new Fake();
        const original = fake.transactRaw.bind(fake);

        fake.transactRaw = async <C, T>(o: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let onAbort!: () => void;

            try {
                return await Promise.race([
                    original(o),
                    new Promise<Sso12RawResult<T>>((resolve) => {
                        onAbort = () =>
                            resolve({
                                kind: 'failure',
                                code: 'raw-cancelled',
                                writeState: 'not-written',
                            });
                        o.signal!.addEventListener('abort', onAbort, { once: true });
                        timer = setTimeout(
                            () =>
                                resolve({
                                    kind: 'failure',
                                    code: 'raw-timeout',
                                    writeState: 'not-written',
                                }),
                            o.timeoutMs,
                        );
                    }),
                ]);
            } finally {
                clearTimeout(timer);
                o.signal!.removeEventListener('abort', onAbort);
            }
        };

        const pending = referenceRegisterOnTransport(fake, options);
        await ready;

        if (mode === 'abort') {
            controller.abort();
        }

        expect(await pending).toMatchObject({
            kind: 'failure',
            code: 'borrowed-transaction-failed',
            writeState: 'not-written',
        });
        expect(body.every((v) => v === 0)).toBe(true);
        release(body);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(fake.frame).toBeUndefined();
        expect(fake.calls).toBe(1);
        expect(fake.close).not.toHaveBeenCalled();
    });
    it('revokes a builder left pending by a transport that settles early', async () => {
        let release!: (value: Uint8Array) => void;
        let signing!: Uint8Array;
        let background!: Promise<unknown>;
        const options = config();

        options.buildReserved = ({ body }) => {
            signing = body;
            return new Promise((resolve) => {
                release = resolve;
            });
        };

        const transport: Sso12RawTransport = {
            async transactRaw<C, T>(o: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                background = Promise.resolve(o.buildRequest({ uin: '0', sequence: seq })).catch(
                    () => undefined,
                );
                return { kind: 'failure', code: 'early', writeState: 'not-written' };
            },
        };
        expect(await referenceRegisterOnTransport(transport, options)).toMatchObject({
            kind: 'failure',
            code: 'borrowed-transaction-failed',
        });
        expect(signing.every((v) => v === 0)).toBe(true);
        release(signing);
        await background;
        expect(signing.every((v) => v === 0)).toBe(true);
    });
    it('wipes and revokes a verifier left pending by an early transport result', async () => {
        let release!: (value: boolean) => void;
        let entered!: () => void;
        let evidence!: Uint8Array;
        let background!: Promise<unknown>;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const options = config();

        options.verifyRaw = ({ responseFrame }) => {
            evidence = responseFrame;
            entered();
            return new Promise((resolve) => {
                release = resolve;
            });
        };

        const transport: Sso12RawTransport = {
            async transactRaw<C, T>(o: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                const identity = { uin: '0', sequence: seq };
                const built = await o.buildRequest(identity);
                background = Promise.resolve(
                    o.verifyCandidate(reply(), built.context, identity),
                ).catch(() => false);
                await ready;
                return { kind: 'failure', code: 'early', writeState: 'unknown' };
            },
        };
        expect(await referenceRegisterOnTransport(transport, options)).toMatchObject({
            kind: 'failure',
            code: 'borrowed-transaction-failed',
            writeState: 'unknown',
        });
        expect(evidence.every((v) => v === 0)).toBe(true);
        release(true);
        expect(await background).toBe(false);
        expect(evidence.every((v) => v === 0)).toBe(true);
    });
    it.each(['unknown', 'not-written'] as const)(
        'normalizes untrusted failure text with state %s',
        async (writeState) => {
            const secret = 'credential-secret-' + 'x'.repeat(100000);
            const transport: Sso12RawTransport = {
                async transactRaw<_C, T>(): Promise<Sso12RawResult<T>> {
                    return { kind: 'failure', code: secret, writeState };
                },
            };
            const result = await referenceRegisterOnTransport(transport, config());
            expect(result).toEqual({
                kind: 'failure',
                code: 'borrowed-transaction-failed',
                writeState,
            });
            expect(JSON.stringify(result)).not.toContain('credential-secret');
        },
    );
    it('normalizes thrown transport diagnostics', async () => {
        const transport: Sso12RawTransport = {
            async transactRaw<_C, T>(): Promise<Sso12RawResult<T>> {
                throw new Error('credential-secret');
            },
        };
        const result = await referenceRegisterOnTransport(transport, config());
        expect(result).toEqual({
            kind: 'failure',
            code: 'borrowed-transaction-failed',
            writeState: 'unknown',
        });
        expect(JSON.stringify(result)).not.toContain('credential-secret');
    });
    it('copies a large valid synthetic candidate without enumerating typed-array keys', async () => {
        const fake = new Fake();
        fake.candidate = reply('123', seq, SSO_INFO_SYNC_COMMAND, 'x'.repeat(1024 * 1024));
        const options = config();
        options.verifyRaw = () => false;
        const originalOwnKeys = Reflect.ownKeys;
        let largeEnumerations = 0;
        const spy = vi.spyOn(Reflect, 'ownKeys').mockImplementation((target) => {
            if (ArrayBuffer.isView(target) && target.byteLength > 65535) {
                largeEnumerations++;
            }

            return originalOwnKeys(target);
        });

        try {
            expect(await referenceRegisterOnTransport(fake, options)).toMatchObject({
                kind: 'failure',
                code: 'borrowed-transaction-failed',
                writeState: 'unknown',
            });
            expect(largeEnumerations).toBe(0);
        } finally {
            spy.mockRestore();
        }
    });
    it.each(['proxy', 'shared', 'detached'] as const)(
        'rejects %s candidate before verifier',
        async (kind) => {
            const options = config();
            options.verifyRaw = vi.fn(() => true);
            const transport: Sso12RawTransport = {
                async transactRaw<C, T>(o: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                    const identity = { uin: '0', sequence: seq };
                    const built = await o.buildRequest(identity);
                    let candidate = new Uint8Array(32);

                    if (kind === 'proxy') {
                        candidate = new Proxy(candidate, {
                            ownKeys() {
                                throw new Error('ownKeys called');
                            },
                        });
                    }

                    if (kind === 'shared') {
                        candidate = new Uint8Array(new SharedArrayBuffer(32));
                    }

                    if (kind === 'detached') {
                        structuredClone(candidate.buffer, { transfer: [candidate.buffer] });
                    }

                    await o.verifyCandidate(candidate, built.context, identity);
                    return { kind: 'failure', code: 'unexpected', writeState: 'unknown' };
                },
            };
            expect(await referenceRegisterOnTransport(transport, options)).toEqual({
                kind: 'failure',
                code: 'borrowed-transaction-failed',
                writeState: 'unknown',
            });
            expect(options.verifyRaw).not.toHaveBeenCalled();
        },
    );
    it('returns pre-abort without entering transport', async () => {
        const fake = new Fake();
        const controller = new AbortController();
        controller.abort();
        expect(
            await referenceRegisterOnTransport(fake, { ...config(), signal: controller.signal }),
        ).toMatchObject({ kind: 'failure', code: 'raw-cancelled', writeState: 'not-written' });
        expect(fake.calls).toBe(0);
    });
});
