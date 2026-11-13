import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { ApiResponse, JsonObject, JsonValue } from '../types';

/** Independently implemented subset of the NapCat plugin interface.
 * Reference: https://doc.napneko.icu/develop/plugin and /develop/plugin/api/type
 * NapCatQQ: Copyright © 2024 Mlikiowa. No NapCat implementation is included.
 */
export class UnsupportedPluginFeatureError extends Error {
    constructor(feature: string) {
        super(`Unsupported plugin feature: ${feature}`);
        this.name = 'UnsupportedPluginFeatureError';
    }
}

export class PluginHostError extends Error {
    constructor(readonly code: string) {
        super(`Plugin host: ${code}`);
        this.name = 'PluginHostError';
    }
}

type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';
type Hook = (context: PluginContext, event: JsonObject) => void | Promise<void>;
type LifecycleHook = (context: PluginContext) => void | Promise<void>;
interface PluginModule {
    plugin_init: LifecycleHook;
    plugin_cleanup?: LifecycleHook;
    plugin_onevent?: Hook;
    plugin_onmessage?: Hook;
}

export interface PluginContext {
    readonly pluginName: string;
    readonly pluginPath: string;
    readonly configPath: string;
    readonly dataPath: string;
    readonly adapterName: string;
    readonly pluginManager: { readonly config: unknown };
    readonly logger: Record<LogLevel, (...args: unknown[]) => void>;
    readonly actions: {
        call(
            name: string,
            params: JsonObject | undefined,
            adapterName: string,
            config: unknown,
        ): Promise<JsonValue>;
    };
    readonly core: never;
    readonly oneBot: never;
    readonly router: never;
    readonly NapCatConfig: never;
    getPluginExports(id: string): never;
}

export interface PluginHostOptions {
    /** Decimal account identifier; this host belongs to one account generation. */
    accountId: string;
    /** Parent of account-specific writable state. */
    stateRoot: string;
    /** The actual account configuration object passed to pluginManager.config. */
    managerConfig: unknown;
    /** Must invoke this account's OneBot v11 handler with owner-managed in-flight tracking. */
    invokeAction: (name: string, params: JsonObject) => Promise<ApiResponse>;
    /** Used to reject multi-frame actions: this interface returns a single data value. */
    isStreamAction: (name: string) => boolean;
    logger: (
        level: LogLevel,
        pluginId: string,
        args: readonly unknown[],
    ) => void | PromiseLike<void>;
    /** Counts running plus queued events per plugin. */
    maxPendingEvents?: number;
}

export interface PluginStatus {
    readonly id: string;
    readonly state: 'initializing' | 'active' | 'stopping' | 'cleanup_failed';
    readonly cleanupFailed: boolean;
    readonly initializationFailed: boolean;
    readonly pendingActions: number;
    readonly processResources: 'unknown';
}

interface Slot {
    readonly module: PluginModule;
    readonly context: PluginContext;
    accepting: boolean;
    callable: boolean;
    state: 'active' | 'stopping' | 'cleanup_failed';
    cleanupFailed: boolean;
    initializationFailed: boolean;
    pending: number;
    readonly actionsInFlight: Set<Promise<void>>;
    tail: Promise<void>;
}

function validId(id: string): boolean {
    return /^(?!con$|prn$|aux$|nul$|com[1-9]$|lpt[1-9]$)[a-z0-9][a-z0-9_-]{0,79}$/.test(id);
}

function inside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return (
        relative !== '' &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
    );
}

async function childRealPath(root: string, candidate: string): Promise<string> {
    const resolved = await realpath(candidate);

    if (!inside(root, resolved)) {
        throw new PluginHostError('PATH_ESCAPE');
    }

    return resolved;
}

const MANIFEST_LIMIT = 64 * 1024;

async function readManifest(file: string): Promise<unknown> {
    const before = await stat(file);

    if (!before.isFile()) {
        throw new PluginHostError('INVALID_MANIFEST');
    }

    if (before.size > MANIFEST_LIMIT) {
        throw new PluginHostError('MANIFEST_TOO_LARGE');
    }

    const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));

    try {
        const opened = await handle.stat();

        if (!opened.isFile()) {
            throw new PluginHostError('INVALID_MANIFEST');
        }

        if (opened.size > MANIFEST_LIMIT) {
            throw new PluginHostError('MANIFEST_TOO_LARGE');
        }

        const bytes = Buffer.alloc(MANIFEST_LIMIT + 1);
        let offset = 0;

        while (offset < bytes.length) {
            const result = await handle.read(bytes, offset, bytes.length - offset, null);

            if (!result.bytesRead) {
                break;
            }

            offset += result.bytesRead;
        }

        if (offset > MANIFEST_LIMIT) {
            throw new PluginHostError('MANIFEST_TOO_LARGE');
        }

        return JSON.parse(bytes.toString('utf8', 0, offset)) as unknown;
    } finally {
        await handle.close();
    }
}

export class PluginHost {
    private readonly slots = new Map<string, Slot>();
    private readonly initializing = new Set<string>();
    private readonly initializingSlots = new Map<string, Slot>();
    private readonly failedInitializing = new Set<string>();
    private readonly generations = new Map<string, number>();
    private lifecycle: Promise<void> = Promise.resolve();
    private closing = false;
    private shutdownTask: Promise<void> | undefined;
    private readonly maxPending: number;
    private readonly options: PluginHostOptions;

    constructor(options: PluginHostOptions) {
        const {
            accountId,
            stateRoot,
            managerConfig,
            invokeAction,
            isStreamAction,
            logger,
            maxPendingEvents,
        } = options;
        this.options = Object.freeze({
            accountId,
            stateRoot: path.resolve(stateRoot),
            managerConfig,
            invokeAction,
            isStreamAction,
            logger,
            maxPendingEvents,
        });

        if (!/^[1-9]\d{0,31}$/.test(accountId)) {
            throw new PluginHostError('INVALID_ACCOUNT');
        }

        this.maxPending = maxPendingEvents ?? 64;

        if (
            !Number.isSafeInteger(this.maxPending) ||
            this.maxPending < 1 ||
            this.maxPending > 10000
        ) {
            throw new PluginHostError('INVALID_QUEUE_LIMIT');
        }
    }

    private enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const result = this.lifecycle.then(fn);
        this.lifecycle = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    /** Snapshot only; absent IDs are not proof that process resources are gone. */
    listStatuses(): PluginStatus[] {
        const statuses: PluginStatus[] = [];

        for (const id of this.initializing) {
            statuses.push({
                id,
                state: 'initializing',
                cleanupFailed: this.initializingSlots.get(id)?.cleanupFailed ?? false,
                initializationFailed: this.failedInitializing.has(id),
                pendingActions: this.initializingSlots.get(id)?.actionsInFlight.size ?? 0,
                processResources: 'unknown',
            });
        }

        for (const [id, slot] of this.slots) {
            statuses.push({
                id,
                state: slot.state,
                cleanupFailed: slot.cleanupFailed,
                initializationFailed: slot.initializationFailed,
                pendingActions: slot.actionsInFlight.size,
                processResources: 'unknown',
            });
        }

        return statuses.sort((a, b) => a.id.localeCompare(b.id));
    }

    /** Explicitly selects and executes a user-provided ESM plugin directory. */
    enable(id: string, directory: string): Promise<void> {
        if (this.closing) {
            return Promise.reject(new PluginHostError('CLOSED'));
        }

        if (!validId(id) || !path.isAbsolute(directory)) {
            return Promise.reject(new PluginHostError('INVALID_PLUGIN_SELECTION'));
        }

        const generation = this.generations.get(id) ?? 0;
        return this.enqueue(async () => {
            if (this.closing) {
                throw new PluginHostError('CLOSED');
            }

            if ((this.generations.get(id) ?? 0) !== generation) {
                throw new PluginHostError('DISABLED');
            }

            if (this.slots.has(id)) {
                throw new PluginHostError('ALREADY_ENABLED');
            }

            let slot: Slot | undefined;
            let initialized = false;
            this.initializing.add(id);

            try {
                const pluginPath = await realpath(directory);

                if (!(await stat(pluginPath)).isDirectory()) {
                    throw new PluginHostError('INVALID_PLUGIN_DIRECTORY');
                }

                const manifestPath = await childRealPath(
                    pluginPath,
                    path.join(pluginPath, 'package.json'),
                );
                const manifest = await readManifest(manifestPath);

                if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
                    throw new PluginHostError('INVALID_MANIFEST');
                }

                const { main: declaredMain, type } = manifest as Record<string, unknown>;
                let main: unknown = declaredMain;

                if (declaredMain === undefined) {
                    for (const candidate of ['index.mjs', 'index.js', 'main.mjs', 'main.js']) {
                        try {
                            await lstat(path.join(pluginPath, candidate));
                            main = candidate;
                            break;
                        } catch (error) {
                            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                                throw error;
                            }
                        }
                    }
                }

                if (
                    typeof main !== 'string' ||
                    !main ||
                    path.isAbsolute(main) ||
                    main.includes('\\') ||
                    main.includes('\0') ||
                    main.split('/').some((part) => part === '..' || part === '')
                ) {
                    throw new PluginHostError('INVALID_ENTRY');
                }

                if (!main.endsWith('.mjs') && !(main.endsWith('.js') && type === 'module')) {
                    throw new PluginHostError('ESM_REQUIRED');
                }

                const entry = await childRealPath(pluginPath, path.resolve(pluginPath, main));

                if (!(await stat(entry)).isFile()) {
                    throw new PluginHostError('INVALID_ENTRY');
                }

                const stateRoot = path.resolve(this.options.stateRoot);
                await mkdir(stateRoot, { recursive: true });
                const rootReal = await realpath(stateRoot);
                const accountPath = path.join(rootReal, this.options.accountId);

                if (!inside(rootReal, accountPath)) {
                    throw new PluginHostError('PATH_ESCAPE');
                }

                await mkdir(accountPath, { recursive: true });

                if ((await lstat(accountPath)).isSymbolicLink()) {
                    throw new PluginHostError('PATH_ESCAPE');
                }

                const accountReal = await childRealPath(rootReal, accountPath);
                const dataPath = path.join(accountReal, id);

                if (!inside(accountReal, dataPath)) {
                    throw new PluginHostError('PATH_ESCAPE');
                }

                await mkdir(dataPath, { recursive: true });

                if ((await lstat(dataPath)).isSymbolicLink()) {
                    throw new PluginHostError('PATH_ESCAPE');
                }

                const dataReal = await childRealPath(accountReal, dataPath);
                const configPath = path.join(dataReal, 'config.json');

                // Refuse an already-present redirected configuration file.
                try {
                    if ((await lstat(configPath)).isSymbolicLink()) {
                        throw new PluginHostError('PATH_ESCAPE');
                    }

                    await childRealPath(dataReal, configPath);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                        throw error;
                    }
                }

                if (this.closing) {
                    throw new PluginHostError('CLOSED');
                }

                if ((this.generations.get(id) ?? 0) !== generation) {
                    throw new PluginHostError('DISABLED');
                }

                const url = pathToFileURL(entry);
                url.searchParams.set('jiyu_activation', randomUUID());
                let imported: unknown;

                try {
                    imported = await import(/* @vite-ignore */ url.href);
                } catch {
                    throw new PluginHostError('ENABLE_FAILED');
                }

                if (this.closing) {
                    throw new PluginHostError('CLOSED');
                }

                if ((this.generations.get(id) ?? 0) !== generation) {
                    throw new PluginHostError('DISABLED');
                }

                if (!imported || typeof imported !== 'object') {
                    throw new PluginHostError('INVALID_MODULE');
                }

                const mod = imported as Record<string, unknown>;

                if (
                    typeof mod.plugin_init !== 'function' ||
                    ['plugin_cleanup', 'plugin_onevent', 'plugin_onmessage'].some(
                        (key) => mod[key] !== undefined && typeof mod[key] !== 'function',
                    )
                ) {
                    throw new PluginHostError('INVALID_HOOK');
                }

                const module = mod as unknown as PluginModule;
                slot = {
                    module,
                    context: undefined as unknown as PluginContext,
                    accepting: false,
                    callable: true,
                    state: 'active',
                    cleanupFailed: false,
                    initializationFailed: false,
                    pending: 0,
                    actionsInFlight: new Set(),
                    tail: Promise.resolve(),
                };
                const current = slot;
                this.initializingSlots.set(id, slot);
                const adapterName = 'Jiyu OneBot v11';
                const manager = new Proxy(Object.freeze({ config: this.options.managerConfig }), {
                    get(target, key, receiver) {
                        if (key === 'config') {
                            return Reflect.get(target, key, receiver);
                        }

                        throw new UnsupportedPluginFeatureError('pluginManager.' + String(key));
                    },
                });

                const log =
                    (level: LogLevel) =>
                    (...args: unknown[]) => {
                        this.emitLog(level, id, args);
                    };

                const unsupported = (feature: string): never => {
                    throw new UnsupportedPluginFeatureError(feature);
                };

                const context: PluginContext = Object.freeze({
                    pluginName: id,
                    pluginPath,
                    configPath,
                    dataPath: dataReal,
                    adapterName,
                    pluginManager: manager,
                    logger: Object.freeze({
                        log: log('log'),
                        info: log('info'),
                        warn: log('warn'),
                        error: log('error'),
                        debug: log('debug'),
                    }),
                    actions: new Proxy(
                        Object.freeze({
                            call: async (
                                name: string,
                                params: JsonObject | undefined,
                                adapter: string,
                                config: unknown,
                            ): Promise<JsonValue> => {
                                if (!current.callable) {
                                    throw new PluginHostError('PLUGIN_INACTIVE');
                                }

                                if (adapter !== adapterName || config !== manager.config) {
                                    throw new PluginHostError('INVALID_ACTION_CONTEXT');
                                }

                                if (
                                    typeof name !== 'string' ||
                                    !/^[a-zA-Z0-9_]{1,128}$/.test(name) ||
                                    (params !== undefined &&
                                        (!params ||
                                            typeof params !== 'object' ||
                                            Array.isArray(params)))
                                ) {
                                    throw new PluginHostError('INVALID_ACTION');
                                }

                                if (this.options.isStreamAction(name)) {
                                    throw new UnsupportedPluginFeatureError('stream action');
                                }

                                let result: ApiResponse;

                                try {
                                    const execution = this.options.invokeAction(name, params ?? {});
                                    const tracked = Promise.resolve(execution).then(
                                        () => undefined,
                                        () => undefined,
                                    );
                                    current.actionsInFlight.add(tracked);
                                    void tracked.then(() => {
                                        current.actionsInFlight.delete(tracked);
                                    });
                                    result = await execution;
                                } catch {
                                    throw new PluginHostError('ACTION_EXECUTION_FAILED');
                                }

                                if (result.status !== 'ok' || result.retcode !== 0) {
                                    throw new PluginHostError(
                                        `ACTION_FAILED_${Number.isSafeInteger(result.retcode) ? result.retcode : 'UNKNOWN'}`,
                                    );
                                }

                                return result.data;
                            },
                        }),
                        {
                            get(target, key, receiver) {
                                if (key === 'call') {
                                    return Reflect.get(target, key, receiver);
                                }

                                return unsupported('actions.' + String(key));
                            },
                        },
                    ),
                    get core(): never {
                        return unsupported('core');
                    },
                    get oneBot(): never {
                        return unsupported('oneBot');
                    },
                    get router(): never {
                        return unsupported('router');
                    },
                    get NapCatConfig(): never {
                        return unsupported('NapCatConfig');
                    },
                    getPluginExports: () => unsupported('getPluginExports'),
                });
                Object.assign(slot, { context });
                initialized = true;

                try {
                    await module.plugin_init(context);
                } catch {
                    throw new PluginHostError('ENABLE_FAILED');
                }

                if (this.closing) {
                    throw new PluginHostError('CLOSED');
                }

                if ((this.generations.get(id) ?? 0) !== generation) {
                    throw new PluginHostError('DISABLED');
                }

                slot.accepting = true;
                this.slots.set(id, slot);
            } catch (error) {
                if (initialized && slot) {
                    const initializationFailed = !(
                        error instanceof PluginHostError &&
                        (error.code === 'CLOSED' || error.code === 'DISABLED')
                    );

                    if (initializationFailed) {
                        this.failedInitializing.add(id);
                    }

                    slot.initializationFailed = initializationFailed;

                    try {
                        await this.cleanupSlot(id, slot);
                    } catch {
                        this.slots.set(id, slot);
                        throw new PluginHostError('CLEANUP_FAILED');
                    }
                }

                if (
                    error instanceof PluginHostError ||
                    error instanceof UnsupportedPluginFeatureError
                ) {
                    throw error;
                }

                throw new PluginHostError('ENABLE_FAILED');
            } finally {
                this.initializing.delete(id);
                this.initializingSlots.delete(id);
                this.failedInitializing.delete(id);
            }
        });
    }

    /** Admission is synchronous; each plugin owns an independent bounded FIFO. */
    dispatch(event: JsonObject): { accepted: number; dropped: number } {
        let accepted = 0;
        let dropped = 0;

        if (this.closing) {
            return { accepted, dropped };
        }

        for (const [id, slot] of this.slots) {
            if (!slot.accepting) {
                continue;
            }

            if (slot.pending >= this.maxPending) {
                dropped++;
                this.report(id, 'queue_full');
                continue;
            }

            let copy: JsonObject;

            try {
                copy = structuredClone(event);
            } catch {
                dropped++;
                this.report(id, 'invalid_event');
                continue;
            }

            const isMessage = Boolean(copy.message_type);
            accepted++;
            slot.pending++;
            slot.tail = slot.tail.then(async () => {
                try {
                    await slot.module.plugin_onevent?.(slot.context, copy);

                    if (isMessage) {
                        await slot.module.plugin_onmessage?.(slot.context, copy);
                    }
                } catch {
                    this.report(id, 'event');
                } finally {
                    slot.pending--;
                }
            });
        }

        return { accepted, dropped };
    }

    disable(id: string): Promise<void> {
        if (!validId(id)) {
            return Promise.reject(new PluginHostError('INVALID_PLUGIN_SELECTION'));
        }

        this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
        const current = this.slots.get(id);

        if (current) {
            current.accepting = false;

            if (!current.cleanupFailed) {
                current.state = 'stopping';
            }
        }

        return this.enqueue(async () => {
            const slot = this.slots.get(id);

            if (!slot) {
                return;
            }

            await this.cleanupSlot(id, slot);
        });
    }

    shutdown(): Promise<void> {
        if (this.shutdownTask) {
            return this.shutdownTask;
        }

        this.closing = true;

        for (const slot of this.slots.values()) {
            slot.accepting = false;

            if (!slot.cleanupFailed) {
                slot.state = 'stopping';
            }
        }

        const attempt = this.enqueue(async () => {
            let failed = false;

            for (const [id, slot] of this.slots) {
                try {
                    await this.cleanupSlot(id, slot);
                } catch {
                    failed = true;
                }
            }

            if (failed) {
                throw new PluginHostError('CLEANUP_FAILED');
            }
        });
        this.shutdownTask = attempt;
        void attempt.catch(() => {
            if (this.shutdownTask === attempt) {
                this.shutdownTask = undefined;
            }
        });
        return attempt;
    }

    private async cleanupSlot(id: string, slot: Slot): Promise<void> {
        slot.accepting = false;
        slot.state = 'stopping';
        await slot.tail;
        slot.callable = false;
        await Promise.all(slot.actionsInFlight);

        // A failed cleanup never reopens action access on a later retry.
        slot.callable = !slot.cleanupFailed;
        let failed = false;

        try {
            await slot.module.plugin_cleanup?.(slot.context);
        } catch {
            failed = true;
        } finally {
            slot.callable = false;
        }

        if (failed) {
            slot.cleanupFailed = true;
            slot.state = 'cleanup_failed';
            this.report(id, 'cleanup');
        }

        await Promise.all(slot.actionsInFlight);

        if (failed) {
            throw new PluginHostError('CLEANUP_FAILED');
        }

        this.slots.delete(id);
    }

    private emitLog(level: LogLevel, id: string, args: readonly unknown[]): void {
        try {
            const result = this.options.logger(level, id, args);

            if (result !== undefined) {
                void Promise.resolve(result).catch(() => undefined);
            }
        } catch {
            /* Never leak logger errors or recursively log them. */
        }
    }

    private report(id: string, phase: string): void {
        this.emitLog('warn', id, [`Plugin host ${phase} failed`]);
    }
}
