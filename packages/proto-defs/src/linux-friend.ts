import type {
    pb_optional,
    pb_repeated,
    uint_32,
    uint_64,
    int_32,
    bytes,
    bool,
} from '@snowluma/proton';

// Linux QQ 3.2.35-54395, wrapper.node SHA256
// dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328.
// CheckSettingWorker encoder RVA 0x4a0dfa0; AddBuddyWorkerV2 encoder 0x4a11890.
// These are the UIN variants. UID variants use different wire types at the same tags.
// CPBMessageOpti preserves present zero/empty values; optionality is wire presence,
// not merely the TypeScript '?' modifier. No transport or business success is implied.
export interface LinuxFriendSettingUinBody {
    version?: pb_optional<1, uint_32>;
    selfUin?: pb_optional<2, uint_64>;
    peerUin?: pb_optional<3, uint_64>;
    sourceId?: pb_optional<4, uint_32>;
    sourceSub?: pb_optional<5, uint_32>;
    name?: pb_optional<6, string>;
    name1?: pb_optional<7, string>;
}

export interface LinuxFriendAddUinBody {
    selfUin?: pb_optional<1, uint_64>;
    peerUin?: pb_optional<2, uint_64>;
    addSetting?: pb_optional<3, int_32>;
    myAllowFlag?: pb_optional<4, uint_32>;
    groupId?: pb_optional<5, uint_32>;
    answer?: pb_optional<7, string>;
    srcFlag?: pb_optional<8, uint_32>;
    autoSend?: pb_optional<9, uint_32>;
    sig?: pb_optional<10, bytes>;
    sourceId?: pb_optional<11, uint_32>;
    sourceSub?: pb_optional<12, uint_32>;
    name?: pb_optional<13, string>;
    name1?: pb_optional<14, string>;
    sourceDescription?: pb_optional<15, string>;
    friendSourceDescription?: pb_optional<16, string>;
    remark?: pb_optional<18, string>;
    cardSwitch?: pb_optional<20, int_32>;
    token?: pb_optional<25, bytes>;
    verify?: pb_optional<26, bytes>;
    secureTips?: pb_optional<28, bool>;
    supportAddRelief?: pb_optional<29, bool>;
    ext?: pb_optional<30, bytes>;
    bytesSig?: pb_optional<31, bytes>;
    clientExt?: pb_optional<32, bytes>;
}

// Native CheckSetting decoder RVA 0x4a0ee10. Questions are repeated strings,
// not nested messages. Read them as bytes so the projection can validate UTF-8.
export interface LinuxFriendSettingUinResponseBody {
    peerUin?: pb_optional<2, uint_64>;
    setting?: pb_optional<3, int_32>;
    questions?: pb_repeated<4, bytes>;
    result?: pb_optional<5, int_32>;
    errorCode?: pb_optional<6, uint_32>;
    isContactFriend?: pb_optional<9, bool>;
    returnedUin?: pb_optional<14, uint_64>;
}

// Native AddBuddy decoder RVA 0x4a13c50. These are protocol data, not a success
// enum. In particular verify is opaque bytes, not a boolean approval flag.
// Field 2 is intentionally not inferred as a real UID from native GetString:
// that generic reader can convert other wire types to strings.
export interface LinuxFriendAddResponseBody {
    friendSetting?: pb_optional<3, int_32>;
    myAllowFlag?: pb_optional<4, uint_32>;
    groupId?: pb_optional<5, uint_32>;
    result?: pb_optional<6, int_32>;
    errorCode?: pb_optional<7, uint_32>;
    errorMessage?: pb_optional<8, bytes>;
    sig?: pb_optional<9, bytes>;
    verify?: pb_optional<12, bytes>;
}
