import { describe, expect, it, vi } from 'vitest';
import {
    IngressSequencer,
    type IngressHost,
    type IngressLimits,
    type IngressScheduler,
} from '../../src/v12-runtime/ingress-sequencer';

const limits: IngressLimits = {
    maxParents: 8,
    maxChildren: 12,
    maxChildrenPerParent: 4,
    maxBytes: 512,
    maxEventBytes: 128,
    deadlineMs: 100,
    maxFlushWork: 4,
};
const event = (id: number) => ({ type: 'message', id });
class Clock implements IngressScheduler {
    now = 0;
    private next = 1;
    timers = new Map<number, { at: number; cb: () => void }>();
    immediates = new Map<number, () => void>();
    timer(cb: () => void, delay: number): number {
        const id = this.next++;
        this.timers.set(id, { at: this.now + delay, cb });
        return id;
    }
    clearTimer(id: unknown): void {
        this.timers.delete(id as number);
    }
    immediate(cb: () => void): number {
        const id = this.next++;
        this.immediates.set(id, cb);
        return id;
    }
    clearImmediate(id: unknown): void {
        this.immediates.delete(id as number);
    }
    tick(): boolean {
        const entry = this.immediates.entries().next().value as [number, () => void] | undefined;

        if (!entry) {
            return false;
        }

        this.immediates.delete(entry[0]);
        entry[1]();
        return true;
    }
    flush(): void {
        let remaining = 100;

        while (this.tick()) {
            if (--remaining === 0) {
                throw new Error('flush loop');
            }
        }
    }
    timersDue(): void {
        for (const [id, timer] of [...this.timers]) {
            if (timer.at <= this.now && this.timers.delete(id)) {
                timer.cb();
            }
        }
    }
}

function fixture(overrides: Partial<IngressLimits> = {}, hostOverrides: Partial<IngressHost> = {}) {
    const clock = new Clock();
    const output: unknown[] = [];
    const degrade = vi.fn();
    const host: IngressHost = {
        now: () => clock.now,
        scheduler: clock,
        deliver: (json) => {
            output.push(JSON.parse(json));
            return 'accepted';
        },
        onDegrade: degrade,
        ...hostOverrides,
    };
    const q = new IngressSequencer({ ...limits, ...overrides }, host);
    return { clock, output, degrade, host, q };
}

function ready(q: IngressSequencer, id: number) {
    const p = q.admit()!;
    const c = p.child()!;
    expect(c.resolve(event(id))).toBe(true);
    expect(p.seal()).toBe(true);
    return { p, c };
}

describe('standalone bounded ingress sequencer', () => {
    it('delivers A before B after reversed completion', () => {
        const { q, clock, output } = fixture();
        const a = q.admit()!;
        const ca = a.child()!;
        a.seal();
        const b = q.admit()!;
        const cb = b.child()!;
        b.seal();
        cb.resolve(event(2));
        clock.flush();
        expect(output).toEqual([]);
        expect(q.stats().pendingHead).toBe(true);
        ca.resolve(event(1));
        clock.flush();
        expect(output).toEqual([event(1), event(2)]);
        expect(q.stats().pendingHead).toBe(false);
    });
    it('requires sealing and every child to finish before delivering any child', () => {
        const { q, clock, output } = fixture();
        const p = q.admit()!;
        const a = p.child()!;
        const b = p.child()!;
        a.resolve(event(1));
        clock.flush();
        expect(output).toEqual([]);
        p.seal();
        clock.flush();
        expect(output).toEqual([]);
        b.resolve(event(2));
        clock.flush();
        expect(output).toEqual([event(1), event(2)]);
    });
    it('preserves ordinal across out-of-order child completion', () => {
        const { q, clock, output } = fixture();
        const p = q.admit()!;
        const a = p.child()!;
        const b = p.child()!;
        const c = p.child()!;
        p.seal();
        c.resolve(event(3));
        a.resolve(event(1));
        b.resolve(event(2));
        clock.flush();
        expect(output).toEqual([event(1), event(2), event(3)]);
    });
    it('zero-child seal unblocks following parent', () => {
        const { q, clock, output } = fixture();
        q.admit()!.seal();
        ready(q, 2);
        clock.flush();
        expect(output).toEqual([event(2)]);
    });
    it('skip is terminal and not loss', () => {
        const { q, clock, output, degrade } = fixture();
        const p = q.admit()!;
        p.child()!.skip();
        p.seal();
        ready(q, 2);
        clock.flush();
        expect(output).toEqual([event(2)]);
        expect(degrade).not.toHaveBeenCalled();
    });
    it('retains pending heads, including unsealed zero-child parent', () => {
        const { q, clock } = fixture();
        q.admit();
        clock.flush();
        expect(q.stats().pendingHead).toBe(true);
    });
    it('nested admission during delivery appends behind existing parents', () => {
        const f = fixture();
        const delivered: number[] = [];

        f.host.deliver = (json) => {
            const id = JSON.parse(json).id;
            delivered.push(id);

            if (id === 1) {
                ready(f.q, 3);
            }

            return 'accepted';
        };

        ready(f.q, 1);
        ready(f.q, 2);
        f.clock.flush();
        expect(delivered).toEqual([1, 2, 3]);
    });
    it('sink reentry cannot deliver the active slot twice', () => {
        const f = fixture();
        const delivered: number[] = [];

        f.host.deliver = (json) => {
            delivered.push(JSON.parse(json).id);
            f.clock.flush();
            return 'accepted';
        };

        ready(f.q, 1);
        f.clock.flush();
        expect(delivered).toEqual([1]);
    });
    it('reentrant retire stops remaining delivery', () => {
        const f = fixture();

        f.host.deliver = () => {
            f.q.retire();
            return 'accepted';
        };

        ready(f.q, 1);
        ready(f.q, 2);
        f.clock.flush();
        expect(f.q.stats().state).toBe('retired');
    });
    it('sink throw degrades and calls observer exactly once', () => {
        const f = fixture(
            {},
            {
                deliver: () => {
                    throw new Error('failure');
                },
            },
        );
        ready(f.q, 1);
        f.clock.flush();
        expect(f.degrade).toHaveBeenCalledOnce();
        expect(f.degrade).toHaveBeenCalledWith('sink_error');
        expect(f.q.stats().state).toBe('degraded');
    });
    it('sink full degrades without retry or skipping the head', () => {
        const deliver = vi.fn(() => 'full' as const);
        const f = fixture({}, { deliver });
        ready(f.q, 1);
        ready(f.q, 2);
        f.clock.flush();
        f.clock.flush();
        expect(deliver).toHaveBeenCalledOnce();
        expect(f.q.stats().reason).toBe('sink_full');
    });
    it('freezes state before synchronous observer, contains observer exceptions and reentry', () => {
        let q!: IngressSequencer;
        let calls = 0;
        const f = fixture(
            {},
            {
                onDegrade: () => {
                    calls++;
                    expect(q.stats().state).toBe('degraded');
                    expect(q.admit()).toBeNull();
                    throw new Error('observer');
                },
            },
        );
        q = f.q;
        const c = q.admit()!.child()!;
        expect(c.fail()).toBe(true);
        expect(c.fail()).toBe(false);
        expect(calls).toBe(1);
        expect(q.stats().notificationFailed).toBe(true);
    });
    it('contains an unsupported async observer rejection and reports notification failure', async () => {
        const f = fixture(
            {},
            {
                onDegrade: async () => {
                    throw new Error('async observer');
                },
            },
        );
        f.q.admit()!.child()!.fail();
        await Promise.resolve();
        expect(f.q.stats().notificationFailed).toBe(true);
        expect(f.q.stats().state).toBe('degraded');
    });
    it('contains an unsupported async sink rejection and degrades', async () => {
        const f = fixture(
            {},
            {
                deliver: (() =>
                    Promise.reject(new Error('async sink'))) as unknown as IngressHost['deliver'],
            },
        );
        ready(f.q, 1);
        f.clock.flush();
        await Promise.resolve();
        expect(f.q.stats().reason).toBe('sink_error');
    });
    it('child failure makes a sticky gap', () => {
        const { q, degrade } = fixture();
        const p = q.admit()!;
        p.child()!.fail();
        expect(q.stats().reason).toBe('child_failed');
        expect(p.seal()).toBe(false);
        expect(degrade).toHaveBeenCalledOnce();
    });
    it('expires even when scheduler never fires', () => {
        const { q, clock, degrade } = fixture();
        const p = q.admit()!;
        const c = p.child()!;
        p.seal();
        clock.now = 100;
        expect(c.resolve(event(1))).toBe(false);
        expect(q.stats().reason).toBe('expired');
        expect(degrade).toHaveBeenCalledOnce();
    });
    it.each([100, 101])('stats checks deadline %s with delayed timer and notifies once', (time) => {
        const { q, clock, degrade } = fixture();
        q.admit()!.child();
        clock.now = time;
        expect(q.stats().reason).toBe('expired');
        expect(q.stats().state).toBe('degraded');
        expect(degrade).toHaveBeenCalledOnce();
        expect(clock.timers.size).toBe(0);
    });
    it.each([100, 101])('retire checks deadline %s before discarding', (time) => {
        const { q, clock, degrade } = fixture();
        q.admit()!.child();
        clock.now = time;
        q.retire();
        expect(q.stats().state).toBe('retired');
        expect(q.stats().reason).toBe('expired');
        expect(q.stats().abandonedOnDegrade).toBeGreaterThan(0);
        expect(degrade).toHaveBeenCalledExactlyOnceWith('expired');
        q.retire();
        expect(degrade).toHaveBeenCalledOnce();
    });
    it('clearTimer reentry preserves the newly armed timer and ignores stale callback', () => {
        const f = fixture();
        let nested = false;
        const clear = f.clock.clearTimer.bind(f.clock);

        f.clock.clearTimer = (id) => {
            clear(id);

            if (!nested) {
                nested = true;
                f.q.admit()!.child();
            }
        };

        ready(f.q, 1);
        const stale = [...f.clock.timers.values()][0].cb;
        f.clock.flush();
        expect(f.clock.timers.size).toBe(1);
        stale();
        expect(f.clock.timers.size).toBe(1);
        f.clock.now = 100;
        f.clock.timersDue();
        expect(f.q.stats().reason).toBe('expired');
        expect(f.degrade).toHaveBeenCalledOnce();
    });
    it('async clearTimer fails closed immediately and observes rejection', async () => {
        const f = fixture();

        f.clock.clearTimer = async () => {
            throw new Error('async clear');
        };

        ready(f.q, 1);
        f.clock.flush();
        expect(f.q.stats().reason).toBe('scheduler_error');
        expect(f.q.stats().cleanupUncertain).toBe(true);
        expect(f.degrade).toHaveBeenCalledOnce();
        await Promise.resolve();
    });
    it('async clearImmediate on retirement reports uncertainty once', async () => {
        const f = fixture();

        f.clock.clearImmediate = async () => {
            throw new Error('async clear');
        };

        ready(f.q, 1);
        f.q.retire();
        expect(f.q.stats().state).toBe('retired');
        expect(f.q.stats().reason).toBe('scheduler_error');
        expect(f.q.stats().cleanupUncertain).toBe(true);
        expect(f.degrade).toHaveBeenCalledExactlyOnceWith('scheduler_error');
        await Promise.resolve();
    });
    it('async clear preserves existing expiry diagnosis and never renotifies', async () => {
        const f = fixture();

        f.clock.clearTimer = async () => {
            throw new Error('async clear');
        };

        f.q.admit()!.child();
        f.clock.now = 100;
        f.q.retire();
        expect(f.q.stats().reason).toBe('expired');
        expect(f.q.stats().cleanupUncertain).toBe(true);
        expect(f.degrade).toHaveBeenCalledExactlyOnceWith('expired');
        await Promise.resolve();
    });
    it('timer expires a stalled sealed parent', () => {
        const { q, clock } = fixture();
        const p = q.admit()!;
        p.child();
        p.seal();
        clock.now = 100;
        clock.timersDue();
        expect(q.stats().reason).toBe('expired');
        expect(clock.timers.size).toBe(0);
    });
    it('early timer reschedules against original absolute deadline', () => {
        const { q, clock } = fixture();
        q.admit();
        clock.now = 50;
        const [id, item] = [...clock.timers][0];
        clock.timers.delete(id);
        item.cb();
        expect([...clock.timers.values()][0].at).toBe(100);
    });
    it('timer and queued work are canceled on retirement', () => {
        const { q, clock } = fixture();
        ready(q, 1);
        expect(clock.timers.size).toBe(1);
        expect(clock.immediates.size).toBe(1);
        expect(q.retire()).toBe(1);
        expect(clock.timers.size).toBe(0);
        expect(clock.immediates.size).toBe(0);
    });
    it('old handles never affect a new epoch', () => {
        const a = fixture();
        const p = a.q.admit()!;
        const c = p.child()!;
        a.q.retire();
        const b = fixture();
        ready(b.q, 2);
        expect(c.resolve(event(1))).toBe(false);
        expect(p.seal()).toBe(false);
        b.clock.flush();
        expect(b.output).toEqual([event(2)]);
    });
    it('retire skips settled filters without reporting loss', () => {
        const { q, clock } = fixture();
        const p = q.admit()!;
        p.child()!.skip();
        p.seal();
        clock.flush();
        expect(q.retire()).toBe(0);
    });
    it('refuses repeated child terminal and repeated seal', () => {
        const { q, clock, output } = fixture();
        const p = q.admit()!;
        const c = p.child()!;
        expect(c.resolve(event(1))).toBe(true);
        expect(c.skip()).toBe(false);
        expect(p.seal()).toBe(true);
        expect(p.seal()).toBe(false);
        expect(p.child()).toBeNull();
        clock.flush();
        expect(output).toEqual([event(1)]);
    });
    it('late candidate after a skip degrades the live epoch', () => {
        const { q, degrade } = fixture();
        const p = q.admit()!;
        const c = p.child()!;
        c.skip();
        p.seal();
        expect(c.resolve(event(1))).toBe(false);
        expect(q.stats().reason).toBe('late_candidate');
        expect(degrade).toHaveBeenCalledOnce();
    });
    it('late candidate after delivery degrades without duplicate enqueue', () => {
        const { q, clock, output } = fixture();
        const { c } = ready(q, 1);
        clock.flush();
        expect(c.resolve(event(1))).toBe(false);
        clock.flush();
        expect(output).toEqual([event(1)]);
        expect(q.stats().reason).toBe('late_candidate');
    });
    it('snapshot owns all nested event data', () => {
        const { q, clock, output } = fixture();
        const p = q.admit()!;
        const c = p.child()!;
        const value = { type: 'message', nested: { list: ['a'] } };
        c.resolve(value);
        value.nested.list[0] = 'b';
        p.seal();
        clock.flush();
        expect(output).toEqual([{ type: 'message', nested: { list: ['a'] } }]);
    });
    it('bounds synchronous flush operations and schedules the rest', () => {
        const { q, clock, output } = fixture({ maxFlushWork: 1 });
        ready(q, 1);
        ready(q, 2);
        expect(clock.tick()).toBe(true);
        expect(output).toEqual([event(1)]);
        expect(clock.immediates.size).toBe(1);
        clock.flush();
        expect(output).toEqual([event(1), event(2)]);
    });
    it('parent overflow degrades', () => {
        const { q } = fixture({ maxParents: 1 });
        q.admit();
        expect(q.admit()).toBeNull();
        expect(q.stats().reason).toBe('parent_capacity');
    });
    it('child overflow degrades', () => {
        const { q } = fixture({ maxChildren: 1, maxChildrenPerParent: 1 });
        q.admit()!.child();
        expect(q.admit()!.child()).toBeNull();
        expect(q.stats().reason).toBe('child_capacity');
    });
    it('per-parent child overflow degrades', () => {
        const { q } = fixture({ maxChildrenPerParent: 1 });
        const p = q.admit()!;
        p.child();
        expect(p.child()).toBeNull();
        expect(q.stats().reason).toBe('parent_child_capacity');
    });
    it('cumulative encoded bytes overflow degrades', () => {
        const { q } = fixture({ maxBytes: 40, maxEventBytes: 40 });
        const p = q.admit()!;
        p.child()!.resolve(event(1));
        expect(p.child()!.resolve(event(2))).toBe(false);
        expect(q.stats().reason).toBe('bytes');
    });
    it('single encoded event overflow degrades', () => {
        const { q } = fixture({ maxEventBytes: 20 });
        const c = q.admit()!.child()!;
        expect(c.resolve({ type: 'message', text: 'abc' })).toBe(false);
        expect(q.stats().reason).toBe('event_too_large');
    });
    it('sequence exhaustion degrades without wrapping', () => {
        const { q } = fixture({ initialSequence: Number.MAX_SAFE_INTEGER });
        expect(q.admit()).toBeNull();
        expect(q.stats().reason).toBe('sequence_exhausted');
    });
    it('deadline crossed in sink does not resume ordered delivery', () => {
        const f = fixture();
        let calls = 0;

        f.host.deliver = () => {
            calls++;
            f.clock.now = 100;
            return 'accepted';
        };

        ready(f.q, 1);
        ready(f.q, 2);
        f.clock.flush();
        expect(calls).toBe(1);
        expect(f.q.stats().reason).toBe('expired');
    });
    it('clock moving backwards degrades', () => {
        const { q, clock } = fixture();
        clock.now = 10;
        q.admit();
        clock.now = 9;
        expect(q.admit()).toBeNull();
        expect(q.stats().reason).toBe('clock_error');
    });
    it('clock reentry cannot recurse or invert admissions', () => {
        let q!: IngressSequencer;
        let entered = false;
        const f = fixture(
            {},
            {
                now: () => {
                    if (!entered) {
                        entered = true;
                        q.admit();
                    }

                    return 0;
                },
            },
        );
        q = f.q;
        expect(q.admit()).toBeNull();
        expect(q.stats().reason).toBe('clock_error');
    });
    it('timer scheduling failure degrades before exposing handle', () => {
        const clock = new Clock();

        clock.timer = () => {
            throw new Error('timer');
        };

        const f = fixture({}, { scheduler: clock });
        expect(f.q.admit()).toBeNull();
        expect(f.q.stats().reason).toBe('scheduler_error');
    });
    it('immediate scheduling failure degrades', () => {
        const clock = new Clock();

        clock.immediate = () => {
            throw new Error('immediate');
        };

        const f = fixture({}, { scheduler: clock });
        const p = f.q.admit()!;
        expect(p.seal()).toBe(false);
        expect(f.q.stats().reason).toBe('scheduler_error');
    });
    it('performs one active timer and one flush even for many admissions', () => {
        const { q, clock } = fixture();
        ready(q, 1);
        ready(q, 2);
        expect(clock.timers.size).toBe(1);
        expect(clock.immediates.size).toBe(1);
        clock.flush();
        expect(clock.timers.size).toBe(0);
    });
    it('does not invoke thenable or getter on input', () => {
        const get = vi.fn();
        const value = { type: 'message' };
        Object.defineProperty(value, 'then', { enumerable: true, get });
        const { q } = fixture();
        expect(q.admit()!.child()!.resolve(value)).toBe(false);
        expect(get).not.toHaveBeenCalled();
    });
    it('ignores a canceled stale immediate after retire', () => {
        const { q, clock, output } = fixture();
        ready(q, 1);
        const cb = [...clock.immediates.values()][0];
        q.retire();
        cb();
        expect(output).toEqual([]);
    });
    it('retire reports undelivered pending and ready children', () => {
        const { q } = fixture();
        const p = q.admit()!;
        p.child();
        p.child()!.resolve(event(2));
        p.seal();
        expect(q.retire()).toBe(2);
        expect(q.retire()).toBe(2);
    });
    it.each([-1, Number.NaN, Infinity])('rejects invalid initial sequence %s', (n) => {
        expect(() => fixture({ initialSequence: n })).toThrow();
    });
    it.each([
        'maxParents',
        'maxChildren',
        'maxChildrenPerParent',
        'maxBytes',
        'maxEventBytes',
        'deadlineMs',
        'maxFlushWork',
    ] as const)('rejects zero %s', (key) => {
        expect(() => fixture({ [key]: 0 })).toThrow();
    });
    it.each([
        null,
        [],
        'x',
        3,
        {},
        { type: '' },
        { type: 'meta' },
        { type: 'message', value: undefined },
        { type: 'message', value: NaN },
        { type: 'message', value: Infinity },
        { type: 'message', value: 1n },
        { type: 'message', value: () => 1 },
        { type: 'message', value: Symbol('x') },
        { type: 'message', value: new Date() },
        { type: 'message', value: new Map() },
        { type: 'message', value: new Proxy({}, {}) },
        { type: 'message', value: new Array(3) },
        { type: 'message', value: Number.MAX_VALUE },
    ])('invalid JSON-shaped event %# degrades', (value) => {
        const { q } = fixture();
        expect(q.admit()!.child()!.resolve(value)).toBe(false);
        expect(q.stats().reason).toBe('invalid_event');
    });
    it.each([0, 1, 49, 99])('permits terminal at monotonic time %s before deadline', (time) => {
        const { q, clock, output } = fixture();
        const p = q.admit()!;
        const c = p.child()!;
        clock.now = time;
        expect(c.resolve(event(1))).toBe(true);
        p.seal();
        clock.flush();
        expect(output).toEqual([event(1)]);
    });
    it.each([100, 101, 1000])('expires at or beyond deadline %s', (time) => {
        const { q, clock } = fixture();
        const p = q.admit()!;
        const c = p.child()!;
        clock.now = time;
        expect(c.skip()).toBe(false);
        expect(q.stats().reason).toBe('expired');
    });
});
