import { once } from 'node:events';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createWtEcdh } from '../../src/direct/wt-ecdh';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { ServiceFrameDecoder } from '../../src/direct/service-stream';
import { encodeWtQrD1 } from '../../src/direct/wt-qr-protobuf';
import { encodeWtTlv } from '../../src/direct/wt-tlv';
import {
    WtReferenceLoginAttempt,
    type WtReferenceLoginAttemptOptions,
} from '../../src/direct/wt-reference-login-attempt';

// Synthetic loopback fixtures only, including all keys and identities. Tests use
// the package Vitest configuration and its real Proton transformation plugin.
const peer = createWtEcdh(Buffer.concat([Buffer.alloc(23), Buffer.of(2)]));
const ticketKey = new Uint8Array(16).fill(4);
const attempts: WtReferenceLoginAttempt[] = [];
const sockets: Socket[] = [];
const servers: Server[] = [];

const be32 = (value: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(value >>> 0);
    return b;
};

const field = (b: Uint8Array) => Buffer.concat([be32(b.length + 4), b]);
const fetchBusiness = () =>
    Buffer.concat([
        Buffer.from([0, 0, 0, 0, 0, 42, 0, 0, 3, 1, 2, 3]),
        encodeWtTlv([
            { tag: 0x17, value: Uint8Array.of(7, 8) },
            { tag: 0xd1, value: encodeWtQrD1({ qrUrl: 'https://example.invalid/qr' }) },
        ]),
    ]);

function confirmation(uin = 123n) {
    const identity = Buffer.alloc(12);
    identity.writeBigInt64BE(uin);
    return Buffer.concat([
        Buffer.from([0, 0, 0, 0, 0, 42, 0]),
        identity,
        encodeWtTlv([
            { tag: 0x1e, value: ticketKey },
            { tag: 0x19, value: Uint8Array.of(5) },
            { tag: 0x18, value: Uint8Array.of(6) },
        ]),
    ]);
}

function loginBusiness() {
    return Buffer.concat([
        Buffer.of(0, 9, 0),
        encodeWtTlv([
            {
                tag: 0x119,
                value: qqTeaEncrypt(
                    encodeWtTlv([
                        { tag: 0x143, value: Uint8Array.of(9) },
                        { tag: 0x305, value: new Uint8Array(16).fill(10) },
                        { tag: 0x10a, value: Uint8Array.of(11) },
                        { tag: 0x106, value: Uint8Array.of(12) },
                    ]),
                    ticketKey,
                ),
            },
        ]),
    ]);
}

function parseRequest(frame: Uint8Array) {
    const b = Buffer.from(frame);
    const start = 10 + b.readUInt32BE(9);
    const end = start + b.readUInt32BE(start);
    const account = b.subarray(start + 4, end).toString();
    const sso = Buffer.from(qqTeaDecrypt(b.subarray(end), new Uint8Array(16)));
    let offset = 28;

    const read = () => {
        const size = sso.readUInt32BE(offset);
        const result = sso.subarray(offset + 4, offset + size);
        offset += size;
        return result;
    };

    read();
    const command = read().toString();
    const oicq = sso.subarray(sso.readUInt32BE(0) + 4);
    const shared = peer.deriveTeaKey(oicq.subarray(48, 73));
    const business = Buffer.from(qqTeaDecrypt(oicq.subarray(73, -1), shared));
    const kind = oicq.readUInt16BE(5) === 0x810 ? 0x810 : business.readUInt16BE(21);
    return { account, command, sequence: sso.readUInt32BE(4), shared, kind };
}

type Request = ReturnType<typeof parseRequest>;
type Override = {
    ssoSequence?: number;
    ssoCommand?: string;
    oicqCommand?: number;
    oicqUin?: number;
};

function makeResponse(req: Request, business: Uint8Array, override: Override = {}) {
    let body: Uint8Array = business;

    if (req.kind !== 0x810) {
        const layer = Buffer.alloc(43);
        layer.writeUInt16BE(req.kind, 3);
        const code2d = Buffer.concat([layer, business]);
        body = Buffer.concat([Buffer.of(0, 0, code2d.length >> 8, code2d.length & 255, 0), code2d]);
    }

    const cipher = qqTeaEncrypt(body, req.shared);
    const wt = Buffer.alloc(17 + cipher.length);
    wt[0] = 2;
    wt.writeUInt16BE(wt.length, 1);
    wt.writeUInt16BE(override.oicqCommand ?? (req.kind === 0x810 ? 0x810 : 0x812), 5);
    wt.writeUInt32BE(override.oicqUin ?? (req.kind === 0x810 ? 123 : 0), 9);
    wt.set(cipher, 16);
    wt[wt.length - 1] = 3;
    const sso = Buffer.concat([
        field(
            Buffer.concat([
                be32(override.ssoSequence ?? req.sequence),
                be32(0),
                field(Buffer.alloc(0)),
                field(Buffer.from(override.ssoCommand ?? req.command)),
                field(Buffer.alloc(0)),
                be32(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(wt),
    ]);
    const encrypted = qqTeaEncrypt(sso, new Uint8Array(16));
    const account = Buffer.from(req.account);
    return Buffer.concat([
        be32(14 + account.length + encrypted.length),
        be32(12),
        Buffer.of(2, 0),
        field(account),
        encrypted,
    ]);
}

const fetchFields = {
    packageName: 'p',
    ptVersion: 'v',
    miscBitMap: 1,
    ssoVersion: 1,
    d1: Uint8Array.of(1),
};
const loginFields = {
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

async function setup(
    handler: (socket: Socket, req: Request) => void,
    overrides: Partial<WtReferenceLoginAttemptOptions> = {},
) {
    const received: Request[] = [];
    const server = createServer((socket) => {
        sockets.push(socket);
        const decoder = new ServiceFrameDecoder();
        socket.on('data', (data) => {
            for (const frame of decoder.push(data)) {
                const req = parseRequest(frame);
                received.push(req);
                handler(socket, req);
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

    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    sockets.push(socket);
    await once(socket, 'connect');
    const options: WtReferenceLoginAttemptOptions = {
        socket,
        profile: {
            uin: '999',
            appId: 42,
            subAppId: 43,
            clientVersion: 44,
            guid: Uint8Array.of(1, 2),
            unknown21: new Uint8Array(21),
            randomKey: new Uint8Array(16).fill(7),
            peerPublicKey: peer.publicKey,
            ssoVersion: 'v',
            qrCommand: 'fixture.qr',
            loginCommand: 'fixture.login',
        },
        timeoutMs: 250,
        attemptTimeoutMs: 3000,
        getTimestamp: () => 10,
        buildReserved: async () => new Uint8Array(),
        verifyRaw: () => true,
        verifyContext: () => true,
        sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
        ...overrides,
    };
    const attempt = new WtReferenceLoginAttempt(options);
    attempts.push(attempt);
    return { attempt, received, options, socket };
}

afterEach(async () => {
    for (const attempt of attempts.splice(0)) {
        attempt.close();
    }

    for (const socket of sockets.splice(0)) {
        socket.destroy();
    }

    await Promise.all(
        servers
            .splice(0)
            .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
});

describe('reference attempt adversarial bindings (synthetic loopback)', () => {
    it.each(['sequence', 'command'] as const)('rejects mismatched SSO %s', async (which) => {
        const { attempt, received } = await setup((socket, req) => {
            const wrong =
                which === 'sequence'
                    ? { ssoSequence: req.sequence + 1 }
                    : { ssoCommand: 'fixture.wrong' };
            socket.write(makeResponse(req, fetchBusiness(), wrong));
        });
        await expect(attempt.fetch(fetchFields)).rejects.toThrow();
        expect(attempt.getState()).toBe('failed');
        expect(received).toHaveLength(1);
        await expect(attempt.poll()).rejects.toThrow();
    });

    it('accepts the otherwise identical synthetic login response', async () => {
        const { attempt } = await setup((socket, req) => {
            const business =
                req.kind === 0x31
                    ? fetchBusiness()
                    : req.kind === 0x12
                      ? confirmation()
                      : loginBusiness();
            socket.write(makeResponse(req, business));
        });
        await attempt.fetch(fetchFields);
        expect((await attempt.poll()).status).toBe('confirmed');
        expect((await attempt.login(loginFields)).status).toBe('tickets');
    });

    it.each(['uin', 'command'] as const)('rejects mismatched login OICQ %s', async (which) => {
        const { attempt, received } = await setup((socket, req) => {
            const business =
                req.kind === 0x31
                    ? fetchBusiness()
                    : req.kind === 0x12
                      ? confirmation()
                      : loginBusiness();
            const wrong =
                req.kind !== 0x810
                    ? {}
                    : which === 'uin'
                      ? { oicqUin: 124 }
                      : { oicqCommand: 0x811 };
            socket.write(makeResponse(req, business, wrong));
        });
        await attempt.fetch(fetchFields);
        expect((await attempt.poll()).status).toBe('confirmed');
        await expect(attempt.login(loginFields)).rejects.toThrow();
        expect(attempt.getState()).toBe('failed');
        expect(received.map((r) => r.kind)).toEqual([0x31, 0x12, 0x810]);
    });

    it('rejects a confirmed UIN above u32 without sending login', async () => {
        let checked = false;
        const { attempt, received } = await setup(
            (socket, req) =>
                socket.write(
                    makeResponse(
                        req,
                        req.kind === 0x31 ? fetchBusiness() : confirmation(0x100000000n),
                    ),
                ),
            {
                verifyContext: (context) => {
                    if (context.operation === 'poll') {
                        checked = context.businessUin === 0x100000000n;
                    }

                    return true;
                },
            },
        );
        await attempt.fetch(fetchFields);
        await expect(attempt.poll()).rejects.toThrow();
        expect(checked).toBe(true);
        await expect(attempt.login(loginFields)).rejects.toThrow();
        expect(received).toHaveLength(2);
    });

    it('rejects a second owner without disrupting the original socket', async () => {
        const { attempt, options, socket } = await setup((s, req) =>
            s.write(makeResponse(req, fetchBusiness())),
        );
        expect(() => new WtReferenceLoginAttempt(options)).toThrow();
        expect(socket.destroyed).toBe(false);
        expect((await attempt.fetch(fetchFields)).image).toEqual(Uint8Array.of(7, 8));
    });

    it('ignores late async raw verification after abort and writes no follow-up request', async () => {
        const controller = new AbortController();
        let started!: () => void;
        let release!: (value: boolean) => void;
        let finished!: () => void;
        const entered = new Promise<void>((resolve) => {
            started = resolve;
        });
        const blocked = new Promise<boolean>((resolve) => {
            release = resolve;
        });
        const done = new Promise<void>((resolve) => {
            finished = resolve;
        });
        const { attempt, received } = await setup(
            (socket, req) => socket.write(makeResponse(req, fetchBusiness())),
            {
                signal: controller.signal,
                verifyRaw: async () => {
                    started();
                    const result = await blocked;
                    finished();
                    return result;
                },
            },
        );
        const fetch = attempt.fetch(fetchFields);
        const rejection = expect(fetch).rejects.toThrow();
        await entered;
        controller.abort();
        await rejection;
        release(true);
        await done;
        await new Promise<void>((resolve) => setImmediate(resolve));
        await expect(attempt.poll()).rejects.toThrow();
        await expect(attempt.login(loginFields)).rejects.toThrow();
        expect(attempt.getState()).toBe('failed');
        expect(received).toHaveLength(1);
    });
});
