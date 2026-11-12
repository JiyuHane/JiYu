import { qqTeaDecrypt } from './qq-tea';
import { decodeWtTlv, type WtTlvEntry } from './wt-tlv';

// Static references and local synthetic vectors only; no live QQ validation.
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Services/Login/LoginService.cs#L62-L90
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Utility/ProtocolHelper.cs#L6-L20
// https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Logic/WtExchangeLogic.cs#L538-L595

const MAX_BODY_BYTES = 0xffff;

export type WtLoginResponse =
    | {
          status: 'tickets';
          command: number;
          state: 0;
          tickets: { d2: Uint8Array; d2Key: Uint8Array; a2: Uint8Array; a1: Uint8Array };
          outerTlvs: WtTlvEntry[];
          innerTlvs: WtTlvEntry[];
      }
    | {
          status: 'error';
          command: number;
          state: number;
          error: { code: number; title: string; message: string };
          outerTlvs: WtTlvEntry[];
      }
    | {
          status: 'verification-required' | 'nonzero' | 'incomplete';
          command: number;
          state: number;
          outerTlvs: WtTlvEntry[];
      };

function wipe(buffers: Iterable<Uint8Array>): void {
    for (const buffer of buffers) {
        try {
            buffer.fill(0);
        } catch {
            // Best effort per owned buffer; keep the original parse error.
        }
    }
}

function entries(input: Uint8Array): WtTlvEntry[] {
    const result = decodeWtTlv(input);
    const seen = new Set<number>();

    try {
        for (const entry of result) {
            if (seen.has(entry.tag)) {
                throw new Error('duplicate WT login TLV tag');
            }

            seen.add(entry.tag);
        }

        return result;
    } catch (error) {
        wipe(result.map((entry) => entry.value));
        throw error;
    }
}

function required(tlvs: WtTlvEntry[], tag: number, owned: Uint8Array[]): Uint8Array {
    const value = tlvs.find((entry) => entry.tag === tag)?.value;

    if (!value || value.length === 0) {
        throw new Error(`missing or empty WT login TLV 0x${tag.toString(16)}`);
    }

    const copy = Uint8Array.from(value);
    owned.push(copy);
    return copy;
}

function error146(input: Uint8Array): { code: number; title: string; message: string } {
    if (input.length < 8) {
        throw new Error('truncated WT login error TLV');
    }

    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const code = view.getUint32(0);
    let offset = 4;

    const readString = (): string => {
        if (input.length - offset < 2) {
            throw new Error('truncated WT login error string length');
        }

        // BinaryPacket's Int16 string length is signed.
        const length = view.getInt16(offset);
        offset += 2;

        if (length < 0 || length > input.length - offset) {
            throw new Error('invalid WT login error string length');
        }

        const value = new TextDecoder().decode(input.subarray(offset, offset + length));
        offset += length;
        return value;
    };

    const title = readString();
    const message = readString();

    if (offset !== input.length) {
        throw new Error('trailing WT login error bytes');
    }

    return { code, title, message };
}

/**
 * Parse exactly the decrypted 0x810/9 business body, not its OICQ envelope.
 * Caller must bind the outer OICQ command, UIN and sequence to the pending
 * account/request before using this result. QQ-TEA has no authentication.
 * All returned TLVs and tickets are sensitive: never log or serialize them.
 * Successful returns transfer ownership of TLV/ticket copies to the caller.
 * Failure clears owned copies; decrypted plaintext is always cleared, best effort.
 * This does not securely erase strings, JavaScript or crypto-internal copies.
 * Even 'tickets' means parsed local fields, not authenticated or online login.
 */
export function decodeWtLoginResponse(input: Uint8Array, tgtgtKey: Uint8Array): WtLoginResponse {
    if (!(input instanceof Uint8Array) || input.length < 5 || input.length > MAX_BODY_BYTES) {
        throw new RangeError('invalid WT login response body size');
    }

    if (!(tgtgtKey instanceof Uint8Array) || tgtgtKey.length !== 16) {
        throw new RangeError('invalid WT login tgtgt key length');
    }

    const data = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const command = data.getUint16(0);

    if (command !== 9) {
        throw new Error('unexpected WT login internal command');
    }

    const state = data.getUint8(2);
    const outerTlvs = entries(input.subarray(3));
    let innerTlvs: WtTlvEntry[] = [];
    const ownedTickets: Uint8Array[] = [];
    let plaintext: Uint8Array | undefined;

    try {
        const err = outerTlvs.find((entry) => entry.tag === 0x146);

        if (err) {
            return { status: 'error', command, state, error: error146(err.value), outerTlvs };
        }

        if (state !== 0) {
            const status = [2, 160, 204, 239].includes(state) ? 'verification-required' : 'nonzero';
            return { status, command, state, outerTlvs };
        }

        const encrypted = outerTlvs.find((entry) => entry.tag === 0x119)?.value;

        if (!encrypted) {
            return { status: 'incomplete', command, state, outerTlvs };
        }

        // ProtocolHelper.TlvUnPack reads the count first: there is no inner command.
        plaintext = qqTeaDecrypt(encrypted, tgtgtKey);
        innerTlvs = entries(plaintext);
        const d2 = required(innerTlvs, 0x143, ownedTickets);
        const d2Key = required(innerTlvs, 0x305, ownedTickets);

        if (d2Key.length !== 16) {
            throw new RangeError('invalid WT login D2 key length');
        }

        const a2 = required(innerTlvs, 0x10a, ownedTickets);
        const a1 = required(innerTlvs, 0x106, ownedTickets);
        return {
            status: 'tickets',
            command,
            state: 0,
            tickets: { d2, d2Key, a2, a1 },
            outerTlvs,
            innerTlvs,
        };
    } catch (error) {
        wipe(outerTlvs.map((entry) => entry.value));
        wipe(innerTlvs.map((entry) => entry.value));
        wipe(ownedTickets);
        throw error;
    } finally {
        if (plaintext) {
            wipe([plaintext]);
        }
    }
}
