import { describe, expect, it, vi } from 'vitest';
import { createLinuxEasyPushQueue } from '../../src/direct/linux-easy-push-queue';
import type {
    LinuxEasyPushQueue,
    LinuxEasyPushQueueDetailed,
    LinuxEasyPushQueueLease,
} from '../../src/direct/linux-easy-push-queue';

// Synthetic bytes only; these tests exercise the real in-memory queue.
const limits = { maxFrameBytes: 4, maxQueuedFrames: 2, maxQueuedBytes: 5 } as const;
const meta = (sequence: number) => ({
    uin: '123',
    sequence,
    command: 'Synthetic.Push',
    retCode: 0,
});
const bytes = (...values: number[]) => new Uint8Array(values);
const queued = { kind: 'queued' } as const;
const capacity = { kind: 'rejected', reason: 'capacity' } as const;

function isLease(value: unknown): value is LinuxEasyPushQueueLease {
    return (
        typeof value === 'object' &&
        value !== null &&
        Object.hasOwn(value, 'frame') &&
        Object.hasOwn(value, 'release')
    );
}

function isWrapper(value: unknown): value is { kind: 'item'; lease: LinuxEasyPushQueueLease } {
    return (
        typeof value === 'object' &&
        value !== null &&
        Object.hasOwn(value, 'kind') &&
        (value as { kind?: unknown }).kind === 'item' &&
        Object.hasOwn(value, 'lease')
    );
}

function item(queue: LinuxEasyPushQueueDetailed): LinuxEasyPushQueueLease {
    const result = queue.takeDetailed();
    expect(result.kind).toBe('item');

    if (result.kind !== 'item') {
        throw new Error(`expected item, got ${result.kind}`);
    }

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.lease)).toBe(true);
    return result.lease;
}

// The queue captures freeze during module evaluation. Only the import window
// replaces the global intrinsic; the captured shim is dormant until a test arms
// its narrowly scoped hook. With unmodified intrinsics these faults do not occur.
// Run this file in its own Vitest process, not alongside other test files.
async function withFreezeHook(
    run: (
        create: typeof createLinuxEasyPushQueue,
        arm: (hook: ((value: unknown) => void) | undefined) => void,
    ) => void,
): Promise<void> {
    const original = Object.freeze;
    let hook: ((value: unknown) => void) | undefined;
    vi.resetModules();

    try {
        Object.freeze = ((value: unknown) => {
            hook?.(value);
            return original(value);
        }) as typeof Object.freeze;
        let fresh: typeof import('../../src/direct/linux-easy-push-queue');

        try {
            fresh = await import('../../src/direct/linux-easy-push-queue');
        } finally {
            Object.freeze = original;
        }

        run(fresh.createLinuxEasyPushQueue, (next) => {
            hook = next;
        });
    } finally {
        hook = undefined;
        Object.freeze = original;
        vi.resetModules();
    }
}

describe('linux easy push queue: detailed synthetic contract', () => {
    it('reports disabled, empty, item, inflight busy and terminal closed', () => {
        const queue = createLinuxEasyPushQueue(limits);
        expect(queue.takeDetailed()).toEqual({ kind: 'disabled' });
        expect(queue.enqueue(bytes(1, 2, 3), meta(1))).toEqual(queued);
        expect(queue.takeDetailed()).toEqual({ kind: 'disabled' });
        expect(queue.enableDrain()).toBe(true);
        const first = item(queue);
        expect([...first.frame]).toEqual([1, 2, 3]);
        expect(first.meta).toEqual(meta(1));
        expect(queue.takeDetailed()).toEqual({ kind: 'busy' });
        first.release();
        expect([...first.frame]).toEqual([0, 0, 0]);
        expect(queue.takeDetailed()).toEqual({ kind: 'empty' });
        queue.close();
        expect(queue.takeDetailed()).toEqual({ kind: 'closed' });
        expect(queue.enableDrain()).toBe(false);
        expect(queue.take()).toBeUndefined();
    });

    it('keeps queued and inflight charged and duplicate release isolated across items', () => {
        const queue = createLinuxEasyPushQueue(limits);
        const source = bytes(1, 2, 3);
        expect(queue.enqueue(source, meta(1))).toEqual(queued);
        expect(queue.enqueue(bytes(4, 5), meta(2))).toEqual(queued);
        expect(queue.enableDrain()).toBe(true);
        const first = item(queue);
        expect(first.frame).not.toBe(source);
        expect(queue.enqueue(bytes(6), meta(3))).toEqual(capacity);
        expect(queue.takeDetailed()).toEqual({ kind: 'busy' });
        first.release();
        expect([...first.frame]).toEqual([0, 0, 0]);
        expect([...source]).toEqual([1, 2, 3]);
        expect(queue.enqueue(bytes(6, 7, 8), meta(3))).toEqual(queued);
        const second = item(queue);
        expect([...second.frame]).toEqual([4, 5]);
        first.frame.fill(99);
        first.release();
        first.release();
        expect([...first.frame]).toEqual([0, 0, 0]);
        expect([...second.frame]).toEqual([4, 5]);
        expect(queue.enqueue(bytes(9), meta(4))).toEqual(capacity);
        second.release();
        const third = item(queue);
        expect([...third.frame]).toEqual([6, 7, 8]);
        expect(third.meta.sequence).toBe(3);
        third.release();
        expect(queue.takeDetailed()).toEqual({ kind: 'empty' });
        queue.close();
    });

    it('preserves the old queue type and take lease/undefined behavior', () => {
        const detailed = createLinuxEasyPushQueue(limits);
        const legacy: LinuxEasyPushQueue = detailed;
        const source = bytes(7, 8);
        expect(legacy.take()).toBeUndefined();
        expect(legacy.enqueue(source, meta(1))).toEqual(queued);
        expect(legacy.take()).toBeUndefined();
        expect(legacy.enableDrain()).toBe(true);
        const lease = legacy.take();
        expect(lease).toBeDefined();

        if (!lease) {
            throw new Error('expected legacy lease');
        }

        expect(lease.frame).not.toBe(source);
        expect([...lease.frame]).toEqual([7, 8]);
        expect(legacy.take()).toBeUndefined();
        expect(detailed.takeDetailed()).toEqual({ kind: 'busy' });
        lease.release();
        expect([...lease.frame]).toEqual([0, 0]);
        expect([...source]).toEqual([7, 8]);
        expect(legacy.take()).toBeUndefined();
        legacy.close();
        expect(legacy.take()).toBeUndefined();
    });

    it('checks busy before disabled during synchronous enqueue reentry', async () => {
        await withFreezeHook((create, arm) => {
            const queue = create(limits);
            let nested: unknown;
            let hits = 0;
            arm((value) => {
                if (
                    typeof value === 'object' &&
                    value !== null &&
                    Object.hasOwn(value, 'command') &&
                    Object.hasOwn(value, 'sequence')
                ) {
                    hits++;
                    nested = queue.takeDetailed();
                }
            });
            const result = queue.enqueue(bytes(1), meta(1));
            arm(undefined);
            expect(hits).toBe(1);
            expect(result).toEqual(queued);
            expect(nested).toEqual({ kind: 'busy' });
            expect(queue.takeDetailed()).toEqual({ kind: 'disabled' });
            queue.enableDrain();
            item(queue).release();
            queue.close();
        });
    });

    for (const site of ['lease', 'wrapper'] as const) {
        it(`retains FIFO and quota when ${site} freeze fails, then succeeds`, async () => {
            await withFreezeHook((create, arm) => {
                const queue = create(limits);
                expect(queue.enqueue(bytes(1, 2, 3), meta(1))).toEqual(queued);
                expect(queue.enqueue(bytes(4, 5), meta(2))).toEqual(queued);
                queue.enableDrain();
                let hits = 0;
                let capturedFrame: Uint8Array | undefined;
                let nested: unknown;
                arm((value) => {
                    if (isLease(value)) {
                        capturedFrame = value.frame;
                    }

                    const selected = site === 'lease' ? isLease(value) : isWrapper(value);

                    if (selected) {
                        hits++;
                        nested = queue.takeDetailed();
                        throw new Error('synthetic freeze failure');
                    }
                });
                const failed = queue.takeDetailed();
                arm(undefined);
                expect(hits).toBe(1);
                expect(nested).toEqual({ kind: 'busy' });
                expect(failed).toEqual({ kind: 'failed' });
                expect(queue.enqueue(bytes(9), meta(3))).toEqual(capacity);
                const first = item(queue);
                expect(first.frame).toBe(capturedFrame);
                expect([...first.frame]).toEqual([1, 2, 3]);
                expect(first.meta.sequence).toBe(1);
                first.release();
                const second = item(queue);
                expect([...second.frame]).toEqual([4, 5]);
                expect(second.meta.sequence).toBe(2);
                second.release();
                expect(queue.takeDetailed()).toEqual({ kind: 'empty' });
                queue.close();
            });
        });

        it(`returns closed without reviving a frame when ${site} freeze closes synchronously`, async () => {
            await withFreezeHook((create, arm) => {
                const queue = create(limits);
                const source = bytes(1, 2, 3);
                expect(queue.enqueue(source, meta(1))).toEqual(queued);
                expect(queue.enqueue(bytes(4, 5), meta(2))).toEqual(queued);
                queue.enableDrain();
                let hits = 0;
                let capturedLease: LinuxEasyPushQueueLease | undefined;
                let nestedAfterClose: unknown;
                arm((value) => {
                    if (isLease(value)) {
                        capturedLease = value;
                    }

                    const selected = site === 'lease' ? isLease(value) : isWrapper(value);

                    if (selected) {
                        hits++;
                        queue.close();
                        nestedAfterClose = queue.takeDetailed();
                    }
                });
                const result = queue.takeDetailed();
                arm(undefined);
                expect(hits).toBe(1);
                expect(nestedAfterClose).toEqual({ kind: 'closed' });
                expect(result).toEqual({ kind: 'closed' });
                expect(capturedLease).toBeDefined();
                expect([...capturedLease!.frame]).toEqual([0, 0, 0]);
                expect([...source]).toEqual([1, 2, 3]);
                capturedLease!.release();
                expect(queue.takeDetailed()).toEqual({ kind: 'closed' });
                expect(queue.take()).toBeUndefined();
                expect(queue.enqueue(bytes(9), meta(3))).toEqual({
                    kind: 'rejected',
                    reason: 'closed',
                });
                queue.close();
            });
        });
    }

    it('returns closed when metadata freeze closes during enqueue without reviving a frame', async () => {
        await withFreezeHook((create, arm) => {
            const queue = create(limits);
            const source = bytes(1, 2, 3);
            let hits = 0;
            let nested: unknown;
            arm((value) => {
                if (
                    typeof value === 'object' &&
                    value !== null &&
                    Object.hasOwn(value, 'command') &&
                    Object.hasOwn(value, 'sequence')
                ) {
                    hits++;
                    queue.close();
                    nested = queue.takeDetailed();
                }
            });
            const result = queue.enqueue(source, meta(1));
            arm(undefined);
            expect(hits).toBe(1);
            expect(nested).toEqual({ kind: 'closed' });
            expect(result).toEqual({ kind: 'rejected', reason: 'closed' });
            expect([...source]).toEqual([1, 2, 3]);
            expect(queue.takeDetailed()).toEqual({ kind: 'closed' });
            expect(queue.take()).toBeUndefined();
            expect(queue.enableDrain()).toBe(false);
            expect(queue.enqueue(bytes(9), meta(2))).toEqual({
                kind: 'rejected',
                reason: 'closed',
            });
            queue.close();
        });
    });

    it('returns undefined and wipes the frame when legacy lease freeze closes synchronously', async () => {
        await withFreezeHook((create, arm) => {
            const queue = create(limits);
            const source = bytes(1, 2, 3);
            expect(queue.enqueue(source, meta(1))).toEqual(queued);
            expect(queue.enqueue(bytes(4, 5), meta(2))).toEqual(queued);
            expect(queue.enableDrain()).toBe(true);
            let captured: LinuxEasyPushQueueLease | undefined;
            let nested: unknown;
            let hits = 0;
            arm((value) => {
                if (isLease(value)) {
                    hits++;
                    captured = value;
                    queue.close();
                    nested = queue.takeDetailed();
                }
            });
            const result = queue.take();
            arm(undefined);
            expect(hits).toBe(1);
            expect(nested).toEqual({ kind: 'closed' });
            expect(result).toBeUndefined();
            expect(captured).toBeDefined();
            expect([...captured!.frame]).toEqual([0, 0, 0]);
            expect([...source]).toEqual([1, 2, 3]);
            captured!.release();
            captured!.release();
            expect(queue.takeDetailed()).toEqual({ kind: 'closed' });
            expect(queue.take()).toBeUndefined();
            expect(queue.enqueue(bytes(9), meta(3))).toEqual({
                kind: 'rejected',
                reason: 'closed',
            });
            queue.close();
        });
    });

    it('ignores release called during lease freeze before publication', async () => {
        await withFreezeHook((create, arm) => {
            const queue = create(limits);
            expect(queue.enqueue(bytes(1, 2, 3), meta(1))).toEqual(queued);
            expect(queue.enqueue(bytes(4, 5), meta(2))).toEqual(queued);
            queue.enableDrain();
            let hits = 0;
            let provisional: LinuxEasyPushQueueLease | undefined;
            arm((value) => {
                if (isLease(value)) {
                    hits++;
                    provisional = value;
                    value.release();
                }
            });
            const result = queue.takeDetailed();
            arm(undefined);
            expect(hits).toBe(1);
            expect(result.kind).toBe('item');

            if (result.kind !== 'item') {
                throw new Error(`expected item, got ${result.kind}`);
            }

            expect(result.lease).toBe(provisional);
            expect([...result.lease.frame]).toEqual([1, 2, 3]);
            expect(queue.takeDetailed()).toEqual({ kind: 'busy' });
            expect(queue.enqueue(bytes(9), meta(3))).toEqual(capacity);
            result.lease.release();
            expect([...result.lease.frame]).toEqual([0, 0, 0]);
            const second = item(queue);
            expect([...second.frame]).toEqual([4, 5]);
            second.release();
            queue.close();
        });
    });

    for (const mode of ['detailed-wrapper', 'legacy-lease'] as const) {
        it(`does not let a leaked failed ${mode} handle release the retried winner`, async () => {
            await withFreezeHook((create, arm) => {
                const queue = create(limits);
                expect(queue.enqueue(bytes(1, 2, 3), meta(1))).toEqual(queued);
                expect(queue.enqueue(bytes(4, 5), meta(2))).toEqual(queued);
                queue.enableDrain();
                let leaked: LinuxEasyPushQueueLease | undefined;
                let hits = 0;
                arm((value) => {
                    if (mode === 'detailed-wrapper' && isWrapper(value)) {
                        hits++;
                        leaked = value.lease;
                        throw new Error('synthetic wrapper freeze failure');
                    }

                    if (mode === 'legacy-lease' && isLease(value)) {
                        hits++;
                        leaked = value;
                        throw new Error('synthetic lease freeze failure');
                    }
                });
                const failed = mode === 'detailed-wrapper' ? queue.takeDetailed() : queue.take();
                arm(undefined);
                expect(hits).toBe(1);
                expect(failed).toEqual(
                    mode === 'detailed-wrapper' ? { kind: 'failed' } : undefined,
                );
                expect(leaked).toBeDefined();
                const winner = mode === 'detailed-wrapper' ? item(queue) : queue.take();
                expect(winner).toBeDefined();

                if (!winner || !leaked) {
                    throw new Error('expected leaked and winning leases');
                }

                expect(winner).not.toBe(leaked);
                expect(winner.frame).toBe(leaked.frame);
                expect([...winner.frame]).toEqual([1, 2, 3]);
                leaked.release();
                leaked.release();
                expect([...winner.frame]).toEqual([1, 2, 3]);
                expect(queue.takeDetailed()).toEqual({ kind: 'busy' });
                expect(queue.enqueue(bytes(9), meta(3))).toEqual(capacity);
                winner.release();
                expect([...winner.frame]).toEqual([0, 0, 0]);
                const second = item(queue);
                expect([...second.frame]).toEqual([4, 5]);
                expect(second.meta.sequence).toBe(2);
                expect(queue.enqueue(bytes(6, 7, 8), meta(3))).toEqual(queued);
                leaked.release();
                expect([...second.frame]).toEqual([4, 5]);
                expect(queue.enqueue(bytes(9), meta(4))).toEqual(capacity);
                second.release();
                const third = item(queue);
                expect([...third.frame]).toEqual([6, 7, 8]);
                third.release();
                queue.close();
            });
        });
    }

    it('returns the same single queue frame copy from the legacy lease', async () => {
        await withFreezeHook((create, arm) => {
            const queue = create(limits);
            const source = bytes(8, 9);
            expect(queue.enqueue(source, meta(1))).toEqual(queued);
            queue.enableDrain();
            let constructed: LinuxEasyPushQueueLease | undefined;
            arm((value) => {
                if (isLease(value)) {
                    constructed = value;
                }
            });
            const taken = queue.take();
            arm(undefined);
            expect(constructed).toBeDefined();
            expect(taken).toBe(constructed);
            expect(taken!.frame).toBe(constructed!.frame);
            expect(taken!.frame).not.toBe(source);
            expect([...taken!.frame]).toEqual([8, 9]);
            taken!.release();
            queue.close();
        });
    });
});
