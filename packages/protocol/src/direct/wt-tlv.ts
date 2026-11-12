// Static wire-layout reference; this codec has not been validated against live QQ.
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Utility/ProtocolHelper.cs
// BinaryPacket.Read<T> uses big-endian numeric fields:
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Utility/Binary/BinaryPacket.cs
// Unlike the reference's dictionary, an array preserves duplicate tags and order.

export const MAX_WT_TLV_BYTES = 16 * 1024 * 1024;
const MAX_U16 = 0xffff;

export interface WtTlvEntry {
    tag: number;
    value: Uint8Array;
}

/** Encode a count followed by tag, value length and value for each entry. */
export function encodeWtTlv(entries: readonly WtTlvEntry[]): Uint8Array {
    if (!Array.isArray(entries) || entries.length > MAX_U16) {
        throw new RangeError('invalid WT TLV entry count');
    }

    let length = 2;

    for (const entry of entries) {
        if (!entry || !Number.isInteger(entry.tag) || entry.tag < 0 || entry.tag > MAX_U16) {
            throw new RangeError('invalid WT TLV tag');
        }

        if (!(entry.value instanceof Uint8Array) || entry.value.length > MAX_U16) {
            throw new RangeError('invalid WT TLV value');
        }

        length += 4 + entry.value.length;

        if (length > MAX_WT_TLV_BYTES) {
            throw new RangeError('WT TLV exceeds size limit');
        }
    }

    const result = new Uint8Array(length);
    const view = new DataView(result.buffer);
    view.setUint16(0, entries.length);
    let offset = 2;

    for (const entry of entries) {
        view.setUint16(offset, entry.tag);
        view.setUint16(offset + 2, entry.value.length);
        offset += 4;
        result.set(entry.value, offset);
        offset += entry.value.length;
    }

    return result;
}

/** Decode exactly one complete block; returned values own independent bytes. */
export function decodeWtTlv(input: Uint8Array): WtTlvEntry[] {
    if (!(input instanceof Uint8Array) || input.length < 2 || input.length > MAX_WT_TLV_BYTES) {
        throw new RangeError('invalid WT TLV block size');
    }

    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const count = view.getUint16(0);
    let offset = 2;
    const entries: WtTlvEntry[] = [];

    let complete = false;

    try {
        for (let i = 0; i < count; i++) {
            if (input.length - offset < 4) {
                throw new RangeError('truncated WT TLV header');
            }

            const tag = view.getUint16(offset);
            const length = view.getUint16(offset + 2);
            offset += 4;

            if (length > input.length - offset) {
                throw new RangeError('truncated WT TLV value');
            }

            entries.push({ tag, value: Uint8Array.from(input.subarray(offset, offset + length)) });
            offset += length;
        }

        if (offset !== input.length) {
            throw new RangeError('trailing WT TLV bytes');
        }

        complete = true;
        return entries;
    } finally {
        if (!complete) {
            for (const entry of entries) {
                try {
                    entry.value.fill(0);
                } catch {
                    // Best effort for each owned copy without masking the parse error.
                }
            }
        }
    }
}
