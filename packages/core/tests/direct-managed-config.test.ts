import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig, REFERENCE_COMMIT } from '../src/direct/config';
import {
    assertManagedPathIsolation,
    loadManagedDirectConfig,
    ManagedDirectConfigError,
    parseManagedDirectConfig,
} from '../src/direct/managed-config';

const root = path.resolve('synthetic-direct-config');

function definition(id = 'first') {
    const dir = path.join(root, id);
    return {
        id,
        label: `Fixture ${id}`,
        configFile: path.join(dir, 'runner.json'),
        selectorFile: path.join(dir, 'selector.json'),
        persistence: {
            vaultRoot: path.join(dir, 'vault'),
            keyRoot: path.join(dir, 'keys'),
            slotId: '12'.repeat(16),
        },
        autoRestore: false,
        autoRenew: true,
    };
}

function runner(dir: string) {
    const profile = {
        appId: 42,
        subAppId: 43,
        clientVersion: 44,
        currentVersion: 'fixture-version',
        packageName: 'p',
        ptVersion: 'pt',
        ssoVersion: 19,
        mainSigMap: 1,
        miscBitMap: 2,
        subSigMap: 3,
        sdkVersion: 'sdk',
        os: 'Linux',
        deviceName: 'fixture',
        deviceType: 'Linux',
        vendorOs: 'linux',
        apkSignatureHex: '0102',
        unknown21Hex: '00'.repeat(21),
        tlv124Hex: '00'.repeat(12),
        peerPublicKeyHex: `04${'11'.repeat(48)}`,
        qrCommand: 'fixture.qr',
        loginCommand: 'fixture.login',
    };
    return parseConfig(
        {
            version: 1,
            referenceCommit: REFERENCE_COMMIT,
            gateway: { host: '127.0.0.1', port: 9, family: 4 },
            signer: {
                executable: 'fixture-not-run',
                args: [],
                cwd: dir,
                initialUin: '0',
                expectedBuild: 'fixture',
                expectedSha256: '11'.repeat(32),
                startupTimeoutMs: 1000,
                requestTimeoutMs: 1000,
                maxPending: 1,
            },
            statePath: path.join(dir, 'device.json'),
            outDir: path.join(dir, 'qr'),
            attemptTimeoutMs: 10000,
            transactionTimeoutMs: 1000,
            connectTimeoutMs: 1000,
            onlineHoldMs: 900000,
            reserve: { msgType: null, ntCoreVersion: null, signCommands: [] },
            profile,
            provenance: Object.fromEntries(
                Object.keys(profile).map((key) => [key, 'local-policy']),
            ),
        },
        dir,
    );
}

const dirs: string[] = [];
afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function diskFixture() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jiyu-managed-config-'));
    dirs.push(dir);
    const entry = definition();
    entry.configFile = path.join(dir, 'runner.json');
    entry.selectorFile = path.join(dir, 'selector.json');
    entry.persistence.vaultRoot = path.join(dir, 'vault');
    entry.persistence.keyRoot = path.join(dir, 'keys');
    const config = runner(dir);
    const file = path.join(dir, 'managed.json');
    await writeFile(entry.configFile, JSON.stringify(config), { mode: 0o600 });
    await writeFile(file, JSON.stringify({ version: 1, accounts: [entry] }), { mode: 0o600 });
    return { dir, entry, config, file };
}

describe('managed direct account configuration', () => {
    it('loads an empty explicit configuration', () => {
        expect(parseManagedDirectConfig({ version: 1, accounts: [] })).toEqual([]);
    });

    it('snapshots two isolated entries without mutating caller data', () => {
        const first = definition();
        const second = definition('second');
        const value = parseManagedDirectConfig({ version: 1, accounts: [first, second] });
        first.label = 'changed';
        first.persistence.slotId = 'ff'.repeat(16);
        expect(value[0]!.label).toBe('Fixture first');
        expect(value[0]!.persistence.slotId).toBe('12'.repeat(16));
        expect(value[1]!.id).toBe('second');
    });

    it.each([
        undefined,
        null,
        [],
        {},
        { version: 2, accounts: [] },
        { version: 1, accounts: [], extra: true },
        { version: 1, accounts: new Array(1) },
        { version: 1, accounts: [definition(), definition()] },
        { version: 1, accounts: Array.from({ length: 33 }, (_, i) => definition(`a${i}`)) },
    ])('rejects invalid roots and arrays %j', (input) => {
        expect(() => parseManagedDirectConfig(input)).toThrow(ManagedDirectConfigError);
    });

    it.each([
        { id: '../bad' },
        { id: 'UpperCase' },
        { id: '' },
        { id: 'a'.repeat(49) },
        { label: 'bad\nlabel' },
        { label: '' },
        { label: '   ' },
        { label: 'x'.repeat(81) },
        { configFile: 'relative.json' },
        { selectorFile: 'relative.json' },
        { autoRestore: 1 },
        { autoRenew: 'true' },
        { extra: true },
    ])('rejects invalid account values %j', (patch) => {
        expect(() =>
            parseManagedDirectConfig({ version: 1, accounts: [{ ...definition(), ...patch }] }),
        ).toThrow(ManagedDirectConfigError);
    });

    it.each([
        { slotId: 'A'.repeat(32) },
        { slotId: '11' },
        { vaultRoot: 'relative' },
        { keyRoot: 'relative' },
        { extra: 'unknown' },
    ])('rejects invalid storage %j', (patch) => {
        const entry = definition();
        expect(() =>
            parseManagedDirectConfig({
                version: 1,
                accounts: [
                    {
                        ...entry,
                        persistence: { ...entry.persistence, ...patch },
                    },
                ],
            }),
        ).toThrow(ManagedDirectConfigError);
    });

    it('does not invoke getters or proxy traps', () => {
        const getter = vi.fn();
        const input = Object.defineProperty({ version: 1 }, 'accounts', { get: getter });
        expect(() => parseManagedDirectConfig(input)).toThrow(ManagedDirectConfigError);
        expect(getter).not.toHaveBeenCalled();
        const ownKeys = vi.fn();
        const proxy = new Proxy({}, { ownKeys });
        expect(() => parseManagedDirectConfig(proxy)).toThrow(ManagedDirectConfigError);
        expect(ownKeys).not.toHaveBeenCalled();
    });

    it('rejects shared and nested account directories', () => {
        for (const key of ['vaultRoot', 'keyRoot'] as const) {
            const first = definition();
            const second = definition('second');
            second.persistence[key] = first.persistence[key];
            expect(() =>
                parseManagedDirectConfig({ version: 1, accounts: [first, second] }),
            ).toThrow('managed-config-path-conflict');
            second.persistence[key] = path.join(first.persistence[key], 'nested');
            expect(() =>
                parseManagedDirectConfig({ version: 1, accounts: [first, second] }),
            ).toThrow('managed-config-path-conflict');
        }
    });

    it('rejects a key root inside the same account vault', () => {
        const entry = definition();
        entry.persistence.keyRoot = path.join(entry.persistence.vaultRoot, 'keys');
        expect(() => parseManagedDirectConfig({ version: 1, accounts: [entry] })).toThrow(
            'managed-config-path-conflict',
        );
    });

    it('rejects selectors that overwrite configs or belong to another account root', () => {
        const first = definition();
        first.selectorFile = first.configFile;
        expect(() => parseManagedDirectConfig({ version: 1, accounts: [first] })).toThrow(
            'managed-config-path-conflict',
        );
        first.selectorFile = path.join(definition('second').persistence.vaultRoot, 'selector.json');
        expect(() =>
            parseManagedDirectConfig({ version: 1, accounts: [first, definition('second')] }),
        ).toThrow('managed-config-path-conflict');
    });

    it('rejects shared GUIDs, nested QR outputs and the source-file overwrite', () => {
        const definitions = [definition(), definition('second')];
        const configs = definitions.map((entry) => runner(path.dirname(entry.configFile)));
        assertManagedPathIsolation(definitions, configs);
        configs[1]!.statePath = configs[0]!.statePath;
        expect(() => assertManagedPathIsolation(definitions, configs)).toThrow(
            'managed-config-path-conflict',
        );
        configs[1] = runner(path.dirname(definitions[1]!.configFile));
        configs[0]!.outDir = path.dirname(configs[1]!.statePath);
        expect(() => assertManagedPathIsolation(definitions, configs)).toThrow(
            'managed-config-path-conflict',
        );
        expect(() =>
            assertManagedPathIsolation(definitions, undefined, definitions[0]!.selectorFile),
        ).toThrow('managed-config-path-conflict');
    });

    it('reads real files without creating a selector, device, vault, QR or signer', async () => {
        const fixture = await diskFixture();
        const before = await readdir(fixture.dir);
        const result = await loadManagedDirectConfig(fixture.file);
        expect(result).toEqual([{ ...fixture.entry, config: fixture.config }]);
        expect(await readdir(fixture.dir)).toEqual(before);
        expect(result[0]!.config.onlineHoldMs).toBe(900000);
    });

    it('rejects overlarge and malformed files with fixed errors, without path leakage', async () => {
        const fixture = await diskFixture();

        for (const content of ['{', Buffer.from([0xff, 0xfe, 0xff]), ' '.repeat(256 * 1024 + 1)]) {
            await writeFile(fixture.file, content);
            const error: unknown = await loadManagedDirectConfig(fixture.file).catch(
                (value: unknown) => value,
            );
            expect(error).toBeInstanceOf(ManagedDirectConfigError);
            expect(String(error)).not.toContain(fixture.dir);
        }
    });

    it('validates the runner with the canonical legacy parser', async () => {
        const fixture = await diskFixture();
        const body = JSON.parse(await readFile(fixture.entry.configFile, 'utf8')) as Record<
            string,
            unknown
        >;
        body.onlineHoldMs = 900001;
        await writeFile(fixture.entry.configFile, JSON.stringify(body));
        await expect(loadManagedDirectConfig(fixture.file)).rejects.toThrow('managed-config-read');
    });

    it('rejects missing paths and directories without revealing filesystem errors', async () => {
        const fixture = await diskFixture();
        await expect(
            loadManagedDirectConfig(path.join(fixture.dir, 'missing.json')),
        ).rejects.toThrow('managed-config-read');
        const directory = path.join(fixture.dir, 'directory');
        await mkdir(directory);
        await expect(loadManagedDirectConfig(directory)).rejects.toBeInstanceOf(
            ManagedDirectConfigError,
        );
    });
});
