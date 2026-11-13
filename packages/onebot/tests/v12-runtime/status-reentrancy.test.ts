import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeLogs } from '@snowluma/common/logger';
import { V12Runtime } from '../../src/v12-runtime/runtime';
import type { V12TransportOptions } from '../../src/v12-network';

type StatusEvent = {
    id: string;
    detail_type: string;
    status: {
        good: boolean;
        bots: { self: { platform: string; user_id: string }; online: boolean }[];
    };
};

const transport = vi.hoisted(() => ({
    options: null as V12TransportOptions | null,
    closeError: false,
    construct: null as ((options: V12TransportOptions) => void) | null,
    open: null as (() => Promise<void>) | null,
    quiesce: null as (() => void) | null,
    quiesceInsideClose: false,
}));

vi.mock('../../src/v12-network', () => ({
    V12Transport: class {
        constructor(options: V12TransportOptions) {
            transport.options = options;
            transport.construct?.(options);
        }
        async open() {
            await transport.open?.();
        }
        async close() {
            if (transport.quiesceInsideClose) {
                this.quiesce();
            }

            if (transport.closeError) {
                throw new Error('fixture close failure');
            }
        }
        quiesce() {
            transport.quiesce?.();
        }
        forceClose() {}
    },
}));

function createFixture() {
    let online = false;
    const getStatus = vi.fn(() => ({ good: online, online }));
    const runtime = new V12Runtime(
        { name: 'v12', enabled: true, host: '127.0.0.1', port: 1, allowNonLoopback: false },
        {
            uin: '12345',
            api: {} as never,
            buildLifecycleEvent: () => ({}),
            buildHeartbeatEvent: () => ({}),
        },
        {
            getStatus,
            getSentMessageTime: async () => null,
            trackAction: (_label, start) => start(),
            canAccept: () => true,
        },
    );
    return {
        runtime,
        getStatus,
        setOnline: (value: boolean) => {
            online = value;
        },
    };
}

async function fixture() {
    const base = createFixture();
    await base.runtime.open();
    const options = transport.options!;
    return {
        ...base,
        options,
        subscribe: (listener: (event: StatusEvent) => void) =>
            options.subscribe((event) => listener(event as StatusEvent)),
    };
}

afterEach(() => {
    vi.useRealTimers();
    transport.options = null;
    transport.closeError = false;
    transport.construct = null;
    transport.open = null;
    transport.quiesce = null;
    transport.quiesceInsideClose = false;
});

describe('v12 status reentrancy (in memory)', () => {
    it('delivers old then current offline to both subscribers synchronously', async () => {
        const f = await fixture();
        const a: boolean[] = [];
        const b: boolean[] = [];
        let trigger = false;
        f.subscribe((event) => {
            a.push(event.status.good);

            if (trigger && event.status.good) {
                trigger = false;
                f.setOnline(false);
                f.runtime.statusUpdate();
            }
        });
        f.subscribe((event) => b.push(event.status.good));
        f.setOnline(true);
        trigger = true;
        f.runtime.statusUpdate();
        expect(a).toEqual([false, true, false]);
        expect(b).toEqual([false, true, false]);
        await f.runtime.close();
    });

    it('defers a status update raised inside the initial delivery', async () => {
        const f = await fixture();
        const order: string[] = [];
        f.subscribe((event) => order.push(`existing:${event.status.good}`));
        f.subscribe((event) => {
            order.push(`new:${event.status.good}`);

            if (!event.status.good) {
                f.setOnline(true);
                f.runtime.statusUpdate();
                order.push('initial-returning');
            }
        });
        expect(order).toEqual([
            'existing:false',
            'new:false',
            'initial-returning',
            'existing:true',
            'new:true',
        ]);
        await f.runtime.close();
    });

    it('excludes joins and removed or re-subscribed identities from an older snapshot', async () => {
        const f = await fixture();
        const b: boolean[] = [];
        const c: boolean[] = [];
        let alter = false;

        let release = () => {};

        const listener = (event: unknown) => b.push((event as StatusEvent).status.good);
        f.subscribe((event) => {
            if (alter && event.status.good) {
                alter = false;
                release();
                f.setOnline(false);
                release = f.options.subscribe(listener);
                f.subscribe((value) => c.push(value.status.good));
                f.runtime.statusUpdate();
            }
        });
        release = f.options.subscribe(listener);
        f.setOnline(true);
        alter = true;
        f.runtime.statusUpdate();
        expect(b).toEqual([false, false, false]);
        expect(c).toEqual([false, false]);
        release();
        await f.runtime.close();
    });

    it('isolates thrown consumers and mutations while retaining event identity', async () => {
        const f = await fixture();
        const logs: string[] = [];
        const stop = subscribeLogs((entry) => logs.push(entry.message));
        const received: StatusEvent[] = [];
        let active = false;
        let id = '';
        f.subscribe((event) => {
            if (active) {
                id = event.id;
                event.status.good = false;
                event.status.bots[0].self.user_id = 'poison';
                event.status.bots[0].online = false;
                event.status.bots.push({
                    self: { platform: 'bad', user_id: 'bad' },
                    online: false,
                });
                throw new Error('private-fixture');
            }
        });
        f.subscribe((event) => received.push(event));
        active = true;
        f.setOnline(true);
        f.runtime.statusUpdate();
        expect(received[1]).toMatchObject({
            id,
            status: { good: true, bots: [{ self: { user_id: '12345' }, online: true }] },
        });
        expect(received[1].status.bots).toHaveLength(1);
        const initial: StatusEvent[] = [];
        f.subscribe((event) => initial.push(event));
        expect(initial[0].status).toEqual(received[1].status);
        expect(logs.join(' ')).toContain('v12 event subscriber failed');
        expect(logs.join(' ')).not.toContain('private-fixture');
        stop();
        await f.runtime.close();
    });

    it('removes an initial throw and propagates it after deferred delivery', async () => {
        const f = await fixture();
        const values: boolean[] = [];
        f.subscribe((event) => values.push(event.status.good));
        const failure = new Error('initial');
        const callback = vi.fn(() => {
            f.setOnline(true);
            f.runtime.statusUpdate();
            throw failure;
        });
        expect(() => f.options.subscribe(callback)).toThrow(failure);
        expect(values).toEqual([false, true]);
        f.runtime.statusUpdate();
        expect(callback).toHaveBeenCalledTimes(1);
        await f.runtime.close();
    });

    it.each(['close', 'quiesce', 'forceClose'] as const)(
        'bounds storms with one immediate and cancels on %s',
        async (method) => {
            vi.useFakeTimers();
            const f = await fixture();
            let storm = false;
            let calls = 0;
            f.subscribe(() => {
                calls++;

                if (storm) {
                    f.setOnline(!(calls % 2 === 0));
                    f.runtime.statusUpdate();
                    f.runtime.statusUpdate();
                }
            });
            storm = true;
            f.runtime.statusUpdate();
            expect(calls).toBe(3);
            expect(vi.getTimerCount()).toBe(1);
            await f.runtime[method]();
            expect(vi.getTimerCount()).toBe(0);
            vi.runAllTimers();
            expect(calls).toBe(3);

            if (method !== 'close') {
                await f.runtime.close();
            }
        },
    );

    it('reads initial status once and leaves non-status event sharing unchanged', async () => {
        const f = await fixture();
        const seen: unknown[] = [];
        f.options.subscribe((event) => {
            const value = event as Record<string, unknown>;

            if (value.type === 'message') {
                value.fixture = 'shared';
            }
        });

        const repeated = (event: unknown) => {
            const value = event as Record<string, unknown>;

            if (value.type === 'message') {
                seen.push(value.fixture);
            }
        };

        f.options.subscribe(repeated);
        f.options.subscribe(repeated);
        expect(f.getStatus).toHaveBeenCalledTimes(3);
        f.runtime.onEvent({
            time: 1700000000,
            self_id: 12345,
            post_type: 'message',
            message_type: 'private',
            sub_type: 'friend',
            user_id: 20001,
            message_id: -10,
            message_seq: 5,
            raw_message: 'hi',
            message: [{ type: 'text', data: { text: 'hi' } }],
        });
        expect(seen).toEqual(['shared']);
        expect(f.getStatus).toHaveBeenCalledTimes(3);
        await f.runtime.close();
    });

    it('isolates logger failures from the initial error and subsequent fanout', async () => {
        const f = await fixture();
        const log = (f.runtime as unknown as { log: { warn: (message: string) => void } }).log;
        const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
        const brokenLog = vi.spyOn(log, 'warn').mockImplementation(() => {
            throw new Error('log secret');
        });
        const observed: boolean[] = [];
        f.subscribe((event) => observed.push(event.status.good));
        const failure = new Error('initial failure');
        const bad = vi.fn(() => {
            f.setOnline(true);
            f.runtime.statusUpdate();
            throw failure;
        });

        try {
            expect(() => f.options.subscribe(bad)).toThrow(failure);
            expect(observed).toEqual([false, true]);
            let throwLater = false;
            f.options.subscribe(() => {
                if (throwLater) {
                    throw new Error('secret');
                }
            });
            throwLater = true;
            f.runtime.statusUpdate();
            expect(observed).toEqual([false, true, true]);
            expect(bad).toHaveBeenCalledTimes(1);
            expect(warning).toHaveBeenCalledWith('v12 status diagnostic failed');
        } finally {
            brokenLog.mockRestore();
            warning.mockRestore();
            await f.runtime.close();
        }
    });

    it('cancels a storm on asynchronous transport error', async () => {
        vi.useFakeTimers();
        const f = await fixture();
        let storm = false;
        let calls = 0;
        f.subscribe(() => {
            calls++;

            if (storm) {
                f.runtime.statusUpdate();
            }
        });
        storm = true;
        f.runtime.statusUpdate();
        expect(vi.getTimerCount()).toBe(1);
        f.options.onError!(new Error('secret'));
        expect(vi.getTimerCount()).toBe(0);
        vi.runAllTimers();
        expect(calls).toBe(3);
        await f.runtime.close();
    });

    it('repeated immediate turns stay bounded to one pending handle', async () => {
        vi.useFakeTimers();
        const f = await fixture();
        let storm = false;
        let calls = 0;
        f.subscribe(() => {
            calls++;

            if (storm) {
                f.runtime.statusUpdate();
            }
        });
        storm = true;
        f.runtime.statusUpdate();

        for (let n = 0; n < 25; n++) {
            expect(vi.getTimerCount()).toBe(1);
            const before = calls;
            vi.advanceTimersToNextTimer();
            expect(calls - before).toBe(2);
        }

        await f.runtime.close();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops deferred status when initial callback synchronously closes', async () => {
        const f = await fixture();
        const seen: boolean[] = [];
        f.subscribe((event) => seen.push(event.status.good));
        let closing: Promise<void> | undefined;
        f.subscribe(() => {
            f.setOnline(true);
            f.runtime.statusUpdate();
            closing = f.runtime.close();
        });
        await closing;
        expect(seen).toEqual([false]);
    });

    it('keeps enabled state and pending timer when initial quiesce throws', async () => {
        vi.useFakeTimers();
        const f = await fixture();
        let storm = false;
        let calls = 0;
        f.subscribe(() => {
            calls++;

            if (storm) {
                f.runtime.statusUpdate();
            }
        });
        storm = true;
        f.runtime.statusUpdate();
        expect(vi.getTimerCount()).toBe(1);
        const failure = new Error('quiesce fixture');

        transport.quiesce = () => {
            throw failure;
        };

        await expect(f.runtime.close()).rejects.toBe(failure);
        expect(f.runtime.isActive).toBe(true);
        expect(vi.getTimerCount()).toBe(1);
        storm = false;
        vi.runAllTimers();
        expect(calls).toBe(4);
        transport.quiesce = null;
        await f.runtime.close();
    });

    it('sanitizes a second quiesce failure from transport close and retains its token', async () => {
        const f = await fixture();
        let count = 0;
        transport.quiesceInsideClose = true;

        transport.quiesce = () => {
            if (++count === 2) {
                throw new Error('close secret');
            }
        };

        await expect(f.runtime.close()).rejects.toThrow('v12 operation failed');
        expect(f.runtime.isActive).toBe(false);
        await expect(f.runtime.open()).rejects.toThrow('v12 listener has not been released');
        f.options.onError!(new Error('EACCES'));
        expect(f.runtime.hasApplyFailure).toBe(true);
        transport.quiesce = null;
        await f.runtime.close();
    });

    it('ignores retired errors while current errors cancel pending and remain observable', async () => {
        vi.useFakeTimers();
        const f = await fixture();
        const old = f.options;
        await f.runtime.close();
        await f.runtime.open();
        const current = transport.options!;
        let storm = false;
        let calls = 0;
        current.subscribe(() => {
            calls++;

            if (storm) {
                f.runtime.statusUpdate();
            }
        });
        storm = true;
        f.runtime.statusUpdate();
        expect(vi.getTimerCount()).toBe(1);
        old.onError!(new Error('old secret'));
        expect(f.runtime.isActive).toBe(true);
        expect(f.runtime.hasApplyFailure).toBe(false);
        expect(vi.getTimerCount()).toBe(1);
        const logs: string[] = [];
        const stop = subscribeLogs((entry) => logs.push(entry.message));
        current.onError!(new Error('EACCES'));
        expect(f.runtime.isActive).toBe(false);
        expect(f.runtime.hasApplyFailure).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        expect(logs.join(' ')).toContain('v12 listener failed');
        expect(logs.join(' ')).not.toContain('old secret');
        expect(calls).toBe(3);
        stop();
        await f.runtime.close();
    });

    it('retains a failed cleanup generation until successfully released', async () => {
        const f = await fixture();
        transport.closeError = true;
        await expect(f.runtime.close()).rejects.toThrow('v12 operation failed');
        await expect(f.runtime.open()).rejects.toThrow('v12 listener has not been released');
        f.options.onError!(new Error('EACCES'));
        expect(f.runtime.hasApplyFailure).toBe(true);
        transport.closeError = false;
        await f.runtime.close();
        f.runtime.clearApplyFailure();
        await f.runtime.open();
        f.options.onError!(new Error('EACCES'));
        expect(f.runtime.isActive).toBe(true);
        expect(f.runtime.hasApplyFailure).toBe(false);
        await f.runtime.close();
    });

    it('retires an open-failure generation only after successful cleanup', async () => {
        const f = createFixture();

        transport.open = async () => {
            throw new Error('open secret');
        };

        await expect(f.runtime.open()).rejects.toThrow('v12 operation failed');
        const old = transport.options!;
        transport.open = null;
        await f.runtime.open();
        old.onError!(new Error('EACCES'));
        expect(f.runtime.isActive).toBe(true);
        expect(f.runtime.hasApplyFailure).toBe(false);
        await f.runtime.close();
    });

    it('retains the generation when open and cleanup both fail until cleanup succeeds', async () => {
        const f = createFixture();
        const logs: string[] = [];
        const stop = subscribeLogs((entry) => logs.push(entry.message));

        transport.open = async () => {
            throw new Error('private open failure');
        };

        transport.closeError = true;

        try {
            await expect(f.runtime.open()).rejects.toMatchObject({
                message:
                    'v12 open failed: v12 operation failed; cleanup failed: v12 operation failed',
            });
            const old = transport.options!;
            await expect(f.runtime.open()).rejects.toThrow('v12 listener has not been released');
            old.onError!(new Error('EACCES'));
            expect(f.runtime.hasApplyFailure).toBe(true);
            expect(logs.join(' ')).toContain('v12 listener failed: EACCES');
            expect(logs.join(' ')).not.toContain('private open failure');
            transport.closeError = false;
            transport.open = null;
            await f.runtime.close();
            f.runtime.clearApplyFailure();
            await f.runtime.open();
            old.onError!(new Error('EACCES'));
            expect(f.runtime.isActive).toBe(true);
            expect(f.runtime.hasApplyFailure).toBe(false);
            await f.runtime.close();
        } finally {
            stop();
        }
    });

    it('retires a synthetic constructor callback generation after synchronous throw', async () => {
        const f = createFixture();
        const failure = new Error('constructor failure');
        let old: V12TransportOptions | null = null;

        transport.construct = (options) => {
            old = options;
            options.onError!(new Error('EACCES'));
            throw failure;
        };

        await expect(f.runtime.open()).rejects.toBe(failure);
        expect(f.runtime.hasApplyFailure).toBe(true);
        f.runtime.clearApplyFailure();
        transport.construct = null;
        await f.runtime.open();
        (old as unknown as V12TransportOptions).onError!(new Error('EACCES'));
        expect(f.runtime.isActive).toBe(true);
        expect(f.runtime.hasApplyFailure).toBe(false);
        await f.runtime.close();
    });

    it('handles constructor-time errors without reading an uninitialized transport', async () => {
        const f = createFixture();
        const logs: string[] = [];
        const stop = subscribeLogs((entry) => logs.push(entry.message));
        transport.construct = (options) => options.onError!(new Error('EACCES'));
        await f.runtime.open();
        expect(f.runtime.hasApplyFailure).toBe(true);
        expect(logs.join(' ')).toContain('v12 listener failed');
        await f.runtime.close();
        stop();
        const failure = new Error('constructor fixture');

        transport.construct = () => {
            throw failure;
        };

        await expect(f.runtime.open()).rejects.toBe(failure);
        transport.construct = null;
        await f.runtime.open();
        expect(f.runtime.isActive).toBe(true);
        await f.runtime.close();
    });

    it('does not cancel a newer timer when a synthetic overlapping old open rejects', async () => {
        vi.useFakeTimers();
        const f = createFixture();
        let rejectOld!: (error: Error) => void;
        transport.open = () =>
            new Promise<void>((_resolve, reject) => {
                rejectOld = reject;
            });
        const oldOpening = f.runtime.open();
        const old = transport.options!;
        // Simulate bypassing the manager FIFO; original cross-generation state
        // semantics remain outside this targeted timer ownership check.
        (f.runtime as unknown as { transport: null }).transport = null;
        transport.open = null;
        await f.runtime.open();
        const current = transport.options!;
        let storm = false;
        current.subscribe(() => {
            if (storm) {
                f.runtime.statusUpdate();
            }
        });
        storm = true;
        f.runtime.statusUpdate();
        expect(vi.getTimerCount()).toBe(1);
        rejectOld(new Error('old open failure'));
        await expect(oldOpening).rejects.toThrow('v12 operation failed');
        expect(vi.getTimerCount()).toBe(1);
        old.onError!(new Error('EACCES'));
        expect(vi.getTimerCount()).toBe(1);
        await f.runtime.close();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('retains observable close failure after cancelling pending work', async () => {
        vi.useFakeTimers();
        const f = await fixture();
        let storm = false;
        f.subscribe(() => {
            if (storm) {
                f.runtime.statusUpdate();
            }
        });
        storm = true;
        f.runtime.statusUpdate();
        expect(vi.getTimerCount()).toBe(1);
        transport.closeError = true;
        await expect(f.runtime.close()).rejects.toThrow('v12 operation failed');
        expect(vi.getTimerCount()).toBe(0);
        transport.closeError = false;
        await f.runtime.close();
    });
});
