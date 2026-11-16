import type { pb, pb_optional, bytes, int_32, int_64, uint_32, uint_64 } from '@snowluma/proton';

// Field declarations only; no QQ build interoperability is implied.
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Login/NTEcdh.cs
export interface KeyExchangeRequest {
    publicKey?: pb<1, bytes>;
    type?: pb<2, uint_32>;
    secret?: pb<3, bytes>;
    timestamp?: pb<4, int_64>;
    verifyHash?: pb<5, bytes>;
}

export interface KeyExchangeResponse {
    secret?: pb<1, bytes>;
    field2?: pb<2, bytes>;
    publicKey?: pb<3, bytes>;
}

export interface KeyExchangeRequestBuf {
    uin?: pb<1, string>;
    guid?: pb<2, bytes>;
}

export interface KeyExchangeResponseSecret {
    sessionKey?: pb<1, bytes>;
    sessionTicket?: pb<2, bytes>;
    expiration?: pb<3, uint_32>;
}

export interface NTLoginForwardRequest {
    sessionTicket?: pb<1, bytes>;
    buffer?: pb<3, bytes>;
    type?: pb<4, uint_32>;
    secBuffer?: pb<5, bytes>;
}

// Independent Linux request-only reference schemas; upstream overall license undetermined.
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Packets/Login/NTLogin.cs
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/Login/NTLoginCommon.cs#L11-L25
// pb_optional preserves non-null reference values, including empty strings/bytes.
export interface LinuxNTLoginReferenceUser {
    account: pb_optional<1, string>;
}

export interface LinuxNTLoginReferenceClient {
    deviceType: pb_optional<1, string>;
    deviceName: pb_optional<2, string>;
    platform: pb<3, int_32>;
    guid: pb_optional<4, bytes>;
}

export interface LinuxNTLoginReferenceApp {
    version: pb_optional<1, string>;
    appId: pb<2, int_32>;
    appName: pb_optional<3, string>;
    qua: pb_optional<5, string>;
}

export interface LinuxNTLoginReferenceCookie {
    cookieContent?: pb_optional<1, string>;
}

export interface LinuxNTLoginReferenceSdk {
    version: pb<1, uint_32>;
}

export interface LinuxNTLoginReferenceHead {
    user: pb<1, LinuxNTLoginReferenceUser>;
    client: pb<2, LinuxNTLoginReferenceClient>;
    app: pb<3, LinuxNTLoginReferenceApp>;
    cookie: pb<5, LinuxNTLoginReferenceCookie>;
    sdk: pb<7, LinuxNTLoginReferenceSdk>;
}

export interface LinuxNTLoginReferenceCommon {
    head: pb<1, LinuxNTLoginReferenceHead>;
    body: pb_optional<2, bytes>;
}

export interface LinuxNTLoginReferenceForward {
    sessionTicket: pb<1, bytes>;
    buffer: pb<3, bytes>;
    type: pb<4, uint_32>;
}

// Minimal response-only projection. Other fields intentionally remain unknown.
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Packets/Login/NTEcdh.cs#L53-L61
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Packets/Login/NTLogin.cs#L76-L94
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Packets/Login/NTLogin.cs#L167-L182
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Packets/Login/NTLogin.cs#L538-L544
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/Login/NTLoginCommon.cs#L55-L76
export interface LinuxNTLoginReferenceResponseForward {
    buffer?: pb_optional<3, bytes>;
}

export interface LinuxNTLoginReferenceResponseError {
    code?: pb_optional<1, uint_64>;
}

export interface LinuxNTLoginReferenceResponseHead {
    errorInfo?: pb<4, LinuxNTLoginReferenceResponseError>;
}

export interface LinuxNTLoginReferenceResponseCommon {
    head?: pb<1, LinuxNTLoginReferenceResponseHead>;
    body?: pb_optional<2, bytes>;
}

// Independent EasyLogin field declarations; overall upstream license undetermined.
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/Login/EasyLoginService.cs#L13-L25
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Packets/Login/NTLogin.cs#L306-L315
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Packets/Login/NTLogin.cs#L455-L464
export interface LinuxNTEasyLoginReferenceRequestBody {
    a1: pb_optional<1, bytes>;
}

export interface LinuxNTEasyLoginReferenceTickets {
    a1?: pb_optional<3, bytes>;
    a2?: pb_optional<4, bytes>;
    d2?: pb_optional<5, bytes>;
    d2Key?: pb_optional<6, bytes>;
}

export interface LinuxNTEasyLoginReferenceResponseBody {
    tickets?: pb_optional<1, LinuxNTEasyLoginReferenceTickets>;
}

// Field declarations independently derived from LagrangeV2; original authors retain ownership.
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Packets/System/ThirdPartyLoginResponse.cs
export interface DirectThirdPartyLoginResponse {
    commonInfo?: pb<9, DirectThirdPartyCommonInfo>;
}

export interface DirectThirdPartyCommonInfo {
    rspNT?: pb<11, DirectThirdPartyRspNT>;
}

export interface DirectThirdPartyRspNT {
    uid?: pb<1, string>;
}
