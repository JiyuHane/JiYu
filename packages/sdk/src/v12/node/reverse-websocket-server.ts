/// <reference types="node" preserve="true" />
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
    checkedLimit,
    hasDuplicateEcho,
    OneBot12ClientError,
    requestDeadline,
} from '../client-types.js';
import type { OneBot12RequestOptions } from '../client-types.js';
import {
    parseOneBot12ActionResponseJson,
    parseOneBot12ActionResponseShapeJson,
    parseOneBot12Event,
    parseOneBot12EventJson,
    serializeOneBot12ActionRequest,
} from '../protocol.js';
import type {
    OneBot12ActionResponse,
    OneBot12Event,
    OneBot12JsonObject,
    OneBot12Self,
} from '../types.js';

export interface OneBot12ReverseWebSocketServerOptions {
    host?: string;
    port?: number;
    path?: string;
    /** On shared hosts this SDK claims its route; callers must dedicate it against non-SDK upgrade handlers. */
    server?: Server | HttpsServer;
    accessToken?: string;
    requestTimeoutMs?: number;
    maxPayloadBytes?: number;
    /** Aggregate pending requests across all implementation connections. */
    maxPendingRequests?: number;
    /** Aggregate queued WebSocket bytes across all implementation connections. */
    maxBufferedBytes?: number;
    maxConnections?: number;
}

type Pending = {
    resolve(value: OneBot12ActionResponse): void;
    reject(error: OneBot12ClientError): void;
};
type EventListener = (event: OneBot12Event) => unknown;
type ErrorListener = (error: OneBot12ClientError) => unknown;
// Duplicate installed SDK copies share this registry; existing incompatible values fail closed.
const routeRegistryKey = Symbol.for('@harehane/sdk/v12/reverse-websocket-server/routes');
type RouteRegistry = WeakMap<Server | HttpsServer, Map<string, object>>;

function routeRegistry(): RouteRegistry {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, routeRegistryKey);

    if (descriptor) {
        if (!('value' in descriptor) || !(descriptor.value instanceof WeakMap)) {
            throw new OneBot12ClientError('invalid_options', 'Invalid OneBot 12 route registry');
        }

        return descriptor.value as RouteRegistry;
    }

    const registry: RouteRegistry = new WeakMap();

    try {
        Object.defineProperty(globalThis, routeRegistryKey, {
            value: registry,
            configurable: false,
            writable: false,
        });
    } catch {
        throw new OneBot12ClientError('invalid_options', 'OneBot 12 route registry unavailable');
    }

    return registry;
}

type ServerEventMap = {
    connection: OneBot12ReverseWebSocketSession;
    disconnect: OneBot12ReverseWebSocketSession;
    rejected: { status: number; reason: string };
    error: OneBot12ClientError;
    /** Terminal diagnostic for a failing error listener; failures here are isolated. */
    callbackError: OneBot12ClientError;
};

let makeSession: (
    implementation: string,
    socket: WebSocket,
    owner: OneBot12ReverseWebSocketServer,
    timeoutMs: number,
) => OneBot12ReverseWebSocketSession;

/** One implementation connection. No account is inferred from its handshake. */
export class OneBot12ReverseWebSocketSession {
    static {
        makeSession = (implementation, socket, owner, timeoutMs) =>
            new OneBot12ReverseWebSocketSession(implementation, socket, owner, timeoutMs);
    }
    private readonly pending = new Map<string, Pending>();
    private readonly listeners = new Set<EventListener>();
    private readonly errors = new Set<ErrorListener>();
    private closed = false;
    readonly #implementation: string;

    private constructor(
        implementation: string,
        private readonly socket: WebSocket,
        private readonly owner: OneBot12ReverseWebSocketServer,
        private readonly timeoutMs: number,
    ) {
        this.#implementation = implementation;
        Object.defineProperty(this, 'implementation', {
            get: () => this.#implementation,
            enumerable: true,
            configurable: false,
        });
        socket.on('message', (data, binary) => this.receive(data.toString(), binary));
        socket.on('error', () =>
            this.owner.report(
                new OneBot12ClientError('network', 'OneBot 12 WebSocket transport failed'),
                this,
            ),
        );
        socket.once('close', () => this.finish());
    }

    get implementation(): string {
        return this.#implementation;
    }
    get isConnected(): boolean {
        return !this.closed && this.socket.readyState === WebSocket.OPEN;
    }
    onEvent(listener: EventListener): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }
    /** Filter on the complete platform and user_id pair without binding a socket to an account. */
    onSelfEvent(self: OneBot12Self, listener: EventListener): () => void {
        const platform = self.platform;
        const userId = self.user_id;
        return this.onEvent((event) => {
            if (
                Object.hasOwn(event, 'self') &&
                event.self?.platform === platform &&
                event.self.user_id === userId
            ) {
                return listener(event);
            }

            return undefined;
        });
    }
    onError(listener: ErrorListener): () => void {
        this.errors.add(listener);

        return () => {
            this.errors.delete(listener);
        };
    }
    async request(
        action: string,
        params: OneBot12JsonObject = {},
        options: OneBot12RequestOptions = {},
    ): Promise<OneBot12ActionResponse> {
        const deadline = requestDeadline(options.timeoutMs ?? this.timeoutMs, options.signal);

        try {
            if (deadline.signal.aborted) {
                throw deadline.failure();
            }

            if (!this.isConnected) {
                throw new OneBot12ClientError('closed', 'OneBot 12 WebSocket is closed');
            }

            const echo = randomUUID();
            let payload: string;

            try {
                payload = serializeOneBot12ActionRequest({
                    action,
                    params,
                    echo,
                    ...(options.self === undefined ? {} : { self: options.self }),
                });
            } catch {
                throw new OneBot12ClientError(
                    'invalid_options',
                    'Invalid OneBot 12 action request',
                );
            }

            this.owner.reserve(Buffer.byteLength(payload));
            return await new Promise<OneBot12ActionResponse>((resolve, reject) => {
                let done = false;

                const settle = (value: OneBot12ActionResponse | OneBot12ClientError): void => {
                    if (done) {
                        return;
                    }

                    done = true;
                    this.pending.delete(echo);
                    this.owner.release();
                    deadline.signal.removeEventListener('abort', abort);

                    if (value instanceof OneBot12ClientError) {
                        reject(value);
                    } else {
                        resolve(value);
                    }
                };

                const abort = () => settle(deadline.failure());
                this.pending.set(echo, { resolve: settle, reject: settle });
                deadline.signal.addEventListener('abort', abort, { once: true });

                if (deadline.signal.aborted) {
                    abort();
                    return;
                }

                try {
                    this.socket.send(payload, (error) => {
                        if (error) {
                            settle(
                                new OneBot12ClientError(
                                    'network',
                                    'OneBot 12 WebSocket send failed',
                                ),
                            );
                        }
                    });
                } catch {
                    settle(new OneBot12ClientError('network', 'OneBot 12 WebSocket send failed'));
                }
            });
        } finally {
            deadline.cleanup();
        }
    }
    call(
        action: string,
        params: OneBot12JsonObject = {},
        options?: OneBot12RequestOptions,
    ): Promise<OneBot12ActionResponse> {
        return this.request(action, params, options);
    }
    /** Terminates rather than waiting indefinitely for a peer close handshake. */
    close(): void {
        this.finish();
        this.socket.terminate();
    }
    private finish(
        error = new OneBot12ClientError('closed', 'OneBot 12 WebSocket closed'),
        reportError = false,
    ): void {
        if (this.closed) {
            return;
        }

        this.closed = true;

        for (const item of [...this.pending.values()]) {
            item.reject(error);
        }

        if (reportError) {
            this.owner.report(error, this);
        }

        this.owner.disconnected(this);
        this.listeners.clear();
        this.errors.clear();
    }
    private failProtocol(message: string): void {
        const error = new OneBot12ClientError('protocol', message);
        this.finish(error, true);
        this.socket.terminate();
    }
    private receive(text: string, binary: boolean): void {
        if (this.closed) {
            return;
        }

        if (binary) {
            this.failProtocol('Unsupported OneBot 12 WebSocket frame');
            return;
        }

        let raw: unknown;

        try {
            raw = JSON.parse(text);
        } catch {
            this.failProtocol('Invalid OneBot 12 JSON frame');
            return;
        }

        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            this.failProtocol('Invalid OneBot 12 frame');
            return;
        }

        const frame = raw as Record<string, unknown>;

        if (hasDuplicateEcho(text)) {
            this.failProtocol('Duplicate OneBot 12 response echo');
            return;
        }

        const hasEcho = Object.hasOwn(frame, 'echo');
        const eventCandidate =
            Object.hasOwn(frame, 'type') ||
            Object.hasOwn(frame, 'id') ||
            Object.hasOwn(frame, 'detail_type');
        const responseCandidate =
            Object.hasOwn(frame, 'status') ||
            Object.hasOwn(frame, 'retcode') ||
            (!eventCandidate && hasEcho);
        let event: OneBot12Event | undefined;
        let response: OneBot12ActionResponse | undefined;

        if (eventCandidate) {
            try {
                event = parseOneBot12EventJson(text);
            } catch {
                /* Classified below. */
            }
        }

        if (event && responseCandidate) {
            let responseLike = false;

            try {
                parseOneBot12ActionResponseShapeJson(text);
                responseLike = true;
            } catch {
                /* An event may carry incomplete response-shaped extensions. */
            }

            if (responseLike) {
                this.failProtocol('Ambiguous OneBot 12 event and response');
                return;
            }
        }

        if (event) {
            for (const listener of this.listeners) {
                try {
                    // Event objects are mutable in the public types. Never share one between listeners.
                    const result = listener(parseOneBot12Event(event));

                    if (result) {
                        void Promise.resolve(result).catch(() =>
                            this.owner.report(
                                new OneBot12ClientError(
                                    'callback',
                                    'OneBot 12 event callback failed',
                                ),
                                this,
                            ),
                        );
                    }
                } catch {
                    this.owner.report(
                        new OneBot12ClientError('callback', 'OneBot 12 event callback failed'),
                        this,
                    );
                }
            }

            return;
        }

        if (responseCandidate) {
            try {
                response = parseOneBot12ActionResponseJson(text);
            } catch {
                /* Classified below. */
            }

            if (!hasEcho || typeof frame.echo !== 'string') {
                this.failProtocol('Missing or invalid OneBot 12 response echo');
                return;
            }

            const item = this.pending.get(frame.echo);

            if (!response) {
                const error = new OneBot12ClientError(
                    'invalid_response',
                    'Invalid OneBot 12 action response',
                );
                item?.reject(error);
                this.owner.report(error, this);
            } else if (item) {
                item.resolve(response);
            } else {
                this.owner.report(
                    new OneBot12ClientError('protocol', 'Unmatched OneBot 12 action response'),
                    this,
                );
            }

            return;
        }

        if (eventCandidate) {
            this.failProtocol('Invalid OneBot 12 event');
            return;
        }

        this.failProtocol('Unrecognized OneBot 12 frame');
    }
    /** @internal */
    report(error: OneBot12ClientError): void {
        const failed = () =>
            this.owner.report(
                new OneBot12ClientError('callback', 'OneBot 12 session error callback failed'),
            );

        for (const listener of this.errors) {
            try {
                const result = listener(error);

                if (result !== undefined) {
                    void Promise.resolve(result).catch(failed);
                }
            } catch {
                failed();
            }
        }
    }
    /** @internal */
    get bufferedAmount(): number {
        return this.socket.bufferedAmount;
    }
}

export class OneBot12ReverseWebSocketServer {
    private readonly options: OneBot12ReverseWebSocketServerOptions;
    private readonly path: string;
    private readonly listeners = new Map<keyof ServerEventMap, Set<(value: never) => unknown>>();
    private readonly sessions = new Set<OneBot12ReverseWebSocketSession>();
    private readonly sockets = new Set<Duplex>();
    private routes: RouteRegistry | null = null;
    private http: Server | HttpsServer | null = null;
    private wss: WebSocketServer | null = null;
    private opening: Promise<void> | null = null;
    private closing: Promise<void> | null = null;
    private pending = 0;
    constructor(options: OneBot12ReverseWebSocketServerOptions = {}) {
        if (options.server && (options.host !== undefined || options.port !== undefined)) {
            throw new OneBot12ClientError(
                'invalid_options',
                'server cannot be combined with host or port',
            );
        }

        if (options.accessToken !== undefined && typeof options.accessToken !== 'string') {
            throw new OneBot12ClientError('invalid_options', 'Invalid accessToken');
        }

        const path = options.path ?? '/';

        if (!path.startsWith('/') || /[?#\s]/.test(path)) {
            throw new OneBot12ClientError('invalid_options', 'Invalid path');
        }

        this.path = path.replace(/\/+$/, '') || '/';
        checkedLimit(options.port ?? 3002, 'port', 0);

        if ((options.port ?? 3002) > 65535) {
            throw new OneBot12ClientError('invalid_options', 'Invalid port');
        }

        checkedLimit(options.requestTimeoutMs ?? 30_000, 'requestTimeoutMs', 0);
        checkedLimit(options.maxPayloadBytes ?? 4 * 1024 * 1024, 'maxPayloadBytes', 1);
        checkedLimit(options.maxPendingRequests ?? 1024, 'maxPendingRequests', 1);
        checkedLimit(options.maxBufferedBytes ?? 4 * 1024 * 1024, 'maxBufferedBytes', 1);
        checkedLimit(options.maxConnections ?? 128, 'maxConnections', 1);
        this.options = { ...options };
    }
    get address(): AddressInfo | string | null {
        return this.http?.address() ?? null;
    }
    get clients(): ReadonlySet<OneBot12ReverseWebSocketSession> {
        return new Set(this.sessions);
    }
    on<K extends keyof ServerEventMap>(
        event: K,
        listener: (value: ServerEventMap[K]) => unknown,
    ): () => void {
        let set = this.listeners.get(event);

        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }

        set.add(listener as (value: never) => unknown);

        return () => {
            set?.delete(listener as (value: never) => unknown);
        };
    }
    private emit<K extends keyof ServerEventMap>(event: K, value: ServerEventMap[K]): void {
        const failed = () => {
            if (event === 'callbackError') {
                return;
            }

            const error = new OneBot12ClientError('callback', 'OneBot 12 server callback failed');

            if (event === 'error') {
                this.emit('callbackError', error);
            } else {
                this.report(error);
            }
        };

        for (const listener of this.listeners.get(event) ?? []) {
            try {
                const result = listener(value as never);

                if (result !== undefined) {
                    void Promise.resolve(result).catch(failed);
                }
            } catch {
                failed();
            }
        }
    }
    /** @internal */
    report(error: OneBot12ClientError, session?: OneBot12ReverseWebSocketSession): void {
        session?.report(error);
        this.emit('error', error);
    }
    /** @internal */
    reserve(bytes: number): void {
        if (this.pending >= (this.options.maxPendingRequests ?? 1024)) {
            throw new OneBot12ClientError('limit', 'OneBot 12 pending request limit reached');
        }

        let queued = bytes;

        for (const session of this.sessions) {
            queued += session.bufferedAmount;
        }

        if (queued > (this.options.maxBufferedBytes ?? 4 * 1024 * 1024)) {
            throw new OneBot12ClientError('limit', 'OneBot 12 outgoing buffer limit reached');
        }

        this.pending++;
    }
    /** @internal */
    release(): void {
        this.pending--;
    }
    /** @internal */
    disconnected(session: OneBot12ReverseWebSocketSession): void {
        if (this.sessions.delete(session)) {
            this.emit('disconnect', session);
        }
    }
    async listen(): Promise<void> {
        if (this.closing) {
            await this.closing;
        }

        if (this.opening) {
            return this.opening;
        }

        if (this.wss) {
            return;
        }

        if (this.options.server && !this.options.server.listening) {
            throw new OneBot12ClientError('closed', 'HTTP server is not listening');
        }

        const http =
            this.options.server ??
            createServer((_request, response) => {
                response.writeHead(426);
                response.end();
            });
        const wss = new WebSocketServer({
            noServer: true,
            perMessageDeflate: false,
            maxPayload: this.options.maxPayloadBytes ?? 4 * 1024 * 1024,
            handleProtocols: (protocols) =>
                [...protocols].find((protocol) =>
                    /^12\.[a-z][-a-z0-9]*(?:\.[-a-z0-9]+)*$/.test(protocol),
                ) || false,
        });

        if (this.options.server) {
            try {
                const registry = routeRegistry();
                let owners = WeakMap.prototype.get.call(registry, http) as
                    Map<string, object> | undefined;

                if (owners === undefined) {
                    owners = new Map();
                    WeakMap.prototype.set.call(registry, http, owners);
                }

                if (!(owners instanceof Map)) {
                    throw new OneBot12ClientError(
                        'invalid_options',
                        'Invalid OneBot 12 route registry',
                    );
                }

                if (Map.prototype.has.call(owners, this.path)) {
                    throw new OneBot12ClientError(
                        'invalid_options',
                        'OneBot 12 listener route is already claimed',
                    );
                }

                Map.prototype.set.call(owners, this.path, this);
                this.routes = registry;
            } catch (error) {
                wss.close();

                if (error instanceof OneBot12ClientError) {
                    throw error;
                }

                throw new OneBot12ClientError(
                    'invalid_options',
                    'Invalid OneBot 12 route registry',
                );
            }
        }

        this.http = http;
        this.wss = wss;
        http.on('upgrade', this.upgrade);
        http.on('close', this.httpClosed);
        http.on('error', this.httpError);
        wss.on('error', this.httpError);
        this.opening = this.options.server
            ? Promise.resolve()
            : new Promise<void>((resolve, reject) => {
                  const fail = () => {
                      http.off('listening', ready);
                      reject(new OneBot12ClientError('network', 'OneBot 12 listener failed'));
                  };

                  const ready = () => {
                      http.off('error', fail);
                      resolve();
                  };

                  http.once('error', fail);
                  http.once('listening', ready);

                  try {
                      http.listen(this.options.port ?? 3002, this.options.host ?? '127.0.0.1');
                  } catch {
                      http.off('error', fail);
                      http.off('listening', ready);
                      reject(new OneBot12ClientError('network', 'OneBot 12 listener failed'));
                  }
              });

        try {
            await this.opening;
        } catch (error) {
            this.detach();
            wss.close();
            throw error;
        } finally {
            this.opening = null;
        }
    }
    async close(): Promise<void> {
        if (this.closing) {
            return this.closing;
        }

        this.closing = (async () => {
            await Promise.resolve();

            if (this.opening) {
                try {
                    await this.opening;
                } catch {
                    return;
                }
            }

            const http = this.http;
            const wss = this.wss;

            if (!http || !wss) {
                return;
            }

            this.detach();

            for (const session of [...this.sessions]) {
                session.close();
            }

            for (const socket of this.sockets) {
                socket.destroy();
            }

            const wsClose = new Promise<void>((resolve) => wss.close(() => resolve()));
            const httpClose = this.options.server
                ? Promise.resolve()
                : new Promise<void>((resolve) => {
                      http.close(() => resolve());
                      http.closeAllConnections();
                  });
            await Promise.all([wsClose, httpClose]);
        })();

        try {
            await this.closing;
        } finally {
            this.closing = null;
        }
    }
    private detach(): void {
        if (this.routes && this.http) {
            const owners = WeakMap.prototype.get.call(this.routes, this.http) as
                Map<string, object> | undefined;

            if (owners instanceof Map && Map.prototype.get.call(owners, this.path) === this) {
                Map.prototype.delete.call(owners, this.path);

                if (owners.size === 0) {
                    WeakMap.prototype.delete.call(this.routes, this.http);
                }
            }

            this.routes = null;
        }

        this.http?.off('upgrade', this.upgrade);
        this.http?.off('close', this.httpClosed);
        this.http?.off('error', this.httpError);
        this.wss?.off('error', this.httpError);
        this.http = null;
        this.wss = null;
    }
    private readonly httpError = (): void => {
        if (!this.opening) {
            this.report(new OneBot12ClientError('network', 'OneBot 12 listener failed'));
        }
    };
    private readonly httpClosed = (): void => {
        void this.close();
    };
    private readonly upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
        const swallow = () => {};

        socket.on('error', swallow);

        const track = () => {
            if (!this.sockets.has(socket)) {
                this.sockets.add(socket);
                socket.once('close', () => this.sockets.delete(socket));
            }
        };

        if (!this.options.server) {
            track();
        }

        const reject = (status: number, reason: string) => {
            track();
            socket.end(
                `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
                () => socket.destroy(),
            );
            this.emit('rejected', { status, reason });
        };

        let url: URL;

        try {
            url = new URL(request.url ?? '/', 'http://localhost');
        } catch {
            reject(400, 'Bad Request');
            return;
        }

        if (url.pathname !== this.path && url.pathname !== `${this.path.replace(/\/$/, '')}/`) {
            if (this.options.server) {
                socket.off('error', swallow);
            } else {
                reject(404, 'Not Found');
            }

            return;
        }

        track();
        const wss = this.wss;

        if (!wss || this.closing) {
            reject(503, 'Service Unavailable');
            return;
        }

        const token = this.options.accessToken;

        if (token) {
            const header = request.headers.authorization;
            const supplied =
                header === undefined
                    ? url.searchParams.get('access_token')
                    : header.startsWith('Bearer ')
                      ? header.slice(7)
                      : null;
            const actual = Buffer.from(supplied ?? '');
            const expected = Buffer.from(token);

            if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
                reject(401, 'Unauthorized');
                return;
            }
        }

        const protocolHeader = request.headers['sec-websocket-protocol'];
        const protocols =
            typeof protocolHeader === 'string'
                ? protocolHeader.split(',').map((item) => item.trim())
                : [];
        const protocol = protocols.find((item) =>
            /^12\.[a-z][-a-z0-9]*(?:\.[-a-z0-9]+)*$/.test(item),
        );

        if (!request.headers['user-agent']?.trim() || !protocol) {
            reject(400, 'Bad Request');
            return;
        }

        if (wss.clients.size >= (this.options.maxConnections ?? 128)) {
            reject(503, 'Service Unavailable');
            return;
        }

        try {
            wss.handleUpgrade(request, socket, head, (peer) => {
                socket.off('error', swallow);
                const session = makeSession(
                    protocol.slice(3),
                    peer,
                    this,
                    this.options.requestTimeoutMs ?? 30_000,
                );
                this.sessions.add(session);
                this.emit('connection', session);
            });
        } catch {
            socket.destroy();
        }
    };
}

export function createOneBot12ReverseWebSocketServer(
    options?: OneBot12ReverseWebSocketServerOptions,
): OneBot12ReverseWebSocketServer {
    return new OneBot12ReverseWebSocketServer(options);
}
