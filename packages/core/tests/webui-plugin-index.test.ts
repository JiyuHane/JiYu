import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OneBotManager } from '@snowluma/onebot/manager';
import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import { initWebUI } from '../src/webui/server';

const state = vi.hoisted(() => ({
    fetch: null as null | ((request: Request) => Promise<Response>),
    get: vi.fn(async (_force?: boolean) => ({
        index: {
            version: '1',
            updateTime: '2026-01-01T00:00:00Z',
            statsUrl: 'https://example.invalid/stats',
            plugins: [
                {
                    id: 'napcat-plugin-fixture',
                    name: 'Fixture',
                    version: '1.0.0',
                    description: 'Fixture',
                    author: 'Original author',
                    homepage: 'https://example.invalid/fixture',
                    downloadUrl: 'https://example.invalid/fixture.zip',
                    minVersion: '4.0.0',
                },
            ],
        },
        fetchedAt: 123,
        stale: false,
        error: null,
        verified: false,
        minVersionTarget: 'NapCat',
    })),
}));

vi.mock('@hono/node-server', () => ({
    serve: vi.fn(
        (options: { fetch: typeof state.fetch }, onListen: (info: { port: number }) => void) => {
            state.fetch = options.fetch;
            queueMicrotask(() => onListen({ port: 5099 }));
            return { close: (done: () => void) => done() };
        },
    ),
}));
vi.mock('../src/webui/port', () => ({ findAvailablePort: vi.fn(async () => 5099) }));
vi.mock('../src/webui/plugin-index', () => ({
    createCommunityIndexService: () => ({ get: state.get }),
}));

let cwd: string;
let dir: string;
beforeEach(() => {
    cwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiyu-plugin-index-'));
    process.chdir(dir);
    state.get.mockClear();
    vi.stubEnv('SNOWLUMA_DEV_MODE', '1');
    vi.stubEnv('SNOWLUMA_ACCEPT_EULA', '1');
    vi.stubEnv('SNOWLUMA_ACCEPT_PRIVACY', '1');
});
afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
});

describe('community plugin index route', () => {
    it('requires an authenticated request and fetches only on demand', async () => {
        const server = await initWebUI(5099, {} as OneBotManager);

        try {
            const fetch = state.fetch!;
            expect(state.get).not.toHaveBeenCalled();
            const denied = await fetch(new Request('http://127.0.0.1/api/plugins/index'));
            expect(denied.status).toBe(401);
            const deniedEnable = await fetch(
                new Request('http://127.0.0.1/api/plugins/local/10001/fixture/enable', {
                    method: 'POST',
                }),
            );
            expect(deniedEnable.status).toBe(401);
            expect(state.get).not.toHaveBeenCalled();

            const login = await fetch(
                new Request('http://127.0.0.1/api/login', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ password: 'snowluma-dev' }),
                }),
            );
            const { token } = (await login.json()) as { token: string };
            const headers = { authorization: `Bearer ${token}` };
            const response = await fetch(
                new Request('http://127.0.0.1/api/plugins/index', { headers }),
            );
            expect(response.status).toBe(200);
            const body = (await response.json()) as {
                index: { plugins: Array<{ author: string }> };
                verified: boolean;
                minVersionTarget: string;
            };
            expect(body.index.plugins[0].author).toBe('Original author');
            expect(body.verified).toBe(false);
            expect(body.minVersionTarget).toBe('NapCat');
            expect(state.get).toHaveBeenLastCalledWith(false);

            const refreshed = await fetch(
                new Request('http://127.0.0.1/api/plugins/index?refresh=1', { headers }),
            );
            expect(refreshed.status).toBe(200);
            expect(state.get).toHaveBeenLastCalledWith(true);
        } finally {
            await server.stop();
        }
    });

    it('does not trace the authenticated management token or ignored request body', async () => {
        const instance = {
            canEnablePlugins: () => true,
            getPluginStatus: () => null,
            listPlugins: () => [],
        };
        const server = await initWebUI(5099, {
            getInstance: () => instance,
        } as unknown as OneBotManager);
        const previousLevel = getLogLevel();
        const logs: LogEntry[] = [];
        setLogLevel('trace');
        const unsubscribe = subscribeLogs((entry) => logs.push(entry));

        try {
            const fetch = state.fetch!;
            const login = await fetch(
                new Request('http://127.0.0.1/api/login', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ password: 'snowluma-dev' }),
                }),
            );
            const { token } = (await login.json()) as { token: string };
            const marker = 'fixture-private-body-marker';
            for (const target of [
                'http://127.0.0.1/api/plugins/local/10001/fixture/enable',
                'http://127.0.0.1/api/plugins/%6cocal/10001/fixture/enable',
                'http://127.0.0.1/api/%70lugins/local/10001/fixture/enable',
            ]) {
                const response = await fetch(
                    new Request(target, {
                        method: 'POST',
                        headers: {
                            authorization: `Bearer ${token}`,
                            'content-type': 'application/json',
                        },
                        body: JSON.stringify({ ignored: marker }),
                    }),
                );
                // All three paths reach the authenticated handler; this missing
                // local plugin fixture is reported after the middleware.
                expect(response.status).toBe(404);
            }
            const rendered = logs.map((entry) => entry.message).join('\n');
            expect(rendered).not.toContain(token);
            expect(rendered).not.toContain(marker);
        } finally {
            unsubscribe();
            setLogLevel(previousLevel);
            await server.stop();
        }
    });
});
