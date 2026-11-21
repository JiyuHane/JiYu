import { randomBytes } from 'node:crypto';
import { constants, linkSync, lstatSync, unlinkSync, type BigIntStats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { posix as path } from 'node:path';

const SELECTOR_LIMIT = 1024;
const QR_LIMIT = 1024 * 1024;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE_FLAGS =
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
const BIG = { bigint: true } as const;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

type Guard = () => boolean;
type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';
export type ManagedFileErrorCode =
    | 'unsupported-platform'
    | 'managed-selector-invalid'
    | 'managed-selector-io'
    | 'managed-selector-conflict'
    | 'managed-selector-commit-uncertain'
    | 'managed-file-stale'
    | 'managed-qr-unavailable';

/** Never retain an OS error, path, selector value or guard exception. */
export class ManagedFileError extends Error {
    constructor(readonly code: ManagedFileErrorCode) {
        super(code);
        this.name = 'ManagedFileError';
    }
}

function fail(code: ManagedFileErrorCode): never {
    throw new ManagedFileError(code);
}

function invalid(): never {
    return fail('managed-selector-invalid');
}

function fence(guard: Guard): void {
    try {
        if (guard() === true) {
            return;
        }
    } catch {
        // A throwing (or non-synchronous) guard is never permission.
    }

    fail('managed-file-stale');
}

function errno(error: unknown, code: string): boolean {
    return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}

function absolute(value: string): boolean {
    if (
        typeof value !== 'string' ||
        value.length > 4096 ||
        !path.isAbsolute(value) ||
        value.includes('\0') ||
        value.endsWith('/') ||
        path.normalize(value) !== value
    ) {
        return false;
    }

    // Node replaces lone UTF-16 surrogates when encoding a path; do not admit such aliases.
    const encoded = Buffer.from(value);
    return encoded.length < 4096 && encoded.toString('utf8') === value;
}

function sameNode(a: BigIntStats, b: BigIntStats): boolean {
    return a.dev === b.dev && a.ino === b.ino;
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
    return (
        sameNode(a, b) && a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs
    );
}

function trustedDirectory(stat: BigIntStats, uid: bigint, leaf: boolean): void {
    if (
        !stat.isDirectory() ||
        stat.nlink < 1n ||
        (stat.uid !== 0n && stat.uid !== uid) ||
        (stat.mode & 0o022n) !== 0n ||
        (leaf && (stat.uid !== uid || (stat.mode & 0o7777n) !== 0o700n))
    ) {
        invalid();
    }
}

function privateFile(stat: BigIntStats, uid: bigint, limit: number): void {
    if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        stat.uid !== uid ||
        (stat.mode & 0o7777n) !== 0o600n ||
        stat.size < 1n ||
        stat.size > BigInt(limit)
    ) {
        invalid();
    }
}

interface Parent {
    handle: FileHandle;
    file: string;
    uid: bigint;
    verify(): Promise<void>;
}

async function closeAll(handles: FileHandle[]): Promise<void> {
    const results = await Promise.allSettled(handles.map((handle) => handle.close()));

    if (results.some((result) => result.status === 'rejected')) {
        fail('managed-selector-io');
    }
}

/** Pin each component, including the final private directory. Never follow a configured symlink. */
async function withParent<T>(file: string, use: (parent: Parent) => Promise<T>): Promise<T> {
    if (process.platform !== 'linux' || !process.getuid) {
        fail('unsupported-platform');
    }

    if (!absolute(file)) {
        invalid();
    }

    const parts = file.slice(1).split('/');
    const basename = parts.pop()!;

    if (parts.length > 128) {
        invalid();
    }

    const uid = BigInt(process.getuid());
    const handles: FileHandle[] = [];
    const chain: { location: string; pinned: BigIntStats; leaf: boolean }[] = [];

    try {
        for (const [index, part] of ['/', ...parts].entries()) {
            const prev = handles.at(-1);
            const location = prev ? `/proc/self/fd/${prev.fd}/${part}` : '/';
            const leaf = index === parts.length;
            const named = await lstat(location, BIG);
            trustedDirectory(named, uid, leaf);
            const handle = await open(location, READ_FLAGS | constants.O_DIRECTORY);
            handles.push(handle);
            const pinned = await handle.stat(BIG);
            trustedDirectory(pinned, uid, leaf);

            if (!sameNode(pinned, named)) {
                invalid();
            }

            chain.push({ location, pinned, leaf });
        }

        const verify = async () => {
            for (const { location, pinned, leaf } of chain) {
                const named = await lstat(location, BIG);
                trustedDirectory(named, uid, leaf);

                if (!sameNode(pinned, named)) {
                    invalid();
                }
            }
        };

        const handle = handles.at(-1)!;
        const result = await use({
            uid,
            handle,
            file: `/proc/self/fd/${handle.fd}/${basename}`,
            verify,
        });
        await verify();
        return result;
    } finally {
        await closeAll(handles);
    }
}

/** Only an absent *leaf* at initial lookup is a miss. A vanished open file is an error. */
async function readPrivate<T>(
    parent: Parent,
    limit: number,
    consume: (bytes: Buffer) => T,
    guard?: Guard,
    durable = false,
): Promise<T | null> {
    let named: BigIntStats;

    try {
        named = await lstat(parent.file, BIG);
    } catch (error) {
        if (errno(error, 'ENOENT')) {
            return null;
        }

        throw error;
    }

    // Publication uses link + immediate unlink; another process may observe the two names in between.
    // Re-stat once, never read while a hard link actually exists.
    if (limit === SELECTOR_LIMIT && named.nlink === 2n) {
        named = await lstat(parent.file, BIG);
    }

    privateFile(named, parent.uid, limit);
    const handle = await open(parent.file, READ_FLAGS);
    let bytes: Buffer | undefined;

    try {
        const pinned = await handle.stat(BIG);
        privateFile(pinned, parent.uid, limit);

        if (!sameFile(named, pinned)) {
            invalid();
        }

        if (guard) {
            fence(guard);
        }

        bytes = Buffer.alloc(Number(pinned.size));
        let offset = 0;

        while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);

            if (bytesRead <= 0) {
                invalid();
            }

            offset += bytesRead;
        }

        const result = consume(bytes);

        if (durable) {
            await handle.sync();
            await parent.handle.sync();
        }

        for (const current of [await handle.stat(BIG), await lstat(parent.file, BIG)]) {
            privateFile(current, parent.uid, limit);

            if (!sameFile(pinned, current)) {
                invalid();
            }
        }

        return result;
    } finally {
        bytes?.fill(0);
        await handle.close();
    }
}

function canonicalUin(value: unknown): string {
    if (
        typeof value !== 'string' ||
        !/^[1-9][0-9]{0,9}$/.test(value) ||
        Number(value) > 0xffff_ffff
    ) {
        invalid();
    }

    return value;
}

function parseSelector(bytes: Buffer): string {
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const record: unknown = JSON.parse(text);

        // This flat two-field schema has exactly one comma. JSON.parse alone hides duplicate keys.
        if (
            !record ||
            typeof record !== 'object' ||
            Object.keys(record).length !== 2 ||
            !Object.hasOwn(record, 'version') ||
            !('version' in record) ||
            record.version !== 1 ||
            !Object.hasOwn(record, 'uin') ||
            !('uin' in record) ||
            text.indexOf(',') !== text.lastIndexOf(',')
        ) {
            invalid();
        }

        return canonicalUin(record.uin);
    } catch {
        return invalid();
    }
}

function selectorError(error: unknown): ManagedFileError {
    return error instanceof ManagedFileError ? error : new ManagedFileError('managed-selector-io');
}

export async function readManagedSelector(selectorFile: string): Promise<string | null> {
    try {
        return await withParent(selectorFile, (dir) =>
            readPrivate(dir, SELECTOR_LIMIT, parseSelector),
        );
    } catch (error) {
        throw selectorError(error);
    }
}

/** A successful same-UIN save never replaces even the original formatting or inode. */
export async function saveManagedSelector(
    selectorFile: string,
    uin: string,
    guard: Guard,
): Promise<void> {
    let published = false;

    try {
        canonicalUin(uin);
        fence(guard);
        await withParent(selectorFile, async (dir) => {
            const existing = () =>
                readPrivate(
                    dir,
                    SELECTOR_LIMIT,
                    (bytes) => {
                        if (parseSelector(bytes) !== uin) {
                            fail('managed-selector-conflict');
                        }

                        return true;
                    },
                    guard,
                    true,
                );

            if (await existing()) {
                return;
            }

            const tmp = `/proc/self/fd/${dir.handle.fd}/.managed-selector-${randomBytes(16).toString('hex')}.tmp`;
            await dir.verify();
            fence(guard);
            const handle = await open(tmp, CREATE_FLAGS, 0o600);

            try {
                // O_EXCL is the sole source of cleanup ownership; never clean an existing temp file.
                const identity = await handle.stat(BIG);
                let complete: BigIntStats;

                try {
                    const body = JSON.stringify({ version: 1, uin }) + '\n';
                    await handle.writeFile(body);
                    await handle.sync();
                    complete = await handle.stat(BIG);
                    privateFile(complete, dir.uid, SELECTOR_LIMIT);

                    if (complete.size !== BigInt(body.length)) {
                        invalid();
                    }

                    await dir.verify();
                    fence(guard);

                    if (!sameFile(complete, lstatSync(tmp, BIG))) {
                        invalid();
                    }

                    // link(2) publishes all bytes at once and never replaces a racing winner.
                    // Keep the two short namespace syscalls in one JS turn; no async guard gap.
                    try {
                        linkSync(tmp, dir.file);
                        published = true;
                    } catch (error) {
                        if (!errno(error, 'EEXIST')) {
                            throw error;
                        }
                    }
                } finally {
                    if (!sameNode(identity, lstatSync(tmp, BIG))) {
                        invalid();
                    }

                    unlinkSync(tmp);
                }

                if (published) {
                    // Link/unlink changes ctime, not the contents' length or modification time.
                    const linked = await handle.stat(BIG);
                    await dir.handle.sync();
                    const target = await lstat(dir.file, BIG);
                    privateFile(target, dir.uid, SELECTOR_LIMIT);

                    if (
                        !sameFile(linked, target) ||
                        target.size !== complete.size ||
                        target.mtimeNs !== complete.mtimeNs
                    ) {
                        invalid();
                    }
                } else if (!(await existing())) {
                    fail('managed-selector-io');
                }
            } finally {
                await handle.close();
            }
        });
        fence(guard);
    } catch (error) {
        // Never roll back a published name, or tell the caller that no binding was made.
        if (published) {
            fail('managed-selector-commit-uncertain');
        }

        throw selectorError(error);
    }
}

function qrMime(bytes: Buffer): ImageMime | null {
    if (bytes.subarray(0, 8).equals(PNG)) {
        return 'image/png';
    }

    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg';
    }

    if (
        bytes.length >= 12 &&
        bytes.readUInt32BE(0) === 0x52494646 &&
        bytes.readUInt32BE(8) === 0x57454250
    ) {
        return 'image/webp';
    }

    return null;
}

/** Only for the server's current qr-ready event; a browser path is never an input.
 * The caller owns/wipes the snapshot. A path is not a creation handle: do not unlink it on stop. */
export async function readManagedQr(
    outDir: string,
    qrFile: string,
    guard: Guard,
): Promise<{ bytes: Uint8Array; contentType: ImageMime }> {
    let owned: Uint8Array | undefined;

    try {
        fence(guard);

        if (!absolute(outDir) || !absolute(qrFile) || path.dirname(qrFile) !== outDir) {
            fail('managed-qr-unavailable');
        }

        const name = /^qr-[0-9a-f]{24}\.(png|jpg|webp)$/.exec(path.basename(qrFile));

        if (!name) {
            fail('managed-qr-unavailable');
        }

        const result = await withParent(qrFile, (dir) =>
            readPrivate(
                dir,
                QR_LIMIT,
                (bytes) => {
                    const contentType = qrMime(bytes);
                    const expected = name[1] === 'jpg' ? 'image/jpeg' : `image/${name[1]}`;

                    if (contentType === null || contentType !== expected) {
                        fail('managed-qr-unavailable');
                    }

                    owned = new Uint8Array(bytes);
                    return { bytes: owned, contentType };
                },
                guard,
            ),
        );
        fence(guard);

        if (!result) {
            fail('managed-qr-unavailable');
        }

        return result;
    } catch (error) {
        owned?.fill(0);

        if (
            error instanceof ManagedFileError &&
            (error.code === 'managed-file-stale' || error.code === 'unsupported-platform')
        ) {
            throw error;
        }

        fail('managed-qr-unavailable');
    }
}
