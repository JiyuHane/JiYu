import { createCipheriv } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NTLoginForwardRequest } from '@snowluma/proto-defs/direct-login';
import { protobuf_encode } from '@snowluma/proton';
import { decodeLinuxNTLoginReferenceResponseWithTips } from '../../src/direct/nt-linux-login-response-reference';

// Capture the genuine update result, not a copy. These observations are made
// before the decoder's finally block clears its reachable byte buffers.
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

                    // In particular, setAuthTag and final remain the genuine
                    // methods, bound to the genuine decipher instance.
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

function fixture(plainHex: string, corruptTag = false) {
    const plain = keep(Buffer.from(plainHex, 'hex'));
    const sessionKey = keep(Uint8Array.from({ length: 16 }, (_, index) => 0x40 + index));
    const nonce = keep(Buffer.from('000102030405060708090a0b', 'hex'));
    const cipher = createCipheriv('aes-128-gcm', sessionKey, nonce);
    const ciphertext = keep(cipher.update(plain));
    const tail = keep(cipher.final());
    const tag = keep(cipher.getAuthTag());

    if (corruptTag) {
        tag[tag.length - 1] ^= 1;
    }

    const encrypted = keep(Buffer.concat([nonce, ciphertext, tail, tag]));
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

describe('Linux opt-in tips response decipher update wiping (synthetic only)', () => {
    it('wipes the real update output when GCM final rejects the modified tag', () => {
        const input = fixture('0a0a220808011201411a01421202aabb', true);
        const error = caught(() =>
            decodeLinuxNTLoginReferenceResponseWithTips({
                forward: input.forward,
                sessionKey: input.sessionKey,
            }),
        );
        expect(error.message).toBe('invalid reference authentication');
        expect(error.message).not.toContain('A');
        expect(error.message).not.toContain('B');
        expectWipedUpdate();
        expectCallerUnchanged(input);
    });

    it('wipes the real update output after authenticated invalid UTF-8 content', () => {
        // Title is A, while content is the invalid standalone byte ff.
        const input = fixture('0a0822061201411a01ff1202aabb');
        const error = caught(() =>
            decodeLinuxNTLoginReferenceResponseWithTips({
                forward: input.forward,
                sessionKey: input.sessionKey,
            }),
        );
        expect(error.message).toBe('invalid reference response');
        expect(error.message).not.toContain('A');
        expect(error.message).not.toContain('\uFFFD');
        expectWipedUpdate();
        expectCallerUnchanged(input);
    });

    it('returns tips and an independent body after wiping the real update output', () => {
        const input = fixture('0a0a220808011201411a01421202aabb');
        const result = decodeLinuxNTLoginReferenceResponseWithTips({
            forward: input.forward,
            sessionKey: input.sessionKey,
        });

        if (result.body) {
            keep(result.body);
        }

        expect(result.status).toEqual({ kind: 'code', code: 1n, codePresent: true });
        expect(result.tips).toEqual({ title: 'A', content: 'B' });
        expect(result.body).toEqual(Uint8Array.of(0xaa, 0xbb));
        expectWipedUpdate();
        expect(result.body).not.toBeNull();
        expect(result.body!.buffer).not.toBe(capture.updates[0].buffer);
        expect(result.body).toEqual(Uint8Array.of(0xaa, 0xbb));
        expectCallerUnchanged(input);
    });
});
