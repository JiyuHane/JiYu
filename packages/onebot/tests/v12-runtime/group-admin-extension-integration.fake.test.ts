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
import workerThreads from 'node:worker_threads';
import type { GroupAdmin as GroupAdminWire } from '@snowluma/proto-defs/notify';
import { protobuf_encode } from '@snowluma/proton';
import type { QQEventVariant } from '@snowluma/protocol/events';
import type { MsgPushContext } from '@snowluma/protocol/msg-push/context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchPayload } from '../../src/event-filter';
import type { JsonObject, NetworkBase } from '../../src/types';
import type { V12Transport, V12TransportOptions } from '../../src/v12-network';
import type { V12Runtime } from '../../src/v12-runtime/runtime';
import type { V12Source } from '../../src/v12-runtime/source-generation';

// Synthetic values only. qq.group_admin_change is a Jiyu extension, not a
// standard v12 event and not a claim about upstream authenticity or delivery.
type GroupAdmin = Extract<QQEventVariant, { kind: 'group_admin' }>;
type Captured = { options: V12TransportOptions; instance: V12Transport };
type Guard = { mock: { calls: unknown[] } };
const fake = vi.hoisted(() => ({
    transports: [] as Captured[],
    peer: null as FakePeer | null,
    violations: [] as string[],
    warnings: [] as unknown[][],
}));
const TOKEN = 'SYNTHETIC_GROUP_ADMIN_TOKEN_649f';
const GROUP = 30001;
const USER = 20001;
const TIME = 1_700_000_001.5;

// The real transport's open is the sole transport override; its attach,
// subscriber, request handler and scoped polling use in-memory boundaries.
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
            fake.violations.push('WebSocket construction');
            throw new Error('unexpected WebSocket');
        }
    },
    WebSocketServer: class {
        constructor(options: { noServer?: boolean }) {
            if (options?.noServer !== true) {
                fake.violations.push('WebSocket listener');
                throw new Error('unexpected listener');
            }
        }
        handleUpgrade(
            _request: unknown,
            _socket: unknown,
            _head: unknown,
            accept: (peer: unknown) => void,
        ) {
            if (!fake.peer) {
                fake.violations.push('unexpected upgrade');
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
        warn: (...args: unknown[]) => fake.warnings.push(args),
        error: (...args: unknown[]) => fake.warnings.push(args),
    };
    return { createLogger: () => logger, runWithTraceRequest: <T>(start: () => T): T => start() };
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

let converters: typeof import('../../src/event-converter/to-notice');
let eventsApi: typeof import('../../src/v12/events');
let filterApi: typeof import('../../src/event-filter');
let sourceApi: typeof import('../../src/v12-runtime/source-generation');
let bufferApi: typeof import('../../src/v12-runtime/event-poll-buffer');
let runtimeApi: typeof import('../../src/v12-runtime/runtime');
let managerApi: typeof import('../../src/network/network-manager');
let adapterApi: typeof import('../../src/network/adapter');
let identityApi: typeof import('../../src/v12-runtime/identity');
let queue: ReturnType<typeof instrumentQueue>;
let guards: Guard[];
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
const fixtures: Array<{
    manager: import('../../src/network/network-manager').OneBotNetworkManager;
    api: ReturnType<typeof vi.fn>;
    sentTime: ReturnType<typeof vi.fn>;
}> = [];

function instrumentQueue(module: typeof import('../../src/v12-runtime/event-poll-buffer')) {
    return {
        scoped: vi.spyOn(module.EventPollBuffer, 'scoped'),
        enqueue: vi.spyOn(module.EventPollBuffer.prototype, 'enqueue'),
        reserve: vi.spyOn(module.EventPollBuffer.prototype, 'reserveGuarded'),
        commit: vi.spyOn(module.EventPollBuffer.prototype, 'commitGuardedNoDrain'),
        resume: vi.spyOn(module.EventPollBuffer.prototype, 'resumeGuardedDrain'),
    };
}

function forbidden(): never {
    throw new Error('unexpected network, process, native, account or plugin operation');
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    vi.stubEnv('SNOWLUMA_LOG_FILE', '0');
    fake.transports.length = 0;
    fake.violations.length = 0;
    fake.warnings.length = 0;
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
    const names = [
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

        for (const name of names) {
            if (typeof methods[name] === 'function') {
                guards.push(vi.spyOn(methods, name).mockImplementation(forbidden));
            }
        }
    }

    bufferApi = await import('../../src/v12-runtime/event-poll-buffer');
    queue = instrumentQueue(bufferApi);
    sourceApi = await import('../../src/v12-runtime/source-generation');
    filterApi = await import('../../src/event-filter');
    converters = await import('../../src/event-converter/to-notice');
    eventsApi = await import('../../src/v12/events');
    adapterApi = await import('../../src/network/adapter');
    managerApi = await import('../../src/network/network-manager');
    identityApi = await import('../../src/v12-runtime/identity');
    runtimeApi = await import('../../src/v12-runtime/runtime');
});
afterEach(async () => {
    let cleanupFailed = false;
    const resources = fixtures.splice(0);

    try {
        for (const f of resources) {
            try {
                const result = await f.manager.shutdown();
                cleanupFailed ||= !result.closed;
            } catch {
                cleanupFailed = true;
            }
        }

        await settle();
    } finally {
        const calls = guards.map((guard) => guard.mock.calls.length);
        const backend = resources.flatMap((f) => [
            f.api.mock.calls.length,
            f.sentTime.mock.calls.length,
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
type WireEvent = {
    id: string;
    time: number;
    type: string;
    detail_type: string;
    sub_type: string;
    self: { platform: string; user_id: string };
    group_id: string;
    user_id: string;
    is_admin: boolean;
};
type WireResponse = {
    status: string;
    retcode: number;
    data: unknown;
    message: string;
    echo?: string;
};
class FakePeer extends EventEmitter {
    readonly frames: WireEvent[] = [];
    terminated = false;
    onAdmin?: (event: WireEvent) => void;
    send(text: string, callback: (error?: Error) => void): void {
        const event = JSON.parse(text) as WireEvent;
        this.frames.push(event);

        if (event.detail_type === 'qq.group_admin_change') {
            this.onAdmin?.(event);
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
    notices(): WireEvent[] {
        return this.frames.filter((event) => event.detail_type === 'qq.group_admin_change');
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
    echo = 'synthetic-http-echo',
    params: object = {},
): Promise<WireResponse> {
    const request = new FakeRequest();
    const response = new FakeResponse();
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

function ok(data: unknown[], echo: string) {
    return { status: 'ok', retcode: 0, data, message: '', echo };
}

function raw(self: number, set: boolean, time = TIME): GroupAdmin {
    return { kind: 'group_admin', time, selfUin: self, groupId: GROUP, userUin: USER, set };
}

function v11(self: number, set: boolean, time = TIME): JsonObject {
    return converters.convertGroupAdmin(
        {
            selfId: self,
            imageUrlResolver: null,
            mediaUrlResolver: null,
            messageIdResolver: null,
            mediaSegmentSink: null,
        },
        raw(self, set, time),
    );
}

function expectedV11(self: number, set: boolean, time = TIME): JsonObject {
    return {
        time,
        self_id: self,
        post_type: 'notice',
        notice_type: 'group_admin',
        sub_type: set ? 'set' : 'unset',
        group_id: GROUP,
        user_id: USER,
    };
}

function scopedQueue() {
    const result = queue.scoped.mock.results.at(-1);

    if (!result || result.type !== 'return') {
        throw new Error('missing actual scoped queue');
    }

    return result.value;
}

async function account(self = 10001) {
    const uin = String(self);
    const generation = new sourceApi.SourceGeneration();
    generation.setOnline(true);
    const manager = new managerApi.OneBotNetworkManager();
    const api = vi.fn(forbidden);
    const sentTime = vi.fn(forbidden);
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
            isSourceCurrent: (source: V12Source | undefined, binding: object | null) => {
                const current =
                    manager.get(identityApi.V12_ADAPTER_NAME) === runtime &&
                    generation.isCurrent(source, binding);
                verification.before?.();
                return current;
            },
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
    fixtures.push({ manager, api, sentTime });
    legacy.open();
    const index = fake.transports.length;
    await runtime.open();
    expect(fake.transports).toHaveLength(index + 1);
    const transport = fake.transports[index]!.instance;
    const peer = connect(transport);

    const ticket = (): V12Source => {
        const result = generation.capture(runtime[sourceApi.captureBinding]());

        if (!result) {
            throw new Error('synthetic source unavailable');
        }

        return result;
    };

    return {
        self,
        uin,
        generation,
        manager,
        runtime,
        legacy,
        transport,
        peer,
        ticket,
        verification,
    };
}

function expectRejected(candidate: unknown, self: string): void {
    let result: unknown;
    let thrown = false;

    try {
        result = eventsApi.convertV11Event(candidate, { platform: 'qq', user_id: self });
    } catch (error) {
        thrown = true;
        expect(error).toBeInstanceOf(Error);
    }

    if (!thrown) {
        expect(result).toBeNull();
    }
}

describe('synthetic group-admin v11 to Jiyu v12 extension (no sockets)', () => {
    it.each([true, false])(
        'preserves set=%s across v11, WS, real scoped HTTP and SDK',
        async (set) => {
            const f = await account();
            const input = v11(f.self, set);
            const before = structuredClone(input);
            expect(input).toEqual(expectedV11(f.self, set));
            expect(Object.keys(input).sort()).toEqual(
                [
                    'time',
                    'self_id',
                    'post_type',
                    'notice_type',
                    'sub_type',
                    'group_id',
                    'user_id',
                ].sort(),
            );
            const scoped = scopedQueue();
            await f.manager.emitEvent(input, f.ticket());
            expect(input).toEqual(before);
            expect(f.legacy.frames.map((frame) => JSON.parse(frame))).toEqual([before]);
            expect(f.peer.notices()).toHaveLength(1);
            const ws = f.peer.notices()[0]!;
            expect(ws).toEqual({
                id: expect.any(String),
                time: TIME,
                type: 'notice',
                detail_type: 'qq.group_admin_change',
                sub_type: '',
                self: { platform: 'qq', user_id: f.uin },
                group_id: String(GROUP),
                user_id: String(USER),
                is_admin: set,
            });
            expect(Object.hasOwn(ws, 'operator_id')).toBe(false);
            expect(queue.enqueue).toHaveBeenCalledOnce();
            expect(queue.enqueue.mock.contexts[0]).toBe(scoped);
            expect(scoped.stats()).toMatchObject({ count: 1 });
            const endpoint = 'http://admin-sdk.fixture.invalid/';
            const echo = `synthetic-admin-${set}-回显`;
            const requests: string[] = [];
            const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
                expect(url).toBe(endpoint);

                if (init?.method !== 'POST' || typeof init.body !== 'string') {
                    throw new Error('invalid SDK request');
                }

                const headers = new Headers(init.headers);
                expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
                const request = new FakeRequest();
                request.method = init.method;
                const pairs = Array.from(headers.entries());
                request.headers = Object.fromEntries(pairs);
                request.rawHeaders = pairs.flatMap(([name, value]) => [name, value]);
                const response = new FakeResponse();
                f.transport.handleRequest(
                    request as unknown as IncomingMessage,
                    response as unknown as ServerResponse,
                );
                requests.push(init.body);
                request.emit('data', Buffer.from(init.body, 'utf8'));
                request.emit('end');
                await settle();
                expect(response.status).toBe(200);
                expect(response.bodies).toHaveLength(1);
                return new globalThis.Response(response.bodies[0], {
                    status: response.status,
                    headers: { 'content-type': 'application/json' },
                });
            });
            const { OneBot12HttpClient } = await import('../../../sdk/src/v12/http-client.js');
            const client = new OneBot12HttpClient({
                baseUrl: endpoint,
                accessToken: TOKEN,
                fetch,
                requestTimeoutMs: 0,
            });
            const result = await client.getLatestEvents(
                { limit: 1, timeout: 0 },
                { self: { platform: 'qq', user_id: f.uin }, echo },
            );
            expect(fetch).toHaveBeenCalledOnce();
            expect(JSON.parse(requests[0]!)).toEqual({
                action: 'get_latest_events',
                params: { limit: 1, timeout: 0 },
                self: { platform: 'qq', user_id: f.uin },
                echo,
            });
            expect(result).toEqual(ok([ws], echo));
            expect(queue.reserve).toHaveBeenCalledOnce();
            expect(queue.commit).toHaveBeenCalledOnce();
            expect(queue.resume).toHaveBeenCalledOnce();
            const selection = await queue.reserve.mock.results[0]!.value;
            expect(selection.status).toBe('reserved');

            if (selection.status === 'reserved') {
                expect(queue.commit.mock.calls[0]![1]).toBe(selection);
            }

            expect(queue.resume.mock.calls[0]![0]).toBe(queue.commit.mock.results[0]!.value);
            expect((await poll(f.transport, 'empty')).data).toEqual([]);
        },
    );

    it.each([true, false])(
        'decodes synthetic Proton admin set=%s through the real runtime',
        async (set) => {
            const f = await account();
            const { IdentityService } = await import('@snowluma/protocol/identity-service');
            const { decodeGroupAdmin } =
                await import('@snowluma/protocol/msg-push/decoders/group-admin');
            const identity = IdentityService.memory(f.uin);

            try {
                const uid = 'synthetic-group-admin-uid';
                identity.rememberGroupMemberIdentity(GROUP, { uid, uin: USER });
                expect(identity.findUinByUid(uid, GROUP)).toBe(USER);
                const content = protobuf_encode<GroupAdminWire>({
                    groupUin: GROUP,
                    body: set
                        ? { extraEnable: { adminUid: uid } }
                        : { extraDisable: { adminUid: uid } },
                });
                const context: MsgPushContext = {
                    head: {
                        msgType: 0,
                        subType: 0,
                        c2cCmd: 0,
                        sequence: 0,
                        ntMsgSeq: 0,
                        timestamp: TIME,
                        msgId: 0,
                    },
                    fromUin: GROUP,
                    fromUid: '',
                    selfUin: f.self,
                    content,
                    body: undefined,
                    responseHead: undefined,
                    identity,
                    isHistorical: false,
                };
                const decoded = decodeGroupAdmin(context);
                expect(decoded).toEqual([raw(f.self, set)]);
                const event = decoded[0];

                if (!event || event.kind !== 'group_admin') {
                    throw new Error('synthetic admin did not decode');
                }

                const legacy = converters.convertGroupAdmin(
                    {
                        selfId: f.self,
                        imageUrlResolver: null,
                        mediaUrlResolver: null,
                        messageIdResolver: null,
                        mediaSegmentSink: null,
                    },
                    event,
                );
                expect(legacy).toEqual(expectedV11(f.self, set));
                await f.manager.emitEvent(legacy, f.ticket());
                expect(f.legacy.frames.map((frame) => JSON.parse(frame))).toEqual([legacy]);
                expect(f.peer.notices()).toHaveLength(1);
                expect(f.peer.notices()[0]).toMatchObject({
                    self: { platform: 'qq', user_id: f.uin },
                    group_id: String(GROUP),
                    user_id: String(USER),
                    is_admin: set,
                });
                expect(await poll(f.transport, 'proton')).toEqual(
                    ok([f.peer.notices()[0]], 'proton'),
                );
            } finally {
                await identity.close();
            }
        },
    );

    it.each([
        ['zero group', { group_id: 0 }],
        ['zero user', { user_id: 0 }],
        ['unsafe group', { group_id: Number.MAX_SAFE_INTEGER + 1 }],
        ['unsafe user', { user_id: Number.MAX_SAFE_INTEGER + 1 }],
        ['unsafe time', { time: Number.MAX_SAFE_INTEGER + 1 }],
        ['wrong account', { self_id: 10002 }],
        ['operator field', { operator_id: 9 }],
        ['extra public field', { extra: 'synthetic-extra' }],
    ] as const)('rejects %s without publishing or queueing a v12 event', async (_label, change) => {
        const f = await account();
        const candidate = { ...v11(f.self, true), ...change };
        expectRejected(candidate, f.uin);
        await f.manager.emitEvent(candidate, f.ticket());
        expect(f.legacy.frames).toHaveLength(1);
        expect(f.peer.notices()).toEqual([]);
        expect(queue.enqueue).not.toHaveBeenCalled();
        expect(scopedQueue().stats()).toMatchObject({ count: 0 });
        expect(await poll(f.transport, 'invalid')).toEqual(ok([], 'invalid'));
    });

    it.each(['self_id', 'time', 'sub_type', 'group_id', 'user_id'] as const)(
        'does not read recognizable %s accessor in v12 projection and does not emit it',
        async (field) => {
            const f = await account();
            const candidate = v11(f.self, true);
            const old = candidate[field];
            const getter = vi.fn(() => old);
            Object.defineProperty(candidate, field, {
                enumerable: true,
                configurable: true,
                get: getter,
            });
            // Once the notice has been recognized, inspect only field descriptors.
            expectRejected(candidate, f.uin);
            expect(getter).not.toHaveBeenCalled();
            await f.manager.emitEvent(candidate, f.ticket());
            // V11 payload serialization and unrelated legacy recognition may read
            // a getter; no claim is made about those pre-projection operations.
            expect(f.legacy.frames).toHaveLength(1);
            expect(f.peer.notices()).toEqual([]);
            expect(queue.enqueue).not.toHaveBeenCalled();
            expect(await poll(f.transport, 'accessor')).toEqual(ok([], 'accessor'));
        },
    );

    it('ignores a non-enumerable symbol getter without reading its value', async () => {
        const f = await account();
        const candidate = v11(f.self, true);
        const readHidden = vi.fn(() => {
            throw new Error('hidden metadata was read');
        });
        Object.defineProperty(candidate, 'syntheticPrivateData', {
            enumerable: false,
            value: 'not-on-wire',
        });
        Object.defineProperty(candidate, Symbol('synthetic-private'), {
            enumerable: false,
            get: readHidden,
        });
        await f.manager.emitEvent(candidate, f.ticket());
        expect(readHidden).not.toHaveBeenCalled();
        expect(f.legacy.frames.map((frame) => JSON.parse(frame))).toEqual([
            expectedV11(f.self, true),
        ]);
        expect(f.peer.notices()).toHaveLength(1);
        expect(await poll(f.transport, 'hidden')).toEqual(ok([f.peer.notices()[0]], 'hidden'));
        expect(readHidden).not.toHaveBeenCalled();
    });

    it('snapshots an identified admin event before a later self getter mutates it', () => {
        const candidate = v11(10001, true);
        const getter = vi.fn(() => {
            candidate.group_id = 49999;
            candidate.user_id = 29999;
            return 'qq';
        });
        const self = { platform: 'qq', user_id: '10001' };
        Object.defineProperty(self, 'platform', { enumerable: true, get: getter });
        const result = eventsApi.convertV11Event(candidate, self);
        expect(getter).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            detail_type: 'qq.group_admin_change',
            group_id: String(GROUP),
            user_id: String(USER),
            is_admin: true,
        });
        expect(result && Object.hasOwn(result, 'operator_id')).toBe(false);
    });

    it('preserves legacy recognition when the initial post_type is an accessor', () => {
        const candidate = v11(10001, true);
        const getter = vi.fn(() => 'notice');
        Object.defineProperty(candidate, 'post_type', { enumerable: true, get: getter });
        expectRejected(candidate, '10001');
        // This pre-recognition field is still subject to the legacy read path.
        expect(getter).toHaveBeenCalled();
    });

    it('handles a synchronous WS reentry using the same source ticket without duplicating either event', async () => {
        const f = await account();
        const ticket = f.ticket();
        const second = v11(f.self, false, TIME + 1);
        let reentered = false;

        f.peer.onAdmin = () => {
            if (reentered) {
                return;
            }

            reentered = true;
            void f.runtime[sourceApi.receiveSourceEvent](
                second,
                filterApi.buildDispatchPayload(second),
                ticket,
            );
        };

        await f.manager.emitEvent(v11(f.self, true), ticket);
        expect(reentered).toBe(true);
        expect(f.legacy.frames).toHaveLength(1);
        const ws = f.peer.notices();
        expect(ws.map((event) => event.is_admin)).toEqual([true, false]);
        expect(ws[0]!.id).not.toBe(ws[1]!.id);
        expect(queue.enqueue).toHaveBeenCalledTimes(2);
        expect(await poll(f.transport, 'reentry')).toEqual(ok(ws, 'reentry'));
    });

    it('does not carry a queued old-source event across an epoch change from the WS callback', async () => {
        const f = await account();
        const scoped = scopedQueue();
        const oldTicket = f.ticket();
        let countAtWs = -1;

        f.peer.onAdmin = () => {
            countAtWs = scoped.stats().count;
            f.generation.setOnline(false);
            f.generation.setOnline(true);
        };

        await f.manager.emitEvent(v11(f.self, true), oldTicket);
        // Ordinary production admission precedes WS; source loss cannot undo a
        // previously observed enqueue, but the old owner must not cross epochs.
        expect(countAtWs).toBe(1);
        expect(f.peer.notices()).toHaveLength(1);
        expect(f.legacy.frames).toHaveLength(1);
        f.peer.onAdmin = undefined;
        f.runtime.statusUpdate();
        await settle();
        expect(await poll(f.transport, 'rotated-empty')).toEqual(ok([], 'rotated-empty'));
        await f.manager.emitEvent(v11(f.self, false, TIME + 1), f.ticket());
        expect(f.peer.notices()).toHaveLength(2);
        expect(await poll(f.transport, 'rotated-fresh')).toEqual(
            ok([f.peer.notices()[1]], 'rotated-fresh'),
        );
    });

    it('keeps account IDs, source tickets and HTTP owners isolated', async () => {
        const a = await account(10001);
        const b = await account(10002);
        const aEvent = v11(a.self, true);
        const bEvent = v11(b.self, false, TIME + 1);
        await a.manager.emitEvent(aEvent, a.ticket());
        await b.manager.emitEvent(aEvent, b.ticket()); // wrong self, still v11
        await a.manager.emitEvent(aEvent, b.ticket()); // foreign ticket, still v11
        await b.manager.emitEvent(bEvent, b.ticket());
        expect(a.peer.notices()).toHaveLength(1);
        expect(b.peer.notices()).toHaveLength(1);
        expect(a.legacy.frames).toHaveLength(2);
        expect(b.legacy.frames).toHaveLength(2);
        expect(a.peer.notices()[0]).toMatchObject({
            self: { platform: 'qq', user_id: a.uin },
            is_admin: true,
        });
        expect(b.peer.notices()[0]).toMatchObject({
            self: { platform: 'qq', user_id: b.uin },
            is_admin: false,
        });
        expect(await poll(a.transport, 'account-a')).toEqual(
            ok([a.peer.notices()[0]], 'account-a'),
        );
        expect(await poll(b.transport, 'account-b')).toEqual(
            ok([b.peer.notices()[0]], 'account-b'),
        );
    });
});
