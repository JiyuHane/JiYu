import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { makeDefaultOneBotConfig } from '../src/config';
import { defaultGlobalSettings } from '../src/global-config';
import { OneBotInstance } from '../src/instance';
import type { JsonObject } from '../src/types';

const instances: OneBotInstance[] = [];
let nextAccount = 31000;

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function plugin(source: string): Promise<string> {
    const directory = await mkdtemp(path.join(process.cwd(), 'plugin-fixture-'));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
    await writeFile(path.join(directory, 'index.mjs'), source);
    return directory;
}

async function instance() {
    const uin = String(nextAccount++);
    const bridge = {
        events: new BridgeEventBus(),
        identity: { initialization: Promise.resolve(), nickname: `user-${uin}`, groups: [] },
        receiveHealthy: true,
        apis: { contacts: { fetchDownloadRKeys: async () => [] } },
    } as unknown as BridgeInterface;
    const config = makeDefaultOneBotConfig();
    config.networks = { httpServers: [], httpClients: [], wsServers: [], wsClients: [] };
    config.statusCommand.enabled = false;
    const account = new OneBotInstance(uin, bridge, config, defaultGlobalSettings());
    instances.push(account);
    expect((await account.waitUntilNetworkReady()).applied).toBe(true);
    return account;
}

function setProbe(value: unknown): void {
    (globalThis as Record<string, unknown>).__instancePluginProbe = value;
}

afterEach(async () => {
    for (const account of instances.splice(0)) {
        await account.dispose();
    }

    delete (globalThis as Record<string, unknown>).__instancePluginProbe;
    vi.restoreAllMocks();
});

describe('OneBot account plugin integration', () => {
    it('defaults off; explicitly invokes the real account handler and keeps credentials out of context', async () => {
        const directory = await plugin(`
            globalThis.__instancePluginProbe.evaluated++;
            export async function plugin_init(c) {
                const p = globalThis.__instancePluginProbe;
                p.context = c;
                p.result = await c.actions.call('get_login_info', {}, c.adapterName, c.pluginManager.config);
                try { await c.actions.call('download_file_stream', {}, c.adapterName, c.pluginManager.config); }
                catch (e) { p.streamError = e.message; }
            }
        `);
        const probe: { evaluated: number; context?: any; result?: unknown; streamError?: string } =
            { evaluated: 0 };
        setProbe(probe);
        const account = await instance();
        const observed = vi.fn();
        account.observeActions(observed);
        expect(account.listPlugins()).toEqual([]);
        expect(probe.evaluated).toBe(0);
        await account.enablePlugin('demo', directory);
        expect(probe.evaluated).toBe(1);
        expect(probe.result).toEqual({
            user_id: Number(account.uin),
            nickname: `user-${account.uin}`,
        });
        expect(observed).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'get_login_info' }),
        );
        expect(probe.streamError).toContain('stream action');
        expect(probe.context.pluginManager.config).toEqual({});
        expect(probe.context.dataPath).toBe(
            path.join(process.cwd(), 'data', 'plugins', account.uin, 'demo'),
        );
        expect(account.getPluginStatus('demo')).toMatchObject({
            state: 'active',
            pendingActions: 0,
            processResources: 'unknown',
        });
        await account.disablePlugin('demo');
        expect(account.getPluginStatus('demo')).toBeNull();
    });

    it('reports enable capability as a snapshot and rechecks after quiesce', async () => {
        const directory = await plugin(`export function plugin_init() {}`);
        const account = await instance();
        expect(account.canEnablePlugins()).toBe(true);
        account.quiesce();
        expect(account.canEnablePlugins()).toBe(false);
        await expect(account.enablePlugin('demo', directory)).rejects.toThrow('disposing');
        expect(account.listPlugins()).toEqual([]);
        await account.dispose();
        expect(account.canEnablePlugins()).toBe(false);
    });

    it('isolates account actions, state and event delivery while plugin errors do not block v11', async () => {
        const directory = await plugin(`
            export async function plugin_init(c) { globalThis.__instancePluginProbe.contexts.push(c); }
            export async function plugin_onevent(c, e) {
                globalThis.__instancePluginProbe.events.push([c.dataPath, e.user_id]);
                throw new Error('synthetic hook failure');
            }
        `);
        const probe: { contexts: any[]; events: unknown[] } = { contexts: [], events: [] };
        setProbe(probe);
        const a = await instance();
        const b = await instance();
        await Promise.all([a.enablePlugin('demo', directory), b.enablePlugin('demo', directory)]);
        const observed = vi.fn();
        a.subscribeDebugEvents(observed);
        await a.emitBotStatus('online');
        await vi.waitFor(() => expect(probe.events).toHaveLength(1));
        expect(observed).toHaveBeenCalledOnce();
        expect(probe.events[0]).toEqual([expect.stringContaining(a.uin), Number(a.uin)]);
        expect(probe.contexts[0].dataPath).not.toBe(probe.contexts[1].dataPath);
        const values = await Promise.all(
            probe.contexts.map((c) =>
                c.actions.call('get_login_info', {}, c.adapterName, c.pluginManager.config),
            ),
        );
        expect(values.map((x: { user_id: number }) => x.user_id).sort()).toEqual(
            [Number(a.uin), Number(b.uin)].sort(),
        );
    });

    it('keeps v11 flowing under event backpressure and drains admitted hooks before stores close', async () => {
        const gate = deferred();
        const probe = { gate: gate.promise, started: 0, finished: 0, cleanup: 0 };
        setProbe(probe);
        const directory = await plugin(`
            export function plugin_init() {}
            export async function plugin_onevent() {
                globalThis.__instancePluginProbe.started++;
                await globalThis.__instancePluginProbe.gate;
                globalThis.__instancePluginProbe.finished++;
            }
            export function plugin_cleanup() { globalThis.__instancePluginProbe.cleanup++; }
        `);
        const account = await instance();
        await account.enablePlugin('demo', directory);
        const debug = vi.fn();
        account.subscribeDebugEvents(debug);

        for (let i = 0; i < 70; i++) {
            await account.emitBotStatus('online');
        }

        expect(debug).toHaveBeenCalledTimes(70);
        await vi.waitFor(() => expect(probe.started).toBe(1));
        const closing = account.dispose();
        await Promise.resolve();
        expect(probe.cleanup).toBe(0);
        expect(probe.finished).toBe(0);
        gate.resolve();
        await closing;
        expect(probe.finished).toBe(64);
        expect(probe.cleanup).toBe(1);
    });

    it('retains cleanup failures and stores until a later dispose retries', async () => {
        const probe = { calls: 0, closed: '' };
        setProbe(probe);
        const directory = await plugin(`
            export function plugin_init() {}
            export async function plugin_cleanup(c) {
                const p = globalThis.__instancePluginProbe;
                p.calls++;
                try { await c.actions.call('get_login_info', {}, c.adapterName, c.pluginManager.config); }
                catch (e) { p.closed = e.code; }
                if (p.calls === 1) throw Error('fixture');
            }
        `);
        const account = await instance();
        await account.enablePlugin('demo', directory);
        const store = (account as unknown as { messageStore: { close(): Promise<void> } })
            .messageStore;
        const close = vi.spyOn(store, 'close');
        await expect(account.dispose()).rejects.toThrow('plugin shutdown incomplete');
        expect(close).not.toHaveBeenCalled();
        expect(probe.closed).toBe('ACTION_EXECUTION_FAILED');
        expect(account.getPluginStatus('demo')).toMatchObject({
            state: 'cleanup_failed',
            cleanupFailed: true,
        });
        await expect(account.dispose()).resolves.toMatchObject({ closed: true });
        expect(probe.calls).toBe(2);
        expect(close).toHaveBeenCalledOnce();
    });

    it('handles enable versus disable or dispose and failed initialization', async () => {
        const gate = deferred();
        const probe = { gate: gate.promise, entered: false, cleanup: 0 };
        setProbe(probe);
        const directory = await plugin(`
            export async function plugin_init() { globalThis.__instancePluginProbe.entered = true; await globalThis.__instancePluginProbe.gate; }
            export function plugin_cleanup() { globalThis.__instancePluginProbe.cleanup++; }
        `);
        const account = await instance();
        const enabling = account.enablePlugin('demo', directory);
        await vi.waitFor(() => expect(probe.entered).toBe(true));
        const disabling = account.disablePlugin('demo');
        gate.resolve();
        await expect(enabling).rejects.toMatchObject({ code: 'DISABLED' });
        await disabling;
        expect(probe.cleanup).toBe(1);
        const bad = await plugin(`export function plugin_init() { throw Error('fixture'); }`);
        await expect(account.enablePlugin('bad', bad)).rejects.toMatchObject({
            code: 'ENABLE_FAILED',
        });
        const opening = account.enablePlugin('demo', directory);
        const closing = account.dispose();
        await expect(opening).rejects.toMatchObject({ code: 'CLOSED' });
        await closing;
    });

    it('sends a reported self-message to plugins once after duplicate suppression', async () => {
        const probe = { events: [] as JsonObject[] };
        setProbe(probe);
        const directory = await plugin(`
            export function plugin_init() {}
            export function plugin_onevent(_c, event) { globalThis.__instancePluginProbe.events.push(event); }
        `);
        const account = await instance();
        await account.enablePlugin('demo', directory);
        const debug = vi.fn();
        account.subscribeDebugEvents(debug);
        const dispatch = (
            account as unknown as {
                dispatchEvent(event: JsonObject, source: 'send' | 'bridge'): Promise<void>;
            }
        ).dispatchEvent.bind(account);
        const event: JsonObject = {
            time: 1700000000,
            self_id: Number(account.uin),
            post_type: 'message_sent',
            message_type: 'private',
            sub_type: 'friend',
            message_id: 987654,
            message_seq: 9,
            user_id: Number(account.uin),
            target_id: 20002,
            message: [{ type: 'text', data: { text: 'fixture' } }],
            raw_message: 'fixture',
        };
        await dispatch(event, 'send');
        await dispatch({ ...event }, 'bridge');
        await vi.waitFor(() => expect(probe.events).toHaveLength(1));
        expect(debug).toHaveBeenCalledOnce();
    });

    it('waits for a detached tracked plugin action before closing account stores', async () => {
        const gate = deferred();
        const probe: { context?: any } = {};
        setProbe(probe);
        const directory = await plugin(
            `export function plugin_init(c) { globalThis.__instancePluginProbe.context = c; }`,
        );
        const account = await instance();
        await account.enablePlugin('demo', directory);
        const internal = account as unknown as {
            apiHandler: { handle(action: string, params: JsonObject): Promise<unknown> };
            messageStore: { close(): Promise<void> };
        };
        const handle = internal.apiHandler.handle.bind(internal.apiHandler);
        const close = vi.spyOn(internal.messageStore, 'close');
        vi.spyOn(internal.apiHandler, 'handle').mockImplementation(async (action, params) => {
            await gate.promise;
            return handle(action, params);
        });
        const c = probe.context;
        const action = c.actions.call('get_login_info', {}, c.adapterName, c.pluginManager.config);
        expect(account.getPluginStatus('demo')?.pendingActions).toBe(1);
        const closing = account.dispose();
        await Promise.resolve();
        expect(close).not.toHaveBeenCalled();
        gate.resolve();
        // This synthetic delayed dispatch reaches the handler after quiesce.
        await expect(action).rejects.toMatchObject({ code: 'ACTION_FAILED_100' });
        await closing;
        expect(close).toHaveBeenCalledOnce();
    });

    it('rejects a redirected plugin state root before executing the selected ESM', async () => {
        const oldCwd = process.cwd();
        const workspace = await mkdtemp(path.join(oldCwd, 'isolated-workspace-'));
        const external = await mkdtemp(path.join(oldCwd, 'external-state-'));
        const probe = { evaluated: 0 };
        setProbe(probe);
        const directory = await plugin(
            `globalThis.__instancePluginProbe.evaluated++; export function plugin_init() {}`,
        );
        process.chdir(workspace);

        try {
            const account = await instance();
            await mkdir(path.join(workspace, 'data'), { recursive: true });
            await symlink(external, path.join(workspace, 'data', 'plugins'), 'junction');
            await expect(account.enablePlugin('demo', directory)).rejects.toThrow('state root');
            expect(probe.evaluated).toBe(0);
            expect(account.listPlugins()).toEqual([]);
            await account.dispose();
        } finally {
            process.chdir(oldCwd);
        }
    });

    it('omits events filtered by the existing command path', async () => {
        const probe = { events: [] as JsonObject[] };
        setProbe(probe);
        const directory = await plugin(`
            export function plugin_init() {}
            export function plugin_onevent(_c, e) { globalThis.__instancePluginProbe.events.push(e); }
        `);
        const account = await instance();
        await account.enablePlugin('demo', directory);
        const internal = account as unknown as {
            ctx: {
                config: {
                    statusCommand: {
                        enabled: boolean;
                        swallow: boolean;
                        trigger: string;
                        cooldownSeconds: number;
                    };
                };
            };
            statusCommandCooldown: Map<string, number>;
            dispatchEvent(event: JsonObject, source: 'bridge'): Promise<void>;
        };
        internal.ctx.config.statusCommand = {
            enabled: true,
            swallow: true,
            trigger: '#sl',
            cooldownSeconds: 60,
        };
        internal.statusCommandCooldown.set('p:20002', Date.now());
        await internal.dispatchEvent(
            { post_type: 'message', message_type: 'private', user_id: 20002, message: '#sl' },
            'bridge',
        );
        await account.emitBotStatus('online');
        await vi.waitFor(() => expect(probe.events).toHaveLength(1));
        expect(probe.events[0].notice_type).toBe('bot_status');
    });
});
