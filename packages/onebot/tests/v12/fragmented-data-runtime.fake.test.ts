import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V12TransportOptions } from '../../src/v12-network';
import type { V12Runtime } from '../../src/v12-runtime/runtime';
import type { V12Source } from '../../src/v12-runtime/source-generation';
import type { V12UploadedDataStore } from '../../src/v12/uploaded-data-store';
import type { JsonObject } from '../../src/types';

type FakeTransport = {
    options: V12TransportOptions;
    open: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    quiesce: ReturnType<typeof vi.fn>;
    forceClose: ReturnType<typeof vi.fn>;
    isAcceptingActions: ReturnType<typeof vi.fn>;
};

// The fake open is an in-memory state change, not a bind or a connection. The
// saved handle lets a test exercise a callback after its generation is retired.
const fixture = vi.hoisted(() => ({
    transports: [] as FakeTransport[],
    forbiddenModules: [] as string[],
}));

vi.mock('../../src/v12-network', () => ({
    V12Transport: class {
        private accepting = false;
        readonly open = vi.fn(async () => {
            this.accepting = true;
        });
        readonly close = vi.fn(async () => {
            this.accepting = false;
        });
        readonly quiesce = vi.fn(() => {
            this.accepting = false;
        });
        readonly forceClose = vi.fn(() => {
            this.accepting = false;
        });
        readonly isAcceptingActions = vi.fn(() => this.accepting);

        constructor(readonly options: V12TransportOptions) {
            fixture.transports.push(this);
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
    // The real V12Transport attach() test below needs only this inert noServer
    // object. It does not create a listener, upgrade, server, or socket.
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

const ENDPOINT = 'http://fixture.invalid/';
const TOKEN = 'synthetic-transport-token';
const PREFIX = 'jiyu-upload:v1:';
const NAME = 'fixture.txt';
const DATA = 'aGVsbG8=';
const SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const activeRuntimes: V12Runtime[] = [];

let sdkApi: typeof import('../../../sdk/src/v12/http-client.js');
let runtimeApi: typeof import('../../src/v12-runtime/runtime');
let identityApi: typeof import('../../src/v12-runtime/identity');
let sourceApi: typeof import('../../src/v12-runtime/source-generation');
let managerApi: typeof import('../../src/network/network-manager');
let dispatcherApi: typeof import('../../src/v12/dispatcher');
let storeApi: typeof import('../../src/v12/uploaded-data-store');
let tokenApi: typeof import('../../src/v12/image-file-token');
let loggerApi: typeof import('@snowluma/common/logger');
let logEntries: Array<{ message: string; line: string }>;
let previousLevel: string;
let unsubscribeLogs: () => void;
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let guards: Array<{ mock: { calls: unknown[] } }>;

function blocked(): never {
    throw new Error('unexpected network or native operation in fragmented-data fixture');
}

beforeEach(async () => {
    fixture.transports.length = 0;
    fixture.forbiddenModules.length = 0;
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

    // Import the real dispatcher, runtime, store and SDK after guards are active.
    sdkApi = await import('../../../sdk/src/v12/http-client.js');
    sourceApi = await import('../../src/v12-runtime/source-generation');
    managerApi = await import('../../src/network/network-manager');
    identityApi = await import('../../src/v12-runtime/identity');
    dispatcherApi = await import('../../src/v12/dispatcher');
    storeApi = await import('../../src/v12/uploaded-data-store');
    tokenApi = await import('../../src/v12/image-file-token');
    runtimeApi = await import('../../src/v12-runtime/runtime');
    loggerApi = await import('@snowluma/common/logger');
    previousLevel = loggerApi.getLogLevel();
    loggerApi.setLogLevel('trace');
    logEntries = [];
    unsubscribeLogs = loggerApi.subscribeLogs((entry) => logEntries.push(entry));
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
        unsubscribeLogs();
        loggerApi.setLogLevel(previousLevel);
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
    } = {},
) {
    const generation = new sourceApi.SourceGeneration();
    const manager = new managerApi.OneBotNetworkManager();
    const api = {
        handle: vi.fn(async (_action: string, _params: JsonObject) => {
            throw new Error('unexpected v11 action in fragmented-data fixture');
        }),
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
            getSentMessageTime: async () => null,
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
    let current!: FakeTransport;

    const open = async () => {
        await runtime.open();
        const candidate = fixture.transports.at(-1);

        if (!candidate) {
            throw new Error('fake transport unavailable');
        }

        current = candidate;
    };

    await open();
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
    return { uin, runtime, api, client, fakeFetch, open, transport: () => current };
}

type Account = Awaited<ReturnType<typeof account>>;

async function upload(f: Account, name = NAME, data = DATA) {
    return f.client.request(
        'upload_file',
        { type: 'data', name, data },
        { self: { platform: 'qq', user_id: f.uin }, echo: 'upload' },
    );
}

function uploadedId(result: Awaited<ReturnType<typeof upload>>): string {
    expect(result).toMatchObject({ status: 'ok', retcode: 0, echo: 'upload' });
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

async function prepare(f: Account, fileId: string, echo = 'prepare') {
    return f.client.request(
        'get_file_fragmented',
        { stage: 'prepare', file_id: fileId },
        { self: { platform: 'qq', user_id: f.uin }, echo },
    );
}

async function transfer(
    f: Account,
    fileId: string,
    offset: number,
    size: number,
    echo = 'transfer',
) {
    return f.client.request(
        'get_file_fragmented',
        { stage: 'transfer', file_id: fileId, offset, size },
        { self: { platform: 'qq', user_id: f.uin }, echo },
    );
}

function failed(result: { status: string; retcode: number; data: unknown }) {
    expect(result.status).toBe('failed');
    expect(result.retcode).not.toBe(0);
    expect(result.data).toBeNull();
}

// These are inert EventEmitters, not node HTTP servers, sockets or connections.
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
    for (let index = 0; index < 30; index++) {
        await Promise.resolve();
    }
}

describe('get_file_fragmented through SDK, runtime and generation-local store', () => {
    it('uploads hello and returns the exact prepare and transfer envelopes', async () => {
        const f = await account('10001');
        const id = uploadedId(await upload(f));
        const specialEcho = '中文🪶\\\n\t\u0000"';
        expect(await prepare(f, id, '')).toEqual({
            status: 'ok',
            retcode: 0,
            data: { name: NAME, total_size: 5, sha256: SHA256 },
            message: '',
            echo: '',
        });
        expect(await transfer(f, id, 1, 3, specialEcho)).toEqual({
            status: 'ok',
            retcode: 0,
            data: { data: 'ZWxs' },
            message: '',
            echo: specialEcho,
        });
        expect(f.fakeFetch).toHaveBeenCalledTimes(3);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('serves empty and end-of-file ranges, out-of-order and repeated reads', async () => {
        const f = await account('10001');
        const id = uploadedId(await upload(f));
        const empty = uploadedId(await upload(f, '', ''));
        expect((await prepare(f, empty)).data).toEqual({
            name: '',
            total_size: 0,
            sha256: EMPTY_SHA256,
        });
        expect((await transfer(f, empty, 0, 0)).data).toEqual({ data: '' });

        for (const [offset, size, expected] of [
            [5, 0, ''],
            [3, 2, 'bG8='],
            [0, 2, 'aGU='],
            [1, 3, 'ZWxs'],
            [1, 3, 'ZWxs'],
            [0, 5, DATA],
        ] as const) {
            const result = await transfer(f, id, offset, size);
            expect(result).toMatchObject({ status: 'ok', retcode: 0, data: { data: expected } });
        }

        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('uses 10004 for out-of-file ranges and rejects unsafe or malformed integers', async () => {
        const f = await account('10001');
        const id = uploadedId(await upload(f));
        const empty = uploadedId(await upload(f, 'empty', ''));

        for (const [fileId, offset, size] of [
            [id, 0, 6],
            [id, 4, 2],
            [id, 5, 1],
            [id, 6, 0],
            [id, Number.MAX_SAFE_INTEGER, 0],
            [id, 1, Number.MAX_SAFE_INTEGER],
            [empty, 0, 1],
        ] as const) {
            const result = await f.transport().options.handle({
                action: 'get_file_fragmented',
                params: { stage: 'transfer', file_id: fileId, offset, size },
                echo: '范围🪶',
            });
            expect(result).toMatchObject({
                status: 'failed',
                retcode: 10004,
                data: null,
                echo: '范围🪶',
            });
        }

        for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null]) {
            for (const field of ['offset', 'size'] as const) {
                const params = { stage: 'transfer', file_id: id, offset: 0, size: 1, [field]: bad };
                failed(
                    await f.transport().options.handle({ action: 'get_file_fragmented', params }),
                );
            }
        }

        for (const params of [
            { stage: 'transfer', file_id: id, size: 1 },
            { stage: 'transfer', file_id: id, offset: 0 },
        ]) {
            failed(await f.transport().options.handle({ action: 'get_file_fragmented', params }));
        }

        expect((await transfer(f, id, 1, 3)).data).toEqual({ data: 'ZWxs' });
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('rejects extra fields, unsupported stages and invalid or unrecognized file IDs', async () => {
        const f = await account('10001');
        const id = uploadedId(await upload(f));
        const otherId =
            PREFIX + (id[PREFIX.length] === 'A' ? 'B' : 'A') + id.slice(PREFIX.length + 1);

        for (const params of [
            { stage: 'prepare', file_id: id, offset: 0 },
            { stage: 'prepare', file_id: id, extra: true },
            { stage: 'transfer', file_id: id, offset: 0, size: 1, extra: true },
        ]) {
            expect(
                await f
                    .transport()
                    .options.handle({ action: 'get_file_fragmented', params, echo: '' }),
            ).toMatchObject({ status: 'failed', retcode: 10004, data: null, echo: '' });
        }

        for (const params of [
            { stage: 'finish', file_id: id },
            { stage: '', file_id: id },
            { file_id: id },
            { stage: 1, file_id: id },
            { stage: 'prepare' },
            { stage: 'prepare', file_id: '' },
            { stage: 'prepare', file_id: null },
            { stage: 'prepare', file_id: 12 },
            { stage: 'prepare', file_id: 'x'.repeat(4097) },
            { stage: 'prepare', file_id: PREFIX },
            { stage: 'prepare', file_id: `${PREFIX}%%%` },
            { stage: 'prepare', file_id: otherId },
            { stage: 'prepare', file_id: 'legacy-v11-id' },
        ]) {
            failed(await f.transport().options.handle({ action: 'get_file_fragmented', params }));
        }

        expect((await prepare(f, id)).data).toEqual({ name: NAME, total_size: 5, sha256: SHA256 });
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('does not redeem image/voice handles or fall back to v11 for either stage', async () => {
        const f = await account('10001');
        const imageTokens = new tokenApi.V12ImageFileTokens(f.uin);
        const voiceTokens = new tokenApi.V12VoiceFileTokens(f.uin);
        const image = imageTokens.issue('https://media.example.invalid/image');
        const voice = voiceTokens.issue('https://media.example.invalid/voice');
        const imageRedeem = vi.spyOn(tokenApi.V12ImageFileTokens.prototype, 'redeem');
        const voiceRedeem = vi.spyOn(tokenApi.V12VoiceFileTokens.prototype, 'redeem');

        try {
            for (const id of [image, voice, 'legacy-v11-id']) {
                failed(await prepare(f, id));
                failed(await transfer(f, id, 0, 1));
            }

            expect(imageRedeem).not.toHaveBeenCalled();
            expect(voiceRedeem).not.toHaveBeenCalled();
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            imageTokens.revoke();
            voiceTokens.revoke();
        }
    });

    it('uses only each runtime store and rejects wrong self before either store read', async () => {
        const a = await account('10001');
        const b = await account('10002');
        const idA = uploadedId(await upload(a));
        // B is still empty, so this checks an observed local miss without assuming
        // that random IDs can never collide across stores or generations.
        failed(await prepare(b, idA));
        failed(await transfer(b, idA, 1, 3));
        const idB = uploadedId(await upload(b, 'b.txt', 'Qg=='));
        expect((await prepare(b, idB)).data).toEqual({
            name: 'b.txt',
            total_size: 1,
            sha256: createHash('sha256').update('B').digest('hex'),
        });

        if (idA !== idB) {
            failed(await prepare(b, idA));
            failed(await transfer(b, idA, 0, 1));
            failed(await prepare(a, idB));
        }

        const metadata = vi.spyOn(storeApi.V12UploadedDataStore.prototype, 'getMetadata');
        const chunk = vi.spyOn(storeApi.V12UploadedDataStore.prototype, 'getChunk');
        const wrongSelf = { platform: 'qq', user_id: b.uin };

        for (const params of [
            { stage: 'prepare', file_id: idA },
            { stage: 'transfer', file_id: idA, offset: 1, size: 3 },
        ]) {
            const result = await a.transport().options.handle({
                action: 'get_file_fragmented',
                params,
                self: wrongSelf,
                echo: '身份',
            });
            expect(result).toMatchObject({
                status: 'failed',
                retcode: 10102,
                data: null,
                echo: '身份',
            });
        }

        expect(metadata).not.toHaveBeenCalled();
        expect(chunk).not.toHaveBeenCalled();
        expect(a.api.handle).not.toHaveBeenCalled();
        expect(b.api.handle).not.toHaveBeenCalled();
    });

    it('expires at the local ten-minute boundary without read renewal', async () => {
        let now = 1_000_000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const f = await account('10001');
        const id = uploadedId(await upload(f));
        now += 600_000 - 1;
        expect((await prepare(f, id)).data).toEqual({ name: NAME, total_size: 5, sha256: SHA256 });
        expect((await transfer(f, id, 1, 3)).data).toEqual({ data: 'ZWxs' });
        now++;
        failed(await prepare(f, id));
        failed(await transfer(f, id, 1, 3));
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('revokes close/reopen and delayed old-generation callbacks before the new store', async () => {
        const gate: { promise?: Promise<void>; release?: () => void } = {};
        const f = await account('10001', {
            trackAction: <T>(_label: string, start: () => Promise<T>) =>
                gate.promise ? gate.promise.then(start) : start(),
        });
        const old = f.transport();
        const oldId = uploadedId(await upload(f));
        gate.promise = new Promise<void>((resolve) => {
            gate.release = resolve;
        });
        const delayed = old.options.handle({
            action: 'get_file_fragmented',
            params: { stage: 'transfer', file_id: oldId, offset: 1, size: 3 },
            echo: 'old',
        });
        await f.runtime.close();
        await f.open();
        expect(f.transport()).not.toBe(old);
        const release = gate.release!;
        gate.promise = undefined;
        release();
        failed(await delayed);
        failed(await prepare(f, oldId)); // The replacement store is still empty.
        expect((await f.client.request('get_supported_actions')).data).toContain(
            'get_file_fragmented',
        );
        const newId = uploadedId(await upload(f, 'new.txt'));
        expect((await prepare(f, newId)).data).toEqual({
            name: 'new.txt',
            total_size: 5,
            sha256: SHA256,
        });

        for (const params of [
            { stage: 'prepare', file_id: newId },
            { stage: 'transfer', file_id: newId, offset: 1, size: 3 },
        ]) {
            failed(await old.options.handle({ action: 'get_file_fragmented', params }));
        }

        expect((await transfer(f, newId, 1, 3)).data).toEqual({ data: 'ZWxs' });
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it.each(['quiesce', 'forceClose'] as const)(
        'revokes both stages immediately on runtime %s through the saved callback',
        async (method) => {
            const f = await account('10001');
            const saved = f.transport();
            const id = uploadedId(await upload(f));
            f.runtime[method]();

            for (const params of [
                { stage: 'prepare', file_id: id },
                { stage: 'transfer', file_id: id, offset: 1, size: 3 },
            ]) {
                failed(await saved.options.handle({ action: 'get_file_fragmented', params }));
            }

            const actions = await saved.options.handle({
                action: 'get_supported_actions',
                params: {},
            });
            expect(actions.data).not.toContain('get_file_fragmented');
            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );

    it.each(['prepare', 'transfer'] as const)(
        'drops a successful %s provider result when that callback closes the runtime',
        async (stage) => {
            const f = await account('10001');
            const id = uploadedId(await upload(f));
            const closing: { promise?: Promise<void> } = {};
            let observedSuccess = false;
            let spy: { mockRestore(): void };

            if (stage === 'prepare') {
                const original = storeApi.V12UploadedDataStore.prototype.getMetadata;
                spy = vi
                    .spyOn(storeApi.V12UploadedDataStore.prototype, 'getMetadata')
                    .mockImplementation(function (this: V12UploadedDataStore, ...args) {
                        const result = original.apply(this, args);
                        observedSuccess = result.kind === 'ok';
                        closing.promise = f.runtime.close();
                        return result;
                    });
            } else {
                const original = storeApi.V12UploadedDataStore.prototype.getChunk;
                spy = vi
                    .spyOn(storeApi.V12UploadedDataStore.prototype, 'getChunk')
                    .mockImplementation(function (this: V12UploadedDataStore, ...args) {
                        const result = original.apply(this, args);
                        observedSuccess = result.kind === 'ok';
                        closing.promise = f.runtime.close();
                        return result;
                    });
            }

            try {
                const result =
                    stage === 'prepare' ? await prepare(f, id) : await transfer(f, id, 1, 3);
                expect(observedSuccess).toBe(true);
                expect(closing.promise).toBeDefined();
                failed(result);
                await closing.promise;
            } finally {
                spy.mockRestore();
            }

            await f.open();
            failed(await prepare(f, id));
            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );

    it.each(['prepare', 'transfer'] as const)(
        'fails closed when the %s disclosure guard reenters close and returns true',
        async (stage) => {
            const f = await account('10001');
            const id = uploadedId(await upload(f));
            const closing: { promise?: Promise<void> } = {};
            let guardEntered = false;
            let spy: { mockRestore(): void };

            const wrap = (guard: (() => boolean) | undefined) => () => {
                guardEntered = true;
                const allowed = guard?.() === true;
                closing.promise = f.runtime.close();
                return allowed;
            };

            if (stage === 'prepare') {
                const original = storeApi.V12UploadedDataStore.prototype.getMetadata;
                spy = vi
                    .spyOn(storeApi.V12UploadedDataStore.prototype, 'getMetadata')
                    .mockImplementation(function (this: V12UploadedDataStore, fileId, guard) {
                        return original.call(this, fileId, wrap(guard));
                    });
            } else {
                const original = storeApi.V12UploadedDataStore.prototype.getChunk;
                spy = vi
                    .spyOn(storeApi.V12UploadedDataStore.prototype, 'getChunk')
                    .mockImplementation(function (
                        this: V12UploadedDataStore,
                        fileId,
                        offset,
                        size,
                        guard,
                    ) {
                        return original.call(this, fileId, offset, size, wrap(guard));
                    });
            }

            try {
                const result =
                    stage === 'prepare' ? await prepare(f, id) : await transfer(f, id, 1, 3);
                expect(guardEntered).toBe(true);
                expect(closing.promise).toBeDefined();
                failed(result);
                await closing.promise;
            } finally {
                spy.mockRestore();
            }

            await f.open();
            failed(await prepare(f, id));
            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );

    it('suppresses provider exceptions and captured log plaintext for both stages', async () => {
        const f = await account('10001');
        const secretName = 'SYNTHETIC_PRIVATE_NAME_X731';
        const plaintext = 'SYNTHETIC_PRIVATE_BYTES_X732';
        const encoded = Buffer.from(plaintext).toString('base64');
        const echo = 'SYNTHETIC_PRIVATE_ECHO_X733';
        const exception = 'SYNTHETIC_PRIVATE_EXCEPTION_X734';
        const id = uploadedId(await upload(f, secretName, encoded));
        loggerApi.createLogger('fragmented-fixture').info('synthetic log capture control');
        expect(
            logEntries.some((entry) => entry.message.includes('synthetic log capture control')),
        ).toBe(true);
        expect((await prepare(f, id, echo)).retcode).toBe(0);
        expect((await transfer(f, id, 0, plaintext.length, echo)).retcode).toBe(0);
        const metadata = vi
            .spyOn(storeApi.V12UploadedDataStore.prototype, 'getMetadata')
            .mockImplementation(() => {
                throw new Error(exception);
            });
        const chunk = vi
            .spyOn(storeApi.V12UploadedDataStore.prototype, 'getChunk')
            .mockImplementation(() => {
                throw new Error(exception);
            });
        const prepareFailure = await prepare(f, id, echo);
        const transferFailure = await transfer(f, id, 0, 1, echo);
        failed(prepareFailure);
        failed(transferFailure);
        expect(prepareFailure.echo).toBe(echo);
        expect(transferFailure.echo).toBe(echo);
        expect(prepareFailure.message).not.toContain(exception);
        expect(transferFailure.message).not.toContain(exception);
        expect(metadata).toHaveBeenCalled();
        expect(chunk).toHaveBeenCalled();
        await f.runtime.close();
        const observed = JSON.stringify(logEntries);

        // Only the shared logger entries observed by this synthetic scenario are
        // covered; this is not a statement about unrelated callers or sinks.
        for (const marker of [secretName, plaintext, encoded, echo, exception, id]) {
            expect(observed).not.toContain(marker);
        }

        expect(f.api.handle).not.toHaveBeenCalled();
    });
});

describe('get_file_fragmented capability', () => {
    it('advertises only with both fragment callbacks and the local upload capability', async () => {
        const api = {
            handle: vi.fn(async () => ({ status: 'ok' as const, retcode: 0, data: null })),
        };
        const uploadProvider = vi.fn(() => ({ kind: 'unavailable' as const }));
        const dataProvider = vi.fn(() => ({ kind: 'unavailable' as const }));
        const metadataProvider = vi.fn(() => ({ kind: 'unavailable' as const }));
        const chunkProvider = vi.fn(() => ({ kind: 'unavailable' as const }));
        const base = {
            self: { platform: 'qq', user_id: '10001' },
            version: { impl: 'fixture', version: '1' },
            api,
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
        };

        for (const [uploadReady, dataReady, metadataReady, chunkReady, advertised] of [
            [false, false, false, false, false],
            [true, true, false, false, false],
            [true, true, true, false, false],
            [true, true, false, true, false],
            [false, true, true, true, false],
            [true, false, true, true, false],
            [true, true, true, true, true],
        ]) {
            const core = new dispatcherApi.V12Dispatcher({
                ...base,
                ...(uploadReady ? { uploadDataFile: uploadProvider } : {}),
                ...(dataReady ? { getUploadedDataFile: dataProvider } : {}),
                ...(metadataReady ? { getUploadedDataFileMetadata: metadataProvider } : {}),
                ...(chunkReady ? { getUploadedDataFileChunk: chunkProvider } : {}),
            });
            const result = await core.handle({
                action: 'get_supported_actions',
                params: {},
                echo: '',
            });
            expect(result).toMatchObject({ status: 'ok', retcode: 0, echo: '' });
            expect(Array.isArray(result.data)).toBe(true);
            const matches = (result.data as unknown[]).filter(
                (name) => name === 'get_file_fragmented',
            );
            expect(matches).toHaveLength(advertised ? 1 : 0);
        }

        const f = await account('10001');
        const actions = await f.client.request('get_supported_actions');
        expect(
            (actions.data as unknown[]).filter((name) => name === 'get_file_fragmented'),
        ).toHaveLength(1);
        expect(api.handle).not.toHaveBeenCalled();
        expect(uploadProvider).not.toHaveBeenCalled();
        expect(dataProvider).not.toHaveBeenCalled();
        expect(metadataProvider).not.toHaveBeenCalled();
        expect(chunkProvider).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('does not invoke or advertise a fragment callback accessor', async () => {
        const api = {
            handle: vi.fn(async () => ({ status: 'ok' as const, retcode: 0, data: null })),
        };
        const metadata = vi.fn(() => ({ kind: 'unavailable' as const }));
        const options = {
            self: { platform: 'qq', user_id: '10001' },
            version: { impl: 'fixture', version: '1' },
            api,
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
            uploadDataFile: () => ({ kind: 'unavailable' as const }),
            getUploadedDataFile: () => ({ kind: 'unavailable' as const }),
            getUploadedDataFileMetadata: metadata,
            getUploadedDataFileChunk: () => ({ kind: 'unavailable' as const }),
        };
        let reads = 0;
        Object.defineProperty(options, 'getUploadedDataFileMetadata', {
            configurable: true,
            get() {
                reads++;
                delete (options as { uploadDataFile?: unknown }).uploadDataFile;
                return metadata;
            },
        });
        const core = new dispatcherApi.V12Dispatcher(options);
        const result = await core.handle({ action: 'get_supported_actions', params: {} });
        expect(reads).toBe(0);
        expect(result.retcode).toBe(0);
        expect(result.data).not.toContain('get_file_fragmented');
        expect(metadata).not.toHaveBeenCalled();
        expect(api.handle).not.toHaveBeenCalled();
    });

    it('does not advertise after a readiness callback revokes its lease', async () => {
        let live = true;
        const api = {
            handle: vi.fn(async () => ({ status: 'ok' as const, retcode: 0, data: null })),
        };
        const readiness = vi.fn(() => {
            live = false;
            return true;
        });
        const core = new dispatcherApi.V12Dispatcher({
            self: { platform: 'qq', user_id: '10001' },
            version: { impl: 'fixture', version: '1' },
            api,
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
            isUploadDataSupported: readiness,
            uploadDataFile: () => ({ kind: 'unavailable' as const }),
            getUploadedDataFile: () => ({ kind: 'unavailable' as const }),
            getUploadedDataFileMetadata: () => ({ kind: 'unavailable' as const }),
            getUploadedDataFileChunk: () => ({ kind: 'unavailable' as const }),
        });
        const result = await core.handle(
            { action: 'get_supported_actions', params: {} },
            () => live,
        );
        expect(readiness).toHaveBeenCalled();
        expect(result.retcode).toBe(0);
        expect(result.data).not.toContain('get_file_fragmented');
        expect(api.handle).not.toHaveBeenCalled();
    });

    it('requires literal true from canAccept for both local file capabilities', async () => {
        const control: { value: unknown } = { value: true };
        const f = await account('10001', { canAccept: () => control.value as boolean });
        const id = uploadedId(await upload(f));
        const uploadCall = vi.spyOn(storeApi.V12UploadedDataStore.prototype, 'upload');
        const metadataCall = vi.spyOn(storeApi.V12UploadedDataStore.prototype, 'getMetadata');
        const chunkCall = vi.spyOn(storeApi.V12UploadedDataStore.prototype, 'getChunk');

        for (const invalid of [1, 'true', {}, Promise.resolve(false)]) {
            control.value = invalid;
            const unavailable = await f.client.request('get_supported_actions');
            expect(unavailable.retcode).toBe(0);
            expect(unavailable.data).not.toContain('upload_file');
            expect(unavailable.data).not.toContain('get_file_fragmented');
            failed(await upload(f));
            failed(await prepare(f, id));
            failed(await transfer(f, id, 1, 3));
            expect(uploadCall).not.toHaveBeenCalled();
            expect(metadataCall).not.toHaveBeenCalled();
            expect(chunkCall).not.toHaveBeenCalled();

            control.value = true;
            const available = await f.client.request('get_supported_actions');
            expect(available.data).toContain('upload_file');
            expect(available.data).toContain('get_file_fragmented');
            const freshId = uploadedId(await upload(f, 'recovered.txt'));
            expect((await prepare(f, freshId)).data).toEqual({
                name: 'recovered.txt',
                total_size: 5,
                sha256: SHA256,
            });
            expect((await transfer(f, id, 1, 3)).data).toEqual({ data: 'ZWxs' });
            uploadCall.mockClear();
            metadataCall.mockClear();
            chunkCall.mockClear();
        }

        expect(f.api.handle).not.toHaveBeenCalled();
    });
});

describe('real V12Transport authentication with only in-memory request/response fakes', () => {
    it('returns 401 before dispatch for a wrong token and accepts the correct path and token', async () => {
        const f = await account('10001');
        const id = uploadedId(await upload(f));
        const actual =
            await vi.importActual<typeof import('../../src/v12-network')>('../../src/v12-network');
        const handle = vi.fn((request: unknown) => f.transport().options.handle(request));
        const wire = new actual.V12Transport({
            host: 'fixture.invalid',
            port: 1,
            accessToken: TOKEN,
            handle,
            getConnectEvent: () => null,
            subscribe: () => () => {},
        });
        wire.attach();

        try {
            const wrong = new FakeRequest();
            wrong.rawHeaders = ['Authorization', 'Bearer synthetic-wrong'];
            const rejected = new FakeResponse();
            wire.handleRequest(
                wrong as unknown as IncomingMessage,
                rejected as unknown as ServerResponse,
            );
            expect(rejected.status).toBe(401);
            expect(rejected.writableEnded).toBe(true);
            expect(handle).not.toHaveBeenCalled();

            const missingPath = new FakeRequest();
            missingPath.url = '/not-the-action-path';
            missingPath.rawHeaders = ['Authorization', `Bearer ${TOKEN}`];
            const notFound = new FakeResponse();
            wire.handleRequest(
                missingPath as unknown as IncomingMessage,
                notFound as unknown as ServerResponse,
            );
            expect(notFound.status).toBe(404);
            expect(handle).not.toHaveBeenCalled();

            const good = new FakeRequest();
            good.rawHeaders = ['Authorization', `Bearer ${TOKEN}`];
            const response = new FakeResponse();
            wire.handleRequest(
                good as unknown as IncomingMessage,
                response as unknown as ServerResponse,
            );
            good.emit(
                'data',
                Buffer.from(
                    JSON.stringify({
                        action: 'get_file_fragmented',
                        params: { stage: 'transfer', file_id: id, offset: 1, size: 3 },
                        echo: '认证🪶',
                    }),
                ),
            );
            good.emit('end');
            await flushMicrotasks();
            expect(response.status).toBe(200);
            expect(response.destroyed).toBe(false);
            expect(response.body).toBeDefined();
            expect(JSON.parse(response.body!)).toEqual({
                status: 'ok',
                retcode: 0,
                data: { data: 'ZWxs' },
                message: '',
                echo: '认证🪶',
            });
            expect(handle).toHaveBeenCalledOnce();
            expect(f.api.handle).not.toHaveBeenCalled();
        } finally {
            await wire.close();
        }
    });
});
