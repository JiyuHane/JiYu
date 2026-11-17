import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import childProcess from 'node:child_process';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '@snowluma/common/logger';
import type { OneBot12Event } from '../../../sdk/src/v12/types.js';
import type { V12TransportOptions } from '../../src/v12-network';
import type { DispatchPayload } from '../../src/event-filter';
import type { JsonObject, NetworkBase } from '../../src/types';
import type { V12Runtime } from '../../src/v12-runtime/runtime';
import type { V12Source } from '../../src/v12-runtime/source-generation';
import type { PollSink } from '../../src/v12-runtime/poll-transaction';
import type { V12ImageFileTokens } from '../../src/v12/image-file-token';

// Only fake transport callbacks are used. The imports below happen after the
// network/native guards are installed; no QQ, Core, account or service starts.
const fixture = vi.hoisted(() => ({
    transports: [] as Array<{
        options: V12TransportOptions;
        instance: { isAcceptingActions(): boolean };
    }>,
    forbiddenModules: [] as string[],
}));

vi.mock('../../src/v12-network', () => ({
    V12Transport: class {
        private accepting = false;
        constructor(options: V12TransportOptions) {
            fixture.transports.push({ options, instance: this });
        }
        async open() {
            this.accepting = true;
        }
        async close() {
            this.accepting = false;
        }
        isAcceptingActions() {
            return this.accepting;
        }
        quiesce() {
            this.accepting = false;
        }
        forceClose() {
            this.accepting = false;
        }
    },
}));
vi.mock('../../src/network', async () => ({
    IOneBotNetworkAdapter: (await import('../../src/network/adapter')).IOneBotNetworkAdapter,
}));
vi.mock('@snowluma/websocket', () => ({
    WebSocket: class {
        constructor() {
            fixture.forbiddenModules.push('websocket');
            throw new Error('unexpected WebSocket');
        }
    },
    WebSocketServer: class {
        constructor() {
            fixture.forbiddenModules.push('websocket-server');
            throw new Error('unexpected WebSocket server');
        }
    },
}));
vi.mock('@snowluma/sqlite', () => ({
    SqliteDatabase: class {
        constructor() {
            fixture.forbiddenModules.push('sqlite');
            throw new Error('unexpected SQLite construction');
        }
    },
}));

const VOICE_PREFIX = 'jiyu-voice:v1:';
const IMAGE_PREFIX = 'jiyu-image:v1:';
const ENDPOINT = 'http://fixture.invalid/';
const VOICE_SECRET = 'SYNTHETIC_VOICE_QUERY_SECRET_X731';
const IMAGE_SECRET = 'SYNTHETIC_IMAGE_QUERY_SECRET_X732';
const PRIVATE_FILE = 'SYNTHETIC_PRIVATE_V11_VOICE_FILE_X733';
const ACCESS_SECRET = 'SYNTHETIC_RUNTIME_ACCESS_SECRET_X734';
const FAILURE_SECRET = 'SYNTHETIC_ISSUER_FAILURE_X735';
// URL validation and redemption preserve a syntactic snapshot; they do not
// demonstrate that a URL can be downloaded or that voice content is playable.
const VOICE_URL = `https://media.example.invalid/voice%20clip?token=${VOICE_SECRET}&raw=%2f%2F+%20#fragment`;
const OTHER_VOICE_URL = 'https://media.example.invalid/other-voice?token=other';
const IMAGE_URL = `https://media.example.invalid/image.png?token=${IMAGE_SECRET}`;
const LEGACY_URL = 'https://media.example.invalid/legacy';
const activeRuntimes: V12Runtime[] = [];

let sdkHttp: typeof import('../../../sdk/src/v12/http-client.js');
let sdkProtocol: typeof import('../../../sdk/src/v12/protocol.js');
let sourceApi: typeof import('../../src/v12-runtime/source-generation');
let pollApi: typeof import('../../src/v12-runtime/poll-owner');
let pollBufferApi: typeof import('../../src/v12-runtime/event-poll-buffer');
let runtimeApi: typeof import('../../src/v12-runtime/runtime');
let identityApi: typeof import('../../src/v12-runtime/identity');
let managerApi: typeof import('../../src/network/network-manager');
let adapterApi: typeof import('../../src/network/adapter');
let mediaApi: typeof import('../../src/message-media');
let tokenApi: typeof import('../../src/v12/image-file-token');
let loggerApi: typeof import('@snowluma/common/logger');
let logEntries: LogEntry[];
let previousLogLevel: string;
let unsubscribeLogs: (() => void) | undefined;
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let networkGuards: Array<{ mock: { calls: unknown[] } }>;
let nativeGuard: { mock: { calls: unknown[] } };

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    vi.stubEnv('SNOWLUMA_LOG_FILE', '0');
    fixture.transports.length = 0;
    fixture.forbiddenModules.length = 0;

    const blocked = (): never => {
        throw new Error('unexpected network or native operation in voice fixture');
    };

    fetchGuard = vi.fn(blocked);
    webSocketGuard = vi.fn(function BlockWebSocket() {
        return blocked();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    networkGuards = [
        vi.spyOn(net, 'createServer').mockImplementation(blocked),
        vi.spyOn(net, 'createConnection').mockImplementation(blocked),
        vi.spyOn(net, 'connect').mockImplementation(blocked),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(blocked),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(http, 'createServer').mockImplementation(blocked),
        vi.spyOn(http, 'request').mockImplementation(blocked),
        vi.spyOn(http, 'get').mockImplementation(blocked),
        vi.spyOn(https, 'createServer').mockImplementation(blocked),
        vi.spyOn(https, 'request').mockImplementation(blocked),
        vi.spyOn(https, 'get').mockImplementation(blocked),
        vi.spyOn(http2, 'createServer').mockImplementation(blocked),
        vi.spyOn(http2, 'createSecureServer').mockImplementation(blocked),
        vi.spyOn(http2, 'connect').mockImplementation(blocked),
        vi.spyOn(tls, 'createServer').mockImplementation(blocked),
        vi.spyOn(tls, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram, 'createSocket').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(blocked),
        vi.spyOn(childProcess, 'spawn').mockImplementation(blocked),
        vi.spyOn(childProcess, 'spawnSync').mockImplementation(blocked),
        vi.spyOn(childProcess, 'exec').mockImplementation(blocked),
        vi.spyOn(childProcess, 'execSync').mockImplementation(blocked),
        vi.spyOn(childProcess, 'execFile').mockImplementation(blocked),
        vi.spyOn(childProcess, 'execFileSync').mockImplementation(blocked),
        vi.spyOn(childProcess, 'fork').mockImplementation(blocked),
    ];
    nativeGuard = vi.spyOn(process, 'dlopen').mockImplementation(blocked);

    loggerApi = await import('@snowluma/common/logger');
    previousLogLevel = loggerApi.getLogLevel();
    loggerApi.setLogLevel('trace');
    logEntries = [];
    unsubscribeLogs = loggerApi.subscribeLogs((entry) => logEntries.push(entry));
    sdkHttp = await import('../../../sdk/src/v12/http-client.js');
    sdkProtocol = await import('../../../sdk/src/v12/protocol.js');
    sourceApi = await import('../../src/v12-runtime/source-generation');
    pollApi = await import('../../src/v12-runtime/poll-owner');
    pollBufferApi = await import('../../src/v12-runtime/event-poll-buffer');
    runtimeApi = await import('../../src/v12-runtime/runtime');
    identityApi = await import('../../src/v12-runtime/identity');
    managerApi = await import('../../src/network/network-manager');
    adapterApi = await import('../../src/network/adapter');
    mediaApi = await import('../../src/message-media');
    tokenApi = await import('../../src/v12/image-file-token');
});

afterEach(async () => {
    try {
        for (const runtime of activeRuntimes.splice(0)) {
            await runtime.close();
        }
    } finally {
        const fetchCalls = fetchGuard.mock.calls.length;
        const webSocketCalls = webSocketGuard.mock.calls.length;
        const networkCalls = networkGuards.map((guard) => guard.mock.calls.length);
        const nativeCalls = nativeGuard.mock.calls.length;
        const modules = [...fixture.forbiddenModules];
        const diagnostics = JSON.stringify(logEntries ?? []);
        unsubscribeLogs?.();
        unsubscribeLogs = undefined;
        loggerApi?.setLogLevel(previousLogLevel);
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.clearAllTimers();
        vi.useRealTimers();
        expect(fetchCalls).toBe(0);
        expect(webSocketCalls).toBe(0);
        expect(networkCalls).toEqual(networkCalls.map(() => 0));
        expect(nativeCalls).toBe(0);
        expect(modules).toEqual([]);

        for (const secret of [
            VOICE_URL,
            VOICE_SECRET,
            IMAGE_URL,
            IMAGE_SECRET,
            PRIVATE_FILE,
            ACCESS_SECRET,
            FAILURE_SECRET,
        ]) {
            expect(diagnostics).not.toContain(secret);
        }
    }
});

async function account(
    uin: string,
    options: {
        verifier?: boolean;
        orderedFixture?: boolean;
        firstSubscriber?: (event: unknown) => void;
    } = {},
) {
    const generation = new sourceApi.SourceGeneration();
    const manager = new managerApi.OneBotNetworkManager();
    const verification: { before?: () => void } = {};
    const api = {
        // This deliberately succeeds for *any* alias, including a collision in
        // the voice namespace. Reserved IDs must never reach this fake.
        handle: vi.fn(async (action: string, _params: JsonObject) => {
            if (action !== 'get_file') {
                throw new Error('unexpected legacy action');
            }

            return {
                status: 'ok' as const,
                retcode: 0,
                data: { file_name: 'legacy.voice', url: LEGACY_URL },
            };
        }),
    };
    let runtime!: V12Runtime;
    runtime = new runtimeApi.V12Runtime(
        {
            name: identityApi.V12_ADAPTER_NAME,
            enabled: true,
            host: 'fixture.invalid',
            port: 1,
            accessToken: ACCESS_SECRET,
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
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: async () => null,
            trackAction: <T>(_label: string, start: () => Promise<T>) => start(),
            canAccept: () => true,
            captureCurrentSource: () => generation.capture(runtime[sourceApi.captureBinding]()),
            ...(options.verifier === false
                ? {}
                : {
                      isSourceCurrent: (source: V12Source | undefined, binding: object | null) => {
                          verification.before?.();
                          return (
                              manager.get(identityApi.V12_ADAPTER_NAME) === runtime &&
                              generation.isCurrent(source, binding)
                          );
                      },
                  }),
        },
    );
    activeRuntimes.push(runtime);
    manager.register(runtime);

    class V11Capture extends adapterApi.IOneBotNetworkAdapter<NetworkBase> {
        readonly frames: string[] = [];

        constructor() {
            super(
                'fixture-v11',
                {
                    name: 'fixture-v11',
                    enabled: true,
                    messageFormat: 'array',
                    reportSelfMessage: true,
                },
                {
                    uin,
                    api: {} as never,
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
        protected bindingSignature(): string {
            return 'fixture';
        }
        describeStatus() {
            return {
                name: this.name,
                kind: 'httpServer' as const,
                status: 'ok' as const,
                detail: '',
            };
        }
    }

    const v11 = new V11Capture();
    v11.open();
    manager.register(v11);

    // Ordered-only fixtures start without a source so production completion-order
    // poll activation does not claim their gate; their fake transport is still ready.
    if (!options.orderedFixture) {
        generation.setOnline(true);
    }

    let transport: (typeof fixture.transports)[number] | undefined;
    const wire: string[] = [];

    const open = async () => {
        await runtime.open();
        transport = fixture.transports.at(-1);

        if (!transport || !transport.instance.isAcceptingActions()) {
            throw new Error('ready fake transport was not created');
        }

        if (options.firstSubscriber) {
            transport.options.subscribe(options.firstSubscriber);
        }

        transport.options.subscribe((event) => wire.push(JSON.stringify(event)));
        wire.length = 0; // Initial status is not a message.
    };

    await open();

    if (options.orderedFixture) {
        generation.setOnline(true);
    }

    const current = () => {
        if (!transport) {
            throw new Error('fake transport unavailable');
        }

        return transport;
    };

    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe(ENDPOINT);
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('error');
        expect(typeof init?.body).toBe('string');

        if (!transport) {
            throw new Error('fake transport unavailable');
        }

        const result = await transport.options.handle(JSON.parse(init!.body as string));
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    });
    const client = new sdkHttp.OneBot12HttpClient({
        baseUrl: ENDPOINT,
        fetch: fakeFetch,
        requestTimeoutMs: 0,
    });
    const ticket = () => generation.capture(runtime[sourceApi.captureBinding]());
    const emit = (event: JsonObject, source: V12Source | undefined = ticket()) =>
        manager.emitEvent(event, source);
    const messages = () =>
        wire
            .map((text) => sdkProtocol.parseOneBot12EventJson(text))
            .filter((event) => event.type === 'message');
    // Manager builds a JSON payload before adapter dispatch. Use the runtime's
    // real source-aware entry with an inert payload for accessor/Proxy fixtures,
    // so those traps are tested at the converter boundary, not by JSON.stringify.
    const injectUnserializable = async (event: JsonObject, source: V12Source) =>
        runtime[sourceApi.receiveSourceEvent](
            event,
            {
                isSelfMessage: false,
                arrayJson: '{}',
                stringJson: '{}',
            },
            source,
        );

    const subscribe = (listener: (event: unknown) => void) => {
        if (!transport) {
            throw new Error('fake transport unavailable');
        }

        return transport.options.subscribe(listener);
    };

    return {
        uin,
        generation,
        manager,
        runtime,
        verification,
        api,
        v11,
        wire,
        client,
        fakeFetch,
        open,
        current,
        ticket,
        emit,
        messages,
        injectUnserializable,
        subscribe,
    };
}

type Account = Awaited<ReturnType<typeof account>>;
type ImageIssuerSlot = { imageFileTokens: V12ImageFileTokens | null };

function record(url = VOICE_URL): JsonObject {
    return { type: 'record', data: { file: PRIVATE_FILE, url } };
}

function image(url = IMAGE_URL): JsonObject {
    return {
        type: 'image',
        data: { file: 'synthetic-image-file', url, sub_type: 0, summary: '[图片]' },
    };
}

function message(uin: string, detail: 'private' | 'group', voice = record()): JsonObject {
    return {
        post_type: 'message',
        self_id: Number(uin),
        user_id: 20001,
        message_type: detail,
        sub_type: detail === 'private' ? 'friend' : 'normal',
        ...(detail === 'group' ? { group_id: 40001 } : {}),
        message_id: -123,
        time: 1_700_000_000,
        raw_message: 'synthetic CQ representation',
        message: [
            { type: 'text', data: { text: 'before' } },
            { type: 'at', data: { qq: '30001' } },
            voice,
            image(),
            { type: 'text', data: { text: 'after' } },
        ],
    };
}

function fileId(event: OneBot12Event, index: number, expectedType: 'voice' | 'image'): string {
    const segments = event.message;

    if (!Array.isArray(segments)) {
        throw new Error('message array missing');
    }

    const segment = segments[index];

    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
        throw new Error('media segment missing');
    }

    const data = segment.data;

    if (
        segment.type !== expectedType ||
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        typeof data.file_id !== 'string'
    ) {
        throw new Error('media file_id missing');
    }

    return data.file_id;
}

async function getFile(f: Account, id: string, echo = 'file') {
    return f.client.request(
        'get_file',
        { file_id: id, type: 'url' },
        { self: { platform: 'qq', user_id: f.uin }, echo },
    );
}

function tamper(id: string, prefix: string): string {
    const packed = Buffer.from(id.slice(prefix.length), 'base64url');
    packed[12] ^= 1;
    return prefix + packed.toString('base64url');
}

function setupOrdered(f: Account) {
    const activation = pollApi.activateOrderedPollOwner(f.runtime);
    expect(activation.status).toBe('ready');

    if (activation.status !== 'ready') {
        throw new Error('ordered in-process fixture unavailable');
    }

    const context = {};
    sourceApi.prepareOrderedContext(context, f.runtime);
    expect(sourceApi.installOrderedReady(context, f.runtime, activation.owner)).not.toBeNull();
    return { context, owner: activation.owner };
}

async function emitOrdered(f: Account, context: object, input: JsonObject, source: V12Source) {
    const admission = sourceApi.bindOrderedContext(
        context,
        sourceApi.reserveOrderedContext(context),
        source,
        true,
    );
    expect(admission.kind).toBe('eligible');
    await sourceApi.withOrderedScope(f.manager, 'manager', input, admission, () =>
        f.manager.emitEvent(input, source),
    );
}

class MemorySink extends EventEmitter implements PollSink {
    body = '';
    openCalls = 0;
    readonly writeHead = vi.fn();

    constructor(private readonly onOpen?: (call: number) => void) {
        super();
    }
    isOpen(): boolean {
        this.openCalls += 1;
        this.onOpen?.(this.openCalls);
        return true;
    }
    end(body: string): void {
        this.body = body;
        this.emit('finish');
    }
}

function pollRequest() {
    return {
        limit: 0,
        timeoutMs: 0,
        maxOutputBytes: 65536,
        responseDeadline: performance.now() + 10000,
    };
}

async function settle() {
    for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
    }
}

describe('inbound voice through the real v12 runtime and SDK with fake transports', () => {
    it.each(['private', 'group'] as const)(
        'preserves %s text/mention/voice/image order and resolves exact URL snapshots repeatedly',
        async (detail) => {
            const f = await account('10001');
            const input = message(f.uin, detail);
            const before = structuredClone(input);
            const source = f.ticket();
            expect(source).toBeDefined();
            await f.emit(input, source);
            expect(f.messages()).toHaveLength(1);
            const event = f.messages()[0]!;
            const voiceId = fileId(event, 2, 'voice');
            const imageId = fileId(event, 3, 'image');
            expect(voiceId.startsWith(VOICE_PREFIX)).toBe(true);
            expect(imageId.startsWith(IMAGE_PREFIX)).toBe(true);
            expect(voiceId.length).toBeLessThanOrEqual(4096);
            expect(event).toMatchObject({
                self: { platform: 'qq', user_id: f.uin },
                detail_type: detail,
                message_id: '-123',
                user_id: '20001',
                ...(detail === 'group' ? { group_id: '40001' } : {}),
                alt_message: 'before@30001[语音][图片]after',
                message: [
                    { type: 'text', data: { text: 'before' } },
                    { type: 'mention', data: { user_id: '30001' } },
                    { type: 'voice', data: { file_id: voiceId } },
                    { type: 'image', data: { file_id: imageId } },
                    { type: 'text', data: { text: 'after' } },
                ],
            });
            const published = f.wire.join('');

            for (const secret of [VOICE_URL, VOICE_SECRET, IMAGE_URL, IMAGE_SECRET, PRIVATE_FILE]) {
                expect(published).not.toContain(secret);
            }

            expect(input).toEqual(before);
            expect(f.v11.frames.map((frame) => JSON.parse(frame))).toEqual([before]);
            expect(await getFile(f, voiceId, 'first')).toEqual({
                status: 'ok',
                retcode: 0,
                data: { name: '', url: VOICE_URL },
                message: '',
                echo: 'first',
            });
            expect(await getFile(f, voiceId, 'second')).toEqual({
                status: 'ok',
                retcode: 0,
                data: { name: '', url: VOICE_URL },
                message: '',
                echo: 'second',
            });
            expect((await getFile(f, imageId)).data).toEqual({ name: '', url: IMAGE_URL });
            expect(f.fakeFetch).toHaveBeenCalledTimes(3);
            const requests = JSON.stringify(f.fakeFetch.mock.calls.map(([, init]) => init?.body));
            expect(requests).not.toContain(VOICE_URL);
            expect(requests).not.toContain(VOICE_SECRET);
            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );

    it('accepts the real non-enumerable persistence media symbol without exposing it', async () => {
        const f = await account('10001');
        const voice = record();
        mediaApi.attachMessageMedia(voice, {
            type: 'record',
            fileId: PRIVATE_FILE,
            url: VOICE_URL,
            duration: 2,
        });
        const symbols = Object.getOwnPropertySymbols(voice);
        expect(symbols).toHaveLength(1);
        expect(Object.getOwnPropertyDescriptor(voice, symbols[0]!)?.enumerable).toBe(false);
        const input = message(f.uin, 'group', voice);
        await f.emit(input, f.ticket());
        expect(f.messages()).toHaveLength(1);
        const event = f.messages()[0]!;
        expect(Object.getOwnPropertySymbols(event)).toEqual([]);
        expect(f.wire.join('')).not.toContain(VOICE_URL);
        expect(f.wire.join('')).not.toContain(VOICE_SECRET);
        const id = fileId(event, 2, 'voice');
        (voice.data as JsonObject).url = OTHER_VOICE_URL;
        expect((await getFile(f, id)).data).toEqual({ name: '', url: VOICE_URL });
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('retains the same runtime key across close/open and online changes while old tickets expire', async () => {
        const f = await account('10001');
        const oldTicket = f.ticket()!;
        await f.emit(message(f.uin, 'private'), oldTicket);
        const id = fileId(f.messages()[0]!, 2, 'voice');
        const oldTransport = f.current();
        const oldHandle = oldTransport.options.handle;
        await f.runtime.close();
        await f.open();
        expect(oldTransport.instance.isAcceptingActions()).toBe(false);
        expect(f.current().instance).not.toBe(oldTransport.instance);
        expect(f.current().instance.isAcceptingActions()).toBe(true);
        const resolver = vi.spyOn(
            (
                f.runtime as unknown as {
                    dispatcher: {
                        options: { resolveVoiceFileUrl: (fileId: string) => string | null };
                    };
                }
            ).dispatcher.options,
            'resolveVoiceFileUrl',
        );
        const redeem = vi.spyOn(tokenApi.V12VoiceFileTokens.prototype, 'redeem');
        const revoke = vi.spyOn(tokenApi.V12VoiceFileTokens.prototype, 'revoke');
        const stale = await oldHandle({
            action: 'get_file',
            params: { file_id: id, type: 'url' },
            echo: 'old-voice-lease-🪶',
        });
        expect(stale).toMatchObject({
            status: 'failed',
            retcode: 20002,
            data: null,
            echo: 'old-voice-lease-🪶',
        });
        expect(resolver).not.toHaveBeenCalled();
        expect(redeem).not.toHaveBeenCalled();
        expect(revoke).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
        expect((await getFile(f, id)).data).toEqual({ name: '', url: VOICE_URL });
        expect(resolver).toHaveBeenCalledExactlyOnceWith(id);
        expect(redeem).toHaveBeenCalledExactlyOnceWith(id);
        const reopened = f.ticket()!;
        await f.emit(message(f.uin, 'private'), oldTicket);
        expect(f.messages()).toEqual([]);
        expect((await getFile(f, id)).data).toEqual({ name: '', url: VOICE_URL });
        await f.emit(message(f.uin, 'group', record(OTHER_VOICE_URL)), reopened);
        expect(f.messages()).toHaveLength(1);
        expect((await getFile(f, fileId(f.messages()[0]!, 2, 'voice'))).data).toEqual({
            name: '',
            url: OTHER_VOICE_URL,
        });
        f.generation.setOnline(false);
        await f.emit(message(f.uin, 'private'), reopened);
        f.generation.setOnline(true);
        await f.emit(message(f.uin, 'private'), reopened);
        expect(f.messages()).toHaveLength(1);
        await f.emit(message(f.uin, 'private'), f.ticket());
        expect(f.messages()).toHaveLength(2);
        expect((await getFile(f, id)).data).toEqual({ name: '', url: VOICE_URL });
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it.each(['quiesce', 'forceClose'] as const)(
        'revokes voice on %s even through a saved fake HTTP callback',
        async (method) => {
            const f = await account('10001');
            const source = f.ticket()!;
            await f.emit(message(f.uin, 'private'), source);
            const id = fileId(f.messages()[0]!, 2, 'voice');
            const handle = f.current().options.handle;
            const resolver = vi.spyOn(
                (
                    f.runtime as unknown as {
                        dispatcher: {
                            options: { resolveVoiceFileUrl: (fileId: string) => string | null };
                        };
                    }
                ).dispatcher.options,
                'resolveVoiceFileUrl',
            );
            const redeem = vi.spyOn(tokenApi.V12VoiceFileTokens.prototype, 'redeem');
            const revoke = vi.spyOn(tokenApi.V12VoiceFileTokens.prototype, 'revoke');
            f.runtime[method]();
            await f.emit(message(f.uin, 'private'), source);
            expect(f.messages()).toHaveLength(1);
            // A saved callback models a stale in-process listener, not a socket.
            expect(
                await handle({
                    action: 'get_file',
                    params: { file_id: id, type: 'url' },
                    echo: 'voice-retired',
                }),
            ).toMatchObject({
                status: 'failed',
                retcode: 20002,
                data: null,
                echo: 'voice-retired',
            });
            expect(resolver).not.toHaveBeenCalled();
            expect(redeem).not.toHaveBeenCalled();
            expect(revoke).toHaveBeenCalledOnce();
            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );

    it('discards a voice URL if redemption synchronously retires its listener', async () => {
        const f = await account('10001');
        await f.emit(message(f.uin, 'private'), f.ticket());
        const id = fileId(f.messages()[0]!, 2, 'voice');
        const original = tokenApi.V12VoiceFileTokens.prototype.redeem;
        let decrypted = false;
        const redeem = vi
            .spyOn(tokenApi.V12VoiceFileTokens.prototype, 'redeem')
            .mockImplementation(function (
                this: InstanceType<typeof tokenApi.V12VoiceFileTokens>,
                input: string,
            ) {
                const url = original.call(this, input);

                if (input === id && url === VOICE_URL) {
                    decrypted = true;
                    f.runtime.quiesce();
                }

                return url;
            });
        const result = await getFile(f, id, 'voice-reentrant');
        expect(decrypted).toBe(true);
        expect(redeem).toHaveBeenCalledExactlyOnceWith(id);
        expect(result).toMatchObject({
            status: 'failed',
            retcode: 20002,
            data: null,
            echo: 'voice-reentrant',
        });
        expect(JSON.stringify(result)).not.toContain(VOICE_SECRET);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('isolates accounts and new runtimes, tampering and swapped image/voice prefixes without fallback', async () => {
        const a = await account('10001');
        const b = await account('10002');
        const anotherA = await account('10001');
        await a.emit(message(a.uin, 'private'), a.ticket());
        const voiceId = fileId(a.messages()[0]!, 2, 'voice');
        const imageId = fileId(a.messages()[0]!, 3, 'image');
        expect((await getFile(a, voiceId)).data).toEqual({ name: '', url: VOICE_URL });
        expect((await getFile(a, imageId)).data).toEqual({ name: '', url: IMAGE_URL });

        for (const other of [b, anotherA]) {
            for (const id of [voiceId, imageId]) {
                expect(await getFile(other, id)).toMatchObject({
                    status: 'failed',
                    retcode: 20001,
                    data: null,
                });
            }

            expect(other.api.handle).not.toHaveBeenCalled();
        }

        const malformed = [
            VOICE_PREFIX,
            `${VOICE_PREFIX}%%%`,
            tamper(voiceId, VOICE_PREFIX),
            tamper(imageId, IMAGE_PREFIX),
            VOICE_PREFIX + imageId.slice(IMAGE_PREFIX.length),
            IMAGE_PREFIX + voiceId.slice(VOICE_PREFIX.length),
        ];

        for (const id of malformed) {
            const result = await getFile(a, id);
            expect(result).toMatchObject({ status: 'failed', retcode: 20001, data: null });
            expect(JSON.stringify(result)).not.toContain(VOICE_SECRET);
        }

        expect(a.api.handle).not.toHaveBeenCalled();
        await a.emit(message(a.uin, 'private'), b.ticket());
        expect(a.messages()).toHaveLength(1);
    });

    it('preserves non-reserved aliases but rejects a legacy alias colliding with the new voice prefix', async () => {
        const f = await account('10001');
        const ordinary = 'ordinary-legacy-alias';
        expect(await getFile(f, ordinary, 'legacy')).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: { name: 'legacy.voice', url: LEGACY_URL },
            echo: 'legacy',
        });
        expect(f.api.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: ordinary });
        f.api.handle.mockClear();
        const collision = `${VOICE_PREFIX}legacy-alias`;
        expect(await getFile(f, collision)).toMatchObject({
            status: 'failed',
            retcode: 20001,
            data: null,
        });
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('drops the entire message for missing/invalid URL, extra fields and self-sent voice', async () => {
        const f = await account('10001');
        const invalid: JsonObject[] = [
            { type: 'record', data: { file: PRIVATE_FILE } },
            record(''),
            record('file:///fixture'),
            record(`https://fixture.invalid/${'x'.repeat(3001)}`),
            { type: 'record', data: { file: PRIVATE_FILE, url: VOICE_URL, extra: true } },
            { ...record(), extra: true },
            { type: 'record', data: { file: 1, url: VOICE_URL } },
            { type: 'record', data: { file: PRIVATE_FILE, url: null } },
        ];

        for (const voice of invalid) {
            await f.emit(message(f.uin, 'group', voice), f.ticket());
            expect(f.messages()).toEqual([]);
        }

        for (const detail of ['private', 'group'] as const) {
            const sent = message(f.uin, detail);
            sent.post_type = 'message_sent';
            sent.user_id = Number(f.uin);

            if (detail === 'private') {
                sent.target_id = 20001;
            }

            await f.emit(sent, f.ticket());
            expect(f.messages()).toEqual([]);
        }

        expect(f.v11.frames).toHaveLength(invalid.length + 2);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('preflights a later invalid voice URL before issuing either media handle', async () => {
        const f = await account('10001');
        const imageIssue = vi.spyOn(tokenApi.V12ImageFileTokens.prototype, 'issue');
        const voiceIssue = vi.spyOn(tokenApi.V12VoiceFileTokens.prototype, 'issue');
        const input = message(f.uin, 'private');
        input.message = [image(), record(`ftp://fixture.invalid/voice?token=${VOICE_SECRET}`)];
        const before = structuredClone(input);
        await f.emit(input, f.ticket());
        expect(imageIssue).not.toHaveBeenCalled();
        expect(voiceIssue).not.toHaveBeenCalled();
        expect(f.messages()).toEqual([]);
        expect(f.v11.frames.map((frame) => JSON.parse(frame))).toEqual([before]);
        expect(await getFile(f, `${VOICE_PREFIX}legacy-alias`)).toMatchObject({
            status: 'failed',
            retcode: 20001,
            data: null,
        });
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it.each([128, 129])(
        'enforces the combined per-event image/voice count at %i segments',
        async (count) => {
            const f = await account('10001');
            const imageIssue = vi.spyOn(tokenApi.V12ImageFileTokens.prototype, 'issue');
            const voiceIssue = vi.spyOn(tokenApi.V12VoiceFileTokens.prototype, 'issue');
            const input = message(f.uin, 'group');
            input.message = [image(), ...Array.from({ length: count - 1 }, () => record())];
            await f.emit(input, f.ticket());
            expect(f.v11.frames).toHaveLength(1);
            expect(JSON.parse(f.v11.frames[0]!).message).toEqual(input.message);

            if (count === 128) {
                expect(imageIssue).toHaveBeenCalledTimes(1);
                expect(voiceIssue).toHaveBeenCalledTimes(127);
                expect(f.messages()).toHaveLength(1);
                const event = f.messages()[0]!;
                expect(event.message).toHaveLength(128);
                expect(event.alt_message).toBe('[图片]' + '[语音]'.repeat(127));
                expect(fileId(event, 0, 'image').startsWith(IMAGE_PREFIX)).toBe(true);
                const voiceId = fileId(event, 127, 'voice');
                expect(voiceId.startsWith(VOICE_PREFIX)).toBe(true);
                expect(JSON.stringify(event)).not.toContain(VOICE_URL);
                expect((await getFile(f, voiceId)).data).toEqual({ name: '', url: VOICE_URL });
                // The budget belongs to one conversion, not the runtime lifetime.
                await f.emit(input, f.ticket());
                expect(f.messages()).toHaveLength(2);
                expect(imageIssue).toHaveBeenCalledTimes(2);
                expect(voiceIssue).toHaveBeenCalledTimes(254);
            } else {
                expect(imageIssue).not.toHaveBeenCalled();
                expect(voiceIssue).not.toHaveBeenCalled();
                expect(f.messages()).toEqual([]);
            }

            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );

    it.each([262144, 262145])(
        'enforces the aggregate media URL UTF-8 budget at %i bytes, separately from poll',
        async (totalBytes) => {
            const f = await account('10001', { orderedFixture: true });
            const { context, owner } = setupOrdered(f);
            const imageIssue = vi.spyOn(tokenApi.V12ImageFileTokens.prototype, 'issue');
            const voiceIssue = vi.spyOn(tokenApi.V12VoiceFileTokens.prototype, 'issue');
            const enqueue = vi.spyOn(pollBufferApi.EventPollBuffer.prototype, 'enqueue');
            // Each URL includes a supplementary character, so character-counting
            // would incorrectly admit the one-byte-over-budget case.
            const base = 'https://media.example.invalid/🪶?payload=';

            const urlOfBytes = (bytes: number) => {
                const padding = bytes - Buffer.byteLength(base, 'utf8');

                if (padding < 0) {
                    throw new Error('invalid synthetic URL size');
                }

                return base + 'v'.repeat(padding);
            };

            const lengths = [...Array.from({ length: 87 }, () => 3000), totalBytes - 87 * 3000];
            const urls = lengths.map(urlOfBytes);
            expect(urls).toHaveLength(88);
            expect(urls.every((url) => Buffer.byteLength(url, 'utf8') <= 3000)).toBe(true);
            expect(urls.reduce((sum, url) => sum + Buffer.byteLength(url, 'utf8'), 0)).toBe(
                totalBytes,
            );
            expect(urls.reduce((sum, url) => sum + url.length, 0)).toBeLessThan(totalBytes);
            const input = message(f.uin, 'group');
            input.message = [image(urls[0]!), ...urls.slice(1).map((url) => record(url))];

            try {
                await emitOrdered(f, context, input, f.ticket()!);
                await vi.advanceTimersByTimeAsync(0);
                await settle();
                expect(f.v11.frames).toHaveLength(1);
                expect(JSON.parse(f.v11.frames[0]!).message).toEqual(input.message);
                expect(enqueue).not.toHaveBeenCalled();

                if (totalBytes === 262144) {
                    expect(imageIssue).toHaveBeenCalledTimes(1);
                    expect(voiceIssue).toHaveBeenCalledTimes(87);
                    expect(f.messages()).toHaveLength(1);
                    const event = f.messages()[0]!;
                    expect(event.message).toHaveLength(88);
                    const eventJson = JSON.stringify(event);
                    expect(Buffer.byteLength(eventJson, 'utf8')).toBeGreaterThan(64 * 1024);
                    expect(eventJson).not.toContain(urls[0]!);
                    expect(eventJson).not.toContain(urls[87]!);
                    expect((await getFile(f, fileId(event, 0, 'image'))).data).toEqual({
                        name: '',
                        url: urls[0],
                    });
                    expect((await getFile(f, fileId(event, 87, 'voice'))).data).toEqual({
                        name: '',
                        url: urls[87],
                    });
                    // This gap belongs to the separate 64 KiB poll event budget;
                    // the WS subscriber above has already received the event.
                    expect(pollApi.pollOwnerStats(f.runtime)).toMatchObject({
                        accepted: 0,
                        ordering_gap: true,
                        ordering_reason: 'event_too_large',
                    });
                } else {
                    expect(imageIssue).not.toHaveBeenCalled();
                    expect(voiceIssue).not.toHaveBeenCalled();
                    expect(f.messages()).toEqual([]);
                }

                expect(f.api.handle).not.toHaveBeenCalled();
            } finally {
                owner.invalidate();
                await settle();
            }
        },
    );

    it('does not apply the media count budget to 256 text-only segments', async () => {
        const f = await account('10001');
        const imageIssue = vi.spyOn(tokenApi.V12ImageFileTokens.prototype, 'issue');
        const voiceIssue = vi.spyOn(tokenApi.V12VoiceFileTokens.prototype, 'issue');
        const input = message(f.uin, 'private');
        const textSegments = Array.from({ length: 256 }, () => ({
            type: 'text',
            data: { text: 'x' },
        }));
        input.message = textSegments;
        await f.manager.emitEvent(input);
        expect(f.messages()).toHaveLength(1);
        expect(f.messages()[0]).toMatchObject({
            message: textSegments,
            alt_message: 'x'.repeat(256),
        });
        expect(imageIssue).not.toHaveBeenCalled();
        expect(voiceIssue).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('rejects getter and Proxy voice segments without executing traps at the runtime conversion boundary', async () => {
        const f = await account('10001');
        const getter = vi.fn(() => {
            throw new Error(FAILURE_SECRET);
        });
        const trap = vi.fn((): never => {
            throw new Error(FAILURE_SECRET);
        });
        const getterVoice = record();
        Object.defineProperty(getterVoice.data as JsonObject, 'url', {
            enumerable: true,
            get: getter,
        });
        const proxy = new Proxy(record(), {
            get: trap,
            ownKeys: trap,
            getOwnPropertyDescriptor: trap,
            getPrototypeOf: trap,
        });
        const proxyData = {
            type: 'record',
            data: new Proxy(record().data as JsonObject, {
                get: trap,
                ownKeys: trap,
                getOwnPropertyDescriptor: trap,
                getPrototypeOf: trap,
            }),
        };

        for (const voice of [getterVoice, proxy, proxyData]) {
            await f.injectUnserializable(message(f.uin, 'private', voice), f.ticket()!);
            expect(f.messages()).toEqual([]);
        }

        expect(getter).not.toHaveBeenCalled();
        expect(trap).not.toHaveBeenCalled();
        expect(f.v11.frames).toEqual([]); // Direct injection is intentionally runtime-only.
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('rejects missing/old tickets and a missing verifier while text-only stays independent', async () => {
        const f = await account('10001');
        const oldTicket = f.ticket()!;
        await f.manager.emitEvent(message(f.uin, 'private'));
        expect(f.messages()).toEqual([]);
        f.generation.setOnline(false);
        await f.emit(message(f.uin, 'private'), oldTicket);
        f.generation.setOnline(true);
        await f.emit(message(f.uin, 'private'), oldTicket);
        expect(f.messages()).toEqual([]);
        await f.emit(message(f.uin, 'private'), f.ticket());
        expect(f.messages()).toHaveLength(1);
        const textOnly = message(f.uin, 'private');
        textOnly.message = [{ type: 'text', data: { text: 'legacy text' } }];
        await f.manager.emitEvent(textOnly);
        expect(f.messages()[1]).toMatchObject({
            message: [{ type: 'text', data: { text: 'legacy text' } }],
        });
        const noVerifier = await account('10002', { verifier: false });
        await noVerifier.emit(message(noVerifier.uin, 'group'), noVerifier.ticket());
        expect(noVerifier.messages()).toEqual([]);
        expect(f.api.handle).not.toHaveBeenCalled();
        expect(noVerifier.api.handle).not.toHaveBeenCalled();
    });

    it('does not publish a partial message when a later voice issuer throws', async () => {
        const f = await account('10001');
        const imageIssue = vi.spyOn(tokenApi.V12ImageFileTokens.prototype, 'issue');
        const voiceIssue = vi
            .spyOn(tokenApi.V12VoiceFileTokens.prototype, 'issue')
            .mockImplementation(() => {
                throw new Error(`${FAILURE_SECRET} ${VOICE_SECRET} ${VOICE_URL} ${PRIVATE_FILE}`);
            });
        const input = message(f.uin, 'group');
        input.message = [image(), record()];
        const before = structuredClone(input);
        await f.emit(input, f.ticket());
        expect(imageIssue).toHaveBeenCalledOnce();
        expect(voiceIssue).toHaveBeenCalledExactlyOnceWith(VOICE_URL);
        expect(f.messages()).toEqual([]);
        expect(f.v11.frames.map((frame) => JSON.parse(frame))).toEqual([before]);
        expect(
            logEntries.some((entry) => entry.message.includes('v12 event conversion failed')),
        ).toBe(true);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    // These are same-process synthetic reentrancy probes. Issuer identity is a
    // consistency guard, not a security boundary against code in the process.
    it('drops the whole event when voice issuance replaces the earlier image issuer', async () => {
        const f = await account('10001');
        const slot = f.runtime as unknown as ImageIssuerSlot;
        const original = new tokenApi.V12ImageFileTokens(f.uin);
        let replacement: V12ImageFileTokens | null = null;
        let swapped = false;
        const realVoiceIssue = tokenApi.V12VoiceFileTokens.prototype.issue;

        try {
            replacement = new tokenApi.V12ImageFileTokens(f.uin);
            const next = replacement;
            expect(slot.imageFileTokens).toBeNull();
            slot.imageFileTokens = original;
            const imageIssue = vi.spyOn(tokenApi.V12ImageFileTokens.prototype, 'issue');
            const voiceIssue = vi
                .spyOn(tokenApi.V12VoiceFileTokens.prototype, 'issue')
                .mockImplementation(function (
                    this: InstanceType<typeof tokenApi.V12VoiceFileTokens>,
                    url: string,
                ) {
                    const id = realVoiceIssue.call(this, url);
                    slot.imageFileTokens = next;
                    swapped = true;
                    return id;
                });
            const input = message(f.uin, 'group');
            input.message = [image(), record()];
            const before = structuredClone(input);
            const source = f.ticket()!;
            expect(f.runtime[sourceApi.verifySource](source)).toBe(true);
            await f.emit(input, source);
            expect(swapped).toBe(true);
            expect(imageIssue).toHaveBeenCalledExactlyOnceWith(IMAGE_URL);
            expect(voiceIssue).toHaveBeenCalledExactlyOnceWith(VOICE_URL);
            expect(f.runtime[sourceApi.verifySource](source)).toBe(true);
            expect(slot.imageFileTokens).toBe(next);
            expect(f.messages()).toEqual([]);
            expect(f.v11.frames.map((frame) => JSON.parse(frame))).toEqual([before]);

            const issued = imageIssue.mock.results[0];

            if (!issued || issued.type !== 'return' || typeof issued.value !== 'string') {
                throw new Error('expected an image handle before reentrancy');
            }

            expect(original.redeem(issued.value)).toBe(IMAGE_URL);
            expect(await getFile(f, issued.value)).toMatchObject({
                status: 'failed',
                retcode: 20001,
                data: null,
            });
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            slot.imageFileTokens = null;
            original.revoke();
            replacement?.revoke();
            // Also revoke the separately held voice issuer from this fixture.
            f.runtime.quiesce();
        }
    });

    it('stops later subscribers when the first subscriber replaces the image issuer', async () => {
        const firstMessages: string[] = [];
        const laterMessages: string[] = [];
        let slot!: ImageIssuerSlot;
        let replacement: V12ImageFileTokens | null = null;
        let swapped = false;
        const f = await account('10001', {
            // The fake transport registers this before the ordinary wire tap.
            firstSubscriber: (event) => {
                if (
                    !event ||
                    typeof event !== 'object' ||
                    (event as { type?: unknown }).type !== 'message'
                ) {
                    return;
                }

                firstMessages.push(JSON.stringify(event));
                slot.imageFileTokens = replacement;
                swapped = true;
            },
        });
        slot = f.runtime as unknown as ImageIssuerSlot;
        const original = new tokenApi.V12ImageFileTokens(f.uin);
        let unsubscribeLater: (() => void) | undefined;

        try {
            replacement = new tokenApi.V12ImageFileTokens(f.uin);
            expect(slot.imageFileTokens).toBeNull();
            slot.imageFileTokens = original;
            // This third listener and the fixture wire tap are both after the
            // first listener; registration's initial status is not a message.
            unsubscribeLater = f.subscribe((event) => {
                if (
                    event &&
                    typeof event === 'object' &&
                    (event as { type?: unknown }).type === 'message'
                ) {
                    laterMessages.push(JSON.stringify(event));
                }
            });
            const input = message(f.uin, 'private');
            input.message = [image(), record()];
            const source = f.ticket()!;
            expect(f.runtime[sourceApi.verifySource](source)).toBe(true);
            await f.emit(input, source);
            expect(swapped).toBe(true);
            expect(f.runtime[sourceApi.verifySource](source)).toBe(true);
            expect(slot.imageFileTokens).toBe(replacement);
            expect(firstMessages).toHaveLength(1); // Earlier delivery is not retracted.
            expect(f.messages()).toEqual([]); // The wire tap is the second subscriber.
            expect(laterMessages).toEqual([]);
            const first = sdkProtocol.parseOneBot12EventJson(firstMessages[0]!);
            const imageId = fileId(first, 0, 'image');
            const voiceId = fileId(first, 1, 'voice');
            expect(first).toMatchObject({ alt_message: '[图片][语音]' });
            expect(firstMessages[0]).not.toContain(IMAGE_URL);
            expect(firstMessages[0]).not.toContain(VOICE_URL);
            expect(original.redeem(imageId)).toBe(IMAGE_URL);
            expect(await getFile(f, imageId)).toMatchObject({
                status: 'failed',
                retcode: 20001,
                data: null,
            });
            expect((await getFile(f, voiceId)).data).toEqual({ name: '', url: VOICE_URL });
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            unsubscribeLater?.();
            slot.imageFileTokens = null;
            original.revoke();
            replacement?.revoke();
            f.runtime.quiesce();
        }
    });

    it('admits the converted mixed event to the explicitly activated in-process ordered poll fixture', async () => {
        const f = await account('10001', { orderedFixture: true });
        const { context, owner } = setupOrdered(f);
        const enqueue = vi.spyOn(pollBufferApi.EventPollBuffer.prototype, 'enqueue');

        try {
            await emitOrdered(f, context, message(f.uin, 'private'), f.ticket()!);
            await vi.advanceTimersByTimeAsync(0);
            expect(f.messages()).toHaveLength(1);
            const event = f.messages()[0]!;
            expect(enqueue).toHaveBeenCalledOnce();
            expect(enqueue.mock.calls[0]![0]).toMatchObject({
                message: [
                    { type: 'text', data: { text: 'before' } },
                    { type: 'mention', data: { user_id: '30001' } },
                    { type: 'voice', data: { file_id: fileId(event, 2, 'voice') } },
                    { type: 'image', data: { file_id: fileId(event, 3, 'image') } },
                    { type: 'text', data: { text: 'after' } },
                ],
                alt_message: 'before@30001[语音][图片]after',
            });
            expect(JSON.stringify(enqueue.mock.calls[0]![0])).not.toContain(VOICE_SECRET);
            expect(pollApi.pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 1,
                invalid: 0,
                ordering_gap: false,
            });
            const sink = new MemorySink();
            expect(await owner.start(pollRequest(), sink).result).toEqual({
                kind: 'local_finish',
                response: 'events',
            });
            const polled = JSON.parse(sink.body);
            expect(polled.data).toHaveLength(1);
            expect(sdkProtocol.parseOneBot12EventJson(JSON.stringify(polled.data[0]))).toEqual(
                event,
            );
            expect(sink.body).not.toContain(VOICE_SECRET);
            // Explicit fixture activation does not expose production HTTP polling.
            expect(await f.client.getLatestEvents()).toMatchObject({
                status: 'failed',
                retcode: 10002,
            });
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            owner.invalidate();
            await settle();
        }
    });

    it('leaves a poll gap if the source expires after voice issuance but before poll resolution', async () => {
        const f = await account('10001', { orderedFixture: true });
        const { context, owner } = setupOrdered(f);
        const enqueue = vi.spyOn(pollBufferApi.EventPollBuffer.prototype, 'enqueue');
        const original = tokenApi.V12VoiceFileTokens.prototype.issue;
        let issued = false;
        let afterIssueChecks = 0;
        let invalidated = false;
        const issue = vi
            .spyOn(tokenApi.V12VoiceFileTokens.prototype, 'issue')
            .mockImplementation(function (
                this: InstanceType<typeof tokenApi.V12VoiceFileTokens>,
                url: string,
            ) {
                const id = original.call(this, url);
                issued = true;
                return id;
            });

        f.verification.before = () => {
            if (issued && ++afterIssueChecks === 2) {
                invalidated = true;
                f.generation.setOnline(false);
                f.generation.setOnline(true);
            }
        };

        try {
            const input = message(f.uin, 'private');
            // Voice is last: the first post-issue verification is inside the
            // issuer callback; the second is the runtime's pre-poll fence.
            input.message = [image(), record()];
            await emitOrdered(f, context, input, f.ticket()!);
            await vi.advanceTimersByTimeAsync(0);
            await settle();
            expect(issue).toHaveBeenCalledOnce();
            expect(invalidated).toBe(true);
            expect(enqueue).not.toHaveBeenCalled();
            expect(f.messages()).toEqual([]);
            expect(f.v11.frames).toHaveLength(1);
            expect(pollApi.pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 0,
                ordering_gap: true,
                ordering_reason: 'child_failed',
            });
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            f.verification.before = undefined;
            owner.invalidate();
            await settle();
        }
    });

    it('releases a queued voice on source loss at the final poll precommit fence and records the gap', async () => {
        const f = await account('10001', { orderedFixture: true });
        const { context, owner } = setupOrdered(f);

        try {
            await emitOrdered(f, context, message(f.uin, 'group'), f.ticket()!);
            await vi.advanceTimersByTimeAsync(0);
            expect(pollApi.pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 1,
                ordering_gap: false,
            });
            const commit = vi.spyOn(pollBufferApi.EventPollBuffer.prototype, 'commit');
            const release = vi.spyOn(pollBufferApi.EventPollBuffer.prototype, 'release');
            const sink = new MemorySink((call) => {
                if (call === 3) {
                    f.generation.setOnline(false);
                    f.generation.setOnline(true);
                }
            });
            const result = await owner.start(pollRequest(), sink).result;
            expect(sink.openCalls).toBe(3);
            expect(result).toEqual({ kind: 'epoch_invalid' });
            expect(commit).not.toHaveBeenCalled();
            expect(release).toHaveBeenCalledOnce();
            expect(sink.writeHead).not.toHaveBeenCalled();
            expect(sink.body).toBe('');
            // Retiring the stale owner records the undelivered queued event as a gap.
            f.runtime.statusUpdate();
            await settle();
            expect(pollApi.pollOwnerStats(f.runtime)).toMatchObject({
                accepted: 1,
                ordering_gap: true,
                ordering_reason: 'child_failed',
            });
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            owner.invalidate();
            await settle();
        }
    });
});
