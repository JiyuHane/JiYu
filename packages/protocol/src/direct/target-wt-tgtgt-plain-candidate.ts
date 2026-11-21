import { isProxy } from 'node:util/types';

export interface TargetWtTgtgtPlainInput {
    arg3: number;
    field04: number;
    field08: number;
    field0c: number;
    field50: bigint;
    arg4: number;
    field14: number;
    field18: number;
    raw5: Uint8Array;
    raw7: Uint8Array;
    field19: number;
    raw20: Uint8Array;
    field10: number;
    field00: number;
    tail38: Uint8Array;
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
const maxOutput = 16 * 1024 * 1024;

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

function unsigned(value: unknown, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
        throw new TypeError();
    }

    return value;
}

/**
 * Offline model of the normal stream-success write sequence at 0x3504d80.
 * The raw fields are opaque; neither their meanings nor live QQ success is inferred.
 * The 65535-byte tail and 16 MiB total limits and the uniform failure are local
 * validation policies, not a model of the target's length or failure behavior.
 * Inputs must stay stable while copied and intrinsics must be trusted. Caller
 * buffers are never cleared; snapshots and incomplete output are wiped best
 * effort, subject to runtime copies and garbage collection.
 */
export function encodeTargetWtTgtgtPlainCandidate(input: TargetWtTgtgtPlainInput): Uint8Array {
    const snapshots: Array<Uint8Array | undefined> = [undefined, undefined, undefined, undefined];
    let output: Uint8Array | undefined;
    let complete = false;

    try {
        if (input === null || typeof input !== 'object' || isProxy(input)) {
            throw new TypeError();
        }

        checkPrototypeChain(input);
        const names = [
            'arg3',
            'field04',
            'field08',
            'field0c',
            'field50',
            'arg4',
            'field14',
            'field18',
            'raw5',
            'raw7',
            'field19',
            'raw20',
            'field10',
            'field00',
            'tail38',
        ] as const;
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
        const arg3 = unsigned(fields[0], 0xffffffff);
        const field04 = unsigned(fields[1], 0xffffffff);
        const field08 = unsigned(fields[2], 0xffffffff);
        const field0c = unsigned(fields[3], 0xffffffff);
        const field50 = fields[4];

        if (typeof field50 !== 'bigint' || field50 < 0n || field50 > 0xffffffffffffffffn) {
            throw new TypeError();
        }

        const arg4 = unsigned(fields[5], 0xffffffff);
        const field14 = unsigned(fields[6], 0xffffffff);
        const field18 = unsigned(fields[7], 0xff);
        const field19 = unsigned(fields[10], 0xff);
        const field10 = unsigned(fields[12], 0xffffffff);
        const field00 = unsigned(fields[13], 0xffffffff);
        const parts = [fields[8], fields[9], fields[11], fields[14]];
        const sources: Array<{ backing: ArrayBuffer; start: number; size: number }> = [];
        let outputLength = 48;

        for (let index = 0; index < parts.length; index++) {
            const part = parts[index];

            if (isProxy(part) || !isView(part) || tag.call(part) !== 'Uint8Array') {
                throw new TypeError();
            }

            checkPrototypeChain(part);
            const backing = buffer.call(part) as ArrayBuffer;
            bufferLength.call(backing); // Reject shared backing, including foreign realms.
            values.call(part); // Reject detached and out-of-bounds views.
            const size = length.call(part) as number;
            const start = offset.call(part) as number;

            if (index === 3 && size > 0xffff) {
                throw new RangeError();
            }

            outputLength += size + (index === 3 && size !== 0 ? 2 : 0);

            if (outputLength > maxOutput) {
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

        output = new Bytes(outputLength);
        const view = new View(output.buffer);
        let cursor = 0;
        view.setUint16(cursor, 4, false);
        cursor += 2;

        for (const word of [arg3, field04, field08, field0c]) {
            view.setUint32(cursor, word, false);
            cursor += 4;
        }

        view.setBigUint64(cursor, field50, false);
        cursor += 8;

        for (const word of [arg4, field14]) {
            view.setUint32(cursor, word, false);
            cursor += 4;
        }

        view.setUint8(cursor++, field18);

        for (let index = 0; index < 2; index++) {
            set.call(output, snapshots[index]!, cursor);
            cursor += sources[index].size;
        }

        view.setUint32(cursor, 0, false);
        cursor += 4;
        view.setUint8(cursor++, field19);
        set.call(output, snapshots[2]!, cursor);
        cursor += sources[2].size;
        view.setUint32(cursor, field10, false);
        cursor += 4;
        view.setUint32(cursor, field00, false);
        cursor += 4;

        if (sources[3].size !== 0) {
            view.setUint16(cursor, sources[3].size, false);
            cursor += 2;
            set.call(output, snapshots[3]!, cursor);
        }

        complete = true;
        return output;
    } catch {
        throw new Error('target WT tgtgt plaintext candidate failed');
    } finally {
        for (const snapshot of snapshots) {
            clear(snapshot);
        }

        if (!complete) {
            clear(output);
        }
    }
}
