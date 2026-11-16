import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { NTLoginForwardRequest } from '@snowluma/proto-defs/direct-login';
import { protobuf_encode } from '@snowluma/proton';
import { decodeLinuxNTLoginReferenceResponse } from '../../src/direct/nt-linux-login-response-reference';

// Synthetic bytes only. These fixtures exercise the response projection, rather
// than reproducing the decoder or depending on a live client or transport.
// Reference: LagrangeV2 NTLogin.cs, lines 76, 167, 538 (7011cdf87368cc0fb77273c1508e779a52328165).
const nonce = Buffer.from('000102030405060708090a0b', 'hex');
const key = Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i);
const hex = (value: string) => Buffer.from(value, 'hex');
const bytes = (...parts: Uint8Array[]) => Buffer.concat(parts);

function seal(plain: Uint8Array, secret: Uint8Array = key, aad?: Uint8Array): Buffer {
    const cipher = createCipheriv(`aes-${secret.byteLength * 8}-gcm`, secret, nonce);

    if (aad !== undefined) {
        cipher.setAAD(aad);
    }

    return bytes(nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag());
}

// Proton's build transform must execute here, using the existing request schema
// only as an encoder for the equivalent outer field-3 wire envelope.
function envelope(buffer: Uint8Array, ticket = Uint8Array.of(0x41), type = 1): Uint8Array {
    return protobuf_encode<NTLoginForwardRequest>({ sessionTicket: ticket, buffer, type });
}

function input(plain: Uint8Array, secret: Uint8Array = key) {
    return { forward: envelope(seal(plain, secret)), sessionKey: secret };
}

function decodeHex(plain: string) {
    return decodeLinuxNTLoginReferenceResponse(input(hex(plain)));
}

// Only lengths and field framing are assembled here; inner semantic fixtures
// remain literal reference-projection wire bytes.
function varint(value: number): Buffer {
    const out: number[] = [];

    do {
        const part = value % 128;
        value = Math.floor(value / 128);
        out.push(part | (value ? 128 : 0));
    } while (value);

    return Buffer.from(out);
}

function field(tag: number, value: Uint8Array): Buffer {
    return bytes(varint(tag * 8 + 2), varint(value.length), value);
}

function expectInvalidPlain(plain: string | Uint8Array): void {
    const value = typeof plain === 'string' ? hex(plain) : plain;
    expect(() => decodeLinuxNTLoginReferenceResponse(input(value))).toThrow();
}

describe('Linux NT login reference response (synthetic only)', () => {
    it.each([
        ['', { status: { kind: 'missing-head' }, body: null }],
        ['1200', { status: { kind: 'missing-head' }, body: new Uint8Array() }],
        ['0a00', { status: { kind: 'missing-error-info' }, body: null }],
        ['0a022200', { status: { kind: 'code', code: 0n, codePresent: false }, body: null }],
        ['0a0422020800', { status: { kind: 'code', code: 0n, codePresent: true }, body: null }],
        ['0a0422020801', { status: { kind: 'code', code: 1n, codePresent: true }, body: null }],
        [
            '0a0b2209088180808080808010',
            { status: { kind: 'code', code: 9007199254740993n, codePresent: true }, body: null },
        ],
        [
            '0a0d220b08ffffffffffffffffff01',
            {
                status: { kind: 'code', code: 18446744073709551615n, codePresent: true },
                body: null,
            },
        ],
        [
            '0a04220208011204ff00c328',
            {
                status: { kind: 'code', code: 1n, codePresent: true },
                body: Uint8Array.of(0xff, 0, 0xc3, 0x28),
            },
        ],
    ])('projects independent Common fixture %s', (wire, expected) => {
        expect(decodeHex(wire)).toEqual(expected);
    });

    it('permits opaque unknown Common, head, user and error fields, including repeated error field 7', () => {
        const error = bytes(hex('0801'), field(7, hex('ff00')), field(7, hex('c328')), hex('4001'));
        const head = bytes(field(1, hex('ff00')), field(4, error), field(6, hex('ffff')));
        const common = bytes(field(1, head), field(2, hex('ff00c328')), field(8, hex('dead')));
        expect(decodeLinuxNTLoginReferenceResponse(input(common))).toEqual({
            status: { kind: 'code', code: 1n, codePresent: true },
            body: Uint8Array.of(0xff, 0, 0xc3, 0x28),
        });
    });

    it('does not treat inherited numeric keys as selected wire fields', () => {
        const previous = Object.getOwnPropertyDescriptor(Object.prototype, '7');
        const error = bytes(hex('0801'), field(7, hex('ff')), field(7, hex('ee')));
        const fixture = input(field(1, field(4, error)));
        let result: ReturnType<typeof decodeLinuxNTLoginReferenceResponse>;

        try {
            Object.defineProperty(Object.prototype, '7', {
                value: 0,
                writable: true,
                configurable: true,
            });
            result = decodeLinuxNTLoginReferenceResponse(fixture);
        } finally {
            if (previous) {
                Object.defineProperty(Object.prototype, '7', previous);
            } else {
                Reflect.deleteProperty(Object.prototype, '7');
            }
        }

        expect(result).toEqual({
            status: { kind: 'code', code: 1n, codePresent: true },
            body: null,
        });
    });

    it.each([16, 24, 32])('accepts a %i-byte AES-GCM key without AAD', (length) => {
        const secret = Uint8Array.from({ length }, (_, i) => i + 1);
        expect(decodeLinuxNTLoginReferenceResponse(input(hex('0a0422020801'), secret))).toEqual({
            status: { kind: 'code', code: 1n, codePresent: true },
            body: null,
        });
    });

    it('treats outer ticket and type as unauthenticated metadata rather than identity', () => {
        const encrypted = seal(hex('0a0422020801'));
        const first = decodeLinuxNTLoginReferenceResponse({
            forward: envelope(encrypted, hex('0102'), 1),
            sessionKey: key,
        });
        const changed = decodeLinuxNTLoginReferenceResponse({
            forward: envelope(encrypted, hex('aabbcc'), 9),
            sessionKey: key,
        });
        expect(changed).toEqual(first);
        expect(first).toEqual({
            status: { kind: 'code', code: 1n, codePresent: true },
            body: null,
        });
    });

    it('rejects mutations of nonce, ciphertext, tag and key with the same non-sensitive authentication error', () => {
        const original = seal(hex('0a0422020801'));
        const errors: string[] = [];

        for (const position of [0, 12, original.length - 1]) {
            const changed = Buffer.from(original);
            changed[position] ^= 1;

            try {
                decodeLinuxNTLoginReferenceResponse({
                    forward: envelope(changed),
                    sessionKey: key,
                });
                throw new Error('unexpected success');
            } catch (error) {
                errors.push((error as Error).message);
            }
        }

        const changedKey = Uint8Array.from(key);
        changedKey[0] ^= 1;

        try {
            decodeLinuxNTLoginReferenceResponse({
                forward: envelope(original),
                sessionKey: changedKey,
            });
            throw new Error('unexpected success');
        } catch (error) {
            errors.push((error as Error).message);
        }

        expect(errors).toEqual(Array(4).fill('invalid reference authentication'));

        for (const message of errors) {
            expect(message).not.toContain(Buffer.from(key).toString('hex'));
            expect(message).not.toContain(original.toString('hex'));
        }

        expect(decodeLinuxNTLoginReferenceResponse(input(hex('0a00')))).toEqual({
            status: { kind: 'missing-error-info' },
            body: null,
        });
    });

    it('rejects all envelopes shorter than nonce plus tag and ciphertext sealed with AAD', () => {
        for (let size = 0; size < 28; size++) {
            expect(() =>
                decodeLinuxNTLoginReferenceResponse({
                    forward: envelope(new Uint8Array(size)),
                    sessionKey: key,
                }),
            ).toThrow();
        }

        expect(() =>
            decodeLinuxNTLoginReferenceResponse({
                forward: envelope(seal(hex('0a00'), key, hex('010203'))),
                sessionKey: key,
            }),
        ).toThrow('invalid reference authentication');
        expect(decodeLinuxNTLoginReferenceResponse(input(new Uint8Array()))).toEqual({
            status: { kind: 'missing-head' },
            body: null,
        });
    });

    it('rejects absent, duplicated and wrong-wire outer buffer fields', () => {
        const valid = field(3, seal(hex('0a00')));

        for (const forward of [
            new Uint8Array(),
            hex('1801'),
            bytes(valid, valid),
            bytes(valid, hex('1801')),
        ]) {
            expect(() =>
                decodeLinuxNTLoginReferenceResponse({ forward, sessionKey: key }),
            ).toThrow();
        }
    });

    it('applies the local duplicate, wire and uint32 rules to outer metadata', () => {
        const bufferOnly = field(3, seal(hex('0a00')));
        expect(
            decodeLinuxNTLoginReferenceResponse({ forward: bufferOnly, sessionKey: key }),
        ).toEqual({
            status: { kind: 'missing-error-info' },
            body: null,
        });

        for (const suffix of [
            '0a000a00', // duplicate ticket
            '0a000801', // ticket followed by its wrong wire type
            '2a002a00', // duplicate secBuffer
            '2a002801', // secBuffer followed by its wrong wire type
            '20012001', // duplicate type
            '20012200', // type followed by its wrong wire type
            '208080808010', // type exceeds uint32
        ]) {
            expect(() =>
                decodeLinuxNTLoginReferenceResponse({
                    forward: bytes(bufferOnly, hex(suffix)),
                    sessionKey: key,
                }),
            ).toThrow('invalid reference response');
        }
    });

    it.each([
        '0a000a00',
        '12001200',
        '0801',
        '1001',
        '0a0222000a00',
        '0a0422002200',
        '0a022001',
        '0a06220408010801',
        '0a0422020a00',
        '00',
        '03',
        '04',
        '0b',
        '0c',
        '0f',
        '0a',
        '0a01',
        '1201',
        '0a0122',
        '0a03220208',
        '0a0422020880',
        '0a0d220b08ffffffffffffffffffff02',
        '0a052203088000',
        '8a0000',
        '0a800000',
    ])('rejects malformed or ambiguous Common/head/error wire %s', (wire) => {
        expectInvalidPlain(wire);
    });

    it('rejects truncated nested projections at every byte, without consuming trailing data as nested data', () => {
        for (const wire of [
            '0a0422020801',
            '0a0d220b08ffffffffffffffffff01',
            '0a04220208011204ff00c328',
        ]) {
            const full = hex(wire);

            for (let end = 1; end < full.length; end++) {
                // Prefixes at a valid field boundary are legitimate independent protobuf messages.
                if (end === 6 && wire.endsWith('1204ff00c328')) {
                    continue;
                }

                expectInvalidPlain(full.subarray(0, end));
            }
        }
    });

    it('rejects malformed wire forms in the outer layer too', () => {
        for (const wire of [
            '00',
            '03',
            '04',
            '0b',
            '0c',
            '1f',
            '1a',
            '1a02ff',
            '1a800000',
            '9a0000',
            '80',
            'ffffffffffffffffffff02',
        ]) {
            expect(() =>
                decodeLinuxNTLoginReferenceResponse({ forward: hex(wire), sessionKey: key }),
            ).toThrow();
        }
    });

    it('respects the one MiB bound and rejects excessive framing work', () => {
        const valid = Buffer.from(envelope(seal(hex('0a00'))));
        // One unknown length-delimited field fills precisely the outer byte limit.
        const max = 1024 * 1024;
        const filler = new Uint8Array(max - valid.length - 4);
        const atLimit = bytes(valid, field(6, filler));
        expect(atLimit.length).toBe(max);
        expect(decodeLinuxNTLoginReferenceResponse({ forward: atLimit, sessionKey: key })).toEqual({
            status: { kind: 'missing-error-info' },
            body: null,
        });
        expect(() =>
            decodeLinuxNTLoginReferenceResponse({
                forward: bytes(atLimit, hex('3000')),
                sessionKey: key,
            }),
        ).toThrow();
        const manyFields = Buffer.from('3800'.repeat(100000), 'hex');
        expect(() =>
            decodeLinuxNTLoginReferenceResponse({
                forward: bytes(valid, manyFields),
                sessionKey: key,
            }),
        ).toThrow();
        expectInvalidPlain(bytes(hex('0a00'), manyFields));
        expectInvalidPlain(field(1, bytes(hex('2200'), manyFields)));
        expectInvalidPlain(field(1, field(4, manyFields)));
    });

    it('accepts 256 fields per frame and 1024 fields across all four frames, but rejects 257 in each', () => {
        const unknown = (count: number) => Buffer.from('3800'.repeat(count), 'hex');
        const error = unknown(256);
        const head = bytes(field(4, error), unknown(255));
        const common = bytes(field(1, head), unknown(255));
        const forward = bytes(field(3, seal(common)), unknown(255));
        expect(decodeLinuxNTLoginReferenceResponse({ forward, sessionKey: key })).toEqual({
            status: { kind: 'code', code: 0n, codePresent: false },
            body: null,
        });
        const outerTooMany = bytes(field(3, seal(hex('0a00'))), unknown(256));
        expect(() =>
            decodeLinuxNTLoginReferenceResponse({ forward: outerTooMany, sessionKey: key }),
        ).toThrow();
        expectInvalidPlain(bytes(hex('0a00'), unknown(256)));
        expectInvalidPlain(field(1, bytes(hex('2200'), unknown(256))));
        expectInvalidPlain(field(1, field(4, unknown(257))));
        // Across these four frames, 1025 fields necessarily exceed one frame's cap.
        const overTotal = bytes(field(3, seal(bytes(field(1, head), unknown(256)))), unknown(255));
        expect(() =>
            decodeLinuxNTLoginReferenceResponse({ forward: overTotal, sessionKey: key }),
        ).toThrow();
    });

    it('keeps caller buffers unchanged and returns an independently owned body', () => {
        const raw = Buffer.from(envelope(seal(hex('0a04220208011204ff00c328'))));
        const backing = Buffer.concat([hex('abcd'), raw, hex('ef')]);
        const forward = backing.subarray(2, backing.length - 1);
        const keyBacking = Buffer.concat([hex('aa'), Buffer.from(key), hex('bb')]);
        const sessionKey = keyBacking.subarray(1, 17);
        const beforeForward = Buffer.from(backing);
        const beforeKey = Buffer.from(keyBacking);
        const first = decodeLinuxNTLoginReferenceResponse({ forward, sessionKey });
        const second = decodeLinuxNTLoginReferenceResponse({ forward, sessionKey });
        expect(backing).toEqual(beforeForward);
        expect(keyBacking).toEqual(beforeKey);
        expect(first.body).toEqual(Uint8Array.of(0xff, 0, 0xc3, 0x28));
        first.body![0] = 0x77;
        expect(second.body).toEqual(Uint8Array.of(0xff, 0, 0xc3, 0x28));
        backing.fill(0);
        keyBacking.fill(0);
        expect(second.body).toEqual(Uint8Array.of(0xff, 0, 0xc3, 0x28));
    });

    it('leaves inputs unchanged on failures and uses a fixed structural error', () => {
        const valid = input(hex('0a00'));

        for (const length of [0, 15, 17, 31, 33]) {
            const secret = new Uint8Array(length).fill(0xa7);
            const beforeForward = Uint8Array.from(valid.forward);
            const beforeKey = Uint8Array.from(secret);
            expect(() =>
                decodeLinuxNTLoginReferenceResponse({ forward: valid.forward, sessionKey: secret }),
            ).toThrow('invalid reference response');
            expect(valid.forward).toEqual(beforeForward);
            expect(secret).toEqual(beforeKey);
        }

        const bad = input(hex('0a0422020880'));
        const beforeForward = Uint8Array.from(bad.forward);
        const beforeKey = Uint8Array.from(bad.sessionKey);
        expect(() => decodeLinuxNTLoginReferenceResponse(bad)).toThrow(
            'invalid reference response',
        );
        expect(bad.forward).toEqual(beforeForward);
        expect(bad.sessionKey).toEqual(beforeKey);
        expect(decodeLinuxNTLoginReferenceResponse(valid)).toEqual({
            status: { kind: 'missing-error-info' },
            body: null,
        });
    });

    it('rejects proxies, accessors, shared, resizable and detached byte stores without invoking getters', () => {
        const good = input(hex('0a00'));
        let getterCalls = 0;
        const accessor = Object.defineProperty({ sessionKey: key }, 'forward', {
            enumerable: true,
            get() {
                getterCalls++;
                return good.forward;
            },
        });
        const shared = new Uint8Array(new SharedArrayBuffer(good.forward.length));
        const resizable = new Uint8Array(
            new ArrayBuffer(good.forward.length, { maxByteLength: good.forward.length + 1 }),
        );
        const detached = new Uint8Array(good.forward);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const invalid: unknown[] = [
            new Proxy(good, {}),
            accessor,
            { forward: new Proxy(good.forward, {}), sessionKey: key },
            { forward: shared, sessionKey: key },
            { forward: resizable, sessionKey: key },
            { forward: detached, sessionKey: key },
            { forward: good.forward, sessionKey: new Uint8Array(new SharedArrayBuffer(16)) },
            { forward: good.forward, sessionKey: new Proxy(key, {}) },
        ];

        for (const candidate of invalid) {
            expect(() => decodeLinuxNTLoginReferenceResponse(candidate as typeof good)).toThrow();
        }

        expect(getterCalls).toBe(0);
        expect(decodeLinuxNTLoginReferenceResponse(good)).toEqual({
            status: { kind: 'missing-error-info' },
            body: null,
        });
    });
});
