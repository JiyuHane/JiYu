import type { OneBot12Self } from './types.js';

/** Failures intentionally exclude response bodies, URL credentials and token values. */
export class OneBot12ClientError extends Error {
    constructor(
        readonly code:
            | 'invalid_options'
            | 'network'
            | 'http_status'
            | 'invalid_response'
            | 'timeout'
            | 'aborted'
            | 'closed'
            | 'limit'
            | 'protocol'
            | 'callback',
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = 'OneBot12ClientError';
    }
}

export interface OneBot12RequestOptions {
    self?: OneBot12Self;
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface OneBot12ClientOptions {
    accessToken?: string;
    requestTimeoutMs?: number;
    /** Maximum size of a received JSON message, measured in UTF-8 bytes. */
    maxResponseBytes?: number;
}

export function checkedLimit(value: number, name: string, minimum: number): number {
    if (!Number.isSafeInteger(value) || value < minimum || value > 2_147_483_647) {
        throw new OneBot12ClientError('invalid_options', `Invalid ${name}`);
    }

    return value;
}

/** Manage one total deadline, including connection and response. */
export function requestDeadline(
    timeoutMs: number,
    signal?: AbortSignal,
): {
    signal: AbortSignal;
    failure(): OneBot12ClientError;
    cleanup(): void;
} {
    checkedLimit(timeoutMs, 'timeoutMs', 0);
    const controller = new AbortController();
    const timeoutReason = Symbol('OneBot 12 request timeout');
    const abort = () => controller.abort();
    let timedOut = false;
    let listening = false;
    let combined = controller.signal;

    const removeFallback = () => {
        if (listening) {
            listening = false;

            try {
                signal?.removeEventListener('abort', abort);
            } catch {
                // An untrusted signal can throw; never expose its error text.
            }
        }
    };

    try {
        if (signal !== undefined) {
            if (typeof AbortSignal.any === 'function') {
                // Native dependencies are not blocked by source event propagation.
                combined = AbortSignal.any([signal, controller.signal]);
            } else if (signal.aborted) {
                controller.abort();
            } else {
                listening = true;
                signal.addEventListener('abort', abort, { once: true });

                if (signal.aborted) {
                    abort();
                }
            }
        }
    } catch {
        removeFallback();
        throw new OneBot12ClientError('invalid_options', 'Invalid OneBot 12 request signal');
    }

    const timer =
        timeoutMs > 0 && !combined.aborted
            ? setTimeout(() => {
                  if (!combined.aborted) {
                      timedOut = true;
                      controller.abort(timeoutReason);
                  }
              }, timeoutMs)
            : undefined;
    return {
        signal: combined,
        failure: () =>
            timedOut
                ? new OneBot12ClientError('timeout', 'OneBot 12 request timed out')
                : new OneBot12ClientError('aborted', 'OneBot 12 request aborted'),
        cleanup: () => {
            if (timer !== undefined) {
                clearTimeout(timer);
            }

            removeFallback();
        },
    };
}

export function abortable<T>(
    promise: Promise<T>,
    signal: AbortSignal,
    failure: () => Error,
): Promise<T> {
    if (signal.aborted) {
        // The caller may already have started work before observing the abort.
        // Observe a later rejection without changing the cancellation result.
        try {
            void Promise.resolve(promise).catch(() => {});
        } catch {
            // A modified Promise can throw during observation; keep abort dominant.
        }

        return Promise.reject(failure());
    }

    return new Promise((resolve, reject) => {
        const onAbort = () => {
            cleanup();
            reject(failure());
        };

        const cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                cleanup();
                resolve(value);
            },
            (error: unknown) => {
                cleanup();
                reject(error);
            },
        );

        if (signal.aborted) {
            onAbort();
        }
    });
}

// Call only after validating JSON syntax. Nested echoes are independent of correlation.
export function hasDuplicateEcho(text: string): boolean {
    let depth = 0;
    let count = 0;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (ch === '"') {
            const start = i;

            while (++i < text.length) {
                if (text[i] === '\\') {
                    i++;
                } else if (text[i] === '"') {
                    break;
                }
            }

            let next = i + 1;

            while (next < text.length && /\s/.test(text[next])) {
                next++;
            }

            if (
                depth === 1 &&
                text[next] === ':' &&
                JSON.parse(text.slice(start, i + 1)) === 'echo'
            ) {
                if (++count > 1) {
                    return true;
                }
            }
        } else if (ch === '{' || ch === '[') {
            depth++;
        } else if (ch === '}' || ch === ']') {
            depth--;
        }
    }

    return false;
}

export function validateEndpoint(value: string, protocol: 'http' | 'ws'): string {
    let url: URL;

    try {
        url = new URL(value);
    } catch {
        throw new OneBot12ClientError('invalid_options', 'Invalid endpoint URL');
    }

    const allowed = protocol === 'http' ? ['http:', 'https:'] : ['ws:', 'wss:'];

    if (
        !allowed.includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        url.search ||
        url.pathname !== '/'
    ) {
        throw new OneBot12ClientError(
            'invalid_options',
            'Endpoint must be a root URL without credentials, query or fragment',
        );
    }

    return url.toString();
}
