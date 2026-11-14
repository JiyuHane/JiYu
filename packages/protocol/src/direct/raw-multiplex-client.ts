import { addAbortListener } from 'node:events';
import { types as utilTypes } from 'node:util';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawIdentity,
    Sso12RawOptions,
    Sso12RawResult,
} from './sso12-packet-client';

export type RawMultiplexPushRoute = Readonly<{ kind: 'push'; name: string; id: number }>;
export type RawMultiplexRoute =
    | Readonly<{ kind: 'response'; sequence: number }>
    | RawMultiplexPushRoute
    | Readonly<{ kind: 'reject' }>;
export type RawMultiplexIdentity = Readonly<{ uin: string; sequence?: number }>;

export interface RawMultiplexClientOptions {
    uin: string;
    initialSequence?: number;
    defaultTimeoutMs?: number;
    maxFrameBytes: number;
    maxBufferedBytes: number;
    maxFrames: number;
    maxPushFrames: number;
    maxPushBytes: number;
    write(frame: Uint8Array): void | Promise<void>;
    classify(
        frame: Uint8Array,
        identity: RawMultiplexIdentity,
    ): RawMultiplexRoute | Promise<RawMultiplexRoute>;
    /**
     * Synchronously select transactions whose following frames must wait for response
     * verification and consumption. This is caller policy, not authentication; a
     * misclassified response can activate it. A held writer must finish independently
     * of following frame processing. Stage any required state before consume resolves;
     * business-delivery gating and final commit of provisional state belong to the caller.
     */
    holdFollowingFrames?(identity: Sso12RawIdentity): boolean;
    verifyPush(frame: Uint8Array, route: RawMultiplexPushRoute): boolean | Promise<boolean>;
    onPush(frame: Uint8Array, route: RawMultiplexPushRoute): void | Promise<void>;
}

export interface RawMultiplexClient extends Sso12RawClient {
    feed(chunk: Uint8Array): void;
    end(): void;
    readonly closed: boolean;
}

const MAX_FRAME = 16 * 1024 * 1024;
const MAX_TIMER = 0x7fffffff;
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const lengthGetter = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const tagGetter = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const arrayBufferLengthGetter = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const nativeValues = Uint8Array.prototype.values;
const nativeFill = Uint8Array.prototype.fill;
const nativeThen = Promise.prototype.then;

function wipe(bytes: Uint8Array | undefined): void {
    if (bytes) {
        try {
            nativeFill.call(bytes, 0);
        } catch {
            // A recipient may detach its callback copy.
        }
    }
}

function bytesView(value: unknown, max: number): Uint8Array {
    if (
        utilTypes.isProxy(value) ||
        !ArrayBuffer.isView(value) ||
        tagGetter.call(value) !== 'Uint8Array'
    ) {
        throw new Error('invalid bytes');
    }

    nativeValues.call(value);
    const length = lengthGetter.call(value) as number;
    const buffer = bufferGetter.call(value) as ArrayBuffer;
    const offset = offsetGetter.call(value) as number;
    arrayBufferLengthGetter.call(buffer); // Reject shared storage.

    if (length > max) {
        throw new Error('byte limit');
    }

    return new Uint8Array(buffer, offset, length);
}

function dataRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || utilTypes.isProxy(value)) {
        throw new Error('invalid record');
    }

    const proto = Object.getPrototypeOf(value);

    if (proto !== null && proto !== Object.prototype) {
        throw new Error('invalid record');
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string' || !allowed.includes(key) || !('value' in descriptors[key])) {
            throw new Error('invalid record');
        }

        out[key] = descriptors[key].value;
    }

    return out;
}

function uint(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function routeSnapshot(value: unknown): RawMultiplexRoute {
    const r = dataRecord(value, ['kind', 'sequence', 'name', 'id']);
    const keys = Object.keys(r);

    if (r.kind === 'response' && keys.length === 2 && uint(r.sequence, 0, 0xffffffff)) {
        return Object.freeze({ kind: 'response', sequence: r.sequence });
    }

    if (
        r.kind === 'push' &&
        keys.length === 3 &&
        typeof r.name === 'string' &&
        r.name.length > 0 &&
        r.name.length <= 256 &&
        uint(r.id, 0, 0xffffffff)
    ) {
        return Object.freeze({ kind: 'push', name: r.name, id: r.id });
    }

    if (r.kind === 'reject' && keys.length === 1) {
        return Object.freeze({ kind: 'reject' });
    }

    throw new Error('invalid route');
}

type Pending = {
    identity: Sso12RawIdentity;
    deadline: number;
    written: boolean;
    writeDone: boolean;
    responseSeen: boolean;
    holdFollowingFrames: boolean;
    candidate?: Uint8Array;
    responseWorker: boolean;
    hasValue: boolean;
    value: unknown;
    context: unknown;
    verify?: Sso12RawOptions<unknown, unknown>['verifyCandidate'];
    consume?: Sso12RawOptions<unknown, unknown>['consumeCandidate'];
    timer: ReturnType<typeof setTimeout>;
    abort?: ReturnType<typeof addAbortListener>;
    resolve: (result: Sso12RawResult<unknown>) => void;
};
type Incoming = { bytes: Uint8Array; pending?: Pending; written: boolean };
type Push = { bytes: Uint8Array; route: RawMultiplexPushRoute };

/**
 * In-memory framing and policy dispatcher, not a socket or an authenticated session.
 * LagrangeV2 PacketContext reference (7011cdf87368cc0fb77273c1508e779a52328165):
 * https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Context/PacketContext.cs
 * Unlike sequence-only dispatch, every frame requires explicit classification and every
 * push explicit verification. Identity and route fields alone do not authenticate a peer.
 * Callbacks get independent temporary copies; retained aliases and callback side effects
 * cannot be erased or rolled back. Context and result disposal belong to the owner/guard,
 * including values produced after cancellation. Never infer authentication from reentry.
 * Successful settlement means this transaction's build, write, verify, and consume
 * callbacks have finished and will not run again. Independent push callbacks may still
 * run or subsequently close the client; owners must observe whenClosed. A write callback
 * defines its own acceptance/flush semantics and does not establish peer receipt.
 * A response candidate remains bounded and unconsumed until write resolves successfully;
 * push processing continues independently. Long dispatch runs yield to the event loop;
 * deadlines are checked at boundaries and are not hard real-time guarantees.
 */
export function createRawMultiplexClient(options: RawMultiplexClientOptions): RawMultiplexClient {
    const config = dataRecord(options, [
        'uin',
        'initialSequence',
        'defaultTimeoutMs',
        'maxFrameBytes',
        'maxBufferedBytes',
        'maxFrames',
        'maxPushFrames',
        'maxPushBytes',
        'write',
        'classify',
        'holdFollowingFrames',
        'verifyPush',
        'onPush',
    ]);
    const { uin, maxFrameBytes, maxBufferedBytes, maxFrames, maxPushFrames, maxPushBytes } = config;
    const initialSequence = config.initialSequence ?? 1;
    const defaultTimeoutMs = config.defaultTimeoutMs ?? 15000;

    if (
        typeof uin !== 'string' ||
        !/^[0-9]{1,20}$/.test(uin) ||
        !uint(initialSequence, 0, 0xffffffff) ||
        !uint(defaultTimeoutMs, 1, MAX_TIMER) ||
        !uint(maxFrameBytes, 14, MAX_FRAME) ||
        !uint(maxBufferedBytes, 14, MAX_FRAME * 64) ||
        !uint(maxFrames, 1, 65536) ||
        !uint(maxPushFrames, 1, 65536) ||
        !uint(maxPushBytes, 14, MAX_FRAME * 64) ||
        typeof config.write !== 'function' ||
        typeof config.classify !== 'function' ||
        (config.holdFollowingFrames !== undefined &&
            typeof config.holdFollowingFrames !== 'function') ||
        typeof config.verifyPush !== 'function' ||
        typeof config.onPush !== 'function'
    ) {
        throw new Error('invalid multiplex configuration');
    }

    const write = config.write as RawMultiplexClientOptions['write'];
    const classify = config.classify as RawMultiplexClientOptions['classify'];
    const holdFollowingFrames = config.holdFollowingFrames as
        RawMultiplexClientOptions['holdFollowingFrames'] | undefined;
    const verifyPush = config.verifyPush as RawMultiplexClientOptions['verifyPush'];
    const onPush = config.onPush as RawMultiplexClientOptions['onPush'];
    let closed = false;
    let nextSequence = initialSequence;
    let issued = 0;
    let pending: Pending | undefined;
    let resolveClosed!: (reason: Sso12CloseReason) => void;
    const whenClosed = new Promise<Sso12CloseReason>((resolve) => {
        resolveClosed = resolve;
    });
    const prefix = new Uint8Array(4);
    let prefixUsed = 0;
    let partial: Uint8Array | undefined;
    let used = 0;
    let origin: Pending | undefined;
    let originWritten = false;
    let reservedBytes = 0;
    let reservedFrames = 0;
    const incoming: Incoming[] = [];
    let activeIncoming: Incoming | undefined;
    let processing = false;
    let incomingTurns = 0;
    const pushes: Push[] = [];
    let pushFrames = 0;
    let pushBytes = 0;
    let delivering = false;
    let pushTurns = 0;
    const callbackCopies = new Set<Uint8Array>();

    const copyForCallback = (source: Uint8Array): Uint8Array => {
        const copy = Uint8Array.from(source);
        callbackCopies.add(copy);
        return copy;
    };

    const releaseCopy = (copy: Uint8Array): void => {
        wipe(copy);
        callbackCopies.delete(copy);
    };

    const finishPending = (p: Pending): void => {
        clearTimeout(p.timer);

        try {
            p.abort?.[Symbol.dispose]();
        } catch {
            /* best effort */
        }

        p.context = undefined;
        p.verify = undefined;
        p.consume = undefined;
    };

    const shutdown = (kind: Sso12CloseReason['kind'], code: string): void => {
        if (closed) {
            return;
        }

        closed = true;
        wipe(prefix);
        wipe(partial);
        wipe(activeIncoming?.bytes);
        activeIncoming = undefined;
        partial = undefined;

        for (const frame of incoming.splice(0)) {
            wipe(frame.bytes);
        }

        for (const push of pushes.splice(0)) {
            wipe(push.bytes);
        }

        for (const copy of callbackCopies) {
            wipe(copy);
        }

        callbackCopies.clear();
        reservedBytes = 0;
        reservedFrames = 0;
        pushFrames = 0;
        pushBytes = 0;

        if (pending) {
            const p = pending;
            pending = undefined;
            wipe(p.candidate);
            p.candidate = undefined;
            finishPending(p);
            p.value = undefined;
            p.resolve({ kind: 'failure', code, writeState: p.written ? 'unknown' : 'not-written' });
        }

        resolveClosed(Object.freeze({ kind, code }));
    };

    const live = (p: Pending): boolean => {
        if (closed || pending !== p) {
            return false;
        }

        if (performance.now() >= p.deadline) {
            shutdown('local', 'raw-timeout');
            return false;
        }

        return true;
    };

    const currentAlive = (): boolean => !closed && (!pending || live(pending));
    const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    const tryCommit = (): void => {
        const p = pending;

        if (
            !p ||
            !p.hasValue ||
            !p.writeDone ||
            p.responseWorker ||
            p.candidate ||
            processing ||
            incoming.length ||
            partial ||
            prefixUsed ||
            !live(p)
        ) {
            return;
        }

        pending = undefined;
        finishPending(p);
        const value = p.value;
        p.value = undefined;
        p.resolve({
            kind: 'response',
            sequence: p.identity.sequence,
            value,
            writeState: 'written',
        });
    };

    // Budget remains charged to the candidate until this worker completes or shutdown wipes it.
    const runResponse = (p: Pending): void => {
        if (!p.writeDone || p.responseWorker || !p.candidate || !live(p)) {
            return;
        }

        const candidate = p.candidate;
        p.responseWorker = true;

        void (async () => {
            try {
                const verifyCopy = copyForCallback(candidate);
                let accepted: unknown;

                try {
                    if (!live(p)) {
                        return;
                    }

                    accepted = await p.verify!(verifyCopy, p.context, p.identity);
                } finally {
                    releaseCopy(verifyCopy);
                }

                if (!live(p)) {
                    return;
                }

                if (accepted !== true) {
                    shutdown('protocol-error', 'raw-rejected');
                    return;
                }

                const consumeCopy = copyForCallback(candidate);

                try {
                    if (!live(p)) {
                        return;
                    }

                    p.value = await p.consume!(consumeCopy, p.context, p.identity);
                } finally {
                    releaseCopy(consumeCopy);
                }

                if (!live(p)) {
                    p.value = undefined;
                    return;
                }

                p.hasValue = true;
            } catch {
                if (live(p)) {
                    shutdown('handler-error', 'frame-handler-failed');
                }
            } finally {
                if (p.candidate === candidate) {
                    p.candidate = undefined;
                    wipe(candidate);
                    reservedBytes -= candidate.length;
                    reservedFrames--;
                }

                p.responseWorker = false;

                if (p.holdFollowingFrames && p.hasValue && live(p)) {
                    p.holdFollowingFrames = false;
                    pump();
                }

                if (!closed) {
                    tryCommit();
                }
            }
        })();
    };

    const deliver = (): void => {
        if (delivering || closed) {
            return;
        }

        delivering = true;

        void (async () => {
            try {
                while (currentAlive() && pushes.length) {
                    if (++pushTurns >= 32) {
                        pushTurns = 0;
                        await yieldTurn();

                        if (!currentAlive()) {
                            break;
                        }
                    }

                    const push = pushes.shift()!;
                    const copy = copyForCallback(push.bytes);
                    wipe(push.bytes);

                    try {
                        if (!currentAlive()) {
                            break;
                        }

                        const result: unknown = await onPush(copy, push.route);

                        if (!currentAlive()) {
                            break;
                        }

                        if (result !== undefined) {
                            throw new Error('invalid push result');
                        }
                    } finally {
                        releaseCopy(copy);

                        if (!closed) {
                            pushFrames--;
                            pushBytes -= push.bytes.length;
                        }
                    }
                }
            } catch {
                shutdown('handler-error', 'push-handler-failed');
            } finally {
                delivering = false;

                if (!closed && pushes.length) {
                    deliver();
                }
            }
        })();
    };

    const pump = (): void => {
        if (processing || closed || pending?.holdFollowingFrames) {
            return;
        }

        processing = true;

        void (async () => {
            let current: Incoming | undefined;

            try {
                while (currentAlive() && !pending?.holdFollowingFrames && incoming.length) {
                    if (++incomingTurns >= 32) {
                        incomingTurns = 0;
                        await yieldTurn();

                        if (!currentAlive()) {
                            break;
                        }
                    }

                    current = incoming.shift()!;
                    activeIncoming = current;
                    const item = current;
                    const view = copyForCallback(item.bytes);
                    let route: RawMultiplexRoute;

                    try {
                        if (!currentAlive()) {
                            break;
                        }

                        const identity = Object.freeze(
                            item.pending
                                ? { uin, sequence: item.pending.identity.sequence }
                                : { uin },
                        );
                        route = routeSnapshot(await classify(view, identity));
                    } finally {
                        releaseCopy(view);
                    }

                    if (!currentAlive()) {
                        break;
                    }

                    if (route.kind === 'reject') {
                        shutdown('protocol-error', 'frame-rejected');
                        break;
                    }

                    if (route.kind === 'push') {
                        const verifyCopy = copyForCallback(item.bytes);
                        let accepted: unknown;

                        try {
                            if (!currentAlive()) {
                                break;
                            }

                            accepted = await verifyPush(verifyCopy, route);
                        } finally {
                            releaseCopy(verifyCopy);
                        }

                        if (!currentAlive()) {
                            break;
                        }

                        if (accepted !== true) {
                            shutdown('protocol-error', 'push-rejected');
                            break;
                        }

                        if (
                            pushFrames + 1 > maxPushFrames ||
                            pushBytes + item.bytes.length > maxPushBytes
                        ) {
                            shutdown('protocol-error', 'push-capacity');
                            break;
                        }

                        const push = { bytes: Uint8Array.from(item.bytes), route };
                        pushFrames++;
                        pushBytes += push.bytes.length;
                        pushes.push(push);
                        deliver();

                        if (closed || activeIncoming !== current) {
                            break;
                        }
                    } else {
                        const p = item.pending;

                        if (
                            !p ||
                            p !== pending ||
                            !item.written ||
                            route.sequence !== p.identity.sequence ||
                            p.responseSeen ||
                            !live(p)
                        ) {
                            shutdown('protocol-error', 'unexpected-response');
                            break;
                        }

                        p.responseSeen = true;
                        p.candidate = item.bytes;
                        current = undefined;
                        activeIncoming = undefined;

                        if (holdFollowingFrames) {
                            // Reserve the barrier before invoking caller code: it may reenter feed.
                            p.holdFollowingFrames = true;
                            const hold: unknown = holdFollowingFrames(p.identity);

                            // Observe a mistaken native async policy even if it reentrantly
                            // closed, without consulting a potentially overridden `then`.
                            // Promise species and non-native thenables remain caller-owned.
                            if (utilTypes.isPromise(hold)) {
                                void nativeThen.call(hold, undefined, () => {});
                            }

                            if (!live(p) || p.candidate !== item.bytes) {
                                break;
                            }

                            if (typeof hold !== 'boolean') {
                                throw new Error('invalid response barrier result');
                            }

                            p.holdFollowingFrames = hold;
                        }

                        runResponse(p);
                        continue;
                    }

                    wipe(item.bytes);
                    reservedBytes -= item.bytes.length;
                    reservedFrames--;
                    current = undefined;
                    activeIncoming = undefined;
                }
            } catch {
                shutdown('handler-error', 'frame-handler-failed');
            } finally {
                if (current && activeIncoming === current) {
                    wipe(current.bytes);
                }

                activeIncoming = undefined;
                processing = false;

                if (!closed && incoming.length) {
                    pump();
                } else if (!closed) {
                    tryCommit();
                }
            }
        })();
    };

    const client: RawMultiplexClient = {
        get closed() {
            return closed;
        },
        whenClosed,
        close() {
            shutdown('local', 'local-close');
        },
        end() {
            if (closed) {
                return;
            }

            if (partial || prefixUsed) {
                shutdown('protocol-error', 'truncated-stream');
            } else {
                shutdown('remote', 'remote-end');
            }
        },
        feed(input) {
            if (closed) {
                throw new Error('closed');
            }

            try {
                const chunk = bytesView(input, maxBufferedBytes);
                let cursor = 0;

                while (cursor < chunk.length && !closed) {
                    if (!partial) {
                        if (prefixUsed === 0) {
                            origin = pending;
                            originWritten = pending?.written === true;
                        }

                        const n = Math.min(4 - prefixUsed, chunk.length - cursor);
                        prefix.set(chunk.subarray(cursor, cursor + n), prefixUsed);
                        prefixUsed += n;
                        cursor += n;

                        if (prefixUsed < 4) {
                            continue;
                        }

                        const length = new DataView(prefix.buffer).getUint32(0);

                        if (
                            length < 14 ||
                            length > maxFrameBytes ||
                            reservedFrames + 1 > maxFrames ||
                            reservedBytes + length > maxBufferedBytes
                        ) {
                            throw new Error('frame capacity');
                        }

                        partial = new Uint8Array(length);
                        partial.set(prefix);
                        used = 4;
                        prefixUsed = 0;
                        prefix.fill(0);
                        reservedFrames++;
                        reservedBytes += length;
                    }

                    const n = Math.min(partial.length - used, chunk.length - cursor);
                    partial.set(chunk.subarray(cursor, cursor + n), used);
                    used += n;
                    cursor += n;

                    if (used === partial.length) {
                        incoming.push({ bytes: partial, pending: origin, written: originWritten });
                        partial = undefined;
                        origin = undefined;
                        used = 0;
                    }
                }

                pump();
                tryCommit();
            } catch {
                shutdown('protocol-error', 'invalid-stream');
            }
        },
        transactRaw<C, T>(input: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
            const started = performance.now();
            const failed = (code: string): Promise<Sso12RawResult<T>> =>
                Promise.resolve({ kind: 'failure', code, writeState: 'not-written' });

            if (closed) {
                return failed('closed');
            }

            if (pending) {
                return failed('busy');
            }

            if (issued >= 0x100000000) {
                shutdown('local', 'sequence-exhausted');
                return failed('sequence-exhausted');
            }

            let values: Record<string, unknown>;
            let signal: AbortSignal | undefined;
            let timeout: number;

            try {
                values = dataRecord(input, [
                    'buildRequest',
                    'verifyCandidate',
                    'consumeCandidate',
                    'timeoutMs',
                    'signal',
                ]);
                timeout = (values.timeoutMs ?? defaultTimeoutMs) as number;
                signal = values.signal as AbortSignal | undefined;

                if (
                    typeof values.buildRequest !== 'function' ||
                    typeof values.verifyCandidate !== 'function' ||
                    typeof values.consumeCandidate !== 'function' ||
                    !uint(timeout, 1, MAX_TIMER)
                ) {
                    throw new Error('invalid');
                }

                if (signal !== undefined) {
                    if (
                        utilTypes.isProxy(signal) ||
                        Object.getPrototypeOf(signal) !== AbortSignal.prototype ||
                        Object.hasOwn(signal, 'aborted') ||
                        Object.hasOwn(signal, 'addEventListener') ||
                        Object.hasOwn(signal, 'removeEventListener')
                    ) {
                        throw new Error('invalid');
                    }

                    if (abortedGetter.call(signal) === true) {
                        return failed('raw-cancelled');
                    }
                }
            } catch {
                return failed('raw-invalid-options');
            }

            const identity = Object.freeze({ uin, sequence: nextSequence });
            nextSequence = (nextSequence + 1) >>> 0;
            issued++;
            return new Promise<Sso12RawResult<T>>((resolve) => {
                const p: Pending = {
                    identity,
                    deadline: started + timeout,
                    written: false,
                    writeDone: false,
                    responseSeen: false,
                    holdFollowingFrames: false,
                    responseWorker: false,
                    hasValue: false,
                    value: undefined,
                    context: undefined,
                    verify: values.verifyCandidate as Pending['verify'],
                    consume: values.consumeCandidate as Pending['consume'],
                    timer: setTimeout(() => shutdown('local', 'raw-timeout'), timeout),
                    resolve: resolve as (result: Sso12RawResult<unknown>) => void,
                };
                pending = p;

                try {
                    if (signal) {
                        p.abort = addAbortListener(signal, () =>
                            shutdown('local', 'raw-cancelled'),
                        );

                        if (abortedGetter.call(signal) === true) {
                            shutdown('local', 'raw-cancelled');
                        }
                    }
                } catch {
                    shutdown('handler-error', 'raw-signal-failed');
                }

                if (!live(p)) {
                    return;
                }

                void (async () => {
                    let request: Uint8Array | undefined;

                    try {
                        const build = values.buildRequest as Sso12RawOptions<C, T>['buildRequest'];
                        const built = await build(identity);

                        if (!live(p)) {
                            try {
                                wipe(bytesView(built.frame, maxFrameBytes));
                            } catch {
                                /* late producer owns cleanup */
                            }

                            return;
                        }

                        const inputFrame = bytesView(built.frame, maxFrameBytes);
                        request = Uint8Array.from(inputFrame);

                        if (
                            request.length < 14 ||
                            new DataView(request.buffer, request.byteOffset, 4).getUint32(0) !==
                                request.length
                        ) {
                            throw new Error('invalid frame');
                        }

                        p.context = built.context;

                        if (!live(p)) {
                            return;
                        }

                        const writeCopy = copyForCallback(request);
                        wipe(request);
                        request = undefined;

                        try {
                            if (!live(p)) {
                                return;
                            }

                            p.written = true;
                            const result: unknown = await write(writeCopy);

                            if (result !== undefined) {
                                throw new Error('invalid write result');
                            }
                        } finally {
                            releaseCopy(writeCopy);
                        }

                        if (!live(p)) {
                            return;
                        }

                        p.writeDone = true;
                        runResponse(p);
                        tryCommit();
                    } catch {
                        if (live(p)) {
                            shutdown(
                                p.written ? 'transport-error' : 'handler-error',
                                p.written ? 'raw-write-failed' : 'raw-build-failed',
                            );
                        }
                    } finally {
                        wipe(request);
                    }
                })();
            });
        },
    };
    return client;
}
