import {
    ApiError,
    type CommunityIndexResult,
    type CommunityPlugin,
    type LocalPluginStatus,
    type LocalPluginsResult,
    type LocalPluginMutationResult,
    type PluginConfigField,
    type PluginConfigValue,
    type PluginDisplaySidecar,
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
                (key) =>
                    !['key', 'label', 'type', 'default', 'description', 'reactive', 'hidden'].includes(
                        key,
                    ),
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
            (Object.hasOwn(field, 'reactive') && field.reactive !== false) ||
            (Object.hasOwn(field, 'hidden') && field.hidden !== false) ||
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

export interface PluginConfigView {
    readonly fields: PluginConfigField[];
    readonly displayTexts: string[];
    readonly readOnly: boolean;
}

/** Compare the two decoded JSON snapshots without invoking object accessors. */
function sameConfigSnapshot(left: unknown, right: unknown): boolean {
    let visited = 0;

    const same = (a: unknown, b: unknown, depth: number): boolean => {
        if (++visited > 20000 || depth > 20) {
            return false;
        }

        if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
            if (typeof a === 'number' && !Number.isFinite(a)) {
                return false;
            }

            return (
                (a === null || ['string', 'number', 'boolean'].includes(typeof a)) &&
                Object.is(a, b)
            );
        }

        if (Array.isArray(a) || Array.isArray(b)) {
            if (
                !Array.isArray(a) ||
                !Array.isArray(b) ||
                Object.getPrototypeOf(a) !== Array.prototype ||
                Object.getPrototypeOf(b) !== Array.prototype ||
                a.length !== b.length ||
                a.length > 10000
            ) {
                return false;
            }

            const ak = Reflect.ownKeys(a);
            const bk = Reflect.ownKeys(b);

            if (ak.length !== a.length + 1 || bk.length !== b.length + 1) {
                return false;
            }

            for (let index = 0; index < a.length; index++) {
                const av = Object.getOwnPropertyDescriptor(a, String(index));
                const bv = Object.getOwnPropertyDescriptor(b, String(index));

                if (
                    !av ||
                    !bv ||
                    !av.enumerable ||
                    !bv.enumerable ||
                    !('value' in av) ||
                    !('value' in bv) ||
                    !same(av.value, bv.value, depth + 1)
                ) {
                    return false;
                }
            }

            return true;
        }

        if (!isPlainConfigRecord(a) || !isPlainConfigRecord(b)) {
            return false;
        }

        const ak = Object.keys(a);
        const bk = Object.keys(b);

        if (ak.length !== bk.length) {
            return false;
        }

        for (const key of ak) {
            const av = Object.getOwnPropertyDescriptor(a, key);
            const bv = Object.getOwnPropertyDescriptor(b, key);

            if (
                !av ||
                !bv ||
                !('value' in av) ||
                !('value' in bv) ||
                !same(av.value, bv.value, depth + 1)
            ) {
                return false;
            }
        }

        return true;
    };

    return same(left, right, 0);
}

/** Sidecar is a read-only server observation, not an authentication or sandbox proof. */
export function parseConfigView(fields: unknown, sidecar?: PluginDisplaySidecar): PluginConfigView {
    if (sidecar === undefined) {
        return { fields: parseConfigFields(fields), displayTexts: [], readOnly: false };
    }

    if (
        !isPlainConfigRecord(sidecar) ||
        Object.keys(sidecar).length !== 5 ||
        Object.keys(sidecar).some(
            (key) => !['version', 'generation', 'source', 'snapshot', 'entries'].includes(key),
        ) ||
        !['version', 'generation', 'source', 'snapshot', 'entries'].every((key) =>
            Object.hasOwn(sidecar, key),
        ) ||
        sidecar.version !== 1 ||
        !isPluginGeneration(sidecar.generation) ||
        (sidecar.source !== 'schema' && sidecar.source !== 'ui') ||
        !Array.isArray(fields) ||
        fields.length > 64 ||
        !Array.isArray(sidecar.snapshot) ||
        !sameConfigSnapshot(fields, sidecar.snapshot) ||
        !Array.isArray(sidecar.entries) ||
        !sameConfigSnapshot(sidecar.entries, sidecar.entries) ||
        sidecar.entries.length < 1 ||
        sidecar.entries.length > fields.length
    ) {
        return unsupportedConfig();
    }

    const marked = new Set<number>();

    for (const entry of sidecar.entries) {
        if (
            !isPlainConfigRecord(entry) ||
            Object.keys(entry).length !== 2 ||
            !Object.hasOwn(entry, 'index') ||
            !Object.hasOwn(entry, 'kind') ||
            entry.kind !== 'plainText' ||
            !Number.isSafeInteger(entry.index) ||
            entry.index < 0 ||
            entry.index >= fields.length ||
            marked.has(entry.index)
        ) {
            return unsupportedConfig();
        }

        marked.add(entry.index);
    }

    const seen = new Set<string>();
    const editable: PluginConfigField[] = [];
    const displayTexts: string[] = [];

    for (let index = 0; index < fields.length; index++) {
        const field: unknown = fields[index];

        if (
            !isPlainConfigRecord(field) ||
            !Object.hasOwn(field, 'key') ||
            typeof field.key !== 'string' ||
            !field.key.trim() ||
            field.key.length > 128 ||
            [...field.key].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
            DANGEROUS_CONFIG_KEYS.has(field.key) ||
            seen.has(field.key)
        ) {
            return unsupportedConfig();
        }

        seen.add(field.key);

        if (marked.has(index)) {
            if (
                Object.keys(field).length !== 4 ||
                !Object.hasOwn(field, 'type') ||
                !Object.hasOwn(field, 'label') ||
                field.type !== 'text' ||
                field.label !== '' ||
                typeof field.default !== 'string' ||
                field.default.length > 16384 ||
                !Object.hasOwn(field, 'default')
            ) {
                return unsupportedConfig();
            }

            displayTexts.push(field.default);
        } else {
            editable.push(...parseConfigFields([field]));
        }
    }

    return { fields: editable, displayTexts, readOnly: true };
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
        if (Object.hasOwn(value, 'displaySidecar')) {
            const sidecar = value.displaySidecar;

            if (
                value.source === 'none' ||
                !isPlainConfigRecord(sidecar) ||
                sidecar.generation !== value.generation ||
                sidecar.source !== value.source
            ) {
                return unsupportedConfig();
            }

            parseConfigView(value.fields, sidecar as unknown as PluginDisplaySidecar);
            return {
                source: value.source,
                fields: value.fields,
                generation: value.generation,
                displaySidecar: sidecar,
            };
        }

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
