import { addAbortListener } from 'node:events';
import { isProxy } from 'node:util/types';

/** Offline, in-memory, single-process prototype; this is not an HTTP action.
 * The owner binds a separate instance to each account and validates event conversion,
 * account/self, authorization and source epoch. This only requires a nonempty type
 * and excludes meta; it does not validate a OneBot schema or account ownership.
 * A reservation is neither a server response nor proof of remote delivery. Its owner
 * must explicitly commit or release; an abandoned reservation blocks later polls.
 * Transport needs its own cancellation/deadline and an explicit delivery policy.
 * A local HTTP finish is not remote receipt; retry after partial writes can duplicate.
 * Once reserved, signal abort does not release the token: its owner must do so.
 * Returned strings remain with their caller after release or close and cannot be
 * revoked or prevented from being sent by that caller. close discards queued data.
 *
 * maxEventBytes includes the encoded event plus two enclosing array brackets;
 * maxQueueBytes and maxBatchBytes cover JSON arrays including commas and brackets;
 * maxBatchBytes defaults to maxQueueBytes. Neither includes an HTTP envelope or echo.
 * A blocked result reports requiredBytes as head event JSON plus [] and keeps it queued.
 * Event strings/keys, depth (32) and nodes (8192)
 * are independently bounded; these limits may reject otherwise small wire data.
 * Reflect.ownKeys first allocates for event, config and options before size checks;
 * config and options must come from a trusted owner and be bounded beforehand.
 * Encoded budgets do not bound RSS: stringify escapes, join, retained caller copies,
 * native Promise and AbortSignal machinery may allocate additional memory.
 * Pending timers are ref'ed and can keep the process alive; the owner must close.
 * Synchronous drain may process all maxWaiters (at most 1024), with potentially
 * quadratic array movement; it gives no per-tick fairness or CPU-time guarantee.
 * Assumes untampered built-ins; same-process hostile code is not isolated.
 * JSON number semantics apply (including -0 becoming 0).
 */
export interface PollBufferConfig {
    capacity: number;
    maxQueueBytes: number;
    maxEventBytes: number;
    maxWaiters: number;
    maxTimeoutMs: number;
}

export type EnqueueResult = 'accepted' | 'full' | 'oversize' | 'invalid' | 'meta' | 'closed';
export type PollResult =
    | { status: 'reserved'; token: object; eventsJson: string; count: number; bytes: number }
    | { status: 'blocked'; requiredBytes: number }
    | { status: 'empty' | 'timeout' | 'aborted' | 'closed' | 'busy' | 'invalid' };
export interface PollOptions {
    limit?: number;
    timeoutMs?: number;
    maxBatchBytes?: number;
    signal?: AbortSignal;
}

type Entry = { json: string; bytes: number };
type Waiter = {
    limit: number;
    budget: number;
    deadline: number;
    signal?: AbortSignal;
    resolve: (value: PollResult) => void;
    timer?: ReturnType<typeof setTimeout>;
    listener?: Disposable;
};

const caps: PollBufferConfig = {
    capacity: 10000,
    maxQueueBytes: 64 * 1024 * 1024,
    maxEventBytes: 1024 * 1024,
    maxWaiters: 1024,
    maxTimeoutMs: 3600000,
};
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const tooLarge = Symbol('oversize');

/** Data descriptors only; never calls a caller's getter or toJSON. */
function snapshotEvent(input: unknown, maxBytes: number): Entry | 'invalid' | 'oversize' | 'meta' {
    let nodes = 0;
    let textBytes = 0;
    const ancestors = new WeakSet<object>();

    function text(value: string): void {
        if (value.length > maxBytes) {
            throw tooLarge;
        }

        textBytes += Buffer.byteLength(value, 'utf8');

        if (textBytes > maxBytes) {
            throw tooLarge;
        }
    }

    function visit(value: unknown, depth: number): unknown {
        if (++nodes > 8192 || depth > 32) {
            throw tooLarge;
        }

        if (value === null || typeof value === 'boolean') {
            return value;
        }

        if (typeof value === 'string') {
            text(value);
            return value;
        }

        if (
            typeof value === 'number' &&
            Number.isFinite(value) &&
            Math.abs(value) <= Number.MAX_SAFE_INTEGER
        ) {
            return value;
        }

        if (typeof value !== 'object' || isProxy(value) || ancestors.has(value)) {
            throw new Error('invalid value');
        }

        const array = Array.isArray(value);
        const proto = Object.getPrototypeOf(value);

        if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
            throw new Error('invalid prototype');
        }

        const keys = Reflect.ownKeys(value);

        if (keys.length > 8193) {
            throw tooLarge;
        }

        const length = array ? Object.getOwnPropertyDescriptor(value, 'length')?.value : 0;

        if (array && (!Number.isSafeInteger(length) || length < 0 || length > 8192)) {
            throw tooLarge;
        }

        const result: unknown[] | Record<string, unknown> = array
            ? Object.setPrototypeOf(new Array(length), null)
            : Object.create(null);
        let elements = 0;
        ancestors.add(value);

        for (const key of keys) {
            if (typeof key !== 'string') {
                throw new Error('symbol key');
            }

            if (array && key === 'length') {
                continue;
            }

            if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) {
                throw new Error('invalid array');
            }

            // Array index names do not appear in JSON and do not consume text budget.
            if (!array) {
                text(key);
            }

            const descriptor = Object.getOwnPropertyDescriptor(value, key);

            if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
                throw new Error('invalid descriptor');
            }

            Object.defineProperty(result, key, {
                value: visit(descriptor.value, depth + 1),
                enumerable: true,
                writable: true,
                configurable: true,
            });
            elements++;
        }

        if (array && elements !== length) {
            throw new Error('sparse array');
        }

        ancestors.delete(value);
        return result;
    }

    try {
        if (typeof input !== 'object' || input === null || isProxy(input) || Array.isArray(input)) {
            return 'invalid';
        }

        const value = visit(input, 0) as Record<string, unknown>;

        if (typeof value.type !== 'string' || value.type.length === 0) {
            return 'invalid';
        }

        if (value.type === 'meta') {
            return 'meta';
        }

        const json = JSON.stringify(value);
        const bytes = Buffer.byteLength(json, 'utf8');
        return bytes + 2 > maxBytes ? 'oversize' : { json, bytes };
    } catch (error) {
        return error === tooLarge ? 'oversize' : 'invalid';
    }
}

/** Only primitive own data properties; prevents option getters and Proxy traps. */
function dataOptions(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        return null;
    }

    try {
        if (
            Object.getPrototypeOf(value) !== Object.prototype &&
            Object.getPrototypeOf(value) !== null
        ) {
            return null;
        }

        const output: Record<string, unknown> = Object.create(null);

        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== 'string' || !keys.includes(key)) {
                return null;
            }

            const descriptor = Object.getOwnPropertyDescriptor(value, key);

            if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
                return null;
            }

            output[key] = descriptor.value;
        }

        return output;
    } catch {
        return null;
    }
}

function integer(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function validSignal(value: unknown): value is AbortSignal {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        return false;
    }

    try {
        if (
            Object.getPrototypeOf(value) !== AbortSignal.prototype ||
            ['aborted', 'addEventListener', 'removeEventListener'].some((key) =>
                Object.getOwnPropertyDescriptor(value, key),
            )
        ) {
            return false;
        }

        signalAborted.call(value);
        return true;
    } catch {
        return false;
    }
}

export class EventPollBuffer {
    private readonly config: PollBufferConfig;
    private queue: Entry[] = [];
    private sumBytes = 0;
    private waiters: Waiter[] = [];
    private active: { token: object; count: number } | null = null;
    private closed = false;

    constructor(config: PollBufferConfig) {
        const input = dataOptions(config, Object.keys(caps));

        if (
            !input ||
            Object.keys(caps).some(
                (key) => !integer(input[key], 1, caps[key as keyof PollBufferConfig]),
            )
        ) {
            throw new RangeError('invalid poll buffer config');
        }

        this.config = input as unknown as PollBufferConfig;

        if (
            this.config.maxQueueBytes < 2 ||
            this.config.maxEventBytes < 2 ||
            this.config.maxEventBytes > this.config.maxQueueBytes
        ) {
            throw new RangeError('inconsistent byte budgets');
        }
    }

    /** queueBytes includes array brackets and separators, including reserved entries. */
    stats(): {
        count: number;
        queueBytes: number;
        waiters: number;
        reserved: number;
        closed: boolean;
    } {
        return {
            count: this.queue.length,
            queueBytes: this.sumBytes + Math.max(0, this.queue.length - 1) + 2,
            waiters: this.waiters.length,
            reserved: this.active?.count ?? 0,
            closed: this.closed,
        };
    }

    enqueue(input: unknown): EnqueueResult {
        if (this.closed) {
            return 'closed';
        }

        const event = snapshotEvent(input, this.config.maxEventBytes);

        if (typeof event === 'string') {
            return event;
        }

        if (
            this.queue.length >= this.config.capacity ||
            this.sumBytes + event.bytes + this.queue.length + 2 > this.config.maxQueueBytes
        ) {
            return 'full';
        }

        this.queue.push(event);
        this.sumBytes += event.bytes;
        this.drain();
        return 'accepted';
    }

    reserve(options: PollOptions = {}): Promise<PollResult> {
        const start = performance.now();
        const input = dataOptions(options, ['limit', 'timeoutMs', 'maxBatchBytes', 'signal']);

        if (!input) {
            return Promise.resolve({ status: 'invalid' });
        }

        const limit = input.limit === undefined ? 0 : input.limit;
        const timeout = input.timeoutMs === undefined ? 0 : input.timeoutMs;
        const budget =
            input.maxBatchBytes === undefined ? this.config.maxQueueBytes : input.maxBatchBytes;
        const signal = input.signal;

        if (
            !integer(limit, 0, Number.MAX_SAFE_INTEGER) ||
            !integer(timeout, 0, this.config.maxTimeoutMs) ||
            !integer(budget, 2, this.config.maxQueueBytes) ||
            (signal !== undefined && !validSignal(signal))
        ) {
            return Promise.resolve({ status: 'invalid' });
        }

        if (signal && signalAborted.call(signal)) {
            return Promise.resolve({ status: 'aborted' });
        }

        if (this.closed) {
            return Promise.resolve({ status: 'closed' });
        }

        if (timeout === 0) {
            if (this.active || this.waiters.length || !this.queue.length) {
                return Promise.resolve({ status: 'empty' });
            }

            return Promise.resolve(this.select(limit, budget));
        }

        if (this.waiters.length >= this.config.maxWaiters) {
            return Promise.resolve({ status: 'busy' });
        }

        return new Promise((resolve) => {
            const waiter: Waiter = {
                limit,
                budget,
                deadline: start + timeout,
                signal: signal as AbortSignal | undefined,
                resolve,
            };

            this.waiters.push(waiter);

            if (waiter.signal) {
                waiter.listener = addAbortListener(waiter.signal, () => {
                    this.finish(waiter, {
                        status: performance.now() >= waiter.deadline ? 'timeout' : 'aborted',
                    });
                    this.drain();
                });
            }

            const expire = () => {
                const remaining = waiter.deadline - performance.now();

                if (remaining > 0) {
                    waiter.timer = setTimeout(expire, Math.ceil(remaining));
                    return;
                }

                this.finish(waiter, { status: 'timeout' });
                this.drain();
            };

            waiter.timer = setTimeout(
                expire,
                Math.max(0, Math.ceil(waiter.deadline - performance.now())),
            );

            if (waiter.signal && signalAborted.call(waiter.signal)) {
                this.finish(waiter, {
                    status: performance.now() >= waiter.deadline ? 'timeout' : 'aborted',
                });
            }

            this.drain();
        });
    }

    private select(limit: number, budget: number): PollResult {
        const first = this.queue[0];

        if (first.bytes + 2 > budget) {
            return { status: 'blocked', requiredBytes: first.bytes + 2 };
        }

        let bytes = 2;
        let count = 0;
        const parts: string[] = [];

        for (const item of this.queue) {
            if (limit && count >= limit) {
                break;
            }

            const next = bytes + item.bytes + (count ? 1 : 0);

            if (next > budget) {
                break;
            }

            bytes = next;
            parts.push(item.json);
            count++;
        }

        const token = Object.freeze({});
        this.active = { token, count };
        return { status: 'reserved', token, count, bytes, eventsJson: `[${parts.join(',')}]` };
    }

    private finish(waiter: Waiter, result: PollResult): void {
        const index = this.waiters.indexOf(waiter);

        if (index < 0) {
            return;
        }

        this.waiters.splice(index, 1);

        if (waiter.timer !== undefined) {
            clearTimeout(waiter.timer);
        }

        waiter.listener?.[Symbol.dispose]();

        waiter.resolve(result);
    }

    private drain(): void {
        while (!this.closed && !this.active && this.waiters.length) {
            const waiter = this.waiters[0];

            if (performance.now() >= waiter.deadline) {
                this.finish(waiter, { status: 'timeout' });
            } else if (waiter.signal && signalAborted.call(waiter.signal)) {
                this.finish(waiter, { status: 'aborted' });
            } else if (this.queue.length) {
                this.finish(waiter, this.select(waiter.limit, waiter.budget));
            } else {
                break;
            }
        }
    }

    commit(token: object): boolean {
        if (!this.active || this.active.token !== token) {
            return false;
        }

        for (const entry of this.queue.splice(0, this.active.count)) {
            this.sumBytes -= entry.bytes;
        }

        this.active = null;
        this.drain();
        return true;
    }

    release(token: object): boolean {
        if (!this.active || this.active.token !== token) {
            return false;
        }

        this.active = null;
        this.drain();
        return true;
    }

    /** Discards all entries, revokes the active token, resolves all waiters. */
    close(): boolean {
        if (this.closed) {
            return false;
        }

        this.closed = true;
        this.active = null;
        this.queue = [];
        this.sumBytes = 0;

        for (const waiter of [...this.waiters]) {
            this.finish(waiter, { status: 'closed' });
        }

        return true;
    }
}
