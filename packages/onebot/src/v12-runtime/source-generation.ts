import type { OrderedPollOwner } from './poll-owner';

/** Internal-only source metadata. These symbols are not part of event payloads. */
export const captureSource = Symbol('v12 source capture');
export const captureBinding = Symbol('v12 binding capture');
export const receiveSourceEvent = Symbol('v12 source event');
export const verifySource = Symbol('v12 source verify');

class Ticket {
    readonly #binding: object;
    readonly #online: object;

    constructor(binding: object, online: object) {
        this.#binding = binding;
        this.#online = online;
    }

    static compare(a: unknown, b: unknown): 'same' | 'different' | 'invalid' {
        try {
            if (
                typeof a !== 'object' ||
                a === null ||
                !(#binding in a) ||
                !(#online in a) ||
                typeof b !== 'object' ||
                b === null ||
                !(#binding in b) ||
                !(#online in b)
            ) {
                return 'invalid';
            }

            return a.#binding === b.#binding && a.#online === b.#online ? 'same' : 'different';
        } catch {
            return 'invalid';
        }
    }

    static hasBinding(source: unknown, binding: object): boolean {
        try {
            return (
                typeof source === 'object' &&
                source !== null &&
                #binding in source &&
                source.#binding === binding
            );
        } catch {
            return false;
        }
    }

    static matches(source: unknown, binding: object, online: object): boolean {
        try {
            return (
                typeof source === 'object' &&
                source !== null &&
                #binding in source &&
                #online in source &&
                source.#binding === binding &&
                source.#online === online
            );
        } catch {
            return false;
        }
    }
}

export type V12Source = Ticket;

/** Private generation identity, not authentication against same-process code. */
export function sameSourceEpoch(a: unknown, b: unknown): 'same' | 'different' | 'invalid' {
    return Ticket.compare(a, b);
}

export function sourceHasBinding(source: unknown, binding: object): boolean {
    return Ticket.hasBinding(source, binding);
}

/** Tracks only the OneBot admission boundary, not earlier protocol processing. */
export class SourceGeneration {
    private online: object | null = null;

    setOnline(value: boolean): void {
        if (value) {
            this.online ??= {};
        } else {
            this.online = null;
        }
    }

    capture(binding: object | null): V12Source | undefined {
        return binding && this.online ? new Ticket(binding, this.online) : undefined;
    }

    isCurrent(source: V12Source | undefined, binding: object | null): boolean {
        return (
            binding !== null && this.online !== null && Ticket.matches(source, binding, this.online)
        );
    }
}

export function tryCaptureSource(context: {
    [captureSource]?: () => V12Source | undefined;
}): V12Source | undefined {
    try {
        return context[captureSource]?.();
    } catch {
        return undefined;
    }
}

/** Trusted internal scope metadata; never attach these objects to event payloads. */
export interface OrderedLease {
    resolve(value: unknown): boolean;
    skip(): boolean;
    fail(): boolean;
    pending(): boolean;
}
export type OrderedAdmission =
    | { readonly kind: 'disabled' | 'failed' }
    | {
          readonly kind: 'not_eligible';
          readonly target: object;
          readonly source: V12Source | undefined;
          readonly reportOnLoss: boolean;
      }
    | { readonly kind: 'eligible'; readonly target: object; readonly lease: OrderedLease };
type Ready = { readonly target: object; readonly owner: OrderedPollOwner; readonly cut: object };
type ReadyCell = { ready: Ready | null; target: object };
// Internal weak registration identifies objects constructed by the runtime module;
// this is neither instance ownership proof nor a same-process security boundary.
const supportedRuntimes = new WeakSet<object>();
const scopeLossHandlers = new WeakMap<object, (source: V12Source | undefined) => void>();
const contexts = new WeakMap<object, ReadyCell>();
const readyTargets = new WeakMap<object, { context: object; cut: object }>();
const disabled = Object.freeze({ kind: 'disabled' as const });
const failed = Object.freeze({ kind: 'failed' as const });

function notEligible(target: object, source: V12Source | undefined, reportOnLoss: boolean) {
    return Object.freeze({ kind: 'not_eligible' as const, target, source, reportOnLoss });
}

/** Called by the V12Runtime constructor; no readiness or I/O is activated. */
export function registerOrderedRuntime(
    target: object,
    onScopeLoss: (source: V12Source | undefined) => void,
): void {
    scopeLossHandlers.set(target, onScopeLoss);
    supportedRuntimes.add(target);
}

/** Internal trusted-fixture setup; registration is not an authorization boundary. */
export function prepareOrderedContext(context: object, target: object): void {
    if (typeof target !== 'object' || target === null || !supportedRuntimes.has(target)) {
        throw new TypeError('unregistered ordered runtime');
    }

    const cell = contexts.get(context);

    if (!cell) {
        contexts.set(context, { ready: null, target });
    } else if (cell.target !== target) {
        throw new Error('ordered context target mismatch');
    }
}

/** Internal-only fake activation seam. Production does not install a ready pointer. */
export function installOrderedReady(
    context: object,
    target: object,
    owner: OrderedPollOwner,
): object | null {
    const cell = contexts.get(context);

    if (!cell || cell.ready || cell.target !== target || !supportedRuntimes.has(target)) {
        return null;
    }

    try {
        if (
            !owner.matchesTarget(target) ||
            contexts.get(context) !== cell ||
            cell.ready ||
            readyTargets.has(target)
        ) {
            return null;
        }
    } catch {
        return null;
    }

    const cut = {};
    cell.target = target;
    cell.ready = Object.freeze({ target, owner, cut });
    readyTargets.set(target, { context, cut });
    return cut;
}

/** Only the installer holding the exact cut may revoke it. */
export function revokeOrderedReady(context: object, cut: object): boolean {
    const cell = contexts.get(context);

    if (!cell || cell.ready?.cut !== cut) {
        return false;
    }

    const target = cell.ready.target;
    cell.ready = null;
    const reverse = readyTargets.get(target);

    if (reverse?.context === context && reverse.cut === cut) {
        readyTargets.delete(target);
    }

    return true;
}

/** These revoke only the exact current pair; stale runtime cleanup cannot clear a new cut. */
export function revokeOrderedContext(context: object): void {
    const cut = contexts.get(context)?.ready?.cut;

    if (cut) {
        revokeOrderedReady(context, cut);
    }
}

export function revokeOrderedTarget(target: object): void {
    const pair = readyTargets.get(target);

    if (pair) {
        revokeOrderedReady(pair.context, pair.cut);
    }
}

/** Explicit exclusion for the existing internally generated status/heartbeat paths. */
export function excludedOrderedContext(context: object): OrderedAdmission {
    const cell = contexts.get(context);
    return cell ? notEligible(cell.target, undefined, false) : disabled;
}

export type PendingAdmission =
    | { readonly kind: 'disabled' | 'failed' }
    | { readonly kind: 'not_eligible'; readonly target: object }
    | {
          readonly kind: 'reserved';
          readonly ready: Ready;
          readonly reservation: NonNullable<ReturnType<OrderedPollOwner['reserve']>>;
      };

/** Lookup and reserve run before calling a potentially reentrant source supplier. */
export function reserveOrderedContext(context: object): PendingAdmission {
    const cell = contexts.get(context);

    if (!cell) {
        return disabled;
    }

    const ready = cell.ready;

    if (!ready) {
        return Object.freeze({ kind: 'not_eligible' as const, target: cell.target });
    }

    let reservation: ReturnType<OrderedPollOwner['reserve']>;

    try {
        reservation = ready.owner.reserve();
    } catch {
        try {
            ready.owner.failIngress();
        } catch {
            /* no WS/v11 propagation changes */
        }

        return failed;
    }

    if (!reservation) {
        return failed;
    }

    if (contexts.get(context)?.ready !== ready) {
        reservation.fail();
        return failed;
    }

    return { kind: 'reserved', ready, reservation };
}

export function bindOrderedContext(
    context: object,
    pending: PendingAdmission,
    source: V12Source | undefined,
    hasChild: boolean,
): OrderedAdmission {
    if (pending.kind === 'not_eligible') {
        return notEligible(pending.target, source, hasChild);
    }

    if (pending.kind !== 'reserved') {
        return pending;
    }

    if (contexts.get(context)?.ready !== pending.ready) {
        pending.reservation.fail();
        return failed;
    }

    let bound: ReturnType<typeof pending.reservation.bind>;

    try {
        bound = pending.reservation.bind(source);
    } catch {
        try {
            pending.reservation.fail();
            pending.ready.owner.failIngress();
        } catch {
            /* preserve WS/v11 */
        }

        return failed;
    }

    if (bound.kind === 'old') {
        return notEligible(pending.ready.target, source, hasChild);
    }

    if (bound.kind !== 'ready') {
        return failed;
    }

    let child: ReturnType<typeof bound.parent.child>;

    try {
        if (!hasChild) {
            return bound.parent.seal() ? notEligible(pending.ready.target, source, false) : failed;
        }

        child = bound.parent.child();

        if (!child) {
            return failed;
        }

        if (!bound.parent.seal()) {
            child.fail();
            return failed;
        }
    } catch {
        try {
            pending.ready.owner.failIngress();
        } catch {
            /* preserve WS/v11 */
        }

        return failed;
    }

    let terminal = false;

    const onError = () => {
        try {
            pending.ready.owner.failIngress();
        } catch {
            /* preserve WS/v11 */
        }
    };

    const lease: OrderedLease = Object.freeze({
        resolve(value: unknown): boolean {
            try {
                if (terminal) {
                    return child.resolve(value);
                }

                terminal = true;
                return child.resolve(value);
            } catch {
                onError();
                return false;
            }
        },
        skip(): boolean {
            if (terminal) {
                return false;
            }

            terminal = true;

            try {
                return child.skip();
            } catch {
                onError();
                return false;
            }
        },
        fail(): boolean {
            if (terminal) {
                return false;
            }

            terminal = true;

            try {
                return child.fail();
            } catch {
                onError();
                return false;
            }
        },
        pending(): boolean {
            return !terminal;
        },
    });
    return Object.freeze({ kind: 'eligible', target: pending.ready.target, lease });
}

/** Skip only a known filtered input; this does not signal loss. */
export function skipOrderedAdmission(admission: OrderedAdmission): void {
    if (admission.kind === 'eligible' && admission.lease.pending()) {
        try {
            admission.lease.skip();
        } catch {
            failOrderedAdmission(admission);
        }
    }
}

/** Fail a still-owned lease without disturbing existing WS/v11 propagation. */
export function failOrderedAdmission(admission: OrderedAdmission | null | undefined): void {
    if (admission?.kind === 'eligible' && admission.lease.pending()) {
        try {
            admission.lease.fail();
        } catch {
            /* owner handles its sticky failure */
        }
    }
}

export type OrderedScopePhase = 'context' | 'instance' | 'manager' | 'manager-run' | 'runtime';
type ScopeFrame = {
    readonly phase: OrderedScopePhase;
    readonly event: object;
    readonly admission: OrderedAdmission;
    claimed: boolean;
};
const scopeStacks = new WeakMap<object, ScopeFrame[]>();
const reportedScopeLosses = new WeakSet<object>();

function reportScopeLoss(admission: OrderedAdmission): void {
    if (
        admission.kind !== 'not_eligible' ||
        !admission.reportOnLoss ||
        reportedScopeLosses.has(admission)
    ) {
        return;
    }

    reportedScopeLosses.add(admission);

    // A prepared target is registered with its internal handler before it can be used.
    try {
        scopeLossHandlers.get(admission.target)?.(admission.source);
    } catch {
        /* preserve WS/v11 */
    }
}

// Overflowing nested calls must not claim a matching outer frame.
const overflowDepth = new WeakMap<object, number>();
const maxScopeDepth = 32;

/** Synchronous only: an unclaimed scope is failed before an override's Promise settles. */
export function withOrderedScope<T>(
    key: object,
    phase: OrderedScopePhase,
    event: object,
    admission: OrderedAdmission,
    invoke: () => T,
): T {
    if (admission.kind === 'disabled') {
        return invoke();
    }

    let stack = scopeStacks.get(key);

    if (!stack) {
        stack = [];
        scopeStacks.set(key, stack);
    }

    const overflowing = overflowDepth.get(key) ?? 0;

    if (stack.length >= maxScopeDepth || overflowing > 0) {
        overflowDepth.set(key, overflowing + 1);

        try {
            reportScopeLoss(admission);
            failOrderedAdmission(admission);
            return invoke();
        } finally {
            if (overflowing === 0) {
                overflowDepth.delete(key);
            } else {
                overflowDepth.set(key, overflowing);
            }
        }
    }

    const frame: ScopeFrame = { phase, event, admission, claimed: false };
    stack.push(frame);

    try {
        return invoke();
    } finally {
        stack.pop();

        if (!stack.length) {
            scopeStacks.delete(key);
        }

        if (!frame.claimed) {
            reportScopeLoss(admission);
            failOrderedAdmission(admission);
        }
    }
}

/** Claims only the top matching frame; no event/payload field is inspected. */
export function claimOrderedScope(
    key: object,
    phase: OrderedScopePhase,
    event: object,
): OrderedAdmission | null {
    if (overflowDepth.has(key)) {
        return null;
    }

    const frame = scopeStacks.get(key)?.at(-1);

    if (!frame || frame.phase !== phase || frame.event !== event || frame.claimed) {
        return null;
    }

    frame.claimed = true;
    return frame.admission;
}
