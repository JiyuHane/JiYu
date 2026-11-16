import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginHost } from '../../src/plugin-host';
import type { PluginConfigBuilder, PluginConfigItem } from '../../src/plugin-host/config-builder';

// The fixture imports only this synthetic local module. These mocks veto the
// named network entry points if a tested module unexpectedly requests them.
const blockedNetwork = vi.hoisted(() => () => {
    throw new Error('unexpected network operation in synthetic host fixture');
});

vi.mock('node:net', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:net')>();
    const defaultExport = (actual as unknown as { default?: Record<string, unknown> }).default;
    const blocked = {
        connect: blockedNetwork,
        createConnection: blockedNetwork,
        createServer: blockedNetwork,
        Socket: blockedNetwork,
        Server: blockedNetwork,
    };
    return { ...actual, ...blocked, default: { ...(defaultExport ?? actual), ...blocked } };
});

vi.mock('node:http', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:http')>();
    const defaultExport = (actual as unknown as { default?: Record<string, unknown> }).default;
    const blocked = { createServer: blockedNetwork, request: blockedNetwork, get: blockedNetwork };
    return { ...actual, ...blocked, default: { ...(defaultExport ?? actual), ...blocked } };
});

vi.mock('node:https', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:https')>();
    const defaultExport = (actual as unknown as { default?: Record<string, unknown> }).default;
    const blocked = { createServer: blockedNetwork, request: blockedNetwork, get: blockedNetwork };
    return { ...actual, ...blocked, default: { ...(defaultExport ?? actual), ...blocked } };
});

vi.mock('@snowluma/websocket', () => ({
    WebSocket: blockedNetwork,
    WebSocketServer: blockedNetwork,
}));

const roots: string[] = [];

beforeEach(() => {
    vi.stubGlobal('fetch', blockedNetwork);
    vi.stubGlobal('WebSocket', blockedNetwork);
});

afterEach(async () => {
    try {
        for (const root of roots.splice(0)) {
            await rm(root, { recursive: true, force: true });
        }
    } finally {
        delete (globalThis as Record<string, unknown>).__copierPlaceholderProbe;
        vi.unstubAllGlobals();
    }
});

async function fixture(): Promise<{ root: string; plugin: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'jiyu-copier-placeholder-'));
    roots.push(root);
    const plugin = path.join(root, 'plugin');
    await mkdir(plugin);
    await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
    await writeFile(
        path.join(plugin, 'index.mjs'),
        `
        export let plugin_config_schema = [];
        export function plugin_init(c) {
            globalThis.__copierPlaceholderProbe = {
                builder: c.NapCatConfig,
                setSchema(value) { plugin_config_schema = value; }
            };
        }
        `,
    );
    return { root, plugin };
}

type Probe = {
    builder: PluginConfigBuilder;
    setSchema(value: PluginConfigItem[]): void;
};

describe('synthetic host schema copier with an inherited placeholder accessor', () => {
    it.each([false, true])(
        'copies own metadata without inherited access (setter: %s)',
        async (withSetter) => {
            const { root, plugin } = await fixture();
            const host = new PluginHost({
                accountId: '123',
                stateRoot: path.join(root, 'state'),
                managerConfig: {},
                invokeAction: async () => {
                    throw new Error('unexpected action');
                },
                isStreamAction: () => false,
                logger: () => {},
            });

            try {
                await host.enable('demo', plugin);
                const probe = (globalThis as Record<string, unknown>).__copierPlaceholderProbe as
                    Probe | undefined;

                if (!probe) {
                    throw new Error('missing synthetic plugin probe');
                }

                // Prepare all source objects before installing the inherited accessor.
                const fields: PluginConfigItem[] = [
                    {
                        key: 'message',
                        label: 'Message',
                        type: 'string',
                        default: '',
                        placeholder: 'hint',
                    },
                    { key: 'count', label: 'Count', type: 'number', default: 0, placeholder: '' },
                    { key: 'enabled', label: 'Enabled', type: 'boolean', default: false },
                    {
                        key: 'choices',
                        label: 'Choices',
                        type: 'multi-select',
                        options: [
                            { label: 'one', value: 1 },
                            { label: 'text', value: '1' },
                        ],
                        default: [1, '1'],
                        placeholder: 'choose',
                    },
                ];
                const before = structuredClone(fields);
                const beforeJson = JSON.stringify(fields);
                const beforeDescriptors = fields.map((field) =>
                    Object.getOwnPropertyDescriptors(field),
                );
                const marker = probe.builder.plainText('synthetic display');
                const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'placeholder');
                let getterCalls = 0;
                let setterCalls = 0;
                const inherited: PropertyDescriptor = {
                    configurable: true,
                    get() {
                        getterCalls++;
                        return 'inherited';
                    },
                };

                if (withSetter) {
                    inherited.set = () => {
                        setterCalls++;
                    };
                }

                let built: PluginConfigItem[] | undefined;
                let result: Awaited<ReturnType<PluginHost['getConfigSchema']>> | undefined;
                Object.defineProperty(Object.prototype, 'placeholder', inherited);

                try {
                    built = probe.builder.combine(marker, ...fields);
                    probe.setSchema(built);
                    result = await host.getConfigSchema('demo');
                } finally {
                    if (previous) {
                        Object.defineProperty(Object.prototype, 'placeholder', previous);
                    } else {
                        delete (Object.prototype as { placeholder?: unknown }).placeholder;
                    }
                }

                expect(getterCalls).toBe(0);
                expect(setterCalls).toBe(0);

                if (!built || !result?.fields) {
                    throw new Error('missing synthetic schema');
                }

                expect(fields).toEqual(before);
                expect(JSON.stringify(fields)).toBe(beforeJson);
                expect(fields.map((field) => Object.getOwnPropertyDescriptors(field))).toEqual(
                    beforeDescriptors,
                );
                expect(fields.every((field) => !Object.isFrozen(field))).toBe(true);
                expect(Object.isFrozen(built)).toBe(true);
                expect(built.every(Object.isFrozen)).toBe(true);
                expect(Object.isFrozen(built[4].options)).toBe(true);
                expect(Object.isFrozen(built[4].default)).toBe(true);
                expect(result.source).toBe('schema');
                expect(result.fields).toEqual(built);
                expect(JSON.stringify(result.fields)).toBe(JSON.stringify(built));
                expect(result.displaySidecar?.entries).toEqual([{ index: 0, kind: 'plainText' }]);
                expect(result.displaySidecar?.snapshot).toEqual(result.fields);
                expect(result.displaySidecar?.snapshot).not.toBe(result.fields);

                for (let index = 0; index < fields.length; index++) {
                    const source = fields[index];
                    const output = result.fields[index + 1];

                    if (!output || typeof output !== 'object' || Array.isArray(output)) {
                        throw new Error('missing copied declaration');
                    }

                    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
                    expect(Object.keys(output)).toEqual(Object.keys(source));

                    if (Object.hasOwn(source, 'placeholder')) {
                        expect(Object.getOwnPropertyDescriptor(output, 'placeholder')).toEqual({
                            value: source.placeholder,
                            enumerable: true,
                            writable: true,
                            configurable: true,
                        });
                        expect(
                            Object.getOwnPropertyDescriptor(built[index + 1], 'placeholder'),
                        ).toEqual({
                            value: source.placeholder,
                            enumerable: true,
                            writable: false,
                            configurable: false,
                        });
                    } else {
                        expect(Object.hasOwn(output, 'placeholder')).toBe(false);
                        expect(Object.hasOwn(built[index + 1], 'placeholder')).toBe(false);
                    }
                }

                let ownGetterCalls = 0;
                const accessor: PluginConfigItem = { key: 'bad', label: 'Bad', type: 'string' };
                Object.defineProperty(accessor, 'placeholder', {
                    enumerable: true,
                    get() {
                        ownGetterCalls++;
                        return 'must not run';
                    },
                });
                expect(() => probe.builder.combine(accessor)).toThrow('CONFIG_INVALID');
                probe.setSchema([accessor]);
                await expect(host.getConfigSchema('demo')).rejects.toMatchObject({
                    code: 'CONFIG_INVALID',
                });
                expect(ownGetterCalls).toBe(0);
            } finally {
                await host.shutdown();
            }
        },
    );
});
