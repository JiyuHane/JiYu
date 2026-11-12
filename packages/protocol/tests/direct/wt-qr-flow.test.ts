import { once } from 'node:events';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WtQrFlow, type WtQrFlowOptions } from '../../src/direct/wt-qr-flow';
import { createWtEcdh } from '../../src/direct/wt-ecdh';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { ServiceFrameDecoder } from '../../src/direct/service-stream';
import { encodeWtQrD1 } from '../../src/direct/wt-qr-protobuf';
import * as qrResponse from '../../src/direct/wt-qr-response';
import { encodeWtTlv } from '../../src/direct/wt-tlv';

// All vectors and peers are synthetic and use loopback only.
const peers: Socket[] = [];
const servers: Server[] = [];
const flows: WtQrFlow[] = [];
const scalar = Buffer.concat([Buffer.alloc(23), Buffer.of(2)]);
const peerKey = createWtEcdh(scalar);

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
            { tag: 0xd1, value: encodeWtQrD1({ qrUrl: 'https://example.invalid/synthetic' }) },
        ]),
    ]);
const pollBody = (code: number) =>
    code
        ? header(code)
        : Buffer.concat([
              header(0),
              Buffer.from('000000000000007b00000000', 'hex'),
              encodeWtTlv([
                  { tag: 0x1e, value: new Uint8Array(16).fill(4) },
                  { tag: 0x19, value: Uint8Array.of(5) },
                  { tag: 0x18, value: Uint8Array.of(6) },
              ]),
          ]);

function parse(frame: Uint8Array) {
    const b = Buffer.from(frame);
    const uinStart = 9 + b.readUInt32BE(9) + 1;
    const uinLen = b.readUInt32BE(uinStart);
    const uin = b.subarray(uinStart + 4, uinStart + uinLen).toString();
    const sso = Buffer.from(qqTeaDecrypt(b.subarray(uinStart + uinLen), new Uint8Array(16)));
    const end = sso.readUInt32BE(0);
    let pos = 28;

    const readField = () => {
        const len = sso.readUInt32BE(pos);
        const v = sso.subarray(pos + 4, pos + len);
        pos += len;
        return v;
    };

    readField();
    const command = readField().toString();
    readField();
    const guid = Buffer.from(readField());
    const oicq = sso.subarray(end + 4);
    const shared = peerKey.deriveTeaKey(oicq.subarray(48, 73));
    const plain = Buffer.from(qqTeaDecrypt(oicq.subarray(73, -1), shared));
    return {
        uin,
        command,
        guid,
        subAppId: sso.readInt32BE(8),
        seq: sso.readInt32BE(4),
        timestamp: plain.readUInt32BE(14),
        operation: plain.readUInt16BE(14 + 7),
        oicq: Buffer.from(oicq),
        shared,
    };
}

function reply(
    req: ReturnType<typeof parse>,
    body: Uint8Array,
    opts: { code?: number; command?: number; trailer?: boolean } = {},
) {
    const layer = Buffer.alloc(43);
    layer.writeUInt16BE(opts.command ?? req.operation, 3);
    layer.writeBigInt64BE(123n, 35);
    const business = Buffer.concat([layer, body, opts.trailer ? Buffer.of(3) : Buffer.alloc(0)]);
    const code2d = Buffer.concat([
        Buffer.from([0, 0, business.length >> 8, business.length & 255, 0]),
        business,
    ]);
    const cipher = qqTeaEncrypt(code2d, req.shared);
    const oicq = Buffer.alloc(17 + cipher.length);
    oicq[0] = 2;
    oicq.writeUInt16BE(oicq.length, 1);
    oicq.writeUInt16BE(0x812, 5);
    oicq.writeUInt32BE(123, 9);
    oicq.set(cipher, 16);
    oicq[oicq.length - 1] = 3;
    const inner = Buffer.concat([
        field(
            Buffer.concat([
                int(req.seq),
                int(opts.code ?? 0),
                field(Buffer.alloc(0)),
                field(Buffer.from(req.command)),
                field(Buffer.alloc(0)),
                int(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(oicq),
    ]);
    const encrypted = qqTeaEncrypt(inner, new Uint8Array(16));
    const uin = Buffer.from(req.uin);
    return Buffer.concat([
        int(14 + uin.length + encrypted.length),
        int(12),
        Buffer.of(2, 0),
        field(uin),
        encrypted,
    ]);
}

async function setup(
    handler: (socket: Socket, req: ReturnType<typeof parse>) => void,
    overrides: Partial<WtQrFlowOptions> = {},
    beforeFlow?: (options: WtQrFlowOptions) => void,
) {
    const server = createServer((s) => {
        peers.push(s);
        const decoder = new ServiceFrameDecoder();
        s.on('data', (chunk) => {
            for (const frame of decoder.push(chunk)) {
                handler(s, parse(frame));
            }
        });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();

    if (!address || typeof address === 'string') {
        throw new Error('missing address');
    }

    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    peers.push(socket);
    await once(socket, 'connect');
    const profile: WtQrFlowOptions['profile'] = {
        uin: '123',

        appId: 42,
        subAppId: 43,
        clientVersion: 44,
        guid: Uint8Array.of(1, 2),
        unknown21: new Uint8Array(21),
        randomKey: new Uint8Array(16),
        peerPublicKey: peerKey.publicKey,
        ssoVersion: 'test',
        serviceCommand: 'fixture',
    };
    const signed: Buffer[] = [];
    let clock = 10;
    const options: WtQrFlowOptions = {
        socket,
        profile,
        timeoutMs: 300,
        getTimestamp: () => clock++,
        buildReserved: async ({ body }) => {
            signed.push(Buffer.from(body));
            body.fill(0);
            return new Uint8Array();
        },
        classifyIncoming: () => 'response',
        verifyResponseUin: (a, b) => a === b,
        verifyResponse: () => true,
        verifyContext: ({
            operation,
            oicqCommand,
            oicqUin,
            code2dCommand,
            code2dUin,
            businessUin,
            businessAppId,
        }) =>
            oicqCommand === 0x812 &&
            oicqUin === 123 &&
            code2dCommand === (operation === 'fetch' ? 0x31 : 0x12) &&
            code2dUin === 123n &&
            (businessUin === undefined || businessUin === 123n) &&
            businessAppId === 42,
        sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
        ...overrides,
    };
    beforeFlow?.(options);
    const flow = new WtQrFlow(options);
    flows.push(flow);
    return { flow, profile, signed };
}

const fetchFields = {
    packageName: 'fixture',
    ptVersion: 'test',
    miscBitMap: 1,
    ssoVersion: 1,
    d1: Uint8Array.of(1),
};
afterEach(async () => {
    for (const flow of flows.splice(0)) {
        flow.close();
    }

    for (const peer of peers.splice(0)) {
        peer.destroy();
    }

    await Promise.all(
        servers
            .splice(0)
            .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    vi.restoreAllMocks();
});

describe('isolated QR coordinator', () => {
    it('fetches, waits and confirms with identical signed and sent OICQ on loopback', async () => {
        const received: ReturnType<typeof parse>[] = [];
        const verified: number[] = [];
        const { flow, profile, signed } = await setup(
            (socket, req) => {
                received.push(req);
                socket.write(
                    reply(
                        req,
                        req.operation === 0x31
                            ? fetchBody()
                            : pollBody(received.length === 2 ? 48 : 0),
                    ),
                );
            },
            {
                verifyResponse: ({ sequence, command }) => {
                    verified.push(sequence);
                    return command === 'fixture';
                },
            },
        );
        profile.uin = '999';
        profile.guid.fill(9);
        profile.subAppId = 99;
        expect(await flow.fetch(fetchFields)).toEqual({
            image: Uint8Array.of(7, 8),
            qrUrl: 'https://example.invalid/synthetic',
        });
        expect(await flow.poll()).toEqual({ status: 'wait', code: 48 });
        expect(await flow.poll()).toEqual({
            status: 'confirmed',
            uin: 123n,
            retry: 0,
            tickets: {
                tgtgtKey: new Uint8Array(16).fill(4),
                noPicSig: Uint8Array.of(5),
                tempPassword: Uint8Array.of(6),
            },
        });
        expect(received.map((r) => r.oicq)).toEqual(signed);
        expect(received.map((r) => r.timestamp)).toEqual([10, 11, 12]);
        expect(verified).toEqual(received.map((r) => r.seq >>> 0));
        expect(
            received.every(
                (r) => r.uin === '123' && r.subAppId === 43 && r.guid.equals(Buffer.from('0102')),
            ),
        ).toBe(true);
        await expect(flow.poll()).rejects.toThrow(/state/);
    });
    it.each([17, 54, 144, 222])(
        'preserves terminal code %i without returning raw remainder',
        async (code) => {
            const { flow } = await setup((socket, req) =>
                socket.write(reply(req, req.operation === 0x31 ? fetchBody() : pollBody(code))),
            );
            await flow.fetch(fetchFields);
            expect(await flow.poll()).toEqual({
                status: (
                    { 17: 'expired', 54: 'canceled', 144: 'invalid', 222: 'unknown' } as Record<
                        number,
                        string
                    >
                )[code],
                code,
            });
            await expect(flow.poll()).rejects.toThrow(/state/);
        },
    );
    it('fails closed for nonzero SSO, mismatched context and rejected integrity', async () => {
        for (const mode of ['sso', 'context', 'integrity'] as const) {
            const { flow } = await setup(
                (socket, req) =>
                    socket.write(
                        reply(req, fetchBody(), {
                            code: mode === 'sso' ? 2 : 0,
                            command: mode === 'context' ? 0x12 : 0x31,
                        }),
                    ),
                mode === 'integrity' ? { verifyResponse: () => false } : {},
            );
            await expect(flow.fetch(fetchFields)).rejects.toThrow('QR fetch failed');
            await expect(flow.fetch(fetchFields)).rejects.toThrow(/state/);
        }
    });
    it('scrubs parser-owned QR copies on rejected and waiting responses', async () => {
        const fetchOriginal = qrResponse.decodeWtQrFetchResponse;
        const pollOriginal = qrResponse.decodeWtQrPollResponse;
        const fetchResults: ReturnType<typeof fetchOriginal>[] = [];
        const pollResults: ReturnType<typeof pollOriginal>[] = [];
        vi.spyOn(qrResponse, 'decodeWtQrFetchResponse').mockImplementation((bytes) => {
            const result = fetchOriginal(bytes);
            fetchResults.push(result);
            return result;
        });
        vi.spyOn(qrResponse, 'decodeWtQrPollResponse').mockImplementation((bytes) => {
            const result = pollOriginal(bytes);
            pollResults.push(result);
            return result;
        });
        const rejected = await setup((socket, req) => socket.write(reply(req, fetchBody())), {
            verifyContext: () => false,
        });
        await expect(rejected.flow.fetch(fetchFields)).rejects.toThrow();
        const fetch = fetchResults[0];

        if (fetch.status !== 'success') {
            throw new Error('bad test');
        }

        expect(fetch.qrSig).toEqual(new Uint8Array(3));
        const waiting = await setup((socket, req) =>
            socket.write(
                reply(
                    req,
                    req.operation === 0x31
                        ? fetchBody()
                        : Buffer.concat([header(48), Buffer.of(0xaa)]),
                ),
            ),
        );
        await waiting.flow.fetch(fetchFields);
        await waiting.flow.poll();
        const state = pollResults[0];

        if (state.status === 'confirmed') {
            throw new Error('bad test');
        }

        expect(state.remaining).toEqual(Uint8Array.of(0));
        const rejectedConfirmation = await setup(
            (socket, req) =>
                socket.write(reply(req, req.operation === 0x31 ? fetchBody() : pollBody(0))),
            { verifyContext: ({ operation }) => operation !== 'poll' },
        );
        await rejectedConfirmation.flow.fetch(fetchFields);
        await expect(rejectedConfirmation.flow.poll()).rejects.toThrow();
        const confirmed = pollResults[1];

        if (confirmed.status !== 'confirmed') {
            throw new Error('bad test');
        }

        expect(confirmed.tickets.tgtgtKey).toEqual(new Uint8Array(16));
        expect(confirmed.tickets.noPicSig).toEqual(Uint8Array.of(0));
        expect(confirmed.tickets.tempPassword).toEqual(Uint8Array.of(0));
    });
    it('validates the copied profile before claiming the socket', async () => {
        const { flow } = await setup(
            (socket, req) => socket.write(reply(req, fetchBody())),
            {},
            (options) => {
                for (const bad of [
                    { randomKey: new Uint8Array(15) },
                    { unknown21: new Uint8Array(20) },
                    { peerPublicKey: new Uint8Array(25) },
                    { appId: -1 },
                    { clientVersion: 65536 },
                    { subAppId: -1 },
                    { guid: new Uint8Array() },
                ]) {
                    expect(
                        () => new WtQrFlow({ ...options, profile: { ...options.profile, ...bad } }),
                    ).toThrow();
                }
            },
        );
        expect((await flow.fetch(fetchFields)).image).toEqual(Uint8Array.of(7, 8));
    });
    it('reads each fetch getter once before validation and sending', async () => {
        const { flow } = await setup((socket, req) => socket.write(reply(req, fetchBody())));
        const reads = {
            packageName: 0,
            ptVersion: 0,
            miscBitMap: 0,
            ssoVersion: 0,
            d1: 0,
            unusualSig: 0,
        };
        const fields = Object.fromEntries(
            Object.entries(fetchFields).map(([key, value]) => [
                key,
                {
                    enumerable: true,
                    get() {
                        const n = ++reads[key as keyof typeof reads];
                        return n === 1 ? value : null;
                    },
                },
            ]),
        );
        fields.unusualSig = {
            enumerable: true,
            get() {
                reads.unusualSig++;
                return undefined;
            },
        };
        const input = Object.defineProperties({}, fields) as typeof fetchFields;
        await flow.fetch(input);
        expect(Object.values(reads)).toEqual([1, 1, 1, 1, 1, 1]);
    });
    it('rejects non-byte fetch inputs before signing or sending', async () => {
        for (const bad of [{ d1: [1] }, { d1: 'x' }, { unusualSig: [1] }, { unusualSig: 'x' }]) {
            const received = vi.fn();
            const { flow, signed } = await setup(received);
            await expect(flow.fetch({ ...fetchFields, ...bad } as never)).rejects.toThrow();
            expect(received).not.toHaveBeenCalled();
            expect(signed).toHaveLength(0);
        }
    });
    it('fails closed on nonzero fetch return code and verifier exceptions', async () => {
        for (const mode of ['fetch-code', 'verifier'] as const) {
            const { flow } = await setup(
                (socket, req) =>
                    socket.write(reply(req, mode === 'fetch-code' ? header(1) : fetchBody())),
                mode === 'verifier'
                    ? {
                          verifyResponse: () => {
                              throw new Error('untrusted details');
                          },
                      }
                    : {},
            );
            await expect(flow.fetch(fetchFields)).rejects.toThrow('QR fetch failed');
            await expect(flow.fetch(fetchFields)).rejects.toThrow(/state/);
        }
    });
    it('preserves confirm state and fails on an inconsistent confirmed account', async () => {
        let calls = 0;
        const { flow } = await setup((socket, req) => {
            calls++;
            const body = req.operation === 0x31 ? fetchBody() : pollBody(calls === 2 ? 53 : 0);

            if (calls === 3) {
                body.writeBigInt64BE(456n, 7);
            }

            socket.write(reply(req, body));
        });
        await flow.fetch(fetchFields);
        expect(await flow.poll()).toEqual({ status: 'confirm', code: 53 });
        await expect(flow.poll()).rejects.toThrow('QR poll failed');
        await expect(flow.poll()).rejects.toThrow(/state/);
    });
    it('suppresses confirmed tickets if closed inside context validation', async () => {
        let flow!: WtQrFlow;
        ({ flow } = await setup(
            (socket, req) =>
                socket.write(reply(req, req.operation === 0x31 ? fetchBody() : pollBody(0))),
            {
                verifyContext: ({ operation }) => {
                    if (operation === 'poll') {
                        flow.close();
                    }

                    return true;
                },
            },
        ));
        await flow.fetch(fetchFields);
        await expect(flow.poll()).rejects.toThrow('QR poll failed');
    });
    it('does not let verification callback mutate parsing input', async () => {
        const { flow } = await setup((socket, req) => socket.write(reply(req, fetchBody())), {
            verifyResponse: ({ oicq }) => {
                oicq.fill(0);
                return true;
            },
        });
        expect((await flow.fetch(fetchFields)).image).toEqual(Uint8Array.of(7, 8));
    });
    it('snapshots slice getters once and checks closure after reading them', async () => {
        let reads = 0;
        const first = await setup((socket, req) => socket.write(reply(req, fetchBody())), {
            sliceBusiness: ({ bodyLength }) => ({
                get start() {
                    reads++;
                    return reads === 1 ? 0 : bodyLength;
                },
                get end() {
                    reads++;
                    return reads === 2 ? bodyLength : 0;
                },
            }),
        });
        expect((await first.flow.fetch(fetchFields)).image).toEqual(Uint8Array.of(7, 8));
        expect(reads).toBe(2);
        let second!: WtQrFlow;
        ({ flow: second } = await setup((socket, req) => socket.write(reply(req, fetchBody())), {
            sliceBusiness: ({ bodyLength }) => ({
                get start() {
                    second.close();
                    return 0;
                },
                end: bodyLength,
            }),
        }));
        await expect(second.fetch(fetchFields)).rejects.toThrow('QR fetch failed');
    });
    it('requires an explicit valid trailer boundary and rejects truncation', async () => {
        for (const mode of ['unsliced', 'slice', 'bad', 'truncated'] as const) {
            const { flow } = await setup(
                (socket, req) =>
                    socket.write(
                        reply(
                            req,
                            mode === 'truncated' ? fetchBody().subarray(0, 8) : fetchBody(),
                            { trailer: mode !== 'truncated' },
                        ),
                    ),
                mode === 'slice'
                    ? { sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength - 1 }) }
                    : mode === 'bad'
                      ? { sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength + 1 }) }
                      : {},
            );

            if (mode === 'slice') {
                expect((await flow.fetch(fetchFields)).image).toEqual(Uint8Array.of(7, 8));
            } else {
                await expect(flow.fetch(fetchFields)).rejects.toThrow('QR fetch failed');
            }
        }
    });
    it('does not send after a slow clock consumes the deadline', async () => {
        const onRequest = vi.fn();
        const { flow } = await setup(onRequest, {
            timeoutMs: 5,
            getTimestamp: () => {
                const until = performance.now() + 15;

                while (performance.now() < until) {
                    /* synthetic synchronous delay */
                }

                return 10;
            },
        });
        await expect(flow.fetch(fetchFields)).rejects.toThrow('QR fetch failed');
        expect(onRequest).not.toHaveBeenCalled();
    });
    it('rejects overlap and late replies after abort, close, disconnect or timeout', async () => {
        for (const mode of ['abort', 'close', 'disconnect', 'timeout'] as const) {
            let send!: () => void;
            const { flow } = await setup(
                (socket, req) => {
                    send = () => socket.write(reply(req, fetchBody()));

                    if (mode === 'disconnect') {
                        socket.destroy();
                    }
                },
                { timeoutMs: 50 },
            );
            const controller = new AbortController();
            const pending = flow.fetch(fetchFields, controller.signal);
            await expect(flow.fetch(fetchFields)).rejects.toThrow(/single-flight/);

            if (mode === 'abort') {
                controller.abort();
            }

            if (mode === 'close') {
                flow.close();
            }

            await expect(pending).rejects.toThrow('QR fetch failed');

            if (send && mode !== 'disconnect') {
                try {
                    send();
                } catch {
                    /* closed peer */
                }
            }

            await expect(flow.fetch(fetchFields)).rejects.toThrow(/state/);
        }
    });
});
