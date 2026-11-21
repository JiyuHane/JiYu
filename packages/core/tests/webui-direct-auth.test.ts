import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { OneBotManager } from '@snowluma/onebot/manager';
import type { DirectAccountStatus, DirectOperation } from '@snowluma/common/direct-account';
import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import { WebuiAuth } from '../src/webui/auth';
import { initWebUI } from '../src/webui/server';
import {
    DIRECT_SERVICE_ERRORS,
    DirectServiceError,
    type DirectAccountService,
    type DirectRequestScope,
} from '../src/direct/service-contract';

const transport = vi.hoisted(() => ({
    fetch: null as null | ((request: Request) => Promise<Response>),
}));
vi.mock('@hono/node-server', () => ({
    serve: vi.fn(
        (
            options: { fetch: typeof transport.fetch },
            onListen: (info: { port: number }) => void,
        ) => {
            transport.fetch = options.fetch;
            queueMicrotask(() => onListen({ port: 5099 }));
            return { close: (done: () => void) => done() };
        },
    ),
}));
vi.mock('../src/webui/port', () => ({ findAvailablePort: vi.fn(async () => 5099) }));

const ID = 'a'.repeat(32);
const GENERATION = 'b'.repeat(32);
const REVISION = 'c'.repeat(32);
const START = {
    mode: 'qr',
    expectedRevision: REVISION,
    operationKey: '12345678-1234-4123-8123-123456789abc',
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let cwd: string;
let directory: string;
let server: Awaited<ReturnType<typeof initWebUI>> | undefined;
let network: MockInstance<typeof fetch>;
const tokens = new Set<string>();

beforeEach(async () => {
    cwd = process.cwd();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jiyu-direct-auth-'));
    process.chdir(directory);
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' });
    transport.fetch = null;
    vi.stubEnv('SNOWLUMA_DEV_MODE', '1');
    vi.stubEnv('SNOWLUMA_ACCEPT_EULA', '1');
    vi.stubEnv('SNOWLUMA_ACCEPT_PRIVACY', '1');
    vi.stubEnv('SNOWLUMA_WEBUI_TARGET', '');
    vi.stubEnv('SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD', '');
    network = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Unexpected external network'));
});

afterEach(async () => {
    try {
        vi.restoreAllMocks();

        if (server) {
            for (const token of tokens) {
                await request('/api/logout', {
                    method: 'POST',
                    headers: { 'X-SnowLuma-Token': token },
                });
            }

            await server.stop();
        }
    } finally {
        server = undefined;
        tokens.clear();
        transport.fetch = null;
        vi.unstubAllEnvs();
        Object.defineProperty(process, 'platform', originalPlatform);
        process.chdir(cwd);
        await fs.rm(directory, { recursive: true, force: true });
    }
});

async function request(url: string, init?: RequestInit): Promise<Response> {
    if (!transport.fetch) {
        throw new Error('WebUI fetch is not ready');
    }

    return transport.fetch(new Request(`http://127.0.0.1${url}`, init));
}

async function login(password = 'snowluma-dev'): Promise<string> {
    const response = await request('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as { token: string };
    expect(data.token).toBeTruthy();
    tokens.add(data.token);
    return data.token;
}

function headers(token: string): Record<string, string> {
    return { 'X-SnowLuma-Token': token, 'content-type': 'application/json' };
}

function serviceFixture() {
    let owner: string | undefined;
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
        accountId: 'main',
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
        start: vi.fn<DirectAccountService['start']>((_id, _input, scope) => {
            owner = scope.owner;
            return { account, operation };
        }),
        stop: vi.fn<DirectAccountService['stop']>(() => ({ account, operation })),
        renew: vi.fn<DirectAccountService['renew']>(() => {
            throw new DirectServiceError('renewal-unavailable');
        }),
        operation: vi.fn<DirectAccountService['operation']>((_id, scope) => {
            if (scope.owner !== owner) {
                throw new DirectServiceError('operation-not-found');
            }

            return { operation };
        }),
        cancel: vi.fn<DirectAccountService['cancel']>((_id, scope) => {
            if (scope.owner !== owner) {
                throw new DirectServiceError('operation-not-found');
            }

            return {
                account,
                operation: { ...operation, status: 'cancelled', qrAvailable: false, finishedAt: 2 },
            };
        }),
        qr: vi.fn<DirectAccountService['qr']>(async () => ({
            bytes: new Uint8Array(PNG),
            contentType: 'image/png',
        })),
        dispose: vi.fn<DirectAccountService['dispose']>(async () => {}),
    };
    return service;
}

async function start(service = serviceFixture()) {
    server = await initWebUI(5099, {} as OneBotManager, undefined, undefined, {
        directService: service,
    });
    return service;
}

async function beginQr(token: string) {
    const response = await request('/api/direct/accounts/main/start', {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify(START),
    });
    expect(response.status).toBe(202);
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

describe('direct routes behind real WebUI authentication', () => {
    it('retains existing login/header precedence, and never grants query/cookie/proxy-only credentials', async () => {
        const service = await start();

        for (const route of [
            '/api/direct',
            '/api/direct/accounts',
            '/api/direct/accounts/main',
            `/api/direct/operations/${ID}`,
            `/api/direct/operations/${ID}/qr`,
        ]) {
            await expectFailure(await request(route), 'scope-expired');
        }

        for (const route of [
            '/api/direct/accounts/main/start',
            '/api/direct/accounts/main/stop',
            '/api/direct/accounts/main/renew',
            `/api/direct/operations/${ID}/cancel`,
        ]) {
            await expectFailure(
                await request(route, { method: 'POST', body: 'private unread body' }),
                'scope-expired',
            );
        }

        const token = await login();

        for (const denied of [
            { cookie: `snowluma_avatar_session=${token}` },
            { authorization: 'Basic cHJveHk6cGFzcw==' },
            { authorization: `Bearer ${token}`, 'X-SnowLuma-Token': '' },
            { authorization: `Bearer ${token}`, 'X-SnowLuma-Token': 'wrong-token' },
        ]) {
            await expectFailure(
                await request('/api/direct/accounts', { headers: denied }),
                'scope-expired',
            );
        }

        await expectFailure(
            await request(`/api/direct/operations/${ID}/qr?token=${token}`),
            'scope-expired',
        );
        expect(service.list).not.toHaveBeenCalled();
        expect(service.start).not.toHaveBeenCalled();
        expect(service.qr).not.toHaveBeenCalled();
        expect(
            (
                await request('/api/direct/accounts', {
                    headers: { authorization: `Bearer ${token}` },
                })
            ).status,
        ).toBe(200);
        expect(
            (
                await request('/api/direct/accounts', {
                    headers: { ...headers(token), authorization: 'Basic cHJveHk6cGFzcw==' },
                })
            ).status,
        ).toBe(200);
        const scopes = service.list.mock.calls.map(([scope]) => scope);
        expect(scopes[0]).not.toBe(scopes[1]);
        expect(scopes[0]!.owner).toBe(
            createHash('sha256').update('jiyu-webui-direct-scope\0').update(token).digest('hex'),
        );
        expect(scopes[0]!.owner).toBe(scopes[1]!.owner);
        expect(JSON.stringify(scopes)).not.toContain(token);
        expect(Object.keys(scopes[0]!).sort()).toEqual(['expiresAt', 'isCurrent', 'owner']);
        expect(scopes[0]!.isCurrent()).toBe(true);
        expect(network).not.toHaveBeenCalled();
    });

    it('uses the real consent gate before direct effects and unlocks through existing consent API', async () => {
        vi.stubEnv('SNOWLUMA_ACCEPT_EULA', '0');
        vi.stubEnv('SNOWLUMA_ACCEPT_PRIVACY', '0');
        const service = await start();
        const token = await login();
        await expectFailure(
            await request('/api/direct/accounts', { headers: headers(token) }),
            'consent-required',
        );
        await expectFailure(
            await request('/api/direct/accounts/main/start', {
                method: 'POST',
                headers: headers(token),
                body: JSON.stringify(START),
            }),
            'consent-required',
        );
        expect(service.start).not.toHaveBeenCalled();
        const agreements = (await (
            await request('/api/agreements', { headers: headers(token) })
        ).json()) as { version: string; consentRequired: boolean };
        expect(agreements.consentRequired).toBe(true);
        const consent = await request('/api/agreements/record-consent', {
            method: 'POST',
            headers: headers(token),
            body: JSON.stringify({ version: agreements.version }),
        });
        expect(consent.status).toBe(200);
        await beginQr(token);
        expect(service.start).toHaveBeenCalledOnce();
        expect(network).not.toHaveBeenCalled();
    });

    it('retains the real forced-password gate and invalidates scopes on password rotation', async () => {
        vi.stubEnv('SNOWLUMA_DEV_MODE', '0');
        const initial = vi.spyOn(WebuiAuth.prototype, 'takeInitialPassword');
        const service = await start();
        const password = initial.mock.results[0]?.value;
        expect(typeof password).toBe('string');
        const token = await login(password as string);
        await expectFailure(
            await request('/api/direct/accounts', { headers: headers(token) }),
            'password-change-required',
        );
        expect(service.list).not.toHaveBeenCalled();
        const changed = await request('/api/auth/change-password', {
            method: 'POST',
            headers: headers(token),
            body: JSON.stringify({ oldPassword: password, newPassword: 'Fixture-Password-A!' }),
        });
        expect(changed.status).toBe(200);
        await expectFailure(
            await request('/api/direct/accounts', { headers: headers(token) }),
            'scope-expired',
        );
        const nextToken = await login('Fixture-Password-A!');
        expect(
            (await request('/api/direct/accounts', { headers: headers(nextToken) })).status,
        ).toBe(200);
        const scope = service.list.mock.calls[0]![0];
        const rotated = await request('/api/auth/change-password', {
            method: 'POST',
            headers: headers(nextToken),
            body: JSON.stringify({
                oldPassword: 'Fixture-Password-A!',
                newPassword: 'Fixture-Password-B!',
            }),
        });
        expect(rotated.status).toBe(200);
        expect(scope.isCurrent()).toBe(false);
        expect(network).not.toHaveBeenCalled();
    });

    it('keeps operations owner-scoped and preserves the original cancel id', async () => {
        const service = await start();
        const first = await login();
        const second = await login();
        await beginQr(first);
        await expectFailure(
            await request(`/api/direct/operations/${ID}/qr`, { headers: headers(second) }),
            'operation-not-found',
        );
        expect(service.qr).not.toHaveBeenCalled();
        const qr = await request(`/api/direct/operations/${ID}/qr`, { headers: headers(first) });
        expect(qr.status).toBe(200);
        expect(new Uint8Array(await qr.arrayBuffer())).toEqual(PNG);
        const cancelled = await request(`/api/direct/operations/${ID}/cancel`, {
            method: 'POST',
            headers: headers(first),
            body: '{}',
        });
        expect(cancelled.status).toBe(202);
        expect(await cancelled.json()).toMatchObject({
            operation: { id: ID, status: 'cancelled' },
        });
        expect(network).not.toHaveBeenCalled();
    });

    it.each(['logout', 'expiry', 'shutdown'] as const)(
        'rechecks %s after awaiting QR bytes and never returns the old image',
        async (kind) => {
            const service = await start();
            const token = await login();
            await beginQr(token);
            const scope: DirectRequestScope = service.start.mock.calls[0]![2];
            let release!: (value: Awaited<ReturnType<DirectAccountService['qr']>>) => void;
            let entered!: () => void;
            const reading = new Promise<void>((resolve) => {
                entered = resolve;
            });
            service.qr.mockImplementationOnce(() => {
                entered();
                return new Promise((resolve) => {
                    release = resolve;
                });
            });
            const pending = request(`/api/direct/operations/${ID}/qr`, { headers: headers(token) });
            await reading;

            if (kind === 'logout') {
                expect(
                    (await request('/api/logout', { method: 'POST', headers: headers(token) }))
                        .status,
                ).toBe(200);
            } else if (kind === 'expiry') {
                vi.spyOn(Date, 'now').mockReturnValue(scope.expiresAt);
            } else {
                await server!.stop();
                server = undefined;
            }

            expect(scope.isCurrent()).toBe(false);
            const owned = new Uint8Array(PNG);
            release({ bytes: owned, contentType: 'image/png' });
            await expectFailure(await pending, 'scope-expired');
            expect(owned.every((byte) => byte === 0)).toBe(true);
            expect(service.dispose).not.toHaveBeenCalled();
            expect(network).not.toHaveBeenCalled();
        },
    );

    it('applies CSRF/body guards after auth, emits fixed errors and excludes direct requests from raw TRACE', async () => {
        const service = await start();
        const token = await login();
        const level = getLogLevel();
        const entries: LogEntry[] = [];
        setLogLevel('trace');
        const unsubscribe = subscribeLogs((entry) => entries.push(entry));

        try {
            await expectFailure(
                await request('/api/direct/accounts/main/start', {
                    method: 'POST',
                    headers: {
                        ...headers(token),
                        origin: 'https://evil.example',
                        'x-forwarded-host': 'evil.example',
                    },
                    body: JSON.stringify(START),
                }),
                'cross-origin',
            );
            await expectFailure(
                await request('/api/direct/accounts/main/start', {
                    method: 'POST',
                    headers: headers(token),
                    body: 'x'.repeat(16385),
                }),
                'body-too-large',
            );
            await expectFailure(
                await request('/api/direct/accounts/main/start', {
                    method: 'POST',
                    headers: headers(token),
                    body: '{',
                }),
                'invalid-request',
            );
            expect(service.start).not.toHaveBeenCalled();
            service.list.mockImplementationOnce(() => {
                throw new Error('/private/account/vault secret-ticket marker');
            });
            await expectFailure(
                await request('/api/direct/accounts', { headers: headers(token) }),
                'internal-error',
            );
            await beginQr(token);
            expect(entries.filter((entry) => entry.scope === 'WebUI.Mutation')).toEqual([]);
            expect(JSON.stringify(entries)).not.toContain(token);
            expect(JSON.stringify(entries)).not.toContain('secret-ticket');
            expect(network).not.toHaveBeenCalled();
        } finally {
            unsubscribe();
            setLogLevel(level);
        }
    });

    it('keeps default/unconfigured and non-Linux server startup inert', async () => {
        server = await initWebUI(5099, {} as OneBotManager);
        const token = await login();
        expect(
            await (await request('/api/direct/accounts', { headers: headers(token) })).json(),
        ).toEqual({ supported: true, configured: false, reason: 'not-configured', accounts: [] });
        await server.stop();
        server = undefined;
        Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
        const service = await start();
        const next = await login();
        expect(
            await (await request('/api/direct/accounts', { headers: headers(next) })).json(),
        ).toEqual({
            supported: false,
            configured: true,
            reason: 'unsupported-platform',
            accounts: [],
        });
        await expectFailure(
            await request('/api/direct/accounts/main/start', {
                method: 'POST',
                headers: headers(next),
                body: JSON.stringify(START),
            }),
            'unsupported-platform',
        );
        expect(service.list).not.toHaveBeenCalled();
        expect(service.start).not.toHaveBeenCalled();
        expect(network).not.toHaveBeenCalled();
    });
});
