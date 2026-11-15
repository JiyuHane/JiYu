import type {
    DirectSendMessageRequest,
    DirectSendMessageResponse,
} from '@snowluma/proto-defs/direct-send-message';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';

import { encodeDirectSendMessageRequest } from '../../src/direct/send-message-request';
import { decodeDirectSendMessageResponse } from '../../src/direct/send-message-response';

// Manually assembled from the local schema: route group=1; content has four
// explicitly present scalars; text and its empty reserve, sequence=1, random=0.
// Synthetic reference-only fixture, not a captured or live QQ result.
const GROUP_BOM_A = '0a0412020801120808011000180020001a0e0a0c120a0a080a04efbbbf41620020012800';

describe('synthetic direct send message BOM regression', () => {
    it('preserves the leading BOM in the hand-assembled request and decode', () => {
        const wire = encodeDirectSendMessageRequest({
            route: { kind: 'group', groupUin: 1n },
            text: '\ufeffA',
            clientSequence: 1n,
            random: 0,
        });
        expect(Buffer.from(wire).toString('hex')).toBe(GROUP_BOM_A);
        const decoded = protobuf_decode<DirectSendMessageRequest>(wire);
        expect(decoded.messageBody.richText.elems[0].text.text).toBe('\ufeffA');
        expect(decoded.messageBody.richText.elems[0].text.pbReserve).toEqual(new Uint8Array());
    });

    it('preserves BOM and malformed replacement in synthetic response projection', () => {
        const encoded = protobuf_encode<DirectSendMessageResponse>({ errMsg: '\ufeffA' });
        expect(Buffer.from(encoded).toString('hex')).toBe('1204efbbbf41');
        expect(protobuf_decode<DirectSendMessageResponse>(encoded).errMsg).toBe('\ufeffA');
        expect(decodeDirectSendMessageResponse(encoded)).toMatchObject({
            errMsg: '\ufeffA',
            presence: { errMsg: true },
        });
        const malformed = Uint8Array.from([0x12, 0x04, 0xef, 0xbb, 0xbf, 0xff]);
        expect(protobuf_decode<DirectSendMessageResponse>(malformed).errMsg).toBe('\ufeff\ufffd');
        expect(decodeDirectSendMessageResponse(malformed).errMsg).toBe('\ufeff\ufffd');
    });
});
