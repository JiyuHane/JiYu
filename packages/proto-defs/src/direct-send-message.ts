import type {
    bytes,
    int_32,
    int_64,
    pb,
    pb_optional,
    pb_repeated,
    uint_32,
    uint_64,
} from '@snowluma/proton';

// Independent field declarations based on the LagrangeV2 protocol schema, not SDK source.
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Packets/Message/NTSendMessage.cs
// Explicit presence is retained, including encoded zero and empty-string values.
export interface DirectSendMessageResponse {
    result?: pb_optional<1, int_32>;
    errMsg?: pb_optional<2, string>;
    sendTime?: pb_optional<3, int_64>;
    msgInfoFlag?: pb_optional<10, uint_32>;
    sequence?: pb_optional<11, uint_64>;
    clientSequence?: pb_optional<14, uint_64>;
}

// Reference-only request slice for one text element, independently derived from
// LagrangeV2 7011cdf87368cc0fb77273c1508e779a52328165:
// Lagrange.Core/Internal/Packets/Message/{NTSendMessage,NTMessageCommon,Elem}.cs
// and Lagrange.Core/Message/{MessagePacker,Entities/TextEntity}.cs.
// These types describe a candidate layout, not demonstrated server compatibility.
export interface DirectSendMessageRequest {
    routingHead: pb<1, DirectSendRoutingHead>;
    contentHead: pb<2, DirectSendContentHead>;
    messageBody: pb<3, DirectSendMessageBody>;
    clientSequence: pb_optional<4, uint_64>;
    random: pb_optional<5, uint_32>;
}

export interface DirectSendRoutingHead {
    c2c?: pb<1, DirectSendC2C>;
    group?: pb<2, DirectSendGroup>;
}

export interface DirectSendC2C {
    peerUin: pb_optional<1, int_64>;
    peerUid: pb_optional<2, string>;
}

export interface DirectSendGroup {
    groupUin: pb_optional<1, int_64>;
}

export interface DirectSendContentHead {
    pkgNum: pb_optional<1, uint_32>;
    pkgIndex: pb_optional<2, uint_32>;
    divSeq: pb_optional<3, uint_32>;
    autoReply: pb_optional<4, uint_32>;
}

export interface DirectSendMessageBody {
    richText: pb<1, DirectSendRichText>;
}

export interface DirectSendRichText {
    elems: pb_repeated<2, DirectSendElem>;
}

export interface DirectSendElem {
    text: pb<1, DirectSendText>;
}

export interface DirectSendText {
    text: pb_optional<1, string>;
    pbReserve: pb_optional<12, bytes>;
}
