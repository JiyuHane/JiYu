import { EventPollBuffer } from './event-poll-buffer';
import {
    PollCoordinator,
    type PollOutcome,
    type PollRequest,
    type PollSink,
} from './poll-transaction';
import type { V12Source } from './source-generation';

// Internal capability, not a package export or a same-process security boundary.
// A real transport must separately validate/authenticate requests and bound its sink.
const limits = {
    capacity: 128,
    maxQueueBytes: 256 * 1024,
    maxEventBytes: 64 * 1024,
    maxWaiters: 8,
    maxTimeoutMs: 10_000,
} as const;
const maxTransactions = 8;
const maxOutputBytes = 1024 * 1024;
const maxDeadlineMs = 15_000;

type Counter =
    'accepted' | 'full' | 'invalid' | 'too_large' | 'closing_discard' | 'postcommit_unknown';
type Counters = Record<Counter, number>;
type Host = {
    captureBinding(): object | null;
    captureSource(): V12Source | undefined;
    verify(source: V12Source | undefined): boolean;
};
export interface PollGate {
    claim: object | null;
    uncertain: boolean;
}

/** One private gate belongs to one instance, not an account ID. */
export function createPollGate(): PollGate {
    return { claim: null, uncertain: false };
}

type Slot = {
    host: Host;
    gate: PollGate;
    owner: Owner | null;
    retiring: boolean;
    activating: boolean;
    revision: object;
    cleanupUncertain: boolean;
    counters: Counters;
};
const slots = new WeakMap<object, Slot>();

export interface PollOwner {
    start(request: PollRequest, sink: PollSink): { result: Promise<PollOutcome>; cancel(): void };
    invalidate(): void;
}

export type PollActivation =
    { status: 'ready'; owner: PollOwner } | { status: 'unavailable' | 'cleanup_pending' };

function increment(slot: Slot, key: Counter, amount = 1): void {
    slot.counters[key] = Math.min(Number.MAX_SAFE_INTEGER, slot.counters[key] + amount);
}

export function registerPollHost(runtime: object, host: Host, gate = createPollGate()): void {
    if (slots.has(runtime)) {
        throw new Error('poll host already registered');
    }

    slots.set(runtime, {
        host,
        gate,
        owner: null,
        retiring: false,
        activating: false,
        revision: {},
        cleanupUncertain: false,
        counters: {
            accepted: 0,
            full: 0,
            invalid: 0,
            too_large: 0,
            closing_discard: 0,
            postcommit_unknown: 0,
        },
    });
}

/** Trusted-host-only explicit activation; there is no implicit production buffer. */
export function activatePollOwner(runtime: object): PollActivation {
    const slot = slots.get(runtime);

    if (!slot) {
        return { status: 'unavailable' };
    }

    if (slot.retiring || slot.gate.uncertain) {
        return { status: 'cleanup_pending' };
    }

    if (slot.activating) {
        return { status: 'unavailable' };
    }

    const current = slot.owner;

    if (current) {
        if (current.valid()) {
            return { status: 'ready', owner: current.facade };
        }

        current.invalidate();
        return { status: slot.retiring ? 'cleanup_pending' : 'unavailable' };
    }

    if (slot.gate.claim) {
        return { status: 'cleanup_pending' };
    }

    slot.activating = true;
    const revision = slot.revision;
    const claim = {};
    slot.gate.claim = claim;
    let attached = false;

    try {
        const binding = slot.host.captureBinding();
        const source = slot.host.captureSource();

        if (
            !binding ||
            !source ||
            slot.host.captureBinding() !== binding ||
            !slot.host.verify(source) ||
            slot.host.captureBinding() !== binding ||
            slot.retiring ||
            slot.owner ||
            slot.gate.uncertain ||
            slot.gate.claim !== claim ||
            slot.revision !== revision
        ) {
            return { status: 'unavailable' };
        }

        const owner = new Owner(slot, binding, source, claim);
        slot.owner = owner;
        attached = true;
        return { status: 'ready', owner: owner.facade };
    } catch {
        return { status: 'unavailable' };
    } finally {
        slot.activating = false;

        if (!attached && !slot.gate.uncertain && slot.gate.claim === claim) {
            slot.gate.claim = null;
        }
    }
}

export function pollOwnerStats(
    runtime: object,
): Readonly<
    Counters & { active: boolean; cleanup_pending: boolean; cleanup_uncertain: boolean }
> | null {
    const slot = slots.get(runtime);
    return slot
        ? {
              ...slot.counters,
              active: slot.owner !== null,
              cleanup_pending:
                  slot.retiring ||
                  slot.gate.uncertain ||
                  (slot.gate.claim !== null && !slot.owner?.ownsGate()),
              cleanup_uncertain: slot.cleanupUncertain || slot.gate.uncertain,
          }
        : null;
}

/** Synchronous revocation. Cleanup is asynchronous while selected reservations settle. */
export function invalidatePollOwner(runtime: object): void {
    const slot = slots.get(runtime);

    if (slot) {
        slot.revision = {};
        slot.owner?.invalidate();
    }
}

export function invalidateStalePollOwner(runtime: object): void {
    const owner = slots.get(runtime)?.owner;

    if (owner && !owner.valid()) {
        owner.invalidate();
    }
}

/** Called after conversion, before normal WS fanout; metadata stays out of payloads. */
export function enqueuePollEvent(
    runtime: object,
    event: unknown,
    source: V12Source | undefined,
): void {
    const slot = slots.get(runtime);
    const owner = slot?.owner;

    if (!slot || !owner || !source || !owner.valid()) {
        return;
    }

    try {
        if (!slot.host.verify(source) || !owner.valid()) {
            return;
        }

        const result = owner.enqueue(event);

        if (result === 'accepted') {
            increment(slot, 'accepted');
        } else if (result === 'full') {
            increment(slot, 'full');
        } else if (result === 'oversize') {
            increment(slot, 'too_large');
        } else if (result === 'invalid') {
            increment(slot, 'invalid');
        }
    } catch {
        increment(slot, 'invalid');
        owner.invalidate();
    }
}

class Owner implements PollOwner {
    private readonly queue = new EventPollBuffer(limits);
    private readonly coordinator: PollCoordinator;
    private readonly running = new Set<Promise<unknown>>();
    private retired = false;
    private checking = false;
    readonly facade: PollOwner = Object.freeze({
        start: (request: PollRequest, sink: PollSink) => this.start(request, sink),
        invalidate: () => this.invalidate(),
    });

    constructor(
        private readonly slot: Slot,
        private readonly binding: object,
        private readonly source: V12Source,
        private readonly claim: object,
    ) {
        this.coordinator = new PollCoordinator(
            this.queue,
            limits.maxQueueBytes,
            () => performance.now(),
            () => this.valid(),
        );
    }

    ownsGate(): boolean {
        return this.slot.gate.claim === this.claim;
    }

    valid(): boolean {
        if (this.checking) {
            return false;
        }

        this.checking = true;

        try {
            return (
                !this.retired &&
                !this.slot.gate.uncertain &&
                this.ownsGate() &&
                this.slot.owner === this &&
                this.slot.host.captureBinding() === this.binding &&
                this.slot.host.verify(this.source) &&
                !this.retired &&
                this.slot.owner === this &&
                this.slot.host.captureBinding() === this.binding &&
                !this.retired &&
                !this.slot.gate.uncertain &&
                this.ownsGate() &&
                this.slot.owner === this
            );
        } catch {
            return false;
        } finally {
            this.checking = false;
        }
    }

    enqueue(event: unknown) {
        return this.queue.enqueue(event);
    }

    start(request: PollRequest, sink: PollSink): { result: Promise<PollOutcome>; cancel(): void } {
        const failure = (kind: 'epoch_invalid' | 'busy' | 'invalid_input' | 'queue_error') => ({
            result: Promise.resolve({ kind } as PollOutcome),
            cancel() {},
        });

        if (!this.valid()) {
            this.invalidate();
            return failure('epoch_invalid');
        }

        if (this.running.size >= maxTransactions) {
            return failure('busy');
        }

        let finish!: () => void;
        const tracked = new Promise<void>((resolve) => {
            finish = resolve;
        });
        this.running.add(tracked);
        let started = false;
        let enteringRun = false;

        try {
            const snapshot: PollRequest = {
                limit: request.limit,
                timeoutMs: request.timeoutMs,
                maxOutputBytes: request.maxOutputBytes,
                responseDeadline: request.responseDeadline,
                echo: request.echo,
                externalAbortSignal: request.externalAbortSignal,
            };
            const now = performance.now();

            if (
                !Number.isSafeInteger(snapshot.limit) ||
                snapshot.limit < 0 ||
                !Number.isSafeInteger(snapshot.timeoutMs) ||
                snapshot.timeoutMs < 0 ||
                snapshot.timeoutMs > limits.maxTimeoutMs ||
                !Number.isSafeInteger(snapshot.maxOutputBytes) ||
                snapshot.maxOutputBytes < 0 ||
                snapshot.maxOutputBytes > maxOutputBytes ||
                !Number.isFinite(snapshot.responseDeadline) ||
                snapshot.responseDeadline <= now ||
                snapshot.responseDeadline > now + maxDeadlineMs ||
                (snapshot.echo !== undefined &&
                    (typeof snapshot.echo !== 'string' || snapshot.echo.length > 4096))
            ) {
                return failure('invalid_input');
            }

            if (!this.valid()) {
                this.invalidate();
                return failure('epoch_invalid');
            }

            const tx = this.coordinator.create(snapshot, sink);

            if (!this.valid()) {
                this.invalidate();
                return failure('epoch_invalid');
            }

            enteringRun = true;
            const result = tx.run();
            started = true;
            void result.then(
                (outcome) => {
                    const core = outcome.kind === 'cleanup_uncertain' ? outcome.outcome : outcome;
                    const uncertain =
                        outcome.kind === 'cleanup_uncertain' ||
                        core.kind === 'release_unknown' ||
                        core.kind === 'commit_unknown';

                    if (uncertain) {
                        this.markUncertain();
                    }

                    if (
                        core.kind === 'commit_unknown' ||
                        core.kind === 'committed_unsent' ||
                        (core.kind === 'unknown' && core.committed) ||
                        (outcome.kind === 'cleanup_uncertain' && outcome.committed !== false)
                    ) {
                        increment(this.slot, 'postcommit_unknown');
                    }

                    if (uncertain) {
                        this.invalidate();
                    }

                    this.running.delete(tracked);
                    finish();
                },
                () => {
                    this.markUncertain();
                    increment(this.slot, 'postcommit_unknown');
                    this.invalidate();
                    this.running.delete(tracked);
                    finish();
                },
            );
            return { result, cancel: () => tx.cancel() };
        } catch {
            if (enteringRun) {
                this.markUncertain();
                increment(this.slot, 'postcommit_unknown');
                this.invalidate();
                return failure('queue_error');
            }

            return failure('invalid_input');
        } finally {
            if (!started) {
                this.running.delete(tracked);
                finish();
            }
        }
    }

    private markUncertain(): void {
        this.slot.cleanupUncertain = true;
        this.slot.gate.uncertain = true;
    }

    invalidate(): void {
        if (this.retired) {
            return;
        }

        this.retired = true;

        if (this.slot.owner !== this) {
            return;
        }

        this.slot.owner = null;
        this.slot.retiring = true;
        this.slot.revision = {};

        try {
            this.coordinator.close();
            void Promise.allSettled([...this.running]).then(() => {
                try {
                    const count = this.queue.stats().count;
                    this.queue.close();
                    increment(this.slot, 'closing_discard', count);

                    if (!this.slot.gate.uncertain && this.ownsGate()) {
                        this.slot.gate.claim = null;
                        this.slot.retiring = false;
                    }
                } catch {
                    this.markUncertain();
                }
            });
        } catch {
            this.markUncertain();
        }
    }
}
