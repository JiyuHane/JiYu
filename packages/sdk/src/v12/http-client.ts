import {
    abortable,
    checkedLimit,
    hasDuplicateEcho,
    OneBot12ClientError,
    requestDeadline,
    validateEndpoint,
} from './client-types.js';
import { parseOneBot12ActionResponseJson, serializeOneBot12ActionRequest } from './protocol.js';
import type { OneBot12ClientOptions, OneBot12RequestOptions } from './client-types.js';
import type { OneBot12ActionResponse, OneBot12JsonObject } from './types.js';

export interface OneBot12HttpRequestOptions extends OneBot12RequestOptions {
    /** Optional correlation value, echoed by the implementation when non-empty. */
    echo?: string;
}

export interface OneBot12HttpClientOptions extends OneBot12ClientOptions {
    baseUrl: string;
    fetch?: typeof fetch;
    /** Explicit Authorization takes precedence over accessToken. */
    headers?: HeadersInit;
}

/** OneBot 12 application-side HTTP transport. No failed action is retried. */
export class OneBot12HttpClient {
    readonly baseUrl: string;
    private readonly fetchImpl: typeof fetch;
    private readonly headers: Headers;
    private readonly timeoutMs: number;
    private readonly maxResponseBytes: number;

    constructor(options: OneBot12HttpClientOptions) {
        this.baseUrl = validateEndpoint(options.baseUrl, 'http');
        this.timeoutMs = checkedLimit(options.requestTimeoutMs ?? 30_000, 'requestTimeoutMs', 0);
        this.maxResponseBytes = checkedLimit(
            options.maxResponseBytes ?? 4 * 1024 * 1024,
            'maxResponseBytes',
            1,
        );
        this.fetchImpl = options.fetch ?? globalThis.fetch;

        if (typeof this.fetchImpl !== 'function') {
            throw new OneBot12ClientError('invalid_options', 'fetch is unavailable');
        }

        try {
            this.headers = new Headers(options.headers);
            this.headers.set('Content-Type', 'application/json');
            this.headers.set('Accept', 'application/json');

            if (options.accessToken && !this.headers.has('Authorization')) {
                this.headers.set('Authorization', `Bearer ${options.accessToken}`);
            }
        } catch {
            throw new OneBot12ClientError('invalid_options', 'Invalid HTTP headers');
        }
    }

    async request(
        action: string,
        params: OneBot12JsonObject = {},
        options: OneBot12HttpRequestOptions = {},
    ): Promise<OneBot12ActionResponse> {
        let body: string;
        let echo: string | undefined;

        try {
            echo = options.echo;
            body = serializeOneBot12ActionRequest({
                action,
                params,
                ...(echo === undefined ? {} : { echo }),
                ...(options.self === undefined ? {} : { self: options.self }),
            });
        } catch {
            throw new OneBot12ClientError('invalid_options', 'Invalid OneBot 12 action request');
        }

        const deadline = requestDeadline(options.timeoutMs ?? this.timeoutMs, options.signal);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let completed = false;

        try {
            if (deadline.signal.aborted) {
                throw deadline.failure();
            }

            const fetchResult = Promise.resolve()
                .then(() => {
                    if (deadline.signal.aborted) {
                        throw deadline.failure();
                    }

                    return this.fetchImpl(this.baseUrl, {
                        method: 'POST',
                        headers: new Headers(this.headers),
                        body,
                        redirect: 'error',
                        signal: deadline.signal,
                    });
                })
                .then(
                    (response) => {
                        if (deadline.signal.aborted) {
                            void response.body?.cancel().catch(() => {});
                        }

                        return response;
                    },
                    () => {
                        throw new OneBot12ClientError('network', 'OneBot 12 HTTP request failed');
                    },
                );
            const response = await abortable(fetchResult, deadline.signal, deadline.failure);

            if (response.status !== 200) {
                void response.body?.cancel().catch(() => {});
                throw new OneBot12ClientError(
                    'http_status',
                    `OneBot 12 HTTP status ${response.status}`,
                    response.status,
                );
            }

            const declared = response.headers.get('content-length');

            if (declared && /^\d+$/.test(declared) && Number(declared) > this.maxResponseBytes) {
                void response.body?.cancel().catch(() => {});
                throw new OneBot12ClientError('limit', 'OneBot 12 response exceeds the byte limit');
            }

            if (!response.body) {
                throw new OneBot12ClientError(
                    'invalid_response',
                    'OneBot 12 response body is missing',
                );
            }

            reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8', { fatal: true });
            const parts: string[] = [];
            let bytes = 0;

            while (true) {
                const read = reader.read().catch(() => {
                    throw new OneBot12ClientError('network', 'OneBot 12 HTTP response read failed');
                });
                const item = await abortable(read, deadline.signal, deadline.failure);

                if (item.done) {
                    break;
                }

                bytes += item.value.byteLength;

                if (bytes > this.maxResponseBytes) {
                    throw new OneBot12ClientError(
                        'limit',
                        'OneBot 12 response exceeds the byte limit',
                    );
                }

                try {
                    parts.push(decoder.decode(item.value, { stream: true }));
                } catch {
                    throw new OneBot12ClientError(
                        'invalid_response',
                        'Invalid OneBot 12 UTF-8 response',
                    );
                }
            }

            try {
                parts.push(decoder.decode());
            } catch {
                throw new OneBot12ClientError(
                    'invalid_response',
                    'Invalid OneBot 12 UTF-8 response',
                );
            }

            let result: OneBot12ActionResponse;

            try {
                const text = parts.join('');
                result = parseOneBot12ActionResponseJson(text);

                if (hasDuplicateEcho(text)) {
                    throw new Error('Duplicate echo');
                }
            } catch {
                throw new OneBot12ClientError(
                    'invalid_response',
                    'Invalid OneBot 12 action response',
                );
            }

            if (echo && result.echo !== echo) {
                throw new OneBot12ClientError(
                    'invalid_response',
                    'OneBot 12 response echo mismatch',
                );
            }

            completed = true;
            return result;
        } catch (error) {
            if (deadline.signal.aborted) {
                throw deadline.failure();
            }

            if (error instanceof OneBot12ClientError) {
                throw error;
            }

            throw new OneBot12ClientError('network', 'OneBot 12 HTTP request failed');
        } finally {
            deadline.cleanup();

            if (reader) {
                if (!completed) {
                    void reader.cancel().catch(() => {});
                }

                try {
                    reader.releaseLock();
                } catch {
                    /* A pending read may still own the lock. */
                }
            }
        }
    }

    call(
        action: string,
        params: OneBot12JsonObject = {},
        options?: OneBot12HttpRequestOptions,
    ): Promise<OneBot12ActionResponse> {
        return this.request(action, params, options);
    }
}
