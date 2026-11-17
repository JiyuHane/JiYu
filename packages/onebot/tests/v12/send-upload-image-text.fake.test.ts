import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { format } from 'node:util';
import workerThreads from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompiledActionRegistry } from '../../src/actions';
import type { ActionHandler, ActionRecord, ApiActionContext } from '../../src/api-handler';
import type { ApiResponse, JsonObject } from '../../src/types';
import type { V12CoreOptions, V12FileLease, V12Response } from '../../src/v12/types';
import type { V12ReadUploadResult, V12UploadedDataStore } from '../../src/v12/uploaded-data-store';

// Real dispatcher, local store, ApiHandler, SDK client and v11 parser. The
// registered actions, fetch, listener tickets and clock are in-memory fakes;
// none of these tests constructs Core, a bridge, a transport or an account.
const capture = vi.hoisted(() => ({
    logs: [] as Array<{ level: string; message: string }>,
    forbidden: [] as string[],
    onLog: null as null | ((entry: { level: string; message: string }) => void),
}));

vi.mock('../../src/actions', () => ({
    ACTION_REGISTRY: {
        rawActions: [],
        bind: () => {
            throw new Error('unexpected default action registry');
        },
    },
    HANDLE_QUICK_OPERATION_ACTION: '.handle_quick_operation',
}));
vi.mock('@snowluma/sqlite', () => {
    capture.forbidden.push('sqlite');
    throw new Error('unexpected SQLite module');
});
vi.mock('@snowluma/websocket', () => {
    capture.forbidden.push('websocket');
    throw new Error('unexpected WebSocket module');
});
vi.mock('@snowluma/core/bridge-interface', () => {
    capture.forbidden.push('core');
    throw new Error('unexpected Core module');
});
vi.mock('@snowluma/common/logger', () => {
    const write = (level: string, args: unknown[]): void => {
        const rendered = typeof args[0] === 'function' ? (args[0] as () => unknown[])() : args;
        const entry = { level, message: format(rendered[0], ...rendered.slice(1)) };
        capture.logs.push(entry);
        capture.onLog?.(entry);
    };

    const logger = {
        trace: (...args: unknown[]) => write('trace', args),
        debug: (...args: unknown[]) => write('debug', args),
        info: (...args: unknown[]) => write('info', args),
        success: (...args: unknown[]) => write('success', args),
        warn: (...args: unknown[]) => write('warn', args),
        error: (...args: unknown[]) => write('error', args),
        child: () => logger,
    };
    return { createLogger: () => logger, runWithTraceRequest: <T>(fn: () => T): T => fn() };
});

const SELF = { platform: 'qq', user_id: '10001' };
const TARGETS = { private: '2948317061', group: '2948317062' } as const;
const ECHO = 'synthetic-text-image-echo';
const NAME = 'SYNTHETIC_MIXED_IMAGE_NAME_327a';
const TEXT = 'SYNTHETIC_MIXED_TEXT_🪶[CQ:at,qq=99]\n尾';
const SECRET = 'SYNTHETIC_MIXED_ERROR_68bc';
const RESPONSE_SECRET = 'SYNTHETIC_MIXED_RESPONSE_a831';
const BYTES = Buffer.from([0, 255, 1, 2, 3, 128, 47, 92, 13, 10]);
const DATA = BYTES.toString('base64');
const PREFIX = 'jiyu-upload:v1:';
const MESSAGE_ID = -2147483648;
const TIME = 1700000000;
const ENDPOINT = 'http://fixture.invalid/';
type Scene = 'private' | 'group';
type Guard = { mock: { calls: unknown[] } };

let ApiHandler: typeof import('../../src/api-handler').ApiHandler;
let V12Dispatcher: typeof import('../../src/v12/dispatcher').V12Dispatcher;
let UploadedDataStore: typeof import('../../src/v12/uploaded-data-store').V12UploadedDataStore;
let OneBot12HttpClient: typeof import('../../../sdk/src/v12/http-client.js').OneBot12HttpClient;
let parseMessage: typeof import('../../src/message-parser').parseMessage;
let guards: Guard[];
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let stores: V12UploadedDataStore[];
let randomSequence: number;

function blocked(): never {
    throw new Error('unexpected external effect in synthetic image-text fixture');
}

beforeEach(async () => {
    capture.logs.length = 0;
    capture.forbidden.length = 0;
    capture.onLog = null;
    stores = [];
    randomSequence = 0;
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
        vi.spyOn(childProcess, 'spawn').mockImplementation(blocked),
        vi.spyOn(childProcess, 'spawnSync').mockImplementation(blocked),
        vi.spyOn(childProcess, 'exec').mockImplementation(blocked),
        vi.spyOn(childProcess, 'execSync').mockImplementation(blocked),
        vi.spyOn(childProcess, 'execFile').mockImplementation(blocked),
        vi.spyOn(childProcess, 'execFileSync').mockImplementation(blocked),
        vi.spyOn(childProcess, 'fork').mockImplementation(blocked),
        vi.spyOn(workerThreads, 'Worker').mockImplementation(blocked),
        vi.spyOn(process, 'dlopen').mockImplementation(blocked),
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
                guards.push(vi.spyOn(methods, method).mockImplementation(blocked));
            }
        }
    }

    // All effect guards precede module loading; parser and element manifest are real.
    ({ ApiHandler } = await import('../../src/api-handler'));
    ({ V12Dispatcher } = await import('../../src/v12/dispatcher'));
    ({ V12UploadedDataStore: UploadedDataStore } =
        await import('../../src/v12/uploaded-data-store'));
    ({ OneBot12HttpClient } = await import('../../../sdk/src/v12/http-client.js'));
    ({ parseMessage } = await import('../../src/message-parser'));
});

afterEach(() => {
    capture.onLog = null;

    for (const store of stores) {
        store.close();
    }

    const calls = guards.map((guard) => guard.mock.calls.length);
    const fetchCalls = fetchGuard.mock.calls.length;
    const websocketCalls = webSocketGuard.mock.calls.length;
    const forbidden = [...capture.forbidden];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    expect(calls).toEqual(calls.map(() => 0));
    expect(fetchCalls).toBe(0);
    expect(websocketCalls).toBe(0);
    expect(forbidden).toEqual([]);
});

function fixture(account = SELF.user_id, hasReader = true) {
    const state = { current: true, now: 100 };
    const store = new UploadedDataStore({
        now: () => state.now,
        randomBytes: () => Buffer.alloc(32, ++randomSequence),
    });
    stores.push(store);
    const lease = vi.fn(() => state.current);
    const parsed: Array<Awaited<ReturnType<typeof parseMessage>>> = [];

    const handler = async (params: JsonObject): Promise<ApiResponse> => {
        parsed.push(await parseMessage(params.message, params.auto_escape === true));
        return {
            status: 'ok',
            retcode: 0,
            data: { message_id: MESSAGE_ID, secret: RESPONSE_SECRET },
        };
    };

    const privateHandler = vi.fn<ActionHandler>(handler);
    const groupHandler = vi.fn<ActionHandler>(handler);
    const context = new Proxy({} as ApiActionContext, {
        get(_target, key) {
            throw new Error(`unexpected context access: ${String(key)}`);
        },
    });
    const bind = vi.fn<CompiledActionRegistry['bind']>(
        () =>
            new Map([
                [
                    'send_private_msg',
                    {
                        handler: privateHandler,
                        canonical: 'send_private_msg',
                        kind: 'normal' as const,
                    },
                ],
                [
                    'send_group_msg',
                    { handler: groupHandler, canonical: 'send_group_msg', kind: 'normal' as const },
                ],
            ]),
    );
    const registry: CompiledActionRegistry = {
        actions: [],
        executableNames: [],
        categories: [],
        rawActions: [],
        resolve: () => undefined,
        bind,
    };
    const api = new ApiHandler(context, undefined, registry);
    const ordinary = vi.spyOn(api, 'handle');
    const sensitive = vi.spyOn(api, 'handleV12SensitiveMessage');
    const records: ActionRecord[] = [];
    api.setObserver((record) => records.push(record));
    const uploadProvider = vi.fn(
        (name: string, data: string, sha?: string, ticket?: V12FileLease) =>
            store.upload(name, data, sha, ticket),
    );
    const reader = vi.fn(function (
        this: V12CoreOptions,
        id: string,
        ticket?: V12FileLease,
    ): V12ReadUploadResult {
        return store.get(id, ticket);
    });
    const readiness = vi.fn((ticket?: V12FileLease) => ticket?.() === true);
    const getSentMessageTime = vi.fn((_id: number): number | null | Promise<number | null> => TIME);
    const options: V12CoreOptions = {
        self: { platform: 'qq', user_id: account },
        version: { impl: 'synthetic', version: '1' },
        api,
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime,
        uploadDataFile: uploadProvider,
        ...(hasReader ? { getUploadedDataFile: reader } : {}),
        isUploadDataSupported: readiness,
    };
    const dispatcher = new V12Dispatcher(options);
    const received: unknown[] = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe(ENDPOINT);
        expect(init?.method).toBe('POST');
        expect(typeof init?.body).toBe('string');
        const body: unknown = JSON.parse(init!.body as string);
        received.push(body);
        const result = await dispatcher.handle(body, lease);
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
    return {
        account,
        state,
        store,
        lease,
        parsed,
        privateHandler,
        groupHandler,
        api,
        ordinary,
        sensitive,
        records,
        uploadProvider,
        reader,
        readiness,
        getSentMessageTime,
        dispatcher,
        received,
        fakeFetch,
        client,
    };
}

type Fixture = ReturnType<typeof fixture>;
const image = (file_id: string) => ({ type: 'image', data: { file_id } });
const text = (value: string) => ({ type: 'text', data: { text: value } });

function request(
    scene: Scene,
    message: unknown,
    target: string = TARGETS[scene],
    account: string = SELF.user_id,
) {
    return {
        action: 'send_message',
        params:
            scene === 'private'
                ? { detail_type: 'private', user_id: target, message }
                : { detail_type: 'group', group_id: target, message },
        self: { platform: 'qq', user_id: account },
        echo: ECHO,
    };
}

async function upload(f: Fixture): Promise<string> {
    const result = await f.client.request(
        'upload_file',
        { type: 'data', name: NAME, data: DATA },
        { self: { platform: 'qq', user_id: f.account }, echo: 'synthetic-upload-echo' },
    );
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
    f.fakeFetch.mockClear();
    f.received.length = 0;
    f.reader.mockClear();
    f.lease.mockClear();
    f.readiness.mockClear();
    return data.file_id;
}

function expectFailure(
    result: { status: string; retcode: number; data: unknown; echo?: unknown },
    code?: number,
) {
    expect(result).toMatchObject({ status: 'failed', data: null, echo: ECHO });
    expect(result.retcode).not.toBe(0);

    if (code !== undefined) {
        expect(result.retcode).toBe(code);
    }
}

function noHandler(f: Fixture): void {
    expect(f.privateHandler).not.toHaveBeenCalled();
    expect(f.groupHandler).not.toHaveBeenCalled();
    expect(f.ordinary).not.toHaveBeenCalled();
    expect(f.getSentMessageTime).not.toHaveBeenCalled();
}

function expectNoDiagnosticSecrets(f: Fixture, id: string, ...values: unknown[]): void {
    // This covers ApiHandler's own trace/observer boundary, not downstream
    // send logging, self events, message history, transport or delivery.
    const observed = JSON.stringify({ logs: capture.logs, records: f.records, values });

    for (const marker of [
        NAME,
        'SYNTHETIC_MIXED_TEXT_',
        DATA,
        id,
        SECRET,
        RESPONSE_SECRET,
        ...Object.values(TARGETS),
    ]) {
        expect(observed).not.toContain(marker);
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function flush(): Promise<void> {
    for (let i = 0; i < 40; i += 1) {
        await Promise.resolve();
    }
}

async function immediateResult(promise: Promise<V12Response>): Promise<V12Response> {
    let settled = false;
    void promise.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        },
    );
    await flush();
    expect(settled).toBe(true);
    return promise;
}

const success = (): ApiResponse => ({ status: 'ok', retcode: 0, data: { message_id: MESSAGE_ID } });

describe('in-memory V12 image plus text through SDK, dispatcher and ApiHandler', () => {
    it.each(
        (['private', 'group'] as const).flatMap((scene) =>
            [true, false].flatMap((textFirst) =>
                ['', ' ', '\u0000', TEXT].map((content) => ({ scene, textFirst, content })),
            ),
        ),
    )(
        '$scene keeps both segment positions and exact text, textFirst=$textFirst',
        async ({ scene, textFirst, content }) => {
            const f = fixture();
            const id = await upload(f);
            const message = textFirst ? [text(content), image(id)] : [image(id), text(content)];
            const input = request(scene, message);
            const before = structuredClone(input);
            const params =
                scene === 'private'
                    ? { detail_type: 'private', user_id: TARGETS.private, message }
                    : { detail_type: 'group', group_id: TARGETS.group, message };
            const result = await f.client.request('send_message', params, {
                self: SELF,
                echo: ECHO,
            });
            expect(result).toEqual({
                status: 'ok',
                retcode: 0,
                data: { message_id: String(MESSAGE_ID), time: TIME },
                message: '',
                echo: ECHO,
            });
            expect(input).toEqual(before);
            expect(f.received).toEqual([input]);
            expect(f.fakeFetch).toHaveBeenCalledTimes(1);
            expect(f.reader).toHaveBeenCalledExactlyOnceWith(id, f.lease);
            const used = scene === 'private' ? f.privateHandler : f.groupHandler;
            const unused = scene === 'private' ? f.groupHandler : f.privateHandler;
            const v11Text = { type: 'text', data: { text: content } };
            const v11Image = { type: 'image', data: { file: `base64://${DATA}` } };
            const v11Message = textFirst ? [v11Text, v11Image] : [v11Image, v11Text];
            expect(used).toHaveBeenCalledTimes(1);
            expect(used.mock.calls[0]?.[0]).toEqual({
                ...(scene === 'private'
                    ? { user_id: Number(TARGETS.private) }
                    : { group_id: Number(TARGETS.group) }),
                message: v11Message,
                auto_escape: false,
            });
            expect(unused).not.toHaveBeenCalled();
            expect(f.ordinary).not.toHaveBeenCalled();
            expect(f.sensitive).toHaveBeenCalledTimes(1);
            expect(f.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(MESSAGE_ID);
            const parsedImage = { type: 'image', url: `base64://${DATA}` };
            const parsedText = { type: 'text', text: content };
            const expectedParsed =
                content === ''
                    ? [parsedImage]
                    : textFirst
                      ? [parsedText, parsedImage]
                      : [parsedImage, parsedText];
            expect(f.parsed).toHaveLength(1);
            expect(f.parsed[0]).toMatchObject(expectedParsed);

            if (content !== '') {
                const parsedTextElement = f.parsed[0]!.find((element) => element.type === 'text');
                expect(parsedTextElement?.type).toBe('text');

                if (!parsedTextElement || parsedTextElement.type !== 'text') {
                    throw new Error('synthetic parsed text missing');
                }

                expect(Buffer.from(parsedTextElement.text ?? '', 'utf8')).toEqual(
                    Buffer.from(content, 'utf8'),
                );
            }

            expect(f.records).toHaveLength(1);
            expect(f.records[0]).toMatchObject({
                action: scene === 'private' ? 'send_private_msg' : 'send_group_msg',
                params: {},
                redacted: true,
                response: { status: 'ok', retcode: 0, data: null, message: '[redacted]' },
            });
            expect(capture.logs).toContainEqual({
                level: 'trace',
                message: 'action_input [redacted]',
            });
            expect(capture.logs).toContainEqual({
                level: 'debug',
                message: 'action_params [redacted]',
            });
            expectNoDiagnosticSecrets(f, id);
            expect(f.store.get(id, f.lease)).toMatchObject({ kind: 'ok', name: NAME, data: DATA });
        },
    );

    it('keeps well-formed multibyte text above 64 KiB intact through the real parser', async () => {
        const f = fixture();
        const id = await upload(f);
        const content = '🪶'.repeat(16385);
        expect(Buffer.byteLength(content, 'utf8')).toBe(65540);
        const result = await f.dispatcher.handle(
            request('group', [text(content), image(id)]),
            f.lease,
        );
        expect(result).toMatchObject({ status: 'ok', retcode: 0, echo: ECHO });
        expect(f.reader).toHaveBeenCalledExactlyOnceWith(id, f.lease);
        expect(f.groupHandler).toHaveBeenCalledTimes(1);
        expect(f.groupHandler.mock.calls[0]?.[0]).toMatchObject({
            group_id: Number(TARGETS.group),
            message: [text(content), { type: 'image', data: { file: `base64://${DATA}` } }],
            auto_escape: false,
        });
        const element = f.parsed[0]?.[0];
        expect(element?.type).toBe('text');

        if (!element || element.type !== 'text') {
            throw new Error('synthetic parsed text missing');
        }

        expect(element.text).toBe(content);
        expect(Buffer.from(element.text ?? '', 'utf8')).toEqual(Buffer.from(content, 'utf8'));
        expect(f.parsed[0]).toMatchObject([element, { type: 'image', url: `base64://${DATA}` }]);
        expect(f.ordinary).not.toHaveBeenCalled();
    });

    it('validates all mixed segments and target before any uploaded-data read or action', async () => {
        const f = fixture();
        const id = await upload(f);
        const valid = image(id);
        const cases: Array<{ input: unknown; code: number }> = [
            { input: request('group', [valid, { type: 'text', data: {} }]), code: 10006 },
            { input: request('group', [valid, { type: 'text', data: { text: 42 } }]), code: 10006 },
            { input: request('group', [valid, text('\ud800')]), code: 10006 },
            { input: request('group', [text('\udc00'), valid]), code: 10006 },
            { input: request('group', [valid, text('a\ud800b')]), code: 10006 },
            { input: request('group', [text('\udfffz'), valid]), code: 10006 },
            {
                input: request('group', [
                    valid,
                    { type: 'text', data: { text: TEXT, extra: SECRET } },
                ]),
                code: 10007,
            },
            { input: request('group', [text(TEXT), { ...valid, extra: SECRET }]), code: 10007 },
            {
                input: request('group', [text(TEXT), image(`${PREFIX}${'A'.repeat(42)}B`)]),
                code: 10005,
            },
            // Both segments are invalid: report the first segment's own error.
            { input: request('group', [image('bad-upload'), text('\ud800')]), code: 10005 },
            { input: request('group', [text('\ud800'), image('bad-upload')]), code: 10006 },
            { input: request('group', [valid, valid]), code: 10005 },
            { input: request('group', [valid, text(TEXT), text('third')]), code: 10005 },
            { input: request('group', [valid, { type: 'mention_all', data: {} }]), code: 10005 },
            {
                input: request('group', [valid, { type: 'video', data: { file_id: id } }]),
                code: 10005,
            },
            { input: request('group', [valid, text(TEXT)], '4294967296'), code: 10003 },
            { input: request('private', [text(TEXT), valid], '4294967338'), code: 10003 },
            {
                input: request('group', [valid, { type: 'text', data: {} }], '4294967296'),
                code: 10006,
            },
            { input: request('group', [valid, text(TEXT)], '0'), code: 10003 },
            { input: { ...request('group', [valid, text(TEXT)]), extra: SECRET }, code: 10004 },
            { input: request('group', [valid, text(TEXT)], TARGETS.group, '10002'), code: 10102 },
        ];

        for (const { input, code } of cases) {
            const before = structuredClone(input);
            expectFailure(await f.dispatcher.handle(input, f.lease), code);
            expect(input).toEqual(before);
            expect(f.reader).not.toHaveBeenCalled();
            expect(f.sensitive).not.toHaveBeenCalled();
            noHandler(f);
        }
    });

    it('isolates unknown and foreign canonical IDs and blocks false or retired tickets before reading', async () => {
        const f = fixture();
        const id = await upload(f);
        const other = fixture('10002');
        const foreign = await upload(other);

        for (const candidate of [`${PREFIX}${'A'.repeat(43)}`, foreign]) {
            f.reader.mockClear();
            expectFailure(
                await f.dispatcher.handle(
                    request('group', [image(candidate), text(TEXT)]),
                    f.lease,
                ),
            );
            // A canonical bearer ID's membership requires the current store lookup.
            expect(f.reader).toHaveBeenCalledExactlyOnceWith(candidate, f.lease);
            expect(f.sensitive).not.toHaveBeenCalled();
            noHandler(f);
        }

        f.reader.mockClear();
        f.state.current = false;
        expectFailure(
            await f.dispatcher.handle(request('group', [text(TEXT), image(id)]), f.lease),
        );
        expect(f.reader).not.toHaveBeenCalled();
        expect(f.sensitive).not.toHaveBeenCalled();
        noHandler(f);
        const noReader = fixture(SELF.user_id, false);
        expectFailure(
            await noReader.dispatcher.handle(
                request('private', [image(id), text(TEXT)]),
                noReader.lease,
            ),
        );
        expect(noReader.reader).not.toHaveBeenCalled();
        expect(noReader.sensitive).not.toHaveBeenCalled();
        noHandler(noReader);
    });

    it('rejects a tampered digest after one provider read, without a sensitive call', async () => {
        const f = fixture();
        const id = await upload(f);
        f.reader.mockImplementationOnce((fileId, ticket) => {
            const result = f.store.get(fileId, ticket);
            return result.kind === 'ok' ? { ...result, sha256: '0'.repeat(64) } : result;
        });
        const result = await f.dispatcher.handle(
            request('private', [text(TEXT), image(id)]),
            f.lease,
        );
        expectFailure(result);
        expect(f.reader).toHaveBeenCalledExactlyOnceWith(id, f.lease);
        expect(f.sensitive).not.toHaveBeenCalled();
        noHandler(f);
        expectNoDiagnosticSecrets(f, id, result);
    });

    it('blocks a lease revoked by synchronous sensitive trace reentry before the registered action', async () => {
        const f = fixture();
        const id = await upload(f);
        let reentries = 0;

        capture.onLog = (entry) => {
            if (entry.message === 'action_params [redacted]') {
                capture.onLog = null;
                reentries += 1;
                f.state.current = false;
            }
        };

        const result = await f.dispatcher.handle(
            request('group', [image(id), text(TEXT)]),
            f.lease,
        );
        expectFailure(result);
        expect(reentries).toBe(1);
        expect(f.reader).toHaveBeenCalledExactlyOnceWith(id, f.lease);
        expect(f.sensitive).toHaveBeenCalledTimes(1);
        noHandler(f);
        expectNoDiagnosticSecrets(f, id, result);
    });

    it('consumes the original one-shot start guard even when it is called again during the handler', async () => {
        const f = fixture();
        const id = await upload(f);
        const gate = deferred<ApiResponse>();
        f.groupHandler.mockImplementationOnce(async () => gate.promise);
        const pending = f.dispatcher.handle(request('group', [text(TEXT), image(id)]), f.lease);

        try {
            await flush();
            expect(f.groupHandler).toHaveBeenCalledTimes(1);
            expect(f.reader).toHaveBeenCalledTimes(1);
            const canStart = f.sensitive.mock.calls[0]?.[2];
            expect(typeof canStart).toBe('function');
            expect(canStart?.()).toBe(false);
            expect(canStart?.()).toBe(false);
            expect(f.groupHandler).toHaveBeenCalledTimes(1);
            expect(f.reader).toHaveBeenCalledTimes(1);
            gate.resolve(success());
            expect(await pending).toMatchObject({ status: 'ok', retcode: 0, echo: ECHO });
        } finally {
            gate.resolve(success());
            await pending;
        }
    });

    it('limits mixed sends to four real in-flight registered handlers without reading a fifth', async () => {
        const f = fixture();
        const id = await upload(f);
        const gates = Array.from({ length: 4 }, () => deferred<ApiResponse>());
        let index = 0;
        f.groupHandler.mockImplementation(() => gates[index++]!.promise);
        const pending: Promise<V12Response>[] = [];

        try {
            for (let i = 0; i < 4; i += 1) {
                pending.push(
                    f.dispatcher.handle(request('group', [image(id), text(TEXT)]), f.lease),
                );
                await flush();
            }

            expect(f.groupHandler).toHaveBeenCalledTimes(4);
            expect(f.reader).toHaveBeenCalledTimes(4);
            const overflow = f.dispatcher.handle(
                request('group', [text(TEXT), image(id)]),
                f.lease,
            );
            pending.push(overflow);
            expectFailure(await immediateResult(overflow));
            expect(f.groupHandler).toHaveBeenCalledTimes(4);
            expect(f.reader).toHaveBeenCalledTimes(4);
            expect(f.sensitive).toHaveBeenCalledTimes(4);
            expect(f.ordinary).not.toHaveBeenCalled();
        } finally {
            for (const gate of gates) {
                gate.resolve(success());
            }

            await Promise.all(pending);
        }
    });

    it('shares four slots between single-image and mixed sends and admits both after settlement', async () => {
        const f = fixture();
        const id = await upload(f);
        const gates = Array.from({ length: 6 }, () => deferred<ApiResponse>());
        let started = 0;
        f.groupHandler.mockImplementation(() => gates[started++]!.promise);
        const pending: Promise<V12Response>[] = [];
        const initialMessages: unknown[] = [
            image(id),
            [image(id), text(TEXT)],
            image(id),
            [text(TEXT), image(id)],
        ];

        try {
            for (const message of initialMessages) {
                pending.push(f.dispatcher.handle(request('group', message), f.lease));
                await flush();
            }

            expect(f.reader).toHaveBeenCalledTimes(4);
            expect(f.groupHandler).toHaveBeenCalledTimes(4);
            expect(f.sensitive).toHaveBeenCalledTimes(4);

            for (const message of [image(id), [text(TEXT), image(id)]]) {
                const overflow = f.dispatcher.handle(request('group', message), f.lease);
                pending.push(overflow);
                expectFailure(await immediateResult(overflow));
                expect(f.reader).toHaveBeenCalledTimes(4);
                expect(f.groupHandler).toHaveBeenCalledTimes(4);
                expect(f.sensitive).toHaveBeenCalledTimes(4);
            }

            gates[0]!.resolve(success());
            expect(await pending[0]).toMatchObject({ status: 'ok', retcode: 0, echo: ECHO });
            const single = f.dispatcher.handle(request('group', image(id)), f.lease);
            pending.push(single);
            await flush();
            expect(f.reader).toHaveBeenCalledTimes(5);
            expect(f.groupHandler).toHaveBeenCalledTimes(5);
            gates[4]!.resolve(success());
            expect(await single).toMatchObject({ status: 'ok', retcode: 0, echo: ECHO });

            const mixed = f.dispatcher.handle(request('group', [image(id), text(TEXT)]), f.lease);
            pending.push(mixed);
            await flush();
            expect(f.reader).toHaveBeenCalledTimes(6);
            expect(f.groupHandler).toHaveBeenCalledTimes(6);
            gates[5]!.resolve(success());
            expect(await mixed).toMatchObject({ status: 'ok', retcode: 0, echo: ECHO });
            expect(f.sensitive).toHaveBeenCalledTimes(6);
            expect(f.privateHandler).not.toHaveBeenCalled();
            expect(f.ordinary).not.toHaveBeenCalled();
        } finally {
            for (const gate of gates) {
                gate.resolve(success());
            }

            await Promise.all(pending);
        }
    });

    it.each(['handler-throws-after-effect', 'metadata-throws-after-success'] as const)(
        'returns a sanitized failure without re-sending for %s',
        async (mode) => {
            const f = fixture();
            const id = await upload(f);
            let effects = 0;

            if (mode === 'handler-throws-after-effect') {
                f.groupHandler.mockImplementationOnce(async () => {
                    effects += 1;
                    throw new Error(`${SECRET}|${TEXT}|${DATA}|${id}`);
                });
            } else {
                f.groupHandler.mockImplementationOnce(async () => {
                    effects += 1;
                    return success();
                });
                f.getSentMessageTime.mockImplementationOnce(() => {
                    throw new Error(`${SECRET}|${id}|${DATA}`);
                });
            }

            const params = {
                detail_type: 'group',
                group_id: TARGETS.group,
                message: [text(TEXT), image(id)],
            };
            const result = await f.client.request('send_message', params, {
                self: SELF,
                echo: ECHO,
            });
            expectFailure(result);
            expect(effects).toBe(1);
            expect(f.fakeFetch).toHaveBeenCalledTimes(1);
            expect(f.reader).toHaveBeenCalledTimes(1);
            expect(f.sensitive).toHaveBeenCalledTimes(1);
            expect(f.groupHandler).toHaveBeenCalledTimes(1);
            expect(f.privateHandler).not.toHaveBeenCalled();
            expect(f.ordinary).not.toHaveBeenCalled();
            expect(f.getSentMessageTime).toHaveBeenCalledTimes(
                mode === 'metadata-throws-after-success' ? 1 : 0,
            );
            expectNoDiagnosticSecrets(f, id, result);
        },
    );
});
