import { isProxy } from 'node:util/types';

/** Local resource policies, not target protocol limits or a peak-memory bound. */
export const MAX_TARGET_QR31_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_TARGET_QR31_RESPONSE_ENTRIES = 4096;

export type TargetQr31StringField = {
    raw: Uint8Array;
    nativeProjection: { kind: 'unchanged' } | { kind: 'assigned'; bytes: Uint8Array };
};

export type TargetQr31Response = {
    first: TargetQr31StringField;
    wordBits: number;
    statusByte: number;
    consumed: number;
} & (
    | {
          kind: 'entries';
          rawSpan: Uint8Array;
          spanNativeWrite: boolean;
          declaredCount: number;
          entries: { tag: number; value: Uint8Array }[];
      }
    | { kind: 'other'; field2: TargetQr31StringField }
);

const Bytes = Uint8Array;
const View = DataView;
const typed = Object.getPrototypeOf(Bytes.prototype) as object;
const tagGetter = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const lengthGetter = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get!;
const values = Bytes.prototype.values;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;
const getPrototype = Object.getPrototypeOf;
const isView = ArrayBuffer.isView;

type Span = { start: number; length: number };

/**
 * Extract a strict, exact caller-supplied QR31 body slice using the observed
 * target-static field layout. A zero-length C-string field leaves the target's
 * previous state unchanged; for a nonzero length the projection ends at the
 * first NUL while raw keeps all consumed bytes. The raw span similarly records
 * whether its nonempty value would be written. The caller must keep input stable
 * while it is snapshotted. This is local structural extraction only: it does not
 * run target tag factories or child decoders, interpret status, decide whether
 * values are valid, authenticate, check identity/signatures, or establish server
 * behavior. Successful extraction does not imply target decode success.
 */
export function extractTargetQr31Response(input: Uint8Array): TargetQr31Response {
    let snapshot: Uint8Array | undefined;
    const outputs: Uint8Array[] = [];
    let complete = false;

    const clear = (bytes: Uint8Array | undefined): void => {
        if (bytes) {
            try {
                fill.call(bytes, 0);
            } catch {
                // Independently attempt cleanup of every private allocation.
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

        const buffer = bufferGetter.call(input) as ArrayBuffer;
        arrayBufferLength.call(buffer); // Reject SharedArrayBuffer, including foreign realms.
        values.call(input); // Reject detached and out-of-bounds resizable views.
        const length = lengthGetter.call(input) as number;
        const offset = offsetGetter.call(input) as number;

        if (length > MAX_TARGET_QR31_RESPONSE_BYTES) {
            throw new RangeError();
        }

        snapshot = new Bytes(length);
        set.call(snapshot, new Bytes(buffer, offset, length));
        const view = new View(snapshot.buffer);
        let cursor = 0;

        const read8 = (): number => {
            if (length - cursor < 1) {
                throw new RangeError();
            }

            return view.getUint8(cursor++);
        };

        const read16 = (): number => {
            if (length - cursor < 2) {
                throw new RangeError();
            }

            const result = view.getUint16(cursor, false);
            cursor += 2;
            return result;
        };

        const read32 = (): number => {
            if (length - cursor < 4) {
                throw new RangeError();
            }

            const result = view.getUint32(cursor, false);
            cursor += 4;
            return result;
        };

        const readSpan = (): Span => {
            const size = read16();

            if (size > length - cursor) {
                throw new RangeError();
            }

            const result = { start: cursor, length: size };
            cursor += size;
            return result;
        };

        const firstSpan = readSpan();
        const wordBits = read32();
        const statusByte = read8();
        const span = readSpan();
        let declaredCount = 0;
        const entrySpans: { tag: number; value: Span }[] = [];

        if (statusByte === 0 || statusByte === 2) {
            declaredCount = read16();

            if (
                declaredCount > MAX_TARGET_QR31_RESPONSE_ENTRIES ||
                declaredCount > Math.floor((length - cursor) / 4)
            ) {
                throw new RangeError();
            }

            for (let i = 0; i < declaredCount; i++) {
                entrySpans.push({ tag: read16(), value: readSpan() });
            }
        }

        // Reject trailing bytes as a local policy, not a target behavior claim.
        if (cursor !== length) {
            throw new RangeError();
        }

        const copy = (part: Span): Uint8Array => {
            const result = new Bytes(part.length);
            outputs.push(result);
            set.call(result, new Bytes(snapshot!.buffer, part.start, part.length));
            return result;
        };

        const stringField = (part: Span): TargetQr31StringField => {
            const raw = copy(part);

            if (part.length === 0) {
                return { raw, nativeProjection: { kind: 'unchanged' } };
            }

            let projectedLength = 0;

            while (projectedLength < part.length && snapshot![part.start + projectedLength] !== 0) {
                projectedLength++;
            }

            return {
                raw,
                nativeProjection: {
                    kind: 'assigned',
                    bytes: copy({ start: part.start, length: projectedLength }),
                },
            };
        };

        const first = stringField(firstSpan);
        let result: TargetQr31Response;

        if (statusByte === 0 || statusByte === 2) {
            result = {
                first,
                wordBits,
                statusByte,
                consumed: cursor,
                kind: 'entries',
                rawSpan: copy(span),
                spanNativeWrite: span.length !== 0,
                declaredCount,
                entries: entrySpans.map((entry) => ({ tag: entry.tag, value: copy(entry.value) })),
            };
        } else {
            result = {
                first,
                wordBits,
                statusByte,
                consumed: cursor,
                kind: 'other',
                field2: stringField(span),
            };
        }

        complete = true;
        return result;
    } catch {
        throw new Error('target QR31 response extraction failed');
    } finally {
        clear(snapshot);

        if (!complete) {
            for (const output of outputs) {
                clear(output);
            }
        }
    }
}
