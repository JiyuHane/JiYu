import {
    ApiError,
    type CommunityIndexResult,
    type CommunityPlugin,
    type LocalPluginStatus,
    type LocalPluginsResult,
    type LocalPluginMutationResult,
} from '@/lib/api/types';

function invalid(): never {
    throw new ApiError(502, '插件索引响应格式无效', 'INVALID_RESPONSE');
}

function invalidLocal(): never {
    throw new ApiError(502, '本地插件响应格式无效', 'INVALID_RESPONSE');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate response fields before the UI can treat them as observed facts. */
export function parsePluginIndex(value: unknown): CommunityIndexResult {
    if (
        !isRecord(value) ||
        typeof value.stale !== 'boolean' ||
        value.verified !== false ||
        value.minVersionTarget !== 'NapCat' ||
        !(
            value.fetchedAt === null ||
            (typeof value.fetchedAt === 'number' && Number.isFinite(value.fetchedAt))
        ) ||
        !(
            value.error === null ||
            (typeof value.error === 'string' &&
                ['timeout', 'network', 'http', 'too_large', 'invalid'].includes(value.error))
        )
    ) {
        return invalid();
    }

    if (value.index === null) {
        if (value.fetchedAt !== null || !value.stale || value.error === null) {
            return invalid();
        }

        return value as unknown as CommunityIndexResult;
    }

    if (
        !isRecord(value.index) ||
        typeof value.index.version !== 'string' ||
        typeof value.index.updateTime !== 'string' ||
        !Array.isArray(value.index.plugins) ||
        typeof value.fetchedAt !== 'number'
    ) {
        return invalid();
    }

    for (const plugin of value.index.plugins) {
        if (
            !isRecord(plugin) ||
            ![
                'id',
                'name',
                'version',
                'description',
                'author',
                'homepage',
                'downloadUrl',
                'minVersion',
            ].every((key) => typeof plugin[key] === 'string') ||
            (plugin.tags !== undefined &&
                (!Array.isArray(plugin.tags) ||
                    !plugin.tags.every((tag: unknown) => typeof tag === 'string')))
        ) {
            return invalid();
        }
    }

    return value as unknown as CommunityIndexResult;
}

const LOCAL_PLUGIN_ID = /^(?!con$|prn$|aux$|nul$|com[1-9]$|lpt[1-9]$)[a-z0-9][a-z0-9_-]{0,79}$/;

function isLocalPluginId(value: unknown): value is string {
    return typeof value === 'string' && LOCAL_PLUGIN_ID.test(value);
}

export function isLocalPluginStatus(value: unknown): value is LocalPluginStatus {
    return (
        isRecord(value) &&
        isLocalPluginId(value.id) &&
        typeof value.state === 'string' &&
        ['initializing', 'active', 'stopping', 'cleanup_failed'].includes(value.state) &&
        typeof value.cleanupFailed === 'boolean' &&
        typeof value.initializationFailed === 'boolean' &&
        typeof value.pendingActions === 'number' &&
        Number.isSafeInteger(value.pendingActions) &&
        value.pendingActions >= 0 &&
        value.processResources === 'unknown'
    );
}

export function parseLocalPlugins(value: unknown): LocalPluginsResult {
    if (
        !isRecord(value) ||
        value.status !== 'ok' ||
        typeof value.accountOnline !== 'boolean' ||
        value.processResources !== 'unknown' ||
        !Array.isArray(value.candidates) ||
        !value.candidates.every(isLocalPluginId) ||
        !(
            value.runtime === null ||
            (Array.isArray(value.runtime) && value.runtime.every(isLocalPluginStatus))
        ) ||
        !Array.isArray(value.actions) ||
        !value.actions.every(
            (action: unknown) =>
                isRecord(action) &&
                isLocalPluginId(action.id) &&
                typeof action.canEnable === 'boolean' &&
                typeof action.canDisable === 'boolean' &&
                (action.enableReason === null || typeof action.enableReason === 'string') &&
                (action.disableReason === null || typeof action.disableReason === 'string'),
        ) ||
        !Array.isArray(value.pendingOperations) ||
        !value.pendingOperations.every(
            (pending: unknown) =>
                isRecord(pending) &&
                isLocalPluginId(pending.id) &&
                pending.operation === 'enable' &&
                (pending.phase === 'resolving' || pending.phase === 'invoked') &&
                typeof pending.cancelled === 'boolean' &&
                typeof pending.currentInstance === 'boolean',
        )
    ) {
        return invalidLocal();
    }

    return value as unknown as LocalPluginsResult;
}

export function parseLocalPluginMutation(
    value: unknown,
    operation: 'enable' | 'disable',
): LocalPluginMutationResult {
    if (
        !isRecord(value) ||
        value.status !== 'ok' ||
        value.operation !== operation ||
        value.processResources !== 'unknown' ||
        !(value.runtime === null || isLocalPluginStatus(value.runtime)) ||
        !(
            value.outcome === undefined ||
            (operation === 'disable' && value.outcome === 'cancelled_before_execution')
        )
    ) {
        return invalidLocal();
    }

    return value as unknown as LocalPluginMutationResult;
}

/** The index homepage remains visible as supplied, but only HTTPS links are navigable. */
export function safePluginHomepage(homepage: string): string | null {
    try {
        const url = new URL(homepage);
        return url.protocol === 'https:' && !url.username && !url.password ? homepage : null;
    } catch {
        return null;
    }
}

export function filterPlugins(plugins: CommunityPlugin[], query: string): CommunityPlugin[] {
    const needle = query.trim().toLocaleLowerCase();

    if (!needle) {
        return plugins;
    }

    return plugins.filter((plugin) =>
        [plugin.id, plugin.name, plugin.description, plugin.author, ...(plugin.tags ?? [])].some(
            (field) => field.toLocaleLowerCase().includes(needle),
        ),
    );
}
