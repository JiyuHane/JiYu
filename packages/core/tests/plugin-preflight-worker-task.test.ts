import { createHash } from 'node:crypto';
import { EventEmitter, getEventListeners } from 'node:events';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import {
    PreflightWorkerTask,
    type PreflightWorker,
} from '../src/webui/plugin-install/preflight-worker-task';
import { preflightZip } from '../src/webui/plugin-install/zip-preflight';

class FakeWorker extends EventEmitter implements PreflightWorker {
    terminate = vi.fn<() => Promise<unknown>>(() => new Promise(() => {}));
}
const failure = (code: string) => ({ kind: 'failure', code });
const input = Buffer.from([1, 2, 3]);
const message = (bytes = input) => ({
    kind: 'result',
    result: {
        ok: true,
        entries: [{ path: 'x', kind: 'file', compressedSize: 3, actualSize: 3, crc32: 0 }],
        totalSize: 3,
        sha256: createHash('sha256').update(bytes).digest('hex'),
    },
});

const start = (worker: FakeWorker, timeoutMs = 1000, cleanupMs = 30) => {
    const controller = new PreflightWorkerTask(() => worker, cleanupMs);
    return { controller, task: controller.start(input, { timeoutMs }) };
};

describe('injected worker task', () => {
    it('holds a candidate until natural exit zero, deep-copying and freezing it', async () => {
        const worker = new FakeWorker();
        const { task } = start(worker);
        const value = message();
        worker.emit('message', value);
        value.result.entries[0].path = 'changed';
        expect(worker.terminate).not.toHaveBeenCalled();
        worker.emit('exit', 0);
        const result = await task.outcome;
        expect(result).toMatchObject({ kind: 'result', result: { entries: [{ path: 'x' }] } });

        if (result.kind === 'result' && result.result.ok) {
            expect(Object.isFrozen(result.result.entries[0])).toBe(true);
            expect(Object.isFrozen(result.result.entries)).toBe(true);
        }

        expect(await task.cleanup).toBe('released');
        expect(worker.eventNames()).toEqual([]);
    });

    it('candidate then exit one fails, and exit zero without a candidate fails', async () => {
        for (const hasMessage of [true, false]) {
            const worker = new FakeWorker();
            const { task } = start(worker);

            if (hasMessage) {
                worker.emit('message', message());
            }

            worker.emit('exit', hasMessage ? 1 : 0);
            expect(await task.outcome).toEqual(failure('exit'));
            expect(await task.cleanup).toBe('released');
        }
    });

    it('timeout beats late result and exit, then releases only on exit', async () => {
        const worker = new FakeWorker();
        const { task } = start(worker, 10, 100);
        expect(await task.outcome).toEqual(failure('timeout'));
        worker.emit('message', message());
        worker.emit('exit', 0);
        expect(await task.outcome).toEqual(failure('timeout'));
        expect(await task.cleanup).toBe('released');
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        expect(worker.eventNames()).toEqual([]);
    });

    it.each(['reject', 'hang', 'fulfilled'] as const)(
        'terminate %s keeps slot until exit',
        async (mode) => {
            const worker = new FakeWorker();

            if (mode === 'reject') {
                worker.terminate.mockRejectedValue(new Error('secret'));
            }

            if (mode === 'fulfilled') {
                worker.terminate.mockResolvedValue(0);
            }

            const { controller, task } = start(worker, 5);
            expect(await task.outcome).toEqual(failure('timeout'));
            expect(await task.cleanup).toBe('unknown');
            expect(await controller.start(input, { timeoutMs: 100 }).outcome).toEqual(
                failure('busy'),
            );
            worker.emit('error', new Error('late secret'));
            worker.emit('exit', 1);
            expect(worker.eventNames()).toEqual([]);
            const next = controller.start(input, { timeoutMs: 100 });
            worker.emit('exit', 0);
            expect(await next.cleanup).toBe('released');
        },
    );

    it('error and repeated or invalid messages preserve first failure and wait for exit', async () => {
        for (const mode of ['error', 'messageerror', 'double', 'bad'] as const) {
            const worker = new FakeWorker();
            const { task } = start(worker);

            if (mode === 'error') {
                worker.emit('error', new Error('private'));
            }

            if (mode === 'messageerror') {
                worker.emit('messageerror', new Error('private'));
            }

            if (mode === 'double') {
                worker.emit('message', message());
                worker.emit('message', message());
            }

            if (mode === 'bad') {
                worker.emit('message', { kind: 'result', result: { ok: false, code: 'password' } });
            }

            const expected =
                mode === 'error'
                    ? 'worker_error'
                    : mode === 'messageerror'
                      ? 'message_error'
                      : 'invalid_result';
            expect(await task.outcome).toEqual(failure(expected));
            worker.emit('exit', 0);
            expect(await task.cleanup).toBe('released');
        }
    });

    it('preserves error across reentrant native abort and exit without early release', async () => {
        const worker = new FakeWorker();
        const signal = new AbortController();
        let fire = false;
        let nested: ReturnType<PreflightWorkerTask['start']> | undefined;
        let errorListeners = 0;
        const controller = new PreflightWorkerTask(
            () => worker,
            30,
            () => {
                if (fire) {
                    fire = false;
                    signal.abort();
                    worker.emit('message', message());
                    worker.emit('exit', 0);
                    errorListeners = worker.listenerCount('error');
                    nested = controller.start(input, { timeoutMs: 100 });
                }

                return 0;
            },
        );
        const task = controller.start(input, { timeoutMs: 1000, signal: signal.signal });
        worker.emit('message', message());
        fire = true;
        worker.emit('error', Error('private'));
        expect(await nested!.outcome).toEqual(failure('busy'));
        expect(errorListeners).toBeGreaterThan(0);
        expect(await task.outcome).toEqual(failure('worker_error'));
        expect(await task.cleanup).toBe('released');
        expect(worker.terminate).not.toHaveBeenCalled();
        expect(worker.eventNames()).toEqual([]);
        expect(getEventListeners(signal.signal, 'abort')).toHaveLength(0);
    });

    it.each(['messageerror', 'abort'] as const)(
        'preserves first %s during reentrant error and exit',
        async (first) => {
            const worker = new FakeWorker();
            const signal = new AbortController();
            let fire = false;
            let nested: ReturnType<PreflightWorkerTask['start']> | undefined;
            const controller = new PreflightWorkerTask(
                () => worker,
                30,
                () => {
                    if (fire) {
                        fire = false;
                        worker.emit('error', Error('private'));
                        worker.emit('message', message());
                        worker.emit('exit', 0);
                        nested = controller.start(input, { timeoutMs: 100 });
                    }

                    return 0;
                },
            );
            const task = controller.start(input, { timeoutMs: 1000, signal: signal.signal });
            worker.emit('message', message());
            fire = true;

            if (first === 'abort') {
                signal.abort();
            } else {
                worker.emit('messageerror', Error('private'));
            }

            expect(await nested!.outcome).toEqual(failure('busy'));
            expect(await task.outcome).toEqual(
                failure(first === 'abort' ? 'abort' : 'message_error'),
            );
            expect(await task.cleanup).toBe('released');
            expect(worker.terminate).not.toHaveBeenCalled();
        },
    );

    it.each([true, false])(
        'keeps first exit against reentrant abort and error, candidate=%s',
        async (hasCandidate) => {
            const worker = new FakeWorker();
            const signal = new AbortController();
            let fire = false;
            let nested: ReturnType<PreflightWorkerTask['start']> | undefined;
            const controller = new PreflightWorkerTask(
                () => worker,
                30,
                () => {
                    if (fire) {
                        fire = false;
                        signal.abort();
                        worker.emit('error', Error('private'));
                        worker.emit('message', message());
                        nested = controller.start(input, { timeoutMs: 100 });
                    }

                    return 0;
                },
            );
            const task = controller.start(input, { timeoutMs: 1000, signal: signal.signal });

            if (hasCandidate) {
                worker.emit('message', message());
            }

            fire = true;
            worker.emit('exit', 0);
            expect(await nested!.outcome).toEqual(failure('busy'));
            const outcome = await task.outcome;

            if (hasCandidate) {
                expect(outcome.kind).toBe('result');
            } else {
                expect(outcome).toEqual(failure('exit'));
            }

            expect(await task.cleanup).toBe('released');
            expect(worker.terminate).not.toHaveBeenCalled();
            expect(getEventListeners(signal.signal, 'abort')).toHaveLength(0);
        },
    );

    it.each(['deadline', 'throw', 'nonfinite'] as const)(
        'keeps %s priority during failure and reentrant exit',
        async (mode) => {
            const worker = new FakeWorker();
            let fire = false;
            const controller = new PreflightWorkerTask(
                () => worker,
                30,
                () => {
                    if (fire) {
                        fire = false;
                        worker.emit('exit', 0);

                        if (mode === 'throw') {
                            throw Error('private');
                        }

                        return mode === 'deadline' ? 100 : NaN;
                    }

                    return 0;
                },
            );
            const task = controller.start(input, { timeoutMs: 10 });
            worker.emit('message', message());
            fire = true;
            worker.emit('error', Error('private'));
            expect(await task.outcome).toEqual(
                failure(mode === 'deadline' ? 'timeout' : 'internal'),
            );
            expect(await task.cleanup).toBe('released');
            expect(worker.terminate).not.toHaveBeenCalled();
        },
    );

    it('preserves timeout when its clock synchronously emits error and exit', async () => {
        vi.useFakeTimers();

        try {
            const worker = new FakeWorker();
            let fire = false;
            let nested: ReturnType<PreflightWorkerTask['start']> | undefined;
            const controller = new PreflightWorkerTask(
                () => worker,
                30,
                () => {
                    if (fire) {
                        fire = false;
                        worker.emit('error', Error('private'));
                        worker.emit('message', message());
                        worker.emit('exit', 0);
                        nested = controller.start(input, { timeoutMs: 100 });
                    }

                    return 0;
                },
            );
            const task = controller.start(input, { timeoutMs: 10 });
            worker.emit('message', message());
            fire = true;
            vi.advanceTimersByTime(10);
            expect(await nested!.outcome).toEqual(failure('busy'));
            expect(await task.outcome).toEqual(failure('timeout'));
            expect(await task.cleanup).toBe('released');
            expect(worker.terminate).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('preserves unknown cleanup after reentrant abort and permits release only after late exit', async () => {
        const worker = new FakeWorker();
        const signal = new AbortController();
        let fire = false;
        const controller = new PreflightWorkerTask(
            () => worker,
            10,
            () => {
                if (fire) {
                    fire = false;
                    signal.abort();
                }

                return 0;
            },
        );
        const task = controller.start(input, { timeoutMs: 1000, signal: signal.signal });
        worker.emit('message', message());
        fire = true;
        worker.emit('error', Error('private'));
        expect(await task.outcome).toEqual(failure('worker_error'));
        expect(await task.cleanup).toBe('unknown');
        expect(await controller.start(input, { timeoutMs: 100 }).outcome).toEqual(failure('busy'));
        worker.emit('error', Error('private'));
        worker.emit('exit', 1);
        expect(await task.cleanup).toBe('unknown');
        const next = controller.start(input, { timeoutMs: 100 });
        worker.emit('exit', 0);
        expect(await next.cleanup).toBe('released');
        expect(worker.terminate).toHaveBeenCalledOnce();
    });

    it('defers synchronous exit emitted by terminate until the first failure settles', async () => {
        const worker = new FakeWorker();
        let nested: ReturnType<PreflightWorkerTask['start']> | undefined;
        let errorsDuringTermination = 0;
        const controller = new PreflightWorkerTask(() => worker, 30);
        worker.terminate.mockImplementation(() => {
            worker.emit('exit', 1);
            errorsDuringTermination = worker.listenerCount('error');
            nested = controller.start(input, { timeoutMs: 100 });
            return Promise.reject(Error('private'));
        });
        const task = controller.start(input, { timeoutMs: 1000 });
        worker.emit('error', Error('private'));
        expect(await task.outcome).toEqual(failure('worker_error'));
        expect(await nested!.outcome).toEqual(failure('busy'));
        expect(errorsDuringTermination).toBeGreaterThan(0);
        expect(await task.cleanup).toBe('released');
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(worker.eventNames()).toEqual([]);
    });

    it('keeps cleanup unknown and slot occupied after reentrant exit if listener removal fails', async () => {
        const worker = new FakeWorker();
        worker.on('removeListener', (event) => {
            if (event === 'message') {
                throw Error('private');
            }
        });
        let fire = false;
        const controller = new PreflightWorkerTask(
            () => worker,
            30,
            () => {
                if (fire) {
                    fire = false;
                    worker.emit('exit', 0);
                }

                return 0;
            },
        );
        const task = controller.start(input, { timeoutMs: 1000 });
        worker.emit('message', message());
        fire = true;
        worker.emit('error', Error('private'));
        expect(await task.outcome).toEqual(failure('worker_error'));
        expect(await task.cleanup).toBe('unknown');
        expect(await controller.start(input, { timeoutMs: 100 }).outcome).toEqual(failure('busy'));
    });

    it('rejects proxies and accessors without invoking them, and enforces bounds/hash', async () => {
        let invoked = false;
        const getter = Object.defineProperty({}, 'ok', {
            get() {
                invoked = true;
                throw Error();
            },
            enumerable: true,
        });
        const values: unknown[] = [
            new Proxy(message(), {}),
            { kind: 'result', result: getter },
            { ...message(), extra: 'secret' },
            { kind: 'result', result: new Proxy({}, {}) },
            { kind: 'result', result: { ...message().result, sha256: '0'.repeat(64) } },
            { kind: 'result', result: { ...message().result, entries: Array(513).fill({}) } },
            {
                kind: 'result',
                result: {
                    ...message().result,
                    entries: [{ ...message().result.entries[0], path: '../x' }],
                },
            },
            { kind: 'result', result: { ...message().result, totalSize: Number.NaN } },
            {
                kind: 'result',
                result: {
                    ...message().result,
                    entries: [{ ...message().result.entries[0], compressedSize: 4 }],
                },
            },
        ];

        for (const value of values) {
            const worker = new FakeWorker();
            const { task } = start(worker);
            worker.emit('message', value);
            expect(await task.outcome).toEqual(failure('invalid_result'));
            worker.emit('exit', 1);
            expect(await task.cleanup).toBe('released');
        }

        expect(invoked).toBe(false);
    });

    it('accepts only bounded error enums with no extra properties', async () => {
        const worker = new FakeWorker();
        const { task } = start(worker);
        worker.emit('message', { kind: 'result', result: { ok: false, code: 'malformed' } });
        worker.emit('exit', 0);
        expect(await task.outcome).toEqual({
            kind: 'result',
            result: { ok: false, code: 'malformed' },
        });
    });

    it('handles aborted signal before spawning and during factory construction', async () => {
        const signal = new AbortController();
        signal.abort();
        const factory = vi.fn(() => new FakeWorker());
        const controller = new PreflightWorkerTask(factory, 30);
        const pre = controller.start(input, { timeoutMs: 100, signal: signal.signal });
        expect(await pre.outcome).toEqual(failure('abort'));
        expect(factory).not.toHaveBeenCalled();
        const runningSignal = new AbortController();
        const worker = new FakeWorker();
        const running = new PreflightWorkerTask(() => {
            runningSignal.abort();
            return worker;
        }, 30);
        const task = running.start(input, { timeoutMs: 100, signal: runningSignal.signal });
        expect(await task.outcome).toEqual(failure('abort'));
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        worker.emit('exit', 1);
        expect(await task.cleanup).toBe('released');
    });

    it('locks on factory throw or invalid handle and rejects reentrancy', async () => {
        for (const factory of [
            () => {
                throw Error('private');
            },
            () => ({}) as PreflightWorker,
        ]) {
            const controller = new PreflightWorkerTask(factory, 30);
            const task = controller.start(input, { timeoutMs: 100 });
            expect((await task.outcome).kind).toBe('failure');
            expect(await task.cleanup).toBe('unknown');
            expect(await controller.start(input, { timeoutMs: 100 }).outcome).toEqual(
                failure('busy'),
            );
        }

        const worker = new FakeWorker();
        let nested: ReturnType<PreflightWorkerTask['start']> | undefined;
        const controller = new PreflightWorkerTask(() => {
            nested = controller.start(input, { timeoutMs: 100 });
            return worker;
        }, 30);
        const task = controller.start(input, { timeoutMs: 100 });
        expect(await nested!.outcome).toEqual(failure('busy'));
        worker.emit('exit', 0);
        await task.cleanup;
    });

    it('reserves the slot before invoking the clock and never frees a later worker', async () => {
        const workers = [new FakeWorker(), new FakeWorker()];
        let created = 0;
        let nested: ReturnType<PreflightWorkerTask['start']> | undefined;
        let calls = 0;
        const controller = new PreflightWorkerTask(
            () => workers[created++],
            30,
            () => {
                calls++;

                if (calls === 1) {
                    nested = controller.start(input, { timeoutMs: 100 });
                }

                return 0;
            },
        );
        const first = controller.start(input, { timeoutMs: 1000 });
        expect(await nested!.outcome).toEqual(failure('busy'));
        expect(created).toBe(1);
        workers[0].emit('exit', 0);
        expect(await first.cleanup).toBe('released');
        const second = controller.start(input, { timeoutMs: 1000 });
        workers[0].emit('exit', 0);
        expect(await controller.start(input, { timeoutMs: 100 }).outcome).toEqual(failure('busy'));
        expect(created).toBe(2);
        workers[1].emit('exit', 0);
        expect(await second.cleanup).toBe('released');
    });

    it('rejects options accessors, prototypes, extra keys and proxies without executing them', async () => {
        const signal = new AbortController();
        const factory = vi.fn(() => new FakeWorker());
        const controller = new PreflightWorkerTask(factory, 30);
        let executed = 0;
        const options = Object.defineProperty({}, 'timeoutMs', {
            get() {
                executed++;
                void controller.start(input, { timeoutMs: 100 });
                return 100;
            },
            set(_value: number) {
                executed++;
                signal.abort();
            },
        });
        const values = [
            options,
            Object.create({ timeoutMs: 100 }),
            { timeoutMs: 100, extra: 1 },
            new Proxy(
                { timeoutMs: 100 },
                {
                    ownKeys() {
                        executed++;
                        throw Error();
                    },
                },
            ),
        ];

        for (const value of values) {
            const task = controller.start(input, value as { timeoutMs: number });
            expect(await task.outcome).toEqual(failure('invalid_options'));
            expect(await task.cleanup).toBe('released');
        }

        expect(executed).toBe(0);
        expect(signal.signal.aborted).toBe(false);
        expect(factory).not.toHaveBeenCalled();
        const worker = new FakeWorker();
        const active = new PreflightWorkerTask(() => worker, 30);
        const task = active.start(input, { timeoutMs: 1000 });
        expect(await active.start(input, options as { timeoutMs: number }).outcome).toEqual(
            failure('busy'),
        );
        expect(executed).toBe(0);
        worker.emit('exit', 0);
        await task.cleanup;
    });

    it('handles nonfinite, throwing and regressing clock before factory without locking the slot', async () => {
        for (const bad of [NaN, Infinity, -Infinity, 'throw', 'backwards'] as const) {
            let isBad = true;
            let calls = 0;
            const factory = vi.fn(() => new FakeWorker());
            const controller = new PreflightWorkerTask(factory, 30, () => {
                if (!isBad) {
                    return 100;
                }

                calls++;

                if (bad === 'throw') {
                    throw Error('private');
                }

                if (bad === 'backwards') {
                    return calls === 1 ? 100 : 99;
                }

                return bad;
            });
            const task = controller.start(input, { timeoutMs: 1000 });
            expect(await task.outcome).toEqual(failure('internal'));
            expect(await task.cleanup).toBe('released');
            expect(factory).not.toHaveBeenCalled();
            isBad = false;
            const next = controller.start(input, { timeoutMs: 1000 });
            expect(factory).toHaveBeenCalledOnce();
            factory.mock.results[0].value.emit('exit', 0);
            expect(await next.cleanup).toBe('released');
        }
    });

    it.each(['message', 'error', 'abort', 'exit'] as const)(
        'clock failure during %s stays controlled and waits for exit',
        async (event) => {
            let broken = false;
            const signal = new AbortController();
            const worker = new FakeWorker();
            const controller = new PreflightWorkerTask(
                () => worker,
                30,
                () => {
                    if (broken) {
                        throw Error('private clock');
                    }

                    return 0;
                },
            );
            const task = controller.start(input, { timeoutMs: 1000, signal: signal.signal });
            broken = true;

            if (event === 'message') {
                worker.emit('message', message());
            }

            if (event === 'error') {
                worker.emit('error', Error('private worker'));
            }

            if (event === 'abort') {
                signal.abort();
            }

            if (event === 'exit') {
                worker.emit('exit', 0);
            }

            expect(await task.outcome).toEqual(failure('internal'));

            if (event !== 'exit') {
                expect(worker.terminate).toHaveBeenCalledOnce();
                expect(await controller.start(input, { timeoutMs: 100 }).outcome).toEqual(
                    failure('busy'),
                );
                worker.emit('exit', 1);
            }

            expect(await task.cleanup).toBe('released');
            expect(worker.eventNames()).toEqual([]);
            expect(getEventListeners(signal.signal, 'abort')).toHaveLength(0);
        },
    );

    it.each([NaN, Infinity, -1])(
        'fails closed on invalid event-time clock value %s',
        async (value) => {
            let bad = false;
            const worker = new FakeWorker();
            const controller = new PreflightWorkerTask(
                () => worker,
                30,
                () => (bad ? value : 0),
            );
            const task = controller.start(input, { timeoutMs: 1000 });
            bad = true;
            worker.emit('message', message());
            expect(await task.outcome).toEqual(failure('internal'));
            expect(await controller.start(input, { timeoutMs: 100 }).outcome).toEqual(
                failure('busy'),
            );
            worker.emit('exit', 1);
            expect(await task.cleanup).toBe('released');
        },
    );

    it('ignores a message reentered from clock after exit was observed', async () => {
        let calls = 0;
        const worker = new FakeWorker();
        const controller = new PreflightWorkerTask(
            () => worker,
            30,
            () => {
                if (++calls === 6) {
                    worker.emit('message', message());
                }

                return 0;
            },
        );
        const task = controller.start(input, { timeoutMs: 1000 });
        worker.emit('exit', 0);
        expect(await task.outcome).toEqual(failure('exit'));
        expect(await task.cleanup).toBe('released');
    });

    it('rejects a duplicate message reentered from the injected clock', async () => {
        let calls = 0;
        const worker = new FakeWorker();
        const controller = new PreflightWorkerTask(
            () => worker,
            30,
            () => {
                if (++calls === 7) {
                    worker.emit('message', message());
                }

                return 0;
            },
        );
        const task = controller.start(input, { timeoutMs: 1000 });
        worker.emit('message', message());
        expect(await task.outcome).toEqual(failure('invalid_result'));
        worker.emit('exit', 1);
        expect(await task.cleanup).toBe('released');
    });

    it('does not spawn if the deadline passes while scheduling its timer', async () => {
        let calls = 0;
        const factory = vi.fn(() => new FakeWorker());
        const controller = new PreflightWorkerTask(factory, 30, () => (++calls < 3 ? 0 : 100));
        const task = controller.start(input, { timeoutMs: 10 });
        expect(await task.outcome).toEqual(failure('timeout'));
        expect(await task.cleanup).toBe('released');
        expect(factory).not.toHaveBeenCalled();
    });

    it('does not install a timer after abort during the clock call', async () => {
        vi.useFakeTimers();

        try {
            const signal = new AbortController();
            let calls = 0;
            const factory = vi.fn(() => new FakeWorker());
            const controller = new PreflightWorkerTask(factory, 30, () => {
                if (++calls === 3) {
                    signal.abort();
                }

                return 0;
            });
            const task = controller.start(input, { timeoutMs: 100, signal: signal.signal });
            expect(await task.outcome).toEqual(failure('abort'));
            expect(await task.cleanup).toBe('released');
            expect(factory).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
            expect(getEventListeners(signal.signal, 'abort')).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('charges copy and factory time to deadline using injected monotonic clock', async () => {
        let time = 0;
        const worker = new FakeWorker();
        const controller = new PreflightWorkerTask(
            () => {
                time = 20;
                return worker;
            },
            30,
            () => time,
        );
        const task = controller.start(input, { timeoutMs: 10 });
        expect(await task.outcome).toEqual(failure('timeout'));
        expect(worker.terminate).toHaveBeenCalledOnce();
        worker.emit('exit', 1);
        expect(await task.cleanup).toBe('released');
        const never = vi.fn(() => new FakeWorker());
        let tick = 0;
        const copyDeadline = new PreflightWorkerTask(never, 30, () => (tick++ ? 100 : 0));
        expect(await copyDeadline.start(input, { timeoutMs: 10 }).outcome).toEqual(
            failure('timeout'),
        );
        expect(never).not.toHaveBeenCalled();
    });

    it('copies subviews without invoking custom getters and rejects proxy, SAB, detached, oversize', async () => {
        const source = new Uint8Array([9, 1, 2, 3, 8]);
        const view = source.subarray(1, 4);
        Object.defineProperty(view, 'buffer', {
            get() {
                throw Error('getter');
            },
        });
        let snapshot = new Uint8Array();
        const worker = new FakeWorker();
        const controller = new PreflightWorkerTask((owned) => {
            snapshot = new Uint8Array(owned);
            return worker;
        }, 30);
        const task = controller.start(view, { timeoutMs: 100 });
        expect([...snapshot]).toEqual([1, 2, 3]);
        snapshot[0] = 7;
        expect([...source]).toEqual([9, 1, 2, 3, 8]);
        worker.emit('exit', 0);
        await task.cleanup;
        const detached = new Uint8Array(4);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });

        for (const [value, code] of [
            [new Proxy(new Uint8Array(1), {}), 'invalid_input'],
            [new Uint8Array(new SharedArrayBuffer(1)), 'invalid_input'],
            [detached, 'invalid_input'],
            [new Uint8Array(32 * 1024 * 1024 + 1), 'limit'],
            [{}, 'invalid_input'],
        ] as const) {
            expect(await controller.start(value, { timeoutMs: 100 }).outcome).toEqual(
                failure(code),
            );
        }
    });

    it.each(['throw', 'noop', 'getter'] as const)(
        'bypasses %s instance removeEventListener and verifies removal',
        async (mode) => {
            const signal = new AbortController();
            let invoked = 0;
            Object.defineProperty(
                signal.signal,
                'removeEventListener',
                mode === 'getter'
                    ? {
                          configurable: true,
                          get() {
                              invoked++;
                              throw Error('private');
                          },
                      }
                    : {
                          configurable: true,
                          value: () => {
                              invoked++;

                              if (mode === 'throw') {
                                  throw Error('private');
                              }
                          },
                      },
            );
            const worker = new FakeWorker();
            const controller = new PreflightWorkerTask(() => worker, 30);
            const task = controller.start(input, { timeoutMs: 1000, signal: signal.signal });
            expect(getEventListeners(signal.signal, 'abort')).toHaveLength(1);
            worker.emit('message', message());
            worker.emit('exit', 0);
            expect((await task.outcome).kind).toBe('result');
            expect(await task.cleanup).toBe('released');
            expect(getEventListeners(signal.signal, 'abort')).toHaveLength(0);
            expect(invoked).toBe(0);
        },
    );

    it('handles abort with a throwing removeEventListener and still observes exit', async () => {
        const signal = new AbortController();
        Object.defineProperty(signal.signal, 'removeEventListener', {
            value: () => {
                throw Error('private');
            },
        });
        const worker = new FakeWorker();
        worker.terminate.mockRejectedValue(Error('private'));
        const controller = new PreflightWorkerTask(() => worker, 30);
        const task = controller.start(input, { timeoutMs: 1000, signal: signal.signal });
        signal.abort();
        expect(await task.outcome).toEqual(failure('abort'));
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(await task.cleanup).toBe('unknown');
        expect(await controller.start(input, { timeoutMs: 100 }).outcome).toEqual(failure('busy'));
        worker.emit('exit', 1);
        expect(getEventListeners(signal.signal, 'abort')).toHaveLength(0);
        const next = controller.start(input, { timeoutMs: 100 });
        worker.emit('exit', 0);
        expect(await next.cleanup).toBe('released');
    });

    it('keeps the slot on unprovable listener cleanup without invoking a later getter', async () => {
        const signal = new AbortController();
        const worker = new FakeWorker();
        const controller = new PreflightWorkerTask(() => worker, 30);
        const task = controller.start(input, { timeoutMs: 1000, signal: signal.signal });
        let invoked = false;
        Object.defineProperty(signal.signal, 'listeners', {
            get() {
                invoked = true;
                throw Error('private');
            },
        });
        worker.emit('message', message());
        worker.emit('exit', 0);
        expect((await task.outcome).kind).toBe('result');
        expect(await task.cleanup).toBe('unknown');
        expect(await controller.start(input, { timeoutMs: 100 }).outcome).toEqual(failure('busy'));
        expect(invoked).toBe(false);
    });

    it.each(['throws', 'unrecognized'] as const)(
        'keeps the slot when installed abort listener observation %s',
        async (mode) => {
            vi.doMock('node:events', async (importOriginal) => {
                const original = await importOriginal<typeof import('node:events')>();
                return {
                    ...original,
                    getEventListeners: () => {
                        if (mode === 'throws') {
                            throw Error('private');
                        }

                        return [];
                    },
                };
            });

            try {
                vi.resetModules();
                const { PreflightWorkerTask: Isolated } =
                    await import('../src/webui/plugin-install/preflight-worker-task');
                const signal = new AbortController();
                const factory = vi.fn(() => new FakeWorker());
                const controller = new Isolated(factory, 30);
                const task = controller.start(input, { timeoutMs: 100, signal: signal.signal });
                expect(await task.outcome).toEqual(failure('invalid_signal'));
                expect(await task.cleanup).toBe('unknown');
                expect(factory).not.toHaveBeenCalled();
                expect(getEventListeners(signal.signal, 'abort')).toHaveLength(0);
                expect(await controller.start(input, { timeoutMs: 100 }).outcome).toEqual(
                    failure('busy'),
                );
            } finally {
                vi.doUnmock('node:events');
                vi.resetModules();
            }
        },
    );

    it('keeps cleanup unknown when the captured intrinsic remove throws', async () => {
        const original = EventTarget.prototype.removeEventListener;
        const spy = vi
            .spyOn(EventTarget.prototype, 'removeEventListener')
            .mockImplementation(() => {
                throw Error('private');
            });

        try {
            vi.resetModules();
            const { PreflightWorkerTask: Isolated } =
                await import('../src/webui/plugin-install/preflight-worker-task');
            const signal = new AbortController();
            const worker = new FakeWorker();
            const controller = new Isolated(() => worker, 30);
            const task = controller.start(input, { timeoutMs: 1000, signal: signal.signal });
            const listener = getEventListeners(signal.signal, 'abort')[0] as Parameters<
                typeof original
            >[1];
            worker.emit('message', message());
            worker.emit('exit', 0);
            expect((await task.outcome).kind).toBe('result');
            expect(await task.cleanup).toBe('unknown');
            expect(await controller.start(input, { timeoutMs: 100 }).outcome).toEqual(
                failure('busy'),
            );
            original.call(signal.signal, 'abort', listener);

            const beforeSpawn = new AbortController();
            let calls = 0;
            const factory = vi.fn(() => new FakeWorker());
            const second = new Isolated(factory, 30, () => {
                if (++calls === 2) {
                    beforeSpawn.abort();
                }

                return 0;
            });
            const aborted = second.start(input, { timeoutMs: 100, signal: beforeSpawn.signal });
            expect(await aborted.outcome).toEqual(failure('abort'));
            expect(await aborted.cleanup).toBe('unknown');
            expect(await second.start(input, { timeoutMs: 100 }).outcome).toEqual(failure('busy'));
            expect(factory).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
            vi.resetModules();
        }
    });

    it('settles a pre-factory abort despite a throwing instance remover', async () => {
        const signal = new AbortController();
        Object.defineProperty(signal.signal, 'removeEventListener', {
            get() {
                throw Error('private');
            },
        });
        const factory = vi.fn(() => new FakeWorker());
        let calls = 0;
        const controller = new PreflightWorkerTask(factory, 30, () => {
            if (++calls === 2) {
                signal.abort();
            }

            return 0;
        });
        const task = controller.start(input, { timeoutMs: 100, signal: signal.signal });
        expect(await task.outcome).toEqual(failure('abort'));
        expect(await task.cleanup).toBe('released');
        expect(getEventListeners(signal.signal, 'abort')).toHaveLength(0);
        expect(factory).not.toHaveBeenCalled();
    });

    it('returns unknown when a worker removeListener hook throws', async () => {
        const worker = new FakeWorker();
        worker.on('removeListener', (event) => {
            if (event === 'message') {
                throw Error('private');
            }
        });
        const controller = new PreflightWorkerTask(() => worker, 30);
        const task = controller.start(input, { timeoutMs: 1000 });
        worker.emit('message', message());
        worker.emit('exit', 0);
        expect((await task.outcome).kind).toBe('result');
        expect(await task.cleanup).toBe('unknown');
        expect(await controller.start(input, { timeoutMs: 100 }).outcome).toEqual(failure('busy'));
    });

    it('makes a best effort to terminate after worker listener registration fails', async () => {
        const worker = new FakeWorker();
        worker.on('newListener', (event) => {
            if (event === 'message') {
                throw Error('private');
            }
        });
        const controller = new PreflightWorkerTask(() => worker, 30);
        const task = controller.start(input, { timeoutMs: 1000 });
        expect(await task.outcome).toEqual(failure('invalid_worker'));
        expect(await task.cleanup).toBe('unknown');
        expect(worker.terminate).toHaveBeenCalledOnce();
        worker.emit('error', Error('private'));
        worker.emit('exit', 1);
        expect(await controller.start(input, { timeoutMs: 100 }).outcome).toEqual(failure('busy'));
    });

    it('rejects malicious signal lookup accessors without invoking them', async () => {
        for (const key of ['aborted', 'addEventListener', 'listeners']) {
            const signal = new AbortController();
            let called = false;
            Object.defineProperty(signal.signal, key, {
                get() {
                    called = true;
                    throw Error('private');
                },
            });
            const factory = vi.fn(() => new FakeWorker());
            const task = new PreflightWorkerTask(factory, 30).start(input, {
                timeoutMs: 100,
                signal: signal.signal,
            });
            expect(await task.outcome).toEqual(failure('invalid_signal'));
            expect(await task.cleanup).toBe('released');
            expect(called).toBe(false);
            expect(factory).not.toHaveBeenCalled();
        }

        const proxied = new Proxy(new AbortController().signal, {});
        const task = new PreflightWorkerTask(() => new FakeWorker(), 30).start(input, {
            timeoutMs: 100,
            signal: proxied,
        });
        expect(await task.outcome).toEqual(failure('invalid_signal'));
    });

    it('observes abort even if another listener stops immediate propagation', async () => {
        const worker = new FakeWorker();
        const signal = new AbortController();
        signal.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
        const controller = new PreflightWorkerTask(() => worker, 30);
        const task = controller.start(input, { timeoutMs: 1000, signal: signal.signal });
        signal.abort();
        expect(await task.outcome).toEqual(failure('abort'));
        worker.emit('exit', 1);
        expect(await task.cleanup).toBe('released');
    });

    it('removes signal and worker listeners after an observed exit', async () => {
        const worker = new FakeWorker();
        const signal = new AbortController();
        const controller = new PreflightWorkerTask(() => worker, 30);
        const task = controller.start(input, { timeoutMs: 1000, signal: signal.signal });
        expect(getEventListeners(signal.signal, 'abort')).toHaveLength(1);
        worker.emit('message', message());
        worker.emit('exit', 0);
        expect(await task.cleanup).toBe('released');
        expect(getEventListeners(signal.signal, 'abort')).toHaveLength(0);
        expect(worker.eventNames()).toEqual([]);
        signal.abort();
        expect((await task.outcome).kind).toBe('result');
    });

    it('accepts the exact input limit while retaining the active slot', async () => {
        const worker = new FakeWorker();
        const controller = new PreflightWorkerTask(() => worker, 30);
        const task = controller.start(new Uint8Array(32 * 1024 * 1024), { timeoutMs: 2000 });
        expect(await controller.start(input, { timeoutMs: 100 }).outcome).toEqual(failure('busy'));
        worker.emit('exit', 0);
        expect(await task.cleanup).toBe('released');
    });

    it('bounds timeout and rejects false signals', async () => {
        const controller = new PreflightWorkerTask(() => new FakeWorker());

        for (const timeoutMs of [0, 60001, Infinity, NaN, 1.5]) {
            expect(await controller.start(input, { timeoutMs }).outcome).toEqual(
                failure('invalid_timeout'),
            );
        }

        expect(
            await controller.start(input, { timeoutMs: 10, signal: {} as AbortSignal }).outcome,
        ).toEqual(failure('invalid_signal'));
    });
});

describe('synthetic real Node workers', () => {
    it('runs the independent ZIP parser on a synthetic stored archive', async () => {
        const name = Buffer.from('x');
        const body = Buffer.from('A');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(0xd3d99e8b, 14);
        local.writeUInt32LE(1, 18);
        local.writeUInt32LE(1, 22);
        local.writeUInt16LE(1, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(0xd3d99e8b, 16);
        central.writeUInt32LE(1, 20);
        central.writeUInt32LE(1, 24);
        central.writeUInt16LE(1, 28);
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(1, 8);
        end.writeUInt16LE(1, 10);
        end.writeUInt32LE(central.length + name.length, 12);
        end.writeUInt32LE(local.length + name.length + body.length, 16);
        const archive = Buffer.concat([local, name, body, central, name, end]);
        const expected = preflightZip(archive);
        expect(expected.ok).toBe(true);
        const moduleURL = new URL('../src/webui/plugin-install/zip-preflight.ts', import.meta.url)
            .href;
        const controller = new PreflightWorkerTask(
            (owned) =>
                new Worker(
                    `
            const { parentPort, workerData } = require('node:worker_threads');
            (async () => {
                const { preflightZip } = await import(workerData.moduleURL);
                parentPort.postMessage({ kind: 'result', result: preflightZip(new Uint8Array(workerData.owned)) });
                parentPort.close();
            })();
        `,
                    { eval: true, workerData: { owned, moduleURL }, transferList: [owned] },
                ),
            2000,
        );
        const task = controller.start(archive, { timeoutMs: 2000 });
        expect(await task.outcome).toEqual({ kind: 'result', result: expected });
        expect(await task.cleanup).toBe('released');
    }, 5000);

    it('terminates an infinite worker and waits for its actual exit', async () => {
        const controller = new PreflightWorkerTask(
            () => new Worker('while (true) {}', { eval: true }),
            2000,
        );
        const task = controller.start(input, { timeoutMs: 30 });
        expect(await task.outcome).toEqual(failure('timeout'));
        expect(await task.cleanup).toBe('released');
    }, 5000);

    it('passes only the selected snapshot and accepts the synthetic worker result', async () => {
        const bytes = new Uint8Array([0, 1, 2, 3, 4]);
        const controller = new PreflightWorkerTask(
            (owned) =>
                new Worker(
                    `
            const { parentPort, workerData } = require('node:worker_threads');
            const { createHash } = require('node:crypto');
            const bytes = new Uint8Array(workerData);
            parentPort.postMessage({ kind: 'result', result: { ok: true,
                entries: [{ path: 'x', kind: 'file', compressedSize: bytes.length, actualSize: bytes.length, crc32: 0 }],
                totalSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } });
            parentPort.close();
        `,
                    { eval: true, workerData: owned, transferList: [owned] },
                ),
            2000,
        );
        const task = controller.start(bytes.subarray(1, 4), { timeoutMs: 2000 });
        expect((await task.outcome).kind).toBe('result');
        expect(await task.cleanup).toBe('released');
        expect([...bytes]).toEqual([0, 1, 2, 3, 4]);
    }, 5000);

    it('reports real worker exceptions without leaking error details', async () => {
        const controller = new PreflightWorkerTask(
            () => new Worker("throw Error('private')", { eval: true }),
            2000,
        );
        const task = controller.start(input, { timeoutMs: 2000 });
        expect(await task.outcome).toEqual(failure('worker_error'));
        expect(await task.cleanup).toBe('released');
    }, 5000);
});
