import {
    createCipheriv,
    createDecipheriv,
    createECDH,
    createHash,
    ECDH,
    randomBytes,
} from 'node:crypto';

const KEY_SIZE = 32;
const PUBLIC_SIZE = 65;
const NONCE_SIZE = 12;
const TAG_SIZE = 16;

/** Independent byte primitives; serialization and account/session handling belong to the caller.
 * Wire facts: https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Services/Login/KeyExchangeService.cs
 */
function publicKeyBytes(publicKey: Uint8Array): void {
    if (
        !(publicKey instanceof Uint8Array) ||
        publicKey.length !== PUBLIC_SIZE ||
        publicKey[0] !== 4
    ) {
        throw new RangeError('P-256 public key must be a 65-byte uncompressed point');
    }

    // OpenSSL validates that the point is on the curve, including coordinate bounds.
    ECDH.convertKey(publicKey, 'prime256v1', undefined, undefined, 'uncompressed');
}

function keyBytes(key: Uint8Array): void {
    if (!(key instanceof Uint8Array) || key.length !== KEY_SIZE) {
        throw new RangeError('key must be exactly 32 bytes');
    }
}

/** Creates a fresh key pair unless a test scalar is explicitly supplied. */
export function createP256KeyExchange(privateKey?: Uint8Array): {
    publicKey: Uint8Array;
    sharedSecret: (peerPublicKey: Uint8Array) => Uint8Array;
} {
    const ecdh = createECDH('prime256v1');

    if (privateKey === undefined) {
        ecdh.generateKeys();
    } else {
        keyBytes(privateKey);
        ecdh.setPrivateKey(privateKey);
    }

    return {
        publicKey: Uint8Array.from(ecdh.getPublicKey(undefined, 'uncompressed')),
        sharedSecret(peerPublicKey: Uint8Array): Uint8Array {
            publicKeyBytes(peerPublicKey);
            return Uint8Array.from(ecdh.computeSecret(peerPublicKey));
        },
    };
}

/** AES-256-GCM without AAD, encoded as nonce || ciphertext || tag. */
export function encryptKeyExchangeBytes(
    plaintext: Uint8Array,
    key: Uint8Array,
    nonce?: Uint8Array,
): Uint8Array {
    keyBytes(key);

    if (!(plaintext instanceof Uint8Array)) {
        throw new TypeError('plaintext must be bytes');
    }

    const iv = nonce === undefined ? randomBytes(NONCE_SIZE) : nonce;

    if (!(iv instanceof Uint8Array) || iv.length !== NONCE_SIZE) {
        throw new RangeError('nonce must be exactly 12 bytes');
    }

    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_SIZE });
    return Uint8Array.from(
        Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]),
    );
}

/** Authentication is checked before any plaintext is returned. */
export function decryptKeyExchangeBytes(encoded: Uint8Array, key: Uint8Array): Uint8Array {
    keyBytes(key);

    if (!(encoded instanceof Uint8Array) || encoded.length < NONCE_SIZE + TAG_SIZE) {
        throw new RangeError('encrypted data must contain a nonce and tag');
    }

    const decipher = createDecipheriv('aes-256-gcm', key, encoded.subarray(0, NONCE_SIZE), {
        authTagLength: TAG_SIZE,
    });
    decipher.setAuthTag(encoded.subarray(encoded.length - TAG_SIZE));
    return Uint8Array.from(
        Buffer.concat([
            decipher.update(encoded.subarray(NONCE_SIZE, encoded.length - TAG_SIZE)),
            decipher.final(),
        ]),
    );
}

/** SHA-256 over the public point, fixed fields, encrypted secret and timestamp. */
export function keyExchangeVerifyDigest(
    publicKey: Uint8Array,
    secret: Uint8Array,
    timestamp: number,
): Uint8Array {
    publicKeyBytes(publicKey);

    if (!(secret instanceof Uint8Array) || secret.length < NONCE_SIZE + TAG_SIZE) {
        throw new RangeError('secret must contain a nonce and tag');
    }

    if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffff) {
        throw new RangeError('timestamp must be a uint32');
    }

    const type = Buffer.alloc(4);
    type.writeInt32BE(1);
    const zero = Buffer.alloc(4);
    const time = Buffer.alloc(4);
    time.writeUInt32BE(timestamp);
    return Uint8Array.from(
        createHash('sha256')
            .update(publicKey)
            .update(type)
            .update(secret)
            .update(zero)
            .update(time)
            .digest(),
    );
}

export interface KeyExchangeOptions {
    /** Explicit inputs are intended for deterministic vectors; never reuse nonces with a key. */
    privateKey?: Uint8Array;
    secretNonce?: Uint8Array;
    verifyNonce?: Uint8Array;
}

/** Builds fields from already serialized secret bytes; does not serialize a request.
 * The response derivation closure retains the ephemeral private key while reachable.
 * JavaScript and the underlying crypto provider do not guarantee secure key erasure.
 */
export function buildKeyExchange(
    serializedSecret: Uint8Array,
    serverPublicKey: Uint8Array,
    verifyKey: Uint8Array,
    timestamp: number,
    options: KeyExchangeOptions = {},
): {
    publicKey: Uint8Array;
    secret: Uint8Array;
    verifyHash: Uint8Array;
    sharedSecret: Uint8Array;
    timestamp: number;
    deriveResponseSecret: (peerPublicKey: Uint8Array) => Uint8Array;
} {
    const ecdh = createP256KeyExchange(options.privateKey);
    const sharedSecret = ecdh.sharedSecret(serverPublicKey);
    const secret = encryptKeyExchangeBytes(serializedSecret, sharedSecret, options.secretNonce);
    const digest = keyExchangeVerifyDigest(ecdh.publicKey, secret, timestamp);
    const verifyHash = encryptKeyExchangeBytes(digest, verifyKey, options.verifyNonce);
    return {
        publicKey: ecdh.publicKey,
        secret,
        verifyHash,
        sharedSecret,
        timestamp,
        deriveResponseSecret: ecdh.sharedSecret,
    };
}
