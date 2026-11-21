import { isProxy } from 'node:util/types';

export interface TargetWtNode0124Input {
    first: Uint8Array;
    second: Uint8Array;
    word: number;
    third: Uint8Array;
    fourth: Uint8Array;
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
 * Offline normal-success model of the 0x0124 writer at 0x3505fe0. The four
 * inputs are opaque bytes; no text encoding or field semantics are inferred.
 * Inputs must remain stable while being copied and intrinsics must be trusted.
 * Lengths are checked rather than truncated. Caller-owned inputs are never
 * cleared; snapshots and incomplete output are wiped best effort, subject to
 * runtime copies and garbage collection. No network or login is performed.
 */
export function encodeTargetWtLoginNode0124(input: TargetWtNode0124Input): Uint8Array {
    const snapshots: Array<Uint8Array | undefined> = [undefined, undefined, undefined, undefined];
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        if (input === null || typeof input !== 'object' || isProxy(input)) {
            throw new TypeError();
        }

        checkPrototypeChain(input);
        const names = ['first', 'second', 'word', 'third', 'fourth'] as const;
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
        const word = fields[2];

        if (typeof word !== 'number' || !Number.isInteger(word) || word < 0 || word > 0xffff) {
            throw new TypeError();
        }

        const parts = [fields[0], fields[1], fields[3], fields[4]];
        const sources: Array<{ backing: ArrayBuffer; start: number; size: number }> = [];
        let valueLength = 12;

        for (const part of parts) {
            if (isProxy(part) || !isView(part) || tag.call(part) !== 'Uint8Array') {
                throw new TypeError();
            }

            checkPrototypeChain(part);
            const backing = buffer.call(part) as ArrayBuffer;
            bufferLength.call(backing); // Reject shared backing, including foreign realms.
            values.call(part); // Reject detached and out-of-bounds views.
            const size = length.call(part) as number;
            const start = offset.call(part) as number;

            if (size > 0xffff) {
                throw new RangeError();
            }

            valueLength += size;

            if (valueLength > 0xffff) {
                throw new RangeError();
            }

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
        view.setUint16(0, 0x0124, false);
        view.setUint16(2, valueLength, false);
        let cursor = 4;

        for (let index = 0; index < snapshots.length; index++) {
            if (index === 2) {
                view.setUint16(cursor, word, false);
                cursor += 2;
            }

            const snapshot = snapshots[index]!;
            view.setUint16(cursor, snapshot.byteLength, false);
            cursor += 2;
            set.call(output, snapshot, cursor);
            cursor += snapshot.byteLength;
        }

        view.setUint16(cursor, 0, false);
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
