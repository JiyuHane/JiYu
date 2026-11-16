import { createCipheriv, createDecipheriv, createECDH } from 'node:crypto';
import type {
    LinuxNTEasyLoginReferenceResponseBody,
    LinuxNTLoginReferenceForward,
    LinuxNTLoginReferenceResponseCommon,
    NTLoginForwardRequest,
} from '@snowluma/proto-defs/direct-login';
import type {
    DirectSendMessageRequest,
    DirectSendMessageResponse,
} from '@snowluma/proto-defs/direct-send-message';
import type { SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { KEY_EXCHANGE_COMMAND } from '../../src/direct/key-exchange-flow';
import { createLinuxEasyAccountOwner } from '../../src/direct/linux-easy-account-owner';
import {
    decodeKeyExchangeRequest,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
} from '../../src/direct/key-exchange-protobuf';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { LINUX_EASY_LOGIN_COMMAND } from '../../src/direct/sso-reference-linux-easy-login-flow';
import { SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
} from '../../src/direct/sso12-packet-client';

// Synthetic local bytes and in-memory transactions only.
const UIN = '123456';
const UID = 'synthetic-uid';
const SEND = 'MessageSvc.PbSendMsg';
const ZERO = new Uint8Array(16);
const SESSION_KEY = Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i);
const SESSION_TICKET = Uint8Array.from({ length: 24 }, (_, i) => 0x60 + i);
const D2_KEY = Uint8Array.from({ length: 16 }, (_, i) => 0x80 + i);
const D2 = Uint8Array.of(0x31, 0, 0x33);
const A1 = Uint8Array.of(0x11, 0, 0x12);
const A2 = Uint8Array.of(0x21, 0, 0x22);
const GUID = Uint8Array.of(0xab, 0xcd);
const NONCE = Uint8Array.from({ length: 12 }, (_, i) => i);
const RESERVED = Uint8Array.of(0xe1, 0xe2);

function word(value: number): Buffer {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value >>> 0);
    return bytes;
}

const field = (bytes: Uint8Array): Buffer => Buffer.concat([word(bytes.length + 4), bytes]);

function fixtureKey(scalar: number) {
    const ecdh = createECDH('prime256v1');
    const key = Buffer.alloc(32);
    key[31] = scalar;
    ecdh.setPrivateKey(key);
    return ecdh;
}

function seal(plain: Uint8Array, key: Uint8Array, nonce: Uint8Array): Buffer {
    const cipher = createCipheriv(key.length === 32 ? 'aes-256-gcm' : 'aes-128-gcm', key, nonce);
    return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function open(encoded: Uint8Array, key: Uint8Array): Buffer {
    const decipher = createDecipheriv('aes-128-gcm', key, encoded.subarray(0, 12));
    decipher.setAuthTag(encoded.subarray(-16));
    return Buffer.concat([decipher.update(encoded.subarray(12, -16)), decipher.final()]);
}

function unpack(input: Uint8Array, usesTickets: boolean) {
    const frame = Buffer.from(input);
    expect(frame.readUInt32BE(0)).toBe(frame.length);
    expect(frame.readUInt32BE(4)).toBe(12);
    expect(frame[8]).toBe(usesTickets ? 1 : 2);
    const d2End = 9 + frame.readUInt32BE(9);
    const d2 = frame.subarray(13, d2End);
    const accountStart = d2End + 1;
    const accountEnd = accountStart + frame.readUInt32BE(accountStart);
    expect(frame.subarray(accountStart + 4, accountEnd).toString()).toBe(UIN);
    const inner = Buffer.from(
        qqTeaDecrypt(frame.subarray(accountEnd), usesTickets ? D2_KEY : ZERO),
    );
    const sequence = inner.readUInt32BE(4);
    let offset = 28;

    const take = (width: 2 | 4 = 4): Buffer => {
        const size = width === 2 ? inner.readUInt16BE(offset) : inner.readUInt32BE(offset);
        const value = inner.subarray(offset + width, offset + size);
        offset += size;
        return value;
    };

    const a2 = take();
    const command = take().toString();
    take(); // empty field
    take(); // guid
    take(); // empty field
    take(2); // version
    take(); // reserved
    expect(offset).toBe(inner.readUInt32BE(0));
    const body = take();
    expect(offset).toBe(inner.length);
    return { sequence, d2, a2, command, body };
}

function response(sequence: number, command: string, body: Uint8Array, usesTickets: boolean) {
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
        Buffer.of(usesTickets ? 1 : 2, 0),
        field(Buffer.from(UIN)),
        Buffer.from(qqTeaEncrypt(inner, usesTickets ? D2_KEY : ZERO)),
    ]);
    frame.writeUInt32BE(frame.length);
    return Uint8Array.from(frame);
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

class FakeClient implements Sso12RawClient {
    private resolveClosed!: (reason: Sso12CloseReason) => void;
    readonly whenClosed = new Promise<Sso12CloseReason>((resolve) => {
        this.resolveClosed = resolve;
    });
    readonly close = vi.fn(() => this.resolveClosed({ kind: 'local', code: 'fixture-closed' }));
    readonly commands: string[] = [];
    readonly sequences: number[] = [];
    readonly errors: unknown[] = [];
    readonly sendReady = deferred();
    readonly sendRelease = deferred();
    readonly buildReady = deferred();
    readonly buildRelease = deferred();
    readonly buildSettled = deferred();
    holdBeforeBuild = false;
    buildAttempted = false;
    buildSucceeded = false;
    buildEntryTime = 0;
    buildTimeoutMs: number | undefined;
    holdSend = false;
    responseConsumed = false;
    fakeSettling = false;
    calls = 0;
    consumes = 0;

    async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        const index = this.calls++;
        const sequence = 0x80000001 + index;

        try {
            const identity = { uin: UIN, sequence };

            if (index >= 3 && this.holdBeforeBuild) {
                this.buildEntryTime = performance.now();
                this.buildTimeoutMs = options.timeoutMs;
                this.buildReady.resolve();
                await this.buildRelease.promise;
            }

            let built: Awaited<ReturnType<typeof options.buildRequest>>;

            try {
                if (index >= 3 && this.holdBeforeBuild) {
                    this.buildAttempted = true;
                }

                built = await options.buildRequest(identity);

                if (index >= 3 && this.holdBeforeBuild) {
                    this.buildSucceeded = true;
                }
            } finally {
                if (index >= 3 && this.holdBeforeBuild) {
                    this.buildSettled.resolve();
                }
            }

            const request = unpack(built.frame, index >= 2);
            expect(request.sequence).toBe(sequence);
            const expected =
                index === 0
                    ? KEY_EXCHANGE_COMMAND
                    : index === 1
                      ? LINUX_EASY_LOGIN_COMMAND
                      : index === 2
                        ? SSO_INFO_SYNC_COMMAND
                        : SEND;
            expect(request.command).toBe(expected);
            this.commands.push(request.command);
            this.sequences.push(sequence);
            let body: Uint8Array;

            if (index === 0) {
                const decoded = decodeKeyExchangeRequest(request.body);
                const ecdh = fixtureKey(2);
                const shared = ecdh.computeSecret(decoded.publicKey!);
                const secret = encodeKeyExchangeResponseSecret({
                    sessionKey: SESSION_KEY,
                    sessionTicket: SESSION_TICKET,
                    expiration: 300,
                });
                body = encodeKeyExchangeResponse({
                    publicKey: ecdh.getPublicKey(),
                    secret: seal(secret, shared, Buffer.alloc(12, 0x42)),
                });
            } else if (index === 1) {
                const forward = protobuf_decode<LinuxNTLoginReferenceForward>(request.body);
                expect(Buffer.from(forward.sessionTicket)).toEqual(Buffer.from(SESSION_TICKET));
                // The request is real encrypted data; opening it also authenticates its fixture key.
                expect(open(forward.buffer, SESSION_KEY).length).toBeGreaterThan(0);
                const tickets = protobuf_encode<LinuxNTEasyLoginReferenceResponseBody>({
                    tickets: { a1: A1, a2: A2, d2: D2, d2Key: D2_KEY },
                });
                const plain = protobuf_encode<LinuxNTLoginReferenceResponseCommon>({
                    head: { errorInfo: { code: 0n } },
                    body: tickets,
                });
                body = protobuf_encode<NTLoginForwardRequest>({
                    sessionTicket: Uint8Array.of(0x42),
                    buffer: seal(plain, SESSION_KEY, Buffer.alloc(12, 0x51)),
                    type: 1,
                });
            } else {
                expect(Buffer.from(request.d2)).toEqual(Buffer.from(D2));
                expect(Buffer.from(request.a2)).toEqual(Buffer.from(A2));

                if (index === 2) {
                    body = protobuf_encode<SsoRegisterResponse>({
                        register: { message: 'register success' },
                    });
                } else {
                    const decoded = protobuf_decode<DirectSendMessageRequest>(request.body);
                    expect(decoded.messageBody.richText.elems[0].text.text).toBe('synthetic text');
                    expect(decoded.routingHead.c2c).toEqual({
                        peerUin: 456n,
                        peerUid: 'fixture-peer',
                    });
                    body = protobuf_encode<DirectSendMessageResponse>({
                        result: 0,
                        sequence: 99n,
                        clientSequence: 88n,
                    });
                }
            }

            const candidate = response(sequence, request.command, body, index >= 2);

            if (!(await options.verifyCandidate(candidate, built.context, identity))) {
                return { kind: 'failure', code: 'fixture-rejected', writeState: 'unknown' };
            }

            const value = await options.consumeCandidate(candidate, built.context, identity);
            this.consumes++;

            if (index >= 3 && this.holdSend) {
                this.responseConsumed = true;
                this.sendReady.resolve();
                await this.sendRelease.promise;
                this.fakeSettling = true;
            }

            return { kind: 'response', sequence, value, writeState: 'written' };
        } catch (error) {
            this.errors.push(error);
            return { kind: 'failure', code: 'fixture-failed', writeState: 'unknown' };
        }
    }
}

function fixture() {
    const client = new FakeClient();
    const sign = vi.fn(() => Uint8Array.from(RESERVED));
    const verify = vi.fn(() => true);
    const options = {
        client,
        trustedSuccessQuiescence: true as const,
        isUsable: () => true,
        sessionTimeoutMs: 30000,
        login: {
            uin: UIN,
            guid: Uint8Array.from(GUID),
            a2: Uint8Array.from(A2),
            version: 'header-v',
            subAppId: 42,
            serverPublicKey: Uint8Array.from(fixtureKey(1).getPublicKey()),
            verifyKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
            timestamp: 1700000000,
            a1: Uint8Array.from(A1),
            nonce: Uint8Array.from(NONCE),
            deviceName: 'fixture-device',
            deviceType: 'fixture-type',
            appId: 42,
            appName: 'fixture-app',
            qua: 'fixture-qua',
            cookie: 'fixture-cookie',
            timeoutMs: 5000,
            buildReserved: sign,
            verifyRaw: verify,
            verifyServerResponse: vi.fn(() => true),
            acceptKeyExchange: vi.fn(
                ({ uin, expiration }: { uin: string; expiration: number | undefined }) =>
                    uin === UIN && expiration === 300,
            ),
        },
        register: {
            profile: { guid: Uint8Array.from(GUID), version: 'header-v', subAppId: 42 },
            registration: {
                uid: UID,
                version: 'build-v',
                deviceName: 'fixture-device',
                deviceType: 'fixture-type',
                vendorOs: 'fixture-os',
                random: 4,
            },
            timeoutMs: 5000,
            buildReserved: sign,
            verifyRaw: verify,
            acceptLogin: vi.fn(
                ({ uin, uid, statusCode }: { uin: string; uid: string; statusCode: bigint }) =>
                    uin === UIN && uid === UID && statusCode === 0n,
            ),
        },
    };
    const send = {
        request: {
            route: { kind: 'private' as const, peerUin: 456n, peerUid: 'fixture-peer' },
            text: 'synthetic text',
            clientSequence: 9007199254740993n,
            random: 0x12345678,
        },
        maxResponseBodyBytes: 65536,
        timeoutMs: 5000,
    };
    return { client, options, send, sign, verify };
}

describe('Linux Easy owner send operation deadline with synthetic transport', () => {
    it('counts option preflight against the operation deadline without closing the session', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwner();
        let now = 1000;
        let triggered = false;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
        const originalOwnKeys = Reflect.ownKeys;
        const keys = vi.spyOn(Reflect, 'ownKeys').mockImplementation((value) => {
            if (value === f.send.request.route) {
                triggered = true;
                now = 6001; // operation deadline 6000; session deadline 31000
            }

            return originalOwnKeys(value);
        });

        try {
            expect(await owner.start(f.options)).toEqual({
                kind: 'registered',
                registerSequence: 0x80000003,
            });
            expect(await owner.sendText(f.send)).toEqual({
                kind: 'failure',
                code: 'timeout',
                writeState: 'not-written',
            });
            expect(triggered).toBe(true);
            expect(now).toBeLessThan(31000);
            expect(f.client.calls).toBe(3);
            expect(f.client.close).not.toHaveBeenCalled();
            keys.mockRestore();
            expect(await owner.sendText(f.send)).toMatchObject({
                kind: 'response',
                sequence: 0x80000004,
                writeState: 'written',
            });
            expect(f.client.calls).toBe(4);
            expect(f.client.errors).toEqual([]);
        } finally {
            keys.mockRestore();
            owner.close();
            f.client.sendRelease.resolve();
            f.client.close();
            clock.mockRestore();
        }
    });

    it('treats expiry at the owner post-settlement check as an uncertain write and terminates', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwner();
        let now = 1000;
        let triggered = false;
        f.client.holdSend = true;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
            // The fake has consumed the real response and is settling its transaction.
            // Select the owner's nowChecked phase, not a count of global clock reads.
            if (f.client.fakeSettling && !triggered && new Error().stack?.includes('nowChecked')) {
                triggered = true;
                now = 6001;
            }

            return now;
        });

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            const pending = owner.sendText(f.send);
            expect(
                await Promise.race([
                    f.client.sendReady.promise.then(() => 'ready'),
                    pending.then(() => 'finished'),
                ]),
            ).toBe('ready');
            expect(f.client.responseConsumed).toBe(true);
            expect(f.client.calls).toBe(4);
            expect(f.client.consumes).toBe(4);
            expect(triggered).toBe(false);
            f.client.sendRelease.resolve();
            expect(await pending).toEqual({
                kind: 'failure',
                code: 'send-failed',
                writeState: 'unknown',
            });
            expect(f.client.fakeSettling).toBe(true);
            expect(triggered).toBe(true);
            expect(now).toBeLessThan(31000);
            expect(f.client.close).toHaveBeenCalled();
            expect(await owner.sendText(f.send)).toEqual({
                kind: 'failure',
                code: 'closed',
                writeState: 'not-written',
            });
            expect(f.client.calls).toBe(4);
            expect(f.client.errors).toEqual([]);
        } finally {
            f.client.sendRelease.resolve();
            owner.close();
            f.client.close();
            clock.mockRestore();
        }
    });

    it('fences a raw build after the absolute deadline even while the rounded child deadline remains future', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwner();
        let now = 1000;
        let preflightShifted = false;
        f.client.holdBeforeBuild = true;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
        const originalOwnKeys = Reflect.ownKeys;
        const keys = vi.spyOn(Reflect, 'ownKeys').mockImplementation((value) => {
            if (value === f.send.request.route) {
                preflightShifted = true;
                now = 1000.25;
            }

            return originalOwnKeys(value);
        });

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            expect(f.sign).toHaveBeenCalledTimes(3);
            expect(f.verify).toHaveBeenCalledTimes(3);
            const pending = owner.sendText(f.send);
            expect(
                await Promise.race([
                    f.client.buildReady.promise.then(() => 'ready'),
                    pending.then(() => 'finished'),
                ]),
            ).toBe('ready');
            expect(preflightShifted).toBe(true);
            expect(f.client.calls).toBe(4);
            expect(f.client.buildEntryTime).toBe(1000.25);
            expect(f.client.buildTimeoutMs).toBe(5000);
            expect(f.client.buildAttempted).toBe(false);
            expect(f.sign).toHaveBeenCalledTimes(3);
            expect(f.verify).toHaveBeenCalledTimes(3);

            // The owner started at 1000 with a 5000ms budget. The child started
            // at 1000.25 with rounded 5000ms, so 6000.125 is in the gap.
            now = 6000.125;
            expect(now).toBeGreaterThan(6000);
            expect(now).toBeLessThan(f.client.buildEntryTime + f.client.buildTimeoutMs!);
            expect(now).toBeLessThan(31000);
            f.client.buildRelease.resolve();
            expect(await pending).toEqual({
                kind: 'failure',
                code: 'send-failed',
                writeState: 'unknown',
            });
            await f.client.buildSettled.promise;
            expect(f.client.buildAttempted).toBe(true);
            expect(f.client.buildSucceeded).toBe(false);
            expect(f.sign).toHaveBeenCalledTimes(3);
            expect(f.verify).toHaveBeenCalledTimes(3);
            expect(f.client.close).toHaveBeenCalled();
            expect(await owner.sendText(f.send)).toEqual({
                kind: 'failure',
                code: 'closed',
                writeState: 'not-written',
            });
            expect(f.client.calls).toBe(4);
        } finally {
            f.client.buildRelease.resolve();
            f.client.sendRelease.resolve();
            owner.close();
            f.client.close();
            keys.mockRestore();
            clock.mockRestore();
        }
    });

    it('sends three times on one registered owner with distinct sequences and no retry', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwner();

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            const results = [];

            for (let i = 0; i < 3; i++) {
                results.push(await owner.sendText(f.send));
                expect(f.client.calls).toBe(4 + i);
            }

            expect(results).toMatchObject([
                { kind: 'response', sequence: 0x80000004, writeState: 'written' },
                { kind: 'response', sequence: 0x80000005, writeState: 'written' },
                { kind: 'response', sequence: 0x80000006, writeState: 'written' },
            ]);
            expect(new Set(f.client.sequences.slice(3)).size).toBe(3);
            expect(f.client.commands).toEqual([
                KEY_EXCHANGE_COMMAND,
                LINUX_EASY_LOGIN_COMMAND,
                SSO_INFO_SYNC_COMMAND,
                SEND,
                SEND,
                SEND,
            ]);
            expect(f.client.consumes).toBe(6);
            expect(f.sign).toHaveBeenCalledTimes(6);
            expect(f.verify).toHaveBeenCalledTimes(6);
            expect(f.client.errors).toEqual([]);
            owner.close();
            expect(f.client.close).toHaveBeenCalledTimes(1);
            expect(await owner.sendText(f.send)).toEqual({
                kind: 'failure',
                code: 'closed',
                writeState: 'not-written',
            });
            expect(f.client.calls).toBe(6);
        } finally {
            owner.close();
            f.client.sendRelease.resolve();
            f.client.close();
        }
    });
});
