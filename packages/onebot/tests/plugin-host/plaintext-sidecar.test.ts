import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginHost } from '../../src/plugin-host';

const roots: string[] = [];

async function fixture(source: string) {
    const root = await mkdtemp(path.join(tmpdir(), 'jiyu-plaintext-host-'));
    roots.push(root);
    const plugin = path.join(root, 'plugin');
    await mkdir(plugin);
    await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
    await writeFile(path.join(plugin, 'index.mjs'), source);
    return { root, plugin };
}

function host(root: string, accountId: string) {
    return new PluginHost({
        accountId,
        stateRoot: path.join(root, 'state'),
        managerConfig: {},
        invokeAction: async () => {
            throw Error('unexpected');
        },
        isStreamAction: () => false,
        logger: () => {},
    });
}

afterEach(async () => {
    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }

    delete (globalThis as Record<string, unknown>).__plainTextHostProbe;
});

describe('slot-scoped plainText sidecar', () => {
    it('preserves provenance across combine and direct arrays without crossing account slots', async () => {
        const { root, plugin } = await fixture(`
            export let plugin_config_schema;
            export function plugin_init(c) {
                const text = c.NapCatConfig.plainText('hello');
                const field = c.NapCatConfig.boolean('flag', 'Flag', false);
                const combined = c.NapCatConfig.combine(text, field);
                plugin_config_schema = combined;
                globalThis.__plainTextHostProbe.push({ path:c.dataPath, text, combined, builder:c.NapCatConfig, set: v => { plugin_config_schema = v; } });
            }
        `);
        const probe: Array<{
            path: string;
            text: any;
            combined: any[];
            builder: any;
            set: (value: unknown) => void;
        }> = [];
        (globalThis as Record<string, unknown>).__plainTextHostProbe = probe;
        const a = host(root, '123');
        const b = host(root, '456');
        await Promise.all([a.enable('demo', plugin), b.enable('demo', plugin)]);
        const pa = probe.find((v) => v.path.includes(`${path.sep}123${path.sep}`))!;
        const pb = probe.find((v) => v.path.includes(`${path.sep}456${path.sep}`))!;
        const first = await a.getConfigSchema('demo');
        expect(first.displaySidecar).toMatchObject({
            version: 1,
            generation: a.getConfigGeneration('demo'),
            source: 'schema',
            entries: [{ index: 0, kind: 'plainText' }],
            snapshot: first.fields,
        });
        expect(first.displaySidecar!.snapshot).not.toBe(first.fields);
        expect((await b.getConfigSchema('demo')).displaySidecar?.generation).toBe(
            b.getConfigGeneration('demo'),
        );
        pa.set([pa.text]);
        const captured = await a.getConfigSchema('demo');
        expect(captured.displaySidecar?.entries).toEqual([{ index: 0, kind: 'plainText' }]);
        pa.set([{ ...pa.text }]);
        expect(captured.displaySidecar?.snapshot).toEqual([pa.text]);
        expect((await a.getConfigSchema('demo')).displaySidecar).toBeUndefined();
        pa.set([JSON.parse(JSON.stringify(pa.text))]);
        expect((await a.getConfigSchema('demo')).displaySidecar).toBeUndefined();
        pb.set([pa.text]);
        expect((await b.getConfigSchema('demo')).displaySidecar).toBeUndefined();
        pb.set(pb.builder.combine(pa.text));
        expect((await b.getConfigSchema('demo')).displaySidecar).toBeUndefined();
        await a.disable('demo');
        await a.enable('demo', plugin);
        const fresh = probe.filter((v) => v.path.includes(`${path.sep}123${path.sep}`)).at(-1)!;
        fresh.set([pa.text]);
        expect((await a.getConfigSchema('demo')).displaySidecar).toBeUndefined();
        await Promise.all([a.shutdown(), b.shutdown()]);
    });

    it('rejects untrusted accessors and proxies without triggering traps', async () => {
        const { root, plugin } = await fixture(`
            export let plugin_config_schema = [];
            export function plugin_init(c) { globalThis.__plainTextHostProbe = { c, set: v => { plugin_config_schema = v; } }; }
        `);
        const instance = host(root, '123');
        await instance.enable('demo', plugin);
        const p = (globalThis as Record<string, any>).__plainTextHostProbe;
        let traps = 0;
        const proxy = new Proxy(
            {},
            {
                ownKeys() {
                    traps++;
                    throw Error('PRIVATE');
                },
            },
        );
        p.set([proxy]);
        await expect(instance.getConfigSchema('demo')).rejects.toMatchObject({
            code: 'CONFIG_INVALID',
        });
        const item = Object.defineProperty({ key: 'x', label: 'X', type: 'text' }, 'default', {
            enumerable: true,
            get() {
                traps++;
                throw Error('PRIVATE');
            },
        });
        p.set([item]);
        await expect(instance.getConfigSchema('demo')).rejects.toMatchObject({
            code: 'CONFIG_INVALID',
        });
        expect(() => p.c.NapCatConfig.combine(proxy)).toThrow('CONFIG_INVALID');
        expect(traps).toBe(0);
        await instance.shutdown();
    });

    it('keeps near-limit Unicode schemas, repeated items, high-node and depth-16 snapshots', async () => {
        const { root, plugin } = await fixture(`
            export let plugin_config_schema;
            export function plugin_init(c) {
                const d = c.NapCatConfig.plainText('猫');
                const many = Array(700).fill(d);
                const base = Buffer.byteLength(JSON.stringify(many), 'utf8');
                const extra = Math.floor((65000 - base - 200) / 3);
                if (extra < 0 || extra > 16383) throw Error('fixture bounds');
                many.push(c.NapCatConfig.plainText('猫'.repeat(extra) + '\\ud800'));
                plugin_config_schema = many;
                globalThis.__plainTextHostProbe = { d, set: v => { plugin_config_schema = v; } };
            }
        `);
        const instance = host(root, '123');
        await instance.enable('demo', plugin);
        const first = await instance.getConfigSchema('demo');
        const schemaBytes = Buffer.byteLength(JSON.stringify(first.fields), 'utf8');
        expect(schemaBytes).toBeGreaterThan(64000);
        expect(schemaBytes).toBeLessThanOrEqual(65536);
        expect(first.displaySidecar?.entries).toHaveLength(701);
        expect(
            Buffer.byteLength(
                JSON.stringify({
                    status: 'ok',
                    ...first,
                    generation: instance.getConfigGeneration('demo'),
                    processResources: 'unknown',
                }),
                'utf8',
            ),
        ).toBeLessThan(4 * 1024 * 1024);
        const p = (globalThis as Record<string, any>).__plainTextHostProbe;
        p.set([p.d, ...Array(9992).fill(0)]);
        const highNodes = await instance.getConfigSchema('demo');
        expect(highNodes.displaySidecar?.entries).toHaveLength(1);
        let deep: unknown = 0;

        for (let i = 0; i < 15; i++) {
            deep = [deep];
        }

        p.set([p.d, deep]);
        expect((await instance.getConfigSchema('demo')).displaySidecar?.entries).toHaveLength(1);
        await instance.shutdown();
    });

    it('does not produce a sidecar for html or hand-written matching shapes', async () => {
        const { root, plugin } = await fixture(`
            export let plugin_config_schema;
            export function plugin_init(c) {
                const d = c.NapCatConfig.plainText('plain');
                plugin_config_schema = [{...d}, c.NapCatConfig.html('<b>raw</b>')];
            }
        `);
        const instance = host(root, '123');
        await instance.enable('demo', plugin);
        expect((await instance.getConfigSchema('demo')).displaySidecar).toBeUndefined();
        await instance.shutdown();
    });
});
