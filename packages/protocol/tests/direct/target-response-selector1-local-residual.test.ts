import type { SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import {
    composeTargetResponseCandidate,
    composeTargetResponseCandidateWithSelector1LocalResidual as compose,
    MAX_TARGET_RESPONSE_CANDIDATE_BYTES as cap,
} from '../../src/direct/target-response-candidate';

// All fields, protobuf contents and keys are synthetic. This is no authentication
// or claim about a real target's business body or peer behavior.
const key = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const random = (size: number) => new Uint8Array(size).fill(0x51);
const failure = 'target response candidate decoding failed';
const body = protobuf_encode<SsoRegisterResponse>({ register: { message: 'fixture' } });

const word = (value: number) => {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value >>> 0);
    return result;
};

const field = (bytes: Uint8Array) => Buffer.concat([word(bytes.length + 4), bytes]);

function plaintext(
    kind: 'good' | 'head' | 'business' | 'zlib' | 'compressed' = 'good',
    skip: 0 | 4 = 0,
): Buffer {
    const flags = kind === 'compressed' || kind === 'zlib' ? 1 : 0;
    const bytes =
        kind === 'compressed' ? deflateSync(body) : kind === 'zlib' ? Buffer.from([1, 2, 3]) : body;
    const headerFields = Buffer.concat([
        word(0x80000001),
        word(0x12345678),
        field(Uint8Array.of(0xa1)),
        field(Uint8Array.of(0xb2)),
        field(Uint8Array.of(0xc3)),
        word(flags),
        field(new Uint8Array()),
        Buffer.from([0xe5, 0xf6]),
    ]);
    const head = Buffer.concat([word(headerFields.length + 4), headerFields]);

    if (kind === 'head') {
        head.writeUInt32BE(3, 12);
    }

    const business = field(bytes);

    if (kind === 'business') {
        business.writeUInt32BE(0xffffffff, 0);
    }

    return Buffer.concat([head, Buffer.alloc(skip, 0x89), business, Buffer.from([0xfa, 0xfb])]);
}

function frame(plain = plaintext(), selector = 1): Buffer {
    const cipher = qqTeaEncrypt(plain, key, random);
    return Buffer.concat([
        word(0x12345678),
        word(0x87654321),
        Buffer.from([selector, 0xa5]),
        field(Uint8Array.of(0xbe, 0xef)),
        cipher,
    ]);
}

function keyFromIndex(index: number): Uint8Array {
    const result = new Uint8Array(16);
    new DataView(result.buffer).setUint32(0, index);
    return result;
}

function secondaryObserved<T>(keys: object, callback: () => T): { result: T; reads: number } {
    const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');

    try {
        const result = callback();
        return {
            result,
            reads: descriptor.mock.calls.filter(
                ([object, name]) => object === keys && name === 'secondaryKey',
            ).length,
        };
    } finally {
        descriptor.mockRestore();
    }
}

describe('explicit local selector-1 response composition', () => {
    it.each([0, 4] as const)(
        'uses primary once and matches legacy output and Proton body, skip=%i',
        (skip) => {
            const original = frame(plaintext('good', skip));
            const backing = Uint8Array.from([0x77, ...original, 0x88]);
            const before = backing.slice();
            const keyBacking = Uint8Array.from([0x31, ...key, 0x32]);
            const keyBefore = keyBacking.slice();
            const keys = {
                primaryKey: keyBacking.subarray(1, -1),
                secondaryKey: new Uint8Array(16),
            };
            const old = composeTargetResponseCandidate(
                backing.subarray(1, -1),
                skip,
                'reject',
                cap,
                keys.primaryKey,
            );
            const { result, reads } = secondaryObserved(keys, () =>
                compose(backing.subarray(1, -1), skip, 'reject', cap, keys),
            );
            expect(result).toEqual(old);
            expect(reads).toBe(0);
            expect(protobuf_decode<SsoRegisterResponse>(result.body).register?.message).toBe(
                'fixture',
            );
            expect(backing).toEqual(before);
            expect(keyBacking).toEqual(keyBefore);
            const outputs = [
                result.basic.opaque,
                result.head.field1,
                result.head.field2,
                result.head.field3,
                result.head.reserve,
                result.head.tail,
                result.body,
                result.trailing,
            ];
            expect(new Set(outputs.map((bytes) => bytes.buffer)).size).toBe(outputs.length);
            const saved = outputs.map((bytes) => bytes.slice());
            backing.fill(0);
            keyBacking.fill(0);
            outputs.forEach((bytes, index) => expect(bytes).toEqual(saved[index]));
        },
    );

    it('falls back on a real multi-block framing failure and rejects insufficient residual capacity', () => {
        const input = frame();
        // Fixed local keys for this exact Proton/QQ-TEA fixture: 16 leaves enough
        // residual capacity, 0 leaves too little. Both fail real framing first.
        const fallback = keyFromIndex(16);
        const insufficient = keyFromIndex(0);
        expect(() => qqTeaDecrypt(input.subarray(16), fallback)).toThrow(
            'invalid QQ-TEA ciphertext',
        );
        expect(() => qqTeaDecrypt(input.subarray(16), insufficient)).toThrow(
            'invalid QQ-TEA ciphertext',
        );
        const normal = composeTargetResponseCandidate(input, 0, 'reject', cap, key);
        const keys = { primaryKey: fallback, secondaryKey: key };
        const { result, reads } = secondaryObserved(keys, () =>
            compose(input, 0, 'reject', cap, keys),
        );
        expect(reads).toBe(1);
        expect(result).toEqual(normal);
        const inadequate = { primaryKey: insufficient, secondaryKey: key };
        const spy = vi.spyOn(Object, 'getOwnPropertyDescriptor');

        try {
            expect(() => compose(input, 0, 'reject', cap, inadequate)).toThrow(failure);
            expect(
                spy.mock.calls.filter(
                    ([object, name]) => object === inadequate && name === 'secondaryKey',
                ),
            ).toHaveLength(1);
        } finally {
            spy.mockRestore();
        }
    });

    it.each(['head', 'business', 'zlib'] as const)(
        'does not try another key after primary success and invalid %s',
        (kind) => {
            const input = frame(plaintext(kind));
            const keys = { primaryKey: key, secondaryKey: new Uint8Array(16) };
            const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');

            try {
                expect(() => compose(input, 0, 'node-zlib-strict', cap, keys)).toThrow(failure);
                expect(
                    descriptor.mock.calls.some(
                        ([object, name]) => object === keys && name === 'secondaryKey',
                    ),
                ).toBe(false);
            } finally {
                descriptor.mockRestore();
            }
        },
    );

    it('performs strict zlib transformation after successful decryption', () => {
        const input = frame(plaintext('compressed'));
        const result = compose(input, 0, 'node-zlib-strict', cap, { primaryKey: key });
        expect(result.body).toEqual(body);
        expect(result.compression).toBe('node-zlib-strict');
    });

    it('rejects a secondary accessor only after a real framing failure without invoking it', () => {
        const input = frame();
        let calls = 0;
        const keys = { primaryKey: keyFromIndex(16) };
        Object.defineProperty(keys, 'secondaryKey', {
            get() {
                calls++;
                throw new Error('fixture');
            },
        });
        const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');

        try {
            expect(() => compose(input, 0, 'reject', cap, keys)).toThrow(failure);
            expect(
                descriptor.mock.calls.filter(
                    ([object, name]) => object === keys && name === 'secondaryKey',
                ),
            ).toHaveLength(1);
            expect(calls).toBe(0);
        } finally {
            descriptor.mockRestore();
        }
    });

    it('rejects empty decrypted plaintext before reading secondary', () => {
        const input = frame(Buffer.alloc(0));
        const keys = { primaryKey: key, secondaryKey: new Uint8Array(16) };
        const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');

        try {
            expect(() => compose(input, 0, 'reject', cap, keys)).toThrow(failure);
            expect(
                descriptor.mock.calls.some(
                    ([object, name]) => object === keys && name === 'secondaryKey',
                ),
            ).toBe(false);
        } finally {
            descriptor.mockRestore();
        }
    });

    it('rejects invalid frame, options and proxy or accessor keys without getters', () => {
        const input = frame();
        const keys = { primaryKey: key };

        for (const selector of [0, 2, 3]) {
            const altered = Buffer.from(input);
            altered[8] = selector;
            expect(() => compose(altered, 0, 'reject', cap, keys)).toThrow(failure);
        }

        expect(() => compose(input.subarray(0, 12), 0, 'reject', cap, keys)).toThrow(failure);
        expect(() => compose(input, 2 as 0, 'reject', cap, keys)).toThrow(failure);
        expect(() => compose(input, 0, 'reject', cap + 1, keys)).toThrow(failure);
        let calls = 0;
        const proxy = new Proxy(keys, {
            getOwnPropertyDescriptor() {
                calls++;
                throw new Error('fixture');
            },
        });
        expect(() => compose(input, 0, 'reject', cap, proxy)).toThrow(failure);
        const accessor = Object.defineProperty({}, 'primaryKey', {
            get() {
                calls++;
                throw new Error('fixture');
            },
        });
        expect(() => compose(input, 0, 'reject', cap, accessor as never)).toThrow(failure);
        expect(calls).toBe(0);
    });

    it('does not try secondary after a primitive exception inside the first block', () => {
        const input = frame();
        const keys = { primaryKey: key, secondaryKey: new Uint8Array(16) };
        const original = DataView.prototype.getUint32;
        let reads = 0;
        const view = vi.spyOn(DataView.prototype, 'getUint32').mockImplementation(function (
            this: DataView,
            offset: number,
            littleEndian?: boolean,
        ) {
            reads++;

            if (reads === 8) {
                throw new Error('primitive fixture');
            }

            return original.call(this, offset, littleEndian);
        });
        const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');

        try {
            expect(() => compose(input, 0, 'reject', cap, keys)).toThrow(failure);
            expect(reads).toBe(8);
            expect(
                descriptor.mock.calls.some(
                    ([object, name]) => object === keys && name === 'secondaryKey',
                ),
            ).toBe(false);
        } finally {
            descriptor.mockRestore();
            view.mockRestore();
        }
    });

    it('wipes owned plaintext on later transform failure without altering inputs', async () => {
        const raw = plaintext('zlib');
        const input = frame(raw);
        const before = Buffer.from(input);
        const keys = { primaryKey: Uint8Array.from(key), secondaryKey: new Uint8Array(16) };
        const beforeKey = keys.primaryKey.slice();
        const original = Uint8Array.prototype.fill;
        const plaintextCopies: Uint8Array[] = [];
        vi.resetModules();
        const spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value: number,
            start?: number,
            end?: number,
        ) {
            if (this.length === raw.length && this.every((byte, index) => byte === raw[index])) {
                plaintextCopies.push(this);
            }

            return original.call(this, value, start, end);
        });

        try {
            const module = await import('../../src/direct/target-response-candidate');
            expect(() =>
                module.composeTargetResponseCandidateWithSelector1LocalResidual(
                    input,
                    0,
                    'node-zlib-strict',
                    cap,
                    keys,
                ),
            ).toThrow(failure);
        } finally {
            spy.mockRestore();
        }

        expect(plaintextCopies.length).toBeGreaterThan(0);
        expect(plaintextCopies.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
        expect(input).toEqual(before);
        expect(keys.primaryKey).toEqual(beforeKey);
    });

    it('does not read keys if copying the private frame throws and clears that copy', async () => {
        const input = frame();
        const keys = { primaryKey: key, secondaryKey: new Uint8Array(16) };
        const sourceSet = Uint8Array.prototype.set;
        const copies: Uint8Array[] = [];
        vi.resetModules();
        const setSpy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            data: ArrayLike<number>,
            offset?: number,
        ) {
            copies.push(this);
            sourceSet.call(this, data, offset);
            throw new Error('copy fixture');
        });
        const descriptor = vi.spyOn(Object, 'getOwnPropertyDescriptor');

        try {
            const module = await import('../../src/direct/target-response-candidate');
            expect(() =>
                module.composeTargetResponseCandidateWithSelector1LocalResidual(
                    input,
                    0,
                    'reject',
                    cap,
                    keys,
                ),
            ).toThrow(failure);
            expect(descriptor.mock.calls.some(([object]) => object === keys)).toBe(false);
        } finally {
            descriptor.mockRestore();
            setSpy.mockRestore();
        }

        expect(copies).toHaveLength(1);
        expect(copies[0].every((byte) => byte === 0)).toBe(true);
    });
});
