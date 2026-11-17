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
import type { OneBot12JsonObject, OneBot12QQGroupNameChangeEvent } from '../../src/v12/index.js';

// This suite constructs only the SDK HTTP client with an in-memory fetch fake.
// It does not construct a WebSocket, bind a listener, or contact an account.
const forbidden = vi.hoisted(() => ({ attempts: [] as string[] }));
vi.mock('ws', () => {
    class ForbiddenWebSocket {
        constructor() {
            forbidden.attempts.push('ws');
            throw new Error('unexpected WebSocket in group-name fixture');
        }
    }
    class ForbiddenWebSocketServer {
        constructor() {
            forbidden.attempts.push('ws-server');
            throw new Error('unexpected WebSocket server in group-name fixture');
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
    throw new Error('unexpected network or native operation in group-name fixture');
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
    // The public entry is loaded only after these guards are active.
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
const GROUP_ID = '900719925474099302';
const OPERATOR_ID = '900719925474099303';
const ECHO = '群名-echo-🪶';

function eventWithOperator(): OneBot12QQGroupNameChangeEvent {
    return {
        id: 'synthetic-group-name-event-1',
        time: 1_732_847_927.25,
        type: 'notice',
        detail_type: 'qq.group_name_change',
        sub_type: '',
        self: { ...SELF, 'x.self': { active: true } },
        group_id: GROUP_ID,
        group_name: '新的群名 🪶',
        operator_id: OPERATOR_ID,
        'x.fixture': { nested: ['original', true, null] },
    };
}

function eventWithoutOperator(): OneBot12QQGroupNameChangeEvent {
    return {
        id: 'synthetic-group-name-event-2',
        time: 1_732_847_928,
        type: 'notice',
        detail_type: 'qq.group_name_change',
        sub_type: '',
        self: { ...SELF },
        group_id: GROUP_ID,
        group_name: '',
        'x.fixture': { source: 'synthetic' },
    };
}

describe('OneBot 12 custom group-name event in isolated SDK fixtures', () => {
    it('typechecks the public index and the type-only consumer fixture in process', () => {
        // The ordinary SDK tsconfig includes src only. As in voice-types, add
        // this test and the explicit type-only fixture to a no-emit program.
        // The package specifier is mapped to source, so this is not an installed
        // package/export-map test and does not execute a compiler command.
        const testFile = fileURLToPath(import.meta.url);
        const configFile = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
        const fixtureFile = fileURLToPath(
            new URL('../fixtures/v12-group-name-types.mts', import.meta.url),
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

    it.each([true, false])('round trips the notice with operator present: %s', (withOperator) => {
        const input = withOperator ? eventWithOperator() : eventWithoutOperator();
        const original = structuredClone(input);
        const parsed = sdk.parseOneBot12Event(input);
        const encoded = sdk.serializeOneBot12Event(parsed);
        const decoded = sdk.parseOneBot12EventJson(encoded);
        expect(parsed).toEqual(original);
        expect(decoded).toEqual(original);
        expect(JSON.parse(encoded)).toEqual(original);
        expect(input).toEqual(original);
        expect(parsed).not.toBe(input);
        expect(parsed.self).not.toBe(input.self);
        expect(parsed['x.fixture']).not.toBe(input['x.fixture']);
        expect(parsed.group_id).toBe(GROUP_ID);
        expect(parsed.group_name).toBe(input.group_name);
        expect(Object.hasOwn(parsed, 'operator_id')).toBe(withOperator);

        if (withOperator) {
            expect(parsed.operator_id).toBe(OPERATOR_ID);
        } else {
            expect(decoded.operator_id).toBeUndefined();
        }
    });

    it('snapshots nested extension fields without mutating the caller event', () => {
        const input = eventWithOperator();
        const original = structuredClone(input);
        const parsed = sdk.parseOneBot12Event(input);
        const extension = parsed['x.fixture'] as { nested: Array<string | boolean | null> };
        extension.nested[0] = 'modified-output';
        expect(input).toEqual(original);
        expect(parsed['x.fixture']).not.toEqual(original['x.fixture']);
    });

    it('retains invalid detail-specific JSON values without claiming they were validated', () => {
        const base = eventWithOperator();
        const missing: OneBot12JsonObject = { ...base };
        delete missing.group_name;
        delete missing.operator_id;
        const candidates = [
            { ...base, group_name: 42, operator_id: null },
            { ...base, group_name: null, operator_id: 42 },
            { ...base, group_name: { nested: [true, 'unknown'] }, operator_id: ['not-an-id'] },
            { ...base, group_id: 123, group_name: false, operator_id: { unknown: true } },
            { ...base, sub_type: 'extension-subtype' },
            missing,
        ];

        for (const input of candidates) {
            const parsed = sdk.parseOneBot12Event(input);
            expect(parsed).toEqual(input);
            expect(sdk.parseOneBot12EventJson(JSON.stringify(input))).toEqual(input);
            expect(sdk.parseOneBot12EventJson(sdk.serializeOneBot12Event(parsed))).toEqual(input);
        }

        // These are generic parsed events, not OneBot12QQGroupNameChangeEvent
        // values: the latter is a static description of valid dedicated fields.
        const malformed = sdk.parseOneBot12Event(candidates[0]);
        expect(malformed.group_name).toBe(42);
        expect(malformed.operator_id).toBeNull();
    });

    it('still rejects invalid common event headers', () => {
        const base = eventWithOperator();

        for (const invalid of [
            { ...base, id: 42 },
            { ...base, time: 'not-a-number' },
            { ...base, type: 'other' },
            { ...base, detail_type: 17 },
            { ...base, sub_type: null },
            { ...base, self: null },
            { ...base, self: { platform: 'qq', user_id: 7 } },
        ]) {
            expect(() => sdk.parseOneBot12Event(invalid)).toThrow(TypeError);
        }
    });

    it('retains event extensions, self and echo through an in-memory HTTP poll', async () => {
        const withOperator = eventWithOperator();
        const withoutOperator = eventWithoutOperator();
        const envelope = {
            status: 'ok',
            retcode: 0,
            message: '',
            data: [withOperator, withoutOperator],
            echo: ECHO,
            'x.response': { source: 'memory' },
        };
        const fetchImpl = vi.fn(
            async (_input: RequestInfo | URL, _init?: RequestInit) =>
                new Response(JSON.stringify(envelope), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const client = new sdk.OneBot12HttpClient({
            baseUrl: 'http://fixture.invalid/',
            fetch: fetchImpl,
            requestTimeoutMs: 0,
        });
        const result = await client.getLatestEvents(
            { limit: 2, timeout: 0 },
            { self: withOperator.self, echo: ECHO },
        );
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(result).toEqual(envelope);

        if (result.status !== 'ok') {
            throw new Error('expected the synthetic successful response');
        }

        expect(result.data[0].self).toEqual(withOperator.self);
        expect(result.data[0].group_id).toBe(GROUP_ID);
        expect(result.data[0].group_name).toBe('新的群名 🪶');
        expect(result.data[0].operator_id).toBe(OPERATOR_ID);
        expect(result.data[0]['x.fixture']).toEqual(withOperator['x.fixture']);
        expect(Object.hasOwn(result.data[1], 'operator_id')).toBe(false);
        expect(result.data[1].group_name).toBe('');
        expect(result.echo).toBe(ECHO);
        const [url, init] = fetchImpl.mock.calls[0]!;
        expect(url).toBe('http://fixture.invalid/');
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('error');
        expect(JSON.parse(String(init?.body))).toEqual({
            action: 'get_latest_events',
            params: { limit: 2, timeout: 0 },
            self: withOperator.self,
            echo: ECHO,
        });
    });

    it('preserves malformed detail fields through generic HTTP polling too', async () => {
        const malformed = {
            ...eventWithOperator(),
            group_name: 42,
            operator_id: { unresolved: true },
        };
        const envelope = { status: 'ok', retcode: 0, message: '', data: [malformed], echo: ECHO };
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify(envelope)));
        const client = new sdk.OneBot12HttpClient({
            baseUrl: 'http://fixture.invalid/',
            fetch: fetchImpl,
            requestTimeoutMs: 0,
        });
        const result = await client.getLatestEvents({}, { self: SELF, echo: ECHO });
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(result).toEqual(envelope);

        if (result.status !== 'ok') {
            throw new Error('expected the synthetic successful response');
        }

        expect(result.data[0].group_name).toBe(42);
        expect(result.data[0].operator_id).toEqual({ unresolved: true });
    });
});
