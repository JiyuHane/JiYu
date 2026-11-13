import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { WebSocket } from '@snowluma/websocket';
import { V12Transport, type V12Response } from '../../src/v12-network';
import { V12Dispatcher } from '../../src/v12/dispatcher';

const servers: V12Transport[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
    for (const socket of sockets.splice(0)) {
        socket.terminate();
    }

    await Promise.all(servers.splice(0).map((server) => server.close()));
});

function make(self = '1', extra: Partial<ConstructorParameters<typeof V12Transport>[0]> = {}) {
    const listeners = new Set<(event: unknown) => void>();
    const server = new V12Transport({
        host: '127.0.0.1',
        port: 0,
        accessToken: 'token',
        getConnectEvent: () => ({
            id: 'id',
            time: 1,
            type: 'meta',
            detail_type: 'connect',
            sub_type: '',
            version: { impl: 'fixture', version: '1', onebot_version: '12' },
        }),
        subscribe: (listener) => {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
        handle: async (input): Promise<V12Response> => {
            const request = input as { self?: { user_id: string } };
            return request.self && request.self.user_id !== self
                ? { status: 'failed', retcode: 10102, data: null, message: 'unknown self' }
                : { status: 'ok', retcode: 0, data: { self }, message: '' };
        },
        ...extra,
    });
    servers.push(server);
    return { server, listeners };
}

async function request(
    port: number,
    path: string,
    body: string,
    headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, path, method: 'POST', headers },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        body: JSON.parse(Buffer.concat(chunks).toString()),
                    }),
                );
            },
        );
        req.on('error', reject);
        req.end(body);
    });
}

function connect(port: number, path = '/?access_token=token', headers?: Record<string, string>) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    sockets.push(ws);
    const frames: any[] = [];
    const waiters: Array<(value: any) => void> = [];
    ws.on('message', (data: Buffer) => {
        const value = JSON.parse(data.toString());
        const waiter = waiters.shift();

        if (waiter) {
            waiter(value);
        } else {
            frames.push(value);
        }
    });
    return {
        ws,
        next: () =>
            frames.length
                ? Promise.resolve(frames.shift())
                : new Promise<any>((resolve) => waiters.push(resolve)),
    };
}

describe('OneBot v12 network over real loopback sockets', () => {
    it('enforces auth precedence, media type, valid envelope and account binding', async () => {
        const { server } = make();
        const { port } = await server.open();
        const h = { 'content-type': 'application/json' };
        expect((await request(port, '/', '{}', h)).status).toBe(401);
        expect(
            (
                await request(port, '/?access_token=token', '{}', {
                    ...h,
                    authorization: 'Bearer bad',
                })
            ).status,
        ).toBe(401);
        expect(
            (
                await request(port, '/?access_token=token', '{}', {
                    'content-type': 'application/msgpack',
                })
            ).status,
        ).toBe(415);
        const bad = await request(port, '/?access_token=token', '{', h);
        expect(bad.status).toBe(200);
        expect(bad.body).toEqual({
            status: 'failed',
            retcode: 10001,
            data: null,
            message: 'invalid request',
        });
        const invalid = await request(
            port,
            '/',
            JSON.stringify({ action: '', params: {}, echo: 'id' }),
            { ...h, authorization: 'Bearer token' },
        );
        expect(invalid.body).toMatchObject({ retcode: 10001, echo: 'id' });
        const valid = await request(
            port,
            '/?access_token=token',
            JSON.stringify({ action: 'x', params: {}, echo: 'abc' }),
            h,
        );
        expect(valid.body).toEqual({
            status: 'ok',
            retcode: 0,
            data: { self: '1' },
            message: '',
            echo: 'abc',
        });
        const other = await request(
            port,
            '/?access_token=token',
            JSON.stringify({ action: 'x', params: {}, self: { user_id: '2' } }),
            h,
        );
        expect(other.body.retcode).toBe(10102);
    });
    it('preserves mandatory 401 and 415 with zero body when cap is one byte', async () => {
        const { server } = make('1', { maxOutputBytes: 1 });
        const { port } = await server.open();
        const raw = (path: string, contentType: string) =>
            new Promise<{ status: number; bytes: number }>((resolve, reject) => {
                const req = http.request(
                    {
                        host: '127.0.0.1',
                        port,
                        path,
                        method: 'POST',
                        headers: { 'content-type': contentType },
                    },
                    (res) => {
                        let bytes = 0;
                        res.on('data', (chunk: Buffer) => {
                            bytes += chunk.length;
                        });
                        res.on('end', () => resolve({ status: res.statusCode ?? 0, bytes }));
                    },
                );
                req.on('error', reject);
                req.end('{}');
            });
        expect(await raw('/', 'application/json')).toEqual({ status: 401, bytes: 0 });
        expect(await raw('/?access_token=token', 'application/msgpack')).toEqual({
            status: 415,
            bytes: 0,
        });
    });
    it('delivers connect first, interleaves events/actions, rejects binary, cleans up', async () => {
        const { server, listeners } = make();
        const { port } = await server.open();
        const c = connect(port);
        const first = await c.next();
        expect(first).toMatchObject({
            type: 'meta',
            detail_type: 'connect',
            version: { onebot_version: '12' },
        });
        expect(listeners.size).toBe(1);

        for (const listener of listeners) {
            listener({ type: 'message', id: 'event' });
        }

        c.ws.send(JSON.stringify({ action: 'x', params: {}, echo: 'a' }));
        expect(await c.next()).toMatchObject({ id: 'event' });
        expect(await c.next()).toMatchObject({ status: 'ok', echo: 'a' });
        c.ws.send(Buffer.from([1]));
        expect(await c.next()).toMatchObject({ status: 'failed', retcode: 10001 });
        const closed = new Promise<void>((resolve) => c.ws.once('close', () => resolve()));
        await server.close();
        await closed;
        expect(listeners.size).toBe(0);
    });
    it('rejects invalid authorization even with a valid websocket query', async () => {
        const { server } = make();
        const { port } = await server.open();
        const c = connect(port, '/?access_token=token', { authorization: 'Bearer wrong' });
        const message = await new Promise<string>((resolve) =>
            c.ws.once('error', (error: Error) => resolve(error.message)),
        );
        expect(message).toContain('401');
    });
    it('isolates concurrent server instances and handles open/close races', async () => {
        const a = make('a');
        const b = make('b');
        const [aa, bb] = await Promise.all([a.server.open(), b.server.open()]);
        const ca = connect(aa.port);
        const cb = connect(bb.port);
        await Promise.all([ca.next(), cb.next()]);

        for (const listener of a.listeners) {
            listener({ id: 'only-a' });
        }

        expect(await ca.next()).toMatchObject({ id: 'only-a' });
        cb.ws.send(JSON.stringify({ action: 'x', params: {}, echo: 'b' }));
        expect(await cb.next()).toMatchObject({ data: { self: 'b' }, echo: 'b' });
        const race = make();
        const opening = race.server.open();
        const closing = race.server.close();
        await Promise.all([opening, closing]);
    });
    it('quiesces during open and force closes active clients', async () => {
        const a = make();
        const opening = a.server.open();
        a.server.quiesce();
        const address = await opening;
        const result = await request(address.port, '/?access_token=token', '{}', {
            'content-type': 'application/json',
        });
        expect(result.status).toBe(503);
        const blocked = connect(address.port);
        const error = await new Promise<string>((resolve) =>
            blocked.ws.once('error', (e: Error) => resolve(e.message)),
        );
        expect(error).toContain('503');
        await a.server.close();
        const b = make();
        const bound = await b.server.open();
        const client = connect(bound.port);
        await client.next();
        const closed = new Promise<void>((resolve) => client.ws.once('close', () => resolve()));
        b.server.forceClose();
        expect(b.listeners.size).toBe(0);
        await b.server.close();
        await closed;
    });
    it('bounds bodies, slow uploads and outstanding handler work without leaking errors', async () => {
        let release!: (value: V12Response) => void;
        const handlerResult = new Promise<V12Response>((resolve) => {
            release = resolve;
        });
        const { server } = make('1', {
            maxBodyBytes: 80,
            maxConcurrent: 1,
            timeoutMs: 100,
            handle: () => handlerResult,
        });
        const { port } = await server.open();
        const h = { 'content-type': 'application/json' };
        const tooLarge = await request(port, '/?access_token=token', 'x'.repeat(81), h);
        expect(tooLarge.status).toBe(200);
        expect(tooLarge.body.retcode).toBe(10001);
        const slow = new Promise<number>((resolve, reject) => {
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port,
                    method: 'POST',
                    path: '/?access_token=token',
                    headers: h,
                },
                (res) => {
                    res.resume();
                    res.once('end', () => resolve(res.statusCode ?? 0));
                },
            );
            req.on('error', reject);
            req.write('{');
        });
        expect(await slow).toBe(200);
        const pending = await request(
            port,
            '/?access_token=token',
            JSON.stringify({ action: 'x', params: {}, echo: 'r' }),
            h,
        );
        expect(pending.body).toMatchObject({ status: 'failed', echo: 'r' });
        const busy = await request(
            port,
            '/?access_token=token',
            JSON.stringify({ action: 'x', params: {} }),
            h,
        );
        expect(busy.body).toMatchObject({ status: 'failed', message: 'transport busy' });
        release({ status: 'failed', retcode: 20002, data: 'token', message: 'token' });
    });
    it('reports asynchronous listener failures and preserves a failed close for retry', async () => {
        const errors: string[] = [];
        const { server } = make('1', { onError: (error) => errors.push(error.message) });
        const address = await server.open();
        const listener = (server as unknown as { server: http.Server }).server;
        listener.emit('error', new Error('secret token'));
        expect(errors).toEqual(['v12 listener failure']);
        expect(
            (await request(address.port, '/', '{}', { 'content-type': 'application/json' })).status,
        ).toBe(503);
        const originalClose = listener.close;
        listener.close = ((callback?: (error?: Error) => void) => {
            queueMicrotask(() => callback?.(new Error('transient failure')));
            return listener;
        }) as typeof listener.close;
        await expect(server.close()).rejects.toThrow('transient failure');
        expect((server as unknown as { server: http.Server }).server).toBe(listener);
        listener.close = originalClose;
        await server.close();
    });
    it('serializes hostile output once on HTTP and WebSocket and handles serialization errors', async () => {
        let count = 0;
        const { server } = make('1', {
            maxOutputBytes: 256,
            handle: (input) => {
                const mode = (input as { params: { mode: string } }).params.mode;
                return {
                    status: 'ok',
                    retcode: 0,
                    message: '',
                    data: {
                        toJSON() {
                            count++;

                            if (mode === 'throws' || count % 2 === 0) {
                                throw new Error('private-marker');
                            }

                            return 'ok';
                        },
                    },
                };
            },
        });
        const { port } = await server.open();
        const h = { 'content-type': 'application/json' };
        const call = (mode: string) =>
            request(
                port,
                '/?access_token=token',
                JSON.stringify({ action: 'x', params: { mode }, echo: 'id' }),
                h,
            );
        const first = await call('ok');
        expect(first.body).toMatchObject({ data: 'ok', echo: 'id' });
        expect(count).toBe(1);
        const ws = connect(port);
        await ws.next();
        // Each new response starts with a fresh first invocation.
        count = 0;
        ws.ws.send(JSON.stringify({ action: 'x', params: { mode: 'ok' }, echo: 'ws' }));
        expect(await ws.next()).toMatchObject({ data: 'ok', echo: 'ws' });
        expect(count).toBe(1);
        const failed = await call('throws');
        expect(failed.body).toMatchObject({ status: 'failed', retcode: 20001, echo: 'id' });
        expect(failed.body.message).toContain('do not retry automatically');
        expect(JSON.stringify(failed.body)).not.toContain('private-marker');
        ws.ws.send(JSON.stringify({ action: 'x', params: { mode: 'throws' }, echo: 'ws2' }));
        expect(await ws.next()).toMatchObject({ status: 'failed', retcode: 20001, echo: 'ws2' });
        const emptyEcho = JSON.stringify({ action: 'x', params: { mode: 'throws' }, echo: '' });
        const failedEmpty = await request(port, '/?access_token=token', emptyEcho, h);
        expect(failedEmpty.body).toMatchObject({ status: 'failed', retcode: 20001, echo: '' });
        ws.ws.send(emptyEcho);
        expect(await ws.next()).toMatchObject({ status: 'failed', retcode: 20001, echo: '' });
    });
    it('keeps the actual HTTP wire body within a 128-byte cap with stateful toJSON', async () => {
        let calls = 0;
        const { server } = make('1', {
            maxOutputBytes: 128,
            handle: () => ({
                status: 'ok',
                retcode: 0,
                message: '',
                data: {
                    toJSON() {
                        calls++;

                        if (calls === 1) {
                            return 'ok';
                        }

                        throw new Error('private-marker');
                    },
                },
            }),
        });
        const { port } = await server.open();
        const result = await request(
            port,
            '/?access_token=token',
            JSON.stringify({ action: 'x', params: {}, echo: 'x' }),
            { 'content-type': 'application/json' },
        );
        expect(result.body).toMatchObject({ status: 'ok', data: 'ok', echo: 'x' });
        expect(Buffer.byteLength(JSON.stringify(result.body))).toBeLessThanOrEqual(128);
        expect(calls).toBe(1);
    });
    it('closes rather than omit an echo that cannot fit on every response path', async () => {
        let release!: (v: V12Response) => void;
        const pending = new Promise<V12Response>((resolve) => {
            release = resolve;
        });
        const { server } = make('1', {
            maxOutputBytes: 256,
            maxConcurrent: 1,
            timeoutMs: 40,
            handle: (input) => {
                const mode = (input as { params: { mode: string } }).params.mode;

                if (mode === 'error') {
                    throw new Error('secret');
                }

                if (mode === 'timeout') {
                    return pending;
                }

                return { status: 'ok', retcode: 0, data: null, message: '' };
            },
        });
        const { port } = await server.open();
        const h = { 'content-type': 'application/json' };
        const body = (mode: string) =>
            JSON.stringify({ action: 'x', params: { mode }, echo: 'E'.repeat(1024) });

        for (const mode of ['ok', 'error', 'timeout', 'busy']) {
            await expect(request(port, '/?access_token=token', body(mode), h)).rejects.toThrow();
        }

        const ws = connect(port);
        await ws.next();
        const closed = new Promise<void>((resolve) => ws.ws.once('close', () => resolve()));
        ws.ws.send(body('busy'));
        await closed;
        release({ status: 'ok', retcode: 0, data: null, message: '' });
    });
    it('preserves an empty echo and omits an absent echo on HTTP and WebSocket', async () => {
        let calls = 0;
        const core = new V12Dispatcher({
            self: { platform: 'qq', user_id: '1' },
            version: { impl: 'fixture', version: '1' },
            api: {
                handle: async () => {
                    calls++;
                    return {
                        status: 'failed',
                        retcode: 1400,
                        data: null,
                        wording: 'fixture-secret',
                    };
                },
            },
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
        });
        const { server } = make('1', { handle: (input) => core.handle(input) });
        const { port } = await server.open();
        const cases = [
            { action: 'get_version', params: {}, code: 0 },
            { action: '', params: {}, code: 10001 },
            { action: 'not_real', params: {}, code: 10002 },
            { action: 'delete_message', params: { message_id: '123' }, code: 10003 },
        ];
        const ws = connect(port);
        await ws.next();

        for (const entry of cases) {
            for (const includeEcho of [true, false]) {
                const body = {
                    action: entry.action,
                    params: entry.params,
                    ...(includeEcho ? { echo: '' } : {}),
                };
                const httpResult = await request(
                    port,
                    '/?access_token=token',
                    JSON.stringify(body),
                    { 'content-type': 'application/json' },
                );
                ws.ws.send(JSON.stringify(body));
                const wsResult = await ws.next();

                for (const result of [httpResult.body, wsResult]) {
                    expect(result.retcode).toBe(entry.code);
                    expect(Object.hasOwn(result, 'echo')).toBe(includeEcho);

                    if (includeEcho) {
                        expect(result.echo).toBe('');
                    }

                    if (entry.code === 10003) {
                        expect(result.message).toContain('do not retry automatically');
                    }

                    expect(JSON.stringify(result)).not.toContain('fixture-secret');
                }
            }
        }

        expect(calls).toBe(4);
    });
    it('preserves core send uncertainty on HTTP and WebSocket without retrying', async () => {
        let sent = 0;
        const core = new V12Dispatcher({
            self: { platform: 'qq', user_id: '1' },
            version: { impl: 'fixture', version: '1' },
            api: {
                handle: async () => {
                    sent++;
                    return { status: 'ok', retcode: 0, data: { message_id: 123 } };
                },
            },
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
        });
        const { server } = make('1', { handle: (input) => core.handle(input) });
        const { port } = await server.open();
        const action = {
            action: 'send_message',
            params: {
                detail_type: 'private',
                user_id: '2',
                message: [{ type: 'text', data: { text: 'fixture' } }],
            },
            echo: 'id',
        };
        const result = await request(port, '/?access_token=token', JSON.stringify(action), {
            'content-type': 'application/json',
        });
        expect(result.body).toMatchObject({ status: 'failed', retcode: 20001, echo: 'id' });
        expect(result.body.message).toContain('message sent');
        expect(result.body.message).toContain('do not retry automatically');
        expect(sent).toBe(1);
        const ws = connect(port);
        await ws.next();
        ws.ws.send(JSON.stringify(action));
        const frame = await ws.next();
        expect(frame.message).toContain('message sent');
        expect(frame.message).toContain('do not retry automatically');
        expect(sent).toBe(2);
        ws.ws.send(JSON.stringify({ action: 'not_real', params: {}, echo: 'bad' }));
        const invalid = await ws.next();
        expect(invalid).toMatchObject({
            retcode: 10002,
            echo: 'bad',
            message: 'unsupported action',
        });
        expect(sent).toBe(2);
    });
    it('retains uncertain v11 failure after send and delete over HTTP and WebSocket', async () => {
        let calls = 0;
        const core = new V12Dispatcher({
            self: { platform: 'qq', user_id: '1' },
            version: { impl: 'fixture', version: '1' },
            api: {
                handle: async () => {
                    calls++;
                    return {
                        status: 'failed',
                        retcode: 1400,
                        data: null,
                        wording: 'fixture-secret',
                    };
                },
            },
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
        });
        const { server } = make('1', { handle: (input) => core.handle(input) });
        const { port } = await server.open();
        const actions = [
            {
                action: 'send_message',
                params: {
                    detail_type: 'private',
                    user_id: '2',
                    message: [{ type: 'text', data: { text: 'test' } }],
                },
                echo: 'send',
            },
            { action: 'delete_message', params: { message_id: '123' }, echo: 'delete' },
        ];
        const ws = connect(port);
        await ws.next();

        for (const action of actions) {
            const beforeHttp = calls;
            const httpResult = await request(port, '/?access_token=token', JSON.stringify(action), {
                'content-type': 'application/json',
            });
            expect(calls).toBe(beforeHttp + 1);
            expect(httpResult.body).toMatchObject({
                status: 'failed',
                retcode: 10003,
                echo: action.echo,
            });
            expect(httpResult.body.message).toContain('outcome may be uncertain');
            expect(httpResult.body.message).toContain('do not retry automatically');
            expect(JSON.stringify(httpResult.body)).not.toContain('fixture-secret');
            const beforeWs = calls;
            ws.ws.send(JSON.stringify(action));
            const frame = await ws.next();
            expect(calls).toBe(beforeWs + 1);
            expect(frame).toMatchObject({ status: 'failed', retcode: 10003, echo: action.echo });
            expect(frame.message).toContain('outcome may be uncertain');
            expect(frame.message).toContain('do not retry automatically');
            expect(JSON.stringify(frame)).not.toContain('fixture-secret');
        }

        expect(calls).toBe(4);
    });
    it('treats unrecognized request-code handler failures as unknown outcomes', async () => {
        const { server } = make('1', {
            handle: () => ({
                status: 'failed',
                retcode: 10003,
                data: null,
                message: 'fixture-secret',
            }),
        });
        const { port } = await server.open();
        const result = await request(
            port,
            '/?access_token=token',
            JSON.stringify({ action: 'x', params: {}, echo: 'id' }),
            { 'content-type': 'application/json' },
        );
        expect(result.body).toMatchObject({ status: 'failed', retcode: 10003, echo: 'id' });
        expect(result.body.message).toContain('side effects may have occurred');
        expect(result.body.message).toContain('do not retry automatically');
        expect(JSON.stringify(result.body)).not.toContain('fixture-secret');
    });
    it('marks a timeout as unknown while the original side effect finishes once', async () => {
        let effects = 0;
        let finish!: () => void;
        const settled = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const { server } = make('1', {
            timeoutMs: 40,
            maxConcurrent: 1,
            handle: async () => {
                await new Promise<void>((resolve) => setTimeout(resolve, 120));
                effects++;
                finish();
                return { status: 'ok', retcode: 0, data: null, message: '' };
            },
        });
        const { port } = await server.open();
        const call = (echo: string) =>
            request(
                port,
                '/?access_token=token',
                JSON.stringify({ action: 'send', params: {}, echo }),
                { 'content-type': 'application/json' },
            );
        const timedOut = await call('first');
        expect(timedOut.body).toMatchObject({ status: 'failed', retcode: 20002, echo: 'first' });
        expect(timedOut.body.message).toContain('side effects may have occurred');
        expect(timedOut.body.message).toContain('do not retry automatically');
        const busy = await call('second');
        expect(busy.body).toMatchObject({
            status: 'failed',
            echo: 'second',
            message: 'transport busy',
        });
        await settled;
        expect(effects).toBe(1);
    });
    it('destroys the response on write failure without an unhandled rejection', async () => {
        const unhandled: unknown[] = [];

        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason);
        };

        process.on('unhandledRejection', onUnhandled);
        const { server } = make();
        server.attach();
        const external = http.createServer((req, res) => {
            res.writeHead = (() => {
                throw new Error('private-marker');
            }) as typeof res.writeHead;
            server.handleRequest(req, res);
        });
        await new Promise<void>((resolve) => external.listen(0, '127.0.0.1', resolve));

        try {
            const port = (external.address() as import('node:net').AddressInfo).port;
            await expect(
                request(port, '/?access_token=token', JSON.stringify({ action: 'x', params: {} }), {
                    'content-type': 'application/json',
                }),
            ).rejects.toThrow();
            await new Promise<void>((resolve) => setTimeout(resolve, 60));
            expect(unhandled).toEqual([]);
        } finally {
            process.removeListener('unhandledRejection', onUnhandled);
            await server.close();
            await new Promise<void>((resolve) => external.close(() => resolve()));
        }
    });
    it('leaves shared-listener TCP admission to its owner', async () => {
        const { server } = make('1', { maxConnections: 1 });
        server.attach();
        const external = http.createServer((req, res) => server.handleRequest(req, res));
        external.on('upgrade', (req, socket, head) => server.handleUpgrade(req, socket, head));
        await new Promise<void>((resolve) => external.listen(0, '127.0.0.1', resolve));
        const port = (external.address() as import('node:net').AddressInfo).port;
        const connections: net.Socket[] = [];

        try {
            for (let i = 0; i < 2; i++) {
                const socket = net.connect(port, '127.0.0.1');
                connections.push(socket);
                await new Promise<void>((resolve, reject) => {
                    socket.once('connect', resolve);
                    socket.once('error', reject);
                });
            }

            expect(connections.every((socket) => !socket.destroyed)).toBe(true);
            await server.close();
            expect(connections.every((socket) => !socket.destroyed)).toBe(true);
        } finally {
            for (const socket of connections) {
                socket.destroy();
            }

            await new Promise<void>((resolve) => external.close(() => resolve()));
        }
    });
    it('supports caller-owned shared listener and cleanup', async () => {
        const { server } = make();
        server.attach();
        const external = http.createServer((req, res) => server.handleRequest(req, res));
        external.on('upgrade', (req, socket, head) => server.handleUpgrade(req, socket, head));
        await new Promise<void>((resolve) => external.listen(0, '127.0.0.1', resolve));

        try {
            const port = (external.address() as import('node:net').AddressInfo).port;
            expect(
                (
                    await request(port, '/?access_token=token', '{}', {
                        'content-type': 'application/json',
                    })
                ).status,
            ).toBe(200);
            const c = connect(port);
            expect(await c.next()).toMatchObject({ detail_type: 'connect' });
            await server.close();
        } finally {
            await new Promise<void>((resolve) => external.close(() => resolve()));
        }
    });
});
