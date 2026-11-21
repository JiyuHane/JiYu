import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';

/** A local credential snapshot, not evidence of authentication or an online session. */
export interface WtPersistedSessionV1 {
    readonly version: 1;
    readonly uin: string;
    readonly uid: string;
    readonly guid: Uint8Array;
    readonly tickets: Readonly<{
        d2: Uint8Array;
        d2Key: Uint8Array;
        a1: Uint8Array;
        a2: Uint8Array;
    }>;
}

export interface WtSessionCheckpointContext {
    readonly signal: AbortSignal;
    /** Absolute Unix seconds supplied only for a native ticket-renewal save. */
    readonly ticketMetadata?: Readonly<{
        readonly nextRefreshAtSeconds: bigint;
        readonly expiresAtSeconds: bigint;
    }>;
    /** Valid only during this invocation and while its exact owner is still live. */
    isCurrent(): boolean;
}

export interface WtSessionCheckpoint {
    readonly timeoutMs: number;
    /** Borrowed independent bytes, cleared on settlement or earlier cancellation.
     * Resolve only after the caller's durable commit. No filesystem policy is inferred. */
    readonly save: (
        snapshot: WtPersistedSessionV1,
        context: WtSessionCheckpointContext,
    ) => void | Promise<void>;
    /** Durably invalidate the exact retained generation represented by context.
     * Resolve only after the invalidation commit. */
    readonly invalidate?: (context: WtSessionCheckpointContext) => void | Promise<void>;
}

const INVALID = 'invalid WT persisted session';
const FIELD_LIMIT = 65535;
const HEADER_BYTES = 8 + 7 * 4;
/** Header + decimal UIN + UID + GUID + D2 + D2Key + A1 + A2. */
export const MAX_WT_PERSISTED_SESSION_BYTES = HEADER_BYTES + 10 + FIELD_LIMIT * 4 + 32;
const MAGIC = Uint8Array.of(0x4a, 0x59, 0x57, 0x54, 1, 0, 0, 0);
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const lengthOf = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const offsetOf = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const bufferOf = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const set = Uint8Array.prototype.set;
const fill = Uint8Array.prototype.fill;
const encodeText = new TextEncoder();
const decodeText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const fields = ['uin', 'uid', 'guid', 'd2', 'd2Key', 'a1', 'a2'] as const;

function plain(value: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || isProxy(value)) {
        throw new Error(INVALID);
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    const actual = Reflect.ownKeys(value);

    if ((prototype !== Object.prototype && prototype !== null) || actual.length !== keys.length) {
        throw new Error(INVALID);
    }

    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const key of actual) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (
            typeof key !== 'string' ||
            !keys.includes(key) ||
            !descriptor ||
            !('value' in descriptor)
        ) {
            throw new Error(INVALID);
        }

        result[key] = descriptor.value;
    }

    return result;
}

function copyBytes(value: unknown, min: number, max: number): Uint8Array {
    if (isProxy(value) || !isUint8Array(value)) {
        throw new Error(INVALID);
    }

    const size = lengthOf.call(value) as number;
    const offset = offsetOf.call(value) as number;
    const buffer = bufferOf.call(value) as ArrayBuffer;

    if (
        size < min ||
        size > max ||
        isSharedArrayBuffer(buffer) ||
        resizable?.call(buffer) === true
    ) {
        throw new Error(INVALID);
    }

    // No user iterator or accessor is evaluated, including spoofed byte metadata.
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (
            typeof key !== 'string' ||
            !/^(0|[1-9][0-9]*)$/.test(key) ||
            Number(key) >= size ||
            !descriptor ||
            !('value' in descriptor)
        ) {
            throw new Error(INVALID);
        }
    }

    const view = new Uint8Array(buffer, offset, size);
    const result = new Uint8Array(size);
    set.call(result, view);
    return result;
}

function wipe(value: Uint8Array | undefined): void {
    if (value) {
        try {
            fill.call(value, 0);
        } catch {
            // Detached callback buffers and engine/crypto copies are best effort.
        }
    }
}

function text(value: unknown, max: number): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > max) {
        throw new Error(INVALID);
    }

    const encoded = encodeText.encode(value);

    try {
        if (encoded.length > max || decodeText.decode(encoded) !== value) {
            throw new Error(INVALID);
        }

        return value;
    } finally {
        wipe(encoded);
    }
}

/** Strictly snapshot unknown caller data. Returned records are frozen, not their byte views. */
export function cloneWtPersistedSession(input: unknown): WtPersistedSessionV1 {
    const owned: Uint8Array[] = [];

    try {
        const source = plain(input, ['version', 'uin', 'uid', 'guid', 'tickets']);
        const tickets = plain(source.tickets, ['d2', 'd2Key', 'a1', 'a2']);
        const uin = text(source.uin, 10);
        const uid = text(source.uid, FIELD_LIMIT);

        if (source.version !== 1 || !/^[1-9][0-9]{0,9}$/.test(uin) || BigInt(uin) > 0xffffffffn) {
            throw new Error(INVALID);
        }

        const take = (value: unknown, min: number, max: number): Uint8Array => {
            const result = copyBytes(value, min, max);
            owned.push(result);
            return result;
        };

        const guid = take(source.guid, 16, 16);
        const d2 = take(tickets.d2, 1, FIELD_LIMIT);
        const d2Key = take(tickets.d2Key, 16, 16);
        const a1 = take(tickets.a1, 1, FIELD_LIMIT);
        const a2 = take(tickets.a2, 1, FIELD_LIMIT);
        return Object.freeze({
            version: 1,
            uin,
            uid,
            guid,
            tickets: Object.freeze({ d2, d2Key, a1, a2 }),
        });
    } catch {
        owned.forEach(wipe);
        throw new Error(INVALID);
    }
}

/** Clear only the supplied views, never their entire backing buffers. Idempotent, best effort.
 * Strings and copies made by a consumer remain outside this function's control. */
export function disposeWtPersistedSession(input: WtPersistedSessionV1): void {
    try {
        const source = plain(input, ['version', 'uin', 'uid', 'guid', 'tickets']);
        const tickets = plain(source.tickets, ['d2', 'd2Key', 'a1', 'a2']);

        for (const value of [source.guid, tickets.d2, tickets.d2Key, tickets.a1, tickets.a2]) {
            if (!isProxy(value) && isUint8Array(value)) {
                wipe(value);
            }
        }
    } catch {
        // This cleanup entry never evaluates accessors or hides the original failure.
    }
}

/** Binary v1: fixed magic/version/reserved bytes, seven BE32 lengths, seven byte strings.
 * No encryption or filesystem access. The caller must protect and dispose the returned bytes. */
export function encodeWtPersistedSession(input: unknown): Uint8Array {
    let snapshot: WtPersistedSessionV1 | undefined;
    let uin: Uint8Array | undefined;
    let uid: Uint8Array | undefined;
    let output: Uint8Array | undefined;
    let success = false;

    try {
        snapshot = cloneWtPersistedSession(input);
        uin = encodeText.encode(snapshot.uin);
        uid = encodeText.encode(snapshot.uid);
        const values = [
            uin,
            uid,
            snapshot.guid,
            snapshot.tickets.d2,
            snapshot.tickets.d2Key,
            snapshot.tickets.a1,
            snapshot.tickets.a2,
        ];
        const size = HEADER_BYTES + values.reduce((total, value) => total + value.length, 0);
        output = new Uint8Array(size);
        set.call(output, MAGIC);
        const view = new DataView(output.buffer);
        let offset = HEADER_BYTES;

        values.forEach((value, index) => {
            view.setUint32(8 + index * 4, value.length, false);
            set.call(output!, value, offset);
            offset += value.length;
        });
        success = true;
        return output;
    } catch {
        throw new Error(INVALID);
    } finally {
        if (!success) {
            wipe(output);
        }

        wipe(uin);
        wipe(uid);

        if (snapshot) {
            disposeWtPersistedSession(snapshot);
        }
    }
}

/** Loading bytes establishes neither the issuing account nor ticket freshness. */
export function decodeWtPersistedSession(input: unknown): WtPersistedSessionV1 {
    let bytes: Uint8Array | undefined;

    try {
        bytes = copyBytes(input, HEADER_BYTES, MAX_WT_PERSISTED_SESSION_BYTES);

        for (let index = 0; index < MAGIC.length; index++) {
            if (bytes[index] !== MAGIC[index]) {
                throw new Error(INVALID);
            }
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
        const values: Record<string, Uint8Array> = Object.create(null) as Record<
            string,
            Uint8Array
        >;
        let offset = HEADER_BYTES;

        fields.forEach((field, index) => {
            const size = view.getUint32(8 + index * 4, false);
            const maximum =
                field === 'uin' ? 10 : field === 'guid' || field === 'd2Key' ? 16 : FIELD_LIMIT;

            if (size === 0 || size > maximum || size > bytes!.length - offset) {
                throw new Error(INVALID);
            }

            values[field] = bytes!.subarray(offset, offset + size);
            offset += size;
        });

        if (offset !== bytes.length) {
            throw new Error(INVALID);
        }

        return cloneWtPersistedSession({
            version: 1,
            uin: decodeText.decode(values.uin),
            uid: decodeText.decode(values.uid),
            guid: values.guid,
            tickets: { d2: values.d2, d2Key: values.d2Key, a1: values.a1, a2: values.a2 },
        });
    } catch {
        throw new Error(INVALID);
    } finally {
        wipe(bytes);
    }
}
