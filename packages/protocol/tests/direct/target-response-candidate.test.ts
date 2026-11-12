import { runInNewContext } from 'node:vm';
import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { qqTeaEncrypt } from '../../src/direct/qq-tea';
import {
    composeTargetResponseCandidate,
    composeTargetResponseCandidateWithFinal,
    MAX_TARGET_RESPONSE_CANDIDATE_BYTES as cap,
} from '../../src/direct/target-response-candidate';

const failure = 'target response candidate decoding failed';
const key = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const wrongKey = new Uint8Array(16).fill(0x92);
const random = (length: number) => new Uint8Array(length).fill(0xa8);

// Synthetic bytes only: there is no identity, request binding or authentication.
function plain(body = Uint8Array.of(10, 11), flags = 0, skip: 0 | 4 = 0): Uint8Array {
    const headLength = 38;
    const bytes = new Uint8Array(headLength + skip + 4 + body.length + 2);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, headLength);
    view.setUint32(4, 0x80000001);
    view.setUint32(8, 0xffffffff);
    view.setUint32(12, 5);
    bytes[16] = 0xa1;
    view.setUint32(17, 5);
    bytes[21] = 0xb2;
    view.setUint32(22, 5);
    bytes[26] = 0xc3;
    view.setUint32(27, flags);
    view.setUint32(31, 5);
    bytes[35] = 0xd4;
    bytes.set([0xe5, 0xf6], 36);
    bytes.fill(0x89, headLength, headLength + skip);
    view.setUint32(headLength + skip, body.length + 4);
    bytes.set(body, headLength + skip + 4);
    bytes.set([0xfa, 0xfb], headLength + skip + 4 + body.length);
    return bytes;
}

function frame(data: Uint8Array, selector = 0): Uint8Array {
    const remainder = selector === 0 ? data : qqTeaEncrypt(data, key, random);
    const result = new Uint8Array(16 + remainder.length);
    const view = new DataView(result.buffer);
    view.setUint32(0, 0x12345678);
    view.setUint32(4, 0x87654321);
    result[8] = selector;
    result[9] = 0xa5;
    view.setUint32(10, 6);
    result.set([0xbe, 0xef], 14);
    result.set(remainder, 16);
    return result;
}

const run = (input: Uint8Array, secret?: Uint8Array) =>
    composeTargetResponseCandidate(input, 0, 'reject', cap, secret);

function withTail(body: Uint8Array, flags: number, skip: 0 | 4, tail: number[]): Uint8Array {
    const initial = plain(body, flags, skip);
    const result = new Uint8Array(initial.length - 2 + tail.length);
    result.set(initial.subarray(0, 36));
    result.set(tail, 36);
    result.set(initial.subarray(38), 36 + tail.length);
    new DataView(result.buffer).setUint32(0, 36 + tail.length);
    return result;
}

describe('final observation from the composed private plaintext', () => {
    it.each([0, 1, 2])('reads every tail/skip combination for selector %i', (selector) => {
        const tailBytes = [0x80, 0xa1, 0xb2, 0xc3, 0xd4];
        const body = Uint8Array.of(0x80, 0x45, 0xff);
        const encoded = Uint8Array.from(deflateSync(body));

        for (const skip of [0, 4] as const) {
            for (const compressed of [false, true]) {
                for (let n = 0; n <= tailBytes.length; n++) {
                    const tail = tailBytes.slice(0, n);
                    const raw = withTail(
                        compressed ? encoded : body,
                        Number(compressed),
                        skip,
                        tail,
                    );
                    const input = frame(raw, selector);
                    const before = input.slice();
                    const keyBefore = key.slice();
                    const secret = selector ? key : undefined;
                    const policy = compressed ? 'node-zlib-strict' : 'reject';
                    const old = composeTargetResponseCandidate(input, skip, policy, cap, secret);
                    const result = composeTargetResponseCandidateWithFinal(
                        input,
                        skip,
                        policy,
                        cap,
                        secret,
                        0xfedcba98,
                    );
                    const { finalWord, finalWordRead, ...oldShape } = result;
                    const finalBytes = raw.slice(36, 40);
                    expect(finalWord).toBe(new DataView(finalBytes.buffer).getUint32(0, false));
                    expect(finalWordRead).toBe(true);
                    expect(oldShape).toEqual(old);
                    expect(Object.keys(old)).toEqual([
                        'kind',
                        'basic',
                        'head',
                        'body',
                        'trailing',
                        'businessOffset',
                        'nextOffset',
                        'compression',
                    ]);
                    expect(result.head.tail).toEqual(Uint8Array.from(tail));
                    expect(result.body).toEqual(body);
                    expect(result.businessOffset).toBe(36 + n + skip);
                    expect(result.trailing).toEqual(Uint8Array.of(0xfa, 0xfb));
                    expect(input).toEqual(before);
                    expect(key).toEqual(keyBefore);
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
                    expect(new Set(outputs.map((value) => value.buffer)).size).toBe(outputs.length);
                    const saved = outputs.map((value) => value.slice());
                    input.fill(0);
                    outputs.forEach((value, index) => expect(value).toEqual(saved[index]));
                    result.head.field1[0] = 0;
                    expect(result.head.field2).toEqual(Uint8Array.of(0xb2));
                }
            }
        }
    });

    it('requires a primitive uint32 prior even with a complete business wrapper', () => {
        const input = frame(plain());
        let coerced = 0;
        const hostile = {
            valueOf() {
                coerced++;
                throw new Error('SECRET');
            },
        };

        for (const prior of [
            undefined,
            null,
            -1,
            0.5,
            NaN,
            Infinity,
            0x100000000,
            '0',
            0n,
            hostile,
        ]) {
            expect(() =>
                composeTargetResponseCandidateWithFinal(
                    input,
                    0,
                    'reject',
                    cap,
                    undefined,
                    prior as number,
                ),
            ).toThrow(failure);
        }

        expect(coerced).toBe(0);

        for (const prior of [0, 0xffffffff]) {
            expect(
                composeTargetResponseCandidateWithFinal(input, 0, 'reject', cap, undefined, prior)
                    .finalWordRead,
            ).toBe(true);
        }
    });

    it('rejects malformed candidates without partial output', () => {
        const good = frame(plain());

        for (let n = 0; n < good.length - 2; n++) {
            expect(() =>
                composeTargetResponseCandidateWithFinal(
                    good.subarray(0, n),
                    0,
                    'reject',
                    cap,
                    undefined,
                    0,
                ),
            ).toThrow(failure);
        }

        const malformed = good.slice();
        new DataView(malformed.buffer).setUint32(16 + 38, 0xffffffff);
        expect(() =>
            composeTargetResponseCandidateWithFinal(malformed, 0, 'reject', cap, undefined, 0),
        ).toThrow(failure);
    });

    it('clears all owned copies after final succeeds and compression is rejected', () => {
        const input = frame(plain(Uint8Array.of(0x80), 1));
        const before = input.slice();
        const NativeUint8Array = Uint8Array;
        const allocations: Uint8Array[] = [];
        vi.stubGlobal(
            'Uint8Array',
            new Proxy(NativeUint8Array, {
                construct(target, args) {
                    const result = Reflect.construct(target, args, target) as Uint8Array;

                    if (typeof args[0] === 'number') {
                        allocations.push(result);
                    }

                    return result;
                },
            }),
        );

        try {
            expect(() =>
                composeTargetResponseCandidateWithFinal(input, 0, 'reject', cap, undefined, 0),
            ).toThrow(failure);
        } finally {
            vi.unstubAllGlobals();
        }

        expect(allocations.length).toBeGreaterThanOrEqual(16);
        expect(allocations.every((value) => value.every((byte) => byte === 0))).toBe(true);
        expect(input).toEqual(before);
    });

    it('rejects invalid prior before invoking decryption', async () => {
        vi.resetModules();
        const decrypt = await import('../../src/direct/target-service-decrypt-candidate');
        const spy = vi.spyOn(decrypt, 'decodeTargetServiceDecryptCandidate');

        try {
            const module = await import('../../src/direct/target-response-candidate');
            let calls = 0;
            const prior = {
                valueOf() {
                    calls++;
                    throw new Error('SECRET');
                },
            };
            const input = frame(plain(), 1);
            expect(() =>
                module.composeTargetResponseCandidateWithFinal(
                    input,
                    0,
                    'reject',
                    cap,
                    key,
                    prior as unknown as number,
                ),
            ).toThrow(failure);
            expect(calls).toBe(0);
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    it('wipes the encrypted candidate and explicit key copies after a later failure', async () => {
        const raw = plain(Uint8Array.of(0x80), 1);
        const input = frame(raw, 1);
        const before = input.slice();
        const keyBefore = key.slice();
        const originalFill = Uint8Array.prototype.fill;
        const keyCopies: Uint8Array[] = [];
        const plaintextCopies: Uint8Array[] = [];
        vi.resetModules();
        const spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value: number,
            start?: number,
            end?: number,
        ) {
            if (this.length === key.length && this.every((byte, index) => byte === key[index])) {
                keyCopies.push(this);
            }

            if (this.length === raw.length && this.every((byte, index) => byte === raw[index])) {
                plaintextCopies.push(this);
            }

            return originalFill.call(this, value, start, end);
        });

        try {
            const module = await import('../../src/direct/target-response-candidate');
            expect(() =>
                module.composeTargetResponseCandidateWithFinal(input, 0, 'reject', cap, key, 0),
            ).toThrow(failure);
        } finally {
            spy.mockRestore();
        }

        expect(keyCopies.length).toBeGreaterThanOrEqual(2);
        expect(plaintextCopies.length).toBeGreaterThanOrEqual(3);
        expect(
            [...keyCopies, ...plaintextCopies].every((bytes) => bytes.every((byte) => byte === 0)),
        ).toBe(true);
        expect(input).toEqual(before);
        expect(key).toEqual(keyBefore);
    });

    it('clears final and transform outputs when the trailing copy fails', async () => {
        const input = frame(plain());
        const before = input.slice();
        const originalSet = Uint8Array.prototype.set;
        const copies: Uint8Array[] = [];
        vi.resetModules();
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source: ArrayLike<number>,
            offset?: number,
        ) {
            copies.push(this);
            originalSet.call(this, source, offset);

            if (source.length === 2 && source[0] === 0xfa && source[1] === 0xfb) {
                throw new Error('SECRET');
            }
        });

        try {
            const module = await import('../../src/direct/target-response-candidate');
            expect(() =>
                module.composeTargetResponseCandidateWithFinal(
                    input,
                    0,
                    'reject',
                    cap,
                    undefined,
                    0,
                ),
            ).toThrow(failure);
        } finally {
            spy.mockRestore();
        }

        expect(copies.length).toBeGreaterThanOrEqual(15);
        expect(copies.every((value) => value.every((byte) => byte === 0))).toBe(true);
        expect(input).toEqual(before);
    });

    it('continues independent wipes when one final head wipe throws', async () => {
        const input = frame(plain());
        const before = input.slice();
        const originalFill = Uint8Array.prototype.fill;
        const attempts: Uint8Array[] = [];
        let failed: Uint8Array | undefined;
        vi.resetModules();
        const spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value: number,
            start?: number,
            end?: number,
        ) {
            attempts.push(this);

            if (!failed && this.length === 1 && this[0] === 0xa1) {
                failed = this;
                throw new Error('SECRET');
            }

            return originalFill.call(this, value, start, end);
        });

        try {
            const module = await import('../../src/direct/target-response-candidate');
            const result = module.composeTargetResponseCandidateWithFinal(
                input,
                0,
                'reject',
                cap,
                undefined,
                0,
            );
            expect(result.body).toEqual(Uint8Array.of(10, 11));
            expect(result.head.field1).toEqual(Uint8Array.of(0xa1));
            expect(result.head.field2).toEqual(Uint8Array.of(0xb2));
        } finally {
            spy.mockRestore();
        }

        expect(failed).toBeDefined();
        const position = attempts.indexOf(failed!);
        expect(attempts.slice(position + 1).length).toBeGreaterThanOrEqual(4);
        expect(
            attempts.slice(position + 1).every((value) => value.every((byte) => byte === 0)),
        ).toBe(true);
        expect(input).toEqual(before);
    });
});

describe('composed unverified target response candidate', () => {
    it.each([0, 1, 2])('composes selector %i at plaintext-relative offsets', (selector) => {
        const raw = plain();
        const input = frame(raw, selector);
        const original = input.slice();
        const savedKey = key.slice();
        const result = run(input, selector ? key : undefined);
        expect(result.kind).toBe('unverified-response-candidate');
        expect(result.basic).toEqual({
            word0: 0x12345678,
            word4: 0x87654321,
            selector,
            flag9: 0xa5,
            opaque: Uint8Array.of(0xbe, 0xef),
            nextOffset: 16,
        });
        expect(result.basic.word0).not.toBe(input.length);
        expect(result.head.nextOffset).toBe(38);
        expect(result.businessOffset).toBe(38);
        expect(result.nextOffset).toBe(44);
        expect(result.body).toEqual(Uint8Array.of(10, 11));
        expect(result.head.tail).toEqual(Uint8Array.of(0xe5, 0xf6));
        expect(result.trailing).toEqual(Uint8Array.of(0xfa, 0xfb));
        expect(result.compression).toBe('none');
        expect(input).toEqual(original);
        expect(key).toEqual(savedKey);
    });

    it('uses only the supplied single key and rejects missing, wrong or unexpected keys', () => {
        for (const selector of [1, 2]) {
            const input = frame(plain(), selector);
            expect(() => run(input)).toThrow(failure);
            expect(() => run(input, wrongKey)).toThrow(failure);

            for (const size of [0, 15, 17, 32]) {
                expect(() => run(input, new Uint8Array(size))).toThrow(failure);
            }
        }

        expect(() => run(frame(plain()), key)).toThrow(failure);
        const invalid = frame(plain());
        invalid[8] = 3;
        expect(() => run(invalid, key)).toThrow(failure);
    });

    it.each([0, 4] as const)('handles explicit skip %i and strict compression policy', (skip) => {
        const body = Uint8Array.of(4, 5, 6);
        const compressed = Uint8Array.from(deflateSync(body));

        for (const selector of [0, 1, 2]) {
            const input = frame(plain(compressed, 1, skip), selector);
            const secret = selector ? key : undefined;
            expect(() => composeTargetResponseCandidate(input, skip, 'reject', 3, secret)).toThrow(
                failure,
            );
            const result = composeTargetResponseCandidate(
                input,
                skip,
                'node-zlib-strict',
                3,
                secret,
            );
            expect(result.body).toEqual(body);
            expect(result.compression).toBe('node-zlib-strict');
            expect(result.businessOffset).toBe(38 + skip);
            expect(result.nextOffset).toBe(42 + skip + compressed.length);
            expect(result.trailing).toEqual(Uint8Array.of(0xfa, 0xfb));
            expect(() =>
                composeTargetResponseCandidate(input, skip, 'node-zlib-strict', 2, secret),
            ).toThrow(failure);
        }

        const uncompressed = frame(plain(body, 0, skip));
        expect(composeTargetResponseCandidate(uncompressed, skip, 'reject', 3).body).toEqual(body);
        expect(() => composeTargetResponseCandidate(uncompressed, skip, 'reject', 2)).toThrow(
            failure,
        );
    });

    it('returns independent fields from bounded frame and key subviews', () => {
        const raw = frame(plain(), 1);
        const backing = Uint8Array.from([77, ...raw, 88]);
        const keyBacking = Uint8Array.from([99, ...key, 100]);
        const before = backing.slice();
        const keyBefore = keyBacking.slice();
        const result = run(backing.subarray(1, -1), keyBacking.subarray(1, -1));
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
        expect(new Set(outputs.map((value) => value.buffer)).size).toBe(outputs.length);
        const copies = outputs.map((value) => value.slice());
        backing.fill(0);
        keyBacking.fill(0);
        outputs.forEach((value, index) => expect(value).toEqual(copies[index]));
        outputs.forEach((value) => {
            value[0] ^= 0xff;
        });
        expect(before.subarray(1, -1)).toEqual(raw);
        expect(keyBefore.subarray(1, -1)).toEqual(key);
        expect(backing.every((value) => value === 0)).toBe(true);
        expect(keyBacking.every((value) => value === 0)).toBe(true);
    });

    it('requires a remainder, validates all parameters and rejects every meaningful truncation', () => {
        const good = frame(plain());

        for (let length = 0; length < good.length - 2; length++) {
            expect(() => run(good.subarray(0, length))).toThrow(failure);
        }

        expect(() => run(good.subarray(0, 16))).toThrow(failure);

        for (const value of [-1, 1, 5, undefined, '0']) {
            expect(() => composeTargetResponseCandidate(good, value as 0, 'reject', cap)).toThrow(
                failure,
            );
        }

        for (const value of [undefined, '', 'none', {}, 'SECRET']) {
            expect(() => composeTargetResponseCandidate(good, 0, value as 'reject', cap)).toThrow(
                failure,
            );
        }

        for (const value of [-1, 0.5, NaN, Infinity, cap + 1, undefined, '3', {}]) {
            expect(() =>
                composeTargetResponseCandidate(good, 0, 'reject', value as number),
            ).toThrow(failure);
        }
    });

    it('bounds the complete frame including trailing bytes independently of basic size', () => {
        const good = frame(plain());
        const atCap = new Uint8Array(cap);
        atCap.set(good);
        const result = run(atCap);
        expect(result.body).toEqual(Uint8Array.of(10, 11));
        expect(result.trailing.length).toBe(cap - 16 - result.nextOffset);
        const tooLarge = new Uint8Array(cap + 1);
        tooLarge.set(good);
        Object.defineProperty(tooLarge, 'byteLength', { value: good.length });
        expect(() => run(tooLarge)).toThrow(failure);
    });

    it('rejects proxies, proxy prototypes, shared, detached and OOB input and key without callbacks', () => {
        let calls = 0;
        const handler = {
            get() {
                calls++;
                throw new Error('SECRET');
            },
            getPrototypeOf() {
                calls++;
                throw new Error('SECRET');
            },
        };
        const proxy = new Proxy(new Uint8Array(16), handler);
        const revoked = Proxy.revocable(new Uint8Array(16), {});
        revoked.revoke();
        const badPrototype = new Uint8Array(16);
        Object.setPrototypeOf(badPrototype, new Proxy(Uint8Array.prototype, handler));
        const detached = new Uint8Array(16);
        structuredClone(detached, { transfer: [detached.buffer] });
        const resize = new ArrayBuffer(20, { maxByteLength: 32 });
        const outOfBounds = new Uint8Array(resize, 4, 16);
        resize.resize(4);
        const values = [
            proxy,
            revoked.proxy,
            badPrototype,
            detached,
            outOfBounds,
            new Uint8Array(new SharedArrayBuffer(16)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(16))'),
            new Uint16Array(16),
            new DataView(new ArrayBuffer(16)),
            null,
            {},
        ];
        const encrypted = frame(plain(), 1);

        for (const value of values) {
            expect(() => run(value as Uint8Array)).toThrow(failure);
            expect(() => run(encrypted, value as Uint8Array)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it('ignores shadow getters and accepts ordinary foreign byte views', () => {
        const source = frame(plain(), 1);
        const foreign = runInNewContext(`new Uint8Array([${Array.from(source)}])`) as Uint8Array;
        const foreignKey = runInNewContext(`new Uint8Array([${Array.from(key)}])`) as Uint8Array;
        let calls = 0;

        for (const value of [foreign, foreignKey]) {
            for (const name of [
                'length',
                'byteLength',
                'byteOffset',
                'buffer',
                Symbol.iterator,
                Symbol.toStringTag,
            ]) {
                Object.defineProperty(value, name, {
                    get() {
                        calls++;
                        throw new Error('SECRET');
                    },
                });
            }
        }

        expect(run(foreign, foreignKey).body).toEqual(Uint8Array.of(10, 11));
        expect(calls).toBe(0);
    });

    it('clears transferred transform outputs and a partially copied tail on failure', async () => {
        const input = frame(plain());
        const before = input.slice();
        const originalSet = Uint8Array.prototype.set;
        const copies: Uint8Array[] = [];
        vi.resetModules();
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source: ArrayLike<number>,
            offset?: number,
        ) {
            copies.push(this);
            originalSet.call(this, source, offset);

            if (source.length === 2 && source[0] === 0xfa && source[1] === 0xfb) {
                throw new Error('SECRET synthetic failure');
            }
        });

        try {
            const module = await import('../../src/direct/target-response-candidate');
            expect(() => module.composeTargetResponseCandidate(input, 0, 'reject', cap)).toThrow(
                failure,
            );
        } finally {
            spy.mockRestore();
        }

        expect(copies.length).toBeGreaterThanOrEqual(10);
        expect(copies.every((value) => value.every((byte) => byte === 0))).toBe(true);
        expect(input).toEqual(before);
    });

    it('clears all captured owned arrays after a late transform failure', () => {
        const input = frame(plain(Uint8Array.of(1), 1));
        const original = input.slice();
        const NativeUint8Array = Uint8Array;
        const allocations: Uint8Array[] = [];
        vi.stubGlobal(
            'Uint8Array',
            new Proxy(NativeUint8Array, {
                construct(target, args) {
                    const result = Reflect.construct(target, args, target) as Uint8Array;

                    if (typeof args[0] === 'number') {
                        allocations.push(result);
                    }

                    return result;
                },
            }),
        );

        try {
            expect(() => run(input)).toThrow(failure);
        } finally {
            vi.unstubAllGlobals();
        }

        expect(allocations.length).toBeGreaterThanOrEqual(9);
        expect(allocations.every((value) => value.every((byte) => byte === 0))).toBe(true);
        expect(input).toEqual(original);
    });
});
