import { decodeWtTlv } from './wt-tlv';

// Static references; no live QQ validation:
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Services/Login/TransEmpService.cs
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Login/WtLogin.cs
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Events/Login/TransEmpEvent.cs

const MAX_BODY_BYTES = 0xffff;

interface Header {
    /** Opaque signed short in the reference. */
    dummy: number;
    /** Opaque signed int in the reference, not validated against the request. */
    appId: number;
    retCode: number;
}

export type WtQrFetchResponse =
    | (Header & {
          status: 'success';
          qrSig: Uint8Array;
          image: Uint8Array;
          /** Raw TLV 0xd1; protobuf interpretation belongs to the caller. */
          d1: Uint8Array;
      })
    | (Header & { status: 'failure'; remaining: Uint8Array });

export type WtQrPollResponse =
    | (Header & {
          status: 'confirmed';
          uin: bigint;
          retry: number;
          /** Sensitive values: callers must not log or serialize this object. */
          tickets: { tgtgtKey: Uint8Array; noPicSig: Uint8Array; tempPassword: Uint8Array };
      })
    | (Header & {
          status: 'expired' | 'wait' | 'confirm' | 'canceled' | 'invalid' | 'unknown';
          /** Uninterpreted remainder; may contain sensitive data. */
          remaining: Uint8Array;
      });

function header(input: Uint8Array): { data: DataView; fields: Header } {
    if (!(input instanceof Uint8Array) || input.length < 7 || input.length > MAX_BODY_BYTES) {
        throw new RangeError('invalid WT QR response body size');
    }

    const data = new DataView(input.buffer, input.byteOffset, input.byteLength);
    return {
        data,
        fields: { dummy: data.getInt16(0), appId: data.getInt32(2), retCode: data.getUint8(6) },
    };
}

function uniqueEntries(input: Uint8Array): Map<number, Uint8Array> {
    const entries = new Map<number, Uint8Array>();

    for (const entry of decodeWtTlv(input)) {
        if (entries.has(entry.tag)) {
            throw new Error('duplicate WT QR TLV tag');
        }

        entries.set(entry.tag, entry.value);
    }

    return entries;
}

function required(entries: Map<number, Uint8Array>, tag: number): Uint8Array {
    const value = entries.get(tag);

    if (!value || value.length === 0) {
        throw new Error(`missing or empty WT QR TLV 0x${tag.toString(16)}`);
    }

    return value;
}

/**
 * Parse exactly the command 0x31 business body, not OICQ or code2d framing.
 * The reference returns all remaining code2d bytes and never validates/removes
 * a response trailer. The caller must supply the exact business-body slice;
 * this parser never guesses whether a final 0x03 is framing or payload.
 * Returned signatures and raw fields are sensitive and must not be logged.
 */
export function decodeWtQrFetchResponse(input: Uint8Array): WtQrFetchResponse {
    const { data, fields } = header(input);

    if (fields.retCode !== 0) {
        return { ...fields, status: 'failure', remaining: Uint8Array.from(input.subarray(7)) };
    }

    if (input.length < 9) {
        throw new RangeError('truncated WT QR signature length');
    }

    // BinaryPacket.ReadBytes(Int16 | LengthOnly) reads a signed Int16.
    const length = data.getInt16(7);

    if (length <= 0 || length > input.length - 9) {
        throw new RangeError('invalid WT QR signature length');
    }

    const entries = uniqueEntries(input.subarray(9 + length));
    return {
        ...fields,
        status: 'success',
        qrSig: Uint8Array.from(input.subarray(9, 9 + length)),
        image: required(entries, 0x17),
        d1: required(entries, 0xd1),
    };
}

/** Parse exactly the command 0x12 business body; see the 0x31 boundary contract. */
export function decodeWtQrPollResponse(input: Uint8Array): WtQrPollResponse {
    const { data, fields } = header(input);

    if (fields.retCode !== 0) {
        const status =
            fields.retCode === 17
                ? 'expired'
                : fields.retCode === 48
                  ? 'wait'
                  : fields.retCode === 53
                    ? 'confirm'
                    : fields.retCode === 54
                      ? 'canceled'
                      : fields.retCode === 144
                        ? 'invalid'
                        : 'unknown';
        return { ...fields, status, remaining: Uint8Array.from(input.subarray(7)) };
    }

    if (input.length < 19) {
        throw new RangeError('truncated WT QR confirmed response');
    }

    const uin = data.getBigInt64(7);

    if (uin <= 0n) {
        throw new RangeError('invalid WT QR confirmed UIN');
    }

    const retry = data.getInt32(15);
    const entries = uniqueEntries(input.subarray(19));
    const tgtgtKey = required(entries, 0x1e);

    // The reference subsequently passes this key to QQ-TEA (four 32-bit words).
    if (tgtgtKey.length !== 16) {
        throw new RangeError('invalid WT QR tgtgt key length');
    }

    return {
        ...fields,
        status: 'confirmed',
        uin,
        retry,
        tickets: {
            tgtgtKey,
            noPicSig: required(entries, 0x19),
            tempPassword: required(entries, 0x18),
        },
    };
}
