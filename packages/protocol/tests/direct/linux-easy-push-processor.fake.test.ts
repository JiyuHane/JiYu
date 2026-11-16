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
import type { DirectPushMeta } from '../../src/direct/direct-push-ingress';
import { KEY_EXCHANGE_COMMAND } from '../../src/direct/key-exchange-flow';
import {
    decodeKeyExchangeRequest,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
} from '../../src/direct/key-exchange-protobuf';
import {
    createLinuxEasyAccountOwnerWithKeyCapability,
    isLinuxEasyOwnerPushActive,
    isLinuxEasyOwnerPushActiveForUin,
} from '../../src/direct/linux-easy-account-owner';
import { createLinuxEasyPushProcessor } from '../../src/direct/linux-easy-push-processor';
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

// These are synthetic in-memory peers and data. The verifier is a caller
// assertion, not evidence of real peer authentication or message delivery.
const sequences = [0x80000001, 0xf0000002, 0xf0000003] as const;
const commands = [KEY_EXCHANGE_COMMAND, LINUX_EASY_LOGIN_COMMAND, SSO_INFO_SYNC_COMMAND] as const;
const pushSequence = 0xf000000a;
const route = (id: number, name = MSG_PUSH_CMD) => ({ kind: 'push' as const, name, id });

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function fixture(
    uin = '123456',
    makeOwner: typeof createLinuxEasyAccountOwnerWithKeyCapability = createLinuxEasyAccountOwnerWithKeyCapability,
) {
    const allocations: Uint8Array[] = [];
    const rawChecks: boolean[] = [];

    const checkRaw = (ok: boolean): void => {
        rawChecks.push(ok);

        if (!ok) {
            throw new Error('invalid synthetic raw request');
        }
    };

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

    const response = (
        sequence: number,
        command: string,
        body: Uint8Array,
        registered: boolean,
        retCode = 0,
        account = uin,
    ) => {
        const header = own(
            Buffer.concat([
                word(sequence),
                word(retCode),
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
                field(text(account)),
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
        checkRaw(frame.subarray(accountStart + 4, accountEnd).toString() === uin);
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
        checkRaw(offset === inner.readUInt32BE(0));
        const body = take();
        checkRaw(offset === inner.length);
        return { sequence, command, body };
    };

    class Client implements Sso12RawClient {
        private resolveClosed!: (reason: Sso12CloseReason) => void;
        readonly whenClosed = new Promise<Sso12CloseReason>((resolve) => {
            this.resolveClosed = resolve;
        });
        readonly entered = deferred();
        readonly gate = deferred();
        readonly errors: unknown[] = [];
        readonly rawChecks = rawChecks;
        holdRegister = false;
        calls = 0;
        onClose: (() => void) | undefined;
        readonly close = vi.fn(() => {
            this.onClose?.();
            this.gate.resolve();
            this.resolveClosed({ kind: 'local', code: 'synthetic-close' });
        });
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
                checkRaw(request.sequence === sequence);
                checkRaw(request.command === commands[index]);
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
    const owner = makeOwner();
    const identity = IdentityService.memory(uin);
    const dispatch = vi.fn(
        async (_meta: { serviceCmd: string; seqId: number }, _events: unknown[]) => {},
    );
    const ingress = {
        uin,
        identity,
        pipeline: { processDecodedDirectEvents: dispatch } as unknown as IncomingPacketPipeline,
        pipelineIdentityBound: true as const,
        sourceAuthenticationHandled: true as const,
        maxBodyBytes: 65536,
        maxPendingBytes: 262144,
        maxPending: 8,
        maxEventsPerPush: 16,
    };
    const body = (id: number) =>
        own(
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
    const push = (
        settings: {
            sequence?: number;
            command?: string;
            retCode?: number;
            account?: string;
            body?: Uint8Array;
        } = {},
    ) =>
        response(
            settings.sequence ?? pushSequence,
            settings.command ?? MSG_PUSH_CMD,
            settings.body ?? body(settings.sequence ?? pushSequence),
            true,
            settings.retCode ?? 0,
            settings.account ?? uin,
        );
    const queue = { maxFrameBytes: 65536, maxQueuedFrames: 8, maxQueuedBytes: 262144 };
    return {
        uin,
        owner,
        identity,
        ingress,
        dispatch,
        client,
        options,
        body,
        push,
        queue,
        make(
            verifyRaw: (frame: Uint8Array, meta: Readonly<DirectPushMeta>) => boolean = () => true,
            limits = queue,
        ) {
            return createLinuxEasyPushProcessor({ owner, uin, ingress, queue: limits, verifyRaw });
        },
        async cleanup() {
            client.onClose = undefined;
            client.gate.resolve();
            owner.close();
            await identity.close();

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

describe('Linux Easy synthetic push processor', () => {
    it('reports buffering, active and explicitly stopped without treating a later throw as failure', async () => {
        const f = fixture();
        const processor = f.make();

        try {
            expect(processor.status()).toBe('buffering');
            expect(processor.activate()).toBe(false);
            expect(processor.status()).toBe('buffering');
            expect((await f.owner.start(f.options)).kind).toBe('registered');
            expect(processor.activate()).toBe(true);
            expect(processor.status()).toBe('active');
            processor.stop();
            expect(processor.status()).toBe('stopped');
            expect(() => processor.onPush(f.push(), route(pushSequence))).toThrow(
                'direct push processor stopped',
            );
            expect(processor.status()).toBe('stopped');
            await processor.drain();
            expect(processor.status()).toBe('stopped');
        } finally {
            processor.stop();
            await processor.drain();
            await f.cleanup();
        }
    });

    it('keeps a different account buffered while the same owner activates its matching ingress', async () => {
        const registered = fixture();
        const different = fixture('234567');
        const dispatched = deferred();
        const ownerClosed = deferred();
        const wrongVerify = vi.fn(() => true);
        const matchingVerify = vi.fn(() => true);
        let wrong: ReturnType<typeof registered.make> | undefined;
        let matching: ReturnType<typeof registered.make> | undefined;
        registered.dispatch.mockImplementation(async () => {
            dispatched.resolve();
        });
        registered.client.onClose = () => ownerClosed.resolve();

        try {
            expect(await registered.owner.start(registered.options)).toEqual({
                kind: 'registered',
                registerSequence: sequences[2],
            });
            expect(registered.client.errors).toEqual([]);
            expect(registered.client.rawChecks.length).toBeGreaterThan(0);
            expect(registered.client.rawChecks.every((ok) => ok)).toBe(true);
            expect(isLinuxEasyOwnerPushActive(registered.owner)).toBe(true);
            expect(isLinuxEasyOwnerPushActiveForUin(registered.owner, registered.uin)).toBe(true);
            expect(isLinuxEasyOwnerPushActiveForUin(registered.owner, different.uin)).toBe(false);
            wrong = createLinuxEasyPushProcessor({
                owner: registered.owner,
                uin: different.uin,
                ingress: different.ingress,
                queue: different.queue,
                verifyRaw: wrongVerify,
            });
            matching = registered.make(matchingVerify);
            const candidate = registered.push();
            expect(wrong.onPush(candidate, route(pushSequence))).toBeUndefined();
            expect(matching.onPush(candidate, route(pushSequence))).toBeUndefined();
            expect(wrong.status()).toBe('buffering');
            expect(wrong.activate()).toBe(false);
            expect(wrong.status()).toBe('buffering');
            expect(wrongVerify).not.toHaveBeenCalled();
            expect(different.dispatch).not.toHaveBeenCalled();
            expect(matchingVerify).not.toHaveBeenCalled();
            expect(matching.activate()).toBe(true);
            expect(matching.status()).toBe('active');
            const result = await Promise.race([
                dispatched.promise.then(() => 'dispatched'),
                ownerClosed.promise.then(() => 'closed'),
            ]);
            expect(result).toBe('dispatched');
            expect(matchingVerify).toHaveBeenCalledTimes(1);
            expect(registered.dispatch).toHaveBeenCalledTimes(1);
            expect(isLinuxEasyOwnerPushActiveForUin(registered.owner, registered.uin)).toBe(true);
            expect(wrong.activate()).toBe(false);
            expect(wrong.status()).toBe('buffering');
            expect(wrongVerify).not.toHaveBeenCalled();
            expect(different.dispatch).not.toHaveBeenCalled();
            wrong.stop();
            await wrong.drain();
            expect(wrong.status()).toBe('stopped');
            expect(() => wrong!.onPush(candidate, route(pushSequence))).toThrow(
                'direct push processor stopped',
            );
            expect(wrongVerify).not.toHaveBeenCalled();
            expect(different.dispatch).not.toHaveBeenCalled();
        } finally {
            wrong?.stop();
            matching?.stop();
            await wrong?.drain();
            await matching?.drain();
            await registered.cleanup();
            await different.cleanup();
        }
    });

    it.each(['verifier', 'route-mismatch', 'owner-inactive'] as const)(
        'reports and retains failed after %s in the worker',
        async (mode) => {
            const f = fixture();
            const entered = deferred();
            const processor = f.make(() => {
                entered.resolve();

                if (mode === 'owner-inactive') {
                    f.owner.close();
                }

                return mode !== 'verifier';
            });

            try {
                expect(processor.status()).toBe('buffering');
                expect((await f.owner.start(f.options)).kind).toBe('registered');
                expect(processor.activate()).toBe(true);
                expect(processor.status()).toBe('active');
                const frame = f.push(
                    mode === 'route-mismatch' ? { sequence: pushSequence + 1 } : {},
                );
                expect(processor.onPush(frame, route(pushSequence))).toBeUndefined();
                await entered.promise;
                expect(processor.status()).toBe('failed');
                await processor.drain();
                expect(f.dispatch).not.toHaveBeenCalled();
                expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(false);
                processor.stop();
                expect(processor.status()).toBe('failed');
                expect(() => processor.onPush(frame, route(pushSequence))).toThrow(
                    'direct push processor stopped',
                );
                expect(processor.status()).toBe('failed');
            } finally {
                processor.stop();
                await processor.drain();
                await f.cleanup();
            }
        },
    );

    it('continues to throw for invalid constructor options', async () => {
        const f = fixture();

        try {
            expect(() =>
                createLinuxEasyPushProcessor({
                    owner: f.owner,
                    uin: f.uin,
                    ingress: {
                        ...f.ingress,
                        sourceAuthenticationHandled: false as unknown as true,
                    },
                    queue: f.queue,
                    verifyRaw: () => true,
                }),
            ).toThrow();
        } finally {
            await f.cleanup();
        }
    });

    it('buffers while registration is pending, then verifies and dispatches encrypted pushes in FIFO order', async () => {
        const f = fixture();
        f.client.holdRegister = true;
        const firstEntered = deferred();
        const secondEntered = deferred();
        const releaseFirst = deferred();
        const verified: number[] = [];
        const verifierCopies: Uint8Array[] = [];
        const processor = f.make((copy, meta) => {
            verifierCopies.push(copy);
            verified.push(meta.sequence);
            return true;
        });
        f.dispatch.mockImplementation(async (_meta) => {
            if (f.dispatch.mock.calls.length === 1) {
                firstEntered.resolve();
                await releaseFirst.promise;
            } else {
                secondEntered.resolve();
            }
        });
        const first = f.push();
        const second = f.push({ sequence: pushSequence + 1 });
        const firstBefore = Uint8Array.from(first);
        const secondBefore = Uint8Array.from(second);
        const pending = f.owner.start(f.options);

        try {
            await waitEntered(f.client.entered.promise, pending);
            expect(processor.onPush(first, route(pushSequence))).toBeUndefined();
            expect(processor.onPush(second, route(pushSequence + 1))).toBeUndefined();
            expect(processor.activate()).toBe(false);
            expect(verified).toEqual([]);
            expect(f.dispatch).not.toHaveBeenCalled();
            f.client.gate.resolve();
            expect(await pending).toEqual({ kind: 'registered', registerSequence: sequences[2] });
            expect(f.client.errors).toEqual([]);
            expect(processor.activate()).toBe(true);
            expect(processor.activate()).toBe(false);
            await firstEntered.promise;
            expect(verified).toEqual([pushSequence]);
            expect(f.dispatch).toHaveBeenCalledTimes(1);
            expect(verifierCopies[0]).not.toBe(first);
            expect([...verifierCopies[0]]).toEqual(Array(first.length).fill(0));
            releaseFirst.resolve();
            await secondEntered.promise;
            expect(verified).toEqual([pushSequence, pushSequence + 1]);
            expect(f.dispatch.mock.calls.map(([meta]) => meta.seqId)).toEqual([
                pushSequence,
                pushSequence + 1,
            ]);
            expect(f.dispatch.mock.calls.every(([, events]) => events.length > 0)).toBe(true);
            expect([...verifierCopies[1]]).toEqual(Array(second.length).fill(0));
            expect(Array.from(first)).toEqual(Array.from(firstBefore));
            expect(Array.from(second)).toEqual(Array.from(secondBefore));
        } finally {
            f.client.gate.resolve();
            releaseFirst.resolve();
            processor.stop();
            await processor.drain();
            await f.cleanup();
        }
    });

    it.each(['frames', 'bytes'] as const)(
        'counts inflight plus queued %s and throws synchronously on overflow',
        async (mode) => {
            const f = fixture();
            const first = f.push();
            const second = f.push({ sequence: pushSequence + 1 });
            const third = f.push({ sequence: pushSequence + 2 });
            const entered = deferred();
            const release = deferred();
            f.dispatch.mockImplementation(async () => {
                entered.resolve();
                await release.promise;
            });
            const limits =
                mode === 'frames'
                    ? { ...f.queue, maxQueuedFrames: 2 }
                    : { ...f.queue, maxQueuedBytes: first.length + second.length };
            const processor = f.make(() => true, limits);

            try {
                expect((await f.owner.start(f.options)).kind).toBe('registered');
                expect(processor.activate()).toBe(true);
                expect(processor.onPush(first, route(pushSequence))).toBeUndefined();
                await entered.promise;
                expect(processor.onPush(second, route(pushSequence + 1))).toBeUndefined();
                expect(() => processor.onPush(third, route(pushSequence + 2))).toThrow(
                    'direct push processor stopped',
                );
                expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(false);
                expect(() => processor.onPush(first, route(pushSequence))).toThrow(
                    'direct push processor stopped',
                );
                expect(f.dispatch).toHaveBeenCalledTimes(1);
            } finally {
                release.resolve();
                processor.stop();
                await processor.drain();
                await f.cleanup();
            }
        },
    );

    it.each(['sequence', 'account', 'command', 'retCode', 'wrong-key'] as const)(
        'stops without dispatch on a synthetic %s mismatch',
        async (kind) => {
            const f = fixture();
            const other = fixture('234567');
            const verified = deferred();
            const processor = f.make(() => {
                verified.resolve();
                return true;
            });

            try {
                expect((await f.owner.start(f.options)).kind).toBe('registered');
                expect(processor.activate()).toBe(true);
                const frame =
                    kind === 'sequence'
                        ? f.push({ sequence: pushSequence + 1 })
                        : kind === 'account'
                          ? f.push({ account: other.uin })
                          : kind === 'command'
                            ? f.push({ command: 'Synthetic.NotPush' })
                            : kind === 'retCode'
                              ? f.push({ retCode: 1 })
                              : other.push();
                const before = Uint8Array.from(frame);
                expect(processor.onPush(frame, route(pushSequence))).toBeUndefined();
                await verified.promise;
                expect(f.dispatch).not.toHaveBeenCalled();
                expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(false);
                expect(() => processor.onPush(frame, route(pushSequence))).toThrow(
                    'direct push processor stopped',
                );
                expect(Array.from(frame)).toEqual(Array.from(before));
            } finally {
                processor.stop();
                await processor.drain();
                await f.cleanup();
                await other.cleanup();
            }
        },
    );

    it('rejects an invalid raw route synchronously and closes before propagating the failure', async () => {
        const f = fixture();
        const processor = f.make();
        const frame = f.push();

        try {
            expect((await f.owner.start(f.options)).kind).toBe('registered');
            expect(processor.activate()).toBe(true);
            let caught: unknown;

            try {
                processor.onPush(frame, route(pushSequence, 'Synthetic.NotPush'));
            } catch (error) {
                caught = error;
            }

            expect(caught).toBeInstanceOf(Error);
            expect((caught as Error).message).toBe('direct push processor stopped');
            expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(false);
            expect(f.dispatch).not.toHaveBeenCalled();
        } finally {
            processor.stop();
            await processor.drain();
            await f.cleanup();
        }
    });

    it.each([
        'false',
        'truthy',
        'throw',
        'promise',
        'rejected',
        'thenable',
        'mutate',
        'detach',
        'close',
        'stop',
    ] as const)('fails closed for verifier %s without reaching the pipeline', async (mode) => {
        const f = fixture();
        const entered = deferred();
        let copy: Uint8Array | undefined;
        let thenReads = 0;
        let processor!: ReturnType<typeof f.make>;

        const verifier = (frame: Uint8Array): boolean => {
            copy = frame;
            entered.resolve();

            if (mode === 'false') {
                return false;
            }

            if (mode === 'truthy') {
                return 1 as unknown as boolean;
            }

            if (mode === 'throw') {
                throw new Error('synthetic verifier failure');
            }

            if (mode === 'promise') {
                return Promise.resolve(true) as unknown as boolean;
            }

            if (mode === 'rejected') {
                return Promise.reject(new Error('synthetic rejection')) as unknown as boolean;
            }

            if (mode === 'thenable') {
                return Object.defineProperty({}, 'then', {
                    get() {
                        thenReads++;
                        throw new Error('then getter');
                    },
                }) as boolean;
            }

            if (mode === 'mutate') {
                frame[0] ^= 1;
            }

            if (mode === 'detach') {
                structuredClone(frame.buffer, { transfer: [frame.buffer as ArrayBuffer] });
            }

            if (mode === 'close') {
                f.owner.close();
            }

            if (mode === 'stop') {
                processor.stop();
            }

            return true;
        };

        processor = f.make(verifier);
        const frame = f.push();
        const before = Uint8Array.from(frame);

        try {
            expect((await f.owner.start(f.options)).kind).toBe('registered');
            expect(processor.activate()).toBe(true);
            expect(processor.onPush(frame, route(pushSequence))).toBeUndefined();
            await entered.promise;
            expect(thenReads).toBe(0);
            expect(f.dispatch).not.toHaveBeenCalled();
            expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(false);
            expect(() => processor.onPush(frame, route(pushSequence))).toThrow(
                'direct push processor stopped',
            );
            expect(Array.from(frame)).toEqual(Array.from(before));
            expect(copy).toBeDefined();
            expect(copy).not.toBe(frame);

            if (mode !== 'detach') {
                expect([...copy!]).toEqual(Array(frame.length).fill(0));
            }
        } finally {
            processor.stop();
            await processor.drain();
            await f.cleanup();
        }
    });

    it('wipes the verifier copy synchronously on reentrant stop and again on callback return', async () => {
        const f = fixture();
        const entered = deferred();
        let copy: Uint8Array | undefined;
        let nonzeroBeforeStop = false;
        let afterStop: number[] = [];
        let processor!: ReturnType<typeof f.make>;
        processor = f.make((frame) => {
            copy = frame;
            nonzeroBeforeStop = frame.some((byte) => byte !== 0);
            processor.stop();
            afterStop = Array.from(frame);
            frame.fill(0xa5);
            entered.resolve();
            return true;
        });
        const input = f.push();
        const original = Uint8Array.from(input);

        try {
            expect((await f.owner.start(f.options)).kind).toBe('registered');
            expect(processor.activate()).toBe(true);
            expect(processor.onPush(input, route(pushSequence))).toBeUndefined();
            await entered.promise;
            await processor.drain();
            expect(nonzeroBeforeStop).toBe(true);
            expect(afterStop).toEqual(Array(input.length).fill(0));
            expect(copy).toBeDefined();
            expect(Array.from(copy!)).toEqual(Array(input.length).fill(0));
            expect(Array.from(input)).toEqual(Array.from(original));
            expect(f.dispatch).not.toHaveBeenCalled();
            expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(false);
        } finally {
            processor.stop();
            await processor.drain();
            await f.cleanup();
        }
    });

    it('wipes the processor business body synchronously when the identity getter stops admission', async () => {
        // The fresh modules capture this dormant wrapper at import time. Restore the
        // global intrinsic immediately; arm the wrapper only for this synthetic push.
        vi.resetModules();
        const nativeSet = Uint8Array.prototype.set;
        let armed = false;
        let expected: Uint8Array | undefined;
        let sourceView: Uint8Array | undefined;
        let ingressCopy: Uint8Array | undefined;
        let matches = 0;

        Uint8Array.prototype.set = function (
            this: Uint8Array,
            source: ArrayLike<number>,
            offset?: number,
        ): void {
            Reflect.apply(nativeSet, this, [source, offset ?? 0]);

            if (
                !armed ||
                !(source instanceof Uint8Array) ||
                !expected ||
                source.length !== expected.length
            ) {
                return;
            }

            for (let i = 0; i < source.length; i++) {
                if (source[i] !== expected[i]) {
                    return;
                }
            }

            matches++;
            sourceView = source;
            ingressCopy = this;
        };

        let freshOwner: typeof import('../../src/direct/linux-easy-account-owner');
        let freshProcessor: typeof import('../../src/direct/linux-easy-push-processor');

        try {
            freshProcessor = await import('../../src/direct/linux-easy-push-processor');
            freshOwner = await import('../../src/direct/linux-easy-account-owner');
        } finally {
            Uint8Array.prototype.set = nativeSet;
        }

        const f = fixture('123456', freshOwner.createLinuxEasyAccountOwnerWithKeyCapability);
        const entered = deferred();
        const pipelineEntered = deferred();
        const closed = deferred();
        f.dispatch.mockImplementation(async () => {
            pipelineEntered.resolve();
        });
        f.client.onClose = () => closed.resolve();
        expected = f.body(pushSequence);
        const input = f.push({ body: expected });
        const original = Uint8Array.from(input);
        let before: number[] = [];
        let after: number[] = [];
        let copiedAfter: number[] = [];
        let separateBuffers = false;
        let sourceIsPrivate = false;
        const processor = freshProcessor.createLinuxEasyPushProcessor({
            owner: f.owner,
            uin: f.uin,
            ingress: f.ingress,
            queue: f.queue,
            verifyRaw: () => {
                armed = true;
                return true;
            },
        });

        try {
            expect((await f.owner.start(f.options)).kind).toBe('registered');
            expect(processor.activate()).toBe(true);
            Object.defineProperty(f.identity, 'uin', {
                configurable: true,
                get() {
                    if (armed && sourceView && ingressCopy) {
                        armed = false;
                        before = Array.from(sourceView);
                        separateBuffers = sourceView.buffer !== ingressCopy.buffer;
                        sourceIsPrivate =
                            sourceView.buffer !== expected!.buffer &&
                            sourceView.buffer !== input.buffer;
                        entered.resolve();
                        processor.stop();
                        after = Array.from(sourceView);
                        copiedAfter = Array.from(ingressCopy);
                        sourceView.fill(0xa5);
                    }

                    return f.uin;
                },
            });
            expect(processor.onPush(input, route(pushSequence))).toBeUndefined();
            const reachedGetter = await Promise.race([
                entered.promise.then(() => true),
                pipelineEntered.promise.then(() => false),
                closed.promise.then(() => false),
            ]);
            expect(reachedGetter).toBe(true);
            await processor.drain();
            expect(matches).toBeGreaterThan(0);
            expect(before).toEqual(Array.from(expected));
            expect(separateBuffers).toBe(true);
            expect(sourceIsPrivate).toBe(true);
            expect(before.some((byte) => byte !== 0)).toBe(true);
            expect(after).toEqual(Array(expected.length).fill(0));
            expect(copiedAfter).toEqual(Array(expected.length).fill(0));
            expect(Array.from(sourceView!)).toEqual(Array(expected.length).fill(0));
            expect(Array.from(input)).toEqual(Array.from(original));
            expect(f.dispatch).not.toHaveBeenCalled();
            expect(freshOwner.isLinuxEasyOwnerPushActive(f.owner)).toBe(false);
        } finally {
            armed = false;
            processor.stop();
            await processor.drain();
            await f.cleanup();
            vi.resetModules();
        }
    });

    it('fences identity getter reentry that closes the owner', async () => {
        const f = fixture();
        const verified = deferred();
        const processor = f.make(() => {
            verified.resolve();
            return true;
        });
        let reads = 0;

        try {
            expect((await f.owner.start(f.options)).kind).toBe('registered');
            expect(processor.activate()).toBe(true);
            Object.defineProperty(f.identity, 'uin', {
                configurable: true,
                get() {
                    reads++;
                    f.owner.close();
                    return f.uin;
                },
            });
            expect(processor.onPush(f.push(), route(pushSequence))).toBeUndefined();
            await verified.promise;
            await processor.drain();
            expect(reads).toBeGreaterThan(0);
            expect(f.dispatch).not.toHaveBeenCalled();
            expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(false);
        } finally {
            processor.stop();
            await processor.drain();
            await f.cleanup();
        }
    });

    it('makes callback reentry observe the stopped state before owner close completes', async () => {
        const f = fixture();
        const processor = f.make();
        const frame = f.push();
        const failures: unknown[] = [];

        try {
            expect((await f.owner.start(f.options)).kind).toBe('registered');
            expect(processor.activate()).toBe(true);

            f.client.onClose = () => {
                try {
                    processor.onPush(frame, route(pushSequence));
                } catch (error) {
                    failures.push(error);
                }

                processor.stop();
            };

            processor.stop();
            await processor.drain();
            expect(failures).toHaveLength(1);
            expect(failures[0]).toMatchObject({ message: 'direct push processor stopped' });
            expect(f.dispatch).not.toHaveBeenCalled();
        } finally {
            f.client.onClose = undefined;
            processor.stop();
            await processor.drain();
            await f.cleanup();
        }
    });

    it('stops queued processing when the in-memory pipeline rejects', async () => {
        const f = fixture();
        const closed = deferred();
        f.client.onClose = () => closed.resolve();
        f.dispatch.mockImplementation(async () => {
            throw new Error('synthetic pipeline failure');
        });
        const processor = f.make();

        try {
            expect((await f.owner.start(f.options)).kind).toBe('registered');
            expect(processor.activate()).toBe(true);
            expect(processor.onPush(f.push(), route(pushSequence))).toBeUndefined();
            expect(
                processor.onPush(f.push({ sequence: pushSequence + 1 }), route(pushSequence + 1)),
            ).toBeUndefined();
            await closed.promise;
            await processor.drain();
            expect(f.dispatch).toHaveBeenCalledTimes(1);
            expect(isLinuxEasyOwnerPushActive(f.owner)).toBe(false);
        } finally {
            f.client.onClose = undefined;
            processor.stop();
            await processor.drain();
            await f.cleanup();
        }
    });

    it('keeps two synthetic owners independent when one processor stops', async () => {
        const a = fixture();
        const b = fixture('234567');
        const aEntered = deferred();
        const bEntered = deferred();
        a.dispatch.mockImplementation(async () => {
            aEntered.resolve();
        });
        b.dispatch.mockImplementation(async () => {
            bEntered.resolve();
        });
        const pa = a.make();
        const pb = b.make();

        try {
            expect((await a.owner.start(a.options)).kind).toBe('registered');
            expect((await b.owner.start(b.options)).kind).toBe('registered');
            expect(pa.activate()).toBe(true);
            expect(pb.activate()).toBe(true);
            expect(pa.onPush(a.push(), route(pushSequence))).toBeUndefined();
            await aEntered.promise;
            pa.stop();
            await pa.drain();
            expect(isLinuxEasyOwnerPushActive(a.owner)).toBe(false);
            expect(isLinuxEasyOwnerPushActive(b.owner)).toBe(true);
            expect(pb.onPush(b.push(), route(pushSequence))).toBeUndefined();
            await bEntered.promise;
            expect(a.dispatch).toHaveBeenCalledTimes(1);
            expect(b.dispatch).toHaveBeenCalledTimes(1);
        } finally {
            pa.stop();
            pb.stop();
            await pa.drain();
            await pb.drain();
            await a.cleanup();
            await b.cleanup();
        }
    });
});
