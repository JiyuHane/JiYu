import type { pb, bytes, int_64, uint_32 } from '@snowluma/proton';

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
