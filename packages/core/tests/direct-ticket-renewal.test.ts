import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DirectTicketRenewal,
    DirectTicketRenewalError,
    type DirectTicketAcknowledgement,
    type DirectTicketIssueResult,
    type DirectTicketReceipt,
    type DirectTicketRenewalContext,
    type DirectTicketRenewalOptions,
    type DirectTicketRenewalProvider,
    type DirectTicketState,
} from '../src/direct/ticket-renewal';

const NOW = 10_000;
const ID = 'local-fixture';
const GENERATION = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

function gate<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((ok) => {
        resolve = ok;
    });
    return { promise, resolve };
}

function ack<K extends 'checkpointed' | 'activated'>(
    kind: K,
    r: DirectTicketReceipt,
): DirectTicketAcknowledgement<K> {
    return {
        kind,
        accountId: r.accountId,
        generation: r.generation,
        previousRevision: r.previousRevision,
        revision: r.revision,
    };
}

function receipt(c: DirectTicketRenewalContext, revision: string): DirectTicketReceipt {
    return {
        accountId: c.accountId,
        generation: c.generation,
        previousRevision: c.expectedRevision,
        revision,
        issuedAt: Date.now(),
        nextAt: Date.now() + 2_000,
        expiresAt: Date.now() + 60_000,
    };
}

/** Local issuer metadata, one in-memory durable slot and one live slot. No secret
 * values and no transport. The two independent CAS checks model the adapter's contract. */
function fixture(patch: Partial<DirectTicketState> = {}) {
    const initial = {
        accountId: ID,
        generation: GENERATION,
        revision: 'initial',
        issuedAt: NOW - 1_000,
        nextAt: NOW + 1_000,
        expiresAt: NOW + 70_000,
        ...patch,
    };
    const store = { durable: initial.revision, active: initial.revision };
    let n = 0;
    const issue = vi.fn(
        async (c: DirectTicketRenewalContext): Promise<DirectTicketIssueResult> => ({
            kind: 'issued',
            receipt: receipt(c, `issue-${++n}`),
        }),
    );

    const commit = (c: DirectTicketRenewalContext, r: DirectTicketReceipt) => {
        if (!c.isCurrent() || store.durable !== c.expectedRevision) {
            throw new Error('fixture checkpoint CAS');
        }

        store.durable = r.revision;
        return ack('checkpointed', r);
    };

    const switchOwner = (c: DirectTicketRenewalContext, r: DirectTicketReceipt) => {
        if (!c.isCurrent() || store.durable !== r.revision || store.active !== c.expectedRevision) {
            throw new Error('fixture activation CAS');
        }

        store.active = r.revision;
        return ack('activated', r);
    };

    const checkpoint = vi.fn(async (c: DirectTicketRenewalContext, r: DirectTicketReceipt) =>
        commit(c, r),
    );
    const activate = vi.fn(async (c: DirectTicketRenewalContext, r: DirectTicketReceipt) =>
        switchOwner(c, r),
    );
    const provider: DirectTicketRenewalProvider = { current: initial, issue, checkpoint, activate };
    const open = (options: Partial<DirectTicketRenewalOptions> = {}) =>
        new DirectTicketRenewal({
            accountId: ID,
            generation: GENERATION,
            autoRenew: true,
            isCurrent: () => true,
            provider,
            ...options,
        });
    return { initial, store, issue, commit, switchOwner, checkpoint, activate, provider, open };
}

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('issuer ticket renewal for one managed generation', () => {
    it.each([true, false])(
        'has no capability or timer without an installed provider (automatic=%s)',
        async (autoRenew) => {
            const f = fixture();
            const scheduler = f.open({ autoRenew, provider: undefined });
            await vi.advanceTimersByTimeAsync(100_000);
            expect(scheduler.snapshot()).toEqual({
                canRenew: false,
                phase: 'idle',
                error: null,
                renewAt: null,
                retryAt: null,
                lastRenewedAt: null,
            });
            await expect(scheduler.renew()).rejects.toMatchObject({ code: 'renewal-unavailable' });
            expect(f.issue).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
            await scheduler.close();
        },
    );

    it.each([{ nextAt: null }, { expiresAt: null }, { nextAt: null, expiresAt: null }])(
        'never schedules incomplete issuer metadata %j; explicit issuance still needs a real receipt',
        async (patch) => {
            const f = fixture(patch);
            const scheduler = f.open();
            await vi.advanceTimersByTimeAsync(2_000);
            expect(f.issue).not.toHaveBeenCalled();
            expect(scheduler.snapshot()).toMatchObject({
                canRenew: true,
                renewAt: null,
                lastRenewedAt: null,
            });
            expect(vi.getTimerCount()).toBe(0);
            await scheduler.renew();
            expect(f.store).toEqual({ durable: 'issue-1', active: 'issue-1' });
            expect(scheduler.snapshot()).toMatchObject({
                renewAt: NOW + 4_000,
                lastRenewedAt: NOW + 2_000,
            });
            await scheduler.close();
        },
    );

    it('leaves automatic issuance off without disabling explicit singleflight', async () => {
        const f = fixture();
        const scheduler = f.open({ autoRenew: false });
        await vi.advanceTimersByTimeAsync(2_000);
        expect(f.issue).not.toHaveBeenCalled();
        const first = scheduler.renew();
        expect(scheduler.renew()).toBe(first);
        await first;
        expect(f.issue).toHaveBeenCalledTimes(1);
        expect(scheduler.snapshot().lastRenewedAt).toBe(NOW + 2_000);
        expect(vi.getTimerCount()).toBe(0);
        await scheduler.close();
    });

    it('publishes the issuer time only after the durable checkpoint AND live activation, then uses the new issuer schedule', async () => {
        const f = fixture();
        const storeGate = gate<void>();
        const activeGate = gate<void>();
        f.checkpoint.mockImplementationOnce(async (context, r) => {
            await storeGate.promise;
            return f.commit(context, r);
        });
        f.activate.mockImplementationOnce(async (context, r) => {
            await activeGate.promise;
            return f.switchOwner(context, r);
        });
        const scheduler = f.open();
        // Changing a caller-owned baseline must not change the active revision or admission time.
        f.initial.revision = 'overwritten';
        f.initial.nextAt = NOW + 1;
        await vi.advanceTimersByTimeAsync(999);
        expect(f.issue).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        const waiting = scheduler.renew(); // join the timer
        const issueContext = f.issue.mock.calls[0][0];
        const [storeContext, candidate] = f.checkpoint.mock.calls[0];
        expect(issueContext.expectedRevision).toBe('initial');
        expect(issueContext.signal).toBe(storeContext.signal);
        expect(issueContext.isCurrent()).toBe(false);
        expect(storeContext.isCurrent()).toBe(true);
        expect(Object.isFrozen(candidate)).toBe(true);
        expect(scheduler.snapshot()).toMatchObject({ phase: 'renewing', lastRenewedAt: null });
        expect(f.store).toEqual({ durable: 'initial', active: 'initial' });
        expect(f.activate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(40);
        storeGate.resolve();
        await vi.advanceTimersByTimeAsync(0);
        const [activeContext, selected] = f.activate.mock.calls[0];
        expect(selected).toBe(candidate);
        expect(activeContext.signal).toBe(issueContext.signal);
        expect(storeContext.isCurrent()).toBe(false);
        expect(activeContext.isCurrent()).toBe(true);
        expect(f.store).toEqual({ durable: 'issue-1', active: 'initial' });
        expect(scheduler.snapshot().lastRenewedAt).toBeNull();
        await vi.advanceTimersByTimeAsync(40);
        activeGate.resolve();
        await waiting;
        expect(activeContext.isCurrent()).toBe(false);
        expect(activeContext.signal.aborted).toBe(true);
        expect(f.store).toEqual({ durable: 'issue-1', active: 'issue-1' });
        expect(scheduler.snapshot()).toEqual({
            canRenew: true,
            phase: 'idle',
            lastRenewedAt: NOW + 1_000,
            renewAt: NOW + 3_000,
            retryAt: null,
            error: null,
        });
        await vi.advanceTimersByTimeAsync(1_919);
        expect(f.issue).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(f.issue.mock.calls[1][0].expectedRevision).toBe('issue-1');
        expect(scheduler.snapshot().lastRenewedAt).toBe(NOW + 3_000);
        await scheduler.close();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not wake early on a timer longer than the Node delay limit', async () => {
        const delay = 0x7fffffff + 1_000;
        const f = fixture({ nextAt: NOW + delay, expiresAt: NOW + delay + 30_000 });
        const scheduler = f.open();
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(f.issue).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(scheduler.snapshot().lastRenewedAt).toBe(NOW + delay);
        await scheduler.close();
    });

    it('treats overdue nextAt as due only while the old issuer ticket is still live', async () => {
        const f = fixture({ nextAt: NOW - 10, expiresAt: NOW + 10 });
        const scheduler = f.open();
        expect(f.issue).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.issue).toHaveBeenCalledTimes(1);
        expect(f.issue.mock.calls[0][0].deadlineAt).toBe(NOW + 10);
        await scheduler.close();
        const expired = fixture({ nextAt: NOW - 10, expiresAt: NOW });
        const stopped = expired.open();
        expect(stopped.snapshot()).toMatchObject({
            phase: 'needs-login',
            canRenew: false,
            renewAt: null,
        });
        await expect(stopped.renew()).rejects.toMatchObject({ code: 'needs-login' });
        expect(expired.issue).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        { accountId: 'another' },
        { generation: OTHER },
        { revision: '' },
        { issuedAt: NOW + 1 },
        { issuedAt: Number.NaN },
        { nextAt: NOW - 1_000 },
        { expiresAt: NOW - 2_000 },
        { nextAt: NOW + 70_000 },
        { nextAt: NOW + 71_000 },
        { expiresAt: Infinity },
    ])('fails closed on an invalid or mismatched initial issuer state %j', async (patch) => {
        const f = fixture(patch);
        const scheduler = f.open();
        expect(scheduler.snapshot()).toMatchObject({
            canRenew: false,
            error: 'renewal-invalid-receipt',
            renewAt: null,
        });
        await expect(scheduler.renew()).rejects.toMatchObject({ code: 'renewal-invalid-receipt' });
        expect(f.issue).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        { accountId: 'another' },
        { generation: OTHER },
        { previousRevision: 'different' },
        { revision: 'initial' },
        { revision: '' },
        { revision: 'a'.repeat(129) },
        { issuedAt: NOW - 1_000 },
        { issuedAt: NOW - 1 },
        { issuedAt: NOW + 1 },
        { issuedAt: Infinity },
        { nextAt: NOW },
        { nextAt: NOW + 0.5 },
        { nextAt: null },
        { expiresAt: null },
        { expiresAt: NOW },
        { expiresAt: NOW + 2_000 },
        { expiresAt: NOW + 1_900 },
        { nextAt: Number.MAX_SAFE_INTEGER + 1 },
        { unrecognized: 'unexpected' },
    ])(
        'checks actual receipt identity, new issue, revision and issuer window before any checkpoint %j',
        async (patch) => {
            const f = fixture();
            f.issue.mockImplementation(async (c) => ({
                kind: 'issued',
                receipt: { ...receipt(c, 'new-revision'), ...patch } as DirectTicketReceipt,
            }));
            const scheduler = f.open();
            await expect(scheduler.renew()).rejects.toMatchObject({
                code: 'renewal-invalid-receipt',
            });
            expect(f.checkpoint).not.toHaveBeenCalled();
            expect(f.activate).not.toHaveBeenCalled();
            expect(scheduler.snapshot()).toMatchObject({
                phase: 'failed',
                canRenew: false,
                lastRenewedAt: null,
                retryAt: null,
                renewAt: null,
            });
            await vi.advanceTimersByTimeAsync(100_000);
            expect(f.issue).toHaveBeenCalledTimes(1);
        },
    );

    it('neither exposes installation exceptions nor grants capability to an incomplete provider', async () => {
        const f = fixture();
        const throwing = Object.defineProperty({ ...f.provider }, 'current', {
            get() {
                throw new Error('private installation diagnostic');
            },
        });

        for (const provider of [throwing, { ...f.provider, activate: undefined }]) {
            const scheduler = f.open({ provider: provider as DirectTicketRenewalProvider });
            expect(scheduler.snapshot()).toMatchObject({
                canRenew: false,
                error: 'renewal-invalid-receipt',
                renewAt: null,
            });
            await expect(scheduler.renew()).rejects.toMatchObject({
                message: 'renewal-invalid-receipt',
            });
            expect(vi.getTimerCount()).toBe(0);
        }
    });

    it('does not evaluate external accessors or accept a proxy as an issuer receipt', async () => {
        const read = vi.fn(() => 'spoof');

        for (const accessor of [true, false]) {
            const f = fixture();
            f.issue.mockImplementation(async (c) => {
                const candidate = receipt(c, 'fresh');
                return {
                    kind: 'issued',
                    receipt: accessor
                        ? Object.defineProperty(candidate, 'revision', { get: read })
                        : new Proxy(candidate, { get: read }),
                };
            });
            const scheduler = f.open();
            await expect(scheduler.renew()).rejects.toMatchObject({
                code: 'renewal-invalid-receipt',
            });
            expect(f.checkpoint).not.toHaveBeenCalled();
        }

        expect(read).not.toHaveBeenCalled();
    });

    it('checkpoints and activates an owned immutable receipt, independently of a later issuer mutation', async () => {
        const f = fixture();
        const beforeCommit = gate<void>();
        let issued: { revision: string } | undefined;
        f.issue.mockImplementation(async (c) => {
            const candidate = receipt(c, 'fresh');
            issued = candidate;
            return { kind: 'issued', receipt: candidate };
        });
        f.checkpoint.mockImplementation(async (c, r) => {
            await beforeCommit.promise;
            return f.commit(c, r);
        });
        const scheduler = f.open();
        const result = scheduler.renew();
        await vi.advanceTimersByTimeAsync(0);
        expect(issued).toBeDefined();
        issued!.revision = 'mutated';
        beforeCommit.resolve();
        await result;
        expect(f.store).toEqual({ durable: 'fresh', active: 'fresh' });
        await scheduler.close();
    });
});

describe('bounded retry and durable handoff failures', () => {
    it('retries only at the explicit issuer time, at most once per revision', async () => {
        const f = fixture();
        f.issue.mockImplementation(async () => ({
            kind: 'not-sent',
            retryAfterAt: Date.now() + 800,
        }));
        const scheduler = f.open();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(scheduler.snapshot()).toMatchObject({
            phase: 'backoff',
            error: 'renewal-not-sent',
            retryAt: NOW + 1_800,
            lastRenewedAt: null,
        });
        await vi.advanceTimersByTimeAsync(799);
        await expect(scheduler.renew()).rejects.toMatchObject({ code: 'renewal-backoff' });
        expect(f.issue).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(f.issue).toHaveBeenCalledTimes(2);
        expect(scheduler.snapshot()).toMatchObject({
            phase: 'failed',
            error: 'renewal-not-sent',
            retryAt: null,
            renewAt: null,
        });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(f.issue).toHaveBeenCalledTimes(2);
        expect(f.checkpoint).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        // A new explicit operator call after the issuer's wait is not an automatic replay.
        f.issue.mockImplementationOnce(async (c) => ({
            kind: 'issued',
            receipt: receipt(c, 'recovered'),
        }));
        await scheduler.renew();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(scheduler.snapshot()).toMatchObject({ phase: 'backoff', retryAt: Date.now() + 800 });
        await scheduler.close();
    });

    it('honors an explicit issuer retry time after a manual attempt without reviving the original timer', async () => {
        const f = fixture();
        f.issue.mockResolvedValueOnce({ kind: 'not-sent', retryAfterAt: NOW + 50 });
        const scheduler = f.open();
        await expect(scheduler.renew()).rejects.toMatchObject({ code: 'renewal-not-sent' });
        await vi.advanceTimersByTimeAsync(49);
        expect(f.issue).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(scheduler.snapshot()).toMatchObject({ lastRenewedAt: NOW + 50, retryAt: null });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(f.issue).toHaveBeenCalledTimes(2);
        await scheduler.close();
    });

    it('drops a delayed automatic retry beyond its local window even when the old ticket still lives', async () => {
        const f = fixture({ expiresAt: NOW + 500_000 });
        f.issue.mockResolvedValueOnce({ kind: 'not-sent', retryAfterAt: NOW + 1_500 });
        const scheduler = f.open();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(scheduler.snapshot().retryAt).toBe(NOW + 1_500);
        vi.setSystemTime(NOW + 350_000);
        await vi.advanceTimersByTimeAsync(500);
        expect(f.issue).toHaveBeenCalledTimes(1);
        expect(scheduler.snapshot()).toMatchObject({
            phase: 'failed',
            error: 'renewal-not-sent',
            retryAt: null,
            lastRenewedAt: null,
        });
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        { hint: null },
        { hint: NOW - 1 },
        { hint: NOW },
        { hint: NOW + 70_000 },
        { hint: NOW + 70_001 },
        { hint: NOW + 300_001, state: { expiresAt: NOW + 400_000 } },
        { hint: NOW + 2_000, state: { expiresAt: null } },
        { hint: NOW + 2_000, state: { nextAt: null } },
        { hint: NOW + 2_000, autoRenew: false },
    ])(
        'never schedules a missing, early, out-of-window or disabled retry %j',
        async ({ hint, state, autoRenew }) => {
            const f = fixture(state);
            f.issue.mockResolvedValue({ kind: 'not-sent', retryAfterAt: hint });
            const scheduler = f.open({ autoRenew: autoRenew ?? true });
            await expect(scheduler.renew()).rejects.toMatchObject({ code: 'renewal-not-sent' });
            expect(scheduler.snapshot()).toMatchObject({
                retryAt: null,
                renewAt: null,
                lastRenewedAt: null,
            });
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(500_000);
            expect(f.issue).toHaveBeenCalledTimes(1);
        },
    );

    it.each([
        ['unknown write', { kind: 'write-unknown' }, 'renewal-write-unknown'],
        ['required reauthentication', { kind: 'needs-login' }, 'needs-login'],
        ['malformed unsent', { kind: 'not-sent', retryAfterAt: -1 }, 'renewal-write-unknown'],
        [
            'extra fields',
            { kind: 'not-sent', retryAfterAt: NOW + 3_000, extra: true },
            'renewal-write-unknown',
        ],
        ['absent outcome', undefined, 'renewal-write-unknown'],
    ] as const)(
        'reports %s without automatic or manual re-dispatch of an uncertain ticket',
        async (_name, value, code) => {
            const f = fixture();
            f.issue.mockResolvedValue(value as DirectTicketIssueResult);
            const scheduler = f.open();
            await expect(scheduler.renew()).rejects.toMatchObject({ code });
            await expect(scheduler.renew()).rejects.toMatchObject({ code });
            expect(scheduler.snapshot()).toMatchObject({
                error: code,
                phase: code === 'needs-login' ? 'needs-login' : 'failed',
                canRenew: false,
                retryAt: null,
            });
            await vi.advanceTimersByTimeAsync(90_000);
            expect(f.issue).toHaveBeenCalledTimes(1);
        },
    );

    it.each([
        new DirectTicketRenewalError('renewal-not-sent'),
        new Error('private fixture diagnostic'),
    ])(
        'never uses thrown provider text or a thrown retry claim as an issuer receipt',
        async (error) => {
            const f = fixture();
            f.issue.mockRejectedValue(error);
            const scheduler = f.open();
            const failure = await scheduler.renew().catch((e: unknown) => e);
            expect(failure).toMatchObject({
                code: 'renewal-write-unknown',
                message: 'renewal-write-unknown',
            });
            expect(failure).not.toBe(error);
            expect(scheduler.snapshot().error).toBe('renewal-write-unknown');
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it('leaves a committed checkpoint intact on an uncertain fsync or a failed live switch; neither is retried', async () => {
        for (const stage of ['checkpoint', 'activate'] as const) {
            const f = fixture();

            if (stage === 'checkpoint') {
                f.checkpoint.mockImplementation(async (c, r) => {
                    f.commit(c, r);
                    throw new Error('synthetic uncertain commit');
                });
            } else {
                f.activate.mockRejectedValue(new Error('synthetic owner switch failed'));
            }

            const scheduler = f.open();
            const code =
                stage === 'checkpoint' ? 'renewal-checkpoint-failed' : 'renewal-activation-failed';
            await expect(scheduler.renew()).rejects.toMatchObject({ code });
            expect(f.store).toEqual({ durable: 'issue-1', active: 'initial' });
            expect(f.activate).toHaveBeenCalledTimes(stage === 'checkpoint' ? 0 : 1);
            expect(scheduler.snapshot()).toMatchObject({
                canRenew: false,
                phase: 'failed',
                error: code,
                renewAt: null,
                retryAt: null,
                lastRenewedAt: null,
            });
            await expect(scheduler.renew()).rejects.toMatchObject({ code });
            expect(f.issue).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
        }
    });

    it.each(['kind', 'accountId', 'generation', 'previousRevision', 'revision'] as const)(
        'requires both acknowledgements to match the candidate %s',
        async (field) => {
            for (const stage of ['checkpoint', 'activate'] as const) {
                const f = fixture();

                if (stage === 'checkpoint') {
                    f.checkpoint.mockImplementation(async (c, r) => ({
                        ...f.commit(c, r),
                        [field]: 'wrong',
                    }));
                } else {
                    f.activate.mockImplementation(async (c, r) => ({
                        ...f.switchOwner(c, r),
                        [field]: 'wrong',
                    }));
                }

                const scheduler = f.open();
                await expect(scheduler.renew()).rejects.toMatchObject({
                    code:
                        stage === 'checkpoint'
                            ? 'renewal-checkpoint-failed'
                            : 'renewal-activation-failed',
                });
                expect(f.activate).toHaveBeenCalledTimes(stage === 'checkpoint' ? 0 : 1);
                expect(scheduler.snapshot()).toMatchObject({
                    canRenew: false,
                    renewAt: null,
                    lastRenewedAt: null,
                });
                expect(vi.getTimerCount()).toBe(0);
            }
        },
    );

    it('does not overwrite an intervening durable revision or activate against a replaced live owner', async () => {
        for (const conflict of ['durable', 'active'] as const) {
            const f = fixture();
            const scheduler = f.open();
            f.store[conflict] = 'intervening-revision';
            const code =
                conflict === 'durable' ? 'renewal-checkpoint-failed' : 'renewal-activation-failed';
            await expect(scheduler.renew()).rejects.toMatchObject({ code });
            expect(f.store[conflict]).toBe('intervening-revision');
            expect(f.activate).toHaveBeenCalledTimes(conflict === 'durable' ? 0 : 1);
            expect(scheduler.snapshot()).toMatchObject({
                phase: 'failed',
                canRenew: false,
                lastRenewedAt: null,
                error: code,
            });
            expect(vi.getTimerCount()).toBe(0);
        }
    });

    it('keeps the previous confirmed issuer time on a later failure', async () => {
        const f = fixture();
        const scheduler = f.open();
        await scheduler.renew();
        await vi.advanceTimersByTimeAsync(10);
        f.activate.mockRejectedValueOnce(new Error('late switch failed'));
        await expect(scheduler.renew()).rejects.toMatchObject({
            code: 'renewal-activation-failed',
        });
        expect(f.store).toEqual({ durable: 'issue-2', active: 'issue-1' });
        expect(scheduler.snapshot()).toMatchObject({
            lastRenewedAt: NOW,
            canRenew: false,
            renewAt: null,
        });
    });
});

describe('deadline, cancellation and generation ownership', () => {
    it.each(['issue', 'checkpoint', 'activate'] as const)(
        'expires at the exact shared deadline in %s and drains a late result',
        async (stage) => {
            const f = fixture();
            const late = gate<void>();
            let captured!: DirectTicketRenewalContext;

            if (stage === 'issue') {
                f.issue.mockImplementation(async (c) => {
                    captured = c;
                    await late.promise;
                    return { kind: 'issued', receipt: receipt(c, 'late') };
                });
            } else if (stage === 'checkpoint') {
                f.checkpoint.mockImplementation(async (c, r) => {
                    captured = c;
                    await late.promise;
                    return ack('checkpointed', r);
                });
            } else {
                f.activate.mockImplementation(async (c, r) => {
                    captured = c;
                    await late.promise;
                    return ack('activated', r);
                });
            }

            const scheduler = f.open({ timeoutMs: 70 });
            const result = scheduler.renew();
            const failed = expect(result).rejects.toMatchObject({ code: 'renewal-deadline' });
            await vi.advanceTimersByTimeAsync(69);
            expect(captured.isCurrent()).toBe(true);
            await vi.advanceTimersByTimeAsync(1);
            await failed;
            expect(captured.signal.aborted).toBe(true);
            expect(captured.isCurrent()).toBe(false);
            expect(scheduler.snapshot()).toMatchObject({
                phase: 'failed',
                error: 'renewal-deadline',
                canRenew: false,
                lastRenewedAt: null,
                retryAt: null,
            });
            expect(scheduler.renew()).toBe(result);
            const closing = scheduler.close();
            const done = vi.fn();
            void closing.then(done);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(done).not.toHaveBeenCalled();
            expect(scheduler.close()).toBe(closing);
            late.resolve();
            await closing;
            expect(done).toHaveBeenCalledOnce();
            expect(f.checkpoint).toHaveBeenCalledTimes(stage === 'issue' ? 0 : 1);
            expect(f.activate).toHaveBeenCalledTimes(stage === 'activate' ? 1 : 0);
            expect(scheduler.snapshot()).toMatchObject({
                phase: 'closed',
                lastRenewedAt: null,
                renewAt: null,
            });
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it('does not reset the deadline at checkpoint or activation', async () => {
        const f = fixture();
        const issuerGate = gate<void>();
        const checkpointGate = gate<void>();
        const switchGate = gate<void>();
        f.issue.mockImplementation(async (c) => {
            await issuerGate.promise;
            return { kind: 'issued', receipt: receipt(c, 'candidate') };
        });
        f.checkpoint.mockImplementation(async (c, r) => {
            await checkpointGate.promise;
            return f.commit(c, r);
        });
        f.activate.mockImplementation(async (c, r) => {
            await switchGate.promise;
            return f.switchOwner(c, r);
        });
        const scheduler = f.open({ timeoutMs: 90 });
        const rejected = expect(scheduler.renew()).rejects.toMatchObject({
            code: 'renewal-deadline',
        });
        await vi.advanceTimersByTimeAsync(40);
        issuerGate.resolve();
        await vi.advanceTimersByTimeAsync(40);
        checkpointGate.resolve();
        await vi.advanceTimersByTimeAsync(9);
        expect(f.issue.mock.calls[0][0].deadlineAt).toBe(NOW + 90);
        expect(f.checkpoint.mock.calls[0][0].deadlineAt).toBe(NOW + 90);
        expect(f.activate.mock.calls[0][0].deadlineAt).toBe(NOW + 90);
        await vi.advanceTimersByTimeAsync(1);
        await rejected;
        switchGate.resolve();
        await scheduler.close();
        expect(f.store).toEqual({ durable: 'candidate', active: 'initial' });
        expect(scheduler.snapshot().lastRenewedAt).toBeNull();
    });

    it('shortens the commit deadline to the new issuer expiry when it is earlier', async () => {
        const f = fixture();
        f.issue.mockImplementation(async (c) => ({
            kind: 'issued',
            receipt: { ...receipt(c, 'short'), nextAt: NOW + 5, expiresAt: NOW + 12 },
        }));
        const checkpointGate = gate<void>();
        f.checkpoint.mockImplementation(async (c, r) => {
            await checkpointGate.promise;
            return f.commit(c, r);
        });
        const scheduler = f.open({ timeoutMs: 100 });
        const rejected = expect(scheduler.renew()).rejects.toMatchObject({
            code: 'renewal-deadline',
        });
        await vi.advanceTimersByTimeAsync(11);
        expect(f.checkpoint.mock.calls[0][0].deadlineAt).toBe(NOW + 12);
        await vi.advanceTimersByTimeAsync(1);
        await rejected;
        checkpointGate.resolve();
        await scheduler.close();
        expect(f.store).toEqual({ durable: 'initial', active: 'initial' });
        expect(f.activate).not.toHaveBeenCalled();
    });

    it('checks the wall deadline on callback even if its timer has not fired', async () => {
        const f = fixture({ nextAt: NOW + 5, expiresAt: NOW + 12 });
        const late = gate<void>();
        f.issue.mockImplementation(async () => {
            await late.promise;
            return { kind: 'not-sent', retryAfterAt: NOW + 14 };
        });
        const scheduler = f.open();
        const rejected = expect(scheduler.renew()).rejects.toMatchObject({
            code: 'renewal-deadline',
        });
        await vi.advanceTimersByTimeAsync(0);
        vi.setSystemTime(NOW + 12);
        late.resolve();
        await rejected;
        expect(f.checkpoint).not.toHaveBeenCalled();
        expect(scheduler.snapshot()).toMatchObject({
            lastRenewedAt: null,
            retryAt: null,
            canRenew: false,
        });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a backward clock correction does not extend the running attempt', async () => {
        const f = fixture();
        const late = gate<void>();
        f.issue.mockImplementation(async (c) => {
            await late.promise;
            return { kind: 'issued', receipt: receipt(c, 'late') };
        });
        const scheduler = f.open({ timeoutMs: 40 });
        const rejected = expect(scheduler.renew()).rejects.toMatchObject({
            code: 'renewal-deadline',
        });
        await vi.advanceTimersByTimeAsync(20);
        vi.setSystemTime(NOW - 2_000);
        await vi.advanceTimersByTimeAsync(20);
        await rejected;
        late.resolve();
        await scheduler.close();
        expect(f.checkpoint).not.toHaveBeenCalled();
    });

    it('observes cancellation despite another listener stopping propagation, and releases timers before a stalled adapter drains', async () => {
        const f = fixture();
        const late = gate<void>();
        f.issue.mockImplementation(async (c) => {
            await late.promise;
            return { kind: 'issued', receipt: receipt(c, 'late') };
        });
        const signal = new AbortController();
        signal.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
        const scheduler = f.open();
        const rejected = expect(scheduler.renew(signal.signal)).rejects.toMatchObject({
            code: 'renewal-cancelled',
        });
        await vi.advanceTimersByTimeAsync(0);
        signal.abort();
        await rejected;
        expect(vi.getTimerCount()).toBe(0);
        expect(f.issue.mock.calls[0][0].isCurrent()).toBe(false);
        late.resolve();
        await scheduler.close();
        expect(f.checkpoint).not.toHaveBeenCalled();
    });

    it('rejects a pre-aborted caller without consuming the schedule', async () => {
        const f = fixture();
        const scheduler = f.open();
        await expect(scheduler.renew(AbortSignal.abort())).rejects.toMatchObject({
            code: 'renewal-cancelled',
        });
        expect(scheduler.snapshot()).toMatchObject({
            phase: 'idle',
            renewAt: NOW + 1_000,
            lastRenewedAt: null,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(f.issue).toHaveBeenCalledOnce();
        await scheduler.close();
    });

    it('close before dispatch does no work and multiple stops share the same real drain', async () => {
        const f = fixture();
        const scheduler = f.open();
        const rejected = expect(scheduler.renew()).rejects.toMatchObject({
            code: 'renewal-cancelled',
        });
        const first = scheduler.close();
        expect(scheduler.close()).toBe(first);
        await first;
        await rejected;
        await expect(scheduler.renew()).rejects.toMatchObject({ code: 'renewal-closed' });
        expect(f.issue).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('an aborted active operation drains before replacement and a joined signal cannot abort its owner', async () => {
        const f = fixture();
        const late = gate<void>();
        f.checkpoint.mockImplementation(async (c, r) => {
            await late.promise;
            return f.commit(c, r);
        });
        const firstSignal = new AbortController();
        const joinedSignal = new AbortController();
        const scheduler = f.open();
        const result = scheduler.renew(firstSignal.signal);
        const rejected = expect(result).rejects.toMatchObject({ code: 'renewal-cancelled' });
        expect(scheduler.renew(joinedSignal.signal)).toBe(result);
        joinedSignal.abort();
        await vi.advanceTimersByTimeAsync(0);
        const [context] = f.checkpoint.mock.calls[0];
        expect(context.isCurrent()).toBe(true);
        firstSignal.abort(new Error('fixture private reason'));
        expect(context.signal.reason).toMatchObject({
            code: 'renewal-cancelled',
            message: 'renewal-cancelled',
        });
        await rejected;
        expect(scheduler.snapshot()).toMatchObject({
            error: 'renewal-cancelled',
            canRenew: false,
            lastRenewedAt: null,
        });
        expect(context.isCurrent()).toBe(false);
        const done = vi.fn();
        const closing = scheduler.close().then(done);
        await vi.advanceTimersByTimeAsync(0);
        expect(done).not.toHaveBeenCalled();
        late.resolve();
        await closing;
        expect(f.store).toEqual({ durable: 'initial', active: 'initial' });
        expect(f.activate).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('isolates simultaneous accounts and revokes a superseded generation during activation', async () => {
        const old = fixture();
        const other = fixture({ accountId: 'second' });
        const oldGate = gate<void>();
        const newGeneration = { value: GENERATION };
        old.activate.mockImplementation(async (c, r) => {
            await oldGate.promise;
            return old.switchOwner(c, r);
        });
        const first = old.open({ isCurrent: () => newGeneration.value === GENERATION });
        const second = other.open({ accountId: 'second' });
        const rejected = expect(first.renew()).rejects.toMatchObject({ code: 'renewal-cancelled' });
        await second.renew();
        expect(other.store).toEqual({ durable: 'issue-1', active: 'issue-1' });
        expect(old.store).toEqual({ durable: 'issue-1', active: 'initial' });
        const [oldContext] = old.activate.mock.calls[0];
        newGeneration.value = OTHER;
        expect(oldContext.isCurrent()).toBe(false);
        await rejected;
        // Even an ABA return to the old value cannot revive a revoked guard.
        newGeneration.value = GENERATION;
        expect(oldContext.isCurrent()).toBe(false);
        oldGate.resolve();
        await first.close();
        expect(old.store).toEqual({ durable: 'issue-1', active: 'initial' });
        expect(first.snapshot().lastRenewedAt).toBeNull();
        expect(second.snapshot()).toMatchObject({ canRenew: true, lastRenewedAt: NOW });
        await second.close();
    });

    it.each([
        () => false,
        () => {
            throw new Error('private generation lookup');
        },
    ])(
        'does not dispatch when the manager no longer vouches for this generation',
        async (isCurrent) => {
            const f = fixture();
            const scheduler = f.open({ isCurrent });
            await expect(scheduler.renew()).rejects.toMatchObject({ code: 'renewal-cancelled' });
            expect(f.issue).not.toHaveBeenCalled();
            expect(scheduler.snapshot()).toMatchObject({ canRenew: false, renewAt: null });
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it('reserves singleflight before a synchronous provider reentry and suppresses a late timer', async () => {
        const f = fixture();
        const clock = vi.spyOn(globalThis, 'setTimeout');
        const scheduler = f.open();
        const outdated = clock.mock.calls[0][0];
        let joined: Promise<void> | undefined;
        f.issue.mockImplementation(async (c) => {
            joined = scheduler.renew();
            return { kind: 'issued', receipt: receipt(c, 'new') };
        });
        const original = scheduler.renew();
        await original;
        expect(joined).toBe(original);
        outdated();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.issue).toHaveBeenCalledOnce();
        await scheduler.close();
        outdated();
        await vi.advanceTimersByTimeAsync(4_000);
        expect(f.issue).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a reentrant close inside an issuer call never permits its late receipt', async () => {
        const f = fixture();
        const scheduler = f.open();
        let stop: Promise<void> | undefined;
        f.issue.mockImplementation(async (c) => {
            stop = scheduler.close();
            return { kind: 'issued', receipt: receipt(c, 'late') };
        });
        const rejected = expect(scheduler.renew()).rejects.toMatchObject({
            code: 'renewal-cancelled',
        });
        await rejected;
        expect(stop).toBeDefined();
        await stop;
        expect(f.checkpoint).not.toHaveBeenCalled();
        expect(scheduler.snapshot()).toMatchObject({ phase: 'closed', lastRenewedAt: null });
        expect(vi.getTimerCount()).toBe(0);
    });
});
