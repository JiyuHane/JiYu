import { describe, expect, it } from 'vitest';
import { encodeTargetQr31Body, type TargetQr31Body } from '../../src/direct/target-qr31-body';
import {
    encodeTargetQr31Tlv11,
    encodeTargetQr31Tlv16,
    encodeTargetQr31Tlv1b,
    encodeTargetQr31Tlv1d,
    encodeTargetQr31Tlv33,
    encodeTargetQr31Tlv35,
    encodeTargetQr31Tlv66,
} from '../../src/direct/target-qr31-tlv';

// Synthetic caller-selected order and values, not a target request tree or login.
function body(children: readonly Uint8Array[], field80 = 0x4321): TargetQr31Body {
    return {
        field38: Uint8Array.of(0xaa, 0xbb),
        field50: 0x12345678,
        field30: 0x0123456789abcdefn,
        field54: 2, // Synthetic byte, not an asserted target boolean.
        field58: Uint8Array.of(0xcc),
        field80,
        children,
    };
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const failure = 'target QR31 body construction failed';

function sixteen(size: number): Uint8Array {
    return encodeTargetQr31Tlv16({
        field0c: 1,
        field10: 0x11223344,
        field14: 0x55667788,
        vector: Uint8Array.from({ length: 16 }, (_, index) => index),
        field30: new Uint8Array(size).fill(0xa6),
        field48: new Uint8Array(),
        field60: new Uint8Array(),
    });
}

function oneB(size: number): Uint8Array {
    return encodeTargetQr31Tlv1b({
        words: [1, 2, 3, 4, 5, 6, 7],
        x: new Uint8Array(size).fill(0xb6),
    });
}

describe('synthetic target QR31 child/body composition', () => {
    it('preserves caller-selected child order and emits independently assembled golden bytes', () => {
        const children = [
            encodeTargetQr31Tlv66(0x89abcdef),
            encodeTargetQr31Tlv11(Uint8Array.of(0xfa, 0xfb)),
            encodeTargetQr31Tlv35(0x12345678),
            encodeTargetQr31Tlv16({
                field0c: 1,
                field10: 0x11223344,
                field14: 0x55667788,
                vector: Uint8Array.from({ length: 16 }, (_, index) => index),
                field30: Uint8Array.of(0xaa),
                field48: Uint8Array.of(0xbb, 0xcc),
                field60: new Uint8Array(),
            }),
            encodeTargetQr31Tlv1b({ words: [1, 2, 3, 4, 5, 6, 7], x: Uint8Array.of(0xdd, 0xee) }),
            encodeTargetQr31Tlv33(Uint8Array.from({ length: 16 }, (_, index) => index)),
            encodeTargetQr31Tlv1d({
                field0a: 0x7e,
                field0c: 0x10203040,
                field10: 0xaabbccdd,
                values: [1, 0xffffffff],
            }),
        ];
        const copies = children.map((child) => child.slice());
        const result = encodeTargetQr31Body(body(children));
        expect(hex(result)).toBe(
            '0002aabb' +
                '12345678' +
                '0123456789abcdef' +
                '02' +
                '0001cc' +
                '4321' +
                '0066000489abcdef' +
                '00110002fafb' +
                '0035000412345678' +
                '00160025' +
                '00000001' +
                '11223344' +
                '55667788' +
                '000102030405060708090a0b0c0d0e0f' +
                '0001aa' +
                '0002bbcc' +
                '0000' +
                '001b0020' +
                '00000001' +
                '00000002' +
                '00000003' +
                '00000004' +
                '00000005' +
                '00000006' +
                '00000007' +
                '0002ddee' +
                '00330010' +
                '000102030405060708090a0b0c0d0e0f' +
                '001d0012' +
                '7e' +
                '10203040' +
                'aabbccdd' +
                '02' +
                '00000001' +
                'ffffffff',
        );
        expect(children).toHaveLength(7);
        children.forEach((child, index) => expect(child).toEqual(copies[index]));
        const changed = encodeTargetQr31Body(body(children, 0));
        expect(hex(changed.subarray(20, 22))).toBe('0000');
        expect(changed.subarray(22)).toEqual(result.subarray(22));
        const reversed = encodeTargetQr31Body(body([...children].reverse()));
        expect(reversed.subarray(22, 24)).toEqual(Uint8Array.of(0, 0x1d));
        const saved = result.slice();
        children.forEach((child) => child.fill(0));
        expect(result).toEqual(saved);
    });

    it.each([
        [
            '0x11 raw',
            0x11,
            65531,
            (length: number) => encodeTargetQr31Tlv11(new Uint8Array(length).fill(0x91)),
        ],
        ['0x16 strings', 0x16, 65497, sixteen],
        ['0x1b x', 0x1b, 65501, oneB],
    ] as const)(
        '%s enforces the parent complete-child limit including the 4-byte header',
        (_label, tag, max, create) => {
            const valid = create(max);
            const over = create(max + 1);
            expect(valid.length).toBe(65535);
            expect(over.length).toBe(65536); // Still valid for the standalone child encoder.
            const validBefore = valid.slice();
            const overBefore = over.slice();
            const childHeader = new DataView(valid.buffer, valid.byteOffset, valid.byteLength);
            expect(childHeader.getUint16(0)).toBe(tag);
            expect(childHeader.getUint16(2)).toBe(65531);
            const result = encodeTargetQr31Body(body([valid]));
            expect(result.length).toBe(22 + 65535);
            expect(result.subarray(22)).toEqual(validBefore);
            expect(() => encodeTargetQr31Body(body([valid, over]))).toThrow(failure);
            expect(valid).toEqual(validBefore);
            expect(over).toEqual(overBefore);
        },
    );
});
