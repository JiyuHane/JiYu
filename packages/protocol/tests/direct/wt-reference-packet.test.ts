/// <reference lib="es2024.arraybuffer" />
import { EventEmitter, once } from 'node:events';
import { createConnection, createServer, type Socket, type Server } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { DirectThirdPartyLoginResponse } from '@snowluma/proto-defs/direct-login';
import type { SsoRegisterResponse, SsoHeartbeatResponse } from '@snowluma/proto-defs/sso-register';
import type { OidbBase, OidbSvcTrpcTcp0xFD4_1Response } from '@snowluma/proto-defs/oidb';
import { FetchFriendListPage } from '../../src/oidb-services/contacts/fetch-friend-list-page';
import { OidbError } from '../../src/oidb-service';
import {
    createWtMultiplexReference,
    createWtRestoredMultiplexReference,
    type WtMultiplexReferenceOptions,
} from '../../src/direct/wt-multiplex-reference';
import {
    isWtReferencePacketCommand,
    prepareReferencePacketInput,
    disposePreparedReferencePacket,
    disposeReferencePacketResult,
    WtReferencePacketError,
    type WtReferencePacketCommand,
    type WtReferencePacketInput,
    type WtReferencePacketResult,
} from '../../src/direct/wt-reference-packet-flow';
import * as packetFlow from '../../src/direct/wt-reference-packet-flow';
import * as privateSession from '../../src/direct/wt-reference-session-private';
import { disposeWtPersistedSession } from '../../src/direct/wt-persisted-session';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { decodeServiceResponse } from '../../src/direct/service-frame';
import { ServiceFrameDecoder } from '../../src/direct/service-stream';
import {
    SSO_INFO_SYNC_COMMAND as REGISTER,
    SSO_HEARTBEAT_COMMAND as HEARTBEAT,
} from '../../src/direct/sso-register';
import { encodeWtTlv } from '../../src/direct/wt-tlv';
import { fetchBody, parseWt, peer, pollBody, replyWt } from './fixtures/wt-sso-synthetic';
import {
    response,
    deadline,
    deferred,
    turn,
    loginFields,
    COMMAND as PUSH,
} from './fixtures/wt-multiplex-pipeline-synthetic';

// All credentials, replies and accounts are synthetic. The only real socket is loopback.
const commands = [
    'MessageSvc.PbSendMsg',
    'OidbSvcTrpcTcp.0xfd4_1',
    'OidbSvcTrpcTcp.0xfe1_2',
    'OidbSvcTrpcTcp.0xfe5_2',
    'OidbSvcTrpcTcp.0xfe7_3',
    'OidbSvcTrpcTcp.0x9067_202',
] as const satisfies readonly WtReferencePacketCommand[];
const packetInput = (command: WtReferencePacketCommand = commands[1]): WtReferencePacketInput => ({
    command,
    body: Uint8Array.of(8, 1, 18, 1, 42),
    timeoutMs: 1500,
    maxResponseBodyBytes: 65536,
});
const key = new Uint8Array(16).fill(10);
const defaultBody = Uint8Array.of(8, 2, 18, 2, 65, 66);
type Mode = 'qr' | 'restored';
type SignInput = Parameters<WtMultiplexReferenceOptions['session']['buildRegisterReserved']>[0];
type VerifyInput = Parameters<WtMultiplexReferenceOptions['session']['verifyRegisterRaw']>[0];
type Settings = {
    mode?: Mode;
    loopback?: boolean;
    account?: string;
    byte?: number;
    sign?: (input: SignInput) => Uint8Array | Promise<Uint8Array>;
    verify?: (input: VerifyInput) => boolean | Promise<boolean>;
    reply?: (request: ReturnType<typeof inspectWire>) => Uint8Array | undefined;
    body?: Uint8Array;
    retCode?: number;
};

function inspectWire(frame: Uint8Array, d2Key: Uint8Array) {
    const wire = Buffer.from(frame);
    const accountStart = 10 + wire.readUInt32BE(9);
    const accountEnd = accountStart + wire.readUInt32BE(accountStart);
    const inner = Buffer.from(qqTeaDecrypt(wire.subarray(accountEnd), d2Key));
    const commandStart = 28 + inner.readUInt32BE(28);
    const result = {
        command: inner
            .subarray(commandStart + 4, commandStart + inner.readUInt32BE(commandStart))
            .toString(),
        sequence: inner.readUInt32BE(4),
        uin: wire.subarray(accountStart + 4, accountEnd).toString(),
        body: Uint8Array.from(inner.subarray(inner.readUInt32BE(0) + 4)),
    };
    inner.fill(0);
    return result;
}

function loginBody() {
    const uid = protobuf_encode<DirectThirdPartyLoginResponse>({
        commonInfo: { rspNT: { uid: 'synthetic-123' } },
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

class MemoryStream extends EventEmitter {
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

async function setup(settings: Settings = {}) {
    const mode = settings.mode ?? 'restored';
    const account = settings.account ?? '123';
    const d2Key = new Uint8Array(16).fill(settings.byte ?? 10);
    const persisted = {
        version: 1 as const,
        uin: account,
        uid: `synthetic-${account}`,
        guid: new Uint8Array(16).fill(3),
        tickets: { d2: Uint8Array.of(9), d2Key, a1: Uint8Array.of(12), a2: Uint8Array.of(11) },
    };
    const controller = new AbortController();
    const requests: ReturnType<typeof inspectWire>[] = [];
    const signed: SignInput[] = [];
    const verified: VerifyInput[] = [];
    const pushed: number[] = [];
    const failures: unknown[] = [];
    const peers: Socket[] = [];
    let server: Server | undefined;
    let qrCalls = 0;

    const reply = (bytes: Uint8Array): Uint8Array | undefined => {
        if (mode === 'qr' && qrCalls++ < 3) {
            const request = parseWt(bytes);
            const body =
                request.kind === 0x31
                    ? fetchBody()
                    : request.kind === 0x12
                      ? pollBody(0)
                      : loginBody();
            const result = replyWt(request, body);
            body.fill(0);
            request.shared.fill(0);
            request.business.fill(0);
            return result;
        }

        const request = inspectWire(bytes, d2Key);
        requests.push(request);

        if (request.command === REGISTER) {
            return response(
                request.sequence,
                REGISTER,
                protobuf_encode<SsoRegisterResponse>({ register: { message: 'register success' } }),
                account,
                d2Key,
            );
        }

        if (request.command === HEARTBEAT) {
            return response(
                request.sequence,
                HEARTBEAT,
                protobuf_encode<SsoHeartbeatResponse>({ interval: 37n }),
                account,
                d2Key,
            );
        }

        return settings.reply
            ? settings.reply(request)
            : response(
                  request.sequence,
                  request.command,
                  settings.body ?? defaultBody,
                  account,
                  d2Key,
                  settings.retCode,
              );
    };

    const handle = (bytes: Uint8Array, emit: (frame: Uint8Array) => void, fail: () => void) => {
        try {
            const candidate = reply(bytes);

            if (candidate) {
                emit(candidate);
            }
        } catch (error) {
            failures.push(error);
            fail();
        } finally {
            bytes.fill(0);
        }
    };

    let stream: Socket | MemoryStream;

    if (settings.loopback) {
        server = createServer((socket) => {
            peers.push(socket);
            socket.on('error', (error) => failures.push(error));
            const decoder = new ServiceFrameDecoder();
            socket.on('data', (bytes) => {
                for (const frame of decoder.push(bytes)) {
                    handle(
                        frame,
                        (candidate) => socket.write(candidate, () => candidate.fill(0)),
                        () => socket.destroy(),
                    );
                }
            });
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();

        if (!address || typeof address === 'string') {
            throw new Error('missing loopback address');
        }

        const socket = createConnection({ host: '127.0.0.1', port: address.port });
        await once(socket, 'connect');
        stream = socket;
    } else {
        const memory = new MemoryStream();
        memory.onWrite = (bytes) =>
            handle(
                bytes,
                (candidate) => {
                    memory.emit('data', candidate);
                    candidate.fill(0);
                },
                () => memory.destroy(),
            );
        stream = memory;
    }

    stream.on('error', (error) => failures.push(error));
    const shared = {
        registration: {
            version: 'v',
            deviceName: 'name',
            deviceType: 'type',
            vendorOs: 'os',
            random: 4,
        },
        timeoutMs: 3000,
        signal: controller.signal,
        buildRegisterReserved: (input: SignInput) => {
            if (isWtReferencePacketCommand(input.command)) {
                signed.push(input);
                return settings.sign?.(input) ?? Uint8Array.of(8);
            }

            return Uint8Array.of(8);
        },
        verifyRegisterRaw: (input: VerifyInput) => {
            if (isWtReferencePacketCommand(input.command)) {
                verified.push(input);
                return settings.verify?.(input) ?? true;
            }

            return true;
        },
    };
    const common = {
        exclusiveConnected: true as const,
        transportUin: account,
        initialSequence: 0x80000010,
        maxFrameBytes: 3 * 1024 * 1024,
        maxBufferedBytes: 8 * 1024 * 1024,
        maxFrames: 16,
        maxPushFrames: 8,
        maxPushBytes: 65536,
        maxWriteBufferBytes: 1024 * 1024,
        leaseTimeoutMs: 15000,
        verifyPushRaw: () => true,
        onPush: (_frame: Uint8Array, meta: { sequence: number }) => {
            pushed.push(meta.sequence);
        },
    };
    const qrOptions: WtMultiplexReferenceOptions = {
        ...common,
        transportUin: '0',
        session: {
            ...shared,
            profile: {
                uin: '999',
                appId: 42,
                subAppId: 43,
                clientVersion: 44,
                guid: persisted.guid,
                unknown21: new Uint8Array(21),
                randomKey: new Uint8Array(16).fill(7),
                peerPublicKey: peer.publicKey,
                ssoVersion: 'header-v',
                qrCommand: 'fixture.qr',
                loginCommand: 'fixture.login',
            },
            attemptTimeoutMs: 7000,
            getTimestamp: () => 10,
            buildWtReserved: async () => new Uint8Array(),
            verifyRaw: () => true,
            verifyContext: ({ requestUin, responseUin }) => requestUin === responseUin,
            sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
        },
    };
    const session =
        mode === 'qr'
            ? createWtMultiplexReference(stream, qrOptions)
            : createWtRestoredMultiplexReference(stream, {
                  ...common,
                  session: {
                      ...shared,
                      persisted,
                      profile: { subAppId: 43, version: 'header-v' },
                      restoreTimeoutMs: 7000,
                  },
              });
    return {
        session,
        stream,
        settings,
        signed,
        verified,
        requests,
        pushed,
        failures,
        controller,
        async online() {
            if ('restoreAndRegister' in session) {
                expect(await deadline(session.restoreAndRegister(), 'restore')).toEqual({
                    status: 'success',
                });
            } else {
                await session.fetch({
                    packageName: 'p',
                    ptVersion: 'v',
                    miscBitMap: 1,
                    ssoVersion: 1,
                    d1: Uint8Array.of(1),
                });
                expect(await session.poll()).toEqual({ status: 'confirmed' });
                expect(await session.loginAndRegister(loginFields)).toEqual({ status: 'success' });
            }
        },
        async close() {
            session.close();
            stream.destroy();
            peers.forEach((socket) => socket.destroy());
            await session.whenClosed;

            if (server) {
                await new Promise<void>((resolve) => server!.close(() => resolve()));
            }

            requests.forEach((request) => request.body.fill(0));
            disposeWtPersistedSession(persisted);
        },
    };
}

const wiped = (value: Uint8Array) => value.every((byte) => byte === 0);

describe('fixed packet admission and ownership', () => {
    it('accepts exactly six names and snapshots Buffer subviews without retaining callers', () => {
        for (const command of commands) {
            expect(isWtReferencePacketCommand(command)).toBe(true);

            for (const other of [
                command + '.Other',
                command + '\0',
                command.toLowerCase(),
                command.slice(0, -1),
            ]) {
                expect(isWtReferencePacketCommand(other)).toBe(false);
            }
        }

        const source = Buffer.from([9, 1, 2, 8]);
        const input = { ...packetInput(), body: source.subarray(1, 3) };
        const prepared = prepareReferencePacketInput(input);
        source.fill(0);
        expect(prepared.body).toEqual(Uint8Array.of(1, 2));
        expect(Object.isFrozen(prepared)).toBe(true);
        disposePreparedReferencePacket(prepared);
        expect(wiped(prepared.body)).toBe(true);
    });
    it.each([
        undefined,
        null,
        {},
        [],
        { ...packetInput(), command: 'OidbSvcTrpcTcp.0x907_2' },
        { ...packetInput(), command: 'OidbSvcTrpcTcp.0xfe7_3\0' },
        { ...packetInput(), timeoutMs: 0 },
        { ...packetInput(), timeoutMs: 0.5 },
        { ...packetInput(), maxResponseBodyBytes: 2097153 },
        { ...packetInput(), maxResponseBodyBytes: -1 },
        { ...packetInput(), maxResponseBodyBytes: NaN },
        { ...packetInput(), extra: 1 },
        { ...packetInput(), body: new Uint8Array(65537) },
        { ...packetInput(), body: new Uint8Array(new SharedArrayBuffer(8)) },
        { ...packetInput(), body: new Uint8Array(new ArrayBuffer(8, { maxByteLength: 16 })) },
    ])('rejects malformed input %# before any operation', (input) => {
        expect(() => prepareReferencePacketInput(input)).toThrow();
    });
    it('does not invoke accessors, Proxy traps, or detached storage', () => {
        const touched = vi.fn(() => {
            throw new Error('foreign access');
        });
        const accessor = Object.defineProperty(packetInput(), 'body', { get: touched });
        expect(() => prepareReferencePacketInput(accessor)).toThrow();
        expect(() =>
            prepareReferencePacketInput(
                new Proxy(packetInput(), { get: touched, ownKeys: touched }),
            ),
        ).toThrow();
        const body = new Uint8Array(8);
        structuredClone(body.buffer, { transfer: [body.buffer] });
        expect(() => prepareReferencePacketInput({ ...packetInput(), body })).toThrow();
        expect(touched).not.toHaveBeenCalled();
    });
});

for (const mode of ['qr', 'restored'] as const) {
    describe(`${mode} fixed packet owner`, () => {
        it.each(commands)('uses the same owner and actual SSO12/D2 for %s', async (command) => {
            const f = await setup({ mode });
            let result: WtReferencePacketResult | undefined;

            try {
                await f.online();
                const source = packetInput(command);
                result = await f.session.requestPacket(source);
                expect(result).toEqual({
                    status: 'response',
                    command,
                    sequence: f.requests.at(-1)!.sequence,
                    retCode: 0,
                    body: defaultBody,
                    writeState: 'written',
                });
                expect(f.requests.at(-1)).toMatchObject({ command, uin: '123', body: source.body });
                expect(f.signed).toHaveLength(1);
                expect(f.verified).toHaveLength(1);
                expect(wiped(f.signed[0].body)).toBe(true);
                expect(wiped(f.verified[0].requestFrame)).toBe(true);
                expect(wiped(f.verified[0].responseFrame)).toBe(true);
                expect(f.session.getState()).toBe('success');
                expect((await f.session.heartbeat()).status).toBe('success');
                expect(f.failures).toEqual([]);
            } finally {
                await f.close();
            }

            expect(result!.body).toEqual(defaultBody);
            disposeReferencePacketResult(result);
            expect(wiped(result!.body)).toBe(true);
        });
        it('rejects unknown/pre-registration calls without consuming or closing the owner', async () => {
            const f = await setup({ mode });

            try {
                await expect(f.session.requestPacket(packetInput())).rejects.toThrow();
                expect(f.requests).toEqual([]);
                await f.online();
                await expect(
                    f.session.requestPacket({
                        ...packetInput(),
                        command: REGISTER as WtReferencePacketCommand,
                    }),
                ).rejects.toThrow();
                expect(f.signed).toEqual([]);
                expect(f.session.getState()).toBe('success');
                const result = await f.session.requestPacket(packetInput());
                disposeReferencePacketResult(result);
            } finally {
                await f.close();
            }
        });
        it('snapshots request bytes synchronously and excludes every competing operation', async () => {
            const entered = deferred<void>();
            const release = deferred<Uint8Array>();
            const f = await setup({
                mode,
                sign: () => {
                    entered.resolve();
                    return release.promise;
                },
            });

            try {
                await f.online();
                const source = packetInput();
                const original = source.body.slice();
                const pending = f.session.requestPacket(source);
                source.body.fill(0);
                await deadline(entered.promise, 'packet signer');
                await expect(f.session.requestPacket(packetInput())).rejects.toThrow('busy');
                await expect(f.session.heartbeat()).rejects.toThrow('busy');
                await expect(f.session.alive()).rejects.toThrow('busy');
                await expect(f.session.sendText(undefined as never)).rejects.toThrow('busy');
                await expect(f.session.friendRequest(undefined as never)).rejects.toThrow('busy');
                release.resolve(Uint8Array.of(7));
                const result = await deadline(pending, 'packet response');
                expect(f.requests.at(-1)!.body).toEqual(original);
                expect(f.signed).toHaveLength(1);
                disposeReferencePacketResult(result);
            } finally {
                release.resolve(Uint8Array.of(7));
                await f.close();
            }
        });
        it.each([
            'wrong-account',
            'wrong-key',
            'wrong-command',
            'wrong-sequence',
            'protocol13',
            'none',
            'zero',
            'malformed',
            'no-response',
        ] as const)('closes without retry for %s', async (fault) => {
            const f = await setup({
                mode,
                reply: (request) => {
                    if (fault === 'no-response') {
                        return undefined;
                    }

                    const frame = response(
                        request.sequence + (fault === 'wrong-sequence' ? 1 : 0),
                        fault === 'wrong-command' ? commands[2] : request.command,
                        defaultBody,
                        fault === 'wrong-account' ? '456' : '123',
                        fault === 'wrong-key' ? new Uint8Array(16).fill(99) : key,
                    );

                    if (fault === 'protocol13') {
                        frame.writeUInt32BE(13, 4);
                    }

                    if (fault === 'malformed') {
                        frame.writeUInt32BE(13, 0);
                    }

                    if (fault === 'none' || fault === 'zero') {
                        const decoded = decodeServiceResponse(frame, key);
                        const payload =
                            fault === 'zero'
                                ? qqTeaEncrypt(decoded.body, new Uint8Array(16))
                                : decoded.body;
                        const changed = Buffer.concat([frame.subarray(0, 17), payload]);
                        changed.writeUInt32BE(changed.length, 0);
                        changed[8] = fault === 'zero' ? 2 : 0;
                        decoded.body.fill(0);
                        payload.fill(0);
                        frame.fill(0);
                        return changed;
                    }

                    return frame;
                },
            });

            try {
                await f.online();
                const error = await f.session
                    .requestPacket({ ...packetInput(), timeoutMs: 80 })
                    .then(
                        () => undefined,
                        (value: unknown) => value,
                    );
                expect(error).toBeInstanceOf(WtReferencePacketError);
                expect(
                    f.requests.filter((request) => request.command === commands[1]),
                ).toHaveLength(1);
                await f.session.whenClosed;
                expect(f.session.getState()).toBe('closed');
            } finally {
                await f.close();
            }
        });
        it('surfaces a verified SSO retCode with write context and no fake business response', async () => {
            const f = await setup({ mode, retCode: -10001 });

            try {
                await f.online();
                await expect(f.session.requestPacket(packetInput())).rejects.toMatchObject({
                    name: 'WtReferencePacketError',
                    command: commands[1],
                    code: 'sso-error',
                    retCode: -10001,
                    writeState: 'written',
                });
                expect(f.verified).toHaveLength(1);
                expect(f.requests).toHaveLength(2);
            } finally {
                await f.close();
            }
        });
    });
}

it.each(['close', 'abort', 'timeout'] as const)(
    'settles %s while signing and erases prepared bytes',
    async (fault) => {
        const entered = deferred<void>();
        const release = deferred<Uint8Array>();
        const allocations: WtReferencePacketInput[] = [];
        const prepare = packetFlow.prepareReferencePacketInput;
        const spy = vi
            .spyOn(packetFlow, 'prepareReferencePacketInput')
            .mockImplementation((input) => {
                const result = prepare(input);
                allocations.push(result);
                return result;
            });
        const f = await setup({
            sign: () => {
                entered.resolve();
                return release.promise;
            },
        });

        try {
            await f.online();
            const pending = f.session.requestPacket({ ...packetInput(), timeoutMs: 80 });
            void pending.catch(() => {});
            await deadline(entered.promise, 'signer entered');

            if (fault === 'close') {
                f.session.close();
            }

            if (fault === 'abort') {
                f.controller.abort();
            }

            await expect(deadline(pending, 'signer stopped')).rejects.toBeInstanceOf(
                WtReferencePacketError,
            );
            expect(f.requests).toHaveLength(1);
            expect(allocations).toHaveLength(1);
            expect(wiped(allocations[0].body)).toBe(true);
            expect(wiped(f.signed[0].body)).toBe(true);
            release.resolve(Uint8Array.of(8));
            await turn();
            expect(f.requests).toHaveLength(1);
        } finally {
            spy.mockRestore();
            release.resolve(Uint8Array.of(8));
            await f.close();
        }
    },
);

it.each(['deny', 'throw', 'close'] as const)(
    'does not deliver a response when raw verification %s',
    async (fault) => {
        const f = await setup();

        f.settings.verify = () => {
            if (fault === 'throw') {
                throw new Error('synthetic verifier error');
            }

            if (fault === 'close') {
                f.session.close();
            }

            return fault === 'close';
        };

        try {
            await f.online();
            await expect(f.session.requestPacket(packetInput())).rejects.toBeInstanceOf(
                WtReferencePacketError,
            );
            expect(f.verified).toHaveLength(1);
            expect(wiped(f.verified[0].responseFrame)).toBe(true);
            expect(f.requests).toHaveLength(2);
        } finally {
            await f.close();
        }
    },
);

it.each([65537, 2 * 1024 * 1024])(
    'accepts a %s-byte owned packet response without changing old send limits',
    async (size) => {
        const body = new Uint8Array(size).fill(0x52);
        const f = await setup({ body });

        try {
            await f.online();
            const result = await deadline(
                f.session.requestPacket({
                    ...packetInput(),
                    timeoutMs: 5000,
                    maxResponseBodyBytes: size,
                }),
                'large response',
                7000,
            );
            expect(result.body.byteLength).toBe(size);
            expect(Buffer.compare(result.body, body)).toBe(0);
            // Keep identity diagnostics scalar; negated object matchers still deep-compare large views.
            expect(result.body === body).toBe(false);
            disposeReferencePacketResult(result);
            expect(body[0]).toBe(0x52);
        } finally {
            await f.close();
        }
    },
);

it('enforces caller response cap and old sendText admission limits', async () => {
    const f = await setup({ body: new Uint8Array(65537) });

    try {
        await f.online();
        await expect(
            f.session.sendText({
                request: {
                    route: { kind: 'group', groupUin: 456n },
                    text: 'x',
                    clientSequence: 1n,
                    random: 1,
                },
                maxResponseBodyBytes: 65537,
            }),
        ).rejects.toThrow();
        expect(f.session.getState()).toBe('success');
        await expect(f.session.requestPacket(packetInput())).rejects.toBeInstanceOf(
            WtReferencePacketError,
        );
        expect(f.requests).toHaveLength(2);
    } finally {
        await f.close();
    }
});

it.each(['owner-finalization', 'mux-final-fence'] as const)(
    'erases decoded raw bodies on %s failure',
    async (stage) => {
        const f = await setup();
        const captured: WtReferencePacketResult[] = [];
        const original = packetFlow.referencePacketWithCapability;
        let arm = false;
        const clock = performance.now.bind(performance);
        const flowSpy = vi
            .spyOn(packetFlow, 'referencePacketWithCapability')
            .mockImplementation(async (...args) => {
                const result = await original(...args);
                captured.push(result);

                if (stage === 'owner-finalization') {
                    f.session.close();
                }

                return result;
            });
        const dispose = packetFlow.disposePreparedReferencePacket;
        const disposeSpy = vi
            .spyOn(packetFlow, 'disposePreparedReferencePacket')
            .mockImplementation((input) => {
                dispose(input);

                if (stage === 'mux-final-fence') {
                    arm = true;
                }
            });
        const clockSpy = vi.spyOn(performance, 'now').mockImplementation(() => {
            if (arm) {
                arm = false;
                f.session.close();
            }

            return clock();
        });

        try {
            await f.online();
            await expect(f.session.requestPacket(packetInput())).rejects.toBeInstanceOf(
                WtReferencePacketError,
            );
            expect(captured).toHaveLength(1);
            expect(wiped(captured[0].body)).toBe(true);
        } finally {
            clockSpy.mockRestore();
            disposeSpy.mockRestore();
            flowSpy.mockRestore();
            await f.close();
        }
    },
);

it('keeps two restored owners bound to their independent account and key', async () => {
    const first = await setup();
    const second = await setup({ account: '456', byte: 19 });

    try {
        await Promise.all([first.online(), second.online()]);
        const results = await Promise.all([
            first.session.requestPacket(packetInput()),
            second.session.requestPacket(packetInput()),
        ]);
        expect(first.requests.at(-1)!.uin).toBe('123');
        expect(second.requests.at(-1)!.uin).toBe('456');
        results.forEach(disposeReferencePacketResult);
        first.session.close();
        const surviving = await second.session.requestPacket(packetInput(commands[2]));
        disposeReferencePacketResult(surviving);
        expect(second.session.getState()).toBe('success');
    } finally {
        await first.close();
        await second.close();
    }
});

it('routes a same-sequence MsgPush separately and waits until the packet gate releases', async () => {
    const f = await setup({
        reply: (request) =>
            Buffer.concat([
                response(request.sequence, PUSH, Uint8Array.of(8, 1), '123', key),
                response(request.sequence, request.command, defaultBody, '123', key),
            ]),
    });

    try {
        await f.online();
        const result = await f.session.requestPacket(packetInput());
        await turn();
        expect(result.body).toEqual(defaultBody);
        expect(f.pushed).toEqual([result.sequence]);
        expect(f.verified).toHaveLength(1);
        disposeReferencePacketResult(result);
    } finally {
        await f.close();
    }
});

it('binds private packet identity, excludes other workflows, and never reuses an ended run', async () => {
    const publish = privateSession.publishReferenceSessionSend;
    let binding: Parameters<typeof publish> | undefined;
    const spy = vi
        .spyOn(privateSession, 'publishReferenceSessionSend')
        .mockImplementation((...args) => {
            binding = args;
            return publish(...args);
        });
    const f = await setup();

    try {
        await f.online();
        const [token, , origin, lease, owner] = binding!;
        const run = {};
        expect(() =>
            privateSession.beginReferencePacketOperation(
                token,
                owner,
                lease,
                origin,
                run,
                REGISTER as WtReferencePacketCommand,
            ),
        ).toThrow();
        expect(() =>
            privateSession.beginReferencePacketOperation(
                token,
                {} as typeof owner,
                lease,
                origin,
                run,
                commands[1],
            ),
        ).toThrow();
        const operation = privateSession.beginReferencePacketOperation(
            token,
            owner,
            lease,
            origin,
            run,
            commands[1],
        );
        expect(() =>
            privateSession.beginReferenceFriendWorkflow(token, owner, lease, origin, {}),
        ).toThrow();
        expect(() => privateSession.beginReferenceSend(token, origin, lease, {})).toThrow();
        privateSession.beginReferenceSend(token, origin, lease, run);
        expect(privateSession.referenceActivePacketOperation(token, owner, lease, run)).toBe(
            operation,
        );
        expect(() =>
            privateSession.referenceActivePacketOperation(token, owner, {} as typeof lease, run),
        ).toThrow();
        expect(() =>
            privateSession.referenceActivePacketOperation(token, owner, lease, {}),
        ).toThrow();
        expect(() =>
            privateSession.endReferencePacketOperation(token, owner, lease, origin, operation),
        ).toThrow();
        privateSession.endReferenceSend(token, origin, lease, run);
        privateSession.endReferencePacketOperation(token, owner, lease, origin, operation);
        expect(() =>
            privateSession.beginReferencePacketOperation(
                token,
                owner,
                lease,
                origin,
                run,
                commands[1],
            ),
        ).toThrow();
        const response = await f.session.requestPacket(packetInput());
        disposeReferencePacketResult(response);
    } finally {
        spy.mockRestore();
        await f.close();
    }
});

it('reports a missing private packet implementation instead of falling back or fabricating a reply', async () => {
    const publish = privateSession.publishReferenceSessionSend;
    const spy = vi
        .spyOn(privateSession, 'publishReferenceSessionSend')
        .mockImplementation((token, reservation, origin, lease, owner, send, friend) => {
            publish(token, reservation, origin, lease, owner, send, friend);
        });
    const f = await setup();

    try {
        await f.online();
        await expect(f.session.requestPacket(packetInput())).rejects.toMatchObject({
            name: 'WtReferencePacketError',
            code: 'operation-stopped',
            writeState: 'not-written',
        });
        expect(f.requests).toHaveLength(1);
        expect(f.signed).toEqual([]);
    } finally {
        spy.mockRestore();
        await f.close();
    }
});

it.each(['command', 'uin', 'uid', 'sequence', 'body'] as const)(
    'rejects signer mutation of %s without widening the fixed command set',
    async (field) => {
        const f = await setup({
            sign: (input) => {
                if (field === 'body') {
                    input.body[0] ^= 1;
                } else {
                    Object.assign(input, {
                        [field]: field === 'sequence' ? input.sequence + 1 : 'synthetic.changed',
                    });
                }

                return Uint8Array.of(8);
            },
        });

        try {
            await f.online();
            await expect(f.session.requestPacket(packetInput())).rejects.toBeInstanceOf(
                WtReferencePacketError,
            );
            expect(f.requests).toHaveLength(1);
            expect(f.verified).toEqual([]);
        } finally {
            await f.close();
        }
    },
);

it.each(['qr', 'restored'] as const)(
    'uses actual loopback transport with the existing roster codec after %s login',
    async (mode) => {
        const wireBody = protobuf_encode<OidbBase<OidbSvcTrpcTcp0xFD4_1Response>>({
            command: 0xfd4,
            subCommand: 1,
            errorCode: 0,
            body: {
                friends: [{ uin: 456, uid: 'synthetic-friend' }],
                cookie: Uint8Array.of(9),
                categories: [],
            },
        });
        const f = await setup({ mode, loopback: true, body: wireBody });

        try {
            await f.online();
            const page = await FetchFriendListPage.invoke(
                {
                    sendRawPacket: async (command, body) => {
                        if (!isWtReferencePacketCommand(command)) {
                            throw new Error('unlisted codec command');
                        }

                        const result = await f.session.requestPacket({
                            ...packetInput(command),
                            body,
                        });

                        try {
                            return {
                                success: true,
                                gotResponse: true,
                                errorCode: result.retCode,
                                errorMessage: '',
                                responseData: Buffer.from(result.body),
                            };
                        } finally {
                            disposeReferencePacketResult(result);
                        }
                    },
                },
                {},
            );
            expect(page.entries[0].friend).toMatchObject({ uin: 456, uid: 'synthetic-friend' });
            expect(page.cookie).toEqual(Uint8Array.of(9));
            expect(f.requests.at(-1)!.command).toBe(commands[1]);
            expect(f.failures).toEqual([]);
            f.settings.body = protobuf_encode<OidbBase<OidbSvcTrpcTcp0xFD4_1Response>>({
                command: 0xfd4,
                subCommand: 1,
                errorCode: 17,
                errorMsg: 'synthetic rejection',
            });
            const result = await f.session.requestPacket(packetInput());
            expect(() => {
                const parsed = FetchFriendListPage.decode(result.body);

                if (parsed.errorCode) {
                    throw new OidbError(parsed.errorCode, parsed.errorMsg ?? '', 0xfd4, 1);
                }
            }).toThrow(OidbError);
            expect(f.session.getState()).toBe('success');
            disposeReferencePacketResult(result);
        } finally {
            await f.close();
        }
    },
);
