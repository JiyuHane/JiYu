import { createCipheriv, createECDH } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type {
    LinuxNTEasyLoginReferenceResponseBody,
    LinuxNTLoginReferenceForward,
    LinuxNTLoginReferenceResponseCommon,
    NTLoginForwardRequest,
} from '@snowluma/proto-defs/direct-login';
import type { SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { MSG_PUSH_CMD } from '../../src/msg-push';
import { KEY_EXCHANGE_COMMAND } from '../../src/direct/key-exchange-flow';
import {
    decodeKeyExchangeRequest,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
} from '../../src/direct/key-exchange-protobuf';
import {
    classifyLinuxEasyOwnerD2Candidate,
    createLinuxEasyAccountOwner,
    createLinuxEasyAccountOwnerWithKeyCapability,
    extractLinuxEasyOwnerPushBody,
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

// Synthetic peer and data only. Parsing produces a candidate, not peer authentication.
const SEQUENCES = [0x80000001, 0xf0000002, 0xf0000003] as const;
const COMMANDS = [KEY_EXCHANGE_COMMAND, LINUX_EASY_LOGIN_COMMAND, SSO_INFO_SYNC_COMMAND] as const;
const PUSH_SEQUENCE = 0xf000000a;

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function fixture(uin = '123456') {
    const allocations: Uint8Array[] = [];

    const own = <T extends Uint8Array>(bytes: T): T => {
        allocations.push(bytes);
        return bytes;
    };

    const word = (value: number) => {
        const bytes = own(Buffer.alloc(4));
        bytes.writeUInt32BE(value >>> 0);
        return bytes;
    };

    const field = (bytes: Uint8Array) => own(Buffer.concat([word(bytes.length + 4), bytes]));
    const text = (value: string) => own(Buffer.from(value));
    const empty = () => own(Buffer.alloc(0));
    const zero = own(new Uint8Array(16));
    const sessionKey = own(Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i));
    const sessionTicket = own(Uint8Array.from({ length: 24 }, (_, i) => 0x60 + i));
    const d2Key = own(
        Uint8Array.from({ length: 16 }, (_, i) => 0x80 + i + (uin === '123456' ? 0 : 1)),
    );
    const d2 = own(Uint8Array.of(0x31, 0, 0x33));
    const a1 = own(Uint8Array.of(0x11, 0, 0x12));
    const a2 = own(Uint8Array.of(0x21, 0, 0x22));
    const guid = own(Uint8Array.of(0xab, 0xcd));
    const nonce = own(Uint8Array.from({ length: 12 }, (_, i) => i));

    function key(scalar: number) {
        const ecdh = createECDH('prime256v1');
        const privateKey = own(Buffer.alloc(32));
        privateKey[31] = scalar;
        ecdh.setPrivateKey(privateKey);
        return ecdh;
    }

    function seal(plain: Uint8Array, secret: Uint8Array, ivByte: number) {
        const iv = own(Buffer.alloc(12, ivByte));
        const cipher = createCipheriv(
            secret.length === 32 ? 'aes-256-gcm' : 'aes-128-gcm',
            secret,
            iv,
        );
        return own(
            Buffer.concat([
                iv,
                own(cipher.update(plain)),
                own(cipher.final()),
                own(cipher.getAuthTag()),
            ]),
        );
    }

    function response(
        sequence: number,
        command: string,
        body: Uint8Array,
        register: boolean,
        dataFlag = 0,
        retCode = 0,
        frameUin = uin,
    ) {
        const header = own(
            Buffer.concat([
                word(sequence),
                word(retCode),
                field(empty()),
                field(text(command)),
                field(empty()),
                word(dataFlag),
                field(empty()),
            ]),
        );
        const inner = own(Buffer.concat([field(header), field(body)]));
        const encrypted = own(qqTeaEncrypt(inner, register ? d2Key : zero));
        const frame = own(
            Buffer.concat([
                word(0),
                word(12),
                own(Buffer.of(register ? 1 : 2, 0)),
                field(text(frameUin)),
                encrypted,
            ]),
        );
        frame.writeUInt32BE(frame.length);
        return frame;
    }

    function unpack(input: Uint8Array, register: boolean) {
        const frame = own(Buffer.from(input));
        expect(frame.readUInt32BE(0)).toBe(frame.length);
        const d2End = 9 + frame.readUInt32BE(9);
        const accountStart = d2End + 1;
        const accountEnd = accountStart + frame.readUInt32BE(accountStart);
        expect(frame.subarray(accountStart + 4, accountEnd).toString()).toBe(uin);
        const inner = own(
            Buffer.from(own(qqTeaDecrypt(frame.subarray(accountEnd), register ? d2Key : zero))),
        );
        const sequence = inner.readUInt32BE(4);
        let offset = 28;

        const take = (width: 2 | 4 = 4) => {
            const length = width === 2 ? inner.readUInt16BE(offset) : inner.readUInt32BE(offset);
            expect(length).toBeGreaterThanOrEqual(width);
            expect(offset + length).toBeLessThanOrEqual(inner.length);
            const value = inner.subarray(offset + width, offset + length);
            offset += length;
            return value;
        };

        take();
        const command = take().toString();
        take();
        take();
        take();
        take(2);
        take();
        expect(offset).toBe(inner.readUInt32BE(0));
        const body = take();
        expect(offset).toBe(inner.length);
        return { sequence, command, body };
    }

    class Client implements Sso12RawClient {
        private resolveClosed!: (reason: Sso12CloseReason) => void;
        readonly whenClosed = new Promise<Sso12CloseReason>((resolve) => {
            this.resolveClosed = resolve;
        });
        readonly entered = deferred();
        readonly gate = deferred();
        readonly errors: unknown[] = [];
        holdRegister = false;
        calls = 0;
        readonly close = vi.fn(() => {
            this.gate.resolve();
            this.resolveClosed({ kind: 'local', code: 'synthetic-close' });
        });

        async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
            const index = this.calls++;

            try {
                const sequence = SEQUENCES[index];

                if (sequence === undefined) {
                    throw new Error('unexpected synthetic transaction');
                }

                const identity = { uin, sequence };
                const built = await options.buildRequest(identity);
                own(built.frame);
                const request = unpack(built.frame, index === 2);
                expect(request.sequence).toBe(sequence);
                expect(request.command).toBe(COMMANDS[index]);
                let body: Uint8Array;

                if (index === 0) {
                    const decoded = decodeKeyExchangeRequest(request.body);

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

                    const server = key(2);
                    const shared = own(server.computeSecret(decoded.publicKey));
                    const secret = own(
                        encodeKeyExchangeResponseSecret({
                            sessionKey,
                            sessionTicket,
                            expiration: 300,
                        }),
                    );
                    body = own(
                        encodeKeyExchangeResponse({
                            publicKey: own(server.getPublicKey()),
                            secret: seal(secret, shared, 0x42),
                        }),
                    );
                } else if (index === 1) {
                    const forward = protobuf_decode<LinuxNTLoginReferenceForward>(request.body);
                    own(forward.sessionTicket);
                    own(forward.buffer);
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
                    body = own(
                        protobuf_encode<NTLoginForwardRequest>({
                            sessionTicket: own(Uint8Array.of(0x42)),
                            buffer: seal(plain, sessionKey, 0x51),
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

                const candidate = response(sequence, request.command, body, index === 2);

                if (index === 2 && this.holdRegister) {
                    this.entered.resolve();
                    await this.gate.promise;
                }

                if (!(await options.verifyCandidate(candidate, built.context, identity))) {
                    return { kind: 'failure', code: 'synthetic-rejected', writeState: 'unknown' };
                }

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
    const options = {
        client,
        trustedSuccessQuiescence: true as const,
        isUsable: () => true,
        sessionTimeoutMs: 30000,
        login: {
            uin,
            guid,
            a2,
            version: 'header-v',
            subAppId: 42,
            serverPublicKey: own(Uint8Array.from(own(key(1).getPublicKey()))),
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
            acceptKeyExchange: vi.fn(
                ({ uin: account, expiration }: { uin: string; expiration: number | undefined }) =>
                    account === uin && expiration === 300,
            ),
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
            acceptLogin: vi.fn(
                ({
                    uin: account,
                    uid,
                    statusCode,
                }: {
                    uin: string;
                    uid: string;
                    statusCode: bigint;
                }) => account === uin && uid === 'synthetic-uid' && statusCode === 0n,
            ),
        },
    };
    const expected = { uin, sequence: PUSH_SEQUENCE, command: MSG_PUSH_CMD, retCode: 0 };
    const body = own(Uint8Array.of(0x0a, 0x03, 0x08, 0x96, 0x01, 0x12, 0x02, 0xab, 0xcd));
    return {
        client,
        options,
        expected,
        body,
        own,
        push(
            settings: {
                sequence?: number;
                command?: string;
                retCode?: number;
                frameUin?: string;
                body?: Uint8Array;
                compressed?: boolean;
            } = {},
        ) {
            const payload = settings.body ?? body;
            const wireBody = settings.compressed ? own(deflateSync(payload)) : payload;
            return response(
                settings.sequence ?? PUSH_SEQUENCE,
                settings.command ?? MSG_PUSH_CMD,
                wireBody,
                true,
                settings.compressed ? 1 : 0,
                settings.retCode ?? 0,
                settings.frameUin ?? uin,
            );
        },
        cleanup() {
            client.close();
            sign.mockClear();
            verify.mockClear();

            for (const bytes of allocations) {
                bytes.fill(0);
            }
        },
    };
}

async function waitEntered(entered: Promise<void>, pending: Promise<{ kind: string }>) {
    expect(
        await Promise.race([entered.then(() => 'entered'), pending.then(() => 'finished')]),
    ).toBe('entered');
}

describe('Linux Easy active owner synthetic push candidate body', () => {
    it('exposes metadata while staged but returns an independent exact business body only after registration', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        const legacy = createLinuxEasyAccountOwner();
        const frame = f.push();
        const original = f.own(Uint8Array.from(frame));
        f.client.holdRegister = true;
        let first: ReturnType<typeof extractLinuxEasyOwnerPushBody>;
        let second: ReturnType<typeof extractLinuxEasyOwnerPushBody>;

        try {
            expect(extractLinuxEasyOwnerPushBody(owner, frame, f.expected)).toBeUndefined();
            expect(extractLinuxEasyOwnerPushBody(legacy, frame, f.expected)).toBeUndefined();
            const pending = owner.start(f.options);
            await waitEntered(f.client.entered.promise, pending);
            expect(classifyLinuxEasyOwnerD2Candidate(owner, frame)).toEqual(f.expected);
            expect(extractLinuxEasyOwnerPushBody(owner, frame, f.expected)).toBeUndefined();
            f.client.gate.resolve();
            expect(await pending).toEqual({ kind: 'registered', registerSequence: SEQUENCES[2] });
            expect(f.client.errors).toEqual([]);
            first = extractLinuxEasyOwnerPushBody(owner, frame, f.expected);
            expect(first?.meta).toEqual(f.expected);
            expect(Object.keys(first!.meta).sort()).toEqual([
                'command',
                'retCode',
                'sequence',
                'uin',
            ]);
            expect(first?.body).toEqual(f.body);
            expect(first!.body.buffer).not.toBe(frame.buffer);
            first!.body.fill(0);
            expect(Array.from(frame)).toEqual(Array.from(original));
            second = extractLinuxEasyOwnerPushBody(owner, frame, f.expected);
            expect(second?.body).toEqual(f.body);
            expect(second!.body.buffer).not.toBe(first!.body.buffer);
            expect(Array.from(frame)).toEqual(Array.from(original));
            owner.close();
            expect(extractLinuxEasyOwnerPushBody(owner, frame, f.expected)).toBeUndefined();
        } finally {
            first?.body.fill(0);
            second?.body.fill(0);
            f.client.gate.resolve();
            owner.close();
            legacy.close();
            f.cleanup();
        }
    });

    it('isolates active owners and rejects malformed frames and mismatched metadata', async () => {
        const f = fixture();
        const other = fixture('234567');
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        const winner = createLinuxEasyAccountOwnerWithKeyCapability();
        const frame = f.push();
        const otherFrame = other.push();
        const malformed = f.own(Uint8Array.of(1, 2, 3));
        const oversized = f.own(new Uint8Array(65537));
        const badFrames = [
            malformed,
            oversized,
            f.push({ sequence: PUSH_SEQUENCE + 1 }),
            f.push({ frameUin: '234567' }),
            f.push({ command: 'Synthetic.NotPush' }),
            f.push({ retCode: 1 }),
            otherFrame,
        ];
        let result: ReturnType<typeof extractLinuxEasyOwnerPushBody>;

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            expect((await winner.start(other.options)).kind).toBe('registered');

            for (const bad of badFrames) {
                expect(extractLinuxEasyOwnerPushBody(owner, bad, f.expected)).toBeUndefined();
            }

            expect(extractLinuxEasyOwnerPushBody(winner, frame, f.expected)).toBeUndefined();
            expect(
                extractLinuxEasyOwnerPushBody(owner, otherFrame, other.expected),
            ).toBeUndefined();
            expect(
                extractLinuxEasyOwnerPushBody({} as typeof owner, frame, f.expected),
            ).toBeUndefined();

            for (const expected of [
                { ...f.expected, uin: '234567' },
                { ...f.expected, sequence: PUSH_SEQUENCE + 1 },
                { ...f.expected, sequence: PUSH_SEQUENCE + 0.5 },
                { ...f.expected, command: 'Synthetic.NotPush' },
                { ...f.expected, retCode: 1 },
            ]) {
                expect(extractLinuxEasyOwnerPushBody(owner, frame, expected)).toBeUndefined();
            }

            // Matching a non-push command or nonzero return code must not relax the push contract.
            expect(
                extractLinuxEasyOwnerPushBody(owner, f.push({ command: 'Synthetic.NotPush' }), {
                    ...f.expected,
                    command: 'Synthetic.NotPush',
                }),
            ).toBeUndefined();
            expect(
                extractLinuxEasyOwnerPushBody(owner, f.push({ retCode: 1 }), {
                    ...f.expected,
                    retCode: 1,
                }),
            ).toBeUndefined();
            result = extractLinuxEasyOwnerPushBody(winner, otherFrame, other.expected);
            expect(result?.meta).toEqual(other.expected);
            expect(result?.body).toEqual(other.body);
            expect(f.client.errors).toEqual([]);
            expect(other.client.errors).toEqual([]);
        } finally {
            result?.body.fill(0);
            owner.close();
            winner.close();
            f.cleanup();
            other.cleanup();
        }
    });

    it('rejects hostile frame and expected objects without invoking traps or getters', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        const frame = f.push();
        let traps = 0;
        const hostileFrame = new Proxy(frame, {
            get() {
                traps++;
                throw new Error('trap');
            },
        });
        const hostileExpected = new Proxy(f.expected, {
            ownKeys() {
                traps++;
                throw new Error('trap');
            },
            get() {
                traps++;
                throw new Error('trap');
            },
        });
        const getterExpected = {
            ...f.expected,
            get sequence() {
                traps++;
                throw new Error('getter');
            },
        };

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            expect(extractLinuxEasyOwnerPushBody(owner, hostileFrame, f.expected)).toBeUndefined();
            expect(extractLinuxEasyOwnerPushBody(owner, frame, hostileExpected)).toBeUndefined();
            expect(extractLinuxEasyOwnerPushBody(owner, frame, getterExpected)).toBeUndefined();
            expect(traps).toBe(0);
        } finally {
            owner.close();
            f.cleanup();
        }
    });

    it('extracts flag 1 protobuf bytes and rejects expansion beyond 65536', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        const small = f.push({ compressed: true });
        const largeBody = f.own(new Uint8Array(65537).fill(0x61));
        const bomb = f.push({ body: largeBody, compressed: true });
        let result: ReturnType<typeof extractLinuxEasyOwnerPushBody>;

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            result = extractLinuxEasyOwnerPushBody(owner, small, f.expected);
            expect(result && Array.from(result.body)).toEqual(Array.from(f.body));
            expect(bomb.length).toBeLessThan(65536);
            expect(extractLinuxEasyOwnerPushBody(owner, bomb, f.expected)).toBeUndefined();
        } finally {
            result?.body.fill(0);
            owner.close();
            f.cleanup();
        }
    });

    it('rejects synchronous deadline expiry and reentrant close during clock checks', async () => {
        const f = fixture();
        const g = fixture('234567');
        const expired = createLinuxEasyAccountOwnerWithKeyCapability();
        const closing = createLinuxEasyAccountOwnerWithKeyCapability();
        const frame = f.push();
        const otherFrame = g.push();
        let now = 1000;
        let reenter = false;
        let didClose = false;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
            if (reenter && !didClose) {
                didClose = true;
                closing.close();
            }

            return now;
        });

        try {
            expect((await expired.start(f.options)).kind).toBe('registered');
            expect((await closing.start(g.options)).kind).toBe('registered');
            reenter = true;
            expect(extractLinuxEasyOwnerPushBody(closing, otherFrame, g.expected)).toBeUndefined();
            expect(didClose).toBe(true);
            reenter = false;
            now = 31000;
            expect(extractLinuxEasyOwnerPushBody(expired, frame, f.expected)).toBeUndefined();
            expect(extractLinuxEasyOwnerPushBody(expired, frame, f.expected)).toBeUndefined();
        } finally {
            clock.mockRestore();
            expired.close();
            closing.close();
            f.cleanup();
            g.cleanup();
        }
    });
});
