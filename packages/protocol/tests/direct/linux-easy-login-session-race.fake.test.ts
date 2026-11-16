import { createCipheriv, createDecipheriv, createECDH } from 'node:crypto';
import type {
    LinuxNTEasyLoginReferenceRequestBody,
    LinuxNTLoginReferenceCommon,
    LinuxNTLoginReferenceForward,
    LinuxNTLoginReferenceResponseCommon,
    NTLoginForwardRequest,
} from '@snowluma/proto-defs/direct-login';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { KEY_EXCHANGE_COMMAND } from '../../src/direct/key-exchange-flow';
import {
    decodeKeyExchangeRequest,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
} from '../../src/direct/key-exchange-protobuf';
import { runLinuxEasyLoginSession } from '../../src/direct/linux-easy-login-session';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import { LINUX_EASY_LOGIN_COMMAND } from '../../src/direct/sso-reference-linux-easy-login-flow';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
} from '../../src/direct/sso12-packet-client';

// Synthetic peer and in-memory broker only. A fake write records a frame; it does
// not imply a socket, peer identity, transport quiescence, or cleanup of copies.
const UIN = '123456';
const KEY = Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i);
const TICKET = Uint8Array.from({ length: 24 }, (_, i) => 0x60 + i);
const BODY = Uint8Array.of(0xff, 0, 0xc3, 0x28);
const ZERO = new Uint8Array(16);

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

async function bounded<T>(promise: Promise<T>, ms = 2500): Promise<T> {
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

function peer(scalar: number) {
    const ecdh = createECDH('prime256v1');
    const secret = Buffer.alloc(32);
    secret[31] = scalar;
    ecdh.setPrivateKey(secret);
    return ecdh;
}

function seal(plain: Uint8Array, key: Uint8Array, nonce: Uint8Array): Buffer {
    const cipher = createCipheriv(key.length === 32 ? 'aes-256-gcm' : 'aes-128-gcm', key, nonce);
    return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function word(value: number): Buffer {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value >>> 0);
    return result;
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

function response(sequence: number, command: string, body: Uint8Array): Uint8Array {
    const header = Buffer.concat([
        word(sequence),
        word(0),
        field(Buffer.alloc(0)),
        field(Buffer.from(command)),
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
        Buffer.from(qqTeaEncrypt(inner, ZERO)),
    ]);
    frame.writeUInt32BE(frame.length);
    return Uint8Array.from(frame);
}

class FakeClient implements Sso12RawClient {
    readonly whenClosed = new Promise<Sso12CloseReason>(() => {});
    readonly close = vi.fn();
    readonly frames: Uint8Array[] = [];
    readonly completed: Array<ReturnType<typeof deferred<void>>> = [];
    calls = 0;
    consumes = 0;

    // Intentionally ignores cancellation: the returned operation stays alive until
    // its signer settles. A settled outer session is not evidence of quiescence.
    async transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        const index = this.calls++;
        const done = deferred<void>();
        this.completed.push(done);

        try {
            if (index > 1) {
                throw new Error('unexpected retry');
            }

            const identity = { uin: UIN, sequence: 123 + index };
            const built = await raw.buildRequest(identity);
            const frame = Uint8Array.from(built.frame);
            this.frames.push(frame);
            let body: Uint8Array;

            if (index === 0) {
                const request = decodeKeyExchangeRequest(requestBody(frame));

                if (!request.publicKey) {
                    throw new Error('missing fixture key');
                }

                const ephemeral = peer(2);
                const shared = ephemeral.computeSecret(request.publicKey);
                body = encodeKeyExchangeResponse({
                    publicKey: ephemeral.getPublicKey(),
                    secret: seal(
                        encodeKeyExchangeResponseSecret({
                            sessionKey: KEY,
                            sessionTicket: TICKET,
                            expiration: 300,
                        }),
                        shared,
                        Buffer.alloc(12, 0x42),
                    ),
                });
            } else {
                const common = protobuf_encode<LinuxNTLoginReferenceResponseCommon>({
                    head: { errorInfo: { code: 0n } },
                    body: BODY,
                });
                body = protobuf_encode<NTLoginForwardRequest>({
                    sessionTicket: Uint8Array.of(0x42),
                    buffer: seal(common, KEY, Buffer.from('101112131415161718191a1b', 'hex')),
                    type: 1,
                });
            }

            const candidate = response(
                identity.sequence,
                index === 0 ? KEY_EXCHANGE_COMMAND : LINUX_EASY_LOGIN_COMMAND,
                body,
            );

            if (!(await raw.verifyCandidate(candidate, built.context, identity))) {
                return { kind: 'failure', code: 'rejected', writeState: 'unknown' };
            }

            this.consumes++;
            const value = await raw.consumeCandidate(candidate, built.context, identity);
            return { kind: 'response', sequence: identity.sequence, value, writeState: 'written' };
        } catch {
            return { kind: 'failure', code: 'fixture-failed', writeState: 'unknown' };
        } finally {
            done.resolve();
        }
    }
}

function setup() {
    const fake = new FakeClient();
    const lease = createRawSessionBroker(fake, {
        trustedSuccessQuiescence: true,
        isUsable: () => true,
    }).acquire({ deadline: performance.now() + 30000 });
    const poison = vi.spyOn(lease, 'poison');
    const release = vi.spyOn(lease, 'release');
    const options: Options = {
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
        timeoutMs: 3000,
        buildReserved: () => Uint8Array.of(0xaa),
        verifyRaw: () => true,
        verifyServerResponse: () => true,
        acceptKeyExchange: () => true,
    };
    return { fake, lease, poison, release, options };
}

function cleared(bytes: Uint8Array): void {
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
}

function observe<T>(p: Promise<T>): void {
    void p.then(
        () => {},
        () => {},
    );
}

describe('Linux EasyLogin session races on one synthetic lease', () => {
    it.each(['abort', 'timeout', 'stopped abort event'] as const)(
        'terminates a pending key-exchange signer on %s without a late write',
        async (mode) => {
            const f = setup();
            const gate = deferred<Uint8Array>();
            const entered = deferred<void>();
            const controller = new AbortController();
            let borrowed!: Uint8Array;

            if (mode === 'stopped abort event') {
                controller.signal.addEventListener('abort', (event) =>
                    event.stopImmediatePropagation(),
                );
            }

            f.options.signal = controller.signal;
            f.options.timeoutMs = mode === 'timeout' ? 150 : 3000;
            f.options.buildReserved = vi.fn(({ body }) => {
                borrowed = body;
                entered.resolve();
                return gate.promise;
            });
            const pending = runLinuxEasyLoginSession(f.lease, f.options);
            observe(pending);

            try {
                await bounded(entered.promise);
                expect(borrowed.some((byte) => byte !== 0)).toBe(true);

                if (mode !== 'timeout') {
                    controller.abort();
                }

                const result = await bounded(pending);
                expect(result).toMatchObject({
                    kind: 'failure',
                    stage: 'key-exchange',
                    keyExchangeWrite: 'unknown',
                    easyLoginWrite: 'not-started',
                });
                cleared(borrowed);
                expect(f.fake.calls).toBe(1);
                expect(f.fake.frames).toHaveLength(0);
                expect(f.poison).toHaveBeenCalledTimes(1);
                expect(f.fake.close).toHaveBeenCalledTimes(1);
                expect(await bounded(f.lease.whenClosed)).toBe('poisoned');
                gate.resolve(Uint8Array.of(0xaa));
                await bounded(f.fake.completed[0]!.promise);
                expect(f.fake.calls).toBe(1);
                expect(f.fake.frames).toHaveLength(0);
                expect(f.fake.consumes).toBe(0);
                cleared(borrowed);
            } finally {
                gate.resolve(Uint8Array.of(0xaa));
                f.lease.poison();
            }
        },
    );

    it('observes a late signer rejection without a write or unhandled rejection', async () => {
        const f = setup();
        const gate = deferred<Uint8Array>();
        const entered = deferred<void>();
        const controller = new AbortController();
        let borrowed!: Uint8Array;
        f.options.signal = controller.signal;

        f.options.buildReserved = ({ body }) => {
            borrowed = body;
            entered.resolve();
            return gate.promise;
        };

        const pending = runLinuxEasyLoginSession(f.lease, f.options);
        observe(pending);

        try {
            await bounded(entered.promise);
            controller.abort();
            const result = await bounded(pending);
            expect(result).toMatchObject({
                kind: 'failure',
                stage: 'key-exchange',
                keyExchangeWrite: 'unknown',
                easyLoginWrite: 'not-started',
            });
            cleared(borrowed);
            gate.reject(new Error('late-fixture-secret'));
            await bounded(f.fake.completed[0]!.promise);
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(f.fake.frames).toHaveLength(0);
            expect(f.fake.calls).toBe(1);
            expect(f.poison).toHaveBeenCalledTimes(1);
            expect(JSON.stringify(result)).not.toContain('late-fixture-secret');
        } finally {
            gate.resolve(Uint8Array.of(0xaa));
            f.lease.poison();
        }
    });

    it.each(['abort', 'false'] as const)(
        'preserves the written key exchange when acceptance returns %s',
        async (mode) => {
            const f = setup();
            const controller = new AbortController();
            f.options.signal = controller.signal;
            f.options.acceptKeyExchange = vi.fn(() => {
                if (mode === 'abort') {
                    controller.abort();
                    return true;
                }

                return false;
            });

            try {
                const result = await bounded(runLinuxEasyLoginSession(f.lease, f.options));
                expect(result).toMatchObject({
                    kind: 'failure',
                    keyExchangeWrite: 'written',
                    easyLoginWrite: 'not-started',
                });
                expect(f.fake.calls).toBe(1);
                expect(f.fake.frames).toHaveLength(1);
                expect(f.options.acceptKeyExchange).toHaveBeenCalledOnce();
                expect(f.poison).toHaveBeenCalledTimes(1);
                expect(f.fake.close).toHaveBeenCalledTimes(1);
            } finally {
                f.lease.poison();
            }
        },
    );

    it('aborts the EasyLogin signer while retaining the first written state', async () => {
        const f = setup();
        const gate = deferred<Uint8Array>();
        const entered = deferred<void>();
        const controller = new AbortController();
        let borrowed!: Uint8Array;
        f.options.signal = controller.signal;

        f.options.buildReserved = ({ command, body }) => {
            if (command === KEY_EXCHANGE_COMMAND) {
                return Uint8Array.of(0xaa);
            }

            expect(command).toBe(LINUX_EASY_LOGIN_COMMAND);
            borrowed = body;
            entered.resolve();
            return gate.promise;
        };

        const pending = runLinuxEasyLoginSession(f.lease, f.options);
        observe(pending);

        try {
            await bounded(entered.promise);
            expect(f.fake.frames).toHaveLength(1);
            controller.abort();
            const result = await bounded(pending);
            expect(result).toMatchObject({
                kind: 'failure',
                stage: 'easy-login',
                keyExchangeWrite: 'written',
                easyLoginWrite: 'unknown',
            });
            cleared(borrowed);
            expect(f.poison).toHaveBeenCalledTimes(1);
            expect(f.fake.calls).toBe(2);
            gate.resolve(Uint8Array.of(0xaa));
            await bounded(f.fake.completed[1]!.promise);
            expect(f.fake.frames).toHaveLength(1);
            expect(f.fake.consumes).toBe(1);
            cleared(borrowed);
        } finally {
            gate.resolve(Uint8Array.of(0xaa));
            f.lease.poison();
        }
    });

    it('uses one total deadline across both deferred signers', async () => {
        const f = setup();
        const first = deferred<Uint8Array>();
        const second = deferred<Uint8Array>();
        const keyEntered = deferred<void>();
        const easyEntered = deferred<void>();
        f.options.timeoutMs = 1200;

        f.options.buildReserved = ({ command }) => {
            if (command === KEY_EXCHANGE_COMMAND) {
                keyEntered.resolve();
                return first.promise;
            }

            easyEntered.resolve();
            return second.promise;
        };

        const pending = runLinuxEasyLoginSession(f.lease, f.options);
        observe(pending);

        try {
            await bounded(keyEntered.promise);
            await new Promise<void>((resolve) => setTimeout(resolve, 800));
            first.resolve(Uint8Array.of(0xaa));
            await bounded(easyEntered.promise);
            // With a reset deadline the second signer would still have 1200ms.
            // Allow scheduling slack; the watchdog is not a hard-real-time claim.
            const result = await bounded(pending, 1000);
            expect(result).toMatchObject({
                kind: 'failure',
                stage: 'easy-login',
                keyExchangeWrite: 'written',
                easyLoginWrite: 'unknown',
            });
            expect(f.fake.frames).toHaveLength(1);
            expect(f.poison).toHaveBeenCalledTimes(1);
            second.resolve(Uint8Array.of(0xaa));
            await bounded(f.fake.completed[1]!.promise);
            expect(f.fake.frames).toHaveLength(1);
        } finally {
            first.resolve(Uint8Array.of(0xaa));
            second.resolve(Uint8Array.of(0xaa));
            f.lease.poison();
        }
    });

    it('snapshots caller inputs synchronously across the phase boundary', async () => {
        const f = setup();
        const first = deferred<Uint8Array>();
        const entered = deferred<void>();
        const expectedGuid = Uint8Array.from(f.options.guid);
        const expectedA1 = Uint8Array.from(f.options.a1);
        const expectedNonce = Uint8Array.from(f.options.nonce);

        f.options.buildReserved = ({ command }) => {
            if (command === KEY_EXCHANGE_COMMAND) {
                entered.resolve();
                return first.promise;
            }

            return Uint8Array.of(0xaa);
        };

        const pending = runLinuxEasyLoginSession(f.lease, f.options);
        observe(pending);

        try {
            f.options.guid.fill(0);
            f.options.a1.fill(0);
            f.options.a2!.fill(0);
            f.options.nonce.fill(0);
            f.options.serverPublicKey.fill(0);
            f.options.verifyKey.fill(0);
            f.options.deviceName = 'changed-after-call';
            await bounded(entered.promise);
            first.resolve(Uint8Array.of(0xaa));
            const result = await bounded(pending);
            expect(result).toMatchObject({ kind: 'response' });
            const forward = protobuf_decode<LinuxNTLoginReferenceForward>(
                requestBody(f.fake.frames[1]!),
            );
            expect(Uint8Array.from(forward.buffer.subarray(0, 12))).toEqual(expectedNonce);
            const decipher = createDecipheriv('aes-128-gcm', KEY, forward.buffer.subarray(0, 12));
            decipher.setAuthTag(forward.buffer.subarray(-16));
            const plain = Buffer.concat([
                decipher.update(forward.buffer.subarray(12, -16)),
                decipher.final(),
            ]);
            const common = protobuf_decode<LinuxNTLoginReferenceCommon>(plain);
            expect(Uint8Array.from(common.head.client.guid)).toEqual(expectedGuid);
            expect(common.head.client.deviceName).toBe('fixture-device');
            const easy = protobuf_decode<LinuxNTEasyLoginReferenceRequestBody>(common.body);
            expect(Uint8Array.from(easy.a1)).toEqual(expectedA1);
        } finally {
            first.resolve(Uint8Array.of(0xaa));
            f.lease.poison();
        }
    });

    it('leaves a successful lease open for its owner', async () => {
        const f = setup();

        try {
            const result = await bounded(runLinuxEasyLoginSession(f.lease, f.options));
            expect(result).toMatchObject({ kind: 'response' });
            expect(f.fake.calls).toBe(2);
            expect(f.fake.frames).toHaveLength(2);
            expect(f.fake.consumes).toBe(2);
            expect(f.poison).not.toHaveBeenCalled();
            expect(f.release).not.toHaveBeenCalled();
            expect(f.fake.close).not.toHaveBeenCalled();
            f.lease.release();
            expect(await bounded(f.lease.whenClosed)).toBe('released');
            expect(f.fake.close).not.toHaveBeenCalled();
        } finally {
            f.lease.poison();
        }
    });
});
