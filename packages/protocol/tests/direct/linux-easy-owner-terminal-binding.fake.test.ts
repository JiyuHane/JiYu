import { createCipheriv, createECDH } from 'node:crypto';
import type {
    LinuxNTEasyLoginReferenceResponseBody,
    LinuxNTLoginReferenceResponseCommon,
    NTLoginForwardRequest,
} from '@snowluma/proto-defs/direct-login';
import type { SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { KEY_EXCHANGE_COMMAND } from '../../src/direct/key-exchange-flow';
import {
    decodeKeyExchangeRequest,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
} from '../../src/direct/key-exchange-protobuf';
import {
    classifyLinuxEasyOwnerD2Candidate,
    createLinuxEasyAccountOwnerWithKeyCapability,
} from '../../src/direct/linux-easy-account-owner';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { LINUX_EASY_LOGIN_COMMAND } from '../../src/direct/sso-reference-linux-easy-login-flow';
import { SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
} from '../../src/direct/sso12-packet-client';

// Synthetic in-memory peer only; classification does not establish authentication or delivery.
const UIN = '123456';
const SEQUENCES = [0x80000001, 0xf0000002, 0xf0000003] as const;
const COMMANDS = [KEY_EXCHANGE_COMMAND, LINUX_EASY_LOGIN_COMMAND, SSO_INFO_SYNC_COMMAND] as const;
const CANDIDATE_SEQUENCE = 0xf0000010;
const CANDIDATE_COMMAND = 'Synthetic.Candidate';
const metadata = { uin: UIN, sequence: CANDIDATE_SEQUENCE, command: CANDIDATE_COMMAND, retCode: 0 };

function word(value: number): Buffer {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value >>> 0);
    return result;
}

const field = (bytes: Uint8Array): Buffer => Buffer.concat([word(bytes.length + 4), bytes]);

function fixtureKey(scalar: number) {
    const ecdh = createECDH('prime256v1');
    const key = Buffer.alloc(32);
    key[31] = scalar;

    try {
        ecdh.setPrivateKey(key);
        return ecdh;
    } finally {
        key.fill(0);
    }
}

function seal(plain: Uint8Array, key: Uint8Array, nonce: Uint8Array): Buffer {
    const cipher = createCipheriv(key.length === 32 ? 'aes-256-gcm' : 'aes-128-gcm', key, nonce);
    return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function fixture() {
    const allocations: Uint8Array[] = [];

    const own = <T extends Uint8Array>(value: T): T => {
        allocations.push(value);
        return value;
    };

    const zero = own(new Uint8Array(16));
    const sessionKey = own(Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i));
    const sessionTicket = own(Uint8Array.from({ length: 24 }, (_, i) => 0x60 + i));
    const d2Key = own(Uint8Array.from({ length: 16 }, (_, i) => 0x80 + i));
    const d2 = own(Uint8Array.of(0x31, 0, 0x33));
    const a1 = own(Uint8Array.of(0x11, 0, 0x12));
    const a2 = own(Uint8Array.of(0x21, 0, 0x22));
    const guid = own(Uint8Array.of(0xab, 0xcd));
    const nonce = own(Uint8Array.from({ length: 12 }, (_, i) => i));

    function response(sequence: number, command: string, body: Uint8Array, usesD2: boolean) {
        const header = own(
            Buffer.concat([
                word(sequence),
                word(0),
                field(Buffer.alloc(0)),
                field(Buffer.from(command)),
                field(Buffer.alloc(0)),
                word(0),
                field(Buffer.alloc(0)),
            ]),
        );
        const inner = own(Buffer.concat([field(header), field(body)]));
        const encrypted = own(qqTeaEncrypt(inner, usesD2 ? d2Key : zero));
        const frame = own(
            Buffer.concat([
                word(0),
                word(12),
                Buffer.of(usesD2 ? 1 : 2, 0),
                field(Buffer.from(UIN)),
                encrypted,
            ]),
        );
        frame.writeUInt32BE(frame.length);
        return frame;
    }

    function requestBody(frame: Uint8Array, usesD2: boolean) {
        const bytes = own(Buffer.from(frame));
        const d2End = 9 + bytes.readUInt32BE(9);
        const accountStart = d2End + 1;
        const accountEnd = accountStart + bytes.readUInt32BE(accountStart);
        const inner = own(
            Buffer.from(qqTeaDecrypt(bytes.subarray(accountEnd), usesD2 ? d2Key : zero)),
        );
        const headerEnd = inner.readUInt32BE(0);
        const bodyEnd = headerEnd + inner.readUInt32BE(headerEnd);
        return inner.subarray(headerEnd + 4, bodyEnd);
    }

    class Client implements Sso12RawClient {
        private resolveClosed!: (reason: Sso12CloseReason) => void;
        readonly whenClosed = new Promise<Sso12CloseReason>((resolve) => {
            this.resolveClosed = resolve;
        });
        readonly errors: unknown[] = [];
        calls = 0;
        consumes = 0;
        onClose: (() => void) | undefined;
        readonly close = vi.fn(() => {
            this.onClose?.();
            this.resolveClosed({ kind: 'local', code: 'synthetic-close' });
        });

        externalClose() {
            this.resolveClosed({ kind: 'local', code: 'synthetic-external-close' });
        }

        async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
            const index = this.calls++;

            if (index === 3) {
                return { kind: 'failure', code: 'synthetic-send-failure', writeState: 'unknown' };
            }

            try {
                const sequence = SEQUENCES[index];
                const command = COMMANDS[index];

                if (sequence === undefined || command === undefined) {
                    throw new Error('unexpected synthetic transaction');
                }

                const identity = { uin: UIN, sequence };
                const built = await options.buildRequest(identity);
                own(built.frame);
                const frame = own(Uint8Array.from(built.frame));
                const request = requestBody(frame, index === 2);
                let body: Uint8Array;

                if (index === 0) {
                    const decoded = decodeKeyExchangeRequest(request);

                    if (!decoded.publicKey) {
                        throw new Error('missing synthetic public key');
                    }

                    own(decoded.publicKey);

                    if (decoded.secret) {
                        own(decoded.secret);
                    }

                    if (decoded.verifyHash) {
                        own(decoded.verifyHash);
                    }

                    const server = fixtureKey(2);
                    const shared = own(server.computeSecret(decoded.publicKey));
                    const secret = own(
                        encodeKeyExchangeResponseSecret({
                            sessionKey,
                            sessionTicket,
                            expiration: 300,
                        }),
                    );
                    const encrypted = own(seal(secret, shared, own(Buffer.alloc(12, 0x42))));
                    body = own(
                        encodeKeyExchangeResponse({
                            publicKey: own(server.getPublicKey()),
                            secret: encrypted,
                        }),
                    );
                } else if (index === 1) {
                    const tickets = own(
                        protobuf_encode<LinuxNTEasyLoginReferenceResponseBody>({
                            tickets: { a1, a2, d2, d2Key },
                        }),
                    );
                    const plain = own(
                        protobuf_encode<LinuxNTLoginReferenceResponseCommon>({
                            head: { errorInfo: { code: 0n } },
                            body: tickets,
                        }),
                    );
                    const encrypted = own(seal(plain, sessionKey, own(Buffer.alloc(12, 0x51))));
                    body = own(
                        protobuf_encode<NTLoginForwardRequest>({
                            sessionTicket: own(Uint8Array.of(0x42)),
                            buffer: encrypted,
                            type: 1,
                        }),
                    );
                } else {
                    body = own(
                        protobuf_encode<SsoRegisterResponse>({
                            register: { message: 'register success' },
                        }),
                    );
                }

                const candidate = response(sequence, command, body, index === 2);

                if (!(await options.verifyCandidate(candidate, built.context, identity))) {
                    return { kind: 'failure', code: 'synthetic-rejected', writeState: 'unknown' };
                }

                this.consumes++;
                const value = await options.consumeCandidate(candidate, built.context, identity);
                return { kind: 'response', sequence, value, writeState: 'written' };
            } catch (error) {
                this.errors.push(error);
                return { kind: 'failure', code: 'synthetic-failed', writeState: 'unknown' };
            }
        }
    }

    const client = new Client();
    const sign = vi.fn(() => own(Uint8Array.of(0xe1, 0xe2)));
    const verify = vi.fn(() => true);
    const acceptLogin = vi.fn(() => true);
    const options = {
        client,
        trustedSuccessQuiescence: true as const,
        isUsable: () => true,
        sessionTimeoutMs: 30000,
        login: {
            uin: UIN,
            guid,
            a2,
            version: 'header-v',
            subAppId: 42,
            serverPublicKey: own(Uint8Array.from(fixtureKey(1).getPublicKey())),
            verifyKey: own(Uint8Array.from({ length: 32 }, (_, i) => i + 1)),
            timestamp: 1700000000,
            a1,
            nonce,
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
            acceptKeyExchange: vi.fn(() => true),
        },
        register: {
            profile: { guid: own(Uint8Array.from(guid)), version: 'header-v', subAppId: 42 },
            registration: {
                uid: 'synthetic-uid',
                version: 'build-v',
                deviceName: 'fixture-device',
                deviceType: 'fixture-type',
                vendorOs: 'fixture-os',
                random: 4,
            },
            timeoutMs: 5000,
            buildReserved: sign,
            verifyRaw: verify,
            acceptLogin,
        },
    };
    const candidate = response(
        CANDIDATE_SEQUENCE,
        CANDIDATE_COMMAND,
        own(Uint8Array.of(1, 2, 3)),
        true,
    );
    const send = {
        request: {
            route: { kind: 'private' as const, peerUin: 456n, peerUid: 'fixture-peer' },
            text: 'synthetic text',
            clientSequence: 123n,
            random: 42,
        },
        maxResponseBodyBytes: 65536,
        timeoutMs: 5000,
    };

    return {
        client,
        options,
        candidate,
        send,
        acceptLogin,
        cleanup() {
            client.onClose = undefined;
            client.close();
            sign.mockClear();
            verify.mockClear();
            acceptLogin.mockClear();

            for (const value of allocations) {
                value.fill(0);
            }
        },
    };
}

describe('Linux Easy owner terminal binding with a synthetic in-memory peer', () => {
    it('revokes the tentative key before policy rejection closes the client synchronously', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        const events: string[] = [];
        let before: ReturnType<typeof classifyLinuxEasyOwnerD2Candidate>;
        let duringClose: ReturnType<typeof classifyLinuxEasyOwnerD2Candidate>;
        f.acceptLogin.mockImplementation(() => {
            events.push('policy');
            before = classifyLinuxEasyOwnerD2Candidate(owner, f.candidate);
            return false;
        });

        f.client.onClose = () => {
            events.push('close');
            duringClose = classifyLinuxEasyOwnerD2Candidate(owner, f.candidate);
        };

        try {
            expect((await owner.start(f.options)).kind).toBe('failure');
            expect(events).toEqual(['policy', 'close']);
            expect(before).toEqual(metadata);
            expect(duringClose).toBeUndefined();
            expect(f.client.calls).toBe(2);
            expect(f.client.consumes).toBe(2);
            expect(f.client.errors).toEqual([]);
            expect(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate)).toBeUndefined();
        } finally {
            owner.close();
            f.cleanup();
        }
    });

    it('revokes the active key before broker close on a failed send', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        const observed: Array<ReturnType<typeof classifyLinuxEasyOwnerD2Candidate>> = [];

        f.client.onClose = () => {
            observed.push(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate));
        };

        try {
            expect(await owner.start(f.options)).toEqual({
                kind: 'registered',
                registerSequence: SEQUENCES[2],
            });
            expect(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate)).toEqual(metadata);
            expect(await owner.sendText(f.send)).toMatchObject({
                kind: 'failure',
                writeState: 'unknown',
            });
            expect(f.client.calls).toBe(4);
            expect(observed).toEqual([undefined]);
            expect(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate)).toBeUndefined();
        } finally {
            owner.close();
            f.cleanup();
        }
    });

    it('does not start login when acquire terminates synchronously and close reenters stop', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        let closeCalls = 0;
        f.options.isUsable = () => false;

        f.client.onClose = () => {
            closeCalls++;
            owner.close();
        };

        try {
            expect((await owner.start(f.options)).kind).toBe('failure');
            expect(closeCalls).toBe(1);
            expect(f.client.calls).toBe(0);
            expect(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate)).toBeUndefined();
            expect((await owner.start(f.options)).kind).toBe('failure');
            expect(f.client.calls).toBe(0);
        } finally {
            owner.close();
            f.cleanup();
        }
    });

    it('revokes after the external whenClosed observation reaches broker close', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        let observed: ReturnType<typeof classifyLinuxEasyOwnerD2Candidate>;
        let resolveObserved!: () => void;
        const brokerClosed = new Promise<void>((resolve) => {
            resolveObserved = resolve;
        });

        f.client.onClose = () => {
            observed = classifyLinuxEasyOwnerD2Candidate(owner, f.candidate);
            resolveObserved();
        };

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            expect(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate)).toEqual(metadata);
            f.client.externalClose();
            await brokerClosed;
            expect(observed).toBeUndefined();
            expect(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate)).toBeUndefined();
        } finally {
            owner.close();
            f.cleanup();
        }
    });
});
