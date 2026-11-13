import { isProxy } from 'node:util/types';

/** Local policies, not target protocol limits or a peak-memory bound. */
export const MAX_TARGET_QR12_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_TARGET_QR12_RESPONSE_ENTRIES = 4096;

export interface TargetQr12Response {
    first: {
        raw: Uint8Array;
        nativeProjection: { kind: 'unchanged' } | { kind: 'assigned'; bytes: Uint8Array };
    };
    word1Bits: number;
    statusByte: number;
    word2Bits: bigint;
    word3Bits: number;
    declaredCount: number;
    entries: { tag: number; value: Uint8Array }[];
    consumed: number;
}

const Bytes = Uint8Array;
const View = DataView;
const typed = Object.getPrototypeOf(Bytes.prototype) as object;
const tagGetter = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const lengthGetter = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const values = Bytes.prototype.values;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;
const isView = ArrayBuffer.isView;
const getPrototype = Object.getPrototypeOf;

type Span = { start: number; length: number };

/**
 * Extract only the observed QR12 response structure from an exact body slice.
 * Zero-length first fields leave the native prior value unknown and unchanged;
 * nonempty fields consume every byte but project only bytes before the first NUL.
 * The caller keeps input stable until the private snapshot is made. The size,
 * count and no-trailing-byte rules are local policies. All statuses are parsed
 * strictly; native nonzero-status read-failure behavior is not emulated. This
 * does not execute target tag factories or child decoders, assign status meaning,
 * check identity or signatures, authenticate, or establish interoperability or
 * server behavior. Extraction does not imply target decode success.
 */
export function extractTargetQr12Response(input: Uint8Array): TargetQr12Response {
    let snapshot: Uint8Array | undefined;
    const owned: Uint8Array[] = [];
    let complete = false;

    const clear = (value: Uint8Array | undefined): void => {
        if (value) {
            try {
                fill.call(value, 0);
            } catch {
                // Best effort separately for every private allocation.
            }
        }
    };

    try {
        if (isProxy(input) || !isView(input) || tagGetter.call(input) !== 'Uint8Array') {
            throw new TypeError();
        }

        let current: object | null = input;
        let depth = 0;

        while (current !== null) {
            if (depth++ >= 256 || isProxy(current)) {
                throw new TypeError();
            }

            current = getPrototype(current) as object | null;
        }

        const backing = bufferGetter.call(input) as ArrayBuffer;
        bufferLength.call(backing); // Reject shared buffers, also across realms.
        values.call(input); // Reject detached and out-of-bounds resizable views.
        const length = lengthGetter.call(input) as number;
        const offset = offsetGetter.call(input) as number;

        if (length > MAX_TARGET_QR12_RESPONSE_BYTES) {
            throw new RangeError();
        }

        snapshot = new Bytes(length);
        set.call(snapshot, new Bytes(backing, offset, length));
        const view = new View(snapshot.buffer);
        let cursor = 0;

        const take = (size: number): number => {
            if (size > length - cursor) {
                throw new RangeError();
            }

            const start = cursor;
            cursor += size;
            return start;
        };

        const read16 = (): number => view.getUint16(take(2), false);

        const span = (): Span => {
            const size = read16();
            return { start: take(size), length: size };
        };

        const firstSpan = span();
        const word1Bits = view.getUint32(take(4), false);
        const statusByte = view.getUint8(take(1));
        const word2Bits = view.getBigUint64(take(8), false);
        const word3Bits = view.getUint32(take(4), false);
        const declaredCount = read16();

        if (
            declaredCount > MAX_TARGET_QR12_RESPONSE_ENTRIES ||
            declaredCount > Math.floor((length - cursor) / 4)
        ) {
            throw new RangeError();
        }

        const spans: { tag: number; value: Span }[] = [];

        for (let i = 0; i < declaredCount; i++) {
            spans.push({ tag: read16(), value: span() });
        }

        if (cursor !== length) {
            throw new RangeError();
        }

        const copy = (part: Span): Uint8Array => {
            const result = new Bytes(part.length);
            owned.push(result);
            set.call(result, new Bytes(snapshot!.buffer, part.start, part.length));
            return result;
        };

        const raw = copy(firstSpan);
        let first: TargetQr12Response['first'];

        if (firstSpan.length === 0) {
            first = { raw, nativeProjection: { kind: 'unchanged' } };
        } else {
            let size = 0;

            while (size < firstSpan.length && snapshot[firstSpan.start + size] !== 0) {
                size++;
            }

            first = {
                raw,
                nativeProjection: {
                    kind: 'assigned',
                    bytes: copy({ start: firstSpan.start, length: size }),
                },
            };
        }

        const result: TargetQr12Response = {
            first,
            word1Bits,
            statusByte,
            word2Bits,
            word3Bits,
            declaredCount,
            entries: spans.map((entry) => ({ tag: entry.tag, value: copy(entry.value) })),
            consumed: cursor,
        };
        complete = true;
        return result;
    } catch {
        throw new Error('target QR12 response extraction failed');
    } finally {
        clear(snapshot);

        if (!complete) {
            for (const value of owned) {
                clear(value);
            }
        }
    }
}
