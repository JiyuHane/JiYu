import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@snowluma/websocket', () => ({ WebSocket: class {}, WebSocketServer: class {} }));
vi.mock('../../src/v12-network', () => ({
    V12Transport: class {
        async open() {}
        async close() {}
        quiesce() {}
        forceClose() {}
    },
}));

import { V12Runtime } from '../../src/v12-runtime/runtime';
import { V12_ADAPTER_NAME } from '../../src/v12-runtime/identity';
import {
    activateOrderedPollOwner,
    pollOwnerStats,
    recordPreparedScopeLoss,
    registerPollHost,
    type OrderedPollOwner,
} from '../../src/v12-runtime/poll-owner';
import {
    bindOrderedContext,
    captureBinding,
    excludedOrderedContext,
    installOrderedReady,
    prepareOrderedContext,
    registerOrderedRuntime,
    reserveOrderedContext,
    revokeOrderedReady,
    sameSourceEpoch,
    SourceGeneration,
    withOrderedScope,
    type V12Source,
} from '../../src/v12-runtime/source-generation';

function fixture(account = '12345') {
    const runtime = {};
    const context = {};
    const binding = {};
    const generation = new SourceGeneration();
    generation.setOnline(true);
    const token = () => generation.capture(binding)!;
    registerPollHost(runtime, {
        self: { platform: 'qq', user_id: account },
        captureBinding: () => binding,
        captureSource: token,
        verify: (source: V12Source | undefined) => generation.isCurrent(source, binding),
    });
    registerOrderedRuntime(runtime, (source) => recordPreparedScopeLoss(runtime, source));
    prepareOrderedContext(context, runtime);

    const activate = () => {
        const result = activateOrderedPollOwner(runtime);
        expect(result.status).toBe('ready');

        if (result.status !== 'ready') {
            throw new Error('fixture owner not ready');
        }

        return result.owner;
    };

    const rotate = () => {
        generation.setOnline(false);
        generation.setOnline(true);
    };

    return { runtime, context, token, activate, rotate };
}

async function settle() {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
}

async function knownOldFixture() {
    const f = fixture();
    const old = f.token();
    const first = f.activate();
    first.invalidate();
    await settle();
    f.rotate();
    const owner = f.activate();
    const cut = installOrderedReady(f.context, f.runtime, owner);
    expect(cut).not.toBeNull();
    return { ...f, old, owner, cut: cut! };
}

const event = {
    id: 'queued-event',
    time: 1,
    type: 'message',
    detail_type: 'private',
    sub_type: '',
    self: { platform: 'qq', user_id: '12345' },
    message_id: '1',
    message: [],
    alt_message: '',
    user_id: '23456',
};

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

async function enqueue(owner: OrderedPollOwner, source: V12Source) {
    const parent = owner.begin(source);
    expect(parent).not.toBeNull();
    expect(parent!.child()!.resolve(event)).toBe(true);
    expect(parent!.seal()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
}

async function readQueued(owner: OrderedPollOwner) {
    const sink = new Sink();
    const result = await owner.start(
        {
            limit: 0,
            timeoutMs: 0,
            maxOutputBytes: 65536,
            responseDeadline: performance.now() + 5000,
        },
        sink,
    ).result;
    expect(result.kind).toBe('local_finish');
    expect(JSON.parse(sink.body).data).toEqual([event]);
}

afterEach(() => {
    vi.useRealTimers();
});

describe('known old source scope loss (pure fake host)', () => {
    it.each(['return', 'throw', 'overflow'] as const)(
        'preserves owner and queued event on unclaimed %s without downstream handler',
        async (mode) => {
            vi.useFakeTimers();
            const f = await knownOldFixture();
            await enqueue(f.owner, f.token());
            expect(pollOwnerStats(f.runtime)).toMatchObject({ accepted: 1, active: true });
            const pending = reserveOrderedContext(f.context);
            expect(pending.kind).toBe('reserved');
            const admission = bindOrderedContext(f.context, pending, f.old, true);
            expect(admission.kind).toBe('not_eligible');
            const failure = new Error('legacy failure');
            const invoke = vi.fn(() => {
                if (mode === 'throw') {
                    throw failure;
                }

                return 'legacy result';
            });
            const run = () => withOrderedScope(f.context, 'context', {}, admission, invoke);

            if (mode === 'throw') {
                expect(run).toThrow(failure);
            } else if (mode === 'overflow') {
                // This probes scope-loss reporting only; a real downstream handler can
                // fail closed when overflow prevents it from claiming the scope.
                const nest = (depth: number): string =>
                    depth === 0
                        ? run()
                        : withOrderedScope(
                              f.context,
                              'context',
                              {},
                              excludedOrderedContext(f.context),
                              () => nest(depth - 1),
                          );
                expect(nest(32)).toBe('legacy result');
            } else {
                expect(run()).toBe('legacy result');
            }

            expect(invoke).toHaveBeenCalledOnce();
            expect(pollOwnerStats(f.runtime)).toMatchObject({
                active: true,
                cleanup_uncertain: false,
                ordering_gap: false,
                accepted: 1,
            });
            expect(activateOrderedPollOwner(f.runtime)).toEqual({
                status: 'ready',
                owner: f.owner,
            });
            await readQueued(f.owner);
            expect(revokeOrderedReady(f.context, f.cut)).toBe(true);
            f.owner.invalidate();
            await settle();
        },
    );

    it('fails closed when overflow reaches the real runtime event handler', async () => {
        const generation = new SourceGeneration();
        generation.setOnline(true);
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
                isSourceCurrent: (source, binding) => generation.isCurrent(source, binding),
            },
        );
        const handler = vi.spyOn(runtime, 'onEvent');
        const errors: unknown[] = [];

        try {
            await runtime.open();
            const binding = runtime[captureBinding]();
            expect(binding).not.toBeNull();
            const old = generation.capture(binding)!;
            const first = activateOrderedPollOwner(runtime);
            expect(first.status).toBe('ready');

            if (first.status !== 'ready') {
                throw new Error('first owner not ready');
            }

            first.owner.invalidate();
            await settle();
            generation.setOnline(false);
            generation.setOnline(true);
            const next = activateOrderedPollOwner(runtime);
            expect(next.status).toBe('ready');

            if (next.status !== 'ready') {
                throw new Error('next owner not ready');
            }

            const context = {};
            prepareOrderedContext(context, runtime);
            expect(installOrderedReady(context, runtime, next.owner)).not.toBeNull();
            const admission = bindOrderedContext(
                context,
                reserveOrderedContext(context),
                old,
                true,
            );
            expect(admission).toMatchObject({ kind: 'not_eligible', reportOnLoss: false });
            const v11 = {
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
            const run = () =>
                withOrderedScope(runtime, 'runtime', v11, admission, () => runtime.onEvent(v11));

            const nest = (depth: number): void => {
                if (depth === 0) {
                    void run();
                    return;
                }

                withOrderedScope(runtime, 'runtime', {}, excludedOrderedContext(context), () =>
                    nest(depth - 1),
                );
            };

            nest(32);
            expect(handler).toHaveBeenCalledOnce();
            expect(pollOwnerStats(runtime)).toMatchObject({
                active: false,
                ordering_gap: true,
                ordering_reason: 'child_failed',
            });
            await settle();
            expect(activateOrderedPollOwner(runtime).status).toBe('degraded');
        } catch (error) {
            errors.push(error);
        } finally {
            try {
                handler.mockRestore();
            } catch (error) {
                errors.push(error);
            }

            try {
                await runtime.close();
            } catch (error) {
                errors.push(error);
            }
        }

        if (errors.length === 1) {
            throw errors[0];
        }

        if (errors.length > 1) {
            throw new AggregateError(errors, 'test and/or runtime cleanup failed');
        }
    });

    it('fails closed for absent source with an active owner', async () => {
        const f = await knownOldFixture();
        const admission = bindOrderedContext(
            f.context,
            reserveOrderedContext(f.context),
            undefined,
            true,
        );
        expect(admission.kind).toBe('failed');
        await settle();
        expect(pollOwnerStats(f.runtime)).toMatchObject({ active: false, ordering_gap: true });
        expect(activateOrderedPollOwner(f.runtime).status).toBe('degraded');
    });

    it('keeps pre-ready unclaimed child scope loss for a current source', async () => {
        const f = fixture();
        const owner = f.activate();
        const pending = reserveOrderedContext(f.context);
        expect(pending.kind).toBe('not_eligible');
        const admission = bindOrderedContext(f.context, pending, f.token(), true);
        expect(admission).toMatchObject({ kind: 'not_eligible', reportOnLoss: true });
        expect(withOrderedScope(f.context, 'context', {}, admission, () => 'legacy')).toBe(
            'legacy',
        );
        await settle();
        expect(pollOwnerStats(f.runtime)).toMatchObject({
            active: false,
            ordering_gap: true,
            ordering_reason: 'scope_lost',
        });
        expect(activateOrderedPollOwner(f.runtime).status).toBe('degraded');
        owner.invalidate();
    });

    it('keeps pre-ready absent source uncertain', async () => {
        const f = fixture();
        const pending = reserveOrderedContext(f.context);
        const admission = bindOrderedContext(f.context, pending, undefined, true);
        expect(admission).toMatchObject({ kind: 'not_eligible', reportOnLoss: true });
        withOrderedScope(f.context, 'context', {}, admission, () => undefined);
        expect(pollOwnerStats(f.runtime)).toMatchObject({
            cleanup_uncertain: true,
            ordering_gap: false,
        });
        expect(activateOrderedPollOwner(f.runtime).status).toBe('cleanup_pending');
    });

    it.each(['never-activated', 'ambiguous-proxy'] as const)(
        'fails closed for %s source rather than assuming old',
        async (kind) => {
            const f = fixture();
            const original = f.token();
            f.rotate();
            const owner = f.activate();
            expect(installOrderedReady(f.context, f.runtime, owner)).not.toBeNull();
            const source = kind === 'never-activated' ? original : new Proxy(original, {});
            expect(sameSourceEpoch(original, source)).toBe(
                kind === 'never-activated' ? 'same' : 'invalid',
            );
            const admission = bindOrderedContext(
                f.context,
                reserveOrderedContext(f.context),
                source,
                true,
            );
            expect(admission.kind).toBe('failed');
            await settle();
            expect(pollOwnerStats(f.runtime)).toMatchObject({ active: false, ordering_gap: true });
            expect(activateOrderedPollOwner(f.runtime).status).toBe('degraded');
        },
    );

    it('treats a different account current source as unknown rather than old', async () => {
        const f = await knownOldFixture();
        const other = fixture('67890');
        const otherOwner = other.activate();
        const foreign = other.token();
        expect(sameSourceEpoch(f.old, foreign)).toBe('different');
        expect(sameSourceEpoch(f.token(), foreign)).toBe('different');
        const admission = bindOrderedContext(
            f.context,
            reserveOrderedContext(f.context),
            foreign,
            true,
        );
        expect(admission.kind).toBe('failed');
        await settle();
        expect(pollOwnerStats(f.runtime)).toMatchObject({ active: false, ordering_gap: true });
        expect(activateOrderedPollOwner(f.runtime).status).toBe('degraded');
        expect(pollOwnerStats(other.runtime)).toMatchObject({
            active: true,
            cleanup_uncertain: false,
            ordering_gap: false,
        });
        otherOwner.invalidate();
        await settle();
    });

    it('fails closed even for an actually recorded old source once history overflows', async () => {
        const f = fixture();
        const old = f.token();

        for (let i = 0; i < 9; i++) {
            f.activate().invalidate();
            await settle();
            f.rotate();
        }

        const owner = f.activate();
        expect(pollOwnerStats(f.runtime)?.history_overflow).toBe(true);
        expect(installOrderedReady(f.context, f.runtime, owner)).not.toBeNull();
        const admission = bindOrderedContext(
            f.context,
            reserveOrderedContext(f.context),
            old,
            true,
        );
        expect(admission.kind).toBe('failed');
        await settle();
        expect(pollOwnerStats(f.runtime)).toMatchObject({
            active: false,
            ordering_gap: true,
            history_overflow: true,
        });
        expect(activateOrderedPollOwner(f.runtime).status).toBe('degraded');
    });
});
