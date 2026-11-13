import {
    ApiError,
    type CommunityIndexResult,
    type CommunityPlugin,
    type LocalPluginStatus,
    type LocalPluginsResult,
    type LocalPluginMutationResult,
    type PluginConfigField,
    type PluginConfigValue,
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
                ((pending.operation === 'enable' &&
                    (pending.phase === 'resolving' || pending.phase === 'invoked')) ||
                    (['config-schema', 'config-read', 'config-write'].includes(
                        String(pending.operation),
                    ) &&
                        (pending.phase === 'reading' || pending.phase === 'invoked')) ||
                    (pending.operation === 'disable' && pending.phase === 'draining')) &&
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

const DANGEROUS_CONFIG_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainConfigRecord(value: unknown): value is Record<string, unknown> {
    if (!isRecord(value)) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
        return false;
    }

    if (Object.getOwnPropertySymbols(value).length) {
        return false;
    }

    return Object.values(Object.getOwnPropertyDescriptors(value)).every(
        (item) => item.enumerable && 'value' in item,
    );
}

function unsupportedConfig(): never {
    throw new ApiError(502, '插件配置格式或字段暂不支持', 'CONFIG_UI_UNSUPPORTED');
}

/** Reject unsupported schema semantics instead of silently dropping fields. */
export function parseConfigFields(fields: unknown): PluginConfigField[] {
    if (!Array.isArray(fields) || fields.length > 64) {
        return unsupportedConfig();
    }

    const seen = new Set<string>();
    const accepted: PluginConfigField[] = [];

    for (const field of fields) {
        if (
            !isPlainConfigRecord(field) ||
            Object.keys(field).some(
                (key) => !['key', 'label', 'type', 'default', 'description'].includes(key),
            ) ||
            typeof field.key !== 'string' ||
            !field.key.trim() ||
            field.key.length > 128 ||
            [...field.key].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
            DANGEROUS_CONFIG_KEYS.has(field.key) ||
            seen.has(field.key) ||
            typeof field.label !== 'string' ||
            !field.label.trim() ||
            field.label.length > 256 ||
            typeof field.type !== 'string' ||
            !['string', 'text', 'number', 'boolean'].includes(field.type) ||
            (field.description !== undefined &&
                (typeof field.description !== 'string' || field.description.length > 1024))
        ) {
            return unsupportedConfig();
        }

        if (Object.hasOwn(field, 'default') && !isConfigScalar(field.type, field.default)) {
            return unsupportedConfig();
        }

        seen.add(field.key);
        accepted.push(field as unknown as PluginConfigField);
    }

    return accepted;
}

function isSafeConfigNumber(value: number): boolean {
    return (
        Number.isFinite(value) &&
        !Object.is(value, -0) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value))
    );
}

function isConfigScalar(type: string, value: unknown): value is string | number | boolean {
    if (type === 'string' || type === 'text') {
        return typeof value === 'string' && value.length <= 16384;
    }

    if (type === 'boolean') {
        return typeof value === 'boolean';
    }

    return type === 'number' && typeof value === 'number' && isSafeConfigNumber(value);
}

export function parseConfigValue(fields: PluginConfigField[], value: unknown): PluginConfigValue {
    if (!isPlainConfigRecord(value) || Object.keys(value).length !== fields.length) {
        return unsupportedConfig();
    }

    const result: PluginConfigValue = Object.create(null);

    for (const field of fields) {
        if (!Object.hasOwn(value, field.key) || !isConfigScalar(field.type, value[field.key])) {
            return unsupportedConfig();
        }

        result[field.key] = value[field.key] as string | number | boolean;
    }

    return result;
}

export function parseConfigNumber(text: string): number | null {
    const trimmed = text.trim();

    if (!trimmed || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
        return null;
    }

    const value = Number(trimmed);

    if (!isSafeConfigNumber(value)) {
        return null;
    }

    const [mantissa, exponentText] = trimmed.split(/[eE]/);
    const unsigned = mantissa.replace(/^[+-]/, '');
    const [whole, fractional = ''] = unsigned.split('.');
    const digits = `${whole}${fractional}`;

    if (value === 0 && /[1-9]/.test(digits)) {
        return null;
    }

    if (Number.isInteger(value) && value !== 0) {
        const scale = fractional.length - Number(exponentText ?? '0');

        if (scale > 0 && /[1-9]/.test(digits.slice(-scale))) {
            return null;
        }
    }

    return value;
}

export function isPluginGeneration(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    );
}

export function parseConfigEnvelope(
    value: unknown,
    operation: 'schema' | 'read' | 'write',
    expectedGeneration?: string,
): unknown {
    if (!isRecord(value) || value.status !== 'ok' || value.processResources !== 'unknown') {
        return unsupportedConfig();
    }

    if (
        !isPluginGeneration(value.generation) ||
        (operation !== 'schema' &&
            (!isPluginGeneration(expectedGeneration) || value.generation !== expectedGeneration))
    ) {
        throw new ApiError(
            409,
            '插件实例已更替，请重新读取字段和配置',
            'CONFIG_GENERATION_CHANGED',
        );
    }

    if (
        operation === 'schema' &&
        (value.source === 'schema' || value.source === 'ui' || value.source === 'none') &&
        (value.source === 'none' ? value.fields === null : Array.isArray(value.fields))
    ) {
        return { source: value.source, fields: value.fields, generation: value.generation };
    }

    if (operation === 'read' && value.source === 'plugin' && isRecord(value.value)) {
        return { source: value.source, value: value.value, generation: value.generation };
    }

    if (operation === 'write' && value.persistence === 'plugin-managed') {
        return { persistence: value.persistence, generation: value.generation };
    }

    return unsupportedConfig();
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
