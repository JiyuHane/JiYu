import { createHash } from 'node:crypto';

/**
 * Offline, conditional intermediate-digest candidate, not a final signature.
 * At static 0x68563e0 the identity of the formatted value is unresolved.
 * The MD5 path is conditional on a nonzero byte at offset +1 of the pointer
 * from 0x684bd56 and a dword equal to 1 at +0xa0 of another object. Those
 * gates are statically indicated, not observed here; other branches are unknown.
 * Indirect branches, gating at runtime, aliasing, errors, dynamic PLT binding
 * and downstream result flow remain unproven. Neither target output nor any
 * slot, ZIP association or SSO use is established. This calculation assumes
 * the supplied bits are the value formatted with %d, not target reachability.
 *
 * The input must be a primitive uint32 bit pattern. Negative zero is rejected
 * rather than treated as the zero pattern. MD5 provider failures produce a
 * fixed error without the input, original cause, fallback or network access.
 */
export function targetSignedDecimalMd5Candidate(bits: number): Uint8Array {
    if (
        typeof bits !== 'number' ||
        !Number.isInteger(bits) ||
        Object.is(bits, -0) ||
        bits < 0 ||
        bits > 0xffffffff
    ) {
        throw new TypeError('invalid candidate input');
    }

    const decimal = (bits | 0).toString(10);

    try {
        return Uint8Array.from(createHash('md5').update(decimal, 'ascii').digest());
    } catch {
        throw new Error('target signed decimal MD5 candidate failed');
    }
}
