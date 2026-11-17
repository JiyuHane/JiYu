import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V12TransportOptions } from '../../src/v12-network';
import type { DispatchPayload } from '../../src/event-filter';
import type { JsonObject, NetworkBase } from '../../src/types';

// The runtime and generation/manager are real. Neither the fake transport nor
// the mocked poll functions create a listener, connection, queue, or poll owner.
const fake = vi.hoisted(() => ({
    transports: [] as Array<{ options: V12TransportOptions }>,
    trace: [] as string[],
    registerPollHost: vi.fn(),
    activateHttpPollOwner: vi.fn(),
    hasHttpPollOwner: vi.fn(),
    pollOwnerStats: vi.fn(),
    failOrderedPollIngress: vi.fn(),
    hasOrderedPollOwner: vi.fn(),
    enqueuePollEvent: vi.fn(),
    invalidatePollOwner: vi.fn(),
    invalidateStalePollOwner: vi.fn(),
    recordPreparedScopeLoss: vi.fn(),
}));

vi.mock('@snowluma/websocket', () => ({
    WebSocket: class {
        constructor() {
            throw new Error('unexpected WebSocket construction');
        }
    },
    WebSocketServer: class {
        constructor() {
            throw new Error('unexpected WebSocketServer construction');
        }
    },
}));
// This fake omits isAcceptingActions: event activation checks its source guard,
// then remains unavailable. Poll markers below do not imply real HTTP readiness.
vi.mock('../../src/v12-network', () => ({
    V12Transport: class {
        constructor(options: V12TransportOptions) {
            fake.transports.push({ options });
        }
        async open() {}
        async close() {}
        quiesce() {}
        forceClose() {}
    },
}));
vi.mock('../../src/v12-runtime/poll-owner', () => ({
    registerPollHost: fake.registerPollHost,
    activateHttpPollOwner: fake.activateHttpPollOwner,
    hasHttpPollOwner: fake.hasHttpPollOwner,
    pollOwnerStats: fake.pollOwnerStats,
    failOrderedPollIngress: fake.failOrderedPollIngress,
    hasOrderedPollOwner: fake.hasOrderedPollOwner,
    enqueuePollEvent: fake.enqueuePollEvent,
    invalidatePollOwner: fake.invalidatePollOwner,
    invalidateStalePollOwner: fake.invalidateStalePollOwner,
    recordPreparedScopeLoss: fake.recordPreparedScopeLoss,
    isCurrentOrderedFacade: vi.fn(() => false),
}));

import { IOneBotNetworkAdapter } from '../../src/network/adapter';
import { OneBotNetworkManager } from '../../src/network/network-manager';
import { V12_ADAPTER_NAME } from '../../src/v12-runtime/identity';
import { V12Runtime } from '../../src/v12-runtime/runtime';
import {
    captureBinding,
    receiveSourceEvent,
    SourceGeneration,
    withOrderedScope,
    type OrderedAdmission,
    type V12Source,
} from '../../src/v12-runtime/source-generation';

type SeenEvent = { type: string; detail_type: string; message_id?: string; group_id?: string };
type MessageKind = 'private' | 'group';
const runtimes: V12Runtime[] = [];

class LegacySink extends IOneBotNetworkAdapter<NetworkBase> {
    readonly received = vi.fn((_event: JsonObject, _payload: DispatchPayload) => {
        fake.trace.push('v11');
    });

    constructor() {
        super(
            'synthetic-v11',
            {
                name: 'synthetic-v11',
                enabled: true,
                messageFormat: 'array',
                reportSelfMessage: false,
            },
            {
                uin: '12345',
                api: {} as never,
                buildLifecycleEvent: () => ({}),
                buildHeartbeatEvent: () => ({}),
            },
        );
    }

    protected bindingSignature(): string {
        return 'synthetic-v11';
    }

    open() {
        this.isEnabled = true;
    }

    close() {
        this.isEnabled = false;
    }

    onEvent(event: JsonObject, payload: DispatchPayload) {
        this.received(event, payload);
    }

    describeStatus() {
        return {
            name: this.name,
            kind: 'httpClient' as const,
            status: 'ok' as const,
            detail: 'synthetic',
        };
    }
}

function message(kind: MessageKind, id: number): JsonObject {
    return {
        post_type: 'message',
        self_id: 12345,
        user_id: 23456,
        message_id: id,
        time: 1,
        message_type: kind,
        sub_type: kind === 'private' ? 'friend' : 'normal',
        ...(kind === 'group' ? { group_id: 34567 } : {}),
        raw_message: `synthetic-${id}`,
        message: [{ type: 'text', data: { text: `synthetic-${id}` } }],
    };
}

function messages(events: SeenEvent[]) {
    return events.filter((event) => event.type === 'message');
}

function observe(options: V12TransportOptions, hook?: (event: SeenEvent) => void) {
    // Reproduce only the fake transport's connect-before-subscribe contract.
    const events: SeenEvent[] = [options.getConnectEvent() as SeenEvent];

    const listener = (value: unknown) => {
        const event = value as SeenEvent;
        events.push(event);
        hook?.(event);
    };

    const unsubscribe = options.subscribe(listener);
    return { events, listener, unsubscribe };
}

async function fixture(heartbeat = false) {
    const generation = new SourceGeneration();
    generation.setOnline(true);
    const manager = new OneBotNetworkManager();
    const legacy = new LegacySink();
    legacy.open();
    let runtime!: V12Runtime;
    let verifyHook: (() => void) | undefined;
    const verify = vi.fn((source: V12Source | undefined, binding: object | null) => {
        fake.trace.push('verify');
        verifyHook?.();
        return manager.get(V12_ADAPTER_NAME) === runtime && generation.isCurrent(source, binding);
    });
    runtime = new V12Runtime(
        {
            name: V12_ADAPTER_NAME,
            enabled: true,
            host: 'synthetic',
            port: 1,
            accessToken: '',
            allowNonLoopback: false,
            messageFormat: 'array',
            reportSelfMessage: false,
            ...(heartbeat ? { heartbeat: { enabled: true, interval: 10 } } : {}),
        },
        {
            uin: '12345',
            api: {} as never,
            buildLifecycleEvent: () => ({}),
            buildHeartbeatEvent: () => ({}),
        },
        {
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: async () => null,
            trackAction: (_label, start) => start(),
            canAccept: () => true,
            captureCurrentSource: () => generation.capture(runtime[captureBinding]()),
            isSourceCurrent: verify,
        },
    );
    runtimes.push(runtime);
    manager.register(runtime);
    manager.register(legacy);
    await runtime.open();
    const options = fake.transports.at(-1)?.options;

    if (!options) {
        throw new Error('fake transport did not construct');
    }

    const ticket = () => {
        const value = generation.capture(runtime[captureBinding]());

        if (!value) {
            throw new Error('synthetic source binding unavailable');
        }

        return value;
    };

    const rotate = () => {
        generation.setOnline(false);
        generation.setOnline(true);
    };

    return {
        manager,
        runtime,
        generation,
        legacy,
        options,
        ticket,
        rotate,
        verify,
        setVerifyHook(hook?: () => void) {
            verifyHook = hook;
        },
    };
}

function clearDeliveryTrace() {
    fake.trace.length = 0;
    fake.hasHttpPollOwner.mockClear();
    fake.pollOwnerStats.mockClear();
    fake.failOrderedPollIngress.mockClear();
    fake.hasOrderedPollOwner.mockClear();
    fake.enqueuePollEvent.mockClear();
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    fake.transports.length = 0;
    fake.trace.length = 0;
    runtimes.length = 0;
    fake.registerPollHost.mockReset();
    fake.activateHttpPollOwner.mockReset().mockReturnValue({ status: 'unavailable' });
    fake.hasHttpPollOwner.mockReset().mockReturnValue(false);
    fake.pollOwnerStats.mockReset().mockReturnValue(null);
    fake.failOrderedPollIngress.mockReset().mockImplementation(() => {
        fake.trace.push('poll:fail-ingress');
    });
    fake.hasOrderedPollOwner.mockReset().mockImplementation(() => {
        fake.trace.push('poll:has-owner');
        return false;
    });
    fake.enqueuePollEvent.mockReset().mockImplementation(() => {
        fake.trace.push('poll:enqueue');
    });
    fake.invalidatePollOwner.mockReset();
    fake.invalidateStalePollOwner.mockReset();
    fake.recordPreparedScopeLoss.mockReset();
});

afterEach(async () => {
    try {
        for (const runtime of runtimes) {
            await runtime.close();
        }

        expect(vi.getTimerCount()).toBe(0);
    } finally {
        vi.clearAllTimers();
        vi.restoreAllMocks();
        vi.useRealTimers();
        runtimes.length = 0;
        fake.transports.length = 0;
    }
});

describe('qualified ordinary event fanout (pure memory)', () => {
    it.each(['private', 'group'] as const)(
        'delivers a current %s ticket, but drops an epoch rotated before manager microtasks',
        async (kind) => {
            const f = await fixture();
            const ws = observe(f.options);
            const current = f.ticket();
            const first = message(kind, 1);
            await f.manager.emitEvent(first, current);
            expect(messages(ws.events)).toMatchObject([
                {
                    type: 'message',
                    detail_type: kind,
                    message_id: '1',
                    ...(kind === 'group' ? { group_id: '34567' } : {}),
                },
            ]);
            expect(f.legacy.received).toHaveBeenCalledOnce();
            expect(f.legacy.received.mock.calls[0]![0]).toBe(first);

            const staleInput = message(kind, 2);
            const pending = f.manager.emitEvent(staleInput, current);
            f.rotate();
            expect(messages(ws.events)).toHaveLength(1);
            await pending;
            expect(messages(ws.events).map((event) => event.message_id)).toEqual(['1']);
            expect(f.legacy.received).toHaveBeenCalledTimes(2);
            expect(f.legacy.received.mock.calls[1]![0]).toBe(staleInput);

            await f.manager.emitEvent(message(kind, 3), f.ticket());
            expect(messages(ws.events).map((event) => event.message_id)).toEqual(['1', '3']);
            expect(f.legacy.received).toHaveBeenCalledTimes(3);
        },
    );

    it('rejects the old binding after close/reopen while admitting the replacement binding', async () => {
        const f = await fixture();
        const old = f.ticket();
        const first = observe(f.options);
        await f.manager.emitEvent(message('private', 11), old);
        expect(messages(first.events)).toHaveLength(1);
        await f.runtime.close();
        await f.runtime.open();
        const newOptions = fake.transports.at(-1)!.options;
        const next = observe(newOptions);
        const current = f.ticket();
        expect(f.generation.isCurrent(old, f.runtime[captureBinding]())).toBe(false);
        expect(f.generation.isCurrent(current, f.runtime[captureBinding]())).toBe(true);
        await f.manager.emitEvent(message('private', 12), old);
        await f.manager.emitEvent(message('private', 13), current);
        expect(messages(first.events).map((event) => event.message_id)).toEqual(['11']);
        expect(messages(next.events).map((event) => event.message_id)).toEqual(['13']);
        expect(f.legacy.received).toHaveBeenCalledTimes(3);
    });

    it.each([
        'object',
        'foreign-generation',
        'foreign-runtime',
        'proxy',
        'revoked-proxy',
        'null',
        'false',
    ] as const)('does not downgrade a %s ticket to the unticketed path', async (kind) => {
        const f = await fixture();
        const ws = observe(f.options);
        const current = f.ticket();
        const other = new SourceGeneration();
        other.setOnline(true);
        const foreignRuntime = kind === 'foreign-runtime' ? await fixture() : undefined;
        const revoked = Proxy.revocable(current, {});
        revoked.revoke();
        const invalid: Record<string, unknown> = {
            object: {},
            'foreign-generation': other.capture(f.runtime[captureBinding]()),
            'foreign-runtime': foreignRuntime?.ticket(),
            proxy: new Proxy(current, {}),
            'revoked-proxy': revoked.proxy,
            null: null,
            false: false,
        };
        const input = message('group', 21);
        const receive = vi.spyOn(f.runtime, receiveSourceEvent);
        await f.manager.emitEvent(input, invalid[kind] as V12Source);
        expect(receive).toHaveBeenCalledOnce();
        expect(receive.mock.calls[0]![2]).toBe(invalid[kind]);
        expect(messages(ws.events)).toEqual([]);
        expect(f.legacy.received).toHaveBeenCalledOnce();
        expect(f.legacy.received.mock.calls[0]![0]).toBe(input);
        await f.manager.emitEvent(message('group', 22));
        expect(messages(ws.events).map((event) => event.message_id)).toEqual(['22']);
        expect(f.legacy.received).toHaveBeenCalledTimes(2);
    });

    it('keeps unticketed fanout when source verification throws for a separate ticketed event', async () => {
        const f = await fixture();
        const ws = observe(f.options);
        f.setVerifyHook(() => {
            throw new Error('synthetic verifier failure');
        });
        await f.manager.emitEvent(message('private', 31), f.ticket());
        expect(messages(ws.events)).toEqual([]);
        f.verify.mockClear();
        await f.manager.emitEvent(message('private', 32));
        expect(f.verify).not.toHaveBeenCalled();
        expect(messages(ws.events).map((event) => event.message_id)).toEqual(['32']);
        expect(f.legacy.received).toHaveBeenCalledTimes(2);
    });

    it('finishes the legacy poll branch before pre-publish and per-subscriber verification', async () => {
        const f = await fixture();
        const ticket = f.ticket();
        const ws = observe(f.options, (event) => {
            if (event.type === 'message') {
                fake.trace.push('ws:first');
            }
        });
        const second = observe(f.options, (event) => {
            if (event.type === 'message') {
                fake.trace.push('ws:second');
            }
        });
        clearDeliveryTrace();
        f.verify.mockClear();
        await f.manager.emitEvent(message('private', 41), ticket);
        expect(fake.failOrderedPollIngress).toHaveBeenCalledExactlyOnceWith(f.runtime);
        expect(fake.hasOrderedPollOwner).toHaveBeenCalledExactlyOnceWith(f.runtime);
        expect(fake.hasHttpPollOwner).toHaveBeenCalledExactlyOnceWith(f.runtime);
        expect(fake.pollOwnerStats).not.toHaveBeenCalled();
        expect(fake.activateHttpPollOwner).not.toHaveBeenCalled();
        expect(fake.enqueuePollEvent).toHaveBeenCalledExactlyOnceWith(
            f.runtime,
            expect.objectContaining({ type: 'message', message_id: '41' }),
            ticket,
        );
        expect(fake.trace).toEqual([
            'verify', // pre-activation source guard
            'poll:fail-ingress',
            'poll:has-owner',
            'poll:enqueue',
            'verify', // pre-publish
            'verify', // first subscriber
            'ws:first',
            'verify', // second subscriber
            'ws:second',
            'v11',
        ]);
        expect(f.verify.mock.calls.map(([source]) => source)).toEqual([
            ticket,
            ticket,
            ticket,
            ticket,
        ]);
        expect(f.verify.mock.results.map((result) => result.value)).toEqual([
            true,
            true,
            true,
            true,
        ]);
        expect(messages(ws.events).map((event) => event.message_id)).toEqual(['41']);
        expect(messages(second.events).map((event) => event.message_id)).toEqual(['41']);
        expect(f.legacy.received).toHaveBeenCalledOnce();

        // A stale input still runs the same poll admission branch before WS is fenced.
        f.rotate();
        clearDeliveryTrace();
        f.verify.mockClear();
        await f.manager.emitEvent(message('private', 42), ticket);
        expect(fake.trace).toEqual([
            'verify', // pre-activation source guard
            'poll:fail-ingress',
            'poll:has-owner',
            'poll:enqueue',
            'verify', // pre-publish rejects the stale ticket
            'v11',
        ]);
        expect(fake.enqueuePollEvent).toHaveBeenCalledExactlyOnceWith(
            f.runtime,
            expect.objectContaining({ message_id: '42' }),
            ticket,
        );
        expect(f.verify.mock.calls.map(([source]) => source)).toEqual([ticket, ticket]);
        expect(f.verify.mock.results.map((result) => result.value)).toEqual([false, false]);
        expect(messages(ws.events).map((event) => event.message_id)).toEqual(['41']);
        expect(messages(second.events).map((event) => event.message_id)).toEqual(['41']);
        expect(f.legacy.received).toHaveBeenCalledTimes(2);
    });

    it('performs the pre-publish check even with no WS subscribers', async () => {
        const f = await fixture();
        const ticket = f.ticket();
        clearDeliveryTrace();
        f.verify.mockClear();
        await f.manager.emitEvent(message('group', 43), ticket);
        expect(fake.enqueuePollEvent).toHaveBeenCalledOnce();
        expect(fake.trace).toEqual([
            'verify', // pre-activation source guard
            'poll:fail-ingress',
            'poll:has-owner',
            'poll:enqueue',
            'verify', // pre-publish, even without subscribers
            'v11',
        ]);
        expect(f.verify.mock.calls.map(([source]) => source)).toEqual([ticket, ticket]);
        expect(f.verify.mock.results.map((result) => result.value)).toEqual([true, true]);
        expect(f.legacy.received).toHaveBeenCalledOnce();
    });

    it('resolves an ordered lease first and fences WS if resolution rotates the epoch', async () => {
        const f = await fixture();
        const ws = observe(f.options, (event) => {
            if (event.type === 'message') {
                fake.trace.push('ws');
            }
        });
        const ticket = f.ticket();
        let pending = true;
        const lease = {
            resolve: vi.fn((_value: unknown) => {
                fake.trace.push('poll:resolve');
                pending = false;
                f.rotate();
                return true;
            }),
            skip: vi.fn(() => {
                pending = false;
                return true;
            }),
            fail: vi.fn(() => {
                pending = false;
                return true;
            }),
            pending: vi.fn(() => pending),
        };
        const admission: OrderedAdmission = { kind: 'eligible', target: f.runtime, lease };
        const input = message('group', 51);
        clearDeliveryTrace();
        f.verify.mockClear();
        await withOrderedScope(f.manager, 'manager', input, admission, () =>
            f.manager.emitEvent(input, ticket),
        );
        expect(lease.resolve).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ type: 'message', message_id: '51' }),
        );
        expect(lease.fail).not.toHaveBeenCalled();
        expect(lease.skip).not.toHaveBeenCalled();
        expect(fake.failOrderedPollIngress).not.toHaveBeenCalled();
        expect(fake.enqueuePollEvent).not.toHaveBeenCalled();
        expect(fake.trace).toEqual([
            'verify', // pre-activation source guard
            'poll:resolve',
            'verify', // pre-publish rejects the rotated epoch
            'v11',
        ]);
        expect(f.verify.mock.calls.map(([source]) => source)).toEqual([ticket, ticket]);
        expect(f.verify.mock.results.map((result) => result.value)).toEqual([true, false]);
        expect(messages(ws.events)).toEqual([]);
        expect(f.legacy.received).toHaveBeenCalledOnce();
    });

    it('keeps current eligible admission and WS on the identical converted event', async () => {
        const f = await fixture();
        const ws = observe(f.options, (event) => {
            if (event.type === 'message') {
                fake.trace.push('ws');
            }
        });
        const ticket = f.ticket();
        let pending = true;
        const lease = {
            resolve: vi.fn((_value: unknown) => {
                fake.trace.push('poll:resolve');
                pending = false;
                return true;
            }),
            skip: vi.fn(() => {
                pending = false;
                return true;
            }),
            fail: vi.fn(() => {
                pending = false;
                return true;
            }),
            pending: vi.fn(() => pending),
        };
        const admission: OrderedAdmission = { kind: 'eligible', target: f.runtime, lease };
        const input = message('private', 53);
        clearDeliveryTrace();
        f.verify.mockClear();
        await withOrderedScope(f.manager, 'manager', input, admission, () =>
            f.manager.emitEvent(input, ticket),
        );
        expect(lease.resolve).toHaveBeenCalledOnce();
        expect(lease.resolve.mock.calls[0]![0]).toBe(messages(ws.events)[0]);
        expect(lease.skip).not.toHaveBeenCalled();
        expect(lease.fail).not.toHaveBeenCalled();
        expect(fake.failOrderedPollIngress).not.toHaveBeenCalled();
        expect(fake.enqueuePollEvent).not.toHaveBeenCalled();
        expect(fake.trace).toEqual([
            'verify', // pre-activation source guard
            'poll:resolve',
            'verify', // pre-publish
            'verify', // subscriber
            'ws',
            'v11',
        ]);
        expect(f.verify.mock.calls.map(([source]) => source)).toEqual([ticket, ticket, ticket]);
        expect(f.verify.mock.results.map((result) => result.value)).toEqual([true, true, true]);
        expect(f.legacy.received).toHaveBeenCalledOnce();
    });

    it('keeps a not-eligible admission out of legacy poll while still fencing WS', async () => {
        const f = await fixture();
        const ws = observe(f.options);
        const ticket = f.ticket();
        const admission: OrderedAdmission = {
            kind: 'not_eligible',
            target: f.runtime,
            source: ticket,
            reportOnLoss: false,
        };
        const current = message('group', 54);
        clearDeliveryTrace();
        await withOrderedScope(f.manager, 'manager', current, admission, () =>
            f.manager.emitEvent(current, ticket),
        );
        f.rotate();
        const stale = message('group', 55);
        await withOrderedScope(f.manager, 'manager', stale, admission, () =>
            f.manager.emitEvent(stale, ticket),
        );
        expect(fake.failOrderedPollIngress).not.toHaveBeenCalled();
        expect(fake.hasOrderedPollOwner).not.toHaveBeenCalled();
        expect(fake.enqueuePollEvent).not.toHaveBeenCalled();
        expect(messages(ws.events).map((event) => event.message_id)).toEqual(['54']);
        expect(f.legacy.received).toHaveBeenCalledTimes(2);
    });

    it('leaves the unproven private-recall skip before WS and v11 behavior intact', async () => {
        const f = await fixture();
        const ws = observe(f.options);
        const ticket = f.ticket();
        let pending = true;
        const lease = {
            resolve: vi.fn((_value: unknown) => {
                pending = false;
                return true;
            }),
            skip: vi.fn(() => {
                pending = false;
                return true;
            }),
            fail: vi.fn(() => {
                pending = false;
                return true;
            }),
            pending: vi.fn(() => pending),
        };
        const admission: OrderedAdmission = { kind: 'eligible', target: f.runtime, lease };
        const input: JsonObject = {
            post_type: 'notice',
            notice_type: 'friend_recall',
            time: 1,
            self_id: 12345,
            user_id: 23456,
            message_id: 56,
        };
        clearDeliveryTrace();
        f.verify.mockClear();
        await withOrderedScope(f.manager, 'manager', input, admission, () =>
            f.manager.emitEvent(input, ticket),
        );
        expect(lease.skip).toHaveBeenCalledOnce();
        expect(lease.resolve).not.toHaveBeenCalled();
        expect(lease.fail).not.toHaveBeenCalled();
        expect(fake.enqueuePollEvent).not.toHaveBeenCalled();
        expect(f.verify).not.toHaveBeenCalled();
        expect(ws.events.map((event) => event.detail_type)).toEqual(['connect', 'status_update']);
        expect(f.legacy.received).toHaveBeenCalledOnce();
        expect(f.legacy.received.mock.calls[0]![0]).toBe(input);
    });

    it('continues qualified WS after a synthetic poll enqueue exception', async () => {
        const f = await fixture();
        const ws = observe(f.options, (event) => {
            if (event.type === 'message') {
                fake.trace.push('ws');
            }
        });
        const ticket = f.ticket();
        clearDeliveryTrace();
        f.verify.mockClear();
        fake.enqueuePollEvent.mockImplementationOnce(() => {
            fake.trace.push('poll:enqueue-throws');
            throw new Error('synthetic poll error');
        });
        await f.manager.emitEvent(message('private', 52), ticket);
        expect(fake.enqueuePollEvent).toHaveBeenCalledExactlyOnceWith(
            f.runtime,
            expect.objectContaining({ type: 'message', message_id: '52' }),
            ticket,
        );
        expect(messages(ws.events).map((event) => event.message_id)).toEqual(['52']);
        expect(fake.trace).toEqual([
            'verify', // pre-activation source guard
            'poll:fail-ingress',
            'poll:has-owner',
            'poll:enqueue-throws',
            'verify', // pre-publish
            'verify', // subscriber
            'ws',
            'v11',
        ]);
        expect(f.verify.mock.calls.map(([source]) => source)).toEqual([ticket, ticket, ticket]);
        expect(f.verify.mock.results.map((result) => result.value)).toEqual([true, true, true]);
        expect(f.legacy.received).toHaveBeenCalledOnce();
    });

    it('rechecks after pre-publish when verification itself rotates before the first subscriber', async () => {
        const f = await fixture();
        const ws = observe(f.options, (event) => {
            if (event.type === 'message') {
                fake.trace.push('ws');
            }
        });
        const ticket = f.ticket();
        let postPollChecks = 0;
        clearDeliveryTrace();
        f.verify.mockClear();
        f.setVerifyHook(() => {
            if (fake.trace.includes('poll:enqueue')) {
                postPollChecks++;

                if (postPollChecks === 2) {
                    f.rotate();
                }
            }
        });
        await f.manager.emitEvent(message('private', 60), ticket);
        expect(postPollChecks).toBe(2);
        expect(fake.enqueuePollEvent).toHaveBeenCalledOnce();
        expect(fake.trace).toEqual([
            'verify', // pre-activation source guard
            'poll:fail-ingress',
            'poll:has-owner',
            'poll:enqueue',
            'verify', // pre-publish
            'verify', // first subscriber rotates and is fenced
            'v11',
        ]);
        expect(f.verify.mock.calls.map(([source]) => source)).toEqual([ticket, ticket, ticket]);
        expect(f.verify.mock.results.map((result) => result.value)).toEqual([true, true, false]);
        expect(messages(ws.events)).toEqual([]);
        expect(f.legacy.received).toHaveBeenCalledOnce();
    });

    it('stops between subscribers when the first synchronously rotates the source', async () => {
        const f = await fixture();
        const first = observe(f.options, (event) => {
            if (event.type === 'message' && event.message_id === '61') {
                f.rotate();
            }
        });
        const second = observe(f.options);
        await f.manager.emitEvent(message('private', 61), f.ticket());
        expect(messages(first.events).map((event) => event.message_id)).toEqual(['61']);
        expect(messages(second.events)).toEqual([]);
        expect(f.legacy.received).toHaveBeenCalledOnce();
        await f.manager.emitEvent(message('private', 62), f.ticket());
        expect(messages(first.events).map((event) => event.message_id)).toEqual(['61', '62']);
        expect(messages(second.events).map((event) => event.message_id)).toEqual(['62']);
    });

    it('uses a subscription-generation snapshot for qualified re-subscription', async () => {
        const f = await fixture();
        let changed = false;

        let unsubscribeSecond = () => {};

        let unsubscribeThird = () => {};

        const secondEvents: SeenEvent[] = [];
        const thirdEvents: SeenEvent[] = [];
        const addedEvents: SeenEvent[] = [];
        const second = (value: unknown) => secondEvents.push(value as SeenEvent);
        const third = (value: unknown) => thirdEvents.push(value as SeenEvent);
        const added = (value: unknown) => addedEvents.push(value as SeenEvent);
        const first = observe(f.options, (event) => {
            if (event.type === 'message' && !changed) {
                changed = true;
                const staleUnsubscribe = unsubscribeSecond;
                unsubscribeSecond();
                unsubscribeSecond = f.options.subscribe(second);
                staleUnsubscribe();
                unsubscribeThird();
                f.options.subscribe(added);
            }
        });
        unsubscribeSecond = f.options.subscribe(second);
        unsubscribeThird = f.options.subscribe(third);
        const ticket = f.ticket();
        await f.manager.emitEvent(message('group', 71), ticket);
        expect(messages(first.events).map((event) => event.message_id)).toEqual(['71']);
        expect(messages(secondEvents)).toEqual([]);
        expect(messages(thirdEvents)).toEqual([]);
        expect(messages(addedEvents)).toEqual([]);
        await f.manager.emitEvent(message('group', 72), ticket);
        expect(messages(secondEvents).map((event) => event.message_id)).toEqual(['72']);
        expect(messages(thirdEvents)).toEqual([]);
        expect(messages(addedEvents).map((event) => event.message_id)).toEqual(['72']);
        expect(f.legacy.received).toHaveBeenCalledTimes(2);
    });

    it('retains legacy live-Set fanout for an independent unticketed event', async () => {
        const f = await fixture();
        const removed: SeenEvent[] = [];
        const added: SeenEvent[] = [];

        let unsubscribe = () => {};

        observe(f.options, (event) => {
            if (event.type === 'message') {
                unsubscribe();
                f.options.subscribe((value) => added.push(value as SeenEvent));
            }
        });
        unsubscribe = f.options.subscribe((value) => removed.push(value as SeenEvent));
        f.verify.mockClear();
        await f.manager.emitEvent(message('private', 81));
        expect(f.verify).not.toHaveBeenCalled();
        expect(messages(removed)).toEqual([]);
        expect(messages(added).map((event) => event.message_id)).toEqual(['81']);
        expect(f.legacy.received).toHaveBeenCalledOnce();
    });

    it('fences a synchronous same-event and same-payload reentry storm while the scope is live', async () => {
        const f = await fixture();
        const input = message('private', 91);
        const ticket = f.ticket();
        let capturedPayload: DispatchPayload | undefined;
        let reentered = false;
        const original = f.runtime.onEvent.bind(f.runtime);
        vi.spyOn(f.runtime, 'onEvent').mockImplementation((event, payload) => {
            capturedPayload = payload;
            original(event, payload);
        });
        const first = observe(f.options, (event) => {
            if (event.type === 'message' && !reentered) {
                reentered = true;
                f.rotate();

                if (!capturedPayload) {
                    throw new Error('missing synthetic payload');
                }

                // These identical no-argument-ticket calls occur while the source scope is live.
                for (let index = 0; index < 4; index++) {
                    f.runtime.onEvent(input, capturedPayload);
                }
            }
        });
        const second = observe(f.options);
        await f.manager.emitEvent(input, ticket);
        expect(messages(first.events).map((event) => event.message_id)).toEqual(['91']);
        expect(messages(second.events)).toEqual([]);
        expect(f.legacy.received).toHaveBeenCalledOnce();
        expect(fake.enqueuePollEvent).toHaveBeenCalledTimes(5);

        // Once the source scope has unwound, this is an independent no-ticket call.
        f.verify.mockClear();
        f.runtime.onEvent(input, capturedPayload);
        expect(f.verify).not.toHaveBeenCalled();
        expect(messages(first.events).map((event) => event.message_id)).toEqual(['91', '91']);
        expect(messages(second.events).map((event) => event.message_id)).toEqual(['91']);
    });

    it('keeps unticketed messages and connect/status/heartbeat independent of source validity', async () => {
        const f = await fixture(true);
        const ws = observe(f.options);
        expect(ws.events.map((event) => event.detail_type)).toEqual(['connect', 'status_update']);
        f.generation.setOnline(false);
        f.verify.mockClear();
        clearDeliveryTrace();
        f.runtime.statusUpdate();
        vi.advanceTimersByTime(10);
        await f.manager.emitEvent(message('group', 101));
        expect(ws.events.map((event) => event.detail_type)).toEqual([
            'connect',
            'status_update',
            'status_update',
            'heartbeat',
            'group',
        ]);
        expect(messages(ws.events).map((event) => event.message_id)).toEqual(['101']);
        expect(f.verify).not.toHaveBeenCalled();
        expect(fake.enqueuePollEvent).toHaveBeenCalledExactlyOnceWith(
            f.runtime,
            expect.objectContaining({ message_id: '101' }),
            undefined,
        );
        expect(f.legacy.received).toHaveBeenCalledOnce();
    });
});
