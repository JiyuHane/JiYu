import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalPluginCatalog } from '../src/webui/plugin-local';

let root: string;
let oldCwd: string;

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'jiyu-plugin-local-'));
    oldCwd = process.cwd();
});

afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(oldCwd);
    await fs.rm(root, { recursive: true, force: true });
});

function base(): string {
    return path.join(root, 'data', 'plugin-packages');
}

async function directory(id: string): Promise<void> {
    await fs.mkdir(path.join(base(), id), { recursive: true });
}

describe('local plugin catalog', () => {
    it('reports an absent catalog without creating it', async () => {
        const catalog = createLocalPluginCatalog({ baseDirectory: base() });
        await expect(catalog.list()).resolves.toEqual([]);
        await expect(catalog.resolve('valid')).rejects.toMatchObject({ code: 'not_found' });
        await expect(fs.lstat(path.join(root, 'data'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('lists only valid direct directories in stable order without executing code or networking', async () => {
        await directory('z-two');
        await directory('a_one');
        await directory('a_one/nested');
        await directory('Uppercase');
        await directory('bad.name');
        await directory('CON');
        await fs.writeFile(path.join(base(), 'file'), 'fixture');
        const marker = path.join(root, 'executed');
        await fs.writeFile(
            path.join(base(), 'a_one', 'index.js'),
            `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        );
        const fetch = vi.spyOn(globalThis, 'fetch');
        const catalog = createLocalPluginCatalog({ baseDirectory: base() });
        await expect(catalog.list()).resolves.toEqual(['a_one', 'z-two']);
        await expect(catalog.resolve('a_one')).resolves.toBe(path.join(base(), 'a_one'));
        await expect(fs.lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects invalid IDs and missing or non-directory children without exposing paths', async () => {
        await fs.mkdir(base(), { recursive: true });
        await fs.writeFile(path.join(base(), 'file'), 'fixture');
        const catalog = createLocalPluginCatalog({ baseDirectory: base() });

        for (const id of [
            '../outside',
            '.',
            '',
            'UPPER',
            'con',
            'com1',
            'lpt9',
            'a'.repeat(81),
            'https://example.invalid',
        ]) {
            await expect(catalog.resolve(id)).rejects.toMatchObject({ code: 'invalid_id' });
        }

        await expect(catalog.resolve('absent')).rejects.toMatchObject({ code: 'not_found' });
        await expect(catalog.resolve('file')).rejects.toMatchObject({ code: 'unsafe_path' });

        try {
            await catalog.resolve('absent');
            throw new Error('expected failure');
        } catch (error) {
            expect(String(error)).not.toContain(root);
            expect(JSON.stringify(error)).not.toContain(root);
        }
    });

    it('requires the exact on-disk child name even on a case-insensitive filesystem', async () => {
        await directory('MiXeD');
        const catalog = createLocalPluginCatalog({ baseDirectory: base() });
        expect(await catalog.list()).toEqual([]);
        await expect(catalog.resolve('mixed')).rejects.toMatchObject({ code: 'not_found' });
        await fs.rm(path.join(base(), 'MiXeD'), { recursive: true });
        await directory('mixed');
        expect(await catalog.list()).toEqual(['mixed']);
        await expect(catalog.resolve('mixed')).resolves.toBe(path.join(base(), 'mixed'));
    });

    it('distinguishes initial absence from disappearance after lstat', async () => {
        await directory('present');
        const catalog = createLocalPluginCatalog({ baseDirectory: base() });
        const originalLstat = fs.lstat.bind(fs);
        const initial = vi.spyOn(fs, 'lstat').mockImplementation(async (target, ...rest) => {
            if (String(target) === base()) {
                throw Object.assign(new Error(`private ${root}`), { code: 'ENOENT' });
            }

            return originalLstat(target, ...rest);
        });
        await expect(catalog.list()).resolves.toEqual([]);
        await expect(catalog.resolve('present')).rejects.toMatchObject({ code: 'not_found' });
        initial.mockRestore();

        const originalRealpath = fs.realpath.bind(fs);
        const realpath = vi.spyOn(fs, 'realpath').mockImplementation(async (target, ...rest) => {
            if (String(target) === base()) {
                throw Object.assign(new Error(`private ${root}`), { code: 'ENOENT' });
            }

            return originalRealpath(target, ...rest);
        });

        for (const operation of [() => catalog.list(), () => catalog.resolve('present')]) {
            await expect(operation()).rejects.toMatchObject({
                code: 'io_error',
                systemCode: 'ENOENT',
                message: 'Local plugin catalog: io_error',
            });
        }

        realpath.mockRestore();

        let seen = 0;
        vi.spyOn(fs, 'lstat').mockImplementation(async (target, ...rest) => {
            if (String(target) === base() && ++seen === 2) {
                throw Object.assign(new Error(`private ${root}`), { code: 'ENOENT' });
            }

            return originalLstat(target, ...rest);
        });
        await expect(catalog.list()).rejects.toMatchObject({
            code: 'io_error',
            systemCode: 'ENOENT',
            message: 'Local plugin catalog: io_error',
        });
    });

    it('rejects junctions at the child and at an existing ancestor', async () => {
        const outside = path.join(root, 'outside');
        await fs.mkdir(outside);
        await fs.mkdir(base(), { recursive: true });
        await fs.symlink(
            outside,
            path.join(base(), 'linked'),
            process.platform === 'win32' ? 'junction' : 'dir',
        );
        const catalog = createLocalPluginCatalog({ baseDirectory: base() });
        expect(await catalog.list()).toEqual([]);
        await expect(catalog.resolve('linked')).rejects.toMatchObject({ code: 'unsafe_path' });
        const junction = path.join(root, 'alias');
        await fs.symlink(
            path.join(root, 'data'),
            junction,
            process.platform === 'win32' ? 'junction' : 'dir',
        );
        const throughJunction = createLocalPluginCatalog({
            baseDirectory: path.join(junction, 'plugin-packages'),
        });
        await expect(throughJunction.list()).rejects.toMatchObject({ code: 'unsafe_path' });
    });

    it('exposes a controlled IO error rather than claiming an empty catalog', async () => {
        await fs.mkdir(base(), { recursive: true });
        vi.spyOn(fs, 'opendir').mockRejectedValueOnce(
            Object.assign(new Error(`secret ${root}`), { code: 'EACCES' }),
        );
        const catalog = createLocalPluginCatalog({ baseDirectory: base() });
        await expect(catalog.list()).rejects.toMatchObject({
            code: 'io_error',
            systemCode: 'EACCES',
            message: 'Local plugin catalog: io_error',
        });
    });

    it('hides unrecognized system codes and rejects relative base configuration', async () => {
        expect(() => createLocalPluginCatalog({ baseDirectory: 'relative' })).toThrow(
            'Local plugin catalog: unsafe_path',
        );

        if (process.platform === 'win32') {
            expect(() =>
                createLocalPluginCatalog({ baseDirectory: '\\\\server\\share\\plugins' }),
            ).toThrow('Local plugin catalog: unsafe_path');
        }

        await fs.mkdir(base(), { recursive: true });
        vi.spyOn(fs, 'opendir').mockRejectedValueOnce(
            Object.assign(new Error('private detail'), { code: 'PRIVATE_SECRET' }),
        );
        await expect(
            createLocalPluginCatalog({ baseDirectory: base() }).list(),
        ).rejects.toMatchObject({
            code: 'io_error',
            systemCode: undefined,
            message: 'Local plugin catalog: io_error',
        });
    });

    it('detects a child swapped for a junction during validation', async () => {
        await directory('plugin');
        const outside = path.join(root, 'outside');
        await fs.mkdir(outside);
        const child = path.join(base(), 'plugin');
        const original = fs.realpath.bind(fs);
        vi.spyOn(fs, 'realpath').mockImplementation(async (target, ...rest) => {
            if (String(target) === child) {
                await fs.rm(child, { recursive: true });
                await fs.symlink(outside, child, process.platform === 'win32' ? 'junction' : 'dir');
            }

            return original(target, ...rest);
        });
        await expect(
            createLocalPluginCatalog({ baseDirectory: base() }).resolve('plugin'),
        ).rejects.toMatchObject({ code: 'unsafe_path' });
    });

    it('bounds enumeration and does not return a misleading partial list', async () => {
        await fs.mkdir(base(), { recursive: true });
        await Promise.all(Array.from({ length: 513 }, (_, index) => directory(`p${index}`)));
        const catalog = createLocalPluginCatalog({ baseDirectory: base() });
        await expect(catalog.list()).rejects.toMatchObject({ code: 'limit_exceeded' });
        await expect(catalog.resolve('p0')).rejects.toMatchObject({ code: 'limit_exceeded' });
        await expect(catalog.resolve('missing')).rejects.toMatchObject({ code: 'limit_exceeded' });
    }, 30_000);

    it('captures the default cwd once and handles concurrent requests independently', async () => {
        const other = path.join(root, 'other');
        await fs.mkdir(other);
        process.chdir(root);
        await directory('plugin');
        const catalog = createLocalPluginCatalog();
        process.chdir(other);
        const results = await Promise.all([
            catalog.list(),
            catalog.resolve('plugin'),
            catalog.list(),
        ]);
        expect(results).toEqual([['plugin'], path.join(base(), 'plugin'), ['plugin']]);
        await expect(createLocalPluginCatalog().list()).resolves.toEqual([]);
    });
});
