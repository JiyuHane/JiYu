import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Freshly bundle private-files.ts, then run this file with Node 24 on Linux.
// The fixtures contain only synthetic GUIDs. No QQ, account state or native addons.
if (process.platform !== 'linux') {
  test('existing GUID real filesystem suite', { skip: 'Linux filesystem required' }, () => {});
} else {
  const moduleUrl = process.env.JIYU_GUID_MODULE
    ? pathToFileURL(path.resolve(process.env.JIYU_GUID_MODULE)).href
    : new URL('../../node_modules/.cache/jiyu-guid-tests/private-files.mjs', import.meta.url).href;
  const { loadExistingDeviceGuid } = await import(moduleUrl);
  const parent =
    process.env.JIYU_GUID_TEST_ROOT ?? path.join(os.homedir(), '.jiyu-guid-synthetic-tests');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const guid = '0123456789abcdef0123456789abcdef';
  const otherGuid = 'fedcba9876543210fedcba9876543210';
  const bytesFor = (value = guid) => Buffer.from(JSON.stringify({ version: 1, guid: value }));
  const failure = {
    name: 'DirectLoginError',
    code: 'private-state',
    message: 'Direct QQ login: private-state',
  };
  const rootFor = async (t) => {
    const root = await fs.mkdtemp(path.join(parent, 'run-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
  };
  const fixture = async (t, bytes = bytesFor()) => {
    const root = await rootFor(t);
    const outer = path.join(root, 'outer');
    const directory = path.join(outer, 'inner');
    const file = path.join(directory, 'device.json');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
    return { root, outer, directory, file };
  };
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  // Interpose only asynchronous observation points; the handles, reads, stats,
  // symlink checks and closes are real Linux operations in the production loader.
  const instrument = (t, hooks = {}) => {
    const originalOpen = fs.open;
    const active = new Set();
    const closes = [];
    const originals = [];
    fs.open = async function (name, flags, ...args) {
      const label = String(name);
      await hooks.beforeOpen?.(label, flags);
      const handle = await originalOpen.call(this, name, flags, ...args);
      const close = handle.close.bind(handle);
      const read = handle.read.bind(handle);
      originals.push(close);
      active.add(handle);
      handle.read = async (...values) => {
        const result = await read(...values);
        await hooks.afterRead?.(label, result);
        return result;
      };
      handle.close = async () => {
        closes.push(label);
        await hooks.beforeClose?.(label);
        await close();
        active.delete(handle);
      };
      return handle;
    };
    syncBuiltinESMExports();
    t.after(async () => {
      fs.open = originalOpen;
      syncBuiltinESMExports();
      // Test cleanup, not evidence of loader cleanup: assertions precede this hook.
      await Promise.allSettled(originals.map((close) => close()));
    });
    return { active, closes };
  };
  const isDevice = (name) => name.endsWith('/device.json');

  test('trusted root/owner chain, private file, exact bytes and independent return buffers', async (t) => {
    const f = await fixture(t);
    await fs.chmod(f.outer, 0o755);
    const before = await fs.stat(f.file);
    const tracking = instrument(t);
    const first = await loadExistingDeviceGuid(f.file);
    const second = await loadExistingDeviceGuid(f.file);
    assert.equal(Buffer.from(first).toString('hex'), guid);
    assert.equal(Buffer.from(second).toString('hex'), guid);
    assert.notEqual(first, second);
    first.fill(0);
    assert.equal(Buffer.from(second).toString('hex'), guid);
    const after = await fs.stat(f.file);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.mode & 0o777, 0o600);
    assert.deepEqual(await fs.readFile(f.file), bytesFor());
    assert.equal(tracking.active.size, 0);
  });

  test('missing file and missing parent are preserved without initialization', async (t) => {
    const root = await rootFor(t);
    const tracking = instrument(t);
    await assert.rejects(loadExistingDeviceGuid(path.join(root, 'device.json')), failure);
    await assert.rejects(
      loadExistingDeviceGuid(path.join(root, 'absent', 'nested', 'device.json')),
      failure,
    );
    assert.deepEqual(await fs.readdir(root), []);
    assert.equal(tracking.active.size, 0);
  });

  for (const [name, bytes] of [
    ['broken JSON', Buffer.from('{broken')],
    ['wrong schema', Buffer.from(JSON.stringify({ version: 2, guid }))],
    ['extra field', Buffer.from(JSON.stringify({ version: 1, guid, account: 'synthetic' }))],
    ['malformed UTF-8', Buffer.concat([bytesFor(), Buffer.from([0xc0, 0xaf])])],
    ['oversized file', Buffer.alloc(1025, 32)],
  ]) {
    test(`preserves ${name} and releases all real file descriptors`, async (t) => {
      const f = await fixture(t, bytes);
      const tracking = instrument(t);
      await assert.rejects(loadExistingDeviceGuid(f.file), failure);
      assert.deepEqual(await fs.readFile(f.file), bytes);
      assert.equal(tracking.active.size, 0);
    });
  }

  test('accepts the exact 1024-byte boundary', async (t) => {
    const f = await fixture(t, Buffer.from(bytesFor().toString().padEnd(1024, ' ')));
    assert.equal(Buffer.from(await loadExistingDeviceGuid(f.file)).toString('hex'), guid);
  });

  for (const policy of [
    'file-mode',
    'hardlink',
    'leaf-symlink',
    'ancestor-symlink',
    'ancestor-0777',
    'fifo',
  ]) {
    test(`real Linux ${policy} is rejected`, async (t) => {
      const f = await fixture(t);
      let target = f.file;
      if (policy === 'file-mode') {
        await fs.chmod(f.file, 0o640);
      } else if (policy === 'hardlink') {
        await fs.link(f.file, f.file + '.hardlink');
      } else if (policy === 'leaf-symlink') {
        await fs.rename(f.file, f.file + '.original');
        await fs.symlink(f.file + '.original', f.file);
      } else if (policy === 'ancestor-symlink') {
        await fs.symlink(f.outer, path.join(f.root, 'alias'));
        target = path.join(f.root, 'alias', 'inner', 'device.json');
      } else if (policy === 'ancestor-0777') {
        await fs.chmod(f.outer, 0o777);
      } else {
        await fs.unlink(f.file);
        await promisify(execFile)('mkfifo', ['--mode=600', f.file]);
      }
      const tracking = instrument(t);
      await assert.rejects(loadExistingDeviceGuid(target), failure);
      assert.equal(tracking.active.size, 0);
    });
  }

  for (const change of [
    'ancestor-replacement',
    'ancestor-mode',
    'file-replacement',
    'same-size-write',
    'truncation',
    'new-hardlink',
  ]) {
    test(`detects real ${change} after reading through a pinned descriptor`, async (t) => {
      const f = await fixture(t);
      let changed = false;
      const tracking = instrument(t, {
        afterRead: async (name, result) => {
          if (changed || !isDevice(name) || result.bytesRead === 0) return;
          if (change === 'ancestor-replacement') {
            await fs.rename(f.outer, f.outer + '-held');
            await fs.mkdir(f.directory, { recursive: true, mode: 0o700 });
            await fs.writeFile(f.file, bytesFor(), { mode: 0o600 });
          } else if (change === 'ancestor-mode') {
            await fs.chmod(f.outer, 0o777);
          } else if (change === 'file-replacement') {
            await fs.rename(f.file, f.file + '.held');
            await fs.writeFile(f.file, bytesFor(), { mode: 0o600 });
          } else if (change === 'same-size-write') {
            await fs.writeFile(f.file, bytesFor(otherGuid));
            await fs.utimes(f.file, 1000000000, 1000000000);
          } else if (change === 'truncation') {
            await fs.truncate(f.file, 1);
          } else {
            await fs.link(f.file, f.file + '.new-link');
          }
          changed = true;
        },
      });
      await assert.rejects(loadExistingDeviceGuid(f.file), failure);
      assert.equal(changed, true);
      assert.equal(tracking.active.size, 0);
    });
  }

  test('fd-relative traversal detects a parent renamed before opening its descendant', async (t) => {
    const f = await fixture(t);
    let changed = false;
    const tracking = instrument(t, {
      beforeOpen: async (name) => {
        if (changed || !name.endsWith('/inner')) return;
        await fs.rename(f.outer, f.outer + '-held');
        await fs.mkdir(f.directory, { recursive: true, mode: 0o700 });
        await fs.writeFile(f.file, bytesFor(), { mode: 0o600 });
        changed = true;
      },
    });
    await assert.rejects(loadExistingDeviceGuid(f.file), failure);
    assert.equal(changed, true);
    assert.equal(tracking.active.size, 0);
  });

  test('does not hand the GUID to the caller while a real close is pending', async (t) => {
    const f = await fixture(t);
    const entered = deferred();
    const release = deferred();
    const tracking = instrument(t, {
      beforeClose: async (name) => {
        if (!isDevice(name)) return;
        entered.resolve();
        await release.promise;
      },
    });
    let settled = false;
    const pending = loadExistingDeviceGuid(f.file).finally(() => {
      settled = true;
    });
    try {
      await entered.promise;
      assert.equal(settled, false);
      assert.ok(tracking.active.size > 0);
    } finally {
      release.resolve();
    }
    assert.equal(Buffer.from(await pending).toString('hex'), guid);
    assert.equal(tracking.active.size, 0);
  });

  test('normalizes close failure and retries cleanup on real descriptors', async (t) => {
    const f = await fixture(t);
    let failed = false;
    const tracking = instrument(t, {
      beforeClose: (name) => {
        if (!failed && isDevice(name)) {
          failed = true;
          throw new Error('synthetic close detail');
        }
      },
    });
    await assert.rejects(loadExistingDeviceGuid(f.file), failure);
    assert.equal(failed, true);
    assert.equal(tracking.closes.filter(isDevice).length, 2);
    assert.equal(tracking.active.size, 0);
  });

  test('concurrent replacement accepts a new consistent snapshot and rejects the old pinned one', async (t) => {
    const f = await fixture(t);
    const entered = deferred();
    const release = deferred();
    let held = false;
    const tracking = instrument(t, {
      afterRead: async (name, result) => {
        if (held || !isDevice(name) || result.bytesRead === 0) return;
        held = true;
        entered.resolve();
        await release.promise;
      },
    });
    const first = loadExistingDeviceGuid(f.file);
    const firstRejected = assert.rejects(first, failure);
    try {
      await entered.promise;
      await fs.rename(f.file, f.file + '.held');
      await fs.writeFile(f.file, bytesFor(otherGuid), { mode: 0o600 });
      assert.equal(Buffer.from(await loadExistingDeviceGuid(f.file)).toString('hex'), otherGuid);
    } finally {
      release.resolve();
    }
    await firstRejected;
    assert.equal(tracking.active.size, 0);
  });

  test('repeated success and rejection leave the process fd count unchanged', async (t) => {
    const f = await fixture(t);
    await loadExistingDeviceGuid(f.file);
    const tracking = instrument(t);
    const before = (await fs.readdir('/proc/self/fd')).length;
    for (let iteration = 0; iteration < 12; iteration++) {
      assert.equal(Buffer.from(await loadExistingDeviceGuid(f.file)).toString('hex'), guid);
      await fs.chmod(f.file, 0o644);
      await assert.rejects(loadExistingDeviceGuid(f.file), failure);
      await fs.chmod(f.file, 0o600);
      assert.equal(tracking.active.size, 0);
    }
    assert.equal((await fs.readdir('/proc/self/fd')).length, before);
  });
}
