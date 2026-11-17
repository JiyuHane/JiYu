import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep this file in its own Vitest process. Ordinary crypto calls use Node's
// in-memory provider; the switches below inject only the selected test fault.
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
    randomBuffers: [] as Buffer[],
    aadBuffers: [] as Buffer[],
    plaintextInputs: [] as Buffer[],
    plaintextParts: [] as Buffer[],
    decipherCalls: 0,
    finalCalls: 0,
    finalFailures: 0,
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
        cryptoGate.randomBuffers.push(bytes);

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
            cryptoGate.finalCalls += 1;

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
                cryptoGate.finalFailures += 1;
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
        default: {
            ...(actual as typeof actual & { default: typeof actual }).default,
            randomBytes,
            createCipheriv,
            createDecipheriv,
        },
    };
});

let tokenApi: typeof import('../../src/v12/image-file-token');
let fetchGuard: ReturnType<typeof vi.fn>;
let webSocketGuard: ReturnType<typeof vi.fn>;
let networkGuards: Array<{ mock: { calls: unknown[] }; mockRestore: () => unknown }>;

function blockedNetwork(): never {
    throw new Error('unexpected network operation in video token fixture');
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
    cryptoGate.randomBuffers.length = 0;
    cryptoGate.aadBuffers.length = 0;
    cryptoGate.plaintextInputs.length = 0;
    cryptoGate.plaintextParts.length = 0;
    cryptoGate.decipherCalls = 0;
    cryptoGate.finalCalls = 0;
    cryptoGate.finalFailures = 0;
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
        vi.spyOn(http, 'get').mockImplementation(blockedNetwork),
        vi.spyOn(https, 'get').mockImplementation(blockedNetwork),
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
const secretMarker = 'SYNTHETIC_VIDEO_SECRET_79E4';
const videoUrl = `https://fixture.invalid/视频/🪶?sig=${secretMarker}&raw=%2f%2F+%20#view`;

function packedToken(id: string, prefix = tokenApi.V12_VIDEO_TOKEN_PREFIX): Buffer {
    expect(id.startsWith(prefix)).toBe(true);
    const encoded = id.slice(prefix.length);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    const bytes = Buffer.from(encoded, 'base64url');
    expect(bytes.toString('base64url')).toBe(encoded);
    return bytes;
}

function tokenFromBytes(bytes: Uint8Array): string {
    return tokenApi.V12_VIDEO_TOKEN_PREFIX + Buffer.from(bytes).toString('base64url');
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

describe('V12 video file token local synthetic fixtures', () => {
    it('reserves its namespace and round-trips an opaque URL without fetching it', () => {
        const { V12VideoFileTokens, V12_VIDEO_TOKEN_PREFIX: prefix, isV12VideoToken } = tokenApi;
        expect(prefix).toBe('jiyu-video:v1:');
        const subject = new V12VideoFileTokens(accountA);
        const urls = [
            videoUrl,
            'HTTP://EXAMPLE.COM:80/a/../b?token=%2f#frag',
            'http://[2001:db8::1]:8080/a?token=%2F',
            'https://fixture.invalid/@path?token=a@b%20c',
        ];

        for (const url of urls) {
            const id = subject.issue(url);
            const packed = packedToken(id);
            expect(isV12VideoToken(id)).toBe(true);
            expect(id.length).toBeLessThanOrEqual(4096);
            expect(packed.length).toBe(12 + Buffer.byteLength(url, 'utf8') + 16);
            expect(id).not.toContain(url);
            expect(id).not.toContain(secretMarker);
            expect(packed.includes(Buffer.from(url, 'utf8'))).toBe(false);
            expect(subject.redeem(id)).toBe(url);
            expect(subject.redeem(id)).toBe(url);
        }

        expect(cryptoGate.randomSizes).toEqual([32, 4]);
        expect(isV12VideoToken(prefix)).toBe(true);
        expect(isV12VideoToken(prefix + '!')).toBe(true);
        expect(isV12VideoToken('jiyu-video:v2:abc')).toBe(false);
        expect(isV12VideoToken('Jiyu-video:v1:abc')).toBe(false);
        expect(isV12VideoToken(tokenApi.V12_IMAGE_TOKEN_PREFIX + 'abc')).toBe(false);
        expect(isV12VideoToken(tokenApi.V12_VOICE_TOKEN_PREFIX + 'abc')).toBe(false);
        expect(tokenApi.isV12ImageToken(prefix + 'abc')).toBe(false);
        expect(tokenApi.isV12VoiceToken(prefix + 'abc')).toBe(false);
        expect(isV12VideoToken(null as unknown as string)).toBe(false);
        subject.revoke();
    });

    it('uses the issuer lifetime rather than a ten-minute token TTL', () => {
        vi.useFakeTimers();
        let subject: InstanceType<typeof tokenApi.V12VideoFileTokens> | undefined;

        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            subject = new tokenApi.V12VideoFileTokens(accountA);
            const id = subject.issue(videoUrl);
            vi.setSystemTime(new Date('2026-01-01T02:00:00.000Z'));
            expect(subject.redeem(id)).toBe(videoUrl);
            subject.revoke();
            expect(subject.redeem(id)).toBeNull();
        } finally {
            subject?.revoke();
            vi.useRealTimers();
        }
        // A URL can expire at its own origin independently of this local handle.
    });

    it('preserves image and voice wire bytes and matches the video v1 format', async () => {
        const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
        // These deterministic duplicate keys/nonces are fixture-only.
        cryptoGate.fixedRandom = true;
        const nonce = Buffer.alloc(12);
        nonce.fill(0x24, 0, 4);
        nonce.writeBigUInt64BE(1n, 4);
        const cases = [
            [new tokenApi.V12ImageFileTokens(accountA), 'jiyu-image:v1:', 'jiyu-onebot12-image-v1'],
            [new tokenApi.V12VoiceFileTokens(accountA), 'jiyu-voice:v1:', 'jiyu-onebot12-voice-v1'],
            [new tokenApi.V12VideoFileTokens(accountA), 'jiyu-video:v1:', 'jiyu-onebot12-video-v1'],
        ] as const;

        for (const [subject, prefix, purpose] of cases) {
            const cipher = actual.createCipheriv('aes-256-gcm', Buffer.alloc(32, 0x42), nonce, {
                authTagLength: 16,
            });
            cipher.setAAD(Buffer.from(JSON.stringify([purpose, 'qq', accountA])));
            const ciphertext = Buffer.concat([
                cipher.update(Buffer.from(videoUrl)),
                cipher.final(),
            ]);
            const expected =
                prefix +
                Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64url');
            expect(subject.issue(videoUrl)).toBe(expected);
            expect(subject.redeem(expected)).toBe(videoUrl);
            subject.revoke();
        }
    });

    it('isolates separate issuers and accounts with independent random material', () => {
        const a = new tokenApi.V12VideoFileTokens(accountA);
        const anotherA = new tokenApi.V12VideoFileTokens(accountA);
        const b = new tokenApi.V12VideoFileTokens(accountB);
        expect(cryptoGate.randomSizes).toEqual([32, 4, 32, 4, 32, 4]);
        const keys = [0, 2, 4].map((index) => cryptoGate.randomBuffers[index].toString('hex'));
        expect(new Set(keys).size).toBe(3);
        const aId = a.issue(videoUrl);
        const bUrl = 'https://fixture.invalid/b?sig=SYNTHETIC_B';
        const bId = b.issue(bUrl);
        expect(a.redeem(aId)).toBe(videoUrl);
        expect(b.redeem(bId)).toBe(bUrl);
        expect(anotherA.redeem(aId)).toBeNull();
        expect(b.redeem(aId)).toBeNull();
        expect(a.redeem(bId)).toBeNull();
        expect(anotherA.redeem(bId)).toBeNull();
        a.revoke();
        anotherA.revoke();
        b.revoke();
    });

    it('authenticates account and all three purposes even with identical test keys and nonces', () => {
        // Deliberate fixture-only key/nonce collisions establish AAD domain
        // separation, not GCM safety under nonce reuse in production.
        cryptoGate.fixedRandom = true;
        const image = new tokenApi.V12ImageFileTokens(accountA);
        const voice = new tokenApi.V12VoiceFileTokens(accountA);
        const video = new tokenApi.V12VideoFileTokens(accountA);
        const videoControl = new tokenApi.V12VideoFileTokens(accountA);
        const differentAccount = new tokenApi.V12VideoFileTokens(accountB);
        const cases = [
            [image, tokenApi.V12_IMAGE_TOKEN_PREFIX, 'jiyu-onebot12-image-v1'],
            [voice, tokenApi.V12_VOICE_TOKEN_PREFIX, 'jiyu-onebot12-voice-v1'],
            [video, tokenApi.V12_VIDEO_TOKEN_PREFIX, 'jiyu-onebot12-video-v1'],
        ] as const;
        const ids = cases.map(([subject]) => subject.issue(videoUrl));
        const nonces = cases.map(([, prefix], index) =>
            packedToken(ids[index], prefix).subarray(0, 12),
        );

        for (let i = 0; i < cases.length; i += 1) {
            expect(cryptoGate.randomBuffers[2 * i]).toEqual(cryptoGate.randomBuffers[0]);
            expect(cryptoGate.randomBuffers[2 * i + 1]).toEqual(cryptoGate.randomBuffers[1]);
            expect(nonces[i]).toEqual(nonces[0]);
            expect(cryptoGate.aadBuffers[i].toString('utf8')).toBe(
                JSON.stringify([cases[i][2], 'qq', accountA]),
            );
            expect(cases[i][0].redeem(ids[i])).toBe(videoUrl);
        }

        expect(videoControl.redeem(ids[2])).toBe(videoUrl);
        const initialFailures = cryptoGate.finalFailures;
        expect(differentAccount.redeem(ids[2])).toBeNull();
        expect(cryptoGate.finalFailures).toBe(initialFailures + 1);
        const finalCalls = cryptoGate.finalCalls;
        const finalFailures = cryptoGate.finalFailures;

        for (let src = 0; src < cases.length; src += 1) {
            for (let dst = 0; dst < cases.length; dst += 1) {
                if (src === dst) {
                    continue;
                }

                expect(cases[dst][0].redeem(ids[src])).toBeNull();
                const altered = cases[dst][1] + ids[src].slice(cases[src][1].length);
                expect(cases[dst][0].redeem(altered)).toBeNull();
            }
        }

        // All six rewritten handles reached and failed real GCM authentication.
        expect(cryptoGate.finalCalls).toBe(finalCalls + 6);
        expect(cryptoGate.finalFailures).toBe(finalFailures + 6);
        image.revoke();
        voice.revoke();
        video.revoke();
        videoControl.revoke();
        differentAccount.revoke();
    });

    it('uses unique uint64 nonces and reserves counts on encryption or write failure', () => {
        const subject = new tokenApi.V12VideoFileTokens(accountA);
        const first = packedToken(subject.issue(videoUrl)).subarray(0, 12);
        const second = packedToken(subject.issue(videoUrl)).subarray(0, 12);
        expect(first.subarray(0, 4)).toEqual(second.subarray(0, 4));
        expect(first.readBigUInt64BE(4)).toBe(1n);
        expect(second.readBigUInt64BE(4)).toBe(2n);
        cryptoGate.failCipher = true;
        expect(errorFrom(() => subject.issue(videoUrl)).message).toBe(
            'video file token unavailable',
        );
        cryptoGate.failCipher = false;
        const write = vi.spyOn(Buffer.prototype, 'writeBigUInt64BE');

        try {
            write.mockImplementationOnce(() => {
                throw new RangeError('SYNTHETIC_UINT64_OVERFLOW');
            });
            const error = errorFrom(() => subject.issue(videoUrl));
            expect(error.message).toBe('video file token unavailable');
            expect(error.stack).not.toContain('SYNTHETIC_UINT64_OVERFLOW');
        } finally {
            write.mockRestore();
        }

        cryptoGate.failCipherUpdate = true;
        expect(errorFrom(() => subject.issue(videoUrl)).message).toBe(
            'video file token unavailable',
        );
        cryptoGate.failCipherUpdate = false;
        const after = packedToken(subject.issue(videoUrl)).subarray(0, 12);
        expect(after.subarray(0, 4)).toEqual(first.subarray(0, 4));
        expect(after.readBigUInt64BE(4)).toBe(6n);
        expectErased(cryptoGate.plaintextInputs);
        subject.revoke();
    });

    it('rejects mutated nonce, ciphertext and tag and erases unauthenticated plaintext', () => {
        const subject = new tokenApi.V12VideoFileTokens(accountA);
        const original = packedToken(subject.issue(videoUrl));
        const offsets = [
            0,
            4,
            11,
            12,
            original.length - 17,
            original.length - 16,
            original.length - 1,
        ];
        const failures = cryptoGate.finalFailures;

        for (const offset of offsets) {
            const changed = Buffer.from(original);
            changed[offset] ^= 1;
            expect(subject.redeem(tokenFromBytes(changed))).toBeNull();
        }

        const maxCounter = Buffer.from(original);
        maxCounter.fill(0xff, 4, 12);
        expect(subject.redeem(tokenFromBytes(maxCounter))).toBeNull();
        expect(cryptoGate.finalFailures).toBe(failures + offsets.length + 1);
        expectErased(cryptoGate.plaintextParts);
        subject.revoke();
    });

    it('validates account IDs, URL syntax, and 3000-byte and 4096-character limits', () => {
        for (const account of ['a'.repeat(128), 'é'.repeat(128), '🪶'.repeat(64)]) {
            const subject = new tokenApi.V12VideoFileTokens(account);
            expect(subject.redeem(subject.issue(videoUrl))).toBe(videoUrl);
            subject.revoke();
        }

        const invalidAccounts: unknown[] = [
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
            const error = errorFrom(() => new tokenApi.V12VideoFileTokens(account as string));
            expect(error.message).toBe('invalid video file token account');
            expect(cryptoGate.randomSizes).toHaveLength(before);
        }

        const subject = new tokenApi.V12VideoFileTokens(accountA);
        const base = 'https://fixture.invalid/';
        const below = base + 'x'.repeat(2999 - Buffer.byteLength(base));
        const atLimit = base + 'x'.repeat(3000 - Buffer.byteLength(base) - 4) + '🪶';
        const above = atLimit + 'x';
        const overChars = base + 'x'.repeat(3001 - base.length);
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
            overChars,
            'ftp://fixture.invalid/a',
            'file:///tmp/fixture',
            'data:text/plain,x',
            'https:fixture.invalid/a',
            'https:///fixture.invalid/a',
            'https://user:password@fixture.invalid/a',
            'https://@fixture.invalid/a',
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
            expect(tokenApi.isV12SealableFileUrl(url)).toBe(false);
            expect(errorFrom(() => subject.issue(url as string)).message).toBe(
                'video file token unavailable',
            );
        }

        const prefix = tokenApi.V12_VIDEO_TOKEN_PREFIX;
        const limitId = prefix + 'A'.repeat(4096 - prefix.length);
        expect(limitId.length).toBe(4096);
        expect(subject.redeem(limitId)).toBeNull();
        expect(subject.redeem(limitId + 'A')).toBeNull();
        subject.revoke();
    });

    it('maps preflight Buffer and URL failures without consuming a nonce', () => {
        const subject = new tokenApi.V12VideoFileTokens(accountA);
        const byteLength = vi.spyOn(Buffer, 'byteLength');

        try {
            byteLength.mockImplementationOnce(() => {
                throw new Error('SYNTHETIC_BYTE_LENGTH_FAILURE');
            });
            expect(errorFrom(() => subject.issue(videoUrl)).message).toBe(
                'video file token unavailable',
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
            expect(errorFrom(() => subject.issue(videoUrl)).message).toBe(
                'video file token unavailable',
            );
        } finally {
            vi.stubGlobal('URL', originalURL);
        }

        expect(packedToken(subject.issue(videoUrl)).readBigUInt64BE(4)).toBe(1n);
        subject.revoke();
    });

    it('rejects malformed and noncanonical base64url before using the provider', () => {
        const subject = new tokenApi.V12VideoFileTokens(accountA);
        const prefix = tokenApi.V12_VIDEO_TOKEN_PREFIX;
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
            prefix + encoded.slice(0, 3) + '\n' + encoded.slice(4),
            prefix + Buffer.alloc(12 + 3001 + 16).toString('base64url'),
            prefix + 'A'.repeat(4097 - prefix.length),
            videoUrl,
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

    it('revalidates genuinely authenticated plaintext with fatal UTF-8 and URL rules', () => {
        const subject = new tokenApi.V12VideoFileTokens(accountA);
        const replacement = 'https://fixture.invalid/replacement?sig=SYNTHETIC_REPLACEMENT';
        cryptoGate.replacementPlaintext = Buffer.from(replacement);
        const control = subject.issue(videoUrl);
        expect(cryptoGate.replacementPlaintext).toBeNull();
        expect(subject.redeem(control)).toBe(replacement);
        const base = 'https://fixture.invalid/';
        const invalid = [
            Buffer.from('file:///tmp/synthetic-file'),
            Buffer.from('https://user@fixture.invalid/'),
            Buffer.from('https://fixture.invalid/path with space'),
            Buffer.from('https://fixture.invalid/%zz'),
            Buffer.concat([Buffer.from(base), Buffer.from([0xc0, 0xaf])]),
            Buffer.from(base + 'x'.repeat(3001 - Buffer.byteLength(base))),
        ];

        for (const payload of invalid) {
            cryptoGate.replacementPlaintext = payload;
            const id = subject.issue(videoUrl);
            expect(cryptoGate.replacementPlaintext).toBeNull();
            expect(subject.redeem(id)).toBeNull();
        }

        expectErased(cryptoGate.plaintextInputs);
        expectErased(cryptoGate.plaintextParts);
        subject.revoke();
    });

    it('maps random-source failures and wipes partially allocated material', () => {
        const existing = new tokenApi.V12VideoFileTokens(accountA);
        const existingId = existing.issue(videoUrl);

        for (const size of [32, 4]) {
            cryptoGate.randomBuffers.length = 0;
            cryptoGate.failRandomSize = size;
            const error = errorFrom(() => new tokenApi.V12VideoFileTokens(accountB));
            expect(error.message).toBe('video file token unavailable');
            expect(error.stack).not.toContain('SYNTHETIC_RANDOM_FAILURE');

            if (size === 4) {
                expect(cryptoGate.randomBuffers).toHaveLength(1);
                expectErased(cryptoGate.randomBuffers);
            }

            cryptoGate.failRandomSize = 0;
            expect(existing.redeem(existingId)).toBe(videoUrl);
        }

        for (const size of [32, 4]) {
            cryptoGate.randomBuffers.length = 0;
            cryptoGate.shortRandomSize = size;
            expect(errorFrom(() => new tokenApi.V12VideoFileTokens(accountB)).message).toBe(
                'video file token unavailable',
            );
            expect(cryptoGate.randomBuffers).toHaveLength(2);
            expectErased(cryptoGate.randomBuffers);
            cryptoGate.shortRandomSize = 0;
        }

        existing.revoke();
    });

    it('keeps provider errors distinct from bad tags without revealing secrets', () => {
        const subject = new tokenApi.V12VideoFileTokens(accountA);
        const id = subject.issue(videoUrl);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

        try {
            for (const stage of ['create', 'aad', 'tag', 'update'] as const) {
                cryptoGate.failDecipher = stage;
                const error = errorFrom(() => subject.redeem(id));
                expect(error.message).toBe('video file token unavailable');
                const diagnostic = [error.message, error.stack, String(error.cause ?? '')].join(
                    '\n',
                );

                for (const secret of ['SYNTHETIC_DECIPHER', secretMarker, videoUrl, accountA, id]) {
                    expect(diagnostic).not.toContain(secret);
                }
            }

            cryptoGate.failDecipher = 'final';
            expect(subject.redeem(id)).toBeNull();
            expectErased(cryptoGate.plaintextParts);
            cryptoGate.failDecipher = '';
            expect(subject.redeem(id)).toBe(videoUrl);
            expect(errors).not.toHaveBeenCalled();
            expect(warnings).not.toHaveBeenCalled();
        } finally {
            errors.mockRestore();
            warnings.mockRestore();
            subject.revoke();
        }
    });

    it('handles reentrant revoke during issue and redeem without releasing a handle or URL', () => {
        const issuing = new tokenApi.V12VideoFileTokens(accountA);
        cryptoGate.afterCipherAAD = () => issuing.revoke();
        expect(errorFrom(() => issuing.issue(videoUrl)).message).toBe(
            'video file token unavailable',
        );
        expect(cryptoGate.afterCipherAAD).toBeNull();
        const redeeming = new tokenApi.V12VideoFileTokens(accountA);
        const id = redeeming.issue(videoUrl);
        cryptoGate.afterDecipherUpdate = () => redeeming.revoke();
        expect(redeeming.redeem(id)).toBeNull();
        expect(cryptoGate.afterDecipherUpdate).toBeNull();
        expectErased(cryptoGate.plaintextInputs);
        expectErased(cryptoGate.plaintextParts);
    });

    it('revokes idempotently and wipes its key, nonce prefix, AAD and plaintext', () => {
        cryptoGate.fixedRandom = true;
        const subject = new tokenApi.V12VideoFileTokens(accountA);
        const [key, noncePrefix] = cryptoGate.randomBuffers;
        const id = subject.issue(videoUrl);
        expect(key).toEqual(Buffer.alloc(32, 0x42));
        expect(noncePrefix).toEqual(Buffer.alloc(4, 0x24));
        expect(subject.redeem(id)).toBe(videoUrl);
        expectErased(cryptoGate.plaintextInputs);
        expectErased(cryptoGate.plaintextParts);
        expect(cryptoGate.aadBuffers).toHaveLength(1);
        expect(cryptoGate.aadBuffers[0].toString('utf8')).toBe(
            JSON.stringify(['jiyu-onebot12-video-v1', 'qq', accountA]),
        );
        subject.revoke();
        expectErased([key, noncePrefix, ...cryptoGate.aadBuffers]);
        expect(subject.redeem(id)).toBeNull();
        expect(() => subject.revoke()).not.toThrow();
        const error = errorFrom(() => subject.issue(videoUrl));
        expect(error.message).toBe('video file token unavailable');
        expect(error.message).not.toContain(videoUrl);
        expect(error.message).not.toContain(secretMarker);
        expect(error.message).not.toContain(accountA);
        expect(error.message).not.toContain(id);
    });
});
