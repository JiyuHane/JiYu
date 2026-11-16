import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V12TransportOptions } from '../../src/v12-network';
import type { V12ManagedConfig } from '../../src/v12-runtime/identity';

type FakeTransport = {
    options: V12TransportOptions;
    openCalls: number;
    closeCalls: number;
    quiesceCalls: number;
    forceCloseCalls: number;
    onOpen?: () => Promise<void>;
    onClose?: () => Promise<void>;
    onQuiesce?: () => void;
    onForceClose?: () => void;
};

const transport = vi.hoisted(() => ({
    instances: [] as FakeTransport[],
    onConstruct: null as null | ((instance: FakeTransport) => void),
}));

// No implementation from v12-network is loaded, and this fake owns no socket.
vi.mock('../../src/v12-network', () => ({
    V12Transport: class {
        private readonly instance: FakeTransport;

        constructor(options: V12TransportOptions) {
            this.instance = {
                options,
                openCalls: 0,
                closeCalls: 0,
                quiesceCalls: 0,
                forceCloseCalls: 0,
            };
            transport.instances.push(this.instance);
            transport.onConstruct?.(this.instance);
        }

        async open() {
            this.instance.openCalls++;
            await this.instance.onOpen?.();
        }

        async close() {
            this.instance.closeCalls++;
            await this.instance.onClose?.();
        }

        quiesce() {
            this.instance.quiesceCalls++;
            this.instance.onQuiesce?.();
        }

        forceClose() {
            this.instance.forceCloseCalls++;
            this.instance.onForceClose?.();
        }
    },
}));

// Other modules imported by the runtime must not acquire a real WebSocket either.
vi.mock('@snowluma/websocket', () => ({ WebSocket: class {}, WebSocketServer: class {} }));

import { V12Runtime } from '../../src/v12-runtime/runtime';
import { EventPollBuffer } from '../../src/v12-runtime/event-poll-buffer';
import * as pollOwner from '../../src/v12-runtime/poll-owner';

type Event = {
    id: string;
    time: number;
    type: string;
    detail_type: string;
    sub_type: string;
    interval?: number;
    status?: {
        good: boolean;
        bots: { self: { platform: string; user_id: string }; online: boolean }[];
    };
};

type Heartbeat = NonNullable<V12ManagedConfig['heartbeat']>;
const startTime = 1_700_000_000_000;
const runtimes: V12Runtime[] = [];

function config(heartbeat?: Heartbeat): V12ManagedConfig {
    return {
        name: 'OneBot v12',
        enabled: true,
        host: '127.0.0.1',
        port: 1,
        accessToken: '',
        allowNonLoopback: false,
        ...(heartbeat === undefined ? {} : { heartbeat }),
    };
}

function fixture(
    uin = '10001',
    heartbeat?: Heartbeat,
    getStatus: () => { good: boolean; online: boolean } = () => ({ good: true, online: true }),
) {
    const initial = config(heartbeat);
    const runtime = new V12Runtime(
        initial,
        {
            uin,
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
    runtimes.push(runtime);

    return {
        runtime,
        initial,
        async open(): Promise<FakeTransport> {
            const index = transport.instances.length;
            await runtime.open();
            expect(transport.instances).toHaveLength(index + 1);
            const instance = transport.instances[index]!;
            expect(instance.openCalls).toBe(1);
            return instance;
        },
    };
}

/** Simulate the transport's connect-before-subscribe ordering in memory. */
function connect(instance: FakeTransport, onEvent?: (event: Event) => void) {
    const events: Event[] = [structuredClone(instance.options.getConnectEvent() as Event)];
    const unsubscribe = instance.options.subscribe((value) => {
        const event = value as Event;
        events.push(structuredClone(event));
        onEvent?.(event);
    });
    return { events, unsubscribe };
}

function heartbeats(events: Event[]): Event[] {
    return events.filter((event) => event.detail_type === 'heartbeat');
}

/** Retain a callback independently of clearInterval/clearTimeout to probe stale work. */
function watchTimerCallbacks() {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const timeouts = vi.spyOn(globalThis, 'setTimeout');

    return (delay: number): (() => void) => {
        const calls = [...intervals.mock.calls, ...timeouts.mock.calls];
        const callback = calls.filter((args) => args[1] === delay).at(-1)?.[0];

        if (typeof callback !== 'function') {
            throw new Error(`fixture did not capture a ${delay}ms timer callback`);
        }

        return callback as () => void;
    };
}

function deferred() {
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(startTime);
    transport.instances.length = 0;
    transport.onConstruct = null;
    runtimes.length = 0;
});

afterEach(async () => {
    try {
        transport.onConstruct = null;

        for (const instance of transport.instances) {
            instance.onOpen = undefined;
            instance.onClose = undefined;
            instance.onQuiesce = undefined;
            instance.onForceClose = undefined;
        }

        for (const runtime of runtimes) {
            await runtime.close();
        }

        expect(vi.getTimerCount()).toBe(0);
    } finally {
        vi.clearAllTimers();
        vi.restoreAllMocks();
        vi.useRealTimers();
        transport.instances.length = 0;
        runtimes.length = 0;
    }
});

describe('v12 heartbeat runtime (in-memory transport)', () => {
    it.each([
        ['omitted', undefined],
        ['disabled', { enabled: false, interval: 1 }],
    ] as const)(
        'leaves the legacy %s configuration without a heartbeat timer',
        async (_name, hb) => {
            const f = fixture('10001', hb);
            const fake = await f.open();
            const client = connect(fake);
            expect(client.events.map((event) => event.detail_type)).toEqual([
                'connect',
                'status_update',
            ]);
            expect(vi.getTimerCount()).toBe(0);
            vi.advanceTimersByTime(10_000);
            expect(heartbeats(client.events)).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it('keeps accounts isolated and protects each subscriber from same-tick mutation', async () => {
        const enqueue = vi.spyOn(pollOwner, 'enqueuePollEvent');
        const enqueueBuffer = vi.spyOn(EventPollBuffer.prototype, 'enqueue');
        const a = fixture('10001', { enabled: true, interval: 10 });
        const b = fixture('10002', { enabled: true, interval: 10 });
        const aTransport = await a.open();
        const bTransport = await b.open();
        const first = connect(aTransport, (event) => {
            if (event.detail_type === 'heartbeat') {
                event.id = 'corrupted';
                event.time = 0;
                event.interval = 999;
            }
        });
        const second = connect(aTransport);
        const other = connect(bTransport);
        expect(first.events[1].status?.bots[0].self.user_id).toBe('10001');
        expect(second.events[1].status?.bots[0].self.user_id).toBe('10001');
        expect(other.events[1].status?.bots[0].self.user_id).toBe('10002');
        expect(vi.getTimerCount()).toBe(2);
        vi.advanceTimersByTime(9);
        expect(heartbeats(first.events)).toEqual([]);
        expect(heartbeats(other.events)).toEqual([]);
        vi.advanceTimersByTime(1);
        const aFirst = heartbeats(first.events)[0]!;
        const aSecond = heartbeats(second.events)[0]!;
        const bFirst = heartbeats(other.events)[0]!;

        for (const event of [aFirst, aSecond, bFirst]) {
            expect(event).toMatchObject({
                type: 'meta',
                detail_type: 'heartbeat',
                sub_type: '',
                time: (startTime + 10) / 1000,
                interval: 10,
            });
            expect(event.id).toEqual(expect.any(String));
            expect(event.id.length).toBeGreaterThan(0);
            expect(event.id).not.toBe('corrupted');
        }

        // Each account constructs its own tick; listeners of one tick see the same id.
        expect(aFirst.id).toBe(aSecond.id);
        expect(bFirst.id).not.toBe(aFirst.id);
        expect(enqueue).not.toHaveBeenCalled();
        vi.advanceTimersByTime(20);
        expect(heartbeats(first.events)).toHaveLength(3);
        expect(heartbeats(second.events)).toHaveLength(3);
        expect(heartbeats(other.events)).toHaveLength(3);
        expect(new Set(heartbeats(second.events).map((event) => event.id)).size).toBe(3);
        expect(enqueue).not.toHaveBeenCalled();
        expect(enqueueBuffer).not.toHaveBeenCalled();
    });

    it('emits each 1ms interval with seconds timestamps and a fresh id', async () => {
        const f = fixture('10001', { enabled: true, interval: 1 });
        const client = connect(await f.open());
        expect(heartbeats(client.events)).toEqual([]);
        vi.advanceTimersByTime(5);
        const events = heartbeats(client.events);
        expect(events).toHaveLength(5);
        expect(events.map((event) => event.time)).toEqual(
            Array.from({ length: 5 }, (_, index) => (startTime + index + 1) / 1000),
        );
        expect(events.every((event) => event.interval === 1)).toBe(true);
        expect(new Set(events.map((event) => event.id)).size).toBe(5);
        expect(events.every((event) => typeof event.id === 'string' && event.id.length > 0)).toBe(
            true,
        );
    });

    it.each(['close', 'quiesce', 'forceClose', 'onError'] as const)(
        '%s revokes only its own timer even if its cleared callback runs later',
        async (method) => {
            const timer = watchTimerCallbacks();
            const a = fixture('10001', { enabled: true, interval: 11 });
            const b = fixture('10002', { enabled: true, interval: 17 });
            const oldTransport = await a.open();
            const stale = timer(11);
            const otherTransport = await b.open();
            const first = connect(oldTransport);
            const other = connect(otherTransport);
            vi.advanceTimersByTime(11);
            expect(heartbeats(first.events)).toHaveLength(1);

            if (method === 'onError') {
                oldTransport.options.onError!(new Error('EACCES'));
                expect(a.runtime.isActive).toBe(false);
                expect(a.runtime.hasApplyFailure).toBe(true);
            } else {
                await a.runtime[method]();
            }

            expect(vi.getTimerCount()).toBe(1);
            stale();
            expect(heartbeats(first.events)).toHaveLength(1);
            vi.advanceTimersByTime(34);
            expect(heartbeats(first.events)).toHaveLength(1);
            expect(heartbeats(other.events)).toHaveLength(2);
            expect(b.runtime.isActive).toBe(true);
        },
    );

    it('keeps a reopened generation separate from old timer and error callbacks', async () => {
        const timer = watchTimerCallbacks();
        const f = fixture('10001', { enabled: true, interval: 13 });
        const oldTransport = await f.open();
        const old = connect(oldTransport);
        const stale = timer(13);
        vi.advanceTimersByTime(13);
        expect(heartbeats(old.events)).toHaveLength(1);
        await f.runtime.close();
        expect(vi.getTimerCount()).toBe(0);
        const currentTransport = await f.open();
        const current = connect(currentTransport);
        expect(vi.getTimerCount()).toBe(1);
        stale();
        oldTransport.options.onError!(new Error('EACCES'));
        expect(f.runtime.isActive).toBe(true);
        expect(f.runtime.hasApplyFailure).toBe(false);
        expect(heartbeats(current.events)).toEqual([]);
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(13);
        expect(heartbeats(old.events)).toHaveLength(1);
        expect(heartbeats(current.events)).toHaveLength(1);
    });

    it('stops and retains the transport when close quiesce throws with heartbeat enabled', async () => {
        const timer = watchTimerCallbacks();
        const f = fixture('10001', { enabled: true, interval: 19 });
        const fake = await f.open();
        const client = connect(fake);
        const stale = timer(19);
        const failure = new Error('synthetic quiesce failure');
        let partiallyQuiesced = false;

        fake.onQuiesce = () => {
            partiallyQuiesced = true;
            throw failure;
        };

        await expect(f.runtime.close()).rejects.toBe(failure);
        expect(partiallyQuiesced).toBe(true);
        expect(f.runtime.isActive).toBe(false);
        expect(fake.closeCalls).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        await expect(f.runtime.open()).rejects.toThrow('v12 listener has not been released');
        stale();
        vi.advanceTimersByTime(100);
        expect(heartbeats(client.events)).toEqual([]);
        fake.onQuiesce = undefined;
        await f.runtime.close();
        expect(fake.closeCalls).toBe(1);
        const reopened = connect(await f.open());
        vi.advanceTimersByTime(19);
        expect(heartbeats(reopened.events)).toHaveLength(1);
    });

    async function expectNestedShutdownToFailClosed(method: 'quiesce' | 'forceClose') {
        const timer = watchTimerCallbacks();
        const f = fixture('10001', { enabled: true, interval: 73 });
        const fake = await f.open();
        const client = connect(fake);
        const stale = timer(73);
        const failure = new Error('synthetic outer quiesce failure');
        let quiesceAttempts = 0;

        fake.onQuiesce = () => {
            quiesceAttempts++;

            if (quiesceAttempts === 1) {
                // The nested call must finish before the original quiesce throws.
                // A nested quiesce calls this hook a second time and succeeds.
                f.runtime[method]();
                throw failure;
            }
        };

        expect(f.runtime.isActive).toBe(true);
        expect(vi.getTimerCount()).toBe(1);
        await expect(f.runtime.close()).rejects.toBe(failure);
        expect(quiesceAttempts).toBe(method === 'quiesce' ? 2 : 1);
        expect(fake.forceCloseCalls).toBe(method === 'forceClose' ? 1 : 0);
        expect(f.runtime.isActive).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(fake.closeCalls).toBe(0);
        stale();
        vi.advanceTimersByTime(146);
        expect(heartbeats(client.events)).toEqual([]);
        fake.onQuiesce = undefined;
        await f.runtime.close();
        expect(fake.closeCalls).toBe(1);
    }

    it('fails closed when outer close quiesce reenters quiesce and then throws', async () => {
        await expectNestedShutdownToFailClosed('quiesce');
    });

    it('fails closed when outer close quiesce reenters forceClose and then throws', async () => {
        await expectNestedShutdownToFailClosed('forceClose');
    });

    it.each(['quiesce', 'forceClose'] as const)(
        'fails closed if close quiesce throws after an earlier %s',
        async (method) => {
            const f = fixture('10001', { enabled: true, interval: 21 });
            const fake = await f.open();
            f.runtime[method]();
            expect(vi.getTimerCount()).toBe(0);
            const failure = new Error('synthetic later quiesce failure');

            fake.onQuiesce = () => {
                throw failure;
            };

            await expect(f.runtime.close()).rejects.toBe(failure);
            expect(f.runtime.isActive).toBe(false);
            expect(fake.closeCalls).toBe(0);
            await expect(f.runtime.open()).rejects.toThrow();
            fake.onQuiesce = undefined;
            await f.runtime.close();
            expect(fake.closeCalls).toBe(1);
        },
    );

    it.each([
        ['omitted', undefined],
        ['disabled', { enabled: false, interval: 20 }],
    ] as const)(
        'preserves the old %s close-quiesce failure and pending status semantics',
        async (_name, heartbeat) => {
            const f = fixture('10001', heartbeat);
            const fake = await f.open();
            let storm = false;
            let calls = 0;
            fake.options.subscribe(() => {
                calls++;

                if (storm) {
                    f.runtime.statusUpdate();
                }
            });
            storm = true;
            f.runtime.statusUpdate();
            expect(calls).toBe(3);
            expect(vi.getTimerCount()).toBe(1);
            const failure = new Error('synthetic quiesce failure');

            fake.onQuiesce = () => {
                throw failure;
            };

            await expect(f.runtime.close()).rejects.toBe(failure);
            expect(f.runtime.isActive).toBe(true);
            expect(fake.closeCalls).toBe(0);
            expect(vi.getTimerCount()).toBe(1);
            storm = false;
            vi.advanceTimersToNextTimer();
            expect(calls).toBe(4);
            fake.onQuiesce = undefined;
            await f.runtime.close();
        },
    );

    it('stops the timer and keeps the transport on an asynchronous close failure', async () => {
        const timer = watchTimerCallbacks();
        const f = fixture('10001', { enabled: true, interval: 23 });
        const fake = await f.open();
        const client = connect(fake);
        const stale = timer(23);

        fake.onClose = async () => {
            throw new Error('synthetic close failure');
        };

        await expect(f.runtime.close()).rejects.toThrow('v12 operation failed');
        expect(f.runtime.isActive).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        await expect(f.runtime.open()).rejects.toThrow('v12 listener has not been released');
        stale();
        expect(heartbeats(client.events)).toEqual([]);
        fake.onClose = undefined;
        await f.runtime.close();
    });

    it('starts its first interval only after the controlled open succeeds', async () => {
        const gate = deferred();

        transport.onConstruct = (instance) => {
            instance.onOpen = () => gate.promise;
        };

        const f = fixture('10001', { enabled: true, interval: 27 });
        const opening = f.runtime.open();
        const fake = transport.instances[0]!;
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(1000);
        expect(vi.getTimerCount()).toBe(0);
        gate.resolve();
        await opening;
        const client = connect(fake);
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(26);
        expect(heartbeats(client.events)).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(heartbeats(client.events)).toMatchObject([
            { time: (startTime + 1027) / 1000, interval: 27 },
        ]);
    });

    it('does not start a timer after open rejects, and permits a clean retry', async () => {
        transport.onConstruct = (instance) => {
            instance.onOpen = async () => {
                throw new Error('synthetic open failure');
            };
        };

        const f = fixture('10001', { enabled: true, interval: 29 });
        await expect(f.runtime.open()).rejects.toThrow('v12 operation failed');
        expect(f.runtime.isActive).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(transport.instances[0]!.closeCalls).toBe(1);
        transport.onConstruct = null;
        const client = connect(await f.open());
        vi.advanceTimersByTime(29);
        expect(heartbeats(client.events)).toHaveLength(1);
    });

    it.each(['resolve', 'reject'] as const)(
        'a late old open %s neither starts a timer nor cancels the new generation',
        async (outcome) => {
            const gate = deferred();

            transport.onConstruct = (instance) => {
                instance.onOpen = () => gate.promise;
            };

            const f = fixture('10001', { enabled: true, interval: 31 });
            const opening = f.runtime.open();
            const oldTransport = transport.instances[0]!;
            expect(vi.getTimerCount()).toBe(0);
            await f.runtime.close();
            transport.onConstruct = null;
            const client = connect(await f.open());
            expect(vi.getTimerCount()).toBe(1);

            if (outcome === 'resolve') {
                gate.resolve();
            } else {
                gate.reject(new Error('synthetic late open failure'));
            }

            await expect(opening).rejects.toThrow('v12 operation failed');
            expect(transport.instances[1]!.closeCalls).toBe(0);
            oldTransport.options.onError!(new Error('EACCES'));
            expect(f.runtime.isActive).toBe(true);
            expect(vi.getTimerCount()).toBe(1);
            vi.advanceTimersByTime(31);
            expect(heartbeats(client.events)).toHaveLength(1);
        },
    );

    it('does not revive an opening transport after its error callback', async () => {
        const gate = deferred();

        transport.onConstruct = (instance) => {
            instance.onOpen = () => gate.promise;
        };

        const f = fixture('10001', { enabled: true, interval: 37 });
        const opening = f.runtime.open();
        const fake = transport.instances[0]!;
        fake.options.onError!(new Error('EACCES'));
        gate.resolve();
        await expect(opening).rejects.toThrow('v12 operation failed');
        expect(fake.closeCalls).toBe(1);
        expect(f.runtime.isActive).toBe(false);
        expect(f.runtime.hasApplyFailure).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('limits late error cleanup to its old transport after a new generation opens', async () => {
        const gate = deferred();

        transport.onConstruct = (instance) => {
            instance.onOpen = () => gate.promise;
        };

        const f = fixture('10001', { enabled: true, interval: 39 });
        const opening = f.runtime.open();
        const oldTransport = transport.instances[0]!;
        oldTransport.options.onError!(new Error('EACCES'));
        await f.runtime.close();
        transport.onConstruct = null;
        const currentTransport = await f.open();
        const current = connect(currentTransport);
        gate.resolve();
        await expect(opening).rejects.toThrow('v12 operation failed');
        expect(oldTransport.closeCalls).toBeGreaterThanOrEqual(1);
        expect(currentTransport.closeCalls).toBe(0);
        expect(f.runtime.isActive).toBe(true);
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(39);
        expect(heartbeats(current.events)).toHaveLength(1);
    });

    it.each([
        ['omitted', undefined],
        ['disabled', { enabled: false, interval: 37 }],
    ] as const)(
        'retains legacy %s open-settlement behavior after an opening error',
        async (_name, heartbeat) => {
            const gate = deferred();

            transport.onConstruct = (instance) => {
                instance.onOpen = () => gate.promise;
            };

            const f = fixture('10001', heartbeat);
            const opening = f.runtime.open();
            transport.instances[0]!.options.onError!(new Error('EACCES'));
            gate.resolve();
            await expect(opening).resolves.toBeUndefined();
            expect(f.runtime.isActive).toBe(true);
            expect(f.runtime.hasApplyFailure).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it.each(['quiesce', 'forceClose'] as const)(
        '%s before open settles prevents a late timer',
        async (method) => {
            const gate = deferred();

            transport.onConstruct = (instance) => {
                instance.onOpen = () => gate.promise;
            };

            const f = fixture('10001', { enabled: true, interval: 41 });
            const opening = f.runtime.open();
            f.runtime[method]();
            gate.resolve();
            await opening.catch(() => undefined);
            expect(f.runtime.isActive).toBe(false);
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it.each([
        ['omitted', undefined],
        ['disabled', { enabled: false, interval: 71 }],
    ] as const)(
        'fails closed when reload enables heartbeat from %s and old quiesce throws',
        async (_name, heartbeat) => {
            const f = fixture('10001', heartbeat);
            const fake = await f.open();
            const desired = config({ enabled: true, interval: 71 });
            const failure = new Error('synthetic reload quiesce failure');
            let partiallyQuiesced = false;

            fake.onQuiesce = () => {
                partiallyQuiesced = true;
                throw failure;
            };

            await expect(f.runtime.reload(desired)).rejects.toBe(failure);
            expect(partiallyQuiesced).toBe(true);
            expect(f.runtime.isActive).toBe(false);
            expect(f.runtime.currentConfig).toEqual(f.initial);
            expect(transport.instances).toHaveLength(1);
            expect(fake.closeCalls).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
            await expect(f.runtime.open()).rejects.toThrow('v12 listener has not been released');
            fake.onQuiesce = undefined;
            await f.runtime.close();
            expect(fake.closeCalls).toBe(1);

            // The failed enabling attempt must not leak its scope to a new,
            // still-disabled transport's ordinary close failure.
            const disabledTransport = await f.open();

            disabledTransport.onQuiesce = () => {
                throw failure;
            };

            await expect(f.runtime.close()).rejects.toBe(failure);
            expect(f.runtime.isActive).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
            disabledTransport.onQuiesce = undefined;
            await f.runtime.close();
            await f.runtime.reload(desired);
            expect(transport.instances).toHaveLength(3);
            expect(f.runtime.isActive).toBe(true);
            const current = connect(transport.instances[2]!);
            vi.advanceTimersByTime(71);
            expect(heartbeats(current.events)).toHaveLength(1);
        },
    );

    it.each([
        ['omitted to omitted', undefined, undefined],
        ['disabled to disabled', { enabled: false, interval: 1 }, { enabled: false, interval: 2 }],
        ['omitted to disabled', undefined, { enabled: false, interval: 2 }],
    ] as const)(
        'retains legacy pending-status behavior when %s reload quiesce throws',
        async (_name, oldHeartbeat, nextHeartbeat) => {
            const f = fixture('10001', oldHeartbeat);
            const fake = await f.open();
            let storm = false;
            let calls = 0;
            fake.options.subscribe(() => {
                calls++;

                if (storm) {
                    f.runtime.statusUpdate();
                }
            });
            storm = true;
            f.runtime.statusUpdate();
            expect(calls).toBe(3);
            expect(vi.getTimerCount()).toBe(1);
            const desired = { ...config(nextHeartbeat), port: 2 };
            const failure = new Error('synthetic legacy reload failure');

            fake.onQuiesce = () => {
                throw failure;
            };

            await expect(f.runtime.reload(desired)).rejects.toBe(failure);
            expect(f.runtime.isActive).toBe(true);
            expect(f.runtime.currentConfig).toEqual(f.initial);
            expect(transport.instances).toHaveLength(1);
            expect(fake.closeCalls).toBe(0);
            expect(vi.getTimerCount()).toBe(1);
            storm = false;
            vi.advanceTimersToNextTimer();
            expect(calls).toBe(4);
            fake.onQuiesce = undefined;
        },
    );

    it('reopens on enabled or interval changes, but treats disabled and omitted alike', async () => {
        const timer = watchTimerCallbacks();
        const f = fixture();
        const initial = await f.open();
        await f.runtime.reload(config({ enabled: false, interval: 1 }));
        expect(transport.instances).toHaveLength(1);
        expect(initial.closeCalls).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        await f.runtime.reload(config());
        expect(transport.instances).toHaveLength(1);
        await f.runtime.reload(config({ enabled: true, interval: 43 }));
        expect(transport.instances).toHaveLength(2);
        expect(initial.closeCalls).toBe(1);
        const firstTransport = transport.instances[1]!;
        const first = connect(firstTransport);
        const stale = timer(43);
        expect(vi.getTimerCount()).toBe(1);
        await f.runtime.reload(config({ enabled: true, interval: 43 }));
        expect(transport.instances).toHaveLength(2);
        expect(firstTransport.closeCalls).toBe(0);
        await f.runtime.reload(config({ enabled: true, interval: 7 }));
        expect(transport.instances).toHaveLength(3);
        expect(firstTransport.closeCalls).toBe(1);
        const current = connect(transport.instances[2]!);
        expect(vi.getTimerCount()).toBe(1);
        stale();
        expect(heartbeats(first.events)).toEqual([]);
        expect(heartbeats(current.events)).toEqual([]);
        vi.advanceTimersByTime(14);
        expect(heartbeats(current.events).map((event) => event.interval)).toEqual([7, 7]);
        await f.runtime.reload(config({ enabled: false, interval: 7 }));
        expect(transport.instances).toHaveLength(4);
        expect(vi.getTimerCount()).toBe(0);
        await f.runtime.reload(config({ enabled: false, interval: 999 }));
        await f.runtime.reload(config());
        expect(transport.instances).toHaveLength(4);
        vi.advanceTimersByTime(100);
        expect(heartbeats(current.events)).toHaveLength(2);
    });

    it('supports self-unsubscribe and excludes a re-subscribed listener from an old tick', async () => {
        const f = fixture('10001', { enabled: true, interval: 47 });
        const fake = await f.open();
        const first: Event[] = [];
        const second: Event[] = [];

        let unsubscribeFirst = () => {};

        let unsubscribeSecond = () => {};

        let staleUnsubscribe = () => {};

        const secondListener = (value: unknown) => second.push(structuredClone(value as Event));
        unsubscribeFirst = fake.options.subscribe((value) => {
            const event = value as Event;
            first.push(structuredClone(event));

            if (event.detail_type === 'heartbeat') {
                unsubscribeFirst();
                staleUnsubscribe = unsubscribeSecond;
                unsubscribeSecond();
                unsubscribeSecond = fake.options.subscribe(secondListener);
                staleUnsubscribe();
            }
        });
        unsubscribeSecond = fake.options.subscribe(secondListener);
        vi.advanceTimersByTime(47);
        expect(first.map((event) => event.detail_type)).toEqual(['status_update', 'heartbeat']);
        expect(second.map((event) => event.detail_type)).toEqual([
            'status_update',
            'status_update',
        ]);
        vi.advanceTimersByTime(47);
        expect(heartbeats(first)).toHaveLength(1);
        expect(heartbeats(second)).toHaveLength(1);
        unsubscribeSecond();
    });

    it.each(['close', 'quiesce', 'forceClose', 'onError'] as const)(
        'stops fanout when a subscriber synchronously triggers %s',
        async (method) => {
            const f = fixture('10001', { enabled: true, interval: 53 });
            const fake = await f.open();
            let closing: Promise<void> | undefined;
            const first = connect(fake, (event) => {
                if (event.detail_type === 'heartbeat') {
                    if (method === 'onError') {
                        fake.options.onError!(new Error('EACCES'));
                    } else if (method === 'close') {
                        closing = f.runtime.close();
                    } else {
                        f.runtime[method]();
                    }
                }
            });
            const second = connect(fake);
            vi.advanceTimersByTime(53);
            await closing;
            expect(heartbeats(first.events)).toHaveLength(1);
            expect(heartbeats(second.events)).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it('does not recursively fan out a reentered timer callback', async () => {
        const timer = watchTimerCallbacks();
        const f = fixture('10001', { enabled: true, interval: 57 });
        const fake = await f.open();
        const reenter = timer(57);
        let entered = false;
        const first = connect(fake, (event) => {
            if (event.detail_type === 'heartbeat' && !entered) {
                entered = true;
                reenter();
            }
        });
        const second = connect(fake);
        vi.advanceTimersByTime(57);
        expect(heartbeats(first.events)).toHaveLength(1);
        expect(heartbeats(second.events)).toHaveLength(1);
        expect(heartbeats(first.events)[0]!.id).toBe(heartbeats(second.events)[0]!.id);
        vi.advanceTimersByTime(57);
        expect(heartbeats(first.events)).toHaveLength(2);
        expect(heartbeats(second.events)).toHaveLength(2);
    });

    it.each(['build', 'delivery'] as const)(
        'skips a tick reentered during initial status %s and preserves ordering',
        async (phase) => {
            let armed = false;
            const f = fixture('10001', { enabled: true, interval: 59 }, () => {
                if (phase === 'build' && armed) {
                    armed = false;
                    vi.advanceTimersByTime(59);
                }

                return { good: true, online: true };
            });
            const fake = await f.open();
            const existing = connect(fake);
            armed = true;
            const incoming = connect(fake, (event) => {
                if (phase === 'delivery' && armed && event.detail_type === 'status_update') {
                    armed = false;
                    vi.advanceTimersByTime(59);
                }
            });
            expect(incoming.events.map((event) => event.detail_type)).toEqual([
                'connect',
                'status_update',
            ]);
            expect(heartbeats(existing.events)).toEqual([]);
            vi.advanceTimersByTime(59);
            expect(heartbeats(incoming.events)).toHaveLength(1);
            expect(heartbeats(existing.events)).toHaveLength(1);
        },
    );

    it('continues delivery after a heartbeat listener throws', async () => {
        const f = fixture('10001', { enabled: true, interval: 61 });
        const fake = await f.open();
        const bad = connect(fake, (event) => {
            if (event.detail_type === 'heartbeat') {
                throw new Error('synthetic listener failure');
            }
        });
        const good = connect(fake);
        vi.advanceTimersByTime(122);
        expect(heartbeats(bad.events)).toHaveLength(2);
        expect(heartbeats(good.events)).toHaveLength(2);
        expect(heartbeats(good.events).map((event) => event.id)).toEqual(
            heartbeats(bad.events).map((event) => event.id),
        );
        expect(f.runtime.isActive).toBe(true);
    });
});
