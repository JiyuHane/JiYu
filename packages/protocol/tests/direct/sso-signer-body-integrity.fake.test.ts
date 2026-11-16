import type {
    DirectSendMessageRequest,
    DirectSendMessageResponse,
} from '@snowluma/proto-defs/direct-send-message';
import type { SsoRegisterRequest, SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import type { DirectSsoReserve } from '@snowluma/proto-defs/sso-reserve';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createSsoReserveBuilder } from '../../src/direct/sso-reserve';
import { SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import {
    referenceRegisterOnTransport,
    type SsoReferenceRegisterBorrowedOptions,
} from '../../src/direct/sso-reference-register-flow';
import {
    referenceSendTextOnTransport,
    type SsoReferenceSendTextOptions,
} from '../../src/direct/sso-reference-send-text-flow';
import type { Sso12RawOptions, Sso12RawTransport } from '../../src/direct/sso12-packet-client';

// Synthetic bytes and in-memory callbacks only: these assertions do not establish
// cryptographic signing, peer authentication, receipt, or real message delivery.
const key = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const sequence = 0xf0000001;
const identity = { uin: '123', sequence };

const word = (n: number): Buffer => {
    const value = Buffer.alloc(4);
    value.writeUInt32BE(n >>> 0);
    return value;
};

const field = (value: Uint8Array): Buffer => Buffer.concat([word(value.length + 4), value]);

function response(command: string, body: Uint8Array): Uint8Array {
    const header = Buffer.concat([
        word(sequence),
        word(0),
        field(Buffer.alloc(0)),
        field(Buffer.from(command)),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    const cipher = qqTeaEncrypt(Buffer.concat([field(header), field(body)]), key);
    const uin = Buffer.from(identity.uin);
    return Buffer.concat([
        word(14 + uin.length + cipher.length),
        word(12),
        Buffer.of(1, 0),
        field(uin),
        cipher,
    ]);
}

function requestParts(frame: Uint8Array): { body: Uint8Array; reserved: Uint8Array } {
    const wire = Buffer.from(frame);
    const ticketEnd = 9 + wire.readUInt32BE(9);
    const accountStart = ticketEnd + 1;
    const accountEnd = accountStart + wire.readUInt32BE(accountStart);
    const inner = Buffer.from(qqTeaDecrypt(wire.subarray(accountEnd), key));
    const headerEnd = inner.readUInt32BE(0);
    let position = 28;

    const readField = (): Buffer => {
        const end = position + inner.readUInt32BE(position);
        const result = inner.subarray(position + 4, end);
        position = end;
        return result;
    };

    readField(); // A2
    readField(); // command
    readField(); // empty
    readField(); // GUID
    readField(); // empty
    position += inner.readUInt16BE(position);
    return {
        reserved: Uint8Array.from(readField()),
        body: Uint8Array.from(inner.subarray(headerEnd + 4)),
    };
}

function fixture(command: string, body: Uint8Array) {
    const writes: Uint8Array[] = [];
    let calls = 0;
    let built = 0;
    let observedTimeout: number | undefined;
    const transport: Sso12RawTransport = {
        async transactRaw<C, T>(raw: Sso12RawOptions<C, T>) {
            calls++;
            observedTimeout = raw.timeoutMs;

            try {
                const request = await raw.buildRequest(identity);
                built++;
                // This counter is the fixture's write boundary, not real I/O.
                writes.push(Uint8Array.from(request.frame));
                const candidate = response(command, body);

                if (!(await raw.verifyCandidate(candidate, request.context, identity))) {
                    return {
                        kind: 'failure' as const,
                        code: 'fixture-rejected',
                        writeState: 'unknown' as const,
                    };
                }

                const value = await raw.consumeCandidate(candidate, request.context, identity);
                return {
                    kind: 'response' as const,
                    sequence,
                    value,
                    writeState: 'written' as const,
                };
            } catch {
                return {
                    kind: 'failure' as const,
                    code: 'fixture-build-failed',
                    writeState: 'not-written' as const,
                };
            }
        },
    };
    return {
        transport,
        writes,
        get calls() {
            return calls;
        },
        get built() {
            return built;
        },
        get timeout() {
            return observedTimeout;
        },
    };
}

function shared() {
    return {
        login: {
            status: 'tickets' as const,
            uin: '123',
            tickets: {
                d2: Uint8Array.of(3, 4),
                d2Key: Uint8Array.from(key),
                a1: Uint8Array.of(5),
                a2: Uint8Array.of(6, 7),
            },
        },
        profile: { subAppId: 42, guid: Uint8Array.of(0xab, 0xcd), version: 'header-v' },
        timeoutMs: 1000,
        buildReserved: () => Uint8Array.of(8),
        verifyRaw: () => true,
    };
}

function registerOptions(): SsoReferenceRegisterBorrowedOptions {
    return {
        ...shared(),
        registration: {
            uid: 'fixture-uid',
            version: 'build-v',
            deviceName: 'name',
            deviceType: 'type',
            vendorOs: 'os',
            random: 4,
        },
    };
}

function sendOptions(): SsoReferenceSendTextOptions {
    return {
        ...shared(),
        uid: 'fixture-uid',
        request: {
            route: { kind: 'private', peerUin: 456n, peerUid: 'fixture-peer' },
            text: 'synthetic text',
            clientSequence: 9007199254740993n,
            random: 0x12345678,
        },
        maxResponseBodyBytes: 65536,
    };
}

function assertFixture(f: ReturnType<typeof fixture>, expectedWrites: number) {
    expect(f.calls).toBe(1);
    expect(f.timeout).toBeGreaterThan(0);
    expect(f.timeout).toBeLessThanOrEqual(1000);
    expect(f.built).toBe(expectedWrites);
    expect(f.writes).toHaveLength(expectedWrites);
}

const reserveRequest = () => ({
    uin: '123',
    command: 'synthetic.command',
    sequence,
    body: Uint8Array.of(1, 2, 3),
});

describe('synthetic signer body integrity', () => {
    it('snapshots unchanged and aliased signature fields before cleanup', async () => {
        for (const alias of [false, true]) {
            const input = reserveRequest();
            const before = Uint8Array.from(input.body);
            let borrowed!: Uint8Array;
            const sign = vi.fn(async ({ body }: { body: Uint8Array }) => {
                borrowed = body;
                expect(body).toEqual(before);
                return alias
                    ? { sign: body, token: body.subarray(0, 2), extra: body.subarray(2) }
                    : { sign: Uint8Array.of(7), token: Uint8Array.of(8), extra: Uint8Array.of(9) };
            });
            const build = createSsoReserveBuilder({
                uin: '123',
                classifySigning: () => 'sign',
                createTraceParent: () => 'trace',
                sign,
            });
            const decoded = protobuf_decode<DirectSsoReserve>(await build(input));
            expect(decoded.secureInfo).toMatchObject(
                alias
                    ? { sign: before, token: before.subarray(0, 2), extra: before.subarray(2) }
                    : { sign: Uint8Array.of(7), token: Uint8Array.of(8), extra: Uint8Array.of(9) },
            );
            expect(input.body).toEqual(before);
            expect(sign).toHaveBeenCalledOnce();
            // The producer may wipe its private callback copy after saving outputs.
            expect(borrowed).not.toBe(input.body);
        }
    });

    it('rejects persistent mutation and detachment, but a restored byte is outside the detection boundary', async () => {
        for (const mode of ['mutate', 'detach', 'restore'] as const) {
            const input = reserveRequest();
            const before = Uint8Array.from(input.body);
            const build = createSsoReserveBuilder({
                uin: '123',
                classifySigning: () => 'sign',
                createTraceParent: () => 'trace',
                sign: async ({ body }) => {
                    if (mode === 'detach') {
                        structuredClone(body.buffer, { transfer: [body.buffer as ArrayBuffer] });
                    } else {
                        body[0] ^= 0xff;

                        if (mode === 'restore') {
                            body[0] ^= 0xff;
                        }
                    }

                    return {
                        sign: Uint8Array.of(9),
                        token: Uint8Array.of(8),
                        extra: Uint8Array.of(7),
                    };
                },
            });

            if (mode === 'restore') {
                const metadata = protobuf_decode<DirectSsoReserve>(await build(input));
                expect(metadata.secureInfo?.sign).toEqual(Uint8Array.of(9));
            } else {
                await expect(build(input)).rejects.toThrow();
            }

            expect(input.body).toEqual(before);
        }
    });

    it.each(['register', 'send'] as const)(
        'rejects a modified %s callback body before the fake write',
        async (kind) => {
            const options = kind === 'register' ? registerOptions() : sendOptions();
            const inputs = structuredClone({ login: options.login, profile: options.profile });
            const sendInput =
                kind === 'send'
                    ? structuredClone((options as SsoReferenceSendTextOptions).request)
                    : undefined;
            const sign = vi.fn(({ body }: Parameters<typeof options.buildReserved>[0]) => {
                expect(body.length).toBeGreaterThan(0);
                body[0] ^= 0xff;
                return Uint8Array.of(8, 9); // Nonempty synthetic metadata.
            });
            options.buildReserved = sign;
            const command = kind === 'register' ? SSO_INFO_SYNC_COMMAND : 'MessageSvc.PbSendMsg';
            const f = fixture(command, new Uint8Array());
            const result =
                kind === 'register'
                    ? await referenceRegisterOnTransport(
                          f.transport,
                          options as SsoReferenceRegisterBorrowedOptions,
                      )
                    : await referenceSendTextOnTransport(
                          f.transport,
                          options as SsoReferenceSendTextOptions,
                      );
            expect(result).toMatchObject({ kind: 'failure' });
            assertFixture(f, 0);
            expect(sign).toHaveBeenCalledOnce();
            expect({ login: options.login, profile: options.profile }).toEqual(inputs);

            if (kind === 'send') {
                expect((options as SsoReferenceSendTextOptions).request).toEqual(sendInput);
            }
        },
    );

    it.each(['register', 'send'] as const)(
        'keeps normal and alias-returning %s callbacks working',
        async (kind) => {
            for (const alias of [false, true]) {
                const options = kind === 'register' ? registerOptions() : sendOptions();
                let signedBody!: Uint8Array;
                options.buildReserved = vi.fn(
                    ({ uin, uid, sequence: actualSequence, command, body }) => {
                        expect({ uin, uid, sequence: actualSequence, command }).toEqual({
                            uin: '123',
                            uid: 'fixture-uid',
                            sequence,
                            command:
                                kind === 'register'
                                    ? SSO_INFO_SYNC_COMMAND
                                    : 'MessageSvc.PbSendMsg',
                        });
                        signedBody = Uint8Array.from(body);
                        return alias ? body : Uint8Array.of(8, 9);
                    },
                );
                const command =
                    kind === 'register' ? SSO_INFO_SYNC_COMMAND : 'MessageSvc.PbSendMsg';
                const reply =
                    kind === 'register'
                        ? protobuf_encode<SsoRegisterResponse>({
                              register: { message: 'register success' },
                          })
                        : protobuf_encode<DirectSendMessageResponse>({
                              result: 0,
                              clientSequence: 88n,
                          });
                const f = fixture(command, reply);
                const result =
                    kind === 'register'
                        ? await referenceRegisterOnTransport(
                              f.transport,
                              options as SsoReferenceRegisterBorrowedOptions,
                          )
                        : await referenceSendTextOnTransport(
                              f.transport,
                              options as SsoReferenceSendTextOptions,
                          );
                expect(result).toMatchObject({ kind: 'response', sequence, writeState: 'written' });
                assertFixture(f, 1);
                const written = requestParts(f.writes[0]);
                expect(written.body).toEqual(signedBody);
                expect(written.reserved).toEqual(alias ? signedBody : Uint8Array.of(8, 9));

                if (kind === 'register') {
                    expect(
                        protobuf_decode<SsoRegisterRequest>(written.body).register,
                    ).toMatchObject({ guid: 'ABCD', buildVersion: 'build-v' });
                } else {
                    const decoded = protobuf_decode<DirectSendMessageRequest>(written.body);
                    expect(decoded.messageBody.richText.elems[0].text.text).toBe('synthetic text');
                    expect(decoded.clientSequence).toBe(9007199254740993n);
                }
            }
        },
    );

    it.each(['register', 'send'] as const)(
        'rejects an inner signer mutation through the %s reserve builder',
        async (kind) => {
            const options = kind === 'register' ? registerOptions() : sendOptions();
            const sign = vi.fn(async ({ body }: { body: Uint8Array }) => {
                body[0] ^= 0xff;
                return { sign: Uint8Array.of(9), token: Uint8Array.of(8), extra: Uint8Array.of(7) };
            });
            options.buildReserved = createSsoReserveBuilder({
                uin: '123',
                classifySigning: () => 'sign',
                createTraceParent: () => 'trace',
                sign,
            });
            const f = fixture(
                kind === 'register' ? SSO_INFO_SYNC_COMMAND : 'MessageSvc.PbSendMsg',
                new Uint8Array(),
            );
            const result =
                kind === 'register'
                    ? await referenceRegisterOnTransport(
                          f.transport,
                          options as SsoReferenceRegisterBorrowedOptions,
                      )
                    : await referenceSendTextOnTransport(
                          f.transport,
                          options as SsoReferenceSendTextOptions,
                      );
            expect(result).toMatchObject({ kind: 'failure' });
            expect(sign).toHaveBeenCalledOnce();
            assertFixture(f, 0);
        },
    );
});
