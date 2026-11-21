import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    snapshotPersistenceOptions,
    snapshotRestoreOptions,
    type DirectAccountPersistenceOptions,
    type DirectAccountRestoreOptions,
} from './account-persistence';
import { readConfig } from './config';
import { DirectLoginError } from './errors';
import { restoreDirectLogin, startDirectLogin, type LoginEvent } from './runner';

export { readConfig, startDirectLogin, restoreDirectLogin };
export type {
    DirectAccountPersistenceOptions,
    DirectAccountRestoreOptions,
    DirectLoginController,
    DirectRestoredLoginController,
    DirectLoginPushOptions,
    LoginEvent,
} from './runner';

const usage =
    'Usage: node runner.mjs --config PRIVATE_JSON [--close-after-register]\n' +
    '  Save:    --save-account --account-vault ABS_DIR --account-keys ABS_DIR --account-slot HEX32\n' +
    '  Restore: --restore-account UIN --account-vault ABS_DIR --account-keys ABS_DIR --account-slot HEX32\n';

type CliLoginMode =
    | { kind: 'qr'; persistence?: DirectAccountPersistenceOptions }
    | { kind: 'restore'; options: DirectAccountRestoreOptions };

export interface DirectCliOptions {
    configPath: string;
    closeAfter: boolean;
    mode: CliLoginMode;
}

/** Parsing is side-effect free; a stored file never implicitly enables persistence. */
export function parseCliOptions(args: readonly string[]): DirectCliOptions {
    const fail = (): never => {
        throw new DirectLoginError('cli-arguments');
    };

    if (
        args.length < 2 ||
        args.length > 16 ||
        args[0] !== '--config' ||
        !args[1] ||
        args[1].startsWith('--')
    ) {
        fail();
    }

    let closeAfter = false;
    let save = false;
    let restore: string | undefined;
    let vaultRoot: string | undefined;
    let keyRoot: string | undefined;
    let slotId: string | undefined;
    const seen = new Set<string>();

    for (let index = 2; index < args.length; index++) {
        const flag = args[index];

        if (seen.has(flag)) {
            fail();
        }

        seen.add(flag);

        if (flag === '--close-after-register') {
            closeAfter = true;
            continue;
        }

        if (flag === '--save-account') {
            save = true;
            continue;
        }

        if (
            !['--restore-account', '--account-vault', '--account-keys', '--account-slot'].includes(
                flag,
            )
        ) {
            fail();
        }

        const value = args[++index];

        if (!value || value.startsWith('--')) {
            fail();
        }

        if (flag === '--restore-account') {
            restore = value;
        } else if (flag === '--account-vault') {
            vaultRoot = value;
        } else if (flag === '--account-keys') {
            keyRoot = value;
        } else {
            slotId = value;
        }
    }

    if (save && restore !== undefined) {
        fail();
    }

    const selected = save || restore !== undefined;
    const anyPath = vaultRoot !== undefined || keyRoot !== undefined || slotId !== undefined;

    if (selected ? !vaultRoot || !keyRoot || !slotId : anyPath) {
        fail();
    }

    let mode: CliLoginMode = { kind: 'qr' };

    if (restore !== undefined) {
        mode = {
            kind: 'restore',
            options: snapshotRestoreOptions({ vaultRoot, keyRoot, slotId, uin: restore }),
        };
    } else if (save) {
        mode = {
            kind: 'qr',
            persistence: snapshotPersistenceOptions({ vaultRoot, keyRoot, slotId }),
        };
    }

    return { configPath: args[1], closeAfter, mode };
}

export async function main(args: readonly string[]): Promise<number> {
    if (args.length === 1 && args[0] === '--help') {
        process.stdout.write(
            'Jiyu direct QQ registration probe\n' +
                usage +
                'Persistence is Linux-only and opt-in. Restore performs new-connection registration without QR fallback.\n' +
                'No message is sent. Config onlineHoldMs is limited to 900000 without automatic heartbeat.\n',
        );
        return 0;
    }

    let options: DirectCliOptions;

    try {
        options = parseCliOptions(args);
    } catch {
        process.stderr.write(usage);
        return 2;
    }

    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    try {
        const config = await readConfig(options.configPath);

        if (options.closeAfter) {
            config.onlineHoldMs = 0;
        }

        const onEvent = (event: LoginEvent) => {
            process.stdout.write(JSON.stringify(event) + '\n');
        };

        const session =
            options.mode.kind === 'restore'
                ? await restoreDirectLogin(config, options.mode.options, onEvent, controller.signal)
                : await startDirectLogin(
                      config,
                      onEvent,
                      controller.signal,
                      undefined,
                      options.mode.persistence,
                  );

        if (options.closeAfter) {
            await session.close();
        } else {
            await session.whenClosed;
        }

        return 0;
    } catch {
        // Detail comes only from the runner's fixed, redacted state events.
        process.stderr.write(
            'Direct login did not complete; inspect the redacted state or configuration.\n',
        );
        return 1;
    } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    });
}
