import type { DirectSendMessageResponse } from '@snowluma/proto-defs/direct-send-message';
import { protobuf_decode } from '@snowluma/proton';

export interface DirectSendMessageResponseProjection {
    result: number | null;
    errMsg: string | null;
    sendTime: bigint | null;
    msgInfoFlag: number | null;
    sequence: bigint | null;
    clientSequence: bigint | null;
    presence: {
        result: boolean;
        errMsg: boolean;
        sendTime: boolean;
        msgInfoFlag: boolean;
        sequence: boolean;
        clientSequence: boolean;
    };
    /** Derived LagrangeV2 choice; a zero fallback is not an observed wire field. */
    selectedSequence: bigint;
}

/**
 * Reference-only projection of a protobuf payload, without transport or authentication.
 * Its schema and sequence selection independently reference LagrangeV2 commit
 * 7011cdf87368cc0fb77273c1508e779a52328165; this is not Lagrange SDK source.
 *
 * Proton accepts an empty message: all fields are absent and selectedSequence is
 * the derived 0n fallback, not evidence of a successful or authentic response.
 * Missing values are null; encoded zero/empty values remain present. Duplicate
 * singular fields use the decoder's last value. Unknown fields and their metadata
 * are not exposed by this projection. Nonzero results are returned unchanged.
 *
 * The caller supplies a Uint8Array under the normal Proton parser trust boundary;
 * no additional size limit, server identity check or receipt verification is applied.
 * Malformed protobuf errors propagate from the production decoder.
 */
export function decodeDirectSendMessageResponse(
    bytes: Uint8Array,
): DirectSendMessageResponseProjection {
    const decoded = protobuf_decode<DirectSendMessageResponse>(bytes);
    const result = decoded.result ?? null;
    const errMsg = decoded.errMsg ?? null;
    const sendTime = decoded.sendTime ?? null;
    const msgInfoFlag = decoded.msgInfoFlag ?? null;
    const sequence = decoded.sequence ?? null;
    const clientSequence = decoded.clientSequence ?? null;
    const normalizedClientSequence = clientSequence ?? 0n;

    return {
        result,
        errMsg,
        sendTime,
        msgInfoFlag,
        sequence,
        clientSequence,
        presence: {
            result: result !== null,
            errMsg: errMsg !== null,
            sendTime: sendTime !== null,
            msgInfoFlag: msgInfoFlag !== null,
            sequence: sequence !== null,
            clientSequence: clientSequence !== null,
        },
        selectedSequence:
            normalizedClientSequence !== 0n ? normalizedClientSequence : (sequence ?? 0n),
    };
}
