/** JSON values on the OneBot 12 wire. IDs defined by the protocol stay strings. */
export type OneBot12JsonValue =
    null | boolean | number | string | OneBot12JsonValue[] | OneBot12JsonObject;
export interface OneBot12JsonObject {
    [key: string]: OneBot12JsonValue | undefined;
}

export interface OneBot12Self extends OneBot12JsonObject {
    platform: string;
    user_id: string;
}

export interface OneBot12MessageSegment extends OneBot12JsonObject {
    type: string;
    data: OneBot12JsonObject;
}

export interface OneBot12TextSegment extends OneBot12MessageSegment {
    type: 'text';
    data: OneBot12JsonObject & { text: string };
}

export interface OneBot12MentionSegment extends OneBot12MessageSegment {
    type: 'mention';
    data: OneBot12JsonObject & { user_id: string };
}

export interface OneBot12MentionAllSegment extends OneBot12MessageSegment {
    type: 'mention_all';
    data: OneBot12JsonObject;
}

/** Incoming messages are segment arrays; outgoing message parameters may also be a string or single segment. */
export type OneBot12Message = OneBot12MessageSegment[];
export type OneBot12OutgoingMessage = OneBot12Message | OneBot12MessageSegment | string;

export interface OneBot12ActionRequest extends OneBot12JsonObject {
    action: string;
    params: OneBot12JsonObject;
    echo?: string;
    self?: OneBot12Self;
}

export interface OneBot12ActionResponse extends OneBot12JsonObject {
    status: 'ok' | 'failed';
    /** The JSON codec supports the safe integer subset of OneBot's int64. */
    retcode: number;
    data: OneBot12JsonValue;
    message: string;
    echo?: string;
}

/** Group information returned by OneBot 12 group actions. */
export interface OneBot12GroupInfo extends OneBot12JsonObject {
    group_id: string;
    group_name: string;
}

/** Describes the response shape; the generic response parser does not validate group fields. */
export type OneBot12GroupInfoResponse =
    | (OneBot12ActionResponse & { status: 'ok'; data: OneBot12GroupInfo })
    | (OneBot12ActionResponse & { status: 'failed'; data: OneBot12JsonValue });

/** Describes the response shape; the generic response parser does not validate group fields. */
export type OneBot12GroupListResponse =
    | (OneBot12ActionResponse & { status: 'ok'; data: OneBot12GroupInfo[] })
    | (OneBot12ActionResponse & { status: 'failed' });

/** Group member information returned by OneBot 12 group member actions. */
export interface OneBot12GroupMemberInfo extends OneBot12JsonObject {
    user_id: string;
    user_name: string;
    user_displayname: string;
}

/** Describes the response shape; the generic response parser does not validate member fields. */
export type OneBot12GroupMemberInfoResponse =
    | (OneBot12ActionResponse & { status: 'ok'; data: OneBot12GroupMemberInfo })
    | (OneBot12ActionResponse & { status: 'failed'; data: OneBot12JsonValue });

/** Describes the response shape; the generic response parser does not validate member fields. */
export type OneBot12GroupMemberListResponse =
    | (OneBot12ActionResponse & { status: 'ok'; data: OneBot12GroupMemberInfo[] })
    | (OneBot12ActionResponse & { status: 'failed' });

/** User information returned by OneBot 12 user actions. */
export interface OneBot12UserInfo extends OneBot12JsonObject {
    user_id: string;
    user_name: string;
    user_displayname: string;
    user_remark: string;
}

/** Describes the response shape; the generic response parser does not validate user fields. */
export type OneBot12UserInfoResponse =
    | (OneBot12ActionResponse & { status: 'ok'; data: OneBot12UserInfo })
    | (OneBot12ActionResponse & { status: 'failed'; data: OneBot12JsonValue });

/** Describes the response shape; the generic response parser does not validate user fields. */
export type OneBot12FriendListResponse =
    | (OneBot12ActionResponse & { status: 'ok'; data: OneBot12UserInfo[] })
    | (OneBot12ActionResponse & { status: 'failed' });

export interface OneBot12EventBase extends OneBot12JsonObject {
    id: string;
    time: number;
    detail_type: string;
    sub_type: string;
}

export interface OneBot12MetaEvent extends OneBot12EventBase {
    type: 'meta';
    self?: OneBot12Self;
}

export interface OneBot12PlatformEvent extends OneBot12EventBase {
    type: 'message' | 'notice' | 'request';
    self: OneBot12Self;
}

export type OneBot12Event = OneBot12MetaEvent | OneBot12PlatformEvent;

/** Both fields use the safe integer subset of the protocol's int64. */
export interface OneBot12LatestEventsParams extends OneBot12JsonObject {
    /** Maximum event count; 0 or omission means no protocol count limit. */
    limit?: number;
    /** Server wait in seconds; 0 or omission requests a short poll. */
    timeout?: number;
}

/** Only the common event fields are validated, not detail-specific payloads. */
export type OneBot12LatestEventsResponse =
    | (OneBot12ActionResponse & { status: 'ok'; data: OneBot12PlatformEvent[] })
    | (OneBot12ActionResponse & { status: 'failed' });
