import { isProxy, isUint8Array } from 'node:util/types';
import { qqTeaEncrypt } from './qq-tea';
import {
    encodeTargetMsfSso12HeadCandidate,
    type TargetMsfSso12HeadCandidateInput,
} from './target-msf-sso12-head-candidate';

/** Local ciphertext cap; an outer frame still needs room for its own header. */
export const MAX_TARGET_MSF_SSO12_PAYLOAD_BYTES = 16 * 1024 * 1024;

export interface TargetMsfSso12PayloadCandidateInput {
    head: TargetMsfSso12HeadCandidateInput;
    /** Existing body bytes at head-object +0x80, without an added prefix. */
    body80: Uint8Array;
    /** Explicit key for +0x38; this API requires exactly 16 initialized bytes. */
    key38: Uint8Array;
    /** Optional synthetic prefix source, with the existing QQ-TEA contract. */
    randomSource?: (length: number) => Uint8Array;
}

const ERROR = 'target MSF SSO12 payload construction failed';
const Bytes = Uint8Array;
const Failure = Error;
const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const getPrototype = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const create = Object.create;
const plainPrototype = Object.prototype;
const typed = getPrototype(Bytes.prototype) as object;
const getLength = getDescriptor(typed, 'byteLength')!.get!;
const getBuffer = getDescriptor(typed, 'buffer')!.get!;
const getBufferLength = getDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const values = Bytes.prototype.values;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;

function capture(input: unknown): Record<string, unknown> {
    if (input === null || typeof input !== 'object' || isProxy(input)) {
        throw new Failure();
    }

    const prototype: unknown = getPrototype(input);
    const keys = ownKeys(input);

    if (
        (prototype !== plainPrototype && prototype !== null) ||
        keys.length < 3 ||
        keys.length > 4
    ) {
        throw new Failure();
    }

    const fields = create(null) as Record<string, unknown>;

    for (let index = 0; index < keys.length; index++) {
        const key = keys[index];

        if (key !== 'head' && key !== 'body80' && key !== 'key38' && key !== 'randomSource') {
            throw new Failure();
        }

        const descriptor = getDescriptor(input, key);

        if (descriptor === undefined || !hasOwn(descriptor, 'value')) {
            throw new Failure();
        }

        fields[key] = descriptor.value;
    }

    if (!hasOwn(fields, 'head') || !hasOwn(fields, 'body80') || !hasOwn(fields, 'key38')) {
        throw new Failure();
    }

    return fields;
}

function inspect(value: unknown): { value: Uint8Array; length: number } {
    if (isProxy(value) || !isUint8Array(value)) {
        throw new Failure();
    }

    apply(values, value, []);
    apply(getBufferLength, apply(getBuffer, value, []), []);
    return { value, length: apply(getLength, value, []) as number };
}

function clear(value: Uint8Array | undefined): void {
    if (value !== undefined) {
        try {
            apply(fill, value, [0]);
        } catch {
            // Best effort; preserve the original outcome.
        }
    }
}

/**
 * Offline composition of the SDK mode-12 path with compression disabled,
 * encryption enabled, context[8] == 0 and an explicitly initialized 16-byte key.
 * Empty body80 becomes 00 00 00 04; nonempty body80 is appended verbatim.
 * The result is ciphertext for CRequestBase's field28, not a complete frame.
 *
 * Every byte consumed by encryption is copied before calling a supplied RNG.
 * The key, head and assembled plaintext owned by this wrapper are cleared best
 * effort on success and failure; QQ-TEA's internal temporaries are outside that
 * promise. Built-ins must remain intact, including during the optional callback.
 *
 * Native rand() reduction/call counts differ from the secure default RNG here.
 * Matching the native ciphertext requires the same processed random bytes and
 * key. Invalid native key lengths/flags, compression, signing, account lookup,
 * real transport and server acceptance are not modeled. Existing codecs and
 * production wiring remain unchanged.
 */
export function encodeTargetMsfSso12PayloadCandidate(
    input: TargetMsfSso12PayloadCandidateInput,
): Uint8Array {
    let key: Uint8Array | undefined;
    let head: Uint8Array | undefined;
    let plaintext: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        const fields = capture(input);
        const sourceKey = inspect(fields.key38);
        const body = inspect(fields.body80);
        const randomSource = fields.randomSource;

        if (
            sourceKey.length !== 16 ||
            body.length > MAX_TARGET_MSF_SSO12_PAYLOAD_BYTES ||
            (randomSource !== undefined &&
                (typeof randomSource !== 'function' || isProxy(randomSource)))
        ) {
            throw new Failure();
        }

        key = new Bytes(16);
        apply(set, key, [sourceKey.value]);
        // This codec performs the nested record's full runtime validation.
        head = encodeTargetMsfSso12HeadCandidate(fields.head as TargetMsfSso12HeadCandidateInput);
        const headLength = apply(getLength, head, []) as number;
        const length = headLength + (body.length === 0 ? 4 : body.length);
        const padding = (8 - ((length + 10) % 8)) % 8;
        const cipherLength = length + padding + 10;

        if (cipherLength > MAX_TARGET_MSF_SSO12_PAYLOAD_BYTES) {
            throw new Failure();
        }

        plaintext = new Bytes(length);
        apply(set, plaintext, [head]);

        if (body.length === 0) {
            plaintext[headLength + 3] = 4;
        } else {
            apply(set, plaintext, [body.value, headLength]);
        }

        output = qqTeaEncrypt(
            plaintext,
            key,
            randomSource === undefined
                ? undefined
                : (size) => {
                      const result: unknown = randomSource(size);

                      if (isProxy(result) || !isUint8Array(result)) {
                          throw new Failure();
                      }

                      // QQ-TEA validates the returned extent/backing and makes its own copy.
                      return result;
                  },
        );

        if (apply(getLength, output, []) !== cipherLength) {
            throw new Failure();
        }

        complete = true;
        return output;
    } catch {
        throw new Failure(ERROR);
    } finally {
        clear(key);
        clear(head);
        clear(plaintext);

        if (!complete) {
            clear(output);
        }
    }
}
