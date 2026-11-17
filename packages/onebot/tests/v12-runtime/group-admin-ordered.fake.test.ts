import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    activateOrderedPollOwner,
    pollOwnerStats,
    registerPollHost,
} from '../../src/v12-runtime/poll-owner';
import { SourceGeneration } from '../../src/v12-runtime/source-generation';

// In-memory ordered prototype only: no runtime, transport, or QQ connection.
function fixture() {
    const runtime = {};
    const binding = {};
    const generation = new SourceGeneration();
    generation.setOnline(true);
    registerPollHost(runtime, {
        self: { platform: 'qq', user_id: '10001' },
        captureBinding: () => binding,
        captureSource: () => generation.capture(binding),
        verify: (source) => generation.isCurrent(source, binding),
    });
    const result = activateOrderedPollOwner(runtime);

    if (result.status !== 'ready') {
        throw new Error('fixture owner was not ready');
    }

    return { runtime, owner: result.owner, ticket: () => generation.capture(binding)! };
}

function notice(id = 'synthetic-admin', isAdmin = true) {
    return {
        id,
        time: 1700000000.5,
        type: 'notice',
        detail_type: 'qq.group_admin_change',
        sub_type: '',
        self: { platform: 'qq', user_id: '10001' },
        group_id: '43',
        user_id: '42',
        is_admin: isAdmin,
    };
}

class Sink extends EventEmitter {
    body = '';

    isOpen() {
        return true;
    }

    writeHead() {}

    end(body: string) {
        this.body = body;
        this.emit('finish');
    }
}

async function settle() {
    for (let i = 0; i < 12; i++) {
        await Promise.resolve();
    }
}

afterEach(() => {
    vi.useRealTimers();
});

describe('group admin ordered owner structural admission (in-process fixture)', () => {
    it('preserves both boolean values, boundary times and child order after a skip', async () => {
        vi.useFakeTimers();
        const f = fixture();

        try {
            const parent = f.owner.begin(f.ticket());
            const skipped = parent?.child();
            const first = parent?.child();
            const second = parent?.child();
            const maximum = parent?.child();

            if (!parent || !skipped || !first || !second || !maximum) {
                throw new Error('fixture admission missing');
            }

            const zero = { ...notice('zero', true), time: 0, group_id: '1', user_id: '1' };
            const fractional = notice('fractional', false);
            const max = {
                ...notice('maximum', true),
                time: Number.MAX_SAFE_INTEGER,
                group_id: String(Number.MAX_SAFE_INTEGER),
                user_id: String(Number.MAX_SAFE_INTEGER),
            };

            // Resolve out of order; publication still follows child admission order.
            expect(maximum.resolve(max)).toBe(true);
            expect(second.resolve(fractional)).toBe(true);
            expect(skipped.skip()).toBe(true);
            expect(first.resolve(zero)).toBe(true);
            expect(parent.seal()).toBe(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 3,
                ordering_gap: false,
                ordering_reason: null,
            });

            const sink = new Sink();
            const result = await f.owner.start(
                {
                    limit: 0,
                    timeoutMs: 0,
                    maxOutputBytes: 65536,
                    responseDeadline: performance.now() + 5000,
                },
                sink,
            ).result;
            expect(result.kind).toBe('local_finish');
            expect(JSON.parse(sink.body).data).toEqual([zero, fractional, max]);
            expect(pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 3,
                ordering_gap: false,
            });
        } finally {
            f.owner.invalidate();
            await settle();
        }

        expect(pollOwnerStats(f.runtime)).toMatchObject({
            active: false,
            cleanup_pending: false,
            cleanup_uncertain: false,
            ordering_gap: false,
        });
    });

    const base = notice();

    const without = (key: string) => {
        const value: Record<string, unknown> = notice();
        delete value[key];
        return value;
    };

    const invalidShapes: Array<[string, unknown]> = [
        ['operator', { ...base, operator_id: '42' }],
        ['extra extension', { ...base, 'qq.extra': true }],
        ['numeric boolean', { ...base, is_admin: 1 }],
        ['string boolean', { ...base, is_admin: 'false' }],
        ['null boolean', { ...base, is_admin: null }],
        ['missing boolean', without('is_admin')],
        ['missing group', without('group_id')],
        ['missing user', without('user_id')],
        ['missing self', without('self')],
        ['missing id', without('id')],
        ['missing time', without('time')],
        ['missing detail type', without('detail_type')],
        ['missing subtype', without('sub_type')],
        ['empty id', { ...base, id: '' }],
        ['wrong type', { ...base, type: 'message' }],
        ['wrong detail', { ...base, detail_type: 'group_admin_change' }],
        ['nonempty subtype', { ...base, sub_type: 'set' }],
        ['wrong account', { ...base, self: { platform: 'qq', user_id: '10002' } }],
        ['wrong platform', { ...base, self: { platform: 'other', user_id: '10001' } }],
        ['noncanonical self', { ...base, self: { platform: 'qq', user_id: '010001' } }],
        ['extra self field', { ...base, self: { ...base.self, extra: true } }],
        ['missing self account', { ...base, self: { platform: 'qq' } }],
        ['zero group', { ...base, group_id: '0' }],
        ['negative group', { ...base, group_id: '-1' }],
        ['noncanonical group', { ...base, group_id: '043' }],
        ['unsafe group', { ...base, group_id: '9007199254740992' }],
        ['numeric group', { ...base, group_id: 43 }],
        ['zero user', { ...base, user_id: '0' }],
        ['negative user', { ...base, user_id: '-1' }],
        ['noncanonical user', { ...base, user_id: '042' }],
        ['unsafe user', { ...base, user_id: '9007199254740992' }],
        ['numeric user', { ...base, user_id: 42 }],
        ['negative time', { ...base, time: -1 }],
        ['string time', { ...base, time: '1' }],
    ];

    it.each(invalidShapes)(
        'marks a structurally invalid %s as an ordered sink gap',
        async (_label, event) => {
            vi.useFakeTimers();
            const f = fixture();

            try {
                const parent = f.owner.begin(f.ticket());
                const child = parent?.child();

                if (!parent || !child) {
                    throw new Error('fixture admission missing');
                }

                // Snapshot acceptance is not structural acceptance: the latter
                // occurs asynchronously when the sequencer delivers the child.
                expect(child.resolve(event)).toBe(true);
                expect(parent.seal()).toBe(true);
                await vi.advanceTimersByTimeAsync(0);
                await settle();
                expect(pollOwnerStats(f.runtime)).toMatchObject({
                    accepted: 0,
                    invalid: 1,
                    ordering_gap: true,
                    ordering_reason: 'sink_error',
                    active: false,
                    cleanup_pending: false,
                    cleanup_uncertain: false,
                });
                expect(activateOrderedPollOwner(f.runtime).status).toBe('degraded');
            } finally {
                f.owner.invalidate();
                await settle();
            }
        },
    );

    const invalidSnapshots: Array<[string, unknown]> = [
        ['unsafe time', { ...base, time: Number.MAX_SAFE_INTEGER + 1 }],
        ['NaN time', { ...base, time: Number.NaN }],
        ['infinite time', { ...base, time: Number.POSITIVE_INFINITY }],
        ['missing type', without('type')],
    ];

    it.each(invalidSnapshots)(
        'rejects %s at the sequencer snapshot and retains the gap',
        async (_label, event) => {
            vi.useFakeTimers();
            const f = fixture();

            try {
                const parent = f.owner.begin(f.ticket());
                const child = parent?.child();

                if (!parent || !child) {
                    throw new Error('fixture admission missing');
                }

                expect(child.resolve(event)).toBe(false);
                expect(parent.seal()).toBe(false);
                await settle();
                expect(pollOwnerStats(f.runtime)).toMatchObject({
                    accepted: 0,
                    ordering_gap: true,
                    ordering_reason: 'invalid_event',
                    active: false,
                    cleanup_pending: false,
                    cleanup_uncertain: false,
                });
                expect(activateOrderedPollOwner(f.runtime).status).toBe('degraded');
            } finally {
                f.owner.invalidate();
                await settle();
            }
        },
    );
});
