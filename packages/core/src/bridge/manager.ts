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

export class BridgeManager implements BridgeSessionSource {
    private readonly bridges = new Map<string, Bridge>();
    private readonly pidToUin_ = new Map<number, string>();
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

        if (this.healthImmediate) {
            clearImmediate(this.healthImmediate);
            this.healthImmediate = undefined;
        }

        // Finish synchronous lifecycle observers before collecting detached sessions.
        return disposal;
    }

    private async disposeSessions(): Promise<void> {
        for (const [uin, session] of this.bridges) {
            this.closeSession(uin, session);
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

    private closeSession(uin: string, bridge: Bridge): void {
        const sessions = this.closingSessions_.get(uin) ?? new Set<Promise<void>>();
        const closing = bridge.dispose();
        sessions.add(closing);
        this.closingSessions_.set(uin, sessions);
        void closing.then(
            () => {
                sessions.delete(closing);

                if (sessions.size === 0) {
                    this.closingSessions_.delete(uin);
                }
            },
            (error) => {
                log.error(
                    'identity close failed: UIN=%s err=%s',
                    uin,
                    error instanceof Error ? (error.stack ?? error.message) : String(error),
                );
            },
        );
    }

    /** Listener changes take effect on the next event. Close observers run before
     *  Bridge disposal, so the final process and account identity remain readable. */
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

    private fireSessionClosed(uin: string, bridge: Bridge, pid: number): void {
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
                    runtimeLog.trace(
                        'bridge_detach_terminal pid=%d uin=%j outcome=failed reason=invariant_violation error=%j elapsedMs=%d',
                        pid,
                        uin,
                        error instanceof Error ? error.message : String(error),
                        Date.now() - startedAt,
                    );
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
                    runtimeLog.trace(
                        'bridge_binding_terminal pid=%d uin=%j source=login outcome=failed reason=binding_failed error=%j elapsedMs=%d',
                        pid,
                        uin,
                        error instanceof Error ? error.message : String(error),
                        Date.now() - startedAt,
                    );
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
            this.tracePacketFailure(
                pkt,
                startedAt,
                handedToPipeline ? 'pipeline_failed' : 'routing_failed',
                error,
            );
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
        this.bridges.delete(uin);
        log.debug('session closed: UIN=%s', uin);
        // Fire before dispose() so listeners can still read bridge.identity.
        this.fireSessionClosed(uin, session, pid);
        this.closeSession(uin, session);
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
