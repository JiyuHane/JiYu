import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { V12TransportOptions } from '../../src/v12-network';

const fixture = vi.hoisted(() => ({
    transports: [] as Array<{
        options: V12TransportOptions;
        open: () => Promise<void>;
        close: () => Promise<void>;
        quiesce: () => void;
    }>,
    construct: null as null | ((options: V12TransportOptions) => void),
    open: null as null | (() => Promise<void>),
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

import { OneBotInstance } from '../../src/instance';
import { OneBotNetworkManager } from '../../src/network/network-manager';
import { V12_ADAPTER_NAME } from '../../src/v12-runtime/identity';
import {
    activatePollOwner,
    createPollGate,
    enqueuePollEvent,
    invalidatePollOwner,
    pollOwnerStats,
    registerPollHost,
    type PollOwner,
} from '../../src/v12-runtime/poll-owner';
import {
    captureBinding,
    receiveSourceEvent,
    SourceGeneration,
} from '../../src/v12-runtime/source-generation';
import type { V12Runtime } from '../../src/v12-runtime/runtime';
import { PollTransaction, type PollSink } from '../../src/v12-runtime/poll-transaction';
import { EventPollBuffer } from '../../src/v12-runtime/event-poll-buffer';

class Sink extends EventEmitter implements PollSink {
    body = '';
    opened = true;
    autoFinish = true;
    headAction?: () => void;
    isOpen() {
        return this.opened;
    }
    writeHead() {
        this.headAction?.();
    }
    end(body: string) {
        this.body = body;

        if (this.autoFinish) {
            this.emit('finish');
        }
    }
}

function request(timeoutMs = 0) {
    return {
        limit: 1,
        timeoutMs,
        maxOutputBytes: 1024 * 1024,
        responseDeadline: performance.now() + 12_000,
    };
}

function event(id: number, self = 12345, text = 'hello') {
    return {
        post_type: 'message',
        self_id: self,
        user_id: 23456,
        message_id: id,
        time: 1,
        message_type: 'private',
        sub_type: 'friend',
        raw_message: text,
        message: [{ type: 'text', data: { text } }],
    };
}

function setup(uin = '12345') {
    const generation = new SourceGeneration();
    const manager = new OneBotNetworkManager();
    const instance = Object.create(OneBotInstance.prototype) as any;
    Object.assign(instance, {
        uin,
        networkManager: manager,
        v12Adapter: null,
        sourceGeneration: generation,
        v12PollGate: createPollGate(),
        disposeRequested: false,
        v12Online: false,
        bridge: { receiveHealthy: true },
        dispatchEvent: vi.fn(async () => {}),
    });
    const desired = {
        kind: 'v12Server',
        name: V12_ADAPTER_NAME,
        config: {
            name: V12_ADAPTER_NAME,
            enabled: true,
            host: '127.0.0.1',
            port: 1,
            allowNonLoopback: false,
        },
    };
    const ctx = { uin, api: {}, buildLifecycleEvent: () => ({}), buildHeartbeatEvent: () => ({}) };
    const create = () => instance.createNetworkAdapter(desired, ctx) as V12Runtime;
    const runtime = create();
    manager.register(runtime);
    return { generation, manager, instance, runtime, create };
}

function owner(runtime: V12Runtime): PollOwner {
    const activation = activatePollOwner(runtime);
    expect(activation.status).toBe('ready');

    if (activation.status !== 'ready') {
        throw new Error('fixture owner unavailable');
    }

    return activation.owner;
}

async function flush() {
    for (let i = 0; i < 12; i++) {
        await Promise.resolve();
    }
}

afterEach(() => {
    fixture.construct = null;
    fixture.open = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('explicit internal poll owner (pure memory)', () => {
    it('keeps source out of two-argument override calls and shares each conversion with WS', async () => {
        const f = setup();
        await f.runtime.open();
        await f.instance.emitBotStatus('online');
        const poll = owner(f.runtime);
        const ticket = f.generation.capture(f.runtime[captureBinding]())!;
        const seen = vi.fn();
        fixture.transports.at(-1)!.options.subscribe(seen);
        seen.mockClear();
        const original = f.runtime.onEvent.bind(f.runtime);
        const spy = vi.spyOn(f.runtime, 'onEvent').mockImplementation((value, payload) => {
            original(value, payload);
            original(value, payload);
        });
        const value = event(31);
        const payload = {} as never;
        f.runtime[receiveSourceEvent](value, payload, ticket);
        expect(spy).toHaveBeenCalledOnce();
        expect(spy.mock.calls[0]).toEqual([value, payload]);
        expect(spy.mock.calls[0]).toHaveLength(2);
        expect(Object.values(value)).not.toContain(ticket);
        expect(Object.values(payload as object)).not.toContain(ticket);
        expect(seen).toHaveBeenCalledTimes(2);

        for (let i = 0; i < 2; i++) {
            const sink = new Sink();
            expect((await poll.start(request(), sink).result).kind).toBe('local_finish');
            const received = JSON.parse(sink.body).data[0];
            expect(received.id).toBe((seen.mock.calls[i]![0] as { id: string }).id);
            expect(received.message_id).toBe('31');
            expect(Object.values(received)).not.toContain(ticket);
        }

        expect((seen.mock.calls[0]![0] as { id: string }).id).not.toBe(
            (seen.mock.calls[1]![0] as { id: string }).id,
        );
        await f.runtime.close();
        await flush();
    });

    it.each(['outer', 'inner'] as const)(
        'uses only the matching nested scope when %s has the valid ticket',
        async (valid) => {
            const f = setup();
            await f.runtime.open();
            await f.instance.emitBotStatus('online');
            const poll = owner(f.runtime);
            const current = f.generation.capture(f.runtime[captureBinding]())!;
            const other = new SourceGeneration();
            other.setOnline(true);
            const foreign = other.capture(f.runtime[captureBinding]())!;
            const outer = event(41);
            const inner = event(42);
            const outerPayload = {} as never;
            const innerPayload = {} as never;
            const seen = vi.fn();
            fixture.transports.at(-1)!.options.subscribe(seen);
            seen.mockClear();
            const original = f.runtime.onEvent.bind(f.runtime);
            const spy = vi.spyOn(f.runtime, 'onEvent').mockImplementation((value, payload) => {
                if (value === outer) {
                    f.runtime[receiveSourceEvent](
                        inner,
                        innerPayload,
                        valid === 'inner' ? current : foreign,
                    );
                }

                original(value, payload);
            });
            f.runtime[receiveSourceEvent](
                outer,
                outerPayload,
                valid === 'outer' ? current : foreign,
            );
            expect(spy.mock.calls.map((args) => args.length)).toEqual([2, 2]);
            expect(seen).toHaveBeenCalledTimes(2);
            const sink = new Sink();
            await poll.start(request(), sink).result;
            const item = JSON.parse(sink.body).data[0];
            expect(item.message_id).toBe(valid === 'outer' ? '41' : '42');
            expect(item.id).toBe(
                (seen.mock.calls[valid === 'inner' ? 0 : 1]![0] as { id: string }).id,
            );
            const empty = new Sink();
            await poll.start(request(), empty).result;
            expect(JSON.parse(empty.body).data).toEqual([]);
            await f.runtime.close();
            await flush();
        },
    );

    it('cleans the scope after throwing and does not grant a later direct call a ticket', async () => {
        const f = setup();
        await f.runtime.open();
        await f.instance.emitBotStatus('online');
        const poll = owner(f.runtime);
        const ticket = f.generation.capture(f.runtime[captureBinding]())!;
        const value = event(51);
        const payload = {} as never;
        const seen = vi.fn();
        fixture.transports.at(-1)!.options.subscribe(seen);
        seen.mockClear();
        const spy = vi.spyOn(f.runtime, 'onEvent').mockImplementation(() => {
            throw new Error('fixture override');
        });
        expect(() => f.runtime[receiveSourceEvent](value, payload, ticket)).toThrow(
            'fixture override',
        );
        spy.mockRestore();
        f.runtime.onEvent(value, payload);
        expect(seen).toHaveBeenCalledOnce();
        const sink = new Sink();
        await poll.start(request(), sink).result;
        expect(JSON.parse(sink.body).data).toEqual([]);
        await f.runtime.close();
        await flush();
    });

    it('manager waits for async override while its later super call has no source ticket', async () => {
        const f = setup();
        await f.runtime.open();
        await f.instance.emitBotStatus('online');
        const poll = owner(f.runtime);
        const ticket = f.generation.capture(f.runtime[captureBinding]())!;
        const seen = vi.fn();
        fixture.transports.at(-1)!.options.subscribe(seen);
        seen.mockClear();
        const original = f.runtime.onEvent.bind(f.runtime);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const spy = vi.spyOn(f.runtime, 'onEvent').mockImplementation(async (value, payload) => {
            await gate;
            await original(value, payload);
        });
        let settled = false;
        const dispatch = f.manager.emitEvent(event(71), ticket).then(() => {
            settled = true;
        });
        await flush();
        expect(spy.mock.calls[0]).toHaveLength(2);
        expect(settled).toBe(false);
        expect(seen).not.toHaveBeenCalled();
        release();
        await dispatch;
        expect(settled).toBe(true);
        expect(seen).toHaveBeenCalledOnce();
        const sink = new Sink();
        await poll.start(request(), sink).result;
        expect(JSON.parse(sink.body).data).toEqual([]);
        await f.runtime.close();
        await flush();
    });

    it('manager observes async override rejection without unhandled rejection', async () => {
        const f = setup();
        await f.runtime.open();
        await f.instance.emitBotStatus('online');
        const ticket = f.generation.capture(f.runtime[captureBinding]())!;
        let reject!: (error: Error) => void;
        const gate = new Promise<void>((_, fail) => {
            reject = fail;
        });
        const spy = vi.spyOn(f.runtime, 'onEvent').mockReturnValue(gate);
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown) => unhandled.push(error);
        process.on('unhandledRejection', onUnhandled);

        try {
            let settled = false;
            const dispatch = f.manager.emitEvent(event(72), ticket).then(() => {
                settled = true;
            });
            await flush();
            expect(spy.mock.calls[0]).toHaveLength(2);
            expect(settled).toBe(false);
            reject(new Error('fixture async rejection'));
            await expect(dispatch).resolves.toBeUndefined();
            expect(settled).toBe(true);
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
            await f.runtime.close();
            await flush();
        }
    });

    it('does not restore a source ticket for asynchronous override continuation', async () => {
        const f = setup();
        await f.runtime.open();
        await f.instance.emitBotStatus('online');
        const poll = owner(f.runtime);
        const ticket = f.generation.capture(f.runtime[captureBinding]())!;
        const seen = vi.fn();
        fixture.transports.at(-1)!.options.subscribe(seen);
        seen.mockClear();
        const original = f.runtime.onEvent.bind(f.runtime);
        const spy = vi.spyOn(f.runtime, 'onEvent').mockImplementation((value, payload) => {
            queueMicrotask(() => original(value, payload));
        });
        f.runtime[receiveSourceEvent](event(61), {} as never, ticket);
        expect(spy.mock.calls[0]).toHaveLength(2);
        await flush();
        expect(seen).toHaveBeenCalledOnce();
        const sink = new Sink();
        await poll.start(request(), sink).result;
        expect(JSON.parse(sink.body).data).toEqual([]);
        await f.runtime.close();
        await flush();
    });
    it('locks same-instance replacement while a selected real queue token is delayed', async () => {
        const f = setup();
        await f.runtime.open();
        await f.instance.emitBotStatus('online');
        const poll = owner(f.runtime);
        let release!: () => void;
        const delayed = new Promise<void>((resolve) => {
            release = resolve;
        });
        let selected = false;
        const original = EventPollBuffer.prototype.reserve;
        vi.spyOn(EventPollBuffer.prototype, 'reserve').mockImplementation(function (options) {
            return original.call(this, options).then(async (result) => {
                if (result.status === 'reserved') {
                    selected = true;
                    await delayed;
                }

                return result;
            });
        });
        const pending = poll.start(request(1000), new Sink());
        await flush();
        const ticket = f.generation.capture(f.runtime[captureBinding]())!;
        f.runtime[receiveSourceEvent](event(1), {} as never, ticket);
        await flush();
        expect(selected).toBe(true);
        await f.manager.closeOne(V12_ADAPTER_NAME);
        const next = f.create();
        f.manager.register(next);
        await next.open();
        expect(activatePollOwner(next).status).toBe('cleanup_pending');
        expect(pollOwnerStats(next)).toMatchObject({
            cleanup_pending: true,
            cleanup_uncertain: false,
            accepted: 0,
        });
        release();
        expect((await pending.result).kind).toBe('closed');
        await flush();
        expect(pollOwnerStats(f.runtime)).toMatchObject({
            cleanup_pending: false,
            closing_discard: 1,
        });
        expect(activatePollOwner(next).status).toBe('ready');
        await next.close();
        await flush();
    });

    it('locks all runtimes of one instance on uncertain cleanup, not another same-UIN instance', async () => {
        const f = setup();
        const other = setup();
        await f.runtime.open();
        await other.runtime.open();
        await f.instance.emitBotStatus('online');
        await other.instance.emitBotStatus('online');
        const p = owner(f.runtime);
        const sink = new Sink();
        const realOff = sink.off.bind(sink);
        vi.spyOn(sink, 'off').mockImplementation((name, listener) => {
            if (name === 'close') {
                throw new Error('private cleanup');
            }

            return realOff(name, listener);
        });
        const result = await p.start(request(), sink).result;
        expect(result).toMatchObject({ kind: 'cleanup_uncertain', committed: false });
        await flush();
        expect(pollOwnerStats(f.runtime)).toMatchObject({
            cleanup_pending: true,
            cleanup_uncertain: true,
            postcommit_unknown: 0,
        });
        await f.manager.closeOne(V12_ADAPTER_NAME);
        const next = f.create();
        f.manager.register(next);
        await next.open();
        expect(activatePollOwner(next).status).toBe('cleanup_pending');
        expect(pollOwnerStats(next)).toMatchObject({
            cleanup_pending: true,
            cleanup_uncertain: true,
            accepted: 0,
        });
        expect(activatePollOwner(other.runtime).status).toBe('ready');
        expect(JSON.stringify(pollOwnerStats(next))).not.toContain('private cleanup');
        await next.close();
        await other.runtime.close();
        await flush();
    });
    it('starts empty long poll before first source event; WS is independent', async () => {
        const f = setup();
        await f.runtime.open();
        await f.instance.emitBotStatus('online');
        const transport = fixture.transports.at(-1)!;
        const ws = vi.fn();
        transport.options.subscribe(ws);
        ws.mockClear();
        expect(pollOwnerStats(f.runtime)).toMatchObject({ active: false, accepted: 0 });
        const ticket = f.generation.capture(f.runtime[captureBinding]())!;
        await f.manager.emitEvent(event(1), ticket);
        expect(ws).toHaveBeenCalledOnce();
        expect(pollOwnerStats(f.runtime)).toMatchObject({ active: false, accepted: 0 });
        const poll = owner(f.runtime);
        const sink = new Sink();
        const pending = poll.start(request(1000), sink);
        await flush();
        await f.manager.emitEvent(event(2), ticket);
        expect(await pending.result).toEqual({ kind: 'local_finish', response: 'events' });
        expect(JSON.parse(sink.body).data.map((x: any) => x.message_id)).toEqual(['2']);
        expect(ws).toHaveBeenCalledTimes(2);
        expect(pollOwnerStats(f.runtime)).toMatchObject({ accepted: 1 });
        await f.runtime.close();
        await flush();
    });

    it('does not admit missing, stale, wrong account or other owner tickets but preserves WS', async () => {
        const f = setup();
        const other = setup();
        await f.runtime.open();
        await other.runtime.open();
        await f.instance.emitBotStatus('online');
        await other.instance.emitBotStatus('online');
        const seen = vi.fn();
        fixture.transports.at(-2)!.options.subscribe(seen);
        seen.mockClear();
        const p = owner(f.runtime);
        const old = f.generation.capture(f.runtime[captureBinding]())!;
        const foreign = other.generation.capture(other.runtime[captureBinding]())!;
        await f.manager.emitEvent(event(1));
        await f.manager.emitEvent(event(2), foreign);
        await f.manager.emitEvent(event(3, 99999), old);
        f.generation.setOnline(false);
        f.generation.setOnline(true);
        await f.manager.emitEvent(event(4), old);
        expect(seen).toHaveBeenCalledTimes(3);
        expect(pollOwnerStats(f.runtime)).toMatchObject({ accepted: 0 });
        expect((await p.start(request(), new Sink()).result).kind).toBe('epoch_invalid');
        await f.runtime.close();
        await other.runtime.close();
        await flush();
    });

    it('repeated online preserves owner, offline retires waits and old queued events once', async () => {
        vi.useFakeTimers();
        const f = setup();
        await f.runtime.open();
        await f.instance.emitBotStatus('online');
        const p = owner(f.runtime);
        const ticket = f.generation.capture(f.runtime[captureBinding]())!;
        await f.instance.emitBotStatus('online');
        expect(activatePollOwner(f.runtime)).toEqual({ status: 'ready', owner: p });
        const first = p.start(request(1000), new Sink());
        const waiting = p.start(request(1000), new Sink());
        await flush();
        await f.manager.emitEvent(event(1), ticket);
        await f.instance.emitBotStatus('offline');
        expect(activatePollOwner(f.runtime).status).toBe('cleanup_pending');
        const outcomes = await Promise.all([first.result, waiting.result]);
        expect(outcomes.every((x) => x.kind === 'closed' || x.kind === 'local_finish')).toBe(true);
        await flush();
        expect(pollOwnerStats(f.runtime)).toMatchObject({ active: false, cleanup_pending: false });
        await f.instance.emitBotStatus('online');
        const next = owner(f.runtime);
        expect(next).not.toBe(p);
        const emptySink = new Sink();
        expect(await next.start(request(), emptySink).result).toEqual({
            kind: 'local_finish',
            response: 'empty',
            reason: 'empty',
        });
        expect(JSON.parse(emptySink.body).data).toEqual([]);
        expect((await p.start(request(), new Sink()).result).kind).toBe('epoch_invalid');
        await f.runtime.close();
        await flush();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('shares FIFO between consumers and isolates accounts', async () => {
        const a = setup('12345');
        const b = setup('77777');
        await a.runtime.open();
        await b.runtime.open();
        await a.instance.emitBotStatus('online');
        await b.instance.emitBotStatus('online');
        const pa = owner(a.runtime);
        const pb = owner(b.runtime);
        const ta = a.generation.capture(a.runtime[captureBinding]())!;
        const tb = b.generation.capture(b.runtime[captureBinding]())!;
        await a.manager.emitEvent(event(1), ta);
        await a.manager.emitEvent(event(2), ta);
        await b.manager.emitEvent(event(3, 77777), tb);
        const s1 = new Sink();
        const s2 = new Sink();
        const sb = new Sink();
        expect((await pa.start(request(), s1).result).kind).toBe('local_finish');
        expect((await pa.start(request(), s2).result).kind).toBe('local_finish');
        expect((await pb.start(request(), sb).result).kind).toBe('local_finish');
        expect([s1, s2, sb].map((s) => JSON.parse(s.body).data[0].message_id)).toEqual([
            '1',
            '2',
            '3',
        ]);
        await a.runtime.close();
        await b.runtime.close();
        await flush();
    });

    it('counts full and oversize without echoing payload; no queue without activation', async () => {
        const f = setup();
        await f.runtime.open();
        await f.instance.emitBotStatus('online');
        const p = owner(f.runtime);
        const t = f.generation.capture(f.runtime[captureBinding]())!;

        for (let id = 1; id <= 129; id++) {
            await f.manager.emitEvent(event(id), t);
        }

        await f.manager.emitEvent(event(130, 12345, 'private-fixture-'.repeat(7000)), t);
        expect(pollOwnerStats(f.runtime)).toMatchObject({ accepted: 128, full: 1, too_large: 1 });
        expect(JSON.stringify(pollOwnerStats(f.runtime))).not.toContain('private-fixture');
        p.invalidate();
        await flush();
        expect(pollOwnerStats(f.runtime)).toMatchObject({ closing_discard: 128 });
        await f.runtime.close();
    });

    it('retires on sync quiesce throw while preserving existing active status', async () => {
        const f = setup();
        await f.runtime.open();
        await f.instance.emitBotStatus('online');
        const p = owner(f.runtime);
        const t = f.generation.capture(f.runtime[captureBinding]())!;
        await f.manager.emitEvent(event(1), t);
        const transport = fixture.transports.at(-1)!;
        const error = new Error('quiesce');

        transport.quiesce = () => {
            throw error;
        };

        await expect(f.runtime.close()).rejects.toBe(error);
        expect(f.runtime.isActive).toBe(true);
        expect((await p.start(request(), new Sink()).result).kind).toBe('epoch_invalid');
        await flush();
        expect(pollOwnerStats(f.runtime)).toMatchObject({ closing_discard: 1 });

        transport.quiesce = () => {};

        await f.runtime.close();
    });

    it('invalidates before instance replaces adapter identity', async () => {
        const f = setup();
        await f.runtime.open();
        await f.instance.emitBotStatus('online');
        const p = owner(f.runtime);
        const pending = p.start(request(1000), new Sink());
        await flush();
        f.create();
        expect((await pending.result).kind).toBe('closed');
        await flush();
        expect(activatePollOwner(f.runtime).status).toBe('unavailable');
        await f.runtime.close();
    });

    it('retains a replacement claim across reentrant activation cleanup', () => {
        const key = {};
        const gate = createPollGate();
        const generation = new SourceGeneration();
        const binding = {};
        const replacement = {};
        generation.setOnline(true);
        const ticket = generation.capture(binding)!;
        registerPollHost(
            key,
            {
                captureBinding: () => binding,
                captureSource: () => {
                    invalidatePollOwner(key);
                    // Controlled reentry models a newer owner of the shared gate.
                    gate.claim = replacement;
                    return ticket;
                },
                verify: (value) => generation.isCurrent(value, binding),
            },
            gate,
        );
        expect(activatePollOwner(key).status).toBe('unavailable');
        expect(gate.claim).toBe(replacement);
    });

    it.each(['release', 'commit', 'run'] as const)(
        'locks the gate on controlled %s uncertainty',
        async (mode) => {
            const f = setup();
            await f.runtime.open();
            await f.instance.emitBotStatus('online');
            const p = owner(f.runtime);
            const ticket = f.generation.capture(f.runtime[captureBinding]())!;

            if (mode === 'run') {
                vi.spyOn(PollTransaction.prototype, 'run').mockImplementation(() =>
                    Promise.reject(new Error('private rejection')),
                );
                await expect(p.start(request(), new Sink()).result).rejects.toThrow(
                    'private rejection',
                );
            } else if (mode === 'commit') {
                const realCommit = EventPollBuffer.prototype.commit;
                vi.spyOn(EventPollBuffer.prototype, 'commit').mockImplementation(function (token) {
                    realCommit.call(this, token);
                    throw new Error('private commit');
                });
                await f.manager.emitEvent(event(1), ticket);
                expect((await p.start(request(), new Sink()).result).kind).toBe('commit_unknown');
            } else {
                vi.spyOn(EventPollBuffer.prototype, 'release').mockReturnValue(false);
                const pending = p.start(request(1000), new Sink());
                await flush();
                f.runtime[receiveSourceEvent](event(1), {} as never, ticket);
                pending.cancel();
                expect((await pending.result).kind).toBe('release_unknown');
            }

            await flush();
            expect(pollOwnerStats(f.runtime)).toMatchObject({
                cleanup_pending: true,
                cleanup_uncertain: true,
            });
            expect(activatePollOwner(f.runtime).status).toBe('cleanup_pending');
            expect(JSON.stringify(pollOwnerStats(f.runtime))).not.toContain('private');
            await f.runtime.close();
        },
    );

    it('rejects activation invalidated by a synchronous host capture', () => {
        const key = {};
        const generation = new SourceGeneration();
        const binding = {};
        generation.setOnline(true);
        const ticket = generation.capture(binding)!;
        registerPollHost(key, {
            captureBinding: () => binding,
            captureSource: () => {
                invalidatePollOwner(key);
                return ticket;
            },
            verify: (value) => generation.isCurrent(value, binding),
        });
        expect(activatePollOwner(key).status).toBe('unavailable');
        expect(pollOwnerStats(key)).toMatchObject({ active: false, cleanup_pending: false });
    });

    it('pre-registers startup so synchronous retirement cannot lose a transaction', async () => {
        const f = setup();
        await f.runtime.open();
        await f.instance.emitBotStatus('online');
        const p = owner(f.runtime);
        const input = request();
        Object.defineProperty(input, 'limit', {
            get: () => {
                p.invalidate();
                return 1;
            },
        });
        const pending = p.start(input, new Sink());
        expect(activatePollOwner(f.runtime).status).toBe('cleanup_pending');
        expect((await pending.result).kind).toBe('epoch_invalid');
        await flush();
        expect(pollOwnerStats(f.runtime)).toMatchObject({ cleanup_pending: false });
        await f.runtime.close();
    });

    it('separately counts unknown postcommit delivery without replay', async () => {
        const f = setup();
        await f.runtime.open();
        await f.instance.emitBotStatus('online');
        const p = owner(f.runtime);
        const t = f.generation.capture(f.runtime[captureBinding]())!;
        await f.manager.emitEvent(event(1), t);
        const sink = new Sink();

        sink.end = () => {
            throw new Error('private sink failure');
        };

        const result = await p.start(request(), sink).result;
        expect(result).toEqual({ kind: 'unknown', committed: true });
        await flush();
        expect(pollOwnerStats(f.runtime)).toMatchObject({ postcommit_unknown: 1 });
        p.invalidate();
        await flush();
        expect(pollOwnerStats(f.runtime)).toMatchObject({
            closing_discard: 0,
            postcommit_unknown: 1,
        });
        await f.runtime.close();
    });

    it('isolates queue exceptions from WS and only keeps fixed diagnostics', async () => {
        const f = setup();
        await f.runtime.open();
        await f.instance.emitBotStatus('online');
        owner(f.runtime);
        const seen = vi.fn();
        fixture.transports.at(-1)!.options.subscribe(seen);
        seen.mockClear();
        vi.spyOn(EventPollBuffer.prototype, 'enqueue').mockImplementation(() => {
            throw new Error('secret payload');
        });
        const t = f.generation.capture(f.runtime[captureBinding]())!;
        await f.manager.emitEvent(event(1), t);
        expect(seen).toHaveBeenCalledOnce();
        await flush();
        expect(pollOwnerStats(f.runtime)).toMatchObject({ invalid: 1, active: false });
        expect(JSON.stringify(pollOwnerStats(f.runtime))).not.toContain('secret');
        await f.runtime.close();
    });

    it('rejects invalid and meta shapes and records no payload', async () => {
        const key = {};
        const generation = new SourceGeneration();
        const binding = {};
        generation.setOnline(true);
        const ticket = generation.capture(binding)!;
        registerPollHost(key, {
            captureBinding: () => binding,
            captureSource: () => ticket,
            verify: (value) => generation.isCurrent(value, binding),
        });
        expect(activatePollOwner(key).status).toBe('ready');
        enqueuePollEvent(key, { type: 'message', x: undefined }, ticket);
        enqueuePollEvent(key, { type: 'meta' }, ticket);
        expect(pollOwnerStats(key)).toMatchObject({ invalid: 1, accepted: 0 });
        invalidatePollOwner(key);
        await flush();
    });

    it('does not lose selected reservations when close precedes continuation', async () => {
        const f = setup();
        await f.runtime.open();
        await f.instance.emitBotStatus('online');
        const p = owner(f.runtime);
        const t = f.generation.capture(f.runtime[captureBinding]())!;
        const pending = p.start(request(1000), new Sink());
        await flush();
        // Synchronous admission selects the waiting token, but its continuation
        // has not run when this same stack retires the owner.
        f.runtime[receiveSourceEvent](event(1), {} as never, t);
        invalidatePollOwner(f.runtime);
        const result = await pending.result;
        expect(result.kind).toBe('closed');
        await flush();
        expect(pollOwnerStats(f.runtime)).toMatchObject({
            cleanup_pending: false,
            closing_discard: 1,
        });
        await f.runtime.close();
    });
});
