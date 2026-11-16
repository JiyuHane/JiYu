import { createCipheriv } from 'node:crypto';
import type { NTLoginForwardRequest } from '@snowluma/proto-defs/direct-login';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';
import {
    decodeLinuxNTLoginReferenceResponse,
    decodeLinuxNTLoginReferenceResponseWithTips,
} from '../../src/direct/nt-linux-login-response-reference';

// Synthetic bytes only: no account, service, transport or real client is involved.
// Inner fixtures are independently authored wire bytes; Proton builds the outer
// envelope and the actual response decoder owns all decryption and projection.
const nonce = Buffer.from('000102030405060708090a0b', 'hex');
const key = Uint8Array.from({ length: 16 }, (_, index) => 0x40 + index);
const hex = (value: string): Buffer => Buffer.from(value, 'hex');
const bytes = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);

function varint(value: number): Buffer {
    const result: number[] = [];

    do {
        const low = value % 128;
        value = Math.floor(value / 128);
        result.push(low | (value ? 0x80 : 0));
    } while (value);

    return Buffer.from(result);
}

// This helper frames opaque test payloads only; it does not implement decoding.
function field(number: number, value: Uint8Array): Buffer {
    return bytes(varint(number * 8 + 2), varint(value.length), value);
}

function commonWithError(error: Uint8Array, body?: Uint8Array): Buffer {
    const head = field(4, error);
    return body === undefined ? field(1, head) : bytes(field(1, head), field(2, body));
}

function seal(plain: Uint8Array, secret: Uint8Array = key): Buffer {
    const cipher = createCipheriv(`aes-${secret.byteLength * 8}-gcm`, secret, nonce);
    return bytes(nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag());
}

// The existing Proton transform compiles this real schema at the call site.
function envelope(encrypted: Uint8Array): Uint8Array {
    return protobuf_encode<NTLoginForwardRequest>({
        sessionTicket: Uint8Array.of(0x42),
        buffer: encrypted,
        type: 1,
    });
}

function input(plain: Uint8Array, secret: Uint8Array = key) {
    return { forward: envelope(seal(plain, secret)), sessionKey: secret };
}

function caught(action: () => unknown): Error {
    let thrown: unknown;

    try {
        action();
    } catch (error) {
        thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    return thrown as Error;
}

function expectInvalidPlain(plain: Uint8Array): void {
    const fixture = input(plain);
    const plainBefore = Uint8Array.from(plain);
    const forwardBefore = Uint8Array.from(fixture.forward);
    const keyBefore = Uint8Array.from(fixture.sessionKey);
    const error = caught(() => decodeLinuxNTLoginReferenceResponseWithTips(fixture));
    expect(error.message).toBe('invalid reference response');
    expect(Uint8Array.from(plain)).toEqual(plainBefore);
    expect(Uint8Array.from(fixture.forward)).toEqual(forwardBefore);
    expect(Uint8Array.from(fixture.sessionKey)).toEqual(keyBefore);
}

describe('Linux NT login tips reference response (synthetic offline fixtures)', () => {
    it('independently checks every supplied literal frame length', () => {
        const vectors: Array<[string, Uint8Array]> = [
            ['', bytes()],
            ['0a00', field(1, bytes())],
            ['0a022200', commonWithError(bytes())],
            ['0a0422021200', commonWithError(field(2, bytes()))],
            ['0a0422021a00', commonWithError(field(3, bytes()))],
            [
                '0a0a220808011201411a01421202aabb',
                commonWithError(
                    bytes(hex('0801'), field(2, hex('41')), field(3, hex('42'))),
                    hex('aabb'),
                ),
            ],
            [
                '0a0a220808011204efbbbf41',
                commonWithError(bytes(hex('0801'), field(2, hex('efbbbf41')))),
            ],
            ['0a0522031201ff', commonWithError(field(2, hex('ff')))],
            ['0a0422021000', commonWithError(hex('1000'))],
            [
                '0a082206120141120142',
                commonWithError(bytes(field(2, hex('41')), field(2, hex('42')))),
            ],
            // The title length itself is deliberately nonminimal; enclosing lengths are correct.
            ['0a052203128000', commonWithError(hex('128000'))],
            [
                '0a0d220b08fba1e2421201411a014212061a041202aabb',
                commonWithError(
                    bytes(hex('08fba1e242'), field(2, hex('41')), field(3, hex('42'))),
                    hex('1a041202aabb'),
                ),
            ],
        ];

        for (const [literal, assembled] of vectors) {
            expect(assembled).toEqual(hex(literal));
        }
    });

    it.each([
        {
            name: 'missing head',
            wire: '',
            status: { kind: 'missing-head' },
            body: null,
            tips: null,
        },
        {
            name: 'missing head with present-empty body',
            wire: '1200',
            status: { kind: 'missing-head' },
            body: new Uint8Array(),
            tips: null,
        },
        {
            name: 'missing error info',
            wire: '0a00',
            status: { kind: 'missing-error-info' },
            body: null,
            tips: null,
        },
        {
            name: 'present-empty error info',
            wire: '0a022200',
            status: { kind: 'code', code: 0n, codePresent: false },
            body: null,
            tips: { title: null, content: null },
        },
        {
            name: 'explicit zero code',
            wire: '0a0422020800',
            status: { kind: 'code', code: 0n, codePresent: true },
            body: null,
            tips: { title: null, content: null },
        },
        {
            name: 'present-empty title',
            wire: '0a0422021200',
            status: { kind: 'code', code: 0n, codePresent: false },
            body: null,
            tips: { title: '', content: null },
        },
        {
            name: 'present-empty content',
            wire: '0a0422021a00',
            status: { kind: 'code', code: 0n, codePresent: false },
            body: null,
            tips: { title: null, content: '' },
        },
        {
            name: 'both texts with code and opaque body',
            wire: '0a0a220808011201411a01421202aabb',
            status: { kind: 'code', code: 1n, codePresent: true },
            body: Uint8Array.of(0xaa, 0xbb),
            tips: { title: 'A', content: 'B' },
        },
        {
            name: 'UTF-8 BOM is retained',
            wire: '0a0a220808011204efbbbf41',
            status: { kind: 'code', code: 1n, codePresent: true },
            body: null,
            tips: { title: '\uFEFFA', content: null },
        },
        {
            name: 'code 140022011 and opaque signature-shaped body',
            wire: '0a0d220b08fba1e2421201411a014212061a041202aabb',
            status: { kind: 'code', code: 140022011n, codePresent: true },
            body: Uint8Array.of(0x1a, 0x04, 0x12, 0x02, 0xaa, 0xbb),
            tips: { title: 'A', content: 'B' },
        },
    ])('projects $name without changing the old result', ({ wire, status, body, tips }) => {
        const plain = hex(wire);
        const fixture = input(plain);
        expect(decodeLinuxNTLoginReferenceResponseWithTips(fixture)).toEqual({
            status,
            body,
            tips,
        });
        expect(decodeLinuxNTLoginReferenceResponse(fixture)).toEqual({ status, body });
        expect(plain).toEqual(hex(wire));
    });

    it('preserves Unicode, leading and embedded BOMs, NULs and U+FFFD in both fields', () => {
        const title = '\uFEFF题\0🧪\uFEFF';
        const content = '\uFEFF正文\uFFFD\0结束';
        const plain = commonWithError(
            bytes(
                hex('0801'),
                field(2, Buffer.from(title, 'utf8')),
                field(3, Buffer.from(content, 'utf8')),
            ),
        );
        expect(decodeLinuxNTLoginReferenceResponseWithTips(input(plain))).toEqual({
            status: { kind: 'code', code: 1n, codePresent: true },
            body: null,
            tips: { title, content },
        });
    });

    it('accepts repeated unknown fields at outer, Common, Head and ErrorInfo levels', () => {
        // Repeated field 7 uses different valid wire types; its bytes are opaque.
        const unknown = bytes(
            hex('3801'),
            hex('390102030405060708'),
            field(7, hex('ff00c328')),
            hex('3d01020304'),
        );
        const error = bytes(hex('0801'), field(2, hex('41')), field(3, hex('42')), unknown);
        const head = bytes(field(4, error), unknown);
        const common = bytes(field(1, head), field(2, hex('ff00')), unknown);
        const fixture = { forward: bytes(envelope(seal(common)), unknown), sessionKey: key };
        expect(decodeLinuxNTLoginReferenceResponseWithTips(fixture)).toEqual({
            status: { kind: 'code', code: 1n, codePresent: true },
            body: Uint8Array.of(0xff, 0x00),
            tips: { title: 'A', content: 'B' },
        });
        expect(decodeLinuxNTLoginReferenceResponse(fixture)).toEqual({
            status: { kind: 'code', code: 1n, codePresent: true },
            body: Uint8Array.of(0xff, 0x00),
        });
    });

    it('rejects duplicate and wrong-wire tips while the old API ignores them', () => {
        for (const number of [2, 3]) {
            const first = field(number, Buffer.from('first'));
            const second = field(number, Buffer.from('second'));
            const wrongVarint = bytes(varint(number * 8), hex('01'));
            const wrongFixed64 = bytes(varint(number * 8 + 1), hex('0102030405060708'));
            const wrongFixed32 = bytes(varint(number * 8 + 5), hex('01020304'));

            for (const bad of [
                bytes(first, second),
                wrongVarint,
                wrongFixed64,
                wrongFixed32,
                bytes(first, wrongVarint),
                bytes(wrongVarint, first),
            ]) {
                const plain = commonWithError(bytes(hex('0801'), bad), hex('aabb'));
                expectInvalidPlain(plain);
                expect(decodeLinuxNTLoginReferenceResponse(input(plain))).toEqual({
                    status: { kind: 'code', code: 1n, codePresent: true },
                    body: Uint8Array.of(0xaa, 0xbb),
                });
            }
        }

        expectInvalidPlain(hex('0a0422021000'));
        expectInvalidPlain(hex('0a082206120141120142'));
    });

    it('keeps duplicate and wrong-wire rules for Common, Head and code fields', () => {
        const error = commonWithError(hex('0801'));
        const errorField = field(4, hex('0801'));
        const cases = [
            bytes(error, field(1, bytes())),
            bytes(error, hex('0801')),
            hex('0801'),
            bytes(error, field(2, bytes()), field(2, bytes())),
            bytes(error, hex('1001')),
            field(1, bytes(errorField, errorField)),
            field(1, bytes(errorField, hex('2001'))),
            field(1, hex('2001')),
            commonWithError(hex('08010801')),
            commonWithError(hex('0a00')),
        ];

        for (const plain of cases) {
            expectInvalidPlain(plain);
            expect(() => decodeLinuxNTLoginReferenceResponse(input(plain))).toThrow(
                'invalid reference response',
            );
        }
    });

    it('requires canonical field lengths and rejects truncated selected values', () => {
        for (const plain of [
            hex('0a052203128000'), // title length zero encoded in two bytes
            commonWithError(hex('1a8000')), // content length zero encoded in two bytes
            commonWithError(hex('1202ff')), // title extends beyond ErrorInfo
            commonWithError(hex('1a0241')), // content extends beyond ErrorInfo
        ]) {
            expectInvalidPlain(plain);
        }
    });

    it('requires fatal UTF-8 in both text fields while the old API ignores them', () => {
        const malformed = [
            hex('ff'), // illegal leading byte
            hex('c328'), // missing continuation
            hex('c0af'), // overlong sequence
            hex('eda080'), // surrogate code point
            hex('f4908080'), // above U+10FFFF
            hex('e282'), // incomplete at end
        ];

        for (const number of [2, 3]) {
            for (const value of malformed) {
                const plain = commonWithError(bytes(hex('0801'), field(number, value)));
                expectInvalidPlain(plain);
                expect(decodeLinuxNTLoginReferenceResponse(input(plain))).toEqual({
                    status: { kind: 'code', code: 1n, codePresent: true },
                    body: null,
                });
            }
        }

        expectInvalidPlain(hex('0a0522031201ff'));
    });

    it.each([2, 3])(
        'enforces the 4096-byte local bound on text field %i',
        (number) => {
            const ascii = 'x'.repeat(4096);
            const unicode = 'é'.repeat(2048);
            expect(Buffer.byteLength(ascii)).toBe(4096);
            expect(Buffer.byteLength(unicode)).toBe(4096);

            for (const text of [ascii, unicode]) {
                const plain = commonWithError(
                    bytes(hex('0801'), field(number, Buffer.from(text, 'utf8'))),
                );
                const result = decodeLinuxNTLoginReferenceResponseWithTips(input(plain));
                expect(result.status).toEqual({ kind: 'code', code: 1n, codePresent: true });
                expect(result.body).toBeNull();
                expect(result.tips).toEqual(
                    number === 2 ? { title: text, content: null } : { title: null, content: text },
                );
            }

            for (const text of [ascii + 'x', unicode + 'x']) {
                expect(Buffer.byteLength(text)).toBe(4097);
                const plain = commonWithError(
                    bytes(hex('0801'), field(number, Buffer.from(text, 'utf8'))),
                );
                expectInvalidPlain(plain);
                expect(decodeLinuxNTLoginReferenceResponse(input(plain))).toEqual({
                    status: { kind: 'code', code: 1n, codePresent: true },
                    body: null,
                });
            }
        },
        20000,
    );

    it('applies the byte limit per field rather than to their combined length', () => {
        const title = 'a'.repeat(4096);
        const content = 'b'.repeat(4096);
        const plain = commonWithError(
            bytes(field(2, Buffer.from(title)), field(3, Buffer.from(content))),
        );
        expect(decodeLinuxNTLoginReferenceResponseWithTips(input(plain))).toEqual({
            status: { kind: 'code', code: 0n, codePresent: false },
            body: null,
            tips: { title, content },
        });
    }, 20000);

    it.each([16, 24, 32])('accepts a synthetic %i-byte AES-GCM key', (length) => {
        const secret = Uint8Array.from({ length }, (_, index) => index + 1);
        const plain = hex('0a0a220808011201411a01421202aabb');
        const before = Uint8Array.from(secret);
        expect(decodeLinuxNTLoginReferenceResponseWithTips(input(plain, secret))).toEqual({
            status: { kind: 'code', code: 1n, codePresent: true },
            body: Uint8Array.of(0xaa, 0xbb),
            tips: { title: 'A', content: 'B' },
        });
        expect(secret).toEqual(before);
    });

    it.each([16, 24, 32])('authenticates before observing tips with a %i-byte key', (length) => {
        const secret = Uint8Array.from({ length }, (_, index) => index + 0x21);
        const title = 'SYNTHETIC_TITLE_6f2d';
        const content = 'SYNTHETIC_CONTENT_8b17';
        const plain = commonWithError(
            bytes(hex('0801'), field(2, Buffer.from(title)), field(3, Buffer.from(content))),
            Buffer.from('SYNTHETIC_BODY_104c'),
        );
        const encrypted = seal(plain, secret);
        const encryptedBefore = Buffer.from(encrypted);
        const secretBefore = Uint8Array.from(secret);
        const valid = { forward: envelope(encrypted), sessionKey: secret };
        expect(decodeLinuxNTLoginReferenceResponseWithTips(valid).tips).toEqual({ title, content });

        const nonceChanged = Buffer.from(encrypted);
        nonceChanged[0] ^= 1;
        const ciphertextChanged = Buffer.from(encrypted);
        // GCM is length preserving: this changes the first plaintext tag from 0x0a
        // to 0x00. Structural parsing before successful authentication is visible.
        ciphertextChanged[12] ^= 0x0a;
        const tagChanged = Buffer.from(encrypted);
        tagChanged[tagChanged.length - 1] ^= 1;
        const wrongKey = Uint8Array.from(secret);
        wrongKey[0] ^= 1;
        const attempts = [
            { forward: envelope(nonceChanged), sessionKey: secret },
            { forward: envelope(ciphertextChanged), sessionKey: secret },
            { forward: envelope(tagChanged), sessionKey: secret },
            { forward: envelope(encrypted), sessionKey: wrongKey },
        ];

        for (const attempt of attempts) {
            const forwardBefore = Uint8Array.from(attempt.forward);
            const attemptKeyBefore = Uint8Array.from(attempt.sessionKey);
            const error = caught(() => decodeLinuxNTLoginReferenceResponseWithTips(attempt));
            expect(error.message).toBe('invalid reference authentication');
            const diagnostic = `${error.message}\n${error.stack ?? ''}\n${JSON.stringify(error)}`;

            for (const sensitive of [
                title,
                content,
                'SYNTHETIC_BODY_104c',
                Buffer.from(secret).toString('hex'),
                plain.toString('hex'),
                encrypted.toString('hex'),
            ]) {
                expect(diagnostic).not.toContain(sensitive);
            }

            expect(attempt.forward).toEqual(forwardBefore);
            expect(attempt.sessionKey).toEqual(attemptKeyBefore);
        }

        expect(encrypted).toEqual(encryptedBefore);
        expect(secret).toEqual(secretBefore);
        expect(decodeLinuxNTLoginReferenceResponseWithTips(valid).tips).toEqual({ title, content });
    });

    it('uses a non-sensitive structural error after authenticated malformed tips', () => {
        const title = 'SYNTHETIC_TITLE_9c25';
        const content = 'SYNTHETIC_CONTENT_4e71';
        const plain = commonWithError(
            bytes(
                field(2, Buffer.from(title)),
                field(3, Buffer.from(content)),
                field(2, hex('ff')),
            ),
        );
        const fixture = input(plain);
        const error = caught(() => decodeLinuxNTLoginReferenceResponseWithTips(fixture));
        expect(error.message).toBe('invalid reference response');
        const diagnostic = `${error.message}\n${error.stack ?? ''}\n${JSON.stringify(error)}`;

        for (const sensitive of [
            title,
            content,
            plain.toString('hex'),
            Buffer.from(key).toString('hex'),
        ]) {
            expect(diagnostic).not.toContain(sensitive);
        }
    });

    it('keeps input and plaintext unchanged and owns each output body independently', () => {
        const plain = hex('0a0a220808011201411a01421202aabb');
        const plainBefore = Buffer.from(plain);
        const raw = Buffer.from(envelope(seal(plain)));
        const forwardBacking = bytes(hex('f1f2'), raw, hex('f3'));
        const forward = forwardBacking.subarray(2, forwardBacking.length - 1);
        const keyBacking = bytes(hex('e1'), key, hex('e2'));
        const sessionKey = keyBacking.subarray(1, 17);
        const beforeForward = Buffer.from(forwardBacking);
        const beforeKey = Buffer.from(keyBacking);
        const first = decodeLinuxNTLoginReferenceResponseWithTips({ forward, sessionKey });
        const second = decodeLinuxNTLoginReferenceResponseWithTips({ forward, sessionKey });
        const old = decodeLinuxNTLoginReferenceResponse({ forward, sessionKey });
        expect(plain).toEqual(plainBefore);
        expect(forwardBacking).toEqual(beforeForward);
        expect(keyBacking).toEqual(beforeKey);
        expect(first.body).toEqual(Uint8Array.of(0xaa, 0xbb));
        expect(second.body).toEqual(first.body);
        expect(old.body).toEqual(first.body);
        expect(first.body).not.toBe(second.body);
        expect(first.tips).not.toBe(second.tips);
        first.body![0] = 0x77;
        expect(second.body).toEqual(Uint8Array.of(0xaa, 0xbb));
        expect(old.body).toEqual(Uint8Array.of(0xaa, 0xbb));
        expect(forwardBacking).toEqual(beforeForward);
        expect(keyBacking).toEqual(beforeKey);
        plain.fill(0);
        forwardBacking.fill(0);
        keyBacking.fill(0);
        expect(second.body).toEqual(Uint8Array.of(0xaa, 0xbb));
        expect(second.tips).toEqual({ title: 'A', content: 'B' });
    });

    it.each([31, 32, 33, 127, 128, 129])(
        'preserves BOM and Unicode across Proton string branches at %i bytes',
        (length) => {
            // BOM + multibyte code point + ASCII padding gives the exact byte length.
            const title = '\uFEFFé' + 'A'.repeat(length - 5);
            const content = '\uFEFF🧪' + 'B'.repeat(length - 7);
            expect(Buffer.byteLength(title, 'utf8')).toBe(length);
            expect(Buffer.byteLength(content, 'utf8')).toBe(length);
            const plain = commonWithError(
                bytes(hex('0801'), field(2, Buffer.from(title)), field(3, Buffer.from(content))),
                hex('00ffaabb'),
            );
            const fixture = input(plain);
            const withTips = decodeLinuxNTLoginReferenceResponseWithTips(fixture);
            const previous = decodeLinuxNTLoginReferenceResponse(fixture);
            expect(withTips).toEqual({
                status: { kind: 'code', code: 1n, codePresent: true },
                body: Uint8Array.of(0x00, 0xff, 0xaa, 0xbb),
                tips: { title, content },
            });
            expect(previous).toEqual({ status: withTips.status, body: withTips.body });
        },
    );
});
