import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OneBot12HttpRequestOptions } from '../../src/v12/index.js';

// Real HTTP client and helpers, with an injected deferred in-memory fetch only.
const forbiddenAttempts = vi.hoisted(() => [] as string[]);
vi.mock('ws', () => {
    class ForbiddenWebSocket {
        constructor() {
            forbiddenAttempts.push('ws');
            throw new Error('unexpected WebSocket in deadline fixture');
        }
    }
    class ForbiddenWebSocketServer {
        constructor() {
            forbiddenAttempts.push('ws-server');
            throw new Error('unexpected WebSocket server in deadline fixture');
        }
    }
    return {
        default: ForbiddenWebSocket,
        WebSocket: ForbiddenWebSocket,
        WebSocketServer: ForbiddenWebSocketServer,
    };
});

let sdk: typeof import('../../src/v12/index.js');
let guards: Array<{ mock: { calls: unknown[] } }>;
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let unhandled: unknown[];
let onUnhandled: (reason: unknown) => void;

function forbidden(): never {
    throw new Error('unexpected network, native or process operation in deadline fixture');
}

beforeEach(async () => {
    forbiddenAttempts.length = 0;
    unhandled = [];
    onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    fetchGuard = vi.fn(forbidden);
    webSocketGuard = vi.fn(function ForbiddenGlobalWebSocket() {
        return forbidden();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    guards = [
        vi.spyOn(net, 'createServer').mockImplementation(forbidden),
        vi.spyOn(net, 'createConnection').mockImplementation(forbidden),
        vi.spyOn(net, 'connect').mockImplementation(forbidden),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(forbidden),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(forbidden),
        vi.spyOn(http, 'createServer').mockImplementation(forbidden),
        vi.spyOn(http, 'request').mockImplementation(forbidden),
        vi.spyOn(http, 'get').mockImplementation(forbidden),
        vi.spyOn(https, 'createServer').mockImplementation(forbidden),
        vi.spyOn(https, 'request').mockImplementation(forbidden),
        vi.spyOn(https, 'get').mockImplementation(forbidden),
        vi.spyOn(http2, 'createServer').mockImplementation(forbidden),
        vi.spyOn(http2, 'createSecureServer').mockImplementation(forbidden),
        vi.spyOn(http2, 'connect').mockImplementation(forbidden),
        vi.spyOn(tls, 'createServer').mockImplementation(forbidden),
        vi.spyOn(tls, 'connect').mockImplementation(forbidden),
        vi.spyOn(dgram, 'createSocket').mockImplementation(forbidden),
        vi.spyOn(dgram.Socket.prototype, 'bind').mockImplementation(forbidden),
        vi.spyOn(dgram.Socket.prototype, 'connect').mockImplementation(forbidden),
        vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawn').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'spawnSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'exec').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFile').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'execFileSync').mockImplementation(forbidden),
        vi.spyOn(childProcess, 'fork').mockImplementation(forbidden),
        vi.spyOn(process, 'dlopen').mockImplementation(forbidden),
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
                guards.push(vi.spyOn(methods, method).mockImplementation(forbidden));
            }
        }
    }

    sdk = await import('../../src/v12/index.js');
});

afterEach(() => {
    const calls = guards.map((guard) => guard.mock.calls.length);
    const globalFetchCalls = fetchGuard.mock.calls.length;
    const globalWebSocketCalls = webSocketGuard.mock.calls.length;
    const attempts = [...forbiddenAttempts];
    const unhandledReasons = [...unhandled];
    process.removeListener('unhandledRejection', onUnhandled);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    expect(calls).toEqual(calls.map(() => 0));
    expect(globalFetchCalls).toBe(0);
    expect(globalWebSocketCalls).toBe(0);
    expect(attempts).toEqual([]);
    expect(unhandledReasons).toEqual([]);
});

type Stage = 'prepare' | 'transfer';
type LateSettlement = 'response' | 'rejection';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

async function settleMicrotasks() {
    for (let i = 0; i < 16; i++) {
        await Promise.resolve();
    }
}

function invoke(
    stage: Stage,
    client: InstanceType<typeof sdk.OneBot12HttpClient>,
    options: OneBot12HttpRequestOptions,
) {
    return stage === 'prepare'
        ? sdk.prepareOneBot12FileFragment(
              client,
              { stage: 'prepare', file_id: 'synthetic-file' },
              options,
          )
        : sdk.transferOneBot12FileFragment(
              client,
              { stage: 'transfer', file_id: 'synthetic-file', offset: 0, size: 1 },
              options,
          );
}

function fixture(stage: Stage, options: OneBot12HttpRequestOptions) {
    const lateFetch = deferred<Response>();
    let capturedSignal: AbortSignal | null | undefined;
    const fakeFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        capturedSignal = init?.signal;
        return lateFetch.promise;
    });
    const client = new sdk.OneBot12HttpClient({
        baseUrl: 'http://fixture.invalid/',
        fetch: fakeFetch,
        requestTimeoutMs: 5000,
    });
    const request = vi.spyOn(client, 'request');
    const result = invoke(stage, client, options);
    const requestResult = request.mock.results[0];

    if (!requestResult || requestResult.type !== 'return') {
        throw new Error('expected one underlying HTTP request promise');
    }

    // Observe both promises before any timeout or abort to avoid creating an
    // unhandled rejection in the fixture itself.
    const helperError = result.then(
        () => {
            throw new Error('expected helper rejection');
        },
        (error: unknown) => error,
    );
    const transportError = requestResult.value.then(
        () => {
            throw new Error('expected transport rejection');
        },
        (error: unknown) => error,
    );
    const cancel = vi.fn(() => Promise.reject(new Error('synthetic late cancel rejection')));
    const lateResponse = {
        status: 200,
        headers: new Headers(),
        body: { cancel },
    } as unknown as Response;
    return {
        fakeFetch,
        request,
        helperError,
        transportError,
        lateFetch,
        lateResponse,
        cancel,
        signal: () => capturedSignal,
    };
}

async function finishLate(f: ReturnType<typeof fixture>, mode: LateSettlement): Promise<void> {
    if (mode === 'response') {
        f.lateFetch.resolve(f.lateResponse);
    } else {
        f.lateFetch.reject(new Error('synthetic late fetch rejection'));
    }

    await settleMicrotasks();
    // Yield a task turn as well as promise turns so a late unhandled rejection
    // cannot be hidden by checking immediately after settling the deferred fetch.
    await vi.advanceTimersByTimeAsync(0);
    await settleMicrotasks();
    expect(f.cancel).toHaveBeenCalledTimes(mode === 'response' ? 1 : 0);
    expect(f.fakeFetch).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
}

const cases: Array<[Stage, LateSettlement]> = [
    ['prepare', 'response'],
    ['prepare', 'rejection'],
    ['transfer', 'response'],
    ['transfer', 'rejection'],
];

describe('fragmented file helper HTTP deadline propagation (in-memory fetch)', () => {
    it.each(cases)(
        '%s propagates timeout and observes late fetch %s without retry',
        async (stage, late) => {
            vi.useFakeTimers();
            const f = fixture(stage, { timeoutMs: 25 });
            await settleMicrotasks();
            expect(f.request).toHaveBeenCalledTimes(1);
            expect(f.fakeFetch).toHaveBeenCalledTimes(1);
            expect(f.signal()).toBeInstanceOf(AbortSignal);
            expect(f.signal()?.aborted).toBe(false);

            await vi.advanceTimersByTimeAsync(25);
            const error = await f.helperError;
            expect(error).toBeInstanceOf(sdk.OneBot12ClientError);
            expect(error).toMatchObject({ code: 'timeout' });
            expect(error).toBe(await f.transportError);
            expect(f.signal()?.aborted).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
            // Started work may still have had an effect; a timeout is not rollback.
            await finishLate(f, late);
        },
    );

    it.each(cases)(
        '%s propagates manual abort and observes late fetch %s without retry',
        async (stage, late) => {
            vi.useFakeTimers();
            const controller = new AbortController();
            const reason = { marker: 'synthetic abort reason' };
            const f = fixture(stage, { timeoutMs: 100, signal: controller.signal });
            await settleMicrotasks();
            expect(f.request).toHaveBeenCalledTimes(1);
            expect(f.fakeFetch).toHaveBeenCalledTimes(1);
            expect(f.signal()).toBeInstanceOf(AbortSignal);
            expect(f.signal()?.aborted).toBe(false);

            controller.abort(reason);
            const error = await f.helperError;
            expect(error).toBeInstanceOf(sdk.OneBot12ClientError);
            expect(error).toMatchObject({ code: 'aborted' });
            expect(error).toBe(await f.transportError);
            expect(String(error)).not.toContain(reason.marker);
            expect(controller.signal.reason).toBe(reason);
            expect(f.signal()?.aborted).toBe(true);

            // Native AbortSignal.any preserves the source reason; the SDK's
            // documented fallback only guarantees abort classification.
            if (typeof AbortSignal.any === 'function') {
                expect(f.signal()?.reason).toBe(reason);
            }

            expect(vi.getTimerCount()).toBe(0);
            await finishLate(f, late);
        },
    );
});
