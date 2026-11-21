import { chmod, lstat, mkdtemp, readFile, rename, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    openAccountVault,
    type AccountVault,
    type VaultBinding,
    type VaultGuard,
} from '../src/direct/account-vault';

// Real Linux filesystem/flock/fsync with newly-created synthetic records only.
// Windows fake-fs regressions live in tools/direct-qq-login/account-vault.test.ts.
const opened: AccountVault[] = [];
const roots: string[] = [];
const binding = (): VaultBinding => ({
    uin: '123',
    profileDigest: new Uint8Array(32).fill(1),
    deviceDigest: new Uint8Array(32).fill(2),
});
const guard = (): VaultGuard => ({ signal: new AbortController().signal, isCurrent: () => true });

async function fixture() {
    // /tmp has public-writable ancestry, intentionally disallowed by the actual vault.
    const root = await mkdtemp(path.join(homedir(), '.jiyu-vault-invalidation-test-'));
    roots.push(root);
    await chmod(root, 0o700);
    const options = {
        vaultRoot: path.join(root, 'vault'),
        keyRoot: path.join(root, 'keys'),
        slotId: 'a'.repeat(32),
    };
    const vault = await openAccountVault({ ...options, initialize: true });
    opened.push(vault);
    return {
        root,
        options,
        vault,
        record: path.join(options.vaultRoot, `${options.slotId}.vault`),
    };
}

afterEach(async () => {
    await Promise.all(opened.splice(0).map((vault) => vault.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === 'linux')('real Linux CAS invalidation', () => {
    it('durably deletes a matching slot but preserves the immutable key and lock across reopen', async () => {
        const f = await fixture();
        const revision = await f.vault.save(binding(), Uint8Array.of(1, 2, 3), null, guard());
        const keyFile = path.join(f.options.keyRoot, 'master.key');
        const key = await readFile(keyFile);
        const lock = await lstat(path.join(f.options.vaultRoot, '.vault.lock'));
        expect((await lstat(f.record)).mode & 0o777).toBe(0o600);
        await f.vault.invalidate!(binding(), revision, guard());
        await expect(lstat(f.record)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(keyFile)).toEqual(key);
        expect((await lstat(path.join(f.options.vaultRoot, '.vault.lock'))).ino).toBe(lock.ino);
        key.fill(0);
        await f.vault.close();
        const reopened = await openAccountVault({ ...f.options, initialize: false });
        opened.push(reopened);
        expect(await reopened.read(binding(), () => null)).toEqual({ kind: 'missing' });
        await expect(reopened.invalidate!(binding(), revision, guard())).rejects.toMatchObject({
            code: 'revision-conflict',
        });
    });
    it('keeps a newer authenticated generation on stale CAS and then accepts the exact revision', async () => {
        const f = await fixture();
        const first = await f.vault.save(binding(), Uint8Array.of(1), null, guard());
        const second = await f.vault.save(binding(), Uint8Array.of(2), first, guard());
        await expect(f.vault.invalidate!(binding(), first, guard())).rejects.toMatchObject({
            code: 'revision-conflict',
        });
        expect(await f.vault.read(binding(), (bytes) => [...bytes])).toMatchObject({
            value: [2],
            revision: second,
        });
        await f.vault.invalidate!(binding(), second, guard());
        expect(await f.vault.read(binding(), () => null)).toEqual({ kind: 'missing' });
    });
    it('retains a substituted symlink and its target instead of unlinking either', async () => {
        const f = await fixture();
        const revision = await f.vault.save(binding(), Uint8Array.of(3), null, guard());
        const backup = `${f.record}.synthetic-backup`;
        await rename(f.record, backup);
        await symlink(backup, f.record);
        await expect(f.vault.invalidate!(binding(), revision, guard())).rejects.toMatchObject({
            code: 'path-policy',
        });
        expect((await lstat(f.record)).isSymbolicLink()).toBe(true);
        expect((await lstat(backup)).isFile()).toBe(true);
    });
    it('honors cancellation and keeps the stable cross-owner flock until close', async () => {
        const f = await fixture();
        const revision = await f.vault.save(binding(), Uint8Array.of(4), null, guard());
        const abort = new AbortController();
        abort.abort();
        await expect(
            f.vault.invalidate!(binding(), revision, {
                signal: abort.signal,
                isCurrent: () => true,
            }),
        ).rejects.toMatchObject({ code: 'cancelled' });
        await expect(openAccountVault({ ...f.options, initialize: false })).rejects.toMatchObject({
            code: 'locked',
        });
        expect((await lstat(f.record)).isFile()).toBe(true);
    });
});
