import { isPromise, isProxy } from 'node:util/types';
import { MSG_PUSH_CMD } from '../msg-push';
import {
    createGuardedDirectPushIngress,
    type DirectPushIngressOptions,
    type DirectPushMeta,
} from './direct-push-ingress';
import {
    classifyLinuxEasyOwnerD2Candidate,
    extractLinuxEasyOwnerPushBody,
    isLinuxEasyOwnerPushActive,
    type LinuxEasyAccountOwner,
} from './linux-easy-account-owner';
import { createLinuxEasyPushQueue, type LinuxEasyPushQueueOptions } from './linux-easy-push-queue';

export interface LinuxEasyPushProcessorOptions {
    readonly owner: LinuxEasyAccountOwner;
    readonly uin: string;
    readonly ingress: DirectPushIngressOptions;
    readonly queue: LinuxEasyPushQueueOptions;
    readonly verifyRaw: (frame: Uint8Array, meta: Readonly<DirectPushMeta>) => boolean;
}

export interface LinuxEasyPushProcessor {
    onPush(frame: Uint8Array, route: { kind: 'push'; name: string; id: number }): void;
    activate(): boolean;
    /** Latest local gate result only; it does not prove online status or a remote connection. */
    status(): 'buffering' | 'active' | 'stopped' | 'failed';
    stop(): void;
    drain(): Promise<void>;
}

const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const getPrototypeOf = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const freeze = Object.freeze;
const Bytes = Uint8Array;
const typedPrototype = getPrototypeOf(Bytes.prototype) as object;
const getLength = getDescriptor(typedPrototype, 'byteLength')!.get!;
const validateView = Bytes.prototype.values;
const setBytes = Bytes.prototype.set;
const fillBytes = Bytes.prototype.fill;
const promiseThen = Promise.prototype.then;
const scheduleImmediate = setImmediate;
const cancelImmediate = clearImmediate;
const YIELD_BATCH_SIZE = 16;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        throw new TypeError('invalid processor options');
    }

    const prototype = getPrototypeOf(value);
    const names = ownKeys(value);

    if ((prototype !== Object.prototype && prototype !== null) || names.length !== keys.length) {
        throw new TypeError('invalid processor options');
    }

    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const name of names) {
        if (typeof name !== 'string' || !keys.includes(name)) {
            throw new TypeError('invalid processor options');
        }

        const descriptor = getDescriptor(value, name);

        if (!descriptor || !hasOwn(descriptor, 'value')) {
            throw new TypeError('invalid processor options');
        }

        result[name] = descriptor.value;
    }

    return result;
}

function observePromise(value: unknown): void {
    if (isPromise(value)) {
        try {
            apply(promiseThen, value, [undefined, () => undefined]);
        } catch {
            // Promise species and the native intrinsics are trusted runtime assumptions.
        }
    }
}

function wipe(value: Uint8Array): void {
    try {
        apply(fillBytes, value, [0]);
    } catch {
        // Detached or transferred memory is outside this best-effort wipe.
    }
}

function sameMeta(
    actual: Readonly<DirectPushMeta> | undefined,
    expected: Readonly<DirectPushMeta>,
): boolean {
    return (
        actual !== undefined &&
        actual.uin === expected.uin &&
        actual.sequence === expected.sequence &&
        actual.command === expected.command &&
        actual.retCode === expected.retCode
    );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    try {
        apply(validateView, left, []);
        apply(validateView, right, []);
        const length = apply(getLength, left, []) as number;

        if (length !== (apply(getLength, right, []) as number)) {
            return false;
        }

        for (let i = 0; i < length; i += 1) {
            if (left[i] !== right[i]) {
                return false;
            }
        }

        return true;
    } catch {
        return false;
    }
}

/**
 * Experimental opt-in local composition; this installs no mux or production wiring.
 * The caller exclusively coordinates the same one-shot owner, account, identity and
 * pipeline, and awaits owner.start() returning registered before activation. Candidates
 * queued before activation rely only on caller routing; unknown D2 frames preceding
 * the EasyLogin response are not classified or supported here. Neither routing,
 * owner state, a true verifier result, nor the ingress authentication assertion is
 * independent proof of a peer, source authenticity, online status or delivery.
 * The synchronous verifier is trusted and receives a private complete encrypted frame
 * that may contain account data. stop best-effort wipes the verifier copy and
 * extracted body already reachable by this processor synchronously, including during
 * reentry. A body not yet returned by the extractor is wiped after it returns.
 * The callback can retain or rewrite bytes; its other copies and transferred memory
 * are outside this processor's reach, and mutation followed by restoration is not observable.
 * No data or errors are logged here. Already-entered pipeline effects cannot be rolled
 * back; drain may remain pending if initialization or pipeline work never settles.
 * Verifier, identity and pipeline callbacks and their dependencies must not await
 * this processor's drain or later work in this same FIFO: they can wait on themselves.
 * Standard unmodified Promise, Array and other intrinsics, including Promise species,
 * and absence of synchronous async_hooks reentry are caller/runtime assumptions.
 * After each fixed batch of fully processed, released items, the worker yields to an
 * event-loop task. This bound excludes an uncooperative synchronous verifier, time
 * spent in a parser or processing wait, event-loop performance and pipeline work
 * already entered. Lifecycle observation still depends on event-loop progress.
 * status reports only the last local state and gate check, not online status or a
 * remote connection. Owner termination while idle is noticed at the next check or
 * explicit stop, not automatically; callers coordinate shutdown and await drain.
 */
export function createLinuxEasyPushProcessor(
    options: LinuxEasyPushProcessorOptions,
): LinuxEasyPushProcessor {
    let input: Record<string, unknown>;
    let ingressInput: Record<string, unknown>;
    let queueInput: Record<string, unknown>;

    try {
        input = record(options, ['owner', 'uin', 'ingress', 'queue', 'verifyRaw']);
        ingressInput = record(input.ingress, [
            'uin',
            'identity',
            'pipeline',
            'pipelineIdentityBound',
            'sourceAuthenticationHandled',
            'maxBodyBytes',
            'maxPendingBytes',
            'maxPending',
            'maxEventsPerPush',
        ]);
        queueInput = record(input.queue, ['maxFrameBytes', 'maxQueuedFrames', 'maxQueuedBytes']);
    } catch {
        throw new TypeError('invalid push processor options');
    }

    const owner = input.owner;
    const uin = input.uin;
    const verify = input.verifyRaw;

    if (
        typeof owner !== 'object' ||
        owner === null ||
        isProxy(owner) ||
        typeof uin !== 'string' ||
        !/^[1-9][0-9]{0,9}$/.test(uin) ||
        Number(uin) > 0xffffffff ||
        ingressInput.uin !== uin ||
        ingressInput.pipelineIdentityBound !== true ||
        ingressInput.sourceAuthenticationHandled !== true ||
        typeof verify !== 'function' ||
        isProxy(verify) ||
        typeof ingressInput.identity !== 'object' ||
        ingressInput.identity === null ||
        isProxy(ingressInput.identity) ||
        typeof ingressInput.pipeline !== 'object' ||
        ingressInput.pipeline === null ||
        isProxy(ingressInput.pipeline)
    ) {
        throw new TypeError('invalid push processor options');
    }

    const closeDescriptor = getDescriptor(owner, 'close');

    if (
        !closeDescriptor ||
        !hasOwn(closeDescriptor, 'value') ||
        typeof closeDescriptor.value !== 'function' ||
        isProxy(closeDescriptor.value)
    ) {
        throw new TypeError('invalid push processor options');
    }

    const ownerClose = closeDescriptor.value as () => void;
    const trustedOwner = owner as LinuxEasyAccountOwner;
    const verifier = verify as LinuxEasyPushProcessorOptions['verifyRaw'];
    const queue = createLinuxEasyPushQueue(queueInput as unknown as LinuxEasyPushQueueOptions);
    let state: 'disabled' | 'active' | 'stopped' = 'disabled';
    let failed = false;
    let checking = false;
    let entering = false;
    let calling = false;
    let running = false;
    let kick = false;
    let verifyingCopy: Uint8Array | undefined;
    let pendingBody: Uint8Array | undefined;
    let worker: Promise<void> | undefined;
    let completedSinceYield = 0;
    let ownedImmediate:
        | {
              handle: ReturnType<typeof setImmediate> | undefined;
              resolve: () => void;
          }
        | undefined;
    let ingress: ReturnType<typeof createGuardedDirectPushIngress>;

    try {
        ingress = createGuardedDirectPushIngress(
            ingressInput as unknown as DirectPushIngressOptions,
            () => state === 'active' && isLinuxEasyOwnerPushActive(trustedOwner),
        );
    } catch (error) {
        observePromise(error);

        try {
            queue.close();
        } catch {
            /* independent cleanup */
        }

        try {
            apply(ownerClose, undefined, []);
        } catch {
            /* independent cleanup */
        }

        throw new TypeError('invalid push processor options');
    }

    function stop(): void {
        if (state === 'stopped') {
            return;
        }

        state = 'stopped';
        kick = false;
        const immediate = ownedImmediate;
        ownedImmediate = undefined;

        if (immediate) {
            try {
                if (immediate.handle !== undefined) {
                    cancelImmediate(immediate.handle);
                }
            } catch {
                /* independent cleanup */
            } finally {
                immediate.resolve();
            }
        }

        const copy = verifyingCopy;
        const body = pendingBody;
        verifyingCopy = undefined;
        pendingBody = undefined;

        if (copy) {
            wipe(copy);
        }

        if (body) {
            wipe(body);
        }

        try {
            queue.close();
        } catch {
            /* independent cleanup */
        }

        try {
            ingress.stop();
        } catch {
            /* independent cleanup */
        }

        try {
            apply(ownerClose, undefined, []);
        } catch {
            /* independent cleanup */
        }
    }

    function markFailed(): void {
        if (state !== 'stopped') {
            failed = true;
        }

        stop();
    }

    function status(): 'buffering' | 'active' | 'stopped' | 'failed' {
        if (state === 'stopped') {
            return failed ? 'failed' : 'stopped';
        }

        return state === 'disabled' ? 'buffering' : 'active';
    }

    function active(): boolean {
        if (state !== 'active' || checking) {
            if (checking) {
                markFailed();
            }

            return false;
        }

        checking = true;
        let result = false;

        try {
            result = isLinuxEasyOwnerPushActive(trustedOwner) === true;
        } catch {
            result = false;
        } finally {
            checking = false;
        }

        if (!result || state !== 'active') {
            markFailed();
            return false;
        }

        return true;
    }

    function fail(): never {
        markFailed();
        throw new Error('direct push processor stopped');
    }

    function yieldToEventLoop(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const immediate = {
                handle: undefined as ReturnType<typeof setImmediate> | undefined,
                resolve,
            };
            ownedImmediate = immediate;

            try {
                immediate.handle = scheduleImmediate(() => {
                    if (ownedImmediate === immediate) {
                        ownedImmediate = undefined;
                        completedSinceYield = 0;
                        resolve();
                    }
                });
            } catch (error) {
                if (ownedImmediate === immediate) {
                    ownedImmediate = undefined;
                }

                markFailed();
                reject(error);
            }
        });
    }

    async function work(): Promise<void> {
        try {
            while (active()) {
                kick = false;
                const result = queue.takeDetailed();

                if (result.kind !== 'item') {
                    if (!active()) {
                        break;
                    }

                    if (result.kind === 'empty') {
                        break;
                    }

                    fail();
                }

                const lease = result.lease;

                try {
                    if (!active()) {
                        break;
                    }

                    const frame = lease.frame;
                    const meta = lease.meta;
                    const length = apply(getLength, frame, []) as number;
                    const copy = new Bytes(length);
                    verifyingCopy = copy;

                    try {
                        apply(setBytes, copy, [frame]);

                        if (!active()) {
                            break;
                        }

                        let accepted: unknown;
                        calling = true;

                        try {
                            accepted = apply(verifier, undefined, [copy, meta]);
                            observePromise(accepted);
                        } catch (error) {
                            observePromise(error);
                            fail();
                        } finally {
                            calling = false;
                        }

                        if (!active() || accepted !== true || !equalBytes(copy, frame)) {
                            fail();
                        }
                    } finally {
                        if (verifyingCopy === copy) {
                            verifyingCopy = undefined;
                        }

                        wipe(copy);
                    }

                    if (!active()) {
                        break;
                    }

                    calling = true;
                    let classified: ReturnType<typeof classifyLinuxEasyOwnerD2Candidate>;

                    try {
                        classified = classifyLinuxEasyOwnerD2Candidate(trustedOwner, frame);
                    } finally {
                        calling = false;
                    }

                    if (
                        !active() ||
                        !sameMeta(classified, meta) ||
                        meta.uin !== uin ||
                        meta.command !== MSG_PUSH_CMD ||
                        meta.retCode !== 0
                    ) {
                        fail();
                    }

                    calling = true;
                    let extracted: ReturnType<typeof extractLinuxEasyOwnerPushBody>;

                    try {
                        extracted = extractLinuxEasyOwnerPushBody(trustedOwner, frame, meta);
                    } finally {
                        calling = false;
                    }

                    if (!extracted) {
                        fail();
                    }

                    const body = extracted.body;
                    pendingBody = body;
                    let receipt: ReturnType<typeof ingress.submit>;

                    try {
                        if (!active() || !sameMeta(extracted.meta, meta)) {
                            fail();
                        }

                        calling = true;

                        try {
                            receipt = ingress.submit(body, meta);
                            observePromise(receipt);
                        } finally {
                            calling = false;
                        }
                    } finally {
                        if (pendingBody === body) {
                            pendingBody = undefined;
                        }

                        // submit snapshots the body synchronously, even when later work waits.
                        wipe(body);
                    }

                    if (!active()) {
                        break;
                    }

                    const outcome = await receipt;

                    if (!active() || (outcome.kind !== 'settled' && outcome.kind !== 'empty')) {
                        fail();
                    }
                } finally {
                    lease.release();
                }

                completedSinceYield += 1;

                if (completedSinceYield >= YIELD_BATCH_SIZE) {
                    await yieldToEventLoop();
                }
            }
        } catch (error) {
            observePromise(error);
            markFailed();
        } finally {
            running = false;

            if (kick && state === 'active') {
                schedule();
            }
        }
    }

    function schedule(): void {
        if (state !== 'active') {
            return;
        }

        kick = true;

        if (!running) {
            running = true;
            worker = Promise.resolve().then(work);
        }
    }

    function onPush(frame: Uint8Array, route: { kind: 'push'; name: string; id: number }): void {
        if (state === 'stopped' || entering || checking || calling) {
            fail();
        }

        entering = true;

        try {
            if (state === 'active' && !active()) {
                fail();
            }

            const fields = record(route, ['kind', 'name', 'id']);
            const id = fields.id;

            if (
                fields.kind !== 'push' ||
                fields.name !== MSG_PUSH_CMD ||
                typeof id !== 'number' ||
                !Number.isInteger(id) ||
                id < 0 ||
                id > 0xffffffff
            ) {
                fail();
            }

            // This is only the caller's routing expectation, not authentication.
            const meta = freeze({ uin, sequence: id, command: MSG_PUSH_CMD, retCode: 0 });

            if (queue.enqueue(frame, meta).kind !== 'queued') {
                fail();
            }

            if (state === 'active') {
                if (!active()) {
                    fail();
                }

                schedule();
            }
        } catch {
            fail();
        } finally {
            entering = false;
        }
    }

    function activate(): boolean {
        if (state !== 'disabled') {
            return false;
        }

        if (entering || checking || calling) {
            markFailed();
            return false;
        }

        entering = true;

        try {
            checking = true;
            let ready: boolean;

            try {
                ready = isLinuxEasyOwnerPushActive(trustedOwner);
            } finally {
                checking = false;
            }

            if (!ready || state !== 'disabled') {
                return false;
            }

            state = 'active';

            if (
                !active() ||
                !ingress.activate() ||
                !active() ||
                !queue.enableDrain() ||
                !active()
            ) {
                markFailed();
                return false;
            }

            schedule();
            return true;
        } catch (error) {
            observePromise(error);
            markFailed();
            return false;
        } finally {
            entering = false;
        }
    }

    async function drain(): Promise<void> {
        if (state !== 'stopped') {
            throw new Error('stop push processor before drain');
        }

        if (worker) {
            await worker;
        }

        await ingress.drain();
    }

    return freeze({ onPush, activate, status, stop, drain });
}
