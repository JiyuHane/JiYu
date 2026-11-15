import type { DirectSendMessageResponse } from '@snowluma/proto-defs/direct-send-message';
import { protobuf_decode, protobuf_encode, protobuf_getUnknownFields } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';

import { decodeDirectSendMessageResponse } from '../../src/direct/send-message-response';

// Synthetic wire examples derived from the reference schema, not captured responses.
const absent = {
    result: null,
    errMsg: null,
    sendTime: null,
    msgInfoFlag: null,
    sequence: null,
    clientSequence: null,
    presence: {
        result: false,
        errMsg: false,
        sendTime: false,
        msgInfoFlag: false,
        sequence: false,
        clientSequence: false,
    },
    selectedSequence: 0n,
};

function encode(value: DirectSendMessageResponse): Uint8Array {
    return protobuf_encode<DirectSendMessageResponse>(value);
}

describe('reference-only direct send message response projection', () => {
    it('cross-checks the real codec and projection against a small hand-calculated wire', () => {
        // field 1=7, field 2="err", field 3=2, field 10=3, field 11=300, field 14=4
        const wire = Uint8Array.of(
            0x08,
            0x07,
            0x12,
            0x03,
            0x65,
            0x72,
            0x72,
            0x18,
            0x02,
            0x50,
            0x03,
            0x58,
            0xac,
            0x02,
            0x70,
            0x04,
        );
        const values = {
            result: 7,
            errMsg: 'err',
            sendTime: 2n,
            msgInfoFlag: 3,
            sequence: 300n,
            clientSequence: 4n,
        };
        expect(encode(values)).toEqual(wire);
        expect(protobuf_decode<DirectSendMessageResponse>(wire)).toMatchObject(values);
        expect(decodeDirectSendMessageResponse(wire)).toEqual({
            ...values,
            presence: {
                result: true,
                errMsg: true,
                sendTime: true,
                msgInfoFlag: true,
                sequence: true,
                clientSequence: true,
            },
            selectedSequence: 4n,
        });
    });

    it('prefers nonzero tag 14 with values above the safe integer range', () => {
        const sequence = 9007199254740993n;
        const clientSequence = 18446744073709551615n;
        const wire = encode({ sequence, clientSequence, msgInfoFlag: 4294967295 });
        const decoded = protobuf_decode<DirectSendMessageResponse>(wire);
        expect(decoded).toMatchObject({ sequence, clientSequence, msgInfoFlag: 4294967295 });
        expect(decodeDirectSendMessageResponse(wire)).toEqual({
            ...absent,
            msgInfoFlag: 4294967295,
            sequence,
            clientSequence,
            presence: {
                ...absent.presence,
                msgInfoFlag: true,
                sequence: true,
                clientSequence: true,
            },
            selectedSequence: clientSequence,
        });
    });

    it('falls back from explicitly encoded zero tag 14 to tag 11', () => {
        const wire = Uint8Array.of(0x58, 0xac, 0x02, 0x70, 0x00);
        expect(protobuf_decode<DirectSendMessageResponse>(wire)).toMatchObject({
            sequence: 300n,
            clientSequence: 0n,
        });
        expect(decodeDirectSendMessageResponse(wire)).toEqual({
            ...absent,
            sequence: 300n,
            clientSequence: 0n,
            presence: { ...absent.presence, sequence: true, clientSequence: true },
            selectedSequence: 300n,
        });
    });

    it('falls back to tag 11 when tag 14 is missing and to zero when both are missing', () => {
        const wire = encode({ sequence: 4294967296n });
        expect(decodeDirectSendMessageResponse(wire)).toEqual({
            ...absent,
            sequence: 4294967296n,
            presence: { ...absent.presence, sequence: true },
            selectedSequence: 4294967296n,
        });
        expect(decodeDirectSendMessageResponse(encode({ result: 5 }))).toEqual({
            ...absent,
            result: 5,
            presence: { ...absent.presence, result: true },
        });
    });

    it.each([-9223372036854775808n, -9007199254740993n, -1n, 9223372036854775807n])(
        'retains signed int64 sendTime %s without precision loss',
        (sendTime) => {
            const wire = encode({ sendTime });
            expect(protobuf_decode<DirectSendMessageResponse>(wire).sendTime).toBe(sendTime);
            expect(decodeDirectSendMessageResponse(wire)).toEqual({
                ...absent,
                sendTime,
                presence: { ...absent.presence, sendTime: true },
            });
        },
    );

    it('retains nonzero result, plaintext errMsg and uint32 flag without implying success', () => {
        const fields = { result: -42, errMsg: 'synthetic error 明文', msgInfoFlag: 0xffffffff };
        const wire = encode(fields);
        expect(protobuf_decode<DirectSendMessageResponse>(wire)).toMatchObject(fields);
        expect(decodeDirectSendMessageResponse(wire)).toEqual({
            ...absent,
            ...fields,
            presence: { ...absent.presence, result: true, errMsg: true, msgInfoFlag: true },
        });
    });

    it('treats an empty message as all absent, not as a success claim', () => {
        expect(decodeDirectSendMessageResponse(new Uint8Array())).toEqual(absent);
    });

    it('preserves every explicit zero and empty string from fixed wire bytes', () => {
        const wire = Uint8Array.of(
            0x08,
            0x00,
            0x12,
            0x00,
            0x18,
            0x00,
            0x50,
            0x00,
            0x58,
            0x00,
            0x70,
            0x00,
        );
        expect(protobuf_decode<DirectSendMessageResponse>(wire)).toMatchObject({
            result: 0,
            errMsg: '',
            sendTime: 0n,
            msgInfoFlag: 0,
            sequence: 0n,
            clientSequence: 0n,
        });
        expect(decodeDirectSendMessageResponse(wire)).toEqual({
            result: 0,
            errMsg: '',
            sendTime: 0n,
            msgInfoFlag: 0,
            sequence: 0n,
            clientSequence: 0n,
            presence: {
                result: true,
                errMsg: true,
                sendTime: true,
                msgInfoFlag: true,
                sequence: true,
                clientSequence: true,
            },
            selectedSequence: 0n,
        });
    });

    it('applies Proton last-value semantics to repeated singular fields', () => {
        const wire = Uint8Array.of(0x58, 0x09, 0x70, 0x04, 0x58, 0x03, 0x70, 0x00);
        expect(protobuf_decode<DirectSendMessageResponse>(wire)).toMatchObject({
            sequence: 3n,
            clientSequence: 0n,
        });
        expect(decodeDirectSendMessageResponse(wire)).toEqual({
            ...absent,
            sequence: 3n,
            clientSequence: 0n,
            presence: { ...absent.presence, sequence: true, clientSequence: true },
            selectedSequence: 3n,
        });
    });

    it('skips synthetic unknown fields without exposing codec metadata in the projection', () => {
        // Unknown field 20, varint; field 21, length-delimited; followed by known tag 14.
        const wire = Uint8Array.of(0xa0, 0x01, 0x2a, 0xaa, 0x01, 0x02, 0x41, 0x42, 0x70, 0x07);
        const decoded = protobuf_decode<DirectSendMessageResponse>(wire);
        expect(decoded.clientSequence).toBe(7n);
        expect(protobuf_getUnknownFields(decoded)).toHaveLength(2);
        const projection = decodeDirectSendMessageResponse(wire);
        expect(projection).toEqual({
            ...absent,
            clientSequence: 7n,
            presence: { ...absent.presence, clientSequence: true },
            selectedSequence: 7n,
        });
        expect(protobuf_getUnknownFields(projection)).toEqual([]);
        expect(Object.getOwnPropertySymbols(projection)).toEqual([]);
    });

    it.each([
        ['zero tag', [0x00]],
        ['truncated tag', [0x80]],
        ['truncated result varint', [0x08, 0x80]],
        ['truncated string', [0x12, 0x02, 0x41]],
        ['truncated sequence varint', [0x58, 0x80]],
        ['truncated unknown varint', [0xa0, 0x01, 0x80]],
    ])('propagates malformed protobuf errors: %s', (_name, bytes) => {
        const wire = Uint8Array.from(bytes);
        expect(() => protobuf_decode<DirectSendMessageResponse>(wire)).toThrow();
        expect(() => decodeDirectSendMessageResponse(wire)).toThrow();
    });

    it('accepts a fixed standard int64 negative-one wire without changing the input', () => {
        // Synthetic protobuf bytes only; they do not assert how a C# writer encoded its output.
        const wire = Uint8Array.of(0x18, ...Array(9).fill(0xff), 0x01);
        const before = wire.slice();
        expect(protobuf_decode<DirectSendMessageResponse>(wire).sendTime).toBe(-1n);
        expect(decodeDirectSendMessageResponse(wire)).toEqual({
            ...absent,
            sendTime: -1n,
            presence: { ...absent.presence, sendTime: true },
        });
        expect(wire).toEqual(before);
    });

    it('accepts a fixed standard int64 minimum wire without changing the input', () => {
        // Synthetic protobuf bytes; this is not an observation of a C# writer or a response.
        const wire = Uint8Array.of(0x18, ...Array(9).fill(0x80), 0x01);
        const before = wire.slice();
        const sendTime = -(1n << 63n);
        expect(protobuf_decode<DirectSendMessageResponse>(wire).sendTime).toBe(sendTime);
        expect(decodeDirectSendMessageResponse(wire)).toEqual({
            ...absent,
            sendTime,
            presence: { ...absent.presence, sendTime: true },
        });
        expect(wire).toEqual(before);
    });

    it('uses Proton replacement decoding for invalid UTF-8 instead of strict validation', () => {
        const wire = Uint8Array.of(0x12, 0x01, 0xff);
        const before = wire.slice();
        expect(protobuf_decode<DirectSendMessageResponse>(wire).errMsg).toBe('\ufffd');
        expect(decodeDirectSendMessageResponse(wire)).toEqual({
            ...absent,
            errMsg: '\ufffd',
            presence: { ...absent.presence, errMsg: true },
        });
        expect(wire).toEqual(before);
    });

    it('accepts a nonminimal zero varint as a present result', () => {
        const wire = Uint8Array.of(0x08, 0x80, 0x00);
        const before = wire.slice();
        expect(protobuf_decode<DirectSendMessageResponse>(wire).result).toBe(0);
        expect(decodeDirectSendMessageResponse(wire)).toEqual({
            ...absent,
            result: 0,
            presence: { ...absent.presence, result: true },
        });
        expect(wire).toEqual(before);
    });

    it('skips a structurally valid known field number with a different wire type', () => {
        // Tag 1 expects varint, but here it is an empty length-delimited unknown field.
        const wire = Uint8Array.of(0x0a, 0x00);
        const before = wire.slice();
        const decoded = protobuf_decode<DirectSendMessageResponse>(wire);
        expect(decoded.result).toBeNull();
        expect(protobuf_getUnknownFields(decoded)).toEqual([
            { fieldNumber: 1, wireType: 2, count: 1, totalByteLength: 1 },
        ]);
        const projection = decodeDirectSendMessageResponse(wire);
        expect(projection).toEqual(absent);
        expect(protobuf_getUnknownFields(projection)).toEqual([]);
        expect(wire).toEqual(before);
    });

    it('borrows only the specified byte view and leaves the backing bytes unchanged', () => {
        const wire = encode({ errMsg: 'fixture', sequence: 9007199254740993n });
        const backing = new Uint8Array(wire.length + 2).fill(0xff);
        backing.set(wire, 1);
        const before = backing.slice();
        const view = backing.subarray(1, -1);
        const projection = decodeDirectSendMessageResponse(view);
        expect(projection.errMsg).toBe('fixture');
        expect(projection.selectedSequence).toBe(9007199254740993n);
        expect(backing).toEqual(before);
        expect(view.byteOffset).toBe(1);
        expect(view.byteLength).toBe(wire.byteLength);
    });
});
