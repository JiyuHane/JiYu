import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import * as fields from '../../src/direct/target-msf-length-prefixed-field-candidate';
import { encodeTargetMsfRequestBaseCandidate } from '../../src/direct/target-msf-request-base-candidate';
import {
    encodeTargetMsfSso20HeadCandidate as encode,
    MAX_TARGET_MSF_SSO20_HEAD_BYTES as MAX,
    type TargetMsfSso20HeadCandidateInput as Input,
} from '../../src/direct/target-msf-sso20-head-candidate';

const ERROR = 'target MSF SSO20 head construction failed';
const GOLDEN =
    '0000002e010203040000000d313233343536373839' +
    '00000005110000000522000000053300000005440000000555';
const NAMES = ['field20', 'field50', 'field68', 'field98', 'fieldE0'] as const;
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
let guards: Array<{ mock: { calls: readonly unknown[] } }> = [];

function fixture(): Input {
    return {
        field08: 0x01020304,
        field0c: 123456789,
        field20: Uint8Array.of(0x11),
        field50: Uint8Array.of(0x22),
        field68: Uint8Array.of(0x33),
        field98: Uint8Array.of(0x44),
        fieldE0: Uint8Array.of(0x55),
    };
}

function empty(): Input {
    return {
        field08: 0,
        field0c: 0,
        field20: new Uint8Array(),
        field50: new Uint8Array(),
        field68: new Uint8Array(),
        field98: new Uint8Array(),
        fieldE0: new Uint8Array(),
    };
}

function rejected(input: unknown): void {
    expect(() => encode(input as Input)).toThrow(ERROR);
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

describe('offline mode-20 SSO head candidate', () => {
    it('matches fixed bytes with an ASCII decimal field and five byte fields', () => {
        expect(hex(encode(fixture()))).toBe(GOLDEN);
    });

    it('has a 33-byte minimum, including the ASCII zero', () => {
        expect(hex(encode(empty()))).toBe('00000021000000000000000530' + '00000004'.repeat(5));
    });

    it.each([
        [0, '0'],
        [9, '9'],
        [10, '10'],
        [99, '99'],
        [100, '100'],
        [9999, '9999'],
        [10000, '10000'],
        [99999999, '99999999'],
        [100000000, '100000000'],
        [0x7fffffff, '2147483647'],
        [0x80000000, '-2147483648'],
        [0xfffffff6, '-10'],
        [0xffffffff, '-1'],
    ] as const)('interprets field0c bit pattern %s as decimal %s', (field0c, text) => {
        const output = encode({ ...empty(), field0c });
        const view = new DataView(output.buffer);
        expect(view.getUint32(0)).toBe(32 + text.length);
        expect(view.getUint32(8)).toBe(4 + text.length);
        expect(Buffer.from(output.subarray(12, 12 + text.length)).toString('ascii')).toBe(text);
        expect(hex(output.subarray(12 + text.length))).toBe('00000004'.repeat(5));
    });

    it('retains all sequence bits independently of signed decimal conversion', () => {
        const output = encode({ ...empty(), field08: 0xffffffff });
        expect(new DataView(output.buffer).getUint32(4)).toBe(0xffffffff);
    });

    it('preserves opaque bytes and exact field boundaries', () => {
        for (const name of NAMES) {
            for (const length of [0, 1, 7, 8, 255, 256]) {
                const input = empty();
                input[name] = new Uint8Array(length).fill(0xfe);
                const output = encode(input);
                const view = new DataView(output.buffer);
                expect(view.getUint32(0)).toBe(33 + length);
                let offset = 13;

                for (const field of NAMES) {
                    const size = view.getUint32(offset);
                    expect(size).toBe(4 + input[field].length);
                    expect(output.subarray(offset + 4, offset + size)).toEqual(input[field]);
                    offset += size;
                }

                expect(offset).toBe(output.length);
            }
        }
    });

    it('accepts subviews, foreign views and a null-prototype input', () => {
        const input = Object.assign(Object.create(null) as Input, fixture(), {
            field20: Buffer.from([0xff, 0x11, 0xff]).subarray(1, 2),
            field50: runInNewContext('new Uint8Array([0x22])') as Uint8Array,
        });
        expect(hex(encode(input))).toBe(GOLDEN);
    });

    it('does not consult byte-view properties, iterators or constructors', () => {
        const input = fixture();
        const trap = vi.fn(blocked);

        for (const name of NAMES) {
            for (const property of [
                'length',
                'buffer',
                'byteOffset',
                'byteLength',
                'constructor',
            ]) {
                Object.defineProperty(input[name], property, { get: trap });
            }

            Object.defineProperty(input[name], Symbol.iterator, { get: trap });
        }

        expect(hex(encode(input))).toBe(GOLDEN);
        expect(trap).not.toHaveBeenCalled();
    });

    it('owns the result without changing caller bytes', () => {
        const input = fixture();
        const before = NAMES.map((name) => hex(input[name]));
        const first = encode(input);
        const second = encode(input);
        expect(NAMES.map((name) => hex(input[name]))).toEqual(before);
        input.field20.fill(0);
        expect(hex(first)).toBe(GOLDEN);
        first.fill(0);
        expect(hex(second)).toBe(GOLDEN);
    });

    it('requires seven own data fields with no implicit mixed-prefix values', () => {
        const trap = vi.fn(blocked);
        const accessor = fixture();
        Object.defineProperty(accessor, 'field0c', { get: trap });

        for (const input of [null, undefined, [], Object.create(fixture()) as unknown, accessor]) {
            rejected(input);
        }

        rejected(new Proxy(fixture(), { get: trap, ownKeys: trap, getPrototypeOf: trap }));
        rejected({ ...fixture(), field14: 1 });
        rejected({ ...fixture(), [Symbol('extra')]: 1 });
        const missing: Partial<Input> = fixture();
        delete missing.field98;
        rejected(missing);
        expect(trap).not.toHaveBeenCalled();
    });

    it.each(['field08', 'field0c'] as const)('validates raw u32 %s without coercion', (name) => {
        const trap = vi.fn(blocked);

        for (const value of [
            -1,
            0x100000000,
            1.5,
            NaN,
            Infinity,
            null,
            '1',
            1n,
            { valueOf: trap },
        ]) {
            rejected({ ...fixture(), [name]: value });
        }

        expect(trap).not.toHaveBeenCalled();
    });

    it.each(NAMES)('rejects invalid, shared, detached and out-of-bounds %s', (name) => {
        const buffer = new ArrayBuffer(4);
        const detached = new Uint8Array(buffer);
        structuredClone(buffer, { transfer: [buffer] });
        const resizable = new ArrayBuffer(4, { maxByteLength: 8 });
        const outOfBounds = new Uint8Array(resizable, 0, 4);
        resizable.resize(0);

        for (const value of [
            undefined,
            null,
            [],
            'bytes',
            new Uint16Array(1),
            new Uint8ClampedArray(1),
            new DataView(new ArrayBuffer(1)),
            Object.create(Uint8Array.prototype) as unknown,
            new Proxy(new Uint8Array(1), {}),
            new Uint8Array(new SharedArrayBuffer(1)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(1))') as unknown,
            detached,
            outOfBounds,
        ]) {
            rejected({ ...fixture(), [name]: value });
        }
    });

    it('enforces total size, aggregate bytes and decimal width before framing', () => {
        const field20 = new Uint8Array(MAX - 33);
        const output = encode({ ...empty(), field20 });
        expect(output.length).toBe(MAX);
        expect(new DataView(output.buffer).getUint32(0)).toBe(MAX);
        const spy = vi.spyOn(fields, 'encodeTargetMsfLengthPrefixedFieldCandidate');
        rejected({ ...empty(), field20: new Uint8Array(MAX - 32) });
        rejected({ ...empty(), field20, field0c: 0xffffffff });
        rejected({
            ...empty(),
            field20: field20.subarray(0, MAX - 34),
            field50: Uint8Array.of(1, 2),
        });
        expect(spy).not.toHaveBeenCalled();
    });

    it('clears all six framed temporaries and the private decimal bytes', () => {
        const original = fields.encodeTargetMsfLengthPrefixedFieldCandidate;
        const parts: Uint8Array[] = [];
        const sources: Uint8Array[] = [];
        vi.spyOn(fields, 'encodeTargetMsfLengthPrefixedFieldCandidate').mockImplementation(
            (input) => {
                sources.push(input);
                const part = original(input);
                parts.push(part);
                return part;
            },
        );
        expect(hex(encode(fixture()))).toBe(GOLDEN);
        expect(parts).toHaveLength(6);
        expect(sources[0].every((byte) => byte === 0)).toBe(true);

        for (const part of parts) {
            expect(part.every((byte) => byte === 0)).toBe(true);
        }
    });

    it('clears earlier framed output and hides details when a dependency fails', () => {
        const original = fields.encodeTargetMsfLengthPrefixedFieldCandidate;
        const first = original(Uint8Array.of(0x31));
        vi.spyOn(fields, 'encodeTargetMsfLengthPrefixedFieldCandidate')
            .mockReturnValueOnce(first)
            .mockImplementationOnce(() => {
                throw new Error('private-marker');
            });
        let failure: unknown;

        try {
            encode(fixture());
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(ERROR);
        expect((failure as Error).cause).toBeUndefined();
        expect((failure as Error).stack).not.toContain('private-marker');
        expect(first.every((byte) => byte === 0)).toBe(true);
    });

    it('composes real QQ-TEA and Base20 with an explicitly supplied key', () => {
        const head = encode(fixture());
        const plaintext = Buffer.concat([head, Buffer.from('deadbeef', 'hex')]);
        const key = new Uint8Array(16).fill(0x11);
        const ciphertext = qqTeaEncrypt(plaintext, key, (length) => new Uint8Array(length));
        const frame = encodeTargetMsfRequestBaseCandidate({
            mode: 20,
            flagA1: 0,
            field0c: 1,
            field10: Uint8Array.of(0x77),
            field60: 0,
            field68: Uint8Array.of(0x30),
            field28: ciphertext,
        });
        const view = new DataView(frame.buffer);
        expect(view.getUint32(0)).toBe(frame.length);
        expect(view.getUint32(4)).toBe(20);
        expect(view.getUint8(8)).toBe(1);
        expect(view.getUint32(9)).toBe(5);
        expect(view.getUint8(13)).toBe(0x77);
        expect(view.getUint8(14)).toBe(0);
        expect(view.getUint32(15)).toBe(5);
        expect(view.getUint8(19)).toBe(0x30);
        expect(frame.subarray(20)).toEqual(ciphertext);
        expect(hex(qqTeaDecrypt(frame.subarray(20), key))).toBe(GOLDEN + 'deadbeef');
    });
});
