import { createCipheriv } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptKeyExchangeBytes } from '../../src/direct/key-exchange';

// Retain the actual update buffers, not copies, and record their contents before cleanup.
const capture = vi.hoisted(() => ({
    updates: [] as Buffer[],
    hadNonzero: [] as boolean[],
    matchedPlain: [] as boolean[],
    expectedPlain: null as Uint8Array | null,
}));

vi.mock('node:crypto', async () => {
    const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');

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

                    // All other methods, including final, remain genuine Node methods.
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        },
    };
});

function fixture(corruptTag: boolean) {
    const plaintext = Uint8Array.from([0x01, 0x00, 0x43, 0xff, 0x91, 0x25, 0xa7, 0x10]);
    const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const nonce = Uint8Array.from({ length: 12 }, (_, index) => 0xa0 + index);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    const encoded = Uint8Array.from(
        Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]),
    );

    if (corruptTag) {
        encoded[encoded.length - 1] ^= 1;
    }

    capture.expectedPlain = plaintext;
    return {
        plaintext,
        key,
        nonce,
        encoded,
        plaintextBefore: Uint8Array.from(plaintext),
        keyBefore: Uint8Array.from(key),
        nonceBefore: Uint8Array.from(nonce),
        encodedBefore: Uint8Array.from(encoded),
    };
}

function expectWipedUpdate(): Buffer {
    expect(capture.updates).toHaveLength(1);
    expect(capture.updates[0].length).toBeGreaterThan(0);
    expect(capture.hadNonzero).toEqual([true]);
    expect(capture.matchedPlain).toEqual([true]);
    expect(capture.updates[0].every((byte) => byte === 0)).toBe(true);
    return capture.updates[0];
}

function expectInputsUnchanged(input: ReturnType<typeof fixture>): void {
    expect(input.plaintext).toEqual(input.plaintextBefore);
    expect(input.key).toEqual(input.keyBefore);
    expect(input.nonce).toEqual(input.nonceBefore);
    expect(input.encoded).toEqual(input.encodedBefore);
}

function overlaps(a: Uint8Array, b: Uint8Array): boolean {
    return (
        a.buffer === b.buffer &&
        a.byteOffset < b.byteOffset + b.byteLength &&
        b.byteOffset < a.byteOffset + a.byteLength
    );
}

beforeEach(async () => {
    capture.updates.length = 0;
    capture.hadNonzero.length = 0;
    capture.matchedPlain.length = 0;
    capture.expectedPlain = null;
    const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
    expect(createCipheriv).toBe(actual.createCipheriv);
});

afterEach(() => {
    for (const update of capture.updates) {
        update.fill(0);
    }

    capture.updates.length = 0;
    capture.hadNonzero.length = 0;
    capture.matchedPlain.length = 0;
    capture.expectedPlain = null;
});

describe('key exchange decipher update wiping (synthetic only)', () => {
    it('preserves the Node authentication error type and message and wipes update output', async () => {
        const input = fixture(true);
        const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
        const control = actual.createDecipheriv('aes-256-gcm', input.key, input.nonce, {
            authTagLength: 16,
        });
        control.setAuthTag(input.encoded.subarray(input.encoded.length - 16));
        const controlUpdate = control.update(input.encoded.subarray(12, input.encoded.length - 16));
        let controlError: unknown;

        try {
            control.final();
        } catch (error) {
            controlError = error;
        } finally {
            controlUpdate.fill(0);
        }

        let thrown: unknown;
        let returned: Uint8Array | undefined;

        try {
            returned = decryptKeyExchangeBytes(input.encoded, input.key);
        } catch (error) {
            thrown = error;
        }

        expect(controlError).toBeInstanceOf(Error);
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).constructor).toBe((controlError as Error).constructor);
        expect((thrown as Error).message).toBe((controlError as Error).message);
        expect(returned).toBeUndefined();
        expectWipedUpdate();
        expectInputsUnchanged(input);
    });

    it('returns an independent authenticated copy and wipes the update buffer', () => {
        const input = fixture(false);
        const result = decryptKeyExchangeBytes(input.encoded, input.key);
        const update = expectWipedUpdate();

        expect(result).toEqual(input.plaintextBefore);
        expect(overlaps(result, update)).toBe(false);
        result[0] ^= 1;
        expect(update.every((byte) => byte === 0)).toBe(true);
        expectInputsUnchanged(input);
    });
});
