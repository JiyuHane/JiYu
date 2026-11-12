import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { decodeTargetServiceResponseBasic } from '../../src/direct/target-service-response-basic';
import { decodeTargetServiceBusinessResponse } from '../../src/direct/target-service-business-response';
import { decodeTargetSso12ResponsePrefix } from '../../src/direct/target-sso12-response-prefix';
import { inflateTargetZlibCandidate } from '../../src/direct/target-zlib-candidate';

// Synthetic bytes only: these probes neither authenticate a peer nor bind a request.
const prefixError = 'target sso12 response prefix decoding failed';
const businessError = 'target service business response decoding failed';
const inflateError = 'target zlib candidate decoding failed';

// A manually assembled inclusive 15-byte head, followed by an inclusive wrapper.
function response(body: Uint8Array, followingWord = 0): Uint8Array {
    const head = Buffer.from([
        0,
        0,
        0,
        15,
        0x80,
        0,
        0,
        1,
        (followingWord >>> 24) & 0xff,
        (followingWord >>> 16) & 0xff,
        (followingWord >>> 8) & 0xff,
        followingWord & 0xff,
        0xde,
        0xad,
        0x01,
    ]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length + 4);
    return Uint8Array.from(Buffer.concat([head, length, body]));
}

// This local concatenation is synthetic only. It establishes neither native dynamic
// reachability, complete header/reserve semantics, nor server authentication.
function basicResponse(remainder: Uint8Array, selector = 0): Uint8Array {
    return Uint8Array.from([
        0x12,
        0x34,
        0x56,
        0x78, // Opaque BE32; not a total-length assertion.
        0x87,
        0x65,
        0x43,
        0x21, // Another BE32 with no assigned meaning.
        selector,
        0xa5, // Selector and opaque byte at offset 9.
        0,
        0,
        0,
        6,
        0xbe,
        0xef, // Inclusive L and opaque bytes.
        ...remainder,
    ]);
}

describe('synthetic response prefix, business wrapper and explicit zlib candidate', () => {
    it('composes synthetic basic, strict head, business and explicit inflate at exact offsets', () => {
        const payload = Uint8Array.of(0, 0xff, 0x42, 0x80);
        const compressed = Uint8Array.from(deflateSync(payload));
        const frame = basicResponse(response(compressed, 0xfedcba98));
        const backing = Uint8Array.from([0xee, 0xdd, ...frame, 0xca, 0xfe, 0xbb]);
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
        const prefix = decodeTargetSso12ResponsePrefix(input, basic.nextOffset);
        expect(prefix).toEqual({
            headLength: 15,
            sequenceBits: 0x80000001,
            followingWord: 0xfedcba98,
            remainingHead: Uint8Array.of(0xde, 0xad, 1),
            nextOffset: basic.nextOffset + 15,
        });
        const business = decodeTargetServiceBusinessResponse(input, prefix.nextOffset);
        expect(business.body).toEqual(compressed);
        expect(business.nextOffset).toBe(prefix.nextOffset + 4 + compressed.length);
        expect(input.slice(business.nextOffset)).toEqual(Uint8Array.of(0xca, 0xfe));
        const inflated = inflateTargetZlibCandidate(business.body, payload.length);
        expect(inflated).toEqual(payload);
        expect(backing).toEqual(before);

        basic.opaque[0] = 0;
        prefix.remainingHead[0] = 0;
        business.body[0] ^= 0xff;
        inflated[0] = 0x99;
        expect(backing).toEqual(before);
        expect(compressed).toEqual(Uint8Array.from(deflateSync(payload)));
        backing.fill(0);
        expect(basic.opaque).toEqual(Uint8Array.of(0, 0xef));
        expect(prefix.remainingHead).toEqual(Uint8Array.of(0, 0xad, 1));
        expect(business.body.subarray(1)).toEqual(compressed.subarray(1));
        expect(inflated).toEqual(Uint8Array.of(0x99, ...payload.subarray(1)));
    });

    it('leaves a nonzero-selector remainder for the caller without parsing a head', () => {
        const frame = basicResponse(response(Uint8Array.of(1, 2, 3)), 2);
        const before = frame.slice();
        const basic = decodeTargetServiceResponseBasic(frame);
        const parseHead = vi.fn(decodeTargetSso12ResponsePrefix);

        // This fixture has no decryption step: the caller must handle the selector
        // before attempting any header parsing; no successful result is claimed.
        if (basic.selector === 0) {
            parseHead(frame, basic.nextOffset);
        }

        expect(basic.selector).toBe(2);
        expect(parseHead).not.toHaveBeenCalled();
        expect(frame.slice(basic.nextOffset)).toEqual(response(Uint8Array.of(1, 2, 3)));
        expect(frame).toEqual(before);
    });

    it('rejects malformed lengths at each stage and accepts a false first word only as basic', () => {
        const frame = basicResponse(response(Uint8Array.of(1, 2, 3)));
        const basic = decodeTargetServiceResponseBasic(frame);
        expect(basic.word0).toBe(0x12345678);
        expect(basic.word0).not.toBe(frame.length);
        expect(basic.nextOffset).toBe(16);

        for (const length of [0, 1, 2, 3, 0xffffffff]) {
            const malformed = frame.slice();
            new DataView(malformed.buffer).setUint32(10, length);
            const before = malformed.slice();
            expect(() => decodeTargetServiceResponseBasic(malformed)).toThrow(
                'target service response basic decoding failed',
            );
            expect(malformed).toEqual(before);
        }

        for (const truncated of [frame.subarray(0, 13), frame.subarray(0, 15)]) {
            const before = truncated.slice();
            expect(() => decodeTargetServiceResponseBasic(truncated)).toThrow(
                'target service response basic decoding failed',
            );
            expect(truncated).toEqual(before);
        }

        for (const length of [3, 11, 0xffffffff]) {
            const malformed = frame.slice();
            new DataView(malformed.buffer).setUint32(basic.nextOffset, length);
            const before = malformed.slice();
            expect(() => decodeTargetSso12ResponsePrefix(malformed, basic.nextOffset)).toThrow(
                prefixError,
            );
            expect(malformed).toEqual(before);
        }

        const prefix = decodeTargetSso12ResponsePrefix(frame, basic.nextOffset);

        for (const length of [0, 3, 0xffffffff]) {
            const malformed = frame.slice();
            new DataView(malformed.buffer).setUint32(prefix.nextOffset, length);
            const before = malformed.slice();
            expect(() => decodeTargetServiceBusinessResponse(malformed, prefix.nextOffset)).toThrow(
                businessError,
            );
            expect(malformed).toEqual(before);
        }

        const truncated = frame.subarray(0, frame.length - 1);
        const before = truncated.slice();
        expect(() => decodeTargetServiceBusinessResponse(truncated, prefix.nextOffset)).toThrow(
            businessError,
        );
        expect(truncated).toEqual(before);
    });
    it('composes the three real decoders with subview-relative offsets and independent outputs', () => {
        const payload = Uint8Array.of(0, 0xff, 0x41, 0x80, 0x00, 0x7e, 0x42);
        const compressed = deflateSync(payload);
        const frame = response(compressed, 0xfedcba98);
        const backing = Uint8Array.from([0xaa, 0xbb, 0xcc, ...frame, 0xdd, 0xee]);
        const input = backing.subarray(1, backing.length - 1);
        const before = backing.slice();
        const compressedBefore = Uint8Array.from(compressed);

        const prefix = decodeTargetSso12ResponsePrefix(input, 2);
        expect(prefix).toEqual({
            headLength: 15,
            sequenceBits: 0x80000001,
            followingWord: 0xfedcba98,
            remainingHead: Uint8Array.of(0xde, 0xad, 0x01),
            nextOffset: 17,
        });
        const business = decodeTargetServiceBusinessResponse(input, prefix.nextOffset);
        expect(business.body).toEqual(compressedBefore);
        expect(business.nextOffset).toBe(17 + 4 + compressed.length);
        expect(input[business.nextOffset]).toBe(0xdd);
        const decoded = inflateTargetZlibCandidate(business.body, payload.length);
        expect(decoded).toEqual(payload);
        expect(backing).toEqual(before);
        expect(compressed).toEqual(Buffer.from(compressedBefore));
        expect(business.body).toEqual(compressedBefore);

        prefix.remainingHead[0] = 0;
        business.body[0] ^= 0xff;
        decoded[0] = 0x99;
        expect(backing).toEqual(before);
        expect(compressed).toEqual(Buffer.from(compressedBefore));
        expect(decoded.subarray(1)).toEqual(payload.subarray(1));
        backing.fill(0);
        expect(prefix.remainingHead).toEqual(Uint8Array.of(0, 0xad, 0x01));
        expect(business.body.subarray(1)).toEqual(compressedBefore.subarray(1));
        expect(decoded).toEqual(Uint8Array.of(0x99, ...payload.subarray(1)));
    });

    it('locally rejects each short declared head even when business bytes are present', () => {
        for (let length = 5; length <= 11; length++) {
            const frame = response(deflateSync(Uint8Array.of(1, 2, 3)));
            frame[3] = length;
            const before = frame.slice();
            expect(() => decodeTargetSso12ResponsePrefix(frame)).toThrow(prefixError);
            expect(frame).toEqual(before);
        }
    });

    it('rejects a head declaration beyond the supplied view', () => {
        const frame = response(Uint8Array.of(0x41));
        frame[3] = frame.length + 1;
        const before = frame.slice();
        expect(() => decodeTargetSso12ResponsePrefix(frame)).toThrow(prefixError);
        expect(frame).toEqual(before);
    });

    it('rejects a truncated business length and an incomplete declared business body', () => {
        const complete = response(Uint8Array.of(1, 2, 3));

        for (const frame of [complete.subarray(0, 18), complete.subarray(0, complete.length - 1)]) {
            const before = frame.slice();
            const prefix = decodeTargetSso12ResponsePrefix(frame);
            expect(prefix.nextOffset).toBe(15);
            expect(() => decodeTargetServiceBusinessResponse(frame, prefix.nextOffset)).toThrow(
                businessError,
            );
            expect(frame).toEqual(before);
        }
    });

    it('accepts the business envelope but explicitly rejects zlib trailing bytes', () => {
        const compressed = deflateSync(Uint8Array.of(1, 2, 3));
        const body = Uint8Array.from([...compressed, 0]);
        const frame = response(body, 1);
        const before = frame.slice();
        const prefix = decodeTargetSso12ResponsePrefix(frame);
        const business = decodeTargetServiceBusinessResponse(frame, prefix.nextOffset);
        expect(business.nextOffset).toBe(frame.length);
        expect(business.body).toEqual(body);
        expect(() => inflateTargetZlibCandidate(business.body, 3)).toThrow(inflateError);
        expect(business.body).toEqual(body);
        expect(frame).toEqual(before);
    });

    it('accepts the business envelope but rejects an insufficient explicit output limit', () => {
        const payload = Uint8Array.of(1, 2, 3, 4);
        const compressed = deflateSync(payload);
        const frame = response(compressed, 0);
        const before = frame.slice();
        const prefix = decodeTargetSso12ResponsePrefix(frame);
        const business = decodeTargetServiceBusinessResponse(frame, prefix.nextOffset);
        expect(business.nextOffset).toBe(frame.length);
        expect(business.body).toEqual(Uint8Array.from(compressed));
        expect(() => inflateTargetZlibCandidate(business.body, 3)).toThrow(inflateError);
        expect(business.body).toEqual(Uint8Array.from(compressed));
        expect(frame).toEqual(before);
    });

    it('keeps a non-zlib body opaque regardless of head bits without invoking inflate', () => {
        const body = Uint8Array.of(0xff, 0, 0x41, 0x42);

        for (const word of [0, 1, 0xffffffff]) {
            const frame = response(body, word);
            const before = frame.slice();
            const prefix = decodeTargetSso12ResponsePrefix(frame);
            const business = decodeTargetServiceBusinessResponse(frame, prefix.nextOffset);
            expect(prefix.sequenceBits).toBe(0x80000001);
            expect(prefix.followingWord).toBe(word);
            expect(prefix.remainingHead).toEqual(Uint8Array.of(0xde, 0xad, 1));
            expect(business.body).toEqual(body);
            expect(business.nextOffset).toBe(frame.length);
            expect(frame).toEqual(before);
        }
    });
});
