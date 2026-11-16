import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';

// Local allocation policy, not a limit established for the reported target.
export const LINUX_QQ_APP_SIGNATURE_CHECK_MAX_JCE_BYTES = 1024 * 1024;

export interface LinuxQQAppSignatureCheckEnvelope {
    readonly command: 'PhSigLcId.Check';
    readonly field38: '0';
    readonly commandNumber: 75;
    readonly body: Uint8Array;
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const lengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const typedArrayValues = Uint8Array.prototype.values;
const typedArraySet = Uint8Array.prototype.set;

/**
 * Wrap complete, opaque serialized JCE bytes in the length-prefixed body described
 * by the supplier's Linux QQ 3.2.35 DoAppSignatureCheck reconstruction. The
 * supplier's account has not been checked against the original binary here.
 *
 * command, field38 and commandNumber describe reconstructed in-memory packet
 * fields; they do not establish their wire encoding. The request builder,
 * serializer and JCE tags, signature inputs, sequence and callback remain unknown.
 * The caller is responsible for the completeness and integrity of its JCE bytes.
 * This function neither parses nor constructs JCE, generates signatures, performs
 * SSO signing, sends a packet, nor contacts any service.
 *
 * Input must be a live, non-proxy Uint8Array over a fixed, non-shared buffer.
 * It is snapshotted into a caller-owned body. The metadata object is frozen,
 * but the body bytes remain mutable; callers may clear them when finished.
 */
export function buildLinuxQQAppSignatureCheckEnvelope(
    jce: Uint8Array,
): LinuxQQAppSignatureCheckEnvelope {
    let backing: ArrayBuffer;
    let offset: number;
    let length: number;

    try {
        if (isProxy(jce) || !isUint8Array(jce) || !resizableGetter) {
            throw new Error();
        }

        // Detect detached zero-length views without reading instance properties.
        typedArrayValues.call(jce);
        const storage = bufferGetter.call(jce) as ArrayBufferLike;
        offset = offsetGetter.call(jce) as number;
        length = lengthGetter.call(jce) as number;

        if (
            isSharedArrayBuffer(storage) ||
            resizableGetter.call(storage) ||
            length > LINUX_QQ_APP_SIGNATURE_CHECK_MAX_JCE_BYTES
        ) {
            throw new Error();
        }

        backing = storage as ArrayBuffer;
    } catch {
        throw new TypeError('Invalid JCE bytes or length');
    }

    let body: Uint8Array;

    try {
        const total = length + 4;
        body = new Uint8Array(total);
        body[0] = (total >>> 24) & 0xff;
        body[1] = (total >>> 16) & 0xff;
        body[2] = (total >>> 8) & 0xff;
        body[3] = total & 0xff;
        typedArraySet.call(body, new Uint8Array(backing, offset, length), 4);
    } catch {
        throw new Error('App signature check envelope construction failed');
    }

    return Object.freeze({
        command: 'PhSigLcId.Check' as const,
        field38: '0' as const,
        commandNumber: 75 as const,
        body,
    });
}
