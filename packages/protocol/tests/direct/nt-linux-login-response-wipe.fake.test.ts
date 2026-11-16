import { createCipheriv } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NTLoginForwardRequest } from '@snowluma/proto-defs/direct-login';
import { protobuf_encode } from '@snowluma/proton';
import { decodeLinuxNTLoginReferenceResponse } from '../../src/direct/nt-linux-login-response-reference';

// Vitest hoists the mock factory; the stored values are actual update buffers,
// not copies. The observations are made before the decoder's finally block.
const capture = vi.hoisted(() => ({
    updates: [] as Buffer[],
    hadNonzero: [] as boolean[],
    matchedPlain: [] as boolean[],
    expectedPlain: null as Uint8Array | null,
}));

vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();

    return {
        ...actual,
        createDecipheriv(...args: Parameters<typeof actual.createDecipheriv>) {
            const decipher = actual.createDecipheriv(...args);
            return new Proxy(decipher, {
                get(target, property) {
                    const value = Reflect.get(target, property, target);

                    if (property === 'update' && typeof value === 'function') {
                        return (...updateArgs: unknown[]) => {
                            const result: unknown = Reflect.apply(value, target, updateArgs);

                            if (!Buffer.isBuffer(result)) {
                                throw new Error('Expected a Buffer from decipher.update');
                            }

                            capture.updates.push(result);
                            capture.hadNonzero.push(result.some((byte) => byte !== 0));
                            const expected = capture.expectedPlain;
                            capture.matchedPlain.push(
                                expected !== null &&
                                    result.length === expected.length &&
                                    result.every((byte, index) => byte === expected[index]),
                            );
                            return result;
                        };
                    }

                    // setAuthTag and final are the genuine methods bound to the
                    // genuine decipher; neither their implementation nor inputs change.
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        },
    };
});

const cleanup: Uint8Array[] = [];

function keep<T extends Uint8Array>(value: T): T {
    cleanup.push(value);
    return value;
}

function fixture(plainBytes: number[], corruptTag = false) {
    const plain = keep(Uint8Array.from(plainBytes));
    const sessionKey = keep(Uint8Array.from({ length: 16 }, (_, index) => 0x30 + index));
    const nonce = keep(Buffer.from('000102030405060708090a0b', 'hex'));
    const cipher = createCipheriv('aes-128-gcm', sessionKey, nonce);
    const ciphertext = keep(cipher.update(plain));
    const tail = keep(cipher.final());
    const tag = keep(cipher.getAuthTag());

    if (corruptTag) {
        tag[tag.length - 1] ^= 1;
    }

    const encrypted = keep(Buffer.concat([nonce, ciphertext, tail, tag]));
    // The production Proton transform generates the field-3 envelope encoder.
    const forward = keep(protobuf_encode<NTLoginForwardRequest>({ buffer: encrypted }));
    const forwardBefore = keep(Uint8Array.from(forward));
    const keyBefore = keep(Uint8Array.from(sessionKey));
    capture.expectedPlain = plain;
    return { forward, sessionKey, forwardBefore, keyBefore };
}

function expectWipedUpdate(): void {
    expect(capture.updates).toHaveLength(1);
    expect(capture.updates[0].length).toBeGreaterThan(0);
    expect(capture.hadNonzero).toEqual([true]);
    expect(capture.matchedPlain).toEqual([true]);

    for (const update of capture.updates) {
        expect(update.every((byte) => byte === 0)).toBe(true);
    }
}

function expectCallerUnchanged(input: ReturnType<typeof fixture>): void {
    expect(input.forward).toEqual(input.forwardBefore);
    expect(input.sessionKey).toEqual(input.keyBefore);
}

beforeEach(async () => {
    capture.updates.length = 0;
    capture.hadNonzero.length = 0;
    capture.matchedPlain.length = 0;
    capture.expectedPlain = null;
    cleanup.length = 0;
    const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
    expect(createCipheriv).toBe(actual.createCipheriv);
});

afterEach(() => {
    for (const update of capture.updates) {
        update.fill(0);
    }

    for (const value of cleanup) {
        value.fill(0);
    }

    capture.updates.length = 0;
    capture.hadNonzero.length = 0;
    capture.matchedPlain.length = 0;
    capture.expectedPlain = null;
    cleanup.length = 0;
});

describe('Linux reference response decipher update wiping (synthetic only)', () => {
    it('wipes real update output after authentication failure', () => {
        const input = fixture(
            [0x0a, 0x04, 0x22, 0x02, 0x08, 0x01, 0x12, 0x04, 0xff, 0x00, 0xc3, 0x28],
            true,
        );
        expect(() =>
            decodeLinuxNTLoginReferenceResponse({
                forward: input.forward,
                sessionKey: input.sessionKey,
            }),
        ).toThrowError(/^invalid reference authentication$/);
        expectWipedUpdate();
        expectCallerUnchanged(input);
    });

    it('wipes real update output after authenticated truncated Common framing', () => {
        // Field 2 declares five bytes, but only two payload bytes follow.
        const input = fixture([0x12, 0x05, 0xde, 0xad]);
        expect(() =>
            decodeLinuxNTLoginReferenceResponse({
                forward: input.forward,
                sessionKey: input.sessionKey,
            }),
        ).toThrowError(/^invalid reference response$/);
        expectWipedUpdate();
        expectCallerUnchanged(input);
    });

    it('returns an independent body after wiping real update output', () => {
        const input = fixture([
            0x0a, 0x04, 0x22, 0x02, 0x08, 0x01, 0x12, 0x04, 0xff, 0x00, 0xc3, 0x28,
        ]);
        const result = decodeLinuxNTLoginReferenceResponse({
            forward: input.forward,
            sessionKey: input.sessionKey,
        });

        if (result.body) {
            keep(result.body);
        }

        expect(result.status).toEqual({ kind: 'code', code: 1n, codePresent: true });
        expect(result.body).toEqual(Uint8Array.of(0xff, 0x00, 0xc3, 0x28));
        expectWipedUpdate();
        expect(result.body).not.toBeNull();
        expect(result.body!.buffer).not.toBe(capture.updates[0].buffer);
        result.body![0] = 0x7e;
        expect(capture.updates[0].every((byte) => byte === 0)).toBe(true);
        expectCallerUnchanged(input);
    });
});
