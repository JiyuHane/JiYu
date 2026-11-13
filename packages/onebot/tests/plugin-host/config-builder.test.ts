import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginHost } from '../../src/plugin-host';

const roots: string[] = [];

async function fixture(source: string): Promise<{ root: string; plugin: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'jiyu-config-builder-'));
    roots.push(root);
    const plugin = path.join(root, 'plugin');
    await mkdir(plugin);
    await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
    await writeFile(path.join(plugin, 'index.mjs'), source);
    return { root, plugin };
}

function makeHost(root: string, accountId: string): PluginHost {
    return new PluginHost({
        accountId,
        stateRoot: path.join(root, 'state'),
        managerConfig: {},
        invokeAction: async () => {
            throw new Error('unexpected action');
        },
        isStreamAction: () => false,
        logger: () => {},
    });
}

afterEach(async () => {
    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }

    delete (globalThis as Record<string, unknown>).__jiyuBuilderProbe;
});

describe('independent plugin config builder', () => {
    it('builds pure snapshots in two accounts without changing config hooks', async () => {
        const { root, plugin } = await fixture(`
            let saved = { value: 'initial' };
            export let plugin_config_schema;
            export function plugin_init(ctx) {
                const b = ctx.NapCatConfig;
                const options = [{ label: 'One', value: 1 }];
                const choice = b.select('choice', 'Choice', options, 'not-a-member', undefined, true);
                plugin_config_schema = b.combine(
                    b.text('text', 'Text', '', 'help', false),
                    b.number('number', 'Number', 0),
                    b.boolean('switch', 'Switch', false),
                    choice,
                    b.multiSelect('multiple', 'Multiple', options, [])
                );
                options[0].label = 'mutated';
                globalThis.__jiyuBuilderProbe.push({ ctx, schema: plugin_config_schema, choice });
            }
            export function plugin_get_config() { return saved; }
            export function plugin_set_config(_ctx, value) { saved = value; }
        `);
        const probe: Array<{ ctx: any; schema: any[]; choice: any }> = [];
        (globalThis as Record<string, unknown>).__jiyuBuilderProbe = probe;
        const first = makeHost(root, '123');
        const second = makeHost(root, '456');
        await Promise.all([first.enable('demo', plugin), second.enable('demo', plugin)]);
        expect(probe).toHaveLength(2);
        expect(probe[0].ctx.dataPath).not.toBe(probe[1].ctx.dataPath);
        const expected = [
            {
                key: 'text',
                label: 'Text',
                type: 'string',
                default: '',
                description: 'help',
                reactive: false,
            },
            { key: 'number', label: 'Number', type: 'number', default: 0 },
            { key: 'switch', label: 'Switch', type: 'boolean', default: false },
            {
                key: 'choice',
                label: 'Choice',
                type: 'select',
                default: 'not-a-member',
                reactive: true,
                options: [{ label: 'One', value: 1 }],
            },
            {
                key: 'multiple',
                label: 'Multiple',
                type: 'multi-select',
                default: [],
                options: [{ label: 'One', value: 1 }],
            },
        ];
        expect((await first.getConfigSchema('demo')).fields).toEqual(expected);
        expect((await second.getConfigSchema('demo')).fields).toEqual(expected);
        expect(Object.isFrozen(probe[0].schema)).toBe(true);
        expect(Object.isFrozen(probe[0].choice.options[0])).toBe(true);
        expect(Object.isFrozen(probe[0].ctx.NapCatConfig)).toBe(true);
        expect(await first.getConfig('demo')).toEqual({
            value: { value: 'initial' },
            source: 'plugin',
        });
        await first.setConfig('demo', { value: 'changed' });
        expect((await first.getConfig('demo')).value).toEqual({ value: 'changed' });
        expect((await second.getConfig('demo')).value).toEqual({ value: 'initial' });
        await Promise.all([first.shutdown(), second.shutdown()]);
    });

    it('validates fields and makes snapshots without inspecting getters or proxies', async () => {
        const { root, plugin } = await fixture(
            `export function plugin_init(c) { globalThis.__jiyuBuilderProbe = c.NapCatConfig; }`,
        );
        const host = makeHost(root, '123');
        await host.enable('demo', plugin);
        const builder = (globalThis as Record<string, any>).__jiyuBuilderProbe;
        expect(builder.text('key', 'label')).toEqual({
            key: 'key',
            label: 'label',
            type: 'string',
        });
        expect(builder.number('key', 'label', undefined, undefined, false)).toEqual({
            key: 'key',
            label: 'label',
            type: 'number',
            reactive: false,
        });
        const source = {
            key: 'value',
            label: 'Value',
            type: 'string',
            default: { x: [1] },
            hidden: false,
        };
        const schema = builder.combine(source);
        source.default.x[0] = 99;
        expect(schema[0].default).toEqual({ x: [1] });
        expect(Object.isFrozen(schema[0].default.x)).toBe(true);
        expect(Object.isFrozen(source)).toBe(false);
        const display = builder.combine(
            { key: 'info', label: 'Info', type: 'html', description: '<b>plain data</b>' },
            { key: 'manual', label: 'Manual', type: 'text' },
        );
        expect(display[0].description).toBe('<b>plain data</b>');
        let trapped = 0;
        const proxy = new Proxy(
            {},
            {
                ownKeys() {
                    trapped++;
                    throw Error('PRIVATE');
                },
            },
        );
        const getter = Object.defineProperty({ key: 'x', label: 'X', type: 'string' }, 'default', {
            enumerable: true,
            get() {
                trapped++;
                throw Error('PRIVATE');
            },
        });
        const cycle: any = {};
        cycle.self = cycle;
        const thenable = Object.defineProperty({}, 'then', {
            enumerable: true,
            get() {
                trapped++;
                throw Error('PRIVATE_THENABLE');
            },
        });
        const bad: Array<() => unknown> = [
            () => builder.combine(proxy),
            () => builder.combine(getter),
            () => builder.combine({ key: 'x', label: 'X', type: 'string', default: cycle }),
            () => builder.combine({ key: 'x', label: 'X', type: 'string', default: thenable }),
            () =>
                builder.combine({
                    key: 'x',
                    label: 'X',
                    type: 'string',
                    default: Array(10000).fill(null),
                }),
            () => builder.combine({ key: 'x', label: 'X', type: 'string', mystery: 1 }),
            () => builder.combine({ key: 'x', label: 'X', type: 'string', default: undefined }),
            () => builder.combine({ key: '__proto__', label: 'X', type: 'string' }),
            () => builder.combine({ key: 'x', label: 'X', type: 'string', default: Array(1) }),
            () => builder.combine({ key: 'x', label: 'X', type: 'string', default: new Date() }),
            () => builder.combine({ key: 'x', label: 'X', type: 'string', default: 2n }),
            () => builder.combine({ key: 'x', label: 'X', type: 'string', reactive: 'yes' }),
            () => builder.text('x'.repeat(129), 'X'),
            () => builder.text('x', 'L'.repeat(257)),
            () => builder.number('x', 'X', NaN),
            () => builder.text('x', 'X', 4),
            () => builder.select('x', 'X', [{ label: 'X', value: 1, extra: 'bad' }]),
            () => builder.select('x', 'X', [], true),
            () => builder.multiSelect('x', 'X', [], [false]),
            () => builder.combine(...Array(257).fill({ key: 'x', label: 'X', type: 'string' })),
            () => builder.text('x', 'X', 'a'.repeat(16385)),
            () => builder.text('x', 'X', undefined, 'd'.repeat(1025)),
            () => builder.select('x', 'X', Array(257).fill({ label: 'a', value: 1 })),
        ];
        let deep: any = {};

        for (let i = 0; i < 18; i++) {
            deep = { x: deep };
        }

        bad.push(() => builder.combine({ key: 'x', label: 'X', type: 'string', default: deep }));
        bad.push(() =>
            builder.combine({ key: 'x', label: 'X', type: 'string', default: '猫'.repeat(22000) }),
        );

        for (const run of bad) {
            try {
                run();
                throw Error('missing expected error');
            } catch (error) {
                expect(error).toMatchObject({
                    code: 'CONFIG_INVALID',
                    stack: 'PluginHostError: Plugin host: CONFIG_INVALID',
                });
                expect(String(error)).not.toContain('PRIVATE');
            }
        }

        expect(trapped).toBe(0);
        await host.shutdown();
    });

    it('keeps a display-dependent init failure explicit and sanitized', async () => {
        const { root, plugin } = await fixture(`
            export function plugin_init(c) { c.NapCatConfig.html('<b>NOT_EXECUTED</b>'); }
        `);
        const host = makeHost(root, '123');
        const error = await host.enable('demo', plugin).catch((reason) => reason);
        expect(error).toMatchObject({ code: 'ENABLE_FAILED' });
        expect(String(error)).not.toContain('NOT_EXECUTED');
        await host.shutdown();
    });

    it('reports display methods as unsupported while preserving old mutable schemas', async () => {
        const { root, plugin } = await fixture(`
            export const plugin_config_schema = [{ key: 'legacy', label: 'Legacy', type: 'string', default: 'before' }];
            export function plugin_init(c) { globalThis.__jiyuBuilderProbe = { builder: c.NapCatConfig, schema: plugin_config_schema }; }
        `);
        const host = makeHost(root, '123');
        await host.enable('demo', plugin);
        const probe = (globalThis as Record<string, any>).__jiyuBuilderProbe;

        for (const feature of ['html', 'plainText']) {
            try {
                probe.builder[feature]('<b>not rendered</b>');
                throw Error('missing expected error');
            } catch (error) {
                expect(error).toMatchObject({
                    name: 'UnsupportedPluginFeatureError',
                    message: `Unsupported plugin feature: NapCatConfig.${feature}`,
                    stack: `UnsupportedPluginFeatureError: Unsupported plugin feature: NapCatConfig.${feature}`,
                });
            }
        }

        expect(Object.isFrozen(probe.schema)).toBe(false);
        probe.schema[0].default = 'after';
        expect((await host.getConfigSchema('demo')).fields).toEqual([
            { key: 'legacy', label: 'Legacy', type: 'string', default: 'after' },
        ]);
        await host.shutdown();
    });
});
