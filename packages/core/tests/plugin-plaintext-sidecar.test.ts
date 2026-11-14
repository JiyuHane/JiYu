import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerLocalPluginRoutes } from '../src/webui/plugin-routes';

const GENERATION = '123e4567-e89b-42d3-a456-426614174000';

function fixture(legacy = false) {
    let value = { flag: false };
    const fields = legacy
        ? [{ key: 'flag', label: 'Flag', type: 'boolean', default: false }]
        : [
              { key: '_text_fixture', label: '', type: 'text', default: 'route text' },
              { key: 'flag', label: 'Flag', type: 'boolean', default: false },
          ];
    const instance = {
        canEnablePlugins: () => true,
        getPluginConfigGeneration: vi.fn(() => GENERATION),
        getPluginConfigSchema: vi.fn(async (_id: string) => ({
            fields,
            source: 'schema' as const,
            ...(legacy
                ? {}
                : {
                      displaySidecar: {
                          version: 1 as const,
                          generation: GENERATION,
                          source: 'schema' as const,
                          snapshot: structuredClone(fields),
                          entries: [{ index: 0, kind: 'plainText' as const }],
                      },
                  }),
        })),
        getPluginConfig: vi.fn(async (_id: string) => ({ value, source: 'plugin' as const })),
        setPluginConfig: vi.fn(async (_id: string, next: { flag: boolean }) => {
            value = next;
            return { persistence: 'plugin-managed' as const };
        }),
    };
    const app = new Hono();
    app.use('/api/*', async (c, next) =>
        c.req.header('authorization') === 'Bearer test'
            ? next()
            : c.json({ status: 'failed' }, 401),
    );
    let current: unknown = instance;
    registerLocalPluginRoutes(
        app,
        { getInstance: () => current } as never,
        { list: async () => [], resolve: async () => '' } as never,
    );
    const request = (action: string, body?: string) =>
        app.request(`http://localhost/api/plugins/local/10001/demo/config/${action}`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer test',
                'x-jiyu-plugin-generation': GENERATION,
                ...(body ? { 'content-type': 'application/json' } : {}),
            },
            body,
        });
    return {
        instance,
        app,
        request,
        setCurrent: (next: unknown) => {
            current = next;
        },
    };
}

describe('plainText sidecar memory route', () => {
    it('transports a bound snapshot and preserves the explicit legacy direct-write API', async () => {
        const { instance, app, request } = fixture();
        const denied = await app.request(
            'http://localhost/api/plugins/local/10001/demo/config/schema',
            { method: 'POST' },
        );
        expect(denied.status).toBe(401);
        expect(instance.getPluginConfigSchema).not.toHaveBeenCalled();
        const response = await request('schema');
        const result = (await response.json()) as {
            fields: unknown[];
            generation: string;
            displaySidecar?: unknown;
        };
        expect(response.status).toBe(200);
        expect(result.displaySidecar).toMatchObject({
            version: 1,
            generation: result.generation,
            source: 'schema',
            snapshot: result.fields,
            entries: [{ index: 0, kind: 'plainText' }],
        });
        expect(result.fields[0]).toMatchObject({ type: 'text', label: '', default: 'route text' });
        expect((await request('write', JSON.stringify({ flag: true }))).status).toBe(200);
        expect(instance.setPluginConfig).toHaveBeenCalledOnce();
        expect((await instance.getPluginConfig('demo')).value).toEqual({ flag: true });
    });

    it('keeps a legacy scalar schema without sidecar directly writable', async () => {
        const { instance, request } = fixture(true);
        const result = (await (await request('schema')).json()) as {
            fields: unknown[];
            displaySidecar?: unknown;
        };
        expect(result.displaySidecar).toBeUndefined();
        expect(result.fields).toEqual([
            { key: 'flag', label: 'Flag', type: 'boolean', default: false },
        ]);
        expect((await request('write', JSON.stringify({ flag: true }))).status).toBe(200);
        expect(instance.setPluginConfig).toHaveBeenCalledOnce();
        expect((await instance.getPluginConfig('demo')).value).toEqual({ flag: true });
    });

    it('fails if the final generation observation replaces the account synchronously', async () => {
        const { instance, request, setCurrent } = fixture();
        let calls = 0;
        instance.getPluginConfigGeneration.mockImplementation(() => {
            if (++calls === 2) {
                setCurrent({});
            }

            return GENERATION;
        });
        const response = await request('schema');
        expect(calls).toBe(2);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'CONFIG_OUTCOME_UNKNOWN' });
    });

    it('rejects a mismatched sidecar generation instead of downgrading schema', async () => {
        const { instance, request } = fixture();
        const original = await instance.getPluginConfigSchema('demo');
        instance.getPluginConfigSchema.mockResolvedValueOnce({
            ...original,
            displaySidecar: { ...original.displaySidecar!, generation: 'bad-generation' },
        });
        const response = await request('schema');
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ status: 'failed', code: 'CONFIG_INVALID' });
    });
});
