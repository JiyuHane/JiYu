import type { pb, uint_32 } from '@snowluma/proton';

// Field declarations from the pinned public reference, not a target packet capture:
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Login/QrLoginExtInfo.cs
export interface WtQrDeviceInfo {
    deviceType?: pb<1, string>;
    deviceName?: pb<2, string>;
}

export interface WtQrGenInfo {
    clientType?: pb<1, uint_32>;
    clientVersion?: pb<2, uint_32>;
    clientAppId?: pb<3, uint_32>;
    field6?: pb<6, uint_32>;
}

export interface WtQrExtInfo {
    deviceInfo?: pb<1, WtQrDeviceInfo>;
    qrUrl?: pb<2, string>;
    qrSig?: pb<3, string>;
    genInfo?: pb<4, WtQrGenInfo>;
}
