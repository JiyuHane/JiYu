import { isProxy, isSharedArrayBuffer, isUint8Array } from 'node:util/types';
import type { DirectThirdPartyLoginResponse } from '@snowluma/proto-defs/direct-login';
import { protobuf_decode } from '@snowluma/proton';
import type { WtTlvEntry } from './wt-tlv';

// Independent projection of public field declarations; upstream authors retain their rights.
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Packets/System/ThirdPartyLoginResponse.cs
// https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Logic/WtExchangeLogic.cs
const MAX_ENTRIES = 1024;
const MAX_BLOCK_BYTES = 0xffff;
const UID_TAG = 0x543;
const INVALID = 'invalid WT login keystore projection';
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;

function ownData(object: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);

    if (!descriptor || !('value' in descriptor)) {
        throw new Error(INVALID);
    }

    return descriptor.value;
}

export type WtLoginUidProjection = { status: 'absent' } | { status: 'present'; uid: string };

// Validate framing and all UID occurrences before Proton's replacement-mode UTF-8
// decoder runs. Unknown ordinary wire fields are skipped without interpreting data.
function validateMessage(data: Uint8Array, level: number): void {
    let offset = 0;

    const readVarint = (max: number): bigint => {
        let value = 0n;

        for (let index = 0; index < max; index++) {
            if (offset >= data.length) {
                throw new Error(INVALID);
            }

            const byte = data[offset++];
            value |= BigInt(byte & 0x7f) << BigInt(index * 7);

            if ((byte & 0x80) === 0) {
                if (max === 10 && index === 9 && byte > 1) {
                    throw new Error(INVALID);
                }

                return value;
            }
        }

        throw new Error(INVALID);
    };

    while (offset < data.length) {
        const key = readVarint(5);

        if (key === 0n || key > 0xffffffffn || key >> 3n === 0n) {
            throw new Error(INVALID);
        }

        const field = Number(key >> 3n);
        const wire = Number(key & 7n);
        const selected = field === (level === 0 ? 9 : level === 1 ? 11 : 1);

        if (selected && wire !== 2) {
            throw new Error(INVALID);
        }

        if (wire === 0) {
            readVarint(10);
        } else if (wire === 1 || wire === 5) {
            offset += wire === 1 ? 8 : 4;

            if (offset > data.length) {
                throw new Error(INVALID);
            }
        } else if (wire === 2) {
            const length = readVarint(5);

            if (length > BigInt(data.length - offset)) {
                throw new Error(INVALID);
            }

            const end = offset + Number(length);

            if (selected) {
                const fieldData = data.subarray(offset, end);

                if (level < 2) {
                    validateMessage(fieldData, level + 1);
                } else {
                    new TextDecoder('utf-8', { fatal: true }).decode(fieldData);
                }
            }

            offset = end;
        } else {
            throw new Error(INVALID);
        }
    }
}

/**
 * Project only the UID carried by inner WT TLV 0x543. An absent TLV is
 * distinct from a present TLV with missing nested messages or an empty UID,
 * which yields the upstream default empty string. This is not login success.
 *
 * Locally the array is limited to 1024 entries and its encoded count, headers,
 * and values together to 65535 bytes. Tags and lengths are uint16; duplicate
 * 0x543 is rejected rather than applying V2's dictionary last-value behavior.
 * Proton's TextDecoder-compatible behavior strips an initial UTF-8 BOM whereas
 * .NET preserves it. Malformed UTF-8, unsupported/unknown wire types (including
 * groups), and truncated or overflowing framing fail closed locally; this is
 * not a promise of byte-for-byte equivalence with upstream. Unknown ordinary
 * protobuf fields remain accepted. The selected value is copied and its owned
 * byte snapshot wiped in finally; JavaScript UID strings cannot be wiped.
 * Input arrays must be dense own data properties, and entries must have own
 * data properties tag/value. Proxies, shared and resizable backing buffers,
 * detached buffers and out-of-bounds views are rejected; no user iterator or
 * property getter is invoked. Normal Uint8Array/Buffer subviews are accepted.
 */
export function projectWtLoginUid(entries: readonly WtTlvEntry[]): WtLoginUidProjection {
    let snapshot: Uint8Array | undefined;

    try {
        if (isProxy(entries) || !Array.isArray(entries)) {
            throw new Error(INVALID);
        }

        const count = ownData(entries, 'length');

        if (typeof count !== 'number' || count > MAX_ENTRIES) {
            throw new Error(INVALID);
        }

        let total = 2;

        for (let index = 0; index < count; index++) {
            const entry = ownData(entries, String(index));

            if (!entry || typeof entry !== 'object' || isProxy(entry)) {
                throw new Error(INVALID);
            }

            const tag = ownData(entry, 'tag');
            const value = ownData(entry, 'value');

            if (
                typeof tag !== 'number' ||
                !Number.isInteger(tag) ||
                tag < 0 ||
                tag > 0xffff ||
                isProxy(value) ||
                !isUint8Array(value)
            ) {
                throw new Error(INVALID);
            }

            const length: number = Reflect.apply(byteLengthGetter, value, []);
            const offset: number = Reflect.apply(byteOffsetGetter, value, []);
            const buffer: ArrayBufferLike = Reflect.apply(bufferGetter, value, []);

            if (
                isSharedArrayBuffer(buffer) ||
                (resizableGetter && Reflect.apply(resizableGetter, buffer, [])) ||
                length > 0xffff
            ) {
                throw new Error(INVALID);
            }

            total += 4 + length;

            if (total > MAX_BLOCK_BYTES) {
                throw new Error(INVALID);
            }

            // Construction validates that the fixed backing buffer is still attached.
            const view = new Uint8Array(buffer, offset, length);

            if (tag === UID_TAG) {
                if (snapshot !== undefined) {
                    throw new Error(INVALID);
                }

                snapshot = new Uint8Array(length);
                Uint8Array.prototype.set.call(snapshot, view);
            }
        }

        if (snapshot === undefined) {
            return { status: 'absent' };
        }

        validateMessage(snapshot, 0);
        const decoded = protobuf_decode<DirectThirdPartyLoginResponse>(snapshot);
        return { status: 'present', uid: decoded.commonInfo?.rspNT?.uid ?? '' };
    } catch {
        throw new Error(INVALID);
    } finally {
        snapshot?.fill(0);
    }
}
