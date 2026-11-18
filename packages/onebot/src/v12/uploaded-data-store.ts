import { createHash, Hash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isArrayBuffer, isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';

/** Reserved local namespace, including malformed or expired upload handles. */
export const V12_UPLOAD_TOKEN_PREFIX = 'jiyu-upload:v1:';
export const V12_UPLOAD_DRAFT_TOKEN_PREFIX = 'jiyu-upload-draft:v1:';

export type V12UploadResult =
    { kind: 'ok'; fileId: string } | { kind: 'invalid' | 'capacity' | 'unavailable' };

export type V12ReadUploadResult =
    | { kind: 'ok'; name: string; data: string; sha256: string }
    | { kind: 'not_found' | 'unavailable' };

export type V12FragmentMetadataResult =
    | { kind: 'ok'; name: string; totalSize: number; sha256: string }
    | { kind: 'not_found' | 'unavailable' };

export type V12FragmentChunkResult =
    { kind: 'ok'; data: string } | { kind: 'not_found' | 'unavailable' | 'invalid_range' };

export type V12FragmentUploadPrepareResult =
    { kind: 'ok'; draftId: string } | { kind: 'invalid' | 'capacity' | 'unavailable' };

export type V12FragmentUploadTransferResult =
    { kind: 'ok' } | { kind: 'invalid' | 'not_found' | 'invalid_range' | 'unavailable' };

export type V12FragmentUploadFinishResult =
    | { kind: 'ok'; fileId: string }
    | { kind: 'invalid' | 'not_found' | 'incomplete' | 'unavailable' };

const MAX_NAME_LENGTH = 4096;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_FILE_BYTES / 3);
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 32;
const TOKEN_BYTES = 32;
const TOKEN_TEXT_LENGTH = 43;
const MAX_TOKEN_ATTEMPTS = 4;
const TTL_MS = 600_000;

type FileBytes = {
    name: string;
    bytes: Buffer;
    length: number;
    createdAt: number;
};

type Entry = FileBytes & { kind: 'file'; sha256: string };
type Draft = FileBytes & { kind: 'draft'; written: number };
type Stored = Entry | Draft;

type DraftAccess = {
    entries: Map<string, Stored>;
    revision: number;
    now: number;
    canWrite(): boolean;
};

// Capture the operations used on untrusted injected byte views and on private
// state. This assumes genuine built-ins at module initialization; it is not an
// isolation boundary against arbitrary same-process code.
const apply = Reflect.apply;
const bufferFrom = Buffer.from;
const bufferAlloc = Buffer.alloc;
const bufferToString = Buffer.prototype.toString;
const bufferWrite = Buffer.prototype.write;
const hashUpdate = Hash.prototype.update;
const hashDigest = Hash.prototype.digest;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const mapDelete = Map.prototype.delete;
const mapClear = Map.prototype.clear;
const mapEntries = Map.prototype.entries;
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!;
const mapIteratorNext = Object.getPrototypeOf(new Map().entries()).next as (
    this: Iterator<[string, Stored]>,
) => IteratorResult<[string, Stored]>;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'byteLength',
)!.get!;
const finiteNumber = Number.isFinite;
const safeInteger = Number.isSafeInteger;
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
 * Account-owner-local, synchronous content cache, not a QQ upload. The runtime
 * can use an eligible current-generation handle for its separately guarded,
 * single-image send subset; this store itself does not initiate a media send.
 * The runtime owner controls its lifetime and must call close when revoking it.
 *
 * Limits apply to this instance's retained raw data and entry count, not process
 * RSS. Draft reservations share these limits with published files. TTL is
 * 600,000 ms from the initial validated upload or prepare clock sample, not
 * commit or finish; a later access may immediately expire an entry after slow
 * work. Expiry is lazy: idle entries remain until another access or close.
 * Store-owned buffers are wiped on expiry, close, and failed operations on a
 * best-effort basis. JavaScript strings, input Base64, returned copies, crypto
 * internals, and caller-owned injection buffers cannot be guaranteed erased.
 * Collision checks cover the current map only. An expired or consumed ID can
 * theoretically recur, and another store may produce the same string. The
 * injected RNG is a trusted test seam; observed bytes cannot prove unpredictability.
 * Production uses node:crypto randomBytes.
 * Optional synchronous guards protect commit/disclosure at the caller's request;
 * the owner remains responsible for identity and authorization.
 */
export class V12UploadedDataStore {
    #entries: Map<string, Stored> | null = new Map();
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

            const digest = this.#digest(bytes, revision);

            if (digest === null) {
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

            const fileId = this.#newId(V12_UPLOAD_TOKEN_PREFIX, entries, revision);

            if (fileId === null) {
                return { kind: 'unavailable' };
            }

            const entry: Entry = {
                kind: 'file',
                name,
                bytes,
                length,
                sha256: digest,
                createdAt: now,
            };
            const result: V12UploadResult = { kind: 'ok', fileId };

            // All temporary token cleanup precedes the final guard and commit.
            if (canCommit !== undefined && apply(canCommit, undefined, []) !== true) {
                return { kind: 'unavailable' };
            }

            if (!this.#current(revision) || this.#entries !== entries) {
                return { kind: 'unavailable' };
            }

            apply(mapSet, entries, [fileId, entry]);
            this.#totalBytes += length;
            bytes = null; // Ownership transferred to the map.
            return result;
        } catch {
            return { kind: 'unavailable' };
        } finally {
            if (bytes) {
                erase(bytes);
            }

            this.#busy = false;
        }
    }

    /** Reserve the complete size; the draft ID is not usable as a file ID. */
    prepareFragments(
        name: string,
        totalSize: number,
        canCommit?: () => boolean,
    ): V12FragmentUploadPrepareResult {
        return this.#editDraft<V12FragmentUploadPrepareResult>(canCommit, (access) => {
            if (
                typeof name !== 'string' ||
                name.length > MAX_NAME_LENGTH ||
                typeof totalSize !== 'number' ||
                !safeInteger(totalSize) ||
                totalSize < 0 ||
                totalSize > MAX_FILE_BYTES
            ) {
                return { kind: 'invalid' };
            }

            const { entries, revision, now, canWrite } = access;

            if (
                apply(mapSize, entries, []) >= MAX_ENTRIES ||
                totalSize > MAX_TOTAL_BYTES - this.#totalBytes
            ) {
                return { kind: 'capacity' };
            }

            const draftId = this.#newId(V12_UPLOAD_DRAFT_TOKEN_PREFIX, entries, revision);

            if (draftId === null) {
                return { kind: 'unavailable' };
            }

            // Accept -0 as zero but keep the stored length canonical.
            const length = totalSize === 0 ? 0 : totalSize;
            const bytes = bufferAlloc(length);
            let kept = false;

            try {
                const entry: Draft = {
                    kind: 'draft',
                    name,
                    bytes,
                    length,
                    createdAt: now,
                    written: 0,
                };

                if (!canWrite()) {
                    return { kind: 'unavailable' };
                }

                apply(mapSet, entries, [draftId, entry]);
                this.#totalBytes += length;
                kept = true;
                return { kind: 'ok', draftId };
            } finally {
                if (!kept) {
                    erase(bytes);
                }
            }
        });
    }

    /** Stage one nonempty chunk, exactly at the current cursor. */
    transferFragment(
        draftId: string,
        offset: number,
        data: string,
        canCommit?: () => boolean,
    ): V12FragmentUploadTransferResult {
        return this.#editDraft<V12FragmentUploadTransferResult>(canCommit, (access) => {
            const length = typeof data === 'string' ? decodedLength(data) : null;

            if (length === null || length === 0) {
                return { kind: 'invalid' };
            }

            const draft = this.#draft(access.entries, draftId);

            if (!draft) {
                return { kind: 'not_found' };
            }

            if (
                typeof offset !== 'number' ||
                !safeInteger(offset) ||
                offset !== draft.written ||
                length > draft.length - draft.written
            ) {
                return { kind: 'invalid_range' };
            }

            // Keep the checked chunk off the shared Buffer pool across the final guard.
            const bytes = bufferAlloc(length);

            try {
                const written: unknown = apply(bufferWrite, bytes, [data, 0, length, 'base64']);

                if (!this.#current(access.revision)) {
                    return { kind: 'unavailable' };
                }

                const encoded: unknown = apply(bufferToString, bytes, ['base64']);

                if (!this.#current(access.revision)) {
                    return { kind: 'unavailable' };
                }

                if (written !== length || encoded !== data) {
                    return { kind: 'invalid' };
                }

                if (!access.canWrite()) {
                    return { kind: 'unavailable' };
                }

                apply(typedArraySet, draft.bytes, [bytes, offset]);
                draft.written += length;
                return { kind: 'ok' };
            } finally {
                erase(bytes);
            }
        });
    }

    /** Publish a complete, hash-matched draft and consume its staging handle. */
    finishFragments(
        draftId: string,
        sha256: string,
        canCommit?: () => boolean,
    ): V12FragmentUploadFinishResult {
        return this.#editDraft<V12FragmentUploadFinishResult>(canCommit, (access) => {
            if (!isLowerSha256(sha256)) {
                return { kind: 'invalid' };
            }

            const { entries, revision, canWrite } = access;
            const draft = this.#draft(entries, draftId);

            if (!draft) {
                return { kind: 'not_found' };
            }

            if (draft.written !== draft.length) {
                return { kind: 'incomplete' };
            }

            const digest = this.#digest(draft.bytes, revision);

            if (digest === null) {
                return { kind: 'unavailable' };
            }

            if (digest !== sha256) {
                return { kind: 'invalid' };
            }

            const fileId = this.#newId(V12_UPLOAD_TOKEN_PREFIX, entries, revision);

            if (fileId === null) {
                return { kind: 'unavailable' };
            }

            const { name, bytes, length, createdAt } = draft;
            const entry: Entry = { kind: 'file', name, bytes, length, sha256: digest, createdAt };

            if (!canWrite()) {
                return { kind: 'unavailable' };
            }

            // No callback between the insert and removal. The prepared buffer
            // and its quota reservation move to the final ID without copying.
            apply(mapSet, entries, [fileId, entry]);
            apply(mapDelete, entries, [draftId]);
            return { kind: 'ok', fileId };
        });
    }

    #draft(entries: Map<string, Stored>, id: unknown): Draft | undefined {
        if (
            typeof id !== 'string' ||
            id.length !== V12_UPLOAD_DRAFT_TOKEN_PREFIX.length + TOKEN_TEXT_LENGTH ||
            !startsWith(id, V12_UPLOAD_DRAFT_TOKEN_PREFIX)
        ) {
            return undefined;
        }

        const entry = apply(mapGet, entries, [id]) as Stored | undefined;
        return entry?.kind === 'draft' ? entry : undefined;
    }

    #editDraft<T>(
        guard: (() => boolean) | undefined,
        operation: (access: DraftAccess) => T,
    ): T | { kind: 'unavailable' } {
        const entries = this.#entries;

        if (!entries || this.#closed || this.#busy || !this.#validOptions) {
            return { kind: 'unavailable' };
        }

        this.#busy = true;
        const revision = this.#revision;
        const current = () => this.#current(revision) && this.#entries === entries;
        const canWrite = () =>
            current() && (guard === undefined || apply(guard, undefined, []) === true) && current();

        try {
            if (!canWrite()) {
                return { kind: 'unavailable' };
            }

            const now = this.#accessTime(revision);

            if (now === null) {
                return { kind: 'unavailable' };
            }

            return operation({ entries, revision, now, canWrite });
        } catch {
            return { kind: 'unavailable' };
        } finally {
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

            const entry = apply(mapGet, entries, [fileId]) as Stored | undefined;

            if (!this.#current(revision)) {
                return { kind: 'unavailable' };
            }

            if (entry?.kind !== 'file') {
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

    /**
     * Read metadata from this generation's local memory only, not from QQ,
     * network storage, or a persistent upload. Each read performs lazy expiry
     * and its own optional disclosure guard.
     */
    getMetadata(fileId: string, canRead?: () => boolean): V12FragmentMetadataResult {
        return this.#readFragment(fileId, canRead, (entry): V12FragmentMetadataResult => ({
            kind: 'ok',
            name: entry.name,
            totalSize: entry.length,
            sha256: entry.sha256,
        }));
    }

    /**
     * Encode exactly the requested local byte range as padded Base64. A range
     * ending at the file length may be empty; returned strings are managed by
     * JavaScript and their erasure by garbage collection is not guaranteed.
     */
    getChunk(
        fileId: string,
        offset: number,
        size: number,
        canRead?: () => boolean,
    ): V12FragmentChunkResult {
        return this.#readFragment(fileId, canRead, (entry): V12FragmentChunkResult => {
            if (
                typeof offset !== 'number' ||
                !safeInteger(offset) ||
                offset < 0 ||
                typeof size !== 'number' ||
                !safeInteger(size) ||
                size < 0 ||
                offset > entry.length ||
                size > entry.length - offset
            ) {
                return { kind: 'invalid_range' };
            }

            const data: unknown = apply(bufferToString, entry.bytes, [
                'base64',
                offset,
                offset + size,
            ]);

            if (typeof data !== 'string') {
                return { kind: 'unavailable' };
            }

            return { kind: 'ok', data };
        });
    }

    #readFragment<T extends V12FragmentMetadataResult | V12FragmentChunkResult>(
        fileId: string,
        canRead: (() => boolean) | undefined,
        read: (entry: Entry) => T,
    ): T | { kind: 'not_found' | 'unavailable' } {
        if (this.#closed || this.#busy || !this.#validOptions) {
            return { kind: 'unavailable' };
        }

        this.#busy = true;
        const revision = this.#revision;

        try {
            if (this.#accessTime(revision) === null) {
                return { kind: 'unavailable' };
            }

            const entries = this.#entries;

            if (!entries || !this.#current(revision)) {
                return { kind: 'unavailable' };
            }

            let entry: Entry | undefined;

            if (
                typeof fileId === 'string' &&
                fileId.length === V12_UPLOAD_TOKEN_PREFIX.length + TOKEN_TEXT_LENGTH &&
                isV12UploadToken(fileId)
            ) {
                const stored = apply(mapGet, entries, [fileId]) as Stored | undefined;

                if (stored?.kind === 'file') {
                    entry = stored;
                }
            }

            if (!this.#current(revision)) {
                return { kind: 'unavailable' };
            }

            if (!entry) {
                // All misses obey the guard without inspecting or coercing an
                // invalid fileId. Recheck after its synchronous callback.
                if (canRead !== undefined && apply(canRead, undefined, []) !== true) {
                    return { kind: 'unavailable' };
                }

                return this.#current(revision) && this.#entries === entries
                    ? { kind: 'not_found' }
                    : { kind: 'unavailable' };
            }

            const result = read(entry);

            if (!this.#current(revision)) {
                return { kind: 'unavailable' };
            }

            // A range failure can reveal the file boundary, so guard it too.
            if (canRead !== undefined) {
                const allowed: unknown = apply(canRead, undefined, []);

                if (allowed !== true) {
                    return { kind: 'unavailable' };
                }
            }

            if (!this.#current(revision) || this.#entries !== entries) {
                return { kind: 'unavailable' };
            }

            return result;
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
            const iterator = apply(mapEntries, entries, []) as Iterator<[string, Stored]>;

            for (;;) {
                const next = apply(mapIteratorNext, iterator, []) as IteratorResult<
                    [string, Stored]
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

    #digest(bytes: Buffer, revision: number): string | null {
        const hash = createHash('sha256');

        if (!this.#current(revision)) {
            return null;
        }

        apply(hashUpdate, hash, [bytes]);

        if (!this.#current(revision)) {
            return null;
        }

        const digest: unknown = apply(hashDigest, hash, ['hex']);
        return this.#current(revision) && isLowerSha256(digest) ? digest : null;
    }

    #newId(prefix: string, entries: Map<string, Stored>, revision: number): string | null {
        for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt += 1) {
            let source: unknown;
            let tokenBytes: Buffer | null = null;
            let id: string | null = null;

            try {
                source = apply(this.#random, undefined, [TOKEN_BYTES]);

                if (!this.#current(revision)) {
                    return null;
                }

                tokenBytes = copyRandomBytes(source);

                if (!this.#current(revision) || !tokenBytes) {
                    return null;
                }

                const token: unknown = apply(bufferToString, tokenBytes, ['base64url']);

                if (
                    !this.#current(revision) ||
                    typeof token !== 'string' ||
                    token.length !== TOKEN_TEXT_LENGTH
                ) {
                    return null;
                }

                const candidate = prefix + token;
                const existing: unknown = apply(mapGet, entries, [candidate]);

                if (!this.#current(revision)) {
                    return null;
                }

                if (existing === undefined) {
                    id = candidate;
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
                return null;
            }

            if (id !== null) {
                return id;
            }
        }

        return null;
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
        const iterator = apply(mapEntries, entries, []) as Iterator<[string, Stored]>;

        for (;;) {
            const next = apply(mapIteratorNext, iterator, []) as IteratorResult<[string, Stored]>;

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
