import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import tls from 'node:tls';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { protobuf_encode } from '@snowluma/proton';
import type { MsgInfo } from '@snowluma/proto-defs/element';
import type { MessageElement, QQEventVariant } from '@snowluma/protocol/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '@snowluma/common/logger';
import type { OneBot12Event } from '../../../sdk/src/v12/types.js';
import type { V12TransportOptions } from '../../src/v12-network';
import type { PollSink } from '../../src/v12-runtime/poll-transaction';
import type { V12Runtime } from '../../src/v12-runtime/runtime';
import type { V12Source } from '../../src/v12-runtime/source-generation';
import type { DispatchPayload } from '../../src/event-filter';
import type { ConverterContext } from '../../src/event-converter';
import type { JsonObject, NetworkBase } from '../../src/types';
import type { V12ImageFileTokens } from '../../src/v12/image-file-token';

// The fake transport exposes only runtime-created callbacks. No listener, QQ,
// Hook, Core, account, addon, signature service or third-party plugin is started.
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

const PREFIX = {
    image: 'jiyu-image:v1:',
    voice: 'jiyu-voice:v1:',
    video: 'jiyu-video:v1:',
} as const;
const ENDPOINT = 'http://fixture.invalid/';
const ACCESS_SECRET = 'SYNTHETIC_ACCESS_VIDEO_X701';
const VIDEO_SECRET = 'SYNTHETIC_VIDEO_QUERY_X702';
const VOICE_SECRET = 'SYNTHETIC_VOICE_QUERY_X703';
const IMAGE_SECRET = 'SYNTHETIC_IMAGE_QUERY_X704';
const PRIVATE_FILE = 'SYNTHETIC_PRIVATE_VIDEO_FILE_X705';
const THROW_SECRET = 'SYNTHETIC_PROVIDER_ERROR_X706';
// These are URL snapshots, not evidence of download, file bytes or playback.
const VIDEO_URL = `https://media.example.invalid/clip%20one.mp4?sig=${VIDEO_SECRET}&raw=%2f%2F+%20#part`;
const VOICE_URL = `https://media.example.invalid/voice?sig=${VOICE_SECRET}`;
const IMAGE_URL = `https://media.example.invalid/image?sig=${IMAGE_SECRET}`;
const LEGACY_URL = 'https://media.example.invalid/legacy';
const activeRuntimes: V12Runtime[] = [];

let runtimeApi: typeof import('../../src/v12-runtime/runtime');
let sourceApi: typeof import('../../src/v12-runtime/source-generation');
let managerApi: typeof import('../../src/network/network-manager');
let adapterApi: typeof import('../../src/network/adapter');
let identityApi: typeof import('../../src/v12-runtime/identity');
let pollApi: typeof import('../../src/v12-runtime/poll-owner');
let tokens: typeof import('../../src/v12/image-file-token');
let converter: typeof import('../../src/event-converter');
let mediaUrlApi: typeof import('../../src/media-url-resolver');
let richDecoder: typeof import('../../../protocol/src/msg-push/rich-body-decoder');
let sdkHttp: typeof import('../../../sdk/src/v12/http-client.js');
let sdkWs: typeof import('../../../sdk/src/v12/websocket-client.js');
let loggerApi: typeof import('@snowluma/common/logger');
let previousLevel: ReturnType<typeof import('@snowluma/common/logger').getLogLevel>;
let unsubscribeLogs: (() => void) | undefined;
let logs: LogEntry[];
let guards: Array<{ mock: { calls: unknown[] } }>;
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    vi.stubEnv('SNOWLUMA_LOG_FILE', '0');
    fixture.transports.length = 0;
    fixture.forbiddenModules.length = 0;

    const forbidden = (): never => {
        throw new Error('unexpected network, child process or native operation');
    };

    fetchGuard = vi.fn(forbidden);
    webSocketGuard = vi.fn(function BlockWebSocket() {
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
        vi.spyOn(process, 'dlopen').mockImplementation(forbidden),
    ];

    // Production modules load only after the guards are armed. Proton's local
    // compile-time encoder is statically imported so the workspace plugin can
    // replace protobuf_encode<MsgInfo>; it never opens an account or transport.
    loggerApi = await import('@snowluma/common/logger');
    previousLevel = loggerApi.getLogLevel();
    loggerApi.setLogLevel('trace');
    logs = [];
    unsubscribeLogs = loggerApi.subscribeLogs((entry) => logs.push(entry));
    sourceApi = await import('../../src/v12-runtime/source-generation');
    pollApi = await import('../../src/v12-runtime/poll-owner');
    adapterApi = await import('../../src/network/adapter');
    managerApi = await import('../../src/network/network-manager');
    identityApi = await import('../../src/v12-runtime/identity');
    runtimeApi = await import('../../src/v12-runtime/runtime');
    tokens = await import('../../src/v12/image-file-token');
    converter = await import('../../src/event-converter');
    mediaUrlApi = await import('../../src/media-url-resolver');
    richDecoder = await import('../../../protocol/src/msg-push/rich-body-decoder');
    sdkHttp = await import('../../../sdk/src/v12/http-client.js');
    sdkWs = await import('../../../sdk/src/v12/websocket-client.js');
});

afterEach(async () => {
    try {
        for (const runtime of activeRuntimes.splice(0)) {
            runtime.quiesce();
            await runtime.close();
        }

        await settle();
    } finally {
        const guardCalls = guards.map((guard) => guard.mock.calls.length);
        const globalFetchCalls = fetchGuard.mock.calls.length;
        const globalWebSocketCalls = webSocketGuard.mock.calls.length;
        const forbiddenModules = [...fixture.forbiddenModules];
        const diagnostics = JSON.stringify(logs ?? []);
        unsubscribeLogs?.();
        unsubscribeLogs = undefined;
        loggerApi?.setLogLevel(previousLevel);
        vi.clearAllTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        vi.useRealTimers();
        expect(guardCalls).toEqual(guardCalls.map(() => 0));
        expect(globalFetchCalls).toBe(0);
        expect(globalWebSocketCalls).toBe(0);
        expect(forbiddenModules).toEqual([]);

        for (const secret of [
            ACCESS_SECRET,
            VIDEO_SECRET,
            VOICE_SECRET,
            IMAGE_SECRET,
            PRIVATE_FILE,
            THROW_SECRET,
            VIDEO_URL,
            VOICE_URL,
            IMAGE_URL,
        ]) {
            expect(diagnostics).not.toContain(secret);
        }
    }
});

class MemorySink extends EventEmitter implements PollSink {
    body = '';
    readonly writeHead = vi.fn();
    isOpen(): boolean {
        return true;
    }
    end(body: string): void {
        this.body = body;
        this.emit('finish');
    }
}

async function settle() {
    for (let i = 0; i < 20; i += 1) {
        await Promise.resolve();
    }
}

async function account(uin: string) {
    const generation = new sourceApi.SourceGeneration();
    const manager = new managerApi.OneBotNetworkManager();
    const verification: { before?: () => void } = {};
    const api = {
        handle: vi.fn(async (action: string, _params: JsonObject) => {
            if (action !== 'get_file') {
                throw new Error('unexpected legacy action');
            }

            // Even colliding aliases would succeed here; reserved prefixes must
            // never reach this intentionally permissive fake.
            return {
                status: 'ok' as const,
                retcode: 0,
                data: { file_name: 'legacy.mp4', url: LEGACY_URL },
            };
        }),
        handleV12SensitiveMessage: vi.fn(async () => {
            throw new Error('unexpected real send');
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
            isSourceCurrent: (source: V12Source | undefined, binding: object | null) => {
                verification.before?.();
                return (
                    manager.get(identityApi.V12_ADAPTER_NAME) === runtime &&
                    generation.isCurrent(source, binding)
                );
            },
        },
    );
    activeRuntimes.push(runtime);
    manager.register(runtime);
    class LegacyCapture extends adapterApi.IOneBotNetworkAdapter<NetworkBase> {
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
    const legacy = new LegacyCapture();
    legacy.open();
    manager.register(legacy);
    generation.setOnline(true);
    let transport: (typeof fixture.transports)[number] | undefined;

    const reopen = async () => {
        await runtime.open();
        transport = fixture.transports.at(-1);

        if (!transport || !transport.instance.isAcceptingActions() || !transport.options.httpPoll) {
            throw new Error('expected ready in-memory runtime transport');
        }
    };

    await reopen();

    const current = () => {
        if (!transport) {
            throw new Error('missing fake transport');
        }

        return transport;
    };

    const fakeFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(url).toBe(ENDPOINT);
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('error');
        const request = JSON.parse(init?.body as string) as { action: string };
        let body: string;

        if (request.action === 'get_latest_events') {
            const sink = new MemorySink();
            const capability = current().options.httpPoll;

            if (!capability) {
                throw new Error('missing real runtime poll capability');
            }

            const result = await capability.run(request, {
                sink,
                signal: new AbortController().signal,
                responseDeadline: performance.now() + 10_000,
                maxOutputBytes: 1024 * 1024,
            });
            expect(result.kind).toBe('outcome');

            if (result.kind !== 'outcome' || result.outcome.kind !== 'local_finish' || !sink.body) {
                throw new Error('synthetic HTTP poll did not finish locally');
            }

            body = sink.body;
        } else {
            body = JSON.stringify(await current().options.handle(request));
        }

        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new sdkHttp.OneBot12HttpClient({
        baseUrl: ENDPOINT,
        fetch: fakeFetch,
        requestTimeoutMs: 0,
    });
    const ticket = () => generation.capture(runtime[sourceApi.captureBinding]());
    const emit = (event: JsonObject, source: V12Source | undefined = ticket()) =>
        manager.emitEvent(event, source);
    const rawInject = (event: JsonObject, source: V12Source) =>
        runtime[sourceApi.receiveSourceEvent](
            event,
            {
                isSelfMessage: false,
                arrayJson: '{}',
                stringJson: '{}',
            },
            source,
        );
    return {
        uin,
        generation,
        manager,
        runtime,
        verification,
        api,
        legacy,
        current,
        reopen,
        ticket,
        emit,
        rawInject,
        client,
        fakeFetch,
    };
}

type Account = Awaited<ReturnType<typeof account>>;
type ImageSlot = { imageFileTokens: V12ImageFileTokens | null };

function video(url = VIDEO_URL): JsonObject {
    return { type: 'video', data: { file: PRIVATE_FILE, url } };
}

function voice(url = VOICE_URL): JsonObject {
    return { type: 'record', data: { file: 'synthetic-voice-file', url } };
}

function image(url = IMAGE_URL): JsonObject {
    return {
        type: 'image',
        data: { file: 'synthetic-image-file', url, sub_type: 0, summary: '[图片]' },
    };
}

function message(
    uin: string,
    detail: 'private' | 'group',
    segments: JsonObject[] = [video()],
): JsonObject {
    return {
        time: 1_700_000_000,
        self_id: Number(uin),
        post_type: 'message',
        message_type: detail,
        sub_type: detail === 'private' ? 'friend' : 'normal',
        message_id: -123,
        user_id: 20001,
        ...(detail === 'group' ? { group_id: 40001 } : {}),
        message: segments,
        raw_message: 'synthetic CQ representation',
    };
}

function fileId(event: OneBot12Event, index: number, kind: keyof typeof PREFIX): string {
    if (!Array.isArray(event.message)) {
        throw new Error('message array missing');
    }

    const segment = event.message[index];

    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
        throw new Error('segment missing');
    }

    const data = segment.data;

    if (
        segment.type !== kind ||
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        typeof data.file_id !== 'string'
    ) {
        throw new Error('unexpected media segment');
    }

    return data.file_id;
}

async function getFile(f: Account, id: string, echo = 'file') {
    return f.client.request(
        'get_file',
        { file_id: id, type: 'url' },
        {
            self: { platform: 'qq', user_id: f.uin },
            echo,
        },
    );
}

function tamper(id: string, prefix: string) {
    const packed = Buffer.from(id.slice(prefix.length), 'base64url');
    packed[12] ^= 1;
    return prefix + packed.toString('base64url');
}

// The SDK uses this injected constructor, not global WebSocket. Events enter
// through the runtime's real subscriber callback and the SDK's real WS parser.
async function connectSdkWs(f: Account) {
    type Listener = (event: { data?: string }) => void;
    let socket!: FakeSocket;
    class FakeSocket {
        readyState = 0;
        bufferedAmount = 0;
        readonly frames: string[] = [];
        private readonly listeners = new Map<string, Listener[]>();
        constructor(url: string) {
            expect(url).toBe('ws://fixture.invalid/');
            socket = this;
        }
        addEventListener(type: string, listener: Listener): void {
            const listeners = this.listeners.get(type) ?? [];
            listeners.push(listener);
            this.listeners.set(type, listeners);
        }
        fire(type: string, event: { data?: string } = {}): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }
        open(): void {
            this.readyState = 1;
            this.fire('open');
        }
        deliver(value: unknown): void {
            const data = JSON.stringify(value);
            this.frames.push(data);
            this.fire('message', { data });
        }
        close(): void {
            this.readyState = 3;
            this.fire('close');
        }
        readonly send = vi.fn((): never => {
            throw new Error('unexpected WebSocket action');
        });
    }
    const client = new sdkWs.OneBot12WebSocketClient({
        url: 'ws://fixture.invalid/',
        webSocket: FakeSocket as unknown as typeof WebSocket,
        requestTimeoutMs: 0,
    });
    const messages: OneBot12Event[] = [];
    const errors: unknown[] = [];
    client.onEvent((event) => {
        if (event.type === 'message') {
            messages.push(event);
        }
    });
    client.onError((error) => errors.push(error));
    const opening = client.connect();
    socket.open();
    await opening;
    const unsubscribe = f.current().options.subscribe((event) => socket.deliver(event));
    return {
        client,
        messages,
        errors,
        socket,
        close: () => {
            unsubscribe();
            client.close();
            expect(socket.send).not.toHaveBeenCalled();
        },
    };
}

// Proton encodes a synthetic nested NT video. The real decoder and v11
// converter are used without constructing an IdentityService or an account.
async function decodedVideoEvent(
    f: Account,
    detail: 'private' | 'group',
    options: {
        mediaResolver?: NonNullable<ConverterContext['mediaUrlResolver']>;
        videoSkipped?: boolean;
    } = {},
) {
    const msgInfo = protobuf_encode<MsgInfo>({
        msgInfoBody: [
            {
                index: {
                    fileUuid: 'synthetic-video-uuid',
                    storeId: 1,
                    uploadTime: 1_700_000_000,
                    ttl: 3600,
                    info: {
                        fileName: PRIVATE_FILE,
                        fileSize: 4096,
                        fileHash: 'a'.repeat(32),
                        fileSha1: 'b'.repeat(40),
                        width: 640,
                        height: 360,
                        time: 3,
                        type: { type: 2, videoFormat: 1 },
                    },
                },
            },
        ],
    });
    const elements = richDecoder.decodeRichBody(
        {
            richText: {
                elems: [
                    { text: { str: 'before ' } },
                    {
                        commonElem: {
                            serviceType: 48,
                            businessType: detail === 'group' ? 21 : 11,
                            pbElem: msgInfo,
                        },
                    },
                    { text: { str: ' after' } },
                ],
            },
        },
        detail === 'group',
    );
    expect(elements).toMatchObject([
        { type: 'text', text: 'before ' },
        { type: 'video', fileName: PRIVATE_FILE, fileId: 'synthetic-video-uuid', duration: 3 },
        { type: 'text', text: ' after' },
    ]);
    const event: QQEventVariant =
        detail === 'private'
            ? {
                  kind: 'friend_message',
                  time: 1_700_000_000,
                  selfUin: Number(f.uin),
                  senderUin: 20001,
                  senderNick: 'synthetic',
                  msgSeq: 7,
                  msgId: 8,
                  elements,
              }
            : {
                  kind: 'group_message',
                  time: 1_700_000_000,
                  selfUin: Number(f.uin),
                  senderUin: 20001,
                  senderNick: 'synthetic',
                  senderCard: '',
                  senderRole: 'member',
                  groupId: 40001,
                  groupName: 'synthetic',
                  msgSeq: 7,
                  msgId: 8,
                  elements,
              };
    const resolver = vi.fn(
        options.mediaResolver ??
            (async (_element: MessageElement, _isGroup: boolean, _sessionId: number) => VIDEO_URL),
    );
    const sink = vi.fn(async () => {});
    const v11 = await converter.convertEvent(
        {
            selfId: Number(f.uin),
            imageUrlResolver: null,
            mediaUrlResolver: resolver,
            messageIdResolver: () => -123,
            mediaSegmentSink: sink,
        },
        event,
    );

    if (!v11 || !Array.isArray(v11.message)) {
        throw new Error('v11 synthetic video event missing');
    }

    expect(resolver).toHaveBeenCalledOnce();

    if (options.videoSkipped) {
        expect(v11.message).toEqual([
            { type: 'text', data: { text: 'before ' } },
            { type: 'text', data: { text: ' after' } },
        ]);
        expect(sink).not.toHaveBeenCalled();
    } else {
        const segment = v11.message[1] as JsonObject;
        const symbols = Object.getOwnPropertySymbols(segment);
        expect(symbols.length).toBeGreaterThan(0);
        expect(
            symbols.every(
                (key) => Object.getOwnPropertyDescriptor(segment, key)?.enumerable === false,
            ),
        ).toBe(true);
        expect(sink).toHaveBeenCalledOnce();
    }

    return v11;
}

function fakeMediaResolver(mode: 'success' | 'bridge-failure' | 'rkey-failure') {
    const result = async () => {
        if (mode === 'bridge-failure') {
            throw new Error(`${THROW_SECRET} ${VIDEO_SECRET} ${VIDEO_URL}`);
        }

        return VIDEO_URL;
    };

    const bridge = {
        apis: {
            groupFile: {
                getVideoUrl: vi.fn(async (_group: number, _node: unknown) => result()),
                getPrivateVideoUrl: vi.fn(async (_node: unknown) => result()),
            },
        },
    };
    const rkey = {
        resolveMediaUrl: vi.fn(
            async (_bridge: unknown, element: MessageElement, _isGroup: boolean) => {
                if (mode === 'rkey-failure') {
                    throw new Error('synthetic rkey failure');
                }

                return element.url ?? '';
            },
        ),
    };
    const resolver = new mediaUrlApi.MediaUrlResolver(bridge as never, rkey as never);
    return { bridge, rkey, resolve: resolver.resolve.bind(resolver) };
}

describe('synthetic video through production runtime and injected SDK transports', () => {
    it.each(['private', 'group'] as const)(
        'decodes %s video through Proton/v11 and returns the same source event via SDK WS and HTTP poll',
        async (detail) => {
            const f = await account('10001');
            const ws = await connectSdkWs(f);

            try {
                const input = await decodedVideoEvent(f, detail);
                const serializedV11 = JSON.stringify(input);
                await f.emit(input, f.ticket());
                expect(ws.errors).toEqual([]);
                expect(ws.messages).toHaveLength(1);
                const event = ws.messages[0]!;
                const id = fileId(event, 1, 'video');
                expect(id.startsWith(PREFIX.video)).toBe(true);
                expect(event).toMatchObject({
                    self: { platform: 'qq', user_id: f.uin },
                    detail_type: detail,
                    message_id: '-123',
                    alt_message: 'before [视频] after',
                    message: [
                        { type: 'text', data: { text: 'before ' } },
                        { type: 'video', data: { file_id: id } },
                        { type: 'text', data: { text: ' after' } },
                    ],
                });
                expect(f.legacy.frames).toEqual([serializedV11]);
                const polled = await f.client.getLatestEvents(
                    { limit: 0, timeout: 0 },
                    {
                        self: { platform: 'qq', user_id: f.uin },
                        echo: 'poll',
                    },
                );
                expect(polled).toMatchObject({
                    status: 'ok',
                    retcode: 0,
                    echo: 'poll',
                    data: [event],
                });
                expect(await getFile(f, id, 'first')).toEqual({
                    status: 'ok',
                    retcode: 0,
                    message: '',
                    echo: 'first',
                    data: { name: '', url: VIDEO_URL },
                });
                expect((await getFile(f, id, 'second')).data).toEqual({ name: '', url: VIDEO_URL });
                const output = JSON.stringify({ frames: ws.socket.frames, poll: polled });

                for (const secret of [VIDEO_URL, VIDEO_SECRET, PRIVATE_FILE]) {
                    expect(output).not.toContain(secret);
                }

                expect(
                    JSON.stringify(f.fakeFetch.mock.calls.map(([, init]) => init?.body)),
                ).not.toContain(VIDEO_SECRET);
                expect(f.api.handle).not.toHaveBeenCalled();
                expect(f.api.handleV12SensitiveMessage).not.toHaveBeenCalled();
            } finally {
                ws.close();
            }
        },
    );

    it.each(['private', 'group'] as const)(
        'uses the real MediaUrlResolver and synthetic %s bridge to populate the decoded video URL',
        async (detail) => {
            const f = await account('10001');
            const ws = await connectSdkWs(f);
            const media = fakeMediaResolver('success');

            try {
                const input = await decodedVideoEvent(f, detail, { mediaResolver: media.resolve });
                const segment = (input.message as JsonObject[])[1]!;
                expect(segment.data).toEqual({ file: PRIVATE_FILE, url: VIDEO_URL });
                const node = expect.objectContaining({ fileUuid: 'synthetic-video-uuid' });

                if (detail === 'group') {
                    expect(media.bridge.apis.groupFile.getVideoUrl).toHaveBeenCalledExactlyOnceWith(
                        40001,
                        node,
                    );
                    expect(media.bridge.apis.groupFile.getPrivateVideoUrl).not.toHaveBeenCalled();
                } else {
                    expect(
                        media.bridge.apis.groupFile.getPrivateVideoUrl,
                    ).toHaveBeenCalledExactlyOnceWith(node);
                    expect(media.bridge.apis.groupFile.getVideoUrl).not.toHaveBeenCalled();
                }

                expect(media.rkey.resolveMediaUrl).toHaveBeenCalledOnce();
                await f.emit(input, f.ticket());
                expect(ws.messages).toHaveLength(1);
                expect((await getFile(f, fileId(ws.messages[0]!, 1, 'video'))).data).toEqual({
                    name: '',
                    url: VIDEO_URL,
                });
                expect(f.api.handle).not.toHaveBeenCalled();
            } finally {
                ws.close();
            }
        },
    );

    it.each(['private', 'group'] as const)(
        'keeps an empty v11 video URL but drops the v12 event when the synthetic %s bridge fails',
        async (detail) => {
            const f = await account('10001');
            const ws = await connectSdkWs(f);
            const media = fakeMediaResolver('bridge-failure');
            const issue = vi.spyOn(tokens.V12VideoFileTokens.prototype, 'issue');

            try {
                const input = await decodedVideoEvent(f, detail, { mediaResolver: media.resolve });
                const segment = (input.message as JsonObject[])[1]!;
                expect(segment.data).toEqual({ file: PRIVATE_FILE, url: '' });
                expect(media.rkey.resolveMediaUrl).toHaveBeenCalledOnce();
                expect(
                    detail === 'group'
                        ? media.bridge.apis.groupFile.getVideoUrl
                        : media.bridge.apis.groupFile.getPrivateVideoUrl,
                ).toHaveBeenCalledOnce();
                await f.emit(input, f.ticket());
                expect(issue).not.toHaveBeenCalled();
                expect(ws.messages).toEqual([]);
                expect(JSON.parse(f.legacy.frames[0]!)).toEqual(JSON.parse(JSON.stringify(input)));
                expect((await f.client.getLatestEvents()).data).toEqual([]);
                expect(f.api.handle).not.toHaveBeenCalled();
            } finally {
                ws.close();
            }
        },
    );

    it('observes text-only delivery if an upstream rkey failure already removed the video segment', async () => {
        const f = await account('10001');
        const ws = await connectSdkWs(f);
        const media = fakeMediaResolver('rkey-failure');
        const issue = vi.spyOn(tokens.V12VideoFileTokens.prototype, 'issue');

        try {
            const input = await decodedVideoEvent(f, 'group', {
                mediaResolver: media.resolve,
                videoSkipped: true,
            });
            expect(media.bridge.apis.groupFile.getVideoUrl).toHaveBeenCalledOnce();
            expect(media.rkey.resolveMediaUrl).toHaveBeenCalledOnce();
            await f.emit(input, f.ticket());
            expect(issue).not.toHaveBeenCalled();
            expect(ws.messages).toHaveLength(1);
            expect(ws.messages[0]).toMatchObject({
                message: [
                    { type: 'text', data: { text: 'before ' } },
                    { type: 'text', data: { text: ' after' } },
                ],
                alt_message: 'before  after',
            });
            expect((await f.client.getLatestEvents()).data).toEqual([ws.messages[0]]);
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            ws.close();
        }
    });

    it('preserves mixed image/voice/video order and issues all IDs without exposing the source URLs', async () => {
        const f = await account('10001');
        const ws = await connectSdkWs(f);

        try {
            const input = message(f.uin, 'group', [
                { type: 'text', data: { text: 'A' } },
                image(),
                { type: 'at', data: { qq: '30001' } },
                voice(),
                video(),
                { type: 'at', data: { qq: 'all' } },
                { type: 'text', data: { text: 'Z' } },
            ]);
            const before = structuredClone(input);
            await f.emit(input, f.ticket());
            expect(ws.messages).toHaveLength(1);
            const event = ws.messages[0]!;
            const imageId = fileId(event, 1, 'image');
            const voiceId = fileId(event, 3, 'voice');
            const videoId = fileId(event, 4, 'video');
            expect([
                imageId.startsWith(PREFIX.image),
                voiceId.startsWith(PREFIX.voice),
                videoId.startsWith(PREFIX.video),
            ]).toEqual([true, true, true]);
            expect(event).toMatchObject({
                alt_message: 'A[图片]@30001[语音][视频]@全体成员Z',
                message: [
                    { type: 'text', data: { text: 'A' } },
                    { type: 'image', data: { file_id: imageId } },
                    { type: 'mention', data: { user_id: '30001' } },
                    { type: 'voice', data: { file_id: voiceId } },
                    { type: 'video', data: { file_id: videoId } },
                    { type: 'mention_all', data: {} },
                    { type: 'text', data: { text: 'Z' } },
                ],
            });
            expect(input).toEqual(before);
            expect(JSON.parse(f.legacy.frames[0]!)).toEqual(before);
            expect((await getFile(f, imageId)).data).toEqual({ name: '', url: IMAGE_URL });
            expect((await getFile(f, voiceId)).data).toEqual({ name: '', url: VOICE_URL });
            expect((await getFile(f, videoId)).data).toEqual({ name: '', url: VIDEO_URL });
            expect((await f.client.getLatestEvents()).data).toEqual([event]);
            expect(JSON.stringify(event)).not.toContain(VIDEO_SECRET);
            expect(JSON.stringify(event)).not.toContain(VOICE_SECRET);
            expect(JSON.stringify(event)).not.toContain(IMAGE_SECRET);
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            ws.close();
        }
    });

    it('isolates account/runtime/purpose and rejects damaged or reserved alias handles without legacy fallback', async () => {
        const a = await account('10001');
        const b = await account('10002');
        const sameAccount = await account('10001');
        const ws = await connectSdkWs(a);

        try {
            await a.emit(message(a.uin, 'private', [image(), voice(), video()]), a.ticket());
            const event = ws.messages[0]!;
            const img = fileId(event, 0, 'image');
            const aud = fileId(event, 1, 'voice');
            const vid = fileId(event, 2, 'video');
            expect((await getFile(a, vid)).data).toEqual({ name: '', url: VIDEO_URL });

            for (const other of [b, sameAccount]) {
                expect(await getFile(other, vid)).toMatchObject({
                    status: 'failed',
                    retcode: 20001,
                    data: null,
                });
                expect(other.api.handle).not.toHaveBeenCalled();
            }

            const damaged = [
                PREFIX.video,
                `${PREFIX.video}%%%`,
                `${PREFIX.video}legacy-collision`,
                `${PREFIX.video}${VIDEO_SECRET}`,
                tamper(vid, PREFIX.video),
                PREFIX.video + img.slice(PREFIX.image.length),
                PREFIX.video + aud.slice(PREFIX.voice.length),
                PREFIX.image + vid.slice(PREFIX.video.length),
                PREFIX.voice + vid.slice(PREFIX.video.length),
            ];

            for (const id of damaged) {
                const result = await getFile(a, id);
                expect(result).toMatchObject({ status: 'failed', retcode: 20001, data: null });
                expect(JSON.stringify(result)).not.toContain(VIDEO_SECRET);
                expect(a.api.handle).not.toHaveBeenCalled();
            }

            const badParams = await a.client.request('get_file', {
                file_id: vid,
                type: 'url',
                unexpected: VIDEO_SECRET,
            });
            expect(badParams).toMatchObject({ status: 'failed', retcode: 10004, data: null });
            expect(JSON.stringify(badParams)).not.toContain(VIDEO_SECRET);
            expect(a.api.handle).not.toHaveBeenCalled();
            const alias = 'ordinary-v11-video-alias';
            expect((await getFile(a, alias)).data).toEqual({ name: 'legacy.mp4', url: LEGACY_URL });
            expect(a.api.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: alias });
            await a.emit(message(a.uin, 'private'), b.ticket());
            expect(ws.messages).toHaveLength(1);
        } finally {
            ws.close();
        }
    });

    it('keeps the snapshot across time and same-runtime reopen, fences the old poll lease and revokes on quiesce', async () => {
        const f = await account('10001');
        const ws = await connectSdkWs(f);
        const oldTicket = f.ticket()!;
        await f.emit(message(f.uin, 'private'), oldTicket);
        const id = fileId(ws.messages[0]!, 0, 'video');
        const oldTransport = f.current();
        const oldHandle = oldTransport.options.handle;
        const oldPoll = oldTransport.options.httpPoll!;
        vi.setSystemTime(Date.now() + 365 * 24 * 60 * 60 * 1000);
        expect((await getFile(f, id)).data).toEqual({ name: '', url: VIDEO_URL });
        ws.close();
        await f.runtime.close();
        await settle();
        await f.reopen();
        const staleSink = new MemorySink();
        const stale = await oldPoll.run(
            { action: 'get_latest_events', params: {} },
            {
                sink: staleSink,
                signal: new AbortController().signal,
                responseDeadline: performance.now() + 10000,
                maxOutputBytes: 65536,
            },
        );
        expect(stale).toEqual({ kind: 'unavailable' });
        expect(staleSink.body).toBe('');
        expect(oldTransport.instance.isAcceptingActions()).toBe(false);
        expect(f.current().instance).not.toBe(oldTransport.instance);
        expect(f.current().instance.isAcceptingActions()).toBe(true);
        const resolver = vi.spyOn(
            (
                f.runtime as unknown as {
                    dispatcher: {
                        options: { resolveVideoFileUrl: (fileId: string) => string | null };
                    };
                }
            ).dispatcher.options,
            'resolveVideoFileUrl',
        );
        const redeem = vi.spyOn(tokens.V12VideoFileTokens.prototype, 'redeem');
        const oldLeaseRevoke = vi.spyOn(tokens.V12VideoFileTokens.prototype, 'revoke');
        const staleFile = await oldHandle({
            action: 'get_file',
            params: { file_id: id, type: 'url' },
            echo: 'old-video-lease-🪶',
        });
        expect(staleFile).toMatchObject({
            status: 'failed',
            retcode: 20002,
            data: null,
            echo: 'old-video-lease-🪶',
        });
        expect(resolver).not.toHaveBeenCalled();
        expect(redeem).not.toHaveBeenCalled();
        expect(oldLeaseRevoke).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
        expect((await getFile(f, id)).data).toEqual({ name: '', url: VIDEO_URL });
        expect(resolver).toHaveBeenCalledExactlyOnceWith(id);
        expect(redeem).toHaveBeenCalledExactlyOnceWith(id);
        const reopenedWs = await connectSdkWs(f);

        try {
            await f.emit(message(f.uin, 'private'), oldTicket);
            expect(reopenedWs.messages).toEqual([]);
            const online = f.ticket()!;
            f.generation.setOnline(false);
            await f.emit(message(f.uin, 'private'), online);
            f.generation.setOnline(true);
            await f.emit(message(f.uin, 'private'), online);
            expect(reopenedWs.messages).toEqual([]);
            await f.emit(message(f.uin, 'private'), f.ticket());
            expect(reopenedWs.messages).toHaveLength(1);
            expect((await getFile(f, id)).data).toEqual({ name: '', url: VIDEO_URL });
            const savedHandle = f.current().options.handle;
            resolver.mockClear();
            redeem.mockClear();
            const revoke = oldLeaseRevoke;
            f.runtime.quiesce();
            const revoked = await savedHandle({
                action: 'get_file',
                params: { file_id: id, type: 'url' },
                echo: 'closed',
            });
            expect(revoked).toMatchObject({
                status: 'failed',
                retcode: 20002,
                data: null,
                echo: 'closed',
            });
            expect(resolver).not.toHaveBeenCalled();
            expect(redeem).not.toHaveBeenCalled();
            expect(revoke).toHaveBeenCalledOnce();
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            reopenedWs.close();
        }
    });

    it('revokes video on forceClose without falling back to a legacy alias', async () => {
        const f = await account('10001');
        const ws = await connectSdkWs(f);

        try {
            await f.emit(message(f.uin, 'private'), f.ticket());
            const id = fileId(ws.messages[0]!, 0, 'video');
            const savedHandle = f.current().options.handle;
            const resolver = vi.spyOn(
                (
                    f.runtime as unknown as {
                        dispatcher: {
                            options: { resolveVideoFileUrl: (fileId: string) => string | null };
                        };
                    }
                ).dispatcher.options,
                'resolveVideoFileUrl',
            );
            const redeem = vi.spyOn(tokens.V12VideoFileTokens.prototype, 'redeem');
            const revoke = vi.spyOn(tokens.V12VideoFileTokens.prototype, 'revoke');
            f.runtime.forceClose();
            const result = await savedHandle({
                action: 'get_file',
                params: { file_id: id, type: 'url' },
                echo: 'video-forced',
            });
            expect(result).toMatchObject({
                status: 'failed',
                retcode: 20002,
                data: null,
                echo: 'video-forced',
            });
            expect(resolver).not.toHaveBeenCalled();
            expect(redeem).not.toHaveBeenCalled();
            expect(revoke).toHaveBeenCalledOnce();
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            ws.close();
        }
    });

    it('does not return a stale URL when video redemption synchronously quiesces the runtime', async () => {
        const f = await account('10001');
        const ws = await connectSdkWs(f);

        try {
            await f.emit(message(f.uin, 'private'), f.ticket());
            const id = fileId(ws.messages[0]!, 0, 'video');
            const originalRedeem = tokens.V12VideoFileTokens.prototype.redeem;
            let revokedAfterDecrypt = false;
            const redeem = vi
                .spyOn(tokens.V12VideoFileTokens.prototype, 'redeem')
                .mockImplementation(function (
                    this: InstanceType<typeof tokens.V12VideoFileTokens>,
                    input: string,
                ) {
                    const url = originalRedeem.call(this, input);

                    if (input === id && url === VIDEO_URL) {
                        revokedAfterDecrypt = true;
                        f.runtime.quiesce();
                    }

                    return url;
                });
            const result = await getFile(f, id);
            expect(redeem).toHaveBeenCalledExactlyOnceWith(id);
            expect(revokedAfterDecrypt).toBe(true);
            expect(result).toMatchObject({ status: 'failed', retcode: 20002, data: null });
            expect(JSON.stringify(result)).not.toContain(VIDEO_SECRET);
            expect(JSON.stringify(result)).not.toContain(VIDEO_URL);
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            ws.close();
        }
    });

    it('redacts video provider throws as 20002 while an authentic bad tag stays 20001', async () => {
        const f = await account('10001');
        const ws = await connectSdkWs(f);

        try {
            await f.emit(message(f.uin, 'private'), f.ticket());
            const id = fileId(ws.messages[0]!, 0, 'video');
            const redeem = vi
                .spyOn(tokens.V12VideoFileTokens.prototype, 'redeem')
                .mockImplementation(() => {
                    throw new Error(`${THROW_SECRET} ${VIDEO_SECRET} ${VIDEO_URL}`);
                });
            const failed = await getFile(f, id);
            expect(failed).toMatchObject({ status: 'failed', retcode: 20002, data: null });
            expect(JSON.stringify(failed)).not.toContain(VIDEO_SECRET);
            expect(JSON.stringify(failed)).not.toContain(THROW_SECRET);
            redeem.mockRestore();
            expect(await getFile(f, tamper(id, PREFIX.video))).toMatchObject({
                status: 'failed',
                retcode: 20001,
                data: null,
            });
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            ws.close();
        }
    });

    it('prevalidates a later bad video URL before any of the three issuers', async () => {
        const f = await account('10001');
        const ws = await connectSdkWs(f);
        const imageIssue = vi.spyOn(tokens.V12ImageFileTokens.prototype, 'issue');
        const voiceIssue = vi.spyOn(tokens.V12VoiceFileTokens.prototype, 'issue');
        const videoIssue = vi.spyOn(tokens.V12VideoFileTokens.prototype, 'issue');

        try {
            const input = message(f.uin, 'group', [
                image(),
                voice(),
                video(`ftp://fixture.invalid/?token=${VIDEO_SECRET}`),
            ]);
            await f.emit(input, f.ticket());
            expect(imageIssue).not.toHaveBeenCalled();
            expect(voiceIssue).not.toHaveBeenCalled();
            expect(videoIssue).not.toHaveBeenCalled();
            expect(ws.messages).toEqual([]);
            expect(JSON.parse(f.legacy.frames[0]!)).toEqual(input);
            expect((await f.client.getLatestEvents()).data).toEqual([]);
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            ws.close();
        }
    });

    it('does not publish a partial event or provider error text when video issuance fails', async () => {
        const f = await account('10001');
        const ws = await connectSdkWs(f);
        const imageIssue = vi.spyOn(tokens.V12ImageFileTokens.prototype, 'issue');
        const voiceIssue = vi.spyOn(tokens.V12VoiceFileTokens.prototype, 'issue');
        const videoIssue = vi
            .spyOn(tokens.V12VideoFileTokens.prototype, 'issue')
            .mockImplementation(() => {
                throw new Error(`${THROW_SECRET} ${VIDEO_SECRET} ${VIDEO_URL} ${PRIVATE_FILE}`);
            });

        try {
            const input = message(f.uin, 'group', [image(), voice(), video()]);
            await f.emit(input, f.ticket());
            expect(imageIssue).toHaveBeenCalledOnce();
            expect(voiceIssue).toHaveBeenCalledOnce();
            expect(videoIssue).toHaveBeenCalledExactlyOnceWith(VIDEO_URL);
            expect(ws.messages).toEqual([]);
            expect(JSON.parse(f.legacy.frames[0]!)).toEqual(input);
            expect((await f.client.getLatestEvents()).data).toEqual([]);
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            ws.close();
        }
    });

    it.each([128, 129])('enforces the combined image/voice/video count at %i', async (count) => {
        const f = await account('10001');
        const ws = await connectSdkWs(f);
        const imageIssue = vi.spyOn(tokens.V12ImageFileTokens.prototype, 'issue');
        const voiceIssue = vi.spyOn(tokens.V12VoiceFileTokens.prototype, 'issue');
        const videoIssue = vi.spyOn(tokens.V12VideoFileTokens.prototype, 'issue');

        try {
            const segments = [
                image(),
                voice(),
                ...Array.from({ length: count - 2 }, () => video()),
            ];
            await f.emit(message(f.uin, 'private', segments), f.ticket());

            if (count === 128) {
                expect(imageIssue).toHaveBeenCalledTimes(1);
                expect(voiceIssue).toHaveBeenCalledTimes(1);
                expect(videoIssue).toHaveBeenCalledTimes(126);
                expect(ws.messages).toHaveLength(1);
                expect(ws.messages[0]!.message).toHaveLength(128);
                expect((await f.client.getLatestEvents()).data).toEqual([ws.messages[0]]);
            } else {
                expect(imageIssue).not.toHaveBeenCalled();
                expect(voiceIssue).not.toHaveBeenCalled();
                expect(videoIssue).not.toHaveBeenCalled();
                expect(ws.messages).toEqual([]);
            }

            expect(f.legacy.frames).toHaveLength(1);
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            ws.close();
        }
    });

    it.each([262144, 262145])(
        'enforces mixed URL budget at exactly %i UTF-8 bytes',
        async (total) => {
            const f = await account('10001');
            const ws = await connectSdkWs(f);
            const imageIssue = vi.spyOn(tokens.V12ImageFileTokens.prototype, 'issue');
            const voiceIssue = vi.spyOn(tokens.V12VoiceFileTokens.prototype, 'issue');
            const videoIssue = vi.spyOn(tokens.V12VideoFileTokens.prototype, 'issue');
            const base = 'https://media.example.invalid/🪶?synthetic=';
            const urlOfBytes = (bytes: number) =>
                base + 'x'.repeat(bytes - Buffer.byteLength(base, 'utf8'));
            const urls = [
                ...Array.from({ length: 87 }, () => urlOfBytes(3000)),
                urlOfBytes(total - 87 * 3000),
            ];
            expect(urls.reduce((sum, url) => sum + Buffer.byteLength(url, 'utf8'), 0)).toBe(total);
            expect(urls.reduce((sum, url) => sum + url.length, 0)).toBeLessThan(total);
            expect(urls.every((url) => Buffer.byteLength(url, 'utf8') <= 3000)).toBe(true);

            try {
                await f.emit(
                    message(f.uin, 'group', [
                        image(urls[0]),
                        voice(urls[1]),
                        ...urls.slice(2).map(video),
                    ]),
                    f.ticket(),
                );

                if (total === 262144) {
                    expect(imageIssue).toHaveBeenCalledTimes(1);
                    expect(voiceIssue).toHaveBeenCalledTimes(1);
                    expect(videoIssue).toHaveBeenCalledTimes(86);
                    expect(ws.messages).toHaveLength(1);
                    expect(
                        Buffer.byteLength(JSON.stringify(ws.messages[0]), 'utf8'),
                    ).toBeGreaterThan(64 * 1024);
                    expect((await getFile(f, fileId(ws.messages[0]!, 87, 'video'))).data).toEqual({
                        name: '',
                        url: urls[87],
                    });
                    // Production HTTP poll independently drops oversized events; WS
                    // delivery above is not retroactively undone by this queue limit.
                    expect(pollApi.pollOwnerStats(f.runtime)).toMatchObject({ too_large: 1 });
                } else {
                    expect(imageIssue).not.toHaveBeenCalled();
                    expect(voiceIssue).not.toHaveBeenCalled();
                    expect(videoIssue).not.toHaveBeenCalled();
                    expect(ws.messages).toEqual([]);
                }

                expect(f.api.handle).not.toHaveBeenCalled();
            } finally {
                ws.close();
            }
        },
    );

    it('rejects missing/old tickets, invalid shapes, getters, proxies and self-sent video', async () => {
        const f = await account('10001');
        const ws = await connectSdkWs(f);
        const getter = vi.fn(() => {
            throw new Error(THROW_SECRET);
        });
        const trap = vi.fn((): never => {
            throw new Error(THROW_SECRET);
        });

        try {
            const old = f.ticket()!;
            await f.manager.emitEvent(message(f.uin, 'private'));
            f.generation.setOnline(false);
            await f.emit(message(f.uin, 'private'), old);
            f.generation.setOnline(true);
            await f.emit(message(f.uin, 'private'), old);
            const invalid: JsonObject[] = [
                { type: 'video', data: { file: PRIVATE_FILE } },
                video(''),
                { type: 'video', data: { file: PRIVATE_FILE, url: VIDEO_URL, extra: true } },
                { ...video(), extra: true },
            ];

            for (const segment of invalid) {
                await f.emit(message(f.uin, 'group', [segment]), f.ticket());
            }

            const sent = message(f.uin, 'private');
            sent.post_type = 'message_sent';
            sent.user_id = Number(f.uin);
            sent.target_id = 20001;
            await f.emit(sent, f.ticket());
            const accessor = video();
            Object.defineProperty(accessor.data as JsonObject, 'url', {
                enumerable: true,
                get: getter,
            });
            const proxy = new Proxy(video(), {
                get: trap,
                ownKeys: trap,
                getOwnPropertyDescriptor: trap,
                getPrototypeOf: trap,
            });
            await f.rawInject(message(f.uin, 'private', [accessor]), f.ticket()!);
            await f.rawInject(message(f.uin, 'private', [proxy]), f.ticket()!);
            expect(getter).not.toHaveBeenCalled();
            expect(trap).not.toHaveBeenCalled();
            expect(ws.messages).toEqual([]);
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            ws.close();
        }
    });

    it('does not send video through the v11 action path', async () => {
        const f = await account('10001');
        const result = await f.client.request('send_message', {
            detail_type: 'private',
            user_id: '20001',
            message: [{ type: 'video', data: { file_id: `${PREFIX.video}synthetic` } }],
        });
        expect(result).toMatchObject({ status: 'failed', retcode: 10005, data: null });
        expect(f.api.handle).not.toHaveBeenCalled();
        expect(f.api.handleV12SensitiveMessage).not.toHaveBeenCalled();
    });

    it('never routes an actual video ID into data, path, fragments or video sending', async () => {
        const f = await account('10001');
        const ws = await connectSdkWs(f);

        try {
            await f.emit(message(f.uin, 'private'), f.ticket());
            const videoId = fileId(ws.messages[0]!, 0, 'video');
            const upload = await f.client.request('upload_file', {
                type: 'data',
                name: 'synthetic-upload.mp4',
                data: 'aGVsbG8=',
            });
            expect(upload).toMatchObject({ status: 'ok', retcode: 0 });
            const uploaded = upload.data;

            if (
                !uploaded ||
                typeof uploaded !== 'object' ||
                Array.isArray(uploaded) ||
                typeof uploaded.file_id !== 'string'
            ) {
                throw new Error('synthetic upload ID missing');
            }

            const uploadId = uploaded.file_id;
            expect(uploadId.startsWith('jiyu-upload:v1:')).toBe(true);
            const providers = (
                f.runtime as unknown as {
                    dispatcher: {
                        options: {
                            getUploadedDataFile: (...args: never[]) => unknown;
                            getUploadedDataFileMetadata: (...args: never[]) => unknown;
                            getUploadedDataFileChunk: (...args: never[]) => unknown;
                        };
                    };
                }
            ).dispatcher.options;
            const dataProvider = vi.spyOn(providers, 'getUploadedDataFile');
            const metadataProvider = vi.spyOn(providers, 'getUploadedDataFileMetadata');
            const chunkProvider = vi.spyOn(providers, 'getUploadedDataFileChunk');

            for (const type of ['data', 'path'] as const) {
                const response = await f.client.request('get_file', { file_id: videoId, type });
                expect(response).toMatchObject({ status: 'failed', retcode: 10004, data: null });
            }

            for (const params of [
                { stage: 'prepare', file_id: videoId },
                { stage: 'transfer', file_id: videoId, offset: 0, size: 1 },
            ]) {
                const response = await f.client.request('get_file_fragmented', params);
                expect(response).toMatchObject({ status: 'failed', retcode: 10004, data: null });
            }

            // A genuine upload capability is not a media URL capability.
            expect(await getFile(f, uploadId)).toMatchObject({
                status: 'failed',
                retcode: 10004,
                data: null,
            });
            const forgedVideoId = PREFIX.video + uploadId.slice('jiyu-upload:v1:'.length);
            expect(await getFile(f, forgedVideoId)).toMatchObject({
                status: 'failed',
                retcode: 20001,
                data: null,
            });
            expect((await getFile(f, videoId)).data).toEqual({ name: '', url: VIDEO_URL });
            const text = { type: 'text', data: { text: 'synthetic' } };
            const segment = (id: string) => ({ type: 'video', data: { file_id: id } });

            for (const params of [
                { detail_type: 'private', user_id: '20001', message: [segment(videoId)] },
                { detail_type: 'private', user_id: '20001', message: [text, segment(videoId)] },
                { detail_type: 'private', user_id: '20001', message: [segment(uploadId)] },
                {
                    detail_type: 'group',
                    group_id: '40001',
                    message: [segment(forgedVideoId), text],
                },
            ]) {
                const response = await f.client.request('send_message', params);
                expect(response).toMatchObject({ status: 'failed', retcode: 10005, data: null });
            }

            expect(dataProvider).not.toHaveBeenCalled();
            expect(metadataProvider).not.toHaveBeenCalled();
            expect(chunkProvider).not.toHaveBeenCalled();
            expect(f.api.handle).not.toHaveBeenCalled();
            expect(f.api.handleV12SensitiveMessage).not.toHaveBeenCalled();
        } finally {
            ws.close();
        }
    });

    // In-process reentrancy checks consistency, not a security boundary against
    // code in the same process. The original and replacement keys are revoked.
    it('drops a mixed event if video issuance replaces its earlier image issuer while the source stays current', async () => {
        const f = await account('10001');
        const ws = await connectSdkWs(f);
        const slot = f.runtime as unknown as ImageSlot;
        const original = new tokens.V12ImageFileTokens(f.uin);
        let replacement: V12ImageFileTokens | null = null;
        const realIssue = tokens.V12VideoFileTokens.prototype.issue;
        let swapped = false;

        try {
            replacement = new tokens.V12ImageFileTokens(f.uin);
            const next = replacement;
            expect(slot.imageFileTokens).toBeNull();
            slot.imageFileTokens = original;
            const videoIssue = vi
                .spyOn(tokens.V12VideoFileTokens.prototype, 'issue')
                .mockImplementation(function (
                    this: InstanceType<typeof tokens.V12VideoFileTokens>,
                    url: string,
                ) {
                    const id = realIssue.call(this, url);
                    slot.imageFileTokens = next;
                    swapped = true;
                    return id;
                });
            const imageIssue = vi.spyOn(tokens.V12ImageFileTokens.prototype, 'issue');
            const ticket = f.ticket()!;
            expect(f.runtime[sourceApi.verifySource](ticket)).toBe(true);
            await f.emit(message(f.uin, 'private', [image(), video()]), ticket);
            expect(swapped).toBe(true);
            expect(imageIssue).toHaveBeenCalledOnce();
            expect(videoIssue).toHaveBeenCalledOnce();
            expect(f.runtime[sourceApi.verifySource](ticket)).toBe(true);
            expect(ws.messages).toEqual([]);
            expect(f.legacy.frames).toHaveLength(1);
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            ws.close();
            slot.imageFileTokens = null;
            original.revoke();
            replacement?.revoke();
            f.runtime.quiesce();
        }
    });

    it('drops stale mixed media at the production completion-order poll enqueue fence', async () => {
        const f = await account('10001');
        const ws = await connectSdkWs(f);
        const slot = f.runtime as unknown as ImageSlot;
        const issuerA = new tokens.V12ImageFileTokens(f.uin);
        let issuerB: V12ImageFileTokens | null = null;
        const oldStackLimit = Error.stackTraceLimit;
        let ingressSpy: { mockRestore(): void } | undefined;

        try {
            issuerB = new tokens.V12ImageFileTokens(f.uin);
            const nextIssuer = issuerB;
            expect(slot.imageFileTokens).toBeNull();
            slot.imageFileTokens = issuerA;
            const source = f.ticket()!;
            const firstInput = message(f.uin, 'private', [
                { type: 'text', data: { text: 'queued-before' } },
            ]);
            firstInput.time = 1_699_999_999;
            await f.emit(firstInput, source);
            expect(ws.messages).toHaveLength(1);
            const beforeEvent = ws.messages[0]!;
            const before = pollApi.pollOwnerStats(f.runtime);
            expect(before).toMatchObject({
                active: true,
                accepted: 1,
                invalid: 0,
                ordering_gap: false,
            });

            if (!before) {
                throw new Error('expected production HTTP poll owner');
            }

            const pollBufferApi = await import('../../src/v12-runtime/event-poll-buffer');
            const queueEnqueue = vi.spyOn(pollBufferApi.EventPollBuffer.prototype, 'enqueue');
            const imageIssue = vi.spyOn(tokens.V12ImageFileTokens.prototype, 'issue');
            const videoIssue = vi.spyOn(tokens.V12VideoFileTokens.prototype, 'issue');
            const ingress = f.runtime as unknown as {
                enqueuePollWithDiagnostics: (...args: unknown[]) => unknown;
            };
            const realIngress = ingress.enqueuePollWithDiagnostics;
            let inIngress = false;
            let offered: unknown;
            let swapped = false;
            let enqueueStack = '';
            let sourceCurrentAtSwap = false;
            let managerCurrentAtSwap = false;
            let gateCurrentAtSwap = false;
            let issuedBeforeSwap = false;
            Error.stackTraceLimit = 50;
            ingressSpy = vi
                .spyOn(ingress, 'enqueuePollWithDiagnostics')
                .mockImplementation(function (this: typeof ingress, ...args: unknown[]) {
                    inIngress = true;
                    offered = args[0];

                    try {
                        return Reflect.apply(realIngress, this, args);
                    } finally {
                        inIngress = false;
                    }
                });

            // This hook is the real poll host's isSourceCurrent verifier. The
            // stack marker proves enqueuePollEvent was entered; unlike a call
            // count it does not depend on how many earlier checks ran. It is
            // used only to place the synthetic same-process reentrancy.
            f.verification.before = () => {
                if (!inIngress || swapped) {
                    return;
                }

                const stack = new Error('synthetic enqueue phase').stack ?? '';

                if (!/\benqueuePollEvent\b/.test(stack)) {
                    return;
                }

                enqueueStack = stack;
                sourceCurrentAtSwap = f.generation.isCurrent(
                    source,
                    f.runtime[sourceApi.captureBinding](),
                );
                managerCurrentAtSwap = f.manager.get(identityApi.V12_ADAPTER_NAME) === f.runtime;
                const gate = pollApi.pollOwnerStats(f.runtime);
                gateCurrentAtSwap =
                    gate?.active === true &&
                    !gate.cleanup_pending &&
                    !gate.cleanup_uncertain &&
                    !gate.ordering_gap;
                issuedBeforeSwap =
                    imageIssue.mock.calls.length === 1 && videoIssue.mock.calls.length === 1;
                slot.imageFileTokens = nextIssuer;
                swapped = true;
            };

            const rejectedInput = message(f.uin, 'group', [image(), video()]);
            await f.emit(rejectedInput, source);
            f.verification.before = undefined;
            expect(swapped).toBe(true);
            expect(enqueueStack).toMatch(/\benqueuePollEvent\b/);
            expect([
                sourceCurrentAtSwap,
                managerCurrentAtSwap,
                gateCurrentAtSwap,
                issuedBeforeSwap,
            ]).toEqual([true, true, true, true]);
            expect(imageIssue).toHaveBeenCalledOnce();
            expect(videoIssue).toHaveBeenCalledOnce();
            expect(slot.imageFileTokens).toBe(nextIssuer);
            expect(f.runtime[sourceApi.verifySource](source)).toBe(true);
            expect(ws.messages).toHaveLength(1);
            expect(queueEnqueue).not.toHaveBeenCalled();
            const lostEvent = offered as OneBot12Event;
            const staleImageId = fileId(lostEvent, 0, 'image');
            expect(issuerA.redeem(staleImageId)).toBe(IMAGE_URL);
            expect(nextIssuer.redeem(staleImageId)).toBeNull();
            expect(pollApi.pollOwnerStats(f.runtime)).toMatchObject({
                active: true,
                accepted: before.accepted,
                invalid: before.invalid + 1,
                ordering_gap: false,
                cleanup_uncertain: false,
            });
            expect(logs.map((entry) => entry.message)).toContain(
                'v12 http poll event invalid; event dropped',
            );
            ingressSpy.mockRestore();
            ingressSpy = undefined;

            // A later valid mixed message uses B and the same source. Both it
            // and the already queued control survive; the stale A event does not.
            const nextInput = message(f.uin, 'group', [image(), video()]);
            nextInput.time = 1_700_000_001;
            await f.emit(nextInput, source);
            expect(ws.messages).toHaveLength(2);
            expect(queueEnqueue).toHaveBeenCalledOnce();
            const nextEvent = ws.messages[1]!;
            expect(nextIssuer.redeem(fileId(nextEvent, 0, 'image'))).toBe(IMAGE_URL);
            expect((await f.client.getLatestEvents()).data).toEqual([beforeEvent, nextEvent]);
            expect(f.legacy.frames.map((frame) => JSON.parse(frame))).toEqual([
                firstInput,
                rejectedInput,
                nextInput,
            ]);
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            f.verification.before = undefined;
            ingressSpy?.mockRestore();
            Error.stackTraceLimit = oldStackLimit;
            ws.close();
            slot.imageFileTokens = null;
            issuerA.revoke();
            issuerB?.revoke();
            f.runtime.quiesce();
        }
    });

    it('stops later subscribers if the first replaces the image issuer of a mixed video event', async () => {
        const f = await account('10001');
        const slot = f.runtime as unknown as ImageSlot;
        const original = new tokens.V12ImageFileTokens(f.uin);
        let replacement: V12ImageFileTokens | null = null;
        const first: unknown[] = [];
        let unsubscribe: (() => void) | undefined;
        let ws: Awaited<ReturnType<typeof connectSdkWs>> | undefined;

        try {
            replacement = new tokens.V12ImageFileTokens(f.uin);
            expect(slot.imageFileTokens).toBeNull();
            slot.imageFileTokens = original;
            // Register this fake sink before the injected SDK WebSocket sink.
            unsubscribe = f.current().options.subscribe((event) => {
                if (
                    event &&
                    typeof event === 'object' &&
                    (event as { type?: unknown }).type === 'message'
                ) {
                    first.push(event);
                    slot.imageFileTokens = replacement;
                }
            });
            ws = await connectSdkWs(f);
            const source = f.ticket()!;
            expect(f.runtime[sourceApi.verifySource](source)).toBe(true);
            await f.emit(message(f.uin, 'group', [image(), video()]), source);
            expect(first).toHaveLength(1); // This delivery cannot be retracted.
            expect(ws.messages).toEqual([]);
            expect(f.runtime[sourceApi.verifySource](source)).toBe(true);
            expect(slot.imageFileTokens).toBe(replacement);
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            unsubscribe?.();
            ws?.close();
            slot.imageFileTokens = null;
            original.revoke();
            replacement?.revoke();
            f.runtime.quiesce();
        }
    });

    it('rejects video issuance when its source epoch changes synchronously', async () => {
        const f = await account('10001');
        const ws = await connectSdkWs(f);
        const realIssue = tokens.V12VideoFileTokens.prototype.issue;
        let issued = false;
        vi.spyOn(tokens.V12VideoFileTokens.prototype, 'issue').mockImplementation(function (
            this: InstanceType<typeof tokens.V12VideoFileTokens>,
            url: string,
        ) {
            const id = realIssue.call(this, url);
            issued = true;
            f.generation.setOnline(false);
            f.generation.setOnline(true);
            return id;
        });

        try {
            await f.emit(message(f.uin, 'group'), f.ticket());
            expect(issued).toBe(true);
            expect(ws.messages).toEqual([]);
            expect(f.legacy.frames).toHaveLength(1);
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            ws.close();
        }
    });
});
