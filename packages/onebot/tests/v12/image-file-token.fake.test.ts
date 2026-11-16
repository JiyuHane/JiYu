import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only the test-specific switches are fake: normal random bytes and all AES-GCM
// operations come from Node. No module-cache or global mock reset is necessary.
const cryptoGate = vi.hoisted(() => ({
    failRandomSize: 0,
    shortRandomSize: 0,
    fixedRandom: false,
    failCipher: false,
    failDecipher: false,
    decipherCalls: 0,
    decipherFinalCalls: 0,
    decipherFinalFailures: 0,
    replacementPlaintext: null as Uint8Array | null,
    randomSizes: [] as number[],
    emitted: [] as Buffer[],
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
            throw new Error('SYNTHETIC_RANDOM_SOURCE_FAILURE');
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

        const cipher = actual.createCipheriv(...args);
        const replacement = cryptoGate.replacementPlaintext;

        if (replacement !== null) {
            cryptoGate.replacementPlaintext = null;
            const update = cipher.update.bind(cipher);
            // Produce a genuinely authenticated synthetic payload that normal
            // issue() validation would prevent. The real cipher still makes its tag.
            cipher.update = ((_data: NodeJS.ArrayBufferView) =>
                update(Buffer.from(replacement))) as typeof cipher.update;
        }

        return cipher;
    }) as typeof actual.createCipheriv;

    const createDecipheriv = ((...args: Parameters<typeof actual.createDecipheriv>) => {
        cryptoGate.decipherCalls += 1;

        if (cryptoGate.failDecipher) {
            throw new Error('SYNTHETIC_DECIPHER_ENGINE_FAILURE');
        }

        const decipher = actual.createDecipheriv(...args);
        const final = decipher.final.bind(decipher);
        decipher.final = ((outputEncoding?: BufferEncoding) => {
            cryptoGate.decipherFinalCalls += 1;

            try {
                return outputEncoding === undefined ? final() : final(outputEncoding);
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

function resetCryptoGate() {
    cryptoGate.failRandomSize = 0;
    cryptoGate.shortRandomSize = 0;
    cryptoGate.fixedRandom = false;
    cryptoGate.failCipher = false;
    cryptoGate.failDecipher = false;
    cryptoGate.decipherCalls = 0;
    cryptoGate.decipherFinalCalls = 0;
    cryptoGate.decipherFinalFailures = 0;
    cryptoGate.replacementPlaintext = null;
    cryptoGate.randomSizes.length = 0;
    cryptoGate.emitted.length = 0;
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
    // Import after installing guards, including on the first module evaluation.
    tokenApi = await import('../../src/v12/image-file-token');
});

afterEach(() => {
    const fetchCalls = fetchGuard.mock.calls.length;
    const webSocketCalls = webSocketGuard.mock.calls.length;
    const networkCalls = networkGuards.map((guard) => guard.mock.calls.length);

    for (const guard of networkGuards) {
        guard.mockRestore();
    }

    vi.unstubAllGlobals();
    resetCryptoGate();
    expect(fetchCalls).toBe(0);
    expect(webSocketCalls).toBe(0);
    expect(networkCalls).toEqual(networkCalls.map(() => 0));
});

const accountA = '10001';
const accountB = '10002';
const privateMarker = 'SYNTHETIC_PRIVATE_QUERY_7D32';
const imageUrl = `https://fixture.invalid/图片/🪶?sig=${privateMarker}&raw=%2f%2F+%20#view`;

function packedToken(id: string): Buffer {
    const { V12_IMAGE_TOKEN_PREFIX: prefix } = tokenApi;
    expect(id.startsWith(prefix)).toBe(true);
    const encoded = id.slice(prefix.length);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    const bytes = Buffer.from(encoded, 'base64url');
    expect(bytes.toString('base64url')).toBe(encoded);
    return bytes;
}

function tokenFromBytes(bytes: Uint8Array): string {
    return tokenApi.V12_IMAGE_TOKEN_PREFIX + Buffer.from(bytes).toString('base64url');
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

describe('V12 image file token local synthetic fixtures', () => {
    it('reserves its exact prefix and round-trips opaque UTF-8 and query snapshots', () => {
        const { V12ImageFileTokens, V12_IMAGE_TOKEN_PREFIX: prefix, isV12ImageToken } = tokenApi;
        expect(prefix).toBe('jiyu-image:v1:');
        const subject = new V12ImageFileTokens(accountA);
        const urls = [
            imageUrl,
            'HTTP://EXAMPLE.COM:80/a/../b?token=%2f#frag',
            'http://[2001:db8::1]:8080/a?token=%2F',
            'https://fixture.invalid/@path?token=a@b%20c',
        ];

        for (const url of urls) {
            const id = subject.issue(url);
            const packed = packedToken(id);
            expect(isV12ImageToken(id)).toBe(true);
            expect(id.length).toBeLessThanOrEqual(4096);
            expect(packed.length).toBe(12 + Buffer.byteLength(url, 'utf8') + 16);
            expect(id).not.toContain(url);
            expect(id).not.toContain(privateMarker);
            expect(packed.includes(Buffer.from(url, 'utf8'))).toBe(false);
            expect(subject.redeem(id)).toBe(url);
            expect(subject.redeem(id)).toBe(url);
        }

        expect(isV12ImageToken(prefix)).toBe(true);
        expect(isV12ImageToken(prefix + '!')).toBe(true);
        expect(isV12ImageToken('')).toBe(false);
        expect(isV12ImageToken(imageUrl)).toBe(false);
        expect(isV12ImageToken('jiyu-image:v2:abc')).toBe(false);
        expect(isV12ImageToken('Jiyu-image:v1:abc')).toBe(false);
        expect(isV12ImageToken('x' + subject.issue(imageUrl))).toBe(false);
    });

    it('uses distinct 12-byte nonces with a stable prefix and consecutive counters', () => {
        const subject = new tokenApi.V12ImageFileTokens(accountA);
        const ids = Array.from({ length: 128 }, () => subject.issue(imageUrl));
        expect(new Set(ids).size).toBe(ids.length);
        const nonces = ids.map((id) => packedToken(id).subarray(0, 12));
        expect(new Set(nonces.map((nonce) => nonce.toString('hex'))).size).toBe(ids.length);
        expect(new Set(nonces.map((nonce) => nonce.subarray(0, 4).toString('hex'))).size).toBe(1);

        // The contract specifies a counter, not its byte order.
        const consecutive = (order: 'BE' | 'LE') =>
            nonces.slice(1).every((nonce, index) => {
                const previous = nonces[index];
                const now = order === 'BE' ? nonce.readBigUInt64BE(4) : nonce.readBigUInt64LE(4);
                const before =
                    order === 'BE' ? previous.readBigUInt64BE(4) : previous.readBigUInt64LE(4);
                return now === before + 1n;
            });
        expect(consecutive('BE') || consecutive('LE')).toBe(true);

        for (const id of ids) {
            expect(subject.redeem(id)).toBe(imageUrl);
        }
    });

    it('isolates accounts and distinct instances of the same account', () => {
        const a = new tokenApi.V12ImageFileTokens(accountA);
        const anotherA = new tokenApi.V12ImageFileTokens(accountA);
        const b = new tokenApi.V12ImageFileTokens(accountB);
        const aId = a.issue(imageUrl);
        const bUrl = 'https://fixture.invalid/b?sig=SYNTHETIC_B';
        const bId = b.issue(bUrl);

        expect(a.redeem(aId)).toBe(imageUrl);
        expect(b.redeem(bId)).toBe(bUrl);
        expect(anotherA.redeem(aId)).toBeNull();
        expect(b.redeem(aId)).toBeNull();
        expect(a.redeem(bId)).toBeNull();
        expect(anotherA.redeem(bId)).toBeNull();
    });

    it('binds the account in authenticated data even under a forced key collision', () => {
        // Deliberately repeat the random bytes only in this test: a same-account
        // control demonstrates that the key and other authenticated data match.
        cryptoGate.fixedRandom = true;
        const a = new tokenApi.V12ImageFileTokens(accountA);
        const sameAccountControl = new tokenApi.V12ImageFileTokens(accountA);
        const b = new tokenApi.V12ImageFileTokens(accountB);
        const id = a.issue(imageUrl);
        expect(sameAccountControl.redeem(id)).toBe(imageUrl);
        expect(b.redeem(id)).toBeNull();
    });

    it('rejects nonce, ciphertext and tag bit flips and parts spliced from another URL', () => {
        const subject = new tokenApi.V12ImageFileTokens(accountA);
        const a = packedToken(subject.issue(imageUrl));
        const otherUrl = 'https://fixture.invalid/another?token=SYNTHETIC_OTHER';
        const b = packedToken(subject.issue(otherUrl));
        const offsets = [0, 4, 11, 12, a.length - 17, a.length - 16, a.length - 1];

        for (const offset of offsets) {
            const changed = Buffer.from(a);
            changed[offset] ^= 1;
            expect(subject.redeem(tokenFromBytes(changed))).toBeNull();
        }

        const differentNonce = Buffer.from(a);
        b.copy(differentNonce, 0, 0, 12);
        const differentTag = Buffer.concat([a.subarray(0, -16), b.subarray(-16)]);
        const differentCiphertext = Buffer.concat([
            a.subarray(0, 12),
            b.subarray(12, -16),
            a.subarray(-16),
        ]);

        for (const changed of [differentNonce, differentTag, differentCiphertext]) {
            expect(subject.redeem(tokenFromBytes(changed))).toBeNull();
        }
    });

    it('distinguishes decipher initialization failures from bad tags through the dispatcher', async () => {
        const { V12Dispatcher } = await import('../../src/v12/dispatcher');
        const subject = new tokenApi.V12ImageFileTokens(accountA);
        const id = subject.issue(imageUrl);
        const resolveImageFileUrl = vi.fn((fileId: string) => subject.redeem(fileId));
        const legacyHandle = vi.fn(async () => ({
            status: 'ok' as const,
            retcode: 0,
            data: { file_name: 'fallback.png', url: 'https://fixture.invalid/fallback' },
        }));
        const dispatcher = new V12Dispatcher({
            self: { platform: 'qq', user_id: accountA },
            version: { impl: 'synthetic', version: '1' },
            api: { handle: legacyHandle },
            getStatus: () => ({ good: true, online: true }),
            getSentMessageTime: () => null,
            resolveImageFileUrl,
        });
        const request = (fileId: string) => ({
            action: 'get_file',
            params: { file_id: fileId, type: 'url' },
            echo: 'e',
        });
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

        try {
            expect(subject.redeem(id)).toBe(imageUrl);
            expect(await dispatcher.handle(request(id))).toEqual({
                status: 'ok',
                retcode: 0,
                data: { name: '', url: imageUrl },
                message: '',
                echo: 'e',
            });
            expect(resolveImageFileUrl).toHaveBeenCalledExactlyOnceWith(id);
            resolveImageFileUrl.mockClear();

            const callsBeforeFailure = cryptoGate.decipherCalls;
            const finalsBeforeFailure = cryptoGate.decipherFinalCalls;
            cryptoGate.failDecipher = true;
            const error = errorFrom(() => subject.redeem(id));
            expect(error.message).toBe('image file token unavailable');
            const unavailable = await dispatcher.handle(request(id));
            expect(unavailable).toEqual({
                status: 'failed',
                retcode: 20002,
                data: null,
                message: 'file unavailable',
                echo: 'e',
            });
            expect(resolveImageFileUrl).toHaveBeenCalledExactlyOnceWith(id);
            expect(cryptoGate.decipherCalls).toBe(callsBeforeFailure + 2);
            expect(cryptoGate.decipherFinalCalls).toBe(finalsBeforeFailure);
            expect(legacyHandle).not.toHaveBeenCalled();

            cryptoGate.failDecipher = false;
            expect(subject.redeem(id)).toBe(imageUrl);
            resolveImageFileUrl.mockClear();
            const tampered = packedToken(id);
            tampered[tampered.length - 1] ^= 1;
            const badTagId = tokenFromBytes(tampered);
            const finalCalls = cryptoGate.decipherFinalCalls;
            const finalFailures = cryptoGate.decipherFinalFailures;
            expect(subject.redeem(badTagId)).toBeNull();
            const invalid = await dispatcher.handle(request(badTagId));
            expect(invalid).toEqual({
                status: 'failed',
                retcode: 20001,
                data: null,
                message: 'invalid file result',
                echo: 'e',
            });
            // Both rejections must reach real AES-GCM authentication, rather
            // than merely failing a prefix or base64 parsing precheck.
            expect(cryptoGate.decipherFinalCalls).toBe(finalCalls + 2);
            expect(cryptoGate.decipherFinalFailures).toBe(finalFailures + 2);
            expect(resolveImageFileUrl).toHaveBeenCalledExactlyOnceWith(badTagId);
            expect(legacyHandle).not.toHaveBeenCalled();

            const diagnostic = [
                error.message,
                error.stack,
                String(error.cause ?? ''),
                JSON.stringify([unavailable, invalid, errors.mock.calls, warnings.mock.calls]),
            ].join('\n');

            for (const secret of [
                'SYNTHETIC_DECIPHER_ENGINE_FAILURE',
                privateMarker,
                imageUrl,
                id,
                badTagId,
            ]) {
                expect(diagnostic).not.toContain(secret);
            }
        } finally {
            errors.mockRestore();
            warnings.mockRestore();
        }
    });

    it('rejects empty, short, truncated, bad-tag, noncanonical and oversized IDs', () => {
        const subject = new tokenApi.V12ImageFileTokens(accountA);
        const { V12_IMAGE_TOKEN_PREFIX: prefix } = tokenApi;
        let id = subject.issue('https://fixture.invalid/a');

        if (id.slice(prefix.length).length % 4 === 0) {
            id = subject.issue('https://fixture.invalid/aa');
        }

        const encoded = id.slice(prefix.length);
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        const last = alphabet.indexOf(encoded[encoded.length - 1]);
        expect([2, 3]).toContain(encoded.length % 4);
        const noncanonical = encoded.slice(0, -1) + alphabet[last + 1];
        // A permissive decoder sees identical bytes; canonical base64url must reject it.
        expect(Buffer.from(noncanonical, 'base64url')).toEqual(Buffer.from(encoded, 'base64url'));
        const malformed = [
            '',
            prefix,
            prefix + 'A',
            prefix + '=',
            prefix + Buffer.alloc(11).toString('base64url'),
            prefix + Buffer.alloc(28).toString('base64url'),
            prefix + Buffer.alloc(29).toString('base64url'),
            id.slice(0, -1),
            id.slice(0, -8),
            id + '=',
            id + '==',
            prefix + noncanonical,
            prefix + encoded.slice(0, 3) + '+' + encoded.slice(4),
            prefix + encoded.slice(0, 3) + '/' + encoded.slice(4),
            prefix + encoded.slice(0, 3) + ' ' + encoded.slice(4),
            prefix + encoded.slice(0, 3) + '\n' + encoded.slice(4),
            prefix + 'A'.repeat(4096 - prefix.length),
            prefix + 'A'.repeat(4097 - prefix.length),
            imageUrl,
        ];

        for (const value of malformed) {
            expect(subject.redeem(value)).toBeNull();
        }

        for (const value of [null, undefined, 0, {}, []]) {
            expect(subject.redeem(value as unknown as string)).toBeNull();
        }
    });

    it('accepts permitted URL forms and rejects unsafe or malformed issue inputs', () => {
        const subject = new tokenApi.V12ImageFileTokens(accountA);
        const invalid = [
            '',
            'ftp://fixture.invalid/file',
            'file:///tmp/fixture',
            'data:text/plain,fixture',
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
            'https://fixture.invalid/' + String.fromCharCode(0),
            'https://fixture.invalid/' + String.fromCharCode(0xd800),
            'https://fixture.invalid/' + String.fromCharCode(0xdc00),
        ];

        for (const url of invalid) {
            const error = errorFrom(() => subject.issue(url));
            expect(error.message).not.toContain(privateMarker);

            if (url.length > 0) {
                expect(error.message).not.toContain(url);
            }
        }

        expect(subject.redeem(subject.issue(imageUrl))).toBe(imageUrl);
    });

    it('enforces the 3000 UTF-8-byte URL limit and the 4096-character ID limit', () => {
        const subject = new tokenApi.V12ImageFileTokens(accountA);
        const base = 'https://fixture.invalid/';
        const below = base + 'x'.repeat(2999 - Buffer.byteLength(base));
        const atLimit = base + 'x'.repeat(3000 - Buffer.byteLength(base) - 4) + '🪶';
        const above = atLimit + 'x';
        expect(Buffer.byteLength(below, 'utf8')).toBe(2999);
        expect(Buffer.byteLength(atLimit, 'utf8')).toBe(3000);
        expect(Buffer.byteLength(above, 'utf8')).toBe(3001);
        // UTF-16 length alone would incorrectly admit the multibyte over-limit case.
        expect(above.length).toBeLessThanOrEqual(3000);

        for (const url of [below, atLimit]) {
            const id = subject.issue(url);
            expect(id.length).toBeLessThanOrEqual(4096);
            expect(packedToken(id).length).toBe(12 + Buffer.byteLength(url, 'utf8') + 16);
            expect(subject.redeem(id)).toBe(url);
        }

        const error = errorFrom(() => subject.issue(above));
        expect(error.message).not.toContain(above);
        const prefix = tokenApi.V12_IMAGE_TOKEN_PREFIX;
        const limitId = prefix + 'A'.repeat(4096 - prefix.length);
        expect(limitId.length).toBe(4096);
        expect(subject.redeem(limitId)).toBeNull();
        expect(subject.redeem(limitId + 'A')).toBeNull();
    });

    it('revalidates authenticated plaintext, including URL rules, UTF-8 and byte bounds', () => {
        const subject = new tokenApi.V12ImageFileTokens(accountA);
        const replacement = 'https://fixture.invalid/replacement?sig=SYNTHETIC_REPLACEMENT';
        cryptoGate.replacementPlaintext = Buffer.from(replacement, 'utf8');
        const control = subject.issue(imageUrl);
        expect(cryptoGate.replacementPlaintext).toBeNull();
        // This control confirms that the injected bytes carry a valid real GCM tag.
        expect(subject.redeem(control)).toBe(replacement);

        const prefix = 'https://fixture.invalid/';
        const invalidUtf8 = Buffer.concat([Buffer.from(prefix), Buffer.from([0xc0, 0xaf])]);
        const tooLong = Buffer.from(prefix + 'x'.repeat(3001 - Buffer.byteLength(prefix)));
        const invalidPayloads = [
            Buffer.from('file:///tmp/synthetic-file'),
            Buffer.from('https://user@fixture.invalid/'),
            Buffer.from('https://fixture.invalid/path with space'),
            Buffer.from('https://fixture.invalid/%zz'),
            invalidUtf8,
            tooLong,
        ];
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});

        try {
            for (const payload of invalidPayloads) {
                cryptoGate.replacementPlaintext = payload;
                const id = subject.issue(imageUrl);
                expect(cryptoGate.replacementPlaintext).toBeNull();
                expect(subject.redeem(id)).toBeNull();
            }

            const diagnostics = JSON.stringify([errors.mock.calls, warnings.mock.calls]);
            expect(diagnostics).not.toContain(privateMarker);
            expect(diagnostics).not.toContain('SYNTHETIC_REPLACEMENT');
            expect(diagnostics).not.toContain('synthetic-file');
        } finally {
            errors.mockRestore();
            warnings.mockRestore();
        }
    });

    it('handles random-source throws and short output without corrupting other instances', () => {
        const existing = new tokenApi.V12ImageFileTokens(accountA);
        const existingId = existing.issue(imageUrl);

        for (const size of [32, 4]) {
            cryptoGate.emitted.length = 0;
            cryptoGate.randomSizes.length = 0;
            cryptoGate.failRandomSize = size;
            const error = errorFrom(() => new tokenApi.V12ImageFileTokens(accountB));
            expect(cryptoGate.randomSizes).toContain(size);
            expect(error.message).not.toContain('SYNTHETIC_RANDOM_SOURCE_FAILURE');
            expect(error.message).not.toContain(accountB);

            if (size === 4) {
                expect(cryptoGate.emitted).toHaveLength(1);
                expect(cryptoGate.emitted[0]).toEqual(Buffer.alloc(32));
            }

            cryptoGate.failRandomSize = 0;
            expect(existing.redeem(existingId)).toBe(imageUrl);
        }

        for (const size of [32, 4]) {
            cryptoGate.shortRandomSize = size;
            expect(() => new tokenApi.V12ImageFileTokens(accountB)).toThrow();
            cryptoGate.shortRandomSize = 0;
        }

        const fresh = new tokenApi.V12ImageFileTokens(accountB);
        expect(fresh.redeem(fresh.issue(imageUrl))).toBe(imageUrl);
        expect(existing.redeem(existing.issue(imageUrl))).toBe(imageUrl);
    });

    it('does not reuse a reserved nonce after an encryption exception', () => {
        const subject = new tokenApi.V12ImageFileTokens(accountA);
        const before = packedToken(subject.issue(imageUrl)).subarray(0, 12);
        cryptoGate.failCipher = true;
        const error = errorFrom(() => subject.issue(imageUrl));
        expect(error.message).not.toContain('SYNTHETIC_CIPHER_FAILURE');
        expect(error.message).not.toContain(privateMarker);
        cryptoGate.failCipher = false;
        const after = packedToken(subject.issue(imageUrl)).subarray(0, 12);
        expect(after.subarray(0, 4)).toEqual(before.subarray(0, 4));
        expect(after.equals(before)).toBe(false);
        const differenceBE = after.readBigUInt64BE(4) - before.readBigUInt64BE(4);
        const differenceLE = after.readBigUInt64LE(4) - before.readBigUInt64LE(4);
        expect(differenceBE === 2n || differenceLE === 2n).toBe(true);
    });

    it('revokes idempotently, wipes retained random buffers and emits a fixed safe error', () => {
        cryptoGate.fixedRandom = true;
        const subject = new tokenApi.V12ImageFileTokens(accountA);
        const [key, noncePrefix] = cryptoGate.emitted;
        expect(key).toEqual(Buffer.alloc(32, 0x42));
        expect(noncePrefix).toEqual(Buffer.alloc(4, 0x24));
        const id = subject.issue(imageUrl);
        expect(subject.redeem(id)).toBe(imageUrl);

        subject.revoke();
        expect(key).toEqual(Buffer.alloc(32));
        expect(noncePrefix).toEqual(Buffer.alloc(4));
        expect(subject.redeem(id)).toBeNull();
        expect(() => subject.revoke()).not.toThrow();
        expect(subject.redeem(id)).toBeNull();
        const first = errorFrom(() => subject.issue(imageUrl));
        const second = errorFrom(() => subject.issue('https://fixture.invalid/different'));
        const invalid = errorFrom(() => subject.issue(''));
        expect(first.message.length).toBeGreaterThan(0);
        expect(second.message).toBe(first.message);
        expect(invalid.message).toBe(first.message);
        expect(first.message).not.toContain(imageUrl);
        expect(first.message).not.toContain(privateMarker);
        expect(first.message).not.toContain(accountA);
        expect(first.message).not.toContain(id);
    });
});
