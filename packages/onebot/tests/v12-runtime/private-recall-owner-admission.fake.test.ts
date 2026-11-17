import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import workerThreads from 'node:worker_threads';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '../../src/types';
import type {
    EventPollBuffer as BufferInstance,
    GuardedPollResult,
    GuardedSelection,
} from '../../src/v12-runtime/event-poll-buffer';
import type { PollOwner } from '../../src/v12-runtime/poll-owner';
import type { PollSink } from '../../src/v12-runtime/poll-transaction';
import type { V12Source } from '../../src/v12-runtime/source-ticket';

// Synthetic in-memory owner and authentic local proof only: no real runtime,
// account, plugin, transport, QQ process, socket, native addon or child process.
vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();
    return { ...actual, randomUUID: () => '22222222-2222-4222-8222-222222222222' };
});
vi.mock('@snowluma/sqlite', () => {
    throw new Error('SQLite is outside this in-memory fixture');
});
vi.mock('@snowluma/websocket', () => {
    throw new Error('WebSocket is outside this in-memory fixture');
});

let ownerApi: typeof import('../../src/v12-runtime/poll-owner');
let bufferApi: typeof import('../../src/v12-runtime/event-poll-buffer');
let ticketApi: typeof import('../../src/v12-runtime/source-ticket');
let recallApi: typeof import('../../src/v12-runtime/private-recall-source');
let effects: Array<{ mock: { calls: unknown[] } }> = [];
let maxEventBytesOverride: number | undefined;
const createdQueues: BufferInstance[] = [];
const owners: PollOwner[] = [];

function forbidden(): never {
    throw new Error('unexpected network, native or child-process operation in owner fixture');
}

beforeEach(async () => {
    vi.useFakeTimers();
    maxEventBytesOverride = undefined;
    const fetchGuard = vi.fn(forbidden);
    const webSocketGuard = vi.fn(function ForbiddenWebSocket() {
        return forbidden();
    });
    const eventSourceGuard = vi.fn(function ForbiddenEventSource() {
        return forbidden();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    vi.stubGlobal('EventSource', eventSourceGuard);
    effects = [
        fetchGuard,
        webSocketGuard,
        eventSourceGuard,
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
                effects.push(vi.spyOn(methods, method).mockImplementation(forbidden));
            }
        }
    }

    syncBuiltinESMExports();
    ticketApi = await import('../../src/v12-runtime/source-ticket');
    recallApi = await import('../../src/v12-runtime/private-recall-source');
    bufferApi = await import('../../src/v12-runtime/event-poll-buffer');
    const originalScoped = bufferApi.EventPollBuffer.scoped;
    vi.spyOn(bufferApi.EventPollBuffer, 'scoped').mockImplementation((config, policy, scope) => {
        // Optional smaller budget exercises a real oversize result, not a fake result.
        const actualConfig =
            maxEventBytesOverride === undefined
                ? config
                : { ...config, maxEventBytes: maxEventBytesOverride };
        const queue = originalScoped(actualConfig, policy, scope);
        createdQueues.push(queue);
        return queue;
    });
    ownerApi = await import('../../src/v12-runtime/poll-owner');
});

async function flush(): Promise<void> {
    for (let i = 0; i < 80; i++) {
        await Promise.resolve();
    }
}

afterEach(async () => {
    let cleanupFailed = false;

    for (const owner of owners.splice(0)) {
        try {
            owner.invalidate();
        } catch {
            cleanupFailed = true;
        }
    }

    await flush();

    for (const queue of createdQueues.splice(0)) {
        try {
            if (!queue.stats().closed) {
                queue.close();
            }
        } catch {
            cleanupFailed = true;
        }
    }

    await flush();
    const calls = effects.map((effect) => effect.mock.calls.length);
    const timers = vi.getTimerCount();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    effects = [];
    expect(cleanupFailed).toBe(false);
    expect(calls).toEqual(calls.map(() => 0));
    expect(timers).toBe(0);
});

function required<T>(value: T | null | undefined, label: string): T {
    if (value === null || value === undefined) {
        throw new Error(`synthetic ${label} missing`);
    }

    return value;
}

const SELF = 10001;
const PEER = 20002;
type RawRecall = Extract<QQEventVariant, { kind: 'friend_recall' }>;

/** The host is only a local lifecycle fake; owner, gate, queue and tickets are real. */
function fixture() {
    const runtime = {};
    const binding = {};
    const self = Object.freeze({ platform: 'qq', user_id: String(SELF) });
    const generation = new ticketApi.SourceGeneration();
    generation.setOnline(true);
    const gate = ownerApi.createPollGate();
    let nextVerifyAction: (() => void) | undefined;
    const host = {
        self,
        captureBinding: vi.fn(() => binding),
        captureSource: vi.fn(() => generation.capture(binding)),
        verify: vi.fn((source: V12Source | undefined) => {
            const action = nextVerifyAction;
            nextVerifyAction = undefined;
            action?.();
            return generation.isCurrent(source, binding);
        }),
    };
    ownerApi.registerPollHost(runtime, host, gate);

    function activate() {
        const before = createdQueues.length;
        const result = ownerApi.activateHttpPollOwner(runtime);

        if (result.status !== 'ready') {
            throw new Error(`synthetic HTTP owner not ready: ${result.status}`);
        }

        const queue = required(createdQueues[before], 'real scoped queue');
        const ownerTicket = required(host.captureSource.mock.results.at(-1)?.value, 'owner ticket');
        owners.push(result.owner);
        return { owner: result.owner, queue, ownerTicket };
    }

    const first = activate();
    return {
        runtime,
        binding,
        self,
        generation,
        gate,
        host,
        ...first,
        activate,
        onNextVerify: (action: () => void) => {
            nextVerifyAction = action;
        },
    };
}

type Fixture = ReturnType<typeof fixture>;

function makeRecall(f: Fixture, account = SELF) {
    const eventTicket = required(f.generation.capture(f.binding), 'event ticket');
    const self =
        account === SELF ? f.self : Object.freeze({ platform: 'qq', user_id: String(account) });
    const context = { uin: String(account), selfId: account };
    const raw: RawRecall = {
        kind: 'friend_recall',
        selfUin: account,
        userUin: PEER,
        msgSeq: 445,
        clientSeq: 446,
        time: 100,
        recalledBySelf: false,
    };
    const event: JsonObject = {
        time: 100,
        self_id: account,
        post_type: 'notice',
        notice_type: 'friend_recall',
        user_id: PEER,
        message_id: -42,
    };
    const snapshot = required(
        recallApi.capturePrivateRecallSource(context, raw, eventTicket),
        'snapshot',
    );

    if (!recallApi.rememberPrivateRecallSource(context, event, snapshot, -42)) {
        throw new Error('synthetic provenance not remembered');
    }

    const source = required(recallApi.getPrivateRecallSource(context, event), 'provenance');
    const candidate = required(
        recallApi.convertPrivateRecallEvent(event, self, source),
        'candidate',
    );
    const proof = required(
        recallApi.createPrivateRecallPollProof(event, source, eventTicket, self, candidate),
        'proof',
    );
    return { eventTicket, self, context, raw, event, snapshot, source, candidate, proof };
}

class MemorySink extends EventEmitter implements PollSink {
    headCalls = 0;
    endCalls = 0;
    body: string | undefined;

    isOpen(): boolean {
        return true;
    }

    writeHead(): void {
        this.headCalls++;
    }

    end(body: string): void {
        this.endCalls++;
        this.body = body;
        this.emit('finish');
    }
}

function startPoll(owner: PollOwner, limit = 0) {
    const sink = new MemorySink();
    const run = owner.start(
        {
            limit,
            timeoutMs: 0,
            maxOutputBytes: 1024 * 1024,
            responseDeadline: performance.now() + 1000,
            echo: 'synthetic-echo-😺',
        },
        sink,
        () => true,
    );
    return { sink, ...run };
}

function isSelection(result: GuardedPollResult): result is GuardedSelection {
    return result.status === 'reserved' || result.status === 'blocked_guarded';
}

/** Hold the real fulfilled selection, retaining the exact token and object. */
function holdFirstSelection(queue: BufferInstance) {
    const original = queue.reserveGuarded.bind(queue);
    let first = true;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
        resume = resolve;
    });
    const state: { selection?: GuardedSelection } = {};
    vi.spyOn(queue, 'reserveGuarded').mockImplementation((options) => {
        const result = original(options);

        if (!first) {
            return result;
        }

        first = false;
        return result.then(async (selection) => {
            if (isSelection(selection)) {
                state.selection = selection;
                await gate;
            }

            return selection;
        });
    });
    return { state, resume };
}

function isUnavailableOrInvalid(result: string): boolean {
    return result === 'unavailable' || result === 'invalid';
}

describe('private recall admission to the real scoped HTTP owner', () => {
    it('admits the exact real proof under a different ticket from the same owner epoch', async () => {
        const f = fixture();
        const value = makeRecall(f);
        expect(value.eventTicket).not.toBe(f.ownerTicket);
        expect(ticketApi.sameSourceEpoch(value.eventTicket, f.ownerTicket)).toBe('same');
        expect(recallApi.isPrivateRecallPollProofFor(value.proof, value.candidate)).toBe(true);
        const enqueue = vi.spyOn(f.queue, 'enqueueScopedRecall');
        const guard = vi.fn(() => true);
        expect(
            ownerApi.enqueuePrivateRecallPollEvent(
                f.runtime,
                f.owner,
                value.candidate,
                value.proof,
                value.eventTicket,
                guard,
            ),
        ).toBe('accepted');
        expect(guard).toHaveBeenCalled();
        expect(enqueue).toHaveBeenCalledOnce();
        expect(enqueue.mock.calls[0]![0]).toBe(value.candidate);
        expect(enqueue.mock.calls[0]![1]).toBe(value.proof);
        expect(enqueue.mock.calls[0]![2]).toBe(value.eventTicket);
        expect(f.queue.stats()).toMatchObject({ count: 1, reserved: 0 });
        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
            accepted: 1,
            cleanup_uncertain: false,
        });

        const poll = startPoll(f.owner);
        expect(await poll.result).toEqual({ kind: 'local_finish', response: 'events' });
        expect(poll.sink.headCalls).toBe(1);
        expect(poll.sink.endCalls).toBe(1);
        expect(JSON.parse(poll.sink.body!)).toEqual({
            status: 'ok',
            retcode: 0,
            data: [value.candidate],
            message: '',
            echo: 'synthetic-echo-😺',
        });
        expect(f.queue.stats()).toMatchObject({ count: 0, reserved: 0 });
        expect(f.gate.uncertain).toBe(false);
    });

    it('rejects equal clones, a different exact event ticket and a different account', () => {
        const f = fixture();
        const value = makeRecall(f);
        const anotherTicket = required(f.generation.capture(f.binding), 'equal-epoch ticket');
        expect(anotherTicket).not.toBe(value.eventTicket);
        expect(ticketApi.sameSourceEpoch(anotherTicket, value.eventTicket)).toBe('same');
        const clonedEvent = { ...value.event };
        const clonedSelf = { ...value.self };
        const clonedCandidate = { ...value.candidate };
        const clonedCandidateSelf = { ...value.candidate, self: { ...value.candidate.self } };
        expect(clonedEvent).toEqual(value.event);
        expect(clonedSelf).toEqual(value.self);
        expect(clonedCandidate).toEqual(value.candidate);
        expect(clonedCandidateSelf).toEqual(value.candidate);
        expect(
            recallApi.createPrivateRecallPollProof(
                clonedEvent,
                value.source,
                value.eventTicket,
                value.self,
                value.candidate,
            ),
        ).toBeUndefined();
        expect(
            recallApi.createPrivateRecallPollProof(
                value.event,
                value.source,
                value.eventTicket,
                clonedSelf,
                value.candidate,
            ),
        ).toBeUndefined();

        for (const [candidate, source] of [
            [value.candidate, anotherTicket],
            [clonedCandidate, value.eventTicket],
            [clonedCandidateSelf, value.eventTicket],
        ] as const) {
            expect(
                ownerApi.enqueuePrivateRecallPollEvent(
                    f.runtime,
                    f.owner,
                    candidate,
                    value.proof,
                    source,
                    () => true,
                ),
            ).toBe('invalid');
            expect(f.queue.stats()).toMatchObject({ count: 0, reserved: 0 });
        }

        const wrongAccount = makeRecall(f, SELF + 1);
        expect(
            recallApi.isPrivateRecallPollProofFor(wrongAccount.proof, wrongAccount.candidate),
        ).toBe(true);
        expect(
            ownerApi.enqueuePrivateRecallPollEvent(
                f.runtime,
                f.owner,
                wrongAccount.candidate,
                wrongAccount.proof,
                wrongAccount.eventTicket,
                () => true,
            ),
        ).toBe('invalid');
        expect(f.queue.stats()).toMatchObject({ count: 0, reserved: 0 });
        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
            accepted: 0,
            cleanup_uncertain: false,
        });
        expect(f.gate.uncertain).toBe(false);
    });

    it('does not place an old facade or old epoch into a replacement owner queue', async () => {
        const f = fixture();
        const old = makeRecall(f);
        f.generation.setOnline(false);
        f.owner.invalidate();
        await flush();
        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
            active: false,
            cleanup_pending: false,
        });
        f.generation.setOnline(true);
        const replacement = f.activate();
        expect(replacement.owner).not.toBe(f.owner);
        expect(ticketApi.sameSourceEpoch(old.eventTicket, replacement.ownerTicket)).toBe(
            'different',
        );
        const fresh = makeRecall(f);

        expect(
            ownerApi.enqueuePrivateRecallPollEvent(
                f.runtime,
                f.owner,
                old.candidate,
                old.proof,
                old.eventTicket,
                () => true,
            ),
        ).toBe('unavailable');
        expect(
            isUnavailableOrInvalid(
                ownerApi.enqueuePrivateRecallPollEvent(
                    f.runtime,
                    replacement.owner,
                    old.candidate,
                    old.proof,
                    old.eventTicket,
                    () => true,
                ),
            ),
        ).toBe(true);
        expect(replacement.queue.stats()).toMatchObject({ count: 0, reserved: 0 });
        expect(
            ownerApi.enqueuePrivateRecallPollEvent(
                f.runtime,
                replacement.owner,
                fresh.candidate,
                fresh.proof,
                fresh.eventTicket,
                () => true,
            ),
        ).toBe('accepted');
        expect(replacement.queue.stats()).toMatchObject({ count: 1, reserved: 0 });
        expect(f.gate.uncertain).toBe(false);
    });

    it('rejects proof invalidation caused by a reentrant host verifier before enqueue', () => {
        const f = fixture();
        const value = makeRecall(f);
        let mutated = false;
        f.onNextVerify(() => {
            mutated = true;
            value.event.message_id = -43;
        });
        expect(
            ownerApi.enqueuePrivateRecallPollEvent(
                f.runtime,
                f.owner,
                value.candidate,
                value.proof,
                value.eventTicket,
                () => true,
            ),
        ).toBe('invalid');
        expect(mutated).toBe(true);
        expect(recallApi.isPrivateRecallPollProofCurrent(value.proof)).toBe(false);
        expect(f.queue.stats()).toMatchObject({ count: 0, reserved: 0 });
        expect(f.gate.uncertain).toBe(false);
    });

    it.each(['guard', 'verify'] as const)(
        'keeps a successor queue clean when %s reenters lifecycle retirement',
        async (where) => {
            const f = fixture();
            const value = makeRecall(f);
            const enqueue = vi.spyOn(f.queue, 'enqueueScopedRecall');
            let triggered = false;
            let reentrantStatus: string | undefined;

            const rotate = () => {
                triggered = true;
                f.generation.setOnline(false);
                f.owner.invalidate();
                f.generation.setOnline(true);
                reentrantStatus = ownerApi.activateHttpPollOwner(f.runtime).status;
            };

            if (where === 'verify') {
                f.onNextVerify(rotate);
            }

            const guard = vi.fn(() => {
                if (where === 'guard') {
                    rotate();
                }

                return f.generation.isCurrent(value.eventTicket, f.binding);
            });
            expect(
                isUnavailableOrInvalid(
                    ownerApi.enqueuePrivateRecallPollEvent(
                        f.runtime,
                        f.owner,
                        value.candidate,
                        value.proof,
                        value.eventTicket,
                        guard,
                    ),
                ),
            ).toBe(true);
            expect(triggered).toBe(true);
            expect(reentrantStatus).not.toBe('ready');
            expect(enqueue).not.toHaveBeenCalled();
            await flush();
            const replacement = f.activate();
            expect(replacement.owner).not.toBe(f.owner);
            expect(replacement.queue.stats()).toMatchObject({ count: 0, reserved: 0 });
            expect(f.gate.uncertain).toBe(false);
        },
    );

    it.each(['verify', 'captureBinding'] as const)(
        'rejects the second listener sample when %s reentrantly revokes readiness',
        (where) => {
            const f = fixture();
            const value = makeRecall(f);
            const enqueue = vi.spyOn(f.queue, 'enqueueScopedRecall');
            let ready = true;
            let armed = false;
            let changed = false;

            const revokeAfterFirstGuard = () => {
                if (armed && !changed) {
                    changed = true;
                    ready = false;
                }
            };

            if (where === 'verify') {
                f.host.verify.mockImplementation((source) => {
                    revokeAfterFirstGuard();
                    return f.generation.isCurrent(source, f.binding);
                });
            } else {
                f.host.captureBinding.mockImplementation(() => {
                    revokeAfterFirstGuard();
                    return f.binding;
                });
            }

            const guard = vi.fn(() => {
                const observed = ready;

                if (observed) {
                    armed = true;
                }

                return observed;
            });
            expect(
                ownerApi.enqueuePrivateRecallPollEvent(
                    f.runtime,
                    f.owner,
                    value.candidate,
                    value.proof,
                    value.eventTicket,
                    guard,
                ),
            ).toBe('unavailable');
            expect(armed).toBe(true);
            expect(changed).toBe(true);
            expect(guard).toHaveBeenCalledTimes(2);
            expect(guard.mock.results.map((result) => result.value)).toEqual([true, false]);
            expect(f.generation.isCurrent(value.eventTicket, f.binding)).toBe(true);
            expect(f.host.captureBinding()).toBe(f.binding);
            expect(recallApi.isPrivateRecallPollProofCurrent(value.proof)).toBe(true);
            expect(enqueue).not.toHaveBeenCalled();
            expect(f.queue.stats()).toMatchObject({ count: 0, reserved: 0 });
            expect(f.gate.uncertain).toBe(false);
            expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
                active: true,
                accepted: 0,
                cleanup_uncertain: false,
            });
        },
    );

    it.each(['closed', 'uncertain'] as const)(
        'retires and sticks the gate when preflight reports %s with an active scope',
        async (reported) => {
            const f = fixture();
            const value = makeRecall(f);
            const factory = vi.mocked(bufferApi.EventPollBuffer.scoped);
            const scope = required(factory.mock.calls.at(-1)?.[2], 'owner scope');
            expect(recallApi.isPrivateRecallPollEpochAccountScopeActive(scope)).toBe(true);
            expect(f.queue.guardedCleanupState()).toBe('open');
            const cleanupState = vi
                .spyOn(f.queue, 'guardedCleanupState')
                .mockReturnValueOnce(reported);
            const enqueue = vi.spyOn(f.queue, 'enqueueScopedRecall');
            const close = vi.spyOn(f.queue, 'close');
            const guard = vi.fn(() => true);
            expect(
                ownerApi.enqueuePrivateRecallPollEvent(
                    f.runtime,
                    f.owner,
                    value.candidate,
                    value.proof,
                    value.eventTicket,
                    guard,
                ),
            ).toBe('unavailable');
            expect(cleanupState).toHaveBeenCalled();
            expect(cleanupState.mock.results[0]!.value).toBe(reported);
            expect(enqueue).not.toHaveBeenCalled();
            expect(guard).not.toHaveBeenCalled();
            expect(f.gate.uncertain).toBe(true);
            await flush();
            expect(close).toHaveBeenCalledOnce();
            expect(f.queue.stats()).toMatchObject({ count: 0, closed: true });
            expect(recallApi.isPrivateRecallPollEpochAccountScopeActive(scope)).toBe(false);
            expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
                active: false,
                cleanup_uncertain: true,
            });
            expect(ownerApi.activateHttpPollOwner(f.runtime).status).toBe('cleanup_pending');
        },
    );

    it.each(['uncertain', 'closed'] as const)(
        'quarantines a %s preflight before checking a proof invalidated by that probe',
        async (reported) => {
            const unrelated = fixture();
            const f = fixture();
            const value = makeRecall(f);
            const factory = vi.mocked(bufferApi.EventPollBuffer.scoped);
            const scope = required(factory.mock.calls.at(-1)?.[2], 'owner scope');
            expect(recallApi.isPrivateRecallPollEpochAccountScopeActive(scope)).toBe(true);
            expect(f.queue.guardedCleanupState()).toBe('open');
            let scopeActiveDuringProbe = false;
            let proofInvalidatedDuringProbe = false;
            const cleanupState = vi
                .spyOn(f.queue, 'guardedCleanupState')
                .mockImplementationOnce(() => {
                    scopeActiveDuringProbe =
                        recallApi.isPrivateRecallPollEpochAccountScopeActive(scope);
                    value.event.message_id = -43;
                    proofInvalidatedDuringProbe = !recallApi.isPrivateRecallPollProofCurrent(
                        value.proof,
                    );
                    return reported;
                });
            const enqueue = vi.spyOn(f.queue, 'enqueueScopedRecall');
            const close = vi.spyOn(f.queue, 'close');
            const guard = vi.fn(() => true);
            expect(
                ownerApi.enqueuePrivateRecallPollEvent(
                    f.runtime,
                    f.owner,
                    value.candidate,
                    value.proof,
                    value.eventTicket,
                    guard,
                ),
            ).toBe('unavailable');
            expect(cleanupState.mock.results[0]!.value).toBe(reported);
            expect(scopeActiveDuringProbe).toBe(true);
            expect(proofInvalidatedDuringProbe).toBe(true);
            expect(enqueue).not.toHaveBeenCalled();
            expect(guard).not.toHaveBeenCalled();
            expect(f.gate.uncertain).toBe(true);
            expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
                invalid: 0,
                accepted: 0,
                cleanup_uncertain: true,
            });
            await flush();
            expect(close).toHaveBeenCalledOnce();
            expect(f.queue.stats()).toMatchObject({ count: 0, closed: true });
            expect(recallApi.isPrivateRecallPollEpochAccountScopeActive(scope)).toBe(false);
            expect(ownerApi.activateHttpPollOwner(f.runtime).status).toBe('cleanup_pending');

            // The quarantined owner cannot affect a separately gated owner.
            const other = makeRecall(unrelated);
            expect(
                ownerApi.enqueuePrivateRecallPollEvent(
                    unrelated.runtime,
                    unrelated.owner,
                    other.candidate,
                    other.proof,
                    other.eventTicket,
                    () => true,
                ),
            ).toBe('accepted');
            expect(unrelated.queue.stats()).toMatchObject({ count: 1, reserved: 0 });
            expect(unrelated.gate.uncertain).toBe(false);
        },
    );

    it('makes an observed post-publication throw sticky and never automatically retries', async () => {
        const f = fixture();
        const value = makeRecall(f);
        const original = f.queue.enqueueScopedRecall.bind(f.queue);
        let observedCount: number | undefined;
        const enqueue = vi
            .spyOn(f.queue, 'enqueueScopedRecall')
            .mockImplementation((candidate, proof, source) => {
                const result = original(candidate, proof, source);

                if (result === 'accepted') {
                    observedCount = f.queue.stats().count;
                    throw new Error('synthetic throw after real queue publication');
                }

                return result;
            });
        expect(
            ownerApi.enqueuePrivateRecallPollEvent(
                f.runtime,
                f.owner,
                value.candidate,
                value.proof,
                value.eventTicket,
                () => true,
            ),
        ).toBe('uncertain');
        expect(observedCount).toBe(1);
        expect(enqueue).toHaveBeenCalledOnce();
        expect(f.gate.uncertain).toBe(true);
        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({ cleanup_uncertain: true });
        await flush();
        const retry = ownerApi.enqueuePrivateRecallPollEvent(
            f.runtime,
            f.owner,
            value.candidate,
            value.proof,
            value.eventTicket,
            () => true,
        );
        expect(retry).not.toBe('accepted');
        expect(enqueue).toHaveBeenCalledOnce();
        expect(ownerApi.activateHttpPollOwner(f.runtime).status).toBe('cleanup_pending');
    });

    it('returns full for a real protected capacity prefix without making the gate uncertain', async () => {
        const f = fixture();

        for (let i = 0; i < 128; i++) {
            expect(f.queue.enqueue({ type: 'message', id: `ordinary-${i}`, time: i })).toBe(
                'accepted',
            );
        }

        const held = holdFirstSelection(f.queue);
        const poll = startPoll(f.owner);
        const value = makeRecall(f);
        const enqueue = vi.spyOn(f.queue, 'enqueueScopedRecall');

        try {
            await flush();
            const selection = required(held.state.selection, 'protected prefix');
            expect(selection.status).toBe('reserved');
            expect(f.queue.stats()).toMatchObject({ count: 128, reserved: 128 });
            expect(
                ownerApi.enqueuePrivateRecallPollEvent(
                    f.runtime,
                    f.owner,
                    value.candidate,
                    value.proof,
                    value.eventTicket,
                    () => true,
                ),
            ).toBe('full');
            expect(enqueue).toHaveBeenCalledOnce();
            expect(enqueue.mock.results[0]!.value).toBe('full');
            expect(f.queue.stats()).toMatchObject({ count: 128, reserved: 128 });
            expect(f.gate.uncertain).toBe(false);
            expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
                full: 1,
                cleanup_uncertain: false,
            });
        } finally {
            poll.cancel();
            held.resume();
            await poll.result;
        }
    });

    it('returns a real oversize result without quarantining the owner', () => {
        // The production owner's normal 64 KiB event bound easily fits this
        // fixed recall shape. Shrink only this real fixture queue's budget.
        maxEventBytesOverride = 48;
        const f = fixture();
        const value = makeRecall(f);
        const enqueue = vi.spyOn(f.queue, 'enqueueScopedRecall');
        expect(
            ownerApi.enqueuePrivateRecallPollEvent(
                f.runtime,
                f.owner,
                value.candidate,
                value.proof,
                value.eventTicket,
                () => true,
            ),
        ).toBe('oversize');
        expect(enqueue).toHaveBeenCalledOnce();
        expect(enqueue.mock.results[0]!.value).toBe('oversize');
        expect(f.queue.stats()).toMatchObject({ count: 0, reserved: 0 });
        expect(f.gate.uncertain).toBe(false);
        expect(ownerApi.pollOwnerStats(f.runtime)).toMatchObject({
            too_large: 1,
            cleanup_uncertain: false,
        });
    });
});
