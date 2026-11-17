import { addAbortListener } from 'node:events';
import type {
    GuardedBlockedResult,
    GuardedCleanupState,
    GuardedCommitResult,
    GuardedDrainResult,
    GuardedPollResult,
    GuardedReleaseResult,
    GuardedSelection,
    PollOptions,
    PollResult,
} from './event-poll-buffer';

/** Internal transaction seam used by the bounded production HTTP poll owner.
 * The ordered-ingress owner remains a separate experimental mode.
 * The trusted host owns one coordinator per account and binding epoch, validates
 * event origin, creates the buffer and supplies its exact maxQueueBytes. Neither
 * request input nor an arbitrary same-process object is an authority for these.
 * A controlled queue must settle reserve after abort; every selected token must be
 * returned as fulfilled reserved, even late. Rejection is permitted only before
 * selection or after the queue reliably releases its own token. A violating queue
 * cannot be cleaned up by this coordinator. Same-process objects are not authenticated.
 * The host bounds concurrency (including unfinished writes), relative deadlines,
 * parsed request/echo and output sizes. Deadlines and now() use the same monotonic
 * millisecond clock; timers are not real-time guarantees and byte caps do not bound RSS.
 * The sink is injected: fixtures use in-memory fakes, while the optional transport
 * seam can supply a response sink. isOpen covers every unusable writing state. The
 * host owns error handling before and after this transaction and
 * for late sink errors. Local finish is not evidence of remote receipt. Real transport
 * needs its own authentication, source provenance, admission and effect accounting.
 * Legacy mode writes [] for empty or timeout; ordered mode instead returns an
 * internal empty_unresolved outcome without a write. It is not an HTTP response.
 * Timeout says only this consumer did not reserve events before its wait expired;
 * other waiters or reservations may exist. This mapping still needs transport and
 * fairness review; it does not establish delivery, global emptiness or event order.
 *
 * The trusted owner may opt into event-time order for each selected FIFO prefix.
 * Selection still uses the original FIFO count and byte limits, and equal times keep
 * their selected indices; in particular, limit=1 still selects the FIFO head. OneBot
 * v12's oldest-to-newest expectation additionally assumes event.time represents age
 * and earlier events are already available in the right order across requests. This
 * policy does not select the globally earliest queued event or order late arrivals
 * or separate responses. Runtime producers remain responsible for non-meta events.
 */
export interface PollQueue {
    reserve(options: PollOptions): Promise<PollResult>;
    commit(token: object): boolean;
    release(token: object): boolean;
}

/** Exact queue selections and no-drain receipts belong to the scoped queue.
 * The owner must supply a queue created for its exact active scope, and the
 * epoch verifier must include that scope: this structural interface proves neither. */
export interface ScopedPollQueue {
    reserveGuarded(options: PollOptions): Promise<GuardedPollResult>;
    commitGuardedNoDrain(token: object, selection: GuardedSelection): GuardedCommitResult;
    settleBlockedGuardedNoDrain(token: object, selection: GuardedSelection): GuardedBlockedResult;
    releaseGuardedNoDrain(token: object): GuardedReleaseResult;
    resumeGuardedDrain(receipt: object): GuardedDrainResult;
    guardedCleanupState(): GuardedCleanupState;
}

/** Synchronous owner signals; scope_revoked requests retirement, not proof of cleanup. */
export type ScopedPollStatus =
    | { readonly kind: 'pruned'; readonly count: number }
    | { readonly kind: 'uncertain' | 'scope_revoked' };

export type ScopedPollEffect =
    | { readonly kind: 'none' | 'released' | 'committed' | 'unknown' }
    | { readonly kind: 'pruned'; readonly count: number }
    | { readonly kind: 'blocked'; readonly requiredBytes: number };

type ScopedBackend = {
    readonly queue: ScopedPollQueue;
    readonly onScopedStatus?: (status: ScopedPollStatus) => void;
};

// This sentinel is never used to translate guarded results. Selecting it is a bug.
const inactiveLegacyQueue: PollQueue = {
    reserve: () => {
        throw new Error('inactive legacy poll backend');
    },
    commit: () => {
        throw new Error('inactive legacy poll backend');
    },
    release: () => {
        throw new Error('inactive legacy poll backend');
    },
};

export interface PollSink {
    isOpen(): boolean;
    on(event: 'close' | 'error' | 'finish', listener: () => void): void;
    off(event: 'close' | 'error' | 'finish', listener: () => void): void;
    writeHead(): void;
    end(body: string): void;
}

/** Trusted per-transaction listener check; never supplied by a poll request. */
export type PollListenerGuard = () => boolean;

export interface PollRequest {
    readonly limit: number;
    readonly timeoutMs: number;
    readonly echo?: string;
    readonly maxOutputBytes: number;
    readonly responseDeadline: number;
    readonly externalAbortSignal?: AbortSignal;
}

type PollCoreOutcome =
    | { readonly kind: 'local_finish'; readonly response: 'events' | 'fallback' }
    | {
          readonly kind: 'local_finish';
          readonly response: 'empty';
          readonly reason: 'empty' | 'timeout';
      }
    | { readonly kind: 'unknown'; readonly committed: boolean }
    | { readonly kind: 'committed_unsent' }
    | { readonly kind: 'commit_unknown' }
    | { readonly kind: 'commit_rejected' }
    | { readonly kind: 'release_unknown' }
    | { readonly kind: 'fatal_budget' }
    | { readonly kind: 'queue_error' }
    | { readonly kind: 'empty_unresolved'; readonly reason: 'empty' | 'timeout' }
    | { readonly kind: 'invalid_input' | 'already_started' }
    | {
          readonly kind:
              'aborted' | 'cancelled' | 'closed' | 'deadline' | 'epoch_invalid' | 'clock_error';
      }
    | { readonly kind: 'blocked'; readonly requiredBytes?: number }
    | { readonly kind: 'invalid' | 'busy' | 'contended' }
    | { readonly kind: 'pruned'; readonly count: number }
    | {
          readonly kind: 'scope_revoked';
          readonly effect: ScopedPollEffect;
          readonly committed: boolean;
      }
    | {
          readonly kind: 'scoped_uncertain';
          readonly effect: ScopedPollEffect;
          readonly committed: boolean | 'unknown';
      };

export type PollOutcome =
    | PollCoreOutcome
    | {
          readonly kind: 'cleanup_uncertain';
          readonly outcome: PollCoreOutcome;
          readonly committed: boolean | 'unknown';
      };

type Stop = 'aborted' | 'cancelled' | 'closed' | 'deadline' | 'epoch_invalid' | 'clock_error';
type State = 'initial' | 'waiting' | 'prepared' | 'committing' | 'writing' | 'terminal';
type WriteKind =
    | { readonly response: 'events' | 'fallback' }
    | { readonly response: 'empty'; readonly reason: 'empty' | 'timeout' };

const bindScopedBackend = Symbol('bind scoped poll backend');
const prefix = '{"status":"ok","retcode":0,"data":';
const unknownMessage =
    'outcome unknown; side effects may have occurred; do not retry automatically';
const maxTimer = 2_147_483_647;

function nonnegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Reorder only a private parsed copy of the already selected FIFO prefix. */
function orderEventsByTime(events: unknown[]): string | undefined {
    const indexed: { event: object; time: number; index: number }[] = [];

    for (let index = 0; index < events.length; index++) {
        const event: unknown = events[index];

        if (
            typeof event !== 'object' ||
            event === null ||
            Array.isArray(event) ||
            Object.getPrototypeOf(event) !== Object.prototype
        ) {
            return undefined;
        }

        // JSON.parse creates own data properties; inherited time is not an event time.
        const time: unknown = Object.getOwnPropertyDescriptor(event, 'time')?.value;

        if (
            typeof time !== 'number' ||
            !Number.isFinite(time) ||
            time < 0 ||
            time > Number.MAX_SAFE_INTEGER
        ) {
            return undefined;
        }

        indexed.push({ event, time, index });
    }

    indexed.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.index - b.index));
    return JSON.stringify(indexed.map(({ event }) => event));
}

/** The functions and queue are trusted owner dependencies, not request-selected callbacks. */
export class PollCoordinator {
    private closed = false;
    private readonly transactions = new Set<PollTransaction>();
    private scopedBackend: ScopedBackend | undefined;

    /** Internal scoped queue seam; its owner must bind lifecycle and status handling. */
    static scoped(
        queue: ScopedPollQueue,
        maxQueueBytes: number,
        now: () => number,
        isEpochValid: () => boolean,
        emptyPolicy: 'legacy' | 'unavailable' = 'legacy',
        batchOrder: 'fifo' | 'event-time' = 'fifo',
        onScopedStatus?: (status: ScopedPollStatus) => void,
    ): PollCoordinator {
        const coordinator = new PollCoordinator(
            inactiveLegacyQueue,
            maxQueueBytes,
            now,
            isEpochValid,
            emptyPolicy,
            batchOrder,
        );
        coordinator.scopedBackend = { queue, onScopedStatus };
        return coordinator;
    }

    constructor(
        private readonly queue: PollQueue,
        private readonly maxQueueBytes: number,
        private readonly now: () => number,
        private readonly isEpochValid: () => boolean,
        private readonly emptyPolicy: 'legacy' | 'unavailable' = 'legacy',
        private readonly batchOrder: 'fifo' | 'event-time' = 'fifo',
    ) {
        if (!nonnegativeInteger(maxQueueBytes) || maxQueueBytes < 2) {
            throw new RangeError('invalid queue budget');
        }

        if (emptyPolicy !== 'legacy' && emptyPolicy !== 'unavailable') {
            throw new RangeError('invalid empty policy');
        }

        if (batchOrder !== 'fifo' && batchOrder !== 'event-time') {
            throw new RangeError('invalid batch order');
        }
    }

    create(
        request: PollRequest,
        sink: PollSink,
        listenerGuard?: PollListenerGuard,
    ): PollTransaction {
        const transaction = new PollTransaction(
            this.queue,
            this.maxQueueBytes,
            this.now,
            () => !this.closed && this.isEpochValid(),
            request,
            sink,
            () => {
                if (this.closed) {
                    return false;
                }

                this.transactions.add(transaction);
                return true;
            },
            () => this.transactions.delete(transaction),
            this.emptyPolicy,
            this.batchOrder,
            listenerGuard,
        );

        if (this.scopedBackend) {
            transaction[bindScopedBackend](this.scopedBackend);
        }

        return transaction;
    }

    close(): void {
        if (this.closed) {
            return;
        }

        this.closed = true;

        for (const transaction of this.transactions) {
            transaction.close();
        }
    }
}

export class PollTransaction {
    private state: State = 'initial';
    private stopReason: Stop | undefined;
    private readonly controller = new AbortController();
    private task: Promise<PollOutcome> | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private abortListener: Disposable | undefined;
    private sinkListening = false;
    private writerResolve: ((outcome: PollCoreOutcome) => void) | undefined;
    private writeOutcome: PollCoreOutcome | undefined;
    private writeKind: WriteKind | undefined;
    private cleanupUncertain = false;
    private endStarted = false;
    private endReturned = false;
    private finishSeen = false;
    private committed = false;
    private scopedBackend: ScopedBackend | undefined;
    private scopedEffect: ScopedPollEffect = { kind: 'none' };
    private scopedCommitUnknown = false;
    private scopedUncertain = false;
    private scopedScopeRevoked = false;
    private scopedFinishChecking = false;
    private readonly request: PollRequest;

    [bindScopedBackend](backend: ScopedBackend): void {
        this.scopedBackend = backend;
    }

    constructor(
        private readonly queue: PollQueue,
        private readonly maxQueueBytes: number,
        private readonly now: () => number,
        private readonly isEpochValid: () => boolean,
        request: PollRequest,
        private readonly sink: PollSink,
        private readonly onStart: () => boolean,
        private readonly onDone: () => void,
        private readonly emptyPolicy: 'legacy' | 'unavailable' = 'legacy',
        private readonly batchOrder: 'fifo' | 'event-time' = 'fifo',
        private listenerGuard?: PollListenerGuard,
    ) {
        if (emptyPolicy !== 'legacy' && emptyPolicy !== 'unavailable') {
            throw new RangeError('invalid empty policy');
        }

        if (batchOrder !== 'fifo' && batchOrder !== 'event-time') {
            throw new RangeError('invalid batch order');
        }

        this.request = {
            limit: request.limit,
            timeoutMs: request.timeoutMs,
            echo: request.echo,
            maxOutputBytes: request.maxOutputBytes,
            responseDeadline: request.responseDeadline,
            externalAbortSignal: request.externalAbortSignal,
        };
    }

    run(): Promise<PollOutcome> {
        if (this.task) {
            return Promise.resolve({ kind: 'already_started' });
        }

        // Store the promise before executing any owner-provided method: a
        // synchronous reentrant run() cannot start another reservation.
        this.task = Promise.resolve().then(() => this.execute());

        if (!this.onStart()) {
            this.close();
        }

        return this.task;
    }

    cancel(): void {
        this.stop('cancelled');
    }

    close(): void {
        this.stop('closed');
    }

    private stop(reason: Stop): void {
        if (this.state === 'terminal' || this.stopReason) {
            return;
        }

        this.stopReason = reason;

        if (this.timer !== undefined) {
            this.cleanup(() => clearTimeout(this.timer));
            this.timer = undefined;
        }

        if (this.abortListener) {
            const listener = this.abortListener;
            this.abortListener = undefined;
            this.cleanup(() => listener[Symbol.dispose]());
        }

        this.cleanup(() => this.controller.abort());

        if (this.state === 'writing') {
            this.finishWrite({ kind: 'unknown', committed: this.committed });
        }
    }

    private cleanup(action: () => void): void {
        try {
            action();
        } catch {
            this.cleanupUncertain = true;

            if (this.scopedBackend) {
                this.markScopedUncertain();
            }
        }
    }

    private notifyScoped(status: ScopedPollStatus): void {
        try {
            this.scopedBackend?.onScopedStatus?.(status);
        } catch {
            // A notification can have changed the owner before throwing.
            this.cleanupUncertain = true;
            this.markScopedUncertain();
        }
    }

    private markScopedUncertain(): void {
        if (this.scopedUncertain) {
            return;
        }

        this.scopedUncertain = true;
        this.notifyScoped({ kind: 'uncertain' });
    }

    private markScopeRevoked(): void {
        if (this.scopedScopeRevoked) {
            return;
        }

        this.scopedScopeRevoked = true;
        this.notifyScoped({ kind: 'scope_revoked' });
    }

    private sampleScopedCleanup(): void {
        const backend = this.scopedBackend;

        if (!backend) {
            return;
        }

        try {
            const state = backend.queue.guardedCleanupState();

            if (state === 'uncertain' || state === 'unavailable') {
                this.markScopedUncertain();
                this.stop('closed');
            } else if (state === 'closing' || state === 'closed') {
                // This signal requests owner retirement; it does not claim the
                // exact scope has already been retired or cleanup has finished.
                this.markScopeRevoked();
                this.stop('closed');
            } else if (state !== 'open') {
                this.markScopedUncertain();
                this.stop('closed');
            }
        } catch {
            this.markScopedUncertain();
            this.stop('closed');
        }
    }

    /** Resume only the exact receipt after recording its local effect. */
    private resumeScoped(receipt: object): void {
        const backend = this.scopedBackend!;

        try {
            const result = backend.queue.resumeGuardedDrain(receipt);

            if (result.status === 'scope_revoked') {
                this.markScopeRevoked();
            } else if (result.status === 'uncertain') {
                this.markScopedUncertain();
            } else if (result.status === 'stale') {
                // A clean close can clear a barrier during drain. Other stale
                // receipts are not evidence that cleanup or delivery succeeded.
                if (backend.queue.guardedCleanupState() === 'closed') {
                    this.stop('closed');
                } else {
                    this.markScopedUncertain();
                }
            } else if (result.status !== 'resumed') {
                this.markScopedUncertain();
            }
        } catch {
            this.markScopedUncertain();
        }

        this.sampleScopedCleanup();
    }

    /** Cancellation releases either kind of selection without checking its proof. */
    private releaseScoped(selection: GuardedSelection): void {
        const backend = this.scopedBackend!;

        try {
            const receipt = backend.queue.releaseGuardedNoDrain(selection.token);

            if (receipt.status !== 'released') {
                this.scopedEffect = { kind: 'unknown' };
                this.markScopedUncertain();
                return;
            }

            this.scopedEffect = { kind: 'released' };
            this.resumeScoped(receipt);
        } catch {
            this.scopedEffect = { kind: 'unknown' };
            this.markScopedUncertain();
        }
    }

    /** Final synchronous owner, sink and listener samples around a scoped effect. */
    private scopedFence(): Stop | undefined {
        let stopped = this.check() ?? this.check(false);
        const listenerGuard = this.listenerGuard;

        if (!stopped && listenerGuard !== undefined) {
            try {
                if (listenerGuard() !== true) {
                    this.stop('epoch_invalid');
                }
            } catch {
                this.stop('epoch_invalid');
            }

            stopped = this.stopReason ?? this.check() ?? this.check(false);

            if (!stopped) {
                try {
                    if (listenerGuard() !== true) {
                        this.stop('epoch_invalid');
                    }
                } catch {
                    this.stop('epoch_invalid');
                }

                stopped = this.stopReason;
            }
        }

        return stopped;
    }

    /** Sample only the scoped listener after callback-capable write checks. */
    private sampleScopedListener(): Stop | undefined {
        if (!this.scopedBackend || this.stopReason) {
            return this.stopReason;
        }

        const listenerGuard = this.listenerGuard;

        if (listenerGuard !== undefined) {
            try {
                if (listenerGuard() !== true) {
                    this.stop('epoch_invalid');
                }
            } catch {
                this.stop('epoch_invalid');
            }
        }

        return this.stopReason;
    }

    /** A reentrant finish must not publish success before the last sample returns. */
    private finishScopedIfReady(): void {
        if (this.scopedFinishChecking || this.writeOutcome) {
            return;
        }

        this.scopedFinishChecking = true;

        try {
            if (this.check(false) || this.sampleScopedListener()) {
                return;
            }

            if (this.finishSeen && !this.writeOutcome && !this.stopReason) {
                this.finishLocalWrite();
            }
        } finally {
            this.scopedFinishChecking = false;
        }
    }

    private readonly onClose = (): void => this.stop('closed');
    private readonly onError = (): void => this.stop('closed');
    private readonly onFinish = (): void => {
        if (this.state !== 'writing') {
            return;
        }

        this.finishSeen = true;

        if (!this.endStarted) {
            this.finishWrite({ kind: 'unknown', committed: this.committed });
        } else if (this.endReturned) {
            if (this.scopedBackend) {
                this.finishScopedIfReady();
            } else if (!this.check(false)) {
                this.finishLocalWrite();
            }
        }
    };

    private finishLocalWrite(): void {
        const kind = this.writeKind;

        if (!kind) {
            this.finishWrite({ kind: 'unknown', committed: this.committed });
        } else if (kind.response === 'empty') {
            this.finishWrite({ kind: 'local_finish', response: 'empty', reason: kind.reason });
        } else {
            this.finishWrite({ kind: 'local_finish', response: kind.response });
        }
    }

    private finishWrite(outcome: PollCoreOutcome): void {
        if (this.writeOutcome) {
            return;
        }

        this.writeOutcome = outcome;
        this.writerResolve?.(outcome);
    }

    private armDeadline(): void {
        if (this.stopReason) {
            return;
        }

        let remaining: number;

        try {
            remaining = this.request.responseDeadline - this.now();
        } catch {
            this.stop('clock_error');
            return;
        }

        if (this.stopReason) {
            return;
        }

        if (!Number.isFinite(remaining) || remaining <= 0) {
            this.stop('deadline');
            return;
        }

        this.timer = setTimeout(
            () => {
                this.timer = undefined;
                this.armDeadline();
            },
            Math.min(maxTimer, Math.ceil(remaining)),
        );
    }

    private check(requireOpen = true): Stop | undefined {
        if (this.scopedBackend) {
            this.sampleScopedCleanup();
        }

        if (this.stopReason) {
            return this.stopReason;
        }

        try {
            if (!this.isEpochValid()) {
                this.stop('epoch_invalid');
            }
        } catch {
            this.stop('closed');
        }

        if (this.stopReason) {
            return this.stopReason;
        }

        try {
            const now = this.now();

            if (!Number.isFinite(now) || now >= this.request.responseDeadline) {
                this.stop('deadline');
            }
        } catch {
            this.stop('clock_error');
        }

        if (!this.stopReason && requireOpen) {
            try {
                if (!this.sink.isOpen()) {
                    this.stop('closed');
                }
            } catch {
                this.stop('closed');
            }
        }

        if (this.scopedBackend) {
            this.sampleScopedCleanup();
        }

        return this.stopReason;
    }

    private release(token: object): boolean {
        try {
            return this.queue.release(token);
        } catch {
            return false;
        }
    }

    private async write(body: string, kind: WriteKind): Promise<PollCoreOutcome> {
        let stop = this.check();

        if (!stop && this.scopedBackend) {
            stop = this.sampleScopedListener();
        }

        if (stop) {
            return this.committed ? { kind: 'committed_unsent' } : { kind: stop };
        }

        this.writeKind = kind;
        this.state = 'writing';
        const completed = new Promise<PollCoreOutcome>((resolve) => {
            this.writerResolve = resolve;
        });

        try {
            this.sink.writeHead();
            // Header publication may synchronously revoke the owner or consume
            // the remaining deadline even without emitting a sink event.
            this.check();

            if (this.scopedBackend && !this.writeOutcome) {
                this.sampleScopedListener();
            }

            if (!this.writeOutcome) {
                this.endStarted = true;
                this.sink.end(body);
                this.endReturned = true;

                // A normal finish can make the sink no longer writable, so only
                // epoch and clock are checked after end, not isOpen().
                if (this.scopedBackend) {
                    this.finishScopedIfReady();
                } else {
                    this.check(false);

                    if (this.finishSeen && !this.writeOutcome && !this.stopReason) {
                        this.finishLocalWrite();
                    }
                }
            }
        } catch {
            this.finishWrite({ kind: 'unknown', committed: this.committed });
        }

        return completed;
    }

    private async fallback(echo: string | undefined): Promise<PollCoreOutcome> {
        try {
            const body = JSON.stringify({
                status: 'failed',
                retcode: 20001,
                data: null,
                message: unknownMessage,
                ...(echo !== undefined ? { echo } : {}),
            });

            const stop = this.check();

            if (stop) {
                return { kind: stop };
            }

            if (Buffer.byteLength(body, 'utf8') > this.request.maxOutputBytes) {
                return { kind: 'fatal_budget' };
            }

            return await this.write(body, { response: 'fallback' });
        } catch {
            const stop = this.check();
            return stop ? { kind: stop } : { kind: 'fatal_budget' };
        }
    }

    private async execute(): Promise<PollOutcome> {
        let outcome: PollCoreOutcome;

        try {
            outcome = await (this.scopedBackend ? this.executeScopedCore() : this.executeCore());
        } finally {
            // Drop this transaction's direct reference to the listener guard.
            this.listenerGuard = undefined;
        }

        this.state = 'terminal';

        if (this.timer !== undefined) {
            this.cleanup(() => clearTimeout(this.timer));
            this.timer = undefined;
        }

        if (this.abortListener) {
            const listener = this.abortListener;
            this.abortListener = undefined;
            this.cleanup(() => listener[Symbol.dispose]());
        }

        if (this.sinkListening) {
            this.cleanup(() => this.sink.off('close', this.onClose));
            this.cleanup(() => this.sink.off('error', this.onError));
            this.cleanup(() => this.sink.off('finish', this.onFinish));
        }

        this.cleanup(this.onDone);

        if (this.scopedBackend) {
            // Sink and owner cleanup can reenter a guarded queue after the last write.
            this.sampleScopedCleanup();
            this.scopedBackend = undefined;
        }

        if (this.scopedUncertain) {
            outcome = {
                kind: 'scoped_uncertain',
                effect: this.scopedEffect,
                committed: this.scopedCommitUnknown ? 'unknown' : this.committed,
            };
        } else if (this.scopedScopeRevoked) {
            outcome = {
                kind: 'scope_revoked',
                effect: this.scopedEffect,
                committed: this.committed,
            };
        }

        return this.cleanupUncertain
            ? {
                  kind: 'cleanup_uncertain',
                  outcome,
                  committed:
                      outcome.kind === 'commit_unknown'
                          ? 'unknown'
                          : outcome.kind === 'scoped_uncertain'
                            ? outcome.committed
                            : this.committed,
              }
            : outcome;
    }

    /** The scoped path keeps selections and no-drain receipts as distinct objects. */
    private async executeScopedCore(): Promise<PollCoreOutcome> {
        const backend = this.scopedBackend!;
        let selection: GuardedSelection | undefined;
        let selectionOwned = false;
        let reservePending = false;
        let settlementPending: 'reserved' | 'blocked_guarded' | undefined;

        const releaseSelection = (): void => {
            if (!selectionOwned || !selection) {
                return;
            }

            selectionOwned = false;
            this.releaseScoped(selection);
        };

        try {
            const {
                limit,
                timeoutMs,
                echo,
                maxOutputBytes,
                responseDeadline,
                externalAbortSignal,
            } = this.request;

            if (
                !nonnegativeInteger(limit) ||
                !nonnegativeInteger(timeoutMs) ||
                !nonnegativeInteger(maxOutputBytes) ||
                !Number.isFinite(responseDeadline) ||
                (echo !== undefined && typeof echo !== 'string')
            ) {
                return { kind: 'invalid_input' };
            }

            this.state = 'waiting';
            this.sinkListening = true;
            this.sink.on('close', this.onClose);
            this.sink.on('error', this.onError);
            this.sink.on('finish', this.onFinish);

            if (externalAbortSignal) {
                this.abortListener = addAbortListener(externalAbortSignal, () =>
                    this.stop('aborted'),
                );

                if (externalAbortSignal.aborted) {
                    this.stop('aborted');
                }
            }

            this.armDeadline();
            const stopped = this.check();

            if (stopped) {
                return { kind: stopped };
            }

            let suffix: string;

            try {
                suffix = `,"message":""${echo === undefined ? '' : `,"echo":${JSON.stringify(echo)}`}}`;
            } catch {
                return await this.fallback(echo);
            }

            const overhead = Buffer.byteLength(prefix, 'utf8') + Buffer.byteLength(suffix, 'utf8');
            const budget = Math.min(maxOutputBytes - overhead, this.maxQueueBytes);

            if (budget < 2) {
                return await this.fallback(echo);
            }

            reservePending = true;
            const result = await backend.queue.reserveGuarded({
                limit,
                timeoutMs,
                maxBatchBytes: budget,
                signal: this.controller.signal,
            });
            const status = result.status;

            // Both outcomes own a physical prefix, including when they arrive late.
            if (status === 'reserved' || status === 'blocked_guarded') {
                selection = result;
                selectionOwned = true;
            }

            reservePending = false;

            if (status === 'uncertain') {
                this.markScopedUncertain();
            } else if (status === 'scope_revoked' || status === 'closed') {
                this.markScopeRevoked();
            }

            // A waiter may have resolved before its timer/listener cleanup failed.
            const afterReserve = this.check();

            if (afterReserve || this.scopedUncertain || this.scopedScopeRevoked) {
                releaseSelection();
                return afterReserve ? { kind: afterReserve } : { kind: 'queue_error' };
            }

            if (status !== 'reserved' && status !== 'blocked_guarded') {
                if (status === 'empty' || status === 'timeout') {
                    if (this.emptyPolicy === 'unavailable') {
                        return { kind: 'empty_unresolved', reason: status };
                    }

                    const body = `${prefix}[]${suffix}`;

                    if (Buffer.byteLength(body, 'utf8') > maxOutputBytes) {
                        return await this.fallback(echo);
                    }

                    return await this.write(body, { response: 'empty', reason: status });
                }

                if (status === 'blocked') {
                    if (!nonnegativeInteger(result.requiredBytes) || result.requiredBytes < 2) {
                        this.markScopedUncertain();
                        return { kind: 'queue_error' };
                    }

                    return { kind: 'blocked', requiredBytes: result.requiredBytes };
                }

                if (status === 'aborted') {
                    return { kind: 'aborted' };
                }

                if (
                    status === 'closed' ||
                    status === 'busy' ||
                    status === 'contended' ||
                    status === 'invalid'
                ) {
                    return { kind: status };
                }

                this.markScopedUncertain();
                return { kind: 'queue_error' };
            }

            this.state = 'prepared';
            let body: string | undefined;

            if (status === 'reserved') {
                try {
                    if (
                        typeof result.eventsJson === 'string' &&
                        Buffer.byteLength(result.eventsJson, 'utf8') <= budget &&
                        result.bytes === Buffer.byteLength(result.eventsJson, 'utf8') &&
                        Number.isSafeInteger(result.count) &&
                        result.count > 0
                    ) {
                        const parsed: unknown = JSON.parse(result.eventsJson);

                        if (Array.isArray(parsed) && parsed.length === result.count) {
                            if (this.batchOrder === 'fifo') {
                                const candidate = prefix + result.eventsJson + suffix;

                                if (Buffer.byteLength(candidate, 'utf8') <= maxOutputBytes) {
                                    body = candidate;
                                }
                            } else {
                                const ordered = orderEventsByTime(parsed);

                                if (
                                    ordered !== undefined &&
                                    Buffer.byteLength(ordered, 'utf8') <= budget
                                ) {
                                    const candidate = prefix + ordered + suffix;

                                    if (Buffer.byteLength(candidate, 'utf8') <= maxOutputBytes) {
                                        body = candidate;
                                    }
                                }
                            }
                        }
                    }
                } catch {
                    // Malformed controlled fake results cannot be committed.
                }

                if (body === undefined) {
                    releaseSelection();

                    if (this.scopedUncertain || this.scopedScopeRevoked) {
                        return { kind: 'queue_error' };
                    }

                    return await this.fallback(echo);
                }
            }

            // Keep the legacy double listener sample before either guarded effect.
            const beforeSettlement = this.scopedFence();

            if (beforeSettlement) {
                releaseSelection();
                return { kind: beforeSettlement };
            }

            // A thrown or uncertain no-drain operation may already have changed
            // the prefix. Do not attempt release until scope_revoked proves it held.
            this.state = 'committing';
            selectionOwned = false;
            settlementPending = status;
            let receipt: GuardedCommitResult | GuardedBlockedResult;

            try {
                receipt =
                    status === 'reserved'
                        ? backend.queue.commitGuardedNoDrain(result.token, result)
                        : backend.queue.settleBlockedGuardedNoDrain(result.token, result);
            } catch {
                this.scopedEffect = { kind: 'unknown' };
                this.scopedCommitUnknown = status === 'reserved';
                this.markScopedUncertain();
                return { kind: 'queue_error' };
            }

            if (receipt.status === 'scope_revoked') {
                settlementPending = undefined;
                selectionOwned = true;
                releaseSelection();
                this.markScopeRevoked();
                return { kind: 'queue_error' };
            }

            if (receipt.status === 'stale' || receipt.status === 'uncertain') {
                this.scopedEffect = { kind: 'unknown' };
                this.scopedCommitUnknown = status === 'reserved';
                this.markScopedUncertain();
                return { kind: 'queue_error' };
            }

            if (receipt.status === 'pruned') {
                const maximum = status === 'reserved' ? result.count : 1;

                if (
                    !nonnegativeInteger(receipt.count) ||
                    receipt.count < 1 ||
                    receipt.count > maximum
                ) {
                    this.scopedEffect = { kind: 'unknown' };
                    this.scopedCommitUnknown = status === 'reserved';
                    this.markScopedUncertain();
                    return { kind: 'queue_error' };
                }

                settlementPending = undefined;
                this.scopedEffect = { kind: 'pruned', count: receipt.count };
                this.notifyScoped({ kind: 'pruned', count: receipt.count });

                if (!this.scopedUncertain) {
                    this.resumeScoped(receipt);
                    this.scopedFence();
                }

                return { kind: 'pruned', count: receipt.count };
            }

            if (receipt.status === 'blocked' && status === 'blocked_guarded') {
                if (
                    !nonnegativeInteger(receipt.requiredBytes) ||
                    receipt.requiredBytes < 2 ||
                    receipt.requiredBytes !== result.requiredBytes
                ) {
                    this.scopedEffect = { kind: 'unknown' };
                    this.markScopedUncertain();
                    return { kind: 'queue_error' };
                }

                settlementPending = undefined;
                this.scopedEffect = { kind: 'blocked', requiredBytes: receipt.requiredBytes };
                this.resumeScoped(receipt);
                const afterBlocked = this.scopedFence();
                return afterBlocked
                    ? { kind: afterBlocked }
                    : { kind: 'blocked', requiredBytes: receipt.requiredBytes };
            }

            if (receipt.status !== 'committed' || status !== 'reserved' || body === undefined) {
                this.scopedEffect = { kind: 'unknown' };
                this.scopedCommitUnknown = status === 'reserved';
                this.markScopedUncertain();
                return { kind: 'queue_error' };
            }

            // Publish the committed fact before the resume or any status callback.
            settlementPending = undefined;
            this.committed = true;
            this.scopedEffect = { kind: 'committed' };
            this.resumeScoped(receipt);

            if (this.scopedUncertain || this.scopedScopeRevoked || this.scopedFence()) {
                return { kind: 'committed_unsent' };
            }

            return await this.write(body, { response: 'events' });
        } catch {
            if (reservePending || settlementPending !== undefined) {
                // A violating queue could have selected or changed the prefix
                // before rejecting or returning an unreadable receipt.
                this.scopedEffect = { kind: 'unknown' };
                this.scopedCommitUnknown = settlementPending === 'reserved';
                this.markScopedUncertain();
            }

            releaseSelection();
            return this.stopReason ? { kind: this.stopReason } : { kind: 'queue_error' };
        }
    }

    private async executeCore(): Promise<PollCoreOutcome> {
        let token: object | undefined;
        let tokenOwned = false;

        try {
            const {
                limit,
                timeoutMs,
                echo,
                maxOutputBytes,
                responseDeadline,
                externalAbortSignal,
            } = this.request;

            if (
                !nonnegativeInteger(limit) ||
                !nonnegativeInteger(timeoutMs) ||
                !nonnegativeInteger(maxOutputBytes) ||
                !Number.isFinite(responseDeadline) ||
                (echo !== undefined && typeof echo !== 'string')
            ) {
                return { kind: 'invalid_input' };
            }

            this.state = 'waiting';
            this.sinkListening = true;
            this.sink.on('close', this.onClose);
            this.sink.on('error', this.onError);
            this.sink.on('finish', this.onFinish);

            if (externalAbortSignal) {
                this.abortListener = addAbortListener(externalAbortSignal, () =>
                    this.stop('aborted'),
                );

                if (externalAbortSignal.aborted) {
                    this.stop('aborted');
                }
            }

            this.armDeadline();
            const stopped = this.check();

            if (stopped) {
                return { kind: stopped };
            }

            let suffix: string;

            try {
                suffix = `,"message":""${echo === undefined ? '' : `,"echo":${JSON.stringify(echo)}`}}`;
            } catch {
                return await this.fallback(echo);
            }

            const overhead = Buffer.byteLength(prefix, 'utf8') + Buffer.byteLength(suffix, 'utf8');
            const budget = Math.min(maxOutputBytes - overhead, this.maxQueueBytes);

            if (budget < 2) {
                return await this.fallback(echo);
            }

            const result = await this.queue.reserve({
                limit,
                timeoutMs,
                maxBatchBytes: budget,
                signal: this.controller.signal,
            });

            // Always observe the original promise and take a late reservation,
            // even if cancellation or expiry happened before this continuation.
            if (result.status === 'reserved') {
                token = result.token;
                tokenOwned = true;
            }

            const afterReserve = this.check();

            if (afterReserve) {
                if (tokenOwned) {
                    tokenOwned = false;

                    if (!token || !this.release(token)) {
                        return { kind: 'release_unknown' };
                    }
                }

                return { kind: afterReserve };
            }

            if (result.status !== 'reserved') {
                if (result.status === 'empty' || result.status === 'timeout') {
                    if (this.emptyPolicy === 'unavailable') {
                        return { kind: 'empty_unresolved', reason: result.status };
                    }

                    const body = `${prefix}[]${suffix}`;

                    if (Buffer.byteLength(body, 'utf8') > maxOutputBytes) {
                        return await this.fallback(echo);
                    }

                    return await this.write(body, { response: 'empty', reason: result.status });
                }

                if (result.status === 'aborted') {
                    return { kind: 'aborted' };
                }

                return { kind: result.status };
            }

            this.state = 'prepared';
            let body: string | undefined;

            try {
                if (
                    typeof result.eventsJson === 'string' &&
                    Buffer.byteLength(result.eventsJson, 'utf8') <= budget &&
                    result.bytes === Buffer.byteLength(result.eventsJson, 'utf8') &&
                    Number.isSafeInteger(result.count) &&
                    result.count > 0
                ) {
                    const parsed: unknown = JSON.parse(result.eventsJson);

                    if (Array.isArray(parsed) && parsed.length === result.count) {
                        if (this.batchOrder === 'fifo') {
                            const candidate = prefix + result.eventsJson + suffix;

                            if (Buffer.byteLength(candidate, 'utf8') <= maxOutputBytes) {
                                body = candidate;
                            }
                        } else {
                            const ordered = orderEventsByTime(parsed);

                            // budget covers both maxQueueBytes and the response envelope.
                            if (
                                ordered !== undefined &&
                                Buffer.byteLength(ordered, 'utf8') <= budget
                            ) {
                                const candidate = prefix + ordered + suffix;

                                if (Buffer.byteLength(candidate, 'utf8') <= maxOutputBytes) {
                                    body = candidate;
                                }
                            }
                        }
                    }
                }
            } catch {
                // Treat malformed controlled fake results as a preparation failure.
            }

            if (body === undefined) {
                tokenOwned = false;

                if (!token || !this.release(token)) {
                    return { kind: 'release_unknown' };
                }

                return await this.fallback(echo);
            }

            // isOpen() can synchronously change epoch or clock after their first
            // samples. Recheck without reentering the sink; injected sampling may
            // itself reenter, so this is not an atomic or hard real-time guarantee.
            let beforeCommit = this.check() ?? this.check(false);
            const listenerGuard = this.listenerGuard;

            if (!beforeCommit && listenerGuard !== undefined) {
                try {
                    if (listenerGuard() !== true) {
                        this.stop('epoch_invalid');
                    }
                } catch {
                    this.stop('epoch_invalid');
                }

                // The trusted listener check can reenter cancellation, source or
                // listener lifecycle code. Recheck the sink, owner and deadline.
                beforeCommit = this.stopReason ?? this.check() ?? this.check(false);

                if (!beforeCommit) {
                    // The recheck can itself change listener readiness. Sample the
                    // same trusted guard last; do not invoke another host callback
                    // between this sample and the commit. This is not atomic.
                    try {
                        if (listenerGuard() !== true) {
                            this.stop('epoch_invalid');
                        }
                    } catch {
                        this.stop('epoch_invalid');
                    }

                    beforeCommit = this.stopReason;
                }
            }

            if (beforeCommit) {
                tokenOwned = false;

                if (!token || !this.release(token)) {
                    return { kind: 'release_unknown' };
                }

                return { kind: beforeCommit };
            }

            this.state = 'committing';
            tokenOwned = false;
            let committed: boolean;

            try {
                committed = this.queue.commit(token!);
            } catch {
                // A thrown commit may already have consumed the queue head.
                return { kind: 'commit_unknown' };
            }

            if (!committed) {
                return { kind: 'commit_rejected' };
            }

            this.committed = true;

            if (this.check()) {
                return { kind: 'committed_unsent' };
            }

            // No await between the post-commit check and beginning the first write.
            return await this.write(body, { response: 'events' });
        } catch {
            if (tokenOwned && token) {
                tokenOwned = false;

                if (!this.release(token)) {
                    return { kind: 'release_unknown' };
                }
            }

            return this.stopReason ? { kind: this.stopReason } : { kind: 'queue_error' };
        }
    }
}
