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
    encodeTargetMsfTrimmedHeadCandidate as encode,
    MAX_TARGET_MSF_TRIMMED_HEAD_BYTES as MAX,
    type TargetMsfTrimmedHeadCandidateInput as Input,
} from '../../src/direct/target-msf-trimmed-head-candidate';

const ERROR = 'target MSF trimmed head construction failed';
const GOLDEN = '0000001800000007434d4400000006aabb00000007ccdd00';
const NAMES = ['field50', 'field68', 'fieldE0'] as const;
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
let guards: Array<{ mock: { calls: readonly unknown[] } }> = [];

function fixture(): Input {
    return {
        field50: Buffer.from('CMD'),
        field68: Uint8Array.of(0xaa, 0xbb),
        fieldE0: Uint8Array.of(0xcc, 0xdd, 0),
    };
}

function empty(): Input {
    return { field50: new Uint8Array(), field68: new Uint8Array(), fieldE0: new Uint8Array() };
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

describe('offline mode-13/21 trimmed head candidate', () => {
    it('matches an independently stated three-field wire vector', () => {
        expect(hex(encode(fixture()))).toBe(GOLDEN);
    });

    it('writes sixteen bytes for three empty fields', () => {
        expect(hex(encode(empty()))).toBe('00000010000000040000000400000004');
    });

    it('counts all eight empty/nonempty combinations without optional fields', () => {
        for (let mask = 0; mask < 8; mask++) {
            const input = empty();
            const expected = ['00000004', '00000004', '00000004'];
            let total = 16;

            for (let index = 0; index < NAMES.length; index++) {
                if ((mask & (1 << index)) !== 0) {
                    input[NAMES[index]] = Uint8Array.of(index + 1);
                    expected[index] = `000000050${index + 1}`;
                    total++;
                }
            }

            expect(hex(encode(input))).toBe(
                total.toString(16).padStart(8, '0') + expected.join(''),
            );
        }
    });

    it('preserves opaque bytes and inclusive lengths at multiple boundaries', () => {
        for (const name of NAMES) {
            for (const length of [0, 1, 7, 8, 255, 256]) {
                const input = empty();
                input[name] = new Uint8Array(length).fill(0xfe);
                const output = encode(input);
                const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
                expect(view.getUint32(0)).toBe(16 + length);
                let offset = 4;

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

    it('accepts Buffer slices, foreign-realm views and null-prototype records', () => {
        const source = Buffer.from([0xff, 0x43, 0x4d, 0x44, 0xff]);
        const input = Object.assign(Object.create(null) as Input, fixture(), {
            field50: source.subarray(1, 4),
            field68: runInNewContext('new Uint8Array([0xaa,0xbb])') as Uint8Array,
        });
        expect(hex(encode(input))).toBe(GOLDEN);
    });

    it('does not consult byte-view instance metadata or iterators', () => {
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

    it('owns the output and neither mutates nor aliases caller bytes', () => {
        const input = fixture();
        const original = NAMES.map((name) => hex(input[name]));
        const first = encode(input);
        const second = encode(input);
        expect(NAMES.map((name) => hex(input[name]))).toEqual(original);
        input.field50.fill(0);
        expect(hex(first)).toBe(GOLDEN);
        first.fill(0);
        expect(hex(second)).toBe(GOLDEN);
    });

    it('requires exactly the three own data fields on a plain record', () => {
        for (const input of [null, undefined, 1, [], Object.create(fixture()) as unknown]) {
            rejected(input);
        }

        rejected({ ...fixture(), field08: 1 });
        rejected({ ...fixture(), [Symbol('extra')]: 1 });
        const missing: Partial<Input> = fixture();
        delete missing.field68;
        rejected(missing);
        const wrongName = { field50: new Uint8Array(), field68: new Uint8Array(), other: 1 };
        rejected(wrongName);
    });

    it('rejects root accessors and proxies without invoking their traps', () => {
        const trap = vi.fn(blocked);
        const input = fixture();
        Object.defineProperty(input, 'field50', { get: trap });
        rejected(input);
        rejected(new Proxy(fixture(), { get: trap, ownKeys: trap, getPrototypeOf: trap }));
        expect(trap).not.toHaveBeenCalled();
    });

    it.each(NAMES)('rejects invalid, shared, detached and out-of-bounds %s views', (name) => {
        const detached = new ArrayBuffer(4);
        const detachedView = new Uint8Array(detached);
        structuredClone(detached, { transfer: [detached] });
        const resized = new ArrayBuffer(4, { maxByteLength: 8 });
        const outOfBounds = new Uint8Array(resized, 0, 4);
        resized.resize(0);
        const invalid = [
            null,
            undefined,
            [],
            'bytes',
            new Uint16Array(1),
            new Uint8ClampedArray(1),
            new DataView(new ArrayBuffer(1)),
            Object.create(Uint8Array.prototype) as unknown,
            new Proxy(new Uint8Array(1), {}),
            new Uint8Array(new SharedArrayBuffer(1)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(1))') as unknown,
            detachedView,
            outOfBounds,
        ];

        for (const value of invalid) {
            rejected({ ...fixture(), [name]: value });
        }
    });

    it('enforces the total local cap before invoking the field encoder', () => {
        const accepted = encode({ ...empty(), field50: new Uint8Array(MAX - 16) });
        expect(accepted.length).toBe(MAX);
        expect(new DataView(accepted.buffer).getUint32(0)).toBe(MAX);
        expect(hex(accepted.subarray(MAX - 8))).toBe('0000000400000004');
        const spy = vi.spyOn(fields, 'encodeTargetMsfLengthPrefixedFieldCandidate');
        rejected({ ...empty(), field50: new Uint8Array(MAX - 15) });
        const individuallyBounded = accepted.subarray(0, (MAX - 16) / 2);
        rejected({
            field50: individuallyBounded,
            field68: individuallyBounded,
            fieldE0: Uint8Array.of(1),
        });
        expect(spy).not.toHaveBeenCalled();
    });

    it('clears framed temporaries after successful construction', () => {
        const original = fields.encodeTargetMsfLengthPrefixedFieldCandidate;
        const parts: Uint8Array[] = [];
        vi.spyOn(fields, 'encodeTargetMsfLengthPrefixedFieldCandidate').mockImplementation(
            (input) => {
                const part = original(input);
                parts.push(part);
                return part;
            },
        );
        expect(hex(encode(fixture()))).toBe(GOLDEN);
        expect(parts).toHaveLength(3);

        for (const part of parts) {
            expect(part.every((byte) => byte === 0)).toBe(true);
        }
    });

    it('clears completed temporaries and hides downstream error details on failure', () => {
        const original = fields.encodeTargetMsfLengthPrefixedFieldCandidate;
        const first = original(fixture().field50);
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

    it.each([13, 21] as const)('composes real QQ-TEA and Base mode %s without effects', (mode) => {
        const head = encode(fixture());
        const plain = Buffer.concat([head, Buffer.from('00000004', 'hex')]);
        const key = new Uint8Array(16);
        const ciphertext = qqTeaEncrypt(plain, key, (length) => new Uint8Array(length));
        const frame = encodeTargetMsfRequestBaseCandidate({
            mode,
            flagA1: 0,
            field0c: 2,
            fieldA4: 0x01020304,
            field60: 0,
            field68: Uint8Array.of(0x30),
            field28: ciphertext,
        });
        const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
        expect(view.getUint32(0)).toBe(frame.length);
        expect(view.getUint32(4)).toBe(mode);
        expect(view.getUint8(8)).toBe(2);
        expect(view.getUint32(9)).toBe(0x01020304);
        expect(view.getUint8(13)).toBe(0);
        expect(view.getUint32(14)).toBe(5);
        expect(view.getUint8(18)).toBe(0x30);
        expect(frame.subarray(19)).toEqual(ciphertext);
        expect(hex(qqTeaDecrypt(frame.subarray(19), key))).toBe(GOLDEN + '00000004');
    });
});
