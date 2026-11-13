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
            export async function plugin_init(ctx) {
                const login = await ctx.actions.call('get_login_info', {}, ctx.adapterName, ctx.pluginManager.config);
                globalThis.__webuiPluginIntegrationProbe.initialized.push({login, dataPath: ctx.dataPath});
            }
            export function plugin_onevent(ctx, event) {
                globalThis.__webuiPluginIntegrationProbe.events.push({dataPath: ctx.dataPath, event});
            }
            export function plugin_cleanup(ctx) {
                globalThis.__webuiPluginIntegrationProbe.cleaned.push(ctx.dataPath);
            }
        `,
        );
        const probe: Probe = { evaluated: 0, initialized: [], events: [], cleaned: [] };
        (globalThis as Record<string, unknown>).__webuiPluginIntegrationProbe = probe;
        const network = vi
            .spyOn(globalThis, 'fetch')
            .mockRejectedValue(new Error('Unexpected external fetch'));
        const a = await makeAccount('10001');
        const b = await makeAccount('10002');
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
            const rendered = logs.map((entry) => entry.message).join('\n');
            expect(rendered).not.toContain(token);
            expect(rendered).not.toContain(marker);
            expect(network).not.toHaveBeenCalled();
        } finally {
            unsubscribe();
            setLogLevel(prevLevel);
        }
    });
});
