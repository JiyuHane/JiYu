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
