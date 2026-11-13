import { afterEach, describe, expect, it, vi } from 'vitest';
import { OneBot12WebSocketClient } from '../../src/v12/websocket-client.js';
import * as protocol from '../../src/v12/protocol.js';
import type { OneBot12Event } from '../../src/v12/types.js';

class FakeSocket extends EventTarget {
    static latest: FakeSocket;
    readonly sent: string[] = [];
    readyState = 0;
    bufferedAmount = 0;
    constructor(readonly url: string) {
        super();
        FakeSocket.latest = this;
    }
    send(data: string) {
        this.sent.push(data);
    }
    close() {
        this.readyState = 3;
        this.dispatchEvent(new Event('close'));
    }
    open() {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
    }
    frame(value: unknown) {
        this.dispatchEvent(
            new MessageEvent('message', {
                data: typeof value === 'string' ? value : JSON.stringify(value),
            }),
        );
    }
}
const clients: OneBot12WebSocketClient[] = [];

function client(options: Record<string, unknown> = {}): OneBot12WebSocketClient {
    const instance = new OneBot12WebSocketClient({
        url: 'ws://localhost/',
        webSocket: FakeSocket as unknown as typeof WebSocket,
        ...options,
    });
    clients.push(instance);
    return instance;
}

async function connected(options: Record<string, unknown> = {}) {
    const instance = client(options);
    const opening = instance.connect();
    const socket = FakeSocket.latest;
    socket.open();
    await opening;
    return { instance, socket };
}

const response = (echo: string, data: unknown = null) => ({
    status: 'ok',
    retcode: 0,
    data,
    message: '',
    echo,
});
afterEach(() => {
    for (const item of clients.splice(0)) {
        item.close();
    }
});

describe('OneBot 12 WebSocket application client', () => {
    it('matches out-of-order replies and preserves account-specific self and extension fields', async () => {
        const { instance, socket } = await connected();
        const a = instance.request(
            'send_message',
            { detail_type: 'private' },
            { self: { platform: 'qq', user_id: '1' } },
        );
        const b = instance.request(
            'send_message',
            { detail_type: 'group' },
            { self: { platform: 'other', user_id: '1' } },
        );
        const [first, second] = socket.sent.map((value) => JSON.parse(value));
        expect(first.self).toEqual({ platform: 'qq', user_id: '1' });
        expect(second.self).toEqual({ platform: 'other', user_id: '1' });
        expect(first.echo).not.toBe(second.echo);
        socket.frame({ ...response(second.echo, 'b'), 'x.ext': true, id: 'response-extension' });
        socket.frame(response(first.echo, 'a'));
        expect((await b)['x.ext']).toBe(true);
        expect((await a).data).toBe('a');
    });

    it('dispatches valid events even with an echo extension; invalid events and unknown responses are observable', async () => {
        const { instance, socket } = await connected();
        const events: OneBot12Event[] = [];
        const errors: string[] = [];
        instance.onEvent((event) => events.push(event));
        instance.onError((error) => errors.push(error.code));
        socket.frame({
            id: 'event',
            time: 1.25,
            type: 'message',
            detail_type: 'private',
            sub_type: '',
            self: { platform: 'qq', user_id: '123' },
            echo: 'extension',
            message_id: '1',
            user_id: '2',
            alt_message: 'hello',
            message: [{ type: 'text', data: { text: 'hello' } }],
        });
        socket.frame({ id: 'bad', type: 'message', detail_type: 'private' });
        socket.frame(response('unknown'));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ id: 'event', echo: 'extension' });
        expect(errors).toEqual(['protocol', 'protocol']);
    });

    it('keeps failed action responses as complete results and rejects malformed correlated replies', async () => {
        const { instance, socket } = await connected();
        const a = instance.request('x');
        const first = JSON.parse(socket.sent[0]);
        socket.frame({
            status: 'failed',
            retcode: 10002,
            data: null,
            message: 'unsupported',
            echo: first.echo,
        });
        expect(await a).toMatchObject({ status: 'failed', message: 'unsupported' });
        const b = instance.request('x');
        const second = JSON.parse(socket.sent[1]);
        socket.frame({ status: 'ok', data: null, echo: second.echo });
        await expect(b).rejects.toMatchObject({ code: 'invalid_response' });
    });

    it('times out and aborts individually, ignores late response, and rejects pending on close', async () => {
        const { instance, socket } = await connected({ maxPendingRequests: 1 });
        const timed = instance.request('one', {}, { timeoutMs: 10 });
        await expect(timed).rejects.toMatchObject({ code: 'timeout' });
        const late = JSON.parse(socket.sent[0]).echo;
        const controller = new AbortController();
        const aborted = instance.request('two', {}, { signal: controller.signal });
        socket.frame(response(late));
        controller.abort();
        await expect(aborted).rejects.toMatchObject({ code: 'aborted' });
        const pending = instance.request('three');
        socket.close();
        await expect(pending).rejects.toMatchObject({ code: 'closed' });
        expect(socket.sent).toHaveLength(3);
    });

    it('rejects too many pending calls and oversized inbound frames without revealing content', async () => {
        const { instance, socket } = await connected({
            maxPendingRequests: 1,
            maxResponseBytes: 64,
        });
        const pending = instance.request('one');
        await expect(instance.request('two')).rejects.toMatchObject({ code: 'limit' });
        socket.frame('sensitive'.repeat(20));
        const error = await pending.catch((cause: unknown) => cause);
        expect(error).toMatchObject({ code: 'limit' });
        expect(String(error)).not.toContain('sensitive');
    });

    it('isolates per-listener self and nested extensions across synchronous and asynchronous changes', async () => {
        const { instance, socket } = await connected();
        const received: OneBot12Event[] = [];
        instance.onEvent(async (event) => {
            if (event.self) {
                event.self.user_id = 'B';
            }

            (event.extra as { nested: { value: string } }).nested.value = 'changed';
            await Promise.resolve();
            (event.extra as { nested: { value: string } }).nested.value = 'later';
            throw new Error('secret async failure');
        });
        const errors: string[] = [];
        instance.onError((error) => errors.push(`${error.code}:${error.message}`));
        instance.onEvent((event) => {
            received.push(event);
        });
        socket.frame({
            id: 'e',
            time: 1,
            type: 'notice',
            detail_type: 'custom',
            sub_type: '',
            self: { platform: 'qq', user_id: 'A' },
            extra: { nested: { value: 'original' } },
        });
        expect(received[0].self?.user_id).toBe('A');
        expect(received[0].extra).toEqual({ nested: { value: 'original' } });
        expect(Object.getPrototypeOf(received[0])).toBeNull();
        expect(Object.getPrototypeOf(received[0].self)).toBeNull();
        expect(Object.getPrototypeOf(received[0].extra)).toBeNull();
        await Promise.resolve();
        await Promise.resolve();
        expect(received[0].extra).toEqual({ nested: { value: 'original' } });
        expect(errors).toEqual(['callback:OneBot 12 event callback failed']);
    });

    it('uses only wire-owned classification fields when Object.prototype is polluted', async () => {
        const { instance, socket } = await connected();
        const events: OneBot12Event[] = [];
        const errors: string[] = [];
        instance.onEvent((event) => events.push(event));
        instance.onError((error) => errors.push(error.code));
        const pending = instance.request('x', {}, { timeoutMs: 0 });
        const rejected = expect(pending).rejects.toMatchObject({ code: 'protocol' });
        const echo = JSON.parse(socket.sent[0]).echo;
        const keys = ['echo', 'type', 'id', 'detail_type', 'status', 'retcode', 'self'];
        const saved = new Map(
            keys.map((key) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]),
        );

        try {
            for (const key of keys) {
                Object.defineProperty(Object.prototype, key, {
                    configurable: true,
                    get() {
                        if (key === 'echo') {
                            return echo;
                        }

                        if (key === 'self') {
                            return { platform: 'qq', user_id: 'polluted' };
                        }

                        throw new Error(`unexpected inherited ${key}`);
                    },
                });
            }

            socket.frame(
                '{"id":"meta","time":1,"type":"meta","detail_type":"heartbeat","sub_type":"","extension":{"ok":true}}',
            );
            socket.frame('{"status":"ok","retcode":0,"data":null,"message":""}');
        } finally {
            for (const key of keys) {
                const descriptor = saved.get(key);

                if (descriptor) {
                    Object.defineProperty(Object.prototype, key, descriptor);
                } else {
                    Reflect.deleteProperty(Object.prototype, key);
                }
            }
        }

        await rejected;
        expect(instance.isConnected).toBe(false);
        expect(events).toHaveLength(1);
        expect(events[0].self).toBeUndefined();
        expect(events[0].extension).toEqual({ ok: true });
        expect(errors).toEqual(['protocol']);
    });

    it('does not inherit polluted Object.prototype.self for a meta event', async () => {
        const { instance, socket } = await connected();
        const events: OneBot12Event[] = [];
        instance.onEvent((event) => events.push(event));
        instance.onEvent((event) => events.push(event));
        const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'self');

        try {
            Object.defineProperty(Object.prototype, 'self', {
                configurable: true,
                writable: true,
                value: { platform: 'qq', user_id: 'polluted' },
            });
            socket.frame(
                '{"id":"meta","time":1,"type":"meta","detail_type":"heartbeat","sub_type":""}',
            );
        } finally {
            if (descriptor) {
                Object.defineProperty(Object.prototype, 'self', descriptor);
            } else {
                Reflect.deleteProperty(Object.prototype, 'self');
            }
        }

        expect(events).toHaveLength(2);

        for (const event of events) {
            expect(Object.getPrototypeOf(event)).toBeNull();
            expect('self' in event).toBe(false);
            expect(event.self).toBeUndefined();
        }
    });

    it('reports a sanitized snapshot failure and still dispatches to subsequent listeners', async () => {
        const { instance, socket } = await connected();
        const errors: string[] = [];
        const events: OneBot12Event[] = [];
        const original = protocol.parseOneBot12Event;
        const spy = vi
            .spyOn(protocol, 'parseOneBot12Event')
            .mockImplementationOnce(() => {
                throw new Error('secret snapshot');
            })
            .mockImplementation(original);

        try {
            instance.onError((error) => errors.push(`${error.code}:${error.message}`));
            instance.onEvent((event) => events.push(event));
            instance.onEvent((event) => events.push(event));
            socket.frame({
                id: 'e',
                time: 1,
                type: 'meta',
                detail_type: 'heartbeat',
                sub_type: '',
            });
            expect(events).toHaveLength(1);
            expect(events[0].id).toBe('e');
            expect(errors).toEqual(['protocol:OneBot 12 event snapshot failed']);
        } finally {
            spy.mockRestore();
        }
    });

    it('continues dispatch after a synchronous event listener throws', async () => {
        const { instance, socket } = await connected();
        const errors: string[] = [];
        const seen: string[] = [];
        instance.onError((error) => errors.push(error.code));
        instance.onEvent(() => {
            throw new Error('secret');
        });
        instance.onEvent((event) => seen.push(event.id));
        socket.frame({ id: 'e', time: 1, type: 'meta', detail_type: 'heartbeat', sub_type: '' });
        expect(seen).toEqual(['e']);
        expect(errors).toEqual(['callback']);
    });

    it('rejects overflowing the outgoing buffer and unsafe event numbers', async () => {
        const { instance, socket } = await connected({ maxBufferedBytes: 200 });
        const errors: string[] = [];
        instance.onError((error) => errors.push(error.code));
        socket.bufferedAmount = 200;
        await expect(instance.request('x')).rejects.toMatchObject({ code: 'limit' });
        expect(socket.sent).toHaveLength(0);
        socket.frame(
            '{"id":"e","time":1e-400,"type":"meta","detail_type":"heartbeat","sub_type":""}',
        );
        expect(errors).toEqual(['protocol']);
    });

    it('reports asynchronous event callback failures without exposing callback contents', async () => {
        const { instance, socket } = await connected();
        const errors: string[] = [];
        instance.onError((error) => {
            errors.push(`${error.code}:${error.message}`);
        });
        instance.onEvent(async () => {
            throw new Error('secret-callback');
        });
        socket.frame({ id: 'id', time: 1, type: 'meta', detail_type: 'heartbeat', sub_type: '' });
        await Promise.resolve();
        await Promise.resolve();
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('callback');
        expect(errors[0]).not.toContain('secret-callback');
    });

    it('requires explicit token query transport and keeps it out of public url and errors', async () => {
        expect(() => client({ accessToken: 'secret' })).toThrow(/explicit query/);
        const { instance, socket } = await connected({
            accessToken: 'secret',
            tokenTransport: 'query',
        });
        expect(new URL(socket.url).searchParams.get('access_token')).toBe('secret');
        expect(instance.url).not.toContain('secret');
    });

    it('reserves capacity before waiting for open and releases it on abort and close', async () => {
        const instance = client({ maxPendingRequests: 1, requestTimeoutMs: 0 });
        const opening = instance.connect();
        const openingClosed = expect(opening).rejects.toMatchObject({ code: 'closed' });
        const aborter = new AbortController();
        const first = instance.request('first', {}, { timeoutMs: 0, signal: aborter.signal });
        const firstAborted = expect(first).rejects.toMatchObject({ code: 'aborted' });
        const extra = Array.from({ length: 100 }, () =>
            instance.request('extra', {}, { timeoutMs: 0 }),
        );
        await Promise.all(
            extra.map((request) => expect(request).rejects.toMatchObject({ code: 'limit' })),
        );
        aborter.abort();
        await firstAborted;
        const second = instance.request('second', {}, { timeoutMs: 0 });
        const secondClosed = expect(second).rejects.toMatchObject({ code: 'closed' });
        await expect(instance.request('third', {}, { timeoutMs: 0 })).rejects.toMatchObject({
            code: 'limit',
        });
        instance.close();
        await Promise.all([openingClosed, secondClosed]);
        const reopened = instance.connect();
        const socket = FakeSocket.latest;
        socket.open();
        await reopened;
        const action = instance.request('fourth', {}, { timeoutMs: 0 });
        socket.frame(response(JSON.parse(socket.sent[0]).echo));
        await expect(action).resolves.toMatchObject({ status: 'ok' });
        const after = instance.request('fifth', {}, { timeoutMs: 0 });
        socket.frame(response(JSON.parse(socket.sent[1]).echo));
        await expect(after).resolves.toMatchObject({ status: 'ok' });
    });

    it('releases reserved capacity after timeout and invalid options while opening', async () => {
        const instance = client({ maxPendingRequests: 1, requestTimeoutMs: 0 });
        const opening = instance.connect();
        const closed = expect(opening).rejects.toMatchObject({ code: 'closed' });
        await expect(instance.request('x', {}, { timeoutMs: -1 })).rejects.toMatchObject({
            code: 'invalid_options',
        });
        await expect(instance.request('x', {}, { timeoutMs: 5 })).rejects.toMatchObject({
            code: 'timeout',
        });
        const waiting = instance.request('x', {}, { timeoutMs: 0 });
        const waitingClosed = expect(waiting).rejects.toMatchObject({ code: 'closed' });
        instance.close();
        await Promise.all([closed, waitingClosed]);
    });

    it('reserves capacity during constructor reentrancy and releases it after close', async () => {
        let instance: OneBot12WebSocketClient;
        let first!: Promise<unknown>;
        let second!: Promise<unknown>;
        class ReentrantSocket extends FakeSocket {
            constructor(url: string) {
                super(url);
                first = instance
                    .request('first', {}, { timeoutMs: 0 })
                    .catch((error: unknown) => error);
                second = instance
                    .request('second', {}, { timeoutMs: 0 })
                    .catch((error: unknown) => error);
                instance.close();
            }
        }
        instance = client({ webSocket: ReentrantSocket, maxPendingRequests: 1 });
        await expect(instance.connect()).rejects.toMatchObject({ code: 'closed' });
        await expect(first).resolves.toMatchObject({ code: 'closed' });
        await expect(second).resolves.toMatchObject({ code: 'limit' });
        await expect(instance.request('after')).rejects.toMatchObject({ code: 'closed' });
    });

    it('expires an unopened connection and rejects waiting calls; reconnect is explicit', async () => {
        const instance = client({ requestTimeoutMs: 10 });
        const opening = instance.connect();
        const openingResult = expect(opening).rejects.toMatchObject({ code: 'timeout' });
        const waitingResult = expect(
            instance.request('x', {}, { timeoutMs: 100 }),
        ).rejects.toMatchObject({ code: 'timeout' });
        const old = FakeSocket.latest;
        await Promise.all([openingResult, waitingResult]);
        expect(old.readyState).toBe(3);
        const next = instance.connect();
        FakeSocket.latest.open();
        await next;
        expect(instance.isConnected).toBe(true);
    });

    it('closes even during reentrant WebSocket construction', async () => {
        let instance: OneBot12WebSocketClient;
        class ReentrantSocket extends FakeSocket {
            constructor(url: string) {
                super(url);
                instance.close();
            }
        }
        instance = client({ webSocket: ReentrantSocket });
        await expect(instance.connect()).rejects.toMatchObject({ code: 'closed' });
        expect(FakeSocket.latest.readyState).toBe(3);
        expect(instance.isConnected).toBe(false);
    });

    it('does not reuse echoes after timeout, even when the random UUID repeats', async () => {
        const spy = vi
            .spyOn(globalThis.crypto, 'randomUUID')
            .mockReturnValue('00000000-0000-4000-8000-000000000000');

        try {
            const { instance, socket } = await connected();
            await expect(instance.request('a', {}, { timeoutMs: 5 })).rejects.toMatchObject({
                code: 'timeout',
            });
            const oldEcho = JSON.parse(socket.sent[0]).echo;
            const next = instance.request('b');
            const newEcho = JSON.parse(socket.sent[1]).echo;
            expect(newEcho).not.toBe(oldEcho);
            socket.frame(response(oldEcho, 'stale'));
            socket.frame(response(newEcho, 'fresh'));
            expect((await next).data).toBe('fresh');
        } finally {
            spy.mockRestore();
        }
    });

    it.each([
        '{"status":"ok","retcode":0,"data":null,"message":""}',
        '{"status":"ok","retcode":0,"data":null,"message":"","echo":"x","\\u0065cho":"x"}',
    ])('terminates ambiguous responses rather than leaking pending calls', async (frame) => {
        const { instance, socket } = await connected();
        const pending = instance.request('x', {}, { timeoutMs: 0 });
        const rejected = expect(pending).rejects.toMatchObject({ code: 'protocol' });
        socket.frame(frame);
        await rejected;
        expect(instance.isConnected).toBe(false);
    });

    it('routes response-shaped event extensions and rejects truly ambiguous envelopes', async () => {
        const { instance, socket } = await connected();
        const first = instance.request('x');
        const echo = JSON.parse(socket.sent[0]).echo;
        socket.frame({
            ...response(echo, 1),
            id: 'extension',
            type: 'message',
            detail_type: 'private',
        });
        expect((await first).data).toBe(1);
        const second = instance.request('x', {}, { timeoutMs: 0 });
        const secondEcho = JSON.parse(socket.sent[1]).echo;
        const rejected = expect(second).rejects.toMatchObject({ code: 'protocol' });
        socket.frame({
            ...response(secondEcho),
            id: 'e',
            time: 1,
            type: 'meta',
            detail_type: 'heartbeat',
            sub_type: '',
        });
        await rejected;
        expect(instance.isConnected).toBe(false);
    });

    it('does not move a request waiting on one opening to a subsequent connection', async () => {
        const instance = client();
        const first = instance.connect();
        const old = FakeSocket.latest;
        const pending = instance.request('x');
        old.open();
        instance.close();
        const second = instance.connect();
        const next = FakeSocket.latest;
        next.open();
        await first;
        await second;
        await expect(pending).rejects.toMatchObject({ code: 'closed' });
        expect(next.sent).toHaveLength(0);
    });

    it('checks the connection again after reentrant request serialization', async () => {
        const { instance, socket } = await connected();
        const params = new Proxy(
            {},
            {
                ownKeys(target) {
                    instance.close();
                    return Reflect.ownKeys(target);
                },
            },
        );
        await expect(instance.request('x', params)).rejects.toMatchObject({ code: 'closed' });
        expect(socket.sent).toHaveLength(0);
    });

    it('rejects binary frames and numeric precision loss while protecting callback errors', async () => {
        const { instance, socket } = await connected();
        const errors: string[] = [];
        instance.onError((error) => {
            errors.push(error.code);
            throw new Error('private');
        });
        socket.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([1, 2]) }));
        const pending = instance.request('x');
        const echo = JSON.parse(socket.sent[0]).echo;
        const failed = expect(pending).rejects.toMatchObject({ code: 'invalid_response' });
        socket.frame(
            `{"status":"ok","retcode":0,"data":9007199254740993,"message":"","echo":${JSON.stringify(echo)}}`,
        );
        await failed;
        expect(errors).toEqual(['protocol', 'invalid_response']);
    });

    it('aborts a request waiting for an existing connection without sending later', async () => {
        const instance = client();
        const open = instance.connect();
        const socket = FakeSocket.latest;
        const aborter = new AbortController();
        const request = instance.request('x', {}, { signal: aborter.signal });
        aborter.abort();
        await expect(request).rejects.toMatchObject({ code: 'aborted' });
        socket.open();
        await open;
        expect(socket.sent).toEqual([]);
    });
});
