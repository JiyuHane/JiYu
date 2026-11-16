import { constants, createHash, createPublicKey, verify } from 'node:crypto';
import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';

/*
 * Offline file-signature reference, independently implemented from the claims in
 * deliverable_4YDwe.zip: README.md:13-35 and verify/REPORT.md:11-65.
 * The supplier identifies the target as Linux QQNT 3.2.35 wrapper.node, SHA-256
 * dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328.
 * The reported algorithm and claimed original-file verification are supplier
 * conclusions, not observations made by this module. Target source, original
 * signed files, and signing secret are unavailable here. This is file-signature
 * verification, not an SSO packet or sec_sign implementation.
 *
 * A caller-selected public key establishes no trust by itself. Callers must
 * authenticate the key separately. No keys, files, signatures, or network
 * endpoints are loaded or generated here.
 */

// Local resource policy, not a property of the reported file format. This allows
// the supplier's 152,431,496-byte wrapper.node while bounding the snapshot copy.
export const LINUX_QQ_APP_SIGNATURE_MAX_DATA_BYTES = 256 * 1024 * 1024;
export const LINUX_QQ_APP_SIGNATURE_MAX_PUBLIC_KEY_DER_BYTES = 4 * 1024;
export const LINUX_QQ_APP_SIGNATURE_BYTES = 256;

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const typedArrayValues = Uint8Array.prototype.values;
const typedArraySet = Uint8Array.prototype.set;
const typedArrayFill = Uint8Array.prototype.fill;

function wipe(bytes: Uint8Array | undefined): void {
    if (bytes) {
        // Only owned temporary buffers are passed here, never the caller's view.
        typedArrayFill.call(bytes, 0);
    }
}

function snapshotBytes(
    value: Uint8Array,
    label: string,
    maxLength: number,
    exactLength?: number,
): Uint8Array {
    let copy: Uint8Array | undefined;

    try {
        if (isProxy(value) || !isUint8Array(value) || !resizableGetter) {
            throw new Error();
        }

        // The intrinsic validates detached views, including detached zero-length
        // views, without consulting attacker-controlled instance properties.
        typedArrayValues.call(value);
        const backing = bufferGetter.call(value) as ArrayBufferLike;
        const offset = byteOffsetGetter.call(value) as number;
        const length = byteLengthGetter.call(value) as number;

        if (
            isSharedArrayBuffer(backing) ||
            resizableGetter.call(backing) ||
            length > maxLength ||
            (exactLength !== undefined && length !== exactLength)
        ) {
            throw new Error();
        }

        copy = new Uint8Array(length);
        typedArraySet.call(copy, new Uint8Array(backing as ArrayBuffer, offset, length));
        return copy;
    } catch {
        wipe(copy);
        throw new TypeError(`Invalid ${label} bytes or length`);
    }
}

/**
 * Verify a supplied signature against a supplied RSA-2048 SPKI DER public key.
 * The message for RSA-PSS is the 64-byte lowercase ASCII hex SHA-256 of data;
 * RSA-PSS itself hashes that message with SHA-256 and uses a 32-byte salt;
 * Node/OpenSSL's default PSS MGF1 digest follows the specified SHA-256 digest.
 *
 * Inputs must be live, non-proxy Uint8Array views over fixed, non-shared
 * ArrayBuffers. The function snapshots each view; input sizes are bounded by
 * the exported local-policy constants. The DER key must round-trip byte-for-byte
 * through Node's SPKI exporter, a local restriction rather than a general DER test.
 * A false result means verification did not succeed; native thrown errors and
 * invalid inputs are reported separately as sanitized exceptions. Temporary byte
 * arrays are wiped best-effort; native crypto state and the public-key object are
 * managed by Node and are not wipeable here.
 */
export function verifyLinuxQQAppSignatureReference(
    data: Uint8Array,
    publicKeyDer: Uint8Array,
    signature: Uint8Array,
): boolean {
    let dataCopy: Uint8Array | undefined;
    let keyCopy: Uint8Array | undefined;
    let signatureCopy: Uint8Array | undefined;
    let canonicalKey: Buffer | undefined;
    let digest: Buffer | undefined;
    let message: Buffer | undefined;

    try {
        keyCopy = snapshotBytes(
            publicKeyDer,
            'public key',
            LINUX_QQ_APP_SIGNATURE_MAX_PUBLIC_KEY_DER_BYTES,
        );
        signatureCopy = snapshotBytes(
            signature,
            'signature',
            LINUX_QQ_APP_SIGNATURE_BYTES,
            LINUX_QQ_APP_SIGNATURE_BYTES,
        );

        let key: ReturnType<typeof createPublicKey>;

        try {
            key = createPublicKey({
                key: Buffer.from(keyCopy.buffer, keyCopy.byteOffset, keyCopy.byteLength),
                format: 'der',
                type: 'spki',
            });
        } catch {
            throw new TypeError('Invalid RSA SPKI DER public key');
        }

        if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 2048) {
            throw new TypeError('Public key must be RSA-2048 SPKI DER');
        }

        try {
            canonicalKey = key.export({ format: 'der', type: 'spki' });
        } catch {
            throw new Error('Public key processing failed due to a crypto error');
        }

        // Reject trailing bytes and noncanonical encodings that the native DER
        // parser might otherwise accept as a prefix.
        if (canonicalKey.length !== keyCopy.length || !canonicalKey.equals(keyCopy)) {
            throw new TypeError('Public key must be canonical RSA SPKI DER');
        }

        dataCopy = snapshotBytes(data, 'data', LINUX_QQ_APP_SIGNATURE_MAX_DATA_BYTES);

        try {
            digest = createHash('sha256').update(dataCopy).digest();
            message = Buffer.allocUnsafe(64);
            const hex = '0123456789abcdef';

            for (let index = 0; index < digest.length; index++) {
                const byte = digest[index];
                message[index * 2] = hex.charCodeAt(byte >>> 4);
                message[index * 2 + 1] = hex.charCodeAt(byte & 15);
            }

            return verify(
                'sha256',
                message,
                {
                    key,
                    padding: constants.RSA_PKCS1_PSS_PADDING,
                    saltLength: 32,
                },
                signatureCopy,
            );
        } catch {
            throw new Error('File signature verification failed due to a crypto error');
        }
    } finally {
        wipe(dataCopy);
        wipe(keyCopy);
        wipe(signatureCopy);
        wipe(canonicalKey);
        wipe(digest);
        wipe(message);
    }
}
