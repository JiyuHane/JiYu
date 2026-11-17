import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    V12HttpPollCapability,
    V12HttpPollResult,
    V12Transport,
    V12TransportOptions,
} from '../../src/v12-network';

const mockState = vi.hoisted(() => ({
    nextWebSocket: null as unknown,
    realWebSocketAttempts: 0,
    namedHttpServerAttempts: 0,
}));

// Block the transport's named import as well as the default HTTP export guarded below.
vi.mock('node:http', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:http')>();
    return {
        ...actual,
        createServer: () => {
            mockState.namedHttpServerAttempts++;
            throw new Error('unexpected HTTP server creation');
        },
    };
});

// handleUpgrade returns only the explicitly supplied in-memory WebSocket.
vi.mock('@snowluma/websocket', () => ({
    WebSocket: class {
        constructor() {
            mockState.realWebSocketAttempts++;
            throw new Error('unexpected WebSocket creation');
        }
    },
    WebSocketServer: class {
        constructor(options: { noServer?: boolean }) {
            if (options.noServer !== true) {
                throw new Error('unexpected WebSocket listener');
            }
        }

        handleUpgrade(
            _request: unknown,
            _socket: unknown,
            _head: unknown,
            callback: (ws: unknown) => void,
        ): void {
            const ws = mockState.nextWebSocket;
            mockState.nextWebSocket = null;

            if (!ws) {
                throw new Error('missing fake WebSocket');
            }

            callback(ws);
        }

        destroy(): void {}
    },
}));

class FakeRequest extends EventEmitter {
    url = '/';
    method = 'POST';
    headers: Record<string, string> = { 'content-type': 'application/json' };
    rawHeaders: string[] = [];

    pause(): void {}
}

class FakeResponse extends EventEmitter {
    headersSent = false;
    destroyed = false;
    writableEnded = false;
    writableFinished = false;
    finished = false;
    writes = 0;
    bodies: string[] = [];
    headHook?: () => void;

    setHeader(): void {}

    writeHead(_status: number): this {
        this.writes++;
        this.headHook?.();
        this.headersSent = true;
        return this;
    }

    end(body: string): this {
        this.bodies.push(body);
        this.writableEnded = true;

        if (!this.destroyed) {
            this.writableFinished = true;
            this.finished = true;
            this.emit('finish');
        }

        return this;
    }

    destroy(): this {
        if (!this.destroyed) {
            this.destroyed = true;
            this.emit('close');
        }

        return this;
    }
}

class FakeSocket extends EventEmitter {
    destroyed = false;

    end(): void {}

    destroy(): void {
        this.destroyed = true;
    }
}

class FakeWebSocket extends EventEmitter {
    frames: unknown[] = [];
    terminated = false;

    send(text: string, callback?: (error?: Error) => void): void {
        this.frames.push(JSON.parse(text) as unknown);
        callback?.();
    }

    terminate(): void {
        if (!this.terminated) {
            this.terminated = true;
            this.emit('close');
        }
    }
}

let Transport: typeof V12Transport;
let transports: V12Transport[] = [];
let guards: Array<{ mock: { calls: unknown[] } }> = [];
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let unhandled: unknown[] = [];

function blocked(): never {
    throw new Error('unexpected network or native operation in fake fixture');
}

function onUnhandled(reason: unknown): void {
    unhandled.push(reason);
}

beforeEach(async () => {
    transports = [];
    guards = [];
    unhandled = [];
    mockState.nextWebSocket = null;
    mockState.namedHttpServerAttempts = 0;
    mockState.realWebSocketAttempts = 0;
    fetchGuard = vi.fn(blocked);
    webSocketGuard = vi.fn(function ForbiddenWebSocket() {
        return blocked();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    guards = [
        vi.spyOn(net, 'createServer').mockImplementation(blocked),
        vi.spyOn(net, 'createConnection').mockImplementation(blocked),
        vi.spyOn(net, 'connect').mockImplementation(blocked),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(blocked),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(http, 'createServer').mockImplementation(blocked),
        vi.spyOn(http, 'request').mockImplementation(blocked),
        vi.spyOn(http, 'get').mockImplementation(blocked),
        vi.spyOn(https, 'createServer').mockImplementation(blocked),
        vi.spyOn(https, 'request').mockImplementation(blocked),
        vi.spyOn(https, 'get').mockImplementation(blocked),
        vi.spyOn(http2, 'createServer').mockImplementation(blocked),
        vi.spyOn(http2, 'createSecureServer').mockImplementation(blocked),
        vi.spyOn(http2, 'connect').mockImplementation(blocked),
        vi.spyOn(tls, 'createServer').mockImplementation(blocked),
        vi.spyOn(tls, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram, 'createSocket').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(blocked),
        vi.spyOn(process, 'dlopen').mockImplementation(blocked),
    ];
    process.on('unhandledRejection', onUnhandled);
    ({ V12Transport: Transport } = await import('../../src/v12-network'));
});

afterEach(async () => {
    let closeFailures = 0;

    try {
        for (const transport of transports) {
            try {
                await transport.close();
            } catch {
                closeFailures++;
            }
        }

        // Give any unobserved rejected diagnostic promise an event-loop turn.
        await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
        const calls = guards.map((guard) => guard.mock.calls.length);
        const fetchCalls = fetchGuard.mock.calls.length;
        const webSocketCalls = webSocketGuard.mock.calls.length;
        const namedHttpCalls = mockState.namedHttpServerAttempts;
        const realWebSocketCalls = mockState.realWebSocketAttempts;
        const unhandledReasons = [...unhandled];
        process.off('unhandledRejection', onUnhandled);
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        expect(closeFailures).toBe(0);
        expect(calls).toEqual(calls.map(() => 0));
        expect(fetchCalls).toBe(0);
        expect(webSocketCalls).toBe(0);
        expect(namedHttpCalls).toBe(0);
        expect(realWebSocketCalls).toBe(0);
        expect(unhandledReasons).toEqual([]);
    }
});

async function flush(): Promise<void> {
    for (let i = 0; i < 24; i++) {
        await Promise.resolve();
    }
}

function fixture(
    capability: V12HttpPollCapability,
    callbacks: Pick<V12TransportOptions, 'onError' | 'onPollError'>,
) {
    const subscribers = new Set<(event: unknown) => void>();
    const handle = vi.fn(() => ({ status: 'ok' as const, retcode: 0, data: null, message: '' }));
    const unsubscribe = vi.fn((listener: (event: unknown) => void) => {
        subscribers.delete(listener);
    });
    const options: V12TransportOptions = {
        host: 'fixture',
        port: 0,
        handle,
        httpPoll: capability,
        getConnectEvent: () => ({ type: 'connect' }),
        subscribe: (listener) => {
            subscribers.add(listener);
            return () => unsubscribe(listener);
        },
        ...callbacks,
    };
    const transport = new Transport(options);
    transports.push(transport);
    transport.attach();
    const ws = new FakeWebSocket();
    const socket = new FakeSocket();
    const upgrade = new FakeRequest();
    upgrade.method = 'GET';
    mockState.nextWebSocket = ws;
    transport.handleUpgrade(
        upgrade as unknown as IncomingMessage,
        socket as unknown as Duplex,
        Buffer.alloc(0),
    );
    expect(mockState.nextWebSocket).toBeNull();
    expect(socket.destroyed).toBe(false);
    expect(subscribers.size).toBe(1);
    expect(ws.frames).toEqual([{ type: 'connect' }]);
    return { transport, options, subscribers, unsubscribe, handle, ws };
}

type Fixture = ReturnType<typeof fixture>;
type ErrorPath = 'shape' | 'preflight' | 'sink' | 'late-host';
const paths: ErrorPath[] = ['shape', 'preflight', 'sink', 'late-host'];
const secret = 'synthetic-request-payload-do-not-report';

function makeCapability(path: ErrorPath, onAbort?: () => void) {
    const sinkError = vi.fn();
    let signal: AbortSignal | undefined;
    const capability: V12HttpPollCapability = {
        run: vi.fn(
            (
                _input: unknown,
                context: Parameters<V12HttpPollCapability['run']>[1],
            ): V12HttpPollResult => {
                signal = context.signal;

                if (path === 'sink') {
                    context.sink.on('error', sinkError);

                    if (onAbort) {
                        context.signal.addEventListener('abort', onAbort, { once: true });
                    }

                    try {
                        context.sink.writeHead();
                    } finally {
                        context.sink.off('error', sinkError);
                    }
                }

                if (path === 'preflight') {
                    return { kind: 'preflight', error: 'invalid_params' };
                }

                return { kind: 'unavailable' };
            },
        ),
    };
    return { capability, sinkError, getSignal: () => signal };
}

async function trigger(f: Fixture, path: ErrorPath, onResponse?: (res: FakeResponse) => void) {
    const req = new FakeRequest();
    const res = new FakeResponse();
    const raw = new Error(secret);
    onResponse?.(res);

    if (path !== 'late-host') {
        res.headHook = () => {
            res.headHook = undefined;
            res.emit('error', raw);
        };
    }

    f.transport.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    req.emit(
        'data',
        Buffer.from(
            JSON.stringify({
                action: 'get_latest_events',
                params: path === 'shape' ? null : { payload: secret },
                echo: secret,
            }),
        ),
    );
    req.emit('end');
    await flush();

    if (path === 'late-host') {
        // The capability has settled and its sink was disposed, but the transport
        // retains the independent response error listener after finish.
        expect(res.finished).toBe(true);
        expect(res.destroyed).toBe(false);
        res.emit('error', raw);
    }

    // Duplicate/late response errors must not produce a second diagnostic.
    res.emit('error', new Error(`late ${secret}`));
    await flush();
    expect(res.destroyed).toBe(true);
    expect((f.transport as unknown as { pollUnknown: number }).pollUnknown).toBe(1);
    return { res, raw };
}

async function expectWsStillWorks(f: Fixture): Promise<void> {
    expect(f.transport.isAcceptingActions()).toBe(true);
    expect(f.subscribers.size).toBe(1);
    expect(f.unsubscribe).not.toHaveBeenCalled();
    expect(f.ws.terminated).toBe(false);

    for (const subscriber of f.subscribers) {
        subscriber({ type: 'message', id: 'after-poll-failure' });
    }

    f.ws.emit(
        'message',
        Buffer.from(JSON.stringify({ action: 'get_version', params: {}, echo: 'ws-still-open' })),
        false,
    );
    await flush();
    expect(f.handle).toHaveBeenCalledTimes(1);
    expect(f.ws.frames).toContainEqual({ type: 'message', id: 'after-poll-failure' });
    expect(f.ws.frames).toContainEqual({
        status: 'ok',
        retcode: 0,
        data: null,
        message: '',
        echo: 'ws-still-open',
    });
}

function expectSanitized(error: Error, raw: Error): void {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBe(raw);
    expect(error.message).toBe('poll response error');
    expect(error.stack ?? '').not.toContain(secret);
}

describe('poll response diagnostic isolation (in-memory attach)', () => {
    it.each(paths)(
        'reports %s once only to onPollError and leaves WebSocket subscribers live',
        async (path) => {
            const { capability, sinkError, getSignal } = makeCapability(path);
            const onPollError = vi.fn();
            const onError = vi.fn();
            const f = fixture(capability, { onPollError, onError });
            const { raw } = await trigger(f, path);
            expect(onPollError).toHaveBeenCalledTimes(1);
            expect(onError).not.toHaveBeenCalled();
            expectSanitized(onPollError.mock.calls[0][0] as Error, raw);
            expect(capability.run).toHaveBeenCalledTimes(path === 'shape' ? 0 : 1);

            if (path === 'sink') {
                expect(sinkError).toHaveBeenCalledTimes(1);
                expect(getSignal()?.aborted).toBe(true);
            }

            await expectWsStillWorks(f);
        },
    );

    it.each(paths)(
        'falls back to legacy onError for %s when onPollError is absent',
        async (path) => {
            const { capability } = makeCapability(path);
            let receiver: unknown;
            const onError = vi.fn(function (this: unknown, _error: Error) {
                receiver = this;
            });
            const f = fixture(capability, { onError });
            const { raw } = await trigger(f, path);
            expect(onError).toHaveBeenCalledTimes(1);
            expectSanitized(onError.mock.calls[0][0], raw);
            expect(receiver).toBe(f.options);
            await expectWsStillWorks(f);
        },
    );

    it('reports once when abort synchronously reenters the response error listener', async () => {
        let response!: FakeResponse;
        const reenter = vi.fn(() => response.emit('error', new Error(`reentrant ${secret}`)));
        const { capability } = makeCapability('sink', reenter);
        const onError = vi.fn();
        const onPollError = vi.fn();
        const f = fixture(capability, { onPollError, onError });
        const { raw } = await trigger(f, 'sink', (res) => {
            response = res;
        });
        expect(reenter).toHaveBeenCalledTimes(1);
        expect(onPollError).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
        expectSanitized(onPollError.mock.calls[0][0] as Error, raw);
        await expectWsStillWorks(f);
    });

    it.each(['shape', 'sink'] as const)(
        'contains synchronous throws and rejected promises from poll reporters on %s',
        async (path) => {
            for (const behavior of ['throw', 'reject'] as const) {
                const { capability } = makeCapability(path);
                const onError = vi.fn();
                const onPollError = vi.fn((_error: Error) => {
                    if (behavior === 'throw') {
                        throw new Error(secret);
                    }

                    return Promise.reject(new Error(secret));
                });
                const f = fixture(capability, { onPollError, onError });
                const { raw } = await trigger(f, path);
                expect(onPollError).toHaveBeenCalledTimes(1);
                expectSanitized(onPollError.mock.calls[0][0], raw);
                expect(onError).not.toHaveBeenCalled();
                await expectWsStillWorks(f);
            }
        },
    );

    it.each(['shape', 'sink'] as const)(
        'contains synchronous throws and rejected promises from legacy reporters on %s',
        async (path) => {
            for (const behavior of ['throw', 'reject'] as const) {
                const { capability } = makeCapability(path);
                const onError = vi.fn((_error: Error) => {
                    if (behavior === 'throw') {
                        throw new Error(secret);
                    }

                    return Promise.reject(new Error(secret));
                });
                const f = fixture(capability, { onError });
                const { raw } = await trigger(f, path);
                expect(onError).toHaveBeenCalledTimes(1);
                expectSanitized(onError.mock.calls[0][0], raw);
                await expectWsStillWorks(f);
            }
        },
    );
});
