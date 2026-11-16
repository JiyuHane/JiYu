import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    activateOrderedPollOwner,
    activatePollOwner,
    invalidatePollOwner,
    pollOwnerStats,
    registerPollHost,
} from '../../src/v12-runtime/poll-owner';
import type { PollSink } from '../../src/v12-runtime/poll-transaction';
import { SourceGeneration, type V12Source } from '../../src/v12-runtime/source-generation';

// Only the explicit in-process owner and synthetic host/sink are exercised.
const self = { platform: 'qq', user_id: '12345' };

class MemorySink extends EventEmitter implements PollSink {
    body = '';
    writeHead = vi.fn();

    isOpen(): boolean {
        return true;
    }

    end(body: string): void {
        this.body = body;
        this.emit('finish');
    }
}

function event(segment: unknown, altMessage = '[voice]') {
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

function request() {
    return {
        limit: 0,
        timeoutMs: 0,
        maxOutputBytes: 65536,
        responseDeadline: performance.now() + 10000,
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

describe('ordered poll voice boundaries (in-process fixture only)', () => {
    it.each([
        { label: 'one UTF-16 unit', fileId: 'v', length: 1 },
        { label: '4096 ASCII UTF-16 units', fileId: 'v'.repeat(4096), length: 4096 },
        {
            label: '4096 UTF-16 units of supplementary text',
            fileId: '🪶'.repeat(2048),
            length: 4096,
        },
    ])('polls the exact voice file_id at $label', async ({ fileId, length }) => {
        const f = fixture();
        const input = event({ type: 'voice', data: { file_id: fileId } });

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
            expect(pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 1,
                invalid: 0,
                ordering_gap: false,
            });
            const sink = new MemorySink();
            expect(await f.owner.start(request(), sink).result).toEqual({
                kind: 'local_finish',
                response: 'events',
            });
            expect(sink.writeHead).toHaveBeenCalledOnce();
            expect(JSON.parse(sink.body).data).toEqual([input]);
        } finally {
            f.owner.invalidate();
            await settle();
        }
    });

    it('keeps text, mention, mention_all and image alongside voice', async () => {
        const f = fixture();
        const input = {
            ...event({ type: 'voice', data: { file_id: 'voice-fixture' } }),
            detail_type: 'group',
            group_id: '34567',
            message: [
                { type: 'text', data: { text: 'fixture' } },
                { type: 'mention', data: { user_id: '45678' } },
                { type: 'mention_all', data: {} },
                { type: 'image', data: { file_id: 'image-fixture' } },
                { type: 'voice', data: { file_id: 'voice-fixture' } },
            ],
        };

        try {
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
            const sink = new MemorySink();
            expect(await f.owner.start(request(), sink).result).toEqual({
                kind: 'local_finish',
                response: 'events',
            });
            expect(JSON.parse(sink.body).data).toEqual([input]);
            expect(pollOwnerStats(f.runtime)).toMatchObject({ accepted: 1, ordering_gap: false });
        } finally {
            f.owner.invalidate();
            await settle();
        }
    });

    it.each([
        { label: 'empty file_id', segment: { type: 'voice', data: { file_id: '' } } },
        {
            label: '4097 ASCII UTF-16 units',
            segment: { type: 'voice', data: { file_id: 'v'.repeat(4097) } },
        },
        {
            label: '4097 UTF-16 units with surrogate pairs',
            segment: { type: 'voice', data: { file_id: '🪶'.repeat(2048) + 'v' } },
        },
        { label: 'numeric file_id', segment: { type: 'voice', data: { file_id: 1 } } },
        { label: 'null file_id', segment: { type: 'voice', data: { file_id: null } } },
        { label: 'boolean file_id', segment: { type: 'voice', data: { file_id: false } } },
        { label: 'object file_id', segment: { type: 'voice', data: { file_id: {} } } },
        { label: 'missing file_id', segment: { type: 'voice', data: {} } },
        {
            label: 'extra data field',
            segment: { type: 'voice', data: { file_id: 'v', extra: true } },
        },
        {
            label: 'extra segment field',
            segment: { type: 'voice', data: { file_id: 'v' }, extra: true },
        },
        { label: 'missing data', segment: { type: 'voice' } },
        { label: 'null data', segment: { type: 'voice', data: null } },
        { label: 'array data', segment: { type: 'voice', data: [] } },
    ])('records a sticky gap for voice with $label', async ({ segment }) => {
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

            // The JSON snapshots fit; the ordered event validator rejects the segment.
            expect(child.resolve(event(segment))).toBe(true);
            expect(parent.seal()).toBe(true);
            await vi.advanceTimersByTimeAsync(0);
            await settle();
            expect(pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 0,
                invalid: 1,
                ordering_gap: true,
                ordering_reason: 'sink_error',
            });
            const sink = new MemorySink();
            expect(await f.owner.start(request(), sink).result).toEqual({ kind: 'epoch_invalid' });
            expect(sink.writeHead).not.toHaveBeenCalled();
            expect(sink.body).toBe('');
            expect(f.owner.begin(f.source)).toBeNull();
            expect(activateOrderedPollOwner(f.runtime).status).toBe('degraded');
            expect(activatePollOwner(f.runtime).status).toBe('degraded');
            invalidatePollOwner(f.runtime);
            await settle();
            expect(activateOrderedPollOwner(f.runtime).status).toBe('degraded');
            expect(pollOwnerStats(f.runtime)?.ordering_gap).toBe(true);
        } finally {
            f.owner.invalidate();
            await settle();
        }
    });

    it('retains the whole-event byte budget for an otherwise valid 4096-unit file_id', async () => {
        const f = fixture();
        const fileId = 'v'.repeat(4096);
        const input = event({ type: 'voice', data: { file_id: fileId } }, 'x'.repeat(64 * 1024));

        try {
            expect(fileId.length).toBe(4096);
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
