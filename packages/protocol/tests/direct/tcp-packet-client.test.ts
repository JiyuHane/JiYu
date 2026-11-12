import { createServer, createConnection, type Socket, type Server } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TcpPacketClient } from '../../src/direct/tcp-packet-client';
import { ServiceFrameDecoder } from '../../src/direct/service-stream';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';

const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const uin = '123456';
const servers: Server[] = [];
const sockets: Socket[] = [];
const clients: TcpPacketClient[] = [];

function field(value: Uint8Array): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length + 4);
    return Buffer.concat([length, value]);
}

function int(value: number): Buffer {
    const result = Buffer.alloc(4);
    result.writeInt32BE(value);
    return result;
}

function reply(sequence: number, command: string, body: string, account = uin, code = 0): Buffer {
    const inner = Buffer.concat([
        field(
            Buffer.concat([
                int(sequence | 0),
                int(code),
                field(Buffer.from(code ? 'failed' : '')),
                field(Buffer.from(command)),
                field(Buffer.alloc(0)),
                int(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(Buffer.from(body)),
    ]);
    const encrypted = qqTeaEncrypt(inner, key);
    const accountBytes = Buffer.from(account);
    return Buffer.concat([
        int(14 + accountBytes.length + encrypted.length),
        int(13),
        Buffer.from([1, 0]),
        int(accountBytes.length + 4),
        accountBytes,
        encrypted,
    ]);
}

function request(frame: Uint8Array): { sequence: number; command: string; body: Buffer } {
    const bytes = Buffer.from(frame);
    const sequence = bytes.readUInt32BE(9);
    const uinLength = bytes.readUInt32BE(14);
    const plain = Buffer.from(qqTeaDecrypt(bytes.subarray(14 + uinLength), key));
    const headerLength = plain.readUInt32BE(0);
    const commandLength = plain.readUInt32BE(4);
    return {
        sequence,
        command: plain.subarray(8, 4 + commandLength).toString(),
        body: plain.subarray(headerLength + 4),
    };
}

async function setup(
    onRequest: (socket: Socket, frame: Uint8Array) => void,
    options: Partial<ConstructorParameters<typeof TcpPacketClient>[0]> = {},
): Promise<{ client: TcpPacketClient; socket: Socket }> {
    const server = createServer((peer) => {
        sockets.push(peer);
        const decoder = new ServiceFrameDecoder();
        peer.on('data', (chunk) => {
            for (const frame of decoder.push(chunk)) {
                onRequest(peer, frame);
            }
        });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();

    if (!address || typeof address === 'string') {
        throw new Error('missing local address');
    }

    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    sockets.push(socket);
    await once(socket, 'connect');
    const client = new TcpPacketClient({
        socket,
        uin,
        d2Key: key,
        buildReserved: async () => new Uint8Array(),
        classifyIncoming: (response) => (response.command === 'push' ? 'push' : 'response'),
        ...options,
    });
    clients.push(client);
    return { client, socket };
}

afterEach(async () => {
    for (const client of clients.splice(0)) {
        client.close();
    }

    for (const socket of sockets.splice(0)) {
        socket.destroy();
    }

    await Promise.all(
        servers
            .splice(0)
            .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    vi.restoreAllMocks();
});

describe('TCP packet client with synthetic loopback peers', () => {
    it('waits for actual socket close, preserves the first reason and supports late subscribers', async () => {
        const { client, socket } = await setup(() => {});
        const destroy = socket.destroy.bind(socket);
        const intercept = vi.spyOn(socket, 'destroy').mockImplementation(() => socket);
        const pending = client.sendPacket('a', Buffer.alloc(0));
        const originalPromise = client.whenClosed;
        const listener = vi.fn();
        void originalPromise.then(listener);
        client.close();
        client.close();
        expect(await pending).toMatchObject({ success: false, gotResponse: false });
        expect((client as unknown as { key: Uint8Array }).key).toEqual(new Uint8Array(16));
        expect(intercept).toHaveBeenCalledTimes(1);
        await Promise.resolve();
        expect(listener).not.toHaveBeenCalled();
        intercept.mockRestore();
        destroy();
        expect(await originalPromise).toEqual({ kind: 'local', code: 'local-close' });
        expect(socket.closed).toBe(true);
        expect(client.whenClosed).toBe(originalPromise);
        expect(await client.whenClosed).toEqual({ kind: 'local', code: 'local-close' });
        expect(listener).toHaveBeenCalledTimes(1);
    });
    it('reports clean peer EOF after the socket closes and rejects in-flight requests', async () => {
        const { client, socket } = await setup((peer) => peer.end());
        const result = client.sendPacket('a', Buffer.alloc(0));
        expect(await client.whenClosed).toEqual({ kind: 'remote', code: 'remote-end' });
        expect(socket.closed).toBe(true);
        expect(await result).toMatchObject({ success: false, gotResponse: false });
        client.close();
        expect(await client.whenClosed).toEqual({ kind: 'remote', code: 'remote-end' });
    });
    it('reports transport errors without revealing socket errors', async () => {
        const { client, socket } = await setup(() => {});
        const result = client.sendPacket('a', Buffer.alloc(0));
        socket.destroy(new Error('secret transport details'));
        expect(await client.whenClosed).toEqual({ kind: 'transport-error', code: 'socket-error' });
        expect(await result).toMatchObject({
            success: false,
            gotResponse: false,
            errorMessage: 'socket error',
        });
        client.close();
        expect(await client.whenClosed).toEqual({ kind: 'transport-error', code: 'socket-error' });
        expect(JSON.stringify(await client.whenClosed)).not.toContain('secret');
    });
    it('reports a socket closed without EOF as an unexpected transport close', async () => {
        let release!: (value: Uint8Array) => void;
        const { client, socket } = await setup(() => {}, {
            buildReserved: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });
        const result = client.sendPacket('a', Buffer.alloc(0));
        socket.destroy();
        expect(await client.whenClosed).toEqual({ kind: 'transport-error', code: 'socket-closed' });
        expect(await result).toMatchObject({ success: false, gotResponse: false });
        release(Buffer.alloc(0));
    });
    it('reports a truncated frame at EOF as a protocol error', async () => {
        const { client } = await setup((peer) => peer.end(Buffer.from([0, 0, 0])));
        const result = client.sendPacket('a', Buffer.alloc(0));
        expect(await client.whenClosed).toEqual({
            kind: 'protocol-error',
            code: 'truncated-stream',
        });
        expect(await result).toMatchObject({ success: false, gotResponse: false });
    });
    it('reports protocol errors separately from handler errors', async () => {
        const invalid = await setup((peer) => peer.write(Buffer.from('ffffffff', 'hex')));
        const pending = invalid.client.sendPacket('a', Buffer.alloc(0));
        expect(await invalid.client.whenClosed).toEqual({
            kind: 'protocol-error',
            code: 'invalid-response',
        });
        expect(await pending).toMatchObject({ success: false, gotResponse: false });
        const throwing = await setup(
            (peer, frame) => {
                const r = request(frame);
                peer.write(reply(r.sequence, r.command, 'data'));
            },
            {
                classifyIncoming: () => {
                    throw new Error('sensitive handler details');
                },
            },
        );
        const waiting = throwing.client.sendPacket('a', Buffer.alloc(0));
        expect(await throwing.client.whenClosed).toEqual({
            kind: 'handler-error',
            code: 'classification-failed',
        });
        expect(await waiting).toMatchObject({ success: false, gotResponse: false });
        expect(JSON.stringify(await throwing.client.whenClosed)).not.toContain('sensitive');
    });
    it('handles fragmentation, coalescing, out-of-order replies, push and signed sequence conversion', async () => {
        const requests: ReturnType<typeof request>[] = [];
        const pushed: number[] = [];
        const reserved = vi.fn(async ({ sequence }: { sequence: number }) =>
            Buffer.from([sequence & 255]),
        );
        const { client } = await setup(
            (peer, frame) => {
                requests.push(request(frame));

                if (requests.length === 2) {
                    const all = Buffer.concat([
                        reply(42, 'push', 'p'),
                        reply(requests[1].sequence, requests[1].command, 'second', uin, -7),
                        reply(requests[0].sequence, requests[0].command, 'first'),
                    ]);
                    peer.write(all.subarray(0, 3));
                    setImmediate(() => peer.write(all.subarray(3)));
                }
            },
            {
                initialSequence: 0x7fffffff,
                buildReserved: reserved,
                onPush: (value) => pushed.push(value.sequence),
            },
        );
        const [first, second] = await Promise.all([
            client.sendPacket('a', Buffer.from('A')),
            client.sendPacket('b', Buffer.from('B')),
        ]);
        expect(requests.map((item) => item.sequence)).toEqual([0x7fffffff, 0x80000000]);
        expect(requests.map((item) => item.body.toString())).toEqual(['A', 'B']);
        expect(reserved.mock.calls.map(([value]) => value.sequence)).toEqual([
            0x7fffffff, 0x80000000,
        ]);
        expect(first).toEqual({
            success: true,
            gotResponse: true,
            errorCode: 0,
            errorMessage: '',
            responseData: Buffer.from('first'),
        });
        expect(second).toEqual({
            success: false,
            gotResponse: true,
            errorCode: -7,
            errorMessage: 'failed',
            responseData: Buffer.from('second'),
        });
        expect(pushed).toEqual([42]);
    });
    it('fails pending work rather than silently dropping a push without a handler', async () => {
        const { client } = await setup(
            (peer, frame) => {
                const r = request(frame);
                peer.write(reply(r.sequence, r.command, 'push'));
            },
            { classifyIncoming: () => 'push' },
        );
        expect(await client.sendPacket('a', Buffer.alloc(0))).toMatchObject({
            success: false,
            gotResponse: false,
            errorMessage: 'push handler missing',
        });
    });

    it('closes and fails every pending request on wrong account', async () => {
        const { client } = await setup((peer, frame) => {
            const r = request(frame);
            peer.write(reply(r.sequence, r.command, 'bad', '999999'));
        });
        const results = await Promise.all([
            client.sendPacket('a', Buffer.alloc(0)),
            client.sendPacket('b', Buffer.alloc(0)),
        ]);
        expect(results.every((result) => !result.success && !result.gotResponse)).toBe(true);
        expect((await client.sendPacket('a', Buffer.alloc(0))).errorMessage).toMatch(/closed/);
    });
    it('times out and discards late replies rather than dispatching them as pushes', async () => {
        const pushes: string[] = [];
        const { client } = await setup(
            (peer, frame) => {
                const r = request(frame);
                setTimeout(() => {
                    if (!peer.destroyed) {
                        peer.write(reply(r.sequence, r.command, 'late'));
                    }
                }, 40);
            },
            { onPush: (r) => pushes.push(Buffer.from(r.body).toString()) },
        );
        expect(await client.sendPacket('a', Buffer.alloc(0), 10)).toMatchObject({
            success: false,
            gotResponse: false,
            errorCode: -2,
        });
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(pushes).toEqual([]);
    });
    it('routes caller-classified pushes even when sequence and command collide', async () => {
        const pushes: string[] = [];
        const { client } = await setup(
            (peer, frame) => {
                const r = request(frame);
                peer.write(
                    Buffer.concat([
                        reply(r.sequence, r.command, 'push:same'),
                        reply(r.sequence, 'other', 'push:other'),
                        reply(r.sequence, r.command, 'actual'),
                    ]),
                );
            },
            {
                classifyIncoming: (r) =>
                    Buffer.from(r.body).toString().startsWith('push:') ? 'push' : 'response',
                onPush: (r) => pushes.push(Buffer.from(r.body).toString()),
            },
        );
        expect(await client.sendPacket('a', Buffer.alloc(0))).toMatchObject({
            success: true,
            responseData: Buffer.from('actual'),
        });
        expect(pushes).toEqual(['push:same', 'push:other']);
    });
    it('fails closed on unissued responses and invalid classification', async () => {
        const one = await setup((peer) => peer.write(reply(100, 'a', 'bad')));
        expect(await one.client.sendPacket('a', Buffer.alloc(0))).toMatchObject({
            success: false,
            errorMessage: 'response has unissued sequence',
        });
        const two = await setup(
            (peer, frame) => {
                const r = request(frame);
                peer.write(reply(r.sequence, r.command, 'bad'));
            },
            { classifyIncoming: () => 'invalid' as 'response' },
        );
        expect(await two.client.sendPacket('a', Buffer.alloc(0))).toMatchObject({
            success: false,
            errorMessage: 'invalid incoming classification',
        });
    });
    it('closes on classifier or push callback exceptions without leaking their messages', async () => {
        const one = await setup(
            (peer, frame) => {
                const r = request(frame);
                peer.write(reply(r.sequence, r.command, 'bad'));
            },
            {
                classifyIncoming: () => {
                    throw new Error('secret');
                },
            },
        );
        expect(await one.client.sendPacket('a', Buffer.alloc(0))).toMatchObject({
            success: false,
            errorMessage: 'incoming classification callback failed',
        });
        const two = await setup(
            (peer, frame) => {
                const r = request(frame);
                peer.write(reply(r.sequence, 'push', 'bad'));
            },
            {
                onPush: () => {
                    throw new Error('secret');
                },
            },
        );
        expect(await two.client.sendPacket('a', Buffer.alloc(0))).toMatchObject({
            success: false,
            errorMessage: 'push callback failed',
        });
        expect(await two.client.whenClosed).toEqual({
            kind: 'handler-error',
            code: 'push-handler-failed',
        });
    });
    it('checks the monotonic deadline before writing after synchronous preparation', async () => {
        const { client, socket } = await setup(() => {}, {
            buildReserved: async () => {
                const deadline = performance.now() + 30;

                while (performance.now() < deadline) {
                    /* simulate blocking preparation */
                }

                return Buffer.alloc(0);
            },
        });
        const writes = vi.spyOn(socket, 'write');
        expect(await client.sendPacket('a', Buffer.alloc(0), 5)).toMatchObject({
            success: false,
            gotResponse: false,
            errorCode: -2,
        });
        expect(writes).not.toHaveBeenCalled();
    });
    it('fails closed when a response arrives before metadata preparation finishes', async () => {
        let release!: (value: Uint8Array) => void;
        const pushes: string[] = [];
        const { client, socket } = await setup(() => {}, {
            buildReserved: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
            onPush: (r) => pushes.push(r.command),
        });
        const result = client.sendPacket('a', Buffer.alloc(0));
        const peer = sockets.find((candidate) => candidate !== socket);

        if (!peer) {
            throw new Error('missing loopback peer');
        }

        peer.write(reply(1, 'a', 'early'));
        expect(await result).toMatchObject({
            success: false,
            gotResponse: false,
            errorMessage: 'response before request write',
        });
        expect(pushes).toEqual([]);
        release(Buffer.alloc(0));
    });
    it('fails pending metadata on close and never writes when the builder resolves later', async () => {
        let release!: (value: Uint8Array) => void;
        const { client, socket } = await setup(() => {}, {
            buildReserved: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });
        const writes = vi.spyOn(socket, 'write');
        const result = client.sendPacket('a', Buffer.from('request'));
        client.close();
        expect(await client.whenClosed).toEqual({ kind: 'local', code: 'local-close' });
        expect(await result).toMatchObject({ success: false, gotResponse: false });
        release(Buffer.alloc(0));
        await Promise.resolve();
        expect(writes).not.toHaveBeenCalled();
    });
    it('reports metadata failures without exposing callback errors', async () => {
        const { client } = await setup(() => {}, {
            buildReserved: async () => {
                throw new Error('sensitive');
            },
        });
        const result = await client.sendPacket('a', Buffer.alloc(0));
        expect(result).toMatchObject({
            success: false,
            gotResponse: false,
            errorMessage: 'request preparation or write failed',
        });
    });
    it('stops writes when socket signals backpressure until drain', async () => {
        const { client, socket } = await setup(() => {});
        vi.spyOn(socket, 'write').mockImplementation((() => false) as typeof socket.write);
        const first = client.sendPacket('a', Buffer.alloc(0), 25);
        await Promise.resolve();
        expect(await client.sendPacket('b', Buffer.alloc(0))).toMatchObject({
            success: false,
            errorMessage: 'transport capacity exceeded',
        });
        socket.emit('drain');
        const second = client.sendPacket('c', Buffer.alloc(0), 25);
        expect((await Promise.all([first, second])).every((r) => r.errorCode === -2)).toBe(true);
    });
    it('maps unsigned wraparound and rejects a mismatched command', async () => {
        const seen: number[] = [];
        const one = await setup(
            (peer, frame) => {
                const r = request(frame);
                seen.push(r.sequence);
                peer.write(reply(r.sequence, r.command, 'ok'));
            },
            { initialSequence: 0xffffffff },
        );
        expect((await one.client.sendPacket('a', Buffer.alloc(0))).success).toBe(true);
        expect((await one.client.sendPacket('b', Buffer.alloc(0))).success).toBe(true);
        expect(seen).toEqual([0xffffffff, 0]);
        const two = await setup((peer, frame) => {
            const r = request(frame);
            peer.write(reply(r.sequence, 'wrong', 'bad'));
        });
        expect(await two.client.sendPacket('a', Buffer.alloc(0))).toMatchObject({
            success: false,
            gotResponse: false,
            errorMessage: 'response command mismatch',
        });
    });
    it('fails on peer disconnect and oversized framing', async () => {
        const one = await setup((peer) => peer.destroy());
        expect(await one.client.sendPacket('a', Buffer.alloc(0))).toMatchObject({
            success: false,
            gotResponse: false,
        });
        const two = await setup((peer) => peer.write(Buffer.from('ffffffff', 'hex')));
        expect(await two.client.sendPacket('a', Buffer.alloc(0))).toMatchObject({
            success: false,
            gotResponse: false,
        });
    });
    it('cleans up on synchronous and asynchronous write failures', async () => {
        const one = await setup(() => {});
        vi.spyOn(one.socket, 'write').mockImplementation(() => {
            throw new Error('write');
        });
        expect(await one.client.sendPacket('a', Buffer.alloc(0))).toMatchObject({
            success: false,
            gotResponse: false,
        });
        const two = await setup(() => {});
        vi.spyOn(two.socket, 'write').mockImplementation(((
            _frame: unknown,
            cb: (e: Error) => void,
        ) => {
            queueMicrotask(() => cb(new Error('write')));
            return true;
        }) as typeof two.socket.write);
        const all = await Promise.all([
            two.client.sendPacket('a', Buffer.alloc(0)),
            two.client.sendPacket('b', Buffer.alloc(0)),
        ]);
        expect(all.every((result) => !result.success && !result.gotResponse)).toBe(true);
        expect(await one.client.whenClosed).toEqual({
            kind: 'transport-error',
            code: 'write-failed',
        });
        expect(await two.client.whenClosed).toEqual({
            kind: 'transport-error',
            code: 'write-failed',
        });
    });
    it('bounds pending preparation and applies backpressure without buffering extra writes', async () => {
        let release!: (value: Uint8Array) => void;
        const { client } = await setup(() => {}, {
            maxPending: 1,
            buildReserved: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });
        const first = client.sendPacket('a', Buffer.alloc(1), 10);
        expect(await client.sendPacket('b', Buffer.alloc(0))).toMatchObject({
            success: false,
            errorMessage: 'transport capacity exceeded',
        });
        expect(await first).toMatchObject({ errorCode: -2 });
        expect(await client.sendPacket('c', Buffer.alloc(0))).toMatchObject({
            success: false,
            errorMessage: 'transport capacity exceeded',
        });
        release(Buffer.alloc(0));
    });
});
