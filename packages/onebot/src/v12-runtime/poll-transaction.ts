import { addAbortListener } from 'node:events';
import type { PollOptions, PollResult } from './event-poll-buffer';

/** Internal transaction seam: an explicitly activated runtime owner and an injected
 * HTTP capability can use it, but the production runtime does not wire them together.
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
 */
export interface PollQueue {
    reserve(options: PollOptions): Promise<PollResult>;
    commit(token: object): boolean;
    release(token: object): boolean;
}

export interface PollSink {
    isOpen(): boolean;
    on(event: 'close' | 'error' | 'finish', listener: () => void): void;
    off(event: 'close' | 'error' | 'finish', listener: () => void): void;
    writeHead(): void;
    end(body: string): void;
}

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
    | { readonly kind: 'blocked' | 'invalid' | 'busy' | 'contended' };

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

const prefix = '{"status":"ok","retcode":0,"data":';
const unknownMessage =
    'outcome unknown; side effects may have occurred; do not retry automatically';
const maxTimer = 2_147_483_647;

function nonnegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** The functions and queue are trusted owner dependencies, not request-selected callbacks. */
export class PollCoordinator {
    private closed = false;
    private readonly transactions = new Set<PollTransaction>();

    constructor(
        private readonly queue: PollQueue,
        private readonly maxQueueBytes: number,
        private readonly now: () => number,
        private readonly isEpochValid: () => boolean,
        private readonly emptyPolicy: 'legacy' | 'unavailable' = 'legacy',
    ) {
        if (!nonnegativeInteger(maxQueueBytes) || maxQueueBytes < 2) {
            throw new RangeError('invalid queue budget');
        }

        if (emptyPolicy !== 'legacy' && emptyPolicy !== 'unavailable') {
            throw new RangeError('invalid empty policy');
        }
    }

    create(request: PollRequest, sink: PollSink): PollTransaction {
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
        );

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
    private readonly request: PollRequest;

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
    ) {
        if (emptyPolicy !== 'legacy' && emptyPolicy !== 'unavailable') {
            throw new RangeError('invalid empty policy');
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
        } else if (this.endReturned && !this.check(false)) {
            this.finishLocalWrite();
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
        const stop = this.check();

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

            if (!this.writeOutcome) {
                this.endStarted = true;
                this.sink.end(body);
                this.endReturned = true;
                // A normal finish can make the sink no longer writable, so only
                // epoch and clock are checked after end, not isOpen().
                this.check(false);

                if (this.finishSeen && !this.writeOutcome && !this.stopReason) {
                    this.finishLocalWrite();
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
        const outcome = await this.executeCore();
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
        return this.cleanupUncertain
            ? {
                  kind: 'cleanup_uncertain',
                  outcome,
                  committed: outcome.kind === 'commit_unknown' ? 'unknown' : this.committed,
              }
            : outcome;
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
                        const candidate = prefix + result.eventsJson + suffix;

                        if (Buffer.byteLength(candidate, 'utf8') <= maxOutputBytes) {
                            body = candidate;
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

            const beforeCommit = this.check();

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
