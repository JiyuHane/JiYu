import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { isProxy } from 'node:util/types';
import { parseConfig, type DirectLoginConfig } from './config';
import type { DirectAccountPersistenceOptions } from './account-persistence';

export const DIRECT_CONFIG_ENV = 'JIYU_DIRECT_QQ_CONFIG';
const MAX_CONFIG_BYTES = 256 * 1024;
const accountKeys = [
    'id',
    'label',
    'configFile',
    'selectorFile',
    'persistence',
    'autoRestore',
    'autoRenew',
] as const;

export interface ManagedAccountDefinition {
    readonly id: string;
    readonly label: string;
    readonly configFile: string;
    readonly selectorFile: string;
    readonly persistence: DirectAccountPersistenceOptions;
    readonly autoRestore: boolean;
    readonly autoRenew: boolean;
}

export interface ManagedAccountConfig extends ManagedAccountDefinition {
    readonly config: DirectLoginConfig;
}

export class ManagedDirectConfigError extends Error {
    constructor(
        readonly code:
            'managed-config-invalid' | 'managed-config-read' | 'managed-config-path-conflict',
    ) {
        super(code);
        this.name = 'ManagedDirectConfigError';
    }
}

function invalid(): never {
    throw new ManagedDirectConfigError('managed-config-invalid');
}

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!input || typeof input !== 'object' || isProxy(input)) {
        invalid();
    }

    const proto = Object.getPrototypeOf(input) as unknown;
    const names = Reflect.ownKeys(input);

    if ((proto !== Object.prototype && proto !== null) || names.length !== keys.length) {
        invalid();
    }

    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const name of names) {
        const property = Object.getOwnPropertyDescriptor(input, name);

        if (
            typeof name !== 'string' ||
            !keys.includes(name) ||
            !property ||
            !('value' in property)
        ) {
            invalid();
        }

        result[name] = property.value;
    }

    return result;
}

function string(input: unknown, max: number): string {
    if (
        typeof input !== 'string' ||
        !input.trim() ||
        input.length > max ||
        Array.from(input).some((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127;
        })
    ) {
        invalid();
    }

    return input;
}

function absolute(input: unknown): string {
    const value = string(input, 8192);

    if (!path.isAbsolute(value)) {
        invalid();
    }

    return path.resolve(value);
}

function bool(input: unknown): boolean {
    if (typeof input !== 'boolean') {
        invalid();
    }

    return input;
}

/** Pure, strict snapshot. Browser requests never reach this parser. */
export function parseManagedDirectConfig(input: unknown): ManagedAccountDefinition[] {
    const root = record(input, ['version', 'accounts']);

    if (
        root.version !== 1 ||
        !Array.isArray(root.accounts) ||
        isProxy(root.accounts) ||
        root.accounts.length > 32
    ) {
        invalid();
    }

    const accounts = root.accounts;

    if (Reflect.ownKeys(accounts).length !== accounts.length + 1) {
        invalid();
    }

    const ids = new Set<string>();
    const result: ManagedAccountDefinition[] = [];

    for (let index = 0; index < accounts.length; index++) {
        const item = Object.getOwnPropertyDescriptor(accounts, String(index));

        if (!item || !('value' in item)) {
            invalid();
        }

        const account = record(item.value, accountKeys);
        const id = string(account.id, 48);

        if (!/^[a-z][a-z0-9-]{0,47}$/.test(id) || ids.has(id)) {
            invalid();
        }

        ids.add(id);
        const storage = record(account.persistence, ['vaultRoot', 'keyRoot', 'slotId']);
        const slotId = string(storage.slotId, 32);

        if (!/^[0-9a-f]{32}$/.test(slotId)) {
            invalid();
        }

        result.push({
            id,
            label: string(account.label, 80),
            configFile: absolute(account.configFile),
            selectorFile: absolute(account.selectorFile),
            persistence: {
                vaultRoot: absolute(storage.vaultRoot),
                keyRoot: absolute(storage.keyRoot),
                slotId,
            },
            autoRestore: bool(account.autoRestore),
            autoRenew: bool(account.autoRenew),
        });
    }

    assertManagedPathIsolation(result);
    return result;
}

function canonical(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function contains(directory: string, target: string): boolean {
    const relative = path.relative(canonical(directory), canonical(target));
    return (
        relative === '' ||
        (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
}

/** Cross-account writable aliases are rejected before any signer or socket opens.
 * The underlying vault/GUID IO independently rejects symlinks and untrusted
 * ancestors; lexical isolation is not a replacement for those fd-level checks. */
export function assertManagedPathIsolation(
    accounts: readonly ManagedAccountDefinition[],
    configs?: readonly DirectLoginConfig[],
    sourceFile?: string,
): void {
    if (configs && configs.length !== accounts.length) {
        invalid();
    }

    const files: { owner: number; path: string; writable: boolean }[] = [];
    const directories: { owner: number; path: string }[] = [];

    accounts.forEach((account, index) => {
        const { vaultRoot, keyRoot } = account.persistence;

        if (contains(vaultRoot, keyRoot) || contains(keyRoot, vaultRoot)) {
            throw new ManagedDirectConfigError('managed-config-path-conflict');
        }

        directories.push({ owner: index, path: vaultRoot }, { owner: index, path: keyRoot });
        files.push(
            { owner: index, path: account.configFile, writable: false },
            { owner: index, path: account.selectorFile, writable: true },
        );
        const config = configs?.[index];

        if (config) {
            files.push({ owner: index, path: config.statePath, writable: true });
            directories.push({ owner: index, path: config.outDir });
        }
    });

    if (sourceFile) {
        files.push({ owner: -1, path: sourceFile, writable: false });
    }

    const conflict = () => {
        throw new ManagedDirectConfigError('managed-config-path-conflict');
    };

    for (let i = 0; i < files.length; i++) {
        const a = files[i]!;

        for (const b of files.slice(i + 1)) {
            if (canonical(a.path) === canonical(b.path) && (a.writable || b.writable)) {
                conflict();
            }
        }
    }

    for (let i = 0; i < directories.length; i++) {
        const a = directories[i]!;

        for (const b of directories.slice(i + 1)) {
            if (a.owner !== b.owner && (contains(a.path, b.path) || contains(b.path, a.path))) {
                conflict();
            }
        }

        for (const file of files) {
            if (
                canonical(a.path) === canonical(file.path) ||
                (a.owner !== file.owner && contains(a.path, file.path))
            ) {
                conflict();
            }
        }
    }
}

async function readJson(file: string, limit: number): Promise<unknown> {
    const bytes = Buffer.alloc(limit + 1);
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
        handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const info = await handle.stat();

        if (!info.isFile() || info.size === 0 || info.size > limit || info.nlink !== 1) {
            invalid();
        }

        if (
            process.platform === 'linux' &&
            ((info.mode & 0o022) !== 0 || (info.uid !== process.getuid!() && info.uid !== 0))
        ) {
            invalid();
        }

        let used = 0;

        while (used < bytes.length) {
            const read = await handle.read(bytes, used, bytes.length - used, used);

            if (read.bytesRead === 0) {
                break;
            }

            used += read.bytesRead;
        }

        if (used > limit) {
            invalid();
        }

        return JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)),
        ) as unknown;
    } finally {
        bytes.fill(0);
        await handle?.close();
    }
}

export async function loadManagedDirectConfig(file: string): Promise<ManagedAccountConfig[]> {
    try {
        const sourceFile = absolute(file);
        const accounts = parseManagedDirectConfig(await readJson(sourceFile, MAX_CONFIG_BYTES));
        const result: ManagedAccountConfig[] = [];

        for (const account of accounts) {
            const config = parseConfig(
                await readJson(account.configFile, 65536),
                path.dirname(account.configFile),
            );
            result.push({ ...account, config });
        }

        assertManagedPathIsolation(
            accounts,
            result.map((account) => account.config),
            sourceFile,
        );
        return result;
    } catch (error) {
        if (error instanceof ManagedDirectConfigError) {
            throw error;
        }

        throw new ManagedDirectConfigError('managed-config-read');
    }
}
