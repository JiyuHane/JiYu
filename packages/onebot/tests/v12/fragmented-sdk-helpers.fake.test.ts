import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '../../src/types';
import type { V12CoreOptions, V12FileLease, V12Response } from '../../src/v12/types';

// The SDK public entry, dispatcher and upload store are real. The HTTP-shaped
// exchange terminates in a fake fetch: no runtime, bridge, server or socket exists.
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
            throw new Error('unexpected real ApiHandler');
        }
    },
}));
vi.mock('../../src/v12-runtime/runtime', () => ({
    V12Runtime: class {
        constructor() {
            forbidden.constructions.push('V12Runtime');
            throw new Error('unexpected V12Runtime');
        }
    },
}));

let sdk: typeof import('../../../sdk/src/v12/index');
let dispatcherModule: typeof import('../../src/v12/dispatcher');
let storeModule: typeof import('../../src/v12/uploaded-data-store');
let guards: Array<{ mock: { calls: unknown[] } }>;
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let stores: Array<{ close(): void }>;
let randomSequence: number;

function blocked(): never {
    throw new Error('unexpected network, process or native operation in fixture');
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

    // Install all guards before loading either subject. OneBot has no SDK
    // dependency, so this source path is the actual @harehane/sdk/v12 entry.
    sdk = await import('../../../sdk/src/v12/index');
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

const SELF_A = { platform: 'qq', user_id: '10001' };
const SELF_B = { platform: 'qq', user_id: '10002' };
const ENDPOINT = 'http://fixture.invalid/';
const NAME = 'synthetic-霁羽.bin';
const ABC_DATA = 'YWJj';
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

type WireRequest = {
    action: string;
    params: JsonObject;
    echo?: string;
    self?: { platform: string; user_id: string };
};

function account(self = SELF_A) {
    const state = { current: true, supported: true, now: 100 };
    const store = new storeModule.V12UploadedDataStore({
        now: () => state.now,
        randomBytes: (size) => Buffer.alloc(size, ++randomSequence),
    });
    stores.push(store);
    const lease = vi.fn(() => state.current);
    const upload = vi.fn((name: string, data: string, sha256?: string, guard?: V12FileLease) =>
        store.upload(name, data, sha256, guard),
    );
    const get = vi.fn((id: string, guard?: V12FileLease) => store.get(id, guard));
    const metadata = vi.fn((id: string, guard?: V12FileLease) => store.getMetadata(id, guard));
    const chunk = vi.fn((id: string, offset: number, size: number, guard?: V12FileLease) =>
        store.getChunk(id, offset, size, guard),
    );
    const readiness = vi.fn(
        (guard?: V12FileLease) => state.supported && (guard === undefined || guard() === true),
    );
    const api = {
        handle: vi.fn(async (_action: string, _params: JsonObject) => {
            throw new Error('unexpected v11 action');
        }),
    };
    const options: V12CoreOptions = {
        self,
        version: { impl: 'fixture', version: '1' },
        api,
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime: () => null,
        uploadDataFile: upload,
        getUploadedDataFile: get,
        getUploadedDataFileMetadata: metadata,
        getUploadedDataFileChunk: chunk,
        isUploadDataSupported: readiness,
    };
    const dispatcher = new dispatcherModule.V12Dispatcher(options);
    return {
        self,
        state,
        store,
        lease,
        upload,
        get,
        metadata,
        chunk,
        readiness,
        api,
        options,
        dispatcher,
    };
}

type Account = ReturnType<typeof account>;

function fakeServer(target: Account) {
    const requests: WireRequest[] = [];
    const responses: V12Response[] = [];
    const state: { mutate?: (response: V12Response) => object } = {};
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe(ENDPOINT);
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('error');
        expect(init?.headers).toBeInstanceOf(Headers);
        expect((init?.headers as Headers).get('content-type')).toBe('application/json');
        expect((init?.headers as Headers).get('accept')).toBe('application/json');
        expect(typeof init?.body).toBe('string');
        const body = JSON.parse(init!.body as string) as WireRequest;
        requests.push(body);
        const result = await target.dispatcher.handle(body, target.lease);
        responses.push(result);
        return new Response(JSON.stringify(state.mutate ? state.mutate(result) : result), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    });
    const client = new sdk.OneBot12HttpClient({ baseUrl: ENDPOINT, fetch });
    return { client, fetch, requests, responses, state };
}

type Server = ReturnType<typeof fakeServer>;

// Every operation passed here must cause exactly one fake HTTP exchange, even
// when the SDK rejects a bad echo or malformed successful response.
async function oneFetch<T>(server: Server, operation: () => Promise<T>): Promise<T> {
    const before = server.fetch.mock.calls.length;

    try {
        return await operation();
    } finally {
        expect(server.fetch.mock.calls.length).toBe(before + 1);
    }
}

async function upload(
    server: Server,
    self = SELF_A,
    data = ABC_DATA,
    name = NAME,
): Promise<string> {
    const result = await oneFetch(server, () =>
        server.client.request(
            'upload_file',
            { type: 'data', name, data },
            { self, echo: 'upload' },
        ),
    );
    expect(result).toMatchObject({ status: 'ok', retcode: 0, echo: 'upload' });

    if (
        result.status !== 'ok' ||
        typeof result.data !== 'object' ||
        result.data === null ||
        Array.isArray(result.data) ||
        typeof result.data.file_id !== 'string'
    ) {
        throw new Error('fixture upload did not return a file ID');
    }

    expect(result.data.file_id).toMatch(/^jiyu-upload:v1:/);
    return result.data.file_id;
}

function prepare(fileId: string) {
    return { stage: 'prepare' as const, file_id: fileId };
}

function transfer(fileId: string, offset: number, size: number) {
    return { stage: 'transfer' as const, file_id: fileId, offset, size };
}

describe('fragment helpers with the real SDK, dispatcher and local upload store', () => {
    it('uploads data, prepares metadata and transfers exactly one requested fragment', async () => {
        const target = account();
        const server = fakeServer(target);
        const fileId = await upload(server);
        const prepared = await oneFetch(server, () =>
            sdk.prepareOneBot12FileFragment(server.client, prepare(fileId), {
                self: SELF_A,
                echo: 'prepare-echo',
            }),
        );
        expect(prepared).toEqual({
            status: 'ok',
            retcode: 0,
            data: { name: NAME, total_size: 3, sha256: ABC_SHA256 },
            message: '',
            echo: 'prepare-echo',
        });
        const part = await oneFetch(server, () =>
            sdk.transferOneBot12FileFragment(server.client, transfer(fileId, 1, 2), {
                self: SELF_A,
                echo: 'fragment-echo',
            }),
        );
        expect(part).toEqual({
            status: 'ok',
            retcode: 0,
            data: { data: 'YmM=' },
            message: '',
            echo: 'fragment-echo',
        });

        if (part.status !== 'ok') {
            throw new Error('fixture fragment did not succeed');
        }

        expect(Buffer.from(part.data.data, 'base64')).toEqual(Buffer.from('bc'));
        expect(server.requests).toEqual([
            {
                action: 'upload_file',
                params: { type: 'data', name: NAME, data: ABC_DATA },
                self: SELF_A,
                echo: 'upload',
            },
            {
                action: 'get_file_fragmented',
                params: prepare(fileId),
                self: SELF_A,
                echo: 'prepare-echo',
            },
            {
                action: 'get_file_fragmented',
                params: transfer(fileId, 1, 2),
                self: SELF_A,
                echo: 'fragment-echo',
            },
        ]);
        expect(target.upload).toHaveBeenCalledExactlyOnceWith(
            NAME,
            ABC_DATA,
            undefined,
            target.lease,
        );
        expect(target.metadata).toHaveBeenCalledExactlyOnceWith(fileId, target.lease);
        expect(target.chunk).toHaveBeenCalledExactlyOnceWith(fileId, 1, 2, target.lease);
        expect(target.get).not.toHaveBeenCalled();
        expect(target.api.handle).not.toHaveBeenCalled();
        expect(server.fetch).toHaveBeenCalledTimes(3);
    });

    it('keeps zero-length uploads and zero-length EOF fragments intact', async () => {
        const target = account();
        const server = fakeServer(target);
        const fileId = await upload(server, SELF_A, '', 'empty.bin');
        const prepared = await oneFetch(server, () =>
            sdk.prepareOneBot12FileFragment(server.client, prepare(fileId), {
                self: SELF_A,
                echo: '',
            }),
        );
        expect(prepared).toEqual({
            status: 'ok',
            retcode: 0,
            data: { name: 'empty.bin', total_size: 0, sha256: EMPTY_SHA256 },
            message: '',
            echo: '',
        });
        const part = await oneFetch(server, () =>
            sdk.transferOneBot12FileFragment(server.client, transfer(fileId, 0, 0), {
                self: SELF_A,
                echo: 'empty',
            }),
        );
        expect(part).toEqual({
            status: 'ok',
            retcode: 0,
            data: { data: '' },
            message: '',
            echo: 'empty',
        });
        expect(target.metadata).toHaveBeenCalledExactlyOnceWith(fileId, target.lease);
        expect(target.chunk).toHaveBeenCalledExactlyOnceWith(fileId, 0, 0, target.lease);
        expect(target.api.handle).not.toHaveBeenCalled();
    });

    it('preserves server failures for mismatched self and a different account store', async () => {
        const a = account(SELF_A);
        const b = account(SELF_B);
        const serverA = fakeServer(a);
        const serverB = fakeServer(b);
        const fileId = await upload(serverA);
        const mismatch = await oneFetch(serverA, () =>
            sdk.prepareOneBot12FileFragment(serverA.client, prepare(fileId), {
                self: SELF_B,
                echo: 'wrong-self',
            }),
        );
        expect(mismatch).toEqual({
            status: 'failed',
            retcode: 10102,
            data: null,
            message: 'unknown self',
            echo: 'wrong-self',
        });
        expect(mismatch).toEqual(serverA.responses[serverA.responses.length - 1]);
        expect(a.metadata).not.toHaveBeenCalled();
        const foreign = await oneFetch(serverB, () =>
            sdk.prepareOneBot12FileFragment(serverB.client, prepare(fileId), {
                self: SELF_B,
                echo: 'foreign',
            }),
        );
        expect(foreign).toEqual({
            status: 'failed',
            retcode: 20001,
            data: null,
            message: 'invalid file result',
            echo: 'foreign',
        });
        expect(foreign).toEqual(serverB.responses[serverB.responses.length - 1]);
        expect(b.metadata).toHaveBeenCalledExactlyOnceWith(fileId, b.lease);
        const foreignPart = await oneFetch(serverB, () =>
            sdk.transferOneBot12FileFragment(serverB.client, transfer(fileId, 0, 1), {
                self: SELF_B,
                echo: 'foreign-part',
            }),
        );
        expect(foreignPart).toEqual({
            status: 'failed',
            retcode: 20001,
            data: null,
            message: 'invalid file result',
            echo: 'foreign-part',
        });
        expect(foreignPart).toEqual(serverB.responses[serverB.responses.length - 1]);
        expect(b.chunk).toHaveBeenCalledExactlyOnceWith(fileId, 0, 1, b.lease);
        expect(a.api.handle).not.toHaveBeenCalled();
        expect(b.api.handle).not.toHaveBeenCalled();
    });

    it('preserves unsupported and out-of-range failures without a retry', async () => {
        const target = account();
        const server = fakeServer(target);
        const fileId = await upload(server);
        const negative = await oneFetch(server, () =>
            sdk.transferOneBot12FileFragment(server.client, transfer(fileId, -1, 1), {
                self: SELF_A,
                echo: 'negative',
            }),
        );
        expect(negative).toEqual({
            status: 'failed',
            retcode: 10003,
            data: null,
            message: 'invalid file parameters',
            echo: 'negative',
        });
        expect(negative).toEqual(server.responses[server.responses.length - 1]);
        expect(target.chunk).not.toHaveBeenCalled();
        const beyond = await oneFetch(server, () =>
            sdk.transferOneBot12FileFragment(server.client, transfer(fileId, 2, 2), {
                self: SELF_A,
                echo: 'beyond',
            }),
        );
        expect(beyond).toEqual({
            status: 'failed',
            retcode: 10004,
            data: null,
            message: 'unsupported file range',
            echo: 'beyond',
        });
        expect(beyond).toEqual(server.responses[server.responses.length - 1]);
        expect(target.chunk).toHaveBeenCalledExactlyOnceWith(fileId, 2, 2, target.lease);
        target.options.getUploadedDataFileChunk = undefined;
        const unsupported = await oneFetch(server, () =>
            sdk.prepareOneBot12FileFragment(server.client, prepare(fileId), {
                self: SELF_A,
                echo: 'unsupported',
            }),
        );
        expect(unsupported).toEqual({
            status: 'failed',
            retcode: 10002,
            data: null,
            message: 'unsupported action',
            echo: 'unsupported',
        });
        expect(unsupported).toEqual(server.responses[server.responses.length - 1]);
        expect(target.metadata).not.toHaveBeenCalled();
        expect(target.api.handle).not.toHaveBeenCalled();
    });

    it('does not disclose a result if its lease expires during the metadata read', async () => {
        const target = account();
        const server = fakeServer(target);
        const fileId = await upload(server);
        target.metadata.mockImplementationOnce((id, guard) => {
            const result = target.store.getMetadata(id, guard);
            target.state.current = false;
            return result;
        });
        const stale = await oneFetch(server, () =>
            sdk.prepareOneBot12FileFragment(server.client, prepare(fileId), {
                self: SELF_A,
                echo: 'stale',
            }),
        );
        expect(stale).toEqual({
            status: 'failed',
            retcode: 20002,
            data: null,
            message: 'file unavailable',
            echo: 'stale',
        });
        expect(stale).toEqual(server.responses[server.responses.length - 1]);
        expect(target.metadata).toHaveBeenCalledExactlyOnceWith(fileId, target.lease);
        const revoked = await oneFetch(server, () =>
            sdk.transferOneBot12FileFragment(server.client, transfer(fileId, 0, 1), {
                self: SELF_A,
                echo: 'revoked',
            }),
        );
        expect(revoked).toEqual({
            status: 'failed',
            retcode: 10002,
            data: null,
            message: 'unsupported action',
            echo: 'revoked',
        });
        expect(revoked).toEqual(server.responses[server.responses.length - 1]);
        expect(target.chunk).not.toHaveBeenCalled();
        expect(target.api.handle).not.toHaveBeenCalled();
    });

    it('propagates an echo mismatch after the real server response without retrying', async () => {
        const target = account();
        const server = fakeServer(target);
        const fileId = await upload(server);
        server.state.mutate = (response) => ({ ...response, echo: 'different' });
        await expect(
            oneFetch(server, () =>
                sdk.prepareOneBot12FileFragment(server.client, prepare(fileId), {
                    self: SELF_A,
                    echo: 'expected',
                }),
            ),
        ).rejects.toMatchObject({ code: 'invalid_response' });
        expect(server.responses[server.responses.length - 1]).toMatchObject({
            status: 'ok',
            retcode: 0,
            echo: 'expected',
        });
        expect(target.metadata).toHaveBeenCalledExactlyOnceWith(fileId, target.lease);
        expect(server.fetch).toHaveBeenCalledTimes(2);
        expect(target.api.handle).not.toHaveBeenCalled();
    });

    it('rejects malformed helper input before reaching fake fetch', async () => {
        const target = account();
        const server = fakeServer(target);
        await expect(
            sdk.prepareOneBot12FileFragment(
                server.client,
                { stage: 'prepare', file_id: 42 as unknown as string },
                { self: SELF_A, echo: 'invalid-prepare' },
            ),
        ).rejects.toMatchObject({ code: 'invalid_options' });
        await expect(
            sdk.transferOneBot12FileFragment(server.client, transfer('file', 0.5, 1), {
                self: SELF_A,
                echo: 'invalid-transfer',
            }),
        ).rejects.toMatchObject({ code: 'invalid_options' });
        expect(server.fetch).not.toHaveBeenCalled();
        expect(target.upload).not.toHaveBeenCalled();
        expect(target.metadata).not.toHaveBeenCalled();
        expect(target.chunk).not.toHaveBeenCalled();
        expect(target.api.handle).not.toHaveBeenCalled();
    });

    it('rejects malformed successful fragment data after one exchange', async () => {
        const target = account();
        const server = fakeServer(target);
        const fileId = await upload(server);
        server.state.mutate = (response) => ({ ...response, data: { unexpected: true } });

        await expect(
            oneFetch(server, () =>
                sdk.prepareOneBot12FileFragment(server.client, prepare(fileId), {
                    self: SELF_A,
                    echo: 'bad-prepare',
                }),
            ),
        ).rejects.toMatchObject({ code: 'invalid_response' });
        await expect(
            oneFetch(server, () =>
                sdk.transferOneBot12FileFragment(server.client, transfer(fileId, 0, 1), {
                    self: SELF_A,
                    echo: 'bad-transfer',
                }),
            ),
        ).rejects.toMatchObject({ code: 'invalid_response' });
        expect(target.metadata).toHaveBeenCalledExactlyOnceWith(fileId, target.lease);
        expect(target.chunk).toHaveBeenCalledExactlyOnceWith(fileId, 0, 1, target.lease);
        expect(server.fetch).toHaveBeenCalledTimes(3);
        expect(target.api.handle).not.toHaveBeenCalled();
    });
});
