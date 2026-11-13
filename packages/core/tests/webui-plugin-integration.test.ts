import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import { makeDefaultOneBotConfig } from '@snowluma/onebot/config';
import { defaultGlobalSettings } from '@snowluma/onebot/global-config';
import { OneBotInstance } from '@snowluma/onebot/instance';
import type { OneBotManager } from '@snowluma/onebot/manager';
import { initWebUI } from '../src/webui/server';

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

interface Probe {
    evaluated: number;
    initialized: Array<{ login: unknown; dataPath: string }>;
    events: Array<{ dataPath: string; event: Record<string, unknown> }>;
    cleaned: string[];
    configs: Record<string, { label: string; nested: { count: number } }>;
    reads: string[];
    writes: string[];
}

let previousCwd: string;
let temporary: string;
const accounts: OneBotInstance[] = [];
let webui: Awaited<ReturnType<typeof initWebUI>> | undefined;

beforeEach(async () => {
    previousCwd = process.cwd();
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'jiyu-plugin-e2e-'));
    process.chdir(temporary);
    transport.fetch = null;
    vi.stubEnv('SNOWLUMA_DEV_MODE', '1');
    vi.stubEnv('SNOWLUMA_ACCEPT_EULA', '1');
    vi.stubEnv('SNOWLUMA_ACCEPT_PRIVACY', '1');
});

afterEach(async () => {
    try {
        const cleanup: Promise<unknown>[] = [];

        if (webui) {
            cleanup.push(webui.stop());
        }

        webui = undefined;

        for (const account of accounts.splice(0)) {
            cleanup.push(account.dispose());
        }

        const results = await Promise.allSettled(cleanup);
        const errors = results.filter((result) => result.status === 'rejected');

        if (errors.length) {
            throw new Error('WebUI or account cleanup failed');
        }
    } finally {
        delete (globalThis as Record<string, unknown>).__webuiPluginIntegrationProbe;
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        process.chdir(previousCwd);
        await fs.rm(temporary, { recursive: true, force: true });
    }
});

async function makeAccount(uin: string): Promise<OneBotInstance> {
    const bridge = {
        events: new BridgeEventBus(),
        identity: { initialization: Promise.resolve(), nickname: `fixture-${uin}`, groups: [] },
        receiveHealthy: true,
        apis: { contacts: { fetchDownloadRKeys: async () => [] } },
    } as unknown as BridgeInterface;
    const config = makeDefaultOneBotConfig();
    config.networks = { httpServers: [], httpClients: [], wsServers: [], wsClients: [] };
    config.statusCommand.enabled = false;
    const account = new OneBotInstance(uin, bridge, config, defaultGlobalSettings());
    accounts.push(account);
    expect((await account.waitUntilNetworkReady()).applied).toBe(true);
    return account;
}

async function request(url: string, init?: RequestInit): Promise<Response> {
    if (!transport.fetch) {
        throw new Error('WebUI fetch is not ready');
    }

    return transport.fetch(new Request(`http://127.0.0.1${url}`, init));
}

describe('authenticated WebUI local plugin integration', () => {
    it('executes only an explicit authenticated enable and isolates real account lifecycles', async () => {
        const dir = path.join(temporary, 'data', 'plugin-packages', 'demo');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
        await fs.writeFile(
            path.join(dir, 'index.mjs'),
            `
            globalThis.__webuiPluginIntegrationProbe.evaluated++;
            export const plugin_config_schema = [{ key: 'label', type: 'string' }];
            export async function plugin_init(ctx) {
                const login = await ctx.actions.call('get_login_info', {}, ctx.adapterName, ctx.pluginManager.config);
                globalThis.__webuiPluginIntegrationProbe.initialized.push({login, dataPath: ctx.dataPath});
                globalThis.__webuiPluginIntegrationProbe.configs[ctx.dataPath] = {label: 'initial', nested: {count: 1}};
            }
            export function plugin_get_config(ctx) {
                const probe = globalThis.__webuiPluginIntegrationProbe;
                probe.reads.push(ctx.dataPath);
                return probe.configs[ctx.dataPath];
            }
            export function plugin_set_config(ctx, value) {
                const probe = globalThis.__webuiPluginIntegrationProbe;
                probe.writes.push(ctx.dataPath);
                probe.configs[ctx.dataPath] = value;
            }
            export function plugin_onevent(ctx, event) {
                globalThis.__webuiPluginIntegrationProbe.events.push({dataPath: ctx.dataPath, event});
            }
            export function plugin_cleanup(ctx) {
                globalThis.__webuiPluginIntegrationProbe.cleaned.push(ctx.dataPath);
            }
        `,
        );
        const probe: Probe = {
            evaluated: 0,
            initialized: [],
            events: [],
            cleaned: [],
            configs: {},
            reads: [],
            writes: [],
        };
        (globalThis as Record<string, unknown>).__webuiPluginIntegrationProbe = probe;
        const network = vi
            .spyOn(globalThis, 'fetch')
            .mockRejectedValue(new Error('Unexpected external fetch'));
        const a = await makeAccount('10001');
        const b = await makeAccount('10002');
        const schemaA = vi.spyOn(a, 'getPluginConfigSchema');
        const schemaB = vi.spyOn(b, 'getPluginConfigSchema');
        const readA = vi.spyOn(a, 'getPluginConfig');
        const readB = vi.spyOn(b, 'getPluginConfig');
        const writeA = vi.spyOn(a, 'setPluginConfig');
        const writeB = vi.spyOn(b, 'setPluginConfig');
        const byAccount = new Map([
            [a.uin, a],
            [b.uin, b],
        ]);
        webui = await initWebUI(5099, {
            getInstance: (uin: string) => byAccount.get(uin) ?? null,
        } as unknown as OneBotManager);
        const prevLevel = getLogLevel();
        const logs: LogEntry[] = [];
        setLogLevel('trace');
        const unsubscribe = subscribeLogs((entry) => logs.push(entry));

        try {
            const denied = await request('/api/plugins/local/10001/demo/enable', {
                method: 'POST',
            });
            expect(denied.status).toBe(401);

            for (const uin of ['10001', '10002']) {
                for (const operation of ['schema', 'read', 'write']) {
                    const response = await request(
                        `/api/plugins/local/${uin}/demo/config/${operation}`,
                        {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body:
                                operation === 'write'
                                    ? '{"label":"fixture-unauth-secret"}'
                                    : undefined,
                        },
                    );
                    expect(response.status).toBe(401);
                    expect(response.headers.get('cache-control')).toContain('no-store');
                }
            }

            for (const spy of [schemaA, schemaB, readA, readB, writeA, writeB]) {
                expect(spy).not.toHaveBeenCalled();
            }

            expect(probe.reads).toEqual([]);
            expect(probe.writes).toEqual([]);
            expect(probe.evaluated).toBe(0);
            const login = await request('/api/login', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ password: 'snowluma-dev' }),
            });
            expect(login.status).toBe(200);
            const { token } = (await login.json()) as { token: string };
            expect(token).toBeTruthy();
            const headers = {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            };
            const first = await request('/api/plugins/local/10001', { headers });
            expect(first.status).toBe(200);
            expect(await first.json()).toMatchObject({
                status: 'ok',
                accountOnline: true,
                candidates: ['demo'],
                runtime: [],
                processResources: 'unknown',
                actions: [{ id: 'demo', canEnable: true, canDisable: false }],
            });

            for (const operation of ['schema', 'read', 'write']) {
                await request(`/api/plugins/local/10001/demo/config/${operation}`, { headers });
            }

            for (const spy of [schemaA, schemaB, readA, readB, writeA, writeB]) {
                expect(spy).not.toHaveBeenCalled();
            }

            expect(probe.evaluated).toBe(0);
            const marker = 'fixture-body-secret-marker';
            const enabled = await request('/api/plugins/local/10001/demo/enable', {
                method: 'POST',
                headers,
                body: JSON.stringify({ ignored: marker }),
            });
            expect(enabled.status).toBe(200);
            const enabledText = await enabled.text();
            expect(enabledText).not.toContain(temporary);
            expect(JSON.parse(enabledText)).toMatchObject({
                status: 'ok',
                operation: 'enable',
                runtime: { id: 'demo', state: 'active' },
                processResources: 'unknown',
            });
            expect(probe.evaluated).toBe(1);
            expect(probe.initialized).toEqual([
                {
                    login: { user_id: 10001, nickname: 'fixture-10001' },
                    dataPath: path.join(temporary, 'data', 'plugins', '10001', 'demo'),
                },
            ]);
            expect((await fs.stat(probe.initialized[0]!.dataPath)).isDirectory()).toBe(true);
            const active = await request('/api/plugins/local/10001', { headers });
            expect(await active.json()).toMatchObject({
                runtime: [{ id: 'demo', state: 'active' }],
                actions: [{ id: 'demo', canEnable: false, canDisable: true }],
                processResources: 'unknown',
            });
            const other = await request('/api/plugins/local/10002', { headers });
            expect(await other.json()).toMatchObject({
                candidates: ['demo'],
                runtime: [],
                actions: [{ id: 'demo', canEnable: true }],
                processResources: 'unknown',
            });
            expect(
                (await request('/api/plugins/local/10001/demo/enable', { method: 'POST', headers }))
                    .status,
            ).toBe(409);
            expect(probe.evaluated).toBe(1);
            expect(probe.initialized).toHaveLength(1);
            await a.emitBotStatus('online');
            await vi.waitFor(() => expect(probe.events).toHaveLength(1));
            expect(probe.events[0]).toMatchObject({
                dataPath: path.join(temporary, 'data', 'plugins', '10001', 'demo'),
                event: { notice_type: 'bot_status', self_id: 10001 },
            });
            await b.emitBotStatus('online');
            expect(probe.events).toHaveLength(1);
            const enabledB = await request('/api/plugins/local/10002/demo/enable', {
                method: 'POST',
                headers,
            });
            expect(enabledB.status).toBe(200);
            expect(await enabledB.json()).toMatchObject({
                status: 'ok',
                runtime: { id: 'demo', state: 'active' },
                processResources: 'unknown',
            });
            expect(probe.evaluated).toBe(2);
            expect(probe.initialized).toHaveLength(2);
            expect(probe.initialized[1]).toEqual({
                login: { user_id: 10002, nickname: 'fixture-10002' },
                dataPath: path.join(temporary, 'data', 'plugins', '10002', 'demo'),
            });

            // A listing and GET-only config probes must not invoke plugin configuration.
            for (const uin of ['10001', '10002']) {
                await request(`/api/plugins/local/${uin}`, { headers });

                for (const operation of ['schema', 'read', 'write']) {
                    await request(`/api/plugins/local/${uin}/demo/config/${operation}`, {
                        headers,
                    });
                }
            }

            for (const spy of [schemaA, schemaB, readA, readB, writeA, writeB]) {
                expect(spy).not.toHaveBeenCalled();
            }

            expect(probe.reads).toEqual([]);
            expect(probe.writes).toEqual([]);
            const pathA = path.join(temporary, 'data', 'plugins', '10001', 'demo');
            const pathB = path.join(temporary, 'data', 'plugins', '10002', 'demo');
            const secretA = 'fixture-config-secret-alpha';
            const secretB = 'fixture-config-secret-beta';

            const generations: Record<string, string> = {};

            for (const uin of ['10001', '10002']) {
                const schema = await request(`/api/plugins/local/${uin}/demo/config/schema`, {
                    method: 'POST',
                    headers,
                });
                expect(schema.status).toBe(200);
                expect(schema.headers.get('cache-control')).toBe('no-store');
                const schemaBody = (await schema.json()) as { generation: string };
                expect(schemaBody).toMatchObject({
                    status: 'ok',
                    source: 'schema',
                    fields: [{ key: 'label', type: 'string' }],
                    processResources: 'unknown',
                });
                expect(typeof schemaBody.generation).toBe('string');
                generations[uin] = schemaBody.generation;
            }

            expect(generations['10001'] !== generations['10002']).toBe(true);
            const configHeaders = (uin: string) => ({
                ...headers,
                'x-jiyu-plugin-generation': generations[uin]!,
            });
            const crossed = await request('/api/plugins/local/10002/demo/config/write', {
                method: 'POST',
                headers: configHeaders('10001'),
                body: JSON.stringify({ label: 'fixture-cross-secret' }),
            });
            expect(crossed.status).toBe(409);
            expect(await crossed.json()).toMatchObject({
                code: 'CONFIG_GENERATION_CHANGED',
                outcome: 'not_started',
            });
            expect(probe.writes).toEqual([]);

            for (const [uin, dataPath] of [
                ['10001', pathA],
                ['10002', pathB],
            ] as const) {
                const response = await request(`/api/plugins/local/${uin}/demo/config/read`, {
                    method: 'POST',
                    headers: configHeaders(uin),
                });
                expect(response.status).toBe(200);
                expect(response.headers.get('cache-control')).toBe('no-store');
                const snapshot = (await response.json()) as {
                    value: { label: string; nested: { count: number } };
                    source: string;
                };
                expect(snapshot).toMatchObject({
                    source: 'plugin',
                    value: { label: 'initial', nested: { count: 1 } },
                });
                snapshot.value.nested.count = 99;
                expect(probe.configs[dataPath]!.nested.count).toBe(1);
                probe.configs[dataPath]!.nested.count = 2;
                expect(snapshot.value.nested.count).toBe(99);
                probe.configs[dataPath]!.nested.count = 1;
            }

            const writeFirst = await request('/api/plugins/local/10001/demo/config/write', {
                method: 'POST',
                headers: configHeaders('10001'),
                body: JSON.stringify({ label: secretA, nested: { count: 11 } }),
            });
            expect(writeFirst.status).toBe(200);
            expect(writeFirst.headers.get('cache-control')).toBe('no-store');
            expect(await writeFirst.json()).toMatchObject({
                status: 'ok',
                persistence: 'plugin-managed',
                processResources: 'unknown',
            });
            expect(probe.configs[pathA]).toEqual({ label: secretA, nested: { count: 11 } });
            expect(probe.configs[pathB]).toEqual({ label: 'initial', nested: { count: 1 } });
            const writeSecond = await request('/api/plugins/local/10002/demo/config/write', {
                method: 'POST',
                headers: configHeaders('10002'),
                body: JSON.stringify({ label: secretB, nested: { count: 22 } }),
            });
            expect(writeSecond.status).toBe(200);
            expect(writeSecond.headers.get('cache-control')).toBe('no-store');
            expect(await writeSecond.json()).toMatchObject({
                status: 'ok',
                persistence: 'plugin-managed',
                processResources: 'unknown',
            });
            expect(probe.configs[pathA]).toEqual({ label: secretA, nested: { count: 11 } });
            expect(probe.configs[pathB]).toEqual({ label: secretB, nested: { count: 22 } });

            for (const spy of [schemaA, schemaB, readA, readB, writeA, writeB]) {
                expect(spy).toHaveBeenCalledOnce();
            }

            expect(probe.reads).toEqual([pathA, pathB]);
            expect(probe.writes).toEqual([pathA, pathB]);
            await b.emitBotStatus('offline');
            await vi.waitFor(() => expect(probe.events).toHaveLength(2));
            expect(probe.events[1]).toMatchObject({
                dataPath: path.join(temporary, 'data', 'plugins', '10002', 'demo'),
                event: { notice_type: 'bot_status', self_id: 10002 },
            });
            const disabled = await request('/api/plugins/local/10001/demo/disable', {
                method: 'POST',
                headers,
            });
            expect(disabled.status).toBe(200);
            expect(await disabled.json()).toMatchObject({
                status: 'ok',
                operation: 'disable',
                runtime: null,
                processResources: 'unknown',
            });
            expect(probe.cleaned).toEqual([
                path.join(temporary, 'data', 'plugins', '10001', 'demo'),
            ]);

            for (const operation of ['schema', 'read', 'write']) {
                const inactive = await request(
                    `/api/plugins/local/10001/demo/config/${operation}`,
                    {
                        method: 'POST',
                        headers: configHeaders('10001'),
                        body:
                            operation === 'write'
                                ? JSON.stringify({ label: 'fixture-inactive-secret' })
                                : undefined,
                    },
                );
                expect(inactive.status).toBe(409);
                expect(inactive.headers.get('cache-control')).toBe('no-store');
                expect(await inactive.json()).toMatchObject({
                    status: 'failed',
                    code: operation === 'schema' ? 'PLUGIN_INACTIVE' : 'CONFIG_GENERATION_CHANGED',
                    outcome: 'not_started',
                    processResources: 'unknown',
                });
            }

            expect(probe.reads).toEqual([pathA, pathB]);
            expect(probe.writes).toEqual([pathA, pathB]);
            expect(probe.configs[pathB]).toEqual({ label: secretB, nested: { count: 22 } });
            const after = await request('/api/plugins/local/10001', { headers });
            expect(await after.json()).toMatchObject({
                candidates: ['demo'],
                runtime: [],
                processResources: 'unknown',
            });
            expect(b.listPlugins()).toMatchObject([{ id: 'demo', state: 'active' }]);
            const stillActive = await request('/api/plugins/local/10002', { headers });
            expect(await stillActive.json()).toMatchObject({
                runtime: [{ id: 'demo', state: 'active' }],
                processResources: 'unknown',
            });
            await b.emitBotStatus('online');
            await vi.waitFor(() => expect(probe.events).toHaveLength(3));
            expect(probe.events[2]).toMatchObject({
                dataPath: path.join(temporary, 'data', 'plugins', '10002', 'demo'),
                event: { self_id: 10002 },
            });
            const disabledB = await request('/api/plugins/local/10002/demo/disable', {
                method: 'POST',
                headers,
            });
            expect(await disabledB.json()).toMatchObject({
                status: 'ok',
                runtime: null,
                processResources: 'unknown',
            });
            expect(probe.cleaned).toEqual([
                path.join(temporary, 'data', 'plugins', '10001', 'demo'),
                path.join(temporary, 'data', 'plugins', '10002', 'demo'),
            ]);
            // A replacement activation on the same instance must reject an old draft.
            expect(
                (await request('/api/plugins/local/10001/demo/enable', { method: 'POST', headers }))
                    .status,
            ).toBe(200);
            const replacement = await request('/api/plugins/local/10001/demo/config/schema', {
                method: 'POST',
                headers,
            });
            expect(replacement.status).toBe(200);
            const newGeneration = ((await replacement.json()) as { generation: string }).generation;
            expect(typeof newGeneration).toBe('string');
            expect(newGeneration !== generations['10001']).toBe(true);
            const stale = await request('/api/plugins/local/10001/demo/config/write', {
                method: 'POST',
                headers: configHeaders('10001'),
                body: JSON.stringify({ label: 'fixture-stale-secret' }),
            });
            expect(stale.status).toBe(409);
            expect(await stale.json()).toMatchObject({
                code: 'CONFIG_GENERATION_CHANGED',
                outcome: 'not_started',
            });
            expect(probe.writes).toEqual([pathA, pathB]);
            expect(probe.configs[pathA]).toEqual({ label: 'initial', nested: { count: 1 } });
            expect(
                (
                    await request('/api/plugins/local/10001/demo/disable', {
                        method: 'POST',
                        headers,
                    })
                ).status,
            ).toBe(200);
            expect(probe.cleaned).toEqual([pathA, pathB, pathA]);
            const rendered = logs.map((entry) => entry.message).join('\n');
            expect(
                rendered.includes(generations['10001']!) ||
                    rendered.includes(generations['10002']!) ||
                    rendered.includes(newGeneration),
            ).toBe(false);
            expect(rendered).not.toContain(token);
            expect(rendered).not.toContain(marker);

            for (const value of [
                secretA,
                secretB,
                'fixture-unauth-secret',
                'fixture-inactive-secret',
                'fixture-cross-secret',
                'fixture-stale-secret',
            ]) {
                expect(rendered).not.toContain(value);
            }

            expect(network).not.toHaveBeenCalled();
        } finally {
            unsubscribe();
            setLogLevel(prevLevel);
        }
    });
});
