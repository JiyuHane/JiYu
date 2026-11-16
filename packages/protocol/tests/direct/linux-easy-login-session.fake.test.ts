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

// Entirely in memory. This fixture establishes local sequencing, not a peer identity,
// expiry interpretation, nonce uniqueness, or coordination with external lease users.
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
// Exercise uint32 on both sides of signed int32 boundary.
const SEQUENCES = [0x80000001, 0xf0000002] as const;
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

const word = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    return b;
};

const field = (data: Uint8Array) => Buffer.concat([word(data.length + 4), data]);

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

type Case =
    | 'ok'
    | 'key-malformed'
    | 'wrong-expiration'
    | 'easy-malformed'
    | 'easy-invalid'
    | 'easy-failure';
class FakeClient implements Sso12RawClient {
    readonly whenClosed = new Promise<Sso12CloseReason>(() => {});
    readonly close = vi.fn();
    readonly frames: Uint8Array[] = [];
    readonly candidates: Uint8Array[] = [];
    readonly errors: unknown[] = [];
    calls = 0;
    consumes = 0;
    gate?: Promise<void>;
    entered!: () => void;
    readonly firstEntered = new Promise<void>((resolve) => {
        this.entered = resolve;
    });
    scenario: Case = 'ok';
    body: Uint8Array | null = BODY;

    async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        const index = this.calls++;
        const sequence = SEQUENCES[index];

        try {
            if (sequence === undefined) {
                throw new Error('unexpected extra transaction');
            }

            const identity = { uin: UIN, sequence };
            const built = await options.buildRequest(identity);
            const frame = Uint8Array.from(built.frame);
            this.frames.push(frame);
            const request = unpack(frame);

            if (index === 0) {
                this.entered();

                if (this.gate) {
                    await this.gate;
                }
            }

            if (index === 1 && this.scenario === 'easy-failure') {
                return { kind: 'failure', code: 'synthetic-failure', writeState: 'unknown' };
            }

            let body: Uint8Array;

            if (index === 0) {
                expect(request.command).toBe(KEY_EXCHANGE_COMMAND);
                const decoded = decodeKeyExchangeRequest(request.body);
                const ephemeral = peer(2);
                const shared = ephemeral.computeSecret(decoded.publicKey!);
                const secret = encodeKeyExchangeResponseSecret({
                    sessionKey: KEY,
                    sessionTicket: TICKET,
                    expiration: this.scenario === 'wrong-expiration' ? 301 : 300,
                });
                body =
                    this.scenario === 'key-malformed'
                        ? Uint8Array.of(0xff)
                        : encodeKeyExchangeResponse({
                              publicKey: ephemeral.getPublicKey(),
                              secret: seal(secret, shared, Buffer.alloc(12, 0x42)),
                          });
            } else {
                expect(request.command).toBe(LINUX_EASY_LOGIN_COMMAND);
                const common = protobuf_encode<LinuxNTLoginReferenceResponseCommon>({
                    head: { errorInfo: { code: 0n } },
                    ...(this.body === null ? {} : { body: this.body }),
                });
                body = protobuf_encode<NTLoginForwardRequest>({
                    sessionTicket: Uint8Array.of(0x42),
                    buffer: seal(common, KEY, Buffer.from('101112131415161718191a1b', 'hex')),
                    type: 1,
                });

                if (this.scenario === 'easy-malformed') {
                    body = Uint8Array.of(0xff);
                }
            }

            const candidate = response(sequence, request.command, body);

            if (index === 1 && this.scenario === 'easy-invalid') {
                candidate[9] = 1;
            }

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

function setup() {
    const fake = new FakeClient();
    const lease = createRawSessionBroker(fake, {
        trustedSuccessQuiescence: true,
        isUsable: () => true,
    }).acquire({ deadline: performance.now() + 30000 });
    const poison = vi.spyOn(lease, 'poison');
    const transaction = vi.spyOn(lease, 'transactRaw');
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
    const verifyServer = vi.fn(() => true);
    const accept = vi.fn(
        ({ uin, expiration }: { uin: string; expiration: number | undefined }) =>
            uin === UIN && expiration === 300,
    );
    const options = {
        uin: UIN,
        guid: Uint8Array.from(GUID),
        a2: Uint8Array.from(A2),
        version: 'synthetic-version',
        subAppId: 1234,
        serverPublicKey: Uint8Array.from(peer(1).getPublicKey()),
        verifyKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
        timestamp: 1700000000,
        a1: Uint8Array.from(A1),
        nonce: Uint8Array.from(NONCE),
        deviceName: 'fixture-device',
        deviceType: 'fixture-pc',
        appId: 42,
        appName: 'fixture-app',
        qua: 'fixture-qua',
        cookie: 'fixture-cookie',
        timeoutMs: 5000,
        buildReserved: sign,
        verifyRaw: verify,
        verifyServerResponse: verifyServer,
        acceptKeyExchange: accept,
    };
    return {
        fake,
        lease,
        poison,
        transaction,
        signed,
        verified,
        sign,
        verify,
        verifyServer,
        accept,
        options,
    };
}

async function nonSuccess(action: () => Promise<unknown>) {
    let value: unknown;

    try {
        value = await action();
    } catch {
        // Duplicate ownership may be rejected by throwing before a second claim.
        return;
    }

    expect(value).toMatchObject({ kind: 'failure' });
}

describe('Linux EasyLogin two-stage session on one in-memory lease', () => {
    it('snapshots the entire input before the first gated stage and returns caller-owned output', async () => {
        const f = setup();
        let release!: () => void;
        f.fake.gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        try {
            const pending = runLinuxEasyLoginSession(f.lease, f.options);
            // Mutation occurs after the call returned its Promise, before the KE response.
            f.options.guid.fill(0);
            f.options.a2.fill(0);
            f.options.a1.fill(0);
            f.options.nonce.fill(0);
            f.options.serverPublicKey.fill(0);
            f.options.verifyKey.fill(0);
            f.options.version = 'changed';
            f.options.deviceName = 'changed';
            f.options.deviceType = 'changed';
            f.options.appId = 99;
            f.options.appName = 'changed';
            f.options.qua = 'changed';
            f.options.cookie = 'changed';
            f.options.uin = '999';
            f.options.subAppId = 99;
            f.options.timestamp = 1;
            await f.fake.firstEntered;
            expect(f.fake.calls).toBe(1);
            release();
            const result = await pending;
            expect(result.kind).toBe('response');

            if (result.kind !== 'response') {
                throw new Error('expected response');
            }

            expect(result.keyExchangeSequence).toBe(SEQUENCES[0]);
            expect(result.easyLoginSequence).toBe(SEQUENCES[1]);
            expect(result.value.status).toEqual({ kind: 'code', code: 0n, codePresent: true });
            expect(result.value.body).not.toBeNull();
            expect(same(result.value.body!, BODY)).toBe(true);
            expect(f.fake.calls).toBe(2);
            expect(f.fake.consumes).toBe(2);
            expect(f.fake.errors).toEqual([]);
            expect(f.transaction).toHaveBeenCalledTimes(2);
            expect(f.transaction.mock.contexts).toEqual([f.lease, f.lease]);
            expect(f.accept).toHaveBeenCalledExactlyOnceWith({ uin: UIN, expiration: 300 });
            expect(f.verifyServer).toHaveBeenCalledOnce();
            expect(f.sign).toHaveBeenCalledTimes(2);
            expect(f.verify).toHaveBeenCalledTimes(2);
            const first = unpack(f.fake.frames[0]!);
            const second = unpack(f.fake.frames[1]!);

            for (const [request, index, command] of [
                [first, 0, KEY_EXCHANGE_COMMAND],
                [second, 1, LINUX_EASY_LOGIN_COMMAND],
            ] as const) {
                expect(request).toMatchObject({
                    uin: UIN,
                    sequence: SEQUENCES[index],
                    command,
                    subAppId: 1234,
                    guid: '01020304',
                    version: 'synthetic-version',
                });
                expect(same(request.a2, A2)).toBe(true);
                expect(same(request.reserved, RESERVED)).toBe(true);
                expect(same(request.body, f.signed[index]!.body)).toBe(true);
                expect(same(f.verified[index]!.request, f.fake.frames[index]!)).toBe(true);
                expect(f.signed[index]).toMatchObject({ sequence: SEQUENCES[index], command });
                expect(f.verified[index]).toMatchObject({ sequence: SEQUENCES[index], command });
            }

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
            expect(
                same(protobuf_decode<LinuxNTEasyLoginReferenceRequestBody>(common.body).a1, A1),
            ).toBe(true);

            for (const source of [
                ...f.fake.frames,
                ...f.fake.candidates,
                ...f.signed.map((s) => s.body),
                KEY,
                TICKET,
                BODY,
            ]) {
                expect(result.value.body!.buffer).not.toBe(source.buffer);
            }

            f.fake.candidates[1]!.fill(0);
            expect(same(result.value.body!, BODY)).toBe(true);
            result.value.body!.fill(0);
            expect(same(BODY, Uint8Array.of(0xff, 0, 0xc3, 0x28))).toBe(true);
            expect(f.poison).not.toHaveBeenCalled();
            expect(f.fake.close).not.toHaveBeenCalled();
            f.lease.release();
            expect(await f.lease.whenClosed).toBe('released');
            expect(f.fake.close).not.toHaveBeenCalled();
        } finally {
            release();
            f.lease.poison();
        }
    });

    it.each([null, new Uint8Array(0)])(
        'preserves absent or empty response body from decoder',
        async (body) => {
            const f = setup();
            f.fake.body = body;

            try {
                const result = await runLinuxEasyLoginSession(f.lease, f.options);
                expect(result.kind).toBe('response');

                if (result.kind !== 'response') {
                    throw new Error('expected response');
                }

                expect(result.value.status).toEqual({ kind: 'code', code: 0n, codePresent: true });

                if (body === null) {
                    expect(result.value.body).toBeNull();
                } else {
                    expect(result.value.body).not.toBeNull();
                    expect(result.value.body!.length).toBe(0);
                }

                f.lease.release();
                expect(await f.lease.whenClosed).toBe('released');
                expect(f.fake.close).not.toHaveBeenCalled();
            } finally {
                f.lease.poison();
            }
        },
    );

    it.each(['verifier', 'policy', 'wrong-expiration', 'key-malformed'] as const)(
        'stops and poisons after first-stage %s',
        async (scenario) => {
            const f = setup();

            if (scenario === 'verifier') {
                f.verifyServer.mockReturnValue(false);
            }

            if (scenario === 'policy') {
                f.accept.mockReturnValue(false);
            }

            if (scenario === 'wrong-expiration' || scenario === 'key-malformed') {
                f.fake.scenario = scenario;
            }

            try {
                const result = await runLinuxEasyLoginSession(f.lease, f.options);
                expect(result.kind).toBe('failure');

                if (result.kind !== 'failure') {
                    throw new Error('unexpected credential-bearing response');
                }

                expect(typeof result.stage).toBe('string');
                expect(typeof result.code).toBe('string');
                expect(result.easyLoginWrite).toBe('not-started');
                expect(['requested', 'uncertain']).toContain(result.poison);
                expect(result).not.toHaveProperty('value');
                expect(f.fake.calls).toBe(1);
                expect(f.transaction).toHaveBeenCalledTimes(1);
                expect(f.poison).toHaveBeenCalledTimes(1);
                expect(await f.lease.whenClosed).toBe('poisoned');
                expect(f.fake.close).toHaveBeenCalledTimes(1);

                if (scenario === 'wrong-expiration') {
                    expect(f.accept).toHaveBeenCalledExactlyOnceWith({ uin: UIN, expiration: 301 });
                }
            } finally {
                f.lease.poison();
            }
        },
    );

    it.each(['easy-malformed', 'easy-invalid', 'easy-failure'] as const)(
        'records first write and poisons on second-stage %s',
        async (scenario) => {
            const f = setup();
            f.fake.scenario = scenario;

            try {
                const result = await runLinuxEasyLoginSession(f.lease, f.options);
                expect(result.kind).toBe('failure');

                if (result.kind !== 'failure') {
                    throw new Error('unexpected response');
                }

                expect(result.keyExchangeWrite).toBe('written');
                expect(['unknown', 'not-written']).toContain(result.easyLoginWrite);
                expect(['requested', 'uncertain']).toContain(result.poison);
                expect(typeof result.stage).toBe('string');
                expect(typeof result.code).toBe('string');
                expect(result).not.toHaveProperty('value');
                expect(f.fake.calls).toBe(2);
                expect(f.transaction).toHaveBeenCalledTimes(2);
                expect(f.poison).toHaveBeenCalledTimes(1);
                expect(await f.lease.whenClosed).toBe('poisoned');
                expect(f.fake.close).toHaveBeenCalledTimes(1);
            } finally {
                f.lease.poison();
            }
        },
    );

    it('rejects concurrent duplicate use of the exact lease without disturbing the owner', async () => {
        const f = setup();
        let release!: () => void;
        f.fake.gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        try {
            const first = runLinuxEasyLoginSession(f.lease, f.options);
            await f.fake.firstEntered;
            await nonSuccess(() => runLinuxEasyLoginSession(f.lease, f.options));
            expect(f.transaction).toHaveBeenCalledTimes(1);
            expect(f.fake.calls).toBe(1);
            expect(f.poison).not.toHaveBeenCalled();
            expect(f.fake.close).not.toHaveBeenCalled();
            release();
            const result = await first;
            expect(result.kind).toBe('response');
            expect(f.transaction).toHaveBeenCalledTimes(2);
            f.lease.release();
            expect(await f.lease.whenClosed).toBe('released');
            expect(f.fake.close).not.toHaveBeenCalled();
        } finally {
            release();
            f.lease.poison();
        }
    });
});
