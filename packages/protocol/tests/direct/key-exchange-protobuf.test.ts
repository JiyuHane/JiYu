import { protobuf_getUnknownFields } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';
import {
    decodeKeyExchangeRequest,
    decodeKeyExchangeRequestBuf,
    decodeKeyExchangeResponse,
    decodeKeyExchangeResponseSecret,
    decodeNTLoginForwardRequest,
    encodeKeyExchangeRequest,
    encodeKeyExchangeRequestBuf,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
    encodeNTLoginForwardRequest,
} from '../../src/direct/key-exchange-protobuf';

// Synthetic wire vectors based only on the public NTEcdh.cs declarations.
// They are not captured samples and do not verify online login interoperability.
const bytes = (hex: string): Uint8Array => Buffer.from(hex, 'hex');
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');

describe('offline key-exchange protobufs', () => {
    it('encodes and decodes a request including a signed int64 timestamp', () => {
        const value = {
            publicKey: bytes('0102'),
            type: 1,
            secret: bytes('aabb'),
            timestamp: -1n,
            verifyHash: bytes('cc'),
        };
        const wire = '0a02010210011a02aabb20ffffffffffffffffff012a01cc';
        expect(hex(encodeKeyExchangeRequest(value))).toBe(wire);
        expect(decodeKeyExchangeRequest(bytes(wire))).toMatchObject(value);
    });

    it('encodes and decodes the response, keeping field 2 uninterpreted', () => {
        const value = { secret: bytes('aa'), field2: bytes('bbcc'), publicKey: bytes('dd') };
        const wire = '0a01aa1202bbcc1a01dd';
        expect(hex(encodeKeyExchangeResponse(value))).toBe(wire);
        expect(decodeKeyExchangeResponse(bytes(wire))).toMatchObject(value);
    });

    it('encodes and decodes the inner request with UTF-8 UIN', () => {
        const value = { uin: '123', guid: bytes('abcd') };
        const wire = '0a033132331202abcd';
        expect(hex(encodeKeyExchangeRequestBuf(value))).toBe(wire);
        expect(decodeKeyExchangeRequestBuf(bytes(wire))).toMatchObject(value);
    });

    it('encodes and decodes response secret without inventing credentials', () => {
        const value = {
            sessionKey: bytes('0102'),
            sessionTicket: bytes('aabbcc'),
            expiration: 300,
        };
        const wire = '0a0201021203aabbcc18ac02';
        expect(hex(encodeKeyExchangeResponseSecret(value))).toBe(wire);
        expect(decodeKeyExchangeResponseSecret(bytes(wire))).toMatchObject(value);

        for (const bad of ['', '0a0101', '120102', '0a00120102', '0a01011200']) {
            expect(() => decodeKeyExchangeResponseSecret(bytes(bad))).toThrow(
                /session(Key|Ticket)/,
            );
        }

        expect(() => encodeKeyExchangeResponseSecret({ sessionKey: bytes('01') })).toThrow(
            /sessionTicket/,
        );
    });

    it('encodes forward fields with the gap at tag 2', () => {
        const value = {
            sessionTicket: bytes('01'),
            buffer: bytes('0203'),
            type: 2,
            secBuffer: bytes('04'),
        };
        const wire = '0a01011a02020320022a0104';
        expect(hex(encodeNTLoginForwardRequest(value))).toBe(wire);
        expect(decodeNTLoginForwardRequest(bytes(wire))).toMatchObject(value);
    });

    it('retains Proton unknown field metadata without inventing its semantics', () => {
        const response = decodeKeyExchangeResponse(bytes('0a01aa1202bbcc1a01dd4807'));
        expect(response.field2).toEqual(bytes('bbcc'));
        expect(protobuf_getUnknownFields(response)).toEqual([
            { fieldNumber: 9, wireType: 0, count: 1, totalByteLength: 1 },
        ]);
        expect(hex(encodeKeyExchangeResponse(response))).toBe('0a01aa1202bbcc1a01dd');
    });

    it('rejects truncated and malformed wire fields', () => {
        const decoders = [
            decodeKeyExchangeRequest,
            decodeKeyExchangeRequestBuf,
            decodeKeyExchangeResponse,
            decodeKeyExchangeResponseSecret,
            decodeNTLoginForwardRequest,
        ];

        for (const decode of decoders) {
            for (const wire of ['0a02ff', '0a80', '0880', '00', '0b14']) {
                expect(() => decode(bytes(wire))).toThrow();
            }
        }

        const wire = bytes('0a0201021203aabbcc18ac02');

        for (let length = 0; length < wire.length; length++) {
            // A prefix ending after both credentials is itself a valid protobuf message.
            if (length !== 9) {
                expect(() => decodeKeyExchangeResponseSecret(wire.subarray(0, length))).toThrow();
            }
        }
    });

    it('rejects absent or empty response fields and invalid external input', () => {
        for (const wire of ['', '0a01aa', '1a01dd', '0a001a01dd', '0a01aa1a00']) {
            expect(() => decodeKeyExchangeResponse(bytes(wire))).toThrow();
        }

        expect(() => encodeKeyExchangeRequest({ type: -1 })).toThrow(/uint32/);
        expect(() => encodeKeyExchangeRequest({ type: 0x100000000 })).toThrow(/uint32/);
        expect(() => encodeKeyExchangeRequest({ timestamp: 1n << 63n })).toThrow(/int64/);
        expect(() => encodeKeyExchangeRequest({ timestamp: -(1n << 63n) - 1n })).toThrow(/int64/);
        expect(() => decodeKeyExchangeRequest(null as never)).toThrow(/bytes/);
        expect(() => encodeKeyExchangeRequest({ publicKey: 'not bytes' as never })).toThrow(
            /bytes/,
        );
    });
});
