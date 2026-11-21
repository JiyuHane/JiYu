export type DirectQueueErrorCode =
    | 'operation-queue-closed'
    | 'operation-queue-full'
    | 'operation-queue-expired'
    | 'operation-queue-cancelled';

export class DirectQueueError extends Error {
    constructor(readonly code: DirectQueueErrorCode) {
        super(code);
        this.name = 'DirectQueueError';
    }
}

interface QueueItem {
    deadline: number;
    run: (remainingMs: number) => Promise<void>;
    reject: (error: DirectQueueError) => void;
    cost: number;
    timer: ReturnType<typeof setTimeout> | undefined;
    unlisten: (() => void) | undefined;
}

export interface DirectQueueOptions {
    /** Includes the active operation. */
    maxPending?: number;
    /** Sum of caller-owned bytes retained by queued and active operations. */
    maxBytes?: number;
}

export interface DirectQueuedOperation {
    timeoutMs: number;
    cost: number;
    /** Cancels before dispatch only. The work owns cancellation once dispatched. */
    signal?: AbortSignal;
}

/** One account generation, one active owner call. No retries or replay.
 * Dispatch always leaves the current callback stack, including a push callback.
 * An active call owns its remaining deadline; close waits for its real settlement
 * rather than pretending a timed-out promise has released the transport. */
export class DirectOperationQueue {
    private readonly pending: QueueItem[] = [];
    private readonly maxPending: number;
    private readonly maxBytes: number;
    private bytes = 0;
    private active: QueueItem | undefined;
    private scheduled: ReturnType<typeof setImmediate> | undefined;
    private stopped = false;
    private closing: Promise<void> | undefined;
    private finishClosing: (() => void) | undefined;

    constructor(options: DirectQueueOptions = {}) {
        this.maxPending = options.maxPending ?? 64;
        this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;

        if (
            !Number.isSafeInteger(this.maxPending) ||
            this.maxPending < 1 ||
            this.maxPending > 1024 ||
            !Number.isSafeInteger(this.maxBytes) ||
            this.maxBytes < 0 ||
            this.maxBytes > 16 * 1024 * 1024
        ) {
            throw new TypeError('invalid direct queue limits');
        }
    }

    get size(): number {
        return this.pending.length + (this.active ? 1 : 0);
    }

    get retainedBytes(): number {
        return this.bytes;
    }

    enqueue<T>(
        options: DirectQueuedOperation,
        work: (remainingMs: number) => Promise<T>,
    ): Promise<T> {
        const { timeoutMs, cost, signal } = options;

        if (
            !Number.isSafeInteger(timeoutMs) ||
            timeoutMs < 1 ||
            timeoutMs > 120000 ||
            !Number.isSafeInteger(cost) ||
            cost < 0 ||
            typeof work !== 'function'
        ) {
            throw new TypeError('invalid direct queued operation');
        }

        if (this.stopped) {
            return Promise.reject(new DirectQueueError('operation-queue-closed'));
        }

        if (signal?.aborted) {
            return Promise.reject(new DirectQueueError('operation-queue-cancelled'));
        }

        if (this.size >= this.maxPending || cost > this.maxBytes - this.bytes) {
            return Promise.reject(new DirectQueueError('operation-queue-full'));
        }

        const deadline = performance.now() + timeoutMs;
        return new Promise<T>((resolve, reject) => {
            const item: QueueItem = {
                deadline,
                cost,
                reject,
                timer: undefined,
                unlisten: undefined,
                run: async (remainingMs) => {
                    try {
                        resolve(await work(remainingMs));
                    } catch (error) {
                        reject(error);
                    }
                },
            };
            this.pending.push(item);
            this.bytes += cost;
            item.timer = setTimeout(() => {
                this.remove(item, 'operation-queue-expired');
            }, timeoutMs);

            if (signal) {
                const abort = () => this.remove(item, 'operation-queue-cancelled');
                signal.addEventListener('abort', abort, { once: true });
                item.unlisten = () => signal.removeEventListener('abort', abort);

                if (signal.aborted) {
                    abort();
                }
            }

            this.schedule();
        });
    }

    /** Stop admission synchronously; drain the active call. Its owner must also
     * close/abort the transport, in parallel, if that call is waiting on IO. */
    close(): Promise<void> {
        if (this.closing) {
            return this.closing;
        }

        this.stopped = true;
        this.closing = new Promise<void>((resolve) => {
            this.finishClosing = resolve;
        });

        if (this.scheduled) {
            clearImmediate(this.scheduled);
            this.scheduled = undefined;
        }

        for (const item of this.pending.splice(0)) {
            this.releaseWaiters(item);
            this.bytes -= item.cost;
            item.reject(new DirectQueueError('operation-queue-closed'));
        }

        this.settleClose();
        return this.closing;
    }

    private releaseWaiters(item: QueueItem): void {
        if (item.timer !== undefined) {
            clearTimeout(item.timer);
            item.timer = undefined;
        }

        item.unlisten?.();
        item.unlisten = undefined;
    }

    private remove(item: QueueItem, code: DirectQueueErrorCode): void {
        const index = this.pending.indexOf(item);

        if (index === -1) {
            return;
        }

        this.pending.splice(index, 1);
        this.releaseWaiters(item);
        this.bytes -= item.cost;
        item.reject(new DirectQueueError(code));
    }

    private settleClose(): void {
        if (this.stopped && !this.active) {
            this.finishClosing?.();
            this.finishClosing = undefined;
        }
    }

    private schedule(): void {
        if (this.stopped || this.active || this.scheduled || this.pending.length === 0) {
            return;
        }

        this.scheduled = setImmediate(() => {
            this.scheduled = undefined;
            const item = this.pending.shift();

            if (!item) {
                return;
            }

            this.releaseWaiters(item);
            const remainingMs = Math.floor(item.deadline - performance.now());

            if (remainingMs < 1) {
                this.bytes -= item.cost;
                item.reject(new DirectQueueError('operation-queue-expired'));
                this.schedule();
                return;
            }

            this.active = item;
            void item.run(remainingMs).finally(() => {
                this.active = undefined;
                this.bytes -= item.cost;
                this.settleClose();
                this.schedule();
            });
        });
    }
}
