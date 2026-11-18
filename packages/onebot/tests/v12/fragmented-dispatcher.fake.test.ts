import dgram from 'node:dgram';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '@snowluma/common/logger';
import type { JsonObject } from '../../src/types';
import type { V12CoreOptions, V12FileLease, V12Response } from '../../src/v12/types';
import type {
    V12FragmentChunkResult,
    V12FragmentMetadataResult,
    V12FragmentUploadFinishResult,
    V12FragmentUploadPrepareResult,
    V12FragmentUploadTransferResult,
} from '../../src/v12/uploaded-data-store';

// Only V12Dispatcher is instantiated. These module fakes detect accidental
// construction; neither a transport nor a V11 handler is needed by this suite.
const forbidden = vi.hoisted(() => ({ attempts: [] as string[] }));
vi.mock('@snowluma/websocket', () => ({
    WebSocket: class {
        constructor() {
            forbidden.attempts.push('WebSocket');
            throw new Error('unexpected WebSocket');
        }
    },
    WebSocketServer: class {
        constructor() {
            forbidden.attempts.push('WebSocketServer');
            throw new Error('unexpected WebSocketServer');
        }
    },
}));
vi.mock('@snowluma/sqlite', () => ({
    SqliteDatabase: class {
        constructor() {
            forbidden.attempts.push('SqliteDatabase');
            throw new Error('unexpected SQLite');
        }
    },
}));
vi.mock('../../src/api-handler', () => ({
    ApiHandler: class {
        constructor() {
            forbidden.attempts.push('ApiHandler');
            throw new Error('unexpected real V11 handler');
        }
    },
}));

let dispatcherModule: typeof import('../../src/v12/dispatcher');
let logger: typeof import('@snowluma/common/logger');
let previousLevel: string;
let unsubscribe: () => void;
let entries: LogEntry[];
let guards: Array<{ mock: { calls: unknown[] } }>;
let consoleGuards: Array<{ mock: { calls: unknown[][] } }>;
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;

function blocked(): never {
    throw new Error('unexpected network or native operation in dispatcher fixture');
}

beforeEach(async () => {
    forbidden.attempts.length = 0;
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
    consoleGuards = [
        vi.spyOn(console, 'log').mockImplementation(() => {}),
        vi.spyOn(console, 'debug').mockImplementation(() => {}),
        vi.spyOn(console, 'info').mockImplementation(() => {}),
        vi.spyOn(console, 'warn').mockImplementation(() => {}),
        vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];

    // Install every network/native guard before loading the subject or logger.
    dispatcherModule = await import('../../src/v12/dispatcher');
    logger = await import('@snowluma/common/logger');
    previousLevel = logger.getLogLevel();
    logger.setLogLevel('trace');
    entries = [];
    unsubscribe = logger.subscribeLogs((entry) => entries.push(entry));
});

afterEach(() => {
    const calls = guards.map((guard) => guard.mock.calls.length);
    const fetchCalls = fetchGuard.mock.calls.length;
    const webSocketCalls = webSocketGuard.mock.calls.length;
    const attempts = [...forbidden.attempts];
    unsubscribe();
    logger.setLogLevel(previousLevel);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    expect(calls).toEqual(calls.map(() => 0));
    expect(fetchCalls).toBe(0);
    expect(webSocketCalls).toBe(0);
    expect(attempts).toEqual([]);
});

const MAX_BYTES = 256 * 1024;
const SELF = { platform: 'qq', user_id: '10001' };
const PREFIX = 'jiyu-upload:v1:';
const FILE_ID = PREFIX + 'A'.repeat(43);
const MISSING_ID = PREFIX + 'B' + 'A'.repeat(42);
const NAME = 'SYNTHETIC_PRIVATE_FILE_霁羽🪶.bin';
const ERROR_MARKER = 'SYNTHETIC_PRIVATE_CALLBACK_ERROR_X741';
const UNKNOWN_ACTION = 'SYNTHETIC_PRIVATE_UNKNOWN_ACTION_X742';
const BYTES = Buffer.from([0, 255, 128, 1, 2, 3, 10, 13, 47, 92, 127]);
const STALE_BYTES = Buffer.from('SYNTHETIC_STALE_BYTES_X741');
const STALE_DATA = STALE_BYTES.toString('base64');
// A structurally valid synthetic value, deliberately not claimed as the hash of BYTES.
const SHA256 = '0'.repeat(64);

function fixture(bytes = BYTES, overrides: Partial<V12CoreOptions> = {}) {
    const state = { current: true, throws: false, known: true };
    const lease = vi.fn(() => {
        if (state.throws) {
            throw new Error(ERROR_MARKER);
        }

        return state.current;
    });
    const api = {
        handle: vi.fn(async (_action: string, _params: JsonObject) => ({
            status: 'ok' as const,
            retcode: 0,
            data: { file_name: 'legacy.bin', url: 'https://fixture.invalid/legacy' },
        })),
    };
    const uploadDataFile = vi.fn(() => ({ kind: 'ok' as const, fileId: FILE_ID }));
    const getUploadedDataFile = vi.fn(() => ({
        kind: 'ok' as const,
        name: NAME,
        data: bytes.toString('base64'),
        sha256: SHA256,
    }));
    const getUploadedDataFileMetadata = vi.fn(
        (fileId: string, _lease?: V12FileLease): V12FragmentMetadataResult =>
            state.known && fileId === FILE_ID
                ? { kind: 'ok', name: NAME, totalSize: bytes.length, sha256: SHA256 }
                : { kind: 'not_found' },
    );
    const getUploadedDataFileChunk = vi.fn(
        (
            fileId: string,
            offset: number,
            size: number,
            _lease?: V12FileLease,
        ): V12FragmentChunkResult => {
            if (!state.known || fileId !== FILE_ID) {
                return { kind: 'not_found' };
            }

            if (offset > bytes.length || size > bytes.length - offset) {
                return { kind: 'invalid_range' };
            }

            return { kind: 'ok', data: bytes.subarray(offset, offset + size).toString('base64') };
        },
    );
    const isUploadDataSupported = vi.fn((candidate?: V12FileLease) =>
        candidate === undefined ? true : candidate() === true,
    );
    const options: V12CoreOptions = {
        self: SELF,
        version: { impl: 'fixture', version: '1' },
        api,
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime: () => null,
        uploadDataFile,
        getUploadedDataFile,
        getUploadedDataFileMetadata,
        getUploadedDataFileChunk,
        isUploadDataSupported,
        ...overrides,
    };
    const dispatcher = new dispatcherModule.V12Dispatcher(options);
    return {
        state,
        lease,
        api,
        options,
        dispatcher,
        uploadDataFile,
        getUploadedDataFile,
        getUploadedDataFileMetadata,
        getUploadedDataFileChunk,
        isUploadDataSupported,
    };
}

type Fixture = ReturnType<typeof fixture>;

function prepare(fileId: unknown = FILE_ID, extra: object = {}) {
    return { stage: 'prepare', file_id: fileId, ...extra };
}

function transfer(fileId: unknown = FILE_ID, offset: unknown = 0, size: unknown = 1) {
    return { stage: 'transfer', file_id: fileId, offset, size };
}

function request(params: unknown, extra: object = {}) {
    return { action: 'get_file_fragmented', params, ...extra };
}

function failed(result: V12Response, retcode?: number): void {
    expect(result.status).toBe('failed');
    expect(result.retcode).not.toBe(0);
    expect(result.data).toBeNull();

    if (retcode !== undefined) {
        expect(result.retcode).toBe(retcode);
    }
}

function noDataProviders(f: Fixture): void {
    expect(f.uploadDataFile).not.toHaveBeenCalled();
    expect(f.getUploadedDataFile).not.toHaveBeenCalled();
    expect(f.getUploadedDataFileMetadata).not.toHaveBeenCalled();
    expect(f.getUploadedDataFileChunk).not.toHaveBeenCalled();
    expect(f.api.handle).not.toHaveBeenCalled();
}

function hiddenField(source: Record<string, unknown>, key: string): object {
    const copy = { ...source };
    Object.defineProperty(copy, key, { value: copy[key], enumerable: false });
    return copy;
}

function noPrivateResult(result: V12Response): void {
    const text = JSON.stringify(result);

    for (const marker of [
        FILE_ID,
        NAME,
        ERROR_MARKER,
        SHA256,
        BYTES.toString('base64'),
        STALE_DATA,
    ]) {
        expect(text).not.toContain(marker);
    }
}

describe('get_file_fragmented on the real V12 dispatcher with synthetic callbacks', () => {
    it('advertises exactly once when all callbacks are ready and the lease is current', async () => {
        const f = fixture();
        const supported = await f.dispatcher.handle(
            { action: 'get_supported_actions', params: {} },
            f.lease,
        );
        expect(supported).toMatchObject({ status: 'ok', retcode: 0 });
        expect(Array.isArray(supported.data)).toBe(true);
        expect(
            (supported.data as unknown[]).filter((value) => value === 'get_file_fragmented'),
        ).toHaveLength(1);
        expect(supported.data).toContain('upload_file');
        expect(f.isUploadDataSupported).toHaveBeenCalledWith(f.lease);
        expect(f.lease).toHaveBeenCalled();
        noDataProviders(f);
    });

    it.each([
        'uploadDataFile',
        'getUploadedDataFile',
        'getUploadedDataFileMetadata',
        'getUploadedDataFileChunk',
    ] as const)('does not advertise or invoke a provider when %s is absent', async (missing) => {
        const f = fixture(BYTES, { [missing]: undefined });
        const supported = await f.dispatcher.handle(
            { action: 'get_supported_actions', params: {} },
            f.lease,
        );
        expect(supported.data).not.toContain('get_file_fragmented');
        failed(await f.dispatcher.handle(request(prepare()), f.lease), 10002);
        failed(await f.dispatcher.handle(request(transfer()), f.lease), 10002);
        noDataProviders(f);
    });

    it.each(['false', 'throw', 'revoked', 'lease-throw'] as const)(
        'does not advertise or call providers when readiness is %s',
        async (mode) => {
            const f = fixture();

            if (mode === 'false') {
                f.isUploadDataSupported.mockReturnValue(false);
            } else if (mode === 'throw') {
                f.isUploadDataSupported.mockImplementation(() => {
                    throw new Error(ERROR_MARKER);
                });
            } else if (mode === 'revoked') {
                f.state.current = false;
            } else {
                f.state.throws = true;
            }

            const supported = await f.dispatcher.handle(
                { action: 'get_supported_actions', params: {} },
                f.lease,
            );
            expect(supported.data).not.toContain('get_file_fragmented');
            const result = await f.dispatcher.handle(request(prepare(), { echo: '' }), f.lease);
            failed(result, 10002);
            expect(result.echo).toBe('');
            noPrivateResult(result);
            noDataProviders(f);
        },
    );

    it.each(['getUploadedDataFileMetadata', 'getUploadedDataFileChunk'] as const)(
        'rejects an accessor capability without invoking %s',
        async (key) => {
            const f = fixture();
            const provider = f.options[key];
            let reads = 0;
            Object.defineProperty(f.options, key, {
                configurable: true,
                get() {
                    reads++;

                    if (reads === 2) {
                        f.state.current = false;
                    }

                    return provider;
                },
            });
            const supported = await f.dispatcher.handle(
                { action: 'get_supported_actions', params: {} },
                f.lease,
            );
            expect(reads).toBe(0);
            expect(supported.data).not.toContain('get_file_fragmented');
            expect(f.lease).toHaveBeenCalled();
            noDataProviders(f);
        },
    );

    it('keeps a changing readiness result consistent within one supported-actions list', async () => {
        const f = fixture();
        let calls = 0;
        f.options.isUploadDataSupported = () => ++calls > 1;
        const supported = await f.dispatcher.handle(
            { action: 'get_supported_actions', params: {} },
            f.lease,
        );
        expect(supported.data).not.toContain('upload_file');
        expect(supported.data).not.toContain('get_file_fragmented');
        expect(calls).toBe(1);
    });

    it('drops local capabilities if discovery itself revokes the lease', async () => {
        const f = fixture();
        let checks = 0;

        f.options.isUploadDataSupported = () => {
            if (++checks === 2) {
                f.state.current = false;
            }

            return true;
        };

        const result = await f.dispatcher.handle(
            { action: 'get_supported_actions', params: {} },
            f.lease,
        );
        expect(result.retcode).toBe(0);
        expect(result.data).not.toContain('upload_file');
        expect(result.data).not.toContain('get_file_fragmented');
        expect(checks).toBe(2);
    });

    it('prevents discovery readiness from synchronously reentering a fragment', async () => {
        const f = fixture();
        let nested: Promise<V12Response> | undefined;
        let once = true;

        f.options.isUploadDataSupported = () => {
            if (once) {
                once = false;
                nested = f.dispatcher.handle(request(prepare()), f.lease);
            }

            return true;
        };

        const supported = await f.dispatcher.handle(
            { action: 'get_supported_actions', params: {} },
            f.lease,
        );
        expect(supported.data).toContain('get_file_fragmented');
        expect(nested).toBeDefined();
        failed(await nested!, 20002);
        noDataProviders(f);
    });

    it('fences discovery while its final lease removes a fragment callback', async () => {
        const f = fixture();
        let checks = 0;
        let nested: Promise<V12Response> | undefined;
        f.options.isUploadDataSupported = () => true;
        f.lease.mockImplementation(() => {
            if (++checks === 3) {
                f.options.getUploadedDataFileChunk = undefined;
                nested = f.dispatcher.handle(request(prepare()), f.lease);
            }

            return true;
        });
        const result = await f.dispatcher.handle(
            { action: 'get_supported_actions', params: {} },
            f.lease,
        );
        expect(checks).toBe(3);
        expect(result.data).toContain('upload_file');
        expect(result.data).not.toContain('get_file_fragmented');
        expect(nested).toBeDefined();
        failed(await nested!, 20002);
        noDataProviders(f);
    });

    it('rejects an upload callback accessor on a direct fragment request without running it', async () => {
        const f = fixture();
        let reads = 0;
        Object.defineProperty(f.options, 'uploadDataFile', {
            configurable: true,
            get() {
                reads++;
                return f.uploadDataFile;
            },
        });
        failed(await f.dispatcher.handle(request(prepare()), f.lease), 10002);
        expect(reads).toBe(0);
        noDataProviders(f);
    });

    it('preserves the optional readiness and lease convention for direct core callers', async () => {
        const f = fixture(BYTES, { isUploadDataSupported: undefined });
        const supported = await f.dispatcher.handle({
            action: 'get_supported_actions',
            params: {},
        });
        expect(supported.data).toContain('get_file_fragmented');
        const result = await f.dispatcher.handle(request(prepare()));
        expect(result).toEqual({
            status: 'ok',
            retcode: 0,
            data: { name: NAME, total_size: BYTES.length, sha256: SHA256 },
            message: '',
        });
        expect(f.getUploadedDataFileMetadata).toHaveBeenCalledExactlyOnceWith(FILE_ID);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('returns metadata, exact padded ranges, zero size and EOF with echo and self', async () => {
        const f = fixture();
        const meta = await f.dispatcher.handle(
            request(prepare(), { echo: '', self: SELF }),
            f.lease,
        );
        expect(meta).toEqual({
            status: 'ok',
            retcode: 0,
            data: { name: NAME, total_size: BYTES.length, sha256: SHA256 },
            message: '',
            echo: '',
        });
        expect(f.getUploadedDataFileMetadata).toHaveBeenCalledExactlyOnceWith(FILE_ID, f.lease);

        for (const [offset, size, echo] of [
            [0, 1, '中文回声🪶'],
            [1, 2, 'two'],
            [3, 3, 'three'],
            [0, BYTES.length, 'all'],
            [0, 0, 'zero'],
            [BYTES.length, 0, 'eof'],
        ] as const) {
            const result = await f.dispatcher.handle(
                request(transfer(FILE_ID, offset, size), { echo, self: SELF }),
                f.lease,
            );
            expect(result).toEqual({
                status: 'ok',
                retcode: 0,
                data: { data: BYTES.subarray(offset, offset + size).toString('base64') },
                message: '',
                echo,
            });
            expect(f.getUploadedDataFileChunk).toHaveBeenLastCalledWith(
                FILE_ID,
                offset,
                size,
                f.lease,
            );
        }

        expect(f.getUploadedDataFileChunk).toHaveBeenCalledTimes(6);
        expect(f.getUploadedDataFile).not.toHaveBeenCalled();
        expect(f.uploadDataFile).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('handles an empty file at its zero-size EOF', async () => {
        const f = fixture(Buffer.alloc(0));
        const meta = await f.dispatcher.handle(request(prepare()), f.lease);
        expect(meta).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: { name: NAME, total_size: 0, sha256: SHA256 },
        });
        const chunk = await f.dispatcher.handle(request(transfer(FILE_ID, 0, 0)), f.lease);
        expect(chunk).toEqual({ status: 'ok', retcode: 0, message: '', data: { data: '' } });
        expect(f.getUploadedDataFileMetadata).toHaveBeenCalledExactlyOnceWith(FILE_ID, f.lease);
        expect(f.getUploadedDataFileChunk).toHaveBeenCalledExactlyOnceWith(FILE_ID, 0, 0, f.lease);
        expect(f.getUploadedDataFile).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('accepts 256 KiB exactly, blocks a larger size, and reports out-of-range chunks', async () => {
        const bytes = Buffer.alloc(MAX_BYTES, 0x61);
        bytes[0] = 0;
        bytes[bytes.length - 1] = 255;
        const f = fixture(bytes);
        const full = await f.dispatcher.handle(request(transfer(FILE_ID, 0, MAX_BYTES)), f.lease);
        expect(full).toMatchObject({
            status: 'ok',
            retcode: 0,
            data: { data: bytes.toString('base64') },
        });
        expect(f.getUploadedDataFileChunk).toHaveBeenCalledExactlyOnceWith(
            FILE_ID,
            0,
            MAX_BYTES,
            f.lease,
        );
        f.getUploadedDataFileChunk.mockClear();
        failed(
            await f.dispatcher.handle(request(transfer(FILE_ID, 0, MAX_BYTES + 1)), f.lease),
            10004,
        );
        expect(f.getUploadedDataFileChunk).not.toHaveBeenCalled();

        for (const [offset, size] of [
            [MAX_BYTES, 1],
            [MAX_BYTES + 1, 0],
            [MAX_BYTES - 1, 2],
        ] as const) {
            const result = await f.dispatcher.handle(
                request(transfer(FILE_ID, offset, size)),
                f.lease,
            );
            failed(result, 10004);
            noPrivateResult(result);
        }

        expect(f.getUploadedDataFileChunk).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('separates missing, invalid, unsupported and nonlocal parameters before providers', async () => {
        const f = fixture();
        const cases: Array<[unknown, number]> = [
            [{}, 10003],
            [{ stage: null, file_id: FILE_ID }, 10003],
            [{ stage: 0, file_id: FILE_ID }, 10003],
            [{ stage: 'other', file_id: FILE_ID }, 10004],
            [{ stage: 'prepare' }, 10003],
            [prepare(''), 10003],
            [prepare(42), 10003],
            [prepare('x'.repeat(4097)), 10003],
            [prepare(FILE_ID, { offset: 0 }), 10004],
            [prepare(FILE_ID, { extra: true }), 10004],
            [{ stage: 'transfer', file_id: FILE_ID }, 10003],
            [{ stage: 'transfer', file_id: FILE_ID, offset: 0 }, 10003],
            [{ ...transfer(), extra: true }, 10004],
            [transfer(FILE_ID, -1, 1), 10003],
            [transfer(FILE_ID, 0, -1), 10003],
            [transfer(FILE_ID, 0.5, 1), 10003],
            [transfer(FILE_ID, 0, 1.5), 10003],
            [transfer(FILE_ID, '0', 1), 10003],
            [transfer(FILE_ID, 0, '1'), 10003],
            [transfer(FILE_ID, Number.MAX_SAFE_INTEGER + 1, 0), 10003],
            [transfer(FILE_ID, 0, Number.MAX_SAFE_INTEGER + 1), 10003],
            [transfer(FILE_ID, 0, MAX_BYTES + 1), 10004],
            [transfer(FILE_ID, Number.MAX_SAFE_INTEGER, 1), 10004],
            [prepare('legacy-id'), 10004],
            [prepare('https://fixture.invalid/file'), 10004],
            [prepare('jiyu-image:v1:fixture'), 10004],
            [transfer('jiyu-voice:v1:fixture', 0, 1), 10004],
        ];

        for (const [params, code] of cases) {
            const result = await f.dispatcher.handle(
                request(params, { echo: 'validation' }),
                f.lease,
            );
            failed(result, code);
            expect(result.echo).toBe('validation');
            noPrivateResult(result);
        }

        // Non-finite values fail the common request snapshot before action parsing.
        failed(await f.dispatcher.handle(request(transfer(FILE_ID, NaN, 1)), f.lease), 10001);
        failed(await f.dispatcher.handle(request(transfer(FILE_ID, 0, Infinity)), f.lease), 10001);
        noDataProviders(f);
    });

    it('rejects hostile request accessors and proxies without evaluating them', async () => {
        const f = fixture();
        const getter = vi.fn(() => {
            throw new Error(ERROR_MARKER);
        });
        const trap = vi.fn(() => {
            throw new Error(ERROR_MARKER);
        });
        const params = { file_id: FILE_ID };
        Object.defineProperty(params, 'stage', { enumerable: true, get: getter });
        const proxied = new Proxy(prepare(), {
            get: trap,
            ownKeys: trap,
            getOwnPropertyDescriptor: trap,
        });

        for (const input of [
            request(params, { echo: 'safe' }),
            request(proxied, { echo: 'safe' }),
        ]) {
            const result = await f.dispatcher.handle(input, f.lease);
            failed(result, 10001);
            expect(result.echo).toBe('safe');
            noPrivateResult(result);
        }

        expect(getter).not.toHaveBeenCalled();
        expect(trap).not.toHaveBeenCalled();
        noDataProviders(f);
    });

    it('uses the same fixed failure for malformed, missing and expired local IDs without V11', async () => {
        const f = fixture();
        const failures: V12Response[] = [];

        for (const id of [PREFIX, `${PREFIX}%%%`, PREFIX + 'A'.repeat(42) + 'B', MISSING_ID]) {
            failures.push(await f.dispatcher.handle(request(prepare(id)), f.lease));
            failures.push(await f.dispatcher.handle(request(transfer(id, 0, 0)), f.lease));
        }

        f.state.known = false;
        failures.push(await f.dispatcher.handle(request(prepare()), f.lease));
        failures.push(await f.dispatcher.handle(request(transfer(FILE_ID, 0, 0)), f.lease));

        for (const result of failures) {
            expect(result).toEqual({
                status: 'failed',
                retcode: 20001,
                data: null,
                message: 'invalid file result',
            });
            noPrivateResult(result);
        }

        expect(f.getUploadedDataFile).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('preserves valid self and echoes but rejects a different or malformed self before providers', async () => {
        const f = fixture();
        const other = await f.dispatcher.handle(
            request(prepare(), { echo: '中文', self: { platform: 'qq', user_id: '10002' } }),
            f.lease,
        );
        expect(other).toEqual({
            status: 'failed',
            retcode: 10102,
            data: null,
            message: 'unknown self',
            echo: '中文',
        });
        failed(
            await f.dispatcher.handle(
                request(prepare(), { self: { platform: 'qq', user_id: 1 } }),
                f.lease,
            ),
            10001,
        );
        failed(
            await f.dispatcher.handle(request(prepare(), { self: { ...SELF, extra: 1 } }), f.lease),
            10004,
        );
        noDataProviders(f);
    });

    it('rejects a JSON-escaped oversized success before invoking the chunk provider', async () => {
        const f = fixture();
        const echo = '"\\\n'.repeat(200_000);
        expect(echo.length).toBeLessThanOrEqual(1_048_576);
        expect(Buffer.byteLength(JSON.stringify(echo), 'utf8')).toBeGreaterThan(1024 * 1024);
        const result = await f.dispatcher.handle(
            request(transfer(FILE_ID, 0, 1), { echo }),
            f.lease,
        );
        failed(result, 10003);
        expect(result.echo === echo).toBe(true);
        noDataProviders(f);
    });
});

describe('fragment provider boundaries and stale leases', () => {
    it('discards a provider result if its callback removes an upload capability', async () => {
        const f = fixture();

        f.options.getUploadedDataFileMetadata = () => {
            f.options.uploadDataFile = undefined;
            return { kind: 'ok', name: NAME, totalSize: BYTES.length, sha256: SHA256 };
        };

        const result = await f.dispatcher.handle(request(prepare()), f.lease);
        failed(result, 20002);
        noPrivateResult(result);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it.each([
        ['prepare', 'ok', 'false'],
        ['prepare', 'not_found', 'throw'],
        ['transfer', 'ok', 'false'],
        ['transfer', 'invalid_range', 'throw'],
    ] as const)(
        'rechecks %s readiness after a %s provider result (%s)',
        async (stage, kind, effect) => {
            const f = fixture();
            let ready = true;
            const calls: Array<{ receiver: unknown; lease: V12FileLease | undefined }> = [];

            f.options.isUploadDataSupported = function (candidate) {
                calls.push({ receiver: this, lease: candidate });

                if (!ready && effect === 'throw') {
                    throw new Error(ERROR_MARKER);
                }

                return ready;
            };

            if (stage === 'prepare') {
                f.options.getUploadedDataFileMetadata = () => {
                    ready = false;
                    return kind === 'ok'
                        ? { kind: 'ok', name: NAME, totalSize: BYTES.length, sha256: SHA256 }
                        : { kind: 'not_found' };
                };
            } else {
                f.options.getUploadedDataFileChunk = () => {
                    ready = false;
                    return kind === 'ok' ? { kind: 'ok', data: 'AA==' } : { kind: 'invalid_range' };
                };
            }

            const result = await f.dispatcher.handle(
                request(stage === 'prepare' ? prepare() : transfer()),
                f.lease,
            );
            failed(result, 20002);
            noPrivateResult(result);
            expect(calls.length).toBeGreaterThanOrEqual(3);

            for (const call of calls) {
                expect(call.receiver).toBe(f.options);
                expect(call.lease).toBe(f.lease);
            }
        },
    );

    it('blocks nested fragments during an ABA provider callback', async () => {
        const f = fixture();
        let nested: Promise<V12Response> | undefined;

        f.options.getUploadedDataFileMetadata = () => {
            const upload = f.options.uploadDataFile;
            f.options.uploadDataFile = undefined;
            nested = f.dispatcher.handle(request(prepare()), f.lease);
            f.options.uploadDataFile = upload;
            return { kind: 'ok', name: NAME, totalSize: BYTES.length, sha256: SHA256 };
        };

        const outer = await f.dispatcher.handle(request(prepare()), f.lease);
        expect(outer.retcode).toBe(0);
        expect(nested).toBeDefined();
        failed(await nested!, 20002);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('blocks nested fragments during readiness checks', async () => {
        const f = fixture();
        let nested: Promise<V12Response> | undefined;

        f.options.isUploadDataSupported = () => {
            nested = f.dispatcher.handle(request(prepare()), f.lease);
            return true;
        };

        const outer = await f.dispatcher.handle(request(prepare()), f.lease);
        expect(outer.retcode).toBe(0);
        expect(nested).toBeDefined();
        failed(await nested!, 20002);
        expect(f.api.handle).not.toHaveBeenCalled();
    });
    it('rejects proxy, missing kind, accessors and malformed metadata without evaluating traps', async () => {
        const f = fixture();
        const trap = vi.fn(() => {
            throw new Error(ERROR_MARKER);
        });
        const getter = vi.fn(() => {
            throw new Error(ERROR_MARKER);
        });
        const proxy = new Proxy(
            { kind: 'ok', name: NAME, totalSize: BYTES.length, sha256: SHA256 },
            {
                get: trap,
                ownKeys: trap,
                getOwnPropertyDescriptor: trap,
            },
        );
        const getterKind = Object.defineProperty({}, 'kind', { enumerable: true, get: getter });
        const getterName = Object.defineProperty(
            { kind: 'ok', totalSize: BYTES.length, sha256: SHA256 },
            'name',
            { enumerable: true, get: getter },
        );
        const getterSize = Object.defineProperty(
            { kind: 'ok', name: NAME, sha256: SHA256 },
            'totalSize',
            { enumerable: true, get: getter },
        );
        const getterSha = Object.defineProperty(
            { kind: 'ok', name: NAME, totalSize: BYTES.length },
            'sha256',
            { enumerable: true, get: getter },
        );
        const valid = { kind: 'ok', name: NAME, totalSize: BYTES.length, sha256: SHA256 };
        const badResults: unknown[] = [
            proxy,
            null,
            [],
            {},
            { ...valid, kind: 'unknown' },
            getterKind,
            getterName,
            getterSize,
            getterSha,
            ...['kind', 'name', 'totalSize', 'sha256'].map((key) => hiddenField(valid, key)),
            { ...valid, name: 123 },
            { ...valid, name: 'x'.repeat(4097) },
            { ...valid, sha256: 'A'.repeat(64) },
            { ...valid, sha256: 'x'.repeat(64) },
            { ...valid, sha256: '0'.repeat(63) },
            { ...valid, sha256: null },
            { ...valid, totalSize: -1 },
            { ...valid, totalSize: 1.5 },
            { ...valid, totalSize: MAX_BYTES + 1 },
            { ...valid, totalSize: Number.MAX_SAFE_INTEGER + 1 },
            { ...valid, totalSize: '1' },
            { ...valid, totalSize: NaN },
            { kind: 'unavailable' },
        ];

        for (const value of badResults) {
            f.getUploadedDataFileMetadata.mockReturnValueOnce(value as V12FragmentMetadataResult);
            const result = await f.dispatcher.handle(request(prepare(), { echo: 'safe' }), f.lease);
            failed(result, 20002);
            expect(result.message).toBe('file unavailable');
            noPrivateResult(result);
        }

        expect(trap).not.toHaveBeenCalled();
        expect(getter).not.toHaveBeenCalled();
        expect(f.getUploadedDataFileChunk).not.toHaveBeenCalled();
        expect(f.getUploadedDataFile).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('rejects proxy, accessors, noncanonical Base64 and decoded length mismatches', async () => {
        const f = fixture();
        const trap = vi.fn(() => {
            throw new Error(ERROR_MARKER);
        });
        const getter = vi.fn(() => {
            throw new Error(ERROR_MARKER);
        });
        const proxy = new Proxy(
            { kind: 'ok', data: 'AA==' },
            {
                get: trap,
                ownKeys: trap,
                getOwnPropertyDescriptor: trap,
            },
        );
        const getterKind = Object.defineProperty({}, 'kind', { enumerable: true, get: getter });
        const getterData = Object.defineProperty({ kind: 'ok' }, 'data', {
            enumerable: true,
            get: getter,
        });
        const badResults: unknown[] = [
            proxy,
            null,
            [],
            {},
            getterKind,
            getterData,
            { kind: 'unknown', data: 'AA==' },
            hiddenField({ kind: 'ok', data: 'AA==' }, 'kind'),
            hiddenField({ kind: 'ok', data: 'AA==' }, 'data'),
            { kind: 'ok', data: null },
            { kind: 'ok', data: 'AA' },
            { kind: 'ok', data: 'AA===' },
            { kind: 'ok', data: 'AA==\n' },
            { kind: 'ok', data: '-_==' },
            { kind: 'ok', data: 'AB==' },
            { kind: 'ok', data: 'AAB=' },
            { kind: 'ok', data: '' },
            { kind: 'ok', data: 'AAA=' },
            { kind: 'ok', data: 'AAAA' },
            { kind: 'ok', data: Buffer.alloc(MAX_BYTES + 1).toString('base64') },
            { kind: 'unavailable' },
        ];

        for (const value of badResults) {
            f.getUploadedDataFileChunk.mockReturnValueOnce(value as V12FragmentChunkResult);
            const result = await f.dispatcher.handle(
                request(transfer(FILE_ID, 0, 1), { echo: 'safe' }),
                f.lease,
            );
            failed(result, 20002);
            expect(result.message).toBe('file unavailable');
            noPrivateResult(result);
        }

        // Each nonzero-pad-bit example has the requested decoded length; this
        // isolates canonical-bit validation from the separate length check.
        for (const [data, size] of [
            ['AB==', 1],
            ['AAB=', 2],
        ] as const) {
            expect(Buffer.from(data, 'base64').length).toBe(size);
            f.getUploadedDataFileChunk.mockReturnValueOnce({ kind: 'ok', data });
            const result = await f.dispatcher.handle(request(transfer(FILE_ID, 0, size)), f.lease);
            failed(result, 20002);
            noPrivateResult(result);
        }

        // Even a canonical nonempty result is wrong for a zero-byte request.
        f.getUploadedDataFileChunk.mockReturnValueOnce({ kind: 'ok', data: 'AA==' });
        failed(await f.dispatcher.handle(request(transfer(FILE_ID, 0, 0)), f.lease), 20002);
        expect(trap).not.toHaveBeenCalled();
        expect(getter).not.toHaveBeenCalled();
        expect(f.getUploadedDataFileMetadata).not.toHaveBeenCalled();
        expect(f.getUploadedDataFile).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it.each(['prepare', 'transfer'] as const)(
        'contains a throwing %s callback and its error',
        async (stage) => {
            const f = fixture();
            const provider =
                stage === 'prepare' ? f.getUploadedDataFileMetadata : f.getUploadedDataFileChunk;
            provider.mockImplementationOnce(() => {
                throw new Error(`${ERROR_MARKER} ${FILE_ID} ${NAME} ${SHA256}`);
            });
            const params = stage === 'prepare' ? prepare() : transfer();
            const result = await f.dispatcher.handle(request(params, { echo: 'safe' }), f.lease);
            failed(result, 20002);
            noPrivateResult(result);
            expect(provider).toHaveBeenCalledOnce();
            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );

    it.each(['false', 'throw'] as const)(
        'rechecks a %s lease when a prepared ordinary token is consumed',
        async (effect) => {
            const f = fixture();
            const preflight = f.dispatcher.createInternalHttpPreflight(f.lease);
            const prepared = preflight.classify(request(prepare(), { echo: 'safe' }));
            expect(prepared.kind).toBe('ordinary');

            if (prepared.kind !== 'ordinary') {
                throw new Error('expected an ordinary dispatcher token');
            }

            f.state.current = false;
            f.state.throws = effect === 'throw';
            const result = await f.dispatcher.handlePreparedOrdinary(prepared.token);
            failed(result, 10002);
            expect(result.echo).toBe('safe');
            noPrivateResult(result);
            failed(await f.dispatcher.handlePreparedOrdinary(prepared.token), 10001);
            noDataProviders(f);
        },
    );

    it.each(['getUploadedDataFileMetadata', 'getUploadedDataFileChunk'] as const)(
        'contains a throwing %s options getter during capability admission',
        async (key) => {
            const f = fixture();
            const getter = vi.fn(() => {
                throw new Error(ERROR_MARKER);
            });
            Object.defineProperty(f.options, key, { configurable: true, get: getter });
            const supported = await f.dispatcher.handle(
                { action: 'get_supported_actions', params: {} },
                f.lease,
            );
            expect(supported.data).not.toContain('get_file_fragmented');
            const result = await f.dispatcher.handle(request(prepare(), { echo: 'safe' }), f.lease);
            failed(result, 10002);
            noPrivateResult(result);
            expect(getter).not.toHaveBeenCalled();
            noDataProviders(f);
        },
    );

    it.each([
        ['prepare', 'false'],
        ['prepare', 'throw'],
        ['transfer', 'false'],
        ['transfer', 'throw'],
    ] as const)(
        'checks a %s lease that becomes %s before calling the provider',
        async (stage, effect) => {
            const f = fixture();
            let checks = 0;
            f.lease.mockImplementation(() => {
                checks++;

                // Readiness and admission consume the first two checks; revoke on
                // the explicit lease check just before calling the provider.
                if (checks === 3) {
                    if (effect === 'throw') {
                        throw new Error(ERROR_MARKER);
                    }

                    return false;
                }

                return true;
            });
            const result = await f.dispatcher.handle(
                request(stage === 'prepare' ? prepare() : transfer()),
                f.lease,
            );
            expect(checks).toBe(3);
            failed(result, 20002);
            noPrivateResult(result);
            noDataProviders(f);
        },
    );

    it.each([
        ['prepare', 'false'],
        ['prepare', 'throw'],
        ['transfer', 'false'],
        ['transfer', 'throw'],
    ] as const)(
        'checks a %s lease that becomes %s after callback consumption',
        async (stage, effect) => {
            const f = fixture();

            const close = () => {
                f.state.current = false;
                f.state.throws = effect === 'throw';
            };

            if (stage === 'prepare') {
                f.getUploadedDataFileMetadata.mockImplementationOnce(() => {
                    close();
                    return { kind: 'ok', name: NAME, totalSize: BYTES.length, sha256: SHA256 };
                });
            } else {
                f.getUploadedDataFileChunk.mockImplementationOnce(() => {
                    close();
                    return { kind: 'ok', data: STALE_DATA };
                });
            }

            const params =
                stage === 'prepare' ? prepare() : transfer(FILE_ID, 0, STALE_BYTES.length);
            const result = await f.dispatcher.handle(request(params, { echo: 'safe' }), f.lease);
            failed(result, 20002);
            noPrivateResult(result);
            expect(
                stage === 'prepare' ? f.getUploadedDataFileMetadata : f.getUploadedDataFileChunk,
            ).toHaveBeenCalledOnce();
            expect(f.lease.mock.calls.length).toBeGreaterThan(1);
            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );

    it.each([
        ['prepare', 'not_found'],
        ['transfer', 'not_found'],
        ['transfer', 'invalid_range'],
    ] as const)('hides stale %s %s results after the lease is revoked', async (stage, kind) => {
        const f = fixture();

        if (stage === 'prepare') {
            f.getUploadedDataFileMetadata.mockImplementationOnce(() => {
                f.state.current = false;
                return { kind: 'not_found' };
            });
        } else {
            f.getUploadedDataFileChunk.mockImplementationOnce(() => {
                f.state.current = false;
                return { kind };
            });
        }

        const result = await f.dispatcher.handle(
            request(stage === 'prepare' ? prepare() : transfer(), { echo: 'safe' }),
            f.lease,
        );
        failed(result, 20002);
        expect(result.message).toBe('file unavailable');
        noPrivateResult(result);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it.each(['prepare', 'transfer'] as const)(
        'discards a stale %s success after synchronous close and reentrant dispatch',
        async (stage) => {
            const f = fixture();
            let nested: Promise<V12Response> | undefined;
            let returnedStale = false;
            const params =
                stage === 'prepare' ? prepare() : transfer(FILE_ID, 0, STALE_BYTES.length);

            const closeAndReenter = () => {
                f.state.current = false;
                nested = f.dispatcher.handle(request(params), f.lease);
                returnedStale = true;
            };

            if (stage === 'prepare') {
                f.getUploadedDataFileMetadata.mockImplementationOnce(() => {
                    closeAndReenter();
                    return { kind: 'ok', name: NAME, totalSize: BYTES.length, sha256: SHA256 };
                });
            } else {
                f.getUploadedDataFileChunk.mockImplementationOnce(() => {
                    closeAndReenter();
                    return { kind: 'ok', data: STALE_DATA };
                });
            }

            const result = await f.dispatcher.handle(request(params), f.lease);
            expect(returnedStale).toBe(true);
            expect(nested).toBeDefined();
            failed(result, 20002);
            noPrivateResult(result);
            failed(await nested!, 20002);
            expect(
                stage === 'prepare' ? f.getUploadedDataFileMetadata : f.getUploadedDataFileChunk,
            ).toHaveBeenCalledOnce();
            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );
});

describe('ordinary actions and diagnostic privacy', () => {
    it('retains ordinary meta and V11 get_file URL behavior independently of fragmented support', async () => {
        const f = fixture();
        const version = await f.dispatcher.handle(
            { action: 'get_version', params: {}, echo: '' },
            f.lease,
        );
        expect(version).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: '',
            data: { impl: 'fixture', version: '1', onebot_version: '12' },
        });
        const old = await f.dispatcher.handle(
            {
                action: 'get_file',
                params: { file_id: 'legacy-id', type: 'url' },
                echo: '旧版',
            },
            f.lease,
        );
        expect(old).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: '旧版',
            data: { name: 'legacy.bin', url: 'https://fixture.invalid/legacy' },
        });
        expect(f.api.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: 'legacy-id' });
        expect(f.getUploadedDataFileMetadata).not.toHaveBeenCalled();
        expect(f.getUploadedDataFileChunk).not.toHaveBeenCalled();
    });

    it('keeps unknown actions and callback failures out of observed response and logs', async () => {
        const f = fixture();
        const unknown = await f.dispatcher.handle(
            { action: UNKNOWN_ACTION, params: { file_id: FILE_ID }, echo: 'safe' },
            f.lease,
        );
        failed(unknown, 10002);
        expect(JSON.stringify(unknown)).not.toContain(UNKNOWN_ACTION);
        noPrivateResult(unknown);
        expect(f.api.handle).not.toHaveBeenCalled();
        f.getUploadedDataFileMetadata.mockImplementationOnce(() => {
            throw new Error(`${ERROR_MARKER} ${FILE_ID} ${NAME} ${SHA256}`);
        });
        f.getUploadedDataFileChunk.mockImplementationOnce(() => {
            throw new Error(`${ERROR_MARKER} ${FILE_ID} ${NAME} ${BYTES.toString('base64')}`);
        });

        for (const params of [prepare(), transfer()]) {
            const result = await f.dispatcher.handle(request(params, { echo: 'safe' }), f.lease);
            failed(result, 20002);
            noPrivateResult(result);
        }

        // This inspects the logger subscription and console calls during these
        // direct dispatcher scenarios, not unrelated transports or log sinks.
        const observed =
            JSON.stringify(entries) +
            consoleGuards
                .flatMap((guard) => guard.mock.calls)
                .flat()
                .map((value) => String(value))
                .join('\n');

        for (const marker of [
            UNKNOWN_ACTION,
            ERROR_MARKER,
            FILE_ID,
            NAME,
            SHA256,
            BYTES.toString('base64'),
        ]) {
            expect(observed).not.toContain(marker);
        }

        expect(f.api.handle).not.toHaveBeenCalled();
    });
});

const UPLOAD_ACTION = 'upload_file_fragmented';
const DRAFT_PREFIX = 'jiyu-upload-draft:v1:';
const DRAFT_ID = DRAFT_PREFIX + 'A'.repeat(43);
const MISSING_DRAFT_ID = DRAFT_PREFIX + 'B' + 'A'.repeat(42);
const UPLOAD_DATA = BYTES.toString('base64');
const DISCOVERY = { action: 'get_supported_actions', params: {} };
const UPLOAD_CAPABILITIES = [
    'prepareUploadFileFragments',
    'transferUploadFileFragment',
    'finishUploadFileFragments',
    'uploadDataFile',
    'getUploadedDataFile',
] as const;

function uploadFixture(overrides: Partial<V12CoreOptions> = {}) {
    const prepareUploadFileFragments = vi.fn(
        (_name: string, _size: number, _guard?: V12FileLease): V12FragmentUploadPrepareResult => ({
            kind: 'ok',
            draftId: DRAFT_ID,
        }),
    );
    const transferUploadFileFragment = vi.fn(
        (
            _id: string,
            _offset: number,
            _data: string,
            _guard?: V12FileLease,
        ): V12FragmentUploadTransferResult => ({ kind: 'ok' }),
    );
    const finishUploadFileFragments = vi.fn(
        (_id: string, _digest: string, _guard?: V12FileLease): V12FragmentUploadFinishResult => ({
            kind: 'ok',
            fileId: FILE_ID,
        }),
    );
    return {
        ...fixture(BYTES, {
            prepareUploadFileFragments,
            transferUploadFileFragment,
            finishUploadFileFragments,
            ...overrides,
        }),
        prepareUploadFileFragments,
        transferUploadFileFragment,
        finishUploadFileFragments,
    };
}

type UploadFixture = ReturnType<typeof uploadFixture>;

function uploadPrepare(name: unknown = NAME, totalSize: unknown = BYTES.length) {
    return { stage: 'prepare', name, total_size: totalSize };
}

function uploadTransfer(
    fileId: unknown = DRAFT_ID,
    offset: unknown = 0,
    data: unknown = UPLOAD_DATA,
) {
    return { stage: 'transfer', file_id: fileId, offset, data };
}

function uploadFinish(fileId: unknown = DRAFT_ID, sha256: unknown = SHA256) {
    return { stage: 'finish', file_id: fileId, sha256 };
}

function uploadRequest(params: unknown, extra: object = {}) {
    return { action: UPLOAD_ACTION, params, ...extra };
}

function noUploadFragmentProviders(f: UploadFixture): void {
    expect(f.prepareUploadFileFragments).not.toHaveBeenCalled();
    expect(f.transferUploadFileFragment).not.toHaveBeenCalled();
    expect(f.finishUploadFileFragments).not.toHaveBeenCalled();
    noDataProviders(f);
}

function noPrivateUploadResult(result: V12Response): void {
    noPrivateResult(result);
    const text = JSON.stringify(result);
    expect(text).not.toContain(DRAFT_ID);
    expect(text).not.toContain(MISSING_DRAFT_ID);
}

describe('upload_file_fragmented on the real V12 dispatcher with synthetic callbacks', () => {
    it('advertises exactly once without requiring the fragmented read callbacks', async () => {
        const f = uploadFixture({
            getUploadedDataFileMetadata: undefined,
            getUploadedDataFileChunk: undefined,
        });
        const supported = await f.dispatcher.handle(DISCOVERY, f.lease);
        expect(supported).toMatchObject({ status: 'ok', retcode: 0 });
        expect((supported.data as unknown[]).filter((value) => value === UPLOAD_ACTION)).toEqual([
            UPLOAD_ACTION,
        ]);
        expect(supported.data).toContain('upload_file');
        expect(supported.data).not.toContain('get_file_fragmented');
        expect(f.isUploadDataSupported).toHaveBeenCalledWith(f.lease);
        noUploadFragmentProviders(f);
    });

    it.each(UPLOAD_CAPABILITIES)('requires %s for discovery and all three stages', async (key) => {
        const f = uploadFixture({ [key]: undefined });
        const supported = await f.dispatcher.handle(DISCOVERY, f.lease);
        expect(supported.data).not.toContain(UPLOAD_ACTION);

        for (const params of [uploadPrepare(), uploadTransfer(), uploadFinish()]) {
            const result = await f.dispatcher.handle(
                uploadRequest(params, { echo: 'safe' }),
                f.lease,
            );
            failed(result, 10002);
            expect(result.echo).toBe('safe');
        }

        noUploadFragmentProviders(f);
    });

    it('requires readiness to return literal true and withholds support after shutdown', async () => {
        const f = uploadFixture();

        for (const readiness of [
            () => false,
            () => 1 as unknown as boolean,
            () => {
                throw new Error(ERROR_MARKER);
            },
            () => {
                f.state.current = false;
                return true;
            },
        ]) {
            f.isUploadDataSupported.mockImplementation(readiness);
            const supported = await f.dispatcher.handle(DISCOVERY, f.lease);
            expect(supported.data).not.toContain(UPLOAD_ACTION);
            const result = await f.dispatcher.handle(uploadRequest(uploadPrepare()), f.lease);
            failed(result, 10002);
            noPrivateUploadResult(result);
        }

        noUploadFragmentProviders(f);
    });

    it('returns the exact stage envelopes, preserving echo and passing a distinct guard', async () => {
        const f = uploadFixture();
        const chunk = Buffer.alloc(MAX_BYTES, 0xff).toString('base64');
        const steps = [
            [uploadPrepare(NAME, MAX_BYTES), { file_id: DRAFT_ID }, ''],
            [uploadTransfer(DRAFT_ID, 0, chunk), null, '偏移 🪶'],
            [uploadFinish(), { file_id: FILE_ID }, 'finished'],
        ] as const;

        for (const [params, data, echo] of steps) {
            expect(
                await f.dispatcher.handle(uploadRequest(params, { echo, self: SELF }), f.lease),
            ).toEqual({ status: 'ok', retcode: 0, message: '', data, echo });
        }

        expect(f.prepareUploadFileFragments).toHaveBeenCalledExactlyOnceWith(
            NAME,
            MAX_BYTES,
            expect.any(Function),
        );
        expect(f.transferUploadFileFragment).toHaveBeenCalledExactlyOnceWith(
            DRAFT_ID,
            0,
            chunk,
            expect.any(Function),
        );
        expect(f.finishUploadFileFragments).toHaveBeenCalledExactlyOnceWith(
            DRAFT_ID,
            SHA256,
            expect.any(Function),
        );
        expect(f.prepareUploadFileFragments.mock.calls[0]![2]).not.toBe(f.lease);
        expect(f.transferUploadFileFragment.mock.calls[0]![3]).not.toBe(f.lease);
        expect(f.finishUploadFileFragments.mock.calls[0]![2]).not.toBe(f.lease);
        expect(f.isUploadDataSupported).toHaveBeenCalled();

        for (const [candidate] of f.isUploadDataSupported.mock.calls) {
            expect(candidate).toBe(f.lease);
        }

        noDataProviders(f);
    });

    it('preserves optional readiness and supports preparing an empty file with a guard', async () => {
        const f = uploadFixture({ isUploadDataSupported: undefined });
        let canCommit: boolean | undefined;
        f.prepareUploadFileFragments.mockImplementationOnce((_name, _size, guard) => {
            canCommit = guard?.();
            return { kind: 'ok', draftId: DRAFT_ID };
        });
        const supported = await f.dispatcher.handle(DISCOVERY);
        expect(supported.data).toContain(UPLOAD_ACTION);
        expect(await f.dispatcher.handle(uploadRequest(uploadPrepare(NAME, 0)))).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: { file_id: DRAFT_ID },
        });
        expect(canCommit).toBe(true);
        expect(f.prepareUploadFileFragments).toHaveBeenCalledExactlyOnceWith(
            NAME,
            0,
            expect.any(Function),
        );
        noDataProviders(f);
    });

    it('validates the stage, allowed fields, sizes, canonical Base64 and digest before writing', async () => {
        const f = uploadFixture();
        const cases: Array<[object, number]> = [
            [{}, 10003],
            [{ stage: null }, 10003],
            [{ stage: 'discard' }, 10004],
            [{ ...uploadPrepare(), type: 'data' }, 10004],
            [{ ...uploadTransfer(), size: 1 }, 10004],
            [{ ...uploadFinish(), data: UPLOAD_DATA }, 10004],
            [{ stage: 'prepare', name: NAME }, 10003],
            [uploadPrepare(1), 10003],
            [uploadPrepare(NAME, '1'), 10003],
            [uploadPrepare(NAME, -1), 10003],
            [uploadPrepare(NAME, MAX_BYTES + 1), 10004],
            [{ stage: 'transfer', file_id: DRAFT_ID, offset: 0 }, 10003],
            [uploadTransfer('', 0), 10003],
            [uploadTransfer(DRAFT_ID, '0'), 10003],
            [uploadTransfer(DRAFT_ID, 0.5), 10003],
            [uploadTransfer(DRAFT_ID, MAX_BYTES, 'AA=='), 10004],
            [uploadTransfer(DRAFT_ID, Number.MAX_SAFE_INTEGER, 'AA=='), 10004],
            [uploadTransfer(DRAFT_ID, 0, Buffer.alloc(MAX_BYTES + 1).toString('base64')), 10004],
            [uploadTransfer(FILE_ID), 10004],
            [uploadFinish('legacy-id'), 10004],
            [{ stage: 'finish', file_id: DRAFT_ID }, 10003],
            [uploadFinish(DRAFT_ID, 0), 10003],
            [uploadFinish(DRAFT_ID, 'A'.repeat(64)), 10003],
            [uploadFinish(DRAFT_ID, SHA256.slice(1)), 10003],
        ];

        for (const data of [null, '', 'AA', 'AA===', 'AA==\n', '_w==', 'AB==', 'AAB=']) {
            cases.push([uploadTransfer(DRAFT_ID, 0, data), 10003]);
        }

        for (const [params, code] of cases) {
            const result = await f.dispatcher.handle(
                uploadRequest(params, { echo: 'safe' }),
                f.lease,
            );
            failed(result, code);
            expect(result.echo).toBe('safe');
            noPrivateUploadResult(result);
        }

        noUploadFragmentProviders(f);
    });

    it.each([
        ['prepare', uploadPrepare(), { file_id: DRAFT_ID }],
        ['transfer', uploadTransfer(), null],
        ['finish', uploadFinish(), { file_id: FILE_ID }],
    ] as const)(
        'preflights the exact %s success envelope before writing',
        async (_stage, params, data) => {
            const f = uploadFixture();
            const limit = 1024 * 1024 - 14;
            const empty = { status: 'ok', retcode: 0, data, message: '', echo: '' };
            const budget = limit - Buffer.byteLength(JSON.stringify(empty), 'utf8');
            const sample = '"\\\n霁🪶';
            const cost = Buffer.byteLength(JSON.stringify(sample), 'utf8') - 2;
            const echo = sample.repeat(Math.floor(budget / cost)) + 'x'.repeat(budget % cost);
            const oversized = `${echo}x`;
            const badParams = await f.dispatcher.handle(
                uploadRequest({ ...params, extra: true }, { echo: oversized }),
                f.lease,
            );
            failed(badParams, 10004);
            const badEcho = await f.dispatcher.handle(
                uploadRequest(params, { echo: oversized }),
                f.lease,
            );
            failed(badEcho, 10003);
            expect(badEcho.echo === oversized).toBe(true);
            noUploadFragmentProviders(f);

            const exact = await f.dispatcher.handle(uploadRequest(params, { echo }), f.lease);
            expect(exact).toMatchObject({ status: 'ok', retcode: 0, data, message: '' });
            expect(exact.echo === echo).toBe(true);
            expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(limit);
        },
    );

    it('returns the same fixed miss for a malformed draft token and a canonical unknown draft', async () => {
        const f = uploadFixture();
        const invalid = [DRAFT_PREFIX, DRAFT_PREFIX + 'A'.repeat(42) + 'B'];
        const misses: V12Response[] = [];

        for (const id of invalid) {
            misses.push(await f.dispatcher.handle(uploadRequest(uploadTransfer(id)), f.lease));
            misses.push(await f.dispatcher.handle(uploadRequest(uploadFinish(id)), f.lease));
        }

        noUploadFragmentProviders(f);
        f.transferUploadFileFragment.mockReturnValueOnce({ kind: 'not_found' });
        f.finishUploadFileFragments.mockReturnValueOnce({ kind: 'not_found' });
        misses.push(
            await f.dispatcher.handle(uploadRequest(uploadTransfer(MISSING_DRAFT_ID)), f.lease),
            await f.dispatcher.handle(uploadRequest(uploadFinish(MISSING_DRAFT_ID)), f.lease),
        );
        expect(f.transferUploadFileFragment).toHaveBeenCalledExactlyOnceWith(
            MISSING_DRAFT_ID,
            0,
            UPLOAD_DATA,
            expect.any(Function),
        );
        expect(f.finishUploadFileFragments).toHaveBeenCalledExactlyOnceWith(
            MISSING_DRAFT_ID,
            SHA256,
            expect.any(Function),
        );

        for (const result of misses) {
            failed(result, 20001);
            expect(result).toEqual(misses[0]);
            noPrivateUploadResult(result);
        }

        noDataProviders(f);
    });

    it('maps capacity, range, incomplete and digest errors from the owning stage callback', async () => {
        const f = uploadFixture();
        f.prepareUploadFileFragments.mockReturnValueOnce({ kind: 'capacity' });
        failed(await f.dispatcher.handle(uploadRequest(uploadPrepare()), f.lease), 20002);

        // These syntactically valid chunks represent overlap, a gap, and overrun
        // for a draft of three bytes with one already written. Only the provider
        // knows that draft state, so all three must reach it.
        for (const [offset, data] of [
            [0, 'AA=='],
            [2, 'AA=='],
            [1, 'AAAA'],
        ] as const) {
            f.transferUploadFileFragment.mockReturnValueOnce({ kind: 'invalid_range' });
            const result = await f.dispatcher.handle(
                uploadRequest(uploadTransfer(DRAFT_ID, offset, data)),
                f.lease,
            );
            failed(result, 10004);
            expect(f.transferUploadFileFragment).toHaveBeenLastCalledWith(
                DRAFT_ID,
                offset,
                data,
                expect.any(Function),
            );
        }

        for (const [kind, code] of [
            ['incomplete', 10004],
            ['invalid', 10003],
        ] as const) {
            f.finishUploadFileFragments.mockReturnValueOnce({ kind });
            failed(await f.dispatcher.handle(uploadRequest(uploadFinish()), f.lease), code);
        }

        noDataProviders(f);
    });

    it.each([...UPLOAD_CAPABILITIES, 'isUploadDataSupported'] as const)(
        'does not invoke an accessor or callable Proxy in %s on direct upload',
        async (key) => {
            const f = uploadFixture();
            const trap = vi.fn(() => {
                throw new Error(ERROR_MARKER);
            });
            const callable = new Proxy(() => true, { apply: trap, get: trap });
            const input = uploadRequest(uploadPrepare(), { echo: 'safe' });
            Object.defineProperty(f.options, key, { configurable: true, get: trap });
            failed(await f.dispatcher.handle(input, f.lease), 10002);
            Object.defineProperty(f.options, key, { configurable: true, value: callable });
            failed(await f.dispatcher.handle(input, f.lease), 10002);
            expect(trap).not.toHaveBeenCalled();
            noUploadFragmentProviders(f);
        },
    );

    it('does not admit inherited upload callbacks', async () => {
        const f = uploadFixture();
        delete f.options.prepareUploadFileFragments;
        Object.setPrototypeOf(f.options, {
            prepareUploadFileFragments: f.prepareUploadFileFragments,
        });
        failed(await f.dispatcher.handle(uploadRequest(uploadPrepare()), f.lease), 10002);
        expect((await f.dispatcher.handle(DISCOVERY, f.lease)).data).not.toContain(UPLOAD_ACTION);
        noUploadFragmentProviders(f);
    });

    it('fences write and read reentry from readiness and a stage callback', async () => {
        const f = uploadFixture();
        let nestedWrite: Promise<V12Response> | undefined;
        let nestedRead: Promise<V12Response> | undefined;
        let probed = false;
        f.isUploadDataSupported.mockImplementation(() => {
            if (!probed) {
                probed = true;
                nestedWrite = f.dispatcher.handle(uploadRequest(uploadTransfer()), f.lease);
            }

            return true;
        });
        f.prepareUploadFileFragments.mockImplementationOnce(() => {
            nestedRead = f.dispatcher.handle(request(prepare()), f.lease);
            return { kind: 'ok', draftId: DRAFT_ID };
        });

        const outer = await f.dispatcher.handle(uploadRequest(uploadPrepare()), f.lease);
        expect(outer.data).toEqual({ file_id: DRAFT_ID });
        expect(nestedWrite).toBeDefined();
        expect(nestedRead).toBeDefined();
        failed(await nestedWrite!, 20002);
        failed(await nestedRead!, 20002);
        expect(f.prepareUploadFileFragments).toHaveBeenCalledOnce();
        expect(f.transferUploadFileFragment).not.toHaveBeenCalled();
        noDataProviders(f);
    });

    it.each(['readiness', 'binding'] as const)(
        'rechecks %s in the commit guard and masks a stale provider error',
        async (effect) => {
            const f = uploadFixture();
            const seen: Array<boolean | undefined> = [];
            f.transferUploadFileFragment.mockImplementationOnce((_id, _offset, _data, guard) => {
                seen.push(guard?.());

                if (effect === 'readiness') {
                    f.isUploadDataSupported.mockReturnValue(false);
                } else {
                    f.options.finishUploadFileFragments = () => ({ kind: 'ok', fileId: FILE_ID });
                }

                seen.push(guard?.());
                return { kind: 'invalid_range' };
            });

            const result = await f.dispatcher.handle(uploadRequest(uploadTransfer()), f.lease);
            expect(seen).toEqual([true, false]);
            failed(result, 20002);
            noPrivateUploadResult(result);
            noDataProviders(f);
        },
    );

    it.each(['revoked', 'throwing'] as const)(
        'discards a finish result on a %s lease and fences a prepared token',
        async (effect) => {
            const f = uploadFixture();
            const input = uploadRequest(uploadFinish(), { echo: 'safe' });
            const prepared = f.dispatcher.createInternalHttpPreflight(f.lease).classify(input);

            if (prepared.kind !== 'ordinary') {
                throw new Error('expected an ordinary dispatcher token');
            }

            f.finishUploadFileFragments.mockImplementationOnce(() => {
                f.state.current = false;
                f.state.throws = effect === 'throwing';
                return { kind: 'ok', fileId: FILE_ID };
            });

            const result = await f.dispatcher.handle(input, f.lease);
            failed(result, 20002);
            expect(result.echo).toBe('safe');
            noPrivateUploadResult(result);
            failed(await f.dispatcher.handlePreparedOrdinary(prepared.token), 10002);
            expect(f.finishUploadFileFragments).toHaveBeenCalledOnce();
            noDataProviders(f);
        },
    );

    it('contains bad provider records, exceptions and private values in responses and logs', async () => {
        const f = uploadFixture();
        const markers = [DRAFT_ID, FILE_ID, NAME, UPLOAD_DATA, SHA256, ERROR_MARKER];
        const trap = vi.fn(() => {
            throw new Error(markers.join(' '));
        });
        const good = { kind: 'ok', draftId: DRAFT_ID };
        const badPrepare: unknown[] = [
            new Proxy(good, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap }),
            Object.defineProperty({ kind: 'ok' }, 'draftId', { enumerable: true, get: trap }),
            hiddenField(good, 'kind'),
            { kind: 'ok', draftId: FILE_ID },
            { kind: 'ok', draftId: DRAFT_PREFIX + 'A'.repeat(42) + 'B' },
        ];

        for (const value of badPrepare) {
            f.prepareUploadFileFragments.mockReturnValueOnce(
                value as V12FragmentUploadPrepareResult,
            );
            const result = await f.dispatcher.handle(uploadRequest(uploadPrepare()), f.lease);
            failed(result, 20002);
            noPrivateUploadResult(result);
        }

        f.transferUploadFileFragment.mockReturnValueOnce({ kind: 'unavailable' });
        f.finishUploadFileFragments.mockReturnValueOnce({ kind: 'ok', fileId: DRAFT_ID });
        f.finishUploadFileFragments.mockImplementationOnce(() => {
            throw new Error(markers.join(' '));
        });

        for (const params of [uploadTransfer(), uploadFinish(), uploadFinish()]) {
            const result = await f.dispatcher.handle(
                uploadRequest(params, { echo: 'safe' }),
                f.lease,
            );
            failed(result, 20002);
            expect(result.echo).toBe('safe');
            noPrivateUploadResult(result);
        }

        const observed =
            JSON.stringify(entries) +
            consoleGuards
                .flatMap((guard) => guard.mock.calls)
                .flat()
                .map(String)
                .join('\n');

        for (const marker of markers) {
            expect(observed).not.toContain(marker);
        }

        expect(trap).not.toHaveBeenCalled();
        noDataProviders(f);
    });

    it('keeps canonical and malformed draft handles out of V11 get_file URL lookup', async () => {
        const f = uploadFixture();

        for (const fileId of [DRAFT_ID, DRAFT_PREFIX + 'bad']) {
            const result = await f.dispatcher.handle(
                { action: 'get_file', params: { file_id: fileId, type: 'url' }, echo: 'safe' },
                f.lease,
            );
            failed(result, 10004);
            expect(result.echo).toBe('safe');
            noPrivateUploadResult(result);
        }

        noUploadFragmentProviders(f);
    });
});
