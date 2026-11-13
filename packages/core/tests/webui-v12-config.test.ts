import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    loadOneBotConfig,
    makeDefaultOneBotConfig,
    saveOneBotConfig,
} from '@snowluma/onebot/config';
import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import type { OneBotManager } from '@snowluma/onebot/manager';
import type { OneBotConfig } from '@snowluma/onebot/types';
import { initWebUI } from '../src/webui/server';

const state = vi.hoisted(() => ({
    fetch: null as null | ((request: Request) => Promise<Response>),
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

const v12 = {
    enabled: true,
    host: '127.0.0.1',
    port: 3012,
    accessToken: 'E5xqVb7_9pLt2QwR4M8kZ1nY',
    allowNonLoopback: false,
};
let cwd: string;
let dir: string;

beforeEach(() => {
    cwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiyu-v12-webui-'));
    process.chdir(dir);
    vi.stubEnv('SNOWLUMA_DEV_MODE', '1');
    vi.stubEnv('SNOWLUMA_ACCEPT_EULA', '1');
    vi.stubEnv('SNOWLUMA_ACCEPT_PRIVACY', '1');
});
afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
});

describe('legacy account config saves', () => {
    it('does not log v12 credentials during an authenticated backup restore', async () => {
        const server = await initWebUI(5099, {} as OneBotManager);
        const previousLogLevel = getLogLevel();
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
            const config = makeDefaultOneBotConfig();
            config.v12 = { ...v12 };
            const response = await fetch(
                new Request('http://127.0.0.1/api/system/backup/import', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({
                        restoreCredentials: true,
                        backup: {
                            version: 1,
                            app: 'snowluma',
                            files: {
                                'onebot_10001.json': {
                                    encoding: 'utf8',
                                    data: JSON.stringify(config),
                                },
                            },
                        },
                    }),
                }),
            );
            expect(response.status).toBe(200);
            expect(((await response.json()) as { success: boolean }).success).toBe(true);
            expect(loadOneBotConfig('10001').v12).toEqual(v12);
            expect(logs.map((entry) => entry.message).join('\n')).not.toContain(v12.accessToken);
            expect(logs.map((entry) => entry.message).join('\n')).not.toContain(token);
        } finally {
            unsubscribe();
            setLogLevel(previousLogLevel);
            await server.stop();
        }
    });

    it('does not expose credentials when applying a saved configuration throws', async () => {
        const initial = makeDefaultOneBotConfig();
        initial.v12 = { ...v12 };
        saveOneBotConfig('10001', initial);
        const next = structuredClone(initial);
        next.v12!.accessToken = 'Wy8C6nKfQ3_rA7mP9xB5tD2z';
        const reloadConfig = vi.fn(async () => {
            throw new Error(
                `raw-error ${initial.v12!.accessToken} ${next.v12!.accessToken} /private/fixture`,
            );
        });
        const getInstance = vi.fn(() => ({}));
        const server = await initWebUI(5099, {
            reloadConfig,
            getInstance,
        } as unknown as OneBotManager);
        const previousLogLevel = getLogLevel();
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
            const response = await fetch(
                new Request('http://127.0.0.1/api/config/10001', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify(next),
                }),
            );
            const body = (await response.json()) as {
                saved: boolean;
                applied: boolean;
                online: boolean;
                reloaded: boolean;
                errors: unknown[];
                config: OneBotConfig;
            };
            expect(response.status).toBe(200);
            expect(body).toMatchObject({
                saved: true,
                applied: false,
                online: true,
                reloaded: false,
            });
            expect(body.config.v12).toEqual(next.v12);
            expect(loadOneBotConfig('10001').v12).toEqual(next.v12);

            for (const value of [
                initial.v12!.accessToken,
                next.v12!.accessToken,
                token,
                'raw-error',
                '/private/fixture',
            ]) {
                expect(JSON.stringify(body.errors)).not.toContain(value);
                expect(logs.map((entry) => entry.message).join('\n')).not.toContain(value);
            }
        } finally {
            unsubscribe();
            setLogLevel(previousLogLevel);
            await server.stop();
        }
    });

    it('preserves the latest v12 while saving and applying old-client changes', async () => {
        const initial = makeDefaultOneBotConfig();
        initial.v12 = { ...v12 };
        saveOneBotConfig('10001', initial);
        let releaseFirst!: () => void;
        const gate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const reloadConfig = vi.fn(async (_uin: string, _config: OneBotConfig) => {
            if (reloadConfig.mock.calls.length === 1) {
                await gate;
            }

            return { online: true, applied: true, errors: [], adapters: [] };
        });
        const server = await initWebUI(5099, { reloadConfig } as unknown as OneBotManager);
        const previousLogLevel = getLogLevel();
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
            expect(token).toBeTruthy();
            const updated = structuredClone(initial);
            updated.v12!.port = 3013;
            const first = fetch(
                new Request('http://127.0.0.1/api/config/10001', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify(updated),
                }),
            );
            await vi.waitFor(() => expect(reloadConfig).toHaveBeenCalledTimes(1));
            const oldClient = structuredClone(initial);
            delete oldClient.v12;
            oldClient.statusCommand.trigger = '#changed';
            const response = await fetch(
                new Request('http://127.0.0.1/api/config/10001', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify(oldClient),
                }),
            );
            const body = (await response.json()) as {
                saved: boolean;
                applied: boolean;
                config: typeof initial;
            };
            expect(response.status).toBe(200);
            expect(body.saved).toBe(true);
            expect(body.applied).toBe(true);
            expect(body.config.v12).toEqual(updated.v12);
            expect(loadOneBotConfig('10001').v12).toEqual(updated.v12);
            expect(reloadConfig.mock.calls[1][1].v12).toEqual(updated.v12);
            releaseFirst();
            expect((await first).status).toBe(200);
            expect(logs.map((entry) => entry.message).join('\n')).not.toContain(v12.accessToken);
            expect(logs.map((entry) => entry.message).join('\n')).not.toContain(token);
        } finally {
            releaseFirst();
            unsubscribe();
            setLogLevel(previousLogLevel);
            await server.stop();
        }
    });
});
