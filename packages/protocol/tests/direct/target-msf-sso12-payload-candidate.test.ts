import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { encodeTargetMsfRequestBaseCandidate } from '../../src/direct/target-msf-request-base-candidate';
import { encodeTargetMsfSso12HeadCandidate } from '../../src/direct/target-msf-sso12-head-candidate';
import {
    encodeTargetMsfSso12PayloadCandidate as encode,
    MAX_TARGET_MSF_SSO12_PAYLOAD_BYTES as MAX,
    type TargetMsfSso12PayloadCandidateInput as Input,
} from '../../src/direct/target-msf-sso12-payload-candidate';

const ERROR = 'target MSF SSO12 payload construction failed';
const KEY_HEX = '000102030405060708090a0b0c0d0e0f';
const HEAD_HEX =
    '00000036010203041122334420027635010001020304050607080000' +
    '0000000400000004000000040000000400000004000200000004';
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
let guards: Array<{ mock: { calls: readonly unknown[] } }> = [];

function random(size: number): Uint8Array {
    const bytes = new Uint8Array(size);
    bytes[0] = 0xf8;
    return bytes;
}

function fixture(): Input {
    return {
        head: {
            field08: 0x01020304,
            field0c: 0x11223344,
            field10: 0x20027635,
            field14: 1,
            globalPrefix9: Uint8Array.from({ length: 9 }, (_, i) => i),
            field15: 0,
            field16: 0,
            field20: new Uint8Array(),
            field50: new Uint8Array(),
            field68: new Uint8Array(),
            field98: new Uint8Array(),
            fieldB0: new Uint8Array(),
            fieldC8: new Uint8Array(),
            fieldE0: new Uint8Array(),
        },
        body80: new Uint8Array(),
        key38: Buffer.from(KEY_HEX, 'hex'),
        randomSource: random,
    };
}

function rejected(input: unknown): void {
    let caught: unknown;

    try {
        encode(input as Input);
    } catch (error) {
        caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(ERROR);
    expect((caught as Error).cause).toBeUndefined();
    expect((caught as Error).stack ?? '').not.toContain('private-marker');
}

function blocked(): never {
    throw new Error('unexpected effect');
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

describe('offline SDK uncompressed encrypted payload candidate', () => {
    it('encrypts a fixed mixed head plus the four-byte empty-body fallback', () => {
        const input = fixture();
        const plaintext = Buffer.from(HEAD_HEX + '00000004', 'hex');
        const result = encode(input);
        expect(hex(qqTeaDecrypt(result, input.key38))).toBe(hex(plaintext));
        expect(result).toEqual(qqTeaEncrypt(plaintext, input.key38, random));
        expect(result.length).toBe(72);
        expect(new DataView(plaintext.buffer, plaintext.byteOffset).getUint32(0)).toBe(54);
    });

    it('accepts an explicitly supplied 16-byte zero key without inventing a fallback', () => {
        const input = fixture();
        input.key38 = new Uint8Array(16);
        const plaintext = Buffer.from(HEAD_HEX + '00000004', 'hex');
        const result = encode(input);
        expect(result).toEqual(qqTeaEncrypt(plaintext, input.key38, random));
        expect(hex(qqTeaDecrypt(result, input.key38))).toBe(hex(plaintext));
        expect(result).not.toEqual(encode(fixture()));
        // Native branch selection is not part of this API; empty keys still fail.
        rejected({ ...input, key38: new Uint8Array() });
    });

    it.each(['ab', 'deadbeef', '00000005ab'])(
        'appends existing nonempty body %s without an additional frame prefix',
        (body) => {
            const input = { ...fixture(), body80: Buffer.from(body, 'hex') };
            expect(hex(qqTeaDecrypt(encode(input), input.key38))).toBe(HEAD_HEX + body);
        },
    );

    it('matches all padding alignments and passes the exact prefix size to the callback', () => {
        for (let length = 0; length < 17; length++) {
            const calls: number[] = [];
            const input = {
                ...fixture(),
                body80: new Uint8Array(length).fill(0xaa),
                randomSource: (size: number) => {
                    calls.push(size);
                    return random(size);
                },
            };
            const plainLength = 54 + (length === 0 ? 4 : length);
            const padding = (8 - ((plainLength + 10) % 8)) % 8;
            const output = encode(input);
            expect(calls).toEqual([padding + 3]);
            expect(output.length).toBe(plainLength + padding + 10);
            const expectedBody = length === 0 ? '00000004' : 'aa'.repeat(length);
            expect(hex(qqTeaDecrypt(output, input.key38))).toBe(HEAD_HEX + expectedBody);
        }
    });

    it('uses the existing secure default when no callback is supplied', () => {
        const input = fixture();
        delete input.randomSource;
        expect(hex(qqTeaDecrypt(encode(input), input.key38))).toBe(HEAD_HEX + '00000004');
    });

    it('composes real head, encryption and normal outer codecs with synthetic inputs only', () => {
        const input = fixture();
        const encrypted = encode(input);
        const frame = encodeTargetMsfRequestBaseCandidate({
            mode: 12,
            flagA1: 0,
            field0c: 1,
            field10: Uint8Array.of(0x55),
            field60: 0,
            field68: Uint8Array.of(0x31),
            field28: encrypted,
        });
        expect(frame.subarray(20)).toEqual(encrypted);
        expect(hex(qqTeaDecrypt(frame.subarray(20), input.key38))).toBe(HEAD_HEX + '00000004');
        expect(new DataView(frame.buffer).getUint32(0)).toBe(frame.length);
        // No native execution or peer acceptance is inferred from this composition.
    });

    it('snapshots all plaintext and key material before a callback mutates the original inputs', () => {
        const input = fixture();
        input.body80 = Uint8Array.of(0xde, 0xad);
        const originalKey = Uint8Array.from(input.key38);

        input.randomSource = (size) => {
            input.head.globalPrefix9.fill(0xff);
            input.head.field08 = 0;
            input.body80.fill(0);
            input.key38.fill(0);
            return random(size);
        };

        const output = encode(input);
        expect(hex(qqTeaDecrypt(output, originalKey))).toBe(HEAD_HEX + 'dead');
    });

    it('survives detachment of caller-owned inputs inside the RNG', () => {
        const input = fixture();
        input.key38 = Uint8Array.from(input.key38);
        input.body80 = Uint8Array.of(0xab);
        const key = Uint8Array.from(input.key38);

        input.randomSource = (size) => {
            for (const buffer of [
                input.key38.buffer,
                input.body80.buffer,
                input.head.globalPrefix9.buffer,
            ]) {
                if (!(buffer instanceof ArrayBuffer)) {
                    throw new Error('expected a local nonshared fixture buffer');
                }

                structuredClone(buffer, { transfer: [buffer] });
            }

            return random(size);
        };

        expect(hex(qqTeaDecrypt(encode(input), key))).toBe(HEAD_HEX + 'ab');
    });

    it('respects Buffer and foreign-realm subviews and returns independent output', () => {
        const input = fixture();
        input.body80 = Buffer.from([0xee, 0xab, 0xcd, 0xee]).subarray(1, 3);
        input.key38 = runInNewContext(
            'Uint8Array.from({length:18}, (_,i)=>i-1).subarray(1,17)',
        ) as Uint8Array;
        const first = encode(input);
        const second = encode(input);
        expect(hex(qqTeaDecrypt(first, input.key38))).toBe(HEAD_HEX + 'abcd');
        expect(first.buffer).not.toBe(second.buffer);
        first.fill(0);
        expect(hex(qqTeaDecrypt(second, input.key38))).toBe(HEAD_HEX + 'abcd');
        expect(hex(input.body80)).toBe('abcd');
        expect(hex(input.key38)).toBe(KEY_HEX);
    });

    it('ignores shadowed view metadata and accepts null-prototype input records', () => {
        const input = fixture();
        input.body80 = Uint8Array.of(0xab);
        let calls = 0;

        const hostile = () => {
            calls++;
            throw new Error('unexpected getter');
        };

        for (const view of [input.key38, input.body80]) {
            for (const name of ['length', 'byteLength', 'byteOffset', 'buffer', 'set', 'slice']) {
                Object.defineProperty(view, name, { get: hostile });
            }
        }

        const plainRecord = Object.assign(Object.create(null) as Input, input);
        const output = encode(plainRecord);
        expect(hex(qqTeaDecrypt(output, Buffer.from(KEY_HEX, 'hex')))).toBe(HEAD_HEX + 'ab');
        expect(calls).toBe(0);
    });

    it.each([0, 1, 15, 17, 32])('rejects a %i-byte key before RNG invocation', (length) => {
        const rng = vi.fn(random);
        rejected({ ...fixture(), key38: new Uint8Array(length), randomSource: rng });
        expect(rng).not.toHaveBeenCalled();
    });

    it('rejects an oversized result before plaintext/ciphertext allocation or RNG invocation', () => {
        const rng = vi.fn(random);
        // H=54, body=MAX-63: the padded ciphertext would be MAX+8 bytes.
        rejected({ ...fixture(), body80: new Uint8Array(MAX - 63), randomSource: rng });
        expect(rng).not.toHaveBeenCalled();
    });

    it('validates nested heads and top-level own data without running getters or proxies', () => {
        let calls = 0;

        const hostile = () => {
            calls++;
            throw new Error('unexpected hook');
        };

        const input = fixture();
        Object.defineProperty(input, 'head', { get: hostile });
        rejected(input);
        rejected(new Proxy(fixture(), { ownKeys: hostile, getPrototypeOf: hostile }));
        const missing: Partial<Input> = fixture();
        delete missing.key38;
        rejected(missing);
        rejected({ ...fixture(), compression: false });
        rejected({ ...fixture(), [Symbol('extra')]: 0 });
        rejected({ ...fixture(), head: { ...fixture().head, field14: 256 } });
        rejected({ ...fixture(), head: Object.create(fixture().head) });
        expect(calls).toBe(0);
    });

    it('rejects shared, detached, OOB and fake input views', () => {
        const detached = new Uint8Array(16);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const backing = new ArrayBuffer(16, { maxByteLength: 32 });
        const oob = new Uint8Array(backing, 0, 16);
        backing.resize(8);

        for (const value of [
            null,
            {},
            [],
            new Uint16Array(16),
            new Uint8Array(new SharedArrayBuffer(16)),
            detached,
            oob,
            new Proxy(new Uint8Array(16), {}),
        ]) {
            rejected({ ...fixture(), key38: value });
            rejected({ ...fixture(), body80: value });
        }
    });

    it('sanitizes callback errors and invalid return values without changing caller storage', () => {
        for (const source of [
            42,
            new Proxy(random, {}),
            () => undefined,
            () => new Uint8Array(1),
            () => new Uint8Array(new SharedArrayBuffer(7)),
            () => {
                throw new Error('private-marker');
            },
        ]) {
            const input = { ...fixture(), randomSource: source };
            rejected(input);
            expect(hex(input.key38)).toBe(KEY_HEX);
            expect(hex(encodeTargetMsfSso12HeadCandidate(input.head))).toBe(HEAD_HEX);
        }
    });

    it('clears wrapper-owned head, key and plaintext after an RNG failure', async () => {
        const nativeFill = Uint8Array.prototype.fill;
        const cleared: Uint8Array[] = [];
        const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value,
            start,
            end,
        ) {
            const result = nativeFill.call(this, value, start, end);

            if (value === 0) {
                cleared.push(this);
            }

            return result;
        });
        const input = fixture();

        input.randomSource = () => {
            throw new Error('private-marker');
        };

        try {
            vi.resetModules();
            const fresh = await import('../../src/direct/target-msf-sso12-payload-candidate');
            expect(() => fresh.encodeTargetMsfSso12PayloadCandidate(input)).toThrow(ERROR);
        } finally {
            fillSpy.mockRestore();
            vi.resetModules();
        }

        for (const size of [16, 54, 58]) {
            const bytes = cleared.find((value) => value.length === size);
            expect(bytes).toBeDefined();
            expect(bytes).toEqual(new Uint8Array(size));
        }

        expect(hex(input.key38)).toBe(KEY_HEX);
        expect(hex(encodeTargetMsfSso12HeadCandidate(input.head))).toBe(HEAD_HEX);
    });
});
