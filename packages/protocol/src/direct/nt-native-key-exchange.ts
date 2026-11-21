import { createHash, createPublicKey, verify } from 'node:crypto';
import {
    protobuf_decode,
    protobuf_encode,
    type pb,
    type bytes,
    type uint_32,
    type uint_64,
    type int_64,
} from '@snowluma/proton';
import {
    createP256KeyExchange,
    decryptKeyExchangeBytes,
    encryptKeyExchangeBytes,
} from './key-exchange';
import {
    nativeBytes,
    nativeRecord,
    nativeSeconds,
    nativeText,
    wipeNativeBytes,
} from './nt-native-ticket-codec';

export const NATIVE_KEY_EXCHANGE_COMMAND = 'trpc.login.ecdh.EcdhService.SsoKeyExchange';
// Fixed native trust, independently extracted from Linux QQ 3.2.35-54395.
// 0x3490ad0 builds requests; 0x34923d0 authenticates the response before ECDH/decryption.
// Deliberately no public key, scalar, nonce, verifier or trust-policy injection in this API.
const BOOTSTRAP_KEY = Buffer.from(
    '049d1423332735980edabe7e9ea451b3395b6f35250db8fc56f25889f628cbae3e8e73077914071eeebc108f4e0170057792bb17aa303af652313d17c1ac815e79',
    'hex',
);
const VERIFY_HASH_KEY = Buffer.from(
    'e2733bf403149913cbf80c7a95168bd4ca6935ee53cd39764beebe2e007e3aee',
    'hex',
);
const SIGNING_POINT = Buffer.from(
    '04453977b048d0b72c1a7d50c36ebe881b69bbdd51a5c662d08a1baf1236ce92cbb95460f573fe7a5b0ed9ccfee01eb4dfb6e6ecfa16a090e3ed8f5847a9daf984',
    'hex',
);
const SIGNING_KEY = createPublicKey({
    key: {
        kty: 'EC',
        crv: 'P-256',
        x: SIGNING_POINT.subarray(1, 33).toString('base64url'),
        y: SIGNING_POINT.subarray(33).toString('base64url'),
    },
    format: 'jwk',
});

interface NativeKeyExchangeInner {
    uin: pb<1, string>;
    guid: pb<2, bytes>;
}
export interface NativeKeyExchangeRequestWire {
    publicKey: pb<1, bytes>;
    type: pb<2, uint_32>;
    secret: pb<3, bytes>;
    timestamp: pb<4, uint_64>;
    verifyHash: pb<5, bytes>;
}
export interface NativeKeyExchangeResponseWire {
    secret?: pb<1, bytes>;
    signature?: pb<2, bytes>;
    publicKey?: pb<3, bytes>;
}
export interface NativeKeyExchangeSecretWire {
    sessionKey?: pb<1, bytes>;
    sessionTicket?: pb<2, bytes>;
    expiresInSeconds?: pb<3, int_64>;
}
export interface NativeKeyExchangeSession {
    readonly sessionKey: Uint8Array;
    readonly sessionTicket: Uint8Array;
    readonly expiresInSeconds: bigint;
}
export interface NativeKeyExchangeInput {
    readonly uin: string;
    readonly guid: Uint8Array;
    readonly timestampSeconds: bigint;
}
export interface NativeKeyExchange {
    /** Borrowed request bytes; erased by complete/cancel. The caller never owns a private key. */
    readonly request: Uint8Array;
    complete(response: Uint8Array): NativeKeyExchangeSession;
    cancel(): void;
}

function canonicalDer(signature: Uint8Array): boolean {
    // P-256 DER is a short-form SEQUENCE of two minimally encoded positive INTEGERs.
    if (
        signature.length < 8 ||
        signature.length > 72 ||
        signature[0] !== 0x30 ||
        signature[1] !== signature.length - 2
    ) {
        return false;
    }

    let offset = 2;

    for (let index = 0; index < 2; index++) {
        if (signature[offset++] !== 2) {
            return false;
        }

        const size = signature[offset++];

        if (
            size === undefined ||
            size < 1 ||
            size > 33 ||
            offset + size > signature.length ||
            (signature[offset]! & 0x80) !== 0 ||
            (signature[offset] === 0 && (size === 1 || (signature[offset + 1]! & 0x80) === 0))
        ) {
            return false;
        }

        offset += size;
    }

    return offset === signature.length;
}

export function disposeNativeKeyExchangeSession(
    session: NativeKeyExchangeSession | undefined,
): void {
    if (session) {
        wipeNativeBytes(session.sessionKey);
        wipeNativeBytes(session.sessionTicket);
    }
}

/** One fresh P-256 exchange, one response attempt (including failure). PB only, no I/O.
 * JS can release the ECDH handle but does not promise erasure inside the crypto provider. */
export function createNativeKeyExchange(options: NativeKeyExchangeInput): NativeKeyExchange {
    const input = nativeRecord(options, ['uin', 'guid', 'timestampSeconds']);
    const uin = nativeText(input.uin, 10);
    const timestamp = nativeSeconds(input.timestampSeconds);

    if (!/^[1-9][0-9]{0,9}$/.test(uin) || BigInt(uin) > 0xffffffffn) {
        throw new TypeError('invalid native account');
    }

    let guid: Uint8Array | undefined;
    let plain: Uint8Array | undefined;
    let shared: Uint8Array | undefined;
    let secret: Uint8Array | undefined;
    let digest: Uint8Array | undefined;
    let verifyHash: Uint8Array | undefined;
    let exchange: ReturnType<typeof createP256KeyExchange> | undefined;
    let request: Uint8Array | undefined;
    let publicKey: Uint8Array | undefined;
    let built = false;

    try {
        guid = nativeBytes(input.guid, 16, 16);
        plain = protobuf_encode<NativeKeyExchangeInner>({ uin, guid });
        exchange = createP256KeyExchange();
        publicKey = exchange.publicKey;
        shared = exchange.sharedSecret(BOOTSTRAP_KEY);
        secret = encryptKeyExchangeBytes(plain, shared);
        const type = Buffer.alloc(4);
        type.writeUInt32BE(1);
        const time = Buffer.alloc(8);
        time.writeBigUInt64BE(timestamp);
        digest = createHash('sha256')
            .update(publicKey)
            .update(type)
            .update(secret)
            .update(time)
            .digest();
        verifyHash = encryptKeyExchangeBytes(digest, VERIFY_HASH_KEY);
        request = protobuf_encode<NativeKeyExchangeRequestWire>({
            publicKey,
            type: 1,
            secret,
            timestamp,
            verifyHash,
        });
        built = true;
    } finally {
        [guid, plain, shared, secret, digest, verifyHash].forEach(wipeNativeBytes);

        if (!built) {
            [request, publicKey].forEach(wipeNativeBytes);
            exchange = undefined;
        }
    }

    let active = true;
    const requestBytes = request!;

    const cancel = (): void => {
        active = false;
        exchange = undefined;
        wipeNativeBytes(publicKey);
        wipeNativeBytes(requestBytes);
    };

    const complete = (response: Uint8Array): NativeKeyExchangeSession => {
        if (!active) {
            throw new Error('native key exchange already consumed');
        }

        active = false;
        let wire: Uint8Array | undefined;
        let signedInput: Uint8Array | undefined;
        let responseKey: Uint8Array | undefined;
        let plaintext: Uint8Array | undefined;
        let sessionKey: Uint8Array | undefined;
        let sessionTicket: Uint8Array | undefined;
        let delivered = false;

        try {
            wire = nativeBytes(response, 1);
            const reply = protobuf_decode<NativeKeyExchangeResponseWire>(
                Buffer.from(wire.buffer, wire.byteOffset, wire.byteLength),
            );

            if (
                !reply.publicKey ||
                reply.publicKey.length !== 65 ||
                reply.publicKey[0] !== 4 ||
                !reply.secret ||
                reply.secret.length <= 28 ||
                !reply.signature ||
                !canonicalDer(reply.signature)
            ) {
                throw new Error('invalid native key exchange response');
            }

            signedInput = Buffer.concat([publicKey!, reply.publicKey, reply.secret]);

            // verify('sha256') hashes the ORIGINAL concatenation exactly once, not a prehash.
            if (
                !verify(
                    'sha256',
                    signedInput,
                    { key: SIGNING_KEY, dsaEncoding: 'der' },
                    reply.signature,
                )
            ) {
                throw new Error('native key exchange signature mismatch');
            }

            responseKey = exchange!.sharedSecret(reply.publicKey);
            plaintext = decryptKeyExchangeBytes(reply.secret, responseKey);
            const session = protobuf_decode<NativeKeyExchangeSecretWire>(
                Buffer.from(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength),
            );
            sessionKey = nativeBytes(session.sessionKey, 32, 32);
            sessionTicket = nativeBytes(session.sessionTicket, 1, 65535);
            const expiresInSeconds = nativeSeconds(session.expiresInSeconds);

            if (expiresInSeconds === 0n) {
                throw new Error('expired native key exchange session');
            }

            delivered = true;
            return Object.freeze({ sessionKey, sessionTicket, expiresInSeconds });
        } finally {
            [wire, signedInput, responseKey, plaintext].forEach(wipeNativeBytes);
            cancel();

            if (!delivered) {
                [sessionKey, sessionTicket].forEach(wipeNativeBytes);
            }
        }
    };

    return Object.freeze({ request: requestBytes, complete, cancel });
}
