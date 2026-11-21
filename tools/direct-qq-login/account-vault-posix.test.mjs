import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

// Run with Node 24 on Linux, against the freshly bundled real implementation.
// No QQ, network, native samples, real account files, or external key providers.
if (process.platform !== 'linux') {
  test(
    'account vault real POSIX suite',
    { skip: 'Linux-only filesystem and flock tests' },
    () => {},
  );
} else {
  const moduleUrl = process.env.JIYU_VAULT_MODULE
    ? pathToFileURL(path.resolve(process.env.JIYU_VAULT_MODULE)).href
    : new URL('../../node_modules/.cache/jiyu-vault-tests/account-vault.mjs', import.meta.url).href;
  const { openAccountVault } = await import(moduleUrl);
  const parent =
    process.env.JIYU_VAULT_TEST_ROOT ?? path.join(os.homedir(), '.jiyu-vault-synthetic-tests');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const slotId = '1'.repeat(32);
  const payload = Buffer.from('synthetic-vault-ticket-not-a-real-account');
  const binding = () => ({
    uin: '123456789',
    profileDigest: Buffer.alloc(32, 3),
    deviceDigest: Buffer.alloc(32, 4),
  });
  const guard = () => ({ signal: new AbortController().signal, isCurrent: () => true });
  const options = (root, initialize = true) => ({
    vaultRoot: path.join(root, 'vault'),
    keyRoot: path.join(root, 'keys'),
    slotId,
    initialize,
  });
  const rootFor = async (t) => {
    const root = await fs.mkdtemp(path.join(parent, 'run-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
  };
  const child = (source, args = []) =>
    new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['--input-type=module', '-e', source, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      const stdout = [];
      const stderr = [];
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 20000);
      proc.stdout.on('data', (chunk) => stdout.push(chunk));
      proc.stderr.on('data', (chunk) => stderr.push(chunk));
      proc.on('error', reject);
      proc.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({
          code,
          signal,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        });
      });
    });
  const workerPrelude = `
        import assert from 'node:assert/strict';
        const [url,root,mode] = process.argv.slice(1);
        const opts = {vaultRoot:root+'/vault',keyRoot:root+'/keys',slotId:'${slotId}',initialize:false};
        const binding = {uin:'123456789',profileDigest:Buffer.alloc(32,3),deviceDigest:Buffer.alloc(32,4)};
        const guard = {signal:new AbortController().signal,isCurrent:()=>true};
    `;

  test('real 0700/0600, ciphertext, synchronous borrow, process reopen', async (t) => {
    const root = await rootFor(t);
    const opts = options(root);
    const owner = await openAccountVault(opts);
    try {
      for (const dir of [opts.vaultRoot, opts.keyRoot]) {
        assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
      }
      assert.equal((await fs.stat(path.join(opts.keyRoot, 'master.key'))).mode & 0o777, 0o600);
      const revision = await owner.save(binding(), payload, null, guard());
      assert.equal(revision.generation, 1n);
      const disk = await fs.readFile(path.join(opts.vaultRoot, slotId + '.vault'));
      assert.equal(disk.includes(payload), false);
      let borrowed;
      const result = await owner.read(binding(), (bytes) => {
        borrowed = bytes;
        return Buffer.from(bytes);
      });
      assert.deepEqual(result.value, payload);
      assert.deepEqual(borrowed, Buffer.alloc(payload.length));
      await owner.close();
      const resultFromNewProcess = await child(
        workerPrelude +
          `
                const {openAccountVault} = await import(url);
                const owner = await openAccountVault(opts);
                try {
                    const result = await owner.read(binding, bytes=>Buffer.from(bytes));
                    assert.equal(result.kind,'present');
                    assert.equal(result.value.toString(),'synthetic-vault-ticket-not-a-real-account');
                    process.stdout.write('restored\\n');
                } finally { await owner.close(); }
            `,
        [moduleUrl, root],
      );
      assert.equal(resultFromNewProcess.code, 0, resultFromNewProcess.stderr);
      assert.equal(resultFromNewProcess.stdout, 'restored\n');
    } finally {
      await owner.close();
    }
  });

  test('flock remains held after helper exit and releases on owner close', async (t) => {
    const root = await rootFor(t);
    const owner = await openAccountVault(options(root));
    const source =
      workerPrelude +
      `
            const {openAccountVault} = await import(url);
            try {
                const owner = await openAccountVault(opts);
                await owner.close();
                assert.equal(mode,'open');
                process.stdout.write('open\\n');
            } catch(error) {
                assert.equal(mode,'locked'); assert.equal(error.code,'locked');
                process.stdout.write('locked\\n');
            }
        `;
    try {
      const locked = await child(source, [moduleUrl, root, 'locked']);
      assert.equal(locked.code, 0, locked.stderr);
      assert.equal(locked.stdout, 'locked\n');
      await owner.close();
      const unlocked = await child(source, [moduleUrl, root, 'open']);
      assert.equal(unlocked.code, 0, unlocked.stderr);
      assert.equal(unlocked.stdout, 'open\n');
    } finally {
      await owner.close();
    }
  });

  test('actual mode, symlink, hardlink, ancestor and directory identity checks', async (t) => {
    const root = await rootFor(t);
    const opts = options(root);
    const owner = await openAccountVault(opts);
    const file = path.join(opts.vaultRoot, slotId + '.vault');
    try {
      await owner.save(binding(), payload, null, guard());
      const bytes = await fs.readFile(file);
      await fs.chmod(file, 0o644);
      await assert.rejects(
        owner.read(binding(), () => 1),
        { code: 'path-policy' },
      );
      await fs.chmod(file, 0o600);
      await fs.link(file, file + '.hardlink');
      await assert.rejects(
        owner.read(binding(), () => 1),
        { code: 'path-policy' },
      );
      await fs.unlink(file + '.hardlink');
      await fs.rename(file, file + '.original');
      await fs.symlink(file + '.original', file);
      await assert.rejects(
        owner.read(binding(), () => 1),
        { code: 'path-policy' },
      );
      await fs.unlink(file);
      await fs.rename(file + '.original', file);
      assert.deepEqual(await fs.readFile(file), bytes);
      await fs.chmod(opts.vaultRoot, 0o755);
      await assert.rejects(
        owner.read(binding(), () => 1),
        { code: 'path-policy' },
      );
      await fs.chmod(opts.vaultRoot, 0o700);
      await fs.rename(opts.vaultRoot, opts.vaultRoot + '-old');
      await fs.mkdir(opts.vaultRoot, { mode: 0o700 });
      await assert.rejects(
        owner.read(binding(), () => 1),
        { code: 'path-policy' },
      );
    } finally {
      await owner.close();
    }
    await fs.symlink(opts.keyRoot, root + '/keys-link');
    await assert.rejects(
      openAccountVault({ ...opts, vaultRoot: root + '/other', keyRoot: root + '/keys-link' }),
      { code: 'path-policy' },
    );
  });

  test('missing master and corrupt ciphertext are preserved, never initialized over', async (t) => {
    const root = await rootFor(t);
    const opts = options(root);
    let owner = await openAccountVault(opts);
    const file = path.join(opts.vaultRoot, slotId + '.vault');
    await owner.save(binding(), payload, null, guard());
    await owner.close();
    const key = path.join(opts.keyRoot, 'master.key');
    await fs.rename(key, key + '.held');
    await assert.rejects(openAccountVault(opts), { code: 'key-unavailable' });
    await fs.rename(key + '.held', key);
    const corrupt = await fs.readFile(file);
    corrupt[corrupt.length - 1] ^= 1;
    await fs.writeFile(file, corrupt, { mode: 0o600 });
    owner = await openAccountVault(options(root, false));
    try {
      await assert.rejects(
        owner.read(binding(), () => 1),
        { code: 'auth-failed' },
      );
      await assert.rejects(owner.save(binding(), payload, null, guard()), { code: 'auth-failed' });
      assert.deepEqual(await fs.readFile(file), corrupt);
    } finally {
      await owner.close();
    }
  });

  test('durable tombstone survives another process and blocks stale save', async (t) => {
    const root = await rootFor(t);
    const owner = await openAccountVault(options(root));
    try {
      const first = await owner.save(binding(), payload, null, guard());
      const revoked = await owner.revoke(binding(), first, guard());
      assert.equal(revoked.generation, 2n);
      await assert.rejects(owner.save(binding(), payload, first, guard()), {
        code: 'revision-conflict',
      });
      await owner.close();
      const result = await child(
        workerPrelude +
          `
                const {openAccountVault} = await import(url);
                const owner = await openAccountVault(opts);
                try {
                    const result = await owner.read(binding, ()=>{throw Error('unexpected payload')});
                    assert.equal(result.kind,'revoked'); process.stdout.write('revoked\\n');
                } finally { await owner.close(); }
            `,
        [moduleUrl, root],
      );
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, 'revoked\n');
    } finally {
      await owner.close();
    }
  });

  for (const point of ['after-write', 'after-file-sync', 'after-rename', 'after-dir-sync']) {
    test(`process SIGKILL at ${point}: only authenticated old/new is accepted`, async (t) => {
      const root = await rootFor(t);
      let owner = await openAccountVault(options(root));
      await owner.save(binding(), Buffer.from([1, 2, 3]), null, guard());
      await owner.close();
      const result = await child(
        workerPrelude +
          `
                import fsp from 'node:fs/promises';
                import {syncBuiltinESMExports} from 'node:module';
                let renamed = false;
                const die = ()=>process.kill(process.pid,'SIGKILL');
                const oldOpen = fsp.open;
                fsp.open = async function(name,...args) {
                    const handle = await oldOpen.call(this,name,...args);
                    const text = String(name);
                    if (text.includes('/.tmp-')) {
                        const oldWrite = handle.write.bind(handle);
                        handle.write = async (...values)=>{
                            const value = await oldWrite(...values);
                            if (mode==='after-write') die();
                            return value;
                        };
                    }
                    const oldSync = handle.sync.bind(handle);
                    handle.sync = async ()=>{
                        const value = await oldSync();
                        if (mode==='after-file-sync' && text.includes('/.tmp-')) die();
                        if (mode==='after-dir-sync' && renamed && text===opts.vaultRoot) die();
                        return value;
                    };
                    return handle;
                };
                const oldRename = fsp.rename;
                fsp.rename = async (...args)=>{
                    const value = await oldRename(...args); renamed = true;
                    if (mode==='after-rename') die();
                    return value;
                };
                syncBuiltinESMExports();
                const {openAccountVault} = await import(url);
                const owner = await openAccountVault(opts);
                const result = await owner.read(binding, ()=>null);
                await owner.save(binding,Buffer.from([7,8,9]),result.revision,guard);
                throw Error('crash injection did not execute');
            `,
        [moduleUrl, root, point],
      );
      assert.equal(result.signal, 'SIGKILL', result.stderr);
      owner = await openAccountVault(options(root, false));
      try {
        const record = await owner.read(binding(), (bytes) => Array.from(bytes));
        assert.deepEqual(
          record.value,
          point === 'after-write' || point === 'after-file-sync' ? [1, 2, 3] : [7, 8, 9],
        );
        const files = await fs.readdir(options(root).vaultRoot);
        for (const name of files.filter((name) => name.startsWith('.tmp-'))) {
          const disk = await fs.readFile(path.join(options(root).vaultRoot, name));
          assert.equal(disk.includes(payload), false);
        }
      } finally {
        await owner.close();
      }
    });
  }
}
