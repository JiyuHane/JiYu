import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { V12TransportOptions } from '../../src/v12-network';
import type { ApiResponse, JsonObject } from '../../src/types';
import type { V12Runtime } from '../../src/v12-runtime/runtime';
import type { V12Source } from '../../src/v12-runtime/source-generation';
import type { V11ActionHandler } from '../../src/v12/types';
import type { V12UploadedDataStore } from '../../src/v12/uploaded-data-store';

type MemoryTransport = {
    attach(): void;
    close(): Promise<void>;
    quiesce(): void;
    forceClose(): void;
    isAcceptingActions(): boolean;
    handleRequest(req: IncomingMessage, res: ServerResponse): void;
};

type FakeTransport = {
    options: V12TransportOptions;
    open: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    quiesce: ReturnType<typeof vi.fn>;
    forceClose: ReturnType<typeof vi.fn>;
    isAcceptingActions: Mock<() => boolean>;
    backing?: MemoryTransport;
};

// open() is an in-memory no-op. Saved options.handle intentionally bypasses
// transport admission so a retired listener callback can be exercised directly.
const fixture = vi.hoisted(() => ({
    transports: [] as FakeTransport[],
    forbiddenModules: [] as string[],
    construct: null as null | ((transport: FakeTransport) => void),
    openGate: null as null | ((transport: FakeTransport) => Promise<void>),
    createBacking: null as null | ((options: V12TransportOptions) => MemoryTransport),
}));

vi.mock('../../src/v12-network', () => ({
    V12Transport: class {
        private accepting = false;
        readonly backing?: MemoryTransport;
        readonly open = vi.fn(async () => {
            const gate = fixture.openGate;

            if (gate) {
                await gate(this);
            }

            this.backing?.attach();
            this.accepting = true;
        });
        readonly close = vi.fn(async () => {
            this.accepting = false;
            await this.backing?.close();
        });
        readonly quiesce = vi.fn(() => {
            this.accepting = false;
            this.backing?.quiesce();
        });
        readonly forceClose = vi.fn(() => {
            this.accepting = false;
            this.backing?.forceClose();
        });
        readonly isAcceptingActions = vi.fn(() =>
            this.backing ? this.backing.isAcceptingActions() : this.accepting,
        );

        constructor(readonly options: V12TransportOptions) {
            this.backing = fixture.createBacking?.(options);
            fixture.transports.push(this);
            fixture.construct?.(this);
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
    // attach() on the separately inspected transport uses this inert noServer
    // fixture; it creates no server, socket, listener or outbound connection.
    WebSocketServer: class {
        constructor(options: { noServer?: boolean }) {
            if (options?.noServer !== true) {
                fixture.forbiddenModules.push('websocket-server');
                throw new Error('unexpected WebSocket server');
            }
        }
        destroy() {}
    },
}));
vi.mock('@snowluma/sqlite', () => ({
    SqliteDatabase: class {
        constructor() {
            fixture.forbiddenModules.push('sqlite');
            throw new Error('unexpected SQLite');
        }
    },
}));

const PREFIX = 'jiyu-upload:v1:';
const ENDPOINT = 'http://fixture.invalid/';
const TOKEN = 'synthetic-same-token';
const NAME = '霁羽-🪶.bin';
const BYTES = Buffer.from([0, 255, 128, 1, 2, 3, 10, 13, 47, 92, 127]);
const DATA = BYTES.toString('base64');
const SHA256 = createHash('sha256').update(BYTES).digest('hex');
const LEGACY_URL = 'HTTPS://example.invalid:443/a/../b?sig=%2f%2F+#frag';
const OLD_SECRET = 'SYNTHETIC_OLD_GENERATION_PAYLOAD_X734';
const activeRuntimes: V12Runtime[] = [];

let sdkApi: typeof import('../../../sdk/src/v12/http-client.js');
let runtimeApi: typeof import('../../src/v12-runtime/runtime');
let identityApi: typeof import('../../src/v12-runtime/identity');
let sourceApi: typeof import('../../src/v12-runtime/source-generation');
let managerApi: typeof import('../../src/network/network-manager');
let dispatcherApi: typeof import('../../src/v12/dispatcher');
let storeApi: typeof import('../../src/v12/uploaded-data-store');
let tokenApi: typeof import('../../src/v12/image-file-token');
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let guards: Array<{ mock: { calls: unknown[] } }>;

function blocked(): never {
    throw new Error('unexpected network or native operation in upload fixture');
}

beforeEach(async () => {
    fixture.transports.length = 0;
    fixture.forbiddenModules.length = 0;
    fixture.construct = null;
    fixture.openGate = null;
    fixture.createBacking = null;
    vi.stubEnv('SNOWLUMA_LOG_FILE', '0');
    fetchGuard = vi.fn(blocked);
    webSocketGuard = vi.fn(function ForbiddenWebSocket() {
        return blocked();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    guards = [
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
        vi.spyOn(process, 'dlopen').mockImplementation(blocked),
    ];

    // Import runtime and SDK only after all native/network guards are active.
    sdkApi = await import('../../../sdk/src/v12/http-client.js');
    sourceApi = await import('../../src/v12-runtime/source-generation');
    managerApi = await import('../../src/network/network-manager');
    identityApi = await import('../../src/v12-runtime/identity');
    dispatcherApi = await import('../../src/v12/dispatcher');
    storeApi = await import('../../src/v12/uploaded-data-store');
    tokenApi = await import('../../src/v12/image-file-token');
    runtimeApi = await import('../../src/v12-runtime/runtime');
});

afterEach(async () => {
    try {
        for (const runtime of activeRuntimes.splice(0)) {
            await runtime.close();
        }
    } finally {
        const calls = guards.map((guard) => guard.mock.calls.length);
        const fetchCalls = fetchGuard.mock.calls.length;
        const webSocketCalls = webSocketGuard.mock.calls.length;
        const modules = [...fixture.forbiddenModules];
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        expect(fetchCalls).toBe(0);
        expect(webSocketCalls).toBe(0);
        expect(calls).toEqual(calls.map(() => 0));
        expect(modules).toEqual([]);
    }
});

async function account(
    uin: string,
    overrides: {
        trackAction?: <T>(label: string, start: () => Promise<T>) => Promise<T>;
        canAccept?: () => boolean;
        open?: boolean;
        handleV12SensitiveMessage?: V11ActionHandler['handleV12SensitiveMessage'];
        getSentMessageTime?: (id: number) => Promise<number | null>;
    } = {},
) {
    const generation = new sourceApi.SourceGeneration();
    const manager = new managerApi.OneBotNetworkManager();
    const api = {
        // Every alias exists in this synthetic V11 cache, including collisions.
        handle: vi.fn(async (action: string, _params: JsonObject) => {
            if (action !== 'get_file') {
                throw new Error('unexpected synthetic v11 action');
            }

            return {
                status: 'ok' as const,
                retcode: 0,
                data: { file_name: 'legacy.bin', url: LEGACY_URL },
            };
        }),
        ...(overrides.handleV12SensitiveMessage === undefined
            ? {}
            : { handleV12SensitiveMessage: overrides.handleV12SensitiveMessage }),
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
        {
            uin,
            api: api as never,
            buildLifecycleEvent: () => ({}),
            buildHeartbeatEvent: () => ({}),
        },
        {
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: overrides.getSentMessageTime ?? (async () => null),
            trackAction:
                overrides.trackAction ?? (<T>(_label: string, start: () => Promise<T>) => start()),
            canAccept: overrides.canAccept ?? (() => true),
            captureCurrentSource: () => generation.capture(runtime[sourceApi.captureBinding]()),
            isSourceCurrent: (source: V12Source | undefined, binding: object | null) =>
                manager.get(identityApi.V12_ADAPTER_NAME) === runtime &&
                generation.isCurrent(source, binding),
        },
    );
    activeRuntimes.push(runtime);
    manager.register(runtime);
    generation.setOnline(true);
    const events: unknown[] = [];
    let current!: FakeTransport;

    const captureTransport = () => {
        const candidate = fixture.transports.at(-1);

        if (!candidate) {
            throw new Error('fake transport unavailable');
        }

        current = candidate;
        current.options.subscribe((event) => events.push(event));
    };

    const open = async () => {
        await runtime.open();
        captureTransport();
    };

    if (overrides.open !== false) {
        await open();
    }

    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe(ENDPOINT);
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('error');
        expect(typeof init?.body).toBe('string');
        const response = await current.options.handle(JSON.parse(init!.body as string));
        return new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    });
    const client = new sdkApi.OneBot12HttpClient({
        baseUrl: ENDPOINT,
        fetch: fakeFetch,
        requestTimeoutMs: 0,
    });
    return {
        uin,
        runtime,
        api,
        manager,
        generation,
        events,
        client,
        fakeFetch,
        open,
        captureTransport,
        transport: () => current,
    };
}

type Account = Awaited<ReturnType<typeof account>>;

async function upload(f: Account, name = NAME, data = DATA, sha256?: string) {
    return f.client.request(
        'upload_file',
        { type: 'data', name, data, ...(sha256 === undefined ? {} : { sha256 }) },
        { self: { platform: 'qq', user_id: f.uin }, echo: 'upload-echo' },
    );
}

async function getData(f: Account, fileId: string) {
    return f.client.request(
        'get_file',
        { file_id: fileId, type: 'data' },
        { self: { platform: 'qq', user_id: f.uin }, echo: 'get-echo' },
    );
}

function uploadedId(result: Awaited<ReturnType<typeof upload>>): string {
    expect(result).toMatchObject({ status: 'ok', retcode: 0 });
    const data = result.data;

    if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        typeof data.file_id !== 'string'
    ) {
        throw new Error('synthetic upload ID missing');
    }

    expect(data.file_id).toMatch(/^jiyu-upload:v1:[A-Za-z0-9_-]{43}$/);
    const suffix = data.file_id.slice(PREFIX.length);
    expect(Buffer.from(suffix, 'base64url').length).toBe(32);
    expect(Buffer.from(suffix, 'base64url').toString('base64url')).toBe(suffix);
    return data.file_id;
}

function failed(result: { status: string; retcode: number; data: unknown }) {
    expect(result.status).toBe('failed');
    expect(result.retcode).not.toBe(0);
    expect(result.data).toBeNull();
}

// These EventEmitters are in-memory test doubles, not node sockets or servers.
class FakeWirePeer extends EventEmitter {
    readonly frames: string[] = [];
    readonly callbacks: Array<(error?: Error) => void> = [];
    terminated = false;

    send(text: string, callback: (error?: Error) => void): void {
        this.frames.push(text);
        this.callbacks.push(callback);
    }

    acknowledge(): void {
        this.callbacks.shift()?.();
    }

    terminate(): void {
        this.terminated = true;
        this.emit('close');
    }
}

class FakeRequest extends EventEmitter {
    url = '/';
    method = 'POST';
    headers: Record<string, string> = { 'content-type': 'application/json' };
    rawHeaders: string[] = [];
    pause(): void {}
}

class FakeResponse extends EventEmitter {
    destroyed = false;
    writableEnded = false;
    status = 0;
    body: string | undefined;

    setHeader(): void {}
    writeHead(status: number): this {
        this.status = status;
        return this;
    }
    end(body: string): this {
        this.body = body;
        this.writableEnded = true;
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
}

async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 30; i++) {
        await Promise.resolve();
    }
}

async function emitMedia(f: Account): Promise<[string, string]> {
    const event: JsonObject = {
        post_type: 'message',
        self_id: Number(f.uin),
        user_id: 20001,
        message_type: 'private',
        sub_type: 'friend',
        message_id: -123,
        time: 1_700_000_000,
        raw_message: 'synthetic message',
        message: [
            {
                type: 'image',
                data: {
                    file: 'synthetic-image',
                    url: 'https://media.example.invalid/image',
                    sub_type: 0,
                    summary: '[图片]',
                },
            },
            {
                type: 'record',
                data: { file: 'synthetic-voice', url: 'https://media.example.invalid/voice' },
            },
        ],
    };
    const ticket = f.generation.capture(f.runtime[sourceApi.captureBinding]());
    expect(ticket).toBeDefined();
    await f.manager.emitEvent(event, ticket);
    const message = f.events.find(
        (value) =>
            value !== null &&
            typeof value === 'object' &&
            (value as { type?: unknown }).type === 'message',
    ) as { message?: Array<{ type?: string; data?: { file_id?: string } }> } | undefined;
    const image = message?.message?.[0];
    const voice = message?.message?.[1];
    expect(image?.type).toBe('image');
    expect(voice?.type).toBe('voice');

    if (typeof image?.data?.file_id !== 'string' || typeof voice?.data?.file_id !== 'string') {
        throw new Error('synthetic media IDs missing');
    }

    return [image.data.file_id, voice.data.file_id];
}

describe('v12 uploaded data through SDK and fake listener', () => {
    it('advertises the capability only on a runtime that supplies it', async () => {
        const api = {
            handle: vi.fn(async () => ({ status: 'ok' as const, retcode: 0, data: null })),
        };
        const ordinary = new dispatcherApi.V12Dispatcher({
            self: { platform: 'qq', user_id: '10001' },
            version: { impl: 'fixture', version: '1' },
            api,
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
        });
        const coreActions = await ordinary.handle({ action: 'get_supported_actions', params: {} });
        expect(coreActions.retcode).toBe(0);
        expect(coreActions.data).not.toContain('upload_file');
        expect(api.handle).not.toHaveBeenCalled();

        const f = await account('10001');
        const runtimeActions = await f.client.request('get_supported_actions');
        expect(runtimeActions.retcode).toBe(0);
        expect(Array.isArray(runtimeActions.data)).toBe(true);
        expect(
            (runtimeActions.data as unknown[]).filter((item) => item === 'upload_file'),
        ).toHaveLength(1);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('round-trips exact bytes, UTF-8 name and SHA-256 using generic SDK fake fetch', async () => {
        const f = await account('10001');
        const result = await upload(f);
        const id = uploadedId(result);
        expect(result.echo).toBe('upload-echo');
        expect(await getData(f, id)).toMatchObject({
            status: 'ok',
            retcode: 0,
            data: { name: NAME, data: DATA, sha256: SHA256 },
            echo: 'get-echo',
        });
        expect(f.fakeFetch).toHaveBeenCalledTimes(2);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('accepts matching SHA and empty data, rejects malformed data, SHA and parameters', async () => {
        const f = await account('10001');
        const id = uploadedId(await upload(f, NAME, DATA, SHA256));
        expect((await getData(f, id)).data).toEqual({ name: NAME, data: DATA, sha256: SHA256 });
        const emptyId = uploadedId(await upload(f, '', ''));
        expect((await getData(f, emptyId)).data).toEqual({
            name: '',
            data: '',
            sha256: createHash('sha256').update('').digest('hex'),
        });

        const cases: Array<[unknown, number]> = [
            [{ type: 'data', name: NAME, data: DATA, sha256: '0'.repeat(64) }, 10003],
            [{ type: 'data', name: NAME, data: DATA, sha256: SHA256.toUpperCase() }, 10003],
            [{ type: 'data', name: NAME, data: DATA, sha256: '' }, 10003],
            [{ type: 'data', name: NAME, data: DATA, sha256: 12 }, 10003],
            [{ type: 'data', name: NAME, data: 'AB==' }, 10003],
            [{ type: 'data', name: NAME, data: 'AA' }, 10003],
            [{ type: 'data', name: NAME, data: '-_==' }, 10003],
            [{ type: 'data', data: DATA }, 10003],
            [{ type: 'data', name: NAME }, 10003],
            [{ type: 'data', name: 1, data: DATA }, 10003],
            [{ type: 'data', name: NAME, data: [1] }, 10003],
            [{ type: 'data', name: NAME, data: DATA, extra: true }, 10004],
        ];

        for (const [params, retcode] of cases) {
            const result = await f.transport().options.handle({ action: 'upload_file', params });
            expect(result).toMatchObject({ status: 'failed', retcode, data: null });
        }

        expect((await getData(f, id)).data).toEqual({ name: NAME, data: DATA, sha256: SHA256 });
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('rejects unsupported upload modes and fragmented actions; keeps the old URL path', async () => {
        const f = await account('10001');

        for (const params of [
            { type: 'url', name: NAME, url: 'https://example.invalid/file' },
            { type: 'path', name: NAME, path: '/synthetic/file' },
            { type: 'fragment', name: NAME, data: DATA },
        ]) {
            failed(await f.transport().options.handle({ action: 'upload_file', params }));
        }

        failed(
            await f.transport().options.handle({
                action: 'upload_file_fragment',
                params: { stage: 'prepare', name: NAME, total_size: BYTES.length },
            }),
        );
        const result = await f.client.request('get_file', { file_id: 'legacy-id', type: 'url' });
        expect(result).toMatchObject({
            status: 'ok',
            retcode: 0,
            data: { name: 'legacy.bin', url: LEGACY_URL },
        });
        expect(f.api.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: 'legacy-id' });
    });

    it('isolates two accounts, two same-account runtimes, forged IDs and explicit self', async () => {
        const a = await account('10001');
        const b = await account('10002');
        const otherA = await account('10001');
        const id = uploadedId(await upload(a));
        const bId = uploadedId(await upload(b, 'other', Buffer.from('B').toString('base64')));
        expect(bId).not.toBe(id);
        expect((await getData(a, id)).data).toEqual({ name: NAME, data: DATA, sha256: SHA256 });

        for (const other of [b, otherA]) {
            failed(await getData(other, id));
            expect(other.api.handle).not.toHaveBeenCalled();
        }

        const altered =
            id.slice(0, PREFIX.length) +
            (id[PREFIX.length] === 'A' ? 'B' : 'A') +
            id.slice(PREFIX.length + 1);

        for (const forged of [
            PREFIX,
            `${PREFIX}legacy`,
            `${PREFIX}%%%`,
            altered,
            `${PREFIX}${'A'.repeat(43)}`,
        ]) {
            failed(await getData(a, forged));
        }

        const wrongSelf = await a.client.request(
            'get_file',
            { file_id: id, type: 'data' },
            { self: { platform: 'qq', user_id: b.uin } },
        );
        expect(wrongSelf).toMatchObject({ status: 'failed', retcode: 10102, data: null });
        expect(a.api.handle).not.toHaveBeenCalled();
        expect(b.api.handle).not.toHaveBeenCalled();
    });

    it('reserves upload prefixes in v12 only, including malformed and URL-mode IDs', async () => {
        const f = await account('10001');
        const collision = `${PREFIX}legacy-alias`;
        const direct = await f.api.handle('get_file', { file_id: collision });
        expect(direct).toMatchObject({ status: 'ok', retcode: 0, data: { url: LEGACY_URL } });
        f.api.handle.mockClear();
        const id = uploadedId(await upload(f));

        for (const candidate of [PREFIX, collision, `${PREFIX}%%%`, id]) {
            failed(await f.client.request('get_file', { file_id: candidate, type: 'url' }));
        }

        for (const candidate of [PREFIX, collision, `${PREFIX}%%%`]) {
            failed(await getData(f, candidate));
        }

        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('never decrypts image/voice IDs or consults v11 for data mode', async () => {
        const f = await account('10001');
        const [image, voice] = await emitMedia(f);
        const imageRedeem = vi.spyOn(tokenApi.V12ImageFileTokens.prototype, 'redeem');
        const voiceRedeem = vi.spyOn(tokenApi.V12VoiceFileTokens.prototype, 'redeem');

        for (const id of [image, voice, 'legacy-id', `${PREFIX}missing`]) {
            failed(await getData(f, id));
        }

        expect(imageRedeem).not.toHaveBeenCalled();
        expect(voiceRedeem).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
        expect((await f.client.request('get_file', { file_id: image, type: 'url' })).retcode).toBe(
            0,
        );
        expect((await f.client.request('get_file', { file_id: voice, type: 'url' })).retcode).toBe(
            0,
        );
    });

    it('sends an uploaded single image through the runtime and retires its listener lease', async () => {
        const messageId = -2147483648;
        const time = 1_700_000_000;
        const echo = 'synthetic-image-send-echo-🪶';

        const makeSensitive = () => {
            const startCheck = vi.fn((canStart: () => boolean) => canStart());
            const submitted = vi.fn(
                (
                    _action: 'send_private_msg' | 'send_group_msg',
                    _params: JsonObject,
                ): ApiResponse => ({
                    status: 'ok',
                    retcode: 0,
                    data: { message_id: messageId },
                }),
            );
            const method = vi.fn<NonNullable<V11ActionHandler['handleV12SensitiveMessage']>>(
                async (action, params, canStart) => {
                    if (canStart === undefined || !startCheck(canStart)) {
                        return { status: 'failed', retcode: 100, data: null };
                    }

                    return submitted(action, params);
                },
            );
            const getSentMessageTime = vi.fn(async (_id: number): Promise<number | null> => time);
            return { startCheck, submitted, method, getSentMessageTime };
        };

        const imageParams = (fileId: string) => ({
            detail_type: 'private',
            user_id: '20001',
            message: [{ type: 'image', data: { file_id: fileId } }],
        });
        const expectedV11 = (data: string) => ({
            user_id: 20001,
            message: [{ type: 'image', data: { file: `base64://${data}` } }],
            auto_escape: false,
        });
        const first = makeSensitive();
        // Both capabilities must be present before the runtime constructs its dispatcher.
        const a = await account('10001', {
            handleV12SensitiveMessage: first.method,
            getSentMessageTime: first.getSentMessageTime,
        });
        const selfA = { platform: 'qq', user_id: a.uin };
        const savedHandler = a.transport().options.handle;
        expect(BYTES.length).toBeGreaterThan(0);
        const id = uploadedId(await upload(a));
        const sent = await a.client.request('send_message', imageParams(id), { self: selfA, echo });
        expect(sent).toEqual({
            status: 'ok',
            retcode: 0,
            data: { message_id: String(messageId), time },
            message: '',
            echo,
        });
        expect(a.fakeFetch).toHaveBeenCalledTimes(2);
        expect(JSON.parse(a.fakeFetch.mock.calls[1]![1]!.body as string)).toEqual({
            action: 'send_message',
            params: imageParams(id),
            self: selfA,
            echo,
        });
        expect(first.method).toHaveBeenCalledExactlyOnceWith(
            'send_private_msg',
            expectedV11(DATA),
            expect.any(Function),
        );
        expect(first.method.mock.contexts[0]).toBe(a.api);
        expect(first.startCheck).toHaveBeenCalledExactlyOnceWith(first.method.mock.calls[0]![2]);
        expect(first.startCheck).toHaveReturnedWith(true);
        expect(first.submitted).toHaveBeenCalledExactlyOnceWith(
            'send_private_msg',
            expectedV11(DATA),
        );
        expect(first.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(messageId);
        expect(a.api.handle).not.toHaveBeenCalled();
        expect((await getData(a, id)).data).toEqual({ name: NAME, data: DATA, sha256: SHA256 });

        // The foreign account has the same capabilities, but not A's store.
        const second = makeSensitive();
        const b = await account('10002', {
            handleV12SensitiveMessage: second.method,
            getSentMessageTime: second.getSentMessageTime,
        });
        const selfB = { platform: 'qq', user_id: b.uin };
        const foreign = await b.client.request('send_message', imageParams(id), {
            self: selfB,
            echo: 'foreign-echo',
        });
        expect(foreign).toMatchObject({
            status: 'failed',
            retcode: 20002,
            data: null,
            echo: 'foreign-echo',
        });
        expect(second.method).not.toHaveBeenCalled();
        expect(second.startCheck).not.toHaveBeenCalled();
        expect(second.submitted).not.toHaveBeenCalled();
        expect(second.getSentMessageTime).not.toHaveBeenCalled();
        const otherData = Buffer.from('synthetic-other-image').toString('base64');
        const otherId = uploadedId(await upload(b, 'other-image.bin', otherData));
        expect(otherId).not.toBe(id);
        expect(
            await b.client.request('send_message', imageParams(otherId), { self: selfB, echo }),
        ).toEqual({
            status: 'ok',
            retcode: 0,
            data: { message_id: String(messageId), time },
            message: '',
            echo,
        });
        expect(second.method).toHaveBeenCalledExactlyOnceWith(
            'send_private_msg',
            expectedV11(otherData),
            expect.any(Function),
        );
        expect(second.startCheck).toHaveBeenCalledExactlyOnceWith(second.method.mock.calls[0]![2]);
        expect(second.startCheck).toHaveReturnedWith(true);
        expect(second.submitted).toHaveBeenCalledExactlyOnceWith(
            'send_private_msg',
            expectedV11(otherData),
        );
        expect(second.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(messageId);
        expect(b.api.handle).not.toHaveBeenCalled();

        await a.runtime.close();
        await a.open();
        const staleId = await a.client.request('send_message', imageParams(id), {
            self: selfA,
            echo,
        });
        expect(staleId).toMatchObject({ status: 'failed', retcode: 20002, data: null, echo });
        const staleRequest = { action: 'send_message', params: imageParams(id), self: selfA, echo };
        expect(await savedHandler(staleRequest)).toMatchObject({
            status: 'failed',
            retcode: 20002,
            data: null,
            echo,
        });
        const freshId = uploadedId(await upload(a, 'new-generation'));
        expect(freshId).not.toBe(id);
        expect(await savedHandler({ ...staleRequest, params: imageParams(freshId) })).toMatchObject(
            {
                status: 'failed',
                retcode: 20002,
                data: null,
                echo,
            },
        );
        expect((await getData(a, freshId)).data).toEqual({
            name: 'new-generation',
            data: DATA,
            sha256: SHA256,
        });
        expect(first.method).toHaveBeenCalledTimes(1);
        expect(first.startCheck).toHaveBeenCalledTimes(1);
        expect(first.submitted).toHaveBeenCalledTimes(1);
        expect(first.getSentMessageTime).toHaveBeenCalledTimes(1);
        expect(a.api.handle).not.toHaveBeenCalled();
    });

    it('never forwards uploaded file, image or voice segments to v11', async () => {
        const f = await account('10001');
        const id = uploadedId(await upload(f));

        for (const type of ['file', 'image', 'voice']) {
            const result = await f.client.request('send_message', {
                detail_type: 'private',
                user_id: '20001',
                message: [{ type, data: { file_id: id } }],
            });
            expect(result).toMatchObject({
                status: 'failed',
                retcode: type === 'image' ? 20002 : 10005,
                data: null,
            });
        }

        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('handles a full-size payload through the fake boundary without claiming queue coverage', async () => {
        const f = await account('10001');
        const bytes = Buffer.alloc(256 * 1024, 0x61);
        bytes[0] = 0;
        bytes[bytes.length - 1] = 255;
        const encoded = bytes.toString('base64');
        const digest = createHash('sha256').update(bytes).digest('hex');
        const id = uploadedId(await upload(f, 'large.bin', encoded, digest));
        expect((await getData(f, id)).data).toEqual({
            name: 'large.bin',
            data: encoded,
            sha256: digest,
        });

        // Direct callback only: even a failure retaining this echo is larger than
        // the real transport's default 1 MiB limit. This fake does not serialize
        // with that limit, test a queue, or prove how a real connection closes.
        const echo = 'E'.repeat(1_048_576);
        const direct = await f.transport().options.handle({
            action: 'get_file',
            params: { type: 'data', file_id: id },
            echo,
        });
        failed(direct);
        expect(direct.echo === echo).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(direct))).toBeGreaterThan(1024 * 1024);
        expect((await getData(f, id)).retcode).toBe(0);
        expect(f.api.handle).not.toHaveBeenCalled();
    });
});

describe('v12 file success envelope UTF-8 byte boundaries', () => {
    const limit = 1024 * 1024 - 14;
    const fileId = PREFIX + 'A'.repeat(43);
    // Includes multibyte UTF-8, JSON escaping and a lone surrogate.
    const specialEcho = '中文🪶\\\n\t\u0000"\ud800';

    function boundaryEcho(data: JsonObject): string {
        const envelope = { status: 'ok', retcode: 0, data, message: '', echo: specialEcho };
        const base = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
        expect(base).toBeLessThan(limit);
        const echo = specialEcho + 'x'.repeat(limit - base);
        expect(echo.length + 1).toBeLessThanOrEqual(1024 * 1024);
        expect(Buffer.byteLength(JSON.stringify({ ...envelope, echo }), 'utf8')).toBe(limit);
        expect(Buffer.byteLength(JSON.stringify({ ...envelope, echo: `${echo}x` }), 'utf8')).toBe(
            limit + 1,
        );
        return echo;
    }

    it('accepts the exact upload success budget and rejects +1 before the provider', async () => {
        const api = {
            handle: vi.fn(async () => ({ status: 'ok' as const, retcode: 0, data: null })),
        };
        const uploadProvider = vi.fn(() => ({ kind: 'ok' as const, fileId }));
        const downloadProvider = vi.fn(() => ({ kind: 'unavailable' as const }));
        const core = new dispatcherApi.V12Dispatcher({
            self: { platform: 'qq', user_id: '10001' },
            version: { impl: 'fixture', version: '1' },
            api,
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
            uploadDataFile: uploadProvider,
            getUploadedDataFile: downloadProvider,
        });
        const params = { type: 'data', name: NAME, data: DATA, sha256: SHA256 };
        const echo = boundaryEcho({ file_id: fileId });
        const exact = await core.handle({ action: 'upload_file', params, echo });
        expect(exact).toMatchObject({ status: 'ok', retcode: 0, data: { file_id: fileId } });
        expect(exact.echo === echo).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(limit);
        expect(uploadProvider).toHaveBeenCalledOnce();
        uploadProvider.mockClear();

        const over = await core.handle({ action: 'upload_file', params, echo: `${echo}x` });
        expect(over).toMatchObject({ status: 'failed', retcode: 10003, data: null });
        expect(uploadProvider).not.toHaveBeenCalled();
        expect(downloadProvider).not.toHaveBeenCalled();
        expect(api.handle).not.toHaveBeenCalled();
    });

    it('accepts the exact get-data success budget and rejects +1 without v11', async () => {
        const api = {
            handle: vi.fn(async () => ({ status: 'ok' as const, retcode: 0, data: null })),
        };
        const uploadProvider = vi.fn(() => ({ kind: 'ok' as const, fileId }));
        const payload = { name: '文件🪶\\\n\t\u0000"\udfff.bin', data: DATA, sha256: SHA256 };
        const downloadProvider = vi.fn(() => ({ kind: 'ok' as const, ...payload }));
        const core = new dispatcherApi.V12Dispatcher({
            self: { platform: 'qq', user_id: '10001' },
            version: { impl: 'fixture', version: '1' },
            api,
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
            uploadDataFile: uploadProvider,
            getUploadedDataFile: downloadProvider,
        });
        const params = { type: 'data', file_id: fileId };
        const echo = boundaryEcho(payload);
        const exact = await core.handle({ action: 'get_file', params, echo });
        expect(exact).toMatchObject({ status: 'ok', retcode: 0, data: payload });
        expect(exact.echo === echo).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(limit);
        expect(downloadProvider).toHaveBeenCalledOnce();

        const over = await core.handle({ action: 'get_file', params, echo: `${echo}x` });
        expect(over).toMatchObject({ status: 'failed', retcode: 10003, data: null });
        expect(downloadProvider).toHaveBeenCalledTimes(2);
        expect(uploadProvider).not.toHaveBeenCalled();
        expect(api.handle).not.toHaveBeenCalled();
    });
});

describe('real transport output accounting with purely in-memory peer fakes', () => {
    it('returns an overflow failure and terminates a peer when its pending response queue fills', async () => {
        const f = await account('10001');
        const payload = Buffer.alloc(1024, 0x61).toString('base64');
        const id = uploadedId(await upload(f, 'queue.bin', payload));
        const actual =
            await vi.importActual<typeof import('../../src/v12-network')>('../../src/v12-network');
        const transport = new actual.V12Transport({
            host: 'fixture.invalid',
            port: 1,
            handle: f.transport().options.handle,
            getConnectEvent: () => null,
            subscribe: () => () => {},
            maxOutputBytes: 320,
        });
        transport.attach();
        const peer = new FakeWirePeer();

        try {
            // Exercise the real serializer/queue with an EventEmitter stand-in;
            // attach() uses only the inert noServer fake above, never open().
            (transport as unknown as { accept(peer: FakeWirePeer): void }).accept(peer);
            expect(peer.frames).toHaveLength(1);
            peer.acknowledge();
            const echo = 'E'.repeat(100);
            const input = JSON.stringify({
                action: 'get_file',
                params: { type: 'data', file_id: id },
                echo,
            });
            peer.emit('message', Buffer.from(input), false);
            await flushMicrotasks();
            expect(peer.frames).toHaveLength(2);
            const first = JSON.parse(peer.frames[1]!) as {
                status: string;
                retcode: number;
                echo: string;
            };
            expect(first).toMatchObject({ status: 'failed', retcode: 20001, echo });
            const queuedBytes = Buffer.byteLength(peer.frames[1]!) + 14;
            expect(queuedBytes).toBeLessThanOrEqual(320);
            expect(queuedBytes * 2).toBeGreaterThan(320);
            peer.emit('message', Buffer.from(input), false);
            await flushMicrotasks();
            expect(peer.terminated).toBe(true);
            expect(peer.frames).toHaveLength(2);
            expect((await getData(f, id)).retcode).toBe(0);
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            await transport.close();
        }
    });

    it('destroys an in-memory HTTP response when even its echoed error exceeds the output cap', async () => {
        const f = await account('10001');
        const id = uploadedId(await upload(f));
        const actual =
            await vi.importActual<typeof import('../../src/v12-network')>('../../src/v12-network');
        const transport = new actual.V12Transport({
            host: 'fixture.invalid',
            port: 1,
            handle: f.transport().options.handle,
            getConnectEvent: () => null,
            subscribe: () => () => {},
            maxBodyBytes: 2 * 1024 * 1024,
        });
        transport.attach();
        const req = new FakeRequest();
        const res = new FakeResponse();

        try {
            transport.handleRequest(
                req as unknown as IncomingMessage,
                res as unknown as ServerResponse,
            );
            req.emit(
                'data',
                Buffer.from(
                    JSON.stringify({
                        action: 'get_file',
                        params: { type: 'data', file_id: id },
                        echo: 'E'.repeat(1_048_576),
                    }),
                ),
            );
            req.emit('end');
            await flushMicrotasks();
            expect(res.destroyed).toBe(true);
            expect(res.body).toBeUndefined();
            expect((await getData(f, id)).retcode).toBe(0);
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            await transport.close();
        }
    });
});

describe('real transport quiesce reentrancy with in-memory peers', () => {
    it.each(['response', 'peer'] as const)(
        'blocks saved callback reads and writes during synchronous %s cleanup, before onError',
        async (kind) => {
            const actual =
                await vi.importActual<typeof import('../../src/v12-network')>(
                    '../../src/v12-network',
                );
            // The runtime's fake transport delegates admission to this real
            // transport, whose attach() installs only the inert noServer fake.
            // No listen, upgrade, socket, or real HTTP connection is made.
            fixture.createBacking = (options) =>
                new actual.V12Transport(options) as unknown as MemoryTransport;
            const f = await account('10001');
            const old = f.transport();
            const backing = old.backing!;
            expect(backing.isAcceptingActions()).toBe(true);
            const id = uploadedId(await upload(f));
            const reported = vi.spyOn(
                old.options as V12TransportOptions & { onError: (error: Error) => void },
                'onError',
            );
            const attempted: Array<ReturnType<V12TransportOptions['handle']>> = [];
            let duringCleanup = false;

            const reenter = () => {
                duringCleanup = true;
                expect(backing.isAcceptingActions()).toBe(false);
                expect(f.runtime.isActive).toBe(true);
                attempted.push(
                    old.options.handle({
                        action: 'get_file',
                        params: { type: 'data', file_id: id },
                    }),
                );
                attempted.push(
                    old.options.handle({
                        action: 'upload_file',
                        params: { type: 'data', name: OLD_SECRET, data: DATA },
                    }),
                );
                attempted.push(old.options.handle({ action: 'get_supported_actions', params: {} }));
            };

            if (kind === 'response') {
                const req = new FakeRequest();
                req.rawHeaders = ['Authorization', `Bearer ${TOKEN}`];
                const res = new FakeResponse();
                const destroy = res.destroy.bind(res);

                res.destroy = () => {
                    reenter();
                    return destroy();
                };

                backing.handleRequest(
                    req as unknown as IncomingMessage,
                    res as unknown as ServerResponse,
                );
                expect(res.status).toBe(0);
                expect(res.destroyed).toBe(false);
                expect(res.writableEnded).toBe(false);
            } else {
                const peer = new FakeWirePeer();
                const terminate = peer.terminate.bind(peer);

                peer.terminate = () => {
                    reenter();
                    terminate();
                };

                (backing as unknown as { accept(peer: FakeWirePeer): void }).accept(peer);
            }

            backing.quiesce();
            expect(duringCleanup).toBe(true);
            expect(reported).not.toHaveBeenCalled();
            expect(f.runtime.isActive).toBe(true);
            expect(attempted).toHaveLength(3);
            const [read, write, supported] = await Promise.all(attempted);
            failed(read!);
            failed(write!);
            expect(supported!.retcode).toBe(0);
            expect(supported!.data).not.toContain('upload_file');
            expect(f.api.handle).not.toHaveBeenCalled();
            await f.runtime.close();
            fixture.createBacking = null;
            await f.open();
            failed(await getData(f, id));
            expect((await f.client.request('get_supported_actions')).data).toContain('upload_file');
            expect((await getData(f, uploadedId(await upload(f)))).retcode).toBe(0);
        },
    );
});

describe('upload capability readiness in exceptional listener lifecycles', () => {
    it('does not advertise a revoked generation whose pending open survives a failed close', async () => {
        const openGate: { release?: () => void } = {};
        const pendingOpen = new Promise<void>((resolve) => {
            openGate.release = resolve;
        });
        const actionGate: { promise?: Promise<void>; release?: () => void } = {};
        const f = await account('10001', {
            open: false,
            trackAction: <T>(_label: string, start: () => Promise<T>) =>
                actionGate.promise ? actionGate.promise.then(start) : start(),
        });
        fixture.openGate = () => pendingOpen;
        const opening = f.open();
        const old = fixture.transports.at(-1)!;
        old.quiesce.mockImplementationOnce(() => {
            throw new Error('synthetic quiesce failure during pending open');
        });
        actionGate.promise = new Promise<void>((resolve) => {
            actionGate.release = resolve;
        });
        const queued = old.options.handle({
            action: 'upload_file',
            params: { type: 'data', name: OLD_SECRET, data: DATA },
        });
        await expect(f.runtime.close()).rejects.toBeInstanceOf(Error);
        fixture.openGate = null;
        openGate.release!();
        await opening;
        expect(f.runtime.isActive).toBe(true);
        expect(old.isAcceptingActions()).toBe(true);
        const releaseAction = actionGate.release!;
        actionGate.promise = undefined;
        releaseAction();
        failed(await queued);
        failed(await upload(f));
        const supported = await f.client.request('get_supported_actions');
        expect(supported.retcode).toBe(0);
        expect(supported.data).not.toContain('upload_file');
        expect((await f.client.request('get_version')).retcode).toBe(0);
        expect(f.api.handle).not.toHaveBeenCalled();

        await f.runtime.close();
        await f.open();
        expect(f.runtime.isActive).toBe(true);
        expect((await f.client.request('get_supported_actions')).data).toContain('upload_file');
        expect((await getData(f, uploadedId(await upload(f)))).retcode).toBe(0);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('does not advertise after constructor-time onError until a real close/reopen', async () => {
        fixture.construct = (transport) => {
            fixture.construct = null;
            transport.options.onError!(new Error('synthetic constructor error'));
        };

        const f = await account('10001');
        const old = f.transport();
        expect(f.runtime.isActive).toBe(true);
        expect(old.isAcceptingActions()).toBe(true);
        const supported = await f.client.request('get_supported_actions');
        expect(supported.retcode).toBe(0);
        expect(supported.data).not.toContain('upload_file');
        expect((await f.client.request('get_version')).retcode).toBe(0);
        failed(await upload(f));
        failed(
            await old.options.handle({
                action: 'upload_file',
                params: { type: 'data', name: OLD_SECRET, data: DATA },
            }),
        );
        await f.runtime.close();
        await f.open();
        expect((await f.client.request('get_supported_actions')).data).toContain('upload_file');
        expect((await getData(f, uploadedId(await upload(f)))).retcode).toBe(0);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('uses transport readiness without reading the function own call getter', async () => {
        const f = await account('10001');
        const ready = f.transport().isAcceptingActions;
        let callReads = 0;
        Object.defineProperty(ready, 'call', {
            configurable: true,
            get() {
                callReads++;
                throw new Error('unexpected readiness call getter');
            },
        });

        try {
            const supported = await f.client.request('get_supported_actions');
            expect(supported.retcode).toBe(0);
            expect(supported.data).toContain('upload_file');
            const id = uploadedId(await upload(f));
            expect((await getData(f, id)).data).toEqual({ name: NAME, data: DATA, sha256: SHA256 });
            expect(ready.mock.calls.length).toBeGreaterThan(0);
            expect(callReads).toBe(0);
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            delete (ready as unknown as { call?: unknown }).call;
        }
    });

    it.each(['uploadDataFile', 'getUploadedDataFile'] as const)(
        'rechecks a revoked lease after the second read of provider %s',
        async (revokingProvider) => {
            let current = true;
            let uploadReads = 0;
            let downloadReads = 0;
            let readinessCallsAtRevocation = -1;
            const api = {
                handle: vi.fn(async () => ({ status: 'ok' as const, retcode: 0, data: null })),
            };
            const uploadProvider = vi.fn(() => ({ kind: 'unavailable' as const }));
            const downloadProvider = vi.fn(() => ({ kind: 'unavailable' as const }));
            const readiness = vi.fn((lease?: () => boolean) => lease?.() === true);
            const lease = vi.fn(() => current);
            const options = {
                self: { platform: 'qq', user_id: '10001' },
                version: { impl: 'fixture', version: '1' },
                api,
                getStatus: () => ({ good: true, online: true }),
                getSentMessageTime: () => null,
                isUploadDataSupported: readiness,
                get uploadDataFile() {
                    uploadReads++;

                    if (revokingProvider === 'uploadDataFile' && uploadReads === 2) {
                        readinessCallsAtRevocation = readiness.mock.calls.length;
                        current = false;
                    }

                    return uploadProvider;
                },
                get getUploadedDataFile() {
                    downloadReads++;

                    if (revokingProvider === 'getUploadedDataFile' && downloadReads === 2) {
                        readinessCallsAtRevocation = readiness.mock.calls.length;
                        current = false;
                    }

                    return downloadProvider;
                },
            };
            const core = new dispatcherApi.V12Dispatcher(options);
            const result = await core.handle(
                { action: 'get_supported_actions', params: {} },
                lease,
            );
            expect(result.retcode).toBe(0);
            expect(result.data).not.toContain('upload_file');
            expect(readinessCallsAtRevocation).toBe(1);
            expect(uploadReads).toBe(2);
            expect(downloadReads).toBe(2);
            expect(readiness).toHaveReturnedWith(true);
            expect(lease.mock.calls.length).toBeGreaterThanOrEqual(2);
            expect(uploadProvider).not.toHaveBeenCalled();
            expect(downloadProvider).not.toHaveBeenCalled();
            expect(api.handle).not.toHaveBeenCalled();
        },
    );

    it('uses core readiness without reading the function own call getter', async () => {
        let callReads = 0;
        const readiness = vi.fn((lease?: () => boolean) => lease?.() === true);
        Object.defineProperty(readiness, 'call', {
            configurable: true,
            get() {
                callReads++;
                throw new Error('unexpected core readiness call getter');
            },
        });
        const api = {
            handle: vi.fn(async () => ({ status: 'ok' as const, retcode: 0, data: null })),
        };
        const uploadProvider = vi.fn(() => ({ kind: 'unavailable' as const }));
        const downloadProvider = vi.fn(() => ({ kind: 'unavailable' as const }));
        const core = new dispatcherApi.V12Dispatcher({
            self: { platform: 'qq', user_id: '10001' },
            version: { impl: 'fixture', version: '1' },
            api,
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
            isUploadDataSupported: readiness,
            uploadDataFile: uploadProvider,
            getUploadedDataFile: downloadProvider,
        });

        try {
            const result = await core.handle(
                { action: 'get_supported_actions', params: {} },
                () => true,
            );
            expect(result.retcode).toBe(0);
            expect(result.data).toContain('upload_file');
            expect(readiness).toHaveBeenCalledOnce();
            expect(callReads).toBe(0);
            expect(uploadProvider).not.toHaveBeenCalled();
            expect(downloadProvider).not.toHaveBeenCalled();
            expect(api.handle).not.toHaveBeenCalled();
        } finally {
            delete (readiness as unknown as { call?: unknown }).call;
        }
    });

    it.each([
        ['canAccept', 'throw'],
        ['canAccept', 'close'],
        ['transport', 'throw'],
        ['transport', 'close'],
    ] as const)('does not advertise when %s readiness reenters with %s', async (source, effect) => {
        const control: { hook?: () => boolean; closing?: Promise<void>; calls: number } = {
            calls: 0,
        };
        const f = await account('10001', {
            canAccept: () => (control.hook ? control.hook() : true),
        });
        const current = f.transport();

        const disrupt = (): boolean => {
            control.calls++;
            control.hook = undefined;

            if (effect === 'throw') {
                throw new Error('synthetic readiness failure');
            }

            control.closing = f.runtime.close();
            return true;
        };

        if (source === 'canAccept') {
            control.hook = disrupt;
        } else {
            current.isAcceptingActions.mockImplementationOnce(disrupt);
        }

        const result = await f.client.request('get_supported_actions');
        expect(control.calls).toBe(1);
        expect(result.retcode).toBe(0);
        expect(result.data).not.toContain('upload_file');

        if (effect === 'close') {
            expect(control.closing).toBeDefined();
            await control.closing;
            await f.open();
        }

        expect((await f.client.request('get_supported_actions')).data).toContain('upload_file');
        expect((await getData(f, uploadedId(await upload(f)))).retcode).toBe(0);
        expect(f.api.handle).not.toHaveBeenCalled();
    });
});

describe('v12 uploaded data listener generation and revocation', () => {
    it('revokes on close/reopen and prevents saved old callbacks from writing into the new store', async () => {
        const f = await account('10001');
        const old = f.transport();
        const oldId = uploadedId(await upload(f, OLD_SECRET));
        await f.runtime.close();
        await f.open();
        expect(f.transport()).not.toBe(old);
        failed(await getData(f, oldId));
        const original = storeApi.V12UploadedDataStore.prototype.upload;
        const issued: string[] = [];
        const spy = vi
            .spyOn(storeApi.V12UploadedDataStore.prototype, 'upload')
            .mockImplementation(function (this: V12UploadedDataStore, ...args) {
                const result = original.apply(this, args);

                if (result.kind === 'ok') {
                    issued.push(result.fileId);
                }

                return result;
            });
        failed(
            await old.options.handle({
                action: 'upload_file',
                params: { type: 'data', name: OLD_SECRET, data: DATA },
            }),
        );
        spy.mockRestore();

        for (const leakedId of issued) {
            failed(await getData(f, leakedId));
        }

        const freshId = uploadedId(await upload(f, 'new-generation'));
        expect(freshId).not.toBe(oldId);
        const fresh = await getData(f, freshId);
        expect(fresh.data).toEqual({ name: 'new-generation', data: DATA, sha256: SHA256 });
        expect(JSON.stringify(fresh)).not.toContain(OLD_SECRET);
        failed(await getData(f, oldId));
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('rejects an old action delayed until after a complete listener replacement', async () => {
        const gate: { promise?: Promise<void>; release?: () => void } = {};
        const f = await account('10001', {
            trackAction: <T>(_label: string, start: () => Promise<T>) =>
                gate.promise ? gate.promise.then(start) : start(),
        });
        const old = f.transport();
        const oldId = uploadedId(await upload(f, 'old-before-delay'));
        gate.promise = new Promise<void>((resolve) => {
            gate.release = resolve;
        });
        const delayed = old.options.handle({
            action: 'upload_file',
            params: { type: 'data', name: OLD_SECRET, data: DATA },
        });
        await f.runtime.close();
        await f.open();
        const release = gate.release!;
        gate.promise = undefined;
        release();
        failed(await delayed);
        failed(await getData(f, oldId));
        const freshId = uploadedId(await upload(f, 'after-delayed-action'));
        const fresh = await getData(f, freshId);
        expect(fresh.data).toEqual({ name: 'after-delayed-action', data: DATA, sha256: SHA256 });
        expect(JSON.stringify(fresh)).not.toContain(OLD_SECRET);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it.each([
        ['token', { accessToken: 'synthetic-new-token' }],
        ['host', { host: 'other.fixture.invalid' }],
        ['port', { port: 2 }],
    ] as const)('destroys the old store on %s reload', async (_label, change) => {
        const f = await account('10001');
        const old = f.transport();
        const id = uploadedId(await upload(f));
        await f.runtime.reload({ ...f.runtime.currentConfig, ...change });
        f.captureTransport();
        expect(f.transport()).not.toBe(old);
        failed(await getData(f, id));
        failed(
            await old.options.handle({ action: 'get_file', params: { type: 'data', file_id: id } }),
        );
        const next = uploadedId(await upload(f, 'reloaded'));
        expect((await getData(f, next)).retcode).toBe(0);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('revokes on current onError but ignores an earlier generation onError', async () => {
        const f = await account('10001');
        const old = f.transport();
        const oldId = uploadedId(await upload(f));
        await f.runtime.close();
        await f.open();
        const current = f.transport();
        const newId = uploadedId(await upload(f, 'current'));
        old.options.onError!(new Error('synthetic old error'));
        expect((await getData(f, newId)).data).toEqual({
            name: 'current',
            data: DATA,
            sha256: SHA256,
        });
        failed(await getData(f, oldId));
        current.options.onError!(new Error('synthetic current error'));
        failed(await getData(f, newId));
        await f.runtime.close();
        await f.open();
        failed(await getData(f, newId));
        const newest = uploadedId(await upload(f, 'newest'));
        expect((await getData(f, newest)).retcode).toBe(0);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it.each(['quiesce', 'forceClose'] as const)(
        'revokes immediately on %s, even through the saved callback',
        async (method) => {
            const f = await account('10001');
            const saved = f.transport();
            const id = uploadedId(await upload(f));
            f.runtime[method]();
            failed(
                await saved.options.handle({
                    action: 'get_file',
                    params: { type: 'data', file_id: id },
                }),
            );
            failed(
                await saved.options.handle({
                    action: 'upload_file',
                    params: { type: 'data', name: NAME, data: DATA },
                }),
            );
            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );

    it.each(['close', 'quiesce'] as const)(
        'invalidates data even if transport %s fails during close',
        async (failure) => {
            const f = await account('10001');
            const old = f.transport();
            const id = uploadedId(await upload(f));

            if (failure === 'close') {
                old.close.mockRejectedValueOnce(new Error('synthetic close failure'));
            } else {
                old.quiesce.mockImplementationOnce(() => {
                    throw new Error('synthetic quiesce failure');
                });
            }

            await expect(f.runtime.close()).rejects.toBeInstanceOf(Error);
            failed(
                await old.options.handle({
                    action: 'get_file',
                    params: { type: 'data', file_id: id },
                }),
            );
            await f.runtime.close();
            await f.open();
            failed(await getData(f, id));
            expect((await getData(f, uploadedId(await upload(f, 'after-recovery')))).retcode).toBe(
                0,
            );
            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );

    it('rejects a close reentered synchronously during store upload before commit', async () => {
        const f = await account('10001');
        const old = f.transport();
        const before = uploadedId(await upload(f, 'before-reentry'));
        const originalUpload = storeApi.V12UploadedDataStore.prototype.upload;
        const originalNow = performance.now.bind(performance);
        const closing: { promise?: Promise<void> } = {};
        const observed: Array<{ kind: string; fileId?: string }> = [];
        const spy = vi
            .spyOn(storeApi.V12UploadedDataStore.prototype, 'upload')
            .mockImplementation(function (this: V12UploadedDataStore, ...args) {
                const clock = vi.spyOn(performance, 'now').mockImplementationOnce(() => {
                    closing.promise = f.runtime.close();
                    return originalNow();
                });

                try {
                    const result = originalUpload.apply(this, args);
                    observed.push(result);
                    return result;
                } finally {
                    clock.mockRestore();
                }
            });
        const stale = await old.options.handle({
            action: 'upload_file',
            params: { type: 'data', name: OLD_SECRET, data: DATA },
        });
        spy.mockRestore();
        expect(closing.promise).toBeDefined();
        failed(stale);
        await closing.promise;
        await f.open();
        failed(await getData(f, before));

        for (const result of observed) {
            if (result.kind === 'ok' && result.fileId) {
                failed(await getData(f, result.fileId));
            }
        }

        const fresh = uploadedId(await upload(f, 'after-reentry'));
        expect((await getData(f, fresh)).data).toEqual({
            name: 'after-reentry',
            data: DATA,
            sha256: SHA256,
        });
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('rejects forceClose reentered synchronously during store upload before commit', async () => {
        const f = await account('10001');
        const saved = f.transport();
        const before = uploadedId(await upload(f));
        const originalUpload = storeApi.V12UploadedDataStore.prototype.upload;
        const originalNow = performance.now.bind(performance);
        let entered = false;
        const spy = vi
            .spyOn(storeApi.V12UploadedDataStore.prototype, 'upload')
            .mockImplementation(function (this: V12UploadedDataStore, ...args) {
                const clock = vi.spyOn(performance, 'now').mockImplementationOnce(() => {
                    entered = true;
                    f.runtime.forceClose();
                    return originalNow();
                });

                try {
                    return originalUpload.apply(this, args);
                } finally {
                    clock.mockRestore();
                }
            });
        const result = await saved.options.handle({
            action: 'upload_file',
            params: { type: 'data', name: OLD_SECRET, data: DATA },
        });
        spy.mockRestore();
        expect(entered).toBe(true);
        failed(result);
        failed(
            await saved.options.handle({
                action: 'get_file',
                params: { type: 'data', file_id: before },
            }),
        );
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('bounds an oversized echo before upload at the saved in-process callback', async () => {
        const f = await account('10001');
        const spy = vi.spyOn(storeApi.V12UploadedDataStore.prototype, 'upload');
        const result = await f.transport().options.handle({
            action: 'upload_file',
            params: { type: 'data', name: NAME, data: DATA },
            echo: 'x'.repeat(1_048_577),
        });
        expect(result).toMatchObject({ status: 'failed', retcode: 10001, data: null });
        expect(result).not.toHaveProperty('echo');
        expect(spy).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
    });
});
