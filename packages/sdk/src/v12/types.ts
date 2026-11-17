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

/** Describes an image segment; the generic segment parser does not validate file_id. */
export interface OneBot12ImageSegment extends OneBot12MessageSegment {
    type: 'image';
    data: OneBot12JsonObject & { file_id: string };
}

/** Describes a voice segment; the generic segment parser does not validate file_id. */
export interface OneBot12VoiceSegment extends OneBot12MessageSegment {
    type: 'voice';
    data: OneBot12JsonObject & { file_id: string };
}

/** Describes a location segment; the generic segment parser does not validate location fields. */
export interface OneBot12LocationSegment extends OneBot12MessageSegment {
    type: 'location';
    data: OneBot12JsonObject & {
        latitude: number;
        longitude: number;
        title: string;
        content: string;
    };
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

/** JSON bytes are Base64 strings; Jiyu requires canonical Base64, which this type does not validate. */
export interface OneBot12UploadFileDataParams extends OneBot12JsonObject {
    type: 'data';
    name: string;
    data: string;
    /** Optional lowercase hexadecimal SHA-256 of the original bytes. */
    sha256?: string;
}

/** File ID returned by a supporting OneBot 12 upload_file implementation. */
export interface OneBot12UploadFileDataResult extends OneBot12JsonObject {
    file_id: string;
}

/** Describes the response shape; the generic response parser does not validate file fields. */
export type OneBot12UploadFileDataResponse =
    | (OneBot12ActionResponse & { status: 'ok'; data: OneBot12UploadFileDataResult })
    | (OneBot12ActionResponse & { status: 'failed'; data: OneBot12JsonValue });

/** Parameters for the data subset of OneBot 12 get_file. */
export interface OneBot12GetFileDataParams extends OneBot12JsonObject {
    file_id: string;
    type: 'data';
}

/** JSON bytes are Base64 strings, not byte arrays; Jiyu uses canonical Base64. */
export interface OneBot12GetFileDataResult extends OneBot12JsonObject {
    name: string;
    data: string;
    /** Optional lowercase hexadecimal SHA-256 of the original bytes. */
    sha256?: string;
}

/** Describes the response shape; the generic response parser does not validate file fields. */
export type OneBot12GetFileDataResponse =
    | (OneBot12ActionResponse & { status: 'ok'; data: OneBot12GetFileDataResult })
    | (OneBot12ActionResponse & { status: 'failed'; data: OneBot12JsonValue });

/** Parameters for the URL subset of OneBot 12 get_file. */
export interface OneBot12GetFileUrlParams extends OneBot12JsonObject {
    file_id: string;
    type: 'url';
}

/** URL data returned by a supporting OneBot 12 get_file implementation. */
export interface OneBot12GetFileUrlData extends OneBot12JsonObject {
    name: string;
    url: string;
    headers?: Record<string, string>;
    sha256?: string;
}

/** Describes the response shape; the generic response parser does not validate file fields. */
export type OneBot12GetFileUrlResponse =
    | (OneBot12ActionResponse & { status: 'ok'; data: OneBot12GetFileUrlData })
    | (OneBot12ActionResponse & { status: 'failed'; data: OneBot12JsonValue });

/** Prepare a fragmented read; the file ID is interpreted by the implementation. */
export interface OneBot12GetFileFragmentedPrepareParams extends OneBot12JsonObject {
    stage: 'prepare';
    file_id: string;
}

/** Read a byte range; JSON int64 values are represented by safe integers in JavaScript. */
export interface OneBot12GetFileFragmentedTransferParams extends OneBot12JsonObject {
    stage: 'transfer';
    file_id: string;
    /** Byte offset. This type does not validate the integer or its range. */
    offset: number;
    /** Requested size in bytes. This type does not validate the integer or its range. */
    size: number;
}

/** Prepare metadata reported by a supporting implementation. */
export interface OneBot12GetFileFragmentedPrepareResult extends OneBot12JsonObject {
    name: string;
    /** JSON int64 represented as a safe integer; this type does not validate it. */
    total_size: number;
    /** Server-reported SHA-256; this field alone does not establish integrity or trust. */
    sha256: string;
}

/** JSON bytes are Base64 strings rather than byte arrays. */
export interface OneBot12GetFileFragmentedTransferResult extends OneBot12JsonObject {
    data: string;
}

/** Describes the response shape; the generic parser does not validate prepare fields. */
export type OneBot12GetFileFragmentedPrepareResponse =
    | (OneBot12ActionResponse & { status: 'ok'; data: OneBot12GetFileFragmentedPrepareResult })
    | (OneBot12ActionResponse & { status: 'failed'; data: OneBot12JsonValue });

/** Describes the response shape; the generic parser does not validate transfer fields. */
export type OneBot12GetFileFragmentedTransferResponse =
    | (OneBot12ActionResponse & { status: 'ok'; data: OneBot12GetFileFragmentedTransferResult })
    | (OneBot12ActionResponse & { status: 'failed'; data: OneBot12JsonValue });

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

/**
 * Jiyu-specific notice, not a standard OneBot 12 event. The generic event
 * parser does not validate its detail-specific fields; this shape does not
 * authenticate that an event originated from QQ.
 */
export interface OneBot12QQGroupNameChangeEvent extends OneBot12PlatformEvent {
    type: 'notice';
    detail_type: 'qq.group_name_change';
    sub_type: '';
    group_id: string;
    group_name: string;
    /** Jiyu omits this for an unresolved operator; omission does not prove there was no operator. */
    operator_id?: string;
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
