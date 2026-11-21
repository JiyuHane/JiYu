import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as codec from '../../packages/protocol/src/direct/wt-persisted-session';
import type { WtPersistedSessionV1 } from '../../packages/protocol/src/direct/wt-persisted-session';
import {
    createLoginPersistence,
    persistedProfileDigest,
    persistenceError,
    snapshotPersistenceOptions,
    snapshotRestoreOptions,
    validateRestoredUin,
    type AccountPersistenceEvent,
    type LoginPersistence,
} from './account-persistence';
import {
    AccountVaultError,
    type AccountVault,
    type VaultBinding,
    type VaultGuard,
    type VaultReadResult,
    type VaultRevision,
} from './account-vault';
import { parseConfig, type DirectLoginConfig } from './config';
import { DirectLoginError } from './errors';
import example from './config.example.json';

// Real binary codec, synthetic credentials, and an interface-only vault fake.
// No filesystem, QQ, signer, network, or private account/config access.
const GUID = new Uint8Array(16).fill(0x31);
const UIN = '123456789';
const inputs = {
    vaultRoot: path.resolve('synthetic-vault-root'),
    keyRoot: path.resolve('synthetic-key-root'),
    slotId: 'a'.repeat(32),
};
const config = (): DirectLoginConfig =>
    parseConfig(structuredClone(example), path.resolve('synthetic-config'));
const session = (uin = UIN, guid = GUID): WtPersistedSessionV1 =>
    codec.cloneWtPersistedSession({
        version: 1,
        uin,
        uid: 'synthetic-uid',
        guid,
        tickets: {
            d2: new Uint8Array([0x41, 0x42, 0x43]),
            d2Key: new Uint8Array(16).fill(0x44),
            a1: new Uint8Array([0x51, 0x52]),
            a2: new Uint8Array([0x61, 0x62, 0x63]),
        },
    });
const guard = (controller = new AbortController()): VaultGuard => ({
    signal: controller.signal,
    isCurrent: () => true,
});
const revision = (generation = 7n): VaultRevision =>
    Object.freeze({ generation, recordHash: 'b'.repeat(64) });
const bytesOf = (value: WtPersistedSessionV1): Uint8Array[] => [
    value.guid,
    ...Object.values(value.tickets),
];

const expectWiped = (value: WtPersistedSessionV1) => {
    for (const bytes of bytesOf(value)) {
        expect(bytes).toEqual(new Uint8Array(bytes.length));
    }
};

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

interface ReadCall {
    binding: VaultBinding;
    guard: VaultGuard | undefined;
}
interface SaveCall {
    binding: VaultBinding;
    payload: Uint8Array;
    copiedPayload: Uint8Array;
    expected: VaultRevision | null;
    guard: VaultGuard;
}
class FakeVault implements AccountVault {
    kind: 'missing' | 'present' | 'revoked' = 'missing';
    payload: Uint8Array = new Uint8Array();
    revision = revision();
    readCalls: ReadCall[] = [];
    saveCalls: SaveCall[] = [];
    invalidateCalls: { binding: VaultBinding; expected: VaultRevision; guard: VaultGuard }[] = [];
    invalidateError: unknown;
    invalidateGate?: Promise<void>;
    invalidateStarted = deferred<void>();
    consumedValues: unknown[] = [];
    borrowedBuffers: Uint8Array[] = [];
    readError: unknown;
    afterReadError: unknown;
    saveError: unknown;
    closeError: unknown;
    closeSyncError: unknown;
    readGate?: Promise<void>;
    saveGate?: Promise<void>;
    closeGate?: Promise<void>;
    afterConsume?: () => void;
    closeCalls = 0;
    saveStarted = deferred<void>();

    store(value: WtPersistedSessionV1): this {
        this.kind = 'present';
        this.payload = codec.encodeWtPersistedSession(value);
        return this;
    }

    async read<T>(
        binding: VaultBinding,
        consume: (bytes: Uint8Array, revision: VaultRevision) => T,
        observedGuard?: VaultGuard,
    ): Promise<VaultReadResult<T>> {
        this.readCalls.push({ binding, guard: observedGuard });

        if (this.readGate) {
            await this.readGate;
        }

        if (this.readError) {
            throw this.readError;
        }

        if (this.kind === 'missing') {
            return { kind: 'missing' };
        }

        if (this.kind === 'revoked') {
            return { kind: 'revoked', revision: this.revision };
        }

        const borrowed = Uint8Array.from(this.payload);
        this.borrowedBuffers.push(borrowed);

        try {
            const value = consume(borrowed, this.revision);
            this.consumedValues.push(value);
            this.afterConsume?.();

            if (this.afterReadError) {
                throw this.afterReadError;
            }

            return { kind: 'present', revision: this.revision, value };
        } finally {
            borrowed.fill(0);
        }
    }

    async save(
        binding: VaultBinding,
        payload: Uint8Array,
        expected: VaultRevision | null,
        observedGuard: VaultGuard,
    ): Promise<VaultRevision> {
        this.saveCalls.push({
            binding,
            payload,
            copiedPayload: Uint8Array.from(payload),
            expected,
            guard: observedGuard,
        });
        this.saveStarted.resolve();

        if (this.saveGate) {
            await this.saveGate;
        }

        if (this.saveError) {
            throw this.saveError;
        }

        return revision((expected?.generation ?? 0n) + 1n);
    }

    async invalidate(
        binding: VaultBinding,
        expected: VaultRevision,
        observedGuard: VaultGuard,
    ): Promise<void> {
        this.invalidateCalls.push({ binding, expected, guard: observedGuard });
        this.invalidateStarted.resolve();
        await this.invalidateGate;

        if (this.invalidateError) {
            throw this.invalidateError;
        }
    }

    async revoke(): Promise<VaultRevision> {
        throw new Error('unexpected revoke');
    }

    close(): Promise<void> {
        this.closeCalls++;

        if (this.closeSyncError) {
            throw this.closeSyncError;
        }

        return (this.closeGate ?? Promise.resolve()).then(() => {
            if (this.closeError) {
                throw this.closeError;
            }
        });
    }
}
const lifetimes: LoginPersistence[] = [];
const dtos: WtPersistedSessionV1[] = [];

function ownSession(uin = UIN, guid = GUID) {
    const value = session(uin, guid);
    dtos.push(value);
    return value;
}

function adapter(vault = new FakeVault(), settings = config(), guid = GUID) {
    const events: AccountPersistenceEvent[] = [];
    const persistence = createLoginPersistence(vault, settings, guid, (event) => {
        events.push(event);
    });
    lifetimes.push(persistence);
    return { persistence, vault, events };
}

afterEach(async () => {
    await Promise.allSettled(lifetimes.splice(0).map((item) => item.close()));

    for (const value of dtos.splice(0)) {
        codec.disposeWtPersistedSession(value);
    }

    vi.restoreAllMocks();
});

describe('explicit persistence option validation', () => {
    it('keeps omitted persistence disabled and snapshots valid options', () => {
        expect(snapshotPersistenceOptions(undefined)).toBeUndefined();
        const mutable = { ...inputs };
        const result = snapshotPersistenceOptions(mutable)!;
        mutable.slotId = 'c'.repeat(32);
        expect(result).toEqual(inputs);
        expect(Object.isFrozen(result)).toBe(true);
    });
    it.each([
        null,
        [],
        1,
        'enabled',
        true,
        {},
        { ...inputs, extra: true },
        { vaultRoot: inputs.vaultRoot },
    ])('rejects invalid persistence configuration %j', (value) => {
        expect(() => snapshotPersistenceOptions(value)).toThrow(DirectLoginError);
    });
    it.each(['', '../slot', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33)])(
        'rejects invalid slot %s',
        (slotId) => {
            expect(() => snapshotPersistenceOptions({ ...inputs, slotId })).toThrow(
                DirectLoginError,
            );
        },
    );
    it.each(['', './relative', 'path\0bad', 'x'.repeat(8193), 123])(
        'rejects invalid roots',
        (value) => {
            expect(() => snapshotPersistenceOptions({ ...inputs, vaultRoot: value })).toThrow(
                DirectLoginError,
            );
            expect(() => snapshotPersistenceOptions({ ...inputs, keyRoot: value })).toThrow(
                DirectLoginError,
            );
        },
    );
    it('rejects getters, proxies, symbols and inherited configurations without running user code', () => {
        const getter = vi.fn(() => {
            throw new Error('getter should not execute');
        });
        const descriptor = Object.defineProperty({ ...inputs }, 'vaultRoot', { get: getter });
        expect(() => snapshotPersistenceOptions(descriptor)).toThrow(DirectLoginError);
        expect(getter).not.toHaveBeenCalled();
        const trap = vi.fn(() => {
            throw new Error('proxy should not execute');
        });
        expect(() => snapshotPersistenceOptions(new Proxy({ ...inputs }, { get: trap }))).toThrow(
            DirectLoginError,
        );
        expect(trap).not.toHaveBeenCalled();
        expect(() => snapshotPersistenceOptions({ ...inputs, [Symbol('extra')]: 1 })).toThrow(
            DirectLoginError,
        );
        expect(() =>
            snapshotPersistenceOptions(Object.assign(Object.create({ inherited: true }), inputs)),
        ).toThrow(DirectLoginError);
    });
    it('snapshots an explicit restore identity', () => {
        const result = snapshotRestoreOptions({ ...inputs, uin: UIN });
        expect(result).toEqual({ ...inputs, uin: UIN });
        expect(Object.isFrozen(result)).toBe(true);
        expect(() => snapshotRestoreOptions(inputs)).toThrow(DirectLoginError);
        expect(() => snapshotRestoreOptions({ ...inputs, uin: UIN, extra: true })).toThrow(
            DirectLoginError,
        );
    });
    it.each([undefined, null, 123, '', '0', '01', '-1', '1e3', ' 123', '123 ', '4294967296'])(
        'rejects a noncanonical restore UIN',
        (uin) => {
            expect(() => validateRestoredUin(uin)).toThrow(DirectLoginError);
            expect(() => snapshotRestoreOptions({ ...inputs, uin })).toThrow(DirectLoginError);
        },
    );
    it('accepts the positive uint32 UIN limits', () => {
        expect(validateRestoredUin('1')).toBe('1');
        expect(validateRestoredUin('4294967295')).toBe('4294967295');
    });
});

describe('canonical public protocol/profile binding', () => {
    it('is independent of profile property order and sign-command ordering', () => {
        const original = config();
        const changed = config();
        changed.profile = Object.fromEntries(
            Object.entries(changed.profile).reverse(),
        ) as typeof changed.profile;
        changed.reserve.signCommands.reverse();
        expect(persistedProfileDigest(changed)).toEqual(persistedProfileDigest(original));
    });
    it.each(Object.keys(config().profile))('binds profile field %s', (key) => {
        const original = config();
        const changed = config();
        const value = changed.profile[key as keyof typeof changed.profile];
        Object.assign(changed.profile, {
            [key]: typeof value === 'number' ? value + 1 : `${value}-changed`,
        });
        expect(persistedProfileDigest(changed)).not.toEqual(persistedProfileDigest(original));
    });
    it.each(['build', 'hash', 'msgType', 'ntCoreVersion', 'reference', 'signCommands'])(
        'binds %s identity',
        (field) => {
            const original = config();
            const changed = config();

            if (field === 'build') {
                changed.signer.expectedBuild += '-changed';
            }

            if (field === 'hash') {
                changed.signer.expectedSha256 = 'f'.repeat(64);
            }

            if (field === 'msgType') {
                changed.reserve.msgType = 100;
            }

            if (field === 'ntCoreVersion') {
                changed.reserve.ntCoreVersion = 100;
            }

            if (field === 'reference') {
                Object.assign(changed, { referenceCommit: 'different-reference' });
            }

            if (field === 'signCommands') {
                changed.reserve.signCommands.push('Synthetic.OtherCommand');
            }

            expect(persistedProfileDigest(changed)).not.toEqual(persistedProfileDigest(original));
        },
    );
    it('does not bind operational paths, endpoint or timeout settings', () => {
        const original = config();
        const changed = config();
        changed.gateway.host = 'synthetic.invalid';
        changed.gateway.port++;
        changed.signer.executable = '/synthetic/moved/signer';
        changed.signer.args = ['synthetic'];
        changed.signer.cwd = path.resolve('synthetic-new-cwd');
        changed.statePath = path.resolve('synthetic-new-guid');
        changed.outDir = path.resolve('synthetic-new-qr');
        changed.attemptTimeoutMs++;
        changed.transactionTimeoutMs++;
        changed.onlineHoldMs++;
        expect(persistedProfileDigest(changed)).toEqual(persistedProfileDigest(original));
    });
});

describe('Core encrypted payload envelope and renewal metadata', () => {
    it.each([
        [0n, 0n],
        [0n, 5n],
        [5n, 0n],
        [10n, 5n],
        [5n, 5n],
        [1n, 2n],
        [0xffffffffffffffffn, 0xffffffffffffffffn],
    ])(
        'round-trips independent u64 metadata %s/%s without inferring scheduling validity',
        async (nextRefreshAtSeconds, expiresAtSeconds) => {
            const first = adapter();
            const ticketMetadata = { nextRefreshAtSeconds, expiresAtSeconds };
            await first.persistence.checkpoint.save(ownSession(), { ...guard(), ticketMetadata });
            const payload = first.vault.saveCalls[0].copiedPayload;
            const secondVault = new FakeVault();
            secondVault.kind = 'present';
            secondVault.payload = payload;
            const second = adapter(secondVault);
            const loaded = await second.persistence.load(UIN, guard());
            dtos.push(loaded);
            expect(loaded.uin).toBe(UIN);
            expect(loaded.tickets.d2).toEqual(ownSession().tickets.d2);
            expect(second.persistence.getRenewalMetadata()).toEqual(ticketMetadata);
            expect(first.persistence.getRenewalMetadata()).toEqual(ticketMetadata);
            expect(second.persistence.getRenewalMetadata()).not.toBe(
                second.persistence.getRenewalMetadata(),
            );
            expect(Object.isFrozen(second.persistence.getRenewalMetadata())).toBe(true);
            expect(Object.keys(first.vault.saveCalls[0].guard).sort()).toEqual([
                'isCurrent',
                'signal',
            ]);
            ticketMetadata.nextRefreshAtSeconds = 123n;
            expect(first.persistence.getRenewalMetadata()?.nextRefreshAtSeconds).toBe(
                nextRefreshAtSeconds,
            );
        },
    );
    it('loads legacy raw WT V1 and new metadata-free envelopes with null metadata', async () => {
        const first = adapter(new FakeVault().store(ownSession()));
        const legacy = await first.persistence.load(UIN, guard());
        dtos.push(legacy);
        expect(first.persistence.getRenewalMetadata()).toBeNull();
        await first.persistence.checkpoint.save(ownSession(), guard());
        const persisted = first.vault.saveCalls[0].copiedPayload;
        expect(persisted[8]).toBe(0);
        const secondVault = new FakeVault();
        secondVault.kind = 'present';
        secondVault.payload = persisted;
        const second = adapter(secondVault);
        const loaded = await second.persistence.load(UIN, guard());
        dtos.push(loaded);
        expect(loaded.uin).toBe(UIN);
        expect(second.persistence.getRenewalMetadata()).toBeNull();
    });
    it.each([
        null,
        {},
        { nextRefreshAtSeconds: 1n },
        { nextRefreshAtSeconds: 1, expiresAtSeconds: 2n },
        { nextRefreshAtSeconds: -1n, expiresAtSeconds: 2n },
        { nextRefreshAtSeconds: 1n, expiresAtSeconds: -1n },
        { nextRefreshAtSeconds: 0x10000000000000000n, expiresAtSeconds: 2n },
        { nextRefreshAtSeconds: 1n, expiresAtSeconds: 0x10000000000000000n },
        { nextRefreshAtSeconds: 1n, expiresAtSeconds: 2n, extra: true },
    ])('rejects malformed metadata before touching the vault %#', async (ticketMetadata) => {
        const { persistence, vault } = adapter();
        await expect(
            persistence.checkpoint.save(ownSession(), { ...guard(), ticketMetadata } as never),
        ).rejects.toMatchObject({ code: 'account-store-metadata' });
        expect(vault.readCalls).toHaveLength(0);
        expect(vault.saveCalls).toHaveLength(0);
        expect(persistence.getRenewalMetadata()).toBeNull();
    });
    it('does not invoke metadata getters or proxy traps', async () => {
        const getter = vi.fn(() => 1n);
        const accessor = Object.defineProperty({ expiresAtSeconds: 2n }, 'nextRefreshAtSeconds', {
            get: getter,
        });
        const trap = vi.fn();
        const proxy = new Proxy({}, { get: trap });
        const { persistence, vault } = adapter();

        for (const ticketMetadata of [accessor, proxy]) {
            await expect(
                persistence.checkpoint.save(ownSession(), { ...guard(), ticketMetadata } as never),
            ).rejects.toMatchObject({ code: 'account-store-metadata' });
        }

        expect(getter).not.toHaveBeenCalled();
        expect(trap).not.toHaveBeenCalled();
        expect(vault.saveCalls).toHaveLength(0);
    });
    it.each([
        'version',
        'flags',
        'reserved',
        'length',
        'empty',
        'truncated',
        'trailing',
        'absent-time',
        'inner',
    ] as const)(
        'rejects a malformed %s envelope without transferring a DTO or metadata',
        async (change) => {
            const first = adapter();
            await first.persistence.checkpoint.save(ownSession(), guard());
            let bytes = Buffer.from(first.vault.saveCalls[0].copiedPayload);

            if (change === 'version') {
                bytes[7] = 2;
            }

            if (change === 'flags') {
                bytes[8] = 2;
            }

            if (change === 'reserved') {
                bytes[10] = 1;
            }

            if (change === 'length') {
                bytes.writeUInt32BE(0xffffffff, 12);
            }

            if (change === 'empty') {
                bytes.writeUInt32BE(0, 12);
                bytes = bytes.subarray(0, 32);
            }

            if (change === 'truncated') {
                bytes = bytes.subarray(0, 31);
            }

            if (change === 'trailing') {
                bytes = Buffer.concat([bytes, Buffer.from([0])]);
            }

            if (change === 'absent-time') {
                bytes[23] = 1;
            }

            if (change === 'inner') {
                bytes[32] ^= 1;
            }

            const vault = new FakeVault();
            vault.kind = 'present';
            vault.payload = bytes;
            const { persistence } = adapter(vault);
            await expect(persistence.load(UIN, guard())).rejects.toBeInstanceOf(Error);
            expect(persistence.getRenewalMetadata()).toBeNull();
            expect(vault.borrowedBuffers.every((value) => value.every((byte) => byte === 0))).toBe(
                true,
            );
        },
    );
    it('updates metadata only with the same durable save receipt and clears on close', async () => {
        const { persistence, vault } = adapter();
        const initial = { nextRefreshAtSeconds: 1n, expiresAtSeconds: 2n };
        await persistence.checkpoint.save(ownSession(), { ...guard(), ticketMetadata: initial });
        vault.saveError = new AccountVaultError('commit-uncertain');
        await expect(
            persistence.checkpoint.save(ownSession(), {
                ...guard(),
                ticketMetadata: { nextRefreshAtSeconds: 3n, expiresAtSeconds: 4n },
            }),
        ).rejects.toMatchObject({ code: 'account-store-commit-uncertain' });
        expect(persistence.getRenewalMetadata()).toEqual(initial);
        await persistence.close();
        expect(persistence.getRenewalMetadata()).toBeNull();
    });
});

describe('terminal retained-revision invalidation checkpoint', () => {
    it.each(['save', 'load'] as const)(
        'invalidates only the last successful %s revision without a latest-slot read',
        async (source) => {
            const vault = new FakeVault().store(ownSession());
            const { persistence } = adapter(vault);

            if (source === 'save') {
                await persistence.checkpoint.save(ownSession(), {
                    ...guard(),
                    ticketMetadata: { nextRefreshAtSeconds: 1n, expiresAtSeconds: 2n },
                });
            } else {
                const loaded = await persistence.load(UIN, guard());
                dtos.push(loaded);
            }

            const retainedRevision = revision(source === 'save' ? 8n : 7n);
            const reads = vault.readCalls.length;
            vault.revision = revision(20n);
            await persistence.checkpoint.invalidate(guard());
            expect(vault.readCalls).toHaveLength(reads);
            expect(vault.invalidateCalls).toHaveLength(1);
            expect(vault.invalidateCalls[0].expected).toEqual(retainedRevision);
            expect(vault.invalidateCalls[0].binding.uin).toBe(UIN);
            expect(persistence.getRenewalMetadata()).toBeNull();
            await expect(persistence.checkpoint.save(ownSession(), guard())).rejects.toMatchObject({
                code: 'account-store-revoked',
            });
            await expect(persistence.load(UIN, guard())).rejects.toMatchObject({
                code: 'account-store-revoked',
            });
            await expect(persistence.checkpoint.invalidate(guard())).rejects.toMatchObject({
                code: 'account-store-missing',
            });
            expect(vault.invalidateCalls).toHaveLength(1);
        },
    );
    it('never invalidates an account which has not been successfully loaded or saved', async () => {
        const { persistence, vault } = adapter();
        await expect(persistence.checkpoint.invalidate(guard())).rejects.toMatchObject({
            code: 'account-store-missing',
        });
        expect(vault.invalidateCalls).toHaveLength(0);
        expect(vault.readCalls).toHaveLength(0);
    });
    it.each(['revision-conflict', 'commit-uncertain', 'io'] as const)(
        'preserves %s failures with no blind retry',
        async (code) => {
            const vault = new FakeVault().store(ownSession());
            const { persistence } = adapter(vault);
            dtos.push(await persistence.load(UIN, guard()));
            vault.invalidateError = new AccountVaultError(code);
            await expect(persistence.checkpoint.invalidate(guard())).rejects.toMatchObject({
                code: `account-store-${code}`,
            });
            expect(persistence.getFailure()?.code).toBe(`account-store-${code}`);
            expect(vault.invalidateCalls).toHaveLength(1);
            await expect(persistence.checkpoint.save(ownSession(), guard())).rejects.toMatchObject({
                code: 'account-store-revoked',
            });
        },
    );
    it('reports a provider without invalidation instead of inventing success', async () => {
        const vault = new FakeVault().store(ownSession());
        Object.defineProperty(vault, 'invalidate', { value: undefined });
        const { persistence } = adapter(vault);
        dtos.push(await persistence.load(UIN, guard()));
        await expect(persistence.checkpoint.invalidate(guard())).rejects.toMatchObject({
            code: 'account-store-invalidation-unsupported',
        });
    });
    it('waits for invalidation and blocks a duplicate while retaining cancellation uncertainty', async () => {
        const vault = new FakeVault().store(ownSession());
        const { persistence } = adapter(vault);
        dtos.push(await persistence.load(UIN, guard()));
        const gate = deferred<void>();
        vault.invalidateGate = gate.promise;
        const abort = new AbortController();
        let settled = false;
        const pending = persistence.checkpoint.invalidate(guard(abort)).catch((error: unknown) => {
            settled = true;
            return error;
        });
        await vault.invalidateStarted.promise;
        expect(settled).toBe(false);
        await expect(persistence.checkpoint.invalidate(guard())).rejects.toMatchObject({
            code: 'account-store-busy',
        });
        abort.abort();
        gate.resolve();
        expect(await pending).toMatchObject({ code: 'account-store-commit-uncertain' });
        expect(vault.invalidateCalls).toHaveLength(1);
    });
    it('fences a paused save before that old generation can publish again', async () => {
        const { persistence, vault } = adapter();
        await persistence.checkpoint.save(ownSession(), guard());
        const gate = deferred<void>();
        vault.readGate = gate.promise;
        const pending = persistence.checkpoint.save(ownSession(), guard());
        const checked = expect(pending).rejects.toMatchObject({ code: 'account-store-revoked' });
        await persistence.checkpoint.invalidate(guard());
        gate.resolve();
        await checked;
        expect(vault.saveCalls).toHaveLength(1);
    });
});

describe('checkpoint ownership, awaiting and CAS', () => {
    it('encodes before the first await and waits for the durable save receipt', async () => {
        const vault = new FakeVault();
        const readGate = deferred<void>();
        const saveGate = deferred<void>();
        vault.readGate = readGate.promise;
        vault.saveGate = saveGate.promise;
        const { persistence, events } = adapter(vault);
        const input = ownSession();
        const expected = codec.encodeWtPersistedSession(input);
        const observedGuard = guard();
        let settled = false;
        const pending = Promise.resolve(persistence.checkpoint.save(input, observedGuard));
        void pending.then(() => {
            settled = true;
        });
        input.tickets.d2.fill(0);
        input.tickets.a1.fill(0);
        input.guid.fill(0);
        expect(events).toEqual([{ state: 'saving-account' }]);
        expect(vault.saveCalls).toHaveLength(0);
        expect(settled).toBe(false);
        readGate.resolve();
        await vault.saveStarted.promise;
        const call = vault.saveCalls[0];
        expect(Array.from(call.copiedPayload.subarray(0, 8))).toEqual([
            0x4a, 0x59, 0x41, 0x43, 0x43, 0x54, 0, 1,
        ]);
        expect(Array.from(call.copiedPayload.subarray(32))).toEqual(Array.from(expected));
        expect(call.payload).toEqual(call.copiedPayload);
        expect(call.expected).toBeNull();
        expect(call.guard).toBe(observedGuard);
        expect(vault.readCalls[0].guard).toBe(observedGuard);
        expect(settled).toBe(false);
        expect(events).toEqual([{ state: 'saving-account' }]);
        saveGate.resolve();
        await expect(pending).resolves.toBeUndefined();
        expect(Array.from(call.payload)).toEqual(Array(call.payload.length).fill(0));
        expect(events).toEqual([
            { state: 'saving-account' },
            { state: 'account-saved', accountRevision: '1' },
        ]);
        expected.fill(0);
    });
    it.each(['missing', 'present', 'revoked'] as const)(
        'uses exact %s CAS revision',
        async (kind) => {
            const vault = new FakeVault();

            if (kind === 'present') {
                vault.store(ownSession());
            }

            vault.kind = kind;
            const { persistence } = adapter(vault);
            await persistence.checkpoint.save(ownSession(), guard());
            expect(vault.saveCalls).toHaveLength(1);
            expect(vault.saveCalls[0].expected).toBe(kind === 'missing' ? null : vault.revision);
            expect(vault.readCalls).toHaveLength(1);
        },
    );
    it('uses an independent device snapshot and authenticated account/profile/device binding', async () => {
        const device = Uint8Array.from(GUID);
        const settings = config();
        const { persistence, vault } = adapter(new FakeVault(), settings, device);
        device.fill(0);
        await persistence.checkpoint.save(ownSession(), guard());
        const actual = vault.saveCalls[0].binding;
        expect(actual.uin).toBe(UIN);
        expect(actual.profileDigest).toEqual(persistedProfileDigest(settings));
        expect(actual.deviceDigest).toEqual(createHash('sha256').update(GUID).digest());
    });
    it('wipes the temporary decoded previous DTO and caller serialization after success', async () => {
        const decode = codec.decodeWtPersistedSession;
        let previous: WtPersistedSessionV1 | undefined;
        vi.spyOn(codec, 'decodeWtPersistedSession').mockImplementation((bytes) => {
            previous = decode(bytes);
            return previous;
        });
        const vault = new FakeVault().store(ownSession());
        const { persistence } = adapter(vault);
        const input = ownSession();
        await persistence.checkpoint.save(input, guard());
        expectWiped(previous!);
        expect(vault.saveCalls[0].payload).toEqual(
            new Uint8Array(vault.saveCalls[0].payload.length),
        );
        expect(input.tickets.d2).toEqual(new Uint8Array([0x41, 0x42, 0x43]));
    });
    it('wipes encoded output when a read fails before save starts', async () => {
        const encode = codec.encodeWtPersistedSession;
        let encoded: Uint8Array | undefined;
        vi.spyOn(codec, 'encodeWtPersistedSession').mockImplementation((value) => {
            encoded = encode(value);
            return encoded;
        });
        const vault = new FakeVault();
        vault.readError = new AccountVaultError('auth-failed');
        const { persistence } = adapter(vault);
        await expect(persistence.checkpoint.save(ownSession(), guard())).rejects.toMatchObject({
            code: 'account-store-auth-failed',
        });
        expect(vault.saveCalls).toHaveLength(0);
        expect(encoded).toEqual(new Uint8Array(encoded!.length));
    });
    it.each(['revision-conflict', 'commit-uncertain', 'io'] as const)(
        'retains %s errors without automatic retry',
        async (code) => {
            const vault = new FakeVault();
            vault.saveError = new AccountVaultError(code);
            const { persistence, events } = adapter(vault);
            await expect(persistence.checkpoint.save(ownSession(), guard())).rejects.toMatchObject({
                code: `account-store-${code}`,
            });
            expect(persistence.getFailure()).toMatchObject({ code: `account-store-${code}` });
            expect(vault.readCalls).toHaveLength(1);
            expect(vault.saveCalls).toHaveLength(1);
            const bytes = vault.saveCalls[0].payload;
            expect(bytes).toEqual(new Uint8Array(bytes.length));
            expect(events).toEqual([{ state: 'saving-account' }]);
        },
    );
    it('rejects a mismatched new or existing device without saving', async () => {
        const wrong = ownSession(UIN, new Uint8Array(16).fill(0x77));
        const { persistence, vault } = adapter();
        await expect(persistence.checkpoint.save(wrong, guard())).rejects.toMatchObject({
            code: 'account-store-binding-mismatch',
        });
        expect(vault.readCalls).toHaveLength(0);
        vault.store(wrong);
        await expect(persistence.checkpoint.save(ownSession(), guard())).rejects.toMatchObject({
            code: 'account-store-binding-mismatch',
        });
        expect(vault.saveCalls).toHaveLength(0);
    });
    it('does not save after the guard expires while reading the prior revision', async () => {
        const vault = new FakeVault();
        const gate = deferred<void>();
        vault.readGate = gate.promise;
        const controller = new AbortController();
        const { persistence } = adapter(vault);
        const pending = persistence.checkpoint.save(ownSession(), guard(controller));
        controller.abort();
        gate.resolve();
        await expect(pending).rejects.toMatchObject({ code: 'account-store-cancelled' });
        expect(vault.saveCalls).toHaveLength(0);
    });
    it('does not announce saved when the guard expires during an in-flight commit', async () => {
        const vault = new FakeVault();
        const gate = deferred<void>();
        vault.saveGate = gate.promise;
        const controller = new AbortController();
        const { persistence, events } = adapter(vault);
        const pending = persistence.checkpoint.save(ownSession(), guard(controller));
        await vault.saveStarted.promise;
        controller.abort();
        gate.resolve();
        await expect(pending).rejects.toMatchObject({ code: 'account-store-cancelled' });
        expect(events).toEqual([{ state: 'saving-account' }]);
        expect(vault.saveCalls[0].payload).toEqual(
            new Uint8Array(vault.saveCalls[0].payload.length),
        );
    });
});

describe('read handoff and late-failure disposal', () => {
    it('transfers an owned decoded DTO without saving or revoking anything', async () => {
        const vault = new FakeVault().store(ownSession());
        const { persistence } = adapter(vault);
        const value = await persistence.load(UIN, guard());
        dtos.push(value);
        expect(value.uin).toBe(UIN);
        expect(value.guid).toEqual(GUID);
        expect(value.tickets.d2).toEqual(new Uint8Array([0x41, 0x42, 0x43]));
        expect(vault.saveCalls).toHaveLength(0);
        expect(vault.borrowedBuffers[0]).toEqual(new Uint8Array(vault.borrowedBuffers[0].length));
        expect(value).toBe(vault.consumedValues[0]);
    });
    it.each(['missing', 'revoked'] as const)('reports %s without creating state', async (kind) => {
        const vault = new FakeVault();
        vault.kind = kind;
        const { persistence } = adapter(vault);
        await expect(persistence.load(UIN, guard())).rejects.toMatchObject({
            code: `account-store-${kind}`,
        });
        expect(vault.saveCalls).toHaveLength(0);
    });
    it('disposes the owned DTO if vault.read fails after its callback returned', async () => {
        const vault = new FakeVault().store(ownSession());
        vault.afterReadError = new AccountVaultError('cancelled');
        const { persistence } = adapter(vault);
        await expect(persistence.load(UIN, guard())).rejects.toMatchObject({
            code: 'account-store-cancelled',
        });
        expectWiped(vault.consumedValues[0] as WtPersistedSessionV1);
    });
    it('disposes the owned DTO on the wrapper post-read guard failure', async () => {
        const vault = new FakeVault().store(ownSession());
        const controller = new AbortController();

        vault.afterConsume = () => {
            controller.abort();
        };

        const { persistence } = adapter(vault);
        await expect(persistence.load(UIN, guard(controller))).rejects.toMatchObject({
            code: 'account-store-cancelled',
        });
        expectWiped(vault.consumedValues[0] as WtPersistedSessionV1);
    });
    it('disposes the owned DTO on reentrant close inside the final isCurrent callback', async () => {
        const vault = new FakeVault().store(ownSession());
        const { persistence } = adapter(vault);
        let consumed = false;

        vault.afterConsume = () => {
            consumed = true;
        };

        const observedGuard = {
            ...guard(),
            isCurrent() {
                if (consumed) {
                    void persistence.close();
                }

                return true;
            },
        };
        await expect(persistence.load(UIN, observedGuard)).rejects.toMatchObject({
            code: 'account-store-cancelled',
        });
        expectWiped(vault.consumedValues[0] as WtPersistedSessionV1);
    });
    it('rejects the wrong inner identity/device and wipes the decoded DTO', async () => {
        const decode = codec.decodeWtPersistedSession;
        const decoded: WtPersistedSessionV1[] = [];
        vi.spyOn(codec, 'decodeWtPersistedSession').mockImplementation((bytes) => {
            const value = decode(bytes);
            decoded.push(value);
            return value;
        });

        for (const wrong of [
            ownSession('987654321'),
            ownSession(UIN, new Uint8Array(16).fill(7)),
        ]) {
            const { persistence } = adapter(new FakeVault().store(wrong));
            await expect(persistence.load(UIN, guard())).rejects.toMatchObject({
                code: 'account-store-binding-mismatch',
            });
        }

        expect(decoded).toHaveLength(2);
        decoded.forEach(expectWiped);
    });
    it('fails on malformed binary without an automatic save or reset', async () => {
        const vault = new FakeVault();
        vault.kind = 'present';
        vault.payload = new Uint8Array([1, 2, 3]);
        const { persistence } = adapter(vault);
        await expect(persistence.load(UIN, guard())).rejects.toMatchObject({
            code: 'account-store-failed',
        });
        expect(vault.saveCalls).toHaveLength(0);
    });
});

describe('strict guards, normalized errors and closure', () => {
    it.each([false, 1, 'yes', {}, undefined])(
        'requires an exact true current result',
        async (current) => {
            const { persistence, vault } = adapter();
            const observedGuard = { ...guard(), isCurrent: () => current } as VaultGuard;
            await expect(persistence.load(UIN, observedGuard)).rejects.toMatchObject({
                code: 'account-store-cancelled',
            });
            expect(vault.readCalls).toHaveLength(0);
        },
    );
    it('rechecks signal after the current callback returns true', async () => {
        const { persistence, vault } = adapter();
        const controller = new AbortController();
        const observedGuard = {
            signal: controller.signal,
            isCurrent() {
                controller.abort();
                return true;
            },
        };
        await expect(
            persistence.checkpoint.save(ownSession(), observedGuard),
        ).rejects.toMatchObject({ code: 'account-store-cancelled' });
        expect(vault.readCalls).toHaveLength(0);
    });
    it('preserves explicit DirectLoginError and normalizes unrelated errors without content', () => {
        const direct = new DirectLoginError('synthetic-phase');
        expect(persistenceError(direct)).toBe(direct);
        expect(persistenceError(new AccountVaultError('commit-uncertain'))).toMatchObject({
            code: 'account-store-commit-uncertain',
        });
        const secret = 'synthetic-secret-error-marker';
        const safe = persistenceError(new Error(secret));
        expect(safe).toMatchObject({ code: 'account-store-failed' });
        expect(String(safe)).not.toContain(secret);
        expect(safe.cause).toBeUndefined();
    });
    it('is idempotent on close and wipes retained binding digests after close settles', async () => {
        const vault = new FakeVault();
        const gate = deferred<void>();
        vault.closeGate = gate.promise;
        const { persistence } = adapter(vault);
        await expect(persistence.load(UIN, guard())).rejects.toMatchObject({
            code: 'account-store-missing',
        });
        const retained = vault.readCalls[0].binding;
        const closing = persistence.close();
        expect(persistence.close()).toBe(closing);
        await expect(persistence.load(UIN, guard())).rejects.toMatchObject({
            code: 'account-store-cancelled',
        });
        expect(vault.closeCalls).toBe(1);
        gate.resolve();
        await closing;
        expect(Array.from(retained.profileDigest)).toEqual(Array(32).fill(0));
        expect(Array.from(retained.deviceDigest)).toEqual(Array(32).fill(0));
    });
    it.each(['async', 'sync'] as const)(
        'normalizes %s close failure, records it and still wipes digests',
        async (mode) => {
            const vault = new FakeVault();
            const { persistence } = adapter(vault);
            await expect(persistence.load(UIN, guard())).rejects.toMatchObject({
                code: 'account-store-missing',
            });
            const retained = vault.readCalls[0].binding;

            if (mode === 'async') {
                vault.closeError = new AccountVaultError('io');
            } else {
                vault.closeSyncError = new AccountVaultError('io');
            }

            await expect(Promise.resolve().then(() => persistence.close())).rejects.toMatchObject({
                code: 'account-store-io',
            });
            expect(persistence.getFailure()).toMatchObject({ code: 'account-store-io' });
            expect(Array.from(retained.profileDigest)).toEqual(Array(32).fill(0));
            expect(Array.from(retained.deviceDigest)).toEqual(Array(32).fill(0));
            await expect(Promise.resolve().then(() => persistence.close())).rejects.toMatchObject({
                code: 'account-store-io',
            });
            expect(vault.closeCalls).toBe(1);
        },
    );
});
