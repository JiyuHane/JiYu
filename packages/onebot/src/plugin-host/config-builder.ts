import { randomUUID } from 'node:crypto';
import type { JsonObject, JsonValue } from '../types';

/** Independently implemented data-only subset of the public NapCat plugin API.
 * NapCatQQ is Copyright © 2024 Mlikiowa. No NapCat implementation is included.
 */
type OptionValue = string | number;
type ConfigOption = { label: string; value: OptionValue };
export type PluginConfigItem = JsonObject & {
    key: string;
    label: string;
    type: 'string' | 'number' | 'boolean' | 'select' | 'multi-select' | 'html' | 'text';
};

export interface PluginConfigBuilder {
    text(
        key: string,
        label: string,
        defaultValue?: string,
        description?: string,
        reactive?: boolean,
    ): PluginConfigItem;
    number(
        key: string,
        label: string,
        defaultValue?: number,
        description?: string,
        reactive?: boolean,
    ): PluginConfigItem;
    boolean(
        key: string,
        label: string,
        defaultValue?: boolean,
        description?: string,
        reactive?: boolean,
    ): PluginConfigItem;
    select(
        key: string,
        label: string,
        options: ConfigOption[],
        defaultValue?: OptionValue,
        description?: string,
        reactive?: boolean,
    ): PluginConfigItem;
    multiSelect(
        key: string,
        label: string,
        options: ConfigOption[],
        defaultValue?: OptionValue[],
        description?: string,
        reactive?: boolean,
    ): PluginConfigItem;
    html(content: string): PluginConfigItem;
    plainText(content: string): PluginConfigItem;
    combine(...items: PluginConfigItem[]): PluginConfigItem[];
}

interface BuilderDependencies {
    /** Existing host copier checks bytes, depth, nodes, proxy traps and JSON. */
    copySchema(input: unknown): JsonValue;
    invalid(): never;
    unsupported(feature: string): never;
}

const fields = new Set([
    'key',
    'label',
    'type',
    'description',
    'default',
    'options',
    'placeholder',
    'reactive',
    'hidden',
]);
const itemTypes = new Set([
    'string',
    'number',
    'boolean',
    'select',
    'multi-select',
    'html',
    'text',
]);
const reservedKeys = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_ITEMS = 256;
const MAX_OPTIONS = 256;
const MAX_STRING = 16384;

/** Inputs are copied before inspection, so their accessors and proxies are never invoked. */
export function createConfigBuilder(deps: BuilderDependencies): PluginConfigBuilder {
    const invalid = deps.invalid;
    const isRecord = (value: JsonValue | undefined): value is JsonObject =>
        value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
    const isOptionValue = (value: JsonValue | undefined): value is OptionValue =>
        typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

    function checkStrings(value: JsonValue): void {
        if (typeof value === 'string') {
            if (value.length > MAX_STRING) {
                invalid();
            }
        } else if (Array.isArray(value)) {
            for (const item of value) {
                checkStrings(item);
            }
        } else if (value !== null && typeof value === 'object') {
            for (const [key, item] of Object.entries(value)) {
                if (key.length > MAX_STRING) {
                    invalid();
                }

                checkStrings(item);
            }
        }
    }

    function checkOptions(value: JsonValue): void {
        if (!Array.isArray(value) || value.length > MAX_OPTIONS) {
            invalid();
        }

        for (const option of value as JsonValue[]) {
            if (
                !isRecord(option) ||
                Object.keys(option).length !== 2 ||
                typeof option.label !== 'string' ||
                option.label.length > 256 ||
                !isOptionValue(option.value) ||
                !Object.hasOwn(option, 'label') ||
                !Object.hasOwn(option, 'value')
            ) {
                invalid();
            }
        }
    }

    function checkItem(value: JsonValue): asserts value is PluginConfigItem {
        if (
            !isRecord(value) ||
            Object.keys(value).some((key) => !fields.has(key)) ||
            typeof value.key !== 'string' ||
            value.key.length > 128 ||
            reservedKeys.has(value.key) ||
            typeof value.label !== 'string' ||
            value.label.length > 256 ||
            typeof value.type !== 'string' ||
            !itemTypes.has(value.type)
        ) {
            return invalid();
        }

        if (
            Object.hasOwn(value, 'description') &&
            (typeof value.description !== 'string' || value.description.length > 1024)
        ) {
            invalid();
        }

        if (
            Object.hasOwn(value, 'placeholder') &&
            (typeof value.placeholder !== 'string' || value.placeholder.length > 1024)
        ) {
            invalid();
        }

        if (Object.hasOwn(value, 'reactive') && typeof value.reactive !== 'boolean') {
            invalid();
        }

        if (Object.hasOwn(value, 'hidden') && typeof value.hidden !== 'boolean') {
            invalid();
        }

        if (Object.hasOwn(value, 'options')) {
            checkOptions(value.options);
        }

        checkStrings(value);
    }

    function freeze<T extends JsonValue>(value: T): T {
        if (value !== null && typeof value === 'object') {
            for (const nested of Object.values(value)) {
                freeze(nested);
            }

            Object.freeze(value);
        }

        return value;
    }

    function snapshot(input: unknown): JsonValue {
        try {
            return deps.copySchema(input);
        } catch {
            return invalid();
        }
    }

    function item(
        kind: string,
        key: string,
        label: string,
        value: unknown,
        description: string | undefined,
        reactive: boolean | undefined,
        options?: unknown,
    ): PluginConfigItem {
        const raw: Record<string, unknown> = { key, label, type: kind };

        if (value !== undefined) {
            raw.default = value;
        }

        if (description !== undefined) {
            raw.description = description;
        }

        if (reactive !== undefined) {
            raw.reactive = reactive;
        }

        if (options !== undefined) {
            raw.options = options;
        }

        const copy = snapshot(raw);
        checkItem(copy);

        if (kind === 'select' || kind === 'multi-select') {
            if (!Object.hasOwn(copy, 'options')) {
                invalid();
            }
        }

        if (value !== undefined) {
            const result = copy.default;

            if (
                (kind === 'string' && typeof result !== 'string') ||
                (kind === 'number' && (typeof result !== 'number' || !Number.isFinite(result))) ||
                (kind === 'boolean' && typeof result !== 'boolean') ||
                (kind === 'select' && !isOptionValue(result)) ||
                (kind === 'multi-select' &&
                    (!Array.isArray(result) ||
                        result.length > MAX_OPTIONS ||
                        !result.every(isOptionValue)))
            ) {
                invalid();
            }
        }

        return freeze(copy);
    }

    function displayItem(kind: 'html' | 'text', content: string): PluginConfigItem {
        if (typeof content !== 'string' || content.length > MAX_STRING) {
            return invalid();
        }

        const key = `_${kind}_${randomUUID().replaceAll('-', '')}`;
        return item(kind, key, '', content, undefined, undefined);
    }

    const builder: PluginConfigBuilder = {
        text: (key, label, value, description, reactive) =>
            item('string', key, label, value, description, reactive),
        number: (key, label, value, description, reactive) =>
            item('number', key, label, value, description, reactive),
        boolean: (key, label, value, description, reactive) =>
            item('boolean', key, label, value, description, reactive),
        select: (key, label, options, value, description, reactive) =>
            item('select', key, label, value, description, reactive, options),
        multiSelect: (key, label, options, value, description, reactive) =>
            item('multi-select', key, label, value, description, reactive, options),
        html: (content) => displayItem('html', content),
        plainText: (content) => displayItem('text', content),
        combine: (...items) => {
            if (items.length > MAX_ITEMS) {
                invalid();
            }

            const copy = snapshot(items);

            if (!Array.isArray(copy)) {
                return invalid();
            }

            for (const part of copy) {
                checkItem(part);
            }

            return freeze(copy) as PluginConfigItem[];
        },
    };
    return Object.freeze(builder);
}
