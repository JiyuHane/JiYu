import { EventEmitter, getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventPollBuffer, type PollOptions } from '../../src/v12-runtime/event-poll-buffer';
import {
    PollCoordinator,
    PollTransaction,
    type PollQueue,
    type PollRequest,
    type PollSink,
} from '../../src/v12-runtime/poll-transaction';

const config = {
    capacity: 8,
    maxQueueBytes: 4096,
    maxEventBytes: 2048,
    maxWaiters: 4,
    maxTimeoutMs: 1000,
};
const event = (id: number) => ({ type: 'message', id });

class FakeSink extends EventEmitter implements PollSink {
    open = true;
    body: string | undefined;
    headCalls = 0;
    endCalls = 0;
    headAction?: () => void;
    endAction?: () => void;
    autoFinish = true;

    isOpen(): boolean {
        return this.open;
    }

    writeHead(): void {
        this.headCalls++;
        this.headAction?.();
    }

    end(body: string): void {
        this.endCalls++;
        this.body = body;
        this.endAction?.();

        if (this.autoFinish) {
            this.emit('finish');
        }
    }

    shutdown(): void {
        this.open = false;
        this.emit('close');
    }
}

function setup(options: { queue?: PollQueue; valid?: () => boolean; now?: () => number } = {}) {
    const q = new EventPollBuffer(config);
    const sink = new FakeSink();
    const coordinator = new PollCoordinator(
        options.queue ?? q,
        config.maxQueueBytes,
        options.now ?? (() => performance.now()),
        options.valid ?? (() => true),
    );
    const request: PollRequest = {
        limit: 0,
        timeoutMs: 0,
        maxOutputBytes: 4096,
        responseDeadline: performance.now() + 500,
    };
    return { q, sink, coordinator, request };
}

function queueWrapper(q: EventPollBuffer, changes: Partial<PollQueue>): PollQueue {
    return {
        reserve: changes.reserve ?? ((options) => q.reserve(options)),
        commit: changes.commit ?? ((token) => q.commit(token)),
        release: changes.release ?? ((token) => q.release(token)),
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('offline poll transaction', () => {
    it('commits FIFO with an embedded array and retains account isolation', async () => {
        const a = setup();
        const b = setup();
        a.q.enqueue(event(1));
        a.q.enqueue(event(2));
        b.q.enqueue(event(3));
        const result = await a.coordinator.create({ ...a.request, limit: 1 }, a.sink).run();
        expect(result).toEqual({ kind: 'local_finish', response: 'events' });
        expect(JSON.parse(a.sink.body!)).toEqual({
            status: 'ok',
            retcode: 0,
            data: [event(1)],
            message: '',
        });
        expect(a.q.stats()).toMatchObject({ count: 1, reserved: 0 });
        expect(b.q.stats()).toMatchObject({ count: 1, reserved: 0 });
        const next = new FakeSink();
        await a.coordinator.create(a.request, next).run();
        expect(JSON.parse(next.body!).data).toEqual([event(2)]);
        expect(b.q.stats().count).toBe(1);
    });

    it.each([undefined, '', 'é😀\n"\\', '\ud800', '大'.repeat(300)])(
        'preserves echo %s and enforces exact UTF-8 envelope size',
        async (echo) => {
            const full = JSON.stringify({
                status: 'ok',
                retcode: 0,
                data: [event(1)],
                message: '',
                ...(echo === undefined ? {} : { echo }),
            });
            const bytes = Buffer.byteLength(full);
            const a = setup();
            a.q.enqueue(event(1));
            expect(
                await a.coordinator
                    .create({ ...a.request, echo, maxOutputBytes: bytes }, a.sink)
                    .run(),
            ).toEqual({ kind: 'local_finish', response: 'events' });
            expect(a.sink.body).toBe(full);
            const b = setup();
            b.q.enqueue(event(1));
            const short = await b.coordinator
                .create({ ...b.request, echo, maxOutputBytes: bytes - 1 }, b.sink)
                .run();
            expect(['blocked', 'fatal_budget']).toContain(short.kind);
            expect(b.q.stats().count).toBe(1);
            expect(b.sink.headCalls).toBe(0);
        },
    );

    it('returns fatal budget without reserving when the empty array does not fit', async () => {
        const q = new EventPollBuffer(config);
        q.enqueue(event(1));
        const reserve = vi.fn((options: PollOptions) => q.reserve(options));
        const t = setup({ queue: queueWrapper(q, { reserve }) });
        expect(
            await t.coordinator.create({ ...t.request, maxOutputBytes: 0 }, t.sink).run(),
        ).toEqual({ kind: 'fatal_budget' });
        expect(reserve).not.toHaveBeenCalled();
        expect(q.stats()).toMatchObject({ count: 1, reserved: 0 });
        expect(t.sink.headCalls).toBe(0);
    });

    it.each(['json', 'count', 'bytes'] as const)(
        'releases malformed %s reservation before fixed sanitized fallback',
        async (mode) => {
            const q = new EventPollBuffer(config);
            q.enqueue(event(1));
            const release = vi.fn((token: object) => q.release(token));

            const reserve: PollQueue['reserve'] = async (options) => {
                const r = await q.reserve(options);

                if (r.status !== 'reserved') {
                    return r;
                }

                return mode === 'json'
                    ? { ...r, eventsJson: '{"private":"bad"}' }
                    : mode === 'count'
                      ? { ...r, count: r.count + 1 }
                      : { ...r, bytes: r.bytes + 1 };
            };

            const t = setup({ queue: queueWrapper(q, { reserve, release }) });
            expect(await t.coordinator.create({ ...t.request, echo: '' }, t.sink).run()).toEqual({
                kind: 'local_finish',
                response: 'fallback',
            });
            expect(release).toHaveBeenCalledTimes(1);
            expect(q.stats()).toMatchObject({ count: 1, reserved: 0 });
            const response = JSON.parse(t.sink.body!);
            expect(response).toMatchObject({
                status: 'failed',
                retcode: 20001,
                data: null,
                echo: '',
            });
            expect(t.sink.body).not.toContain('private');
        },
    );

    it('keeps queue status distinct and does not write an empty response', async () => {
        vi.useFakeTimers();
        const t = setup();
        expect(await t.coordinator.create(t.request, t.sink).run()).toEqual({ kind: 'empty' });
        const pending = t.q.reserve({ timeoutMs: 50 });
        const short = new FakeSink();
        expect(await t.coordinator.create(t.request, short).run()).toEqual({ kind: 'contended' });
        await vi.advanceTimersByTimeAsync(50);
        expect((await pending).status).toBe('timeout');
        const long = new FakeSink();
        const p = t.coordinator.create({ ...t.request, timeoutMs: 20 }, long).run();
        await vi.advanceTimersByTimeAsync(20);
        expect(await p).toEqual({ kind: 'timeout' });
        expect(long.headCalls).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('preserves blocked head and reports busy without confusing either for empty', async () => {
        vi.useFakeTimers();
        const q = new EventPollBuffer({ ...config, maxWaiters: 1 });
        q.enqueue(event(1));
        const held = await q.reserve();

        if (held.status !== 'reserved') {
            throw new Error('expected reserved');
        }

        const waiter = q.reserve({ timeoutMs: 40 });
        const t = setup({ queue: q });
        expect(await t.coordinator.create({ ...t.request, timeoutMs: 20 }, t.sink).run()).toEqual({
            kind: 'busy',
        });
        q.release(held.token);
        const selected = await waiter;

        if (selected.status !== 'reserved') {
            throw new Error('expected reserved');
        }

        q.release(selected.token);
        const tooSmall = JSON.stringify({ status: 'ok', retcode: 0, data: [], message: '' });
        const sink = new FakeSink();
        expect(
            await t.coordinator
                .create({ ...t.request, maxOutputBytes: Buffer.byteLength(tooSmall) }, sink)
                .run(),
        ).toEqual({ kind: 'blocked' });
        expect(q.stats()).toMatchObject({ count: 1, reserved: 0 });
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['abort', 'close', 'deadline'] as const)(
        'cancels an active wait on %s and cleans timers/listeners',
        async (reason) => {
            vi.useFakeTimers();
            const t = setup();
            const external = new AbortController();
            const before = getEventListeners(external.signal, 'abort').length;
            const tx = t.coordinator.create(
                {
                    ...t.request,
                    timeoutMs: 200,
                    responseDeadline:
                        reason === 'deadline'
                            ? performance.now() + 100
                            : t.request.responseDeadline,
                    externalAbortSignal: external.signal,
                },
                t.sink,
            );
            const p = tx.run();
            await Promise.resolve();
            expect(t.q.stats().waiters).toBe(1);

            if (reason === 'abort') {
                external.abort();
            }

            if (reason === 'close') {
                t.coordinator.close();
            }

            if (reason === 'deadline') {
                await vi.advanceTimersByTimeAsync(100);
            }

            expect(await p).toEqual({
                kind: reason === 'abort' ? 'aborted' : reason === 'close' ? 'closed' : 'deadline',
            });
            expect(t.q.stats().waiters).toBe(0);
            expect(getEventListeners(external.signal, 'abort')).toHaveLength(before);
            expect(t.sink.listenerCount('error')).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it.each(['abort', 'close', 'deadline', 'epoch'] as const)(
        'takes and releases a late reservation after %s',
        async (reason) => {
            vi.useFakeTimers();
            let valid = true;
            let clock = 0;
            const q = new EventPollBuffer(config);
            const t = setup({ queue: q, valid: () => valid, now: () => clock });
            const external = new AbortController();
            const tx = t.coordinator.create(
                {
                    ...t.request,
                    responseDeadline: 100,
                    timeoutMs: 80,
                    externalAbortSignal: external.signal,
                },
                t.sink,
            );
            const p = tx.run();
            await Promise.resolve();
            expect(q.stats().waiters).toBe(1);
            q.enqueue(event(1));
            expect(q.stats().reserved).toBe(1);

            if (reason === 'abort') {
                external.abort();
            }

            if (reason === 'close') {
                tx.close();
            }

            if (reason === 'deadline') {
                clock = 100;
            }

            if (reason === 'epoch') {
                valid = false;
            }

            expect(await p).toEqual({
                kind:
                    reason === 'abort'
                        ? 'aborted'
                        : reason === 'close'
                          ? 'closed'
                          : reason === 'deadline'
                            ? 'deadline'
                            : 'epoch_invalid',
            });
            expect(q.stats()).toMatchObject({ count: 1, reserved: 0, waiters: 0 });
            expect(t.sink.headCalls).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it.each(['deadline', 'revoke', 'abort', 'close'] as const)(
        'suppresses first write when commit reenters %s',
        async (mode) => {
            vi.useFakeTimers();
            let clock = 0;
            let valid = true;
            const q = new EventPollBuffer(config);
            q.enqueue(event(1));
            const external = new AbortController();
            const sink = new FakeSink();
            let coordinator: PollCoordinator;
            const commit = vi.fn((token: object) => {
                const result = q.commit(token);

                if (mode === 'deadline') {
                    clock = 100;
                }

                if (mode === 'revoke') {
                    valid = false;
                }

                if (mode === 'abort') {
                    external.abort();
                }

                if (mode === 'close') {
                    coordinator.close();
                }

                return result;
            });
            const release = vi.fn((token: object) => q.release(token));
            coordinator = new PollCoordinator(
                queueWrapper(q, { commit, release }),
                config.maxQueueBytes,
                () => clock,
                () => valid,
            );
            const outcome = await coordinator
                .create(
                    {
                        limit: 0,
                        timeoutMs: 0,
                        maxOutputBytes: 4096,
                        responseDeadline: 100,
                        externalAbortSignal: external.signal,
                    },
                    sink,
                )
                .run();
            expect(outcome).toEqual({ kind: 'committed_unsent' });
            expect(commit).toHaveBeenCalledTimes(1);
            expect(release).not.toHaveBeenCalled();
            expect(q.stats()).toMatchObject({ count: 0, reserved: 0 });
            expect(sink.headCalls).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it.each(['head-throw', 'head-close', 'end-throw', 'end-close', 'finish-then-throw'] as const)(
        'reports unknown without rollback on fake writer %s',
        async (mode) => {
            const t = setup();
            t.q.enqueue(event(1));

            if (mode === 'head-throw') {
                t.sink.headAction = () => {
                    throw new Error('private');
                };
            }

            if (mode === 'head-close') {
                t.sink.headAction = () => t.sink.shutdown();
            }

            if (mode === 'end-throw') {
                t.sink.endAction = () => {
                    throw new Error('private');
                };
            }

            if (mode === 'end-close') {
                t.sink.endAction = () => t.sink.shutdown();
            }

            if (mode === 'finish-then-throw') {
                t.sink.endAction = () => {
                    t.sink.emit('finish');
                    throw new Error('private');
                };
            }

            expect(await t.coordinator.create(t.request, t.sink).run()).toEqual({
                kind: 'unknown',
                committed: true,
            });
            expect(t.q.stats()).toMatchObject({ count: 0, reserved: 0 });

            if (mode.startsWith('head-')) {
                expect(t.sink.endCalls).toBe(0);
            }
        },
    );

    it('bounds a sink with no finish and makes a repeated run an error', async () => {
        vi.useFakeTimers();
        const t = setup();
        t.q.enqueue(event(1));
        t.sink.autoFinish = false;
        const tx = t.coordinator.create(t.request, t.sink);
        const p = tx.run();
        expect(await tx.run()).toEqual({ kind: 'already_started' });
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(500);
        expect(await p).toEqual({ kind: 'unknown', committed: true });
        tx.cancel();
        tx.close();
        expect(await tx.run()).toEqual({ kind: 'already_started' });
        expect(t.q.stats().count).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('releases a malformed reservation when fallback exceeds the response cap', async () => {
        const q = new EventPollBuffer(config);
        q.enqueue(event(1));

        const reserve: PollQueue['reserve'] = async (options) => {
            const result = await q.reserve(options);
            return result.status === 'reserved' ? { ...result, count: 999 } : result;
        };

        const t = setup({ queue: queueWrapper(q, { reserve }) });
        const cap = Buffer.byteLength(
            JSON.stringify({ status: 'ok', retcode: 0, data: [event(1)], message: '' }),
        );
        expect(
            await t.coordinator.create({ ...t.request, maxOutputBytes: cap }, t.sink).run(),
        ).toEqual({ kind: 'fatal_budget' });
        expect(q.stats()).toMatchObject({ count: 1, reserved: 0 });
        expect(t.sink.headCalls).toBe(0);
    });

    it.each(['throw', 'reject'] as const)('cleans up after reserve %s', async (mode) => {
        vi.useFakeTimers();
        const q = new EventPollBuffer(config);
        const external = new AbortController();

        const reserve: PollQueue['reserve'] = () => {
            if (mode === 'throw') {
                throw new Error('private');
            }

            return Promise.reject(new Error('private'));
        };

        const t = setup({ queue: queueWrapper(q, { reserve }) });
        expect(
            await t.coordinator
                .create({ ...t.request, externalAbortSignal: external.signal }, t.sink)
                .run(),
        ).toEqual({ kind: 'queue_error' });
        expect(getEventListeners(external.signal, 'abort')).toHaveLength(0);
        expect(t.sink.listenerCount('error')).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('observes a controlled fake late result after abort and releases exactly once', async () => {
        vi.useFakeTimers();
        const q = new EventPollBuffer(config);
        q.enqueue(event(1));
        let deliver: (() => void) | undefined;

        const reserve: PollQueue['reserve'] = async (options) => {
            const result = await q.reserve(options);
            await new Promise<void>((resolve) => {
                deliver = resolve;
            });
            return result;
        };

        const release = vi.fn((token: object) => q.release(token));
        const t = setup({ queue: queueWrapper(q, { reserve, release }) });
        const tx = t.coordinator.create(t.request, t.sink);
        const p = tx.run();
        await Promise.resolve();
        await Promise.resolve();
        expect(q.stats().reserved).toBe(1);
        tx.cancel();
        tx.close();
        expect(vi.getTimerCount()).toBe(0);
        deliver!();
        expect(await p).toEqual({ kind: 'cancelled' });
        expect(release).toHaveBeenCalledTimes(1);
        expect(q.stats()).toMatchObject({ count: 1, reserved: 0 });
        expect(t.sink.headCalls).toBe(0);
    });

    it('does not repeat release when it throws after synchronous reentry', async () => {
        const q = new EventPollBuffer(config);
        q.enqueue(event(1));
        let close: () => void = () => undefined;

        const reserve: PollQueue['reserve'] = async (options) => {
            const r = await q.reserve(options);
            return r.status === 'reserved' ? { ...r, count: r.count + 1 } : r;
        };

        const release = vi.fn((token: object) => {
            q.release(token);
            close();
            throw new Error('private');
        });
        const t = setup({ queue: queueWrapper(q, { reserve, release }) });
        const tx = t.coordinator.create(t.request, t.sink);
        close = () => tx.close();
        expect(await tx.run()).toEqual({ kind: 'release_unknown' });
        expect(release).toHaveBeenCalledTimes(1);
        expect(q.stats()).toMatchObject({ count: 1, reserved: 0 });
        expect(t.sink.headCalls).toBe(0);
    });

    it('records unknown and skips body if header emission invalidates the epoch', async () => {
        let valid = true;
        const t = setup({ valid: () => valid });
        t.q.enqueue(event(1));

        t.sink.headAction = () => {
            valid = false;
        };

        expect(await t.coordinator.create(t.request, t.sink).run()).toEqual({
            kind: 'unknown',
            committed: true,
        });
        expect(t.sink.endCalls).toBe(0);
        expect(t.q.stats().count).toBe(0);
    });

    it('keeps the first stop when an aborted controlled reserve rejects', async () => {
        vi.useFakeTimers();
        const q = new EventPollBuffer(config);
        const reserve: PollQueue['reserve'] = (options) =>
            new Promise((_, reject) => {
                options.signal!.addEventListener('abort', () => reject(new Error('private')), {
                    once: true,
                });
            });
        const t = setup({ queue: queueWrapper(q, { reserve }) });
        const tx = t.coordinator.create(t.request, t.sink);
        const pending = tx.run();
        await Promise.resolve();
        tx.cancel();
        expect(await pending).toEqual({ kind: 'cancelled' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('closes waiting polls when the fake sink closes and honors first stop', async () => {
        vi.useFakeTimers();
        const t = setup();
        const tx = t.coordinator.create({ ...t.request, timeoutMs: 100 }, t.sink);
        const p = tx.run();
        await Promise.resolve();
        t.sink.shutdown();
        tx.cancel();
        expect(await p).toEqual({ kind: 'closed' });
        expect(t.q.stats()).toMatchObject({ waiters: 0, reserved: 0 });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('marks rejection of a revoked commit separately without writing', async () => {
        const q = new EventPollBuffer(config);
        q.enqueue(event(1));
        const t = setup({
            queue: queueWrapper(q, {
                commit: (token) => {
                    q.release(token);
                    return false;
                },
            }),
        });
        expect(await t.coordinator.create(t.request, t.sink).run()).toEqual({
            kind: 'commit_rejected',
        });
        expect(q.stats()).toMatchObject({ count: 1, reserved: 0 });
        expect(t.sink.headCalls).toBe(0);
    });

    it('aborts immediately if the injected clock reenters cancellation during timer setup', async () => {
        vi.useFakeTimers();
        const q = new EventPollBuffer(config);
        let cancel: () => void = () => undefined;
        const t = setup({
            queue: q,
            now: () => {
                cancel();
                return 0;
            },
        });
        const tx = t.coordinator.create(
            { ...t.request, responseDeadline: 100, timeoutMs: 50 },
            t.sink,
        );
        cancel = () => tx.cancel();
        expect(await tx.run()).toEqual({ kind: 'cancelled' });
        expect(q.stats().waiters).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reports asynchronous fake writer error as unknown without retry', async () => {
        vi.useFakeTimers();
        const t = setup();
        t.q.enqueue(event(1));
        t.sink.autoFinish = false;
        const pending = t.coordinator.create(t.request, t.sink).run();
        await Promise.resolve();
        await Promise.resolve();
        t.sink.emit('error', new Error('private'));
        expect(await pending).toEqual({ kind: 'unknown', committed: true });
        expect(t.q.stats().count).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['cancel', 'close', 'deadline'] as const)(
        'retains %s over an oversize fallback after release reentry',
        async (reason) => {
            vi.useFakeTimers();
            let clock = 0;
            const q = new EventPollBuffer(config);
            q.enqueue(event(1));
            let stop: () => void = () => undefined;

            const reserve: PollQueue['reserve'] = async (options) => {
                const r = await q.reserve(options);
                return r.status === 'reserved' ? { ...r, count: r.count + 1 } : r;
            };

            const release: PollQueue['release'] = (token) => {
                const result = q.release(token);
                stop();
                return result;
            };

            const t = setup({ queue: queueWrapper(q, { reserve, release }), now: () => clock });
            const cap = Buffer.byteLength(
                JSON.stringify({ status: 'ok', retcode: 0, data: [event(1)], message: '' }),
            );
            const tx = t.coordinator.create(
                { ...t.request, responseDeadline: 100, maxOutputBytes: cap },
                t.sink,
            );

            stop = () => {
                if (reason === 'cancel') {
                    tx.cancel();
                }

                if (reason === 'close') {
                    tx.close();
                }

                if (reason === 'deadline') {
                    clock = 100;
                }
            };

            expect(await tx.run()).toEqual({
                kind:
                    reason === 'cancel' ? 'cancelled' : reason === 'close' ? 'closed' : 'deadline',
            });
            expect(q.stats()).toMatchObject({ count: 1, reserved: 0 });
            expect(t.sink.headCalls).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it('prioritizes release uncertainty over reentrant cancellation', async () => {
        const q = new EventPollBuffer(config);
        q.enqueue(event(1));
        let stop: () => void = () => undefined;

        const reserve: PollQueue['reserve'] = async (options) => {
            const r = await q.reserve(options);
            return r.status === 'reserved' ? { ...r, count: r.count + 1 } : r;
        };

        const t = setup({
            queue: queueWrapper(q, {
                reserve,
                release: () => {
                    stop();
                    return false;
                },
            }),
        });
        const tx = t.coordinator.create(t.request, t.sink);
        stop = () => tx.cancel();
        expect(await tx.run()).toEqual({ kind: 'release_unknown' });
        q.close();
    });

    it('captures request primitives at creation before run', async () => {
        const t = setup();
        t.q.enqueue(event(1));
        t.q.enqueue(event(2));
        const request = { ...t.request, limit: 1, echo: 'first' };
        const tx = t.coordinator.create(request, t.sink);
        request.limit = 2;
        request.echo = 'changed';
        request.maxOutputBytes = 0;
        request.responseDeadline = -1;
        expect(await tx.run()).toEqual({ kind: 'local_finish', response: 'events' });
        expect(JSON.parse(t.sink.body!)).toMatchObject({ data: [event(1)], echo: 'first' });
        expect(t.q.stats().count).toBe(1);
    });

    it('captures request primitives when directly constructing a transaction', async () => {
        const t = setup();
        t.q.enqueue(event(1));
        const request = { ...t.request, echo: 'initial' };
        const tx = new PollTransaction(
            t.q,
            config.maxQueueBytes,
            () => performance.now(),
            () => true,
            request,
            t.sink,
            () => true,
            () => undefined,
        );
        request.echo = 'changed';
        request.maxOutputBytes = 0;
        expect(await tx.run()).toEqual({ kind: 'local_finish', response: 'events' });
        expect(JSON.parse(t.sink.body!)).toMatchObject({ echo: 'initial', data: [event(1)] });
    });

    it('keeps the original deadline while the owner changes its request during await', async () => {
        vi.useFakeTimers();
        const t = setup();
        const request = { ...t.request, timeoutMs: 300, responseDeadline: performance.now() + 100 };
        const tx = t.coordinator.create(request, t.sink);
        const pending = tx.run();
        await Promise.resolve();
        request.responseDeadline += 10000;
        request.maxOutputBytes = 100000;
        await vi.advanceTimersByTimeAsync(100);
        expect(await pending).toEqual({ kind: 'deadline' });
        expect(t.q.stats().waiters).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('converts a timer clock throw to clock_error and cancels a waiting reserve', async () => {
        vi.useFakeTimers();
        let fail = false;
        const t = setup({
            now: () => {
                if (fail) {
                    throw new Error('private-clock');
                }

                return 0;
            },
        });
        const tx = t.coordinator.create(
            { ...t.request, responseDeadline: 50, timeoutMs: 200 },
            t.sink,
        );
        const pending = tx.run();
        await Promise.resolve();
        expect(t.q.stats().waiters).toBe(1);
        fail = true;
        await vi.advanceTimersByTimeAsync(50);
        expect(await pending).toEqual({ kind: 'clock_error' });
        expect(t.q.stats().waiters).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('releases a late selected token after timer clock failure', async () => {
        vi.useFakeTimers();
        let fail = false;
        const q = new EventPollBuffer(config);
        q.enqueue(event(1));
        let deliver: (() => void) | undefined;

        const reserve: PollQueue['reserve'] = async (options) => {
            const selected = await q.reserve(options);
            await new Promise<void>((resolve) => {
                deliver = resolve;
            });
            return selected;
        };

        const release = vi.fn((token: object) => q.release(token));
        const t = setup({
            queue: queueWrapper(q, { reserve, release }),
            now: () => {
                if (fail) {
                    throw new Error('private-clock');
                }

                return 0;
            },
        });
        const pending = t.coordinator.create({ ...t.request, responseDeadline: 50 }, t.sink).run();
        await Promise.resolve();
        await Promise.resolve();
        expect(q.stats().reserved).toBe(1);
        fail = true;
        await vi.advanceTimersByTimeAsync(50);
        deliver!();
        expect(await pending).toEqual({ kind: 'clock_error' });
        expect(release).toHaveBeenCalledTimes(1);
        expect(q.stats()).toMatchObject({ count: 1, reserved: 0 });
        expect(t.sink.headCalls).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('reports unknown if clock throws on the write-period timer after commit', async () => {
        vi.useFakeTimers();
        let fail = false;
        const t = setup({
            now: () => {
                if (fail) {
                    throw new Error('private-clock');
                }

                return 0;
            },
        });
        t.q.enqueue(event(1));
        t.sink.autoFinish = false;
        const pending = t.coordinator.create({ ...t.request, responseDeadline: 50 }, t.sink).run();
        await Promise.resolve();
        await Promise.resolve();
        expect(t.sink.endCalls).toBe(1);
        fail = true;
        await vi.advanceTimersByTimeAsync(50);
        expect(await pending).toEqual({ kind: 'unknown', committed: true });
        expect(t.q.stats().count).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['epoch', 'deadline', 'normal-finished'] as const)(
        'rechecks %s after end without mistaking normal finish for close',
        async (mode) => {
            let valid = true;
            let clock = 0;
            const q = new EventPollBuffer(config);
            q.enqueue(event(1));
            const t = setup({ queue: q, valid: () => valid, now: () => clock });
            t.sink.autoFinish = false;

            t.sink.endAction = () => {
                if (mode === 'epoch') {
                    valid = false;
                }

                if (mode === 'deadline') {
                    clock = 100;
                }

                t.sink.open = false;
                t.sink.emit('finish');
            };

            expect(
                await t.coordinator.create({ ...t.request, responseDeadline: 100 }, t.sink).run(),
            ).toEqual(
                mode === 'normal-finished'
                    ? { kind: 'local_finish', response: 'events' }
                    : { kind: 'unknown', committed: true },
            );
            expect(q.stats()).toMatchObject({ count: 0, reserved: 0 });
        },
    );

    it('rechecks epoch before an asynchronous finish without sink-open confusion', async () => {
        let valid = true;
        const t = setup({ valid: () => valid });
        t.q.enqueue(event(1));
        t.sink.autoFinish = false;
        const pending = t.coordinator.create(t.request, t.sink).run();
        await Promise.resolve();
        await Promise.resolve();
        valid = false;
        t.sink.open = false;
        t.sink.emit('finish');
        expect(await pending).toEqual({ kind: 'unknown', committed: true });
        expect(t.q.stats().count).toBe(0);
    });

    it('keeps unknown commit state if cleanup also fails', async () => {
        const q = new EventPollBuffer(config);
        q.enqueue(event(1));
        const t = setup({
            queue: queueWrapper(q, {
                commit: (token) => {
                    q.commit(token);
                    throw new Error('private-commit');
                },
            }),
        });
        const realOff = t.sink.off.bind(t.sink);
        vi.spyOn(t.sink, 'off').mockImplementation((name, listener) => {
            if (name === 'close') {
                throw new Error('private-cleanup');
            }

            return realOff(name, listener);
        });
        expect(await t.coordinator.create(t.request, t.sink).run()).toEqual({
            kind: 'cleanup_uncertain',
            outcome: { kind: 'commit_unknown' },
            committed: 'unknown',
        });
        expect(t.q.stats().count).toBe(0);
    });

    it('keeps the outcome and tries all cleanup when a sink off throws', async () => {
        const t = setup();
        t.q.enqueue(event(1));
        const realOff = t.sink.off.bind(t.sink);
        const off = vi.spyOn(t.sink, 'off').mockImplementation((name, listener) => {
            if (name === 'close') {
                throw new Error('private-cleanup');
            }

            return realOff(name, listener);
        });
        expect(await t.coordinator.create(t.request, t.sink).run()).toEqual({
            kind: 'cleanup_uncertain',
            outcome: { kind: 'local_finish', response: 'events' },
            committed: true,
        });
        expect(off.mock.calls.map(([name]) => name)).toEqual(['close', 'error', 'finish']);
        expect(t.sink.listenerCount('error')).toBe(0);
        expect(t.sink.listenerCount('finish')).toBe(0);
        expect(t.q.stats()).toMatchObject({ count: 0, reserved: 0 });
    });

    it.each([
        ['error', 'before'],
        ['error', 'after'],
        ['finish', 'before'],
        ['finish', 'after'],
    ] as const)(
        'cleans a partial on(%s) registration throwing %s registration',
        async (target, when) => {
            vi.useFakeTimers();
            const t = setup();
            t.q.enqueue(event(1));
            const done = vi.fn();
            const on = t.sink.on.bind(t.sink);
            vi.spyOn(t.sink, 'on').mockImplementation((name, listener) => {
                if (name === target && when === 'before') {
                    throw new Error('private-registration');
                }

                const result = on(name, listener);

                if (name === target && when === 'after') {
                    throw new Error('private-registration');
                }

                return result;
            });
            const off = vi.spyOn(t.sink, 'off');
            const tx = new PollTransaction(
                t.q,
                config.maxQueueBytes,
                () => performance.now(),
                () => true,
                t.request,
                t.sink,
                () => true,
                done,
            );
            const result = await tx.run();
            expect(result).toEqual({ kind: 'queue_error' });
            expect(JSON.stringify(result)).not.toContain('private-registration');
            expect(off.mock.calls.map(([name]) => name)).toEqual(['close', 'error', 'finish']);
            expect(done).toHaveBeenCalledTimes(1);

            for (const name of ['close', 'error', 'finish']) {
                expect(t.sink.listenerCount(name)).toBe(0);
            }

            expect(t.q.stats()).toMatchObject({ count: 1, waiters: 0, reserved: 0 });
            expect(t.sink.headCalls).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it.each(['error', 'finish'] as const)(
        'continues cleanup and owner finalization when off(%s) throws',
        async (target) => {
            vi.useFakeTimers();
            const t = setup();
            t.q.enqueue(event(1));
            const done = vi.fn();
            const realOff = t.sink.off.bind(t.sink);
            const off = vi.spyOn(t.sink, 'off').mockImplementation((name, listener) => {
                if (name === target) {
                    throw new Error('private-cleanup');
                }

                return realOff(name, listener);
            });
            const tx = new PollTransaction(
                t.q,
                config.maxQueueBytes,
                () => performance.now(),
                () => true,
                t.request,
                t.sink,
                () => true,
                done,
            );
            const result = await tx.run();
            expect(result).toEqual({
                kind: 'cleanup_uncertain',
                outcome: { kind: 'local_finish', response: 'events' },
                committed: true,
            });
            expect(JSON.stringify(result)).not.toContain('private-cleanup');
            expect(off.mock.calls.map(([name]) => name)).toEqual(['close', 'error', 'finish']);
            expect(done).toHaveBeenCalledTimes(1);

            for (const name of ['close', 'error', 'finish']) {
                expect(t.sink.listenerCount(name)).toBe(name === target ? 1 : 0);
            }

            expect(t.q.stats()).toMatchObject({ count: 0, waiters: 0, reserved: 0 });
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it('does not retry or release after a commit throws following consumption', async () => {
        const q = new EventPollBuffer(config);
        q.enqueue(event(1));
        const release = vi.fn((token: object) => q.release(token));
        const t = setup({
            queue: queueWrapper(q, {
                release,
                commit: (token) => {
                    q.commit(token);
                    throw new Error('private');
                },
            }),
        });
        expect(await t.coordinator.create(t.request, t.sink).run()).toEqual({
            kind: 'commit_unknown',
        });
        expect(release).not.toHaveBeenCalled();
        expect(q.stats().count).toBe(0);
        expect(t.sink.headCalls).toBe(0);
    });
});
