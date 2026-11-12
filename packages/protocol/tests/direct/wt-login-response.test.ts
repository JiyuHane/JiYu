import { describe, expect, it, vi } from 'vitest';
import * as teaCodec from '../../src/direct/qq-tea';
import * as tlvCodec from '../../src/direct/wt-tlv';
import { qqTeaEncrypt } from '../../src/direct/qq-tea';
import { decodeWtTlv, encodeWtTlv, type WtTlvEntry } from '../../src/direct/wt-tlv';
import { decodeWtLoginResponse } from '../../src/direct/wt-login-response';

// Synthetic hand-assembled plaintext: first u16 is the count, not a command.
const inner = Buffer.from(
    '000501430002aabb03050010000102030405060708090a0b0c0d0e0f010a0003ccddee01060001ff777700029988',
    'hex',
);
const key = Uint8Array.from({ length: 16 }, (_, i) => i);
const prefix = (n: number) => new Uint8Array(n).fill(0x42);

function body(state: number, tlvs: WtTlvEntry[]): Buffer {
    return Buffer.concat([Buffer.from([0, 9, state]), encodeWtTlv(tlvs)]);
}

function encrypted(plain: Uint8Array): Uint8Array {
    return qqTeaEncrypt(plain, key, prefix);
}

function success(plain: Uint8Array = inner): Buffer {
    return body(0, [{ tag: 0x119, value: encrypted(plain) }]);
}

function tlvs(
    overrides: Partial<Record<'d2' | 'd2Key' | 'a2' | 'a1', Uint8Array>> = {},
): WtTlvEntry[] {
    return [
        { tag: 0x143, value: overrides.d2 ?? Uint8Array.of(1) },
        { tag: 0x305, value: overrides.d2Key ?? new Uint8Array(16) },
        { tag: 0x10a, value: overrides.a2 ?? Uint8Array.of(2) },
        { tag: 0x106, value: overrides.a1 ?? Uint8Array.of(3) },
    ];
}

function captureOwnership() {
    const actualDecode = tlvCodec.decodeWtTlv;
    const actualDecrypt = teaCodec.qqTeaDecrypt;
    const layers: WtTlvEntry[][] = [];
    const plaintexts: Uint8Array[] = [];
    const decode = vi.spyOn(tlvCodec, 'decodeWtTlv').mockImplementation((input) => {
        const result = actualDecode(input);
        layers.push(result);
        return result;
    });
    const decrypt = vi.spyOn(teaCodec, 'qqTeaDecrypt').mockImplementation((input, key) => {
        const result = actualDecrypt(input, key);
        plaintexts.push(result);
        return result;
    });
    const copies = vi.spyOn(Uint8Array, 'from');
    return {
        layers,
        plaintexts,
        tickets: () =>
            copies.mock.calls.flatMap(([source], index) => {
                const result = copies.mock.results[index];
                return layers[1]?.some((entry) => entry.value === source) &&
                    result.type === 'return'
                    ? [result.value as Uint8Array]
                    : [];
            }),
        restore: () => {
            copies.mockRestore();
            decrypt.mockRestore();
            decode.mockRestore();
        },
    };
}

describe('WT login response owned buffer cleanup', () => {
    const duplicate = [
        { tag: 0x7777, value: Uint8Array.of(0x91) },
        { tag: 0x7777, value: Uint8Array.of(0x92) },
    ];
    const missing = tlvs();
    missing.pop();
    const cases = [
        {
            name: 'duplicate outer tags',
            input: body(1, duplicate),
            error: /duplicate/,
            layers: 1,
            tickets: 0,
        },
        {
            name: 'duplicate inner tags',
            input: success(encodeWtTlv([...tlvs(), ...duplicate])),
            error: /duplicate/,
            layers: 2,
            tickets: 0,
        },
        {
            name: 'malformed error146',
            input: body(0, [{ tag: 0x146, value: Buffer.from('00000000ffff0000', 'hex') }]),
            error: /invalid WT login error string length/,
            layers: 1,
            tickets: 0,
        },
        {
            name: 'missing inner A1',
            input: success(encodeWtTlv(missing)),
            error: /missing or empty WT login TLV 0x106/,
            layers: 2,
            tickets: 3,
        },
        {
            name: 'bad D2 key length',
            input: success(encodeWtTlv(tlvs({ d2Key: new Uint8Array(15).fill(0x93) }))),
            error: /invalid WT login D2 key length/,
            layers: 2,
            tickets: 2,
        },
    ];

    it.each(cases)('clears owned copies after $name without changing caller bytes', (test) => {
        const inputBefore = Buffer.from(test.input);
        const keyBefore = Buffer.from(key);
        const owned = captureOwnership();

        try {
            expect(() => decodeWtLoginResponse(test.input, key)).toThrow(test.error);
            const tickets = owned.tickets();
            expect(owned.layers).toHaveLength(test.layers);
            expect(tickets).toHaveLength(test.tickets);
            expect(owned.plaintexts).toHaveLength(test.layers - 1);

            for (const value of [
                ...owned.layers.flatMap((layer) => layer.map((entry) => entry.value)),
                ...tickets,
                ...owned.plaintexts,
            ]) {
                expect(value).toEqual(new Uint8Array(value.length));
            }

            expect(test.input).toEqual(inputBefore);
            expect(Buffer.from(key)).toEqual(keyBefore);
        } finally {
            owned.restore();
        }
    });

    it('always clears plaintext but transfers successful TLV and ticket copies intact', () => {
        const input = success();
        const inputBefore = Buffer.from(input);
        const keyBefore = Buffer.from(key);
        const expectedInner = decodeWtTlv(inner);
        const owned = captureOwnership();

        try {
            const result = decodeWtLoginResponse(input, key);

            if (result.status !== 'tickets') {
                throw new Error('unexpected status');
            }

            expect(owned.layers).toHaveLength(2);
            expect(result.outerTlvs).toBe(owned.layers[0]);
            expect(result.innerTlvs).toBe(owned.layers[1]);
            expect(result.innerTlvs).toEqual(expectedInner);
            expect(Buffer.from(result.outerTlvs[0].value)).toEqual(input.subarray(9));
            expect(owned.tickets()).toEqual(Object.values(result.tickets));
            expect(owned.tickets()).toHaveLength(4);

            for (const [index, value] of Object.values(result.tickets).entries()) {
                expect(value).toEqual(expectedInner[index].value);
                expect(value).not.toBe(result.innerTlvs[index].value);
            }

            expect(owned.plaintexts).toHaveLength(1);
            expect(owned.plaintexts[0]).toEqual(new Uint8Array(inner.length));
            expect(input).toEqual(inputBefore);
            expect(Buffer.from(key)).toEqual(keyBefore);
        } finally {
            owned.restore();
        }
    });
});

describe('WT 0x810/9 response business body', () => {
    it('parses a separately supplied synthetic fixed ciphertext', () => {
        const ciphertext = Buffer.from(
            'c6ae0d5ee512f51e4aa88c5218f75e24befa937126a9cf99724bd4c77ca7a7abde874452df3591ae5981906ca5ef1da3',
            'hex',
        );
        const result = decodeWtLoginResponse(body(0, [{ tag: 0x119, value: ciphertext }]), key);
        expect(result.status).toBe('tickets');

        if (result.status !== 'tickets') {
            throw new Error('unexpected status');
        }

        expect(result.tickets).toEqual({
            d2: Uint8Array.of(0xaa),
            d2Key: key,
            a2: Uint8Array.of(0xbb),
            a1: Uint8Array.of(0xcc),
        });
    });

    it('parses source-derived count-first TLV119 and exposes four copied tickets', () => {
        const input = success();
        const result = decodeWtLoginResponse(input, key);
        expect(result.status).toBe('tickets');

        if (result.status !== 'tickets') {
            throw new Error('unexpected status');
        }

        expect(result.command).toBe(9);
        expect(result.state).toBe(0);
        expect(result.tickets).toEqual({
            d2: Uint8Array.of(0xaa, 0xbb),
            d2Key: Uint8Array.from({ length: 16 }, (_, i) => i),
            a2: Uint8Array.of(0xcc, 0xdd, 0xee),
            a1: Uint8Array.of(0xff),
        });
        expect(result.innerTlvs.map((item) => item.tag)).toEqual([
            0x143, 0x305, 0x10a, 0x106, 0x7777,
        ]);
        expect(result.innerTlvs[4].value).toEqual(Uint8Array.of(0x99, 0x88));
        // Prepending an invented inner command must not produce tickets.
        expect(() =>
            decodeWtLoginResponse(success(Buffer.concat([Buffer.from([0, 9]), inner])), key),
        ).toThrow();
    });

    it('retains verification, nonzero and incomplete outcomes even with success-looking data', () => {
        for (const state of [2, 160, 204, 239]) {
            const result = decodeWtLoginResponse(
                body(state, [{ tag: 0x119, value: encrypted(inner) }]),
                key,
            );
            expect(result.status).toBe('verification-required');
            expect(result.state).toBe(state);
        }

        for (const state of [1, 3, 15, 40, 155, 162, 163, 167, 235, 237, 240, 255]) {
            expect(decodeWtLoginResponse(body(state, []), key)).toMatchObject({
                status: 'nonzero',
                state,
            });
        }

        expect(decodeWtLoginResponse(body(0, []), key)).toMatchObject({
            status: 'incomplete',
            state: 0,
        });
    });

    it('honors 0x146 error priority over status and 0x119', () => {
        const error = Buffer.from('010203040002c3a90003626164', 'hex');
        const result = decodeWtLoginResponse(
            body(0, [
                { tag: 0x119, value: encrypted(inner) },
                { tag: 0x146, value: error },
            ]),
            key,
        );
        expect(result).toMatchObject({
            status: 'error',
            state: 0,
            error: { code: 0x01020304, title: 'é', message: 'bad' },
        });

        for (let i = 0; i < error.length; i++) {
            expect(() =>
                decodeWtLoginResponse(body(1, [{ tag: 0x146, value: error.subarray(0, i) }]), key),
            ).toThrow();
        }

        for (const invalid of [
            Buffer.concat([error, Buffer.of(0)]),
            Buffer.from('00000000ffff0000', 'hex'),
            Buffer.from('0000000000007fff', 'hex'),
        ]) {
            expect(() =>
                decodeWtLoginResponse(body(0, [{ tag: 0x146, value: invalid }]), key),
            ).toThrow();
        }
    });

    it('rejects wrong keys, ciphertext and incomplete or trailing body bytes', () => {
        const input = success();

        for (let i = 0; i < input.length; i++) {
            expect(() => decodeWtLoginResponse(input.subarray(0, i), key)).toThrow();
        }

        for (const length of [0, 15, 17]) {
            expect(() => decodeWtLoginResponse(input, new Uint8Array(length))).toThrow(/key/);
        }

        expect(() => decodeWtLoginResponse(input, new Uint8Array(16))).toThrow();
        expect(() => decodeWtLoginResponse(input, [] as unknown as Uint8Array)).toThrow(/key/);
        expect(() => decodeWtLoginResponse(new Uint8Array(0x10000), key)).toThrow(/size/);
        expect(() => decodeWtLoginResponse([] as unknown as Uint8Array, key)).toThrow(/size/);
        expect(() => decodeWtLoginResponse(Buffer.concat([input, Buffer.of(3)]), key)).toThrow(
            /trailing/,
        );
        expect(() => decodeWtLoginResponse(Buffer.from('0008000000', 'hex'), key)).toThrow(
            /command/,
        );

        for (const length of [0, 8, 15, 17]) {
            expect(() =>
                decodeWtLoginResponse(
                    body(0, [{ tag: 0x119, value: new Uint8Array(length) }]),
                    key,
                ),
            ).toThrow();
        }

        const damaged = input.slice();
        damaged[damaged.length - 1] ^= 1;
        expect(() => decodeWtLoginResponse(damaged, key)).toThrow();
    });

    it('accepts the maximum bounded body while preserving unknown TLVs', () => {
        const maximum = body(255, [{ tag: 0x7777, value: new Uint8Array(65526).fill(0xab) }]);
        expect(maximum.length).toBe(65535);
        const result = decodeWtLoginResponse(maximum, key);
        expect(result.status).toBe('nonzero');
        expect(result.outerTlvs[0].value.length).toBe(65526);
        expect(result.outerTlvs[0].value[65525]).toBe(0xab);
        expect(() => decodeWtLoginResponse(Buffer.concat([maximum, Buffer.of(0)]), key)).toThrow(
            /size/,
        );
    });

    it('rejects malformed inner blocks and duplicate tags in either layer', () => {
        for (let i = 0; i < inner.length; i++) {
            expect(() => decodeWtLoginResponse(success(inner.subarray(0, i)), key)).toThrow();
        }

        expect(() =>
            decodeWtLoginResponse(success(Buffer.concat([inner, Buffer.of(3)])), key),
        ).toThrow(/trailing/);
        const duplicate = [
            { tag: 0x7777, value: Uint8Array.of(1) },
            { tag: 0x7777, value: Uint8Array.of(2) },
        ];
        expect(() => decodeWtLoginResponse(body(1, duplicate), key)).toThrow(/duplicate/);
        expect(() =>
            decodeWtLoginResponse(success(encodeWtTlv([...tlvs(), ...duplicate])), key),
        ).toThrow(/duplicate/);
        expect(() =>
            decodeWtLoginResponse(success(encodeWtTlv([...tlvs(), tlvs()[0]])), key),
        ).toThrow(/duplicate/);
    });

    it('enforces nonempty core tickets and an exactly 16-byte D2 key', () => {
        for (let i = 0; i < 4; i++) {
            const missing = tlvs();
            missing.splice(i, 1);
            expect(() => decodeWtLoginResponse(success(encodeWtTlv(missing)), key)).toThrow(
                /missing/,
            );
            const empty = tlvs();
            empty[i].value = new Uint8Array();
            expect(() => decodeWtLoginResponse(success(encodeWtTlv(empty)), key)).toThrow(/empty/);
        }

        for (const length of [1, 15, 17, 255]) {
            expect(() =>
                decodeWtLoginResponse(
                    success(encodeWtTlv(tlvs({ d2Key: new Uint8Array(length) }))),
                    key,
                ),
            ).toThrow(/D2 key/);
        }
    });

    it('supports offset views and keeps input, key, inner fields and tickets independent', () => {
        const input = success();
        const source = Buffer.concat([Buffer.of(9), input, Buffer.of(8)]);
        const snapshot = Buffer.from(source);
        const keySource = Buffer.concat([Buffer.of(7), key, Buffer.of(6)]);
        const keyCopy = Buffer.from(keySource);
        const result = decodeWtLoginResponse(source.subarray(1, -1), keySource.subarray(1, 17));

        if (result.status !== 'tickets') {
            throw new Error('unexpected status');
        }

        result.tickets.d2.fill(0);
        result.tickets.d2Key.fill(0);
        result.tickets.a2.fill(0);
        result.tickets.a1.fill(0);
        expect(result.innerTlvs[0].value).toEqual(Uint8Array.of(0xaa, 0xbb));
        result.outerTlvs[0].value.fill(0);
        result.innerTlvs[0].value.fill(0);
        expect(source).toEqual(snapshot);
        expect(keySource).toEqual(keyCopy);
    });

    it('keeps thrown diagnostics free of sensitive field bytes', () => {
        const secret = Buffer.from('secret-not-for-log', 'utf8');
        const value = body(0, [{ tag: 0x119, value: secret }]);

        try {
            decodeWtLoginResponse(value, key);
            throw new Error('unexpected acceptance');
        } catch (error) {
            expect(String(error)).not.toContain('secret-not-for-log');
        }
    });
});
