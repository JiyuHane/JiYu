import { createLogger, renderTraceBytes, runWithTraceRequest } from '@snowluma/common/logger';
import type { PacketSender } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { isRealUin } from '@snowluma/common/uin';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { Bridge } from './bridge';
import type { BridgeSessionListener, BridgeSessionSource } from './bridge-interface';

const log = createLogger('Bridge');
const packetLog = createLogger('Bridge.Packet');
const runtimeLog = createLogger('Bridge.Runtime');
const HEALTH_FLUSH_BUDGET = 32;

type HealthCandidate = {
    uin: string;
    bridge: Bridge;
    before: boolean | null;
    healthy: boolean;
    revision: object;
};

type DirectSession = {
    bridge: Bridge;
    /** True once 'started' was handed to observers; only then is 'closed' owed. */
    activated: boolean;
    closing: Promise<void> | null;
};

/**
 * @internal Experimental owner handle for one direct (non-hook) account session.
 * It has no QQ process: session observers see `activePid === null` and a `closed`
 * PID of `null`. Opening it claims the account; no hook login can bind to it.
 */
export interface DirectSessionHandle {
    /** Available before activation so the owner can claim a push port and buffer. */
    readonly bridge: Bridge;
    /** Single use. Attaches the logged-in sender, then announces the session. */
    activate(sender: PacketSender): void;
    /** Throws unless the session is active, like a health report for an unbound PID. */
    setReceiveHealthy(healthy: boolean): void;
    /** Idempotent. Rejects if observers or Bridge disposal fail. */
    close(): Promise<void>;
}

export class BridgeManager implements BridgeSessionSource {
    private readonly bridges = new Map<string, Bridge>();
    private readonly pidToUin_ = new Map<number, string>();
    private readonly directSessions_ = new Map<string, DirectSession>();
    /** Hook PIDs whose login was refused by a direct session, with the refusing UIN.
     *  They stay unbound until the hook layer reports a disconnect or another login. */
    private readonly refusedHookPids_ = new Map<number, string>();
    private readonly closingSessions_ = new Map<string, Set<Promise<void>>>();
    private readonly sessionSubscriptions = new Set<{ listener: BridgeSessionListener }>();
    private readonly healthRevisions = new WeakMap<Bridge, object>();
    private readonly pendingHealth = new Map<Bridge, HealthCandidate>();
    private readonly healthBaselines = new Map<Bridge, boolean | null>();
    private healthInFlight: HealthCandidate | undefined;
    private healthRoutingDepth = 0;
    private healthFlushing = false;
    private healthDeferred = false;
    private healthImmediate: NodeJS.Immediate | undefined;
    private disposal_: Promise<void> | null = null;

    /** Hook callbacks remain synchronous; shutdown awaits every detached account. */
    dispose(): Promise<void> {
        const disposal = (this.disposal_ ??= Promise.resolve().then(() => this.disposeSessions()));
        this.sessionSubscriptions.clear();
        this.pendingHealth.clear();
        this.healthBaselines.clear();
        this.directSessions_.clear();
        this.refusedHookPids_.clear();

        if (this.healthImmediate) {
            clearImmediate(this.healthImmediate);
            this.healthImmediate = undefined;
        }

        // Finish synchronous lifecycle observers before collecting detached sessions.
        return disposal;
    }

    private async disposeSessions(): Promise<void> {
        for (const [uin, session] of this.bridges) {
            // Synchronous dispose failures are recorded in their reservations;
            // keep closing the remaining sessions before aggregating them.
            this.closeSession(uin, session, undefined, false);
        }

        this.bridges.clear();
        this.pidToUin_.clear();
        const results = await Promise.allSettled(
            [...this.closingSessions_.values()].flatMap((sessions) => [...sessions]),
        );
        const errors = results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
        );

        if (errors.length) {
            throw new AggregateError(errors, 'Bridge persistence shutdown failed');
        }
    }

    // Only manager-observed changes are included; direct Bridge mutation and
    // same-PID callbacks from earlier Hook generations cannot be distinguished.
    private withHealthRouting<T>(route: () => T): T {
        this.healthRoutingDepth++;

        try {
            return route();
        } catch (error) {
            // A partial route may already have changed an older session. Do not
            // notify synchronously before the original exception reaches its caller.
            this.healthDeferred = true;
            throw error;
        } finally {
            this.healthRoutingDepth--;

            if (this.healthRoutingDepth === 0) {
                this.healthBaselines.clear();
            }

            if (this.healthRoutingDepth === 0 && !this.disposal_) {
                if (this.healthDeferred && this.pendingHealth.size) {
                    this.scheduleHealthFlush();
                } else if (!this.healthFlushing && !this.healthDeferred) {
                    this.flushHealth();
                } else if (!this.healthFlushing && !this.pendingHealth.size) {
                    this.healthDeferred = false;
                }
            }
        }
    }

    private captureHealth(bridge: Bridge): { before: boolean; revision: object | undefined } {
        const before = bridge.receiveHealthy;

        if (!this.healthBaselines.has(bridge)) {
            const pending = this.pendingHealth.get(bridge);
            // A listener may have seen an in-flight value that later listeners
            // have not. Replay the final value even if nested changes form ABA.
            const baseline =
                this.healthInFlight?.bridge === bridge ? null : pending ? pending.before : before;
            this.healthBaselines.set(bridge, baseline);
        }

        return { before, revision: this.healthRevisions.get(bridge) };
    }

    private recordHealthChange(
        uin: string,
        bridge: Bridge,
        before: boolean,
        revision: object | undefined,
    ): void {
        if (
            this.disposal_ ||
            this.bridges.get(uin) !== bridge ||
            bridge.empty ||
            this.healthRevisions.get(bridge) !== revision
        ) {
            return;
        }

        const healthy = bridge.receiveHealthy;

        if (healthy === before) {
            return;
        }

        const next = {};
        this.healthRevisions.set(bridge, next);
        const previous = this.pendingHealth.get(bridge);
        const baseline = this.healthBaselines.has(bridge)
            ? this.healthBaselines.get(bridge)!
            : previous
              ? previous.before
              : before;

        if (baseline !== null && healthy === baseline) {
            this.pendingHealth.delete(bridge);
        } else {
            this.pendingHealth.set(bridge, {
                uin,
                bridge,
                before: baseline,
                healthy,
                revision: next,
            });
        }
    }

    // started observers can see the first bound value before nested mutations.
    private markStartedHealthBoundary(bridge: Bridge): void {
        // An empty session may first bind from inside a started observer.
        this.healthBaselines.set(bridge, null);
        const candidate = this.pendingHealth.get(bridge);

        if (candidate) {
            candidate.before = null;
        }
    }

    private scheduleHealthFlush(): void {
        if (this.disposal_ || this.healthImmediate || !this.pendingHealth.size) {
            return;
        }

        try {
            this.healthImmediate = setImmediate(() => {
                this.healthImmediate = undefined;

                if (this.disposal_) {
                    return;
                }

                this.healthDeferred = false;
                this.flushHealth();
            });
            this.healthImmediate.unref();
        } catch {
            // Scheduling failures never replace the original routing exception.
            try {
                log.warn('receive health notification scheduling failed');
            } catch {
                /* no diagnostics available */
            }
        }
    }

    private currentHealth(candidate: HealthCandidate): boolean {
        return (
            !this.disposal_ &&
            this.bridges.get(candidate.uin) === candidate.bridge &&
            this.healthRevisions.get(candidate.bridge) === candidate.revision &&
            candidate.bridge.receiveHealthy === candidate.healthy
        );
    }

    private flushHealth(): void {
        if (
            this.disposal_ ||
            this.healthFlushing ||
            this.healthRoutingDepth !== 0 ||
            this.healthDeferred
        ) {
            return;
        }

        this.healthFlushing = true;

        try {
            let count = 0;

            while (
                !this.disposal_ &&
                !this.healthDeferred &&
                this.pendingHealth.size &&
                count < HEALTH_FLUSH_BUDGET
            ) {
                const candidate = this.pendingHealth.values().next().value;

                if (!candidate) {
                    break;
                }

                this.pendingHealth.delete(candidate.bridge);
                count++;

                if (!this.currentHealth(candidate)) {
                    continue;
                }

                this.healthInFlight = candidate;

                try {
                    for (const { listener } of [...this.sessionSubscriptions]) {
                        if (this.healthDeferred || !this.currentHealth(candidate)) {
                            break;
                        }

                        try {
                            listener.receiveHealthChanged?.(candidate.uin, candidate.bridge);
                        } catch {
                            try {
                                log.warn('receive health listener failed');
                            } catch {
                                /* no diagnostics available */
                            }
                        }
                    }
                } finally {
                    if (
                        this.healthDeferred &&
                        this.currentHealth(candidate) &&
                        !this.pendingHealth.has(candidate.bridge)
                    ) {
                        this.pendingHealth.set(candidate.bridge, { ...candidate, before: null });
                    }

                    this.healthInFlight = undefined;
                }
            }
        } finally {
            this.healthFlushing = false;

            if (this.disposal_) {
                this.pendingHealth.clear();
            } else if (this.pendingHealth.size) {
                this.healthDeferred = true;
                this.scheduleHealthFlush();
            } else {
                this.healthDeferred = false;

                if (this.healthImmediate) {
                    clearImmediate(this.healthImmediate);
                    this.healthImmediate = undefined;
                }
            }
        }
    }

    private closeSession(
        uin: string,
        bridge: Bridge,
        beforeDispose?: () => void,
        propagateDisposeError = true,
    ): void {
        const sessions = this.closingSessions_.get(uin) ?? new Set<Promise<void>>();
        let resolveClosing!: () => void;
        let rejectClosing!: (error: unknown) => void;
        const closing = new Promise<void>((resolve, reject) => {
            resolveClosing = resolve;
            rejectClosing = reject;
        });
        sessions.add(closing);
        this.closingSessions_.set(uin, sessions);
        void closing.then(
            () => {
                sessions.delete(closing);

                if (sessions.size === 0 && this.closingSessions_.get(uin) === sessions) {
                    this.closingSessions_.delete(uin);
                }
            },
            (error) => {
                try {
                    log.error(
                        'identity close failed: UIN=%s err=%s',
                        uin,
                        error instanceof Error ? (error.stack ?? error.message) : String(error),
                    );
                } catch {
                    // Diagnostics must not replace the close failure or reject
                    // the observer promise.
                }
            },
        );

        const startDispose = () => {
            try {
                // Resolve the reservation with void, not the dispose promise:
                // reentrant opens may already be waiting on this reservation.
                void Promise.resolve(bridge.dispose()).then(() => resolveClosing(), rejectClosing);
            } catch (error) {
                rejectClosing(error);

                if (propagateDisposeError) {
                    throw error;
                }
            }
        };

        let beforeDisposeCompleted = false;

        try {
            beforeDispose?.();
            beforeDisposeCompleted = true;
        } finally {
            if (beforeDisposeCompleted) {
                startDispose();
            } else {
                try {
                    startDispose();
                } catch {
                    // Preserve the synchronous observer/logging exception; the
                    // dispose exception remains in the rejected reservation.
                }
            }
        }
    }

    /** Listener changes take effect on the next event. On final detach, close
     *  observers run before Bridge disposal and can still read its account identity;
     *  the final PID has already been detached. */
    subscribeSessions(listener: BridgeSessionListener): () => void {
        const subscription = { listener };
        this.sessionSubscriptions.add(subscription);

        return () => {
            this.sessionSubscriptions.delete(subscription);
        };
    }

    private fireSessionStarted(uin: string, bridge: Bridge): void {
        for (const { listener } of [...this.sessionSubscriptions]) {
            try {
                listener.started?.(uin, bridge);
            } catch (err) {
                log.warn(
                    'session-started listener threw: %s',
                    err instanceof Error ? err.message : String(err),
                );
            }
        }
    }

    private fireSessionClosed(uin: string, bridge: Bridge, pid: number | null): void {
        for (const { listener } of [...this.sessionSubscriptions]) {
            try {
                listener.closed?.(uin, bridge, pid);
            } catch (err) {
                log.warn(
                    'session-closed listener threw: %s',
                    err instanceof Error ? err.message : String(err),
                );
            }
        }
    }

    onPidDisconnected(pid: number): void {
        if (this.disposal_) {
            return;
        }

        this.refusedHookPids_.delete(pid);
        const uin = this.pidToUin_.get(pid);

        if (!uin) {
            return;
        }

        this.withHealthRouting(() =>
            runWithTraceRequest(() => {
                const startedAt = Date.now();
                runtimeLog.trace('bridge_detach_start pid=%d uin=%j', pid, uin);

                try {
                    const closed = this.detachPidFromSession(pid, uin);
                    const activePid = this.bridges.get(uin)?.activePid ?? null;

                    if (closed) {
                        runtimeLog.trace(
                            'bridge_detach_branch pid=%d uin=%j branch=session_closed',
                            pid,
                            uin,
                        );
                    }

                    runtimeLog.trace(
                        'bridge_detach_terminal pid=%d uin=%j outcome=completed reason=%s activePid=%j elapsedMs=%d',
                        pid,
                        uin,
                        closed ? 'session_closed' : 'pid_detached',
                        activePid,
                        Date.now() - startedAt,
                    );
                } catch (error) {
                    try {
                        runtimeLog.trace(
                            'bridge_detach_terminal pid=%d uin=%j outcome=failed reason=invariant_violation error=%j elapsedMs=%d',
                            pid,
                            uin,
                            error instanceof Error ? error.message : String(error),
                            Date.now() - startedAt,
                        );
                    } catch {
                        // Preserve the original synchronous detach failure.
                    }

                    throw error;
                }
            }),
        );
    }

    onPidReceiveHealthChanged(pid: number, healthy: boolean): void {
        this.withHealthRouting(() => this.setPidReceiveHealth(pid, healthy));
    }

    private setPidReceiveHealth(pid: number, healthy: boolean): void {
        if (this.disposal_) {
            return;
        }

        if (this.refusedHookPids_.has(pid)) {
            // This process is not a transport of any session; its health is not ours.
            return;
        }

        const uin = this.pidToUin_.get(pid);

        if (!uin) {
            const message = `BridgeManager invariant violated: receive health for unmapped PID=${pid}`;
            log.error(message);
            throw new Error(message);
        }

        const session = this.bridges.get(uin);

        if (!session || !session.hasPid(pid)) {
            const message = `BridgeManager invariant violated: receive health PID=${pid} is not owned by UIN=${uin}`;
            log.error(message);
            throw new Error(message);
        }

        const { before, revision } = this.captureHealth(session);
        session.setPidReceiveHealthy(pid, healthy);
        this.recordHealthChange(uin, session, before, revision);
    }

    onHookLogin(pid: number, uin: string, packetClient: PacketSender): void {
        if (this.disposal_ || !isRealUin(uin)) {
            return;
        }

        this.withHealthRouting(() =>
            runWithTraceRequest(() => {
                const startedAt = Date.now();
                const previousUin = this.pidToUin_.get(pid) ?? null;
                runtimeLog.trace(
                    'bridge_binding_start pid=%d uin=%j source=login previousUin=%j',
                    pid,
                    uin,
                    previousUin,
                );

                try {
                    if (this.refuseHookPid(pid, uin, 'login')) {
                        runtimeLog.trace(
                            'bridge_binding_terminal pid=%d uin=%j source=login outcome=refused reason=direct_session_owner elapsedMs=%d',
                            pid,
                            uin,
                            Date.now() - startedAt,
                        );
                        return;
                    }

                    const { session, created } = this.bindPid(pid, uin, packetClient, 'login');

                    if (previousUin && previousUin !== uin) {
                        runtimeLog.trace(
                            'bridge_binding_branch pid=%d uin=%j branch=account_rebind previousUin=%j',
                            pid,
                            uin,
                            previousUin,
                        );
                        const previousSession = this.bridges.get(previousUin);
                        runtimeLog.trace(
                            'bridge_binding_branch pid=%d uin=%j branch=%s previousUin=%j activePid=%j',
                            pid,
                            uin,
                            previousSession
                                ? 'previous_session_retained'
                                : 'previous_session_closed',
                            previousUin,
                            previousSession?.activePid ?? null,
                        );
                    }

                    if (created) {
                        runtimeLog.trace(
                            'bridge_binding_branch pid=%d uin=%j branch=session_created',
                            pid,
                            uin,
                        );
                        log.debug('session started: UIN=%s', uin);
                        this.markStartedHealthBoundary(session);
                        this.fireSessionStarted(uin, session);
                    }

                    runtimeLog.trace(
                        'bridge_binding_terminal pid=%d uin=%j source=login outcome=completed reason=%s created=%s activePid=%j elapsedMs=%d',
                        pid,
                        uin,
                        previousUin && previousUin !== uin ? 'rebound' : 'bound',
                        created,
                        session.activePid,
                        Date.now() - startedAt,
                    );
                } catch (error) {
                    try {
                        runtimeLog.trace(
                            'bridge_binding_terminal pid=%d uin=%j source=login outcome=failed reason=binding_failed error=%j elapsedMs=%d',
                            pid,
                            uin,
                            error instanceof Error ? error.message : String(error),
                            Date.now() - startedAt,
                        );
                    } catch {
                        // Preserve the original synchronous binding failure.
                    }

                    throw error;
                }
            }),
        );
    }

    onPacket(pkt: PacketInfo): void {
        if (this.disposal_) {
            return;
        }

        this.withHealthRouting(() => runWithTraceRequest(() => this.onPacketInContext(pkt)));
    }

    private onPacketInContext(pkt: PacketInfo): void {
        const startedAt = Date.now();
        packetLog.trace(() => [
            'packet_push serviceCmd=%j seqId=%d retCode=%d fromClient=%s pid=%d uin=%j length=%d body=%s',
            pkt.serviceCmd,
            pkt.seqId,
            pkt.retCode,
            pkt.fromClient,
            pkt.pid,
            pkt.uin,
            pkt.body.byteLength,
            renderTraceBytes(pkt.body),
        ]);

        if (!pkt.uin || !isRealUin(pkt.uin)) {
            packetLog.trace(() => [
                'packet_terminal serviceCmd=%j seqId=%d outcome=dropped reason=invalid_uin events=0 dispatched=0 elapsedMs=%d',
                pkt.serviceCmd,
                pkt.seqId,
                Date.now() - startedAt,
            ]);
            return;
        }

        const uin = pkt.uin;

        let completion: Promise<void>;
        let handedToPipeline = false;

        try {
            if (this.refuseHookPid(pkt.pid, uin, 'packet')) {
                packetLog.trace(() => [
                    'packet_terminal serviceCmd=%j seqId=%d outcome=dropped reason=direct_session_owner events=0 dispatched=0 elapsedMs=%d',
                    pkt.serviceCmd,
                    pkt.seqId,
                    Date.now() - startedAt,
                ]);
                return;
            }

            // A packet may be the first trustworthy observation that a live PID moved
            // to another UIN. Apply the exact same ownership transition as login so a
            // PID can never remain attached to two Bridges.
            const client = pkt.pid > 0 ? this.packetClientForPid(pkt.pid) : null;
            const { session, created } = client
                ? this.bindPid(pkt.pid, uin, client, 'packet')
                : this.ensureSession(uin);

            // Notify session started on first real packet
            if (created) {
                log.debug('session started: UIN=%s', uin);
                this.markStartedHealthBoundary(session);
                this.fireSessionStarted(uin, session);
            }

            // Dispatch packet to bridge. The pipeline preserves synchronous parsing and
            // dispatch; its promise only marks completion of any async enrichment.
            handedToPipeline = true;
            completion = session.onPacket(pkt);
        } catch (error) {
            try {
                this.tracePacketFailure(
                    pkt,
                    startedAt,
                    handedToPipeline ? 'pipeline_failed' : 'routing_failed',
                    error,
                );
            } catch {
                // Preserve the original synchronous routing or pipeline failure.
            }

            throw error;
        }

        void completion.catch((error) => {
            this.tracePacketFailure(pkt, startedAt, 'pipeline_failed', error);
        });
    }

    private tracePacketFailure(
        pkt: PacketInfo,
        startedAt: number,
        reason: 'routing_failed' | 'pipeline_failed',
        error: unknown,
    ): void {
        packetLog.trace(() => [
            'packet_terminal serviceCmd=%j seqId=%d outcome=failed reason=%s error=%j events=0 dispatched=0 elapsedMs=%d',
            pkt.serviceCmd,
            pkt.seqId,
            reason,
            error instanceof Error ? error.message : String(error),
            Date.now() - startedAt,
        ]);
        log.error(
            'packet %s failed for %s: %s',
            reason === 'routing_failed' ? 'routing' : 'pipeline',
            pkt.serviceCmd,
            error instanceof Error ? (error.stack ?? error.message) : String(error),
        );
    }

    /**
     * A direct session is the only owner of its Bridge. A hook process reporting
     * that account is released from its previous account (it no longer speaks for
     * it) and left unbound; its packets are dropped so the direct session's own
     * pushes are not duplicated. The refusal outlives the direct session: the hook
     * layer still considers the process logged in and will not repeat the login.
     */
    private refuseHookPid(pid: number, uin: string, source: 'login' | 'packet'): boolean {
        const refusedUin = this.refusedHookPids_.get(pid);

        if (!this.directSessions_.has(uin)) {
            if (source === 'packet' && refusedUin === uin) {
                return true;
            }

            this.refusedHookPids_.delete(pid);
            return false;
        }

        const previousUin = this.pidToUin_.get(pid);

        if (previousUin) {
            log.warn(
                'PID ownership changed: PID=%d UIN=%s -> UIN=%s source=%s',
                pid,
                previousUin,
                uin,
                source,
            );
            this.detachPidFromSession(pid, previousUin);
        }

        if (pid > 0) {
            this.refusedHookPids_.set(pid, uin);
        }

        if (source === 'login' || (pid > 0 && refusedUin !== uin)) {
            log.warn(
                'hook %s refused: UIN=%s is owned by a direct session; PID=%d stays unbound',
                source,
                uin,
                pid,
            );
        }

        return true;
    }

    /**
     * @internal Experimental, explicit composition only. Two-phase open of a session
     * that has no QQ process: the Bridge exists at once, so the owner can claim a
     * push port and buffer, but observers learn of the session only on `activate`.
     */
    openDirectSession(uin: string): DirectSessionHandle {
        if (this.disposal_) {
            throw new Error('BridgeManager is disposed');
        }

        if (!isRealUin(uin)) {
            throw new Error(`Direct session requires a real UIN: ${JSON.stringify(uin)}`);
        }

        if (this.bridges.has(uin)) {
            throw new Error(`Bridge session already exists: UIN=${uin}`);
        }

        const bridge = this.ensureSession(uin).session;
        const record: DirectSession = { bridge, activated: false, closing: null };
        this.directSessions_.set(uin, record);

        return Object.freeze({
            bridge,
            activate: (sender: PacketSender) => this.activateDirectSession(uin, record, sender),
            setReceiveHealthy: (healthy: boolean) =>
                this.setDirectReceiveHealth(uin, record, healthy),
            close: () => this.closeDirectSession(uin, record),
        });
    }

    private activateDirectSession(uin: string, record: DirectSession, sender: PacketSender): void {
        if (this.disposal_ || record.closing) {
            throw new Error(`Direct session is closed: UIN=${uin}`);
        }

        if (record.activated) {
            throw new Error(`Direct session is already activated: UIN=${uin}`);
        }

        const { bridge } = record;
        this.withHealthRouting(() =>
            runWithTraceRequest(() => {
                const { before, revision } = this.captureHealth(bridge);
                // Observers send packets as soon as they start, so attach first.
                bridge.attachDirectSender(sender);
                this.recordHealthChange(uin, bridge, before, revision);
                log.debug('session started: UIN=%s', uin);
                this.markStartedHealthBoundary(bridge);
                record.activated = true;
                this.fireSessionStarted(uin, bridge);
            }),
        );
    }

    private setDirectReceiveHealth(uin: string, record: DirectSession, healthy: boolean): void {
        if (this.disposal_) {
            return;
        }

        if (!record.activated || record.closing) {
            const message = `BridgeManager invariant violated: receive health for inactive direct session UIN=${uin}`;
            log.error(message);
            throw new Error(message);
        }

        const { bridge } = record;
        this.withHealthRouting(() => {
            const { before, revision } = this.captureHealth(bridge);
            bridge.setDirectReceiveHealthy(healthy);
            this.recordHealthChange(uin, bridge, before, revision);
        });
    }

    private closeDirectSession(uin: string, record: DirectSession): Promise<void> {
        if (record.closing) {
            return record.closing;
        }

        const { bridge } = record;
        let resolveClosing!: () => void;
        let rejectClosing!: (error: unknown) => void;
        // Publish the gate before observers run: a closed observer may reenter close().
        record.closing = new Promise<void>((resolve, reject) => {
            resolveClosing = resolve;
            rejectClosing = reject;
        });

        try {
            // Manager shutdown clears the registry and disposes every Bridge itself.
            if (!this.disposal_) {
                this.withHealthRouting(() => {
                    // Same order as a final PID detach: the sender is gone before
                    // observers run, and they can still read the account identity.
                    bridge.detachDirectSender();
                    this.pendingHealth.delete(bridge);
                    this.closeSession(uin, bridge, () => {
                        this.bridges.delete(uin);
                        this.directSessions_.delete(uin);

                        if (record.activated) {
                            log.debug('session closed: UIN=%s', uin);
                            this.fireSessionClosed(uin, bridge, null);
                        }
                    });
                });
            }

            void bridge.dispose().then(resolveClosing, rejectClosing);
        } catch (error) {
            rejectClosing(error);
        }

        return record.closing;
    }

    /** Bind PID + sender as one state transition. If the PID changed accounts,
     *  the old Bridge is fully detached (and, when empty, closed) before the new
     *  Bridge is created. */
    private bindPid(
        pid: number,
        uin: string,
        packetClient: PacketSender,
        source: 'login' | 'packet',
    ): { session: Bridge; created: boolean } {
        const previousUin = this.pidToUin_.get(pid);

        if (previousUin && previousUin !== uin) {
            log.warn(
                'PID ownership changed: PID=%d UIN=%s -> UIN=%s source=%s',
                pid,
                previousUin,
                uin,
                source,
            );
            this.detachPidFromSession(pid, previousUin);
        }

        const result = this.ensureSession(uin);
        const { before, revision } = this.captureHealth(result.session);
        const ownedBefore =
            previousUin === uin &&
            this.bridges.get(uin) === result.session &&
            result.session.hasPid(pid);

        try {
            result.session.bindPid(pid, packetClient);
        } catch (error) {
            // A logging callback can throw after an already-owned PID was reset
            // healthy. Report only if both sides of ownership remain consistent.
            try {
                if (
                    ownedBefore &&
                    this.bridges.get(uin) === result.session &&
                    this.pidToUin_.get(pid) === uin &&
                    result.session.hasPid(pid)
                ) {
                    this.recordHealthChange(uin, result.session, before, revision);
                }
            } catch {
                // Never replace the original bind failure with diagnostic work.
            }

            throw error;
        }

        this.pidToUin_.set(pid, uin);
        this.recordHealthChange(uin, result.session, before, revision);
        return result;
    }

    private packetClientForPid(pid: number): PacketSender | null {
        const uin = this.pidToUin_.get(pid);

        if (!uin) {
            return null;
        }

        const session = this.bridges.get(uin);

        if (!session) {
            const message = `BridgeManager invariant violated: PID=${pid} references missing UIN=${uin} session`;
            log.error(message);
            throw new Error(message);
        }

        const packetClient = session.packetClientForPid(pid);

        if (packetClient) {
            return packetClient;
        }

        const message = `BridgeManager invariant violated: PID=${pid} has no sender in UIN=${uin} session`;
        log.error(message);
        throw new Error(message);
    }

    private detachPidFromSession(pid: number, uin: string): boolean {
        const mappedUin = this.pidToUin_.get(pid);

        if (mappedUin !== uin) {
            const message = `BridgeManager invariant violated: PID=${pid} detach expected UIN=${uin}, mapped UIN=${mappedUin ?? 'none'}`;
            log.error(message);
            throw new Error(message);
        }

        const session = this.bridges.get(uin);

        if (!session) {
            const message = `BridgeManager invariant violated: PID=${pid} references missing UIN=${uin} session`;
            log.error(message);
            throw new Error(message);
        }

        if (!session.hasPid(pid)) {
            const message = `BridgeManager invariant violated: PID=${pid} is mapped to UIN=${uin}, but Bridge does not own the PID`;
            log.error(message);
            throw new Error(message);
        }

        // Validation is complete. Mutate both sides only after the ownership
        // invariant is known to hold, so a fail-fast error preserves the evidence.
        const { before, revision } = this.captureHealth(session);
        this.pidToUin_.delete(pid);

        try {
            session.detachPid(pid);
        } catch (error) {
            // A trace listener may throw after non-final removal. Only publish
            // the completed PID removal on this still-current session.
            try {
                const reboundUin = this.pidToUin_.get(pid);
                const hasCurrentOwner =
                    reboundUin === undefined ||
                    (reboundUin !== uin && this.bridges.get(reboundUin)?.hasPid(pid) === true);

                if (
                    this.bridges.get(uin) === session &&
                    !session.empty &&
                    !session.hasPid(pid) &&
                    hasCurrentOwner
                ) {
                    this.recordHealthChange(uin, session, before, revision);
                }
            } catch {
                // Preserve the original detach failure.
            }

            throw error;
        }

        if (!session.empty) {
            this.recordHealthChange(uin, session, before, revision);
            return false;
        }

        this.pendingHealth.delete(session);
        this.closeSession(uin, session, () => {
            this.bridges.delete(uin);
            log.debug('session closed: UIN=%s', uin);
            // Fire before dispose() so listeners can still read bridge.identity.
            this.fireSessionClosed(uin, session, pid);
        });
        return true;
    }

    private ensureSession(uin: string): { session: Bridge; created: boolean } {
        const session = this.bridges.get(uin);

        if (session) {
            return { session, created: false };
        }

        const closing = this.closingSessions_.get(uin);
        // allSettled, not all: a failed close stays in the bookkeeping (so
        // dispose can still report it) but must not reject this gate — a
        // rejected gate would keep the identity DB of every future session
        // for this UIN closed until the process restarts.
        const beforeOpen = closing ? Promise.allSettled(closing).then(() => undefined) : undefined;
        const bridge = new Bridge(IdentityService.openForUin(uin, 'data', beforeOpen));
        this.bridges.set(uin, bridge);

        return { session: bridge, created: true };
    }

    getBridge(uin: string): Bridge | null {
        return this.bridges.get(uin) ?? null;
    }
}
