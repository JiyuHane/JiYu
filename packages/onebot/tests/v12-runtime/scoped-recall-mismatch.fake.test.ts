import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    EventPollBuffer as BufferInstance,
    PollBufferConfig,
} from '../../src/v12-runtime/event-poll-buffer';

// Explicit fault injection, not a real-proof integration fixture. In the trusted
// implementation an admitted, still-current real proof cannot independently
// change its stored scope binding this way. These isolated maps deliberately
// make that otherwise unreachable combination observable to the real queue.
const injected = vi.hoisted(() => {
    type ProofState = {
        candidate: object;
        ticket: object;
        scope: object;
        current: boolean;
        inScope: boolean;
    };
    const scopes = new Map<object, boolean>();
    const proofs = new Map<object, ProofState>();
    const lookup = (proof: unknown) =>
        typeof proof === 'object' && proof !== null ? proofs.get(proof) : undefined;
    return {
        scopes,
        proofs,
        scopeActive: vi.fn((scope: unknown) =>
            typeof scope === 'object' && scope !== null ? scopes.get(scope) === true : false,
        ),
        proofFor: vi.fn((proof: unknown, candidate: unknown) => {
            const state = lookup(proof);
            return state !== undefined && state.current && state.candidate === candidate;
        }),
        proofCurrent: vi.fn((proof: unknown) => lookup(proof)?.current === true),
        proofInScope: vi.fn((proof: unknown, ticket: unknown, scope: unknown) => {
            const state = lookup(proof);
            return (
                state !== undefined &&
                state.current &&
                state.inScope &&
                state.ticket === ticket &&
                state.scope === scope &&
                scopes.get(state.scope) === true
            );
        }),
    };
});

// No real provenance or scope implementation is loaded into this file. Every
// predicate is a pure map read; the test changes only the synthetic map state.
vi.mock('../../src/v12-runtime/private-recall-source', () => ({
    isPrivateRecallPollEpochAccountScopeActive: injected.scopeActive,
    isPrivateRecallPollProofFor: injected.proofFor,
    isPrivateRecallPollProofCurrent: injected.proofCurrent,
    isPrivateRecallPollProofInEpochAccountScope: injected.proofInScope,
}));
vi.mock('@snowluma/sqlite', () => {
    throw new Error('SQLite is outside this synthetic queue fixture');
});
vi.mock('@snowluma/websocket', () => {
    throw new Error('WebSocket is outside this synthetic queue fixture');
});

let EventPollBuffer: typeof import('../../src/v12-runtime/event-poll-buffer').EventPollBuffer;
let guards: Array<{ mock: { calls: unknown[] } }> = [];
const buffers: BufferInstance[] = [];

function forbidden(): never {
    throw new Error('unexpected network, native or child-process operation in synthetic fixture');
}

beforeEach(async () => {
    vi.useFakeTimers();
    buffers.length = 0;
    injected.scopes.clear();
    injected.proofs.clear();
    injected.scopeActive.mockClear();
    injected.proofFor.mockClear();
    injected.proofCurrent.mockClear();
    injected.proofInScope.mockClear();
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
    guards = [
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
        vi.spyOn(process, 'dlopen').mockImplementation(forbidden),
    ];
    // Also guard named built-in exports before loading the real queue module.
    syncBuiltinESMExports();
    ({ EventPollBuffer } = await import('../../src/v12-runtime/event-poll-buffer'));
});

afterEach(() => {
    for (const q of buffers) {
        q.close();
    }

    const calls = guards.map((guard) => guard.mock.calls.length);
    const timers = vi.getTimerCount();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    guards = [];
    expect(calls).toEqual(calls.map(() => 0));
    expect(timers).toBe(0);
});

const config: PollBufferConfig = {
    capacity: 8,
    maxQueueBytes: 8192,
    maxEventBytes: 4096,
    maxWaiters: 4,
    maxTimeoutMs: 1000,
};
type PollResult = Awaited<ReturnType<BufferInstance['reserveGuarded']>>;
type Reserved = Extract<PollResult, { status: 'reserved' }>;

function hiddenHandle(marker: string): object {
    const handle = Object.create(null) as object;
    Object.defineProperty(handle, 'syntheticMarker', { value: marker });
    return Object.freeze(handle);
}

function makeScope() {
    const scope = hiddenHandle('INJECTED_SCOPE_SECRET');
    injected.scopes.set(scope, true);
    return scope;
}

function makeRecall(scope: object, suffix: string) {
    const proof = hiddenHandle(`INJECTED_PROOF_SECRET_${suffix}`);
    const ticket = hiddenHandle(`INJECTED_TICKET_SECRET_${suffix}`);
    const candidate = Object.freeze({
        id: `event-${suffix}`,
        time: 1_700_000_100,
        type: 'notice',
        detail_type: 'private_message_delete',
        sub_type: '',
        self: Object.freeze({ platform: 'qq', user_id: '10001' }),
        message_id: `-${suffix}`,
        user_id: '20002',
    });
    const state = { candidate, ticket, scope, current: true, inScope: true };
    injected.proofs.set(proof, state);
    return { candidate, proof, ticket, state };
}

function ordinary(id: string, text = '') {
    return { type: 'message', id, text, time: 1_700_000_100 };
}

function bytes(value: unknown[]): number {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function scoped(scope: object): BufferInstance {
    const q = EventPollBuffer.scoped(config, 'reject-new', scope);
    buffers.push(q);
    return q;
}

function reserved(result: PollResult): Reserved {
    if (result.status !== 'reserved') {
        throw new Error(`expected synthetic reservation, got ${result.status}`);
    }

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.token)).toBe(true);
    expect(result.bytes).toBe(Buffer.byteLength(result.eventsJson, 'utf8'));
    return result;
}

function clearProofCalls(): void {
    injected.proofFor.mockClear();
    injected.proofCurrent.mockClear();
    injected.proofInScope.mockClear();
}

describe('scoped queue classification with explicitly mocked proof faults', () => {
    it.each(['stale-first', 'mismatch-first'] as const)(
        'quarantines the entire reserved batch without partial prune: %s',
        async (order) => {
            const scope = makeScope();
            const q = scoped(scope);
            const r1 = makeRecall(scope, '1');
            const r2 = makeRecall(scope, '2');
            const first = ordinary('A', '雪');
            const tail = ordinary('tail', '😀');
            const all = [first, r1.candidate, r2.candidate, tail];
            expect(q.enqueue(first)).toBe('accepted');
            expect(q.enqueueScopedRecall(r1.candidate, r1.proof, r1.ticket)).toBe('accepted');
            expect(q.enqueueScopedRecall(r2.candidate, r2.proof, r2.ticket)).toBe('accepted');
            expect(q.enqueue(tail)).toBe('accepted');

            const full = reserved(await q.reserveGuarded());
            expect(full.eventsJson).toBe(JSON.stringify(all));
            expect(full.bytes).toBe(bytes(all));
            const release = q.releaseGuardedNoDrain(full.token);
            expect(release).toEqual({ status: 'released' });
            expect(Object.isFrozen(release)).toBe(true);
            expect(q.resumeGuardedDrain(release)).toEqual({ status: 'resumed' });
            const selection = reserved(await q.reserveGuarded({ limit: 3 }));
            expect(selection.eventsJson).toBe(JSON.stringify(all.slice(0, 3)));
            expect(selection.count).toBe(3);
            expect(selection.bytes).toBe(bytes(all.slice(0, 3)));
            const before = q.stats();
            expect(before).toMatchObject({ count: 4, reserved: 3, queueBytes: bytes(all) });

            const stale = order === 'stale-first' ? r1 : r2;
            const mismatch = order === 'stale-first' ? r2 : r1;
            stale.state.current = false;
            mismatch.state.current = true;
            mismatch.state.inScope = false;
            clearProofCalls();
            expect(q.commitGuardedNoDrain(selection.token, selection)).toEqual({
                status: 'uncertain',
            });
            expect(injected.proofCurrent).toHaveBeenCalledWith(stale.proof);
            expect(injected.proofCurrent).toHaveBeenCalledWith(mismatch.proof);
            expect(injected.proofInScope).toHaveBeenCalledWith(
                mismatch.proof,
                mismatch.ticket,
                scope,
            );
            expect(q.stats()).toEqual(before);
            expect(q.oldestDropCount()).toBe(0n);
            expect(selection.eventsJson).toBe(JSON.stringify(all.slice(0, 3)));
            expect(full.eventsJson).toBe(JSON.stringify(all));

            // Once quarantined, public reserve is unavailable for a fresh view.
            // The old full snapshot and unchanged metrics do not by themselves
            // establish the inaccessible post-quarantine internal entry order.
            clearProofCalls();
            expect(await q.reserveGuarded()).toEqual({ status: 'uncertain' });
            expect(q.enqueue(ordinary('must-not-enter'))).toBe('uncertain');
            expect(q.enqueueScopedRecall(r2.candidate, r2.proof, r2.ticket)).toBe('uncertain');
            expect(q.releaseGuardedNoDrain(selection.token)).toEqual({ status: 'uncertain' });
            expect(injected.proofFor).not.toHaveBeenCalled();
            expect(injected.proofCurrent).not.toHaveBeenCalled();
            expect(injected.proofInScope).not.toHaveBeenCalled();
            expect(q.stats()).toEqual(before);
            expect(q.close()).toBe(true);
            expect(q.stats()).toMatchObject({ count: 0, queueBytes: 2, reserved: 0, closed: true });
            expect(await q.reserveGuarded()).toEqual({ status: 'closed' });
            expect(q.commitGuardedNoDrain(selection.token, selection)).toEqual({ status: 'stale' });
        },
    );

    it('short-circuits a retired injected scope before proof checks, permits release but not resume', async () => {
        const scope = makeScope();
        const q = scoped(scope);
        const recall = makeRecall(scope, '9');
        const first = ordinary('A', '雪😀');
        expect(q.enqueue(first)).toBe('accepted');
        expect(q.enqueueScopedRecall(recall.candidate, recall.proof, recall.ticket)).toBe(
            'accepted',
        );
        const selection = reserved(await q.reserveGuarded());
        const before = q.stats();
        expect(selection.eventsJson).toBe(JSON.stringify([first, recall.candidate]));
        expect(selection.bytes).toBe(bytes([first, recall.candidate]));

        // Hidden sentinel properties are present only on synthetic handles; none
        // may appear in the event JSON, receipt or reservation token serialization.
        for (const handle of [scope, recall.proof, recall.ticket, selection.token]) {
            expect(JSON.stringify(handle)).toBe('{}');
        }

        for (const marker of [
            'INJECTED_SCOPE_SECRET',
            'INJECTED_PROOF_SECRET_9',
            'INJECTED_TICKET_SECRET_9',
        ]) {
            expect(selection.eventsJson).not.toContain(marker);
            expect(JSON.stringify(q.stats())).not.toContain(marker);
        }

        clearProofCalls();
        injected.scopes.set(scope, false);
        expect(q.commitGuardedNoDrain(selection.token, selection)).toEqual({
            status: 'scope_revoked',
        });
        expect(q.stats()).toEqual(before);
        expect(injected.proofCurrent).not.toHaveBeenCalled();
        expect(injected.proofInScope).not.toHaveBeenCalled();
        expect(injected.proofFor).not.toHaveBeenCalled();
        const release = q.releaseGuardedNoDrain(selection.token);
        expect(release).toEqual({ status: 'released' });
        expect(Object.isFrozen(release)).toBe(true);
        expect(JSON.stringify(release)).toBe('{"status":"released"}');
        expect(q.stats()).toMatchObject({
            count: 2,
            reserved: 0,
            queueBytes: bytes([first, recall.candidate]),
        });
        expect(q.resumeGuardedDrain(release)).toEqual({ status: 'scope_revoked' });
        expect(await q.reserveGuarded()).toEqual({ status: 'scope_revoked' });
        expect(q.enqueue(ordinary('not-admitted'))).toBe('scope_revoked');
        expect(q.enqueueScopedRecall(recall.candidate, recall.proof, recall.ticket)).toBe(
            'scope_revoked',
        );
        expect(injected.proofCurrent).not.toHaveBeenCalled();
        expect(injected.proofInScope).not.toHaveBeenCalled();
        expect(injected.proofFor).not.toHaveBeenCalled();
        expect(q.close()).toBe(true);
        expect(q.resumeGuardedDrain(release)).toEqual({ status: 'stale' });
        expect(q.stats()).toMatchObject({ count: 0, queueBytes: 2, reserved: 0, closed: true });
    });
});

describe('guarded configuration isolation with mocked scope predicates', () => {
    it.each(['scoped-mock', 'unscoped'] as const)(
        'uses original capacity, policy and waiter limits without reading replaceable properties: %s',
        async (mode) => {
            // The scoped branch uses the explicit predicate mock above; this is
            // a real queue regression, not a real-scope integration test.
            const scope = mode === 'scoped-mock' ? makeScope() : undefined;

            function build() {
                const original: PollBufferConfig = { ...config, capacity: 1, maxWaiters: 1 };
                const q = scope
                    ? EventPollBuffer.scoped(original, 'reject-new', scope)
                    : new EventPollBuffer(original, 'reject-new', 'guarded-recall');
                buffers.push(q);
                const configGetter = vi.fn(() => {
                    if (scope) {
                        injected.scopes.set(scope, false);
                    }

                    q.close();
                    throw new Error('replaceable config getter must not run');
                });
                const policyGetter = vi.fn(() => {
                    throw new Error('replaceable overflow policy getter must not run');
                });
                Object.defineProperty(q, 'config', { configurable: true, get: configGetter });
                Object.defineProperty(q, 'overflowPolicy', {
                    configurable: true,
                    get: policyGetter,
                });

                // Neither changing the caller's original object nor installing
                // these reentrant accessors changes the queue's fixed snapshot.
                original.capacity = 8;
                original.maxWaiters = 8;
                original.maxTimeoutMs = 1;
                original.maxEventBytes = 2;
                original.maxQueueBytes = 2;
                return { q, configGetter, policyGetter };
            }

            // A full queue and an empty waiter queue are independent scenarios:
            // the first waiting poll on an occupied queue would instead reserve.
            const fullCase = build();
            const first = ordinary('one', '雪😀');
            expect(fullCase.q.enqueue(first)).toBe('accepted');
            expect(fullCase.q.enqueue(ordinary('two'))).toBe('full');
            expect(fullCase.q.stats()).toMatchObject({
                count: 1,
                queueBytes: bytes([first]),
                waiters: 0,
                closed: false,
            });
            expect(fullCase.q.guardedCleanupState()).toBe('open');
            expect(fullCase.q.oldestDropCount()).toBe(0n);
            const selected = reserved(await fullCase.q.reserveGuarded());
            expect(selected.eventsJson).toBe(JSON.stringify([first]));
            expect(fullCase.configGetter).not.toHaveBeenCalled();
            expect(fullCase.policyGetter).not.toHaveBeenCalled();
            expect(fullCase.q.close()).toBe(true);
            expect(fullCase.configGetter).not.toHaveBeenCalled();
            expect(fullCase.policyGetter).not.toHaveBeenCalled();

            const waiterCase = build();
            const pending = waiterCase.q.reserveGuarded({ timeoutMs: 100 });
            expect(waiterCase.q.stats()).toMatchObject({ count: 0, waiters: 1, closed: false });
            expect(waiterCase.q.guardedCleanupState()).toBe('open');
            const competing = waiterCase.q.reserveGuarded({ timeoutMs: 100 });
            expect(await competing).toEqual({ status: 'busy' });
            expect(waiterCase.q.stats()).toMatchObject({ count: 0, waiters: 1, closed: false });
            expect(waiterCase.q.guardedCleanupState()).toBe('open');
            expect(waiterCase.configGetter).not.toHaveBeenCalled();
            expect(waiterCase.policyGetter).not.toHaveBeenCalled();
            expect(waiterCase.q.close()).toBe(true);
            expect(await pending).toEqual({ status: 'closed' });
            expect(waiterCase.q.stats()).toMatchObject({ waiters: 0, closed: true });
            expect(waiterCase.q.guardedCleanupState()).toBe('closed');
            expect(vi.getTimerCount()).toBe(0);
            expect(waiterCase.configGetter).not.toHaveBeenCalled();
            expect(waiterCase.policyGetter).not.toHaveBeenCalled();
        },
    );
});
