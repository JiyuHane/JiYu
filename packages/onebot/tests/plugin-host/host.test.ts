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

function makeHost(root: string, accountId = '123', maxPendingEvents = 2) {
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
