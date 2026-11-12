import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, updateDirectory } from '../src/update/files';
import {
    assertNoLegacyUpdate,
    createJiyuUpdateService,
    getJiyuUpdateInfo,
    UPDATE_UNAVAILABLE,
} from '../src/update/jiyu-update-policy';
import { updateRoutes } from '../src/webui/update-routes';

let root: string;
let system: string;
beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'jiyu-update-'));
    system = await updateDirectory(root);
});
afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
    await rm(system, { recursive: true, force: true });
});

describe('Jiyu update policy', () => {
    it('returns explicit errors without network or download', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        expect(await getJiyuUpdateInfo(true)).toMatchObject({
            latest: null,
            hasUpdate: false,
            error: UPDATE_UNAVAILABLE,
        });
        expect(await getJiyuUpdateInfo()).toMatchObject({ error: UPDATE_UNAVAILABLE });
        const service = await createJiyuUpdateService('1.0.0');
        expect(service.status()).toMatchObject({
            phase: 'unavailable',
            message: UPDATE_UNAVAILABLE,
        });
        expect(() => service.start('2.0.0')).toThrow(UPDATE_UNAVAILABLE);
        expect(() => service.restart()).toThrow(UPDATE_UNAVAILABLE);
        const app = updateRoutes(service, vi.fn());
        for (const route of ['/sources/test', '/download', '/restart']) {
            const response = await app.request(route, {
                method: 'POST',
                body: JSON.stringify({ version: '2.0.0' }),
            });
            expect(response.status).toBe(route === '/sources/test' ? 503 : 409);
            expect(await response.json()).toEqual({ message: UPDATE_UNAVAILABLE });
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not create or delete files with no pending', async () => {
        await mkdir(path.join(system, 'completed'));
        await writeFile(path.join(system, 'completed/transaction.json'), 'keep');
        await assertNoLegacyUpdate(root);
        expect(await readFile(path.join(system, 'completed/transaction.json'), 'utf8')).toBe(
            'keep',
        );
        expect(await exists(path.join(root, 'tmp/update'))).toBe(false);
    });

    it.each(['local', 'system', 'both'])(
        'fails closed with %s pending and preserves partial state',
        async (mode) => {
            const local = path.join(root, 'tmp/update/pending');
            const remote = path.join(system, 'pending');
            const paths = mode === 'both' ? [local, remote] : [mode === 'local' ? local : remote];
            await mkdir(path.dirname(local), { recursive: true });
            for (const pending of paths) {
                await mkdir(path.join(pending, 'backup'), { recursive: true });
                await mkdir(path.join(pending, 'payload'));
                await writeFile(path.join(pending, 'transaction.json'), '{corrupt');
                await writeFile(path.join(pending, 'backup/index.mjs'), 'backup');
                await writeFile(path.join(pending, 'payload/index.mjs'), 'legacy payload');
            }
            await writeFile(path.join(root, 'index.mjs'), 'partly replaced');
            await writeFile(path.join(root, '.update-install'), 'in progress');
            await expect(assertNoLegacyUpdate(root)).rejects.toThrow(/可能已部分应用/);
            for (const pending of paths) {
                expect(await readFile(path.join(pending, 'transaction.json'), 'utf8')).toBe(
                    '{corrupt',
                );
                expect(await readFile(path.join(pending, 'backup/index.mjs'), 'utf8')).toBe(
                    'backup',
                );
                expect(await readFile(path.join(pending, 'payload/index.mjs'), 'utf8')).toBe(
                    'legacy payload',
                );
            }
            expect(await readFile(path.join(root, 'index.mjs'), 'utf8')).toBe('partly replaced');
            expect(await readFile(path.join(root, '.update-install'), 'utf8')).toBe('in progress');
        },
    );

    it.each(['root tmp', 'local update', 'system staging'])(
        'blocks non-directory %s and preserves its contents',
        async (mode) => {
            let file: string;

            if (mode === 'root tmp') {
                file = path.join(root, 'tmp');
            } else if (mode === 'local update') {
                await mkdir(path.join(root, 'tmp'));
                file = path.join(root, 'tmp', 'update');
            } else {
                await rm(system, { recursive: true });
                file = system;
            }

            await writeFile(file, 'keep original bytes');
            const before = await readdir(path.dirname(file));
            await expect(assertNoLegacyUpdate(root)).rejects.toThrow(/暂存路径不是目录/);
            expect(await readFile(file, 'utf8')).toBe('keep original bytes');
            expect(await readdir(path.dirname(file))).toEqual(before);
        },
    );

    it.each(['local', 'system'])('blocks a dangling %s staging ancestor', async (mode) => {
        const link = mode === 'local' ? path.join(root, 'tmp') : system;
        if (mode === 'system') {
            await rm(system, { recursive: true });
        }
        await symlink(
            path.join(root, 'missing-target'),
            link,
            process.platform === 'win32' ? 'junction' : 'dir',
        );
        await expect(assertNoLegacyUpdate(root)).rejects.toThrow(/暂存路径是链接/);
        expect(await exists(link)).toBe(true);
    });

    it('blocks an isolated .update-install without deleting it', async () => {
        await writeFile(path.join(root, '.update-install'), 'partial');
        await expect(assertNoLegacyUpdate(root)).rejects.toThrow(/可能已部分应用/);
        expect(await readFile(path.join(root, '.update-install'), 'utf8')).toBe('partial');
    });
});
