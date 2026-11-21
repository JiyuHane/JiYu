import { isProxy, isUint8Array } from 'node:util/types';
import { qqTeaEncrypt } from './qq-tea';
import { encodeTargetWtInnerWriterCandidate } from './target-wt-inner-writer-candidate';
import { encodeTargetWtLoginNode0106, encodeTargetWtLoginNode0144 } from './target-wt-login-node';
import { deriveTargetWtTgtgtKeyCandidate } from './target-wt-tgtgt-key-candidate';
import {
    encodeTargetWtTgtgtPlainCandidate,
    type TargetWtTgtgtPlainInput,
} from './target-wt-tgtgt-plain-candidate';

const Bytes = Uint8Array;
const typed = Object.getPrototypeOf(Bytes.prototype) as object;
const getBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const getLength = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const getBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const getResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const getDescriptor = Object.getOwnPropertyDescriptor;
const getPrototype = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const values = Bytes.prototype.values;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;

const fieldNames = [
    'arg3',
    'field04',
    'field08',
    'field0c',
    'field50',
    'arg4',
    'field14',
    'field18',
    'raw5',
    'field19',
    'raw20',
    'field10',
    'field00',
    'tail38',
] as const;

function checkPrototypeChain(value: object): void {
    let current: object | null = value;

    for (let depth = 0; current !== null; depth++) {
        if (depth >= 256 || isProxy(current)) {
            throw new TypeError();
        }

        current = getPrototype(current) as object | null;
    }
}

function ownData(value: object, name: string): unknown {
    const descriptor = getDescriptor(value, name);

    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError();
    }

    return descriptor.value as unknown;
}

function clear(value: Uint8Array | undefined): void {
    if (value !== undefined) {
        try {
            fill.call(value, 0);
        } catch {
            // Independently attempt cleanup for each owned allocation.
        }
    }
}

function snapshotLocal16(input: Uint8Array): Uint8Array {
    if (isProxy(input) || !isUint8Array(input) || typeof getResizable !== 'function') {
        throw new TypeError();
    }

    checkPrototypeChain(input);
    values.call(input);
    const backing = getBuffer.call(input) as ArrayBuffer;
    const backingSize = getBufferLength.call(backing) as number;
    const size = getLength.call(input) as number;
    const start = getOffset.call(input) as number;

    if (size !== 16 || start + size > backingSize || getResizable.call(backing) !== false) {
        throw new TypeError();
    }

    const copy = new Bytes(16);

    try {
        set.call(copy, new Bytes(backing, start, 16));
        return copy;
    } catch (error) {
        clear(copy);
        throw error;
    }
}

/**
 * Offline conditional composition of the initial target WT two-node path.
 * Using the same local16 for raw7 and the inner key models only the initial
 * branch at 0x34fe6a0, assuming the original buffer is unchanged from the raw7
 * read through the session copy and that the session copy remains unchanged and
 * valid until the later inner-key read. The source, word, four opaque writer
 * outputs and callbacks are caller chosen.
 * MD5 and QQ-TEA are candidates; neither target equivalence nor a real login,
 * signature or server acceptance is established. No process or network is used.
 *
 * Inputs must remain stable until snapshotted, intrinsics must be trustworthy,
 * and both random callbacks must synchronously return the requested bytes.
 * A callback returning a rejected Promise is responsible for handling it.
 * Caller buffers, callback results and successful nodes are not cleared. Owned
 * intermediates and failed nodes receive independent best-effort cleanup; engine,
 * crypto and QQ-TEA internal copies may persist. The source candidates' 16 MiB
 * limits do not guarantee performance or peak memory. This composition further
 * limits both ciphertext lengths to 65535 bytes before either callback runs.
 */
export function encodeTargetWtInitialTwoNodesCandidate(
    plainFields: Omit<TargetWtTgtgtPlainInput, 'raw7'>,
    keySource: Uint8Array,
    keyWord: bigint,
    local16: Uint8Array,
    parts: readonly [Uint8Array, Uint8Array, Uint8Array, Uint8Array],
    tgtgtRandom: (size: number) => Uint8Array,
    innerRandom: (size: number) => Uint8Array,
): { node0106: Uint8Array; node0144: Uint8Array } {
    let local16copy: Uint8Array | undefined;
    let plain: Uint8Array | undefined;
    let innerPlain: Uint8Array | undefined;
    let derivedKey: Uint8Array | undefined;
    let tgtgtCipher: Uint8Array | undefined;
    let innerCipher: Uint8Array | undefined;
    let node0106: Uint8Array | undefined;
    let node0144: Uint8Array | undefined;
    let complete = false;

    try {
        if (
            plainFields === null ||
            typeof plainFields !== 'object' ||
            isProxy(plainFields) ||
            isProxy(parts) ||
            !Array.isArray(parts) ||
            typeof tgtgtRandom !== 'function' ||
            typeof innerRandom !== 'function'
        ) {
            throw new TypeError();
        }

        checkPrototypeChain(plainFields);
        checkPrototypeChain(parts);
        const keys = ownKeys(plainFields);

        if (
            keys.length !== fieldNames.length ||
            keys.some((key) => !fieldNames.includes(key as (typeof fieldNames)[number]))
        ) {
            throw new TypeError();
        }

        const fields = fieldNames.map((name) => ownData(plainFields, name));

        if (ownData(parts, 'length') !== 4) {
            throw new TypeError();
        }

        const fragments = [0, 1, 2, 3].map((index) => ownData(parts, String(index)) as Uint8Array);
        local16copy = snapshotLocal16(local16);
        const safePlain: TargetWtTgtgtPlainInput = {
            arg3: fields[0] as number,
            field04: fields[1] as number,
            field08: fields[2] as number,
            field0c: fields[3] as number,
            field50: fields[4] as bigint,
            arg4: fields[5] as number,
            field14: fields[6] as number,
            field18: fields[7] as number,
            raw5: fields[8] as Uint8Array,
            raw7: local16copy,
            field19: fields[9] as number,
            raw20: fields[10] as Uint8Array,
            field10: fields[11] as number,
            field00: fields[12] as number,
            tail38: fields[13] as Uint8Array,
        };
        plain = encodeTargetWtTgtgtPlainCandidate(safePlain);
        derivedKey = deriveTargetWtTgtgtKeyCandidate(keySource, keyWord);
        innerPlain = encodeTargetWtInnerWriterCandidate(
            fragments[0],
            fragments[1],
            fragments[2],
            fragments[3],
        );

        if (
            8 * Math.ceil((plain.length + 10) / 8) > 0xffff ||
            8 * Math.ceil((innerPlain.length + 10) / 8) > 0xffff
        ) {
            throw new RangeError();
        }

        tgtgtCipher = qqTeaEncrypt(plain, derivedKey, tgtgtRandom);
        innerCipher = qqTeaEncrypt(innerPlain, local16copy, innerRandom);
        node0106 = encodeTargetWtLoginNode0106(tgtgtCipher);
        node0144 = encodeTargetWtLoginNode0144(innerCipher);
        const result = { node0106, node0144 };
        complete = true;
        return result;
    } catch {
        throw new Error('target WT initial two nodes candidate failed');
    } finally {
        clear(plain);
        clear(innerPlain);
        clear(local16copy);
        clear(derivedKey);
        clear(tgtgtCipher);
        clear(innerCipher);

        if (!complete) {
            clear(node0106);
            clear(node0144);
        }
    }
}
