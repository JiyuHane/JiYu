import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import workerThreads from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OneBot12ClientError, OneBot12RequestOptions } from '../../src/v12/client-types.js';
import type { OneBot12FileFragmentRequester } from '../../src/v12/file-fragmented.js';
import type { OneBot12ReverseWebSocketSession } from '../../src/v12/node/reverse-websocket-server.js';
import type { OneBot12WebSocketClient } from '../../src/v12/websocket-client.js';

// ws supplies OPEN for the real reverse session, but neither ws constructor is
// allowed to run. Both peers below are in-memory event emitters only.
const forbiddenWsConstructors = vi.hoisted(() => [] as string[]);
vi.mock('ws', () => {
    class ForbiddenWebSocket {
        static readonly OPEN = 1;
        constructor() {
            forbiddenWsConstructors.push('ws');
            throw new Error('unexpected ws construction');
        }
    }
    class ForbiddenWebSocketServer {
        constructor() {
            forbiddenWsConstructors.push('ws-server');
            throw new Error('unexpected ws listener');
        }
    }
    return {
        default: ForbiddenWebSocket,
        WebSocket: ForbiddenWebSocket,
        WebSocketServer: ForbiddenWebSocketServer,
    };
});

type Guard = { mock: { calls: unknown[] } };
type Stage = 'prepare' | 'transfer';
type Frame = {
    action: string;
    params: Record<string, unknown>;
    self: { platform: string; user_id: string };
    echo: string;
};
let sdk: typeof import('../../src/v12/index.js');
let reverseApi: typeof import('../../src/v12/node/reverse-websocket-server.js');
let guards: Guard[];
let globalFetch: ReturnType<typeof vi.fn>;
let globalWebSocket: ReturnType<typeof vi.fn>;
const clients: OneBot12WebSocketClient[] = [];
const sessions: OneBot12ReverseWebSocketSession[] = [];

function forbidden(): never {
    throw new Error('unexpected network, native or process operation');
}

beforeEach(async () => {
    forbiddenWsConstructors.length = 0;
    FakeForwardSocket.instances.length = 0;
    globalFetch = vi.fn(forbidden);
    globalWebSocket = vi.fn(function ForbiddenGlobalWebSocket() {
        return forbidden();
    });
    vi.stubGlobal('fetch', globalFetch);
    vi.stubGlobal('WebSocket', globalWebSocket);
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
        vi.spyOn(workerThreads, 'Worker').mockImplementation(forbidden),
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
    reverseApi = await import('../../src/v12/node/reverse-websocket-server.js');
});
afterEach(() => {
    for (const client of clients.splice(0)) {
        client.close();
    }

    for (const session of sessions.splice(0)) {
        if (session.isConnected) {
            session.close();
        }
    }

    const calls = guards.map((guard) => guard.mock.calls.length);
    const effects = [globalFetch.mock.calls.length, globalWebSocket.mock.calls.length];
    const attempts = [...forbiddenWsConstructors];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    expect(calls).toEqual(calls.map(() => 0));
    expect(effects).toEqual([0, 0]);
    expect(attempts).toEqual([]);
});

class FakeForwardSocket extends EventTarget {
    static instances: FakeForwardSocket[] = [];
    readonly sent: string[] = [];
    readonly bufferedAmount = 0;
    readyState = 0;
    constructor(readonly url: string) {
        super();
        FakeForwardSocket.instances.push(this);
    }
    open(): void {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
    }
    send(payload: string): void {
        this.sent.push(payload);
    }
    receive(frame: unknown): void {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }));
    }
    close(): void {
        this.readyState = 3;
        this.dispatchEvent(new Event('close'));
    }
}
class FakeReverseSocket extends EventEmitter {
    readonly sent: string[] = [];
    readonly bufferedAmount = 0;
    readyState = 1;
    readonly terminate = vi.fn(() => {
        this.readyState = 3;
        this.emit('close');
    });
    send(payload: string, callback: (error?: Error) => void): void {
        this.sent.push(payload);
        callback();
    }
    receive(frame: unknown): void {
        this.emit('message', Buffer.from(JSON.stringify(frame)), false);
    }
}
class FakeOwner extends EventEmitter {
    pending = 0;
    readonly reserve = vi.fn((_bytes: number) => {
        this.pending += 1;
    });
    readonly release = vi.fn(() => {
        this.pending -= 1;
    });
    readonly report = vi.fn(
        (error: OneBot12ClientError, session?: OneBot12ReverseWebSocketSession) => {
            session?.report(error);
            this.emit('diagnostic', error);
        },
    );
    readonly disconnected = vi.fn((_session: OneBot12ReverseWebSocketSession) => {});
}

function pendingCount(target: OneBot12WebSocketClient | OneBot12ReverseWebSocketSession): number {
    return (target as unknown as { pending: Map<string, unknown> }).pending.size;
}

async function flush(): Promise<void> {
    for (let index = 0; index < 16; index += 1) {
        await Promise.resolve();
    }
}

function parsed(socket: { sent: string[] }): Frame[] {
    return socket.sent.map((text) => JSON.parse(text) as Frame);
}

function forwardOpening() {
    const client = new sdk.OneBot12WebSocketClient({
        url: 'ws://fixture.invalid/',
        webSocket: FakeForwardSocket as unknown as typeof WebSocket,
        requestTimeoutMs: 0,
    });
    clients.push(client);
    const diagnostics: OneBot12ClientError[] = [];
    client.onError((error) => diagnostics.push(error));
    const opening = client.connect();
    const socket = FakeForwardSocket.instances.at(-1);

    if (!socket) {
        throw new Error('missing synthetic forward socket');
    }

    return { client, socket, opening, diagnostics };
}

function reverse() {
    const socket = new FakeReverseSocket();
    const owner = new FakeOwner();
    // This creates the genuine exported session with the documented fixture
    // seam; it does not construct a server or a real WebSocket.
    const session = Reflect.construct(reverseApi.OneBot12ReverseWebSocketSession, [
        'synthetic-implementation',
        socket,
        owner,
        0,
    ]) as OneBot12ReverseWebSocketSession;
    sessions.push(session);
    const diagnostics: OneBot12ClientError[] = [];
    owner.on('diagnostic', (error: OneBot12ClientError) => diagnostics.push(error));
    return { socket, owner, session, diagnostics };
}

type Harness = {
    target: OneBot12WebSocketClient | OneBot12ReverseWebSocketSession;
    socket: FakeForwardSocket | FakeReverseSocket;
    diagnostics: OneBot12ClientError[];
    owner?: FakeOwner;
};

async function setup(kind: 'forward' | 'reverse'): Promise<Harness> {
    if (kind === 'reverse') {
        const f = reverse();
        return { target: f.session, socket: f.socket, diagnostics: f.diagnostics, owner: f.owner };
    }

    const f = forwardOpening();
    f.socket.open();
    await f.opening;
    return { target: f.client, socket: f.socket, diagnostics: f.diagnostics };
}

function params(stage: Stage) {
    return stage === 'prepare'
        ? {
              stage: 'prepare' as const,
              file_id: 'synthetic-file',
              'x.fixture': { nested: ['prepare'] },
          }
        : {
              stage: 'transfer' as const,
              file_id: 'synthetic-file',
              offset: 2,
              size: 3,
              'x.fixture': { nested: ['transfer'] },
          };
}

function invoke(
    stage: Stage,
    target: OneBot12FileFragmentRequester,
    options?: OneBot12RequestOptions,
) {
    return stage === 'prepare'
        ? sdk.prepareOneBot12FileFragment(
              target,
              { stage: 'prepare', file_id: 'synthetic-file', 'x.fixture': { nested: ['prepare'] } },
              options,
          )
        : sdk.transferOneBot12FileFragment(
              target,
              {
                  stage: 'transfer',
                  file_id: 'synthetic-file',
                  offset: 2,
                  size: 3,
                  'x.fixture': { nested: ['transfer'] },
              },
              options,
          );
}

function success(stage: Stage, echo: string) {
    return {
        status: 'ok' as const,
        retcode: 0,
        data:
            stage === 'prepare'
                ? {
                      name: 'synthetic.bin',
                      total_size: 42,
                      sha256: 'synthetic-hash',
                      'x.data': { part: 'prepare' },
                  }
                : { data: 'AQIDBA==', 'x.data': { part: 'transfer' } },
        message: '',
        echo,
        'x.envelope': { source: 'synthetic' },
    };
}

function expectIdle(f: Harness, frames: number): void {
    expect(f.socket.sent).toHaveLength(frames);
    expect(pendingCount(f.target)).toBe(0);
    expect(f.target.isConnected).toBe(true);

    if (f.owner) {
        expect(f.owner.pending).toBe(0);
        expect(f.owner.reserve).toHaveBeenCalledTimes(frames);
        expect(f.owner.release).toHaveBeenCalledTimes(frames);
    }
}

describe('fragmented file helpers over actual in-memory WebSocket clients', () => {
    it('snapshots both params during forward opening but reads self at the existing later request serialization point', async () => {
        const f = forwardOpening();
        const prepare = params('prepare');
        const transfer = params('transfer');

        if (prepare.stage !== 'prepare' || transfer.stage !== 'transfer') {
            throw new Error('invalid fixture stages');
        }

        const prepareOptions = {
            self: { platform: 'qq', user_id: 'prepare-before' },
            timeoutMs: 0,
        };
        const transferOptions = {
            self: { platform: 'qq', user_id: 'transfer-before' },
            timeoutMs: 0,
        };
        const first = sdk.prepareOneBot12FileFragment(f.client, prepare, prepareOptions);
        const second = sdk.transferOneBot12FileFragment(f.client, transfer, transferOptions);
        void first.catch(() => {});
        void second.catch(() => {});
        expect(f.socket.sent).toHaveLength(0);
        prepare.file_id = 'prepare-after';
        prepare['x.fixture'].nested[0] = 'changed-prepare';
        transfer.file_id = 'transfer-after';
        transfer.offset = 99;
        transfer.size = 100;
        transfer['x.fixture'].nested[0] = 'changed-transfer';
        prepareOptions.self.user_id = 'prepare-after-self';
        transferOptions.self.user_id = 'transfer-after-self';
        f.socket.open();
        await f.opening;
        await flush();
        const sent = parsed(f.socket);
        expect(sent).toHaveLength(2);
        const prepareFrame = sent.find((frame) => frame.params.stage === 'prepare');
        const transferFrame = sent.find((frame) => frame.params.stage === 'transfer');

        if (!prepareFrame || !transferFrame) {
            throw new Error('missing synthetic requests');
        }

        expect(prepareFrame).toEqual({
            action: 'get_file_fragmented',
            params: params('prepare'),
            self: { platform: 'qq', user_id: 'prepare-after-self' },
            echo: expect.any(String),
        });
        expect(transferFrame).toEqual({
            action: 'get_file_fragmented',
            params: params('transfer'),
            self: { platform: 'qq', user_id: 'transfer-after-self' },
            echo: expect.any(String),
        });
        expect(prepareFrame.echo.length).toBeGreaterThan(0);
        expect(transferFrame.echo).not.toBe(prepareFrame.echo);
        expect(pendingCount(f.client)).toBe(2);
        let firstSettled = false;
        void first.then(
            () => {
                firstSettled = true;
            },
            () => {
                firstSettled = true;
            },
        );
        const transferResponse = success('transfer', transferFrame.echo);
        f.socket.receive(transferResponse);
        await expect(second).resolves.toEqual(transferResponse);
        expect(firstSettled).toBe(false);
        expect(pendingCount(f.client)).toBe(1);
        const prepareResponse = success('prepare', prepareFrame.echo);
        f.socket.receive(prepareResponse);
        await expect(first).resolves.toEqual(prepareResponse);
        expect(f.socket.sent).toHaveLength(2);
        expect(pendingCount(f.client)).toBe(0);
        expect(f.diagnostics).toEqual([]);
        // Params are captured by the helpers; options are deliberately forwarded
        // and the observed self timing is not an immutable-options guarantee.
    });

    it('correlates out-of-order reverse responses and releases each actual session reservation once', async () => {
        const f = reverse();
        const self = { platform: 'qq', user_id: 'reverse-account' };
        const prepare = sdk.prepareOneBot12FileFragment(
            f.session,
            params('prepare') as Extract<ReturnType<typeof params>, { stage: 'prepare' }>,
            { self, timeoutMs: 0 },
        );
        const transfer = sdk.transferOneBot12FileFragment(
            f.session,
            params('transfer') as Extract<ReturnType<typeof params>, { stage: 'transfer' }>,
            { self, timeoutMs: 0 },
        );
        void prepare.catch(() => {});
        void transfer.catch(() => {});
        const sent = parsed(f.socket);
        expect(sent).toHaveLength(2);
        const first = sent[0]!;
        const second = sent[1]!;
        expect(first).toEqual({
            action: 'get_file_fragmented',
            params: params('prepare'),
            self,
            echo: expect.any(String),
        });
        expect(second).toEqual({
            action: 'get_file_fragmented',
            params: params('transfer'),
            self,
            echo: expect.any(String),
        });
        expect(first.echo.length).toBeGreaterThan(0);
        expect(second.echo).not.toBe(first.echo);
        expect(f.owner.reserve.mock.calls.map(([bytes]) => bytes)).toEqual(
            f.socket.sent.map((text) => Buffer.byteLength(text)),
        );
        expect(f.owner.pending).toBe(2);
        expect(pendingCount(f.session)).toBe(2);
        let prepareSettled = false;
        void prepare.then(
            () => {
                prepareSettled = true;
            },
            () => {
                prepareSettled = true;
            },
        );
        const secondResponse = success('transfer', second.echo);
        f.socket.receive(secondResponse);
        await expect(transfer).resolves.toEqual(secondResponse);
        expect(prepareSettled).toBe(false);
        expect(f.owner.pending).toBe(1);
        expect(pendingCount(f.session)).toBe(1);
        expect(f.owner.release).toHaveBeenCalledOnce();
        const firstResponse = success('prepare', first.echo);
        f.socket.receive(firstResponse);
        await expect(prepare).resolves.toEqual(firstResponse);
        expect(f.owner.pending).toBe(0);
        expect(pendingCount(f.session)).toBe(0);
        expect(f.owner.release).toHaveBeenCalledTimes(2);
        expect(f.socket.sent).toHaveLength(2);
        expect(f.diagnostics).toEqual([]);
    });

    for (const kind of ['forward', 'reverse'] as const) {
        for (const stage of ['prepare', 'transfer'] as const) {
            it(`${kind} ${stage} preserves a failed envelope without retry`, async () => {
                const f = await setup(kind);
                const self = { platform: 'qq', user_id: `${kind}-self` };
                const result = invoke(stage, f.target, { self, timeoutMs: 0 });
                void result.catch(() => {});
                const sent = parsed(f.socket);
                expect(sent).toHaveLength(1);
                expect(sent[0]).toEqual({
                    action: 'get_file_fragmented',
                    params: params(stage),
                    self,
                    echo: expect.any(String),
                });
                expect(sent[0]!.echo.length).toBeGreaterThan(0);
                expect(pendingCount(f.target)).toBe(1);
                const failure = {
                    status: 'failed',
                    retcode: 10004,
                    data: { reason: 'synthetic', 'x.data': [1, 2] },
                    message: 'synthetic failure',
                    echo: sent[0]!.echo,
                    'x.envelope': { retry: false },
                };
                f.socket.receive(failure);
                await expect(result).resolves.toEqual(failure);
                await flush();
                expectIdle(f, 1);
                expect(f.diagnostics).toEqual([]);
            });

            it(`${kind} ${stage} rejects invalid helper data after one valid transport envelope`, async () => {
                const f = await setup(kind);
                const result = invoke(stage, f.target, {
                    self: { platform: 'qq', user_id: 'fixture' },
                    timeoutMs: 0,
                });
                void result.catch(() => {});
                const frame = parsed(f.socket)[0];

                if (!frame) {
                    throw new Error('missing request frame');
                }

                const badData =
                    stage === 'prepare'
                        ? { name: 'synthetic.bin', total_size: '42', sha256: 'hash' }
                        : { data: 42 };
                f.socket.receive({
                    status: 'ok',
                    retcode: 0,
                    data: badData,
                    message: '',
                    echo: frame.echo,
                });
                await expect(result).rejects.toMatchObject({ code: 'invalid_response' });
                await flush();
                expectIdle(f, 1);
                // The frame envelope is valid; this rejection belongs to the helper.
                expect(f.diagnostics).toEqual([]);
            });

            it(`${kind} ${stage} propagates a malformed transport envelope without retry`, async () => {
                const f = await setup(kind);
                const result = invoke(stage, f.target, {
                    self: { platform: 'qq', user_id: 'fixture' },
                    timeoutMs: 0,
                });
                void result.catch(() => {});
                const frame = parsed(f.socket)[0];

                if (!frame) {
                    throw new Error('missing request frame');
                }

                const data = success(stage, frame.echo).data;
                f.socket.receive({ status: 'ok', retcode: 7, data, message: '', echo: frame.echo });
                await expect(result).rejects.toMatchObject({ code: 'invalid_response' });
                await flush();
                expectIdle(f, 1);
                expect(f.diagnostics).toHaveLength(1);
                expect(f.diagnostics[0]).toBeInstanceOf(sdk.OneBot12ClientError);
                expect(f.diagnostics[0]).toMatchObject({ code: 'invalid_response' });
            });
        }
    }

    it('releases both reverse reservations and clears pending helpers on close', async () => {
        const f = reverse();
        const first = invoke('prepare', f.session, { timeoutMs: 0 });
        const second = invoke('transfer', f.session, { timeoutMs: 0 });
        void first.catch(() => {});
        void second.catch(() => {});
        const echoes = parsed(f.socket).map((frame) => frame.echo);
        expect(echoes).toHaveLength(2);
        expect(echoes[0]).not.toBe(echoes[1]);
        expect(f.owner.pending).toBe(2);
        expect(pendingCount(f.session)).toBe(2);
        f.session.close();
        await Promise.all([
            expect(first).rejects.toMatchObject({ code: 'closed' }),
            expect(second).rejects.toMatchObject({ code: 'closed' }),
        ]);
        expect(f.owner.pending).toBe(0);
        expect(pendingCount(f.session)).toBe(0);
        expect(f.owner.reserve).toHaveBeenCalledTimes(2);
        expect(f.owner.release).toHaveBeenCalledTimes(2);
        expect(f.owner.disconnected).toHaveBeenCalledOnce();
        expect(f.socket.terminate).toHaveBeenCalledOnce();
        f.socket.receive(success('prepare', echoes[0]!));
        f.socket.receive(success('transfer', echoes[1]!));
        await flush();
        expect(f.owner.release).toHaveBeenCalledTimes(2);
        expect(f.socket.sent).toHaveLength(2);
        expect(f.diagnostics).toEqual([]);
    });

    for (const kind of ['forward', 'reverse'] as const) {
        it(`${kind} ignores an extra HTTP echo option and generates distinct transport echoes`, async () => {
            const f = await setup(kind);
            // Extra properties on a structurally assignable variable pass through
            // the helper; WebSocket request options do not select the wire echo.
            const options = {
                self: { platform: 'qq', user_id: 'synthetic-account' },
                timeoutMs: 0,
                echo: 'caller-synthetic',
            };
            const prepare = invoke('prepare', f.target, options);
            const transfer = invoke('transfer', f.target, options);
            void prepare.catch(() => {});
            void transfer.catch(() => {});
            const sent = parsed(f.socket);
            expect(sent).toHaveLength(2);
            expect(sent[0]).toEqual({
                action: 'get_file_fragmented',
                params: params('prepare'),
                self: options.self,
                echo: expect.any(String),
            });
            expect(sent[1]).toEqual({
                action: 'get_file_fragmented',
                params: params('transfer'),
                self: options.self,
                echo: expect.any(String),
            });
            const prepareEcho = sent[0]!.echo;
            const transferEcho = sent[1]!.echo;
            expect(prepareEcho.length).toBeGreaterThan(0);
            expect(transferEcho.length).toBeGreaterThan(0);
            expect(prepareEcho).not.toBe(options.echo);
            expect(transferEcho).not.toBe(options.echo);
            expect(prepareEcho).not.toBe(transferEcho);
            const prepareResponse = success('prepare', prepareEcho);
            const transferResponse = success('transfer', transferEcho);
            f.socket.receive(transferResponse);
            f.socket.receive(prepareResponse);
            await expect(transfer).resolves.toEqual(transferResponse);
            await expect(prepare).resolves.toEqual(prepareResponse);
            expectIdle(f, 2);
            expect(f.diagnostics).toEqual([]);
        });

        for (const mode of ['timeout', 'abort'] as const) {
            it(`${kind} propagates ${mode}, releases pending work and isolates the late echo`, async () => {
                const f = await setup(kind);
                vi.useFakeTimers();

                try {
                    const stage: Stage = kind === 'forward' ? 'prepare' : 'transfer';
                    const nextStage: Stage = stage === 'prepare' ? 'transfer' : 'prepare';
                    const controller = new AbortController();
                    const request = vi.spyOn(f.target, 'request');
                    const first = invoke(stage, f.target, {
                        self: { platform: 'qq', user_id: 'deadline-account' },
                        timeoutMs: mode === 'timeout' ? 25 : 0,
                        signal: controller.signal,
                    });
                    const captured = request.mock.results[0];

                    if (!captured || captured.type !== 'return') {
                        throw new Error('missing genuine WebSocket request promise');
                    }

                    // Both outcomes are observed before cancellation, including
                    // if an assertion later causes fixture cleanup.
                    const transportOutcome = captured.value.then(
                        (value) => ({ value }),
                        (error: unknown) => ({ error }),
                    );
                    const helperOutcome = first.then(
                        (value) => ({ value }),
                        (error: unknown) => ({ error }),
                    );
                    const oldFrame = parsed(f.socket)[0];

                    if (!oldFrame) {
                        throw new Error('missing initial frame');
                    }

                    expect(f.socket.sent).toHaveLength(1);
                    expect(oldFrame).toEqual({
                        action: 'get_file_fragmented',
                        params: params(stage),
                        self: { platform: 'qq', user_id: 'deadline-account' },
                        echo: expect.any(String),
                    });
                    expect(pendingCount(f.target)).toBe(1);

                    if (f.owner) {
                        expect(f.owner.pending).toBe(1);
                        expect(f.owner.reserve).toHaveBeenCalledOnce();
                        expect(f.owner.release).not.toHaveBeenCalled();
                    }

                    if (mode === 'timeout') {
                        await vi.advanceTimersByTimeAsync(25);
                    } else {
                        controller.abort();
                    }

                    const [helper, transport] = await Promise.all([
                        helperOutcome,
                        transportOutcome,
                    ]);
                    expect(helper).toHaveProperty('error');
                    expect(transport).toHaveProperty('error');

                    if (!('error' in helper) || !('error' in transport)) {
                        throw new Error('expected matching request failures');
                    }

                    expect(helper.error).toBe(transport.error);
                    expect(helper.error).toBeInstanceOf(sdk.OneBot12ClientError);
                    expect(helper.error).toMatchObject({
                        code: mode === 'timeout' ? 'timeout' : 'aborted',
                    });
                    expect(pendingCount(f.target)).toBe(0);
                    expect(f.socket.sent).toHaveLength(1);
                    expect(vi.getTimerCount()).toBe(0);

                    if (f.owner) {
                        expect(f.owner.pending).toBe(0);
                        expect(f.owner.release).toHaveBeenCalledOnce();
                    }

                    const fresh = invoke(nextStage, f.target, {
                        self: { platform: 'qq', user_id: 'fresh-account' },
                        timeoutMs: 0,
                    });
                    void fresh.catch(() => {});
                    const newFrame = parsed(f.socket)[1];

                    if (!newFrame) {
                        throw new Error('missing fresh frame');
                    }

                    expect(newFrame.echo).not.toBe(oldFrame.echo);
                    expect(pendingCount(f.target)).toBe(1);
                    let freshSettled = false;
                    void fresh.then(
                        () => {
                            freshSettled = true;
                        },
                        () => {
                            freshSettled = true;
                        },
                    );
                    f.socket.receive(success(stage, oldFrame.echo));
                    await flush();
                    expect(freshSettled).toBe(false);
                    expect(pendingCount(f.target)).toBe(1);
                    expect(f.target.isConnected).toBe(true);
                    expect(f.socket.sent).toHaveLength(2);
                    // The existing transport may report the late unmatched echo.
                    expect(f.diagnostics.length).toBeLessThanOrEqual(1);
                    expect(f.diagnostics.every((error) => error.code === 'protocol')).toBe(true);
                    const freshResponse = success(nextStage, newFrame.echo);
                    f.socket.receive(freshResponse);
                    await expect(fresh).resolves.toEqual(freshResponse);
                    await flush();
                    expectIdle(f, 2);
                    expect(request).toHaveBeenCalledTimes(2);
                    expect(vi.getTimerCount()).toBe(0);
                } finally {
                    vi.useRealTimers();
                }
            });
        }
    }
});
