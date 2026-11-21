import { isProxy, isUint8Array } from 'node:util/types';
import { qqTeaEncrypt } from './qq-tea';
import { encodeTargetWtInnerWriterCandidate } from './target-wt-inner-writer-candidate';

const Bytes = Uint8Array;
const typed = Object.getPrototypeOf(Bytes.prototype) as object;
const getBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const getLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const getBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const getResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const values = Bytes.prototype.values;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;
const getDescriptor = Object.getOwnPropertyDescriptor;
const isArray = Array.isArray;

/**
 * Local conditional composition of the observed four-writer sequence and the
 * existing QQ-TEA model. The opaque inputs are caller-asserted writer outputs,
 * not validated TLVs. The key and random source are supplied by the caller;
 * this does not derive keys, construct a 0x0144 node, sign, send or log in.
 * Neither target runtime equivalence nor the target's random-source behavior is
 * established. This is an offline candidate, not an authenticated encryption API.
 *
 * The four tuple elements must be own data properties. The key must be a genuine
 * fixed, attached, non-shared 16-byte Uint8Array. The caller must prevent input
 * memory from changing while it is copied and provide trustworthy intrinsics
 * and a synchronous random source. Its synchronous exceptions are replaced
 * with a fixed error. A callback that instead creates a rejected Promise remains
 * responsible for handling that Promise; it may trigger an unhandled rejection.
 * Caller-owned inputs and callback results are never cleared. Private
 * plaintext and key snapshots are cleared best effort; qqTeaEncrypt and the JS
 * runtime may retain intermediate copies, so erasure is not guaranteed. The
 * existing writer's 16 MiB limit is a plaintext bound, not a time or memory
 * bound; encryption is synchronous and its output includes padding. Separate
 * decoder candidates can impose lower effective ciphertext limits.
 */
export function encodeTargetWtInnerEncryptedCandidate(
    parts: readonly [Uint8Array, Uint8Array, Uint8Array, Uint8Array],
    key: Uint8Array,
    randomBytes: (size: number) => Uint8Array,
): Uint8Array {
    let keyCopy: Uint8Array | undefined;
    let plaintext: Uint8Array | undefined;

    try {
        if (
            isProxy(parts) ||
            !isArray(parts) ||
            parts.length !== 4 ||
            typeof randomBytes !== 'function'
        ) {
            throw new TypeError();
        }

        const fragments: Uint8Array[] = [];

        for (let index = 0; index < 4; index++) {
            const descriptor = getDescriptor(parts, String(index));

            if (!descriptor || !('value' in descriptor)) {
                throw new TypeError();
            }

            fragments.push(descriptor.value as Uint8Array);
        }

        if (isProxy(key) || !isUint8Array(key) || typeof getResizable !== 'function') {
            throw new TypeError();
        }

        let current: object | null = key;

        for (let depth = 0; current !== null; depth++) {
            if (depth >= 256 || isProxy(current)) {
                throw new TypeError();
            }

            current = Object.getPrototypeOf(current) as object | null;
        }

        values.call(key);
        const backing = getBuffer.call(key) as ArrayBuffer;
        const size = getLength.call(key) as number;
        const offset = getOffset.call(key) as number;
        const backingSize = getBufferLength.call(backing) as number;

        if (size !== 16 || offset + size > backingSize || getResizable.call(backing) !== false) {
            throw new TypeError();
        }

        keyCopy = new Bytes(16);
        set.call(keyCopy, new Bytes(backing, offset, 16));
        plaintext = encodeTargetWtInnerWriterCandidate(
            fragments[0],
            fragments[1],
            fragments[2],
            fragments[3],
        );
        return qqTeaEncrypt(plaintext, keyCopy, randomBytes);
    } catch {
        throw new Error('target WT inner encrypted candidate failed');
    } finally {
        for (const value of [plaintext, keyCopy]) {
            if (value) {
                try {
                    fill.call(value, 0);
                } catch {
                    // Independently attempt cleanup of each owned snapshot.
                }
            }
        }
    }
}
