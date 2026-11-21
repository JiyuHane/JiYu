import { randomBytes } from 'node:crypto';
import { types } from 'node:util';
import {
    DIRECT_ACCOUNT_PHASES,
    parseDirectAccountId,
    parseDirectAccountStatus,
    parseDirectControlRequest,
    parseDirectOperationId,
    parseDirectStartRequest,
    type DirectAcceptedResponse,
    type DirectAccountPhase,
    type DirectAccountResponse,
    type DirectAccountsResponse,
    type DirectAccountStatus,
    type DirectControlRequest,
    type DirectOperation,
    type DirectOperationKind,
    type DirectOperationResponse,
    type DirectStartRequest,
} from '@snowluma/common/direct-account';
import { DirectOperationRegistry } from './operation-registry';
import {
    assertDirectRequestScope,
    DirectServiceError,
    type DirectAccountService,
    type DirectRequestScope,
} from './service-contract';

export type ManagedDirectAccountErrorCode =
    | 'internal-error'
    | 'protocol-or-transport'
    | 'needs-login'
    | 'renewal-unavailable'
    | 'renewal-not-sent'
    | 'renewal-write-unknown'
    | 'renewal-invalid-receipt'
    | 'renewal-protocol-error'
    | 'renewal-empty-a1'
    | 'renewal-disabled'
    | 'renewal-invalidation-failed'
    | 'renewal-checkpoint-failed'
    | 'renewal-activation-failed'
    | 'renewal-backoff'
    | 'renewal-deadline'
    | 'renewal-cancelled'
    | 'renewal-closed'
    | 'persistence-failed'
    | 'cleanup-failed';

const MANAGED_ERROR_CODES = new Set<ManagedDirectAccountErrorCode>([
    'internal-error',
    'protocol-or-transport',
    'needs-login',
    'renewal-unavailable',
    'renewal-not-sent',
    'renewal-write-unknown',
    'renewal-invalid-receipt',
    'renewal-protocol-error',
    'renewal-empty-a1',
    'renewal-disabled',
    'renewal-invalidation-failed',
    'renewal-checkpoint-failed',
    'renewal-activation-failed',
    'renewal-backoff',
    'renewal-deadline',
    'renewal-cancelled',
    'renewal-closed',
    'persistence-failed',
    'cleanup-failed',
]);

export class ManagedDirectAccountDriverError extends Error {
    constructor(readonly code: ManagedDirectAccountErrorCode) {
        super(code);
        this.name = 'ManagedDirectAccountDriverError';
    }
}

export interface ManagedDirectAccountUpdate {
    readonly phase: DirectAccountPhase;
    readonly qrAvailable: boolean;
    readonly error: ManagedDirectAccountErrorCode | null;
}

export interface ManagedDirectAccountDriverCallbacks {
    /** Notifications may outlive begin(). They remain valid only while signal is not aborted. */
    readonly update: (update: ManagedDirectAccountUpdate) => void;
    /** Revoked when this exact generation is cancelled, replaced, stopped or disposed. */
    readonly signal: AbortSignal;
}

export interface ManagedDirectAccountQr {
    readonly bytes: Uint8Array;
    readonly contentType: 'image/png' | 'image/jpeg' | 'image/webp';
}

/** Pure injected lifecycle boundary. The implementation belongs to the actual account driver. */
export interface ManagedDirectAccountDriver {
    snapshot(): DirectAccountStatus;
    /** Reserve and run exactly one effect. The service always invokes this from setImmediate. */
    begin(
        kind: DirectOperationKind,
        generation: string,
        callbacks: ManagedDirectAccountDriverCallbacks,
    ): Promise<void>;
    /** Synchronously requests cancellation; begin()/dispose() still own real drainage. */
    cancel(generation: string): void;
    /** Transfers an owned image snapshot to the service. */
    qr(generation: string): Promise<ManagedDirectAccountQr>;
    /** Settles only after all driver-owned work and resources have drained. */
    dispose(): Promise<void>;
}

export type ManagedDirectAccountAvailability =
    'available' | 'unsupported-platform' | 'not-configured';

export interface ManagedDirectAccountServiceOptions {
    readonly registry?: DirectOperationRegistry;
    readonly availability?: ManagedDirectAccountAvailability;
    /** Production defaults to true. Tests and staged composition may opt out. */
    readonly autoStart?: boolean;
}

interface BoundDriver {
    readonly snapshot: () => DirectAccountStatus;
    readonly begin: ManagedDirectAccountDriver['begin'];
    readonly cancel: ManagedDirectAccountDriver['cancel'];
    readonly qr: ManagedDirectAccountDriver['qr'];
    readonly dispose: ManagedDirectAccountDriver['dispose'];
}

interface PriorState {
    readonly revision: string;
    readonly generation: string | null;
    readonly phase: DirectAccountPhase;
    readonly error: ManagedDirectAccountErrorCode | null;
    readonly recentOperationId: string | undefined;
}

interface ManagedRun {
    readonly kind: DirectOperationKind;
    readonly generation: string;
    readonly operationId: string | undefined;
    readonly system: boolean;
    readonly controller: AbortController;
    readonly prior: PriorState;
    readonly updates: Set<ReturnType<typeof setImmediate>>;
    readonly drain: Promise<void>;
    readonly resolveDrain: () => void;
    readonly blockedBy: Promise<void> | undefined;
    scheduled: ReturnType<typeof setImmediate> | undefined;
    phase: DirectAccountPhase;
    error: ManagedDirectAccountErrorCode | null;
    qrAvailable: boolean;
    settled: boolean;
    cancelRequested: boolean;
    cancelIssued: boolean;
    forcedError: ManagedDirectAccountErrorCode | undefined;
}

interface ManagedSlot {
    readonly driver: BoundDriver;
    readonly id: string;
    readonly label: string;
    readonly protocol: 'linux';
    revision: string;
    generation: string | null;
    phase: DirectAccountPhase;
    error: ManagedDirectAccountErrorCode | null;
    recentOperationId: string | undefined;
    active: ManagedRun | undefined;
    readonly listeners: Set<ManagedRun>;
}

const QR_LIMIT_BYTES = 1024 * 1024;
const OWNER = /^[0-9a-f]{64}$/;

function opaqueId(): string {
    return randomBytes(16).toString('hex');
}

function freshGeneration(previous: string | null): string {
    let generation = opaqueId();

    while (generation === previous) {
        generation = opaqueId();
    }

    return generation;
}

function fixedError(value: unknown): ManagedDirectAccountErrorCode {
    return typeof value === 'string' &&
        MANAGED_ERROR_CODES.has(value as ManagedDirectAccountErrorCode)
        ? (value as ManagedDirectAccountErrorCode)
        : 'internal-error';
}

function phase(value: unknown): value is DirectAccountPhase {
    return (
        typeof value === 'string' && (DIRECT_ACCOUNT_PHASES as readonly string[]).includes(value)
    );
}

function parseUpdate(value: unknown): ManagedDirectAccountUpdate | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);

    if (
        (prototype !== Object.prototype && prototype !== null) ||
        keys.length !== 3 ||
        !keys.every((key) => key === 'phase' || key === 'qrAvailable' || key === 'error')
    ) {
        return null;
    }

    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of ['phase', 'qrAvailable', 'error'] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (!descriptor || !('value' in descriptor)) {
            return null;
        }

        result[key] = descriptor.value;
    }

    if (
        !phase(result.phase) ||
        typeof result.qrAvailable !== 'boolean' ||
        (result.error !== null &&
            (typeof result.error !== 'string' ||
                !MANAGED_ERROR_CODES.has(result.error as ManagedDirectAccountErrorCode)))
    ) {
        return null;
    }

    return {
        phase: result.phase,
        qrAvailable: result.qrAvailable,
        error: result.error as ManagedDirectAccountErrorCode | null,
    };
}

function input<T>(parse: (value: unknown) => T, value: unknown): T {
    try {
        return parse(value);
    } catch {
        throw new DirectServiceError('invalid-request');
    }
}

function scopeOwner(scope: DirectRequestScope): string {
    try {
        assertDirectRequestScope(scope);

        if (!OWNER.test(scope.owner)) {
            throw new DirectServiceError('invalid-request');
        }

        return scope.owner;
    } catch (error) {
        if (error instanceof DirectServiceError) {
            throw error;
        }

        throw new DirectServiceError('scope-expired');
    }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function bindDriver(driver: ManagedDirectAccountDriver): BoundDriver {
    if (
        !driver ||
        typeof driver !== 'object' ||
        typeof driver.snapshot !== 'function' ||
        typeof driver.begin !== 'function' ||
        typeof driver.cancel !== 'function' ||
        typeof driver.qr !== 'function' ||
        typeof driver.dispose !== 'function'
    ) {
        throw new TypeError('invalid managed direct account driver');
    }

    return Object.freeze({
        snapshot: driver.snapshot.bind(driver),
        begin: driver.begin.bind(driver),
        cancel: driver.cancel.bind(driver),
        qr: driver.qr.bind(driver),
        dispose: driver.dispose.bind(driver),
    });
}

function initialPhase(kind: DirectOperationKind): DirectAccountPhase {
    switch (kind) {
        case 'qr':
            return 'starting';
        case 'restore':
            return 'restoring';
        case 'stop':
            return 'stopping';
        case 'renew':
            return 'renewing';
    }
}

function operationFailurePhase(
    kind: DirectOperationKind,
    code: ManagedDirectAccountErrorCode,
    prior: DirectAccountPhase,
): DirectAccountPhase {
    if (code === 'needs-login') {
        return 'needs-login';
    }

    return kind === 'renew' ? prior : 'failed';
}

/**
 * One service owns operation metadata and CAS revisions; injected drivers own runtime resources.
 * No runner, Bridge, OneBot or protocol implementation is imported here.
 */
export class ManagedDirectAccountService implements DirectAccountService {
    private readonly registry: DirectOperationRegistry;
    private readonly availability: ManagedDirectAccountAvailability;
    private readonly slots = new Map<string, ManagedSlot>();
    private disposed = false;
    private closing: Promise<void> | undefined;

    constructor(
        drivers: readonly ManagedDirectAccountDriver[],
        options: ManagedDirectAccountServiceOptions = {},
    ) {
        this.registry = options.registry ?? new DirectOperationRegistry();
        this.availability = options.availability ?? 'available';
        const autoStart = options.autoStart ?? true;

        if (
            !Array.isArray(drivers) ||
            drivers.length > 32 ||
            !['available', 'unsupported-platform', 'not-configured'].includes(this.availability) ||
            typeof autoStart !== 'boolean' ||
            (this.availability !== 'available' && drivers.length !== 0)
        ) {
            throw new TypeError('invalid managed direct account service options');
        }

        for (const candidate of drivers) {
            const driver = bindDriver(candidate);
            const snapshot = this.driverSnapshot(driver);

            if (this.slots.has(snapshot.id)) {
                throw new TypeError('duplicate managed direct account id');
            }

            this.slots.set(snapshot.id, {
                driver,
                id: snapshot.id,
                label: snapshot.label,
                protocol: snapshot.protocol,
                revision: snapshot.revision,
                generation: snapshot.generation,
                phase: snapshot.phase,
                error: snapshot.error === null ? null : fixedError(snapshot.error),
                recentOperationId: undefined,
                active: undefined,
                listeners: new Set(),
            });
        }

        if (this.availability === 'available' && autoStart) {
            for (const slot of this.slots.values()) {
                const snapshot = this.readSnapshot(slot);

                if (snapshot.autoRestore && snapshot.hasStoredAccount) {
                    this.reserveSystemRestore(slot);
                }
            }
        }
    }

    list(scope: DirectRequestScope): DirectAccountsResponse {
        scopeOwner(scope);
        this.ensureOpen();

        if (this.availability !== 'available') {
            const supported = this.availability !== 'unsupported-platform';
            scopeOwner(scope);
            return {
                supported,
                configured: false,
                reason: this.availability,
                accounts: [],
            };
        }

        const accounts = Array.from(this.slots.values(), (slot) =>
            this.project(slot, this.readSnapshot(slot), scope),
        );
        scopeOwner(scope);
        return { supported: true, configured: true, reason: null, accounts };
    }

    get(id: string, scope: DirectRequestScope): DirectAccountResponse {
        scopeOwner(scope);
        this.ensureAvailable();
        const slot = this.account(input(parseDirectAccountId, id));
        const account = this.project(slot, this.readSnapshot(slot), scope);
        scopeOwner(scope);
        return { account };
    }

    start(
        id: string,
        request: DirectStartRequest,
        scope: DirectRequestScope,
    ): DirectAcceptedResponse {
        scopeOwner(scope);
        const parsed = input(parseDirectStartRequest, request);
        return this.mutate(id, parsed.mode, parsed, scope);
    }

    stop(
        id: string,
        request: DirectControlRequest,
        scope: DirectRequestScope,
    ): DirectAcceptedResponse {
        scopeOwner(scope);
        return this.mutate(id, 'stop', input(parseDirectControlRequest, request), scope);
    }

    renew(
        id: string,
        request: DirectControlRequest,
        scope: DirectRequestScope,
    ): DirectAcceptedResponse {
        scopeOwner(scope);
        return this.mutate(id, 'renew', input(parseDirectControlRequest, request), scope);
    }

    operation(id: string, scope: DirectRequestScope): DirectOperationResponse {
        scopeOwner(scope);
        this.ensureAvailable();
        const operation = this.registry.get(input(parseDirectOperationId, id), scope);
        scopeOwner(scope);
        return { operation };
    }

    cancel(id: string, scope: DirectRequestScope): DirectAcceptedResponse {
        scopeOwner(scope);
        this.ensureAvailable();
        const operationId = input(parseDirectOperationId, id);
        const existing = this.registry.get(operationId, scope);
        const slot = this.account(existing.accountId);
        const snapshot = this.readSnapshot(slot);

        if (existing.status === 'running') {
            const run = slot.active;

            if (
                !run ||
                run.system ||
                run.operationId !== existing.id ||
                run.generation !== existing.generation
            ) {
                throw new DirectServiceError('internal-error');
            }

            run.qrAvailable = false;
            this.registry.update(existing.id, {
                phase: run.phase,
                qrAvailable: false,
                error: run.error,
            });
            this.requestCancellation(slot, run, true);
        }

        const operation = this.registry.get(operationId, scope);
        const account = this.project(slot, snapshot, scope);
        scopeOwner(scope);
        return { account, operation };
    }

    async qr(id: string, scope: DirectRequestScope): Promise<ManagedDirectAccountQr> {
        scopeOwner(scope);
        this.ensureAvailable();
        const operationId = input(parseDirectOperationId, id);
        const operation = this.registry.get(operationId, scope);
        const slot = this.account(operation.accountId);
        const run = slot.active;

        if (
            operation.kind !== 'qr' ||
            operation.status !== 'running' ||
            !operation.qrAvailable ||
            !run ||
            run.system ||
            run.operationId !== operation.id ||
            run.generation !== operation.generation ||
            run.controller.signal.aborted
        ) {
            throw new DirectServiceError('qr-unavailable');
        }

        let owned: Uint8Array | undefined;

        try {
            scopeOwner(scope);
            const result = await slot.driver.qr(run.generation);
            owned = result?.bytes;

            if (
                !types.isUint8Array(owned) ||
                types.isSharedArrayBuffer(owned.buffer) ||
                ('resizable' in owned.buffer && owned.buffer.resizable === true) ||
                owned.byteLength < 1 ||
                owned.byteLength > QR_LIMIT_BYTES ||
                !['image/png', 'image/jpeg', 'image/webp'].includes(result.contentType)
            ) {
                throw new DirectServiceError('qr-unavailable');
            }

            scopeOwner(scope);
            const after = this.registry.peek(operation.id);

            if (
                !after ||
                after.status !== 'running' ||
                !after.qrAvailable ||
                after.generation !== run.generation ||
                slot.active !== run ||
                run.controller.signal.aborted
            ) {
                throw new DirectServiceError('qr-unavailable');
            }

            const transferred = { bytes: owned, contentType: result.contentType };
            owned = undefined;
            return transferred;
        } catch (error) {
            owned?.fill(0);

            if (error instanceof DirectServiceError) {
                throw error;
            }

            throw new DirectServiceError('qr-unavailable');
        }
    }

    dispose(): Promise<void> {
        if (!this.closing) {
            this.disposed = true;
            this.closing = this.disposeAll();
        }

        return this.closing;
    }

    private ensureOpen(): void {
        if (this.disposed) {
            throw new DirectServiceError('not-configured');
        }
    }

    private ensureAvailable(): void {
        this.ensureOpen();

        if (this.availability !== 'available') {
            throw new DirectServiceError(this.availability);
        }
    }

    private account(id: string): ManagedSlot {
        const slot = this.slots.get(id);

        if (!slot) {
            throw new DirectServiceError('account-not-found');
        }

        return slot;
    }

    private driverSnapshot(driver: BoundDriver): DirectAccountStatus {
        try {
            return parseDirectAccountStatus(driver.snapshot());
        } catch {
            throw new DirectServiceError('internal-error');
        }
    }

    private readSnapshot(slot: ManagedSlot): DirectAccountStatus {
        const snapshot = this.driverSnapshot(slot.driver);

        if (snapshot.id !== slot.id || snapshot.protocol !== slot.protocol) {
            throw new DirectServiceError('internal-error');
        }

        return snapshot;
    }

    private project(
        slot: ManagedSlot,
        snapshot: DirectAccountStatus,
        scope: DirectRequestScope,
    ): DirectAccountStatus {
        const active = slot.active;
        const operationId = this.registry.visibleId(slot.recentOperationId, scope);

        try {
            return parseDirectAccountStatus({
                ...snapshot,
                id: slot.id,
                label: slot.label,
                protocol: slot.protocol,
                revision: slot.revision,
                generation: slot.generation,
                phase: active?.phase ?? slot.phase,
                error: active?.error ?? slot.error,
                operationId,
                capabilities: [...snapshot.capabilities],
            });
        } catch {
            throw new DirectServiceError('internal-error');
        }
    }

    private preflight(
        slot: ManagedSlot,
        status: DirectAccountStatus,
        kind: DirectOperationKind,
    ): void {
        if (slot.active && !(kind === 'stop' && slot.active.system)) {
            throw new DirectServiceError('account-busy');
        }

        if (kind === 'restore' && !status.hasStoredAccount) {
            throw new DirectServiceError('needs-login');
        }

        if (kind === 'qr' || kind === 'restore') {
            if (status.online || !['stopped', 'failed', 'needs-login'].includes(slot.phase)) {
                throw new DirectServiceError('account-busy');
            }
        }

        if (kind === 'renew' && slot.phase === 'renewing') {
            throw new DirectServiceError('account-busy');
        }

        if (kind === 'renew' && (!status.online || !status.canRenew || slot.generation === null)) {
            throw new DirectServiceError('renewal-unavailable');
        }
    }

    private mutate(
        id: string,
        kind: DirectOperationKind,
        request: DirectControlRequest,
        scope: DirectRequestScope,
    ): DirectAcceptedResponse {
        this.ensureAvailable();
        const accountId = input(parseDirectAccountId, id);
        const slot = this.account(accountId);
        const operationRequest: DirectControlRequest = {
            expectedRevision: request.expectedRevision,
            operationKey: request.operationKey,
        };
        const retry = this.registry.find(accountId, kind, operationRequest, scope);

        if (retry) {
            const account = this.project(slot, this.readSnapshot(slot), scope);
            scopeOwner(scope);
            return { account, operation: retry };
        }

        const snapshot = this.readSnapshot(slot);

        if (request.expectedRevision !== slot.revision) {
            throw new DirectServiceError('revision-conflict');
        }

        this.preflight(slot, snapshot, kind);
        const preempted = kind === 'stop' && slot.active?.system ? slot.active : undefined;
        const generation =
            kind === 'qr' || kind === 'restore'
                ? freshGeneration(slot.generation)
                : (slot.generation ?? opaqueId());
        const nextRevision = opaqueId();
        const operation = this.registry.create({
            accountId,
            generation,
            kind,
            phase: initialPhase(kind),
            request: operationRequest,
            scope,
        });

        if (preempted) {
            this.requestCancellation(slot, preempted, true);
        }

        const run = this.reserve(
            slot,
            kind,
            generation,
            operation.id,
            false,
            nextRevision,
            kind !== 'stop' || slot.generation !== null,
            preempted?.drain,
        );

        try {
            const account = this.project(slot, snapshot, scope);
            scopeOwner(scope);

            if ((kind === 'qr' || kind === 'restore') && run.prior.generation) {
                this.revokeGeneration(slot, run.prior.generation);
            }

            this.schedule(slot, run);
            return { account, operation };
        } catch (error) {
            this.abandon(slot, run);
            throw error;
        }
    }

    private reserve(
        slot: ManagedSlot,
        kind: DirectOperationKind,
        generation: string,
        operationId: string | undefined,
        system: boolean,
        revision = opaqueId(),
        publishGeneration = true,
        blockedBy?: Promise<void>,
    ): ManagedRun {
        const done = deferred();
        const run: ManagedRun = {
            kind,
            generation,
            operationId,
            system,
            controller: new AbortController(),
            prior: {
                revision: slot.revision,
                generation: slot.generation,
                phase: slot.phase,
                error: slot.error,
                recentOperationId: slot.recentOperationId,
            },
            updates: new Set(),
            drain: done.promise,
            resolveDrain: done.resolve,
            blockedBy,
            scheduled: undefined,
            phase: initialPhase(kind),
            error: null,
            qrAvailable: false,
            settled: false,
            cancelRequested: false,
            cancelIssued: false,
            forcedError: undefined,
        };

        slot.active = run;
        slot.revision = revision;

        if (publishGeneration) {
            slot.generation = generation;
        }

        if (operationId) {
            slot.recentOperationId = operationId;
        }

        return run;
    }

    private reserveSystemRestore(slot: ManagedSlot): void {
        if (slot.active) {
            return;
        }

        const run = this.reserve(
            slot,
            'restore',
            freshGeneration(slot.generation),
            undefined,
            true,
        );

        if (run.prior.generation) {
            this.revokeGeneration(slot, run.prior.generation);
        }

        this.schedule(slot, run);
    }

    private schedule(slot: ManagedSlot, run: ManagedRun): void {
        run.scheduled = setImmediate(() => {
            run.scheduled = undefined;
            void this.dispatch(slot, run);
        });
    }

    private async dispatch(slot: ManagedSlot, run: ManagedRun): Promise<void> {
        let succeeded = false;
        let failure: unknown;

        try {
            await run.blockedBy;

            if (this.disposed || slot.active !== run || run.controller.signal.aborted) {
                return;
            }

            await slot.driver.begin(run.kind, run.generation, {
                signal: run.controller.signal,
                update: (update) => this.queueUpdate(slot, run, update),
            });
            succeeded = true;
        } catch (error) {
            failure = error;
        } finally {
            this.complete(slot, run, succeeded, failure);
            run.resolveDrain();
        }
    }

    private queueUpdate(
        slot: ManagedSlot,
        run: ManagedRun,
        value: ManagedDirectAccountUpdate,
    ): void {
        if (run.controller.signal.aborted || this.disposed) {
            return;
        }

        let update: ManagedDirectAccountUpdate | null;

        try {
            update = parseUpdate(value);
        } catch {
            update = null;
        }

        const handle = setImmediate(() => {
            run.updates.delete(handle);

            if (!update) {
                this.invalidateDriverRun(slot, run);
                return;
            }

            this.applyUpdate(slot, run, update);
        });
        run.updates.add(handle);
    }

    private applyUpdate(
        slot: ManagedSlot,
        run: ManagedRun,
        update: ManagedDirectAccountUpdate,
    ): void {
        if (
            this.disposed ||
            run.controller.signal.aborted ||
            (slot.active !== run &&
                (slot.active !== undefined || slot.generation !== run.generation))
        ) {
            return;
        }

        if (slot.active === run) {
            run.phase = update.phase;
            run.error = update.error;
            run.qrAvailable = run.kind === 'qr' && update.qrAvailable;
            slot.revision = opaqueId();

            if (run.operationId) {
                this.registry.update(run.operationId, {
                    phase: run.phase,
                    qrAvailable: run.qrAvailable,
                    error: run.error,
                });
            }

            return;
        }

        if (run.settled && slot.listeners.has(run)) {
            slot.phase = update.phase;
            slot.error = update.error;
            slot.revision = opaqueId();
        }
    }

    private invalidateDriverRun(slot: ManagedSlot, run: ManagedRun): void {
        if (
            run.controller.signal.aborted ||
            (slot.active !== run &&
                (slot.generation !== run.generation || !slot.listeners.has(run)))
        ) {
            return;
        }

        run.forcedError = 'internal-error';
        run.error = 'internal-error';
        run.qrAvailable = false;

        if (run.operationId && slot.active === run) {
            this.registry.update(run.operationId, {
                phase: run.phase,
                qrAvailable: false,
                error: 'internal-error',
            });
        }

        this.requestCancellation(slot, run, false);
    }

    private requestCancellation(slot: ManagedSlot, run: ManagedRun, requested: boolean): void {
        if (requested) {
            run.cancelRequested = true;
        }

        run.controller.abort();

        for (const handle of run.updates) {
            clearImmediate(handle);
        }

        run.updates.clear();

        if (!run.cancelIssued) {
            run.cancelIssued = true;

            try {
                slot.driver.cancel(run.generation);
            } catch {
                // The signal is already revoked. The real begin/dispose drain remains authoritative.
            }
        }
    }

    private abandon(slot: ManagedSlot, run: ManagedRun): void {
        run.cancelRequested = true;
        run.controller.abort();
        run.settled = true;
        slot.active = undefined;
        slot.revision = run.prior.revision;
        slot.generation = run.prior.generation;
        slot.phase = run.prior.phase;
        slot.error = run.prior.error;
        slot.recentOperationId = run.prior.recentOperationId;

        if (run.operationId) {
            this.registry.finish(run.operationId, 'cancelled', run.prior.phase, null);
        }

        run.resolveDrain();
    }

    private complete(
        slot: ManagedSlot,
        run: ManagedRun,
        succeeded: boolean,
        failure: unknown,
    ): void {
        if (run.settled) {
            return;
        }

        run.settled = true;

        for (const handle of run.updates) {
            clearImmediate(handle);
        }

        run.updates.clear();

        if (slot.active !== run) {
            run.controller.abort();
            slot.listeners.delete(run);
            return;
        }

        let snapshot: DirectAccountStatus | undefined;

        try {
            snapshot = this.readSnapshot(slot);
        } catch {
            if (succeeded && !run.cancelRequested && !run.forcedError) {
                succeeded = false;
                failure = new ManagedDirectAccountDriverError('internal-error');
            }
        }

        let status: Exclude<DirectOperation['status'], 'running'>;
        let terminalError: ManagedDirectAccountErrorCode | null;
        let terminalPhase: DirectAccountPhase;

        if (run.forcedError) {
            status = 'failed';
            terminalError = run.forcedError;
            terminalPhase = operationFailurePhase(run.kind, terminalError, run.prior.phase);
        } else if (run.cancelRequested || this.disposed) {
            status = 'cancelled';
            terminalError = null;
            terminalPhase = run.prior.phase;
        } else if (!succeeded) {
            status = 'failed';
            terminalError =
                failure instanceof ManagedDirectAccountDriverError
                    ? fixedError(failure.code)
                    : (run.error ?? 'internal-error');
            terminalPhase =
                run.kind === 'renew' && snapshot?.generation === run.generation
                    ? snapshot.phase
                    : operationFailurePhase(run.kind, terminalError, run.prior.phase);
        } else {
            status = 'succeeded';
            terminalError = null;
            terminalPhase = snapshot!.phase;
        }

        slot.active = undefined;
        slot.revision = opaqueId();

        if (status === 'cancelled') {
            if (run.kind === 'stop' && snapshot) {
                slot.generation = snapshot.generation;
                slot.phase = snapshot.phase;
                slot.error = snapshot.error === null ? null : fixedError(snapshot.error);
                terminalPhase = snapshot.phase;

                if (snapshot.generation === null) {
                    this.revokeGeneration(slot, run.generation);
                }
            } else {
                slot.generation = run.prior.generation;
                slot.phase = run.prior.phase;
                slot.error = run.prior.error;
            }

            run.controller.abort();
        } else if (status === 'failed') {
            slot.generation = run.kind === 'stop' ? run.prior.generation : run.generation;
            slot.phase = terminalPhase;
            slot.error = terminalError;
            run.controller.abort();
        } else if (run.kind === 'stop') {
            this.revokeGeneration(slot, run.generation);
            slot.generation = null;
            slot.phase = 'stopped';
            slot.error = null;
            terminalPhase = 'stopped';
            run.controller.abort();
        } else {
            slot.generation = run.generation;
            slot.phase = terminalPhase;
            slot.error = null;

            if (run.kind === 'qr' || run.kind === 'restore') {
                slot.listeners.add(run);
            } else {
                run.controller.abort();
            }
        }

        if (run.operationId) {
            this.registry.finish(run.operationId, status, terminalPhase, terminalError);
        }
    }

    private revokeGeneration(slot: ManagedSlot, generation: string): void {
        for (const listener of [...slot.listeners]) {
            if (listener.generation === generation) {
                listener.controller.abort();

                for (const handle of listener.updates) {
                    clearImmediate(handle);
                }

                listener.updates.clear();
                slot.listeners.delete(listener);
            }
        }
    }

    private async disposeAll(): Promise<void> {
        const drains: Promise<void>[] = [];
        const disposals: Promise<void>[] = [];
        let failed = false;

        for (const slot of this.slots.values()) {
            const generations = new Set<string>();

            if (slot.active) {
                generations.add(slot.active.generation);
                this.requestCancellation(slot, slot.active, true);
                drains.push(slot.active.drain);
            }

            for (const listener of [...slot.listeners]) {
                generations.add(listener.generation);
                listener.controller.abort();

                for (const handle of listener.updates) {
                    clearImmediate(handle);
                }

                listener.updates.clear();
                slot.listeners.delete(listener);
            }

            if (slot.generation) {
                generations.add(slot.generation);
            }

            for (const generation of generations) {
                if (slot.active?.generation === generation && slot.active.cancelIssued) {
                    continue;
                }

                try {
                    slot.driver.cancel(generation);
                } catch {
                    failed = true;
                }
            }

            try {
                disposals.push(Promise.resolve(slot.driver.dispose()));
            } catch {
                failed = true;
            }
        }

        const settled = await Promise.allSettled([...drains, ...disposals]);
        failed ||= settled.some((result) => result.status === 'rejected');
        this.registry.clear();

        if (failed) {
            throw new DirectServiceError('internal-error');
        }
    }
}

export function createUnavailableManagedDirectAccountService(
    reason: Exclude<ManagedDirectAccountAvailability, 'available'>,
): ManagedDirectAccountService {
    return new ManagedDirectAccountService([], { availability: reason, autoStart: false });
}
