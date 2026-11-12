import { once } from 'node:events';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createSso12RawClient,
    Sso12PacketClient,
    type Sso12RawClient,
    type Sso12RawOptions,
} from '../../src/direct/sso12-packet-client';
import { ServiceFrameDecoder } from '../../src/direct/service-stream';

const servers: Server[] = [];
const sockets: Socket[] = [];
const clients: Sso12RawClient[] = [];
const wire = Buffer.concat([Buffer.from([0, 0, 0, 18]), Buffer.alloc(14, 0x31)]);
const reply = Buffer.concat([Buffer.from([0, 0, 0, 18]), Buffer.alloc(14, 0x42)]);

async function pair(): Promise<{ socket: Socket; peer: Socket }> {
    const server = createServer();
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();

    if (!address || typeof address === 'string') {
        throw new Error('missing address');
    }

    const incoming = once(server, 'connection');
    const socket = createConnection({ port: address.port, host: '127.0.0.1' });
    sockets.push(socket);
    await once(socket, 'connect');
    const [peer] = (await incoming) as [Socket];
    sockets.push(peer);
    return { socket, peer };
}

function rawOptions(): Sso12RawOptions<null, string> {
    return {
        buildRequest: () => ({ frame: wire, context: null }),
        verifyCandidate: (candidate) => Buffer.from(candidate).equals(reply),
        consumeCandidate: () => 'ok',
    };
}

function responding(peer: Socket, answer = reply): void {
    const decoder = new ServiceFrameDecoder();
    peer.on('data', (chunk) => {
        for (const _frame of decoder.push(chunk)) {
            peer.write(answer);
        }
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
        servers
            .splice(0)
            .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    vi.restoreAllMocks();
});

describe('SSO12 raw-only client', () => {
    it('has a narrow public type and exchanges fragmented frames with the supplied local identifier', async () => {
        const { socket, peer } = await pair();
        const client = createSso12RawClient({ socket, uin: '0', initialSequence: 37 });
        clients.push(client);

        const typeCheckOnly = (value: Sso12RawClient): void => {
            // @ts-expect-error reference methods are not part of the factory type
            value.getProfile();
            // @ts-expect-error reference methods are not part of the factory type
            value.sendPacket('x', wire);
            // @ts-expect-error reference methods are not part of the factory type
            value.sendBoundPacket('x', wire);
        };

        void typeCheckOnly;

        const decoder = new ServiceFrameDecoder();
        peer.on('data', (chunk) => {
            for (const _frame of decoder.push(chunk)) {
                peer.write(reply.subarray(0, 3));
                setImmediate(() => peer.write(reply.subarray(3)));
            }
        });
        const verify = vi.fn(
            (
                candidate: Uint8Array,
                _context: null,
                identity: { uin: string; sequence: number },
            ) => {
                expect(identity).toEqual({ uin: '0', sequence: 37 });
                expect(Buffer.from(candidate)).toEqual(reply);
                candidate.fill(0);
                return true;
            },
        );
        const consume = vi.fn((candidate: Uint8Array) => {
            expect(Buffer.from(candidate)).toEqual(reply);
            return 'ok';
        });
        expect(
            await client.transactRaw({
                ...rawOptions(),
                verifyCandidate: verify,
                consumeCandidate: consume,
            }),
        ).toEqual({
            kind: 'response',
            sequence: 37,
            value: 'ok',
            writeState: 'written',
        });
        expect(verify).toHaveBeenCalledTimes(1);
        expect(consume).toHaveBeenCalledTimes(1);
        client.close();
        expect(await client.whenClosed).toEqual({ kind: 'local', code: 'local-close' });
    });

    it('rejects reference operations without writes or sequence consumption, including during raw activity', async () => {
        const { socket, peer } = await pair();
        const client = createSso12RawClient({
            socket,
            uin: '0',
            initialSequence: 93,
        }) as Sso12PacketClient;
        clients.push(client);
        const writes = vi.spyOn(socket, 'write');
        expect(() => client.getProfile()).toThrow('reference-profile-unavailable');
        expect(await client.sendPacket('x', wire)).toMatchObject({
            success: false,
            errorMessage: 'reference-mode-unavailable',
        });
        expect(await client.sendBoundPacket('x', wire)).toMatchObject({
            kind: 'failure',
            binding: null,
            result: { errorMessage: 'reference-mode-unavailable' },
        });
        expect(writes).not.toHaveBeenCalled();
        let release!: () => void;
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        responding(peer);
        const pending = client.transactRaw({
            ...rawOptions(),
            verifyCandidate: async () => {
                entered();
                await gate;
                return true;
            },
        });
        await ready;
        expect(await client.sendPacket('x', wire)).toMatchObject({
            errorMessage: 'reference-mode-unavailable',
        });
        expect(await client.transactRaw(rawOptions())).toMatchObject({ code: 'busy' });
        release();
        expect(await pending).toMatchObject({ kind: 'response', sequence: 93 });
        client.close();
        expect(() => client.getProfile()).toThrow('connection closed');
        expect(await client.sendPacket('x', wire)).toMatchObject({
            errorMessage: 'connection closed',
        });
        await client.whenClosed;
    });

    it.each(['before', 'after'] as const)('closes on idle bytes %s a transaction', async (when) => {
        const { socket, peer } = await pair();
        const client = createSso12RawClient({ socket, uin: '0' });
        clients.push(client);

        if (when === 'after') {
            responding(peer);
            expect((await client.transactRaw(rawOptions())).kind).toBe('response');
        }

        peer.write(Buffer.of(0x42));
        expect(await client.whenClosed).toEqual({
            kind: 'protocol-error',
            code: 'raw-unexpected-data',
        });
    });

    it.each(['verify', 'consume'] as const)(
        'fails closed on callback reentry from %s',
        async (phase) => {
            const { socket, peer } = await pair();
            const client = createSso12RawClient({ socket, uin: '0' }) as Sso12PacketClient;
            clients.push(client);
            responding(peer);

            const reenter = async () => {
                await Promise.resolve();
                await client.sendBoundPacket('x', wire);
            };

            const result = await client.transactRaw({
                ...rawOptions(),
                verifyCandidate: async () => {
                    if (phase === 'verify') {
                        await reenter();
                    }

                    return true;
                },
                consumeCandidate: async () => {
                    if (phase === 'consume') {
                        await reenter();
                    }

                    return 'ok';
                },
            });
            expect(result).toMatchObject({
                kind: 'failure',
                code: 'callback-reentry',
                writeState: 'unknown',
            });
            expect(await client.whenClosed).toEqual({
                kind: 'handler-error',
                code: 'callback-reentry',
            });
        },
    );

    it('rejects a coalesced extra frame before verifier and consumer', async () => {
        const { socket, peer } = await pair();
        const client = createSso12RawClient({ socket, uin: '0' });
        clients.push(client);
        responding(peer, Buffer.concat([reply, reply.subarray(0, 2)]));
        const verify = vi.fn(() => true);
        const consume = vi.fn(() => 'ok');
        expect(
            await client.transactRaw({
                ...rawOptions(),
                verifyCandidate: verify,
                consumeCandidate: consume,
            }),
        ).toMatchObject({ code: 'raw-extra-data', writeState: 'unknown' });
        expect(verify).not.toHaveBeenCalled();
        expect(consume).not.toHaveBeenCalled();
        expect((await client.whenClosed).code).toBe('raw-extra-data');
    });

    it.each(['timeout', 'abort'] as const)('ignores a late verifier after %s', async (outcome) => {
        const { socket, peer } = await pair();
        const client = createSso12RawClient({ socket, uin: '0' });
        clients.push(client);
        responding(peer);
        const controller = new AbortController();
        let entered!: () => void;
        let release!: () => void;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const consume = vi.fn(() => 'ok');
        const pending = client.transactRaw({
            ...rawOptions(),
            timeoutMs: outcome === 'timeout' ? 30 : 2000,
            signal: controller.signal,
            verifyCandidate: async () => {
                entered();
                await gate;
                return true;
            },
            consumeCandidate: consume,
        });
        await ready;

        if (outcome === 'abort') {
            controller.abort();
        }

        const code = outcome === 'abort' ? 'raw-cancelled' : 'raw-timeout';
        expect(await pending).toMatchObject({ kind: 'failure', code, writeState: 'unknown' });
        expect((await client.whenClosed).code).toBe(code);
        release();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(consume).not.toHaveBeenCalled();
    });

    it('rejects invalid factory records before socket ownership or destruction', async () => {
        const { socket } = await pair();
        const getter = vi.fn(() => 'raw-only');
        const trap = vi.fn(() => {
            throw new Error('trap');
        });
        const bad: unknown[] = [
            { socket, uin: '' },
            { socket, uin: '1'.repeat(21) },
            { socket, uin: '0', initialSequence: -1 },
            { socket, uin: '0', defaultTimeoutMs: 0 },
            { socket, uin: '0', maxWriteBufferBytes: 0 },
            { socket, uin: '0', mode: 'raw-only' },
            Object.defineProperty({ socket, uin: '0' }, 'mode', { get: getter }),
            new Proxy({ socket, uin: '0' }, { getPrototypeOf: trap, ownKeys: trap }),
            Object.assign(Object.create({ inherited: true }) as object, { socket, uin: '0' }),
        ];

        for (const value of bad) {
            expect(() => createSso12RawClient(value as never)).toThrow();
            expect(socket.destroyed).toBe(false);
        }

        expect(getter).not.toHaveBeenCalled();
        expect(trap).not.toHaveBeenCalled();
        const client = createSso12RawClient({ socket, uin: '0' });
        clients.push(client);
        expect(() => createSso12RawClient({ socket, uin: '0' })).toThrow(/owned/);
        client.close();
        expect((await client.whenClosed).code).toBe('local-close');
    });

    it.each([true, false])(
        'preserves legacy reference getters and extra mode (proxy=%s)',
        async (proxy) => {
            const { socket } = await pair();
            const reads = vi.fn();
            const reference = {
                socket,
                uin: '123',
                mode: 'raw-only',
                get encryption() {
                    reads('encryption');
                    return { type: 'zero' as const };
                },
                get subAppId() {
                    reads('subAppId');
                    return 42;
                },
                get guid() {
                    reads('guid');
                    return reads.mock.calls.filter(([name]) => name === 'guid').length === 1
                        ? Uint8Array.of(1)
                        : new Uint8Array();
                },
                get version() {
                    reads('version');
                    return 'v';
                },
                get a2() {
                    reads('a2');
                    return Uint8Array.of(2);
                },
                buildReserved: async () => new Uint8Array(),
                classifyIncoming: () => 'response' as const,
            };
            const has = vi.fn(() => {
                throw new Error('has trap');
            });
            const client = new Sso12PacketClient(proxy ? new Proxy(reference, { has }) : reference);
            clients.push(client);
            expect(has).not.toHaveBeenCalled();
            expect(reads.mock.calls.map(([name]) => name)).toEqual([
                'encryption',
                'subAppId',
                'guid',
                'version',
                'a2',
            ]);
            expect(client.getProfile()).toEqual({
                uin: '123',
                subAppId: 42,
                guid: Uint8Array.of(1),
                version: 'v',
            });
            client.close();
            await client.whenClosed;
        },
    );

    it('preserves legacy validation ordering before sequence validation', async () => {
        const { socket } = await pair();
        const calls: string[] = [];
        const clientOptions = {
            socket,
            uin: '123',
            initialSequence: -1,
            encryption: {
                get type(): 'zero' {
                    calls.push('type');
                    return 'zero';
                },
            },
            subAppId: 1,
            guid: Uint8Array.of(1),
            version: 'v',
            a2: new Uint8Array(),
            get buildReserved() {
                calls.push('buildReserved');
                return async () => new Uint8Array();
            },
            get classifyIncoming() {
                calls.push('classifyIncoming');
                return () => 'response' as const;
            },
        };
        expect(() => new Sso12PacketClient(clientOptions)).toThrow(
            'invalid protocol-12 transport configuration',
        );
        expect(calls).toEqual(['type', 'type', 'buildReserved', 'classifyIncoming']);
        expect(socket.destroyed).toBe(false);
        const raw = createSso12RawClient({ socket, uin: '0' });
        clients.push(raw);
        raw.close();
        await raw.whenClosed;
    });

    it('rolls back socket ownership and listeners when registration fails', async () => {
        const { socket } = await pair();
        const original = socket.on.bind(socket);
        const spy = vi.spyOn(socket, 'on').mockImplementation(((
            event: string | symbol,
            callback: (...args: never[]) => void,
        ) => {
            if (event === 'end') {
                throw new Error('registration failed');
            }

            return (
                original as (name: string | symbol, listener: (...args: never[]) => void) => Socket
            )(event, callback);
        }) as typeof socket.on);
        expect(() => createSso12RawClient({ socket, uin: '0' })).toThrow('registration failed');
        spy.mockRestore();
        expect(socket.destroyed).toBe(false);
        expect(socket.listenerCount('data')).toBe(0);
        expect(socket.listenerCount('error')).toBe(0);
        const client = createSso12RawClient({ socket, uin: '0' });
        clients.push(client);
        client.close();
        await client.whenClosed;
    });
});
