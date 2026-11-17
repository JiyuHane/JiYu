import { isPromise, isProxy } from 'node:util/types';
import { renderParamsVerbose, summarizeParams } from '@snowluma/common/log-summary';
import { createLogger, runWithTraceRequest, type Logger } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { MessageElementValidationError } from '@snowluma/protocol/element-manifest';
import {
    ACTION_REGISTRY,
    HANDLE_QUICK_OPERATION_ACTION,
    type CompiledActionKind,
    type CompiledActionRegistry,
} from './actions';
import type { GroupSystemMessageQuery } from './modules/contact-actions';
import type { ForwardPreviewMeta } from './modules/message-actions';
import type { ReadSessionTargets } from './message-store';
import type { JsonObject, JsonValue, MessageMeta } from './types';
import { RETCODE, failedResponse, okResponse } from './types';
import {
    StreamTransportClosedError,
    type StreamSink,
    wrapStreamFrame,
    wrapStreamTerminal,
} from './streaming';
const moduleLog = createLogger('Bridge.Action');

// Member queries and the canonical leave action redact their inputs as well as
// their results; the group ID itself is private.
function hasPrivateGroupActionDiagnostics(action: string): boolean {
    return (
        action === 'get_group_member_list' ||
        action === 'get_group_member_info' ||
        action === 'set_group_leave'
    );
}

function hasSensitiveActionDiagnostics(action: string): boolean {
    return (
        action === 'get_file' ||
        action === 'get_friend_list' ||
        action === 'get_group_list' ||
        action === 'get_group_info' ||
        action === 'get_stranger_info' ||
        hasPrivateGroupActionDiagnostics(action)
    );
}

function hasSensitiveActionInput(action: string): boolean {
    return (
        action === 'get_file' ||
        action === 'get_group_info' ||
        action === 'get_stranger_info' ||
        hasPrivateGroupActionDiagnostics(action)
    );
}

function summarizeActionParams(action: string, params: JsonObject): string {
    if (action !== 'fetch_emoji_like') {
        return summarizeParams(params);
    }

    const safeParams: JsonObject = { ...params };
    const cursor = params.cookie;

    if (typeof cursor !== 'string' || !/^\d+$/.test(cursor)) {
        return summarizeParams(safeParams);
    }

    const offset = Number(cursor);

    if (!Number.isSafeInteger(offset)) {
        return summarizeParams(safeParams);
    }

    delete safeParams.cookie;
    safeParams.emoji_like_offset = offset;
    return summarizeParams(safeParams);
}

export interface MessageSendResult {
    messageId: number;
    meta?: MessageMeta;
    echoEvent?: JsonObject;
}

export interface ApiActionContext {
    bridge: BridgeInterface;
    getLoginInfo: () => { userId: number; nickname: string };
    isOnline: () => boolean;
    getUptimeMs: () => number;
    getMessage: (messageId: number) => JsonObject | null | Promise<JsonObject | null>;
    refreshMessageMedia: (messageId: number, event: JsonObject) => Promise<void>;
    getMessageMeta: (messageId: number) => MessageMeta | null | Promise<MessageMeta | null>;
    cacheMessageMetas: (
        entries: ReadonlyArray<{ messageId: number; meta: MessageMeta }>,
    ) => void | Promise<void>;
    listReadSessions: () => ReadSessionTargets | Promise<ReadSessionTargets>;
    sendPrivateMessage: (
        userId: number,
        message: JsonValue,
        autoEscape: boolean,
        tempGroupId?: number,
    ) => Promise<MessageSendResult>;
    sendGroupMessage: (
        groupId: number,
        message: JsonValue,
        autoEscape: boolean,
    ) => Promise<MessageSendResult>;
    deleteMessage: (messageId: number, meta: MessageMeta) => Promise<void>;
    canSendImage: () => boolean;
    canSendRecord: () => boolean;
    getFriendList: (withProfile?: boolean) => Promise<JsonObject[]>;
    getGroupList: (noCache?: boolean) => Promise<JsonObject[]>;
    getGroupInfo: (groupId: number, noCache?: boolean) => Promise<JsonObject | null>;
    getGroupMemberList: (groupId: number, noCache?: boolean) => Promise<JsonObject[]>;
    getGroupMemberInfo: (
        groupId: number,
        userId: number,
        noCache?: boolean,
    ) => Promise<JsonObject | null>;
    getStrangerInfo: (userId: number) => Promise<JsonObject | null>;
    getGroupFiles: (groupId: number, folderId?: string) => Promise<JsonObject>;
    handleGroupRequest: (
        flag: string,
        subType: string,
        approve: boolean,
        reason: string,
    ) => Promise<void>;
    setEssenceMsg: (messageId: number) => Promise<void>;
    deleteEssenceMsg: (messageId: number) => Promise<void>;
    getGroupMsgHistory: (
        groupId: number,
        messageId?: number,
        count?: number,
        reverseOrder?: boolean,
    ) => Promise<JsonObject[]>;
    getFriendMsgHistory: (
        userId: number,
        messageId?: number,
        count?: number,
        reverseOrder?: boolean,
    ) => Promise<JsonObject[]>;
    handleGetGroupSystemMsg: (query: GroupSystemMessageQuery) => Promise<JsonObject[]>;
    getDownloadRKeys: () => Promise<JsonObject[]>;
    sendGroupForwardMsg: (
        groupId: number,
        messages: JsonValue,
        meta?: ForwardPreviewMeta,
    ) => Promise<{ messageId: number; forwardId: string }>;
    sendPrivateForwardMsg: (
        userId: number,
        messages: JsonValue,
        meta?: ForwardPreviewMeta,
    ) => Promise<{ messageId: number; forwardId: string }>;
    sendForwardMsg: (messages: JsonValue, groupId?: number) => Promise<{ forwardId: string }>;
    getForwardMsg: (resId: string) => Promise<JsonObject[]>;
    forwardSingleMsg: (
        messageId: number,
        target: { groupId?: number; userId?: number },
    ) => Promise<{ messageId: number }>;
    setMsgEmojiLike: (messageId: number, emojiId: string, set: boolean) => Promise<void>;
    fetchEmojiLikeUsers: (
        messageId: number,
        emojiId: string,
        count: number,
        offset?: number,
    ) => Promise<{
        users: Array<{ uin: number; uid: string; setAt: number }>;
        cachedCount: number;
        serverCount: number;
        complete: boolean;
    }>;
    fetchEmojiLikeSummary: (messageId: number) => Promise<
        Array<{
            emoji_id: string;
            emoji_type: number;
            count: number;
            last_reaction_time: number;
            users: Array<{ user_id: number }>;
        }>
    >;
    getImageInfo: (file: string) => Promise<JsonObject | null>;
    getRecordInfo: (file: string) => Promise<JsonObject | null>;
    fetchPttText: (messageId: number) => Promise<{ text: string }>;
}

export type ActionHandler = (
    params: JsonObject,
    sink?: StreamSink,
) => Promise<import('./types').ApiResponse>;

interface RegisteredHandler {
    readonly handler: ActionHandler;
    readonly canonical: string;
    readonly kind: CompiledActionKind;
}

type ActionMode = 'normal' | 'v12-sensitive';
type SensitiveMessageAction = 'send_private_msg' | 'send_group_msg';
type SensitiveHandlerResponse = 'reported' | 'unavailable';
type SensitiveLogMessage =
    | 'action_input [redacted]'
    | 'action_params [redacted]'
    | 'action_stream_frame [redacted]'
    | 'action_terminal [redacted]'
    | 'action_quiesced [redacted]'
    | 'action_unknown [redacted]'
    | 'action_failed [redacted]'
    | 'action_invalid_response [redacted]'
    | 'action_observer_error [redacted]';

function safeSensitiveLog(level: 'trace' | 'debug' | 'warn', message: SensitiveLogMessage): void {
    try {
        moduleLog[level](message);
    } catch {
        // A log subscriber must not break sensitive dispatch or expose its error.
    }
}

/** A handled-action record handed to debug observers. */
export interface ActionRecord {
    action: string;
    params: JsonObject;
    response: import('./types').ApiResponse;
    ms: number;
    /** Present only on a v12-sensitive record. */
    redacted?: true;
    /** `unavailable` describes the handler response, not whether effects occurred. */
    handler_response?: SensitiveHandlerResponse;
    /** Handler status is unknown when its response is unavailable. */
    handler_status?: 'unknown';
    /** The original failure retcode is withheld, or unknown when unavailable. */
    handler_retcode?: null;
}
export type ActionObserver = (rec: ActionRecord) => void;

/** Make a v12-sensitive failure independent of response and Object prototypes. */
function sensitiveFailure(retcode: number, wording: string): import('./types').ApiResponse {
    const response = Object.create(null) as import('./types').ApiResponse;
    response.status = 'failed';
    response.retcode = retcode;
    response.data = null;
    response.wording = wording;
    return response;
}

/** Project an already awaited response without invoking accessors or Proxy traps. */
function snapshotSensitiveResponse(value: unknown): import('./types').ApiResponse | null {
    if (typeof value !== 'object' || value === null || isProxy(value) || Array.isArray(value)) {
        return null;
    }

    try {
        const status = Object.getOwnPropertyDescriptor(value, 'status');
        const retcode = Object.getOwnPropertyDescriptor(value, 'retcode');
        const data = Object.getOwnPropertyDescriptor(value, 'data');

        if (
            !status ||
            !('value' in status) ||
            !retcode ||
            !('value' in retcode) ||
            !data ||
            !('value' in data)
        ) {
            return null;
        }

        if (!(
            (status.value === 'ok' && retcode.value === 0) ||
            (status.value === 'failed' &&
                typeof retcode.value === 'number' &&
                Number.isSafeInteger(retcode.value) &&
                retcode.value > 0)
        )) {
            return null;
        }

        for (const key of ['message', 'wording', 'echo', 'stream']) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);

            if (descriptor && !('value' in descriptor)) {
                return null;
            }
        }

        // Project before post-handler logging or observers. The fresh
        // null-prototype envelopes have no `then`, and share no mutable response
        // or data object with the handler. The dispatcher validates the message ID.
        const result = Object.create(null) as import('./types').ApiResponse;
        result.status = status.value;
        result.retcode = retcode.value;
        result.data = null;

        if (status.value === 'failed') {
            result.wording = 'sensitive action failed';
            return result;
        }

        const originalData: unknown = data.value;

        if (
            typeof originalData !== 'object' ||
            originalData === null ||
            isProxy(originalData) ||
            Array.isArray(originalData)
        ) {
            return result;
        }

        try {
            const messageId = Object.getOwnPropertyDescriptor(originalData, 'message_id');

            if (
                messageId &&
                'value' in messageId &&
                ((typeof messageId.value === 'string' && messageId.value.length <= 11) ||
                    (typeof messageId.value === 'number' && Number.isFinite(messageId.value)))
            ) {
                const projectedData = Object.create(null) as JsonObject;
                projectedData.message_id = messageId.value;
                result.data = projectedData;
            }
        } catch {
            // The action reported success; missing metadata is not a send failure.
        }

        return result;
    } catch {
        return null;
    }
}

/** Classify ordinary thrown errors without traversing a Proxy prototype. */
function isSensitiveValidationError(error: unknown): boolean {
    if ((typeof error !== 'object' || error === null) && typeof error !== 'function') {
        return false;
    }

    try {
        let current: object | null = error;

        for (let depth = 0; current !== null && depth < 100; depth++) {
            if (isProxy(current)) {
                return false;
            }

            current = Object.getPrototypeOf(current) as object | null;

            if (current === MessageElementValidationError.prototype) {
                return true;
            }
        }
    } catch {
        return false;
    }

    return false;
}

export class ApiHandler {
    /** Handler + dispatch kind live in one record so stream classification can
     *  never outlive or drift from the handler it describes. */
    private readonly handlers: ReadonlyMap<string, RegisteredHandler>;
    /** Sticky instance-lifecycle gate. A failed transport close may restore its
     *  own listener for retry, but it must never reopen execution against a
     *  retiring Bridge/store generation. */
    private acceptingActions = true;
    private readonly log: Logger;
    /** Debug-stream taps — notified after every handled action. Attached
     *  on-demand (ref-counted) by the WebUI debug stream. */
    private readonly observers = new Set<ActionObserver>();

    // A child logger also renders its account UIN and routes to a per-account
    // file. Keep these private group diagnostics on the same scope without it.
    private actionLogger(action: string): Logger {
        return hasPrivateGroupActionDiagnostics(action) ? moduleLog : this.log;
    }

    /** Observe handled actions (debug). Returns an unsubscribe. */
    setObserver(cb: ActionObserver): () => void {
        this.observers.add(cb);

        return () => {
            this.observers.delete(cb);
        };
    }

    constructor(
        context: ApiActionContext,
        uin?: number,
        registry: CompiledActionRegistry = ACTION_REGISTRY,
    ) {
        this.log = typeof uin === 'number' && uin > 0 ? moduleLog.child({ uin }) : moduleLog;
        const rawFactories: Record<string, (api: ApiHandler) => ActionHandler> = {};

        for (const raw of registry.rawActions) {
            if (raw.canonical !== HANDLE_QUICK_OPERATION_ACTION) {
                throw new Error(
                    `Action registry has no factory for raw action canonical "${raw.canonical}" ` +
                        `(name "${raw.name}", kind raw)`,
                );
            }

            rawFactories[raw.canonical] = (api) => async (params) => {
                const opContext = params.context as JsonObject | undefined;
                const operation = params.operation as Record<string, unknown> | undefined;

                if (!opContext || !operation) {
                    return failedResponse(
                        RETCODE.BAD_REQUEST,
                        'context and operation are required',
                    );
                }

                const { executeQuickOperation } = await import('./network/quick-operation');
                await executeQuickOperation(opContext, operation, api);
                return okResponse();
            };
        }

        this.handlers = registry.bind(context, this, rawFactories);
    }

    /** Whether `action` answers with a multi-frame Stream API response. */
    isStreamAction(action: string): boolean {
        return this.handlers.get(action)?.kind === 'stream';
    }

    /** Whether the owning OneBot instance still accepts new Action execution. */
    get isAcceptingActions(): boolean {
        return this.acceptingActions;
    }

    /** Permanently reject new Actions for this handler generation.
     *
     * Existing calls have already been admitted and are drained by their owning
     * transport/instance. There is intentionally no resume operation: hot reload
     * keeps the same live generation open, while teardown creates a new handler
     * only after the previous generation has fully retired. */
    quiesce(): void {
        if (!this.acceptingActions) {
            return;
        }

        this.acceptingActions = false;
        this.log.info('Action ingress quiesced');
    }

    async handle(
        action: string,
        params: JsonObject,
        sink?: StreamSink,
    ): Promise<import('./types').ApiResponse> {
        return runWithTraceRequest(() => this.handleInContext(action, params, sink));
    }

    /**
     * Internal v12 message dispatch with per-call redaction at ApiHandler's
     * diagnostics and action-observer boundary only. The registered action,
     * media callbacks, bridge and other downstream code still receive the
     * original input; this is not isolation from untrusted in-process code.
     * An optional synchronous canStart checks the caller's current lease just
     * before dispatch; its result is trusted and is not a lasting guarantee.
     * JavaScript await can inspect a returned thenable before this layer can
     * inspect its response descriptors.
     */
    async handleV12SensitiveMessage(
        action: SensitiveMessageAction,
        params: JsonObject,
        canStart?: () => boolean,
    ): Promise<import('./types').ApiResponse> {
        // Keep the boundary closed even for JavaScript callers and unsafe casts.
        if (action !== 'send_private_msg' && action !== 'send_group_msg') {
            return sensitiveFailure(RETCODE.UNKNOWN_ACTION, 'sensitive action failed');
        }

        return runWithTraceRequest(() =>
            this.handleInContext(action, params, undefined, 'v12-sensitive', canStart),
        );
    }

    traceQuiescedAction(
        action: string,
        params: JsonObject,
        response: import('./types').ApiResponse,
    ): void {
        if (this.acceptingActions) {
            return;
        }

        runWithTraceRequest(() => {
            const startedAt = Date.now();
            this.traceActionInput(action, params);
            this.traceActionTerminal(action, response, startedAt, 'failed', 'quiesced');
        });
    }

    traceQuiescedStreamRequest(rawRequest: string): void {
        const request = parseStreamRequest(rawRequest);

        if (!request) {
            return;
        }

        this.traceQuiescedAction(
            request.action,
            request.params,
            failedResponse(RETCODE.ACTION_FAILED, 'OneBot instance is shutting down'),
        );
    }

    private async handleInContext(
        action: string,
        params: JsonObject,
        sink?: StreamSink,
        mode: ActionMode = 'normal',
        canStart?: () => boolean,
    ): Promise<import('./types').ApiResponse> {
        const startedAt = Date.now();
        this.traceActionInput(action, params, mode);

        if (!this.acceptingActions) {
            const response =
                mode === 'v12-sensitive'
                    ? sensitiveFailure(RETCODE.ACTION_FAILED, 'sensitive action unavailable')
                    : failedResponse(RETCODE.ACTION_FAILED, 'OneBot instance is shutting down');

            if (mode === 'v12-sensitive') {
                safeSensitiveLog('warn', 'action_quiesced [redacted]');
            } else {
                this.actionLogger(action).warn('rejected Action %s after instance quiesce', action);
            }

            this.traceActionTerminal(action, response, startedAt, 'failed', 'quiesced', mode);
            this.notifyObservers(action, params, response, 0, mode, 'unavailable');
            return response;
        }

        const registered = this.handlers.get(action);

        if (!registered || (mode === 'v12-sensitive' && registered.canonical !== action)) {
            const response =
                mode === 'v12-sensitive'
                    ? sensitiveFailure(RETCODE.UNKNOWN_ACTION, 'unknown action')
                    : failedResponse(RETCODE.UNKNOWN_ACTION, 'unknown action');

            if (mode === 'v12-sensitive') {
                safeSensitiveLog('debug', 'action_unknown [redacted]');
            } else {
                this.actionLogger(action).debug('unknown action %s', action);
            }

            this.traceActionTerminal(action, response, startedAt, 'failed', 'unknown_action', mode);

            if (mode === 'v12-sensitive') {
                this.notifyObservers(action, params, response, 0, mode, 'unavailable');
            }

            return response;
        }

        return this.runAction(action, registered.handler, params, sink, startedAt, mode, canStart);
    }

    private async runAction(
        action: string,
        handler: ActionHandler,
        params: JsonObject,
        sink: StreamSink | undefined,
        startedAt: number,
        mode: ActionMode = 'normal',
        canStart?: () => boolean,
    ): Promise<import('./types').ApiResponse> {
        // Terse breadcrumb to the log file (debug, which is written to disk under the default
        // file level): lets the operator grep "what did the bot get asked to do" in post-mortems.
        if (mode === 'v12-sensitive') {
            safeSensitiveLog('debug', 'action_params [redacted]');
        } else {
            this.actionLogger(action).debug(
                '%s params=%s',
                action,
                hasSensitiveActionInput(action)
                    ? '[redacted]'
                    : summarizeActionParams(action, params),
            );
        }

        let response: import('./types').ApiResponse;
        let outcome: 'ok' | 'failed' | 'cancelled';
        let reason: 'response_returned' | 'handler_threw' | 'transport_closed';
        let handlerResponse: SensitiveHandlerResponse = 'unavailable';

        try {
            if (mode === 'v12-sensitive') {
                let permitted = true;

                try {
                    permitted = canStart === undefined || canStart() === true;
                } catch {
                    permitted = false;
                }

                // The guard itself can reenter and quiesce the instance. No
                // external callback or await may occur between this gate and
                // the registered handler invocation below.
                if (!this.acceptingActions || !permitted) {
                    const unavailable = sensitiveFailure(
                        RETCODE.ACTION_FAILED,
                        'sensitive action unavailable',
                    );
                    this.traceActionTerminal(
                        action,
                        unavailable,
                        startedAt,
                        'failed',
                        'not_started',
                        mode,
                    );
                    this.notifyObservers(
                        action,
                        params,
                        unavailable,
                        Date.now() - startedAt,
                        mode,
                        'unavailable',
                    );
                    return unavailable;
                }
            }

            response = await handler(
                params,
                sink
                    ? {
                          send: async (frame) => {
                              if (mode === 'v12-sensitive') {
                                  safeSensitiveLog('trace', 'action_stream_frame [redacted]');
                              } else {
                                  this.actionLogger(action).trace(() => [
                                      'action_stream_frame action=%s frame=%s',
                                      action,
                                      hasPrivateGroupActionDiagnostics(action)
                                          ? '[redacted]'
                                          : renderParamsVerbose(frame),
                                  ]);
                              }

                              await sink.send(frame);
                          },
                      }
                    : undefined,
            );

            if (mode === 'v12-sensitive') {
                const snapshot = snapshotSensitiveResponse(response);

                if (snapshot) {
                    response = snapshot;
                    handlerResponse = 'reported';
                    outcome = snapshot.status;
                } else {
                    response = sensitiveFailure(RETCODE.ACTION_FAILED, 'sensitive action failed');
                    outcome = 'failed';
                    safeSensitiveLog('warn', 'action_invalid_response [redacted]');
                }
            } else {
                outcome = response.status === 'ok' ? 'ok' : 'failed';
            }

            reason = 'response_returned';
        } catch (error) {
            // Single error seam: typed message-contract failures are caller errors
            // and therefore map to BAD_REQUEST. Bridge/OIDB business failures and
            // unexpected internal faults retain the shared ACTION_FAILED policy.
            // Action `run` bodies should not hand-roll their own catch/response
            // mapping: central classification keeps every transport consistent.
            // `OidbError.message` already carries the QQ server code, so it needs no
            // special casing. warn (not error) keeps the log file useful without
            // drowning it in expected client-side failures.
            if (mode === 'v12-sensitive') {
                const retcode = isSensitiveValidationError(error)
                    ? RETCODE.BAD_REQUEST
                    : RETCODE.ACTION_FAILED;
                response = sensitiveFailure(retcode, 'sensitive action failed');
                outcome = 'failed';
                reason = 'handler_threw';
                safeSensitiveLog('warn', 'action_failed [redacted]');
            } else {
                if (hasSensitiveActionDiagnostics(action)) {
                    this.actionLogger(action).warn(`${action} failed: [redacted]`);
                } else {
                    this.log.warn(
                        '%s failed: %s\n%s',
                        action,
                        error instanceof Error ? error.message : String(error),
                        error instanceof Error ? (error.stack ?? '') : '',
                    );
                }

                const message = error instanceof Error ? error.message : String(error);
                const retcode =
                    error instanceof MessageElementValidationError
                        ? RETCODE.BAD_REQUEST
                        : RETCODE.ACTION_FAILED;
                response = failedResponse(retcode, message);
                outcome = error instanceof StreamTransportClosedError ? 'cancelled' : 'failed';
                reason =
                    error instanceof StreamTransportClosedError
                        ? 'transport_closed'
                        : 'handler_threw';
            }
        }

        this.traceActionTerminal(action, response, startedAt, outcome, reason, mode);
        this.notifyObservers(
            action,
            params,
            response,
            Date.now() - startedAt,
            mode,
            handlerResponse,
        );
        return response;
    }

    private traceActionInput(
        action: string,
        params: JsonObject,
        mode: ActionMode = 'normal',
    ): void {
        if (mode === 'v12-sensitive') {
            safeSensitiveLog('trace', 'action_input [redacted]');
            return;
        }

        this.actionLogger(action).trace(() => [
            'action_input action=%s params=%s',
            action,
            hasSensitiveActionInput(action) ? '[redacted]' : renderParamsVerbose(params),
        ]);
    }

    private traceActionTerminal(
        action: string,
        response: import('./types').ApiResponse,
        startedAt: number,
        outcome: 'ok' | 'failed' | 'cancelled',
        reason:
            | 'response_returned'
            | 'handler_threw'
            | 'transport_closed'
            | 'unknown_action'
            | 'quiesced'
            | 'not_started',
        mode: ActionMode = 'normal',
    ): void {
        if (mode === 'v12-sensitive') {
            safeSensitiveLog('trace', 'action_terminal [redacted]');
            return;
        }

        this.actionLogger(action).trace(() => [
            'action_terminal action=%s outcome=%s reason=%s ms=%d response=%s',
            action,
            outcome,
            reason,
            Date.now() - startedAt,
            hasSensitiveActionDiagnostics(action) ? '[redacted]' : renderParamsVerbose(response),
        ]);
    }

    private notifyObservers(
        action: string,
        params: JsonObject,
        response: import('./types').ApiResponse,
        ms: number,
        mode: ActionMode = 'normal',
        handlerResponse: SensitiveHandlerResponse = 'unavailable',
    ): void {
        if (!this.observers.size) {
            return;
        }

        if (mode === 'v12-sensitive') {
            const status = snapshotSensitiveResponse(response);
            const source = status ? handlerResponse : 'unavailable';
            const observed =
                status ?? sensitiveFailure(RETCODE.ACTION_FAILED, 'sensitive action failed');

            for (const cb of this.observers) {
                try {
                    // Each observer receives its own JSON record, never the
                    // input, handler response, or another observer's objects.
                    const result: unknown = cb({
                        action,
                        params: {},
                        response: {
                            status: observed.status,
                            retcode: observed.status === 'ok' ? 0 : RETCODE.ACTION_FAILED,
                            data: null,
                            message: '[redacted]',
                        },
                        ms: 0,
                        redacted: true,
                        handler_response: source,
                        ...(source === 'unavailable' ? { handler_status: 'unknown' as const } : {}),
                        ...(source === 'unavailable' || observed.status === 'failed'
                            ? { handler_retcode: null }
                            : {}),
                    });

                    // A callback typed `void` may still be async. This is best
                    // effort for native Promises with ordinary constructor/species;
                    // arbitrary thenables and hostile in-process callbacks are not
                    // isolated or guaranteed to have their rejections consumed.
                    if (isPromise(result)) {
                        void Promise.prototype.then.call(
                            result,
                            () => undefined,
                            () => {
                                safeSensitiveLog('warn', 'action_observer_error [redacted]');
                            },
                        );
                    }
                } catch {
                    safeSensitiveLog('warn', 'action_observer_error [redacted]');
                }
            }

            return;
        }

        for (const cb of this.observers) {
            try {
                cb({ action, params, response, ms });
            } catch (err) {
                if (hasSensitiveActionDiagnostics(action)) {
                    this.actionLogger(action).warn(`${action} action observer error: [redacted]`);
                } else {
                    this.log.warn(
                        'action observer error: %s',
                        err instanceof Error ? err.message : String(err),
                    );
                }
            }
        }
    }

    /** WS dispatch supporting Stream API multi-frame responses. A normal action
     *  emits exactly one frame; a stream action emits each intermediate frame
     *  then the terminal frame — every frame carries the request's echo. `emit`
     *  writes one JSON string per frame; awaiting it lets the transport apply
     *  backpressure. `isAlive`, when supplied, is checked before each stream
     *  frame — returning false aborts the action (e.g. the client disconnected),
     *  so a dead client can't make a download keep pumping frames into the void. */
    async processStreamRequest(
        rawRequest: string,
        emit: (json: string) => void | Promise<void>,
        isAlive?: () => boolean,
    ): Promise<void> {
        const bad = (): Promise<void> =>
            Promise.resolve(
                emit(JSON.stringify(failedResponse(RETCODE.BAD_REQUEST, 'bad request'))),
            );

        if (!rawRequest.trim()) {
            await bad();
            return;
        }

        const request = parseStreamRequest(rawRequest);

        if (!request) {
            await bad();
            return;
        }

        const { action, params, echo } = request;

        if (!this.isStreamAction(action)) {
            const response = await this.handle(action, params);

            if (echo !== undefined) {
                response.echo = echo;
            }

            await emit(JSON.stringify(response));
            return;
        }

        const sink: StreamSink = {
            send: async (frame) => {
                if (isAlive && !isAlive()) {
                    throw new StreamTransportClosedError();
                }

                await emit(JSON.stringify(wrapStreamFrame(frame, echo)));
            },
        };
        const response = await this.handle(action, params, sink);
        await emit(JSON.stringify(wrapStreamTerminal(response, echo)));
    }
}

interface StreamRequest {
    action: string;
    params: JsonObject;
    echo: JsonValue | undefined;
}

function parseStreamRequest(rawRequest: string): StreamRequest | null {
    if (!rawRequest.trim()) {
        return null;
    }

    try {
        const parsed = JSON.parse(rawRequest) as unknown;

        if (!isJsonObject(parsed)) {
            return null;
        }

        const action = asString(parsed.action);

        if (!action) {
            return null;
        }

        return {
            action,
            params: isJsonObject(parsed.params) ? parsed.params : {},
            echo: parsed.echo !== undefined ? toJsonValue(parsed.echo) : undefined,
        };
    } catch {
        return null;
    }
}

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, fallback = ''): string {
    if (typeof value === 'string') {
        return value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }

    return fallback;
}

export function toJsonValue(value: unknown): JsonValue {
    if (value === null) {
        return null;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map(toJsonValue);
    }

    if (isJsonObject(value)) {
        const obj: JsonObject = {};

        for (const [key, item] of Object.entries(value)) {
            obj[key] = toJsonValue(item);
        }

        return obj;
    }

    return String(value);
}
