import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiHandler, type ApiActionContext } from '../../src/api-handler';
import { PluginHost, type PluginHostOptions } from '../../src/plugin-host';
import { createCompiledTestHandler, testAction } from '../helpers/compiled-action-handler';

const fsGate = vi.hoisted(() => ({
    target: '',
    gate: undefined as Promise<void> | undefined,
    entered: undefined as (() => void) | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...original,
        realpath: async (target: string) => {
            if (target === fsGate.target && fsGate.gate) {
                fsGate.entered?.();
                await fsGate.gate;
            }

            return original.realpath(target);
        },
    };
});

const roots: string[] = [];

async function fixture(source: string): Promise<{ root: string; plugin: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'jiyu-plugin-'));
    roots.push(root);
    const plugin = path.join(root, 'plugin');
    await mkdir(plugin);
    await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
    await writeFile(path.join(plugin, 'index.mjs'), source);
    return { root, plugin };
}

function makeHost(
    root: string,
    accountId = '123',
    maxPendingEvents = 2,
    configOptions: Partial<PluginHostOptions> = {},
) {
    const handler = new ApiHandler({
        getLoginInfo: () => ({ userId: Number(accountId), nickname: 'fixture' }),
    } as ApiActionContext);
    const logger = vi.fn();
    const host = new PluginHost({
        accountId,
        stateRoot: path.join(root, 'state'),
        managerConfig: Object.freeze({ fixture: true }),
        invokeAction: (name, params) => handler.handle(name, params),
        isStreamAction: (name) => handler.isStreamAction(name),
        logger,
        maxPendingEvents,
        ...configOptions,
    });
    return { host, logger };
}

afterEach(async () => {
    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }

    delete (globalThis as Record<string, unknown>).__jiyuProbe;
    fsGate.target = '';
    fsGate.gate = undefined;
    fsGate.entered = undefined;
});

describe('independent account plugin host', () => {
    it('only executes on enable, invokes real account handler, and orders event hooks', async () => {
        const { root, plugin } = await fixture(`
            globalThis.__jiyuProbe.evaluated++;
            export async function plugin_init(c) {
                globalThis.__jiyuProbe.contexts.push(c);
                globalThis.__jiyuProbe.result = await c.actions.call('get_login_info', undefined, c.adapterName, c.pluginManager.config);
            }
            export async function plugin_onevent(c, e) { globalThis.__jiyuProbe.events.push('event:' + e.post_type); }
            export async function plugin_onmessage(c, e) { globalThis.__jiyuProbe.events.push('message:' + e.post_type); }
            export async function plugin_cleanup() { globalThis.__jiyuProbe.events.push('cleanup'); }
        `);
        const probe: {
            evaluated: number;
            contexts: Array<any>;
            events: string[];
            result?: unknown;
        } = { evaluated: 0, contexts: [], events: [] };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        const { host } = makeHost(root);
        expect(probe.evaluated).toBe(0);
        await host.enable('demo', plugin);
        expect(probe.result).toEqual({ user_id: 123, nickname: 'fixture' });
        expect(host.dispatch({ post_type: 'notice' })).toEqual({ accepted: 1, dropped: 0 });
        expect(host.dispatch({ post_type: 'message', message_type: 'group' })).toEqual({
            accepted: 1,
            dropped: 0,
        });
        await host.shutdown();
        expect(probe.events).toEqual([
            'event:notice',
            'event:message',
            'message:message',
            'cleanup',
        ]);
        await expect(
            probe.contexts[0].actions.call(
                'get_login_info',
                {},
                probe.contexts[0].adapterName,
                probe.contexts[0].pluginManager.config,
            ),
        ).rejects.toMatchObject({ code: 'PLUGIN_INACTIVE' });
    });

    it('isolates accounts, rejects unsupported actions and unsupported context features', async () => {
        const { root, plugin } = await fixture(
            `export async function plugin_init(c) { globalThis.__jiyuProbe.push(c); }`,
        );
        const contexts: Array<any> = [];
        (globalThis as Record<string, unknown>).__jiyuProbe = contexts;
        const first = makeHost(root, '123').host;
        const second = makeHost(root, '456').host;
        await Promise.all([first.enable('demo', plugin), second.enable('demo', plugin)]);
        expect(contexts).toHaveLength(2);
        expect(contexts[0].dataPath).not.toBe(contexts[1].dataPath);

        for (const context of contexts) {
            await expect(
                context.actions.call(
                    'missing_action',
                    {},
                    context.adapterName,
                    context.pluginManager.config,
                ),
            ).rejects.toMatchObject({ code: expect.stringMatching(/^ACTION_FAILED_/) });
            await expect(
                context.actions.call('get_login_info', {}, context.adapterName, {}),
            ).rejects.toMatchObject({ code: 'INVALID_ACTION_CONTEXT' });
            expect(() => context.core).toThrow('Unsupported plugin feature');
            expect(() => context.pluginManager.someMethod).toThrow('Unsupported plugin feature');
            expect(() => context.getPluginExports('x')).toThrow('Unsupported plugin feature');
        }

        const results = await Promise.all(
            contexts.map((c) =>
                c.actions.call('get_login_info', {}, c.adapterName, c.pluginManager.config),
            ),
        );
        expect(results.map((r) => r.user_id).sort()).toEqual([123, 456]);
        await Promise.all([first.shutdown(), second.shutdown()]);
    });

    it('bounds queues, isolates failures and drains before cleanup', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init() {}
            export async function plugin_onevent(c, e) {
                globalThis.__jiyuProbe.events.push('start:' + e.n);
                if (e.n === 1) await globalThis.__jiyuProbe.gate;
                if (e.n === 2) throw new Error('PRIVATE_TOKEN');
                globalThis.__jiyuProbe.events.push('end:' + e.n);
            }
            export function plugin_onmessage() { globalThis.__jiyuProbe.events.push('message'); }
            export function plugin_cleanup() { globalThis.__jiyuProbe.events.push('cleanup'); }
        `);
        let release!: () => void;
        const probe = {
            events: [] as string[],
            gate: new Promise<void>((resolve) => {
                release = resolve;
            }),
        };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        const { host, logger } = makeHost(root);
        await host.enable('demo', plugin);
        expect(host.dispatch({ n: 1, message_type: 'private' }).accepted).toBe(1);
        expect(host.dispatch({ n: 2, message_type: 'private' }).accepted).toBe(1);
        expect(host.dispatch({ n: 3 }).dropped).toBe(1);
        const closing = host.shutdown();
        expect(host.dispatch({ n: 4 }).accepted).toBe(0);
        await Promise.resolve();
        expect(probe.events).not.toContain('cleanup');
        release();
        await closing;
        expect(probe.events).toEqual(['start:1', 'end:1', 'message', 'start:2', 'cleanup']);
        expect(JSON.stringify(logger.mock.calls)).not.toContain('PRIVATE_TOKEN');
    });

    it('calls cleanup on failed init and serializes enable/disable/shutdown races', async () => {
        const { root, plugin } = await fixture(`
            export async function plugin_init() { globalThis.__jiyuProbe.push('init'); throw Error('PRIVATE_TOKEN'); }
            export async function plugin_cleanup() { globalThis.__jiyuProbe.push('cleanup'); }
        `);
        const events: string[] = [];
        (globalThis as Record<string, unknown>).__jiyuProbe = events;
        const { host } = makeHost(root);
        await expect(host.enable('demo', plugin)).rejects.toMatchObject({ code: 'ENABLE_FAILED' });
        expect(events).toEqual(['init', 'cleanup']);
        const opening = host.enable('demo', plugin);
        const disabling = host.disable('demo');
        const closing = host.shutdown();
        await expect(opening).rejects.toMatchObject({ code: 'CLOSED' });
        await Promise.all([disabling, closing]);
    });

    it('preserves falsy successful data and rejects stream actions through a real handler', async () => {
        const { root, plugin } = await fixture(
            `export function plugin_init(c) { globalThis.__jiyuProbe = c; }`,
        );
        const handler = createCompiledTestHandler({} as never, [
            testAction('null_value', () => ({ status: 'ok', retcode: 0, data: null })),
            testAction('zero_value', () => ({ status: 'ok', retcode: 0, data: 0 })),
            testAction('false_value', () => ({ status: 'ok', retcode: 0, data: false })),
        ]);
        const host = new PluginHost({
            accountId: '123',
            stateRoot: path.join(root, 'state'),
            managerConfig: {},
            invokeAction: (name, params) => handler.handle(name, params),
            isStreamAction: (name) => name === 'stream_fixture',
            logger: () => {},
        });
        await host.enable('demo', plugin);
        const ctx = (globalThis as Record<string, any>).__jiyuProbe;

        for (const [name, value] of [
            ['null_value', null],
            ['zero_value', 0],
            ['false_value', false],
        ] as const) {
            await expect(
                ctx.actions.call(name, undefined, ctx.adapterName, ctx.pluginManager.config),
            ).resolves.toBe(value);
        }

        await expect(
            ctx.actions.call('stream_fixture', {}, ctx.adapterName, ctx.pluginManager.config),
        ).rejects.toThrow('Unsupported plugin feature');
        await host.shutdown();
    });

    it('waits for an in-progress init and cleans up when shutdown races', async () => {
        const { root, plugin } = await fixture(`
            export async function plugin_init() { globalThis.__jiyuProbe.started(); await globalThis.__jiyuProbe.gate; }
            export function plugin_cleanup() { globalThis.__jiyuProbe.cleaned = true; }
        `);
        let release!: () => void;
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        const probe = {
            started,
            gate: new Promise<void>((resolve) => {
                release = resolve;
            }),
            cleaned: false,
        };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        const { host } = makeHost(root);
        const opening = host.enable('demo', plugin);
        await ready;
        const closing = host.shutdown();
        expect(probe.cleaned).toBe(false);
        release();
        await expect(opening).rejects.toMatchObject({ code: 'CLOSED' });
        await closing;
        expect(probe.cleaned).toBe(true);
    });

    it('uses an ESM fallback entry only on enable, without bypassing path checks', async () => {
        const { root, plugin } = await fixture(
            `globalThis.__jiyuProbe.push('index'); export function plugin_init() {}`,
        );
        await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ type: 'module' }));
        await writeFile(
            path.join(plugin, 'main.mjs'),
            `globalThis.__jiyuProbe.push('main'); export function plugin_init() {}`,
        );
        const events: string[] = [];
        (globalThis as Record<string, unknown>).__jiyuProbe = events;
        const { host } = makeHost(root);
        expect(events).toEqual([]);
        await host.enable('demo', plugin);
        expect(events).toEqual(['index']);
        await host.disable('demo');
        await rm(path.join(plugin, 'index.mjs'));
        await host.enable('demo', plugin);
        expect(events).toEqual(['index', 'main']);
        await host.disable('demo');
        await rm(path.join(plugin, 'main.mjs'));
        await expect(host.enable('demo', plugin)).rejects.toMatchObject({ code: 'INVALID_ENTRY' });
        await writeFile(path.join(root, 'outside.mjs'), `export function plugin_init() {}`);

        try {
            await symlink(path.join(root, 'outside.mjs'), path.join(plugin, 'index.mjs'), 'file');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') {
                await host.shutdown();
                return;
            }

            throw error;
        }

        await expect(host.enable('demo', plugin)).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
        await host.shutdown();
    });

    it('classifies messages before a plugin mutates event fields', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init() {}
            export function plugin_onevent(c,e) {
                if (e.post_type === 'notice') e.message_type = 'group';
                else delete e.message_type;
            }
            export function plugin_onmessage(c,e) { globalThis.__jiyuProbe.push(e.post_type); }
        `);
        const events: string[] = [];
        (globalThis as Record<string, unknown>).__jiyuProbe = events;
        const { host } = makeHost(root);
        await host.enable('demo', plugin);
        host.dispatch({ post_type: 'notice' });
        host.dispatch({ post_type: 'message', message_type: 'group' });
        await host.shutdown();
        expect(events).toEqual(['message']);
    });

    it('observes async logger rejections in plugin and host diagnostic paths', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init(c) { c.logger.log('fixture'); }
            export function plugin_onevent() { throw Error('PRIVATE_PLUGIN'); }
        `);
        const calls: unknown[] = [];
        const errors: unknown[] = [];

        const onUnhandled = (error: unknown) => {
            errors.push(error);
        };

        process.on('unhandledRejection', onUnhandled);
        const host = new PluginHost({
            accountId: '123',
            stateRoot: path.join(root, 'state'),
            managerConfig: {},
            invokeAction: async () => ({ status: 'ok', retcode: 0, data: null }),
            isStreamAction: () => false,
            logger: async (...args) => {
                calls.push(args);
                throw Error('PRIVATE_LOGGER');
            },
        });

        try {
            await host.enable('demo', plugin);
            host.dispatch({ post_type: 'notice' });
            await host.shutdown();
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(calls).toHaveLength(2);
            expect(errors).toEqual([]);
            expect(JSON.stringify(calls)).not.toContain('PRIVATE_');
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });

    it('cancels an in-progress enable on disable and permits later retry', async () => {
        const { root, plugin } = await fixture(`
            export async function plugin_init() { globalThis.__jiyuProbe.started(); await globalThis.__jiyuProbe.gate; }
            export function plugin_cleanup() { globalThis.__jiyuProbe.cleaned++; }
        `);
        let release!: () => void;
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        const probe = {
            started,
            gate: new Promise<void>((resolve) => {
                release = resolve;
            }),
            cleaned: 0,
        };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        const { host } = makeHost(root);
        const opening = host.enable('demo', plugin);
        await ready;
        const disabling = host.disable('demo');
        const duplicate = host.disable('demo');
        const other = host.enable('other', plugin);
        release();
        await expect(opening).rejects.toMatchObject({ code: 'DISABLED' });
        expect(host.dispatch({ post_type: 'notice' }).accepted).toBe(0);
        await Promise.all([disabling, duplicate, other]);
        expect(probe.cleaned).toBe(1);
        await host.enable('demo', plugin);
        expect(host.dispatch({ post_type: 'notice' }).accepted).toBe(2);
        await host.shutdown();
        expect(probe.cleaned).toBe(3);
    });

    it('captures constructor options once and keeps account paths bound', async () => {
        const { root, plugin } = await fixture(
            `export function plugin_init(c) { globalThis.__jiyuProbe.push(c.dataPath); }`,
        );
        const paths: string[] = [];
        (globalThis as Record<string, unknown>).__jiyuProbe = paths;
        let reads = 0;
        const settings: PluginHostOptions = {
            get accountId() {
                return ++reads === 1 ? '123' : '../outside';
            },
            stateRoot: path.join(root, 'state'),
            managerConfig: {},
            invokeAction: async () => ({ status: 'ok', retcode: 0, data: null }),
            isStreamAction: () => false,
            logger: () => {},
        };
        const host = new PluginHost(settings);
        settings.stateRoot = path.join(root, 'redirected');
        await host.enable('demo', plugin);
        expect(reads).toBe(1);
        expect(paths[0]).toBe(path.join(root, 'state', '123', 'demo'));
        await expect(
            import('node:fs/promises').then((fs) => fs.stat(path.join(root, 'outside'))),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(
            import('node:fs/promises').then((fs) => fs.stat(path.join(root, 'redirected'))),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        await host.shutdown();
        const mutable: PluginHostOptions = {
            ...settings,
            accountId: '222',
            stateRoot: path.join(root, 'second'),
        };
        const second = new PluginHost(mutable);
        mutable.accountId = '999';
        await second.enable('demo', plugin);
        expect(paths[1]).toBe(path.join(root, 'second', '222', 'demo'));
        await second.shutdown();
    });

    it('rejects oversized and non-file manifests without executing entry code', async () => {
        const { root, plugin } = await fixture(
            `globalThis.__jiyuProbe.push('executed'); export function plugin_init() {}`,
        );
        const events: string[] = [];
        (globalThis as Record<string, unknown>).__jiyuProbe = events;
        const { host } = makeHost(root);
        await writeFile(path.join(plugin, 'package.json'), ' '.repeat(65537));
        await expect(host.enable('demo', plugin)).rejects.toMatchObject({
            code: 'MANIFEST_TOO_LARGE',
        });
        await rm(path.join(plugin, 'package.json'));
        await mkdir(path.join(plugin, 'package.json'));
        await expect(host.enable('demo', plugin)).rejects.toMatchObject({
            code: 'INVALID_MANIFEST',
        });
        expect(events).toEqual([]);
        await host.shutdown();
    });

    it('retains failed cleanup, denies actions and retries disable once', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init(c) { globalThis.__jiyuProbe.ctx = c; }
            export async function plugin_cleanup() {
                const p = globalThis.__jiyuProbe;
                p.calls++;
                if (p.calls === 1) throw Error('PRIVATE_CLEANUP');
                p.started(); await p.gate; p.successes++;
            }
        `);
        let release!: () => void;
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        const probe: {
            ctx?: any;
            calls: number;
            successes: number;
            started: () => void;
            gate: Promise<void>;
        } = {
            calls: 0,
            successes: 0,
            started,
            gate: new Promise((resolve) => {
                release = resolve;
            }),
        };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        const { host } = makeHost(root);
        await host.enable('demo', plugin);
        expect(host.listStatuses()).toMatchObject([
            { id: 'demo', state: 'active', processResources: 'unknown' },
        ]);
        await expect(host.disable('demo')).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
        expect(host.listStatuses()).toMatchObject([
            { id: 'demo', state: 'cleanup_failed', cleanupFailed: true },
        ]);
        expect(host.dispatch({ post_type: 'notice' }).accepted).toBe(0);
        await expect(
            probe.ctx.actions.call(
                'get_login_info',
                {},
                probe.ctx.adapterName,
                probe.ctx.pluginManager.config,
            ),
        ).rejects.toMatchObject({ code: 'PLUGIN_INACTIVE' });
        const retry = host.disable('demo');
        await ready;
        expect(host.listStatuses()).toMatchObject([
            { id: 'demo', state: 'stopping', cleanupFailed: true },
        ]);
        await expect(
            probe.ctx.actions.call(
                'get_login_info',
                {},
                probe.ctx.adapterName,
                probe.ctx.pluginManager.config,
            ),
        ).rejects.toMatchObject({ code: 'PLUGIN_INACTIVE' });
        release();
        await retry;
        await host.disable('demo');
        expect(probe.calls).toBe(2);
        expect(probe.successes).toBe(1);
        expect(host.listStatuses()).toEqual([]);
        await host.shutdown();
    });

    it('exposes init failure while cleanup is pending and retains failed cleanup for retry', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init(c) { globalThis.__jiyuProbe.ctx = c; throw Error('SECRET_INIT'); }
            export async function plugin_cleanup() {
                const p = globalThis.__jiyuProbe; p.calls++;
                if (p.calls === 1) { p.started(); await p.gate; throw Error('SECRET_CLEANUP'); }
            }
        `);
        let release!: () => void;
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        const probe: { ctx?: any; calls: number; started: () => void; gate: Promise<void> } = {
            calls: 0,
            started,
            gate: new Promise((resolve) => {
                release = resolve;
            }),
        };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        const { host } = makeHost(root);
        const opening = host.enable('demo', plugin);
        await ready;
        expect(host.listStatuses()).toMatchObject([
            { id: 'demo', state: 'initializing', initializationFailed: true },
        ]);
        release();
        await expect(opening).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
        expect(host.listStatuses()).toMatchObject([
            {
                id: 'demo',
                state: 'cleanup_failed',
                cleanupFailed: true,
                initializationFailed: true,
                processResources: 'unknown',
            },
        ]);
        expect(JSON.stringify(host.listStatuses())).not.toContain('SECRET');
        await expect(
            probe.ctx.actions.call(
                'get_login_info',
                {},
                probe.ctx.adapterName,
                probe.ctx.pluginManager.config,
            ),
        ).rejects.toMatchObject({ code: 'PLUGIN_INACTIVE' });
        await host.disable('demo');
        expect(probe.calls).toBe(2);
        expect(host.listStatuses()).toEqual([]);
        await host.shutdown();
    });

    it('continues shutdown after cleanup failure and retries only failed plugins', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init(c) { globalThis.__jiyuProbe.contexts[c.pluginName] = c; }
            export function plugin_cleanup(c) {
                const p = globalThis.__jiyuProbe;
                p.calls[c.pluginName] = (p.calls[c.pluginName] ?? 0) + 1;
                if (c.pluginName === 'bad' && p.calls.bad === 1) throw Error('PRIVATE_SHUTDOWN');
            }
        `);
        const probe: { contexts: Record<string, any>; calls: Record<string, number> } = {
            contexts: {},
            calls: {},
        };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        const { host } = makeHost(root);
        await host.enable('bad', plugin);
        await host.enable('good', plugin);
        const first = host.shutdown();
        expect(host.shutdown()).toBe(first);
        await expect(first).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
        expect(probe.calls).toEqual({ bad: 1, good: 1 });
        expect(host.listStatuses()).toMatchObject([{ id: 'bad', state: 'cleanup_failed' }]);
        const ctx = probe.contexts.bad;
        await expect(
            ctx.actions.call('get_login_info', {}, ctx.adapterName, ctx.pluginManager.config),
        ).rejects.toMatchObject({ code: 'PLUGIN_INACTIVE' });
        await host.shutdown();
        await host.shutdown();
        expect(probe.calls).toEqual({ bad: 2, good: 1 });
        expect(host.listStatuses()).toEqual([]);
    });

    it('cancels before import while resolving paths without executing top level', async () => {
        const { root, plugin } = await fixture(
            `globalThis.__jiyuProbe.push('top'); export function plugin_init() { globalThis.__jiyuProbe.push('init'); }`,
        );
        const events: string[] = [];
        (globalThis as Record<string, unknown>).__jiyuProbe = events;
        let release!: () => void;
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
        });
        fsGate.target = plugin;
        fsGate.entered = entered;
        fsGate.gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { host } = makeHost(root);
        const opening = host.enable('demo', plugin);
        await ready;
        const stopping = host.disable('demo');
        release();
        await expect(opening).rejects.toMatchObject({ code: 'DISABLED' });
        await stopping;
        expect(events).toEqual([]);
        await host.shutdown();
    });

    it('cancels after an already-started import without invoking init', async () => {
        const { root, plugin } = await fixture(`
            globalThis.__jiyuProbe.events.push('top');
            globalThis.__jiyuProbe.started(); await globalThis.__jiyuProbe.gate;
            export function plugin_init() { globalThis.__jiyuProbe.events.push('init'); }
        `);
        let release!: () => void;
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        const probe = {
            events: [] as string[],
            started,
            gate: new Promise<void>((resolve) => {
                release = resolve;
            }),
        };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        const { host } = makeHost(root);
        const opening = host.enable('demo', plugin);
        await ready;
        const stopping = host.disable('demo');
        release();
        await expect(opening).rejects.toMatchObject({ code: 'DISABLED' });
        await stopping;
        expect(probe.events).toEqual(['top']);
        await host.shutdown();
    });

    it('drains detached init and cleanup actions before returning from disable', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init(c) { globalThis.__jiyuProbe.ctx = c; void c.actions.call('pre', {}, c.adapterName, c.pluginManager.config); }
            export function plugin_cleanup(c) { globalThis.__jiyuProbe.cleanupStarted(); void c.actions.call('cleanup', {}, c.adapterName, c.pluginManager.config); }
        `);
        let cleanupStarted!: () => void;
        const cleanupReady = new Promise<void>((resolve) => {
            cleanupStarted = resolve;
        });
        const probe: { ctx?: any; cleanupStarted: () => void } = { cleanupStarted };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        const release: Record<string, () => void> = {};
        const host = new PluginHost({
            accountId: '123',
            stateRoot: path.join(root, 'state'),
            managerConfig: {},
            invokeAction: async (name) => {
                await new Promise<void>((resolve) => {
                    release[name] = resolve;
                });
                return { status: 'ok', retcode: 0, data: null };
            },
            isStreamAction: () => false,
            logger: () => {},
        });
        await host.enable('demo', plugin);
        expect(host.listStatuses()).toMatchObject([{ id: 'demo', pendingActions: 1 }]);
        let done = false;
        const closing = host.disable('demo').then(() => {
            done = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(done).toBe(false);
        expect(release.cleanup).toBeUndefined();
        release.pre();
        await cleanupReady;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(host.listStatuses()).toMatchObject([
            { id: 'demo', state: 'stopping', pendingActions: 1 },
        ]);
        expect(done).toBe(false);
        await expect(
            probe.ctx.actions.call(
                'late',
                {},
                probe.ctx.adapterName,
                probe.ctx.pluginManager.config,
            ),
        ).rejects.toMatchObject({ code: 'PLUGIN_INACTIVE' });
        release.cleanup();
        await closing;
        expect(done).toBe(true);
        await host.shutdown();
    });

    it('keeps a failed cleanup visible while its detached action is still draining', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init() {}
            export function plugin_cleanup(c) {
                const p = globalThis.__jiyuProbe;
                if (++p.calls === 1) { void c.actions.call('slow', {}, c.adapterName, c.pluginManager.config); throw Error('PRIVATE_CLEANUP'); }
            }
        `);
        const probe = { calls: 0 };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        let release!: () => void;
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const host = new PluginHost({
            accountId: '123',
            stateRoot: path.join(root, 'state'),
            managerConfig: {},
            invokeAction: async () => {
                started();
                await gate;
                return { status: 'ok', retcode: 0, data: null };
            },
            isStreamAction: () => false,
            logger: () => {},
        });
        await host.enable('demo', plugin);
        const closing = host.disable('demo');
        await ready;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(host.listStatuses()).toMatchObject([
            { state: 'cleanup_failed', cleanupFailed: true, pendingActions: 1 },
        ]);
        release();
        await expect(closing).rejects.toMatchObject({ code: 'CLEANUP_FAILED' });
        await host.disable('demo');
        expect(probe.calls).toBe(2);
        await host.shutdown();
    });

    it('lets an accepted hook await an action before draining', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init() {}
            export async function plugin_onevent(c) { await c.actions.call('hook', {}, c.adapterName, c.pluginManager.config); globalThis.__jiyuProbe.push('hook'); }
            export function plugin_cleanup() { globalThis.__jiyuProbe.push('cleanup'); }
        `);
        const events: string[] = [];
        (globalThis as Record<string, unknown>).__jiyuProbe = events;
        let release!: () => void;
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const host = new PluginHost({
            accountId: '123',
            stateRoot: path.join(root, 'state'),
            managerConfig: {},
            invokeAction: async () => {
                started();
                await gate;
                return { status: 'ok', retcode: 0, data: null };
            },
            isStreamAction: () => false,
            logger: () => {},
        });
        await host.enable('demo', plugin);
        host.dispatch({ post_type: 'notice' });
        const closing = host.disable('demo');
        await ready;
        expect(host.listStatuses()).toMatchObject([{ state: 'stopping', pendingActions: 1 }]);
        release();
        await closing;
        expect(events).toEqual(['hook', 'cleanup']);
        await host.shutdown();
    });

    it('drains a detached action even when init fails', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init(c) { void c.actions.call('pre', {}, c.adapterName, c.pluginManager.config); throw Error('INIT_PRIVATE'); }
            export function plugin_cleanup() { globalThis.__jiyuProbe.push('cleanup'); }
        `);
        const events: string[] = [];
        (globalThis as Record<string, unknown>).__jiyuProbe = events;
        let release!: () => void;
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const host = new PluginHost({
            accountId: '123',
            stateRoot: path.join(root, 'state'),
            managerConfig: {},
            invokeAction: async () => {
                started();
                await gate;
                return { status: 'ok', retcode: 0, data: null };
            },
            isStreamAction: () => false,
            logger: () => {},
        });
        const opening = host.enable('demo', plugin);
        await ready;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(host.listStatuses()).toMatchObject([
            { state: 'initializing', initializationFailed: true, pendingActions: 1 },
        ]);
        expect(events).toEqual([]);
        release();
        await expect(opening).rejects.toMatchObject({ code: 'ENABLE_FAILED' });
        expect(events).toEqual(['cleanup']);
        await host.shutdown();
    });

    it('rejects account state redirected to another account', async () => {
        const { root, plugin } = await fixture('export function plugin_init() {}');
        const state = path.join(root, 'state');
        await mkdir(path.join(state, '456'), { recursive: true });

        try {
            await symlink(
                path.join(state, '456'),
                path.join(state, '123'),
                process.platform === 'win32' ? 'junction' : 'dir',
            );
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') {
                return;
            }

            throw error;
        }

        const { host } = makeHost(root);
        await expect(host.enable('demo', plugin)).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
        await host.shutdown();
    });

    it('gives each active slot a distinct opaque configuration generation', async () => {
        const { root, plugin } = await fixture(`
            export async function plugin_init() { globalThis.__jiyuProbe.initStarted(); await globalThis.__jiyuProbe.initGate; }
            export async function plugin_onevent() { globalThis.__jiyuProbe.eventStarted(); await globalThis.__jiyuProbe.eventGate; }
        `);
        let initStarted!: () => void;
        let releaseInit!: () => void;
        let eventStarted!: () => void;
        let releaseEvent!: () => void;
        const initReady = new Promise<void>((resolve) => {
            initStarted = resolve;
        });
        const eventReady = new Promise<void>((resolve) => {
            eventStarted = resolve;
        });
        const probe = {
            initStarted,
            initGate: new Promise<void>((resolve) => {
                releaseInit = resolve;
            }),
            eventStarted,
            eventGate: new Promise<void>((resolve) => {
                releaseEvent = resolve;
            }),
        };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        const first = makeHost(root, '123').host;
        const second = makeHost(root, '123').host;
        const opening = first.enable('demo', plugin);
        await initReady;
        expect(first.getConfigGeneration('demo')).toBeNull();
        releaseInit();
        await opening;
        await second.enable('demo', plugin);
        const generation = first.getConfigGeneration('demo');
        expect(generation).toMatch(/^[0-9a-f-]{36}$/);
        expect(second.getConfigGeneration('demo')).toMatch(/^[0-9a-f-]{36}$/);
        expect(second.getConfigGeneration('demo')).not.toBe(generation);
        expect(first.getConfigGeneration('missing')).toBeNull();
        let coerced = false;
        const invalid = {
            toString: () => {
                coerced = true;
                throw Error('PRIVATE');
            },
        };
        expect(first.getConfigGeneration(invalid as unknown as string)).toBeNull();
        expect(first.getConfigGeneration('../invalid')).toBeNull();
        expect(coerced).toBe(false);
        first.dispatch({ n: 1 });
        await eventReady;
        const stopping = first.disable('demo');
        expect(first.getConfigGeneration('demo')).toBeNull();
        releaseEvent();
        await stopping;
        expect(first.getConfigGeneration('demo')).toBeNull();
        await first.enable('demo', plugin);
        const next = first.getConfigGeneration('demo');
        expect(next).toMatch(/^[0-9a-f-]{36}$/);
        expect(next).not.toBe(generation);
        expect(next).not.toBe(second.getConfigGeneration('demo'));
        const closing = first.shutdown();
        expect(first.getConfigGeneration('demo')).toBeNull();
        await Promise.all([closing, second.shutdown()]);
    });

    it('exposes explicit account-scoped configuration hooks and static schema only', async () => {
        const { root, plugin } = await fixture(`
            let value = { initial: true };
            export function plugin_init() { globalThis.__jiyuProbe.init++; }
            export const plugin_config_schema = [{ name: 'setting' }];
            export const plugin_config_ui = [{ name: 'ignored' }];
            export function plugin_get_config() { globalThis.__jiyuProbe.get++; return value; }
            export function plugin_set_config(c, v) { globalThis.__jiyuProbe.set++; value = v; }
        `);
        const probe = { init: 0, get: 0, set: 0 };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        const a = makeHost(root, '123').host;
        const b = makeHost(root, '456').host;
        await Promise.all([a.enable('demo', plugin), b.enable('demo', plugin)]);
        expect(probe).toEqual({ init: 2, get: 0, set: 0 });
        const schema = await a.getConfigSchema('demo');
        expect(schema).toEqual({ fields: [{ name: 'setting' }], source: 'schema' });
        (schema.fields![0] as Record<string, unknown>).name = 'mutated';
        expect(await a.getConfigSchema('demo')).toEqual({
            fields: [{ name: 'setting' }],
            source: 'schema',
        });
        const input = { nested: { x: 1 } };
        const setting = a.setConfig('demo', input);
        input.nested.x = 99;
        expect(await setting).toEqual({ persistence: 'plugin-managed' });
        const result = await a.getConfig('demo');
        expect(result).toEqual({ value: { nested: { x: 1 } }, source: 'plugin' });
        (result.value.nested as Record<string, unknown>).x = 7;
        expect((await a.getConfig('demo')).value).toEqual({ nested: { x: 1 } });
        expect((await b.getConfig('demo')).value).toEqual({ initial: true });
        await Promise.all([a.shutdown(), b.shutdown()]);
        await expect(a.getConfig('demo')).rejects.toMatchObject({ code: 'PLUGIN_INACTIVE' });
    });

    it('treats schema and hooks independently and never calls schema functions', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init() {}
            export const plugin_config_ui = [{ key: 'ui' }];
        `);
        const host = makeHost(root).host;
        await host.enable('demo', plugin);
        expect(await host.getConfigSchema('demo')).toEqual({
            fields: [{ key: 'ui' }],
            source: 'ui',
        });
        await expect(host.getConfig('demo')).rejects.toMatchObject({ code: 'CONFIG_UNSUPPORTED' });
        await expect(host.setConfig('demo', {})).rejects.toMatchObject({
            code: 'CONFIG_UNSUPPORTED',
        });
        await host.disable('demo');
        await writeFile(
            path.join(plugin, 'index.mjs'),
            `
            export function plugin_init() {}
            export function plugin_config_schema() { globalThis.__jiyuProbe.executed = true; return []; }
            export const plugin_config_ui = [];
        `,
        );
        const probe = { executed: false };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        await host.enable('demo', plugin);
        await expect(host.getConfigSchema('demo')).rejects.toMatchObject({
            code: 'CONFIG_INVALID',
        });
        expect(probe.executed).toBe(false);
        await host.disable('demo');
        await writeFile(path.join(plugin, 'index.mjs'), 'export function plugin_init() {}');
        await host.enable('demo', plugin);
        expect(await host.getConfigSchema('demo')).toEqual({ fields: null, source: 'none' });
        await host.shutdown();
    });

    it('orders events and config FIFO, bounds admission, and drains a stuck config hook', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init() {}
            export async function plugin_onevent(c,e) { globalThis.__jiyuProbe.log.push('event:' + e.n); }
            export async function plugin_set_config(c,v) {
                const p = globalThis.__jiyuProbe; p.log.push('set:' + v.n); p.started(); await p.gate;
            }
            export function plugin_get_config() { globalThis.__jiyuProbe.log.push('get'); return {}; }
            export function plugin_cleanup() { globalThis.__jiyuProbe.log.push('cleanup'); }
        `);
        let release!: () => void;
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        const probe = {
            log: [] as string[],
            started,
            gate: new Promise<void>((resolve) => {
                release = resolve;
            }),
        };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        const host = makeHost(root, '123', 2, {
            maxPendingConfig: 2,
            maxPendingConfigBytes: 14,
        }).host;
        await host.enable('demo', plugin);
        host.dispatch({ n: 1 });
        const first = host.setConfig('demo', { n: 1 });
        await expect(host.setConfig('demo', { n: 222222 })).rejects.toMatchObject({
            code: 'CONFIG_QUEUE_FULL',
        });
        host.dispatch({ n: 2 });
        const second = host.getConfig('demo');
        await expect(host.getConfig('demo')).rejects.toMatchObject({ code: 'CONFIG_QUEUE_FULL' });
        await ready;
        let stopped = false;
        const disable = host.disable('demo').then(() => {
            stopped = true;
        });
        await expect(host.getConfig('demo')).rejects.toMatchObject({ code: 'PLUGIN_INACTIVE' });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(stopped).toBe(false);
        expect(probe.log).toEqual(['event:1', 'set:1']);
        release();
        await Promise.all([first, second, disable]);
        expect(probe.log).toEqual(['event:1', 'set:1', 'event:2', 'get', 'cleanup']);
        await host.shutdown();
    });

    it('bounds config bytes and rejects malformed JSON without accessing proxies or getters', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init() {}
            export function plugin_set_config() { globalThis.__jiyuProbe++; }
        `);
        (globalThis as Record<string, unknown>).__jiyuProbe = 0;
        const host = makeHost(root, '123', 2, { maxPendingConfigBytes: 20 }).host;
        await host.enable('demo', plugin);
        let trapped = 0;
        const proxy = new Proxy(
            {},
            {
                ownKeys() {
                    trapped++;
                    throw Error('PRIVATE');
                },
            },
        );
        const getter = Object.defineProperty({}, 'x', {
            enumerable: true,
            get() {
                trapped++;
                throw Error('PRIVATE');
            },
        });
        const cycle: any = {};
        cycle.self = cycle;
        const sparse = Array(1);
        const deep: any = {};
        let cursor = deep;

        for (let i = 0; i < 33; i++) {
            cursor.x = {};
            cursor = cursor.x;
        }

        for (const value of [
            proxy,
            getter,
            cycle,
            { x: sparse },
            { x: NaN },
            { x: 1n },
            { x: () => {} },
            JSON.parse('{"__proto__":1}'),
            deep,
        ]) {
            await expect(host.setConfig('demo', value as any)).rejects.toMatchObject({
                code: 'CONFIG_INVALID',
            });
        }

        await expect(host.setConfig('demo', { x: 'a'.repeat(30) })).rejects.toMatchObject({
            code: 'CONFIG_QUEUE_FULL',
        });
        await expect(host.setConfig('demo', { x: 'a'.repeat(256 * 1024) })).rejects.toMatchObject({
            code: 'CONFIG_INVALID',
        });
        expect(trapped).toBe(0);
        expect((globalThis as Record<string, unknown>).__jiyuProbe).toBe(0);
        await host.shutdown();
    });

    it('bounds schema and returned values without invoking accessors or proxy traps', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init() {}
            export let plugin_config_schema = [];
            export function plugin_get_config() { return globalThis.__jiyuProbe.value; }
            globalThis.__jiyuProbe.schema = value => { plugin_config_schema = value; };
        `);
        let trapped = 0;
        const probe: { value: unknown; schema?: (value: unknown) => void } = { value: {} };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        const host = makeHost(root).host;
        await host.enable('demo', plugin);
        const proxy = new Proxy(
            {},
            {
                ownKeys() {
                    trapped++;
                    throw Error('PRIVATE');
                },
            },
        );
        const getter = Object.defineProperty({}, 'secret', {
            enumerable: true,
            get() {
                trapped++;
                throw Error('PRIVATE');
            },
        });

        for (const value of [proxy, getter, { n: Infinity }, { x: Array(1) }, 'not-object']) {
            probe.value = value;
            await expect(host.getConfig('demo')).rejects.toMatchObject({
                code: 'CONFIG_OUTCOME_UNKNOWN',
            });
        }

        for (const value of [
            [proxy],
            [getter],
            ['x'.repeat(64 * 1024)],
            new Proxy([], {
                ownKeys() {
                    trapped++;
                    return [];
                },
            }),
        ]) {
            probe.schema!(value);
            await expect(host.getConfigSchema('demo')).rejects.toMatchObject({
                code: 'CONFIG_INVALID',
            });
        }

        let deep: any = 'leaf';

        for (let i = 0; i < 17; i++) {
            deep = [deep];
        }

        probe.schema!(deep);
        await expect(host.getConfigSchema('demo')).rejects.toMatchObject({
            code: 'CONFIG_INVALID',
        });
        probe.schema!(['x'.repeat(65532)]);
        await expect(host.getConfigSchema('demo')).resolves.toMatchObject({ source: 'schema' });
        probe.schema!(['x'.repeat(65533)]);
        await expect(host.getConfigSchema('demo')).rejects.toMatchObject({
            code: 'CONFIG_INVALID',
        });
        expect(trapped).toBe(0);
        await host.shutdown();
    });

    it('rejects same-slot lifecycle reentrancy while preserving external and other-host management', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init() {}
            export async function plugin_onevent() { await globalThis.__jiyuProbe.event(); }
            export async function plugin_get_config() { await globalThis.__jiyuProbe.config(); return { ok: true }; }
            export function plugin_cleanup() { globalThis.__jiyuProbe.cleanups++; }
        `);
        const host = makeHost(root, '123').host;
        const other = makeHost(root, '456').host;
        const errors: Array<{ code: string; stack: string; cause?: unknown }> = [];
        let eventFinished!: () => void;
        const ready = new Promise<void>((resolve) => {
            eventFinished = resolve;
        });
        const probe = {
            cleanups: 0,
            event: async () => {
                errors.push(await host.disable('demo').catch((error) => error));
                errors.push(
                    await Promise.resolve()
                        .then(() => host.shutdown())
                        .catch((error) => error),
                );
                await other.shutdown();
                eventFinished();
            },
            config: async () => {
                errors.push(
                    await Promise.resolve()
                        .then(() => host.disable('demo'))
                        .catch((error) => error),
                );
                errors.push(await host.shutdown().catch((error) => error));
            },
        };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        await host.enable('demo', plugin);
        await other.enable('demo', plugin);
        expect(host.dispatch({ n: 1 }).accepted).toBe(1);
        await ready;
        expect(host.listStatuses()).toMatchObject([{ id: 'demo', state: 'active' }]);
        expect(await host.getConfig('demo')).toEqual({ value: { ok: true }, source: 'plugin' });
        expect(errors).toHaveLength(4);

        for (const error of errors) {
            expect(error.code).toBe('CONFIG_REENTRANT');
            expect(error.stack).toBe('PluginHostError: Plugin host: CONFIG_REENTRANT');
            expect(error.cause).toBeUndefined();
        }

        expect(host.listStatuses()).toMatchObject([{ id: 'demo', state: 'active' }]);
        await host.disable('demo');
        await host.shutdown();
        expect(probe.cleanups).toBe(2);
    });

    it('rejects same-host lifecycle hook reentrancy and expires detached lifecycle tokens', async () => {
        const { root, plugin } = await fixture(`
            export async function plugin_init() { await globalThis.__jiyuProbe.init(); }
            export async function plugin_cleanup() { await globalThis.__jiyuProbe.cleanup(); }
        `);
        const otherFixture = await fixture('export function plugin_init() {}');
        const host = makeHost(root, '123').host;
        const other = makeHost(root, '456').host;
        const errors: Array<{ code: string; stack: string }> = [];
        let releaseInit!: () => void;
        let releaseCleanup!: () => void;
        let releaseShutdown!: () => void;
        const initGate = new Promise<void>((resolve) => {
            releaseInit = resolve;
        });
        const cleanupGate = new Promise<void>((resolve) => {
            releaseCleanup = resolve;
        });
        const shutdownGate = new Promise<void>((resolve) => {
            releaseShutdown = resolve;
        });
        let initDetached!: Promise<void>;
        let cleanupDetached!: Promise<void>;
        let shutdownDetached!: Promise<void>;

        const inspect = async () => {
            errors.push(await host.enable('later', otherFixture.plugin).catch((e) => e));
            errors.push(
                await Promise.resolve()
                    .then(() => host.disable('different'))
                    .catch((e) => e),
            );
            errors.push(await host.shutdown().catch((e) => e));
        };

        const probe = {
            init: async () => {
                await inspect();
                await other.enable('independent', otherFixture.plugin);
                initDetached = initGate.then(() => host.enable('later', otherFixture.plugin));
            },
            cleanup: async () => {
                await inspect();
                cleanupDetached = cleanupGate.then(async () => {
                    await host.enable('after', otherFixture.plugin);
                    await host.disable('later');
                });
                shutdownDetached = shutdownGate.then(() => host.shutdown());
            },
        };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        await host.enable('demo', plugin);
        expect(host.listStatuses()).toMatchObject([{ id: 'demo', state: 'active' }]);
        releaseInit();
        await initDetached;
        await host.disable('demo');
        releaseCleanup();
        await cleanupDetached;
        expect(host.listStatuses().map((item) => item.id)).toEqual(['after']);
        expect(errors).toHaveLength(6);

        for (const error of errors) {
            expect(error).toMatchObject({
                code: 'CONFIG_REENTRANT',
                stack: 'PluginHostError: Plugin host: CONFIG_REENTRANT',
            });
        }

        releaseShutdown();
        await Promise.all([shutdownDetached, other.shutdown()]);
    });

    it('rejects cleanup reentrancy before returning an existing shutdown task', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init() {}
            export async function plugin_cleanup() {
                globalThis.__jiyuProbe.error = await globalThis.__jiyuProbe.host.shutdown().catch(e => e);
            }
        `);
        const host = makeHost(root).host;
        const probe: { host: PluginHost; error?: Error & { code?: string } } = { host };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        await host.enable('demo', plugin);
        await host.shutdown();
        expect(probe.error).toMatchObject({
            code: 'CONFIG_REENTRANT',
            stack: 'PluginHostError: Plugin host: CONFIG_REENTRANT',
        });
    });

    it('expires a detached event token after its hook finishes', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init() {}
            export function plugin_onevent() { globalThis.__jiyuProbe.schedule(); }
            export function plugin_get_config() { return { ok: true }; }
        `);
        const host = makeHost(root).host;
        let release!: () => void;
        let scheduled!: () => void;
        const ready = new Promise<void>((resolve) => {
            scheduled = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let detached!: Promise<unknown>;
        (globalThis as Record<string, unknown>).__jiyuProbe = {
            schedule: () => {
                detached = gate.then(() => host.getConfig('demo'));
                scheduled();
            },
        };
        await host.enable('demo', plugin);
        host.dispatch({ n: 1 });
        await ready;
        await new Promise<void>((resolve) => setImmediate(resolve));
        release();
        await expect(detached).resolves.toEqual({ value: { ok: true }, source: 'plugin' });
        await host.disable('demo');
        await host.shutdown();
    });

    it('rejects a hook shutdown even when an external shutdown already waits for it', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init() {}
            export async function plugin_onevent() {
                const p = globalThis.__jiyuProbe; p.started(); await p.gate;
                p.error = await p.host.shutdown().catch(e => e);
                p.finished = true;
            }
        `);
        let started!: () => void;
        let release!: () => void;
        const ready = new Promise<void>((resolve) => {
            started = resolve;
        });
        const host = makeHost(root).host;
        const probe: {
            host: PluginHost;
            started: () => void;
            gate: Promise<void>;
            error?: Error & { code?: string };
            finished: boolean;
        } = {
            host,
            started,
            gate: new Promise<void>((resolve) => {
                release = resolve;
            }),
            finished: false,
        };
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        await host.enable('demo', plugin);
        host.dispatch({ n: 1 });
        await ready;
        const closing = host.shutdown();
        release();
        await closing;
        expect(probe.finished).toBe(true);
        expect(probe.error).toMatchObject({
            code: 'CONFIG_REENTRANT',
            stack: 'PluginHostError: Plugin host: CONFIG_REENTRANT',
        });
    });

    it('sanitizes hook failures and rejects same-slot reentrant config operations', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init() {}
            export async function plugin_onevent() { globalThis.__jiyuProbe.reentrant = await globalThis.__jiyuProbe.host.getConfig('demo').catch(e => e.code); }
            export function plugin_get_config() { throw Error('SECRET_VALUE /private/path'); }
            export function plugin_set_config() { throw Error('SECRET_VALUE /private/path'); }
        `);
        const probe: { host?: PluginHost; reentrant?: string } = {};
        (globalThis as Record<string, unknown>).__jiyuProbe = probe;
        const host = makeHost(root).host;
        probe.host = host;
        await host.enable('demo', plugin);

        for (const promise of [
            host.getConfig('demo'),
            host.setConfig('demo', { secret: 'PRIVATE_INPUT' }),
        ]) {
            const error = await promise.catch((e) => e);
            expect(error).toMatchObject({ code: 'CONFIG_OUTCOME_UNKNOWN' });
            expect(String(error)).not.toMatch(/SECRET_VALUE|private\/path|PRIVATE_INPUT/);
            expect(error.stack).toBe('PluginHostError: Plugin host: CONFIG_OUTCOME_UNKNOWN');
            expect(error.cause).toBeUndefined();
        }

        host.dispatch({ n: 1 });
        await new Promise<void>((resolve) => setImmediate(resolve));
        await host.disable('demo');
        expect(probe.reentrant).toBe('CONFIG_REENTRANT');
        await host.shutdown();
    });

    it('rejects traversal and escaped entry symlinks', async () => {
        const { root, plugin } = await fixture('export function plugin_init() {}');
        const { host } = makeHost(root);
        await expect(host.enable('../demo', plugin)).rejects.toMatchObject({
            code: 'INVALID_PLUGIN_SELECTION',
        });
        await writeFile(
            path.join(plugin, 'package.json'),
            JSON.stringify({ main: '../outside.mjs' }),
        );
        await expect(host.enable('demo', plugin)).rejects.toMatchObject({ code: 'INVALID_ENTRY' });
        await writeFile(path.join(root, 'outside.mjs'), 'export function plugin_init() {}');
        await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ main: 'escape.mjs' }));

        try {
            await symlink(path.join(root, 'outside.mjs'), path.join(plugin, 'escape.mjs'), 'file');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') {
                await host.shutdown();
                return;
            }

            throw error;
        }

        await expect(host.enable('demo', plugin)).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
        await host.shutdown();
    });
});
