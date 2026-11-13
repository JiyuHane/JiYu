import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OneBotManager } from '@snowluma/onebot/manager';
import { createLocalPluginCatalog, type LocalPluginCatalog } from '../src/webui/plugin-local';
import { registerLocalPluginRoutes } from '../src/webui/plugin-routes';

let root: string;
let directory: string;
let manifest: string;
let catalog: LocalPluginCatalog;

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiyu-manifest-'));
    directory = path.join(root, 'plugins', 'fixture');
    manifest = path.join(directory, 'package.json');
    await fs.mkdir(directory, { recursive: true });
    catalog = createLocalPluginCatalog({ baseDirectory: path.dirname(directory) });
});

afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
});

function appFixture(selected: LocalPluginCatalog = catalog) {
    let current: unknown = null;
    const manager = { getInstance: () => current } as Pick<OneBotManager, 'getInstance'>;
    const app = new Hono();
    app.use('/api/*', async (c, next) => {
        c.header('Cache-Control', 'no-store');

        if (c.req.header('authorization') !== 'Bearer fixture') {
            return c.json({ status: 'failed' }, 401);
        }

        if (c.req.header('x-consent') !== 'yes') {
            return c.json({ status: 'failed' }, 401);
        }

        return next();
    });
    registerLocalPluginRoutes(app, manager, selected);
    const request = (
        url = '/api/plugins/local/10001/fixture/manifest',
        headers: Record<string, string> = { authorization: 'Bearer fixture', 'x-consent': 'yes' },
        signal?: AbortSignal,
    ) => app.request(`http://local.test${url}`, { headers, signal });
    return {
        request,
        setCurrent: (value: unknown) => {
            current = value;
        },
    };
}

describe('local manifest preview', () => {
    it('returns only safe declarations for offline accounts without executing plugin code', async () => {
        const marker = path.join(root, 'marker');
        await fs.writeFile(
            path.join(directory, 'index.js'),
            `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        );
        await fs.writeFile(
            manifest,
            JSON.stringify({ main: 'index.js', type: 'module', secret: root }),
        );
        const fetch = vi.spyOn(globalThis, 'fetch');
        const { request } = appFixture();
        const response = await request();
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(await response.json()).toEqual({
            status: 'ok',
            id: 'fixture',
            declarations: { main: 'index.js', type: 'module' },
            invalidFields: [],
            source: 'local-unverified',
        });
        await expect(fs.lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('distinguishes missing fields from invalid values and accepts empty strings', async () => {
        const { request } = appFixture();
        await fs.writeFile(manifest, '{}');
        expect(await (await request()).json()).toMatchObject({
            declarations: { main: null, type: null },
            invalidFields: [],
        });
        await fs.writeFile(manifest, JSON.stringify({ main: '', type: 'x'.repeat(513) }));
        expect(await (await request()).json()).toMatchObject({
            declarations: { main: '', type: null },
            invalidFields: ['type'],
        });
        await fs.writeFile(manifest, JSON.stringify({ main: 42, type: '\u009f' }));
        expect(await (await request()).json()).toMatchObject({
            declarations: { main: null, type: null },
            invalidFields: ['main', 'type'],
        });
        await fs.writeFile(manifest, `{}`.padEnd(65536, ' '));
        expect((await request()).status).toBe(200);
    });

    it('redacts absolute main declarations across platform path conventions', async () => {
        const { request } = appFixture();

        for (const main of [
            '/private/entry.js',
            'D:/private/entry.js',
            'D:\\private\\entry.js',
            '\\\\server\\share\\entry.js',
            '\\\\?\\C:\\private\\entry.js',
        ]) {
            await fs.writeFile(manifest, JSON.stringify({ main, type: 'module' }));
            const response = await request();
            const text = await response.text();
            expect(text).not.toContain('private');
            expect(JSON.parse(text)).toMatchObject({
                declarations: { main: null, type: 'module' },
                invalidFields: ['main'],
            });
        }

        await fs.writeFile(manifest, JSON.stringify({ main: '../entry.js', type: 'module' }));
        expect(await (await request()).json()).toMatchObject({
            declarations: { main: '../entry.js', type: 'module' },
            invalidFields: [],
        });
    });

    it('redacts whitespace-prefixed absolute main values in the catalog and HTTP response', async () => {
        const { request } = appFixture();

        for (const main of [
            ' /private/catalog-sentinel.js',
            '\u00a0D:/private/catalog-sentinel.js',
            '\u3000D:\\private\\catalog-sentinel.js',
            ' \\private\\catalog-sentinel.js',
            '\u00a0\\\\server\\share\\catalog-sentinel.js',
            '\u3000\\\\?\\C:\\private\\catalog-sentinel.js',
        ]) {
            await fs.writeFile(manifest, JSON.stringify({ main, type: 'module' }));
            expect(await catalog.previewManifest!('fixture')).toEqual({
                declarations: { main: null, type: 'module' },
                invalidFields: ['main'],
            });
            const response = await request();
            expect(response.status).toBe(200);
            const text = await response.text();
            expect(text).not.toContain('catalog-sentinel');
            expect(JSON.parse(text)).toEqual({
                status: 'ok',
                id: 'fixture',
                declarations: { main: null, type: 'module' },
                invalidFields: ['main'],
                source: 'local-unverified',
            });
        }

        for (const main of ['', '  ', '\u00a0../entry.js', '  entry.js']) {
            await fs.writeFile(manifest, JSON.stringify({ main }));
            const expected = { declarations: { main, type: null }, invalidFields: [] };
            expect(await catalog.previewManifest!('fixture')).toEqual(expected);
            expect(await (await request()).json()).toMatchObject(expected);
        }
    });

    it('redacts absolute type declarations in the catalog and HTTP response', async () => {
        const { request } = appFixture();

        for (const type of [
            '/private/type-sentinel',
            ' C:\\private\\type-sentinel',
            '\u00a0D:/private/type-sentinel',
            '\u3000\\private\\type-sentinel',
            '\u00a0\\\\server\\share\\type-sentinel',
            '\u3000\\\\?\\C:\\private\\type-sentinel',
        ]) {
            await fs.writeFile(manifest, JSON.stringify({ main: 'index.js', type }));
            const expected = {
                declarations: { main: 'index.js', type: null },
                invalidFields: ['type'],
            };
            expect(await catalog.previewManifest!('fixture')).toEqual(expected);
            const response = await request();
            expect(response.status).toBe(200);
            const text = await response.text();
            expect(text).not.toContain('type-sentinel');
            expect(JSON.parse(text)).toMatchObject(expected);
        }

        for (const type of ['module', 'commonjs', '', '  ', '\u00a0../relative']) {
            await fs.writeFile(manifest, JSON.stringify({ type }));
            const expected = { declarations: { main: null, type }, invalidFields: [] };
            expect(await catalog.previewManifest!('fixture')).toEqual(expected);
            expect(await (await request()).json()).toMatchObject(expected);
        }

        await fs.writeFile(
            manifest,
            JSON.stringify({ main: '/private/main', type: ' C:\\private\\type' }),
        );
        const expected = {
            declarations: { main: null, type: null },
            invalidFields: ['main', 'type'],
        };
        expect(await catalog.previewManifest!('fixture')).toEqual(expected);
        expect(await (await request()).json()).toMatchObject(expected);
    });

    it('fails closed on missing, oversized, invalid JSON, invalid UTF-8, and missing directory', async () => {
        const { request } = appFixture();

        const check = async (status: number, code: string) => {
            const response = await request();
            expect(response.status).toBe(status);
            expect(response.headers.get('cache-control')).toContain('no-store');
            const text = await response.text();
            expect(text).not.toContain(root);
            expect(JSON.parse(text)).toEqual({ status: 'failed', code });
        };

        await check(404, 'LOCAL_MANIFEST_NOT_FOUND');
        await fs.writeFile(manifest, Buffer.alloc(65537));
        await check(409, 'LOCAL_MANIFEST_TOO_LARGE');
        await fs.writeFile(manifest, '{');
        await check(409, 'LOCAL_MANIFEST_INVALID');
        await fs.writeFile(manifest, Buffer.from([0xff]));
        await check(409, 'LOCAL_MANIFEST_INVALID');
        await fs.rm(directory, { recursive: true });
        await check(404, 'LOCAL_MANIFEST_NOT_FOUND');
    });

    it('rejects symlink directories and a changed manifest during opening', async () => {
        const outside = path.join(root, 'outside');
        await fs.mkdir(outside);
        await fs.rm(directory, { recursive: true });
        await fs.symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
        const { request } = appFixture();
        expect((await request()).status).toBe(409);
        await fs.rm(directory, { recursive: true });
        await fs.mkdir(directory);
        await fs.symlink(outside, manifest, process.platform === 'win32' ? 'junction' : 'dir');
        expect((await request()).status).toBe(409);
        await fs.rm(manifest, { recursive: true });
        await fs.writeFile(manifest, '{}');
        const original = fs.open.bind(fs);
        vi.spyOn(fs, 'open').mockImplementation(async (target, ...args) => {
            if (String(target) === manifest) {
                await fs.rename(manifest, path.join(directory, 'old.json'));
                await fs.writeFile(manifest, '{"main":"other"}');
            }

            return original(target, ...args);
        });
        const result = await request();
        expect(result.status).toBe(409);
        expect(await result.text()).not.toContain(root);
    });

    it('rejects replacement of the package directory while opening', async () => {
        await fs.writeFile(manifest, '{}');
        const original = fs.open.bind(fs);
        vi.spyOn(fs, 'open').mockImplementation(async (target, ...args) => {
            if (String(target) === manifest) {
                await fs.rename(directory, `${directory}-old`);
                await fs.mkdir(directory);
                await fs.writeFile(manifest, '{}');
            }

            return original(target, ...args);
        });
        const result = await appFixture().request();
        expect(result.status).toBe(409);
        expect(await result.text()).not.toContain(root);
    });

    it('does no catalog work before both guards or for invalid identifiers', async () => {
        const preview = vi.fn(async () => ({
            declarations: { main: null, type: null },
            invalidFields: [],
        }));
        const mock = {
            list: vi.fn(async () => []),
            resolve: vi.fn(async () => ''),
            previewManifest: preview,
        } satisfies LocalPluginCatalog;
        const { request } = appFixture(mock);
        const noAuth = await request(undefined, {});
        const noConsent = await request(undefined, { authorization: 'Bearer fixture' });
        expect(noAuth.status).toBe(401);
        expect(noConsent.status).toBe(401);
        expect(noAuth.headers.get('cache-control')).toContain('no-store');
        expect(noConsent.headers.get('cache-control')).toContain('no-store');
        expect((await request('/api/plugins/local/10001/CON/manifest')).status).toBe(400);
        expect((await request('/api/plugins/local/123/fixture/manifest')).status).toBe(400);
        expect(preview).not.toHaveBeenCalled();
        expect(mock.resolve).not.toHaveBeenCalled();
        expect(mock.list).not.toHaveBeenCalled();
    });

    it('detects instance transitions including offline and failed operations', async () => {
        let release!: () => void;
        const pending = new Promise<void>((done) => {
            release = done;
        });
        const preview = vi.fn(async () => {
            await pending;
            throw new Error(`private ${root}`);
        });
        const mock = {
            list: async () => [],
            resolve: async () => '',
            previewManifest: preview,
        } satisfies LocalPluginCatalog;
        const { request, setCurrent } = appFixture(mock);
        const response = request();
        await vi.waitFor(() => expect(preview).toHaveBeenCalled());
        setCurrent({});
        release();
        const result = await response;
        expect(result.status).toBe(409);
        expect(await result.json()).toEqual({ status: 'failed', code: 'INSTANCE_CHANGED' });
    });

    it('hides filesystem errors and handles legacy catalogs explicitly', async () => {
        await fs.writeFile(manifest, '{}');
        vi.spyOn(fs, 'open').mockRejectedValueOnce(
            Object.assign(new Error(`secret ${root}`), { code: 'EACCES' }),
        );
        const result = await appFixture().request();
        expect(result.status).toBe(503);
        expect(await result.text()).toBe('{"status":"failed","code":"LOCAL_MANIFEST_UNAVAILABLE"}');
        const legacy = {
            list: async () => [],
            resolve: async () => '',
        } satisfies LocalPluginCatalog;
        expect((await appFixture(legacy).request()).status).toBe(503);
    });

    it('bounds global pending reads even when a client aborts, and releases after settlement', async () => {
        await fs.writeFile(manifest, '{}');
        const original = fs.open.bind(fs);
        let release!: () => void;
        const gate = new Promise<void>((done) => {
            release = done;
        });
        let entered = 0;
        vi.spyOn(fs, 'open').mockImplementation(async (target, ...args) => {
            if (String(target) === manifest) {
                entered++;
                await gate;
            }

            return original(target, ...args);
        });
        const { request } = appFixture();
        const abort = new AbortController();
        const pending = Array.from({ length: 16 }, (_, index) =>
            request(undefined, undefined, index === 0 ? abort.signal : undefined),
        );

        try {
            await vi.waitFor(() => expect(entered).toBe(16), { timeout: 30000 });
            abort.abort();
            const full = await request();
            expect(full.status).toBe(503);
            expect(await full.json()).toEqual({
                status: 'failed',
                code: 'LOCAL_MANIFEST_UNAVAILABLE',
            });
        } finally {
            release();
            await Promise.allSettled(pending);
        }

        expect((await request()).status).toBe(200);
    }, 60000);

    it('keeps reservations when handle close fails', async () => {
        await fs.writeFile(manifest, '{}');
        const original = fs.open.bind(fs);
        let opened = 0;
        vi.spyOn(fs, 'open').mockImplementation(async (target, ...args) => {
            const handle = await original(target, ...args);

            if (String(target) === manifest) {
                opened++;
                const close = handle.close.bind(handle);

                handle.close = async () => {
                    await close();
                    throw new Error(`private ${root}`);
                };
            }

            return handle;
        });
        const { request } = appFixture();

        for (let i = 0; i < 16; i++) {
            const result = await request();
            expect(result.status).toBe(503);
            expect(await result.text()).not.toContain(root);
        }

        expect((await request()).status).toBe(503);
        expect(opened).toBe(16);
    }, 30000);
});
