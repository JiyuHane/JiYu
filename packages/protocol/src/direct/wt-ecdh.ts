import { createECDH, createHash, ECDH } from 'node:crypto';

const CURVE = 'secp192k1';
const SCALAR_SIZE = 24;
const ORDER = Buffer.from('fffffffffffffffffffffffe26f2fc170f69466a74defd8d', 'hex');

// Complete uncompressed server point from the referenced WtLogin implementation.
// This is a source constant, not an observation of a current client or server.
const SERVER_PUBLIC_KEY = Buffer.from(
    '04928d8850673088b343264e0c6bacb8496d697799f37211de' +
        'b25bb73906cb089fea9639b4e0260498b51a992d50813da8',
    'hex',
);

/** Return a copy of the server point used by the referenced implementation. */
export function referenceWtServerPublicKey(): Uint8Array {
    return Uint8Array.from(SERVER_PUBLIC_KEY);
}

function validatePoint(point: Uint8Array): void {
    if (
        !(point instanceof Uint8Array) ||
        !(
            (point.length === 25 && (point[0] === 2 || point[0] === 3)) ||
            (point.length === 49 && point[0] === 4)
        )
    ) {
        throw new RangeError(
            'secp192k1 public key must be a 25-byte compressed or 49-byte uncompressed point',
        );
    }

    // OpenSSL checks the point and coordinate bounds, not just its encoding.
    ECDH.convertKey(point, CURVE, undefined, undefined, 'uncompressed');
}

/**
 * Independent OICQ byte primitives based on Lagrange.Core's Secp192K1 and WtLogin:
 * https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Utility/Cryptography/EcdhProvider.cs
 * https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Login/WtLogin.cs
 * A fixed 24-byte big-endian scalar is for reproducible tests; default is fresh randomness.
 * The peer point is always required. The reference point alone does not establish
 * which server key applies to a target version.
 * The closure retains private key material and JavaScript does not guarantee erasure.
 */
export function createWtEcdh(privateKey?: Uint8Array): {
    readonly publicKey: Uint8Array;
    sharedSecret: (peerPublicKey: Uint8Array) => Uint8Array;
    deriveTeaKey: (peerPublicKey: Uint8Array) => Uint8Array;
} {
    const ecdh = createECDH(CURVE);

    if (privateKey === undefined) {
        ecdh.generateKeys();
    } else {
        if (!(privateKey instanceof Uint8Array) || privateKey.length !== SCALAR_SIZE) {
            throw new RangeError('secp192k1 private scalar must be exactly 24 bytes');
        }

        const scalar = Buffer.from(privateKey);
        if (scalar.equals(Buffer.alloc(SCALAR_SIZE)) || Buffer.compare(scalar, ORDER) >= 0) {
            throw new RangeError('secp192k1 private scalar must be between 1 and n - 1');
        }

        ecdh.setPrivateKey(scalar);
    }

    function sharedSecret(peerPublicKey: Uint8Array): Uint8Array {
        validatePoint(peerPublicKey);
        const shared = ecdh.computeSecret(peerPublicKey);
        if (shared.length !== SCALAR_SIZE) {
            throw new Error('secp192k1 shared X must be exactly 24 bytes');
        }

        return Uint8Array.from(shared);
    }

    const publicKey = ecdh.getPublicKey(undefined, 'compressed');
    return Object.freeze({
        // A copy on every read keeps callers from changing the point paired with this scalar.
        get publicKey(): Uint8Array {
            return Uint8Array.from(publicKey);
        },
        sharedSecret,
        deriveTeaKey(peerPublicKey: Uint8Array): Uint8Array {
            return Uint8Array.from(createHash('md5').update(sharedSecret(peerPublicKey)).digest());
        },
    });
}
