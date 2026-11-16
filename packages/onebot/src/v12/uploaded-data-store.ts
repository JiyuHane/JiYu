import { createHash, Hash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isArrayBuffer, isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';

/** Reserved local namespace, including malformed or expired upload handles. */
export const V12_UPLOAD_TOKEN_PREFIX = 'jiyu-upload:v1:';

export type V12UploadResult =
    { kind: 'ok'; fileId: string } | { kind: 'invalid' | 'capacity' | 'unavailable' };

export type V12ReadUploadResult =
    | { kind: 'ok'; name: string; data: string; sha256: string }
    | { kind: 'not_found' | 'unavailable' };

const MAX_NAME_LENGTH = 4096;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_FILE_BYTES / 3);
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 32;
const TOKEN_BYTES = 32;
const TOKEN_TEXT_LENGTH = 43;
const MAX_TOKEN_ATTEMPTS = 4;
const TTL_MS = 600_000;

type Entry = {
    name: string;
    bytes: Buffer;
    length: number;
    sha256: string;
    createdAt: number;
};

// Capture the operations used on untrusted injected byte views and on private
// state. This assumes genuine built-ins at module initialization; it is not an
// isolation boundary against arbitrary same-process code.
const apply = Reflect.apply;
const bufferFrom = Buffer.from;
const bufferAlloc = Buffer.alloc;
const bufferToString = Buffer.prototype.toString;
const hashUpdate = Hash.prototype.update;
const hashDigest = Hash.prototype.digest;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const mapDelete = Map.prototype.delete;
const mapClear = Map.prototype.clear;
const mapEntries = Map.prototype.entries;
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!;
const mapIteratorNext = Object.getPrototypeOf(new Map().entries()).next as (
    this: Iterator<[string, Entry]>,
) => IteratorResult<[string, Entry]>;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'byteLength',
)!.get!;
const finiteNumber = Number.isFinite;
const typedArraySet = Uint8Array.prototype.set;
const typedArrayFill = Uint8Array.prototype.fill;
const charCodeAt = Function.prototype.call.bind(String.prototype.charCodeAt) as (
    value: string,
    index: number,
) => number;
const startsWith = Function.prototype.call.bind(String.prototype.startsWith) as (
    value: string,
    prefix: string,
) => boolean;

export function isV12UploadToken(value: unknown): value is string {
    return typeof value === 'string' && startsWith(value, V12_UPLOAD_TOKEN_PREFIX);
}

function erase(bytes: Uint8Array): void {
    try {
        apply(typedArrayFill, bytes, [0]);
    } catch {
        // Best effort, including on teardown; never expose an exception.
    }
}

function isLowerSha256(value: unknown): value is string {
    if (typeof value !== 'string' || value.length !== 64) {
        return false;
    }

    for (let index = 0; index < value.length; index += 1) {
        const code = charCodeAt(value, index);

        if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) {
            return false;
        }
    }

    return true;
}

/** Validate the alphabet and size before allocating; re-encoding checks pad bits. */
function decodedLength(value: string): number | null {
    const length = value.length;

    if (length > MAX_BASE64_LENGTH || length % 4 !== 0) {
        return null;
    }

    let padding = 0;

    if (length > 0 && charCodeAt(value, length - 1) === 61) {
        padding = 1;

        if (charCodeAt(value, length - 2) === 61) {
            padding = 2;
        }
    }

    for (let index = 0; index < length - padding; index += 1) {
        const code = charCodeAt(value, index);

        if (!(
            (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) ||
            (code >= 48 && code <= 57) ||
            code === 43 ||
            code === 47
        )) {
            return null;
        }
    }

    const bytes = (length / 4) * 3 - padding;
    return bytes <= MAX_FILE_BYTES ? bytes : null;
}

/**
 * Copy genuine, non-shared byte views using intrinsic typed-array operations.
 * Neither overridden getters nor methods on an injected view are consulted.
 */
function copyRandomBytes(value: unknown): Buffer | null {
    if (typeof value !== 'object' || value === null || isProxy(value) || !isUint8Array(value)) {
        return null;
    }

    const length: unknown = apply(typedArrayByteLength, value, []);
    const backing: unknown = apply(typedArrayBuffer, value, []);

    if (length !== TOKEN_BYTES || isSharedArrayBuffer(backing) || !isArrayBuffer(backing)) {
        return null;
    }

    const copy = bufferAlloc(TOKEN_BYTES);

    try {
        apply(typedArraySet, copy, [value]);
        return copy;
    } catch (error) {
        erase(copy);
        throw error;
    }
}

function wipeDefaultRandom(value: unknown): void {
    try {
        if (typeof value !== 'object' || value === null || isProxy(value) || !isUint8Array(value)) {
            return;
        }

        const length: unknown = apply(typedArrayByteLength, value, []);
        const backing: unknown = apply(typedArrayBuffer, value, []);

        if (length === TOKEN_BYTES && isArrayBuffer(backing) && !isSharedArrayBuffer(backing)) {
            erase(value);
        }
    } catch {
        // A failed provider must not expose an exception during cleanup.
    }
}

/**
 * Account-owner-local, synchronous content cache, not a QQ upload: these handles
 * are not yet usable to send media through send_message. The runtime owner
 * controls its lifetime and must call close when revoking this instance.
 *
 * Limits apply to this instance's retained raw data and entry count, not process
 * RSS. TTL is 600,000 ms from the initial validated upload clock sample, not
 * commit; slow or reentrant work can leave an entry expired immediately after
 * success. Expiry is lazy: idle entries remain until another access or close.
 * Store-owned buffers are wiped on expiry, close, and failed operations on a
 * best-effort basis. JavaScript strings, input Base64, returned copies, crypto
 * internals, and caller-owned injection buffers cannot be guaranteed erased.
 * Collision checks cover the current map only. A historical random collision
 * can theoretically make an expired handle string refer to new content. The
 * injected RNG is a trusted test seam; observed bytes cannot prove unpredictability.
 * Production uses node:crypto randomBytes.
 * Optional synchronous guards protect commit/disclosure at the caller's request;
 * the owner remains responsible for identity and authorization.
 */
export class V12UploadedDataStore {
    #entries: Map<string, Entry> | null = new Map();
    #totalBytes = 0;
    #lastNow: number | null = null;
    #closed = false;
    #busy = false;
    #revision = 0;
    #validOptions = true;
    #clock: () => number = () => performance.now();
    #random: (size: number) => Uint8Array = (size) => randomBytes(size);
    #defaultRandom = true;

    constructor(options?: { now?: () => number; randomBytes?: (n: number) => Uint8Array }) {
        if (options === undefined) {
            return;
        }

        try {
            if (typeof options !== 'object' || options === null || isProxy(options)) {
                this.#validOptions = false;
                return;
            }

            const clock = Object.getOwnPropertyDescriptor(options, 'now');
            const random = Object.getOwnPropertyDescriptor(options, 'randomBytes');

            if (
                (clock && !('value' in clock)) ||
                (random && !('value' in random)) ||
                (clock && clock.value !== undefined && typeof clock.value !== 'function') ||
                (random && random.value !== undefined && typeof random.value !== 'function')
            ) {
                this.#validOptions = false;
                return;
            }

            if (clock && clock.value !== undefined) {
                this.#clock = clock.value as () => number;
            }

            if (random && random.value !== undefined) {
                this.#random = random.value as (size: number) => Uint8Array;
                this.#defaultRandom = false;
            }
        } catch {
            this.#validOptions = false;
        }
    }

    upload(
        name: string,
        data: string,
        sha256?: string,
        canCommit?: () => boolean,
    ): V12UploadResult {
        if (this.#closed || this.#busy || !this.#validOptions) {
            return { kind: 'unavailable' };
        }

        this.#busy = true;
        const revision = this.#revision;
        let bytes: Buffer | null = null;

        try {
            const now = this.#accessTime(revision);

            if (now === null) {
                return { kind: 'unavailable' };
            }

            if (
                typeof name !== 'string' ||
                name.length > MAX_NAME_LENGTH ||
                typeof data !== 'string' ||
                (sha256 !== undefined && !isLowerSha256(sha256))
            ) {
                return { kind: 'invalid' };
            }

            const length = decodedLength(data);

            if (length === null) {
                return { kind: 'invalid' };
            }

            bytes = bufferFrom(data, 'base64');

            if (!this.#current(revision)) {
                return { kind: 'unavailable' };
            }

            const encoded: unknown = apply(bufferToString, bytes, ['base64']);
            const actualLength: unknown = apply(typedArrayByteLength, bytes, []);

            if (!this.#current(revision)) {
                return { kind: 'unavailable' };
            }

            if (actualLength !== length || encoded !== data) {
                return { kind: 'invalid' };
            }

            const hash = createHash('sha256');

            if (!this.#current(revision)) {
                return { kind: 'unavailable' };
            }

            apply(hashUpdate, hash, [bytes]);

            if (!this.#current(revision)) {
                return { kind: 'unavailable' };
            }

            const digest: unknown = apply(hashDigest, hash, ['hex']);

            if (!this.#current(revision) || !isLowerSha256(digest)) {
                return { kind: 'unavailable' };
            }

            if (sha256 !== undefined && sha256 !== digest) {
                return { kind: 'invalid' };
            }

            const entries = this.#entries;

            if (!entries || !this.#current(revision)) {
                return { kind: 'unavailable' };
            }

            if (
                apply(mapSize, entries, []) >= MAX_ENTRIES ||
                this.#totalBytes + length > MAX_TOTAL_BYTES
            ) {
                return { kind: 'capacity' };
            }

            for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt += 1) {
                let source: unknown;
                let tokenBytes: Buffer | null = null;
                let fileId: string | null = null;

                try {
                    source = apply(this.#random, undefined, [TOKEN_BYTES]);

                    if (!this.#current(revision)) {
                        return { kind: 'unavailable' };
                    }

                    tokenBytes = copyRandomBytes(source);

                    if (!this.#current(revision) || !tokenBytes) {
                        return { kind: 'unavailable' };
                    }

                    const token: unknown = apply(bufferToString, tokenBytes, ['base64url']);

                    if (
                        !this.#current(revision) ||
                        typeof token !== 'string' ||
                        token.length !== TOKEN_TEXT_LENGTH
                    ) {
                        return { kind: 'unavailable' };
                    }

                    const candidate = V12_UPLOAD_TOKEN_PREFIX + token;
                    const existing: unknown = apply(mapGet, entries, [candidate]);

                    if (!this.#current(revision)) {
                        return { kind: 'unavailable' };
                    }

                    if (existing === undefined) {
                        fileId = candidate;
                    }
                } finally {
                    if (tokenBytes) {
                        erase(tokenBytes);
                    }

                    if (this.#defaultRandom) {
                        wipeDefaultRandom(source);
                    }
                }

                if (!this.#current(revision) || this.#entries !== entries) {
                    return { kind: 'unavailable' };
                }

                if (fileId === null) {
                    continue;
                }

                if (bytes === null) {
                    return { kind: 'unavailable' };
                }

                const entry: Entry = { name, bytes, length, sha256: digest, createdAt: now };
                const result: V12UploadResult = { kind: 'ok', fileId };

                // All temporary token cleanup precedes the final guard and commit.
                if (canCommit !== undefined) {
                    const allowed: unknown = apply(canCommit, undefined, []);

                    if (allowed !== true) {
                        return { kind: 'unavailable' };
                    }
                }

                if (!this.#current(revision) || this.#entries !== entries) {
                    return { kind: 'unavailable' };
                }

                apply(mapSet, entries, [fileId, entry]);
                this.#totalBytes += length;
                bytes = null; // Ownership transferred to the map.
                return result;
            }

            return { kind: 'unavailable' };
        } catch {
            return { kind: 'unavailable' };
        } finally {
            if (bytes) {
                erase(bytes);
            }

            this.#busy = false;
        }
    }

    get(fileId: string, canRead?: () => boolean): V12ReadUploadResult {
        if (this.#closed || this.#busy || !this.#validOptions) {
            return { kind: 'unavailable' };
        }

        this.#busy = true;
        const revision = this.#revision;

        try {
            if (this.#accessTime(revision) === null) {
                return { kind: 'unavailable' };
            }

            if (
                typeof fileId !== 'string' ||
                fileId.length !== V12_UPLOAD_TOKEN_PREFIX.length + TOKEN_TEXT_LENGTH ||
                !isV12UploadToken(fileId)
            ) {
                return { kind: 'not_found' };
            }

            const entries = this.#entries;

            if (!entries || !this.#current(revision)) {
                return { kind: 'unavailable' };
            }

            const entry = apply(mapGet, entries, [fileId]) as Entry | undefined;

            if (!this.#current(revision)) {
                return { kind: 'unavailable' };
            }

            if (!entry) {
                return { kind: 'not_found' };
            }

            const data: unknown = apply(bufferToString, entry.bytes, ['base64']);

            if (!this.#current(revision) || typeof data !== 'string') {
                return { kind: 'unavailable' };
            }

            if (canRead !== undefined) {
                const allowed: unknown = apply(canRead, undefined, []);

                if (allowed !== true) {
                    return { kind: 'unavailable' };
                }
            }

            if (!this.#current(revision) || this.#entries !== entries) {
                return { kind: 'unavailable' };
            }

            return { kind: 'ok', name: entry.name, data, sha256: entry.sha256 };
        } catch {
            return { kind: 'unavailable' };
        } finally {
            this.#busy = false;
        }
    }

    /** Revoke first, detach the map, then wipe all reachable retained buffers. */
    close(): void {
        if (this.#closed) {
            return;
        }

        this.#closed = true;
        const entries = this.#entries;
        this.#entries = null;
        this.#revision = 1;
        this.#totalBytes = 0;
        this.#lastNow = null;

        if (!entries) {
            return;
        }

        try {
            const iterator = apply(mapEntries, entries, []) as Iterator<[string, Entry]>;

            for (;;) {
                const next = apply(mapIteratorNext, iterator, []) as IteratorResult<
                    [string, Entry]
                >;

                if (next.done) {
                    break;
                }

                erase(next.value[1].bytes);
            }
        } catch {
            // Continue detaching references even if best-effort wiping fails.
        } finally {
            try {
                apply(mapClear, entries, []);
            } catch {
                // The map is already detached and the store is permanently closed.
            }
        }
    }

    #current(revision: number): boolean {
        return !this.#closed && this.#revision === revision && this.#entries !== null;
    }

    /** Read and validate the clock before changing timestamps or cached data. */
    #accessTime(revision: number): number | null {
        const value: unknown = apply(this.#clock, undefined, []);

        if (
            !this.#current(revision) ||
            typeof value !== 'number' ||
            !finiteNumber(value) ||
            value < 0 ||
            (this.#lastNow !== null && value < this.#lastNow)
        ) {
            return null;
        }

        const entries = this.#entries;

        if (!entries) {
            return null;
        }

        this.#lastNow = value;
        const iterator = apply(mapEntries, entries, []) as Iterator<[string, Entry]>;

        for (;;) {
            const next = apply(mapIteratorNext, iterator, []) as IteratorResult<[string, Entry]>;

            if (next.done) {
                break;
            }

            const id = next.value[0];
            const entry = next.value[1];

            // Subtraction avoids overflow or a rounded expiration timestamp.
            if (value - entry.createdAt >= TTL_MS) {
                apply(mapDelete, entries, [id]);
                this.#totalBytes -= entry.length;
                erase(entry.bytes);

                if (!this.#current(revision)) {
                    return null;
                }
            }
        }

        return this.#current(revision) ? value : null;
    }
}
