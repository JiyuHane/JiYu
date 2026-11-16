import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V12TransportOptions } from '../../src/v12-network';

// No listener, outgoing socket, native addon, account, Core or plugin is started.
// The real runtime calls this in-memory transport's saved callbacks.
const fixture = vi.hoisted(() => ({
    transports: [] as Array<{ options: V12TransportOptions }>,
    forbiddenModules: [] as string[],
}));

vi.mock('../../src/v12-network', () => ({
    V12Transport: class {
        constructor(options: V12TransportOptions) {
            fixture.transports.push({ options });
        }
        async open() {}
        async close() {}
        quiesce() {}
        forceClose() {}
    },
}));

// Runtime only needs the shared base adapter. Avoid loading network adapters.
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

import { OneBot12HttpClient } from '../../../sdk/src/v12/http-client.js';
import { parseOneBot12EventJson } from '../../../sdk/src/v12/protocol.js';
import { EventPollBuffer } from '../../src/v12-runtime/event-poll-buffer';
import { V12_ADAPTER_NAME } from '../../src/v12-runtime/identity';
import { activateOrderedPollOwner, pollOwnerStats } from '../../src/v12-runtime/poll-owner';
import { V12Runtime } from '../../src/v12-runtime/runtime';
import {
    bindOrderedContext,
    captureBinding,
    installOrderedReady,
    prepareOrderedContext,
    reserveOrderedContext,
    SourceGeneration,
    withOrderedScope,
    type V12Source,
} from '../../src/v12-runtime/source-generation';
import { IOneBotNetworkAdapter } from '../../src/network/adapter';
import { OneBotNetworkManager } from '../../src/network/network-manager';
import { attachMessageMedia } from '../../src/message-media';
import type { DispatchPayload } from '../../src/event-filter';
import type { JsonObject, NetworkBase } from '../../src/types';

const PREFIX = 'jiyu-image:v1:';
const ENDPOINT = 'http://fixture.invalid/';
const URL_MARKER = 'SYNTHETIC_IMAGE_QUERY_SECRET_X731';
const IMAGE_URL = `https://media.example.invalid/photo.png?token=${URL_MARKER}&x=%2F`;
const OTHER_URL = 'https://media.example.invalid/other.png?token=other';
const LEGACY_URL = 'https://media.example.invalid/legacy.png';
const activeRuntimes: V12Runtime[] = [];

let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let networkGuards: Array<{ mock: { calls: unknown[] } }>;
let nativeGuard: { mock: { calls: unknown[] } };

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    fixture.transports.length = 0;
    fixture.forbiddenModules.length = 0;

    const blocked = () => {
        throw new Error('unexpected network or native operation');
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
        vi.spyOn(tls, 'createServer').mockImplementation(blocked),
        vi.spyOn(tls, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram, 'createSocket').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(blocked),
    ];
    nativeGuard = vi.spyOn(process, 'dlopen').mockImplementation(blocked);
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
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.clearAllTimers();
        vi.useRealTimers();
        expect(fetchCalls).toBe(0);
        expect(webSocketCalls).toBe(0);
        expect(networkCalls).toEqual(networkCalls.map(() => 0));
        expect(nativeCalls).toBe(0);
        expect(modules).toEqual([]);
    }
});

class V11Capture extends IOneBotNetworkAdapter<NetworkBase> {
    readonly frames: string[] = [];

    constructor(uin: string) {
        super(
            'fixture-v11',
            { name: 'fixture-v11', enabled: true, messageFormat: 'array', reportSelfMessage: true },
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
        return { name: this.name, kind: 'httpServer' as const, status: 'ok' as const, detail: '' };
    }
}

async function account(uin: string, options: { verifier?: boolean } = {}) {
    const generation = new SourceGeneration();
    const manager = new OneBotNetworkManager();
    const api = {
        handle: vi.fn(async (action: string, _params: JsonObject) => {
            if (action !== 'get_file') {
                throw new Error('unexpected legacy action');
            }

            return {
                status: 'ok' as const,
                retcode: 0,
                data: { file_name: 'legacy.png', url: LEGACY_URL },
            };
        }),
    };
    let runtime!: V12Runtime;
    runtime = new V12Runtime(
        {
            name: V12_ADAPTER_NAME,
            enabled: true,
            host: 'fixture.invalid',
            port: 1,
            accessToken: 'fixture-only-token',
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
            captureCurrentSource: () => generation.capture(runtime[captureBinding]()),
            ...(options.verifier === false
                ? {}
                : {
                      isSourceCurrent: (source: V12Source | undefined, binding: object | null) =>
                          manager.get(V12_ADAPTER_NAME) === runtime &&
                          generation.isCurrent(source, binding),
                  }),
        },
    );
    activeRuntimes.push(runtime);
    manager.register(runtime);
    const v11 = new V11Capture(uin);
    v11.open();
    manager.register(v11);
    generation.setOnline(true);
    let transport: { options: V12TransportOptions } | undefined;
    const wire: string[] = [];

    const open = async () => {
        await runtime.open();
        transport = fixture.transports.at(-1);

        if (!transport) {
            throw new Error('fake transport was not created');
        }

        // This is the fake WebSocket boundary: the production runtime supplies
        // the event and the fixture serializes it as a wire frame.
        transport.options.subscribe((event) => wire.push(JSON.stringify(event)));
        wire.length = 0; // Initial status is unrelated to message assertions.
    };

    await open();
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
    const client = new OneBot12HttpClient({
        baseUrl: ENDPOINT,
        fetch: fakeFetch,
        requestTimeoutMs: 0,
    });
    const ticket = () => generation.capture(runtime[captureBinding]());
    const emit = (event: JsonObject, source: V12Source | undefined = ticket()) =>
        manager.emitEvent(event, source);
    const messages = () =>
        wire
            .map((text) => parseOneBot12EventJson(text))
            .filter((event) => event.type === 'message');
    return {
        uin,
        generation,
        manager,
        runtime,
        api,
        v11,
        wire,
        client,
        fakeFetch,
        open,
        ticket,
        emit,
        messages,
    };
}

function image(url = IMAGE_URL): JsonObject {
    return {
        type: 'image',
        data: { file: 'synthetic-file-id', url, sub_type: 0, summary: '[图片]' },
    };
}

function message(uin: string, detail: 'private' | 'group', picture = image()): JsonObject {
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
            picture,
            { type: 'text', data: { text: 'after' } },
        ],
    };
}

function fileId(
    event: ReturnType<Awaited<ReturnType<typeof account>>['messages']>[number],
): string {
    const segments = event.message;

    if (!Array.isArray(segments)) {
        throw new Error('message array missing');
    }

    const segment = segments[2];

    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
        throw new Error('image segment missing');
    }

    const data = segment.data;

    if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        typeof data.file_id !== 'string'
    ) {
        throw new Error('image file_id missing');
    }

    return data.file_id;
}

async function getFile(f: Awaited<ReturnType<typeof account>>, id: string, echo = 'file') {
    return f.client.request(
        'get_file',
        { file_id: id, type: 'url' },
        { self: { platform: 'qq', user_id: f.uin }, echo },
    );
}

describe('inbound image through the real v12 runtime with fake transports', () => {
    it.each(['private', 'group'] as const)(
        'preserves %s segment order and resolves the sealed URL repeatedly via the SDK',
        async (detail) => {
            const f = await account('10001');
            const input = message(f.uin, detail);
            const before = structuredClone(input);
            const source = f.ticket();
            expect(source).toBeDefined();
            await f.emit(input, source);
            expect(f.messages()).toHaveLength(1);
            const event = f.messages()[0]!;
            const id = fileId(event);
            expect(id.startsWith(PREFIX)).toBe(true);
            expect(id.length).toBeLessThanOrEqual(4096);
            expect(event).toMatchObject({
                self: { platform: 'qq', user_id: f.uin },
                detail_type: detail,
                message_id: '-123',
                user_id: '20001',
                ...(detail === 'group' ? { group_id: '40001' } : {}),
                alt_message: 'before@30001[图片]after',
                message: [
                    { type: 'text', data: { text: 'before' } },
                    { type: 'mention', data: { user_id: '30001' } },
                    { type: 'image', data: { file_id: id } },
                    { type: 'text', data: { text: 'after' } },
                ],
            });
            expect(JSON.stringify(event)).not.toContain(IMAGE_URL);
            expect(JSON.stringify(event)).not.toContain(URL_MARKER);
            expect(input).toEqual(before);
            expect(f.v11.frames.map((frame) => JSON.parse(frame))).toEqual([before]);
            expect(await getFile(f, id, 'first')).toEqual({
                status: 'ok',
                retcode: 0,
                data: { name: '', url: IMAGE_URL },
                message: '',
                echo: 'first',
            });
            expect(await getFile(f, id, 'second')).toEqual({
                status: 'ok',
                retcode: 0,
                data: { name: '', url: IMAGE_URL },
                message: '',
                echo: 'second',
            });
            expect(f.fakeFetch).toHaveBeenCalledTimes(2);
            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );

    it('accepts a real persistence-only media symbol without exposing it on the v12 wire', async () => {
        const f = await account('10001');
        const picture = image();
        attachMessageMedia(picture, {
            type: 'image',
            fileId: 'synthetic-file-id',
            imageUrl: IMAGE_URL,
        });
        expect(Object.getOwnPropertySymbols(picture)).toHaveLength(1);
        const input = message(f.uin, 'group', picture);
        await f.emit(input, f.ticket());
        expect(f.messages()).toHaveLength(1);
        const wire = f.wire.join('');
        expect(wire).not.toContain(IMAGE_URL);
        expect(wire).not.toContain(URL_MARKER);
        expect((await getFile(f, fileId(f.messages()[0]!))).data).toEqual({
            name: '',
            url: IMAGE_URL,
        });
    });

    it('accepts an empty summary and seals the observed URL against later input mutation', async () => {
        const f = await account('10001');
        const picture = image();
        const data = picture.data as JsonObject;
        data.summary = '';
        const input = message(f.uin, 'private', picture);
        await f.emit(input, f.ticket());
        expect(f.messages()).toHaveLength(1);
        const event = f.messages()[0]!;
        expect(event.alt_message).toBe('before@30001[图片]after');
        const id = fileId(event);
        data.url = OTHER_URL;
        expect((await getFile(f, id)).data).toEqual({ name: '', url: IMAGE_URL });
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('keeps its key across close and reopen of the same runtime, but rotates the source binding', async () => {
        const f = await account('10001');
        const oldTicket = f.ticket()!;
        await f.emit(message(f.uin, 'private'), oldTicket);
        const id = fileId(f.messages()[0]!);
        await f.runtime.close();
        await f.open();
        f.wire.length = 0;
        const nextTicket = f.ticket()!;
        expect(nextTicket).toBeDefined();
        expect(f.runtime[captureBinding]()).not.toBeNull();
        await f.emit(message(f.uin, 'private'), oldTicket);
        expect(f.messages()).toEqual([]);
        expect((await getFile(f, id)).data).toEqual({ name: '', url: IMAGE_URL });
        await f.emit(message(f.uin, 'group', image(OTHER_URL)), nextTicket);
        expect(f.messages()).toHaveLength(1);
        expect((await getFile(f, fileId(f.messages()[0]!))).data).toEqual({
            name: '',
            url: OTHER_URL,
        });
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('separates two accounts and a new runtime for the same account', async () => {
        const a = await account('10001');
        const b = await account('10002');
        const anotherA = await account('10001');
        await a.emit(message(a.uin, 'private'), a.ticket());
        const id = fileId(a.messages()[0]!);
        expect((await getFile(a, id)).data).toEqual({ name: '', url: IMAGE_URL });

        for (const other of [b, anotherA]) {
            const result = await getFile(other, id);
            expect(result).toMatchObject({ status: 'failed', retcode: 20001, data: null });
            expect(other.api.handle).not.toHaveBeenCalled();
        }

        expect(
            await a.client.request(
                'get_file',
                { file_id: id, type: 'url' },
                { self: { platform: 'qq', user_id: b.uin } },
            ),
        ).toMatchObject({ status: 'failed', retcode: 10102, data: null });
        expect(a.api.handle).not.toHaveBeenCalled();
        await b.emit(message(b.uin, 'group', image(OTHER_URL)), b.ticket());
        expect((await getFile(b, fileId(b.messages()[0]!))).data).toEqual({
            name: '',
            url: OTHER_URL,
        });
        await a.emit(message(a.uin, 'group'), b.ticket());
        expect(a.messages()).toHaveLength(1);
    });

    it('rejects reserved, malformed and altered IDs without falling back to a legacy alias', async () => {
        const f = await account('10001');
        await f.emit(message(f.uin, 'private'), f.ticket());
        const id = fileId(f.messages()[0]!);
        const position = PREFIX.length + 2;
        const tampered =
            id.slice(0, position) + (id[position] === 'A' ? 'B' : 'A') + id.slice(position + 1);

        for (const invalid of [PREFIX, `${PREFIX}legacy`, `${PREFIX}%%%`, tampered]) {
            const result = await getFile(f, invalid);
            expect(result).toMatchObject({ status: 'failed', retcode: 20001, data: null });
            expect(JSON.stringify(result)).not.toContain(URL_MARKER);
        }

        expect(f.api.handle).not.toHaveBeenCalled();
        const legacy = await getFile(f, 'ordinary-legacy-alias', 'legacy');
        expect(legacy).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: { name: 'legacy.png', url: LEGACY_URL },
            echo: 'legacy',
        });
        expect(f.api.handle).toHaveBeenCalledExactlyOnceWith('get_file', {
            file_id: 'ordinary-legacy-alias',
        });
    });

    it('rejects no ticket, expired online epochs, and missing source verification while text stays independent', async () => {
        const f = await account('10001');
        const oldTicket = f.ticket()!;
        await f.manager.emitEvent(message(f.uin, 'private'));
        expect(f.messages()).toEqual([]);
        f.generation.setOnline(false);
        await f.emit(message(f.uin, 'private'), oldTicket);
        expect(f.messages()).toEqual([]);
        f.generation.setOnline(true);
        await f.emit(message(f.uin, 'private'), oldTicket);
        expect(f.messages()).toEqual([]);
        await f.emit(message(f.uin, 'private'), f.ticket());
        expect(f.messages()).toHaveLength(1);
        const textOnly = message(f.uin, 'private');
        textOnly.message = [{ type: 'text', data: { text: 'legacy text' } }];
        await f.manager.emitEvent(textOnly);
        expect(f.messages()).toHaveLength(2);
        expect(f.messages()[1]).toMatchObject({
            message: [{ type: 'text', data: { text: 'legacy text' } }],
        });

        const issued = fileId(f.messages()[0]!);
        f.generation.setOnline(false);
        f.generation.setOnline(true);
        expect((await getFile(f, issued)).data).toEqual({ name: '', url: IMAGE_URL });

        const noVerifier = await account('10002', { verifier: false });
        await noVerifier.emit(message(noVerifier.uin, 'private'), noVerifier.ticket());
        expect(noVerifier.messages()).toEqual([]);
        expect(noVerifier.api.handle).not.toHaveBeenCalled();
    });

    it('fails the whole inbound message for flash, mface and unsupported image fields', async () => {
        const f = await account('10001');
        const invalid: JsonObject[] = [
            {
                type: 'image',
                data: { file: 'x', url: IMAGE_URL, sub_type: 0, summary: '[图片]', type: 'flash' },
            },
            {
                type: 'image',
                data: {
                    file: 'x',
                    url: IMAGE_URL,
                    sub_type: 0,
                    summary: '[图片]',
                    emoji_id: 'x',
                    emoji_package_id: 1,
                    key: 'x',
                },
            },
            {
                type: 'image',
                data: { file: 'x', url: IMAGE_URL, sub_type: 1, summary: '[动画表情]' },
            },
            {
                type: 'image',
                data: { file: 'x', url: IMAGE_URL, sub_type: 0, summary: 'custom caption' },
            },
            { type: 'image', data: { file: 'x', url: '', sub_type: 0, summary: '' } },
            {
                type: 'image',
                data: { file: 'x', url: 'file:///fixture', sub_type: 0, summary: '' },
            },
            {
                type: 'image',
                data: {
                    file: 'x',
                    url: `https://fixture.invalid/${'a'.repeat(3001)}`,
                    sub_type: 0,
                    summary: '',
                },
            },
            {
                type: 'image',
                data: { file: 'x', url: IMAGE_URL, sub_type: 0, summary: '', extra: false },
            },
            { type: 'image', data: { file: 'x' } },
        ];

        for (const picture of invalid) {
            await f.emit(message(f.uin, 'group', picture), f.ticket());
            expect(f.messages()).toEqual([]);
        }

        // A valid image before an unsupported later segment must not turn into
        // a partially delivered event.
        const mixed = message(f.uin, 'group');
        (mixed.message as JsonObject[]).push({ type: 'reply', data: { id: '-1' } });
        await f.emit(mixed, f.ticket());
        expect(f.messages()).toEqual([]);

        const selfSent = message(f.uin, 'group');
        selfSent.post_type = 'message_sent';
        selfSent.user_id = Number(f.uin);
        await f.emit(selfSent, f.ticket());
        expect(f.messages()).toEqual([]);
        expect(f.v11.frames).toHaveLength(invalid.length + 2);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it.each(['quiesce', 'forceClose'] as const)(
        'revokes the image key on %s, including when a saved fake callback is invoked',
        async (method) => {
            const f = await account('10001');
            const source = f.ticket()!;
            await f.emit(message(f.uin, 'private'), source);
            const id = fileId(f.messages()[0]!);
            f.runtime[method]();
            await f.emit(message(f.uin, 'private'), source);
            expect(f.messages()).toHaveLength(1);
            // The fake HTTP callback deliberately bypasses transport admission;
            // this assertion concerns key revocation, not a live endpoint.
            expect(await getFile(f, id)).toMatchObject({
                status: 'failed',
                retcode: 20001,
                data: null,
            });
            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );

    it('admits a source-verified image into the explicitly activated in-process ordered poll fixture', async () => {
        const f = await account('10001');
        const activation = activateOrderedPollOwner(f.runtime);
        expect(activation.status).toBe('ready');

        if (activation.status !== 'ready') {
            throw new Error('ordered fixture unavailable');
        }

        const context = {};
        prepareOrderedContext(context, f.runtime);
        expect(installOrderedReady(context, f.runtime, activation.owner)).not.toBeNull();
        const source = f.ticket()!;
        const admission = bindOrderedContext(context, reserveOrderedContext(context), source, true);
        expect(admission.kind).toBe('eligible');
        const queued = vi.spyOn(EventPollBuffer.prototype, 'enqueue');
        const input = message(f.uin, 'private');
        await withOrderedScope(f.manager, 'manager', input, admission, () =>
            f.manager.emitEvent(input, source),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(f.messages()).toHaveLength(1);
        expect(queued).toHaveBeenCalledOnce();
        expect(queued.mock.calls[0]![0]).toMatchObject({
            type: 'message',
            message: [
                { type: 'text', data: { text: 'before' } },
                { type: 'mention', data: { user_id: '30001' } },
                { type: 'image', data: { file_id: fileId(f.messages()[0]!) } },
                { type: 'text', data: { text: 'after' } },
            ],
        });
        expect(JSON.stringify(queued.mock.calls[0]![0])).not.toContain(URL_MARKER);
        expect(pollOwnerStats(f.runtime)).toMatchObject({ accepted: 1, ordering_gap: false });
        // Explicit fixture activation does not wire production HTTP polling.
        expect(await f.client.getLatestEvents()).toMatchObject({
            status: 'failed',
            retcode: 10002,
        });
        activation.owner.invalidate();
    });

    it('does not enqueue or fan out an image whose ticket expires after poll admission', async () => {
        const f = await account('10001');
        const activation = activateOrderedPollOwner(f.runtime);
        expect(activation.status).toBe('ready');

        if (activation.status !== 'ready') {
            throw new Error('ordered fixture unavailable');
        }

        const context = {};
        prepareOrderedContext(context, f.runtime);
        expect(installOrderedReady(context, f.runtime, activation.owner)).not.toBeNull();
        const source = f.ticket()!;
        const admission = bindOrderedContext(context, reserveOrderedContext(context), source, true);
        expect(admission.kind).toBe('eligible');
        const queued = vi.spyOn(EventPollBuffer.prototype, 'enqueue');
        f.generation.setOnline(false);
        f.generation.setOnline(true);
        const input = message(f.uin, 'private');
        await withOrderedScope(f.manager, 'manager', input, admission, () =>
            f.manager.emitEvent(input, source),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(queued).not.toHaveBeenCalled();
        expect(f.messages()).toEqual([]);
        expect(pollOwnerStats(f.runtime)?.accepted).toBe(0);
        activation.owner.invalidate();
    });
});
