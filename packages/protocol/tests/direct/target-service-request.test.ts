import { describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt } from '../../src/direct/qq-tea';
import {
    encodeTargetServiceRequest,
    MAX_TARGET_SERVICE_REQUEST_BYTES,
    type TargetServiceRequest,
} from '../../src/direct/target-service-request';

// Synthetic data only. The ciphertext is the independently generated MiraiGo
// three-byte vector in qq-tea.test.ts; the frame header is hand-assembled here.
const fixtureKey = Uint8Array.from({ length: 16 }, (_, index) => index);

const fixedRandom = (length: number): Uint8Array => {
    const result = new Uint8Array(length);
    result[0] = 0xf8;
    return result;
};

function fixture(): TargetServiceRequest {
    return {
        sourceCommand: 'wtlogin64.trans_emp',
        virtualProtocol: 0x01020304,
        basicBranch: { virtualResultByte: 1, kind: 'value', value: 0x11223344 },
        requestObjectByte: 0x7f,
        uin: '123456',
        head: Uint8Array.of(0),
        busi: Uint8Array.of(1, 2),
        targetTeaKey: fixtureKey.slice(),
        randomSource: fixedRandom,
    };
}

describe('target static request branch', () => {
    it('matches a hand-assembled complete synthetic vector with independently generated ciphertext', () => {
        const encoded = encodeTargetServiceRequest(fixture());
        expect(Buffer.from(encoded).toString('hex')).toBe(
            '000000280102030402112233447f0000000a313233343536' + 'b619e9103a2640d8262b6860a4102374',
        );
        expect(qqTeaDecrypt(encoded.subarray(24), fixtureKey)).toEqual(Uint8Array.of(0, 1, 2));
    });

    it('uses the zero-result span branch, self-inclusive lengths, and UTF-8 byte length', () => {
        const input = fixture();
        input.sourceCommand = 'wtlogin64.login';
        input.basicBranch = { virtualResultByte: 0, kind: 'span', span: Uint8Array.of(0xaa, 0xbb) };
        input.uin = 'é';
        input.requestObjectByte = 0xff;
        const encoded = Buffer.from(encodeTargetServiceRequest(input));
        expect(encoded.toString('hex')).toBe(
            '00000026010203040200000006aabbff00000006c3a9' + 'b619e9103a2640d8262b6860a4102374',
        );
        input.basicBranch = { virtualResultByte: 0, kind: 'span', span: new Uint8Array() };
        const empty = Buffer.from(encodeTargetServiceRequest(input));
        expect(empty.readUInt32BE(9)).toBe(4);
        expect(empty.readUInt32BE(14)).toBe(6);
        expect(empty.readUInt32BE(0)).toBe(empty.length);
    });

    it('preserves the supplied head/business concatenation and permits every alignment', () => {
        for (let length = 0; length < 24; length++) {
            const input = fixture();
            input.head = Uint8Array.from({ length }, (_, index) => index);
            input.busi = Uint8Array.of(0xfe, 0xff);
            const frame = encodeTargetServiceRequest(input);
            expect(frame.length).toBe(24 + Math.ceil((length + 12) / 8) * 8);
            expect(qqTeaDecrypt(frame.subarray(24), fixtureKey)).toEqual(
                Uint8Array.from([...input.head, 0xfe, 0xff]),
            );
        }
    });

    it('snapshots input bytes before a random callback mutates inputs', () => {
        const input = fixture();
        input.basicBranch = { virtualResultByte: 0, kind: 'span', span: Uint8Array.of(4, 5) };
        const expected = encodeTargetServiceRequest(input);
        const branch = input.basicBranch;

        input.randomSource = (length) => {
            branch.span.fill(9);
            input.head.fill(9);
            input.busi.fill(9);
            input.targetTeaKey.fill(9);
            input.uin = 'changed';
            input.requestObjectByte = 0;
            return fixedRandom(length);
        };

        expect(encodeTargetServiceRequest(input)).toEqual(expected);
    });

    it('rejects a forged random prefix and round-trips the real request with caller-owned bytes', () => {
        const input = fixture();

        input.randomSource = (length) => {
            const bytes = new Uint8Array(length + 3).fill(0x41);
            Object.defineProperty(bytes, 'length', { value: length });
            return bytes;
        };

        expect(() => encodeTargetServiceRequest(input)).toThrow(
            'target service request construction failed',
        );

        let source: Uint8Array | undefined;

        input.randomSource = (length) => {
            source = new Uint8Array(length).fill(0x42);
            return source;
        };

        const frame = encodeTargetServiceRequest(input);
        expect(qqTeaDecrypt(frame.subarray(24), fixtureKey)).toEqual(Uint8Array.of(0, 1, 2));
        expect(source).toEqual(new Uint8Array(source!.length).fill(0x42));
    });

    it('changes only ciphertext for differing random padding', () => {
        const first = fixture();
        const second = fixture();
        second.randomSource = (length) => new Uint8Array(length).fill(0x22);
        const a = encodeTargetServiceRequest(first);
        const b = encodeTargetServiceRequest(second);
        expect(a.subarray(0, 24)).toEqual(b.subarray(0, 24));
        expect(a.subarray(24)).not.toEqual(b.subarray(24));
        expect(qqTeaDecrypt(b.subarray(24), fixtureKey)).toEqual(Uint8Array.of(0, 1, 2));
    });

    it('enforces the local inclusive frame bound, including at the exact limit', () => {
        const input = fixture();
        input.uin = '';
        input.head = new Uint8Array();
        input.busi = new Uint8Array();
        input.basicBranch = {
            virtualResultByte: 0,
            kind: 'span',
            span: new Uint8Array(MAX_TARGET_SERVICE_REQUEST_BYTES - 34),
        };
        const frame = Buffer.from(encodeTargetServiceRequest(input));
        expect(frame.length).toBe(MAX_TARGET_SERVICE_REQUEST_BYTES);
        expect(frame.readUInt32BE(0)).toBe(MAX_TARGET_SERVICE_REQUEST_BYTES);
        input.head = new Uint8Array(6);
        expect(encodeTargetServiceRequest(input).length).toBe(MAX_TARGET_SERVICE_REQUEST_BYTES);
        input.head = new Uint8Array(7);
        expect(() => encodeTargetServiceRequest(input)).toThrow(/size limit/);
        input.head = new Uint8Array();
        input.basicBranch.span = new Uint8Array(MAX_TARGET_SERVICE_REQUEST_BYTES - 33);
        expect(() => encodeTargetServiceRequest(input)).toThrow(/size limit/);
    });

    it('rejects unknown commands, range errors, malformed Unicode and inconsistent branches', () => {
        const input = fixture();
        expect(() =>
            encodeTargetServiceRequest({ ...input, sourceCommand: 'wtlogin.login' as never }),
        ).toThrow(/command/);

        for (const value of [-1, 0x100000000, 1.5, NaN]) {
            expect(() => encodeTargetServiceRequest({ ...input, virtualProtocol: value })).toThrow(
                /protocol/,
            );
            expect(() =>
                encodeTargetServiceRequest({
                    ...input,
                    basicBranch: { virtualResultByte: 1, kind: 'value', value },
                }),
            ).toThrow(/branch value/);
        }

        for (const value of [-1, 256, 1.5, NaN]) {
            expect(() =>
                encodeTargetServiceRequest({ ...input, requestObjectByte: value }),
            ).toThrow(/byte/);
            expect(() =>
                encodeTargetServiceRequest({
                    ...input,
                    basicBranch: { virtualResultByte: value, kind: 'value', value: 1 },
                }),
            ).toThrow(/virtual result/);
        }

        expect(() =>
            encodeTargetServiceRequest({
                ...input,
                basicBranch: { virtualResultByte: 0, kind: 'value', value: 0 },
            }),
        ).toThrow(/disagree/);
        expect(() =>
            encodeTargetServiceRequest({
                ...input,
                basicBranch: {
                    virtualResultByte: 1,
                    kind: 'span',
                    span: new Uint8Array(),
                } as never,
            }),
        ).toThrow(/disagree/);

        for (const uin of ['\ud800', '\udc00', 'x\ud800y']) {
            expect(() => encodeTargetServiceRequest({ ...input, uin })).toThrow(/UIN/);
        }

        expect(() =>
            encodeTargetServiceRequest({ ...input, targetTeaKey: new Uint8Array(15) }),
        ).toThrow(/key/);
        expect(() => encodeTargetServiceRequest({ ...input, head: [] as never })).toThrow(/head/);
        expect(() =>
            encodeTargetServiceRequest({ ...input, randomSource: (n) => new Uint8Array(n - 1) }),
        ).toThrow(/construction failed/);
    });

    it('suppresses thrown getter and callback contents in diagnostics', () => {
        const marker = 'SENSITIVE_SYNTHETIC_MARKER';
        const input = fixture();

        input.randomSource = () => {
            throw new Error(marker);
        };

        expect(() => encodeTargetServiceRequest(input)).toThrow(
            'target service request construction failed',
        );

        try {
            encodeTargetServiceRequest(input);
        } catch (error) {
            expect(String(error)).not.toContain(marker);
        }

        Object.defineProperty(input, 'targetTeaKey', {
            get() {
                throw new Error(marker);
            },
        });
        expect(() => encodeTargetServiceRequest(input)).toThrow(/accessor/);
    });

    it('rejects accessors and proxies before executing getters or proxy traps', () => {
        let called = 0;
        const input = fixture();
        Object.defineProperty(input, 'head', {
            get() {
                called++;
                input.busi.fill(9);
                return Uint8Array.of(0);
            },
        });
        expect(() => encodeTargetServiceRequest(input)).toThrow(/accessor/);
        expect(called).toBe(0);
        const branch = fixture();
        Object.defineProperty(branch.basicBranch, 'value', {
            get() {
                called++;
                return 0;
            },
        });
        expect(() => encodeTargetServiceRequest(branch)).toThrow(/accessor/);
        expect(called).toBe(0);
        const trap = {
            getOwnPropertyDescriptor() {
                called++;
                throw new Error('trap');
            },
        };
        expect(() => encodeTargetServiceRequest(new Proxy(fixture(), trap))).toThrow(/record/);
        const proxiedBranch = fixture();
        proxiedBranch.basicBranch = new Proxy(proxiedBranch.basicBranch, trap);
        expect(() => encodeTargetServiceRequest(proxiedBranch)).toThrow(/record/);
        expect(called).toBe(0);
    });

    it('uses real typed-array internal lengths and rejects shared backing stores', () => {
        const input = fixture();
        input.head = new Uint8Array(MAX_TARGET_SERVICE_REQUEST_BYTES);
        let called = false;
        Object.defineProperty(input.head, 'byteLength', {
            get() {
                called = true;
                return 0;
            },
        });
        expect(() => encodeTargetServiceRequest(input)).toThrow(/size limit/);
        expect(called).toBe(false);
        const wrongKey = fixture();
        wrongKey.targetTeaKey = new Uint8Array(17);
        Object.defineProperty(wrongKey.targetTeaKey, 'byteLength', {
            get() {
                called = true;
                return 16;
            },
        });
        expect(() => encodeTargetServiceRequest(wrongKey)).toThrow(/key/);
        expect(called).toBe(false);

        for (const field of ['head', 'busi', 'targetTeaKey'] as const) {
            const shared = fixture();
            shared[field] = new Uint8Array(
                new SharedArrayBuffer(field === 'targetTeaKey' ? 16 : 1),
            );
            expect(() => encodeTargetServiceRequest(shared)).toThrow();
        }

        const sharedSpan = fixture();
        sharedSpan.basicBranch = {
            kind: 'span',
            virtualResultByte: 0,
            span: new Uint8Array(new SharedArrayBuffer(1)),
        };
        expect(() => encodeTargetServiceRequest(sharedSpan)).toThrow();
    });

    it('sanitizes a previously returned validation error thrown by a callback', () => {
        let prior: Error | undefined;

        try {
            encodeTargetServiceRequest({ ...fixture(), sourceCommand: 'unknown' as never });
        } catch (error) {
            prior = error as Error;
        }

        expect(prior).toBeDefined();
        const marker = 'SYNTHETIC_MARKER';
        prior!.message = marker;
        const input = fixture();

        input.randomSource = () => {
            throw prior;
        };

        expect(() => encodeTargetServiceRequest(input)).toThrow(
            'target service request construction failed',
        );

        try {
            encodeTargetServiceRequest(input);
        } catch (error) {
            expect(String(error)).not.toContain(marker);
        }
    });

    it('wipes owned copies on success and callback failure', async () => {
        const wiped: Uint8Array[] = [];
        const original = Uint8Array.prototype.fill;
        const spy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value,
            start,
            end,
        ) {
            const result = original.call(this, value, start, end);

            if (value === 0 && start === undefined && end === undefined) {
                wiped.push(this);
            }

            return result;
        });

        try {
            vi.resetModules();
            const fresh = await import('../../src/direct/target-service-request');
            const input = fixture();
            input.basicBranch = { kind: 'span', virtualResultByte: 0, span: Uint8Array.of(8) };
            const output = fresh.encodeTargetServiceRequest(input);
            expect(output.some((byte) => byte !== 0)).toBe(true);
            expect(wiped).toHaveLength(6);
            expect(wiped.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
            expect(input.basicBranch.span[0]).toBe(8);
            expect(input.targetTeaKey).toEqual(fixtureKey);
            wiped.length = 0;

            input.randomSource = () => {
                throw new Error('synthetic');
            };

            expect(() => fresh.encodeTargetServiceRequest(input)).toThrow(/construction failed/);
            expect(wiped).toHaveLength(5);
            expect(wiped.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
        } finally {
            spy.mockRestore();
            vi.resetModules();
        }
    });
});
