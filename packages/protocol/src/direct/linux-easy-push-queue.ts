import { isProxy, isUint8Array } from 'node:util/types';

// Passive candidate storage only: neither frames nor metadata are authenticated.
// A future adapter may enable draining only after successful registration, key
// commit, and verification that its owner is current. This local latch proves none
// of those facts. Do not log frames or metadata; they may contain sensitive data.
// No callback is invoked: an onPush adapter should only enqueue and return undefined.
export interface LinuxEasyPushQueueOptions {
    readonly maxFrameBytes: number;
    readonly maxQueuedFrames: number;
    readonly maxQueuedBytes: number;
}

export interface LinuxEasyPushQueueMeta {
    readonly uin: string;
    readonly sequence: number;
    readonly command: string;
    readonly retCode: number;
}

export type LinuxEasyPushQueueResult =
    | { kind: 'queued' }
    | { kind: 'rejected'; reason: 'closed' | 'invalid' | 'capacity' | 'reentrant' };

export type LinuxEasyPushQueueLease = Readonly<{
    frame: Uint8Array;
    meta: Readonly<LinuxEasyPushQueueMeta>;
    release(): void;
}>;

export type LinuxEasyPushQueueTakeResult =
    | Readonly<{ kind: 'item'; lease: LinuxEasyPushQueueLease }>
    | Readonly<{ kind: 'empty' | 'busy' | 'disabled' | 'closed' | 'failed' }>;

export type LinuxEasyPushQueue = Readonly<{
    enqueue(frame: unknown, meta: unknown): LinuxEasyPushQueueResult;
    enableDrain(): boolean;
    take(): LinuxEasyPushQueueLease | undefined;
    close(): void;
}>;

export type LinuxEasyPushQueueDetailed = LinuxEasyPushQueue &
    Readonly<{
        takeDetailed(): LinuxEasyPushQueueTakeResult;
    }>;

// Local resource ceilings, not protocol limits. Command length is measured in
// UTF-16 code units; byte frames are preserved without parsing or interpretation.
const MAX_FRAME_BYTES = 65_536;
const MAX_QUEUED_FRAMES = 4_096;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const MAX_COMMAND_UNITS = 256;

const getPrototypeOf = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const freeze = Object.freeze;
const ownKeys = Reflect.ownKeys;
const apply = Reflect.apply;
const isSafeInteger = Number.isSafeInteger;
const objectPrototype = Object.prototype;
const Bytes = Uint8Array;
const typedPrototype = getPrototypeOf(Bytes.prototype) as object;
const getBuffer = getDescriptor(typedPrototype, 'buffer')!.get!;
const getLength = getDescriptor(typedPrototype, 'byteLength')!.get!;
const validateView = Bytes.prototype.values;
const copyBytes = Bytes.prototype.set;
const fillBytes = Bytes.prototype.fill;
const getArrayBufferLength = getDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const getResizable = getDescriptor(ArrayBuffer.prototype, 'resizable')?.get;

const queued = freeze({ kind: 'queued' } as const);
const closed = freeze({ kind: 'rejected', reason: 'closed' } as const);
const invalid = freeze({ kind: 'rejected', reason: 'invalid' } as const);
const capacity = freeze({ kind: 'rejected', reason: 'capacity' } as const);
const reentrant = freeze({ kind: 'rejected', reason: 'reentrant' } as const);

const takeEmpty = freeze({ kind: 'empty' } as const);
const takeBusy = freeze({ kind: 'busy' } as const);
const takeDisabled = freeze({ kind: 'disabled' } as const);
const takeClosed = freeze({ kind: 'closed' } as const);
const takeFailed = freeze({ kind: 'failed' } as const);

type Slot = {
    frame: Uint8Array;
    meta: Readonly<LinuxEasyPushQueueMeta>;
    size: number;
    next: Slot | undefined;
};

function plainRecord(value: unknown): value is object {
    if (typeof value !== 'object' || value === null || isProxy(value)) {
        return false;
    }

    const prototype = getPrototypeOf(value);
    return prototype === null || prototype === objectPrototype;
}

function dataField(value: object, name: string): unknown {
    const descriptor = getDescriptor(value, name);

    if (!descriptor || !hasOwn(descriptor, 'value')) {
        throw new TypeError('invalid field');
    }

    return descriptor.value;
}

function positiveLimit(value: unknown, ceiling: number): value is number {
    return typeof value === 'number' && isSafeInteger(value) && value > 0 && value <= ceiling;
}

function snapshotMeta(value: unknown): Readonly<LinuxEasyPushQueueMeta> | undefined {
    if (!plainRecord(value) || ownKeys(value).length !== 4) {
        return undefined;
    }

    const uin = dataField(value, 'uin');
    const sequence = dataField(value, 'sequence');
    const command = dataField(value, 'command');
    const retCode = dataField(value, 'retCode');

    if (
        typeof uin !== 'string' ||
        uin.length < 1 ||
        uin.length > 10 ||
        uin[0] < '1' ||
        uin[0] > '9'
    ) {
        return undefined;
    }

    for (let i = 1; i < uin.length; i += 1) {
        if (uin[i] < '0' || uin[i] > '9') {
            return undefined;
        }
    }

    if (
        (uin.length === 10 && uin > '4294967295') ||
        typeof sequence !== 'number' ||
        !isSafeInteger(sequence) ||
        sequence < 0 ||
        sequence > 0xffffffff ||
        typeof command !== 'string' ||
        command.length === 0 ||
        command.length > MAX_COMMAND_UNITS ||
        typeof retCode !== 'number' ||
        !isSafeInteger(retCode) ||
        retCode < -0x80000000 ||
        retCode > 0x7fffffff
    ) {
        return undefined;
    }

    return freeze({ uin, sequence, command, retCode });
}

function frameLength(value: unknown): number | undefined {
    if (isProxy(value) || !isUint8Array(value)) {
        return undefined;
    }

    // The intrinsic rejects detached and out-of-bounds views before observing
    // their length. The ArrayBuffer brand check also excludes shared storage.
    apply(validateView, value, []);
    const buffer = apply(getBuffer, value, []) as ArrayBuffer;
    apply(getArrayBufferLength, buffer, []);

    if (getResizable && apply(getResizable, buffer, [])) {
        return undefined;
    }

    const length = apply(getLength, value, []) as number;
    return length > 0 && length <= MAX_FRAME_BYTES ? length : undefined;
}

function wipe(frame: Uint8Array): void {
    try {
        apply(fillBytes, frame, [0]);
    } catch {
        // A borrower may already have detached/transferred the exposed buffer.
        // External copies and transferred storage are outside this queue's reach.
    }
}

export function createLinuxEasyPushQueue(
    options: Readonly<LinuxEasyPushQueueOptions>,
): LinuxEasyPushQueueDetailed {
    let maxFrameBytes: number;
    let maxQueuedFrames: number;
    let maxQueuedBytes: number;

    try {
        if (!plainRecord(options)) {
            throw new RangeError('invalid queue limits');
        }

        const frameLimit = dataField(options, 'maxFrameBytes');
        const frameCountLimit = dataField(options, 'maxQueuedFrames');
        const byteLimit = dataField(options, 'maxQueuedBytes');

        if (
            !positiveLimit(frameLimit, MAX_FRAME_BYTES) ||
            !positiveLimit(frameCountLimit, MAX_QUEUED_FRAMES) ||
            !positiveLimit(byteLimit, MAX_QUEUED_BYTES)
        ) {
            throw new RangeError('invalid queue limits');
        }

        maxFrameBytes = frameLimit;
        maxQueuedFrames = frameCountLimit;
        maxQueuedBytes = byteLimit;
    } catch {
        // Construction errors never expose option values or user-provided errors.
        throw new RangeError('invalid queue limits');
    }

    let head: Slot | undefined;
    let tail: Slot | undefined;
    let inflight: Slot | undefined;
    let chargedFrames = 0;
    let chargedBytes = 0;
    let draining = false;
    let stopped = false;
    let busy = false;

    function enqueue(frame: unknown, meta: unknown): LinuxEasyPushQueueResult {
        if (stopped) {
            return closed;
        }

        if (busy) {
            return reentrant;
        }

        busy = true;
        let privateFrame: Uint8Array | undefined;

        try {
            const length = frameLength(frame);
            const copiedMeta = snapshotMeta(meta);

            if (stopped) {
                return closed;
            }

            if (length === undefined || length > maxFrameBytes || !copiedMeta) {
                return invalid;
            }

            if (chargedFrames >= maxQueuedFrames || length > maxQueuedBytes - chargedBytes) {
                return capacity;
            }

            privateFrame = new Bytes(length);
            apply(copyBytes, privateFrame, [frame]);
            const slot: Slot = {
                frame: privateFrame,
                meta: copiedMeta,
                size: length,
                next: undefined,
            };

            if (stopped) {
                wipe(privateFrame);
                return closed;
            }

            if (tail) {
                tail.next = slot;
            } else {
                head = slot;
            }

            tail = slot;
            chargedFrames += 1;
            chargedBytes += length;
            privateFrame = undefined;
            return queued;
        } catch {
            if (privateFrame) {
                wipe(privateFrame);
            }

            return stopped ? closed : invalid;
        } finally {
            busy = false;
        }
    }

    function enableDrain(): boolean {
        if (stopped || busy) {
            return false;
        }

        draining = true;
        return true;
    }

    function take(): LinuxEasyPushQueueLease | undefined {
        if (stopped || busy || !draining || inflight || !head) {
            return undefined;
        }

        busy = true;

        try {
            const slot = head;
            let published = false;
            // Construct the handle before mutating the queue, so an exceptional
            // allocation leaves the original FIFO and quota untouched.
            const lease = freeze({
                frame: slot.frame,
                meta: slot.meta,
                release(): void {
                    if (!published) {
                        return;
                    }

                    if (inflight !== slot) {
                        // Re-wipe only this lease, without touching a later lease
                        // or charging quota twice. Detached transfers stay external.
                        wipe(slot.frame);
                        return;
                    }

                    inflight = undefined;
                    chargedFrames -= 1;
                    chargedBytes -= slot.size;
                    wipe(slot.frame);
                },
            });

            // A replaced intrinsic can reenter close() before the commit.
            if (stopped) {
                return undefined;
            }

            head = slot.next;
            slot.next = undefined;

            if (!head) {
                tail = undefined;
            }

            inflight = slot;
            published = true;
            return lease;
        } catch {
            return undefined;
        } finally {
            busy = false;
        }
    }

    function takeDetailed(): LinuxEasyPushQueueTakeResult {
        if (stopped) {
            return takeClosed;
        }

        if (busy) {
            return takeBusy;
        }

        if (!draining) {
            return takeDisabled;
        }

        if (inflight) {
            return takeBusy;
        }

        if (!head) {
            return takeEmpty;
        }

        busy = true;

        try {
            const slot = head;
            let published = false;
            // Finish both allocations before moving the FIFO or charging a lease.
            const lease = freeze({
                frame: slot.frame,
                meta: slot.meta,
                release(): void {
                    if (!published) {
                        return;
                    }

                    if (inflight !== slot) {
                        wipe(slot.frame);
                        return;
                    }

                    inflight = undefined;
                    chargedFrames -= 1;
                    chargedBytes -= slot.size;
                    wipe(slot.frame);
                },
            });
            const result = freeze({ kind: 'item' as const, lease });

            // close() may have erased the slot during an intercepted intrinsic.
            if (stopped) {
                return takeClosed;
            }

            head = slot.next;
            slot.next = undefined;

            if (!head) {
                tail = undefined;
            }

            inflight = slot;
            published = true;
            return result;
        } catch {
            return stopped ? takeClosed : takeFailed;
        } finally {
            busy = false;
        }
    }

    function close(): void {
        if (stopped) {
            return;
        }

        stopped = true;
        draining = false;
        let slot = head;
        head = undefined;
        tail = undefined;
        const borrowed = inflight;
        inflight = undefined;
        chargedFrames = 0;
        chargedBytes = 0;

        while (slot) {
            const next = slot.next;
            slot.next = undefined;
            wipe(slot.frame);
            slot = next;
        }

        if (borrowed) {
            wipe(borrowed.frame);
        }
    }

    return freeze({ enqueue, enableDrain, take, takeDetailed, close });
}
