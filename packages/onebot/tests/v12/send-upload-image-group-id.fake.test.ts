import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResponse, JsonObject } from '../../src/types';
import type { V12CoreOptions, V12FileLease } from '../../src/v12/types';
import type { V12UploadedDataStore } from '../../src/v12/uploaded-data-store';

// The dispatcher and memory store are real; all identities, APIs and data are synthetic.
const forbidden = vi.hoisted(() => ({ constructions: [] as string[] }));
vi.mock('@snowluma/websocket', () => ({
    WebSocket: class {
        constructor() {
            forbidden.constructions.push('WebSocket');
            throw new Error('unexpected WebSocket');
        }
    },
    WebSocketServer: class {
        constructor() {
            forbidden.constructions.push('WebSocketServer');
            throw new Error('unexpected WebSocketServer');
        }
    },
}));
vi.mock('@snowluma/sqlite', () => ({
    SqliteDatabase: class {
        constructor() {
            forbidden.constructions.push('SqliteDatabase');
            throw new Error('unexpected SQLite');
        }
    },
}));
vi.mock('../../src/api-handler', () => ({
    ApiHandler: class {
        constructor() {
            forbidden.constructions.push('ApiHandler');
            throw new Error('unexpected real API handler');
        }
    },
}));

let dispatcherModule: typeof import('../../src/v12/dispatcher');
let storeModule: typeof import('../../src/v12/uploaded-data-store');
let guards: Array<{ mock: { calls: unknown[] } }>;
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let stores: V12UploadedDataStore[];

function blocked(): never {
    throw new Error('unexpected network, process or native operation');
}

beforeEach(async () => {
    forbidden.constructions.length = 0;
    stores = [];
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
        vi.spyOn(childProcess, 'spawn').mockImplementation(blocked),
        vi.spyOn(childProcess, 'spawnSync').mockImplementation(blocked),
        vi.spyOn(childProcess, 'exec').mockImplementation(blocked),
        vi.spyOn(childProcess, 'execSync').mockImplementation(blocked),
        vi.spyOn(childProcess, 'execFile').mockImplementation(blocked),
        vi.spyOn(childProcess, 'execFileSync').mockImplementation(blocked),
        vi.spyOn(childProcess, 'fork').mockImplementation(blocked),
        vi.spyOn(process, 'dlopen').mockImplementation(blocked),
    ];
    dispatcherModule = await import('../../src/v12/dispatcher');
    storeModule = await import('../../src/v12/uploaded-data-store');
});

afterEach(() => {
    for (const store of stores) {
        store.close();
    }

    const calls = guards.map((guard) => guard.mock.calls.length);
    const fetchCalls = fetchGuard.mock.calls.length;
    const webSocketCalls = webSocketGuard.mock.calls.length;
    const constructions = [...forbidden.constructions];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    expect(calls).toEqual(calls.map(() => 0));
    expect(fetchCalls).toBe(0);
    expect(webSocketCalls).toBe(0);
    expect(constructions).toEqual([]);
});

const DATA = Buffer.from([1, 2, 3, 0, 255]).toString('base64');
const SELF = { platform: 'qq', user_id: '10001' };
const MESSAGE_ID = -2147483648;
const TIME = 1700000000;
type Scene = 'group' | 'private';

function success(): ApiResponse {
    return { status: 'ok', retcode: 0, data: { message_id: MESSAGE_ID } };
}

function fixture() {
    const clock = vi.fn(() => 100);
    const store = new storeModule.V12UploadedDataStore({
        now: clock,
        randomBytes: () => Buffer.alloc(32, 1),
    });
    stores.push(store);
    const lease = vi.fn(() => true);
    const uploaded = store.upload('fixture.bin', DATA, undefined, lease);

    if (uploaded.kind !== 'ok') {
        throw new Error('synthetic upload failed');
    }

    const get = vi.spyOn(store, 'get');
    const reader = vi.fn((id: string, candidate?: V12FileLease) => store.get(id, candidate));
    const readiness = vi.fn((candidate?: V12FileLease) => candidate?.() === true);
    const raw = vi.fn(async (_action: string, _params: JsonObject): Promise<ApiResponse> =>
        success(),
    );
    const sensitive = vi.fn(
        async (
            _action: string,
            _params: JsonObject,
            canStart?: () => boolean,
        ): Promise<ApiResponse> =>
            canStart?.() === true
                ? success()
                : { status: 'failed', retcode: 100, data: null, wording: 'unavailable' },
    );
    const getSentMessageTime = vi.fn(() => TIME);
    const options: V12CoreOptions = {
        self: SELF,
        version: { impl: 'synthetic', version: '1' },
        api: { handle: raw, handleV12SensitiveMessage: sensitive },
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime,
        getUploadedDataFile: reader,
        isUploadDataSupported: readiness,
    };
    const dispatcher = new dispatcherModule.V12Dispatcher(options);
    clock.mockClear();
    lease.mockClear();
    return {
        id: uploaded.fileId,
        dispatcher,
        lease,
        readiness,
        reader,
        get,
        clock,
        raw,
        sensitive,
        getSentMessageTime,
    };
}

type Fixture = ReturnType<typeof fixture>;

function image(id: unknown) {
    return { type: 'image', data: { file_id: id } };
}

function request(scene: Scene, target: string, message: unknown, echo = '') {
    return {
        action: 'send_message',
        params: {
            detail_type: scene,
            [scene === 'group' ? 'group_id' : 'user_id']: target,
            message,
        },
        self: SELF,
        echo,
    };
}

function noEffects(f: Fixture) {
    expect(f.reader).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.lease).not.toHaveBeenCalled();
    expect(f.readiness).not.toHaveBeenCalled();
    expect(f.clock).not.toHaveBeenCalled();
    expect(f.raw).not.toHaveBeenCalled();
    expect(f.sensitive).not.toHaveBeenCalled();
    expect(f.getSentMessageTime).not.toHaveBeenCalled();
}

describe('synthetic uploaded-image target bounds through V12 dispatcher', () => {
    it.each(['group', 'private'] as const)(
        'passes the uint32 boundaries in the %s scene',
        async (scene) => {
            for (const target of ['1', '4294967295']) {
                const f = fixture();
                const input = request(scene, target, image(f.id), 'boundary');
                const before = structuredClone(input);
                const result = await f.dispatcher.handle(input, f.lease);
                expect(input).toEqual(before);
                expect(result).toEqual({
                    status: 'ok',
                    retcode: 0,
                    data: { message_id: String(MESSAGE_ID), time: TIME },
                    message: '',
                    echo: 'boundary',
                });
                expect(f.reader).toHaveBeenCalledExactlyOnceWith(f.id, f.lease);
                expect(f.get).toHaveBeenCalledExactlyOnceWith(f.id, f.lease);
                expect(f.sensitive).toHaveBeenCalledExactlyOnceWith(
                    scene === 'group' ? 'send_group_msg' : 'send_private_msg',
                    {
                        [scene === 'group' ? 'group_id' : 'user_id']: Number(target),
                        message: [{ type: 'image', data: { file: `base64://${DATA}` } }],
                        auto_escape: false,
                    },
                    expect.any(Function),
                );
                expect(f.raw).not.toHaveBeenCalled();
                expect(f.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(MESSAGE_ID);
            }
        },
    );

    it.each(['group', 'private'] as const)(
        'rejects out-of-range %s image targets before capabilities or store reads',
        async (scene) => {
            for (const target of ['4294967296', '4294967338', '9007199254740991']) {
                for (const echo of ['', 'synthetic-echo']) {
                    const f = fixture();
                    const input = request(scene, target, image(f.id), echo);
                    const before = structuredClone(input);
                    const result = await f.dispatcher.handle(input, f.lease);
                    expect(result).toEqual({
                        status: 'failed',
                        retcode: 10003,
                        data: null,
                        message: 'invalid target or message',
                        echo,
                    });
                    expect(input).toEqual(before);
                    noEffects(f);
                }
            }
        },
    );

    it.each(['group', 'private'] as const)(
        'preserves segment and parameter error precedence for large %s targets',
        async (scene) => {
            const f = fixture();
            const target = '4294967338';
            const valid = image(f.id);
            const cases = [
                { input: request(scene, target, { type: 'image', data: null }), code: 10006 },
                { input: request(scene, target, image(123)), code: 10006 },
                { input: request(scene, target, { ...valid, extra: true }), code: 10007 },
                {
                    input: request(scene, target, {
                        type: 'image',
                        data: { file_id: f.id, extra: true },
                    }),
                    code: 10007,
                },
                { input: request(scene, target, image('jiyu-upload:v1:bad')), code: 10005 },
                {
                    input: request(scene, target, [
                        valid,
                        { type: 'text', data: { text: 'fixture' } },
                    ]),
                    code: 10005,
                },
                {
                    input: {
                        ...request(scene, target, valid),
                        params: { ...request(scene, target, valid).params, extra: true },
                    },
                    code: 10004,
                },
            ];

            for (const { input, code } of cases) {
                const before = structuredClone(input);
                expect(await f.dispatcher.handle(input, f.lease)).toMatchObject({
                    status: 'failed',
                    retcode: code,
                    data: null,
                    echo: '',
                });
                expect(input).toEqual(before);
                noEffects(f);
            }
        },
    );

    it.each([
        { type: 'text', data: { text: 'synthetic text' } },
        {
            type: 'location',
            data: { latitude: 1, longitude: 2, title: 'fixture', content: 'fixture' },
        },
    ])('preserves large group targets for ordinary $type messages', async (message) => {
        const f = fixture();
        const input = request('group', '9007199254740991', message, 'ordinary');
        const before = structuredClone(input);
        const result = await f.dispatcher.handle(input, f.lease);
        expect(input).toEqual(before);
        expect(result).toMatchObject({ status: 'ok', retcode: 0, echo: 'ordinary' });
        expect(f.raw).toHaveBeenCalledOnce();
        expect(f.raw.mock.calls[0]?.[0]).toBe('send_group_msg');
        expect(f.raw.mock.calls[0]?.[1].group_id).toBe(Number.MAX_SAFE_INTEGER);
        expect(f.reader).not.toHaveBeenCalled();
        expect(f.sensitive).not.toHaveBeenCalled();
    });

    it.each([
        { type: 'text', data: { text: 'synthetic text' } },
        {
            type: 'location',
            data: { latitude: 1, longitude: 2, title: 'fixture', content: 'fixture' },
        },
    ])('retains the existing private uint32 limit for ordinary $type messages', async (message) => {
        const f = fixture();
        const input = request('private', '9007199254740991', message);
        const before = structuredClone(input);
        expect(await f.dispatcher.handle(input, f.lease)).toMatchObject({
            status: 'failed',
            retcode: 10003,
            data: null,
            echo: '',
        });
        expect(input).toEqual(before);
        noEffects(f);
    });
});
