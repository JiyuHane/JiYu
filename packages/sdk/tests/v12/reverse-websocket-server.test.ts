import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import {
    createOneBot12ReverseWebSocketServer,
    type OneBot12ReverseWebSocketServer,
    type OneBot12ReverseWebSocketServerOptions,
    type OneBot12ReverseWebSocketSession,
} from '../../src/v12/node/reverse-websocket-server.js';

const servers: OneBot12ReverseWebSocketServer[] = [];
const peers: WebSocket[] = [];
afterEach(async () => {
    for (const peer of peers.splice(0)) {
        peer.terminate();
    }

    await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function start(options: OneBot12ReverseWebSocketServerOptions = {}) {
    const server = createOneBot12ReverseWebSocketServer({
        port: 0,
        accessToken: 'secret',
        ...options,
    });
    servers.push(server);
    const sessions: OneBot12ReverseWebSocketSession[] = [];
    const errors = vi.fn();
    server.on('connection', (session) => sessions.push(session));
    server.on('error', errors);
    await server.listen();
    const port = (server.address as AddressInfo).port;

    function connect(
        config: {
            protocol?: string | string[];
            path?: string;
            headers?: Record<string, string>;
        } = {},
    ) {
        const peer = new WebSocket(
            `ws://127.0.0.1:${port}${config.path ?? '/'}`,
            config.protocol ?? '12.test-impl.v2',
            {
                headers: {
                    'User-Agent': 'test implementation',
                    Authorization: 'Bearer secret',
                    ...config.headers,
                },
            },
        );
        peers.push(peer);
        return peer;
    }

    async function accept() {
        const peer = connect();
        await once(peer, 'open');
        return { peer, session: sessions[sessions.length - 1]! };
    }

    return { server, sessions, connect, accept, errors, port };
}

const event = (platform: string, user_id: string) => ({
    id: 'id',
    time: 1,
    type: 'notice',
    detail_type: 'test',
    sub_type: '',
    self: { platform, user_id },
});
const response = (echo: string, data: unknown = null) =>
    JSON.stringify({ status: 'ok', retcode: 0, data, message: '', echo });

async function nextAction(peer: WebSocket) {
    const [data] = await once(peer, 'message');
    return JSON.parse(data.toString());
}

describe('OneBot 12 reverse WebSocket', () => {
    it('keeps implementation connections independent and routes events by full self identity', async () => {
        const { accept, server } = await start();
        const first = await accept();
        const second = await accept();
        expect(first.session.implementation).toBe('test-impl.v2');
        expect(server.clients.size).toBe(2);
        const qq = vi.fn();
        const other = vi.fn();
        const otherSession = vi.fn();
        first.session.onSelfEvent({ platform: 'qq', user_id: '42' }, qq);
        first.session.onSelfEvent({ platform: 'other', user_id: '42' }, other);
        second.session.onEvent(otherSession);
        first.peer.send(JSON.stringify(event('qq', '42')));
        first.peer.send(JSON.stringify(event('other', '42')));
        await vi.waitFor(() => {
            expect(qq).toHaveBeenCalledTimes(1);
            expect(other).toHaveBeenCalledTimes(1);
        });
        expect(otherSession).not.toHaveBeenCalled();
        const aFrame = nextAction(first.peer);
        const bFrame = nextAction(second.peer);
        const a = first.session.call(
            'send_message',
            { message: 'a' },
            { self: { platform: 'qq', user_id: '42' } },
        );
        const b = second.session.call(
            'send_message',
            { message: 'b' },
            { self: { platform: 'other', user_id: '42' } },
        );
        const [aReq, bReq] = await Promise.all([aFrame, bFrame]);
        expect(aReq.self).toEqual({ platform: 'qq', user_id: '42' });
        expect(bReq.self).toEqual({ platform: 'other', user_id: '42' });
        first.peer.send(response(bReq.echo, 'wrong socket'));
        second.peer.send(response(bReq.echo, 'b'));
        first.peer.send(response(aReq.echo, 'a'));
        expect((await a).data).toBe('a');
        expect((await b).data).toBe('b');
    });
    it('isolates mutable events between every handler and keeps implementation identity immutable', async () => {
        const { accept } = await start();
        const { peer, session } = await accept();
        expect(() => {
            (session as unknown as { implementation: string }).implementation = 'other';
        }).toThrow();
        expect(() =>
            Object.defineProperty(session, 'implementation', { value: 'other' }),
        ).toThrow();
        expect(session.implementation).toBe('test-impl.v2');
        const observed = vi.fn();
        const wrongAccount = vi.fn();
        session.onEvent(async (value) => {
            if (value.self) {
                value.self.user_id = 'other';
            }

            value.extension = 'corrupted';
            await Promise.resolve();
            value.extension = 'later corruption';
        });
        session.onSelfEvent({ platform: 'qq', user_id: 'other' }, wrongAccount);
        session.onSelfEvent({ platform: 'qq', user_id: '42' }, observed);
        peer.send(JSON.stringify({ ...event('qq', '42'), extension: 'original' }));
        await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(1));
        expect(wrongAccount).not.toHaveBeenCalled();
        expect(observed.mock.calls[0]![0]).toMatchObject({
            self: { platform: 'qq', user_id: '42' },
            extension: 'original',
        });
    });
    it('ignores polluted prototype self while isolating meta and account events', async () => {
        const { accept } = await start();
        const { peer, session } = await accept();
        const target = vi.fn();
        const trueAccount = vi.fn();
        let done!: () => void;
        const received = new Promise<void>((resolve) => {
            done = resolve;
        });
        let count = 0;
        session.onEvent((value) => {
            if (value.self) {
                value.self.user_id = 'B';
            } else {
                value.self = { platform: 'qq', user_id: 'B' };
            }

            value.extension = 'changed';
        });
        session.onSelfEvent({ platform: 'qq', user_id: 'B' }, target);
        session.onSelfEvent({ platform: 'qq', user_id: 'A' }, trueAccount);
        session.onEvent(() => {
            if (++count === 2) {
                done();
            }
        });
        Object.defineProperty(Object.prototype, 'self', {
            value: { platform: 'qq', user_id: 'B' },
            writable: true,
            configurable: true,
        });

        try {
            peer.send(
                '{"id":"m","time":1,"type":"meta","detail_type":"heartbeat","sub_type":"","extension":"original"}',
            );
            peer.send(
                '{"id":"n","time":1,"type":"notice","detail_type":"test","sub_type":"","self":{"platform":"qq","user_id":"A"},"extension":"original"}',
            );
            await received;
            expect(target).not.toHaveBeenCalled();
            expect(trueAccount).toHaveBeenCalledTimes(1);
            expect(trueAccount.mock.calls[0]![0]).toMatchObject({
                self: { platform: 'qq', user_id: 'A' },
                extension: 'original',
            });
        } finally {
            delete (Object.prototype as { self?: unknown }).self;
        }
    });
    it('never associates inherited echo or classifies inherited event fields', async () => {
        const { accept } = await start();
        const first = await accept();
        const second = await accept();
        const firstFrame = nextAction(first.peer);
        const request = first.session.call('wait', {}, { timeoutMs: 0 });
        const firstResult = request.then(
            () => 'resolved',
            (error: { code: string }) => error.code,
        );
        const action = await firstFrame;
        const metaSeen = vi.fn();
        second.session.onEvent(metaSeen);
        const secondFrame = nextAction(second.peer);
        const waiting = second.session.call('wait', {}, { timeoutMs: 0 });
        const secondResult = waiting.then(
            () => 'resolved',
            (error: { code: string }) => error.code,
        );
        await secondFrame;
        let echoReads = 0;
        let detailReads = 0;
        Object.defineProperty(Object.prototype, 'echo', {
            configurable: true,
            get() {
                echoReads++;
                return action.echo;
            },
        });
        Object.defineProperty(Object.prototype, 'detail_type', {
            configurable: true,
            get() {
                detailReads++;
                return 'heartbeat';
            },
        });

        try {
            second.peer.send(
                '{"id":"valid","time":1,"type":"meta","detail_type":"heartbeat","sub_type":""}',
            );
            await vi.waitFor(() => expect(metaSeen).toHaveBeenCalledTimes(1));
            first.peer.send('{"status":"ok","retcode":0,"data":"wrong","message":""}');
            second.peer.send('{"id":"bad","time":1,"type":"meta","sub_type":""}');
            expect(await firstResult).toBe('protocol');
            expect(await secondResult).toBe('protocol');
            expect(metaSeen).toHaveBeenCalledTimes(1);
            expect(echoReads).toBe(0);
            expect(detailReads).toBe(0);
        } finally {
            delete (Object.prototype as { echo?: unknown }).echo;
            delete (Object.prototype as { detail_type?: unknown }).detail_type;
        }
    });
    it('isolates sync and async callback failures without recursive or unhandled rejection', async () => {
        const { server, connect, accept, errors } = await start();
        const diagnostics = vi.fn();
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);

        try {
            server.on('callbackError', diagnostics);
            server.on('callbackError', async () => {
                throw new Error('secret terminal');
            });
            server.on('error', async () => {
                throw new Error('secret server error');
            });
            server.on('connection', async () => {
                throw new Error('secret connection');
            });
            server.on('connection', () => {
                throw new Error('secret sync');
            });
            server.on('disconnect', async () => {
                throw new Error('secret disconnect');
            });
            server.on('rejected', async () => {
                throw new Error('secret rejected');
            });
            const { peer, session } = await accept();
            session.onError(async () => {
                throw new Error('secret session');
            });
            session.onError(() => {
                throw new Error('secret session sync');
            });
            peer.send('{');
            await vi.waitFor(() =>
                expect(errors).toHaveBeenCalledWith(expect.objectContaining({ code: 'protocol' })),
            );
            const rejected = connect({ protocol: '11.invalid' });
            await once(rejected, 'error');
            peer.terminate();
            await vi.waitFor(() => {
                expect(
                    errors.mock.calls.filter(([error]) => error.code === 'callback').length,
                ).toBeGreaterThanOrEqual(6);
                expect(diagnostics.mock.calls.length).toBeGreaterThanOrEqual(6);
            });
            await new Promise((resolve) => setImmediate(resolve));
            expect(diagnostics.mock.calls.length).toBeLessThan(30);
            expect(unhandled).not.toHaveBeenCalled();
            expect(JSON.stringify([...diagnostics.mock.calls, ...errors.mock.calls])).not.toContain(
                'secret',
            );
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });
    it('does not await a slow server or event observer', async () => {
        const { server, accept } = await start();
        const later = vi.fn();
        const never = () => new Promise<void>(() => {});
        server.on('connection', never);
        server.on('connection', later);
        const { peer, session } = await accept();
        expect(later).toHaveBeenCalledTimes(1);
        const seen = vi.fn();
        session.onEvent(never);
        session.onEvent(seen);
        peer.send(JSON.stringify(event('qq', '42')));
        await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1));
    });
    it('requires correct protocol, user agent and token, with Authorization taking precedence', async () => {
        const { connect } = await start();

        async function rejected(peer: WebSocket, status: number) {
            const [error] = await once(peer, 'error');
            expect(error.message).toContain(String(status));
        }

        await rejected(connect({ protocol: '11.test' }), 400);
        await rejected(connect({ protocol: '12.Bad_Name' }), 400);
        await rejected(connect({ headers: { 'User-Agent': '' } }), 400);
        await rejected(
            connect({ path: '/?access_token=secret', headers: { Authorization: 'Basic secret' } }),
            401,
        );
        await rejected(
            connect({ path: '/?access_token=secret', headers: { Authorization: 'Bearer wrong' } }),
            401,
        );
        await rejected(connect({ path: '/wrong' }), 404);
        const fallback = connect({ path: '/?access_token=secret', headers: { Authorization: '' } });
        await rejected(fallback, 401);
        const url = (await start()).port;
        const query = new WebSocket(`ws://127.0.0.1:${url}/?access_token=secret`, '12.impl', {
            headers: { 'User-Agent': 'test' },
        });
        peers.push(query);
        await once(query, 'open');
        expect(query.protocol).toBe('12.impl');
    });
    it('correlates concurrent, malformed, duplicate, unknown and late responses', async () => {
        const { accept, errors } = await start();
        const { peer, session } = await accept();
        const oneFrame = nextAction(peer);
        const one = session.request('one');
        const req1 = await oneFrame;
        const twoFrame = nextAction(peer);
        const two = session.request('two');
        const req2 = await twoFrame;
        peer.send(response(req2.echo, 2));
        peer.send(response(req1.echo, 1));
        expect((await one).data).toBe(1);
        expect((await two).data).toBe(2);
        peer.send(response(req1.echo));
        peer.send(response('unknown'));
        const malformedFrame = nextAction(peer);
        const malformed = session.request('broken');
        const rejected = expect(malformed).rejects.toMatchObject({ code: 'invalid_response' });
        const req3 = await malformedFrame;
        peer.send(JSON.stringify({ echo: req3.echo, status: 'ok', retcode: 'invalid' }));
        await rejected;
        const timeoutFrame = nextAction(peer);
        const late = session.request('late', {}, { timeoutMs: 20 });
        const timeout = expect(late).rejects.toMatchObject({ code: 'timeout' });
        const req4 = await timeoutFrame;
        await timeout;
        peer.send(response(req4.echo));
        await vi.waitFor(() => expect(errors.mock.calls.length).toBeGreaterThanOrEqual(4));
        expect(JSON.stringify(errors.mock.calls)).not.toContain('secret');
    });
    it.each(['echo', '\\u0065cho'])(
        'rejects all concurrent requests for duplicate top-level %s',
        async (key) => {
            const { accept } = await start();
            const { peer, session } = await accept();
            const firstFrame = nextAction(peer);
            const first = session.call('first', {}, { timeoutMs: 0 });
            const firstError = expect(first).rejects.toMatchObject({ code: 'protocol' });
            const a = await firstFrame;
            const secondFrame = nextAction(peer);
            const second = session.call('second', {}, { timeoutMs: 0 });
            const secondError = expect(second).rejects.toMatchObject({ code: 'protocol' });
            const b = await secondFrame;
            peer.send(
                `{"echo":${JSON.stringify(a.echo)},"status":"ok","retcode":0,"data":"wrong","message":"","${key}":${JSON.stringify(b.echo)}}`,
            );
            await Promise.all([firstError, secondError]);
            expect(session.isConnected).toBe(false);
        },
    );
    it('accepts nested echo and event extensions, and rejects missing echo or ambiguous frames', async () => {
        const first = await start();
        const active = await first.accept();
        const events = vi.fn();
        active.session.onEvent(events);
        active.peer.send(JSON.stringify({ ...event('qq', '42'), echo: 'event-extension' }));
        const frame = nextAction(active.peer);
        const request = active.session.call('test');
        const sent = await frame;
        active.peer.send(response(sent.echo, { echo: 'nested', deeper: { echo: 'nested-again' } }));
        expect((await request).data).toEqual({ echo: 'nested', deeper: { echo: 'nested-again' } });
        await vi.waitFor(() => expect(events).toHaveBeenCalledTimes(1));
        const noEchoFrame = nextAction(active.peer);
        const noEcho = active.session.call('wait', {}, { timeoutMs: 0 });
        const missing = expect(noEcho).rejects.toMatchObject({ code: 'protocol' });
        await noEchoFrame;
        active.peer.send(JSON.stringify({ status: 'ok', retcode: 0, data: null, message: '' }));
        await missing;
        const invalidEcho = await first.accept();
        const invalidFrame = nextAction(invalidEcho.peer);
        const invalidRequest = invalidEcho.session.call('wait', {}, { timeoutMs: 0 });
        const invalidFailure = expect(invalidRequest).rejects.toMatchObject({ code: 'protocol' });
        await invalidFrame;
        invalidEcho.peer.send(
            JSON.stringify({ status: 'ok', retcode: 0, data: null, message: '', echo: 123 }),
        );
        await invalidFailure;
        const ambiguous = await first.accept();
        const ambiguousFrame = nextAction(ambiguous.peer);
        const pending = ambiguous.session.call('wait', {}, { timeoutMs: 0 });
        const failed = expect(pending).rejects.toMatchObject({ code: 'protocol' });
        const action = await ambiguousFrame;
        ambiguous.peer.send(
            JSON.stringify({
                ...event('qq', '42'),
                status: 'ok',
                retcode: 0,
                data: null,
                message: '',
                echo: action.echo,
            }),
        );
        await failed;
        const disguised = await first.accept();
        const disguisedFrame = nextAction(disguised.peer);
        const valid = disguised.session.call('wait');
        const outgoing = await disguisedFrame;
        disguised.peer.send(
            JSON.stringify({
                type: 'bad-event',
                id: 'x',
                detail_type: 'x',
                status: 'ok',
                retcode: 0,
                data: 'response',
                message: '',
                echo: outgoing.echo,
            }),
        );
        expect((await valid).data).toBe('response');
    });
    it('bounds aggregate pending and outbound bytes, handles abort and disconnect without replay', async () => {
        const { accept } = await start({ maxPendingRequests: 1 });
        const a = await accept();
        const b = await accept();
        const controller = new AbortController();
        const frame = nextAction(a.peer);
        const pending = a.session.call('one', {}, { signal: controller.signal });
        const canceled = expect(pending).rejects.toMatchObject({ code: 'aborted' });
        await frame;
        await expect(b.session.call('two')).rejects.toMatchObject({ code: 'limit' });
        controller.abort();
        await canceled;
        const next = nextAction(b.peer);
        const second = b.session.call('two');
        const disconnected = expect(second).rejects.toMatchObject({ code: 'closed' });
        await next;
        b.peer.terminate();
        await disconnected;
        const tight = await start({ maxBufferedBytes: 32 });
        const t = await tight.accept();
        await expect(
            t.session.call('large_action', { text: 'x'.repeat(200) }),
        ).rejects.toMatchObject({ code: 'limit' });
    });
    it('applies aggregate backpressure when a real peer stops reading', async () => {
        const { accept } = await start({ maxBufferedBytes: 256 * 1024, maxPendingRequests: 200 });
        const slow = await accept();
        const other = await accept();
        slow.peer.pause();
        const controller = new AbortController();
        const attempts: Promise<string>[] = [];
        const payload = { text: 'x'.repeat(128 * 1024) };

        for (let index = 0; index < 100; index++) {
            attempts.push(
                slow.session.call('send', payload, { signal: controller.signal }).then(
                    () => 'ok',
                    (error: { code: string }) => error.code,
                ),
            );
        }

        await Promise.resolve();
        await expect(other.session.call('send', payload)).rejects.toMatchObject({ code: 'limit' });
        controller.abort();
        const outcomes = await Promise.all(attempts);
        expect(outcomes).toContain('limit');
        expect(outcomes).toContain('aborted');
        slow.peer.resume();
    });
    it('rejects missing subprotocol and limits connection count without affecting the active socket', async () => {
        const { connect, port, accept } = await start({ maxConnections: 1 });
        const missing = new WebSocket(`ws://127.0.0.1:${port}/`, {
            headers: { 'User-Agent': 'test', Authorization: 'Bearer secret' },
        });
        peers.push(missing);
        expect((await once(missing, 'error'))[0].message).toContain('400');
        const active = await accept();
        expect((await once(connect(), 'error'))[0].message).toContain('503');
        expect(active.session.isConnected).toBe(true);
    });
    it('reports binary frames and drains pending work on shutdown', async () => {
        const { accept, server, errors } = await start();
        const { peer, session } = await accept();
        const frame = nextAction(peer);
        const pending = session.call('send_message', {}, { timeoutMs: 0 });
        const rejected = expect(pending).rejects.toMatchObject({ code: 'protocol' });
        await frame;
        const closed = once(peer, 'close');
        peer.send(Buffer.from('not text'));
        await Promise.all([closed, rejected]);
        await vi.waitFor(() =>
            expect(errors).toHaveBeenCalledWith(expect.objectContaining({ code: 'protocol' })),
        );
        await server.close();
        expect(server.clients.size).toBe(0);
        expect(session.isConnected).toBe(false);
    });
    it.each(['{', '[]', '{}', '{"type":"notice"}'])(
        'rejects pending without a timeout for uncorrelatable frame %s',
        async (input) => {
            const { accept } = await start();
            const { peer, session } = await accept();
            const errors = vi.fn();
            session.onError(errors);
            const frame = nextAction(peer);
            const pending = session.call('hold', {}, { timeoutMs: 0 });
            const failed = expect(pending).rejects.toMatchObject({ code: 'protocol' });
            await frame;
            const closed = once(peer, 'close');
            peer.send(input);
            await Promise.all([failed, closed]);
            expect(errors).toHaveBeenCalledWith(expect.objectContaining({ code: 'protocol' }));
        },
    );
    it('enforces inbound payload limits and rejects outstanding requests', async () => {
        const { accept } = await start({ maxPayloadBytes: 128 });
        const { peer, session } = await accept();
        const frame = nextAction(peer);
        const pending = session.call('hold');
        const failed = expect(pending).rejects.toMatchObject({ code: 'closed' });
        await frame;
        peer.send('x'.repeat(200));
        await failed;
    });
    it('claims each shared-host route once and releases it on close', async () => {
        const host = createServer();
        await new Promise<void>((resolve, reject) =>
            host.once('error', reject).listen(0, '127.0.0.1', resolve),
        );
        const modulePath = '../../src/v12/node/reverse-websocket-server.ts?second-copy';
        const copy = (await import(
            modulePath
        )) as typeof import('../../src/v12/node/reverse-websocket-server.js');
        expect(copy.OneBot12ReverseWebSocketServer).not.toBe(
            (await import('../../src/v12/node/reverse-websocket-server.js'))
                .OneBot12ReverseWebSocketServer,
        );
        const a = createOneBot12ReverseWebSocketServer({ server: host, path: '/a' });
        const duplicate = copy.createOneBot12ReverseWebSocketServer({ server: host, path: '/a/' });
        const b = copy.createOneBot12ReverseWebSocketServer({ server: host, path: '/b' });
        servers.push(a, duplicate, b);

        try {
            await a.listen();
            await expect(duplicate.listen()).rejects.toMatchObject({ code: 'invalid_options' });
            await b.listen();
            const port = (host.address() as AddressInfo).port;
            const peer = new WebSocket(`ws://127.0.0.1:${port}/a`, '12.test', {
                headers: { 'User-Agent': 'test' },
            });
            peers.push(peer);
            await once(peer, 'open');
            expect(a.clients.size).toBe(1);
            expect(b.clients.size).toBe(0);
            expect(peer.readyState).toBe(WebSocket.OPEN);
            await a.close();
            await duplicate.listen();
            expect(host.listening).toBe(true);
        } finally {
            await Promise.all([a.close(), b.close(), duplicate.close()]);
            await new Promise<void>((resolve, reject) =>
                host.close((error) => (error ? reject(error) : resolve())),
            );
        }
    });
    it('closes during startup, releases port and detaches from an external listener', async () => {
        const server = createOneBot12ReverseWebSocketServer({ port: 0 });
        servers.push(server);
        const opening = server.listen();
        const closing = server.close();
        await Promise.all([opening, closing]);
        expect(server.address).toBeNull();
        await server.listen();
        const port = (server.address as AddressInfo).port;
        await server.close();
        const reuse = createServer();
        await new Promise<void>((resolve, reject) =>
            reuse.once('error', reject).listen(port, '127.0.0.1', resolve),
        );
        const attached = createOneBot12ReverseWebSocketServer({ server: reuse });
        servers.push(attached);
        const initial = reuse.listenerCount('upgrade');
        await attached.listen();
        expect(reuse.listenerCount('upgrade')).toBe(initial + 1);
        await attached.close();
        expect(reuse.listenerCount('upgrade')).toBe(initial);
        expect(reuse.listening).toBe(true);
        await new Promise<void>((resolve, reject) =>
            reuse.close((error) => (error ? reject(error) : resolve())),
        );
    });
});
