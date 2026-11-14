import { isPromise, isProxy } from 'node:util/types';

/** Internal ordering primitive. An explicitly prepared fixture path can connect it
 * to pipeline admission and an injected HTTP capability; production does not enable it.
 * The host owns source/epoch verification and must install it before declaring ready.
 * Ordering means admission order, not QQ occurrence time or OneBot event.time.
 * Encoded byte budgets do not bound RSS, allocation during ownKeys, or CPU time.
 * The trusted clock is monotonic; scheduled callbacks must never run inline.
 * All host callbacks, including timer clearing, must be synchronous. Promise detection
 * assumes untampered built-ins, constructor and species; arbitrary thenables or hostile
 * same-process Promise implementations are outside this contract. Timers are not real-time.
 */
export type IngressFailure =
    | 'parent_capacity'
    | 'child_capacity'
    | 'parent_child_capacity'
    | 'bytes'
    | 'invalid_event'
    | 'event_too_large'
    | 'late_candidate'
    | 'expired'
    | 'child_failed'
    | 'sink_full'
    | 'sink_error'
    | 'clock_error'
    | 'scheduler_error'
    | 'sequence_exhausted';
export type IngressState = 'active' | 'degraded' | 'retired';
export interface IngressLimits {
    maxParents: number;
    maxChildren: number;
    maxChildrenPerParent: number;
    maxBytes: number;
    maxEventBytes: number;
    deadlineMs: number;
    maxFlushWork: number;
    /** Test seam; production defaults to zero. */
    initialSequence?: number;
}
export interface IngressScheduler {
    timer(callback: () => void, delayMs: number): unknown;
    clearTimer(handle: unknown): void;
    immediate(callback: () => void): unknown;
    clearImmediate(handle: unknown): void;
}
export interface IngressHost {
    now(): number;
    scheduler: IngressScheduler;
    /** Receives immutable validated JSON. The host must enqueue at most once. */
    deliver(json: string): 'accepted' | 'full';
    /** Trusted synchronous notification after state is frozen; async observers are unsupported. */
    onDegrade(reason: IngressFailure): void;
}
export interface IngressChild {
    resolve(event: unknown): boolean;
    skip(): boolean;
    fail(): boolean;
}
export interface IngressParent {
    child(): IngressChild | null;
    seal(): boolean;
}
type Child = {
    state: 'pending' | 'ready' | 'skip' | 'delivering' | 'done';
    json?: string;
    bytes: number;
};
type Parent = { seq: number; deadline: number; sealed: boolean; children: Child[]; cursor: number };
type Scheduled = { handle: unknown; ready: boolean; canceled: boolean };

const maximum = {
    maxParents: 128,
    maxChildren: 256,
    maxChildrenPerParent: 32,
    maxBytes: 256 * 1024,
    maxEventBytes: 64 * 1024,
    deadlineMs: 60_000,
    maxFlushWork: 32,
} as const;
const tooLarge = Symbol('too large');

/** A data-descriptor-only copy: getters, proxies, sparse arrays and toJSON do not run. */
function snapshot(
    input: unknown,
    maxBytes: number,
): { json: string; bytes: number } | 'invalid' | 'large' {
    let nodes = 0;
    let textBytes = 0;
    const ancestors = new WeakSet<object>();

    const text = (value: string) => {
        if (value.length > maxBytes || (textBytes += Buffer.byteLength(value, 'utf8')) > maxBytes) {
            throw tooLarge;
        }
    };

    const visit = (value: unknown, depth: number): unknown => {
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
            throw new Error('invalid');
        }

        const array = Array.isArray(value);
        const proto = Object.getPrototypeOf(value);

        if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
            throw new Error('invalid');
        }

        const keys = Reflect.ownKeys(value);

        if (keys.length > 8193) {
            throw tooLarge;
        }

        const length = array ? Object.getOwnPropertyDescriptor(value, 'length')?.value : 0;

        if (array && (!Number.isSafeInteger(length) || length < 0 || length > 8192)) {
            throw tooLarge;
        }

        const out: unknown[] | Record<string, unknown> = array
            ? Object.setPrototypeOf(new Array(length), null)
            : Object.create(null);
        ancestors.add(value);
        let count = 0;

        for (const key of keys) {
            if (typeof key !== 'string') {
                throw new Error('invalid');
            }

            if (array && key === 'length') {
                continue;
            }

            if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) {
                throw new Error('invalid');
            }

            if (!array) {
                text(key);
            }

            const descriptor = Object.getOwnPropertyDescriptor(value, key);

            if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
                throw new Error('invalid');
            }

            Object.defineProperty(out, key, {
                value: visit(descriptor.value, depth + 1),
                enumerable: true,
                writable: true,
                configurable: true,
            });
            count++;
        }

        if (array && count !== length) {
            throw new Error('invalid');
        }

        ancestors.delete(value);
        return out;
    };

    try {
        if (typeof input !== 'object' || input === null || Array.isArray(input) || isProxy(input)) {
            return 'invalid';
        }

        const value = visit(input, 0) as Record<string, unknown>;

        if (typeof value.type !== 'string' || value.type.length === 0 || value.type === 'meta') {
            return 'invalid';
        }

        const json = JSON.stringify(value);
        const bytes = Buffer.byteLength(json, 'utf8');
        return bytes > maxBytes ? 'large' : { json, bytes };
    } catch (error) {
        return error === tooLarge ? 'large' : 'invalid';
    }
}

export class IngressSequencer {
    private state: IngressState = 'active';
    private reason: IngressFailure | null = null;
    private parents: Parent[] = [];
    private children = 0;
    private bytes = 0;
    private nextSequence: number;
    private lastNow = -Infinity;
    private timer: Scheduled | null = null;
    private immediate: Scheduled | null = null;
    private flushing = false;
    private checkingClock = false;
    private lostOnRetire = 0;
    private abandonedOnDegrade = 0;
    private notificationFailed = false;
    private cleanupUncertain = false;
    private notified = false;
    private readonly limits: Required<IngressLimits>;

    constructor(
        limits: IngressLimits,
        private readonly host: IngressHost,
    ) {
        for (const key of Object.keys(maximum) as Array<keyof typeof maximum>) {
            if (
                !Number.isSafeInteger(limits[key]) ||
                limits[key] < 1 ||
                limits[key] > maximum[key]
            ) {
                throw new RangeError(`invalid ${key}`);
            }
        }

        const initialSequence = limits.initialSequence ?? 0;

        if (
            !Number.isSafeInteger(initialSequence) ||
            initialSequence < 0 ||
            limits.maxEventBytes > limits.maxBytes ||
            limits.maxChildrenPerParent > limits.maxChildren
        ) {
            throw new RangeError('invalid ingress limits');
        }

        this.limits = { ...limits, initialSequence };
        this.nextSequence = initialSequence;
    }

    stats(): Readonly<{
        state: IngressState;
        reason: IngressFailure | null;
        parents: number;
        children: number;
        bytes: number;
        pendingHead: boolean;
        lostOnRetire: number;
        abandonedOnDegrade: number;
        notificationFailed: boolean;
        cleanupUncertain: boolean;
    }> {
        if (this.state === 'active') {
            this.check();
        }

        return {
            state: this.state,
            reason: this.reason,
            parents: this.parents.length,
            children: this.children,
            bytes: this.bytes,
            pendingHead: this.parents.length > 0,
            lostOnRetire: this.lostOnRetire,
            abandonedOnDegrade: this.abandonedOnDegrade,
            notificationFailed: this.notificationFailed,
            cleanupUncertain: this.cleanupUncertain,
        };
    }

    admit(): IngressParent | null {
        if (!this.check()) {
            return null;
        }

        if (this.parents.length >= this.limits.maxParents) {
            return this.degrade('parent_capacity');
        }

        if (this.nextSequence >= Number.MAX_SAFE_INTEGER) {
            return this.degrade('sequence_exhausted');
        }

        const parent: Parent = {
            seq: this.nextSequence++,
            deadline: this.lastNow + this.limits.deadlineMs,
            sealed: false,
            children: [],
            cursor: 0,
        };

        if (!Number.isFinite(parent.deadline)) {
            return this.degrade('clock_error');
        }

        this.parents.push(parent);

        if (!this.armTimer()) {
            return null;
        }

        return Object.freeze({ child: () => this.child(parent), seal: () => this.seal(parent) });
    }

    private child(parent: Parent): IngressChild | null {
        if (!this.check() || !this.parents.includes(parent) || parent.sealed) {
            return null;
        }

        if (parent.children.length >= this.limits.maxChildrenPerParent) {
            return this.degrade('parent_child_capacity');
        }

        if (this.children >= this.limits.maxChildren) {
            return this.degrade('child_capacity');
        }

        const child: Child = { state: 'pending', bytes: 0 };
        parent.children.push(child);
        this.children++;
        return Object.freeze({
            resolve: (event: unknown) => this.resolve(parent, child, event),
            skip: () => this.terminal(parent, child, false),
            fail: () => this.terminal(parent, child, true),
        });
    }

    private seal(parent: Parent): boolean {
        if (!this.check() || !this.parents.includes(parent) || parent.sealed) {
            return false;
        }

        parent.sealed = true;
        this.scheduleFlush();
        return this.state === 'active';
    }

    private resolve(parent: Parent, child: Child, event: unknown): boolean {
        if (!this.check()) {
            return false;
        }

        if (!this.parents.includes(parent) || child.state !== 'pending') {
            this.degrade('late_candidate');
            return false;
        }

        const result = snapshot(event, this.limits.maxEventBytes);

        if (!this.check() || !this.parents.includes(parent) || child.state !== 'pending') {
            return false;
        }

        if (result === 'invalid') {
            return this.degrade('invalid_event') !== null;
        }

        if (result === 'large') {
            return this.degrade('event_too_large') !== null;
        }

        if (this.bytes + result.bytes > this.limits.maxBytes) {
            return this.degrade('bytes') !== null;
        }

        child.json = result.json;
        child.bytes = result.bytes;
        child.state = 'ready';
        this.bytes += result.bytes;
        this.scheduleFlush();
        return this.state === 'active';
    }

    private terminal(parent: Parent, child: Child, failed: boolean): boolean {
        if (!this.check() || !this.parents.includes(parent) || child.state !== 'pending') {
            return false;
        }

        if (failed) {
            this.degrade('child_failed');
            return true;
        }

        child.state = 'skip';
        this.scheduleFlush();
        return this.state === 'active';
    }

    private check(): boolean {
        if (this.state !== 'active') {
            return false;
        }

        if (this.checkingClock) {
            this.degrade('clock_error');
            return false;
        }

        let now: number;
        this.checkingClock = true;

        try {
            now = this.host.now();
        } catch {
            this.degrade('clock_error');
            return false;
        } finally {
            this.checkingClock = false;
        }

        if (this.state !== 'active') {
            return false;
        }

        if (!Number.isFinite(now) || now < this.lastNow) {
            this.degrade('clock_error');
            return false;
        }

        this.lastNow = now;

        if (this.parents.some((parent) => this.hasOutstanding(parent) && now >= parent.deadline)) {
            this.degrade('expired');
            return false;
        }

        return true;
    }

    private hasOutstanding(parent: Parent): boolean {
        return (
            !parent.sealed ||
            parent.children
                .slice(parent.cursor)
                .some(
                    (child) =>
                        child.state === 'pending' ||
                        child.state === 'ready' ||
                        child.state === 'delivering',
                )
        );
    }

    private scheduleFlush(): void {
        if (this.state !== 'active' || this.flushing || this.immediate !== null) {
            return;
        }

        const slot: Scheduled = { handle: undefined, ready: false, canceled: false };
        this.immediate = slot;

        try {
            const handle = this.host.scheduler.immediate(() => {
                if (this.immediate !== slot) {
                    return;
                }

                this.immediate = null;
                this.flush();
            });

            if (isPromise(handle)) {
                void Promise.prototype.then.call(handle, undefined, () => undefined);
                this.cleanupFailed();
                return;
            }

            slot.handle = handle;
            slot.ready = true;

            if (slot.canceled) {
                this.clearSlot('immediate', slot);
            }
        } catch {
            this.cleanupFailed();
        }
    }

    private armTimer(): boolean {
        if (this.state !== 'active' || this.timer !== null || !this.parents.length) {
            return this.state === 'active';
        }

        const next = this.parents.find((parent) => this.hasOutstanding(parent));

        if (!next) {
            return true;
        }

        const slot: Scheduled = { handle: undefined, ready: false, canceled: false };
        this.timer = slot;

        try {
            const handle = this.host.scheduler.timer(
                () => {
                    if (this.timer !== slot) {
                        return;
                    }

                    this.timer = null;

                    if (this.check()) {
                        this.armTimer();
                    }
                },
                Math.max(0, Math.ceil(next.deadline - this.lastNow)),
            );

            if (isPromise(handle)) {
                void Promise.prototype.then.call(handle, undefined, () => undefined);
                this.cleanupFailed();
                return false;
            }

            slot.handle = handle;
            slot.ready = true;

            if (slot.canceled) {
                this.clearSlot('timer', slot);
            }

            return this.state === 'active';
        } catch {
            this.cleanupFailed();
            return false;
        }
    }

    private flush(): void {
        if (this.flushing || !this.check()) {
            return;
        }

        this.flushing = true;
        let work = 0;

        try {
            while (work < this.limits.maxFlushWork && this.check() && this.parents.length) {
                const parent = this.parents[0];

                if (!parent.sealed || parent.children.some((child) => child.state === 'pending')) {
                    break;
                }

                const child = parent.children[parent.cursor];

                if (!child) {
                    this.parents.shift();
                    work++;
                    continue;
                }

                if (child.state === 'ready') {
                    child.state = 'delivering';
                    let result: unknown;

                    try {
                        result = this.host.deliver(child.json!);

                        if (isPromise(result)) {
                            void Promise.prototype.then.call(result, undefined, () => undefined);
                        }
                    } catch {
                        this.degrade('sink_error');
                        break;
                    }

                    if (this.state !== 'active') {
                        break;
                    }

                    if (result !== 'accepted') {
                        this.degrade(result === 'full' ? 'sink_full' : 'sink_error');
                        break;
                    }

                    if (!this.check()) {
                        break;
                    }

                    this.bytes -= child.bytes;
                    child.json = undefined;
                }

                child.state = 'done';
                this.children--;
                parent.cursor++;
                work++;
            }
        } finally {
            this.flushing = false;
        }

        if (this.state !== 'active') {
            return;
        }

        if (work >= this.limits.maxFlushWork && this.parents.length) {
            this.scheduleFlush();
        }

        if (!this.parents.length && this.timer !== null) {
            const old = this.timer;
            this.timer = null;
            this.clearSlot('timer', old);
        }

        if (this.state === 'active') {
            this.armTimer();
        }
    }

    private degrade(reason: IngressFailure): null {
        if (this.state !== 'active') {
            return null;
        }

        this.state = 'degraded';
        this.reason = reason;
        this.abandonedOnDegrade = this.discard();

        this.notify(reason);
        this.clearScheduled();
        return null;
    }

    private notify(reason: IngressFailure): void {
        if (this.notified) {
            return;
        }

        this.notified = true;

        try {
            const result: unknown = this.host.onDegrade(reason);

            if (isPromise(result)) {
                this.notificationFailed = true;
                void Promise.prototype.then.call(result, undefined, () => undefined);
            }
        } catch {
            this.notificationFailed = true;
        }
    }

    private cleanupFailed(): void {
        this.cleanupUncertain = true;

        if (this.state === 'active') {
            this.degrade('scheduler_error');
        } else if (this.state === 'retired' && this.reason === null) {
            this.reason = 'scheduler_error';
            this.notify('scheduler_error');
        }
    }

    private clearSlot(kind: 'timer' | 'immediate', slot: Scheduled): void {
        slot.canceled = true;

        if (!slot.ready) {
            return;
        }

        try {
            const result: unknown =
                kind === 'timer'
                    ? this.host.scheduler.clearTimer(slot.handle)
                    : this.host.scheduler.clearImmediate(slot.handle);

            if (isPromise(result)) {
                void Promise.prototype.then.call(result, undefined, () => undefined);
                this.cleanupFailed();
            }
        } catch {
            this.cleanupFailed();
        }
    }

    /** Counts open parents and undelivered children, not known lost event count. */
    private discard(): number {
        let count = 0;

        for (const parent of this.parents) {
            if (!parent.sealed) {
                count++;
            }

            for (const child of parent.children.slice(parent.cursor)) {
                if (
                    child.state === 'pending' ||
                    child.state === 'ready' ||
                    child.state === 'delivering'
                ) {
                    count++;
                }
            }

            for (const child of parent.children) {
                child.json = undefined;
            }

            parent.children.length = 0;
        }

        this.parents = [];
        this.children = 0;
        this.bytes = 0;
        return count;
    }

    private clearScheduled(): void {
        const timer = this.timer;
        const immediate = this.immediate;
        this.timer = null;
        this.immediate = null;

        if (timer !== null) {
            this.clearSlot('timer', timer);
        }

        if (immediate !== null) {
            this.clearSlot('immediate', immediate);
        }
    }

    /** Retiring an active epoch abandons unresolved or ready entries; returns their count. */
    retire(): number {
        if (this.state === 'retired') {
            return this.lostOnRetire;
        }

        if (this.state === 'active') {
            this.check();
        }

        if (this.state === 'active') {
            this.lostOnRetire = this.discard();
        }

        this.state = 'retired';
        this.clearScheduled();
        return this.lostOnRetire;
    }
}
