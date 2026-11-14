import {
    abortable,
    checkedLimit,
    hasDuplicateEcho,
    OneBot12ClientError,
    requestDeadline,
    validateEndpoint,
} from './client-types.js';
import {
    parseOneBot12ActionResponseJson,
    parseOneBot12ActionResponseShapeJson,
    parseOneBot12Event,
    parseOneBot12EventJson,
    serializeOneBot12ActionRequest,
} from './protocol.js';
import type { OneBot12ClientOptions, OneBot12RequestOptions } from './client-types.js';
import type { OneBot12ActionResponse, OneBot12Event, OneBot12JsonObject } from './types.js';

export interface OneBot12WebSocketClientOptions extends OneBot12ClientOptions {
    url: string;
    webSocket?: typeof WebSocket;
    /** Browser WebSocket cannot set headers; URL token transmission requires explicit consent. */
    tokenTransport?: 'query';
    maxPendingRequests?: number;
    /** Maximum encoded bytes queued by WebSocket, including a new frame. */
    maxBufferedBytes?: number;
}

type Pending = { resolve(value: OneBot12ActionResponse): void; reject(error: Error): void };

/** A single OneBot Connect session; accounts are selected per action, never per socket. */
export class OneBot12WebSocketClient {
    readonly url: string;
    private readonly WebSocketCtor: typeof WebSocket;
    private readonly accessToken?: string;
    private readonly timeoutMs: number;
    private readonly maxResponseBytes: number;
    private readonly maxPending: number;
    private readonly maxBufferedBytes: number;
    private readonly pending = new Map<string, Pending>();
    // Includes callers waiting for connect, serialization, and an action response.
    private activeRequests = 0;
    private readonly eventListeners = new Set<(event: OneBot12Event) => unknown>();
    private readonly errorListeners = new Set<(error: OneBot12ClientError) => unknown>();
    private socket: WebSocket | null = null;
    private opening: Promise<void> | null = null;
    private rejectOpening: ((error: Error) => void) | null = null;
    private openingTimer: ReturnType<typeof setTimeout> | undefined;
    private echoPrefix: string | undefined;
    private echoSequence = 0n;
    private generation = 0;

    constructor(options: OneBot12WebSocketClientOptions) {
        this.url = validateEndpoint(options.url, 'ws');

        if (options.accessToken && options.tokenTransport !== 'query') {
            throw new OneBot12ClientError(
                'invalid_options',
                'WebSocket token requires explicit query transport',
            );
        }

        this.accessToken = options.accessToken;
        this.timeoutMs = checkedLimit(options.requestTimeoutMs ?? 30_000, 'requestTimeoutMs', 0);
        this.maxResponseBytes = checkedLimit(
            options.maxResponseBytes ?? 4 * 1024 * 1024,
            'maxResponseBytes',
            1,
        );
        this.maxPending = checkedLimit(options.maxPendingRequests ?? 1024, 'maxPendingRequests', 1);
        this.maxBufferedBytes = checkedLimit(
            options.maxBufferedBytes ?? 4 * 1024 * 1024,
            'maxBufferedBytes',
            1,
        );
        this.WebSocketCtor = options.webSocket ?? globalThis.WebSocket;

        if (typeof this.WebSocketCtor !== 'function') {
            throw new OneBot12ClientError('invalid_options', 'WebSocket is unavailable');
        }
    }

    get isConnected(): boolean {
        return this.socket?.readyState === 1;
    }

    onEvent(listener: (event: OneBot12Event) => unknown): () => void {
        this.eventListeners.add(listener);

        return () => {
            this.eventListeners.delete(listener);
        };
    }

    onError(listener: (error: OneBot12ClientError) => unknown): () => void {
        this.errorListeners.add(listener);

        return () => {
            this.errorListeners.delete(listener);
        };
    }

    /** Explicitly opens a connection. This client never reconnects or replays actions. */
    connect(): Promise<void> {
        if (this.opening) {
            return this.opening;
        }

        if (this.isConnected) {
            return Promise.resolve();
        }

        let resolveOpen!: () => void;
        let rejectOpen!: (error: Error) => void;
        const opening = new Promise<void>((resolve, reject) => {
            resolveOpen = resolve;
            rejectOpen = reject;
        });
        this.generation++;
        this.opening = opening;
        this.rejectOpening = rejectOpen;

        if (this.timeoutMs > 0) {
            this.openingTimer = setTimeout(() => {
                const error = new OneBot12ClientError(
                    'timeout',
                    'OneBot 12 WebSocket connection timed out',
                );

                if (this.socket) {
                    this.failConnection(this.socket, error);
                } else {
                    this.finishOpening(error);
                }
            }, this.timeoutMs);
        }

        const endpoint = new URL(this.url);

        if (this.accessToken) {
            endpoint.searchParams.set('access_token', this.accessToken);
        }

        let socket: WebSocket;

        try {
            socket = new this.WebSocketCtor(endpoint.toString());
        } catch {
            if (this.opening === opening) {
                this.finishOpening(
                    new OneBot12ClientError('network', 'OneBot 12 WebSocket connection failed'),
                );
            }

            return opening;
        }

        // A custom constructor may synchronously call close() or initiate a new connection.
        if (this.opening !== opening) {
            try {
                socket.close();
            } catch {
                /* The socket may already be closed. */
            }

            return opening;
        }

        this.socket = socket;
        socket.addEventListener('open', () => {
            if (this.socket !== socket) {
                return;
            }

            this.finishOpening();
            resolveOpen();
        });
        socket.addEventListener('message', (event: MessageEvent) => {
            if (this.socket === socket) {
                this.handleMessage(event.data);
            }
        });
        socket.addEventListener('error', () => {
            if (this.socket !== socket) {
                return;
            }

            const error = new OneBot12ClientError(
                'network',
                'OneBot 12 WebSocket transport failed',
            );
            this.failConnection(socket, error);
            this.emitError(error);
        });
        socket.addEventListener('close', () => {
            if (this.socket === socket) {
                this.failConnection(
                    socket,
                    new OneBot12ClientError('closed', 'OneBot 12 WebSocket closed'),
                );
            }
        });
        return opening;
    }

    close(): void {
        const error = new OneBot12ClientError('closed', 'OneBot 12 WebSocket closed');

        if (this.socket) {
            this.failConnection(this.socket, error);
        } else if (this.opening) {
            this.finishOpening(error);
        }
    }

    async request(
        action: string,
        params: OneBot12JsonObject = {},
        options: OneBot12RequestOptions = {},
    ): Promise<OneBot12ActionResponse> {
        if (this.activeRequests >= this.maxPending) {
            throw new OneBot12ClientError('limit', 'OneBot 12 pending request limit reached');
        }

        this.activeRequests++;

        let cleanupDeadline = () => {};

        try {
            const deadline = requestDeadline(options.timeoutMs ?? this.timeoutMs, options.signal);
            cleanupDeadline = deadline.cleanup;

            if (deadline.signal.aborted) {
                throw deadline.failure();
            }

            const generation = this.generation;

            if (this.opening) {
                await abortable(this.opening, deadline.signal, deadline.failure);
            }

            if (generation !== this.generation) {
                throw new OneBot12ClientError('closed', 'OneBot 12 WebSocket connection changed');
            }

            const socket = this.socket;

            if (!socket || socket.readyState !== 1) {
                throw new OneBot12ClientError('closed', 'OneBot 12 WebSocket is not connected');
            }

            if (!this.echoPrefix) {
                if (!globalThis.crypto?.randomUUID) {
                    throw new OneBot12ClientError(
                        'invalid_options',
                        'Secure random UUID is unavailable',
                    );
                }

                this.echoPrefix = globalThis.crypto.randomUUID();
            }

            // Never reuse an echo within this client, even after timeout or reconnect.
            const echo = `${this.echoPrefix}:${++this.echoSequence}`;

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

            // Serializing caller data can invoke proxy traps and re-enter this client.
            if (this.socket !== socket || socket.readyState !== 1) {
                throw new OneBot12ClientError('closed', 'OneBot 12 WebSocket is not connected');
            }

            if (deadline.signal.aborted) {
                throw deadline.failure();
            }

            if (
                payload.length > this.maxBufferedBytes ||
                socket.bufferedAmount + new TextEncoder().encode(payload).byteLength >
                    this.maxBufferedBytes
            ) {
                throw new OneBot12ClientError('limit', 'OneBot 12 outgoing buffer limit reached');
            }

            return await new Promise<OneBot12ActionResponse>((resolve, reject) => {
                let settled = false;

                const cleanup = () => {
                    this.pending.delete(echo);
                    deadline.signal.removeEventListener('abort', onAbort);
                };

                const finish = (value: OneBot12ActionResponse) => {
                    if (!settled) {
                        settled = true;
                        cleanup();
                        resolve(value);
                    }
                };

                const fail = (error: Error) => {
                    if (!settled) {
                        settled = true;
                        cleanup();
                        reject(error);
                    }
                };

                const onAbort = () => fail(deadline.failure());
                this.pending.set(echo, { resolve: finish, reject: fail });
                deadline.signal.addEventListener('abort', onAbort, { once: true });

                if (deadline.signal.aborted) {
                    onAbort();
                    return;
                }

                try {
                    socket.send(payload);
                } catch {
                    fail(new OneBot12ClientError('network', 'OneBot 12 WebSocket send failed'));
                }
            });
        } finally {
            try {
                cleanupDeadline();
            } finally {
                this.activeRequests--;
            }
        }
    }

    call(
        action: string,
        params: OneBot12JsonObject = {},
        options?: OneBot12RequestOptions,
    ): Promise<OneBot12ActionResponse> {
        return this.request(action, params, options);
    }

    private handleMessage(data: unknown): void {
        if (typeof data !== 'string') {
            this.emitError(
                new OneBot12ClientError('protocol', 'Unsupported OneBot 12 WebSocket frame'),
            );
            return;
        }

        if (
            data.length > this.maxResponseBytes ||
            new TextEncoder().encode(data).byteLength > this.maxResponseBytes
        ) {
            const error = new OneBot12ClientError(
                'limit',
                'OneBot 12 WebSocket frame exceeds the byte limit',
            );

            if (this.socket) {
                this.failConnection(this.socket, error);
            }

            this.emitError(error);
            return;
        }

        let raw: unknown;

        try {
            raw = JSON.parse(data);
        } catch {
            this.emitError(
                new OneBot12ClientError('invalid_response', 'Invalid OneBot 12 JSON frame'),
            );
            return;
        }

        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            this.emitError(new OneBot12ClientError('protocol', 'Invalid OneBot 12 frame'));
            return;
        }

        const frame = raw as Record<string, unknown>;

        if (hasDuplicateEcho(data)) {
            const error = new OneBot12ClientError('protocol', 'Duplicate OneBot 12 echo');

            if (this.socket) {
                this.failConnection(this.socket, error);
            }

            this.emitError(error);
            return;
        }

        // Extension fields can make a frame resemble both kinds. Do not misroute an
        // ambiguous correlated action response to an event listener (or vice versa).
        if (
            Object.hasOwn(frame, 'type') &&
            typeof frame.type === 'string' &&
            Object.hasOwn(frame, 'id') &&
            Object.hasOwn(frame, 'detail_type')
        ) {
            let event: OneBot12Event | undefined;

            try {
                event = parseOneBot12EventJson(data);
            } catch {
                // It may instead be a response carrying event-shaped extensions.
            }

            let responseLike = false;

            if (event && (Object.hasOwn(frame, 'status') || Object.hasOwn(frame, 'retcode'))) {
                try {
                    parseOneBot12ActionResponseShapeJson(data);
                    responseLike = true;
                } catch {
                    // An event may itself carry response-shaped extension fields.
                }
            }

            if (event && responseLike) {
                const error = new OneBot12ClientError('protocol', 'Ambiguous OneBot 12 frame');

                if (this.socket) {
                    this.failConnection(this.socket, error);
                }

                this.emitError(error);
                return;
            }

            if (event) {
                for (const listener of this.eventListeners) {
                    let isolatedEvent: OneBot12Event;

                    try {
                        isolatedEvent = parseOneBot12Event(event);
                    } catch {
                        this.emitError(
                            new OneBot12ClientError('protocol', 'OneBot 12 event snapshot failed'),
                        );
                        continue;
                    }

                    try {
                        const result = listener(isolatedEvent);

                        if (result) {
                            void Promise.resolve(result).catch(() =>
                                this.emitError(
                                    new OneBot12ClientError(
                                        'callback',
                                        'OneBot 12 event callback failed',
                                    ),
                                ),
                            );
                        }
                    } catch {
                        this.emitError(
                            new OneBot12ClientError('callback', 'OneBot 12 event callback failed'),
                        );
                    }
                }

                return;
            }

            if (!Object.hasOwn(frame, 'status') && !Object.hasOwn(frame, 'retcode')) {
                this.emitError(new OneBot12ClientError('protocol', 'Invalid OneBot 12 event'));
                return;
            }
        }

        if (
            Object.hasOwn(frame, 'status') ||
            Object.hasOwn(frame, 'retcode') ||
            Object.hasOwn(frame, 'echo')
        ) {
            const echo =
                Object.hasOwn(frame, 'echo') && typeof frame.echo === 'string'
                    ? frame.echo
                    : undefined;
            const pending = echo === undefined ? undefined : this.pending.get(echo);

            if (echo === undefined && this.pending.size > 0) {
                const error = new OneBot12ClientError(
                    'protocol',
                    'OneBot 12 action response is missing echo',
                );

                if (this.socket) {
                    this.failConnection(this.socket, error);
                }

                this.emitError(error);
                return;
            }

            let response: OneBot12ActionResponse;

            try {
                response = parseOneBot12ActionResponseJson(data);
            } catch {
                const error = new OneBot12ClientError(
                    'invalid_response',
                    'Invalid OneBot 12 action response',
                );
                pending?.reject(error);
                this.emitError(error);
                return;
            }

            if (!pending) {
                this.emitError(
                    new OneBot12ClientError('protocol', 'Unmatched OneBot 12 action response'),
                );
                return;
            }

            pending.resolve(response);
            return;
        }

        this.emitError(new OneBot12ClientError('protocol', 'Unrecognized OneBot 12 frame'));
    }

    private emitError(error: OneBot12ClientError): void {
        for (const listener of this.errorListeners) {
            try {
                const result = listener(error);

                if (result) {
                    void Promise.resolve(result).catch(() => {});
                }
            } catch {
                /* User callbacks must not corrupt transport state. */
            }
        }
    }

    private finishOpening(error?: OneBot12ClientError): void {
        if (error) {
            this.generation++;
        }

        if (this.openingTimer !== undefined) {
            clearTimeout(this.openingTimer);
            this.openingTimer = undefined;
        }

        const reject = this.rejectOpening;
        this.rejectOpening = null;
        this.opening = null;

        if (error) {
            reject?.(error);
        }
    }

    private failConnection(socket: WebSocket, error: OneBot12ClientError): void {
        if (this.socket !== socket) {
            return;
        }

        this.socket = null;
        this.finishOpening(error);

        for (const pending of [...this.pending.values()]) {
            pending.reject(error);
        }

        try {
            socket.close();
        } catch {
            /* The peer may already be closed. */
        }
    }
}
