import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@snowluma/websocket', () => ({
    WebSocketServer: class {
        destroy() {}
    },
}));

import { V12Transport, type V12HttpPollCapability, type V12Response } from '../../src/v12-network';
import { V12Dispatcher } from '../../src/v12/dispatcher';

class Request extends EventEmitter {
    url = '/';
    method = 'POST';
    headers: Record<string, string> = { 'content-type': 'application/json' };
    rawHeaders: string[] = [];
    pause() {}
}

class Response extends EventEmitter {
    headersSent = false;
    destroyed = false;
    writableEnded = false;
    writableFinished = false;
    finished = false;
    status = 0;
    bodies: string[] = [];
    writes = 0;
    headHook?: () => void;
    endHook?: () => void;
    setHeader() {}
    writeHead(status: number): this {
        this.writes++;
        this.headHook?.();
        this.headersSent = true;
        this.status = status;
        return this;
    }
    end(body: string): this {
        this.bodies.push(body);
        this.writableEnded = true;
        this.endHook?.();

        if (!this.destroyed) {
            this.finished = true;
            this.writableFinished = true;
            this.emit('finish');
        }

        return this;
    }
    destroy(): this {
        if (!this.destroyed) {
            this.destroyed = true;
            this.emit('close');
        }

        return this;
    }
    json(): Record<string, unknown> {
        return JSON.parse(this.bodies[0]);
    }
}

const ok: V12Response = { status: 'ok', retcode: 0, data: null, message: '' };

const flush = async () => {
    for (let i = 0; i < 12; i++) {
        await Promise.resolve();
    }
};

function make(extra: Partial<ConstructorParameters<typeof V12Transport>[0]> = {}) {
    const handle = vi.fn(() => ok);
    const transport = new V12Transport({
        host: 'fixture',
        port: 0,
        handle,
        getConnectEvent: () => null,
        subscribe: () => () => undefined,
        ...extra,
    });
    transport.attach();
    return { transport, handle };
}

function request(
    transport: V12Transport,
    body: string,
    configure?: (req: Request, res: Response) => void,
) {
    const req = new Request();
    const res = new Response();
    configure?.(req, res);
    transport.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    req.emit('data', Buffer.from(body));
    req.emit('end');
    return { req, res };
}

const poll = (echo?: string) =>
    JSON.stringify({
        action: 'get_latest_events',
        params: {},
        ...(echo === undefined ? {} : { echo }),
    });

afterEach(() => vi.useRealTimers());

describe('HTTP poll capability routing without sockets', () => {
    it('keeps the ordinary and absent-capability microtask path', async () => {
        const a = make();
        const first = request(a.transport, poll(''));
        expect(a.handle).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(a.handle).toHaveBeenCalledTimes(1);
        await flush();
        expect(first.res.json()).toMatchObject({ retcode: 0, echo: '' });
        const capability = { run: vi.fn(() => ({ kind: 'unavailable' as const })) };
        const b = make({ httpPoll: capability });
        request(b.transport, JSON.stringify({ action: 'get_version', params: {} }));
        expect(b.handle).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(b.handle).toHaveBeenCalledTimes(1);
        expect(capability.run).not.toHaveBeenCalled();
        await flush();
        await a.transport.close();
        await b.transport.close();
    });
    it.each(['error', 'close', 'quiesce'] as const)(
        'guards fixed failure head reentry: %s',
        async (event) => {
            for (const busy of [false, true]) {
                const cap = { run: vi.fn(() => ({ kind: 'unavailable' as const })) };
                const { transport } = make({
                    httpPoll: cap,
                    ...(busy ? { maxConcurrent: 1 } : {}),
                });
                const { res } = request(transport, poll(), (_req, response) => {
                    response.headHook = () => {
                        if (event === 'error') {
                            response.emit('error', new Error('fixture'));
                        }

                        if (event === 'close') {
                            response.destroy();
                        }

                        if (event === 'quiesce') {
                            transport.quiesce();
                        }
                    };
                });
                await flush();
                expect(res.destroyed).toBe(true);
                expect(res.writes).toBe(1);
                expect(res.bodies).toHaveLength(0);
                await transport.close();
            }
        },
    );
    it.each(['queue_error', 'fatal_budget'] as const)('destroys on %s', async (kind) => {
        const cap: V12HttpPollCapability = { run: () => ({ kind: 'outcome', outcome: { kind } }) };
        const { transport } = make({ httpPoll: cap });
        const { res } = request(transport, poll());
        await flush();
        expect(res.destroyed).toBe(true);
        expect(res.bodies).toHaveLength(0);
        await transport.close();
    });
    it('seals a retained sink at task settlement', async () => {
        let held!: import('../../src/v12-runtime/poll-transaction').PollSink;
        const cap: V12HttpPollCapability = {
            run(_input, { sink }) {
                held = sink;
                return { kind: 'unavailable' };
            },
        };
        const { transport } = make({ httpPoll: cap });
        const { res } = request(transport, poll());
        await flush();
        expect(res.json()).toMatchObject({ retcode: 20002 });
        expect(held.isOpen()).toBe(false);
        expect(() => held.writeHead()).toThrow();
        expect(() => held.end('late')).toThrow();
        expect(res.writes).toBe(1);
        expect(res.destroyed).toBe(false);
        await transport.close();
    });
    it.each(['error', 'close', 'quiesce'] as const)(
        'rechecks control state after headersSent getter reentry: %s',
        async (event) => {
            for (const busy of [false, true]) {
                for (const postHead of [false, true]) {
                    const cap = { run: vi.fn(() => ({ kind: 'unavailable' as const })) };
                    const { transport } = make({
                        httpPoll: cap,
                        ...(busy ? { maxConcurrent: 1 } : {}),
                    });
                    let triggered = false;
                    const { res } = request(transport, poll(), (_req, response) => {
                        let sent = false;
                        Object.defineProperty(response, 'headersSent', {
                            get() {
                                if (
                                    !triggered &&
                                    (postHead ? response.writes === 1 : response.writes === 0)
                                ) {
                                    triggered = true;

                                    if (event === 'error') {
                                        response.emit('error', new Error('fixture'));
                                    }

                                    if (event === 'close') {
                                        response.destroy();
                                    }

                                    if (event === 'quiesce') {
                                        transport.quiesce();
                                    }
                                }

                                return sent;
                            },
                            set(value: boolean) {
                                sent = value;
                            },
                        });
                    });
                    await flush();
                    expect(triggered).toBe(true);
                    expect(res.destroyed).toBe(true);
                    expect(res.writes).toBe(postHead ? 1 : 0);
                    expect(res.bodies).toHaveLength(0);
                    await transport.close();
                }
            }
        },
    );
    it('tracks cross-realm Promise writes before settlement', async () => {
        const deferred = runInNewContext(`(() => {
            let resolve;
            const promise = new Promise(r => { resolve = r; });
            return { promise, resolve };
        })()`) as {
            promise: Promise<import('../../src/v12-network').V12HttpPollResult>;
            resolve: (value: import('../../src/v12-network').V12HttpPollResult) => void;
        };
        let held!: import('../../src/v12-runtime/poll-transaction').PollSink;
        const cap: V12HttpPollCapability = {
            run(_input, { sink }) {
                held = sink;
                return deferred.promise;
            },
        };
        const { transport } = make({ httpPoll: cap });
        const { res } = request(transport, poll());
        await flush();
        expect(held.isOpen()).toBe(true);
        held.writeHead();
        held.end('{"status":"ok","retcode":0,"data":[],"message":""}');
        deferred.resolve({
            kind: 'outcome',
            outcome: { kind: 'local_finish', response: 'empty', reason: 'empty' },
        });
        await flush();
        expect(res.destroyed).toBe(false);
        expect(res.writes).toBe(1);
        expect(held.isOpen()).toBe(false);
        await transport.close();
    });
    it('returns fixed failure when trusted capability reports not ready', async () => {
        const capability = { run: vi.fn(() => ({ kind: 'unavailable' as const })) };
        const { transport, handle } = make({ httpPoll: capability });
        const { res } = request(transport, poll('😀'));
        await flush();
        expect(res.status).toBe(200);
        expect(res.json()).toEqual({
            status: 'failed',
            retcode: 20002,
            data: null,
            message: 'poll unavailable',
            echo: '😀',
        });
        expect(handle).not.toHaveBeenCalled();
        await transport.close();
    });
    it('runs shared preflight before the not-ready gate in a fake capability', async () => {
        const dispatcher = new V12Dispatcher({
            self: { platform: 'fixture', user_id: '1' },
            version: { impl: 'fixture', version: '1' },
            api: { handle: async () => ({ status: 'ok', retcode: 0, data: null }) },
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
        });
        const preflight = dispatcher.createInternalHttpPreflight();
        const cap: V12HttpPollCapability = {
            run(input) {
                const checked = preflight.classify(input);

                if (checked.kind === 'error') {
                    const errors = {
                        'invalid action request': 'invalid_request',
                        'unknown self': 'unknown_self',
                        'invalid poll parameters': 'invalid_params',
                        'unsupported request field': 'unsupported_field',
                        'unsupported parameter': 'unsupported_parameter',
                    } as const;
                    const error = errors[checked.response.message as keyof typeof errors];

                    if (!error) {
                        throw new Error('unexpected preflight result');
                    }

                    return { kind: 'preflight', error };
                }

                return { kind: 'unavailable' };
            },
        };
        const { transport } = make({ httpPoll: cap });
        const cases = [
            [{ self: { platform: 'fixture', user_id: '2' } }, 10102],
            [{ params: { timeout: 11 } }, 10003],
            [{ params: { extra: true } }, 10004],
            [{ extra: true }, 10004],
            [{ params: { timeout: 0 } }, 20002],
        ] as const;

        for (const [fields, retcode] of cases) {
            const { res } = request(
                transport,
                JSON.stringify({ action: 'get_latest_events', params: {}, echo: '', ...fields }),
            );
            await flush();
            expect(res.json()).toMatchObject({ retcode, echo: '' });
        }

        await transport.close();
    });
    it('routes a fake websocket action only through the original handler', async () => {
        class FakeWebSocket extends EventEmitter {
            frames: string[] = [];
            send(text: string, callback?: (error?: Error) => void) {
                this.frames.push(text);
                callback?.();
            }
            terminate() {
                this.emit('close');
            }
        }
        const cap = { run: vi.fn(() => ({ kind: 'unavailable' as const })) };
        const { transport, handle } = make({ httpPoll: cap });
        const ws = new FakeWebSocket();
        (transport as unknown as { accept(ws: unknown): void }).accept(ws);
        ws.emit('message', Buffer.from(poll('ws')), false);
        await flush();
        expect(handle).toHaveBeenCalledTimes(1);
        expect(cap.run).not.toHaveBeenCalled();
        expect(JSON.parse(ws.frames[1])).toMatchObject({ retcode: 0, echo: 'ws' });
        await transport.close();
    });
    it('uses the parsed last duplicate action and echo', async () => {
        const cap = { run: vi.fn(() => ({ kind: 'unavailable' as const })) };
        const { transport } = make({ httpPoll: cap });
        const { res } = request(
            transport,
            '{"action":"x","action":"get_latest_events","params":{},"echo":"first","echo":""}',
        );
        await flush();
        expect(cap.run).toHaveBeenCalledTimes(1);
        expect(res.json()).toMatchObject({ retcode: 20002, echo: '' });
        await transport.close();
    });
    it('respects HTTP early checks and validation before capability', async () => {
        const cap = { run: vi.fn(() => ({ kind: 'unavailable' as const })) };
        const { transport } = make({
            httpPoll: cap,
            accessToken: 'fixture-token',
            maxOutputBytes: 1,
        });
        const a = request(transport, poll(), (req) => {
            req.url = '/?access_token=fixture-token';
            req.rawHeaders = ['Authorization', 'Bearer wrong'];
        });
        expect(a.res.status).toBe(401);
        expect(a.res.bodies).toEqual(['']);
        const b = request(transport, poll(), (req) => {
            req.url = '/?access_token=fixture-token';
            req.headers['content-type'] = 'text/plain';
        });
        expect(b.res.status).toBe(415);
        expect(b.res.bodies).toEqual(['']);
        expect(cap.run).not.toHaveBeenCalled();
        await transport.close();
    });
    it('preserves validRequest and active admission before poll preflight', async () => {
        let release!: (value: V12Response) => void;
        const pending = new Promise<V12Response>((resolve) => {
            release = resolve;
        });
        const cap = { run: vi.fn(() => ({ kind: 'unavailable' as const })) };
        const { transport } = make({ httpPoll: cap, maxConcurrent: 2, handle: () => pending });
        const invalid = request(
            transport,
            JSON.stringify({ action: 'get_latest_events', params: null, echo: '' }),
        );
        expect(invalid.res.json()).toMatchObject({ retcode: 10001, echo: '' });
        const first = request(transport, JSON.stringify({ action: 'x', params: {} }));
        request(transport, JSON.stringify({ action: 'x', params: {} }));
        await flush();
        first.res.destroy();
        const busy = request(transport, poll('p'));
        expect(busy.res.json()).toMatchObject({
            retcode: 20002,
            message: 'transport busy',
            echo: 'p',
        });
        expect(cap.run).not.toHaveBeenCalled();
        release(ok);
        await flush();
        await transport.close();
    });
    it('reserves a normal action slot and rejects polls when maxConcurrent is one', async () => {
        const cap = { run: vi.fn(() => ({ kind: 'unavailable' as const })) };
        const { transport } = make({ httpPoll: cap, maxConcurrent: 1 });
        const { res } = request(transport, poll());
        expect(res.json()).toMatchObject({ retcode: 20002, message: 'transport busy' });
        expect(cap.run).not.toHaveBeenCalled();
        await transport.close();
    });
    it('does not write a second response after a successful owned write', async () => {
        const capability: V12HttpPollCapability = {
            run(_input, { sink }) {
                sink.writeHead();
                sink.end('{"status":"ok","retcode":0,"data":[],"message":""}');
                return {
                    kind: 'outcome',
                    outcome: { kind: 'local_finish', response: 'empty', reason: 'empty' },
                };
            },
        };
        const { transport } = make({ httpPoll: capability });
        const { res } = request(transport, poll());
        await flush();
        expect(res.writes).toBe(1);
        expect(res.bodies).toHaveLength(1);
        expect(res.json().data).toEqual([]);
        await transport.close();
    });
    it('destroys on partial header throw and retains a sanitized error listener', async () => {
        const onError = vi.fn();
        const capability: V12HttpPollCapability = {
            run(_input, { sink }) {
                sink.writeHead();
                return { kind: 'unavailable' };
            },
        };
        const { transport } = make({ httpPoll: capability, onError });
        const { res } = request(transport, poll(), (_req, response) => {
            response.headHook = () => {
                response.headersSent = true;
                throw new Error('fixture-detail');
            };
        });
        await flush();
        expect(res.destroyed).toBe(true);
        expect(res.writes).toBe(1);
        expect(res.bodies).toHaveLength(0);
        res.emit('error', new Error('fixture-detail'));
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][0].message).toBe('poll response error');
        await transport.close();
    });
    it('aborts at deadline yet holds active work until the original promise settles', async () => {
        vi.useFakeTimers();
        let release!: (value: { kind: 'unavailable' }) => void;
        let signal!: AbortSignal;
        const pending = new Promise<{ kind: 'unavailable' }>((resolve) => {
            release = resolve;
        });
        const cap: V12HttpPollCapability = {
            run(_input, ctx) {
                signal = ctx.signal;
                return pending;
            },
        };
        const { transport } = make({ httpPoll: cap, timeoutMs: 50, maxConcurrent: 2 });
        const first = request(transport, poll());
        await flush();
        vi.advanceTimersByTime(50);
        expect(signal.aborted).toBe(true);
        expect(first.res.destroyed).toBe(true);
        expect(first.res.bodies).toHaveLength(0);
        const second = request(transport, poll('second'));
        expect(second.res.json()).toMatchObject({ message: 'transport busy', echo: 'second' });
        release({ kind: 'unavailable' });
        await flush();
        expect(first.res.bodies).toHaveLength(0);
        await transport.close();
    });
    it('aborts a parsed body before the capability microtask', async () => {
        const cap = { run: vi.fn(() => ({ kind: 'unavailable' as const })) };
        const { transport } = make({ httpPoll: cap });
        const { req, res } = request(transport, poll());
        req.emit('aborted');
        await flush();
        expect(cap.run).not.toHaveBeenCalled();
        expect(res.destroyed).toBe(true);
        expect(res.bodies).toHaveLength(0);
        await transport.close();
    });
    it('destroys rather than drop an echo that exceeds the output cap', async () => {
        const cap = { run: vi.fn(() => ({ kind: 'unavailable' as const })) };
        const { transport } = make({ httpPoll: cap, maxOutputBytes: 128 });
        const { res } = request(transport, poll('😀'.repeat(128)));
        await flush();
        expect(res.destroyed).toBe(true);
        expect(res.bodies).toHaveLength(0);
        await transport.close();
    });
    it('keeps the constructor deadline zero invalid', () => {
        expect(() => make({ timeoutMs: 0 })).toThrow(RangeError);
    });
    it('does not start work after close before the action microtask', async () => {
        const cap = { run: vi.fn(() => ({ kind: 'unavailable' as const })) };
        const { transport } = make({ httpPoll: cap });
        const { res } = request(transport, poll());
        res.destroy();
        await flush();
        expect(cap.run).not.toHaveBeenCalled();
        expect(res.bodies).toHaveLength(0);
        await transport.close();
    });
    it.each([
        ['invalid_request', 10001],
        ['unknown_self', 10102],
        ['invalid_params', 10003],
        ['unsupported_field', 10004],
        ['unsupported_parameter', 10004],
    ] as const)('maps trusted preflight %s with echo', async (error, retcode) => {
        const cap: V12HttpPollCapability = { run: () => ({ kind: 'preflight', error }) };
        const { transport } = make({ httpPoll: cap });
        const { res } = request(transport, poll(''));
        await flush();
        expect(res.json()).toMatchObject({ status: 'failed', retcode, echo: '' });
        await transport.close();
    });
    it.each([
        'release_unknown',
        'commit_unknown',
        'committed_unsent',
        'cleanup_uncertain',
    ] as const)('destroys and counts uncertain outcome %s', async (kind) => {
        const cap: V12HttpPollCapability = {
            run: () => ({
                kind: 'outcome',
                outcome:
                    kind === 'cleanup_uncertain'
                        ? { kind, outcome: { kind: 'queue_error' }, committed: 'unknown' }
                        : { kind },
            }),
        };
        const { transport } = make({ httpPoll: cap });
        const { res } = request(transport, poll());
        await flush();
        expect(res.destroyed).toBe(true);
        expect(res.bodies).toHaveLength(0);
        expect((transport as unknown as { pollUnknown: number }).pollUnknown).toBe(1);
        await transport.close();
    });
    it('blocks synchronous and late sink writes after deadline abort', async () => {
        vi.useFakeTimers();
        let resolve!: (value: { kind: 'unavailable' }) => void;
        const pending = new Promise<{ kind: 'unavailable' }>((done) => {
            resolve = done;
        });
        const attempts: string[] = [];
        const cap: V12HttpPollCapability = {
            run(_input, { signal, sink }) {
                signal.addEventListener('abort', () => {
                    try {
                        sink.writeHead();
                    } catch {
                        attempts.push('abort-blocked');
                    }
                });
                void pending.then(() => {
                    try {
                        sink.writeHead();
                    } catch {
                        attempts.push('late-blocked');
                    }
                });
                return pending;
            },
        };
        const { transport } = make({ httpPoll: cap, timeoutMs: 10 });
        const { res } = request(transport, poll());
        await flush();
        vi.advanceTimersByTime(10);
        expect(attempts).toEqual(['abort-blocked']);
        resolve({ kind: 'unavailable' });
        await flush();
        expect(attempts).toEqual(['abort-blocked', 'late-blocked']);
        expect(res.writes).toBe(0);
        expect(res.bodies).toHaveLength(0);
        await transport.close();
    });
    it('quiesces during writeHead and suppresses the reentrant end', async () => {
        const capability: V12HttpPollCapability = {
            run(_input, { sink }) {
                sink.writeHead();
                sink.end('unexpected');
                return { kind: 'unavailable' };
            },
        };
        const { transport } = make({ httpPoll: capability });
        const { res } = request(transport, poll(), (_req, response) => {
            response.headHook = () => transport.quiesce();
        });
        await flush();
        expect(res.destroyed).toBe(true);
        expect(res.writes).toBe(1);
        expect(res.bodies).toHaveLength(0);
        await transport.close();
    });
    it('handles a synchronous close from end without attempting a second response', async () => {
        const capability: V12HttpPollCapability = {
            run(_input, { sink }) {
                sink.writeHead();
                sink.end('partial');
                return { kind: 'outcome', outcome: { kind: 'unknown', committed: true } };
            },
        };
        const { transport } = make({ httpPoll: capability });
        const { res } = request(transport, poll(), (_req, response) => {
            response.endHook = () => response.destroy();
        });
        await flush();
        expect(res.destroyed).toBe(true);
        expect(res.writes).toBe(1);
        expect(res.bodies).toEqual(['partial']);
        expect((transport as unknown as { pollUnknown: number }).pollUnknown).toBe(1);
        await transport.close();
    });
    it('aborts synchronously on quiesce and observes late rejection', async () => {
        let reject!: (error: Error) => void;
        let signal!: AbortSignal;
        const pending = new Promise<never>((_resolve, rejectPromise) => {
            reject = rejectPromise;
        });
        const cap: V12HttpPollCapability = {
            run(_input, context) {
                signal = context.signal;
                return pending;
            },
        };
        const onError = vi.fn();
        const { transport } = make({ httpPoll: cap, onError });
        const { res } = request(transport, poll());
        await flush();
        transport.quiesce();
        expect(signal.aborted).toBe(true);
        expect(res.destroyed).toBe(true);
        reject(new Error('fixture-detail'));
        await flush();
        expect(res.bodies).toHaveLength(0);
        expect(onError).not.toHaveBeenCalled();
        expect((transport as unknown as { pollUnknown: number }).pollUnknown).toBe(1);
        await transport.close();
    });
});
