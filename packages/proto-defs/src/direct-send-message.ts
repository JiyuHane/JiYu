import type { int_32, int_64, pb_optional, uint_32, uint_64 } from '@snowluma/proton';

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
