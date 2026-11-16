import { createECDH } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createLinuxEasyAccountOwner } from '../../src/direct/linux-easy-account-owner';
import type {
    Sso12CloseReason,
    Sso12RawOptions,
    Sso12RawResult,
} from '../../src/direct/sso12-packet-client';

// Everything here is synthetic: the transport never creates a socket or contacts a service.
function fixture() {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
    });
    const transactRaw = vi.fn(
        async <C, T>(_options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> => {
            // A regression remains observable without leaving a pending transaction behind.
            await Promise.race([gate, Promise.resolve()]);
            return { kind: 'failure', code: 'unexpected-transaction', writeState: 'not-written' };
        },
    );
    const client = {
        transactRaw,
        whenClosed: new Promise<Sso12CloseReason>(() => {}),
        close: vi.fn(),
    };
    const sign = vi.fn(() => Uint8Array.of(1));
    const verify = vi.fn(() => true);
    const accept = vi.fn(() => true);
    const verifyServerResponse = vi.fn(() => true);
    const acceptKeyExchange = vi.fn(() => true);
    const key = createECDH('prime256v1');
    const scalar = Buffer.alloc(32);
    scalar[31] = 1;
    key.setPrivateKey(scalar);
    const controller = new AbortController();
    const options = {
        client,
        trustedSuccessQuiescence: true as const,
        isUsable: vi.fn(() => true),
        sessionTimeoutMs: 30000,
        signal: controller.signal,
        login: {
            uin: '123456',
            guid: Uint8Array.of(0xab, 0xcd),
            a2: Uint8Array.of(0x21, 0, 0x22),
            version: 'header-v',
            subAppId: 42,
            serverPublicKey: Uint8Array.from(key.getPublicKey()),
            verifyKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
            timestamp: 1700000000,
            a1: Uint8Array.of(0x11, 0, 0x12),
            nonce: Uint8Array.from({ length: 12 }, (_, i) => i),
            deviceName: 'fixture-device',
            deviceType: 'fixture-type',
            appId: 42,
            appName: 'fixture-app',
            qua: 'fixture-qua',
            cookie: 'fixture-cookie',
            timeoutMs: 5000,
            buildReserved: sign,
            verifyRaw: verify,
            verifyServerResponse,
            acceptKeyExchange,
        },
        register: {
            profile: { guid: Uint8Array.of(0xab, 0xcd), version: 'header-v', subAppId: 42 },
            registration: {
                uid: 'synthetic-uid',
                version: 'build-v',
                deviceName: 'fixture-device',
                deviceType: 'fixture-type',
                vendorOs: 'fixture-os',
                random: 4,
            },
            timeoutMs: 5000,
            buildReserved: sign,
            verifyRaw: verify,
            acceptLogin: accept,
        },
    };
    return {
        options,
        client,
        sign,
        verify,
        accept,
        verifyServerResponse,
        acceptKeyExchange,
        releaseGate,
    };
}

type Fixture = ReturnType<typeof fixture>;
type OwnerInput = Parameters<ReturnType<typeof createLinuxEasyAccountOwner>['start']>[0];

const set = (object: object, key: string, value: unknown): void => {
    (object as Record<string, unknown>)[key] = value;
};

const remove = (object: object, key: string): void => {
    delete (object as Record<string, unknown>)[key];
};

const cases: [string, (f: Fixture) => void][] = [
    [
        'empty profile version',
        (f) => {
            f.options.register.profile.version = '';
        },
    ],
    [
        'invalid profile version UTF-16',
        (f) => {
            f.options.register.profile.version = '\ud800';
        },
    ],
    [
        'empty uid',
        (f) => {
            f.options.register.registration.uid = '';
        },
    ],
    [
        'uid exceeding UTF-8 byte limit',
        (f) => {
            f.options.register.registration.uid = 'é'.repeat(2049);
        },
    ],
    [
        'invalid uid UTF-16',
        (f) => {
            f.options.register.registration.uid = '\udc00';
        },
    ],
    [
        'empty registration version',
        (f) => {
            f.options.register.registration.version = '';
        },
    ],
    [
        'proxy deviceName',
        (f) => {
            set(f.options.register.registration, 'deviceName', new Proxy(new String('device'), {}));
        },
    ],
    [
        'unpaired high surrogate in deviceName',
        (f) => {
            f.options.register.registration.deviceName = '\ud800';
        },
    ],
    [
        'unpaired low surrogate in deviceName',
        (f) => {
            f.options.register.registration.deviceName = '\udc00';
        },
    ],
    [
        'invalid deviceType UTF-16',
        (f) => {
            f.options.register.registration.deviceType = '\ud800';
        },
    ],
    [
        'invalid vendorOs UTF-16',
        (f) => {
            f.options.register.registration.vendorOs = '\udc00';
        },
    ],
    [
        'deviceName exceeding UTF-8 byte limit',
        (f) => {
            f.options.register.registration.deviceName = 'é'.repeat(2049);
        },
    ],
    [
        'subAppId above signed integer maximum',
        (f) => {
            f.options.register.profile.subAppId = 0x80000000;
        },
    ],
    [
        'negative subAppId',
        (f) => {
            f.options.register.profile.subAppId = -1;
        },
    ],
    [
        'random at exclusive maximum',
        (f) => {
            f.options.register.registration.random = 0x7fffffff;
        },
    ],
    [
        'fractional random',
        (f) => {
            f.options.register.registration.random = 1.5;
        },
    ],
    [
        'negative random',
        (f) => {
            f.options.register.registration.random = -1;
        },
    ],
    [
        'zero register timeout',
        (f) => {
            f.options.register.timeoutMs = 0;
        },
    ],
    [
        'missing signer',
        (f) => {
            remove(f.options.register, 'buildReserved');
        },
    ],
    [
        'proxy signer',
        (f) => {
            set(f.options.register, 'buildReserved', new Proxy(f.sign, {}));
        },
    ],
    [
        'missing verifier',
        (f) => {
            remove(f.options.register, 'verifyRaw');
        },
    ],
    [
        'proxy verifier',
        (f) => {
            set(f.options.register, 'verifyRaw', new Proxy(f.verify, {}));
        },
    ],
    [
        'missing acceptLogin',
        (f) => {
            remove(f.options.register, 'acceptLogin');
        },
    ],
    [
        'proxy acceptLogin',
        (f) => {
            set(f.options.register, 'acceptLogin', new Proxy(f.accept, {}));
        },
    ],
    [
        'empty profile guid',
        (f) => {
            f.options.register.profile.guid = new Uint8Array();
        },
    ],
    [
        'UIN above uint32',
        (f) => {
            f.options.login.uin = '4294967296';
        },
    ],
    [
        'UIN with leading zero',
        (f) => {
            f.options.login.uin = '0123456';
        },
    ],
    [
        'UIN with non-decimal character',
        (f) => {
            f.options.login.uin = '123x';
        },
    ],
];

function expectNoEffects(f: Fixture): void {
    expect(f.client.transactRaw).not.toHaveBeenCalled();
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.accept).not.toHaveBeenCalled();
    expect(f.verifyServerResponse).not.toHaveBeenCalled();
    expect(f.acceptKeyExchange).not.toHaveBeenCalled();
}

describe('Linux Easy account owner registration preflight', () => {
    it.each(cases)('rejects %s before the first transaction', async (_name, mutate) => {
        const f = fixture();
        const owner = createLinuxEasyAccountOwner();

        try {
            mutate(f);
            const result = await owner.start(f.options as unknown as OwnerInput);
            expect(result.kind).toBe('failure');
            expectNoEffects(f);
        } finally {
            owner.close();
            f.releaseGate();
        }
    });

    it.each(['extra', 'getter'] as const)(
        'rejects an options %s without executing a getter or transaction',
        async (kind) => {
            const f = fixture();
            const owner = createLinuxEasyAccountOwner();
            const getter = vi.fn(() => 'unexpected');

            try {
                if (kind === 'extra') {
                    set(f.options, 'extra', 'unexpected');
                } else {
                    Object.defineProperty(f.options, 'sessionTimeoutMs', { get: getter });
                }

                const result = await owner.start(f.options as unknown as OwnerInput);
                expect(result.kind).toBe('failure');
                expect(getter).not.toHaveBeenCalled();
                expectNoEffects(f);
            } finally {
                owner.close();
                f.releaseGate();
            }
        },
    );
});
