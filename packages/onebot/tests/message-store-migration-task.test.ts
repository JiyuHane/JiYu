import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { subscribeLogs } from '@snowluma/common/logger';
import type { DatabaseMigrationCallbacks } from '../src/manager';
import {
    createMessageStoreMigrationTask,
    type MessageStoreMigrationWorkerHandle,
} from '../src/message-store-migration-task';

function fakeWorker(): EventEmitter & MessageStoreMigrationWorkerHandle {
    const worker = new EventEmitter() as EventEmitter & MessageStoreMigrationWorkerHandle;
    worker.postMessage = vi.fn();
    worker.unref = vi.fn();
    return worker;
}

function callbacks(): DatabaseMigrationCallbacks {
    return {
        onReady: vi.fn(),
        onProgress: vi.fn(),
        onFailed: vi.fn(),
    };
}

describe('message-store migration task lifecycle', () => {
    it('records worker preparation through the parent logger with account context', () => {
        const worker = fakeWorker();
        const handlers = callbacks();
        const entries: Array<{ scope: string; uin?: number; message: string }> = [];
        const unsubscribe = subscribeLogs((entry) => entries.push(entry));
        const task = createMessageStoreMigrationTask('10001', () => worker);

        try {
            task.start(handlers);
            worker.emit('message', { kind: 'preparation', progress: { stage: 'started' } });
            worker.emit('message', {
                kind: 'preparation',
                progress: { stage: 'indexed', elapsedMs: 12.5 },
            });
            worker.emit('message', {
                kind: 'preparation',
                progress: { stage: 'counted', total: 3, elapsedMs: 2.1 },
            });
            expect(
                entries.map((entry) => ({
                    scope: entry.scope,
                    uin: entry.uin,
                    message: entry.message,
                })),
            ).toEqual([
                {
                    scope: 'OneBot.MessageMigration',
                    uin: 10001,
                    message: 'preparing message history migration',
                },
                {
                    scope: 'OneBot.MessageMigration',
                    uin: 10001,
                    message: 'message history migration preparation finished in 13ms',
                },
                {
                    scope: 'OneBot.MessageMigration',
                    uin: 10001,
                    message: 'message history migration: pending=3 checked in 2ms',
                },
            ]);
            expect(handlers.onProgress).not.toHaveBeenCalled();
            expect(handlers.onFailed).not.toHaveBeenCalled();
            task.cancel();
            worker.emit('message', { kind: 'preparation', progress: { stage: 'started' } });
            expect(entries).toHaveLength(3);
        } finally {
            unsubscribe();
        }
    });

    it('reports an exit before completion even when its code is zero', () => {
        const worker = fakeWorker();
        const handlers = callbacks();
        const task = createMessageStoreMigrationTask('10001', () => worker);

        task.start(handlers);
        worker.emit('exit', 0);

        expect(handlers.onFailed).toHaveBeenCalledOnce();
    });

    it('accepts a normal exit after completion', () => {
        const worker = fakeWorker();
        const handlers = callbacks();
        const task = createMessageStoreMigrationTask('10001', () => worker);

        task.start(handlers);
        worker.emit('message', {
            kind: 'progress',
            status: { phase: 'complete', processed: 8, total: 8 },
            elapsedMs: 25,
        });
        worker.emit('exit', 0);

        expect(handlers.onProgress).toHaveBeenCalledOnce();
        expect(handlers.onFailed).not.toHaveBeenCalled();
    });

    it('ignores worker exit after cancellation', () => {
        const worker = fakeWorker();
        const handlers = callbacks();
        const task = createMessageStoreMigrationTask('10001', () => worker);

        task.start(handlers);
        task.cancel();
        worker.emit('exit', 1);

        expect(worker.postMessage).toHaveBeenCalledWith('cancel');
        expect(worker.unref).toHaveBeenCalledOnce();
        expect(handlers.onFailed).not.toHaveBeenCalled();
    });

    it('waits for real exit rather than unref, cancellation or complete progress', async () => {
        const worker = fakeWorker();
        const handlers = callbacks();
        const task = createMessageStoreMigrationTask('10001', () => worker);
        task.start(handlers);
        worker.emit('message', {
            kind: 'progress',
            status: { phase: 'complete', processed: 8, total: 8 },
            elapsedMs: 25,
        });
        const stopped = Promise.resolve(task.cancel());
        let settled = false;
        void stopped.then(() => {
            settled = true;
        });
        expect(task.cancel()).toBe(task.cancel());
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(worker.postMessage).toHaveBeenCalledTimes(1);
        expect(worker.unref).toHaveBeenCalledOnce();
        worker.emit('message', { kind: 'ready' });
        expect(handlers.onReady).not.toHaveBeenCalled();
        worker.emit('exit', 0);
        await stopped;
        expect(settled).toBe(true);
    });

    it('retains a worker cleanup error, but waits for its subsequent exit', async () => {
        const worker = fakeWorker();
        const handlers = callbacks();
        const task = createMessageStoreMigrationTask('10001', () => worker);
        task.start(handlers);
        const stopped = Promise.resolve(task.cancel());
        let settled = false;
        void stopped.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        const failure = new Error('synthetic worker finally failed');
        worker.emit('error', failure);
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(handlers.onFailed).not.toHaveBeenCalled();
        worker.emit('exit', 1);
        await expect(stopped).rejects.toBe(failure);
    });

    it('reports an abnormal cancelled exit even when no error event was sent', async () => {
        const worker = fakeWorker();
        const task = createMessageStoreMigrationTask('10001', () => worker);
        task.start(callbacks());
        const stopped = task.cancel();
        worker.emit('exit', 2);
        await expect(stopped).rejects.toThrow(/exited with code 2/);
    });

    it('does not create a worker after cancellation before start', async () => {
        const createWorker = vi.fn(() => fakeWorker());
        const task = createMessageStoreMigrationTask('10001', createWorker);
        await task.cancel();
        task.start(callbacks());
        task.beginMigration();
        expect(createWorker).not.toHaveBeenCalled();
    });

    it('settles cancellation after a failed worker construction with no resources', async () => {
        const failure = new Error('synthetic construction failed');
        const task = createMessageStoreMigrationTask('10001', () => {
            throw failure;
        });
        expect(() => task.start(callbacks())).toThrow(failure);
        await expect(task.cancel()).resolves.toBeUndefined();
    });

    it('preserves a synchronous cancel post failure and permits a real retry', async () => {
        const worker = fakeWorker();
        const failure = new Error('synthetic post failed');
        vi.mocked(worker.postMessage).mockImplementationOnce(() => {
            throw failure;
        });
        const task = createMessageStoreMigrationTask('10001', () => worker);
        task.start(callbacks());
        expect(() => task.cancel()).toThrow(failure);
        const stopped = task.cancel();
        worker.emit('exit', 0);
        await stopped;
        expect(worker.postMessage).toHaveBeenCalledTimes(2);
    });

    it('does not resolve early when cancellation reenters worker construction', async () => {
        const worker = fakeWorker();
        let stopped: void | Promise<void>;
        const task = createMessageStoreMigrationTask('10001', () => {
            stopped = task.cancel();
            return worker;
        });
        task.start(callbacks());
        let settled = false;
        void Promise.resolve(stopped!).then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(worker.postMessage).toHaveBeenCalledWith('cancel');
        worker.emit('exit', 0);
        await stopped!;
    });

    it('waits for an actual isolated Node worker to leave its final drain', async () => {
        let ready!: () => void;
        const readyPromise = new Promise<void>((resolve) => {
            ready = resolve;
        });
        let cancelObserved!: () => void;
        const cancellation = new Promise<void>((resolve) => {
            cancelObserved = resolve;
        });
        const worker = new Worker(
            `
            const { parentPort } = require('node:worker_threads');
            parentPort.on('message', (message) => {
                if (message === 'cancel') {
                    parentPort.postMessage({ kind: 'preparation', progress: { stage: 'started' } });
                } else if (message === 'release') {
                    parentPort.close();
                }
            });
            parentPort.postMessage({ kind: 'ready' });
        `,
            { eval: true },
        );
        worker.on('message', (message: { kind: string }) => {
            if (message.kind === 'preparation') {
                cancelObserved();
            }
        });
        const task = createMessageStoreMigrationTask('10001', () => worker);
        const handlers = callbacks();
        handlers.onReady = ready;

        try {
            task.start(handlers);
            await readyPromise;
            const stopped = Promise.resolve(task.cancel());
            let settled = false;
            void stopped.then(() => {
                settled = true;
            });
            await cancellation;
            expect(settled).toBe(false);
            worker.postMessage('release');
            await stopped;
            expect(worker.threadId).toBe(-1);
        } finally {
            await worker.terminate();
        }
    });
});
