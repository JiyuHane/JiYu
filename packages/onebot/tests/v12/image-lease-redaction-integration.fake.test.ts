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

type LogEntry = { level: string; message: string };
type Guard = { mock: { calls: unknown[] } };
type Scene = 'private' | 'group';
type Change = 'revoke' | 'quiesce' | 'reader' | 'readiness' | 'api' | 'method';

// No default action registry, account, Core, database, native addon or transport
// is constructed. The three subjects are imported only after the guards exist.
const capture = vi.hoisted(() => ({
    logs: [] as LogEntry[],
    forbiddenModules: [] as string[],
    onLog: null as null | ((entry: LogEntry) => void),
}));

vi.mock('../../src/actions', () => ({
    ACTION_REGISTRY: {
        rawActions: [],
        bind: () => {
            throw new Error('the default action registry must not be used');
        },
    },
    HANDLE_QUICK_OPERATION_ACTION: '.handle_quick_operation',
}));
vi.mock('@snowluma/protocol/element-manifest', () => ({
    MessageElementValidationError: class extends Error {},
}));
vi.mock('@snowluma/sqlite', () => {
    capture.forbiddenModules.push('sqlite');
    throw new Error('unexpected SQLite module');
});
vi.mock('@snowluma/websocket', () => {
    capture.forbiddenModules.push('websocket');
    throw new Error('unexpected native websocket module');
});
vi.mock('@snowluma/core/bridge-interface', () => {
    capture.forbiddenModules.push('core');
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
    return {
        createLogger: () => logger,
        runWithTraceRequest: <T>(fn: () => T): T => fn(),
    };
});

const SELF = { platform: 'qq', user_id: '10001' };
const TARGETS = { private: '2948317061', group: '2948317062' } as const;
const NAME = 'SYNTHETIC_IMAGE_NAME_68c42';
const SECRET = 'SYNTHETIC_EXCEPTION_6d981';
const RESPONSE_SECRET = 'SYNTHETIC_RESPONSE_SECRET_e45b2';
const BYTES = Buffer.from('SYNTHETIC_IMAGE_BYTES_91e2af\u0000\u00ff', 'utf8');
const DATA = BYTES.toString('base64');
const MESSAGE_ID = -2147483648;
const TIME = 1700000000;

let ApiHandler: typeof import('../../src/api-handler').ApiHandler;
let V12Dispatcher: typeof import('../../src/v12/dispatcher').V12Dispatcher;
let UploadedDataStore: typeof import('../../src/v12/uploaded-data-store').V12UploadedDataStore;
let guards: Guard[];
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let stores: V12UploadedDataStore[];
let randomSequence: number;

function blocked(): never {
    throw new Error('unexpected external effect in in-memory image fixture');
}

beforeEach(async () => {
    capture.logs.length = 0;
    capture.forbiddenModules.length = 0;
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
        vi.spyOn(process, 'dlopen').mockImplementation(blocked),
        vi.spyOn(childProcess, 'spawn').mockImplementation(blocked),
        vi.spyOn(childProcess, 'spawnSync').mockImplementation(blocked),
        vi.spyOn(childProcess, 'exec').mockImplementation(blocked),
        vi.spyOn(childProcess, 'execSync').mockImplementation(blocked),
        vi.spyOn(childProcess, 'execFile').mockImplementation(blocked),
        vi.spyOn(childProcess, 'execFileSync').mockImplementation(blocked),
        vi.spyOn(childProcess, 'fork').mockImplementation(blocked),
        vi.spyOn(workerThreads, 'Worker').mockImplementation(blocked),
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

    ({ ApiHandler } = await import('../../src/api-handler'));
    ({ V12Dispatcher } = await import('../../src/v12/dispatcher'));
    ({ V12UploadedDataStore: UploadedDataStore } =
        await import('../../src/v12/uploaded-data-store'));
});

afterEach(() => {
    capture.onLog = null;

    for (const store of stores) {
        store.close();
    }

    const calls = guards.map((guard) => guard.mock.calls.length);
    const fetchCalls = fetchGuard.mock.calls.length;
    const webSocketCalls = webSocketGuard.mock.calls.length;
    const forbiddenModules = [...capture.forbiddenModules];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    expect(calls).toEqual(calls.map(() => 0));
    expect(fetchCalls).toBe(0);
    expect(webSocketCalls).toBe(0);
    expect(forbiddenModules).toEqual([]);
});

function fixture() {
    const state = { current: true, now: 100 };
    const store = new UploadedDataStore({
        now: () => state.now,
        randomBytes: () => Buffer.alloc(32, ++randomSequence),
    });
    stores.push(store);
    const lease = vi.fn(() => state.current);
    const privateHandler = vi.fn<ActionHandler>(async () => ({
        status: 'ok',
        retcode: 0,
        data: { message_id: MESSAGE_ID, secret: RESPONSE_SECRET },
    }));
    const groupHandler = vi.fn<ActionHandler>(async () => ({
        status: 'ok',
        retcode: 0,
        data: { message_id: MESSAGE_ID, secret: RESPONSE_SECRET },
    }));
    const context = new Proxy({} as ApiActionContext, {
        get(_target, key) {
            throw new Error(`unexpected fake context access: ${String(key)}`);
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
    const upload = vi.fn((name: string, data: string, sha256?: string, candidate?: V12FileLease) =>
        store.upload(name, data, sha256, candidate),
    );
    const reader = vi.fn(function (
        this: V12CoreOptions,
        id: string,
        candidate?: V12FileLease,
    ): V12ReadUploadResult {
        return store.get(id, candidate);
    });
    const readiness = vi.fn((candidate?: V12FileLease) => candidate?.() === true);
    const getSentMessageTime = vi.fn((_id: number): number | null => TIME);
    const options: V12CoreOptions = {
        self: { ...SELF },
        version: { impl: 'synthetic', version: '1' },
        api,
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime,
        uploadDataFile: upload,
        getUploadedDataFile: reader,
        isUploadDataSupported: readiness,
    };
    const dispatcher = new V12Dispatcher(options);
    const records: ActionRecord[] = [];
    const frames: string[] = [];
    expect(bind).toHaveBeenCalledTimes(1);
    expect(bind.mock.calls[0]?.[0]).toBe(context);
    expect(bind.mock.calls[0]?.[1]).toBe(api);
    return {
        state,
        store,
        lease,
        privateHandler,
        groupHandler,
        api,
        ordinary,
        upload,
        reader,
        readiness,
        getSentMessageTime,
        options,
        dispatcher,
        records,
        frames,
    };
}

type Fixture = ReturnType<typeof fixture>;

async function uploadImage(f: Fixture): Promise<string> {
    const response = await f.dispatcher.handle(
        {
            action: 'upload_file',
            params: { type: 'data', name: NAME, data: DATA },
            echo: 'synthetic-upload-echo',
        },
        f.lease,
    );
    expect(response).toMatchObject({ status: 'ok', retcode: 0, echo: 'synthetic-upload-echo' });
    const data = response.data;

    if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        typeof data.file_id !== 'string'
    ) {
        throw new Error('synthetic upload ID missing');
    }

    expect(data.file_id).toMatch(/^jiyu-upload:v1:[A-Za-z0-9_-]{43}$/);
    expect(f.upload).toHaveBeenCalledTimes(1);
    return data.file_id;
}

function request(scene: Scene, fileId: string, echo: string) {
    const message = { type: 'image', data: { file_id: fileId } };
    return {
        action: 'send_message',
        params:
            scene === 'private'
                ? { detail_type: 'private', user_id: TARGETS.private, message }
                : { detail_type: 'group', group_id: TARGETS.group, message: [message] },
        self: { ...SELF },
        echo,
    };
}

function echoWithSecrets(id: string, scene: Scene): string {
    // Echo is caller-owned and deliberately may contain every sensitive marker.
    return `SYNTHETIC_ECHO|${DATA}|${id}|${TARGETS[scene]}|${SECRET}|${RESPONSE_SECRET}`;
}

function attachObservers(f: Fixture, id: string, scene: Scene): void {
    f.api.setObserver(() => {
        throw new Error(`${SECRET}|${DATA}|${id}|${TARGETS[scene]}|${RESPONSE_SECRET}`);
    });
    f.api.setObserver((record) => {
        f.records.push(record);
        f.frames.push(JSON.stringify({ kind: 'action', ...record }));
    });
}

function expectNoSecrets(id: string, ...values: unknown[]): void {
    const observed = JSON.stringify({ logs: capture.logs, values });

    for (const marker of [
        NAME,
        DATA,
        id,
        TARGETS.private,
        TARGETS.group,
        SECRET,
        RESPONSE_SECRET,
    ]) {
        expect(observed).not.toContain(marker);
    }
}

function expectRecord(f: Fixture, scene: Scene, status: 'ok' | 'failed'): void {
    expect(f.records).toHaveLength(1);
    expect(f.frames).toHaveLength(1);
    expect(f.records[0]?.params).toEqual({});
    expect(f.records[0]).toMatchObject({
        action: scene === 'private' ? 'send_private_msg' : 'send_group_msg',
        params: {},
        response: {
            status,
            retcode: status === 'ok' ? 0 : 100,
            data: null,
            message: '[redacted]',
        },
        redacted: true,
        handler_response: status === 'ok' ? 'reported' : 'unavailable',
        ...(status === 'failed' ? { handler_status: 'unknown', handler_retcode: null } : {}),
    });
}

function expectFixedFailure(result: V12Response, echo: string, id: string, f: Fixture): void {
    expect(result).toEqual({
        status: 'failed',
        retcode: 20002,
        data: null,
        message: 'action outcome unavailable; do not retry automatically',
        echo,
    });
    const { echo: returnedEcho, ...withoutEcho } = result;
    expect(returnedEcho).toBe(echo);
    expectNoSecrets(id, withoutEcho, f.records, f.frames);
}

const stages = [
    { level: 'trace', message: 'action_input [redacted]' },
    { level: 'debug', message: 'action_params [redacted]' },
] as const;
const scenarios = (['private', 'group'] as const).flatMap((scene) =>
    stages.flatMap((stage) =>
        (['revoke', 'quiesce', 'reader', 'readiness', 'api', 'method'] as const).map((change) => ({
            scene,
            stage,
            change,
        })),
    ),
);

// This checks admission up to the registered handler's start, not cancellation
// or reversal of side effects after the handler has already been entered.
describe('real API, dispatcher and upload store: sensitive image start boundary', () => {
    it.each(scenarios)(
        '$scene: $stage.message reentry with $change does not start a handler',
        async ({
            scene,
            stage,
            change,
        }: {
            scene: Scene;
            stage: (typeof stages)[number];
            change: Change;
        }) => {
            const f = fixture();
            const id = await uploadImage(f);
            const echo = echoWithSecrets(id, scene);
            attachObservers(f, id, scene);
            const replacementReader = vi.fn(() => ({ kind: 'unavailable' as const }));
            const replacementReadiness = vi.fn(() => true);
            const replacementHandle = vi.fn(async (): Promise<ApiResponse> => ({
                status: 'ok',
                retcode: 0,
                data: { message_id: MESSAGE_ID },
            }));
            const replacementSensitive = vi.fn(async (): Promise<ApiResponse> => ({
                status: 'ok',
                retcode: 0,
                data: { message_id: MESSAGE_ID },
            }));
            let fires = 0;
            let readsAtLog = -1;
            let currentAtLog = false;
            let acceptingAtLog = false;

            capture.onLog = (entry) => {
                if (entry.level !== stage.level || entry.message !== stage.message) {
                    return;
                }

                capture.onLog = null; // quiesce emits its own log synchronously.
                fires += 1;
                readsAtLog = f.reader.mock.calls.length;
                currentAtLog = f.state.current;
                acceptingAtLog = f.api.isAcceptingActions;

                if (change === 'revoke') {
                    f.state.current = false;
                } else if (change === 'quiesce') {
                    f.api.quiesce();
                } else if (change === 'reader') {
                    f.options.getUploadedDataFile = replacementReader;
                } else if (change === 'readiness') {
                    f.options.isUploadDataSupported = replacementReadiness;
                } else if (change === 'api') {
                    f.options.api = {
                        handle: replacementHandle,
                        handleV12SensitiveMessage: replacementSensitive,
                    };
                } else {
                    Object.defineProperty(f.api, 'handleV12SensitiveMessage', {
                        value: replacementSensitive,
                        configurable: true,
                    });
                }
            };

            const result = await f.dispatcher.handle(request(scene, id, echo), f.lease);
            expect(fires).toBe(1);
            expect(readsAtLog).toBe(1);
            expect(currentAtLog).toBe(true);
            expect(acceptingAtLog).toBe(true);
            expect(f.state.current).toBe(change !== 'revoke');
            expect(f.api.isAcceptingActions).toBe(change !== 'quiesce');
            expect(f.reader).toHaveBeenCalledExactlyOnceWith(id, f.lease);
            expect(f.reader.mock.contexts[0]).toBe(f.options);
            expect(replacementReader).not.toHaveBeenCalled();
            expect(replacementReadiness).not.toHaveBeenCalled();
            expect(replacementHandle).not.toHaveBeenCalled();
            expect(replacementSensitive).not.toHaveBeenCalled();
            expect(f.privateHandler).not.toHaveBeenCalled();
            expect(f.groupHandler).not.toHaveBeenCalled();
            expect(f.ordinary).not.toHaveBeenCalled();
            expect(f.getSentMessageTime).not.toHaveBeenCalled();
            expectRecord(f, scene, 'failed');
            expectFixedFailure(result, echo, id, f);
        },
    );

    it.each(['private', 'group'] as const)(
        '%s: a current lease calls the injected registered handler once',
        async (scene) => {
            const f = fixture();
            const id = await uploadImage(f);
            const echo = echoWithSecrets(id, scene);
            attachObservers(f, id, scene);
            const input = request(scene, id, echo);
            const before = structuredClone(input);
            const result = await f.dispatcher.handle(input, f.lease);
            expect(input).toEqual(before);
            expect(f.state.current).toBe(true);
            expect(f.api.isAcceptingActions).toBe(true);
            expect(f.reader).toHaveBeenCalledExactlyOnceWith(id, f.lease);
            expect(f.reader.mock.contexts[0]).toBe(f.options);
            const handler = scene === 'private' ? f.privateHandler : f.groupHandler;
            const other = scene === 'private' ? f.groupHandler : f.privateHandler;
            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler.mock.calls[0]?.[0]).toEqual({
                ...(scene === 'private'
                    ? { user_id: Number(TARGETS.private) }
                    : { group_id: Number(TARGETS.group) }),
                message: [{ type: 'image', data: { file: `base64://${DATA}` } }],
                auto_escape: false,
            });
            expect(other).not.toHaveBeenCalled();
            expect(f.ordinary).not.toHaveBeenCalled();
            expect(f.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(MESSAGE_ID);
            expect(result).toEqual({
                status: 'ok',
                retcode: 0,
                data: { message_id: String(MESSAGE_ID), time: TIME },
                message: '',
                echo,
            });
            expectRecord(f, scene, 'ok');
            const { echo: returnedEcho, ...withoutEcho } = result;
            expect(returnedEcho).toBe(echo);
            expectNoSecrets(id, withoutEcho, f.records, f.frames);
            expect(capture.logs).toContainEqual({
                level: 'trace',
                message: 'action_input [redacted]',
            });
            expect(capture.logs).toContainEqual({
                level: 'debug',
                message: 'action_params [redacted]',
            });
        },
    );

    it.each(['throw', 'quiesce-return-true'] as const)(
        'real ApiHandler blocks a canStart callback that performs %s',
        async (mode) => {
            const f = fixture();
            const id = await uploadImage(f);
            attachObservers(f, id, 'private');
            const params: JsonObject = {
                user_id: Number(TARGETS.private),
                message: [{ type: 'image', data: { file: `base64://${DATA}`, file_id: id } }],
            };
            const canStart = vi.fn(() => {
                if (mode === 'throw') {
                    throw new Error(`${SECRET}|${DATA}|${id}|${TARGETS.private}`);
                }

                f.api.quiesce();
                return true;
            });
            const result = await f.api.handleV12SensitiveMessage(
                'send_private_msg',
                params,
                canStart,
            );
            expect(canStart).toHaveBeenCalledTimes(1);
            expect(f.api.isAcceptingActions).toBe(mode !== 'quiesce-return-true');
            expect(f.privateHandler).not.toHaveBeenCalled();
            expect(f.groupHandler).not.toHaveBeenCalled();
            expect(f.ordinary).not.toHaveBeenCalled();
            expect(f.reader).not.toHaveBeenCalled();
            expect(f.getSentMessageTime).not.toHaveBeenCalled();
            expect(result).toEqual({
                status: 'failed',
                retcode: 100,
                data: null,
                wording: 'sensitive action unavailable',
            });
            expectRecord(f, 'private', 'failed');
            expectNoSecrets(id, result, f.records, f.frames);
            expect(capture.logs).toContainEqual({
                level: 'trace',
                message: 'action_input [redacted]',
            });
            expect(capture.logs).toContainEqual({
                level: 'debug',
                message: 'action_params [redacted]',
            });
        },
    );
});
