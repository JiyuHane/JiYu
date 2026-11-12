import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readManifest } from '../src/update/files';
import { releaseFixture } from './helpers/update-fixture';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const validator = path.join(repoRoot, 'tools/check-release-layout.mjs');
let root: string;

async function writeManifest(): Promise<void> {
    const entries = await readdir(root);
    await writeFile(
        path.join(root, 'release.json'),
        JSON.stringify({ version: '1.0.0', target: 'win32-x64', entries }),
    );
}

function validate() {
    return spawnSync(process.execPath, [validator, root], { encoding: 'utf8' });
}

beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'jiyu-release-layout-'));
    await releaseFixture(root, '1.0.0');
    for (const file of ['LICENSE', 'JIYU_NOTICE.md', 'EULA.md', 'PRIVACY.md']) {
        await copyFile(path.join(repoRoot, file), path.join(root, file));
    }
    const sqlite = path.join(root, 'native/sqlite');
    await mkdir(path.join(sqlite, 'prebuilds/win32-x64'), { recursive: true });
    await writeFile(path.join(sqlite, 'LICENSE.sqlite3'), 'fixture');
    await writeFile(path.join(sqlite, 'prebuilds/win32-x64/@appthreat+sqlite3.node'), 'fixture');
    await writeFile(
        path.join(sqlite, 'manifest.json'),
        JSON.stringify({
            target: 'win32-x64',
            package: '@appthreat/sqlite3',
            version: '9.1.0',
            nativeInterface: 1,
            files: ['prebuilds/win32-x64/@appthreat+sqlite3.node'],
        }),
    );
    await writeManifest();
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('release document layout', () => {
    it('accepts the new manifest and verifies the packaged documents and links', async () => {
        const manifest = await readManifest(root);
        expect(manifest.entries).toEqual(expect.arrayContaining(['LICENSE', 'JIYU_NOTICE.md']));
        const result = validate();
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
    });

    it('keeps old manifests readable while rejecting unapproved entries', async () => {
        await rm(path.join(root, 'LICENSE'));
        await rm(path.join(root, 'JIYU_NOTICE.md'));
        await writeManifest();
        await expect(readManifest(root)).resolves.toMatchObject({ version: '1.0.0' });
        await writeFile(path.join(root, 'unapproved.md'), 'unexpected');
        await writeManifest();
        await expect(readManifest(root)).rejects.toThrow('清单无效');
    });

    it.each(['LICENSE', 'JIYU_NOTICE.md'])('rejects a missing %s', async (file) => {
        await rm(path.join(root, file));
        await writeManifest();
        const result = validate();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(`release is missing required document: ${file}`);
    });

    it.each(['LICENSE', 'JIYU_NOTICE.md'])('rejects a modified %s', async (file) => {
        await writeFile(path.join(root, file), 'modified');
        const result = validate();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(`release document differs from source: ${file}`);
    });

    it.each(['EULA.md', 'PRIVACY.md'])('rejects a broken notice link in %s', async (file) => {
        const text = await readFile(path.join(root, file), 'utf8');
        await writeFile(
            path.join(root, file),
            text.replaceAll('](JIYU_NOTICE.md)', '](missing.md)'),
        );
        const result = validate();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(`${file} is missing its relative JIYU_NOTICE.md link`);
    });
});
