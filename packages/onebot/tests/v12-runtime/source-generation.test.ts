import { describe, expect, it, vi } from 'vitest';
import type { V12TransportOptions } from '../../src/v12-network';

const fixture = vi.hoisted(() => ({
    transports: [] as Array<{
        options: V12TransportOptions;
        open: () => Promise<void>;
        close: () => Promise<void>;
        quiesce: () => void;
    }>,
    send: null as null | ((handler: (event: any) => Promise<void>) => Promise<void>),
    backfill: null as null | (() => Promise<void>),
    open: null as null | (() => Promise<void>),
    construct: null as null | ((options: V12TransportOptions) => void),
}));

vi.mock('@snowluma/websocket', () => ({ WebSocket: class {}, WebSocketServer: class {} }));
vi.mock('../../src/v12-network', () => ({
    V12Transport: class {
        private state: (typeof fixture.transports)[number];
        constructor(options: V12TransportOptions) {
            this.state = {
                options,
                open: async () => {
                    await fixture.open?.();
                },
                close: async () => {},
                quiesce: () => {},
            };
            fixture.transports.push(this.state);
            fixture.construct?.(options);
        }
        open() {
            return this.state.open();
        }
        close() {
            return this.state.close();
        }
        quiesce() {
            this.state.quiesce();
        }
        forceClose() {}
    },
}));
vi.mock('../../src/modules/message-actions', () => ({
    backfillReplyTarget: async (_ctx: unknown, event: unknown) => {
        await fixture.backfill?.();
        return event;
    },
    sendPrivateMessage: (
        _ref: unknown,
        _user: unknown,
        _msg: unknown,
        _escape: unknown,
        _group: unknown,
        handler: any,
    ) => fixture.send!(handler),
    sendPrivateForwardMessage: (
        _ref: unknown,
        _user: unknown,
        _msgs: unknown,
        _meta: unknown,
        handler: any,
    ) => fixture.send!(handler),
    forwardSingleMessage: (_ref: unknown, _id: unknown, _target: unknown, handler: any) =>
        fixture.send!(handler),
}));

import { V12Runtime } from '../../src/v12-runtime/runtime';
import {
    captureBinding,
    captureSource,
    receiveSourceEvent,
    SourceGeneration,
    verifySource,
} from '../../src/v12-runtime/source-generation';
import { OneBotNetworkManager } from '../../src/network/network-manager';
import { IOneBotNetworkAdapter } from '../../src/network/adapter';
import { OneBotInstance } from '../../src/instance';
import { buildApiContext } from '../../src/instance-context';
import { registerEventPipeline } from '../../src/event-pipeline';
import { V12_ADAPTER_NAME } from '../../src/v12-runtime/identity';

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function makeRuntime(generation = new SourceGeneration()) {
    const manager = new OneBotNetworkManager();
    let runtime!: V12Runtime;
    runtime = new V12Runtime(
        {
            name: V12_ADAPTER_NAME,
            enabled: true,
            host: '127.0.0.1',
            port: 1,
            allowNonLoopback: false,
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
            isSourceCurrent: (source, binding) =>
                manager.get(V12_ADAPTER_NAME) === runtime && generation.isCurrent(source, binding),
        },
    );
    manager.register(runtime);
    return { runtime, manager, generation };
}

const event = {
    post_type: 'message',
    self_id: 12345,
    user_id: 23456,
    message_id: 1,
    time: 1,
    message_type: 'private',
    sub_type: 'friend',
    raw_message: 'hello',
    message: [{ type: 'text', data: { text: 'hello' } }],
};

describe('internal source generation (no transports)', () => {
    it('rotates on online edges, rejects fake and other-owner sources', async () => {
        const a = makeRuntime();
        const b = makeRuntime();
        await a.runtime.open();
        await b.runtime.open();
        a.generation.setOnline(true);
        b.generation.setOnline(true);
        const ticket = a.generation.capture(a.runtime[captureBinding]())!;
        expect(a.runtime[verifySource](ticket)).toBe(true);
        expect(b.runtime[verifySource](ticket)).toBe(false);
        expect(a.runtime[verifySource](JSON.parse(JSON.stringify(ticket)))).toBe(false);
        a.generation.setOnline(true);
        expect(a.runtime[verifySource](ticket)).toBe(true);
        a.generation.setOnline(false);
        a.generation.setOnline(true);
        expect(a.runtime[verifySource](ticket)).toBe(false);
        const next = a.generation.capture(a.runtime[captureBinding]())!;
        expect(a.runtime[verifySource](next)).toBe(true);
        expect(JSON.stringify(next)).toBe('{}');
        await a.runtime.close();
        await b.runtime.close();
    });

    it('rejects forged prototypes, overrides and proxies without invoking them', async () => {
        const f = makeRuntime();
        await f.runtime.open();
        f.generation.setOnline(true);
        const binding = f.runtime[captureBinding]();
        const valid = f.generation.capture(binding)!;
        const fake = Object.create(Object.getPrototypeOf(valid));
        fake.matches = () => true;
        expect(f.generation.isCurrent(fake, binding)).toBe(false);

        fake.matches = () => {
            throw new Error('must not run');
        };

        expect(f.generation.isCurrent(fake, binding)).toBe(false);
        expect(f.generation.isCurrent(new Proxy(valid, {}), binding)).toBe(false);
        const revoked = Proxy.revocable(valid, {});
        revoked.revoke();
        expect(f.generation.isCurrent(revoked.proxy, binding)).toBe(false);
        expect(f.generation.isCurrent(valid, binding)).toBe(true);
        f.generation.setOnline(false);
        f.generation.setOnline(true);
        expect(f.generation.isCurrent(fake, binding)).toBe(false);
        expect(f.generation.isCurrent(valid, binding)).toBe(false);
        await f.runtime.close();
    });

    it('revokes on a throwing quiesce without changing status and old onError cannot revoke new', async () => {
        const f = makeRuntime();
        await f.runtime.open();
        f.generation.setOnline(true);
        const old = fixture.transports.at(-1)!;
        const ticket = f.generation.capture(f.runtime[captureBinding]())!;
        const error = new Error('quiesce');

        old.quiesce = () => {
            throw error;
        };

        await expect(f.runtime.close()).rejects.toBe(error);
        expect(f.runtime.isActive).toBe(true);
        expect(f.runtime[verifySource](ticket)).toBe(false);

        old.quiesce = () => {};

        await f.runtime.close();
        await f.runtime.open();
        const next = f.generation.capture(f.runtime[captureBinding]())!;
        old.options.onError?.(new Error('old'));
        expect(f.runtime[verifySource](next)).toBe(true);
        await f.runtime.close();
    });

    it('preserves a pending status timer when quiesce throws', async () => {
        vi.useFakeTimers();

        try {
            const f = makeRuntime();
            await f.runtime.open();
            const transport = fixture.transports.at(-1)!;
            let storm = false;
            let calls = 0;
            transport.options.subscribe(() => {
                calls++;

                if (storm) {
                    f.runtime.statusUpdate();
                }
            });
            storm = true;
            f.runtime.statusUpdate();
            expect(vi.getTimerCount()).toBe(1);
            const failure = new Error('quiesce');

            transport.quiesce = () => {
                throw failure;
            };

            await expect(f.runtime.close()).rejects.toBe(failure);
            expect(f.runtime.isActive).toBe(true);
            expect(vi.getTimerCount()).toBe(1);
            storm = false;
            vi.runAllTimers();
            expect(calls).toBe(4);

            transport.quiesce = () => {};

            await f.runtime.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it.each(['resolve', 'reject'] as const)(
        'preserves pending open status ownership when quiesce throws: %s',
        async (outcome) => {
            const f = makeRuntime();
            f.generation.setOnline(true);
            const gate = deferred();
            fixture.open = () => gate.promise;
            const opening = f.runtime.open();
            const transport = fixture.transports.at(-1)!;
            const listener = vi.fn();
            transport.options.subscribe(listener);
            listener.mockClear();
            const failure = new Error('quiesce fixture');

            transport.quiesce = () => {
                throw failure;
            };

            await expect(f.runtime.close()).rejects.toBe(failure);
            expect(f.runtime[captureBinding]()).toBeNull();
            fixture.open = null;

            if (outcome === 'resolve') {
                gate.resolve();
                await opening;
                expect(f.runtime.isActive).toBe(true);
                expect(f.runtime[captureBinding]()).toBeNull();
                f.runtime.statusUpdate();
                expect(listener).toHaveBeenCalledOnce();
                await f.manager.emitEvent(event);
                expect(listener).toHaveBeenCalledTimes(2);

                transport.quiesce = () => {};

                await f.runtime.close();
            } else {
                const rejected = expect(opening).rejects.toThrow('v12 operation failed');
                gate.reject(new Error('private open details'));
                await rejected;
                expect(f.runtime.isActive).toBe(false);
                expect(f.runtime[captureBinding]()).toBeNull();
                await f.runtime.open();
                expect(f.runtime.isActive).toBe(true);
                await f.runtime.close();
            }
        },
    );

    it('does not restore old open ownership after a reentrant successful close', async () => {
        const f = makeRuntime();
        f.generation.setOnline(true);
        const gate = deferred();
        fixture.open = () => gate.promise;
        const opening = f.runtime.open();
        const old = fixture.transports.at(-1)!;
        const failure = new Error('outer quiesce');
        let nested!: Promise<void>;
        let entered = false;

        old.quiesce = () => {
            if (!entered) {
                entered = true;
                nested = f.runtime.close();
                throw failure;
            }
        };

        await expect(f.runtime.close()).rejects.toBe(failure);
        await nested;
        fixture.open = null;
        await f.runtime.open();
        const current = fixture.transports.at(-1)!;
        const seen = vi.fn();
        current.options.subscribe(seen);
        seen.mockClear();
        const ticket = f.generation.capture(f.runtime[captureBinding]())!;
        gate.resolve();
        await opening;
        expect(f.runtime.isActive).toBe(true);
        expect(f.runtime[verifySource](ticket)).toBe(true);
        await f.manager.emitEvent(event, ticket);
        expect(seen).toHaveBeenCalledOnce();
        await f.runtime.close();
    });

    it('does not activate a binding after constructor-time onError', async () => {
        const f = makeRuntime();
        f.generation.setOnline(true);
        fixture.construct = (options) => options.onError?.(new Error('fixture'));

        try {
            await f.runtime.open();
            expect(f.runtime.isActive).toBe(true);
            expect(f.runtime[captureBinding]()).toBeNull();
            await f.runtime.close();
        } finally {
            fixture.construct = null;
        }
    });

    it('does not resurrect an opening attempt after close', async () => {
        const f = makeRuntime();
        f.generation.setOnline(true);
        const gate = deferred();
        fixture.open = () => gate.promise;
        const opening = f.runtime.open();
        await f.runtime.close();
        fixture.open = null;
        await f.runtime.open();
        const next = f.generation.capture(f.runtime[captureBinding]())!;
        gate.resolve();
        await opening;
        expect(f.runtime[verifySource](next)).toBe(true);
        await f.runtime.close();
    });

    it.each(['reject', 'cleanup-failure', 'success-after-error', 'success-after-close'] as const)(
        'keeps the new owner stable when old open settles: %s',
        async (mode) => {
            const f = makeRuntime();
            f.generation.setOnline(true);
            const gate = deferred();
            fixture.open = () => gate.promise;
            const oldOpening = f.runtime.open();
            const old = fixture.transports.at(-1)!;
            await f.runtime.close();
            fixture.open = null;
            await f.runtime.open();
            const current = fixture.transports.at(-1)!;
            const currentClose = vi.fn(async () => {});
            current.close = currentClose;
            const seen: unknown[] = [];
            current.options.subscribe((value) => seen.push(value));
            seen.length = 0;
            const ticket = f.generation.capture(f.runtime[captureBinding]())!;

            if (mode === 'cleanup-failure') {
                old.close = async () => {
                    throw new Error('old cleanup secret');
                };
            }

            if (mode === 'success-after-error') {
                current.options.onError?.(new Error('EACCES'));
            }

            if (mode === 'success-after-close') {
                await f.runtime.close();
            }

            if (mode === 'reject' || mode === 'cleanup-failure') {
                const result = expect(oldOpening).rejects.toThrow('v12');
                gate.reject(new Error('old open secret'));
                await result;
                expect(f.runtime.isActive).toBe(true);
                expect(f.runtime[verifySource](ticket)).toBe(true);
                expect(currentClose).not.toHaveBeenCalled();
                await f.manager.emitEvent(event, ticket);
                expect(seen).toHaveLength(1);
            } else {
                gate.resolve();
                await oldOpening;
                expect(f.runtime.isActive).toBe(false);
                expect(f.runtime[verifySource](ticket)).toBe(false);
                f.runtime.statusUpdate();
                await f.manager.emitEvent(event);
                expect(seen).toHaveLength(0);
            }

            if (mode !== 'success-after-close') {
                await f.runtime.close();
            }
        },
    );

    it.each(['success', 'failure'] as const)(
        'does not let a late second close affect the new owner: %s',
        async (outcome) => {
            const f = makeRuntime();
            await f.runtime.open();
            f.generation.setOnline(true);
            const old = fixture.transports.at(-1)!;
            const firstGate = deferred();
            const secondGate = deferred();
            let closes = 0;

            let unsubscribe = () => {};

            old.close = async () => {
                closes++;
                await (closes === 1 ? firstGate.promise : secondGate.promise);

                if (closes === 2) {
                    unsubscribe();
                }
            };

            const sharedListener = vi.fn();
            unsubscribe = old.options.subscribe(sharedListener);
            const first = f.runtime.close();
            const second = f.runtime.close();
            firstGate.resolve();
            await first;
            await f.runtime.open();
            const current = fixture.transports.at(-1)!;
            current.options.subscribe(sharedListener);
            sharedListener.mockClear();
            const ticket = f.generation.capture(f.runtime[captureBinding]())!;

            if (outcome === 'failure') {
                const rejected = expect(second).rejects.toThrow('v12');
                secondGate.reject(new Error('close secret'));
                await rejected;
            } else {
                secondGate.resolve();
                await second;
            }

            expect(f.runtime.isActive).toBe(true);
            expect(f.runtime[verifySource](ticket)).toBe(true);
            await f.manager.emitEvent(event, ticket);
            expect(sharedListener).toHaveBeenCalledOnce();
            await f.runtime.close();
        },
    );

    it('captures the old transport before a synchronously reentrant quiesce', async () => {
        const f = makeRuntime();
        await f.runtime.open();
        f.generation.setOnline(true);
        const old = fixture.transports.at(-1)!;
        const nestedGate = deferred();
        const outerGate = deferred();
        let closeCount = 0;
        old.close = () => (++closeCount === 1 ? nestedGate.promise : outerGate.promise);
        let nested!: Promise<void>;
        let entered = false;

        old.quiesce = () => {
            if (!entered) {
                entered = true;
                nested = f.runtime.close();
            }
        };

        const outer = f.runtime.close();
        nestedGate.resolve();
        await nested;
        await f.runtime.open();
        const current = fixture.transports.at(-1)!;
        const currentClose = vi.fn(async () => {});
        current.close = currentClose;
        const received = vi.fn();
        current.options.subscribe(received);
        received.mockClear();
        const ticket = f.generation.capture(f.runtime[captureBinding]())!;
        outerGate.resolve();
        await outer;
        expect(currentClose).not.toHaveBeenCalled();
        expect(f.runtime.isActive).toBe(true);
        expect(f.runtime[verifySource](ticket)).toBe(true);
        await f.manager.emitEvent(event, ticket);
        expect(received).toHaveBeenCalledOnce();
        await f.runtime.close();
        expect(currentClose).toHaveBeenCalledOnce();
    });

    it('falls back to two-argument onEvent for legacy duck-typed adapters', async () => {
        const f = makeRuntime();
        await f.runtime.open();
        f.generation.setOnline(true);
        const onEvent = vi.fn();
        f.manager.register({
            name: 'duck',
            isActive: true,
            onEvent,
            describeStatus: () => ({ kind: 'httpServer' }),
        } as never);
        await f.manager.emitEvent(event, f.generation.capture(f.runtime[captureBinding]())!);
        expect(onEvent).toHaveBeenCalledOnce();
        expect(onEvent.mock.calls[0]).toHaveLength(2);
        await f.runtime.close();
    });

    it('carries stale metadata through async fanout while preserving existing subscribers', async () => {
        const f = makeRuntime();
        await f.runtime.open();
        f.generation.setOnline(true);
        const ticket = f.generation.capture(f.runtime[captureBinding]())!;
        const transport = fixture.transports.at(-1)!;
        const received: unknown[] = [];
        transport.options.subscribe((value) => received.push(value));
        received.length = 0;
        const recv = vi.spyOn(f.runtime, receiveSourceEvent);
        const pending = f.manager.emitEvent(event, ticket);
        f.generation.setOnline(false);
        f.generation.setOnline(true);
        await pending;
        expect(recv).toHaveBeenCalledOnce();
        expect(f.runtime[verifySource](ticket)).toBe(false);
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({ type: 'message', message_id: '1' });
        await f.runtime.close();
    });

    it('keeps two-argument legacy adapter fanout for ticketed and unknown events', async () => {
        class Legacy extends IOneBotNetworkAdapter<any> {
            protected bindingSignature() {
                return '';
            }
            open() {
                this.isEnabled = true;
            }
            close() {
                this.isEnabled = false;
            }
            onEvent = vi.fn();
            describeStatus() {
                return {
                    name: this.name,
                    kind: 'httpServer' as const,
                    status: 'ok' as const,
                    detail: '',
                };
            }
        }
        const f = makeRuntime();
        await f.runtime.open();
        f.generation.setOnline(true);
        const legacy = new Legacy(
            'legacy',
            { name: 'legacy' },
            {
                uin: '12345',
                api: {} as never,
                buildLifecycleEvent: () => ({}),
                buildHeartbeatEvent: () => ({}),
            },
        );
        legacy.open();
        f.manager.register(legacy);
        await f.manager.emitEvent(event, f.generation.capture(f.runtime[captureBinding]())!);
        await f.manager.emitEvent(event);
        expect(legacy.onEvent.mock.calls.map((args) => args.length)).toEqual([2, 2]);
        await f.runtime.close();
    });

    it('captures at pipeline admission before asynchronous backfill', async () => {
        const f = makeRuntime();
        await f.runtime.open();
        f.generation.setOnline(true);
        const gate = deferred();
        fixture.backfill = () => gate.promise;
        const callbacks = new Map<string, (event: any) => Promise<void>>();
        const capture = vi.fn(() => f.generation.capture(f.runtime[captureBinding]()));
        const dispatch = vi.fn();
        const ctx = {
            uin: '12345',
            selfId: 12345,
            bridge: {
                events: {
                    on: (kind: string, callback: any) => {
                        callbacks.set(kind, callback);
                        return () => callbacks.delete(kind);
                    },
                },
            },
            converterCtx: { selfId: 12345 },
            [captureSource]: capture,
            dispatchEvent: dispatch,
        };
        const pipeline = registerEventPipeline(ctx as never);
        const pending = callbacks.get('group_member_join')!({
            kind: 'group_member_join',
            time: 1,
            selfUin: 12345,
            groupId: 1,
            userUin: 2,
            operatorUin: 2,
        });
        expect(capture).toHaveBeenCalledOnce();
        const original = capture.mock.results[0]!.value;
        f.generation.setOnline(false);
        f.generation.setOnline(true);
        gate.resolve();
        await pending;
        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatch.mock.calls[0]![3]).toBe(original);
        expect(f.runtime[verifySource](original)).toBe(false);
        fixture.backfill = null;
        pipeline.stop();
        await pipeline.drain();
        await f.runtime.close();
    });

    it.each(['sendPrivateMessage', 'sendPrivateForwardMsg', 'forwardSingleMsg'] as const)(
        'captures once before async %s and shares the ticket',
        async (method) => {
            const f = makeRuntime();
            await f.runtime.open();
            f.generation.setOnline(true);
            const gate = deferred();
            const dispatch = vi.fn(async () => {});
            const capture = vi.fn(() => f.generation.capture(f.runtime[captureBinding]()));

            fixture.send = async (handler) => {
                await gate.promise;
                await handler({ test: 1 });
                await handler({ test: 2 });
            };

            const api = buildApiContext({
                bridge: {},
                messageStore: {},
                mediaStore: {},
                reactionStore: {},
                [captureSource]: capture,
                dispatchEvent: dispatch,
            } as never);
            const pending =
                method === 'sendPrivateMessage'
                    ? api.sendPrivateMessage(2, 'hi', false)
                    : method === 'sendPrivateForwardMsg'
                      ? api.sendPrivateForwardMsg(2, [], undefined)
                      : api.forwardSingleMsg(1, { userId: 2 });
            expect(capture).toHaveBeenCalledOnce();
            const original = capture.mock.results[0]!.value;
            f.generation.setOnline(false);
            f.generation.setOnline(true);
            gate.resolve();
            await pending;
            expect(dispatch.mock.calls).toHaveLength(2);
            expect(dispatch.mock.calls[0]![3]).toBe(original);
            expect(dispatch.mock.calls[1]![3]).toBe(original);
            expect(f.runtime[verifySource](original)).toBe(false);
            fixture.send = null;
            await f.runtime.close();
        },
    );

    it('captures only the actual managed adapter, and absent hooks remain unknown', async () => {
        const f = makeRuntime();
        await f.runtime.open();
        f.generation.setOnline(true);
        const instance = Object.create(OneBotInstance.prototype) as any;
        Object.assign(instance, {
            networkManager: f.manager,
            v12Adapter: f.runtime,
            sourceGeneration: f.generation,
            disposeRequested: false,
        });
        expect(instance.captureEventSource()).toBeDefined();
        instance.v12Adapter = makeRuntime().runtime;
        expect(instance.captureEventSource()).toBeUndefined();
        const dispatch = vi.fn(async () => {});

        fixture.send = async (handler) => {
            await handler({});
        };

        const api = buildApiContext({
            bridge: {},
            messageStore: {},
            mediaStore: {},
            reactionStore: {},
            dispatchEvent: dispatch,
        } as never);
        await api.sendPrivateMessage(2, 'hi', false);
        expect(dispatch.mock.calls[0]).toHaveLength(2);
        const throwingApi = buildApiContext({
            bridge: {},
            messageStore: {},
            mediaStore: {},
            reactionStore: {},
            dispatchEvent: dispatch,
            [captureSource]: () => {
                throw new Error('capture failed');
            },
        } as never);
        await throwingApi.sendPrivateMessage(2, 'hi', false);
        expect(dispatch.mock.calls[1]).toHaveLength(2);
        fixture.send = null;
        await f.runtime.close();
    });
});
