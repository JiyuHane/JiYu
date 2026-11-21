import { randomBytes, randomInt } from 'node:crypto';
import { isPromise, isProxy } from 'node:util/types';
import {
    startLocalQqSignWorker,
    LocalQqSignWorkerError,
    type LocalQqSignWorker,
} from '@snowluma/protocol/direct/local-qq-sign-worker';
import {
    createWtMultiplexReference,
    createWtRestoredMultiplexReference,
    type WtMultiplexReference,
    type WtMultiplexReferenceOptions,
    type WtRestoredMultiplexReference,
} from '@snowluma/protocol/direct/wt-multiplex-reference';
import { encodeWtQrD1Request } from '@snowluma/protocol/direct/wt-qr-protobuf';
import {
    disposeWtPersistedSession,
    type WtPersistedSessionV1,
} from '@snowluma/protocol/direct/wt-persisted-session';
import {
    createLoginPersistence,
    persistenceError,
    snapshotPersistenceOptions,
    snapshotRestoreOptions,
    type DirectAccountPersistenceOptions,
    type DirectAccountRenewalMetadata,
    type DirectAccountRestoreOptions,
    type LoginPersistence,
} from './account-persistence';
import { openAccountVault, AccountVaultError, type AccountVault } from './account-vault';
import { MAX_ONLINE_HOLD_MS, parseConfig, type DirectLoginConfig } from './config';
import {
    connectObserved,
    WIRE_LIMIT,
    type ObservedConnection,
    type ConnectionDiagnostics,
} from './connection';
import { DirectLoginError } from './errors';
import { LoginPolicy } from './policy';
import {
    loadDeviceGuid,
    loadExistingDeviceGuid,
    prepareQrDirectory,
    saveQrImage,
} from './private-files';

export type {
    DirectAccountPersistenceOptions,
    DirectAccountRenewalMetadata,
    DirectAccountRestoreOptions,
} from './account-persistence';

export type LoginState =
    | 'starting'
    | 'opening-account-store'
    | 'loading-account'
    | 'saving-account'
    | 'account-saved'
    | 'restoring'
    | 'connecting'
    | 'fetching'
    | 'qr-ready'
    | 'waiting-scan'
    | 'waiting-confirmation'
    | 'confirmed'
    | 'registering'
    | 'online'
    | 'failed'
    | 'closed';
export interface LoginEvent {
    state: LoginState;
    phase?: LoginState;
    /** Only the QR artifact path is intentionally exposed; never the native command/config. */
    qrImage?: string;
    /** Local durable generation only; never an account identifier or ticket. */
    accountRevision?: string;
    code?: string;
    workerCode?: string;
    ssoCode?: number;
    transportClose?: string;
    io?: ConnectionDiagnostics;
}
export interface DirectLoginPushOptions {
    /** Explicit independent body limit: 1..2 MiB; raw frames keep their existing limit. */
    readonly maxPushBodyBytes: number;
    /** Verified, post-registration delivery only. The borrowed body is wiped on
     * settlement or earlier on closure. Copy synchronously if it must be retained. */
    readonly onPushBody: NonNullable<WtMultiplexReferenceOptions['onPushBody']>;
}
export interface DirectLoginController {
    /** Existing owner, still bound to the same TCP connection and held login credentials. */
    readonly owner: WtMultiplexReference;
    readonly confirmedUin: string;
    readonly qrImage: string;
    readonly whenClosed: Promise<void>;
    getRenewalMetadata(): DirectAccountRenewalMetadata | null;
    close(): Promise<void>;
}

export interface DirectRestoredLoginController {
    readonly owner: WtRestoredMultiplexReference;
    readonly confirmedUin: string;
    readonly whenClosed: Promise<void>;
    getRenewalMetadata(): DirectAccountRenewalMetadata | null;
    close(): Promise<void>;
}

export interface ManagedDirectLoginOptions {
    /** Explicit finite raw-owner lifetime, including bootstrap; no automatic extension. */
    readonly leaseTimeoutMs: number;
    readonly persistence: DirectAccountPersistenceOptions;
    /** Synchronous, once-only account claim. Return undefined; asynchronous work is rejected. */
    readonly beforeRegister?: (uin: string) => void;
    readonly onEvent?: (event: LoginEvent) => void;
    readonly signal?: AbortSignal;
    readonly push?: DirectLoginPushOptions;
}

export interface ManagedDirectRestoreOptions extends Omit<
    ManagedDirectLoginOptions,
    'persistence'
> {
    readonly persistence: DirectAccountRestoreOptions;
}

interface ManagedRunOptions {
    readonly leaseTimeoutMs: number;
    readonly beforeRegister?: (uin: string) => void;
}

type QrMode = { kind: 'qr'; persistence?: DirectAccountPersistenceOptions };
type RestoreMode = {
    kind: 'restore';
    persistence: DirectAccountPersistenceOptions;
    uin: string;
};
type LoginMode = QrMode | RestoreMode;

const diagnosticCloseCodes = new Set([
    'raw-timeout',
    'raw-rejected',
    'raw-cancelled',
    'raw-write-failed',
    'raw-build-failed',
    'frame-assembly-timeout',
    'frame-rejected',
    'frame-handler-failed',
    'push-handler-failed',
    'push-capacity',
    'push-rejected',
    'unexpected-response',
    'invalid-stream',
    'truncated-stream',
    'stream-error',
    'stream-closed',
    'remote-end',
    'local-close',
    'sequence-exhausted',
]);

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(new DirectLoginError('aborted'));
        };

        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, milliseconds);
        signal.addEventListener('abort', onAbort, { once: true });

        if (signal.aborted) {
            onAbort();
        }
    });
}

function snapshotPushOptions(
    input: DirectLoginPushOptions | undefined,
): Pick<WtMultiplexReferenceOptions, 'onPushBody' | 'maxPushBodyBytes'> {
    if (input === undefined) {
        return {};
    }

    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new DirectLoginError('configuration');
    }

    const { onPushBody, maxPushBodyBytes } = input;

    if (
        typeof onPushBody !== 'function' ||
        !Number.isSafeInteger(maxPushBodyBytes) ||
        maxPushBodyBytes < 1 ||
        maxPushBodyBytes > WIRE_LIMIT
    ) {
        throw new DirectLoginError('configuration');
    }

    return { onPushBody, maxPushBodyBytes };
}

/** Explicit effects only. No message or heartbeat is sent automatically. The successful
 * owner can be reused during onlineHoldMs (<=15 minutes). Body delivery is opt-in. */
export async function startDirectLogin(
    config: DirectLoginConfig,
    onEvent: (event: LoginEvent) => void = () => {},
    signal?: AbortSignal,
    push?: DirectLoginPushOptions,
    persistence?: DirectAccountPersistenceOptions,
): Promise<DirectLoginController> {
    const selected = snapshotPersistenceOptions(persistence);
    // A persistent identity must be bound to the same immutable profile that is used
    // after asynchronous resource acquisition, rather than a later caller mutation.
    const effective = selected ? parseConfig(config, process.cwd()) : config;
    return runDirectLogin(effective, { kind: 'qr', persistence: selected }, onEvent, signal, push);
}

/** Explicit saved-ticket registration on a new connection. No QR fallback or business replay. */
export async function restoreDirectLogin(
    config: DirectLoginConfig,
    options: DirectAccountRestoreOptions,
    onEvent: (event: LoginEvent) => void = () => {},
    signal?: AbortSignal,
    push?: DirectLoginPushOptions,
): Promise<DirectRestoredLoginController> {
    const { uin, ...persistence } = snapshotRestoreOptions(options);
    const effective = parseConfig(config, process.cwd());
    return runDirectLogin(effective, { kind: 'restore', persistence, uin }, onEvent, signal, push);
}

function snapshotManagedOptions(input: ManagedDirectLoginOptions | ManagedDirectRestoreOptions) {
    if (!input || typeof input !== 'object' || isProxy(input)) {
        throw new DirectLoginError('configuration');
    }

    const prototype = Object.getPrototypeOf(input);
    const keys = ['leaseTimeoutMs', 'persistence', 'beforeRegister', 'onEvent', 'signal', 'push'];

    if (prototype !== Object.prototype && prototype !== null) {
        throw new DirectLoginError('configuration');
    }

    for (const key of Reflect.ownKeys(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);

        if (
            typeof key !== 'string' ||
            !keys.includes(key) ||
            !descriptor ||
            !('value' in descriptor)
        ) {
            throw new DirectLoginError('configuration');
        }
    }

    const selected = { ...input };

    if (
        !Number.isSafeInteger(selected.leaseTimeoutMs) ||
        selected.leaseTimeoutMs < 1 ||
        selected.leaseTimeoutMs > 0x7fffffff ||
        (selected.beforeRegister !== undefined && typeof selected.beforeRegister !== 'function') ||
        (selected.onEvent !== undefined && typeof selected.onEvent !== 'function')
    ) {
        throw new DirectLoginError('configuration');
    }

    if (selected.signal !== undefined) {
        try {
            if (isProxy(selected.signal)) {
                throw new Error();
            }

            Reflect.apply(
                Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!,
                selected.signal,
                [],
            );
        } catch {
            throw new DirectLoginError('configuration');
        }
    }

    // Retain no mutable options container while acquiring the account store or network.
    const push = selected.push === undefined ? undefined : snapshotPushOptions(selected.push);
    return Object.freeze({
        ...selected,
        push:
            push === undefined
                ? undefined
                : Object.freeze({
                      onPushBody: push.onPushBody!,
                      maxPushBodyBytes: push.maxPushBodyBytes!,
                  }),
    });
}

/** Persistent managed QR login. The external manager owns shutdown/reconnect policy;
 * this entry only replaces onlineHoldMs with an explicit finite raw-owner lease. */
export async function startManagedDirectLogin(
    config: DirectLoginConfig,
    options: ManagedDirectLoginOptions,
): Promise<DirectLoginController> {
    const selected = snapshotManagedOptions(options);
    const persistence = snapshotPersistenceOptions(selected.persistence);

    if (!persistence) {
        throw new DirectLoginError('configuration');
    }

    return runDirectLogin(
        parseConfig(config, process.cwd()),
        { kind: 'qr', persistence },
        selected.onEvent ?? (() => {}),
        selected.signal,
        selected.push,
        selected,
    );
}

/** Managed saved-ticket registration; still no QR fallback, heartbeat or ticket renewal. */
export async function restoreManagedDirectLogin(
    config: DirectLoginConfig,
    options: ManagedDirectRestoreOptions,
): Promise<DirectRestoredLoginController> {
    const selected = snapshotManagedOptions(options);
    const { uin, ...persistence } = snapshotRestoreOptions(selected.persistence);
    return runDirectLogin(
        parseConfig(config, process.cwd()),
        { kind: 'restore', persistence, uin },
        selected.onEvent ?? (() => {}),
        selected.signal,
        selected.push,
        selected,
    );
}

function runDirectLogin(
    config: DirectLoginConfig,
    mode: QrMode,
    onEvent: (event: LoginEvent) => void,
    signal?: AbortSignal,
    push?: DirectLoginPushOptions,
    managed?: ManagedRunOptions,
): Promise<DirectLoginController>;
function runDirectLogin(
    config: DirectLoginConfig,
    mode: RestoreMode,
    onEvent: (event: LoginEvent) => void,
    signal?: AbortSignal,
    push?: DirectLoginPushOptions,
    managed?: ManagedRunOptions,
): Promise<DirectRestoredLoginController>;

async function runDirectLogin(
    config: DirectLoginConfig,
    mode: LoginMode,
    onEvent: (event: LoginEvent) => void,
    signal?: AbortSignal,
    push?: DirectLoginPushOptions,
    managed?: ManagedRunOptions,
): Promise<DirectLoginController | DirectRestoredLoginController> {
    // Snapshot before callbacks and resource acquisition. The configuration's maximum
    // attempt (600000) + hold (900000) remains below the owner's 0x7fffffff lease cap.
    const onlineHoldMs = config.onlineHoldMs;
    const pushOptions = snapshotPushOptions(push);

    if (
        !Number.isSafeInteger(onlineHoldMs) ||
        onlineHoldMs < 0 ||
        onlineHoldMs > MAX_ONLINE_HOLD_MS
    ) {
        throw new DirectLoginError('configuration');
    }

    const end = performance.now() + config.attemptTimeoutMs;
    const abortController = new AbortController();
    let timedOut = false;
    let handedOff = false;
    let resourceStopped = false;
    let transportClose: string | undefined;
    let signer: LocalQqSignWorker | undefined;
    let connection: ObservedConnection | undefined;
    let owner: WtMultiplexReference | WtRestoredMultiplexReference | undefined;
    let policy: LoginPolicy | undefined;
    let vault: AccountVault | undefined;
    let persistence: LoginPersistence | undefined;
    let restored: WtPersistedSessionV1 | undefined;
    let closePromise: Promise<void> | undefined;
    const acquisitions = new Set<Promise<unknown>>();
    let onlineTimer: ReturnType<typeof setTimeout> | undefined;
    let guid: Uint8Array | undefined;
    let randomKey: Uint8Array | undefined;
    let resolveClosed!: () => void;
    let rejectClosed!: (error: unknown) => void;
    const whenClosed = new Promise<void>((resolve, reject) => {
        resolveClosed = resolve;
        rejectClosed = reject;
    });
    void whenClosed.catch(() => {});
    let phase: LoginState = 'starting';

    const emit = (event: LoginEvent) => {
        if (event.state !== 'failed' && event.state !== 'closed') {
            phase = event.state;
        }

        try {
            onEvent(Object.freeze(event));
        } catch {
            throw new DirectLoginError('event-sink');
        }
    };

    const close = (): Promise<void> => {
        closePromise ??= Promise.resolve().then(async () => {
            clearTimeout(attemptTimer);
            clearTimeout(onlineTimer);
            signal?.removeEventListener('abort', onAbort);
            abortController.abort();
            // No new acquisitions start once closePromise is set. Each accepted resource
            // is assigned before its acquisition settles, so cleanup also owns late arrivals.
            await Promise.allSettled([...acquisitions]);

            try {
                // A failing close must not let the other physical resources escape the barrier.
                const results = await Promise.allSettled([
                    Promise.resolve().then(() => owner?.close()),
                    Promise.resolve().then(() => {
                        connection?.destroy();
                        return connection?.whenClosed;
                    }),
                    Promise.resolve().then(() => signer?.close()),
                    Promise.resolve().then(() =>
                        persistence ? persistence.close() : vault?.close(),
                    ),
                ]);
                const stored = results[3];

                if (stored.status === 'rejected') {
                    throw persistenceError(stored.reason);
                }

                if (results.some((result) => result.status === 'rejected')) {
                    throw new DirectLoginError('cleanup-failed');
                }
            } catch (error) {
                const failure =
                    error instanceof DirectLoginError
                        ? error
                        : new DirectLoginError('cleanup-failed');

                try {
                    emit({
                        state: 'failed',
                        code: failure.code,
                        phase,
                        transportClose,
                        io: connection?.getDiagnostics(),
                    });
                } catch {
                    /* the original close failure remains observable through both promises */
                }

                throw failure;
            } finally {
                guid?.fill(0);
                randomKey?.fill(0);

                if (restored) {
                    disposeWtPersistedSession(restored);
                    restored = undefined;
                }
            }

            try {
                emit({ state: 'closed', transportClose, io: connection?.getDiagnostics() });
            } catch {
                /* cleanup has already finished */
            }
        });
        void closePromise.then(resolveClosed, rejectClosed);
        return closePromise;
    };

    const onAbort = () => {
        void close().catch(() => {});
    };

    const onResourceClosed = () => {
        resourceStopped = true;

        // During bootstrap the pending owner operation must settle its typed business
        // failure before cleanup aborts its signal. Its catch path performs cleanup.
        if (handedOff) {
            onAbort();
        }
    };

    const attemptTimer = setTimeout(() => {
        timedOut = true;
        onAbort();
    }, config.attemptTimeoutMs);

    const check = () => {
        if (
            signal?.aborted ||
            abortController.signal.aborted ||
            closePromise ||
            performance.now() >= end
        ) {
            throw new DirectLoginError(
                timedOut || performance.now() >= end ? 'attempt-timeout' : 'aborted',
            );
        }

        if (resourceStopped) {
            throw new DirectLoginError('session-closed');
        }
    };

    const claimAccount = (uin: string): void => {
        const claim = managed?.beforeRegister;

        if (!claim) {
            return;
        }

        check();

        try {
            const result: unknown = claim(uin);

            if (result !== undefined) {
                // A forbidden async callback never holds up cleanup. Observe rejections
                // (including thenables) but do not turn its eventual result into a claim.
                try {
                    const pending = isPromise(result)
                        ? result
                        : new Promise<unknown>((resolve) => resolve(result));
                    void Promise.prototype.then.call(
                        pending,
                        () => {},
                        () => {},
                    );
                } catch {
                    // The fixed claim failure below remains the observable result.
                }

                throw new DirectLoginError('before-register');
            }
        } catch {
            throw new DirectLoginError('before-register');
        }

        check();
    };

    const remaining = () => {
        check();
        return Math.max(1, Math.ceil(end - performance.now()));
    };

    const acquire = async <T>(
        operation: () => Promise<T>,
        accept: (value: T) => void,
    ): Promise<T> => {
        check();
        const pending = operation().then((value) => {
            accept(value);
            return value;
        });
        acquisitions.add(pending);

        try {
            return await pending;
        } finally {
            acquisitions.delete(pending);
        }
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    try {
        check();
        emit({ state: 'starting' });

        if (mode.persistence) {
            emit({ state: 'opening-account-store' });
            // The vault rejects an unsupported platform before any state/QR path is touched.
            vault = await acquire(
                () => openAccountVault({ ...mode.persistence!, initialize: mode.kind === 'qr' }),
                (value) => {
                    vault = value;
                },
            );
            check();
        }

        guid = await acquire(
            async () => {
                if (mode.kind === 'restore') {
                    return loadExistingDeviceGuid(config.statePath);
                }

                await prepareQrDirectory(config.outDir);
                check();
                return loadDeviceGuid(config.statePath);
            },
            (value) => {
                guid = value;
            },
        );
        check();

        if (vault) {
            persistence = createLoginPersistence(vault, config, guid, emit);
        }

        if (mode.kind === 'restore') {
            if (!persistence) {
                throw new DirectLoginError('account-store-missing');
            }

            emit({ state: 'loading-account' });
            const store = persistence;
            restored = await acquire(
                () =>
                    store.load(mode.uin, {
                        signal: abortController.signal,
                        isCurrent: () =>
                            !closePromise &&
                            !resourceStopped &&
                            !abortController.signal.aborted &&
                            performance.now() < end,
                    }),
                (value) => {
                    restored = value;
                },
            );
            check();
            claimAccount(mode.uin);
        }

        signer = await acquire(
            () =>
                startLocalQqSignWorker({
                    ...config.signer,
                    startupTimeoutMs: Math.min(config.signer.startupTimeoutMs, remaining()),
                }),
            (value) => {
                signer = value;
            },
        );
        check();
        void signer.whenClosed.then(onResourceClosed);
        emit({ state: 'connecting' });
        connection = await acquire(
            () =>
                connectObserved(
                    config.gateway,
                    Math.min(config.connectTimeoutMs, remaining()),
                    abortController.signal,
                ),
            (value) => {
                connection = value;
            },
        );
        check();
        void connection.whenClosed.then(onResourceClosed);
        policy = new LoginPolicy(connection, signer, config);
        const p = config.profile;
        const common = {
            exclusiveConnected: true as const,
            initialSequence: randomInt(1, 0x7fffffff),
            maxFrameBytes: WIRE_LIMIT,
            maxBufferedBytes: WIRE_LIMIT * 2,
            maxFrames: 32,
            maxPushFrames: 32,
            maxPushBytes: WIRE_LIMIT * 2,
            maxWriteBufferBytes: WIRE_LIMIT,
            leaseTimeoutMs: managed?.leaseTimeoutMs ?? remaining() + onlineHoldMs,
            verifyPushRaw: policy.verifyPushRaw,
            onPush: () => {},
            ...pushOptions,
        };
        const registration = {
            version: p.currentVersion,
            deviceName: p.deviceName,
            deviceType: p.deviceType,
            vendorOs: p.vendorOs,
            random: randomInt(0x7fffffff),
        };

        const observeOwner = (active: WtMultiplexReference | WtRestoredMultiplexReference) => {
            void active.whenClosed.then((reason) => {
                transportClose = diagnosticCloseCodes.has(reason.code) ? reason.code : 'other';
                onResourceClosed();
            });
        };

        let confirmedUin: string;
        let qrImage: string | undefined;

        if (mode.kind === 'restore') {
            if (!restored || !persistence) {
                throw new DirectLoginError('account-store-missing');
            }

            const store = persistence;
            confirmedUin = mode.uin;
            signer.bindUin(confirmedUin);
            policy.initializeRestoredAccount(confirmedUin);
            emit({ state: 'restoring' });
            check();
            const restoredOwner = createWtRestoredMultiplexReference(connection, {
                ...common,
                transportUin: confirmedUin,
                session: {
                    persisted: restored,
                    profile: { subAppId: p.subAppId, version: p.currentVersion },
                    registration,
                    timeoutMs: config.transactionTimeoutMs,
                    restoreTimeoutMs: remaining(),
                    signal: abortController.signal,
                    buildRegisterReserved: policy.buildRegisterReserved,
                    verifyRegisterRaw: policy.verifyRegisterRaw,
                    renewalCheckpoint: store.checkpoint,
                },
            });
            owner = restoredOwner;
            // The owner made its own checked copy; drop the decoded disk copy immediately.
            disposeWtPersistedSession(restored);
            restored = undefined;
            observeOwner(restoredOwner);
            const result = await restoredOwner.restoreAndRegister();

            if (result.status !== 'success') {
                throw new DirectLoginError(`restore-${result.status}`);
            }
        } else {
            randomKey = randomBytes(16);
            const qrOwner = createWtMultiplexReference(connection, {
                ...common,
                transportUin: '0',
                session: {
                    profile: {
                        uin: '0',
                        appId: p.appId,
                        subAppId: p.subAppId,
                        clientVersion: p.clientVersion,
                        ssoVersion: p.currentVersion,
                        guid,
                        unknown21: Buffer.from(p.unknown21Hex, 'hex'),
                        randomKey,
                        peerPublicKey: Buffer.from(p.peerPublicKeyHex, 'hex'),
                        qrCommand: p.qrCommand,
                        loginCommand: p.loginCommand,
                    },
                    timeoutMs: config.transactionTimeoutMs,
                    attemptTimeoutMs: remaining(),
                    signal: abortController.signal,
                    getTimestamp: () => Math.floor(Date.now() / 1000),
                    buildWtReserved: policy.buildWtReserved,
                    verifyRaw: policy.verifyRaw,
                    verifyContext: policy.verifyContext,
                    sliceBusiness: policy.sliceBusiness,
                    registration,
                    buildRegisterReserved: policy.buildRegisterReserved,
                    verifyRegisterRaw: policy.verifyRegisterRaw,
                    ...(persistence ? { checkpoint: persistence.checkpoint } : {}),
                },
            });
            owner = qrOwner;
            observeOwner(qrOwner);
            emit({ state: 'fetching' });
            check();
            const d1 = encodeWtQrD1Request({ deviceType: p.os, deviceName: p.deviceName });

            try {
                const qr = await qrOwner.fetch({
                    packageName: p.packageName,
                    ptVersion: p.ptVersion,
                    miscBitMap: p.miscBitMap,
                    ssoVersion: p.ssoVersion,
                    d1,
                });

                try {
                    qrImage = await acquire(
                        () => saveQrImage(config.outDir, qr.image),
                        () => {},
                    );
                } finally {
                    qr.image.fill(0);
                }
            } finally {
                d1.fill(0);
            }

            check();
            emit({ state: 'qr-ready', qrImage });

            for (;;) {
                await pause(2000, abortController.signal);
                check();
                policy.phase = 'poll';
                const result = await qrOwner.poll();

                // Terminal poll results may close their owner before this continuation runs.
                // Preserve that verified business result instead of masking it as session-closed.
                if (
                    result.status !== 'confirmed' &&
                    result.status !== 'wait' &&
                    result.status !== 'confirm'
                ) {
                    throw new DirectLoginError(`qr-${result.status}`);
                }

                check();

                if (result.status === 'confirmed') {
                    break;
                }

                emit({ state: result.status === 'wait' ? 'waiting-scan' : 'waiting-confirmation' });
            }

            const confirmed = policy.confirmedUin;

            if (!confirmed) {
                throw new DirectLoginError('missing-confirmed-account');
            }

            confirmedUin = confirmed;
            claimAccount(confirmedUin);
            signer.bindUin(confirmedUin);
            emit({ state: 'confirmed' });
            policy.phase = 'login';
            emit({ state: 'registering' });
            const apkSignature = Buffer.from(p.apkSignatureHex, 'hex');
            const tlv124Value = Buffer.from(p.tlv124Hex, 'hex');

            try {
                const result = await qrOwner.loginAndRegister({
                    mainSigMap: p.mainSigMap,
                    miscBitMap: p.miscBitMap,
                    subSigMap: p.subSigMap,
                    packageName: p.packageName,
                    ptVersion: p.ptVersion,
                    sdkVersion: p.sdkVersion,
                    os: p.os,
                    deviceName: p.deviceName,
                    apkSignature,
                    tlv124Value,
                });

                if (result.status !== 'success') {
                    throw new DirectLoginError(`login-${result.status}`);
                }
            } finally {
                apkSignature.fill(0);
                tlv124Value.fill(0);
            }
        }

        check();

        if (!owner || owner.getState() !== 'success') {
            throw new DirectLoginError('registration-state');
        }

        policy.assertRegistrationCommand();
        const getRenewalMetadata = (): DirectAccountRenewalMetadata | null =>
            persistence?.getRenewalMetadata() ?? null;
        let controller: DirectLoginController | DirectRestoredLoginController;

        if ('restoreAndRegister' in owner) {
            controller = Object.freeze({
                owner,
                confirmedUin,
                whenClosed,
                getRenewalMetadata,
                close,
            });
        } else {
            if (qrImage === undefined) {
                throw new DirectLoginError('qr-image');
            }

            controller = Object.freeze({
                owner,
                confirmedUin,
                qrImage,
                whenClosed,
                getRenewalMetadata,
                close,
            });
        }

        clearTimeout(attemptTimer);

        if (!managed) {
            onlineTimer = setTimeout(onAbort, onlineHoldMs);
        }

        handedOff = true;
        emit({ state: 'online' });
        return controller;
    } catch (error) {
        const code = timedOut
            ? 'attempt-timeout'
            : error instanceof LocalQqSignWorkerError
              ? `signer-${error.code}`
              : error instanceof AccountVaultError
                ? persistenceError(error).code
                : error instanceof DirectLoginError
                  ? error.code
                  : (persistence?.getFailure()?.code ?? policy?.failure ?? 'protocol-or-transport');

        try {
            emit({
                state: 'failed',
                phase,
                code,
                workerCode: error instanceof LocalQqSignWorkerError ? error.workerCode : undefined,
                ssoCode: policy?.ssoCode,
                transportClose,
                io: connection?.getDiagnostics(),
            });
        } finally {
            await close();
        }

        throw new DirectLoginError(code, { cause: error });
    }
}
