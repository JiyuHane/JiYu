import { EventEmitter } from 'node:events';
import type { DirectThirdPartyLoginResponse } from '@snowluma/proto-defs/direct-login';
import type { SsoHeartbeatResponse, SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { SSO_HEARTBEAT_COMMAND, SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import {
    createWtMultiplexReference,
    type WtMultiplexReferenceOptions,
} from '../../src/direct/wt-multiplex-reference';
import {
    isWtReferencePushProtocol,
    isWtReferencePushCommand,
} from '../../src/direct/wt-reference-push-commands';
import * as privateSession from '../../src/direct/wt-reference-session-private';
import type { RawSessionLease } from '../../src/direct/raw-session-broker';
import type { WtActiveReferenceSession } from '../../src/direct/wt-reference-session';
import { encodeWtTlv } from '../../src/direct/wt-tlv';
import { fetchBody, parseWt, peer, pollBody, replyWt } from './fixtures/wt-sso-synthetic';

// Isolated synthetic transport, real WT/SSO/TEA/Proton implementations; no QQ or Core.
const configPush = 'ConfigPushSvc.PushReq';
const messagePush = 'trpc.msg.olpush.OlPushService.MsgPush';
const notifications = [
    'trpc.msg.register_proxy.RegisterProxy.InfoSyncPush',
    'trpc.msg.register_proxy.RegisterProxy.PushParams',
    configPush,
] as const;
const notificationVariants = [
    { command: notifications[0], protocol: 12 },
    { command: notifications[1], protocol: 12 },
    { command: configPush, protocol: 13 },
    { command: configPush, protocol: 12 },
    { command: messagePush, protocol: 12 },
    { command: messagePush, protocol: 13 },
] as const;
const key = new Uint8Array(16).fill(10);
const payload = Uint8Array.of(8, 1, 16, 2);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

const word = (n: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(n >>> 0);
    return bytes;
};

const field = (value: Uint8Array) => Buffer.concat([word(value.length + 4), value]);

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function response(
    command: string,
    sequence = 71,
    body: Uint8Array = payload,
    options: {
        protocol?: 12 | 13;
        uin?: string;
        encryption?: 'd2' | 'zero' | 'none';
        key?: Uint8Array;
    } = {},
) {
    const inner = Buffer.concat([
        field(
            Buffer.concat([
                word(sequence),
                word(0),
                field(Buffer.alloc(0)),
                field(Buffer.from(command)),
                field(Buffer.alloc(0)),
                word(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(body),
    ]);
    const encryption = options.encryption ?? 'd2';
    const encrypted =
        encryption === 'none'
            ? Buffer.from(inner)
            : qqTeaEncrypt(
                  inner,
                  encryption === 'zero' ? new Uint8Array(16) : (options.key ?? key),
              );
    inner.fill(0);
    const uin = options.uin ?? '123';
    return Buffer.concat([
        word(14 + Buffer.byteLength(uin) + encrypted.length),
        // Inbound protocol-13 frames share this response header, not the request layout.
        // Keep the fixture's expected protocol independent of the production mapping.
        word(options.protocol ?? (command === configPush ? 13 : 12)),
        Buffer.of(encryption === 'd2' ? 1 : encryption === 'zero' ? 2 : 0, 0),
        field(Buffer.from(uin)),
        encrypted,
    ]);
}

function loginBody() {
    const uid = protobuf_encode<DirectThirdPartyLoginResponse>({
        commonInfo: { rspNT: { uid: 'synthetic-uid' } },
    });
    const inner = encodeWtTlv([
        { tag: 0x143, value: Uint8Array.of(9) },
        { tag: 0x305, value: key },
        { tag: 0x10a, value: Uint8Array.of(11) },
        { tag: 0x106, value: Uint8Array.of(12) },
        { tag: 0x543, value: uid },
    ]);
    const body = Buffer.concat([
        Buffer.of(0, 9, 0),
        encodeWtTlv([{ tag: 0x119, value: qqTeaEncrypt(inner, new Uint8Array(16).fill(4)) }]),
    ]);
    inner.fill(0);
    uid.fill(0);
    return body;
}

function inspectRequest(bytes: Uint8Array) {
    const frame = Buffer.from(bytes);
    const start = 10 + frame.readUInt32BE(9);
    const end = start + frame.readUInt32BE(start);
    const plain = Buffer.from(qqTeaDecrypt(frame.subarray(end), key));
    const commandStart = 28 + plain.readUInt32BE(28);
    const command = plain
        .subarray(commandStart + 4, commandStart + plain.readUInt32BE(commandStart))
        .toString();
    const sequence = plain.readUInt32BE(4);
    plain.fill(0);
    return { command, sequence };
}

class Stream extends EventEmitter {
    readable = true;
    writable = true;
    destroyed = false;
    readableFlowing: boolean | null = null;
    writableLength = 0;
    writableNeedDrain = false;
    onWrite: (bytes: Uint8Array) => void = () => {};
    write(bytes: Uint8Array, callback: (error?: Error | null) => void): boolean {
        const copy = Uint8Array.from(bytes);
        queueMicrotask(() => {
            callback();
            this.onWrite(copy);
        });
        return true;
    }
    destroy(): this {
        if (!this.destroyed) {
            this.destroyed = true;
            this.readable = false;
            this.writable = false;
            queueMicrotask(() => this.emit('close'));
        }

        return this;
    }
}

const login = {
    mainSigMap: 1,
    miscBitMap: 2,
    subSigMap: 3,
    packageName: 'p',
    ptVersion: 'v',
    sdkVersion: 's',
    os: 'x',
    deviceName: 'd',
    apkSignature: Uint8Array.of(3),
    tlv124Value: new Uint8Array(12),
};
type BodyMeta = Parameters<NonNullable<WtMultiplexReferenceOptions['onPushBody']>>[1];
type Settings = {
    preRegistration?: string;
    heartbeatPush?: string;
    notificationProtocol?: 12 | 13;
    holdRegister?: boolean;
    rejectRegister?: boolean;
    registerEncryption?: 'd2' | 'zero' | 'none';
    body?: boolean;
    verify?: boolean;
    maxPushFrames?: number;
    maxPushBytes?: number;
    maxBody?: number;
    bodyHook?: NonNullable<WtMultiplexReferenceOptions['onPushBody']>;
};

function setup(settings: Settings = {}) {
    const stream = new Stream();
    const registerEntered = deferred();
    const allowRegister = deferred();
    const failures: unknown[] = [];
    const verified: Uint8Array[] = [];
    const raw: Array<{ frame: Uint8Array; meta: Omit<BodyMeta, 'retCode'> }> = [];
    const bodies: Array<{ body: Uint8Array; borrowed: Uint8Array; meta: BodyMeta }> = [];
    const requests: string[] = [];
    stream.on('error', (error) => failures.push(error));
    const baseline = new Map(
        ['data', 'error', 'end', 'close', 'pause'].map((name) => [name, stream.listeners(name)]),
    );
    const owner = createWtMultiplexReference(stream, {
        exclusiveConnected: true,
        transportUin: '0',
        initialSequence: 50,
        maxFrameBytes: 65536,
        maxBufferedBytes: 262144,
        maxFrames: 16,
        maxPushFrames: settings.maxPushFrames ?? 8,
        maxPushBytes: settings.maxPushBytes ?? 262144,
        maxWriteBufferBytes: 262144,
        leaseTimeoutMs: 10000,
        session: {
            profile: {
                uin: '999',
                appId: 42,
                subAppId: 43,
                clientVersion: 44,
                guid: Uint8Array.of(1, 2),
                unknown21: new Uint8Array(21),
                randomKey: new Uint8Array(16).fill(7),
                peerPublicKey: peer.publicKey,
                ssoVersion: 'header-v',
                qrCommand: 'fixture.qr',
                loginCommand: 'fixture.login',
            },
            timeoutMs: 1500,
            attemptTimeoutMs: 7000,
            getTimestamp: () => 10,
            buildWtReserved: async () => new Uint8Array(),
            verifyRaw: () => true,
            verifyContext: ({ requestUin, responseUin }) => responseUin === requestUin,
            sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
            registration: {
                version: 'v',
                deviceName: 'n',
                deviceType: 't',
                vendorOs: 'os',
                random: 4,
            },
            buildRegisterReserved: () => new Uint8Array(),
            verifyRegisterRaw: async ({ command }) => {
                if (command === SSO_INFO_SYNC_COMMAND && settings.holdRegister) {
                    registerEntered.resolve();
                    await allowRegister.promise;
                }

                return !settings.rejectRegister;
            },
        },
        verifyPushRaw: (frame) => {
            verified.push(frame);
            return settings.verify !== false;
        },
        onPush: (frame, meta) => {
            raw.push({ frame, meta });
        },
        ...(settings.body === false
            ? {}
            : {
                  maxPushBodyBytes: settings.maxBody ?? 65536,
                  onPushBody: async (body: Uint8Array, meta: BodyMeta) => {
                      bodies.push({ body: body.slice(), borrowed: body, meta });
                      await settings.bodyHook?.(body, meta);
                  },
              }),
    });

    stream.onWrite = (bytes) => {
        try {
            if (requests.length < 3) {
                const request = parseWt(bytes);
                requests.push(request.command);
                const body =
                    request.kind === 0x31
                        ? fetchBody()
                        : request.kind === 0x12
                          ? pollBody(0)
                          : loginBody();
                const reply = replyWt(request, body);
                body.fill(0);
                request.shared.fill(0);
                request.business.fill(0);
                stream.emit(
                    'data',
                    requests.length === 3 && settings.preRegistration
                        ? Buffer.concat([
                              reply,
                              response(settings.preRegistration, request.seq, payload, {
                                  protocol: settings.notificationProtocol,
                              }),
                          ])
                        : reply,
                );
            } else {
                const request = inspectRequest(bytes);
                requests.push(request.command);
                const body =
                    request.command === SSO_INFO_SYNC_COMMAND
                        ? protobuf_encode<SsoRegisterResponse>({
                              register: { message: 'register success' },
                          })
                        : protobuf_encode<SsoHeartbeatResponse>({ interval: 270n });
                const reply = response(request.command, request.sequence, body, {
                    encryption:
                        request.command === SSO_INFO_SYNC_COMMAND
                            ? settings.registerEncryption
                            : undefined,
                });
                body.fill(0);
                stream.emit(
                    'data',
                    request.command === SSO_HEARTBEAT_COMMAND && settings.heartbeatPush
                        ? Buffer.concat([
                              response(settings.heartbeatPush, request.sequence, payload, {
                                  protocol: settings.notificationProtocol,
                              }),
                              reply,
                          ])
                        : reply,
                );
            }
        } catch (error) {
            failures.push(error);
            stream.emit('error', error);
        } finally {
            bytes.fill(0);
        }
    };

    return {
        owner,
        stream,
        requests,
        failures,
        verified,
        raw,
        bodies,
        registerEntered,
        allowRegister,
        async confirm() {
            await owner.fetch({
                packageName: 'p',
                ptVersion: 'v',
                miscBitMap: 1,
                ssoVersion: 1,
                d1: Uint8Array.of(1),
            });
            expect(await owner.poll()).toEqual({ status: 'confirmed' });
        },
        async online() {
            await this.confirm();
            expect(await owner.loginAndRegister(login)).toEqual({ status: 'success' });
        },
        async cleanup() {
            allowRegister.resolve();
            owner.close();
            stream.destroy();
            await owner.whenClosed;
            await turn();

            for (const [name, listeners] of baseline) {
                expect(stream.listeners(name)).toEqual(listeners);
            }
        },
    };
}

async function expectClosed(fixture: ReturnType<typeof setup>) {
    await vi.waitFor(() => expect(fixture.stream.destroyed).toBe(true));
    await fixture.owner.whenClosed;
    expect(fixture.owner.getState()).toBe('closed');
}

function expectWiped(values: Uint8Array[]) {
    expect(values.every((value) => value.every((byte) => byte === 0))).toBe(true);
}

describe('Linux registration response envelope', () => {
    it('accepts the associated SsoInfoSync response under the fixed zero key', async () => {
        const f = setup({ registerEncryption: 'zero' });

        try {
            await f.online();
            expect(f.requests.at(-1)).toBe(SSO_INFO_SYNC_COMMAND);
            expect(f.owner.getState()).toBe('success');
            expect(f.failures).toEqual([]);
        } finally {
            await f.cleanup();
        }
    });

    it('still rejects an unencrypted SsoInfoSync response', async () => {
        const f = setup({ registerEncryption: 'none' });

        try {
            await f.confirm();
            const status = await f.owner.loginAndRegister(login).then(
                (result) => result.status,
                () => 'thrown',
            );
            expect(status).not.toBe('success');
            await expectClosed(f);
        } finally {
            await f.cleanup();
        }
    });
});

describe('fixed reference registration notification commands', () => {
    it('maps exactly the four fixed names to their individual protocols', () => {
        for (const command of [messagePush, ...notifications]) {
            expect(isWtReferencePushCommand(command)).toBe(true);
            expect(isWtReferencePushProtocol(command, 12)).toBe(true);
            expect(isWtReferencePushProtocol(command, 13)).toBe(
                command === configPush || command === messagePush,
            );

            for (const protocol of [0, 11, 14, 20, NaN, Infinity]) {
                expect(isWtReferencePushProtocol(command, protocol)).toBe(false);
            }

            for (const unknown of [
                '',
                command + '.Other',
                command + '\0',
                command.toLowerCase(),
                command.slice(0, -1),
            ]) {
                expect(isWtReferencePushCommand(unknown)).toBe(false);
                expect(isWtReferencePushProtocol(unknown, 12)).toBe(false);
                expect(isWtReferencePushProtocol(unknown, 13)).toBe(false);
            }
        }

        expect(isWtReferencePushCommand(SSO_INFO_SYNC_COMMAND)).toBe(false);
    });

    it.each([
        { command: configPush, protocol: 12 },
        { command: configPush, protocol: 13 },
        { command: messagePush, protocol: 12 },
        { command: messagePush, protocol: 13 },
    ] as const)(
        'forwards opaque $command protocol $protocol bytes without an unsolicited reply',
        async ({ command, protocol }) => {
            const f = setup();
            const opaque = Uint8Array.of(0xff, 0x00, 0x81, 0x7f, 0x42);
            const frame = response(command, 0x80000047, opaque, { protocol });
            const original = Buffer.from(frame);

            try {
                await f.online();
                expect(frame.readUInt32BE(0)).toBe(frame.length);
                expect(frame.readUInt32BE(4)).toBe(protocol);
                expect(frame[8]).toBe(1);
                expect(frame[9]).toBe(0);
                expect(frame.readUInt32BE(10)).toBe(7);
                expect(frame.subarray(14, 17).toString()).toBe('123');
                f.stream.emit('data', frame);
                await vi.waitFor(() => expect(f.bodies).toHaveLength(1));
                await turn();
                expect(f.bodies[0].body).toEqual(opaque);
                expect(f.bodies[0].meta).toEqual({
                    uin: '123',
                    command,
                    sequence: 0x80000047,
                    retCode: 0,
                });
                expectWiped([...f.verified, f.raw[0].frame, f.bodies[0].borrowed]);
                expect(frame).toEqual(original);
                expect(f.requests).toHaveLength(4);
                expect(f.failures).toEqual([]);
                expect(f.owner.getState()).toBe('success');
            } finally {
                await f.cleanup();
            }
        },
    );

    it.each([
        [notifications[0], 13],
        [notifications[1], 13],
        ['ConfigPushSvc.PushResp', 12],
        ['ConfigPushSvc.PushResp', 13],
        ['synthetic.unknown', 13],
    ] as const)('rejects %s in the unlisted protocol %s', async (command, protocol) => {
        const f = setup();

        try {
            await f.online();
            f.stream.emit('data', response(command, 71, payload, { protocol }));
            await expectClosed(f);
            expect(f.verified).toEqual([]);
            expect(f.raw).toEqual([]);
            expect(f.bodies).toEqual([]);
        } finally {
            await f.cleanup();
        }
    });

    it.each([
        [messagePush, 12, undefined],
        [messagePush, 13, undefined],
        [notifications[0], 12, 13],
        [notifications[1], 12, 13],
        [configPush, 12, undefined],
        [configPush, 13, undefined],
    ] as const)(
        'rechecks the exact %s protocol inside the private body decoder',
        (command, protocol, other) => {
            const token = privateSession.createReferenceKeyCapability();
            const attempt = {};
            const reservation = privateSession.reserveReferenceKeyCapability(token);
            privateSession.bindReferenceKeyAttempt(token, attempt, reservation);
            privateSession.stageReferenceConfirmed(token, attempt, '0', '123', 51);
            privateSession.stageReferenceKey(token, attempt, '0', '123', 52, key);
            privateSession.commitReferenceKey(token);
            const expected = { uin: '123', command, sequence: 71 };

            try {
                const accepted = privateSession.decodeReferencePushBody(
                    token,
                    response(command, 71, payload, { protocol }),
                    '0',
                    expected,
                    32,
                );
                expect(accepted.body).toEqual(payload);
                accepted.body.fill(0);
                const invalid = response(command, 71, payload, { protocol: other ?? protocol });

                if (other === undefined) {
                    invalid.writeUInt32BE(14, 4);
                }

                expect(() =>
                    privateSession.decodeReferencePushBody(token, invalid, '0', expected, 32),
                ).toThrow();
            } finally {
                privateSession.revokeReferenceKey(token);
            }
        },
    );

    it('rotates only an exact active refresh binding and preserves the active phase', () => {
        const token = privateSession.createReferenceKeyCapability();
        const reservation = privateSession.reserveReferenceKeyCapability(token);
        const lease = {} as RawSessionLease;
        const foreignLease = {} as RawSessionLease;
        const origin = privateSession.bindReferenceRestoredOwnerLease(
            token,
            reservation,
            lease,
            '123',
        );
        const owner = {
            getState: () => 'success' as const,
            heartbeat: async () => ({ status: 'success' as const, interval: 1n }),
            alive: async () => ({ status: 'success' as const }),
            refreshTickets: async () => ({ status: 'empty-a1' as const }),
            close: vi.fn(),
        } satisfies WtActiveReferenceSession;
        privateSession.publishReferenceSessionSend(
            token,
            reservation,
            origin,
            lease,
            owner,
            vi.fn() as never,
        );
        privateSession.stageReferenceRestoredKey(token, origin, lease, owner, key);
        privateSession.commitReferenceKey(token);
        expect(privateSession.takeReferenceSessionSend(token, owner, lease)).toBeTypeOf('function');
        const run = {};
        const replacement = new Uint8Array(16).fill(29);
        const child = {};
        const release = vi.fn();
        privateSession.beginReferenceTicketRefresh(token, owner, lease, origin, run);
        privateSession.beginReferenceSend(token, origin, lease, child);
        privateSession.armReferenceTicketRefreshContinuation(token, owner, lease, release);
        privateSession.endReferenceSend(token, origin, lease, child);
        privateSession.stageReferenceTicketRefreshCandidate(
            token,
            owner,
            lease,
            origin,
            run,
            key,
            replacement,
        );

        try {
            expect(() =>
                privateSession.rotateReferenceTicketKey(
                    token,
                    owner,
                    foreignLease,
                    origin,
                    run,
                    key,
                    replacement,
                ),
            ).toThrow('invalid reference session binding');
            expect(() =>
                privateSession.rotateReferenceTicketKey(
                    token,
                    owner,
                    lease,
                    origin,
                    run,
                    new Uint8Array(16).fill(7),
                    replacement,
                ),
            ).toThrow('invalid reference ticket key rotation');
            expect(privateSession.referenceKeyState(token)).toBe('active');
            expect(release).toHaveBeenCalledOnce();
            const before = privateSession.decodeReferencePushBody(
                token,
                response(messagePush, 71, payload),
                '123',
                { uin: '123', command: messagePush, sequence: 71 },
                32,
            );
            before.body.fill(0);
            const candidateBeforeCommit = privateSession.decodeReferencePushBody(
                token,
                response(messagePush, 72, payload, { key: replacement }),
                '123',
                { uin: '123', command: messagePush, sequence: 72 },
                32,
            );
            expect(candidateBeforeCommit.body).toEqual(payload);
            candidateBeforeCommit.body.fill(0);
            privateSession.rotateReferenceTicketKey(
                token,
                owner,
                lease,
                origin,
                run,
                key,
                replacement,
            );
            expect(privateSession.referenceKeyState(token)).toBe('active');
            expect(() =>
                privateSession.decodeReferencePushBody(
                    token,
                    response(messagePush, 72, payload),
                    '123',
                    { uin: '123', command: messagePush, sequence: 72 },
                    32,
                ),
            ).toThrow();
            const after = privateSession.decodeReferencePushBody(
                token,
                response(messagePush, 73, payload, { key: replacement }),
                '123',
                { uin: '123', command: messagePush, sequence: 73 },
                32,
            );
            expect(after.body).toEqual(payload);
            after.body.fill(0);
        } finally {
            privateSession.endReferenceTicketRefresh(token, owner, lease, origin, run);
            privateSession.revokeReferenceKey(token);
        }
    });

    it.each(notificationVariants)(
        'queues $command protocol $protocol after key staging and delivers only after registration',
        async ({ command, protocol }) => {
            const f = setup({
                preRegistration: command,
                notificationProtocol: protocol,
                holdRegister: true,
            });

            try {
                await f.confirm();
                const pending = f.owner.loginAndRegister(login);
                await Promise.race([
                    f.registerEntered.promise,
                    pending.then(() => {
                        throw new Error('registration finished before the verifier gate');
                    }),
                ]);
                expect(f.verified).toEqual([]);
                expect(f.raw).toEqual([]);
                expect(f.bodies).toEqual([]);
                f.allowRegister.resolve();
                expect(await pending).toEqual({ status: 'success' });
                await vi.waitFor(() => expect(f.bodies).toHaveLength(1));
                await turn();
                expect(f.bodies[0].body).toEqual(payload);
                expect(f.bodies[0].meta).toEqual({ uin: '123', command, sequence: 52, retCode: 0 });
                expect(Object.isFrozen(f.bodies[0].meta)).toBe(true);
                expect(f.raw[0].meta).toEqual({ uin: '123', command, sequence: 52 });
                expectWiped([
                    ...f.verified,
                    ...f.raw.map((entry) => entry.frame),
                    f.bodies[0].borrowed,
                ]);
                expect(f.requests).toHaveLength(4);
                expect(f.failures).toEqual([]);
            } finally {
                await f.cleanup();
            }
        },
    );

    it.each(notificationVariants)(
        'routes $command protocol $protocol separately from a heartbeat response with the same sequence',
        async ({ command, protocol }) => {
            const f = setup({ heartbeatPush: command, notificationProtocol: protocol });

            try {
                await f.online();
                expect((await f.owner.heartbeat()).status).toBe('success');
                await vi.waitFor(() => expect(f.bodies).toHaveLength(1));
                expect(f.bodies[0].meta.command).toBe(command);
                expect(f.bodies[0].body).toEqual(payload);
                expect(f.requests.at(-1)).toBe(SSO_HEARTBEAT_COMMAND);
                expect(f.requests).toHaveLength(5);
                expect(f.owner.getState()).toBe('success');
                expect(f.failures).toEqual([]);
            } finally {
                await f.cleanup();
            }
        },
    );

    it.each(notificationVariants)(
        'keeps $command protocol $protocol raw-only when body delivery is absent',
        async ({ command, protocol }) => {
            const f = setup({ body: false });
            const decoder = vi.spyOn(privateSession, 'decodeReferencePushBody');

            try {
                await f.online();
                f.stream.emit('data', response(command, 71, payload, { protocol }));
                await vi.waitFor(() => expect(f.raw).toHaveLength(1));
                expect(f.raw[0].meta.command).toBe(command);
                expect(f.bodies).toEqual([]);
                expect(decoder).not.toHaveBeenCalled();
            } finally {
                decoder.mockRestore();
                await f.cleanup();
            }
        },
    );

    it.each(notificationVariants)(
        'rejects $command protocol $protocol before any session key exists',
        async ({ command, protocol }) => {
            const f = setup();

            try {
                f.stream.emit('data', response(command, 71, payload, { protocol }));
                await expectClosed(f);
                expect(f.verified).toEqual([]);
                expect(f.bodies).toEqual([]);
            } finally {
                await f.cleanup();
            }
        },
    );

    for (const { command, protocol } of notificationVariants) {
        it.each([
            ['wrong account', { uin: '456' }],
            ['zero encryption', { encryption: 'zero' as const }],
            ['no encryption', { encryption: 'none' as const }],
            ['wrong D2 key', { key: new Uint8Array(16).fill(99) }],
        ] as const)(`rejects ${command} protocol ${protocol} with %s`, async (_, options) => {
            const f = setup();

            try {
                await f.online();
                f.stream.emit('data', response(command, 71, payload, { ...options, protocol }));
                await expectClosed(f);
                expect(f.verified).toEqual([]);
                expect(f.raw).toEqual([]);
                expect(f.bodies).toEqual([]);
            } finally {
                await f.cleanup();
            }
        });
    }

    it.each([notifications[0] + '.Other', notifications[1] + '\0', 'synthetic.unknown'])(
        'still rejects unknown command %s',
        async (command) => {
            const f = setup();

            try {
                await f.online();
                f.stream.emit('data', response(command));
                await expectClosed(f);
                expect(f.verified).toEqual([]);
                expect(f.raw).toEqual([]);
                expect(f.bodies).toEqual([]);
            } finally {
                await f.cleanup();
            }
        },
    );

    it.each(notificationVariants)(
        'keeps independent raw verification mandatory for $command protocol $protocol',
        async ({ command, protocol }) => {
            const f = setup({ verify: false });

            try {
                await f.online();
                f.stream.emit('data', response(command, 71, payload, { protocol }));
                await expectClosed(f);
                expect(f.verified).toHaveLength(1);
                expectWiped(f.verified);
                expect(f.raw).toEqual([]);
                expect(f.bodies).toEqual([]);
            } finally {
                await f.cleanup();
            }
        },
    );

    it.each(notificationVariants)(
        'applies the same body limit to $command protocol $protocol',
        async ({ command, protocol }) => {
            const f = setup({ maxBody: payload.length - 1 });

            try {
                await f.online();
                f.stream.emit('data', response(command, 71, payload, { protocol }));
                await expectClosed(f);
                expectWiped(f.verified);
                expect(f.raw).toEqual([]);
                expect(f.bodies).toEqual([]);
            } finally {
                await f.cleanup();
            }
        },
    );

    it.each(notificationVariants)(
        'drops queued $command protocol $protocol if registration verification fails',
        async ({ command, protocol }) => {
            const f = setup({
                preRegistration: command,
                notificationProtocol: protocol,
                rejectRegister: true,
            });

            try {
                await f.confirm();
                const status = await f.owner.loginAndRegister(login).then(
                    (result) => result.status,
                    () => 'thrown',
                );
                expect(status).not.toBe('success');
                await expectClosed(f);
                expect(f.verified).toEqual([]);
                expect(f.raw).toEqual([]);
                expect(f.bodies).toEqual([]);
            } finally {
                await f.cleanup();
            }
        },
    );

    it.each([
        ['frames', notifications[0], 12],
        ['bytes', notifications[0], 12],
        ['frames', configPush, 13],
        ['bytes', configPush, 13],
        ['frames', messagePush, 13],
        ['bytes', messagePush, 13],
    ] as const)(
        'keeps the shared %s queue limit and wipes active %s protocol %s bodies on closure',
        async (limit, firstCommand, protocol) => {
            const gate = deferred();
            const first = response(firstCommand, 71, payload, { protocol });
            const second = response(notifications[1], 72);
            const f = setup({
                maxPushFrames: limit === 'frames' ? 1 : 8,
                maxPushBytes: limit === 'bytes' ? first.length + second.length - 1 : 262144,
                bodyHook: () => gate.promise,
            });

            try {
                await f.online();
                f.stream.emit('data', first);
                await vi.waitFor(() => expect(f.bodies).toHaveLength(1));
                expect(f.bodies[0].borrowed).toEqual(payload);
                f.stream.emit('data', second);
                await expectClosed(f);
                expect(f.bodies).toHaveLength(1);
                expectWiped([
                    ...f.verified,
                    ...f.raw.map((entry) => entry.frame),
                    f.bodies[0].borrowed,
                ]);
                expect(f.bodies[0].body).toEqual(payload);
            } finally {
                gate.resolve();
                await f.cleanup();
            }
        },
    );
});
