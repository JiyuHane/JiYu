import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { createLogger } from '@snowluma/common/logger';
import type { DatabaseMigrationCallbacks, DatabaseMigrationTask } from './manager';
import type { MessageStoreMigrationStatus } from './message-store-migration';
import {
    MESSAGE_STORE_WORKER_KIND,
    type MessageStoreMigrationWorkerData,
    type MessageStoreMigrationWorkerMessage,
} from './message-store-migration-worker';

export interface MessageStoreMigrationWorkerHandle {
    on(event: 'message', listener: (message: MessageStoreMigrationWorkerMessage) => void): this;
    once(event: 'error', listener: (error: Error) => void): this;
    once(event: 'exit', listener: (code: number) => void): this;
    postMessage(message: 'start' | 'cancel'): void;
    unref(): void;
}

type CreateMigrationWorker = (
    filename: string,
    options: WorkerOptions,
) => MessageStoreMigrationWorkerHandle;

export function createMessageStoreMigrationTask(
    uin: string,
    createWorker: CreateMigrationWorker = (filename, options) => new Worker(filename, options),
): DatabaseMigrationTask {
    const log = createLogger('OneBot.MessageMigration').child({ uin: Number(uin) });
    let worker: MessageStoreMigrationWorkerHandle | null = null;
    let cancelled = false;
    let finished = false;
    let failureReported = false;
    let started = false;
    let cancellationPosted = false;
    let exited = false;
    let workerFailure: unknown;
    let resolveStopped!: () => void;
    let rejectStopped!: (error: unknown) => void;
    const stopped = new Promise<void>((resolve, reject) => {
        resolveStopped = resolve;
        rejectStopped = reject;
    });
    // Legacy callers may ignore cancel's return value. Keep its failure observable
    // to awaiters without turning those callers into unhandled-rejection sources.
    void stopped.catch(() => undefined);

    const requestCancellation = (): void => {
        if (worker && !exited && !cancellationPosted) {
            // Preserve synchronous postMessage failures for existing callers.
            // A later call may retry posting; cancellation still fences events.
            worker.postMessage('cancel');
            cancellationPosted = true;
            worker.unref();
        }
    };

    return {
        start(callbacks: DatabaseMigrationCallbacks): void {
            if (cancelled) {
                return;
            }

            if (started) {
                throw new Error('database migration task already started');
            }

            started = true;

            const reportFailure = (error: Error): void => {
                if (cancelled || failureReported) {
                    return;
                }

                failureReported = true;
                callbacks.onFailed(error);
            };

            const data: MessageStoreMigrationWorkerData = {
                kind: MESSAGE_STORE_WORKER_KIND,
                dbPath: path.join('data', uin, 'messages.db'),
            };
            const entryPath = process.argv[1];
            const sourceEntry = /\.(?:cts|mts|ts|tsx)$/.test(entryPath);

            try {
                worker = createWorker(sourceEntry ? sourceWorkerBootstrap(entryPath) : entryPath, {
                    workerData: data,
                    eval: sourceEntry,
                    execArgv: sourceEntry ? [] : process.execArgv,
                });
            } catch (error) {
                // Construction failed before a worker acquired any resources.
                resolveStopped();
                throw error;
            }

            worker.on('message', (message: MessageStoreMigrationWorkerMessage) => {
                if (cancelled) {
                    return;
                }

                if (message.kind === 'ready') {
                    callbacks.onReady();
                } else if (message.kind === 'preparation') {
                    const progress = message.progress;

                    if (progress.stage === 'started') {
                        log.info('preparing message history migration');
                    } else if (progress.stage === 'indexed') {
                        log.info(
                            'message history migration preparation finished in %dms',
                            Math.round(progress.elapsedMs),
                        );
                    } else {
                        log.info(
                            'message history migration: pending=%d checked in %dms',
                            progress.total,
                            Math.round(progress.elapsedMs),
                        );
                    }
                } else if (message.kind === 'progress') {
                    callbacks.onProgress(message.status, message.elapsedMs);

                    if (message.status.phase === 'complete') {
                        finished = true;
                    }
                } else {
                    reportFailure(new Error(message.message));
                }
            });
            worker.once('error', (error) => {
                workerFailure = error;
                reportFailure(error);
            });
            worker.once('exit', (code) => {
                exited = true;

                // Neither an unref nor a complete progress message establishes
                // retirement: the worker's finally/close must reach actual exit.
                if (workerFailure !== undefined || code !== 0) {
                    rejectStopped(
                        workerFailure ??
                            new Error(`database migration worker exited with code ${code}`),
                    );
                } else {
                    resolveStopped();
                }

                if (!cancelled && !finished) {
                    reportFailure(
                        new Error(
                            `database migration worker exited before completion with code ${code}`,
                        ),
                    );
                }
            });

            if (cancelled) {
                requestCancellation();
            }
        },
        beginMigration(): void {
            if (!cancelled) {
                worker?.postMessage('start');
            }
        },
        cancel(): Promise<void> {
            cancelled = true;

            if (!started) {
                resolveStopped();
            }

            requestCancellation();
            return stopped;
        },
    };
}

function sourceWorkerBootstrap(entryPath: string): string {
    const require = createRequire(path.resolve(entryPath));
    return [
        `const { register } = require(${JSON.stringify(require.resolve('tsx/esm/api'))});`,
        'register();',
        `import(${JSON.stringify(path.resolve(entryPath))});`,
    ].join('\n');
}

export function estimateRemainingSeconds(
    status: MessageStoreMigrationStatus,
    recentRowsPerSecond: number | null,
): number | null {
    if (status.phase === 'complete') {
        return 0;
    }

    if (!recentRowsPerSecond || recentRowsPerSecond <= 0) {
        return null;
    }

    return Math.max(0, Math.ceil((status.total - status.processed) / recentRowsPerSecond));
}
