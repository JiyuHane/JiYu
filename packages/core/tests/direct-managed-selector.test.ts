import {
    chmod,
    chown,
    link,
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rename,
    rm,
    symlink,
    unlink,
    writeFile,
    type FileHandle,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ManagedFileError,
    readManagedQr,
    readManagedSelector,
    saveManagedSelector,
    type ManagedFileErrorCode,
} from '../src/direct/managed-selector';

// Keep real Linux fs semantics. The optional hook injects a race/fault on a specific opened fd.
const hooks = vi.hoisted(() => ({
    opened: undefined as ((name: string, fd: FileHandle) => Promise<void> | void) | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
    const fs = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...fs,
        async open(...args: Parameters<typeof fs.open>) {
            const fd = await fs.open(...args);

            try {
                await hooks.opened?.(String(args[0]), fd);
                return fd;
            } catch (error) {
                await fd.close();
                throw error;
            }
        },
    };
});

const current = () => true;
const linux = process.platform === 'linux';
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const jpeg = Buffer.from('ffd8ff0010304050', 'hex');
const webp = Buffer.from('524946460400000057454250', 'hex');
const stem = `qr-${'12ab'.repeat(6)}`;
const roots: string[] = [];

async function fixture() {
    // /tmp is usually world-writable, which is intentionally not a trusted ancestor.
    const parent = linux ? (process.env.JIYU_SELECTOR_TEST_ROOT ?? os.homedir()) : os.tmpdir();
    const dir = await mkdtemp(path.join(parent, '.jiyu-selector-test-'));
    roots.push(dir);
    return { dir, file: path.join(dir, 'selector.json'), qr: path.join(dir, `${stem}.png`) };
}

afterEach(async () => {
    hooks.opened = undefined;
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fails(promise: Promise<unknown>, code: ManagedFileErrorCode): Promise<void> {
    const error: unknown = await promise.then(
        () => undefined,
        (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ManagedFileError);
    expect(error).toMatchObject({ code, message: code });
    expect(Object.hasOwn(error as Error, 'cause')).toBe(false);
}

const makeFile = (name: string, data: string | Buffer) =>
    writeFile(name, data, { mode: 0o600, flag: 'wx' });
const v1 = (uin: string) => JSON.stringify({ version: 1, uin });

describe('managed file input and generation boundaries', () => {
    it.each([
        '',
        '0',
        '00',
        '01',
        '+1',
        '-1',
        ' 1',
        '1 ',
        '1\n',
        '1.0',
        '1e1',
        '９',
        '4294967296',
        '10000000000',
        42,
        null,
    ])('accepts no non-canonical UIN (%j)', async (uin) => {
        const { dir, file } = await fixture();
        await fails(saveManagedSelector(file, uin as string, current), 'managed-selector-invalid');
        expect(await readdir(dir)).toEqual([]);
    });

    it('stops before filesystem access on a revoked, throwing or non-boolean guard', async () => {
        const { dir, file, qr } = await fixture();
        const opened = vi.fn();
        hooks.opened = opened;

        for (const guard of [
            () => false,
            () => {
                throw new Error('private detail');
            },
            (() => 1) as unknown as () => boolean,
        ]) {
            await fails(saveManagedSelector(file, '42', guard), 'managed-file-stale');
            await fails(readManagedQr(dir, qr, guard), 'managed-file-stale');
        }

        expect(opened).not.toHaveBeenCalled();
        expect(await readdir(dir)).toEqual([]);
    });

    it('rejects path aliases, other parents, suffixes and browser-like paths before opening a file', async () => {
        const { dir } = await fixture();
        const posixDir = linux ? dir : `/${path.basename(dir)}`;
        const name = `${stem}.png`;
        const opened = vi.fn();
        hooks.opened = opened;

        for (const file of [
            name,
            `file://${posixDir}/${name}`,
            `${posixDir}-else/${name}`,
            `${posixDir}/nested/${name}`,
            `${posixDir}/nested/../${name}`,
            `${posixDir}/./${name}`,
            `${posixDir}//${name}`,
            `${posixDir}/selector.json`,
            `${posixDir}/qr-1.png`,
            `${posixDir}/qr-${'AB'.repeat(12)}.png`,
            `${posixDir}/${stem}.PNG`,
            `${posixDir}/${name}.bak`,
            `${posixDir}/${name}\0`,
        ]) {
            await fails(readManagedQr(posixDir, file, current), 'managed-qr-unavailable');
        }

        expect(opened).not.toHaveBeenCalled();
    });

    it.runIf(!linux)('provides no weaker platform fallback', async () => {
        const { dir, file } = await fixture();
        const posixDir = `/${path.basename(dir)}`;
        await fails(readManagedSelector(file), 'unsupported-platform');
        await fails(saveManagedSelector(file, '42', current), 'unsupported-platform');
        await fails(
            readManagedQr(posixDir, `${posixDir}/${stem}.png`, current),
            'unsupported-platform',
        );
        expect(await readdir(dir)).toEqual([]);
    });
});

describe.runIf(linux)('managed selector on a real private Linux directory', () => {
    it('returns null only on initial missing leaf, never creates a missing parent or follows a dangling link', async () => {
        const { dir, file } = await fixture();
        expect(await readManagedSelector(file)).toBeNull();
        const unprepared = path.join(dir, 'missing', 'selector.json');
        await fails(readManagedSelector(unprepared), 'managed-selector-io');
        await fails(saveManagedSelector(unprepared, '1', current), 'managed-selector-io');
        expect(await readdir(dir)).toEqual([]);
        await symlink(path.join(dir, 'absent'), file);
        await fails(readManagedSelector(file), 'managed-selector-invalid');
        await fails(saveManagedSelector(file, '1', current), 'managed-selector-invalid');
        expect((await lstat(file)).isSymbolicLink()).toBe(true);
    });

    it('rejects distinct JS paths that the filesystem would encode identically', async () => {
        const { dir } = await fixture();
        const real = path.join(dir, '\ufffd');
        const alias = path.join(dir, '\ud800');
        await mkdir(real, { mode: 0o700 });
        await makeFile(path.join(real, 'selector.json'), v1('7'));
        await makeFile(path.join(real, `${stem}.png`), png);
        await fails(
            readManagedSelector(path.join(alias, 'selector.json')),
            'managed-selector-invalid',
        );
        await fails(
            saveManagedSelector(path.join(alias, 'selector.json'), '7', current),
            'managed-selector-invalid',
        );
        await fails(
            readManagedQr(alias, path.join(alias, `${stem}.png`), current),
            'managed-qr-unavailable',
        );
    });

    it('distinguishes a vanished observed file from a clean miss', async () => {
        const { file } = await fixture();
        await makeFile(file, v1('7'));

        hooks.opened = async (name) => {
            if (name.endsWith('/selector.json')) {
                await unlink(file);
            }
        };

        await expect(readManagedSelector(file)).rejects.toBeInstanceOf(ManagedFileError);
    });

    it.each(['1', '4294967295'])(
        'publishes exactly a v1 UIN, with file sync before directory sync (%s)',
        async (uin) => {
            const { dir, file } = await fixture();
            const syncs: string[] = [];

            hooks.opened = async (_name, fd) => {
                const isDir = (await fd.stat()).isDirectory();
                const sync = fd.sync.bind(fd);
                vi.spyOn(fd, 'sync').mockImplementation(async () => {
                    if (isDir) {
                        expect(await readFile(file, 'utf8')).toBe(`${v1(uin)}\n`);
                    } else {
                        await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
                    }

                    await sync();
                    syncs.push(isDir ? 'directory' : 'file');
                });
            };

            await saveManagedSelector(file, uin, current);
            expect(syncs).toEqual(['file', 'directory']);
            const info = await lstat(file);
            expect(info.mode & 0o7777).toBe(0o600);
            expect(info.uid).toBe(process.getuid!());
            expect(info.nlink).toBe(1);
            expect(await readManagedSelector(file)).toBe(uin);
            expect(await readdir(dir)).toEqual(['selector.json']);
        },
    );

    it('preserves the legacy selector bytes and inode on both idempotence and conflict', async () => {
        const { dir, file } = await fixture();
        const legacy = '{ "uin" : "42",\n "version" : 1 }\n';
        await makeFile(file, legacy);
        const before = await lstat(file, { bigint: true });
        expect(await readManagedSelector(file)).toBe('42');
        await saveManagedSelector(file, '42', current);
        await fails(saveManagedSelector(file, '43', current), 'managed-selector-conflict');
        const after = await lstat(file, { bigint: true });
        expect([after.ino, after.ctimeNs, after.mtimeNs]).toEqual([
            before.ino,
            before.ctimeNs,
            before.mtimeNs,
        ]);
        expect(await readFile(file, 'utf8')).toBe(legacy);
        expect(await readdir(dir)).toEqual(['selector.json']);
    });

    it('rejects malformed, ambiguous, oversize or noncanonical disk contents without replacing them', async () => {
        const { file } = await fixture();
        const full = v1('42').padEnd(1024, ' ');
        await makeFile(file, full);
        expect(await readManagedSelector(file)).toBe('42');

        for (const data of [
            '',
            '{',
            'null',
            '42',
            '"42"',
            '[]',
            full + ' ',
            '{"version":1}',
            '{"version":2,"uin":"42"}',
            '{"version":1,"uin":42}',
            '{"version":1,"uin":"42","extra":true}',
            '{"version":1,"uin":"7","uin":"42"}',
            v1('00'),
            v1('1e1'),
            v1('4294967296'),
            Buffer.from([0xff, 0xfe]),
        ]) {
            await writeFile(file, data);
            await fails(readManagedSelector(file), 'managed-selector-invalid');
            await fails(saveManagedSelector(file, '42', current), 'managed-selector-invalid');
            expect(await readFile(file)).toEqual(Buffer.from(data));
        }
    });

    it('does not overwrite an independent publisher that wins between lookup and link', async () => {
        const { dir, file } = await fixture();
        const winner = v1('77');

        hooks.opened = async (name) => {
            if (name.endsWith('.tmp')) {
                await makeFile(file, winner);
            }
        };

        await fails(saveManagedSelector(file, '42', current), 'managed-selector-conflict');
        expect(await readFile(file, 'utf8')).toBe(winner);
        expect(await readdir(dir)).toEqual(['selector.json']);
    });

    it('concurrent first saves converge only for the winning UIN', async () => {
        const { dir, file } = await fixture();
        const uins = ['21', '22', '23', '21', '22', '23'];
        const results = await Promise.allSettled(
            uins.map((uin) => saveManagedSelector(file, uin, current)),
        );
        const winner = await readManagedSelector(file);
        expect(uins).toContain(winner);

        for (const [index, result] of results.entries()) {
            if (uins[index] === winner) {
                expect(result.status).toBe('fulfilled');
            } else {
                expect(result).toMatchObject({
                    status: 'rejected',
                    reason: { code: 'managed-selector-conflict' },
                });
            }
        }

        expect(await readdir(dir)).toEqual(['selector.json']);
    });

    it.each([
        { when: 'file', cancel: true, code: 'managed-file-stale' },
        { when: 'file', cancel: false, code: 'managed-selector-io' },
        { when: 'directory', cancel: true, code: 'managed-selector-commit-uncertain' },
        { when: 'directory', cancel: false, code: 'managed-selector-commit-uncertain' },
    ] as const)(
        'handles $when sync with cancel=$cancel, without pretending to roll back a commit',
        async ({ when, cancel, code }) => {
            const { dir, file } = await fixture();
            let live = true;

            hooks.opened = async (_name, fd) => {
                if ((await fd.stat()).isDirectory() !== (when === 'directory')) {
                    return;
                }

                const sync = fd.sync.bind(fd);
                vi.spyOn(fd, 'sync').mockImplementation(async () => {
                    if (!cancel) {
                        throw new Error('private fsync detail');
                    }

                    live = false;
                    await sync();
                });
            };

            await fails(
                saveManagedSelector(file, '42', () => live),
                code,
            );
            expect(await readManagedSelector(file)).toBe(when === 'file' ? null : '42');
            expect(await readdir(dir)).toEqual(when === 'file' ? [] : ['selector.json']);
        },
    );

    it.each([true, false])(
        'detects a name replaced during directory sync (published here: %s)',
        async (first) => {
            const { file } = await fixture();

            if (!first) {
                await makeFile(file, v1('42'));
            }

            hooks.opened = async (_name, fd) => {
                if ((await fd.stat()).isDirectory()) {
                    const sync = fd.sync.bind(fd);
                    vi.spyOn(fd, 'sync').mockImplementation(async () => {
                        await rename(file, `${file}.previous`);
                        await makeFile(file, v1('77'));
                        await sync();
                    });
                }
            };

            await fails(
                saveManagedSelector(file, '42', current),
                first ? 'managed-selector-commit-uncertain' : 'managed-selector-invalid',
            );
            expect(await readFile(file, 'utf8')).toBe(v1('77'));
            expect(await readManagedSelector(`${file}.previous`)).toBe('42');
        },
    );

    it('honors revocation after checking an already matching selector', async () => {
        const { file } = await fixture();
        await makeFile(file, v1('42'));
        let live = true;

        hooks.opened = (name, fd) => {
            if (name.endsWith('/selector.json')) {
                const close = fd.close.bind(fd);
                vi.spyOn(fd, 'close').mockImplementation(async () => {
                    await close();
                    live = false;
                });
            }
        };

        await fails(
            saveManagedSelector(file, '42', () => live),
            'managed-file-stale',
        );
        expect(await readFile(file, 'utf8')).toBe(v1('42'));
    });
});

describe.runIf(linux)('private Linux file identities', () => {
    it('rejects group/other permissions, special and non-0600 mode bits', async () => {
        const { dir, file, qr } = await fixture();
        await makeFile(file, v1('1'));
        await makeFile(qr, png);

        for (const mode of [0o640, 0o604, 0o400, 0o700, 0o4600]) {
            await chmod(file, mode);
            await chmod(qr, mode);
            await fails(readManagedSelector(file), 'managed-selector-invalid');
            await fails(saveManagedSelector(file, '1', current), 'managed-selector-invalid');
            await fails(readManagedQr(dir, qr, current), 'managed-qr-unavailable');
        }
    });

    it('rejects symlinks, hardlinks and directories even at an otherwise legitimate name', async () => {
        const { dir, file, qr } = await fixture();

        for (const [target, contents] of [
            [file, v1('42')],
            [qr, png],
        ] as const) {
            const source = `${target}.original`;
            await makeFile(source, contents);
            const read = () =>
                target === qr ? readManagedQr(dir, target, current) : readManagedSelector(target);
            const code = target === qr ? 'managed-qr-unavailable' : 'managed-selector-invalid';
            await symlink(source, target);
            await fails(read(), code);
            await unlink(target);
            await link(source, target);
            await fails(read(), code);
            await unlink(target);
            await mkdir(target, { mode: 0o700 });
            await fails(read(), code);
            expect(await readFile(source)).toEqual(Buffer.from(contents));
        }
    });

    it('requires private leaf directories and trustworthy, nonsymlink ancestors even for a miss', async () => {
        const { dir } = await fixture();
        const ancestor = path.join(dir, 'ancestor');
        const out = path.join(ancestor, 'out');
        await mkdir(out, { mode: 0o700, recursive: true });
        const alias = path.join(dir, 'alias');
        await symlink(ancestor, alias);

        const denied = async (candidate: string) => {
            const file = path.join(candidate, 'selector.json');
            await fails(readManagedSelector(file), 'managed-selector-invalid');
            await fails(saveManagedSelector(file, '1', current), 'managed-selector-invalid');
            await fails(
                readManagedQr(candidate, path.join(candidate, `${stem}.png`), current),
                'managed-qr-unavailable',
            );
        };

        await denied(path.join(alias, 'out'));
        await chmod(ancestor, 0o1777);
        await denied(out);
        await chmod(ancestor, 0o700);
        await chmod(out, 0o755);
        await denied(out);
        expect(await readdir(out)).toEqual([]);
    });

    it.runIf(process.getuid?.() === 0)(
        'rejects foreign file and directory ownership even when root can read them',
        async () => {
            const { dir, file, qr } = await fixture();
            await makeFile(file, v1('1'));
            await makeFile(qr, png);
            await chown(file, 1, 1);
            await chown(qr, 1, 1);
            await fails(readManagedSelector(file), 'managed-selector-invalid');
            await fails(readManagedQr(dir, qr, current), 'managed-qr-unavailable');
            await chown(dir, 1, 1);
            await fails(readManagedSelector(path.join(dir, 'missing')), 'managed-selector-invalid');
        },
    );
});

describe.runIf(linux)('current generated QR snapshots', () => {
    it.each([
        ['png', png, 'image/png'],
        ['jpg', jpeg, 'image/jpeg'],
        ['webp', webp, 'image/webp'],
    ] as const)(
        'sniffs %s and transfers isolated, independently wipeable bytes',
        async (ext, bytes, mime) => {
            const { dir } = await fixture();
            const qr = path.join(dir, `${stem}.${ext}`);
            await makeFile(qr, bytes);
            const first = await readManagedQr(dir, qr, current);
            const second = await readManagedQr(dir, qr, current);
            expect(first.contentType).toBe(mime);
            expect(first.bytes).toEqual(new Uint8Array(bytes));
            first.bytes.fill(0);
            expect(second.bytes).toEqual(new Uint8Array(bytes));
            expect(await readFile(qr)).toEqual(bytes);
            second.bytes.fill(0);
        },
    );

    it('enforces magic, matching extension and the exact 1 MiB upper bound', async () => {
        const { dir, qr } = await fixture();
        await fails(readManagedQr(dir, qr, current), 'managed-qr-unavailable');
        const maximum = Buffer.alloc(1024 * 1024);
        png.copy(maximum);
        await makeFile(qr, maximum);
        const snapshot = await readManagedQr(dir, qr, current);
        expect(snapshot.bytes.length).toBe(maximum.length);
        snapshot.bytes.fill(0);

        for (const invalid of [
            Buffer.concat([maximum, Buffer.from([0])]),
            Buffer.alloc(0),
            Buffer.from('not an image'),
            png.subarray(0, 7),
            jpeg,
            webp,
        ]) {
            await writeFile(qr, invalid);
            await fails(readManagedQr(dir, qr, current), 'managed-qr-unavailable');
            expect((await lstat(qr)).size).toBe(invalid.length);
        }
    });

    it('drops already read bytes if the generation is revoked before delivery; leaves the file alone', async () => {
        const { dir, qr } = await fixture();
        await makeFile(qr, png);
        let live = true;

        hooks.opened = (name, fd) => {
            if (name.endsWith(`/${stem}.png`)) {
                const close = fd.close.bind(fd);
                vi.spyOn(fd, 'close').mockImplementation(async () => {
                    await close();
                    live = false;
                });
            }
        };

        await fails(
            readManagedQr(dir, qr, () => live),
            'managed-file-stale',
        );
        expect(await readFile(qr)).toEqual(png);
    });

    it.each(['file', 'parent'])(
        'rejects replacement of the %s after open, leaving both generations untouched',
        async (which) => {
            const { dir } = await fixture();
            const out = path.join(dir, 'out');
            await mkdir(out, { mode: 0o700 });
            const qr = path.join(out, `${stem}.png`);
            const retired = which === 'file' ? `${qr}.retired` : path.join(dir, 'retired');
            await makeFile(qr, png);
            const other = Buffer.concat([png, Buffer.from('different')]);

            hooks.opened = async (name) => {
                if (name.endsWith(`/${stem}.png`)) {
                    await rename(which === 'file' ? qr : out, retired);

                    if (which === 'parent') {
                        await mkdir(out, { mode: 0o700 });
                    }

                    await makeFile(qr, other);
                }
            };

            await fails(readManagedQr(out, qr, current), 'managed-qr-unavailable');
            expect(await readFile(qr)).toEqual(other);
            expect(
                await readFile(which === 'file' ? retired : path.join(retired, `${stem}.png`)),
            ).toEqual(png);
        },
    );
});
