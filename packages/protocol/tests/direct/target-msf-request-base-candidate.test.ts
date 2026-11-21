import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    encodeTargetMsfRequestBaseCandidate as encode,
    MAX_TARGET_MSF_REQUEST_BASE_BYTES as MAX,
    type TargetMsfRequestBaseCandidateInput,
} from '../../src/direct/target-msf-request-base-candidate';
import { encodeTargetServiceRequest } from '../../src/direct/target-service-request';

// Synthetic values only: these tests establish the local normal-path model,
// not native reachability, a complete QQ protocol, or a cryptographic result.
const ERROR = 'target MSF request-base construction failed';
const PRIVATE = 'synthetic-private-marker';
const BYTE_FIELDS = ['field10', 'field68', 'field28'] as const;
const MODES = [12, 13, 20, 21] as const;
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
let guards: Array<{ mock: { calls: readonly unknown[] } }> = [];

function span(mode: 12 | 20 = 12) {
    return {
        mode,
        flagA1: 0,
        field0c: 1,
        field10: Uint8Array.of(0xaa, 0xbb),
        field60: 7,
        field68: Uint8Array.of(0, 0xff),
        field28: Uint8Array.of(0x10, 0x20, 0x30),
    } satisfies TargetMsfRequestBaseCandidateInput;
}

function value(mode: 13 | 21 = 13) {
    return {
        mode,
        flagA1: 0x80,
        field0c: 1,
        fieldA4: 0x89abcdef,
        field60: 7,
        field68: Uint8Array.of(0, 0xff),
        field28: Uint8Array.of(0x10, 0x20, 0x30),
    } satisfies TargetMsfRequestBaseCandidateInput;
}

function unchecked(input: unknown): Uint8Array {
    return encode(input as TargetMsfRequestBaseCandidateInput);
}

function expectFailure(operation: () => unknown): void {
    let caught: unknown;

    try {
        operation();
    } catch (error) {
        caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(ERROR);
    expect((caught as Error).cause).toBeUndefined();
    expect((caught as Error).stack ?? '').not.toContain(PRIVATE);
}

function blocked(): never {
    throw new Error('unexpected effect');
}

beforeEach(() => {
    guards = [
        vi.spyOn(net, 'connect').mockImplementation(blocked),
        vi.spyOn(net, 'createConnection').mockImplementation(blocked),
        vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(blocked),
        vi.spyOn(net.Server.prototype, 'listen').mockImplementation(blocked),
        vi.spyOn(http, 'request').mockImplementation(blocked),
        vi.spyOn(http, 'get').mockImplementation(blocked),
        vi.spyOn(https, 'request').mockImplementation(blocked),
        vi.spyOn(https, 'get').mockImplementation(blocked),
        vi.spyOn(tls, 'connect').mockImplementation(blocked),
        vi.spyOn(dgram, 'createSocket').mockImplementation(blocked),
        vi.spyOn(process, 'dlopen').mockImplementation(blocked),
        vi.spyOn(childProcess, 'spawn').mockImplementation(blocked),
        vi.spyOn(childProcess, 'spawnSync').mockImplementation(blocked),
        vi.spyOn(childProcess, 'exec').mockImplementation(blocked),
        vi.spyOn(childProcess, 'execFile').mockImplementation(blocked),
        vi.spyOn(childProcess, 'execSync').mockImplementation(blocked),
        vi.spyOn(childProcess, 'execFileSync').mockImplementation(blocked),
        vi.spyOn(childProcess, 'fork').mockImplementation(blocked),
        vi.spyOn(console, 'log').mockImplementation(() => {}),
        vi.spyOn(console, 'warn').mockImplementation(() => {}),
        vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];
    const fetch = vi.fn(blocked);
    const webSocket = vi.fn(blocked);
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('WebSocket', webSocket);
    guards.push(fetch, webSocket);
    syncBuiltinESMExports();
});

afterEach(() => {
    try {
        for (const guard of guards) {
            expect(guard.mock.calls).toHaveLength(0);
        }
    } finally {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        syncBuiltinESMExports();
        guards = [];
    }
});

describe('offline MSF CRequestBase normal-path candidate', () => {
    it.each([
        [12, '000000190000000c0100000006aabb070000000600ff102030'],
        [20, '00000019000000140100000006aabb070000000600ff102030'],
    ] as const)('matches the fixed span vector for mode %i', (mode, expected) => {
        expect(hex(encode(span(mode)))).toBe(expected);
    });

    it.each([
        [13, '000000174000000d0189abcdef070000000600ff102030'],
        [21, '00000017400000150189abcdef070000000600ff102030'],
    ] as const)('matches the fixed value vector for mode %i', (mode, expected) => {
        expect(hex(encode(value(mode)))).toBe(expected);
    });

    it.each(MODES)('uses zero/nonzero flagA1 rather than its low bit for mode %i', (mode) => {
        const input = mode === 12 || mode === 20 ? span(mode) : value(mode);

        for (const flagA1 of [0, 1, 2, 0x80, 0xff]) {
            const result = encode({ ...input, flagA1 });
            const view = new DataView(result.buffer);
            expect(view.getUint32(0, false)).toBe(result.length);
            expect(view.getUint32(4, false)).toBe(mode + (flagA1 === 0 ? 0 : 0x40000000));
        }
    });

    it.each([
        [12, '000000120000000c01000000040700000004'],
        [20, '000000120000001401000000040700000004'],
    ] as const)(
        'keeps both inclusive prefixes when all spans are empty in mode %i',
        (mode, expected) => {
            const empty = new Uint8Array();
            expect(
                hex(encode({ ...span(mode), field10: empty, field68: empty, field28: empty })),
            ).toBe(expected);
        },
    );

    it.each([
        [13, '000000120000000d01000000000700000004'],
        [21, '000000120000001501000000000700000004'],
    ] as const)('permits empty U/B and zero fieldA4 in mode %i', (mode, expected) => {
        const empty = new Uint8Array();
        expect(
            hex(encode({ ...value(mode), flagA1: 0, fieldA4: 0, field68: empty, field28: empty })),
        ).toBe(expected);
    });

    it.each([0, 0x7fffffff, 0x80000000, 0xffffffff])(
        'writes unsigned fieldA4 %i exactly',
        (fieldA4) => {
            const result = encode({ ...value(), fieldA4 });
            expect(new DataView(result.buffer).getUint32(9, false)).toBe(fieldA4);
        },
    );

    it('copies B verbatim, including apparent prefixes, and does not classify the byte fields', () => {
        const payload = Uint8Array.of(0, 0, 0, 4, 0xff, 0, 0x80);
        const input = { ...span(), field0c: 0xff, field60: 0, field28: payload };
        const result = encode(input);
        expect(hex(result)).toBe('0000001d0000000cff00000006aabb000000000600ff00000004ff0080');
        expect(result.subarray(22)).toEqual(payload);
        expect(payload).toEqual(Uint8Array.of(0, 0, 0, 4, 0xff, 0, 0x80));
    });

    it.each([12, 13] as const)(
        'accepts the exact local total cap and rejects cap+1 in mode %i',
        (mode) => {
            const backing = new Uint8Array(MAX - 17);
            backing[0] = 0x55;
            const input = mode === 12 ? { ...span(), field10: new Uint8Array() } : value();
            const accepted = encode({
                ...input,
                field68: new Uint8Array(),
                field28: backing.subarray(1),
            });
            expect(accepted.length).toBe(MAX);
            expect(accepted.buffer.byteLength).toBe(MAX);
            expect(new DataView(accepted.buffer).getUint32(0, false)).toBe(MAX);
            expectFailure(() => encode({ ...input, field68: new Uint8Array(), field28: backing }));
            expect(backing[0]).toBe(0x55);
        },
    );

    it('counts all three spans against one total budget instead of separate per-field caps', () => {
        const field10 = new Uint8Array(MAX - 20);
        const input = { ...span(), field10, field68: Uint8Array.of(1), field28: Uint8Array.of(2) };
        expect(encode(input).length).toBe(MAX);
        expectFailure(() => encode({ ...input, field68: Uint8Array.of(1, 2) }));
    });

    it('accepts null-prototype and nonenumerable own-data records', () => {
        const input = span();
        const nullPrototype = Object.assign(Object.create(null) as object, input);
        expect(unchecked(nullPrototype)).toEqual(encode(input));
        const nonenumerable = {};

        for (const [key, item] of Object.entries(input)) {
            Object.defineProperty(nonenumerable, key, { value: item });
        }

        expect(unchecked(nonenumerable)).toEqual(encode(input));
    });

    it('honors Buffer/subview/cross-realm extents and returns independent storage', () => {
        const field10 = Buffer.from([9, 0xaa, 0xbb, 9]).subarray(1, 3);
        const field68 = runInNewContext(
            'new Uint8Array([9, 0, 255, 9]).subarray(1, 3)',
        ) as Uint8Array;
        const backing = Uint8Array.of(9, 0x10, 0x20, 0x30, 9);
        const field28 = backing.subarray(1, 4);
        const input = { ...span(), field10, field68, field28 };
        const result = encode(input);
        const second = encode(input);
        expect(hex(result)).toBe('000000190000000c0100000006aabb070000000600ff102030');
        expect(field68 instanceof Uint8Array).toBe(false);
        expect(backing).toEqual(Uint8Array.of(9, 0x10, 0x20, 0x30, 9));

        for (const source of [field10, field68, field28, second]) {
            expect(result.buffer).not.toBe(source.buffer);
        }

        field10.fill(0);
        field68.fill(0);
        field28.fill(0);
        expect(result).toEqual(second);
        result.fill(0);
        expect(hex(second)).toBe('000000190000000c0100000006aabb070000000600ff102030');
    });

    it('handles overlapping views without modifying or retaining any input', () => {
        const backing = Uint8Array.of(1, 2, 3, 4);
        const before = Uint8Array.from(backing);
        const input = {
            ...span(),
            field10: backing.subarray(0, 2),
            field68: backing.subarray(1, 3),
            field28: backing.subarray(2),
        };
        const result = encode(input);
        expect(hex(result)).toBe('000000180000000c01000000060102070000000602030304');
        expect(backing).toEqual(before);
        result.fill(0);
        expect(backing).toEqual(before);
    });

    it('accepts valid resizable-buffer fixed, tracking and zero-length boundary views', () => {
        const buffer = new ArrayBuffer(8, { maxByteLength: 16 });
        const fixed = new Uint8Array(buffer, 1, 2);
        const tracking = new Uint8Array(buffer, 3);
        const empty = new Uint8Array(buffer, 4, 0);
        buffer.resize(4);
        const result = encode({ ...span(), field10: fixed, field68: tracking, field28: empty });
        expect(hex(result)).toBe('000000150000000c01000000060000070000000500');
    });

    it('ignores hostile own properties and methods on genuine byte views', () => {
        const input = span();
        const trap = vi.fn(() => {
            throw new Error(PRIVATE);
        });

        for (const field of BYTE_FIELDS) {
            for (const key of [
                'buffer',
                'byteLength',
                'byteOffset',
                'length',
                'constructor',
                'values',
                'set',
                'subarray',
                'valueOf',
                'toString',
                Symbol.iterator,
                Symbol.toStringTag,
                Symbol.toPrimitive,
            ]) {
                Object.defineProperty(input[field], key, { get: trap });
            }
        }

        expect(hex(encode(input))).toBe('000000190000000c0100000006aabb070000000600ff102030');
        expect(trap).not.toHaveBeenCalled();
    });

    it('uses captured validation/copy/DataView intrinsics after public replacements', () => {
        const input = span();
        const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
        const properties: Array<[object, PropertyKey]> = [
            [typedPrototype, 'buffer'],
            [typedPrototype, 'byteLength'],
            [typedPrototype, 'values'],
            [typedPrototype, 'set'],
            [typedPrototype, 'fill'],
            [ArrayBuffer.prototype, 'byteLength'],
            [DataView.prototype, 'setUint32'],
            [Reflect, 'apply'],
            [Reflect, 'ownKeys'],
            [Number, 'isInteger'],
            [Object, 'getPrototypeOf'],
            [Object, 'getOwnPropertyDescriptor'],
            [Object, 'hasOwn'],
            [Object, 'create'],
        ];
        const descriptors = properties.map(([owner, key]) =>
            Object.getOwnPropertyDescriptor(owner, key)!,
        );
        let hits = 0;

        const poison = () => {
            hits++;
            throw new Error(PRIVATE);
        };

        let result: Uint8Array | undefined;

        try {
            properties.forEach(([owner, key], index) => {
                const descriptor = descriptors[index];
                Object.defineProperty(
                    owner,
                    key,
                    descriptor.get
                        ? { ...descriptor, get: poison }
                        : { ...descriptor, value: poison },
                );
            });
            result = encode(input);
        } finally {
            properties.forEach(([owner, key], index) =>
                Object.defineProperty(owner, key, descriptors[index]),
            );
        }

        expect(hits).toBe(0);
        expect(hex(result!)).toBe('000000190000000c0100000006aabb070000000600ff102030');
    });

    it('does not advance the typed-array validation iterator', () => {
        const prototype = Object.getPrototypeOf(new Uint8Array().values()) as object;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'next')!;
        let hits = 0;
        let result: Uint8Array | undefined;

        try {
            Object.defineProperty(prototype, 'next', {
                ...descriptor,
                value: () => {
                    hits++;
                    throw new Error(PRIVATE);
                },
            });
            result = encode(span());
        } finally {
            Object.defineProperty(prototype, 'next', descriptor);
        }

        expect(hits).toBe(0);
        expect(hex(result!)).toBe('000000190000000c0100000006aabb070000000600ff102030');
    });

    it('rejects unknown modes and validates every scalar without coercion', () => {
        const trap = vi.fn(() => {
            throw new Error(PRIVATE);
        });
        const numericObject = { valueOf: trap, toString: trap, [Symbol.toPrimitive]: trap };

        for (const mode of [
            0,
            11,
            14,
            19,
            22,
            -1,
            12.5,
            NaN,
            Infinity,
            '12',
            12n,
            null,
            numericObject,
        ]) {
            expectFailure(() => unchecked({ ...span(), mode }));
        }

        for (const field of ['flagA1', 'field0c', 'field60'] as const) {
            for (const item of [
                -1,
                256,
                1.5,
                NaN,
                Infinity,
                -Infinity,
                '1',
                1n,
                null,
                undefined,
                false,
                numericObject,
            ]) {
                expectFailure(() => unchecked({ ...span(), [field]: item }));
            }
        }

        for (const fieldA4 of [
            -1,
            0x100000000,
            1.5,
            NaN,
            Infinity,
            '1',
            1n,
            null,
            undefined,
            numericObject,
        ]) {
            expectFailure(() => unchecked({ ...value(), fieldA4 }));
        }

        expect(trap).not.toHaveBeenCalled();
    });

    it('requires every field and rejects the other branch, symbols, A0 and unknown keys', () => {
        for (const input of [span(), value()]) {
            for (const key of Reflect.ownKeys(input)) {
                const missing = { ...input };
                Reflect.deleteProperty(missing, key);
                expectFailure(() => unchecked(missing));
            }

            for (const key of [
                'flagA0',
                'A0',
                'key',
                'sourceCommand',
                'randomSource',
                'unknown',
                Symbol('x'),
            ]) {
                expectFailure(() => unchecked({ ...input, [key]: 0 }));
            }
        }

        expectFailure(() => unchecked({ ...span(), fieldA4: undefined }));
        expectFailure(() => unchecked({ ...value(), field10: undefined }));
        expectFailure(() => unchecked({ ...span(), mode: 13 }));
        expectFailure(() => unchecked({ ...value(), mode: 12 }));
    });

    it('rejects record accessors and proxy traps without invoking them', () => {
        const trap = vi.fn(() => {
            throw new Error(PRIVATE);
        });

        for (const fixture of [span(), value()]) {
            for (const key of Reflect.ownKeys(fixture)) {
                const input = { ...fixture };
                Object.defineProperty(input, key, { get: trap });
                expectFailure(() => unchecked(input));
            }
        }

        const extraAccessor = span();
        Object.defineProperty(extraAccessor, 'unknown', { get: trap });
        expectFailure(() => unchecked(extraAccessor));
        const proxy = new Proxy(span(), {
            get: trap,
            getPrototypeOf: trap,
            getOwnPropertyDescriptor: trap,
            ownKeys: trap,
            has: trap,
        });
        const revoked = Proxy.revocable(span(), {});
        revoked.revoke();
        const inherited = Object.create(span()) as object;
        const nonplain = Object.assign(Object.create({}), span()) as object;

        for (const input of [
            proxy,
            revoked.proxy,
            inherited,
            nonplain,
            null,
            undefined,
            [],
            () => {},
            new Date(),
            'x',
            1,
        ]) {
            expectFailure(() => unchecked(input));
        }

        expect(trap).not.toHaveBeenCalled();
    });

    it('rejects fake views, proxies and other element types in every byte field', () => {
        const trap = vi.fn(() => {
            throw new Error(PRIVATE);
        });
        const proxy = new Proxy(Uint8Array.of(1), {
            get: trap,
            getPrototypeOf: trap,
            getOwnPropertyDescriptor: trap,
            ownKeys: trap,
        });
        const revoked = Proxy.revocable(Uint8Array.of(1), {});
        revoked.revoke();
        const fake = Object.create(Uint8Array.prototype) as object;
        Object.defineProperty(fake, Symbol.toStringTag, { get: trap });
        const invalid = [
            proxy,
            revoked.proxy,
            fake,
            new Proxy(Buffer.from([1]), { get: trap }),
            runInNewContext('Object.create(Uint8Array.prototype)') as unknown,
            null,
            undefined,
            {},
            [],
            'x',
            1,
            false,
            new ArrayBuffer(1),
            new DataView(new ArrayBuffer(1)),
            new Uint8ClampedArray(1),
            new Int8Array(1),
            new Uint16Array(1),
            new Float32Array(1),
        ];

        for (const field of BYTE_FIELDS) {
            for (const item of invalid) {
                expectFailure(() => unchecked({ ...span(), [field]: item }));
            }
        }

        expect(trap).not.toHaveBeenCalled();
    });

    it('rejects shared, detached and OOB backing even for zero-byte views in every slot', () => {
        const detached = new Uint8Array(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const detachedEmpty = new Uint8Array();
        structuredClone(detachedEmpty.buffer, { transfer: [detachedEmpty.buffer] });
        const foreignDetached = runInNewContext('new Uint8Array(1)') as Uint8Array;
        const foreignBuffer = foreignDetached.buffer as ArrayBuffer;
        structuredClone(foreignBuffer, { transfer: [foreignBuffer] });
        const backing = new ArrayBuffer(8, { maxByteLength: 16 });
        const fixed = new Uint8Array(backing, 2, 6);
        const tracking = new Uint8Array(backing, 7);
        const boundary = new Uint8Array(backing, 8, 0);
        backing.resize(1);
        const foreignOob = runInNewContext(`
            const b = new ArrayBuffer(4, { maxByteLength: 8 });
            const v = new Uint8Array(b, 1, 3);
            b.resize(1);
            v;
        `) as Uint8Array;
        const invalid = [
            detached,
            detachedEmpty,
            foreignDetached,
            fixed,
            tracking,
            boundary,
            foreignOob,
            new Uint8Array(new SharedArrayBuffer(0)),
            new Uint8Array(new SharedArrayBuffer(4)),
            runInNewContext('new Uint8Array(new SharedArrayBuffer(1))') as Uint8Array,
        ];

        for (const field of BYTE_FIELDS) {
            for (const item of invalid) {
                expectFailure(() => unchecked({ ...span(), [field]: item }));
            }
        }
    });

    it.each(MODES)(
        'matches only the expressible outer subset of the existing service encoder for mode %i',
        (mode) => {
            // The old encoder alone performs encryption with this synthetic key/RNG.
            // Feeding its ciphertext into B checks outer framing, not encryption in
            // this writer, equality of native paths, or the separate A0 wrapper.
            const input = mode === 12 || mode === 20 ? span(mode) : value(mode);
            const branch =
                mode === 12 || mode === 20
                    ? {
                          virtualResultByte: 0 as const,
                          kind: 'span' as const,
                          span: Uint8Array.of(0xaa, 0xbb),
                      }
                    : { virtualResultByte: 1, kind: 'value' as const, value: 0x89abcdef };
            const old = encodeTargetServiceRequest({
                sourceCommand: 'wtlogin64.trans_emp',
                virtualProtocol: mode | (input.flagA1 === 0 ? 0 : 0x40000000),
                basicBranch: branch,
                requestObjectByte: 7,
                uin: 'é',
                head: Uint8Array.of(0),
                busi: Uint8Array.of(1, 2),
                targetTeaKey: Uint8Array.from({ length: 16 }, (_, index) => index),
                randomSource: (length) => {
                    const bytes = new Uint8Array(length);
                    bytes[0] = 0xf8;
                    return bytes;
                },
            });
            const headerLength = mode === 12 || mode === 20 ? 22 : 20;
            const ciphertext = old.subarray(headerLength);
            expect(hex(ciphertext)).toBe('b619e9103a2640d8262b6860a4102374');
            const result = encode({
                ...input,
                field0c: 2,
                field68: Uint8Array.of(0xc3, 0xa9),
                field28: ciphertext,
            });
            expect(hex(result)).toBe(hex(old));
            expect(result.buffer).not.toBe(old.buffer);
        },
    );

    it('clears a partially written output after an injected intrinsic failure and sanitizes the error', async () => {
        const write = DataView.prototype.setUint32;
        const fill = Uint8Array.prototype.fill;
        let partial: Uint8Array | undefined;
        const cleared: Uint8Array[] = [];
        const setter = vi.spyOn(DataView.prototype, 'setUint32').mockImplementation(function (
            this: DataView,
            offset,
            number,
            endian,
        ) {
            if (this.byteLength === 25) {
                partial = new Uint8Array(this.buffer, this.byteOffset, this.byteLength);

                if (offset === 4) {
                    throw new Error(PRIVATE);
                }
            }

            return write.call(this, offset, number, endian);
        });
        const filler = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            number,
            start,
            end,
        ) {
            const result = fill.call(this, number, start, end);

            if (this.buffer === partial?.buffer && number === 0) {
                cleared.push(this);
            }

            return result;
        });

        try {
            vi.resetModules();
            const fresh = await import('../../src/direct/target-msf-request-base-candidate');
            expectFailure(() => fresh.encodeTargetMsfRequestBaseCandidate(span()));
        } finally {
            setter.mockRestore();
            filler.mockRestore();
            vi.resetModules();
        }

        expect(partial).toBeDefined();
        expect(cleared).toHaveLength(1);
        expect(partial).toEqual(new Uint8Array(25));
    });
});
