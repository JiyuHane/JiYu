import { isProxy } from 'node:util/types';

export interface TargetWtNode0147Input {
    word: number;
    first: Uint8Array;
    second: Uint8Array;
}

const Bytes = Uint8Array;
const View = DataView;
const typed = Object.getPrototypeOf(Bytes.prototype) as object;
const tag = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag)!.get!;
const buffer = Object.getOwnPropertyDescriptor(typed, 'buffer')!.get!;
const length = Object.getOwnPropertyDescriptor(typed, 'byteLength')!.get!;
const offset = Object.getOwnPropertyDescriptor(typed, 'byteOffset')!.get!;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const values = Bytes.prototype.values;
const set = Bytes.prototype.set;
const fill = Bytes.prototype.fill;
const getPrototype = Object.getPrototypeOf;
const getDescriptor = Object.getOwnPropertyDescriptor;
const ownKeys = Reflect.ownKeys;
const isView = ArrayBuffer.isView;

function checkPrototypeChain(value: object): void {
    let current: object | null = value;

    for (let depth = 0; current !== null; depth++) {
        if (depth >= 256 || isProxy(current)) {
            throw new TypeError();
        }

        current = getPrototype(current) as object | null;
    }
}

function clear(bytes: Uint8Array | undefined): void {
    if (bytes) {
        try {
            fill.call(bytes, 0);
        } catch {
            // Each owned allocation gets an independent best-effort attempt.
        }
    }
}

/**
 * Offline normal-success stream model of the 0x0147 writer at 0x3506630.
 * The target ignores helper results; validation and snapshots are local policy.
 * Both fields are opaque bytes, clamped to 32 bytes; no identity or text encoding
 * is inferred. Callers must keep inputs stable during copying and trust intrinsics.
 * Caller-owned inputs are not wiped; snapshots and incomplete output are wiped
 * best effort, subject to runtime copies and garbage collection. No login occurs.
 */
export function encodeTargetWtLoginNode0147(input: TargetWtNode0147Input): Uint8Array {
    const snapshots: Array<Uint8Array | undefined> = [undefined, undefined];
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        if (input === null || typeof input !== 'object' || isProxy(input)) {
            throw new TypeError();
        }

        checkPrototypeChain(input);
        const names = ['word', 'first', 'second'] as const;
        const keys = ownKeys(input);

        if (
            keys.length !== names.length ||
            keys.some((key) => !names.includes(key as (typeof names)[number]))
        ) {
            throw new TypeError();
        }

        const fields = names.map((name) => {
            const descriptor = getDescriptor(input, name);

            if (!descriptor || !('value' in descriptor)) {
                throw new TypeError();
            }

            return descriptor.value as unknown;
        });
        const word = fields[0];

        if (typeof word !== 'number' || !Number.isInteger(word) || word < 0 || word > 0xffffffff) {
            throw new TypeError();
        }

        const sources: Array<{ backing: ArrayBuffer; start: number; size: number }> = [];
        let valueLength = 8;

        for (const part of [fields[1], fields[2]]) {
            if (isProxy(part) || !isView(part) || tag.call(part) !== 'Uint8Array') {
                throw new TypeError();
            }

            checkPrototypeChain(part);
            const backing = buffer.call(part) as ArrayBuffer;
            bufferLength.call(backing); // Reject shared backing, including foreign realms.
            values.call(part); // Reject detached and out-of-bounds views.
            const size = Math.min(length.call(part) as number, 32);
            const start = offset.call(part) as number;
            valueLength += size;
            sources.push({ backing, start, size });
        }

        for (let index = 0; index < sources.length; index++) {
            const source = sources[index];
            const snapshot = new Bytes(source.size);
            snapshots[index] = snapshot;
            set.call(snapshot, new Bytes(source.backing, source.start, source.size));
        }

        output = new Bytes(valueLength + 4);
        const view = new View(output.buffer);
        view.setUint16(0, 0x0147, false);
        view.setUint16(2, valueLength, false);
        view.setUint32(4, word, false);
        let cursor = 8;

        for (const snapshot of snapshots) {
            view.setUint16(cursor, snapshot!.byteLength, false);
            cursor += 2;
            set.call(output, snapshot!, cursor);
            cursor += snapshot!.byteLength;
        }

        complete = true;
        return output;
    } catch {
        throw new Error('target WT login node encoding failed');
    } finally {
        for (const snapshot of snapshots) {
            clear(snapshot);
        }

        if (!complete) {
            clear(output);
        }
    }
}
