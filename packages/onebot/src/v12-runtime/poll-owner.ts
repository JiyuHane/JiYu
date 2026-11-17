import { isProxy } from 'node:util/types';
import { isObject, parseAccountId, parseMessageId } from '../v12/validation';
import { EventPollBuffer } from './event-poll-buffer';
import {
    PollCoordinator,
    type PollListenerGuard,
    type PollOutcome,
    type PollRequest,
    type PollSink,
    type ScopedPollStatus,
} from './poll-transaction';
import { sameSourceEpoch, sourceHasBinding, type V12Source } from './source-generation';
import {
    createPrivateRecallPollEpochAccountScope,
    isPrivateRecallPollEpochAccountScopeActive,
    isPrivateRecallPollProofBoundTo,
    isPrivateRecallPollProofFor,
    isPrivateRecallPollProofInEpochAccountScope,
    retirePrivateRecallPollEpochAccountScope,
    type PrivateRecallPollEpochAccountScope,
    type PrivateRecallPollProof,
} from './private-recall-source';
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
        } else if (Object.hasOwn(event, 'qq.target_id')) {
            if (
                Object.hasOwn(event, 'qq.auto_reply') ||
                parseAccountId(event['qq.target_id']) === null ||
                event.user_id !== self.user_id ||
                event.time > Number.MAX_SAFE_INTEGER
            ) {
                return false;
            }

            fields.push('qq.target_id');
        } else if (Object.hasOwn(event, 'qq.auto_reply')) {
            if (event['qq.auto_reply'] !== true) {
                return false;
            }

            fields.push('qq.auto_reply');
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

            if (segment.type === 'image') {
                return (
                    exact(segment.data, ['file_id']) &&
                    typeof segment.data.file_id === 'string' &&
                    segment.data.file_id.length > 0 &&
                    segment.data.file_id.length <= 4096
                );
            }

            if (segment.type === 'voice') {
                return (
                    exact(segment.data, ['file_id']) &&
                    typeof segment.data.file_id === 'string' &&
                    segment.data.file_id.length > 0 &&
                    segment.data.file_id.length <= 4096
                );
            }

            if (segment.type === 'video') {
                return (
                    exact(segment.data, ['file_id']) &&
                    typeof segment.data.file_id === 'string' &&
                    segment.data.file_id.length > 0 &&
                    segment.data.file_id.length <= 4096
                );
            }

            return segment.type === 'mention_all' && exact(segment.data, []);
        });
    }

    if (event.type === 'notice' && event.detail_type === 'friend_increase') {
        return (
            event.sub_type === '' &&
            parseAccountId(event.user_id) !== null &&
            exact(event, [...common, 'user_id'])
        );
    }

    if (event.type === 'notice' && event.detail_type === 'private_message_delete') {
        return (
            event.sub_type === '' &&
            event.time <= Number.MAX_SAFE_INTEGER &&
            parseAccountId(event.user_id) !== null &&
            parseMessageId(event.message_id) !== null &&
            exact(event, [...common, 'message_id', 'user_id'])
        );
    }

    if (event.type === 'notice' && event.detail_type === 'qq.group_name_change') {
        const fields = [...common, 'group_id', 'group_name'];

        if (Object.hasOwn(event, 'operator_id')) {
            if (parseAccountId(event.operator_id) === null) {
                return false;
            }

            fields.push('operator_id');
        }

        return (
            event.sub_type === '' &&
            event.time <= Number.MAX_SAFE_INTEGER &&
            parseAccountId(event.group_id) !== null &&
            typeof event.group_name === 'string' &&
            event.group_name.length > 0 &&
            event.group_name.length <= 1024 &&
            exact(event, fields)
        );
    }

    if (event.type === 'notice' && event.detail_type === 'qq.group_admin_change') {
        return (
            event.sub_type === '' &&
            event.time <= Number.MAX_SAFE_INTEGER &&
            parseAccountId(event.group_id) !== null &&
            parseAccountId(event.user_id) !== null &&
            typeof event.is_admin === 'boolean' &&
            exact(event, [...common, 'group_id', 'user_id', 'is_admin'])
        );
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

    if (event.detail_type === 'group_member_increase') {
        if (Object.hasOwn(event, 'qq.invitor_id')) {
            fields.push('qq.invitor_id');

            if (parseAccountId(event['qq.invitor_id']) === null) {
                return false;
            }
        }

        return event.sub_type === '' && exact(event, fields);
    }

    return (
        event.detail_type === 'group_member_decrease' &&
        event.sub_type === '' &&
        exact(event, fields)
    );
}

type PollGapReason = IngressFailure | 'committed_unsent' | 'delivery_unknown' | 'scope_lost';
type Counter =
    | 'accepted'
    | 'full'
    | 'invalid'
    | 'too_large'
    | 'closing_discard'
    | 'postcommit_unknown'
    | 'admission_uncertain'
    | 'stale_pruned';
type Counters = Record<Counter, number>;
type Host = {
    /** Trusted account identity supplied by the instance, never by an action. */
    self?: unknown;
    captureBinding(): object | null;
    captureSource(): V12Source | undefined;
    verify(source: V12Source | undefined): boolean;
    /** Best-effort diagnostic; never receives event data. */
    onClosingDiscard?(): void;
};
export interface PollGate {
    claim: object | null;
    uncertain: boolean;
}

export type PollGateRegistryResult =
    { kind: 'ready'; gate: PollGate } | { kind: 'invalid_uin' | 'capacity_exhausted' };

export interface PollGateRegistry {
    getOrCreate(uin: unknown): PollGateRegistryResult;
}

/**
 * Internal admission container only, not a same-process security boundary.
 * Capacity bounds registry entries, not total memory, tasks, or external references.
 * With ordinary, unmodified built-ins, lookup and registration invoke no external
 * callbacks. This does not resist malicious same-process mutation. Gates and their
 * WeakMap history survive only while references remain live; this does not establish
 * persistence across managers or processes. Callers must handle invalid/full
 * explicitly and never pass an absent gate to a defaulting API.
 */
export function createPollGateRegistry(capacity: number): PollGateRegistry {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
        throw new RangeError('capacity must be a positive safe integer');
    }

    const gates = new Map<string, PollGate>();
    return {
        getOrCreate(uin: unknown): PollGateRegistryResult {
            if (typeof uin !== 'string' || uin.length > 16 || parseAccountId(uin) === null) {
                return { kind: 'invalid_uin' };
            }

            const existing = gates.get(uin);

            if (existing) {
                return { kind: 'ready', gate: existing };
            }

            if (gates.size >= capacity) {
                return { kind: 'capacity_exhausted' };
            }

            const gate = createPollGate();
            gates.set(uin, gate);
            return { kind: 'ready', gate };
        },
    };
}

type GateState = {
    gap: { source: V12Source; reason: PollGapReason } | null;
    history: V12Source[];
    historyOverflow: boolean;
    transition: object;
    scopeCheck: { reentered: boolean } | null;
};
const gateStates = new WeakMap<PollGate, GateState>();

function gateState(gate: PollGate): GateState {
    let state = gateStates.get(gate);

    if (!state) {
        state = {
            gap: null,
            history: [],
            historyOverflow: false,
            transition: {},
            scopeCheck: null,
        };
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
    facadeCheck: { reentered: boolean } | null;
    revision: object;
    cleanupUncertain: boolean;
    counters: Counters;
    // Exact for this in-memory slot; bigint growth is not an RSS bound.
    droppedOldest: bigint;
};
const slots = new WeakMap<object, Slot>();

export interface PollOwner {
    start(
        request: PollRequest,
        sink: PollSink,
        listenerGuard?: PollListenerGuard,
    ): { result: Promise<PollOutcome>; cancel(): void };
    invalidate(): void;
}

export type PollActivation =
    | { status: 'ready'; owner: PollOwner }
    | { status: 'unavailable' | 'cleanup_pending' | 'degraded' };

/** A single admission reserved before invoking a source supplier. */
export interface OrderedReservation {
    bind(
        source: V12Source | undefined,
    ): { kind: 'ready'; parent: IngressParent } | { kind: 'old' | 'failed' };
    fail(): void;
}

/** Trusted in-process seam only; it is not connected to production HTTP. */
export interface OrderedPollOwner {
    start(request: PollRequest, sink: PollSink): { result: Promise<PollOutcome>; cancel(): void };
    reserve(): OrderedReservation | null;
    matchesTarget(runtime: object): boolean;
    failIngress(): void;
    begin(source: V12Source | undefined): IngressParent | null;
    invalidate(): void;
}
export type OrderedPollActivation =
    | { status: 'ready'; owner: OrderedPollOwner }
    | { status: 'unavailable' | 'cleanup_pending' | 'degraded' };

// Existing numeric counters saturate; the exact oldest-drop counter is tracked separately.
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
        facadeCheck: null,
        revision: {},
        cleanupUncertain: false,
        counters: {
            accepted: 0,
            full: 0,
            invalid: 0,
            too_large: 0,
            closing_discard: 0,
            postcommit_unknown: 0,
            admission_uncertain: 0,
            stale_pruned: 0,
        },
        droppedOldest: 0n,
    });
}

/** Trusted-host-only explicit activation of the legacy FIFO mode. */
export function activatePollOwner(runtime: object): PollActivation {
    const result = activate(runtime, false, 'fifo');
    return result.status === 'ready' ? { status: 'ready', owner: result.owner.facade } : result;
}

/**
 * HTTP uses completion-order admission and a bounded queue. Only the selected FIFO
 * prefix is stably ordered by event time within each response. Overflow evicts the
 * oldest unreserved events when possible; a protected prefix or byte budget can
 * instead drop the new event. Local loss counts do not guarantee a remote gap signal.
 */
export function activateHttpPollOwner(runtime: object): PollActivation {
    const result = activate(runtime, false, 'event-time');
    return result.status === 'ready' ? { status: 'ready', owner: result.owner.facade } : result;
}

/** Explicit in-process prototype; empty polls do not produce an HTTP response. */
export function activateOrderedPollOwner(runtime: object): OrderedPollActivation {
    const result = activate(runtime, true, 'fifo');
    return result.status === 'ready'
        ? { status: 'ready', owner: result.owner.orderedFacade }
        : result;
}

/** Internal fixture proof: compare the supplied reference without inspecting it. */
export function isCurrentOrderedFacade(runtime: object, supplied: unknown): boolean {
    const slot = slots.get(runtime);

    if (!slot) {
        return false;
    }

    if (slot.facadeCheck) {
        slot.facadeCheck.reentered = true;
        return false;
    }

    const owner = slot.owner;

    if (!owner || !owner.ordered || owner.orderedFacade !== supplied) {
        return false;
    }

    const gate = slot.gate;
    const state = gateState(gate);

    if (state.scopeCheck) {
        state.scopeCheck.reentered = true;
        return false;
    }

    const revision = slot.revision;
    const claim = gate.claim;
    const transition = state.transition;
    const check = { reentered: false };
    slot.facadeCheck = check;
    const stable = () =>
        slots.get(runtime) === slot &&
        slot.owner === owner &&
        slot.facadeCheck === check &&
        !check.reentered &&
        slot.revision === revision &&
        slot.gate === gate &&
        gate.claim === claim &&
        claim !== null &&
        owner.ownsGate() &&
        state.transition === transition &&
        state.scopeCheck === null &&
        state.gap === null &&
        !gate.uncertain &&
        !slot.retiring &&
        !slot.activating;

    try {
        return stable() && owner.valid() && stable();
    } catch {
        return false;
    } finally {
        if (slot.facadeCheck === check) {
            slot.facadeCheck = null;
        }
    }
}

type PollBatchOrder = 'fifo' | 'event-time';

function activate(
    runtime: object,
    ordered: boolean,
    batchOrder: PollBatchOrder,
): { status: 'ready'; owner: Owner } | { status: 'unavailable' | 'cleanup_pending' | 'degraded' } {
    const slot = slots.get(runtime);

    if (!slot) {
        return { status: 'unavailable' };
    }

    const gate = gateState(slot.gate);

    if (gate.scopeCheck) {
        gate.scopeCheck.reentered = true;
        return { status: 'cleanup_pending' };
    }

    if (slot.retiring || slot.gate.uncertain) {
        return { status: 'cleanup_pending' };
    }

    if (slot.activating) {
        return { status: 'unavailable' };
    }

    const current = slot.owner;

    if (current) {
        if (current.ordered !== ordered || current.batchOrder !== batchOrder) {
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
        state.scopeCheck === null &&
        slot.gate.claim === claim &&
        slot.revision === revision &&
        state.transition === transition;
    let attached = false;
    let allocatedOwner: Owner | undefined;

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
        const scoped = !ordered && batchOrder === 'event-time';
        const self = ordered || scoped ? orderedSelf(slot.host) : null;

        if ((ordered || scoped) && !self) {
            return { status: 'unavailable' };
        }

        if (
            (ordered || batchOrder === 'event-time' || gap) &&
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
            state.scopeCheck !== null ||
            slot.retiring ||
            slot.owner ||
            slot.gate.uncertain
        ) {
            return { status: 'unavailable' };
        }

        const owner = new Owner(slot, binding, source, claim, ordered, self, batchOrder);
        allocatedOwner = owner;

        if (scoped) {
            const prepared = (): boolean =>
                stable() &&
                state.gap === gap &&
                owner.scopedActive() &&
                sameSourceEpoch(source, source) === 'same' &&
                sourceHasBinding(source, binding);

            if (!prepared()) {
                return { status: 'unavailable' };
            }

            // This queue check is separate because a substituted method can reenter.
            const queueOpen = owner.scopedQueueOpen();

            if (!queueOpen || !prepared()) {
                return { status: 'unavailable' };
            }

            const currentBinding = slot.host.captureBinding();

            if (currentBinding !== binding || !prepared()) {
                return { status: 'unavailable' };
            }

            const currentSource = slot.host.verify(source);

            if (currentSource !== true || !prepared()) {
                return { status: 'unavailable' };
            }

            const lastBinding = slot.host.captureBinding();

            if (lastBinding !== binding || !prepared()) {
                return { status: 'unavailable' };
            }
        }

        slot.owner = owner;
        attached = true;

        if (gap) {
            state.gap = null;
        }

        return { status: 'ready', owner };
    } catch {
        return { status: 'unavailable' };
    } finally {
        if (!attached && allocatedOwner) {
            try {
                allocatedOwner.discardUnattached();
            } catch {
                slot.cleanupUncertain = true;
                slot.gate.uncertain = true;
            }
        }

        slot.activating = false;

        if (!attached && !slot.gate.uncertain && slot.gate.claim === claim) {
            slot.gate.claim = null;
        }
    }
}

export function pollOwnerStats(runtime: object): Readonly<
    Counters & {
        dropped_oldest: string;
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
    const owner = slot?.owner;

    try {
        owner?.syncOldestDrops();
    } catch (error) {
        try {
            // A watermark failure is not an admission result. Retire only the
            // exact scoped owner which was sampled, never a replacement owner.
            if (owner?.hasScopedQueue() && slot?.owner === owner) {
                owner.failScopedAdmission();
            }
        } catch {
            // Preserve the original statistics failure for the caller.
        }

        throw error;
    }

    return slot
        ? {
              ...slot.counters,
              dropped_oldest: slot.droppedOldest.toString(),
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

/** Diagnostic-only mode check; does not claim a gate or validate an epoch. */
export function hasHttpPollOwner(runtime: object): boolean {
    const owner = slots.get(runtime)?.owner;
    return owner?.ordered === false && owner.batchOrder === 'event-time';
}

/** Internal ordered scope guard; never selected from an action request. */
export function hasOrderedPollOwner(runtime: object): boolean {
    return slots.get(runtime)?.owner?.ordered === true;
}

export function failOrderedPollIngress(runtime: object): void {
    const owner = slots.get(runtime)?.owner;

    if (owner?.ordered) {
        owner.failUnsequenced();
    }
}

/** Record a lost prepared scope without attributing an unverified source to a new epoch. */
export function recordPreparedScopeLoss(runtime: object, source: V12Source | undefined): void {
    const slot = slots.get(runtime);

    if (!slot) {
        return;
    }

    const gate = slot.gate;
    const state = gateState(gate);

    const uncertain = () => {
        slot.cleanupUncertain = true;
        gate.uncertain = true;

        try {
            if (slot.owner?.ownsGate()) {
                slot.owner.invalidate();
            }
        } catch {
            /* uncertainty remains sticky */
        }
    };

    if (state.scopeCheck) {
        state.scopeCheck.reentered = true;
        uncertain();
        return;
    }

    // Lock before any host callback; neither activation nor commit can pass it.
    const check = { reentered: false };
    state.scopeCheck = check;
    const transition = {};
    state.transition = transition;
    const owner = slot.owner;
    const claim = gate.claim;
    const revision = slot.revision;
    const oldGap = state.gap;
    const stable = () =>
        state.scopeCheck === check &&
        !check.reentered &&
        state.transition === transition &&
        !gate.uncertain &&
        slot.owner === owner &&
        gate.claim === claim &&
        slot.revision === revision &&
        state.gap === oldGap &&
        !slot.retiring &&
        !slot.activating;

    try {
        if (
            !source ||
            sameSourceEpoch(source, source) !== 'same' ||
            !stable() ||
            (owner ? !owner.ownsGate() || !owner.matchesScopeSource(source) : claim !== null) ||
            (oldGap && sameSourceEpoch(oldGap.source, source) !== 'same')
        ) {
            uncertain();
            return;
        }

        const binding = slot.host.captureBinding();

        if (!binding || !stable() || !sourceHasBinding(source, binding)) {
            uncertain();
            return;
        }

        const verified = slot.host.verify(source);

        if (!verified || !stable()) {
            uncertain();
            return;
        }

        const finalBinding = slot.host.captureBinding();

        if (finalBinding !== binding || !stable()) {
            uncertain();
            return;
        }

        if (!oldGap) {
            state.gap = { source, reason: 'scope_lost' };
        }

        owner?.invalidate();
    } catch {
        uncertain();
    } finally {
        if (check.reentered) {
            uncertain();
        }

        if (state.scopeCheck === check) {
            state.scopeCheck = null;
        } else {
            uncertain();
        }
    }
}

/** Called after conversion, before normal WS fanout; metadata stays out of payloads. */
export function enqueuePollEvent(
    runtime: object,
    event: unknown,
    source: V12Source | undefined,
    mediaGuard?: () => boolean,
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

    if (!source) {
        return;
    }

    const retireLostScope = (): void => {
        try {
            if (owner.hasScopedQueue() && !owner.scopedActive() && slot.owner === owner) {
                owner.invalidate();
            }
        } catch {
            // The scope check or retirement may have had effects; do not report a
            // dropped event or allow diagnostics to interrupt normal WS fanout.
            try {
                owner.failScopedAdmission();
            } catch {
                // The best-effort sticky-gate transition was already attempted.
            }
        }
    };

    if (!owner.valid()) {
        retireLostScope();
        return;
    }

    let enqueueStarted = false;

    try {
        // HTTP must never admit an old source into a replacement generation,
        // even if a host verifier is permissive or reenters during verification.
        if (
            (owner.batchOrder === 'event-time' && !owner.matchesScopeSource(source)) ||
            !slot.host.verify(source) ||
            !owner.valid() ||
            (owner.batchOrder === 'event-time' && !owner.matchesScopeSource(source))
        ) {
            retireLostScope();
            return;
        }

        // The production media guard is a trusted, synchronous issuer-identity
        // sample. It must not call host verification or be retained by the queue.
        if (owner.batchOrder === 'event-time' && mediaGuard !== undefined) {
            let current = false;

            try {
                current = mediaGuard() === true;
            } catch {
                // A throwing guard rejects this admission just like a false result.
            }

            if (!current) {
                increment(slot, 'invalid');
                retireLostScope();
                return;
            }
        }

        enqueueStarted = true;
        const result = owner.enqueue(event);

        if (result === 'accepted') {
            increment(slot, 'accepted');
        } else if (result === 'full') {
            increment(slot, 'full');
        } else if (result === 'oversize') {
            increment(slot, 'too_large');
        } else if (result === 'invalid') {
            increment(slot, 'invalid');
        } else if (result === 'uncertain') {
            increment(slot, 'admission_uncertain');
        }
    } catch {
        if (enqueueStarted && owner.hasScopedQueue()) {
            increment(slot, 'admission_uncertain');
            owner.failScopedAdmission();
        } else {
            increment(slot, 'invalid');
            owner.invalidate();
        }
    }
}

export type PrivateRecallPollAdmission =
    'accepted' | 'unavailable' | 'full' | 'oversize' | 'invalid' | 'uncertain';

/**
 * Trusted internal admission seam, not a same-process authentication boundary.
 * The caller owns deduplication of the original event and exact source ticket;
 * distinct candidates or proofs do not establish distinct source events. A
 * possibly published admission must never be retried automatically. The guard
 * is sampled synchronously and is not retained by the queue or event payload.
 */
export function enqueuePrivateRecallPollEvent(
    runtime: object,
    expectedOwner: PollOwner,
    candidate: unknown,
    proof: PrivateRecallPollProof,
    source: V12Source,
    guard: () => boolean,
): PrivateRecallPollAdmission {
    const slot = slots.get(runtime);
    const owner = slot?.owner;

    if (
        !slot ||
        !owner ||
        owner.facade !== expectedOwner ||
        owner.ordered ||
        owner.batchOrder !== 'event-time' ||
        !owner.hasScopedQueue() ||
        typeof guard !== 'function'
    ) {
        return 'unavailable';
    }

    const gate = slot.gate;
    const state = gateState(gate);
    const claim = gate.claim;
    const revision = slot.revision;
    const transition = state.transition;
    let attempted = false;

    const sameOwner = (): boolean =>
        slots.get(runtime) === slot &&
        slot.owner === owner &&
        slot.gate === gate &&
        gate.claim === claim &&
        claim !== null;
    const stable = (): boolean =>
        sameOwner() &&
        owner.facade === expectedOwner &&
        slot.revision === revision &&
        state.transition === transition &&
        state.scopeCheck === null &&
        state.gap === null &&
        !slot.retiring &&
        !slot.activating &&
        !gate.uncertain &&
        owner.hasRecallAuthority();

    const unavailable = (): 'unavailable' => {
        try {
            if (sameOwner() && !owner.scopedActive() && sameOwner()) {
                owner.invalidate();
            }
        } catch {
            try {
                if (sameOwner()) {
                    owner.failScopedAdmission();
                }
            } catch {
                // The original owner must never affect a replacement.
            }
        }

        return 'unavailable';
    };

    const validate = (): 'unavailable' | 'invalid' | null => {
        if (!stable() || !owner.matchesScopeSource(source)) {
            return unavailable();
        }

        if (!owner.matchesRecallProof(candidate, proof, source)) {
            if (!stable() || !owner.matchesScopeSource(source)) {
                return unavailable();
            }

            increment(slot, 'invalid');
            return 'invalid';
        }

        return stable() && owner.matchesScopeSource(source) ? null : unavailable();
    };

    try {
        let validation = validate();

        if (validation !== null) {
            return validation;
        }

        // This probe can reenter; all authority and proof checks are repeated after it.
        let queueOpen: boolean;

        try {
            queueOpen = owner.scopedQueueOpen();
        } catch {
            if (sameOwner()) {
                owner.failScopedAdmission();
            }

            return unavailable();
        }

        if (queueOpen !== true) {
            try {
                if (sameOwner()) {
                    const scopeActive = owner.scopedActive();

                    if (sameOwner()) {
                        if (scopeActive === false) {
                            owner.invalidate();
                        } else {
                            // A non-open queue contradicts a live owner scope.
                            owner.failScopedAdmission();
                        }
                    }
                }
            } catch {
                try {
                    if (sameOwner()) {
                        owner.failScopedAdmission();
                    }
                } catch {
                    // Never change a replacement owner after a reentrant probe.
                }
            }

            return unavailable();
        }

        validation = validate();

        if (validation !== null) {
            return validation;
        }

        if (owner.valid() !== true) {
            return unavailable();
        }

        validation = validate();

        if (validation !== null) {
            return validation;
        }

        if (slot.host.verify(source) !== true) {
            return unavailable();
        }

        validation = validate();

        if (validation !== null) {
            return validation;
        }

        if (guard() !== true) {
            return unavailable();
        }

        validation = validate();

        if (validation !== null) {
            return validation;
        }

        if (owner.valid() !== true) {
            return unavailable();
        }

        validation = validate();

        if (validation !== null) {
            return validation;
        }

        if (slot.host.verify(source) !== true) {
            return unavailable();
        }

        validation = validate();

        if (validation !== null) {
            return validation;
        }

        // Sample the trusted guard last; the following checks use only retained
        // identities and fixed scope/proof verifiers, without a host callback.
        if (guard() !== true) {
            return unavailable();
        }

        validation = validate();

        if (validation !== null) {
            return validation;
        }

        attempted = true;
        const result = owner.enqueueScopedRecall(candidate, proof, source);

        if (result === 'accepted') {
            increment(slot, 'accepted');
            return 'accepted';
        }

        if (result === 'full') {
            increment(slot, 'full');
            return 'full';
        }

        if (result === 'oversize') {
            increment(slot, 'too_large');
            return 'oversize';
        }

        if (result === 'invalid' || result === 'meta') {
            increment(slot, 'invalid');
            return 'invalid';
        }

        if (result === 'uncertain') {
            increment(slot, 'admission_uncertain');
            return 'uncertain';
        }

        return unavailable();
    } catch {
        if (attempted) {
            increment(slot, 'admission_uncertain');

            if (sameOwner()) {
                owner.failScopedAdmission();
            }

            return 'uncertain';
        }

        return unavailable();
    }
}

/** The supplied gate protects one owner. The default manager shares it by account
 * across replacement instances; standalone/custom instances and other managers or
 * processes need their own coordination. */
class Owner implements PollOwner {
    private readonly queue: EventPollBuffer;
    readonly #scopedScope: PrivateRecallPollEpochAccountScope | null;
    private oldestDropWatermark = 0n;
    private readonly sequencer: IngressSequencer | null;
    private readonly ownerRevision: object;
    private readonly coordinator: PollCoordinator;
    private readonly running = new Set<Promise<unknown>>();
    private retired = false;
    private invalidating = false;
    private checking = false;
    readonly facade: PollOwner = Object.freeze({
        start: (request: PollRequest, sink: PollSink, listenerGuard?: PollListenerGuard) =>
            listenerGuard === undefined
                ? this.start(request, sink)
                : this.start(request, sink, listenerGuard),
        invalidate: () => this.invalidate(),
    });
    readonly orderedFacade: OrderedPollOwner = Object.freeze({
        start: (request: PollRequest, sink: PollSink) => this.start(request, sink),
        reserve: () => this.reserve(),
        matchesTarget: (runtime: object) => slots.get(runtime) === this.slot && this.valid(),
        failIngress: () => this.failUnsequenced(),
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
        readonly batchOrder: PollBatchOrder,
    ) {
        const scoped = !ordered && batchOrder === 'event-time';
        const scope = scoped ? createPrivateRecallPollEpochAccountScope(source, self) : undefined;

        if (scoped && !scope) {
            throw new Error('scoped poll owner unavailable');
        }

        this.#scopedScope = scope ?? null;
        let queue: EventPollBuffer | undefined;
        let creatingQueue = false;
        let creatingCoordinator = false;

        try {
            creatingQueue = true;
            this.queue = queue = scope
                ? EventPollBuffer.scoped(limits, 'drop-oldest', scope)
                : new EventPollBuffer(limits);
            creatingQueue = false;
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

                              if (
                                  !this.self ||
                                  !validOrderedEvent(event, this.self) ||
                                  !this.valid()
                              ) {
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
            const coordinatorArgs = [
                this.queue,
                limits.maxQueueBytes,
                () => performance.now(),
                () => this.valid(),
                ordered ? 'unavailable' : 'legacy',
            ] as const;
            creatingCoordinator = true;
            this.coordinator = scope
                ? PollCoordinator.scoped(...coordinatorArgs, 'event-time', (status) =>
                      this.onScopedStatus(status),
                  )
                : batchOrder === 'event-time'
                  ? new PollCoordinator(...coordinatorArgs, 'event-time')
                  : new PollCoordinator(...coordinatorArgs);
            creatingCoordinator = false;
        } catch (error) {
            if (scope) {
                // A factory that throws before returning may have retained work.
                if (creatingQueue || creatingCoordinator) {
                    this.markUncertain();
                }

                try {
                    if (
                        isPrivateRecallPollEpochAccountScopeActive(scope) &&
                        !retirePrivateRecallPollEpochAccountScope(scope)
                    ) {
                        this.markUncertain();
                    }

                    if (isPrivateRecallPollEpochAccountScopeActive(scope)) {
                        this.markUncertain();
                    }
                } catch {
                    this.markUncertain();
                }

                if (queue) {
                    try {
                        queue.close();

                        if (queue.guardedCleanupState() !== 'closed') {
                            this.markUncertain();
                        }
                    } catch {
                        this.markUncertain();
                    }
                }
            }

            throw error;
        }
    }

    hasScopedQueue(): boolean {
        return this.#scopedScope !== null;
    }

    failScopedAdmission(): void {
        this.markUncertain();

        try {
            this.invalidate();
        } catch {
            this.markUncertain();
        }
    }

    scopedQueueOpen(): boolean {
        return this.#scopedScope !== null && this.queue.guardedCleanupState() === 'open';
    }

    scopedActive(): boolean {
        return (
            this.#scopedScope !== null &&
            isPrivateRecallPollEpochAccountScopeActive(this.#scopedScope)
        );
    }

    /** Local identity and scope checks only; live source validation is separate. */
    hasRecallAuthority(): boolean {
        return (
            !this.ordered &&
            this.batchOrder === 'event-time' &&
            this.self !== null &&
            this.#scopedScope !== null &&
            this.attached() &&
            isPrivateRecallPollEpochAccountScopeActive(this.#scopedScope)
        );
    }

    /** The proof must bind this exact event ticket and this owner's captured self. */
    matchesRecallProof(
        candidate: unknown,
        proof: PrivateRecallPollProof,
        source: V12Source,
    ): boolean {
        const scope = this.#scopedScope;
        const self = this.self;

        return (
            scope !== null &&
            self !== null &&
            isPrivateRecallPollProofFor(proof, candidate) &&
            isPrivateRecallPollProofBoundTo(proof, source, self) &&
            isPrivateRecallPollProofInEpochAccountScope(proof, source, scope)
        );
    }

    private retireScopedScope(): void {
        const scope = this.#scopedScope;

        if (!scope) {
            return;
        }

        try {
            if (
                isPrivateRecallPollEpochAccountScopeActive(scope) &&
                !retirePrivateRecallPollEpochAccountScope(scope)
            ) {
                this.markUncertain();
            }

            if (isPrivateRecallPollEpochAccountScopeActive(scope)) {
                this.markUncertain();
            }
        } catch {
            this.markUncertain();
        }
    }

    /** Cleanup an unpublished owner before its activation claim may be released. */
    discardUnattached(): void {
        this.retired = true;

        if (!this.ownsGate()) {
            this.markUncertain();
        }

        this.retireScopedScope();

        try {
            this.coordinator.close();
        } catch {
            this.markUncertain();
        }

        try {
            this.queue.close();

            if (this.#scopedScope && this.queue.guardedCleanupState() !== 'closed') {
                this.markUncertain();
            }
        } catch {
            this.markUncertain();
        }
    }

    private onScopedStatus(status: ScopedPollStatus): void {
        try {
            if (status.kind === 'pruned') {
                const count = status.count;

                if (!Number.isSafeInteger(count) || count <= 0) {
                    this.markUncertain();
                } else {
                    increment(this.slot, 'stale_pruned', count);
                    return;
                }
            } else if (status.kind !== 'scope_revoked') {
                // Unknown statuses and explicit uncertainty both fail closed.
                this.markUncertain();
            }

            // A clean scope revocation retires only this owner; uncertainty is sticky.
            if (!this.retired && !this.invalidating && this.slot.owner === this) {
                this.invalidate();
            }
        } catch {
            this.markUncertain();

            try {
                if (!this.retired && !this.invalidating && this.slot.owner === this) {
                    this.invalidate();
                }
            } catch {
                // The gate remains uncertain even if retirement itself failed.
            }
        }
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
        try {
            this.onGap('child_failed');
        } catch {
            this.markUncertain();

            try {
                this.invalidate();
            } catch {
                /* keep the stronger gate lock */
            }
        }
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
        const reservation = this.reserve();

        if (!reservation) {
            return null;
        }

        const result = reservation.bind(source);
        return result.kind === 'ready' ? result.parent : null;
    }

    private reserve(): OrderedReservation | null {
        if (!this.ordered || !this.sequencer || !this.attached()) {
            return null;
        }

        // Reserve before the caller can invoke any source getter or verification.
        const parent = this.sequencer.admit();

        if (!parent || !this.attached()) {
            return null;
        }

        let used = false;
        return Object.freeze({
            bind: (source: V12Source | undefined) => {
                if (used) {
                    if (this.attached()) {
                        this.onGap('late_candidate');
                    }

                    return { kind: 'failed' as const };
                }

                used = true;

                if (!this.attached()) {
                    return { kind: 'failed' as const };
                }

                const relation = sameSourceEpoch(this.source, source);

                if (relation === 'invalid') {
                    this.failParent(parent);
                    return { kind: 'failed' as const };
                }

                if (relation === 'different') {
                    const state = gateState(this.slot.gate);
                    const knownOld =
                        !state.historyOverflow &&
                        state.history.some((entry) => sameSourceEpoch(entry, source) === 'same');

                    if (!knownOld || !this.verifyInput(this.source)) {
                        this.failParent(parent);
                        return { kind: 'failed' as const };
                    }

                    return parent.seal() ? { kind: 'old' as const } : { kind: 'failed' as const };
                }

                if (!source || !this.verifyInput(source)) {
                    this.failParent(parent);
                    return { kind: 'failed' as const };
                }

                return { kind: 'ready' as const, parent: this.boundParent(parent, source) };
            },
            fail: () => {
                if (used) {
                    return;
                }

                used = true;
                this.failParent(parent);
            },
        });
    }

    private boundParent(parent: IngressParent, source: V12Source): IngressParent {
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

    private gateAllows(): boolean {
        const state = gateState(this.slot.gate);

        if (state.scopeCheck) {
            state.scopeCheck.reentered = true;
            return false;
        }

        return state.gap === null;
    }

    matchesScopeSource(source: V12Source): boolean {
        return (
            sameSourceEpoch(this.source, source) === 'same' &&
            sourceHasBinding(source, this.binding)
        );
    }

    valid(): boolean {
        if (!this.gateAllows()) {
            return false;
        }

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
                this.gateAllows() &&
                (this.#scopedScope === null ||
                    (this.scopedActive() &&
                        sameSourceEpoch(this.source, this.source) === 'same' &&
                        sourceHasBinding(this.source, this.binding))) &&
                (!this.ordered || this.sequencer?.stats().state === 'active') &&
                this.slot.host.captureBinding() === this.binding &&
                this.slot.host.verify(this.source) &&
                !this.retired &&
                this.slot.owner === this &&
                this.slot.host.captureBinding() === this.binding &&
                !this.retired &&
                !this.slot.gate.uncertain &&
                this.ownsGate() &&
                this.slot.owner === this &&
                this.gateAllows() &&
                (this.#scopedScope === null || this.scopedActive()) &&
                (!this.ordered || this.sequencer?.stats().state === 'active') &&
                this.attached()
            );
        } catch {
            return false;
        } finally {
            this.checking = false;
        }
    }

    /** Reconcile committed evictions without invoking a host callback. */
    syncOldestDrops(): void {
        if (this.ordered || this.batchOrder !== 'event-time') {
            return;
        }

        const count: unknown = this.queue.oldestDropCount();

        if (typeof count !== 'bigint' || count < 0n || count < this.oldestDropWatermark) {
            if (this.#scopedScope !== null) {
                this.markUncertain();
            }

            throw new Error('poll oldest-drop watermark invalid');
        }

        if (count > this.oldestDropWatermark) {
            const delta = count - this.oldestDropWatermark;
            // Publish the watermark first so nested observations cannot double-count.
            this.oldestDropWatermark = count;
            this.slot.droppedOldest += delta;
        }
    }

    enqueue(event: unknown) {
        if (!this.#scopedScope) {
            try {
                return this.queue.enqueue(event);
            } finally {
                // A drain failure can follow a committed eviction.
                this.syncOldestDrops();
            }
        }

        return this.enqueueScoped(() => this.queue.enqueue(event));
    }

    enqueueScopedRecall(candidate: unknown, proof: PrivateRecallPollProof, source: V12Source) {
        if (!this.#scopedScope) {
            return 'closed' as const;
        }

        return this.enqueueScoped(
            () => this.queue.enqueueScopedRecall(candidate, proof, source),
            true,
        );
    }

    /** Execute a fixed queue operation synchronously without retaining the caller's guard. */
    private enqueueScoped(operation: () => ReturnType<EventPollBuffer['enqueue']>, recall = false) {
        let result: ReturnType<EventPollBuffer['enqueue']> | undefined;
        let uncertain = false;

        try {
            result = operation();
        } catch {
            // Publication and eviction may already have happened; never retry.
            uncertain = true;
        } finally {
            try {
                this.syncOldestDrops();
            } catch {
                uncertain = true;
            }
        }

        let recallScopeActive: boolean | undefined;

        if (recall) {
            try {
                recallScopeActive = this.scopedActive();

                if (recallScopeActive !== true && recallScopeActive !== false) {
                    uncertain = true;
                }
            } catch {
                uncertain = true;
            }
        }

        const cleanRevocation =
            recall &&
            (result === 'scope_revoked' || result === 'closed') &&
            recallScopeActive === false;

        try {
            const cleanup: unknown = this.queue.guardedCleanupState();

            if (
                (cleanup !== 'open' && cleanup !== 'closing' && cleanup !== 'closed') ||
                ((cleanup === 'closing' || cleanup === 'closed') &&
                    !this.retired &&
                    !cleanRevocation)
            ) {
                uncertain = true;
            }
        } catch {
            uncertain = true;
        }

        if (
            recall &&
            (result === 'scope_revoked' || result === 'closed') &&
            recallScopeActive === true &&
            !this.retired
        ) {
            // An open owner scope cannot explain a closed/revoked scoped queue.
            uncertain = true;
        }

        if (
            (result !== 'accepted' &&
                result !== 'full' &&
                result !== 'oversize' &&
                result !== 'invalid' &&
                result !== 'meta' &&
                result !== 'closed' &&
                result !== 'scope_revoked') ||
            this.slot.gate.uncertain
        ) {
            uncertain = true;
        }

        if (uncertain) {
            if (!recall || (this.ownsGate() && (this.slot.owner === this || !this.slot.owner))) {
                this.failScopedAdmission();
            }

            return 'uncertain' as const;
        }

        if (
            (result === 'scope_revoked' || !this.scopedActive()) &&
            !this.retired &&
            this.slot.owner === this
        ) {
            try {
                this.invalidate();
            } catch {
                this.markUncertain();
            }
        }

        return result;
    }

    start(
        request: PollRequest,
        sink: PollSink,
        listenerGuard?: PollListenerGuard,
    ): { result: Promise<PollOutcome>; cancel(): void } {
        const failure = (kind: 'epoch_invalid' | 'busy' | 'invalid_input' | 'queue_error') => ({
            result: Promise.resolve({ kind } as PollOutcome),
            cancel() {},
        });

        // Only the production HTTP owner requires a listener-specific guard.
        // Legacy and ordered owners keep their existing two-argument contract.
        if (
            !this.ordered &&
            this.batchOrder === 'event-time' &&
            typeof listenerGuard !== 'function'
        ) {
            return failure('epoch_invalid');
        }

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

            const tx =
                listenerGuard === undefined
                    ? this.coordinator.create(snapshot, sink)
                    : this.coordinator.create(snapshot, sink, listenerGuard);

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
                            core.kind === 'commit_unknown' ||
                            (this.#scopedScope !== null && core.kind === 'scoped_uncertain');

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
                            (outcome.kind === 'cleanup_uncertain' && outcome.committed !== false) ||
                            (core.kind === 'scoped_uncertain' && core.committed !== false) ||
                            (core.kind === 'scope_revoked' && core.committed)
                        ) {
                            increment(this.slot, 'postcommit_unknown');
                        }

                        if (uncertain || core.kind === 'scope_revoked') {
                            this.invalidate();
                        }
                    } catch {
                        this.markUncertain();

                        if (this.#scopedScope !== null) {
                            try {
                                this.invalidate();
                            } catch {
                                this.markUncertain();
                            }
                        }
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

    private invalidateScoped(): void {
        if (this.retired || this.invalidating) {
            return;
        }

        // Retire admission before any cleanup or status hook can reenter.
        this.invalidating = true;
        this.retired = true;
        const attached = this.slot.owner === this;

        if (!attached || !this.ownsGate()) {
            this.markUncertain();
        }

        if (attached) {
            this.slot.owner = null;
            this.slot.retiring = true;
            this.slot.revision = {};

            try {
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
            } catch {
                this.markUncertain();
            }
        }

        let accountingReliable = true;

        try {
            this.syncOldestDrops();
        } catch {
            accountingReliable = false;
            this.markUncertain();
        }

        // Scope retirement precedes cancellation and any late token settlement.
        this.retireScopedScope();

        try {
            this.coordinator.close();
        } catch {
            this.markUncertain();
        }

        this.invalidating = false;

        try {
            void Promise.allSettled([...this.running]).then(
                () => {
                    let count: number | undefined;
                    let closeReturned = false;
                    let closed = false;
                    let scopeRetired = false;
                    let discardRecorded = false;

                    try {
                        this.syncOldestDrops();
                    } catch {
                        accountingReliable = false;
                        this.markUncertain();
                    }

                    try {
                        const observed = this.queue.stats().count;

                        if (!Number.isSafeInteger(observed) || observed < 0) {
                            accountingReliable = false;
                            this.markUncertain();
                        } else if (accountingReliable) {
                            count = observed;
                        }
                    } catch {
                        accountingReliable = false;
                        this.markUncertain();
                    }

                    // Even an unknown watermark or count must not skip queue cleanup.
                    try {
                        this.queue.close();
                        closeReturned = true;
                    } catch {
                        this.markUncertain();
                    }

                    try {
                        closed = this.queue.guardedCleanupState() === 'closed';
                    } catch {
                        this.markUncertain();
                    }

                    try {
                        scopeRetired = !this.scopedActive();
                    } catch {
                        this.markUncertain();
                    }

                    // A close request or stats().closed alone does not prove cleanup.
                    if (!closeReturned || !closed || !scopeRetired) {
                        this.markUncertain();
                    }

                    if (count !== undefined && closeReturned && closed && scopeRetired) {
                        try {
                            increment(this.slot, 'closing_discard', count);
                            discardRecorded = true;
                        } catch {
                            this.markUncertain();
                        }
                    }

                    if (
                        !this.slot.gate.uncertain &&
                        closeReturned &&
                        closed &&
                        scopeRetired &&
                        this.ownsGate() &&
                        this.slot.owner === null &&
                        this.slot.retiring
                    ) {
                        this.slot.gate.claim = null;
                        this.slot.retiring = false;
                    } else if (!this.slot.gate.uncertain) {
                        this.markUncertain();
                    }

                    if (discardRecorded && count !== undefined && count > 0) {
                        try {
                            this.slot.host.onClosingDiscard?.();
                        } catch {
                            // Diagnostics do not change cleanup or gate state.
                        }
                    }
                },
                () => this.markUncertain(),
            );
        } catch {
            this.markUncertain();
        }
    }

    invalidate(): void {
        if (this.#scopedScope !== null) {
            this.invalidateScoped();
            return;
        }

        if (this.retired || this.invalidating) {
            return;
        }

        // Preserve committed evictions before this owner can detach from the slot.
        this.syncOldestDrops();
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

                    if (count > 0 && this.batchOrder === 'event-time') {
                        try {
                            this.slot.host.onClosingDiscard?.();
                        } catch {
                            // Diagnostics must not change gate or cleanup state.
                        }
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
