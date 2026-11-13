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
async function readConfigBody(
    request: Request,
    registerReader: (cancel: () => void) => void,
    unregisterReader: (cancel: () => void) => void,
    cancelReader: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
    markCleanupUncertain: () => void,
    isCancelled: () => boolean,
): Promise<unknown> {
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

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancel: (() => void) | undefined;
    let streamDone = false;
    let cleanupFailed = false;
    let failure: InvalidConfigBody | undefined;
    let value: unknown;

    try {
        reader = request.body.getReader();
        const acquired = reader;
        cancel = () => cancelReader(acquired);
        registerReader(cancel);
        request.signal.addEventListener('abort', cancel, { once: true });
        const bytes = new Uint8Array(MAX_CONFIG_BYTES);
        let size = 0;
        let chunks = 0;

        if (request.signal.aborted || isCancelled()) {
            cancel();
            throw new InvalidConfigBody();
        }

        for (;;) {
            const part = await reader.read();

            if (part.done) {
                streamDone = true;
            }

            if (request.signal.aborted || isCancelled()) {
                throw new InvalidConfigBody();
            }

            if (part.done) {
                break;
            }

            if (!types.isUint8Array(part.value)) {
                throw new InvalidConfigBody();
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

        value = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)),
        );

        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            throw new InvalidConfigBody();
        }
    } catch (error) {
        // Until the reader reports done, an exception does not establish that
        // the underlying source stopped. Cancellation is idempotently tracked.
        if (reader && !streamDone) {
            try {
                cancelReader(reader);
            } catch {
                markCleanupUncertain();
            }
        } else if (!reader) {
            cancelUnreadBody(request);
        }

        failure = error instanceof InvalidConfigBody ? error : new InvalidConfigBody();
    } finally {
        if (cancel) {
            try {
                request.signal.removeEventListener('abort', cancel);
            } catch {
                cleanupFailed = true;
            }

            try {
                unregisterReader(cancel);
            } catch {
                cleanupFailed = true;
            }
        }

        if (reader) {
            try {
                reader.releaseLock();
            } catch {
                cleanupFailed = true;
            }
        }

        if (cleanupFailed) {
            markCleanupUncertain();
        }
    }

    if (cleanupFailed) {
        throw new InvalidConfigBody();
    }

    if (failure) {
        throw failure;
    }

    return value;
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
        cancelRead?: () => void;
        cleanup?: 'pending' | 'uncertain' | 'settled';
        cleanupFailed?: boolean;
        handlerFinished?: boolean;
    };
    const pendingEnables = new Map<string, PendingEnable>();
    const pendingConfigs = new Map<string, PendingConfig>();
    const pendingDisables = new Map<string, { instance: Instance }>();
    const keyFor = (uin: string, id: string) => `${uin}:${id}`;

    const releaseFinishedConfig = (key: string, pending: PendingConfig) => {
        if (
            pending.handlerFinished &&
            !pending.cleanupFailed &&
            (pending.cleanup === undefined || pending.cleanup === 'settled') &&
            pendingConfigs.get(key) === pending
        ) {
            pendingConfigs.delete(key);
        }
    };

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
                ...(pending.cleanupFailed ||
                pending.cleanup === 'pending' ||
                pending.cleanup === 'uncertain'
                    ? { cleanup: 'cleanup_uncertain' as const }
                    : {}),
                instance: pending.instance,
            })),
            ...[...pendingDisables.entries()].map(([key, owner]) => ({
                key,
                operation: 'disable' as const,
                phase: 'draining' as const,
                cancelled: false,
                instance: owner.instance,
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

    app.get('/api/plugins/local/:uin/:id/manifest', async (c) => {
        const { uin, id } = c.req.param();

        if (!UIN.test(uin) || !PLUGIN_ID.test(id)) {
            return c.json({ status: 'failed', code: 'INVALID_SELECTION' }, 400);
        }

        const instance = manager.getInstance(uin);

        if (!catalog.previewManifest) {
            return c.json({ status: 'failed', code: 'LOCAL_MANIFEST_UNAVAILABLE' }, 503);
        }

        try {
            const preview = await catalog.previewManifest(id);

            if (manager.getInstance(uin) !== instance) {
                return c.json({ status: 'failed', code: 'INSTANCE_CHANGED' }, 409);
            }

            return c.json({
                status: 'ok',
                id,
                declarations: { main: preview.declarations.main, type: preview.declarations.type },
                invalidFields: preview.invalidFields,
                source: 'local-unverified' as const,
            });
        } catch (error) {
            if (manager.getInstance(uin) !== instance) {
                return c.json({ status: 'failed', code: 'INSTANCE_CHANGED' }, 409);
            }

            if (error instanceof LocalPluginCatalogError) {
                if (error.code === 'not_found' || error.code === 'manifest_missing') {
                    return c.json({ status: 'failed', code: 'LOCAL_MANIFEST_NOT_FOUND' }, 404);
                }

                if (error.code === 'invalid_id') {
                    return c.json({ status: 'failed', code: 'INVALID_SELECTION' }, 400);
                }

                if (error.code === 'unsafe_path') {
                    return c.json({ status: 'failed', code: 'LOCAL_MANIFEST_CHANGED' }, 409);
                }

                if (error.code === 'manifest_invalid' || error.code === 'manifest_too_large') {
                    return c.json(
                        {
                            status: 'failed',
                            code:
                                error.code === 'manifest_invalid'
                                    ? 'LOCAL_MANIFEST_INVALID'
                                    : 'LOCAL_MANIFEST_TOO_LARGE',
                        },
                        409,
                    );
                }
            }

            return c.json({ status: 'failed', code: 'LOCAL_MANIFEST_UNAVAILABLE' }, 503);
        }
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

            // The host observation above may synchronously admit another request.
            // Read identity before the final map checks so reentry cannot overwrite it.
            const sameInstance = manager.getInstance(uin) === instance;

            if (!sameInstance) {
                return failure(
                    action === 'schema' ? 'INSTANCE_CHANGED' : 'CONFIG_GENERATION_CHANGED',
                    'not_started',
                    409,
                );
            }

            if (c.req.raw.signal.aborted) {
                return failure('OPERATION_CANCELLED', 'not_started', 409);
            }

            if (pendingEnables.has(key) || pendingConfigs.has(key) || pendingDisables.has(key)) {
                return failure('OPERATION_PENDING', 'not_started', 409);
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
                    let initialGeneration: string | null;

                    try {
                        initialGeneration = instance.getPluginConfigGeneration(id);
                    } catch {
                        return failure('CONFIG_GENERATION_CHANGED', 'not_started', 409);
                    }

                    if (
                        manager.getInstance(uin) !== instance ||
                        pending.cancelled ||
                        pendingDisables.has(key) ||
                        pendingConfigs.get(key) !== pending ||
                        !initialGeneration ||
                        !GENERATION.test(initialGeneration) ||
                        initialGeneration !== suppliedGeneration
                    ) {
                        return failure('CONFIG_GENERATION_CHANGED', 'not_started', 409);
                    }

                    if (c.req.raw.signal.aborted) {
                        return failure('OPERATION_CANCELLED', 'not_started', 409);
                    }

                    if (!instance.canEnablePlugins()) {
                        return failure('INSTANCE_QUIESCED', 'not_started', 409);
                    }

                    // Host methods may synchronously reenter management routes.
                    if (
                        manager.getInstance(uin) !== instance ||
                        pending.cancelled ||
                        pendingDisables.has(key) ||
                        pendingConfigs.get(key) !== pending
                    ) {
                        return failure('CONFIG_GENERATION_CHANGED', 'not_started', 409);
                    }

                    if (c.req.raw.signal.aborted) {
                        return failure('OPERATION_CANCELLED', 'not_started', 409);
                    }

                    bodyHandled = true;

                    try {
                        value = await readConfigBody(
                            c.req.raw,
                            (cancel) => {
                                pending.cancelRead = cancel;
                            },
                            (cancel) => {
                                if (pending.cancelRead === cancel) {
                                    pending.cancelRead = undefined;
                                }
                            },
                            (reader) => {
                                try {
                                    if (c.req.raw.signal.aborted) {
                                        pending.cancelled = true;
                                    }
                                } catch {
                                    pending.cleanupFailed = true;
                                }

                                if (pending.cleanup !== undefined) {
                                    return;
                                }

                                pending.cleanup = 'pending';

                                try {
                                    void reader.cancel().then(
                                        () => {
                                            pending.cleanup = 'settled';
                                            releaseFinishedConfig(key, pending);
                                        },
                                        () => {
                                            pending.cleanup = 'uncertain';
                                        },
                                    );
                                } catch {
                                    pending.cleanup = 'uncertain';
                                }
                            },
                            () => {
                                pending.cleanupFailed = true;
                            },
                            () => pending.cancelled,
                        );
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

                // Host observations can synchronously reenter disable or replace
                // the account. Recheck internal ownership after the last such calls.
                if (!instance.canEnablePlugins()) {
                    return failure('INSTANCE_QUIESCED', 'not_started', 409);
                }

                const sameInstance = manager.getInstance(uin) === instance;

                if (c.req.raw.signal.aborted) {
                    return failure('OPERATION_CANCELLED', 'not_started', 409);
                }

                if (
                    !sameInstance ||
                    pending.cancelled ||
                    pendingDisables.has(key) ||
                    pendingConfigs.get(key) !== pending
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
                pending.handlerFinished = true;
                releaseFinishedConfig(key, pending);
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
                    (pending && pending.instance !== instance) ||
                    (disabling && disabling.instance !== instance)
                ) {
                    return c.json({ status: 'failed', code: 'OLD_INSTANCE_PENDING' }, 409);
                }

                if (disabling) {
                    return c.json({ status: 'failed', code: 'CLEANUP_IN_PROGRESS' }, 409);
                }

                if (!config && !pending && atPendingLimit(uin)) {
                    return c.json({ status: 'failed', code: 'DISABLE_BUSY' }, 429);
                }

                // Claim a unique owner before stream cancellation or any host
                // observation: either can synchronously reenter this route.
                const owner = { instance };
                pendingDisables.set(key, owner);

                try {
                    if (manager.getInstance(uin) !== instance) {
                        return c.json(
                            { status: 'failed', code: 'INSTANCE_CHANGED', outcome: 'unknown' },
                            409,
                        );
                    }

                    if (config?.phase === 'reading') {
                        config.cancelled = true;
                        config.cancelRead?.();
                    }

                    if (pending?.phase === 'resolving') {
                        pending.cancelled = true;
                        return c.json({
                            status: 'ok',
                            operation: 'disable',
                            outcome: 'cancelled_before_execution',
                            runtime: instance.getPluginStatus(id),
                            processResources: 'unknown',
                        });
                    }

                    if (pending) {
                        pending.cancelled = true;
                    } else if (!config && !instance.getPluginStatus(id)) {
                        return c.json({ status: 'failed', code: 'PLUGIN_NOT_ACTIVE' }, 409);
                    }

                    if (manager.getInstance(uin) !== instance) {
                        return c.json(
                            { status: 'failed', code: 'INSTANCE_CHANGED', outcome: 'unknown' },
                            409,
                        );
                    }

                    await instance.disablePlugin(id);
                } finally {
                    if (pendingDisables.get(key) === owner) {
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
