import { createCipheriv, createECDH } from 'node:crypto';
import type {
    LinuxNTEasyLoginReferenceResponseBody,
    LinuxNTLoginReferenceForward,
    LinuxNTLoginReferenceResponseCommon,
    NTLoginForwardRequest,
} from '@snowluma/proto-defs/direct-login';
import type { PushMsg } from '@snowluma/proto-defs/message';
import type { SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { KEY_EXCHANGE_COMMAND } from '../../src/direct/key-exchange-flow';
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
import { IdentityService } from '../../src/identity-service';
import { MSG_PUSH_CMD } from '../../src/msg-push';
import type { IncomingPacketPipeline } from '../../src/packet-pipeline';

// Synthetic in-memory peer and data, adapted from linux-easy-push-processor.fake.test.ts.
// The true verifier is a caller assertion, not peer authentication.
const uin = '123456';
const base = 0xf000000a;
const count = 40;
const sequences = [0x80000001, 0xf0000002, 0xf0000003] as const;
const commands = [KEY_EXCHANGE_COMMAND, LINUX_EASY_LOGIN_COMMAND, SSO_INFO_SYNC_COMMAND] as const;
const nativeImmediate = setImmediate;

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

// Only real setTimeout is used for a bounded failure path; session timeouts stay real.
async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('synthetic fairness watchdog')), 3000);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

function fixture(
    createOwner: typeof import('../../src/direct/linux-easy-account-owner').createLinuxEasyAccountOwnerWithKeyCapability,
    createProcessor: typeof import('../../src/direct/linux-easy-push-processor').createLinuxEasyPushProcessor,
) {
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
    const d2Key = own(Uint8Array.from({ length: 16 }, (_, i) => 0x80 + i));
    const d2 = own(Uint8Array.of(0x31, 0, 0x33));
    const a1 = own(Uint8Array.of(0x11, 0, 0x12));
    const a2 = own(Uint8Array.of(0x21, 0, 0x22));
    const guid = own(Uint8Array.of(0xab, 0xcd));
    const nonce = own(Uint8Array.from({ length: 12 }, (_, i) => i));

    const key = (scalar: number) => {
        const ecdh = createECDH('prime256v1');
        const privateKey = own(Buffer.alloc(32));
        privateKey[31] = scalar;
        ecdh.setPrivateKey(privateKey);
        return ecdh;
    };

    const seal = (plain: Uint8Array, secret: Uint8Array, ivByte: number) => {
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
    };

    const response = (sequence: number, command: string, body: Uint8Array, registered: boolean) => {
        const header = own(
            Buffer.concat([
                word(sequence),
                word(0),
                field(empty()),
                field(text(command)),
                field(empty()),
                word(0),
                field(empty()),
            ]),
        );
        const inner = own(Buffer.concat([field(header), field(body)]));
        const frame = own(
            Buffer.concat([
                word(0),
                word(12),
                own(Buffer.of(registered ? 1 : 2, 0)),
                field(text(uin)),
                own(qqTeaEncrypt(inner, registered ? d2Key : zero)),
            ]),
        );
        frame.writeUInt32BE(frame.length);
        return frame;
    };

    const unpack = (input: Uint8Array, registered: boolean) => {
        const frame = own(Buffer.from(input));
        const d2End = 9 + frame.readUInt32BE(9);
        const accountStart = d2End + 1;
        const accountEnd = accountStart + frame.readUInt32BE(accountStart);
        expect(frame.subarray(accountStart + 4, accountEnd).toString()).toBe(uin);
        const inner = own(
            Buffer.from(own(qqTeaDecrypt(frame.subarray(accountEnd), registered ? d2Key : zero))),
        );
        const sequence = inner.readUInt32BE(4);
        let offset = 28;

        const take = (width: 2 | 4 = 4) => {
            const length = width === 2 ? inner.readUInt16BE(offset) : inner.readUInt32BE(offset);
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
    };

    class Client implements Sso12RawClient {
        private resolveClosed!: (reason: Sso12CloseReason) => void;
        readonly whenClosed = new Promise<Sso12CloseReason>((resolve) => {
            this.resolveClosed = resolve;
        });
        readonly errors: unknown[] = [];
        calls = 0;
        readonly close = vi.fn(() =>
            this.resolveClosed({ kind: 'local', code: 'synthetic-close' }),
        );
        async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
            const index = this.calls++;

            try {
                const sequence = sequences[index];

                if (sequence === undefined) {
                    throw new Error('unexpected synthetic transaction');
                }

                const identity = { uin, sequence };
                const built = await options.buildRequest(identity);
                own(built.frame);
                const request = unpack(built.frame, index === 2);
                expect(request.sequence).toBe(sequence);
                expect(request.command).toBe(commands[index]);
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
            verifyRaw: vi.fn(() => true),
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
            verifyRaw: vi.fn(() => true),
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
    const owner = createOwner();
    const identity = IdentityService.memory(uin);
    const dispatched: number[] = [];
    const allDone = deferred();
    const dispatch = vi.fn(
        async (meta: { serviceCmd: string; seqId: number }, events: unknown[]) => {
            expect(events.length).toBeGreaterThan(0);
            dispatched.push(meta.seqId);

            if (dispatched.length === count) {
                allDone.resolve();
            }
        },
    );
    const verifyRaw = vi.fn(() => true);
    const processor = createProcessor({
        owner,
        uin,
        ingress: {
            uin,
            identity,
            pipeline: { processDecodedDirectEvents: dispatch } as unknown as IncomingPacketPipeline,
            pipelineIdentityBound: true,
            sourceAuthenticationHandled: true,
            maxBodyBytes: 65536,
            maxPendingBytes: 262144,
            maxPending: 8,
            maxEventsPerPush: 16,
        },
        queue: { maxFrameBytes: 65536, maxQueuedFrames: 128, maxQueuedBytes: 4 * 1024 * 1024 },
        verifyRaw,
    });

    const enqueue = (id: number) => {
        const body = own(
            protobuf_encode<PushMsg>({
                message: {
                    responseHead: { fromUin: 10001, fromUid: 'synthetic_peer' },
                    contentHead: {
                        msgType: 166,
                        sequence: id & 0xffff,
                        ntMsgSeq: 63214 + (id & 0xffff),
                        timestamp: 1700000000,
                        msgId: id & 0xffff,
                    },
                    body: { richText: { elems: [{ text: { str: `synthetic ${id}` } }] } },
                },
            }),
        );
        const frame = response(id, MSG_PUSH_CMD, body, true);
        processor.onPush(frame, { kind: 'push', name: MSG_PUSH_CMD, id });
    };

    return {
        owner,
        options,
        client,
        identity,
        dispatch,
        dispatched,
        allDone,
        verifyRaw,
        processor,
        enqueue,
        async cleanup() {
            processor.stop();
            await bounded(processor.drain());
            owner.close();
            await identity.close();

            for (const bytes of allocations) {
                bytes.fill(0);
            }
        },
    };
}

async function makeFixture() {
    // The processor captures these globals at module initialization. Reload the owner
    // and processor together so their private owner capability registry is shared.
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] });

    try {
        const ownerModule = await import('../../src/direct/linux-easy-account-owner');
        const processorModule = await import('../../src/direct/linux-easy-push-processor');
        return fixture(
            ownerModule.createLinuxEasyAccountOwnerWithKeyCapability,
            processorModule.createLinuxEasyPushProcessor,
        );
    } catch (error) {
        vi.useRealTimers();
        throw error;
    }
}

async function activate(f: ReturnType<typeof fixture>) {
    expect((await bounded(f.owner.start(f.options))).kind).toBe('registered');
    expect(f.client.errors).toEqual([]);
    expect(f.processor.activate()).toBe(true);
}

async function firstYield(f: ReturnType<typeof fixture>, amount = count) {
    for (let i = 0; i < amount; i++) {
        f.enqueue(base + i);
    }

    // Enqueue happens first; this real macrotask observes work before a fake yield resumes.
    const observed = await bounded(
        new Promise<number>((resolve) => {
            nativeImmediate(() => resolve(f.dispatched.length));
        }),
    );
    expect(observed).toBe(16);
    expect(observed).toBeLessThan(amount);
    expect(vi.getTimerCount()).toBe(1);
    return observed;
}

const expected = (amount: number) => Array.from({ length: amount }, (_, i) => base + i);

describe('Linux Easy synthetic push fairness', () => {
    it('yields a macrotask opportunity and delivers every encrypted frame once in FIFO order', async () => {
        const f = await makeFixture();

        try {
            await activate(f);
            const observed = await firstYield(f);
            expect(f.dispatched).toEqual(expected(observed));
            await vi.runAllTimersAsync();
            await bounded(f.allDone.promise);
            expect(f.dispatched).toEqual(expected(count));
            expect(f.verifyRaw).toHaveBeenCalledTimes(count);
            expect(f.dispatch).toHaveBeenCalledTimes(count);
            expect(f.processor.status()).toBe('active');
        } finally {
            try {
                await f.cleanup();
            } finally {
                vi.useRealTimers();
            }
        }
    });

    it('cancels the pending yield synchronously on stop and drains without more pipeline calls', async () => {
        const f = await makeFixture();

        try {
            await activate(f);
            const observed = await firstYield(f);
            f.processor.stop();
            expect(vi.getTimerCount()).toBe(0);
            expect(f.processor.status()).toBe('stopped');
            await bounded(f.processor.drain());
            await vi.runAllTimersAsync();
            expect(f.dispatched).toEqual(expected(observed));
            expect(f.dispatch).toHaveBeenCalledTimes(observed);
            expect(f.verifyRaw).toHaveBeenCalledTimes(observed);
        } finally {
            try {
                await f.cleanup();
            } finally {
                vi.useRealTimers();
            }
        }
    });

    it('fences owner closure during the yield before processing another frame', async () => {
        const f = await makeFixture();

        try {
            await activate(f);
            const observed = await firstYield(f);
            f.owner.close();
            await vi.runAllTimersAsync();
            expect(f.processor.status()).toBe('failed');
            await bounded(f.processor.drain());
            expect(f.dispatched).toEqual(expected(observed));
            expect(f.verifyRaw).toHaveBeenCalledTimes(observed);
        } finally {
            try {
                await f.cleanup();
            } finally {
                vi.useRealTimers();
            }
        }
    });

    it('retains the fairness budget across successive one-frame workers', async () => {
        const f = await makeFixture();

        try {
            await activate(f);

            // White-box checkpoint: with the current promise chain, 16 turns after
            // dispatch allow receipt, release, empty take and worker-finally to run.
            // There is no public idle-worker signal; revisit this bound if that chain grows.
            const settleWorker = async () => {
                for (let turn = 0; turn < 16; turn++) {
                    await Promise.resolve();
                }
            };

            await settleWorker();

            for (let i = 0; i < 16; i++) {
                f.enqueue(base + i);

                for (let turn = 0; turn < 256 && f.dispatched.length < i + 1; turn++) {
                    await Promise.resolve();
                }

                expect(f.dispatched).toEqual(expected(i + 1));
                await settleWorker();
                expect(vi.getTimerCount()).toBe(i === 15 ? 1 : 0);
            }

            expect(f.verifyRaw).toHaveBeenCalledTimes(16);
            f.processor.stop();
            expect(vi.getTimerCount()).toBe(0);
            await bounded(f.processor.drain());
        } finally {
            try {
                await f.cleanup();
            } finally {
                vi.useRealTimers();
            }
        }
    });

    it('keeps FIFO and its kick when a new candidate arrives during the yield', async () => {
        const f = await makeFixture();

        try {
            await activate(f);
            const observed = await firstYield(f, count - 1);
            f.enqueue(base + count - 1);
            expect(f.dispatched).toEqual(expected(observed));
            await vi.runAllTimersAsync();
            await bounded(f.allDone.promise);
            expect(f.dispatched).toEqual(expected(count));
            expect(f.dispatch).toHaveBeenCalledTimes(count);
            expect(f.verifyRaw).toHaveBeenCalledTimes(count);
            expect(f.processor.status()).toBe('active');
        } finally {
            try {
                await f.cleanup();
            } finally {
                vi.useRealTimers();
            }
        }
    });
});
