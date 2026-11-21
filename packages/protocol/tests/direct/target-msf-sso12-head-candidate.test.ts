import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { runInNewContext } from 'node:vm';
import type { TargetSso12ReserveMessage } from '@snowluma/proto-defs/target-sso12-reserve';
import { protobuf_decode } from '@snowluma/proton';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeTargetMsfRequestBaseCandidate } from '../../src/direct/target-msf-request-base-candidate';
import {
    encodeTargetMsfSso12HeadCandidate as encode,
    MAX_TARGET_MSF_SSO12_HEAD_BYTES as MAX,
    type TargetMsfSso12HeadCandidateInput as Input,
} from '../../src/direct/target-msf-sso12-head-candidate';
import { encodeTargetSso12Head } from '../../src/direct/target-sso12-head';
import { encodeTargetSso12ReserveFromNativeSlots } from '../../src/direct/target-sso12-reserve';

const ERROR = 'target MSF SSO12 head construction failed';
const GOLDEN =
    '0000003d01020304112233445566778801a0a1a2a3a4a5a6a7a8bb0c' +
    '000000051100000005220000000533000000054400000005550003660000000577';
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const BYTE_FIELDS = [
    'field20',
    'field50',
    'field68',
    'field98',
    'fieldB0',
    'fieldC8',
    'fieldE0',
] as const;
let guards: Array<{ mock: { calls: readonly unknown[] } }> = [];

function fixture(): Input {
    return {
        field08: 0x01020304,
        field0c: 0x11223344,
        field10: 0x55667788,
        field14: 1,
        globalPrefix9: Uint8Array.from({ length: 9 }, (_, index) => 0xa0 + index),
        field15: 0xbb,
        field16: 0xc3,
        field20: Uint8Array.of(0x11),
        field50: Uint8Array.of(0x22),
        field68: Uint8Array.of(0x33),
        field98: Uint8Array.of(0x44),
        fieldB0: Uint8Array.of(0x55),
        fieldC8: Uint8Array.of(0x66),
        fieldE0: Uint8Array.of(0x77),
    };
}

function emptyStrings(): Input {
    const input = fixture();

    for (const field of BYTE_FIELDS) {
        input[field] = new Uint8Array();
    }

    return input;
}

function legacy(input: Input): Uint8Array {
    return encodeTargetSso12Head({
        sequence: input.field08,
        arg0: input.field0c,
        arg4: input.field10,
        arg8: input.field15,
        a2: input.field20,
        requestCommand: input.field50,
        this8: input.field68,
        arg28: input.field98,
        this20: input.fieldB0,
        versionArg10: input.fieldC8,
        reserved: input.fieldE0,
    });
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

describe('synthetic MSF SDK mode-12 pre-transform head', () => {
    it('matches a fixed vector with nonzero global bytes and seven distinct strings', () => {
        const output = encode(fixture());
        expect(hex(output)).toBe(GOLDEN);
        expect(new DataView(output.buffer).getUint32(0)).toBe(output.length);
    });

    it('differs from the old CPB profile only inside the explicitly replaced mixed block', () => {
        const input = fixture();
        const old = legacy(input);
        const output = encode(input);
        expect(old[16]).toBe(0);
        expect(output[16]).toBe(1);
        expect(hex(old.subarray(16, 28))).toBe('00000000000000000000bb00');
        expect(output.subarray(0, 16)).toEqual(old.subarray(0, 16));
        expect(output.subarray(28)).toEqual(old.subarray(28));
        expect(hex(legacy(input))).toBe(hex(old));
    });

    it('reproduces the old profile when its mixed bytes are explicitly selected', () => {
        const input = { ...fixture(), field14: 0, globalPrefix9: new Uint8Array(9), field16: 0 };
        expect(encode(input)).toEqual(legacy(input));
    });

    it('uses low8(field16 << 2) for every byte value, preserving adjacent fields', () => {
        for (let field16 = 0; field16 <= 255; field16++) {
            const output = encode({ ...fixture(), field16 });
            expect(output[27]).toBe((field16 * 4) % 256);
            expect(output[26]).toBe(0xbb);
            expect(output[28]).toBe(0);
        }
    });

    it.each([0, 0x80000000, 0xffffffff])(
        'keeps the u32 bit pattern %i in all three words',
        (value) => {
            const output = encode({ ...fixture(), field08: value, field0c: value, field10: value });
            const view = new DataView(output.buffer);

            for (const offset of [4, 8, 12]) {
                expect(view.getUint32(offset, false)).toBe(value);
            }
        },
    );

    it('emits the 54-byte empty-string head without adding a business body', () => {
        const output = encode(emptyStrings());
        expect(output.length).toBe(54);
        const view = new DataView(output.buffer);
        expect(view.getUint32(0)).toBe(54);

        for (const offset of [28, 32, 36, 40, 44, 50]) {
            expect(view.getUint32(offset)).toBe(4);
        }

        expect(view.getUint16(48)).toBe(2);
    });

    it('retains the delegated inclusive u16 limit rather than silently truncating it', () => {
        const input = emptyStrings();
        input.fieldC8 = new Uint8Array(65533).fill(0x5a);
        const output = encode(input);
        expect(output.length).toBe(54 + 65533);
        expect(new DataView(output.buffer).getUint16(48)).toBe(65535);
        rejected({ ...input, fieldC8: new Uint8Array(65534) });
        expect(input.fieldC8[0]).toBe(0x5a);
    });

    it('retains the shared total cap, including the head and all field prefixes', () => {
        const input = emptyStrings();
        const bytes = new Uint8Array(MAX - 53);
        input.fieldE0 = bytes.subarray(1);
        expect(encode(input).length).toBe(MAX);
        rejected({ ...input, fieldE0: bytes });
    });

    it('composes with the actual reserve and normal-wrapper codecs without claiming encryption', () => {
        const input = emptyStrings();
        input.fieldE0 = encodeTargetSso12ReserveFromNativeSlots(
            {},
            {
                at00: Uint8Array.of(0x11),
                at18: Uint8Array.of(0x22),
                at30: Uint8Array.of(0x33),
            },
        );
        expect(hex(input.fieldE0)).toBe('c201090a01331201111a0122');
        const head = encode(input);
        const decoded = protobuf_decode<TargetSso12ReserveMessage>(head.subarray(54));
        expect(decoded.field24?.field1).toEqual(Uint8Array.of(0x33));
        expect(decoded.field24?.field2).toEqual(Uint8Array.of(0x11));
        expect(decoded.field24?.field3).toEqual(Uint8Array.of(0x22));
        expect(new DataView(head.buffer).getUint32(50)).toBe(input.fieldE0.length + 4);
        // Deliberately untransformed synthetic bytes: a structural composition,
        // not a server-valid encrypted payload or execution of the native path.
        const frame = encodeTargetMsfRequestBaseCandidate({
            mode: 12,
            flagA1: 0,
            field0c: 1,
            field10: new Uint8Array(),
            field60: 0,
            field68: new Uint8Array(),
            field28: head,
        });
        expect(frame.subarray(18)).toEqual(head);
        expect(new DataView(frame.buffer).getUint32(0)).toBe(head.length + 18);
    });

    it('respects Buffer and foreign-realm subviews and owns its output', () => {
        const input = fixture();
        const backing = Buffer.alloc(13, 0xee);
        backing.set(input.globalPrefix9, 2);
        input.globalPrefix9 = backing.subarray(2, 11);
        input.field20 = runInNewContext(
            'Uint8Array.of(0xff, 0x11, 0xff).subarray(1, 2)',
        ) as Uint8Array;
        const output = encode(input);
        const second = encode(input);
        expect(hex(output)).toBe(GOLDEN);
        expect(output.buffer).not.toBe(second.buffer);
        expect(backing[0]).toBe(0xee);
        input.globalPrefix9.fill(0);

        for (const name of BYTE_FIELDS) {
            input[name].fill(0);
        }

        expect(hex(output)).toBe(GOLDEN);
        output.fill(0);
        expect(hex(second)).toBe(GOLDEN);
    });

    it('ignores hostile own view metadata, methods and iterators', () => {
        let calls = 0;

        const hostile = () => {
            calls++;
            throw new Error('view getter ran');
        };

        const input = fixture();

        for (const view of [input.globalPrefix9, input.field20]) {
            for (const name of [
                'buffer',
                'byteOffset',
                'byteLength',
                'length',
                'set',
                'slice',
                'subarray',
            ]) {
                Object.defineProperty(view, name, { get: hostile });
            }

            Object.defineProperty(view, Symbol.iterator, { get: hostile });
        }

        expect(hex(encode(input))).toBe(GOLDEN);
        expect(calls).toBe(0);
    });

    it('accepts null-prototype records and nonenumerable own values', () => {
        const input = fixture();
        Object.defineProperty(input, 'field14', { value: 1, enumerable: false });
        expect(hex(encode(input))).toBe(GOLDEN);
        expect(hex(encode(Object.assign(Object.create(null) as Input, fixture())))).toBe(GOLDEN);
    });

    it('rejects missing/unknown fields, accessors and proxies without evaluating them', () => {
        let calls = 0;

        const hostile = () => {
            calls++;
            throw new Error('record hook ran');
        };

        const accessor = fixture();
        Object.defineProperty(accessor, 'field14', { get: hostile });
        const proxy = new Proxy(fixture(), {
            ownKeys: hostile,
            get: hostile,
            getPrototypeOf: hostile,
        });
        rejected(accessor);
        rejected(proxy);
        const missing: Partial<Input> = fixture();
        delete missing.field16;
        rejected(missing);

        for (const extra of ['arg8', 'field80', 'field1c', 'mode', 'randomSource']) {
            rejected({ ...fixture(), [extra]: 0 });
        }

        rejected({ ...fixture(), [Symbol('extra')]: 0 });
        rejected(Object.create(fixture()));
        expect(calls).toBe(0);
    });

    it('validates numeric fields without coercion', () => {
        for (const field of ['field14', 'field15', 'field16'] as const) {
            for (const value of [-1, 256, 1.5, NaN, Infinity, '1', null, 1n, {}]) {
                rejected({ ...fixture(), [field]: value });
            }
        }

        for (const field of ['field08', 'field0c', 'field10'] as const) {
            for (const value of [-1, 0x100000000, 1.5, NaN, Infinity, '1', null, 1n]) {
                rejected({ ...fixture(), [field]: value });
            }
        }
    });

    it.each([0, 8, 10, 12])('requires exactly nine global-prefix bytes, not %i', (length) => {
        rejected({ ...fixture(), globalPrefix9: new Uint8Array(length) });
    });

    it('rejects invalid, shared, detached and out-of-bounds byte views', () => {
        const detached = new Uint8Array(9);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const resizable = new ArrayBuffer(9, { maxByteLength: 16 });
        const outOfBounds = new Uint8Array(resizable, 0, 9);
        resizable.resize(8);
        const invalid: unknown[] = [
            null,
            {},
            [],
            'bytes',
            new Uint16Array(9),
            new DataView(new ArrayBuffer(9)),
            new Uint8Array(new SharedArrayBuffer(9)),
            detached,
            outOfBounds,
            new Proxy(new Uint8Array(9), {}),
        ];

        for (const value of invalid) {
            rejected({ ...fixture(), globalPrefix9: value });
            rejected({ ...fixture(), field20: value });
        }
    });
});
