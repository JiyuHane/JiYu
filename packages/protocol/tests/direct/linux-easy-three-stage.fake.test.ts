import { createCipheriv, createDecipheriv, createECDH } from 'node:crypto';
import type {
    LinuxNTEasyLoginReferenceRequestBody,
    LinuxNTEasyLoginReferenceResponseBody,
    LinuxNTLoginReferenceCommon,
    LinuxNTLoginReferenceForward,
    LinuxNTLoginReferenceResponseCommon,
    NTLoginForwardRequest,
} from '@snowluma/proto-defs/direct-login';
import type { SsoRegisterRequest, SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { KEY_EXCHANGE_COMMAND } from '../../src/direct/key-exchange-flow';
import {
    decodeKeyExchangeRequest,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
} from '../../src/direct/key-exchange-protobuf';
import { runLinuxEasyLoginSession } from '../../src/direct/linux-easy-login-session';
import { registerLinuxEasyReference } from '../../src/direct/linux-easy-reference-register';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import { LINUX_EASY_LOGIN_COMMAND } from '../../src/direct/sso-reference-linux-easy-login-flow';
import { SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
} from '../../src/direct/sso12-packet-client';

// Synthetic bytes, deterministic fixture responses and an in-memory transport only.
// These tests establish local composition, not a peer identity or online state.
const UIN = '123456';
const UID = 'synthetic-uid';
const SEQUENCES = [0x80000001, 0xf0000002, 0xf0000003] as const;
const COMMANDS = [KEY_EXCHANGE_COMMAND, LINUX_EASY_LOGIN_COMMAND, SSO_INFO_SYNC_COMMAND] as const;
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
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

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

function unpack(input: Uint8Array, register: boolean) {
    const frame = Buffer.from(input);
    expect(frame.readUInt32BE(0)).toBe(frame.length);
    expect(frame.readUInt32BE(4)).toBe(12);
    expect(frame[8]).toBe(register ? 1 : 2);
    const d2End = 9 + frame.readUInt32BE(9);
    const d2 = frame.subarray(13, d2End);
    expect(frame[d2End]).toBe(0);
    const accountStart = d2End + 1;
    const accountEnd = accountStart + frame.readUInt32BE(accountStart);
    const uin = frame.subarray(accountStart + 4, accountEnd).toString('ascii');
    const inner = Buffer.from(qqTeaDecrypt(frame.subarray(accountEnd), register ? D2_KEY : ZERO));
    const sequence = inner.readUInt32BE(4);
    const subAppId = inner.readInt32BE(8);
    let offset = 28;

    const take = (width: 2 | 4 = 4): Buffer => {
        const length = width === 2 ? inner.readUInt16BE(offset) : inner.readUInt32BE(offset);
        expect(length).toBeGreaterThanOrEqual(width);
        expect(offset + length).toBeLessThanOrEqual(inner.length);
        const value = inner.subarray(offset + width, offset + length);
        offset += length;
        return value;
    };

    const a2 = take();
    const command = take().toString();
    expect(take().length).toBe(0);
    const guid = take().toString();
    expect(take().length).toBe(0);
    const version = take(2).toString();
    const reserved = take();
    expect(offset).toBe(inner.readUInt32BE(0));
    const body = take();
    expect(offset).toBe(inner.length);
    return { uin, d2, sequence, subAppId, a2, command, guid, version, reserved, body };
}

function response(sequence: number, command: string, body: Uint8Array, register: boolean) {
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
        Buffer.of(register ? 1 : 2, 0),
        field(Buffer.from(UIN)),
        Buffer.from(qqTeaEncrypt(inner, register ? D2_KEY : ZERO)),
    ]);
    frame.writeUInt32BE(frame.length);
    return Uint8Array.from(frame);
}

type Status = 'ok' | 'missing-code' | 'nonzero';
class FakeClient implements Sso12RawClient {
    readonly whenClosed = new Promise<Sso12CloseReason>(() => {});
    readonly close = vi.fn();
    readonly frames: Uint8Array[] = [];
    readonly candidates: Uint8Array[] = [];
    readonly errors: unknown[] = [];
    calls = 0;
    consumes = 0;
    status: Status = 'ok';
    wrongIdentityAt = -1;

    async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        const index = this.calls++;
        const sequence = SEQUENCES[index];

        try {
            if (sequence === undefined) {
                throw new Error('unexpected transaction');
            }

            const identity = { uin: index === this.wrongIdentityAt ? '999999' : UIN, sequence };
            const built = await options.buildRequest(identity);
            const frame = Uint8Array.from(built.frame);
            this.frames.push(frame);
            const request = unpack(frame, index === 2);
            expect(request).toMatchObject({ uin: UIN, sequence, command: COMMANDS[index] });
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
                expect(forward.type).toBe(1);
                expect(same(forward.sessionTicket, SESSION_TICKET)).toBe(true);
                expect(same(forward.buffer.subarray(0, 12), NONCE)).toBe(true);
                const common = protobuf_decode<LinuxNTLoginReferenceCommon>(
                    open(forward.buffer, SESSION_KEY),
                );
                expect(common.head.user.account).toBe(UIN);
                expect(same(common.head.client.guid, GUID)).toBe(true);
                expect(
                    same(protobuf_decode<LinuxNTEasyLoginReferenceRequestBody>(common.body).a1, A1),
                ).toBe(true);
                const tickets = protobuf_encode<LinuxNTEasyLoginReferenceResponseBody>({
                    tickets: { a1: A1, a2: A2, d2: D2, d2Key: D2_KEY },
                });
                const errorInfo =
                    this.status === 'missing-code' ? {} : { code: this.status === 'ok' ? 0n : 1n };
                const plain = protobuf_encode<LinuxNTLoginReferenceResponseCommon>({
                    head: { errorInfo },
                    body: tickets,
                });
                body = protobuf_encode<NTLoginForwardRequest>({
                    sessionTicket: Uint8Array.of(0x42),
                    buffer: seal(plain, SESSION_KEY, Buffer.alloc(12, 0x51)),
                    type: 1,
                });
            } else {
                expect(same(request.d2, D2)).toBe(true);
                expect(same(request.a2, A2)).toBe(true);
                expect(request).toMatchObject({ subAppId: 42, guid: 'abcd', version: 'header-v' });
                const decoded = protobuf_decode<SsoRegisterRequest>(request.body);
                expect(decoded.register).toMatchObject({
                    guid: 'ABCD',
                    buildVersion: 'build-v',
                    device: {
                        name: 'fixture-device',
                        type: 'fixture-type',
                        vendorOs: 'fixture-os',
                    },
                });
                body = protobuf_encode<SsoRegisterResponse>({
                    register: { message: 'register success' },
                });
            }

            const candidate = response(sequence, request.command, body, index === 2);
            this.candidates.push(candidate);

            if (!(await options.verifyCandidate(candidate, built.context, identity))) {
                return { kind: 'failure', code: 'fixture-rejected', writeState: 'unknown' };
            }

            this.consumes++;
            const value = await options.consumeCandidate(candidate, built.context, identity);
            return { kind: 'response', sequence, value, writeState: 'written' };
        } catch (error) {
            this.errors.push(error);
            return { kind: 'failure', code: 'fixture-failed', writeState: 'unknown' };
        }
    }
}

function setup(status: Status = 'ok') {
    const fake = new FakeClient();
    fake.status = status;
    const lease = createRawSessionBroker(fake, {
        trustedSuccessQuiescence: true,
        isUsable: () => true,
    }).acquire({ deadline: performance.now() + 30000 });
    const transaction = vi.spyOn(lease, 'transactRaw');
    const poison = vi.spyOn(lease, 'poison');
    const signed: {
        uin: string;
        uid?: string;
        sequence: number;
        command: string;
        body: Uint8Array;
    }[] = [];
    const verified: {
        sequence: number;
        command: string;
        request: Uint8Array;
        response: Uint8Array;
    }[] = [];
    const sign = vi.fn(
        (input: {
            uin: string;
            uid?: string;
            sequence: number;
            command: string;
            body: Uint8Array;
        }) => {
            expect(input.uin).toBe(UIN);
            signed.push({ ...input, body: Uint8Array.from(input.body) });
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
            const index = verified.length;
            expect(input.uin).toBe(UIN);
            expect(input.sequence).toBe(SEQUENCES[index]);
            expect(input.command).toBe(COMMANDS[index]);
            expect(same(input.requestFrame, fake.frames[index]!)).toBe(true);
            expect(same(input.responseFrame, fake.candidates[index]!)).toBe(true);
            expect(input.requestFrame.buffer).not.toBe(fake.frames[index]!.buffer);
            expect(input.responseFrame.buffer).not.toBe(fake.candidates[index]!.buffer);
            verified.push({
                sequence: input.sequence,
                command: input.command,
                request: Uint8Array.from(input.requestFrame),
                response: Uint8Array.from(input.responseFrame),
            });
            return true;
        },
    );
    const options = {
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
    };
    const registration = {
        uin: UIN,
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
    };
    return {
        fake,
        lease,
        transaction,
        poison,
        signed,
        verified,
        sign,
        verify,
        options,
        registration,
    };
}

describe('three synthetic stages on one in-memory broker lease', () => {
    it('binds all three sequences, callbacks, ticket bytes and profile; the owner releases', async () => {
        const f = setup();
        const session = await runLinuxEasyLoginSession(f.lease, f.options);
        expect(session.kind).toBe('response');

        if (session.kind !== 'response' || session.value.body === null) {
            throw new Error('expected synthetic response with body');
        }

        expect(session).toMatchObject({
            keyExchangeSequence: SEQUENCES[0],
            easyLoginSequence: SEQUENCES[1],
            value: { status: { kind: 'code', code: 0n, codePresent: true } },
        });
        const expectedBody = protobuf_encode<LinuxNTEasyLoginReferenceResponseBody>({
            tickets: { a1: A1, a2: A2, d2: D2, d2Key: D2_KEY },
        });
        expect(same(session.value.body, expectedBody)).toBe(true);

        for (const source of [
            ...f.fake.frames,
            ...f.fake.candidates,
            SESSION_KEY,
            SESSION_TICKET,
            D2_KEY,
            D2,
            A1,
            A2,
        ]) {
            expect(session.value.body.buffer).not.toBe(source.buffer);
        }

        const pending = registerLinuxEasyReference(f.lease, { ...f.registration, session });
        session.value.body.fill(0);
        f.registration.profile.guid.fill(0);
        const registered = await pending;
        expect(registered).toEqual({
            kind: 'response',
            sequence: SEQUENCES[2],
            value: 'success',
            poison: 'not-requested',
        });
        expect(f.registration.acceptLogin).toHaveBeenCalledExactlyOnceWith({
            uin: UIN,
            uid: UID,
            statusCode: 0n,
        });
        expect(f.options.acceptKeyExchange).toHaveBeenCalledExactlyOnceWith({
            uin: UIN,
            expiration: 300,
        });
        expect(f.options.verifyServerResponse).toHaveBeenCalledOnce();
        expect(f.fake.calls).toBe(3);
        expect(f.fake.consumes).toBe(3);
        expect(f.fake.errors).toEqual([]);
        expect(f.transaction).toHaveBeenCalledTimes(3);
        expect(f.transaction.mock.contexts).toEqual([f.lease, f.lease, f.lease]);
        expect(f.sign).toHaveBeenCalledTimes(3);
        expect(f.verify).toHaveBeenCalledTimes(3);

        for (let i = 0; i < 3; i++) {
            const request = unpack(f.fake.frames[i]!, i === 2);
            expect(request).toMatchObject({
                uin: UIN,
                sequence: SEQUENCES[i],
                command: COMMANDS[i],
                subAppId: 42,
                guid: 'abcd',
                version: 'header-v',
            });
            expect(same(request.reserved, RESERVED)).toBe(true);
            expect(same(request.body, f.signed[i]!.body)).toBe(true);
            expect(f.signed[i]).toMatchObject({
                uin: UIN,
                sequence: SEQUENCES[i],
                command: COMMANDS[i],
            });
            expect(f.verified[i]).toMatchObject({ sequence: SEQUENCES[i], command: COMMANDS[i] });
            expect(same(f.verified[i]!.request, f.fake.frames[i]!)).toBe(true);
            expect(same(f.verified[i]!.response, f.fake.candidates[i]!)).toBe(true);
        }

        expect(f.signed[2]!.uid).toBe(UID);
        expect(f.poison).not.toHaveBeenCalled();
        expect(f.fake.close).not.toHaveBeenCalled();
        f.lease.release();
        expect(await f.lease.whenClosed).toBe('released');
        expect(f.fake.close).not.toHaveBeenCalled();
    });

    it.each(['missing-code', 'nonzero'] as const)(
        'rejects %s from the real Easy result without a third send',
        async (status) => {
            const f = setup(status);
            const session = await runLinuxEasyLoginSession(f.lease, f.options);
            expect(session.kind).toBe('response');

            if (session.kind !== 'response') {
                throw new Error('expected synthetic Easy response');
            }

            expect(session.value.status).toEqual({
                kind: 'code',
                codePresent: status !== 'missing-code',
                code: status === 'nonzero' ? 1n : 0n,
            });
            const result = await registerLinuxEasyReference(f.lease, {
                ...f.registration,
                session,
            });
            expect(result).toMatchObject({
                kind: 'failure',
                stage: 'login',
                code: 'login-rejected',
                writeState: 'not-started',
                poison: 'requested',
            });
            expect(f.fake.calls).toBe(2);
            expect(f.fake.frames).toHaveLength(2);
            expect(f.transaction).toHaveBeenCalledTimes(2);
            expect(f.registration.acceptLogin).not.toHaveBeenCalled();
            expect(f.poison).toHaveBeenCalledOnce();
            expect(await f.lease.whenClosed).toBe('poisoned');
            expect(f.fake.close).toHaveBeenCalledOnce();
        },
    );

    it.each(['missing-code', 'nonzero'] as const)(
        'allows the caller to poison immediately on %s before Register',
        async (status) => {
            const f = setup(status);
            const session = await runLinuxEasyLoginSession(f.lease, f.options);
            expect(session.kind).toBe('response');

            if (session.kind !== 'response') {
                throw new Error('expected synthetic Easy response');
            }

            expect(session.value.status).toEqual({
                kind: 'code',
                codePresent: status !== 'missing-code',
                code: status === 'nonzero' ? 1n : 0n,
            });
            f.lease.poison();
            expect(await f.lease.whenClosed).toBe('poisoned');
            expect(f.fake.calls).toBe(2);
            expect(f.fake.frames).toHaveLength(2);
            expect(f.fake.close).toHaveBeenCalledOnce();
        },
    );

    it.each([0, 1, 2] as const)('rejects a mismatched transport UIN at stage %i', async (stage) => {
        const f = setup();
        f.fake.wrongIdentityAt = stage;
        const session = await runLinuxEasyLoginSession(f.lease, f.options);

        if (stage < 2) {
            expect(session).toMatchObject({ kind: 'failure', poison: 'requested' });
        } else {
            expect(session.kind).toBe('response');

            if (session.kind !== 'response') {
                throw new Error('expected synthetic Easy response');
            }

            const result = await registerLinuxEasyReference(f.lease, {
                ...f.registration,
                session,
            });
            expect(result).toMatchObject({
                kind: 'failure',
                stage: 'register',
                poison: 'requested',
            });
        }

        expect(f.fake.calls).toBe(stage + 1);
        expect(f.fake.frames).toHaveLength(stage);
        expect(f.poison).toHaveBeenCalledOnce();
        expect(await f.lease.whenClosed).toBe('poisoned');
        expect(f.fake.close).toHaveBeenCalledOnce();
    });
});
