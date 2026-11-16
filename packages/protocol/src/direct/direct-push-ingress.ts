import { types as utilTypes } from 'node:util';
import type { QQEventVariant } from '../events';
import type { IdentityService } from '../identity-service';
import { MSG_PUSH_CMD, parseDirectMsgPushOrThrow, SysMsgDedup } from '../msg-push';
import type { IncomingPacketPipeline } from '../packet-pipeline';

export interface DirectPushMeta {
    readonly uin: string;
    readonly sequence: number;
    readonly command: string;
    readonly retCode: number;
}

export type DirectIngressResult =
    | { kind: 'settled'; events: number }
    | { kind: 'empty' }
    | {
          kind: 'rejected';
          reason: 'not-active' | 'stopped' | 'capacity' | 'invalid' | 'identity-changed';
      }
    | { kind: 'failed'; reason: 'parse' | 'clone' | 'pipeline' | 'initialization' };

export interface DirectPushIngressOptions {
    uin: string;
    identity: IdentityService;
    pipeline: IncomingPacketPipeline;
    /** Caller assertion: this exact pipeline was constructed with this exact identity. */
    pipelineIdentityBound: true;
    /** Caller assertion: source authentication is handled outside this ingress. */
    sourceAuthenticationHandled: true;
    maxBodyBytes: number;
    maxPendingBytes: number;
    maxPending: number;
    maxEventsPerPush: number;
}

export interface DirectPushIngress {
    activate(): boolean;
    submit(body: Uint8Array, meta: DirectPushMeta): Promise<DirectIngressResult>;
    stop(): void;
    /** Only valid after stop; waits for admitted pipeline work, not subscribers. */
    drain(): Promise<void>;
}

const isProxy = utilTypes.isProxy;
const isUint8Array = utilTypes.isUint8Array;
const isPromise = utilTypes.isPromise;
const getPrototypeOf = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const ownKeys = Reflect.ownKeys;
const apply = Reflect.apply;
const plainPrototype = Object.prototype;
const typedPrototype = getPrototypeOf(Uint8Array.prototype) as object;
const byteBuffer = getDescriptor(typedPrototype, 'buffer')!.get!;
const byteOffset = getDescriptor(typedPrototype, 'byteOffset')!.get!;
const byteLength = getDescriptor(typedPrototype, 'byteLength')!.get!;
const bufferLength = getDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const bufferResizable = getDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const values = Uint8Array.prototype.values;
const setBytes = Uint8Array.prototype.set;
const fillBytes = Uint8Array.prototype.fill;
const Bytes = Uint8Array;
const clone = globalThis.structuredClone;
const promiseThen = Promise.prototype.then;
const keys = ['uin', 'sequence', 'command', 'retCode'] as const;

function positiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function snapshotMeta(value: unknown, uin: string): DirectPushMeta | null {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        return null;
    }

    const proto = getPrototypeOf(value);

    if (proto !== plainPrototype && proto !== null) {
        return null;
    }

    const names = ownKeys(value);

    if (
        names.length !== keys.length ||
        names.some(
            (name) => typeof name !== 'string' || !keys.includes(name as (typeof keys)[number]),
        )
    ) {
        return null;
    }

    const fields: unknown[] = [];

    for (const key of keys) {
        const descriptor = getDescriptor(value, key);

        if (!descriptor || !('value' in descriptor)) {
            return null;
        }

        fields.push(descriptor.value);
    }

    const [account, sequence, command, retCode] = fields;

    if (
        account !== uin ||
        typeof sequence !== 'number' ||
        !Number.isInteger(sequence) ||
        sequence < 0 ||
        sequence > 0xffffffff ||
        command !== MSG_PUSH_CMD ||
        retCode !== 0
    ) {
        return null;
    }

    return { uin, sequence, command, retCode };
}

function bodyView(value: unknown): Uint8Array {
    if (isProxy(value) || !isUint8Array(value)) {
        throw new TypeError('invalid body');
    }

    apply(values, value, []); // Reject detached or out-of-bounds views, including empty ones.
    const buffer = apply(byteBuffer, value, []) as ArrayBuffer;
    apply(bufferLength, buffer, []); // ArrayBuffer brand check rejects shared storage.

    if (bufferResizable && apply(bufferResizable, buffer, [])) {
        throw new TypeError('invalid body storage');
    }

    const offset = apply(byteOffset, value, []) as number;
    const length = apply(byteLength, value, []) as number;
    return new Bytes(buffer, offset, length);
}

function wipe(body: Uint8Array): void {
    try {
        apply(fillBytes, body, [0]);
    } catch {
        // A synchronous event getter may have detached the backing store.
    }
}

type Item = {
    body: Uint8Array;
    bytes: number;
    meta: DirectPushMeta;
    resolve: (result: DirectIngressResult) => void;
    phase: 'queued' | 'working' | 'pipeline';
};

/**
 * Narrow opt-in adapter for decrypted direct push bodies; it is not wired into
 * production Direct/Bridge. Activation is caller permission, not proof of peer,
 * online state, registration, wire interoperability or delivery. The two explicit
 * assertions are caller obligations: pipeline does not expose its identity.
 * Each instance owns one dedup for exactly this account/session; create a new
 * ingress for another session. The identity, its initialization promise, and the
 * pipeline method/receiver are bound at construction, never looked up in options again.
 *
 * Bodies are privately copied synchronously before dependency callbacks or awaits.
 * Limits include queued and in-flight input copies, including initialization and
 * pipeline waits; they do not bound parser allocations, total RSS or subscribers.
 * Event count is checked after parsing; excess is failed/parse without dispatch.
 * Parser identity/dedup side effects may already exist on any subsequent failure;
 * no rollback or automatic retry is performed. Empty only means parser returned no
 * events and does not distinguish dedup, unsupported messages and filtering.
 * Structured cloning isolates body aliases before wiping, and only current cloneable
 * event data is supported; prototypes and Buffer representation can change. This
 * adapter does not log data or expose errors, but existing parser/identity/pipeline
 * logging may contain sensitive data. The raw-multiplex callback adapter must consume
 * the submit result and return undefined rather than forwarding that result.
 * Pipeline settlement is not subscriber or network
 * delivery; its implementation may swallow failures. Async subscribers and detached
 * roster tasks are outside drain. `settled` reports only pipeline promise settlement,
 * not successful handling or delivery. stop wipes/discards pre-pipeline work
 * synchronously; already-entered pipeline work may continue dispatching after stop.
 * If initialization never settles, the worker and drain can remain pending even after
 * stop. Dependencies awaited by this pipeline must not await another submission to
 * this same FIFO or its drain: either can wait on the current pipeline work itself.
 * Identity, pipeline and ordinary Promise internals, including constructor and
 * species, are caller trust assumptions; they are not an adversarial isolation boundary.
 */
export function createDirectPushIngress(options: DirectPushIngressOptions): DirectPushIngress {
    const { uin, identity, pipeline, maxBodyBytes, maxPendingBytes, maxPending, maxEventsPerPush } =
        options;

    if (
        typeof uin !== 'string' ||
        !/^[1-9][0-9]{0,9}$/.test(uin) ||
        Number(uin) > 0xffffffff ||
        options.pipelineIdentityBound !== true ||
        options.sourceAuthenticationHandled !== true ||
        !positiveInteger(maxBodyBytes) ||
        !positiveInteger(maxPendingBytes) ||
        !positiveInteger(maxPending) ||
        !positiveInteger(maxEventsPerPush) ||
        !identity ||
        !pipeline ||
        identity.uin !== uin
    ) {
        throw new TypeError('invalid direct ingress options');
    }

    const processEvents = pipeline.processDecodedDirectEvents;
    const initialization = identity.initialization;

    if (typeof processEvents !== 'function' || !isPromise(initialization)) {
        throw new TypeError('invalid direct ingress options');
    }

    // Observe rejection immediately, even if no submissions ever arrive.
    const initialized = apply(promiseThen, initialization, [
        () => true,
        () => false,
    ]) as Promise<boolean>;
    const dedup = new SysMsgDedup();
    let state: 'disabled' | 'active' | 'stopped' = 'disabled';
    let pending = 0;
    let pendingBytes = 0;
    let admitting = false;
    let running = false;
    let current: Item | undefined;
    const queue: Item[] = [];
    let drainPromise: Promise<void> | undefined;
    let resolveDrain: (() => void) | undefined;

    function release(bytes: number): void {
        pending--;
        pendingBytes -= bytes;

        if (state === 'stopped' && pending === 0 && resolveDrain) {
            const resolve = resolveDrain;
            resolveDrain = undefined;
            resolve();
        }
    }

    function sameIdentity(): boolean {
        try {
            return identity.uin === uin;
        } catch {
            return false;
        }
    }

    async function handle(item: Item): Promise<DirectIngressResult> {
        item.phase = 'working';
        let ok: boolean;

        try {
            ok = await initialized;
        } catch {
            ok = false;
        }

        if (state !== 'active') {
            return { kind: 'rejected', reason: 'stopped' };
        }

        if (!ok) {
            return { kind: 'failed', reason: 'initialization' };
        }

        if (!sameIdentity()) {
            return { kind: 'rejected', reason: 'identity-changed' };
        }

        if (state !== 'active') {
            return { kind: 'rejected', reason: 'stopped' };
        }

        let events: QQEventVariant[];

        try {
            events = parseDirectMsgPushOrThrow({ ...item.meta, body: item.body }, identity, dedup);
        } catch {
            return state === 'active'
                ? { kind: 'failed', reason: 'parse' }
                : { kind: 'rejected', reason: 'stopped' };
        }

        if (state !== 'active') {
            return { kind: 'rejected', reason: 'stopped' };
        }

        if (events.length > maxEventsPerPush) {
            return { kind: 'failed', reason: 'parse' };
        }

        if (events.length === 0) {
            return { kind: 'empty' };
        }

        const count = events.length;
        let detached: QQEventVariant[];

        try {
            detached = clone(events);
        } catch {
            return state === 'active'
                ? { kind: 'failed', reason: 'clone' }
                : { kind: 'rejected', reason: 'stopped' };
        }

        if (state !== 'active') {
            return { kind: 'rejected', reason: 'stopped' };
        }

        wipe(item.body);

        if (!sameIdentity()) {
            return { kind: 'rejected', reason: 'identity-changed' };
        }

        if (state !== 'active') {
            return { kind: 'rejected', reason: 'stopped' };
        }

        item.phase = 'pipeline';

        try {
            await apply(processEvents, pipeline, [
                { serviceCmd: item.meta.command, seqId: item.meta.sequence },
                detached,
            ]);
            return { kind: 'settled', events: count };
        } catch {
            return { kind: 'failed', reason: 'pipeline' };
        }
    }

    async function work(): Promise<void> {
        try {
            while (state === 'active' && queue.length > 0) {
                const item = queue.shift()!;
                current = item;
                let result: DirectIngressResult;

                try {
                    result = await handle(item);
                } catch {
                    result = { kind: 'failed', reason: 'pipeline' };
                }

                wipe(item.body);
                current = undefined;
                // Settle the submission before signaling drain waiters.
                item.resolve(result);
                release(item.bytes);
            }
        } finally {
            running = false;
        }
    }

    function start(): void {
        if (!running && state === 'active' && queue.length > 0) {
            running = true;
            // Set running before the microtask to prevent synchronous reentry.
            void Promise.resolve().then(work);
        }
    }

    return {
        activate(): boolean {
            if (state !== 'disabled') {
                return false;
            }

            state = 'active';
            return true;
        },
        submit(body, meta): Promise<DirectIngressResult> {
            if (state !== 'active') {
                return Promise.resolve({
                    kind: 'rejected',
                    reason: state === 'stopped' ? 'stopped' : 'not-active',
                });
            }

            if (admitting) {
                return Promise.resolve({ kind: 'rejected', reason: 'capacity' });
            }

            let snapshot: DirectPushMeta | null;
            let view: Uint8Array;

            try {
                snapshot = snapshotMeta(meta, uin);
                view = bodyView(body);
            } catch {
                return Promise.resolve({ kind: 'rejected', reason: 'invalid' });
            }

            const size = apply(byteLength, view, []) as number;

            if (!snapshot || size > maxBodyBytes) {
                return Promise.resolve({ kind: 'rejected', reason: 'invalid' });
            }

            if (pending >= maxPending || size > maxPendingBytes - pendingBytes) {
                return Promise.resolve({ kind: 'rejected', reason: 'capacity' });
            }

            pending++;
            pendingBytes += size;
            let copy: Uint8Array;

            try {
                copy = new Bytes(size);
                apply(setBytes, copy, [view]);
            } catch {
                release(size);
                return Promise.resolve({ kind: 'failed', reason: 'clone' });
            }

            admitting = true;
            let matches: boolean;

            try {
                matches = sameIdentity();
            } finally {
                admitting = false;
            }

            if (state !== 'active' || !matches) {
                wipe(copy);
                release(size);
                return Promise.resolve(
                    state !== 'active'
                        ? { kind: 'rejected', reason: 'stopped' }
                        : { kind: 'rejected', reason: 'identity-changed' },
                );
            }

            return new Promise((resolve) => {
                queue.push({ body: copy, bytes: size, meta: snapshot!, resolve, phase: 'queued' });
                start();
            });
        },
        stop(): void {
            if (state === 'stopped') {
                return;
            }

            state = 'stopped';

            if (current && current.phase !== 'pipeline') {
                wipe(current.body);
            }

            for (const item of queue.splice(0)) {
                wipe(item.body);
                item.resolve({ kind: 'rejected', reason: 'stopped' });
                release(item.bytes);
            }
        },
        drain(): Promise<void> {
            if (state !== 'stopped') {
                return Promise.reject(new Error('stop ingress before drain'));
            }

            if (pending === 0) {
                return Promise.resolve();
            }

            if (!drainPromise) {
                drainPromise = new Promise<void>((resolve) => {
                    resolveDrain = resolve;
                });
            }

            return drainPromise;
        },
    };
}
