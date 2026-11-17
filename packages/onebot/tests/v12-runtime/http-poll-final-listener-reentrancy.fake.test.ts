import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PollSink, PollTransaction } from '../../src/v12-runtime/poll-transaction';

// Import the real in-memory queue and transaction only after all effect guards
// are armed. This fixture constructs no runtime, account, plugin or socket.
let EventPollBuffer: typeof import('../../src/v12-runtime/event-poll-buffer').EventPollBuffer;
let PollCoordinator: typeof import('../../src/v12-runtime/poll-transaction').PollCoordinator;
let effects: Array<{ mock: { calls: unknown[] } }>;

function forbidden(): never {
    throw new Error('unexpected network, native or child-process operation in poll fixture');
}

beforeEach(async () => {
    vi.useFakeTimers();
    const fetchGuard = vi.fn(forbidden);
    const webSocketGuard = vi.fn(function ForbiddenWebSocket() {
        return forbidden();
    });
    const eventSourceGuard = vi.fn(function ForbiddenEventSource() {
        return forbidden();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    vi.stubGlobal('EventSource', eventSourceGuard);
    effects = [
        fetchGuard,
        webSocketGuard,
        eventSourceGuard,
        vi.spyOn(net, 'createServer').mockImplementation(forbidden),
        vi.spyOn(net, 'createConnection').mockImplementation(forbidden),
        vi.spyOn(net, 'connect').mockImplementation(forbidden),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(forbidden),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(forbidden),
        vi.spyOn(http, 'createServer').mockImplementation(forbidden),
        vi.spyOn(http, 'request').mockImplementation(forbidden),
        vi.spyOn(http, 'get').mockImplementation(forbidden),
        vi.spyOn(https, 'createServer').mockImplementation(forbidden),
        vi.spyOn(https, 'request').mockImplementation(forbidden),
        vi.spyOn(https, 'get').mockImplementation(forbidden),
        vi.spyOn(http2, 'createServer').mockImplementation(forbidden),
        vi.spyOn(http2, 'createSecureServer').mockImplementation(forbidden),
        vi.spyOn(http2, 'connect').mockImplementation(forbidden),
        vi.spyOn(tls, 'createServer').mockImplementation(forbidden),
        vi.spyOn(tls, 'connect').mockImplementation(forbidden),
        vi.spyOn(dgram, 'createSocket').mockImplementation(forbidden),
        vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(forbidden),
        vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(forbidden),
        vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(forbidden),
        vi.spyOn(process, 'dlopen').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawn').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawnSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'exec').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFile').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFileSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'fork').mockImplementation(forbidden),
    ];
    ({ EventPollBuffer } = await import('../../src/v12-runtime/event-poll-buffer'));
    ({ PollCoordinator } = await import('../../src/v12-runtime/poll-transaction'));
});

afterEach(() => {
    const calls = effects.map((effect) => effect.mock.calls.length);
    const timers = vi.getTimerCount();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    expect(calls).toEqual(calls.map(() => 0));
    expect(timers).toBe(0);
});

const config = {
    capacity: 8,
    maxQueueBytes: 4096,
    maxEventBytes: 2048,
    maxWaiters: 4,
    maxTimeoutMs: 1000,
};

class MemorySink extends EventEmitter implements PollSink {
    headCalls = 0;
    endCalls = 0;
    body: string | undefined;

    constructor(private readonly onOpen: () => void = () => {}) {
        super();
    }

    isOpen(): boolean {
        this.onOpen();
        return true;
    }

    writeHead(): void {
        this.headCalls++;
    }

    end(body: string): void {
        this.endCalls++;
        this.body = body;
        this.emit('finish');
    }
}

type FinalGuardEffect = 'false' | 'throw' | 'cancel-false' | 'cancel-throw';

async function exerciseFinalGuard(effect: FinalGuardEffect): Promise<void> {
    const queue = new EventPollBuffer(config, 'drop-oldest');
    const event = { type: 'message', id: 'fixture-event', time: 12.5, text: 'retained' };
    const echo = 'retry-😺-"quoted"';
    const source = Object.freeze({});
    const currentSource = source;
    const epochValid = vi.fn(() => currentSource === source);
    const coordinator = new PollCoordinator(
        queue,
        config.maxQueueBytes,
        () => 0,
        epochValid,
        'legacy',
        'event-time',
    );
    const reserve = vi.spyOn(queue, 'reserve');
    const commit = vi.spyOn(queue, 'commit');
    const release = vi.spyOn(queue, 'release');
    let ready = true;
    let changedAfterFirstGuard = false;
    let tx: PollTransaction;
    const trace: string[] = [];
    const listenerGuard = vi.fn(() => {
        if (ready) {
            trace.push('guard:ready');
            return true;
        }

        trace.push('guard:not-ready');

        if (effect === 'cancel-false' || effect === 'cancel-throw') {
            tx.cancel();
        }

        if (effect === 'throw' || effect === 'cancel-throw') {
            throw new Error('synthetic final listener failure');
        }

        return false;
    });
    const sink = new MemorySink(() => {
        // This is the sink recheck after the first successful listener guard.
        // The sink stays writable and does not change the source or owner.
        if (!changedAfterFirstGuard && listenerGuard.mock.calls.length > 0) {
            trace.push('sink:readiness-lost');
            changedAfterFirstGuard = true;
            ready = false;
        }
    });
    const request = {
        limit: 1,
        timeoutMs: 0,
        maxOutputBytes: 4096,
        responseDeadline: 1000,
        echo,
    };
    tx = coordinator.create(request, sink, listenerGuard);

    try {
        expect(queue.enqueue(event)).toBe('accepted');
        const outcome = await tx.run();
        const reason =
            effect === 'cancel-false' || effect === 'cancel-throw' ? 'cancelled' : 'epoch_invalid';

        expect(outcome).toEqual({ kind: reason });
        expect(trace).toEqual(['guard:ready', 'sink:readiness-lost', 'guard:not-ready']);
        expect(listenerGuard).toHaveBeenCalledTimes(2);
        expect(changedAfterFirstGuard).toBe(true);
        expect(currentSource).toBe(source);
        expect(epochValid).toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        expect(reserve).toHaveBeenCalledOnce();
        const selected = await reserve.mock.results[0]!.value;
        expect(selected.status).toBe('reserved');

        if (selected.status !== 'reserved') {
            throw new Error('expected the original reservation');
        }

        expect(release).toHaveBeenCalledExactlyOnceWith(selected.token);
        expect(release.mock.results[0]!.value).toBe(true);
        expect(queue.stats()).toMatchObject({ count: 1, reserved: 0, waiters: 0 });
        expect(sink.headCalls).toBe(0);
        expect(sink.endCalls).toBe(0);
        expect(sink.body).toBeUndefined();
        expect(Reflect.get(tx, 'listenerGuard')).toBeUndefined();
        expect(Reflect.get(tx, 'state')).toBe('terminal');
        expect(sink.listenerCount('close')).toBe(0);
        expect(sink.listenerCount('error')).toBe(0);
        expect(sink.listenerCount('finish')).toBe(0);

        // A later valid poll observes the same event exactly once, with its echo.
        const retrySink = new MemorySink();
        const retry = coordinator.create(request, retrySink, () => true);
        expect(await retry.run()).toEqual({ kind: 'local_finish', response: 'events' });
        expect(retrySink.headCalls).toBe(1);
        expect(retrySink.endCalls).toBe(1);
        expect(JSON.parse(retrySink.body!)).toEqual({
            status: 'ok',
            retcode: 0,
            data: [event],
            message: '',
            echo,
        });
        expect(queue.stats()).toMatchObject({ count: 0, reserved: 0, waiters: 0 });
        expect(commit).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
        expect(Reflect.get(retry, 'listenerGuard')).toBeUndefined();
        expect((Reflect.get(coordinator, 'transactions') as Set<unknown>).size).toBe(0);
    } finally {
        tx.cancel();
        coordinator.close();
        queue.close();
    }
}

describe('final listener recheck after reentrant sink sampling', () => {
    it('rechecks listener readiness after the sink changes it and releases the real selection', async () => {
        await exerciseFinalGuard('false');
    });

    it.each(['throw', 'cancel-false', 'cancel-throw'] as const)(
        'preserves the first stop reason when the final listener guard does %s',
        async (effect) => {
            await exerciseFinalGuard(effect);
        },
    );
});

// The final listener guard is a trusted synchronous dependency. A guard that
// returns stale true after it has itself invalidated the listener is outside this
// fixture's claim; a boolean result is not an independent listener witness.
