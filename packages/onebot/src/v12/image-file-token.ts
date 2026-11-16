import { createCipheriv, createDecipheriv, randomBytes, type DecipherGCM } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { classifyFileUrl } from './file-url';

/** Local OneBot 12 media handles, unrelated to QQ signatures or QQ encryption. */
export const V12_IMAGE_TOKEN_PREFIX = 'jiyu-image:v1:';
export const V12_VOICE_TOKEN_PREFIX = 'jiyu-voice:v1:';

const KEY_BYTES = 32;
const NONCE_PREFIX_BYTES = 4;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_URL_BYTES = 3000;
const MAX_TOKEN_LENGTH = 4096;
const MAX_ISSUES = 1n << 24n;
const MAX_ACCOUNT_CHARS = 128;
const MAX_ACCOUNT_BYTES = 256;

// These module-private frozen configurations are the only possible purposes.
// Each engine retains its selected configuration for its entire lifetime.
const IMAGE_PURPOSE = Object.freeze({
    prefix: V12_IMAGE_TOKEN_PREFIX,
    aad: 'jiyu-onebot12-image-v1',
    error: 'image file token unavailable',
    accountError: 'invalid image file token account',
    providerFailure: 'image token provider failure',
});
const VOICE_PURPOSE = Object.freeze({
    prefix: V12_VOICE_TOKEN_PREFIX,
    aad: 'jiyu-onebot12-voice-v1',
    error: 'voice file token unavailable',
    accountError: 'invalid voice file token account',
    providerFailure: 'voice token provider failure',
});
type TokenPurpose = typeof IMAGE_PURPOSE | typeof VOICE_PURPOSE;

/** Identifies the reserved namespace, including malformed or expired handles. */
export function isV12ImageToken(id: string): boolean {
    return typeof id === 'string' && id.startsWith(V12_IMAGE_TOKEN_PREFIX);
}

/** Identifies the reserved namespace, including malformed or expired handles. */
export function isV12VoiceToken(id: string): boolean {
    return typeof id === 'string' && id.startsWith(V12_VOICE_TOKEN_PREFIX);
}

/** Validates a sealable URL snapshot without issuing a handle or performing I/O. */
export function isV12SealableFileUrl(value: unknown): value is string {
    try {
        if (
            typeof value !== 'string' ||
            value.length === 0 ||
            value.length > MAX_URL_BYTES ||
            Buffer.byteLength(value, 'utf8') > MAX_URL_BYTES
        ) {
            return false;
        }

        const checked = classifyFileUrl(value);
        return checked.kind === 'valid' && checked.url === value;
    } catch {
        return false;
    }
}

function validAccountId(accountId: unknown): accountId is string {
    if (
        typeof accountId !== 'string' ||
        accountId.length === 0 ||
        accountId.length > MAX_ACCOUNT_CHARS ||
        Buffer.byteLength(accountId, 'utf8') > MAX_ACCOUNT_BYTES
    ) {
        return false;
    }

    for (let i = 0; i < accountId.length; i += 1) {
        const code = accountId.charCodeAt(i);

        if (code <= 0x1f || code === 0x7f) {
            return false;
        }

        if (code >= 0xd800 && code <= 0xdbff) {
            const next = accountId.charCodeAt(i + 1);

            if (!(next >= 0xdc00 && next <= 0xdfff)) {
                return false;
            }

            i += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return false;
        }
    }

    return true;
}

/**
 * An account-instance-local, self-contained URL snapshot handle. A handle stays
 * redeemable until this issuer is revoked, but its URL can expire independently.
 * It is a sensitive bearer reference, not proof of availability or file identity.
 */
class V12FileTokenEngine {
    readonly #purpose: TokenPurpose;
    #key: Buffer | null = null;
    #noncePrefix: Buffer | null = null;
    #aad: Buffer | null = null;
    #issued = 0n;

    constructor(accountId: string, purpose: TokenPurpose) {
        this.#purpose = purpose;

        if (!validAccountId(accountId)) {
            throw new Error(purpose.accountError);
        }

        const aad = Buffer.from(JSON.stringify([purpose.aad, 'qq', accountId]), 'utf8');
        let key: Buffer | undefined;
        let noncePrefix: Buffer | undefined;

        try {
            key = randomBytes(KEY_BYTES);
            noncePrefix = randomBytes(NONCE_PREFIX_BYTES);

            if (
                !Buffer.isBuffer(key) ||
                key.length !== KEY_BYTES ||
                !Buffer.isBuffer(noncePrefix) ||
                noncePrefix.length !== NONCE_PREFIX_BYTES
            ) {
                throw new Error(this.#purpose.error);
            }

            this.#key = key;
            this.#noncePrefix = noncePrefix;
            this.#aad = aad;
        } catch {
            // In particular, erase a generated key if nonce-prefix creation fails.
            key?.fill(0);
            noncePrefix?.fill(0);
            aad.fill(0);
            throw new Error(this.#purpose.error);
        }
    }

    issue(url: string): string {
        let plaintext: Buffer | undefined;

        try {
            if (!isV12SealableFileUrl(url)) {
                throw new Error(this.#purpose.error);
            }

            const key = this.#key;
            const prefix = this.#noncePrefix;
            const aad = this.#aad;

            if (!key || !prefix || !aad || this.#issued >= MAX_ISSUES) {
                throw new Error(this.#purpose.error);
            }

            // Reserve the nonce before encryption and never reuse it on failure.
            const count = this.#issued + 1n;
            this.#issued = count;
            const nonce = Buffer.alloc(NONCE_BYTES);
            prefix.copy(nonce);
            nonce.writeBigUInt64BE(count, NONCE_PREFIX_BYTES);
            plaintext = Buffer.from(url, 'utf8');
            const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
            cipher.setAAD(aad);
            const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
            const tag = cipher.getAuthTag();
            const id =
                this.#purpose.prefix +
                Buffer.concat([nonce, ciphertext, tag]).toString('base64url');

            if (this.#key !== key || id.length > MAX_TOKEN_LENGTH) {
                throw new Error(this.#purpose.error);
            }

            return id;
        } catch {
            throw new Error(this.#purpose.error);
        } finally {
            plaintext?.fill(0);
        }
    }

    redeem(id: string): string | null {
        const plaintextParts: Buffer[] = [];
        const providerFailure = Symbol(this.#purpose.providerFailure);

        try {
            const key = this.#key;
            const aad = this.#aad;

            if (!key || !aad || typeof id !== 'string' || id.length > MAX_TOKEN_LENGTH) {
                return null;
            }

            if (!id.startsWith(this.#purpose.prefix)) {
                return null;
            }

            const encoded = id.slice(this.#purpose.prefix.length);

            if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) {
                return null;
            }

            const packed = Buffer.from(encoded, 'base64url');

            if (
                packed.toString('base64url') !== encoded ||
                packed.length <= NONCE_BYTES + TAG_BYTES ||
                packed.length > NONCE_BYTES + MAX_URL_BYTES + TAG_BYTES
            ) {
                return null;
            }

            const nonce = packed.subarray(0, NONCE_BYTES);
            const ciphertext = packed.subarray(NONCE_BYTES, packed.length - TAG_BYTES);
            const tag = packed.subarray(packed.length - TAG_BYTES);
            let decipher: DecipherGCM;

            try {
                decipher = createDecipheriv('aes-256-gcm', key, nonce, {
                    authTagLength: TAG_BYTES,
                });
                decipher.setAAD(aad);
                decipher.setAuthTag(tag);
                plaintextParts.push(decipher.update(ciphertext));
            } catch {
                // Valid-sized inputs have reached the crypto provider; keep a
                // fixed operational failure distinct from a malformed handle.
                throw providerFailure;
            }

            try {
                // update() may return unauthenticated bytes. Never use them before final().
                plaintextParts.push(decipher.final());
            } catch {
                // Authentication failure and a provider failure at final() are
                // not distinguishable here.
                return null;
            }

            const plaintext = Buffer.concat(plaintextParts);
            plaintextParts.push(plaintext);
            const url = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
            const checked = classifyFileUrl(url);

            if (
                this.#key !== key ||
                checked.kind !== 'valid' ||
                checked.url !== url ||
                Buffer.byteLength(url, 'utf8') > MAX_URL_BYTES
            ) {
                return null;
            }

            return url;
        } catch (error) {
            if (error === providerFailure) {
                throw new Error(this.#purpose.error);
            }

            return null;
        } finally {
            for (const part of plaintextParts) {
                part.fill(0);
            }
        }
    }

    revoke(): void {
        const key = this.#key;
        const prefix = this.#noncePrefix;
        const aad = this.#aad;
        this.#key = null;
        this.#noncePrefix = null;
        this.#aad = null;
        key?.fill(0);
        prefix?.fill(0);
        aad?.fill(0);
    }
}

/** Account-instance-local image URL snapshot handles. */
export class V12ImageFileTokens {
    readonly #engine: V12FileTokenEngine;

    constructor(accountId: string) {
        this.#engine = new V12FileTokenEngine(accountId, IMAGE_PURPOSE);
    }

    issue(url: string): string {
        try {
            return this.#engine.issue(url);
        } catch {
            throw new Error(IMAGE_PURPOSE.error);
        }
    }

    redeem(id: string): string | null {
        let engine: V12FileTokenEngine;

        try {
            engine = this.#engine;
        } catch {
            return null;
        }

        return engine.redeem(id);
    }

    revoke(): void {
        this.#engine.revoke();
    }
}

/** Account-instance-local voice URL snapshot handles. */
export class V12VoiceFileTokens {
    readonly #engine: V12FileTokenEngine;

    constructor(accountId: string) {
        this.#engine = new V12FileTokenEngine(accountId, VOICE_PURPOSE);
    }

    issue(url: string): string {
        try {
            return this.#engine.issue(url);
        } catch {
            throw new Error(VOICE_PURPOSE.error);
        }
    }

    redeem(id: string): string | null {
        let engine: V12FileTokenEngine;

        try {
            engine = this.#engine;
        } catch {
            return null;
        }

        return engine.redeem(id);
    }

    revoke(): void {
        this.#engine.revoke();
    }
}
