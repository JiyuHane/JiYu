import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type {
    DirectAccountStatus,
    DirectAccountsResponse,
    DirectOperation,
} from '@snowluma/common/direct-account';
import {
    DirectServiceError,
    DIRECT_SERVICE_ERRORS,
    type DirectAccountService,
    type DirectRequestScope,
} from '../src/direct/service-contract';
import {
    DIRECT_BODY_LIMIT_BYTES,
    DIRECT_QR_LIMIT_BYTES,
    directResponsePolicy,
    registerDirectRoutes,
} from '../src/webui/direct-routes';

const ID = 'a'.repeat(32);
const GENERATION = 'b'.repeat(32);
const REVISION = 'c'.repeat(32);
const CONTROL = {
    expectedRevision: REVISION,
    operationKey: '12345678-1234-4123-8123-123456789abc',
};
const START = { ...CONTROL, mode: 'qr' as const };
const PNG = Uint8Array.from(
    Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/ZkAAAAASUVORK5CYII=',
        'base64',
    ),
);
const JSON_HEADERS = { 'content-type': 'application/json' };

function fixtures() {
    const account: DirectAccountStatus = {
        id: 'main',
        label: 'Fixture',
        protocol: 'linux',
        revision: REVISION,
        generation: GENERATION,
        uin: null,
        phase: 'qr-ready',
        online: false,
        onebotReady: false,
        receiveHealthy: false,
        hasStoredAccount: false,
        autoRestore: false,
        autoRenew: false,
        canRenew: false,
        renewAt: null,
        lastRenewedAt: null,
        retryAt: null,
        error: null,
        operationId: ID,
        capabilities: [],
    };
    const operation: DirectOperation = {
        id: ID,
        accountId: account.id,
        generation: GENERATION,
        kind: 'qr',
        status: 'running',
        phase: 'qr-ready',
        qrAvailable: true,
        error: null,
        startedAt: 1,
        finishedAt: null,
    };
    const service = {
        list: vi.fn<DirectAccountService['list']>(() => ({
            supported: true,
            configured: true,
            reason: null,
            accounts: [account],
        })),
        get: vi.fn<DirectAccountService['get']>(() => ({ account })),
        start: vi.fn<DirectAccountService['start']>(() => ({ account, operation })),
        stop: vi.fn<DirectAccountService['stop']>(() => ({ account, operation })),
        renew: vi.fn<DirectAccountService['renew']>(() => ({ account, operation })),
        operation: vi.fn<DirectAccountService['operation']>(() => ({ operation })),
        cancel: vi.fn<DirectAccountService['cancel']>(() => ({ account, operation })),
        qr: vi.fn<DirectAccountService['qr']>(async () => ({
            bytes: new Uint8Array(PNG),
            contentType: 'image/png',
        })),
        dispose: vi.fn<DirectAccountService['dispose']>(async () => {}),
    };
    return { service, account, operation };
}

function fixtureApp(
    options: {
        service?: DirectAccountService | null;
        scope?: DirectRequestScope | null;
        platform?: NodeJS.Platform;
    } = {},
) {
    const fixture = fixtures();
    const service = options.service === null ? undefined : (options.service ?? fixture.service);
    const scope: DirectRequestScope | undefined =
        options.scope === null
            ? undefined
            : (options.scope ?? {
                  owner: 'd'.repeat(64),
                  expiresAt: Date.now() + 60_000,
                  isCurrent: () => true,
              });
    const app = new Hono();
    app.use('*', directResponsePolicy);
    registerDirectRoutes(app, {
        service,
        getScope: () => scope,
        platform: options.platform ?? 'linux',
    });
    return { ...fixture, app, scope };
}

function post(
    app: Hono,
    path: string,
    body: unknown = START,
    headers: Record<string, string> = {},
) {
    return app.request(`http://localhost${path}`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, ...headers },
        body: JSON.stringify(body),
    });
}

async function expectFailure(response: Response, code: keyof typeof DIRECT_SERVICE_ERRORS) {
    expect(response.status).toBe(DIRECT_SERVICE_ERRORS[code].httpStatus);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
        status: 'failed',
        code,
        message: DIRECT_SERVICE_ERRORS[code].message,
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('direct management route contract', () => {
    it('returns only public list/account/operation DTOs', async () => {
        const { app, account, operation, service, scope } = fixtureApp();
        const list = await app.request('/api/direct/accounts');
        expect(await list.json()).toEqual({
            supported: true,
            configured: true,
            reason: null,
            accounts: [account],
        });
        expect(list.headers.get('cache-control')).toBe('no-store');
        expect(service.list).toHaveBeenCalledWith(scope);
        expect(await (await app.request('/api/direct/accounts/main')).json()).toEqual({ account });
        expect(await (await app.request(`/api/direct/operations/${ID}`)).json()).toEqual({
            operation,
        });
        expect(service.get).toHaveBeenCalledWith('main', scope);
        expect(service.operation).toHaveBeenCalledWith(ID, scope);
    });

    it.each(['start', 'stop', 'renew'] as const)(
        'accepts %s synchronously with 202, not a completion claim',
        async (action) => {
            const { app, service, account, operation, scope } = fixtureApp();
            const input = action === 'start' ? START : CONTROL;
            const response = await post(app, `/api/direct/accounts/main/${action}`, input);
            expect(response.status).toBe(202);
            expect(await response.json()).toEqual({ account, operation });
            expect(service[action]).toHaveBeenCalledWith('main', input, scope);
            expect(operation.status).toBe('running');
        },
    );

    it('cancel accepts only an empty object and returns the same original operation', async () => {
        const { app, service, operation, scope } = fixtureApp();
        const response = await post(app, `/api/direct/operations/${ID}/cancel`, {});
        expect(response.status).toBe(202);
        expect(await response.json()).toMatchObject({ operation });
        expect(service.cancel).toHaveBeenCalledWith(ID, scope);
        service.cancel.mockReturnValueOnce({
            account: fixtures().account,
            operation: { ...operation, id: 'e'.repeat(32) },
        });
        await expectFailure(
            await post(app, `/api/direct/operations/${ID}/cancel`, {}),
            'internal-error',
        );
        await expectFailure(
            await post(app, `/api/direct/operations/${ID}/cancel`, { ignored: true }),
            'invalid-request',
        );
        expect(service.cancel).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['linux', false, true, false, 'not-configured'],
        ['win32', false, false, false, 'unsupported-platform'],
        ['darwin', true, false, true, 'unsupported-platform'],
    ] as const)(
        'reports %s availability without a fake backend',
        async (platform, configured, supported, expectedConfigured, reason) => {
            const service = fixtures().service;
            const { app } = fixtureApp({ platform, service: configured ? service : null });
            expect(await (await app.request('/api/direct/accounts')).json()).toEqual({
                supported,
                configured: expectedConfigured,
                reason,
                accounts: [],
            });
            await expectFailure(await post(app, '/api/direct/accounts/main/start'), reason);
            expect(service.list).not.toHaveBeenCalled();
            expect(service.start).not.toHaveBeenCalled();
        },
    );

    it.each(Object.keys(DIRECT_SERVICE_ERRORS) as Array<keyof typeof DIRECT_SERVICE_ERRORS>)(
        'maps %s to its fixed status/message',
        async (code) => {
            const { app, service } = fixtureApp();
            const error = new DirectServiceError(code);
            error.message = 'private selector /secret/path ticket=opaque';
            service.list.mockImplementationOnce(() => {
                throw error;
            });
            await expectFailure(await app.request('/api/direct/accounts'), code);
        },
    );

    it('never exposes unknown thrown errors or extra private response fields', async () => {
        const { app, service } = fixtureApp();
        service.list.mockImplementationOnce(() => {
            throw new Error('/private/vault ticket=secret');
        });
        await expectFailure(await app.request('/api/direct/accounts'), 'internal-error');
        service.list.mockReturnValueOnce({
            supported: true,
            configured: true,
            reason: null,
            accounts: [],
            selector: '/private/selector',
        } as unknown as DirectAccountsResponse);
        await expectFailure(await app.request('/api/direct/accounts'), 'internal-error');
    });

    it.each([
        ['GET', '/api/direct', 'not-found'],
        ['GET', '/api/direct/accounts/main/send', 'not-found'],
        ['PUT', '/api/direct/accounts/main/start', 'method-not-allowed'],
        ['GET', '/api/direct/accounts/main/start', 'method-not-allowed'],
        ['HEAD', `/api/direct/operations/${ID}/qr`, 'method-not-allowed'],
        ['GET', '/api/direct/accounts/MAIN', 'invalid-request'],
        ['GET', '/api/direct/operations/not-opaque', 'invalid-request'],
        ['GET', '/api/direct/accounts/ma%69n', 'invalid-request'],
        ['GET', '/api/direct/accounts?token=private', 'invalid-request'],
        ['GET', `/api/direct/operations/${ID}/qr?path=/private`, 'invalid-request'],
    ] as const)('handles %s %s without service effects', async (method, path, code) => {
        const { app, service } = fixtureApp();
        const response = await app.request(path, { method });

        if (method === 'HEAD') {
            expect(response.status).toBe(405);
            expect(response.headers.get('cache-control')).toBe('no-store');
        } else {
            await expectFailure(response, code);
        }

        expect(service.start).not.toHaveBeenCalled();
        expect(service.qr).not.toHaveBeenCalled();
    });
});

describe('bounded strict direct requests and CSRF guards', () => {
    it.each([
        null,
        [],
        {},
        { ...START, path: '/private' },
        { ...START, mode: 'automatic' },
        { ...START, expectedRevision: '' },
        { ...START, operationKey: 'not-a-uuid' },
    ])('rejects invalid/unknown fields: %j', async (body) => {
        const { app, service } = fixtureApp();
        await expectFailure(
            await post(app, '/api/direct/accounts/main/start', body),
            'invalid-request',
        );
        expect(service.start).not.toHaveBeenCalled();
    });

    it.each(['', '{', 'null', '{"__proto__":{"polluted":true}}', 'true'])(
        'rejects malformed or non-object JSON %j',
        async (body) => {
            const { app, service } = fixtureApp();
            await expectFailure(
                await app.request('/api/direct/accounts/main/start', {
                    method: 'POST',
                    headers: JSON_HEADERS,
                    body,
                }),
                'invalid-request',
            );
            expect(service.start).not.toHaveBeenCalled();
        },
    );

    it.each(['text/plain', 'application/x-www-form-urlencoded', 'application/problem+json'])(
        'requires application/json instead of %s',
        async (media) => {
            const { app, service } = fixtureApp();
            await expectFailure(
                await post(app, '/api/direct/accounts/main/start', START, {
                    'content-type': media,
                }),
                'unsupported-media-type',
            );
            expect(service.start).not.toHaveBeenCalled();
        },
    );

    it('measures exactly 16KiB, including chunked bodies and dishonest lengths', async () => {
        const { app, service } = fixtureApp();
        const body = JSON.stringify(START).padEnd(DIRECT_BODY_LIMIT_BYTES, ' ');
        expect(
            (
                await app.request('/api/direct/accounts/main/start', {
                    method: 'POST',
                    headers: JSON_HEADERS,
                    body,
                })
            ).status,
        ).toBe(202);
        await expectFailure(
            await app.request('/api/direct/accounts/main/start', {
                method: 'POST',
                headers: JSON_HEADERS,
                body: body + ' ',
            }),
            'body-too-large',
        );
        await expectFailure(
            await post(app, '/api/direct/accounts/main/start', START, {
                'content-length': '16385',
            }),
            'body-too-large',
        );
        await expectFailure(
            await post(app, '/api/direct/accounts/main/start', START, { 'content-length': '1' }),
            'invalid-request',
        );
        await expectFailure(
            await post(app, '/api/direct/accounts/main/start', START, { 'content-length': 'bad' }),
            'invalid-request',
        );
        const cancelled = vi.fn();
        let chunk = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new Uint8Array(++chunk === 1 ? DIRECT_BODY_LIMIT_BYTES : 1));
            },
            cancel: cancelled,
        });
        const request = new Request('http://localhost/api/direct/accounts/main/start', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: stream,
            duplex: 'half',
        } as RequestInit);
        await expectFailure(await app.request(request), 'body-too-large');
        expect(cancelled).toHaveBeenCalledOnce();
        expect(service.start).toHaveBeenCalledOnce();
    });

    it('rejects invalid UTF-8, encoded bodies and aborted streams', async () => {
        const { app, service } = fixtureApp();
        await expectFailure(
            await app.request('/api/direct/accounts/main/start', {
                method: 'POST',
                headers: JSON_HEADERS,
                body: new Uint8Array([0xff]),
            }),
            'invalid-request',
        );
        await expectFailure(
            await post(app, '/api/direct/accounts/main/start', START, {
                'content-encoding': 'gzip',
            }),
            'invalid-request',
        );
        const abort = new AbortController();
        abort.abort();
        await expectFailure(
            await app.request('/api/direct/accounts/main/start', {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify(START),
                signal: abort.signal,
            }),
            'invalid-request',
        );
        expect(service.start).not.toHaveBeenCalled();
    });

    it.each<Record<string, string>>([
        { origin: 'null' },
        { origin: 'https://evil.example' },
        { origin: 'http://localhost.evil.example' },
        { 'sec-fetch-site': 'cross-site' },
        { 'sec-fetch-site': 'same-site' },
        { 'sec-fetch-mode': 'navigate' },
        { 'sec-fetch-mode': 'no-cors' },
        {
            origin: 'https://evil.example',
            'x-forwarded-host': 'evil.example',
            'x-forwarded-proto': 'https',
        },
        { origin: 'https://evil.example', forwarded: 'host=evil.example;proto=https' },
    ])('blocks cross-origin requests before service calls: %j', async (headers) => {
        const { app, service } = fixtureApp();
        await expectFailure(
            await post(app, '/api/direct/accounts/main/start', START, headers),
            'cross-origin',
        );
        await expectFailure(
            await app.request(`http://localhost/api/direct/operations/${ID}/qr`, { headers }),
            'cross-origin',
        );
        expect(service.start).not.toHaveBeenCalled();
        expect(service.qr).not.toHaveBeenCalled();
    });

    it('accepts same-origin browser and no-Origin header-client requests, ignoring forwarded authority', async () => {
        const { app, service } = fixtureApp();
        expect(
            (
                await post(app, '/api/direct/accounts/main/start', START, {
                    origin: 'http://localhost',
                    'sec-fetch-site': 'same-origin',
                    'sec-fetch-mode': 'cors',
                    'x-forwarded-host': 'evil.example',
                })
            ).status,
        ).toBe(202);
        expect((await post(app, '/api/direct/accounts/main/start')).status).toBe(202);
        expect(service.start).toHaveBeenCalledTimes(2);
    });
});

describe('authenticated bounded QR delivery', () => {
    it.each([
        ['image/png', PNG],
        ['image/jpeg', Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])],
        ['image/webp', Uint8Array.from(Buffer.from('RIFFxxxxWEBP', 'ascii'))],
    ] as const)(
        'matches %s magic bytes and wipes the transferred snapshot',
        async (contentType, bytes) => {
            const { app, service } = fixtureApp();
            const owned = new Uint8Array(bytes);
            service.qr.mockResolvedValueOnce({ contentType, bytes: owned });
            const response = await app.request(`/api/direct/operations/${ID}/qr`);
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe(contentType);
            expect(response.headers.get('content-length')).toBe(String(bytes.length));
            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(response.headers.get('x-content-type-options')).toBe('nosniff');
            expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
            expect(owned.every((byte) => byte === 0)).toBe(true);
        },
    );

    it('accepts 1MiB exactly and rejects larger or mismatched image signatures', async () => {
        const { app, service } = fixtureApp();
        const maximum = new Uint8Array(DIRECT_QR_LIMIT_BYTES);
        maximum.set(PNG);
        service.qr.mockResolvedValueOnce({ contentType: 'image/png', bytes: maximum });
        const response = await app.request(`/api/direct/operations/${ID}/qr`);
        expect(response.status).toBe(200);
        expect((await response.arrayBuffer()).byteLength).toBe(DIRECT_QR_LIMIT_BYTES);

        for (const bytes of [
            new Uint8Array(DIRECT_QR_LIMIT_BYTES + 1),
            new Uint8Array(),
            Uint8Array.from(Buffer.from('<svg>private</svg>')),
        ]) {
            service.qr.mockResolvedValueOnce({ contentType: 'image/png', bytes });
            await expectFailure(
                await app.request(`/api/direct/operations/${ID}/qr`),
                'internal-error',
            );
            expect(bytes.every((byte) => byte === 0)).toBe(true);
        }

        const wrongMime = new Uint8Array(PNG);
        service.qr.mockResolvedValueOnce({ contentType: 'image/jpeg', bytes: wrongMime });
        await expectFailure(await app.request(`/api/direct/operations/${ID}/qr`), 'internal-error');
        expect(wrongMime.every((byte) => byte === 0)).toBe(true);
    });

    it.each(['missing', 'expired', 'revoked'] as const)(
        'denies a %s scope before reading bytes',
        async (kind) => {
            const { app, service } = fixtureApp({
                scope:
                    kind === 'missing'
                        ? null
                        : {
                              owner: 'd'.repeat(64),
                              expiresAt: Date.now() + (kind === 'expired' ? -1 : 60_000),
                              isCurrent: () => kind !== 'revoked',
                          },
            });
            await expectFailure(
                await app.request(`/api/direct/operations/${ID}/qr`),
                'scope-expired',
            );
            expect(service.qr).not.toHaveBeenCalled();
        },
    );

    it('denies another owner and stale generation before invoking QR I/O', async () => {
        const { app, service, account } = fixtureApp();
        service.operation.mockImplementationOnce(() => {
            throw new DirectServiceError('operation-not-found');
        });
        await expectFailure(
            await app.request(`/api/direct/operations/${ID}/qr`),
            'operation-not-found',
        );
        account.generation = 'f'.repeat(32);
        await expectFailure(await app.request(`/api/direct/operations/${ID}/qr`), 'qr-unavailable');
        expect(service.qr).not.toHaveBeenCalled();
    });

    it.each(['revoked', 'expired', 'terminal', 'replaced'] as const)(
        'rechecks %s state after the asynchronous image read',
        async (kind) => {
            let current = true;
            const scope: DirectRequestScope = {
                owner: 'd'.repeat(64),
                expiresAt: Date.now() + 60_000,
                isCurrent: () => current,
            };
            const { app, service, operation, account } = fixtureApp({ scope });
            const reading = deferred<Awaited<ReturnType<DirectAccountService['qr']>>>();
            const entered = deferred<void>();
            service.qr.mockImplementationOnce(() => {
                entered.resolve();
                return reading.promise;
            });
            const pending = app.request(`/api/direct/operations/${ID}/qr`);
            await entered.promise;

            if (kind === 'revoked') {
                current = false;
            }

            if (kind === 'expired') {
                vi.spyOn(Date, 'now').mockReturnValue(scope.expiresAt);
            }

            if (kind === 'terminal') {
                operation.status = 'cancelled';
                operation.finishedAt = 2;
                operation.qrAvailable = false;
            }

            if (kind === 'replaced') {
                account.generation = 'f'.repeat(32);
            }

            const bytes = new Uint8Array(PNG);
            reading.resolve({ contentType: 'image/png', bytes });

            try {
                await expectFailure(
                    await pending,
                    kind === 'revoked' || kind === 'expired' ? 'scope-expired' : 'qr-unavailable',
                );
                expect(bytes.every((byte) => byte === 0)).toBe(true);
            } finally {
                vi.restoreAllMocks();
            }
        },
    );

    it('rechecks scope after body streaming and before any mutation', async () => {
        let current = true;
        const { app, service } = fixtureApp({
            scope: {
                owner: 'd'.repeat(64),
                expiresAt: Date.now() + 60_000,
                isCurrent: () => current,
            },
        });
        const pulled = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(START)));
            current = false;
            controller.close();
        });
        const body = new ReadableStream<Uint8Array>({ pull: pulled }, { highWaterMark: 0 });
        const request = new Request('http://localhost/api/direct/accounts/main/start', {
            method: 'POST',
            headers: JSON_HEADERS,
            body,
            duplex: 'half',
        } as RequestInit);
        await expectFailure(await app.request(request), 'scope-expired');
        expect(pulled).toHaveBeenCalledOnce();
        expect(service.start).not.toHaveBeenCalled();
    });
});
