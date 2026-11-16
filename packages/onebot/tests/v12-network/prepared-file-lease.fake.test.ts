import dgram from 'node:dgram';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '../../src/types';
import type { V12Dispatcher } from '../../src/v12/dispatcher';
import type { V12CoreOptions, V12FileLease, V12Response } from '../../src/v12/types';

type DispatcherModule = typeof import('../../src/v12/dispatcher');
type StoreModule = typeof import('../../src/v12/uploaded-data-store');
type Store = InstanceType<StoreModule['V12UploadedDataStore']>;
type Preflight = ReturnType<V12Dispatcher['createInternalHttpPreflight']>;

// Only the real dispatcher and in-memory store are exercised. No transport is
// constructed; these guards also make accidental socket/native use observable.
const forbidden = vi.hoisted(() => ({ apiConstructed: 0 }));
vi.mock('../../src/api-handler', () => ({
    ApiHandler: class {
        constructor() {
            forbidden.apiConstructed++;
            throw new Error('unexpected V11 handler construction');
        }
    },
}));

let dispatcherModule: DispatcherModule;
let storeModule: StoreModule;
let stores: Store[];
let guards: Array<{ mock: { calls: unknown[] } }>;
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;

function blocked(): never {
    throw new Error('unexpected network or native operation in in-memory fixture');
}

beforeEach(async () => {
    stores = [];
    forbidden.apiConstructed = 0;
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
    dispatcherModule = await import('../../src/v12/dispatcher');
    storeModule = await import('../../src/v12/uploaded-data-store');
});

afterEach(() => {
    let closeFailures = 0;

    try {
        for (const store of stores) {
            try {
                store.close();
            } catch {
                closeFailures++;
            }
        }
    } finally {
        const calls = guards.map((guard) => guard.mock.calls.length);
        const fetchCalls = fetchGuard.mock.calls.length;
        const webSocketCalls = webSocketGuard.mock.calls.length;
        const apiConstructed = forbidden.apiConstructed;
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        expect(closeFailures).toBe(0);
        expect(calls).toEqual(calls.map(() => 0));
        expect(fetchCalls).toBe(0);
        expect(webSocketCalls).toBe(0);
        expect(apiConstructed).toBe(0);
    }
});

const self = { platform: 'qq', user_id: '10001' };
const version = { impl: 'fixture', version: '1' };

function uploadRequest(name = 'original.bin', data = 'AQID', echo = 'original-echo') {
    return { action: 'upload_file', params: { type: 'data', name, data }, echo };
}

function getRequest(fileId: string, echo = 'get-echo') {
    return { action: 'get_file', params: { type: 'data', file_id: fileId }, echo };
}

function ordinary(preflight: Preflight, input: unknown): object {
    const checked = preflight.classify(input);
    expect(checked.kind).toBe('ordinary');

    if (checked.kind !== 'ordinary') {
        throw new Error('expected an ordinary prepared action');
    }

    return checked.token;
}

function expectFailed(result: V12Response): void {
    expect(result.status).toBe('failed');
    expect(result.retcode).not.toBe(0);
    expect(result.data).toBeNull();
}

function uploadedId(result: V12Response): string {
    expect(result).toMatchObject({ status: 'ok', retcode: 0 });
    const data = result.data;

    if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        typeof data.file_id !== 'string'
    ) {
        throw new Error('expected a synthetic uploaded file ID');
    }

    return data.file_id;
}

function fixture() {
    const state: {
        a: boolean;
        b: boolean;
        onLeaseA?: () => boolean;
        onClock?: () => void;
        onEntropy?: (fileId: string) => void;
        onUploadGetter?: () => void;
        onGetGetter?: () => void;
    } = { a: true, b: true };
    let serial = 1;
    const store = new storeModule.V12UploadedDataStore({
        now: () => {
            state.onClock?.();
            return 1_000_000;
        },
        randomBytes: (size) => {
            const bytes = new Uint8Array(size);
            new DataView(bytes.buffer).setUint32(0, serial++);
            const fileId =
                storeModule.V12_UPLOAD_TOKEN_PREFIX + Buffer.from(bytes).toString('base64url');
            state.onEntropy?.(fileId);
            return bytes;
        },
    });
    stores.push(store);
    const storeUpload = vi.spyOn(store, 'upload');
    const storeGet = vi.spyOn(store, 'get');
    const leaseA = vi.fn(() => (state.onLeaseA ? state.onLeaseA() : state.a));
    const leaseB = vi.fn(() => state.b);
    const api = {
        handle: vi.fn(async (_action: string, _params: JsonObject) => ({
            status: 'ok' as const,
            retcode: 0,
            data: { message_id: -123 },
        })),
    };
    const uploadDataFile = vi.fn(
        (name: string, data: string, sha256?: string, lease?: V12FileLease) =>
            store.upload(name, data, sha256, lease),
    );
    const getUploadedDataFile = vi.fn((fileId: string, lease?: V12FileLease) =>
        store.get(fileId, lease),
    );
    const isUploadDataSupported = vi.fn((lease?: V12FileLease) => lease?.() === true);
    const options: V12CoreOptions = {
        self,
        version,
        api,
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime: () => 1_700_000_000,
        isUploadDataSupported,
        get uploadDataFile() {
            state.onUploadGetter?.();
            return uploadDataFile;
        },
        get getUploadedDataFile() {
            state.onGetGetter?.();
            return getUploadedDataFile;
        },
    };
    const dispatcher = new dispatcherModule.V12Dispatcher(options);
    const otherDispatcher = new dispatcherModule.V12Dispatcher(options);
    // A and B model distinct internal listener sources on the same dispatcher
    // and store, not accounts, authentication, sockets, or running listeners.
    const preflightA = dispatcher.createInternalHttpPreflight(leaseA);
    const preflightB = dispatcher.createInternalHttpPreflight(leaseB);
    const preflightDefault = dispatcher.createInternalHttpPreflight();
    return {
        state,
        storeUpload,
        storeGet,
        leaseA,
        leaseB,
        api,
        uploadDataFile,
        getUploadedDataFile,
        isUploadDataSupported,
        dispatcher,
        otherDispatcher,
        preflightA,
        preflightB,
        preflightDefault,
    };
}

type Fixture = ReturnType<typeof fixture>;

async function execute(f: Fixture, preflight: Preflight, input: unknown): Promise<V12Response> {
    return f.dispatcher.handlePreparedOrdinary(ordinary(preflight, input));
}

async function uploadB(f: Fixture, name = 'b.bin', data = 'BAUG'): Promise<string> {
    return uploadedId(await execute(f, f.preflightB, uploadRequest(name, data, 'b-upload')));
}

function clearEffects(f: Fixture): void {
    f.storeUpload.mockClear();
    f.storeGet.mockClear();
    f.uploadDataFile.mockClear();
    f.getUploadedDataFile.mockClear();
    f.isUploadDataSupported.mockClear();
    f.api.handle.mockClear();
}

describe('prepared ordinary file lease (real dispatcher/store, no sockets)', () => {
    it('binds each support token to its own live source, including readiness changes', async () => {
        const f = fixture();
        expect(f.preflightA).not.toBe(f.preflightB);
        expect(f.leaseA).not.toBe(f.leaseB);
        const supported = { action: 'get_supported_actions', params: {} };
        const whileAReady = ordinary(f.preflightA, supported);
        const afterARevoked = ordinary(f.preflightA, supported);
        const whileBReady = ordinary(f.preflightB, supported);
        expect(f.storeUpload).not.toHaveBeenCalled();
        expect(f.storeGet).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();

        const a = await f.dispatcher.handlePreparedOrdinary(whileAReady);
        expect(a).toMatchObject({ status: 'ok', retcode: 0 });
        expect(a.data).toContain('upload_file');
        expect(f.isUploadDataSupported).toHaveBeenCalledWith(f.leaseA);
        f.state.a = false;
        const old = await f.dispatcher.handlePreparedOrdinary(afterARevoked);
        expect(old).toMatchObject({ status: 'ok', retcode: 0 });
        expect(old.data).not.toContain('upload_file');
        const b = await f.dispatcher.handlePreparedOrdinary(whileBReady);
        expect(b).toMatchObject({ status: 'ok', retcode: 0 });
        expect(b.data).toContain('upload_file');
        expect(f.isUploadDataSupported).toHaveBeenCalledWith(f.leaseB);

        f.state.b = false;
        expect((await execute(f, f.preflightB, supported)).data).not.toContain('upload_file');
        f.state.b = true;
        expect((await execute(f, f.preflightB, supported)).data).toContain('upload_file');
        expect(f.storeUpload).not.toHaveBeenCalled();
        expect(f.storeGet).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('uses the isolated request snapshot and original lease once, rejecting foreign and forged tokens', async () => {
        const f = fixture();
        const input = uploadRequest();
        const token = ordinary(f.preflightA, input);
        input.action = 'get_version';
        input.params.name = 'changed.bin';
        input.params.data = 'BAUG';
        input.echo = 'changed-echo';
        const trap = vi.fn(() => {
            throw new Error('unexpected forged token inspection');
        });
        const forged = new Proxy(token, {
            get: trap,
            getPrototypeOf: trap,
            ownKeys: trap,
            getOwnPropertyDescriptor: trap,
            has: trap,
        });
        expect((await f.otherDispatcher.handlePreparedOrdinary(token)).retcode).toBe(10001);
        expect((await f.dispatcher.handlePreparedOrdinary(forged)).retcode).toBe(10001);
        expect((await f.dispatcher.handlePreparedOrdinary({})).retcode).toBe(10001);
        expect(trap).not.toHaveBeenCalled();
        expect(f.storeUpload).not.toHaveBeenCalled();

        const first = f.dispatcher.handlePreparedOrdinary(token);
        const replay = f.dispatcher.handlePreparedOrdinary(token);
        const result = await first;
        const fileId = uploadedId(result);
        expect(result.echo).toBe('original-echo');
        expect((await replay).retcode).toBe(10001);
        expect(f.uploadDataFile).toHaveBeenCalledTimes(1);
        expect(f.uploadDataFile).toHaveBeenCalledWith('original.bin', 'AQID', undefined, f.leaseA);
        expect(f.storeUpload).toHaveBeenCalledTimes(1);
        expect(f.storeUpload).toHaveBeenCalledWith('original.bin', 'AQID', undefined, f.leaseA);

        const read = getRequest(fileId, 'original-read-echo');
        const readToken = ordinary(f.preflightA, read);
        read.params.file_id = 'changed-id';
        read.params.type = 'url';
        read.echo = 'changed-read-echo';
        const response = await f.dispatcher.handlePreparedOrdinary(readToken);
        expect(response).toMatchObject({
            status: 'ok',
            retcode: 0,
            data: { name: 'original.bin', data: 'AQID' },
            echo: 'original-read-echo',
        });
        expect(f.getUploadedDataFile).toHaveBeenCalledExactlyOnceWith(fileId, f.leaseA);
        expect(f.storeGet).toHaveBeenCalledExactlyOnceWith(fileId, f.leaseA);
        expect((await f.dispatcher.handlePreparedOrdinary(readToken)).retcode).toBe(10001);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('prevents A tokens from committing or reading B data after A is revoked', async () => {
        const f = fixture();
        const bId = await uploadB(f);
        const uploadA = ordinary(f.preflightA, uploadRequest('stale-a.bin', 'BwgJ', 'stale-write'));
        const readA = ordinary(f.preflightA, getRequest(bId, 'stale-read'));
        clearEffects(f);
        f.state.a = false;
        expect(f.state.b).toBe(true);
        const write = await f.dispatcher.handlePreparedOrdinary(uploadA);
        const read = await f.dispatcher.handlePreparedOrdinary(readA);
        expectFailed(write);
        expectFailed(read);
        expect(write.echo).toBe('stale-write');
        expect(read.echo).toBe('stale-read');
        expect(f.storeUpload).not.toHaveBeenCalled();
        expect(f.storeGet).not.toHaveBeenCalled();
        expect(f.uploadDataFile).not.toHaveBeenCalled();
        expect(f.getUploadedDataFile).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();

        const bRead = await execute(f, f.preflightB, getRequest(bId));
        expect(bRead).toMatchObject({ status: 'ok', data: { name: 'b.bin', data: 'BAUG' } });
        expect(f.storeGet).toHaveBeenCalledExactlyOnceWith(bId, f.leaseB);
        const nextId = await uploadB(f, 'still-b.bin', 'Cg==');
        expect(nextId).not.toBe(bId);
        expect(f.storeUpload).toHaveBeenCalledExactlyOnceWith(
            'still-b.bin',
            'Cg==',
            undefined,
            f.leaseB,
        );
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('does not let an extra consume-time argument replace the token lease', async () => {
        const f = fixture();
        const staleA = ordinary(f.preflightA, uploadRequest('old.bin', 'AQID'));
        const liveA = ordinary(f.preflightA, uploadRequest('live.bin', 'BAUG'));
        f.state.a = false;
        const stale = await Reflect.apply(f.dispatcher.handlePreparedOrdinary, f.dispatcher, [
            staleA,
            f.leaseB,
        ]);
        expectFailed(stale);
        expect(f.uploadDataFile).not.toHaveBeenCalled();
        const version = await execute(f, f.preflightA, { action: 'get_version', params: {} });
        expect(version.retcode).toBe(0);

        f.state.a = true;
        f.state.b = false;
        const live = await Reflect.apply(f.dispatcher.handlePreparedOrdinary, f.dispatcher, [
            liveA,
            f.leaseB,
        ]);
        expect(live.retcode).toBe(0);
        expect(f.storeUpload).toHaveBeenCalledExactlyOnceWith(
            'live.bin',
            'BAUG',
            undefined,
            f.leaseA,
        );
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('classifies poll parameters without calling either bound file lease', () => {
        const f = fixture();
        f.state.a = false;
        const classified = f.preflightA.classify({
            action: 'get_latest_events',
            params: { limit: 2, timeout: 3 },
            echo: 'poll-echo',
        });
        expect(classified).toEqual({
            kind: 'poll',
            limit: 2,
            timeoutSeconds: 3,
            echo: 'poll-echo',
        });
        expect(f.leaseA).not.toHaveBeenCalled();
        expect(f.leaseB).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
        expect(f.storeUpload).not.toHaveBeenCalled();
        expect(f.storeGet).not.toHaveBeenCalled();
    });

    it('keeps the default preflight fail-closed for files but preserves ordinary non-file actions', async () => {
        const f = fixture();
        const bId = await uploadB(f);
        clearEffects(f);
        const supported = await execute(f, f.preflightDefault, {
            action: 'get_supported_actions',
            params: {},
        });
        expect(supported).toMatchObject({ status: 'ok', retcode: 0 });
        expect(supported.data).not.toContain('upload_file');
        expectFailed(await execute(f, f.preflightDefault, uploadRequest()));
        expectFailed(await execute(f, f.preflightDefault, getRequest(bId)));
        expect(f.storeUpload).not.toHaveBeenCalled();
        expect(f.storeGet).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();

        const result = await execute(f, f.preflightDefault, {
            action: 'get_version',
            params: {},
            echo: '',
        });
        expect(result).toEqual({
            status: 'ok',
            retcode: 0,
            data: { ...version, onebot_version: '12' },
            message: '',
            echo: '',
        });
        const message = await execute(f, f.preflightDefault, {
            action: 'send_message',
            params: { detail_type: 'private', user_id: '42', message: 'hello' },
            echo: 'text',
        });
        expect(message).toMatchObject({
            status: 'ok',
            retcode: 0,
            data: { message_id: '-123', time: 1_700_000_000 },
            echo: 'text',
        });
        expect(f.api.handle).toHaveBeenCalledExactlyOnceWith('send_private_msg', {
            user_id: 42,
            message: [{ type: 'text', data: { text: 'hello' } }],
            auto_escape: false,
        });
        expect(f.storeUpload).not.toHaveBeenCalled();
        expect(f.storeGet).not.toHaveBeenCalled();
    });

    it('rejects bad requests, unknown self and request getters before any callback or effect', () => {
        const f = fixture();
        const getter = vi.fn(() => {
            throw new Error('request getter must not run');
        });
        const withGetter = uploadRequest();
        Object.defineProperty(withGetter.params, 'data', { enumerable: true, get: getter });
        const inputs: Array<[unknown, number]> = [
            [{ action: 'upload_file', params: null, echo: '' }, 10001],
            [{ ...uploadRequest(), self: { ...self, user_id: '10002' } }, 10102],
            [{ ...uploadRequest(), extra: true }, 10004],
            [withGetter, 10001],
        ];

        for (const [input, retcode] of inputs) {
            const checked = f.preflightA.classify(input);
            expect(checked.kind).toBe('error');

            if (checked.kind !== 'error') {
                throw new Error('expected a preflight error');
            }

            expect(checked.response).toMatchObject({ status: 'failed', retcode, data: null });
        }

        expect(getter).not.toHaveBeenCalled();
        expect(f.isUploadDataSupported).not.toHaveBeenCalled();
        expect(f.uploadDataFile).not.toHaveBeenCalled();
        expect(f.getUploadedDataFile).not.toHaveBeenCalled();
        expect(f.storeUpload).not.toHaveBeenCalled();
        expect(f.storeGet).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it.each(['upload', 'get'] as const)(
        'stops before the store when the %s provider getter revokes A',
        async (operation) => {
            const f = fixture();
            const bId = await uploadB(f);
            clearEffects(f);
            let getterRan = false;

            const revoke = () => {
                getterRan = true;
                f.state.a = false;
                f.state.onUploadGetter = undefined;
                f.state.onGetGetter = undefined;
            };

            const token = ordinary(
                f.preflightA,
                operation === 'upload' ? uploadRequest() : getRequest(bId),
            );

            if (operation === 'upload') {
                f.state.onUploadGetter = revoke;
            } else {
                f.state.onGetGetter = revoke;
            }

            expectFailed(await f.dispatcher.handlePreparedOrdinary(token));
            expect(getterRan).toBe(true);
            expect(f.state.b).toBe(true);
            expect(f.uploadDataFile).not.toHaveBeenCalled();
            expect(f.getUploadedDataFile).not.toHaveBeenCalled();
            expect(f.storeUpload).not.toHaveBeenCalled();
            expect(f.storeGet).not.toHaveBeenCalled();
            expect(f.api.handle).not.toHaveBeenCalled();
            const supportedB = await execute(f, f.preflightB, {
                action: 'get_supported_actions',
                params: {},
            });
            expect(supportedB.data).toContain('upload_file');
        },
    );

    it('consumes before a reentrant lease revokes A and rechecks a stale true result', async () => {
        const f = fixture();
        const token = ordinary(f.preflightA, uploadRequest());
        let replay: Promise<V12Response> | undefined;
        let guardCalls = 0;

        f.state.onLeaseA = () => {
            guardCalls++;
            f.state.onLeaseA = undefined;
            f.state.a = false;
            replay = f.dispatcher.handlePreparedOrdinary(token);
            return true;
        };

        const result = await f.dispatcher.handlePreparedOrdinary(token);
        expectFailed(result);
        expect(guardCalls).toBe(1);
        expect(replay).toBeDefined();
        expect(await replay).toMatchObject({ status: 'failed', retcode: 10001, data: null });
        expect((await f.dispatcher.handlePreparedOrdinary(token)).retcode).toBe(10001);
        expect(f.state.b).toBe(true);
        expect(f.uploadDataFile).not.toHaveBeenCalled();
        expect(f.getUploadedDataFile).not.toHaveBeenCalled();
        expect(f.storeUpload).not.toHaveBeenCalled();
        expect(f.storeGet).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('does not claim rollback when a trusted lease returns a deliberately stale true', async () => {
        const f = fixture();
        let candidate: string | undefined;

        f.state.onEntropy = (fileId) => {
            candidate = fileId;

            f.state.onLeaseA = () => {
                f.state.a = false;
                f.state.onLeaseA = undefined;
                return true;
            };
        };

        const failed = await execute(f, f.preflightA, uploadRequest('stale-true.bin', 'AQID'));
        expectFailed(failed);
        expect(candidate).toBeDefined();
        expect(f.state.a).toBe(false);
        f.state.onEntropy = undefined;

        // A and B share a store only in this synthetic test. The dishonest A
        // callback allowed commit; a later failure did not roll it back.
        const stored = await execute(f, f.preflightB, getRequest(candidate!));
        expect(stored).toMatchObject({
            status: 'ok',
            data: { name: 'stale-true.bin', data: 'AQID' },
        });
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('passes A unchanged to the final commit guard when A is revoked inside the store', async () => {
        const f = fixture();
        const token = ordinary(f.preflightA, uploadRequest('race.bin', 'AQID', 'race-write'));
        let candidate = '';

        f.state.onEntropy = (fileId) => {
            candidate = fileId;
            f.state.a = false;
            f.state.onEntropy = undefined;
        };

        const result = await f.dispatcher.handlePreparedOrdinary(token);
        expectFailed(result);
        expect(result.echo).toBe('race-write');
        expect(candidate.startsWith(storeModule.V12_UPLOAD_TOKEN_PREFIX)).toBe(true);
        expect(f.uploadDataFile).toHaveBeenCalledExactlyOnceWith(
            'race.bin',
            'AQID',
            undefined,
            f.leaseA,
        );
        expect(f.storeUpload).toHaveBeenCalledExactlyOnceWith(
            'race.bin',
            'AQID',
            undefined,
            f.leaseA,
        );
        expect(f.storeUpload.mock.results[0]?.value).toEqual({ kind: 'unavailable' });
        const missing = await execute(f, f.preflightB, getRequest(candidate));
        expect(missing).toMatchObject({ status: 'failed', retcode: 20001, data: null });
        expect(f.storeGet).toHaveBeenCalledExactlyOnceWith(candidate, f.leaseB);
        expect(await uploadB(f, 'b-after-race.bin', 'BA==')).not.toBe(candidate);
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('passes A unchanged to the final read guard when A is revoked inside the store', async () => {
        const f = fixture();
        const bId = await uploadB(f);
        const token = ordinary(f.preflightA, getRequest(bId, 'race-read'));
        clearEffects(f);

        f.state.onClock = () => {
            f.state.a = false;
            f.state.onClock = undefined;
        };

        const result = await f.dispatcher.handlePreparedOrdinary(token);
        expectFailed(result);
        expect(result.echo).toBe('race-read');
        expect(f.getUploadedDataFile).toHaveBeenCalledExactlyOnceWith(bId, f.leaseA);
        expect(f.storeGet).toHaveBeenCalledExactlyOnceWith(bId, f.leaseA);
        expect(f.storeGet.mock.results[0]?.value).toEqual({ kind: 'unavailable' });
        const bRead = await execute(f, f.preflightB, getRequest(bId));
        expect(bRead).toMatchObject({ status: 'ok', data: { name: 'b.bin', data: 'BAUG' } });
        expect(f.storeGet).toHaveBeenLastCalledWith(bId, f.leaseB);
        expect(f.storeUpload).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
    });
});
