/// <reference types="node" />
/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest';
import type { DirectAccountStatus, DirectOperationKind } from '@snowluma/common/direct-account';
import {
    ManagedDirectAccountDriverError,
    ManagedDirectAccountService,
    createUnavailableManagedDirectAccountService,
    type ManagedDirectAccountDriver,
    type ManagedDirectAccountDriverCallbacks,
    type ManagedDirectAccountQr,
    type ManagedDirectAccountUpdate,
} from '../src/direct/managed-service';
import { DirectOperationRegistry } from '../src/direct/operation-registry';
import { DirectServiceError, type DirectRequestScope } from '../src/direct/service-contract';

const OWNER_A = 'a'.repeat(64);
const OWNER_B = 'b'.repeat(64);
const REVISION_A = '1'.repeat(32);
const REVISION_B = '2'.repeat(32);
const SESSION = '3'.repeat(32);
const PNG = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);

function operationKey(index: number): string {
    return `${index.toString(16).padStart(8, '0')}-0000-4000-8000-${index
        .toString(16)
        .padStart(12, '0')}`;
}

function scope(owner = OWNER_A, current: () => boolean = () => true): DirectRequestScope {
    return { owner, expiresAt: Date.now() + 60_000, isCurrent: current };
}

function status(id = 'main', overrides: Partial<DirectAccountStatus> = {}): DirectAccountStatus {
    return {
        id,
        label: `Fixture ${id}`,
        protocol: 'linux',
        revision: id === 'main' ? REVISION_A : REVISION_B,
        generation: null,
        uin: null,
        phase: 'stopped',
        online: false,
        onebotReady: false,
        receiveHealthy: false,
        hasStoredAccount: true,
        autoRestore: false,
        autoRenew: false,
        canRenew: false,
        renewAt: null,
        lastRenewedAt: null,
        retryAt: null,
        error: null,
        operationId: null,
        capabilities: [],
        ...overrides,
    };
}

function cloneStatus(value: DirectAccountStatus): DirectAccountStatus {
    return { ...value, capabilities: [...value.capabilities] };
}

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

async function turns(count = 1): Promise<void> {
    for (let index = 0; index < count; index++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await Promise.resolve();
    }
}

interface BeginCall {
    kind: DirectOperationKind;
    generation: string;
    callbacks: ManagedDirectAccountDriverCallbacks;
}

class FakeDriver implements ManagedDirectAccountDriver {
    readonly beginCalls: BeginCall[] = [];
    readonly cancelCalls: string[] = [];
    readonly qrCalls: string[] = [];
    disposeCalls = 0;
    snapshotCalls = 0;
    current: DirectAccountStatus;
    beginEffect: (
        kind: DirectOperationKind,
        generation: string,
        callbacks: ManagedDirectAccountDriverCallbacks,
    ) => Promise<void> = async () => {};
    cancelEffect: (generation: string) => void = () => {};
    qrEffect: (generation: string) => Promise<ManagedDirectAccountQr> = async () => ({
        bytes: new Uint8Array(PNG),
        contentType: 'image/png',
    });
    disposeEffect: () => Promise<void> = async () => {};

    constructor(initial: DirectAccountStatus = status()) {
        this.current = cloneStatus(initial);
    }

    snapshot(): DirectAccountStatus {
        this.snapshotCalls++;
        return cloneStatus(this.current);
    }

    begin(
        kind: DirectOperationKind,
        generation: string,
        callbacks: ManagedDirectAccountDriverCallbacks,
    ): Promise<void> {
        this.beginCalls.push({ kind, generation, callbacks });
        return this.beginEffect(kind, generation, callbacks);
    }

    cancel(generation: string): void {
        this.cancelCalls.push(generation);
        this.cancelEffect(generation);
    }

    qr(generation: string): Promise<ManagedDirectAccountQr> {
        this.qrCalls.push(generation);
        return this.qrEffect(generation);
    }

    dispose(): Promise<void> {
        this.disposeCalls++;
        return this.disposeEffect();
    }

    publish(call: BeginCall, update: ManagedDirectAccountUpdate): void {
        call.callbacks.update(update);
    }
}

function service(
    drivers: readonly FakeDriver[],
    options: ConstructorParameters<typeof ManagedDirectAccountService>[1] = {},
): ManagedDirectAccountService {
    return new ManagedDirectAccountService(drivers, { autoStart: false, ...options });
}

function control(revision: string, key = 1) {
    return { expectedRevision: revision, operationKey: operationKey(key) };
}

function errorCode(action: () => unknown): string | undefined {
    try {
        action();
        return undefined;
    } catch (error) {
        return error instanceof DirectServiceError ? error.code : undefined;
    }
}

async function asyncErrorCode(action: () => Promise<unknown>): Promise<string | undefined> {
    try {
        await action();
        return undefined;
    } catch (error) {
        return error instanceof DirectServiceError ? error.code : undefined;
    }
}

describe('managed direct account service projection and availability', () => {
    it('lists multiple admin-wide accounts while keeping operation ids owner-scoped', async () => {
        const first = new FakeDriver(status('main', { operationId: 'f'.repeat(32) }));
        const second = new FakeDriver(status('second', { label: 'Second account' }));
        const managed = service([first, second]);
        const accepted = managed.start('main', { mode: 'qr', ...control(REVISION_A) }, scope());

        expect(accepted.account).toMatchObject({
            id: 'main',
            phase: 'starting',
            generation: accepted.operation.generation,
            operationId: accepted.operation.id,
        });
        expect(accepted.account.revision).not.toBe(REVISION_A);
        expect(first.beginCalls).toHaveLength(0);
        expect(managed.list(scope()).accounts.map((account) => account.id)).toEqual([
            'main',
            'second',
        ]);
        expect(managed.list(scope(OWNER_B)).accounts[0]?.operationId).toBeNull();
        expect(managed.get('second', scope(OWNER_B)).account.label).toBe('Second account');
        await managed.dispose();
    });

    it.each([
        ['unsupported-platform', false],
        ['not-configured', true],
    ] as const)('represents %s without a fake configured account', async (reason, supported) => {
        const managed = createUnavailableManagedDirectAccountService(reason);
        expect(managed.list(scope())).toEqual({
            supported,
            configured: false,
            reason,
            accounts: [],
        });
        expect(() => managed.get('main', scope())).toThrow(DirectServiceError);
        expect(errorCode(() => managed.get('main', scope()))).toBe(reason);
        await managed.dispose();
    });

    it('requires a current, well-formed scope even for admin-wide list', async () => {
        const driver = new FakeDriver();
        const managed = service([driver]);
        expect(errorCode(() => managed.list(scope(OWNER_A, () => false)))).toBe('scope-expired');
        expect(errorCode(() => managed.list(scope('short')))).toBe('invalid-request');
        expect(driver.beginCalls).toHaveLength(0);
        await managed.dispose();
    });
});

describe('managed operation reservation, deduplication and preflight', () => {
    it('deduplicates exact retries before CAS without replaying the driver', async () => {
        const gate = deferred();
        const driver = new FakeDriver();

        driver.beginEffect = (_kind, generation) => {
            driver.current.generation = generation;
            driver.current.phase = 'starting';
            return gate.promise;
        };

        const managed = service([driver]);
        const request = { mode: 'qr' as const, ...control(REVISION_A) };
        const first = managed.start('main', request, scope());
        const retry = managed.start('main', request, scope());
        expect(retry.operation).toEqual(first.operation);
        expect(retry.account.revision).toBe(first.account.revision);
        expect(driver.beginCalls).toHaveLength(0);

        await turns();
        expect(driver.beginCalls).toHaveLength(1);
        const call = driver.beginCalls[0]!;
        driver.publish(call, { phase: 'qr-ready', qrAvailable: true, error: null });
        await turns();
        const running = managed.operation(first.operation.id, scope()).operation;
        expect(running).toMatchObject({ phase: 'qr-ready', qrAvailable: true, status: 'running' });
        expect(managed.start('main', request, scope()).operation).toEqual(running);
        expect(driver.beginCalls).toHaveLength(1);

        driver.current = {
            ...driver.current,
            phase: 'online',
            online: true,
            onebotReady: true,
            receiveHealthy: true,
        };
        gate.resolve();
        await turns();
        const terminal = managed.operation(first.operation.id, scope()).operation;
        expect(terminal).toMatchObject({ status: 'succeeded', phase: 'online' });

        driver.current = { ...driver.current, phase: 'backoff', online: false };
        driver.publish(call, {
            phase: 'backoff',
            qrAvailable: false,
            error: 'protocol-or-transport',
        });
        await turns();
        expect(managed.get('main', scope()).account).toMatchObject({
            phase: 'backoff',
            error: 'protocol-or-transport',
        });
        expect(managed.operation(first.operation.id, scope()).operation).toEqual(terminal);
        await managed.dispose();
    });

    it('rejects operation-key reuse with another kind or revision before busy/CAS checks', async () => {
        const gate = deferred();
        const driver = new FakeDriver();
        driver.beginEffect = () => gate.promise;
        const managed = service([driver]);
        const first = managed.start('main', { mode: 'qr', ...control(REVISION_A, 2) }, scope());
        expect(
            errorCode(() =>
                managed.start('main', { mode: 'restore', ...control(REVISION_A, 2) }, scope()),
            ),
        ).toBe('operation-key-conflict');
        expect(
            errorCode(() =>
                managed.start(
                    'main',
                    { mode: 'qr', ...control(first.account.revision, 2) },
                    scope(),
                ),
            ),
        ).toBe('operation-key-conflict');
        await managed.dispose();
        gate.resolve();
    });

    it('enforces revision CAS, one HTTP operation, and start/restore/renew preflights', async () => {
        const gate = deferred();
        const driver = new FakeDriver();
        driver.beginEffect = () => gate.promise;
        const managed = service([driver]);
        const first = managed.start('main', { mode: 'qr', ...control(REVISION_A, 3) }, scope());
        expect(errorCode(() => managed.stop('main', control(REVISION_A, 4), scope()))).toBe(
            'revision-conflict',
        );
        expect(
            errorCode(() => managed.stop('main', control(first.account.revision, 4), scope())),
        ).toBe('account-busy');
        await managed.dispose();
        gate.resolve();

        const missing = new FakeDriver(status('missing', { hasStoredAccount: false }));
        const missingService = service([missing]);
        expect(
            errorCode(() =>
                missingService.start(
                    'missing',
                    { mode: 'restore', ...control(REVISION_B, 5) },
                    scope(),
                ),
            ),
        ).toBe('needs-login');
        await missingService.dispose();

        const online = new FakeDriver(
            status('online', {
                revision: REVISION_B,
                generation: SESSION,
                phase: 'online',
                online: true,
                canRenew: false,
            }),
        );
        const onlineService = service([online]);
        expect(
            errorCode(() =>
                onlineService.start('online', { mode: 'qr', ...control(REVISION_B, 6) }, scope()),
            ),
        ).toBe('account-busy');
        expect(
            errorCode(() => onlineService.renew('online', control(REVISION_B, 7), scope())),
        ).toBe('renewal-unavailable');
        online.current.canRenew = true;
        const renewed = onlineService.renew('online', control(REVISION_B, 8), scope());
        expect(renewed.operation.generation).toBe(SESSION);
        expect(renewed.account.generation).toBe(SESSION);
        await onlineService.dispose();
    });

    it('accepts an offline stop with an ephemeral operation generation but null account generation', async () => {
        const driver = new FakeDriver(status('offline', { revision: REVISION_B }));

        driver.beginEffect = async (kind) => {
            expect(kind).toBe('stop');
            driver.current.phase = 'stopped';
        };

        const managed = service([driver]);
        const accepted = managed.stop('offline', control(REVISION_B, 9), scope());
        expect(accepted.operation.generation).toMatch(/^[0-9a-f]{32}$/);
        expect(accepted.account).toMatchObject({ generation: null, phase: 'stopping' });
        await turns();
        expect(managed.operation(accepted.operation.id, scope()).operation).toMatchObject({
            status: 'succeeded',
            phase: 'stopped',
        });
        expect(managed.get('offline', scope()).account.generation).toBeNull();
        await managed.dispose();
    });

    it('reports bounded registry capacity before a second driver is dispatched', async () => {
        const gate = deferred();
        const first = new FakeDriver(status('first', { revision: REVISION_A }));
        const second = new FakeDriver(status('second', { revision: REVISION_B }));
        first.beginEffect = () => gate.promise;
        const managed = service([first, second], {
            registry: new DirectOperationRegistry({ maxRecords: 1 }),
        });
        managed.start('first', { mode: 'qr', ...control(REVISION_A, 10) }, scope());
        expect(
            errorCode(() =>
                managed.start('second', { mode: 'qr', ...control(REVISION_B, 11) }, scope()),
            ),
        ).toBe('operation-capacity');
        await turns();
        expect(first.beginCalls).toHaveLength(1);
        expect(second.beginCalls).toHaveLength(0);
        const closing = managed.dispose();
        gate.resolve();
        await closing;
    });
});

describe('owner-scoped cancellation and QR ownership', () => {
    it('lets only the operation owner cancel and waits for the real begin drain', async () => {
        const gate = deferred();
        const driver = new FakeDriver();

        driver.beginEffect = (_kind, generation) => {
            driver.current.generation = generation;
            driver.current.phase = 'starting';
            return gate.promise;
        };

        const managed = service([driver]);
        const accepted = managed.start('main', { mode: 'qr', ...control(REVISION_A, 12) }, scope());
        await turns();
        expect(errorCode(() => managed.cancel(accepted.operation.id, scope(OWNER_B)))).toBe(
            'operation-not-found',
        );
        expect(driver.cancelCalls).toHaveLength(0);

        const cancelled = managed.cancel(accepted.operation.id, scope());
        expect(cancelled.operation).toMatchObject({ status: 'running', qrAvailable: false });
        expect(driver.cancelCalls).toEqual([accepted.operation.generation]);
        expect(managed.operation(accepted.operation.id, scope()).operation.status).toBe('running');
        gate.resolve();
        await turns();
        const terminal = managed.operation(accepted.operation.id, scope()).operation;
        expect(terminal.status).toBe('cancelled');
        managed.cancel(accepted.operation.id, scope());
        expect(driver.cancelCalls).toHaveLength(1);
        await managed.dispose();
    });

    it('transfers successful QR ownership and wipes bytes when ownership becomes stale', async () => {
        const gate = deferred();
        const driver = new FakeDriver();

        driver.beginEffect = (_kind, generation) => {
            driver.current.generation = generation;
            return gate.promise;
        };

        const managed = service([driver]);
        const accepted = managed.start('main', { mode: 'qr', ...control(REVISION_A, 13) }, scope());
        await turns();
        const call = driver.beginCalls[0]!;
        driver.publish(call, { phase: 'qr-ready', qrAvailable: true, error: null });
        await turns();

        const owned = new Uint8Array(PNG);
        driver.qrEffect = async () => ({ bytes: owned, contentType: 'image/png' });
        const transferred = await managed.qr(accepted.operation.id, scope());
        expect(transferred.bytes).toBe(owned);
        expect(owned).toEqual(PNG);
        transferred.bytes.fill(0);
        expect(owned.every((byte) => byte === 0)).toBe(true);
        expect(await asyncErrorCode(() => managed.qr(accepted.operation.id, scope(OWNER_B)))).toBe(
            'operation-not-found',
        );

        const read = deferred<ManagedDirectAccountQr>();
        const stale = new Uint8Array(PNG);
        driver.qrEffect = () => read.promise;
        const pending = managed.qr(accepted.operation.id, scope());
        managed.cancel(accepted.operation.id, scope());
        read.resolve({ bytes: stale, contentType: 'image/png' });
        expect(await asyncErrorCode(() => pending)).toBe('qr-unavailable');
        expect(stale.every((byte) => byte === 0)).toBe(true);
        gate.resolve();
        await turns();
        await managed.dispose();
    });

    it('wipes invalid and post-await revoked QR snapshots without exposing driver errors', async () => {
        let current = true;
        const requestScope = scope(OWNER_A, () => current);
        const gate = deferred();
        const driver = new FakeDriver();
        driver.beginEffect = () => gate.promise;
        const managed = service([driver]);
        const accepted = managed.start(
            'main',
            { mode: 'qr', ...control(REVISION_A, 14) },
            requestScope,
        );
        await turns();
        driver.publish(driver.beginCalls[0]!, {
            phase: 'qr-ready',
            qrAvailable: true,
            error: null,
        });
        await turns();

        const invalid = new Uint8Array(PNG);
        driver.qrEffect = async () => ({
            bytes: invalid,
            contentType: 'text/plain' as 'image/png',
        });
        expect(await asyncErrorCode(() => managed.qr(accepted.operation.id, requestScope))).toBe(
            'qr-unavailable',
        );
        expect(invalid.every((byte) => byte === 0)).toBe(true);

        const reading = deferred<ManagedDirectAccountQr>();
        const revoked = new Uint8Array(PNG);
        driver.qrEffect = () => reading.promise;
        const pending = managed.qr(accepted.operation.id, requestScope);
        current = false;
        reading.resolve({ bytes: revoked, contentType: 'image/png' });
        expect(await asyncErrorCode(() => pending)).toBe('scope-expired');
        expect(revoked.every((byte) => byte === 0)).toBe(true);
        current = true;
        gate.resolve();
        await turns();
        await managed.dispose();
    });
});

describe('driver settlement, lifecycle callbacks and auto restore', () => {
    it('turns a synchronous begin throw into a fixed asynchronous terminal result', async () => {
        const driver = new FakeDriver();

        driver.beginEffect = () => {
            throw new Error('/private/vault ticket=raw-secret');
        };

        const managed = service([driver]);
        const accepted = managed.start('main', { mode: 'qr', ...control(REVISION_A, 15) }, scope());
        expect(accepted.operation.status).toBe('running');
        expect(driver.beginCalls).toHaveLength(0);
        await turns();
        const terminal = managed.operation(accepted.operation.id, scope()).operation;
        expect(terminal).toMatchObject({ status: 'failed', error: 'internal-error' });
        expect(JSON.stringify(terminal)).not.toContain('private');
        expect(JSON.stringify(terminal)).not.toContain('raw-secret');
        await managed.dispose();
    });

    it('preserves only typed driver error codes and lets the first terminal result win', async () => {
        const gate = deferred();
        const driver = new FakeDriver();
        driver.beginEffect = () => gate.promise;
        const managed = service([driver]);
        const accepted = managed.start(
            'main',
            { mode: 'restore', ...control(REVISION_A, 16) },
            scope(),
        );
        await turns();
        gate.reject(new ManagedDirectAccountDriverError('needs-login'));
        await turns();
        const terminal = managed.operation(accepted.operation.id, scope()).operation;
        expect(terminal).toMatchObject({
            status: 'failed',
            phase: 'needs-login',
            error: 'needs-login',
        });
        driver.publish(driver.beginCalls[0]!, {
            phase: 'online',
            qrAvailable: false,
            error: null,
        });
        await turns();
        expect(managed.operation(accepted.operation.id, scope()).operation).toEqual(terminal);
        await managed.dispose();
    });

    it('accepts every fixed renewal update code and never retains renew callbacks', async () => {
        const driver = new FakeDriver(
            status('renewable', {
                revision: REVISION_B,
                generation: SESSION,
                phase: 'online',
                online: true,
                canRenew: true,
            }),
        );
        const gates = [deferred(), deferred()];
        let attempt = 0;

        driver.beginEffect = (_kind, _generation, callbacks) => {
            const gate = gates[attempt++]!;
            callbacks.update({
                phase: 'renewing',
                qrAvailable: false,
                error: 'renewal-protocol-error',
            });
            callbacks.update({
                phase: 'renewing',
                qrAvailable: false,
                error: 'renewal-empty-a1',
            });
            callbacks.update({
                phase: 'renewing',
                qrAvailable: false,
                error: 'renewal-disabled',
            });
            callbacks.update({
                phase: 'renewing',
                qrAvailable: false,
                error: 'renewal-invalidation-failed',
            });
            return gate.promise;
        };

        const managed = service([driver]);
        const first = managed.renew('renewable', control(REVISION_B, 19), scope());
        await turns(2);
        expect(managed.operation(first.operation.id, scope()).operation.error).toBe(
            'renewal-invalidation-failed',
        );
        driver.current.phase = 'online';
        gates[0]!.resolve();
        await turns();
        expect(driver.beginCalls[0]!.callbacks.signal.aborted).toBe(true);
        expect(managed.operation(first.operation.id, scope()).operation).toMatchObject({
            status: 'succeeded',
            phase: 'online',
            error: null,
        });

        const revision = managed.get('renewable', scope()).account.revision;
        const second = managed.renew('renewable', control(revision, 20), scope());
        await turns();
        driver.current.phase = 'online';
        gates[1]!.resolve();
        await turns();
        expect(managed.operation(second.operation.id, scope()).operation.status).toBe('succeeded');
        expect(driver.beginCalls[1]!.callbacks.signal.aborted).toBe(true);
        await managed.dispose();
    });

    it('keeps a failed renewal on the same-generation final snapshot phase', async () => {
        const driver = new FakeDriver(
            status('renew-failed', {
                revision: REVISION_B,
                generation: SESSION,
                phase: 'online',
                online: true,
                canRenew: true,
            }),
        );

        driver.beginEffect = async (_kind, _generation, callbacks) => {
            driver.current = {
                ...driver.current,
                phase: 'failed',
                online: true,
                error: 'renewal-protocol-error',
            };
            callbacks.update({
                phase: 'failed',
                qrAvailable: false,
                error: 'renewal-protocol-error',
            });
            throw new ManagedDirectAccountDriverError('renewal-protocol-error');
        };

        const managed = service([driver]);
        const accepted = managed.renew('renew-failed', control(REVISION_B, 28), scope());
        await turns(2);
        expect(managed.operation(accepted.operation.id, scope()).operation).toMatchObject({
            status: 'failed',
            phase: 'failed',
            error: 'renewal-protocol-error',
        });
        expect(managed.get('renew-failed', scope()).account).toMatchObject({
            generation: SESSION,
            phase: 'failed',
            online: true,
            error: 'renewal-protocol-error',
        });

        driver.publish(driver.beginCalls[0]!, {
            phase: 'online',
            qrAvailable: false,
            error: null,
        });
        await turns();
        expect(managed.get('renew-failed', scope()).account).toMatchObject({
            phase: 'failed',
            online: true,
            error: 'renewal-protocol-error',
        });
        await managed.dispose();
    });

    it('uses the final snapshot when synchronous updates are queued just before begin resolves', async () => {
        const driver = new FakeDriver();

        driver.beginEffect = (kind, generation, callbacks) => {
            if (kind === 'stop') {
                callbacks.update({ phase: 'stopping', qrAvailable: false, error: null });
                driver.current = {
                    ...driver.current,
                    generation: null,
                    phase: 'stopped',
                    online: false,
                    onebotReady: false,
                };
                return Promise.resolve();
            }

            expect(kind).toBe('qr');
            driver.current = {
                ...driver.current,
                generation,
                phase: 'registering',
            };
            callbacks.update({ phase: 'waiting-scan', qrAvailable: true, error: null });
            callbacks.update({ phase: 'registering', qrAvailable: false, error: null });
            driver.current = {
                ...driver.current,
                generation,
                phase: 'online',
                online: true,
                onebotReady: true,
            };
            return Promise.resolve();
        };

        const managed = service([driver]);
        const accepted = managed.start('main', { mode: 'qr', ...control(REVISION_A, 21) }, scope());
        await turns(2);
        expect(managed.operation(accepted.operation.id, scope()).operation).toMatchObject({
            status: 'succeeded',
            phase: 'online',
            qrAvailable: false,
        });
        expect(managed.get('main', scope()).account).toMatchObject({
            phase: 'online',
            online: true,
        });
        const sessionSignal = driver.beginCalls[0]!.callbacks.signal;
        const revision = managed.get('main', scope()).account.revision;
        const stopped = managed.stop('main', control(revision, 27), scope());
        await turns(2);
        expect(sessionSignal.aborted).toBe(true);
        expect(managed.operation(stopped.operation.id, scope()).operation).toMatchObject({
            status: 'succeeded',
            phase: 'stopped',
        });
        expect(managed.get('main', scope()).account).toMatchObject({
            generation: null,
            phase: 'stopped',
        });
        await managed.dispose();
    });

    it('revokes an old session listener only after a replacement passes validation', async () => {
        const secondGate = deferred();
        const driver = new FakeDriver();
        let begins = 0;

        driver.beginEffect = (_kind, generation) => {
            driver.current.generation = generation;

            if (begins++ === 0) {
                driver.current = {
                    ...driver.current,
                    phase: 'online',
                    online: true,
                    onebotReady: true,
                };
                return Promise.resolve();
            }

            return secondGate.promise;
        };

        const managed = service([driver]);
        managed.start('main', { mode: 'qr', ...control(REVISION_A, 22) }, scope());
        await turns();
        const old = driver.beginCalls[0]!;
        expect(old.callbacks.signal.aborted).toBe(false);
        driver.current = { ...driver.current, phase: 'stopped', online: false, onebotReady: false };
        driver.publish(old, { phase: 'stopped', qrAvailable: false, error: null });
        await turns();
        const current = managed.get('main', scope()).account;
        expect(
            errorCode(() =>
                managed.start('main', { mode: 'qr', ...control(REVISION_A, 23) }, scope()),
            ),
        ).toBe('revision-conflict');
        expect(old.callbacks.signal.aborted).toBe(false);

        const replacement = managed.start(
            'main',
            { mode: 'qr', ...control(current.revision, 24) },
            scope(),
        );
        expect(old.callbacks.signal.aborted).toBe(true);
        driver.publish(old, {
            phase: 'backoff',
            qrAvailable: false,
            error: 'protocol-or-transport',
        });
        await turns();
        expect(managed.get('main', scope()).account).toMatchObject({
            generation: replacement.operation.generation,
            phase: 'starting',
            error: null,
        });
        const closing = managed.dispose();
        secondGate.resolve();
        await closing;
    });

    it('does not project a cancelled stop as online after teardown already completed', async () => {
        const gate = deferred();
        const driver = new FakeDriver(
            status('online', {
                revision: REVISION_B,
                generation: SESSION,
                phase: 'online',
                online: true,
            }),
        );

        driver.beginEffect = () => {
            driver.current = {
                ...driver.current,
                generation: null,
                phase: 'stopped',
                online: false,
            };
            return gate.promise;
        };

        const managed = service([driver]);
        const accepted = managed.stop('online', control(REVISION_B, 25), scope());
        await turns();
        managed.cancel(accepted.operation.id, scope());
        gate.resolve();
        await turns();
        expect(managed.operation(accepted.operation.id, scope()).operation).toMatchObject({
            status: 'cancelled',
            phase: 'stopped',
        });
        expect(managed.get('online', scope()).account).toMatchObject({
            generation: null,
            phase: 'stopped',
            online: false,
        });
        await managed.dispose();
    });

    it('rejects manual renewal while lifecycle status already reports renewing', async () => {
        const driver = new FakeDriver(
            status('renewing', {
                revision: REVISION_B,
                generation: SESSION,
                phase: 'renewing',
                online: true,
                canRenew: true,
            }),
        );
        const managed = service([driver]);
        expect(errorCode(() => managed.renew('renewing', control(REVISION_B, 26), scope()))).toBe(
            'account-busy',
        );
        expect(driver.beginCalls).toHaveLength(0);
        await managed.dispose();
    });

    it('auto-restores without an owner operation and lets stop preempt only that system run', async () => {
        const restoreGate = deferred();
        const driver = new FakeDriver(
            status('auto', {
                revision: REVISION_B,
                autoRestore: true,
                hasStoredAccount: true,
            }),
        );

        driver.beginEffect = async (kind, generation) => {
            if (kind === 'restore') {
                driver.current.generation = generation;
                await restoreGate.promise;
                return;
            }

            expect(kind).toBe('stop');
            driver.current = {
                ...driver.current,
                generation: null,
                phase: 'stopped',
                online: false,
            };
        };

        const managed = new ManagedDirectAccountService([driver]);
        const restoring = managed.list(scope()).accounts[0]!;
        expect(restoring).toMatchObject({ phase: 'restoring', operationId: null });
        await turns();
        expect(driver.beginCalls.map((call) => call.kind)).toEqual(['restore']);

        const stopped = managed.stop('auto', control(restoring.revision, 17), scope());
        expect(stopped.operation.generation).toBe(restoring.generation);
        expect(driver.cancelCalls).toEqual([restoring.generation]);
        await turns(2);
        expect(driver.beginCalls.map((call) => call.kind)).toEqual(['restore']);
        restoreGate.resolve();
        await turns(2);
        expect(driver.beginCalls.map((call) => call.kind)).toEqual(['restore', 'stop']);
        await turns();
        expect(managed.operation(stopped.operation.id, scope()).operation.status).toBe('succeeded');
        expect(managed.get('auto', scope()).account).toMatchObject({
            generation: null,
            phase: 'stopped',
        });
        await managed.dispose();
    });

    it('can disable constructor auto-start for staged composition', async () => {
        const driver = new FakeDriver(
            status('auto', {
                revision: REVISION_B,
                autoRestore: true,
                hasStoredAccount: true,
            }),
        );
        const managed = service([driver]);
        await turns();
        expect(driver.beginCalls).toHaveLength(0);
        expect(managed.list(scope()).accounts[0]?.phase).toBe('stopped');
        await managed.dispose();
    });
});

describe('managed service disposal', () => {
    it('revokes active work immediately and waits for begin and every driver dispose', async () => {
        const beginGate = deferred();
        const firstDispose = deferred();
        const secondDispose = deferred();
        const first = new FakeDriver(status('first', { revision: REVISION_A }));
        const second = new FakeDriver(status('second', { revision: REVISION_B }));
        first.beginEffect = () => beginGate.promise;
        first.disposeEffect = () => firstDispose.promise;
        second.disposeEffect = () => secondDispose.promise;
        const managed = service([first, second]);
        const accepted = managed.start(
            'first',
            { mode: 'qr', ...control(REVISION_A, 18) },
            scope(),
        );
        await turns();
        const signal = first.beginCalls[0]!.callbacks.signal;
        let settled = false;
        const closing = managed.dispose().then(() => {
            settled = true;
        });
        expect(signal.aborted).toBe(true);
        expect(first.cancelCalls).toEqual([accepted.operation.generation]);
        expect(first.disposeCalls).toBe(1);
        expect(second.disposeCalls).toBe(1);
        expect(errorCode(() => managed.list(scope()))).toBe('not-configured');
        await turns();
        expect(settled).toBe(false);
        beginGate.resolve();
        firstDispose.resolve();
        await turns();
        expect(settled).toBe(false);
        secondDispose.resolve();
        await closing;
        expect(settled).toBe(true);
        await managed.dispose();
        expect(first.disposeCalls).toBe(1);
    });

    it('waits for all drains before returning one fixed dispose failure', async () => {
        const gate = deferred();
        const first = new FakeDriver(status('first', { revision: REVISION_A }));
        const second = new FakeDriver(status('second', { revision: REVISION_B }));

        first.disposeEffect = async () => {
            throw new Error('/private/dispose-cause');
        };

        second.disposeEffect = () => gate.promise;
        const managed = service([first, second]);
        let settled = false;
        const closing = managed.dispose().catch((error: unknown) => {
            settled = true;
            return error;
        });
        await turns();
        expect(settled).toBe(false);
        gate.resolve();
        const error = await closing;
        expect(error).toBeInstanceOf(DirectServiceError);
        expect((error as DirectServiceError).code).toBe('internal-error');
        expect(String(error)).not.toContain('private');
    });
});
