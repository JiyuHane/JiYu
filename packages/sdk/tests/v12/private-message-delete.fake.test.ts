import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import { dirname } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OneBot12QQPrivateMessageDeleteEvent } from '../../src/v12/index.js';

// These are synthetic SDK inputs, not evidence of QQ delivery, origin or receipt.
// The injected HTTP fetch returns a Response in memory; no socket is opened.
const fixture = vi.hoisted(() => ({ attempts: [] as string[] }));

vi.mock('ws', () => {
    class ForbiddenWebSocket {
        constructor() {
            fixture.attempts.push('ws');
            throw new Error('unexpected WebSocket in private recall fixture');
        }
    }
    class ForbiddenWebSocketServer {
        constructor() {
            fixture.attempts.push('ws-server');
            throw new Error('unexpected WebSocket server in private recall fixture');
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

function forbidden(): never {
    throw new Error('unexpected network, native or process operation in private recall fixture');
}

beforeEach(async () => {
    fixture.attempts.length = 0;
    fetchGuard = vi.fn(forbidden);
    webSocketGuard = vi.fn(function ForbiddenGlobalWebSocket() {
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
    const dnsMethods = [
        'lookup',
        'lookupService',
        'resolve',
        'resolve4',
        'resolve6',
        'resolveAny',
        'resolveCaa',
        'resolveCname',
        'resolveMx',
        'resolveNaptr',
        'resolveNs',
        'resolvePtr',
        'resolveSoa',
        'resolveSrv',
        'resolveTxt',
        'reverse',
    ];

    for (const holder of [
        dns,
        dns.promises,
        dns.Resolver.prototype,
        dns.promises.Resolver.prototype,
    ]) {
        const methods = holder as unknown as Record<string, (...args: never[]) => unknown>;

        for (const method of dnsMethods) {
            if (typeof methods[method] === 'function') {
                guards.push(vi.spyOn(methods, method).mockImplementation(forbidden));
            }
        }
    }

    sdk = await import('../../src/v12/index.js');
});

afterEach(() => {
    const effects = guards.map((guard) => guard.mock.calls.length);
    const fetchCalls = fetchGuard.mock.calls.length;
    const webSocketCalls = webSocketGuard.mock.calls.length;
    const attempts = [...fixture.attempts];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    expect(effects).toEqual(effects.map(() => 0));
    expect(fetchCalls).toBe(0);
    expect(webSocketCalls).toBe(0);
    expect(attempts).toEqual([]);
});

const SELF = '10001';
const PEER = '20002';
const ECHO = 'synthetic-recall-echo-🪶';

const incoming: OneBot12QQPrivateMessageDeleteEvent = {
    id: 'fixture-recall-peer',
    time: 1_700_000_100.25,
    type: 'notice',
    detail_type: 'private_message_delete',
    sub_type: '',
    self: { platform: 'qq', user_id: SELF, 'x.self': { source: 'synthetic' } },
    message_id: '-2147483648',
    user_id: PEER,
    'x.event': { nested: ['synthetic', true, null] },
};
const outgoing: OneBot12QQPrivateMessageDeleteEvent = {
    ...incoming,
    id: 'fixture-recall-self',
    message_id: '-1',
    user_id: SELF,
};
const positiveBoundary: OneBot12QQPrivateMessageDeleteEvent = {
    ...incoming,
    id: 'fixture-recall-positive-boundary',
    message_id: '2147483647',
};
const futureSubtype = {
    ...incoming,
    id: 'fixture-future-subtype',
    sub_type: 'vendor.future',
    'x.future': { known: false, values: [1, 'two', null] },
};

// This is a virtual compiler input only. The package specifier is deliberately
// resolved to the source public v12 index, not directly to its private types.ts.
// A separately built package still needs its own declaration/packaging check.
const consumerSource = `
import type {
    OneBot12Event,
    OneBot12PlatformEvent,
    OneBot12QQPrivateMessageDeleteEvent,
} from '@harehane/sdk/v12';

type Assert<T extends true> = T;
type AssertFalse<T extends false> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;
type QQNotice = OneBot12QQPrivateMessageDeleteEvent;
type Sample = {
    id: string;
    time: number;
    type: 'notice';
    detail_type: 'private_message_delete';
    sub_type: '';
    self: { platform: 'qq'; user_id: string; 'x.self': { synthetic: true } };
    message_id: string;
    user_id: string;
    'x.notice': { nested: [boolean, null] };
};
type FutureGeneric = Omit<Sample, 'sub_type' | 'message_id' | 'self'> & {
    sub_type: 'vendor.future';
    message_id: number;
    self: { platform: 'other'; user_id: string };
};
export type ConsumerChecks = [
    Assert<Assignable<Sample, QQNotice>>,
    Assert<Assignable<QQNotice, OneBot12PlatformEvent>>,
    Assert<Assignable<QQNotice, OneBot12Event>>,
    Assert<Assignable<QQNotice['type'], 'notice'>>,
    Assert<Assignable<QQNotice['detail_type'], 'private_message_delete'>>,
    Assert<Assignable<QQNotice['sub_type'], ''>>,
    Assert<Assignable<QQNotice['self']['platform'], 'qq'>>,
    Assert<Assignable<QQNotice['self']['user_id'], string>>,
    Assert<Assignable<QQNotice['message_id'], string>>,
    Assert<Assignable<QQNotice['user_id'], string>>,
    Assert<Assignable<FutureGeneric, OneBot12Event>>,
    AssertFalse<Assignable<FutureGeneric, QQNotice>>,
    AssertFalse<Assignable<OneBot12PlatformEvent, QQNotice>>,
    AssertFalse<Assignable<Omit<Sample, 'message_id'>, QQNotice>>,
    AssertFalse<Assignable<Omit<Sample, 'user_id'>, QQNotice>>,
    AssertFalse<Assignable<Omit<Sample, 'self'>, QQNotice>>,
    AssertFalse<Assignable<Omit<Sample, 'message_id'> & { message_id: number }, QQNotice>>,
    AssertFalse<Assignable<Omit<Sample, 'user_id'> & { user_id: number }, QQNotice>>,
    AssertFalse<Assignable<Omit<Sample, 'self'> & { self: { platform: 'other'; user_id: string } }, QQNotice>>,
    AssertFalse<Assignable<Omit<Sample, 'sub_type'> & { sub_type: 'vendor.future' }, QQNotice>>,
    AssertFalse<Assignable<Sample & { 'x.invalid': () => void }, QQNotice>>
];
`;

function typecheckPublicConsumer(): void {
    const virtualFile = fileURLToPath(
        new URL('./__virtual_private_recall_consumer__.mts', import.meta.url),
    );
    const publicIndex = fileURLToPath(new URL('../../src/v12/index.ts', import.meta.url));
    const configFile = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
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
    const options: ts.CompilerOptions = {
        ...parsed.options,
        rootDir: undefined,
        noEmit: true,
        paths: { ...parsed.options.paths, '@harehane/sdk/v12': [publicIndex] },
    };
    const host = ts.createCompilerHost(options);
    const originalRead = host.readFile.bind(host);
    const originalExists = host.fileExists.bind(host);
    const originalSource = host.getSourceFile.bind(host);
    const normal = (path: string) => path.replace(/\\/g, '/').toLowerCase();
    const isVirtual = (path: string) => normal(path) === normal(virtualFile);
    host.fileExists = (path) => isVirtual(path) || originalExists(path);
    host.readFile = (path) => (isVirtual(path) ? consumerSource : originalRead(path));
    host.getSourceFile = (path, version, onError, shouldCreateNewSourceFile) =>
        isVirtual(path)
            ? ts.createSourceFile(path, consumerSource, version, true, ts.ScriptKind.TS)
            : originalSource(path, version, onError, shouldCreateNewSourceFile);

    host.writeFile = () => {
        throw new Error('typecheck must not emit files');
    };

    const program = ts.createProgram([virtualFile], options, host);
    const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
    const formatHost: ts.FormatDiagnosticsHost = {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: ts.sys.getCurrentDirectory,
        getNewLine: () => ts.sys.newLine,
    };
    expect(program.getSourceFile(publicIndex)).toBeDefined();
    expect(ts.formatDiagnostics(diagnostics, formatHost)).toBe('');
}

describe('Jiyu QQ private message deletion description and generic SDK codecs', () => {
    it('typechecks a consumer using the public v12 package entry without emitting files', () => {
        typecheckPublicConsumer();
    }, 30_000);

    it.each([incoming, outgoing, positiveBoundary])(
        'preserves signed message IDs, recalling party and extensions through event codecs',
        (event) => {
            const original = structuredClone(event);
            const fromObject = sdk.parseOneBot12Event(event);
            const fromJson = sdk.parseOneBot12EventJson(JSON.stringify(event));
            const serialized = sdk.serializeOneBot12Event(fromObject);
            expect(fromObject).toEqual(original);
            expect(fromJson).toEqual(original);
            expect(sdk.parseOneBot12EventJson(serialized)).toEqual(original);
            expect(JSON.parse(serialized)).toEqual(original);
            expect(fromObject.message_id).toBe(event.message_id);
            expect(typeof fromObject.message_id).toBe('string');
            expect(fromObject.user_id).toBe(event.user_id);
            expect(fromObject.self).toEqual(event.self);
            expect(fromObject['x.event']).toEqual(event['x.event']);
            expect(fromObject).not.toBe(event);
            expect(fromObject.self).not.toBe(event.self);
            expect(fromObject['x.event']).not.toBe(event['x.event']);
            expect(event).toEqual(original);
        },
    );

    it('preserves future subtypes and does not validate detail-specific fields or QQ origin', () => {
        const missingMessageId = { ...incoming } as Partial<OneBot12QQPrivateMessageDeleteEvent>;
        delete missingMessageId.message_id;
        const candidates = [
            futureSubtype,
            missingMessageId,
            { ...incoming, message_id: 42 },
            { ...incoming, user_id: null },
            { ...incoming, self: { ...incoming.self, platform: 'another-platform' } },
        ];

        for (const candidate of candidates) {
            expect(sdk.parseOneBot12Event(candidate)).toEqual(candidate);
            expect(sdk.parseOneBot12EventJson(JSON.stringify(candidate))).toEqual(candidate);
            expect(sdk.parseOneBot12EventJson(sdk.serializeOneBot12Event(candidate))).toEqual(
                candidate,
            );
        }
    });

    it('round trips both directions, future subtype, extensions and echo via injected HTTP polling', async () => {
        const data = [incoming, outgoing, positiveBoundary, futureSubtype];
        const envelope = {
            status: 'ok',
            retcode: 0,
            message: '',
            data,
            echo: ECHO,
            'x.response': { synthetic: true },
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
            { limit: 4, timeout: 0 },
            { self: incoming.self, echo: ECHO },
        );
        expect(result).toEqual(envelope);
        expect(result.echo).toBe(ECHO);
        expect(fakeFetch).toHaveBeenCalledOnce();
        const [url, init] = fakeFetch.mock.calls[0]!;
        expect(url).toBe('http://fixture.invalid/');
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('error');
        expect(JSON.parse(String(init?.body))).toEqual({
            action: 'get_latest_events',
            params: { limit: 4, timeout: 0 },
            self: incoming.self,
            echo: ECHO,
        });
    });

    it('keeps generic HTTP acceptance and echo matching independent of detail-specific fields', async () => {
        const genericOnly = { ...incoming, message_id: 42, user_id: null };
        const makeClient = (echo: string) =>
            new sdk.OneBot12HttpClient({
                baseUrl: 'http://fixture.invalid/',
                requestTimeoutMs: 0,
                fetch: async () =>
                    new Response(
                        JSON.stringify({
                            status: 'ok',
                            retcode: 0,
                            message: '',
                            data: [genericOnly],
                            echo,
                        }),
                    ),
            });
        expect(await makeClient(ECHO).getLatestEvents({}, { echo: ECHO })).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: [genericOnly],
            echo: ECHO,
        });
        await expect(
            makeClient('different-echo').getLatestEvents({}, { echo: ECHO }),
        ).rejects.toMatchObject({ code: 'invalid_response' });
    });
});
