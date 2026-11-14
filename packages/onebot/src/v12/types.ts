import type { ApiResponse, JsonObject, JsonValue } from '../types';

/** One account owned by the surrounding instance, not a global account registry. */
export interface V12Self {
    platform: string;
    user_id: string;
}

export interface V12Response {
    status: 'ok' | 'failed';
    retcode: number;
    data: JsonValue;
    message: string;
    echo?: string;
}

/** Structural subset of ApiHandler; the real instance handler satisfies this. */
export interface V11ActionHandler {
    handle(action: string, params: JsonObject): Promise<ApiResponse>;
}

export interface V12CoreOptions {
    self: V12Self;
    version: { impl: string; version: string };
    api: V11ActionHandler;
    /** Runtime observations for this connection/account; never inferred by the core. */
    getStatus(): { good: boolean; online: boolean } | Promise<{ good: boolean; online: boolean }>;
    /** Resolve the account store's recorded Unix-seconds send-time estimate, or null. */
    getSentMessageTime(messageId: number): number | null | Promise<number | null>;
}

export type V12TextSegment = { type: 'text'; data: { text: string } };
export type V12MessageSegment =
    | V12TextSegment
    | { type: 'mention'; data: { user_id: string } }
    | { type: 'mention_all'; data: Record<string, never> };

export interface V12MessageEvent {
    id: string;
    time: number;
    type: 'message';
    detail_type: 'private' | 'group';
    sub_type: string;
    self: V12Self;
    message_id: string;
    message: V12MessageSegment[];
    alt_message: string;
    user_id: string;
    group_id?: string;
}

export interface V12FriendIncreaseEvent {
    id: string;
    time: number;
    type: 'notice';
    detail_type: 'friend_increase';
    sub_type: '';
    self: V12Self;
    user_id: string;
}

export interface V12GroupMessageDeleteEvent {
    id: string;
    time: number;
    type: 'notice';
    detail_type: 'group_message_delete';
    sub_type: 'recall' | '';
    self: V12Self;
    group_id: string;
    message_id: string;
    user_id: string;
    operator_id: string;
}

export interface V12GroupMemberDecreaseEvent {
    id: string;
    time: number;
    type: 'notice';
    detail_type: 'group_member_decrease';
    /** V11 does not retain enough provenance to determine the underlying reason. */
    sub_type: '';
    self: V12Self;
    group_id: string;
    user_id: string;
    operator_id: string;
}

export interface V12GroupMemberIncreaseEvent {
    id: string;
    time: number;
    type: 'notice';
    detail_type: 'group_member_increase';
    /** V11 admission types may originate from defaults or actor-based fallbacks. */
    sub_type: '';
    self: V12Self;
    group_id: string;
    user_id: string;
    operator_id: string;
}

export type V12ConvertedEvent =
    | V12MessageEvent
    | V12FriendIncreaseEvent
    | V12GroupMessageDeleteEvent
    | V12GroupMemberDecreaseEvent
    | V12GroupMemberIncreaseEvent;
