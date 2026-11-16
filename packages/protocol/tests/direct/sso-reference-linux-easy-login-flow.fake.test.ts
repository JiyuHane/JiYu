import { createCipheriv, createDecipheriv } from 'node:crypto';
import type {
    LinuxNTEasyLoginReferenceRequestBody,
    LinuxNTLoginReferenceCommon,
    LinuxNTLoginReferenceForward,
    NTLoginForwardRequest,
} from '@snowluma/proto-defs/direct-login';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { referenceLinuxEasyLoginOnTransport } from '../../src/direct/sso-reference-linux-easy-login-flow';
import type {
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';

// Synthetic bytes and an in-memory fake only. A fake write records bytes, and a
// true raw-verifier result is caller policy, not server authentication or login.
const UIN = '123456';
const COMMAND = 'trpc.login.ecdh.EcdhService.SsoNTLoginEasyLogin';
const ZERO = new Uint8Array(16);
const RESPONSE_NONCE = Buffer.from('101112131415161718191a1b', 'hex');
const hex = (s: string): Buffer => Buffer.from(s, 'hex');
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
const wiped = (a: Uint8Array): boolean => a.every((value) => value === 0);

const word = (value: number): Buffer => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value >>> 0);
    return out;
};

const field = (value: Uint8Array): Buffer => Buffer.concat([word(value.length + 4), value]);

type Options = Parameters<typeof referenceLinuxEasyLoginOnTransport>[1];
type Fault =
    | 'uin'
    | 'sequence'
    | 'command'
    | 'retCode'
    | 'dummy'
    | 'protocol'
    | 'encryption'
    | 'tea'
    | 'tag'
    | 'truncated'
    | 'outer-protobuf'
    | 'inner-protobuf';

function fixture(): { options: Options; reserved: Uint8Array } {
    const reserved = Uint8Array.of(0xaa, 0, 0xfe);
    const options: Options = {
        uin: UIN,
        sessionKey: Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i),
        sessionTicket: Uint8Array.of(0, 0x91, 0xff, 0x81),
        a1: Uint8Array.of(0x10, 0, 0xff, 0x20),
        a2: Uint8Array.of(0x81, 0, 0xfe),
        nonce: Uint8Array.from({ length: 12 }, (_, i) => i),
        guid: Uint8Array.of(1, 2, 3, 4),
        version: 'synthetic-version',
        subAppId: 1234,
        deviceName: 'fixture-device',
        deviceType: 'fixture-pc',
        appId: 42,
        appName: 'fixture-app',
        qua: 'fixture-qua',
        cookie: 'fixture-cookie',
        timeoutMs: 5000,
        buildReserved: () => reserved,
        verifyRaw: () => true,
    };
    return { options, reserved };
}

// The real serializer produces the request; this reader checks all framing and
// extracts its body rather than re-implementing request serialization.
function unpack(bytes: Uint8Array) {
    const frame = Buffer.from(bytes);
    expect(frame.readUInt32BE(0)).toBe(frame.length);
    expect(frame.readUInt32BE(4)).toBe(12);
    expect(frame[8]).toBe(2);
    expect(frame.readUInt32BE(9)).toBe(4); // empty D2
    expect(frame[13]).toBe(0);
    const end = 14 + frame.readUInt32BE(14);
    const uin = frame.subarray(18, end).toString('ascii');
    const sso = Buffer.from(qqTeaDecrypt(frame.subarray(end), ZERO));
    const sequence = sso.readUInt32BE(4);
    const subAppId = sso.readInt32BE(8);
    expect(sso.readInt32BE(12)).toBe(2052);
    expect(same(sso.subarray(16, 28), Uint8Array.of(2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).toBe(
        true,
    );
    let offset = 28;

    const take = (width: 2 | 4 = 4): Buffer => {
        const length = width === 2 ? sso.readUInt16BE(offset) : sso.readUInt32BE(offset);
        expect(length).toBeGreaterThanOrEqual(width);
        expect(offset + length).toBeLessThanOrEqual(sso.length);
        const out = sso.subarray(offset + width, offset + length);
        offset += length;
        return out;
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

function seal(plain: Uint8Array, key: Uint8Array): Buffer {
    const cipher = createCipheriv('aes-128-gcm', key, RESPONSE_NONCE);
    return Buffer.concat([
        RESPONSE_NONCE,
        cipher.update(plain),
        cipher.final(),
        cipher.getAuthTag(),
    ]);
}

function response(sequence: number, key: Uint8Array, plain: Uint8Array, fault?: Fault): Uint8Array {
    const encrypted = seal(fault === 'inner-protobuf' ? hex('0a03220208') : plain, key);

    if (fault === 'tag') {
        encrypted[encrypted.length - 1] ^= 1;
    }

    const forward =
        fault === 'outer-protobuf'
            ? hex('1a02ff')
            : protobuf_encode<NTLoginForwardRequest>({
                  sessionTicket: Uint8Array.of(0x42),
                  buffer: encrypted,
                  type: 1,
              });
    const header = Buffer.concat([
        word(fault === 'sequence' ? sequence + 1 : sequence),
        word(fault === 'retCode' ? 1 : 0),
        field(Buffer.alloc(0)),
        field(Buffer.from(fault === 'command' ? 'wrong-command' : COMMAND)),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    const inner = Buffer.concat([field(header), field(forward)]);
    const tea = Buffer.from(qqTeaEncrypt(inner, ZERO));

    if (fault === 'tea') {
        tea.fill(0);
    }

    const frame = Buffer.concat([
        word(0),
        word(fault === 'protocol' ? 13 : 12),
        Buffer.of(fault === 'encryption' ? 0 : 2, fault === 'dummy' ? 1 : 0),
        field(Buffer.from(fault === 'uin' ? '654321' : UIN)),
        tea,
    ]);
    frame.writeUInt32BE(frame.length);
    return Uint8Array.from(fault === 'truncated' ? frame.subarray(0, -3) : frame);
}

class Fake implements Sso12RawTransport {
    sequence = 123;
    initialUin = UIN;
    fault?: Fault;
    plain = hex('0a04220208001204ff00c328');
    key = fixture().options.sessionKey;
    frame?: Uint8Array;
    candidate?: Uint8Array;
    candidateBefore?: Uint8Array;
    consumes = 0;
    calls = 0;
    close = vi.fn();
    beforeBuild?: () => Promise<void>;

    async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        this.calls++;
        const identity = { uin: this.initialUin, sequence: this.sequence };

        try {
            await this.beforeBuild?.();
            const built = await options.buildRequest(identity);
            // Recording a frame is not a network write.
            this.frame = Uint8Array.from(built.frame);
            this.candidate = response(this.sequence, this.key, this.plain, this.fault);
            this.candidateBefore = Uint8Array.from(this.candidate);

            if (!(await options.verifyCandidate(this.candidate, built.context, identity))) {
                return { kind: 'failure', code: 'rejected', writeState: 'unknown' };
            }

            this.consumes++;
            const value = await options.consumeCandidate(this.candidate, built.context, identity);
            return { kind: 'response', sequence: this.sequence, value, writeState: 'written' };
        } catch {
            return { kind: 'failure', code: 'callback-failed', writeState: 'unknown' };
        }
    }
}

async function nonSuccess(
    pending: ReturnType<typeof referenceLinuxEasyLoginOnTransport>,
): Promise<void> {
    const result = await pending.catch(() => ({ kind: 'rejected' as const }));
    expect(result.kind).not.toBe('response');
}

describe('Linux EasyLogin reference transaction on a memory-only fake', () => {
    it.each([123, 0x80000000, 0xffffffff])(
        'binds complete signed frame and snapshots for uint32 sequence %i',
        async (sequence) => {
            const { options, reserved } = fixture();
            const original = {
                sessionKey: Uint8Array.from(options.sessionKey),
                sessionTicket: Uint8Array.from(options.sessionTicket),
                a1: Uint8Array.from(options.a1),
                a2: Uint8Array.from(options.a2!),
                nonce: Uint8Array.from(options.nonce),
                guid: Uint8Array.from(options.guid),
            };
            const fake = new Fake();
            fake.sequence = sequence;
            fake.key = Uint8Array.from(original.sessionKey);
            let enter!: () => void;
            let release!: () => void;
            const ready = new Promise<void>((resolve) => {
                enter = resolve;
            });
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });

            fake.beforeBuild = async () => {
                enter();
                await gate;
            };

            let signed!: Uint8Array;
            let borrowed!: Uint8Array;
            let requestCopy!: Uint8Array;
            let responseCopy!: Uint8Array;

            options.buildReserved = async (input) => {
                expect(input).toMatchObject({ uin: UIN, sequence, command: COMMAND });
                borrowed = input.body;
                signed = Uint8Array.from(input.body);
                await Promise.resolve();
                return reserved;
            };

            options.verifyRaw = async (input) => {
                expect(input).toMatchObject({ uin: UIN, sequence, command: COMMAND });
                requestCopy = input.requestFrame;
                responseCopy = input.responseFrame;
                expect(same(input.requestFrame, fake.frame!)).toBe(true);
                expect(same(input.responseFrame, fake.candidateBefore!)).toBe(true);
                input.requestFrame.fill(0x11);
                input.responseFrame.fill(0x22);
                await Promise.resolve();
                return true;
            };

            const pending = referenceLinuxEasyLoginOnTransport(fake, options);
            await ready;
            options.sessionKey.fill(0xe1);
            options.sessionTicket.fill(0xe2);
            options.a1.fill(0xe3);
            options.a2!.fill(0xe4);
            options.nonce.fill(0xe5);
            options.guid.fill(0xe6);
            options.uin = '987654';
            options.version = 'changed';
            options.subAppId = 9;
            options.deviceName = 'changed';
            options.deviceType = 'changed';
            options.appId = 9;
            options.appName = 'changed';
            options.qua = 'changed';
            options.cookie = 'changed';
            release();
            const result = await pending;
            expect(result.kind).toBe('response');

            if (result.kind !== 'response') {
                return;
            }

            expect(result.sequence).toBe(sequence);
            expect(result.value.status).toEqual({ kind: 'code', code: 0n, codePresent: true });
            expect(same(result.value.body!, hex('ff00c328'))).toBe(true);
            const parsed = unpack(fake.frame!);
            expect(parsed).toMatchObject({
                uin: UIN,
                sequence,
                subAppId: 1234,
                command: COMMAND,
                guid: '01020304',
                version: 'synthetic-version',
            });
            expect(same(parsed.a2, original.a2)).toBe(true);
            expect(same(parsed.reserved, reserved)).toBe(true);
            expect(same(parsed.body, signed)).toBe(true);
            const forward = protobuf_decode<LinuxNTLoginReferenceForward>(parsed.body);
            expect(forward.type).toBe(1);
            expect(same(forward.sessionTicket, original.sessionTicket)).toBe(true);
            expect(same(forward.buffer.subarray(0, 12), original.nonce)).toBe(true);
            const decipher = createDecipheriv(
                'aes-128-gcm',
                original.sessionKey,
                forward.buffer.subarray(0, 12),
            );
            decipher.setAuthTag(forward.buffer.subarray(-16));
            const plain = Buffer.concat([
                decipher.update(forward.buffer.subarray(12, -16)),
                decipher.final(),
            ]);
            const common = protobuf_decode<LinuxNTLoginReferenceCommon>(plain);
            expect(common.head.user.account).toBe(UIN);
            expect(common.head.client).toMatchObject({
                deviceName: 'fixture-device',
                deviceType: 'fixture-pc',
                platform: 7,
            });
            expect(same(common.head.client.guid, original.guid)).toBe(true);
            expect(common.head.app).toMatchObject({
                version: 'synthetic-version',
                appId: 42,
                appName: 'fixture-app',
                qua: 'fixture-qua',
            });
            expect(common.head.cookie.cookieContent).toBe('fixture-cookie');
            expect(common.head.sdk.version).toBe(1);
            const easy = protobuf_decode<LinuxNTEasyLoginReferenceRequestBody>(common.body);
            expect(same(easy.a1, original.a1)).toBe(true);
            expect(
                same(
                    common.body,
                    protobuf_encode<LinuxNTEasyLoginReferenceRequestBody>({ a1: original.a1 }),
                ),
            ).toBe(true);
            expect(same(fake.candidate!, fake.candidateBefore!)).toBe(true);
            expect([borrowed, requestCopy, responseCopy].every(wiped)).toBe(true);
            expect(same(reserved, Uint8Array.of(0xaa, 0, 0xfe))).toBe(true);
            expect(fake.close).not.toHaveBeenCalled();
            expect(fake.calls).toBe(1);
            expect(fake.consumes).toBe(1);

            for (const other of [
                fake.frame!,
                fake.candidate!,
                signed,
                borrowed,
                requestCopy,
                responseCopy,
                ...Object.values(original),
            ]) {
                expect(result.value.body!.buffer).not.toBe(other.buffer);
            }

            fake.frame!.fill(0);
            fake.candidate!.fill(0);
            expect(same(result.value.body!, hex('ff00c328'))).toBe(true);
        },
    );

    it.each([
        ['', { kind: 'missing-head' }, null],
        ['1200', { kind: 'missing-head' }, ''],
        ['0a00', { kind: 'missing-error-info' }, null],
        ['0a022200', { kind: 'code', code: 0n, codePresent: false }, null],
        ['0a0422020800', { kind: 'code', code: 0n, codePresent: true }, null],
        ['0a04220208011204ff00c328', { kind: 'code', code: 1n, codePresent: true }, 'ff00c328'],
    ] as const)('preserves status and raw body for Common wire %s', async (wire, status, body) => {
        const { options } = fixture();
        const before = [
            options.sessionKey,
            options.sessionTicket,
            options.a1,
            options.a2!,
            options.nonce,
            options.guid,
        ].map((v) => Uint8Array.from(v));
        const fake = new Fake();
        fake.plain = hex(wire);
        const result = await referenceLinuxEasyLoginOnTransport(fake, options);
        expect(result.kind).toBe('response');

        if (result.kind !== 'response') {
            return;
        }

        expect(result.value.status).toEqual(status);

        if (body === null) {
            expect(result.value.body).toBeNull();
        } else {
            expect(result.value.body).not.toBeNull();
            expect(same(result.value.body!, hex(body))).toBe(true);
            fake.candidate!.fill(0);
            expect(same(result.value.body!, hex(body))).toBe(true);
        }

        [
            options.sessionKey,
            options.sessionTicket,
            options.a1,
            options.a2!,
            options.nonce,
            options.guid,
        ].forEach((v, i) => expect(same(v, before[i]!)).toBe(true));
    });

    it('rejects mismatched transport UIN before signer and fake write', async () => {
        const { options } = fixture();
        const fake = new Fake();
        fake.initialUin = '987654';
        options.buildReserved = vi.fn(() => Uint8Array.of(1));
        await nonSuccess(referenceLinuxEasyLoginOnTransport(fake, options));
        expect(options.buildReserved).not.toHaveBeenCalled();
        expect(fake.frame).toBeUndefined();
        expect(fake.consumes).toBe(0);
    });

    it('rejects a signer mutating its borrowed body before fake write or consume', async () => {
        const { options, reserved } = fixture();
        const fake = new Fake();
        let borrowed!: Uint8Array;
        options.buildReserved = vi.fn(({ body }) => {
            borrowed = body;
            body[0] ^= 0xff;
            return reserved;
        });
        options.verifyRaw = vi.fn(() => true);
        await nonSuccess(referenceLinuxEasyLoginOnTransport(fake, options));
        expect(options.buildReserved).toHaveBeenCalledOnce();
        expect(options.verifyRaw).not.toHaveBeenCalled();
        expect(fake.frame).toBeUndefined();
        expect(fake.consumes).toBe(0);
        expect(wiped(borrowed)).toBe(true);
        expect(same(reserved, Uint8Array.of(0xaa, 0, 0xfe))).toBe(true);
    });

    it.each(['false', 'throw'] as const)(
        'does not consume when raw verifier returns %s',
        async (mode) => {
            const { options } = fixture();
            const fake = new Fake();
            let req!: Uint8Array;
            let res!: Uint8Array;
            options.verifyRaw = vi.fn((input) => {
                req = input.requestFrame;
                res = input.responseFrame;
                req.fill(1);
                res.fill(2);

                if (mode === 'throw') {
                    throw new Error('synthetic verifier failure');
                }

                return false;
            });
            await nonSuccess(referenceLinuxEasyLoginOnTransport(fake, options));
            expect(options.verifyRaw).toHaveBeenCalledOnce();
            expect(fake.consumes).toBe(0);
            expect(same(fake.candidate!, fake.candidateBefore!)).toBe(true);
            expect(wiped(req)).toBe(true);
            expect(wiped(res)).toBe(true);
        },
    );

    it.each([
        'uin',
        'sequence',
        'command',
        'retCode',
        'dummy',
        'protocol',
        'encryption',
        'tea',
        'tag',
        'truncated',
        'outer-protobuf',
        'inner-protobuf',
    ] as const)('does not commit a response with fault %s', async (fault) => {
        const { options } = fixture();
        const inputs = [
            options.sessionKey,
            options.sessionTicket,
            options.a1,
            options.a2!,
            options.nonce,
            options.guid,
        ];
        const before = inputs.map((v) => Uint8Array.from(v));
        const fake = new Fake();
        fake.fault = fault;
        await nonSuccess(referenceLinuxEasyLoginOnTransport(fake, options));
        inputs.forEach((v, i) => expect(same(v, before[i]!)).toBe(true));
        expect(fake.close).not.toHaveBeenCalled();
    });

    it('defaults omitted A2 to an empty SSO field', async () => {
        const { options } = fixture();
        delete options.a2;
        const fake = new Fake();
        const result = await referenceLinuxEasyLoginOnTransport(fake, options);
        expect(result.kind).toBe('response');
        expect(unpack(fake.frame!).a2.length).toBe(0);
    });

    it('does not enter the fake transport on a pre-aborted signal', async () => {
        const { options } = fixture();
        const fake = new Fake();
        const controller = new AbortController();
        controller.abort();
        options.signal = controller.signal;
        await nonSuccess(referenceLinuxEasyLoginOnTransport(fake, options));
        expect(fake.calls).toBe(0);
    });
});
