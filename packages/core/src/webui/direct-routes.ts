import { types } from 'node:util';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import {
    parseDirectAcceptedResponse,
    parseDirectAccountId,
    parseDirectAccountResponse,
    parseDirectAccountsResponse,
    parseDirectCancelRequest,
    parseDirectControlRequest,
    parseDirectOperationId,
    parseDirectOperationResponse,
    parseDirectStartRequest,
    type DirectOperation,
} from '@snowluma/common/direct-account';
import { createLogger } from '@snowluma/common/logger';
import {
    assertDirectRequestScope,
    DIRECT_SERVICE_ERRORS,
    DirectServiceError,
    type DirectAccountService,
    type DirectRequestScope,
} from '../direct/service-contract';
import { sniffImageMime } from './ui-config';

export const DIRECT_BODY_LIMIT_BYTES = 16 * 1024;
export const DIRECT_QR_LIMIT_BYTES = 1024 * 1024;
const log = createLogger('WebUI.Direct');

export function isDirectRequestPath(pathname: string): boolean {
    return /^\/api\/direct(?:\/|$)/u.test(pathname);
}

function cancelBody(request: Request): void {
    if (request.body && !request.body.locked) {
        try {
            void request.body.cancel().catch(() => {});
        } catch {
            // Best effort only: preserve the fixed response on an early exit.
        }
    }
}

/** Install before authentication, including failures and unknown direct routes. */
export const directResponsePolicy: MiddlewareHandler = async (c, next) => {
    if (!isDirectRequestPath(c.req.path)) {
        return next();
    }

    c.header('Cache-Control', 'no-store');
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
    c.res.headers.set('X-Content-Type-Options', 'nosniff');

    if (!c.req.raw.bodyUsed) {
        cancelBody(c.req.raw);
    }
};

export function directFailureResponse(c: Context, error: unknown): Response {
    const code =
        error instanceof DirectServiceError && Object.hasOwn(DIRECT_SERVICE_ERRORS, error.code)
            ? error.code
            : 'internal-error';
    const definition = DIRECT_SERVICE_ERRORS[code];

    if (code === 'internal-error') {
        // No raw cause, request URL, headers, service state or input in diagnostics.
        log.warn('direct management request failed code=%s', code);
    }

    return c.json({ status: 'failed', code, message: definition.message }, definition.httpStatus);
}

function parseInput<T>(parse: (input: unknown) => T, input: unknown): T {
    try {
        return parse(input);
    } catch {
        throw new DirectServiceError('invalid-request');
    }
}

function checkOrigin(request: Request): void {
    const origin = request.headers.get('origin');
    const site = request.headers.get('sec-fetch-site');
    const mode = request.headers.get('sec-fetch-mode');

    // Use the actual request authority. Forwarded/X-Forwarded-Host do not grant
    // another origin access; proxies must preserve the public request authority.
    if (
        (origin !== null && origin !== new URL(request.url).origin) ||
        (site !== null && site !== 'same-origin' && site !== 'none') ||
        (mode !== null && mode !== 'cors' && mode !== 'same-origin')
    ) {
        throw new DirectServiceError('cross-origin');
    }
}

async function readJson(request: Request): Promise<unknown> {
    const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();

    if (mediaType !== 'application/json') {
        throw new DirectServiceError('unsupported-media-type');
    }

    if (request.headers.has('content-encoding')) {
        throw new DirectServiceError('invalid-request');
    }

    const length = request.headers.get('content-length');

    if (length !== null && !/^\d+$/u.test(length)) {
        throw new DirectServiceError('invalid-request');
    }

    const declared = length === null ? null : Number(length);

    if (
        declared !== null &&
        (!Number.isSafeInteger(declared) || declared > DIRECT_BODY_LIMIT_BYTES)
    ) {
        throw new DirectServiceError('body-too-large');
    }

    if (!request.body || request.signal.aborted) {
        throw new DirectServiceError('invalid-request');
    }

    const reader = request.body.getReader();
    const bytes = new Uint8Array(DIRECT_BODY_LIMIT_BYTES);
    let done = false;
    let size = 0;
    let chunks = 0;

    const cancel = () => {
        void reader.cancel().catch(() => {});
    };

    request.signal.addEventListener('abort', cancel, { once: true });

    try {
        for (;;) {
            const part = await reader.read();
            done = part.done;

            if (request.signal.aborted) {
                throw new DirectServiceError('invalid-request');
            }

            if (part.done) {
                break;
            }

            if (!types.isUint8Array(part.value)) {
                throw new DirectServiceError('invalid-request');
            }

            if (++chunks > DIRECT_BODY_LIMIT_BYTES || part.value.byteLength > bytes.length - size) {
                throw new DirectServiceError('body-too-large');
            }

            bytes.set(part.value, size);
            size += part.value.byteLength;
        }

        if (declared !== null && declared !== size) {
            throw new DirectServiceError('invalid-request');
        }

        return JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)),
        );
    } catch (error) {
        throw error instanceof DirectServiceError
            ? error
            : new DirectServiceError('invalid-request');
    } finally {
        request.signal.removeEventListener('abort', cancel);

        if (!done) {
            cancel();
        }

        reader.releaseLock();
        bytes.fill(0);
    }
}

function currentQr(
    service: DirectAccountService,
    id: string,
    scope: DirectRequestScope,
): DirectOperation {
    assertDirectRequestScope(scope);
    const { operation } = parseDirectOperationResponse(service.operation(id, scope));

    if (
        operation.id !== id ||
        operation.kind !== 'qr' ||
        operation.status !== 'running' ||
        !operation.qrAvailable
    ) {
        throw new DirectServiceError('qr-unavailable');
    }

    const { account } = parseDirectAccountResponse(service.get(operation.accountId, scope));

    if (
        account.id !== operation.accountId ||
        account.generation !== operation.generation ||
        account.operationId !== id
    ) {
        throw new DirectServiceError('qr-unavailable');
    }

    assertDirectRequestScope(scope);
    return operation;
}

async function qrResponse(
    service: DirectAccountService,
    id: string,
    scope: DirectRequestScope,
): Promise<Response> {
    const before = currentQr(service, id, scope);
    const qr = await service.qr(id, scope);
    let body: Uint8Array<ArrayBuffer> | undefined;

    try {
        assertDirectRequestScope(scope);
        const after = currentQr(service, id, scope);

        if (before.generation !== after.generation || before.accountId !== after.accountId) {
            throw new DirectServiceError('qr-unavailable');
        }

        if (
            !types.isUint8Array(qr.bytes) ||
            types.isSharedArrayBuffer(qr.bytes.buffer) ||
            ('resizable' in qr.bytes.buffer && qr.bytes.buffer.resizable === true) ||
            qr.bytes.byteLength === 0 ||
            qr.bytes.byteLength > DIRECT_QR_LIMIT_BYTES ||
            !['image/png', 'image/jpeg', 'image/webp'].includes(qr.contentType) ||
            sniffImageMime(qr.bytes) !== qr.contentType
        ) {
            throw new DirectServiceError('internal-error');
        }

        body = new Uint8Array(qr.bytes);
        assertDirectRequestScope(scope);
        return new Response(body, {
            headers: {
                'Content-Type': qr.contentType,
                'Content-Length': String(body.byteLength),
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
            },
        });
    } finally {
        // Response owns its own copy; neither staging buffer survives this call.
        body?.fill(0);

        if (types.isUint8Array(qr.bytes)) {
            qr.bytes.fill(0);
        }
    }
}

/** Register only behind the existing WebUI authentication/consent/password gates. */
export function registerDirectRoutes(
    app: Hono,
    options: {
        service?: DirectAccountService;
        getScope(request: Request): DirectRequestScope | undefined;
        platform?: NodeJS.Platform;
    },
): void {
    const supported = (options.platform ?? process.platform) === 'linux';
    const unavailable = supported ? 'not-configured' : 'unsupported-platform';
    const service = supported ? options.service : undefined;

    const handle = async (c: Context): Promise<Response> => {
        try {
            const request = c.req.raw;
            const scope = options.getScope(request);

            if (!scope) {
                throw new DirectServiceError('scope-expired');
            }

            assertDirectRequestScope(scope);
            checkOrigin(request);
            const url = new URL(request.url);

            if (url.search || url.pathname.includes('%')) {
                throw new DirectServiceError('invalid-request');
            }

            const account = /^\/api\/direct\/accounts\/([^/]+)(?:\/(start|stop|renew))?$/u.exec(
                url.pathname,
            );
            const operation = /^\/api\/direct\/operations\/([^/]+)(?:\/(qr|cancel))?$/u.exec(
                url.pathname,
            );
            const list = url.pathname === '/api/direct/accounts';

            if (!list && !account && !operation) {
                throw new DirectServiceError('not-found');
            }

            const action = account?.[2] ?? operation?.[2];
            const method = action && action !== 'qr' ? 'POST' : 'GET';

            if (request.method !== method) {
                throw new DirectServiceError('method-not-allowed');
            }

            const id = account
                ? parseInput(parseDirectAccountId, account[1])
                : operation
                  ? parseInput(parseDirectOperationId, operation[1])
                  : '';
            // Parse all mutations before dispatch, including disabled deployments.
            const body = method === 'POST' ? await readJson(request) : undefined;
            const input =
                action === 'start'
                    ? parseInput(parseDirectStartRequest, body)
                    : action === 'stop' || action === 'renew'
                      ? parseInput(parseDirectControlRequest, body)
                      : action === 'cancel'
                        ? parseInput(parseDirectCancelRequest, body)
                        : undefined;
            assertDirectRequestScope(scope);

            if (list) {
                const result = service
                    ? parseDirectAccountsResponse(service.list(scope))
                    : {
                          supported,
                          configured: options.service !== undefined,
                          reason: unavailable,
                          accounts: [],
                      };
                assertDirectRequestScope(scope);
                return c.json(result);
            }

            if (!service) {
                throw new DirectServiceError(unavailable);
            }

            if (action === 'qr') {
                return await qrResponse(service, id, scope);
            }

            if (!action) {
                if (account) {
                    const result = parseDirectAccountResponse(service.get(id, scope));

                    if (result.account.id !== id) {
                        throw new DirectServiceError('internal-error');
                    }

                    assertDirectRequestScope(scope);
                    return c.json(result);
                }

                const result = parseDirectOperationResponse(service.operation(id, scope));

                if (result.operation.id !== id) {
                    throw new DirectServiceError('internal-error');
                }

                assertDirectRequestScope(scope);
                return c.json(result);
            }

            const result = parseDirectAcceptedResponse(
                action === 'start'
                    ? service.start(id, parseDirectStartRequest(input), scope)
                    : action === 'stop'
                      ? service.stop(id, parseDirectControlRequest(input), scope)
                      : action === 'renew'
                        ? service.renew(id, parseDirectControlRequest(input), scope)
                        : service.cancel(id, scope),
            );

            if (
                (account && result.account.id !== id) ||
                (operation && result.operation.id !== id)
            ) {
                throw new DirectServiceError('internal-error');
            }

            assertDirectRequestScope(scope);
            return c.json(result, 202);
        } catch (error) {
            return directFailureResponse(c, error);
        }
    };

    app.all('/api/direct', handle);
    app.all('/api/direct/*', handle);
}
