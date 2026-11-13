import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
    encodeTargetWtLoginOrder,
    type TargetWtLoginNode,
    type TargetWtLoginOpaqueNode,
} from '../../src/direct/target-wt-login-order';

// Independently assembled synthetic fragments: a tag is a caller assertion,
// not a claim that opaque bytes share any particular wire format.
const requiredTags = [0x106, 0x144, 0x116, 0x142, 0x145, 0x018, 0x141, 0x177, 0x191];
const optionalTags = [
    0x154, 0x400, 0x104, 0x100, 0x107, 0x108, 0x11b, 0x112, 0x185, 0x008, 0x187, 0x190, 0x201,
    0x318, 0x16a, 0x166, 0x521, 0x516, 0x172,
];
const failure = 'target WT login ordered encoding failed';

function required(): TargetWtLoginOpaqueNode[] {
    return requiredTags.map((tag, index) => ({ tag, kind: 'opaque', bytes: Uint8Array.of(index) }));
}

function optional(): TargetWtLoginNode[] {
    return optionalTags.map((tag, index) =>
        tag === 0x318 || tag === 0x16a
            ? { tag, kind: 'raw', bytes: Uint8Array.of(index) }
            : { tag, kind: 'opaque', bytes: Uint8Array.of(index + 0x20) },
    ) as TargetWtLoginNode[];
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describe('conditional target WT login writer order', () => {
    it('orders both trees by the static tables, not caller order or tag sort', () => {
        const expected =
            '000102030405060708' +
            '202122232425262728292a2b2c' +
            '031800010d' +
            '016a00010e' +
            '2f303132';
        expect(hex(encodeTargetWtLoginOrder(required().reverse(), optional().reverse()))).toBe(
            expected,
        );
    });

    it('writes only present optional nodes and never invents a header or count', () => {
        const choices: TargetWtLoginNode[] = [
            { tag: 0x16a, kind: 'raw', bytes: Uint8Array.of(0, 255) },
            { tag: 0x154, kind: 'opaque', bytes: Uint8Array.of(0xfe, 0xed, 0) },
            { tag: 0x318, kind: 'raw', bytes: new Uint8Array() },
        ];
        expect(hex(encodeTargetWtLoginOrder(required(), choices))).toBe(
            '000102030405060708feed0003180000016a000200ff',
        );
        expect(hex(encodeTargetWtLoginOrder(required(), []))).toBe('000102030405060708');
    });

    it('accepts opaque bytes without inventing or validating an unobserved prefix', () => {
        const entries = required();
        entries[0].bytes = Uint8Array.of(0xff, 0, 0, 0x42);
        entries[1].bytes = new Uint8Array();
        expect(hex(encodeTargetWtLoginOrder(entries, []))).toBe('ff00004202030405060708');
    });

    it('requires every mandatory tag and rejects wrong tree, duplicates and unknown tags', () => {
        for (let index = 0; index < requiredTags.length; index++) {
            const entries = required();
            entries.splice(index, 1);
            expect(() => encodeTargetWtLoginOrder(entries, [])).toThrow(failure);
        }

        const duplicate = required();
        duplicate[1] = { ...duplicate[0] };
        expect(() => encodeTargetWtLoginOrder(duplicate, [])).toThrow(failure);
        expect(() => encodeTargetWtLoginOrder(required(), [optional()[0], optional()[0]])).toThrow(
            failure,
        );
        expect(() =>
            encodeTargetWtLoginOrder(required(), [
                { tag: 0x106, kind: 'opaque', bytes: Uint8Array.of(0) },
            ]),
        ).toThrow(failure);
        expect(() =>
            encodeTargetWtLoginOrder(required(), [
                { tag: 0xbeef, kind: 'opaque', bytes: Uint8Array.of(0) },
            ]),
        ).toThrow(failure);
        expect(() =>
            encodeTargetWtLoginOrder(
                required().map((node, index) => (index === 0 ? { ...node, tag: 0x154 } : node)),
                [],
            ),
        ).toThrow(failure);
    });

    it('enforces raw versus opaque input modes for the two independently inspected tags', () => {
        const invalid = [
            { tag: 0x318, kind: 'opaque', bytes: Uint8Array.of(0) },
            { tag: 0x16a, kind: 'opaque', bytes: Uint8Array.of(0) },
            { tag: 0x154, kind: 'raw', bytes: Uint8Array.of(0) },
        ];

        for (const node of invalid) {
            expect(() => encodeTargetWtLoginOrder(required(), [node as TargetWtLoginNode])).toThrow(
                failure,
            );
        }
    });

    it('rejects oversized known values and aggregate output above the local cap', () => {
        const max = new Uint8Array(0xffff);
        const result = encodeTargetWtLoginOrder(required(), [
            { tag: 0x318, kind: 'raw', bytes: max },
        ]);
        expect(result.length).toBe(9 + 4 + 0xffff);
        expect(hex(result.subarray(9, 13))).toBe('0318ffff');
        expect(() =>
            encodeTargetWtLoginOrder(required(), [
                { tag: 0x318, kind: 'raw', bytes: new Uint8Array(0x10000) },
            ]),
        ).toThrow(failure);
        const entries = required();
        entries[0].bytes = new Uint8Array(16 * 1024 * 1024);
        expect(() => encodeTargetWtLoginOrder(entries, [])).toThrow(failure);
        entries[0].bytes = new Uint8Array(16 * 1024 * 1024 + 1);
        expect(() => encodeTargetWtLoginOrder(entries, [])).toThrow(failure);
    });

    it('accepts exactly the aggregate cap and keeps the returned output independent', () => {
        const entries = required();
        entries[0].bytes = new Uint8Array(16 * 1024 * 1024 - 8).fill(0xa5);
        const output = encodeTargetWtLoginOrder(entries, []);
        expect(output.length).toBe(16 * 1024 * 1024);
        expect(output[0]).toBe(0xa5);
        expect(output.at(-1)).toBe(8);
        entries[0].bytes[0] = 0;
        expect(output[0]).toBe(0xa5);
    });

    it('copies offset views and foreign bytes without mutating caller-owned buffers', () => {
        const backing = Buffer.from([9, 0x80, 0xff, 9]);
        const foreign = runInNewContext(
            'new Uint8Array([9, 1, 2, 9]).subarray(1, 3)',
        ) as Uint8Array;
        const entries = required();
        entries[0].bytes = backing.subarray(1, 3);
        entries[1].bytes = foreign;
        const output = encodeTargetWtLoginOrder(entries, []);
        expect(hex(output)).toBe('80ff010202030405060708');
        expect(backing).toEqual(Buffer.from([9, 0x80, 0xff, 9]));
        backing.fill(0);
        foreign.fill(0);
        expect(hex(output)).toBe('80ff010202030405060708');
        output.fill(0);
        expect(backing).toEqual(Buffer.alloc(4));
    });

    it('rejects accessor records, sparse arrays, proxies and unsafe views without executing traps', () => {
        let traps = 0;

        const fail = () => {
            traps++;
            throw new Error('SECRET');
        };

        const entries = required();
        const accessor = {
            tag: 0x106,
            kind: 'opaque',
            get bytes() {
                return fail();
            },
        };
        entries[0] = accessor;
        expect(() => encodeTargetWtLoginOrder(entries, [])).toThrow(failure);
        const sparse = required();
        delete (sparse as unknown as Record<number, unknown>)[0];
        expect(() => encodeTargetWtLoginOrder(sparse, [])).toThrow(failure);
        expect(() => encodeTargetWtLoginOrder(new Proxy(required(), { get: fail }), [])).toThrow(
            failure,
        );
        const proxied = required();
        proxied[0] = new Proxy(proxied[0], { get: fail, getPrototypeOf: fail });
        expect(() => encodeTargetWtLoginOrder(proxied, [])).toThrow(failure);
        const detached = Uint8Array.of(1);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const rab = new ArrayBuffer(8, { maxByteLength: 16 });
        const outOfBounds = new Uint8Array(rab, 4, 4);
        rab.resize(0);
        const prototypeProxy = Uint8Array.of(1);
        Object.setPrototypeOf(
            prototypeProxy,
            new Proxy(Uint8Array.prototype, { getPrototypeOf: fail }),
        );
        const bad = [
            prototypeProxy,
            detached,
            outOfBounds,
            new Uint8Array(new SharedArrayBuffer(1)),
            new Uint16Array(1),
            new Proxy(Uint8Array.of(1), { get: fail, getPrototypeOf: fail }),
        ];

        for (const value of bad) {
            const input = required();
            input[0].bytes = value as Uint8Array;
            expect(() => encodeTargetWtLoginOrder(input, [])).toThrow(failure);
        }

        expect(traps).toBe(0);
    });

    it('wipes private snapshots and incomplete output after a late copy failure', async () => {
        const original = Uint8Array.prototype.set;
        const calls: Uint8Array[] = [];
        const inputs = required();
        const before = inputs.map(({ bytes }) => Uint8Array.from(bytes));
        vi.resetModules();
        const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            value: ArrayLike<number>,
            offset?: number,
        ) {
            calls.push(this);
            original.call(this, value, offset);

            if (calls.length === 10) {
                throw new Error('SECRET');
            }
        });

        try {
            const module = await import('../../src/direct/target-wt-login-order');
            expect(() => module.encodeTargetWtLoginOrder(inputs, [])).toThrow(failure);
        } finally {
            spy.mockRestore();
        }

        expect(calls).toHaveLength(10);
        expect(calls.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
        expect(inputs.map(({ bytes }) => bytes)).toEqual(before);
    });
});
