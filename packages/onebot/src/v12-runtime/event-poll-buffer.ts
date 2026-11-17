import { addAbortListener } from 'node:events';
import { isProxy } from 'node:util/types';
import {
    isPrivateRecallPollEpochAccountScopeActive,
    isPrivateRecallPollProofCurrent,
    isPrivateRecallPollProofFor,
    isPrivateRecallPollProofInEpochAccountScope,
} from './private-recall-source';

/** In-memory, single-process queue primitive; this is not itself an HTTP action.
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
 * Only the trusted owner selects the construction-time overflow policy. The default
 * rejects new events; drop-oldest protects the reserved physical prefix, and rejects
 * the new event without eviction if removing the entire unreserved tail is insufficient.
 * Its exact bigint drop watermark is in-memory, never reset, and is not part of JSON
 * output. Its dynamically growing representation is not covered by an RSS hard limit.
 *
 * The optional fourth constructor argument enables an exact epoch/account scope on
 * a guarded queue. The production HTTP event-time owner uses it for ordinary events;
 * private-recall HTTP admission remains separate and is not enabled by the queue alone.
 * The scope proves registration and proof/ticket/account/epoch correlation, not online state,
 * ticket issuance for an account, or manager/gate ownership. The trusted owner must
 * verify current lifecycle state separately after all potentially reentrant checks.
 * Retiring a scope does not notify waiting polls: they may wait for timeout, abort,
 * or owner close. Close drops this queue's scope reference; it does not retire a scope
 * potentially shared with another owner. No scope, proof or ticket is serialized.
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

export type EnqueueResult =
    | 'accepted'
    | 'full'
    | 'oversize'
    | 'invalid'
    | 'meta'
    | 'closed'
    | 'uncertain'
    | 'scope_revoked';
export type PollResult =
    | { status: 'reserved'; token: object; eventsJson: string; count: number; bytes: number }
    | { status: 'blocked'; requiredBytes: number }
    | { status: 'empty' | 'contended' | 'timeout' | 'aborted' | 'closed' | 'busy' | 'invalid' };
export interface PollOptions {
    limit?: number;
    timeoutMs?: number;
    maxBatchBytes?: number;
    signal?: AbortSignal;
}

export type GuardedSelection =
    | Readonly<{
          status: 'reserved';
          token: object;
          eventsJson: string;
          count: number;
          bytes: number;
      }>
    | Readonly<{ status: 'blocked_guarded'; token: object; requiredBytes: number }>;
export type GuardedPollResult =
    | GuardedSelection
    | Exclude<PollResult, { status: 'reserved' }>
    | { status: 'uncertain' | 'scope_revoked' };
export type GuardedCommitResult =
    | { status: 'committed' }
    | { status: 'pruned'; count: number }
    | { status: 'stale' | 'uncertain' | 'scope_revoked' };
export type GuardedBlockedResult =
    | { status: 'blocked'; requiredBytes: number }
    | { status: 'pruned'; count: number }
    | { status: 'stale' | 'uncertain' | 'scope_revoked' };
export type GuardedReleaseResult = { status: 'released' | 'stale' | 'uncertain' };
export type GuardedDrainResult = { status: 'resumed' | 'stale' | 'uncertain' | 'scope_revoked' };
export type GuardedCleanupState = 'open' | 'closing' | 'closed' | 'uncertain' | 'unavailable';

type Entry = { json: string; bytes: number };
type Snapshot = { entry: Entry; privateRecall: boolean };
type GuardedMetadata =
    | Readonly<{ kind: 'ordinary' }>
    | Readonly<{ kind: 'recall'; proof: unknown; eventTicket?: unknown }>;
type GuardedSlot = { entry: Entry; json: string; bytes: number; metadata: GuardedMetadata };
type GuardedActive = { selection: GuardedSelection; slots: GuardedSlot[]; count: number };
type Waiter = {
    limit: number;
    budget: number;
    deadline: number;
    signal?: AbortSignal;
    resolve: (value: GuardedPollResult) => void;
    timer?: ReturnType<typeof setTimeout>;
    listener?: Disposable;
};
type GuardedWaiter = Waiter & { timerGeneration?: object };

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
function snapshotEvent(
    input: unknown,
    maxBytes: number,
): Snapshot | 'invalid' | 'oversize' | 'meta' {
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
        return bytes + 2 > maxBytes
            ? 'oversize'
            : {
                  entry: { json, bytes },
                  privateRecall:
                      value.type === 'notice' && value.detail_type === 'private_message_delete',
              };
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
    private readonly overflowPolicy: 'reject-new' | 'drop-oldest';
    private queue: Entry[] = [];
    private sumBytes = 0;
    #droppedOldest = 0n;
    private waiters: Waiter[] = [];
    private active: { token: object; count: number } | null = null;
    private closed = false;

    // Keep guarded backing storage, attestation and token ownership out of the
    // ordinary object graph. The legacy queue remains untouched for its callers.
    readonly #mode: 'legacy' | 'guarded-recall';
    readonly #guardedConfig: Readonly<PollBufferConfig> | null;
    readonly #guardedOverflowPolicy: 'reject-new' | 'drop-oldest';
    readonly #guardedScoped: boolean;
    #guardedScope: unknown;
    #guardedQueue: Entry[] = [];
    #guardedBytes = 0;
    #guardedMetadata = new WeakMap<Entry, GuardedMetadata>();
    #guardedWaiters: GuardedWaiter[] = [];
    #guardedActive: GuardedActive | null = null;
    #guardedBarrier: object | null = null;
    #guardedResuming = false;
    #guardedDraining = false;
    #guardedUncertain = false;
    #guardedClosed = false;
    #guardedCleanup: GuardedCleanupState = 'open';
    #guardedResourceScopes = 0;

    constructor(
        config: PollBufferConfig,
        overflowPolicy: 'reject-new' | 'drop-oldest' = 'reject-new',
        mode: 'legacy' | 'guarded-recall' = 'legacy',
        scope?: unknown,
    ) {
        const scoped = arguments.length >= 4;

        if (
            scoped &&
            (mode !== 'guarded-recall' || !isPrivateRecallPollEpochAccountScopeActive(scope))
        ) {
            throw new RangeError('invalid or retired poll scope');
        }

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

        if (overflowPolicy !== 'reject-new' && overflowPolicy !== 'drop-oldest') {
            throw new RangeError('invalid poll buffer overflow policy');
        }

        if (mode !== 'legacy' && mode !== 'guarded-recall') {
            throw new RangeError('invalid poll buffer mode');
        }

        if (scoped && !isPrivateRecallPollEpochAccountScopeActive(scope)) {
            throw new RangeError('invalid or retired poll scope');
        }

        this.overflowPolicy = overflowPolicy;
        this.#mode = mode;
        this.#guardedConfig =
            mode === 'guarded-recall'
                ? Object.freeze({
                      capacity: this.config.capacity,
                      maxQueueBytes: this.config.maxQueueBytes,
                      maxEventBytes: this.config.maxEventBytes,
                      maxWaiters: this.config.maxWaiters,
                      maxTimeoutMs: this.config.maxTimeoutMs,
                  })
                : null;
        this.#guardedOverflowPolicy = overflowPolicy;
        this.#guardedScoped = scoped;
        this.#guardedScope = scoped ? scope : undefined;
    }

    /** Construct an opt-in queue bound to this exact active scope; no implicit fallback. */
    static scoped(
        config: PollBufferConfig,
        overflowPolicy: 'reject-new' | 'drop-oldest',
        scope: unknown,
    ): EventPollBuffer {
        return new EventPollBuffer(config, overflowPolicy, 'guarded-recall', scope);
    }

    /** queueBytes includes array brackets and separators, including reserved entries. */
    stats(): {
        count: number;
        queueBytes: number;
        waiters: number;
        reserved: number;
        closed: boolean;
    } {
        if (this.#mode === 'guarded-recall') {
            return {
                count: this.#guardedQueue.length,
                queueBytes: this.#guardedBytes + Math.max(0, this.#guardedQueue.length - 1) + 2,
                waiters: this.#guardedWaiters.length,
                reserved: this.#guardedActive?.count ?? 0,
                closed: this.#guardedClosed,
            };
        }

        return {
            count: this.queue.length,
            queueBytes: this.sumBytes + Math.max(0, this.queue.length - 1) + 2,
            waiters: this.waiters.length,
            reserved: this.active?.count ?? 0,
            closed: this.closed,
        };
    }

    /**
     * Guarded cleanup state is local to this queue. `closing` means close was
     * requested while a guarded synchronous operation or timer/abort callback
     * remains in flight, including its timer/listener creation or cleanup.
     * Pending Promise lifetimes, transport work and external owner callbacks are
     * not counted. `uncertain` is sticky and takes precedence over `closing`;
     * `stats().closed` and the close boolean alone do not prove cleanup finished.
     * A future owner must retain sticky uncertainty in its gate: waiters already
     * pending during quarantine can still settle as timeout or abort. A new poll
     * on a closed queue reports `closed`, so also consult this cleanup state.
     */
    guardedCleanupState(): GuardedCleanupState {
        if (this.#mode !== 'guarded-recall') {
            return 'unavailable';
        }

        if (this.#guardedUncertain) {
            return 'uncertain';
        }

        return this.#guardedClosed && this.#guardedResourceScopes > 0
            ? 'closing'
            : this.#guardedCleanup;
    }

    /** Exact process-local eviction watermark; close and reads do not reset it. */
    oldestDropCount(): bigint {
        return this.#droppedOldest;
    }

    #guardedScopeActive(): boolean {
        return (
            !this.#guardedScoped || isPrivateRecallPollEpochAccountScopeActive(this.#guardedScope)
        );
    }

    /**
     * Guarded admission copies the queue (O(n), O(capacity²) over a fill).
     * A subsequent drain can throw after publication or eviction: the effect is
     * unknown to the caller, quarantine is sticky, and automatic retry is unsafe.
     */
    enqueue(input: unknown): EnqueueResult {
        if (this.#mode === 'guarded-recall') {
            return this.#runGuarded(() => this.#enqueueGuarded(input, undefined, false));
        }

        if (this.closed) {
            return 'closed';
        }

        const snapshot = snapshotEvent(input, this.config.maxEventBytes);

        if (typeof snapshot === 'string') {
            return snapshot;
        }

        const event = snapshot.entry;

        // A reservation owns the fixed physical prefix [0, protectedCount).
        // Trial removals from its unreserved tail change no state until the new
        // event fits both limits; otherwise even the entire tail remains intact.
        const protectedCount = this.active?.count ?? 0;
        let dropCount = 0;
        let dropBytes = 0;

        while (
            this.queue.length - dropCount >= this.config.capacity ||
            this.sumBytes - dropBytes + event.bytes + this.queue.length - dropCount + 2 >
                this.config.maxQueueBytes
        ) {
            if (
                this.overflowPolicy === 'reject-new' ||
                protectedCount + dropCount >= this.queue.length
            ) {
                return 'full';
            }

            dropBytes += this.queue[protectedCount + dropCount].bytes;
            dropCount++;
        }

        // Prepare the non-saturating watermark before changing the queue. Under the
        // trusted-builtins assumption, eviction, insertion and the watermark
        // update form one synchronous commit before drain can notify waiters.
        const nextOldestDropCount = dropCount
            ? this.#droppedOldest + BigInt(dropCount)
            : this.#droppedOldest;

        if (dropCount) {
            // Build the replacement before publishing it: a failed allocation must
            // not leave old entries evicted without admitting the new event.
            const nextQueue = this.queue.slice();
            nextQueue.splice(protectedCount, dropCount);
            nextQueue.push(event);
            const nextSumBytes = this.sumBytes + event.bytes - dropBytes;
            this.queue = nextQueue;
            this.sumBytes = nextSumBytes;
            this.#droppedOldest = nextOldestDropCount;
        } else {
            this.queue.push(event);
            this.sumBytes += event.bytes;
        }

        this.drain();
        return 'accepted';
    }

    /**
     * Only a factory-issued proof for this exact candidate admits a recall.
     * The guarded admission cost and post-publication throw contract match enqueue.
     */
    enqueueGuarded(candidate: unknown, proof: unknown): EnqueueResult {
        if (this.#mode !== 'guarded-recall' || this.#guardedScoped) {
            return 'invalid';
        }

        return this.#runGuarded(() => this.#enqueueGuarded(candidate, proof, true));
    }

    /**
     * Scoped admission binds the exact candidate, proof and original event ticket
     * to this queue's fixed scope. Retirement rejects all subsequent admissions
     * without eviction; the two-argument guarded recall path is disabled here.
     */
    enqueueScopedRecall(
        candidate: unknown,
        proof: unknown,
        exactEventTicket: unknown,
    ): EnqueueResult {
        if (this.#mode !== 'guarded-recall' || !this.#guardedScoped) {
            return 'invalid';
        }

        return this.#runGuarded(() =>
            this.#enqueueGuarded(candidate, proof, true, exactEventTicket),
        );
    }

    #enqueueGuarded(
        input: unknown,
        proof: unknown,
        recall: boolean,
        eventTicket?: unknown,
    ): EnqueueResult {
        if (this.#guardedClosed) {
            return 'closed';
        }

        if (this.#guardedUncertain) {
            return 'uncertain';
        }

        if (!this.#guardedScopeActive()) {
            return 'scope_revoked';
        }

        if (recall && !isPrivateRecallPollProofFor(proof, input)) {
            return 'invalid';
        }

        if (
            recall &&
            this.#guardedScoped &&
            !isPrivateRecallPollProofInEpochAccountScope(proof, eventTicket, this.#guardedScope)
        ) {
            return this.#guardedScopeActive() ? 'invalid' : 'scope_revoked';
        }

        const snapshot = snapshotEvent(input, this.#guardedConfig!.maxEventBytes);

        if (this.#guardedScoped) {
            if (this.#guardedClosed) {
                return 'closed';
            }

            if (this.#guardedUncertain) {
                return 'uncertain';
            }

            if (!this.#guardedScopeActive()) {
                return 'scope_revoked';
            }
        }

        if (typeof snapshot === 'string') {
            return snapshot;
        }

        if (snapshot.privateRecall !== recall) {
            return 'invalid';
        }

        if (recall && this.#guardedScoped && !isPrivateRecallPollProofFor(proof, input)) {
            return this.#guardedScopeActive() ? 'invalid' : 'scope_revoked';
        }

        if (
            recall &&
            this.#guardedScoped &&
            !isPrivateRecallPollProofInEpochAccountScope(proof, eventTicket, this.#guardedScope)
        ) {
            return this.#guardedScopeActive() ? 'invalid' : 'scope_revoked';
        }

        if (!this.#guardedScopeActive()) {
            return 'scope_revoked';
        }

        const capacity = this.#guardedConfig!.capacity;
        const maxBytes = this.#guardedConfig!.maxQueueBytes;
        const policy = this.#guardedOverflowPolicy;
        const oldQueue = this.#guardedQueue;
        const oldActive = this.#guardedActive;
        const protectedCount = oldActive?.count ?? 0;
        const event = Object.freeze(snapshot.entry);
        let dropCount = 0;
        let dropBytes = 0;

        while (
            oldQueue.length - dropCount >= capacity ||
            this.#guardedBytes - dropBytes + event.bytes + oldQueue.length - dropCount + 2 >
                maxBytes
        ) {
            if (policy === 'reject-new' || protectedCount + dropCount >= oldQueue.length) {
                if (this.#guardedClosed) {
                    return 'closed';
                }

                if (this.#guardedUncertain) {
                    return 'uncertain';
                }

                if (this.#guardedScoped && !this.#guardedScopeActive()) {
                    return 'scope_revoked';
                }

                return 'full';
            }

            dropBytes += oldQueue[protectedCount + dropCount].bytes;
            dropCount++;
        }

        // Never call methods on a replaceable backing array during guarded
        // preparation. Allocate everything before the last candidate check.
        const nextQueue = new Array<Entry>(oldQueue.length - dropCount + 1);
        let destination = 0;

        for (let i = 0; i < oldQueue.length; i++) {
            if (i < protectedCount || i >= protectedCount + dropCount) {
                nextQueue[destination++] = oldQueue[i];
            }
        }

        nextQueue[destination] = event;
        const nextBytes = this.#guardedBytes + event.bytes - dropBytes;
        const nextDropped = dropCount
            ? this.#droppedOldest + BigInt(dropCount)
            : this.#droppedOldest;
        const metadata: GuardedMetadata = recall
            ? this.#guardedScoped
                ? Object.freeze({ kind: 'recall', proof, eventTicket })
                : Object.freeze({ kind: 'recall', proof })
            : Object.freeze({ kind: 'ordinary' });

        if (!this.#guardedScoped) {
            this.#guardedMetadata.set(event, metadata);
        }

        if (this.#guardedClosed) {
            if (!this.#guardedScoped) {
                this.#guardedMetadata.delete(event);
            }

            return 'closed';
        }

        if (this.#guardedUncertain) {
            if (!this.#guardedScoped) {
                this.#guardedMetadata.delete(event);
            }

            return 'uncertain';
        }

        if (!this.#guardedScopeActive()) {
            return 'scope_revoked';
        }

        if (this.#guardedQueue !== oldQueue || this.#guardedActive !== oldActive) {
            if (!this.#guardedScoped) {
                this.#guardedMetadata.delete(event);
            }

            return 'invalid';
        }

        if (recall && !isPrivateRecallPollProofFor(proof, input)) {
            if (!this.#guardedScoped) {
                this.#guardedMetadata.delete(event);
            }

            return 'invalid';
        }

        if (
            recall &&
            this.#guardedScoped &&
            !isPrivateRecallPollProofInEpochAccountScope(proof, eventTicket, this.#guardedScope)
        ) {
            return this.#guardedScopeActive() ? 'invalid' : 'scope_revoked';
        }

        if (!this.#guardedScopeActive()) {
            return 'scope_revoked';
        }

        // No host callback, getter, queue method or clock between the last
        // proof check and publication of this complete replacement.
        if (this.#guardedScoped) {
            this.#guardedMetadata.set(event, metadata);
        }

        this.#guardedQueue = nextQueue;
        this.#guardedBytes = nextBytes;
        this.#droppedOldest = nextDropped;

        for (let i = 0; i < dropCount; i++) {
            this.#guardedMetadata.delete(oldQueue[protectedCount + i]);
        }

        if (!this.#guardedBarrier) {
            this.#requestGuardedDrain();
        }

        return 'accepted';
    }

    reserve(options: PollOptions = {}): Promise<PollResult> {
        if (this.#mode !== 'legacy') {
            return Promise.resolve({ status: 'invalid' });
        }

        return this.reserveInternal(options) as Promise<PollResult>;
    }

    /**
     * In guarded mode, existing close/quarantine wins over option validation and
     * abort. A retired scope prevents new selection, including ordinary entries.
     */
    reserveGuarded(options: PollOptions = {}): Promise<GuardedPollResult> {
        if (this.#mode !== 'guarded-recall') {
            return Promise.resolve({ status: 'invalid' });
        }

        return this.#runGuarded(() => this.#reserveGuarded(options));
    }

    #reserveGuarded(options: PollOptions): Promise<GuardedPollResult> {
        if (this.#guardedClosed) {
            return Promise.resolve({ status: 'closed' });
        }

        if (this.#guardedUncertain) {
            return Promise.resolve({ status: 'uncertain' });
        }

        if (!this.#guardedScopeActive()) {
            return Promise.resolve({ status: 'scope_revoked' });
        }

        let start: number;

        try {
            start = performance.now();
        } catch {
            this.#quarantineGuarded();
            return Promise.resolve({ status: 'uncertain' });
        }

        if (this.#guardedClosed) {
            return Promise.resolve({ status: 'closed' });
        }

        if (this.#guardedUncertain) {
            return Promise.resolve({ status: 'uncertain' });
        }

        if (!this.#guardedScopeActive()) {
            return Promise.resolve({ status: 'scope_revoked' });
        }

        const input = dataOptions(options, ['limit', 'timeoutMs', 'maxBatchBytes', 'signal']);

        if (!input) {
            return Promise.resolve({ status: 'invalid' });
        }

        const limit = input.limit === undefined ? 0 : input.limit;
        const timeout = input.timeoutMs === undefined ? 0 : input.timeoutMs;
        const config = this.#guardedConfig!;
        const budget =
            input.maxBatchBytes === undefined ? config.maxQueueBytes : input.maxBatchBytes;
        const signal = input.signal;

        if (
            !integer(limit, 0, Number.MAX_SAFE_INTEGER) ||
            !integer(timeout, 0, config.maxTimeoutMs) ||
            !integer(budget, 2, config.maxQueueBytes) ||
            (signal !== undefined && !validSignal(signal))
        ) {
            return Promise.resolve({ status: 'invalid' });
        }

        if (this.#guardedScoped) {
            if (this.#guardedClosed) {
                return Promise.resolve({ status: 'closed' });
            }

            if (this.#guardedUncertain) {
                return Promise.resolve({ status: 'uncertain' });
            }

            if (!this.#guardedScopeActive()) {
                return Promise.resolve({ status: 'scope_revoked' });
            }
        }

        if (signal && signalAborted.call(signal)) {
            return Promise.resolve({ status: 'aborted' });
        }

        if (this.#guardedClosed) {
            return Promise.resolve({ status: 'closed' });
        }

        if (this.#guardedUncertain) {
            return Promise.resolve({ status: 'uncertain' });
        }

        if (!this.#guardedScopeActive()) {
            return Promise.resolve({ status: 'scope_revoked' });
        }

        if (timeout === 0) {
            if (this.#guardedActive || this.#guardedBarrier || this.#guardedWaiters.length) {
                return Promise.resolve({ status: 'contended' });
            }

            if (!this.#guardedQueue.length) {
                return Promise.resolve({ status: 'empty' });
            }

            return Promise.resolve(this.#selectGuarded(limit, budget));
        }

        if (this.#guardedWaiters.length >= config.maxWaiters) {
            return Promise.resolve({ status: 'busy' });
        }

        return new Promise((resolve) => {
            const waiter: GuardedWaiter = {
                limit,
                budget,
                deadline: start + timeout,
                signal: signal as AbortSignal | undefined,
                resolve,
            };

            // Recheck immediately before publication; no caller callback or
            // replaceable config access may intervene before the dense insert.
            if (this.#guardedClosed) {
                resolve({ status: 'closed' });
                return;
            }

            if (this.#guardedUncertain) {
                resolve({ status: 'uncertain' });
                return;
            }

            if (!this.#guardedScopeActive()) {
                resolve({ status: 'scope_revoked' });
                return;
            }

            if (this.#guardedWaiters.length >= config.maxWaiters) {
                resolve({ status: 'busy' });
                return;
            }

            this.#guardedWaiters[this.#guardedWaiters.length] = waiter;

            try {
                if (waiter.signal) {
                    const listener = addAbortListener(waiter.signal, () =>
                        this.#runGuarded(() => this.#abortGuarded(waiter)),
                    );

                    if (!this.#hasGuardedWaiter(waiter)) {
                        listener[Symbol.dispose]();
                        return;
                    }

                    waiter.listener = listener;
                }

                const now = performance.now();

                if (!this.#hasGuardedWaiter(waiter)) {
                    return;
                }

                this.#scheduleGuarded(waiter, Math.max(0, Math.ceil(waiter.deadline - now)));

                if (!this.#hasGuardedWaiter(waiter)) {
                    return;
                }

                if (waiter.signal && signalAborted.call(waiter.signal)) {
                    this.#abortGuarded(waiter);
                }

                if (this.#hasGuardedWaiter(waiter)) {
                    this.#requestGuardedDrain();
                }
            } catch {
                this.#failGuardedWaiter(waiter);
            }
        });
    }

    private reserveInternal(options: PollOptions): Promise<GuardedPollResult> {
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
            // A short poll must not pass an existing reservation or older waiter.
            // This is distinct from an empty queue, even if the queue currently
            // contains no entries: the caller has not observed an available head.
            if (this.active || this.waiters.length) {
                return Promise.resolve({ status: 'contended' });
            }

            if (!this.queue.length) {
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

    #selectGuarded(limit: number, budget: number): GuardedPollResult {
        if (!this.#guardedScopeActive()) {
            return { status: 'scope_revoked' };
        }

        const first = this.#guardedQueue[0];
        const firstMetadata = this.#guardedMetadata.get(first);

        if (!firstMetadata) {
            this.#quarantineGuarded();
            return { status: 'uncertain' };
        }

        if (first.bytes + 2 > budget) {
            if (firstMetadata.kind === 'ordinary') {
                return { status: 'blocked', requiredBytes: first.bytes + 2 };
            }

            const token = Object.freeze(Object.create(null)) as object;
            const selection: GuardedSelection = Object.freeze({
                status: 'blocked_guarded',
                token,
                requiredBytes: first.bytes + 2,
            });
            this.#guardedActive = {
                selection,
                slots: [
                    { entry: first, json: first.json, bytes: first.bytes, metadata: firstMetadata },
                ],
                count: 1,
            };
            return selection;
        }

        let bytes = 2;
        let count = 0;
        const parts: string[] = [];
        const slots: GuardedSlot[] = [];

        for (let i = 0; i < this.#guardedQueue.length; i++) {
            if (limit && count >= limit) {
                break;
            }

            const entry = this.#guardedQueue[i];
            const next = bytes + entry.bytes + (count ? 1 : 0);

            if (next > budget) {
                break;
            }

            const metadata = this.#guardedMetadata.get(entry);

            if (!metadata) {
                this.#quarantineGuarded();
                return { status: 'uncertain' };
            }

            bytes = next;
            parts[count] = entry.json;
            slots[count] = { entry, json: entry.json, bytes: entry.bytes, metadata };
            count++;
        }

        const token = Object.freeze(Object.create(null)) as object;
        const selection: GuardedSelection = Object.freeze({
            status: 'reserved',
            token,
            count,
            bytes,
            eventsJson: `[${parts.join(',')}]`,
        });
        this.#guardedActive = { selection, slots, count };
        return selection;
    }

    private finish(waiter: Waiter, result: GuardedPollResult): void {
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

    // Count only synchronous guarded operation/callback stacks. A returned
    // pending Promise does not itself hold a scope open.
    #runGuarded<T>(operation: () => T): T {
        this.#guardedResourceScopes++;

        try {
            return operation();
        } catch (error) {
            this.#quarantineGuarded();
            throw error;
        } finally {
            this.#guardedResourceScopes--;

            if (
                this.#guardedClosed &&
                this.#guardedResourceScopes === 0 &&
                !this.#guardedUncertain
            ) {
                this.#guardedCleanup = 'closed';
            }
        }
    }

    #quarantineGuarded(): void {
        this.#guardedUncertain = true;
        this.#guardedCleanup = 'uncertain';

        if (!this.#guardedClosed && !this.#guardedBarrier) {
            this.#guardedBarrier = Object.freeze({});
        }
    }

    #hasGuardedWaiter(waiter: GuardedWaiter): boolean {
        for (let i = 0; i < this.#guardedWaiters.length; i++) {
            if (this.#guardedWaiters[i] === waiter) {
                return true;
            }
        }

        return false;
    }

    #finishGuarded(waiter: GuardedWaiter, result: GuardedPollResult): boolean {
        let index = -1;

        for (let i = 0; i < this.#guardedWaiters.length; i++) {
            if (this.#guardedWaiters[i] === waiter) {
                index = i;
                break;
            }
        }

        if (index < 0) {
            return false;
        }

        // Detach without replaceable instance-array methods before resolving the
        // selected token or calling timer/listener cleanup, which can reenter.
        for (let i = index + 1; i < this.#guardedWaiters.length; i++) {
            this.#guardedWaiters[i - 1] = this.#guardedWaiters[i];
        }

        this.#guardedWaiters.length--;
        const timer = waiter.timer;
        const listener = waiter.listener;
        waiter.timer = undefined;
        waiter.timerGeneration = undefined;
        waiter.listener = undefined;
        waiter.resolve(result);
        let failed = false;

        try {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
        } catch {
            failed = true;
        }

        try {
            listener?.[Symbol.dispose]();
        } catch {
            failed = true;
        }

        if (failed) {
            this.#quarantineGuarded();
            throw new Error('guarded waiter cleanup uncertain');
        }

        return true;
    }

    #failGuardedWaiter(waiter: GuardedWaiter): void {
        this.#quarantineGuarded();

        try {
            this.#finishGuarded(waiter, { status: 'uncertain' });
        } catch {
            // The promise was already settled; cleanup uncertainty is retained.
            this.#quarantineGuarded();
        }
    }

    #scheduleGuarded(waiter: GuardedWaiter, delay: number): void {
        if (this.#guardedClosed || !this.#hasGuardedWaiter(waiter)) {
            return;
        }

        const generation = {};
        waiter.timerGeneration = generation;
        const timer = setTimeout(
            () => this.#runGuarded(() => this.#expireGuarded(waiter, generation)),
            delay,
        );

        // A clock/timer fixture may have closed or settled the waiter before
        // setTimeout returns. Never install its now-orphaned timer.
        if (
            this.#guardedClosed ||
            !this.#hasGuardedWaiter(waiter) ||
            waiter.timerGeneration !== generation
        ) {
            clearTimeout(timer);
            return;
        }

        waiter.timer = timer;
    }

    #expireGuarded(waiter: GuardedWaiter, generation: object): void {
        if (waiter.timerGeneration !== generation || !this.#hasGuardedWaiter(waiter)) {
            return;
        }

        waiter.timerGeneration = undefined;
        waiter.timer = undefined;

        try {
            const now = performance.now();

            if (!this.#hasGuardedWaiter(waiter)) {
                return;
            }

            const remaining = waiter.deadline - now;

            if (remaining > 0) {
                this.#scheduleGuarded(waiter, Math.ceil(remaining));
            } else {
                this.#finishGuarded(waiter, { status: 'timeout' });
                this.#requestGuardedDrain();
            }
        } catch {
            this.#failGuardedWaiter(waiter);
        }
    }

    #abortGuarded(waiter: GuardedWaiter): void {
        if (!this.#hasGuardedWaiter(waiter)) {
            return;
        }

        try {
            const now = performance.now();

            if (!this.#hasGuardedWaiter(waiter)) {
                return;
            }

            this.#finishGuarded(waiter, {
                status: now >= waiter.deadline ? 'timeout' : 'aborted',
            });
            this.#requestGuardedDrain();
        } catch {
            this.#failGuardedWaiter(waiter);
        }
    }

    #requestGuardedDrain(): void {
        if (this.#guardedDraining) {
            return;
        }

        this.#guardedDraining = true;

        try {
            this.#drainGuarded();
        } catch (error) {
            this.#quarantineGuarded();
            throw error;
        } finally {
            this.#guardedDraining = false;
        }
    }

    #drainGuarded(allowedBarrier?: object): void {
        while (!this.#guardedClosed && !this.#guardedActive && this.#guardedWaiters.length) {
            const waiter = this.#guardedWaiters[0];
            let selected: GuardedPollResult | undefined;

            try {
                const now = performance.now();

                if (
                    this.#guardedClosed ||
                    this.#guardedActive ||
                    this.#guardedWaiters[0] !== waiter
                ) {
                    continue;
                }

                if (now >= waiter.deadline) {
                    this.#finishGuarded(waiter, { status: 'timeout' });
                } else if (waiter.signal && signalAborted.call(waiter.signal)) {
                    this.#finishGuarded(waiter, { status: 'aborted' });
                } else if (
                    this.#guardedUncertain ||
                    !this.#guardedScopeActive() ||
                    (this.#guardedBarrier && this.#guardedBarrier !== allowedBarrier)
                ) {
                    break;
                } else if (this.#guardedQueue.length) {
                    selected = this.#selectGuarded(waiter.limit, waiter.budget);

                    if (!this.#finishGuarded(waiter, selected)) {
                        this.#quarantineGuarded();
                    }
                } else {
                    break;
                }
            } catch (error) {
                this.#quarantineGuarded();

                if (this.#hasGuardedWaiter(waiter)) {
                    try {
                        this.#finishGuarded(waiter, selected ?? { status: 'uncertain' });
                    } catch {
                        this.#quarantineGuarded();
                    }
                }

                throw error;
            }
        }
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

    /** Verify only queue-owned identities and immutable snapshots, never a DTO. */
    #guardedPrefixCurrent(active: GuardedActive): boolean {
        if (
            active.count < 1 ||
            active.slots.length !== active.count ||
            this.#guardedQueue.length < active.count
        ) {
            return false;
        }

        let json = '[';
        let bytes = 2;

        for (let i = 0; i < active.count; i++) {
            const slot = active.slots[i];
            const entry = this.#guardedQueue[i];

            if (
                !slot ||
                entry !== slot.entry ||
                entry.json !== slot.json ||
                entry.bytes !== slot.bytes ||
                this.#guardedMetadata.get(entry) !== slot.metadata ||
                (slot.metadata.kind !== 'ordinary' && slot.metadata.kind !== 'recall')
            ) {
                return false;
            }

            json += (i ? ',' : '') + slot.json;
            bytes += slot.bytes + (i ? 1 : 0);
        }

        json += ']';
        const selection = active.selection;
        return selection.status === 'reserved'
            ? selection.count === active.count &&
                  selection.bytes === bytes &&
                  selection.eventsJson === json
            : active.count === 1 &&
                  active.slots[0].metadata.kind === 'recall' &&
                  selection.requiredBytes === bytes;
    }

    /**
     * These receipts describe only this queue's local effect. In scoped mode a
     * retired scope retains the token and prefix; a current proof with unexpected
     * ticket/account/epoch mismatch quarantines the whole batch without pruning.
     * The owner must separately verify live binding, source, manager and gate
     * currency after all callbacks, before calling this API. Unscoped guarded mode
     * also requires the owner to verify BoundTo and sameSourceEpoch separately.
     */
    commitGuardedNoDrain(token: object, expectedSelection: unknown): GuardedCommitResult {
        return this.#runGuarded(
            () => this.#settleGuarded(token, expectedSelection, 'reserved') as GuardedCommitResult,
        );
    }

    settleBlockedGuardedNoDrain(token: object, expectedSelection: unknown): GuardedBlockedResult {
        return this.#runGuarded(
            () =>
                this.#settleGuarded(
                    token,
                    expectedSelection,
                    'blocked_guarded',
                ) as GuardedBlockedResult,
        );
    }

    #settleGuarded(
        token: object,
        expectedSelection: unknown,
        kind: 'reserved' | 'blocked_guarded',
    ): GuardedCommitResult | GuardedBlockedResult {
        const active = this.#guardedActive;

        // Compare the returned object by reference before reading anything from it.
        if (
            this.#mode !== 'guarded-recall' ||
            !active ||
            active.selection.token !== token ||
            active.selection !== expectedSelection ||
            active.selection.status !== kind
        ) {
            return { status: 'stale' };
        }

        if (this.#guardedUncertain) {
            return { status: 'uncertain' };
        }

        const oldQueue = this.#guardedQueue;
        let nextQueue: Entry[];
        let nextBytes: number;
        let removed: boolean[];
        let receipt: GuardedCommitResult | GuardedBlockedResult;

        try {
            if (!this.#guardedPrefixCurrent(active)) {
                this.#quarantineGuarded();
                return { status: 'uncertain' };
            }

            if (!this.#guardedScopeActive()) {
                return { status: 'scope_revoked' };
            }

            removed = new Array<boolean>(active.count);
            let badCount = 0;
            let badBytes = 0;
            let scopeMismatch = false;

            // Every verifier is a fixed module function, not a caller callback.
            // Once this scan starts, only local data and trusted built-ins are
            // used until the queue replacement and barrier are published.
            for (let i = 0; i < active.count; i++) {
                const slot = active.slots[i];
                const metadata = slot.metadata;
                const bad =
                    metadata.kind === 'recall' && !isPrivateRecallPollProofCurrent(metadata.proof);
                removed[i] = bad;

                if (bad) {
                    badCount++;
                    badBytes += slot.bytes;
                } else if (
                    this.#guardedScoped &&
                    metadata.kind === 'recall' &&
                    !isPrivateRecallPollProofInEpochAccountScope(
                        metadata.proof,
                        metadata.eventTicket,
                        this.#guardedScope,
                    )
                ) {
                    scopeMismatch = true;
                }
            }

            if (!this.#guardedScopeActive()) {
                return { status: 'scope_revoked' };
            }

            if (scopeMismatch) {
                this.#quarantineGuarded();
                return { status: 'uncertain' };
            }

            const removeAll = kind === 'reserved' && badCount === 0;
            const removeCount = removeAll ? active.count : badCount;
            let removedBytes = badBytes;

            if (removeAll) {
                removedBytes = 0;

                for (let i = 0; i < active.count; i++) {
                    removed[i] = true;
                    removedBytes += active.slots[i].bytes;
                }
            }

            nextQueue =
                removeCount === 0 ? oldQueue : new Array<Entry>(oldQueue.length - removeCount);

            if (removeCount) {
                let destination = 0;

                for (let i = 0; i < oldQueue.length; i++) {
                    if (i >= active.count || !removed[i]) {
                        nextQueue[destination++] = oldQueue[i];
                    }
                }
            }

            nextBytes = this.#guardedBytes - removedBytes;
            receipt = badCount
                ? Object.freeze({ status: 'pruned', count: badCount })
                : kind === 'blocked_guarded'
                  ? Object.freeze({ status: 'blocked', requiredBytes: active.slots[0].bytes + 2 })
                  : Object.freeze({ status: 'committed' });
        } catch {
            this.#quarantineGuarded();
            return { status: 'uncertain' };
        }

        this.#guardedQueue = nextQueue;
        this.#guardedBytes = nextBytes;
        this.#guardedActive = null;
        this.#guardedBarrier = receipt;

        for (let i = 0; i < active.count; i++) {
            if (removed[i]) {
                this.#guardedMetadata.delete(active.slots[i].entry);
            }
        }

        return receipt;
    }

    /** Cancellation, epoch retirement and deadlines release without pruning. */
    releaseGuardedNoDrain(token: object): GuardedReleaseResult {
        return this.#runGuarded(() => this.#releaseGuardedNoDrain(token));
    }

    #releaseGuardedNoDrain(token: object): GuardedReleaseResult {
        const active = this.#guardedActive;

        if (this.#mode !== 'guarded-recall' || !active || active.selection.token !== token) {
            return { status: 'stale' };
        }

        if (this.#guardedUncertain) {
            return { status: 'uncertain' };
        }

        try {
            if (!this.#guardedPrefixCurrent(active)) {
                this.#quarantineGuarded();
                return { status: 'uncertain' };
            }

            const receipt = Object.freeze({ status: 'released' as const });
            this.#guardedActive = null;
            this.#guardedBarrier = receipt;
            return receipt;
        } catch {
            this.#quarantineGuarded();
            return { status: 'uncertain' };
        }
    }

    /**
     * Only the exact, recorded no-drain receipt may resume its barrier. An old
     * or replaced receipt is stale and does not drain. A drain failure is
     * uncertain and quarantines the queue; it does not undo an earlier known
     * committed/pruned/released receipt or permit retrying that prior effect.
     * If close occurs during drain, cleanup uncertainty takes precedence over
     * the stale result used for a cleanly closed queue.
     * Scope retirement retains the barrier and any already selected token; the
     * owner must release that token as appropriate and close the retired queue.
     */
    resumeGuardedDrain(receipt: unknown): GuardedDrainResult {
        return this.#runGuarded(() => this.#resumeGuardedDrain(receipt));
    }

    #resumeGuardedDrain(receipt: unknown): GuardedDrainResult {
        const barrier = this.#guardedBarrier;

        if (this.#mode !== 'guarded-recall' || !barrier || barrier !== receipt) {
            return { status: 'stale' };
        }

        if (this.#guardedUncertain) {
            return { status: 'uncertain' };
        }

        if (!this.#guardedScopeActive()) {
            return { status: 'scope_revoked' };
        }

        if (this.#guardedResuming || this.#guardedDraining) {
            return { status: 'uncertain' };
        }

        this.#guardedResuming = true;
        this.#guardedDraining = true;

        try {
            // The same barrier remains visible to every reentrant short poll.
            this.#drainGuarded(barrier);

            if (this.#guardedUncertain) {
                return { status: 'uncertain' };
            }

            if (this.#guardedClosed) {
                return { status: 'stale' };
            }

            if (this.#guardedBarrier !== barrier) {
                this.#quarantineGuarded();
                return { status: 'uncertain' };
            }

            if (!this.#guardedScopeActive()) {
                return { status: 'scope_revoked' };
            }

            this.#guardedBarrier = null;
            return { status: 'resumed' };
        } catch {
            if (!this.#guardedClosed) {
                this.#quarantineGuarded();
            }

            return { status: 'uncertain' };
        } finally {
            this.#guardedDraining = false;
            this.#guardedResuming = false;
        }
    }

    commit(token: object): boolean {
        if (this.#mode !== 'legacy' || !this.active || this.active.token !== token) {
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
        if (this.#mode !== 'legacy' || !this.active || this.active.token !== token) {
            return false;
        }

        this.active = null;
        this.drain();
        return true;
    }

    /** Discards all entries, revokes the active token, resolves all waiters.
     * In guarded mode the boolean reports the close request, not cleanup certainty.
     */
    close(): boolean {
        if (this.#mode === 'guarded-recall') {
            return this.#runGuarded(() => this.#closeGuarded());
        }

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

    #closeGuarded(): boolean {
        if (this.#guardedClosed) {
            return false;
        }

        this.#guardedClosed = true;
        this.#guardedCleanup = 'closing';
        const oldQueue = this.#guardedQueue;
        this.#guardedActive = null;
        this.#guardedQueue = [];
        this.#guardedBytes = 0;
        this.#guardedBarrier = null;
        this.#guardedScope = undefined;
        let failed = false;

        for (let i = 0; i < oldQueue.length; i++) {
            try {
                this.#guardedMetadata.delete(oldQueue[i]);
            } catch {
                failed = true;
            }
        }

        while (this.#guardedWaiters.length) {
            const waiter = this.#guardedWaiters[0];

            try {
                this.#finishGuarded(waiter, { status: 'closed' });
            } catch {
                failed = true;
            }
        }

        if (failed || this.#guardedUncertain) {
            this.#quarantineGuarded();

            if (failed) {
                throw new Error('guarded poll buffer cleanup uncertain');
            }
        }

        return true;
    }
}
