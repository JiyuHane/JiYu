import type { bytes, pb, uint_32 } from '@snowluma/proton';

// Field declarations follow the cited public implementation, not an observed
// target-build wire capture. Additional fields remain unknown to these types.
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Struct/SsoReserveFields.cs
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Common/BotSignProvider.cs
export interface DirectSsoSecureInfo {
    sign?: pb<1, bytes>;
    token?: pb<2, bytes>;
    extra?: pb<3, bytes>;
}

export interface DirectSsoReserve {
    traceParent?: pb<15, string>;
    uid?: pb<16, string>;
    msgType?: pb<21, uint_32>;
    secureInfo?: pb<24, DirectSsoSecureInfo>;
    ntCoreVersion?: pb<26, uint_32>;
}
