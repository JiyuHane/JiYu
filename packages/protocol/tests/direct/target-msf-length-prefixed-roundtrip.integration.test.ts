import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeTargetMsfLengthPrefixedFieldCandidate as encode } from '../../src/direct/target-msf-length-prefixed-field-candidate';
import {
    decodeTargetServiceBusinessResponse as decode,
    MAX_TARGET_SERVICE_BUSINESS_RESPONSE_BYTES,
} from '../../src/direct/target-service-business-response';

// Synthetic cross-validation only. Two independently written offline models are
// reconciled over the same self-including length-prefixed wire format
// BE32(payload.length + 4) || payload, where the 32-bit big-endian prefix is the
// total frame length and therefore counts its own four bytes. The encoder
// (target-msf-length-prefixed-field-candidate) and the decoder
// (target-service-business-response) were reverse-engineered from different
// target sites; this file asserts that one model's output is exactly the other
// model's input. It claims no real login, no real MSF/SSO packet, no target
// reachability, and no QQ interoperability. Every payload below is a fabricated
// local fixture. The decode-side ceiling
// (MAX_TARGET_SERVICE_BUSINESS_RESPONSE_BYTES) is imported for boundary
// description only and is never actually allocated here.
const PREFIX_BYTES = 4;
const DECODE_ERROR = 'target service business response decoding failed';

let guards: Array<{ mock: { calls: readonly unknown[] } }> = [];

function blocked(): never {
    throw new Error('unexpected effect');
}

function bytes(values: number[]): Uint8Array {
    return Uint8Array.from(values);
}

function ramp(length: number, seed = 1): Uint8Array {
    // Deterministic nonzero fill so copied bytes stay visible against the prefix.
    return Uint8Array.from({ length }, (_, index) => (index * 37 + seed * 11) & 0xff || 0xa5);
}

// Independent BE32 reader over the raw output bytes, not a reuse of either model.
function readPrefix(frame: Uint8Array, offset = 0): number {
    return (
        (frame[offset] << 24) |
        (frame[offset + 1] << 16) |
        (frame[offset + 2] << 8) |
        frame[offset + 3]
    );
}

function expectDecodeFailure(operation: () => unknown): void {
    let caught: unknown;

    try {
        operation();
    } catch (error) {
        caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(DECODE_ERROR);
    expect((caught as Error).cause).toBeUndefined();
}

beforeEach(() => {
    guards = [
        vi.spyOn(net, 'connect').mockImplementation(blocked),
        vi.spyOn(net, 'createConnection').mockImplementation(blocked),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(blocked),
        vi.spyOn(http, 'request').mockImplementation(blocked),
        vi.spyOn(http, 'get').mockImplementation(blocked),
        vi.spyOn(https, 'request').mockImplementation(blocked),
        vi.spyOn(https, 'get').mockImplementation(blocked),
        vi.spyOn(tls, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram, 'createSocket').mockImplementation(blocked),
        vi.spyOn(process, 'dlopen').mockImplementation(blocked),
        vi.spyOn(console, 'log').mockImplementation(() => {}),
        vi.spyOn(console, 'warn').mockImplementation(() => {}),
        vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];
    const fetch = vi.fn(blocked);
    const webSocket = vi.fn(blocked);
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('WebSocket', webSocket);
    guards.push(fetch, webSocket);
    syncBuiltinESMExports();
});

afterEach(() => {
    try {
        for (const guard of guards) {
            expect(guard.mock.calls).toHaveLength(0);
        }
    } finally {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        syncBuiltinESMExports();
        guards = [];
    }
});

describe('offline target MSF length-prefixed self-including round-trip', () => {
    it('round-trips encode -> decode byte for byte across varied payloads', () => {
        const cases: Uint8Array[] = [
            new Uint8Array(0),
            bytes([0x11]),
            bytes([0x00, 0xff, 0x00]),
            bytes([0x00, 0xff, 0x7f, 0x80, 0x01, 0x00, 0xfe]),
            ramp(16, 2),
            ramp(255, 3),
            ramp(1024, 4),
        ];

        for (const payload of cases) {
            const frame = encode(payload);

            // The producer emits BE32(len+4) || payload with the prefix counting
            // its own four bytes.
            expect(frame).toHaveLength(payload.length + PREFIX_BYTES);
            expect(readPrefix(frame)).toBe(payload.length + PREFIX_BYTES);
            expect(frame[0]).toBe(((payload.length + PREFIX_BYTES) >>> 24) & 0xff);
            expect(frame[1]).toBe(((payload.length + PREFIX_BYTES) >>> 16) & 0xff);
            expect(frame[2]).toBe(((payload.length + PREFIX_BYTES) >>> 8) & 0xff);
            expect(frame[3]).toBe((payload.length + PREFIX_BYTES) & 0xff);

            // The consumer reads exactly that frame back into the original body.
            const decoded = decode(frame);
            expect(decoded.body).toBeInstanceOf(Uint8Array);
            expect(decoded.body).toHaveLength(payload.length);
            expect(decoded.nextOffset).toBe(frame.length);

            for (let index = 0; index < payload.length; index++) {
                expect(decoded.body[index]).toBe(payload[index]);
            }

            expect(Uint8Array.from(decoded.body)).toEqual(Uint8Array.from(payload));
        }
    });

    it('decodes a frame placed at a nonzero offset behind prefix garbage', () => {
        const payload = ramp(37, 5);
        const frame = encode(payload);
        const prefix = bytes([0xde, 0xad, 0xbe, 0xef, 0x00, 0x13]);

        const buffer = new Uint8Array(prefix.length + frame.length);
        buffer.set(prefix, 0);
        buffer.set(frame, prefix.length);

        const decoded = decode(buffer, prefix.length);
        expect(decoded.body).toEqual(payload);
        expect(decoded.nextOffset).toBe(prefix.length + frame.length);

        // The length field read is anchored at the offset, not at buffer start.
        expect(readPrefix(buffer, prefix.length)).toBe(payload.length + PREFIX_BYTES);
    });

    it('decodes two concatenated frames in sequence using nextOffset', () => {
        const payloadA = ramp(19, 6);
        const payloadB = bytes([0x00, 0x01, 0x02, 0xfd, 0xfe, 0xff]);
        const frameA = encode(payloadA);
        const frameB = encode(payloadB);

        const stream = new Uint8Array(frameA.length + frameB.length);
        stream.set(frameA, 0);
        stream.set(frameB, frameA.length);

        const first = decode(stream, 0);
        expect(first.body).toEqual(payloadA);
        expect(first.nextOffset).toBe(frameA.length);

        const second = decode(stream, first.nextOffset);
        expect(second.body).toEqual(payloadB);
        expect(second.nextOffset).toBe(frameA.length + frameB.length);
        expect(second.nextOffset).toBe(stream.length);
    });

    it('agrees on big-endian prefixes whose totals cross byte boundaries', () => {
        // len 252 -> total 256 = 0x00000100 -> prefix 00 00 01 00.
        const payload = ramp(252, 7);
        const frame = encode(payload);
        expect(Array.from(frame.subarray(0, PREFIX_BYTES))).toEqual([0x00, 0x00, 0x01, 0x00]);
        expect(readPrefix(frame)).toBe(256);

        const decoded = decode(frame);
        expect(decoded.body).toEqual(payload);
        expect(decoded.nextOffset).toBe(256);

        // len 65532 -> total 65536 = 0x00010000 -> prefix 00 01 00 00.
        const wide = ramp(65532, 8);
        const wideFrame = encode(wide);
        expect(Array.from(wideFrame.subarray(0, PREFIX_BYTES))).toEqual([0x00, 0x01, 0x00, 0x00]);
        const wideDecoded = decode(wideFrame);
        expect(wideDecoded.body).toEqual(wide);
        expect(wideDecoded.nextOffset).toBe(65536);
    });

    it('rejects a frame truncated by one trailing byte with the fixed error', () => {
        const payload = ramp(40, 9);
        const frame = encode(payload);
        // Dropping the last byte leaves the prefix claiming more than is available.
        const truncated = frame.subarray(0, frame.length - 1);

        // The slice still declares the full self-including length in its prefix.
        expect(readPrefix(truncated)).toBe(payload.length + PREFIX_BYTES);
        expect(truncated.length).toBe(payload.length + PREFIX_BYTES - 1);
        expectDecodeFailure(() => decode(truncated));
    });

    it('rejects a frame whose length field was lowered below the 4-byte minimum', () => {
        const payload = ramp(12, 10);
        const frame = encode(payload);
        const tampered = Uint8Array.from(frame);
        // Rewrite the inclusive length to 3 (< the 4-byte prefix it must cover).
        tampered[0] = 0x00;
        tampered[1] = 0x00;
        tampered[2] = 0x00;
        tampered[3] = 0x03;

        expect(readPrefix(tampered)).toBe(3);
        expectDecodeFailure(() => decode(tampered));

        // The encoder is never reinvoked here; the original frame is untouched and
        // still well below the imported decode ceiling.
        expect(readPrefix(frame)).toBe(payload.length + PREFIX_BYTES);
        expect(readPrefix(frame)).toBeLessThan(MAX_TARGET_SERVICE_BUSINESS_RESPONSE_BYTES);
    });

    it('returns a decoded body that does not alias the input frame storage', () => {
        const payload = ramp(48, 11);
        const frame = encode(payload);
        const frameBefore = Uint8Array.from(frame);

        const decoded = decode(frame);
        expect(decoded.body).toEqual(payload);

        // The body is an independent copy, not a view onto the frame's buffer.
        expect(decoded.body.buffer).not.toBe(frame.buffer);

        // Mutating the input frame after the call must not reach the body.
        const bodyBefore = Uint8Array.from(decoded.body);
        frame.fill(0x5a);
        expect(decoded.body).toEqual(bodyBefore);

        // Mutating the body must not reach back into the (now overwritten) frame.
        decoded.body.fill(0xa5);
        expect(frame).toEqual(new Uint8Array(frame.length).fill(0x5a));

        // And decoding never mutated the original bytes before we overwrote them.
        expect(frameBefore).toEqual(encode(payload));
    });
});
