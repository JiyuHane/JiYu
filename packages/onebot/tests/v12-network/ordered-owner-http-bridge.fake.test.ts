import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Preserve other exports, but block both named and default server creation.
vi.mock('node:http', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:http')>();
    const defaultExport = (actual as unknown as { default?: Record<string, unknown> }).default;

    const blocked = () => {
        throw new Error('unexpected HTTP server creation in fake fixture');
    };

    return {
        ...actual,
        createServer: blocked,
        default: { ...(defaultExport ?? actual), createServer: blocked },
    };
});

// attach() receives only this in-memory stub; there is no real WebSocket class.
vi.mock('@snowluma/websocket', () => ({
    WebSocket: class {
        constructor() {
            throw new Error('unexpected WebSocket creation in fake fixture');
        }
    },
    WebSocketServer: class {
        destroy() {}
    },
}));

import {
    V12Transport,
    type V12HttpPollCapability,
    type V12HttpPollResult,
} from '../../src/v12-network';
import { V12Dispatcher } from '../../src/v12/dispatcher';
import type { JsonObject } from '../../src/types';
import { EventPollBuffer, type PollOptions } from '../../src/v12-runtime/event-poll-buffer';
import {
    activateOrderedPollOwner,
    createPollGate,
    pollOwnerStats,
    registerPollHost,
    type OrderedPollOwner,
} from '../../src/v12-runtime/poll-owner';
import type { PollOutcome } from '../../src/v12-runtime/poll-transaction';
import { SourceGeneration } from '../../src/v12-runtime/source-generation';

/** These objects emulate only the Node methods used by handleRequest and its sink. */
class FakeRequest extends EventEmitter {
    url = '/';
    method = 'POST';
    headers: Record<string, string> = { 'content-type': 'application/json' };
    rawHeaders: string[];

    constructor(token: string) {
        super();
        this.rawHeaders = ['Authorization', `Bearer ${token}`];
    }

    pause(): void {}
}

class FakeResponse extends EventEmitter {
    headersSent = false;
    destroyed = false;
    writableEnded = false;
    writableFinished = false;
    finished = false;
    status = 0;
    writes = 0;
    endAttempts = 0;
    bodies: string[] = [];
    throwOnEnd = false;

    setHeader(): void {}

    writeHead(status: number): this {
        this.writes++;
        this.status = status;
        this.headersSent = true;
        return this;
    }

    end(body: string): this {
        this.endAttempts++;

        if (this.throwOnEnd) {
            throw new Error('synthetic end failure');
        }

        this.bodies.push(body);
        this.writableEnded = true;

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
        return JSON.parse(this.bodies[0]) as Record<string, unknown>;
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function settle(): Promise<void> {
    for (let i = 0; i < 40; i++) {
        await Promise.resolve();
    }
}

const action = (params: object = {}, extra: object = {}) => ({
    action: 'get_latest_events',
    params,
    ...extra,
});

function event(account: string, id: number, time = id) {
    return {
        id: `${account}-event-${id}`,
        time,
        type: 'message',
        detail_type: 'private',
        sub_type: '',
        self: { platform: 'qq', user_id: account },
        message_id: String(id),
        message: [{ type: 'text', data: { text: `event-${id}` } }],
        alt_message: `event-${id}`,
        user_id: '23456',
    };
}

const fixtures: Array<{
    state: { owner: OrderedPollOwner | null };
    transport: V12Transport;
}> = [];

/**
 * This is deliberately a test-only bridge, not production wiring or a proof of
 * producer readiness. It classifies the actual parsed request before consulting
 * the explicitly activated owner and awaits the original transaction result.
 */
function fixture(account: string, injectCapability = true) {
    const token = `fixture-token-${account}`;
    const generation = new SourceGeneration();
    generation.setOnline(true);
    const binding = {};
    const runtime = {};
    const gate = createPollGate();
    registerPollHost(
        runtime,
        {
            self: { platform: 'qq', user_id: account },
            captureBinding: () => binding,
            captureSource: () => generation.capture(binding),
            verify: (source) => generation.isCurrent(source, binding),
        },
        gate,
    );

    const api = {
        handle: vi.fn(async (_name: string, _params: JsonObject) => ({
            status: 'ok' as const,
            retcode: 0,
            data: null,
        })),
    };
    const dispatcher = new V12Dispatcher({
        self: { platform: 'qq', user_id: account },
        version: { impl: 'fixture', version: '1' },
        api,
        getStatus: () => ({ good: true, online: true }),
        getSentMessageTime: () => null,
    });
    const preflight = dispatcher.createInternalHttpPreflight();
    const handle = vi.fn((input: unknown) => dispatcher.handle(input));
    const state: { owner: OrderedPollOwner | null; outcomes: PollOutcome[] } = {
        owner: null,
        outcomes: [],
    };

    const capability: V12HttpPollCapability = {
        async run(input, context): Promise<V12HttpPollResult> {
            const checked = preflight.classify(input);

            if (checked.kind === 'error') {
                const errors = {
                    'invalid action request': 'invalid_request',
                    'unknown self': 'unknown_self',
                    'invalid poll parameters': 'invalid_params',
                    'unsupported request field': 'unsupported_field',
                    'unsupported parameter': 'unsupported_parameter',
                } as const;
                const reason = errors[checked.response.message as keyof typeof errors];

                if (!reason) {
                    throw new Error('unexpected fixture preflight response');
                }

                return { kind: 'preflight', error: reason };
            }

            // The HTTP transport routes only a parsed get_latest_events here.
            // Never execute a prepared ordinary token from this test capability.
            if (checked.kind !== 'poll') {
                throw new Error('unexpected ordinary action in poll fixture');
            }

            const owner = state.owner;

            if (!owner || !owner.matchesTarget(runtime)) {
                return { kind: 'unavailable' };
            }

            const operation = owner.start(
                {
                    limit: checked.limit,
                    timeoutMs: checked.timeoutSeconds * 1000,
                    echo: checked.echo,
                    maxOutputBytes: context.maxOutputBytes,
                    responseDeadline: context.responseDeadline,
                    externalAbortSignal: context.signal,
                },
                context.sink,
            );
            const outcome = await operation.result;
            state.outcomes.push(outcome);
            return { kind: 'outcome', outcome };
        },
    };
    const run = vi.spyOn(capability, 'run');
    const transport = new V12Transport({
        host: 'fixture',
        port: 1,
        accessToken: token,
        handle,
        ...(injectCapability ? { httpPoll: capability } : {}),
        getConnectEvent: () => null,
        subscribe: () => () => undefined,
    });
    transport.attach();

    const activate = (): OrderedPollOwner => {
        const result = activateOrderedPollOwner(runtime);

        if (result.status !== 'ready') {
            throw new Error(`fixture owner ${result.status}`);
        }

        state.owner = result.owner;
        return result.owner;
    };

    const source = () => {
        const ticket = generation.capture(binding);

        if (!ticket) {
            throw new Error('fixture source unavailable');
        }

        return ticket;
    };

    const value = {
        account,
        token,
        generation,
        binding,
        runtime,
        gate,
        api,
        dispatcher,
        handle,
        run,
        state,
        transport,
        activate,
        source,
    };
    fixtures.push(value);
    return value;
}

type Fixture = ReturnType<typeof fixture>;

function send(
    f: Fixture,
    input: object | string,
    configure?: (req: FakeRequest, res: FakeResponse) => void,
) {
    const req = new FakeRequest(f.token);
    const res = new FakeResponse();
    configure?.(req, res);
    f.transport.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    req.emit('data', Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)));
    req.emit('end');
    return { req, res };
}

function admit(f: Fixture) {
    const parent = f.state.owner?.begin(f.source());
    const child = parent?.child();

    if (!parent || !child || !parent.seal()) {
        throw new Error('fixture admission failed');
    }

    return child;
}

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(async () => {
    try {
        const results = await Promise.allSettled(
            fixtures.splice(0).map(async (f) => {
                try {
                    f.state.owner?.invalidate();
                } finally {
                    await f.transport.close();
                }
            }),
        );
        await settle();
        const failed = results.find((result) => result.status === 'rejected');

        if (failed?.status === 'rejected') {
            throw failed.reason;
        }
    } finally {
        vi.restoreAllMocks();
        vi.useRealTimers();
    }
});

describe('ordered owner and HTTP capability bridge (synthetic, no sockets)', () => {
    it('keeps absent capability unsupported and maps missing or empty owner to unavailable', async () => {
        const legacy = fixture('10001', false);
        const absentCapability = send(legacy, action({}, { echo: '' }));
        await settle();
        expect(absentCapability.res.json()).toEqual({
            status: 'failed',
            retcode: 10002,
            data: null,
            message: 'unsupported action',
            echo: '',
        });
        expect(legacy.run).not.toHaveBeenCalled();
        expect(legacy.handle).toHaveBeenCalledTimes(1);

        const f = fixture('10002');
        const missing = send(f, action({}, { echo: 'missing' }));
        await settle();
        expect(missing.res.json()).toEqual({
            status: 'failed',
            retcode: 20002,
            data: null,
            message: 'poll unavailable',
            echo: 'missing',
        });
        expect(f.state.outcomes).toHaveLength(0);

        f.activate();
        const empty = send(f, action({}, { echo: '' }));
        await settle();
        expect(empty.res.json()).toEqual({
            status: 'failed',
            retcode: 20002,
            data: null,
            message: 'poll unavailable',
            echo: '',
        });
        expect(f.state.outcomes).toContainEqual({ kind: 'empty_unresolved', reason: 'empty' });
        expect(f.handle).not.toHaveBeenCalled();

        const waiting = send(f, action({ timeout: 1 }));
        await settle();
        expect(waiting.res.bodies).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1000);
        await settle();
        expect(waiting.res.json()).toEqual({
            status: 'failed',
            retcode: 20002,
            data: null,
            message: 'poll unavailable',
        });
        expect(f.state.outcomes).toContainEqual({ kind: 'empty_unresolved', reason: 'timeout' });
    });

    it('returns the admitted A/B order and a prefix while a later head is pending', async () => {
        const f = fixture('10001');
        f.activate();
        const first = admit(f);
        const second = admit(f);
        const a = event(f.account, 1, 2);
        const b = event(f.account, 2, 1);
        expect(second.resolve(b)).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(pollOwnerStats(f.runtime)?.accepted).toBe(0);

        const unresolved = send(f, action({}, { echo: '' }));
        await settle();
        expect(unresolved.res.json()).toMatchObject({ retcode: 20002, echo: '' });
        expect(f.state.outcomes).toContainEqual({ kind: 'empty_unresolved', reason: 'empty' });

        expect(first.resolve(a)).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(pollOwnerStats(f.runtime)?.accepted).toBe(2);
        const later = admit(f);
        const echo = '😺\n"\\';
        const firstBatch = send(f, action({ limit: 1 }, { echo }));
        await settle();
        expect(firstBatch.res.json()).toEqual({
            status: 'ok',
            retcode: 0,
            data: [a],
            message: '',
            echo,
        });
        expect(firstBatch.res.writes).toBe(1);
        expect(firstBatch.res.bodies).toHaveLength(1);

        const secondBatch = send(f, action({ limit: 0 }));
        await settle();
        expect(secondBatch.res.json()).toEqual({
            status: 'ok',
            retcode: 0,
            data: [b],
            message: '',
        });
        expect(later.resolve(event(f.account, 3))).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        const thirdBatch = send(f, action());
        await settle();
        expect(thirdBatch.res.json()).toMatchObject({ status: 'ok', data: [event(f.account, 3)] });
        expect(f.handle).not.toHaveBeenCalled();
        expect(f.state.outcomes.filter((outcome) => outcome.kind === 'local_finish')).toHaveLength(
            3,
        );
    });

    it('checks auth, identity, parameters and echo before readiness, and runs an ordinary action once', async () => {
        const f = fixture('10001');
        const denied = send(f, action({}, { echo: 'not-read' }), (req) => {
            req.url = `/?access_token=${f.token}`;
            req.rawHeaders = ['Authorization', 'Bearer wrong'];
        });
        expect(denied.res.status).toBe(401);
        expect(f.run).not.toHaveBeenCalled();
        const invalidShape = send(f, { action: 'get_latest_events', params: null, echo: '' });
        expect(invalidShape.res.json()).toMatchObject({ retcode: 10001, echo: '' });
        expect(f.run).not.toHaveBeenCalled();

        const cases = [
            [action({}, { self: { platform: 'qq', user_id: '10002' }, echo: '' }), 10102],
            [action({ timeout: 11 }, { echo: '' }), 10003],
            [action({ limit: -1, extra: true }, { echo: '' }), 10004],
            [action({}, { extra: true, echo: '' }), 10004],
        ] as const;

        for (const [input, retcode] of cases) {
            const result = send(f, input);
            await settle();
            expect(result.res.json()).toMatchObject({ status: 'failed', retcode, echo: '' });
        }

        const parsedOnce = send(
            f,
            '{"action":"other","action":"get_latest_events","params":{},"echo":"first","echo":""}',
        );
        await settle();
        expect(parsedOnce.res.json()).toMatchObject({ retcode: 20002, echo: '' });
        expect(f.state.outcomes).toHaveLength(0);

        f.activate();
        const oversizedEcho = 'x'.repeat(4097);
        const tooLong = send(f, action({}, { echo: oversizedEcho }));
        await settle();
        expect(tooLong.res.json()).toMatchObject({ retcode: 10003, echo: oversizedEcho });
        expect(f.state.outcomes).toContainEqual({ kind: 'invalid_input' });

        const waiting = send(f, action({ timeout: 1 }, { echo: 'wait' }));
        await settle();
        const pollCalls = f.run.mock.calls.length;
        const ordinary = send(f, {
            action: 'delete_message',
            params: { message_id: '-42' },
            self: { platform: 'qq', user_id: f.account },
            echo: '',
        });
        await settle();
        expect(ordinary.res.json()).toEqual({
            status: 'ok',
            retcode: 0,
            data: null,
            message: '',
            echo: '',
        });
        expect(f.api.handle).toHaveBeenCalledTimes(1);
        expect(f.api.handle).toHaveBeenCalledWith('delete_msg', { message_id: -42 });
        expect(f.handle).toHaveBeenCalledTimes(1);
        expect(f.run).toHaveBeenCalledTimes(pollCalls);
        expect(waiting.res.bodies).toHaveLength(0);
        waiting.req.emit('aborted');
        await settle();
        expect(waiting.res.destroyed).toBe(true);
        expect(waiting.res.bodies).toHaveLength(0);
        expect(f.api.handle).toHaveBeenCalledTimes(1);
    });

    it('keeps two fake accounts on distinct gates and does not consume a cross-self request', async () => {
        const a = fixture('10001');
        const b = fixture('10002');
        a.activate();
        b.activate();
        expect(a.gate).not.toBe(b.gate);
        expect(admit(a).resolve(event(a.account, 1))).toBe(true);
        expect(admit(b).resolve(event(b.account, 2))).toBe(true);
        await vi.advanceTimersByTimeAsync(0);

        const wrong = send(
            a,
            action({}, { self: { platform: 'qq', user_id: b.account }, echo: 'wrong' }),
        );
        await settle();
        expect(wrong.res.json()).toMatchObject({ retcode: 10102, echo: 'wrong' });
        const responseA = send(a, action({}, { self: { platform: 'qq', user_id: a.account } }));
        const responseB = send(b, action({}, { self: { platform: 'qq', user_id: b.account } }));
        await settle();
        expect(responseA.res.json()).toMatchObject({ status: 'ok', data: [event(a.account, 1)] });
        expect(responseB.res.json()).toMatchObject({ status: 'ok', data: [event(b.account, 2)] });

        const failed = admit(a);
        expect(failed.fail()).toBe(true);
        await settle();
        expect(pollOwnerStats(a.runtime)).toMatchObject({
            ordering_gap: true,
            ordering_reason: 'child_failed',
        });
        expect(pollOwnerStats(b.runtime)).toMatchObject({ ordering_gap: false });
        expect(admit(b).resolve(event(b.account, 3))).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        const unavailableA = send(a, action({}, { echo: 'a-gap' }));
        const stillB = send(b, action({}, { echo: 'b-ok' }));
        await settle();
        expect(unavailableA.res.json()).toMatchObject({ retcode: 20002, echo: 'a-gap' });
        expect(stillB.res.json()).toMatchObject({
            status: 'ok',
            data: [event(b.account, 3)],
            echo: 'b-ok',
        });
    });

    it('releases a reservation delivered after request abort without a false success', async () => {
        const f = fixture('10001');
        f.activate();
        const queued = event(f.account, 1);
        expect(admit(f).resolve(queued)).toBe(true);
        await vi.advanceTimersByTimeAsync(0);

        const resume = deferred<void>();
        const original = EventPollBuffer.prototype.reserve;
        const selectedStatuses: string[] = [];
        let delayed = false;
        vi.spyOn(EventPollBuffer.prototype, 'reserve').mockImplementation(function (
            this: EventPollBuffer,
            options?: PollOptions,
        ) {
            const result = original.call(this, options);

            if (delayed) {
                return result;
            }

            delayed = true;
            return result.then(async (value) => {
                selectedStatuses.push(value.status);
                await resume.promise;
                return value;
            });
        });
        const release = vi.spyOn(EventPollBuffer.prototype, 'release');
        const commit = vi.spyOn(EventPollBuffer.prototype, 'commit');
        const pending = send(f, action({}, { echo: 'abort' }));

        try {
            await settle();
            expect(selectedStatuses).toEqual(['reserved']);
            pending.req.emit('aborted');
            expect(pending.res.destroyed).toBe(true);
            expect(pending.res.bodies).toHaveLength(0);
            expect(commit).not.toHaveBeenCalled();
            resume.resolve(undefined);
            await settle();
            expect(release).toHaveBeenCalledTimes(1);
            expect(commit).not.toHaveBeenCalled();
            expect(f.state.outcomes).toContainEqual({ kind: 'aborted' });
            expect(pending.res.bodies).toHaveLength(0);

            const retry = send(f, action({}, { echo: 'retry' }));
            await settle();
            expect(retry.res.json()).toEqual({
                status: 'ok',
                retcode: 0,
                data: [queued],
                message: '',
                echo: 'retry',
            });
            expect(commit).toHaveBeenCalledTimes(1);
            expect(release).toHaveBeenCalledTimes(1);
        } finally {
            resume.resolve(undefined);
            await settle();
        }
    });

    it('aborts a pending poll on quiesce and records a later admitted child failure', async () => {
        const f = fixture('10001');
        f.activate();
        const child = admit(f);
        const waiting = send(f, action({ timeout: 1 }, { echo: 'shutdown' }));
        await settle();
        expect(waiting.res.bodies).toHaveLength(0);
        f.transport.quiesce();
        expect(waiting.res.destroyed).toBe(true);
        expect(child.fail()).toBe(true);
        await settle();
        expect(waiting.res.bodies).toHaveLength(0);
        expect(f.state.outcomes.some((outcome) => outcome.kind === 'local_finish')).toBe(false);
        expect(pollOwnerStats(f.runtime)).toMatchObject({
            ordering_gap: true,
            ordering_reason: 'child_failed',
        });
        expect(activateOrderedPollOwner(f.runtime).status).toBe('degraded');
    });

    it('records an unknown committed delivery after a synthetic end failure without replay', async () => {
        const f = fixture('10001');
        f.activate();
        expect(admit(f).resolve(event(f.account, 1))).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        const response = send(f, action({}, { echo: 'write-error' }), (_req, res) => {
            res.throwOnEnd = true;
        });
        await settle();
        expect(response.res.writes).toBe(1);
        expect(response.res.endAttempts).toBe(1);
        expect(response.res.destroyed).toBe(true);
        expect(response.res.bodies).toHaveLength(0);
        expect(f.state.outcomes).toContainEqual({ kind: 'unknown', committed: true });
        expect(pollOwnerStats(f.runtime)).toMatchObject({
            ordering_gap: true,
            ordering_reason: 'delivery_unknown',
        });
        expect(activateOrderedPollOwner(f.runtime).status).toBe('degraded');
        const retry = send(f, action({}, { echo: 'retry' }));
        await settle();
        expect(retry.res.json()).toMatchObject({ status: 'failed', retcode: 20002, echo: 'retry' });
        expect(retry.res.json().data).toBeNull();
    });
});
