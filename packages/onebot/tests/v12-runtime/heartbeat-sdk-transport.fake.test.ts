import { EventEmitter } from 'node:events';
import http, { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep unrelated exports available while making both HTTP server entry points fail closed.
vi.mock('node:http', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:http')>();
    const defaultExport = (actual as unknown as { default?: Record<string, unknown> }).default;

    const blocked = () => {
        throw new Error('unexpected HTTP server creation in memory fixture');
    };

    return {
        ...actual,
        createServer: blocked,
        default: { ...(defaultExport ?? actual), createServer: blocked },
    };
});

// The shared adapter barrel also imports Node's unprefixed HTTP specifier.
vi.mock('http', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:http')>();
    const defaultExport = (actual as unknown as { default?: Record<string, unknown> }).default;

    const blocked = () => {
        throw new Error('unexpected HTTP server creation in memory fixture');
    };

    return {
        ...actual,
        createServer: blocked,
        default: { ...(defaultExport ?? actual), createServer: blocked },
    };
});

// Block the socket-producing net helpers as an additional guard; isIP remains real.
vi.mock('node:net', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:net')>();
    const defaultExport = (actual as unknown as { default?: Record<string, unknown> }).default;

    const blocked = () => {
        throw new Error('unexpected net operation in memory fixture');
    };

    return {
        ...actual,
        connect: blocked,
        createConnection: blocked,
        createServer: blocked,
        default: {
            ...(defaultExport ?? actual),
            connect: blocked,
            createConnection: blocked,
            createServer: blocked,
        },
    };
});

// No native WebSocket implementation is loaded. The server pairs only the
// browser object carried by the exact fake duplex supplied to handleUpgrade.
vi.mock('@snowluma/websocket', () => ({
    WebSocket: class {
        constructor() {
            throw new Error('unexpected outgoing WebSocket in memory fixture');
        }
    },
    WebSocketServer: class {
        handleUpgrade(
            request: IncomingMessage,
            socket: MemoryDuplex,
            head: Buffer,
            callback: (peer: MemoryServerPeer) => void,
        ): void {
            upgrades.push({ request, socket, headLength: head.length });

            if (head.length !== 0) {
                throw new Error('fixture does not accept upgrade head bytes');
            }

            const peer = new MemoryServerPeer(socket.browser);
            socket.browser.peer = peer;
            callback(peer);
        }

        destroy(): void {}
    },
}));

// The OneBot package has no SDK dependency. This is the real source of the
// @harehane/sdk/v12 public entry, as in the existing cross-package tests.
import { OneBot12WebSocketClient, type OneBot12Event } from '../../../sdk/src/v12/index';
import { assertValidOneBotConfig, makeDefaultOneBotConfig } from '../../src/config';
import type { OneBotConfig } from '../../src/types';
import { V12Transport } from '../../src/v12-network';
import { V12Runtime } from '../../src/v12-runtime/runtime';

const START_MS = 1_700_000_000_125;
const INTERVAL_MS = 1_500;
const TOKEN = 'fixture-token-0123456789-abcdefghijklmnopqrstuvwxyz';

class MemoryBrowserWebSocket extends EventTarget {
    static instances: MemoryBrowserWebSocket[] = [];
    readonly bufferedAmount = 0;
    readonly incoming: string[] = [];
    readonly history: string[] = [];
    readonly sent: string[] = [];
    readyState = 0;
    peer: MemoryServerPeer | undefined;

    constructor(readonly url: string) {
        super();
        MemoryBrowserWebSocket.instances.push(this);
    }

    open(): void {
        if (this.readyState !== 0) {
            throw new Error('fixture browser already opened');
        }

        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
    }

    send(text: string): void {
        if (this.readyState !== 1 || !this.peer) {
            throw new Error('fixture browser is not paired');
        }

        this.sent.push(text);
        this.peer.emit('message', Buffer.from(text), false);
    }

    enqueue(text: string): void {
        this.history.push(text);
        this.incoming.push(text);
    }

    // Deliberately dispatch even after close: the real SDK must reject a stale
    // old-socket event rather than relying on this fake to discard it.
    deliver(text: string): void {
        this.dispatchEvent(new MessageEvent('message', { data: text }));
    }

    flush(): void {
        while (this.incoming.length > 0) {
            this.deliver(this.incoming.shift()!);
        }
    }

    close(): void {
        if (this.readyState === 3) {
            return;
        }

        this.readyState = 3;
        this.peer?.browserClosed();
        this.dispatchEvent(new Event('close'));
    }

    serverClosed(): void {
        if (this.readyState === 3) {
            return;
        }

        this.readyState = 3;
        this.dispatchEvent(new Event('close'));
    }
}

class MemoryServerPeer extends EventEmitter {
    private closed = false;

    constructor(private readonly browser: MemoryBrowserWebSocket) {
        super();
    }

    send(text: string, callback?: (error?: Error) => void): void {
        if (this.closed) {
            throw new Error('fixture peer closed');
        }

        this.browser.enqueue(text);
        callback?.();
    }

    browserClosed(): void {
        if (!this.closed) {
            this.closed = true;
            this.emit('close');
        }
    }

    terminate(): void {
        if (!this.closed) {
            this.closed = true;
            this.emit('close');
            this.browser.serverClosed();
        }
    }
}

class MemoryDuplex {
    destroyed = false;
    rejection: string | undefined;

    constructor(readonly browser: MemoryBrowserWebSocket) {}

    end(text: string): this {
        this.rejection = text;
        return this;
    }

    destroy(): this {
        this.destroyed = true;
        return this;
    }
}

const upgrades: Array<{ request: IncomingMessage; socket: MemoryDuplex; headLength: number }> = [];
const openedTransports: V12Transport[] = [];
const runtimes: V12Runtime[] = [];
const clients: OneBot12WebSocketClient[] = [];

function newRuntime(heartbeat?: { enabled: boolean; interval: number }) {
    let online = true;
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
            port: 12345,
            accessToken: TOKEN,
            allowNonLoopback: false,
            ...(heartbeat === undefined ? {} : { heartbeat }),
        },
        {
            uin: '10001',
            api: api as never,
            buildLifecycleEvent: () => ({}),
            buildHeartbeatEvent: () => ({}),
        },
        {
            getStatus: () => ({ good: online, online }),
            getSentMessageTime: async () => null,
            trackAction: (_label, start) => start(),
            canAccept: () => true,
        },
    );
    runtimes.push(runtime);
    return {
        runtime,
        api,
        setOnline(value: boolean): void {
            online = value;
            runtime.statusUpdate();
        },
    };
}

function newClient() {
    const client = new OneBot12WebSocketClient({
        url: 'ws://fixture.invalid/',
        accessToken: TOKEN,
        tokenTransport: 'query',
        webSocket: MemoryBrowserWebSocket as unknown as typeof WebSocket,
        requestTimeoutMs: 0,
    });
    clients.push(client);
    const events: OneBot12Event[] = [];
    const mirror: OneBot12Event[] = [];
    const errors: string[] = [];
    // SDK subscriptions exist before the real transport invokes subscribeStatus.
    client.onEvent((event) => {
        events.push(event);
    });
    client.onEvent((event) => {
        mirror.push(event);
    });
    client.onError((error) => {
        errors.push(error.code);
    });
    return { client, events, mirror, errors };
}

async function connectClient(client: OneBot12WebSocketClient, transport: V12Transport) {
    const count = MemoryBrowserWebSocket.instances.length;
    const opening = client.connect();
    expect(MemoryBrowserWebSocket.instances).toHaveLength(count + 1);
    const browser = MemoryBrowserWebSocket.instances[count];
    const url = new URL(browser.url);
    const request = { url: `${url.pathname}${url.search}`, rawHeaders: [] };
    const socket = new MemoryDuplex(browser);

    // SDK handlers are installed by connect(); allow open before delivering frames.
    browser.open();
    transport.handleUpgrade(
        request as unknown as IncomingMessage,
        socket as unknown as Duplex,
        Buffer.alloc(0),
    );
    expect(socket.destroyed).toBe(false);
    expect(socket.rejection).toBeUndefined();
    expect(browser.peer).toBeDefined();
    expect(upgrades.at(-1)).toMatchObject({ socket, headLength: 0 });
    await opening;
    return browser;
}

async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 16; i++) {
        await Promise.resolve();
    }
}

function details(events: OneBot12Event[]): string[] {
    return events.map((event) => event.detail_type);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    vi.spyOn(V12Transport.prototype, 'open').mockImplementation(function (this: V12Transport) {
        this.attach();
        openedTransports.push(this);
        return Promise.resolve({
            address: 'fixture.invalid',
            family: 'IPv4',
            port: 12345,
        } as AddressInfo);
    });
});

afterEach(async () => {
    try {
        for (const client of clients.splice(0)) {
            client.close();
        }

        for (const runtime of runtimes.splice(0)) {
            await runtime.close();
        }
    } finally {
        MemoryBrowserWebSocket.instances = [];
        openedTransports.length = 0;
        upgrades.length = 0;
        vi.restoreAllMocks();
        vi.clearAllTimers();
        vi.useRealTimers();
    }
});

describe('v12 heartbeat via real runtime, transport and SDK (memory only)', () => {
    it('blocks named and default HTTP server creation', () => {
        expect(() => createHttpServer()).toThrow('unexpected HTTP server creation');
        expect(() => http.createServer()).toThrow('unexpected HTTP server creation');
    });

    it('delivers bootstrap then shared heartbeats, including while offline', async () => {
        const f = newRuntime({ enabled: true, interval: INTERVAL_MS });
        await f.runtime.open();
        expect(openedTransports).toHaveLength(1);
        const first = newClient();
        const second = newClient();
        const a = await connectClient(first.client, openedTransports[0]);
        const b = await connectClient(second.client, openedTransports[0]);

        // accept() and subscribeStatus() produced the frames, not the fake.
        expect(first.events).toEqual([]);
        expect(second.events).toEqual([]);
        expect(a.incoming.map((text) => JSON.parse(text).detail_type)).toEqual([
            'connect',
            'status_update',
        ]);
        expect(b.incoming.map((text) => JSON.parse(text).detail_type)).toEqual([
            'connect',
            'status_update',
        ]);
        a.flush();
        b.flush();
        expect(details(first.events)).toEqual(['connect', 'status_update']);
        expect(details(second.events)).toEqual(['connect', 'status_update']);
        expect(first.events[0]).toMatchObject({
            type: 'meta',
            detail_type: 'connect',
            time: START_MS / 1000,
            version: { impl: 'jiyu', onebot_version: '12' },
        });
        expect(first.events[1]).toMatchObject({
            type: 'meta',
            detail_type: 'status_update',
            status: {
                good: true,
                bots: [{ self: { platform: 'qq', user_id: '10001' }, online: true }],
            },
        });

        vi.advanceTimersByTime(INTERVAL_MS - 1);
        a.flush();
        b.flush();
        expect(first.events).toHaveLength(2);
        expect(second.events).toHaveLength(2);
        vi.advanceTimersByTime(1);
        a.flush();
        b.flush();
        const heartbeat = first.events[2];
        expect(heartbeat).toMatchObject({
            type: 'meta',
            detail_type: 'heartbeat',
            sub_type: '',
            time: (START_MS + INTERVAL_MS) / 1000,
            interval: INTERVAL_MS,
        });
        expect(typeof heartbeat.id).toBe('string');
        expect(heartbeat.id.length).toBeGreaterThan(0);
        expect(Object.hasOwn(heartbeat, 'self')).toBe(false);
        expect(first.mirror[2].id).toBe(heartbeat.id);
        expect(second.events[2].id).toBe(heartbeat.id);
        expect(second.mirror[2].id).toBe(heartbeat.id);
        expect(second.events[2]).toEqual(heartbeat);

        f.setOnline(false);
        a.flush();
        b.flush();
        expect(first.events[3]).toMatchObject({
            detail_type: 'status_update',
            status: { good: false, bots: [{ online: false }] },
        });
        expect(second.events[3].id).toBe(first.events[3].id);
        vi.advanceTimersByTime(INTERVAL_MS);
        a.flush();
        b.flush();
        expect(first.events[4]).toMatchObject({
            detail_type: 'heartbeat',
            time: (START_MS + 2 * INTERVAL_MS) / 1000,
            interval: INTERVAL_MS,
        });
        expect(Object.hasOwn(first.events[4], 'self')).toBe(false);
        expect(first.events[4].id).not.toBe(heartbeat.id);
        expect(second.events[4].id).toBe(first.events[4].id);
        expect(first.errors).toEqual([]);
        expect(second.errors).toEqual([]);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it.each([undefined, { enabled: false, interval: INTERVAL_MS }])(
        'sends no heartbeat when configuration is %s',
        async (heartbeat) => {
            const f = newRuntime(heartbeat);
            await f.runtime.open();
            const receiver = newClient();
            const socket = await connectClient(receiver.client, openedTransports[0]);
            socket.flush();
            vi.advanceTimersByTime(5 * INTERVAL_MS);
            socket.flush();
            expect(details(receiver.events)).toEqual(['connect', 'status_update']);
            expect(receiver.errors).toEqual([]);
            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );

    it('does not replay heartbeats missed while the SDK is disconnected', async () => {
        const f = newRuntime({ enabled: true, interval: INTERVAL_MS });
        await f.runtime.open();
        const receiver = newClient();
        const old = await connectClient(receiver.client, openedTransports[0]);
        old.flush();
        vi.advanceTimersByTime(INTERVAL_MS);
        expect(old.incoming).toHaveLength(1);
        const stale = old.incoming[0];
        const oldHistoryCount = old.history.length;
        receiver.client.close();
        expect(receiver.client.isConnected).toBe(false);
        old.flush();
        expect(details(receiver.events)).toEqual(['connect', 'status_update']);
        vi.advanceTimersByTime(2 * INTERVAL_MS);
        expect(old.history).toHaveLength(oldHistoryCount);

        const current = await connectClient(receiver.client, openedTransports[0]);
        expect(current).not.toBe(old);
        expect(current.incoming).toHaveLength(2);
        current.flush();
        expect(details(receiver.events)).toEqual([
            'connect',
            'status_update',
            'connect',
            'status_update',
        ]);
        old.deliver(stale);
        expect(receiver.events).toHaveLength(4);
        vi.advanceTimersByTime(INTERVAL_MS);
        current.flush();
        expect(details(receiver.events)).toEqual([
            'connect',
            'status_update',
            'connect',
            'status_update',
            'heartbeat',
        ]);
        expect(receiver.events[4].time).toBe((START_MS + 4 * INTERVAL_MS) / 1000);
        expect(receiver.errors).toEqual([]);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('rejects old queued frames after runtime close and a new transport generation', async () => {
        const f = newRuntime({ enabled: true, interval: INTERVAL_MS });
        await f.runtime.open();
        const receiver = newClient();
        const old = await connectClient(receiver.client, openedTransports[0]);
        old.flush();
        vi.advanceTimersByTime(INTERVAL_MS);
        expect(old.incoming).toHaveLength(1);
        const stale = old.incoming[0];
        const oldHistoryCount = old.history.length;
        await f.runtime.close();
        expect(receiver.client.isConnected).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        old.flush();
        vi.advanceTimersByTime(2 * INTERVAL_MS);
        expect(old.history).toHaveLength(oldHistoryCount);
        expect(receiver.events).toHaveLength(2);

        await f.runtime.open();
        expect(openedTransports).toHaveLength(2);
        expect(openedTransports[1]).not.toBe(openedTransports[0]);
        const current = await connectClient(receiver.client, openedTransports[1]);
        current.flush();
        expect(details(receiver.events)).toEqual([
            'connect',
            'status_update',
            'connect',
            'status_update',
        ]);
        old.deliver(stale);
        expect(receiver.events).toHaveLength(4);
        vi.advanceTimersByTime(INTERVAL_MS);
        current.flush();
        expect(receiver.events[4]).toMatchObject({
            detail_type: 'heartbeat',
            time: (START_MS + 4 * INTERVAL_MS) / 1000,
            interval: INTERVAL_MS,
        });
        expect(Object.hasOwn(receiver.events[4], 'self')).toBe(false);
        expect(receiver.errors).toEqual([]);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('rejects an invalid SDK action through the real dispatcher before the fake API', async () => {
        const f = newRuntime({ enabled: true, interval: INTERVAL_MS });
        await f.runtime.open();
        const receiver = newClient();
        const socket = await connectClient(receiver.client, openedTransports[0]);
        socket.flush();
        const response = receiver.client.request('send_message', {
            detail_type: 'private',
            user_id: '0',
            message: 'invalid target fixture',
        });
        await flushMicrotasks();
        expect(socket.incoming).toHaveLength(1);
        socket.flush();
        await expect(response).resolves.toMatchObject({ status: 'failed', retcode: 10003 });
        expect(socket.sent).toHaveLength(1);
        expect(f.api.handle).not.toHaveBeenCalled();
        expect(receiver.errors).toEqual([]);
    });

    it.each([
        null,
        {},
        { enabled: true, interval: 0 },
        { enabled: false, interval: 0 },
        { enabled: true, interval: -1 },
        { enabled: true, interval: 1.5 },
        { enabled: true, interval: Number.NaN },
        { enabled: true, interval: Number.POSITIVE_INFINITY },
        { enabled: true, interval: 2_147_483_648 },
        { enabled: true, interval: '1500' },
        { enabled: 'yes', interval: 1500 },
        { enabled: true, interval: 1500, extra: true },
    ])('rejects malformed heartbeat configuration %j without opening a transport', (heartbeat) => {
        const candidate = makeDefaultOneBotConfig();
        candidate.networks = { httpServers: [], httpClients: [], wsServers: [], wsClients: [] };
        candidate.v12 = {
            enabled: false,
            host: '127.0.0.1',
            port: 12345,
            accessToken: '',
            allowNonLoopback: false,
            heartbeat,
        } as unknown as OneBotConfig['v12'];
        expect(() => assertValidOneBotConfig(candidate)).toThrow(/v12\.heartbeat/);
        expect(openedTransports).toHaveLength(0);
        expect(upgrades).toHaveLength(0);
    });
});
