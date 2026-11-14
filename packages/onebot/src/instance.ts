import { APP_VERSION } from '@snowluma/common/version';
import { createLogger, type Logger } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import {
    formatGroup,
    formatMessageSegments,
    formatReply,
    formatUser,
} from '@snowluma/protocol/format';
import path from 'path';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { ApiHandler, type ActionObserver } from './api-handler';
import type { ConverterContext } from './event-converter';
import { registerEventPipeline, type EventPipelineHandle } from './event-pipeline';
import { buildApiContext, type OneBotInstanceContext } from './instance-context';
import { TempSessionStore } from './temp-session-store';
import { RKeyCache } from './instance-rkey';
import type { GlobalSettings } from './global-config';
import { MediaIndexer } from './media-indexer';
import { MediaStore } from './media-store';
import { MediaUrlResolver } from './media-url-resolver';
import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT, privateMessageEventName } from './message-id';
import { MessageStore } from './message-store';
import { createMessageIdResolver } from './message-id-resolver';
import { sendGroupMessage, sendPrivateMessage } from './modules/message-actions';
import {
    buildStatusText,
    matchesStatusCommand,
    statusCooldownElapsed,
} from './modules/status-command';
import { loginHistorySyncCoordinator } from './history-sync';
import {
    HttpPostAdapter,
    HttpServerAdapter,
    OneBotNetworkManager,
    WsClientAdapter,
    WsServerAdapter,
    type AdapterStatus,
    type DesiredNetworkAdapter,
    type NetworkAdapterContext,
    type NetworkReconcileResult,
    type NetworkShutdownResult,
} from './network';
import {
    PluginHost,
    PluginHostError,
    type PluginDisplaySidecar,
    type PluginStatus,
} from './plugin-host';
import { ReactionStore } from './reaction-store';
import { sameSelfSentMessage, selfSentEventKey, SELF_SENT_ECHO_WINDOW_MS } from './self-sent-event';
import type { ApiResponse, JsonObject, JsonValue, MessageMeta, OneBotConfig } from './types';
import { V12Runtime } from './v12-runtime/runtime';
import { createPollGate, invalidatePollOwner } from './v12-runtime/poll-owner';
import { V12_ADAPTER_NAME } from './v12-runtime/identity';
import {
    captureBinding,
    captureSource,
    SourceGeneration,
    type V12Source,
} from './v12-runtime/source-generation';

const moduleLog = createLogger('Event');

export class OneBotInstance {
    readonly uin: string;

    private readonly bridge: BridgeInterface;
    private readonly apiHandler: ApiHandler;
    private readonly converterCtx: ConverterContext;
    private readonly messageStore: MessageStore;
    private readonly mediaStore: MediaStore;
    private readonly reactionStore: ReactionStore;
    private readonly networkManager: OneBotNetworkManager;
    private readonly networkReady: Promise<NetworkReconcileResult>;
    private lifecycleTail: Promise<void>;
    private readonly rkeyCache: RKeyCache;
    private readonly ctx: OneBotInstanceContext;
    /** Account-session uptime shared by the status action and `#sl`. */
    private readonly startedAt = Date.now();
    /** Per-conversation last-reply timestamp for the `#sl` cooldown. */
    private readonly statusCommandCooldown = new Map<string, number>();
    /** Reported self sends retained while matching subsequent QQ echoes. */
    private readonly recentSelfSentEvents = new Map<
        string,
        { event: JsonObject; expiresAt: number }
    >();
    private eventPipeline: EventPipelineHandle | null = null;
    private eventPipelineDrain: Promise<void> = Promise.resolve();
    private disposePromise: Promise<NetworkShutdownResult> | null = null;
    private disposeRequested = false;
    private acceptingActions = true;
    private readonly inFlightActions = new Set<Promise<void>>();
    private readonly pluginWorkspace = path.resolve(process.cwd());
    private pluginHost: PluginHost | null = null;
    private pluginShutdown: Promise<void> | null = null;
    private readonly historySyncAbortController = new AbortController();
    private readonly historySyncEnabledAtStartup: boolean;
    private historySyncStartRequested = false;
    private historySyncTask: Promise<void> | null = null;
    private readonly storeCloseState = {
        message: false,
        media: false,
        reaction: false,
    };

    private readonly pids = new Set<number>();
    private online = true;
    // V12 reports the explicit account-session edge, not listener connectivity.
    private v12Online = false;
    private readonly sourceGeneration = new SourceGeneration();
    private readonly v12PollGate = createPollGate();
    private v12Adapter: V12Runtime | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private static readonly HEARTBEAT_INTERVAL = 30000;
    private readonly log: Logger;

    get nickname(): string {
        return this.bridge.identity.nickname;
    }

    /** Live status of this account's OneBot network adapters. */
    getConnectionStatuses(): AdapterStatus[] {
        return this.networkManager.describeStatuses();
    }

    /**
     * Execute an explicitly selected local ESM plugin in this Node process.
     * Plugins have full process permissions; this is not an isolation boundary.
     * Disable and shutdown do not unload ESM or guarantee that background work stopped.
     * This trusted local API must not be exposed directly to untrusted web input.
     */
    enablePlugin(id: string, absoluteDirectory: string): Promise<void> {
        if (this.disposeRequested) {
            return Promise.reject(new Error(`OneBot instance UIN=${this.uin} is disposing`));
        }

        try {
            const stateRoot = this.preparePluginStateRoot();
            this.pluginHost ??= new PluginHost({
                accountId: this.uin,
                stateRoot,
                // Network credentials and account configuration are not plugin context.
                managerConfig: Object.freeze({}),
                invokeAction: (action, params) => this.invokeAction(action, params),
                isStreamAction: (action) => this.apiHandler.isStreamAction(action),
                // Plugin-supplied log arguments can contain secrets. Keep diagnostics
                // bounded and do not forward arbitrary objects or strings.
                logger: (level, pluginId) =>
                    this.log.warn('plugin [%s] emitted log level=%s', pluginId, level),
            });
            return this.pluginHost.enable(id, absoluteDirectory);
        } catch (error) {
            return Promise.reject(error);
        }
    }

    /** Stop new events, drain accepted hooks and retry a failed plugin cleanup.
     * With no host this is a no-op, not proof that process resources stopped. */
    disablePlugin(id: string): Promise<void> {
        return this.pluginHost?.disable(id) ?? Promise.resolve();
    }

    /** Snapshot for management UI; enablePlugin rechecks when invoked. */
    canEnablePlugins(): boolean {
        return !this.disposeRequested;
    }

    /** Live host observations; a missing plugin does not prove its resources stopped. */
    listPlugins(): PluginStatus[] {
        return this.pluginHost?.listStatuses() ?? [];
    }

    getPluginStatus(id: string): PluginStatus | null {
        return this.listPlugins().find((status) => status.id === id) ?? null;
    }

    /** Opaque identity of the current active plugin slot, without creating a host. */
    getPluginConfigGeneration(id: string): string | null {
        if (this.disposeRequested) {
            return null;
        }

        return this.pluginHost?.getConfigGeneration(id) ?? null;
    }

    /** Configuration is available only to explicitly enabled plugins. */
    getPluginConfigSchema(
        id: string,
    ): Promise<{
        fields: JsonValue[] | null;
        source: 'schema' | 'ui' | 'none';
        displaySidecar?: PluginDisplaySidecar;
    }> {
        if (this.disposeRequested) {
            return Promise.reject(new PluginHostError('CLOSED'));
        }

        if (!this.pluginHost) {
            return Promise.reject(new PluginHostError('PLUGIN_INACTIVE'));
        }

        return this.pluginHost.getConfigSchema(id);
    }

    getPluginConfig(id: string): Promise<{ value: JsonObject; source: 'plugin' }> {
        if (this.disposeRequested) {
            return Promise.reject(new PluginHostError('CLOSED'));
        }

        if (!this.pluginHost) {
            return Promise.reject(new PluginHostError('PLUGIN_INACTIVE'));
        }

        return this.pluginHost.getConfig(id);
    }

    setPluginConfig(id: string, value: unknown): Promise<{ persistence: 'plugin-managed' }> {
        if (this.disposeRequested) {
            return Promise.reject(new PluginHostError('CLOSED'));
        }

        if (!this.pluginHost) {
            return Promise.reject(new PluginHostError('PLUGIN_INACTIVE'));
        }

        return this.pluginHost.setConfig(id, value);
    }

    private preparePluginStateRoot(): string {
        const workspace = realpathSync(this.pluginWorkspace);
        let parent = workspace;

        for (const component of ['data', 'plugins']) {
            const candidate = path.join(parent, component);

            try {
                mkdirSync(candidate);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                    throw error;
                }
            }

            const info = lstatSync(candidate);
            const resolved = realpathSync(candidate);
            const relative = path.relative(workspace, resolved);

            if (
                info.isSymbolicLink() ||
                !info.isDirectory() ||
                !relative ||
                relative === '..' ||
                relative.startsWith(`..${path.sep}`) ||
                path.isAbsolute(relative)
            ) {
                throw new Error('Plugin state root escapes workspace data');
            }

            parent = resolved;
        }

        return parent;
    }

    // ── Debug taps (WebUI debug stream / tester) ──
    /** Tap every emitted OneBot event for this account. Returns an unsubscribe. */
    subscribeDebugEvents(cb: (event: JsonObject) => void): () => void {
        return this.networkManager.subscribeDebug(cb);
    }
    /** Observe every handled action for this account. Returns an unsubscribe. */
    observeActions(cb: ActionObserver): () => void {
        return this.apiHandler.setObserver(cb);
    }
    /** Invoke an OneBot action against this account (debug tester). */
    invokeAction(action: string, params: JsonObject): Promise<ApiResponse> {
        return this.trackAction(`debug action ${action}`, () =>
            this.apiHandler.handle(action, params),
        );
    }
    /** Drive an action through the streaming seam (debug tester, stream actions).
     *  `rawRequest` is a `{action, params, echo?}` JSON string; `emit` receives
     *  each frame as a JSON string. Non-stream actions emit a single frame. */
    invokeStream(
        rawRequest: string,
        emit: (json: string) => void | Promise<void>,
        isAlive?: () => boolean,
    ): Promise<void> {
        return this.trackAction('debug stream action', () =>
            this.apiHandler.processStreamRequest(rawRequest, emit, isAlive),
        );
    }

    constructor(
        uin: string,
        bridge: BridgeInterface,
        config: OneBotConfig,
        globalSettings: GlobalSettings,
    ) {
        this.uin = uin;
        this.bridge = bridge;
        this.historySyncEnabledAtStartup = config.historySync.enabled;
        const uinNum = Number.parseInt(uin, 10);
        this.log =
            Number.isFinite(uinNum) && uinNum > 0 ? moduleLog.child({ uin: uinNum }) : moduleLog;

        this.rkeyCache = new RKeyCache(globalSettings.rkey);
        this.mediaStore = new MediaStore(path.join('data', this.uin, 'messages.db'));
        this.messageStore = new MessageStore(path.join('data', this.uin, 'messages.json'));
        this.reactionStore = new ReactionStore(path.join('data', this.uin, 'reactions.db'));
        const mediaUrlResolver = new MediaUrlResolver(this.bridge, this.rkeyCache);
        const mediaIndexer = new MediaIndexer(this.mediaStore);
        this.converterCtx = {
            selfId: parseInt(this.uin, 10) || 0,
            imageUrlResolver: (element, isGroup) =>
                this.rkeyCache.resolveImageUrl(this.bridge, element, isGroup),
            mediaUrlResolver: (element, isGroup, sessionId) =>
                mediaUrlResolver.resolve(element, isGroup, sessionId),
            messageIdResolver: createMessageIdResolver(this.messageStore),
            mediaSegmentSink: async (mediaType, element, data, isGroup, sessionId) =>
                await mediaIndexer.remember(mediaType, element, data, isGroup, sessionId),
        };
        const ctx: OneBotInstanceContext = {
            uin: this.uin,
            selfId: parseInt(this.uin, 10) || 0,
            bridge: this.bridge,
            messageStore: this.messageStore,
            mediaStore: this.mediaStore,
            reactionStore: this.reactionStore,
            tempSessions: new TempSessionStore(),
            converterCtx: this.converterCtx,
            config,
            musicSignUrl: globalSettings.musicSignUrl,
            getUptimeMs: () => Math.max(0, Date.now() - this.startedAt),
            cacheMessageMeta: async (messageId, meta) =>
                await this.cacheMessageMeta(messageId, meta),
            [captureSource]: () => this.captureEventSource(),
            dispatchEvent: (event, source = 'bridge', startedAt, sourceTicket) =>
                sourceTicket === undefined
                    ? this.dispatchEvent(event, source, startedAt)
                    : this.dispatchEvent(event, source, startedAt, sourceTicket),
        };
        this.ctx = ctx;

        this.apiHandler = new ApiHandler(buildApiContext(ctx), uinNum > 0 ? uinNum : undefined);
        const networkCtx = this.buildNetworkContext();
        this.networkManager = new OneBotNetworkManager((desired) =>
            this.createNetworkAdapter(desired, networkCtx),
        );
        this.networkReady = Promise.all([
            bridge.identity.initialization,
            this.messageStore.initialization,
            this.mediaStore.initialization,
            this.reactionStore.initialization,
        ]).then(() => this.networkManager.reconcile(config));
        this.lifecycleTail = this.networkReady.then(
            () => undefined,
            () => undefined,
        );

        this.startHeartbeat();
        this.rkeyCache.warmUp(this.bridge, this.uin);
        this.eventPipeline = registerEventPipeline(ctx);
    }

    waitUntilNetworkReady(): Promise<NetworkReconcileResult> {
        return this.networkReady;
    }

    /** Refresh only this live account's v12 status from its current Bridge. */
    receiveHealthChanged(bridge: BridgeInterface): void {
        if (this.disposeRequested || !this.v12Online || this.bridge !== bridge) {
            return;
        }

        this.v12Adapter?.statusUpdate();
    }

    /** Bridge session edge → OneBot notice. Awaited so offline can leave
     *  adapters before this generation is disposed. */
    emitBotStatus(subType: 'online' | 'offline'): Promise<void> {
        this.sourceGeneration?.setOnline(!this.disposeRequested && subType === 'online');
        this.v12Online = subType === 'online';
        this.v12Adapter?.statusUpdate();
        return this.dispatchEvent(makeBotStatusEvent(parseInt(this.uin, 10) || 0, subType));
    }

    /**
     * Start the optional login-time backfill once roster warmup has completed.
     * The startup snapshot is intentional: hot config edits take effect on the
     * next account lifecycle and never cause an unexpected QQ request.
     */
    startLoginHistorySync(): void {
        if (this.historySyncStartRequested || this.disposeRequested) {
            return;
        }

        this.historySyncStartRequested = true;

        if (!this.historySyncEnabledAtStartup) {
            this.log.debug('login history sync disabled for this account lifecycle');
            return;
        }

        this.historySyncTask = loginHistorySyncCoordinator
            .schedule(
                {
                    selfId: Number.parseInt(this.uin, 10) || 0,
                    bridge: this.bridge,
                    messageStore: this.messageStore,
                    converterCtx: this.converterCtx,
                },
                this.historySyncAbortController.signal,
            )
            .then(
                () => undefined,
                (error) => {
                    if (this.historySyncAbortController.signal.aborted) {
                        this.log.debug(
                            'login history sync cancelled: %s',
                            error instanceof Error ? error.message : String(error),
                        );
                        return;
                    }

                    this.log.error(
                        'login history sync failed: %s',
                        error instanceof Error ? (error.stack ?? error.message) : String(error),
                    );
                },
            );
    }

    reloadConfig(config: OneBotConfig): Promise<NetworkReconcileResult> {
        if (this.disposeRequested) {
            return Promise.reject(new Error(`OneBot instance UIN=${this.uin} is disposing`));
        }

        const snapshot = structuredClone(config);
        // Validate before entering the FIFO so deterministic errors fail fast.
        this.networkManager.compileDesiredPlan(snapshot);
        return this.enqueueLifecycle(async () => {
            // Keep the shared context's config in sync for exactly the same ordered
            // snapshot the network manager is applying. Concurrent POSTs therefore
            // linearize as A then B instead of publishing B while A is reconciling.
            this.ctx.config = snapshot;
            return this.networkManager.reconcile(snapshot);
        });
    }

    /** Apply edited global (all-accounts) settings without a restart. Called by
     *  the manager when config/snowluma.json is saved from the WebUI. */
    applyGlobalSettings(globalSettings: GlobalSettings): void {
        this.rkeyCache.setFallbackServers(globalSettings.rkey.fallbackServers);
        this.ctx.musicSignUrl = globalSettings.musicSignUrl;
    }

    /** Drop listeners and sockets without waiting for shutdown to finish.
     *  Used when dispose() does not settle and a replacement session must bind. */
    forceRelease(): void {
        try {
            this.quiesce();
        } catch (error) {
            this.log.warn(
                'quiesce during forced release failed: %s',
                error instanceof Error ? error.message : String(error),
            );
        }

        this.v12Adapter?.forceClose();
        this.networkManager.forceRelease();
    }

    /** Synchronously stop every ingress seam for this instance generation.
     *
     * This operation is sticky and idempotent. It is intentionally separate
     * from the asynchronous resource release so the manager can quiesce all
     * generations before waiting for older lifecycle work to settle. */
    quiesce(): void {
        if (this.disposeRequested) {
            return;
        }

        this.disposeRequested = true;
        this.sourceGeneration?.setOnline(false);
        this.acceptingActions = false;
        this.v12Online = false;
        this.v12Adapter?.quiesce();
        this.apiHandler.quiesce();

        // shutdown() closes plugin event admission synchronously. Existing hooks
        // and cleanup can drain, but new actions follow the normal quiesce gate.
        if (this.pluginHost) {
            this.pluginShutdown = this.pluginHost.shutdown();
            void this.pluginShutdown.catch(() => undefined);
        }

        this.online = false;
        this.stopHeartbeat();
        this.historySyncAbortController?.abort(
            new Error(`OneBot instance UIN=${this.uin} is disposing`),
        );
        const pipeline = this.eventPipeline;

        if (pipeline) {
            pipeline.stop();
            this.eventPipeline = null;
            this.eventPipelineDrain = pipeline.drain();
        }
    }

    dispose(): Promise<NetworkShutdownResult> {
        if (this.disposePromise) {
            return this.disposePromise;
        }

        this.quiesce();
        const attempt = this.enqueueLifecycle(async () => {
            if (this.pluginHost) {
                const pluginShutdown = this.pluginShutdown ?? this.pluginHost.shutdown();
                this.pluginShutdown = null;

                try {
                    await pluginShutdown;
                } catch (error) {
                    throw new AggregateError(
                        [error],
                        `plugin shutdown incomplete for UIN=${this.uin}; stores remain open`,
                    );
                }
            }

            await Promise.all([
                Promise.all(this.inFlightActions),
                this.eventPipelineDrain,
                this.historySyncTask ?? Promise.resolve(),
            ]);
            const shutdown = await this.networkManager.shutdown();

            if (!shutdown.closed) {
                throw new AggregateError(
                    shutdown.errors.map(
                        (error) =>
                            new Error(
                                `adapter ${error.name} ${error.phase} failed: ${error.message}`,
                            ),
                    ),
                    `network shutdown incomplete for UIN=${this.uin}; stores remain open`,
                );
            }

            // Stores are intentionally closed only after every queued network
            // reconcile and every transport have actually closed.
            const closeErrors: unknown[] = [];
            const stores = [
                ['message', async () => await this.messageStore.close()],
                ['media', async () => await this.mediaStore.close()],
                ['reaction', async () => await this.reactionStore.close()],
            ] as const;

            for (const [name, close] of stores) {
                if (this.storeCloseState[name]) {
                    continue;
                }

                try {
                    await close();
                    this.storeCloseState[name] = true;
                } catch (error) {
                    closeErrors.push(error);
                }
            }

            if (closeErrors.length > 0) {
                throw new AggregateError(
                    closeErrors,
                    `failed to close OneBot stores for UIN=${this.uin}`,
                );
            }

            return shutdown;
        });
        this.disposePromise = attempt;
        void attempt.then(
            () => undefined,
            () => {
                // Network-close and per-store completion state are retained. Let a
                // later dispose call retry only the meaningful unfinished remainder.
                if (this.disposePromise === attempt) {
                    this.disposePromise = null;
                }
            },
        );
        return attempt;
    }

    addPid(pid: number): void {
        this.pids.add(pid);
    }

    removePid(pid: number): void {
        this.pids.delete(pid);
    }

    hasPid(pid: number): boolean {
        return this.pids.has(pid);
    }

    getPids(): number[] {
        return [...this.pids];
    }

    get empty(): boolean {
        return this.pids.size === 0;
    }

    private async dispatchEvent(
        event: JsonObject,
        source: 'bridge' | 'send' = 'bridge',
        startedAt = Date.now(),
        sourceTicket?: V12Source,
    ): Promise<void> {
        if (!(await this.cacheMessageEvent(event))) {
            this.traceEventHandoffTerminal(event, startedAt, 'suppressed', 'private_recall');
            return;
        }

        if (source === 'bridge') {
            if (this.isDuplicateSelfSentEcho(event)) {
                this.log.trace(
                    'duplicate self-message echo suppressed message_id=%d message_seq=%d',
                    toInt(event.message_id),
                    toInt(event.message_seq),
                );
                this.traceEventHandoffTerminal(
                    event,
                    startedAt,
                    'suppressed',
                    'duplicate_self_echo',
                );
                return;
            }

            if (event.post_type === 'message_sent') {
                this.rememberSelfSentEvent(event);
            }
        } else {
            this.rememberSelfSentEvent(event);
        }

        // The send path already logged the real peer and payload. Logging its
        // synthetic event here would produce a second, less accurate "received"
        // line whose private user_id points at the bot itself.
        if (source === 'bridge') {
            await this.logReceivedMessage(event);
        }

        // Built-in `#sl` only consumes events observed from QQ. Action-originated
        // messages must not recursively trigger the command handler.
        if (source === 'bridge' && this.handleStatusCommand(event)) {
            this.traceEventHandoffTerminal(event, startedAt, 'suppressed', 'status_command');
            return;
        }

        this.traceEventHandoffTerminal(event, startedAt, 'reporting_started');

        try {
            const result = this.pluginHost?.dispatch(event);

            if (result && result.dropped > 0) {
                this.log.warn('plugin event admission dropped=%d', result.dropped);
            }
        } catch {
            // A plugin failure must not prevent the v11 network handoff.
            this.log.warn('plugin event admission failed');
        }

        try {
            if (sourceTicket === undefined) {
                await this.networkManager.emitEvent(event);
            } else {
                await this.networkManager.emitEvent(event, sourceTicket);
            }
        } catch (err) {
            this.log.warn(
                'emitEvent failed: %s',
                err instanceof Error ? (err.stack ?? err.message) : String(err),
            );
        }
    }

    private traceEventHandoffTerminal(
        event: JsonObject,
        startedAt: number,
        outcome: 'suppressed' | 'reporting_started',
        reason?: 'duplicate_self_echo' | 'status_command' | 'private_recall',
    ): void {
        this.log.trace(() => [
            'event_terminal post_type=%s outcome=%s%s ms=%d',
            String(event.post_type ?? '?'),
            outcome,
            reason === undefined ? '' : ` reason=${reason}`,
            Date.now() - startedAt,
        ]);
    }

    private rememberSelfSentEvent(event: JsonObject): void {
        const key = selfSentEventKey(event);

        if (key === null) {
            return;
        }

        const now = Date.now();
        this.sweepSelfSentEvents(now);
        this.recentSelfSentEvents.set(key, { event, expiresAt: now + SELF_SENT_ECHO_WINDOW_MS });
    }

    private isDuplicateSelfSentEcho(event: JsonObject): boolean {
        const key = selfSentEventKey(event);

        if (key === null) {
            return false;
        }

        const now = Date.now();
        this.sweepSelfSentEvents(now);
        const pending = this.recentSelfSentEvents.get(key);

        if (!pending || !sameSelfSentMessage(pending.event, event)) {
            return false;
        }

        return true;
    }

    private sweepSelfSentEvents(now: number): void {
        for (const [key, pending] of this.recentSelfSentEvents) {
            if (pending.expiresAt <= now) {
                this.recentSelfSentEvents.delete(key);
            }
        }
    }

    /**
     * Built-in `#sl` status command. Returns `true` when the event matched AND
     * `swallow` is configured — the caller then skips `emitEvent` so downstream
     * adapters never see it. The reply itself is fired async and rate-limited
     * per conversation; matching and replying are independent of swallowing.
     */
    private handleStatusCommand(event: JsonObject): boolean {
        const cfg = this.ctx.config.statusCommand;

        if (!cfg.enabled) {
            return false;
        }

        const postType = event.post_type;

        if (postType !== 'message' && postType !== 'message_sent') {
            return false;
        }

        if (!matchesStatusCommand(event.message, cfg.trigger)) {
            return false;
        }

        const isGroup = event.message_type === 'group';
        const sessionId = isGroup ? toInt(event.group_id) : toInt(event.user_id);

        if (sessionId === 0) {
            return cfg.swallow;
        }

        const key = `${isGroup ? 'g' : 'p'}:${sessionId}`;
        const now = Date.now();

        if (statusCooldownElapsed(this.statusCommandCooldown.get(key), now, cfg.cooldownSeconds)) {
            this.statusCommandCooldown.set(key, now);
            void this.trackAction('status command reply', () =>
                this.replyStatus(isGroup, sessionId),
            );
        }

        return cfg.swallow;
    }

    private async replyStatus(isGroup: boolean, sessionId: number): Promise<void> {
        const text = buildStatusText({
            version: APP_VERSION,
            platform: process.platform,
            arch: process.arch,
            uptimeMs: this.ctx.getUptimeMs(),
        });

        if (isGroup) {
            await sendGroupMessage(this.ctx, sessionId, text, true);
        } else {
            await sendPrivateMessage(this.ctx, sessionId, text, true);
        }
    }

    private buildNetworkContext(): NetworkAdapterContext {
        return {
            uin: this.uin,
            api: this.apiHandler,
            buildLifecycleEvent: (subType) => this.makeLifecycleEvent(subType),
            buildHeartbeatEvent: () => this.makeHeartbeatEvent(),
        };
    }

    private captureEventSource(): V12Source | undefined {
        const adapter = this.v12Adapter;

        if (
            !adapter ||
            this.disposeRequested ||
            this.networkManager.get(V12_ADAPTER_NAME) !== adapter
        ) {
            return undefined;
        }

        return this.sourceGeneration?.capture(adapter[captureBinding]());
    }

    private createNetworkAdapter(desired: DesiredNetworkAdapter, ctx: NetworkAdapterContext) {
        switch (desired.kind) {
            case 'httpServer':
                return new HttpServerAdapter(desired.name, desired.config, ctx);
            case 'httpClient':
                return new HttpPostAdapter(desired.name, desired.config, ctx);
            case 'wsServer':
                return new WsServerAdapter(desired.name, desired.config, ctx);
            case 'wsClient':
                return new WsClientAdapter(desired.name, desired.config, ctx);

            case 'v12Server': {
                const adapter: V12Runtime = new V12Runtime(desired.config, ctx, {
                    getStatus: () => ({
                        online: this.v12Online,
                        good: this.v12Online && this.bridge.receiveHealthy,
                    }),
                    getSentMessageTime: async (id) =>
                        (await this.messageStore.findMeta(id))?.timestamp ?? null,
                    trackAction: (label, start) => this.trackAction(label, start),
                    canAccept: () => !this.disposeRequested,
                    captureCurrentSource: () => this.captureEventSource(),
                    pollGate: this.v12PollGate,
                    isSourceCurrent: (source, binding) =>
                        !this.disposeRequested &&
                        this.v12Adapter === adapter &&
                        this.networkManager.get(V12_ADAPTER_NAME) === adapter &&
                        (this.sourceGeneration?.isCurrent(source, binding) ?? false),
                });

                try {
                    if (this.v12Adapter) {
                        invalidatePollOwner(this.v12Adapter);
                    }
                } catch {
                    // Revoke poll ownership without changing adapter replacement.
                }

                this.v12Adapter = adapter;
                return adapter;
            }
        }
    }

    private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.lifecycleTail.then(operation);
        this.lifecycleTail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    private trackAction<T>(label: string, start: () => Promise<T>): Promise<T> {
        if (!this.acceptingActions) {
            return this.rejectedAction(
                label,
                new Error(`OneBot instance UIN=${this.uin} is disposing; ${label} rejected`),
            );
        }

        let action: Promise<T>;

        try {
            action = start();
        } catch (error) {
            return this.rejectedAction(label, error);
        }

        const tracked = action.then(
            () => undefined,
            (error) => {
                this.log.error(
                    '%s failed: %s',
                    label,
                    error instanceof Error ? (error.stack ?? error.message) : String(error),
                );
            },
        );
        this.inFlightActions.add(tracked);
        void tracked.then(() => {
            this.inFlightActions.delete(tracked);
        });
        return action;
    }

    private rejectedAction<T>(label: string, error: unknown): Promise<T> {
        const rejected = Promise.reject<T>(error);
        void rejected.catch((reason) => {
            this.log.error(
                '%s rejected: %s',
                label,
                reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
            );
        });
        return rejected;
    }

    private async logReceivedMessage(event: JsonObject): Promise<void> {
        const isSelf = event.post_type === 'message_sent';

        if (event.post_type !== 'message' && !isSelf) {
            return;
        }

        const messageId = toInt(event.message_id);
        const isGroup = event.message_type === 'group';
        const idStr = `ID:${messageId}`;
        const selfTag = isSelf ? '[自身] ' : '';
        const identity = this.bridge.identity;

        // Walk the segment array once: render via the shared formatter for
        // non-reply segments, and resolve `reply` segments through the
        // message store so the chain reference becomes legible
        // ("[回复 <user>: <body>...]" instead of "[回复:1234567890]").
        const renderedParts: string[] = [];
        const message = event.message;

        if (Array.isArray(message)) {
            for (const seg of message) {
                if (typeof seg !== 'object' || seg === null || Array.isArray(seg)) {
                    continue;
                }

                const type = String((seg as JsonObject).type ?? '');
                const data =
                    typeof (seg as JsonObject).data === 'object' &&
                    (seg as JsonObject).data !== null &&
                    !Array.isArray((seg as JsonObject).data)
                        ? ((seg as JsonObject).data as Record<string, unknown>)
                        : {};

                if (type === 'reply') {
                    const replyId = toInt(data.id);
                    renderedParts.push(await formatReply(this.messageStore, identity, replyId));
                } else {
                    renderedParts.push(formatMessageSegments([seg as JsonValue]));
                }
            }
        } else if (typeof message === 'string') {
            renderedParts.push(formatMessageSegments(message));
        }

        const content = renderedParts.join(' ').trim() || '[空消息]';

        if (isGroup) {
            const groupId = toInt(event.group_id);
            const userId = toInt(event.user_id);
            const sender =
                typeof event.sender === 'object' &&
                event.sender !== null &&
                !Array.isArray(event.sender)
                    ? (event.sender as JsonObject)
                    : {};
            const nicknameFromEvent = (sender.card as string) || (sender.nickname as string) || '';
            const userPart = nicknameFromEvent
                ? `[${nicknameFromEvent}(${userId})]`
                : formatUser(identity, groupId, userId);
            this.log.success(
                `${selfTag}群 ${formatGroup(identity, groupId)} | ${userPart}: ${idStr} ${content}`,
            );
        } else {
            const userId = toInt(event.user_id);
            const sender =
                typeof event.sender === 'object' &&
                event.sender !== null &&
                !Array.isArray(event.sender)
                    ? (event.sender as JsonObject)
                    : {};
            const nicknameFromEvent = (sender.nickname as string) || '';
            const userPart = nicknameFromEvent
                ? `[${nicknameFromEvent}(${userId})]`
                : formatUser(identity, undefined, userId);
            this.log.success(`${selfTag}私聊 ${userPart}: ${idStr} ${content}`);
        }
    }

    private async cacheMessageEvent(event: JsonObject): Promise<boolean> {
        if (event.post_type !== 'message' && event.post_type !== 'message_sent') {
            return true;
        }

        const messageId = toInt(event.message_id);

        if (messageId === 0) {
            return true;
        }

        const isGroup = event.message_type === 'group';
        const sessionId = isGroup
            ? toInt(event.group_id)
            : event.post_type === 'message_sent'
              ? toInt(event.target_id) || toInt(event.user_id)
              : toInt(event.user_id);
        const sequence = toInt(event.message_seq);
        const eventName = isGroup
            ? GROUP_MESSAGE_EVENT
            : event.sub_type === 'friend'
              ? privateMessageEventName(event.post_type === 'message_sent', false)
              : PRIVATE_MESSAGE_EVENT;

        if (sessionId === 0) {
            return true;
        }

        return this.messageStore.storeEvent(
            messageId,
            isGroup,
            sessionId,
            sequence,
            eventName,
            event,
        );
    }

    private async cacheMessageMeta(messageId: number, meta: MessageMeta): Promise<void> {
        if (!Number.isInteger(messageId) || messageId === 0) {
            return;
        }

        await this.messageStore.storeMeta(messageId, meta);
    }

    private makeLifecycleEvent(subType: 'connect' | 'enable' | 'disable'): JsonObject {
        const selfId = parseInt(this.uin, 10) || 0;
        const time = Math.floor(Date.now() / 1000);
        return {
            time,
            self_id: selfId,
            post_type: 'meta_event',
            meta_event_type: 'lifecycle',
            sub_type: subType,
            status: {
                online: this.online,
                good: this.online && this.bridge.receiveHealthy,
            },
        };
    }
    private startHeartbeat(): void {
        this.heartbeatTimer = setInterval(() => {
            this.dispatchEvent(this.makeHeartbeatEvent());
        }, OneBotInstance.HEARTBEAT_INTERVAL);
        this.heartbeatTimer.unref();
    }

    private makeHeartbeatEvent(): JsonObject {
        const selfId = parseInt(this.uin, 10) || 0;
        const time = Math.floor(Date.now() / 1000);
        return {
            time,
            self_id: selfId,
            post_type: 'meta_event',
            meta_event_type: 'heartbeat',
            status: { online: this.online, good: this.online && this.bridge.receiveHealthy },
            interval: OneBotInstance.HEARTBEAT_INTERVAL,
        };
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
}

export function makeBotStatusEvent(
    selfId: number,
    subType: 'online' | 'offline',
    time = Math.floor(Date.now() / 1000),
): JsonObject {
    return {
        time,
        self_id: selfId,
        post_type: 'notice',
        notice_type: 'bot_status',
        sub_type: subType,
        user_id: selfId,
    };
}

function toInt(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.trunc(value);
    }

    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);

        if (Number.isFinite(parsed)) {
            return Math.trunc(parsed);
        }
    }

    return 0;
}
