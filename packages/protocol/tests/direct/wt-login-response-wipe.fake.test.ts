import { describe, expect, it, vi } from 'vitest';
import * as tea from '../../src/direct/qq-tea';
import * as tlv from '../../src/direct/wt-tlv';
import type { WtTlvEntry } from '../../src/direct/wt-tlv';
import { decodeWtLoginResponse } from '../../src/direct/wt-login-response';

// Synthetic owned-buffer probes only. Codecs and encryption are the real implementations.
const key = new Uint8Array(16).fill(0x31);
const padding = (length: number) => new Uint8Array(length).fill(0x42);
const tickets = (value: number): WtTlvEntry[] => [
    { tag: 0x143, value: Uint8Array.of(value) },
    { tag: 0x305, value: new Uint8Array(16).fill(value + 1) },
    { tag: 0x10a, value: Uint8Array.of(value + 2) },
    { tag: 0x106, value: Uint8Array.of(value + 3) },
];
const body = (state: number, entries: WtTlvEntry[]) =>
    Buffer.concat([Buffer.of(0, 9, state), tlv.encodeWtTlv(entries)]);
const cipher = (plaintext: Uint8Array) => tea.qqTeaEncrypt(plaintext, key, padding);
const success = (entries: WtTlvEntry[]) =>
    body(0, [{ tag: 0x119, value: cipher(tlv.encodeWtTlv(entries)) }]);

function observe(onDecoded?: (entries: WtTlvEntry[]) => void) {
    const realDecode = tlv.decodeWtTlv;
    const realDecrypt = tea.qqTeaDecrypt;
    const layers: WtTlvEntry[][] = [];
    const plaintexts: Uint8Array[] = [];
    const beforeDecrypt: Uint8Array[][] = [];
    const copies = vi.spyOn(Uint8Array, 'from');
    const decode = vi.spyOn(tlv, 'decodeWtTlv').mockImplementation((input) => {
        const result = realDecode(input);
        layers.push(result);
        onDecoded?.(result);
        return result;
    });
    const decrypt = vi.spyOn(tea, 'qqTeaDecrypt').mockImplementation((input, key) => {
        beforeDecrypt.push(layers[0].map((entry) => entry.value.slice()));
        const result = realDecrypt(input, key);
        plaintexts.push(result);
        return result;
    });
    return {
        layers,
        plaintexts,
        beforeDecrypt,
        ownedCopies: () =>
            copies.mock.results.flatMap((result) =>
                result.type === 'return' ? [result.value as Uint8Array] : [],
            ),
        restore() {
            decrypt.mockRestore();
            decode.mockRestore();
            copies.mockRestore();
        },
    };
}

function expectWiped(values: Uint8Array[]): void {
    for (const value of values) {
        expect(value).toEqual(new Uint8Array(value.length));
    }
}

describe('login-local last-wins owned-buffer cleanup', () => {
    it('wipes superseded outer T119 copies before decrypting the sole retained value', () => {
        const kept = cipher(tlv.encodeWtTlv(tickets(0x61)));
        const input = body(0, [
            { tag: 0x119, value: Uint8Array.of(0x91, 0x92) },
            { tag: 0x119, value: Uint8Array.of(0x93, 0x94, 0x95) },
            { tag: 0x119, value: kept },
        ]);
        const inputBefore = Buffer.from(input);
        const keyBefore = key.slice();
        const owned = observe();

        try {
            const result = decodeWtLoginResponse(input, key);
            expect(result.status).toBe('tickets');
            expect(result.outerTlvs).toHaveLength(1);
            expect(result.outerTlvs[0]).toBe(owned.layers[0][2]);
            expect(result.outerTlvs[0].value).toEqual(kept);
            expect(owned.beforeDecrypt).toHaveLength(1);
            expectWiped(owned.beforeDecrypt[0].slice(0, 2));
            expectWiped(owned.layers[0].slice(0, 2).map((entry) => entry.value));
            expectWiped(owned.plaintexts);
            expect(input).toEqual(inputBefore);
            expect(key).toEqual(keyBefore);
        } finally {
            owned.restore();
        }
    });

    it('transfers only final inner values and independent ticket copies while wiping old owners', () => {
        const old = [...tickets(0x71), { tag: 0x7777, value: Uint8Array.of(0x75) }];
        const kept = [...tickets(0x81), { tag: 0x7777, value: Uint8Array.of(0x85) }];
        const input = success([...old, ...kept]);
        const inputBefore = Buffer.from(input);
        const keyBefore = key.slice();
        const owned = observe();

        try {
            const result = decodeWtLoginResponse(input, key);
            expect(result.status).toBe('tickets');

            if (result.status !== 'tickets') {
                throw new Error('unexpected status');
            }

            expect(result.innerTlvs).toHaveLength(kept.length);
            expect(result.innerTlvs).toEqual(kept);
            expectWiped(owned.layers[1].slice(0, old.length).map((entry) => entry.value));

            for (let index = 0; index < kept.length; index++) {
                expect(result.innerTlvs[index]).toBe(owned.layers[1][index + old.length]);
            }

            for (const [index, value] of Object.values(result.tickets).entries()) {
                expect(value).toEqual(kept[index].value);
                expect(value).not.toBe(result.innerTlvs[index].value);
            }

            expectWiped(owned.plaintexts);
            expect(input).toEqual(inputBefore);
            expect(key).toEqual(keyBefore);
        } finally {
            owned.restore();
        }
    });

    const validError = Buffer.from('00000001000161000162', 'hex');
    const repeated = [...tickets(0x61), ...tickets(0x71)];
    const malformedInner = Buffer.concat([tlv.encodeWtTlv(repeated), Buffer.of(0x91)]);
    const failures = [
        {
            name: 'final error146 is malformed',
            input: body(0, [
                { tag: 0x146, value: validError },
                { tag: 0x146, value: Uint8Array.of(0x91) },
            ]),
            error: /truncated WT login error TLV/,
            plaintexts: 0,
        },
        {
            name: 'final inner D2 key has an invalid length',
            input: success([...repeated, { tag: 0x305, value: new Uint8Array(15).fill(0x91) }]),
            error: /D2 key length/,
            plaintexts: 1,
        },
        {
            name: 'final A1 is empty after three ticket copies were allocated',
            input: success([...repeated, { tag: 0x106, value: new Uint8Array() }]),
            error: /missing or empty WT login TLV 0x106/,
            plaintexts: 1,
        },
        {
            name: 'generic inner decoding rejects trailing data after repeated tags',
            input: body(0, [{ tag: 0x119, value: cipher(malformedInner) }]),
            error: /trailing WT TLV bytes/,
            plaintexts: 1,
        },
    ];

    it.each(failures)('wipes every allocated owned copy when $name', (test) => {
        const inputBefore = Buffer.from(test.input);
        const keyBefore = key.slice();
        const owned = observe();

        try {
            expect(() => decodeWtLoginResponse(test.input, key)).toThrow(test.error);
            const allocated = owned.ownedCopies();
            expect(allocated.length).toBeGreaterThan(0);
            expectWiped(allocated);
            expect(owned.plaintexts).toHaveLength(test.plaintexts);
            expectWiped(owned.plaintexts);
            expect(test.input).toEqual(inputBefore);
            expect(key).toEqual(keyBefore);
        } finally {
            owned.restore();
        }
    });

    it('wipes discarded and retained values if normalization itself fails midway', () => {
        const input = body(1, [
            { tag: 0x7777, value: Uint8Array.of(0x91) },
            { tag: 0x7777, value: Uint8Array.of(0x92) },
            { tag: 0x8888, value: Uint8Array.of(0x93) },
        ]);
        const inputBefore = Buffer.from(input);
        const fault = new Error('synthetic normalization fault');
        const owned = observe((entries) => {
            Object.defineProperty(entries[2], 'tag', {
                get() {
                    throw fault;
                },
            });
        });

        try {
            expect(() => decodeWtLoginResponse(input, key)).toThrow(fault);
            expectWiped(owned.ownedCopies());
            expect(input).toEqual(inputBefore);
        } finally {
            owned.restore();
        }
    });
});
