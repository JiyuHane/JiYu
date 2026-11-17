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
import type { CompiledActionRegistry } from '../src/actions';
import type { ActionHandler, ActionRecord, ApiActionContext } from '../src/api-handler';
import type { ApiResponse, JsonObject } from '../src/types';

type SensitiveAction = 'send_private_msg' | 'send_group_msg';
type Observed = ActionRecord & {
    redacted?: true;
    handler_response?: 'reported' | 'unavailable';
};
type Guard = { mock: { calls: unknown[] } };
type CapturedLog = { level: string; message: string };

// The real ApiHandler is imported only after the effect guards are installed.
// In particular, neither its default registry nor a real account is loaded.
const capture = vi.hoisted(() => ({
    logs: [] as CapturedLog[],
    forbiddenModules: [] as string[],
    fault: null as null | { level: string; fragment: string; error: string; fired: number },
}));

vi.mock('../src/actions', () => ({
    ACTION_REGISTRY: {
        rawActions: [],
        bind: () => {
            throw new Error('the default action registry must not be used');
        },
    },
    HANDLE_QUICK_OPERATION_ACTION: '.handle_quick_operation',
}));
vi.mock('@snowluma/protocol/element-manifest', () => ({
    MessageElementValidationError: class extends Error {
        constructor(_code: string, message: string, _elementType?: string) {
            super(message);
            this.name = 'MessageElementValidationError';
        }
    },
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
        const message = format(rendered[0], ...rendered.slice(1));
        capture.logs.push({ level, message });
        const fault = capture.fault;

        if (
            fault &&
            fault.fired === 0 &&
            fault.level === level &&
            message.includes(fault.fragment)
        ) {
            fault.fired++;
            throw new Error(fault.error);
        }
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

let ApiHandler: typeof import('../src/api-handler').ApiHandler;
let ValidationError: typeof import('@snowluma/protocol/element-manifest').MessageElementValidationError;
let guards: Guard[];
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;

function blocked(): never {
    throw new Error('unexpected external effect in in-memory action fixture');
}

beforeEach(async () => {
    capture.logs.length = 0;
    capture.forbiddenModules.length = 0;
    capture.fault = null;
    fetchGuard = vi.fn(blocked);
    webSocketGuard = vi.fn(function ForbiddenWebSocket() {
        return blocked();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);

    // Install these before loading the tested module. Calls are also checked in
    // afterEach, including calls a test subject might catch and suppress.
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

    ({ ApiHandler } = await import('../src/api-handler'));
    ({ MessageElementValidationError: ValidationError } =
        await import('@snowluma/protocol/element-manifest'));
});

afterEach(() => {
    const guardCalls = guards.map((guard) => guard.mock.calls.length);
    const fetchCalls = fetchGuard.mock.calls.length;
    const webSocketCalls = webSocketGuard.mock.calls.length;
    const forbiddenModules = [...capture.forbiddenModules];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    expect(guardCalls).toEqual(guardCalls.map(() => 0));
    expect(fetchCalls).toBe(0);
    expect(webSocketCalls).toBe(0);
    expect(forbiddenModules).toEqual([]);
});

const markers = {
    target: 'SYNTHETIC_TARGET_PRIVATE_52a',
    group: 'SYNTHETIC_TARGET_GROUP_71b',
    message: 'SYNTHETIC_MESSAGE_CONTENT_16c',
    data: 'SYNTHETIC_BINARY_DATA_93d',
    base64: 'RkFLRV9TRU5TSVRJVkVfQkFTRTY0X0lNQUdF',
    token: 'SYNTHETIC_TOKEN_24e',
    handlerError: 'SYNTHETIC_HANDLER_ERROR_35f',
    response: 'SYNTHETIC_RESPONSE_CONTENT_46a',
    observerError: 'SYNTHETIC_OBSERVER_ERROR_57b',
    getter: 'SYNTHETIC_GETTER_SECRET_68c',
    invalid: 'SYNTHETIC_INVALID_ACTION_79d',
    retcode: '54003147889',
} as const;

function privateParams(): JsonObject {
    return {
        user_id: markers.target,
        group_id: markers.group,
        token: markers.token,
        message: [
            { type: 'text', data: { text: markers.message } },
            { type: 'image', data: { file: `base64://${markers.base64}` } },
        ],
        attachment: { data: markers.data },
    };
}

function fakeApi(handlers: Record<string, ActionHandler> = {}) {
    const context = new Proxy({} as ApiActionContext, {
        get(_target, key) {
            throw new Error(`unexpected fake context access: ${String(key)}`);
        },
    });
    const bind = vi.fn<CompiledActionRegistry['bind']>(
        (_context, _api, _factories) =>
            new Map(
                Object.entries(handlers).map(([name, handler]) => [
                    name,
                    { handler, canonical: name, kind: 'normal' as const },
                ]),
            ),
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
    expect(bind).toHaveBeenCalledTimes(1);
    expect(bind.mock.calls[0]?.[0]).toBe(context);
    expect(bind.mock.calls[0]?.[1]).toBe(api);
    return { api, bind };
}

// This is the WebUI server's record shape, not an imported Core or transport.
function collectWebUi(api: InstanceType<typeof ApiHandler>) {
    const records: Observed[] = [];
    const frames: string[] = [];
    api.setObserver((rec) => {
        records.push(rec as Observed);
        frames.push(JSON.stringify({ kind: 'action', uin: 4242, ...rec }));
    });
    return { records, frames };
}

function expectNoPrivateOutput(...values: unknown[]): void {
    const observed = JSON.stringify({ logs: capture.logs, values });

    for (const marker of Object.values(markers)) {
        expect(observed).not.toContain(marker);
    }
}

function expectRedactedRecord(
    record: Observed | undefined,
    action: SensitiveAction,
    actual: ApiResponse,
    source: 'reported' | 'unavailable',
): void {
    expect(record).toMatchObject({
        action,
        redacted: true,
        handler_response: source,
        response: { status: actual.status, retcode: actual.status === 'ok' ? 0 : 100, data: null },
    });
    expect(record?.response).not.toBe(actual);
    expect(typeof record?.ms).toBe('number');

    if (source === 'unavailable') {
        expect(record).toMatchObject({ handler_status: 'unknown', handler_retcode: null });
    } else {
        expect(record && 'handler_status' in record).toBe(false);

        if (actual.status === 'failed') {
            expect(record).toMatchObject({ handler_retcode: null });
        } else {
            expect(record && 'handler_retcode' in record).toBe(false);
        }
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('ApiHandler v12 sensitive message boundary with a fake registry', () => {
    it.each(['send_private_msg', 'send_group_msg'] as const)(
        '%s invokes its injected handler once per call and redacts success and business failure',
        async (action) => {
            const params = privateParams();
            const success: ApiResponse = {
                status: 'ok',
                retcode: 0,
                data: { message_id: -314, body: markers.response, token: markers.token },
            };
            const businessFailure: ApiResponse = {
                status: 'failed',
                retcode: Number(markers.retcode),
                data: { body: markers.response },
                wording: markers.handlerError,
            };
            const handler = vi
                .fn<ActionHandler>()
                .mockResolvedValueOnce(success)
                .mockResolvedValueOnce(businessFailure);
            const other = vi.fn<ActionHandler>();
            const otherAction =
                action === 'send_private_msg' ? 'send_group_msg' : 'send_private_msg';
            const { api } = fakeApi({ [action]: handler, [otherAction]: other });
            api.setObserver(() => {
                throw new Error(markers.observerError);
            });
            const ui = collectWebUi(api);

            const returnedSuccess = await api.handleV12SensitiveMessage(action, params);
            expect(returnedSuccess).toMatchObject({ status: 'ok', retcode: 0 });
            expect(returnedSuccess.data).toEqual({ message_id: -314 });
            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler.mock.calls[0]?.[0]).toBe(params);
            const returnedFailure = await api.handleV12SensitiveMessage(action, params);
            expect(returnedFailure).toMatchObject({
                status: 'failed',
                retcode: Number(markers.retcode),
            });
            expect(handler).toHaveBeenCalledTimes(2);
            expect(handler.mock.calls[1]?.[0]).toBe(params);
            expect(other).not.toHaveBeenCalled();
            expect(ui.records).toHaveLength(2);
            expect(ui.frames).toHaveLength(2);
            expectRedactedRecord(ui.records[0], action, success, 'reported');
            expectRedactedRecord(ui.records[1], action, businessFailure, 'reported');
            expect(ui.records[0]?.params).not.toBe(params);
            expect(ui.records[1]?.params).not.toBe(params);
            // A redacted failure must never be presented as the original success.
            expect(ui.records[1]?.response.status).toBe('failed');
            expect(ui.records[1]?.response.retcode).not.toBe(0);
            expect(capture.logs.filter((entry) => entry.level === 'trace')).toHaveLength(4);
            expect(capture.logs.filter((entry) => entry.level === 'debug')).toHaveLength(2);
            expect(capture.logs.filter((entry) => entry.level === 'warn')).toHaveLength(2);
            expectNoPrivateOutput(ui.records, ui.frames);
        },
    );

    it('rejects non-allowlisted actions before handlers, observers, or parameter getters', async () => {
        const privateHandler = vi.fn<ActionHandler>();
        const groupHandler = vi.fn<ActionHandler>();
        const disallowedHandler = vi.fn<ActionHandler>();
        const { api } = fakeApi({
            send_private_msg: privateHandler,
            send_group_msg: groupHandler,
            delete_msg: disallowedHandler,
        });
        const observer = vi.fn();
        api.setObserver(observer);
        let reads = 0;
        const poisoned = new Proxy(privateParams(), {
            get() {
                reads++;
                throw new Error(markers.getter);
            },
            ownKeys() {
                reads++;
                throw new Error(markers.getter);
            },
        });

        for (const action of ['delete_msg', 'send_msg', '', markers.invalid]) {
            const rejected = await api
                .handleV12SensitiveMessage(action as SensitiveAction, poisoned)
                .then(
                    (response) => response.status === 'failed',
                    () => true,
                );
            expect(rejected).toBe(true);
        }

        expect(privateHandler).not.toHaveBeenCalled();
        expect(groupHandler).not.toHaveBeenCalled();
        expect(disallowedHandler).not.toHaveBeenCalled();
        expect(observer).not.toHaveBeenCalled();
        expect(reads).toBe(0);
        expectNoPrivateOutput();
    });

    it('uses the injected registry and retains the unknown-action result', async () => {
        const { api } = fakeApi();
        const ui = collectWebUi(api);
        const response = await api.handleV12SensitiveMessage('send_private_msg', privateParams());
        expect(response).toMatchObject({ status: 'failed', retcode: 1404, data: null });
        expect(ui.records).toHaveLength(1);
        expectRedactedRecord(ui.records[0], 'send_private_msg', response, 'unavailable');
        expect(capture.logs.some((entry) => entry.level === 'debug')).toBe(true);
        expect(capture.logs.some((entry) => entry.level === 'trace')).toBe(true);
        expectNoPrivateOutput(ui.records, ui.frames);
    });

    it('isolates an observer that mutates its record from later observers and the caller', async () => {
        const original: ApiResponse = {
            status: 'failed',
            retcode: 1400,
            data: { detail: markers.response },
            wording: markers.handlerError,
        };
        const handler = vi.fn<ActionHandler>(async () => original);
        const { api } = fakeApi({ send_private_msg: handler });
        const firstFrames: string[] = [];
        api.setObserver((record) => {
            firstFrames.push(JSON.stringify(record));
            record.params.injected = markers.getter;
            record.response.status = 'ok';
            record.response.retcode = 0;
            record.response.data = markers.getter;
        });
        const ui = collectWebUi(api);

        const result = await api.handleV12SensitiveMessage('send_private_msg', privateParams());
        expect(result).toMatchObject({ status: 'failed', retcode: 1400 });
        expectRedactedRecord(ui.records[0], 'send_private_msg', original, 'reported');
        expect(ui.records[0]?.response.status).toBe('failed');
        expectNoPrivateOutput(firstFrames, ui.records, ui.frames);
    });

    it.each(['send_private_msg', 'send_group_msg'] as const)(
        '%s honors quiesce and redacts the rejection and observer error',
        async (action) => {
            const handler = vi.fn<ActionHandler>();
            const { api } = fakeApi({ [action]: handler });
            api.setObserver(() => {
                throw new Error(markers.observerError);
            });
            const ui = collectWebUi(api);
            api.quiesce();
            expect(api.isAcceptingActions).toBe(false);
            const result = await api.handleV12SensitiveMessage(action, privateParams());
            expect(result).toMatchObject({ status: 'failed', retcode: 100, data: null });
            expect(handler).not.toHaveBeenCalled();
            expect(ui.records).toHaveLength(1);
            expectRedactedRecord(ui.records[0], action, result, 'unavailable');
            expect(capture.logs.some((entry) => entry.level === 'warn')).toBe(true);
            expect(capture.logs.some((entry) => entry.level === 'trace')).toBe(true);
            expectNoPrivateOutput(ui.records, ui.frames);
        },
    );

    it('keeps throw classification, uses a fixed caller message, and redacts all diagnostics', async () => {
        const { StreamTransportClosedError } = await import('../src/streaming');
        const cases = [
            { error: new Error(markers.handlerError), code: 100 },
            {
                error: new ValidationError(
                    'UNKNOWN_TYPE',
                    `${markers.handlerError}-typed`,
                    'fixture',
                ),
                code: 1400,
            },
            { error: `${markers.handlerError}-string`, code: 100 },
            { error: new StreamTransportClosedError(`${markers.handlerError}-closed`), code: 100 },
        ];
        let next = 0;
        const handler = vi.fn<ActionHandler>(async () => {
            throw cases[next++]!.error;
        });
        const { api } = fakeApi({ send_private_msg: handler });
        api.setObserver(() => {
            throw new Error(markers.observerError);
        });
        const ui = collectWebUi(api);
        const messages: Array<string | undefined> = [];

        for (const [index, item] of cases.entries()) {
            const result = await api.handleV12SensitiveMessage('send_private_msg', privateParams());
            expect(result).toMatchObject({ status: 'failed', retcode: item.code, data: null });
            expectRedactedRecord(ui.records[index], 'send_private_msg', result, 'unavailable');
            messages.push(result.wording);
        }

        expect(handler).toHaveBeenCalledTimes(cases.length);
        expect(messages.every((message) => typeof message === 'string' && message.length > 0)).toBe(
            true,
        );
        expect(new Set(messages).size).toBe(1);
        expect(
            capture.logs.filter((entry) => entry.level === 'warn').length,
        ).toBeGreaterThanOrEqual(cases.length * 2);
        expectNoPrivateOutput(messages, ui.records, ui.frames);
    });

    it.each([
        { level: 'trace', fragment: 'action_input', observer: 'none', throws: false },
        { level: 'debug', fragment: 'action_params', observer: 'none', throws: false },
        { level: 'trace', fragment: 'action_terminal', observer: 'none', throws: false },
        { level: 'warn', fragment: 'action_failed', observer: 'none', throws: true },
        { level: 'warn', fragment: 'action_observer_error', observer: 'sync', throws: false },
        { level: 'warn', fragment: 'action_observer_error', observer: 'async', throws: false },
    ] as const)(
        'contains a $level subscriber throw at $fragment ($observer observer)',
        async ({ level, fragment, observer, throws }) => {
            const handler = vi.fn<ActionHandler>(async () => {
                if (throws) {
                    throw new Error(markers.handlerError);
                }

                return { status: 'ok', retcode: 0, data: { message_id: -27 } };
            });
            const { api } = fakeApi({ send_private_msg: handler });

            if (observer === 'sync') {
                api.setObserver(() => {
                    throw new Error(markers.observerError);
                });
            } else if (observer === 'async') {
                api.setObserver(async () => {
                    throw new Error(markers.observerError);
                });
            }

            const ui = collectWebUi(api);
            capture.fault = { level, fragment, error: markers.getter, fired: 0 };
            const result = await api.handleV12SensitiveMessage('send_private_msg', privateParams());
            // The async observer's rejected native Promise is observed separately.
            await Promise.resolve();
            await Promise.resolve();
            expect(capture.fault.fired).toBe(1);
            expect(handler).toHaveBeenCalledTimes(1);
            expect(ui.records).toHaveLength(1);
            expect(ui.frames).toHaveLength(1);

            if (throws) {
                expect(result).toMatchObject({ status: 'failed', retcode: 100 });
                expectRedactedRecord(ui.records[0], 'send_private_msg', result, 'unavailable');
            } else {
                expect(result).toMatchObject({
                    status: 'ok',
                    retcode: 0,
                    data: { message_id: -27 },
                });
                expectRedactedRecord(ui.records[0], 'send_private_msg', result, 'reported');
            }

            expectNoPrivateOutput(result, ui.records, ui.frames);
        },
    );

    it('does not assimilate a fulfilled observer Promise value a second time', async () => {
        let thenReads = 0;
        const value = Object.create(null) as object;
        Object.defineProperty(value, 'then', {
            get() {
                thenReads++;

                if (thenReads === 1) {
                    return undefined;
                }

                throw new Error(markers.observerError);
            },
        });
        const observer = vi.fn(() => Promise.resolve(value));
        const handler = vi.fn<ActionHandler>(async () => ({
            status: 'ok',
            retcode: 0,
            data: { message_id: -28 },
        }));
        const { api } = fakeApi({ send_private_msg: handler });
        api.setObserver(observer);
        const ui = collectWebUi(api);

        const result = await api.handleV12SensitiveMessage('send_private_msg', privateParams());

        // Flush the fulfillment continuation and any promise-adoption microtasks.
        for (let i = 0; i < 8; i++) {
            await Promise.resolve();
        }

        expect(result).toMatchObject({ status: 'ok', retcode: 0, data: { message_id: -28 } });
        expect(handler).toHaveBeenCalledTimes(1);
        expect(observer).toHaveBeenCalledTimes(1);
        expect(thenReads).toBe(1);
        expect(ui.frames).toHaveLength(1);
        expectRedactedRecord(ui.records[0], 'send_private_msg', result, 'reported');
        expect(capture.logs.filter((entry) => entry.level === 'warn')).toHaveLength(0);
        expectNoPrivateOutput(result, ui.records, ui.frames);
    });

    it('leaves ordinary v11 logger-subscriber exception behavior unchanged', async () => {
        const handler = vi.fn<ActionHandler>(async () => ({
            status: 'ok',
            retcode: 0,
            data: null,
        }));
        const { api } = fakeApi({ send_private_msg: handler });
        const observer = vi.fn();
        api.setObserver(observer);
        capture.fault = {
            level: 'trace',
            fragment: 'action_input',
            error: 'VISIBLE_V11_LOGGER_ERROR',
            fired: 0,
        };
        await expect(api.handle('send_private_msg', {})).rejects.toThrow(
            'VISIBLE_V11_LOGGER_ERROR',
        );
        expect(capture.fault.fired).toBe(1);
        expect(handler).not.toHaveBeenCalled();
        expect(observer).not.toHaveBeenCalled();
    });

    it('does not let observers or logging traverse nested input and returned-data getters', async () => {
        let inputReads = 0;
        let outputReads = 0;
        const params = privateParams();
        Object.defineProperty(params, 'hostile', {
            enumerable: true,
            get() {
                inputReads++;
                throw new Error(markers.getter);
            },
        });
        const data: JsonObject = { message_id: -73, privateExtra: markers.response };
        Object.defineProperty(data, 'hostile', {
            enumerable: true,
            get() {
                outputReads++;
                throw new Error(markers.getter);
            },
        });
        const original: ApiResponse = { status: 'ok', retcode: 0, data };
        const handler = vi.fn<ActionHandler>(async () => original);
        const { api } = fakeApi({ send_group_msg: handler });
        const ui = collectWebUi(api);

        const result = await api.handleV12SensitiveMessage('send_group_msg', params);
        expect(result.status).toBe('ok');
        expect(result.retcode).toBe(0);
        expect(result.data).toEqual({ message_id: -73 });
        expect(Object.is(result.data, data)).toBe(false);
        expect(handler.mock.calls[0]?.[0]).toBe(params);
        expectRedactedRecord(ui.records[0], 'send_group_msg', result, 'reported');
        expect(inputReads).toBe(0);
        expect(outputReads).toBe(0);
        expectNoPrivateOutput(ui.records, ui.frames);
    });

    it('snapshots the message id before observer reentry can alter the handler result', async () => {
        let thenReads = 0;
        const sourceData: JsonObject = { message_id: -92, extra: markers.response };
        const source: ApiResponse = { status: 'ok', retcode: 0, data: sourceData };
        const handler = vi.fn<ActionHandler>(async () => source);
        const { api } = fakeApi({ send_private_msg: handler });
        api.setObserver(() => {
            Object.defineProperty(source, 'then', {
                get() {
                    thenReads++;
                    throw new Error(markers.getter);
                },
            });
            sourceData.message_id = 812;
        });
        const ui = collectWebUi(api);

        const result = await api.handleV12SensitiveMessage('send_private_msg', privateParams());
        expect(result).toMatchObject({ status: 'ok', retcode: 0, data: { message_id: -92 } });
        expect(result.data).not.toBe(sourceData);
        expect(thenReads).toBe(0);
        expect(handler).toHaveBeenCalledTimes(1);
        expectRedactedRecord(ui.records[0], 'send_private_msg', result, 'reported');
        expectNoPrivateOutput(ui.records, ui.frames);
    });

    it.each([
        'proxy',
        'status getter',
        'retcode getter',
        'message getter',
        'wording getter',
        'invalid status',
        'contradictory status',
    ] as const)(
        'uses a truthful unavailable failure for a malicious or invalid %s response',
        async (kind) => {
            let reads = 0;
            let returned: unknown;
            const target = { status: 'ok', retcode: 0, data: { private: markers.response } };

            if (kind === 'proxy') {
                returned = new Proxy(target, {
                    get(_target, property) {
                        // Promise resolution probes thenables, before ApiHandler receives it.
                        if (property === 'then') {
                            return undefined;
                        }

                        reads++;
                        throw new Error(markers.getter);
                    },
                    ownKeys() {
                        reads++;
                        throw new Error(markers.getter);
                    },
                    getOwnPropertyDescriptor() {
                        reads++;
                        throw new Error(markers.getter);
                    },
                    getPrototypeOf() {
                        reads++;
                        throw new Error(markers.getter);
                    },
                });
            } else if (kind === 'invalid status') {
                returned = { ...target, status: markers.getter };
            } else if (kind === 'contradictory status') {
                returned = { ...target, status: 'ok', retcode: 1400 };
            } else {
                const property = kind.slice(0, -' getter'.length);
                Object.defineProperty(target, property, {
                    enumerable: true,
                    get() {
                        reads++;
                        throw new Error(markers.getter);
                    },
                });
                returned = target;
            }

            const handler = vi.fn<ActionHandler>(async () => returned as ApiResponse);
            const { api } = fakeApi({ send_private_msg: handler });
            const ui = collectWebUi(api);
            const result = await api.handleV12SensitiveMessage('send_private_msg', privateParams());
            expect(handler).toHaveBeenCalledTimes(1);
            expect(result.status).toBe('failed');
            expect(result.retcode).not.toBe(0);
            expect(result.data).toBeNull();
            expectRedactedRecord(ui.records[0], 'send_private_msg', result, 'unavailable');
            expect(ui.records[0]?.response.status).not.toBe('ok');
            expect(reads).toBe(0);
            expectNoPrivateOutput(result, ui.records, ui.frames);
        },
    );

    it('keeps ordinary v11 input, response, observer, and exception logging unchanged', async () => {
        const normalInput = { user_id: 'VISIBLE_V11_TARGET', message: 'VISIBLE_V11_INPUT' };
        const normalSuccess: ApiResponse = {
            status: 'ok',
            retcode: 0,
            data: { reply: 'VISIBLE_V11_RESPONSE' },
        };
        const normalFailure: ApiResponse = {
            status: 'failed',
            retcode: Number(markers.retcode),
            data: { reply: 'VISIBLE_V11_BUSINESS_FAILURE' },
        };
        const normalError = 'VISIBLE_V11_HANDLER_ERROR';
        const handler = vi
            .fn<ActionHandler>()
            .mockResolvedValueOnce(normalSuccess)
            .mockResolvedValueOnce(normalFailure)
            .mockRejectedValueOnce(new Error(normalError));
        const { api } = fakeApi({ send_private_msg: handler });
        const ui = collectWebUi(api);

        const first = await api.handle('send_private_msg', normalInput);
        const second = await api.handle('send_private_msg', normalInput);
        const third = await api.handle('send_private_msg', normalInput);
        expect(first).toBe(normalSuccess);
        expect(second).toBe(normalFailure);
        expect(third).toMatchObject({ status: 'failed', retcode: 100, wording: normalError });
        expect(handler).toHaveBeenCalledTimes(3);
        expect(handler.mock.calls[0]?.[0]).toBe(normalInput);
        expect(ui.records).toHaveLength(3);
        expect(ui.records[0]?.params).toBe(normalInput);
        expect(ui.records[0]?.response).toBe(normalSuccess);
        expect(ui.records[1]?.response).toBe(normalFailure);
        expect(ui.records[2]?.response).toBe(third);
        expect(ui.records.every((record) => !('redacted' in record))).toBe(true);
        expect(ui.records.every((record) => !('handler_response' in record))).toBe(true);
        const rendered = JSON.stringify({ logs: capture.logs, frames: ui.frames });
        expect(rendered).toContain('VISIBLE_V11_TARGET');
        expect(rendered).toContain('VISIBLE_V11_INPUT');
        expect(rendered).toContain('VISIBLE_V11_RESPONSE');
        expect(rendered).toContain('VISIBLE_V11_BUSINESS_FAILURE');
        expect(rendered).toContain(markers.retcode);
        expect(rendered).toContain(normalError);
        expect(
            capture.logs.some(
                (entry) => entry.level === 'warn' && entry.message.includes(normalError),
            ),
        ).toBe(true);
    });

    it.each([
        { action: 'send_private_msg', finishFirst: 'normal' },
        { action: 'send_group_msg', finishFirst: 'sensitive' },
    ] as const)(
        'keeps per-call modes isolated when $finishFirst finishes first on $action',
        async ({ action, finishFirst }) => {
            const sensitiveParams = privateParams();
            const normalParams: JsonObject = {
                target: 'VISIBLE_V11_CONCURRENT_TARGET',
                message: 'VISIBLE_V11_CONCURRENT_INPUT',
            };
            const sensitiveResponse: ApiResponse = {
                status: 'failed',
                retcode: 1400,
                data: { response: markers.response },
                wording: markers.handlerError,
            };
            const normalResponse: ApiResponse = {
                status: 'ok',
                retcode: 0,
                data: { response: 'VISIBLE_V11_CONCURRENT_RESPONSE' },
            };
            const sensitiveGate = deferred<ApiResponse>();
            const normalGate = deferred<ApiResponse>();
            const handler = vi.fn<ActionHandler>((params) => {
                if (params === sensitiveParams) {
                    return sensitiveGate.promise;
                }

                if (params === normalParams) {
                    return normalGate.promise;
                }

                throw new Error('unexpected fake handler parameters');
            });
            const { api } = fakeApi({ [action]: handler });
            const ui = collectWebUi(api);
            let sensitiveDone = false;
            let normalDone = false;
            const sensitive = api
                .handleV12SensitiveMessage(action, sensitiveParams)
                .then((value) => {
                    sensitiveDone = true;
                    return value;
                });
            const normal = api.handle(action, normalParams).then((value) => {
                normalDone = true;
                return value;
            });
            expect(handler).toHaveBeenCalledTimes(2);
            expect(handler.mock.calls[0]?.[0]).toBe(sensitiveParams);
            expect(handler.mock.calls[1]?.[0]).toBe(normalParams);

            if (finishFirst === 'normal') {
                normalGate.resolve(normalResponse);
                expect(await normal).toBe(normalResponse);
                expect(sensitiveDone).toBe(false);
                sensitiveGate.resolve(sensitiveResponse);
                expect(await sensitive).toMatchObject({ status: 'failed', retcode: 1400 });
            } else {
                sensitiveGate.resolve(sensitiveResponse);
                expect(await sensitive).toMatchObject({ status: 'failed', retcode: 1400 });
                expect(normalDone).toBe(false);
                normalGate.resolve(normalResponse);
                expect(await normal).toBe(normalResponse);
            }

            expect(ui.records).toHaveLength(2);
            const ordinaryRecord = ui.records.find((record) => record.params === normalParams);
            const sensitiveRecord = ui.records.find((record) => record.redacted === true);
            expect(ordinaryRecord?.response).toBe(normalResponse);
            expect(ordinaryRecord && 'redacted' in ordinaryRecord).toBe(false);
            expect(ordinaryRecord && 'handler_response' in ordinaryRecord).toBe(false);
            expectRedactedRecord(sensitiveRecord, action, sensitiveResponse, 'reported');
            expectNoPrivateOutput(ui.records, ui.frames);
            const rendered = JSON.stringify({ logs: capture.logs, frames: ui.frames });
            expect(rendered).toContain('VISIBLE_V11_CONCURRENT_TARGET');
            expect(rendered).toContain('VISIBLE_V11_CONCURRENT_INPUT');
            expect(rendered).toContain('VISIBLE_V11_CONCURRENT_RESPONSE');
        },
    );
});
