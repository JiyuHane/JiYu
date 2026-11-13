import { isProxy } from 'node:util/types';
import { encodeTargetWtLocalDataCandidate, type TargetWtLocalData } from './target-wt-local-data';
import { encodeTargetWtOicq } from './target-wt-oicq';

export interface TargetWtLoginFrameCandidate {
    version: number;
    sequence: number;
    uin: number;
    clientType: number;
    pubno: number;
    /** All context, keys, randomness and opaque login body are caller supplied. */
    localData: TargetWtLocalData;
}

const getPrototype = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const ownKeys = Reflect.ownKeys;
const hasOwn = Object.hasOwn;
const fill = Uint8Array.prototype.fill;

function record(value: unknown): object {
    if (typeof value !== 'object' || value === null) {
        throw new TypeError();
    }

    let current: object | null = value;

    for (let depth = 0; current !== null; depth++) {
        if (depth >= 256 || isProxy(current)) {
            throw new TypeError();
        }

        current = getPrototype(current) as object | null;
    }

    for (const name of ownKeys(value)) {
        const descriptor = getDescriptor(value, name);

        if (!descriptor || !hasOwn(descriptor, 'value')) {
            throw new TypeError();
        }
    }

    return value;
}

function data(value: object, name: string): unknown {
    const descriptor = getDescriptor(value, name);

    if (!descriptor || !hasOwn(descriptor, 'value')) {
        throw new TypeError();
    }

    return descriptor.value;
}

function uint(value: unknown, maximum: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maximum) {
        throw new TypeError();
    }

    return value;
}

/**
 * Offline explicit-parameter 0x810 composition candidate. Reuses the actual
 * local-data and target OICQ encoders; it does not construct login TLVs, select
 * keys, advance sequence state, sign, register or establish interoperability.
 * `localData.plaintext` is caller-encoded opaque body, not a password contract.
 * All record properties must be own data properties (even ignored accessors
 * are rejected here). Byte validation and private snapshots belong to the
 * local-data encoder; keep caller views stable until that snapshot completes.
 * Its local length limits and branch semantics are unchanged. Returned bytes
 * are caller owned and can include local16. The complete intermediate output
 * is independently wiped best effort on success and failure; inaccessible
 * TEA internals and JS/runtime copies are not covered by that cleanup.
 */
export function encodeTargetWtLoginFrameCandidate(input: TargetWtLoginFrameCandidate): Uint8Array {
    let intermediate: Uint8Array | undefined;

    try {
        const source = record(input);
        const version = uint(data(source, 'version'), 0xffff);
        const sequence = uint(data(source, 'sequence'), 0xffff);
        const uin = uint(data(source, 'uin'), 0xffffffff);
        const clientType = uint(data(source, 'clientType'), 0xffff);
        const pubno = uint(data(source, 'pubno'), 0xffffffff);
        const local = record(data(source, 'localData'));
        // Descriptor validation precedes the existing encoder's field reads;
        // neither record enumeration nor forwarding invokes caller accessors.
        intermediate = encodeTargetWtLocalDataCandidate(local as TargetWtLocalData);
        return encodeTargetWtOicq({
            version,
            command: 0x810,
            sequence,
            uin,
            clientType,
            pubno,
            opaque: intermediate,
        });
    } catch {
        throw new Error('target WT login frame candidate construction failed');
    } finally {
        if (intermediate) {
            try {
                fill.call(intermediate, 0);
            } catch {
                // Best effort for this owned allocation, never caller buffers.
            }
        }
    }
}
