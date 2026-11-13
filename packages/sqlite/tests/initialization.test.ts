import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { SqliteDatabase } from '../src/index';
import * as driver from '../src/driver';
import { Database } from '../src/driver';

const directories: string[] = [];
afterEach(async () => {
    vi.restoreAllMocks();

    for (const directory of directories.splice(0)) {
        await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
});

async function directory(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-init-'));
    directories.push(dir);
    return dir;
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

it('opens concurrent writable connections to fresh databases with WAL and usable data', async () => {
    const dir = await directory();

    for (let i = 0; i < 30; i++) {
        const file = path.join(dir, String(i), 'messages.db');
        const first = new SqliteDatabase(file);
        const second = new SqliteDatabase(file);

        try {
            await Promise.all([first.initialization, second.initialization]);
            expect(await first.prepare('PRAGMA journal_mode').get()).toEqual({
                journal_mode: 'wal',
            });
            expect(await second.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 1000 });
            await first.exec(
                'CREATE TABLE records (value INTEGER); INSERT INTO records VALUES (7)',
            );
            expect(await second.prepare('SELECT value FROM records').get()).toEqual({ value: 7 });
        } finally {
            await Promise.all([first.close(), second.close()]);
        }
    }
});

it('serializes the same filename while unrelated files, memory and read-only opens progress', async () => {
    const dir = await directory();
    const file = path.join(dir, 'messages.db');
    const entered = deferred();
    const release = deferred();
    const original = Database.prototype.exec;
    let walCalls = 0;
    const exec = vi.spyOn(Database.prototype, 'exec').mockImplementation(async function (
        this: Database,
        sql,
    ) {
        if (sql === 'PRAGMA journal_mode = WAL' && ++walCalls === 1) {
            entered.resolve();
            await release.promise;
        }

        return original.call(this, sql);
    });
    const open = vi.spyOn(driver, 'openDatabase');
    const first = new SqliteDatabase(file);
    await entered.promise;
    const second = new SqliteDatabase(file);
    const other = new SqliteDatabase(path.join(dir, 'other.db'));
    const memory = new SqliteDatabase(':memory:');
    const readonly = new SqliteDatabase(file, { readOnly: true });
    const closing = second.close();

    try {
        await Promise.all([other.initialization, memory.initialization, readonly.initialization]);
        // Allow the second path lookup to complete while the first is still gated.
        await delay(30);
        expect(open).toHaveBeenCalledTimes(4); // first, unrelated, memory, read-only
        await expect(second.exec('SELECT 1')).rejects.toThrow('closing');
        expect(exec.mock.calls.filter(([sql]) => sql === 'PRAGMA journal_mode = WAL')).toHaveLength(
            3,
        );
    } finally {
        release.resolve();
        await Promise.allSettled([first.initialization, second.initialization, closing]);
        await Promise.all([
            first.close(),
            second.close(),
            other.close(),
            memory.close(),
            readonly.close(),
        ]);
    }

    expect(open).toHaveBeenCalledTimes(5);
});

it('coordinates relative and absolute names of a new database', async () => {
    const dir = await directory();
    const originalCwd = process.cwd();
    process.chdir(dir);
    const entered = deferred();
    const release = deferred();
    const original = Database.prototype.exec;
    let firstWal = true;
    vi.spyOn(Database.prototype, 'exec').mockImplementation(async function (this: Database, sql) {
        if (sql === 'PRAGMA journal_mode = WAL' && firstWal) {
            firstWal = false;
            entered.resolve();
            await release.promise;
        }

        return original.call(this, sql);
    });
    const open = vi.spyOn(driver, 'openDatabase');
    const first = new SqliteDatabase('messages.db');
    let second: SqliteDatabase | undefined;

    try {
        await entered.promise;
        second = new SqliteDatabase(path.join(dir, 'messages.db'));
        await delay(30);
        expect(open).toHaveBeenCalledTimes(1);
        release.resolve();
        await Promise.all([first.initialization, second.initialization]);
        expect(open).toHaveBeenCalledTimes(2);
    } finally {
        release.resolve();

        try {
            await Promise.all([first.close(), second?.close()]);
        } finally {
            process.chdir(originalCwd);
        }
    }
});

it('freezes the path after beforeOpen even if cwd changes during native open', async () => {
    const dir = await directory();
    const firstDir = path.join(dir, 'a');
    const secondDir = path.join(dir, 'b');
    await Promise.all([mkdir(firstDir), mkdir(secondDir)]);
    const cwd = process.cwd();
    const entered = deferred();
    const release = deferred();
    const openNative = driver.openDatabase;
    const open = vi.spyOn(driver, 'openDatabase').mockImplementation(async (filename, readOnly) => {
        if (open.mock.calls.length === 1) {
            entered.resolve();
            await release.promise;
        }

        return openNative(filename, readOnly);
    });
    process.chdir(firstDir);
    const first = new SqliteDatabase('messages.db');
    let second: SqliteDatabase | undefined;

    try {
        await entered.promise;
        expect(open.mock.calls[0][0]).toBe(path.join(firstDir, 'messages.db'));
        process.chdir(secondDir);
        second = new SqliteDatabase(path.join(firstDir, 'messages.db'));
        await delay(30);
        expect(open).toHaveBeenCalledTimes(1);
        release.resolve();
        await Promise.all([first.initialization, second.initialization]);
        await first.exec('CREATE TABLE records (value INTEGER); INSERT INTO records VALUES (3)');
        expect(await second.prepare('SELECT value FROM records').get()).toEqual({ value: 3 });
        await expect(access(path.join(secondDir, 'messages.db'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    } finally {
        release.resolve();

        try {
            await Promise.allSettled([first.initialization, second?.initialization]);
            await Promise.all([first.close(), second?.close()]);
        } finally {
            process.chdir(cwd);
        }
    }
});

it('chooses the cwd after beforeOpen resolves', async () => {
    const dir = await directory();
    const firstDir = path.join(dir, 'a');
    const secondDir = path.join(dir, 'b');
    await Promise.all([mkdir(firstDir), mkdir(secondDir)]);
    const cwd = process.cwd();
    const gate = deferred();
    process.chdir(firstDir);
    const db = new SqliteDatabase('messages.db', { beforeOpen: gate.promise });

    try {
        process.chdir(secondDir);
        gate.resolve();
        await db.initialization;
        await access(path.join(secondDir, 'messages.db'));
        await expect(access(path.join(firstDir, 'messages.db'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    } finally {
        gate.resolve();

        try {
            await db.close();
        } finally {
            process.chdir(cwd);
        }
    }
});

it.each(['', ':memory:'])('keeps native temporary-database semantics for %j', async (file) => {
    const open = vi.spyOn(driver, 'openDatabase');
    const db = new SqliteDatabase(file);

    try {
        await db.exec(
            'CREATE TABLE temporary_records (value INTEGER); INSERT INTO temporary_records VALUES (17)',
        );
        expect(await db.prepare('SELECT value FROM temporary_records').get()).toEqual({
            value: 17,
        });
        expect(open).toHaveBeenCalledWith(file, false);
    } finally {
        await db.close();
    }
});

it.each(['', ':memory:'])(
    'preserves native readonly special filename behavior for %j',
    async (file) => {
        let nativeCode: string | undefined;

        try {
            const native = await driver.openDatabase(file, true);
            await native.close();
        } catch (error) {
            nativeCode = (error as NodeJS.ErrnoException).code;
            expect(nativeCode).toBeDefined();
        }

        const open = vi.spyOn(driver, 'openDatabase');
        const db = new SqliteDatabase(file, { readOnly: true });

        try {
            if (nativeCode) {
                await expect(db.initialization).rejects.toMatchObject({ code: nativeCode });
            } else {
                await db.initialization;
            }

            expect(open).toHaveBeenCalledWith(file, true);
        } finally {
            await db.close();
        }
    },
);

it('keeps a live legacy alias WAL readable without rewriting its sidecar', async () => {
    const dir = await directory();
    const alias = path.join(dir, 'alias.db');
    const chained = path.join(dir, 'chained.db');
    await symlink('target.db', alias, 'file');
    await symlink('alias.db', chained, 'file');
    const oldOwner = await driver.openDatabase(chained, false);
    await oldOwner.exec(
        'PRAGMA journal_mode=WAL; CREATE TABLE legacy_records (value INTEGER); INSERT INTO legacy_records VALUES (23)',
    );
    const walName = (await readdir(dir)).find((name) => name.endsWith('-wal'));
    expect(walName).toBeDefined();
    const walPath = path.join(dir, walName!);
    const digest = async () =>
        createHash('sha256')
            .update(await readFile(walPath))
            .digest('hex');
    const before = await digest();
    const open = vi.spyOn(driver, 'openDatabase');
    const db = new SqliteDatabase(chained);

    try {
        expect(await db.prepare('SELECT value FROM legacy_records').get()).toEqual({ value: 23 });
        expect(open).toHaveBeenCalledWith(chained, false);
        expect(await digest()).toBe(before);
        await db.close();
        expect(await digest()).toBe(before);
    } finally {
        await db.close();
        await oldOwner.close();
    }

    const reopened = new SqliteDatabase(chained);

    try {
        expect(await reopened.prepare('SELECT value FROM legacy_records').get()).toEqual({
            value: 23,
        });
    } finally {
        await reopened.close();
    }
});

it.each(['alias-first', 'target-first'] as const)(
    'preserves native file-symlink WAL behavior with %s',
    async (order) => {
        const dir = await directory();

        async function scenario(kind: 'native' | 'facade') {
            const folder = path.join(dir, kind);
            await mkdir(folder);
            const target = path.join(folder, 'target.db');
            const alias = path.join(folder, 'alias.db');
            await symlink('target.db', alias, 'file');
            const names = order === 'alias-first' ? [alias, target] : [target, alias];
            const observed: { rows?: unknown; error?: string; sidecars: string[] } = {
                sidecars: [],
            };

            if (kind === 'native') {
                const first = await driver.openDatabase(names[0], false);
                await first.exec(
                    'PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL',
                );
                const second = await driver.openDatabase(names[1], false);

                try {
                    await second.exec(
                        'PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL',
                    );
                    await first.exec(
                        'CREATE TABLE records (value INTEGER); INSERT INTO records VALUES (17)',
                    );

                    try {
                        const statement = await second.prepare('SELECT value FROM records');

                        try {
                            observed.rows = await statement.all([]);
                        } finally {
                            await statement.finalize();
                        }
                    } catch (error) {
                        observed.error = (error as NodeJS.ErrnoException).code;
                    }

                    observed.sidecars = (await readdir(folder))
                        .filter((name) => /-(wal|shm|journal)$/.test(name))
                        .sort();
                } finally {
                    await second.close();
                    await first.close();
                }
            } else {
                const first = new SqliteDatabase(names[0]);
                await first.initialization;
                const second = new SqliteDatabase(names[1]);

                try {
                    await second.initialization;
                    await first.exec(
                        'CREATE TABLE records (value INTEGER); INSERT INTO records VALUES (17)',
                    );

                    try {
                        observed.rows = await second.prepare('SELECT value FROM records').all();
                    } catch (error) {
                        observed.error = (error as NodeJS.ErrnoException).code;
                    }

                    observed.sidecars = (await readdir(folder))
                        .filter((name) => /-(wal|shm|journal)$/.test(name))
                        .sort();
                } finally {
                    await second.close();
                    await first.close();
                }
            }

            return observed;
        }

        expect(await scenario('facade')).toEqual(await scenario('native'));
    },
);

it('releases the same-file queue after initialization failure, including native cleanup', async () => {
    const file = path.join(await directory(), 'db');
    const entered = deferred();
    const release = deferred();
    const failure = new Error('injected initialization failure');
    const original = Database.prototype.exec;
    let firstWal = true;
    const exec = vi.spyOn(Database.prototype, 'exec').mockImplementation(async function (
        this: Database,
        sql,
    ) {
        if (sql === 'PRAGMA journal_mode = WAL' && firstWal) {
            firstWal = false;
            entered.resolve();
            await release.promise;
            throw failure;
        }

        return original.call(this, sql);
    });
    const closeStarted = deferred();
    const closeRelease = deferred();
    const originalClose = Database.prototype.close;
    const close = vi.spyOn(Database.prototype, 'close').mockImplementationOnce(async function (
        this: Database,
    ) {
        closeStarted.resolve();
        await closeRelease.promise;
        return originalClose.call(this);
    });
    const open = vi.spyOn(driver, 'openDatabase');
    const first = new SqliteDatabase(file);
    await entered.promise;
    const second = new SqliteDatabase(file);
    const rejected = expect(first.initialization).rejects.toBe(failure);

    try {
        release.resolve();
        await closeStarted.promise;
        await delay(30);
        expect(open).toHaveBeenCalledTimes(1);
        closeRelease.resolve();
        await rejected;
        await second.initialization;
        expect(close).toHaveBeenCalledTimes(1);
        expect(exec.mock.calls.filter(([sql]) => sql === 'PRAGMA journal_mode = WAL')).toHaveLength(
            2,
        );
        expect(await second.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 });
    } finally {
        release.resolve();
        closeRelease.resolve();
        await Promise.all([first.close(), second.close()]);
    }
});

it('does not let a rejected beforeOpen poison another owner of the same file', async () => {
    const file = path.join(await directory(), 'db');
    const gate = deferred();
    const failure = new Error('previous owner failed');
    const first = new SqliteDatabase(file, {
        beforeOpen: gate.promise.then(() => {
            throw failure;
        }),
    });
    const rejected = expect(first.initialization).rejects.toBe(failure);
    const second = new SqliteDatabase(file);

    try {
        await second.initialization;
        gate.resolve();
        await rejected;
        expect(await second.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 });
    } finally {
        gate.resolve();
        await Promise.all([first.close(), second.close()]);
    }
});

it('preserves an external reader lock failure without replaying the WAL request', async () => {
    const file = path.join(await directory(), 'db');
    // This direct native connection is outside the facade's initialization queue.
    const locker = await driver.openDatabase(file, false);
    await locker.exec('CREATE TABLE records (value INTEGER); BEGIN; SELECT * FROM records');
    const exec = vi.spyOn(Database.prototype, 'exec');
    const db = new SqliteDatabase(file, { busyTimeout: 0 });

    try {
        await expect(db.initialization).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
        expect(exec.mock.calls.filter(([sql]) => sql === 'PRAGMA journal_mode = WAL')).toHaveLength(
            1,
        );
    } finally {
        await db.close();
        await locker.exec('ROLLBACK');
        await locker.close();
    }

    const reopened = new SqliteDatabase(file);

    try {
        await reopened.initialization;
        expect(await reopened.prepare('PRAGMA journal_mode').get()).toEqual({
            journal_mode: 'wal',
        });
        expect(await reopened.prepare('SELECT count(*) AS n FROM records').get()).toEqual({ n: 0 });
    } finally {
        await reopened.close();
    }
});
