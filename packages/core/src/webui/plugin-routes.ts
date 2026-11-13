import { types } from 'node:util';
import type { Hono } from 'hono';
import type { OneBotManager } from '@snowluma/onebot/manager';
import { LocalPluginCatalogError, type LocalPluginCatalog } from './plugin-local';

const UIN = /^\d{5,10}$/;
const PLUGIN_ID = /^(?!con$|prn$|aux$|nul$|com[1-9]$|lpt[1-9]$)[a-z0-9][a-z0-9_-]{0,79}$/;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CONFIG_CHUNKS = 8192;
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cancelBestEffort(cancel: () => Promise<void>): void {
    try {
        void cancel().catch(() => {});
    } catch {
        // Cancellation must never hold up a response.
    }
}

function cancelUnreadBody(request: Request): void {
    const body = request.body;

    if (body && !body.locked) {
        cancelBestEffort(() => body.cancel());
    }
}

const CONFIG_CODES = new Set([
    'PLUGIN_INACTIVE',
    'CONFIG_UNSUPPORTED',
    'CONFIG_INVALID',
    'CONFIG_QUEUE_FULL',
    'CONFIG_REENTRANT',
    'CONFIG_OUTCOME_UNKNOWN',
]);

class InvalidConfigBody extends Error {
    constructor(readonly tooLarge = false) {
        super();
    }
}

// The content length is advisory only: the stream is always measured independently.
async function readConfigBody(request: Request): Promise<unknown> {
    const header = request.headers.get('content-length');

    if (header !== null && !/^\d+$/.test(header)) {
        cancelUnreadBody(request);

        throw new InvalidConfigBody();
    }

    const declared = header === null ? null : Number(header);

    if (declared !== null && (!Number.isSafeInteger(declared) || declared > MAX_CONFIG_BYTES)) {
        cancelUnreadBody(request);

        throw new InvalidConfigBody(true);
    }

    if (!request.body) {
        throw new InvalidConfigBody();
    }

    const reader = request.body.getReader();

    const cancel = () => {
        cancelBestEffort(() => reader.cancel());
    };

    request.signal.addEventListener('abort', cancel, { once: true });
    const bytes = new Uint8Array(MAX_CONFIG_BYTES);
    let size = 0;
    let chunks = 0;

    try {
        if (request.signal.aborted) {
            cancel();
            throw new InvalidConfigBody();
        }

        for (;;) {
            const part = await reader.read();

            if (request.signal.aborted) {
                throw new InvalidConfigBody();
            }

            if (part.done) {
                break;
            }

            chunks++;

            if (chunks > MAX_CONFIG_CHUNKS || part.value.byteLength > MAX_CONFIG_BYTES - size) {
                cancel();
                throw new InvalidConfigBody(true);
            }

            bytes.set(part.value, size);
            size += part.value.byteLength;
        }

        if (declared !== null && declared !== size) {
            throw new InvalidConfigBody();
        }

        const value: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)),
        );

        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new InvalidConfigBody();
        }

        return value;
    } catch (error) {
        if (error instanceof InvalidConfigBody) {
            throw error;
        }

        throw new InvalidConfigBody();
    } finally {
        request.signal.removeEventListener('abort', cancel);
        reader.releaseLock();
    }
}

type AccountManager = Pick<OneBotManager, 'getInstance'>;

/** Register after the WebUI's existing authentication and consent middleware. */
export function registerLocalPluginRoutes(
    app: Hono,
    manager: AccountManager,
    catalog: LocalPluginCatalog,
): void {
    type Instance = NonNullable<ReturnType<AccountManager['getInstance']>>;
    type PendingEnable = {
        instance: Instance;
        phase: 'resolving' | 'invoked';
        cancelled: boolean;
    };
    type PendingConfig = {
        instance: Instance;
        operation: 'config-schema' | 'config-read' | 'config-write';
        phase: 'reading' | 'invoked';
        cancelled: boolean;
    };
    const pendingEnables = new Map<string, PendingEnable>();
    const pendingConfigs = new Map<string, PendingConfig>();
    const pendingDisables = new Map<string, Instance>();
    const keyFor = (uin: string, id: string) => `${uin}:${id}`;

    // Count unique account/plugin keys, not map entries. An accepted enable or
    // config reserves its own future disable, even when capacity is exhausted.
    const atPendingLimit = (uin: string) => {
        const keys = new Set([
            ...pendingEnables.keys(),
            ...pendingConfigs.keys(),
            ...pendingDisables.keys(),
        ]);
        return (
            keys.size >= 128 || [...keys].filter((key) => key.startsWith(`${uin}:`)).length >= 16
        );
    };

    app.use('/api/plugins/local/*', async (c, next) => {
        c.header('Cache-Control', 'no-store');
        await next();
    });

    app.get('/api/plugins/local/:uin', async (c) => {
        const uin = c.req.param('uin');

        if (!UIN.test(uin)) {
            return c.json({ status: 'failed', code: 'INVALID_ACCOUNT' }, 400);
        }

        const instance = manager.getInstance(uin);
        let candidates: string[];

        try {
            candidates = await catalog.list();
        } catch {
            // Never turn an incomplete or failed directory read into an empty list.
            return c.json({ status: 'failed', code: 'LOCAL_CATALOG_UNAVAILABLE' }, 503);
        }

        if (manager.getInstance(uin) !== instance) {
            return c.json({ status: 'failed', code: 'INSTANCE_CHANGED' }, 409);
        }

        const runtime = instance?.listPlugins() ?? null;
        const runtimeById = new Map(runtime?.map((entry) => [entry.id, entry]) ?? []);
        const pendingOperations = [
            ...[...pendingEnables.entries()].map(([key, pending]) => ({
                key,
                operation: 'enable' as const,
                phase: pending.phase,
                cancelled: pending.cancelled,
                instance: pending.instance,
            })),
            ...[...pendingConfigs.entries()].map(([key, pending]) => ({
                key,
                operation: pending.operation,
                phase: pending.phase,
                cancelled: pending.cancelled,
                instance: pending.instance,
            })),
            ...[...pendingDisables.entries()].map(([key, owner]) => ({
                key,
                operation: 'disable' as const,
                phase: 'draining' as const,
                cancelled: false,
                instance: owner,
            })),
        ]
            .filter(({ key }) => key.startsWith(`${uin}:`))
            .map(({ key, instance: owner, ...entry }) => ({
                id: key.slice(uin.length + 1),
                ...entry,
                currentInstance: owner === instance,
            }));
        const pendingById = new Map(pendingOperations.map((entry) => [entry.id, entry]));
        const ids = new Set([
            ...candidates,
            ...(runtime?.map((entry) => entry.id) ?? []),
            ...pendingOperations.map((entry) => entry.id),
        ]);
        const atLimit = atPendingLimit(uin);
        const actions = [...ids].sort().map((id) => {
            const current = runtimeById.get(id);
            const pending = pendingById.get(id);
            const listed = candidates.includes(id);
            const canStart = instance?.canEnablePlugins() ?? false;
            const enableReason = !instance
                ? 'ACCOUNT_OFFLINE'
                : !canStart
                  ? 'INSTANCE_QUIESCED'
                  : pending
                    ? 'OPERATION_PENDING'
                    : atLimit
                      ? 'ENABLE_BUSY'
                      : !listed
                        ? 'NOT_CANDIDATE'
                        : current
                          ? 'ALREADY_PRESENT'
                          : null;
            const disableReason = !instance
                ? 'ACCOUNT_OFFLINE'
                : pending && !pending.currentInstance
                  ? 'OLD_INSTANCE_PENDING'
                  : pending?.operation === 'disable'
                    ? 'CLEANUP_IN_PROGRESS'
                    : pending?.cancelled
                      ? 'CANCELLATION_PENDING'
                      : pending
                        ? null
                        : !current
                          ? 'NOT_LOADED'
                          : current.state === 'stopping'
                            ? 'CLEANUP_IN_PROGRESS'
                            : atLimit
                              ? 'DISABLE_BUSY'
                              : null;
            return {
                id,
                canEnable: enableReason === null,
                canDisable: disableReason === null,
                enableReason,
                disableReason,
            };
        });

        return c.json({
            status: 'ok',
            accountOnline: instance !== null,
            candidates,
            runtime,
            actions,
            pendingOperations,
            // Only local candidates were enumerated; this says nothing about
            // marketplace availability or detached resources in the process.
            processResources: 'unknown' as const,
        });
    });

    for (const action of ['schema', 'read', 'write'] as const) {
        app.post(`/api/plugins/local/:uin/:id/config/${action}`, async (c) => {
            const { uin, id } = c.req.param();
            let bodyHandled = false;

            const failure = (
                code: string,
                outcome: 'not_started' | 'unknown',
                status: 400 | 404 | 409 | 413 | 429,
            ) => {
                if (!bodyHandled) {
                    cancelUnreadBody(c.req.raw);
                    bodyHandled = true;
                }

                return c.json(
                    { status: 'failed', code, outcome, processResources: 'unknown' },
                    status,
                );
            };

            if (!UIN.test(uin) || !PLUGIN_ID.test(id)) {
                return failure('INVALID_SELECTION', 'not_started', 400);
            }

            const suppliedGeneration = c.req.header('x-jiyu-plugin-generation');

            if (
                action !== 'schema' &&
                (!suppliedGeneration || !GENERATION.test(suppliedGeneration))
            ) {
                return failure('CONFIG_GENERATION_REQUIRED', 'not_started', 400);
            }

            const instance = manager.getInstance(uin);

            if (!instance) {
                return failure('ACCOUNT_OFFLINE', 'not_started', 404);
            }

            const key = keyFor(uin, id);

            if (pendingEnables.has(key) || pendingConfigs.has(key) || pendingDisables.has(key)) {
                return failure('OPERATION_PENDING', 'not_started', 409);
            }

            if (!instance.canEnablePlugins()) {
                return failure('INSTANCE_QUIESCED', 'not_started', 409);
            }

            if (atPendingLimit(uin)) {
                return failure('CONFIG_QUEUE_FULL', 'not_started', 429);
            }

            const pending: PendingConfig = {
                instance,
                operation: `config-${action}`,
                phase: 'reading',
                cancelled: false,
            };
            pendingConfigs.set(key, pending);

            try {
                let value: unknown;

                if (action === 'write') {
                    bodyHandled = true;

                    try {
                        value = await readConfigBody(c.req.raw);
                    } catch (error) {
                        if (manager.getInstance(uin) !== instance) {
                            return failure('CONFIG_GENERATION_CHANGED', 'not_started', 409);
                        }

                        if (c.req.raw.signal.aborted) {
                            return failure('OPERATION_CANCELLED', 'not_started', 409);
                        }

                        if (pending.cancelled) {
                            return failure('CONFIG_GENERATION_CHANGED', 'not_started', 409);
                        }

                        return failure(
                            'CONFIG_INVALID',
                            'not_started',
                            error instanceof InvalidConfigBody && error.tooLarge ? 413 : 400,
                        );
                    }
                }

                if (manager.getInstance(uin) !== instance) {
                    return failure(
                        action === 'schema' ? 'INSTANCE_CHANGED' : 'CONFIG_GENERATION_CHANGED',
                        'not_started',
                        409,
                    );
                }

                if (c.req.raw.signal.aborted) {
                    return failure('OPERATION_CANCELLED', 'not_started', 409);
                }

                if (
                    pending.cancelled ||
                    pendingDisables.has(key) ||
                    pendingConfigs.get(key) !== pending
                ) {
                    return failure('CONFIG_GENERATION_CHANGED', 'not_started', 409);
                }

                if (!instance.canEnablePlugins()) {
                    return failure('INSTANCE_QUIESCED', 'not_started', 409);
                }

                if (!bodyHandled) {
                    cancelUnreadBody(c.req.raw);
                    bodyHandled = true;
                }

                // Check the captured account and active slot immediately before
                // synchronous host admission, without yielding between them.
                if (
                    manager.getInstance(uin) !== instance ||
                    pending.cancelled ||
                    pendingDisables.has(key) ||
                    pendingConfigs.get(key) !== pending
                ) {
                    return failure('CONFIG_GENERATION_CHANGED', 'not_started', 409);
                }

                let generation: string | null;

                try {
                    generation = instance.getPluginConfigGeneration(id);
                } catch {
                    return failure('CONFIG_GENERATION_CHANGED', 'not_started', 409);
                }

                if (action === 'schema' && !generation) {
                    return failure('PLUGIN_INACTIVE', 'not_started', 409);
                }

                if (
                    !generation ||
                    !GENERATION.test(generation) ||
                    (action !== 'schema' && generation !== suppliedGeneration)
                ) {
                    return failure('CONFIG_GENERATION_CHANGED', 'not_started', 409);
                }

                pending.phase = 'invoked';

                try {
                    // Invocation and admission are synchronous; the reservation stays
                    // until the returned promise truly settles, even after disconnect.
                    const result =
                        action === 'schema'
                            ? await instance.getPluginConfigSchema(id)
                            : action === 'read'
                              ? await instance.getPluginConfig(id)
                              : await instance.setPluginConfig(id, value);

                    if (
                        manager.getInstance(uin) !== instance ||
                        c.req.raw.signal.aborted ||
                        instance.getPluginConfigGeneration(id) !== generation
                    ) {
                        return failure('CONFIG_OUTCOME_UNKNOWN', 'unknown', 409);
                    }

                    return c.json({
                        status: 'ok',
                        ...result,
                        generation,
                        processResources: 'unknown',
                    });
                } catch (error) {
                    let code = 'CONFIG_OUTCOME_UNKNOWN';

                    try {
                        if (error && typeof error === 'object' && !types.isProxy(error)) {
                            const descriptor = Object.getOwnPropertyDescriptor(error, 'code');

                            if (
                                descriptor &&
                                'value' in descriptor &&
                                typeof descriptor.value === 'string' &&
                                CONFIG_CODES.has(descriptor.value)
                            ) {
                                code = descriptor.value;
                            }
                        }
                    } catch {
                        /* Arbitrary plugin errors are never rendered. */
                    }

                    try {
                        if (
                            manager.getInstance(uin) !== instance ||
                            c.req.raw.signal.aborted ||
                            instance.getPluginConfigGeneration(id) !== generation
                        ) {
                            code = 'CONFIG_OUTCOME_UNKNOWN';
                        }
                    } catch {
                        code = 'CONFIG_OUTCOME_UNKNOWN';
                    }

                    return failure(code, 'unknown', 409);
                }
            } finally {
                if (pendingConfigs.get(key) === pending) {
                    pendingConfigs.delete(key);
                }
            }
        });
    }

    // Unknown configuration operations are never dispatched to a plugin.
    app.post('/api/plugins/local/:uin/:id/config/:operation', (c) => {
        cancelUnreadBody(c.req.raw);
        return c.json(
            {
                status: 'failed',
                code: 'INVALID_OPERATION',
                outcome: 'not_started',
                processResources: 'unknown',
            },
            404,
        );
    });

    app.post('/api/plugins/local/:uin/:id/:operation', async (c) => {
        const { uin, id, operation } = c.req.param();

        if (!UIN.test(uin) || !PLUGIN_ID.test(id)) {
            return c.json({ status: 'failed', code: 'INVALID_SELECTION' }, 400);
        }

        if (operation !== 'enable' && operation !== 'disable') {
            return c.json({ status: 'failed', code: 'INVALID_OPERATION' }, 400);
        }

        const instance = manager.getInstance(uin);

        if (!instance) {
            return c.json({ status: 'failed', code: 'ACCOUNT_OFFLINE' }, 404);
        }

        const key = keyFor(uin, id);
        let ownedPending: PendingEnable | undefined;

        try {
            if (operation === 'enable') {
                if (!instance.canEnablePlugins()) {
                    return c.json({ status: 'failed', code: 'INSTANCE_QUIESCED' }, 409);
                }

                if (
                    pendingEnables.has(key) ||
                    pendingConfigs.has(key) ||
                    pendingDisables.has(key) ||
                    instance.getPluginStatus(id)
                ) {
                    return c.json({ status: 'failed', code: 'PLUGIN_ALREADY_PRESENT' }, 409);
                }

                if (atPendingLimit(uin)) {
                    return c.json({ status: 'failed', code: 'ENABLE_BUSY' }, 429);
                }

                ownedPending = { instance, phase: 'resolving', cancelled: false };
                pendingEnables.set(key, ownedPending);
                // The path is selected solely by the fixed local catalog and is
                // never accepted from the request or returned to the browser.
                const directory = await catalog.resolve(id);

                if (manager.getInstance(uin) !== instance) {
                    return c.json({ status: 'failed', code: 'INSTANCE_CHANGED' }, 409);
                }

                if (ownedPending.cancelled) {
                    return c.json({ status: 'failed', code: 'ENABLE_CANCELLED' }, 409);
                }

                if (!instance.canEnablePlugins()) {
                    return c.json({ status: 'failed', code: 'INSTANCE_QUIESCED' }, 409);
                }

                // This transition and the enable call run synchronously together.
                // A concurrent disable sees either resolving (no code executed)
                // or invoked (it must ask the host to cancel and drain).
                ownedPending.phase = 'invoked';
                await instance.enablePlugin(id, directory);
            } else {
                const pending = pendingEnables.get(key);
                const config = pendingConfigs.get(key);
                const disabling = pendingDisables.get(key);

                if (
                    (config && config.instance !== instance) ||
                    (disabling && disabling !== instance)
                ) {
                    return c.json({ status: 'failed', code: 'OLD_INSTANCE_PENDING' }, 409);
                }

                if (disabling) {
                    return c.json({ status: 'failed', code: 'CLEANUP_IN_PROGRESS' }, 409);
                }

                if (!config && !pending && atPendingLimit(uin)) {
                    return c.json({ status: 'failed', code: 'DISABLE_BUSY' }, 429);
                }

                if (config?.phase === 'reading') {
                    config.cancelled = true;
                }

                if (pending && pending.instance !== instance) {
                    return c.json({ status: 'failed', code: 'OLD_INSTANCE_PENDING' }, 409);
                }

                const sameInstance = pending;

                if (sameInstance?.phase === 'resolving') {
                    // Keep this entry until resolution actually settles; deleting
                    // it early would allow unbounded abandoned filesystem work.
                    sameInstance.cancelled = true;
                    return c.json({
                        status: 'ok',
                        operation: 'disable',
                        outcome: 'cancelled_before_execution',
                        runtime: instance.getPluginStatus(id),
                        processResources: 'unknown',
                    });
                }

                if (sameInstance) {
                    sameInstance.cancelled = true;
                } else if (!config && !instance.getPluginStatus(id)) {
                    return c.json({ status: 'failed', code: 'PLUGIN_NOT_ACTIVE' }, 409);
                }

                pendingDisables.set(key, instance);

                try {
                    await instance.disablePlugin(id);
                } finally {
                    if (pendingDisables.get(key) === instance) {
                        pendingDisables.delete(key);
                    }
                }
            }
        } catch (error) {
            if (manager.getInstance(uin) !== instance) {
                return c.json(
                    { status: 'failed', code: 'INSTANCE_CHANGED', outcome: 'unknown' },
                    409,
                );
            }

            if (ownedPending?.cancelled && ownedPending.phase === 'resolving') {
                return c.json({ status: 'failed', code: 'ENABLE_CANCELLED' }, 409);
            }

            if (error instanceof LocalPluginCatalogError) {
                const code =
                    error.code === 'not_found' ? 'PLUGIN_NOT_FOUND' : 'LOCAL_CATALOG_ERROR';
                return c.json({ status: 'failed', code }, error.code === 'not_found' ? 404 : 400);
            }

            // Plugin errors may contain arbitrary data. Expose only a fixed code
            // and the host's bounded state; never claim that side effects did not occur.
            return c.json(
                {
                    status: 'failed',
                    code: operation === 'enable' ? 'PLUGIN_ENABLE_FAILED' : 'PLUGIN_DISABLE_FAILED',
                    outcome: 'unknown',
                    runtime: instance.getPluginStatus(id),
                    processResources: 'unknown',
                },
                409,
            );
        } finally {
            if (ownedPending && pendingEnables.get(key) === ownedPending) {
                pendingEnables.delete(key);
            }
        }

        if (manager.getInstance(uin) !== instance) {
            return c.json({ status: 'failed', code: 'INSTANCE_CHANGED', outcome: 'unknown' }, 409);
        }

        return c.json({
            status: 'ok',
            operation,
            runtime: instance.getPluginStatus(id),
            processResources: 'unknown' as const,
        });
    });
}
