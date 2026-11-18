import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    OneBot12ActionResponse,
    OneBot12GetFileFragmentedPrepareParams,
    OneBot12GetFileFragmentedTransferParams,
    OneBot12HttpRequestOptions,
    OneBot12JsonObject,
} from '../../src/v12/index.js';

// Only the SDK's real shared helpers and an in-memory request method are used.
const forbiddenAttempts = vi.hoisted(() => [] as string[]);
vi.mock('ws', () => {
    class ForbiddenWebSocket {
        constructor() {
            forbiddenAttempts.push('ws');
            throw new Error('unexpected WebSocket in fragmented helper fixture');
        }
    }
    class ForbiddenWebSocketServer {
        constructor() {
            forbiddenAttempts.push('ws-server');
            throw new Error('unexpected WebSocket server in fragmented helper fixture');
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

function forbidden(): never {
    throw new Error('unexpected network, native or process operation in fragmented helper fixture');
}

beforeEach(async () => {
    forbiddenAttempts.length = 0;
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

    // Load the public entry only after all effect guards are installed.
    sdk = await import('../../src/v12/index.js');
});

afterEach(() => {
    const calls = guards.map((guard) => guard.mock.calls.length);
    const fetchCalls = fetchGuard.mock.calls.length;
    const webSocketCalls = webSocketGuard.mock.calls.length;
    const attempts = [...forbiddenAttempts];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    expect(calls).toEqual(calls.map(() => 0));
    expect(fetchCalls).toBe(0);
    expect(webSocketCalls).toBe(0);
    expect(attempts).toEqual([]);
});

type Stage = 'prepare' | 'transfer';
type RequestCall = {
    receiver: unknown;
    action: string;
    params: OneBot12JsonObject;
    options: OneBot12HttpRequestOptions | undefined;
};
type Handler = (
    action: string,
    params: OneBot12JsonObject,
    options: OneBot12HttpRequestOptions | undefined,
) => unknown;

function fakeTransport(handler: Handler) {
    const calls: RequestCall[] = [];
    const transport = {
        request(
            this: unknown,
            action: string,
            params: OneBot12JsonObject = {},
            options?: OneBot12HttpRequestOptions,
        ): Promise<OneBot12ActionResponse> {
            calls.push({ receiver: this, action, params, options });
            // Deliberately permit raw values, thenables and synchronous throws in the fake.
            return handler(action, params, options) as Promise<OneBot12ActionResponse>;
        },
    };
    return { transport, calls };
}

type FakeTransport = ReturnType<typeof fakeTransport>['transport'];

function invoke(
    stage: Stage,
    transport: FakeTransport,
    params: unknown,
    options?: OneBot12HttpRequestOptions,
) {
    return stage === 'prepare'
        ? sdk.prepareOneBot12FileFragment(
              transport,
              params as OneBot12GetFileFragmentedPrepareParams,
              options,
          )
        : sdk.transferOneBot12FileFragment(
              transport,
              params as OneBot12GetFileFragmentedTransferParams,
              options,
          );
}

function paramsFor(stage: Stage) {
    const extension = { inner: { label: 'original' }, values: ['first', 'second'] };
    return stage === 'prepare'
        ? { stage: 'prepare' as const, file_id: 'file-original', 'x.params': extension }
        : {
              stage: 'transfer' as const,
              file_id: 'file-original',
              offset: 2,
              size: 3,
              'x.params': extension,
          };
}

function responseFor(stage: Stage) {
    const extension = { values: ['original', 'kept'] };
    const data =
        stage === 'prepare'
            ? { name: 'fixture.bin', total_size: 3, sha256: 'short', 'x.data': extension }
            : { data: 'not base64!', 'x.data': extension };
    return {
        status: 'ok' as const,
        retcode: 0,
        data,
        message: '',
        echo: 'response-echo',
        'x.envelope': { source: ['fixture'] },
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function rejection(run: () => unknown): Promise<unknown> {
    try {
        await run();
    } catch (error) {
        return error;
    }

    throw new Error('expected the fixture operation to reject');
}

function expectClientError(
    error: unknown,
    code: 'invalid_options' | 'invalid_response',
    marker?: string,
) {
    expect(error).toBeInstanceOf(sdk.OneBot12ClientError);
    expect(error).toMatchObject({ code });

    if (marker !== undefined) {
        expect(String(error)).not.toContain(marker);
        expect(JSON.stringify(error)).not.toContain(marker);
    }
}

describe('OneBot 12 fragmented file shared helpers with an in-memory request', () => {
    for (const stage of ['prepare', 'transfer'] as const) {
        it(`${stage}: snapshots request and response while passing options and receiver through`, async () => {
            const entered = deferred<void>();
            const reply = deferred<OneBot12ActionResponse>();
            const { transport, calls } = fakeTransport(() => {
                entered.resolve(undefined);
                return reply.promise;
            });
            const controller = new AbortController();
            const options: OneBot12HttpRequestOptions = {
                echo: 'request-echo',
                self: { platform: 'qq', user_id: 'fixture-account' },
                signal: controller.signal,
                timeoutMs: 42,
            };
            const params = paramsFor(stage);
            const response = responseFor(stage);
            const pending = invoke(stage, transport, params, options);
            await Promise.race([entered.promise, pending]);

            expect(calls).toHaveLength(1);
            const call = calls[0]!;
            expect(call.receiver).toBe(transport);
            expect(call.action).toBe('get_file_fragmented');
            expect(call.params).toEqual(params);
            expect(call.params).not.toBe(params);
            expect(call.params['x.params']).not.toBe(params['x.params']);
            expect(call.options).toBe(options);
            expect(call.options?.echo).toBe('request-echo');
            expect(call.options?.self).toBe(options.self);
            expect(call.options?.signal).toBe(controller.signal);
            expect(call.options?.timeoutMs).toBe(42);

            params.file_id = 'changed-while-awaiting';
            params['x.params'].inner.label = 'changed-while-awaiting';
            params['x.params'].values[0] = 'changed-while-awaiting';
            expect(call.params.file_id).toBe('file-original');
            expect(call.params['x.params']).toEqual({
                inner: { label: 'original' },
                values: ['first', 'second'],
            });

            reply.resolve(response);
            const result = await pending;
            expect(calls).toHaveLength(1);
            expect(result).toEqual(response);
            expect(result).not.toBe(response);
            expect(result.data).not.toBe(response.data);
            expect(result['x.envelope']).not.toBe(response['x.envelope']);
            const resultData = result.data as OneBot12JsonObject;
            expect(resultData['x.data']).not.toBe(response.data['x.data']);
            expect(Object.getOwnPropertyDescriptor(result, 'data')).toMatchObject({
                value: result.data,
                enumerable: true,
            });
            expect(Object.getOwnPropertyDescriptor(resultData, 'x.data')).toHaveProperty('value');
            response.data['x.data'].values[0] = 'changed-after-response';
            response['x.envelope'].source[0] = 'changed-after-response';
            expect(resultData['x.data']).toEqual({ values: ['original', 'kept'] });
            expect(result['x.envelope']).toEqual({ source: ['fixture'] });
        });

        it(`${stage}: rejects malformed parameters before request, even with an aborted signal`, async () => {
            const controller = new AbortController();
            controller.abort();
            const options = { signal: controller.signal, echo: 'already-aborted' };
            const invalid: unknown[] =
                stage === 'prepare'
                    ? [
                          null,
                          [],
                          {},
                          { stage: 'prepare' },
                          { file_id: 'file' },
                          { stage: 'transfer', file_id: 'file' },
                          { stage: 'prepare', file_id: 123 },
                          { stage: 'prepare', file_id: null },
                          { stage: 'prepare', file_id: 'file', 'x.invalid': () => 1 },
                      ]
                    : [
                          null,
                          [],
                          {},
                          { stage: 'transfer', file_id: 'file', offset: 0 },
                          { stage: 'transfer', file_id: 'file', size: 0 },
                          { file_id: 'file', offset: 0, size: 0 },
                          { stage: 'prepare', file_id: 'file', offset: 0, size: 0 },
                          { stage: 'transfer', file_id: 123, offset: 0, size: 0 },
                          { stage: 'transfer', file_id: 'file', offset: '0', size: 0 },
                          { stage: 'transfer', file_id: 'file', offset: 0, size: null },
                      ];

            for (const params of invalid) {
                const { transport, calls } = fakeTransport(() => responseFor(stage));
                const error = await rejection(() => invoke(stage, transport, params, options));
                expectClientError(error, 'invalid_options');
                expect(calls).toHaveLength(0);
            }
        });

        it(`${stage}: preserves failed envelopes and arbitrary JSON data as new snapshots`, async () => {
            const payloads = [
                null,
                false,
                1.5,
                'failure',
                [1, null, { nested: true }],
                {
                    reason: 'fixture',
                    details: ['one', null],
                },
            ];

            for (const retcode of [0, -17, 10004]) {
                for (const data of payloads) {
                    const response = {
                        status: 'failed' as const,
                        retcode,
                        data,
                        message: 'fixture failure',
                        echo: 'failure-echo',
                        'x.failure': { nested: ['kept'] },
                    };
                    const { transport, calls } = fakeTransport(() => Promise.resolve(response));
                    const result = await invoke(stage, transport, paramsFor(stage));
                    expect(calls).toHaveLength(1);
                    expect(calls[0]!.receiver).toBe(transport);
                    expect(result).toEqual(response);
                    expect(result).not.toBe(response);
                    expect(result['x.failure']).not.toBe(response['x.failure']);
                    expect(Object.getOwnPropertyDescriptor(result, 'data')).toHaveProperty('value');

                    if (data !== null && typeof data === 'object') {
                        expect(result.data).not.toBe(data);
                    }
                }
            }
        });

        it(`${stage}: maps malformed response envelopes and data to invalid_response`, async () => {
            const goodData = responseFor(stage).data;
            const envelope = { status: 'ok', retcode: 0, data: goodData, message: '' };
            const common: unknown[] = [
                null,
                [],
                {},
                { ...envelope, status: 'other' },
                { ...envelope, retcode: 1 },
                { ...envelope, retcode: 0.5 },
                { ...envelope, retcode: Number.MAX_SAFE_INTEGER + 1 },
                { ...envelope, message: null },
                { ...envelope, echo: 12 },
                { status: 'ok', retcode: 0, message: '' },
                { status: 'failed', retcode: 1, message: '' },
            ];
            const invalidData: unknown[] =
                stage === 'prepare'
                    ? [
                          null,
                          [],
                          {},
                          { total_size: 1, sha256: 'hash' },
                          { name: 'file', sha256: 'hash' },
                          { name: 'file', total_size: 1 },
                          { name: 42, total_size: 1, sha256: 'hash' },
                          { name: 'file', total_size: '1', sha256: 'hash' },
                          { name: 'file', total_size: 1, sha256: 42 },
                          { name: 'file', total_size: 0.5, sha256: 'hash' },
                          { name: 'file', total_size: Number.MAX_SAFE_INTEGER + 1, sha256: 'hash' },
                          { name: 'file', total_size: Number.MIN_SAFE_INTEGER - 1, sha256: 'hash' },
                      ]
                    : [null, [], {}, { data: 42 }, { data: null }, { data: [1, 2] }];

            for (const response of [
                ...common,
                ...invalidData.map((data) => ({ ...envelope, data })),
            ]) {
                const { transport, calls } = fakeTransport(() => Promise.resolve(response));
                const error = await rejection(() => invoke(stage, transport, paramsFor(stage)));
                expectClientError(error, 'invalid_response');
                expect(calls).toHaveLength(1);
                expect(calls[0]!.receiver).toBe(transport);
            }
        });

        it(`${stage}: sanitizes invalid response accessor and proxy errors without invoking getters`, async () => {
            const marker = 'FRAGMENTED_RESPONSE_PRIVATE_MARKER';
            let getterCalls = 0;
            const accessorResponse = responseFor(stage);
            Object.defineProperty(accessorResponse.data, 'x.accessor', {
                enumerable: true,
                get() {
                    getterCalls++;
                    throw new Error(marker);
                },
            });
            const accessorFake = fakeTransport(() => Promise.resolve(accessorResponse));
            const accessorError = await rejection(() =>
                invoke(stage, accessorFake.transport, paramsFor(stage)),
            );
            expectClientError(accessorError, 'invalid_response', marker);
            expect(getterCalls).toBe(0);
            expect(accessorFake.calls).toHaveLength(1);

            let trapCalls = 0;
            const response = responseFor(stage);
            const proxiedData = new Proxy(response.data, {
                getPrototypeOf() {
                    trapCalls++;
                    throw new Error(marker);
                },
            });
            const proxyFake = fakeTransport(() =>
                Promise.resolve({ ...response, data: proxiedData }),
            );
            const proxyError = await rejection(() =>
                invoke(stage, proxyFake.transport, paramsFor(stage)),
            );
            expectClientError(proxyError, 'invalid_response', marker);
            expect(trapCalls).toBeGreaterThan(0);
            expect(proxyFake.calls).toHaveLength(1);

            let failedGetterCalls = 0;
            const failureData = Object.defineProperty({}, 'x.accessor', {
                enumerable: true,
                get() {
                    failedGetterCalls++;
                    throw new Error(marker);
                },
            });
            const failedFake = fakeTransport(() =>
                Promise.resolve({
                    status: 'failed',
                    retcode: 0,
                    data: failureData,
                    message: '',
                }),
            );
            const failedError = await rejection(() =>
                invoke(stage, failedFake.transport, paramsFor(stage)),
            );
            expectClientError(failedError, 'invalid_response', marker);
            expect(failedGetterCalls).toBe(0);
            expect(failedFake.calls).toHaveLength(1);
        });

        it(`${stage}: passes request rejections and synchronous throws through by identity`, async () => {
            const errors = [
                new sdk.OneBot12ClientError('timeout', 'fixture timeout'),
                new sdk.OneBot12ClientError('aborted', 'fixture abort'),
                new sdk.OneBot12ClientError('network', 'fixture network error'),
                new Error('fixture custom error'),
            ];

            for (const original of errors) {
                for (const synchronously of [false, true]) {
                    const { transport, calls } = fakeTransport(() => {
                        if (synchronously) {
                            throw original;
                        }

                        return Promise.reject(original);
                    });
                    const error = await rejection(() => invoke(stage, transport, paramsFor(stage)));
                    expect(error).toBe(original);
                    expect(calls).toHaveLength(1);
                    expect(calls[0]!.receiver).toBe(transport);
                }
            }
        });

        it(`${stage}: forwards an already-aborted signal to the request without replacing its error`, async () => {
            const controller = new AbortController();
            controller.abort();
            const options = { signal: controller.signal, echo: 'aborted-echo' };
            const original = new sdk.OneBot12ClientError('aborted', 'fixture abort');
            const { transport, calls } = fakeTransport(() => Promise.reject(original));
            const error = await rejection(() =>
                invoke(stage, transport, paramsFor(stage), options),
            );
            expect(error).toBe(original);
            expect(calls).toHaveLength(1);
            expect(calls[0]!.options).toBe(options);
            expect(calls[0]!.options?.signal).toBe(controller.signal);
        });

        it(`${stage}: follows JavaScript thenable assimilation before parsing`, async () => {
            let thenReads = 0;
            const response = responseFor(stage);
            const thenable = {
                get then() {
                    thenReads++;
                    return (resolve: (value: typeof response) => void) => resolve(response);
                },
            };
            const fake = fakeTransport(() => thenable);
            const result = await invoke(stage, fake.transport, paramsFor(stage));
            expect(result).toEqual(response);
            expect(result).not.toBe(response);
            expect(thenReads).toBe(1);
            expect(fake.calls).toHaveLength(1);

            // Await reads a top-level then getter before a response parser can run.
            const original = new Error('thenable request rejection');
            let rejectedThenReads = 0;
            const rejectedThenable = {
                get then(): never {
                    rejectedThenReads++;
                    throw original;
                },
            };
            const rejectedFake = fakeTransport(() => rejectedThenable);
            const error = await rejection(() =>
                invoke(stage, rejectedFake.transport, paramsFor(stage)),
            );
            expect(error).toBe(original);
            expect(rejectedThenReads).toBe(1);
            expect(rejectedFake.calls).toHaveLength(1);
        });
    }

    it('accepts safe integer offset and size, including negative values and negative zero', async () => {
        for (const value of [-1, -0, 0, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
            const { transport, calls } = fakeTransport(() =>
                Promise.resolve(responseFor('transfer')),
            );
            const params = { stage: 'transfer' as const, file_id: '', offset: value, size: value };
            const result = await invoke('transfer', transport, params);
            expect(result.status).toBe('ok');
            expect(calls).toHaveLength(1);
            expect(Object.is(calls[0]!.params.offset, value)).toBe(true);
            expect(Object.is(calls[0]!.params.size, value)).toBe(true);
            expect(calls[0]!.params.file_id).toBe('');
        }
    });

    it('rejects fractional, unsafe or non-finite offset and size without requesting', async () => {
        const values = [
            0.5,
            -1.5,
            Number.MAX_SAFE_INTEGER + 1,
            Number.MIN_SAFE_INTEGER - 1,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
        ];

        for (const key of ['offset', 'size'] as const) {
            for (const value of values) {
                const params = {
                    stage: 'transfer',
                    file_id: 'file',
                    offset: 0,
                    size: 0,
                    [key]: value,
                };
                const { transport, calls } = fakeTransport(() => responseFor('transfer'));
                const error = await rejection(() => invoke('transfer', transport, params));
                expectClientError(error, 'invalid_options');
                expect(calls).toHaveLength(0);
            }
        }
    });

    it('accepts prepare total_size safe integers and short hash strings without extra limits', async () => {
        for (const totalSize of [-1, -0, 0, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
            const response = {
                status: 'ok',
                retcode: 0,
                data: { name: '', total_size: totalSize, sha256: 'x' },
                message: '',
            };
            const { transport, calls } = fakeTransport(() => Promise.resolve(response));
            const result = await invoke('prepare', transport, { stage: 'prepare', file_id: '' });
            expect(result.status).toBe('ok');
            expect(Object.is((result.data as OneBot12JsonObject).total_size, totalSize)).toBe(true);
            expect(calls).toHaveLength(1);
        }
    });

    it('accepts transfer data strings without decoding or canonical Base64 validation', async () => {
        for (const data of ['', 'not base64!', 'Zg', 'AB==', 'fixture 🪶']) {
            const response = { status: 'ok', retcode: 0, data: { data }, message: '' };
            const { transport, calls } = fakeTransport(() => Promise.resolve(response));
            const result = await invoke('transfer', transport, paramsFor('transfer'));
            expect(result.status).toBe('ok');
            expect((result.data as OneBot12JsonObject).data).toBe(data);
            expect(calls).toHaveLength(1);
        }
    });

    it('sanitizes parameter accessors and proxies before dispatch', async () => {
        const marker = 'FRAGMENTED_PARAMETER_PRIVATE_MARKER';
        let getterCalls = 0;
        const params = { stage: 'prepare', file_id: 'file' };
        Object.defineProperty(params, 'file_id', {
            enumerable: true,
            get() {
                getterCalls++;
                throw new Error(marker);
            },
        });
        const accessorFake = fakeTransport(() => responseFor('prepare'));
        const accessorError = await rejection(() =>
            invoke('prepare', accessorFake.transport, params),
        );
        expectClientError(accessorError, 'invalid_options', marker);
        expect(getterCalls).toBe(0);
        expect(accessorFake.calls).toHaveLength(0);

        let trapCalls = 0;
        const proxy = new Proxy(
            { stage: 'transfer', file_id: 'file', offset: 0, size: 0 },
            {
                getPrototypeOf() {
                    trapCalls++;
                    throw new Error(marker);
                },
            },
        );
        const proxyFake = fakeTransport(() => responseFor('transfer'));
        const proxyError = await rejection(() => invoke('transfer', proxyFake.transport, proxy));
        expectClientError(proxyError, 'invalid_options', marker);
        expect(trapCalls).toBeGreaterThan(0);
        expect(proxyFake.calls).toHaveLength(0);
    });

    it('preserves method receiver and per-call state through reentrant helper use', async () => {
        let inner: Promise<unknown> | undefined;
        let transport: FakeTransport;
        const options = { echo: 'reentrant', self: { platform: 'qq', user_id: 'fixture' } };
        const fake = fakeTransport((_action, params, forwardedOptions) => {
            if (params.stage === 'prepare') {
                inner = sdk.transferOneBot12FileFragment(
                    transport,
                    { stage: 'transfer', file_id: 'inner', offset: 1, size: 2 },
                    forwardedOptions,
                );
                return Promise.resolve(responseFor('prepare'));
            }

            return Promise.resolve(responseFor('transfer'));
        });
        transport = fake.transport;
        const outer = await sdk.prepareOneBot12FileFragment(
            fake.transport,
            { stage: 'prepare', file_id: 'outer' },
            options,
        );
        expect(inner).toBeDefined();
        const innerResult = await inner;
        expect(outer).toEqual(responseFor('prepare'));
        expect(innerResult).toEqual(responseFor('transfer'));
        expect(fake.calls).toHaveLength(2);
        expect(fake.calls.map((call) => call.params.stage)).toEqual(['prepare', 'transfer']);
        expect(fake.calls.map((call) => call.params.file_id)).toEqual(['outer', 'inner']);

        for (const call of fake.calls) {
            expect(call.receiver).toBe(fake.transport);
            expect(call.action).toBe('get_file_fragmented');
            expect(call.options).toBe(options);
        }
    });

    it('rejects own enumerable undefined extension values before either stage requests', async () => {
        for (const stage of ['prepare', 'transfer'] as const) {
            // The JSON object index type admits undefined, but the existing runtime parser rejects it.
            const params:
                OneBot12GetFileFragmentedPrepareParams | OneBot12GetFileFragmentedTransferParams =
                stage === 'prepare'
                    ? { stage: 'prepare', file_id: 'file', 'x.undefined': undefined }
                    : {
                          stage: 'transfer',
                          file_id: 'file',
                          offset: 0,
                          size: 0,
                          'x.undefined': undefined,
                      };
            expect(Object.getOwnPropertyDescriptor(params, 'x.undefined')).toMatchObject({
                value: undefined,
                enumerable: true,
            });
            const fake = fakeTransport(() => responseFor(stage));
            const error = await rejection(() => invoke(stage, fake.transport, params));
            expectClientError(error, 'invalid_options');
            expect(fake.calls).toHaveLength(0);
        }
    });

    it('preserves own __proto__ JSON data in prepare and success or failure snapshots', async () => {
        const pollutionKey = '__fragment_fixture_pollution__';
        const originalPrototypeDescriptor = Object.getOwnPropertyDescriptor(
            Object.prototype,
            pollutionKey,
        );

        const addOwnProto = (target: object, label: string) => {
            const value = { __fragment_fixture_pollution__: label, nested: { label } };
            Object.defineProperty(target, '__proto__', {
                value,
                enumerable: true,
                writable: true,
                configurable: true,
            });
            return value;
        };

        const checkCopiedProto = (snapshot: object, source: ReturnType<typeof addOwnProto>) => {
            expect(Object.hasOwn(snapshot, '__proto__')).toBe(true);
            const descriptor = Object.getOwnPropertyDescriptor(snapshot, '__proto__');
            expect(descriptor?.enumerable).toBe(true);
            expect(descriptor && 'value' in descriptor).toBe(true);
            const copied = descriptor?.value as typeof source;
            expect(copied).toEqual(source);
            expect(copied).not.toBe(source);
            expect(copied.nested).not.toBe(source.nested);
            expect((snapshot as Record<string, unknown>)['__proto__']).toBe(copied);
            const prototype = Object.getPrototypeOf(snapshot);
            expect(prototype === null || prototype === Object.prototype).toBe(true);
            expect(Object.hasOwn(snapshot, pollutionKey)).toBe(false);
            return copied;
        };

        for (const status of ['ok', 'failed'] as const) {
            const params: OneBot12GetFileFragmentedPrepareParams = {
                stage: 'prepare',
                file_id: 'file',
            };
            const data: OneBot12JsonObject =
                status === 'ok'
                    ? { name: 'file', total_size: 1, sha256: 'short' }
                    : { reason: 'fixture' };
            const response = { status, retcode: 0, data, message: '', echo: 'fixture-echo' };
            const paramProto = addOwnProto(params, 'params');
            const dataProto = addOwnProto(data, 'data');
            const envelopeProto = addOwnProto(response, 'envelope');

            for (const source of [params, data, response]) {
                expect(Object.getPrototypeOf(source)).toBe(Object.prototype);
                expect(Object.getOwnPropertyDescriptor(source, '__proto__')).toMatchObject({
                    enumerable: true,
                    configurable: true,
                    writable: true,
                });
            }

            const fake = fakeTransport(() => Promise.resolve(response));
            const result = await sdk.prepareOneBot12FileFragment(fake.transport, params);
            expect(fake.calls).toHaveLength(1);
            expect(result.status).toBe(status);
            const copiedParams = checkCopiedProto(fake.calls[0]!.params, paramProto);
            const copiedData = checkCopiedProto(result.data as OneBot12JsonObject, dataProto);
            const copiedEnvelope = checkCopiedProto(result, envelopeProto);
            paramProto.nested.label = 'changed';
            dataProto.nested.label = 'changed';
            envelopeProto.nested.label = 'changed';
            expect(copiedParams.nested.label).toBe('params');
            expect(copiedData.nested.label).toBe('data');
            expect(copiedEnvelope.nested.label).toBe('envelope');
            expect(Object.getOwnPropertyDescriptor(Object.prototype, pollutionKey)).toEqual(
                originalPrototypeDescriptor,
            );
        }
    });

    for (const stage of ['prepare', 'transfer'] as const) {
        it(`${stage}: forwards an opaque options Proxy without reading or cloning it`, async () => {
            const traps = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 };
            const options = new Proxy<OneBot12HttpRequestOptions>(
                { echo: 'fixture' },
                {
                    get() {
                        traps.get++;
                        throw new Error('options get must not run');
                    },
                    ownKeys() {
                        traps.ownKeys++;
                        throw new Error('options ownKeys must not run');
                    },
                    getOwnPropertyDescriptor() {
                        traps.getOwnPropertyDescriptor++;
                        throw new Error('options descriptor trap must not run');
                    },
                },
            );
            // The fake records the reference and never inspects the options object.
            const fake = fakeTransport(() => Promise.resolve(responseFor(stage)));
            const result = await invoke(stage, fake.transport, paramsFor(stage), options);
            expect(result.status).toBe('ok');
            expect(fake.calls).toHaveLength(1);
            expect(fake.calls[0]!.options).toBe(options);
            expect(traps).toEqual({ get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });
        });

        it(`${stage}: snapshots params before retrieving the request method`, async () => {
            const params = paramsFor(stage);
            const calls: RequestCall[] = [];
            let getterCalls = 0;
            const options = { echo: 'method-getter' };
            const transport = {
                get request() {
                    getterCalls++;
                    params.file_id = 'changed-by-request-getter';
                    params['x.params'].inner.label = 'changed-by-request-getter';

                    return function (
                        this: unknown,
                        action: string,
                        snapshot: OneBot12JsonObject = {},
                        forwardedOptions?: OneBot12HttpRequestOptions,
                    ): Promise<OneBot12ActionResponse> {
                        calls.push({
                            receiver: this,
                            action,
                            params: snapshot,
                            options: forwardedOptions,
                        });
                        return Promise.resolve(responseFor(stage));
                    };
                },
            };
            const result = await invoke(stage, transport, params, options);
            expect(result.status).toBe('ok');
            expect(getterCalls).toBe(1);
            expect(calls).toHaveLength(1);
            expect(calls[0]!.receiver).toBe(transport);
            expect(calls[0]!.action).toBe('get_file_fragmented');
            expect(calls[0]!.options).toBe(options);
            expect(calls[0]!.params).not.toBe(params);
            expect(calls[0]!.params.file_id).toBe('file-original');
            expect(calls[0]!.params['x.params']).toEqual({
                inner: { label: 'original' },
                values: ['first', 'second'],
            });
            expect(calls[0]!.params['x.params']).not.toBe(params['x.params']);
            expect(params.file_id).toBe('changed-by-request-getter');
            expect(params['x.params'].inner.label).toBe('changed-by-request-getter');
        });
    }

    it('keeps separate snapshots and receivers during one Proxy-triggered reentrant call', async () => {
        const outerParams: OneBot12GetFileFragmentedPrepareParams = {
            stage: 'prepare',
            file_id: 'outer',
            'x.outer': { nested: ['outer'] },
        };
        const innerParams: OneBot12GetFileFragmentedTransferParams = {
            stage: 'transfer',
            file_id: 'inner',
            offset: 1,
            size: 2,
            'x.inner': { nested: ['inner'] },
        };
        const options = { echo: 'proxy-reentry' };
        const fake = fakeTransport((_action, params) =>
            Promise.resolve(responseFor(params.stage === 'prepare' ? 'prepare' : 'transfer')),
        );
        let trapCalls = 0;
        let innerStarts = 0;
        let innerPending: Promise<unknown> | undefined;
        const outerProxy = new Proxy(outerParams, {
            ownKeys(target) {
                trapCalls++;

                if (innerStarts === 0) {
                    innerStarts++;
                    innerPending = sdk.transferOneBot12FileFragment(
                        fake.transport,
                        innerParams,
                        options,
                    );
                }

                return Reflect.ownKeys(target);
            },
        });
        const outerResult = await sdk.prepareOneBot12FileFragment(
            fake.transport,
            outerProxy,
            options,
        );
        expect(outerResult.status).toBe('ok');
        expect(innerPending).toBeDefined();
        const innerResult = await innerPending;
        expect(innerResult).toEqual(responseFor('transfer'));
        expect(trapCalls).toBeGreaterThan(0);
        expect(innerStarts).toBe(1);
        expect(fake.calls).toHaveLength(2);
        const outerCalls = fake.calls.filter((call) => call.params.stage === 'prepare');
        const innerCalls = fake.calls.filter((call) => call.params.stage === 'transfer');
        expect(outerCalls).toHaveLength(1);
        expect(innerCalls).toHaveLength(1);
        const outerCall = outerCalls[0]!;
        const innerCall = innerCalls[0]!;
        expect(outerCall.receiver).toBe(fake.transport);
        expect(innerCall.receiver).toBe(fake.transport);
        expect(outerCall.action).toBe('get_file_fragmented');
        expect(innerCall.action).toBe('get_file_fragmented');
        expect(outerCall.options).toBe(options);
        expect(innerCall.options).toBe(options);
        expect(outerCall.params.file_id).toBe('outer');
        expect(innerCall.params.file_id).toBe('inner');
        expect(innerCall.params.offset).toBe(1);
        expect(innerCall.params.size).toBe(2);
        expect(outerCall.params).not.toBe(outerParams);
        expect(outerCall.params).not.toBe(outerProxy);
        expect(innerCall.params).not.toBe(innerParams);
        expect(outerCall.params).not.toBe(innerCall.params);
        expect(outerCall.params['x.outer']).toEqual({ nested: ['outer'] });
        expect(innerCall.params['x.inner']).toEqual({ nested: ['inner'] });
        expect(outerCall.params['x.outer']).not.toBe(outerParams['x.outer']);
        expect(innerCall.params['x.inner']).not.toBe(innerParams['x.inner']);
    });

    it('leaves generic request and response parsers independent of fragment-specific fields', () => {
        for (const params of [
            { stage: 'prepare', file_id: 42 },
            { stage: 'transfer', file_id: 'file', offset: 0.5, size: 'not-a-number' },
            { stage: 'future-stage', file_id: 'file' },
        ]) {
            const request = { action: 'get_file_fragmented', params };
            expect(sdk.parseOneBot12ActionRequest(request)).toEqual(request);
        }

        for (const data of [
            { name: 42, total_size: 0.5, sha256: false },
            { data: 42 },
            { name: 'missing the other prepare fields' },
            null,
        ]) {
            const response = { status: 'ok', retcode: 0, data, message: '' };
            expect(sdk.parseOneBot12ActionResponse(response)).toEqual(response);
        }
    });
});
