import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { LocalQqSignWorker } from '@snowluma/protocol/direct/local-qq-sign-worker';
import type { ObservedConnection } from '../src/direct/connection';
import { readConfig, type DirectLoginConfig } from '../src/direct/config';
import { LoginPolicy } from '../src/direct/policy';

const KEY_EXCHANGE = 'trpc.login.ecdh.EcdhService.SsoKeyExchange';
const TICKET_REFRESH = 'trpc.login.ecdh.EcdhService.SsoNTLoginRefreshTicket';

let config: DirectLoginConfig;

beforeAll(async () => {
    config = await readConfig(
        path.resolve(process.cwd(), '../../tools/direct-qq-login/config.example.json'),
    );
});

function fixture(command: string) {
    const sign = vi.fn(async () => ({
        sign: Uint8Array.of(1),
        token: Uint8Array.of(2),
        extra: Uint8Array.of(3),
    }));
    const connection = { live: true } as unknown as ObservedConnection;
    const signer = { sign } as unknown as LocalQqSignWorker;
    const policy = new LoginPolicy(connection, signer, config);
    policy.initializeRestoredAccount('123456');
    const input = {
        uin: '123456',
        uid: 'u_fixture',
        command,
        sequence: 1,
        body: Uint8Array.of(4, 5, 6),
    };
    return { policy, input, sign };
}

describe('managed native renewal signing policy', () => {
    it.each([KEY_EXCHANGE, TICKET_REFRESH])(
        'signs the fixed %s command without changing the persisted config allowlist',
        async (command) => {
            expect(config.reserve.signCommands).not.toContain(command);
            const { policy, input, sign } = fixture(command);

            const reserved = await policy.buildRegisterReserved(input);

            expect(reserved.byteLength).toBeGreaterThan(0);
            expect(sign).toHaveBeenCalledTimes(1);
            expect(sign).toHaveBeenCalledWith(
                expect.objectContaining({
                    uin: input.uin,
                    command,
                    sequence: input.sequence,
                    body: input.body,
                }),
            );
            expect(config.reserve.signCommands).not.toContain(command);
        },
    );

    it('keeps an unrelated command unsigned when it is absent from the config list', async () => {
        const { policy, input, sign } = fixture('Synthetic.NotAllowed');

        const reserved = await policy.buildRegisterReserved(input);

        expect(reserved.byteLength).toBeGreaterThan(0);
        expect(sign).not.toHaveBeenCalled();
    });
});
