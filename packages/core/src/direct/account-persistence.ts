import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { isProxy } from 'node:util/types';
import {
    decodeWtPersistedSession,
    disposeWtPersistedSession,
    encodeWtPersistedSession,
    MAX_WT_PERSISTED_SESSION_BYTES,
    type WtPersistedSessionV1,
} from '@snowluma/protocol/direct/wt-persisted-session';
import type { WtReferenceSessionOptions } from '@snowluma/protocol/direct/wt-reference-session';
import {
    AccountVaultError,
    type AccountVault,
    type VaultBinding,
    type VaultGuard,
    type VaultRevision,
} from './account-vault';
import type { DirectLoginConfig } from './config';
import { DirectLoginError } from './errors';

/** Presence is an explicit opt-in. Paths are never selected from a working directory. */
export interface DirectAccountPersistenceOptions {
    readonly vaultRoot: string;
    readonly keyRoot: string;
    readonly slotId: string;
}

export interface DirectAccountRestoreOptions extends DirectAccountPersistenceOptions {
    readonly uin: string;
}

export interface AccountPersistenceEvent {
    readonly state: 'saving-account' | 'account-saved';
    readonly accountRevision?: string;
}

export interface DirectAccountRenewalMetadata {
    readonly nextRefreshAtSeconds: bigint;
    readonly expiresAtSeconds: bigint;
}

export interface LoginPersistence {
    readonly checkpoint: Omit<
        NonNullable<WtReferenceSessionOptions['checkpoint']>,
        'save' | 'invalidate'
    > & {
        readonly save: (
            snapshot: WtPersistedSessionV1,
            context: VaultGuard & {
                readonly ticketMetadata?: DirectAccountRenewalMetadata;
            },
        ) => Promise<void>;
        /** Terminal CAS invalidation of this owner's retained revision, not the latest slot. */
        readonly invalidate: (context: VaultGuard) => Promise<void>;
    };
    load(uin: string, guard: VaultGuard): Promise<WtPersistedSessionV1>;
    getRenewalMetadata(): DirectAccountRenewalMetadata | null;
    getFailure(): DirectLoginError | undefined;
    close(): Promise<void>;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || isProxy(value)) {
        throw new DirectLoginError('configuration');
    }

    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
        throw new DirectLoginError('configuration');
    }

    const actual = Reflect.ownKeys(value);

    if (actual.length !== keys.length || actual.some((key) => !keys.includes(String(key)))) {
        throw new DirectLoginError('configuration');
    }

    const output: Record<string, unknown> = Object.create(null);

    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (!descriptor || !('value' in descriptor)) {
            throw new DirectLoginError('configuration');
        }

        output[key] = descriptor.value;
    }

    return output;
}

function absolutePath(value: unknown): string {
    if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > 8192 ||
        value.includes('\0') ||
        !path.isAbsolute(value)
    ) {
        throw new DirectLoginError('configuration');
    }

    return path.normalize(value);
}

export function validateRestoredUin(value: unknown): string {
    if (
        typeof value !== 'string' ||
        !/^[1-9][0-9]{0,9}$/.test(value) ||
        BigInt(value) > 0xffffffffn
    ) {
        throw new DirectLoginError('configuration');
    }

    return value;
}

function persistenceOptions(input: Record<string, unknown>): DirectAccountPersistenceOptions {
    if (typeof input.slotId !== 'string' || !/^[0-9a-f]{32}$/.test(input.slotId)) {
        throw new DirectLoginError('configuration');
    }

    return Object.freeze({
        vaultRoot: absolutePath(input.vaultRoot),
        keyRoot: absolutePath(input.keyRoot),
        slotId: input.slotId,
    });
}

export function snapshotPersistenceOptions(
    value: unknown,
): DirectAccountPersistenceOptions | undefined {
    return value === undefined
        ? undefined
        : persistenceOptions(record(value, ['vaultRoot', 'keyRoot', 'slotId']));
}

export function snapshotRestoreOptions(value: unknown): DirectAccountRestoreOptions {
    const input = record(value, ['vaultRoot', 'keyRoot', 'slotId', 'uin']);
    return Object.freeze({ ...persistenceOptions(input), uin: validateRestoredUin(input.uin) });
}

/** Public protocol identity, not executable paths, network endpoints or ticket bytes. */
export function persistedProfileDigest(config: DirectLoginConfig): Uint8Array {
    const profile = Object.keys(config.profile)
        .sort()
        .map((key) => [key, config.profile[key as keyof typeof config.profile]]);
    const identity = [
        'jiyu-direct-qq-profile-v1',
        config.referenceCommit,
        profile,
        config.reserve.msgType,
        config.reserve.ntCoreVersion,
        [...config.reserve.signCommands].sort(),
        config.signer.expectedBuild,
        config.signer.expectedSha256,
    ];

    return createHash('sha256').update(JSON.stringify(identity)).digest();
}

export function persistenceError(error: unknown): DirectLoginError {
    if (error instanceof DirectLoginError) {
        return error;
    }

    return new DirectLoginError(
        error instanceof AccountVaultError ? `account-store-${error.code}` : 'account-store-failed',
    );
}

// Core-owned envelope inside the authenticated ciphertext. Protocol WT V1 stays unchanged.
const ENVELOPE_MAGIC = Buffer.from([0x4a, 0x59, 0x41, 0x43, 0x43, 0x54, 0, 1]);
const ENVELOPE_HEADER_BYTES = 32;
const MAX_U64 = 0xffffffffffffffffn;

function renewalMetadata(input: unknown): DirectAccountRenewalMetadata | null {
    if (input === undefined) {
        return null;
    }

    try {
        const fields = record(input, ['nextRefreshAtSeconds', 'expiresAtSeconds']);
        const { nextRefreshAtSeconds, expiresAtSeconds } = fields;

        if (
            typeof nextRefreshAtSeconds !== 'bigint' ||
            typeof expiresAtSeconds !== 'bigint' ||
            nextRefreshAtSeconds < 0n ||
            nextRefreshAtSeconds > MAX_U64 ||
            expiresAtSeconds < 0n ||
            expiresAtSeconds > MAX_U64
        ) {
            throw new Error();
        }

        return Object.freeze({ nextRefreshAtSeconds, expiresAtSeconds });
    } catch {
        throw new DirectLoginError('account-store-metadata');
    }
}

function encodeAccountPayload(
    snapshot: WtPersistedSessionV1,
    metadata: DirectAccountRenewalMetadata | null,
): Uint8Array {
    const session = encodeWtPersistedSession(snapshot);

    try {
        const output = new Uint8Array(ENVELOPE_HEADER_BYTES + session.byteLength);
        const header = Buffer.from(output.buffer, output.byteOffset, ENVELOPE_HEADER_BYTES);
        ENVELOPE_MAGIC.copy(header);
        header[8] = metadata ? 1 : 0;
        header.writeUInt32BE(session.byteLength, 12);

        if (metadata) {
            header.writeBigUInt64BE(metadata.nextRefreshAtSeconds, 16);
            header.writeBigUInt64BE(metadata.expiresAtSeconds, 24);
        }

        output.set(session, ENVELOPE_HEADER_BYTES);
        return output;
    } finally {
        session.fill(0);
    }
}

function decodeAccountPayload(payload: Uint8Array): {
    session: WtPersistedSessionV1;
    metadata: DirectAccountRenewalMetadata | null;
} {
    const bytes = Buffer.from(payload);

    try {
        if (!bytes.subarray(0, 6).equals(ENVELOPE_MAGIC.subarray(0, 6))) {
            return { session: decodeWtPersistedSession(bytes), metadata: null };
        }

        if (
            bytes.length < ENVELOPE_HEADER_BYTES ||
            !bytes.subarray(0, 8).equals(ENVELOPE_MAGIC) ||
            bytes[8] > 1 ||
            bytes[9] !== 0 ||
            bytes[10] !== 0 ||
            bytes[11] !== 0 ||
            bytes.readUInt32BE(12) > MAX_WT_PERSISTED_SESSION_BYTES ||
            bytes.readUInt32BE(12) !== bytes.length - ENVELOPE_HEADER_BYTES
        ) {
            throw new DirectLoginError('account-store-format-invalid');
        }

        const nextRefreshAtSeconds = bytes.readBigUInt64BE(16);
        const expiresAtSeconds = bytes.readBigUInt64BE(24);

        if (bytes[8] === 0 && (nextRefreshAtSeconds !== 0n || expiresAtSeconds !== 0n)) {
            throw new DirectLoginError('account-store-format-invalid');
        }

        const metadata =
            bytes[8] === 1 ? renewalMetadata({ nextRefreshAtSeconds, expiresAtSeconds }) : null;
        return {
            session: decodeWtPersistedSession(bytes.subarray(ENVELOPE_HEADER_BYTES)),
            metadata,
        };
    } finally {
        bytes.fill(0);
    }
}

/** The caller already owns an opened vault and a validated, snapshotted configuration. */
export function createLoginPersistence(
    vault: AccountVault,
    config: DirectLoginConfig,
    guid: Uint8Array,
    onState: (event: AccountPersistenceEvent) => void,
): LoginPersistence {
    const device = Uint8Array.from(guid);
    const deviceDigest = createHash('sha256').update(device).digest();
    const profileDigest = persistedProfileDigest(config);
    let closed = false;
    let closing: Promise<void> | undefined;
    let failure: DirectLoginError | undefined;
    let retained: { uin: string; revision: VaultRevision } | undefined;
    let metadata: DirectAccountRenewalMetadata | null = null;
    let terminal = false;
    let invalidating = false;

    const binding = (uin: string): VaultBinding => ({
        uin: validateRestoredUin(uin),
        profileDigest,
        deviceDigest,
    });

    const assertCurrent = (guard: VaultGuard, allowTerminal = false) => {
        const signal = guard.signal;

        if (terminal && !allowTerminal) {
            throw new DirectLoginError('account-store-revoked');
        }

        if (closed || signal.aborted) {
            throw new DirectLoginError('account-store-cancelled');
        }

        const current = guard.isCurrent();

        if (terminal && !allowTerminal) {
            throw new DirectLoginError('account-store-revoked');
        }

        if (current !== true || closed || signal.aborted) {
            throw new DirectLoginError('account-store-cancelled');
        }
    };

    const validate = (snapshot: WtPersistedSessionV1, uin: string) => {
        if (
            snapshot.uin !== uin ||
            snapshot.guid.byteLength !== device.byteLength ||
            !timingSafeEqual(snapshot.guid, device)
        ) {
            throw new DirectLoginError('account-store-binding-mismatch');
        }
    };

    const checkpoint: LoginPersistence['checkpoint'] = {
        timeoutMs: config.transactionTimeoutMs,
        async save(snapshot, context) {
            let bytes: Uint8Array | undefined;

            try {
                // Metadata is Core state, not part of the vault guard's strict record.
                const guard =
                    'ticketMetadata' in context
                        ? { signal: context.signal, isCurrent: context.isCurrent }
                        : context;
                assertCurrent(guard);
                const selectedMetadata = renewalMetadata(context.ticketMetadata);
                const uin = snapshot.uin;
                validate(snapshot, uin);
                // Serialize while the protocol's independent borrowed snapshot is current.
                bytes = encodeAccountPayload(snapshot, selectedMetadata);
                const expectedBinding = binding(uin);
                onState({ state: 'saving-account' });
                const prior = await vault.read(
                    expectedBinding,
                    (payload) => {
                        const previous = decodeAccountPayload(payload);

                        try {
                            validate(previous.session, uin);
                        } finally {
                            disposeWtPersistedSession(previous.session);
                        }
                    },
                    guard,
                );
                assertCurrent(guard);
                const revision = await vault.save(
                    expectedBinding,
                    bytes,
                    prior.kind === 'missing' ? null : prior.revision,
                    guard,
                );
                assertCurrent(guard);
                retained = { uin, revision: Object.freeze({ ...revision }) };
                metadata = selectedMetadata;
                onState({
                    state: 'account-saved',
                    accountRevision: revision.generation.toString(),
                });
            } catch (error) {
                failure = persistenceError(error);
                throw failure;
            } finally {
                bytes?.fill(0);
            }
        },
        async invalidate(context) {
            let started = false;

            try {
                const guard =
                    'ticketMetadata' in context
                        ? { signal: context.signal, isCurrent: context.isCurrent }
                        : context;
                assertCurrent(guard, true);

                if (invalidating) {
                    throw new DirectLoginError('account-store-busy');
                }

                terminal = true;
                metadata = null;
                const expected = retained;

                if (!expected) {
                    throw new DirectLoginError('account-store-missing');
                }

                if (!vault.invalidate) {
                    throw new DirectLoginError('account-store-invalidation-unsupported');
                }

                invalidating = true;
                started = true;
                await vault.invalidate(binding(expected.uin), expected.revision, guard);
                retained = undefined;

                try {
                    assertCurrent(guard, true);
                } catch {
                    throw new AccountVaultError('commit-uncertain');
                }
            } catch (error) {
                failure = persistenceError(error);
                throw failure;
            } finally {
                if (started) {
                    invalidating = false;
                }
            }
        },
    };

    return Object.freeze({
        checkpoint: Object.freeze(checkpoint),
        async load(uin: string, guard: VaultGuard): Promise<WtPersistedSessionV1> {
            let loaded: WtPersistedSessionV1 | undefined;
            let loadedMetadata: DirectAccountRenewalMetadata | null = null;

            try {
                assertCurrent(guard);
                const result = await vault.read(
                    binding(uin),
                    (payload) => {
                        const value = decodeAccountPayload(payload);

                        try {
                            validate(value.session, uin);
                            loaded = value.session;
                            loadedMetadata = value.metadata;
                            return value.session;
                        } catch (error) {
                            disposeWtPersistedSession(value.session);
                            throw error;
                        }
                    },
                    guard,
                );
                assertCurrent(guard);

                if (result.kind !== 'present') {
                    throw new DirectLoginError(`account-store-${result.kind}`);
                }

                retained = { uin, revision: Object.freeze({ ...result.revision }) };
                metadata = loadedMetadata;
                loaded = undefined; // Ownership is transferred only on this successful return.
                return result.value;
            } catch (error) {
                if (loaded) {
                    disposeWtPersistedSession(loaded);
                }

                failure = persistenceError(error);
                throw failure;
            }
        },
        getRenewalMetadata: () => (metadata ? Object.freeze({ ...metadata }) : null),
        getFailure: () => failure,
        close() {
            closed = true;
            retained = undefined;
            metadata = null;
            closing ??= (async () => {
                try {
                    await vault.close();
                } catch (error) {
                    failure = persistenceError(error);
                    throw failure;
                } finally {
                    device.fill(0);
                    deviceDigest.fill(0);
                    profileDigest.fill(0);
                }
            })();
            return closing;
        },
    });
}
