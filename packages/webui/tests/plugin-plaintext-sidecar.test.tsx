import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginHost } from '../../onebot/src/plugin-host';
import { registerLocalPluginRoutes } from '../../core/src/webui/plugin-routes';
import {
    createConfigModeGuard,
    createConfigTicketGuard,
    dispatchConfigTicket,
    createConfigViewGuard,
    createLocalOperationTracker,
    dispatchEditableConfigConfirmation,
    PluginPlainTextView,
} from '../src/components/settings/plugins-panel';
import { parseConfigEnvelope, parseConfigView } from '../src/lib/plugin-index';
import type { PluginDisplaySidecar } from '../src/lib/api/types';

// Resolve only the existing core dependency; no listener or network service is started.
const requireFromCore = createRequire(new URL('../../core/package.json', import.meta.url));
const { Hono } = requireFromCore('hono') as typeof import('hono');
const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }
});

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'jiyu-plain-e2e-'));
    roots.push(root);
    const plugin = path.join(root, 'plugin');
    await mkdir(plugin);
    await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ main: 'index.mjs' }));
    await writeFile(
        path.join(plugin, 'index.mjs'),
        `
        export let plugin_config_schema;
        export function plugin_init(c) {
            plugin_config_schema = c.NapCatConfig.combine(c.NapCatConfig.plainText('<img src=x onerror=alert(1)>'), c.NapCatConfig.boolean('enabled', 'Enabled', false));
        }
        export function plugin_get_config() { return { enabled:false }; }
        export function plugin_set_config() { throw Error('WRITE_MUST_NOT_RUN'); }
    `,
    );
    const host = new PluginHost({
        accountId: '10001',
        stateRoot: path.join(root, 'state'),
        managerConfig: {},
        invokeAction: async () => {
            throw Error('unexpected');
        },
        isStreamAction: () => false,
        logger: () => {},
    });
    await host.enable('demo', plugin);
    const instance = {
        canEnablePlugins: () => true,
        getPluginConfigGeneration: (id: string) => host.getConfigGeneration(id),
        getPluginConfigSchema: vi.fn((id: string) => host.getConfigSchema(id)),
        getPluginConfig: vi.fn((id: string) => host.getConfig(id)),
        setPluginConfig: vi.fn((id: string, value: unknown) => host.setConfig(id, value)),
    };
    const app = new Hono();
    app.use('/api/*', async (c, next) =>
        c.req.header('authorization') === 'Bearer test'
            ? next()
            : c.json({ status: 'failed' }, 401),
    );
    registerLocalPluginRoutes(
        app,
        { getInstance: () => instance } as never,
        { list: async () => [], resolve: async () => '' } as never,
    );
    return { host, app, instance };
}

describe('plainText sidecar read-only integration', () => {
    it('renders the actual in-memory route response as escaped text and blocks stale confirmation', async () => {
        const { host, app, instance } = await fixture();

        try {
            const response = await app.request(
                'http://localhost/api/plugins/local/10001/demo/config/schema',
                { method: 'POST', headers: { authorization: 'Bearer test' } },
            );
            expect(response.status).toBe(200);
            const envelope = parseConfigEnvelope(await response.json(), 'schema') as {
                fields: unknown;
                displaySidecar: PluginDisplaySidecar;
                generation: string;
            };
            const view = parseConfigView(envelope.fields, envelope.displaySidecar);
            expect(view.readOnly).toBe(true);
            expect(view.fields).toMatchObject([{ key: 'enabled', type: 'boolean' }]);
            expect(view.displayTexts).toEqual(['<img src=x onerror=alert(1)>']);
            const html = renderToStaticMarkup(<PluginPlainTextView texts={view.displayTexts} />);
            expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
            expect(html).not.toContain('<img');
            expect(html).not.toContain('<button');
            const guard = createConfigModeGuard();
            guard.open('editable', envelope.generation);
            const oldBinding = guard.capture();
            guard.open('display', envelope.generation);
            const issueRequest = vi.fn();
            expect(
                dispatchEditableConfigConfirmation(
                    guard,
                    oldBinding,
                    envelope.generation,
                    issueRequest,
                ),
            ).toBe(false);
            expect(
                dispatchEditableConfigConfirmation(
                    guard,
                    guard.capture(),
                    envelope.generation,
                    issueRequest,
                ),
            ).toBe(false);
            expect(issueRequest).not.toHaveBeenCalled();
            expect(instance.getPluginConfig).not.toHaveBeenCalled();
            expect(instance.setPluginConfig).not.toHaveBeenCalled();
        } finally {
            await host.shutdown();
        }
    });

    it('ties each confirmation closure and close to its own operation and epoch', () => {
        const generation = '123e4567-e89b-42d3-a456-426614174000';
        const mode = createConfigModeGuard();
        const tickets = createConfigTicketGuard();
        const post = vi.fn();
        mode.open('editable', generation);
        const oldWrite = tickets.issue('write', mode.capture(), mode.revision());
        const oldWriteClosure = () =>
            dispatchConfigTicket(tickets, mode, oldWrite, 'write', generation, post);
        mode.invalidate();
        mode.open('editable', generation);
        const newRead = tickets.issue('read', mode.capture(), mode.revision());
        expect(oldWriteClosure()).toBe(false);
        expect(tickets.close(oldWrite)).toBe(false);
        expect(tickets.isCurrent(newRead, 'read')).toBe(true);
        expect(dispatchConfigTicket(tickets, mode, newRead, 'write', generation, post)).toBe(false);
        const newWrite = tickets.issue('write', mode.capture(), mode.revision());
        expect(dispatchConfigTicket(tickets, mode, newRead, 'read', generation, post)).toBe(false);
        expect(oldWriteClosure()).toBe(false);
        expect(tickets.close(newRead)).toBe(false);
        expect(tickets.isCurrent(newWrite, 'write')).toBe(true);
        expect(post).not.toHaveBeenCalled();
        const oldSchema = tickets.issue('schema', null, mode.revision());
        const newerSchema = tickets.issue('schema', null, mode.revision());
        expect(dispatchConfigTicket(tickets, mode, oldSchema, 'schema', generation, post)).toBe(
            false,
        );
        expect(tickets.close(oldSchema)).toBe(false);
        expect(tickets.close(newerSchema)).toBe(true);
        // Cancelling the new schema confirmation has not invalidated the prior view.
        expect(mode.allows(newWrite.binding)).toBe(true);
        const afterCancel = tickets.issue('write', mode.capture(), mode.revision());
        expect(dispatchConfigTicket(tickets, mode, afterCancel, 'write', generation, post)).toBe(
            true,
        );
        expect(post).toHaveBeenCalledOnce();
        mode.open('display', generation);
        const readonlyRead = tickets.issue('read', null, mode.revision());
        expect(dispatchConfigTicket(tickets, mode, readonlyRead, 'read', generation, post)).toBe(
            false,
        );
        const readonlyWrite = tickets.issue('write', null, mode.revision());
        expect(dispatchConfigTicket(tickets, mode, readonlyWrite, 'write', generation, post)).toBe(
            false,
        );
        expect(post).toHaveBeenCalledOnce();
    });

    it('keeps a previously sent write unknown after close and rejects stale re-confirmation', async () => {
        vi.useFakeTimers();

        try {
            const generation = '123e4567-e89b-42d3-a456-426614174000';
            const tracker = createLocalOperationTracker();
            const viewGuard = createConfigViewGuard(tracker, '10001');
            const mode = createConfigModeGuard();
            mode.open('editable', generation);
            const binding = mode.capture();
            expect(viewGuard.begin()).toBe(true);
            const issue = vi.fn();
            const scheduled = new Promise<void>((resolve) => {
                expect(
                    dispatchEditableConfigConfirmation(mode, binding, generation, () => {
                        issue();
                        setTimeout(resolve, 50);
                    }),
                ).toBe(true);
            });
            mode.invalidate();
            viewGuard.close();
            expect(tracker.snapshot()['10001']).toBe('unknown-running');
            expect(dispatchEditableConfigConfirmation(mode, binding, generation, issue)).toBe(
                false,
            );
            await vi.advanceTimersByTimeAsync(50);
            await scheduled;
            expect(viewGuard.finish(false)).toBe(false);
            expect(tracker.snapshot()['10001']).toBe('unknown');
            expect(issue).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('fails closed for tampered, unknown and unmarked sidecars while keeping legacy scalar editable', () => {
        const generation = '123e4567-e89b-42d3-a456-426614174000';
        const fields = [
            { key: '_text_fake', type: 'text', label: '', default: 'untrusted' },
            { key: 'enabled', type: 'boolean', label: 'Enabled' },
        ];
        const sidecar = {
            version: 1,
            generation,
            source: 'schema',
            snapshot: structuredClone(fields),
            entries: [{ index: 0, kind: 'plainText' }],
        };
        const envelope = {
            status: 'ok',
            processResources: 'unknown',
            generation,
            source: 'schema',
            fields,
        };
        expect(() => parseConfigView(fields)).toThrow();

        for (const bad of [
            { ...sidecar, version: 2 },
            { ...sidecar, generation: '123e4567-e89b-42d3-a456-426614174001' },
            { ...sidecar, source: 'ui' },
            { ...sidecar, extra: 'unexpected' },
            { ...sidecar, entries: [] },
            { ...sidecar, snapshot: [{ ...fields[0], default: 'altered' }, fields[1]] },
            {
                ...sidecar,
                entries: [
                    { index: 0, kind: 'plainText' },
                    { index: 0, kind: 'plainText' },
                ],
            },
            { ...sidecar, entries: [{ index: 4, kind: 'plainText' }] },
            { ...sidecar, entries: [{ index: 0, kind: 'html' }] },
        ]) {
            expect(() =>
                parseConfigEnvelope({ ...envelope, displaySidecar: bad }, 'schema'),
            ).toThrow();
        }

        const duplicate = [fields[0], { key: fields[0].key, label: 'Enabled', type: 'boolean' }];
        expect(() =>
            parseConfigEnvelope(
                {
                    ...envelope,
                    fields: duplicate,
                    displaySidecar: { ...sidecar, snapshot: structuredClone(duplicate) },
                },
                'schema',
            ),
        ).toThrow();
        expect(() => parseConfigView([{ key: 'x', type: 'string' }])).toThrow();
        const legacy = parseConfigView([{ key: 'enabled', label: 'Enabled', type: 'boolean' }]);
        expect(legacy).toMatchObject({ readOnly: false, fields: [{ key: 'enabled' }] });
        const guard = createConfigModeGuard();
        guard.open('editable', generation);
        const binding = guard.capture();
        const issueRequest = vi.fn();
        expect(dispatchEditableConfigConfirmation(guard, binding, generation, issueRequest)).toBe(
            true,
        );
        guard.invalidate();
        expect(dispatchEditableConfigConfirmation(guard, binding, generation, issueRequest)).toBe(
            false,
        );
        expect(issueRequest).toHaveBeenCalledOnce();
    });
});
