import { createCipheriv, createDecipheriv, createECDH } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type {
    LinuxNTEasyLoginReferenceRequestBody,
    LinuxNTEasyLoginReferenceResponseBody,
    LinuxNTLoginReferenceCommon,
    LinuxNTLoginReferenceForward,
    LinuxNTLoginReferenceResponseCommon,
    NTLoginForwardRequest,
} from '@snowluma/proto-defs/direct-login';
import type { SsoHeartbeatResponse, SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEY_EXCHANGE_COMMAND } from '../../src/direct/key-exchange-flow';
import {
    createLinuxEasyAccountOwner,
    createLinuxEasyAccountOwnerWithKeyCapability,
} from '../../src/direct/linux-easy-account-owner';
import {
    decodeKeyExchangeRequest,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
} from '../../src/direct/key-exchange-protobuf';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { LINUX_EASY_LOGIN_COMMAND } from '../../src/direct/sso-reference-linux-easy-login-flow';
import { SSO_HEARTBEAT_COMMAND, SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import type {
    Sso12CloseReason,
    Sso12RawIdentity,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
} from '../../src/direct/sso12-packet-client';

// Synthetic bytes, local crypto and in-memory callbacks only. This establishes
// local transaction behavior, not QQ online status, authentication or signing.
const UIN = '123456';
const UID = 'synthetic-uid';
const FIRST = 0xf0000001;
const HEARTBEAT_BODY = '08011202080018002000';
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

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

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
    const ticketEnd = 9 + frame.readUInt32BE(9);
    const d2 = frame.subarray(13, ticketEnd);
    expect(frame[ticketEnd]).toBe(0);
    const accountStart = ticketEnd + 1;
    const accountEnd = accountStart + frame.readUInt32BE(accountStart);
    const uin = frame.subarray(accountStart + 4, accountEnd).toString('ascii');
    const inner = Buffer.from(
        qqTeaDecrypt(frame.subarray(accountEnd), usesTickets ? D2_KEY : ZERO),
    );
    const sequence = inner.readUInt32BE(4);
    const subAppId = inner.readInt32BE(8);
    let offset = 28;

    const take = (width: 2 | 4 = 4): Buffer => {
        const size = width === 2 ? inner.readUInt16BE(offset) : inner.readUInt32BE(offset);
        expect(size).toBeGreaterThanOrEqual(width);
        expect(offset + size).toBeLessThanOrEqual(inner.length);
        const value = inner.subarray(offset + width, offset + size);
        offset += size;
        return value;
    };

    const a2 = take();
    const command = take().toString();
    expect(take()).toHaveLength(0);
    const guid = take().toString();
    expect(take()).toHaveLength(0);
    const version = take(2).toString();
    const reserved = take();
    expect(offset).toBe(inner.readUInt32BE(0));
    const body = take();
    expect(offset).toBe(inner.length);
    return { uin, d2, sequence, subAppId, a2, command, guid, version, reserved, body };
}

function response(input: {
    sequence: number;
    command: string;
    body: Uint8Array;
    usesTickets: boolean;
    uin?: string;
    retCode?: number;
    compressed?: boolean;
}): Uint8Array {
    const header = Buffer.concat([
        word(input.sequence),
        word(input.retCode ?? 0),
        field(Buffer.alloc(0)),
        field(Buffer.from(input.command)),
        field(Buffer.alloc(0)),
        word(input.compressed ? 1 : 0),
        field(Buffer.alloc(0)),
    ]);
    const body = input.compressed ? deflateSync(input.body) : input.body;
    const inner = Buffer.concat([field(header), field(body)]);
    const frame = Buffer.concat([
        word(0),
        word(12),
        Buffer.of(input.usesTickets ? 1 : 2, 0),
        field(Buffer.from(input.uin ?? UIN)),
        Buffer.from(qqTeaEncrypt(inner, input.usesTickets ? D2_KEY : ZERO)),
    ]);
    frame.writeUInt32BE(frame.length);
    return Uint8Array.from(frame);
}

function unknownBodyOfSize(size: number): Uint8Array {
    // One valid unknown length-delimited field followed by an explicit zero interval.
    for (let width = 1; width <= 4; width++) {
        let n = size - 3 - width;
        const payload = n;
        const length: number[] = [];

        if (n < 0) {
            continue;
        }

        do {
            const next = n & 127;
            n = Math.floor(n / 128);
            length.push(next | (n ? 128 : 0));
        } while (n);

        if (length.length === width) {
            return Buffer.concat([
                Buffer.of(0x4a, ...length),
                Buffer.alloc(payload),
                Buffer.of(0x18, 0),
            ]);
        }
    }

    throw new Error('unsupported synthetic size');
}

type BadIdentityPhase = 'build' | 'verify' | 'consume';
class FakeClient implements Sso12RawClient {
    private resolveClosed!: (reason: Sso12CloseReason) => void;
    readonly whenClosed = new Promise<Sso12CloseReason>((resolve) => {
        this.resolveClosed = resolve;
    });
    readonly close = vi.fn(() => this.resolveClosed({ kind: 'local', code: 'fixture-closed' }));
    readonly entered = deferred();
    readonly release = deferred();
    readonly settled = deferred();
    readonly frames: Uint8Array[] = [];
    readonly borrowedFrames: Uint8Array[] = [];
    readonly candidates: Uint8Array[] = [];
    readonly errors: unknown[] = [];
    readonly phases: string[] = [];
    calls = 0;
    consumes = 0;
    hold = false;
    badIdentity: BadIdentityPhase | undefined;
    replyUin = UIN;
    replySequence: number | undefined;
    replyCommand = SSO_HEARTBEAT_COMMAND;
    retCode = 0;
    compressed = false;
    body: Uint8Array = protobuf_encode<SsoHeartbeatResponse>({ interval: 270n });
    swapCandidate = false;
    replayCandidate = false;
    heartbeatReserved = RESERVED;
    captured?: Sso12RawOptions<unknown, unknown>;
    capturedIdentity?: Sso12RawIdentity;
    capturedContext?: unknown;

    async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        const index = this.calls++;
        const sequence = (FIRST + index) >>> 0;
        const good = { uin: UIN, sequence };
        const bad = { uin: '456', sequence };
        const identity = index >= 3 && this.badIdentity === 'build' ? bad : good;

        try {
            this.phases.push(`${index}:build`);
            const built = await options.buildRequest(identity);
            this.borrowedFrames.push(built.frame);
            const frame = Uint8Array.from(built.frame);
            this.frames.push(frame);
            const request = unpack(frame, index >= 2);
            expect(request).toMatchObject({
                uin: UIN,
                sequence,
                subAppId: 42,
                guid: 'abcd',
                version: 'header-v',
            });
            expect(request.reserved).toEqual(
                Buffer.from(index >= 3 ? this.heartbeatReserved : RESERVED),
            );
            let body: Uint8Array;

            if (index === 0) {
                expect(request.command).toBe(KEY_EXCHANGE_COMMAND);
                const decoded = decodeKeyExchangeRequest(request.body);
                const server = fixtureKey(2);
                const shared = server.computeSecret(decoded.publicKey!);
                const secret = encodeKeyExchangeResponseSecret({
                    sessionKey: SESSION_KEY,
                    sessionTicket: SESSION_TICKET,
                    expiration: 300,
                });
                body = encodeKeyExchangeResponse({
                    publicKey: server.getPublicKey(),
                    secret: seal(secret, shared, Buffer.alloc(12, 0x42)),
                });
            } else if (index === 1) {
                expect(request.command).toBe(LINUX_EASY_LOGIN_COMMAND);
                const forward = protobuf_decode<LinuxNTLoginReferenceForward>(request.body);
                expect(Buffer.from(forward.sessionTicket)).toEqual(Buffer.from(SESSION_TICKET));
                const common = protobuf_decode<LinuxNTLoginReferenceCommon>(
                    open(forward.buffer, SESSION_KEY),
                );
                expect(common.head.user.account).toBe(UIN);
                expect(
                    Buffer.from(
                        protobuf_decode<LinuxNTEasyLoginReferenceRequestBody>(common.body).a1,
                    ),
                ).toEqual(Buffer.from(A1));
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
                expect(request.d2).toEqual(Buffer.from(D2));
                expect(request.a2).toEqual(Buffer.from(A2));

                if (index === 2) {
                    expect(request.command).toBe(SSO_INFO_SYNC_COMMAND);
                    body = protobuf_encode<SsoRegisterResponse>({
                        register: { message: 'register success' },
                    });
                } else {
                    expect(request.command).toBe(SSO_HEARTBEAT_COMMAND);
                    expect(request.body.toString('hex')).toBe(HEARTBEAT_BODY);
                    body = this.body;
                }
            }

            const candidate =
                this.replayCandidate && index >= 4
                    ? Uint8Array.from(this.candidates[3]!)
                    : response({
                          sequence: index >= 3 ? (this.replySequence ?? sequence) : sequence,
                          command: index >= 3 ? this.replyCommand : request.command,
                          body,
                          usesTickets: index >= 2,
                          uin: index >= 3 ? this.replyUin : UIN,
                          retCode: index >= 3 ? this.retCode : 0,
                          compressed: index >= 3 && this.compressed,
                      });
            this.candidates.push(candidate);

            if (index >= 3) {
                this.captured = options as Sso12RawOptions<unknown, unknown>;
                this.capturedIdentity = identity;
                this.capturedContext = built.context;
            }

            if (index >= 3 && this.hold) {
                this.entered.resolve();
                await this.release.promise;
            }

            const verifyIdentity = index >= 3 && this.badIdentity === 'verify' ? bad : identity;
            this.phases.push(`${index}:verify`);

            if (!(await options.verifyCandidate(candidate, built.context, verifyIdentity))) {
                return { kind: 'failure', code: 'fixture-rejected', writeState: 'unknown' };
            }

            const consumeIdentity = index >= 3 && this.badIdentity === 'consume' ? bad : identity;
            const consumed =
                this.swapCandidate && index >= 3 ? Uint8Array.from(candidate) : candidate;

            if (this.swapCandidate && index >= 3) {
                consumed[consumed.length - 1] ^= 1;
            }

            this.phases.push(`${index}:consume`);
            const value = await options.consumeCandidate(consumed, built.context, consumeIdentity);
            this.consumes++;
            return { kind: 'response', sequence, value, writeState: 'written' };
        } catch (error) {
            this.errors.push(error);
            return { kind: 'failure', code: 'fixture-failed', writeState: 'unknown' };
        } finally {
            if (index >= 3) {
                this.settled.resolve();
            }
        }
    }
}

function fixture() {
    const client = new FakeClient();
    const signed: Array<{
        uin: string;
        uid?: string;
        sequence: number;
        command: string;
        body: Uint8Array;
    }> = [];
    const signedInputs: Uint8Array[] = [];
    const verifiedInputs: Array<{ requestFrame: Uint8Array; responseFrame: Uint8Array }> = [];
    const sign = vi.fn(
        (input: {
            uin: string;
            uid?: string;
            sequence: number;
            command: string;
            body: Uint8Array;
        }): Uint8Array | Promise<Uint8Array> => {
            signed.push({ ...input, body: Uint8Array.from(input.body) });
            signedInputs.push(input.body);
            return Uint8Array.from(RESERVED);
        },
    );
    const verify = vi.fn(
        (input: {
            uin: string;
            sequence: number;
            command: string;
            requestFrame: Uint8Array;
            responseFrame: Uint8Array;
        }) => {
            const index = (input.sequence - FIRST) >>> 0;
            expect(input.uin).toBe(UIN);
            expect(input.sequence).toBe((FIRST + index) >>> 0);
            expect(input.requestFrame).toEqual(client.frames[index]);
            expect(input.responseFrame).toEqual(client.candidates[index]);
            expect(input.requestFrame.buffer).not.toBe(client.frames[index]!.buffer);
            expect(input.responseFrame.buffer).not.toBe(client.candidates[index]!.buffer);
            verifiedInputs.push({
                requestFrame: input.requestFrame,
                responseFrame: input.responseFrame,
            });
            return true;
        },
    );
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
    return { client, options, sign, verify, signed, signedInputs, verifiedInputs };
}

const failed = { kind: 'failure', code: 'heartbeat-failed', writeState: 'unknown' } as const;
const closed = { kind: 'failure', code: 'closed', writeState: 'not-written' } as const;
const heartbeat = { timeoutMs: 5000 };
const zeroed = (bytes: Uint8Array) => bytes.every((value) => value === 0);

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe.each([
    ['plain', createLinuxEasyAccountOwner],
    ['bound-key', createLinuxEasyAccountOwnerWithKeyCapability],
] as const)('Linux Easy %s owner heartbeat with synthetic RawClient', (_, createOwner) => {
    it('uses the registered account, same tickets, high-bit sequences and exactly one local exchange each time', async () => {
        const f = fixture();
        const owner = createOwner();

        try {
            expect(await owner.start(f.options)).toEqual({
                kind: 'registered',
                registerSequence: FIRST + 2,
            });

            for (let i = 0; i < 3; i++) {
                expect(await owner.heartbeat(heartbeat)).toEqual({
                    kind: 'response',
                    sequence: FIRST + 3 + i,
                    value: { status: 'success', interval: 270n },
                    writeState: 'written',
                });
                expect(f.client.calls).toBe(4 + i);
                const request = unpack(f.client.frames[3 + i]!, true);
                expect(request.command).toBe(SSO_HEARTBEAT_COMMAND);
                expect(request.uin).toBe(UIN);
                expect(request.d2).toEqual(Buffer.from(D2));
                expect(request.a2).toEqual(Buffer.from(A2));
                expect(request.body.toString('hex')).toBe(HEARTBEAT_BODY);
                expect(f.signed[3 + i]).toMatchObject({
                    uin: UIN,
                    uid: UID,
                    sequence: FIRST + 3 + i,
                    command: SSO_HEARTBEAT_COMMAND,
                });
                expect(Buffer.from(f.signed[3 + i]!.body).toString('hex')).toBe(HEARTBEAT_BODY);
            }

            expect(f.client.consumes).toBe(6);
            expect(f.client.errors).toEqual([]);
            expect(f.sign).toHaveBeenCalledTimes(6);
            expect(f.verify).toHaveBeenCalledTimes(6);
            expect(f.client.close).not.toHaveBeenCalled();

            // Callback inputs and the client's borrowed build frames are temporary;
            // independent caller-owned fixture bytes and captured frames stay intact.
            for (const bytes of f.signedInputs.slice(3)) {
                expect(zeroed(bytes)).toBe(true);
            }

            for (const pair of f.verifiedInputs.slice(3)) {
                expect(zeroed(pair.requestFrame)).toBe(true);
                expect(zeroed(pair.responseFrame)).toBe(true);
            }

            for (const bytes of f.client.borrowedFrames.slice(3)) {
                expect(zeroed(bytes)).toBe(true);
            }

            expect(f.options.login.a1).toEqual(A1);
            expect(f.options.register.profile.guid).toEqual(GUID);
            expect(f.client.candidates[3]!.some((byte) => byte !== 0)).toBe(true);
        } finally {
            owner.close();
            f.client.release.resolve();
        }
    });

    it.each([
        ['missing', Buffer.alloc(0), { status: 'missing-interval' }],
        ['zero', Buffer.from('1800', 'hex'), { status: 'success', interval: 0n }],
        [
            '270',
            protobuf_encode<SsoHeartbeatResponse>({ interval: 270n }),
            { status: 'success', interval: 270n },
        ],
        [
            'uint64 max',
            protobuf_encode<SsoHeartbeatResponse>({ interval: 0xffffffffffffffffn }),
            { status: 'success', interval: 0xffffffffffffffffn },
        ],
    ] as const)('preserves %s without assigning an interval unit', async (_, body, value) => {
        const f = fixture();
        const owner = createOwner();
        f.client.body = body;

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            expect(await owner.heartbeat(heartbeat)).toEqual({
                kind: 'response',
                sequence: FIRST + 3,
                value,
                writeState: 'written',
            });
            f.client.body = Buffer.from('1800', 'hex');
            expect(await owner.heartbeat(heartbeat)).toMatchObject({
                kind: 'response',
                sequence: FIRST + 4,
                value: { status: 'success', interval: 0n },
            });
            expect(f.client.calls).toBe(5);
            expect(f.client.errors).toEqual([]);
        } finally {
            owner.close();
        }
    });

    it('returns the actual nonzero SSO error and revokes the local owner', async () => {
        const f = fixture();
        const owner = createOwner();
        f.client.retCode = -17;
        f.client.body = Uint8Array.of(0x18, 0x80); // Not parsed as heartbeat protobuf.

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            expect(await owner.heartbeat(heartbeat)).toEqual({
                kind: 'response',
                sequence: FIRST + 3,
                value: { status: 'sso-error', retCode: -17 },
                writeState: 'written',
            });
            expect(f.client.close).toHaveBeenCalledOnce();
            expect(await owner.heartbeat(heartbeat)).toEqual(closed);
            expect(f.client.calls).toBe(4);
        } finally {
            owner.close();
        }
    });

    it('snapshots a signer result alias before wiping and reuses the retained key safely', async () => {
        const f = fixture();
        const owner = createOwner();
        let temporary: Uint8Array | undefined;

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            f.client.heartbeatReserved = Uint8Array.from(Buffer.from(HEARTBEAT_BODY, 'hex'));
            f.sign.mockImplementationOnce((input) => {
                temporary = input.body;
                return input.body;
            });
            expect(await owner.heartbeat(heartbeat)).toMatchObject({
                kind: 'response',
                sequence: FIRST + 3,
            });
            expect(Buffer.from(unpack(f.client.frames[3]!, true).reserved).toString('hex')).toBe(
                HEARTBEAT_BODY,
            );
            expect(temporary).toBeDefined();
            expect(zeroed(temporary!)).toBe(true);
            f.client.heartbeatReserved = RESERVED;
            expect(await owner.heartbeat(heartbeat)).toMatchObject({
                kind: 'response',
                sequence: FIRST + 4,
            });
            expect(f.client.calls).toBe(5);
            expect(f.client.errors).toEqual([]);
        } finally {
            owner.close();
        }
    });

    it('rejects reuse of an earlier heartbeat response for a later high-bit sequence', async () => {
        const f = fixture();
        const owner = createOwner();

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            expect(await owner.heartbeat(heartbeat)).toMatchObject({
                kind: 'response',
                sequence: FIRST + 3,
            });
            f.client.replayCandidate = true;
            expect(await owner.heartbeat(heartbeat)).toEqual(failed);
            expect(f.client.calls).toBe(5);
            expect(f.client.consumes).toBe(4);
            expect(f.client.phases.at(-1)).toBe('4:consume');
            expect(f.client.close).toHaveBeenCalledOnce();
            expect(await owner.heartbeat(heartbeat)).toEqual(closed);
        } finally {
            owner.close();
        }
    });

    it.each(['signer', 'verifier'] as const)(
        'rejects reentry from the %s before inspecting arguments',
        async (origin) => {
            const f = fixture();
            const owner = createOwner();
            let traps = 0;
            let nested: ReturnType<typeof owner.heartbeat> | undefined;
            const competing = new Proxy(heartbeat, {
                ownKeys() {
                    traps++;
                    throw new Error('unexpected trap');
                },
            });

            try {
                expect((await owner.start(f.options)).kind).toBe('registered');

                if (origin === 'signer') {
                    f.sign.mockImplementationOnce(() => {
                        nested = owner.heartbeat(competing);
                        return Uint8Array.from(RESERVED);
                    });
                } else {
                    f.verify.mockImplementationOnce(() => {
                        nested = owner.heartbeat(competing);
                        return true;
                    });
                }

                expect(await owner.heartbeat(heartbeat)).toMatchObject({
                    kind: 'response',
                    sequence: FIRST + 3,
                });
                expect(await nested).toEqual({
                    kind: 'failure',
                    code: 'busy',
                    writeState: 'not-written',
                });
                expect(traps).toBe(0);
                expect(f.client.calls).toBe(4);
                expect(f.client.errors).toEqual([]);
            } finally {
                owner.close();
            }
        },
    );

    it('rejects a second held operation without disturbing the first', async () => {
        const f = fixture();
        const owner = createOwner();
        f.client.hold = true;

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            const pending = owner.heartbeat(heartbeat);
            expect(
                await Promise.race([
                    f.client.entered.promise.then(() => 'entered'),
                    pending.then(() => 'finished'),
                ]),
            ).toBe('entered');
            expect(await owner.heartbeat(heartbeat)).toEqual({
                kind: 'failure',
                code: 'busy',
                writeState: 'not-written',
            });
            let traps = 0;
            const competingSend = new Proxy({} as Parameters<typeof owner.sendText>[0], {
                ownKeys() {
                    traps++;
                    throw new Error('unexpected trap');
                },
            });
            expect(await owner.sendText(competingSend)).toEqual({
                kind: 'failure',
                code: 'busy',
                writeState: 'not-written',
            });
            expect(traps).toBe(0);
            expect(f.client.calls).toBe(4);
            f.client.release.resolve();
            expect(await pending).toMatchObject({ kind: 'response', sequence: FIRST + 3 });
            expect(f.client.errors).toEqual([]);
        } finally {
            f.client.release.resolve();
            owner.close();
        }
    });

    it('rejects closed, pre-aborted, invalid limits and account injection before a transaction', async () => {
        const f = fixture();
        const owner = createOwner();
        const preAbort = new AbortController();
        preAbort.abort();

        try {
            expect(await owner.heartbeat(heartbeat)).toEqual(closed);
            expect((await owner.start(f.options)).kind).toBe('registered');

            for (const limit of [-1, 0.5, 65537, Infinity, NaN]) {
                expect(
                    await owner.heartbeat({ ...heartbeat, maxResponseBodyBytes: limit }),
                ).toEqual({
                    kind: 'failure',
                    code: 'invalid-options',
                    writeState: 'not-written',
                });
            }

            expect(await owner.heartbeat({ ...heartbeat, uin: '456' } as typeof heartbeat)).toEqual(
                {
                    kind: 'failure',
                    code: 'invalid-options',
                    writeState: 'not-written',
                },
            );
            expect(await owner.heartbeat({ ...heartbeat, signal: preAbort.signal })).toEqual({
                kind: 'failure',
                code: 'cancelled',
                writeState: 'not-written',
            });
            expect(f.client.calls).toBe(3);
            expect(await owner.heartbeat(heartbeat)).toMatchObject({
                kind: 'response',
                sequence: FIRST + 3,
            });
            owner.close();
            expect(await owner.heartbeat(heartbeat)).toEqual(closed);
            expect(f.client.calls).toBe(4);
        } finally {
            owner.close();
        }
    });

    it('counts option preflight time and preserves the owner before lease entry', async () => {
        const f = fixture();
        const owner = createOwner();
        const operation = { timeoutMs: 5000 };
        let now = 1000;
        let sampled = false;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
        const originalKeys = Reflect.ownKeys;
        const keys = vi.spyOn(Reflect, 'ownKeys').mockImplementation((value) => {
            if (value === operation) {
                sampled = true;
                now = 6001;
            }

            return originalKeys(value);
        });

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            expect(await owner.heartbeat(operation)).toEqual({
                kind: 'failure',
                code: 'timeout',
                writeState: 'not-written',
            });
            expect(sampled).toBe(true);
            expect(f.client.calls).toBe(3);
            expect(f.client.close).not.toHaveBeenCalled();
            keys.mockRestore();
            expect(await owner.heartbeat(heartbeat)).toMatchObject({
                kind: 'response',
                sequence: FIRST + 3,
            });
        } finally {
            keys.mockRestore();
            owner.close();
            clock.mockRestore();
        }
    });

    it.each(['build', 'verify', 'consume'] as const)(
        'rejects a wrong raw account at %s',
        async (phase) => {
            const f = fixture();
            const owner = createOwner();
            f.client.badIdentity = phase;

            try {
                expect((await owner.start(f.options)).kind).toBe('registered');
                expect(await owner.heartbeat(heartbeat)).toEqual(failed);
                expect(f.client.calls).toBe(4);
                expect(f.client.consumes).toBe(3);
                expect(f.client.phases.at(-1)).toBe(`3:${phase}`);

                if (phase === 'build') {
                    expect(f.sign).toHaveBeenCalledTimes(3);
                    expect(f.client.frames).toHaveLength(3);
                }

                if (phase === 'verify') {
                    expect(f.verify).toHaveBeenCalledTimes(3);
                }

                expect(f.client.close).toHaveBeenCalledOnce();
                expect(await owner.heartbeat(heartbeat)).toEqual(closed);
            } finally {
                owner.close();
            }
        },
    );

    it.each(['account', 'sequence', 'command', 'swapped response', 'verifier false'] as const)(
        'poisons on %s, without a retry',
        async (mode) => {
            const f = fixture();
            const owner = createOwner();

            if (mode === 'account') {
                f.client.replyUin = '456';
            } else if (mode === 'sequence') {
                f.client.replySequence = 7;
            } else if (mode === 'command') {
                f.client.replyCommand = 'synthetic.wrong';
            } else if (mode === 'swapped response') {
                f.client.swapCandidate = true;
            }

            try {
                expect((await owner.start(f.options)).kind).toBe('registered');

                if (mode === 'verifier false') {
                    f.verify.mockImplementationOnce(() => false);
                }

                expect(await owner.heartbeat(heartbeat)).toEqual(failed);
                expect(f.client.calls).toBe(4);
                expect(f.client.consumes).toBe(3);
                expect(f.client.phases.at(-1)).toBe(
                    mode === 'verifier false' ? '3:verify' : '3:consume',
                );
                expect(f.client.close).toHaveBeenCalledOnce();
                expect(await owner.heartbeat(heartbeat)).toEqual(closed);
            } finally {
                owner.close();
            }
        },
    );

    it.each(['signer body', 'verifier request', 'verifier response'] as const)(
        'rejects a persistently modified temporary %s copy',
        async (mode) => {
            const f = fixture();
            const owner = createOwner();
            let temporary: Uint8Array | undefined;

            try {
                expect((await owner.start(f.options)).kind).toBe('registered');

                if (mode === 'signer body') {
                    f.sign.mockImplementationOnce((input) => {
                        temporary = input.body;
                        temporary[0] ^= 0xff;
                        return Uint8Array.from(RESERVED);
                    });
                } else {
                    f.verify.mockImplementationOnce((input) => {
                        temporary =
                            mode === 'verifier request' ? input.requestFrame : input.responseFrame;
                        temporary[0] ^= 0xff;
                        return true;
                    });
                }

                expect(await owner.heartbeat(heartbeat)).toEqual(failed);
                expect(temporary).toBeDefined();
                expect(zeroed(temporary!)).toBe(true);
                expect(f.client.calls).toBe(4);
                expect(f.client.consumes).toBe(3);
                expect(f.client.phases.at(-1)).toBe(
                    mode === 'signer body' ? '3:build' : '3:verify',
                );
                expect(f.client.frames).toHaveLength(mode === 'signer body' ? 3 : 4);
                expect(f.client.close).toHaveBeenCalledOnce();
                expect(await owner.heartbeat(heartbeat)).toEqual(closed);
            } finally {
                owner.close();
            }
        },
    );

    it.each(['signer body', 'verifier request', 'verifier response'] as const)(
        'allows a %s copy restored before the check without claiming detection of intermediate changes',
        async (mode) => {
            const f = fixture();
            const owner = createOwner();

            try {
                expect((await owner.start(f.options)).kind).toBe('registered');

                if (mode === 'signer body') {
                    f.sign.mockImplementationOnce((input) => {
                        input.body[0] ^= 0xff;
                        input.body[0] ^= 0xff;
                        return Uint8Array.from(RESERVED);
                    });
                } else {
                    f.verify.mockImplementationOnce((input) => {
                        const copy =
                            mode === 'verifier request' ? input.requestFrame : input.responseFrame;
                        copy[0] ^= 0xff;
                        copy[0] ^= 0xff;
                        return true;
                    });
                }

                expect(await owner.heartbeat(heartbeat)).toMatchObject({
                    kind: 'response',
                    sequence: FIRST + 3,
                });
                expect(f.client.consumes).toBe(4);
                expect(f.client.errors).toEqual([]);
            } finally {
                owner.close();
            }
        },
    );

    it.each([false, true])(
        'enforces compressed=%s decoded body limits at, below and at zero',
        async (compressed) => {
            const exact = fixture();
            const good = createOwner();
            exact.client.compressed = compressed;
            exact.client.body = Buffer.from('48011800', 'hex');
            const over = fixture();
            const bad = createOwner();
            over.client.compressed = compressed;
            over.client.body = exact.client.body;
            const empty = fixture();
            const zero = createOwner();
            empty.client.compressed = compressed;
            empty.client.body = Buffer.alloc(0);

            try {
                expect((await good.start(exact.options)).kind).toBe('registered');
                expect(
                    await good.heartbeat({ ...heartbeat, maxResponseBodyBytes: 4 }),
                ).toMatchObject({
                    kind: 'response',
                    value: { status: 'success', interval: 0n },
                });
                expect((await bad.start(over.options)).kind).toBe('registered');
                expect(await bad.heartbeat({ ...heartbeat, maxResponseBodyBytes: 3 })).toEqual(
                    failed,
                );
                expect(over.client.close).toHaveBeenCalledOnce();
                expect((await zero.start(empty.options)).kind).toBe('registered');
                expect(
                    await zero.heartbeat({ ...heartbeat, maxResponseBodyBytes: 0 }),
                ).toMatchObject({
                    kind: 'response',
                    value: { status: 'missing-interval' },
                });
                empty.client.body = Buffer.from('1800', 'hex');
                expect(await zero.heartbeat({ ...heartbeat, maxResponseBodyBytes: 0 })).toEqual(
                    failed,
                );
                expect(empty.client.close).toHaveBeenCalledOnce();
            } finally {
                good.close();
                bad.close();
                zero.close();
            }
        },
    );

    it('enforces the default 65536-byte owner bound without treating it as a frame limit', async () => {
        const f = fixture();
        const owner = createOwner();
        f.client.body = unknownBodyOfSize(65536);

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            expect(await owner.heartbeat(heartbeat)).toMatchObject({
                kind: 'response',
                value: { status: 'success', interval: 0n },
            });
            f.client.body = unknownBodyOfSize(65537);
            expect(await owner.heartbeat(heartbeat)).toEqual(failed);
            expect(f.client.calls).toBe(5);
            expect(f.client.close).toHaveBeenCalledOnce();
        } finally {
            owner.close();
        }
    });

    it.each(['close', 'abort', 'timeout'] as const)(
        'revokes a held transaction on %s and fences late completion',
        async (mode) => {
            const f = fixture();
            const owner = createOwner();
            const controller = new AbortController();
            f.client.hold = true;

            try {
                expect((await owner.start(f.options)).kind).toBe('registered');
                const pending = owner.heartbeat({ timeoutMs: 100, signal: controller.signal });
                expect(
                    await Promise.race([
                        f.client.entered.promise.then(() => 'entered'),
                        pending.then(() => 'finished'),
                    ]),
                ).toBe('entered');

                if (mode === 'close') {
                    owner.close();
                } else if (mode === 'abort') {
                    controller.abort();
                } else {
                    await vi.advanceTimersByTimeAsync(100);
                }

                expect(await pending).toEqual(failed);
                expect(f.client.close).toHaveBeenCalledOnce();
                expect(await owner.heartbeat(heartbeat)).toEqual(closed);
                f.client.release.resolve();
                await f.client.settled.promise;
                expect(f.client.calls).toBe(4);
                expect(f.client.consumes).toBe(3);
                expect(await owner.heartbeat(heartbeat)).toEqual(closed);
            } finally {
                f.client.release.resolve();
                owner.close();
            }
        },
    );

    it('observes an aborted pending signer and wipes its late callback bytes without a fake write', async () => {
        const f = fixture();
        const owner = createOwner();
        const controller = new AbortController();
        const entered = deferred();
        let release!: (value: Uint8Array) => void;
        let temporary: Uint8Array | undefined;
        const signerResult = new Promise<Uint8Array>((resolve) => {
            release = resolve;
        });

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            f.sign.mockImplementationOnce((input) => {
                temporary = input.body;
                entered.resolve();
                return signerResult;
            });
            const pending = owner.heartbeat({ ...heartbeat, signal: controller.signal });
            expect(
                await Promise.race([
                    entered.promise.then(() => 'entered'),
                    pending.then(() => 'finished'),
                ]),
            ).toBe('entered');
            controller.abort();
            expect(await pending).toEqual(failed);
            expect(f.client.close).toHaveBeenCalledOnce();
            release(Uint8Array.from(RESERVED));
            await f.client.settled.promise;
            expect(temporary).toBeDefined();
            expect(zeroed(temporary!)).toBe(true);
            expect(f.client.frames).toHaveLength(3);
            expect(f.client.consumes).toBe(3);
            expect(f.client.calls).toBe(4);
            expect(await owner.heartbeat(heartbeat)).toEqual(closed);
        } finally {
            release(Uint8Array.from(RESERVED));
            owner.close();
        }
    });

    it('revokes raw callback reuse after a successful heartbeat', async () => {
        const f = fixture();
        const owner = createOwner();

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            expect(await owner.heartbeat(heartbeat)).toMatchObject({ kind: 'response' });
            const raw = f.client.captured!;
            const identity = f.client.capturedIdentity!;
            const context = f.client.capturedContext;
            const candidate = f.client.candidates[3]!;
            await expect(
                Promise.resolve().then(() => raw.buildRequest(identity)),
            ).rejects.toThrow();
            await expect(
                Promise.resolve().then(() => raw.verifyCandidate(candidate, context, identity)),
            ).rejects.toThrow();
            await expect(
                Promise.resolve().then(() => raw.consumeCandidate(candidate, context, identity)),
            ).rejects.toThrow();
            expect(f.client.calls).toBe(4);
            expect(f.sign).toHaveBeenCalledTimes(4);
            expect(f.verify).toHaveBeenCalledTimes(4);
        } finally {
            owner.close();
        }
    });
});
