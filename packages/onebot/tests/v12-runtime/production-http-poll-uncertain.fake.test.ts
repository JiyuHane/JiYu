import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import http, { type IncomingMessage } from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchPayload } from '../../src/event-filter';
import type { JsonObject, NetworkBase } from '../../src/types';
import type { V12HttpPollResult, V12Transport, V12TransportOptions } from '../../src/v12-network';
import type { PollSink } from '../../src/v12-runtime/poll-transaction';
import type { V12Runtime } from '../../src/v12-runtime/runtime';
import type { V12Source } from '../../src/v12-runtime/source-generation';

type Captured = { instance: V12Transport; options: V12TransportOptions };
const fake = vi.hoisted(() => ({
    transports: [] as Captured[],
    warnings: [] as unknown[][],
    errors: [] as unknown[][],
    violations: [] as string[],
    peer: null as FakePeer | null,
    throwRetirementWarning: false,
}));

const TOKEN = 'synthetic-private-token';
const ECHO = 'synthetic-private-echo';
const BODY = 'synthetic-private-event-body';
const DELIVERY_WARNING = 'v12 http poll delivery outcome unknown; events may be missed';
const RETIRE_WARNING = 'v12 http poll retired with undelivered buffered events';

// The real transport is used only in no-server attach mode with a synthetic peer.
// Even an accidental attempt to call its real open() is stopped before listening.
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
                fake.violations.push('unplanned synthetic upgrade');
                throw new Error('missing fake peer');
            }

            accept(fake.peer);
        }

        destroy() {}
    },
}));

vi.mock('@snowluma/common/logger', () => {
    type MemoryLogger = {
        child: () => MemoryLogger;
        trace: (...args: unknown[]) => void;
        debug: (...args: unknown[]) => void;
        info: (...args: unknown[]) => void;
        success: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
    };
    const logger: MemoryLogger = {
        child: () => logger,
        trace: () => {},
        debug: () => {},
        info: () => {},
        success: () => {},
        warn: (...args: unknown[]) => {
            fake.warnings.push(args);

            if (fake.throwRetirementWarning && args[0] === RETIRE_WARNING) {
                throw new Error('synthetic logger failure');
            }
        },
        error: (...args: unknown[]) => fake.errors.push(args),
    };
    return { createLogger: () => logger };
});

vi.mock('@snowluma/sqlite', () => ({
    SqliteDatabase: class {
        constructor() {
            fake.violations.push('SQLite constructor');
            throw new Error('unexpected SQLite');
        }
    },
}));

vi.mock('../../src/network', async () => ({
    IOneBotNetworkAdapter: (await import('../../src/network/adapter')).IOneBotNetworkAdapter,
}));

vi.mock('../../src/v12-network', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/v12-network')>();

    class NoListenTransport extends actual.V12Transport {
        constructor(options: V12TransportOptions) {
            super(options);
            fake.transports.push({ instance: this, options });
        }

        override async open(): Promise<AddressInfo> {
            this.attach();
            return { address: 'fixture.invalid', family: 'IPv4', port: 1 };
        }
    }

    return { ...actual, V12Transport: NoListenTransport };
});

let sourceApi: typeof import('../../src/v12-runtime/source-generation');
let managerApi: typeof import('../../src/network/network-manager');
let adapterApi: typeof import('../../src/network/adapter');
let identityApi: typeof import('../../src/v12-runtime/identity');
let runtimeApi: typeof import('../../src/v12-runtime/runtime');
let ownerApi: typeof import('../../src/v12-runtime/poll-owner');
let guards: Array<{ mock: { calls: unknown[] } }>;
let fallbackWarning: ReturnType<typeof vi.spyOn>;
const fixtures: Array<{
    manager: import('../../src/network/network-manager').OneBotNetworkManager;
    api: ReturnType<typeof vi.fn>;
    sent: ReturnType<typeof vi.fn>;
}> = [];

function forbidden(): never {
    throw new Error('unexpected network, native, process or account operation');
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    vi.stubEnv('SNOWLUMA_LOG_FILE', '0');
    fake.transports.length = 0;
    fake.warnings.length = 0;
    fake.errors.length = 0;
    fake.violations.length = 0;
    fake.peer = null;
    fake.throwRetirementWarning = false;
    fixtures.length = 0;
    const fetchGuard = vi.fn(forbidden);
    const websocketGuard = vi.fn(forbidden);
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', websocketGuard);
    fallbackWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    guards = [
        fetchGuard,
        websocketGuard,
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

    // All runtime imports occur after the effect guards are installed.
    sourceApi = await import('../../src/v12-runtime/source-generation');
    adapterApi = await import('../../src/network/adapter');
    managerApi = await import('../../src/network/network-manager');
    identityApi = await import('../../src/v12-runtime/identity');
    ownerApi = await import('../../src/v12-runtime/poll-owner');
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
        const effectCounts = guards.map((guard) => guard.mock.calls.length);
        const backendCounts = resources.flatMap(({ api, sent }) => [
            api.mock.calls.length,
            sent.mock.calls.length,
        ]);
        const violations = [...fake.violations];
        const timers = vi.getTimerCount();
        vi.clearAllTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.useRealTimers();
        expect(cleanupFailed).toBe(false);
        expect(effectCounts).toEqual(effectCounts.map(() => 0));
        expect(backendCounts).toEqual(backendCounts.map(() => 0));
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
    method = 'GET';
    headers: Record<string, string> = {};
    rawHeaders = ['Authorization', `Bearer ${TOKEN}`];
    pause(): void {}
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
        fake.violations.push('unexpected synthetic WS data');
    }
}

class FakeSink extends EventEmitter implements PollSink {
    open = true;
    headCalls = 0;
    endCalls = 0;
    body: string | undefined;
    readonly pending: Array<() => void> = [];

    constructor(private readonly closeAt: 'head' | 'end' | 'never') {
        super();
    }

    isOpen(): boolean {
        return this.open;
    }

    private closeWithoutFinish(): void {
        for (const name of ['close', 'error', 'finish']) {
            this.pending.push(...(this.listeners(name) as Array<() => void>));
        }

        this.open = false;
        this.emit('close');
    }

    writeHead(): void {
        this.headCalls++;

        if (this.closeAt === 'head') {
            this.closeWithoutFinish();
        }
    }

    end(body: string): void {
        this.endCalls++;
        this.body = body;

        if (this.closeAt === 'end') {
            this.closeWithoutFinish();
        } else {
            this.emit('finish');
        }
    }

    fireLateCallbacks(): void {
        for (const callback of this.pending) {
            callback();
        }
    }
}

function connect(transport: V12Transport): FakePeer {
    const peer = new FakePeer();
    const socket = new FakeUpgradeSocket();
    fake.peer = peer;

    try {
        transport.handleUpgrade(
            new FakeRequest() as unknown as IncomingMessage,
            socket as unknown as Duplex,
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

function message(id: number): JsonObject {
    return {
        post_type: 'message',
        self_id: 12345,
        user_id: 23456,
        message_id: id,
        time: id,
        message_type: 'private',
        sub_type: 'friend',
        raw_message: `${BODY}-${id}`,
        message: [{ type: 'text', data: { text: `${BODY}-${id}` } }],
    };
}

async function account(options: { closeDuringActivation?: boolean } = {}) {
    const generation = new sourceApi.SourceGeneration();
    const manager = new managerApi.OneBotNetworkManager();
    const api = { handle: vi.fn(forbidden) };
    const sent = vi.fn(forbidden);
    let online = true;
    let closeOnCapture = options.closeDuringActivation === true;
    let pendingClose: Promise<void> | undefined;
    let openingError: unknown;
    generation.setOnline(true);
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
            api: api as never,
            buildLifecycleEvent: () => ({}),
            buildHeartbeatEvent: () => ({}),
        },
        {
            getStatus: () => ({ good: online, online }),
            getSentMessageTime: sent,
            trackAction: (_label, start) => start(),
            canAccept: () => true,
            captureCurrentSource: () => {
                const source = generation.capture(runtime[sourceApi.captureBinding]());

                if (closeOnCapture && runtime.isActive) {
                    closeOnCapture = false;
                    pendingClose = runtime.close();
                    void pendingClose.catch(() => {});
                }

                return source;
            },
            isSourceCurrent: (source: V12Source | undefined, binding: object | null) =>
                manager.get(identityApi.V12_ADAPTER_NAME) === runtime &&
                generation.isCurrent(source, binding),
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
    legacy.open();
    fixtures.push({ manager, api: api.handle, sent });
    let current!: Captured;

    async function open(): Promise<Captured> {
        const before = fake.transports.length;
        await runtime.open();
        expect(fake.transports).toHaveLength(before + 1);
        current = fake.transports[before]!;
        expect(current.options.httpPoll).toBeDefined();
        return current;
    }

    if (options.closeDuringActivation) {
        try {
            await open();
        } catch (error) {
            openingError = error;
        }

        await pendingClose;
    } else {
        await open();
    }

    return {
        manager,
        runtime,
        openingError,
        closeStarted: pendingClose !== undefined,
        legacy,
        open,
        current: () => current,
        ticket(): V12Source {
            const source = generation.capture(runtime[sourceApi.captureBinding]());

            if (!source) {
                throw new Error('fixture source unavailable');
            }

            return source;
        },
        setOnline(value: boolean): void {
            online = value;
            generation.setOnline(value);
            runtime.statusUpdate();
        },
    };
}

async function poll(captured: Captured, sink: FakeSink, echo = ECHO): Promise<V12HttpPollResult> {
    const capability = captured.options.httpPoll;

    if (!capability) {
        throw new Error('production poll capability missing');
    }

    return await capability.run(
        { action: 'get_latest_events', params: {}, echo },
        {
            sink,
            signal: new AbortController().signal,
            responseDeadline: performance.now() + 5000,
            maxOutputBytes: 512 * 1024,
        },
    );
}

function body(sink: FakeSink): { status: string; data: Array<{ message_id: string }> } {
    expect(sink.body).toBeDefined();
    return JSON.parse(sink.body!) as { status: string; data: Array<{ message_id: string }> };
}

function diagnosticCount(message: string): number {
    return fake.warnings.filter((args) => args[0] === message).length;
}

function expectRedacted(): void {
    const logs = JSON.stringify({ warnings: fake.warnings, errors: fake.errors });
    expect(logs).not.toContain(TOKEN);
    expect(logs).not.toContain(ECHO);
    expect(logs).not.toContain(BODY);
}

describe('production HTTP poll post-commit outcomes (in-memory sinks)', () => {
    it('does not report a successful open when source capture closes during poll activation', async () => {
        const f = await account({ closeDuringActivation: true });
        await settle();
        expect(f.closeStarted).toBe(true);
        expect(f.openingError).toBeInstanceOf(Error);
        expect((f.openingError as Error).message).toBe('v12 operation failed');
        expect(f.runtime.isActive).toBe(false);
        expect(fake.transports).toHaveLength(1);
        expect(fake.transports[0]!.instance.isAcceptingActions()).toBe(false);
        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({ active: false });
        expectRedacted();
    });

    it.each(['head', 'end'] as const)(
        'reports a committed uncertain delivery when close happens during %s, without replay',
        async (closeAt) => {
            const f = await account();
            const transport = f.current();
            const peer = connect(transport.instance);
            const closeSpy = vi.spyOn(transport.instance, 'close');
            const stale: FakeSink[] = [];

            for (const id of [1, 2]) {
                await f.manager.emitEvent(message(id), f.ticket());
                const sink = new FakeSink(closeAt);
                const result = await poll(transport, sink);
                await settle();
                expect(result.kind).toBe('outcome');

                if (result.kind !== 'outcome') {
                    throw new Error('expected real owner outcome');
                }

                expect(['unknown', 'committed_unsent']).toContain(result.outcome.kind);

                if (result.outcome.kind === 'unknown') {
                    expect(result.outcome.committed).toBe(true);
                }

                expect(sink.open).toBe(false);
                expect(sink.headCalls).toBe(1);
                expect(sink.endCalls).toBe(closeAt === 'end' ? 1 : 0);
                expect(sink.pending.length).toBeGreaterThan(0);
                stale.push(sink);
            }

            expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({ postcommit_unknown: 2 });
            expect(diagnosticCount(DELIVERY_WARNING)).toBe(1);
            expect(fake.warnings.filter((args) => args[0] === DELIVERY_WARNING)).toEqual([
                [DELIVERY_WARNING],
            ]);
            expectRedacted();
            const beforeLate = JSON.stringify({ warnings: fake.warnings, errors: fake.errors });
            const writesBeforeLate = stale.map((sink) => [
                sink.headCalls,
                sink.endCalls,
                sink.body,
            ]);

            for (const sink of stale) {
                sink.fireLateCallbacks();
            }

            await settle();
            expect(stale.map((sink) => [sink.headCalls, sink.endCalls, sink.body])).toEqual(
                writesBeforeLate,
            );
            expect(JSON.stringify({ warnings: fake.warnings, errors: fake.errors })).toBe(
                beforeLate,
            );
            expectRedacted();
            const empty = new FakeSink('never');
            expect(await poll(transport, empty)).toMatchObject({
                kind: 'outcome',
                outcome: { kind: 'local_finish' },
            });
            expect(body(empty)).toMatchObject({ status: 'ok', data: [] });
            expect(closeSpy).not.toHaveBeenCalled();
            expect(peer.terminated).toBe(false);
            expect(f.runtime.isActive).toBe(true);
            expect(f.runtime.hasApplyFailure).toBe(false);

            await f.manager.emitEvent(message(3), f.ticket());
            const normal = new FakeSink('never');
            await poll(transport, normal);
            expect(body(normal).data.map((event) => event.message_id)).toEqual(['3']);
            expect(
                peer.frames.filter((event) => (event as { type?: string }).type === 'message'),
            ).toHaveLength(3);
            expect(f.legacy.received).toHaveLength(3);
            expect(closeSpy).not.toHaveBeenCalled();
            expect(peer.terminated).toBe(false);

            // A new listener has a fresh diagnostic budget; no old batch reappears.
            await f.runtime.close();
            await settle();
            const reopened = await f.open();
            await f.manager.emitEvent(message(4), f.ticket());
            const again = new FakeSink(closeAt);
            await poll(reopened, again);
            await settle();
            expect(diagnosticCount(DELIVERY_WARNING)).toBe(2);
            const fresh = new FakeSink('never');
            await poll(reopened, fresh);
            expect(body(fresh).data).toEqual([]);
            expectRedacted();
        },
    );

    it('reports discarded queued events once and keeps the gate usable if the logger throws', async () => {
        const f = await account();
        const transport = f.current();
        const peer = connect(transport.instance);
        await f.manager.emitEvent(message(99), f.ticket());
        fake.throwRetirementWarning = true;
        f.setOnline(false);
        await settle();
        expect(diagnosticCount(RETIRE_WARNING)).toBe(1);
        expect(fake.warnings.filter((args) => args[0] === RETIRE_WARNING)).toEqual([
            [RETIRE_WARNING],
        ]);
        expectRedacted();
        expect(peer.terminated).toBe(false);
        expect(f.runtime.isActive).toBe(true);
        expect(fallbackWarning).toHaveBeenCalledWith('v12 status diagnostic failed');
        fake.throwRetirementWarning = false;
        f.setOnline(true);
        await settle();
        const empty = new FakeSink('never');
        const result = await poll(transport, empty);
        expect(result).toMatchObject({ kind: 'outcome', outcome: { kind: 'local_finish' } });
        expect(body(empty).data).toEqual([]);
        await f.manager.emitEvent(message(100), f.ticket());
        const next = new FakeSink('never');
        await poll(transport, next);
        expect(body(next).data.map((event) => event.message_id)).toEqual(['100']);
        expect(diagnosticCount(RETIRE_WARNING)).toBe(1);
        expect(peer.terminated).toBe(false);
        expect(f.legacy.received).toHaveLength(2);
        expectRedacted();
    });
});
