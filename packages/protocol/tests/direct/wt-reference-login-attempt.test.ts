import { once } from 'node:events';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as wtOicq from '../../src/direct/wt-oicq';
import * as qrFrame from '../../src/direct/wt-qr-frame';
import {
    WtReferenceLoginAttempt,
    type WtReferenceLoginAttemptOptions,
} from '../../src/direct/wt-reference-login-attempt';
import { createWtEcdh } from '../../src/direct/wt-ecdh';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { encodeWtTlv, decodeWtTlv } from '../../src/direct/wt-tlv';
import { encodeWtQrD1 } from '../../src/direct/wt-qr-protobuf';
import { ServiceFrameDecoder } from '../../src/direct/service-stream';

const peer = createWtEcdh(Buffer.concat([Buffer.alloc(23), Buffer.of(2)]));
const sockets: Socket[] = [];
const servers: Server[] = [];
const attempts: WtReferenceLoginAttempt[] = [];
const key = new Uint8Array(16).fill(4);

const int = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n | 0);
    return b;
};

const field = (b: Uint8Array) => Buffer.concat([int(b.length + 4), b]);
const header = (code: number) => Buffer.from([0, 0, 0, 0, 0, 42, code]);
const fetchBody = () =>
    Buffer.concat([
        header(0),
        Buffer.from([0, 3, 1, 2, 3]),
        encodeWtTlv([
            { tag: 0x17, value: Uint8Array.of(7, 8) },
            { tag: 0xd1, value: encodeWtQrD1({ qrUrl: 'https://example.invalid/qr' }) },
        ]),
    ]);
const pollBody = (code: number, uin = 123n) =>
    code
        ? header(code)
        : Buffer.concat(
              [
                  header(0),
                  Buffer.from('000000000000000000000000', 'hex'),
                  encodeWtTlv([
                      { tag: 0x1e, value: key },
                      { tag: 0x19, value: Uint8Array.of(5) },
                      { tag: 0x18, value: Uint8Array.of(6) },
                  ]),
              ].map((b, i) => {
                  if (i === 1) {
                      b.writeBigInt64BE(uin);
                  }

                  return b;
              }),
          );

function parse(frame: Uint8Array) {
    const b = Buffer.from(frame);
    const start = 9 + b.readUInt32BE(9) + 1,
        end = start + b.readUInt32BE(start);
    const account = b.subarray(start + 4, end).toString();
    const sso = Buffer.from(qqTeaDecrypt(b.subarray(end), new Uint8Array(16)));
    let pos = 28;

    const read = () => {
        const n = sso.readUInt32BE(pos);
        const v = sso.subarray(pos + 4, pos + n);
        pos += n;
        return v;
    };

    read();
    const command = read().toString();
    read();
    read();
    read();
    pos += sso.readUInt16BE(pos);
    const reserved = Buffer.from(read());
    const oicq = Buffer.from(sso.subarray(sso.readUInt32BE(0) + 4));
    const point = Buffer.from(oicq.subarray(48, 73));
    const shared = peer.deriveTeaKey(point);
    const business = Buffer.from(qqTeaDecrypt(oicq.subarray(73, -1), shared));
    return {
        account,
        seq: sso.readUInt32BE(4),
        command,
        reserved,
        oicq,
        point,
        shared,
        business,
        kind: oicq.readUInt16BE(5) === 0x810 ? 0x810 : business.readUInt16BE(21),
    };
}

type Request = ReturnType<typeof parse>;

function reply(req: Request, business: Uint8Array) {
    let body: Uint8Array = business;

    if (req.kind !== 0x810) {
        const layer = Buffer.alloc(43);
        layer.writeUInt16BE(req.kind, 3);
        layer.writeBigInt64BE(0n, 35);
        const code2d = Buffer.concat([layer, business]);
        body = Buffer.concat([
            Buffer.from([0, 0, code2d.length >> 8, code2d.length & 255, 0]),
            code2d,
        ]);
    }

    const cipher = qqTeaEncrypt(body, req.shared);
    const wt = Buffer.alloc(17 + cipher.length);
    wt[0] = 2;
    wt.writeUInt16BE(wt.length, 1);
    wt.writeUInt16BE(req.kind === 0x810 ? 0x810 : 0x812, 5);
    wt.writeUInt32BE(req.kind === 0x810 ? Number(req.account) : 0, 9);
    wt.set(cipher, 16);
    wt[wt.length - 1] = 3;
    const sso = Buffer.concat([
        field(
            Buffer.concat([
                int(req.seq),
                int(0),
                field(Buffer.alloc(0)),
                field(Buffer.from(req.command)),
                field(Buffer.alloc(0)),
                int(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(wt),
    ]);
    const encrypted = qqTeaEncrypt(sso, new Uint8Array(16));
    const account = Buffer.from(req.account);
    return Buffer.concat([
        int(14 + account.length + encrypted.length),
        int(12),
        Buffer.of(2, 0),
        field(account),
        encrypted,
    ]);
}

const loginReply = () =>
    Buffer.concat([
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
                    key,
                ),
            },
        ]),
    ]);
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
    handler: (socket: Socket, request: Request) => void,
    override: Partial<WtReferenceLoginAttemptOptions> = {},
    before?: (options: WtReferenceLoginAttemptOptions) => void,
) {
    const server = createServer((socket) => {
        sockets.push(socket);
        const decoder = new ServiceFrameDecoder();
        socket.on('data', (data) => {
            for (const frame of decoder.push(data)) {
                handler(socket, parse(frame));
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
    const signed: Buffer[] = [];
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
        timeoutMs: 500,
        attemptTimeoutMs: 3000,
        getTimestamp: () => 10,
        buildReserved: async ({ body }) => {
            signed.push(Buffer.from(body));
            body.fill(0);
            return new Uint8Array();
        },
        verifyRaw: () => true,
        verifyContext: ({ operation, requestUin, responseUin }) =>
            responseUin === requestUin && (operation !== 'login' || requestUin === '123'),
        sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
        ...override,
    };
    before?.(options);
    const attempt = new WtReferenceLoginAttempt(options);
    attempts.push(attempt);
    return { attempt, signed };
}

afterEach(async () => {
    vi.restoreAllMocks();

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

describe('reference one-socket attempt (synthetic only)', () => {
    it('fetches, waits, confirms and logs in with one reader, key, exact signed packets and new account', async () => {
        const received: Request[] = [],
            evidences: Array<{ sequence: number; transportUin: string; requestUin: string }> = [];
        const { attempt, signed } = await setup(
            (socket, req) => {
                received.push(req);

                if (req.kind === 0x810) {
                    const tlvs = decodeWtTlv(req.business.subarray(2));
                    expect(tlvs.find((e) => e.tag === 0x106)?.value).toEqual(Uint8Array.of(6));
                    expect(tlvs.find((e) => e.tag === 0x16a)?.value).toEqual(Uint8Array.of(5));
                    expect(
                        Buffer.from(tlvs.find((e) => e.tag === 0x18)!.value).readUInt32BE(14),
                    ).toBe(123);
                }

                const body =
                    req.kind === 0x31
                        ? fetchBody()
                        : req.kind === 0x810
                          ? loginReply()
                          : pollBody(received.length === 2 ? 48 : received.length === 3 ? 53 : 0);
                const response = reply(req, body);

                if (received.length === 1) {
                    socket.write(response.subarray(0, 3));
                    socket.write(response.subarray(3));
                } else {
                    socket.write(response);
                }
            },
            {
                verifyRaw: ({ sequence, transportUin, requestUin, responseFrame }) => {
                    evidences.push({ sequence, transportUin, requestUin });
                    expect(Buffer.from(responseFrame).readUInt32BE(0)).toBe(responseFrame.length);
                    responseFrame.fill(0);
                    return true;
                },
            },
        );
        expect(await attempt.fetch(fetchFields)).toEqual({
            image: Uint8Array.of(7, 8),
            qrUrl: 'https://example.invalid/qr',
        });
        expect(await attempt.poll()).toEqual({ status: 'wait', code: 48 });
        expect(await attempt.poll()).toEqual({ status: 'confirm', code: 53 });
        expect(await attempt.poll()).toEqual({ status: 'confirmed' });
        expect(attempt.getState()).toBe('confirmed-held');
        expect(await attempt.login(loginFields)).toEqual({
            status: 'tickets',
            uin: '123',
            tickets: {
                d2: Uint8Array.of(9),
                d2Key: new Uint8Array(16).fill(10),
                a2: Uint8Array.of(11),
                a1: Uint8Array.of(12),
            },
        });
        expect(received.map((r) => r.kind)).toEqual([0x31, 0x12, 0x12, 0x12, 0x810]);
        expect(received.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
        expect(received.map((r) => r.account)).toEqual(['999', '999', '999', '999', '123']);
        expect(received.map((r) => r.oicq.readUInt32BE(9))).toEqual([999, 999, 999, 999, 123]);
        expect(received.slice(0, 4).map((r) => r.business.readBigUInt64BE(53))).toEqual([
            999n,
            999n,
            999n,
            999n,
        ]);
        expect(received.every((r) => r.point.equals(received[0].point))).toBe(true);
        expect(received.every((r) => r.oicq.subarray(28, 44).equals(Buffer.alloc(16, 7)))).toBe(
            true,
        );
        expect(received.map((r) => r.oicq)).toEqual(signed);
        expect(evidences.map((e) => e.transportUin)).toEqual(['999', '999', '999', '999', '999']);
        expect(evidences.map((e) => e.requestUin)).toEqual(['999', '999', '999', '999', '123']);
        await expect(attempt.login(loginFields)).rejects.toThrow();
    });
    it('keeps confirmed accounts isolated across concurrent and sequential attempts', async () => {
        const makeAttempt = async (uin: bigint) => {
            let ownedSocket!: Socket;
            const { attempt } = await setup(
                (socket, request) => {
                    const business =
                        request.kind === 0x31
                            ? fetchBody()
                            : request.kind === 0x810
                              ? loginReply()
                              : pollBody(0, uin);
                    socket.write(reply(request, business));
                },
                {
                    verifyContext: ({ operation, requestUin, responseUin, businessUin }) =>
                        requestUin === responseUin &&
                        (operation !== 'poll' || businessUin === uin) &&
                        (operation !== 'login' || requestUin === uin.toString()),
                },
                (options) => {
                    ownedSocket = options.socket;
                },
            );
            return { attempt, socket: ownedSocket };
        };

        const first = await makeAttempt(123n);
        const second = await makeAttempt(456n);
        await Promise.all([first.attempt.fetch(fetchFields), second.attempt.fetch(fetchFields)]);
        expect(await Promise.all([first.attempt.poll(), second.attempt.poll()])).toEqual([
            { status: 'confirmed' },
            { status: 'confirmed' },
        ]);
        const [secondResult, firstResult] = await Promise.all([
            second.attempt.login(loginFields),
            first.attempt.login(loginFields),
        ]);
        expect(firstResult).toMatchObject({ status: 'tickets', uin: '123' });
        expect(secondResult).toMatchObject({ status: 'tickets', uin: '456' });
        expect(first.socket.destroyed).toBe(true);
        expect(second.socket.destroyed).toBe(true);
        const third = await makeAttempt(789n);
        await third.attempt.fetch(fetchFields);
        await third.attempt.poll();
        expect(await third.attempt.login(loginFields)).toMatchObject({
            status: 'tickets',
            uin: '789',
        });
        expect(third.socket.destroyed).toBe(true);
    });
    it.each([
        {
            expected: { status: 'verification-required', state: 2 },
            business: Buffer.concat([
                Buffer.of(0, 9, 2),
                encodeWtTlv([{ tag: 0x174, value: Buffer.from('sensitive-fixture') }]),
            ]),
        },
        {
            expected: { status: 'nonzero', state: 1 },
            business: Buffer.concat([Buffer.of(0, 9, 1), encodeWtTlv([])]),
        },
        {
            expected: { status: 'incomplete', state: 0 },
            business: Buffer.concat([
                Buffer.of(0, 9, 0),
                encodeWtTlv([{ tag: 0x42, value: Buffer.of(1) }]),
            ]),
        },
        {
            expected: { status: 'error', state: 1, code: 42 },
            business: Buffer.concat([
                Buffer.of(0, 9, 1),
                encodeWtTlv([
                    {
                        tag: 0x146,
                        value: Buffer.concat([
                            int(42),
                            Buffer.from([0, 5]),
                            Buffer.from('title'),
                            Buffer.from([0, 6]),
                            Buffer.from('detail'),
                        ]),
                    },
                ]),
            ]),
        },
    ])(
        'returns only the verified decoder status $expected.status and consumes the attempt',
        async ({ expected, business }) => {
            const requests: Request[] = [];
            const verified: string[] = [];
            const contexts: string[] = [];
            let ownedSocket!: Socket;
            const { attempt } = await setup(
                (socket, request) => {
                    requests.push(request);
                    socket.write(
                        reply(
                            request,
                            request.kind === 0x31
                                ? fetchBody()
                                : request.kind === 0x810
                                  ? business
                                  : pollBody(0),
                        ),
                    );
                },
                {
                    verifyRaw: ({ operation }) => {
                        verified.push(operation);
                        return true;
                    },
                    verifyContext: ({ operation }) => {
                        contexts.push(operation);
                        return true;
                    },
                },
                (options) => {
                    ownedSocket = options.socket;
                },
            );
            await attempt.fetch(fetchFields);
            await attempt.poll();
            expect(await attempt.login(loginFields)).toEqual(expected);
            expect(verified).toEqual(['fetch', 'poll', 'login']);
            expect(contexts).toEqual(['fetch', 'poll', 'login']);
            expect(attempt.getState()).toBe('failed');
            expect(ownedSocket.destroyed).toBe(true);
            await expect(attempt.login(loginFields)).rejects.toThrow();
            expect(requests.map((request) => request.kind)).toEqual([0x31, 0x12, 0x810]);
        },
    );
    it.each(['raw', 'context'] as const)(
        'withholds a non-ticket status when %s verification rejects',
        async (reject) => {
            const business = Buffer.concat([Buffer.of(0, 9, 2), encodeWtTlv([])]);
            const { attempt } = await setup(
                (socket, request) =>
                    socket.write(
                        reply(
                            request,
                            request.kind === 0x31
                                ? fetchBody()
                                : request.kind === 0x810
                                  ? business
                                  : pollBody(0),
                        ),
                    ),
                {
                    verifyRaw: ({ operation }) => reject !== 'raw' || operation !== 'login',
                    verifyContext: ({ operation }) => reject !== 'context' || operation !== 'login',
                },
            );
            await attempt.fetch(fetchFields);
            await attempt.poll();
            await expect(attempt.login(loginFields)).rejects.toThrow('attempt login failed');
            expect(attempt.getState()).toBe('failed');
        },
    );
    it('withholds non-ticket output if the login response has extra coalesced bytes', async () => {
        const business = Buffer.concat([Buffer.of(0, 9, 2), encodeWtTlv([])]);
        const { attempt } = await setup((socket, request) => {
            const frame = reply(
                request,
                request.kind === 0x31
                    ? fetchBody()
                    : request.kind === 0x810
                      ? business
                      : pollBody(0),
            );
            socket.write(request.kind === 0x810 ? Buffer.concat([frame, Buffer.of(0)]) : frame);
        });
        await attempt.fetch(fetchFields);
        await attempt.poll();
        await expect(attempt.login(loginFields)).rejects.toThrow('attempt login failed');
        expect(attempt.getState()).toBe('failed');
    });
    it('does not guess an incomplete result when an existing 0x119 lacks required fields', async () => {
        const business = Buffer.concat([
            Buffer.of(0, 9, 0),
            encodeWtTlv([{ tag: 0x119, value: qqTeaEncrypt(encodeWtTlv([]), key) }]),
        ]);
        const { attempt } = await setup((socket, request) =>
            socket.write(
                reply(
                    request,
                    request.kind === 0x31
                        ? fetchBody()
                        : request.kind === 0x810
                          ? business
                          : pollBody(0),
                ),
            ),
        );
        await attempt.fetch(fetchFields);
        await attempt.poll();
        await expect(attempt.login(loginFields)).rejects.toThrow('attempt login failed');
        expect(attempt.getState()).toBe('failed');
    });
    it('rejects overflow after verification and sends no login', async () => {
        const received: Request[] = [];
        let checked = false;
        const { attempt } = await setup(
            (s, r) => {
                received.push(r);
                s.write(reply(r, r.kind === 0x31 ? fetchBody() : pollBody(0, 0x100000000n)));
            },
            {
                verifyContext: (c) => {
                    if (c.businessUin !== undefined) {
                        checked = true;
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
    it('fails closed on extra coalesced bytes and raw trust rejection', async () => {
        for (const extra of [true, false]) {
            const { attempt } = await setup(
                (s, r) => {
                    const frame = reply(r, fetchBody());
                    s.write(extra ? Buffer.concat([frame, Buffer.of(0)]) : frame);
                },
                { verifyRaw: () => extra },
            );
            await expect(attempt.fetch(fetchFields)).rejects.toThrow();
            expect(attempt.getState()).toBe('failed');
        }
    });
    it.each(['whole', 'subarray'] as const)(
        'snapshots a signer %s view before wiping its owned request copy',
        async (view) => {
            let expected!: Uint8Array;
            let retained!: Uint8Array;
            const { attempt } = await setup(
                (socket, request) => {
                    expect(request.reserved).toEqual(Buffer.from(expected));
                    socket.write(reply(request, fetchBody()));
                },
                {
                    buildReserved: async ({ body }) => {
                        retained = body;
                        const result = view === 'whole' ? body : body.subarray(0, 4);
                        expected = Uint8Array.from(result);
                        Object.defineProperty(body, 'fill', {
                            value: () => {
                                throw new Error('overridden fill');
                            },
                        });
                        return result;
                    },
                },
            );
            await attempt.fetch(fetchFields);
            expect(retained.every((byte) => byte === 0)).toBe(true);
        },
    );
    it.each(['throw', 'abort'] as const)(
        'cleans the signer input and closes the attempt on signer %s',
        async (ending) => {
            const controller = new AbortController();
            let retained!: Uint8Array;
            const requests: Request[] = [];
            const { attempt } = await setup((_socket, request) => requests.push(request), {
                signal: controller.signal,
                buildReserved: async ({ body }) => {
                    retained = body;

                    if (ending === 'abort') {
                        controller.abort();
                        return body.subarray(0, 4);
                    }

                    throw new Error('private signer details');
                },
            });
            await expect(attempt.fetch(fetchFields)).rejects.toThrow('attempt fetch failed');
            expect(retained.every((byte) => byte === 0)).toBe(true);
            expect(attempt.getState()).toBe('failed');
            expect(requests).toHaveLength(0);
        },
    );
    it.each(['requestFrame', 'requestOicq', 'responseFrame'] as const)(
        'wipes each verifier copy despite modified or detached %s',
        async (selected) => {
            for (const mode of ['override', 'detach'] as const) {
                let retained!: Record<'requestFrame' | 'requestOicq' | 'responseFrame', Uint8Array>;
                const { attempt } = await setup(
                    (socket, request) => socket.write(reply(request, fetchBody())),
                    {
                        verifyRaw: (evidence) => {
                            retained = evidence;

                            if (mode === 'detach') {
                                structuredClone(evidence[selected].buffer, {
                                    transfer: [evidence[selected].buffer as ArrayBuffer],
                                });
                            } else {
                                Object.defineProperty(evidence[selected], 'fill', {
                                    value: () => {
                                        throw new Error('overridden fill');
                                    },
                                });
                            }

                            return true;
                        },
                    },
                );
                await attempt.fetch(fetchFields);

                for (const name of ['requestFrame', 'requestOicq', 'responseFrame'] as const) {
                    if (mode === 'detach' && name === selected) {
                        expect(retained[name].byteLength).toBe(0);
                    } else {
                        expect(retained[name].every((byte) => byte === 0)).toBe(true);
                    }
                }
            }
        },
    );
    it('wipes decoded WT bodies when a business boundary rejects', async () => {
        const original = wtOicq.decodeWtOicqResponse;
        let decoded: ReturnType<typeof original> | undefined;
        vi.spyOn(wtOicq, 'decodeWtOicqResponse').mockImplementation((...args) => {
            decoded = original(...args);
            return decoded;
        });
        const { attempt } = await setup(
            (socket, request) => socket.write(reply(request, fetchBody())),
            {
                sliceBusiness: () => {
                    throw new Error('private callback details');
                },
            },
        );
        await expect(attempt.fetch(fetchFields)).rejects.toThrow('attempt fetch failed');
        expect(decoded).toBeDefined();
        expect(decoded!.body.every((byte) => byte === 0)).toBe(true);
    });
    it('wipes only the poll signature copy after the transaction', async () => {
        const original = qrFrame.buildWtQrOicq;
        let copy: Uint8Array | undefined;
        vi.spyOn(qrFrame, 'buildWtQrOicq').mockImplementation((context, operation) => {
            if (operation.type === 'poll') {
                copy = operation.qrSig;
            }

            return original(context, operation);
        });
        const { attempt } = await setup((socket, request) =>
            socket.write(reply(request, request.kind === 0x31 ? fetchBody() : pollBody(48))),
        );
        await attempt.fetch(fetchFields);
        expect(await attempt.poll()).toEqual({ status: 'wait', code: 48 });
        expect(copy).toEqual(new Uint8Array(3));
        expect(await attempt.poll()).toEqual({ status: 'wait', code: 48 });
    });
    it('rejects fake and proxy signals before claiming the socket without invoking traps', async () => {
        let traps = 0;
        const real = new AbortController().signal;
        const proxy = new Proxy(real, {
            get() {
                traps++;
                throw new Error('private trap detail');
            },
            getPrototypeOf() {
                traps++;
                throw new Error('private trap detail');
            },
        });
        const fake = Object.create(AbortSignal.prototype) as AbortSignal;
        const { attempt } = await setup(
            (socket, request) => socket.write(reply(request, fetchBody())),
            {},
            (options) => {
                for (const signal of [fake, proxy]) {
                    expect(() => new WtReferenceLoginAttempt({ ...options, signal })).toThrow(
                        'invalid attempt signal',
                    );
                    expect(options.socket.destroyed).toBe(false);
                }
            },
        );
        expect(traps).toBe(0);
        expect((await attempt.fetch(fetchFields)).image).toEqual(Uint8Array.of(7, 8));
    });
    it('ignores overridden signal listener methods and still cancels', async () => {
        const controller = new AbortController();
        Object.defineProperty(controller.signal, 'addEventListener', {
            value: () => {
                throw new Error('secret');
            },
        });
        Object.defineProperty(controller.signal, 'removeEventListener', {
            value: () => {
                throw new Error('secret');
            },
        });
        const { attempt } = await setup(
            (socket, request) => socket.write(reply(request, fetchBody())),
            { signal: controller.signal },
        );
        await attempt.fetch(fetchFields);
        controller.abort();
        expect(attempt.getState()).toBe('failed');
    });
    it.each(['abort', 'timeout'] as const)(
        'does not return an account when an in-flight login ends by %s',
        async (ending) => {
            const controller = new AbortController();
            let loginReceived!: () => void;
            const loginStarted = new Promise<void>((resolve) => {
                loginReceived = resolve;
            });
            let ownedSocket!: Socket;
            const { attempt } = await setup(
                (socket, request) => {
                    if (request.kind === 0x810) {
                        loginReceived();
                    } else {
                        socket.write(
                            reply(request, request.kind === 0x31 ? fetchBody() : pollBody(0)),
                        );
                    }
                },
                { signal: controller.signal, timeoutMs: 100 },
                (options) => {
                    ownedSocket = options.socket;
                },
            );
            await attempt.fetch(fetchFields);
            expect(await attempt.poll()).toEqual({ status: 'confirmed' });
            const result = attempt.login(loginFields);
            const rejection = expect(result).rejects.toThrow('attempt login failed');
            await loginStarted;

            if (ending === 'abort') {
                controller.abort();
            }

            await rejection;
            expect(attempt.getState()).toBe('failed');
            expect(ownedSocket.destroyed).toBe(true);
        },
    );
    it('expires held confirmation without a later login write', async () => {
        const requests: Request[] = [];
        const { attempt } = await setup(
            (socket, request) => {
                requests.push(request);
                socket.write(reply(request, request.kind === 0x31 ? fetchBody() : pollBody(0)));
            },
            { attemptTimeoutMs: 120 },
        );
        await attempt.fetch(fetchFields);
        await attempt.poll();
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        expect(attempt.getState()).toBe('failed');
        await expect(attempt.login(loginFields)).rejects.toThrow();
        expect(requests).toHaveLength(2);
    });
    it('discards delayed confirmation on cancellation while context verification is pending', async () => {
        const controller = new AbortController();
        let started!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => {
            started = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const requests: Request[] = [];
        const { attempt } = await setup(
            (socket, request) => {
                requests.push(request);
                socket.write(reply(request, request.kind === 0x31 ? fetchBody() : pollBody(0)));
            },
            {
                signal: controller.signal,
                verifyContext: async (context) => {
                    if (context.operation === 'poll') {
                        started();
                        await blocked;
                    }

                    return true;
                },
            },
        );
        await attempt.fetch(fetchFields);
        const poll = attempt.poll();
        const rejection = expect(poll).rejects.toThrow();
        await entered;
        controller.abort();
        await rejection;
        release();
        await expect(attempt.login(loginFields)).rejects.toThrow();
        expect(requests).toHaveLength(2);
    });
    it('invalidates held confirmation on cancellation and never sends login', async () => {
        const controller = new AbortController();
        const requests: Request[] = [];
        const { attempt } = await setup(
            (s, r) => {
                requests.push(r);
                s.write(reply(r, r.kind === 0x31 ? fetchBody() : pollBody(0)));
            },
            { signal: controller.signal },
        );
        await attempt.fetch(fetchFields);
        await attempt.poll();
        controller.abort();
        await expect(attempt.login(loginFields)).rejects.toThrow();
        expect(requests).toHaveLength(2);
    });
});
