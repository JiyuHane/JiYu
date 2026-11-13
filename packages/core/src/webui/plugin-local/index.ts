import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_DIRECTORY_ENTRIES = 2048;
const MAX_PLUGINS = 512;
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
    'invalid_id' | 'not_found' | 'unsafe_path' | 'limit_exceeded' | 'io_error';

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

export interface LocalPluginCatalog {
    /** Sorted, bounded IDs only. Missing catalog means no entries. */
    list(): Promise<string[]>;
    /** Validates a single existing direct child; never loads it. */
    resolve(id: string): Promise<string>;
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

    return {
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
    };
}
