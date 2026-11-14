import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
    convert: vi.fn(),
    options: null as any,
    onSelfSent: null as null | ((event: any) => Promise<void>),
}));
vi.mock('../../src/event-converter', () => ({ CONVERTERS: {}, convertEvent: fake.convert }));
vi.mock('../../src/modules/message-actions', () => ({
    backfillReplyTarget: async (_ctx: unknown, event: unknown) => event,
    sendPrivateMessage: async (
        _ref: unknown,
        _user: unknown,
        _message: unknown,
        _escape: unknown,
        _group: unknown,
        onSelfSent: (event: any) => Promise<void>,
    ) => {
        fake.onSelfSent = onSelfSent;
        return { messageId: 1 };
    },
}));
vi.mock('@snowluma/websocket', () => ({ WebSocket: class {}, WebSocketServer: class {} }));
vi.mock('../../src/v12-network', () => ({
    V12Transport: class {
        constructor(options: unknown) {
            fake.options = options;
        }
        async open() {}
        async close() {}
        quiesce() {}
        forceClose() {}
    },
}));

import { registerEventPipeline } from '../../src/event-pipeline';
import { EventPollBuffer } from '../../src/v12-runtime/event-poll-buffer';
import {
    activateOrderedPollOwner,
    activatePollOwner,
    createPollGate,
    enqueuePollEvent,
    pollOwnerStats,
    recordPreparedScopeLoss,
    registerPollHost,
} from '../../src/v12-runtime/poll-owner';
import {
    bindOrderedContext,
    captureBinding,
    captureSource,
    claimOrderedScope,
    installOrderedReady,
    prepareOrderedContext,
    receiveSourceEvent,
    reserveOrderedContext,
    revokeOrderedContext,
    revokeOrderedReady,
    verifySource,
    SourceGeneration,
    withOrderedScope,
    type V12Source,
} from '../../src/v12-runtime/source-generation';
import { IOneBotNetworkAdapter } from '../../src/network/adapter';
import type { DispatchPayload } from '../../src/event-filter';
import type { JsonObject, NetworkBase } from '../../src/types';
import { OneBotNetworkManager } from '../../src/network/network-manager';
import { V12Runtime } from '../../src/v12-runtime/runtime';
import { V12_ADAPTER_NAME } from '../../src/v12-runtime/identity';
import { OneBotInstance } from '../../src/instance';
import { buildApiContext, scopeInstanceContextDispatch } from '../../src/instance-context';

const v12 = (id: number) => ({
    id: `id-${id}`,
    time: 1,
    type: 'message',
    detail_type: 'private',
    sub_type: '',
    self: { platform: 'qq', user_id: '12345' },
    message_id: String(id),
    message: [],
    alt_message: '',
    user_id: '23456',
});

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
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
class FakeAdapter extends IOneBotNetworkAdapter<NetworkBase> {
    readonly calls: Array<{ kind: string; args: unknown[] }> = [];
    throws = false;
    constructor(name: string) {
        super(
            name,
            { name, enabled: true, messageFormat: 'array', reportSelfMessage: false },
            {
                uin: '12345',
                api: {} as never,
                buildLifecycleEvent: () => ({}),
                buildHeartbeatEvent: () => ({}),
            },
        );
    }
    open() {
        this.isEnabled = true;
    }
    close() {
        this.isEnabled = false;
    }
    describeStatus() {
        return {
            name: this.name,
            kind: 'httpClient' as const,
            status: 'ok' as const,
            detail: 'fake',
        };
    }
    override [receiveSourceEvent](event: JsonObject, payload: DispatchPayload, source: V12Source) {
        this.calls.push({ kind: 'source', args: [event, payload, source] });

        if (this.throws) {
            throw new Error('fake adapter failure');
        }
    }
    onEvent(event: JsonObject, payload: DispatchPayload) {
        this.calls.push({ kind: 'plain', args: [event, payload] });
    }
}

async function setup() {
    const listeners = new Map<string, (event: any) => Promise<void>>();
    const generation = new SourceGeneration();
    generation.setOnline(true);
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
            captureCurrentSource: () => generation.capture(runtime[captureBinding]()),
            isSourceCurrent: (source, binding) =>
                manager.get(V12_ADAPTER_NAME) === runtime && generation.isCurrent(source, binding),
        },
    );
    manager.register(runtime);
    await runtime.open();
    const binding = runtime[captureBinding]();

    if (!binding) {
        throw new Error('fake binding');
    }

    const result = activateOrderedPollOwner(runtime);

    if (result.status !== 'ready') {
        throw new Error('owner');
    }

    const owner = result.owner;
    const seen: number[] = [];
    const ctx = {
        uin: '12345',
        selfId: 12345,
        bridge: {
            events: {
                on: (kind: string, cb: (event: any) => Promise<void>) => {
                    listeners.set(kind, cb);
                    return () => listeners.delete(kind);
                },
            },
        },
        converterCtx: {},
        [captureSource]: () => generation.capture(binding),
        dispatchEvent: (event: any) => {
            const admission = claimOrderedScope(ctx, 'context', event);
            seen.push(event.id);

            if (admission?.kind === 'eligible') {
                admission.lease.resolve(v12(event.id));
            }
        },
    };
    return { ctx, listeners, generation, binding, runtime, owner, seen, manager };
}

function attachFakeInstance(f: Awaited<ReturnType<typeof setup>>) {
    const instance = Object.create(OneBotInstance.prototype) as any;
    Object.assign(instance, {
        networkManager: f.manager,
        v12Adapter: f.runtime,
        ctx: f.ctx,
        pluginHost: null,
        log: { trace: vi.fn(), warn: vi.fn() },
        cacheMessageEvent: async () => true,
        isDuplicateSelfSentEcho: () => false,
        logReceivedMessage: async () => {},
        handleStatusCommand: () => false,
    });
    f.ctx.dispatchEvent = scopeInstanceContextDispatch(
        f.ctx as never,
        instance,
        (event, source, started, ticket) => instance.dispatchEvent(event, source, started, ticket),
    );
    return instance;
}

const v11 = (id: number) => ({
    post_type: 'message',
    self_id: 12345,
    user_id: 23456,
    message_id: id,
    time: 1,
    message_type: 'private',
    sub_type: 'friend',
    raw_message: 'hello',
    message: [{ type: 'text', data: { text: 'hello' } }],
});

async function settle() {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fake.convert.mockReset();
    fake.onSelfSent = null;
});

describe('ordered admission producer foundation (fake context, not full runtime integration)', () => {
    it('releases a real reserved legacy token when prepared scope is lost', async () => {
        vi.useFakeTimers();
        const f = await setup();
        f.owner.invalidate();
        await settle();
        const legacy = activatePollOwner(f.runtime);

        if (legacy.status !== 'ready') {
            throw new Error('legacy');
        }

        const source = f.generation.capture(f.binding)!;
        enqueuePollEvent(f.runtime, v12(71), source);
        prepareOrderedContext(f.ctx, f.runtime);
        const admission = bindOrderedContext(f.ctx, reserveOrderedContext(f.ctx), source, true);
        const selected = deferred<void>();
        const resume = deferred<void>();
        const originalReserve = EventPollBuffer.prototype.reserve;
        let selectedCount = 0;
        const reserve = vi
            .spyOn(EventPollBuffer.prototype, 'reserve')
            .mockImplementation(async function (this: EventPollBuffer, options) {
                const result = await originalReserve.call(this, options);

                if (result.status === 'reserved') {
                    selectedCount++;
                    selected.resolve();
                    await resume.promise;
                }

                return result;
            });
        const commit = vi.spyOn(EventPollBuffer.prototype, 'commit');
        const release = vi.spyOn(EventPollBuffer.prototype, 'release');
        const close = vi.spyOn(EventPollBuffer.prototype, 'close');
        const sink = new Sink();
        const head = vi.spyOn(sink, 'writeHead');
        const end = vi.spyOn(sink, 'end');
        const request = {
            limit: 0,
            timeoutMs: 0,
            maxOutputBytes: 65536,
            responseDeadline: performance.now() + 5000,
        };
        const result = legacy.owner.start(request, sink).result;
        await selected.promise;
        withOrderedScope(f.ctx, 'context', {}, admission, () => undefined);
        expect(pollOwnerStats(f.runtime)?.ordering_reason).toBe('scope_lost');
        expect(close).not.toHaveBeenCalled();
        resume.resolve();
        expect((await result).kind).toBe('closed');
        await settle();
        expect(selectedCount).toBe(1);
        expect(reserve).toHaveBeenCalledOnce();
        expect(commit).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
        expect(head).not.toHaveBeenCalled();
        expect(end).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
        await f.runtime.close();
    });
    it('does not replay a committed legacy token when prepared scope is lost', async () => {
        vi.useFakeTimers();
        const f = await setup();
        f.owner.invalidate();
        await settle();
        const legacy = activatePollOwner(f.runtime);

        if (legacy.status !== 'ready') {
            throw new Error('legacy');
        }

        const source = f.generation.capture(f.binding)!;
        enqueuePollEvent(f.runtime, v12(72), source);
        prepareOrderedContext(f.ctx, f.runtime);
        const admission = bindOrderedContext(f.ctx, reserveOrderedContext(f.ctx), source, true);
        const originalCommit = EventPollBuffer.prototype.commit;
        const commit = vi.spyOn(EventPollBuffer.prototype, 'commit').mockImplementation(function (
            this: EventPollBuffer,
            token,
        ) {
            const committed = originalCommit.call(this, token);

            if (committed) {
                withOrderedScope(f.ctx, 'context', {}, admission, () => undefined);
            }

            return committed;
        });
        const release = vi.spyOn(EventPollBuffer.prototype, 'release');
        const sink = new Sink();
        const head = vi.spyOn(sink, 'writeHead');
        const end = vi.spyOn(sink, 'end');
        const request = {
            limit: 0,
            timeoutMs: 0,
            maxOutputBytes: 65536,
            responseDeadline: performance.now() + 5000,
        };
        expect((await legacy.owner.start(request, sink).result).kind).toBe('committed_unsent');
        await settle();
        expect(commit).toHaveBeenCalledOnce();
        expect(release).not.toHaveBeenCalled();
        expect(head).not.toHaveBeenCalled();
        expect(end).not.toHaveBeenCalled();
        expect(pollOwnerStats(f.runtime)).toMatchObject({
            ordering_gap: true,
            ordering_reason: 'scope_lost',
        });
        expect(activatePollOwner(f.runtime).status).toBe('degraded');
        await f.runtime.close();
    });
    it('marks a prepared context override scope loss before a later legacy owner can activate', async () => {
        vi.useFakeTimers();
        const f = await setup();
        f.owner.invalidate();
        await settle();
        const instance = attachFakeInstance(f);
        prepareOrderedContext(f.ctx, f.runtime);
        const published: any[] = [];
        fake.options.subscribe((value: unknown) => published.push(value));
        const delayed = deferred<void>();
        const original = f.ctx.dispatchEvent;

        f.ctx.dispatchEvent = async (...args: any[]) => {
            await delayed.promise;
            return (original as (...values: any[]) => unknown)(...args);
        };

        fake.convert.mockReturnValue(v11(91));
        const pipeline = registerEventPipeline(f.ctx as never);
        const task = f.listeners.get('group_recall')!({ kind: 'group_recall', id: 91 });
        await settle();
        expect(pollOwnerStats(f.runtime)).toMatchObject({
            ordering_gap: true,
            ordering_reason: 'scope_lost',
        });
        expect(activatePollOwner(f.runtime).status).toBe('degraded');
        delayed.resolve();
        await task;
        expect(
            published.filter((event) => event.type === 'message').map((event) => event.message_id),
        ).toEqual(['91']);
        expect(activatePollOwner(f.runtime).status).toBe('degraded');
        pipeline.stop();
        await pipeline.drain();
        await f.runtime.close();
        void instance;
    });
    it('revokes an active legacy owner when the instance override loses a prepared scope', async () => {
        vi.useFakeTimers();
        const f = await setup();
        f.owner.invalidate();
        await settle();
        const instance = attachFakeInstance(f);
        prepareOrderedContext(f.ctx, f.runtime);
        const legacy = activatePollOwner(f.runtime);
        expect(legacy.status).toBe('ready');

        if (legacy.status !== 'ready') {
            throw new Error('legacy');
        }

        const other = new FakeAdapter('scope-v11');
        other.open();
        f.manager.register(other);
        const published: any[] = [];
        fake.options.subscribe((value: unknown) => published.push(value));
        const delayed = deferred<void>();
        const original = instance.dispatchEvent.bind(instance);

        instance.dispatchEvent = async (...args: any[]) => {
            await delayed.promise;
            return original(...args);
        };

        fake.convert.mockReturnValue(v11(92));
        const pipeline = registerEventPipeline(f.ctx as never);
        const task = f.listeners.get('group_recall')!({ kind: 'group_recall', id: 92 });
        await settle();
        expect(pollOwnerStats(f.runtime)).toMatchObject({
            ordering_gap: true,
            ordering_reason: 'scope_lost',
            cleanup_uncertain: false,
        });
        expect(activatePollOwner(f.runtime).status).toBe('degraded');
        const req = {
            limit: 0,
            timeoutMs: 0,
            maxOutputBytes: 65536,
            responseDeadline: performance.now() + 5000,
        };
        expect((await legacy.owner.start(req, new Sink()).result).kind).toBe('epoch_invalid');
        delayed.resolve();
        await task;
        expect(
            published.filter((event) => event.type === 'message').map((event) => event.message_id),
        ).toEqual(['92']);
        expect(other.calls).toHaveLength(1);
        expect(other.calls[0]?.args).toHaveLength(3);
        pipeline.stop();
        await pipeline.drain();
        await f.runtime.close();
    });
    it('makes missing original source uncertain without calling host verification', async () => {
        vi.useFakeTimers();
        const f = await setup();
        f.owner.invalidate();
        await settle();
        prepareOrderedContext(f.ctx, f.runtime);
        const verify = vi.spyOn(f.runtime, verifySource);
        const admission = bindOrderedContext(f.ctx, reserveOrderedContext(f.ctx), undefined, true);
        const event = {};
        withOrderedScope(f.ctx, 'context', event, admission, () => undefined);
        expect(verify).not.toHaveBeenCalled();
        expect(pollOwnerStats(f.runtime)).toMatchObject({
            cleanup_uncertain: true,
            ordering_gap: false,
        });
        expect(activatePollOwner(f.runtime).status).toBe('cleanup_pending');
        await f.runtime.close();
    });
    it('makes host verification reentry uncertain and never opens another owner', async () => {
        vi.useFakeTimers();
        const f = await setup();
        f.owner.invalidate();
        await settle();
        prepareOrderedContext(f.ctx, f.runtime);
        const source = f.generation.capture(f.binding);
        const admission = bindOrderedContext(f.ctx, reserveOrderedContext(f.ctx), source, true);
        const original = f.runtime[verifySource].bind(f.runtime);
        let reentered = false;
        vi.spyOn(f.runtime, verifySource).mockImplementation((ticket) => {
            reentered = true;
            expect(activatePollOwner(f.runtime).status).toBe('cleanup_pending');
            return original(ticket);
        });
        withOrderedScope(f.ctx, 'context', {}, admission, () => undefined);
        expect(reentered).toBe(true);
        expect(pollOwnerStats(f.runtime)).toMatchObject({
            cleanup_uncertain: true,
            ordering_gap: false,
        });
        await f.runtime.close();
    });
    it('never overwrites another epoch or another runtime claim when scope loss occurs', async () => {
        vi.useFakeTimers();
        const f = await setup();
        f.owner.invalidate();
        await settle();
        prepareOrderedContext(f.ctx, f.runtime);
        const oldSource = f.generation.capture(f.binding);
        const old = bindOrderedContext(f.ctx, reserveOrderedContext(f.ctx), oldSource, true);
        f.generation.setOnline(false);
        f.generation.setOnline(true);
        const current = activatePollOwner(f.runtime);
        expect(current.status).toBe('ready');
        withOrderedScope(f.ctx, 'context', {}, old, () => undefined);
        expect(pollOwnerStats(f.runtime)).toMatchObject({
            cleanup_uncertain: true,
            ordering_gap: false,
        });
        await f.runtime.close();
        const gate = createPollGate();
        const gen = new SourceGeneration();
        gen.setOnline(true);
        const binding = {};
        const one = {};
        const two = {};
        const host = {
            captureBinding: () => binding,
            captureSource: () => gen.capture(binding),
            verify: (source: V12Source | undefined) => gen.isCurrent(source, binding),
        };
        registerPollHost(one, host, gate);
        registerPollHost(two, host, gate);
        const first = activatePollOwner(one);
        expect(first.status).toBe('ready');
        recordPreparedScopeLoss(two, gen.capture(binding));
        expect(pollOwnerStats(two)).toMatchObject({ cleanup_uncertain: true, ordering_gap: false });
        expect(activatePollOwner(two).status).toBe('cleanup_pending');
    });
    it('reserves actual pipeline inputs before asynchronous conversion', async () => {
        vi.useFakeTimers();
        const f = await setup();
        prepareOrderedContext(f.ctx, f.runtime);
        expect(installOrderedReady(f.ctx, f.runtime, f.owner)).not.toBeNull();
        const a = deferred<unknown>();
        fake.convert.mockImplementation((_ctx, input) =>
            input.id === 1 ? a.promise : { id: input.id },
        );
        const pipeline = registerEventPipeline(f.ctx as never);
        const first = f.listeners.get('group_recall')!({ kind: 'group_recall', id: 1 });
        const second = f.listeners.get('group_recall')!({ kind: 'group_recall', id: 2 });
        await settle();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.seen).toEqual([2]);
        const emptySink = new Sink();
        const req = {
            limit: 0,
            timeoutMs: 0,
            maxOutputBytes: 65536,
            responseDeadline: performance.now() + 5000,
        };
        expect((await f.owner.start(req, emptySink).result).kind).toBe('empty_unresolved');
        a.resolve({ id: 1 });
        await Promise.all([first, second]);
        await vi.advanceTimersByTimeAsync(0);
        const sink = new Sink();
        expect((await f.owner.start(req, sink).result).kind).toBe('local_finish');
        expect(JSON.parse(sink.body).data).toEqual([v12(1), v12(2)]);
        pipeline.stop();
        await pipeline.drain();
        f.owner.invalidate();
        await settle();
    });
    it('reserves parent before reentrant source capture', async () => {
        vi.useFakeTimers();
        const f = await setup();
        prepareOrderedContext(f.ctx, f.runtime);
        installOrderedReady(f.ctx, f.runtime, f.owner);
        fake.convert.mockImplementation((_ctx, input) => ({ id: input.id }));
        let nested: Promise<void> | undefined;
        let inside = false;

        f.ctx[captureSource] = () => {
            if (!inside) {
                inside = true;
                nested = f.listeners.get('group_recall')!({ kind: 'group_recall', id: 2 });
            }

            return f.generation.capture(f.binding);
        };

        const pipeline = registerEventPipeline(f.ctx as never);
        const first = f.listeners.get('group_recall')!({ kind: 'group_recall', id: 1 });
        await first;
        await nested;
        await vi.advanceTimersByTimeAsync(0);
        const sink = new Sink();
        const req = {
            limit: 0,
            timeoutMs: 0,
            maxOutputBytes: 65536,
            responseDeadline: performance.now() + 5000,
        };
        expect((await f.owner.start(req, sink).result).kind).toBe('local_finish');
        expect(JSON.parse(sink.body).data).toEqual([v12(1), v12(2)]);
        pipeline.stop();
        await pipeline.drain();
        f.owner.invalidate();
        await settle();
    });
    it('routes the real pipeline through the real manager and runtime with fake transports', async () => {
        vi.useFakeTimers();
        const generation = new SourceGeneration();
        generation.setOnline(true);
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
                captureCurrentSource: () => generation.capture(runtime[captureBinding]()),
                isSourceCurrent: (source, binding) =>
                    manager.get(V12_ADAPTER_NAME) === runtime &&
                    generation.isCurrent(source, binding),
            },
        );
        manager.register(runtime);
        const other = new FakeAdapter('other');
        other.open();
        other.throws = true;
        manager.register(other);
        await runtime.open();
        const receiver = vi.spyOn(runtime, receiveSourceEvent);
        const onEvent = vi.spyOn(runtime, 'onEvent');
        const activated = activateOrderedPollOwner(runtime);

        if (activated.status !== 'ready') {
            throw new Error('owner');
        }

        const owner = activated.owner;
        const listeners = new Map<string, (event: any) => Promise<void>>();
        const published: any[] = [];
        // Exercise the real instance prototype without starting stores, QQ or listeners.
        const instance = Object.create(OneBotInstance.prototype) as any;
        Object.assign(instance, {
            networkManager: manager,
            v12Adapter: runtime,
            pluginHost: null,
            log: { trace: vi.fn(), warn: vi.fn() },
            cacheMessageEvent: async () => true,
            isDuplicateSelfSentEcho: () => false,
            rememberSelfSentEvent: () => {},
            logReceivedMessage: async () => {},
            handleStatusCommand: () => false,
        });
        const ctx = {
            uin: '12345',
            selfId: 12345,
            bridge: {
                events: {
                    on: (kind: string, cb: (event: any) => Promise<void>) => {
                        listeners.set(kind, cb);
                        return () => listeners.delete(kind);
                    },
                },
            },
            converterCtx: {},
            [captureSource]: () => generation.capture(runtime[captureBinding]()),
            dispatchEvent: (event: any, source: any, started: any, ticket: any) =>
                instance.dispatchEvent(event, source, started, ticket),
        };
        ctx.dispatchEvent = scopeInstanceContextDispatch(ctx as never, instance, ctx.dispatchEvent);
        const contextDispatch = vi.spyOn(ctx, 'dispatchEvent');
        instance.ctx = ctx;
        prepareOrderedContext(ctx, runtime);
        const api = buildApiContext(ctx as never);
        await api.sendPrivateMessage(23456, 'fixture', false);
        expect(fake.onSelfSent).not.toBeNull();
        fake.options.subscribe((event: unknown) => published.push(event));
        const firstConverted = deferred<unknown>();
        const beforeReadyConverted = deferred<unknown>();
        fake.convert.mockImplementation((_ctx, input) =>
            input.id === 3
                ? beforeReadyConverted.promise
                : input.id === 1
                  ? firstConverted.promise
                  : {
                        post_type: 'message',
                        self_id: 12345,
                        user_id: 23456,
                        message_id: input.id,
                        time: 1,
                        message_type: 'private',
                        sub_type: 'friend',
                        raw_message: 'hello',
                        message: [{ type: 'text', data: { text: 'hello' } }],
                    },
        );
        const pipeline = registerEventPipeline(ctx as never);
        const beforeReady = listeners.get('group_recall')!({ kind: 'group_recall', id: 3 });
        await settle();
        expect(installOrderedReady(ctx, runtime, owner)).not.toBeNull();
        beforeReadyConverted.resolve({
            post_type: 'message',
            self_id: 12345,
            user_id: 23456,
            message_id: 3,
            time: 1,
            message_type: 'private',
            sub_type: 'friend',
            raw_message: 'hello',
            message: [{ type: 'text', data: { text: 'hello' } }],
        });
        await beforeReady;
        expect(pollOwnerStats(runtime)?.ordering_gap).toBe(false);
        published.length = 0;
        other.calls.length = 0;
        const first = listeners.get('group_recall')!({ kind: 'group_recall', id: 1 });
        const second = listeners.get('group_recall')!({ kind: 'group_recall', id: 2 });
        await settle();
        await vi.advanceTimersByTimeAsync(0);
        expect(published.filter((x) => x.type === 'message').map((x) => x.message_id)).toEqual([
            '2',
        ]);
        const req = {
            limit: 0,
            timeoutMs: 0,
            maxOutputBytes: 65536,
            responseDeadline: performance.now() + 5000,
        };
        expect((await owner.start(req, new Sink()).result).kind).toBe('empty_unresolved');
        firstConverted.resolve({
            post_type: 'message',
            self_id: 12345,
            user_id: 23456,
            message_id: 1,
            time: 1,
            message_type: 'private',
            sub_type: 'friend',
            raw_message: 'hello',
            message: [{ type: 'text', data: { text: 'hello' } }],
        });
        await Promise.all([first, second]);
        await vi.advanceTimersByTimeAsync(0);
        const sink = new Sink();
        expect((await owner.start(req, sink).result).kind).toBe('local_finish');
        expect(JSON.parse(sink.body).data.map((x: any) => x.message_id)).toEqual(['1', '2']);
        expect(receiver.mock.calls.every((args) => args.length === 3)).toBe(true);
        expect(onEvent.mock.calls.every((args) => args.length === 2)).toBe(true);
        expect(contextDispatch.mock.calls.every((args) => args.length === 4)).toBe(true);
        expect(other.calls).toHaveLength(2);
        expect(other.calls.every((entry) => entry.args.length === 3)).toBe(true);
        const holdSelf = deferred<void>();

        instance.cacheMessageEvent = async (event: any) => {
            if (event.post_type === 'message_sent' && event.message_id === 10) {
                await holdSelf.promise;
            }

            return true;
        };

        const selfEvent = (message_id: number) => ({
            post_type: 'message_sent',
            self_id: 12345,
            user_id: 23456,
            message_id,
            time: 1,
            message_type: 'private',
            sub_type: 'friend',
            raw_message: 'sent',
            message: [],
        });
        const sent1 = fake.onSelfSent!(selfEvent(10));
        const sent2 = fake.onSelfSent!(selfEvent(11));
        const afterSelf = listeners.get('group_recall')!({ kind: 'group_recall', id: 5 });
        await settle();
        await vi.advanceTimersByTimeAsync(0);
        expect((await owner.start(req, new Sink()).result).kind).toBe('empty_unresolved');
        holdSelf.resolve();
        await Promise.all([sent1, sent2, afterSelf]);
        await vi.advanceTimersByTimeAsync(0);
        const afterSink = new Sink();
        expect((await owner.start(req, afterSink).result).kind).toBe('local_finish');
        expect(JSON.parse(afterSink.body).data.map((x: any) => x.message_id)).toEqual(['5']);
        expect(pollOwnerStats(runtime)?.ordering_gap).toBe(false);
        await instance.dispatchEvent({
            post_type: 'message',
            self_id: 12345,
            user_id: 23456,
            message_id: 4,
            time: 1,
            message_type: 'private',
            sub_type: 'friend',
            raw_message: 'hello',
            message: [{ type: 'text', data: { text: 'hello' } }],
        });
        expect(pollOwnerStats(runtime)?.ordering_gap).toBe(true);
        expect(published.filter((x) => x.type === 'message').at(-1)?.message_id).toBe('4');
        pipeline.stop();
        await pipeline.drain();
        owner.invalidate();
        await settle();
        await runtime.close();
    });
    it('does not backfill pre-ready input into a later legacy owner, but unprepared legacy still receives', async () => {
        vi.useFakeTimers();
        const generation = new SourceGeneration();
        generation.setOnline(true);
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
                captureCurrentSource: () => generation.capture(runtime[captureBinding]()),
                isSourceCurrent: (source, binding) =>
                    manager.get(V12_ADAPTER_NAME) === runtime &&
                    generation.isCurrent(source, binding),
            },
        );
        manager.register(runtime);
        await runtime.open();
        const published: any[] = [];
        fake.options.subscribe((event: unknown) => published.push(event));
        const instance = Object.create(OneBotInstance.prototype) as any;
        Object.assign(instance, {
            networkManager: manager,
            v12Adapter: runtime,
            pluginHost: null,
            log: { trace: vi.fn(), warn: vi.fn() },
            cacheMessageEvent: async () => true,
            isDuplicateSelfSentEcho: () => false,
            logReceivedMessage: async () => {},
            handleStatusCommand: () => false,
        });
        const listeners = new Map<string, (event: any) => Promise<void>>();
        const ctx = {
            uin: '12345',
            selfId: 12345,
            bridge: {
                events: {
                    on: (kind: string, cb: (event: any) => Promise<void>) => {
                        listeners.set(kind, cb);
                        return () => listeners.delete(kind);
                    },
                },
            },
            converterCtx: {},
            [captureSource]: () => generation.capture(runtime[captureBinding]()),
            dispatchEvent: (event: any, source: any, started: any, ticket: any) =>
                instance.dispatchEvent(event, source, started, ticket),
        };
        ctx.dispatchEvent = scopeInstanceContextDispatch(ctx as never, instance, ctx.dispatchEvent);
        instance.ctx = ctx;
        prepareOrderedContext(ctx, runtime);
        const waiting = deferred<unknown>();
        const v11 = (id: number) => ({
            post_type: 'message',
            self_id: 12345,
            user_id: 23456,
            message_id: id,
            time: 1,
            message_type: 'private',
            sub_type: 'friend',
            raw_message: 'hello',
            message: [{ type: 'text', data: { text: 'hello' } }],
        });
        fake.convert.mockImplementation((_ctx, event) =>
            event.id === 1 ? waiting.promise : v11(event.id),
        );
        const pipeline = registerEventPipeline(ctx as never);
        const oldEvent = listeners.get('group_recall')!({ kind: 'group_recall', id: 1 });
        await settle();
        const ordered = activateOrderedPollOwner(runtime);

        if (ordered.status !== 'ready') {
            throw new Error('ordered');
        }

        const cut = installOrderedReady(ctx, runtime, ordered.owner);

        if (!cut) {
            throw new Error('cut');
        }

        expect(revokeOrderedReady(ctx, cut)).toBe(true);
        ordered.owner.invalidate();
        await settle();
        expect(pollOwnerStats(runtime)?.ordering_gap).toBe(false);
        const legacy = activatePollOwner(runtime);

        if (legacy.status !== 'ready') {
            throw new Error('legacy');
        }

        waiting.resolve(v11(1));
        await oldEvent;
        expect(published.filter((e) => e.type === 'message').map((e) => e.message_id)).toEqual([
            '1',
        ]);
        const req = {
            limit: 0,
            timeoutMs: 0,
            maxOutputBytes: 65536,
            responseDeadline: performance.now() + 5000,
        };
        const empty = new Sink();
        expect((await legacy.owner.start(req, empty).result).kind).toBe('local_finish');
        expect(JSON.parse(empty.body).data).toEqual([]);
        const unpreparedListeners = new Map<string, (event: any) => Promise<void>>();
        const unprepared = {
            ...ctx,
            bridge: {
                events: {
                    on: (kind: string, cb: (event: any) => Promise<void>) => {
                        unpreparedListeners.set(kind, cb);
                        return () => unpreparedListeners.delete(kind);
                    },
                },
            },
        };
        expect(() => prepareOrderedContext(unprepared, null as never)).toThrow(TypeError);
        expect(reserveOrderedContext(unprepared).kind).toBe('disabled');
        unprepared.dispatchEvent = scopeInstanceContextDispatch(
            unprepared as never,
            instance,
            (event, source, started, ticket) =>
                instance.dispatchEvent(event, source, started, ticket),
        );
        const secondPipeline = registerEventPipeline(unprepared as never);
        await unpreparedListeners.get('group_recall')!({ kind: 'group_recall', id: 6 });
        const sink = new Sink();
        expect((await legacy.owner.start(req, sink).result).kind).toBe('local_finish');
        expect(JSON.parse(sink.body).data.map((event: any) => event.message_id)).toEqual(['6']);
        pipeline.stop();
        secondPipeline.stop();
        await pipeline.drain();
        await secondPipeline.drain();
        legacy.owner.invalidate();
        await settle();
        await runtime.close();
    });
    it('fails a late runtime override while preserving its promise and other adapters', async () => {
        vi.useFakeTimers();
        const generation = new SourceGeneration();
        generation.setOnline(true);
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
                captureCurrentSource: () => generation.capture(runtime[captureBinding]()),
                isSourceCurrent: (source, binding) =>
                    manager.get(V12_ADAPTER_NAME) === runtime &&
                    generation.isCurrent(source, binding),
            },
        );
        manager.register(runtime);
        const other = new FakeAdapter('other');
        other.open();
        manager.register(other);
        await runtime.open();
        const activated = activateOrderedPollOwner(runtime);

        if (activated.status !== 'ready') {
            throw new Error('owner');
        }

        const listeners = new Map<string, (event: any) => Promise<void>>();
        const published: any[] = [];
        const ctx = {
            uin: '12345',
            selfId: 12345,
            bridge: {
                events: {
                    on: (kind: string, cb: (event: any) => Promise<void>) => {
                        listeners.set(kind, cb);
                        return () => listeners.delete(kind);
                    },
                },
            },
            converterCtx: {},
            [captureSource]: () => generation.capture(runtime[captureBinding]()),
            dispatchEvent: (event: any, _source: unknown, _started: unknown, source: any) => {
                const admission = claimOrderedScope(ctx, 'context', event);

                if (!admission) {
                    throw new Error('missing scope');
                }

                return withOrderedScope(manager, 'manager', event, admission, () =>
                    manager.emitEvent(event, source),
                );
            },
        };
        prepareOrderedContext(ctx, runtime);
        expect(installOrderedReady(ctx, runtime, activated.owner)).not.toBeNull();
        fake.options.subscribe((event: unknown) => published.push(event));
        const delayed = deferred<void>();
        const original = runtime.onEvent.bind(runtime);
        const override = vi.spyOn(runtime, 'onEvent').mockImplementation(async (event, payload) => {
            await delayed.promise;
            return original(event, payload);
        });
        fake.convert.mockReturnValue({
            post_type: 'message',
            self_id: 12345,
            user_id: 23456,
            message_id: 1,
            time: 1,
            message_type: 'private',
            sub_type: 'friend',
            raw_message: 'hello',
            message: [{ type: 'text', data: { text: 'hello' } }],
        });
        const pipeline = registerEventPipeline(ctx as never);
        let settled = false;
        const task = listeners.get('group_recall')!({ kind: 'group_recall', id: 1 });
        void task.then(() => {
            settled = true;
        });
        await settle();
        expect(pollOwnerStats(runtime)?.ordering_gap).toBe(true);
        expect(other.calls).toHaveLength(1);
        expect(settled).toBe(false);
        expect(override.mock.calls[0]).toHaveLength(2);
        delayed.resolve();
        await task;
        expect(published.filter((x) => x.type === 'message').map((x) => x.message_id)).toEqual([
            '1',
        ]);
        pipeline.stop();
        await pipeline.drain();
        await runtime.close();
    });
    it('preserves every adapter source branch and isolates one adapter failure', async () => {
        const manager = new OneBotNetworkManager();
        const a = new FakeAdapter('a');
        const b = new FakeAdapter('b');
        a.open();
        b.open();
        b.throws = true;
        manager.register(a);
        manager.register(b);
        const generation = new SourceGeneration();
        generation.setOnline(true);
        const ticket = generation.capture({})!;
        const event = { post_type: 'notice' };
        await manager.emitEvent(event, ticket);
        expect(a.calls).toHaveLength(1);
        expect(b.calls).toHaveLength(1);
        expect(a.calls[0]?.kind).toBe('source');
        expect(a.calls[0]?.args).toHaveLength(3);
        expect(a.calls[0]?.args[2]).toBe(ticket);
        expect(b.calls[0]?.args).toHaveLength(3);
        b.throws = false;
        await manager.emitEvent(event);
        expect(a.calls[1]?.kind).toBe('plain');
        expect(a.calls[1]?.args).toHaveLength(2);
        expect(b.calls[1]?.kind).toBe('plain');
        expect(b.calls[1]?.args).toHaveLength(2);
    });
    it('fails an unclaimed asynchronous context scope without exposing the child', async () => {
        vi.useFakeTimers();
        const f = await setup();
        prepareOrderedContext(f.ctx, f.runtime);
        installOrderedReady(f.ctx, f.runtime, f.owner);
        const delayed = deferred<void>();
        const calls: unknown[][] = [];
        let captured: unknown = 'unset';

        f.ctx.dispatchEvent = async (...args: any[]) => {
            calls.push(args);
            await delayed.promise;
            captured = claimOrderedScope(f.ctx, 'context', args[0]);
        };

        fake.convert.mockImplementation((_ctx, input) => ({ id: input.id }));
        const pipeline = registerEventPipeline(f.ctx as never);
        const task = f.listeners.get('group_recall')!({ kind: 'group_recall', id: 1 });
        await settle();
        expect(calls).toHaveLength(1);
        expect(calls[0]).toHaveLength(4);
        expect(activateOrderedPollOwner(f.runtime).status).not.toBe('ready');
        delayed.resolve();
        await task;
        expect(captured).toBeNull();
        pipeline.stop();
        await pipeline.drain();
        f.owner.invalidate();
        await settle();
    });
    it('never replays a revoked old lease into a later online epoch', async () => {
        vi.useFakeTimers();
        const f = await setup();
        prepareOrderedContext(f.ctx, f.runtime);
        const cut = installOrderedReady(f.ctx, f.runtime, f.owner);
        expect(cut).not.toBeNull();
        const old = bindOrderedContext(
            f.ctx,
            reserveOrderedContext(f.ctx),
            f.generation.capture(f.binding),
            true,
        );
        expect(old.kind).toBe('eligible');
        const waiting = f.owner.start(
            {
                limit: 0,
                timeoutMs: 100,
                maxOutputBytes: 65536,
                responseDeadline: performance.now() + 5000,
            },
            new Sink(),
        );
        waiting.cancel();
        expect((await waiting.result).kind).toBe('cancelled');
        expect(revokeOrderedReady(f.ctx, cut!)).toBe(true);
        f.owner.invalidate();
        await settle();
        f.generation.setOnline(false);
        f.generation.setOnline(true);
        const next = activateOrderedPollOwner(f.runtime);
        expect(next.status).toBe('ready');

        if (next.status !== 'ready') {
            throw new Error('next owner');
        }

        expect(installOrderedReady(f.ctx, f.runtime, next.owner)).not.toBeNull();

        if (old.kind !== 'eligible') {
            throw new Error('old lease');
        }

        expect(old.lease.resolve(v12(9))).toBe(false);
        const current = bindOrderedContext(
            f.ctx,
            reserveOrderedContext(f.ctx),
            f.generation.capture(f.binding),
            true,
        );

        if (current.kind !== 'eligible') {
            throw new Error('new lease');
        }

        expect(current.lease.resolve(v12(10))).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        const sink = new Sink();
        const req = {
            limit: 0,
            timeoutMs: 0,
            maxOutputBytes: 65536,
            responseDeadline: performance.now() + 5000,
        };
        expect((await next.owner.start(req, sink).result).kind).toBe('local_finish');
        expect(JSON.parse(sink.body).data).toEqual([v12(10)]);
        next.owner.invalidate();
        await settle();
    });
    it('never lets overflowed same-event recursion claim an outer frame', async () => {
        vi.useFakeTimers();
        const f = await setup();
        const context = {};
        const target = f.runtime;
        const event = {};
        prepareOrderedContext(context, target);
        const admission = bindOrderedContext(
            context,
            reserveOrderedContext(context),
            undefined,
            true,
        );
        expect(admission.kind).toBe('not_eligible');
        let calls = 0;
        const descend = (n: number): unknown =>
            withOrderedScope(context, 'context', event, admission, () => {
                calls++;
                return n === 0 ? claimOrderedScope(context, 'context', event) : descend(n - 1);
            });
        expect(descend(32)).toBeNull();
        expect(calls).toBe(33);
        expect(claimOrderedScope(context, 'context', event)).toBeNull();
        f.owner.invalidate();
        await settle();
        await f.runtime.close();
    });
    it('rejects missing, null, unregistered and conflicting targets without a usable cell', async () => {
        vi.useFakeTimers();
        const first = await setup();
        const second = await setup();
        const context = {};
        expect(installOrderedReady(context, first.runtime, first.owner)).toBeNull();
        expect(() => {
            // @ts-expect-error a target is mandatory
            prepareOrderedContext(context);
        }).toThrow(TypeError);
        expect(reserveOrderedContext(context).kind).toBe('disabled');
        expect(() => prepareOrderedContext(context, null as never)).toThrow(TypeError);
        expect(() => prepareOrderedContext(context, { fake: true })).toThrow(TypeError);
        expect(reserveOrderedContext(context).kind).toBe('disabled');
        prepareOrderedContext(context, first.runtime);
        const old = reserveOrderedContext(context);
        expect(old).toEqual({ kind: 'not_eligible', target: first.runtime });
        expect(() => prepareOrderedContext(context, second.runtime)).toThrow(
            'ordered context target mismatch',
        );
        expect(installOrderedReady(context, second.runtime, second.owner)).toBeNull();
        expect(bindOrderedContext(context, old, undefined, true)).toEqual({
            kind: 'not_eligible',
            target: first.runtime,
            source: undefined,
            reportOnLoss: true,
        });
        const cut = installOrderedReady(context, first.runtime, first.owner);
        expect(cut).not.toBeNull();
        prepareOrderedContext(context, first.runtime);
        const pending = reserveOrderedContext(context);
        expect(pending.kind).toBe('reserved');

        if (pending.kind === 'reserved') {
            pending.reservation.fail();
        }

        first.owner.invalidate();
        second.owner.invalidate();
        await settle();
        await first.runtime.close();
        await second.runtime.close();
    });
    it('rejects fake and foreign facades without inspecting supplied objects', async () => {
        vi.useFakeTimers();
        const first = await setup();
        const second = await setup();
        const context = {};
        prepareOrderedContext(context, first.runtime);
        const verify = vi.spyOn(first.runtime, verifySource);
        let reads = 0;
        const malicious = new Proxy(
            {},
            {
                get() {
                    reads++;
                    throw new Error('getter');
                },
                getPrototypeOf() {
                    reads++;
                    throw new Error('prototype');
                },
                ownKeys() {
                    reads++;
                    throw new Error('keys');
                },
                getOwnPropertyDescriptor() {
                    reads++;
                    throw new Error('descriptor');
                },
            },
        );
        const structural = {
            matchesTarget() {
                reads++;
                return true;
            },
        };
        expect(
            installOrderedReady(context, first.runtime, malicious as typeof first.owner),
        ).toBeNull();
        expect(
            installOrderedReady(context, first.runtime, structural as typeof first.owner),
        ).toBeNull();
        expect(installOrderedReady(context, first.runtime, second.owner)).toBeNull();
        expect(reads).toBe(0);
        expect(verify).not.toHaveBeenCalled();
        expect(installOrderedReady(context, first.runtime, first.owner)).not.toBeNull();
        first.owner.invalidate();
        second.owner.invalidate();
        await settle();
        await first.runtime.close();
        await second.runtime.close();
    });
    it('detects pre-ready context revocation during verification and ignores stale cuts', async () => {
        vi.useFakeTimers();
        const f = await setup();
        const context = {};
        prepareOrderedContext(context, f.runtime);
        const original = f.runtime[verifySource].bind(f.runtime);
        const verify = vi.spyOn(f.runtime, verifySource).mockImplementationOnce((source) => {
            revokeOrderedContext(context);
            return original(source);
        });
        expect(installOrderedReady(context, f.runtime, f.owner)).toBeNull();
        expect(reserveOrderedContext(context).kind).toBe('not_eligible');
        verify.mockImplementationOnce((source) => {
            expect(revokeOrderedReady(context, {})).toBe(false);
            return original(source);
        });
        expect(installOrderedReady(context, f.runtime, f.owner)).not.toBeNull();
        f.owner.invalidate();
        await settle();
        await f.runtime.close();
    });
    it('rejects nested installation on a different context without damaging the owner', async () => {
        vi.useFakeTimers();
        const f = await setup();
        const first = {};
        const second = {};
        prepareOrderedContext(first, f.runtime);
        prepareOrderedContext(second, f.runtime);
        const original = f.runtime[verifySource].bind(f.runtime);
        let inner: object | null | undefined;
        const verify = vi.spyOn(f.runtime, verifySource).mockImplementationOnce((source) => {
            inner = installOrderedReady(second, f.runtime, f.owner);
            return original(source);
        });
        expect(installOrderedReady(first, f.runtime, f.owner)).toBeNull();
        expect(inner).toBeNull();
        verify.mockRestore();
        const cut = installOrderedReady(second, f.runtime, f.owner);
        expect(cut).not.toBeNull();
        expect(installOrderedReady(first, f.runtime, f.owner)).toBeNull();
        expect(revokeOrderedReady(second, cut!)).toBe(true);
        f.owner.invalidate();
        await settle();
        await f.runtime.close();
    });
    it('does not let a stale facade invalidate a replacement owner', async () => {
        vi.useFakeTimers();
        const f = await setup();
        const context = {};
        prepareOrderedContext(context, f.runtime);
        const original = f.runtime[verifySource].bind(f.runtime);
        const verify = vi.spyOn(f.runtime, verifySource).mockImplementationOnce((source) => {
            f.owner.invalidate();
            return original(source);
        });
        expect(installOrderedReady(context, f.runtime, f.owner)).toBeNull();
        verify.mockRestore();
        await settle();
        const replacement = activateOrderedPollOwner(f.runtime);

        if (replacement.status !== 'ready') {
            throw new Error('replacement');
        }

        expect(installOrderedReady(context, f.runtime, f.owner)).toBeNull();
        expect(installOrderedReady(context, f.runtime, replacement.owner)).not.toBeNull();
        expect(pollOwnerStats(f.runtime)?.active).toBe(true);
        replacement.owner.invalidate();
        await settle();
        await f.runtime.close();
    });
    it('leaves disabled contexts on original behavior without scopes', () => {
        const context = {};
        expect(reserveOrderedContext(context).kind).toBe('disabled');
        const pending = reserveOrderedContext(context);
        const admission = bindOrderedContext(context, pending, undefined, true);
        const value = {};
        expect(
            withOrderedScope(context, 'context', value, admission, () =>
                claimOrderedScope(context, 'context', value),
            ),
        ).toBeNull();
    });
});

describe('isolated ESM cycle initialization', () => {
    it.each(['source-first', 'owner-first'] as const)(
        'initializes from %s after a fresh module reset',
        async (order) => {
            vi.useFakeTimers();
            vi.resetModules();

            if (order === 'source-first') {
                await import('../../src/v12-runtime/source-generation');
            } else {
                await import('../../src/v12-runtime/poll-owner');
            }

            const source = await import('../../src/v12-runtime/source-generation');
            const owner = await import('../../src/v12-runtime/poll-owner');
            const runtime = {};
            const binding = {};
            const context = {};
            const generation = new source.SourceGeneration();
            generation.setOnline(true);
            owner.registerPollHost(runtime, {
                self: { platform: 'qq', user_id: '12345' },
                captureBinding: () => binding,
                captureSource: () => generation.capture(binding),
                verify: (ticket) => generation.isCurrent(ticket, binding),
            });
            // Explicit synthetic registration emulates the trusted runtime constructor in this isolated module graph.
            source.registerOrderedRuntime(runtime, () => {});
            source.prepareOrderedContext(context, runtime);
            const active = owner.activateOrderedPollOwner(runtime);

            if (active.status !== 'ready') {
                throw new Error('isolated owner');
            }

            const cut = source.installOrderedReady(context, runtime, active.owner);
            expect(cut).not.toBeNull();
            expect(source.revokeOrderedReady(context, cut!)).toBe(true);
            active.owner.invalidate();
            await settle();
        },
    );
});
