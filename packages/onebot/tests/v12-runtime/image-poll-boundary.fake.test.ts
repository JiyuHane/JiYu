import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventPollBuffer } from '../../src/v12-runtime/event-poll-buffer';
import {
    activateOrderedPollOwner,
    pollOwnerStats,
    registerPollHost,
} from '../../src/v12-runtime/poll-owner';
import { SourceGeneration, type V12Source } from '../../src/v12-runtime/source-generation';

// This exercises only the explicit in-process ordered owner, not production HTTP polling.
const self = { platform: 'qq', user_id: '12345' };
const prefix = 'jiyu-image:v1:';
const longId = prefix + 'a'.repeat(4096 - prefix.length);

function event(segment: unknown, altMessage = '[图片]') {
    return {
        id: 'fixture-event',
        time: 1,
        type: 'message',
        detail_type: 'private',
        sub_type: '',
        self: { ...self },
        message_id: '-123',
        message: [segment],
        alt_message: altMessage,
        user_id: '23456',
    };
}

function fixture() {
    const runtime = {};
    const binding = {};
    const generation = new SourceGeneration();
    generation.setOnline(true);
    registerPollHost(runtime, {
        self,
        captureBinding: () => binding,
        captureSource: () => generation.capture(binding),
        verify: (source: V12Source | undefined) => generation.isCurrent(source, binding),
    });
    const activation = activateOrderedPollOwner(runtime);

    if (activation.status !== 'ready') {
        throw new Error('in-memory ordered owner did not activate');
    }

    return { runtime, owner: activation.owner, source: generation.capture(binding)! };
}

function captureQueue() {
    const enqueue = EventPollBuffer.prototype.enqueue;
    let queue: EventPollBuffer | undefined;
    const spy = vi.spyOn(EventPollBuffer.prototype, 'enqueue').mockImplementation(function (
        this: EventPollBuffer,
        value: unknown,
    ) {
        queue = this;
        return enqueue.call(this, value);
    });
    return {
        spy,
        queue: () => {
            if (!queue) {
                throw new Error('event was not offered to the real in-memory queue');
            }

            return queue;
        },
    };
}

async function settle() {
    for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
    }
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('ordered poll image boundaries (in-process fixture only)', () => {
    it.each([
        { label: 'one UTF-16 unit', fileId: 'x', length: 1 },
        { label: '4096 UTF-16 units with the image prefix', fileId: longId, length: 4096 },
        { label: '4096 UTF-16 units of multibyte text', fileId: '🪶'.repeat(2048), length: 4096 },
    ])('queues the exact image file_id at $label', async ({ fileId, length }) => {
        const captured = captureQueue();
        const f = fixture();
        const input = event({ type: 'image', data: { file_id: fileId } });

        try {
            expect(fileId.length).toBe(length);
            const parent = f.owner.begin(f.source);

            if (!parent) {
                throw new Error('expected in-memory admission');
            }

            const child = parent.child();

            if (!child) {
                throw new Error('expected in-memory child admission');
            }

            expect(child.resolve(input)).toBe(true);
            expect(parent.seal()).toBe(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(captured.spy).toHaveBeenCalledOnce();
            expect(captured.spy.mock.results[0]).toMatchObject({
                type: 'return',
                value: 'accepted',
            });
            const queue = captured.queue();
            expect(queue.stats()).toMatchObject({ count: 1, reserved: 0, closed: false });
            const reservation = await queue.reserve();
            expect(reservation.status).toBe('reserved');

            if (reservation.status !== 'reserved') {
                throw new Error('expected event in the real in-memory queue');
            }

            expect(JSON.parse(reservation.eventsJson)).toEqual([input]);
            expect(queue.commit(reservation.token)).toBe(true);
            expect(queue.stats()).toMatchObject({ count: 0, reserved: 0 });
            expect(pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 1,
                invalid: 0,
                ordering_gap: false,
            });
        } finally {
            f.owner.invalidate();
            await settle();
        }
    });

    it.each([
        { label: 'empty file_id', segment: { type: 'image', data: { file_id: '' } } },
        {
            label: '4097-unit file_id',
            segment: { type: 'image', data: { file_id: 'a'.repeat(4097) } },
        },
        { label: 'numeric file_id', segment: { type: 'image', data: { file_id: 1 } } },
        { label: 'missing file_id', segment: { type: 'image', data: {} } },
        {
            label: 'extra data field',
            segment: { type: 'image', data: { file_id: 'x', extra: true } },
        },
        {
            label: 'extra segment field',
            segment: { type: 'image', data: { file_id: 'x' }, extra: true },
        },
    ])('records a sticky gap and does not enqueue an image with $label', async ({ segment }) => {
        const captured = captureQueue();
        const f = fixture();

        try {
            const parent = f.owner.begin(f.source);

            if (!parent) {
                throw new Error('expected in-memory admission');
            }

            const child = parent.child();

            if (!child) {
                throw new Error('expected in-memory child admission');
            }

            // All these inputs fit the sequencer snapshot; rejection is by the ordered event validator.
            expect(child.resolve(event(segment))).toBe(true);
            expect(parent.seal()).toBe(true);
            await vi.advanceTimersByTimeAsync(0);
            await settle();
            expect(captured.spy).not.toHaveBeenCalled();
            expect(pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 0,
                invalid: 1,
                ordering_gap: true,
                ordering_reason: 'sink_error',
            });
            expect(activateOrderedPollOwner(f.runtime).status).toBe('degraded');
        } finally {
            f.owner.invalidate();
            await settle();
        }
    });

    it('keeps the whole-event byte budget when a 4096-unit file_id is otherwise valid', async () => {
        const captured = captureQueue();
        const f = fixture();
        const input = event({ type: 'image', data: { file_id: longId } }, 'x'.repeat(64 * 1024));

        try {
            expect(longId.length).toBe(4096);
            expect(Buffer.byteLength(JSON.stringify(input), 'utf8') + 2).toBeGreaterThan(64 * 1024);
            const parent = f.owner.begin(f.source);

            if (!parent) {
                throw new Error('expected in-memory admission');
            }

            const child = parent.child();

            if (!child) {
                throw new Error('expected in-memory child admission');
            }

            expect(child.resolve(input)).toBe(false);
            await settle();
            expect(captured.spy).not.toHaveBeenCalled();
            expect(pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 0,
                ordering_gap: true,
                ordering_reason: 'event_too_large',
            });
            expect(activateOrderedPollOwner(f.runtime).status).toBe('degraded');
        } finally {
            f.owner.invalidate();
            await settle();
        }
    });
});
