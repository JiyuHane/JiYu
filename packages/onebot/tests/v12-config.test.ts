import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    assertValidOneBotConfig,
    loadOneBotConfig,
    makeDefaultOneBotConfig,
    prepareOneBotConfigForRestore,
    saveOneBotConfig,
} from '../src/config';

const v12 = {
    enabled: true,
    host: '127.0.0.1',
    port: 3012,
    accessToken: 'E5xqVb7_9pLt2QwR4M8kZ1nY',
    allowNonLoopback: false,
};

describe('per-account v12 config', () => {
    let cwd: string;
    let dir: string;

    beforeEach(() => {
        cwd = process.cwd();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiyu-v12-config-'));
        process.chdir(dir);
    });

    afterEach(() => {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('leaves old and new default configurations disabled', () => {
        expect(makeDefaultOneBotConfig().v12).toBeUndefined();
        expect(loadOneBotConfig('10001').v12).toBeUndefined();
    });

    it('round trips a snapshot and preserves disabled explicit configuration', () => {
        const config = makeDefaultOneBotConfig();
        config.v12 = { ...v12 };
        saveOneBotConfig('10001', config);
        expect(loadOneBotConfig('10001').v12).toEqual(v12);
        config.v12.enabled = false;
        saveOneBotConfig('10001', config);
        expect(loadOneBotConfig('10001').v12).toEqual({ ...v12, enabled: false });
    });

    it('restores an overlay without inheriting a global listener or token', () => {
        const global = {
            networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
        };
        const account = { mode: 'overlay', v12 };
        const result = prepareOneBotConfigForRestore(account, 'per-uin', global);
        expect(result.value.v12).toEqual(v12);
        expect(() => prepareOneBotConfigForRestore({ ...global, v12 }, 'global')).toThrow(
            /per-account/,
        );
        expect(() => prepareOneBotConfigForRestore(account, 'per-uin', { ...global, v12 })).toThrow(
            /per-account/,
        );
        fs.mkdirSync('config');
        fs.writeFileSync('config/onebot.json', JSON.stringify({ ...global, v12 }));
        expect(() => loadOneBotConfig('10001')).toThrow(/per-account/);
    });

    it('rejects unknown fields, invalid addresses, ports, tokens and disabled auth', () => {
        for (const patch of [
            { version: 12 },
            { path: '/v12' },
            { tls: true },
            { host: '' },
            { port: 0 },
            { port: 65536 },
            { port: 1.5 },
            { accessToken: '' },
            { accessToken: '********' },
            { enabled: false, accessToken: '********' },
            { accessToken: 'bad token' },
            { host: '0.0.0.0', allowNonLoopback: false },
        ]) {
            const config = makeDefaultOneBotConfig();
            config.v12 = { ...v12, ...patch };
            expect(() => assertValidOneBotConfig(config), JSON.stringify(patch)).toThrow();
            expect(
                () => prepareOneBotConfigForRestore({ v12: config.v12 }, 'per-uin'),
                JSON.stringify(patch),
            ).toThrow();
        }
    });

    it('rejects the reserved name before save or restore only while v12 is enabled', () => {
        const config = makeDefaultOneBotConfig();
        config.v12 = { ...v12 };
        config.networks.httpServers[0].name = 'OneBot v12';
        expect(() => assertValidOneBotConfig(config)).toThrow(/OneBot v12/);
        expect(() => saveOneBotConfig('10001', config)).toThrow(/OneBot v12/);
        expect(fs.existsSync('config/onebot_10001.json')).toBe(false);
        const existing = makeDefaultOneBotConfig();
        saveOneBotConfig('10001', existing);
        const saved = fs.readFileSync('config/onebot_10001.json', 'utf8');
        expect(() => saveOneBotConfig('10001', config)).toThrow(/OneBot v12/);
        expect(fs.readFileSync('config/onebot_10001.json', 'utf8')).toBe(saved);
        expect(() => prepareOneBotConfigForRestore(config, 'per-uin')).toThrow(/OneBot v12/);
        config.networks.httpServers[0].enabled = false;
        expect(() => assertValidOneBotConfig(config)).toThrow(/OneBot v12/);
        config.v12.enabled = false;
        expect(() => assertValidOneBotConfig(config)).not.toThrow();
        saveOneBotConfig('10001', config);
        expect(loadOneBotConfig('10001').networks.httpServers[0].name).toBe('OneBot v12');
    });

    it('requires explicit opt-in for non-loopback and rejects v11 listener port collisions', () => {
        const config = makeDefaultOneBotConfig();
        config.v12 = { ...v12, host: '0.0.0.0', allowNonLoopback: true };
        expect(() => assertValidOneBotConfig(config)).not.toThrow();
        config.v12.port = config.networks.httpServers[0].port;
        expect(() => assertValidOneBotConfig(config)).toThrow(/conflicts/);
        config.networks.httpServers[0].enabled = false;
        expect(() => assertValidOneBotConfig(config)).not.toThrow();
    });
});
