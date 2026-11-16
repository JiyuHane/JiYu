import { createCipheriv, createECDH } from 'node:crypto';
import type {
    LinuxNTEasyLoginReferenceResponseBody,
    LinuxNTLoginReferenceForward,
    LinuxNTLoginReferenceResponseCommon,
    NTLoginForwardRequest,
} from '@snowluma/proto-defs/direct-login';
import type { SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import type { PushMsg } from '@snowluma/proto-defs/message';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import {
    createGuardedDirectPushIngress,
    type DirectIngressResult,
} from '../../src/direct/direct-push-ingress';
import { IdentityService } from '../../src/identity-service';
import { MSG_PUSH_CMD } from '../../src/msg-push';
import type { IncomingPacketPipeline } from '../../src/packet-pipeline';
import { KEY_EXCHANGE_COMMAND } from '../../src/direct/key-exchange-flow';
import {
    decodeKeyExchangeRequest,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
} from '../../src/direct/key-exchange-protobuf';
import {
    createLinuxEasyAccountOwner,
    createLinuxEasyAccountOwnerWithKeyCapability,
    isLinuxEasyOwnerPushActive,
    isLinuxEasyOwnerPushActiveForUin,
    type LinuxEasyAccountOwner,
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

// Entirely synthetic, in-memory data and callbacks. Active is only a local state gate.
const SEQUENCES = [0x80000001, 0xf0000002, 0xf0000003] as const;
const COMMANDS = [KEY_EXCHANGE_COMMAND, LINUX_EASY_LOGIN_COMMAND, SSO_INFO_SYNC_COMMAND] as const;

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function fixture(uin = '123456') {
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

    function response(sequence: number, command: string, body: Uint8Array, register: boolean) {
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
        const encrypted = own(qqTeaEncrypt(inner, register ? d2Key : zero));
        const frame = own(
            Buffer.concat([
                word(0),
                word(12),
                own(Buffer.of(register ? 1 : 2, 0)),
                field(text(uin)),
                encrypted,
            ]),
        );
        frame.writeUInt32BE(frame.length);
        return frame;
    }

    function unpack(input: Uint8Array, register: boolean) {
        const frame = own(Buffer.from(input));
        checkRaw(frame.readUInt32BE(0) === frame.length);
        const d2End = 9 + frame.readUInt32BE(9);
        const accountStart = d2End + 1;
        const accountEnd = accountStart + frame.readUInt32BE(accountStart);
        checkRaw(frame.subarray(accountStart + 4, accountEnd).toString() === uin);
        const decrypted = own(qqTeaDecrypt(frame.subarray(accountEnd), register ? d2Key : zero));
        const inner = own(Buffer.from(decrypted));
        const sequence = inner.readUInt32BE(4);
        let offset = 28;

        const take = (width: 2 | 4 = 4) => {
            const length = width === 2 ? inner.readUInt16BE(offset) : inner.readUInt32BE(offset);
            checkRaw(length >= width);
            checkRaw(offset + length <= inner.length);
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
    }

    class FakeClient implements Sso12RawClient {
        private resolveClosed!: (reason: Sso12CloseReason) => void;
        readonly whenClosed = new Promise<Sso12CloseReason>((resolve) => {
            this.resolveClosed = resolve;
        });
        readonly entered = deferred();
        readonly gate = deferred();
        readonly sendEntered = deferred();
        readonly sendGate = deferred();
        readonly errors: unknown[] = [];
        readonly rawChecks = rawChecks;
        holdRegister = false;
        holdSend = false;
        calls = 0;
        onSend: (() => void) | undefined;
        onClose: (() => void) | undefined;
        readonly close = vi.fn(() => {
            this.onClose?.();
            this.gate.resolve();
            this.sendGate.resolve();
            this.resolveClosed({ kind: 'local', code: 'synthetic-close' });
        });

        externalClose() {
            this.resolveClosed({ kind: 'local', code: 'synthetic-external-close' });
        }

        async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
            const index = this.calls++;

            if (index === 3) {
                this.onSend?.();

                if (this.holdSend) {
                    this.sendEntered.resolve();
                    await this.sendGate.promise;
                }

                return { kind: 'failure', code: 'synthetic-send-failure', writeState: 'unknown' };
            }

            try {
                const sequence = SEQUENCES[index];

                if (sequence === undefined) {
                    throw new Error('unexpected synthetic transaction');
                }

                const identity = { uin, sequence };
                const built = await options.buildRequest(identity);
                own(built.frame);
                const request = unpack(built.frame, index === 2);
                checkRaw(request.sequence === sequence);
                checkRaw(request.command === COMMANDS[index]);
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

    const client = new FakeClient();
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
        send,
        cleanup() {
            client.onClose = undefined;
            client.onSend = undefined;
            client.gate.resolve();
            client.sendGate.resolve();
            client.close();
            sign.mockClear();
            verify.mockClear();

            for (const bytes of allocations) {
                bytes.fill(0);
            }
        },
    };
}

function expectRegisteredRaw(f: ReturnType<typeof fixture>) {
    expect(f.client.errors).toEqual([]);
    expect(f.client.rawChecks.length).toBeGreaterThan(0);
    expect(f.client.rawChecks.every((ok) => ok)).toBe(true);
}

async function waitEntered(entered: Promise<void>, pending: Promise<{ kind: string }>) {
    expect(
        await Promise.race([entered.then(() => 'entered'), pending.then(() => 'finished')]),
    ).toBe('entered');
}

function guardedIngress(owner: LinuxEasyAccountOwner) {
    const uin = '123456';
    const identity = IdentityService.memory(uin);
    const dispatch = vi.fn(async () => {});
    const pipeline = { processDecodedDirectEvents: dispatch } as unknown as IncomingPacketPipeline;
    const ingress = createGuardedDirectPushIngress(
        {
            uin,
            identity,
            pipeline,
            pipelineIdentityBound: true,
            sourceAuthenticationHandled: true,
            maxBodyBytes: 65536,
            maxPendingBytes: 262144,
            maxPending: 8,
            maxEventsPerPush: 16,
        },
        () => isLinuxEasyOwnerPushActive(owner),
    );
    const body = protobuf_encode<PushMsg>({
        message: {
            responseHead: { fromUin: 10001, fromUid: 'synthetic_peer' },
            contentHead: {
                msgType: 166,
                sequence: 32743,
                ntMsgSeq: 63214,
                timestamp: 1700000000,
                msgId: 1,
            },
            body: { richText: { elems: [{ text: { str: 'synthetic guard' } }] } },
        },
    });
    const meta = { uin, sequence: 1, command: MSG_PUSH_CMD, retCode: 0 };
    return { identity, ingress, dispatch, body, meta };
}

describe('Linux Easy owner push-active local state with synthetic client', () => {
    it('is false before and during staged registration, true after settlement, and false on close', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        let pending: ReturnType<typeof owner.start> | undefined;
        f.client.holdRegister = true;

        try {
            expect(isLinuxEasyOwnerPushActive(owner)).toBe(false);
            expect(isLinuxEasyOwnerPushActiveForUin(owner, '123456')).toBe(false);
            pending = owner.start(f.options);
            await waitEntered(f.client.entered.promise, pending);
            expect(f.client.calls).toBe(3);
            expect(isLinuxEasyOwnerPushActive(owner)).toBe(false);
            expect(isLinuxEasyOwnerPushActiveForUin(owner, '123456')).toBe(false);
            f.client.gate.resolve();
            expect(await pending).toEqual({ kind: 'registered', registerSequence: SEQUENCES[2] });
            expectRegisteredRaw(f);
            expect(isLinuxEasyOwnerPushActive(owner)).toBe(true);
            expect(isLinuxEasyOwnerPushActiveForUin(owner, '123456')).toBe(true);
            expect(isLinuxEasyOwnerPushActiveForUin(owner, '234567')).toBe(false);
            expect(isLinuxEasyOwnerPushActiveForUin(owner, '123456')).toBe(true);
            owner.close();
            expect(isLinuxEasyOwnerPushActive(owner)).toBe(false);
            expect(isLinuxEasyOwnerPushActiveForUin(owner, '123456')).toBe(false);
            expect(isLinuxEasyOwnerPushActiveForUin(owner, '123456')).toBe(false);
        } finally {
            f.client.gate.resolve();
            owner.close();
            await pending;
            f.cleanup();
        }
    });

    it('rejects non-string account arguments without inspecting or converting them', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        const observations: string[] = [];
        const boxed = Object('123456') as object;
        Object.defineProperties(boxed, {
            [Symbol.toPrimitive]: {
                get() {
                    observations.push('toPrimitive getter');
                    throw new Error('unexpected conversion');
                },
            },
            toString: {
                get() {
                    observations.push('toString getter');
                    throw new Error('unexpected conversion');
                },
            },
            valueOf: {
                get() {
                    observations.push('valueOf getter');
                    throw new Error('unexpected conversion');
                },
            },
        });
        const proxy = new Proxy(boxed, {
            get() {
                observations.push('get trap');
                throw new Error('unexpected proxy access');
            },
            getPrototypeOf() {
                observations.push('prototype trap');
                throw new Error('unexpected proxy access');
            },
            getOwnPropertyDescriptor() {
                observations.push('descriptor trap');
                throw new Error('unexpected proxy access');
            },
            ownKeys() {
                observations.push('keys trap');
                throw new Error('unexpected proxy access');
            },
            has() {
                observations.push('has trap');
                throw new Error('unexpected proxy access');
            },
        });
        const inputs: unknown[] = [undefined, null, 123456, boxed, proxy];

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            expectRegisteredRaw(f);
            expect(isLinuxEasyOwnerPushActive(owner)).toBe(true);
            expect(isLinuxEasyOwnerPushActiveForUin(owner, '123456')).toBe(true);
            const results = inputs.map((input) =>
                isLinuxEasyOwnerPushActiveForUin(owner, input as string),
            );
            expect(results).toEqual([false, false, false, false, false]);
            expect(observations).toEqual([]);
            expect(isLinuxEasyOwnerPushActive(owner)).toBe(true);
            expect(isLinuxEasyOwnerPushActiveForUin(owner, '123456')).toBe(true);
        } finally {
            owner.close();
            f.cleanup();
        }
    });

    it('stays true while send is busy, then is false inside broker finish before client close returns', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        const inSend: boolean[] = [];
        const boundInSend: boolean[] = [];
        const inClose: boolean[] = [];
        const boundInClose: boolean[] = [];
        let pending: ReturnType<typeof owner.sendText> | undefined;
        f.client.holdSend = true;

        f.client.onSend = () => {
            inSend.push(isLinuxEasyOwnerPushActive(owner));
            boundInSend.push(isLinuxEasyOwnerPushActiveForUin(owner, '123456'));
        };

        f.client.onClose = () => {
            inClose.push(isLinuxEasyOwnerPushActive(owner));
            boundInClose.push(isLinuxEasyOwnerPushActiveForUin(owner, '123456'));
        };

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            expectRegisteredRaw(f);
            expect(isLinuxEasyOwnerPushActive(owner)).toBe(true);
            expect(isLinuxEasyOwnerPushActiveForUin(owner, '123456')).toBe(true);
            pending = owner.sendText(f.send);
            await waitEntered(f.client.sendEntered.promise, pending);
            expect(inSend).toEqual([true]);
            expect(boundInSend).toEqual([true]);
            expect(isLinuxEasyOwnerPushActive(owner)).toBe(true);
            expect(isLinuxEasyOwnerPushActiveForUin(owner, '123456')).toBe(true);
            expect(isLinuxEasyOwnerPushActiveForUin(owner, '234567')).toBe(false);
            f.client.sendGate.resolve();
            expect(await pending).toMatchObject({
                kind: 'failure',
                writeState: 'unknown',
            });
            expect(f.client.calls).toBe(4);
            expect(inClose).toEqual([false]);
            expect(boundInClose).toEqual([false]);
            expect(isLinuxEasyOwnerPushActive(owner)).toBe(false);
            expect(isLinuxEasyOwnerPushActiveForUin(owner, '123456')).toBe(false);
        } finally {
            f.client.sendGate.resolve();
            owner.close();
            await pending;
            f.cleanup();
        }
    });

    it('becomes false when the broker observes client.whenClosed', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        const brokerClosed = deferred();
        const observed: boolean[] = [];

        f.client.onClose = () => {
            observed.push(isLinuxEasyOwnerPushActive(owner));
            brokerClosed.resolve();
        };

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            expect(isLinuxEasyOwnerPushActive(owner)).toBe(true);
            f.client.externalClose();
            await brokerClosed.promise;
            expect(observed).toEqual([false]);
            expect(isLinuxEasyOwnerPushActive(owner)).toBe(false);
        } finally {
            owner.close();
            f.cleanup();
        }
    });

    it('stops admission when the identity getter synchronously closes the registered owner', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        const g = guardedIngress(owner);
        let getterCalls = 0;

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            expect(g.ingress.activate()).toBe(true);
            // Positive control for this locally generated body and fake pipeline.
            expect(await g.ingress.submit(g.body, g.meta)).toEqual({ kind: 'settled', events: 1 });
            expect(g.dispatch).toHaveBeenCalledTimes(1);
            g.dispatch.mockClear();
            Object.defineProperty(g.identity, 'uin', {
                configurable: true,
                get() {
                    getterCalls++;
                    owner.close();
                    return '123456';
                },
            });
            expect(await g.ingress.submit(g.body, g.meta)).toEqual({
                kind: 'rejected',
                reason: 'stopped',
            });
            expect(getterCalls).toBe(1);
            expect(isLinuxEasyOwnerPushActive(owner)).toBe(false);
            expect(g.dispatch).not.toHaveBeenCalled();
        } finally {
            g.ingress.stop();
            await g.ingress.drain();
            await g.identity.close();
            owner.close();
            g.body.fill(0);
            f.cleanup();
        }
    });

    it('rejects ingress synchronously inside client close after broker revokes the key', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        const g = guardedIngress(owner);
        const duringClose: boolean[] = [];
        let submitted: Promise<DirectIngressResult> | undefined;

        f.client.onClose = () => {
            duringClose.push(isLinuxEasyOwnerPushActive(owner));
            submitted = g.ingress.submit(g.body, g.meta);
        };

        try {
            expect((await owner.start(f.options)).kind).toBe('registered');
            expect(g.ingress.activate()).toBe(true);
            expect(isLinuxEasyOwnerPushActive(owner)).toBe(true);
            expect(await owner.sendText(f.send)).toMatchObject({
                kind: 'failure',
                writeState: 'unknown',
            });
            expect(f.client.calls).toBe(4);
            expect(duringClose).toEqual([false]);
            expect(submitted).toBeDefined();
            expect(await submitted).toEqual({ kind: 'rejected', reason: 'stopped' });
            expect(g.dispatch).not.toHaveBeenCalled();
        } finally {
            f.client.onClose = undefined;
            g.ingress.stop();
            await g.ingress.drain();
            await g.identity.close();
            owner.close();
            g.body.fill(0);
            f.cleanup();
        }
    });

    it('turns false synchronously when the owner signal aborts', async () => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwnerWithKeyCapability();
        const controller = new AbortController();

        try {
            expect((await owner.start({ ...f.options, signal: controller.signal })).kind).toBe(
                'registered',
            );
            expect(isLinuxEasyOwnerPushActive(owner)).toBe(true);
            controller.abort();
            expect(isLinuxEasyOwnerPushActive(owner)).toBe(false);
            expect(isLinuxEasyOwnerPushActive(owner)).toBe(false);
        } finally {
            owner.close();
            f.cleanup();
        }
    });

    it('isolates two accounts and ignores legacy, forged and proxy owners without traps', async () => {
        const f = fixture();
        const g = fixture('234567');
        const a = createLinuxEasyAccountOwnerWithKeyCapability();
        const b = createLinuxEasyAccountOwnerWithKeyCapability();
        const legacy = createLinuxEasyAccountOwner();
        const legacyFixture = fixture('345678');
        let traps = 0;
        const forged = {
            get close() {
                traps++;
                throw new Error('getter');
            },
            get start() {
                traps++;
                throw new Error('getter');
            },
            get sendText() {
                traps++;
                throw new Error('getter');
            },
        } as LinuxEasyAccountOwner;
        const proxy = new Proxy(a, {
            get() {
                traps++;
                throw new Error('get trap');
            },
            getPrototypeOf() {
                traps++;
                throw new Error('prototype trap');
            },
            ownKeys() {
                traps++;
                throw new Error('keys trap');
            },
        });

        try {
            expect((await a.start(f.options)).kind).toBe('registered');
            expect((await b.start(g.options)).kind).toBe('registered');
            expect((await legacy.start(legacyFixture.options)).kind).toBe('registered');
            expectRegisteredRaw(f);
            expectRegisteredRaw(g);
            expectRegisteredRaw(legacyFixture);
            expect(isLinuxEasyOwnerPushActive(a)).toBe(true);
            expect(isLinuxEasyOwnerPushActive(b)).toBe(true);
            expect(isLinuxEasyOwnerPushActiveForUin(a, '123456')).toBe(true);
            expect(isLinuxEasyOwnerPushActiveForUin(a, '234567')).toBe(false);
            expect(isLinuxEasyOwnerPushActiveForUin(b, '234567')).toBe(true);
            expect(isLinuxEasyOwnerPushActiveForUin(b, '123456')).toBe(false);
            expect(isLinuxEasyOwnerPushActive(legacy)).toBe(false);
            expect(isLinuxEasyOwnerPushActiveForUin(legacy, '345678')).toBe(false);
            expect(isLinuxEasyOwnerPushActive(forged)).toBe(false);
            expect(isLinuxEasyOwnerPushActiveForUin(forged, '123456')).toBe(false);
            expect(isLinuxEasyOwnerPushActive(proxy)).toBe(false);
            expect(isLinuxEasyOwnerPushActiveForUin(proxy, '123456')).toBe(false);
            expect(traps).toBe(0);
            a.close();
            expect(isLinuxEasyOwnerPushActive(a)).toBe(false);
            expect(isLinuxEasyOwnerPushActiveForUin(a, '123456')).toBe(false);
            expect(isLinuxEasyOwnerPushActive(b)).toBe(true);
            expect(isLinuxEasyOwnerPushActiveForUin(b, '234567')).toBe(true);
            b.close();
            expect(isLinuxEasyOwnerPushActive(b)).toBe(false);
            expect(isLinuxEasyOwnerPushActiveForUin(b, '234567')).toBe(false);
        } finally {
            a.close();
            b.close();
            legacy.close();
            f.cleanup();
            g.cleanup();
            legacyFixture.cleanup();
        }
    });

    it('fences clock reentry and deadline expiry without reviving either owner', async () => {
        const f = fixture();
        const g = fixture('234567');
        const closing = createLinuxEasyAccountOwnerWithKeyCapability();
        const expired = createLinuxEasyAccountOwnerWithKeyCapability();
        let now = 1000;
        let reenter = false;
        let didClose = false;
        let crossDeadline = false;
        let samples = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
            if (reenter && !didClose) {
                didClose = true;
                closing.close();
            }

            if (crossDeadline && ++samples === 2) {
                now = 31000;
            }

            return now;
        });

        try {
            expect((await closing.start(f.options)).kind).toBe('registered');
            expect((await expired.start(g.options)).kind).toBe('registered');
            expectRegisteredRaw(f);
            expectRegisteredRaw(g);
            expect(isLinuxEasyOwnerPushActive(closing)).toBe(true);
            expect(isLinuxEasyOwnerPushActive(expired)).toBe(true);
            expect(isLinuxEasyOwnerPushActiveForUin(closing, '123456')).toBe(true);
            expect(isLinuxEasyOwnerPushActiveForUin(expired, '234567')).toBe(true);
            reenter = true;
            expect(isLinuxEasyOwnerPushActiveForUin(closing, '123456')).toBe(false);
            expect(didClose).toBe(true);
            reenter = false;
            crossDeadline = true;
            expect(isLinuxEasyOwnerPushActiveForUin(expired, '234567')).toBe(false);
            expect(samples).toBeGreaterThanOrEqual(2);
            crossDeadline = false;
            now = 1000;
            expect(isLinuxEasyOwnerPushActive(expired)).toBe(false);
            expect(isLinuxEasyOwnerPushActiveForUin(expired, '234567')).toBe(false);
            expect(isLinuxEasyOwnerPushActiveForUin(expired, '234567')).toBe(false);
            expect(isLinuxEasyOwnerPushActive(closing)).toBe(false);
            expect(isLinuxEasyOwnerPushActiveForUin(closing, '123456')).toBe(false);
            expect(isLinuxEasyOwnerPushActiveForUin(closing, '123456')).toBe(false);
        } finally {
            clock.mockRestore();
            closing.close();
            expired.close();
            f.cleanup();
            g.cleanup();
        }
    });
});
