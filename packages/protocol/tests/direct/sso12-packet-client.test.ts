import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    Sso12PacketClient,
    type Sso12PacketClientOptions,
} from '../../src/direct/sso12-packet-client';
import { ServiceFrameDecoder } from '../../src/direct/service-stream';
import { TcpPacketClient } from '../../src/direct/tcp-packet-client';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';

const servers: Server[] = [];
const sockets: Socket[] = [];
const clients: Sso12PacketClient[] = [];
const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const account = '123456';
const field = (v: Uint8Array): Buffer => Buffer.concat([int(v.length + 4), v]);

function int(n: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n | 0);
    return b;
}

function reply(
    seq: number,
    command: string,
    body: string,
    opts: { uin?: string; key?: Buffer; flag?: number; code?: number } = {},
): Buffer {
    const inner = Buffer.concat([
        field(
            Buffer.concat([
                int(seq),
                int(opts.code ?? 0),
                field(Buffer.from(opts.code ? 'failed' : '')),
                field(Buffer.from(command)),
                field(Buffer.alloc(0)),
                int(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(Buffer.from(body)),
    ]);
    const flag = opts.flag ?? 2;
    const encrypted = qqTeaEncrypt(inner, flag === 1 ? opts.key! : Buffer.alloc(16));
    const uin = Buffer.from(opts.uin ?? account);
    return Buffer.concat([
        int(14 + uin.length + encrypted.length),
        int(12),
        Buffer.from([flag, 0]),
        field(uin),
        encrypted,
    ]);
}

function request(
    frame: Uint8Array,
    decryptKey = Buffer.alloc(16),
): {
    seq: number;
    command: string;
    body: Buffer;
    ticket: Buffer;
    a2: Buffer;
    guid: string;
    version: string;
    uin: string;
    flag: number;
} {
    const b = Buffer.from(frame);
    const ticketLength = b.readUInt32BE(9);
    const ticket = b.subarray(13, 9 + ticketLength);
    const uinStart = 9 + ticketLength + 1;
    const uinLength = b.readUInt32BE(uinStart);
    const uin = b.subarray(uinStart + 4, uinStart + uinLength).toString();
    const plain = Buffer.from(qqTeaDecrypt(b.subarray(uinStart + uinLength), decryptKey));
    const headLength = plain.readUInt32BE(0);
    const seq = plain.readInt32BE(4);
    let pos = 4 + 4 + 4 + 4 + 12;

    const readField = (): Buffer => {
        const len = plain.readUInt32BE(pos);
        const value = plain.subarray(pos + 4, pos + len);
        pos += len;
        return value;
    };

    const a2 = readField();
    const command = readField().toString();
    readField();
    const guid = readField().toString();
    readField();
    const versionLength = plain.readUInt16BE(pos);
    const version = plain.subarray(pos + 2, pos + versionLength).toString();
    return {
        seq,
        command,
        body: plain.subarray(headLength + 4),
        ticket,
        a2,
        guid,
        version,
        uin,
        flag: b[8],
    };
}

async function setup(
    onFrame: (peer: Socket, frame: Uint8Array) => void,
    opts: Partial<Sso12PacketClientOptions> = {},
): Promise<{ client: Sso12PacketClient; socket: Socket; peer: Socket }> {
    let peer!: Socket;
    const server = createServer((s) => {
        peer = s;
        sockets.push(s);
        const decoder = new ServiceFrameDecoder();
        s.on('data', (data) => {
            for (const frame of decoder.push(data)) {
                onFrame(s, frame);
            }
        });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();

    if (!address || typeof address === 'string') {
        throw new Error('no address');
    }

    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    sockets.push(socket);
    await once(socket, 'connect');
    const client = new Sso12PacketClient({
        socket,
        uin: account,
        encryption: { type: 'zero' },
        subAppId: 42,
        guid: Buffer.from([1, 2]),
        version: 'v1',
        a2: Buffer.from([3]),
        buildReserved: async () => Buffer.alloc(0),
        classifyIncoming: () => 'response',
        ...opts,
    });
    clients.push(client);
    return { client, socket, peer };
}

async function rawSocket(): Promise<{ socket: Socket; peer: Socket; server: Server }> {
    const server = createServer((peer) => {
        sockets.push(peer);
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();

    if (!address || typeof address === 'string') {
        throw new Error('no address');
    }

    const incoming = once(server, 'connection');
    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    sockets.push(socket);
    await once(socket, 'connect');
    const [peer] = (await incoming) as [Socket];
    return { socket, peer, server };
}

function create12(socket: Socket): Sso12PacketClient {
    const client = new Sso12PacketClient({
        socket,
        uin: account,
        encryption: { type: 'zero' },
        subAppId: 42,
        guid: Buffer.from([1]),
        version: 'v1',
        a2: Buffer.alloc(0),
        buildReserved: async () => Buffer.alloc(0),
        classifyIncoming: () => 'response',
    });
    clients.push(client);
    return client;
}

function create13(socket: Socket): TcpPacketClient {
    return new TcpPacketClient({
        socket,
        uin: account,
        d2Key: key,
        buildReserved: async () => Buffer.alloc(0),
        classifyIncoming: () => 'response',
    });
}

afterEach(async () => {
    for (const client of clients.splice(0)) {
        client.close();
    }

    for (const socket of sockets.splice(0)) {
        socket.destroy();
    }

    await Promise.all(
        servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
    vi.restoreAllMocks();
});

describe('shared direct socket ownership', () => {
    it('prevents SSO13 takeover of SSO12 and preserves first client operation and caller listeners', async () => {
        const { client, socket } = await setup((peer, frame) => {
            const r = request(frame);
            peer.write(reply(r.seq, r.command, 'ok'));
        });
        const caller = vi.fn();
        socket.on('data', caller);
        const before = socket.listenerCount('data');
        expect(() => create13(socket)).toThrow(/owned/);
        expect(socket.listenerCount('data')).toBe(before);
        expect(await client.sendPacket('test', Buffer.alloc(0))).toMatchObject({
            success: true,
            responseData: Buffer.from('ok'),
        });
        expect(caller).toHaveBeenCalled();
    });
    it('prevents SSO12 takeover of SSO13 and keeps SSO13 operational', async () => {
        const { socket, peer } = await rawSocket();
        const decoder = new ServiceFrameDecoder();
        peer.on('data', (data) => {
            for (const frame of decoder.push(data)) {
                const seq = Buffer.from(frame).readInt32BE(9);
                const response = reply(seq, 'test', 'ok', { flag: 1, key });
                response.writeInt32BE(13, 4);
                peer.write(response);
            }
        });
        const client = create13(socket);
        const before = socket.listenerCount('data');
        expect(() => create12(socket)).toThrow(/owned/);
        expect(socket.listenerCount('data')).toBe(before);
        expect(await client.sendPacket('test', Buffer.alloc(0))).toMatchObject({
            success: true,
            responseData: Buffer.from('ok'),
        });
        client.close();
        await client.whenClosed;
    });
    it.each(['12', '13'] as const)(
        'rolls back partial %s listener setup and ownership on construction failure',
        async (kind) => {
            const { socket } = await rawSocket();
            const caller = vi.fn();
            socket.on('data', caller);
            const originalOn = socket.on.bind(socket);
            const spy = vi.spyOn(socket, 'on').mockImplementation(((
                event: string | symbol,
                listener: (...args: never[]) => void,
            ) => {
                if (event === 'end') {
                    throw new Error('fixture setup error');
                }

                return originalOn(event, listener);
            }) as typeof socket.on);

            if (kind === '12') {
                expect(() => create12(socket)).toThrow('fixture setup error');
            } else {
                expect(() => create13(socket)).toThrow('fixture setup error');
            }

            spy.mockRestore();
            expect(socket.listeners('data')).toEqual([caller]);
            expect(socket.listenerCount('error')).toBe(0);

            if (kind === '12') {
                const replacement = create13(socket);
                replacement.close();
                await replacement.whenClosed;
            } else {
                const replacement = create12(socket);
                replacement.close();
                await replacement.whenClosed;
            }
        },
    );
    it('retains ownership during close and releases it for a reconnected socket only after close', async () => {
        const { socket, server } = await rawSocket();
        const client = create12(socket);
        const destroy = socket.destroy.bind(socket);
        const hold = vi.spyOn(socket, 'destroy').mockImplementation(() => socket);
        client.close();
        expect(() => create13(socket)).toThrow(/owned/);
        hold.mockRestore();
        destroy();
        await client.whenClosed;
        const address = server.address();

        if (!address || typeof address === 'string') {
            throw new Error('no address');
        }

        socket.connect({ host: '127.0.0.1', port: address.port });
        await once(socket, 'connect');
        const replacement = create13(socket);
        replacement.close();
        await replacement.whenClosed;
        const fresh = await rawSocket();
        const freshClient = create12(fresh.socket);
        freshClient.close();
        await freshClient.whenClosed;
    });
});

describe('strict raw-before-decode reference transaction', () => {
    const wire = Buffer.concat([int(18), Buffer.alloc(14, 0xa5)]);
    const candidate = Buffer.concat([int(18), Buffer.alloc(14, 0xf9)]);
    const opts = () => ({
        buildRequest: () => ({ frame: Buffer.from(wire), context: { id: 3 } }),
        verifyCandidate: async (value: Uint8Array) => Buffer.from(value).equals(candidate),
        consumeCandidate: async (_value: Uint8Array, context: { id: number }) => context.id,
    });
    it('reassembles bytewise, presents raw bytes before any decode, and isolates both callback copies', async () => {
        const classifier = vi.fn(() => 'response' as const);
        const { client } = await setup(
            (peer) => {
                for (const byte of candidate) {
                    peer.write(Buffer.from([byte]));
                }
            },
            {
                classifyIncoming: classifier,
                verifyResponseUin: () => {
                    throw new Error('not called');
                },
            },
        );
        const result = await client.transactRaw({
            ...opts(),
            verifyCandidate: async (data) => {
                expect(Buffer.from(data)).toEqual(candidate);
                data.fill(0);
                return true;
            },
            consumeCandidate: async (data) => {
                expect(Buffer.from(data)).toEqual(candidate);
                data.fill(1);
                return 'consumed';
            },
        });
        expect(result).toEqual({
            kind: 'response',
            sequence: 1,
            writeState: 'written',
            value: 'consumed',
        });
        expect(classifier).not.toHaveBeenCalled();
    });
    it('rejects a paused socket before starting the raw transaction', async () => {
        const { client, socket } = await setup(() => {});
        const writes = vi.spyOn(socket, 'write');
        socket.pause();
        expect(await client.transactRaw(opts())).toMatchObject({
            kind: 'failure',
            code: 'raw-partial-stream',
            writeState: 'not-written',
        });
        expect(writes).not.toHaveBeenCalled();
    });
    it('rejects buffered pre-write TCP bytes while a delayed builder is pending', async () => {
        let finish!: (value: { frame: Uint8Array; context: { id: number } }) => void;
        const { client, socket, peer } = await setup(() => {});
        const writes = vi.spyOn(socket, 'write');
        const received = vi.fn();
        peer.on('data', received);
        const peerClosed = once(peer, 'close');
        const verify = vi.fn(() => true);
        const pending = client.transactRaw({
            ...opts(),
            verifyCandidate: verify,
            buildRequest: () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        });
        socket.pause();

        const retainReadableMode = (): void => {};

        socket.on('readable', retainReadableMode);
        const readable = once(socket, 'readable');
        peer.write(candidate.subarray(0, 3));
        await readable;
        expect(socket.readableLength).toBeGreaterThan(0);
        finish({ frame: wire, context: { id: 3 } });
        expect(await pending).toMatchObject({
            kind: 'failure',
            code: 'raw-extra-data',
            writeState: 'not-written',
        });
        await peerClosed;
        expect(writes).not.toHaveBeenCalled();
        expect(received).not.toHaveBeenCalled();
        expect(verify).not.toHaveBeenCalled();
    });
    it('rejects a paused socket with a preexisting unshifted complete frame', async () => {
        let finish!: (value: { frame: Uint8Array; context: { id: number } }) => void;
        const { client, socket, peer } = await setup(() => {});
        const writes = vi.spyOn(socket, 'write');
        const received = vi.fn();
        peer.on('data', received);
        const peerClosed = once(peer, 'close');
        const verify = vi.fn(() => true);
        const pending = client.transactRaw({
            ...opts(),
            verifyCandidate: verify,
            buildRequest: () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        });
        socket.pause();
        socket.unshift(Buffer.from(candidate));
        expect(socket.readableLength).toBe(candidate.length);
        finish({ frame: wire, context: { id: 3 } });
        expect(await pending).toMatchObject({
            kind: 'failure',
            code: 'raw-extra-data',
            writeState: 'not-written',
        });
        await peerClosed;
        expect(writes).not.toHaveBeenCalled();
        expect(received).not.toHaveBeenCalled();
        expect(verify).not.toHaveBeenCalled();
    });
    it.each(['verify', 'consume'] as const)(
        'fails closed when the socket is paused during %s',
        async (phase) => {
            const { client, socket } = await setup((peer) => peer.write(candidate));
            const consume = vi.fn(async () => {
                if (phase === 'consume') {
                    socket.pause();
                    await Promise.resolve();
                }

                return 42;
            });
            const result = await client.transactRaw({
                ...opts(),
                verifyCandidate: async () => {
                    if (phase === 'verify') {
                        socket.pause();
                        await Promise.resolve();
                    }

                    return true;
                },
                consumeCandidate: consume,
            });
            expect(result).toMatchObject({
                kind: 'failure',
                code: 'raw-extra-data',
                writeState: 'unknown',
            });

            if (phase === 'verify') {
                expect(consume).not.toHaveBeenCalled();
            }
        },
    );
    it.each(['verify', 'consume'] as const)(
        'rejects bytes buffered during asynchronous %s',
        async (phase) => {
            let entered!: () => void;
            let unlock!: () => void;
            const started = new Promise<void>((resolve) => {
                entered = resolve;
            });
            const resumeCallback = new Promise<void>((resolve) => {
                unlock = resolve;
            });
            const { client, socket, peer } = await setup((remote) => remote.write(candidate));
            const consume = vi.fn(async () => {
                if (phase === 'consume') {
                    entered();
                    await resumeCallback;
                }

                return 42;
            });
            const pending = client.transactRaw({
                ...opts(),
                verifyCandidate: async () => {
                    if (phase === 'verify') {
                        entered();
                        await resumeCallback;
                    }

                    return true;
                },
                consumeCandidate: consume,
            });
            await started;
            socket.pause();
            socket.on('readable', () => {});
            const readable = once(socket, 'readable');
            peer.write(candidate.subarray(0, 3));
            await readable;
            expect(socket.readableLength).toBeGreaterThan(0);
            unlock();
            expect(await pending).toMatchObject({
                kind: 'failure',
                code: 'raw-extra-data',
                writeState: 'unknown',
            });

            if (phase === 'verify') {
                expect(consume).not.toHaveBeenCalled();
            }
        },
    );
    it('accepts a legitimate response split across separate data events', async () => {
        const { client, socket, peer } = await setup((remote) =>
            remote.write(candidate.subarray(0, 3)),
        );
        const verify = vi.fn(async (value: Uint8Array) => Buffer.from(value).equals(candidate));
        socket.once('data', () => {
            expect(verify).not.toHaveBeenCalled();
            peer.write(candidate.subarray(3));
        });
        expect(await client.transactRaw({ ...opts(), verifyCandidate: verify })).toMatchObject({
            kind: 'response',
            value: 3,
        });
        expect(verify).toHaveBeenCalledTimes(1);
    });
    it.each(['frame', 'partial'] as const)(
        'fails before callbacks on same chunk extra %s',
        async (extra) => {
            const verify = vi.fn(async () => true);
            const consume = vi.fn(async () => 1);
            const { client } = await setup((peer) =>
                peer.write(
                    Buffer.concat([
                        candidate,
                        extra === 'frame' ? candidate : candidate.subarray(0, 2),
                    ]),
                ),
            );
            expect(
                await client.transactRaw({
                    ...opts(),
                    verifyCandidate: verify,
                    consumeCandidate: consume,
                }),
            ).toMatchObject({ kind: 'failure', code: 'raw-extra-data', writeState: 'unknown' });
            expect(verify).not.toHaveBeenCalled();
            expect(consume).not.toHaveBeenCalled();
        },
    );
    it('closes on any later bytes while asynchronous verifier runs and ignores late completion', async () => {
        let unlock!: (v: boolean) => void;
        let started!: () => void;
        const entered = new Promise<void>((resolve) => {
            started = resolve;
        });
        const { client, peer } = await setup((s) => s.write(candidate));
        const consume = vi.fn(async () => 1);
        const pending = client.transactRaw({
            ...opts(),
            verifyCandidate: () => {
                started();
                return new Promise<boolean>((resolve) => {
                    unlock = resolve;
                });
            },
            consumeCandidate: consume,
        });
        await entered;
        peer.write(candidate.subarray(0, 1));
        expect(await pending).toMatchObject({
            kind: 'failure',
            code: 'raw-unexpected-data',
            writeState: 'unknown',
        });
        unlock(true);
        await Promise.resolve();
        expect(consume).not.toHaveBeenCalled();
    });
    it('shares sequence and pending with both old APIs, including uint32 wrap', async () => {
        let unlock!: (v: boolean) => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const { client } = await setup(
            (peer, frame) => {
                if (Buffer.from(frame).equals(wire)) {
                    peer.write(candidate);
                } else {
                    const r = request(frame);
                    peer.write(reply(r.seq, r.command, 'ok'));
                }
            },
            { initialSequence: 0xffffffff },
        );
        const first = client.transactRaw({
            ...opts(),
            verifyCandidate: () => {
                entered();
                return new Promise<boolean>((resolve) => {
                    unlock = resolve;
                });
            },
        });
        await gate;
        expect(await client.sendPacket('test', Buffer.alloc(0))).toMatchObject({
            success: false,
            errorMessage: 'single-flight capacity exceeded',
        });
        expect(await client.sendBoundPacket('test', Buffer.alloc(0))).toMatchObject({
            kind: 'failure',
            binding: null,
        });
        expect(await client.transactRaw(opts())).toMatchObject({
            kind: 'failure',
            code: 'busy',
            writeState: 'not-written',
        });
        unlock(true);
        expect(await first).toMatchObject({ kind: 'response', sequence: 0xffffffff });
        expect(await client.sendBoundPacket('next', Buffer.alloc(0))).toMatchObject({
            kind: 'response',
            binding: { sequence: 0, command: 'next' },
        });
    });
    it('copies exact request bytes before reading a mutating context getter', async () => {
        const original = Buffer.from(wire);
        const { client } = await setup((peer, frame) => {
            expect(Buffer.from(frame)).toEqual(wire);
            peer.write(candidate);
        });
        const result = await client.transactRaw({
            ...opts(),
            buildRequest: () => ({
                get frame() {
                    return original;
                },
                get context() {
                    original.fill(0);
                    return { id: 8 };
                },
            }),
        });
        expect(result).toMatchObject({ kind: 'response', value: 8 });
    });
    it('fails closed on invalid frame, false verifier or callback error without exposing details', async () => {
        const invalid = await setup(() => {});
        const write = vi.spyOn(invalid.socket, 'write');
        expect(
            await invalid.client.transactRaw({
                ...opts(),
                buildRequest: () => ({ frame: Buffer.alloc(4), context: { id: 0 } }),
            }),
        ).toMatchObject({ kind: 'failure', code: 'raw-build-failed', writeState: 'not-written' });
        expect(write).not.toHaveBeenCalled();
        const reject = await setup((peer) => peer.write(candidate));
        expect(
            await reject.client.transactRaw({ ...opts(), verifyCandidate: () => false }),
        ).toMatchObject({ kind: 'failure', code: 'raw-rejected', writeState: 'unknown' });
        const thrown = await setup((peer) => peer.write(candidate));
        expect(
            await thrown.client.transactRaw({
                ...opts(),
                verifyCandidate: () => {
                    throw new Error('private');
                },
            }),
        ).toMatchObject({ kind: 'failure', code: 'raw-callback-failed', writeState: 'unknown' });
    });
    it('detects callback reentry including after an await', async () => {
        const { client } = await setup((peer) => peer.write(candidate));
        const pending = client.transactRaw({
            ...opts(),
            verifyCandidate: async () => {
                await Promise.resolve();
                await client.sendPacket('reentry', Buffer.alloc(0));
                return true;
            },
        });
        expect(await pending).toMatchObject({
            kind: 'failure',
            code: 'callback-reentry',
            writeState: 'unknown',
        });
        expect((await client.whenClosed).code).toBe('callback-reentry');
    });
    it('wipes callback copies, and fails on close from inside consume', async () => {
        let verifierCopy!: Uint8Array;
        let consumerCopy!: Uint8Array;
        const { client } = await setup((peer) => peer.write(candidate));
        const result = await client.transactRaw({
            ...opts(),
            verifyCandidate: (data) => {
                verifierCopy = data;
                return true;
            },
            consumeCandidate: (data) => {
                consumerCopy = data;
                client.close();
                return 42;
            },
        });
        expect(result).toMatchObject({
            kind: 'failure',
            code: 'local-close',
            writeState: 'unknown',
        });
        expect(verifierCopy.every((byte) => byte === 0)).toBe(true);
        expect(consumerCopy.every((byte) => byte === 0)).toBe(true);
    });
    it('does not deliver late consume after cancellation or timeout', async () => {
        let release!: (value: number) => void;
        let notify!: () => void;
        const entered = new Promise<void>((resolve) => {
            notify = resolve;
        });
        const abort = new AbortController();
        const { client, peer } = await setup((s) => s.write(candidate));
        const pending = client.transactRaw({
            ...opts(),
            signal: abort.signal,
            consumeCandidate: () => {
                notify();
                return new Promise<number>((resolve) => {
                    release = resolve;
                });
            },
        });
        await entered;
        abort.abort();
        expect(await pending).toMatchObject({
            kind: 'failure',
            code: 'raw-cancelled',
            writeState: 'unknown',
        });
        release(42);
        await Promise.resolve();
        expect(peer.destroyed || (await client.whenClosed).code === 'raw-cancelled').toBe(true);
    });
    it('times out a delayed builder before writing and ignores its eventual frame', async () => {
        let finish!: (v: { frame: Uint8Array; context: { id: number } }) => void;
        const { client, socket } = await setup(() => {});
        const writes = vi.spyOn(socket, 'write');
        const pending = client.transactRaw({
            ...opts(),
            timeoutMs: 15,
            buildRequest: () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        });
        expect(await pending).toMatchObject({
            kind: 'failure',
            code: 'raw-timeout',
            writeState: 'not-written',
        });
        finish({ frame: wire, context: { id: 1 } });
        await Promise.resolve();
        expect(writes).not.toHaveBeenCalled();
    });
    it('returns an unknown outcome on asynchronous write failure', async () => {
        const { client, socket } = await setup(() => {});
        vi.spyOn(socket, 'write').mockImplementation(((
            _frame: Uint8Array,
            callback: (error: Error) => void,
        ) => {
            queueMicrotask(() => callback(new Error('sensitive transport details')));
            return true;
        }) as typeof socket.write);
        expect(await client.transactRaw(opts())).toEqual({
            kind: 'failure',
            code: 'raw-write-failed',
            writeState: 'unknown',
        });
    });
    it('fails closed when builder reenters raw sending after awaiting', async () => {
        const { client, socket } = await setup(() => {});
        const writes = vi.spyOn(socket, 'write');
        const pending = client.transactRaw({
            ...opts(),
            buildRequest: async () => {
                await Promise.resolve();
                await client.transactRaw(opts());
                return { frame: wire, context: { id: 1 } };
            },
        });
        expect(await pending).toMatchObject({
            kind: 'failure',
            code: 'callback-reentry',
            writeState: 'not-written',
        });
        expect(writes).not.toHaveBeenCalled();
    });
    it('blocks raw transactions during ordinary pending work', async () => {
        let release!: (value: Uint8Array) => void;
        const { client } = await setup(() => {}, {
            buildReserved: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });
        const pending = client.sendPacket('test', Buffer.alloc(0));
        expect(await client.transactRaw(opts())).toMatchObject({
            kind: 'failure',
            code: 'busy',
            writeState: 'not-written',
        });
        client.close();
        await pending;
        release(Buffer.alloc(0));
    });
    it('times out, cancels, and handles EOF before late callbacks can complete', async () => {
        let release!: (v: boolean) => void;
        const timed = await setup((peer) => peer.write(candidate));
        const timedResult = timed.client.transactRaw({
            ...opts(),
            timeoutMs: 15,
            verifyCandidate: () =>
                new Promise<boolean>((resolve) => {
                    release = resolve;
                }),
        });
        expect(await timedResult).toMatchObject({
            kind: 'failure',
            code: 'raw-timeout',
            writeState: 'unknown',
        });
        release(true);
        await Promise.resolve();
        let releaseBuild!: (v: { frame: Buffer; context: { id: number } }) => void;
        const cancelled = await setup(() => {});
        const abort = new AbortController();
        const pending = cancelled.client.transactRaw({
            ...opts(),
            signal: abort.signal,
            buildRequest: () =>
                new Promise((resolve) => {
                    releaseBuild = resolve;
                }),
        });
        abort.abort();
        expect(await pending).toMatchObject({
            kind: 'failure',
            code: 'raw-cancelled',
            writeState: 'not-written',
        });
        releaseBuild({ frame: wire, context: { id: 1 } });
        const eof = await setup((peer) => peer.end(candidate.subarray(0, 3)));
        expect(await eof.client.transactRaw(opts())).toMatchObject({
            kind: 'failure',
            code: 'truncated-stream',
            writeState: 'unknown',
        });
    });
});

describe('SSO12 profile snapshots and matched response binding', () => {
    it('returns isolated profile copies, excludes credentials and disallows reads after close', async () => {
        const guid = Buffer.from([1, 2, 3]);
        const { client } = await setup(() => {}, {
            guid,
            a2: Buffer.from('private-A2'),
            encryption: { type: 'd2', key, d2: Buffer.from('private-D2') },
        });
        guid.fill(9);
        const first = client.getProfile();
        const second = client.getProfile();
        expect(first).toEqual({
            uin: account,
            subAppId: 42,
            version: 'v1',
            guid: Uint8Array.of(1, 2, 3),
        });
        expect(Object.isFrozen(first)).toBe(true);
        expect(Object.keys(first).sort()).toEqual(['guid', 'subAppId', 'uin', 'version']);
        first.guid.fill(8);
        expect(second.guid).toEqual(Uint8Array.of(1, 2, 3));
        expect(client.getProfile().guid).toEqual(Uint8Array.of(1, 2, 3));
        const another = await setup(() => {}, {
            uin: '777',
            subAppId: 7,
            guid: Buffer.from([7]),
            version: 'v2',
        });
        expect(another.client.getProfile()).toEqual({
            uin: '777',
            subAppId: 7,
            guid: Uint8Array.of(7),
            version: 'v2',
        });
        client.close();
        expect(() => client.getProfile()).toThrow('connection closed');
        await client.whenClosed;
        expect(() => client.getProfile()).toThrow('connection closed');
        expect(second.guid).toEqual(Uint8Array.of(1, 2, 3));
    });
    it('binds the actual uint32 sequence across wrap and preserves nonzero response code', async () => {
        const signer = vi.fn(async () => Buffer.alloc(0));
        const { client } = await setup(
            (peer, frame) => {
                const r = request(frame);
                peer.write(
                    reply(r.seq, r.command, 'details', { code: r.command === 'bad' ? -7 : 0 }),
                );
            },
            { initialSequence: 0xffffffff, buildReserved: signer },
        );
        const first = await client.sendBoundPacket('bad', Buffer.from('body'));
        expect(first).toEqual({
            kind: 'response',
            binding: { sequence: 0xffffffff, command: 'bad' },
            result: {
                success: false,
                gotResponse: true,
                errorCode: -7,
                errorMessage: 'failed',
                responseData: Buffer.from('details'),
            },
        });
        expect(Object.isFrozen(first.binding)).toBe(true);
        const second = await client.sendBoundPacket('next', Buffer.alloc(0));
        expect(second).toMatchObject({
            kind: 'response',
            binding: { sequence: 0, command: 'next' },
            result: { success: true, gotResponse: true },
        });
        expect(signer.mock.calls).toHaveLength(2);
        client.close();
        await client.whenClosed;
        expect(first.binding).toEqual({ sequence: 0xffffffff, command: 'bad' });
    });
    it('shares one pending slot across both APIs in both directions', async () => {
        let release!: (value: Uint8Array) => void;
        const { client } = await setup(
            (peer, frame) => {
                const r = request(frame);
                peer.write(reply(r.seq, r.command, 'ok'));
            },
            {
                buildReserved: () =>
                    new Promise((resolve) => {
                        release = resolve;
                    }),
            },
        );
        const legacy = client.sendPacket('legacy', Buffer.alloc(0));
        expect(await client.sendBoundPacket('bound', Buffer.alloc(0))).toMatchObject({
            kind: 'failure',
            binding: null,
            result: { errorMessage: 'single-flight capacity exceeded' },
        });
        release(Buffer.alloc(0));
        expect(await legacy).toMatchObject({ success: true });
        const bound = client.sendBoundPacket('bound', Buffer.alloc(0));
        expect(await client.sendPacket('legacy', Buffer.alloc(0))).toMatchObject({
            success: false,
            errorMessage: 'single-flight capacity exceeded',
        });
        release(Buffer.alloc(0));
        expect(await bound).toMatchObject({
            kind: 'response',
            binding: { sequence: 2, command: 'bound' },
        });
    });
    it.each([
        ['sequence', 2, 'test', account, 'sequence-mismatch'],
        ['command', 1, 'wrong', account, 'command-mismatch'],
        ['UIN', 1, 'test', '999', 'uin-mismatch'],
    ] as const)('never binds a mismatched %s', async (_name, sequence, command, uin, closeCode) => {
        const { client } = await setup((peer) =>
            peer.write(reply(sequence, command, 'x', { uin })),
        );
        expect(await client.sendBoundPacket('test', Buffer.alloc(0))).toMatchObject({
            kind: 'failure',
            binding: null,
            result: { success: false, gotResponse: false },
        });
        expect((await client.whenClosed).code).toBe(closeCode);
    });
    it('exposes caller verifier policy rather than asserting server authentication', async () => {
        const { client } = await setup((peer) => peer.write(reply(1, 'qr', 'ok', { uin: '777' })), {
            uin: '0',
            verifyResponseUin: (requested, actual) => requested === '0' && actual === '777',
        });
        expect(await client.sendBoundPacket('qr', Buffer.alloc(0))).toMatchObject({
            kind: 'response',
            binding: { sequence: 1, command: 'qr' },
        });
    });
    it('returns no binding for invalid input, signer error, unsupported push, or early response', async () => {
        const invalid = await setup(() => {});
        expect(await invalid.client.sendBoundPacket('', Buffer.alloc(0))).toMatchObject({
            kind: 'failure',
            binding: null,
        });
        const signer = await setup(() => {}, {
            buildReserved: async () => {
                throw new Error('private');
            },
        });
        expect(await signer.client.sendBoundPacket('x', Buffer.alloc(0))).toMatchObject({
            kind: 'failure',
            binding: null,
        });
        const push = await setup((peer) => peer.write(reply(1, 'x', 'x')), {
            classifyIncoming: () => 'push',
        });
        expect(await push.client.sendBoundPacket('x', Buffer.alloc(0))).toMatchObject({
            kind: 'failure',
            binding: null,
        });
        let release!: (value: Uint8Array) => void;
        const early = await setup(() => {}, {
            buildReserved: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });
        const pending = early.client.sendBoundPacket('x', Buffer.alloc(0));
        early.peer.write(reply(1, 'x', 'x'));
        expect(await pending).toMatchObject({ kind: 'failure', binding: null });
        release(Buffer.alloc(0));
    });
    it('does not bind timeout, late response, cancellation or close during preparation', async () => {
        const late = await setup((peer, frame) => {
            const r = request(frame);
            setTimeout(() => {
                if (!peer.destroyed) {
                    peer.write(reply(r.seq, r.command, 'late'));
                }
            }, 50);
        });
        expect(await late.client.sendBoundPacket('x', Buffer.alloc(0), 10)).toMatchObject({
            kind: 'failure',
            binding: null,
            result: { errorCode: -2 },
        });
        await late.client.whenClosed;
        expect(await late.client.sendBoundPacket('x', Buffer.alloc(0))).toMatchObject({
            kind: 'failure',
            binding: null,
        });
        let release!: (value: Uint8Array) => void;
        const cancel = await setup(() => {}, {
            buildReserved: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });
        const abort = new AbortController();
        const pending = cancel.client.sendBoundPacket('x', Buffer.alloc(0), 1000, abort.signal);
        abort.abort();
        expect(await pending).toMatchObject({
            kind: 'failure',
            binding: null,
            result: { errorCode: -3 },
        });
        release(Buffer.alloc(0));
        await cancel.client.whenClosed;
        const closed = await setup(() => {}, {
            buildReserved: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });
        const pendingClose = closed.client.sendBoundPacket('x', Buffer.alloc(0));
        closed.client.close();
        expect(await pendingClose).toMatchObject({ kind: 'failure', binding: null });
        release(Buffer.alloc(0));
        await closed.client.whenClosed;
    });
});

describe('synthetic SSO12 loopback transport', () => {
    it('writes D2Auth and snapshots signer body, A2, GUID, key and ticket', async () => {
        const material = Buffer.from(key),
            ticket = Buffer.from('ticket'),
            a2 = Buffer.from('A2'),
            guid = Buffer.from('GUID'),
            body = Buffer.from('payload');
        let release!: () => void;
        let observed: ReturnType<typeof request> | undefined;
        const { client } = await setup(
            (peer, frame) => {
                observed = request(frame, key);
                peer.write(reply(observed.seq, observed.command, 'ok', { flag: 1, key }));
            },
            {
                encryption: { type: 'd2', key: material, d2: ticket },
                a2,
                guid,
                buildReserved: async (input) => {
                    expect(input.body.toString()).toBe('payload');
                    input.body.fill(0);
                    await new Promise<void>((resolve) => {
                        release = resolve;
                    });
                    return Buffer.from('metadata');
                },
            },
        );
        const result = client.sendPacket('test', body);
        material.fill(0);
        ticket.fill(0);
        a2.fill(0);
        guid.fill(0);
        body.fill(0);
        release();
        expect(await result).toMatchObject({ success: true, responseData: Buffer.from('ok') });
        expect(observed).toMatchObject({
            seq: 1,
            command: 'test',
            uin: account,
            flag: 1,
            ticket: Buffer.from('ticket'),
            a2: Buffer.from('A2'),
            guid: Buffer.from('GUID').toString('hex'),
            version: 'v1',
            body: Buffer.from('payload'),
        });
    });
    it('separates fragmented and coalesced frames and fails closed on push', async () => {
        const classify = vi.fn((response) =>
            response.command === 'push' ? ('push' as const) : ('response' as const),
        );
        const { client } = await setup(
            (peer, frame) => {
                const r = request(frame);
                const all = Buffer.concat([
                    reply(r.seq, r.command, 'ok'),
                    reply(90, 'push', 'notice'),
                ]);
                peer.write(all.subarray(0, 3));
                setImmediate(() => peer.write(all.subarray(3)));
            },
            { classifyIncoming: classify },
        );
        expect(await client.sendPacket('test', Buffer.from('x'))).toMatchObject({ success: true });
        expect(await client.whenClosed).toEqual({
            kind: 'protocol-error',
            code: 'push-unsupported',
        });
        expect(classify).toHaveBeenCalledTimes(2);
    });
    it.each([
        ['sequence', 2, 'test', account, 'sequence-mismatch'],
        ['command', 1, 'other', account, 'command-mismatch'],
        ['UIN', 1, 'test', '999', 'uin-mismatch'],
    ] as const)('closes on %s mismatch', async (_name, seq, command, uin, code) => {
        const { client } = await setup((peer) => peer.write(reply(seq, command, 'x', { uin })));
        expect(await client.sendPacket('test', Buffer.alloc(0))).toMatchObject({
            success: false,
            gotResponse: false,
        });
        expect((await client.whenClosed).code).toBe(code);
    });
    it('preserves a nonzero service return code and its response body', async () => {
        const { client } = await setup((peer, frame) => {
            const r = request(frame);
            peer.write(reply(r.seq, r.command, 'details', { code: -7 }));
        });
        expect(await client.sendPacket('test', Buffer.alloc(0))).toEqual({
            success: false,
            gotResponse: true,
            errorCode: -7,
            errorMessage: 'failed',
            responseData: Buffer.from('details'),
        });
    });
    it('requires an explicit UIN policy for a different response UIN', async () => {
        const verify = vi.fn(
            (requested: string, actual: string) => requested === '0' && actual === '777',
        );
        const { client } = await setup((peer) => peer.write(reply(1, 'qr', 'x', { uin: '777' })), {
            uin: '0',
            verifyResponseUin: verify,
        });
        expect(await client.sendPacket('qr', Buffer.alloc(0))).toMatchObject({ success: true });
        expect(verify).toHaveBeenCalledWith('0', '777');
    });
    it('times out once, closes, and ignores a signer that resolves after the deadline', async () => {
        let release!: (value: Uint8Array) => void;
        const { client, socket } = await setup(() => {}, {
            buildReserved: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });
        const writes = vi.spyOn(socket, 'write');
        const p = client.sendPacket('test', Buffer.from('secret'), 15);
        expect(await client.sendPacket('second', Buffer.alloc(0))).toMatchObject({
            success: false,
            errorMessage: 'single-flight capacity exceeded',
        });
        expect(await p).toMatchObject({ errorCode: -2 });
        expect(await client.whenClosed).toEqual({ kind: 'local', code: 'timeout' });
        release(Buffer.alloc(0));
        await Promise.resolve();
        expect(writes).not.toHaveBeenCalled();
    });
    it('closes on post-write timeout and never replays a late response', async () => {
        let seen = 0;
        const { client } = await setup((peer, frame) => {
            seen++;
            const r = request(frame);
            setTimeout(() => {
                if (!peer.destroyed) {
                    peer.write(reply(r.seq, r.command, 'late'));
                }
            }, 50);
        });
        expect(await client.sendPacket('test', Buffer.alloc(0), 10)).toMatchObject({
            errorCode: -2,
        });
        expect((await client.whenClosed).code).toBe('timeout');
        expect(await client.sendPacket('test', Buffer.alloc(0))).toMatchObject({ success: false });
        expect(seen).toBe(1);
    });
    it('settles and cleans secrets if an AbortSignal removal throws', async () => {
        let release!: (value: Uint8Array) => void;
        const controller = new AbortController();
        vi.spyOn(controller.signal, 'removeEventListener').mockImplementation(() => {
            throw new Error('secret removal error');
        });
        const { client, socket } = await setup(() => {}, {
            encryption: { type: 'd2', key, d2: Buffer.from('ticket') },
            a2: Buffer.from('private-a2'),
            guid: Buffer.from('private-guid'),
            buildReserved: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });
        const writes = vi.spyOn(socket, 'write');
        const pending = client.sendPacket('test', Buffer.alloc(0), 1000, controller.signal);
        controller.abort();
        expect(await pending).toMatchObject({ errorCode: -3 });
        expect(await client.whenClosed).toEqual({ kind: 'local', code: 'cancelled' });
        const internal = client as unknown as {
            encryption: { key: Uint8Array; d2: Uint8Array };
            guid: Uint8Array;
            a2: Uint8Array;
        };
        expect(
            [
                ...internal.encryption.key,
                ...internal.encryption.d2,
                ...internal.a2,
                ...internal.guid,
            ].every((v) => v === 0),
        ).toBe(true);
        expect(socket.destroyed).toBe(true);
        release(Buffer.alloc(0));
        await Promise.resolve();
        expect(writes).not.toHaveBeenCalled();
    });
    it('keeps an undeletable old abort callback from cancelling the next request', async () => {
        const controller = new AbortController();
        vi.spyOn(controller.signal, 'removeEventListener').mockImplementation(() => {
            throw new Error('fixture');
        });
        const { client } = await setup((peer, frame) => {
            const r = request(frame);
            peer.write(reply(r.seq, r.command, 'ok'));
        });
        expect(
            (await client.sendPacket('one', Buffer.alloc(0), 1000, controller.signal)).success,
        ).toBe(true);
        const next = client.sendPacket('two', Buffer.alloc(0));
        controller.abort();
        expect(await next).toMatchObject({ success: true, responseData: Buffer.from('ok') });
    });
    it('handles failed AbortSignal listener registration without leaking its error', async () => {
        const controller = new AbortController();
        vi.spyOn(controller.signal, 'addEventListener').mockImplementation(() => {
            throw new Error('secret registration error');
        });
        const { client, socket } = await setup(() => {});
        const writes = vi.spyOn(socket, 'write');
        expect(
            await client.sendPacket('test', Buffer.alloc(0), 1000, controller.signal),
        ).toMatchObject({ success: false, errorMessage: 'cancellation setup failed' });
        expect(await client.whenClosed).toEqual({
            kind: 'handler-error',
            code: 'cancellation-setup-failed',
        });
        expect(socket.destroyed).toBe(true);
        expect(writes).not.toHaveBeenCalled();
    });
    it('supports cancellation and resolves one close promise after socket close', async () => {
        let release!: (value: Uint8Array) => void;
        const { client, socket } = await setup(() => {}, {
            buildReserved: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });
        const spy = vi.spyOn(socket, 'write');
        const abort = new AbortController();
        const pending = client.sendPacket('test', Buffer.alloc(0), 1000, abort.signal);
        const closed = client.whenClosed;
        abort.abort();
        client.close();
        expect(await pending).toMatchObject({ errorCode: -3 });
        expect(await closed).toEqual({ kind: 'local', code: 'cancelled' });
        expect(client.whenClosed).toBe(closed);
        release(Buffer.alloc(0));
        await Promise.resolve();
        expect(spy).not.toHaveBeenCalled();
    });
    it('handles remote EOF during delayed metadata and incomplete framing without exposing errors', async () => {
        let release!: (value: Uint8Array) => void;
        const { client, peer, socket } = await setup(() => {}, {
            buildReserved: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });
        const writes = vi.spyOn(socket, 'write');
        const pending = client.sendPacket('test', Buffer.alloc(0));
        peer.end(Buffer.from([0, 0, 0]));
        expect(await pending).toMatchObject({
            success: false,
            errorMessage: 'truncated service stream',
        });
        expect((await client.whenClosed).code).toBe('truncated-stream');
        release(Buffer.alloc(0));
        await Promise.resolve();
        expect(writes).not.toHaveBeenCalled();
    });
    it('does not send on invalid profile, builder failure, or write capacity exhaustion', async () => {
        const { client, socket } = await setup(() => {}, { maxWriteBufferBytes: 30 });
        const write = vi.spyOn(socket, 'write');
        expect(await client.sendPacket('test', Buffer.alloc(31))).toMatchObject({
            success: false,
            errorMessage: 'transport capacity exceeded',
        });
        expect(await client.sendPacket('test', Buffer.alloc(0))).toMatchObject({ success: false });
        expect(write).not.toHaveBeenCalled();
        expect(
            () =>
                new Sso12PacketClient({
                    socket,
                    uin: account,
                    encryption: { type: 'none' } as never,
                    subAppId: 1,
                    guid: Buffer.from([1]),
                    version: 'v',
                    a2: Buffer.alloc(0),
                    buildReserved: async () => Buffer.alloc(0),
                    classifyIncoming: () => 'response',
                }),
        ).toThrow();
        const bad = await setup(() => {}, {
            buildReserved: async () => {
                throw new Error('private metadata');
            },
        });
        expect(await bad.client.sendPacket('test', Buffer.alloc(0))).toMatchObject({
            success: false,
            errorMessage: 'request preparation failed',
        });
    });
    it('fails a premature response while metadata is pending', async () => {
        let release!: (value: Uint8Array) => void;
        const { client, peer, socket } = await setup(() => {}, {
            buildReserved: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });
        const writes = vi.spyOn(socket, 'write');
        const pending = client.sendPacket('test', Buffer.alloc(0));
        peer.write(reply(1, 'test', 'early'));
        expect(await pending).toMatchObject({
            success: false,
            errorMessage: 'response before request write',
        });
        expect((await client.whenClosed).code).toBe('response-before-write');
        release(Buffer.alloc(0));
        await Promise.resolve();
        expect(writes).not.toHaveBeenCalled();
    });
    it('counts synchronous body snapshot work against the original deadline', async () => {
        const { client, socket } = await setup(() => {});
        const writes = vi.spyOn(socket, 'write');
        const body = new Uint8Array([1]);
        let reads = 0;
        Object.defineProperty(body, 'length', {
            get: () => {
                reads++;

                if (reads === 2) {
                    const end = performance.now() + 40;

                    while (performance.now() < end) {
                        /* simulate slow snapshot */
                    }
                }

                return 1;
            },
        });
        expect(await client.sendPacket('test', body, 10)).toMatchObject({
            success: false,
            errorCode: -2,
        });
        expect(reads).toBeGreaterThanOrEqual(2);
        expect((await client.whenClosed).code).toBe('timeout');
        expect(writes).not.toHaveBeenCalled();
    });
    it('checks the same deadline again after a blocking socket write', async () => {
        const { client, socket } = await setup(() => {});
        vi.spyOn(socket, 'write').mockImplementation((() => {
            const end = performance.now() + 40;

            while (performance.now() < end) {
                /* simulate blocking write */
            }

            return true;
        }) as typeof socket.write);
        expect(await client.sendPacket('test', Buffer.alloc(0), 10)).toMatchObject({
            errorCode: -2,
        });
        expect((await client.whenClosed).code).toBe('timeout');
    });
    it('checks deadline even if a synchronous builder blocks before rejecting', async () => {
        const { client, socket } = await setup(() => {}, {
            buildReserved: async () => {
                const deadline = performance.now() + 20;

                while (performance.now() < deadline) {
                    /* blocking signer */
                }

                throw new Error('private');
            },
        });
        const writes = vi.spyOn(socket, 'write');
        expect(await client.sendPacket('test', Buffer.alloc(0), 2)).toMatchObject({
            errorCode: -2,
        });
        expect((await client.whenClosed).code).toBe('timeout');
        expect(writes).not.toHaveBeenCalled();
    });
    it('preserves matching despite classifier mutations and rejects invalid classification', async () => {
        const good = await setup((peer) => peer.write(reply(1, 'test', 'original')), {
            classifyIncoming: (r) => {
                r.sequence = 99;
                r.command = 'bad';
                r.body.fill(0);
                return 'response';
            },
        });
        expect(await good.client.sendPacket('test', Buffer.alloc(0))).toMatchObject({
            success: true,
            responseData: Buffer.from('original'),
        });
        const bad = await setup((peer) => peer.write(reply(1, 'test', 'x')), {
            classifyIncoming: () => 'unknown' as 'response',
        });
        expect(await bad.client.sendPacket('test', Buffer.alloc(0))).toMatchObject({
            success: false,
        });
        expect((await bad.client.whenClosed).code).toBe('invalid-classification');
    });
    it('isolates two clients and rejects callback failures without revealing secrets', async () => {
        const a = await setup((peer, frame) => {
            const r = request(frame);
            peer.write(reply(r.seq, r.command, 'first'));
        });
        const b = await setup(
            (peer, frame) => {
                const r = request(frame);
                peer.write(reply(r.seq, r.command, 'second', { uin: '888' }));
            },
            { uin: '888' },
        );
        const [x, y] = await Promise.all([
            a.client.sendPacket('a', Buffer.alloc(0)),
            b.client.sendPacket('b', Buffer.alloc(0)),
        ]);
        expect(x.responseData).toEqual(Buffer.from('first'));
        expect(y.responseData).toEqual(Buffer.from('second'));
        const c = await setup((peer) => peer.write(reply(1, 'test', 'x')), {
            classifyIncoming: () => {
                throw new Error('secret');
            },
        });
        expect(await c.client.sendPacket('test', Buffer.alloc(0))).toMatchObject({
            errorMessage: 'incoming classification failed',
        });
        expect(JSON.stringify(await c.client.whenClosed)).not.toContain('secret');
    });
});
