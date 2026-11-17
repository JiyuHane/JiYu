import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import tls from 'node:tls';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '../../src/types';
import type { V12Transport, V12TransportOptions } from '../../src/v12-network';
import type { V12PrivateMessageDeleteEvent, V12Self } from '../../src/v12/types';
import type { V12Runtime } from '../../src/v12-runtime/runtime';
import type { V12Source } from '../../src/v12-runtime/source-generation';

type CapturedTransport = { options: V12TransportOptions; instance: V12Transport };
type Recall = Extract<QQEventVariant, { kind: 'friend_recall' }>;

const fake = vi.hoisted(() => ({
    transports: [] as CapturedTransport[],
    violations: [] as string[],
    noServerConstructed: 0,
}));

// Block the transport's named import too. Its real open() must never create a server.
vi.mock('node:http', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:http')>();
    return {
        ...actual,
        createServer: () => {
            fake.violations.push('named HTTP createServer');
            throw new Error('unexpected HTTP server creation');
        },
    };
});

// attach() uses this in-memory noServer stub. This test never performs an upgrade
// or constructs a real WebSocket; subscriber callbacks stand in for WS fanout.
vi.mock('@snowluma/websocket', () => ({
    WebSocket: class {
        constructor() {
            fake.violations.push('WebSocket construction');
            throw new Error('unexpected WebSocket construction');
        }
    },
    WebSocketServer: class {
        constructor(options: { noServer?: boolean }) {
            if (options?.noServer !== true) {
                fake.violations.push('WebSocket listener');
                throw new Error('unexpected WebSocket listener');
            }

            fake.noServerConstructed++;
        }

        handleUpgrade(): never {
            fake.violations.push('WebSocket upgrade');
            throw new Error('unexpected WebSocket upgrade');
        }

        destroy() {}
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
            fake.violations.push('SQLite construction');
            throw new Error('unexpected SQLite construction');
        }
    },
}));

// Avoid loading unrelated v11 transport adapters, account services, and plugins.
vi.mock('../../src/network', async () => ({
    IOneBotNetworkAdapter: (await import('../../src/network/adapter')).IOneBotNetworkAdapter,
}));

// Keep the real request handler, response sink and HTTP polling capability;
// replace only listener startup with the transport's in-memory attach() mode.
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
let recallApi: typeof import('../../src/v12-runtime/private-recall-source');
let filterApi: typeof import('../../src/event-filter');
let pollApi: typeof import('../../src/v12-runtime/poll-owner');
let guards: Array<{ mock: { calls: unknown[] } }> = [];
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
const runtimes: V12Runtime[] = [];
const backendGuards: Array<ReturnType<typeof vi.fn>> = [];

const SELF = 10001;
const PEER = 20002;
const TIME = 1_700_000_100;
const TOKEN = 'synthetic-token';

function forbidden(): never {
    throw new Error('unexpected network, native, process or filesystem operation');
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    vi.stubEnv('SNOWLUMA_LOG_FILE', '0');
    fake.transports.length = 0;
    fake.violations.length = 0;
    fake.noServerConstructed = 0;
    runtimes.length = 0;
    backendGuards.length = 0;
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

    // All subject imports occur after the network, process and native guards.
    sourceApi = await import('../../src/v12-runtime/source-generation');
    recallApi = await import('../../src/v12-runtime/private-recall-source');
    filterApi = await import('../../src/event-filter');
    pollApi = await import('../../src/v12-runtime/poll-owner');
    runtimeApi = await import('../../src/v12-runtime/runtime');
});

afterEach(async () => {
    let cleanupFailed = false;

    try {
        for (const runtime of runtimes.splice(0)) {
            try {
                await runtime.close();
            } catch {
                cleanupFailed = true;
            }
        }

        await settle();
    } finally {
        const calls = guards.map((guard) => guard.mock.calls.length);
        const backendCalls = backendGuards.map((guard) => guard.mock.calls.length);
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

    json(): unknown {
        expect(this.status).toBe(200);
        expect(this.writes).toBe(1);
        expect(this.bodies).toHaveLength(1);
        expect(this.destroyed).toBe(false);
        return JSON.parse(this.bodies[0]!) as unknown;
    }
}

async function poll(transport: V12Transport, echo: string): Promise<unknown> {
    const request = new FakeRequest();
    const response = new FakeResponse();
    transport.handleRequest(
        request as unknown as IncomingMessage,
        response as unknown as ServerResponse,
    );
    request.emit(
        'data',
        Buffer.from(JSON.stringify({ action: 'get_latest_events', params: {}, echo })),
    );
    request.emit('end');
    await settle();
    return response.json();
}

function ok(data: unknown[], echo: string) {
    return { status: 'ok', retcode: 0, data, message: '', echo };
}

async function fixture() {
    const context = { uin: String(SELF), selfId: SELF };
    const generation = new sourceApi.SourceGeneration();
    generation.setOnline(true);
    const manager: { current: V12Runtime | null } = { current: null };
    const apiCall = vi.fn(forbidden);
    const sentTime = vi.fn(forbidden);
    backendGuards.push(apiCall, sentTime);
    let onVerify: (() => void) | undefined;
    let runtime!: V12Runtime;
    runtime = new runtimeApi.V12Runtime(
        {
            name: 'OneBot v12',
            enabled: true,
            host: 'fixture.invalid',
            port: 1,
            accessToken: TOKEN,
            allowNonLoopback: false,
            messageFormat: 'array',
            reportSelfMessage: false,
        },
        {
            uin: context.uin,
            api: { handle: apiCall } as never,
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
                    manager.current === runtime && generation.isCurrent(source, binding);
                onVerify?.();
                return current;
            },
            getPrivateRecallSource: (event) => recallApi.getPrivateRecallSource(context, event),
        },
    );
    manager.current = runtime;
    runtimes.push(runtime);

    async function open() {
        const previous = fake.transports.length;
        await runtime.open();
        expect(fake.transports).toHaveLength(previous + 1);
        const transport = fake.transports[previous]!;
        expect(transport.instance.isAcceptingActions()).toBe(true);
        expect(transport.options.httpPoll).toBeDefined();
        const published: unknown[] = [];
        const unsubscribe = transport.options.subscribe((event) => published.push(event));
        expect(published).toHaveLength(1); // initial status, not an application event
        published.length = 0;
        return { ...transport, published, unsubscribe };
    }

    const first = await open();
    const selfField = Object.getOwnPropertyDescriptor(runtime, 'self');

    if (!selfField || !('value' in selfField)) {
        throw new Error('runtime self fixture missing');
    }

    // The exact runtime identity is needed to check the converter's internal
    // object-identity brand on a DTO observed by the subscriber.
    const self = selfField.value as V12Self;
    expect(self).toEqual({ platform: 'qq', user_id: String(SELF) });

    function ticket(): V12Source {
        const value = generation.capture(runtime[sourceApi.captureBinding]());

        if (!value) {
            throw new Error('fixture source not online or runtime not open');
        }

        return value;
    }

    return {
        context,
        generation,
        manager,
        runtime,
        self,
        first,
        open,
        ticket,
        onVerify(callback: (() => void) | undefined) {
            onVerify = callback;
        },
    };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function recalled(f: Fixture, recalledBySelf: boolean, messageId: number) {
    const ticket = f.ticket();
    const raw: Recall = {
        kind: 'friend_recall',
        selfUin: SELF,
        userUin: PEER,
        msgSeq: 445,
        clientSeq: 446,
        time: TIME,
        recalledBySelf,
    };
    const event: JsonObject = {
        time: TIME,
        self_id: SELF,
        post_type: 'notice',
        notice_type: 'friend_recall',
        user_id: PEER,
        message_id: messageId,
    };
    const descriptors = Object.getOwnPropertyDescriptors(event);
    const snapshot = recallApi.capturePrivateRecallSource(f.context, raw, ticket);
    expect(snapshot).toBeDefined();
    expect(recallApi.rememberPrivateRecallSource(f.context, event, snapshot, messageId)).toBe(true);
    const source = recallApi.getPrivateRecallSource(f.context, event);

    if (!source) {
        throw new Error('fixture provenance missing');
    }

    expect(source.sourceTicket).toBe(ticket);
    const converted = recallApi.convertPrivateRecallEvent(event, f.self, source);

    if (!converted) {
        throw new Error('fixture conversion failed');
    }

    const proof = recallApi.createPrivateRecallPollProof(event, source, ticket, f.self, converted);

    if (!proof) {
        throw new Error('fixture proof missing');
    }

    expect(recallApi.isPrivateRecallPollProofCurrent(proof)).toBe(true);
    expect(recallApi.isPrivateRecallPollProofFor(proof, converted)).toBe(true);
    expect(recallApi.isPrivateRecallPollProofBoundTo(proof, ticket, { ...f.self })).toBe(true);
    return { raw, event, descriptors, snapshot, source, ticket, converted, proof };
}

function deliver(f: Fixture, event: JsonObject, ticket: V12Source): void {
    const payload = filterApi.buildDispatchPayload(event);
    void f.runtime[sourceApi.receiveSourceEvent](event, payload, ticket);
}

function friendAdd(): JsonObject {
    return {
        time: TIME + 1,
        self_id: SELF,
        post_type: 'notice',
        notice_type: 'friend_add',
        user_id: PEER,
    };
}

describe('private recall proof/brand compatibility with the real V12 runtime', () => {
    it('keeps both directions and signed IDs on the subscriber path while HTTP polling omits recall', async () => {
        const f = await fixture();
        expect(fake.noServerConstructed).toBe(1);
        expect(pollApi.pollOwnerStats(f.runtime)).toMatchObject({ active: true, accepted: 0 });
        const incoming = recalled(f, false, -2147483648);
        const outgoing = recalled(f, true, -123456789);

        for (const [input, userId] of [
            [incoming, String(PEER)],
            [outgoing, String(SELF)],
        ] as const) {
            deliver(f, input.event, input.ticket);
            const observed = f.first.published.at(-1) as V12PrivateMessageDeleteEvent;
            expect(observed).toEqual({
                id: expect.any(String),
                time: TIME,
                type: 'notice',
                detail_type: 'private_message_delete',
                sub_type: '',
                self: { platform: 'qq', user_id: String(SELF) },
                message_id: String(input.source.messageId),
                user_id: userId,
            });
            expect(observed).toEqual({ ...input.converted, id: expect.any(String) });
            expect(Object.isFrozen(observed)).toBe(true);
            expect(Object.isFrozen(observed.self)).toBe(true);
            const runtimeProof = recallApi.createPrivateRecallPollProof(
                input.event,
                input.source,
                input.ticket,
                f.self,
                observed,
            );
            expect(runtimeProof).toBeDefined();
            expect(recallApi.isPrivateRecallPollProofFor(runtimeProof, observed)).toBe(true);
            expect(
                recallApi.isPrivateRecallPollProofBoundTo(runtimeProof, input.ticket, f.self),
            ).toBe(true);
            expect(recallApi.isPrivateRecallPollProofFor(input.proof, observed)).toBe(false);
            expect(recallApi.isPrivateRecallPollProofFor(runtimeProof, input.converted)).toBe(
                false,
            );
            expect(Object.isFrozen(input.event)).toBe(false);
            expect(Object.getOwnPropertyDescriptors(input.event)).toEqual(input.descriptors);
            expect(Reflect.ownKeys(input.event)).toEqual([
                'time',
                'self_id',
                'post_type',
                'notice_type',
                'user_id',
                'message_id',
            ]);
        }

        expect(f.first.published).toHaveLength(2);
        expect(pollApi.pollOwnerStats(f.runtime)).toMatchObject({ active: true, accepted: 0 });
        expect(await poll(f.first.instance, 'recalls-omitted')).toEqual(ok([], 'recalls-omitted'));
        const ordinary = friendAdd();
        deliver(f, ordinary, f.ticket());
        expect(f.first.published).toHaveLength(3);
        expect(f.first.published[2]).toEqual({
            id: expect.any(String),
            time: TIME + 1,
            type: 'notice',
            detail_type: 'friend_increase',
            sub_type: '',
            self: { platform: 'qq', user_id: String(SELF) },
            user_id: String(PEER),
        });
        expect(await poll(f.first.instance, 'ordinary')).toEqual(
            ok([f.first.published[2]], 'ordinary'),
        );
        expect(await poll(f.first.instance, 'drained')).toEqual(ok([], 'drained'));
    });

    it('deduplicates reentrant and later receives of the exact event and ticket', async () => {
        const f = await fixture();
        const input = recalled(f, false, -110);
        const payload = filterApi.buildDispatchPayload(input.event);
        let reentered = false;
        f.onVerify(() => {
            if (!reentered) {
                reentered = true;
                void f.runtime[sourceApi.receiveSourceEvent](input.event, payload, input.ticket);
            }
        });
        await f.runtime[sourceApi.receiveSourceEvent](input.event, payload, input.ticket);
        f.onVerify(undefined);
        expect(reentered).toBe(true);
        expect(f.first.published).toHaveLength(1);
        expect(f.first.published[0]).toEqual({ ...input.converted, id: expect.any(String) });
        await f.runtime[sourceApi.receiveSourceEvent](input.event, payload, input.ticket);
        expect(f.first.published).toHaveLength(1);
        expect(await poll(f.first.instance, 'duplicate')).toEqual(ok([], 'duplicate'));
        expect(Object.isFrozen(input.event)).toBe(false);
        expect(Object.getOwnPropertyDescriptors(input.event)).toEqual(input.descriptors);
    });

    it('does not promote cloned events, provenance, candidates or tickets to a branded source', async () => {
        const f = await fixture();
        const input = recalled(f, true, -41);
        const eventClone: JsonObject = { ...input.event };
        const sourceClone = { ...input.source };
        const candidateClone = { ...input.converted, self: { ...input.converted.self } };
        const sameEpochTicket = f.ticket();
        expect(sameEpochTicket).not.toBe(input.ticket);
        expect(sourceApi.sameSourceEpoch(sameEpochTicket, input.ticket)).toBe('same');
        expect(recallApi.getPrivateRecallSource(f.context, eventClone)).toBeUndefined();
        expect(
            recallApi.createPrivateRecallPollProof(
                input.event,
                sourceClone,
                input.ticket,
                f.self,
                input.converted,
            ),
        ).toBeUndefined();
        expect(
            recallApi.createPrivateRecallPollProof(
                input.event,
                input.source,
                input.ticket,
                f.self,
                candidateClone,
            ),
        ).toBeUndefined();
        expect(
            recallApi.createPrivateRecallPollProof(
                input.event,
                input.source,
                sameEpochTicket,
                f.self,
                input.converted,
            ),
        ).toBeUndefined();
        expect(recallApi.isPrivateRecallPollProofFor(input.proof, candidateClone)).toBe(false);
        expect(recallApi.isPrivateRecallPollProofCurrent({ ...input.proof })).toBe(false);

        // The converter still preserves its legacy value-only behavior, but it
        // grants no proof to a cloned source/event; runtime uses the real lookup.
        const unbranded = recallApi.convertPrivateRecallEvent(eventClone, f.self, sourceClone);
        expect(unbranded).toEqual({ ...input.converted, id: expect.any(String) });
        expect(
            recallApi.createPrivateRecallPollProof(
                eventClone,
                sourceClone,
                input.ticket,
                f.self,
                unbranded,
            ),
        ).toBeUndefined();
        deliver(f, eventClone, input.ticket);
        deliver(f, input.event, sameEpochTicket);
        await f.runtime.onEvent(input.event, filterApi.buildDispatchPayload(input.event));
        expect(f.first.published).toEqual([]);
        deliver(f, input.event, input.ticket);
        expect(f.first.published).toHaveLength(1);
        expect(f.first.published[0]).toEqual({ ...input.converted, id: expect.any(String) });
        expect(await poll(f.first.instance, 'clones')).toEqual(ok([], 'clones'));
    });

    it('rejects undispatched stale tickets on close, reopen and online-epoch change', async () => {
        const f = await fixture();
        const stale = recalled(f, false, -51);
        expect(f.generation.isCurrent(stale.ticket, f.runtime[sourceApi.captureBinding]())).toBe(
            true,
        );
        await f.runtime.close();
        await settle();
        expect(f.generation.isCurrent(stale.ticket, f.runtime[sourceApi.captureBinding]())).toBe(
            false,
        );
        deliver(f, stale.event, stale.ticket);
        expect(f.first.published).toEqual([]);
        const next = await f.open();
        const nextTicket = f.ticket();
        expect(sourceApi.sameSourceEpoch(stale.ticket, nextTicket)).toBe('different');
        expect(f.generation.isCurrent(stale.ticket, f.runtime[sourceApi.captureBinding]())).toBe(
            false,
        );
        deliver(f, stale.event, stale.ticket);
        deliver(f, stale.event, nextTicket);
        expect(next.published).toEqual([]);

        // Proof is a local object binding, not an epoch verifier; runtime must
        // independently reject the expired source even while the proof is current.
        expect(recallApi.isPrivateRecallPollProofCurrent(stale.proof)).toBe(true);
        expect(recallApi.isPrivateRecallPollProofBoundTo(stale.proof, stale.ticket, f.self)).toBe(
            true,
        );
        const fresh = recalled(f, true, -52);
        deliver(f, fresh.event, fresh.ticket);
        expect(next.published).toHaveLength(1);
        expect(next.published[0]).toEqual({ ...fresh.converted, id: expect.any(String) });
        expect(await poll(next.instance, 'reopened')).toEqual(ok([], 'reopened'));

        const offlineStale = recalled(f, false, -53);
        f.generation.setOnline(false);
        f.generation.setOnline(true);
        expect(
            f.generation.isCurrent(offlineStale.ticket, f.runtime[sourceApi.captureBinding]()),
        ).toBe(false);
        deliver(f, offlineStale.event, offlineStale.ticket);
        expect(next.published).toHaveLength(1);
        expect(recallApi.isPrivateRecallPollProofCurrent(offlineStale.proof)).toBe(true);
        expect(Object.getOwnPropertyDescriptors(stale.event)).toEqual(stale.descriptors);
        expect(Object.getOwnPropertyDescriptors(offlineStale.event)).toEqual(
            offlineStale.descriptors,
        );
        next.unsubscribe();
    });
});
