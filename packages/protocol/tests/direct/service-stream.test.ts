import { describe, expect, it } from 'vitest';
import { decodeServiceResponse } from '../../src/direct/service-frame';
import { ServiceFrameDecoder } from '../../src/direct/service-stream';

const wire = Buffer.from('000000180000000c00000000000a313233343536deadbeef', 'hex');

describe('service TCP stream framing', () => {
    it('reassembles every split point and decodes a complete response', () => {
        for (let split = 0; split <= wire.length; split++) {
            const decoder = new ServiceFrameDecoder();
            const frames = [
                ...decoder.push(wire.subarray(0, split)),
                ...decoder.push(wire.subarray(split)),
            ];
            expect(frames).toEqual([Uint8Array.from(wire)]);
            expect(decodeServiceResponse(frames[0]).uin).toBe('123456');
            decoder.finish();
        }
    });

    it('handles byte-by-byte delivery, coalesced frames, and input mutation', () => {
        const bytes = Buffer.concat([wire, wire, wire]);
        const decoder = new ServiceFrameDecoder();
        const frames: Uint8Array[] = [];

        for (const byte of bytes) {
            frames.push(...decoder.push(Uint8Array.of(byte)));
        }

        bytes.fill(0);
        expect(frames).toEqual([
            Uint8Array.from(wire),
            Uint8Array.from(wire),
            Uint8Array.from(wire),
        ]);
        decoder.finish();
        expect(() => decoder.push(wire)).toThrow(/closed/);
    });

    it('returns coalesced frames and carries a partial next frame across chunks', () => {
        const decoder = new ServiceFrameDecoder();
        expect(decoder.push(Buffer.concat([wire, wire, wire.subarray(0, 7)]))).toEqual([
            Uint8Array.from(wire),
            Uint8Array.from(wire),
        ]);
        expect(decoder.push(wire.subarray(7))).toEqual([Uint8Array.from(wire)]);
        decoder.finish();
    });

    it('rejects invalid declared lengths and poisons the decoder', () => {
        for (const length of [0, 3, 13, 16 * 1024 * 1024 + 1, 0xffffffff]) {
            const prefix = Buffer.alloc(4);
            prefix.writeUInt32BE(length);
            const decoder = new ServiceFrameDecoder();
            expect(() => decoder.push(prefix)).toThrow(/length/);
            expect(() => decoder.push(wire)).toThrow(/closed/);
            expect(() => decoder.finish()).toThrow(/closed/);
        }
    });

    it('reports a partial prefix or incomplete frame on end-of-stream', () => {
        for (let length = 1; length < wire.length; length++) {
            const decoder = new ServiceFrameDecoder();
            expect(decoder.push(wire.subarray(0, length))).toEqual([]);
            expect(() => decoder.finish()).toThrow(/truncated/);
        }

        expect(() => new ServiceFrameDecoder().finish()).not.toThrow();
    });
});
