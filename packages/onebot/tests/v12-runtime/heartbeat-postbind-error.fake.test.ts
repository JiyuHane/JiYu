import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Neither mock imports or constructs Node's HTTP server. Both specifiers are
// used by the real runtime's import graph; their servers exist only in memory.
vi.mock('node:http', () => {
    const createServer = () => makeMemoryServer();
    return { createServer, default: { createServer } };
});

vi.mock('http', () => {
    const createServer = () => makeMemoryServer();
    return { createServer, default: { createServer } };
});

vi.mock('@snowluma/websocket', () => ({
    WebSocket: class {
        constructor() {
            throw new Error('unexpected outgoing WebSocket in memory fixture');
        }
    },
    WebSocketServer: class {
        destroyed = false;

        constructor(readonly options: { noServer: boolean; maxPayload: number }) {
            webSocketServers.push(this);
        }

        handleUpgrade(): never {
            throw new Error('unexpected upgrade in memory fixture');
        }

        destroy(): void {
            this.destroyed = true;
        }
    },
}));

import { V12Transport } from '../../src/v12-network';
import { V12Runtime } from '../../src/v12-runtime/runtime';

const START_MS = 1_700_000_000_000;
const INTERVAL_MS = 25;
const SERVER_SECRET = 'private server error fixture';
const PEER_SECRET = 'private peer termination fixture';
const CALLBACK_SECRET = 'private error callback fixture';

class MemoryHttpServer extends EventEmitter {
    headersTimeout = 0;
    requestTimeout = 0;
    bindCalls: Array<{ port: number; host: string }> = [];
    closeCalls = 0;
    closed = false;

    // This method invokes its callback synchronously and creates no OS handle.
    listen(port: number, host: string, ready: () => void): this {
        this.bindCalls.push({ port, host });
        ready();
        return this;
    }

    address() {
        return { address: 'memory-only', family: 'IPv4', port: 23456 };
    }

    close(callback: (error?: Error) => void): this {
        this.closeCalls++;
        this.closed = true;
        callback();
        return this;
    }
}

const servers: MemoryHttpServer[] = [];
const webSocketServers: Array<{ destroyed: boolean }> = [];
const runtimes: V12Runtime[] = [];
const peers: MemoryPeer[] = [];

function makeMemoryServer(): MemoryHttpServer {
    const server = new MemoryHttpServer();
    servers.push(server);
    return server;
}

class MemoryPeer extends EventEmitter {
    readonly frames: Array<Record<string, unknown>> = [];
    terminationCalls = 0;
    throwOnTerminate = false;
    closed = false;

    send(text: string, callback?: (error?: Error) => void): void {
        this.frames.push(JSON.parse(text) as Record<string, unknown>);
        callback?.();
    }

    terminate(): void {
        this.terminationCalls++;

        if (this.throwOnTerminate) {
            this.throwOnTerminate = false;
            throw new Error(PEER_SECRET);
        }

        this.closed = true;
        this.emit('close');
    }
}

type TransportInternals = {
    accept(peer: MemoryPeer): void;
    quiesced: boolean;
    options: { onError(error: Error): void };
};

type RuntimeInternals = { transport: V12Transport | null };

function details(peer: MemoryPeer): unknown[] {
    return peer.frames.map((frame) => frame.detail_type);
}

async function fixture() {
    const api = {
        handle: vi.fn(async () => {
            throw new Error('unexpected fixture API call');
        }),
    };
    const runtime = new V12Runtime(
        {
            name: 'OneBot v12',
            enabled: true,
            host: '127.0.0.1',
            port: 23456,
            accessToken: '',
            allowNonLoopback: false,
            heartbeat: { enabled: true, interval: INTERVAL_MS },
        },
        {
            uin: '10001',
            api: api as never,
            buildLifecycleEvent: () => ({}),
            buildHeartbeatEvent: () => ({}),
        },
        {
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: async () => null,
            trackAction: (_label, start) => start(),
            canAccept: () => true,
        },
    );
    runtimes.push(runtime);
    await runtime.open();
    expect(servers).toHaveLength(1);
    expect(webSocketServers).toHaveLength(1);
    const server = servers[0];
    const transport = (runtime as unknown as RuntimeInternals).transport;
    expect(transport).toBeInstanceOf(V12Transport);

    if (!transport) {
        throw new Error('real transport was not retained');
    }

    const internal = transport as unknown as TransportInternals;

    const connect = () => {
        const peer = new MemoryPeer();
        peers.push(peer);
        internal.accept(peer);
        return peer;
    };

    return { runtime, transport, internal, server, api, connect };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
});

afterEach(async () => {
    try {
        for (const peer of peers) {
            peer.throwOnTerminate = false;
        }

        for (const runtime of runtimes.splice(0)) {
            await runtime.close();
        }

        expect(vi.getTimerCount()).toBe(0);
    } finally {
        vi.clearAllTimers();
        vi.restoreAllMocks();
        vi.useRealTimers();
        servers.length = 0;
        webSocketServers.length = 0;
        peers.length = 0;
    }
});

describe('v12 post-bind listener failure with heartbeat (memory only)', () => {
    it('notifies the runtime after partial quiesce throws and retains transport for close retry', async () => {
        const timers = vi.spyOn(globalThis, 'setInterval');
        const f = await fixture();
        const notify = vi.spyOn(f.internal.options, 'onError');
        const first = f.connect();
        const remaining = f.connect();
        first.throwOnTerminate = true;
        remaining.throwOnTerminate = true;
        expect(f.server.bindCalls).toEqual([{ port: 23456, host: '127.0.0.1' }]);
        expect(f.server.listenerCount('error')).toBe(1);
        expect(f.runtime.isActive).toBe(true);
        expect(vi.getTimerCount()).toBe(1);
        expect(details(first)).toEqual(['connect', 'status_update']);
        expect(details(remaining)).toEqual(['connect', 'status_update']);
        const staleTick = timers.mock.calls.find((call) => call[1] === INTERVAL_MS)?.[0];
        expect(typeof staleTick).toBe('function');
        vi.advanceTimersByTime(INTERVAL_MS);
        expect(details(first)).toEqual(['connect', 'status_update', 'heartbeat']);
        expect(details(remaining)).toEqual(['connect', 'status_update', 'heartbeat']);

        expect(() => f.server.emit('error', new Error(SERVER_SECRET))).not.toThrow();
        expect(first.terminationCalls).toBe(1);
        expect(remaining.terminationCalls).toBe(0);
        expect((f.runtime as unknown as { subscribers: Set<unknown> }).subscribers.size).toBe(1);
        expect(f.internal.quiesced).toBe(true);
        expect(notify).toHaveBeenCalledOnce();
        expect(notify.mock.calls[0][0].message).toBe('v12 listener failure');
        expect(f.runtime.isActive).toBe(false);
        expect(f.runtime.hasApplyFailure).toBe(true);
        const status = f.runtime.describeManagedStatus();
        expect(status).toMatchObject({ status: 'degraded', lastError: 'v12 operation failed' });
        expect(JSON.stringify(status)).not.toContain(SERVER_SECRET);
        expect(JSON.stringify(status)).not.toContain(PEER_SECRET);
        expect(vi.getTimerCount()).toBe(0);
        expect((f.runtime as unknown as RuntimeInternals).transport).toBe(f.transport);
        expect(f.server.closed).toBe(false);
        expect(webSocketServers[0].destroyed).toBe(false);

        // The second peer is still subscribed after the first peer throws, so
        // silence proves runtime revocation rather than merely peer disposal.
        const before = remaining.frames.length;
        (staleTick as () => void)();
        f.runtime.statusUpdate();
        vi.advanceTimersByTime(5 * INTERVAL_MS);
        expect(remaining.frames).toHaveLength(before);
        expect(remaining.terminationCalls).toBe(0);
        expect(first.frames).toHaveLength(3);
        await expect(f.runtime.open()).rejects.toThrow('v12 listener has not been released');

        // A further partial failure must keep the same transport for another
        // close; successful retry closes the fake server and destroys fake WSS.
        await expect(f.runtime.close()).rejects.toThrow(PEER_SECRET);
        expect(remaining.terminationCalls).toBe(1);
        expect((f.runtime as unknown as RuntimeInternals).transport).toBe(f.transport);
        expect(f.server.closeCalls).toBe(0);
        await expect(f.runtime.close()).resolves.toBeUndefined();
        expect((f.runtime as unknown as RuntimeInternals).transport).toBeNull();
        expect(f.server.closed).toBe(true);
        expect(f.server.closeCalls).toBe(1);
        expect(webSocketServers[0].destroyed).toBe(true);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        'swallows an onError callback throw when partial quiesce throws=%s',
        async (quiesceThrows) => {
            const f = await fixture();
            const peer = f.connect();
            peer.throwOnTerminate = quiesceThrows;
            const original = f.internal.options.onError;
            const notify = vi.spyOn(f.internal.options, 'onError').mockImplementation((error) => {
                original(error);
                throw new Error(CALLBACK_SECRET);
            });
            vi.advanceTimersByTime(INTERVAL_MS);
            expect(details(peer)).toEqual(['connect', 'status_update', 'heartbeat']);
            expect(() => f.server.emit('error', new Error(SERVER_SECRET))).not.toThrow();
            expect(peer.terminationCalls).toBe(1);
            expect(notify).toHaveBeenCalledOnce();
            expect(notify.mock.calls[0][0].message).toBe('v12 listener failure');
            expect(notify.mock.results[0].type).toBe('throw');
            expect(f.runtime.isActive).toBe(false);
            expect(f.runtime.describeManagedStatus()).toMatchObject({
                status: 'degraded',
                lastError: 'v12 operation failed',
            });
            expect(vi.getTimerCount()).toBe(0);
            vi.advanceTimersByTime(5 * INTERVAL_MS);
            expect(details(peer)).toEqual(['connect', 'status_update', 'heartbeat']);
            expect(f.api.handle).not.toHaveBeenCalled();
            await expect(f.runtime.close()).resolves.toBeUndefined();
            expect(f.server.closeCalls).toBe(1);
        },
    );
});
