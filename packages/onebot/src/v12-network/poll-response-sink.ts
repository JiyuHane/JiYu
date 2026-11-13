import type { ServerResponse } from 'node:http';
import type { PollSink } from '../v12-runtime/poll-transaction';

type PollEvent = 'close' | 'error' | 'finish';
type Phase = 'initial' | 'entering' | 'owned' | 'ending' | 'poisoned';

const owners = new WeakMap<ServerResponse, object>();
const tombstone = Object.freeze({});

/**
 * The trusted transport must pass the canonical ServerResponse and own its
 * underlying writes exclusively, without other facades or concurrent writers.
 * Object identity does not establish a same-process security boundary. A write
 * by another owner during writeHead reentry cannot be distinguished from ours.
 * Each canonical response permits at most one sink, even after cleanup; its weak
 * tombstone lasts until response collection. This adapter is not a route.
 *
 * Before construction the transport must install its own independent error
 * listener and retain it through construction failure, transaction cleanup and
 * dispose, until there is evidence no more error events can occur. If constructor
 * cleanup is uncertain, no instance is returned: the owner must dispose of the
 * response while retaining that error listener, and must not retry construction.
 * dispose neither ends nor destroys a response.
 *
 * reportError is a trusted transport callback; prefer a synchronous callback with
 * no return value. Ordinary, unmodified asynchronous returns are observed on a
 * best-effort basis and must settle in finite time. A never-settled return can
 * retain this sink and response through its observer, even after dispose. A false
 * diagnosticUncertain means no failure has yet been observed, not that reporting
 * completed. Rejection observation is not guaranteed for Promises with tampered
 * constructors or species, including when diagnosticUncertain is already true.
 */
export class NodePollResponseSink implements PollSink {
    private phase: Phase = 'initial';
    private terminal = false;
    private disposed = false;
    private disposing = false;
    private inFlight = false;
    private reportFailed = false;

    private readonly onError = (): void => {
        this.terminal = true;

        try {
            const result = this.reportError(new Error('poll response error'));
            // Avoid invoking an overridden .then on a returned native Promise.
            void Promise.prototype.then.call(Promise.resolve(result), undefined, () => {
                this.reportFailed = true;
            });
        } catch {
            // Diagnostic callbacks must not interrupt the response's other listeners.
            this.reportFailed = true;
        }
    };

    private readonly onClose = (): void => {
        this.terminal = true;
    };

    private readonly onFinish = (): void => {
        this.terminal = true;
    };

    constructor(
        private readonly response: ServerResponse,
        private readonly reportError: (error: Error) => unknown,
    ) {
        if (owners.has(response)) {
            throw new Error('poll response already owned');
        }

        owners.set(response, this);

        try {
            response.on('error', this.onError);
            response.on('close', this.onClose);
            response.on('finish', this.onFinish);
        } catch {
            // on() can throw before or after registration. Attempt all removals.
            const clean = this.removeOwnedListeners();
            owners.set(response, tombstone);

            if (clean) {
                throw new Error('poll response listener installation failed');
            }

            throw new Error('poll response listener installation cleanup uncertain');
        }
    }

    /** Whether diagnostic reporting failed; async failures appear after settlement. */
    get diagnosticUncertain(): boolean {
        return this.reportFailed;
    }

    isOpen(): boolean {
        if (
            this.disposed ||
            this.disposing ||
            this.terminal ||
            this.phase === 'poisoned' ||
            this.phase === 'ending' ||
            this.response.destroyed ||
            this.response.writableEnded ||
            this.response.writableFinished ||
            this.response.finished ||
            !this.hasOwnedListeners()
        ) {
            return false;
        }

        const phase = this.phase;
        // During writeHead reentry Node may be on either side of header publication.
        const headerOpen =
            phase === 'initial'
                ? !this.response.headersSent
                : phase === 'entering' || this.response.headersSent;

        // An externally invoked isOpen() can itself trigger synchronous reentry.
        return (
            headerOpen &&
            !this.disposed &&
            !this.disposing &&
            !this.terminal &&
            this.phase === phase
        );
    }

    on(event: PollEvent, listener: () => void): void {
        if (this.disposed || this.disposing) {
            throw new Error('poll response sink disposed');
        }

        this.response.on(event, listener);
    }

    off(event: PollEvent, listener: () => void): void {
        this.response.off(event, listener);
    }

    writeHead(): void {
        if (this.inFlight || this.phase !== 'initial') {
            throw new Error('poll response not writable');
        }

        // Response state getters and listener inspection can synchronously reenter.
        this.inFlight = true;

        try {
            if (!this.isOpen()) {
                throw new Error('poll response not writable');
            }

            this.phase = 'entering';

            try {
                this.response.writeHead(200, {
                    'content-type': 'application/json; charset=utf-8',
                    connection: 'close',
                });

                if (!this.response.headersSent) {
                    throw new Error('poll response header state invalid');
                }

                this.phase = 'owned';
            } catch (error) {
                this.phase = 'poisoned';
                throw error;
            }
        } finally {
            this.inFlight = false;
        }
    }

    end(body: string): void {
        if (this.inFlight || this.phase !== 'owned') {
            throw new Error('poll response not writable');
        }

        this.inFlight = true;

        try {
            if (!this.isOpen()) {
                throw new Error('poll response not writable');
            }

            this.phase = 'ending';

            try {
                this.response.end(body);
            } catch (error) {
                this.phase = 'poisoned';
                throw error;
            }
        } finally {
            this.inFlight = false;
        }
    }

    /** The transport's independently installed error owner must remain active. */
    dispose(): void {
        if (this.disposed) {
            return;
        }

        if (this.inFlight) {
            throw new Error('poll response cleanup in flight');
        }

        if (this.disposing) {
            throw new Error('poll response cleanup uncertain');
        }

        this.disposing = true;
        const clean = this.removeOwnedListeners();
        this.disposing = false;

        if (!clean) {
            this.phase = 'poisoned';
            throw new Error('poll response cleanup uncertain');
        }

        this.disposed = true;
        owners.set(this.response, tombstone);
    }

    private hasOwnedListeners(): boolean {
        return (
            this.response.listeners('error').includes(this.onError) &&
            this.response.listeners('close').includes(this.onClose) &&
            this.response.listeners('finish').includes(this.onFinish)
        );
    }

    private removeOwnedListeners(): boolean {
        let clean = true;

        for (const [event, listener] of [
            ['error', this.onError],
            ['close', this.onClose],
            ['finish', this.onFinish],
        ] as const) {
            try {
                this.response.off(event, listener);
            } catch {
                clean = false;
            }
        }

        try {
            if (
                this.response.listeners('error').includes(this.onError) ||
                this.response.listeners('close').includes(this.onClose) ||
                this.response.listeners('finish').includes(this.onFinish)
            ) {
                clean = false;
            }
        } catch {
            clean = false;
        }

        return clean;
    }
}
