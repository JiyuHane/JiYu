import fs from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';

const MAX_DIRECTORY_ENTRIES = 2048;
const MAX_PLUGINS = 512;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MANIFEST_READS = 16;
let activeManifestReads = 0;
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SYSTEM_CODES = new Set([
    'ENOENT',
    'EACCES',
    'EPERM',
    'EMFILE',
    'ENFILE',
    'EIO',
    'ENOTDIR',
    'ELOOP',
    'ESTALE',
    'EBUSY',
    'ENOMEM',
    'EINVAL',
]);

export type LocalPluginCatalogErrorCode =
    | 'invalid_id'
    | 'not_found'
    | 'unsafe_path'
    | 'limit_exceeded'
    | 'io_error'
    | 'manifest_missing'
    | 'manifest_invalid'
    | 'manifest_too_large'
    | 'manifest_busy';

/** Stable, path-free errors for a caller to map to its own authenticated API. */
export class LocalPluginCatalogError extends Error {
    constructor(
        readonly code: LocalPluginCatalogErrorCode,
        readonly systemCode?: string,
    ) {
        super(`Local plugin catalog: ${code}`);
        this.name = 'LocalPluginCatalogError';
    }
}

function isId(value: unknown): value is string {
    return typeof value === 'string' && ID.test(value) && !WINDOWS_DEVICE.test(value);
}

function samePath(left: string, right: string): boolean {
    const a = path.normalize(left);
    const b = path.normalize(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return (
        relative !== '' &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
    );
}

function systemCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return undefined;
    }

    const code = error.code;
    return typeof code === 'string' && SYSTEM_CODES.has(code) ? code : undefined;
}

function wrap(error: unknown): never {
    if (error instanceof LocalPluginCatalogError) {
        throw error;
    }

    const code = systemCode(error);
    throw new LocalPluginCatalogError('io_error', code);
}

/**
 * Reject every existing symbolic-link/junction component, including ancestors.
 * An absent component is distinct from access errors or a non-directory.
 */
async function checkedDirectory(directory: string, missingIsNotFound = true): Promise<string> {
    const root = path.parse(directory).root;
    const relative = path.relative(root, directory);
    let current = root;
    const pieces = relative ? relative.split(path.sep) : [];

    for (const component of ['', ...pieces]) {
        if (component) {
            current = path.join(current, component);
        }

        let before;

        try {
            before = await fs.lstat(current);
        } catch (error) {
            if (missingIsNotFound && systemCode(error) === 'ENOENT') {
                throw new LocalPluginCatalogError('not_found', 'ENOENT');
            }

            throw error;
        }

        if (before.isSymbolicLink() || !before.isDirectory()) {
            throw new LocalPluginCatalogError('unsafe_path');
        }

        const real = await fs.realpath(current);
        const after = await fs.lstat(current);

        if (
            after.isSymbolicLink() ||
            !after.isDirectory() ||
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            !samePath(current, real)
        ) {
            throw new LocalPluginCatalogError('unsafe_path');
        }
    }

    return directory;
}

async function scanDirectory(base: string): Promise<{ ids: string[]; excluded: Set<string> }> {
    const entries = await fs.opendir(base);
    const ids: string[] = [];
    const excluded = new Set<string>();
    let seen = 0;

    for await (const entry of entries) {
        if (++seen > MAX_DIRECTORY_ENTRIES) {
            throw new LocalPluginCatalogError('limit_exceeded');
        }

        if (!isId(entry.name)) {
            continue;
        }

        const child = path.join(base, entry.name);
        const stat = await fs.lstat(child);

        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            excluded.add(entry.name);
            continue;
        }

        await checkedDirectory(child, false);
        ids.push(entry.name);

        if (ids.length > MAX_PLUGINS) {
            throw new LocalPluginCatalogError('limit_exceeded');
        }
    }

    await checkedDirectory(base, false);
    ids.sort();
    return { ids, excluded };
}

export interface LocalManifestPreview {
    declarations: { main: string | null; type: string | null };
    invalidFields: Array<'main' | 'type'>;
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
    // An unavailable inode cannot establish that a path still names the open object.
    return a.ino !== 0n && b.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
    return (
        sameIdentity(a, b) &&
        a.size === b.size &&
        a.mtimeNs === b.mtimeNs &&
        a.ctimeNs === b.ctimeNs
    );
}

export interface LocalPluginCatalog {
    /** Sorted, bounded IDs only. Missing catalog means no entries. */
    list(): Promise<string[]>;
    /** Validates a single existing direct child; never loads it. */
    resolve(id: string): Promise<string>;
    /** Optional for legacy catalog implementations; never executes plugin code. */
    previewManifest?(id: string): Promise<LocalManifestPreview>;
}

/**
 * Enumerates manually placed local packages, without importing or modifying them.
 * `baseDirectory` is a trusted host configuration, never a request parameter.
 * This validation is not a sandbox: filesystem entries can change during or
 * after validation (including case-only renames) before import, and enabled
 * plugins retain the host process privileges.
 */
export function createLocalPluginCatalog(
    options: { baseDirectory?: string } = {},
): LocalPluginCatalog {
    if (options.baseDirectory !== undefined && !path.isAbsolute(options.baseDirectory)) {
        throw new LocalPluginCatalogError('unsafe_path');
    }

    const base = path.resolve(
        options.baseDirectory ?? path.join(process.cwd(), 'data', 'plugin-packages'),
    );

    // UNC and device namespace paths can contact a remote host or bypass normal path handling.
    if (process.platform === 'win32' && base.startsWith('\\\\')) {
        throw new LocalPluginCatalogError('unsafe_path');
    }

    const catalog: LocalPluginCatalog = {
        async list(): Promise<string[]> {
            try {
                try {
                    await checkedDirectory(base);
                } catch (error) {
                    if (error instanceof LocalPluginCatalogError && error.code === 'not_found') {
                        return [];
                    }

                    throw error;
                }

                return (await scanDirectory(base)).ids;
            } catch (error) {
                return wrap(error);
            }
        },
        async resolve(id: string): Promise<string> {
            if (!isId(id)) {
                throw new LocalPluginCatalogError('invalid_id');
            }

            try {
                const child = path.resolve(base, id);

                if (!isInside(base, child) || path.dirname(child) !== base) {
                    throw new LocalPluginCatalogError('unsafe_path');
                }

                await checkedDirectory(base);
                // Match exact on-disk spelling and apply the same complete,
                // bounded candidate scan as list(), even if id appears first.
                const { ids, excluded } = await scanDirectory(base);

                if (excluded.has(id)) {
                    throw new LocalPluginCatalogError('unsafe_path');
                }

                if (!ids.includes(id)) {
                    throw new LocalPluginCatalogError('not_found');
                }

                await checkedDirectory(child, false);
                const [realBase, realChild] = await Promise.all([
                    fs.realpath(base),
                    fs.realpath(child),
                ]);

                if (
                    !samePath(base, realBase) ||
                    !samePath(child, realChild) ||
                    !isInside(realBase, realChild)
                ) {
                    throw new LocalPluginCatalogError('unsafe_path');
                }

                // Detect straightforward swaps during validation, not a later replacement.
                await checkedDirectory(child, false);
                return child;
            } catch (error) {
                return wrap(error);
            }
        },
        async previewManifest(id: string): Promise<LocalManifestPreview> {
            if (!isId(id)) {
                throw new LocalPluginCatalogError('invalid_id');
            }

            if (activeManifestReads >= MAX_MANIFEST_READS) {
                throw new LocalPluginCatalogError('manifest_busy');
            }

            activeManifestReads++;
            let releaseSlot = true;

            try {
                const expectedDirectory = path.join(base, id);
                await checkedDirectory(expectedDirectory);
                const parentBefore = await fs.lstat(expectedDirectory, { bigint: true });
                const directory = await catalog.resolve(id);
                const parentResolved = await fs.lstat(directory, { bigint: true });

                if (
                    !samePath(directory, expectedDirectory) ||
                    !sameIdentity(parentBefore, parentResolved) ||
                    !parentBefore.isDirectory() ||
                    parentBefore.isSymbolicLink() ||
                    parentBefore.ino === 0n ||
                    !parentResolved.isDirectory() ||
                    parentResolved.isSymbolicLink()
                ) {
                    throw new LocalPluginCatalogError('unsafe_path');
                }

                const manifest = path.join(directory, 'package.json');
                let before: BigIntStats;

                try {
                    before = await fs.lstat(manifest, { bigint: true });
                } catch (error) {
                    if (systemCode(error) === 'ENOENT') {
                        throw new LocalPluginCatalogError('manifest_missing');
                    }

                    throw error;
                }

                if (before.isSymbolicLink() || !before.isFile() || before.ino === 0n) {
                    throw new LocalPluginCatalogError('unsafe_path');
                }

                if (before.size > BigInt(MAX_MANIFEST_BYTES)) {
                    throw new LocalPluginCatalogError('manifest_too_large');
                }

                if (!samePath(await fs.realpath(manifest), manifest)) {
                    throw new LocalPluginCatalogError('unsafe_path');
                }

                const checked = await fs.lstat(manifest, { bigint: true });

                if (checked.isSymbolicLink() || !checked.isFile() || !sameFile(before, checked)) {
                    throw new LocalPluginCatalogError('unsafe_path');
                }

                const handle = await fs.open(
                    manifest,
                    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
                );
                releaseSlot = false;

                try {
                    const opened = await handle.stat({ bigint: true });

                    if (!opened.isFile() || !sameFile(before, opened)) {
                        throw new LocalPluginCatalogError('unsafe_path');
                    }

                    const bytes = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
                    let size = 0;

                    while (size < bytes.length) {
                        const part = await handle.read(bytes, size, bytes.length - size, size);

                        if (part.bytesRead === 0) {
                            break;
                        }

                        size += part.bytesRead;
                    }

                    if (size > MAX_MANIFEST_BYTES) {
                        throw new LocalPluginCatalogError('manifest_too_large');
                    }

                    const after = await handle.stat({ bigint: true });
                    const finalPath = await fs.lstat(manifest, { bigint: true });
                    await checkedDirectory(directory, false);
                    const parentAfter = await fs.lstat(directory, { bigint: true });

                    if (
                        !sameFile(opened, after) ||
                        BigInt(size) !== after.size ||
                        finalPath.isSymbolicLink() ||
                        !finalPath.isFile() ||
                        !sameFile(after, finalPath) ||
                        !samePath(await fs.realpath(manifest), manifest) ||
                        !parentAfter.isDirectory() ||
                        parentAfter.isSymbolicLink() ||
                        !sameIdentity(parentBefore, parentAfter)
                    ) {
                        throw new LocalPluginCatalogError('unsafe_path');
                    }

                    let value: unknown;

                    try {
                        value = JSON.parse(
                            new TextDecoder('utf-8', { fatal: true }).decode(
                                bytes.subarray(0, size),
                            ),
                        );
                    } catch {
                        throw new LocalPluginCatalogError('manifest_invalid');
                    }

                    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
                        throw new LocalPluginCatalogError('manifest_invalid');
                    }

                    const declarations: LocalManifestPreview['declarations'] = {
                        main: null,
                        type: null,
                    };
                    const invalidFields: LocalManifestPreview['invalidFields'] = [];

                    for (const field of ['main', 'type'] as const) {
                        if (!Object.hasOwn(value, field)) {
                            continue;
                        }

                        const entry = (value as Record<string, unknown>)[field];

                        if (
                            typeof entry !== 'string' ||
                            entry.length > 512 ||
                            path.posix.isAbsolute(entry.trimStart()) ||
                            path.win32.isAbsolute(entry.trimStart()) ||
                            Array.from(entry).some((character) => {
                                const code = character.charCodeAt(0);
                                return code < 32 || (code >= 127 && code <= 159);
                            })
                        ) {
                            invalidFields.push(field);
                        } else {
                            declarations[field] = entry;
                        }
                    }

                    return { declarations, invalidFields };
                } finally {
                    await handle.close();
                    releaseSlot = true;
                }
            } catch (error) {
                if (systemCode(error) === 'ELOOP') {
                    throw new LocalPluginCatalogError('unsafe_path');
                }

                return wrap(error);
            } finally {
                // A failed or unresolved close leaves the handle's fate unknown.
                if (releaseSlot) {
                    activeManifestReads--;
                }
            }
        },
    };
    return catalog;
}
