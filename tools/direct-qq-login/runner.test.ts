import childProcess, { type ChildProcess } from 'node:child_process';
import { createHash, ECDH } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createServer, Socket, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { DirectThirdPartyLoginResponse } from '../../packages/proto-defs/src/direct-login';
import type { DirectSsoReserve } from '../../packages/proto-defs/src/sso-reserve';
import type { PushMsg } from '../../packages/proto-defs/src/message';
import type { SsoRegisterResponse } from '../../packages/proto-defs/src/sso-register';
import { encodeWtTlv } from '../../packages/protocol/src/direct/wt-tlv';
import { encodeWtQrD1 } from '../../packages/protocol/src/direct/wt-qr-protobuf';
import { decodeServiceResponse } from '../../packages/protocol/src/direct/service-frame';
import { ServiceFrameDecoder } from '../../packages/protocol/src/direct/service-stream';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../packages/protocol/src/direct/qq-tea';
import { SSO_INFO_SYNC_COMMAND } from '../../packages/protocol/src/direct/sso-register';
import { createWtEcdh } from '../../packages/protocol/src/direct/wt-ecdh';
import { parseConfig, readConfig, REFERENCE_COMMIT, type DirectLoginConfig } from './config';
import {
    startDirectLogin,
    restoreDirectLogin,
    startManagedDirectLogin,
    restoreManagedDirectLogin,
    type ManagedDirectLoginOptions,
    type DirectRestoredLoginController,
    type DirectLoginController,
    type DirectLoginPushOptions,
    type LoginEvent,
} from './runner';
import { loadDeviceGuid, prepareQrDirectory, saveQrImage } from './private-files';
import { ObservedConnection } from './connection';
import * as accountVault from '../../packages/core/src/direct/account-vault';
import * as syntheticWorkerTransport from '../../packages/protocol/src/direct/local-qq-sign-worker';
import type {
    AccountVault,
    VaultBinding,
    VaultGuard,
    VaultReadResult,
    VaultRevision,
} from './account-vault';
import { persistedProfileDigest } from './account-persistence';
import { parseCliOptions } from './cli';
import { encodeWtPersistedSession } from '../../packages/protocol/src/direct/wt-persisted-session';

// Real loopback TCP and Node JSONL children, synthetic keys/tickets/QR/signatures only.
// No real QQ gateway, native library, desktop client or Hook is accessed.
const ready = {
    type: 'ready',
    protocol: 1,
    build: '3.2.35-54395',
    sha256: 'dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328',
};
const worker = `
    const crypto = require('node:crypto');
    const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
    send(${JSON.stringify(ready)});
    require('node:readline').createInterface({input:process.stdin}).on('line',line => {
        const request = JSON.parse(line);
        if (Object.keys(request).sort().join(',') !== 'body,command,id,sequence') process.exit(9);
        const sign = crypto.createHash('sha256').update(request.command+':'+request.sequence+':').update(Buffer.from(request.body,'hex')).digest('hex');
        send({id:request.id,result:{sign,token:'',extra:''}});
    });
`;
const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082',
    'hex',
);
const key = new Uint8Array(16).fill(10);
const ticketKey = new Uint8Array(16).fill(4);
const directories: string[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();
const sessions: (DirectLoginController | DirectRestoredLoginController)[] = [];
const children: ChildProcess[] = [];
const closed = new WeakSet<ChildProcess>();
let onChildSpawn: (() => void) | undefined;

const word = (value: number) => {
    const output = Buffer.alloc(4);
    output.writeUInt32BE(value >>> 0);
    return output;
};

const field = (value: Uint8Array) => Buffer.concat([word(value.length + 4), value]);

function responseFrame(
    uin: string,
    inner: Uint8Array,
    encrypted: boolean,
    protocol: 12 | 13 = 12,
): Buffer {
    const cipher = qqTeaEncrypt(inner, encrypted ? key : new Uint8Array(16));
    return Buffer.concat([
        word(14 + uin.length + cipher.length),
        word(protocol),
        Buffer.of(encrypted ? 1 : 2, 0),
        field(Buffer.from(uin)),
        cipher,
    ]);
}

const peer = createWtEcdh(Buffer.concat([Buffer.alloc(23), Buffer.of(2)]));

// The peer has an intentionally independent request reader/response assembler.
// QQ-TEA, ECDH, TLV and protobuf operations use the real existing implementations.
function parseWt(frame: Uint8Array) {
    const wire = Buffer.from(frame);
    const accountStart = 10 + wire.readUInt32BE(9);
    const accountEnd = accountStart + wire.readUInt32BE(accountStart);
    const account = wire.subarray(accountStart + 4, accountEnd).toString();
    const inner = Buffer.from(qqTeaDecrypt(wire.subarray(accountEnd), new Uint8Array(16)));
    let offset = 28;

    const next = () => {
        const size = inner.readUInt32BE(offset);
        const result = inner.subarray(offset + 4, offset + size);
        offset += size;
        return result;
    };

    next();
    const command = next().toString();
    next();
    next();
    next();
    offset += inner.readUInt16BE(offset);
    const reserved = next();
    const oicq = inner.subarray(inner.readUInt32BE(0) + 4);
    const point = oicq.subarray(50, 75);
    const shared = peer.deriveTeaKey(point);
    const business = Buffer.from(qqTeaDecrypt(oicq.subarray(75, -1), shared));
    return {
        account,
        command,
        reserved,
        oicq,
        point,
        shared,
        seq: inner.readUInt32BE(4),
        kind: oicq.readUInt16BE(5) === 0x810 ? 0x810 : business.readUInt16BE(21),
    };
}

function wtReply(
    req: ReturnType<typeof parseWt>,
    business: Uint8Array,
    qrTrailer: Uint8Array = Uint8Array.of(3),
): Buffer {
    let body = business;

    if (req.kind !== 0x810) {
        const layer = Buffer.alloc(43);
        layer.writeUInt16BE(req.kind, 3);
        // Non-zero opaque response values must not become false account/sequence matches.
        layer.writeUInt32BE(73, 31);
        layer.writeBigInt64BE(456n, 35);
        const code2d = Buffer.concat([layer, business, qrTrailer]);
        body = Buffer.concat([
            Buffer.from([0, 0, code2d.length >> 8, code2d.length & 255, 0]),
            code2d,
        ]);
    }

    const cipher = qqTeaEncrypt(body, req.shared);
    const oicq = Buffer.alloc(17 + cipher.length);
    oicq[0] = 2;
    oicq.writeUInt16BE(oicq.length, 1);
    oicq.writeUInt16BE(req.kind === 0x810 ? 0x810 : 0x812, 5);
    oicq.writeUInt32BE(req.kind === 0x810 ? 123 : 789, 9);
    oicq.set(cipher, 16);
    oicq[oicq.length - 1] = 3;
    const inner = Buffer.concat([
        field(
            Buffer.concat([
                word(req.seq),
                word(0),
                field(Buffer.alloc(0)),
                field(Buffer.from(req.command)),
                field(Buffer.alloc(0)),
                word(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(oicq),
    ]);
    return responseFrame(req.account, inner, false);
}

function pollBody(code: number): Buffer {
    const header = Buffer.from([0, 0, 0, 0, 0, 42, code]);

    if (code) {
        return header;
    }

    const identity = Buffer.alloc(12);
    identity.writeBigInt64BE(123n);
    return Buffer.concat([
        header,
        identity,
        encodeWtTlv([
            { tag: 0x1e, value: ticketKey },
            { tag: 0x19, value: Uint8Array.of(5) },
            { tag: 0x18, value: Uint8Array.of(6) },
        ]),
    ]);
}

function fetchBody(): Buffer {
    return Buffer.concat([
        Buffer.from([0, 0, 0, 0, 0, 42, 0]),
        Buffer.from([0, 3, 1, 2, 3]),
        encodeWtTlv([
            { tag: 0x17, value: png },
            { tag: 0xd1, value: encodeWtQrD1({ qrUrl: 'https://example.invalid/private-qr' }) },
        ]),
    ]);
}

function loginBody(): Buffer {
    const projection = protobuf_encode<DirectThirdPartyLoginResponse>({
        commonInfo: { rspNT: { uid: 'synthetic-private-uid' } },
    });
    return Buffer.concat([
        Buffer.from([0, 9, 0]),
        encodeWtTlv([
            {
                tag: 0x119,
                value: qqTeaEncrypt(
                    encodeWtTlv([
                        { tag: 0x143, value: Uint8Array.of(9) },
                        { tag: 0x305, value: key },
                        { tag: 0x10a, value: Uint8Array.of(11) },
                        { tag: 0x106, value: Uint8Array.of(12) },
                        { tag: 0x543, value: projection },
                    ]),
                    ticketKey,
                ),
            },
        ]),
    ]);
}

function parseRegister(frame: Uint8Array) {
    const wire = Buffer.from(frame);
    const ticketEnd = 9 + wire.readUInt32BE(9);
    const accountStart = ticketEnd + 1;
    const end = accountStart + wire.readUInt32BE(accountStart);
    const inner = Buffer.from(qqTeaDecrypt(wire.subarray(end), key));
    let offset = 28;

    const next = () => {
        const size = inner.readUInt32BE(offset);
        const result = inner.subarray(offset + 4, offset + size);
        offset += size;
        return result;
    };

    next();
    const command = next().toString();
    next();
    next();
    next();
    offset += inner.readUInt16BE(offset);
    const reserved = next();
    return {
        uin: wire.subarray(accountStart + 4, end).toString(),
        sequence: inner.readUInt32BE(4),
        command,
        reserved,
        body: inner.subarray(inner.readUInt32BE(0) + 4),
    };
}

function registerReply(
    request: ReturnType<typeof parseRegister>,
    message = 'register success',
): Buffer {
    const body = protobuf_encode<SsoRegisterResponse>({ register: { message } });
    const inner = Buffer.concat([
        field(
            Buffer.concat([
                word(request.sequence),
                word(0),
                field(Buffer.alloc(0)),
                field(Buffer.from(request.command)),
                field(Buffer.alloc(0)),
                word(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(body),
    ]);
    return responseFrame(request.uin, inner, true);
}

const pushCommand = 'trpc.msg.olpush.OlPushService.MsgPush';
const pushText = 'synthetic private push content';

function messageBody(sequence = 71): Uint8Array {
    return protobuf_encode<PushMsg>({
        message: {
            responseHead: { fromUin: 456, fromUid: 'synthetic-sender', toUin: 123 },
            contentHead: { msgType: 166, sequence, timestamp: 1700000000, msgId: 99 },
            body: { richText: { elems: [{ text: { str: pushText } }] } },
        },
    });
}

function pushFrame(
    body: Uint8Array,
    options: {
        uin?: string;
        sequence?: number;
        compressed?: boolean;
        command?: string;
        protocol?: 12 | 13;
    } = {},
): Buffer {
    const inner = Buffer.concat([
        field(
            Buffer.concat([
                word(options.sequence ?? 71),
                word(0),
                field(Buffer.alloc(0)),
                field(Buffer.from(options.command ?? pushCommand)),
                field(Buffer.alloc(0)),
                word(options.compressed ? 1 : 0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(options.compressed ? deflateSync(body) : body),
    ]);
    return responseFrame(options.uin ?? '123', inner, true, options.protocol);
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function checkSignature(
    reserved: Uint8Array,
    command: string,
    sequence: number,
    body: Uint8Array,
): void {
    const value = protobuf_decode<DirectSsoReserve>(reserved);
    expect(value.msgType).toBeNull();
    expect(value.ntCoreVersion).toBeNull();
    const expected = createHash('sha256')
        .update(command + ':' + sequence + ':')
        .update(body)
        .digest();
    expect(Buffer.from(value.secureInfo?.sign ?? [])).toEqual(expected);
}

async function directory() {
    const result = await mkdtemp(path.join(os.tmpdir(), 'jiyu-direct-fixture-'));
    directories.push(result);
    return result;
}

function configuration(dir: string, port: number): DirectLoginConfig {
    const profile = {
        appId: 42,
        subAppId: 43,
        clientVersion: 44,
        currentVersion: 'fixture-version',
        packageName: 'p',
        ptVersion: 'pt',
        ssoVersion: 19,
        mainSigMap: 1,
        miscBitMap: 2,
        subSigMap: 3,
        sdkVersion: 'sdk',
        os: 'Linux',
        deviceName: 'fixture',
        deviceType: 'Linux',
        vendorOs: 'linux',
        apkSignatureHex: '0102',
        unknown21Hex: '00'.repeat(21),
        tlv124Hex: '00'.repeat(12),
        peerPublicKeyHex: Buffer.from(
            ECDH.convertKey(peer.publicKey, 'secp192k1', undefined, undefined, 'uncompressed'),
        ).toString('hex'),
        qrCommand: 'fixture.qr',
        loginCommand: 'fixture.login',
    };
    return parseConfig(
        {
            version: 1,
            referenceCommit: REFERENCE_COMMIT,
            gateway: { host: '127.0.0.1', port, family: 4 },
            signer: {
                executable: process.execPath,
                args: ['-e', worker],
                cwd: dir,
                initialUin: '0',
                expectedBuild: ready.build,
                expectedSha256: ready.sha256,
                startupTimeoutMs: 5000,
                requestTimeoutMs: 3000,
                maxPending: 1,
            },
            statePath: path.join(dir, 'device.json'),
            outDir: path.join(dir, 'qr'),
            attemptTimeoutMs: 15000,
            transactionTimeoutMs: 2000,
            connectTimeoutMs: 1000,
            onlineHoldMs: 10000,
            reserve: {
                msgType: null,
                ntCoreVersion: null,
                signCommands: ['fixture.qr', 'fixture.login', SSO_INFO_SYNC_COMMAND],
            },
            profile,
            provenance: Object.fromEntries(
                Object.keys(profile).map((key) => [key, 'local-policy']),
            ),
        },
        dir,
    );
}

async function fixture(
    options: {
        wait?: boolean;
        terminalPoll?: number;
        wrongOuter?: boolean;
        silent?: boolean;
        registration?: string;
        qrTrailer?: Uint8Array;
        beforeRegisterPush?: Uint8Array;
        registerGate?: Promise<void>;
    } = {},
) {
    let connections = 0;
    let polls = 0;
    const commands: string[] = [];
    const accounts: string[] = [];
    const points: string[] = [];
    const errors: unknown[] = [];
    const registrationStarted = deferred();
    const disconnected = deferred();
    let peerSocket: Socket | undefined;
    const server = createServer((socket) => {
        connections++;
        peerSocket = socket;
        socket.once('close', disconnected.resolve);
        sockets.add(socket);
        socket.on('error', () => {});
        socket.once('close', () => sockets.delete(socket));
        const decoder = new ServiceFrameDecoder();
        socket.on('data', (chunk) => {
            try {
                for (const frame of decoder.push(chunk)) {
                    if (options.silent) {
                        continue;
                    }

                    if (frame[8] === 2) {
                        const req = parseWt(frame);
                        checkSignature(req.reserved, req.command, req.seq, req.oicq);
                        commands.push(req.command);
                        accounts.push(req.account);
                        points.push(req.point.toString('hex'));
                        const body =
                            req.kind === 0x31
                                ? fetchBody()
                                : req.kind === 0x12
                                  ? pollBody(
                                        options.terminalPoll ??
                                            (options.wait && polls++ === 0 ? 48 : 0),
                                    )
                                  : loginBody();
                        const response = wtReply(req, body, options.qrTrailer);

                        if (options.wrongOuter) {
                            const decoded = decodeServiceResponse(response);
                            socket.write(responseFrame('999', decoded.body, false));
                        } else {
                            socket.write(response);
                        }
                    } else {
                        const req = parseRegister(frame);
                        checkSignature(req.reserved, req.command, req.sequence, req.body);
                        commands.push(req.command);
                        accounts.push(req.uin);

                        if (options.beforeRegisterPush) {
                            socket.write(options.beforeRegisterPush);
                        }

                        registrationStarted.resolve();

                        if (options.registerGate) {
                            void options.registerGate.then(() => {
                                if (!socket.destroyed) {
                                    socket.write(registerReply(req, options.registration));
                                }
                            });
                        } else {
                            socket.write(registerReply(req, options.registration));
                        }
                    }
                }
            } catch (error) {
                errors.push(error);
                socket.destroy();
            }
        });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();

    if (!address || typeof address === 'string') {
        throw new Error('fixture');
    }

    const dir = await directory();
    const config = configuration(dir, address.port);
    return {
        config,
        dir,
        commands,
        accounts,
        points,
        errors,
        registrationStarted: registrationStarted.promise,
        disconnected: disconnected.promise,
        sendFrames(...frames: Uint8Array[]) {
            if (!peerSocket || peerSocket.destroyed) {
                throw new Error('fixture peer closed');
            }

            peerSocket.write(Buffer.concat(frames));
        },
        get connections() {
            return connections;
        },
    };
}

beforeEach(() => {
    onChildSpawn = undefined;
    const spawn = childProcess.spawn;
    vi.spyOn(childProcess, 'spawn').mockImplementation(((...args: Parameters<typeof spawn>) => {
        const child = Reflect.apply(spawn, childProcess, args) as ChildProcess;
        children.push(child);
        child.once('close', () => closed.add(child));
        onChildSpawn?.();
        return child;
    }) as typeof spawn);
    syncBuiltinESMExports();
});
afterEach(async () => {
    try {
        await Promise.all(sessions.splice(0).map((session) => session.close()));

        for (const socket of sockets) {
            socket.destroy();
        }

        await Promise.all(
            servers
                .splice(0)
                .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
        );

        for (const child of children.splice(0)) {
            if (!closed.has(child)) {
                const close = once(child, 'close');
                child.kill('SIGKILL');
                await close;
            }
        }

        await Promise.all(
            directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
        );
    } finally {
        vi.restoreAllMocks();
        syncBuiltinESMExports();
    }
});

function persistencePaths(dir: string) {
    return {
        vaultRoot: path.join(dir, 'vault'),
        keyRoot: path.join(dir, 'keys'),
        slotId: '01'.repeat(16),
    };
}

function fakeAccountStore() {
    const state = {
        payload: undefined as Uint8Array | undefined,
        binding: undefined as VaultBinding | undefined,
        revoked: false,
        saves: 0,
        closes: 0,
        saveError: undefined as Error | undefined,
        closeError: undefined as Error | undefined,
        saveGate: undefined as Promise<void> | undefined,
        saveStarted: deferred(),
    };
    const revision: VaultRevision = { generation: 1n, recordHash: 'aa'.repeat(32) };

    const check = (guard?: VaultGuard) => {
        if (guard && (guard.signal.aborted || guard.isCurrent() !== true)) {
            throw new accountVault.AccountVaultError('cancelled');
        }
    };

    const open = vi.spyOn(accountVault, 'openAccountVault').mockImplementation(async () => {
        let closed = false;
        let active: Promise<VaultRevision> | undefined;
        const vault: AccountVault = {
            async read<T>(
                binding: VaultBinding,
                consume: (value: Uint8Array, revision: VaultRevision) => T,
                guard?: VaultGuard,
            ): Promise<VaultReadResult<T>> {
                check(guard);

                if (closed) {
                    throw new accountVault.AccountVaultError('closed');
                }

                if (state.revoked) {
                    return { kind: 'revoked', revision };
                }

                if (!state.payload) {
                    return { kind: 'missing' };
                }

                if (
                    state.binding &&
                    (binding.uin !== state.binding.uin ||
                        !Buffer.from(binding.profileDigest).equals(
                            Buffer.from(state.binding.profileDigest),
                        ) ||
                        !Buffer.from(binding.deviceDigest).equals(
                            Buffer.from(state.binding.deviceDigest),
                        ))
                ) {
                    throw new accountVault.AccountVaultError('binding-mismatch');
                }

                const bytes = Uint8Array.from(state.payload);

                try {
                    return { kind: 'present', revision, value: consume(bytes, revision) };
                } finally {
                    bytes.fill(0);
                }
            },
            save(binding, payload, expected, guard) {
                state.saves++;
                state.saveStarted.resolve();
                active = (async () => {
                    await state.saveGate;
                    check(guard);

                    if (closed) {
                        throw new accountVault.AccountVaultError('closed');
                    }

                    if (state.saveError) {
                        throw state.saveError;
                    }

                    expect(expected).toEqual(state.payload ? revision : null);
                    state.payload = Uint8Array.from(payload);
                    state.binding = {
                        uin: binding.uin,
                        profileDigest: Uint8Array.from(binding.profileDigest),
                        deviceDigest: Uint8Array.from(binding.deviceDigest),
                    };
                    return revision;
                })();
                return active;
            },
            async revoke() {
                throw new Error('unexpected revoke');
            },
            async close() {
                closed = true;
                await active?.catch(() => {});
                state.closes++;

                if (state.closeError) {
                    throw state.closeError;
                }
            },
        };
        return vault;
    });
    return { state, open };
}

async function seedAccount(
    f: Awaited<ReturnType<typeof fixture>>,
    store: ReturnType<typeof fakeAccountStore>,
) {
    // Linux restore deliberately rejects a world-writable /tmp ancestor.
    if (process.platform === 'linux') {
        const dir = await mkdtemp(path.join(os.homedir(), '.jiyu-direct-fixture-'));
        directories.push(dir);
        f.config.statePath = path.join(dir, 'device.json');
    }

    const guid = await loadDeviceGuid(f.config.statePath);
    store.state.payload = encodeWtPersistedSession({
        version: 1,
        uin: '123',
        uid: 'synthetic-private-uid',
        guid,
        tickets: { d2: Uint8Array.of(9), d2Key: key, a1: Uint8Array.of(12), a2: Uint8Array.of(11) },
    });
    store.state.binding = {
        uin: '123',
        profileDigest: persistedProfileDigest(f.config),
        deviceDigest: createHash('sha256').update(guid).digest(),
    };
    guid.fill(0);
}

async function managedFixture(mode: 'qr' | 'restore') {
    const f = await fixture();
    const store = fakeAccountStore();

    if (mode === 'restore') {
        await seedAccount(f, store);
    }

    const persistence = persistencePaths(path.dirname(f.config.statePath));
    return {
        ...f,
        get connections() {
            return f.connections;
        },
        store,
        start(options: Omit<ManagedDirectLoginOptions, 'persistence'>) {
            return mode === 'qr'
                ? startManagedDirectLogin(f.config, { ...options, persistence })
                : restoreManagedDirectLogin(f.config, {
                      ...options,
                      persistence: { ...persistence, uin: '123' },
                  });
        },
    };
}

describe('explicit managed login lifecycle', () => {
    it.each([undefined, null, 0, -1, 1.5, NaN, Infinity, 0x80000000, '1000'])(
        'rejects invalid finite lease %s before resource acquisition',
        async (leaseTimeoutMs) => {
            const config = configuration(path.resolve('synthetic-managed-options'), 1);
            const store = fakeAccountStore();
            const persistence = persistencePaths(path.dirname(config.statePath));
            const options = { leaseTimeoutMs, persistence } as ManagedDirectLoginOptions;
            await expect(startManagedDirectLogin(config, options)).rejects.toMatchObject({
                code: 'configuration',
            });
            await expect(
                restoreManagedDirectLogin(config, {
                    ...options,
                    persistence: { ...persistence, uin: '123' },
                }),
            ).rejects.toMatchObject({ code: 'configuration' });
            expect(store.open).not.toHaveBeenCalled();
            expect(children).toHaveLength(0);
        },
    );

    it('requires explicit persistence and rejects accessor/proxy or malformed option records', async () => {
        const config = configuration(path.resolve('synthetic-managed-options'), 1);
        const store = fakeAccountStore();
        const valid = {
            leaseTimeoutMs: 5000,
            persistence: persistencePaths(path.dirname(config.statePath)),
        };
        const getter = vi.fn(() => valid.leaseTimeoutMs);
        const accessor = Object.defineProperty({ ...valid }, 'leaseTimeoutMs', { get: getter });
        const trap = vi.fn(() => {
            throw new Error('proxy must not execute');
        });
        const invalid: unknown[] = [
            undefined,
            null,
            [],
            {},
            { leaseTimeoutMs: 5000 },
            { ...valid, persistence: undefined },
            { ...valid, beforeRegister: 1 },
            { ...valid, onEvent: 1 },
            { ...valid, signal: {} },
            { ...valid, extra: true },
            accessor,
            new Proxy(valid, { get: trap }),
        ];

        for (const options of invalid) {
            await expect(
                startManagedDirectLogin(config, options as ManagedDirectLoginOptions),
            ).rejects.toMatchObject({ code: 'configuration' });
        }

        expect(getter).not.toHaveBeenCalled();
        expect(trap).not.toHaveBeenCalled();
        expect(store.open).not.toHaveBeenCalled();
        expect(children).toHaveLength(0);
    });

    it.each(['qr', 'restore'] as const)(
        'claims %s once before binding, retains the lease beyond onlineHold and drains on abort',
        async (mode) => {
            const f = await managedFixture(mode);
            f.config.onlineHoldMs = 20;
            const abort = new AbortController();
            const events: LoginEvent[] = [];
            const order: string[] = [];
            const spawnWorker = syntheticWorkerTransport.startLocalQqSignWorker;
            vi.spyOn(syntheticWorkerTransport, 'startLocalQqSignWorker').mockImplementation(
                async (options) => {
                    // The existing fixture launches only its Node JSONL echo worker, never native QQ.
                    const worker = await spawnWorker(options);
                    return Object.freeze({
                        ...worker,
                        bindUin(uin: string) {
                            order.push(`bind:${uin}`);
                            worker.bindUin(uin);
                        },
                    });
                },
            );
            const claim = vi.fn((uin: string) => {
                order.push(`claim:${uin}`);
                expect(uin).toBe('123');
                expect(f.store.open).toHaveBeenCalledOnce();
                expect(f.commands).toEqual(mode === 'qr' ? ['fixture.qr', 'fixture.qr'] : []);
                expect(children).toHaveLength(mode === 'qr' ? 1 : 0);
                expect(f.connections).toBe(mode === 'qr' ? 1 : 0);
            });
            const session = await f.start({
                leaseTimeoutMs: 8000,
                beforeRegister: claim,
                signal: abort.signal,
                onEvent: (event) => {
                    events.push(event);
                },
            });
            sessions.push(session);
            expect(order).toEqual(['claim:123', 'bind:123']);
            expect(claim).toHaveBeenCalledOnce();
            expect(session.confirmedUin).toBe('123');
            expect(f.store.state.saves).toBe(mode === 'qr' ? 1 : 0);
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
            expect(session.owner.getState()).toBe('success');
            expect(closed.has(children[0])).toBe(false);
            expect(events.filter((event) => event.state === 'closed')).toHaveLength(0);
            abort.abort();
            await session.whenClosed;
            await f.disconnected;
            expect(closed.has(children[0])).toBe(true);
            expect(session.owner.getState()).toBe('closed');
            expect(f.store.state.closes).toBe(1);
            expect(events.filter((event) => event.state === 'closed')).toHaveLength(1);
            expect(f.commands).toEqual(
                mode === 'qr'
                    ? ['fixture.qr', 'fixture.qr', 'fixture.login', SSO_INFO_SYNC_COMMAND]
                    : [SSO_INFO_SYNC_COMMAND],
            );
            expect(f.errors).toEqual([]);
        },
    );

    it.each(['qr', 'restore'] as const)(
        'ends %s at its explicit finite raw lease without an onlineHold timer',
        async (mode) => {
            const f = await managedFixture(mode);
            f.config.onlineHoldMs = 0;
            const timers = vi.spyOn(globalThis, 'setTimeout');
            const events: LoginEvent[] = [];
            const session = await f.start({
                leaseTimeoutMs: mode === 'qr' ? 3500 : 500,
                onEvent: (event) => {
                    events.push(event);
                },
            });
            sessions.push(session);
            expect(session.owner.getState()).toBe('success');
            expect(timers.mock.calls.some((call) => call[1] === 0)).toBe(false);
            await session.whenClosed;
            await f.disconnected;
            expect(session.owner.getState()).toBe('closed');
            expect(closed.has(children[0])).toBe(true);
            expect(f.store.state.closes).toBe(1);
            expect(events.filter((event) => event.state === 'online')).toHaveLength(1);
            expect(events.filter((event) => event.state === 'closed')).toHaveLength(1);
            expect(f.errors).toEqual([]);
        },
    );

    it.each(['qr', 'restore'] as const)(
        'rejects a throwing %s claim without binding or registration',
        async (mode) => {
            const f = await managedFixture(mode);
            const events: LoginEvent[] = [];
            const claim = vi.fn(() => {
                throw new Error('synthetic-claim-private-detail');
            });
            await expect(
                f.start({
                    leaseTimeoutMs: 8000,
                    beforeRegister: claim,
                    onEvent: (event) => {
                        events.push(event);
                    },
                }),
            ).rejects.toMatchObject({ code: 'before-register' });
            expect(claim).toHaveBeenCalledOnce();
            expect(f.commands).toEqual(mode === 'qr' ? ['fixture.qr', 'fixture.qr'] : []);
            expect(children).toHaveLength(mode === 'qr' ? 1 : 0);
            expect(children.every((child) => closed.has(child))).toBe(true);
            expect(f.store.state.saves).toBe(0);
            expect(f.store.state.closes).toBe(1);
            expect(events.some((event) => event.state === 'online')).toBe(false);
            expect(JSON.stringify(events)).not.toContain('synthetic-claim-private-detail');
            expect(f.errors).toEqual([]);
        },
    );

    it.each(['qr', 'restore'] as const)(
        'honors reentrant abort from a successful %s claim before sending registration',
        async (mode) => {
            const f = await managedFixture(mode);
            const abort = new AbortController();
            const claim = vi.fn(() => {
                abort.abort();
            });
            await expect(
                f.start({ leaseTimeoutMs: 8000, signal: abort.signal, beforeRegister: claim }),
            ).rejects.toMatchObject({ code: 'aborted' });
            expect(claim).toHaveBeenCalledOnce();
            expect(f.commands).toEqual(mode === 'qr' ? ['fixture.qr', 'fixture.qr'] : []);
            expect(children.every((child) => closed.has(child))).toBe(true);
            expect(f.store.state.closes).toBe(1);
            expect(f.store.state.saves).toBe(0);
        },
    );

    it.each(['resolved', 'rejected', 'pending', 'thenable', 'value'] as const)(
        'rejects %s asynchronous/non-void claim results without waiting or unhandled rejection',
        async (kind) => {
            const f = await managedFixture('restore');
            const rejectThen = vi.fn((_resolve: unknown, reject: (reason: Error) => void) => {
                reject(new Error('synthetic-thenable-detail'));
            });
            const claim = vi.fn(() => {
                switch (kind) {
                    case 'resolved':
                        return Promise.resolve();
                    case 'rejected':
                        return Promise.reject(new Error('synthetic-promise-detail'));
                    case 'pending':
                        return new Promise<void>(() => {});
                    case 'thenable':
                        return { then: rejectThen };
                    case 'value':
                        return true;
                }
            });
            await expect(
                f.start({ leaseTimeoutMs: 8000, beforeRegister: claim }),
            ).rejects.toMatchObject({ code: 'before-register' });
            expect(claim).toHaveBeenCalledOnce();

            if (kind === 'thenable') {
                expect(rejectThen).toHaveBeenCalledOnce();
            }

            expect(children).toHaveLength(0);
            expect(f.connections).toBe(0);
            expect(f.store.state.closes).toBe(1);
            expect(f.store.state.saves).toBe(0);
        },
    );

    it('rejects a pending QR claim and closes its already-open resources immediately', async () => {
        const f = await managedFixture('qr');
        await expect(
            f.start({ leaseTimeoutMs: 8000, beforeRegister: () => new Promise<void>(() => {}) }),
        ).rejects.toMatchObject({ code: 'before-register' });
        await f.disconnected;
        expect(f.commands).toEqual(['fixture.qr', 'fixture.qr']);
        expect(children.every((child) => closed.has(child))).toBe(true);
        expect(f.store.state.closes).toBe(1);
        expect(f.store.state.saves).toBe(0);
    });

    it('does not claim a restored identity before its saved binding has been verified', async () => {
        const f = await managedFixture('restore');
        f.config.profile.deviceName = 'mismatched-managed-profile';
        const claim = vi.fn();
        await expect(
            f.start({ leaseTimeoutMs: 8000, beforeRegister: claim }),
        ).rejects.toMatchObject({ code: 'account-store-binding-mismatch' });
        expect(claim).not.toHaveBeenCalled();
        expect(children).toHaveLength(0);
        expect(f.connections).toBe(0);
        expect(f.store.state.closes).toBe(1);
    });

    it('waits for an aborted durable checkpoint to drain rather than publishing managed online', async () => {
        const f = await managedFixture('qr');
        const gate = deferred();
        f.store.state.saveGate = gate.promise;
        const abort = new AbortController();
        const events: LoginEvent[] = [];
        let settled = false;
        const pending = f.start({
            leaseTimeoutMs: 8000,
            signal: abort.signal,
            onEvent: (event) => {
                events.push(event);
            },
        });
        const failure = pending.then(
            () => {
                throw new Error('managed login unexpectedly succeeded');
            },
            (error: unknown) => {
                settled = true;
                return error;
            },
        );
        await f.store.state.saveStarted.promise;
        abort.abort();
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        expect(settled).toBe(false);
        expect(events.some((event) => event.state === 'online')).toBe(false);
        gate.resolve();
        expect(await failure).toBeInstanceOf(Error);
        await f.disconnected;
        expect(closed.has(children[0])).toBe(true);
        expect(f.store.state.closes).toBe(1);
        expect(f.store.state.payload).toBeUndefined();
        expect(events.some((event) => event.state === 'online')).toBe(false);
    });

    it('snapshots managed options before callbacks and accepts the finite maximum lease', async () => {
        const f = await fixture();
        const store = fakeAccountStore();
        await seedAccount(f, store);
        const claim = vi.fn();
        const rejectedClaim = vi.fn(() => {
            throw new Error('late mutation');
        });
        const timers = vi.spyOn(globalThis, 'setTimeout');
        const options = {
            persistence: { ...persistencePaths(path.dirname(f.config.statePath)), uin: '123' },
            leaseTimeoutMs: 0x7fffffff,
            beforeRegister: claim,
            onEvent() {
                options.leaseTimeoutMs = 1;
                options.beforeRegister = rejectedClaim;
                options.persistence.uin = '999';
            },
        };
        const session = await restoreManagedDirectLogin(f.config, options);
        sessions.push(session);
        expect(session.confirmedUin).toBe('123');
        expect(claim).toHaveBeenCalledExactlyOnceWith('123');
        expect(rejectedClaim).not.toHaveBeenCalled();
        expect(timers.mock.calls.some((call) => Number(call[1]) > 0x7ffff000)).toBe(true);
        expect(session.owner.getState()).toBe('success');
        await session.close();
        expect(store.state.closes).toBe(1);
    });
});

describe('explicit account persistence runner', () => {
    it('waits for durable save, then restores on a new connection without QR or replay', async () => {
        const f = await fixture();
        const store = fakeAccountStore();

        if (process.platform === 'linux') {
            const dir = await mkdtemp(path.join(os.homedir(), '.jiyu-direct-fixture-'));
            directories.push(dir);
            f.config.statePath = path.join(dir, 'device.json');
        }

        const gate = deferred();
        store.state.saveGate = gate.promise;
        const events: LoginEvent[] = [];
        const paths = persistencePaths(path.dirname(f.config.statePath));
        const login = startDirectLogin(
            f.config,
            (event) => events.push(event),
            undefined,
            undefined,
            paths,
        );
        await store.state.saveStarted.promise;
        expect(events.some((event) => event.state === 'online')).toBe(false);
        gate.resolve();
        const first = await login;
        sessions.push(first);
        expect(events.findIndex((event) => event.state === 'account-saved')).toBeLessThan(
            events.findIndex((event) => event.state === 'online'),
        );
        expect(store.state.saves).toBe(1);
        await first.close();
        const initialCommands = f.commands.length;
        const restoredEvents: LoginEvent[] = [];
        f.config.outDir = path.join(path.dirname(f.config.statePath), 'unused-restored-qr');
        const second = await restoreDirectLogin(f.config, { ...paths, uin: '123' }, (event) =>
            restoredEvents.push(event),
        );
        sessions.push(second);
        expect(second.confirmedUin).toBe('123');
        expect(second.owner.getState()).toBe('success');
        expect('qrImage' in second).toBe(false);
        expect('fetch' in second.owner || 'poll' in second.owner).toBe(false);
        expect(f.commands.slice(initialCommands)).toEqual([SSO_INFO_SYNC_COMMAND]);
        expect(store.state.saves).toBe(1);
        expect(store.open.mock.calls.map(([options]) => options.initialize)).toEqual([true, false]);
        expect(restoredEvents.some((event) => event.qrImage || event.state === 'fetching')).toBe(
            false,
        );
        expect(JSON.stringify(restoredEvents)).not.toContain('synthetic-private-uid');
        await expect(stat(f.config.outDir)).rejects.toMatchObject({ code: 'ENOENT' });
        await second.close();
        expect(store.state.closes).toBe(2);
        expect(f.errors).toEqual([]);
    });

    it('does not call a decrypted account online before the new registration response', async () => {
        const gate = deferred();
        const f = await fixture({ registerGate: gate.promise });
        const store = fakeAccountStore();
        await seedAccount(f, store);
        const events: LoginEvent[] = [];
        const pending = restoreDirectLogin(
            f.config,
            { ...persistencePaths(path.dirname(f.config.statePath)), uin: '123' },
            (event) => events.push(event),
        );
        await f.registrationStarted;
        expect(events.some((event) => event.state === 'online')).toBe(false);
        gate.resolve();
        const session = await pending;
        sessions.push(session);
        expect(f.commands).toEqual([SSO_INFO_SYNC_COMMAND]);
        expect(events.at(-1)?.state).toBe('online');
    });

    it('accepts protocol 13 MsgPush after restore with no outstanding transaction', async () => {
        const f = await fixture();
        const store = fakeAccountStore();
        await seedAccount(f, store);
        const bodies: Uint8Array[] = [];
        const session = await restoreDirectLogin(
            f.config,
            { ...persistencePaths(path.dirname(f.config.statePath)), uin: '123' },
            undefined,
            undefined,
            {
                maxPushBodyBytes: 1024,
                onPushBody: (body) => {
                    bodies.push(Uint8Array.from(body));
                },
            },
        );
        sessions.push(session);
        const expected = messageBody();
        f.sendFrames(pushFrame(expected, { protocol: 13 }));
        await vi.waitFor(() => expect(bodies).toHaveLength(1));
        expect(bodies[0]).toEqual(expected);
        expect(session.owner.getState()).toBe('success');
        expect(f.commands).toEqual([SSO_INFO_SYNC_COMMAND]);
        expect(f.errors).toEqual([]);
    });

    it('keeps saved credentials after a rejected registration and never falls back to QR', async () => {
        const f = await fixture({ registration: 'register denied' });
        const store = fakeAccountStore();
        await seedAccount(f, store);
        const previous = Uint8Array.from(store.state.payload!);
        const events: LoginEvent[] = [];
        await expect(
            restoreDirectLogin(
                f.config,
                { ...persistencePaths(path.dirname(f.config.statePath)), uin: '123' },
                (event) => events.push(event),
            ),
        ).rejects.toThrow();
        expect(f.commands).toEqual([SSO_INFO_SYNC_COMMAND]);
        expect(store.state.payload).toEqual(previous);
        expect(store.state.saves).toBe(0);
        expect(events.some((event) => event.state === 'online' || event.state === 'qr-ready')).toBe(
            false,
        );
    });

    it.each(['missing', 'revoked', 'malformed', 'binding'] as const)(
        'fails %s local credentials before starting a signer or connection',
        async (mode) => {
            const f = await fixture();
            const store = fakeAccountStore();
            await seedAccount(f, store);

            if (mode === 'missing') {
                store.state.payload = undefined;
            }

            if (mode === 'revoked') {
                store.state.revoked = true;
            }

            if (mode === 'malformed') {
                store.state.payload = Uint8Array.of(1);
            }

            if (mode === 'binding') {
                f.config.profile.deviceName = 'different-profile';
            }

            await expect(
                restoreDirectLogin(f.config, {
                    ...persistencePaths(path.dirname(f.config.statePath)),
                    uin: '123',
                }),
            ).rejects.toThrow();
            expect(children).toHaveLength(0);
            expect(f.commands).toEqual([]);
            expect(store.state.saves).toBe(0);
            expect(store.state.closes).toBe(1);
        },
    );

    it('fails a checkpoint once without reporting online or retrying the save', async () => {
        const f = await fixture();
        const store = fakeAccountStore();
        store.state.saveError = new accountVault.AccountVaultError('commit-uncertain');
        const events: LoginEvent[] = [];
        await expect(
            startDirectLogin(
                f.config,
                (event) => events.push(event),
                undefined,
                undefined,
                persistencePaths(path.dirname(f.config.statePath)),
            ),
        ).rejects.toThrow();
        expect(store.state.saves).toBe(1);
        expect(events.some((event) => event.state === 'online')).toBe(false);
        expect(events.find((event) => event.state === 'failed')?.code).toBe(
            'account-store-commit-uncertain',
        );
        expect(store.state.closes).toBe(1);
    });

    it('drains a late vault acquisition after cancellation without touching GUID or QR paths', async () => {
        const f = await fixture();
        const store = fakeAccountStore();
        const create = store.open.getMockImplementation()!;
        const gate = deferred();
        const started = deferred();
        store.open.mockImplementation(async (options) => {
            started.resolve();
            await gate.promise;
            return create(options);
        });
        const stop = new AbortController();
        const pending = startDirectLogin(
            f.config,
            undefined,
            stop.signal,
            undefined,
            persistencePaths(f.dir),
        );
        const rejected = expect(pending).rejects.toMatchObject({ code: 'aborted' });
        await started.promise;
        stop.abort();
        gate.resolve();
        await rejected;
        expect(store.state.closes).toBe(1);
        expect(children).toHaveLength(0);
        expect(f.connections).toBe(0);
        await expect(stat(f.config.statePath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(f.config.outDir)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('waits for a cancelled checkpoint to drain and never publishes online', async () => {
        const f = await fixture();
        const store = fakeAccountStore();
        const gate = deferred();
        store.state.saveGate = gate.promise;
        const stop = new AbortController();
        const events: LoginEvent[] = [];
        const pending = startDirectLogin(
            f.config,
            (event) => events.push(event),
            stop.signal,
            undefined,
            persistencePaths(f.dir),
        );
        let settled = false;
        void pending.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        const rejected = expect(pending).rejects.toThrow();
        await store.state.saveStarted.promise;
        stop.abort();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        gate.resolve();
        await rejected;
        expect(store.state.payload).toBeUndefined();
        expect(store.state.saves).toBe(1);
        expect(store.state.closes).toBe(1);
        expect(events.some((event) => event.state === 'online')).toBe(false);
        expect(closed.has(children[0])).toBe(true);
    });

    it('reports failed store close only after the signer and connection have drained', async () => {
        const f = await fixture();
        const store = fakeAccountStore();
        await seedAccount(f, store);
        const events: LoginEvent[] = [];
        const session = await restoreDirectLogin(
            f.config,
            { ...persistencePaths(f.dir), uin: '123' },
            (event) => events.push(event),
        );
        store.state.closeError = new accountVault.AccountVaultError('io');
        await expect(session.close()).rejects.toMatchObject({ code: 'account-store-io' });
        await expect(session.whenClosed).rejects.toMatchObject({ code: 'account-store-io' });
        expect(closed.has(children[0])).toBe(true);
        expect(events.at(-1)).toMatchObject({ state: 'failed', code: 'account-store-io' });
        expect(events.some((event) => event.state === 'closed')).toBe(false);
    });

    it('keeps the original memory-only path free of vault operations', async () => {
        const f = await fixture();
        const store = fakeAccountStore();
        const session = await startDirectLogin(f.config);
        sessions.push(session);
        expect(store.open).not.toHaveBeenCalled();
    });

    it.skipIf(process.platform === 'linux')(
        'rejects unsupported persistence before creating the device or QR paths',
        async () => {
            const f = await fixture();
            await expect(
                startDirectLogin(
                    f.config,
                    undefined,
                    undefined,
                    undefined,
                    persistencePaths(path.dirname(f.config.statePath)),
                ),
            ).rejects.toMatchObject({ code: 'account-store-platform-unsupported' });
            await expect(stat(f.config.statePath)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(stat(f.config.outDir)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(children).toHaveLength(0);
        },
    );

    it('parses explicit save/restore options without enabling them for legacy arguments', () => {
        const flags = [
            '--account-vault',
            path.resolve('vault'),
            '--account-keys',
            path.resolve('keys'),
            '--account-slot',
            '01'.repeat(16),
        ];
        expect(parseCliOptions(['--config', 'config.json']).mode).toEqual({ kind: 'qr' });
        expect(
            parseCliOptions(['--config', 'config.json', '--save-account', ...flags]).mode.kind,
        ).toBe('qr');
        expect(
            parseCliOptions(['--config', 'config.json', '--restore-account', '123', ...flags]).mode
                .kind,
        ).toBe('restore');

        for (const tail of [
            flags,
            ['--save-account'],
            ['--restore-account', '123'],
            ['--save-account', '--restore-account', '123', ...flags],
            ['--save-account', '--save-account', ...flags],
            ['--restore-account', '0', ...flags],
        ]) {
            expect(() => parseCliOptions(['--config', 'config.json', ...tail])).toThrow();
        }
    });
});

describe('explicit direct login runner', () => {
    it('preserves an expired QR result when the owner closes before the poll continuation', async () => {
        const f = await fixture({ terminalPoll: 17 });
        const events: LoginEvent[] = [];
        await expect(
            startDirectLogin(f.config, (event) => events.push(event)),
        ).rejects.toMatchObject({ code: 'qr-expired' });
        expect(events.find((event) => event.state === 'failed')?.code).toBe('qr-expired');
        expect(
            events.some((event) => event.state === 'confirmed' || event.state === 'online'),
        ).toBe(false);
        expect(closed.has(children[0])).toBe(true);
    });

    it('imports with no process/network effects and validates every profile provenance field', async () => {
        const dir = await directory();
        const valid = configuration(dir, 8080);
        await import('./cli');
        expect(children).toHaveLength(0);
        const missing = { ...valid, provenance: {} };
        expect(() => parseConfig(missing, dir)).toThrow('configuration');

        for (const onlineHoldMs of [0, 60000, 60001, 900000]) {
            expect(parseConfig({ ...valid, onlineHoldMs }, dir).onlineHoldMs).toBe(onlineHoldMs);
        }

        for (const onlineHoldMs of [-1, 1.5, 900001, Infinity, NaN]) {
            expect(() => parseConfig({ ...valid, onlineHoldMs }, dir)).toThrow('configuration');
        }

        const example = JSON.parse(
            await readFile(new URL('./config.example.json', import.meta.url), 'utf8'),
        );
        expect(parseConfig(example, dir).onlineHoldMs).toBe(15000);
        expect(() =>
            parseConfig({ ...valid, signer: { ...valid.signer, initialUin: '123' } }, dir),
        ).toThrow('configuration');
        const file = path.join(dir, 'private.json');
        await writeFile(file, JSON.stringify(valid), { mode: 0o600 });
        expect((await readConfig(file)).gateway).toEqual(valid.gateway);
    });
    it('validates the opt-in body limit and callback before any login effects', async () => {
        const dir = await directory();
        const config = configuration(dir, 9);
        const onEvent = vi.fn();
        const invalid: unknown[] = [
            null,
            [],
            {},
            { maxPushBodyBytes: 1 },
            { onPushBody: () => {} },
        ];

        for (const maxPushBodyBytes of [0, -1, 0.5, NaN, Infinity, 2 * 1024 * 1024 + 1]) {
            invalid.push({ maxPushBodyBytes, onPushBody: () => {} });
        }

        invalid.push({ maxPushBodyBytes: 1, onPushBody: true });

        for (const options of invalid) {
            await expect(
                startDirectLogin(config, onEvent, undefined, options as DirectLoginPushOptions),
            ).rejects.toThrow('configuration');
        }

        await expect(
            startDirectLogin({ ...config, onlineHoldMs: 900001 }, onEvent),
        ).rejects.toThrow('configuration');
        expect(onEvent).not.toHaveBeenCalled();
        expect(children).toHaveLength(0);
        await expect(stat(config.outDir)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('persists one random 16-byte GUID and only saves private images under the requested directory', async () => {
        const dir = await directory();
        const file = path.join(dir, 'device.json');
        const first = await loadDeviceGuid(file);
        const second = await loadDeviceGuid(file);
        expect(first).toHaveLength(16);
        expect(first).toEqual(second);
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
            version: 1,
            guid: Buffer.from(first).toString('hex'),
        });
        const out = path.join(dir, 'qr');
        await prepareQrDirectory(out);
        const image = await saveQrImage(out, png);
        expect(path.dirname(image)).toBe(out);
        expect(await readFile(image)).toEqual(png);

        if (process.platform !== 'win32') {
            expect((await stat(image)).mode & 0o777).toBe(0o600);
        }

        await expect(saveQrImage(out, Buffer.from('not an image'))).rejects.toThrow('qr-image');
        await writeFile(file, '{"version":1,"guid":"bad"}');
        await expect(loadDeviceGuid(file)).rejects.toThrow('private-state');
    });
    it('runs fetch, 2-second polling, confirmed login and registration on one signed connection', async () => {
        const f = await fixture({ wait: true });
        const events: LoginEvent[] = [];
        const started = performance.now();
        const session = await startDirectLogin(f.config, (event) => events.push(event)).catch(
            (error) => {
                expect(f.errors).toEqual([]);
                throw error;
            },
        );
        sessions.push(session);
        expect(performance.now() - started).toBeGreaterThanOrEqual(3900);
        expect(f.errors).toEqual([]);
        expect(f.connections).toBe(1);
        expect(f.commands).toEqual([
            'fixture.qr',
            'fixture.qr',
            'fixture.qr',
            'fixture.login',
            SSO_INFO_SYNC_COMMAND,
        ]);
        expect(f.accounts).toEqual(['0', '0', '0', '123', '123']);
        expect(new Set(f.points).size).toBe(1);
        expect(session.confirmedUin).toBe('123');
        expect(session.owner.getState()).toBe('success');
        expect(events.map((event) => event.state)).toEqual([
            'starting',
            'connecting',
            'fetching',
            'qr-ready',
            'waiting-scan',
            'confirmed',
            'registering',
            'online',
        ]);
        expect(await readFile(session.qrImage)).toEqual(png);
        expect(JSON.stringify(events)).not.toContain('synthetic-private-uid');
        expect(JSON.stringify(events)).not.toContain('example.invalid');
        expect(children).toHaveLength(1);
        expect(closed.has(children[0])).toBe(false);
        await session.close();
        expect(closed.has(children[0])).toBe(true);
        expect(events.at(-1)?.state).toBe('closed');
        expect(events.at(-1)?.io).toMatchObject({ writeCalls: 5, receivedFrames: 5 });
        expect(events.at(-1)?.io?.socketBytesRead).toBeGreaterThan(0);
    });
    it.each([
        ['missing', new Uint8Array()],
        ['wrong', Uint8Array.of(4)],
        ['duplicate', Uint8Array.of(3, 3)],
    ] as const)(
        'rejects a %s Code2d terminator without weakening TLV boundaries',
        async (_, qrTrailer) => {
            const f = await fixture({ qrTrailer });
            const events: LoginEvent[] = [];
            await expect(
                startDirectLogin(f.config, (event) => events.push(event)),
            ).rejects.toThrow();
            expect(
                events.some((event) => event.state === 'qr-ready' || event.state === 'online'),
            ).toBe(false);
            expect(events.find((event) => event.state === 'failed')?.phase).toBe('fetching');
            expect(closed.has(children[0])).toBe(true);
        },
    );

    it('rejects a real socket response with the wrong outer account before online', async () => {
        const f = await fixture({ wrongOuter: true });
        const events: LoginEvent[] = [];
        await expect(startDirectLogin(f.config, (event) => events.push(event))).rejects.toThrow();
        expect(events.some((event) => event.state === 'online')).toBe(false);
        expect(events.some((event) => event.state === 'failed')).toBe(true);
        expect(closed.has(children[0])).toBe(true);
    });
    it('does not call a rejected registration online', async () => {
        const f = await fixture({
            registration: 'not successful',
            beforeRegisterPush: pushFrame(messageBody()),
        });
        const events: LoginEvent[] = [];
        const onPushBody = vi.fn();
        await expect(
            startDirectLogin(f.config, (event) => events.push(event), undefined, {
                maxPushBodyBytes: 65536,
                onPushBody,
            }),
        ).rejects.toThrow('login-rejected');
        expect(onPushBody).not.toHaveBeenCalled();
        expect(events.some((event) => event.state === 'online')).toBe(false);
        expect(f.errors).toEqual([]);
        expect(closed.has(children[0])).toBe(true);
    });
    it('cancels after displaying QR and drains the native child and TCP socket', async () => {
        const f = await fixture();
        const abort = new AbortController();
        await expect(
            startDirectLogin(
                f.config,
                (event) => {
                    if (event.state === 'qr-ready') {
                        abort.abort();
                    }
                },
                abort.signal,
            ),
        ).rejects.toThrow();
        expect(f.commands).toEqual(['fixture.qr']);
        expect(closed.has(children[0])).toBe(true);
    });
    it('waits for an in-flight signer startup before reporting physical closure', async () => {
        const f = await fixture();
        const abort = new AbortController();
        const checks: boolean[] = [];
        f.config.signer.args = [
            '-e',
            worker.replace(
                `send(${JSON.stringify(ready)});`,
                `setTimeout(()=>send(${JSON.stringify(ready)}),150);`,
            ),
        ];
        onChildSpawn = () => queueMicrotask(() => abort.abort());
        await expect(
            startDirectLogin(
                f.config,
                (event) => {
                    if (event.state === 'closed') {
                        checks.push(children.length === 1 && closed.has(children[0]));
                    }
                },
                abort.signal,
            ),
        ).rejects.toThrow();
        expect(checks).toEqual([true]);
        expect(f.connections).toBe(0);
    });
    it('waits for a canceled connection acquisition before reporting closed', async () => {
        const f = await fixture();
        const abort = new AbortController();
        let physicallyClosed = false;
        const checks: boolean[] = [];
        const original = Socket.prototype.connect;
        vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (
            this: Socket,
            ...args: unknown[]
        ) {
            this.once('close', () => {
                physicallyClosed = true;
            });
            const result = Reflect.apply(original, this, args) as Socket;
            queueMicrotask(() => abort.abort());
            return result;
        });
        await expect(
            startDirectLogin(
                f.config,
                (event) => {
                    if (event.state === 'closed') {
                        checks.push(physicallyClosed && closed.has(children[0]));
                    }
                },
                abort.signal,
            ),
        ).rejects.toThrow();
        expect(checks).toEqual([true]);
    });
    it('forwards a socket drain event and removes the forwarding listener on close', async () => {
        const server = createServer((socket) => {
            sockets.add(socket);
            socket.on('error', () => {});
            socket.once('close', () => sockets.delete(socket));
        });
        servers.push(server);
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();

        if (!address || typeof address === 'string') {
            throw new Error('fixture');
        }

        const socket = new Socket();
        socket.connect({ host: '127.0.0.1', port: address.port });
        await once(socket, 'connect');
        const observed = new ObservedConnection(socket);
        let drains = 0;
        observed.on('drain', () => {
            drains++;
        });
        vi.spyOn(socket, 'write').mockReturnValueOnce(false);
        expect(observed.write(Uint8Array.of(1), () => {})).toBe(false);
        socket.emit('drain');
        expect(drains).toBe(1);
        observed.destroy();
        await observed.whenClosed;
        expect(socket.listenerCount('drain')).toBe(0);
    });
    it('reports a silent-peer transaction timeout with bounded transport counters', async () => {
        const f = await fixture({ silent: true });
        f.config.attemptTimeoutMs = 5000;
        f.config.transactionTimeoutMs = 500;
        const events: LoginEvent[] = [];
        await expect(startDirectLogin(f.config, (event) => events.push(event))).rejects.toThrow();
        const terminal = events.find((event) => event.state === 'closed');
        // The WT transaction deadline can cancel the inner raw request before its own timer fires.
        expect(['raw-cancelled', 'raw-timeout']).toContain(terminal?.transportClose);
        expect(terminal?.io).toMatchObject({
            writeCalls: 1,
            receivedFrames: 0,
            socketBytesRead: 0,
        });
        expect(terminal?.io?.socketBytesWritten).toBeGreaterThan(0);
        expect(JSON.stringify(events)).not.toContain('bodyHash');
        expect(closed.has(children[0])).toBe(true);
    });

    it('bounds the whole attempt even when a peer never answers', async () => {
        const f = await fixture({ silent: true });
        f.config.attemptTimeoutMs = 1000;
        f.config.transactionTimeoutMs = 3000;
        await expect(startDirectLogin(f.config)).rejects.toThrow('attempt-timeout');
        expect(closed.has(children[0])).toBe(true);
    });
    it('schedules a fifteen-minute hold while the old three-argument call keeps pushes private', async () => {
        const f = await fixture();
        f.config.onlineHoldMs = 900000;
        const timers = vi.spyOn(globalThis, 'setTimeout');
        const verified = vi.spyOn(ObservedConnection.prototype, 'takeReceived');
        const abort = new AbortController();
        const events: LoginEvent[] = [];
        const session = await startDirectLogin(
            f.config,
            (event) => {
                events.push(event);
                // A caller's later mutation must not shorten this attempt's snapshot.
                f.config.onlineHoldMs = 0;
            },
            abort.signal,
        );
        sessions.push(session);
        expect(timers.mock.calls.some((call) => call[1] === 900000)).toBe(true);
        const before = verified.mock.calls.length;
        f.sendFrames(pushFrame(messageBody()));
        await vi.waitFor(() => expect(verified.mock.calls).toHaveLength(before + 1));
        expect(verified.mock.results.at(-1)?.value).toBe(true);
        expect(session.owner.getState()).toBe('success');
        expect(closed.has(children[0])).toBe(false);
        expect(JSON.stringify(events)).not.toContain(pushText);
        expect(f.commands).toEqual([
            'fixture.qr',
            'fixture.qr',
            'fixture.login',
            SSO_INFO_SYNC_COMMAND,
        ]);
        abort.abort();
        await session.whenClosed;
        await f.disconnected;
        expect(closed.has(children[0])).toBe(true);
        expect(f.errors).toEqual([]);
    });

    it.each([
        { command: 'trpc.msg.register_proxy.RegisterProxy.InfoSyncPush', protocol: 12 as const },
        { command: 'trpc.msg.register_proxy.RegisterProxy.PushParams', protocol: 12 as const },
        { command: 'ConfigPushSvc.PushReq', protocol: 13 as const },
        { command: 'ConfigPushSvc.PushReq', protocol: 12 as const },
    ])(
        'delivers $command on protocol $protocol through the same policy',
        async ({ command, protocol }) => {
            const body = Uint8Array.of(8, 1);
            const f = await fixture({ beforeRegisterPush: pushFrame(body, { command, protocol }) });
            const received: Array<{
                body: Uint8Array;
                meta: Parameters<DirectLoginPushOptions['onPushBody']>[1];
            }> = [];
            let borrowed: Uint8Array | undefined;
            const session = await startDirectLogin(f.config, () => {}, undefined, {
                maxPushBodyBytes: 1024,
                onPushBody(bytes, meta) {
                    borrowed = bytes;
                    received.push({ body: Uint8Array.from(bytes), meta });
                },
            });
            sessions.push(session);
            await vi.waitFor(() => expect(received).toHaveLength(1));
            expect(received[0]).toEqual({
                body,
                meta: { uin: '123', sequence: 71, command, retCode: 0 },
            });
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(borrowed?.every((byte) => byte === 0)).toBe(true);
            expect(session.owner.getState()).toBe('success');
            await session.close();
            await f.disconnected;
            expect(f.errors).toEqual([]);
        },
    );

    it.each([12, 13] as const)(
        'delivers protocol %s protobuf pushes serially only after successful registration',
        async (protocol) => {
            const registerGate = deferred();
            const deliveryGate = deferred();
            const first = messageBody(71);
            const second = messageBody(72);
            const f = await fixture({
                registerGate: registerGate.promise,
                beforeRegisterPush: Buffer.concat([
                    pushFrame(first, { protocol }),
                    pushFrame(second, { sequence: 72, protocol }),
                ]),
            });
            const events: LoginEvent[] = [];
            const borrowed: Uint8Array[] = [];
            const received: Array<{
                body: Uint8Array;
                meta: Parameters<DirectLoginPushOptions['onPushBody']>[1];
                phase: string | undefined;
                frozen: boolean;
            }> = [];
            const pending = startDirectLogin(f.config, (event) => events.push(event), undefined, {
                maxPushBodyBytes: 2 * 1024 * 1024,
                onPushBody: async (body, meta) => {
                    borrowed.push(body);
                    received.push({
                        body: Uint8Array.from(body),
                        meta,
                        phase: events.at(-1)?.state,
                        frozen: Object.isFrozen(meta),
                    });

                    if (received.length === 1) {
                        await deliveryGate.promise;
                    }
                },
            });

            try {
                await f.registrationStarted;
                expect(received).toEqual([]);
                expect(events.some((event) => event.state === 'online')).toBe(false);
            } finally {
                registerGate.resolve();
            }

            const session = await pending;
            sessions.push(session);

            try {
                await vi.waitFor(() => expect(received).toHaveLength(1));
                await new Promise<void>((resolve) => setImmediate(resolve));
                expect(received).toHaveLength(1);
            } finally {
                deliveryGate.resolve();
            }

            await vi.waitFor(() => expect(received).toHaveLength(2));
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(received).toEqual([
                {
                    body: first,
                    meta: { uin: '123', sequence: 71, command: pushCommand, retCode: 0 },
                    phase: 'online',
                    frozen: true,
                },
                {
                    body: second,
                    meta: { uin: '123', sequence: 72, command: pushCommand, retCode: 0 },
                    phase: 'online',
                    frozen: true,
                },
            ]);
            expect(borrowed.every((body) => body.every((byte) => byte === 0))).toBe(true);
            expect(
                protobuf_decode<PushMsg>(received[0].body).message?.body?.richText?.elems?.[0]?.text
                    ?.str,
            ).toBe(pushText);
            expect(JSON.stringify(events)).not.toContain(pushText);
            expect(session.owner.getState()).toBe('success');
            await session.close();
            await f.disconnected;
            expect(f.errors).toEqual([]);
        },
    );

    it.each([
        ['wrong account', Uint8Array.of(1, 2, 3), { uin: '999' }, 3],
        ['oversized body', Uint8Array.of(1, 2, 3, 4), {}, 3],
        ['oversized inflated body', new Uint8Array(2048).fill(65), { compressed: true }, 64],
    ] as const)(
        'closes on %s without delivering its body',
        async (_, body, options, maxPushBodyBytes) => {
            const f = await fixture();
            const onPushBody = vi.fn();
            const session = await startDirectLogin(f.config, undefined, undefined, {
                maxPushBodyBytes,
                onPushBody,
            });
            sessions.push(session);
            f.sendFrames(pushFrame(body, options));
            await vi.waitFor(() => expect(closed.has(children[0])).toBe(true), { timeout: 3000 });
            await session.whenClosed;
            await f.disconnected;
            expect(onPushBody).not.toHaveBeenCalled();
            expect(session.owner.getState()).toBe('closed');
            expect(f.errors).toEqual([]);
        },
    );

    it.each(['throw', 'reject', 'close'] as const)(
        'wipes the borrowed body and drains resources when its callback chooses %s',
        async (mode) => {
            const f = await fixture();
            const events: LoginEvent[] = [];
            const borrowed: Uint8Array[] = [];
            let session!: DirectLoginController;
            session = await startDirectLogin(f.config, (event) => events.push(event), undefined, {
                maxPushBodyBytes: 3,
                onPushBody: (body) => {
                    borrowed.push(body);

                    if (mode === 'throw') {
                        throw new Error(pushText);
                    }

                    if (mode === 'reject') {
                        return Promise.reject(new Error(pushText));
                    }

                    return session.close();
                },
            });
            sessions.push(session);
            f.sendFrames(
                pushFrame(Uint8Array.of(1, 2, 3)),
                pushFrame(Uint8Array.of(4, 5, 6), { sequence: 72 }),
            );
            await vi.waitFor(() => expect(closed.has(children[0])).toBe(true), { timeout: 3000 });
            await session.whenClosed;
            await f.disconnected;
            expect(borrowed).toHaveLength(1);
            expect(borrowed[0]).toEqual(new Uint8Array(3));
            expect(events.filter((event) => event.state === 'closed')).toHaveLength(1);
            expect(JSON.stringify(events)).not.toContain(pushText);
            expect(session.owner.getState()).toBe('closed');
            expect(f.errors).toEqual([]);
        },
    );

    it('returns an online owner and automatically closes after the explicit short holding window', async () => {
        const f = await fixture();
        f.config.onlineHoldMs = 100;
        const session = await startDirectLogin(f.config);
        sessions.push(session);
        expect(session.owner.getState()).toBe('success');
        await session.whenClosed;
        expect(closed.has(children[0])).toBe(true);
        expect(f.commands).toEqual([
            'fixture.qr',
            'fixture.qr',
            'fixture.login',
            SSO_INFO_SYNC_COMMAND,
        ]);
    });
});
