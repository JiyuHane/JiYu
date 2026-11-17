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
import type { V12Transport, V12TransportOptions } from '../../src/v12-network';
import type { PollResult } from '../../src/v12-runtime/event-poll-buffer';
import type { PollSink } from '../../src/v12-runtime/poll-transaction';
import type { V12Runtime } from '../../src/v12-runtime/runtime';
import type { V12Source } from '../../src/v12-runtime/source-generation';

const DROP_WARNING = 'v12 http poll queue full; oldest unreserved events dropped';
const TOKEN = 'synthetic-private-token';
const BODY = 'synthetic-private-event-body';
const ECHO = 'synthetic-private-echo';
type Captured = { instance: V12Transport; options: V12TransportOptions };

const fake = vi.hoisted(() => ({
    transports: [] as Captured[],
    peer: null as FakePeer | null,
    warnings: [] as unknown[][],
    timeline: [] as string[],
    violations: [] as string[],
    throwDropWarning: false,
}));

// The transport uses a real noServer attach and its real fanout. No real server
// creation, WebSocket constructor, socket, account backend or native addon is used.
vi.mock('node:http', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:http')>();
    return {
        ...actual,
        createServer: () => {
            fake.violations.push('named HTTP createServer');
            throw new Error('unexpected server creation');
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
                throw new Error('unexpected listener');
            }
        }

        handleUpgrade(
            _req: unknown,
            _socket: unknown,
            _head: unknown,
            accept: (peer: unknown) => void,
        ) {
            if (!fake.peer) {
                fake.violations.push('unexpected upgrade');
                throw new Error('missing synthetic peer');
            }

            accept(fake.peer);
        }

        destroy() {}
    },
}));
vi.mock('@snowluma/common/logger', () => {
    type Logger = {
        child: () => Logger;
        trace: (...args: unknown[]) => void;
        debug: (...args: unknown[]) => void;
        info: (...args: unknown[]) => void;
        success: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
    };
    const logger: Logger = {
        child: () => logger,
        trace: () => {},
        debug: () => {},
        info: () => {},
        success: () => {},
        warn: (...args) => {
            fake.warnings.push(args);
            fake.timeline.push(`warn:${String(args[0])}`);

            if (fake.throwDropWarning && args[0] === DROP_WARNING) {
                throw new Error('synthetic logger failure');
            }
        },
        error: (...args) => fake.warnings.push(args),
    };
    return { createLogger: () => logger };
});
vi.mock('@snowluma/sqlite', () => ({
    SqliteDatabase: class {
        constructor() {
            fake.violations.push('SQLite constructor');
            throw new Error('unexpected backend');
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
let ownerApi: typeof import('../../src/v12-runtime/poll-owner');
let bufferApi: typeof import('../../src/v12-runtime/event-poll-buffer');
let runtimeApi: typeof import('../../src/v12-runtime/runtime');
let managerApi: typeof import('../../src/network/network-manager');
let adapterApi: typeof import('../../src/network/adapter');
let identityApi: typeof import('../../src/v12-runtime/identity');
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
    fake.peer = null;
    fake.warnings.length = 0;
    fake.timeline.length = 0;
    fake.violations.length = 0;
    fake.throwDropWarning = false;
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

    // Runtime imports follow all effect guards.
    sourceApi = await import('../../src/v12-runtime/source-generation');
    bufferApi = await import('../../src/v12-runtime/event-poll-buffer');
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
                cleanupFailed ||= !(await manager.shutdown()).closed;
            } catch {
                cleanupFailed = true;
            }
        }

        await settle();
    } finally {
        const counts = guards.map((guard) => guard.mock.calls.length);
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
        expect(counts).toEqual(counts.map(() => 0));
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

class FakeSink extends EventEmitter implements PollSink {
    body = '';
    isOpen(): boolean {
        return true;
    }
    writeHead(): void {}
    end(body: string): void {
        this.body = body;
        this.emit('finish');
    }
}

class FakePeer extends EventEmitter {
    readonly frames: Array<{ type?: string; message_id?: string }> = [];
    terminated = false;

    send(text: string, callback: (error?: Error) => void): void {
        const frame = JSON.parse(text) as { type?: string; message_id?: string };
        this.frames.push(frame);

        if (frame.type === 'message') {
            fake.timeline.push(`ws:${frame.message_id}`);
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
        fake.violations.push('unexpected WebSocket data');
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

function connect(transport: V12Transport): FakePeer {
    const peer = new FakePeer();
    const request = Object.assign(new EventEmitter(), {
        url: '/',
        method: 'GET',
        headers: {},
        rawHeaders: ['Authorization', `Bearer ${TOKEN}`],
    });
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

async function account() {
    const generation = new sourceApi.SourceGeneration();
    generation.setOnline(true);
    const gate = ownerApi.createPollGate();
    const manager = new managerApi.OneBotNetworkManager();
    const api = vi.fn(forbidden);
    const sent = vi.fn(forbidden);
    const ctx = {
        uin: '12345',
        api: { handle: api } as never,
        buildLifecycleEvent: () => ({}),
        buildHeartbeatEvent: () => ({}),
    };
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
        ctx,
        {
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: sent,
            trackAction: (_label, start) => start(),
            canAccept: () => true,
            captureCurrentSource: () => generation.capture(runtime[sourceApi.captureBinding]()),
            isSourceCurrent: (source: V12Source | undefined, binding: object | null) =>
                manager.get(identityApi.V12_ADAPTER_NAME) === runtime &&
                generation.isCurrent(source, binding),
            pollGate: gate,
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
                ctx,
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
    fixtures.push({ manager, api, sent });
    legacy.open();
    const before = fake.transports.length;
    await runtime.open();
    const captured = fake.transports[before];

    if (!captured) {
        throw new Error('fixture transport not constructed');
    }

    const source = generation.capture(runtime[sourceApi.captureBinding]());

    if (!source) {
        throw new Error('fixture source unavailable');
    }

    return { runtime, manager, legacy, gate, captured, source };
}

async function poll(captured: Captured): Promise<Array<{ message_id: string }>> {
    const sink = new FakeSink();
    const capability = captured.options.httpPoll;

    if (!capability) {
        throw new Error('production poll capability missing');
    }

    const result = await capability.run(
        { action: 'get_latest_events', params: {}, echo: ECHO },
        {
            sink,
            signal: new AbortController().signal,
            responseDeadline: performance.now() + 5000,
            maxOutputBytes: 512 * 1024,
        },
    );
    expect(result).toMatchObject({ kind: 'outcome', outcome: { kind: 'local_finish' } });
    const body = JSON.parse(sink.body) as {
        status: string;
        echo: string;
        data: Array<{ message_id: string }>;
    };
    expect(body).toMatchObject({ status: 'ok', echo: ECHO });
    return body.data;
}

function hostFixture() {
    const generation = new sourceApi.SourceGeneration();
    generation.setOnline(true);
    const binding = {};
    const source = generation.capture(binding)!;
    const gate = ownerApi.createPollGate();
    const runtime = {};
    let onVerify: (() => void) | undefined;
    ownerApi.registerPollHost(
        runtime,
        {
            self: { platform: 'qq', user_id: '12345' },
            captureBinding: () => binding,
            captureSource: () => source,
            verify: (value) => {
                onVerify?.();
                return generation.isCurrent(value, binding);
            },
        },
        gate,
    );
    return {
        runtime,
        source,
        gate,
        setVerifyHook: (hook?: () => void) => {
            onVerify = hook;
        },
    };
}

function simpleEvent(id: number) {
    return { type: 'message', id };
}

function orderedEvent(id: number) {
    return {
        id: `event-${id}`,
        time: id,
        type: 'message',
        detail_type: 'private',
        sub_type: '',
        self: { platform: 'qq', user_id: '12345' },
        message_id: String(id),
        message: [{ type: 'text', data: { text: 'fixture' } }],
        alt_message: 'fixture',
        user_id: '23456',
    };
}

function expectRedacted(): void {
    const logs = JSON.stringify(fake.warnings);
    expect(logs).not.toContain(TOKEN);
    expect(logs).not.toContain(BODY);
    expect(logs).not.toContain(ECHO);
    expect(logs).not.toContain('12345');
    expect(logs).not.toContain('23456');
}

async function selected(result: Promise<PollResult>): Promise<Array<{ id: number | string }>> {
    const selection = await result;

    if (selection.status !== 'reserved') {
        throw new Error(`expected reservation, got ${selection.status}`);
    }

    return JSON.parse(selection.eventsJson) as Array<{ id: number | string }>;
}

describe('HTTP oldest-drop accounting (in-memory fixtures)', () => {
    it('counts exact cumulative drops, retains the newest 128 and warns after real WS fanout', async () => {
        const f = await account();
        const peer = connect(f.captured.instance);

        for (let id = 1; id <= 129; id++) {
            await f.manager.emitEvent(message(id), f.source);
        }

        const firstStats = ownerApi.pollOwnerStats(f.runtime);
        expect(firstStats).toMatchObject({ accepted: 129, full: 0, dropped_oldest: '1' });
        expect(JSON.parse(JSON.stringify(firstStats)).dropped_oldest).toBe('1');
        expect((await poll(f.captured)).map((entry) => entry.message_id)).toEqual(
            Array.from({ length: 128 }, (_, index) => String(index + 2)),
        );
        expect(peer.frames.filter((frame) => frame.type === 'message')).toHaveLength(129);
        expect(f.legacy.received).toHaveLength(129);
        expect(fake.warnings.filter((args) => args[0] === DROP_WARNING)).toEqual([[DROP_WARNING]]);
        expect(fake.timeline.indexOf('ws:129')).toBeLessThan(
            fake.timeline.indexOf(`warn:${DROP_WARNING}`),
        );
        expect(fake.timeline.indexOf('ws:129')).toBeGreaterThanOrEqual(0);

        // Repeated insertion of the same input object still counts each eviction.
        const repeated = message(777);

        for (let index = 0; index < 131; index++) {
            await f.manager.emitEvent(repeated, f.source);
        }

        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
            accepted: 260,
            full: 0,
            dropped_oldest: '4',
        });
        expect(ownerApi.pollOwnerStats(f.runtime)?.dropped_oldest).toBe('4');
        expect((await poll(f.captured)).map((entry) => entry.message_id)).toEqual(
            Array(128).fill('777'),
        );
        expect(peer.frames.filter((frame) => frame.type === 'message')).toHaveLength(260);
        expect(f.legacy.received).toHaveLength(260);
        expect(fake.warnings.filter((args) => args[0] === DROP_WARNING)).toEqual([[DROP_WARNING]]);
        expectRedacted();
    });

    it('keeps WS and v11 working and releases the gate when the drop logger throws', async () => {
        const f = await account();
        const peer = connect(f.captured.instance);
        fake.throwDropWarning = true;

        for (let id = 1; id <= 129; id++) {
            await f.manager.emitEvent(message(id), f.source);
        }

        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
            accepted: 129,
            full: 0,
            dropped_oldest: '1',
        });
        expect(fake.timeline.indexOf('ws:129')).toBeLessThan(
            fake.timeline.indexOf(`warn:${DROP_WARNING}`),
        );
        expect(fallbackWarning).toHaveBeenCalledWith('v12 status diagnostic failed');
        expect(peer.terminated).toBe(false);
        expect(f.runtime.isActive).toBe(true);
        expect(await poll(f.captured)).toHaveLength(128);
        await f.manager.emitEvent(message(130), f.source);
        expect(peer.frames.filter((frame) => frame.type === 'message')).toHaveLength(130);
        expect(f.legacy.received).toHaveLength(130);
        expect((await poll(f.captured)).map((entry) => entry.message_id)).toEqual(['130']);
        expect(f.gate.claim).not.toBeNull();
        await f.runtime.close();
        await settle();
        expect(f.gate.claim).toBeNull();
        expectRedacted();
    });

    it('does not count reentrant, invalid, meta or oversize attempts as evictions', async () => {
        const f = hostFixture();
        expect(ownerApi.activateHttpPollOwner(f.runtime).status).toBe('ready');

        for (let id = 1; id <= 128; id++) {
            ownerApi.enqueuePollEvent(f.runtime, simpleEvent(id), f.source);
        }

        ownerApi.enqueuePollEvent(f.runtime, { type: 'message', bad: undefined }, f.source);
        ownerApi.enqueuePollEvent(f.runtime, { type: 'meta' }, f.source);
        ownerApi.enqueuePollEvent(
            f.runtime,
            { type: 'message', text: 'x'.repeat(65536) },
            f.source,
        );
        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
            accepted: 128,
            invalid: 1,
            too_large: 1,
            full: 0,
            dropped_oldest: '0',
        });
        let reentered = false;
        f.setVerifyHook(() => {
            if (!reentered) {
                reentered = true;
                ownerApi.enqueuePollEvent(f.runtime, simpleEvent(999), f.source);
            }
        });
        ownerApi.enqueuePollEvent(f.runtime, simpleEvent(129), f.source);
        f.setVerifyHook();
        expect(reentered).toBe(true);
        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
            accepted: 129,
            invalid: 1,
            too_large: 1,
            full: 0,
            dropped_oldest: '1',
        });
        expect(ownerApi.pollOwnerStats(f.runtime)?.dropped_oldest).toBe('1');
        ownerApi.invalidatePollOwner(f.runtime);
        await settle();
        expect(f.gate.claim).toBeNull();
        expect(ownerApi.pollOwnerStats(f.runtime)?.dropped_oldest).toBe('1');
    });

    it('syncs the committed drop once even when drain throws and retirement detaches the owner', async () => {
        const f = hostFixture();
        expect(ownerApi.activateHttpPollOwner(f.runtime).status).toBe('ready');

        for (let id = 1; id <= 128; id++) {
            ownerApi.enqueuePollEvent(f.runtime, simpleEvent(id), f.source);
        }

        // drain is TypeScript-private, but is a prototype method at runtime.
        const prototype = bufferApi.EventPollBuffer.prototype as unknown as { drain(): void };
        const captured: { reservation?: Promise<PollResult> } = {};
        const drain = vi.spyOn(prototype, 'drain').mockImplementation(function (
            this: InstanceType<typeof bufferApi.EventPollBuffer>,
        ) {
            expect(this.stats().count).toBe(128);
            expect(this.oldestDropCount()).toBe(1n);
            captured.reservation = this.reserve();
            throw new Error('synthetic drain failure after commit');
        });

        let drainCalls = 0;

        try {
            ownerApi.enqueuePollEvent(f.runtime, simpleEvent(129), f.source);
            drainCalls = drain.mock.calls.length;
        } finally {
            drain.mockRestore();
        }

        expect(drainCalls).toBe(1);
        expect(captured.reservation).toBeDefined();
        const items = await selected(captured.reservation!);
        expect(items.map((item) => item.id)).toEqual(
            Array.from({ length: 128 }, (_, index) => index + 2),
        );
        // No accepted return was observed: 128 is deliberately not a claim about
        // all physical commits when enqueue throws after insertion.
        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
            accepted: 128,
            invalid: 1,
            dropped_oldest: '1',
            active: false,
        });
        await settle();
        expect(f.gate.claim).toBeNull();
        expect(ownerApi.pollOwnerStats(f.runtime)?.dropped_oldest).toBe('1');
        expect(ownerApi.pollOwnerStats(f.runtime)?.dropped_oldest).toBe('1');
        expect(JSON.parse(JSON.stringify(ownerApi.pollOwnerStats(f.runtime))).dropped_oldest).toBe(
            '1',
        );
    });

    it('keeps the private buffer watermark in bigint arithmetic after synthetic seeding', () => {
        const q = new bufferApi.EventPollBuffer(
            {
                capacity: 1,
                maxQueueBytes: 512,
                maxEventBytes: 256,
                maxWaiters: 1,
                maxTimeoutMs: 1000,
            },
            'drop-oldest',
        );
        expect(q.enqueue(simpleEvent(1))).toBe('accepted');

        // A single conversion is substituted to seed the private slot; this is
        // not a claim that the fixture really discarded 2^53 individual events.
        const realBigInt = globalThis.BigInt;
        const seed = vi
            .spyOn(globalThis, 'BigInt')
            .mockImplementation((value) => (value === 1 ? 9007199254740992n : realBigInt(value)));

        try {
            expect(q.enqueue(simpleEvent(2))).toBe('accepted');
        } finally {
            seed.mockRestore();
        }

        expect(q.oldestDropCount()).toBe(9007199254740992n);
        expect(q.enqueue(simpleEvent(3))).toBe('accepted');
        expect(q.oldestDropCount()).toBe(9007199254740993n);
        q.close();
        expect(q.oldestDropCount()).toBe(9007199254740993n);
    });

    it('keeps owner watermark arithmetic exact beyond the safe-integer boundary', async () => {
        const f = hostFixture();
        expect(ownerApi.activateHttpPollOwner(f.runtime).status).toBe('ready');

        for (let id = 1; id <= 128; id++) {
            ownerApi.enqueuePollEvent(f.runtime, simpleEvent(id), f.source);
        }

        // This injects a synthetic watermark offset into the owner's read seam;
        // it does not claim the real buffer experienced 2^53 evictions.
        const original = bufferApi.EventPollBuffer.prototype.oldestDropCount;
        const read = vi
            .spyOn(bufferApi.EventPollBuffer.prototype, 'oldestDropCount')
            .mockImplementation(function (this: InstanceType<typeof bufferApi.EventPollBuffer>) {
                return 9007199254740992n + original.call(this);
            });

        try {
            expect(ownerApi.pollOwnerStats(f.runtime)?.dropped_oldest).toBe('9007199254740992');
            ownerApi.enqueuePollEvent(f.runtime, simpleEvent(129), f.source);
            expect(ownerApi.pollOwnerStats(f.runtime)?.dropped_oldest).toBe('9007199254740993');
            ownerApi.invalidatePollOwner(f.runtime);
            await settle();
            expect(f.gate.claim).toBeNull();
        } finally {
            read.mockRestore();
        }
    });

    it('preserves reject-new behavior for the default buffer and legacy owner', async () => {
        const q = new bufferApi.EventPollBuffer({
            capacity: 2,
            maxQueueBytes: 512,
            maxEventBytes: 256,
            maxWaiters: 1,
            maxTimeoutMs: 1000,
        });
        expect(q.enqueue(simpleEvent(1))).toBe('accepted');
        expect(q.enqueue(simpleEvent(2))).toBe('accepted');
        expect(q.enqueue(simpleEvent(3))).toBe('full');
        expect(q.oldestDropCount()).toBe(0n);
        expect((await selected(q.reserve())).map((item) => item.id)).toEqual([1, 2]);
        q.close();
        const f = hostFixture();
        const legacy = ownerApi.activatePollOwner(f.runtime);

        if (legacy.status !== 'ready') {
            throw new Error('legacy owner unavailable');
        }

        for (let id = 1; id <= 129; id++) {
            ownerApi.enqueuePollEvent(f.runtime, simpleEvent(id), f.source);
        }

        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
            accepted: 128,
            full: 1,
            dropped_oldest: '0',
        });
        const sink = new FakeSink();
        const outcome = await legacy.owner.start(
            {
                limit: 0,
                timeoutMs: 0,
                maxOutputBytes: 512 * 1024,
                responseDeadline: performance.now() + 5000,
            },
            sink,
        ).result;
        expect(outcome).toMatchObject({ kind: 'local_finish' });
        expect(
            (JSON.parse(sink.body).data as Array<{ id: number }>).map((item) => item.id),
        ).toEqual(Array.from({ length: 128 }, (_, index) => index + 1));
        ownerApi.invalidatePollOwner(f.runtime);
        await settle();
        expect(f.gate.claim).toBeNull();
    });

    it('keeps the ordered owner reject-new when its queue fills', async () => {
        const f = hostFixture();
        const activation = ownerApi.activateOrderedPollOwner(f.runtime);

        if (activation.status !== 'ready') {
            throw new Error('ordered owner unavailable');
        }

        const original = bufferApi.EventPollBuffer.prototype.enqueue;
        const captured: { reservation?: Promise<PollResult>; drops?: bigint } = {};
        const enqueue = vi
            .spyOn(bufferApi.EventPollBuffer.prototype, 'enqueue')
            .mockImplementation(function (
                this: InstanceType<typeof bufferApi.EventPollBuffer>,
                event,
            ) {
                const result = original.call(this, event);

                if (result === 'full') {
                    captured.drops = this.oldestDropCount();
                    captured.reservation = this.reserve();
                }

                return result;
            });

        try {
            for (let id = 1; id <= 129; id++) {
                const parent = activation.owner.begin(f.source);

                if (!parent) {
                    throw new Error(`ordered parent unavailable: ${id}`);
                }

                const child = parent.child();

                if (!child) {
                    throw new Error(`ordered child unavailable: ${id}`);
                }

                expect(parent.seal()).toBe(true);
                expect(child.resolve(orderedEvent(id))).toBe(true);
                await vi.advanceTimersByTimeAsync(0);
            }
        } finally {
            enqueue.mockRestore();
        }

        expect(captured.drops).toBe(0n);
        expect(captured.reservation).toBeDefined();
        expect((await selected(captured.reservation!)).map((item) => item.id)).toEqual(
            Array.from({ length: 128 }, (_, index) => `event-${index + 1}`),
        );
        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
            accepted: 128,
            full: 1,
            dropped_oldest: '0',
            ordering_gap: true,
        });
        await settle();
        expect(f.gate.claim).toBeNull();
    });
});
