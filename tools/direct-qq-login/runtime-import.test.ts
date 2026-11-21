import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import example from './config.example.json';

// This suite imports cold leaf modules. Any runtime filesystem, process, network,
// random-session initialization or application bootstrap is a failure, not a fake success.
const effects = vi.hoisted(() => [] as string[]);
const unexpected = vi.hoisted(() => (operation: string): never => {
    effects.push(operation);
    throw new Error(`unexpected import effect: ${operation}`);
});
vi.mock('../../packages/core/src/index.ts', () => unexpected('core-main'));
vi.mock('../../packages/bridge/src/hook-manager.ts', () => unexpected('hook-manager'));
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    const blocked = Object.fromEntries(
        [
            'access',
            'chmod',
            'copyFile',
            'lstat',
            'mkdir',
            'open',
            'readFile',
            'readdir',
            'realpath',
            'rename',
            'rm',
            'stat',
            'unlink',
            'writeFile',
        ].map((name) => [name, () => unexpected(`fs/promises.${name}`)]),
    );
    const patched = { ...actual, ...blocked };
    return { ...patched, default: patched };
});
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const blocked = Object.fromEntries(
        [
            'accessSync',
            'chmodSync',
            'copyFileSync',
            'lstatSync',
            'mkdirSync',
            'openSync',
            'readFileSync',
            'readdirSync',
            'realpathSync',
            'renameSync',
            'rmSync',
            'statSync',
            'unlinkSync',
            'writeFileSync',
            'watch',
            'watchFile',
        ].map((name) => [name, () => unexpected(`fs.${name}`)]),
    );
    const patched = { ...actual, ...blocked };
    return { ...patched, default: patched };
});
vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    const blocked = Object.fromEntries(
        ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync'].map(
            (name) => [name, () => unexpected(`child_process.${name}`)],
        ),
    );
    const patched = { ...actual, ...blocked };
    return { ...patched, default: patched };
});
vi.mock('node:net', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:net')>();
    const patched = {
        ...actual,
        Socket: new Proxy(actual.Socket, { construct: () => unexpected('net.Socket') }),
        connect: () => unexpected('net.connect'),
        createConnection: () => unexpected('net.createConnection'),
        createServer: () => unexpected('net.createServer'),
    };
    return { ...patched, default: patched };
});
vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();
    return {
        ...actual,
        randomBytes: () => unexpected('crypto.randomBytes'),
        randomInt: () => unexpected('crypto.randomInt'),
    };
});

beforeEach(() => {
    effects.length = 0;
    vi.resetModules();
});

describe('Core direct-runtime leaf extraction', () => {
    it('cold-imports every compatibility entry without application, Hook, IO or session startup', async () => {
        const signals = ['SIGINT', 'SIGTERM'] as const;
        const listeners = signals.map((signal) => process.listenerCount(signal));
        const entries = [
            [
                'runner',
                await import('./runner'),
                await import('../../packages/core/src/direct/runner'),
            ],
            [
                'config',
                await import('./config'),
                await import('../../packages/core/src/direct/config'),
            ],
            [
                'connection',
                await import('./connection'),
                await import('../../packages/core/src/direct/connection'),
            ],
            [
                'policy',
                await import('./policy'),
                await import('../../packages/core/src/direct/policy'),
            ],
            [
                'errors',
                await import('./errors'),
                await import('../../packages/core/src/direct/errors'),
            ],
            [
                'private-files',
                await import('./private-files'),
                await import('../../packages/core/src/direct/private-files'),
            ],
            [
                'account-persistence',
                await import('./account-persistence'),
                await import('../../packages/core/src/direct/account-persistence'),
            ],
            [
                'account-vault',
                await import('./account-vault'),
                await import('../../packages/core/src/direct/account-vault'),
            ],
        ] as const;
        const expected: Record<string, string[]> = {
            runner: [
                'restoreDirectLogin',
                'startDirectLogin',
                'restoreManagedDirectLogin',
                'startManagedDirectLogin',
            ],
            config: ['MAX_ONLINE_HOLD_MS', 'REFERENCE_COMMIT', 'parseConfig', 'readConfig'],
            connection: ['ObservedConnection', 'WIRE_LIMIT', 'connectObserved', 'frameHash'],
            policy: ['LoginPolicy'],
            errors: ['DirectLoginError'],
            'private-files': [
                'loadDeviceGuid',
                'loadExistingDeviceGuid',
                'prepareQrDirectory',
                'saveQrImage',
            ],
            'account-persistence': [
                'createLoginPersistence',
                'persistedProfileDigest',
                'persistenceError',
                'snapshotPersistenceOptions',
                'snapshotRestoreOptions',
                'validateRestoredUin',
            ],
            'account-vault': [
                'ACCOUNT_VAULT_MAX_PAYLOAD_BYTES',
                'AccountVaultError',
                'openAccountVault',
            ],
        };
        const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));

        for (const [name, compatibility, owned] of entries) {
            expect(Object.keys(compatibility).sort()).toEqual([...expected[name]].sort());
            expect(Object.keys(owned).sort()).toEqual([...expected[name]].sort());

            for (const key of Object.keys(compatibility)) {
                expect(Reflect.get(compatibility, key)).toBe(Reflect.get(owned, key));
            }

            expect(require.resolve(`@snowluma/core/direct/${name}`)).toBe(
                fileURLToPath(
                    new URL(`../../packages/core/src/direct/${name}.ts`, import.meta.url),
                ),
            );
        }

        expect(effects).toEqual([]);
        expect(signals.map((signal) => process.listenerCount(signal))).toEqual(listeners);
    });

    it('preserves the pre-extraction public profile digest and explicit 15-minute maximum', async () => {
        const { parseConfig, MAX_ONLINE_HOLD_MS } = await import('./config');
        const { persistedProfileDigest } = await import('./account-persistence');
        const input = structuredClone(example);
        const config = parseConfig(input, process.cwd());
        expect(Buffer.from(persistedProfileDigest(config)).toString('hex')).toBe(
            'b10570e052b11e2ecc1b700dfbcb3816dbbf9584092574f585d6a3ec811136be',
        );
        expect(MAX_ONLINE_HOLD_MS).toBe(900000);
        expect(
            parseConfig({ ...input, onlineHoldMs: MAX_ONLINE_HOLD_MS }, process.cwd()).onlineHoldMs,
        ).toBe(MAX_ONLINE_HOLD_MS);
        expect(() =>
            parseConfig({ ...input, onlineHoldMs: MAX_ONLINE_HOLD_MS + 1 }, process.cwd()),
        ).toThrow('configuration');
        expect(effects).toEqual([]);
    });
});
