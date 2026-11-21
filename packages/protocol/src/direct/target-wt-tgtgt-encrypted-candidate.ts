import { qqTeaEncrypt } from './qq-tea';
import { deriveTargetWtTgtgtKeyCandidate } from './target-wt-tgtgt-key-candidate';
import {
    encodeTargetWtTgtgtPlainCandidate,
    type TargetWtTgtgtPlainInput,
} from './target-wt-tgtgt-plain-candidate';

const fill = Uint8Array.prototype.fill;

function clear(bytes: Uint8Array | undefined): void {
    if (bytes) {
        try {
            fill.call(bytes, 0);
        } catch {
            // Each private result gets an independent best-effort cleanup attempt.
        }
    }
}

/**
 * Pure in-memory composition of the local tgtgt plaintext and key candidates
 * with the existing QQ-TEA model. The plaintext candidate writes a modeled
 * sequence with opaque caller-supplied fields. The key candidate hashes a
 * zero-padded 16-byte source prefix followed by the unsigned word as BE64;
 * its MD5-based construction is a hypothesis, not proven target equivalence.
 * This composition is not an SSO signer and performs no networking, hooks,
 * target-process access or real QQ login. QQ-TEA is not authenticated encryption.
 *
 * Validation is delegated to the two candidates before randomBytes is invoked;
 * a non-function callback fails immediately. The callback must return the exact
 * requested Uint8Array synchronously. Its synchronous exceptions and all other
 * failures are replaced by a fixed error. If it creates a rejected Promise, the
 * caller must handle that Promise; this synchronous API does not consume it.
 * Sources must remain stable while copied, and the caller must trust the JS
 * intrinsics and callback. Caller inputs, callback results and returned ciphertext
 * remain caller-owned and are not cleared here. The private plaintext and derived
 * key are independently cleared best effort on success and failure; neither JS
 * engine copies nor crypto or QQ-TEA internal intermediates can be guaranteed
 * erased. The plaintext candidate's 16 MiB limit is not a CPU, execution-time or
 * peak-memory bound, and encryption adds framing and padding.
 */
export function encodeTargetWtTgtgtEncryptedCandidate(
    input: TargetWtTgtgtPlainInput,
    keySource: Uint8Array,
    keyWord: bigint,
    randomBytes: (size: number) => Uint8Array,
): Uint8Array {
    let plain: Uint8Array | undefined;
    let key: Uint8Array | undefined;

    try {
        if (typeof randomBytes !== 'function') {
            throw new TypeError();
        }

        plain = encodeTargetWtTgtgtPlainCandidate(input);
        key = deriveTargetWtTgtgtKeyCandidate(keySource, keyWord);
        return qqTeaEncrypt(plain, key, randomBytes);
    } catch {
        throw new Error('target WT tgtgt encrypted candidate failed');
    } finally {
        clear(plain);
        clear(key);
    }
}
