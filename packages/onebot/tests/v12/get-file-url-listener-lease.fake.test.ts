import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V12CoreOptions, V12FileLease, V12Response } from '../../src/v12/types';

// This suite creates only a dispatcher and synthetic callbacks. No real
// transport, account, Core, native artifact, subprocess or socket is needed.
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

let dispatcherApi: typeof import('../../src/v12/dispatcher');
let guards: Array<{ mock: { calls: unknown[] } }>;
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;

function blocked(): never {
    throw new Error('unexpected network, native or subprocess operation');
}

beforeEach(async () => {
    forbidden.attempts.length = 0;
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
        vi.spyOn(dns, 'Resolver').mockImplementation(blocked),
        vi.spyOn(dns, 'setServers').mockImplementation(blocked),
        vi.spyOn(dns, 'lookup').mockImplementation(blocked),
        vi.spyOn(dns, 'lookupService').mockImplementation(blocked),
        vi.spyOn(dns, 'resolve').mockImplementation(blocked),
        vi.spyOn(dns, 'resolve4').mockImplementation(blocked),
        vi.spyOn(dns, 'resolve6').mockImplementation(blocked),
        vi.spyOn(dns, 'resolveAny').mockImplementation(blocked),
        vi.spyOn(dns, 'resolveCaa').mockImplementation(blocked),
        vi.spyOn(dns, 'resolveCname').mockImplementation(blocked),
        vi.spyOn(dns, 'resolveMx').mockImplementation(blocked),
        vi.spyOn(dns, 'resolveNaptr').mockImplementation(blocked),
        vi.spyOn(dns, 'resolveNs').mockImplementation(blocked),
        vi.spyOn(dns, 'resolvePtr').mockImplementation(blocked),
        vi.spyOn(dns, 'resolveSoa').mockImplementation(blocked),
        vi.spyOn(dns, 'resolveSrv').mockImplementation(blocked),
        vi.spyOn(dns, 'resolveTxt').mockImplementation(blocked),
        vi.spyOn(dns, 'reverse').mockImplementation(blocked),
        vi.spyOn(dns.promises, 'Resolver').mockImplementation(blocked),
        vi.spyOn(dns.promises, 'setServers').mockImplementation(blocked),
        vi.spyOn(dns.promises, 'lookup').mockImplementation(blocked),
        vi.spyOn(dns.promises, 'lookupService').mockImplementation(blocked),
        vi.spyOn(dns.promises, 'resolve').mockImplementation(blocked),
        vi.spyOn(dns.promises, 'resolve4').mockImplementation(blocked),
        vi.spyOn(dns.promises, 'resolve6').mockImplementation(blocked),
        vi.spyOn(dns.promises, 'resolveAny').mockImplementation(blocked),
        vi.spyOn(dns.promises, 'resolveCaa').mockImplementation(blocked),
        vi.spyOn(dns.promises, 'resolveCname').mockImplementation(blocked),
        vi.spyOn(dns.promises, 'resolveMx').mockImplementation(blocked),
        vi.spyOn(dns.promises, 'resolveNaptr').mockImplementation(blocked),
        vi.spyOn(dns.promises, 'resolveNs').mockImplementation(blocked),
        vi.spyOn(dns.promises, 'resolvePtr').mockImplementation(blocked),
        vi.spyOn(dns.promises, 'resolveSoa').mockImplementation(blocked),
        vi.spyOn(dns.promises, 'resolveSrv').mockImplementation(blocked),
        vi.spyOn(dns.promises, 'resolveTxt').mockImplementation(blocked),
        vi.spyOn(dns.promises, 'reverse').mockImplementation(blocked),
        vi.spyOn(childProcess, 'exec').mockImplementation(blocked),
        vi.spyOn(childProcess, 'execFile').mockImplementation(blocked),
        vi.spyOn(childProcess, 'fork').mockImplementation(blocked),
        vi.spyOn(childProcess, 'spawn').mockImplementation(blocked),
        vi.spyOn(childProcess, 'execSync').mockImplementation(blocked),
        vi.spyOn(childProcess, 'execFileSync').mockImplementation(blocked),
        vi.spyOn(childProcess, 'spawnSync').mockImplementation(blocked),
        vi.spyOn(process, 'dlopen').mockImplementation(blocked),
    ];
    dispatcherApi = await import('../../src/v12/dispatcher');
});

afterEach(() => {
    const calls = guards.map((guard) => guard.mock.calls.length);
    const fetchCalls = fetchGuard.mock.calls.length;
    const webSocketCalls = webSocketGuard.mock.calls.length;
    const attempts = [...forbidden.attempts];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    expect(calls).toEqual(calls.map(() => 0));
    expect(fetchCalls).toBe(0);
    expect(webSocketCalls).toBe(0);
    expect(attempts).toEqual([]);
});

const SELF = { platform: 'qq', user_id: '10001' };
const ECHO = '回声🪶\\\n\t"';
const PRIVATE_URL = 'https://fixture.invalid/private?token=SYNTHETIC_PRIVATE_URL_X901';
const LEGACY_URL = 'https://fixture.invalid/legacy';
const ERROR_MARKER = 'SYNTHETIC_PRIVATE_EXCEPTION_X902';
const FAMILIES = [
    { label: 'image', prefix: 'jiyu-image:v1:', key: 'resolveImageFileUrl' },
    { label: 'voice', prefix: 'jiyu-voice:v1:', key: 'resolveVoiceFileUrl' },
    { label: 'video', prefix: 'jiyu-video:v1:', key: 'resolveVideoFileUrl' },
] as const;

function request(fileId: string, extra: object = {}) {
    return {
        action: 'get_file',
        params: { file_id: fileId, type: 'url' },
        self: SELF,
        echo: ECHO,
        ...extra,
    };
}

function fixture() {
    const state = { live: true, throws: false };
    const receivers: unknown[] = [];
    const lease: V12FileLease = vi.fn(() => {
        if (state.throws) {
            throw new Error(ERROR_MARKER);
        }

        return state.live;
    });
    const api = {
        handle: vi.fn(async () => ({
            status: 'ok' as const,
            retcode: 0,
            data: { file_name: 'legacy.bin', url: LEGACY_URL },
        })),
    };
    const resolver = () =>
        vi.fn(function (this: V12CoreOptions, _fileId: string): string | null {
            receivers.push(this);
            return PRIVATE_URL;
        });
    const resolvers = {
        resolveImageFileUrl: resolver(),
        resolveVoiceFileUrl: resolver(),
        resolveVideoFileUrl: resolver(),
    };
    const options: V12CoreOptions = {
        self: SELF,
        version: { impl: 'fixture', version: '1' },
        api,
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime: () => null,
        ...resolvers,
    };
    const dispatcher = new dispatcherApi.V12Dispatcher(options);
    return { state, lease, api, resolvers, options, dispatcher, receivers };
}

function unavailable(result: V12Response, echo = ECHO): void {
    expect(result).toEqual({
        status: 'failed',
        retcode: 20002,
        message: 'file unavailable',
        data: null,
        echo,
    });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_URL);
    expect(JSON.stringify(result)).not.toContain(ERROR_MARKER);
}

function invalid(result: V12Response, echo = ECHO): void {
    expect(result).toEqual({
        status: 'failed',
        retcode: 20001,
        message: 'invalid file result',
        data: null,
        echo,
    });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_URL);
}

function success(result: V12Response, echo = ECHO): void {
    expect(result).toEqual({
        status: 'ok',
        retcode: 0,
        message: '',
        data: { name: '', url: PRIVATE_URL },
        echo,
    });
}

describe.each(FAMILIES)('reserved $label get_file listener lease', ({ prefix, key }) => {
    const fileId = `${prefix}synthetic-token`;

    it('calls the selected resolver once with the original id and options receiver', async () => {
        const f = fixture();
        const result = await f.dispatcher.handle(request(fileId), f.lease);
        success(result);
        expect(f.resolvers[key]).toHaveBeenCalledExactlyOnceWith(fileId);
        expect(f.receivers).toEqual([f.options]);
        expect(f.lease).toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();

        for (const family of FAMILIES) {
            if (family.key !== key) {
                expect(f.resolvers[family.key]).not.toHaveBeenCalled();
            }
        }
    });

    // These are direct dispatcher boundaries, not claims about transport delivery.
    it('preserves an escape-expanded large echo on success and on a stale lease', async () => {
        const echo = ('"' + '\\' + '\n').repeat(200_000);
        expect(echo.length).toBe(600_000);
        expect(Buffer.byteLength(JSON.stringify(echo), 'utf8')).toBeGreaterThan(1024 * 1024);
        const f = fixture();
        success(await f.dispatcher.handle(request(fileId, { echo }), f.lease), echo);
        expect(f.resolvers[key]).toHaveBeenCalledExactlyOnceWith(fileId);
        expect(f.api.handle).not.toHaveBeenCalled();

        f.resolvers[key].mockClear();
        f.state.live = false;
        unavailable(await f.dispatcher.handle(request(fileId, { echo }), f.lease), echo);

        for (const family of FAMILIES) {
            expect(f.resolvers[family.key]).not.toHaveBeenCalled();
        }

        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('accepts the echo snapshot limit and applies fallbackEcho on invalid input', async () => {
        const echo = 'x'.repeat(1_048_576);
        const f = fixture();
        success(await f.dispatcher.handle(request(fileId, { echo }), f.lease), echo);
        expect(f.resolvers[key]).toHaveBeenCalledExactlyOnceWith(fileId);
        expect(f.api.handle).not.toHaveBeenCalled();

        // Even when snapshotting fails elsewhere, preflight already captured this
        // bounded own-data echo without invoking the hostile request getter.
        const invalidFixture = fixture();
        const getter = vi.fn(() => {
            throw new Error(ERROR_MARKER);
        });
        const params = { file_id: fileId, type: 'url' };
        Object.defineProperty(params, 'extra', { enumerable: true, get: getter });
        const invalidResult = await invalidFixture.dispatcher.handle(
            request(fileId, { params, echo }),
            invalidFixture.lease,
        );
        expect(invalidResult).toEqual({
            status: 'failed',
            retcode: 10001,
            data: null,
            message: 'invalid action request',
            echo,
        });
        expect(getter).not.toHaveBeenCalled();
        expect(invalidFixture.lease).not.toHaveBeenCalled();
        expect(invalidFixture.resolvers[key]).not.toHaveBeenCalled();
        expect(invalidFixture.api.handle).not.toHaveBeenCalled();

        // An over-limit echo is not captured as a fallback and must be omitted.
        const overLimit = echo + 'x';
        expect(overLimit.length).toBe(1_048_577);
        const overFixture = fixture();
        const overResult = await overFixture.dispatcher.handle(
            request(fileId, { echo: overLimit }),
            overFixture.lease,
        );
        expect(overResult).toEqual({
            status: 'failed',
            retcode: 10001,
            data: null,
            message: 'invalid action request',
        });
        expect(overResult).not.toHaveProperty('echo');
        expect(overFixture.lease).not.toHaveBeenCalled();
        expect(overFixture.resolvers[key]).not.toHaveBeenCalled();
        expect(overFixture.api.handle).not.toHaveBeenCalled();
    });

    it.each(['false', 'throw'] as const)(
        'checks an already %s listener before even reading the resolver',
        async (mode) => {
            const f = fixture();
            f.state.live = false;
            f.state.throws = mode === 'throw';
            const getter = vi.fn(() => f.resolvers[key]);
            Object.defineProperty(f.options, key, { configurable: true, get: getter });
            unavailable(await f.dispatcher.handle(request(fileId), f.lease));
            expect(getter).not.toHaveBeenCalled();
            expect(f.resolvers[key]).not.toHaveBeenCalled();
            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );

    it('requires the literal boolean true from a supplied lease', async () => {
        const f = fixture();

        for (const value of [1, 'true', {}, Promise.resolve(false)]) {
            const lease = vi.fn(() => value as unknown as boolean);
            unavailable(await f.dispatcher.handle(request(fileId), lease));
            expect(lease).toHaveBeenCalled();
            expect(f.resolvers[key]).not.toHaveBeenCalled();
        }

        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it.each(['false', 'throw'] as const)(
        'rechecks a lease made %s by the resolver getter before calling it',
        async (mode) => {
            const f = fixture();
            const getter = vi.fn(() => {
                f.state.live = false;
                f.state.throws = mode === 'throw';
                return f.resolvers[key];
            });
            Object.defineProperty(f.options, key, { configurable: true, get: getter });
            unavailable(await f.dispatcher.handle(request(fileId), f.lease));
            expect(getter).toHaveBeenCalledTimes(1);
            expect(f.resolvers[key]).not.toHaveBeenCalled();
            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );

    it('uses the single captured resolver if its getter replaces the property', async () => {
        const f = fixture();
        const replacement = vi.fn(() => 'https://fixture.invalid/replacement');
        const getter = vi.fn(() => {
            Object.defineProperty(f.options, key, { configurable: true, value: replacement });
            return f.resolvers[key];
        });
        Object.defineProperty(f.options, key, { configurable: true, get: getter });
        success(await f.dispatcher.handle(request(fileId), f.lease));
        expect(getter).toHaveBeenCalledTimes(1);
        expect(f.resolvers[key]).toHaveBeenCalledExactlyOnceWith(fileId);
        expect(f.receivers).toEqual([f.options]);
        expect(replacement).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it.each(['false', 'throw'] as const)(
        'discards the URL when the resolver makes its lease %s, and recovers on a later request',
        async (mode) => {
            const f = fixture();
            f.resolvers[key].mockImplementationOnce(function (this: V12CoreOptions, id: string) {
                expect(this).toBe(f.options);
                expect(id).toBe(fileId);
                f.state.live = false;
                f.state.throws = mode === 'throw';
                return PRIVATE_URL;
            });
            unavailable(await f.dispatcher.handle(request(fileId), f.lease));
            expect(f.resolvers[key]).toHaveBeenCalledTimes(1);
            f.state.live = true;
            f.state.throws = false;
            success(await f.dispatcher.handle(request(fileId), f.lease));
            expect(f.resolvers[key]).toHaveBeenCalledTimes(2);
            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );

    it.each([null, 'file:///synthetic-private-path'] as const)(
        'suppresses a stale missing or invalid resolver result',
        async (providerValue) => {
            const f = fixture();
            f.resolvers[key].mockImplementationOnce(() => {
                f.state.live = false;
                return providerValue;
            });
            unavailable(await f.dispatcher.handle(request(fileId), f.lease));
            expect(f.resolvers[key]).toHaveBeenCalledExactlyOnceWith(fileId);
            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );

    it.each(['return', 'throw'] as const)(
        'hides the URL when URL classification reenters and revokes the lease (%s)',
        async (mode) => {
            const f = fixture();
            const NativeURL = globalThis.URL;
            let parses = 0;
            class ReentrantURL extends NativeURL {
                constructor(input: string | URL, base?: string | URL) {
                    super(input, base);
                    parses++;
                    f.state.live = false;

                    if (mode === 'throw') {
                        throw new Error(ERROR_MARKER);
                    }
                }
            }

            vi.stubGlobal('URL', ReentrantURL);
            let result: V12Response;

            try {
                result = await f.dispatcher.handle(request(fileId), f.lease);
            } finally {
                vi.stubGlobal('URL', NativeURL);
            }

            unavailable(result);
            expect(parses).toBe(1);
            expect(f.resolvers[key]).toHaveBeenCalledExactlyOnceWith(fileId);
            f.state.live = true;
            success(await f.dispatcher.handle(request(fileId), f.lease));
            expect(f.api.handle).not.toHaveBeenCalled();
        },
    );

    it('preserves invalid, missing, non-string and throwing resolver outcomes without fallback', async () => {
        const f = fixture();
        f.resolvers[key].mockReturnValueOnce(null);
        invalid(await f.dispatcher.handle(request(`${prefix}damaged`), f.lease));
        f.resolvers[key].mockReturnValueOnce('file:///synthetic-private-path');
        invalid(await f.dispatcher.handle(request(fileId), f.lease));
        f.resolvers[key].mockReturnValueOnce(Promise.resolve(PRIVATE_URL) as unknown as string);
        invalid(await f.dispatcher.handle(request(fileId), f.lease));
        f.resolvers[key].mockImplementationOnce(() => {
            throw new Error(`${ERROR_MARKER} ${PRIVATE_URL}`);
        });
        unavailable(await f.dispatcher.handle(request(fileId), f.lease));
        expect(f.resolvers[key]).toHaveBeenCalledTimes(4);

        Object.defineProperty(f.options, key, { configurable: true, value: undefined });
        invalid(await f.dispatcher.handle(request(fileId), f.lease));
        f.state.live = false;
        unavailable(await f.dispatcher.handle(request(fileId), f.lease));
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('contains a throwing resolver getter without exposing the error or trying v11', async () => {
        const f = fixture();
        const getter = vi.fn(() => {
            throw new Error(`${ERROR_MARKER} ${PRIVATE_URL}`);
        });
        Object.defineProperty(f.options, key, { configurable: true, get: getter });
        unavailable(await f.dispatcher.handle(request(fileId), f.lease));
        expect(getter).toHaveBeenCalledTimes(1);
        expect(f.resolvers[key]).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('rechecks an old prepared token and keeps the preflight request snapshot', async () => {
        const f = fixture();
        const input = request(fileId);
        const classified = f.dispatcher.createInternalHttpPreflight(f.lease).classify(input);
        expect(classified.kind).toBe('ordinary');

        if (classified.kind !== 'ordinary') {
            throw new Error('expected a prepared ordinary token');
        }

        input.params.file_id = `${prefix}changed-after-snapshot`;
        input.echo = 'changed-after-snapshot';
        f.state.live = false;
        unavailable(await f.dispatcher.handlePreparedOrdinary(classified.token));
        expect(f.resolvers[key]).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('uses the original snapshot for a current prepared token and consumes it once', async () => {
        const f = fixture();
        const input = request(fileId);
        const classified = f.dispatcher.createInternalHttpPreflight(f.lease).classify(input);

        if (classified.kind !== 'ordinary') {
            throw new Error('expected a prepared ordinary token');
        }

        input.params.file_id = `${prefix}changed-after-snapshot`;
        input.echo = 'changed-after-snapshot';
        success(await f.dispatcher.handlePreparedOrdinary(classified.token));
        expect(f.resolvers[key]).toHaveBeenCalledExactlyOnceWith(fileId);
        expect(await f.dispatcher.handlePreparedOrdinary(classified.token)).toMatchObject({
            status: 'failed',
            retcode: 10001,
            data: null,
        });
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('distinguishes direct no-lease calls from a prepared token with no listener lease', async () => {
        const f = fixture();
        success(await f.dispatcher.handle(request(fileId)));
        expect(f.resolvers[key]).toHaveBeenCalledExactlyOnceWith(fileId);
        f.resolvers[key].mockClear();
        const classified = f.dispatcher.createInternalHttpPreflight().classify(request(fileId));

        if (classified.kind !== 'ordinary') {
            throw new Error('expected a prepared ordinary token');
        }

        unavailable(await f.dispatcher.handlePreparedOrdinary(classified.token));
        expect(f.resolvers[key]).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
    });

    it('keeps input and self validation ahead of listener checks', async () => {
        const f = fixture();
        f.state.live = false;
        const cases: Array<[unknown, number]> = [
            [request(fileId, { params: { file_id: fileId, type: 'data' } }), 10004],
            [request(fileId, { params: { file_id: fileId, type: 'url', extra: true } }), 10004],
            [request(fileId, { params: { file_id: '', type: 'url' } }), 10003],
            [request(fileId, { params: { file_id: 'x'.repeat(4097), type: 'url' } }), 10003],
            [request(fileId, { params: { file_id: fileId, type: null } }), 10003],
            [request(fileId, { self: { platform: 'qq', user_id: '10002' } }), 10102],
        ];

        for (const [input, retcode] of cases) {
            const result = await f.dispatcher.handle(input, f.lease);
            expect(result).toMatchObject({ status: 'failed', retcode, data: null, echo: ECHO });
            expect(JSON.stringify(result)).not.toContain(PRIVATE_URL);
        }

        expect(f.lease).not.toHaveBeenCalled();
        expect(f.resolvers[key]).not.toHaveBeenCalled();
        expect(f.api.handle).not.toHaveBeenCalled();
    });
});

describe('ordinary get_file compatibility', () => {
    it('continues the v11 fallback independently of a stale listener lease', async () => {
        const f = fixture();
        f.state.live = false;
        expect(await f.dispatcher.handle(request('legacy-id'), f.lease)).toEqual({
            status: 'ok',
            retcode: 0,
            message: '',
            data: { name: 'legacy.bin', url: LEGACY_URL },
            echo: ECHO,
        });
        expect(f.api.handle).toHaveBeenCalledExactlyOnceWith('get_file', { file_id: 'legacy-id' });
        expect(f.lease).not.toHaveBeenCalled();

        for (const family of FAMILIES) {
            expect(f.resolvers[family.key]).not.toHaveBeenCalled();
        }
    });
});
