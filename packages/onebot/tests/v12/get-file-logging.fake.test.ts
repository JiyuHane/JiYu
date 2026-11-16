import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import { ApiHandler, type ActionRecord, type ApiActionContext } from '../../src/api-handler';
import { compileActionRegistry } from '../../src/actions';
import { actions as extendedActions } from '../../src/actions/extended';
import type { CachedImage, MediaStore } from '../../src/media-store';
import { getImageInfo } from '../../src/modules/media-actions';
import type { JsonObject } from '../../src/types';
import { V12Dispatcher } from '../../src/v12/dispatcher';

// Keep the actual get_file ActionSpec, but do not register unrelated actions.
// No OneBot instance, account, bridge, native transport, plugin or signing service is started.
vi.mock('../../src/actions/info', () => ({ actions: [] }));
vi.mock('../../src/actions/message', () => ({ actions: [] }));
vi.mock('../../src/actions/friend', () => ({ actions: [] }));
vi.mock('../../src/actions/group-info', () => ({
    actions: [],
    groupInfoReturnsSchema: { type: 'object' },
}));
vi.mock('../../src/actions/group-admin', () => ({ actions: [] }));
vi.mock('../../src/actions/group-file', () => ({ actions: [] }));
vi.mock('../../src/actions/request', () => ({ actions: [] }));
vi.mock('../../src/actions/group-album', () => ({ actions: [] }));
vi.mock('../../src/actions/qzone', () => ({ actions: [] }));
vi.mock('../../src/actions/qzone-public', () => ({ actions: [] }));
vi.mock('../../src/actions/stream-download', () => ({ actions: [] }));
vi.mock('../../src/actions/stream-file', () => ({ actions: [] }));
vi.mock('../../src/actions/system-face', () => ({ actions: [] }));
vi.mock('../../src/actions/extended', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/actions/extended')>();
    return {
        ...actual,
        actions: actual.actions.filter((spec) => spec.names[0] === 'get_file'),
    };
});

const { forbiddenModuleAttempts } = vi.hoisted(() => ({ forbiddenModuleAttempts: [] as string[] }));

// message-media imports media-store transitively. Block the SQLite constructor
// so even an accidental store construction cannot load a native addon.
vi.mock('@snowluma/sqlite', () => ({
    SqliteDatabase: class {
        constructor() {
            forbiddenModuleAttempts.push('sqlite');
            throw new Error('unexpected SQLite construction in memory fixture');
        }
    },
}));
vi.mock('@snowluma/websocket', () => ({
    WebSocket: class {
        constructor() {
            forbiddenModuleAttempts.push('websocket');
            throw new Error('unexpected WebSocket in memory fixture');
        }
    },
    WebSocketServer: class {
        constructor() {
            forbiddenModuleAttempts.push('websocket-server');
            throw new Error('unexpected WebSocket server in memory fixture');
        }
    },
}));

const markers = {
    fileId: 'SYNTHETIC_PRIVATE_FILE_ID_X731',
    alias: 'SYNTHETIC_PRIVATE_FILE_ALIAS_X732',
    url: 'SYNTHETIC_PRIVATE_URL_PATH_X733',
    query: 'SYNTHETIC_PRIVATE_QUERY_VALUE_X734',
    name: 'SYNTHETIC_PRIVATE_FILE_NAME_X735',
    error: 'SYNTHETIC_PRIVATE_HANDLER_ERROR_X736',
    resolverError: 'SYNTHETIC_PRIVATE_RESOLVER_ERROR_X737',
    observerError: 'SYNTHETIC_PRIVATE_OBSERVER_ERROR_X738',
} as const;
const fileId = `${markers.fileId}?value=${markers.query}`;
const rawUrl = `https://media.example.invalid/${markers.url}?token=${markers.query}`;
const cachedUrl = `https://cache.example.invalid/${markers.url}?token=${markers.query}`;
const freshUrl = `https://fresh.example.invalid/${markers.url}?token=${markers.query}`;
const fileName = `${markers.name}.jpg`;
const privateError = `${markers.error} ${fileId} ${freshUrl} ${fileName}`;
const privateResolverError = `${markers.resolverError} ${fileId} ${rawUrl} ${fileName}`;

let entries: LogEntry[];
let previousLevel: string;
let unsubscribe: () => void;
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let networkGuards: Array<{ mock: { calls: unknown[] } }>;
let nativeGuard: { mock: { calls: unknown[] } };

beforeEach(() => {
    previousLevel = getLogLevel();
    setLogLevel('trace');
    entries = [];
    unsubscribe = subscribeLogs((entry) => entries.push(entry));
    forbiddenModuleAttempts.length = 0;

    const blocked = () => {
        throw new Error('unexpected network operation in memory fixture');
    };

    fetchGuard = vi.fn(blocked);
    webSocketGuard = vi.fn(function BlockWebSocket() {
        return blocked();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);

    // Guard outgoing connections, listeners and UDP, including calls through a
    // directly created Socket. The tested fixtures do not create any socket.
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

afterEach(() => {
    const fetchCalls = fetchGuard.mock.calls.length;
    const webSocketCalls = webSocketGuard.mock.calls.length;
    const networkCalls = networkGuards.map((guard) => guard.mock.calls.length);
    const nativeCalls = nativeGuard.mock.calls.length;
    const moduleAttempts = [...forbiddenModuleAttempts];
    unsubscribe();
    setLogLevel(previousLevel);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(fetchCalls).toBe(0);
    expect(webSocketCalls).toBe(0);
    expect(networkCalls).toEqual(networkCalls.map(() => 0));
    expect(nativeCalls).toBe(0);
    expect(moduleAttempts).toEqual([]);
});

function cachedImage(overrides: Partial<CachedImage> = {}): CachedImage {
    return {
        file: fileId,
        url: cachedUrl,
        imageUrl: rawUrl,
        fileName,
        fileSize: 123,
        subType: 2,
        summary: '',
        isGroup: true,
        sessionId: 13579,
        ...overrides,
    };
}

function imageStore(image: CachedImage | null) {
    const values = new Map<string, CachedImage>();

    if (image) {
        values.set(fileId, image);
    }

    const findImage = vi.fn(async (file: string) => values.get(file) ?? null);
    return { store: { findImage } as unknown as MediaStore, findImage };
}

function fixture(
    getImage: ApiActionContext['getImageInfo'],
    getRecord: ApiActionContext['getRecordInfo'] = vi.fn(async () => null),
) {
    const specs = extendedActions.filter((spec) => spec.names[0] === 'get_file');
    expect(specs).toHaveLength(1);
    const registry = compileActionRegistry([{ category: 'fixture', actions: specs }]);
    expect(registry.executableNames.map((entry) => entry.name)).toEqual(['get_file']);
    const context = new Proxy(
        { getImageInfo: getImage, getRecordInfo: getRecord } as unknown as ApiActionContext,
        {
            get(target, property) {
                if (property in target) {
                    return Reflect.get(target, property);
                }

                throw new Error(`unexpected fake account context access: ${String(property)}`);
            },
        },
    );
    return { api: new ApiHandler(context, 13579, registry), getImage, getRecord };
}

function expectNoMarkersInCapturedLogs() {
    // This checks the entries observed in these isolated scenarios, not every
    // possible caller, transport, file sink or logging path in the application.
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
        for (const marker of Object.values(markers)) {
            expect(entry.message).not.toContain(marker);
            expect(entry.line).not.toContain(marker);
        }
    }
}

function actionLogs() {
    return entries.filter((entry) => entry.scope === 'Bridge.Action');
}

function expectTraceRedacted(outcome: 'ok' | 'failed', reason: string) {
    const logs = actionLogs();
    const input = logs.filter(
        (entry) => entry.level === 'trace' && entry.message.includes('action_input'),
    );
    const debug = logs.filter((entry) => entry.level === 'debug');
    const terminal = logs.filter(
        (entry) => entry.level === 'trace' && entry.message.includes('action_terminal'),
    );
    expect(input).toHaveLength(1);
    expect(input[0]?.message).toBe('action_input action=get_file params=[redacted]');
    expect(debug).toHaveLength(1);
    expect(debug[0]?.message).toBe('get_file params=[redacted]');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.message).toContain(
        `action_terminal action=get_file outcome=${outcome} reason=${reason}`,
    );
    expect(terminal[0]?.message).toContain('response=[redacted]');
    expectNoMarkersInCapturedLogs();
}

function expectNoVerboseLogsAtHigherLevel() {
    expect(
        actionLogs().filter((entry) => entry.level === 'trace' || entry.level === 'debug'),
    ).toEqual([]);
    expectNoMarkersInCapturedLogs();
}

describe('get_file action diagnostics with fake account context', () => {
    it.each(['trace', 'info', 'warn'] as const)(
        'redacts observer errors at %s while v11 keeps the original image result',
        async (level) => {
            setLogLevel(level);
            const { store, findImage } = imageStore(cachedImage());
            const resolveImageUrl = vi.fn(async () => freshUrl);
            const getImage = vi.fn((file: string) => getImageInfo(store, file, resolveImageUrl));
            const getRecord = vi.fn(async () => null);
            const { api } = fixture(getImage, getRecord);
            const records: ActionRecord[] = [];
            const order: string[] = [];
            api.setObserver((record) => {
                order.push('first');
                records.push(record);
                throw new Error(`${markers.observerError} ${fileId} ${freshUrl} ${fileName}`);
            });
            api.setObserver((record) => {
                order.push('second');
                records.push(record);
            });
            const params: JsonObject = { file_id: fileId };
            const result = await api.handle('get_file', params);
            expect(result).toEqual({
                status: 'ok',
                retcode: 0,
                data: { file: freshUrl, url: freshUrl, file_size: '123', file_name: fileName },
            });
            expect(getImage).toHaveBeenCalledExactlyOnceWith(fileId);
            expect(findImage).toHaveBeenCalledExactlyOnceWith(fileId);
            expect(resolveImageUrl).toHaveBeenCalledExactlyOnceWith(
                { type: 'image', imageUrl: rawUrl, subType: 2 },
                true,
            );
            expect(getRecord).not.toHaveBeenCalled();
            expect(order).toEqual(['first', 'second']);
            expect(records).toHaveLength(2);
            expect(records[0]?.params).toBe(params);
            expect(records[1]?.params).toBe(params);
            expect(records[0]?.response).toBe(result);
            expect(records[1]?.response).toBe(result);
            expect(
                actionLogs()
                    .filter((entry) => entry.level === 'warn')
                    .map((entry) => entry.message),
            ).toEqual(['get_file action observer error: [redacted]']);

            if (level === 'trace') {
                expectTraceRedacted('ok', 'response_returned');
            } else {
                expectNoVerboseLogsAtHigherLevel();
            }
        },
    );

    it('redacts a real cache-miss failure and retains its v11 observer response', async () => {
        const getImage = vi.fn(async () => null);
        const getRecord = vi.fn(async () => null);
        const { api } = fixture(getImage, getRecord);
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const params: JsonObject = { file_id: fileId };
        const result = await api.handle('get_file', params);
        expect(result).toMatchObject({ status: 'failed', retcode: 100, data: null });
        expect(result.wording).toContain('not found in the image/voice cache');
        expect(getImage).toHaveBeenCalledExactlyOnceWith(fileId);
        expect(getRecord).toHaveBeenCalledExactlyOnceWith(fileId);
        expect(records).toHaveLength(1);
        expect(records[0]?.params).toBe(params);
        expect(records[0]?.response).toBe(result);
        expectTraceRedacted('failed', 'response_returned');
    });

    it('redacts both file aliases while preserving the record fallback', async () => {
        const alias = `https://alias.example.invalid/${markers.alias}?token=${markers.query}`;
        const info = { file: alias, url: freshUrl, file_size: '7', file_name: fileName };
        const getImage = vi.fn(async () => null);
        const getRecord = vi.fn(async () => info);
        const { api } = fixture(getImage, getRecord);
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const params: JsonObject = { file_id: fileId, file: alias };
        const result = await api.handle('get_file', params);
        expect(result).toEqual({ status: 'ok', retcode: 0, data: info });
        expect(result.data).toBe(info);
        expect(getImage).toHaveBeenCalledExactlyOnceWith(alias);
        expect(getRecord).toHaveBeenCalledExactlyOnceWith(alias);
        expect(records[0]?.params).toBe(params);
        expect(records[0]?.response).toBe(result);
        expectTraceRedacted('ok', 'response_returned');
    });

    it('redacts an invalid parameter before the real action rejects it', async () => {
        const getImage = vi.fn(async () => null);
        const getRecord = vi.fn(async () => null);
        const { api } = fixture(getImage, getRecord);
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const params: JsonObject = { file_id: fileId, file: { name: fileName, url: freshUrl } };
        const result = await api.handle('get_file', params);
        expect(result).toEqual({
            status: 'failed',
            retcode: 1400,
            data: null,
            wording: 'file: expected a string',
        });
        expect(getImage).not.toHaveBeenCalled();
        expect(getRecord).not.toHaveBeenCalled();
        expect(records[0]?.params).toBe(params);
        expect(records[0]?.response).toBe(result);
        expectTraceRedacted('failed', 'response_returned');
    });

    it.each(['trace', 'info', 'warn'] as const)(
        'redacts handler exception and stack at %s while preserving raw v11 wording',
        async (level) => {
            setLogLevel(level);
            const getImage = vi.fn(async () => {
                throw new Error(privateError);
            });
            const getRecord = vi.fn(async () => null);
            const { api } = fixture(getImage, getRecord);
            const records: ActionRecord[] = [];
            api.setObserver((record) => records.push(record));
            const params: JsonObject = { file_id: fileId };
            const result = await api.handle('get_file', params);
            expect(result).toEqual({
                status: 'failed',
                retcode: 100,
                data: null,
                wording: privateError,
            });
            expect(getImage).toHaveBeenCalledExactlyOnceWith(fileId);
            expect(getRecord).not.toHaveBeenCalled();
            expect(records).toHaveLength(1);
            expect(records[0]?.params).toBe(params);
            expect(records[0]?.response).toBe(result);
            const warnings = actionLogs().filter((entry) => entry.level === 'warn');
            expect(warnings.map((entry) => entry.message)).toEqual(['get_file failed: [redacted]']);
            expect(warnings[0]?.message).not.toMatch(/\bat\s+.+:\d+:\d+/);

            if (level === 'trace') {
                expectTraceRedacted('failed', 'handler_threw');
            } else {
                expectNoVerboseLogsAtHigherLevel();
            }
        },
    );

    it('redacts the quiesced ingress without calling either fake provider', async () => {
        const getImage = vi.fn(async () => null);
        const getRecord = vi.fn(async () => null);
        const { api } = fixture(getImage, getRecord);
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        api.quiesce();
        const params: JsonObject = { file_id: fileId };
        const result = await api.handle('get_file', params);
        expect(result).toEqual({
            status: 'failed',
            retcode: 100,
            data: null,
            wording: 'OneBot instance is shutting down',
        });
        expect(records[0]?.params).toBe(params);
        expect(records[0]?.response).toBe(result);
        expect(getImage).not.toHaveBeenCalled();
        expect(getRecord).not.toHaveBeenCalled();
        const logs = actionLogs();
        expect(
            logs.some(
                (entry) => entry.message === 'action_input action=get_file params=[redacted]',
            ),
        ).toBe(true);
        expect(
            logs.some(
                (entry) =>
                    entry.message.includes('reason=quiesced') &&
                    entry.message.includes('response=[redacted]'),
            ),
        ).toBe(true);
        expect(
            logs.some(
                (entry) =>
                    entry.level === 'warn' && entry.message.includes('rejected Action get_file'),
            ),
        ).toBe(true);
        expectNoMarkersInCapturedLogs();
    });

    it('keeps the real v12 projection and the original v11 observer result', async () => {
        const info = { file: freshUrl, url: freshUrl, file_size: '123', file_name: fileName };
        const getImage = vi.fn(async () => info);
        const { api } = fixture(getImage);
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const subject = new V12Dispatcher({
            self: { platform: 'qq', user_id: '13579' },
            api,
            version: { impl: 'fixture', version: '1' },
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
        });
        const result = await subject.handle({
            action: 'get_file',
            params: { file_id: fileId, type: 'url' },
            echo: 'fixture',
        });
        expect(result).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            echo: 'fixture',
            data: { name: fileName, url: freshUrl },
        });
        expect(getImage).toHaveBeenCalledExactlyOnceWith(fileId);
        expect(records).toHaveLength(1);
        expect(records[0]?.params).toEqual({ file_id: fileId });
        expect(records[0]?.response).toEqual({ status: 'ok', retcode: 0, data: info });
        expect(records[0]?.response.data).toBe(info);
        expectTraceRedacted('ok', 'response_returned');
    });

    it('keeps raw v11 error wording for the observer when v12 reports unavailable', async () => {
        const getImage = vi.fn(async () => {
            throw new Error(privateError);
        });
        const { api } = fixture(getImage);
        const records: ActionRecord[] = [];
        api.setObserver((record) => records.push(record));
        const subject = new V12Dispatcher({
            self: { platform: 'qq', user_id: '13579' },
            api,
            version: { impl: 'fixture', version: '1' },
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
        });
        const result = await subject.handle({
            action: 'get_file',
            params: { file_id: fileId, type: 'url' },
            echo: 'fixture',
        });
        expect(result).toEqual({
            status: 'failed',
            retcode: 20002,
            message: 'file unavailable',
            data: null,
            echo: 'fixture',
        });
        expect(getImage).toHaveBeenCalledExactlyOnceWith(fileId);
        expect(records).toHaveLength(1);
        expect(records[0]?.params).toEqual({ file_id: fileId });
        expect(records[0]?.response).toEqual({
            status: 'failed',
            retcode: 100,
            data: null,
            wording: privateError,
        });
        expect(
            actionLogs()
                .filter((entry) => entry.level === 'warn')
                .map((entry) => entry.message),
        ).toEqual(['get_file failed: [redacted]']);
        expectTraceRedacted('failed', 'handler_threw');
    });
});

describe('direct getImageInfo with an in-memory MediaStore fake', () => {
    it.each(['trace', 'info', 'warn'] as const)(
        'keeps the cached fallback and emits a fixed warning at %s',
        async (level) => {
            setLogLevel(level);
            const image = cachedImage();
            const { store, findImage } = imageStore(image);
            const resolveImageUrl = vi.fn(async () => {
                throw new Error(privateResolverError);
            });
            const result = await getImageInfo(store, fileId, resolveImageUrl);
            expect(result).toEqual({
                file: cachedUrl,
                url: cachedUrl,
                file_size: '123',
                file_name: fileName,
            });
            expect(findImage).toHaveBeenCalledExactlyOnceWith(fileId);
            expect(resolveImageUrl).toHaveBeenCalledExactlyOnceWith(
                { type: 'image', imageUrl: rawUrl, subType: 2 },
                true,
            );
            const warnings = entries.filter(
                (entry) => entry.scope === 'OneBot' && entry.level === 'warn',
            );
            expect(warnings.map((entry) => entry.message)).toEqual([
                'get_image URL refresh failed',
            ]);
            expect(warnings[0]?.message).not.toMatch(/\bat\s+.+:\d+:\d+/);
            expectNoMarkersInCapturedLogs();
        },
    );

    it('falls back to the original raw image URL when the cached URL is empty', async () => {
        const image = cachedImage({ url: '' });
        const { store, findImage } = imageStore(image);
        const resolveImageUrl = vi.fn(async () => {
            throw new Error(privateResolverError);
        });
        const result = await getImageInfo(store, fileId, resolveImageUrl);
        expect(result).toEqual({
            file: rawUrl,
            url: rawUrl,
            file_size: '123',
            file_name: fileName,
        });
        expect(findImage).toHaveBeenCalledExactlyOnceWith(fileId);
        expect(resolveImageUrl).toHaveBeenCalledExactlyOnceWith(
            { type: 'image', imageUrl: rawUrl, subType: 2 },
            true,
        );
        expect(
            entries
                .filter((entry) => entry.scope === 'OneBot' && entry.level === 'warn')
                .map((entry) => entry.message),
        ).toEqual(['get_image URL refresh failed']);
        expectNoMarkersInCapturedLogs();
    });
});
