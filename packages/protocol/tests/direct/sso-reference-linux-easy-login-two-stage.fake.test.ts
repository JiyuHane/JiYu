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
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import { referenceKeyExchangeOnTransport } from '../../src/direct/sso-reference-key-exchange-flow';
import {
    LINUX_EASY_LOGIN_COMMAND,
    referenceLinuxEasyLoginOnTransport,
} from '../../src/direct/sso-reference-linux-easy-login-flow';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
} from '../../src/direct/sso12-packet-client';

// In-memory synthetic fixture only: 'written' means a recorded frame. The broker's
// quiescence declaration is an owner assertion, not proof of a peer or real QQ.
// The signers and both verifiers are fake policy, not cryptographic authentication.
const UIN = '123456';
const ZERO = new Uint8Array(16);
const KEY = Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i);
const TICKET = Uint8Array.from({ length: 24 }, (_, i) => 0x60 + i);
const GUID = Uint8Array.of(1, 2, 3, 4);
const A2 = Uint8Array.of(0x81, 0, 0xfe);
const A1 = Uint8Array.of(0x10, 0, 0xff, 0x20);
const NONCE = Uint8Array.from({ length: 12 }, (_, i) => i);
const BODY = Uint8Array.of(0xff, 0, 0xc3, 0x28);
const RESERVED = Uint8Array.of(0xaa, 0, 0xfe);
const SEQUENCES = [123, 124] as const;
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

const word = (n: number): Buffer => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(n >>> 0);
    return out;
};

const field = (data: Uint8Array): Buffer => Buffer.concat([word(data.length + 4), data]);

function peer(scalar: number) {
    const ecdh = createECDH('prime256v1');
    const privateKey = Buffer.alloc(32);
    privateKey[31] = scalar;
    ecdh.setPrivateKey(privateKey);
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

// Decode the real emitted request rather than reconstructing its serialization.
function unpack(bytes: Uint8Array) {
    const frame = Buffer.from(bytes);
    expect(frame.readUInt32BE(0)).toBe(frame.length);
    expect(frame.readUInt32BE(4)).toBe(12);
    expect(frame[8]).toBe(2);
    expect(frame.readUInt32BE(9)).toBe(4);
    expect(frame[13]).toBe(0);
    const end = 14 + frame.readUInt32BE(14);
    const uin = frame.subarray(18, end).toString('ascii');
    const sso = Buffer.from(qqTeaDecrypt(frame.subarray(end), ZERO));
    const sequence = sso.readUInt32BE(4);
    const subAppId = sso.readInt32BE(8);
    let offset = 28;

    const take = (width: 2 | 4 = 4): Buffer => {
        const length = width === 2 ? sso.readUInt16BE(offset) : sso.readUInt32BE(offset);
        expect(length).toBeGreaterThanOrEqual(width);
        expect(offset + length).toBeLessThanOrEqual(sso.length);
        const data = sso.subarray(offset + width, offset + length);
        offset += length;
        return data;
    };

    const a2 = take();
    const command = take().toString();
    expect(take().length).toBe(0);
    const guid = take().toString();
    expect(take().length).toBe(0);
    const version = take(2).toString();
    const reserved = take();
    expect(offset).toBe(sso.readUInt32BE(0));
    const body = take();
    expect(offset).toBe(sso.length);
    return { uin, sequence, subAppId, a2, command, guid, version, reserved, body };
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
    readonly candidates: Uint8Array[] = [];
    readonly errors: unknown[] = [];
    calls = 0;
    consumes = 0;
    beforeEasyBuild?: Promise<void>;

    async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        const index = this.calls++;
        const sequence = SEQUENCES[index];

        try {
            if (sequence === undefined) {
                throw new Error('unexpected third transaction');
            }

            if (index === 1 && this.beforeEasyBuild) {
                await this.beforeEasyBuild;
            }

            const identity = { uin: UIN, sequence };
            const built = await options.buildRequest(identity);
            const frame = Uint8Array.from(built.frame);
            this.frames.push(frame);
            const request = unpack(frame);
            let body: Uint8Array;

            if (index === 0) {
                expect(request.command).toBe(KEY_EXCHANGE_COMMAND);
                const requestProto = decodeKeyExchangeRequest(request.body);
                expect(requestProto.publicKey).toBeDefined();
                const ephemeral = peer(2);
                const shared = ephemeral.computeSecret(requestProto.publicKey!);
                const secret = encodeKeyExchangeResponseSecret({
                    sessionKey: KEY,
                    sessionTicket: TICKET,
                    expiration: 300,
                });
                body = encodeKeyExchangeResponse({
                    publicKey: ephemeral.getPublicKey(),
                    secret: seal(secret, shared, Buffer.alloc(12, 0x42)),
                });
            } else {
                expect(request.command).toBe(LINUX_EASY_LOGIN_COMMAND);
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

            const candidate = response(sequence, request.command, body);
            this.candidates.push(candidate);

            if (!(await options.verifyCandidate(candidate, built.context, identity))) {
                return { kind: 'failure', code: 'rejected', writeState: 'unknown' };
            }

            this.consumes++;
            const value = await options.consumeCandidate(candidate, built.context, identity);
            return { kind: 'response', sequence, value, writeState: 'written' };
        } catch (error) {
            this.errors.push(error);
            return { kind: 'failure', code: 'callback-failed', writeState: 'unknown' };
        }
    }
}

function setup(serverAccepted = true) {
    const fake = new FakeClient();
    const lease = createRawSessionBroker(fake, {
        trustedSuccessQuiescence: true,
        isUsable: () => true,
    }).acquire({ deadline: performance.now() + 30000 });
    const signed: { sequence: number; command: string; body: Uint8Array }[] = [];
    const verified: { sequence: number; command: string; request: Uint8Array }[] = [];
    const sign = vi.fn(
        (input: { uin: string; sequence: number; command: string; body: Uint8Array }) => {
            expect(input.uin).toBe(UIN);
            signed.push({
                sequence: input.sequence,
                command: input.command,
                body: Uint8Array.from(input.body),
            });
            return RESERVED;
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
            expect(input.uin).toBe(UIN);
            const index = verified.length;
            expect(same(input.requestFrame, fake.frames[index]!)).toBe(true);
            expect(same(input.responseFrame, fake.candidates[index]!)).toBe(true);
            verified.push({
                sequence: input.sequence,
                command: input.command,
                request: Uint8Array.from(input.requestFrame),
            });
            return true;
        },
    );
    const verifyServer = vi.fn(() => serverAccepted);
    const profile = { uin: UIN, guid: GUID, a2: A2, version: 'synthetic-version', subAppId: 1234 };
    const keyOptions = {
        ...profile,
        serverPublicKey: Uint8Array.from(peer(1).getPublicKey()),
        verifyKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
        timestamp: 1700000000,
        timeoutMs: 5000,
        buildReserved: sign,
        verifyRaw: verify,
        verifyServerResponse: verifyServer,
    };
    const easyOptions = (sessionKey: Uint8Array, sessionTicket: Uint8Array) => ({
        ...profile,
        sessionKey,
        sessionTicket,
        a1: A1,
        nonce: NONCE,
        deviceName: 'fixture-device',
        deviceType: 'fixture-pc',
        appId: 42,
        appName: 'fixture-app',
        qua: 'fixture-qua',
        cookie: 'fixture-cookie',
        timeoutMs: 5000,
        buildReserved: sign,
        verifyRaw: verify,
    });
    return { fake, lease, signed, verified, sign, verify, verifyServer, keyOptions, easyOptions };
}

describe('two-stage Linux EasyLogin reference on one in-memory broker lease', () => {
    it('hands off caller-owned key and ticket, snapshots them, and recovers the response', async () => {
        const f = setup();
        let releaseEasy!: () => void;
        f.fake.beforeEasyBuild = new Promise<void>((resolve) => {
            releaseEasy = resolve;
        });
        let succeeded = false;

        try {
            const keyResult = await referenceKeyExchangeOnTransport(f.lease, f.keyOptions);
            expect(keyResult.kind).toBe('response');

            if (keyResult.kind !== 'response') {
                throw new Error('key exchange failed');
            }

            expect(keyResult.sequence).toBe(SEQUENCES[0]);
            expect(keyResult.value.expiration).toBe(300);
            expect(same(keyResult.value.sessionKey, KEY)).toBe(true);
            expect(same(keyResult.value.sessionTicket, TICKET)).toBe(true);
            expect(keyResult.value.sessionKey.buffer).not.toBe(KEY.buffer);
            expect(keyResult.value.sessionTicket.buffer).not.toBe(TICKET.buffer);
            expect(keyResult.value.sessionKey.buffer).not.toBe(
                keyResult.value.sessionTicket.buffer,
            );

            for (const frame of [...f.fake.frames, ...f.fake.candidates]) {
                expect(keyResult.value.sessionKey.buffer).not.toBe(frame.buffer);
                expect(keyResult.value.sessionTicket.buffer).not.toBe(frame.buffer);
            }

            // The same exact lease object is passed to both real source flows. The
            // async function snapshots its inputs before entering the gated fake.
            const pending = referenceLinuxEasyLoginOnTransport(
                f.lease,
                f.easyOptions(keyResult.value.sessionKey, keyResult.value.sessionTicket),
            );
            keyResult.value.sessionKey.fill(0);
            keyResult.value.sessionTicket.fill(0);
            expect(keyResult.value.sessionKey.every((b) => b === 0)).toBe(true);
            expect(keyResult.value.sessionTicket.every((b) => b === 0)).toBe(true);
            releaseEasy();
            const easyResult = await pending;
            expect(easyResult.kind).toBe('response');

            if (easyResult.kind !== 'response') {
                throw new Error('EasyLogin failed');
            }

            expect(easyResult.sequence).toBe(SEQUENCES[1]);
            expect(easyResult.value.status).toEqual({ kind: 'code', code: 0n, codePresent: true });
            expect(easyResult.value.body).not.toBeNull();
            expect(same(easyResult.value.body!, BODY)).toBe(true);
            expect(f.fake.calls).toBe(2);
            expect(f.fake.consumes).toBe(2);
            expect(f.fake.errors).toEqual([]);
            expect(f.verifyServer).toHaveBeenCalledOnce();
            expect(f.sign).toHaveBeenCalledTimes(2);
            expect(f.verify).toHaveBeenCalledTimes(2);

            const first = unpack(f.fake.frames[0]!);
            const second = unpack(f.fake.frames[1]!);
            expect(first).toMatchObject({
                uin: UIN,
                sequence: SEQUENCES[0],
                command: KEY_EXCHANGE_COMMAND,
                subAppId: 1234,
                guid: '01020304',
                version: 'synthetic-version',
            });
            expect(second).toMatchObject({
                uin: UIN,
                sequence: SEQUENCES[1],
                command: LINUX_EASY_LOGIN_COMMAND,
                subAppId: 1234,
                guid: '01020304',
                version: 'synthetic-version',
            });
            expect(first.sequence).not.toBe(second.sequence);
            expect(same(first.a2, A2)).toBe(true);
            expect(same(second.a2, A2)).toBe(true);
            expect(same(first.reserved, RESERVED)).toBe(true);
            expect(same(second.reserved, RESERVED)).toBe(true);
            expect(f.signed.map(({ sequence, command }) => ({ sequence, command }))).toEqual([
                { sequence: SEQUENCES[0], command: KEY_EXCHANGE_COMMAND },
                { sequence: SEQUENCES[1], command: LINUX_EASY_LOGIN_COMMAND },
            ]);
            expect(f.verified.map(({ sequence, command }) => ({ sequence, command }))).toEqual([
                { sequence: SEQUENCES[0], command: KEY_EXCHANGE_COMMAND },
                { sequence: SEQUENCES[1], command: LINUX_EASY_LOGIN_COMMAND },
            ]);
            expect(same(first.body, f.signed[0]!.body)).toBe(true);
            expect(same(second.body, f.signed[1]!.body)).toBe(true);
            expect(same(second.body, unpack(f.verified[1]!.request).body)).toBe(true);
            const forward = protobuf_decode<LinuxNTLoginReferenceForward>(second.body);
            expect(forward.type).toBe(1);
            expect(same(forward.sessionTicket, TICKET)).toBe(true);
            expect(same(forward.buffer.subarray(0, 12), NONCE)).toBe(true);
            const common = protobuf_decode<LinuxNTLoginReferenceCommon>(open(forward.buffer, KEY));
            expect(common.head.user.account).toBe(UIN);
            expect(common.head.client).toMatchObject({
                deviceName: 'fixture-device',
                deviceType: 'fixture-pc',
                platform: 7,
            });
            expect(same(common.head.client.guid, GUID)).toBe(true);
            expect(common.head.app).toMatchObject({
                version: 'synthetic-version',
                appId: 42,
                appName: 'fixture-app',
                qua: 'fixture-qua',
            });
            expect(common.head.cookie.cookieContent).toBe('fixture-cookie');
            const easyBody = protobuf_decode<LinuxNTEasyLoginReferenceRequestBody>(common.body);
            expect(same(easyBody.a1, A1)).toBe(true);

            for (const source of [
                ...f.fake.frames,
                ...f.fake.candidates,
                ...f.signed.map((s) => s.body),
                KEY,
                TICKET,
                BODY,
            ]) {
                expect(easyResult.value.body!.buffer).not.toBe(source.buffer);
            }

            f.fake.candidates[1]!.fill(0);
            expect(same(easyResult.value.body!, BODY)).toBe(true);
            f.lease.release();
            expect(await f.lease.whenClosed).toBe('released');
            expect(f.fake.close).not.toHaveBeenCalled();
            succeeded = true;
        } finally {
            releaseEasy();

            if (!succeeded) {
                f.lease.poison();
            }
        }
    });

    it('stops before EasyLogin when the key-exchange server verifier rejects', async () => {
        const f = setup(false);

        try {
            const result = await referenceKeyExchangeOnTransport(f.lease, f.keyOptions);
            expect(result.kind).not.toBe('response');
            expect(f.verifyServer).toHaveBeenCalledOnce();
            expect(f.fake.calls).toBe(1);
            expect(f.sign).toHaveBeenCalledTimes(1);
            expect(f.verify).toHaveBeenCalledTimes(1);
        } finally {
            // The broker may already have poisoned on the failed underlying call.
            f.lease.poison();
        }

        expect(await f.lease.whenClosed).toBe('poisoned');
        expect(f.fake.close).toHaveBeenCalledTimes(1);
    });

    it('requires owner poison when EasyLogin fails before entering the still-open lease', async () => {
        const f = setup();
        let terminal = false;
        void f.lease.whenClosed.then(() => {
            terminal = true;
        });

        try {
            const result = await referenceKeyExchangeOnTransport(f.lease, f.keyOptions);
            expect(result.kind).toBe('response');

            if (result.kind !== 'response') {
                throw new Error('key exchange failed');
            }

            try {
                const invalid = {
                    ...f.easyOptions(result.value.sessionKey, result.value.sessionTicket),
                    a1: new Uint8Array(),
                };
                await expect(
                    referenceLinuxEasyLoginOnTransport(f.lease, invalid),
                ).rejects.toThrow();
                await Promise.resolve();
                expect(terminal).toBe(false);
                expect(f.fake.calls).toBe(1);
                expect(f.fake.close).not.toHaveBeenCalled();
            } finally {
                result.value.sessionKey.fill(0);
                result.value.sessionTicket.fill(0);
            }
        } finally {
            f.lease.poison();
        }

        expect(await f.lease.whenClosed).toBe('poisoned');
        expect(f.fake.close).toHaveBeenCalledTimes(1);
    });
});
