import {
    parseDirectAcceptedResponse,
    parseDirectAccountId,
    parseDirectAccountResponse,
    parseDirectAccountsResponse,
    parseDirectCancelRequest,
    parseDirectControlRequest,
    parseDirectFailureResponse,
    parseDirectOperationId,
    parseDirectOperationResponse,
    parseDirectStartRequest,
    type DirectAcceptedResponse,
    type DirectAccountResponse,
    type DirectAccountsResponse,
    type DirectControlRequest,
    type DirectOperationResponse,
    type DirectStartRequest,
} from '@snowluma/common/direct-account';
import { ApiError } from './types';

export interface DirectAccountsApi {
    list(signal?: AbortSignal): Promise<DirectAccountsResponse>;
    get(id: string, signal?: AbortSignal): Promise<DirectAccountResponse>;
    start(
        id: string,
        input: DirectStartRequest,
        signal?: AbortSignal,
    ): Promise<DirectAcceptedResponse>;
    stop(
        id: string,
        input: DirectControlRequest,
        signal?: AbortSignal,
    ): Promise<DirectAcceptedResponse>;
    renew(
        id: string,
        input: DirectControlRequest,
        signal?: AbortSignal,
    ): Promise<DirectAcceptedResponse>;
    operation(id: string, signal?: AbortSignal): Promise<DirectOperationResponse>;
    cancel(id: string, signal?: AbortSignal): Promise<DirectAcceptedResponse>;
    qr(id: string, signal?: AbortSignal): Promise<Blob>;
}

const MAX_BYTES = 1024 * 1024;
const invalid = () => new ApiError(502, '直连账号响应格式错误', 'INVALID_RESPONSE');
const sessionChanged = () =>
    new ApiError(401, '管理会话已变更，请重新读取账号状态', 'SESSION_CHANGED');

/** Uses the existing client's header authentication and old-token 401 handling. */
export function createDirectAccountsApi(
    request: (url: string, init: RequestInit) => Promise<Response>,
    currentToken: () => string | null,
): DirectAccountsApi {
    async function exchange<T>(
        url: string,
        parse: (bytes: Uint8Array, response: Response) => T,
        signal?: AbortSignal,
        input?: unknown,
    ): Promise<T> {
        const token = currentToken();
        const controller = new AbortController();
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let interrupt!: (reason: unknown) => void;
        const interrupted = new Promise<never>((_, reject) => {
            interrupt = reject;
        });

        const abort = (reason: unknown) => {
            controller.abort(reason);
            interrupt(reason);
            void reader?.cancel().catch(() => {});
        };

        const onAbort = () => abort(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        const timer = setTimeout(
            () => abort(new ApiError(408, '请求超时，请重试', 'REQUEST_TIMEOUT')),
            30_000,
        );
        signal?.addEventListener('abort', onAbort, { once: true });

        if (signal?.aborted) {
            onAbort();
        }

        const check = () => {
            if (controller.signal.aborted) {
                throw controller.signal.reason;
            }

            if (!token || token !== currentToken()) {
                throw sessionChanged();
            }
        };

        const work = async () => {
            check();
            const response = await request(url, {
                method: input === undefined ? 'GET' : 'POST',
                ...(input === undefined ? {} : { body: JSON.stringify(input) }),
                signal: controller.signal,
                cache: 'no-store',
                credentials: 'same-origin',
                redirect: 'error',
            });

            try {
                check();
            } catch (error) {
                void response.body?.cancel().catch(() => {});
                throw error;
            }

            const declared = response.headers.get('Content-Length');

            if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
                void response.body?.cancel().catch(() => {});
                throw invalid();
            }

            const chunks: Uint8Array[] = [];
            let total = 0;

            if (response.body) {
                reader = response.body.getReader();

                try {
                    while (true) {
                        const part = await reader.read();
                        check();

                        if (part.done) {
                            break;
                        }

                        total += part.value.byteLength;

                        if (total > MAX_BYTES || chunks.length >= 4096) {
                            void reader.cancel().catch(() => {});
                            throw invalid();
                        }

                        chunks.push(part.value);
                    }
                } finally {
                    reader.releaseLock();
                    reader = undefined;
                }
            }

            check();
            const bytes = new Uint8Array(total);
            let offset = 0;

            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
            }

            if (!response.ok) {
                let failure;

                try {
                    failure = parseDirectFailureResponse(
                        JSON.parse(new TextDecoder().decode(bytes)),
                    );
                } catch {
                    throw new ApiError(
                        response.status,
                        '直连账号请求失败',
                        'DIRECT_REQUEST_FAILED',
                    );
                }

                throw new ApiError(response.status, failure.message, failure.code);
            }

            if (response.status !== (input === undefined ? 200 : 202)) {
                throw invalid();
            }

            return parse(bytes, response);
        };

        try {
            return await Promise.race([interrupted, work()]);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
    }

    function json<T>(
        url: string,
        parse: (value: unknown) => T,
        signal?: AbortSignal,
        input?: unknown,
    ) {
        return exchange(
            url,
            (bytes, response) => {
                if (
                    !/^application\/json(?:;|$)/i.test(response.headers.get('Content-Type') ?? '')
                ) {
                    throw invalid();
                }

                try {
                    return parse(
                        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
                    );
                } catch {
                    throw invalid();
                }
            },
            signal,
            input,
        );
    }

    const accountPath = (id: string) => `/api/direct/accounts/${parseDirectAccountId(id)}`;
    const operationPath = (id: string) => `/api/direct/operations/${parseDirectOperationId(id)}`;

    const accepted = (id: string) => (value: unknown) => {
        const result = parseDirectAcceptedResponse(value);

        if (result.account.id !== id) {
            throw invalid();
        }

        return result;
    };

    return {
        list: (signal) => json('/api/direct/accounts', parseDirectAccountsResponse, signal),
        get: (id, signal) =>
            json(
                accountPath(id),
                (value) => {
                    const result = parseDirectAccountResponse(value);

                    if (result.account.id !== id) {
                        throw invalid();
                    }

                    return result;
                },
                signal,
            ),
        start: (id, input, signal) =>
            json(`${accountPath(id)}/start`, accepted(id), signal, parseDirectStartRequest(input)),
        stop: (id, input, signal) =>
            json(`${accountPath(id)}/stop`, accepted(id), signal, parseDirectControlRequest(input)),
        renew: (id, input, signal) =>
            json(
                `${accountPath(id)}/renew`,
                accepted(id),
                signal,
                parseDirectControlRequest(input),
            ),
        operation: (id, signal) =>
            json(
                operationPath(id),
                (value) => {
                    const result = parseDirectOperationResponse(value);

                    if (result.operation.id !== id) {
                        throw invalid();
                    }

                    return result;
                },
                signal,
            ),
        cancel: (id, signal) =>
            json(
                `${operationPath(id)}/cancel`,
                (value) => {
                    const result = parseDirectAcceptedResponse(value);

                    if (result.operation.id !== id) {
                        throw invalid();
                    }

                    return result;
                },
                signal,
                parseDirectCancelRequest({}),
            ),
        qr: (id, signal) =>
            exchange(
                `${operationPath(id)}/qr`,
                (bytes, response) => {
                    const mime = response.headers
                        .get('Content-Type')
                        ?.split(';')[0]
                        .trim()
                        .toLowerCase();
                    const png =
                        mime === 'image/png' &&
                        [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
                    const jpeg =
                        mime === 'image/jpeg' &&
                        bytes[0] === 255 &&
                        bytes[1] === 216 &&
                        bytes[2] === 255;
                    const ascii = (start: number, value: string) =>
                        [...value].every((v, i) => bytes[start + i] === v.charCodeAt(0));
                    const webp = mime === 'image/webp' && ascii(0, 'RIFF') && ascii(8, 'WEBP');

                    if (!png && !jpeg && !webp) {
                        throw invalid();
                    }

                    return new Blob([new Uint8Array(bytes).buffer], { type: mime });
                },
                signal,
            ),
    };
}
