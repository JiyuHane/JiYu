import { addAbortListener } from 'node:events';
import { isProxy } from 'node:util/types';
import { isDirectAccountId, parseDirectOperationId } from '@snowluma/common/direct-account';

export interface DirectTicketState {
    readonly accountId: string;
    readonly generation: string;
    /** Nonsecret issuer revision, not a vault revision or an HTTP operation id. */
    readonly revision: string;
    /** All times are issuer-supplied Unix milliseconds. Null means unknown. */
    readonly issuedAt: number;
    readonly nextAt: number | null;
    readonly expiresAt: number | null;
}

export interface DirectTicketReceipt extends DirectTicketState {
    readonly previousRevision: string;
    readonly nextAt: number;
    readonly expiresAt: number;
}

export type DirectTicketIssueResult =
    | { readonly kind: 'issued'; readonly receipt: DirectTicketReceipt }
    | { readonly kind: 'not-sent'; readonly retryAfterAt: number | null }
    | { readonly kind: 'write-unknown' | 'needs-login' };

export interface DirectTicketRenewalContext {
    readonly accountId: string;
    readonly generation: string;
    readonly expectedRevision: string;
    readonly deadlineAt: number;
    /** Shared by this attempt only. Revoked even after successful handoff. */
    readonly signal: AbortSignal;
    /** Valid only during this particular stage. Recheck immediately at the effect. */
    isCurrent(): boolean;
}

export interface DirectTicketAcknowledgement<K extends 'checkpointed' | 'activated'> {
    readonly kind: K;
    readonly accountId: string;
    readonly generation: string;
    readonly previousRevision: string;
    readonly revision: string;
}

/** Server-side trust boundary. Install only an adapter for a supported official
 * ticket issuance interface. It authenticates the issuer and binds its actual
 * subject to this managed account/generation; metadata alone is not proof.
 * `not-sent` attests this exact call sent no issuer write, not a timeout or
 * an ordinary service error. The adapter owns all ticket material,
 * including disposal of temporary candidates. Methods must settle only after
 * their work drains. No adapter is installed here or derived from managed config. */
export interface DirectTicketRenewalProvider {
    readonly current: DirectTicketState;
    issue(context: DirectTicketRenewalContext): Promise<DirectTicketIssueResult>;
    /** Atomically persist this candidate with an account/generation/revision CAS.
     * Acknowledge only after durable commit; an uncertain commit must fail. */
    checkpoint(
        context: DirectTicketRenewalContext,
        receipt: DirectTicketReceipt,
    ): Promise<DirectTicketAcknowledgement<'checkpointed'>>;
    /** Atomically switch the same live owner from expectedRevision to the durable
     * candidate. Never activate or roll back another generation. */
    activate(
        context: DirectTicketRenewalContext,
        receipt: DirectTicketReceipt,
    ): Promise<DirectTicketAcknowledgement<'activated'>>;
}

export interface DirectTicketRenewalOptions {
    readonly accountId: string;
    readonly generation: string;
    readonly autoRenew: boolean;
    /** Synchronous predicate for this exact managed session, not just its account. */
    readonly isCurrent: () => boolean;
    readonly provider?: DirectTicketRenewalProvider;
    /** One deadline shared by issue, durable checkpoint and activation. */
    readonly timeoutMs?: number;
}

export type DirectTicketRenewalCode =
    | 'renewal-unavailable'
    | 'renewal-not-sent'
    | 'renewal-write-unknown'
    | 'needs-login'
    | 'renewal-invalid-receipt'
    | 'renewal-checkpoint-failed'
    | 'renewal-activation-failed'
    | 'renewal-backoff'
    | 'renewal-deadline'
    | 'renewal-cancelled'
    | 'renewal-closed';

export class DirectTicketRenewalError extends Error {
    constructor(readonly code: DirectTicketRenewalCode) {
        super(code);
        this.name = 'DirectTicketRenewalError';
    }
}

/** Safe management projection: no revision, receipt, ticket or provider error. */
export interface DirectTicketRenewalStatus {
    readonly canRenew: boolean;
    readonly renewAt: number | null;
    readonly retryAt: number | null;
    readonly lastRenewedAt: number | null;
    readonly phase: 'idle' | 'renewing' | 'backoff' | 'needs-login' | 'failed' | 'closed';
    readonly error: DirectTicketRenewalCode | null;
}

const MAX_TIMER_MS = 0x7fffffff;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const TICKET_FIELDS = ['accountId', 'generation', 'revision', 'issuedAt', 'nextAt', 'expiresAt'];
const RECEIPT_FIELDS = [...TICKET_FIELDS, 'previousRevision'];
const ACK_FIELDS = ['kind', 'accountId', 'generation', 'revision', 'previousRevision'];

type Stage = 'queued' | 'issue' | 'checkpoint' | 'activate' | 'done';

function completion() {
    let resolve!: () => void;
    let reject!: (error: DirectTicketRenewalError) => void;
    const promise = new Promise<void>((ok, fail) => {
        resolve = ok;
        reject = fail;
    });
    return { promise, resolve, reject };
}

interface Flight {
    stage: Stage;
    startedAt: number;
    deadlineAt: number;
    monotonicDeadline: number;
    abort: AbortController;
    result: ReturnType<typeof completion>;
    drain: Promise<void>;
    timer?: ReturnType<typeof setTimeout>;
    unlisten?: () => void;
}

function timestamp(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= 8_640_000_000_000_000
    );
}

/** Read only plain own data: a getter/proxy must not run between validation
 * and the immutable snapshot handed to both halves of the commit. */
function hasFields(input: unknown, fields: readonly string[]): input is Record<string, unknown> {
    if (!input || typeof input !== 'object' || isProxy(input)) {
        return false;
    }

    const prototype: unknown = Object.getPrototypeOf(input);
    return (
        (prototype === Object.prototype || prototype === null) &&
        Reflect.ownKeys(input).length === fields.length &&
        fields.every((key) => {
            const property = Object.getOwnPropertyDescriptor(input, key);
            return property !== undefined && 'value' in property;
        })
    );
}

function readState(
    input: Record<string, unknown>,
    accountId: string,
    generation: string,
): DirectTicketState | null {
    const { revision, issuedAt, nextAt, expiresAt } = input;

    if (
        input.accountId !== accountId ||
        input.generation !== generation ||
        typeof revision !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(revision) ||
        !timestamp(issuedAt) ||
        issuedAt > Date.now() ||
        (nextAt !== null && (!timestamp(nextAt) || nextAt <= issuedAt)) ||
        (expiresAt !== null && (!timestamp(expiresAt) || expiresAt <= issuedAt)) ||
        (nextAt !== null && expiresAt !== null && nextAt >= expiresAt)
    ) {
        return null;
    }

    return Object.freeze({ accountId, generation, revision, issuedAt, nextAt, expiresAt });
}

function readReceipt(
    input: unknown,
    prior: DirectTicketState,
    startedAt: number,
): DirectTicketReceipt | null {
    if (!hasFields(input, RECEIPT_FIELDS) || input.previousRevision !== prior.revision) {
        return null;
    }

    const state = readState(input, prior.accountId, prior.generation);

    if (
        !state ||
        state.revision === prior.revision ||
        state.issuedAt <= prior.issuedAt ||
        state.issuedAt < startedAt ||
        state.nextAt === null ||
        state.nextAt <= Date.now() ||
        state.expiresAt === null
    ) {
        return null;
    }

    return Object.freeze({
        ...state,
        previousRevision: prior.revision,
        nextAt: state.nextAt,
        expiresAt: state.expiresAt,
    });
}

function acknowledged(
    input: unknown,
    kind: 'checkpointed' | 'activated',
    receipt: DirectTicketReceipt,
): boolean {
    return (
        hasFields(input, ACK_FIELDS) &&
        input.kind === kind &&
        input.accountId === receipt.accountId &&
        input.generation === receipt.generation &&
        input.previousRevision === receipt.previousRevision &&
        input.revision === receipt.revision
    );
}

/** One immutable account generation. Its owner closes and awaits it before
 * replacement; we never discover accounts, start a transport or renew by restore. */
export class DirectTicketRenewal {
    private provider?: Omit<DirectTicketRenewalProvider, 'current'>;
    private readonly ownerCurrent: () => boolean;
    private readonly automatic: boolean;
    private readonly timeoutMs: number;
    private current: DirectTicketState | null = null;
    private phase: DirectTicketRenewalStatus['phase'] = 'idle';
    private error: DirectTicketRenewalCode | null = null;
    private renewAt: number | null = null;
    private retryAt: number | null = null;
    private lastRenewedAt: number | null = null;
    private notBefore = 0;
    private retryLimitAt = 0;
    private retryMonotonicLimit = 0;
    private retried = false;
    private timer?: ReturnType<typeof setTimeout>;
    private flight?: Flight;
    private closing?: Promise<void>;

    constructor(options: DirectTicketRenewalOptions) {
        const { accountId, generation, autoRenew, isCurrent, provider } = options;
        this.timeoutMs = options.timeoutMs ?? 30_000;

        if (
            !isDirectAccountId(accountId) ||
            typeof autoRenew !== 'boolean' ||
            typeof isCurrent !== 'function' ||
            !Number.isSafeInteger(this.timeoutMs) ||
            this.timeoutMs < 1 ||
            this.timeoutMs > 120_000
        ) {
            throw new TypeError('invalid direct ticket renewal options');
        }

        parseDirectOperationId(generation);
        this.ownerCurrent = isCurrent;
        this.automatic = autoRenew;

        if (!provider) {
            return;
        }

        try {
            const { current, issue, checkpoint, activate } = provider;
            this.current = hasFields(current, TICKET_FIELDS)
                ? readState(current, accountId, generation)
                : null;

            if (
                !this.current ||
                typeof issue !== 'function' ||
                typeof checkpoint !== 'function' ||
                typeof activate !== 'function'
            ) {
                this.failClosed('renewal-invalid-receipt');
                return;
            }

            this.provider = Object.freeze({
                issue: issue.bind(provider),
                checkpoint: checkpoint.bind(provider),
                activate: activate.bind(provider),
            });
        } catch {
            this.failClosed('renewal-invalid-receipt');
            return;
        }

        this.renewAt = this.current.expiresAt === null ? null : this.current.nextAt;
        this.expireIdle();
        this.schedule();
    }

    snapshot(): DirectTicketRenewalStatus {
        if (this.flight) {
            this.live(this.flight);
        } else if (this.current && !this.ownsGeneration() && !this.closing) {
            this.failClosed('renewal-cancelled');
        }

        this.expireIdle();
        return Object.freeze({
            canRenew: this.current !== null,
            renewAt: this.renewAt,
            retryAt: this.retryAt,
            lastRenewedAt: this.lastRenewedAt,
            phase: this.phase,
            error: this.error,
        });
    }

    /** Concurrent callers join one result. Only the initiating signal controls
     * the shared attempt; an already-aborted caller never starts or joins work. */
    renew(signal?: AbortSignal): Promise<void> {
        if (this.closing) {
            return Promise.reject(new DirectTicketRenewalError('renewal-closed'));
        }

        if (signal?.aborted) {
            return Promise.reject(new DirectTicketRenewalError('renewal-cancelled'));
        }

        if (this.flight) {
            return this.flight.result.promise;
        }

        this.expireIdle();
        const prior = this.current;
        const provider = this.provider;

        if (!provider || !prior) {
            return Promise.reject(
                new DirectTicketRenewalError(this.error ?? 'renewal-unavailable'),
            );
        }

        const startedAt = Date.now();

        if (startedAt < this.notBefore) {
            return Promise.reject(new DirectTicketRenewalError('renewal-backoff'));
        }

        const deadlineAt = Math.min(startedAt + this.timeoutMs, prior.expiresAt ?? Infinity);
        const flight: Flight = {
            stage: 'queued',
            startedAt,
            deadlineAt,
            monotonicDeadline: performance.now() + (deadlineAt - startedAt),
            abort: new AbortController(),
            result: completion(),
            drain: Promise.resolve(),
        };
        this.clearSchedule();
        this.renewAt = null;
        this.retryAt = null;
        this.phase = 'renewing';
        this.error = null;
        this.flight = flight;
        // Reserve both the result and the real drain before any callback may re-enter.
        flight.drain = Promise.resolve().then(() => this.execute(flight, provider, prior));
        this.armDeadline(flight);

        if (signal) {
            const subscription = addAbortListener(signal, () =>
                this.fail(flight, 'renewal-cancelled'),
            );
            flight.unlisten = () => subscription[Symbol.dispose]();
        }

        return flight.result.promise;
    }

    /** Invalidate synchronously. A deadline or a rejected public operation is
     * not proof the provider has stopped using the account. Wait for its real exit. */
    close(): Promise<void> {
        if (!this.closing) {
            this.closing = this.flight?.drain ?? Promise.resolve();
            this.clearSchedule();
            this.provider = undefined;
            this.current = null;
            this.renewAt = null;
            this.retryAt = null;
            this.phase = 'closed';

            if (this.flight) {
                this.fail(this.flight, 'renewal-cancelled');
            }
        }

        return this.closing;
    }

    private clearSchedule(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
    }

    private failClosed(code: DirectTicketRenewalCode): void {
        this.clearSchedule();
        this.provider = undefined;
        this.current = null;
        this.renewAt = null;
        this.retryAt = null;
        this.phase = code === 'needs-login' ? 'needs-login' : 'failed';
        this.error = code;
    }

    private expireIdle(): void {
        const expiresAt = this.current?.expiresAt;

        if (!this.flight && expiresAt != null && Date.now() >= expiresAt) {
            this.failClosed('needs-login');
        } else if (
            this.retryAt !== null &&
            (Date.now() > this.retryLimitAt || performance.now() > this.retryMonotonicLimit)
        ) {
            // A suspended process may wake well after the bounded retry window.
            this.clearSchedule();
            this.retryAt = null;
            this.phase = 'failed';
        }
    }

    private schedule(): void {
        const at = this.retryAt ?? this.renewAt;

        if (!this.automatic || this.closing || this.flight || at === null) {
            return;
        }

        // Node truncates very long timer delays to 1 ms. Recheck the absolute
        // issuer time on each wake, including after a wall-clock correction.
        const timer = setTimeout(
            () => {
                if (this.timer !== timer) {
                    return;
                }

                this.timer = undefined;
                this.expireIdle();

                if ((this.retryAt ?? this.renewAt) !== at) {
                    return;
                }

                if (Date.now() < at) {
                    this.schedule();
                } else {
                    // Fixed failures are observable through snapshot(), including for unattended runs.
                    void this.renew().catch(() => {});
                }
            },
            Math.min(MAX_TIMER_MS, Math.max(0, at - Date.now())),
        );
        this.timer = timer;
        timer.unref();
    }

    private armDeadline(flight: Flight): void {
        clearTimeout(flight.timer);
        const delay = Math.min(
            flight.deadlineAt - Date.now(),
            flight.monotonicDeadline - performance.now(),
        );
        flight.timer = setTimeout(
            () => this.fail(flight, 'renewal-deadline'),
            Math.max(0, Math.ceil(delay)),
        );
    }

    private releaseWaiters(flight: Flight): void {
        clearTimeout(flight.timer);
        flight.timer = undefined;
        flight.unlisten?.();
        flight.unlisten = undefined;
    }

    private ownsGeneration(): boolean {
        try {
            return this.ownerCurrent() === true;
        } catch {
            return false;
        }
    }

    private live(flight: Flight): boolean {
        if (this.flight !== flight || flight.stage === 'done' || this.closing) {
            return false;
        }

        if (!this.ownsGeneration()) {
            this.fail(flight, 'renewal-cancelled');
        } else if (
            Date.now() >= flight.deadlineAt ||
            performance.now() >= flight.monotonicDeadline
        ) {
            this.fail(flight, 'renewal-deadline');
        }

        return !flight.abort.signal.aborted && this.flight === flight && !this.closing;
    }

    private context(
        flight: Flight,
        stage: Stage,
        prior: DirectTicketState,
    ): DirectTicketRenewalContext {
        flight.stage = stage;
        return Object.freeze({
            accountId: prior.accountId,
            generation: prior.generation,
            expectedRevision: prior.revision,
            deadlineAt: flight.deadlineAt,
            signal: flight.abort.signal,
            isCurrent: () => flight.stage === stage && this.live(flight),
        });
    }

    private confirm(
        flight: Flight,
        input: unknown,
        kind: 'checkpointed' | 'activated',
        receipt: DirectTicketReceipt,
    ): boolean {
        if (flight.stage === 'done') {
            return false;
        }

        const matches = acknowledged(input, kind, receipt);

        if (!this.live(flight)) {
            return false;
        }

        if (!matches) {
            this.fail(
                flight,
                kind === 'checkpointed' ? 'renewal-checkpoint-failed' : 'renewal-activation-failed',
            );
        }

        return matches;
    }

    private fail(
        flight: Flight,
        code: DirectTicketRenewalCode,
        retryAfterAt: number | null = null,
    ): void {
        if (this.flight !== flight || flight.stage === 'done') {
            return;
        }

        flight.stage = 'done';
        this.releaseWaiters(flight);

        if (!this.closing) {
            const now = Date.now();
            const current = this.current;

            if (code === 'renewal-not-sent' && current) {
                this.error = code;
                this.phase = 'failed';
                this.notBefore = retryAfterAt ?? 0;

                // At most one automatic retry per issuer revision. Never invent
                // a retry window, clamp the issuer's time earlier or outlive the ticket.
                if (
                    this.automatic &&
                    !this.retried &&
                    current.nextAt !== null &&
                    current.expiresAt !== null &&
                    retryAfterAt !== null &&
                    retryAfterAt > now &&
                    retryAfterAt < current.expiresAt &&
                    retryAfterAt - now <= MAX_RETRY_DELAY_MS
                ) {
                    this.retried = true;
                    this.retryLimitAt = now + MAX_RETRY_DELAY_MS;
                    this.retryMonotonicLimit = performance.now() + MAX_RETRY_DELAY_MS;
                    this.retryAt = retryAfterAt;
                    this.phase = 'backoff';
                }
            } else {
                // This includes a committed checkpoint whose activation failed:
                // never advertise/reuse the old revision or infer a rollback.
                this.failClosed(code);
            }
        }

        const error = new DirectTicketRenewalError(code);
        flight.result.reject(error);
        flight.abort.abort(error);
    }

    private async execute(
        flight: Flight,
        provider: Omit<DirectTicketRenewalProvider, 'current'>,
        prior: DirectTicketState,
    ): Promise<void> {
        try {
            if (!this.live(flight)) {
                return;
            }

            const outcome: unknown = await provider.issue(this.context(flight, 'issue', prior));

            if (!this.live(flight)) {
                return;
            }

            if (
                hasFields(outcome, ['kind', 'retryAfterAt']) &&
                outcome.kind === 'not-sent' &&
                (outcome.retryAfterAt === null || timestamp(outcome.retryAfterAt))
            ) {
                this.fail(flight, 'renewal-not-sent', outcome.retryAfterAt);
                return;
            }

            if (!hasFields(outcome, ['kind', 'receipt']) || outcome.kind !== 'issued') {
                this.fail(
                    flight,
                    hasFields(outcome, ['kind']) && outcome.kind === 'needs-login'
                        ? 'needs-login'
                        : 'renewal-write-unknown',
                );
                return;
            }

            const receipt = readReceipt(outcome.receipt, prior, flight.startedAt);

            if (!receipt) {
                this.fail(flight, 'renewal-invalid-receipt');
                return;
            }

            if (receipt.expiresAt < flight.deadlineAt) {
                flight.deadlineAt = receipt.expiresAt;
                flight.monotonicDeadline = Math.min(
                    flight.monotonicDeadline,
                    performance.now() + receipt.expiresAt - Date.now(),
                );
                this.armDeadline(flight);
            }

            if (!this.live(flight)) {
                return;
            }

            const committed: unknown = await provider.checkpoint(
                this.context(flight, 'checkpoint', prior),
                receipt,
            );

            if (!this.confirm(flight, committed, 'checkpointed', receipt)) {
                return;
            }

            const activated: unknown = await provider.activate(
                this.context(flight, 'activate', prior),
                receipt,
            );

            if (!this.confirm(flight, activated, 'activated', receipt)) {
                return;
            }

            flight.stage = 'done';
            this.current = receipt;
            this.lastRenewedAt = receipt.issuedAt;
            this.renewAt = receipt.nextAt;
            this.notBefore = 0;
            this.retried = false;
            this.phase = 'idle';
            this.error = null;
            flight.result.resolve();
        } catch {
            // An exception (even one spelling "not sent") proves nothing about
            // dispatch. Only the typed, validated issuer result authorizes retry.
            if (this.live(flight)) {
                this.fail(
                    flight,
                    flight.stage === 'activate'
                        ? 'renewal-activation-failed'
                        : flight.stage === 'checkpoint'
                          ? 'renewal-checkpoint-failed'
                          : 'renewal-write-unknown',
                );
            }
        } finally {
            this.releaseWaiters(flight);
            flight.abort.abort();
            this.flight = undefined;
            this.expireIdle();
            this.schedule();
        }
    }
}
