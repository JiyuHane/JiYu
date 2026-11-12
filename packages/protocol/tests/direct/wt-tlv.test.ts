import { describe, expect, it } from 'vitest';
import { decodeWtTlv, encodeWtTlv, MAX_WT_TLV_BYTES } from '../../src/direct/wt-tlv';

// Independent, manually assembled byte vector; synthetic, not a real packet.
// count=4; tag 0x0001 with 2 value bytes; tag 0xfedc with zero value
// bytes; duplicate tag 0x0001 with 1 byte; tag 0xffff with 3 bytes.
const vector = Buffer.from('000400010002aabbfedc000000010001ccffff000300ff80', 'hex');
const expected = [
    { tag: 1, value: Uint8Array.of(0xaa, 0xbb) },
    { tag: 0xfedc, value: new Uint8Array() },
    { tag: 1, value: Uint8Array.of(0xcc) },
    { tag: 0xffff, value: Uint8Array.of(0, 0xff, 0x80) },
];

describe('WT TLV blocks', () => {
    it('encodes the hand-derived byte vector in stable order', () => {
        expect(Buffer.from(encodeWtTlv(expected))).toEqual(vector);
        expect(Buffer.from(encodeWtTlv([]))).toEqual(Buffer.from([0, 0]));
    });

    it('decodes the hand-derived vector, preserving duplicate and unknown tags', () => {
        expect(decodeWtTlv(vector)).toEqual(expected);
        expect(decodeWtTlv(Uint8Array.of(0, 0))).toEqual([]);
    });

    it('handles nonzero byte offsets and copies values independently', () => {
        const backing = Buffer.concat([
            Buffer.from('abcd', 'hex'),
            vector,
            Buffer.from('eeee', 'hex'),
        ]);
        const slice = backing.subarray(2, 2 + vector.length);
        const entries = decodeWtTlv(slice);
        expect(entries).toEqual(expected);
        expect(
            Buffer.from(encodeWtTlv([{ tag: 7, value: slice.subarray(6, 8) }])).toString('hex'),
        ).toBe('000100070002aabb');
        slice[6] = 0;
        expect(entries[0].value).toEqual(Uint8Array.of(0xaa, 0xbb));
        entries[2].value[0] = 0;
        expect(slice[16]).toBe(0xcc);
    });

    it('rejects every truncated vector and trailing bytes', () => {
        for (let i = 0; i < vector.length; i++) {
            expect(() => decodeWtTlv(vector.subarray(0, i))).toThrow();
        }

        expect(() => decodeWtTlv(Buffer.concat([vector, Buffer.from([0])]))).toThrow(/trailing/);
        expect(() => decodeWtTlv(Buffer.from('000000', 'hex'))).toThrow(/trailing/);
        expect(() => decodeWtTlv(Buffer.from('000100010002aa', 'hex'))).toThrow(/value/);
        expect(() => decodeWtTlv(Buffer.from('000200010000', 'hex'))).toThrow(/header/);
    });

    it('supports maximum count, tag, and value length', () => {
        const largestValue = new Uint8Array(0xffff).fill(0xa5);
        const encoded = encodeWtTlv([{ tag: 0xffff, value: largestValue }]);
        expect(Buffer.from(encoded.subarray(0, 6)).toString('hex')).toBe('0001ffffffff');
        expect(decodeWtTlv(encoded)).toEqual([{ tag: 0xffff, value: largestValue }]);

        const entries = Array.from({ length: 0xffff }, () => ({ tag: 0, value: new Uint8Array() }));
        const many = encodeWtTlv(entries);
        expect(Buffer.from(many.subarray(0, 2)).toString('hex')).toBe('ffff');
        expect(decodeWtTlv(many)).toHaveLength(0xffff);
    });

    it('rejects invalid tags, oversized values and entry counts', () => {
        for (const tag of [-1, 0x10000, 1.5, NaN, Infinity]) {
            expect(() => encodeWtTlv([{ tag, value: new Uint8Array() }])).toThrow(/tag/);
        }

        expect(() => encodeWtTlv([{ tag: 0, value: new Uint8Array(0x10000) }])).toThrow(/value/);
        const entry = { tag: 0, value: new Uint8Array() };
        expect(() => encodeWtTlv(Array(0x10000).fill(entry))).toThrow(/count/);
        expect(() => encodeWtTlv([{ tag: 0, value: [] as unknown as Uint8Array }])).toThrow(
            /value/,
        );
    });

    it('enforces the aggregate byte limit on both paths', () => {
        const full = new Uint8Array(0xffff);
        const entries = Array.from({ length: 257 }, () => ({ tag: 0, value: full }));
        expect(() => encodeWtTlv(entries)).toThrow(/size limit/);
        expect(() => decodeWtTlv(new Uint8Array(MAX_WT_TLV_BYTES + 1))).toThrow(/size/);
    });
});
