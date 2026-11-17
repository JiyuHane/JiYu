import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResponse, JsonObject } from '../../src/types';
import type { V12CoreOptions, V12FileLease, V12Response } from '../../src/v12/types';
import type { V12ReadUploadResult, V12UploadedDataStore } from '../../src/v12/uploaded-data-store';

// The dispatcher and the upload store are real. Every API, listener ticket and
// clock below is an in-memory fake; no QQ, network transport or SDK send runs.
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

const SELF = { platform: 'qq', user_id: '10001' };
const ECHO = 'synthetic-image-echo-🪶';
const NAME = 'SYNTHETIC_PRIVATE_IMAGE_NAME_X872.bin';
const SECRET = 'SYNTHETIC_PRIVATE_ERROR_X873';
const BYTES = Buffer.from([0, 255, 128, 1, 2, 3, 10, 13, 47, 92, 127]);
const DATA = BYTES.toString('base64');
const SHA256 = createHash('sha256').update(BYTES).digest('hex');
const PREFIX = 'jiyu-upload:v1:';
const MESSAGE_ID = -2147483648;
const TIME = 1700000000;
const MAX_BYTES = 256 * 1024;

type Scene = 'private' | 'group';
let dispatcherModule: typeof import('../../src/v12/dispatcher');
let storeModule: typeof import('../../src/v12/uploaded-data-store');
let tokenModule: typeof import('../../src/v12/image-file-token');
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let guards: Array<{ mock: { calls: unknown[] } }>;
let stores: V12UploadedDataStore[];
let randomSequence: number;

function blocked(): never {
    throw new Error('unexpected network, process or native operation in image fixture');
}

beforeEach(async () => {
    forbidden.constructions.length = 0;
    stores = [];
    randomSequence = 0;
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
    // Install the guards before loading any subject module.
    dispatcherModule = await import('../../src/v12/dispatcher');
    storeModule = await import('../../src/v12/uploaded-data-store');
    tokenModule = await import('../../src/v12/image-file-token');
});

afterEach(() => {
    for (const store of stores) {
        store.close();
    }

    const calls = guards.map((guard) => guard.mock.calls.length);
    const fetchCalls = fetchGuard.mock.calls.length;
    const websocketCalls = webSocketGuard.mock.calls.length;
    const constructions = [...forbidden.constructions];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    expect(calls).toEqual(calls.map(() => 0));
    expect(fetchCalls).toBe(0);
    expect(websocketCalls).toBe(0);
    expect(constructions).toEqual([]);
});

function success(): ApiResponse {
    return { status: 'ok', retcode: 0, data: { message_id: MESSAGE_ID } };
}

function fixture(account = SELF.user_id) {
    const state: { current: boolean; now: number; onLease?: () => void } = {
        current: true,
        now: 100,
    };
    const store = new storeModule.V12UploadedDataStore({
        now: () => state.now,
        randomBytes: () => Buffer.alloc(32, ++randomSequence),
    });
    stores.push(store);
    const lease = vi.fn(() => {
        const hook = state.onLease;
        state.onLease = undefined;
        hook?.();
        return state.current;
    });
    const raw = vi.fn(async (_action: string, _params: JsonObject): Promise<ApiResponse> => {
        throw new Error('unexpected ordinary API call');
    });
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
    const api = { handle: raw, handleV12SensitiveMessage: sensitive };
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
    const getSentMessageTime = vi.fn((_id: number): number | null | Promise<number | null> => TIME);
    const options: V12CoreOptions = {
        self: { platform: 'qq', user_id: account },
        version: { impl: 'synthetic', version: '1' },
        api,
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime,
        uploadDataFile: upload,
        getUploadedDataFile: reader,
        isUploadDataSupported: readiness,
    };
    const dispatcher = new dispatcherModule.V12Dispatcher(options);
    return {
        state,
        store,
        lease,
        api,
        raw,
        sensitive,
        upload,
        reader,
        readiness,
        options,
        dispatcher,
        getSentMessageTime,
    };
}

type Fixture = ReturnType<typeof fixture>;

function image(fileId: unknown) {
    return { type: 'image', data: { file_id: fileId } };
}

function request(scene: Scene, message: unknown, account = SELF.user_id) {
    return {
        action: 'send_message',
        params:
            scene === 'private'
                ? { detail_type: 'private', user_id: '42', message }
                : { detail_type: 'group', group_id: '44', message },
        self: { platform: 'qq', user_id: account },
        echo: ECHO,
    };
}

async function upload(f: Fixture, data = DATA, name = NAME): Promise<string> {
    const result = await f.dispatcher.handle(
        { action: 'upload_file', params: { type: 'data', name, data }, echo: ECHO },
        f.lease,
    );
    expect(result).toMatchObject({ status: 'ok', retcode: 0, echo: ECHO });
    const value = result.data;

    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        typeof value.file_id !== 'string'
    ) {
        throw new Error('synthetic upload ID missing');
    }

    expect(value.file_id).toMatch(/^jiyu-upload:v1:[A-Za-z0-9_-]{43}$/);
    return value.file_id;
}

function failed(result: V12Response, ...privateValues: string[]): void {
    expect(result).toMatchObject({ status: 'failed', data: null, echo: ECHO });
    expect(result.retcode).not.toBe(0);
    const serialized = JSON.stringify(result);

    for (const value of [NAME, SECRET, DATA, SHA256, ...privateValues]) {
        if (value.length > 0) {
            expect(serialized).not.toContain(value);
        }
    }
}

function noSend(f: Fixture): void {
    expect(f.raw).not.toHaveBeenCalled();
    expect(f.sensitive).not.toHaveBeenCalled();
    expect(f.getSentMessageTime).not.toHaveBeenCalled();
}

function expectedV11(scene: Scene, data: string) {
    return {
        ...(scene === 'private' ? { user_id: 42 } : { group_id: 44 }),
        message: [{ type: 'image', data: { file: `base64://${data}` } }],
        auto_escape: false,
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

async function flush(): Promise<void> {
    for (let i = 0; i < 30; i += 1) {
        await Promise.resolve();
    }
}

// Saturation must fail without waiting for any of the still-unresolved fakes.
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

describe('uploaded single-image sends through real V12 dispatcher and store', () => {
    it.each([
        { scene: 'private' as const, array: false },
        { scene: 'group' as const, array: true },
    ])('sends $scene exactly once and leaves the upload readable', async ({ scene, array }) => {
        const f = fixture();
        const id = await upload(f);
        const expectedStored = { kind: 'ok', name: NAME, data: DATA, sha256: SHA256 };
        expect(f.store.get(id, f.lease)).toEqual(expectedStored);
        const message = image(id);
        const input = request(scene, array ? [message] : message);
        const before = structuredClone(input);
        f.reader.mockClear();
        const result = await f.dispatcher.handle(input, f.lease);
        expect(input).toEqual(before);
        expect(result).toEqual({
            status: 'ok',
            retcode: 0,
            data: { message_id: String(MESSAGE_ID), time: TIME },
            message: '',
            echo: ECHO,
        });
        expect(f.reader).toHaveBeenCalledExactlyOnceWith(id, f.lease);
        expect(f.reader.mock.contexts[0]).toBe(f.options);
        expect(f.sensitive).toHaveBeenCalledExactlyOnceWith(
            scene === 'private' ? 'send_private_msg' : 'send_group_msg',
            expectedV11(scene, DATA),
            expect.any(Function),
        );
        expect(f.sensitive.mock.contexts[0]).toBe(f.api);
        const canStart = f.sensitive.mock.calls[0]?.[2];
        expect(typeof canStart).toBe('function');
        expect(canStart?.()).toBe(false);
        expect(f.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(MESSAGE_ID);
        expect(f.raw).not.toHaveBeenCalled();
        expect(f.store.get(id, f.lease)).toEqual(expectedStored);
    });

    it('keeps an ordinary text send on the existing V11 path without a file lease', async () => {
        const f = fixture();
        f.raw.mockResolvedValueOnce(success());
        const result = await f.dispatcher.handle(
            request('private', { type: 'text', data: { text: 'ordinary synthetic text' } }),
        );
        expect(result).toEqual({
            status: 'ok',
            retcode: 0,
            data: { message_id: String(MESSAGE_ID), time: TIME },
            message: '',
            echo: ECHO,
        });
        expect(f.raw).toHaveBeenCalledExactlyOnceWith('send_private_msg', {
            user_id: 42,
            message: [{ type: 'text', data: { text: 'ordinary synthetic text' } }],
            auto_escape: false,
        });
        expect(f.sensitive).not.toHaveBeenCalled();
        expect(f.reader).not.toHaveBeenCalled();
        expect(f.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(MESSAGE_ID);
    });

    it('accepts a one-byte image at the nonempty lower boundary', async () => {
        const f = fixture();
        const data = Buffer.from([0xff]).toString('base64');
        const id = await upload(f, data);
        const result = await f.dispatcher.handle(request('private', image(id)), f.lease);
        expect(result).toMatchObject({ status: 'ok', retcode: 0, echo: ECHO });
        expect(f.sensitive).toHaveBeenCalledExactlyOnceWith(
            'send_private_msg',
            expectedV11('private', data),
            expect.any(Function),
        );
        expect(f.raw).not.toHaveBeenCalled();
    });

    it('accepts the exact 256 KiB upload boundary without changing its bytes', async () => {
        const f = fixture();
        const bytes = Buffer.alloc(MAX_BYTES, 0x61);
        bytes[0] = 0;
        bytes[bytes.length - 1] = 0xff;
        const data = bytes.toString('base64');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const id = await upload(f, data);
        expect(f.store.get(id, f.lease)).toEqual({ kind: 'ok', name: NAME, data, sha256 });
        f.reader.mockClear();
        const result = await f.dispatcher.handle(request('group', [image(id)]), f.lease);
        expect(result).toMatchObject({ status: 'ok', retcode: 0, echo: ECHO });
        expect(f.reader).toHaveBeenCalledExactlyOnceWith(id, f.lease);
        expect(f.sensitive).toHaveBeenCalledExactlyOnceWith(
            'send_group_msg',
            expectedV11('group', data),
            expect.any(Function),
        );
        expect(f.raw).not.toHaveBeenCalled();
        expect(f.store.get(id, f.lease)).toEqual({ kind: 'ok', name: NAME, data, sha256 });
    });

    it('requires an explicit current lease and the sensitive capability, with no raw fallback', async () => {
        const f = fixture();
        const id = await upload(f);
        f.reader.mockClear();
        failed(await f.dispatcher.handle(request('private', image(id))), id);
        failed(await f.dispatcher.handle(request('private', image(id)), () => false), id);
        failed(
            await f.dispatcher.handle(request('private', image(id)), () => {
                throw new Error(SECRET);
            }),
            id,
        );
        Object.defineProperty(f.api, 'handleV12SensitiveMessage', {
            value: undefined,
            configurable: true,
        });
        failed(await f.dispatcher.handle(request('private', image(id)), f.lease), id);
        noSend(f);
    });

    it('rejects foreign, expired, malformed, empty and inbound media IDs', async () => {
        const f = fixture();
        const foreign = fixture('10002');
        const id = await upload(f);
        const foreignId = await upload(foreign);
        const emptyId = await upload(f, '', 'empty.bin');
        const imageTokens = new tokenModule.V12ImageFileTokens(SELF.user_id);
        const voiceTokens = new tokenModule.V12VoiceFileTokens(SELF.user_id);
        const imageRedeem = vi.spyOn(imageTokens, 'redeem');
        const voiceRedeem = vi.spyOn(voiceTokens, 'redeem');

        try {
            const incomingImage = imageTokens.issue('https://media.fixture.invalid/image');
            const incomingVoice = voiceTokens.issue('https://media.fixture.invalid/voice');

            for (const candidate of [
                foreignId,
                emptyId,
                PREFIX,
                `${PREFIX}not-an-id`,
                `${PREFIX}${'A'.repeat(42)}B`, // invalid base64url pad bits
                `${PREFIX}${'A'.repeat(43)}`, // canonical, but not issued
                incomingImage,
                incomingVoice,
                'legacy-alias',
            ]) {
                failed(
                    await f.dispatcher.handle(request('group', image(candidate)), f.lease),
                    candidate,
                );
                noSend(f);
            }

            expect(imageRedeem).not.toHaveBeenCalled();
            expect(voiceRedeem).not.toHaveBeenCalled();
            f.state.now += 600_000;
            failed(await f.dispatcher.handle(request('group', image(id)), f.lease), id);
            noSend(f);
        } finally {
            imageTokens.revoke();
            voiceTokens.revoke();
        }
    });

    it('isolates old listener tickets, a replacement listener and another account', async () => {
        // These are generation-specific in-memory tickets, not real listeners.
        const old = fixture();
        const oldId = await upload(old);
        old.state.current = false;
        old.store.close();
        const replacement = fixture();
        const replacementId = await upload(replacement);
        const other = fixture('10002');
        const otherId = await upload(other);
        failed(await old.dispatcher.handle(request('group', image(oldId)), old.lease), oldId);
        failed(
            await old.dispatcher.handle(request('group', image(replacementId)), old.lease),
            replacementId,
        );
        failed(
            await replacement.dispatcher.handle(request('group', image(oldId)), replacement.lease),
            oldId,
        );
        failed(
            await other.dispatcher.handle(
                request('group', image(replacementId), '10002'),
                other.lease,
            ),
            replacementId,
        );
        failed(
            await replacement.dispatcher.handle(
                request('group', image(otherId)),
                replacement.lease,
            ),
            otherId,
        );
        failed(
            await replacement.dispatcher.handle(
                request('group', image(replacementId), '10002'),
                replacement.lease,
            ),
            replacementId,
        );
        noSend(old);
        noSend(replacement);
        noSend(other);
    });

    it('rejects invalid shapes, extra keys, targets and mixed or repeated segments before any send', async () => {
        const f = fixture();
        const id = await upload(f);
        const valid = image(id);
        const text = { type: 'text', data: { text: 'synthetic' } };
        const cases: unknown[] = [
            request('private', { type: 'image' }),
            request('private', { type: 'image', data: null }),
            request('private', { type: 'image', data: {} }),
            request('private', image('')),
            request('private', image(123)),
            request('private', { ...valid, extra: SECRET }),
            request('private', { type: 'image', data: { file_id: id, extra: SECRET } }),
            { ...request('private', valid), extra: SECRET },
            { ...request('private', valid), self: { ...SELF, extra: SECRET } },
            { ...request('private', valid), self: { ...SELF, user_id: '10002' } },
            { ...request('private', valid), self: { platform: 'other', user_id: SELF.user_id } },
            {
                ...request('private', valid),
                params: { detail_type: 'private', user_id: '0', message: valid },
            },
            {
                ...request('private', valid),
                params: { detail_type: 'private', user_id: '01', message: valid },
            },
            {
                ...request('private', valid),
                params: { detail_type: 'private', user_id: '4294967296', message: valid },
            },
            {
                ...request('group', valid),
                params: { detail_type: 'group', group_id: '-1', message: valid },
            },
            {
                ...request('group', valid),
                params: { detail_type: 'group', group_id: '44', user_id: '42', message: valid },
            },
            {
                ...request('group', valid),
                params: { detail_type: 'group', group_id: '44', message: valid, extra: SECRET },
            },
            request('group', [{ type: 'file', data: { file_id: id } }]),
            request('group', [{ type: 'voice', data: { file_id: id } }]),
            request('group', [{ type: 'video', data: { file_id: id } }]),
            request('group', [valid, text]),
            request('group', [text, valid]),
            request('group', [valid, valid]),
            request('group', [valid, { type: 'mention_all', data: {} }]),
        ];
        f.reader.mockClear();

        for (const input of cases) {
            const before = structuredClone(input);
            failed(await f.dispatcher.handle(input, f.lease), id);
            expect(input).toEqual(before);
            noSend(f);
        }
    });

    it('rejects accessor and Proxy inputs without invoking their traps', async () => {
        const f = fixture();
        const id = await upload(f);
        let getterCalls = 0;
        let trapCalls = 0;
        const getterData = Object.defineProperty({}, 'file_id', {
            enumerable: true,
            get() {
                getterCalls += 1;
                throw new Error(SECRET);
            },
        });
        const proxy = new Proxy(
            { file_id: id },
            {
                ownKeys() {
                    trapCalls += 1;
                    throw new Error(SECRET);
                },
                get() {
                    trapCalls += 1;
                    throw new Error(SECRET);
                },
            },
        );

        for (const data of [getterData, proxy]) {
            failed(
                await f.dispatcher.handle(request('group', { type: 'image', data }), f.lease),
                id,
            );
        }

        expect(getterCalls).toBe(0);
        expect(trapCalls).toBe(0);
        expect(f.reader).not.toHaveBeenCalled();
        noSend(f);
    });
});

describe('uploaded image reader and capability boundaries', () => {
    it('rejects malformed, noncanonical, oversized and mismatched reader data', async () => {
        const f = fixture();
        const id = await upload(f);
        const oversized = Buffer.alloc(MAX_BYTES + 1, 0x61);
        const cases: unknown[] = [
            { kind: 'not_found' },
            { kind: 'unavailable' },
            {
                kind: 'ok',
                name: NAME,
                data: '',
                sha256: createHash('sha256').update('').digest('hex'),
            },
            { kind: 'ok', name: NAME, data: 'AB==', sha256: SHA256 },
            { kind: 'ok', name: NAME, data: 'AA', sha256: SHA256 },
            { kind: 'ok', name: NAME, data: '-_==', sha256: SHA256 },
            {
                kind: 'ok',
                name: NAME,
                data: oversized.toString('base64'),
                sha256: createHash('sha256').update(oversized).digest('hex'),
            },
            { kind: 'ok', name: NAME, data: DATA, sha256: '0'.repeat(64) },
            { kind: 'ok', name: NAME, data: DATA, sha256: SHA256.toUpperCase() },
            { kind: 'ok', name: NAME, data: DATA, sha256: 3 },
            { kind: 'ok', name: NAME, data: 3, sha256: SHA256 },
        ];

        for (const returned of cases) {
            f.reader.mockClear();
            f.reader.mockImplementationOnce(() => returned as V12ReadUploadResult);
            failed(await f.dispatcher.handle(request('private', image(id)), f.lease), id);
            expect(f.reader).toHaveBeenCalledExactlyOnceWith(id, f.lease);
            noSend(f);
        }

        expect(f.store.get(id, f.lease)).toEqual({
            kind: 'ok',
            name: NAME,
            data: DATA,
            sha256: SHA256,
        });
    });

    it('rejects throwing providers and accessor or Proxy results without disclosing data', async () => {
        const f = fixture();
        const id = await upload(f);
        let getterCalls = 0;
        let trapCalls = 0;
        const getter = Object.defineProperty({ kind: 'ok', name: NAME, sha256: SHA256 }, 'data', {
            enumerable: true,
            get() {
                getterCalls += 1;
                throw new Error(SECRET);
            },
        });
        const proxy = new Proxy(
            { kind: 'ok', name: NAME, data: DATA, sha256: SHA256 },
            {
                get() {
                    trapCalls += 1;
                    throw new Error(SECRET);
                },
                getOwnPropertyDescriptor() {
                    trapCalls += 1;
                    throw new Error(SECRET);
                },
            },
        );

        for (const returned of [getter, proxy]) {
            f.reader.mockClear();
            f.reader.mockImplementationOnce(() => returned as unknown as V12ReadUploadResult);
            failed(await f.dispatcher.handle(request('private', image(id)), f.lease), id);
            expect(f.reader).toHaveBeenCalledExactlyOnceWith(id, f.lease);
            noSend(f);
        }

        f.reader.mockClear();
        f.reader.mockImplementationOnce(() => {
            throw new Error(`${SECRET} ${id} ${DATA}`);
        });
        failed(await f.dispatcher.handle(request('private', image(id)), f.lease), id);
        expect(f.reader).toHaveBeenCalledExactlyOnceWith(id, f.lease);
        expect(getterCalls).toBe(0);
        expect(trapCalls).toBe(0);
        noSend(f);
    });

    it('rejects an accessor reader and accessor or Proxy sensitive capability', async () => {
        for (const mode of ['reader', 'capability', 'api-proxy'] as const) {
            const f = fixture();
            const id = await upload(f);
            let getterCalls = 0;
            let trapCalls = 0;

            if (mode === 'reader') {
                Object.defineProperty(f.options, 'getUploadedDataFile', {
                    configurable: true,
                    get() {
                        getterCalls += 1;
                        throw new Error(SECRET);
                    },
                });
            } else if (mode === 'capability') {
                Object.defineProperty(f.api, 'handleV12SensitiveMessage', {
                    configurable: true,
                    get() {
                        getterCalls += 1;
                        throw new Error(SECRET);
                    },
                });
            } else {
                f.options.api = new Proxy(f.api, {
                    get() {
                        trapCalls += 1;
                        throw new Error(SECRET);
                    },
                    getOwnPropertyDescriptor() {
                        trapCalls += 1;
                        throw new Error(SECRET);
                    },
                });
            }

            failed(await f.dispatcher.handle(request('group', image(id)), f.lease), id);
            expect(getterCalls).toBe(0);
            expect(trapCalls).toBe(0);
            noSend(f);
        }
    });

    it.each(['throw', 'revoke'] as const)(
        'fails closed when the readiness callback synchronously performs %s',
        async (effect) => {
            const f = fixture();
            const id = await upload(f);
            f.reader.mockClear();
            f.readiness.mockImplementationOnce(() => {
                if (effect === 'throw') {
                    throw new Error(`${SECRET} ${id} ${DATA}`);
                }

                f.state.current = false;
                return true;
            });
            failed(await f.dispatcher.handle(request('private', image(id)), f.lease), id);
            noSend(f);
        },
    );

    it.each(['revoke', 'close', 'replace-reader', 'replace-api', 'replace-method'] as const)(
        'rechecks the original lease and identities after the reader synchronously performs %s',
        async (change) => {
            const f = fixture();
            const id = await upload(f);
            const replacementReader = vi.fn(() => ({ kind: 'unavailable' as const }));
            const replacementSensitive = vi.fn(async (): Promise<ApiResponse> => success());
            const replacementApi = {
                handle: f.raw,
                handleV12SensitiveMessage: replacementSensitive,
            };
            f.reader.mockClear();
            f.reader.mockImplementationOnce((fileId, lease) => {
                const result = f.store.get(fileId, lease);

                if (change === 'revoke' || change === 'close') {
                    f.state.current = false;

                    if (change === 'close') {
                        f.store.close();
                    }
                } else if (change === 'replace-reader') {
                    f.options.getUploadedDataFile = replacementReader;
                } else if (change === 'replace-api') {
                    f.options.api = replacementApi;
                } else {
                    Object.defineProperty(f.api, 'handleV12SensitiveMessage', {
                        value: replacementSensitive,
                        configurable: true,
                    });
                }

                return result;
            });
            failed(await f.dispatcher.handle(request('group', image(id)), f.lease), id);
            expect(f.reader).toHaveBeenCalledExactlyOnceWith(id, f.lease);
            expect(replacementReader).not.toHaveBeenCalled();
            expect(replacementSensitive).not.toHaveBeenCalled();
            noSend(f);
        },
    );

    it.each(['lease', 'readiness'] as const)(
        'rechecks identities when the %s callback synchronously replaces the API after reading',
        async (source) => {
            const f = fixture();
            const id = await upload(f);
            const replacementSensitive = vi.fn(async (): Promise<ApiResponse> => success());
            const replacementApi = {
                handle: f.raw,
                handleV12SensitiveMessage: replacementSensitive,
            };
            let changes = 0;

            const replace = () => {
                changes += 1;
                f.options.api = replacementApi;
            };

            f.reader.mockClear();
            f.reader.mockImplementationOnce((fileId, lease) => {
                const result = f.store.get(fileId, lease);

                if (source === 'lease') {
                    f.state.onLease = replace;
                } else {
                    f.readiness.mockImplementationOnce((candidate) => {
                        replace();
                        return candidate?.() === true;
                    });
                }

                return result;
            });
            failed(await f.dispatcher.handle(request('private', image(id)), f.lease), id);
            expect(changes).toBe(1);
            expect(f.reader).toHaveBeenCalledExactlyOnceWith(id, f.lease);
            expect(replacementSensitive).not.toHaveBeenCalled();
            noSend(f);
        },
    );

    it('rejects synchronous reentry through a revoked old ticket', async () => {
        const f = fixture();
        const id = await upload(f);
        let nested: Promise<V12Response> | undefined;
        f.reader.mockClear();
        f.reader.mockImplementationOnce((fileId, lease) => {
            const result = f.store.get(fileId, lease);
            f.state.current = false;
            f.store.close();
            nested = f.dispatcher.handle(request('group', image(id)), f.lease);
            return result;
        });
        const outer = await f.dispatcher.handle(request('group', image(id)), f.lease);
        expect(nested).toBeDefined();
        failed(outer, id);
        failed(await nested!, id);
        expect(f.reader).toHaveBeenCalledExactlyOnceWith(id, f.lease);
        noSend(f);
    });
});

describe('uploaded image in-flight accounting and uncertain outcomes', () => {
    it('does not report success if an injected capability ignores the start guard', async () => {
        const f = fixture();
        const id = await upload(f);
        f.sensitive.mockImplementationOnce(async () => success());
        const result = await f.dispatcher.handle(request('private', image(id)), f.lease);
        expect(result).toMatchObject({ status: 'failed', retcode: 20002, data: null });
        expect(result.message).toContain('do not retry automatically');
        expect(f.sensitive).toHaveBeenCalledTimes(1);
        expect(f.getSentMessageTime).not.toHaveBeenCalled();
    });

    it('holds four slots across an upstream timeout and until sent-time metadata settles', async () => {
        const f = fixture();
        const id = await upload(f);
        const gates = Array.from({ length: 5 }, () => deferred<ApiResponse>());
        const time = deferred<number | null>();
        let index = 0;
        f.reader.mockClear();
        f.sensitive.mockImplementation((_action, _params, canStart) => {
            if (canStart?.() !== true) {
                return Promise.resolve({ status: 'failed', retcode: 100, data: null });
            }

            return gates[index++]!.promise;
        });
        f.getSentMessageTime.mockImplementationOnce(() => time.promise);
        const pending: Promise<V12Response>[] = [];

        try {
            for (let i = 0; i < 4; i += 1) {
                pending.push(f.dispatcher.handle(request('group', image(id)), f.lease));
                await flush();
            }

            expect(f.reader).toHaveBeenCalledTimes(4);
            expect(f.sensitive).toHaveBeenCalledTimes(4);
            const timedOut = await Promise.race([
                pending[0]!.then(() => 'settled'),
                Promise.resolve('upstream-timeout'),
            ]);
            expect(timedOut).toBe('upstream-timeout');
            const firstOverflow = f.dispatcher.handle(request('group', image(id)), f.lease);
            pending.push(firstOverflow);
            failed(await immediateResult(firstOverflow), id);
            expect(f.reader).toHaveBeenCalledTimes(4);
            expect(f.sensitive).toHaveBeenCalledTimes(4);
            gates[0]!.resolve(success());
            await flush();
            expect(f.getSentMessageTime).toHaveBeenCalledExactlyOnceWith(MESSAGE_ID);
            const secondOverflow = f.dispatcher.handle(request('group', image(id)), f.lease);
            pending.push(secondOverflow);
            failed(await immediateResult(secondOverflow), id);
            expect(f.reader).toHaveBeenCalledTimes(4);
            expect(f.sensitive).toHaveBeenCalledTimes(4);
            time.resolve(TIME);
            expect(await pending[0]).toMatchObject({ status: 'ok', retcode: 0 });
            const admitted = f.dispatcher.handle(request('group', image(id)), f.lease);
            pending.push(admitted);
            await flush();
            expect(f.reader).toHaveBeenCalledTimes(5);
            expect(f.sensitive).toHaveBeenCalledTimes(5);
            gates[4]!.resolve(success());
            expect(await admitted).toMatchObject({ status: 'ok', retcode: 0 });
            expect(f.raw).not.toHaveBeenCalled();
        } finally {
            for (const gate of gates) {
                gate.resolve(success());
            }

            time.resolve(TIME);
            await Promise.all(pending);
        }
    });

    it.each(['throw', 'failure', 'invalid-id', 'time-null', 'time-throw'] as const)(
        'does not retry or leak content after %s',
        async (mode) => {
            const f = fixture();
            const id = await upload(f);

            if (mode === 'throw' || mode === 'failure' || mode === 'invalid-id') {
                f.sensitive.mockImplementationOnce(async (_action, _params, canStart) => {
                    if (canStart?.() !== true) {
                        throw new Error('synthetic start guard failed');
                    }

                    if (mode === 'throw') {
                        throw new Error(`${SECRET} ${id} ${DATA}`);
                    }

                    return mode === 'failure'
                        ? { status: 'failed', retcode: 123, data: null, wording: SECRET }
                        : { status: 'ok', retcode: 0, data: { message_id: 0 } };
                });
            } else if (mode === 'time-null') {
                f.getSentMessageTime.mockReturnValueOnce(null);
            } else {
                f.getSentMessageTime.mockImplementationOnce(() => {
                    throw new Error(`${SECRET} ${id} ${DATA}`);
                });
            }

            f.reader.mockClear();
            const result = await f.dispatcher.handle(request('private', image(id)), f.lease);
            failed(result, id, String(MESSAGE_ID));
            expect(f.reader).toHaveBeenCalledExactlyOnceWith(id, f.lease);
            expect(f.sensitive).toHaveBeenCalledExactlyOnceWith(
                'send_private_msg',
                expectedV11('private', DATA),
                expect.any(Function),
            );
            expect(f.raw).not.toHaveBeenCalled();
            expect(f.getSentMessageTime).toHaveBeenCalledTimes(mode.startsWith('time-') ? 1 : 0);
            expect(f.store.get(id, f.lease)).toEqual({
                kind: 'ok',
                name: NAME,
                data: DATA,
                sha256: SHA256,
            });
        },
    );
});
