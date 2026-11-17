import dgram from 'node:dgram';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import { dirname } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    OneBot12Message,
    OneBot12TextSegment,
    OneBot12VideoSegment,
} from '../../src/v12/index.js';

// Only the SDK codecs and an HTTP client using an injected in-memory fetch are
// exercised. No socket, listener, QQ account, native addon or server is started.
const forbidden = vi.hoisted(() => ({ attempts: [] as string[] }));
vi.mock('ws', () => {
    class ForbiddenWebSocket {
        constructor() {
            forbidden.attempts.push('ws');
            throw new Error('unexpected WebSocket in video fixture');
        }
    }
    class ForbiddenWebSocketServer {
        constructor() {
            forbidden.attempts.push('ws-server');
            throw new Error('unexpected WebSocket server in video fixture');
        }
    }
    return {
        default: ForbiddenWebSocket,
        WebSocket: ForbiddenWebSocket,
        WebSocketServer: ForbiddenWebSocketServer,
    };
});

let sdk: typeof import('../../src/v12/index.js');
let guards: Array<{ mock: { calls: unknown[] } }>;
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;

function blocked(): never {
    throw new Error('unexpected network or native operation in video fixture');
}

beforeEach(async () => {
    forbidden.attempts.length = 0;
    fetchGuard = vi.fn(blocked);
    webSocketGuard = vi.fn(function ForbiddenGlobalWebSocket() {
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
    sdk = await import('../../src/v12/index.js');
});

afterEach(() => {
    const calls = guards.map((guard) => guard.mock.calls.length);
    const fetchCalls = fetchGuard.mock.calls.length;
    const webSocketCalls = webSocketGuard.mock.calls.length;
    const attempts = [...forbidden.attempts];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    expect(calls).toEqual(calls.map(() => 0));
    expect(fetchCalls).toBe(0);
    expect(webSocketCalls).toBe(0);
    expect(attempts).toEqual([]);
});

const SELF = { platform: 'qq', user_id: '900719925474099301' };
const FILE_ID = 'synthetic-video-file-id';
const ECHO = '视频-echo-🪶';

function videoSegment(): OneBot12VideoSegment {
    return {
        type: 'video',
        data: { file_id: FILE_ID, 'x.video': { nested: ['original', true, null] } },
        'x.segment': { retained: true },
    };
}

function messageEvent() {
    const text: OneBot12TextSegment = { type: 'text', data: { text: '视频: ' } };
    const message: OneBot12Message = [text, videoSegment()];
    return {
        id: 'synthetic-video-event',
        time: 1_732_847_927.25,
        type: 'message',
        detail_type: 'group',
        sub_type: '',
        self: { ...SELF, 'x.self': { source: 'memory' } },
        message_id: '-123',
        user_id: '900719925474099302',
        group_id: '900719925474099303',
        message,
        alt_message: 'synthetic video event',
        'x.event': { nested: [1, true, null] },
    };
}

describe('OneBot 12 video type and generic codec with in-memory fixtures', () => {
    it('typechecks public source exports and the explicit consumer fixture in process', () => {
        // Source-index check only; package.test separately selects this fixture
        // when compiling freshly built declarations for package consumers.
        const testFile = fileURLToPath(import.meta.url);
        const configFile = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
        const fixtureFile = fileURLToPath(
            new URL('../fixtures/v12-video-types.mts', import.meta.url),
        );
        const publicIndex = fileURLToPath(new URL('../../src/v12/index.ts', import.meta.url));
        const config = ts.readConfigFile(configFile, ts.sys.readFile);

        if (config.error) {
            throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
        }

        const parsed = ts.parseJsonConfigFileContent(
            config.config,
            ts.sys,
            dirname(configFile),
            undefined,
            configFile,
        );
        const program = ts.createProgram([testFile, fixtureFile], {
            ...parsed.options,
            rootDir: undefined,
            noEmit: true,
            paths: { ...parsed.options.paths, '@harehane/sdk/v12': [publicIndex] },
        });
        const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
        const host: ts.FormatDiagnosticsHost = {
            getCanonicalFileName: (name) => name,
            getCurrentDirectory: ts.sys.getCurrentDirectory,
            getNewLine: () => ts.sys.newLine,
        };
        expect(ts.formatDiagnostics(diagnostics, host)).toBe('');
    }, 30_000);

    it('round trips an inbound video segment and JSON extensions without sharing snapshots', () => {
        const input = messageEvent();
        const original = structuredClone(input);
        const parsedSegment = sdk.parseOneBot12MessageSegment(input.message[1]);
        const parsed = sdk.parseOneBot12Event(input);
        const encoded = sdk.serializeOneBot12Event(parsed);
        const decoded = sdk.parseOneBot12EventJson(encoded);
        expect(parsedSegment).toEqual(input.message[1]);
        expect(parsed).toEqual(original);
        expect(decoded).toEqual(original);
        expect(JSON.parse(encoded)).toEqual(original);
        expect(input).toEqual(original);
        expect(parsed).not.toBe(input);
        expect(parsed.self).not.toBe(input.self);
        expect(parsed.message).not.toBe(input.message);
        expect(parsed['x.event']).not.toBe(input['x.event']);
        expect(parsedSegment).not.toBe(input.message[1]);

        const extension = parsed['x.event'] as { nested: Array<number | boolean | null> };
        extension.nested[0] = 2;
        expect(input).toEqual(original);
        expect(decoded).toEqual(original);
    });

    it('does not validate the video file_id or claim the segment-specific shape', () => {
        const base = messageEvent();

        for (const data of [
            {},
            { file_id: '' },
            { file_id: 42 },
            { file_id: null },
            { file_id: { nested: true } },
            { file_id: ['not', 'a', 'string'] },
            { file_id: 'v'.repeat(4097), extra: true },
        ]) {
            const segment = { type: 'video', data, 'x.segment': { kept: true } };
            const input = { ...base, message: [segment] };
            expect(sdk.parseOneBot12MessageSegment(segment)).toEqual(segment);
            expect(sdk.parseOneBot12Event(input)).toEqual(input);
            expect(sdk.parseOneBot12EventJson(sdk.serializeOneBot12Event(input))).toEqual(input);
        }
    });

    it('continues to reject invalid generic segment envelopes', () => {
        const base = messageEvent();

        for (const segment of [
            { type: 'video', data: null },
            { type: 'video', data: [] },
            { type: 'video', data: { type: 'nested', file_id: FILE_ID } },
            { type: 'video' },
            { data: { file_id: FILE_ID } },
            { type: 42, data: { file_id: FILE_ID } },
        ]) {
            expect(() => sdk.parseOneBot12MessageSegment(segment)).toThrow(TypeError);
            expect(() => sdk.parseOneBot12Event({ ...base, message: [segment] })).toThrow(
                TypeError,
            );
        }
    });

    it('retains video, JSON extensions, self and echo through fake HTTP polling', async () => {
        const event = messageEvent();
        const envelope = {
            status: 'ok',
            retcode: 0,
            message: '',
            data: [event],
            echo: ECHO,
            'x.response': { source: 'memory' },
        };
        const fakeFetch = vi.fn(
            async (_input: RequestInfo | URL, _init?: RequestInit) =>
                new Response(JSON.stringify(envelope), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const client = new sdk.OneBot12HttpClient({
            baseUrl: 'http://fixture.invalid/',
            fetch: fakeFetch,
            requestTimeoutMs: 0,
        });
        const result = await client.getLatestEvents(
            { limit: 1, timeout: 0 },
            { self: event.self, echo: ECHO },
        );
        expect(fakeFetch).toHaveBeenCalledOnce();
        expect(result).toEqual(envelope);

        if (result.status !== 'ok') {
            throw new Error('expected a synthetic successful poll');
        }

        expect(result.data[0].self).toEqual(event.self);
        expect(result.data[0].message).toEqual(event.message);
        expect(result.data[0]['x.event']).toEqual(event['x.event']);
        expect(result.echo).toBe(ECHO);
        const [url, init] = fakeFetch.mock.calls[0]!;
        expect(url).toBe('http://fixture.invalid/');
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('error');
        expect(JSON.parse(String(init?.body))).toEqual({
            action: 'get_latest_events',
            params: { limit: 1, timeout: 0 },
            self: event.self,
            echo: ECHO,
        });
    });

    it('preserves an invalid video file_id in generic HTTP event data', async () => {
        const event = {
            ...messageEvent(),
            message: [{ type: 'video', data: { file_id: 42, 'x.video': { retained: true } } }],
        };
        const envelope = { status: 'ok', retcode: 0, message: '', data: [event], echo: ECHO };
        const fakeFetch = vi.fn(async () => new Response(JSON.stringify(envelope)));
        const client = new sdk.OneBot12HttpClient({
            baseUrl: 'http://fixture.invalid/',
            fetch: fakeFetch,
            requestTimeoutMs: 0,
        });
        const result = await client.getLatestEvents({}, { self: SELF, echo: ECHO });
        expect(fakeFetch).toHaveBeenCalledOnce();
        expect(result).toEqual(envelope);

        if (result.status !== 'ok') {
            throw new Error('expected a synthetic successful poll');
        }

        expect(result.data[0].message).toEqual(event.message);
        expect(sdk.parseOneBot12Event(result.data[0])).toEqual(event);
    });
});
