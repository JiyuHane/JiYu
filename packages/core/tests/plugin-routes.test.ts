import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { OneBotManager } from '@snowluma/onebot/manager';
import { LocalPluginCatalogError, type LocalPluginCatalog } from '../src/webui/plugin-local';
import { registerLocalPluginRoutes } from '../src/webui/plugin-routes';

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
        disablePlugin: vi.fn(async () => {
            active = false;
        }),
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
            headers: authenticated ? { authorization: 'Bearer test-session' } : {},
        });
    return { request, catalog, instance, setCurrent: (value: unknown) => (current = value) };
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
