import { randomBytes } from 'node:crypto';

const BLOCK_SIZE = 8;
const KEY_SIZE = 16;
const DELTA = 0x9e3779b9;
const ROUNDS = 16;

/**
 * QQ-TEA wire format: big-endian TEA words, 16 cycles, and two feedback
 * chains. The header's low three bits encode the 0..7 alignment bytes;
 * two more random bytes precede the message and seven zero bytes follow it.
 * See https://github.com/hzruandd/python-qq/blob/master/socket-qq/tea.py
 * and https://github.com/Mrs4s/MiraiGo/blob/2b2be6693df1219d867300c6f6cd0f804c59d620/binary/tea.go.
 *
 * This is a legacy format, not authenticated encryption. A valid zero trailer
 * is not proof of authenticity or the correct key. Do not expose decryption
 * failure details to a network peer. It does not implement any account,
 * transport, session, or protocol negotiation behavior.
 */

function keyWords(key: Uint8Array): number[] {
    if (key.length !== KEY_SIZE) {
        throw new RangeError('QQ-TEA key must be exactly 16 bytes');
    }

    const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
    return [view.getUint32(0), view.getUint32(4), view.getUint32(8), view.getUint32(12)];
}

function teaBlock(block: Uint8Array, key: number[], decrypt: boolean): Uint8Array {
    const view = new DataView(block.buffer, block.byteOffset, BLOCK_SIZE);
    let left = view.getUint32(0);
    let right = view.getUint32(4);
    let sum = decrypt ? Math.imul(DELTA, ROUNDS) >>> 0 : 0;

    for (let cycle = 0; cycle < ROUNDS; cycle++) {
        if (decrypt) {
            right =
                (right - (((left << 4) + key[2]) ^ (left + sum) ^ ((left >>> 5) + key[3]))) >>> 0;
            left =
                (left - (((right << 4) + key[0]) ^ (right + sum) ^ ((right >>> 5) + key[1]))) >>> 0;
            sum = (sum - DELTA) >>> 0;
        } else {
            sum = (sum + DELTA) >>> 0;
            left =
                (left + (((right << 4) + key[0]) ^ (right + sum) ^ ((right >>> 5) + key[1]))) >>> 0;
            right =
                (right + (((left << 4) + key[2]) ^ (left + sum) ^ ((left >>> 5) + key[3]))) >>> 0;
        }
    }

    const result = new Uint8Array(BLOCK_SIZE);
    const output = new DataView(result.buffer);
    output.setUint32(0, left);
    output.setUint32(4, right);
    return result;
}

/** Encrypt bytes using a fresh secure random prefix by default.
 * The optional random source is for reproducible test vectors; it must return
 * exactly the requested number of bytes. Never use a fixed source in production.
 */
export function qqTeaEncrypt(
    plaintext: Uint8Array,
    key: Uint8Array,
    randomSource: (length: number) => Uint8Array = randomBytes,
): Uint8Array {
    const words = keyWords(key);
    const padding = (8 - ((plaintext.length + 10) % 8)) % 8;
    const prefix = randomSource(padding + 3);

    if (!(prefix instanceof Uint8Array) || prefix.length !== padding + 3) {
        throw new Error('QQ-TEA random source returned an invalid prefix');
    }

    const padded = new Uint8Array(plaintext.length + padding + 10);
    padded.set(prefix);
    padded[0] = (padded[0] & 0xf8) | padding;
    padded.set(plaintext, padding + 3);

    const result = new Uint8Array(padded.length);
    let previousCipher: Uint8Array = new Uint8Array(BLOCK_SIZE);
    let previousMixed: Uint8Array = new Uint8Array(BLOCK_SIZE);

    for (let offset = 0; offset < padded.length; offset += BLOCK_SIZE) {
        const mixed = new Uint8Array(BLOCK_SIZE);

        for (let i = 0; i < BLOCK_SIZE; i++) {
            mixed[i] = padded[offset + i] ^ previousCipher[i];
        }

        const encrypted = teaBlock(mixed, words, false);

        for (let i = 0; i < BLOCK_SIZE; i++) {
            encrypted[i] ^= previousMixed[i];
        }

        result.set(encrypted, offset);
        previousCipher = encrypted;
        previousMixed = mixed;
    }

    return result;
}

/** Decrypt one complete QQ-TEA ciphertext, rejecting malformed framing. */
export function qqTeaDecrypt(ciphertext: Uint8Array, key: Uint8Array): Uint8Array {
    const words = keyWords(key);

    if (ciphertext.length < 16 || ciphertext.length % BLOCK_SIZE !== 0) {
        throw new Error('invalid QQ-TEA ciphertext');
    }

    const padded = new Uint8Array(ciphertext.length);
    let previousCipher: Uint8Array = new Uint8Array(BLOCK_SIZE);
    let previousMixed: Uint8Array = new Uint8Array(BLOCK_SIZE);

    for (let offset = 0; offset < ciphertext.length; offset += BLOCK_SIZE) {
        const block = ciphertext.subarray(offset, offset + BLOCK_SIZE);
        const encrypted = new Uint8Array(BLOCK_SIZE);

        for (let i = 0; i < BLOCK_SIZE; i++) {
            encrypted[i] = block[i] ^ previousMixed[i];
        }

        const mixed = teaBlock(encrypted, words, true);

        for (let i = 0; i < BLOCK_SIZE; i++) {
            padded[offset + i] = mixed[i] ^ previousCipher[i];
        }

        previousCipher = block;
        previousMixed = mixed;
    }

    const start = (padded[0] & 7) + 3;
    const end = padded.length - 7;

    let invalidTrailer = 0;

    for (let i = end; i < padded.length; i++) {
        invalidTrailer |= padded[i];
    }

    if (start > end || invalidTrailer !== 0) {
        throw new Error('invalid QQ-TEA ciphertext');
    }

    return padded.slice(start, end);
}
