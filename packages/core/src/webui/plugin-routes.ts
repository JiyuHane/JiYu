import type { Hono } from 'hono';
import type { OneBotManager } from '@snowluma/onebot/manager';
import { LocalPluginCatalogError, type LocalPluginCatalog } from './plugin-local';

const UIN = /^\d{5,10}$/;
const PLUGIN_ID = /^(?!con$|prn$|aux$|nul$|com[1-9]$|lpt[1-9]$)[a-z0-9][a-z0-9_-]{0,79}$/;

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
    const pendingEnables = new Map<string, PendingEnable>();
    const keyFor = (uin: string, id: string) => `${uin}:${id}`;
    const atPendingLimit = (uin: string) =>
        pendingEnables.size >= 128 ||
        [...pendingEnables.keys()].filter((key) => key.startsWith(`${uin}:`)).length >= 16;

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
        const pendingOperations = [...pendingEnables.entries()]
            .filter(([key]) => key.startsWith(`${uin}:`))
            .map(([key, pending]) => ({
                id: key.slice(uin.length + 1),
                operation: 'enable' as const,
                phase: pending.phase,
                cancelled: pending.cancelled,
                currentInstance: pending.instance === instance,
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
                  : pending?.cancelled
                    ? 'CANCELLATION_PENDING'
                    : pending
                      ? null
                      : !current
                        ? 'NOT_LOADED'
                        : current.state === 'stopping'
                          ? 'CLEANUP_IN_PROGRESS'
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

                if (pendingEnables.has(key) || instance.getPluginStatus(id)) {
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
                } else if (!instance.getPluginStatus(id)) {
                    return c.json({ status: 'failed', code: 'PLUGIN_NOT_ACTIVE' }, 409);
                }

                await instance.disablePlugin(id);
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
