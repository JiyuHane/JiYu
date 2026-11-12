import type { pb, pb_optional, pb_repeated, uint_32, uint_64 } from '@snowluma/proton';

// Fixed public reference only; these declarations do not establish target compatibility.
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/System/SsoInfoSync.cs
// pb_optional preserves explicitly present default values emitted by [ProtoPackable].
export interface SsoRegisterCookie {
    lastMsgTime?: pb_optional<1, uint_64>;
}

export interface SsoRegisterC2C {
    cookie?: pb<1, SsoRegisterCookie>;
    lastMsgTime?: pb_optional<2, uint_64>;
    lastCookie?: pb<3, SsoRegisterCookie>;
}

export interface SsoRegisterMapEntry {
    key?: pb_optional<1, uint_32>;
    value?: pb_optional<2, uint_32>;
}

export interface SsoRegisterConfig {
    // The PC reference uses an empty map; its nonempty int32 values are not modeled here.
    entries?: pb_repeated<1, SsoRegisterMapEntry>;
}

export interface SsoRegisterDevice {
    name?: pb_optional<1, string>;
    type?: pb_optional<2, string>;
    osVersion?: pb_optional<3, string>;
    brand?: pb_optional<4, string>;
    vendorOs?: pb_optional<5, string>;
}

export interface SsoRegisterBusiness {
    notifySwitch?: pb_optional<1, uint_32>;
    bindUinNotifySwitch?: pb_optional<2, uint_32>;
}

export interface SsoRegisterInfo {
    guid?: pb_optional<1, string>;
    kickPc?: pb_optional<2, uint_32>;
    buildVersion?: pb_optional<3, string>;
    firstRegister?: pb_optional<4, uint_32>;
    localeId?: pb_optional<5, uint_32>;
    device?: pb<6, SsoRegisterDevice>;
    mute?: pb_optional<7, uint_32>;
    vendorType?: pb_optional<8, uint_32>;
    regType?: pb_optional<9, uint_32>;
    business?: pb<10, SsoRegisterBusiness>;
    battery?: pb_optional<11, uint_32>;
    field12?: pb_optional<12, uint_32>;
}

export interface SsoRegisterAppState {
    delay?: pb_optional<1, uint_32>;
    status?: pb_optional<2, uint_32>;
    silence?: pb_optional<3, uint_32>;
}

export interface SsoRegisterRequest {
    syncFlag?: pb_optional<1, uint_32>;
    random?: pb_optional<2, uint_32>;
    activeStatus?: pb_optional<4, uint_32>;
    groupLastMsgTime?: pb_optional<5, uint_64>;
    c2c?: pb<6, SsoRegisterC2C>;
    config?: pb<8, SsoRegisterConfig>;
    register?: pb<9, SsoRegisterInfo>;
    unknown?: pb_repeated<10, SsoRegisterMapEntry>;
    appState?: pb<11, SsoRegisterAppState>;
}

export interface SsoRegisterResponseInfo {
    message?: pb<2, string>;
}

export interface SsoRegisterResponse {
    register?: pb<7, SsoRegisterResponseInfo>;
}

// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/System/NTSsoHeartBeat.cs
export interface SsoHeartbeatSilence {
    localSilence?: pb_optional<1, uint_32>;
}

export interface SsoHeartbeatRequest {
    type?: pb_optional<1, uint_32>;
    localSilence?: pb<2, SsoHeartbeatSilence>;
    batteryState?: pb_optional<3, uint_32>;
    time?: pb_optional<4, uint_64>;
}

export interface SsoHeartbeatResponse {
    interval?: pb<3, uint_64>;
}
