import { types } from 'node:util';
import type {
    SsoUnregisterReferenceRequest,
    SsoUnregisterReferenceResponse,
} from '@snowluma/proto-defs/sso-register';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';

// Static reference only: no transport or live registration owner is connected here.
// LagrangeV2 7011cdf87368cc0fb77273c1508e779a52328165,
// Lagrange.Core/Internal/Services/System/SsoUnregisterService.cs and Packets/System.
export const SSO_UNREGISTER_REFERENCE_COMMAND =
    'trpc.qq_new_tech.status_svc.StatusService.UnRegister';

export type SsoUnregisterObservation =
    { presence: 'absent' } | { presence: 'present'; text: string };

/** Construct an independently backed body; temporary codec bytes are cleared. */
export function encodeSsoUnregisterReference(): Uint8Array {
    const temporary = protobuf_encode<SsoUnregisterReferenceRequest>({
        regType: 1,
        device: { name: '', type: '', osVersion: '', brand: '', vendorOs: '' },
        userTrigger: 1,
    });

    try {
        const result = new Uint8Array(temporary.length);
        result.set(temporary);
        return result;
    } finally {
        temporary.fill(0);
    }
}

/**
 * Observe only the top-level message, without inferring success. Missing differs
 * from the reference object's default empty Msg. Unknown and wrong-wire fields
 * follow Proton; invalid UTF-8 is replaced. No conclusion about unknown effects
 * is implied. Accept only non-shared, fixed-size, non-detached Uint8Array input;
 * maxBytes is an explicit integer in 0..65536. Temporary copies are cleared,
 * but JavaScript cannot guarantee erasure of all copies or string storage.
 */
export function decodeSsoUnregisterReference(
    input: Uint8Array,
    maxBytes: number,
): SsoUnregisterObservation {
    try {
        if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 65536) {
            throw new Error();
        }

        if (types.isProxy(input) || !types.isUint8Array(input)) {
            throw new Error();
        }

        // Intrinsic getters avoid caller-defined accessors on the view itself.
        const prototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
        const buffer = Object.getOwnPropertyDescriptor(prototype, 'buffer')!.get!.call(
            input,
        ) as ArrayBuffer;
        const offset = Object.getOwnPropertyDescriptor(prototype, 'byteOffset')!.get!.call(
            input,
        ) as number;
        const length = Object.getOwnPropertyDescriptor(prototype, 'byteLength')!.get!.call(
            input,
        ) as number;
        const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;

        if (
            !types.isArrayBuffer(buffer) ||
            types.isSharedArrayBuffer(buffer) ||
            (resizable && resizable.call(buffer)) ||
            length > maxBytes
        ) {
            throw new Error();
        }

        // Construction also rejects detached ArrayBuffers, including detached empty views.
        const view = new Uint8Array(buffer, offset, length);
        const copy = new Uint8Array(length);
        copy.set(view);

        try {
            const result = protobuf_decode<SsoUnregisterReferenceResponse>(copy);
            return result.message == null
                ? { presence: 'absent' }
                : { presence: 'present', text: result.message };
        } finally {
            copy.fill(0);
        }
    } catch {
        throw new Error('invalid unregister response');
    }
}
