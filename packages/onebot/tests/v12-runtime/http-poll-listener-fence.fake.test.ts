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
import type { EventPollBuffer, PollResult } from '../../src/v12-runtime/event-poll-buffer';
import type { V12Runtime } from '../../src/v12-runtime/runtime';
import type { V12Source } from '../../src/v12-runtime/source-generation';

type CapturedTransport = { options: V12TransportOptions; instance: V12Transport };
type Selection = Extract<PollResult, { status: 'reserved' }>;

// The production runtime supplies the capability and owner. Only transport open()
// is replaced; attach(), HTTP dispatch, response sink and WS fanout remain real.
const fake = vi.hoisted(() => ({
    transports: [] as CapturedTransport[],
    peer: null as FakePeer | null,
    violations: [] as string[],
}));

vi.mock('node:http', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:http')>();
    return {
        ...actual,
        createServer: () => {
            fake.violations.push('named HTTP createServer');
            throw new Error('unexpected HTTP server');
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
        ): void {
            if (!fake.peer) {
                fake.violations.push('unplanned fake upgrade');
                throw new Error('missing synthetic peer');
            }

            accept(fake.peer);
        }

        destroy(): void {}
    },
}));

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
            fake.transports.push({ options, instance: this });
        }

        override async open(): Promise<AddressInfo> {
            this.attach();
            return { address: 'fixture.invalid', family: 'IPv4', port: 1 };
        }
    }

    return { ...actual, V12Transport: NoListenTransport };
});

let sourceApi: typeof import('../../src/v12-runtime/source-generation');
let ownerApi: typeof import('../../src/v12-runtime/poll-owner');
let bufferApi: typeof import('../../src/v12-runtime/event-poll-buffer');
let managerApi: typeof import('../../src/network/network-manager');
let adapterApi: typeof import('../../src/network/adapter');
let identityApi: typeof import('../../src/v12-runtime/identity');
let runtimeApi: typeof import('../../src/v12-runtime/runtime');
let guards: Array<{ mock: { calls: unknown[] } }>;
const fixtures: Array<{
    manager: import('../../src/network/network-manager').OneBotNetworkManager;
    api: ReturnType<typeof vi.fn>;
    sent: ReturnType<typeof vi.fn>;
}> = [];
const TOKEN = 'synthetic-token';

function forbidden(): never {
    throw new Error('unexpected network, native, process, account or plugin operation');
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    vi.stubEnv('SNOWLUMA_LOG_FILE', '0');
    fake.transports.length = 0;
    fake.peer = null;
    fake.violations.length = 0;
    fixtures.length = 0;
    const fetchGuard = vi.fn(forbidden);
    const webSocketGuard = vi.fn(forbidden);
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    guards = [
        fetchGuard,
        webSocketGuard,
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

    // Effect guards are installed before loading the actual runtime and manager.
    sourceApi = await import('../../src/v12-runtime/source-generation');
    ownerApi = await import('../../src/v12-runtime/poll-owner');
    bufferApi = await import('../../src/v12-runtime/event-poll-buffer');
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
                cleanupFailed ||= !(await manager.shutdown()).closed;
            } catch {
                cleanupFailed = true;
            }
        }

        await settle();
    } finally {
        const effects = guards.map((guard) => guard.mock.calls.length);
        const backend = resources.flatMap(({ api, sent }) => [
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
        expect(effects).toEqual(effects.map(() => 0));
        expect(backend).toEqual(backend.map(() => 0));
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
        fake.violations.push('unexpected synthetic WS data');
    }
}

type WireEvent = {
    id: string;
    time: number;
    type: string;
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
    expect(response).toMatchObject({ status: 'ok', retcode: 0, message: '' });
    expect(Array.isArray(response.data)).toBe(true);
    return response.data as WireEvent[];
}

function action(params: object = {}, echo?: string): object {
    return { action: 'get_latest_events', params, ...(echo !== undefined ? { echo } : {}) };
}

function send(transport: V12Transport, input: object) {
    const request = new FakeRequest();
    const response = new FakeResponse();
    transport.handleRequest(
        request as unknown as IncomingMessage,
        response as unknown as ServerResponse,
    );
    request.emit('data', Buffer.from(JSON.stringify(input)));
    request.emit('end');
    return { request, response };
}

async function reply(transport: V12Transport, input: object): Promise<WireResponse> {
    const { response } = send(transport, input);
    await settle();
    return response.json();
}

function connect(transport: V12Transport): FakePeer {
    const peer = new FakePeer();
    const request = new FakeRequest();
    request.method = 'GET';
    const socket = new FakeUpgradeSocket();
    fake.peer = peer;

    try {
        transport.handleUpgrade(
            request as unknown as IncomingMessage,
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

function peerMessages(peer: FakePeer): WireEvent[] {
    return (peer.frames as WireEvent[]).filter((event) => event.type === 'message');
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
        raw_message: `fixture-${id}`,
        message: [{ type: 'text', data: { text: `fixture-${id}` } }],
    };
}

async function account() {
    const generation = new sourceApi.SourceGeneration();
    generation.setOnline(true);
    const manager = new managerApi.OneBotNetworkManager();
    const api = { handle: vi.fn(forbidden) };
    const sent = vi.fn(forbidden);
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
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: sent,
            trackAction: (_label, start) => start(),
            canAccept: () => true,
            captureCurrentSource: () => generation.capture(runtime[sourceApi.captureBinding]()),
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
    await runtime.open();
    const captured = fake.transports.at(-1);

    if (!captured?.options.httpPoll) {
        throw new Error('production HTTP poll capability missing');
    }

    expect(captured.instance.isAcceptingActions()).toBe(true);
    return {
        captured,
        runtime,
        manager,
        legacy,
        generation,
        ticket(): V12Source {
            const source = generation.capture(runtime[sourceApi.captureBinding]());

            if (!source) {
                throw new Error('fixture source unavailable');
            }

            return source;
        },
    };
}

// Observe the real buffer's selected token. The optional delay only holds the
// already-resolved reservation before its continuation; it never creates a token.
function watchSelections(
    onSelected?: (selection: Selection, queue: EventPollBuffer) => void | Promise<void>,
) {
    const original = bufferApi.EventPollBuffer.prototype.reserve;
    const selected: Array<{ selection: Selection; queue: EventPollBuffer }> = [];
    const reserve = vi
        .spyOn(bufferApi.EventPollBuffer.prototype, 'reserve')
        .mockImplementation(async function (this: EventPollBuffer, options) {
            const result = await original.call(this, options);

            if (result.status === 'reserved') {
                selected.push({ selection: result, queue: this });
                await onSelected?.(result, this);
            }

            return result;
        });
    const commit = vi.spyOn(bufferApi.EventPollBuffer.prototype, 'commit');
    const release = vi.spyOn(bufferApi.EventPollBuffer.prototype, 'release');
    return { selected, reserve, commit, release };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('production HTTP poll exact-listener pre-commit fence (in-memory)', () => {
    it.each(['false', 'throw'] as const)(
        'releases a selected long-poll prefix when readiness becomes %s without a close',
        async (mode) => {
            const f = await account();
            const transport = f.captured.instance;
            const peer = connect(transport);
            const source = f.ticket();
            const binding = f.runtime[sourceApi.captureBinding]();
            const run = vi.spyOn(f.captured.options.httpPoll!, 'run');
            let selected = false;
            let selectedStats: ReturnType<EventPollBuffer['stats']> | undefined;
            const ready = vi.spyOn(transport, 'isAcceptingActions').mockImplementation(() => {
                if (selected && mode === 'throw') {
                    throw new Error('synthetic readiness failure');
                }

                return !selected;
            });
            const watched = watchSelections((_selection, queue) => {
                selectedStats = queue.stats();
                selected = true;
            });
            const pending = send(transport, action({ timeout: 5 }, 'retired-😺'));
            await settle();
            expect(watched.reserve).toHaveBeenCalledOnce();
            expect(pending.response.bodies).toEqual([]);
            expect(selected).toBe(false);
            await f.manager.emitEvent(message(1, 30), source);
            await settle();
            expect(selected).toBe(true);
            expect(watched.selected).toHaveLength(1);
            expect(selectedStats).toMatchObject({ count: 1, reserved: 1, waiters: 0 });
            expect(f.manager.get(identityApi.V12_ADAPTER_NAME)).toBe(f.runtime);
            expect(f.runtime[sourceApi.captureBinding]()).toBe(binding);
            expect(f.generation.isCurrent(source, binding)).toBe(true);
            expect(watched.commit).not.toHaveBeenCalled();
            expect(watched.release).toHaveBeenCalledExactlyOnceWith(
                watched.selected[0]!.selection.token,
            );
            expect(watched.release.mock.results[0]!.value).toBe(true);
            expect(watched.selected[0]!.queue.stats()).toMatchObject({ count: 1, reserved: 0 });
            expect(await run.mock.results[0]!.value).toEqual({
                kind: 'outcome',
                outcome: { kind: 'epoch_invalid' },
            });
            expect(pending.response.destroyed).toBe(false);
            expect(pending.response.json()).toEqual({
                status: 'failed',
                retcode: 20002,
                data: null,
                message: 'poll unavailable',
                echo: 'retired-😺',
            });
            expect(peerMessages(peer).map((event) => event.message_id)).toEqual(['1']);
            expect(f.legacy.received).toHaveLength(1);

            // Same listener, binding and source: the same event survives once, at
            // the FIFO head, with its real conversion identity unchanged.
            ready.mockRestore();
            await f.manager.emitEvent(message(2, 10), source);
            const first = await reply(transport, action({ limit: 1 }, 'retry'));
            expect(first.echo).toBe('retry');
            const firstBatch = events(first);
            expect(firstBatch.map((event) => event.message_id)).toEqual(['1']);
            expect(firstBatch[0]!.id).toBe(peerMessages(peer)[0]!.id);
            expect(
                events(await reply(transport, action())).map((event) => event.message_id),
            ).toEqual(['2']);
            expect(events(await reply(transport, action()))).toEqual([]);
            expect(f.manager.get(identityApi.V12_ADAPTER_NAME)).toBe(f.runtime);
            expect(f.generation.isCurrent(source, binding)).toBe(true);
            expect(peer.terminated).toBe(false);
        },
    );

    it.each(['source', 'owner', 'sink-close'] as const)(
        'does not commit when the selected listener guard synchronously changes %s',
        async (mode) => {
            const f = await account();
            const transport = f.captured.instance;
            const peer = connect(transport);
            const source = f.ticket();
            const run = vi.spyOn(f.captured.options.httpPoll!, 'run');
            let armed = false;
            let fired = false;
            let replacementStatus: string | undefined;
            let pending!: ReturnType<typeof send>;
            const ready = vi.spyOn(transport, 'isAcceptingActions').mockImplementation(() => {
                if (armed && !fired) {
                    fired = true;

                    if (mode === 'source') {
                        // No statusUpdate here: the callback changes the source
                        // while the same manager and listener still appear current.
                        f.generation.setOnline(false);
                    } else if (mode === 'owner') {
                        ownerApi.invalidatePollOwner(f.runtime);
                        replacementStatus = ownerApi.activateHttpPollOwner(f.runtime).status;
                    } else {
                        pending.response.destroy();
                    }
                }

                return true;
            });
            const watched = watchSelections(() => {
                armed = true;
            });
            pending = send(transport, action({ timeout: 5 }, `reentrant-${mode}`));
            await settle();
            expect(watched.reserve).toHaveBeenCalledOnce();
            await f.manager.emitEvent(message(11, 11), source);
            await settle();
            expect(armed).toBe(true);
            expect(fired).toBe(true);
            expect(watched.selected).toHaveLength(1);
            expect(watched.commit).not.toHaveBeenCalled();
            expect(watched.release).toHaveBeenCalledExactlyOnceWith(
                watched.selected[0]!.selection.token,
            );
            expect(watched.release.mock.results[0]!.value).toBe(true);
            const result = await run.mock.results[0]!.value;

            if (mode === 'source') {
                expect(result).toEqual({ kind: 'outcome', outcome: { kind: 'epoch_invalid' } });
                expect(pending.response.json()).toEqual({
                    status: 'failed',
                    retcode: 20002,
                    data: null,
                    message: 'poll unavailable',
                    echo: 'reentrant-source',
                });
                expect(f.generation.isCurrent(source, f.runtime[sourceApi.captureBinding]())).toBe(
                    false,
                );
                f.generation.setOnline(true);
            } else {
                // Closing the response aborts the transaction; invalidating the
                // owner closes it. Neither case is a successful batch.
                expect(result).toEqual({
                    kind: 'outcome',
                    outcome: { kind: mode === 'owner' ? 'closed' : 'aborted' },
                });
                expect(pending.response.destroyed).toBe(true);
                expect(pending.response.bodies).toEqual([]);

                if (mode === 'owner') {
                    expect(replacementStatus).toBe('cleanup_pending');
                }
            }

            ready.mockRestore();
            await settle();
            f.runtime.statusUpdate();
            await settle();
            await f.manager.emitEvent(message(12, 12), f.ticket());
            expect(peerMessages(peer).map((event) => event.message_id)).toEqual(['11', '12']);
            expect(f.legacy.received).toHaveLength(2);
            expect(peer.terminated).toBe(false);
            expect(f.runtime.isActive).toBe(true);
        },
    );

    it('records a committed-unsent outcome rather than replaying a post-commit revocation', async () => {
        const f = await account();
        const transport = f.captured.instance;
        const source = f.ticket();
        const run = vi.spyOn(f.captured.options.httpPoll!, 'run');
        let ready = true;
        const readiness = vi.spyOn(transport, 'isAcceptingActions').mockImplementation(() => ready);
        const originalCommit = bufferApi.EventPollBuffer.prototype.commit;
        const watched = watchSelections();
        let pending!: ReturnType<typeof send>;
        watched.commit.mockImplementation(function (this: EventPollBuffer, token) {
            const committed = originalCommit.call(this, token);

            if (committed) {
                ready = false;
                pending.response.destroy();
            }

            return committed;
        });
        pending = send(transport, action({ timeout: 5 }, 'after-commit'));
        await settle();
        await f.manager.emitEvent(message(21, 21), source);
        await settle();
        expect(watched.selected).toHaveLength(1);
        expect(watched.commit).toHaveBeenCalledExactlyOnceWith(
            watched.selected[0]!.selection.token,
        );
        expect(watched.release).not.toHaveBeenCalled();
        expect(await run.mock.results[0]!.value).toEqual({
            kind: 'outcome',
            outcome: { kind: 'committed_unsent' },
        });
        expect(pending.response.destroyed).toBe(true);
        expect(pending.response.bodies).toEqual([]);
        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({ postcommit_unknown: 1 });
        readiness.mockRestore();
        watched.commit.mockRestore();
        expect(events(await reply(transport, action({}, 'no-replay')))).toEqual([]);
        expect(f.generation.isCurrent(source, f.runtime[sourceApi.captureBinding]())).toBe(true);
    });

    it.each(['abort', 'deadline'] as const)(
        'releases an already-selected late reservation after %s without a success response',
        async (mode) => {
            const f = await account();
            const transport = f.captured.instance;
            const source = f.ticket();
            const run = vi.spyOn(f.captured.options.httpPoll!, 'run');
            const resume = deferred();
            const watched = watchSelections(async () => {
                await resume.promise;
            });
            const pending = send(transport, action({ timeout: 5 }, `late-${mode}`));

            try {
                await settle();
                expect(watched.reserve).toHaveBeenCalledOnce();
                await f.manager.emitEvent(message(31, 31), source);
                await settle();
                expect(watched.selected).toHaveLength(1);
                expect(watched.selected[0]!.queue.stats()).toMatchObject({ count: 1, reserved: 1 });

                if (mode === 'abort') {
                    pending.request.emit('aborted');
                } else {
                    // The transport and transaction share the 15-second deadline;
                    // whichever timer fires first must leave a non-success outcome.
                    await vi.advanceTimersByTimeAsync(15_000);
                }

                expect(pending.response.destroyed).toBe(true);
                expect(watched.commit).not.toHaveBeenCalled();
                expect(watched.release).not.toHaveBeenCalled();
            } finally {
                resume.resolve();
            }

            await settle();
            const result = await run.mock.results[0]!.value;
            expect(result.kind).toBe('outcome');

            if (result.kind !== 'outcome') {
                throw new Error('expected tracked transaction outcome');
            }

            expect(mode === 'abort' ? ['aborted'] : ['aborted', 'deadline']).toContain(
                result.outcome.kind,
            );
            expect(watched.commit).not.toHaveBeenCalled();
            expect(watched.release).toHaveBeenCalledExactlyOnceWith(
                watched.selected[0]!.selection.token,
            );
            expect(watched.release.mock.results[0]!.value).toBe(true);
            expect(watched.selected[0]!.queue.stats()).toMatchObject({ count: 1, reserved: 0 });
            expect(pending.response.bodies).toEqual([]);
            expect(
                events(await reply(transport, action({}, 'late-retry'))).map(
                    (event) => event.message_id,
                ),
            ).toEqual(['31']);
            expect(events(await reply(transport, action()))).toEqual([]);
        },
    );

    it('preserves FIFO-prefix selection, stable time order and exact echo without retirement', async () => {
        const f = await account();
        const transport = f.captured.instance;
        const peer = connect(transport);
        const source = f.ticket();
        await f.manager.emitEvent(message(41, 30), source);
        await f.manager.emitEvent(message(42, 10), source);
        await f.manager.emitEvent(message(43, 10), source);
        const first = await reply(transport, action({ limit: 3 }, 'normal-😺'));
        expect(first.echo).toBe('normal-😺');
        const batch = events(first);
        expect(batch.map((event) => [event.message_id, event.time])).toEqual([
            ['42', 10],
            ['43', 10],
            ['41', 30],
        ]);
        const ws = peerMessages(peer);
        expect(batch.map((event) => event.id)).toEqual([ws[1]!.id, ws[2]!.id, ws[0]!.id]);
        expect(f.legacy.received).toHaveLength(3);
        expect(events(await reply(transport, action({}, '')))).toEqual([]);
        expect(await reply(transport, action({}, ''))).toEqual({
            status: 'ok',
            retcode: 0,
            data: [],
            message: '',
            echo: '',
        });
    });
});
