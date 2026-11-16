import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import { MessageElementValidationError } from '@snowluma/protocol/element-manifest';
import type { CompiledActionRegistry } from '../../src/actions';
import {
    ApiHandler,
    type ActionHandler,
    type ActionRecord,
    type ApiActionContext,
} from '../../src/api-handler';
import { StreamTransportClosedError, type StreamSink } from '../../src/streaming';
import type { ApiResponse, JsonObject, JsonValue } from '../../src/types';

// No real action factories, Bridge, transport, or file writer are constructed.
const fileTransport = vi.hoisted(() => {
    const previousFileLevel = process.env.SNOWLUMA_LOG_FILE_LEVEL;
    process.env.SNOWLUMA_LOG_FILE_LEVEL = 'debug';
    return { writes: [] as unknown[][], previousFileLevel };
});
vi.mock('@snowluma/common/log-file-transport', () => ({
    getFileTransport: () => ({
        write: (...args: unknown[]) => fileTransport.writes.push(args),
        close: async () => {},
    }),
}));
vi.mock('../../src/actions', () => ({
    ACTION_REGISTRY: { rawActions: [], bind: () => new Map() },
    HANDLE_QUICK_OPERATION_ACTION: '.handle_quick_operation',
}));
vi.mock('@snowluma/protocol/element-manifest', () => ({
    MessageElementValidationError: class extends Error {
        constructor(_code: string, message: string) {
            super(message);
        }
    },
}));

const action = 'set_group_leave';
const accountId = 817264593;
const groupId = 723851069;
const inputMarker = 'fixture-leave-input-d329';
const resultMarker = 'fixture-leave-result-e842';
const errorMarker = 'fixture-leave-error-a519';
const observerMarker = 'fixture-leave-observer-b710';
const frameMarker = 'fixture-leave-frame-c162';
const markers = [
    String(accountId),
    String(groupId),
    inputMarker,
    resultMarker,
    errorMarker,
    observerMarker,
    frameMarker,
];
let entries: LogEntry[];
let previousLevel: string;
let unsubscribe: () => void;

beforeEach(() => {
    previousLevel = getLogLevel();
    setLogLevel('trace');
    entries = [];
    fileTransport.writes.length = 0;
    unsubscribe = subscribeLogs((entry) => entries.push(entry));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
    unsubscribe();
    setLogLevel(previousLevel);
    vi.restoreAllMocks();
});

afterAll(() => {
    if (fileTransport.previousFileLevel === undefined) {
        delete process.env.SNOWLUMA_LOG_FILE_LEVEL;
    } else {
        process.env.SNOWLUMA_LOG_FILE_LEVEL = fileTransport.previousFileLevel;
    }
});

// Bind an in-memory handler through a fake context and registry. In particular,
// the stream case is synthetic; production set_group_leave is a normal action.
function fixture(
    run?: ActionHandler,
    name: string = action,
    kind: 'normal' | 'stream' = 'normal',
    canonical: string = name,
) {
    const context = { run };
    const registry = {
        rawActions: [],
        bind: (bound: ApiActionContext) => {
            const fake = bound as unknown as typeof context;
            const handlers = new Map<
                string,
                { handler: ActionHandler; canonical: string; kind: 'normal' | 'stream' }
            >();

            if (fake.run) {
                handlers.set(name, { handler: fake.run, canonical, kind });
            }

            return handlers;
        },
    } as unknown as CompiledActionRegistry;
    return new ApiHandler(context as unknown as ApiActionContext, accountId, registry);
}

function logs(): LogEntry[] {
    return entries.filter((entry) => entry.scope === 'Bridge.Action');
}

function expectPrivateLogs(): void {
    const captured = logs();
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.every((entry) => entry.uin === undefined)).toBe(true);
    expect(fileTransport.writes.every((args) => args[1] === undefined)).toBe(true);
    const text = JSON.stringify({ entries: captured, writes: fileTransport.writes });

    for (const marker of markers) {
        expect(text).not.toContain(marker);
    }

    expect(text).not.toMatch(/\bat\s+.+:\d+:\d+/);
}

function expectInput(): void {
    expect(
        logs().some((entry) => entry.message === `action_input action=${action} params=[redacted]`),
    ).toBe(true);
}

function expectTerminal(outcome: 'ok' | 'failed' | 'cancelled', reason: string): void {
    expect(
        logs().some(
            (entry) =>
                entry.level === 'trace' &&
                entry.message.includes(
                    `action_terminal action=${action} outcome=${outcome} reason=${reason} `,
                ) &&
                entry.message.endsWith('response=[redacted]'),
        ),
    ).toBe(true);
}

describe('set_group_leave diagnostics at the ApiHandler boundary', () => {
    it('redacts inputs, success and observer errors without touching payloads or ordering', async () => {
        const events: string[] = [];
        let inputReads = 0;
        let resultReads = 0;
        const params: JsonObject = { group_id: groupId, extra: inputMarker };
        const data: JsonObject = { private_result: resultMarker };
        Object.defineProperty(params, 'untouched', {
            enumerable: true,
            get() {
                inputReads++;
                throw new Error(inputMarker);
            },
        });
        Object.defineProperty(data, 'untouched', {
            enumerable: true,
            get() {
                resultReads++;
                throw new Error(resultMarker);
            },
        });
        const returned: ApiResponse = { status: 'ok', retcode: 0, data };
        const run = vi.fn(async () => {
            events.push('run');
            return returned;
        });
        const api = fixture(run);
        const records: ActionRecord[] = [];
        const stop = subscribeLogs((entry) => {
            if (entry.scope === 'Bridge.Action') {
                events.push(`log:${entry.level}`);
            }
        });
        api.setObserver((record) => {
            events.push('observer-1');
            records.push(record);
            throw new Error(observerMarker);
        });
        api.setObserver((record) => {
            events.push('observer-2');
            records.push(record);
        });
        const response = await api.handle(action, params).finally(stop);

        expect(response).toBe(returned);
        expect(response.data).toBe(data);
        expect(run).toHaveBeenCalledOnce();
        const calls = run.mock.calls as unknown[][];
        expect(calls[0]?.[0]).toBe(params);
        expect(calls[0]?.[1]).toBeUndefined();
        expect(records).toHaveLength(2);
        expect(records[0]?.action).toBe(action);
        expect(records[0]?.params).toBe(params);
        expect(records[1]?.params).toBe(params);
        expect(records[0]?.response).toBe(response);
        expect(records[1]?.response).toBe(response);
        expect(typeof records[0]?.ms).toBe('number');
        expect(inputReads).toBe(0);
        expect(resultReads).toBe(0);
        expect(events).toEqual([
            'log:trace',
            'log:debug',
            'run',
            'log:trace',
            'observer-1',
            'log:warn',
            'observer-2',
        ]);
        expect(logs()[1]?.message).toBe(`${action} params=[redacted]`);
        expect(logs()[3]?.message).toBe(`${action} action observer error: [redacted]`);
        expectInput();
        expectTerminal('ok', 'response_returned');
        expect(fileTransport.writes.length).toBeGreaterThan(0);
        expectPrivateLogs();
    });

    it('preserves a returned failed response and its raw observer reference', async () => {
        const returned: ApiResponse = {
            status: 'failed',
            retcode: 1400,
            data: { private_result: resultMarker },
            wording: errorMarker,
        };
        const run = vi.fn(async () => returned);
        const api = fixture(run);
        const records: ActionRecord[] = [];
        const params = { group_id: groupId, extra: inputMarker };
        api.setObserver((record) => records.push(record));
        const response = await api.handle(action, params);
        expect(response).toBe(returned);
        expect(records[0]?.params).toBe(params);
        expect(records[0]?.response).toBe(returned);
        expect(run).toHaveBeenCalledExactlyOnceWith(params, undefined);
        expect(logs().map((entry) => entry.level)).toEqual(['trace', 'debug', 'trace']);
        expectInput();
        expectTerminal('failed', 'response_returned');
        expectPrivateLogs();
    });

    it.each(['error', 'string', 'validation'] as const)(
        'keeps %s failure wording and classification while logging fixed warnings',
        async (kind) => {
            const message = `${errorMarker}:${groupId}:${accountId}`;
            const error =
                kind === 'validation'
                    ? new MessageElementValidationError('UNKNOWN_TYPE', message, 'fixture')
                    : kind === 'error'
                      ? new Error(message)
                      : message;
            const run = vi.fn(async () => {
                throw error;
            });
            const api = fixture(run);
            const params = { group_id: groupId, extra: inputMarker };
            const records: ActionRecord[] = [];
            const order: string[] = [];
            api.setObserver((record) => {
                order.push('first');
                records.push(record);
                throw observerMarker;
            });
            api.setObserver((record) => {
                order.push('second');
                records.push(record);
            });
            const response = await api.handle(action, params);
            expect(response).toEqual({
                status: 'failed',
                retcode: kind === 'validation' ? 1400 : 100,
                data: null,
                wording: message,
            });
            expect(run).toHaveBeenCalledExactlyOnceWith(params, undefined);
            expect(order).toEqual(['first', 'second']);
            expect(records).toHaveLength(2);
            expect(records[0]?.params).toBe(params);
            expect(records[0]?.response).toBe(response);
            expect(records[1]?.response).toBe(response);
            expect(logs().map((entry) => entry.level)).toEqual([
                'trace',
                'debug',
                'warn',
                'trace',
                'warn',
            ]);
            expect(
                logs()
                    .filter((entry) => entry.level === 'warn')
                    .map((entry) => entry.message),
            ).toEqual([
                `${action} failed: [redacted]`,
                `${action} action observer error: [redacted]`,
            ]);
            expectInput();
            expectTerminal('failed', 'handler_threw');
            expectPrivateLogs();
        },
    );

    it('redacts unknown dispatch without calling a handler or observer', async () => {
        const api = fixture();
        const observer = vi.fn();
        api.setObserver(observer);
        const response = await api.handle(action, { group_id: groupId, extra: inputMarker });
        expect(response).toEqual({
            status: 'failed',
            retcode: 1404,
            data: null,
            wording: 'unknown action',
        });
        expect(observer).not.toHaveBeenCalled();
        expect(logs().map((entry) => entry.level)).toEqual(['trace', 'debug', 'trace']);
        expect(logs()[1]?.message).toBe(`unknown action ${action}`);
        expectInput();
        expectTerminal('failed', 'unknown_action');
        expectPrivateLogs();
    });

    it('redacts quiesced dispatch and both external quiesced trace entrypoints', async () => {
        const run = vi.fn(async (): Promise<ApiResponse> => ({
            status: 'ok',
            retcode: 0,
            data: null,
        }));
        const api = fixture(run);
        api.quiesce(); // The independent lifecycle record keeps its existing account logger.
        entries = [];
        fileTransport.writes.length = 0;
        const params = { group_id: groupId, extra: inputMarker };
        const records: ActionRecord[] = [];
        api.setObserver((record) => {
            records.push(record);
            throw new Error(observerMarker);
        });
        api.setObserver((record) => records.push(record));
        const response = await api.handle(action, params);
        expect(response).toEqual({
            status: 'failed',
            retcode: 100,
            data: null,
            wording: 'OneBot instance is shutting down',
        });
        expect(run).not.toHaveBeenCalled();
        expect(records).toHaveLength(2);
        expect(records[0]?.params).toBe(params);
        expect(records[0]?.response).toBe(response);
        expect(records[1]?.response).toBe(response);
        expect(logs().map((entry) => entry.level)).toEqual(['trace', 'warn', 'trace', 'warn']);
        expect(logs()[3]?.message).toBe(`${action} action observer error: [redacted]`);

        api.traceQuiescedAction(action, params, {
            status: 'failed',
            retcode: 100,
            data: { private_result: resultMarker },
            wording: errorMarker,
        });
        api.traceQuiescedStreamRequest(JSON.stringify({ action, params }));
        expect(logs().map((entry) => entry.level)).toEqual([
            'trace',
            'warn',
            'trace',
            'warn',
            'trace',
            'trace',
            'trace',
            'trace',
        ]);
        expect(records).toHaveLength(2);
        expectInput();
        expectTerminal('failed', 'quiesced');
        expectPrivateLogs();
    });

    it('redacts a synthetic stream frame without traversing or replacing it', async () => {
        const events: string[] = [];
        let reads = 0;
        const frame: JsonObject = { group_id: groupId, payload: frameMarker };
        Object.defineProperty(frame, 'untouched', {
            enumerable: true,
            get() {
                reads++;
                throw new Error(frameMarker);
            },
        });
        const returned: ApiResponse = { status: 'ok', retcode: 0, data: { payload: resultMarker } };
        const run = vi.fn(async (_params: JsonObject, sink?: StreamSink) => {
            events.push('run');
            await sink!.send(frame);
            events.push('after-send');
            return returned;
        });
        const api = fixture(run, action, 'stream');
        const send = vi.fn(async (_frame: JsonValue) => {
            events.push('sink');
        });
        const params = { group_id: groupId, extra: inputMarker };
        const records: ActionRecord[] = [];
        api.setObserver((record) => {
            events.push('observer');
            records.push(record);
        });
        const response = await api.handle(action, params, { send });
        expect(response).toBe(returned);
        expect(run).toHaveBeenCalledOnce();
        expect(run.mock.calls[0]?.[0]).toBe(params);
        expect(send).toHaveBeenCalledOnce();
        expect(send.mock.calls[0]?.[0]).toBe(frame);
        expect(reads).toBe(0);
        expect(records[0]?.response).toBe(returned);
        expect(events).toEqual(['run', 'sink', 'after-send', 'observer']);
        expect(logs().map((entry) => entry.level)).toEqual(['trace', 'debug', 'trace', 'trace']);
        expect(logs()[2]?.message).toBe(`action_stream_frame action=${action} frame=[redacted]`);
        expectInput();
        expectTerminal('ok', 'response_returned');
        expectPrivateLogs();
    });

    it('preserves sink failure classification, wording, and a single send attempt', async () => {
        const message = `${errorMarker}:${groupId}`;
        const run = vi.fn(async (_params: JsonObject, sink?: StreamSink) => {
            await sink!.send({ payload: frameMarker });
            return { status: 'ok', retcode: 0, data: null } as ApiResponse;
        });
        const api = fixture(run, action, 'stream');
        const send = vi.fn(async () => {
            throw new StreamTransportClosedError(message);
        });
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const params = { group_id: groupId, extra: inputMarker };
        const response = await api.handle(action, params, { send });
        expect(response).toEqual({ status: 'failed', retcode: 100, data: null, wording: message });
        expect(run).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledExactlyOnceWith({ payload: frameMarker });
        expect(records[0]?.params).toBe(params);
        expect(records[0]?.response).toBe(response);
        expect(logs()[2]?.message).toBe(`action_stream_frame action=${action} frame=[redacted]`);
        expect(logs()[3]?.message).toBe(`${action} failed: [redacted]`);
        expectTerminal('cancelled', 'transport_closed');
        expectPrivateLogs();
    });

    it('keeps stream emission and echo intact with a synthetic stream registry', async () => {
        const frame = { type: 'stream', payload: frameMarker, group_id: groupId };
        const terminal = { type: 'response', payload: resultMarker };
        const run = vi.fn(async (_params: JsonObject, sink?: StreamSink) => {
            await sink!.send(frame);
            return { status: 'ok', retcode: 0, data: terminal } as ApiResponse;
        });
        const api = fixture(run, action, 'stream');
        const sent: string[] = [];
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        await api.processStreamRequest(
            JSON.stringify({
                action,
                params: { group_id: groupId, extra: inputMarker },
                echo: 'fixture-echo',
            }),
            (value) => {
                sent.push(value);
            },
        );
        expect(run).toHaveBeenCalledOnce();
        expect(sent.map((value) => JSON.parse(value))).toEqual([
            {
                status: 'ok',
                retcode: 0,
                data: frame,
                message: '',
                wording: '',
                stream: 'stream-action',
                echo: 'fixture-echo',
            },
            {
                status: 'ok',
                retcode: 0,
                data: terminal,
                stream: 'stream-action',
                echo: 'fixture-echo',
                message: '',
                wording: '',
            },
        ]);
        expect(records).toHaveLength(1);
        expect(records[0]?.response.data).toBe(terminal);
        expect(
            logs().some(
                (entry) =>
                    entry.message === `action_stream_frame action=${action} frame=[redacted]`,
            ),
        ).toBe(true);
        expectTerminal('ok', 'response_returned');
        expectPrivateLogs();
    });

    it('keeps the file-only debug breadcrumb redacted and without account routing', async () => {
        setLogLevel('warn');
        const run = vi.fn(async (): Promise<ApiResponse> => ({
            status: 'ok',
            retcode: 0,
            data: null,
        }));
        const response = await fixture(run).handle(action, {
            group_id: groupId,
            extra: inputMarker,
        });
        expect(response).toEqual({ status: 'ok', retcode: 0, data: null });
        expect(logs()).toEqual([]);
        expect(fileTransport.writes).toHaveLength(1);
        expect(String(fileTransport.writes[0]?.[0])).toContain(`${action} params=[redacted]`);
        expect(fileTransport.writes[0]?.[1]).toBeUndefined();
        const text = JSON.stringify(fileTransport.writes);

        for (const marker of markers) {
            expect(text).not.toContain(marker);
        }
    });

    it('propagates a throwing logger subscriber at the original warning point without retry', async () => {
        const run = vi.fn(async () => {
            throw new Error(errorMarker);
        });
        const api = fixture(run);
        const observer = vi.fn();
        api.setObserver(observer);
        const loggerError = new Error('fixture-log-subscriber-failure');
        const stop = subscribeLogs((entry) => {
            if (
                entry.scope === 'Bridge.Action' &&
                entry.message === `${action} failed: [redacted]`
            ) {
                throw loggerError;
            }
        });
        const params = { group_id: groupId, extra: inputMarker };
        const reason = await api
            .handle(action, params)
            .then(
                () => undefined,
                (error: unknown) => error,
            )
            .finally(stop);
        expect(reason).toBe(loggerError);
        expect(run).toHaveBeenCalledExactlyOnceWith(params, undefined);
        expect(observer).not.toHaveBeenCalled();
        expect(logs().map((entry) => entry.level)).toEqual(['trace', 'debug', 'warn']);
        expectPrivateLogs();
    });

    it('propagates a logger failure during observer error reporting before the next observer', async () => {
        const returned: ApiResponse = { status: 'ok', retcode: 0, data: null };
        const run = vi.fn(async () => returned);
        const api = fixture(run);
        const laterObserver = vi.fn();
        api.setObserver(() => {
            throw new Error(observerMarker);
        });
        api.setObserver(laterObserver);
        const loggerError = new Error('fixture-observer-log-subscriber-failure');
        const stop = subscribeLogs((entry) => {
            if (
                entry.scope === 'Bridge.Action' &&
                entry.message === `${action} action observer error: [redacted]`
            ) {
                throw loggerError;
            }
        });
        const params = { group_id: groupId, extra: inputMarker };
        const reason = await api
            .handle(action, params)
            .then(
                () => undefined,
                (error: unknown) => error,
            )
            .finally(stop);
        expect(reason).toBe(loggerError);
        expect(run).toHaveBeenCalledExactlyOnceWith(params, undefined);
        expect(laterObserver).not.toHaveBeenCalled();
        expect(logs().map((entry) => entry.level)).toEqual(['trace', 'debug', 'trace', 'warn']);
        expectTerminal('ok', 'response_returned');
        expectPrivateLogs();
    });

    it('leaves similarly named actions and ordinary account-scoped verbose logs unchanged', async () => {
        const name = 'set_group_leave_alias';
        const params = { group_id: groupId, label: inputMarker };
        const returned: ApiResponse = { status: 'ok', retcode: 0, data: { label: resultMarker } };
        const run = vi.fn(async () => returned);
        const api = fixture(run, name, 'normal', action);
        const observer = vi.fn(() => {
            throw new Error(observerMarker);
        });
        api.setObserver(observer);
        expect(await api.handle(name, params)).toBe(returned);
        expect(run).toHaveBeenCalledExactlyOnceWith(params, undefined);
        expect(observer).toHaveBeenCalledOnce();
        expect(logs().map((entry) => entry.level)).toEqual(['trace', 'debug', 'trace', 'warn']);
        expect(logs().every((entry) => entry.uin === accountId)).toBe(true);
        expect(logs()[0]?.message).toBe(
            `action_input action=${name} params={group_id:${groupId},label:"${inputMarker}"}`,
        );
        expect(logs()[1]?.message).toBe(
            `${name} params=group_id=${groupId} label="${inputMarker}"`,
        );
        expect(logs()[2]?.message).toContain(
            `response={status:"ok",retcode:0,data:{label:"${resultMarker}"}}`,
        );
        expect(logs()[3]?.message).toBe(`action observer error: ${observerMarker}`);
        expect(fileTransport.writes.every((args) => args[1] === accountId)).toBe(true);
    });

    it('leaves a similarly named stream frame and handler error verbose', async () => {
        const name = 'set_group_leave_alias';
        const frame = { group_id: groupId, payload: frameMarker };
        const run = vi.fn(async (_params: JsonObject, sink?: StreamSink) => {
            await sink!.send(frame);
            throw new Error(errorMarker);
        });
        const api = fixture(run, name, 'stream', action);
        const send = vi.fn(async (_frame: JsonValue) => undefined);
        const result = await api.handle(name, { group_id: groupId }, { send });
        expect(run).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledExactlyOnceWith(frame);
        expect(result).toEqual({
            status: 'failed',
            retcode: 100,
            data: null,
            wording: errorMarker,
        });
        expect(logs().every((entry) => entry.uin === accountId)).toBe(true);
        expect(logs()[2]?.message).toBe(
            `action_stream_frame action=${name} frame={group_id:${groupId},payload:"${frameMarker}"}`,
        );
        expect(logs()[3]?.message).toContain(`${name} failed: ${errorMarker}`);
        expect(logs()[4]?.message).toContain(`wording:"${errorMarker}"`);
    });
});
