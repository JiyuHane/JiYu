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
