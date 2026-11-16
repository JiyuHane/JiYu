import fs from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginHost, PluginHostOptions } from '../../src/plugin-host';

type PathMethod = (id?: unknown) => string;
type Context = {
    readonly pluginName: string;
    readonly dataPath: string;
    readonly configPath: string;
    readonly pluginManager: {
        readonly config: unknown;
        readonly getPluginDataPath: PathMethod;
        readonly getPluginConfigPath: PathMethod;
    };
};
type Entry = {
    context: Context;
    phase: 'init' | 'event' | 'cleanup';
    number?: number;
    data: string;
    config: string;
};
type Probe = {
    entries: Entry[];
    record: (context: Context, phase: Entry['phase'], n?: number) => void;
};

// Vite-transformed named promise imports are wrapped as well as the native
// fs/default exports below. Setup and teardown are outside the audited window.
const fsAudit = vi.hoisted(() => ({ active: false, calls: [] as string[] }));
const packageWebSocket = vi.hoisted(() =>
    vi.fn(function forbiddenPackageWebSocket() {
        throw new Error('unexpected WebSocket in synthetic plugin fixture');
    }),
);

vi.mock('node:fs/promises', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:fs/promises')>();
    const wrappers: Record<string, unknown> = {};

    for (const [name, value] of Object.entries(original)) {
        if (typeof value === 'function') {
            wrappers[name] = (...args: unknown[]) => {
                if (fsAudit.active) {
                    fsAudit.calls.push(`fs/promises.${name}`);
                    throw new Error('unexpected filesystem access during path query');
                }

                return Reflect.apply(value, original, args);
            };
        }
    }

    return { ...original, ...wrappers, default: { ...original, ...wrappers } };
});

// No WebSocket package implementation or native binding should be loaded.
vi.mock('@snowluma/websocket', () => ({
    default: packageWebSocket,
    WebSocket: packageWebSocket,
    WebSocketClient: packageWebSocket,
    WebSocketServer: packageWebSocket,
    Server: packageWebSocket,
    InternalWebSocket: packageWebSocket,
}));

const roots: string[] = [];
const hosts: PluginHost[] = [];
let Host: typeof import('../../src/plugin-host').PluginHost;
let Unsupported: typeof import('../../src/plugin-host').UnsupportedPluginFeatureError;
let guards: Array<{ mock: { calls: unknown[] } }> = [];
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;

function blocked(): never {
    throw new Error('unexpected transport or native loading in synthetic plugin fixture');
}

// These are spies rather than filesystem mocks: ordinary temporary fixture IO
// passes through, while any IO reached synchronously from a query is stopped.
function guardFileMethods(target: object, names: readonly string[], prefix: string): void {
    const methods = target as Record<string, (...args: unknown[]) => unknown>;

    for (const name of names) {
        const original = methods[name];

        if (typeof original !== 'function') {
            continue;
        }

        const spy = vi.spyOn(methods, name).mockImplementation(function (this: unknown, ...args) {
            if (fsAudit.active) {
                fsAudit.calls.push(`${prefix}.${name}`);
                throw new Error('unexpected filesystem access during path query');
            }

            return Reflect.apply(original, this, args);
        });
        const native = (original as typeof original & { native?: (...args: unknown[]) => unknown })
            .native;

        if (native) {
            Object.defineProperty(spy, 'native', {
                configurable: true,
                value: function (this: unknown, ...args: unknown[]) {
                    if (fsAudit.active) {
                        fsAudit.calls.push(`${prefix}.${name}.native`);
                        throw new Error('unexpected filesystem access during path query');
                    }

                    return Reflect.apply(native, this, args);
                },
            });
        }
    }
}

const fileMethods = [
    'access',
    'accessSync',
    'appendFile',
    'appendFileSync',
    'chmod',
    'chmodSync',
    'chown',
    'chownSync',
    'close',
    'closeSync',
    'copyFile',
    'copyFileSync',
    'cp',
    'cpSync',
    'createReadStream',
    'createWriteStream',
    'exists',
    'existsSync',
    'fstat',
    'fstatSync',
    'lstat',
    'lstatSync',
    'mkdir',
    'mkdirSync',
    'mkdtemp',
    'mkdtempSync',
    'open',
    'openSync',
    'opendir',
    'opendirSync',
    'read',
    'readSync',
    'readdir',
    'readdirSync',
    'readFile',
    'readFileSync',
    'readlink',
    'readlinkSync',
    'realpath',
    'realpathSync',
    'rename',
    'renameSync',
    'rm',
    'rmSync',
    'rmdir',
    'rmdirSync',
    'stat',
    'statSync',
    'statfs',
    'statfsSync',
    'symlink',
    'symlinkSync',
    'unlink',
    'unlinkSync',
    'watch',
    'watchFile',
    'write',
    'writeSync',
    'writeFile',
    'writeFileSync',
] as const;

beforeEach(async () => {
    fsAudit.active = false;
    fsAudit.calls.length = 0;
    packageWebSocket.mockClear();
    fetchGuard = vi.fn(blocked);
    webSocketGuard = vi.fn(function forbiddenWebSocket() {
        return blocked();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    guards = [
        vi.spyOn(net, 'createServer').mockImplementation(blocked),
        vi.spyOn(net, 'createConnection').mockImplementation(blocked),
        vi.spyOn(net, 'connect').mockImplementation(blocked),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(blocked),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(http, 'createServer').mockImplementation(blocked),
        vi.spyOn(http, 'request').mockImplementation(blocked),
        vi.spyOn(http, 'get').mockImplementation(blocked),
        vi.spyOn(https, 'createServer').mockImplementation(blocked),
        vi.spyOn(https, 'request').mockImplementation(blocked),
        vi.spyOn(https, 'get').mockImplementation(blocked),
        vi.spyOn(http2, 'createServer').mockImplementation(blocked),
        vi.spyOn(http2, 'createSecureServer').mockImplementation(blocked),
        vi.spyOn(http2, 'connect').mockImplementation(blocked),
        vi.spyOn(tls, 'createServer').mockImplementation(blocked),
        vi.spyOn(tls, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram, 'createSocket').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(blocked),
        vi.spyOn(process, 'dlopen').mockImplementation(blocked),
    ];
    guardFileMethods(fs, fileMethods, 'fs');
    guardFileMethods(fs.promises, fileMethods, 'fs.promises');
    // Update native named imports too; restore them alongside the spies below.
    syncBuiltinESMExports();
    ({ PluginHost: Host, UnsupportedPluginFeatureError: Unsupported } =
        await import('../../src/plugin-host'));
});

afterEach(async () => {
    const failures: unknown[] = [];

    try {
        // Preserve FIFO cleanup even when an earlier host fails to shut down.
        for (const host of hosts.splice(0)) {
            try {
                await host.shutdown();
            } catch (error) {
                failures.push(error);
            }
        }

        for (const root of roots.splice(0)) {
            try {
                await rm(root, { recursive: true, force: true });
            } catch (error) {
                failures.push(error);
            }
        }
    } finally {
        fsAudit.active = false;
        const guardCalls = guards.map((guard) => guard.mock.calls.length);
        const fetchCalls = fetchGuard.mock.calls.length;
        const webSocketCalls = webSocketGuard.mock.calls.length;
        const packageWebSocketCalls = packageWebSocket.mock.calls.length;
        delete (globalThis as Record<string, unknown>).__managerSelfPathsProbe;
        vi.restoreAllMocks();
        syncBuiltinESMExports();
        vi.unstubAllGlobals();
        expect(guardCalls).toEqual(guardCalls.map(() => 0));
        expect(fetchCalls).toBe(0);
        expect(webSocketCalls).toBe(0);
        expect(packageWebSocketCalls).toBe(0);
        expect(fsAudit.calls).toEqual([]);
    }

    expect(failures).toEqual([]);
});

function withoutFileIo<T>(operation: () => T): T {
    if (fsAudit.active) {
        throw new Error('nested filesystem audit');
    }

    fsAudit.active = true;

    try {
        return operation();
    } finally {
        fsAudit.active = false;
    }
}

function paths(context: Context): { data: string; config: string } {
    return withoutFileIo(() => ({
        data: context.pluginManager.getPluginDataPath(context.pluginName),
        config: context.pluginManager.getPluginConfigPath(context.pluginName),
    }));
}

async function fixture(): Promise<{ root: string; plugin: string; probe: Probe }> {
    const root = await mkdtemp(path.join(tmpdir(), 'jiyu-manager-self-paths-'));
    roots.push(root);
    const plugin = path.join(root, 'plugin');
    await mkdir(plugin);
    await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
    await writeFile(
        path.join(plugin, 'index.mjs'),
        `
        export function plugin_init(c) { globalThis.__managerSelfPathsProbe.record(c, 'init'); }
        export function plugin_onevent(c, e) {
            globalThis.__managerSelfPathsProbe.record(c, 'event', e.n);
            if (e.fail) throw new Error('PRIVATE_SYNTHETIC_HOOK ' + c.dataPath);
        }
        export function plugin_cleanup(c) { globalThis.__managerSelfPathsProbe.record(c, 'cleanup'); }
        `,
    );
    const probe: Probe = {
        entries: [],
        record(context, phase, number) {
            const result = paths(context);
            this.entries.push({ context, phase, number, ...result });
        },
    };
    (globalThis as Record<string, unknown>).__managerSelfPathsProbe = probe;
    return { root, plugin, probe };
}

function makeHost(root: string, accountId: string) {
    const managerConfig = { accountId, fixture: true };
    const invokeAction = vi.fn(async () => ({ status: 'ok' as const, retcode: 0, data: null }));
    const isStreamAction = vi.fn(() => false);
    const logger = vi.fn<PluginHostOptions['logger']>();
    const host = new Host({
        accountId,
        stateRoot: path.join(root, 'state'),
        managerConfig,
        invokeAction,
        isStreamAction,
        logger,
    });
    hosts.push(host);
    return { host, managerConfig, invokeAction, isStreamAction, logger };
}

function expectSelf(context: Context): void {
    const result = paths(context);
    expect(result).toEqual({ data: context.dataPath, config: context.configPath });
    expect(typeof result.data).toBe('string');
    expect(typeof result.config).toBe('string');
}

function takeError(operation: () => unknown): unknown {
    try {
        withoutFileIo(operation);
    } catch (error) {
        return error;
    }

    return undefined;
}

describe('PluginHost synthetic self-only manager paths', () => {
    it('works in init, FIFO events and cleanup, and retains only already-known strings after restart', async () => {
        const { root, plugin, probe } = await fixture();
        const { host, managerConfig, invokeAction, isStreamAction, logger } = makeHost(root, '101');
        await host.enable('demo', plugin);
        const first = probe.entries[0].context;
        const manager = first.pluginManager;
        const data = manager.getPluginDataPath;
        const config = manager.getPluginConfigPath;
        expect(Object.isFrozen(manager)).toBe(true);
        expect(manager.config).toBe(managerConfig);
        expect(manager.getPluginDataPath).toBe(data);
        expect(manager.getPluginConfigPath).toBe(config);
        expect(withoutFileIo(() => data('demo'))).toBe(first.dataPath);
        expect(withoutFileIo(() => config('demo'))).toBe(first.configPath);
        expect(withoutFileIo(() => data.call({ unrelated: true }, 'demo'))).toBe(first.dataPath);
        expect(withoutFileIo(() => config.call({ unrelated: true }, 'demo'))).toBe(
            first.configPath,
        );
        expect(host.dispatch({ post_type: 'notice', n: 1, fail: true })).toEqual({
            accepted: 1,
            dropped: 0,
        });
        expect(host.dispatch({ post_type: 'notice', n: 2 })).toEqual({ accepted: 1, dropped: 0 });
        await host.disable('demo');
        expect(probe.entries.map(({ phase, number }) => [phase, number])).toEqual([
            ['init', undefined],
            ['event', 1],
            ['event', 2],
            ['cleanup', undefined],
        ]);

        for (const entry of probe.entries) {
            expect(entry.context).toBe(first);
            expect({ data: entry.data, config: entry.config }).toEqual({
                data: first.dataPath,
                config: first.configPath,
            });
        }

        expect(logger).toHaveBeenCalled();
        expect(JSON.stringify(logger.mock.calls)).not.toContain('PRIVATE_SYNTHETIC_HOOK');
        expect(JSON.stringify(logger.mock.calls)).not.toContain(first.dataPath);
        expect(invokeAction).not.toHaveBeenCalled();
        expect(isStreamAction).not.toHaveBeenCalled();

        // These are strings the old context already exposed; they say nothing
        // about current existence, access capability, or generation safety.
        expectSelf(first);
        await host.enable('demo', plugin);
        const second = probe.entries[4].context;
        // Compare identity as a boolean: formatting an entire context for a
        // matcher would invoke its intentionally unsupported accessor properties.
        expect(Object.is(second, first)).toBe(false);
        expect(Object.is(second.pluginManager, manager)).toBe(false);
        expect(second.pluginManager.config).toBe(managerConfig);
        expectSelf(first);
        expectSelf(second);
        expect(withoutFileIo(() => data('demo'))).toBe(first.dataPath);
        expect(withoutFileIo(() => config('demo'))).toBe(first.configPath);
        await host.shutdown();
        expect(probe.entries[5].phase).toBe('cleanup');
        expect(probe.entries[5].context).toBe(second);
        expectSelf(first);
        expectSelf(second);
    });

    it('rejects every non-self argument with a fixed error and never inspects it', async () => {
        const { root, plugin, probe } = await fixture();
        const { host } = makeHost(root, '101');
        await host.enable('demo', plugin);
        await host.enable('other', plugin);
        const current = probe.entries[0].context;
        const other = probe.entries[1].context;
        let traps = 0;

        const trap = () => {
            traps++;
            throw new Error('PRIVATE_ARGUMENT_TRAP');
        };

        const poisoned = {
            [Symbol.toPrimitive]: trap,
            toString: trap,
            valueOf: trap,
        };
        const proxy = new Proxy(
            {},
            {
                get: trap,
                has: trap,
                ownKeys: trap,
                getOwnPropertyDescriptor: trap,
                getPrototypeOf: trap,
                isExtensible: trap,
            },
        );
        const revocable = Proxy.revocable({}, {});
        revocable.revoke();
        const inputs: Array<{ label: string; args: unknown[] }> = [
            { label: 'different existing plugin', args: ['other'] },
            { label: 'different private string', args: ['PRIVATE_DIFFERENT_PLUGIN'] },
            { label: 'different case', args: ['DEMO'] },
            { label: 'empty', args: [''] },
            { label: 'missing', args: [] },
            { label: 'undefined', args: [undefined] },
            { label: 'number', args: [101] },
            { label: 'null', args: [null] },
            { label: 'boolean', args: [true] },
            { label: 'symbol', args: [Symbol('PRIVATE_SYMBOL')] },
            { label: 'boxed matching string', args: [new String('demo')] },
            { label: 'object with conversion traps', args: [poisoned] },
            { label: 'proxy', args: [proxy] },
            { label: 'revoked proxy', args: [revocable.proxy] },
        ];

        for (const [name, method] of [
            ['getPluginDataPath', current.pluginManager.getPluginDataPath],
            ['getPluginConfigPath', current.pluginManager.getPluginConfigPath],
        ] as const) {
            let fixedMessage: string | undefined;

            for (const input of inputs) {
                const error = takeError(() => Reflect.apply(method, undefined, input.args));
                expect(error, `${name}: ${input.label}`).toBeInstanceOf(Unsupported);
                const unsupported = error as Error & { cause?: unknown };
                expect(unsupported.name).toBe('UnsupportedPluginFeatureError');
                fixedMessage ??= unsupported.message;
                expect(unsupported.message).toBe(fixedMessage);
                expect(unsupported.stack).toBe(`${unsupported.name}: ${unsupported.message}`);
                expect(unsupported.cause).toBeUndefined();

                for (const secret of [
                    'PRIVATE_DIFFERENT_PLUGIN',
                    'PRIVATE_ARGUMENT_TRAP',
                    'PRIVATE_SYMBOL',
                    other.dataPath,
                    other.configPath,
                ]) {
                    expect(unsupported.message).not.toContain(secret);
                    expect(unsupported.stack).not.toContain(secret);
                }

                const argument = input.args[0];

                if (typeof argument === 'string' && argument.length > 0) {
                    expect(unsupported.message).not.toContain(argument);
                    expect(unsupported.stack).not.toContain(argument);
                }

                if (
                    (typeof argument === 'object' && argument !== null) ||
                    typeof argument === 'function' ||
                    typeof argument === 'symbol'
                ) {
                    const ownValues = Object.values(
                        Object.getOwnPropertyDescriptors(unsupported),
                    ).map((descriptor) => descriptor.value);
                    expect(ownValues.includes(argument)).toBe(false);
                }
            }
        }

        expect(traps).toBe(0);
        expectSelf(current);
        expectSelf(other);
    });

    it('keeps other manager methods unsupported and separates plugins and accounts', async () => {
        const { root, plugin, probe } = await fixture();
        const a = makeHost(root, '101');
        const b = makeHost(root, '202');
        await a.host.enable('demo', plugin);
        await a.host.enable('other', plugin);
        await b.host.enable('demo', plugin);
        const [first, second, third] = probe.entries.map((entry) => entry.context);
        expect(first.pluginName).toBe('demo');
        expect(second.pluginName).toBe('other');
        expect(third.pluginName).toBe('demo');
        expect(new Set([first.dataPath, second.dataPath, third.dataPath]).size).toBe(3);
        expect(new Set([first.configPath, second.configPath, third.configPath]).size).toBe(3);
        expect(first.pluginManager.config).toBe(a.managerConfig);
        expect(second.pluginManager.config).toBe(a.managerConfig);
        expect(third.pluginManager.config).toBe(b.managerConfig);
        expect(a.managerConfig).not.toBe(b.managerConfig);

        for (const context of [first, second, third]) {
            expect(Object.isFrozen(context.pluginManager)).toBe(true);
            expectSelf(context);

            for (const method of [
                'getPlugin',
                'getPluginExports',
                'enablePlugin',
                'disablePlugin',
            ]) {
                expect(
                    () => (context.pluginManager as unknown as Record<string, unknown>)[method],
                ).toThrow(Unsupported);
            }
        }

        for (const [requester, target] of [
            [first, second],
            [second, first],
            [third, second],
        ]) {
            for (const method of [
                requester.pluginManager.getPluginDataPath,
                requester.pluginManager.getPluginConfigPath,
            ]) {
                const error = takeError(() => method(target.pluginName)) as Error;
                expect(error).toBeInstanceOf(Unsupported);
                expect(error.message).not.toContain(target.dataPath);
                expect(error.message).not.toContain(target.configPath);
                expect(error.stack).not.toContain(target.dataPath);
                expect(error.stack).not.toContain(target.configPath);
            }
        }

        await a.host.shutdown();
        expectSelf(first);
        expectSelf(second);
        expectSelf(third);
        await b.host.shutdown();
        expectSelf(third);
        expect(a.invokeAction).not.toHaveBeenCalled();
        expect(b.invokeAction).not.toHaveBeenCalled();
    });
});
