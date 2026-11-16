import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Run this file in its own Vitest process. The switchable provider delegates
// normal cryptography to Node; only the explicitly selected fault is synthetic.
const cryptoGate = vi.hoisted(() => ({
    failRandomSize: 0,
    shortRandomSize: 0,
    fixedRandom: false,
    failCipher: false,
    failCipherUpdate: false,
    failDecipher: '' as '' | 'create' | 'aad' | 'tag' | 'update' | 'final',
    replacementPlaintext: null as Uint8Array | null,
    afterCipherAAD: null as (() => void) | null,
    afterDecipherUpdate: null as (() => void) | null,
    randomSizes: [] as number[],
    emitted: [] as Buffer[],
    aadBuffers: [] as Buffer[],
    plaintextInputs: [] as Buffer[],
    plaintextParts: [] as Buffer[],
    decipherCalls: 0,
    decipherFinalCalls: 0,
    decipherFinalFailures: 0,
}));

vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();

    function randomBytes(size: number): Buffer;
    function randomBytes(
        size: number,
        callback: (error: Error | null, bytes: Buffer) => void,
    ): void;

    function randomBytes(
        size: number,
        callback?: (error: Error | null, bytes: Buffer) => void,
    ): Buffer | void {
        cryptoGate.randomSizes.push(size);

        if (cryptoGate.failRandomSize === size) {
            throw new Error('SYNTHETIC_RANDOM_FAILURE');
        }

        const length = cryptoGate.shortRandomSize === size ? size - 1 : size;

        if (callback && !cryptoGate.fixedRandom && length === size) {
            actual.randomBytes(size, callback);
            return;
        }

        const bytes = cryptoGate.fixedRandom
            ? Buffer.alloc(length, size === 32 ? 0x42 : 0x24)
            : actual.randomBytes(length);
        cryptoGate.emitted.push(bytes);

        if (callback) {
            queueMicrotask(() => callback(null, bytes));
            return;
        }

        return bytes;
    }

    const createCipheriv = ((...args: Parameters<typeof actual.createCipheriv>) => {
        if (cryptoGate.failCipher) {
            throw new Error('SYNTHETIC_CIPHER_FAILURE');
        }

        const cipher = actual.createCipheriv(...args) as import('node:crypto').CipherGCM;
        const setAAD = cipher.setAAD.bind(cipher);
        cipher.setAAD = ((aad: NodeJS.ArrayBufferView) => {
            if (Buffer.isBuffer(aad)) {
                cryptoGate.aadBuffers.push(aad);
            }

            const result = setAAD(aad);
            const hook = cryptoGate.afterCipherAAD;
            cryptoGate.afterCipherAAD = null;
            hook?.();
            return result;
        }) as typeof cipher.setAAD;
        const update = (cipher.update as (data: NodeJS.ArrayBufferView) => Buffer).bind(cipher);
        cipher.update = ((data: NodeJS.ArrayBufferView) => {
            if (Buffer.isBuffer(data)) {
                cryptoGate.plaintextInputs.push(data);
            }

            if (cryptoGate.failCipherUpdate) {
                throw new Error('SYNTHETIC_CIPHER_UPDATE_FAILURE');
            }

            const replacement = cryptoGate.replacementPlaintext;
            cryptoGate.replacementPlaintext = null;
            return update(replacement === null ? data : Buffer.from(replacement));
        }) as typeof cipher.update;
        return cipher;
    }) as typeof actual.createCipheriv;

    const createDecipheriv = ((...args: Parameters<typeof actual.createDecipheriv>) => {
        cryptoGate.decipherCalls += 1;

        if (cryptoGate.failDecipher === 'create') {
            throw new Error('SYNTHETIC_DECIPHER_CREATE_FAILURE');
        }

        const decipher = actual.createDecipheriv(...args) as import('node:crypto').DecipherGCM;
        const setAAD = decipher.setAAD.bind(decipher);
        decipher.setAAD = ((aad: NodeJS.ArrayBufferView) => {
            if (cryptoGate.failDecipher === 'aad') {
                throw new Error('SYNTHETIC_DECIPHER_AAD_FAILURE');
            }

            return setAAD(aad);
        }) as typeof decipher.setAAD;
        const setAuthTag = decipher.setAuthTag.bind(decipher);
        decipher.setAuthTag = ((tag: NodeJS.ArrayBufferView) => {
            if (cryptoGate.failDecipher === 'tag') {
                throw new Error('SYNTHETIC_DECIPHER_TAG_FAILURE');
            }

            return setAuthTag(tag);
        }) as typeof decipher.setAuthTag;
        const update = (decipher.update as (data: NodeJS.ArrayBufferView) => Buffer).bind(decipher);
        decipher.update = ((data: NodeJS.ArrayBufferView) => {
            if (cryptoGate.failDecipher === 'update') {
                throw new Error('SYNTHETIC_DECIPHER_UPDATE_FAILURE');
            }

            const plaintext = update(data);
            cryptoGate.plaintextParts.push(plaintext);
            const hook = cryptoGate.afterDecipherUpdate;
            cryptoGate.afterDecipherUpdate = null;
            hook?.();
            return plaintext;
        }) as typeof decipher.update;
        const final = decipher.final.bind(decipher);
        decipher.final = ((outputEncoding?: BufferEncoding) => {
            cryptoGate.decipherFinalCalls += 1;

            try {
                if (cryptoGate.failDecipher === 'final') {
                    throw new Error('SYNTHETIC_DECIPHER_FINAL_FAILURE');
                }

                const plaintext = outputEncoding === undefined ? final() : final(outputEncoding);

                if (Buffer.isBuffer(plaintext)) {
                    cryptoGate.plaintextParts.push(plaintext);
                }

                return plaintext;
            } catch (error) {
                cryptoGate.decipherFinalFailures += 1;
                throw error;
            }
        }) as typeof decipher.final;
        return decipher;
    }) as typeof actual.createDecipheriv;

    return {
        ...actual,
        randomBytes,
        createCipheriv,
        createDecipheriv,
        default: { ...actual.default, randomBytes, createCipheriv, createDecipheriv },
    };
});

let tokenApi: typeof import('../../src/v12/image-file-token');
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let networkGuards: Array<{ mock: { calls: unknown[] }; mockRestore: () => unknown }>;

function blockedNetwork(): never {
    throw new Error('unexpected network operation in token fixture');
}

function resetCryptoGate(): void {
    cryptoGate.failRandomSize = 0;
    cryptoGate.shortRandomSize = 0;
    cryptoGate.fixedRandom = false;
    cryptoGate.failCipher = false;
    cryptoGate.failCipherUpdate = false;
    cryptoGate.failDecipher = '';
    cryptoGate.replacementPlaintext = null;
    cryptoGate.afterCipherAAD = null;
    cryptoGate.afterDecipherUpdate = null;
    cryptoGate.randomSizes.length = 0;
    cryptoGate.emitted.length = 0;
    cryptoGate.aadBuffers.length = 0;
    cryptoGate.plaintextInputs.length = 0;
    cryptoGate.plaintextParts.length = 0;
    cryptoGate.decipherCalls = 0;
    cryptoGate.decipherFinalCalls = 0;
    cryptoGate.decipherFinalFailures = 0;
}

beforeEach(async () => {
    resetCryptoGate();
    fetchGuard = vi.fn(blockedNetwork);
    webSocketGuard = vi.fn(function ForbiddenWebSocket() {
        return blockedNetwork();
    });
    vi.stubGlobal('fetch', fetchGuard);
    vi.stubGlobal('WebSocket', webSocketGuard);
    networkGuards = [
        vi.spyOn(net, 'createServer').mockImplementation(blockedNetwork),
        vi.spyOn(net, 'createConnection').mockImplementation(blockedNetwork),
        vi.spyOn(net, 'connect').mockImplementation(blockedNetwork),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(blockedNetwork),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blockedNetwork),
        vi.spyOn(http, 'request').mockImplementation(blockedNetwork),
        vi.spyOn(https, 'request').mockImplementation(blockedNetwork),
    ];
    tokenApi = await import('../../src/v12/image-file-token');
});

afterEach(() => {
    const calls = [
        fetchGuard.mock.calls.length,
        webSocketGuard.mock.calls.length,
        ...networkGuards.map((guard) => guard.mock.calls.length),
    ];

    for (const guard of networkGuards) {
        guard.mockRestore();
    }

    vi.unstubAllGlobals();
    resetCryptoGate();
    expect(calls).toEqual(calls.map(() => 0));
});

const accountA = '10001';
const accountB = '10002';
const privateMarker = 'SYNTHETIC_VOICE_PRIVATE_8F32';
const voiceUrl = `https://fixture.invalid/语音/🪶?sig=${privateMarker}&raw=%2f%2F+%20#view`;

function packedToken(id: string, prefix = tokenApi.V12_VOICE_TOKEN_PREFIX): Buffer {
    expect(id.startsWith(prefix)).toBe(true);
    const encoded = id.slice(prefix.length);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    const bytes = Buffer.from(encoded, 'base64url');
    expect(bytes.toString('base64url')).toBe(encoded);
    return bytes;
}

function tokenFromBytes(bytes: Uint8Array): string {
    return tokenApi.V12_VOICE_TOKEN_PREFIX + Buffer.from(bytes).toString('base64url');
}

function errorFrom(operation: () => unknown): Error {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(Error);
        return error as Error;
    }

    throw new Error('expected operation to throw');
}

function expectErased(buffers: Buffer[]): void {
    expect(buffers.length).toBeGreaterThan(0);

    for (const buffer of buffers) {
        expect(buffer).toEqual(Buffer.alloc(buffer.length));
    }
}

describe('V12 voice file token local synthetic fixtures', () => {
    it('preflights exact URL snapshots without creating issuers or consuming nonces', () => {
        const { isV12SealableFileUrl } = tokenApi;
        const base = 'https://fixture.invalid/';
        const atLimit = base + 'x'.repeat(3000 - Buffer.byteLength(base) - 4) + '🪶';
        const overBytes = atLimit + 'x';
        const overChars = base + 'x'.repeat(3001 - base.length);
        const valid = [
            voiceUrl,
            atLimit,
            'HTTP://EXAMPLE.COM:80/a/../b?token=%2f#frag',
            'http://[2001:db8::1]:8080/a?token=%2F',
        ];
        const invalid: unknown[] = [
            '',
            overBytes,
            overChars,
            'file:///tmp/synthetic',
            'https://user@fixture.invalid/',
            'https://fixture.invalid/with space',
            'https://fixture.invalid/%zz',
            'https://fixture.invalid/\ud800',
            null,
            undefined,
            0,
            {},
            [],
        ];

        for (const value of valid) {
            expect(isV12SealableFileUrl(value)).toBe(true);
        }

        for (const value of invalid) {
            expect(isV12SealableFileUrl(value)).toBe(false);
        }

        expect(cryptoGate.randomSizes).toEqual([]);
        const cases = [
            [new tokenApi.V12ImageFileTokens(accountA), 'image', tokenApi.V12_IMAGE_TOKEN_PREFIX],
            [new tokenApi.V12VoiceFileTokens(accountA), 'voice', tokenApi.V12_VOICE_TOKEN_PREFIX],
        ] as const;

        for (const [subject, name, prefix] of cases) {
            for (const value of invalid) {
                expect(errorFrom(() => subject.issue(value as string)).message).toBe(
                    `${name} file token unavailable`,
                );
            }

            const first = packedToken(subject.issue(voiceUrl), prefix);
            expect(first.readBigUInt64BE(4)).toBe(1n);
            subject.revoke();
        }
    });

    it('maps Buffer and URL constructor faults to false without consuming a nonce', () => {
        const image = new tokenApi.V12ImageFileTokens(accountA);
        const voice = new tokenApi.V12VoiceFileTokens(accountA);
        const byteLength = vi.spyOn(Buffer, 'byteLength');

        const failByteLength = () => {
            throw new Error('SYNTHETIC_BYTE_LENGTH_FAILURE');
        };

        try {
            byteLength.mockImplementationOnce(failByteLength);
            expect(tokenApi.isV12SealableFileUrl(voiceUrl)).toBe(false);
            byteLength.mockImplementationOnce(failByteLength);
            expect(errorFrom(() => image.issue(voiceUrl)).message).toBe(
                'image file token unavailable',
            );
            byteLength.mockImplementationOnce(failByteLength);
            expect(errorFrom(() => voice.issue(voiceUrl)).message).toBe(
                'voice file token unavailable',
            );
        } finally {
            byteLength.mockRestore();
        }

        const originalURL = globalThis.URL;
        vi.stubGlobal(
            'URL',
            class BrokenURL {
                constructor() {
                    throw new Error('SYNTHETIC_URL_FAILURE');
                }
            },
        );

        try {
            expect(tokenApi.isV12SealableFileUrl(voiceUrl)).toBe(false);
            expect(errorFrom(() => image.issue(voiceUrl)).message).toBe(
                'image file token unavailable',
            );
            expect(errorFrom(() => voice.issue(voiceUrl)).message).toBe(
                'voice file token unavailable',
            );
        } finally {
            vi.stubGlobal('URL', originalURL);
        }

        expect(
            packedToken(image.issue(voiceUrl), tokenApi.V12_IMAGE_TOKEN_PREFIX).readBigUInt64BE(4),
        ).toBe(1n);
        expect(packedToken(voice.issue(voiceUrl)).readBigUInt64BE(4)).toBe(1n);
        image.revoke();
        voice.revoke();
    });

    it('reserves the voice prefix and round-trips exact opaque URL snapshots', () => {
        const { V12VoiceFileTokens, V12_VOICE_TOKEN_PREFIX: prefix, isV12VoiceToken } = tokenApi;
        expect(prefix).toBe('jiyu-voice:v1:');
        const subject = new V12VoiceFileTokens(accountA);
        const urls = [
            voiceUrl,
            'HTTP://EXAMPLE.COM:80/a/../b?token=%2f#frag',
            'http://[2001:db8::1]:8080/a?token=%2F',
            'https://fixture.invalid/@path?token=a@b%20c',
        ];

        for (const url of urls) {
            const id = subject.issue(url);
            const packed = packedToken(id);
            expect(isV12VoiceToken(id)).toBe(true);
            expect(id.length).toBeLessThanOrEqual(4096);
            expect(packed.length).toBe(12 + Buffer.byteLength(url, 'utf8') + 16);
            expect(id).not.toContain(url);
            expect(id).not.toContain(privateMarker);
            expect(packed.includes(Buffer.from(url, 'utf8'))).toBe(false);
            expect(subject.redeem(id)).toBe(url);
            expect(subject.redeem(id)).toBe(url);
        }

        expect(cryptoGate.randomSizes).toEqual([32, 4]);
        expect(isV12VoiceToken(prefix)).toBe(true);
        expect(isV12VoiceToken(prefix + '!')).toBe(true);
        expect(isV12VoiceToken('')).toBe(false);
        expect(isV12VoiceToken('jiyu-voice:v2:abc')).toBe(false);
        expect(isV12VoiceToken('Jiyu-voice:v1:abc')).toBe(false);
        expect(isV12VoiceToken(tokenApi.V12_IMAGE_TOKEN_PREFIX + 'abc')).toBe(false);
        expect(isV12VoiceToken(null as unknown as string)).toBe(false);
        subject.revoke();
    });

    it('matches the literal image and voice v1 wire formats', async () => {
        const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
        // Fixed key/nonce reuse is deliberate here solely to check wire bytes.
        cryptoGate.fixedRandom = true;
        const image = new tokenApi.V12ImageFileTokens(accountA);
        const voice = new tokenApi.V12VoiceFileTokens(accountA);
        const nonce = Buffer.alloc(12);
        nonce.fill(0x24, 0, 4);
        nonce.writeBigUInt64BE(1n, 4);

        for (const [subject, prefix, purpose] of [
            [image, 'jiyu-image:v1:', 'jiyu-onebot12-image-v1'],
            [voice, 'jiyu-voice:v1:', 'jiyu-onebot12-voice-v1'],
        ] as const) {
            const cipher = actual.createCipheriv('aes-256-gcm', Buffer.alloc(32, 0x42), nonce, {
                authTagLength: 16,
            });
            cipher.setAAD(Buffer.from(JSON.stringify([purpose, 'qq', accountA]), 'utf8'));
            const ciphertext = Buffer.concat([
                cipher.update(Buffer.from(voiceUrl)),
                cipher.final(),
            ]);
            const expected =
                prefix +
                Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64url');
            expect(subject.issue(voiceUrl)).toBe(expected);
            expect(subject.redeem(expected)).toBe(voiceUrl);
        }

        image.revoke();
        voice.revoke();
    });

    it('uses one random prefix and consecutive distinct 64-bit nonces', () => {
        const subject = new tokenApi.V12VoiceFileTokens(accountA);
        const nonces = Array.from({ length: 64 }, () =>
            packedToken(subject.issue(voiceUrl)).subarray(0, 12),
        );
        expect(new Set(nonces.map((nonce) => nonce.toString('hex'))).size).toBe(nonces.length);
        expect(new Set(nonces.map((nonce) => nonce.subarray(0, 4).toString('hex'))).size).toBe(1);

        for (let i = 0; i < nonces.length; i += 1) {
            expect(nonces[i].readBigUInt64BE(4)).toBe(BigInt(i + 1));
        }

        subject.revoke();
    });

    it('isolates two accounts and distinct issuers of the same account', () => {
        const a = new tokenApi.V12VoiceFileTokens(accountA);
        const anotherA = new tokenApi.V12VoiceFileTokens(accountA);
        const b = new tokenApi.V12VoiceFileTokens(accountB);
        const aId = a.issue(voiceUrl);
        const bUrl = 'https://fixture.invalid/b?sig=SYNTHETIC_B';
        const bId = b.issue(bUrl);
        expect(a.redeem(aId)).toBe(voiceUrl);
        expect(b.redeem(bId)).toBe(bUrl);
        expect(anotherA.redeem(aId)).toBeNull();
        expect(b.redeem(aId)).toBeNull();
        expect(a.redeem(bId)).toBeNull();
        expect(anotherA.redeem(bId)).toBeNull();
        a.revoke();
        anotherA.revoke();
        b.revoke();
    });

    it('authenticates the account even when the test forces matching keys and nonces', () => {
        cryptoGate.fixedRandom = true;
        const a = new tokenApi.V12VoiceFileTokens(accountA);
        const sameAccount = new tokenApi.V12VoiceFileTokens(accountA);
        const b = new tokenApi.V12VoiceFileTokens(accountB);
        const id = a.issue(voiceUrl);
        expect(cryptoGate.emitted[0]).toEqual(cryptoGate.emitted[2]);
        expect(cryptoGate.emitted[0]).toEqual(cryptoGate.emitted[4]);
        expect(cryptoGate.emitted[1]).toEqual(cryptoGate.emitted[3]);
        expect(cryptoGate.emitted[1]).toEqual(cryptoGate.emitted[5]);
        expect(sameAccount.redeem(id)).toBe(voiceUrl);
        const failures = cryptoGate.decipherFinalFailures;
        expect(b.redeem(id)).toBeNull();
        expect(cryptoGate.decipherFinalFailures).toBe(failures + 1);
        a.revoke();
        sameAccount.revoke();
        b.revoke();
    });

    it('authenticates the purpose after rewriting prefixes, even with equal test keys and nonces', () => {
        // These collisions deliberately exercise AAD separation only. Real GCM
        // security still requires independently generated keys and unique nonces.
        cryptoGate.fixedRandom = true;
        const image = new tokenApi.V12ImageFileTokens(accountA);
        const imageControl = new tokenApi.V12ImageFileTokens(accountA);
        const voice = new tokenApi.V12VoiceFileTokens(accountA);
        const voiceControl = new tokenApi.V12VoiceFileTokens(accountA);
        const imageId = image.issue(voiceUrl);
        const voiceId = voice.issue(voiceUrl);
        const imagePrefix = tokenApi.V12_IMAGE_TOKEN_PREFIX;
        const voicePrefix = tokenApi.V12_VOICE_TOKEN_PREFIX;
        const imageBytes = packedToken(imageId, imagePrefix);
        const voiceBytes = packedToken(voiceId);
        expect(cryptoGate.emitted[0]).toEqual(cryptoGate.emitted[4]);
        expect(cryptoGate.emitted[1]).toEqual(cryptoGate.emitted[5]);
        expect(imageBytes.subarray(0, 12)).toEqual(voiceBytes.subarray(0, 12));
        expect(imageControl.redeem(imageId)).toBe(voiceUrl);
        expect(voiceControl.redeem(voiceId)).toBe(voiceUrl);
        expect(image.redeem(voiceId)).toBeNull();
        expect(voice.redeem(imageId)).toBeNull();
        expect(tokenApi.isV12ImageToken(voiceId)).toBe(false);
        expect(tokenApi.isV12VoiceToken(imageId)).toBe(false);

        const rewrittenAsImage = imagePrefix + voiceId.slice(voicePrefix.length);
        const rewrittenAsVoice = voicePrefix + imageId.slice(imagePrefix.length);
        const finalCalls = cryptoGate.decipherFinalCalls;
        const failures = cryptoGate.decipherFinalFailures;
        expect(image.redeem(rewrittenAsImage)).toBeNull();
        expect(voice.redeem(rewrittenAsVoice)).toBeNull();
        expect(cryptoGate.decipherFinalCalls).toBe(finalCalls + 2);
        expect(cryptoGate.decipherFinalFailures).toBe(failures + 2);
        expect(cryptoGate.aadBuffers[0].toString('utf8')).toBe(
            JSON.stringify(['jiyu-onebot12-image-v1', 'qq', accountA]),
        );
        expect(cryptoGate.aadBuffers[1].toString('utf8')).toBe(
            JSON.stringify(['jiyu-onebot12-voice-v1', 'qq', accountA]),
        );
        image.revoke();
        imageControl.revoke();
        voice.revoke();
        voiceControl.revoke();
    });

    it('rejects changes to the nonce, ciphertext or tag and wipes unauthenticated output', () => {
        const subject = new tokenApi.V12VoiceFileTokens(accountA);
        const original = packedToken(subject.issue(voiceUrl));
        const offsets = [
            0,
            4,
            11,
            12,
            original.length - 17,
            original.length - 16,
            original.length - 1,
        ];
        const failures = cryptoGate.decipherFinalFailures;

        for (const offset of offsets) {
            const changed = Buffer.from(original);
            changed[offset] ^= 1;
            expect(subject.redeem(tokenFromBytes(changed))).toBeNull();
        }

        expect(cryptoGate.decipherFinalFailures).toBe(failures + offsets.length);
        expectErased(cryptoGate.plaintextParts);
        subject.revoke();
    });

    it('enforces account, URL and token limits without normalizing snapshots', () => {
        for (const account of ['a'.repeat(128), 'é'.repeat(128), '🪶'.repeat(64)]) {
            const subject = new tokenApi.V12VoiceFileTokens(account);
            expect(subject.redeem(subject.issue(voiceUrl))).toBe(voiceUrl);
            subject.revoke();
        }

        const invalidAccounts = [
            '',
            'a'.repeat(129),
            '€'.repeat(86),
            '\0',
            '\x7f',
            '\ud800',
            '\udc00',
            null,
            undefined,
            0,
            {},
            [],
        ];

        for (const account of invalidAccounts) {
            const before = cryptoGate.randomSizes.length;
            const error = errorFrom(() => new tokenApi.V12VoiceFileTokens(account as string));
            expect(error.message).toBe('invalid voice file token account');
            expect(cryptoGate.randomSizes).toHaveLength(before);
        }

        const subject = new tokenApi.V12VoiceFileTokens(accountA);
        const base = 'https://fixture.invalid/';
        const below = base + 'x'.repeat(2999 - Buffer.byteLength(base));
        const atLimit = base + 'x'.repeat(3000 - Buffer.byteLength(base) - 4) + '🪶';
        const above = atLimit + 'x';
        expect(Buffer.byteLength(below)).toBe(2999);
        expect(Buffer.byteLength(atLimit)).toBe(3000);
        expect(Buffer.byteLength(above)).toBe(3001);
        expect(above.length).toBeLessThanOrEqual(3000);

        for (const url of [below, atLimit]) {
            const id = subject.issue(url);
            expect(id.length).toBeLessThanOrEqual(4096);
            expect(packedToken(id).length).toBe(12 + Buffer.byteLength(url) + 16);
            expect(subject.redeem(id)).toBe(url);
        }

        const invalidUrls: unknown[] = [
            '',
            above,
            'ftp://fixture.invalid/file',
            'file:///tmp/fixture',
            'data:text/plain,x',
            'https:fixture.invalid/file',
            'https:/fixture.invalid/file',
            'https:///fixture.invalid/file',
            'https://@fixture.invalid/file',
            'https://user:password@fixture.invalid/file',
            'https://fixture.invalid/path\\name',
            'https://fixture.invalid/with space',
            'https://fixture.invalid/%',
            'https://fixture.invalid/%2',
            'https://fixture.invalid/%zz',
            'https://',
            'https://[::1',
            'https://fixture.invalid/\0',
            'https://fixture.invalid/\ud800',
            'https://fixture.invalid/\udc00',
            null,
            undefined,
            0,
            {},
            [],
        ];

        for (const url of invalidUrls) {
            expect(errorFrom(() => subject.issue(url as string)).message).toBe(
                'voice file token unavailable',
            );
        }

        const prefix = tokenApi.V12_VOICE_TOKEN_PREFIX;
        const limitId = prefix + 'A'.repeat(4096 - prefix.length);
        expect(limitId.length).toBe(4096);
        expect(subject.redeem(limitId)).toBeNull();
        expect(subject.redeem(limitId + 'A')).toBeNull();
        subject.revoke();
    });

    it('rejects malformed and noncanonical IDs before calling the cipher provider', () => {
        const subject = new tokenApi.V12VoiceFileTokens(accountA);
        const prefix = tokenApi.V12_VOICE_TOKEN_PREFIX;
        let id = subject.issue('https://fixture.invalid/a');

        if (id.slice(prefix.length).length % 4 === 0) {
            id = subject.issue('https://fixture.invalid/aa');
        }

        const encoded = id.slice(prefix.length);
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        const last = alphabet.indexOf(encoded[encoded.length - 1]);
        expect([2, 3]).toContain(encoded.length % 4);
        const noncanonical = encoded.slice(0, -1) + alphabet[last + 1];
        expect(Buffer.from(noncanonical, 'base64url')).toEqual(Buffer.from(encoded, 'base64url'));
        const malformed: unknown[] = [
            '',
            prefix,
            prefix + 'A',
            prefix + '=',
            prefix + Buffer.alloc(11).toString('base64url'),
            prefix + Buffer.alloc(28).toString('base64url'),
            id + '=',
            id + '==',
            prefix + noncanonical,
            prefix + encoded.slice(0, 3) + '+' + encoded.slice(4),
            prefix + encoded.slice(0, 3) + '/' + encoded.slice(4),
            prefix + encoded.slice(0, 3) + ' ' + encoded.slice(4),
            prefix + encoded.slice(0, 3) + '\n' + encoded.slice(4),
            prefix + Buffer.alloc(12 + 3001 + 16).toString('base64url'),
            prefix + 'A'.repeat(4097 - prefix.length),
            voiceUrl,
            null,
            undefined,
            0,
            {},
            [],
        ];
        const calls = cryptoGate.decipherCalls;

        for (const value of malformed) {
            expect(subject.redeem(value as string)).toBeNull();
        }

        expect(cryptoGate.decipherCalls).toBe(calls);
        subject.revoke();
    });

    it('revalidates authenticated plaintext, including fatal UTF-8 and URL rules', () => {
        const subject = new tokenApi.V12VoiceFileTokens(accountA);
        const replacement = 'https://fixture.invalid/replacement?sig=SYNTHETIC_REPLACEMENT';
        cryptoGate.replacementPlaintext = Buffer.from(replacement);
        const control = subject.issue(voiceUrl);
        expect(cryptoGate.replacementPlaintext).toBeNull();
        expect(subject.redeem(control)).toBe(replacement);
        const base = 'https://fixture.invalid/';
        const invalidPayloads = [
            Buffer.from('file:///tmp/synthetic-file'),
            Buffer.from('https://user@fixture.invalid/'),
            Buffer.from('https://fixture.invalid/path with space'),
            Buffer.from('https://fixture.invalid/%zz'),
            Buffer.concat([Buffer.from(base), Buffer.from([0xc0, 0xaf])]),
            Buffer.from(base + 'x'.repeat(3001 - Buffer.byteLength(base))),
        ];

        for (const payload of invalidPayloads) {
            cryptoGate.replacementPlaintext = payload;
            const id = subject.issue(voiceUrl);
            expect(cryptoGate.replacementPlaintext).toBeNull();
            expect(subject.redeem(id)).toBeNull();
        }

        expectErased(cryptoGate.plaintextInputs);
        expectErased(cryptoGate.plaintextParts);
        subject.revoke();
    });

    it('maps random failures and erases partially generated material', () => {
        const existing = new tokenApi.V12VoiceFileTokens(accountA);
        const existingId = existing.issue(voiceUrl);

        for (const size of [32, 4]) {
            cryptoGate.emitted.length = 0;
            cryptoGate.randomSizes.length = 0;
            cryptoGate.failRandomSize = size;
            const error = errorFrom(() => new tokenApi.V12VoiceFileTokens(accountB));
            expect(error.message).toBe('voice file token unavailable');
            expect(cryptoGate.randomSizes).toContain(size);
            expect(error.stack).not.toContain('SYNTHETIC_RANDOM_FAILURE');

            if (size === 4) {
                expect(cryptoGate.emitted).toHaveLength(1);
                expectErased(cryptoGate.emitted);
            }

            cryptoGate.failRandomSize = 0;
            expect(existing.redeem(existingId)).toBe(voiceUrl);
        }

        for (const size of [32, 4]) {
            cryptoGate.emitted.length = 0;
            cryptoGate.shortRandomSize = size;
            expect(errorFrom(() => new tokenApi.V12VoiceFileTokens(accountB)).message).toBe(
                'voice file token unavailable',
            );
            expect(cryptoGate.emitted).toHaveLength(2);
            expectErased(cryptoGate.emitted);
            cryptoGate.shortRandomSize = 0;
        }

        existing.revoke();
    });

    it('reserves failed encryption nonces and erases plaintext on every issue outcome', () => {
        const subject = new tokenApi.V12VoiceFileTokens(accountA);
        const before = packedToken(subject.issue(voiceUrl)).subarray(0, 12);
        cryptoGate.failCipher = true;
        const error = errorFrom(() => subject.issue(voiceUrl));
        expect(error.message).toBe('voice file token unavailable');
        expect(error.stack).not.toContain('SYNTHETIC_CIPHER_FAILURE');
        cryptoGate.failCipher = false;
        cryptoGate.failCipherUpdate = true;
        expect(errorFrom(() => subject.issue(voiceUrl)).message).toBe(
            'voice file token unavailable',
        );
        cryptoGate.failCipherUpdate = false;
        const after = packedToken(subject.issue(voiceUrl)).subarray(0, 12);
        expect(after.subarray(0, 4)).toEqual(before.subarray(0, 4));
        expect(after.readBigUInt64BE(4) - before.readBigUInt64BE(4)).toBe(3n);
        expectErased(cryptoGate.plaintextInputs);
        subject.revoke();
    });

    it('maps pre-final provider faults to fixed errors and final faults to null', () => {
        const subject = new tokenApi.V12VoiceFileTokens(accountA);
        const id = subject.issue(voiceUrl);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

        try {
            for (const stage of ['create', 'aad', 'tag', 'update'] as const) {
                cryptoGate.failDecipher = stage;
                const error = errorFrom(() => subject.redeem(id));
                expect(error.message).toBe('voice file token unavailable');
                const diagnostic = [error.message, error.stack, String(error.cause ?? '')].join(
                    '\n',
                );

                for (const secret of [
                    'SYNTHETIC_DECIPHER',
                    privateMarker,
                    voiceUrl,
                    accountA,
                    id,
                ]) {
                    expect(diagnostic).not.toContain(secret);
                }
            }

            cryptoGate.failDecipher = 'final';
            expect(subject.redeem(id)).toBeNull();
            expectErased(cryptoGate.plaintextParts);
            cryptoGate.failDecipher = '';
            expect(subject.redeem(id)).toBe(voiceUrl);
            expect(errors).not.toHaveBeenCalled();
            expect(warnings).not.toHaveBeenCalled();
        } finally {
            errors.mockRestore();
            warnings.mockRestore();
            subject.revoke();
        }
    });

    it('keeps image and voice error mapping and invalid-handle behavior aligned', () => {
        const pairs = [
            [new tokenApi.V12ImageFileTokens(accountA), 'image'],
            [new tokenApi.V12VoiceFileTokens(accountA), 'voice'],
        ] as const;

        for (const [subject, name] of pairs) {
            expect(errorFrom(() => subject.issue('')).message).toBe(
                `${name} file token unavailable`,
            );
            const id = subject.issue(voiceUrl);
            cryptoGate.failDecipher = 'create';
            expect(errorFrom(() => subject.redeem(id)).message).toBe(
                `${name} file token unavailable`,
            );
            cryptoGate.failDecipher = '';
            const prefix =
                name === 'image'
                    ? tokenApi.V12_IMAGE_TOKEN_PREFIX
                    : tokenApi.V12_VOICE_TOKEN_PREFIX;
            const bytes = packedToken(id, prefix);
            bytes[bytes.length - 1] ^= 1;
            expect(subject.redeem(prefix + bytes.toString('base64url'))).toBeNull();
            subject.revoke();
            expect(subject.redeem(id)).toBeNull();
            expect(errorFrom(() => subject.issue(voiceUrl)).message).toBe(
                `${name} file token unavailable`,
            );
        }
    });

    it('does not issue or redeem after reentrant revocation during a crypto operation', () => {
        const issuers = [
            [new tokenApi.V12ImageFileTokens(accountA), 'image'],
            [new tokenApi.V12VoiceFileTokens(accountA), 'voice'],
        ] as const;

        for (const [subject, name] of issuers) {
            cryptoGate.afterCipherAAD = () => subject.revoke();
            expect(errorFrom(() => subject.issue(voiceUrl)).message).toBe(
                `${name} file token unavailable`,
            );
            expect(cryptoGate.afterCipherAAD).toBeNull();
        }

        const redeemers = [
            new tokenApi.V12ImageFileTokens(accountA),
            new tokenApi.V12VoiceFileTokens(accountA),
        ];

        for (const subject of redeemers) {
            const id = subject.issue(voiceUrl);
            cryptoGate.afterDecipherUpdate = () => subject.revoke();
            expect(subject.redeem(id)).toBeNull();
            expect(cryptoGate.afterDecipherUpdate).toBeNull();
        }

        expectErased(cryptoGate.plaintextInputs);
        expectErased(cryptoGate.plaintextParts);
    });

    it('revokes idempotently and wipes the key, prefix, AAD and plaintext buffers', () => {
        cryptoGate.fixedRandom = true;
        const subject = new tokenApi.V12VoiceFileTokens(accountA);
        const [key, noncePrefix] = cryptoGate.emitted;
        const id = subject.issue(voiceUrl);
        expect(key).toEqual(Buffer.alloc(32, 0x42));
        expect(noncePrefix).toEqual(Buffer.alloc(4, 0x24));
        expect(subject.redeem(id)).toBe(voiceUrl);
        expectErased(cryptoGate.plaintextInputs);
        expectErased(cryptoGate.plaintextParts);
        expect(cryptoGate.aadBuffers).toHaveLength(1);
        expect(cryptoGate.aadBuffers[0].toString('utf8')).toBe(
            JSON.stringify(['jiyu-onebot12-voice-v1', 'qq', accountA]),
        );

        subject.revoke();
        expectErased([key, noncePrefix, ...cryptoGate.aadBuffers]);
        expect(subject.redeem(id)).toBeNull();
        expect(() => subject.revoke()).not.toThrow();
        const error = errorFrom(() => subject.issue(voiceUrl));
        expect(error.message).toBe('voice file token unavailable');
        expect(error.message).not.toContain(voiceUrl);
        expect(error.message).not.toContain(privateMarker);
        expect(error.message).not.toContain(accountA);
        expect(error.message).not.toContain(id);
        expect(errorFrom(() => subject.issue('')).message).toBe(error.message);
    });
});
