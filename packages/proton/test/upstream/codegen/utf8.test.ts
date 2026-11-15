import { deepStrictEqual } from 'node:assert';
import { describe, it, expect } from 'vitest';
import { schemaRegistry } from '../schema';
import { generateCode } from '../../../src/codegen/generator';

const code = generateCode(
    schemaRegistry(`
  interface Text { value: pb<1,string>; }
  interface Nested { texts: pb_repeated<1,Text>; }
  interface Entry { key: pb<1,string>; value: pb<2,string>; }
  interface Entries { entries: pb_repeated<1,Entry>; }
`),
);
const { encode, decode, encodeNested, decodeNested, encodeEntries, decodeEntries } =
    new Function(`${code}
  return {
    encode: protobuf_encode_Text, decode: protobuf_decode_Text,
    encodeNested: protobuf_encode_Nested, decodeNested: protobuf_decode_Nested,
    encodeEntries: protobuf_encode_Entries, decodeEntries: protobuf_decode_Entries,
  };`)() as {
        decode(bytes: Uint8Array): { value: string };
        encode(value: { value: string }): Uint8Array;
        encodeNested(value: { texts: { value: string }[] }): Uint8Array;
        decodeNested(bytes: Uint8Array): { texts: { value: string }[] };
        encodeEntries(value: { entries: { key: string; value: string }[] }): Uint8Array;
        decodeEntries(bytes: Uint8Array): { entries: { key: string; value: string }[] };
    };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

function wire(payload: Uint8Array): Uint8Array {
    const prefix = [10];
    let length = payload.length;

    do {
        prefix.push((length & 127) | (length >= 128 ? 128 : 0));
        length >>>= 7;
    } while (length);

    return Uint8Array.from([...prefix, ...payload]);
}

describe('UTF-8 codecs', () => {
    it('matches TextEncoder across native encoding boundaries, including unpaired surrogates', () => {
        for (const length of [31, 32, 33, 42, 43, 63, 64, 65, 127, 128, 129, 4096]) {
            for (const unit of ['a', 'é', '中文', '🚀', '\ud800', '\udc00', 'a\ud800']) {
                const value = unit.repeat(length);
                // Generic iterable equality repeats per-byte work on these large views.
                deepStrictEqual(encode({ value }), wire(encoder.encode(value)));
            }
        }
    });

    it('preserves every ASCII byte across short and native decoding boundaries', () => {
        for (const length of [
            0, 1, 3, 4, 7, 8, 15, 16, 23, 24, 30, 31, 32, 33, 63, 64, 127, 128, 4096,
        ]) {
            for (let byte = 0; byte < 128; byte++) {
                const value = String.fromCharCode(byte).repeat(length);
                deepStrictEqual(
                    encode({ value }),
                    length ? wire(encoder.encode(value)) : new Uint8Array(),
                );
                expect(decode(wire(encoder.encode(value)))).toEqual({ value });
            }
        }
    });

    it('matches TextDecoder for Unicode after ASCII prefixes and at slice boundaries', () => {
        const suffixes = [
            '\u0080',
            'é',
            '\u07ff',
            '\u0800',
            '中文',
            '\ud7ff',
            '\ue000',
            '\uffff',
            '🚀',
            '\u{10000}',
            '\u{10ffff}',
            '\ufeff',
            '\ufeffx\ufeff',
            '\ud800',
            '\udc00',
        ];

        for (let length = 0; length <= 64; length++) {
            for (const suffix of suffixes) {
                const value = 'a'.repeat(length) + suffix;
                const payload = encoder.encode(value);
                const bytes = wire(payload);
                const padded = Uint8Array.from([255, 255, ...bytes, 128, 128]);
                expect(decode(padded.subarray(2, 2 + bytes.length)).value).toBe(
                    decoder.decode(payload),
                );
            }
        }
    });

    it('matches replacement behavior for all one-byte and two-byte sequences', () => {
        const payload = new Uint8Array(2);

        for (let first = 0; first < 256; first++) {
            payload[0] = first;
            const one = payload.subarray(0, 1);
            expect(decode(wire(one)).value).toBe(decoder.decode(one));

            for (let second = 0; second < 256; second++) {
                payload[1] = second;
                expect(decode(wire(payload)).value).toBe(decoder.decode(payload));
            }
        }
    });

    it('matches TextDecoder across randomized valid Unicode strings', () => {
        let state = 0x5a17cafe;

        for (let sample = 0; sample < 5000; sample++) {
            let value = 'a'.repeat(sample % 17);

            for (let index = 0; index < sample % 21; index++) {
                state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
                value += String.fromCodePoint(state % 0x110000);
            }

            const payload = encoder.encode(value);
            expect(decode(wire(payload)).value).toBe(decoder.decode(payload));
        }
    });

    it('matches TextDecoder for invalid and truncated multibyte sequences', () => {
        const sequences = [
            [0xe0, 0x80, 0x80],
            [0xed, 0xa0, 0x80],
            [0xf0, 0x80, 0x80, 0x80],
            [0xf4, 0x90, 0x80, 0x80],
            [0xf5, 0x80, 0x80, 0x80],
            [0xff],
            [0xc2],
            [0xe1, 0x80],
            [0xf1, 0x80, 0x80],
            [0xe1, 65, 0x80],
            [0xf1, 0x80, 65, 0x80],
            [0xef, 0xbb, 0xbf, 0xff],
        ];

        for (let length = 0; length <= 33; length++) {
            for (const sequence of sequences) {
                const payload = Uint8Array.from([...Array(length).fill(65), ...sequence]);
                expect(decode(wire(payload)).value).toBe(decoder.decode(payload));
            }
        }

        let state = 0x42abcdef;

        for (let sample = 0; sample < 5000; sample++) {
            const payload = Uint8Array.from({ length: sample % 65 }, () => {
                state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
                return state >>> 24;
            });
            expect(decode(wire(payload)).value).toBe(decoder.decode(payload));
        }
    });

    it('preserves leading BOM bytes and replacement behavior at exact payload boundaries', () => {
        // Decoder selects the short path through 32 bytes, long from 33;
        // long decoding tries the strict decoder from 128 bytes.
        for (const length of [31, 32, 33, 127, 128]) {
            for (const suffix of [[], [0xff], [0xe1, 0x80]]) {
                const payload = Uint8Array.from([
                    0xef,
                    0xbb,
                    0xbf,
                    ...Array(length - 3 - suffix.length).fill(0x41),
                    ...suffix,
                ]);
                expect(payload.length).toBe(length);
                expect(decode(wire(payload)).value).toBe(decoder.decode(payload));
                expect(decode(wire(payload)).value.startsWith('\ufeff')).toBe(true);
            }
        }

        for (const [hex, expected] of [
            ['efbbbf41', '\ufeffA'],
            ['efbbbfefbbbf41', '\ufeff\ufeffA'],
            ['41efbbbf42', 'A\ufeffB'],
            ['efbbbfff', '\ufeff\ufffd'],
        ]) {
            const payload = Uint8Array.from(Buffer.from(hex, 'hex'));
            expect(decode(wire(payload)).value).toBe(expected);
            expect(decode(wire(payload)).value).toBe(decoder.decode(payload));
        }

        expect(Buffer.from(encode({ value: '\ufeffA' })).toString('hex')).toBe('0a04efbbbf41');
    });

    it('keeps nested and repeated strings independent', () => {
        const texts = [
            '',
            'ascii',
            'a'.repeat(31),
            'a'.repeat(32),
            '中文🚀',
            'a\ufeffb',
            '\ufeffx',
            '\ufeff\ufeffx',
            ...[31, 32, 33, 127, 128].map((length) => '\ufeff' + 'a'.repeat(length - 3)),
            '中文🚀'.repeat(64),
        ].map((value) => ({ value }));
        expect(decodeNested(encodeNested({ texts }))).toEqual({
            texts: texts.map(({ value }) => ({ value: decoder.decode(encoder.encode(value)) })),
        });
        // A truncated UTF-8 sequence must not consume bytes from the following field.
        const first = wire(Uint8Array.from([0xf0, 0x9f]));
        const second = wire(encoder.encode('next'));
        const nested = Uint8Array.from([10, first.length, ...first, 10, second.length, ...second]);
        expect(decodeNested(nested)).toEqual({ texts: [{ value: '�' }, { value: 'next' }] });
    });

    it('retains distinct BOM and plain keys in map-shaped repeated entries', () => {
        // Entry-shaped wire only; this does not assert map runtime semantics.
        const entries = [
            { key: '\ufeffk', value: '\ufeff' + 'x'.repeat(125) },
            { key: 'k', value: '\ufeffshort' },
        ];
        const result = decodeEntries(encodeEntries({ entries }));
        expect(result.entries).toEqual(entries);
        expect(new Map(result.entries.map(({ key, value }) => [key, value])).size).toBe(2);
    });

    it('resets long strict decoder state after a malformed field', () => {
        const invalid = Uint8Array.from([0xef, 0xbb, 0xbf, ...Array(124).fill(0x41), 0xff]);
        const valid = Uint8Array.from([0xef, 0xbb, 0xbf, ...Array(125).fill(0x42)]);
        expect(invalid.length).toBe(128);
        expect(valid.length).toBe(128);
        const first = wire(invalid);
        const second = wire(valid);
        // Nested frame lengths exceed 127, so encode each frame length as varint.
        const wrap = (field: Uint8Array) => [
            10,
            (field.length & 127) | 128,
            field.length >>> 7,
            ...field,
        ];
        const nested = Uint8Array.from([...wrap(first), ...wrap(second)]);
        expect(decodeNested(nested)).toEqual({
            texts: [{ value: decoder.decode(invalid) }, { value: decoder.decode(valid) }],
        });
        expect(decodeNested(nested).texts[1].value.startsWith('\ufeff')).toBe(true);
    });

    it('measures UTF-8 correctly when a code point crosses a scratch-buffer boundary', () => {
        for (const length of [4093, 4094, 4095, 4096, 4097, 8191]) {
            for (const suffix of ['é', '中', '🚀', '\ud800', '\udc00', '\ud800x']) {
                const value = 'a'.repeat(length) + suffix + '中文🚀'.repeat(4000);
                deepStrictEqual(encode({ value }), wire(encoder.encode(value)));
            }
        }
    });

    it('preserves replacement and BOM behavior after long malformed inputs', () => {
        for (const length of [127, 128, 129, 255, 4095, 4096, 4097]) {
            for (const sequence of [
                [0xff],
                [0xe0, 0x80, 0x80],
                [0xed, 0xa0, 0x80],
                [0xf0, 0x9f],
                [0xef, 0xbb, 0xbf],
            ]) {
                for (const prefix of [[], [0xef, 0xbb, 0xbf]]) {
                    const payload = Uint8Array.from([
                        ...prefix,
                        ...Array(length).fill(65),
                        ...sequence,
                    ]);
                    expect(decode(wire(payload)).value).toBe(decoder.decode(payload));
                    const valid = encoder.encode('中文🚀'.repeat(64));
                    expect(decode(wire(valid)).value).toBe(decoder.decode(valid));
                }
            }
        }
    });
});
