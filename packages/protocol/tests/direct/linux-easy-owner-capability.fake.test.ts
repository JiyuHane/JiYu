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
import type { SsoRegisterRequest, SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
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

// Entirely synthetic peer and data; no transport, listener, account or signing service.
const SEQUENCES = [0x80000001, 0xf0000002, 0xf0000003] as const;
const COMMANDS = [KEY_EXCHANGE_COMMAND, LINUX_EASY_LOGIN_COMMAND, SSO_INFO_SYNC_COMMAND] as const;
const CANDIDATE_SEQUENCE = 0xf0000010;
const CANDIDATE_COMMAND = 'Synthetic.Candidate';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

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

function open(encoded: Uint8Array, key: Uint8Array): Buffer {
    const decipher = createDecipheriv('aes-128-gcm', key, encoded.subarray(0, 12));
    decipher.setAuthTag(encoded.subarray(-16));
    return Buffer.concat([decipher.update(encoded.subarray(12, -16)), decipher.final()]);
}

function fixture(uin = '123456') {
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
    const same = (a: Uint8Array, b: Uint8Array) =>
        a.length === b.length && a.every((value, index) => value === b[index]);

    function response(
        sequence: number,
        command: string,
        body: Uint8Array,
        register: boolean,
        dataFlag = 0,
    ) {
        const header = own(
            Buffer.concat([
                word(sequence),
                word(0),
                field(Buffer.alloc(0)),
                field(Buffer.from(command)),
                field(Buffer.alloc(0)),
                word(dataFlag),
                field(Buffer.alloc(0)),
            ]),
        );
        const inner = own(Buffer.concat([field(header), field(body)]));
        const encrypted = own(qqTeaEncrypt(inner, register ? d2Key : zero));
        const frame = own(
            Buffer.concat([
                word(0),
                word(12),
                Buffer.of(register ? 1 : 2, 0),
                field(Buffer.from(uin)),
                encrypted,
            ]),
        );
        frame.writeUInt32BE(frame.length);
        return frame;
    }

    function unpack(input: Uint8Array, register: boolean) {
        const frame = own(Buffer.from(input));
        expect(frame.readUInt32BE(0)).toBe(frame.length);
        expect(frame.readUInt32BE(4)).toBe(12);
        expect(frame[8]).toBe(register ? 1 : 2);
        const d2End = 9 + frame.readUInt32BE(9);
        const accountStart = d2End + 1;
        const accountEnd = accountStart + frame.readUInt32BE(accountStart);
        expect(frame.subarray(accountStart + 4, accountEnd).toString('ascii')).toBe(uin);
        const inner = own(
            Buffer.from(qqTeaDecrypt(frame.subarray(accountEnd), register ? d2Key : zero)),
        );
        const sequence = inner.readUInt32BE(4);
        let offset = 28;

        const take = (width: 2 | 4 = 4): Buffer => {
            const length = width === 2 ? inner.readUInt16BE(offset) : inner.readUInt32BE(offset);
            expect(length).toBeGreaterThanOrEqual(width);
            expect(offset + length).toBeLessThanOrEqual(inner.length);
            const value = inner.subarray(offset + width, offset + length);
            offset += length;
            return value;
        };

        const requestA2 = take();
        const command = take().toString();
        take();
        take();
        take();
        take(2);
        take();
        expect(offset).toBe(inner.readUInt32BE(0));
        const body = take();
        expect(offset).toBe(inner.length);
        return { sequence, command, body, a2: requestA2, d2: frame.subarray(13, d2End) };
    }

    class Client implements Sso12RawClient {
        private resolveClosed!: (reason: Sso12CloseReason) => void;
        readonly whenClosed = new Promise<Sso12CloseReason>((resolve) => {
            this.resolveClosed = resolve;
        });
        readonly gates = new Map<number, ReturnType<typeof deferred>>();
        readonly entered = new Map<number, ReturnType<typeof deferred>>();
        readonly consumedGates = new Map<number, ReturnType<typeof deferred>>();
        readonly consumedEntered = new Map<number, ReturnType<typeof deferred>>();
        readonly frames: Uint8Array[] = [];
        readonly candidates: Uint8Array[] = [];
        readonly errors: unknown[] = [];
        readonly close = vi.fn(() => {
            for (const gate of this.gates.values()) {
                gate.resolve();
            }

            for (const gate of this.consumedGates.values()) {
                gate.resolve();
            }

            this.resolveClosed({ kind: 'local', code: 'synthetic-close' });
        });
        calls = 0;
        consumes = 0;
        status: 'ok' | 'missing' | 'nonzero' = 'ok';
        registrationMessage = 'register success';
        rejectAt = -1;
        wrongIdentityAt = -1;

        hold(stage: number) {
            const gate = deferred();
            const entered = deferred();
            this.gates.set(stage, gate);
            this.entered.set(stage, entered);
            return { entered: entered.promise, release: gate.resolve };
        }

        holdAfterConsume(stage: number) {
            const gate = deferred();
            const entered = deferred();
            this.consumedGates.set(stage, gate);
            this.consumedEntered.set(stage, entered);
            return { entered: entered.promise, release: gate.resolve };
        }

        async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
            const index = this.calls++;
            const sequence = SEQUENCES[index];

            try {
                if (sequence === undefined) {
                    throw new Error('unexpected synthetic transaction');
                }

                const identity = { uin: index === this.wrongIdentityAt ? '999999' : uin, sequence };
                const built = await options.buildRequest(identity);
                const frame = own(Uint8Array.from(built.frame));
                this.frames.push(frame);
                const request = unpack(frame, index === 2);
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
                    const forward = protobuf_decode<LinuxNTLoginReferenceForward>(request.body);
                    own(forward.sessionTicket);
                    own(forward.buffer);
                    expect(forward.type).toBe(1);
                    expect(same(forward.sessionTicket, sessionTicket)).toBe(true);
                    const plainRequest = own(open(forward.buffer, sessionKey));
                    const common = protobuf_decode<LinuxNTLoginReferenceCommon>(plainRequest);
                    own(common.body);
                    own(common.head.client.guid);
                    expect(common.head.user.account).toBe(uin);
                    expect(same(common.head.client.guid, guid)).toBe(true);
                    const decoded = protobuf_decode<LinuxNTEasyLoginReferenceRequestBody>(
                        common.body,
                    );
                    own(decoded.a1);
                    expect(same(decoded.a1, a1)).toBe(true);
                    const tickets = own(
                        protobuf_encode<LinuxNTEasyLoginReferenceResponseBody>({
                            tickets: { a1, a2, d2, d2Key },
                        }),
                    );
                    const errorInfo =
                        this.status === 'missing' ? {} : { code: this.status === 'ok' ? 0n : 1n };
                    const plain = own(
                        protobuf_encode<LinuxNTLoginReferenceResponseCommon>({
                            head: { errorInfo },
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
                    expect(same(request.d2, d2)).toBe(true);
                    expect(same(request.a2, a2)).toBe(true);
                    const decoded = protobuf_decode<SsoRegisterRequest>(request.body);
                    expect(decoded.register).toMatchObject({ guid: 'ABCD' });
                    body = own(
                        protobuf_encode<SsoRegisterResponse>({
                            register: { message: this.registrationMessage },
                        }),
                    );
                }

                const candidate = response(sequence, request.command, body, index === 2);
                this.candidates.push(candidate);
                const gate = this.gates.get(index);

                if (gate) {
                    this.entered.get(index)!.resolve();
                    await gate.promise;
                }

                if (
                    index === this.rejectAt ||
                    !(await options.verifyCandidate(candidate, built.context, identity))
                ) {
                    return { kind: 'failure', code: 'synthetic-rejected', writeState: 'unknown' };
                }

                this.consumes++;
                const value = await options.consumeCandidate(candidate, built.context, identity);
                const consumedGate = this.consumedGates.get(index);

                if (consumedGate) {
                    this.consumedEntered.get(index)!.resolve();
                    await consumedGate.promise;
                }

                return { kind: 'response', sequence, value, writeState: 'written' };
            } catch (error) {
                this.errors.push(error);
                return { kind: 'failure', code: 'synthetic-failed', writeState: 'unknown' };
            }
        }
    }

    const client = new Client();
    const sign = vi.fn(
        (input: {
            uin: string;
            uid?: string;
            sequence: number;
            command: string;
            body: Uint8Array;
        }) => {
            expect(Object.keys(input).sort()).toEqual(
                input.uid === undefined
                    ? ['body', 'command', 'sequence', 'uin']
                    : ['body', 'command', 'sequence', 'uid', 'uin'],
            );
            expect(input.uin).toBe(uin);
            return Uint8Array.of(0xe1, 0xe2);
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
            expect(Object.keys(input).sort()).toEqual([
                'command',
                'requestFrame',
                'responseFrame',
                'sequence',
                'uin',
            ]);
            const index = SEQUENCES.indexOf(input.sequence as (typeof SEQUENCES)[number]);
            expect(index).toBeGreaterThanOrEqual(0);
            expect(input.uin).toBe(uin);
            expect(input.command).toBe(COMMANDS[index]);
            expect(same(input.requestFrame, client.frames[index]!)).toBe(true);
            expect(same(input.responseFrame, client.candidates[index]!)).toBe(true);
            expect(input.requestFrame.buffer).not.toBe(client.frames[index]!.buffer);
            expect(input.responseFrame.buffer).not.toBe(client.candidates[index]!.buffer);
            return true;
        },
    );
    const acceptLogin = vi.fn(
        ({ uin: account, uid, statusCode }: { uin: string; uid: string; statusCode: bigint }) =>
            account === uin && uid === 'synthetic-uid' && statusCode === 0n,
    );
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
            acceptLogin,
        },
    };
    const candidate = response(
        CANDIDATE_SEQUENCE,
        CANDIDATE_COMMAND,
        own(Uint8Array.of(1, 2, 3)),
        true,
    );
    const alternative = response(
        CANDIDATE_SEQUENCE,
        'Synthetic.Candidatx',
        own(Uint8Array.of(1, 2, 3)),
        true,
    );
    return {
        client,
        options,
        candidate,
        alternative,
        sign,
        verify,
        acceptLogin,
        compressedCandidate(length: number) {
            const body = own(new Uint8Array(length).fill(0x61));
            const compressed = own(deflateSync(body));
            return response(CANDIDATE_SEQUENCE, CANDIDATE_COMMAND, compressed, true, 1);
        },
        cleanup() {
            client.close();
            sign.mockClear();
            verify.mockClear();

            for (const value of allocations) {
                value.fill(0);
            }
        },
    };
}

const metadata = (uin: string) => ({
    uin,
    sequence: CANDIDATE_SEQUENCE,
    command: CANDIDATE_COMMAND,
    retCode: 0,
});

async function waitEntered(entered: Promise<void>, pending: Promise<{ kind: string }>) {
    expect(
        await Promise.race([entered.then(() => 'entered'), pending.then(() => 'finished')]),
    ).toBe('entered');
}

describe('Linux Easy owner key capability with synthetic in-memory peer', () => {
    it('classifies tentative and active candidates as scalars only and revokes before close returns', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        const legacy = createLinuxEasyAccountOwner();
        const consumedGate = f.client.holdAfterConsume(1);
        const gate = f.client.hold(2);
        const snapshot = Uint8Array.from(f.candidate);

        try {
            expect(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate)).toBeUndefined();
            expect(classifyLinuxEasyOwnerD2Candidate(legacy, f.candidate)).toBeUndefined();
            const pending = owner.start(f.options);
            await waitEntered(consumedGate.entered, pending);
            expect(f.client.calls).toBe(2);
            expect(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate)).toEqual(
                metadata('123456'),
            );
            expect(f.client.calls).toBe(2);
            consumedGate.release();
            await waitEntered(gate.entered, pending);
            const tentative = classifyLinuxEasyOwnerD2Candidate(owner, f.candidate);
            expect(tentative).toEqual(metadata('123456'));
            expect(Object.keys(tentative!).sort()).toEqual([
                'command',
                'retCode',
                'sequence',
                'uin',
            ]);
            expect(f.client.calls).toBe(3);
            expect(f.client.consumes).toBe(2);
            gate.release();
            expect(await pending).toEqual({ kind: 'registered', registerSequence: SEQUENCES[2] });
            expect(SEQUENCES[1]).not.toBe(SEQUENCES[2]);
            expect(f.client.consumes).toBe(3);
            expect(f.client.errors).toEqual([]);
            expect(f.sign).toHaveBeenCalledTimes(3);
            expect(f.verify).toHaveBeenCalledTimes(3);
            expect(f.acceptLogin).toHaveBeenCalledOnce();
            expect(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate)).toEqual(
                metadata('123456'),
            );
            expect(f.client.calls).toBe(3);
            expect(Array.from(f.candidate)).toEqual(Array.from(snapshot));
            owner.close();
            expect(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate)).toBeUndefined();
        } finally {
            consumedGate.release();
            gate.release();
            owner.close();
            legacy.close();
            snapshot.fill(0);
            f.cleanup();
        }
    });

    it('snapshots the candidate before a reentrant clock changes caller-owned bytes', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        const originalNow = performance.now.bind(performance);
        let clock: ReturnType<typeof vi.spyOn> | undefined;

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            expect(f.candidate.length).toBe(f.alternative.length);
            let changed = false;
            clock = vi.spyOn(performance, 'now').mockImplementation(() => {
                if (!changed) {
                    changed = true;
                    f.candidate.set(f.alternative);
                }

                return originalNow();
            });
            const result = classifyLinuxEasyOwnerD2Candidate(owner, f.candidate);
            clock.mockRestore();
            clock = undefined;
            expect(changed).toBe(true);
            expect(result).toEqual(metadata('123456'));
            expect(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate)).toEqual({
                ...metadata('123456'),
                command: 'Synthetic.Candidatx',
            });
        } finally {
            clock?.mockRestore();
            owner.close();
            f.cleanup();
        }
    });

    it('bounds decompressed D2 candidate bodies while retaining the registered owner', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            const within = f.compressedCandidate(65536);
            const beyond = f.compressedCandidate(65537);
            expect(within.length).toBeLessThan(65536);
            expect(beyond.length).toBeLessThan(65536);
            expect(classifyLinuxEasyOwnerD2Candidate(owner, within)).toEqual(metadata('123456'));
            expect(classifyLinuxEasyOwnerD2Candidate(owner, beyond)).toBeUndefined();
            expect(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate)).toEqual(
                metadata('123456'),
            );
            expect(f.client.calls).toBe(3);
        } finally {
            owner.close();
            f.cleanup();
        }
    });

    it('rejects invalid, malformed, oversized, wrong-account and legacy candidates without affecting active state', async () => {
        const f = fixture();
        const other = fixture('234567');
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        const oversized = new Uint8Array(65537);
        const malformed = Uint8Array.of(1, 2, 3);

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            expect(classifyLinuxEasyOwnerD2Candidate(owner, malformed)).toBeUndefined();
            expect(classifyLinuxEasyOwnerD2Candidate(owner, oversized)).toBeUndefined();
            expect(classifyLinuxEasyOwnerD2Candidate(owner, other.candidate)).toBeUndefined();
            expect(
                classifyLinuxEasyOwnerD2Candidate({} as typeof owner, f.candidate),
            ).toBeUndefined();
            expect(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate)).toEqual(
                metadata('123456'),
            );
        } finally {
            owner.close();
            oversized.fill(0);
            malformed.fill(0);
            f.cleanup();
            other.cleanup();
        }
    });

    it.each([
        'missing',
        'nonzero',
        'register-failure',
        'policy',
        'verify',
        'wrong-identity',
    ] as const)('revokes failed %s without changing another active owner', async (failure) => {
        const f = fixture();
        const other = fixture('234567');
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        const winner = createLinuxEasyAccountOwnerWithKeyCapability();

        if (failure === 'missing' || failure === 'nonzero') {
            f.client.status = failure;
        }

        if (failure === 'register-failure') {
            f.client.registrationMessage = 'register failed';
        }

        if (failure === 'policy') {
            f.acceptLogin.mockReturnValue(false);
        }

        if (failure === 'verify') {
            f.client.rejectAt = 1;
        }

        if (failure === 'wrong-identity') {
            f.client.wrongIdentityAt = 2;
        }

        try {
            expect((await winner.start(other.options)).kind).toBe('registered');
            expect((await owner.start(f.options)).kind).toBe('failure');
            expect(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate)).toBeUndefined();
            expect((await owner.start(f.options)).kind).toBe('failure');
            expect(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate)).toBeUndefined();
            expect(classifyLinuxEasyOwnerD2Candidate(winner, other.candidate)).toEqual(
                metadata('234567'),
            );
        } finally {
            owner.close();
            winner.close();
            f.cleanup();
            other.cleanup();
        }
    });

    it.each(['close', 'transport-close', 'abort', 'timeout'] as const)(
        'revokes a tentative candidate on %s and fences late registration completion',
        async (stop) => {
            const f = fixture();
            const owner = createLinuxEasyAccountOwnerWithKeyCapability();
            const gate = f.client.hold(2);
            const controller = new AbortController();

            try {
                const pending = owner.start({
                    ...f.options,
                    sessionTimeoutMs: stop === 'timeout' ? 100 : 30000,
                    signal: controller.signal,
                });
                await waitEntered(gate.entered, pending);
                expect(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate)).toEqual(
                    metadata('123456'),
                );

                if (stop === 'close') {
                    owner.close();
                }

                if (stop === 'transport-close') {
                    f.client.close();
                }

                if (stop === 'abort') {
                    controller.abort();
                }

                expect((await pending).kind).toBe('failure');
                expect(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate)).toBeUndefined();
                gate.release();
                await new Promise<void>((resolve) => setImmediate(resolve));
                expect(classifyLinuxEasyOwnerD2Candidate(owner, f.candidate)).toBeUndefined();
                expect(f.client.calls).toBe(3);
            } finally {
                gate.release();
                controller.abort();
                owner.close();
                f.cleanup();
            }
        },
    );
});
