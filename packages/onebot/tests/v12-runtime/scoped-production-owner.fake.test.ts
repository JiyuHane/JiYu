import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import { format } from 'node:util';
import workerThreads from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchPayload } from '../../src/event-filter';
import type { JsonObject, NetworkBase } from '../../src/types';
import type { V12Transport, V12TransportOptions } from '../../src/v12-network';
import type { GuardedPollResult } from '../../src/v12-runtime/event-poll-buffer';
import type { PollSink } from '../../src/v12-runtime/poll-transaction';
import type { V12Runtime } from '../../src/v12-runtime/runtime';
import type { V12Source } from '../../src/v12-runtime/source-generation';

type Captured = { options: V12TransportOptions; instance: V12Transport };
type Guard = { mock: { calls: unknown[] } };
const fake = vi.hoisted(() => ({
    transports: [] as Captured[],
    peer: null as FakePeer | null,
    violations: [] as string[],
    warnings: [] as string[],
    logs: [] as string[],
}));
const TOKEN = 'SYNTHETIC_SCOPED_TOKEN_717c';
const BODY = 'SYNTHETIC_SCOPED_EVENT_BODY_8bce';
const ECHO = 'SYNTHETIC_SCOPED_ECHO_05a2';
const IMAGE_URL = 'https://image.fixture.invalid/photo.png?secret=SYNTHETIC_MEDIA_SECRET_f47a';
const ADMISSION_WARNING = 'v12 http poll admission outcome unknown; event may have been queued';
const DELIVERY_WARNING = 'v12 http poll delivery outcome unknown; events may be missed';

// Only open() is replaced; real transport attach/upgrade and HTTP capability
// use in-memory request/response/peer objects. No listening socket is created.
vi.mock('node:http', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:http')>();
    return {
        ...actual,
        createServer: () => {
            fake.violations.push('named HTTP createServer');
            throw new Error('unexpected listener');
        },
    };
});
vi.mock('@snowluma/websocket', () => ({
    WebSocket: class {
        constructor() {
            fake.violations.push('WebSocket constructor');
            throw new Error('unexpected WebSocket');
        }
    },
    WebSocketServer: class {
        constructor(options: { noServer?: boolean }) {
            if (options?.noServer !== true) {
                fake.violations.push('WebSocket listener');
                throw new Error('unexpected WebSocket listener');
            }
        }
        handleUpgrade(
            _request: unknown,
            _socket: unknown,
            _head: unknown,
            accept: (peer: unknown) => void,
        ) {
            if (!fake.peer) {
                fake.violations.push('unsolicited upgrade');
                throw new Error('missing synthetic peer');
            }

            accept(fake.peer);
        }
        destroy() {}
    },
}));
vi.mock('@snowluma/sqlite', () => ({
    SqliteDatabase: class {
        constructor() {
            fake.violations.push('SQLite');
            throw new Error('unexpected SQLite');
        }
    },
}));
vi.mock('@snowluma/common/logger', () => {
    const write = (level: string, args: unknown[]) => {
        const values = typeof args[0] === 'function' ? (args[0] as () => unknown[])() : args;
        const text = format(values[0], ...values.slice(1));
        fake.logs.push(text);

        if (level === 'warn') {
            fake.warnings.push(text);
        }
    };

    const logger = {
        child: () => logger,
        trace: (...args: unknown[]) => write('trace', args),
        debug: (...args: unknown[]) => write('debug', args),
        info: (...args: unknown[]) => write('info', args),
        success: (...args: unknown[]) => write('success', args),
        warn: (...args: unknown[]) => write('warn', args),
        error: (...args: unknown[]) => write('error', args),
    };
    return { createLogger: () => logger };
});
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
let bufferApi: typeof import('../../src/v12-runtime/event-poll-buffer');
let transactionApi: typeof import('../../src/v12-runtime/poll-transaction');
let coordinatorScoped: ReturnType<typeof instrumentCoordinator>;
let recallApi: typeof import('../../src/v12-runtime/private-recall-source');
let managerApi: typeof import('../../src/network/network-manager');
let adapterApi: typeof import('../../src/network/adapter');
let identityApi: typeof import('../../src/v12-runtime/identity');
let tokenApi: typeof import('../../src/v12/image-file-token');
let mediaApi: typeof import('../../src/message-media');
let guards: Guard[];
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let queue: ReturnType<typeof instrumentQueue>;
const fixtures: Array<{
    manager: import('../../src/network/network-manager').OneBotNetworkManager;
    api: ReturnType<typeof vi.fn>;
    time: ReturnType<typeof vi.fn>;
}> = [];

function instrumentCoordinator(module: typeof import('../../src/v12-runtime/poll-transaction')) {
    return vi.spyOn(module.PollCoordinator, 'scoped');
}

function instrumentQueue(module: typeof import('../../src/v12-runtime/event-poll-buffer')) {
    const cls = module.EventPollBuffer;
    const realEnqueue = cls.prototype.enqueue;
    const realEnqueueScopedRecall = cls.prototype.enqueueScopedRecall;
    const realGuardedCleanup = cls.prototype.guardedCleanupState;
    const realReserveGuarded = cls.prototype.reserveGuarded;
    const realCommitGuarded = cls.prototype.commitGuardedNoDrain;
    return {
        realEnqueue,
        realEnqueueScopedRecall,
        realGuardedCleanup,
        realReserveGuarded,
        realCommitGuarded,
        scoped: vi.spyOn(cls, 'scoped'),
        enqueue: vi.spyOn(cls.prototype, 'enqueue'),
        enqueueScopedRecall: vi.spyOn(cls.prototype, 'enqueueScopedRecall'),
        cleanup: vi.spyOn(cls.prototype, 'guardedCleanupState'),
        reserveGuarded: vi.spyOn(cls.prototype, 'reserveGuarded'),
        commitGuarded: vi.spyOn(cls.prototype, 'commitGuardedNoDrain'),
        releaseGuarded: vi.spyOn(cls.prototype, 'releaseGuardedNoDrain'),
        resumeGuarded: vi.spyOn(cls.prototype, 'resumeGuardedDrain'),
        reserveLegacy: vi.spyOn(cls.prototype, 'reserve'),
        commitLegacy: vi.spyOn(cls.prototype, 'commit'),
        releaseLegacy: vi.spyOn(cls.prototype, 'release'),
    };
}

function forbidden(): never {
    throw new Error('unexpected network, native, account or process operation');
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    vi.stubEnv('SNOWLUMA_LOG_FILE', '0');
    fake.transports.length = 0;
    fake.violations.length = 0;
    fake.warnings.length = 0;
    fake.logs.length = 0;
    fake.peer = null;
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
        vi.spyOn(childProcess, 'spawn').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawnSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'exec').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFile').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFileSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'fork').mockImplementation(forbidden),
        vi.spyOn(workerThreads, 'Worker').mockImplementation(forbidden),
        vi.spyOn(process, 'dlopen').mockImplementation(forbidden),
    ];
    const dnsMethods = [
        'lookup',
        'lookupService',
        'resolve',
        'resolve4',
        'resolve6',
        'resolveAny',
        'resolveCaa',
        'resolveCname',
        'resolveMx',
        'resolveNaptr',
        'resolveNs',
        'resolvePtr',
        'resolveSoa',
        'resolveSrv',
        'resolveTxt',
        'reverse',
    ];

    for (const holder of [
        dns,
        dns.promises,
        dns.Resolver.prototype,
        dns.promises.Resolver.prototype,
    ]) {
        const methods = holder as unknown as Record<string, (...args: never[]) => unknown>;

        for (const method of dnsMethods) {
            if (typeof methods[method] === 'function') {
                guards.push(vi.spyOn(methods, method).mockImplementation(forbidden));
            }
        }
    }

    // Instrument the real primitive before importing the owner/coordinator.
    bufferApi = await import('../../src/v12-runtime/event-poll-buffer');
    queue = instrumentQueue(bufferApi);
    transactionApi = await import('../../src/v12-runtime/poll-transaction');
    coordinatorScoped = instrumentCoordinator(transactionApi);
    sourceApi = await import('../../src/v12-runtime/source-generation');
    recallApi = await import('../../src/v12-runtime/private-recall-source');
    ownerApi = await import('../../src/v12-runtime/poll-owner');
    adapterApi = await import('../../src/network/adapter');
    managerApi = await import('../../src/network/network-manager');
    identityApi = await import('../../src/v12-runtime/identity');
    tokenApi = await import('../../src/v12/image-file-token');
    mediaApi = await import('../../src/message-media');
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
        const backend = resources.flatMap(({ api, time }) => [
            api.mock.calls.length,
            time.mock.calls.length,
        ]);
        const forbiddenCalls = [fetchGuard.mock.calls.length, webSocketGuard.mock.calls.length];
        const violations = [...fake.violations];
        const timers = vi.getTimerCount();
        vi.clearAllTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.useRealTimers();
        expect(cleanupFailed).toBe(false);
        expect(calls).toEqual(calls.map(() => 0));
        expect(backend).toEqual(backend.map(() => 0));
        expect(forbiddenCalls).toEqual([0, 0]);
        expect(violations).toEqual([]);
        expect(timers).toBe(0);
    }
});

async function settle(): Promise<void> {
    for (let i = 0; i < 80; i += 1) {
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
    bodies: string[] = [];
    setHeader(): void {}
    writeHead(status: number): this {
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
        expect(this.bodies).toHaveLength(1);
        return JSON.parse(this.bodies[0]!) as WireResponse;
    }
}
class FakeUpgradeSocket extends EventEmitter {
    end(): void {
        fake.violations.push('upgrade rejected');
    }
    destroy(): void {
        fake.violations.push('upgrade destroyed');
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
        fake.violations.push('unexpected pipelined data');
    }
}
class FakeSink extends EventEmitter implements PollSink {
    open = true;
    body: string | undefined;
    isOpen(): boolean {
        return this.open;
    }
    writeHead(): void {}
    end(body: string): void {
        this.body = body;
        this.emit('finish');
    }
}
type WireEvent = {
    id: string;
    type: string;
    detail_type: string;
    time: number;
    message_id?: string;
    message?: Array<{ type: string; data: { file_id?: string } }>;
};
type WireResponse = {
    status: string;
    retcode: number;
    data: unknown;
    message: string;
    echo?: string;
};

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

async function poll(
    transport: V12Transport,
    params: object = {},
    echo = ECHO,
): Promise<WireResponse> {
    const result = send(transport, { action: 'get_latest_events', params, echo });
    await settle();
    return result.json();
}

function events(result: WireResponse): WireEvent[] {
    expect(result).toMatchObject({ status: 'ok', retcode: 0 });
    expect(Array.isArray(result.data)).toBe(true);
    return result.data as WireEvent[];
}

function connect(transport: V12Transport): FakePeer {
    const peer = new FakePeer();
    const request = new FakeRequest();
    request.method = 'GET';
    fake.peer = peer;

    try {
        transport.handleUpgrade(
            request as unknown as IncomingMessage,
            new FakeUpgradeSocket() as unknown as Duplex,
            Buffer.alloc(0),
        );
    } finally {
        fake.peer = null;
    }

    expect(peer.frames).toMatchObject([
        { type: 'meta', detail_type: 'connect' },
        { type: 'meta', detail_type: 'status_update' },
    ]);
    return peer;
}

function message(id: number, time: number): JsonObject {
    return {
        post_type: 'message',
        self_id: 12345,
        user_id: 23456,
        message_id: id,
        time,
        message_type: 'private',
        sub_type: 'friend',
        raw_message: `${BODY}-${id}`,
        message: [{ type: 'text', data: { text: `${BODY}-${id}` } }],
    };
}

function imageMessage(id: number, time: number): JsonObject {
    const picture: JsonObject = {
        type: 'image',
        data: { file: 'synthetic.png', url: IMAGE_URL, sub_type: 0, summary: '[图片]' },
    };
    // Match the real persistence-only metadata without exposing it on the wire.
    mediaApi.attachMessageMedia(picture, {
        type: 'image',
        fileId: 'synthetic.png',
        imageUrl: IMAGE_URL,
    });
    const input = message(id, time);
    input.message = [picture];
    return input;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function account(gate?: import('../../src/v12-runtime/poll-owner').PollGate) {
    const generation = new sourceApi.SourceGeneration();
    generation.setOnline(true);
    const manager = new managerApi.OneBotNetworkManager();
    const api = vi.fn(forbidden);
    const time = vi.fn(forbidden);
    const context = { uin: '12345', selfId: 12345 };
    const verification: { before?: () => void } = {};
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
            uin: '12345',
            api: { handle: api } as never,
            buildLifecycleEvent: () => ({}),
            buildHeartbeatEvent: () => ({}),
        },
        {
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: time,
            trackAction: (_label, start) => start(),
            canAccept: () => true,
            captureCurrentSource: () => generation.capture(runtime[sourceApi.captureBinding]()),
            isSourceCurrent: (source: V12Source | undefined, binding: object | null) => {
                verification.before?.();
                return (
                    manager.get(identityApi.V12_ADAPTER_NAME) === runtime &&
                    generation.isCurrent(source, binding)
                );
            },
            getPrivateRecallSource: (event) => recallApi.getPrivateRecallSource(context, event),
            ...(gate ? { pollGate: gate } : {}),
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
                    uin: '12345',
                    api: { handle: api } as never,
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
                detail: 'fixture',
            };
        }
        protected bindingSignature(config: NetworkBase): string {
            return config.name;
        }
    })();
    manager.register(runtime);
    manager.register(legacy);
    fixtures.push({ manager, api, time });
    legacy.open();
    const index = fake.transports.length;
    await runtime.open();
    expect(fake.transports).toHaveLength(index + 1);
    const transport = fake.transports[index]!;
    expect(transport.options.httpPoll).toBeDefined();

    const ticket = (): V12Source => {
        const result = generation.capture(runtime[sourceApi.captureBinding]());

        if (!result) {
            throw new Error('synthetic source unavailable');
        }

        return result;
    };

    return { generation, manager, runtime, transport, legacy, context, verification, ticket };
}

function realScopedQueue() {
    expect(queue.scoped).toHaveBeenCalled();
    const result = queue.scoped.mock.results.at(-1);

    if (!result || result.type !== 'return') {
        throw new Error('real scoped queue missing');
    }

    return result.value;
}

function assertNoLegacyTransaction(): void {
    expect(queue.reserveLegacy).not.toHaveBeenCalled();
    expect(queue.commitLegacy).not.toHaveBeenCalled();
    expect(queue.releaseLegacy).not.toHaveBeenCalled();
}

function noPrivateDiagnostics(): void {
    const logs = JSON.stringify(fake.logs);

    for (const secret of [BODY, TOKEN, ECHO, IMAGE_URL, 'SYNTHETIC_MEDIA_SECRET_f47a']) {
        expect(logs).not.toContain(secret);
    }
}

describe('real production scoped HTTP owner (in-memory transport and sinks)', () => {
    it('enqueues normal events and commits each FIFO prefix with the exact selection and receipt', async () => {
        const f = await account();
        const peer = connect(f.transport.instance);
        const scoped = realScopedQueue();
        expect(coordinatorScoped).toHaveBeenCalledOnce();
        const source = f.ticket();

        for (const [id, time] of [
            [1, 30],
            [2, 10],
            [3, 10],
            [4, 1],
        ]) {
            await f.manager.emitEvent(message(id!, time!), source);
        }

        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
            accepted: 4,
            admission_uncertain: 0,
        });
        expect(scoped.stats()).toMatchObject({ count: 4, reserved: 0 });
        expect(f.legacy.received).toHaveLength(4);
        const ws = (peer.frames as WireEvent[]).filter((event) => event.type === 'message');
        expect(ws.map((event) => event.message_id)).toEqual(['1', '2', '3', '4']);
        const first = events(await poll(f.transport.instance, { limit: 3 }));
        const second = events(await poll(f.transport.instance));
        expect(first.map((event) => [event.message_id, event.time])).toEqual([
            ['2', 10],
            ['3', 10],
            ['1', 30],
        ]);
        expect(second.map((event) => [event.message_id, event.time])).toEqual([['4', 1]]);
        expect(first.map((event) => event.id)).toEqual([ws[1]!.id, ws[2]!.id, ws[0]!.id]);
        expect(queue.reserveGuarded).toHaveBeenCalledTimes(2);
        expect(queue.commitGuarded).toHaveBeenCalledTimes(2);
        expect(queue.resumeGuarded).toHaveBeenCalledTimes(2);

        for (let index = 0; index < 2; index += 1) {
            const selection = await queue.reserveGuarded.mock.results[index]!.value;
            expect(selection.status).toBe('reserved');

            if (selection.status !== 'reserved') {
                throw new Error('expected actual scoped selection');
            }

            expect(queue.reserveGuarded.mock.contexts[index]).toBe(scoped);
            expect(queue.commitGuarded.mock.contexts[index]).toBe(scoped);
            expect(queue.commitGuarded.mock.calls[index]).toEqual([selection.token, selection]);
            expect(queue.commitGuarded.mock.calls[index]![1]).toBe(selection);
            const receipt = queue.commitGuarded.mock.results[index]!.value;
            expect(receipt).toEqual({ status: 'committed' });
            expect(queue.resumeGuarded.mock.calls[index]![0]).toBe(receipt);
            expect(queue.resumeGuarded.mock.contexts[index]).toBe(scoped);
        }

        assertNoLegacyTransaction();
    });

    it('retains the media issuer fence and shares one sealed image event with WS and v11', async () => {
        const f = await account();
        const peer = connect(f.transport.instance);
        const input = imageMessage(10, 10);
        const issue = vi.spyOn(tokenApi.V12ImageFileTokens.prototype, 'issue');
        await f.manager.emitEvent(input, f.ticket());
        expect(issue).toHaveBeenCalledExactlyOnceWith(IMAGE_URL);
        expect(f.legacy.received).toHaveLength(1);
        const ws = (peer.frames as WireEvent[]).filter((event) => event.type === 'message');
        expect(ws).toHaveLength(1);
        const event = events(await poll(f.transport.instance))[0]!;
        expect(event).toEqual(ws[0]);
        const fileId = event.message?.[0]?.data.file_id;
        expect(fileId).toMatch(/^jiyu-image:v1:/);
        expect(JSON.stringify(event)).not.toContain(IMAGE_URL);
        expect(queue.reserveGuarded).toHaveBeenCalledOnce();
        expect(queue.commitGuarded).toHaveBeenCalledOnce();
        assertNoLegacyTransaction();
        noPrivateDiagnostics();
    });

    it('does not admit a media event if the issuer changes during post-issue verification', async () => {
        const f = await account();
        const peer = connect(f.transport.instance);
        const replacement = new tokenApi.V12ImageFileTokens('12345');
        const slot = f.runtime as unknown as {
            imageFileTokens: InstanceType<typeof tokenApi.V12ImageFileTokens> | null;
        };
        const originalIssue = tokenApi.V12ImageFileTokens.prototype.issue;
        let originalIssuer: InstanceType<typeof tokenApi.V12ImageFileTokens> | null = null;
        let checks = 0;
        let replaced = false;
        vi.spyOn(tokenApi.V12ImageFileTokens.prototype, 'issue').mockImplementation(function (
            this: InstanceType<typeof tokenApi.V12ImageFileTokens>,
            url,
        ) {
            const id = Reflect.apply(originalIssue, this, [url]) as string;
            originalIssuer = this;
            return id;
        });

        f.verification.before = () => {
            if (originalIssuer !== null && ++checks === 2) {
                slot.imageFileTokens = replacement;
                replaced = true;
            }
        };

        try {
            const input = imageMessage(11, 11);
            await f.manager.emitEvent(input, f.ticket());
            expect(replaced).toBe(true);
            expect(queue.enqueue).not.toHaveBeenCalled();
            expect(
                (peer.frames as WireEvent[]).filter((event) => event.type === 'message'),
            ).toHaveLength(0);
            expect(f.legacy.received).toHaveLength(1);
            expect(realScopedQueue().stats()).toMatchObject({ count: 0 });
        } finally {
            f.verification.before = undefined;
            slot.imageFileTokens = originalIssuer;
            replacement.revoke();
        }
    });

    it('admits a proven friend recall to the scoped HTTP queue after WS fanout', async () => {
        const f = await account();
        const peer = connect(f.transport.instance);
        const ticket = f.ticket();
        const raw = {
            kind: 'friend_recall' as const,
            time: 11,
            selfUin: 12345,
            userUin: 23456,
            msgSeq: 7,
            clientSeq: 7,
            recalledBySelf: false,
        };
        const event: JsonObject = {
            time: 11,
            self_id: 12345,
            post_type: 'notice',
            notice_type: 'friend_recall',
            user_id: 23456,
            message_id: -7,
        };
        const snapshot = recallApi.capturePrivateRecallSource(f.context, raw, ticket);
        expect(snapshot).toBeDefined();
        expect(recallApi.rememberPrivateRecallSource(f.context, event, snapshot, -7)).toBe(true);
        await f.manager.emitEvent(event, ticket);
        expect(f.legacy.received).toEqual([event]);
        const notices = (peer.frames as WireEvent[]).filter((item) => item.type === 'notice');
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({
            detail_type: 'private_message_delete',
            message_id: '-7',
        });
        const scoped = realScopedQueue();
        expect(scoped.stats()).toMatchObject({ count: 1, reserved: 0 });
        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({ active: true, accepted: 1 });
        expect(queue.enqueue).not.toHaveBeenCalled();
        expect(queue.enqueueScopedRecall).toHaveBeenCalledOnce();
        expect(queue.enqueueScopedRecall.mock.contexts[0]).toBe(scoped);
        expect(queue.enqueueScopedRecall.mock.results[0]!.value).toBe('accepted');
        const [candidate, proof, eventTicket] = queue.enqueueScopedRecall.mock.calls[0]!;
        const scope = queue.scoped.mock.calls[0]![2]; // The real runtime-created scope.
        expect(eventTicket).toBe(ticket);
        expect(recallApi.isPrivateRecallPollProofFor(proof, candidate)).toBe(true);
        expect(recallApi.isPrivateRecallPollProofInEpochAccountScope(proof, ticket, scope)).toBe(
            true,
        );
        expect(candidate).toEqual(notices[0]);
        const response = await poll(f.transport.instance);
        expect(response.echo).toBe(ECHO);
        expect(events(response)).toEqual(notices);
        expect(events(await poll(f.transport.instance))).toEqual([]);
        expect(queue.enqueueScopedRecall).toHaveBeenCalledOnce();
        expect(fake.warnings).not.toContain('v12 http poll private recall event not admitted');
        assertNoLegacyTransaction();
        noPrivateDiagnostics();
    });

    it('reports uncertain recall admission after a real guarded eviction and publication', async () => {
        const gate = ownerApi.createPollGate();
        const f = await account(gate);
        const peer = connect(f.transport.instance);
        const scoped = realScopedQueue();
        const ticket = f.ticket();

        for (let id = 1; id <= 128; id += 1) {
            await f.manager.emitEvent(message(id, id), ticket);
        }

        expect(scoped.stats()).toMatchObject({ count: 128, reserved: 0, closed: false });
        expect(scoped.oldestDropCount()).toBe(0n);
        expect(queue.enqueue).toHaveBeenCalledTimes(128);
        expect(queue.enqueueScopedRecall).not.toHaveBeenCalled();
        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
            active: true,
            accepted: 128,
            admission_uncertain: 0,
            dropped_oldest: '0',
        });

        const raw = {
            kind: 'friend_recall' as const,
            time: 200,
            selfUin: 12345,
            userUin: 23456,
            msgSeq: 7,
            clientSeq: 7,
            recalledBySelf: false,
        };
        const event: JsonObject = {
            time: 200,
            self_id: 12345,
            post_type: 'notice',
            notice_type: 'friend_recall',
            user_id: 23456,
            message_id: -7,
        };
        const snapshot = recallApi.capturePrivateRecallSource(f.context, raw, ticket);
        expect(snapshot).toBeDefined();
        expect(recallApi.rememberPrivateRecallSource(f.context, event, snapshot, -7)).toBe(true);
        const scope = queue.scoped.mock.calls[0]![2];
        const dropWarning = 'v12 http poll queue full; oldest unreserved events dropped';
        const privateRecallWarning = 'v12 http poll private recall event not admitted';
        expect(fake.warnings).not.toContain(dropWarning);
        expect(fake.warnings).not.toContain(ADMISSION_WARNING);

        const logger = (
            f.runtime as unknown as {
                log: { warn: (...args: unknown[]) => void };
            }
        ).log;
        const originalWarn = logger.warn;
        const warningsAfterWs: Array<{ message: string; notices: number }> = [];
        const warn = vi.spyOn(logger, 'warn').mockImplementation((...args) => {
            const first = args[0];

            if (first === dropWarning || first === ADMISSION_WARNING) {
                warningsAfterWs.push({
                    message: first,
                    notices: (peer.frames as WireEvent[]).filter(
                        (frame) =>
                            frame.type === 'notice' &&
                            frame.detail_type === 'private_message_delete',
                    ).length,
                });
            }

            Reflect.apply(originalWarn, logger, args);
        });
        const admit = vi.spyOn(ownerApi, 'enqueuePrivateRecallPollEvent');
        const close = vi.spyOn(scoped, 'close');
        const published: Array<{
            result: string;
            count: number;
            reserved: number;
            drops: bigint;
            cleanup: string;
            candidate: unknown;
            proof: unknown;
            eventTicket: unknown;
            proofValid: boolean;
            proofInScope: boolean;
        }> = [];
        let uncertainReports = 0;
        let cleanupContext: InstanceType<typeof bufferApi.EventPollBuffer> | undefined;
        const recall = queue.enqueueScopedRecall.mockImplementation(function (
            this: InstanceType<typeof bufferApi.EventPollBuffer>,
            candidate,
            proof,
            eventTicket,
        ) {
            const result = Reflect.apply(queue.realEnqueueScopedRecall, this, [
                candidate,
                proof,
                eventTicket,
            ]);

            if (result === 'accepted') {
                const state = this.stats();
                published.push({
                    result,
                    count: state.count,
                    reserved: state.reserved,
                    drops: this.oldestDropCount(),
                    cleanup: Reflect.apply(queue.realGuardedCleanup, this, []),
                    candidate,
                    proof,
                    eventTicket,
                    proofValid: recallApi.isPrivateRecallPollProofFor(proof, candidate),
                    proofInScope: recallApi.isPrivateRecallPollProofInEpochAccountScope(
                        proof,
                        eventTicket,
                        scope,
                    ),
                });
                // The real enqueue already published. Fault-inject only the
                // following cleanup observation and record its queue instance.
                queue.cleanup.mockImplementationOnce(function (
                    this: InstanceType<typeof bufferApi.EventPollBuffer>,
                ) {
                    cleanupContext = this;
                    uncertainReports += 1;
                    return 'uncertain';
                });
            }

            return result;
        });

        await f.manager.emitEvent(event, ticket);
        await settle();

        expect(recall).toHaveBeenCalledOnce();
        expect(queue.enqueueScopedRecall).toHaveBeenCalledOnce();
        expect(queue.enqueueScopedRecall.mock.contexts[0]).toBe(scoped);
        expect(queue.enqueueScopedRecall.mock.results[0]!.value).toBe('accepted');
        expect(published).toHaveLength(1);
        expect(published[0]).toMatchObject({
            result: 'accepted',
            count: 128,
            reserved: 0,
            drops: 1n,
            cleanup: 'open',
            proofValid: true,
            proofInScope: true,
        });
        const [candidate, proof, eventTicket] = queue.enqueueScopedRecall.mock.calls[0]!;
        expect(candidate).toBe(published[0]!.candidate);
        expect(proof).toBe(published[0]!.proof);
        expect(eventTicket).toBe(ticket);
        expect(published[0]!.eventTicket).toBe(ticket);
        expect(uncertainReports).toBe(1);
        expect(cleanupContext).toBe(scoped);
        expect(admit).toHaveBeenCalledOnce();
        expect(admit.mock.results[0]).toMatchObject({ type: 'return', value: 'uncertain' });
        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
            active: false,
            accepted: 128,
            admission_uncertain: 1,
            dropped_oldest: '1',
            cleanup_pending: true,
            cleanup_uncertain: true,
        });
        expect(gate.uncertain).toBe(true);
        expect(close).toHaveBeenCalledOnce();
        expect(scoped.guardedCleanupState()).toBe('closed');
        expect(scoped.stats()).toMatchObject({ count: 0, reserved: 0, closed: true });
        expect(scoped.oldestDropCount()).toBe(1n);
        expect(queue.enqueueScopedRecall).toHaveBeenCalledOnce();

        expect(f.legacy.received).toHaveLength(129);
        expect(f.legacy.received.filter((entry) => entry === event)).toEqual([event]);
        const notices = (peer.frames as WireEvent[]).filter(
            (frame) => frame.type === 'notice' && frame.detail_type === 'private_message_delete',
        );
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ message_id: '-7' });
        expect(published[0]!.candidate).toEqual(notices[0]);
        expect(warningsAfterWs).toEqual([
            { message: dropWarning, notices: 1 },
            { message: ADMISSION_WARNING, notices: 1 },
        ]);
        expect(
            warn.mock.calls.filter(
                ([message]) => message === dropWarning || message === ADMISSION_WARNING,
            ),
        ).toEqual([[dropWarning], [ADMISSION_WARNING]]);
        expect(fake.warnings).not.toContain(privateRecallWarning);
        expect(JSON.stringify(fake.warnings)).not.toContain('23456');
        expect(JSON.stringify(fake.warnings)).not.toContain('"message_id"');
        assertNoLegacyTransaction();
        noPrivateDiagnostics();
    });

    it.each(['before-enqueue', 'during-host-verify'] as const)(
        'retires an old owner when its real scope is retired %s',
        async (when) => {
            const gate = ownerApi.createPollGate();
            const old = await account(gate);
            const peer = connect(old.transport.instance);
            const oldQueue = realScopedQueue();
            const scope = queue.scoped.mock.calls.at(-1)?.[2];
            expect(recallApi.isPrivateRecallPollEpochAccountScopeActive(scope)).toBe(true);
            const source = old.ticket();
            // Capture a genuinely converted candidate, then exercise the owner
            // seam directly so runtime prechecks cannot retire it beforehand.
            await old.manager.emitEvent(message(41, 41), source);
            expect(queue.enqueue).toHaveBeenCalledOnce();
            const candidate = queue.enqueue.mock.calls[0]?.[0];
            expect(candidate).toBeDefined();
            expect(oldQueue.stats()).toMatchObject({ count: 1 });
            queue.enqueue.mockClear();
            let verificationChecks = 0;
            let retired = false;

            if (when === 'before-enqueue') {
                retired = recallApi.retirePrivateRecallPollEpochAccountScope(scope);
            } else {
                old.verification.before = () => {
                    verificationChecks += 1;

                    // The first check is owner.valid(); the second is the
                    // owner seam's separate host.verify(source) callback.
                    if (verificationChecks === 2) {
                        retired = recallApi.retirePrivateRecallPollEpochAccountScope(scope);
                    }
                };
            }

            ownerApi.enqueuePollEvent(old.runtime, candidate, source);
            old.verification.before = undefined;
            expect(retired).toBe(true);
            expect(recallApi.isPrivateRecallPollEpochAccountScopeActive(scope)).toBe(false);
            expect(ownerApi.pollOwnerStats(old.runtime)).toMatchObject({ active: false });
            expect(queue.enqueue).not.toHaveBeenCalled();
            expect(oldQueue.stats()).toMatchObject({ count: 1 });
            await settle();
            expect(gate.uncertain).toBe(false);
            expect(oldQueue.stats()).toMatchObject({ count: 0, closed: true });
            // The same active runtime may legitimately establish a fresh owner
            // after the retired one cleans up; fanout must not reuse oldQueue.
            await old.manager.emitEvent(message(42, 42), source);
            expect(old.legacy.received).toHaveLength(2);
            expect(
                (peer.frames as WireEvent[]).filter((event) => event.type === 'message'),
            ).toHaveLength(2);
            expect(queue.enqueue).toHaveBeenCalledOnce();
            const successor = realScopedQueue();
            const successorScope = queue.scoped.mock.calls.at(-1)?.[2];
            expect(successor).not.toBe(oldQueue);
            expect(queue.enqueue.mock.contexts[0]).toBe(successor);
            expect(successorScope).not.toBe(scope);
            expect(recallApi.isPrivateRecallPollEpochAccountScopeActive(successorScope)).toBe(true);
            expect(successor.stats()).toMatchObject({ count: 1 });
            expect(oldQueue.stats()).toMatchObject({ count: 0, closed: true });
            // Close the same-runtime successor and await gate release before
            // creating the separately managed replacement for this account.
            queue.enqueue.mockClear();
            await old.runtime.close();
            await settle();
            expect(successor.guardedCleanupState()).toBe('closed');
            expect(gate.uncertain).toBe(false);
            expect(gate.claim).toBeNull();
            const replacement = await account(gate);
            const newQueue = realScopedQueue();
            expect(newQueue).not.toBe(oldQueue);
            expect(newQueue).not.toBe(successor);
            const newClaim = gate.claim;
            expect(newClaim).not.toBeNull();
            ownerApi.enqueuePollEvent(old.runtime, candidate, source);
            expect(queue.enqueue).not.toHaveBeenCalled();
            expect(newQueue.stats()).toMatchObject({ count: 0 });
            expect(gate.claim).toBe(newClaim);
            await replacement.manager.emitEvent(message(43, 43), replacement.ticket());
            expect(
                events(await poll(replacement.transport.instance)).map((event) => event.message_id),
            ).toEqual(['43']);
        },
    );

    it.each(['throw', 'invalid'] as const)(
        'retires before admission when the initial watermark sample is %s',
        async (fault) => {
            const gate = ownerApi.createPollGate();
            const f = await account(gate);
            const scoped = realScopedQueue();
            const peer = connect(f.transport.instance);
            const warning = 'v12 http poll cleanup pending; events may be missed';
            expect(fake.warnings).not.toContain(warning);
            const originalSend = peer.send;
            const warningBeforeWs: boolean[] = [];
            vi.spyOn(peer, 'send').mockImplementation(function (this: FakePeer, text, callback) {
                const frame = JSON.parse(text) as WireEvent;

                if (frame.type === 'message') {
                    warningBeforeWs.push(fake.warnings.includes(warning));
                }

                return Reflect.apply(originalSend, this, [text, callback]);
            });
            const watermark = vi.spyOn(scoped, 'oldestDropCount');
            let injected = 0;
            watermark.mockImplementationOnce(() => {
                injected += 1;

                if (fault === 'throw') {
                    throw new Error('synthetic pre-admission watermark failure');
                }

                return 'not-a-bigint' as unknown as bigint;
            });
            const close = vi.spyOn(scoped, 'close');
            await f.manager.emitEvent(message(1973856227, 71), f.ticket());
            await settle();
            expect(injected).toBe(1);
            expect(queue.enqueue).not.toHaveBeenCalled();
            expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
                active: false,
                cleanup_pending: true,
                cleanup_uncertain: true,
                admission_uncertain: 0,
            });
            expect(gate.uncertain).toBe(true);
            expect(close).toHaveBeenCalledOnce();
            expect(scoped.guardedCleanupState()).toBe('closed');
            expect(f.legacy.received).toHaveLength(1);
            expect(
                (peer.frames as WireEvent[]).filter((event) => event.type === 'message'),
            ).toHaveLength(1);
            expect(warningBeforeWs).toEqual([false]);
            expect(fake.warnings.filter((entry) => entry === warning)).toHaveLength(1);
            expect(fake.warnings).not.toContain(ADMISSION_WARNING);
            expect(JSON.stringify(fake.warnings)).not.toContain('1973856227');
            noPrivateDiagnostics();
        },
    );

    it.each(['stats-throw', 'stats-invalid', 'watermark-throw', 'watermark-invalid'] as const)(
        'keeps the gate sticky and attempts actual queue.close after teardown %s',
        async (fault) => {
            const gate = ownerApi.createPollGate();
            const f = await account(gate);
            const scoped = realScopedQueue();
            await f.manager.emitEvent(message(51, 51), f.ticket());
            const before = scoped.stats();
            expect(before.count).toBe(1);
            const stats = vi.spyOn(scoped, 'stats');
            const watermark = vi.spyOn(scoped, 'oldestDropCount');
            const close = vi.spyOn(scoped, 'close');

            // Only the selected status observation is injected; close and the
            // queue itself remain real and the unread count is never invented.
            if (fault === 'stats-throw') {
                stats.mockImplementation(() => {
                    throw new Error('synthetic stats failure');
                });
            } else if (fault === 'stats-invalid') {
                stats.mockReturnValue({ ...before, count: Number.NaN });
            } else if (fault === 'watermark-throw') {
                watermark.mockImplementation(() => {
                    throw new Error('synthetic watermark failure');
                });
            } else {
                watermark.mockReturnValue('not-a-bigint' as unknown as bigint);
            }

            await f.runtime.close();
            await settle();
            expect(close).toHaveBeenCalledOnce();
            expect(scoped.guardedCleanupState()).toBe('closed');
            expect(gate.uncertain).toBe(true);
            const after = ownerApi.pollOwnerStats(f.runtime);
            expect(after).toMatchObject({
                active: false,
                cleanup_pending: true,
                cleanup_uncertain: true,
                dropped_oldest: '0',
            });

            if (fault.startsWith('stats-')) {
                expect(after?.closing_discard).toBe(0);
                expect(fake.warnings).not.toContain(
                    'v12 http poll retired with undelivered buffered events',
                );
            } else {
                // A successfully sampled count may independently establish one
                // discard; a conservative zero also retains uncertainty.
                expect([0, 1]).toContain(after?.closing_discard);
            }

            const replacement = await account(gate);
            expect(await poll(replacement.transport.instance)).toMatchObject({
                status: 'failed',
                data: null,
            });
            noPrivateDiagnostics();
        },
    );

    it.each(['return-uncertain', 'throw-after-publication', 'report-cleanup-uncertain'] as const)(
        'retains uncertain admission and sticky ownership after %s without retry or fanout loss',
        async (fault) => {
            const gate = ownerApi.createPollGate();
            const f = await account(gate);
            const peer = connect(f.transport.instance);
            const scoped = realScopedQueue();
            let invoked = 0;
            let published = false;

            // Inject only one real queue method: the throw variant runs real
            // enqueue first; the cleanup variant substitutes one reported state.
            if (fault === 'report-cleanup-uncertain') {
                queue.cleanup.mockImplementationOnce(function (
                    this: InstanceType<typeof bufferApi.EventPollBuffer>,
                ) {
                    expect(this).toBe(scoped);
                    invoked += 1;
                    return 'uncertain';
                });
            } else {
                queue.enqueue.mockImplementationOnce(function (
                    this: InstanceType<typeof bufferApi.EventPollBuffer>,
                    input,
                ) {
                    expect(this).toBe(scoped);
                    invoked += 1;

                    if (fault === 'return-uncertain') {
                        return 'uncertain';
                    }

                    expect(Reflect.apply(queue.realEnqueue, this, [input])).toBe('accepted');
                    published = true;
                    throw new Error(`${BODY}-synthetic-queue-error`);
                });
            }

            await f.manager.emitEvent(message(21, 21), f.ticket());
            await settle();
            expect(invoked).toBe(1);
            expect(published).toBe(fault === 'throw-after-publication');

            if (fault === 'report-cleanup-uncertain') {
                expect(queue.enqueue.mock.results[0]?.value).toBe('accepted');
            }

            expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
                admission_uncertain: 1,
                cleanup_uncertain: true,
            });
            expect(gate.uncertain).toBe(true);
            expect(f.legacy.received).toHaveLength(1);
            expect(
                (peer.frames as WireEvent[]).filter((event) => event.type === 'message'),
            ).toHaveLength(1);
            expect(fake.warnings.filter((warning) => warning === ADMISSION_WARNING)).toHaveLength(
                1,
            );
            noPrivateDiagnostics();
            await f.manager.emitEvent(message(22, 22), f.ticket());
            await settle();
            expect(queue.enqueue).toHaveBeenCalledTimes(1);
            expect(f.legacy.received).toHaveLength(2);
            expect(
                (peer.frames as WireEvent[]).filter((event) => event.type === 'message'),
            ).toHaveLength(2);
            const replacement = await account(gate);
            expect(await poll(replacement.transport.instance)).toMatchObject({
                status: 'failed',
                data: null,
                echo: ECHO,
            });
            expect(gate.uncertain).toBe(true);
        },
    );

    it.each(['resume-uncertain', 'commit-then-throw', 'reserve-uncertain'] as const)(
        'diagnoses a scoped transaction according to its actual committed state: %s',
        async (fault) => {
            const f = await account();
            const peer = connect(f.transport.instance);
            const scoped = realScopedQueue();
            await f.manager.emitEvent(message(61, 61), f.ticket());

            if (fault === 'resume-uncertain') {
                // The real commit publishes first; only the following drain
                // result is fault-injected, leaving the real receipt barrier.
                queue.resumeGuarded.mockImplementationOnce(() => ({ status: 'uncertain' }));
            } else if (fault === 'commit-then-throw') {
                queue.commitGuarded.mockImplementationOnce(function (
                    this: InstanceType<typeof bufferApi.EventPollBuffer>,
                    token,
                    selection,
                ) {
                    expect(this).toBe(scoped);
                    const receipt = Reflect.apply(queue.realCommitGuarded, this, [
                        token,
                        selection,
                    ]);
                    expect(receipt).toEqual({ status: 'committed' });
                    throw new Error('synthetic post-commit failure');
                });
            } else {
                // No selection, write, or commit occurs in this injected result.
                queue.reserveGuarded.mockResolvedValueOnce({ status: 'uncertain' });
            }

            const capability = f.transport.options.httpPoll;

            if (!capability) {
                throw new Error('missing real HTTP poll capability');
            }

            const sink = new FakeSink();
            const write = vi.spyOn(sink, 'end');
            const result = await capability.run(
                { action: 'get_latest_events', params: {}, echo: ECHO },
                {
                    sink,
                    signal: new AbortController().signal,
                    responseDeadline: performance.now() + 5000,
                    maxOutputBytes: 512 * 1024,
                },
            );
            await settle();
            expect(result.kind).toBe('outcome');

            if (result.kind !== 'outcome') {
                throw new Error('missing scoped transaction outcome');
            }

            const outcome =
                result.outcome.kind === 'cleanup_uncertain'
                    ? result.outcome.outcome
                    : result.outcome;
            expect(outcome).toMatchObject({
                kind: 'scoped_uncertain',
                committed:
                    fault === 'reserve-uncertain'
                        ? false
                        : fault === 'commit-then-throw'
                          ? 'unknown'
                          : true,
            });
            expect(queue.reserveGuarded).toHaveBeenCalledOnce();
            expect(queue.commitGuarded).toHaveBeenCalledTimes(
                fault === 'reserve-uncertain' ? 0 : 1,
            );
            expect(write).not.toHaveBeenCalled();
            expect(f.legacy.received).toHaveLength(1);
            expect(
                (peer.frames as WireEvent[]).filter((event) => event.type === 'message'),
            ).toHaveLength(1);
            expect(fake.warnings.filter((warning) => warning === DELIVERY_WARNING)).toHaveLength(
                fault === 'reserve-uncertain' ? 0 : 1,
            );
            noPrivateDiagnostics();
            assertNoLegacyTransaction();
        },
    );

    it('keeps the gate until a late reserved token is released, then allows a replacement owner', async () => {
        const gate = ownerApi.createPollGate();
        const old = await account(gate);
        const replacement = await account(gate);
        const scoped = realScopedQueue();
        await old.manager.emitEvent(message(31, 31), old.ticket());
        const late = deferred<GuardedPollResult>();
        const observed: { selection?: GuardedPollResult } = {};
        // Hold only the delivery of the real reservation; no token or selection is fabricated.
        queue.reserveGuarded.mockImplementationOnce(function (
            this: InstanceType<typeof bufferApi.EventPollBuffer>,
            options,
        ) {
            return (
                Reflect.apply(queue.realReserveGuarded, this, [
                    options,
                ]) as Promise<GuardedPollResult>
            ).then((selection) => {
                observed.selection = selection;
                return late.promise;
            });
        });
        const sink = new FakeSink();
        const capability = old.transport.options.httpPoll;

        if (!capability) {
            throw new Error('missing real HTTP poll capability');
        }

        const running = capability.run(
            { action: 'get_latest_events', params: {}, echo: ECHO },
            {
                sink,
                signal: new AbortController().signal,
                responseDeadline: performance.now() + 5000,
                maxOutputBytes: 512 * 1024,
            },
        );
        let closing: Promise<void> | undefined;

        try {
            await settle();
            const selection = observed.selection;
            expect(selection?.status).toBe('reserved');

            if (!selection || selection.status !== 'reserved') {
                throw new Error('real selection missing');
            }

            expect(scoped.stats()).toMatchObject({ count: 1, reserved: 1 });
            closing = old.runtime.close();
            await settle();
            expect(gate.claim).not.toBeNull();
            replacement.runtime.statusUpdate();
            await settle();
            expect(ownerApi.pollOwnerStats(replacement.runtime)).toMatchObject({
                cleanup_pending: true,
            });
            expect(await poll(replacement.transport.instance)).toMatchObject({
                status: 'failed',
                data: null,
            });
            expect(queue.releaseGuarded).not.toHaveBeenCalled();
            late.resolve(selection);
            await running;
            await closing;
            await settle();
            expect(queue.releaseGuarded).toHaveBeenCalledOnce();
            expect(queue.releaseGuarded.mock.calls[0]![0]).toBe(selection.token);
            const receipt = queue.releaseGuarded.mock.results[0]!.value;
            expect(receipt).toEqual({ status: 'released' });
            expect(queue.resumeGuarded).toHaveBeenCalledWith(receipt);
            expect(gate.uncertain).toBe(false);
            replacement.runtime.statusUpdate();
            await settle();
            await replacement.manager.emitEvent(message(32, 32), replacement.ticket());
            expect(
                events(await poll(replacement.transport.instance)).map((event) => event.message_id),
            ).toEqual(['32']);
            assertNoLegacyTransaction();
        } finally {
            late.resolve(observed.selection ?? { status: 'closed' });
            await Promise.allSettled([running, ...(closing ? [closing] : [])]);
            await settle();
        }
    });
});
