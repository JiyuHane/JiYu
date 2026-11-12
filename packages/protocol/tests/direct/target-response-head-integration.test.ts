import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeTargetServiceResponseBasic } from '../../src/direct/target-service-response-basic';
import { decodeTargetSso12ResponseHead } from '../../src/direct/target-sso12-response-head';
import { decodeTargetServiceBusinessResponse } from '../../src/direct/target-service-business-response';
import { inflateTargetZlibCandidate } from '../../src/direct/target-zlib-candidate';

// Synthetic local composition only: no real key, identity or authentication.
// This does not emulate native ReserveFields, conditional +4, or full validation.
const basicBytes = Uint8Array.of(
    0x12,
    0x34,
    0x56,
    0x78,
    0x87,
    0x65,
    0x43,
    0x21,
    0,
    0xa5,
    0,
    0,
    0,
    6,
    0xbe,
    0xef,
);
const headBytes = Uint8Array.of(
    0,
    0,
    0,
    43, // Inclusive head length.
    0x80,
    0,
    0,
    1, // Sequence bits, not request binding.
    0xfe,
    0xdc,
    0xba,
    0x98, // Unknown word.
    0,
    0,
    0,
    6,
    0xff,
    0, // Three inclusive byte spans.
    0,
    0,
    0,
    5,
    0x80,
    0,
    0,
    0,
    7,
    1,
    2,
    3,
    0xfe,
    0xdc,
    0xba,
    0x99, // Low bit set; no automatic inflation.
    0,
    0,
    0,
    6,
    0x81,
    0x82, // Opaque reserve bytes.
    0xde,
    0xad,
    0x7e, // Opaque tail.
);

function frame(body: Uint8Array): Uint8Array {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length + 4);
    return Uint8Array.from([...basicBytes, ...headBytes, ...length, ...body, 0xca, 0xfe]);
}

describe('synthetic basic, strict response head, business and explicit zlib candidate', () => {
    it('composes the real parsers with subview-relative offsets and opaque head fields', () => {
        const payload = Uint8Array.of(0, 0xff, 0x42, 0x80);
        const compressed = Uint8Array.from(deflateSync(payload));
        const backing = Uint8Array.from([0xee, 0xdd, ...frame(compressed), 0xbb]);
        const input = backing.subarray(1, backing.length - 1);
        const before = backing.slice();
        const basic = decodeTargetServiceResponseBasic(input, 1);
        expect(basic).toEqual({
            word0: 0x12345678,
            word4: 0x87654321,
            selector: 0,
            flag9: 0xa5,
            opaque: Uint8Array.of(0xbe, 0xef),
            nextOffset: 17,
        });
        const head = decodeTargetSso12ResponseHead(input, basic.nextOffset);
        expect(head).toEqual({
            headLength: 43,
            sequenceBits: 0x80000001,
            followingWord: 0xfedcba98,
            field1: Uint8Array.of(0xff, 0),
            field2: Uint8Array.of(0x80),
            field3: Uint8Array.of(1, 2, 3),
            flagsWord: 0xfedcba99,
            reserve: Uint8Array.of(0x81, 0x82),
            tail: Uint8Array.of(0xde, 0xad, 0x7e),
            nextOffset: 60,
        });
        expect(head.flagsWord & 1).toBe(1);
        const business = decodeTargetServiceBusinessResponse(input, head.nextOffset);
        expect(business.body).toEqual(compressed);
        expect(business.nextOffset).toBe(64 + compressed.length);
        expect(input.slice(business.nextOffset)).toEqual(Uint8Array.of(0xca, 0xfe));
        // This call is an explicit local candidate, not a consequence of the flag.
        const inflated = inflateTargetZlibCandidate(business.body, payload.length);
        expect(inflated).toEqual(payload);
        expect(backing).toEqual(before);

        head.field1[0] = 0x55;
        head.reserve[0] = 0x66;
        head.tail[0] = 0x77;
        business.body[0] ^= 0xff;
        inflated[0] = 0x88;
        expect(backing).toEqual(before);
        expect(compressed).toEqual(Uint8Array.from(deflateSync(payload)));
    });

    it('rejects each inclusive head field crossing the declared boundary despite later bytes', () => {
        for (const position of [12, 18, 23, 34]) {
            const input = frame(Uint8Array.of(1, 2, 3, 4));
            const basic = decodeTargetServiceResponseBasic(input);
            const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
            view.setUint32(basic.nextOffset + position, headBytes.length - position + 1);
            const before = input.slice();
            expect(input.length - basic.nextOffset).toBeGreaterThan(headBytes.length);
            expect(() => decodeTargetSso12ResponseHead(input, basic.nextOffset)).toThrow(
                'target sso12 response head decoding failed',
            );
            expect(input).toEqual(before);
        }

        const input = frame(Uint8Array.of(1, 2, 3, 4));
        const basic = decodeTargetServiceResponseBasic(input);
        new DataView(input.buffer, input.byteOffset, input.byteLength).setUint32(
            basic.nextOffset,
            36,
        );
        expect(() => decodeTargetSso12ResponseHead(input, basic.nextOffset)).toThrow(
            'target sso12 response head decoding failed',
        );
    });

    it('leaves a non-zlib business body opaque even with the head low bit set', () => {
        const body = Uint8Array.of(0xff, 0, 0x41, 0x42);
        const input = frame(body);
        const basic = decodeTargetServiceResponseBasic(input);
        const head = decodeTargetSso12ResponseHead(input, basic.nextOffset);
        const business = decodeTargetServiceBusinessResponse(input, head.nextOffset);
        expect(head.flagsWord & 1).toBe(1);
        expect(business.body).toEqual(body);
        expect(business.nextOffset).toBe(basic.nextOffset + headBytes.length + 4 + body.length);
        expect(input.slice(business.nextOffset)).toEqual(Uint8Array.of(0xca, 0xfe));
        expect(() => inflateTargetZlibCandidate(business.body, body.length)).toThrow(
            'target zlib candidate decoding failed',
        );
        expect(business.body).toEqual(body);
    });

    it('rejects zlib trailing bytes only when the local candidate is explicitly invoked', () => {
        const payload = Uint8Array.of(1, 2, 3);
        const body = Uint8Array.from([...deflateSync(payload), 0]);
        const input = frame(body);
        const before = input.slice();
        const basic = decodeTargetServiceResponseBasic(input);
        const head = decodeTargetSso12ResponseHead(input, basic.nextOffset);
        const business = decodeTargetServiceBusinessResponse(input, head.nextOffset);
        expect(head.flagsWord & 1).toBe(1);
        expect(business.body).toEqual(body);
        expect(business.nextOffset).toBe(basic.nextOffset + headBytes.length + 4 + body.length);
        expect(() => inflateTargetZlibCandidate(business.body, payload.length)).toThrow(
            'target zlib candidate decoding failed',
        );
        expect(business.body).toEqual(body);
        expect(input).toEqual(before);
    });
});
