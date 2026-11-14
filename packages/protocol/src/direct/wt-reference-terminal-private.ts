import { isProxy } from 'node:util/types';
import type { RawSessionLease, RawSessionTerminalAuthority } from './raw-session-broker';

type Operation = 'poll' | 'login-register';
export interface ReferenceTerminalFence {
    beforeClaim(): boolean;
    afterClaim(): boolean;
}
type Slot = {
    lease: RawSessionLease;
    authority: RawSessionTerminalAuthority;
    ownerLive: (operation: Operation) => boolean;
    fence?: ReferenceTerminalFence;
    attempt?: object;
    phase: 'empty' | 'claiming' | 'verified' | 'published' | 'spent';
    operation?: Operation;
    result?: object;
    attemptDeadline?: number;
    transactionDeadline?: number;
};
const ports = new WeakMap<object, Slot>();

export function createReferenceTerminalPort(
    lease: RawSessionLease,
    authority: RawSessionTerminalAuthority,
    ownerLive: (operation: Operation) => boolean,
    fence?: ReferenceTerminalFence,
): object {
    if (!authority || isProxy(authority) || (fence && isProxy(fence))) {
        throw new Error('invalid terminal authority');
    }

    const a = Object.getOwnPropertyDescriptors(authority);
    const f = fence && Object.getOwnPropertyDescriptors(fence);
    const poison = a.poison && 'value' in a.poison ? a.poison.value : undefined;
    const consume = a.consume && 'value' in a.consume ? a.consume.value : undefined;
    const before = f?.beforeClaim && 'value' in f.beforeClaim ? f.beforeClaim.value : undefined;
    const after = f?.afterClaim && 'value' in f.afterClaim ? f.afterClaim.value : undefined;

    if (
        typeof poison !== 'function' ||
        typeof consume !== 'function' ||
        (fence && (typeof before !== 'function' || typeof after !== 'function'))
    ) {
        throw new Error('invalid terminal authority');
    }

    const snapshot: RawSessionTerminalAuthority = {
        poison: (value) => poison.call(authority, value),
        consume: (value, proof) => consume.call(authority, value, proof),
    };
    const gate = fence
        ? {
              beforeClaim: () => before!.call(fence),
              afterClaim: () => after!.call(fence),
          }
        : undefined;
    const port = Object.freeze({});
    ports.set(port, { lease, authority: snapshot, ownerLive, fence: gate, phase: 'empty' });
    return port;
}

export function bindReferenceTerminalAttempt(port: object, attempt: object): void {
    const slot = ports.get(port);

    if (!slot || slot.attempt || slot.phase !== 'empty') {
        throw new Error('invalid terminal binding');
    }

    slot.attempt = attempt;
}

export function cancelReferenceTerminal(port: object): void {
    const slot = ports.get(port);

    if (slot) {
        slot.phase = 'spent';
        slot.result = undefined;
        slot.attempt = undefined;
    }
}

export function claimReferenceTerminal(
    port: object,
    attempt: object,
    operation: Operation,
    result: object,
    attemptDeadline: number,
    transactionDeadline: number,
    attemptLive: () => boolean,
): boolean {
    const slot = ports.get(port);

    if (!slot || slot.phase !== 'empty' || slot.attempt !== attempt) {
        return false;
    }

    slot.phase = 'claiming';
    slot.operation = operation;
    slot.result = result;
    slot.attemptDeadline = attemptDeadline;
    slot.transactionDeadline = transactionDeadline;
    const valid = (): boolean =>
        slot.phase === 'claiming' &&
        slot.attempt === attempt &&
        slot.result === result &&
        slot.operation === operation &&
        attemptLive() &&
        slot.ownerLive(operation) &&
        attemptLive() &&
        slot.phase === 'claiming' &&
        slot.attempt === attempt &&
        slot.result === result;
    let proof: unknown;
    let consumed = false;

    try {
        if (!valid() || (slot.fence && slot.fence.beforeClaim() !== true) || !valid()) {
            return false;
        }

        proof = slot.authority.poison(slot.lease);

        if (!proof) {
            return false;
        }

        // Consume immediately, even if poison synchronously caused close or abort.
        const claimed = proof;
        proof = undefined;
        consumed = slot.authority.consume(slot.lease, claimed);

        if (!consumed || !valid() || (slot.fence && slot.fence.afterClaim() !== true) || !valid()) {
            return false;
        }

        slot.phase = 'verified';
        return true;
    } catch {
        return false;
    } finally {
        if (proof) {
            try {
                slot.authority.consume(slot.lease, proof);
            } catch {
                /* burn best effort */
            }
        }

        if (slot.phase === 'claiming') {
            cancelReferenceTerminal(port);
        }
    }
}

export function publishReferenceTerminal(
    port: object,
    attempt: object,
    operation: Operation,
    result: object,
    attemptLive: () => boolean,
): boolean {
    const slot = ports.get(port);

    try {
        if (
            !slot ||
            slot.phase !== 'verified' ||
            slot.attempt !== attempt ||
            slot.operation !== operation ||
            slot.result !== result ||
            !attemptLive() ||
            !slot.ownerLive(operation) ||
            (slot.fence && slot.fence.afterClaim() !== true) ||
            slot.phase !== 'verified' ||
            slot.attempt !== attempt ||
            !attemptLive() ||
            !slot.ownerLive(operation)
        ) {
            cancelReferenceTerminal(port);
            return false;
        }

        slot.phase = 'published';
        return true;
    } catch {
        cancelReferenceTerminal(port);
        return false;
    }
}

export function hasReferenceTerminal(port: object, attempt?: object): boolean {
    const slot = ports.get(port);
    return (
        !!slot && slot.phase === 'published' && (attempt === undefined || slot.attempt === attempt)
    );
}

export function takeReferenceTerminal(
    port: object,
    attempt: object,
    operation: Operation,
    result: object,
): { attemptDeadline: number; transactionDeadline: number; afterClaim: () => boolean } | undefined {
    const slot = ports.get(port);

    if (!slot) {
        return undefined;
    }

    const match =
        slot.phase === 'published' &&
        slot.attempt === attempt &&
        slot.operation === operation &&
        slot.result === result &&
        slot.attemptDeadline !== undefined &&
        slot.transactionDeadline !== undefined;
    const receipt = match
        ? {
              attemptDeadline: slot.attemptDeadline!,
              transactionDeadline: slot.transactionDeadline!,
              afterClaim: () => (slot.fence ? slot.fence.afterClaim() === true : true),
          }
        : undefined;
    cancelReferenceTerminal(port);
    return receipt;
}
