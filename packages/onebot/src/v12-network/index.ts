import { WebSocketServer, type WebSocket } from '@snowluma/websocket';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { isPromise, isProxy } from 'node:util/types';
import { NodePollResponseSink } from './poll-response-sink';
import type { PollOutcome, PollSink } from '../v12-runtime/poll-transaction';

/** Trusted internal host seam. The host owns shared preflight, ordering readiness,
 * transaction cleanup and tracking the original work through its actual settlement.
 * All writes must precede promise settlement; a previously registered callback
 * can run before the transport observes settlement. Custom thenables are unsupported.
 * Tampered Promise constructors/species and unrelated same-process writers are outside
 * this contract; a host returning a thenable must observe its own rejection. */
export interface V12HttpPollCapability {
    run(
        input: unknown,
        context: {
            sink: PollSink;
            signal: AbortSignal;
            responseDeadline: number;
            maxOutputBytes: number;
        },
    ): V12HttpPollResult | Promise<V12HttpPollResult>;
}

export type V12HttpPollResult =
    | { kind: 'unavailable' }
    | {
          kind: 'preflight';
          error:
              | 'invalid_request'
              | 'unknown_self'
              | 'invalid_params'
              | 'unsupported_field'
              | 'unsupported_parameter';
      }
    | { kind: 'outcome'; outcome: PollOutcome };

/** A transport instance belongs to exactly one account. The injected dispatcher
 * must enforce that binding, including an explicitly supplied `self`. */
export interface V12Response {
    status: 'ok' | 'failed';
    retcode: number;
    data: unknown;
    message: string;
    echo?: string;
}
export interface V12TransportOptions {
    host: string;
    port: number;
    accessToken?: string;
    handle: (request: unknown) => V12Response | Promise<V12Response>;
    /** Internal HTTP-only capability; absent means the legacy action path. */
    httpPoll?: V12HttpPollCapability;
    getConnectEvent: () => unknown;
    subscribe: (listener: (event: unknown) => void) => () => void;
    /** Called on asynchronous listener failure with a sanitized diagnostic. */
    onError?: (error: Error) => void;
    maxBodyBytes?: number;
    maxOutputBytes?: number;
    maxConcurrent?: number;
    maxConnections?: number;
    timeoutMs?: number;
}

const failed = (retcode: number, message: string, echo?: string): V12Response => ({
    status: 'failed',
    retcode,
    data: null,
    message,
    ...(echo !== undefined ? { echo } : {}),
});

function requestEcho(value: unknown): string | undefined {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const echo = (value as Record<string, unknown>).echo;

        if (typeof echo === 'string') {
            return echo;
        }
    }

    return undefined;
}

function validRequest(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const request = value as Record<string, unknown>;
    return (
        typeof request.action === 'string' &&
        request.action.length > 0 &&
        !!request.params &&
        typeof request.params === 'object' &&
        !Array.isArray(request.params) &&
        (request.echo === undefined || typeof request.echo === 'string')
    );
}

function pathOf(req: IncomingMessage): string | null {
    try {
        return new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
        return null;
    }
}

/** V12 auth deliberately does not share v11's compatibility behavior. */
export function isV12Authorized(req: IncomingMessage, token: string): boolean {
    if (!token) {
        return true;
    }

    const headers = req.rawHeaders;
    const values: string[] = [];

    for (let i = 0; i < headers.length; i += 2) {
        if (headers[i]?.toLowerCase() === 'authorization') {
            values.push(headers[i + 1] ?? '');
        }
    }

    if (values.length) {
        return values.length === 1 && values[0] === `Bearer ${token}`;
    }

    try {
        const tokens = new URL(req.url ?? '/', 'http://localhost').searchParams.getAll(
            'access_token',
        );
        return tokens.length === 1 && tokens[0] === token;
    } catch {
        return false;
    }
}

const UNKNOWN_OUTCOME =
    'outcome unknown; side effects may have occurred; do not retry automatically';
const SAFE_CORE_FAILURES = new Set([
    'message sent but result metadata is unavailable; do not retry automatically',
    'message sent but result metadata is invalid; do not retry automatically',
    'message outcome unavailable; do not retry automatically',
    'action outcome unavailable; do not retry automatically',
    'invalid action input; outcome may be uncertain; do not retry automatically',
]);

/** Serialize each object at most once. A fallback is separately serialized and
 * must preserve the echo; if even that exceeds the cap the connection closes. */
function encodeResponse(value: V12Response, maxBytes: number, echo?: string): string | null {
    try {
        const text = JSON.stringify(value);

        if (typeof text === 'string' && Buffer.byteLength(text) <= maxBytes) {
            const parsed: unknown = JSON.parse(text);

            if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'data')) {
                return text;
            }
        }
    } catch {
        /* use the fixed, non-sensitive fallback */
    }

    const fallback = JSON.stringify(failed(20001, UNKNOWN_OUTCOME, echo));
    return Buffer.byteLength(fallback) <= maxBytes ? fallback : null;
}

function json(
    res: ServerResponse,
    status: number,
    value: V12Response,
    maxBytes: number,
    echo?: string,
): void {
    if (res.destroyed || res.writableEnded) {
        return;
    }

    const text = encodeResponse(value, maxBytes, echo);

    if (text === null && status !== 401 && status !== 415) {
        res.destroy();
        return;
    }

    try {
        // Before the body is read the protocol requires 401/415 even when the
        // configured cap is too small for an error envelope.
        res.writeHead(
            status,
            text === null
                ? { connection: 'close', 'content-length': '0' }
                : { 'content-type': 'application/json; charset=utf-8', connection: 'close' },
        );
        res.end(text ?? '');
    } catch {
        res.destroy();
    }
}

function rejectUpgrade(socket: Duplex, status: number): void {
    const text =
        status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Service Unavailable';
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export class V12Transport {
    private server: Server | null = null;
    private wss: WebSocketServer | null = null;
    private state: 'idle' | 'opening' | 'open' | 'closing' = 'idle';
    private opening: Promise<AddressInfo> | null = null;
    private closing: Promise<void> | null = null;
    private readonly sockets = new Set<Socket>();
    private readonly clients = new Set<WebSocket>();
    private readonly clientDisposers = new Map<WebSocket, () => void>();
    private readonly responses = new Set<ServerResponse>();
    private active = 0;
    private pollActive = 0;
    private pollUnknown = 0;
    private readonly pollAborters = new Map<ServerResponse, () => void>();
    private quiesced = false;
    private readonly maxBody: number;
    private readonly maxOutput: number;
    private readonly maxConcurrent: number;
    private readonly maxConnections: number;
    private readonly timeout: number;

    constructor(private readonly options: V12TransportOptions) {
        const positive = (n: number | undefined, fallback: number): number => {
            if (n === undefined) {
                return fallback;
            }

            if (!Number.isSafeInteger(n) || n <= 0) {
                throw new RangeError('transport limits must be positive integers');
            }

            return n;
        };

        this.maxBody = positive(options.maxBodyBytes, 1024 * 1024);
        this.maxOutput = positive(options.maxOutputBytes, 1024 * 1024);
        this.maxConcurrent = positive(options.maxConcurrent, 64);
        this.maxConnections = positive(options.maxConnections, 128);
        this.timeout = positive(options.timeoutMs, 15_000);
    }

    /** Standalone combined HTTP + WS listener. */
    open(): Promise<AddressInfo> {
        if (this.opening) {
            return this.opening;
        }

        if (this.state !== 'idle' || this.closing) {
            return Promise.reject(new Error('transport already open or closing'));
        }

        this.state = 'opening';
        this.quiesced = false;
        const server = createServer((req, res) => this.handleRequest(req, res));
        this.server = server;
        server.headersTimeout = this.timeout;
        server.requestTimeout = this.timeout;
        server.on('connection', (socket) => {
            this.sockets.add(socket);
            socket.once('close', () => this.sockets.delete(socket));

            if (this.sockets.size > this.maxConnections) {
                socket.destroy();
            }
        });
        server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
        this.wss = new WebSocketServer({ noServer: true, maxPayload: this.maxBody });
        const opening = new Promise<AddressInfo>((resolve, reject) => {
            const onError = (error: Error): void => {
                this.state = 'idle';
                this.server = null;
                this.wss?.destroy();
                this.wss = null;
                reject(error);
            };

            server.once('error', onError);

            try {
                server.listen(this.options.port, this.options.host, () => {
                    server.removeListener('error', onError);
                    // Keep post-bind server errors from becoming uncaught exceptions.
                    server.on('error', () => {
                        this.quiesce();

                        try {
                            this.options.onError?.(new Error('v12 listener failure'));
                        } catch {
                            /* reporting is best effort */
                        }
                    });

                    if (this.state !== 'opening') {
                        reject(new Error('transport closed while opening'));
                        return;
                    }

                    this.state = 'open';
                    resolve(server.address() as AddressInfo);
                });
            } catch (error) {
                server.removeListener('error', onError);
                onError(error instanceof Error ? error : new Error('listener failed'));
            }
        });
        this.opening = opening;
        void opening
            .finally(() => {
                if (this.opening === opening) {
                    this.opening = null;
                }
            })
            .catch(() => undefined);
        return opening;
    }

    /** Activate noServer mode; caller routes requests and upgrades exclusively.
     * The host owns and must bound its TCP sockets and HTTP header/idle deadlines;
     * this transport bounds admitted HTTP actions and WebSocket sessions only. */
    attach(): void {
        if (this.state !== 'idle' || this.closing) {
            throw new Error('transport already open or closing');
        }

        this.wss = new WebSocketServer({ noServer: true, maxPayload: this.maxBody });
        this.quiesced = false;
        this.state = 'open';
    }

    /** Caller must route requests exclusively to this method, not multiple listeners. */
    handleRequest(req: IncomingMessage, res: ServerResponse): void {
        if (this.state !== 'open' || this.quiesced) {
            json(res, 503, failed(20002, 'transport unavailable'), this.maxOutput);
            return;
        }

        if (pathOf(req) !== '/') {
            json(res, 404, failed(10001, 'not found'), this.maxOutput);
            return;
        }

        if (!isV12Authorized(req, this.options.accessToken ?? '')) {
            json(res, 401, failed(10001, 'unauthorized'), this.maxOutput);
            return;
        }

        if (req.method !== 'POST') {
            res.setHeader('allow', 'POST');
            json(res, 405, failed(10001, 'method not allowed'), this.maxOutput);
            return;
        }

        const contentType = req.headers['content-type'] ?? '';

        if (
            !/^application\/json\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i.test(contentType)
        ) {
            json(res, 415, failed(10001, 'unsupported content type'), this.maxOutput);
            return;
        }

        if (this.responses.size >= this.maxConcurrent) {
            json(res, 503, failed(20002, 'transport busy'), this.maxOutput);
            return;
        }

        this.responses.add(res);
        let settled = false;
        let requestAborted = false;
        let size = 0;
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => finish(failed(10001, 'request timeout')), this.timeout);
        timer.unref();

        const cleanup = (): void => {
            clearTimeout(timer);
            this.responses.delete(res);
        };

        const finish = (response: V12Response): void => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            json(res, 200, response, this.maxOutput, response.echo);
        };

        res.once('finish', cleanup);
        res.once('close', () => {
            settled = true;
            this.pollAborters.get(res)?.();
            cleanup();
        });
        req.on('error', () => {
            settled = true;
            this.pollAborters.get(res)?.();
            cleanup();
            res.destroy();
        });

        if (this.options.httpPoll) {
            req.on('aborted', () => {
                requestAborted = true;
                this.pollAborters.get(res)?.();
            });
        }

        req.on('data', (chunk: Buffer) => {
            if (settled) {
                return;
            }

            size += chunk.length;

            if (size > this.maxBody) {
                chunks.length = 0;
                finish(failed(10001, 'request too large'));
                req.pause();
                return;
            }

            chunks.push(chunk);
        });
        req.on('end', () => {
            if (settled) {
                return;
            }

            let input: unknown;

            try {
                input = JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
                );
            } catch {
                finish(failed(10001, 'invalid request'));
                return;
            }

            clearTimeout(timer);
            const capability = this.options.httpPoll;

            if (
                capability &&
                input !== null &&
                typeof input === 'object' &&
                !Array.isArray(input) &&
                (input as Record<string, unknown>).action === 'get_latest_events'
            ) {
                this.dispatchHttpPoll(input, res, capability, () => settled || requestAborted);
                return;
            }

            void this.dispatch(input)
                .then(finish)
                .catch(() => {
                    cleanup();
                    res.destroy();
                });
        });
    }

    /** Caller owns unmatched upgrades and must ensure exclusive routing. */
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
        if (
            this.state !== 'open' ||
            this.quiesced ||
            !this.wss ||
            this.clients.size >= this.maxConnections
        ) {
            rejectUpgrade(socket, 503);
            return;
        }

        if (pathOf(req) !== '/') {
            rejectUpgrade(socket, 404);
            return;
        }

        if (!isV12Authorized(req, this.options.accessToken ?? '')) {
            rejectUpgrade(socket, 401);
            return;
        }

        try {
            // The workspace server parses head before its callback; defer it until
            // listeners are installed so an immediately pipelined action is retained.
            this.wss.handleUpgrade(req, socket, Buffer.alloc(0), (ws) => {
                this.accept(ws);

                if (head.length) {
                    ws._onData(head);
                }
            });
        } catch {
            socket.destroy();
        }
    }

    private accept(ws: WebSocket): void {
        if (this.state !== 'open' || this.quiesced) {
            ws.terminate();
            return;
        }

        this.clients.add(ws);
        let alive = true;
        let queuedBytes = 0;
        let unsubscribe: (() => void) | undefined;

        const dispose = (): void => {
            if (!alive) {
                return;
            }

            alive = false;
            this.clients.delete(ws);
            this.clientDisposers.delete(ws);

            try {
                unsubscribe?.();
            } catch {
                /* subscriber owns its cleanup */
            }
        };

        this.clientDisposers.set(ws, dispose);

        const sendText = (text: string | null): void => {
            if (!alive) {
                return;
            }

            if (text === null) {
                ws.terminate();
                dispose();
                return;
            }

            const bytes = Buffer.byteLength(text) + 14;

            if (queuedBytes + bytes > this.maxOutput) {
                ws.terminate();
                dispose();
                return;
            }

            queuedBytes += bytes;

            try {
                ws.send(text, (error) => {
                    queuedBytes -= bytes;

                    if (error) {
                        ws.terminate();
                        dispose();
                    }
                });
            } catch {
                ws.terminate();
                dispose();
            }
        };

        const send = (data: unknown): void => {
            try {
                const text = JSON.stringify(data);
                sendText(typeof text === 'string' ? text : null);
            } catch {
                sendText(null);
            }
        };

        const sendResponse = (response: V12Response): void => {
            sendText(encodeResponse(response, this.maxOutput, response.echo));
        };

        ws.on('error', () => {
            ws.terminate();
            dispose();
        });
        ws.on('close', dispose);
        ws.on('message', (raw: Buffer, binary: boolean) => {
            if (!alive) {
                return;
            }

            if (binary) {
                sendResponse(failed(10001, 'unsupported message encoding'));
                return;
            }

            let input: unknown;

            try {
                input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
            } catch {
                sendResponse(failed(10001, 'invalid request'));
                return;
            }

            void this.dispatch(input)
                .then((response) => {
                    if (alive) {
                        sendResponse(response);
                    }
                })
                .catch(() => {
                    ws.terminate();
                    dispose();
                });
        });

        try {
            send(this.options.getConnectEvent());

            if (!alive) {
                return;
            }

            const release = this.options.subscribe(send);
            unsubscribe = release;

            if (!alive) {
                release();
            }
        } catch {
            ws.terminate();
            dispose();
        }
    }

    /** Poll failures have their own reentrancy-aware writer; ordinary json remains unchanged. */
    private writePollFailure(
        res: ServerResponse,
        response: V12Response,
        canWrite: (afterHead: boolean) => boolean,
        markHead: () => void,
        stop: () => void,
        countUnknown: () => void,
    ): void {
        try {
            if (!canWrite(false)) {
                stop();
                return;
            }

            const text = encodeResponse(response, this.maxOutput, response.echo);

            if (text === null || !canWrite(false)) {
                stop();
                return;
            }

            markHead();
            res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                connection: 'close',
            });

            if (!canWrite(true)) {
                countUnknown();
                stop();
                return;
            }

            res.end(text);

            if (res.destroyed && !res.writableFinished) {
                countUnknown();
            }
        } catch {
            countUnknown();
            stop();
        }
    }

    /** The pre-admission busy/shape paths also need independent response ownership. */
    private rejectHttpPoll(
        res: ServerResponse,
        response: V12Response,
        unavailable: () => boolean,
    ): void {
        const controller = new AbortController();
        const deadline = performance.now() + Math.min(this.timeout, 15_000);
        let stopped = false;
        let headAttempted = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let reported = false;
        let unknownCounted = false;

        const countUnknown = (): void => {
            if (!unknownCounted) {
                unknownCounted = true;
                this.pollUnknown = Math.min(Number.MAX_SAFE_INTEGER, this.pollUnknown + 1);
            }
        };

        const stop = (): void => {
            if (stopped) {
                return;
            }

            stopped = true;

            if (timer !== undefined) {
                clearTimeout(timer);
            }

            controller.abort();
            res.destroy();
        };

        const cleanup = (): void => {
            if (timer !== undefined) {
                clearTimeout(timer);
            }

            if (this.pollAborters.get(res) === stop) {
                this.pollAborters.delete(res);
            }
        };

        const onError = (): void => {
            countUnknown();
            stop();

            if (!reported) {
                reported = true;

                try {
                    const result: unknown = this.options.onError?.(
                        new Error('poll response error'),
                    );
                    void Promise.resolve(result).catch(() => undefined);
                } catch {
                    /* reporting is best effort */
                }
            }
        };

        this.pollAborters.set(res, stop);

        try {
            res.on('error', onError);
            res.once('finish', cleanup);
            res.once('close', cleanup);

            if (stopped || res.destroyed || res.writableFinished || res.finished) {
                cleanup();
                return;
            }

            timer = setTimeout(stop, Math.min(this.timeout, 15_000));
            timer.unref();
            const canWrite = (afterHead: boolean): boolean =>
                !stopped &&
                !controller.signal.aborted &&
                !this.quiesced &&
                !unavailable() &&
                performance.now() < deadline &&
                !res.destroyed &&
                !res.writableEnded &&
                !res.writableFinished &&
                !res.finished &&
                res.headersSent === afterHead &&
                headAttempted === afterHead &&
                !stopped &&
                !controller.signal.aborted &&
                !this.quiesced &&
                !unavailable() &&
                performance.now() < deadline;
            this.writePollFailure(
                res,
                response,
                canWrite,
                () => {
                    headAttempted = true;
                },
                stop,
                countUnknown,
            );
        } catch {
            countUnknown();
            stop();
        }
    }

    /** The capability must perform shared preflight and explicitly gate ordering readiness.
     * Its promise represents the original tracked work, including transaction cleanup. */
    private dispatchHttpPoll(
        input: unknown,
        res: ServerResponse,
        capability: V12HttpPollCapability,
        unavailable: () => boolean,
    ): void {
        const echo = requestEcho(input);

        if (!validRequest(input)) {
            this.rejectHttpPoll(res, failed(10001, 'invalid request', echo), unavailable);
            return;
        }

        if (this.active >= this.maxConcurrent) {
            this.rejectHttpPoll(res, failed(20002, 'transport busy', echo), unavailable);
            return;
        }

        if (this.pollActive >= Math.min(8, this.maxConcurrent - 1)) {
            this.rejectHttpPoll(res, failed(20002, 'transport busy', echo), unavailable);
            return;
        }

        if (unavailable() || this.quiesced || res.destroyed || res.writableEnded) {
            res.destroy();
            return;
        }

        this.active++;
        this.pollActive++;
        const controller = new AbortController();
        const deadline = performance.now() + Math.min(this.timeout, 15_000);
        let stopped = false;
        let writeAttempted = false;
        let writeSealed = false;
        let finishSeen = false;
        let responseTerminal = false;
        let taskDone = false;
        let sink: NodePollResponseSink | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let reported = false;
        let unknownCounted = false;

        const countUnknown = (): void => {
            if (!unknownCounted) {
                unknownCounted = true;
                this.pollUnknown = Math.min(Number.MAX_SAFE_INTEGER, this.pollUnknown + 1);
            }
        };

        const stop = (): void => {
            if (stopped) {
                return;
            }

            stopped = true;

            if (timer !== undefined) {
                clearTimeout(timer);
            }

            controller.abort();
            res.destroy();
        };

        // Keep this independent listener attached for the response's entire lifetime,
        // including constructor/dispose failure and late error events after close.
        const onHostError = (): void => {
            countUnknown();
            stop();

            if (!reported) {
                reported = true;

                try {
                    const reportedResult: unknown = this.options.onError?.(
                        new Error('poll response error'),
                    );
                    void Promise.resolve(reportedResult).catch(() => undefined);
                } catch {
                    /* reporting is best effort */
                }
            }
        };

        const cleanupIfDone = (): void => {
            if (taskDone && responseTerminal) {
                if (timer !== undefined) {
                    clearTimeout(timer);
                }

                if (this.pollAborters.get(res) === stop) {
                    this.pollAborters.delete(res);
                }
            }
        };

        this.pollAborters.set(res, stop);

        try {
            res.on('error', onHostError);
            res.once('finish', () => {
                finishSeen = true;
                responseTerminal = true;
                cleanupIfDone();
            });
            res.once('close', () => {
                responseTerminal = true;
                cleanupIfDone();
            });

            if (res.destroyed || res.writableFinished || res.finished) {
                responseTerminal = true;
            }
        } catch {
            stop();
        }

        if (!stopped) {
            timer = setTimeout(stop, Math.min(this.timeout, 15_000));
            timer.unref();
        }

        const sendFailure = (response: V12Response): void => {
            const canWrite = (afterHead: boolean): boolean =>
                !stopped &&
                !controller.signal.aborted &&
                !this.quiesced &&
                !unavailable() &&
                performance.now() < deadline &&
                !res.destroyed &&
                !res.writableEnded &&
                !res.writableFinished &&
                !res.finished &&
                res.headersSent === afterHead &&
                writeAttempted === afterHead &&
                !stopped &&
                !controller.signal.aborted &&
                !this.quiesced &&
                !unavailable() &&
                performance.now() < deadline;
            this.writePollFailure(
                res,
                response,
                canWrite,
                () => {
                    writeAttempted = true;
                },
                stop,
                countUnknown,
            );
        };

        // Preserve the original action microtask boundary and observe this exact task
        // until it settles even if the timer or a response event stops the transaction.
        const task = Promise.resolve().then(() => {
            if (stopped || unavailable() || this.quiesced || performance.now() >= deadline) {
                stop();
                return null;
            }

            sink = new NodePollResponseSink(res, () => undefined);
            const owned = sink;
            const guarded: PollSink = {
                isOpen: () =>
                    !writeSealed &&
                    !stopped &&
                    performance.now() < deadline &&
                    owned.isOpen() &&
                    !writeSealed &&
                    !stopped &&
                    performance.now() < deadline,
                on: (event, listener) => owned.on(event, listener),
                off: (event, listener) => owned.off(event, listener),
                writeHead: () => {
                    if (writeSealed) {
                        throw new Error('poll response unavailable');
                    }

                    if (stopped || performance.now() >= deadline) {
                        stop();
                        throw new Error('poll response unavailable');
                    }

                    writeAttempted = true;
                    owned.writeHead();
                },
                end: (body) => {
                    if (writeSealed) {
                        throw new Error('poll response unavailable');
                    }

                    if (stopped || performance.now() >= deadline) {
                        stop();
                        throw new Error('poll response unavailable');
                    }

                    owned.end(body);
                },
            };

            if (stopped || unavailable() || this.quiesced || performance.now() >= deadline) {
                stop();
                return null;
            }

            const result = capability.run(input, {
                sink: guarded,
                signal: controller.signal,
                responseDeadline: deadline,
                maxOutputBytes: this.maxOutput,
            });

            if (!isPromise(result)) {
                writeSealed = true;

                if (
                    result === null ||
                    typeof result !== 'object' ||
                    isProxy(result) ||
                    (Object.getPrototypeOf(result) !== Object.prototype &&
                        Object.getPrototypeOf(result) !== null) ||
                    Object.getOwnPropertyDescriptor(result, 'then') !== undefined
                ) {
                    throw new Error('poll capability result invalid');
                }

                const kind = Object.getOwnPropertyDescriptor(result, 'kind');

                if (
                    !kind ||
                    !('value' in kind) ||
                    !['unavailable', 'preflight', 'outcome'].includes(kind.value)
                ) {
                    throw new Error('poll capability result invalid');
                }

                return result;
            }

            return result.then(
                (value) => {
                    writeSealed = true;
                    return value;
                },
                (error: unknown) => {
                    writeSealed = true;
                    throw error;
                },
            );
        });
        void task
            .then(
                (result) => {
                    writeSealed = true;

                    try {
                        if (
                            result?.kind === 'outcome' &&
                            [
                                'cleanup_uncertain',
                                'release_unknown',
                                'commit_unknown',
                                'committed_unsent',
                                'unknown',
                            ].includes(result.outcome.kind)
                        ) {
                            countUnknown();
                        }

                        if (stopped && writeAttempted) {
                            countUnknown();
                        }

                        if (sink) {
                            sink.dispose();
                        }

                        if (
                            stopped ||
                            unavailable() ||
                            this.quiesced ||
                            performance.now() >= deadline
                        ) {
                            stop();
                            return;
                        }

                        if (result?.kind === 'outcome' && result.outcome.kind === 'local_finish') {
                            if (!writeAttempted || !finishSeen) {
                                countUnknown();
                                stop();
                            }

                            return;
                        }

                        // A header attempt may have partially published even if it threw.
                        if (
                            writeAttempted ||
                            res.headersSent ||
                            res.destroyed ||
                            res.writableEnded
                        ) {
                            countUnknown();
                            stop();
                            return;
                        }

                        if (result?.kind === 'unavailable') {
                            sendFailure(failed(20002, 'poll unavailable', echo));
                            return;
                        }

                        if (result?.kind === 'preflight') {
                            const failures = {
                                invalid_request: [10001, 'invalid action request'],
                                unknown_self: [10102, 'unknown self'],
                                invalid_params: [10003, 'invalid poll parameters'],
                                unsupported_field: [10004, 'unsupported request field'],
                                unsupported_parameter: [10004, 'unsupported parameter'],
                            } as const;
                            const failure = Object.hasOwn(failures, result.error)
                                ? failures[result.error]
                                : undefined;

                            if (failure) {
                                sendFailure(failed(failure[0], failure[1], echo));
                            } else {
                                stop();
                            }

                            return;
                        }

                        if (result?.kind === 'outcome') {
                            const kind = result.outcome.kind;

                            if (kind === 'invalid_input' || kind === 'invalid') {
                                sendFailure(failed(10003, 'invalid poll parameters', echo));
                                return;
                            }

                            if (
                                kind === 'busy' ||
                                kind === 'contended' ||
                                kind === 'blocked' ||
                                kind === 'epoch_invalid' ||
                                kind === 'commit_rejected'
                            ) {
                                sendFailure(failed(20002, 'poll unavailable', echo));
                                return;
                            }
                        }

                        if (
                            result?.kind !== 'outcome' ||
                            !['aborted', 'cancelled', 'closed', 'deadline'].includes(
                                result.outcome.kind,
                            )
                        ) {
                            countUnknown();
                        }

                        stop();
                    } catch {
                        countUnknown();
                        stop();
                    } finally {
                        taskDone = true;
                        cleanupIfDone();
                        this.active--;
                        this.pollActive--;
                    }
                },
                () => {
                    writeSealed = true;

                    try {
                        countUnknown();

                        try {
                            sink?.dispose();
                        } catch {
                            /* stop below; the host error listener remains installed */
                        }

                        stop();
                    } finally {
                        taskDone = true;
                        cleanupIfDone();
                        this.active--;
                        this.pollActive--;
                    }
                },
            )
            .catch(() => {
                // Observe failures from the completion observer itself.
                stop();
            });
    }

    private async dispatch(input: unknown): Promise<V12Response> {
        const echo = requestEcho(input);

        if (!validRequest(input)) {
            return failed(10001, 'invalid request', echo);
        }

        if (this.active >= this.maxConcurrent) {
            return failed(20002, 'transport busy', echo);
        }

        this.active++;
        // Keep the slot until the actual handler settles even if the peer leaves
        // or the response deadline expires: side effects cannot be cancelled here.
        const task = Promise.resolve().then(() => this.options.handle(input));
        void task.then(
            () => {
                this.active--;
            },
            () => {
                this.active--;
            },
        );
        let timer: ReturnType<typeof setTimeout> | undefined;

        try {
            const response = await Promise.race([
                task,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('deadline')), this.timeout);
                    timer.unref();
                }),
            ]);

            // Read each potentially hostile top-level property only once. The
            // untrusted data tree is serialized exactly once at the output seam.
            const status = response?.status;
            const retcode = response?.retcode;
            const message = response?.message;
            const hasData = !!response && Object.prototype.hasOwnProperty.call(response, 'data');
            const data = hasData ? response.data : undefined;

            if (
                (status !== 'ok' && status !== 'failed') ||
                !Number.isSafeInteger(retcode) ||
                typeof message !== 'string' ||
                !hasData ||
                data === undefined ||
                !((status === 'ok' && retcode === 0) || (status === 'failed' && retcode !== 0))
            ) {
                return failed(20001, UNKNOWN_OUTCOME, echo);
            }

            if (status === 'failed') {
                // Never infer pre-execution from retcode alone: the core can
                // report 10003 after an underlying operation has run. Only
                // known fixed diagnostics are forwarded; unknowns stay cautious.
                const safeMessage = SAFE_CORE_FAILURES.has(message)
                    ? message
                    : retcode === 10002 && message === 'unsupported action'
                      ? 'unsupported action'
                      : UNKNOWN_OUTCOME;
                return failed(retcode, safeMessage, echo);
            }

            return {
                status: 'ok',
                retcode: 0,
                data,
                message: '',
                ...(echo !== undefined ? { echo } : {}),
            };
        } catch {
            return failed(20002, UNKNOWN_OUTCOME, echo);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    /** Stop admission synchronously, including while open() is binding. */
    quiesce(): void {
        this.quiesced = true;

        for (const stop of this.pollAborters.values()) {
            stop();
        }

        for (const res of this.responses) {
            res.destroy();
        }

        for (const ws of this.clients) {
            this.clientDisposers.get(ws)?.();
            ws.terminate();
        }
    }

    /** Immediately sever owned sockets; completion is observable with close(). */
    forceClose(): void {
        this.quiesce();

        for (const socket of this.sockets) {
            socket.destroy();
        }

        void this.close().catch(() => {
            try {
                this.options.onError?.(new Error('v12 listener close failed'));
            } catch {
                /* best effort */
            }
        });
    }

    close(): Promise<void> {
        if (this.closing) {
            return this.closing;
        }

        if (this.state === 'idle') {
            return Promise.resolve();
        }

        this.quiesce();
        const opening = this.opening;
        const close = (async () => {
            if (opening) {
                try {
                    await opening;
                } catch {
                    return;
                }
            }

            this.state = 'closing';
            const wss = this.wss;
            wss?.destroy();
            const server = this.server;

            if (server) {
                const done = new Promise<void>((resolve, reject) =>
                    server.close((error) => {
                        if (
                            error &&
                            (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
                        ) {
                            reject(error);
                        } else {
                            resolve();
                        }
                    }),
                );

                for (const socket of this.sockets) {
                    socket.destroy();
                }

                await done;
            }

            if (this.server === server) {
                this.server = null;
            }

            if (this.wss === wss) {
                this.wss = null;
            }

            this.state = 'idle';
        })();
        this.closing = close;
        void close
            .finally(() => {
                if (this.closing === close) {
                    this.closing = null;
                }
            })
            .catch(() => undefined);
        return close;
    }
}
