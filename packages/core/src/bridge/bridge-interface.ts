import type { OnlineDeviceInfo } from '@snowluma/protocol/events';
import type { BridgeContext } from './bridge-context';

export interface RosterWarmupResult {
    friendsLoaded: boolean;
    groupsLoaded: boolean;
}

export interface BridgeInterface extends BridgeContext {
    /** Newest attached QQ process. `null` when none is attached, which is always
     *  the case for a direct (non-hook) session. */
    readonly activePid: number | null;
    /** Settles once for this Bridge session after first-login roster fetch. */
    whenRosterWarmupSettled(): Promise<RosterWarmupResult>;
    /** False when no sender is attached, or when every attached QQ process (or the
     *  direct session's sender) has a confirmed receive or request-path failure.
     *  An unarmed watchdog remains true for compatibility. */
    readonly receiveHealthy: boolean;
    /** Latest device snapshot observed on this Bridge lifecycle. `null` means
     *  QQ has not emitted its cache notification since SnowLuma attached. */
    getOnlineClients(): readonly Readonly<OnlineDeviceInfo>[] | null;
}

export interface BridgeSessionListener {
    started?(uin: string, bridge: BridgeInterface): void;
    /** `pid` is the last QQ process detached from the session, or `null` when the
     *  session was a direct (non-hook) session that never had one. */
    closed?(uin: string, bridge: BridgeInterface, pid: number | null): void;
    /** Manager-observed aggregate health changes, delivered latest-wins for this exact session.
     *  Direct Bridge disposal and same-PID callbacks from an old generation are outside this contract. */
    receiveHealthChanged?(uin: string, bridge: BridgeInterface): void;
}

export interface BridgeSessionSource {
    subscribeSessions(listener: BridgeSessionListener): () => void;
}
