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
import type { QQEventVariant } from '@snowluma/protocol/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchPayload } from '../../src/event-filter';
import type { OneBotInstanceContext } from '../../src/instance-context';
import type { JsonObject, NetworkBase } from '../../src/types';
import type { V12Transport, V12TransportOptions } from '../../src/v12-network';
import type { GuardedPollResult } from '../../src/v12-runtime/event-poll-buffer';
import type { V12Runtime } from '../../src/v12-runtime/runtime';
import type { V12Source } from '../../src/v12-runtime/source-generation';

type Recall = Extract<QQEventVariant, { kind: 'friend_recall' }>;
type Captured = { options: V12TransportOptions; instance: V12Transport };
type Guard = { mock: { calls: unknown[] } };
const fake = vi.hoisted(() => ({
    transports: [] as Captured[],
    peer: null as FakePeer | null,
    violations: [] as string[],
    warnings: [] as string[],
    errors: [] as string[],
}));
const TOKEN = 'SYNTHETIC_RECALL_HTTP_TOKEN_7fb1';
const ECHO = 'SYNTHETIC_RECALL_HTTP_ECHO_67b8';
const TIME = 1_700_000_100;
// Account IDs are synthetic fixture values; no live account is used.
const PEER = 20002;

// Only listener startup is replaced. Real attach, subscription, request
// handling, HTTP owner, coordinator and queue use in-memory peers and sinks.
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
                throw new Error('missing in-memory peer');
            }

            accept(fake.peer);
        }
        destroy() {}
    },
}));
vi.mock('@snowluma/sqlite', () => ({
    SqliteDatabase: class {
        constructor() {
            fake.violations.push('SQLite construction');
            throw new Error('unexpected SQLite');
        }
    },
}));
vi.mock('@snowluma/common/logger', () => {
    const logger = {
        child: () => logger,
        trace: () => {},
        debug: () => {},
        info: () => {},
        success: () => {},
        warn: (...args: unknown[]) => fake.warnings.push(format(args[0], ...args.slice(1))),
        error: (...args: unknown[]) => fake.errors.push(format(args[0], ...args.slice(1))),
    };
    return {
        createLogger: () => logger,
        runWithTraceRequest: <T>(start: () => T): T => start(),
    };
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

let busApi: typeof import('@snowluma/protocol/event-bus');
let pipelineApi: typeof import('../../src/event-pipeline');
let filterApi: typeof import('../../src/event-filter');
let runtimeApi: typeof import('../../src/v12-runtime/runtime');
let sourceApi: typeof import('../../src/v12-runtime/source-generation');
let recallApi: typeof import('../../src/v12-runtime/private-recall-source');
let ownerApi: typeof import('../../src/v12-runtime/poll-owner');
let bufferApi: typeof import('../../src/v12-runtime/event-poll-buffer');
let managerApi: typeof import('../../src/network/network-manager');
let adapterApi: typeof import('../../src/network/adapter');
let identityApi: typeof import('../../src/v12-runtime/identity');
let scopedRecall: ReturnType<typeof instrumentScopedRecall>;
let guardedCommit: ReturnType<typeof instrumentGuardedCommit>;
let guards: Guard[];
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
const fixtures: Array<{
    pipeline: import('../../src/event-pipeline').EventPipelineHandle;
    bus: import('@snowluma/protocol/event-bus').BridgeEventBus;
    manager: import('../../src/network/network-manager').OneBotNetworkManager;
    api: ReturnType<typeof vi.fn>;
    sentTime: ReturnType<typeof vi.fn>;
    errors: unknown[];
}> = [];

function instrumentScopedRecall(module: typeof import('../../src/v12-runtime/event-poll-buffer')) {
    return vi.spyOn(module.EventPollBuffer.prototype, 'enqueueScopedRecall');
}

function instrumentGuardedCommit(module: typeof import('../../src/v12-runtime/event-poll-buffer')) {
    return vi.spyOn(module.EventPollBuffer.prototype, 'commitGuardedNoDrain');
}

function forbidden(): never {
    throw new Error('unexpected network, native or process operation');
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    vi.stubEnv('SNOWLUMA_LOG_FILE', '0');
    fake.transports.length = 0;
    fake.violations.length = 0;
    fake.warnings.length = 0;
    fake.errors.length = 0;
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

        for (const name of dnsMethods) {
            if (typeof methods[name] === 'function') {
                guards.push(vi.spyOn(methods, name).mockImplementation(forbidden));
            }
        }
    }

    // Capture calls to the real scoped queue; do not substitute any proof or queue.
    bufferApi = await import('../../src/v12-runtime/event-poll-buffer');
    scopedRecall = instrumentScopedRecall(bufferApi);
    guardedCommit = instrumentGuardedCommit(bufferApi);
    sourceApi = await import('../../src/v12-runtime/source-generation');
    recallApi = await import('../../src/v12-runtime/private-recall-source');
    ownerApi = await import('../../src/v12-runtime/poll-owner');
    filterApi = await import('../../src/event-filter');
    adapterApi = await import('../../src/network/adapter');
    managerApi = await import('../../src/network/network-manager');
    identityApi = await import('../../src/v12-runtime/identity');
    busApi = await import('@snowluma/protocol/event-bus');
    pipelineApi = await import('../../src/event-pipeline');
    runtimeApi = await import('../../src/v12-runtime/runtime');
});

afterEach(async () => {
    let cleanupFailed = false;
    const resources = fixtures.splice(0);

    try {
        for (const f of resources) {
            try {
                f.pipeline.stop();
                await f.pipeline.drain();
                f.bus.clear();
                cleanupFailed ||= !(await f.manager.shutdown()).closed;
            } catch {
                cleanupFailed = true;
            }
        }

        await settle();
    } finally {
        const calls = guards.map((guard) => guard.mock.calls.length);
        const backend = resources.flatMap(({ api, sentTime }) => [
            api.mock.calls.length,
            sentTime.mock.calls.length,
        ]);
        const busErrors = resources.flatMap((f) => f.errors);
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
        expect(busErrors).toEqual([]);
        expect(forbiddenCalls).toEqual([0, 0]);
        expect(violations).toEqual([]);
        expect(timers).toBe(0);
    }
});

async function settle(): Promise<void> {
    for (let index = 0; index < 80; index += 1) {
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
    onHead?: () => void;
    setHeader(): void {}
    writeHead(status: number): this {
        this.status = status;
        this.headersSent = true;
        this.onHead?.();
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
    json(): Response {
        expect(this.status).toBe(200);
        expect(this.bodies).toHaveLength(1);
        return JSON.parse(this.bodies[0]!) as Response;
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
type WireEvent = {
    id: string;
    time: number;
    type: string;
    detail_type: string;
    sub_type: string;
    self: { platform: string; user_id: string };
    message_id: string;
    user_id: string;
};
type Response = { status: string; retcode: number; data: unknown; message: string; echo?: string };
class FakePeer extends EventEmitter {
    readonly frames: WireEvent[] = [];
    terminated = false;
    onRecall?: (event: WireEvent) => void;
    send(text: string, callback: (error?: Error) => void): void {
        const event = JSON.parse(text) as WireEvent;
        this.frames.push(event);

        if (event.detail_type === 'private_message_delete') {
            this.onRecall?.(event);
        }

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
    recalls(): WireEvent[] {
        return this.frames.filter((event) => event.detail_type === 'private_message_delete');
    }
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

async function poll(
    transport: V12Transport,
    echo = ECHO,
    onHead?: () => void,
    params: object = {},
): Promise<Response> {
    const request = new FakeRequest();
    const response = new FakeResponse();
    response.onHead = onHead;
    transport.handleRequest(
        request as unknown as IncomingMessage,
        response as unknown as ServerResponse,
    );
    request.emit(
        'data',
        Buffer.from(JSON.stringify({ action: 'get_latest_events', params, echo })),
    );
    request.emit('end');
    await settle();
    return response.json();
}

function ok(data: unknown[], echo = ECHO) {
    return { status: 'ok', retcode: 0, data, message: '', echo };
}

async function fixture(self = 10001, startOffline = false) {
    const uin = String(self);
    const generation = new sourceApi.SourceGeneration();

    if (!startOffline) {
        generation.setOnline(true);
    }

    const manager = new managerApi.OneBotNetworkManager();
    const errors: unknown[] = [];
    const bus = new busApi.BridgeEventBus({ onError: (_kind, error) => errors.push(error) });
    const api = vi.fn(forbidden);
    const sentTime = vi.fn(forbidden);
    // The actual event pipeline still owns capture/convert/remember/dispatch.
    // Its asynchronous durable-store boundary is an account-local in-memory map.
    const cache = new Map<string, number>();
    const key = (peer: number, sequence: number, bySelf: boolean) =>
        `${peer}:${sequence}:${bySelf}`;
    const recordPrivateRecall = vi.fn(
        async (peer: number, sequence: number, bySelf: boolean, _time: number) =>
            cache.get(key(peer, sequence, bySelf)) ?? null,
    );
    const handoffs: Array<{ event: JsonObject; ticket: V12Source | undefined }> = [];
    const verification: { before?: () => void } = {};
    let context!: OneBotInstanceContext;
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
            api: { handle: api } as never,
            buildLifecycleEvent: () => ({}),
            buildHeartbeatEvent: () => ({}),
        },
        {
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: sentTime,
            trackAction: (_label, start) => start(),
            canAccept: () => true,
            captureCurrentSource: () => generation.capture(runtime[sourceApi.captureBinding]()),
            isSourceCurrent: (source, binding) => {
                const current =
                    manager.get(identityApi.V12_ADAPTER_NAME) === runtime &&
                    generation.isCurrent(source, binding);
                verification.before?.();
                return current;
            },
            getPrivateRecallSource: (event) => recallApi.getPrivateRecallSource(context, event),
        },
    );
    const legacy = new (class extends adapterApi.IOneBotNetworkAdapter<NetworkBase> {
        readonly frames: string[] = [];
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
        onEvent(_event: JsonObject, payload: DispatchPayload): void {
            this.frames.push(payload.arrayJson);
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
    legacy.open();
    const index = fake.transports.length;
    await runtime.open();
    expect(fake.transports).toHaveLength(index + 1);
    const transport = fake.transports[index]!;
    expect(transport.options.httpPoll).toBeDefined();
    const peer = connect(transport.instance);
    context = {
        uin,
        selfId: self,
        bridge: { events: bus } as never,
        messageStore: { recordPrivateRecall } as never,
        mediaStore: {} as never,
        reactionStore: {} as never,
        tempSessions: {} as never,
        converterCtx: {
            selfId: self,
            imageUrlResolver: null,
            mediaUrlResolver: null,
            messageIdResolver: null,
            mediaSegmentSink: null,
        },
        config: {
            networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
        } as never,
        getUptimeMs: () => 0,
        cacheMessageMeta: () => {},
        [sourceApi.captureSource]: () => generation.capture(runtime[sourceApi.captureBinding]()),
        dispatchEvent: (event, _source, _startedAt, ticket) => {
            handoffs.push({ event, ticket });
            const admission = sourceApi.claimOrderedScope(context, 'context', event);
            const emit = () => manager.emitEvent(event, ticket);
            return admission
                ? sourceApi.withOrderedScope(manager, 'manager', event, admission, emit)
                : emit();
        },
    } as OneBotInstanceContext;
    const pipeline = pipelineApi.registerEventPipeline(context);
    fixtures.push({ pipeline, bus, manager, api, sentTime, errors });
    return {
        self,
        uin,
        generation,
        manager,
        runtime,
        context,
        transport,
        peer,
        legacy,
        bus,
        handoffs,
        verification,
        recordPrivateRecall,
        seed(sequence: number, bySelf: boolean, id: number) {
            cache.set(key(PEER, sequence, bySelf), id);
        },
    };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function raw(f: Fixture, sequence: number, bySelf: boolean): Recall {
    return {
        kind: 'friend_recall',
        time: TIME,
        selfUin: f.self,
        userUin: PEER,
        msgSeq: sequence + 1,
        clientSeq: sequence,
        recalledBySelf: bySelf,
    };
}

function textMessage(f: Fixture, id: number, time: number): JsonObject {
    return {
        post_type: 'message',
        self_id: f.self,
        user_id: PEER,
        message_id: id,
        time,
        message_type: 'private',
        sub_type: 'friend',
        raw_message: `synthetic-text-${id}`,
        message: [{ type: 'text', data: { text: `synthetic-text-${id}` } }],
    };
}

function expectedV11(f: Fixture, id: number): JsonObject {
    return {
        time: TIME,
        self_id: f.self,
        post_type: 'notice',
        notice_type: 'friend_recall',
        user_id: PEER,
        message_id: id,
    };
}

function assertPrivateMetadata(event: JsonObject, ws: WireEvent, result: Response): void {
    expect(Reflect.ownKeys(event)).toEqual([
        'time',
        'self_id',
        'post_type',
        'notice_type',
        'user_id',
        'message_id',
    ]);
    expect(Object.getOwnPropertySymbols(event)).toEqual([]);
    expect(Reflect.ownKeys(ws).sort()).toEqual(
        ['detail_type', 'id', 'message_id', 'self', 'sub_type', 'time', 'type', 'user_id'].sort(),
    );
    const wire = `${JSON.stringify(ws)} ${JSON.stringify(result)}`;

    for (const privateName of [
        'sourceTicket',
        'clientSequence',
        'clientSeq',
        'msgSeq',
        'recalledBySelf',
        'privateRecallPollProof',
        TOKEN,
    ]) {
        expect(wire).not.toContain(privateName);
    }
}

describe('private recall on production scoped HTTP owner (no sockets)', () => {
    it.each([
        [false, -2147483648, String(PEER)],
        [true, -123456789, '10001'],
    ] as const)(
        'admits the first event after WS for direction %s and signed id %s',
        async (bySelf, id, userId) => {
            // Open while the source is offline, then make the source current
            // without invoking statusUpdate or any polling/warm-up action.
            const f = await fixture(10001, true);
            expect(ownerApi.hasHttpPollOwner(f.runtime)).toBe(false);
            f.generation.setOnline(true);
            expect(f.generation.capture(f.runtime[sourceApi.captureBinding]())).toBeDefined();
            expect(ownerApi.hasHttpPollOwner(f.runtime)).toBe(false);
            f.seed(445, bySelf, id);
            const callsAtWs: number[] = [];
            f.peer.onRecall = () => callsAtWs.push(scopedRecall.mock.calls.length);
            await f.bus.emit(raw(f, 445, bySelf));
            expect(f.recordPrivateRecall).toHaveBeenCalledExactlyOnceWith(PEER, 445, bySelf, TIME);
            expect(f.handoffs).toHaveLength(1);
            const { event, ticket } = f.handoffs[0]!;
            expect(ticket).toBeDefined();
            expect(event).toEqual(expectedV11(f, id));
            expect(f.legacy.frames.map((frame) => JSON.parse(frame))).toEqual([expectedV11(f, id)]);
            const ws = f.peer.recalls();
            expect(ws).toHaveLength(1);
            expect(ws[0]).toEqual({
                id: expect.any(String),
                time: TIME,
                type: 'notice',
                detail_type: 'private_message_delete',
                sub_type: '',
                self: { platform: 'qq', user_id: f.uin },
                message_id: String(id),
                user_id: userId,
            });
            expect(callsAtWs).toEqual([0]);
            expect(ownerApi.hasHttpPollOwner(f.runtime)).toBe(true);
            expect(scopedRecall).toHaveBeenCalledOnce();
            const [candidate, proof, exactTicket] = scopedRecall.mock.calls[0]!;
            expect(candidate).toEqual(ws[0]);
            expect(exactTicket).toBe(ticket);
            expect(recallApi.getPrivateRecallSource(f.context, event)?.sourceTicket).toBe(ticket);
            expect(recallApi.isPrivateRecallPollProofCurrent(proof)).toBe(true);
            expect(recallApi.isPrivateRecallPollProofFor(proof, candidate)).toBe(true);
            expect(
                recallApi.isPrivateRecallPollProofBoundTo(proof, ticket, {
                    platform: 'qq',
                    user_id: f.uin,
                }),
            ).toBe(true);
            const result = await poll(f.transport.instance);
            expect(result).toEqual(ok([ws[0]]));
            assertPrivateMetadata(event, ws[0]!, result);
            expect(await poll(f.transport.instance, 'drained')).toEqual(ok([], 'drained'));
        },
    );

    it('polls the real recall through the SDK and an in-memory fetch into the real HTTP handler', async () => {
        const f = await fixture();
        const id = -2147483648;
        f.seed(460, true, id);
        await f.bus.emit(raw(f, 460, true));
        expect(f.legacy.frames.map((frame) => JSON.parse(frame))).toEqual([expectedV11(f, id)]);
        expect(f.peer.recalls()).toHaveLength(1);
        const ws = f.peer.recalls()[0]!;
        expect(ws).toMatchObject({
            type: 'notice',
            detail_type: 'private_message_delete',
            self: { platform: 'qq', user_id: f.uin },
            message_id: String(id),
            user_id: f.uin,
        });
        expect(scopedRecall).toHaveBeenCalledOnce();
        const [candidate, proof, ticket] = scopedRecall.mock.calls[0]!;
        expect(candidate).toEqual(ws);
        expect(recallApi.isPrivateRecallPollProofCurrent(proof)).toBe(true);
        expect(recallApi.isPrivateRecallPollProofFor(proof, candidate)).toBe(true);
        expect(ticket).toBe(f.handoffs[0]?.ticket);

        const endpoint = 'http://sdk-recall.fixture.invalid/';
        const sdkEcho = 'synthetic-sdk-recall-echo-中文-7e2b';
        const bodies: string[] = [];
        const serverBodies: string[] = [];
        const memoryFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            expect(input).toBe(endpoint);
            expect(init?.method).toBe('POST');
            expect(init?.redirect).toBe('error');

            if (typeof init?.body !== 'string') {
                throw new Error('SDK did not serialize a JSON request body');
            }

            if (init.method !== 'POST') {
                throw new Error('SDK did not issue a POST request');
            }

            const headers = new Headers(init.headers);
            expect(headers.get('content-type')).toBe('application/json');
            expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
            const request = new FakeRequest();
            request.method = init.method;
            const pairs = Array.from(headers.entries());
            request.headers = Object.fromEntries(pairs);
            request.rawHeaders = pairs.flatMap(([name, value]) => [name, value]);
            const response = new FakeResponse();
            f.transport.instance.handleRequest(
                request as unknown as IncomingMessage,
                response as unknown as ServerResponse,
            );
            // Forward the exact SDK-produced UTF-8 body; never parse/rebuild it.
            bodies.push(init.body);
            request.emit('data', Buffer.from(init.body, 'utf8'));
            request.emit('end');
            await settle();
            expect(response.status).toBe(200);
            expect(response.bodies).toHaveLength(1);
            const body = response.bodies[0]!;
            serverBodies.push(body);
            return new globalThis.Response(body, {
                status: response.status,
                headers: { 'content-type': 'application/json' },
            });
        });
        const { OneBot12HttpClient } = await import('../../../sdk/src/v12/http-client.js');
        const client = new OneBot12HttpClient({
            baseUrl: endpoint,
            accessToken: TOKEN,
            fetch: memoryFetch,
            requestTimeoutMs: 0,
        });
        const result = await client.getLatestEvents(
            { limit: 1, timeout: 0 },
            { self: { platform: 'qq', user_id: f.uin }, echo: sdkEcho },
        );
        expect(memoryFetch).toHaveBeenCalledOnce();
        expect(bodies).toHaveLength(1);
        expect(JSON.parse(bodies[0]!)).toEqual({
            action: 'get_latest_events',
            params: { limit: 1, timeout: 0 },
            self: { platform: 'qq', user_id: f.uin },
            echo: sdkEcho,
        });
        expect(serverBodies).toHaveLength(1);
        expect(result).toEqual(JSON.parse(serverBodies[0]!));
        expect(result).toEqual(ok([ws], sdkEcho));
        expect(guardedCommit).toHaveBeenCalledOnce();
    });

    it('deduplicates the exact event and ticket across reentry and replay', async () => {
        const f = await fixture();
        f.seed(446, false, -110);
        let reentered = false;

        f.verification.before = () => {
            const first = f.handoffs[0];

            if (!reentered && first?.ticket) {
                reentered = true;
                void f.runtime[sourceApi.receiveSourceEvent](
                    first.event,
                    filterApi.buildDispatchPayload(first.event),
                    first.ticket,
                );
            }
        };

        await f.bus.emit(raw(f, 446, false));
        f.verification.before = undefined;
        expect(reentered).toBe(true);
        const first = f.handoffs[0]!;

        if (!first.ticket) {
            throw new Error('missing real source ticket');
        }

        await f.runtime[sourceApi.receiveSourceEvent](
            first.event,
            filterApi.buildDispatchPayload(first.event),
            first.ticket,
        );
        expect(f.legacy.frames).toHaveLength(1);
        expect(f.peer.recalls()).toHaveLength(1);
        expect(scopedRecall).toHaveBeenCalledOnce();
        expect(await poll(f.transport.instance)).toEqual(ok([f.peer.recalls()[0]]));
        expect(await poll(f.transport.instance, 'dedup-drained')).toEqual(ok([], 'dedup-drained'));
    });

    it('excludes a prepared ordered scope and remembers its event/ticket even outside that scope later', async () => {
        const f = await fixture();
        const ordinaryTicket = f.generation.capture(f.runtime[sourceApi.captureBinding]());

        if (!ordinaryTicket) {
            throw new Error('missing ordinary source ticket');
        }

        // Establish the real completion-order owner and an ordinary queued item
        // before preparing, but do not install, the separate ordered context.
        await f.manager.emitEvent(textMessage(f, 301, 10), ordinaryTicket);
        expect(ownerApi.hasHttpPollOwner(f.runtime)).toBe(true);
        const ordinary = f.peer.frames.find((event) => event.type === 'message');
        expect(ordinary).toBeDefined();
        const before = ownerApi.pollOwnerStats(f.runtime);
        expect(before).toMatchObject({
            active: true,
            accepted: 1,
            invalid: 0,
            full: 0,
            too_large: 0,
            admission_uncertain: 0,
            dropped_oldest: '0',
        });
        sourceApi.prepareOrderedContext(f.context, f.runtime);
        expect(sourceApi.reserveOrderedContext(f.context)).toMatchObject({
            kind: 'not_eligible',
            target: f.runtime,
        });
        const native = raw(f, 459, false);
        f.seed(459, false, -127);
        await f.bus.emit(native);
        const first = f.handoffs[0];

        if (!first?.ticket) {
            throw new Error('missing original provenance ticket');
        }

        const ticketA = first.ticket;
        expect(recallApi.getPrivateRecallSource(f.context, first.event)?.sourceTicket).toBe(
            ticketA,
        );
        expect(f.peer.recalls()).toHaveLength(1);
        expect(f.peer.recalls()[0]).toMatchObject({ message_id: '-127', user_id: String(PEER) });
        expect(
            f.legacy.frames
                .map((frame) => JSON.parse(frame))
                .filter((event) => event.notice_type === 'friend_recall'),
        ).toEqual([expectedV11(f, -127)]);
        expect(scopedRecall).not.toHaveBeenCalled();
        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
            active: true,
            accepted: 1,
            invalid: 0,
            full: 0,
            too_large: 0,
            admission_uncertain: 0,
            dropped_oldest: '0',
        });
        expect(await poll(f.transport.instance, 'prepared-ordinary')).toEqual(
            ok([ordinary], 'prepared-ordinary'),
        );
        expect(await poll(f.transport.instance, 'prepared-no-recall')).toEqual(
            ok([], 'prepared-no-recall'),
        );

        // Deliver the exact same v11 object outside the prepared scope with a
        // genuinely captured B ticket, then rebind A. No private cell is removed:
        // direct runtime receives have no prepared admission frame to claim.
        const ticketB = f.generation.capture(f.runtime[sourceApi.captureBinding]());

        if (!ticketB) {
            throw new Error('missing second source ticket');
        }

        expect(ticketB).not.toBe(ticketA);
        expect(sourceApi.sameSourceEpoch(ticketA, ticketB)).toBe('same');
        const snapshotB = recallApi.capturePrivateRecallSource(f.context, native, ticketB);
        expect(recallApi.rememberPrivateRecallSource(f.context, first.event, snapshotB, -127)).toBe(
            true,
        );
        await f.runtime[sourceApi.receiveSourceEvent](
            first.event,
            filterApi.buildDispatchPayload(first.event),
            ticketB,
        );
        expect(f.peer.recalls()).toHaveLength(2);
        expect(scopedRecall).toHaveBeenCalledOnce();
        expect(scopedRecall.mock.calls[0]?.[2]).toBe(ticketB);
        expect(await poll(f.transport.instance, 'outside-b')).toEqual(
            ok([f.peer.recalls()[1]], 'outside-b'),
        );
        const snapshotA = recallApi.capturePrivateRecallSource(f.context, native, ticketA);
        expect(recallApi.rememberPrivateRecallSource(f.context, first.event, snapshotA, -127)).toBe(
            true,
        );
        await f.runtime[sourceApi.receiveSourceEvent](
            first.event,
            filterApi.buildDispatchPayload(first.event),
            ticketA,
        );
        // WS retains its existing most-recent-ticket behavior; HTTP's independent
        // exact-pair marker prevents A from being attempted after exclusion.
        expect(f.peer.recalls()).toHaveLength(3);
        expect(scopedRecall).toHaveBeenCalledOnce();
        expect(await poll(f.transport.instance, 'outside-a-again')).toEqual(
            ok([], 'outside-a-again'),
        );
    });

    it('does not attempt A twice after A, B, A exact tickets on the same local event', async () => {
        const f = await fixture();
        const native = raw(f, 450, false);
        f.seed(450, false, -114);
        await f.bus.emit(native);
        const first = f.handoffs[0]!;
        const ticketA = first.ticket;
        const ticketB = f.generation.capture(f.runtime[sourceApi.captureBinding]());

        if (!ticketA || !ticketB) {
            throw new Error('missing synthetic source tickets');
        }

        expect(ticketB).not.toBe(ticketA);
        expect(sourceApi.sameSourceEpoch(ticketA, ticketB)).toBe('same');
        expect(scopedRecall).toHaveBeenCalledOnce();
        // Commit A before rebinding: otherwise remember() intentionally invalidates
        // the previously queued proof, confounding attempt dedup with pruning.
        expect(await poll(f.transport.instance, 'ticket-a')).toEqual(
            ok([f.peer.recalls()[0]], 'ticket-a'),
        );
        const snapshotB = recallApi.capturePrivateRecallSource(f.context, native, ticketB);
        expect(recallApi.rememberPrivateRecallSource(f.context, first.event, snapshotB, -114)).toBe(
            true,
        );
        await f.runtime[sourceApi.receiveSourceEvent](
            first.event,
            filterApi.buildDispatchPayload(first.event),
            ticketB,
        );
        expect(scopedRecall).toHaveBeenCalledTimes(2);
        expect(await poll(f.transport.instance, 'ticket-b')).toEqual(
            ok([f.peer.recalls()[1]], 'ticket-b'),
        );
        const snapshotA = recallApi.capturePrivateRecallSource(f.context, native, ticketA);
        expect(recallApi.rememberPrivateRecallSource(f.context, first.event, snapshotA, -114)).toBe(
            true,
        );
        await f.runtime[sourceApi.receiveSourceEvent](
            first.event,
            filterApi.buildDispatchPayload(first.event),
            ticketA,
        );
        expect(scopedRecall).toHaveBeenCalledTimes(2);
        expect(scopedRecall.mock.calls.map((call) => call[2])).toEqual([ticketA, ticketB]);
        // Existing WS last-ticket behavior is independent of HTTP attempt dedup.
        expect(f.peer.recalls()).toHaveLength(3);
        expect(await poll(f.transport.instance, 'ticket-a-again')).toEqual(
            ok([], 'ticket-a-again'),
        );
        expect(f.legacy.frames).toHaveLength(1);
    });

    it('prunes a genuinely admitted proof if the original event changes before poll', async () => {
        const f = await fixture();
        f.seed(451, false, -115);
        await f.bus.emit(raw(f, 451, false));
        const call = scopedRecall.mock.calls[0];

        if (!call) {
            throw new Error('missing real scoped recall admission');
        }

        expect(recallApi.isPrivateRecallPollProofCurrent(call[1])).toBe(true);
        f.handoffs[0]!.event.message_id = -999;
        expect(recallApi.isPrivateRecallPollProofCurrent(call[1])).toBe(false);
        expect(f.peer.recalls()).toHaveLength(1);
        expect(f.legacy.frames.map((frame) => JSON.parse(frame))).toEqual([expectedV11(f, -115)]);
        // The guarded transaction reports a pruned selection as unavailable;
        // a separate subsequent request observes the now-empty queue.
        expect(await poll(f.transport.instance, 'stale-proof')).toMatchObject({
            status: 'failed',
            retcode: 20002,
            data: null,
            echo: 'stale-proof',
        });
        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({ stale_pruned: 1 });
        expect(await poll(f.transport.instance, 'after-prune')).toEqual(ok([], 'after-prune'));
    });

    it.each(['mutate-original', 'rotate-source'] as const)(
        'keeps WS and v11 fanout but omits HTTP when %s happens in the WS callback',
        async (fault) => {
            const f = await fixture();
            f.seed(447, false, -111);
            let called = 0;

            f.peer.onRecall = () => {
                called += 1;
                expect(scopedRecall).not.toHaveBeenCalled();

                if (fault === 'mutate-original') {
                    f.handoffs[0]!.event.message_id = -999;
                } else {
                    f.generation.setOnline(false);
                    f.generation.setOnline(true);
                }
            };

            await f.bus.emit(raw(f, 447, false));
            await settle();
            expect(called).toBe(1);
            expect(f.peer.recalls()).toHaveLength(1);
            expect(f.peer.recalls()[0]).toMatchObject({
                message_id: '-111',
                user_id: String(PEER),
            });
            expect(f.legacy.frames.map((frame) => JSON.parse(frame))).toEqual([
                expectedV11(f, -111),
            ]);
            expect(scopedRecall).not.toHaveBeenCalled();

            if (fault === 'rotate-source') {
                f.runtime.statusUpdate();
                await settle();
            }

            expect(await poll(f.transport.instance, 'lost-proof')).toEqual(ok([], 'lost-proof'));
        },
    );

    it('prunes only stale R1 from a selected ordinary-A/R1/ordinary-B/R2 prefix', async () => {
        const f = await fixture();
        const ticket = f.generation.capture(f.runtime[sourceApi.captureBinding]());

        if (!ticket) {
            throw new Error('missing ordinary source ticket');
        }

        f.seed(453, false, -121);
        f.seed(454, true, -122);
        await f.manager.emitEvent(textMessage(f, 201, 10), ticket);
        await f.bus.emit(raw(f, 453, false));
        await f.manager.emitEvent(textMessage(f, 202, 20), ticket);
        await f.bus.emit(raw(f, 454, true));
        const ws = f.peer.frames.filter((event) => event.type !== 'meta');
        expect(ws).toHaveLength(4);
        expect(f.legacy.frames).toHaveLength(4);
        expect(scopedRecall).toHaveBeenCalledTimes(2);
        const original = bufferApi.EventPollBuffer.prototype.reserveGuarded;
        let selectedCount = 0;
        let didMutate = false;
        // Change the original v11 binding only after the real queue has chosen
        // its prefix, before the real guarded commit checks every proof.
        vi.spyOn(bufferApi.EventPollBuffer.prototype, 'reserveGuarded').mockImplementationOnce(
            function (this: InstanceType<typeof bufferApi.EventPollBuffer>, options) {
                return (
                    Reflect.apply(original, this, [options]) as Promise<GuardedPollResult>
                ).then((selection) => {
                    if (selection.status === 'reserved') {
                        selectedCount = selection.count;
                        f.handoffs[0]!.event.message_id = -999;
                        didMutate = true;
                    }

                    return selection;
                });
            },
        );
        expect(await poll(f.transport.instance, 'prune-selected')).toMatchObject({
            status: 'failed',
            retcode: 20002,
            data: null,
            echo: 'prune-selected',
        });
        expect(didMutate).toBe(true);
        expect(selectedCount).toBe(4);
        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({ stale_pruned: 1 });
        expect(await poll(f.transport.instance, 'remaining')).toEqual(
            ok([ws[0], ws[2], ws[3]], 'remaining'),
        );
        expect(await poll(f.transport.instance, 'remaining-drained')).toEqual(
            ok([], 'remaining-drained'),
        );
    });

    it('does not requeue a committed recall when writeHead mutates the original v11 event', async () => {
        const f = await fixture();
        f.seed(455, false, -123);
        await f.bus.emit(raw(f, 455, false));
        const ws = f.peer.recalls()[0];
        let mutatedAfterCommit = false;
        const result = await poll(f.transport.instance, 'head-mutation', () => {
            expect(guardedCommit).toHaveBeenCalledOnce();
            f.handoffs[0]!.event.message_id = -999;
            mutatedAfterCommit = true;
        });
        expect(mutatedAfterCommit).toBe(true);
        expect(result).toEqual(ok([ws], 'head-mutation'));
        expect(f.peer.recalls()).toHaveLength(1);
        expect(f.legacy.frames.map((frame) => JSON.parse(frame))).toEqual([expectedV11(f, -123)]);
        expect(await poll(f.transport.instance, 'head-drained')).toEqual(ok([], 'head-drained'));
        expect(guardedCommit).toHaveBeenCalledOnce();
    });

    it('selects a WS-reentrant ordinary event before the later HTTP recall admission', async () => {
        const f = await fixture();
        f.seed(456, false, -124);
        let reentered = false;

        f.peer.onRecall = () => {
            if (reentered) {
                return;
            }

            const ticket = f.handoffs[0]?.ticket;

            if (!ticket) {
                throw new Error('missing recall source ticket');
            }

            reentered = true;
            const laterTime = textMessage(f, 203, TIME + 20);
            void f.runtime[sourceApi.receiveSourceEvent](
                laterTime,
                filterApi.buildDispatchPayload(laterTime),
                ticket,
            );
        };

        await f.bus.emit(raw(f, 456, false));
        expect(reentered).toBe(true);
        const ordinary = f.peer.frames.find((event) => event.type === 'message');
        const recall = f.peer.recalls()[0];
        expect(ordinary).toBeDefined();
        expect(recall).toBeDefined();
        expect(ordinary!.time).toBeGreaterThan(recall!.time);
        expect(scopedRecall).toHaveBeenCalledOnce();
        expect(await poll(f.transport.instance, 'fifo-head', undefined, { limit: 1 })).toEqual(
            ok([ordinary], 'fifo-head'),
        );
        expect(await poll(f.transport.instance, 'fifo-tail', undefined, { limit: 1 })).toEqual(
            ok([recall], 'fifo-tail'),
        );
    });

    it('rechecks source after the final true listener-readiness callback invalidates its epoch', async () => {
        const f = await fixture(10001, true);
        f.generation.setOnline(true);
        expect(ownerApi.hasHttpPollOwner(f.runtime)).toBe(false);
        f.seed(457, false, -125);
        const scopedFactory = vi.spyOn(bufferApi.EventPollBuffer, 'scoped');
        const slot = f.runtime as unknown as {
            activateHttpPoll: (guard: () => boolean) => { status: string; owner?: object };
        };
        const originalActivate = slot.activateHttpPoll;
        const activations: Array<{ status: string; owner?: object }> = [];
        let armed = false;
        vi.spyOn(slot, 'activateHttpPoll').mockImplementation(function (this: typeof slot, guard) {
            const result = Reflect.apply(originalActivate, this, [guard]);
            activations.push(result);

            if (result.status === 'ready') {
                armed = true;
            }

            return result;
        });
        const originalReady = f.transport.instance.isAcceptingActions;
        let readsAfterReady = 0;
        let fired = 0;
        let returnedReady: boolean | undefined;
        let sourceBefore = false;
        let sourceAfter = true;
        let bindingAtFlip: object | null = null;
        let bindingAfterFlip: object | null = null;
        let wsAtFlip = 0;
        let offlineVerifications = 0;

        f.verification.before = () => {
            if (fired > 0) {
                offlineVerifications += 1;
            }
        };

        const listener = vi
            .spyOn(f.transport.instance, 'isAcceptingActions')
            .mockImplementation(function (this: V12Transport) {
                const ready = Reflect.apply(originalReady, this, []) as boolean;

                if (armed && ++readsAfterReady === 2) {
                    const ticket = f.handoffs[0]?.ticket;
                    bindingAtFlip = f.runtime[sourceApi.captureBinding]();
                    sourceBefore = f.generation.isCurrent(ticket, bindingAtFlip);
                    wsAtFlip = f.peer.recalls().length;
                    returnedReady = ready;
                    fired += 1;
                    // Only the source epoch changes; this listener, its real true
                    // readiness, the active scope and binding references stay intact.
                    f.generation.setOnline(false);
                    bindingAfterFlip = f.runtime[sourceApi.captureBinding]();
                    sourceAfter = f.generation.isCurrent(ticket, bindingAfterFlip);
                }

                return ready;
            });

        try {
            await f.bus.emit(raw(f, 457, false));
            await settle();
            expect(activations.some((activation) => activation.status === 'ready')).toBe(true);
            expect(fired).toBe(1);
            expect(returnedReady).toBe(true);
            expect(sourceBefore).toBe(true);
            expect(sourceAfter).toBe(false);
            expect(bindingAtFlip).not.toBeNull();
            expect(bindingAfterFlip).toBe(bindingAtFlip);
            expect(f.runtime[sourceApi.captureBinding]()).toBe(bindingAtFlip);
            expect(offlineVerifications).toBeGreaterThan(0);
            expect(wsAtFlip).toBe(1);
            expect(f.peer.recalls()).toHaveLength(1);
            expect(f.legacy.frames.map((frame) => JSON.parse(frame))).toEqual([
                expectedV11(f, -125),
            ]);
            expect(scopedFactory).toHaveBeenCalledOnce();
            const result = scopedFactory.mock.results[0];

            if (!result || result.type !== 'return') {
                throw new Error('missing real scoped queue');
            }

            expect(result.value.stats()).toMatchObject({ count: 0, reserved: 0 });
            expect(scopedRecall).not.toHaveBeenCalled();
            expect(guardedCommit).not.toHaveBeenCalled();
            expect(fake.transports).toHaveLength(1);
            expect(await poll(f.transport.instance, 'offline-after-ready')).toMatchObject({
                status: 'failed',
                retcode: 20002,
                data: null,
                echo: 'offline-after-ready',
            });
        } finally {
            f.verification.before = undefined;
            listener.mockRestore();
        }
    });

    it('does not admit or evict when real upload-store close reenters recall during runtime.close', async () => {
        const scopedFactory = vi.spyOn(bufferApi.EventPollBuffer, 'scoped');
        const f = await fixture();
        expect(scopedFactory).toHaveBeenCalledOnce();
        const allocated = scopedFactory.mock.results[0];

        if (!allocated || allocated.type !== 'return') {
            throw new Error('missing actual scoped queue');
        }

        const scoped = allocated.value;
        const ticket = f.generation.capture(f.runtime[sourceApi.captureBinding]());

        if (!ticket) {
            throw new Error('missing original source ticket');
        }

        // Fill the actual production queue so a wrongly admitted recall would
        // evict an ordinary event under the real drop-oldest policy.
        for (let index = 0; index < 128; index += 1) {
            await f.manager.emitEvent(textMessage(f, 1000 + index, 1000 + index), ticket);
        }

        expect(scoped.stats()).toMatchObject({ count: 128, reserved: 0, closed: false });
        expect(scoped.oldestDropCount()).toBe(0n);
        const upload = await f.transport.options.handle({
            action: 'upload_file',
            params: { type: 'data', name: 'synthetic.txt', data: 'YQ==' },
        });
        expect(upload).toMatchObject({ status: 'ok', retcode: 0 });
        f.seed(458, false, -126);
        // Let the actual pipeline capture, consult the in-memory store, convert
        // and bind provenance, but hold its dispatch until store.close reenters.
        const dispatch = f.context.dispatchEvent;

        try {
            f.context.dispatchEvent = (event, _source, _startedAt, sourceTicket) => {
                f.handoffs.push({ event, ticket: sourceTicket });
            };

            await f.bus.emit(raw(f, 458, false));
        } finally {
            f.context.dispatchEvent = dispatch;
        }

        const handoff = f.handoffs[0];

        if (!handoff?.ticket) {
            throw new Error('missing real recall handoff');
        }

        const event = handoff.event;
        const recallTicket = handoff.ticket;
        const provenance = recallApi.getPrivateRecallSource(f.context, event);
        const selfDescriptor = Object.getOwnPropertyDescriptor(f.runtime, 'self');

        if (!provenance || !selfDescriptor || !('value' in selfDescriptor)) {
            throw new Error('missing real provenance or runtime self');
        }

        const self = selfDescriptor.value as { platform: 'qq'; user_id: string };
        const converted = recallApi.convertPrivateRecallEvent(event, self, provenance);

        if (!converted) {
            throw new Error('missing real converted recall');
        }

        const proof = recallApi.createPrivateRecallPollProof(
            event,
            provenance,
            recallTicket,
            self,
            converted,
        );
        expect(proof).toBeDefined();
        expect(recallApi.isPrivateRecallPollProofCurrent(proof)).toBe(true);
        const uploadedStore = await import('../../src/v12/uploaded-data-store');
        const originalClose = uploadedStore.V12UploadedDataStore.prototype.close;
        const observation: {
            calls: number;
            listener: boolean;
            source: boolean;
            proof: boolean;
            bindingBefore: object | null;
            bindingAfter: object | null;
            wsBefore: number;
            wsAfter: number;
            countBefore: number;
            countAfter: number;
            dropBefore: bigint;
            dropAfter: bigint;
        } = {
            calls: 0,
            listener: false,
            source: false,
            proof: false,
            bindingBefore: null,
            bindingAfter: null,
            wsBefore: 0,
            wsAfter: 0,
            countBefore: 0,
            countAfter: 0,
            dropBefore: -1n,
            dropAfter: -1n,
        };
        const close = vi
            .spyOn(uploadedStore.V12UploadedDataStore.prototype, 'close')
            .mockImplementationOnce(function (
                this: InstanceType<typeof uploadedStore.V12UploadedDataStore>,
            ) {
                try {
                    observation.calls += 1;
                    observation.listener = f.transport.instance.isAcceptingActions();
                    observation.bindingBefore = f.runtime[sourceApi.captureBinding]();
                    observation.source = f.generation.isCurrent(
                        recallTicket,
                        observation.bindingBefore,
                    );
                    observation.proof = recallApi.isPrivateRecallPollProofCurrent(proof);
                    observation.wsBefore = f.peer.recalls().length;
                    observation.countBefore = scoped.stats().count;
                    observation.dropBefore = scoped.oldestDropCount();
                    void f.runtime[sourceApi.receiveSourceEvent](
                        event,
                        filterApi.buildDispatchPayload(event),
                        recallTicket,
                    );
                    observation.wsAfter = f.peer.recalls().length;
                    observation.countAfter = scoped.stats().count;
                    observation.dropAfter = scoped.oldestDropCount();
                    observation.bindingAfter = f.runtime[sourceApi.captureBinding]();
                } finally {
                    // The actual in-memory upload store still gets its real cleanup.
                    Reflect.apply(originalClose, this, []);
                }
            });
        await f.runtime.close();
        await settle();
        expect(close).toHaveBeenCalledOnce();
        expect(observation).toMatchObject({
            calls: 1,
            listener: true,
            source: true,
            proof: true,
            wsBefore: 0,
            wsAfter: 1,
            countBefore: 128,
            countAfter: 128,
            dropBefore: 0n,
            dropAfter: 0n,
        });
        expect(observation.bindingBefore).not.toBeNull();
        expect(observation.bindingAfter).toBe(observation.bindingBefore);
        expect(f.peer.recalls()).toHaveLength(1);
        expect(f.peer.recalls()[0]).toMatchObject({ message_id: '-126', user_id: String(PEER) });
        expect(scopedRecall).not.toHaveBeenCalled();
        expect(guardedCommit).not.toHaveBeenCalled();
    });

    it('rechecks the exact listener after a genuinely ready activation before recall admission', async () => {
        const f = await fixture(10001, true);
        f.generation.setOnline(true);
        expect(ownerApi.hasHttpPollOwner(f.runtime)).toBe(false);
        f.seed(452, false, -116);
        const slot = f.runtime as unknown as {
            activateHttpPoll: (guard: () => boolean) => { status: string; owner?: object };
        };
        const originalActivate = slot.activateHttpPoll;
        const activations: Array<{ status: string; owner?: object }> = [];
        let armed = false;
        vi.spyOn(slot, 'activateHttpPoll').mockImplementation(function (this: typeof slot, guard) {
            const result = Reflect.apply(originalActivate, this, [guard]);
            activations.push(result);

            if (result.status === 'ready') {
                armed = true;
            }

            return result;
        });
        const originalAccepting = f.transport.instance.isAcceptingActions;
        let accepting = true;
        const listener = vi
            .spyOn(f.transport.instance, 'isAcceptingActions')
            .mockImplementation(function (this: V12Transport) {
                return accepting && Reflect.apply(originalAccepting, this, []);
            });
        let flipped = false;
        let sourceAtFlip = false;
        let ownerAtFlip = false;
        let listenerBeforeFlip = false;
        let wsAtFlip = 0;

        f.verification.before = () => {
            if (armed && !flipped) {
                const ticket = f.handoffs[0]?.ticket;
                sourceAtFlip = f.generation.isCurrent(
                    ticket,
                    f.runtime[sourceApi.captureBinding](),
                );
                ownerAtFlip = ownerApi.hasHttpPollOwner(f.runtime);
                listenerBeforeFlip = f.transport.instance.isAcceptingActions();
                wsAtFlip = f.peer.recalls().length;
                accepting = false;
                flipped = true;
            }
        };

        try {
            await f.bus.emit(raw(f, 452, false));
            await settle();
            expect(activations.some((activation) => activation.status === 'ready')).toBe(true);
            expect(flipped).toBe(true);
            expect(sourceAtFlip).toBe(true);
            expect(ownerAtFlip).toBe(true);
            expect(listenerBeforeFlip).toBe(true);
            expect(wsAtFlip).toBe(1);
            expect(f.transport.instance.isAcceptingActions()).toBe(false);
            expect(f.peer.recalls()).toHaveLength(1);
            expect(f.legacy.frames.map((frame) => JSON.parse(frame))).toEqual([
                expectedV11(f, -116),
            ]);
            expect(scopedRecall).not.toHaveBeenCalled();
            expect(guardedCommit).not.toHaveBeenCalled();
            expect(fake.transports).toHaveLength(1);
        } finally {
            f.verification.before = undefined;
            listener.mockRestore();
        }
    });

    it('keeps the real scoped proofs and HTTP queues isolated across two accounts', async () => {
        const a = await fixture(10001);
        const b = await fixture(10002);
        a.seed(448, false, -211);
        b.seed(449, true, -212);
        await a.bus.emit(raw(a, 448, false));
        await b.bus.emit(raw(b, 449, true));
        expect(a.peer.recalls()).toHaveLength(1);
        expect(b.peer.recalls()).toHaveLength(1);
        expect(a.legacy.frames).toHaveLength(1);
        expect(b.legacy.frames).toHaveLength(1);
        expect(scopedRecall).toHaveBeenCalledTimes(2);
        const aCall = scopedRecall.mock.calls[0]!;
        const bQueue = scopedRecall.mock.contexts[1];

        if (!(bQueue instanceof bufferApi.EventPollBuffer)) {
            throw new Error('missing actual second scoped queue');
        }

        const before = bQueue.stats();
        // Present the exact, real A proof and ticket to B's real queue; no proof
        // is fabricated and a rejection must leave B's original item untouched.
        expect(bQueue.enqueueScopedRecall(aCall[0], aCall[1], aCall[2])).toBe('invalid');
        expect(bQueue.stats()).toEqual(before);
        expect(await poll(a.transport.instance, 'account-a')).toEqual(
            ok([a.peer.recalls()[0]], 'account-a'),
        );
        expect(await poll(b.transport.instance, 'account-b')).toEqual(
            ok([b.peer.recalls()[0]], 'account-b'),
        );
        expect(a.peer.recalls()[0]?.self.user_id).toBe(a.uin);
        expect(b.peer.recalls()[0]?.self.user_id).toBe(b.uin);
        expect(b.peer.recalls()[0]?.user_id).toBe(b.uin);
    });
});
