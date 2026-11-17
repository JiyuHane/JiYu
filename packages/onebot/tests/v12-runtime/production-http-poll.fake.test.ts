import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchPayload } from '../../src/event-filter';
import type { JsonObject, NetworkBase } from '../../src/types';
import type { V12Transport, V12TransportOptions } from '../../src/v12-network';
import type { V12Runtime } from '../../src/v12-runtime/runtime';
import type { V12Source } from '../../src/v12-runtime/source-generation';

type CapturedTransport = { options: V12TransportOptions; instance: V12Transport };

// Only open() is replaced: the real transport's attach(), HTTP request handling,
// response sink and WS fanout run in memory. The capability is constructed by the
// real V12Runtime; this fixture never supplies a capability or activates an owner.
const fake = vi.hoisted(() => ({
    transports: [] as CapturedTransport[],
    pendingPeer: null as FakePeer | null,
    violations: [] as string[],
    noServerConstructed: 0,
}));

// Block the named import as well as guarding the default export below. Even an
// accidental call through the original transport's open() cannot create a server.
vi.mock('node:http', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:http')>();
    return {
        ...actual,
        createServer: () => {
            fake.violations.push('node:http named createServer');
            throw new Error('unexpected HTTP server creation');
        },
    };
});

vi.mock('@snowluma/websocket', () => ({
    WebSocket: class {
        constructor() {
            fake.violations.push('WebSocket constructor');
            throw new Error('unexpected WebSocket construction');
        }
    },
    WebSocketServer: class {
        constructor(options: { noServer?: boolean }) {
            if (options?.noServer !== true) {
                fake.violations.push('WebSocketServer listener');
                throw new Error('unexpected WebSocket listener');
            }

            fake.noServerConstructed++;
        }

        handleUpgrade(
            _req: unknown,
            _socket: unknown,
            _head: unknown,
            accept: (ws: unknown) => void,
        ) {
            if (!fake.pendingPeer) {
                fake.violations.push('unexpected fake upgrade');
                throw new Error('no synthetic peer supplied');
            }

            accept(fake.pendingPeer);
        }

        destroy() {}
    },
}));

// Keep expected runtime diagnostics in memory rather than writing logs.
vi.mock('@snowluma/common/logger', () => {
    type NullLogger = {
        child: () => NullLogger;
        trace: () => void;
        debug: () => void;
        info: () => void;
        success: () => void;
        warn: () => void;
        error: () => void;
    };
    const logger: NullLogger = {
        child: () => logger,
        trace: () => {},
        debug: () => {},
        info: () => {},
        success: () => {},
        warn: () => {},
        error: () => {},
    };
    return { createLogger: () => logger };
});

vi.mock('@snowluma/sqlite', () => ({
    SqliteDatabase: class {
        constructor() {
            fake.violations.push('SQLite constructor');
            throw new Error('unexpected SQLite construction');
        }
    },
}));

// Avoid importing the unrelated v11 network adapters into this fixture.
vi.mock('../../src/network', async () => ({
    IOneBotNetworkAdapter: (await import('../../src/network/adapter')).IOneBotNetworkAdapter,
}));

vi.mock('../../src/v12-network', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/v12-network')>();

    class NoListenTransport extends actual.V12Transport {
        constructor(options: V12TransportOptions) {
            super(options);
            fake.transports.push({ options, instance: this });
        }

        override async open(): Promise<AddressInfo> {
            this.attach();
            return { address: 'fixture', family: 'IPv4', port: 1 };
        }
    }

    return { ...actual, V12Transport: NoListenTransport };
});

let runtimeApi: typeof import('../../src/v12-runtime/runtime');
let sourceApi: typeof import('../../src/v12-runtime/source-generation');
let ownerApi: typeof import('../../src/v12-runtime/poll-owner');
let managerApi: typeof import('../../src/network/network-manager');
let adapterApi: typeof import('../../src/network/adapter');
let identityApi: typeof import('../../src/v12-runtime/identity');
let guards: Array<{ mock: { calls: unknown[] } }>;
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;

const fixtures: Array<{
    manager: import('../../src/network/network-manager').OneBotNetworkManager;
    apiCalls: ReturnType<typeof vi.fn>;
    sentTimeCalls: ReturnType<typeof vi.fn>;
}> = [];
const TOKEN = 'synthetic-token';

function forbidden(): never {
    throw new Error('unexpected network, native, account or plugin operation');
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    vi.stubEnv('SNOWLUMA_LOG_FILE', '0');
    fake.transports.length = 0;
    fake.pendingPeer = null;
    fake.violations.length = 0;
    fake.noServerConstructed = 0;
    fixtures.length = 0;
    fetchGuard = vi.fn(forbidden);
    webSocketGuard = vi.fn(function ForbiddenWebSocket() {
        return forbidden();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    guards = [
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
        vi.spyOn(process, 'emitWarning').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawn').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawnSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'exec').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFile').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFileSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'fork').mockImplementation(forbidden),
        vi.spyOn(fs, 'createWriteStream').mockImplementation(forbidden),
        vi.spyOn(fs, 'writeFile').mockImplementation(forbidden),
        vi.spyOn(fs, 'writeFileSync').mockImplementation(forbidden),
        vi.spyOn(fs, 'appendFile').mockImplementation(forbidden),
        vi.spyOn(fs, 'appendFileSync').mockImplementation(forbidden),
        vi.spyOn(fs, 'mkdir').mockImplementation(forbidden),
        vi.spyOn(fs, 'mkdirSync').mockImplementation(forbidden),
        vi.spyOn(fs, 'unlink').mockImplementation(forbidden),
        vi.spyOn(fs, 'unlinkSync').mockImplementation(forbidden),
        vi.spyOn(fs, 'rename').mockImplementation(forbidden),
        vi.spyOn(fs, 'renameSync').mockImplementation(forbidden),
        vi.spyOn(fs, 'rm').mockImplementation(forbidden),
        vi.spyOn(fs, 'rmSync').mockImplementation(forbidden),
        vi.spyOn(fs.promises, 'writeFile').mockImplementation(forbidden),
        vi.spyOn(fs.promises, 'appendFile').mockImplementation(forbidden),
        vi.spyOn(fs.promises, 'mkdir').mockImplementation(forbidden),
        vi.spyOn(fs.promises, 'unlink').mockImplementation(forbidden),
        vi.spyOn(fs.promises, 'rename').mockImplementation(forbidden),
        vi.spyOn(fs.promises, 'rm').mockImplementation(forbidden),
    ];

    // Imports occur after the network/native guards are armed.
    sourceApi = await import('../../src/v12-runtime/source-generation');
    ownerApi = await import('../../src/v12-runtime/poll-owner');
    adapterApi = await import('../../src/network/adapter');
    managerApi = await import('../../src/network/network-manager');
    identityApi = await import('../../src/v12-runtime/identity');
    runtimeApi = await import('../../src/v12-runtime/runtime');
});

afterEach(async () => {
    let cleanupFailed = false;
    const resources = fixtures.splice(0);

    try {
        for (const { manager } of resources) {
            try {
                const result = await manager.shutdown();
                cleanupFailed ||= !result.closed;
            } catch {
                cleanupFailed = true;
            }
        }

        await settle();
    } finally {
        const calls = guards.map((guard) => guard.mock.calls.length);
        const backendCalls = resources.flatMap(({ apiCalls, sentTimeCalls }) => [
            apiCalls.mock.calls.length,
            sentTimeCalls.mock.calls.length,
        ]);
        const fetchCalls = fetchGuard.mock.calls.length;
        const webSocketCalls = webSocketGuard.mock.calls.length;
        const violations = [...fake.violations];
        const timers = vi.getTimerCount();
        vi.clearAllTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.useRealTimers();
        expect(cleanupFailed).toBe(false);
        expect(calls).toEqual(calls.map(() => 0));
        expect(backendCalls).toEqual(backendCalls.map(() => 0));
        expect(fetchCalls).toBe(0);
        expect(webSocketCalls).toBe(0);
        expect(violations).toEqual([]);
        expect(timers).toBe(0);
    }
});

async function settle(): Promise<void> {
    for (let index = 0; index < 50; index++) {
        await Promise.resolve();
    }
}

class FakeRequest extends EventEmitter {
    url = '/';
    method = 'POST';
    headers: Record<string, string> = { 'content-type': 'application/json' };
    rawHeaders = ['Authorization', `Bearer ${TOKEN}`];
    pause(): void {}
}

class FakeResponse extends EventEmitter {
    headersSent = false;
    destroyed = false;
    writableEnded = false;
    writableFinished = false;
    finished = false;
    status = 0;
    writes = 0;
    bodies: string[] = [];

    setHeader(): void {}

    writeHead(status: number): this {
        this.writes++;
        this.status = status;
        this.headersSent = true;
        return this;
    }

    end(body: string): this {
        this.bodies.push(body);
        this.writableEnded = true;
        this.writableFinished = true;
        this.finished = true;
        this.emit('finish');
        return this;
    }

    destroy(): this {
        if (!this.destroyed) {
            this.destroyed = true;
            this.emit('close');
        }

        return this;
    }

    json(): WireResponse {
        expect(this.status).toBe(200);
        expect(this.writes).toBe(1);
        expect(this.bodies).toHaveLength(1);
        return JSON.parse(this.bodies[0]!) as WireResponse;
    }
}

class FakeUpgradeSocket extends EventEmitter {
    end(): void {
        fake.violations.push('synthetic upgrade rejected');
    }
    destroy(): void {
        fake.violations.push('synthetic upgrade destroyed');
    }
}

class FakePeer extends EventEmitter {
    readonly frames: unknown[] = [];
    terminated = false;

    send(text: string, callback: (error?: Error) => void): void {
        this.frames.push(JSON.parse(text) as unknown);
        callback();
    }

    terminate(): void {
        if (!this.terminated) {
            this.terminated = true;
            this.emit('close');
        }
    }

    _onData(): void {
        fake.violations.push('unexpected pipelined WebSocket data');
    }
}

type WireEvent = {
    id: string;
    time: number;
    type: string;
    detail_type: string;
    message_id: string;
    self: { platform: string; user_id: string };
};
type WireResponse = {
    status: 'ok' | 'failed';
    retcode: number;
    data: unknown;
    message: string;
    echo?: string;
};

function events(response: WireResponse): WireEvent[] {
    expect(response.status).toBe('ok');
    expect(response.retcode).toBe(0);
    expect(Array.isArray(response.data)).toBe(true);
    return response.data as WireEvent[];
}

function action(params: object = {}, extra: object = {}) {
    return { action: 'get_latest_events', params, ...extra };
}

function send(transport: V12Transport, input: object): FakeResponse {
    const request = new FakeRequest();
    const response = new FakeResponse();
    transport.handleRequest(
        request as unknown as IncomingMessage,
        response as unknown as ServerResponse,
    );
    request.emit('data', Buffer.from(JSON.stringify(input)));
    request.emit('end');
    return response;
}

async function response(transport: V12Transport, input: object): Promise<WireResponse> {
    const result = send(transport, input);
    await settle();
    return result.json();
}

function connect(transport: V12Transport): FakePeer {
    const peer = new FakePeer();
    const request = new FakeRequest();
    request.method = 'GET';
    const socket = new FakeUpgradeSocket();
    fake.pendingPeer = peer;

    try {
        transport.handleUpgrade(
            request as unknown as IncomingMessage,
            socket as unknown as Duplex,
            Buffer.alloc(0),
        );
    } finally {
        fake.pendingPeer = null;
    }

    expect(peer.frames).toMatchObject([
        { type: 'meta', detail_type: 'connect' },
        { type: 'meta', detail_type: 'status_update' },
    ]);
    return peer;
}

function peerMessages(peer: FakePeer): WireEvent[] {
    return (peer.frames as WireEvent[]).filter((event) => event.type === 'message');
}

function message(account: string, id: number, time: number): JsonObject {
    return {
        post_type: 'message',
        self_id: Number(account),
        user_id: 23456,
        message_id: id,
        time,
        message_type: 'private',
        sub_type: 'friend',
        raw_message: `fixture-${id}`,
        message: [{ type: 'text', data: { text: `fixture-${id}` } }],
    };
}

async function account(
    uin = '12345',
    options: {
        online?: boolean;
        noGate?: boolean;
        gate?: import('../../src/v12-runtime/poll-owner').PollGate;
    } = {},
) {
    const generation = new sourceApi.SourceGeneration();
    const manager = new managerApi.OneBotNetworkManager();
    const api = { handle: vi.fn(forbidden) };
    const sentTimeCalls = vi.fn(forbidden);
    let online = options.online ?? true;
    generation.setOnline(online);
    let runtime!: V12Runtime;
    runtime = new runtimeApi.V12Runtime(
        {
            name: identityApi.V12_ADAPTER_NAME,
            enabled: true,
            host: 'fixture.invalid',
            port: 1,
            accessToken: TOKEN,
            allowNonLoopback: false,
            messageFormat: 'array',
            reportSelfMessage: false,
        },
        {
            uin,
            api: api as never,
            buildLifecycleEvent: () => ({}),
            buildHeartbeatEvent: () => ({}),
        },
        {
            getStatus: () => ({ good: online, online }),
            getSentMessageTime: sentTimeCalls,
            trackAction: (_label, start) => start(),
            canAccept: () => true,
            captureCurrentSource: () => generation.capture(runtime[sourceApi.captureBinding]()),
            isSourceCurrent: (source: V12Source | undefined, binding: object | null) =>
                manager.get(identityApi.V12_ADAPTER_NAME) === runtime &&
                generation.isCurrent(source, binding),
            ...(options.noGate
                ? { pollGate: null }
                : options.gate
                  ? { pollGate: options.gate }
                  : {}),
        },
    );
    const legacy = new (class extends adapterApi.IOneBotNetworkAdapter<NetworkBase> {
        readonly received: JsonObject[] = [];

        constructor() {
            super(
                'synthetic-v11',
                {
                    name: 'synthetic-v11',
                    enabled: true,
                    messageFormat: 'array',
                    reportSelfMessage: false,
                },
                {
                    uin,
                    api: api as never,
                    buildLifecycleEvent: () => ({}),
                    buildHeartbeatEvent: () => ({}),
                },
            );
        }

        open(): void {
            this.isEnabled = true;
        }

        close(): void {
            this.isEnabled = false;
        }

        onEvent(event: JsonObject, _payload: DispatchPayload): void {
            this.received.push(event);
        }

        describeStatus() {
            return {
                name: this.name,
                kind: 'httpClient' as const,
                status: 'ok' as const,
                detail: 'fake',
            };
        }

        protected bindingSignature(config: NetworkBase): string {
            return config.name;
        }
    })();
    manager.register(runtime);
    manager.register(legacy);
    fixtures.push({ manager, apiCalls: api.handle, sentTimeCalls });
    legacy.open();
    let current!: CapturedTransport;

    async function open(): Promise<CapturedTransport> {
        const index = fake.transports.length;
        await runtime.open();
        expect(fake.transports).toHaveLength(index + 1);
        current = fake.transports[index]!;
        expect(current.options.httpPoll).toBeDefined();
        expect(current.instance.isAcceptingActions()).toBe(true);
        return current;
    }

    await open();

    const ticket = (): V12Source => {
        const value = generation.capture(runtime[sourceApi.captureBinding]());

        if (!value) {
            throw new Error('fixture source not online or listener not ready');
        }

        return value;
    };

    return {
        uin,
        runtime,
        manager,
        legacy,
        generation,
        api,
        open,
        ticket,
        current: () => current,
        setOnline(value: boolean) {
            online = value;
            generation.setOnline(value);
            runtime.statusUpdate();
        },
    };
}

describe('production V12 HTTP polling (real runtime, in-memory transport)', () => {
    it('requires a ready listener and online source; returns empty with the exact echo', async () => {
        const f = await account('12345', { online: false });
        const transport = f.current().instance;
        expect(f.runtime.isActive).toBe(true);
        expect(fake.noServerConstructed).toBe(1);
        expect(await response(transport, action({}, { echo: 'offline' }))).toEqual({
            status: 'failed',
            retcode: 20002,
            data: null,
            message: 'poll unavailable',
            echo: 'offline',
        });
        f.setOnline(true);
        await settle();
        const peer = connect(transport);
        f.runtime.statusUpdate();
        expect(peer.frames).toHaveLength(3);
        expect(await response(transport, action({}, { echo: '' }))).toEqual({
            status: 'ok',
            retcode: 0,
            data: [],
            message: '',
            echo: '',
        });
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('queues converted non-meta events before the first poll and stably sorts the selected batch', async () => {
        const f = await account();
        const transport = f.current().instance;
        const peer = connect(transport);
        const source = f.ticket();
        await f.manager.emitEvent(message(f.uin, 1, 30), source);
        await f.manager.emitEvent(message(f.uin, 2, 10), source);
        await f.manager.emitEvent(message(f.uin, 3, 10), source);
        const ws = peerMessages(peer);
        expect(ws.map((event) => event.message_id)).toEqual(['1', '2', '3']);
        expect(f.legacy.received).toHaveLength(3);
        const echo = 'batch-😺';
        const first = await response(transport, action({}, { echo }));
        expect(first).toMatchObject({ status: 'ok', retcode: 0, message: '', echo });
        const batch = events(first);
        expect(batch.map((event) => [event.message_id, event.time])).toEqual([
            ['2', 10],
            ['3', 10],
            ['1', 30],
        ]);
        expect(batch.map((event) => event.id)).toEqual([ws[1]!.id, ws[2]!.id, ws[0]!.id]);
        expect(
            batch.every((event) => event.type === 'message' && event.self.user_id === f.uin),
        ).toBe(true);
        expect(await response(transport, action())).toEqual({
            status: 'ok',
            retcode: 0,
            data: [],
            message: '',
        });
    });

    it('selects a FIFO prefix before sorting; separate batches are not globally time ordered', async () => {
        const f = await account();
        const transport = f.current().instance;
        const source = f.ticket();
        await f.manager.emitEvent(message(f.uin, 11, 30), source);
        await f.manager.emitEvent(message(f.uin, 12, 20), source);
        await f.manager.emitEvent(message(f.uin, 13, 1), source);
        const first = events(await response(transport, action({ limit: 2 })));
        const second = events(await response(transport, action()));
        expect(first.map((event) => [event.message_id, event.time])).toEqual([
            ['12', 20],
            ['11', 30],
        ]);
        expect(second.map((event) => [event.message_id, event.time])).toEqual([['13', 1]]);
    });

    it('returns [] on timeout and wakes a waiting HTTP poll when a later event arrives', async () => {
        const f = await account();
        const transport = f.current().instance;
        const timed = send(transport, action({ timeout: 1 }, { echo: 'timeout' }));
        await settle();
        expect(timed.bodies).toEqual([]);
        await vi.advanceTimersByTimeAsync(999);
        expect(timed.bodies).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        await settle();
        expect(timed.json()).toEqual({
            status: 'ok',
            retcode: 0,
            data: [],
            message: '',
            echo: 'timeout',
        });

        const waiting = send(transport, action({ timeout: 2 }, { echo: 'wake' }));
        await settle();
        expect(waiting.bodies).toEqual([]);
        await f.manager.emitEvent(message(f.uin, 21, 7), f.ticket());
        await settle();
        expect(waiting.json()).toMatchObject({ status: 'ok', retcode: 0, echo: 'wake' });
        expect(events(waiting.json()).map((event) => event.message_id)).toEqual(['21']);
        expect(events(await response(transport, action()))).toEqual([]);
    });

    it('revokes offline and closed source generations without mixing old tickets or queued events', async () => {
        const f = await account();
        const firstTransport = f.current().instance;
        const oldTicket = f.ticket();
        await f.manager.emitEvent(message(f.uin, 31, 1), oldTicket);
        f.setOnline(false);
        await settle();
        expect(await response(firstTransport, action({}, { echo: 'offline' }))).toMatchObject({
            status: 'failed',
            retcode: 20002,
            data: null,
            echo: 'offline',
        });
        f.setOnline(true);
        await settle();
        const currentTicket = f.ticket();
        expect(events(await response(firstTransport, action()))).toEqual([]);
        await f.manager.emitEvent(message(f.uin, 32, 2), oldTicket);
        await f.manager.emitEvent(message(f.uin, 33, 3), currentTicket);
        expect(
            events(await response(firstTransport, action())).map((event) => event.message_id),
        ).toEqual(['33']);

        const pending = send(firstTransport, action({ timeout: 5 }, { echo: 'closed' }));
        await settle();
        expect(pending.bodies).toEqual([]);
        await f.runtime.close();
        await settle();
        expect(pending.destroyed).toBe(true);
        expect(pending.bodies).toEqual([]);
        const closedResponse = send(firstTransport, action());
        expect(closedResponse.status).toBe(503);
        await f.open();
        await settle();
        const nextTransport = f.current().instance;
        expect(nextTransport).not.toBe(firstTransport);
        await f.manager.emitEvent(message(f.uin, 34, 4), currentTicket);
        await f.manager.emitEvent(message(f.uin, 35, 5), f.ticket());
        expect(
            events(await response(nextTransport, action())).map((event) => event.message_id),
        ).toEqual(['35']);
        expect(events(await response(nextTransport, action()))).toEqual([]);
        await f.manager.emitEvent(message(f.uin, 36, 6), f.ticket());
        await f.runtime.close();
        await settle();
        await f.open();
        await settle();
        expect(events(await response(f.current().instance, action()))).toEqual([]);
    });

    it('keeps accounts isolated and rejects a foreign source ticket', async () => {
        const a = await account('12345');
        const b = await account('77777');
        await a.manager.emitEvent(message(a.uin, 41, 4), b.ticket());
        await a.manager.emitEvent(message(a.uin, 42, 5), a.ticket());
        await b.manager.emitEvent(message(b.uin, 43, 6), b.ticket());
        const aEvents = events(await response(a.current().instance, action()));
        const bEvents = events(await response(b.current().instance, action()));
        expect(aEvents.map((event) => [event.message_id, event.self.user_id])).toEqual([
            ['42', '12345'],
        ]);
        expect(bEvents.map((event) => [event.message_id, event.self.user_id])).toEqual([
            ['43', '77777'],
        ]);
    });

    it('uses the shared same-account gate across replacement runtimes', async () => {
        const gate = ownerApi.createPollGate();
        const old = await account('12345', { gate });
        const replacement = await account('12345', { gate });
        const retiredTicket = old.ticket();
        expect(
            await response(replacement.current().instance, action({}, { echo: 'occupied' })),
        ).toMatchObject({
            status: 'failed',
            retcode: 20002,
            data: null,
            echo: 'occupied',
        });
        await old.runtime.close();
        await settle();
        replacement.runtime.statusUpdate();
        await settle();
        await replacement.manager.emitEvent(message(replacement.uin, 44, 1), retiredTicket);
        await replacement.manager.emitEvent(message(replacement.uin, 45, 2), replacement.ticket());
        expect(
            events(await response(replacement.current().instance, action())).map(
                (event) => event.message_id,
            ),
        ).toEqual(['45']);
        await old.open();
        await settle();
        expect(
            await response(old.current().instance, action({}, { echo: 'replacement-owns' })),
        ).toMatchObject({
            status: 'failed',
            retcode: 20002,
            data: null,
            echo: 'replacement-owns',
        });
        expect(events(await response(replacement.current().instance, action()))).toEqual([]);
    });

    it('preserves wrong-self and invalid-parameter errors without consuming queued data', async () => {
        const f = await account();
        const transport = f.current().instance;
        await f.manager.emitEvent(message(f.uin, 51, 1), f.ticket());
        const cases: Array<[object, number, string]> = [
            [
                action({}, { self: { platform: 'qq', user_id: '77777' }, echo: '' }),
                10102,
                'unknown self',
            ],
            [action({ limit: -1 }, { echo: '' }), 10003, 'invalid poll parameters'],
            [action({ timeout: 11 }, { echo: '' }), 10003, 'invalid poll parameters'],
            [action({ extra: true }, { echo: '' }), 10004, 'unsupported parameter'],
            [action({}, { extra: true, echo: '' }), 10004, 'unsupported request field'],
            [{ action: 'get_latest_events', params: null, echo: '' }, 10001, 'invalid request'],
        ];

        for (const [input, retcode, text] of cases) {
            expect(await response(transport, input)).toEqual({
                status: 'failed',
                retcode,
                data: null,
                message: text,
                echo: '',
            });
        }

        const oversizedEcho = 'x'.repeat(4097);
        expect(await response(transport, action({}, { echo: oversizedEcho }))).toEqual({
            status: 'failed',
            retcode: 10001,
            data: null,
            message: 'invalid action request',
            echo: oversizedEcho,
        });
        expect(
            events(await response(transport, action())).map((event) => event.message_id),
        ).toEqual(['51']);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('reports pollGate:null as unavailable while real WS subscription and v11 fanout continue', async () => {
        const f = await account('12345', { noGate: true });
        const transport = f.current().instance;
        const peer = connect(transport);
        expect(ownerApi.pollOwnerStats(f.runtime)).toBeNull();
        expect(await response(transport, action({}, { echo: 'no-gate' }))).toEqual({
            status: 'failed',
            retcode: 20002,
            data: null,
            message: 'poll unavailable',
            echo: 'no-gate',
        });
        const input = message(f.uin, 61, 2);
        await f.manager.emitEvent(input, f.ticket());
        expect(f.legacy.received).toEqual([input]);
        expect(peerMessages(peer).map((event) => event.message_id)).toEqual(['61']);
        expect(f.runtime.isActive).toBe(true);
        expect(f.runtime.hasApplyFailure).toBe(false);
        expect(await response(transport, action({}, { echo: 'still-no-gate' }))).toMatchObject({
            status: 'failed',
            retcode: 20002,
            echo: 'still-no-gate',
        });
        // HTTP polling is not a WebSocket action, even when ordinary WS fanout works.
        peer.emit('message', Buffer.from(JSON.stringify(action({}, { echo: 'ws' }))), false);
        await settle();
        expect(peer.frames.at(-1)).toMatchObject({ status: 'failed', retcode: 10002, echo: 'ws' });
    });

    it('isolates a poll-response error from listener health and subsequent WS/v11 fanout', async () => {
        const f = await account();
        const transport = f.current().instance;
        const peer = connect(transport);
        const waiting = send(transport, action({ timeout: 2 }));
        await settle();
        expect(waiting.bodies).toEqual([]);
        waiting.emit('error', new Error('synthetic response error'));
        await settle();
        expect(waiting.destroyed).toBe(true);
        expect(waiting.bodies).toEqual([]);
        expect(f.runtime.isActive).toBe(true);
        expect(f.runtime.hasApplyFailure).toBe(false);
        await f.manager.emitEvent(message(f.uin, 71, 1), f.ticket());
        expect(peerMessages(peer).map((event) => event.message_id)).toEqual(['71']);
        expect(f.legacy.received).toHaveLength(1);
        expect(
            events(await response(transport, action())).map((event) => event.message_id),
        ).toEqual(['71']);
    });

    it('drops the oldest unreserved HTTP event on overflow without affecting WS or v11', async () => {
        const f = await account();
        const peer = connect(f.current().instance);
        const source = f.ticket();

        for (let id = 1; id <= 129; id++) {
            await f.manager.emitEvent(message(f.uin, id, id), source);
        }

        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
            accepted: 129,
            full: 0,
            dropped_oldest: '1',
        });
        const batch = events(await response(f.current().instance, action()));
        expect(batch).toHaveLength(128);
        expect(batch.map((event) => event.message_id)).toEqual(
            Array.from({ length: 128 }, (_, index) => String(index + 2)),
        );
        expect(peerMessages(peer)).toHaveLength(129);
        expect(f.legacy.received).toHaveLength(129);
    });
});

// This exercises only already-converted, eligible fixture events. An empty result
// or timeout says nothing about events that have not yet reached this runtime.
// FIFO-prefix time sorting is local to a response, not global across responses.
// The bounded 128-event/256-KiB queue can drop on overflow; the private-recall
// projection has separate provenance/ordering limitations and is not asserted here.
