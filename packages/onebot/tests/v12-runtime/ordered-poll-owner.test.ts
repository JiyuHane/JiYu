import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventPollBuffer } from '../../src/v12-runtime/event-poll-buffer';
import {
    activateOrderedPollOwner,
    activatePollOwner,
    createPollGate,
    enqueuePollEvent,
    invalidatePollOwner,
    invalidateStalePollOwner,
    pollOwnerStats,
    registerPollHost,
} from '../../src/v12-runtime/poll-owner';
import {
    sameSourceEpoch,
    SourceGeneration,
    type V12Source,
} from '../../src/v12-runtime/source-generation';

function fixture(gate = createPollGate()) {
    let binding = {};
    const generation = new SourceGeneration();
    generation.setOnline(true);
    let verify: (source: V12Source | undefined) => boolean = (source) =>
        generation.isCurrent(source, binding);
    const runtime = {};
    const host = {
        self: { platform: 'qq', user_id: '12345' },
        captureBinding: () => binding,
        captureSource: () => generation.capture(binding),
        verify: (source: V12Source | undefined) => verify(source),
    };
    registerPollHost(runtime, host, gate);
    const token = () => generation.capture(binding)!;
    const activate = () => activateOrderedPollOwner(runtime);
    return {
        runtime,
        gate,
        generation,
        host,
        token,
        activate,
        binding: () => binding,
        replaceBinding: () => {
            binding = {};
        },
        setVerify: (callback: typeof verify) => {
            verify = callback;
        },
    };
}

function active(f: ReturnType<typeof fixture>) {
    const result = f.activate();
    expect(result.status).toBe('ready');

    if (result.status !== 'ready') {
        throw new Error('owner not ready');
    }

    return result.owner;
}

async function settle() {
    for (let n = 0; n < 12; n++) {
        await Promise.resolve();
    }
}

const event = (id: number) => ({
    id: `event-${id}`,
    time: 1,
    type: 'message',
    detail_type: 'private',
    sub_type: '',
    self: { platform: 'qq', user_id: '12345' },
    message_id: String(id),
    message: [{ type: 'text', data: { text: 'hello' } }],
    alt_message: 'hello',
    user_id: '23456',
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('ordered poll owner: in-process only', () => {
    it('compares private identities instead of Ticket object identity', () => {
        const f = fixture();
        const a = f.token();
        const b = f.token();
        expect(a).not.toBe(b);
        expect(sameSourceEpoch(a, b)).toBe('same');
        const other = fixture();
        expect(sameSourceEpoch(a, other.token())).toBe('different');
        expect(sameSourceEpoch(a, {})).toBe('invalid');
        expect(sameSourceEpoch(new Proxy(a, {}), b)).toBe('invalid');
    });
    it('uses real sequencer and real FIFO for out of order completion', async () => {
        vi.useFakeTimers();
        const spy = vi.spyOn(EventPollBuffer.prototype, 'enqueue');
        const f = fixture();
        const o = active(f);
        const a = o.begin(f.token())!;
        const ac = a.child()!;
        a.seal();
        const b = o.begin(f.token())!;
        const bc = b.child()!;
        b.seal();
        expect(bc.resolve(event(2))).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(spy).not.toHaveBeenCalled();
        expect(ac.resolve(event(1))).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(spy.mock.calls.map(([value]) => value)).toEqual([event(1), event(2)]);
        expect(pollOwnerStats(f.runtime)?.accepted).toBe(2);
        o.invalidate();
        await settle();
    });
    it('keeps child ordinal and skips normal filters without loss', async () => {
        vi.useFakeTimers();
        const spy = vi.spyOn(EventPollBuffer.prototype, 'enqueue');
        const f = fixture();
        const o = active(f);
        const p = o.begin(f.token())!;
        const a = p.child()!;
        const b = p.child()!;
        const c = p.child()!;
        p.seal();
        c.resolve(event(3));
        b.skip();
        a.resolve(event(1));
        await vi.advanceTimersByTimeAsync(0);
        expect(spy.mock.calls.map(([value]) => value)).toEqual([event(1), event(3)]);
        o.invalidate();
        await settle();
    });
    it('ordered start never reads a sink or emits an empty response', async () => {
        const f = fixture();
        const owner = active(f);
        const result = owner.start();
        expect(await result.result).toEqual({ kind: 'ordering_not_ready' });
        result.cancel();
        owner.invalidate();
        await settle();
    });
    it('blocks same epoch in ordered and legacy modes after gap and cleanup', async () => {
        const f = fixture();
        const o = active(f);
        const p = o.begin(f.token())!;
        p.child()!.fail();
        await settle();
        expect(f.activate().status).toBe('degraded');
        expect(activatePollOwner(f.runtime).status).toBe('degraded');
        invalidatePollOwner(f.runtime);
        await settle();
        expect(f.activate().status).toBe('degraded');
    });
    it('gap persists across runtimes sharing exactly one instance gate', async () => {
        const f = fixture();
        const o = active(f);
        o.begin(f.token())!.child()!.fail();
        await settle();
        const runtime = {};
        registerPollHost(runtime, f.host, f.gate);
        expect(activateOrderedPollOwner(runtime).status).toBe('degraded');
        expect(activatePollOwner(runtime).status).toBe('degraded');
    });
    it('recovers after verified new binding', async () => {
        const f = fixture();
        const o = active(f);
        o.begin(f.token())!.child()!.fail();
        await settle();
        f.replaceBinding();
        expect(f.activate().status).toBe('ready');
        invalidatePollOwner(f.runtime);
        await settle();
    });
    it('recovers after verified new online generation', async () => {
        const f = fixture();
        const o = active(f);
        o.begin(f.token())!.child()!.fail();
        await settle();
        f.generation.setOnline(false);
        f.generation.setOnline(true);
        expect(f.activate().status).toBe('ready');
        invalidatePollOwner(f.runtime);
        await settle();
    });
    it('false verification cannot clear a gap', async () => {
        const f = fixture();
        const o = active(f);
        o.begin(f.token())!.child()!.fail();
        await settle();
        f.replaceBinding();
        f.setVerify(() => false);
        expect(f.activate().status).toBe('unavailable');
        f.setVerify((s) => f.generation.isCurrent(s, f.binding()));
        f.replaceBinding();
        // Returning to the old generation is not possible after replacing binding; the retained gap remains until verified change.
        expect(f.activate().status).toBe('ready');
        invalidatePollOwner(f.runtime);
        await settle();
    });
    it('throwing verification cannot clear a gap', async () => {
        const f = fixture();
        const o = active(f);
        o.begin(f.token())!.child()!.fail();
        await settle();
        f.setVerify(() => {
            throw new Error('bad');
        });
        expect(f.activate().status).toBe('unavailable');
        f.setVerify((s) => f.generation.isCurrent(s, f.binding()));
        expect(f.activate().status).toBe('degraded');
    });
    it('rejects invalid and proxy source with gap', async () => {
        const f = fixture();
        const o = active(f);
        const token = f.token();
        expect(o.begin(new Proxy(token, {}))).toBeNull();
        await settle();
        expect(f.activate().status).toBe('degraded');
    });
    it('treats unfamiliar same-account other-instance ticket as unknown', async () => {
        const a = fixture();
        const b = fixture();
        const o = active(a);
        expect(o.begin(b.token())).toBeNull();
        await settle();
        expect(a.activate().status).toBe('degraded');
    });
    it('excludes only previously verified and retired source', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const old = f.token();
        const first = active(f);
        first.invalidate();
        await settle();
        f.generation.setOnline(false);
        f.generation.setOnline(true);
        const next = active(f);
        expect(next.begin(old)).toBeNull();
        const p = next.begin(f.token())!;
        p.child()!.resolve(event(2));
        p.seal();
        await vi.advanceTimersByTimeAsync(0);
        expect(pollOwnerStats(f.runtime)?.accepted).toBe(1);
        next.invalidate();
        await settle();
    });
    it('treats a never-activated old ticket as unknown', async () => {
        const f = fixture();
        const old = f.token();
        f.generation.setOnline(false);
        f.generation.setOnline(true);
        const o = active(f);
        expect(o.begin(old)).toBeNull();
        await settle();
        expect(f.activate().status).toBe('degraded');
    });
    it('fails closed after bounded history overflows', async () => {
        const f = fixture();
        let old!: V12Source;

        for (let i = 0; i < 9; i++) {
            if (i === 0) {
                old = f.token();
            }

            active(f).invalidate();
            await settle();
            f.generation.setOnline(false);
            f.generation.setOnline(true);
        }

        const o = active(f);
        expect(o.begin(old)).toBeNull();
        await settle();
        expect(f.activate().status).toBe('degraded');
    });
    it('verify false during admission degrades current epoch', async () => {
        const f = fixture();
        const o = active(f);
        f.setVerify(() => false);
        expect(o.begin(f.token())).toBeNull();
        await settle();
        f.setVerify((s) => f.generation.isCurrent(s, f.binding()));
        expect(f.activate().status).toBe('degraded');
    });
    it('verify throw during admission degrades current epoch', async () => {
        const f = fixture();
        const o = active(f);
        f.setVerify(() => {
            throw new Error('bad');
        });
        expect(o.begin(f.token())).toBeNull();
        await settle();
        f.setVerify((s) => f.generation.isCurrent(s, f.binding()));
        expect(f.activate().status).toBe('degraded');
    });
    it('unknown old child never changes new owner', async () => {
        const f = fixture();
        const o = active(f);
        const p = o.begin(f.token())!;
        const c = p.child()!;
        o.invalidate();
        await settle();
        f.replaceBinding();
        const replacement = active(f);
        expect(c.resolve(event(1))).toBe(false);
        expect(p.seal()).toBe(false);
        expect(f.activate().status).toBe('ready');
        replacement.invalidate();
        await settle();
    });
    it('old completion-order path degrades ordered owner rather than bypassing sequencing', async () => {
        const f = fixture();
        active(f);
        enqueuePollEvent(f.runtime, event(1), f.token());
        await settle();
        expect(f.activate().status).toBe('degraded');
    });
    it('invalidate with unresolved child keeps same epoch degraded', async () => {
        const f = fixture();
        const o = active(f);
        o.begin(f.token())!.child();
        o.invalidate();
        await settle();
        expect(f.activate().status).toBe('degraded');
        expect(activatePollOwner(f.runtime).status).toBe('degraded');
    });
    it('invalidate with accepted unconsumed events keeps same epoch degraded', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const o = active(f);
        const p = o.begin(f.token())!;
        p.child()!.resolve(event(1));
        p.seal();
        await vi.advanceTimersByTimeAsync(0);
        o.invalidate();
        await settle();
        expect(f.activate().status).toBe('degraded');
    });
    it('verify reentry invalidating admitted parent marks its epoch gap', async () => {
        const f = fixture();
        const o = active(f);
        f.setVerify(() => {
            o.invalidate();
            return true;
        });
        expect(o.begin(f.token())).toBeNull();
        await settle();
        f.setVerify((s) => f.generation.isCurrent(s, f.binding()));
        expect(f.activate().status).toBe('degraded');
    });
    it('activation cannot claim a binding changed reentrantly by verification', () => {
        const f = fixture();
        f.setVerify(() => {
            f.replaceBinding();
            return true;
        });
        expect(f.activate().status).toBe('unavailable');
        expect(pollOwnerStats(f.runtime)?.active).toBe(false);
    });
    it('rejects stale verification after offline-online status reentry during activation', () => {
        const f = fixture();
        f.setVerify((source) => {
            const wasCurrent = f.generation.isCurrent(source, f.binding());
            f.generation.setOnline(false);
            f.generation.setOnline(true);
            invalidateStalePollOwner(f.runtime);
            return wasCurrent;
        });
        expect(f.activate().status).toBe('unavailable');
        expect(pollOwnerStats(f.runtime)?.active).toBe(false);
    });
    it('does not clear existing gap on stale verification during activation', async () => {
        const f = fixture();
        const owner = active(f);
        owner.begin(f.token())!.child()!.fail();
        await settle();
        f.generation.setOnline(false);
        f.generation.setOnline(true);
        f.setVerify((source) => {
            const wasCurrent = f.generation.isCurrent(source, f.binding());
            f.generation.setOnline(false);
            f.generation.setOnline(true);
            invalidateStalePollOwner(f.runtime);
            return wasCurrent;
        });
        expect(f.activate().status).toBe('unavailable');
        expect(pollOwnerStats(f.runtime)?.ordering_gap).toBe(true);
    });
    it('repeat status in same epoch does not retire an active owner', async () => {
        const f = fixture();
        const owner = active(f);
        f.generation.setOnline(true);
        invalidateStalePollOwner(f.runtime);
        expect(f.activate().status).toBe('ready');
        owner.invalidate();
        await settle();
    });
    it('captures immutable trusted self primitives on activation', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const owner = active(f);
        f.host.self.user_id = '67890';
        const p = owner.begin(f.token())!;
        p.child()!.resolve(event(1));
        p.seal();
        await vi.advanceTimersByTimeAsync(0);
        expect(pollOwnerStats(f.runtime)?.accepted).toBe(1);
        owner.invalidate();
        await settle();
    });
    it('accepts the complete supported converter event subset', async () => {
        vi.useFakeTimers();
        const spy = vi.spyOn(EventPollBuffer.prototype, 'enqueue');
        const f = fixture();
        const owner = active(f);
        const p = owner.begin(f.token())!;
        const group = {
            ...event(-2147483648),
            detail_type: 'group',
            group_id: '34567',
            message: [
                { type: 'text', data: { text: 'hi' } },
                { type: 'mention', data: { user_id: '34567' } },
                { type: 'mention_all', data: {} },
            ],
        };
        const base = {
            id: 'notice-id',
            time: 1,
            type: 'notice',
            sub_type: '',
            self: { platform: 'qq', user_id: '12345' },
            group_id: '34567',
            user_id: '23456',
            operator_id: '23456',
        };
        const list = [
            event(1),
            group,
            { ...base, detail_type: 'group_message_delete', sub_type: 'recall', message_id: '-1' },
            { ...base, detail_type: 'group_member_decrease' },
        ];

        for (const item of list) {
            expect(p.child()!.resolve(item)).toBe(true);
        }

        p.seal();
        await vi.advanceTimersByTimeAsync(0);
        expect(spy.mock.calls.map(([value]) => value)).toEqual(list);
        owner.invalidate();
        await settle();
    });
    it.each([
        [
            'missing self',
            (v: any) => {
                delete v.self;
            },
        ],
        [
            'wrong account',
            (v: any) => {
                v.self.user_id = '77777';
            },
        ],
        [
            'wrong platform',
            (v: any) => {
                v.self.platform = 'other';
            },
        ],
        [
            'extra self',
            (v: any) => {
                v.self.extra = true;
            },
        ],
        [
            'missing id',
            (v: any) => {
                delete v.id;
            },
        ],
        [
            'empty id',
            (v: any) => {
                v.id = '';
            },
        ],
        [
            'negative time',
            (v: any) => {
                v.time = -1;
            },
        ],
        [
            'meta',
            (v: any) => {
                v.type = 'meta';
            },
        ],
        [
            'unknown type',
            (v: any) => {
                v.type = 'request';
            },
        ],
        [
            'unknown detail',
            (v: any) => {
                v.detail_type = 'other';
            },
        ],
        [
            'unexpected subtype',
            (v: any) => {
                v.sub_type = 'other';
            },
        ],
        [
            'zero message id',
            (v: any) => {
                v.message_id = '0';
            },
        ],
        [
            'overflow message id',
            (v: any) => {
                v.message_id = '2147483648';
            },
        ],
        [
            'noncanonical user id',
            (v: any) => {
                v.user_id = '001';
            },
        ],
        [
            'missing alt',
            (v: any) => {
                delete v.alt_message;
            },
        ],
        [
            'extension field',
            (v: any) => {
                v.extra = true;
            },
        ],
        [
            'private group id',
            (v: any) => {
                v.group_id = '1';
            },
        ],
        [
            'invalid segment',
            (v: any) => {
                v.message = [{ type: 'image', data: {} }];
            },
        ],
        [
            'segment extra',
            (v: any) => {
                v.message[0].extra = true;
            },
        ],
        [
            'data extra',
            (v: any) => {
                v.message[0].data.extra = true;
            },
        ],
        [
            'bad mention',
            (v: any) => {
                v.message = [{ type: 'mention', data: { user_id: '0' } }];
            },
        ],
    ])('rejects %s without queue admission and records gap', async (_label, change) => {
        vi.useFakeTimers();
        const spy = vi.spyOn(EventPollBuffer.prototype, 'enqueue');
        const f = fixture();
        const owner = active(f);
        const value: any = event(1);
        change(value);
        const p = owner.begin(f.token())!;
        const child = p.child()!;
        child.resolve(value);
        p.seal();
        await vi.advanceTimersByTimeAsync(0);
        await settle();
        expect(spy).not.toHaveBeenCalled();
        expect(pollOwnerStats(f.runtime)?.ordering_gap).toBe(true);
        expect(f.activate().status).toBe('degraded');
    });
    it('rejects event accessors without invoking them', async () => {
        const f = fixture();
        const owner = active(f);
        const getter = vi.fn(() => ({ platform: 'qq', user_id: '12345' }));
        const value = event(1);
        Object.defineProperty(value, 'self', { enumerable: true, get: getter });
        const p = owner.begin(f.token())!;
        expect(p.child()!.resolve(value)).toBe(false);
        await settle();
        expect(getter).not.toHaveBeenCalled();
        expect(pollOwnerStats(f.runtime)?.ordering_gap).toBe(true);
    });
    it('rejects missing or accessor host self without invoking the getter', () => {
        const f = fixture();
        const getter = vi.fn(() => ({ platform: 'qq', user_id: '12345' }));
        Object.defineProperty(f.host, 'self', { get: getter });
        expect(f.activate().status).toBe('unavailable');
        expect(getter).not.toHaveBeenCalled();
    });
    it('does not activate anything by default', () => {
        const f = fixture();
        expect(pollOwnerStats(f.runtime)?.active).toBe(false);
    });
    it('keeps legacy owner functional without a gap', async () => {
        const f = fixture();
        const legacy = activatePollOwner(f.runtime);
        expect(legacy.status).toBe('ready');
        enqueuePollEvent(f.runtime, event(1), f.token());
        expect(pollOwnerStats(f.runtime)?.accepted).toBe(1);
        invalidatePollOwner(f.runtime);
        await settle();
    });
});
