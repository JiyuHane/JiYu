import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { OneBotManager } from '@snowluma/onebot/manager';
import { LocalPluginCatalogError, type LocalPluginCatalog } from '../src/webui/plugin-local';
import { registerLocalPluginRoutes } from '../src/webui/plugin-routes';

const GENERATION_A = '11111111-1111-4111-8111-111111111111';
const GENERATION_B = '22222222-2222-4222-8222-222222222222';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function fixture() {
    let current: unknown;
    const status = {
        id: 'fixture',
        state: 'active',
        cleanupFailed: false,
        initializationFailed: false,
        pendingActions: 0,
        processResources: 'unknown',
    } as const;
    let active = false;
    const instance = {
        canEnablePlugins: vi.fn(() => true),
        listPlugins: vi.fn(() => (active ? [status] : [])),
        getPluginStatus: vi.fn((id: string) => (active && id === 'fixture' ? status : null)),
        enablePlugin: vi.fn(async () => {
            active = true;
        }),
        disablePlugin: vi.fn(async (_id: string) => {
            active = false;
        }),
        getPluginConfigGeneration: vi.fn((_id: string) => GENERATION_A as string | null),
        getPluginConfigSchema: vi.fn(async (_id: string) => ({
            fields: [],
            source: 'schema' as const,
        })),
        getPluginConfig: vi.fn(async (_id: string) => ({
            value: { enabled: true },
            source: 'plugin' as const,
        })),
        setPluginConfig: vi.fn(async (_id: string, _value: unknown) => ({
            persistence: 'plugin-managed' as const,
        })),
    };
    current = instance;
    const manager = {
        getInstance: vi.fn((uin: string) => (uin === '10001' ? current : null)),
    } as unknown as Pick<OneBotManager, 'getInstance'>;
    const catalog = {
        list: vi.fn(async () => ['fixture']),
        resolve: vi.fn(async () => '/private/plugin-packages/fixture'),
    } satisfies LocalPluginCatalog;
    const app = new Hono();
    app.use('/api/*', async (c, next) => {
        if (c.req.header('authorization') !== 'Bearer test-session') {
            return c.json({ status: 'failed' }, 401);
        }

        return next();
    });
    registerLocalPluginRoutes(app, manager, catalog);
    const request = (url: string, method = 'GET', authenticated = true) =>
        app.request(`http://localhost${url}`, {
            method,
            headers: authenticated
                ? { authorization: 'Bearer test-session', 'x-jiyu-plugin-generation': GENERATION_A }
                : {},
        });
    const configRequest = (action: string, init: RequestInit = {}) =>
        app.request(`http://localhost/api/plugins/local/10001/fixture/config/${action}`, {
            ...init,
            method: init.method ?? 'POST',
            headers: {
                authorization: 'Bearer test-session',
                'x-jiyu-plugin-generation': GENERATION_A,
                ...init.headers,
            },
        });
    return {
        request,
        configRequest,
        app,
        catalog,
        instance,
        setCurrent: (value: unknown) => (current = value),
    };
}

describe('authenticated local plugin management routes', () => {
    it('lists candidates separately from account runtime and does nothing before authentication', async () => {
        const { request, catalog, instance } = fixture();
        expect((await request('/api/plugins/local/10001', 'GET', false)).status).toBe(401);
        expect(
            (await request('/api/plugins/local/10001/fixture/enable', 'POST', false)).status,
        ).toBe(401);
        expect(catalog.list).not.toHaveBeenCalled();
        expect(catalog.resolve).not.toHaveBeenCalled();
        expect(instance.enablePlugin).not.toHaveBeenCalled();

        const response = await request('/api/plugins/local/10001');
        expect(await response.json()).toEqual({
            status: 'ok',
            accountOnline: true,
            candidates: ['fixture'],
            runtime: [],
            actions: [
                {
                    id: 'fixture',
                    canEnable: true,
                    canDisable: false,
                    enableReason: null,
                    disableReason: 'NOT_LOADED',
                },
            ],
            pendingOperations: [],
            processResources: 'unknown',
        });
        const offline = await request('/api/plugins/local/10002');
        expect(await offline.json()).toMatchObject({ accountOnline: false, runtime: null });
    });

    it('only enables the catalog-selected directory, preserves runtime status, and disables explicitly', async () => {
        const { request, catalog, instance } = fixture();
        const enabled = await request('/api/plugins/local/10001/fixture/enable', 'POST');
        expect(enabled.status).toBe(200);
        const body = await enabled.text();
        expect(body).not.toContain('/private/');
        expect(JSON.parse(body)).toMatchObject({
            status: 'ok',
            operation: 'enable',
            runtime: { id: 'fixture', state: 'active' },
            processResources: 'unknown',
        });
        expect(catalog.resolve).toHaveBeenCalledWith('fixture');
        expect(instance.enablePlugin).toHaveBeenCalledWith(
            'fixture',
            '/private/plugin-packages/fixture',
        );
        expect((await request('/api/plugins/local/10001/fixture/enable', 'POST')).status).toBe(409);
        const disabled = await request('/api/plugins/local/10001/fixture/disable', 'POST');
        expect(await disabled.json()).toMatchObject({
            status: 'ok',
            operation: 'disable',
            runtime: null,
            processResources: 'unknown',
        });
        expect(instance.disablePlugin).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid selections and distinguishes an offline account from empty runtime', async () => {
        const { request, catalog, instance } = fixture();
        expect((await request('/api/plugins/local/123/fixture/enable', 'POST')).status).toBe(400);
        expect((await request('/api/plugins/local/10001/CON/enable', 'POST')).status).toBe(400);
        expect((await request('/api/plugins/local/10001/fixture/install', 'POST')).status).toBe(
            400,
        );
        expect((await request('/api/plugins/local/10002/fixture/enable', 'POST')).status).toBe(404);
        expect((await request('/api/plugins/local/10001/fixture/disable', 'POST')).status).toBe(
            409,
        );
        expect(catalog.resolve).not.toHaveBeenCalled();
        expect(instance.enablePlugin).not.toHaveBeenCalled();
    });

    it('makes catalog and plugin failures visible without leaking paths or claiming no side effects', async () => {
        const { request, catalog, instance } = fixture();
        catalog.list.mockRejectedValueOnce(new Error('PRIVATE_PATH'));
        const list = await request('/api/plugins/local/10001');
        expect(list.status).toBe(503);
        expect(await list.text()).not.toContain('PRIVATE_PATH');
        catalog.resolve.mockRejectedValueOnce(new LocalPluginCatalogError('not_found'));
        expect((await request('/api/plugins/local/10001/fixture/enable', 'POST')).status).toBe(404);
        instance.enablePlugin.mockRejectedValueOnce(new Error('PRIVATE_PLUGIN_ERROR'));
        const failed = await request('/api/plugins/local/10001/fixture/enable', 'POST');
        expect(failed.status).toBe(409);
        const body = await failed.text();
        expect(body).not.toContain('PRIVATE_PLUGIN_ERROR');
        expect(JSON.parse(body)).toMatchObject({
            status: 'failed',
            code: 'PLUGIN_ENABLE_FAILED',
            outcome: 'unknown',
            processResources: 'unknown',
        });
    });

    it('cancels a pending directory resolution before plugin execution', async () => {
        const { request, catalog, instance } = fixture();
        let release!: (value: string) => void;
        catalog.resolve.mockImplementationOnce(
            () => new Promise<string>((resolve) => (release = resolve)),
        );
        const enabling = request('/api/plugins/local/10001/fixture/enable', 'POST');
        await vi.waitFor(() => expect(catalog.resolve).toHaveBeenCalled());
        const during = await request('/api/plugins/local/10001');
        expect(await during.json()).toMatchObject({
            pendingOperations: [{ id: 'fixture', phase: 'resolving', cancelled: false }],
            actions: [{ id: 'fixture', canEnable: false, canDisable: true }],
        });
        const disabled = await request('/api/plugins/local/10001/fixture/disable', 'POST');
        expect(await disabled.json()).toMatchObject({
            status: 'ok',
            outcome: 'cancelled_before_execution',
            processResources: 'unknown',
        });
        const cancelled = await request('/api/plugins/local/10001');
        expect(await cancelled.json()).toMatchObject({
            pendingOperations: [{ id: 'fixture', phase: 'resolving', cancelled: true }],
            actions: [{ id: 'fixture', canEnable: false, canDisable: false }],
        });
        expect((await request('/api/plugins/local/10001/fixture/enable', 'POST')).status).toBe(409);
        release('/private/plugin-packages/fixture');
        expect(await (await enabling).json()).toMatchObject({ code: 'ENABLE_CANCELLED' });
        expect(instance.enablePlugin).not.toHaveBeenCalled();
    });

    it('bounds unresolved enable operations without treating cancellation as completion', async () => {
        const { request, catalog } = fixture();
        const releases: Array<(value: string) => void> = [];
        catalog.resolve.mockImplementation(
            () => new Promise<string>((resolve) => releases.push(resolve)),
        );
        const pending = Array.from({ length: 16 }, (_, index) =>
            request(`/api/plugins/local/10001/p${index}/enable`, 'POST'),
        );
        await vi.waitFor(() => expect(releases).toHaveLength(16));
        expect((await request('/api/plugins/local/10001/p16/enable', 'POST')).status).toBe(429);
        await request('/api/plugins/local/10001/p0/disable', 'POST');
        expect((await request('/api/plugins/local/10001/p16/enable', 'POST')).status).toBe(429);

        for (const release of releases) {
            release('/private/plugin-packages/fixture');
        }

        await Promise.all(pending);
    });

    it('delegates cancellation to the host after enable has been invoked', async () => {
        const { request, instance } = fixture();
        let release!: () => void;
        instance.enablePlugin.mockImplementationOnce(
            () => new Promise<void>((resolve) => (release = resolve)),
        );
        const enabling = request('/api/plugins/local/10001/fixture/enable', 'POST');
        await vi.waitFor(() => expect(instance.enablePlugin).toHaveBeenCalled());
        const disabled = await request('/api/plugins/local/10001/fixture/disable', 'POST');
        expect(disabled.status).toBe(200);
        expect(instance.disablePlugin).toHaveBeenCalledWith('fixture');
        release();
        await enabling;
    });

    it('reports an indeterminate outcome if the account instance changes during enable', async () => {
        const { request, instance, setCurrent } = fixture();
        instance.enablePlugin.mockImplementationOnce(async () => {
            setCurrent({});
        });
        const response = await request('/api/plugins/local/10001/fixture/enable', 'POST');
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
            status: 'failed',
            code: 'INSTANCE_CHANGED',
            outcome: 'unknown',
        });
    });
});

describe('explicit plugin configuration routes', () => {
    const base = '/api/plugins/local/10001/fixture';

    it('requires upper-layer authentication and only explicit POST executes a hook', async () => {
        const { app, request, configRequest, instance } = fixture();
        const unauth = await app.request(`http://localhost${base}/config/read`, { method: 'POST' });
        expect(unauth.status).toBe(401);
        await request('/api/plugins/local/10001');
        await configRequest('schema', { method: 'GET' });
        expect(instance.getPluginConfigSchema).not.toHaveBeenCalled();
        expect(instance.getPluginConfig).not.toHaveBeenCalled();
        const schema = await configRequest('schema');
        expect(schema.headers.get('cache-control')).toBe('no-store');
        expect(await schema.json()).toMatchObject({
            status: 'ok',
            fields: [],
            source: 'schema',
            generation: GENERATION_A,
            processResources: 'unknown',
        });
        const read = await configRequest('read');
        expect(await read.json()).toMatchObject({
            value: { enabled: true },
            source: 'plugin',
            generation: GENERATION_A,
        });
        const write = await configRequest('write', { body: '{"enabled":false}' });
        expect(await write.json()).toMatchObject({
            persistence: 'plugin-managed',
            generation: GENERATION_A,
        });
        expect(instance.setPluginConfig).toHaveBeenCalledExactlyOnceWith('fixture', {
            enabled: false,
        });
    });

    it('requires a valid generation header and never echoes malformed header data', async () => {
        const { app, instance } = fixture();

        for (const generation of [
            null,
            'PRIVATE-bad-token',
            '00000000-0000-0000-0000-000000000000',
        ]) {
            let cancelled = false;
            const headers = new Headers();
            headers.set('authorization', 'Bearer test-session');

            if (generation !== null) {
                headers.set('x-jiyu-plugin-generation', generation);
            }

            const body = new ReadableStream<Uint8Array>({
                cancel() {
                    cancelled = true;
                    return new Promise<void>(() => {});
                },
            });
            const req = new Request(`http://localhost${base}/config/write`, {
                method: 'POST',
                headers,
                body,
                duplex: 'half',
            } as RequestInit & { duplex: 'half' });
            const response = await app.request(req);
            const text = await response.text();
            expect(response.status).toBe(400);
            expect(JSON.parse(text)).toMatchObject({
                code: 'CONFIG_GENERATION_REQUIRED',
                outcome: 'not_started',
            });
            expect(text).not.toContain('PRIVATE');
            expect(cancelled).toBe(true);
        }

        expect(instance.setPluginConfig).not.toHaveBeenCalled();
        const read = await app.request(`http://localhost${base}/config/read`, {
            method: 'POST',
            headers: new Headers({ authorization: 'Bearer test-session' }),
        });
        expect(await read.json()).toMatchObject({
            code: 'CONFIG_GENERATION_REQUIRED',
            outcome: 'not_started',
        });
        expect(instance.getPluginConfig).not.toHaveBeenCalled();
        instance.getPluginConfigGeneration.mockReturnValue(null);
        const schema = await app.request(`http://localhost${base}/config/schema`, {
            method: 'POST',
            headers: new Headers({ authorization: 'Bearer test-session' }),
        });
        expect(await schema.json()).toMatchObject({
            code: 'PLUGIN_INACTIVE',
            outcome: 'not_started',
        });
        expect(instance.getPluginConfigSchema).not.toHaveBeenCalled();
    });

    it('rejects a stale draft after account replacement and on same-instance slot restart', async () => {
        const { configRequest, instance, setCurrent } = fixture();
        expect(await (await configRequest('schema')).json()).toMatchObject({
            generation: GENERATION_A,
        });
        const replacement = { ...instance, getPluginConfigGeneration: vi.fn(() => GENERATION_B) };
        setCurrent(replacement);
        expect(await (await configRequest('write', { body: '{"value":1}' })).json()).toMatchObject({
            code: 'CONFIG_GENERATION_CHANGED',
            outcome: 'not_started',
        });
        expect(instance.setPluginConfig).not.toHaveBeenCalled();
        expect(await (await configRequest('schema')).json()).toMatchObject({
            generation: GENERATION_B,
        });
        expect(
            (
                await configRequest('write', {
                    body: '{}',
                    headers: { 'x-jiyu-plugin-generation': GENERATION_B },
                })
            ).status,
        ).toBe(200);
        setCurrent(instance);
        instance.getPluginConfigGeneration.mockReturnValue(GENERATION_B);
        expect(await (await configRequest('read')).json()).toMatchObject({
            code: 'CONFIG_GENERATION_CHANGED',
            outcome: 'not_started',
        });
        expect(await (await configRequest('write', { body: '{}' })).json()).toMatchObject({
            code: 'CONFIG_GENERATION_CHANGED',
            outcome: 'not_started',
        });
        expect(
            (await configRequest('read', { headers: { 'x-jiyu-plugin-generation': GENERATION_B } }))
                .status,
        ).toBe(200);
    });

    it('rechecks instance and generation after a slow body before admitting a write', async () => {
        for (const change of ['instance', 'slot'] as const) {
            const { app, request, instance, setCurrent } = fixture();
            let controller!: ReadableStreamDefaultController<Uint8Array>;
            const body = new ReadableStream<Uint8Array>({
                start(c) {
                    controller = c;
                },
            });
            const req = new Request(`http://localhost${base}/config/write`, {
                method: 'POST',
                headers: {
                    authorization: 'Bearer test-session',
                    'x-jiyu-plugin-generation': GENERATION_A,
                },
                body,
                duplex: 'half',
            } as RequestInit & { duplex: 'half' });
            const pending = app.request(req);
            await vi.waitFor(async () =>
                expect(await (await request('/api/plugins/local/10001')).json()).toMatchObject({
                    pendingOperations: [{ id: 'fixture', phase: 'reading' }],
                }),
            );

            if (change === 'slot') {
                instance.getPluginConfigGeneration.mockReturnValue(GENERATION_B);
            } else {
                setCurrent({ ...instance, getPluginConfigGeneration: () => GENERATION_B });
            }

            controller.enqueue(new TextEncoder().encode('{}'));
            controller.close();
            expect(await (await pending).json()).toMatchObject({
                code: 'CONFIG_GENERATION_CHANGED',
                outcome: 'not_started',
            });
            expect(instance.setPluginConfig).not.toHaveBeenCalled();
        }
    });

    it('reports unknown and keeps the key until a stale schema or read promise settles', async () => {
        const { configRequest, instance } = fixture();
        const gate = deferred<{ fields: never[]; source: 'schema' }>();
        instance.getPluginConfigSchema.mockImplementationOnce(() => gate.promise);
        const pending = configRequest('schema');
        await vi.waitFor(() => expect(instance.getPluginConfigSchema).toHaveBeenCalledTimes(1));
        instance.getPluginConfigGeneration.mockReturnValue(GENERATION_B);
        expect(await (await configRequest('write', { body: '{}' })).json()).toMatchObject({
            code: 'OPERATION_PENDING',
            outcome: 'not_started',
        });
        gate.resolve({ fields: [], source: 'schema' });
        expect(await (await pending).json()).toMatchObject({
            code: 'CONFIG_OUTCOME_UNKNOWN',
            outcome: 'unknown',
        });
        instance.getPluginConfig.mockImplementationOnce(async () => {
            instance.getPluginConfigGeneration.mockReturnValue(null);
            return { value: { enabled: true }, source: 'plugin' };
        });
        const read = await configRequest('read', {
            headers: { 'x-jiyu-plugin-generation': GENERATION_B },
        });
        expect(await read.json()).toMatchObject({
            code: 'CONFIG_OUTCOME_UNKNOWN',
            outcome: 'unknown',
        });
    });

    it('rejects malformed, non-object, invalid UTF-8, overlarge and misdeclared bodies', async () => {
        const { configRequest, instance, app } = fixture();

        for (const body of ['{', 'null', '[]', '"secret-input"']) {
            const response = await configRequest('write', { body });
            expect(response.status).toBe(400);
            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(await response.text()).not.toContain('secret-input');
        }

        expect((await configRequest('write', { body: new Uint8Array([0xc3, 0x28]) })).status).toBe(
            400,
        );
        expect(
            (await configRequest('write', { body: '{}', headers: { 'content-length': '1' } }))
                .status,
        ).toBe(400);
        expect(
            (await configRequest('write', { body: '{}', headers: { 'content-length': '999999' } }))
                .status,
        ).toBe(413);
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(128 * 1024));
                controller.enqueue(new Uint8Array(128 * 1024 + 1));
            },
            cancel() {
                cancelled = true;
                return new Promise<void>(() => {});
            },
        });
        const req = new Request(`http://localhost${base}/config/write`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-session',
                'x-jiyu-plugin-generation': GENERATION_A,
                'content-length': '2',
            },
            body: stream,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });
        const oversized = await app.request(req);
        expect(oversized.status).toBe(413);
        expect(cancelled).toBe(true);
        expect(instance.setPluginConfig).not.toHaveBeenCalled();
    });

    it('cancels unconsumed streams on early rejection without awaiting cancellation', async () => {
        const { app, instance } = fixture();
        instance.getPluginConfig.mockImplementation(() => new Promise(() => {}));
        const headers = {
            authorization: 'Bearer test-session',
            'x-jiyu-plugin-generation': GENERATION_A,
        };

        const send = async (path: string, extra: Record<string, string> = {}, reject = false) => {
            let cancelled = false;
            const body = new ReadableStream<Uint8Array>({
                cancel() {
                    cancelled = true;
                    return reject
                        ? Promise.reject(new Error('private cancel error'))
                        : new Promise<void>(() => {});
                },
            });
            const req = new Request(`http://localhost${path}`, {
                method: 'POST',
                headers: { ...headers, ...extra },
                body,
                duplex: 'half',
            } as RequestInit & { duplex: 'half' });
            const response = await app.request(req);
            const text = await response.text();
            expect(cancelled).toBe(true);
            expect(text).not.toContain('private');
            return { response, body: JSON.parse(text) };
        };

        let result = await send(`${base}/config/write`, { 'content-length': 'invalid' });
        expect(result.response.status).toBe(400);
        expect(result.body).toMatchObject({ code: 'CONFIG_INVALID', outcome: 'not_started' });
        result = await send('/api/plugins/local/123/fixture/config/write', {}, true);
        expect(result.body).toMatchObject({ code: 'INVALID_SELECTION', outcome: 'not_started' });
        result = await send('/api/plugins/local/10002/fixture/config/write');
        expect(result.body).toMatchObject({ code: 'ACCOUNT_OFFLINE', outcome: 'not_started' });
        result = await send(`${base}/config/nope`);
        expect(result.body).toMatchObject({ code: 'INVALID_OPERATION', outcome: 'not_started' });

        for (let i = 0; i < 16; i++) {
            void app.request(`http://localhost/api/plugins/local/10001/p${i}/config/read`, {
                method: 'POST',
                headers,
            });
        }

        await vi.waitFor(() => expect(instance.getPluginConfig).toHaveBeenCalledTimes(16));
        result = await send('/api/plugins/local/10001/p0/config/write');
        expect(result.body).toMatchObject({ code: 'OPERATION_PENDING', outcome: 'not_started' });
        result = await send('/api/plugins/local/10001/extra/config/write');
        expect(result.body).toMatchObject({ code: 'CONFIG_QUEUE_FULL', outcome: 'not_started' });
        expect(instance.setPluginConfig).not.toHaveBeenCalled();
    });

    it('handles pre-locked and already-consumed request bodies without awaiting cancellation', async () => {
        const { app, instance } = fixture();
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel() {
                cancelled = true;
            },
        });
        const locked = new Request('http://localhost/api/plugins/local/123/fixture/config/write', {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-session',
                'x-jiyu-plugin-generation': GENERATION_A,
            },
            body,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });
        const reader = locked.body!.getReader();
        const rejected = await app.request(locked);
        expect(await rejected.json()).toMatchObject({
            code: 'INVALID_SELECTION',
            outcome: 'not_started',
        });
        expect(cancelled).toBe(false);
        reader.releaseLock();
        await locked.body!.cancel();
        const consumed = new Request(`http://localhost${base}/config/write`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-session',
                'x-jiyu-plugin-generation': GENERATION_A,
            },
            body: '{}',
        });
        await consumed.text();
        const invalid = await app.request(consumed);
        expect(await invalid.json()).toMatchObject({
            code: 'CONFIG_INVALID',
            outcome: 'not_started',
        });
        expect(instance.setPluginConfig).not.toHaveBeenCalled();
    });

    it('bounds zero-byte and tiny fragments without awaiting cancellation', async () => {
        const { app, instance } = fixture();
        let count = 0;
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                count++;
                controller.enqueue(count % 2 ? new Uint8Array(0) : new Uint8Array([32]));
            },
            cancel() {
                cancelled = true;
                return new Promise<void>(() => {});
            },
        });
        const req = new Request(`http://localhost${base}/config/write`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-session',
                'x-jiyu-plugin-generation': GENERATION_A,
            },
            body: stream,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });
        const response = await app.request(req);
        expect(response.status).toBe(413);
        expect(await response.json()).toMatchObject({
            code: 'CONFIG_INVALID',
            outcome: 'not_started',
        });
        expect(cancelled).toBe(true);
        expect(instance.setPluginConfig).not.toHaveBeenCalled();
    });

    it('returns only fixed errors and never retries after plugin failure', async () => {
        const { configRequest, instance } = fixture();
        instance.getPluginConfig.mockRejectedValueOnce(
            Object.assign(new Error('SECRET /private/path'), { code: 'EVIL_SECRET' }),
        );
        const response = await configRequest('read');
        const text = await response.text();
        expect(text).not.toContain('SECRET');
        expect(text).not.toContain('/private');
        expect(JSON.parse(text)).toMatchObject({
            code: 'CONFIG_OUTCOME_UNKNOWN',
            outcome: 'unknown',
        });
        expect(instance.getPluginConfig).toHaveBeenCalledTimes(1);
        const getter = vi.fn(() => 'CONFIG_INVALID');
        instance.getPluginConfig.mockRejectedValueOnce(
            Object.defineProperty({}, 'code', { get: getter }),
        );
        expect(await (await configRequest('read')).json()).toMatchObject({
            code: 'CONFIG_OUTCOME_UNKNOWN',
            outcome: 'unknown',
        });
        expect(getter).not.toHaveBeenCalled();
        instance.getPluginConfig.mockRejectedValueOnce({
            code: 'CONFIG_UNSUPPORTED',
            message: 'PRIVATE',
        });
        expect(await (await configRequest('read')).json()).toMatchObject({
            code: 'CONFIG_UNSUPPORTED',
            outcome: 'unknown',
        });
    });

    it('blocks config during enable preflight and across instance replacement until settled', async () => {
        const { request, configRequest, catalog, instance, setCurrent } = fixture();
        let release!: (value: string) => void;
        catalog.resolve.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const enable = request(`${base}/enable`, 'POST');
        await vi.waitFor(() => expect(catalog.resolve).toHaveBeenCalled());
        expect(await (await configRequest('read')).json()).toMatchObject({
            code: 'OPERATION_PENDING',
            outcome: 'not_started',
        });
        setCurrent({ ...instance });
        expect(await (await configRequest('schema')).json()).toMatchObject({
            code: 'OPERATION_PENDING',
        });
        release('/private/plugin-packages/fixture');
        await enable;
        expect(instance.getPluginConfig).not.toHaveBeenCalled();
    });

    it('retains a disconnected old-generation hook until settlement, then unlocks', async () => {
        const { configRequest, instance, setCurrent, request } = fixture();
        let finish!: (value: { value: { enabled: boolean }; source: 'plugin' }) => void;
        instance.getPluginConfig.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const abort = new AbortController();
        const pending = configRequest('read', { signal: abort.signal });
        await vi.waitFor(() => expect(instance.getPluginConfig).toHaveBeenCalledTimes(1));
        abort.abort();
        const replacement = {
            ...instance,
            getPluginStatus: vi.fn(() => null),
            listPlugins: vi.fn(() => []),
        };
        setCurrent(replacement);
        expect(await (await configRequest('write', { body: '{}' })).json()).toMatchObject({
            code: 'OPERATION_PENDING',
            outcome: 'not_started',
        });
        expect((await request(`${base}/enable`, 'POST')).status).toBe(409);
        const state = (await (await request('/api/plugins/local/10001')).json()) as {
            pendingOperations: unknown[];
        };
        expect(state.pendingOperations).toContainEqual({
            id: 'fixture',
            operation: 'config-read',
            phase: 'invoked',
            cancelled: false,
            currentInstance: false,
        });
        finish({ value: { enabled: true }, source: 'plugin' });
        expect(await (await pending).json()).toMatchObject({
            code: 'CONFIG_OUTCOME_UNKNOWN',
            outcome: 'unknown',
        });
        expect((await configRequest('schema')).status).toBe(200);
    });

    it('keeps disable admission closed while it drains a config hook', async () => {
        const { request, configRequest, instance, setCurrent } = fixture();
        await request(`${base}/enable`, 'POST');
        let finishRead!: (value: { value: { enabled: boolean }; source: 'plugin' }) => void;
        let finishDisable!: () => void;
        instance.getPluginConfig.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishRead = resolve;
                }),
        );
        instance.disablePlugin.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishDisable = resolve;
                }),
        );
        const read = configRequest('read');
        await vi.waitFor(() => expect(instance.getPluginConfig).toHaveBeenCalled());
        const disable = request(`${base}/disable`, 'POST');
        await vi.waitFor(() => expect(instance.disablePlugin).toHaveBeenCalled());
        expect((await configRequest('schema')).status).toBe(409);
        finishRead({ value: { enabled: true }, source: 'plugin' });
        await read;
        const replacement = {
            ...instance,
            getPluginStatus: vi.fn(() => null),
            listPlugins: vi.fn(() => []),
        };
        setCurrent(replacement);
        expect((await request(`${base}/enable`, 'POST')).status).toBe(409);
        expect((await configRequest('read')).status).toBe(409);
        finishDisable();
        expect(await (await disable).json()).toMatchObject({
            code: 'INSTANCE_CHANGED',
            outcome: 'unknown',
        });
        expect((await configRequest('schema')).status).toBe(200);
    });

    it('cancels a still-reading write before hook invocation when disable starts', async () => {
        const { app, request, instance } = fixture();
        await request(`${base}/enable`, 'POST');
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
            cancel() {
                cancelled = true;
            },
        });
        const req = new Request(`http://localhost${base}/config/write`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-session',
                'x-jiyu-plugin-generation': GENERATION_A,
            },
            body: stream,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });
        const writing = app.request(req);
        await vi.waitFor(async () =>
            expect(
                (
                    (await (await request('/api/plugins/local/10001')).json()) as {
                        pendingOperations: unknown[];
                    }
                ).pendingOperations,
            ).toMatchObject([{ phase: 'reading' }]),
        );
        expect((await request(`${base}/disable`, 'POST')).status).toBe(200);
        expect(cancelled).toBe(true);
        expect(await (await writing).json()).toMatchObject({
            code: 'CONFIG_GENERATION_CHANGED',
            outcome: 'not_started',
        });
        expect(instance.setPluginConfig).not.toHaveBeenCalled();
    });

    it('actively cancels a stalled write when the same instance is disabled', async () => {
        const { app, request, instance } = fixture();
        await request(`${base}/enable`, 'POST');
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
            start(c) {
                controller = c;
            },
            cancel() {
                cancelled = true;
            },
        });
        const req = new Request(`http://localhost${base}/config/write`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-session',
                'x-jiyu-plugin-generation': GENERATION_A,
            },
            body: stream,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });
        const writing = app.request(req);
        await vi.waitFor(async () =>
            expect(await (await request('/api/plugins/local/10001')).json()).toMatchObject({
                pendingOperations: [{ id: 'fixture', phase: 'reading', cancelled: false }],
            }),
        );
        expect((await request(`${base}/disable`, 'POST')).status).toBe(200);
        const observed = await Promise.race([
            writing.then(() => 'settled' as const),
            new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
        ]);
        const state = await (await request('/api/plugins/local/10001')).json();
        const cancelledBeforeCleanup = cancelled;

        if (!cancelled) {
            controller.close();
        }

        const response = await writing;
        expect(await response.json()).toMatchObject({ outcome: 'not_started' });
        expect(instance.setPluginConfig).not.toHaveBeenCalled();
        expect({ observed, cancelled: cancelledBeforeCleanup, state }).toMatchObject({
            observed: 'settled',
            cancelled: true,
            state: { pendingOperations: [] },
        });
    });

    it('rejects an inactive plugin generation before waiting for its request body', async () => {
        const { app, request, instance } = fixture();
        instance.getPluginConfigGeneration.mockImplementation((id) =>
            id.startsWith('missing') ? null : GENERATION_A,
        );
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
            start(c) {
                controller = c;
            },
            cancel() {
                cancelled = true;
            },
        });
        const req = new Request('http://localhost/api/plugins/local/10001/missing/config/write', {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-session',
                'x-jiyu-plugin-generation': GENERATION_A,
            },
            body: stream,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });
        const writing = app.request(req);
        const observed = await Promise.race([
            writing.then(() => 'settled' as const),
            new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
        ]);
        const extraControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
        const extraCancelled = Array<boolean>(15).fill(false);
        const extraWrites = Array.from({ length: 15 }, (_, index) => {
            const body = new ReadableStream<Uint8Array>({
                start(c) {
                    extraControllers[index] = c;
                },
                cancel() {
                    extraCancelled[index] = true;
                },
            });
            return app.request(
                new Request(
                    `http://localhost/api/plugins/local/10001/missing${index}/config/write`,
                    {
                        method: 'POST',
                        headers: {
                            authorization: 'Bearer test-session',
                            'x-jiyu-plugin-generation': GENERATION_A,
                        },
                        body,
                        duplex: 'half',
                    } as RequestInit & { duplex: 'half' },
                ),
            );
        });
        const state = await (await request('/api/plugins/local/10001')).json();
        const quotaResponse = await app.request(`http://localhost${base}/config/write`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-session',
                'x-jiyu-plugin-generation': GENERATION_A,
            },
            body: '{}',
        });
        const quotaStatus = quotaResponse.status;
        const cancelledBeforeCleanup = cancelled;

        if (!cancelled) {
            controller.close();
        }

        for (let i = 0; i < extraControllers.length; i++) {
            if (!extraCancelled[i]) {
                extraControllers[i].close();
            }
        }

        const response = await writing;
        await Promise.all(extraWrites);
        expect(await response.json()).toMatchObject({ outcome: 'not_started' });
        expect({ observed, cancelled: cancelledBeforeCleanup, state, quotaStatus }).toMatchObject({
            observed: 'settled',
            cancelled: true,
            state: { pendingOperations: [] },
            quotaStatus: 200,
        });
    });

    it('keeps reservation ownership across a reentrant generation check and replacement', async () => {
        const { app, request, configRequest, instance, setCurrent } = fixture();
        await request(`${base}/enable`, 'POST');
        let nested!: Promise<Response>;
        let disabling!: Promise<Response>;
        let cancelled = false;
        instance.getPluginConfigGeneration.mockImplementationOnce(() => {
            nested = configRequest('write', { body: '{}' });
            disabling = request(`${base}/disable`, 'POST');
            return GENERATION_A;
        });
        const writing = app.request(
            new Request(`http://localhost${base}/config/write`, {
                method: 'POST',
                headers: {
                    authorization: 'Bearer test-session',
                    'x-jiyu-plugin-generation': GENERATION_A,
                },
                body: new ReadableStream<Uint8Array>({
                    cancel() {
                        cancelled = true;
                    },
                }),
                duplex: 'half',
            } as RequestInit & { duplex: 'half' }),
        );
        expect(await (await nested).json()).toMatchObject({
            code: 'OPERATION_PENDING',
            outcome: 'not_started',
        });
        expect((await disabling).status).toBe(200);
        expect(await (await writing).json()).toMatchObject({
            code: 'CONFIG_GENERATION_CHANGED',
            outcome: 'not_started',
        });
        expect(cancelled).toBe(true);
        expect(instance.setPluginConfig).not.toHaveBeenCalled();

        const gate = deferred<{ value: { enabled: boolean }; source: 'plugin' }>();
        const replacement = {
            ...instance,
            getPluginConfig: vi.fn(() => gate.promise),
        };
        setCurrent(replacement);
        const read = configRequest('read');
        await vi.waitFor(() => expect(replacement.getPluginConfig).toHaveBeenCalledOnce());
        expect(await (await request('/api/plugins/local/10001')).json()).toMatchObject({
            pendingOperations: [
                {
                    id: 'fixture',
                    operation: 'config-read',
                    phase: 'invoked',
                    currentInstance: true,
                },
            ],
        });
        expect(await (await configRequest('write', { body: '{}' })).json()).toMatchObject({
            code: 'OPERATION_PENDING',
            outcome: 'not_started',
        });
        gate.resolve({ value: { enabled: true }, source: 'plugin' });
        expect((await read).status).toBe(200);
    });

    it('rechecks final generation getter reentrancy after releasing the reader', async () => {
        for (const change of ['disable', 'instance', 'abort'] as const) {
            const { app, request, instance, setCurrent } = fixture();
            await request(`${base}/enable`, 'POST');
            const abort = new AbortController();
            let disabled: Promise<Response> | undefined;
            let cancelled = false;
            instance.getPluginConfigGeneration
                .mockReturnValueOnce(GENERATION_A)
                .mockImplementationOnce(() => {
                    if (change === 'disable') {
                        disabled = request(`${base}/disable`, 'POST');
                    } else if (change === 'instance') {
                        setCurrent({ ...instance });
                    } else {
                        abort.abort();
                    }

                    return GENERATION_A;
                });
            const response = await app.request(
                new Request(`http://localhost${base}/config/write`, {
                    method: 'POST',
                    headers: {
                        authorization: 'Bearer test-session',
                        'x-jiyu-plugin-generation': GENERATION_A,
                    },
                    body: new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode('{}'));
                            controller.close();
                        },
                        cancel() {
                            cancelled = true;
                        },
                    }),
                    signal: abort.signal,
                    duplex: 'half',
                } as RequestInit & { duplex: 'half' }),
            );
            expect(await response.json()).toMatchObject({
                code: change === 'abort' ? 'OPERATION_CANCELLED' : 'CONFIG_GENERATION_CHANGED',
                outcome: 'not_started',
            });

            if (disabled) {
                expect((await disabled).status).toBe(200);
            }

            expect(cancelled).toBe(false);
            expect(instance.setPluginConfig).not.toHaveBeenCalled();
            expect(await (await request('/api/plugins/local/10001')).json()).toMatchObject({
                pendingOperations: [],
            });
        }
    });

    it('rechecks ownership after the final canEnablePlugins observation reenters', async () => {
        for (const change of ['disable', 'instance', 'abort'] as const) {
            const { app, request, instance, setCurrent } = fixture();
            await request(`${base}/enable`, 'POST');
            const abort = new AbortController();
            let disabled: Promise<Response> | undefined;
            instance.getPluginConfigGeneration
                .mockReturnValueOnce(GENERATION_A)
                .mockImplementationOnce(() => {
                    instance.canEnablePlugins.mockImplementationOnce(() => {
                        if (change === 'disable') {
                            disabled = request(`${base}/disable`, 'POST');
                        } else if (change === 'instance') {
                            setCurrent({ ...instance });
                        } else {
                            abort.abort();
                        }

                        return true;
                    });
                    return GENERATION_A;
                });
            const response = await app.request(
                new Request(`http://localhost${base}/config/write`, {
                    method: 'POST',
                    headers: {
                        authorization: 'Bearer test-session',
                        'x-jiyu-plugin-generation': GENERATION_A,
                    },
                    body: '{}',
                    signal: abort.signal,
                }),
            );
            expect(await response.json()).toMatchObject({
                code: change === 'abort' ? 'OPERATION_CANCELLED' : 'CONFIG_GENERATION_CHANGED',
                outcome: 'not_started',
            });

            if (disabled) {
                expect((await disabled).status).toBe(200);
            }

            expect(instance.setPluginConfig).not.toHaveBeenCalled();
        }
    });

    it('checks write generation before malformed and oversized bodies', async () => {
        const { configRequest, instance } = fixture();
        instance.getPluginConfigGeneration.mockReturnValue(null);

        for (const init of [
            { body: '{' },
            { body: '{}', headers: { 'content-length': '999999' } },
        ]) {
            const response = await configRequest('write', init);
            expect(response.status).toBe(409);
            expect(await response.json()).toMatchObject({
                code: 'CONFIG_GENERATION_CHANGED',
                outcome: 'not_started',
            });
        }

        expect(instance.setPluginConfig).not.toHaveBeenCalled();
    });

    it('accounts for a cancelled reader until cancellation succeeds, including rejection', async () => {
        for (const outcome of ['resolve', 'reject'] as const) {
            const { app, request, instance } = fixture();
            await request(`${base}/enable`, 'POST');
            let finishCancel!: () => void;
            let failCancel!: (error: Error) => void;
            let calls = 0;
            const cancellation = new Promise<void>((resolve, reject) => {
                finishCancel = resolve;
                failCancel = reject;
            });
            const stream = new ReadableStream<Uint8Array>({
                cancel() {
                    calls++;
                    return cancellation;
                },
            });
            const abort = new AbortController();
            const writing = app.request(
                new Request(`http://localhost${base}/config/write`, {
                    method: 'POST',
                    headers: {
                        authorization: 'Bearer test-session',
                        'x-jiyu-plugin-generation': GENERATION_A,
                    },
                    body: stream,
                    signal: abort.signal,
                    duplex: 'half',
                } as RequestInit & { duplex: 'half' }),
            );
            await vi.waitFor(async () =>
                expect(await (await request('/api/plugins/local/10001')).json()).toMatchObject({
                    pendingOperations: [{ id: 'fixture', phase: 'reading' }],
                }),
            );
            abort.abort();
            expect(await (await writing).json()).toMatchObject({
                code: 'OPERATION_CANCELLED',
                outcome: 'not_started',
            });
            expect((await request(`${base}/disable`, 'POST')).status).toBe(200);
            expect(calls).toBe(1);
            expect((await request(`${base}/enable`, 'POST')).status).toBe(409);
            expect(await (await request('/api/plugins/local/10001')).json()).toMatchObject({
                pendingOperations: [
                    {
                        id: 'fixture',
                        phase: 'reading',
                        cancelled: true,
                        cleanup: 'cleanup_uncertain',
                    },
                ],
            });
            expect(instance.setPluginConfig).not.toHaveBeenCalled();

            if (outcome === 'resolve') {
                finishCancel();
                await vi.waitFor(async () =>
                    expect(await (await request('/api/plugins/local/10001')).json()).toMatchObject({
                        pendingOperations: [],
                    }),
                );
                expect((await request(`${base}/enable`, 'POST')).status).toBe(200);
            } else {
                failCancel(new Error('PRIVATE_CANCEL_ERROR'));
                await Promise.resolve();
                await Promise.resolve();
                const state = await (await request('/api/plugins/local/10001')).text();
                expect(state).not.toContain('PRIVATE_CANCEL_ERROR');
                expect(JSON.parse(state)).toMatchObject({
                    pendingOperations: [{ id: 'fixture', cleanup: 'cleanup_uncertain' }],
                });
                expect((await request(`${base}/enable`, 'POST')).status).toBe(409);
            }
        }
    });

    it('accounts for cancellation after an invalid chunk while the stream is still open', async () => {
        for (const outcome of ['resolve', 'reject'] as const) {
            const { app, request, instance } = fixture();
            let resolveCancel!: () => void;
            let rejectCancel!: (error: Error) => void;
            let cancelCalls = 0;
            const cancellation = new Promise<void>((resolve, reject) => {
                resolveCancel = resolve;
                rejectCancel = reject;
            });
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(null as unknown as Uint8Array);
                },
                cancel() {
                    cancelCalls++;
                    return cancellation;
                },
            });
            const response = await app.request(
                new Request(`http://localhost${base}/config/write`, {
                    method: 'POST',
                    headers: {
                        authorization: 'Bearer test-session',
                        'x-jiyu-plugin-generation': GENERATION_A,
                    },
                    body,
                    duplex: 'half',
                } as RequestInit & { duplex: 'half' }),
            );
            const text = await response.text();
            const stateBeforeSettlement = await (await request('/api/plugins/local/10001')).json();
            const blocked = await request(`${base}/enable`, 'POST');

            if (outcome === 'resolve') {
                resolveCancel();
            } else {
                rejectCancel(new Error('PRIVATE_INVALID_CHUNK_CANCEL'));
            }

            // Avoid an unhandled rejection in the pre-fix regression run.
            await cancellation.catch(() => {});
            expect(text).not.toContain('PRIVATE_INVALID_CHUNK_CANCEL');
            expect(JSON.parse(text)).toMatchObject({
                code: 'CONFIG_INVALID',
                outcome: 'not_started',
            });
            expect(cancelCalls).toBe(1);
            expect(blocked.status).toBe(409);
            expect(stateBeforeSettlement).toMatchObject({
                pendingOperations: [{ id: 'fixture', cleanup: 'cleanup_uncertain' }],
            });
            expect(instance.setPluginConfig).not.toHaveBeenCalled();

            if (outcome === 'resolve') {
                await vi.waitFor(async () =>
                    expect(await (await request('/api/plugins/local/10001')).json()).toMatchObject({
                        pendingOperations: [],
                    }),
                );
            } else {
                const state = await (await request('/api/plugins/local/10001')).text();
                expect(state).not.toContain('PRIVATE_INVALID_CHUNK_CANCEL');
                expect(JSON.parse(state)).toMatchObject({
                    pendingOperations: [{ id: 'fixture', cleanup: 'cleanup_uncertain' }],
                });
            }
        }
    });

    it('does not cancel a reader after done when JSON or UTF-8 decoding fails', async () => {
        for (const bytes of [new TextEncoder().encode('{'), new Uint8Array([0xc3, 0x28])]) {
            const { app, request, instance } = fixture();
            let cancelCalls = 0;
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(bytes);
                    controller.close();
                },
            });
            const req = new Request(`http://localhost${base}/config/write`, {
                method: 'POST',
                headers: {
                    authorization: 'Bearer test-session',
                    'x-jiyu-plugin-generation': GENERATION_A,
                },
                body,
                duplex: 'half',
            } as RequestInit & { duplex: 'half' });
            const getReader = req.body!.getReader.bind(req.body);
            Object.defineProperty(req.body!, 'getReader', {
                value: () => {
                    const reader = getReader();
                    const cancel = reader.cancel.bind(reader);
                    Object.defineProperty(reader, 'cancel', {
                        value: () => {
                            cancelCalls++;
                            return cancel();
                        },
                    });
                    return reader;
                },
            });
            const response = await app.request(req);
            expect(await response.json()).toMatchObject({
                code: 'CONFIG_INVALID',
                outcome: 'not_started',
            });
            expect(cancelCalls).toBe(0);
            expect(req.body?.locked).toBe(false);
            expect(instance.setPluginConfig).not.toHaveBeenCalled();
            expect(await (await request('/api/plugins/local/10001')).json()).toMatchObject({
                pendingOperations: [],
            });
        }
    });

    it('retains an oversized reader when its cancellation rejects', async () => {
        const { app, request, instance } = fixture();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(256 * 1024 + 1));
            },
            cancel() {
                return Promise.reject(new Error('PRIVATE_SIZE_CANCEL'));
            },
        });
        const response = await app.request(
            new Request(`http://localhost${base}/config/write`, {
                method: 'POST',
                headers: {
                    authorization: 'Bearer test-session',
                    'x-jiyu-plugin-generation': GENERATION_A,
                },
                body,
                duplex: 'half',
            } as RequestInit & { duplex: 'half' }),
        );
        expect(response.status).toBe(413);
        expect(await response.json()).toMatchObject({
            code: 'CONFIG_INVALID',
            outcome: 'not_started',
        });
        const state = await (await request('/api/plugins/local/10001')).text();
        expect(state).not.toContain('PRIVATE_SIZE_CANCEL');
        expect(JSON.parse(state)).toMatchObject({
            pendingOperations: [{ id: 'fixture', cleanup: 'cleanup_uncertain' }],
        });
        expect((await request(`${base}/enable`, 'POST')).status).toBe(409);
        expect(instance.setPluginConfig).not.toHaveBeenCalled();
    });

    it('retains cancelled reader keys against the account limit until cancellation succeeds', async () => {
        const { app, request, instance } = fixture();
        const releases: Array<() => void> = [];
        const writes: Promise<Response>[] = [];

        for (let i = 0; i < 16; i++) {
            const abort = new AbortController();
            const body = new ReadableStream<Uint8Array>({
                cancel() {
                    return new Promise<void>((resolve) => {
                        releases[i] = resolve;
                    });
                },
            });
            writes.push(
                app.request(
                    new Request(`http://localhost/api/plugins/local/10001/p${i}/config/write`, {
                        method: 'POST',
                        headers: {
                            authorization: 'Bearer test-session',
                            'x-jiyu-plugin-generation': GENERATION_A,
                        },
                        body,
                        signal: abort.signal,
                        duplex: 'half',
                    } as RequestInit & { duplex: 'half' }),
                ),
            );
            await vi.waitFor(async () => {
                const state = (await (await request('/api/plugins/local/10001')).json()) as {
                    pendingOperations: Array<{ id: string }>;
                };
                expect(state.pendingOperations.some((pending) => pending.id === `p${i}`)).toBe(
                    true,
                );
            });
            abort.abort();
        }

        await Promise.all(writes);
        const state = (await (await request('/api/plugins/local/10001')).json()) as {
            pendingOperations: Array<{ cleanup?: string }>;
        };
        expect(state.pendingOperations).toHaveLength(16);
        expect(
            state.pendingOperations.every((pending) => pending.cleanup === 'cleanup_uncertain'),
        ).toBe(true);
        const post = () =>
            app.request(`http://localhost${base}/config/write`, {
                method: 'POST',
                headers: {
                    authorization: 'Bearer test-session',
                    'x-jiyu-plugin-generation': GENERATION_A,
                },
                body: '{}',
            });
        expect((await post()).status).toBe(429);
        releases[0]();
        await vi.waitFor(async () => {
            const next = (await (await request('/api/plugins/local/10001')).json()) as {
                pendingOperations: unknown[];
            };
            expect(next.pendingOperations).toHaveLength(15);
        });
        expect((await post()).status).toBe(200);

        for (const release of releases.slice(1)) {
            release();
        }

        expect(instance.setPluginConfig).toHaveBeenCalledTimes(1);
    });

    it('reserves one disable owner before a stream cancel reenters disable', async () => {
        for (const replace of [false, true]) {
            const { app, request, instance, setCurrent } = fixture();
            await request(`${base}/enable`, 'POST');
            const gate = deferred<void>();
            instance.disablePlugin.mockImplementationOnce(() => gate.promise);
            let nested!: Promise<Response>;
            let cancellations = 0;
            const body = new ReadableStream<Uint8Array>({
                cancel() {
                    cancellations++;

                    if (replace) {
                        setCurrent({ ...instance });
                    }

                    nested = request(`${base}/disable`, 'POST');

                    if (replace) {
                        setCurrent(instance);
                    }
                },
            });
            const writing = app.request(
                new Request(`http://localhost${base}/config/write`, {
                    method: 'POST',
                    headers: {
                        authorization: 'Bearer test-session',
                        'x-jiyu-plugin-generation': GENERATION_A,
                    },
                    body,
                    duplex: 'half',
                } as RequestInit & { duplex: 'half' }),
            );
            await vi.waitFor(async () =>
                expect(await (await request('/api/plugins/local/10001')).json()).toMatchObject({
                    pendingOperations: [{ id: 'fixture', phase: 'reading' }],
                }),
            );
            const disabling = request(`${base}/disable`, 'POST');
            expect(await (await nested).json()).toMatchObject({
                code: replace ? 'OLD_INSTANCE_PENDING' : 'CLEANUP_IN_PROGRESS',
            });
            expect(await (await writing).json()).toMatchObject({ outcome: 'not_started' });
            expect(cancellations).toBe(1);
            expect(instance.disablePlugin).toHaveBeenCalledTimes(1);
            expect(await (await request(`${base}/disable`, 'POST')).json()).toMatchObject({
                code: 'CLEANUP_IN_PROGRESS',
            });
            expect(await (await request('/api/plugins/local/10001')).json()).toMatchObject({
                pendingOperations: [{ id: 'fixture', operation: 'disable', phase: 'draining' }],
            });
            gate.resolve();
            expect((await disabling).status).toBe(200);
        }
    });

    it('does not overwrite a hook admitted by a reentrant canEnablePlugins observation', async () => {
        const { configRequest, request, instance } = fixture();
        const gate = deferred<{ value: { enabled: boolean }; source: 'plugin' }>();
        instance.getPluginConfig.mockImplementationOnce(() => gate.promise);
        let nested!: Promise<Response>;
        instance.canEnablePlugins.mockImplementationOnce(() => {
            nested = configRequest('read');
            return true;
        });
        const outer = configRequest('write', { body: '{}' });
        expect(await (await outer).json()).toMatchObject({
            code: 'OPERATION_PENDING',
            outcome: 'not_started',
        });
        expect(instance.getPluginConfig).toHaveBeenCalledTimes(1);
        expect(instance.setPluginConfig).not.toHaveBeenCalled();
        expect(await (await configRequest('write', { body: '{}' })).json()).toMatchObject({
            code: 'OPERATION_PENDING',
            outcome: 'not_started',
        });
        expect(await (await request('/api/plugins/local/10001')).json()).toMatchObject({
            pendingOperations: [{ id: 'fixture', operation: 'config-read', phase: 'invoked' }],
        });
        gate.resolve({ value: { enabled: true }, source: 'plugin' });
        expect((await nested).status).toBe(200);
    });

    it('cancels an acquired reader if listener setup throws and tracks settlement', async () => {
        const { app, request, instance } = fixture();
        const gate = deferred<void>();
        let cancelled = 0;
        const body = new ReadableStream<Uint8Array>({
            cancel() {
                cancelled++;
                return gate.promise;
            },
        });
        const req = new Request(`http://localhost${base}/config/write`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-session',
                'x-jiyu-plugin-generation': GENERATION_A,
            },
            body,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });
        Object.defineProperty(req.signal, 'addEventListener', {
            value: () => {
                throw new Error('PRIVATE_SETUP');
            },
        });
        const response = await app.request(req);
        const text = await response.text();
        expect(text).not.toContain('PRIVATE_SETUP');
        expect(JSON.parse(text)).toMatchObject({ code: 'CONFIG_INVALID', outcome: 'not_started' });
        expect(cancelled).toBe(1);
        expect(req.body?.locked).toBe(false);
        expect(instance.setPluginConfig).not.toHaveBeenCalled();
        expect(await (await request('/api/plugins/local/10001')).json()).toMatchObject({
            pendingOperations: [{ id: 'fixture', cleanup: 'cleanup_uncertain' }],
        });
        gate.resolve();
        await vi.waitFor(async () =>
            expect(await (await request('/api/plugins/local/10001')).json()).toMatchObject({
                pendingOperations: [],
            }),
        );
    });

    it('releases the reader and retains uncertainty if listener removal throws', async () => {
        const { app, request, instance } = fixture();
        const req = new Request(`http://localhost${base}/config/write`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-session',
                'x-jiyu-plugin-generation': GENERATION_A,
            },
            body: '{}',
        });
        Object.defineProperty(req.signal, 'removeEventListener', {
            value: () => {
                throw new Error('PRIVATE_LISTENER_REMOVAL');
            },
        });
        const response = await app.request(req);
        const text = await response.text();
        expect(text).not.toContain('PRIVATE_LISTENER_REMOVAL');
        expect(JSON.parse(text)).toMatchObject({ code: 'CONFIG_INVALID', outcome: 'not_started' });
        expect(req.body?.locked).toBe(false);
        expect(instance.setPluginConfig).not.toHaveBeenCalled();
        expect(await (await request('/api/plugins/local/10001')).json()).toMatchObject({
            pendingOperations: [{ id: 'fixture', cleanup: 'cleanup_uncertain' }],
        });
    });

    it('retains cleanup failure after pending cancellation settles and preserves error precedence', async () => {
        const { app, request, instance } = fixture();
        const gate = deferred<void>();
        let cancelCalls = 0;
        let releaseCalls = 0;
        let realRelease!: () => void;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(256 * 1024 + 1));
            },
            cancel() {
                cancelCalls++;
                return gate.promise;
            },
        });
        const req = new Request(`http://localhost${base}/config/write`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-session',
                'x-jiyu-plugin-generation': GENERATION_A,
            },
            body,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });
        const getReader = req.body!.getReader.bind(req.body);
        Object.defineProperty(req.body!, 'getReader', {
            value: () => {
                const reader = getReader();
                realRelease = reader.releaseLock.bind(reader);
                Object.defineProperty(reader, 'releaseLock', {
                    value: () => {
                        releaseCalls++;
                        throw new Error('PRIVATE_RELEASE_AFTER_SIZE_ERROR');
                    },
                });
                return reader;
            },
        });
        const response = await app.request(req);
        const text = await response.text();
        expect(response.status).toBe(400);
        expect(text).not.toContain('PRIVATE_RELEASE_AFTER_SIZE_ERROR');
        expect(JSON.parse(text)).toMatchObject({ code: 'CONFIG_INVALID', outcome: 'not_started' });
        expect(cancelCalls).toBe(1);
        expect(releaseCalls).toBe(1);
        expect(instance.setPluginConfig).not.toHaveBeenCalled();
        expect(await (await request('/api/plugins/local/10001')).json()).toMatchObject({
            pendingOperations: [{ id: 'fixture', cleanup: 'cleanup_uncertain' }],
        });
        gate.resolve();
        await gate.promise;
        await Promise.resolve();
        expect(await (await request('/api/plugins/local/10001')).json()).toMatchObject({
            pendingOperations: [{ id: 'fixture', cleanup: 'cleanup_uncertain' }],
        });
        expect((await request(`${base}/enable`, 'POST')).status).toBe(409);
        realRelease();
    });

    it('retains uncertainty if releasing an acquired reader throws', async () => {
        const { app, request, instance } = fixture();
        let realRelease!: () => void;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{}'));
                controller.close();
            },
        });
        const req = new Request(`http://localhost${base}/config/write`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer test-session',
                'x-jiyu-plugin-generation': GENERATION_A,
            },
            body,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });
        const originalGetReader = req.body!.getReader.bind(req.body);
        Object.defineProperty(req.body!, 'getReader', {
            value: () => {
                const reader = originalGetReader();
                realRelease = reader.releaseLock.bind(reader);
                Object.defineProperty(reader, 'releaseLock', {
                    value: () => {
                        throw new Error('PRIVATE_RELEASE');
                    },
                });
                return reader;
            },
        });
        const response = await app.request(req);
        const text = await response.text();
        expect(text).not.toContain('PRIVATE_RELEASE');
        expect(JSON.parse(text)).toMatchObject({ code: 'CONFIG_INVALID', outcome: 'not_started' });
        expect(instance.setPluginConfig).not.toHaveBeenCalled();
        expect(await (await request('/api/plugins/local/10001')).json()).toMatchObject({
            pendingOperations: [{ id: 'fixture', cleanup: 'cleanup_uncertain' }],
        });
        realRelease();
        expect((await request(`${base}/enable`, 'POST')).status).toBe(409);
    });

    it('bounds never-settling config calls and leaves GET status observable', async () => {
        const { app, request, instance } = fixture();
        instance.getPluginConfig.mockImplementation(() => new Promise(() => {}));

        for (let i = 0; i < 16; i++) {
            void app.request(`http://localhost/api/plugins/local/10001/p${i}/config/read`, {
                method: 'POST',
                headers: {
                    authorization: 'Bearer test-session',
                    'x-jiyu-plugin-generation': GENERATION_A,
                },
            });
        }

        await vi.waitFor(() => expect(instance.getPluginConfig).toHaveBeenCalledTimes(16));
        const response = await app.request(
            'http://localhost/api/plugins/local/10001/p16/config/read',
            {
                method: 'POST',
                headers: {
                    authorization: 'Bearer test-session',
                    'x-jiyu-plugin-generation': GENERATION_A,
                },
            },
        );
        expect(response.status).toBe(429);
        expect(await response.json()).toMatchObject({
            code: 'CONFIG_QUEUE_FULL',
            outcome: 'not_started',
        });
        const state = (await (await request('/api/plugins/local/10001')).json()) as {
            pendingOperations: unknown[];
        };
        expect(state.pendingOperations).toHaveLength(16);
    });

    it('reserves disable slots across repeated config-before-disable settlements', async () => {
        const { app, request, instance, setCurrent } = fixture();
        const reads = new Map<
            string,
            ReturnType<typeof deferred<{ value: { enabled: boolean }; source: 'plugin' }>>
        >();
        const disables = new Map<string, ReturnType<typeof deferred<void>>>();
        instance.getPluginStatus.mockReturnValue({
            id: 'fixture',
            state: 'active',
            cleanupFailed: false,
            initializationFailed: false,
            pendingActions: 0,
            processResources: 'unknown',
        });
        instance.getPluginConfig.mockImplementation((id) => {
            const gate = deferred<{ value: { enabled: boolean }; source: 'plugin' }>();
            reads.set(id, gate);
            return gate.promise;
        });
        instance.disablePlugin.mockImplementation((id: string) => {
            const gate = deferred<void>();
            disables.set(id, gate);
            return gate.promise;
        });
        const post = async (id: string, operation: string) =>
            app.request(`http://localhost/api/plugins/local/10001/${id}/${operation}`, {
                method: 'POST',
                headers: {
                    authorization: 'Bearer test-session',
                    'x-jiyu-plugin-generation': GENERATION_A,
                },
            });
        const requests: Promise<Response>[] = [post('p0', 'disable')];

        for (let i = 1; i < 16; i++) {
            requests.push(post(`p${i}`, 'config/read'));
        }

        await vi.waitFor(() => {
            expect(disables.size).toBe(1);
            expect(reads.size).toBe(15);
        });
        expect((await post('new', 'config/read')).status).toBe(429);
        expect((await post('new', 'disable')).status).toBe(429);
        const snapshot = await (await request('/api/plugins/local/10001')).json();
        expect(snapshot).toMatchObject({
            actions: expect.arrayContaining([
                expect.objectContaining({
                    id: 'fixture',
                    canEnable: false,
                    enableReason: 'ENABLE_BUSY',
                }),
            ]),
        });

        for (let i = 1; i < 16; i++) {
            requests.push(post(`p${i}`, 'disable'));
        }

        await vi.waitFor(() => expect(disables.size).toBe(16));
        const during = await (await request('/api/plugins/local/10001')).json();
        expect(during).toMatchObject({
            actions: expect.arrayContaining([
                expect.objectContaining({
                    id: 'p1',
                    canDisable: false,
                    disableReason: 'CLEANUP_IN_PROGRESS',
                }),
            ]),
        });

        for (const gate of reads.values()) {
            gate.resolve({ value: { enabled: true }, source: 'plugin' });
        }

        await Promise.all(requests.slice(1, 16));
        // The second generation sees every old-generation disable key even after configs settle.
        setCurrent({ ...instance });
        expect((await post('p1', 'config/read')).status).toBe(409);

        for (let round = 0; round < 3; round++) {
            expect((await post(`n${round}`, 'config/read')).status).toBe(429);
            disables.get(`p${round}`)!.resolve();
            await requests[round === 0 ? 0 : 15 + round];
            const read = post(`n${round}`, 'config/read');
            await vi.waitFor(() => expect(reads.has(`n${round}`)).toBe(true));
            const disable = post(`n${round}`, 'disable');
            await vi.waitFor(() => expect(disables.has(`n${round}`)).toBe(true));
            reads.get(`n${round}`)!.resolve({ value: { enabled: true }, source: 'plugin' });
            await read;
            requests.push(disable);
            expect((await post(`overflow${round}`, 'config/read')).status).toBe(429);
        }

        for (const gate of disables.values()) {
            gate.resolve();
        }

        await Promise.all(requests);
    });

    it('allows disabling an invoked enable at capacity and keeps its key until both settle', async () => {
        const { request, configRequest, instance, setCurrent, app } = fixture();
        const enableGate = deferred<void>();
        const disableGate = deferred<void>();
        instance.enablePlugin.mockImplementationOnce(() => enableGate.promise);
        instance.disablePlugin.mockImplementationOnce(() => disableGate.promise);
        instance.getPluginConfig.mockImplementation(() => new Promise(() => {}));
        const enable = request(`${base}/enable`, 'POST');
        await vi.waitFor(() => expect(instance.enablePlugin).toHaveBeenCalled());

        for (let i = 0; i < 15; i++) {
            void app.request(`http://localhost/api/plugins/local/10001/p${i}/config/read`, {
                method: 'POST',
                headers: {
                    authorization: 'Bearer test-session',
                    'x-jiyu-plugin-generation': GENERATION_A,
                },
            });
        }

        await vi.waitFor(() => expect(instance.getPluginConfig).toHaveBeenCalledTimes(15));
        const disable = request(`${base}/disable`, 'POST');
        await vi.waitFor(() => expect(instance.disablePlugin).toHaveBeenCalledTimes(1));
        disableGate.resolve();
        expect((await disable).status).toBe(200);
        setCurrent({ ...instance });
        expect((await configRequest('schema')).status).toBe(409);
        expect(
            (
                await app.request('http://localhost/api/plugins/local/10001/extra/config/read', {
                    method: 'POST',
                    headers: {
                        authorization: 'Bearer test-session',
                        'x-jiyu-plugin-generation': GENERATION_A,
                    },
                })
            ).status,
        ).toBe(429);
        enableGate.resolve();
        await enable;
        expect((await configRequest('schema')).status).toBe(200);
    });

    it('shares the global key limit across accounts without conflating the same id', async () => {
        const { instance, catalog } = fixture();
        const gate = deferred<{ value: { enabled: boolean }; source: 'plugin' }>();
        instance.getPluginConfig.mockImplementation(() => gate.promise);
        const manager = {
            getInstance: (uin: string) => (/^2000[0-8]$/.test(uin) ? instance : null),
        } as unknown as Pick<OneBotManager, 'getInstance'>;
        const app = new Hono();
        app.use('/api/*', async (c, next) =>
            c.req.header('authorization') === 'Bearer test-session'
                ? next()
                : c.json({ status: 'failed' }, 401),
        );
        registerLocalPluginRoutes(app, manager, catalog);
        const post = async (uin: string, id: string) =>
            app.request(`http://localhost/api/plugins/local/${uin}/${id}/config/read`, {
                method: 'POST',
                headers: {
                    authorization: 'Bearer test-session',
                    'x-jiyu-plugin-generation': GENERATION_A,
                },
            });
        const pending: Promise<Response>[] = [];

        for (let account = 0; account < 8; account++) {
            for (let i = 0; i < 16; i++) {
                pending.push(post(`2000${account}`, `p${i}`));
            }
        }

        await vi.waitFor(() => expect(instance.getPluginConfig).toHaveBeenCalledTimes(128));
        expect((await post('20008', 'p0')).status).toBe(429);
        expect((await post('20000', 'p16')).status).toBe(429);
        gate.resolve({ value: { enabled: true }, source: 'plugin' });
        await Promise.all(pending);
        expect((await post('20008', 'p0')).status).toBe(200);
    });
});
