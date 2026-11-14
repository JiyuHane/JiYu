import { isProxy } from 'node:util/types';
import { isObject, parseAccountId, parseMessageId } from '../v12/validation';
import { EventPollBuffer } from './event-poll-buffer';
import {
    PollCoordinator,
    type PollOutcome,
    type PollRequest,
    type PollSink,
} from './poll-transaction';
import { sameSourceEpoch, sourceHasBinding, type V12Source } from './source-generation';
import {
    IngressSequencer,
    type IngressFailure,
    type IngressParent,
    type IngressChild,
} from './ingress-sequencer';

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

type OrderedSelf = Readonly<{ platform: 'qq'; user_id: string }>;

/** Read only ordinary data properties from a trusted host, without invoking getters. */
function orderedSelf(host: Host): OrderedSelf | null {
    try {
        if (isProxy(host)) {
            return null;
        }

        const property = Object.getOwnPropertyDescriptor(host, 'self');

        if (!property || !('value' in property)) {
            return null;
        }

        const value: unknown = property.value;

        if (!isObject(value) || isProxy(value)) {
            return null;
        }

        const proto = Object.getPrototypeOf(value);

        if (proto !== Object.prototype && proto !== null) {
            return null;
        }

        const keys = Reflect.ownKeys(value);

        if (keys.length !== 2 || !keys.includes('platform') || !keys.includes('user_id')) {
            return null;
        }

        const platform = Object.getOwnPropertyDescriptor(value, 'platform');
        const user = Object.getOwnPropertyDescriptor(value, 'user_id');

        if (
            !platform ||
            !('value' in platform) ||
            !platform.enumerable ||
            platform.value !== 'qq' ||
            !user ||
            !('value' in user) ||
            !user.enumerable ||
            parseAccountId(user.value) === null
        ) {
            return null;
        }

        return Object.freeze({ platform: 'qq', user_id: user.value as string });
    } catch {
        return null;
    }
}

/** Structural shapes of supported converter event types; new fields or types require review. */
function validOrderedEvent(event: unknown, self: OrderedSelf): boolean {
    const exact = (value: Record<string, unknown>, fields: readonly string[]): boolean => {
        const keys = Object.keys(value);
        return keys.length === fields.length && keys.every((key) => fields.includes(key));
    };

    if (
        !isObject(event) ||
        typeof event.id !== 'string' ||
        !event.id ||
        typeof event.time !== 'number' ||
        !Number.isFinite(event.time) ||
        event.time < 0 ||
        !isObject(event.self) ||
        !exact(event.self, ['platform', 'user_id']) ||
        event.self.platform !== self.platform ||
        event.self.user_id !== self.user_id
    ) {
        return false;
    }

    const common = ['id', 'time', 'type', 'detail_type', 'sub_type', 'self'];

    if (event.type === 'message') {
        if (
            (event.detail_type !== 'private' && event.detail_type !== 'group') ||
            event.sub_type !== '' ||
            parseMessageId(event.message_id) === null ||
            parseAccountId(event.user_id) === null ||
            typeof event.alt_message !== 'string' ||
            !Array.isArray(event.message)
        ) {
            return false;
        }

        const fields = [...common, 'message_id', 'message', 'alt_message', 'user_id'];

        if (event.detail_type === 'group') {
            if (parseAccountId(event.group_id) === null) {
                return false;
            }

            fields.push('group_id');
        }

        if (!exact(event, fields)) {
            return false;
        }

        return event.message.every((segment: unknown) => {
            if (
                !isObject(segment) ||
                !exact(segment, ['type', 'data']) ||
                !isObject(segment.data)
            ) {
                return false;
            }

            if (segment.type === 'text') {
                return exact(segment.data, ['text']) && typeof segment.data.text === 'string';
            }

            if (segment.type === 'mention') {
                return (
                    exact(segment.data, ['user_id']) &&
                    parseAccountId(segment.data.user_id) !== null
                );
            }

            return segment.type === 'mention_all' && exact(segment.data, []);
        });
    }

    if (
        event.type !== 'notice' ||
        parseAccountId(event.group_id) === null ||
        parseAccountId(event.user_id) === null ||
        parseAccountId(event.operator_id) === null
    ) {
        return false;
    }

    const fields = [...common, 'group_id', 'user_id', 'operator_id'];

    if (event.detail_type === 'group_message_delete') {
        fields.push('message_id');
        return (
            (event.sub_type === '' || event.sub_type === 'recall') &&
            parseMessageId(event.message_id) !== null &&
            exact(event, fields)
        );
    }

    return (
        (event.detail_type === 'group_member_decrease' ||
            event.detail_type === 'group_member_increase') &&
        event.sub_type === '' &&
        exact(event, fields)
    );
}

type PollGapReason = IngressFailure | 'committed_unsent' | 'delivery_unknown';
type Counter =
    'accepted' | 'full' | 'invalid' | 'too_large' | 'closing_discard' | 'postcommit_unknown';
type Counters = Record<Counter, number>;
type Host = {
    /** Trusted account identity supplied by the instance, never by an action. */
    self?: unknown;
    captureBinding(): object | null;
    captureSource(): V12Source | undefined;
    verify(source: V12Source | undefined): boolean;
};
export interface PollGate {
    claim: object | null;
    uncertain: boolean;
}

type GateState = {
    gap: { source: V12Source; reason: PollGapReason } | null;
    history: V12Source[];
    historyOverflow: boolean;
    transition: object;
};
const gateStates = new WeakMap<PollGate, GateState>();

function gateState(gate: PollGate): GateState {
    let state = gateStates.get(gate);

    if (!state) {
        state = { gap: null, history: [], historyOverflow: false, transition: {} };
        gateStates.set(gate, state);
    }

    return state;
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
    | { status: 'ready'; owner: PollOwner }
    | { status: 'unavailable' | 'cleanup_pending' | 'degraded' };

/** Trusted in-process seam only; it is not connected to pipeline or HTTP. */
export interface OrderedPollOwner {
    start(request: PollRequest, sink: PollSink): { result: Promise<PollOutcome>; cancel(): void };
    begin(source: V12Source | undefined): IngressParent | null;
    invalidate(): void;
}
export type OrderedPollActivation =
    | { status: 'ready'; owner: OrderedPollOwner }
    | { status: 'unavailable' | 'cleanup_pending' | 'degraded' };

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
    const result = activate(runtime, false);
    return result.status === 'ready' ? { status: 'ready', owner: result.owner.facade } : result;
}

/** Explicit in-process prototype; empty polls do not produce an HTTP response. */
export function activateOrderedPollOwner(runtime: object): OrderedPollActivation {
    const result = activate(runtime, true);
    return result.status === 'ready'
        ? { status: 'ready', owner: result.owner.orderedFacade }
        : result;
}

function activate(
    runtime: object,
    ordered: boolean,
): { status: 'ready'; owner: Owner } | { status: 'unavailable' | 'cleanup_pending' | 'degraded' } {
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
        if (current.ordered !== ordered) {
            return { status: 'unavailable' };
        }

        if (current.valid()) {
            return { status: 'ready', owner: current };
        }

        if (current.ordered) {
            current.failUnsequenced();
        } else {
            current.invalidate();
        }

        return { status: slot.retiring ? 'cleanup_pending' : 'unavailable' };
    }

    if (slot.gate.claim) {
        return { status: 'cleanup_pending' };
    }

    slot.activating = true;
    const revision = slot.revision;
    const claim = {};
    slot.gate.claim = claim;
    const state = gateState(slot.gate);
    const transition = state.transition;
    const stable = () =>
        !slot.retiring &&
        !slot.owner &&
        !slot.gate.uncertain &&
        slot.gate.claim === claim &&
        slot.revision === revision &&
        state.transition === transition;
    let attached = false;

    try {
        const binding = slot.host.captureBinding();

        if (!binding || !stable()) {
            return { status: 'unavailable' };
        }

        const source = slot.host.captureSource();

        if (!source || !stable()) {
            return { status: 'unavailable' };
        }

        const bindingCheck = slot.host.captureBinding();

        if (bindingCheck !== binding || !stable()) {
            return { status: 'unavailable' };
        }

        const verified = slot.host.verify(source);

        if (!verified || !stable()) {
            return { status: 'unavailable' };
        }

        const finalBinding = slot.host.captureBinding();

        if (finalBinding !== binding || !stable()) {
            return { status: 'unavailable' };
        }

        const gap = state.gap;
        const self = ordered ? orderedSelf(slot.host) : null;

        if (ordered && !self) {
            return { status: 'unavailable' };
        }

        if (
            (ordered || gap) &&
            (sameSourceEpoch(source, source) !== 'same' || !sourceHasBinding(source, binding))
        ) {
            return { status: 'unavailable' };
        }

        if (gap) {
            const relation = sameSourceEpoch(gap.source, source);

            if (relation === 'invalid') {
                return { status: 'unavailable' };
            }

            if (relation === 'same') {
                return { status: 'degraded' };
            }
        }

        if (
            slot.gate.claim !== claim ||
            slot.revision !== revision ||
            state.transition !== transition ||
            state.gap !== gap ||
            slot.retiring ||
            slot.owner ||
            slot.gate.uncertain
        ) {
            return { status: 'unavailable' };
        }

        const owner = new Owner(slot, binding, source, claim, ordered, self);
        slot.owner = owner;
        attached = true;

        if (gap) {
            state.gap = null;
        }

        return { status: 'ready', owner };
    } catch {
        return { status: 'unavailable' };
    } finally {
        slot.activating = false;

        if (!attached && !slot.gate.uncertain && slot.gate.claim === claim) {
            slot.gate.claim = null;
        }
    }
}

export function pollOwnerStats(runtime: object): Readonly<
    Counters & {
        active: boolean;
        cleanup_pending: boolean;
        cleanup_uncertain: boolean;
        ordering_gap: boolean;
        ordering_reason: PollGapReason | null;
        history_overflow: boolean;
    }
> | null {
    const slot = slots.get(runtime);
    slot?.owner?.touchOrdered();
    return slot
        ? {
              ...slot.counters,
              active: slot.owner !== null,
              cleanup_pending:
                  slot.retiring ||
                  slot.gate.uncertain ||
                  (slot.gate.claim !== null && !slot.owner?.ownsGate()),
              cleanup_uncertain: slot.cleanupUncertain || slot.gate.uncertain,
              ordering_gap: gateState(slot.gate).gap !== null,
              ordering_reason: gateState(slot.gate).gap?.reason ?? null,
              history_overflow: gateState(slot.gate).historyOverflow,
          }
        : null;
}

/** Synchronous revocation. Cleanup is asynchronous while selected reservations settle. */
export function invalidatePollOwner(runtime: object): void {
    const slot = slots.get(runtime);

    if (slot) {
        gateState(slot.gate).transition = {};
        slot.revision = {};
        slot.owner?.invalidate();
    }
}

export function invalidateStalePollOwner(runtime: object): void {
    const slot = slots.get(runtime);

    if (slot) {
        gateState(slot.gate).transition = {};
    }

    const owner = slot?.owner;

    if (owner && !owner.valid()) {
        if (owner.ordered) {
            owner.failUnsequenced();
        } else {
            owner.invalidate();
        }
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

    if (!slot || !owner) {
        return;
    }

    if (owner.ordered) {
        // The old completion-order path has no admission handle.
        owner.failUnsequenced();
        return;
    }

    if (!source || !owner.valid()) {
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

/** Per-instance gate only: it does not coordinate replacement instances after forceRelease. */
class Owner implements PollOwner {
    private readonly queue = new EventPollBuffer(limits);
    private readonly sequencer: IngressSequencer | null;
    private readonly ownerRevision: object;
    private readonly coordinator: PollCoordinator;
    private readonly running = new Set<Promise<unknown>>();
    private retired = false;
    private invalidating = false;
    private checking = false;
    readonly facade: PollOwner = Object.freeze({
        start: (request: PollRequest, sink: PollSink) => this.start(request, sink),
        invalidate: () => this.invalidate(),
    });
    readonly orderedFacade: OrderedPollOwner = Object.freeze({
        start: (request: PollRequest, sink: PollSink) => this.start(request, sink),
        begin: (source: V12Source | undefined) => this.begin(source),
        invalidate: () => this.invalidate(),
    });

    constructor(
        private readonly slot: Slot,
        private readonly binding: object,
        private readonly source: V12Source,
        private readonly claim: object,
        readonly ordered: boolean,
        private readonly self: OrderedSelf | null,
    ) {
        this.ownerRevision = slot.revision;
        this.sequencer = ordered
            ? new IngressSequencer(
                  {
                      maxParents: 128,
                      maxChildren: 256,
                      maxChildrenPerParent: 32,
                      maxBytes: 256 * 1024,
                      maxEventBytes: limits.maxEventBytes - 2,
                      deadlineMs: 1000,
                      maxFlushWork: 32,
                  },
                  {
                      now: () => performance.now(),
                      scheduler: {
                          timer: (callback, ms) => setTimeout(callback, ms),
                          clearTimer: (handle) =>
                              clearTimeout(handle as ReturnType<typeof setTimeout>),
                          immediate: (callback) => setImmediate(callback),
                          clearImmediate: (handle) =>
                              clearImmediate(handle as ReturnType<typeof setImmediate>),
                      },
                      deliver: (json) => {
                          if (!this.valid()) {
                              throw new Error('ordered owner invalid');
                          }

                          const event: unknown = JSON.parse(json);

                          if (!this.self || !validOrderedEvent(event, this.self) || !this.valid()) {
                              increment(this.slot, 'invalid');
                              throw new Error('ordered event invalid');
                          }

                          const result = this.queue.enqueue(event);

                          if (result === 'accepted') {
                              increment(this.slot, 'accepted');
                              return 'accepted';
                          }

                          if (result === 'full') {
                              increment(this.slot, 'full');
                              return 'full';
                          }

                          increment(this.slot, result === 'oversize' ? 'too_large' : 'invalid');
                          throw new Error('ordered queue admission failed');
                      },
                      onDegrade: (reason) => this.onGap(reason),
                  },
              )
            : null;
        this.coordinator = new PollCoordinator(
            this.queue,
            limits.maxQueueBytes,
            () => performance.now(),
            () => this.valid(),
            ordered ? 'unavailable' : 'legacy',
        );
    }

    private attached(): boolean {
        return (
            !this.retired &&
            !this.invalidating &&
            !this.slot.gate.uncertain &&
            this.slot.gate.claim === this.claim &&
            this.slot.owner === this &&
            this.slot.revision === this.ownerRevision
        );
    }

    private onGap(reason: IngressFailure): void {
        if (this.retired || this.slot.owner !== this || !this.ownsGate()) {
            return;
        }

        const state = gateState(this.slot.gate);

        if (state.gap === null) {
            state.gap = { source: this.source, reason };
        } else if (sameSourceEpoch(state.gap.source, this.source) !== 'same') {
            this.markUncertain();
        }

        if (!this.invalidating) {
            this.invalidate();
        }
    }

    /** May run after invalidate detached this owner, before its tracked transaction settles. */
    private recordDeliveryGap(reason: 'committed_unsent' | 'delivery_unknown'): void {
        if (!this.ownsGate() || (this.slot.owner !== null && this.slot.owner !== this)) {
            this.markUncertain();

            if (this.slot.owner === this && !this.retired) {
                this.invalidate();
            }

            return;
        }

        const state = gateState(this.slot.gate);
        const gap = state.gap;

        if (gap !== null && sameSourceEpoch(gap.source, this.source) !== 'same') {
            this.markUncertain();

            if (this.slot.owner === this && !this.retired) {
                this.invalidate();
            }

            return;
        }

        if (
            !this.ownsGate() ||
            (this.slot.owner !== null && this.slot.owner !== this) ||
            state.gap !== gap
        ) {
            this.markUncertain();

            if (this.slot.owner === this && !this.retired) {
                this.invalidate();
            }

            return;
        }

        if (gap === null) {
            state.gap = { source: this.source, reason };
        }

        if (this.slot.owner === this && !this.retired) {
            this.invalidate();
        }
    }

    failUnsequenced(): void {
        this.onGap('child_failed');
    }

    private verifyInput(source: V12Source): boolean {
        if (!this.attached()) {
            return false;
        }

        try {
            if (
                !this.slot.host.verify(source) ||
                !this.attached() ||
                !this.valid() ||
                !this.attached()
            ) {
                this.onGap('child_failed');
                return false;
            }

            return true;
        } catch {
            this.onGap('child_failed');
            return false;
        }
    }

    private failParent(parent: IngressParent): void {
        if (!this.attached()) {
            return;
        }

        const child = parent.child();

        if (child) {
            child.fail();
        } else {
            this.onGap('child_failed');
        }
    }

    private begin(source: V12Source | undefined): IngressParent | null {
        if (!this.ordered || !this.sequencer || !this.attached()) {
            return null;
        }

        // Linearize admission before any host-provided verification callback.
        const parent = this.sequencer.admit();

        if (!parent || !this.attached()) {
            return null;
        }

        const relation = sameSourceEpoch(this.source, source);

        if (relation === 'invalid') {
            this.failParent(parent);
            return null;
        }

        if (relation === 'different') {
            const state = gateState(this.slot.gate);
            const knownOld =
                !state.historyOverflow &&
                state.history.some((entry) => sameSourceEpoch(entry, source) === 'same');

            if (!knownOld || !this.verifyInput(this.source)) {
                this.failParent(parent);
                return null;
            }

            parent.seal();
            return null;
        }

        if (!source || !this.verifyInput(source)) {
            this.failParent(parent);
            return null;
        }

        let open = true;
        return Object.freeze({
            child: () => {
                if (!open || !this.attached()) {
                    return null;
                }

                const child = parent.child();

                if (!child || !this.attached()) {
                    return null;
                }

                if (!this.verifyInput(source)) {
                    if (this.attached()) {
                        child.fail();
                    }

                    return null;
                }

                return this.wrapChild(child, source);
            },
            seal: () => {
                if (!open || !this.attached()) {
                    return false;
                }

                open = false;

                if (!this.verifyInput(source)) {
                    this.failParent(parent);
                    return false;
                }

                return parent.seal();
            },
        });
    }

    private wrapChild(child: IngressChild, source: V12Source): IngressChild {
        let state: 'pending' | 'settling' | 'terminal' = 'pending';

        const terminal = (kind: 'resolve' | 'skip' | 'fail', event?: unknown): boolean => {
            if (!this.attached()) {
                return false;
            }

            if (state !== 'pending') {
                if (kind === 'resolve') {
                    if (state === 'settling') {
                        this.onGap('late_candidate');
                    } else {
                        child.resolve(event);
                    }
                }

                return false;
            }

            state = 'settling';

            if (!this.verifyInput(source)) {
                if (this.attached()) {
                    child.fail();
                }

                state = 'terminal';
                return false;
            }

            const result =
                kind === 'resolve'
                    ? child.resolve(event)
                    : kind === 'skip'
                      ? child.skip()
                      : child.fail();
            state = 'terminal';
            return result;
        };

        return Object.freeze({
            resolve: (event: unknown) => terminal('resolve', event),
            skip: () => terminal('skip'),
            fail: () => terminal('fail'),
        });
    }

    touchOrdered(): void {
        if (!this.sequencer) {
            return;
        }

        const status = this.sequencer.stats();

        if (status.cleanupUncertain || status.notificationFailed) {
            this.markUncertain();
        }
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
                (!this.ordered ||
                    (gateState(this.slot.gate).gap === null &&
                        this.sequencer?.stats().state === 'active')) &&
                this.slot.host.captureBinding() === this.binding &&
                this.slot.host.verify(this.source) &&
                !this.retired &&
                this.slot.owner === this &&
                this.slot.host.captureBinding() === this.binding &&
                !this.retired &&
                !this.slot.gate.uncertain &&
                this.ownsGate() &&
                this.slot.owner === this &&
                (!this.ordered ||
                    (gateState(this.slot.gate).gap === null &&
                        this.sequencer?.stats().state === 'active')) &&
                this.attached()
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
                    try {
                        const core =
                            outcome.kind === 'cleanup_uncertain' ? outcome.outcome : outcome;
                        const uncertain =
                            outcome.kind === 'cleanup_uncertain' ||
                            core.kind === 'release_unknown' ||
                            core.kind === 'commit_unknown';

                        if (uncertain) {
                            this.markUncertain();
                        }

                        // The tracked promise remains unresolved until this synchronous
                        // observer finishes, so retirement cannot release our claim first.
                        if (this.ordered && core.kind === 'committed_unsent') {
                            this.recordDeliveryGap('committed_unsent');
                        } else if (this.ordered && core.kind === 'unknown' && core.committed) {
                            this.recordDeliveryGap('delivery_unknown');
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
                    } catch {
                        this.markUncertain();
                    } finally {
                        this.running.delete(tracked);
                        finish();
                    }
                },
                () => {
                    try {
                        this.markUncertain();
                        increment(this.slot, 'postcommit_unknown');
                        this.invalidate();
                    } finally {
                        this.running.delete(tracked);
                        finish();
                    }
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
        if (this.retired || this.invalidating) {
            return;
        }

        this.invalidating = true;

        // Freeze admission first; expiry or abandoning pending work leaves a sticky gap.
        if (this.sequencer) {
            this.sequencer.stats();
            const lost = this.sequencer.retire();
            const status = this.sequencer.stats();

            if (lost > 0 || this.queue.stats().count > 0) {
                this.onGap('child_failed');
            }

            if (status.cleanupUncertain || status.notificationFailed) {
                this.markUncertain();
            }
        }

        this.retired = true;
        this.invalidating = false;

        if (this.slot.owner !== this) {
            return;
        }

        this.slot.owner = null;
        this.slot.retiring = true;
        this.slot.revision = {};
        const state = gateState(this.slot.gate);

        if (
            sameSourceEpoch(this.source, this.source) === 'same' &&
            sourceHasBinding(this.source, this.binding) &&
            !state.history.some((entry) => sameSourceEpoch(entry, this.source) === 'same')
        ) {
            if (state.history.length < 8) {
                state.history.push(this.source);
            } else {
                state.historyOverflow = true;
            }
        }

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
