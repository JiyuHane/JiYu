import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { DirectLoginError } from './errors';

async function privateFile(file: string): Promise<void> {
    const stat = await lstat(file);

    if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    ) {
        throw new DirectLoginError('private-state');
    }
}

function parseDeviceGuid(text: string): Uint8Array {
    const record: unknown = JSON.parse(text);

    if (
        !record ||
        typeof record !== 'object' ||
        !('version' in record) ||
        record.version !== 1 ||
        !('guid' in record) ||
        typeof record.guid !== 'string' ||
        !/^[a-f0-9]{32}$/.test(record.guid) ||
        Object.keys(record).length !== 2
    ) {
        throw new DirectLoginError('private-state');
    }

    return Buffer.from(record.guid, 'hex');
}

interface GuidParent {
    name: string;
    handle: FileHandle;
    stat: Stats;
}

function trustedGuidParent(stat: Stats, uid: number): void {
    if (
        !stat.isDirectory() ||
        stat.nlink < 1 ||
        (stat.uid !== 0 && stat.uid !== uid) ||
        (stat.mode & 0o022) !== 0
    ) {
        throw new DirectLoginError('private-state');
    }
}

/** Linux fd-relative traversal also protects against replacing an ancestor after lstat. */
async function openGuidParents(statePath: string, handles: FileHandle[]): Promise<GuidParent[]> {
    const uid = process.getuid?.();

    if (uid === undefined || !path.isAbsolute(statePath) || statePath.length > 8192) {
        throw new DirectLoginError('private-state');
    }

    const root = path.parse(statePath).root;
    const parts = path.relative(root, path.dirname(statePath)).split(path.sep).filter(Boolean);

    if (parts.length > 128) {
        throw new DirectLoginError('private-state');
    }

    const parents: GuidParent[] = [];
    let name = root;
    let previous: FileHandle | undefined;

    for (const part of [root, ...parts]) {
        const location = previous ? `/proc/self/fd/${previous.fd}/${part}` : root;

        if (previous) {
            name = path.join(name, part);
        }

        const handle = await open(
            location,
            constants.O_RDONLY |
                constants.O_DIRECTORY |
                constants.O_NOFOLLOW |
                constants.O_NONBLOCK,
        );
        handles.push(handle);
        const stat = await handle.stat();
        const named = await lstat(name);
        trustedGuidParent(stat, uid);

        if (named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino) {
            throw new DirectLoginError('private-state');
        }

        parents.push({ name, handle, stat });
        previous = handle;
    }

    return parents;
}

/** Restore never creates or replaces a missing device identity. */
export async function loadExistingDeviceGuid(statePath: string): Promise<Uint8Array> {
    const handles: FileHandle[] = [];
    const bytes = Buffer.alloc(1025);
    let parsed: Uint8Array | undefined;

    try {
        const parents =
            process.platform === 'linux' ? await openGuidParents(statePath, handles) : [];
        const parent = parents.at(-1);
        const location = parent
            ? `/proc/self/fd/${parent.handle.fd}/${path.basename(statePath)}`
            : statePath;
        await privateFile(location);
        const flags =
            process.platform === 'win32'
                ? constants.O_RDONLY
                : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
        const handle = await open(location, flags);
        handles.push(handle);
        const before = await handle.stat();

        if (
            !before.isFile() ||
            before.nlink !== 1 ||
            before.size > 1024 ||
            (process.platform !== 'win32' &&
                (before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0))
        ) {
            throw new DirectLoginError('private-state');
        }

        let length = 0;

        while (length < bytes.length) {
            const part = await handle.read(bytes, length, bytes.length - length, length);

            if (part.bytesRead === 0) {
                break;
            }

            length += part.bytesRead;
        }

        const after = await handle.stat();
        const named = await lstat(location);

        if (
            length > 1024 ||
            length !== before.size ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.nlink !== 1 ||
            named.isSymbolicLink() ||
            named.dev !== before.dev ||
            named.ino !== before.ino ||
            (process.platform !== 'win32' &&
                (after.uid !== before.uid || (after.mode & 0o077) !== 0))
        ) {
            throw new DirectLoginError('private-state');
        }

        for (const entry of parents) {
            const current = await entry.handle.stat();
            const namedParent = await lstat(entry.name);
            trustedGuidParent(current, process.getuid!());

            if (
                namedParent.isSymbolicLink() ||
                current.dev !== entry.stat.dev ||
                current.ino !== entry.stat.ino ||
                namedParent.dev !== current.dev ||
                namedParent.ino !== current.ino
            ) {
                throw new DirectLoginError('private-state');
            }
        }

        parsed = parseDeviceGuid(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)),
        );
        const closed = await Promise.allSettled(handles.map((handle) => handle.close()));

        if (closed.some((result) => result.status === 'rejected')) {
            throw new DirectLoginError('private-state');
        }

        handles.length = 0;
        const result = parsed;
        parsed = undefined;
        return result;
    } catch {
        throw new DirectLoginError('private-state');
    } finally {
        parsed?.fill(0);
        bytes.fill(0);
        await Promise.allSettled(handles.map((handle) => handle.close()));
    }
}

/** The state is only a device GUID; never tickets, QR signatures or a login account. */
export async function loadDeviceGuid(statePath: string): Promise<Uint8Array> {
    try {
        await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
        let handle;

        try {
            handle = await open(statePath, 'wx', 0o600);
        } catch (error) {
            if (!(
                error &&
                typeof error === 'object' &&
                'code' in error &&
                error.code === 'EEXIST'
            )) {
                throw error;
            }
        }

        if (handle) {
            const guid = randomBytes(16);

            try {
                await handle.writeFile(
                    JSON.stringify({ version: 1, guid: guid.toString('hex') }) + '\n',
                );
                await handle.sync();
            } finally {
                await handle.close();
                guid.fill(0);
            }
        }

        await privateFile(statePath);
        const bytes = await readFile(statePath);

        if (bytes.length > 1024) {
            throw new DirectLoginError('private-state');
        }

        return parseDeviceGuid(bytes.toString('utf8'));
    } catch {
        throw new DirectLoginError('private-state');
    }
}

export async function prepareQrDirectory(outDir: string): Promise<void> {
    try {
        await mkdir(outDir, { recursive: true, mode: 0o700 });
        const stat = await lstat(outDir);

        if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
        ) {
            throw new Error();
        }
    } catch {
        throw new DirectLoginError('private-qr-directory');
    }
}

export async function saveQrImage(outDir: string, image: Uint8Array): Promise<string> {
    if (image.length < 8 || image.length > 1024 * 1024) {
        throw new DirectLoginError('qr-image');
    }

    const bytes = Buffer.from(image);

    try {
        const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
        const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

        if (!png && !jpeg) {
            throw new DirectLoginError('qr-image');
        }

        const file = path.join(
            outDir,
            `qr-${randomBytes(12).toString('hex')}.${png ? 'png' : 'jpg'}`,
        );
        await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
        return file;
    } finally {
        bytes.fill(0);
    }
}
