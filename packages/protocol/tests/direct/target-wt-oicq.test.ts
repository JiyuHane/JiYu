import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    encodeTargetWtOicq as encode,
    MAX_TARGET_WT_OICQ_OPAQUE_BYTES,
    type TargetWtOicq,
} from '../../src/direct/target-wt-oicq';

const failure = 'target WT OICQ construction failed';

function fixture(): TargetWtOicq {
    return {
        version: 0x1234,
        command: 0x0812,
        sequence: 0x5678,
        uin: 0x89abcdef,
        clientType: 0xabcd,
        pubno: 0x10203040,
        opaque: Uint8Array.of(0xa1, 0, 0xff, 2),
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('target-static WT OICQ success envelope', () => {
    it('matches a hand-assembled synthetic golden and each documented offset', () => {
        const input = fixture();
        const output = encode(input);
        expect(Buffer.from(output).toString('hex')).toBe(
            '02002112340812567889abcdef0387000000abcd1020304000000000a100ff0203',
        );
        const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
        expect(output.length).toBe(33);
        expect(view.getUint8(0)).toBe(2);
        expect(view.getUint16(1)).toBe(33);
        expect(view.getUint16(3)).toBe(0x1234);
        expect(view.getUint16(5)).toBe(0x0812);
        expect(view.getUint16(7)).toBe(0x5678);
        expect(view.getUint32(9)).toBe(0x89abcdef);
        expect(Array.from(output.subarray(13, 16))).toEqual([3, 0x87, 0]);
        expect(view.getUint32(16)).toBe(0xabcd);
        expect(view.getUint32(20)).toBe(0x10203040);
        expect(view.getUint32(24)).toBe(0);
        expect(Array.from(output.subarray(28))).toEqual([0xa1, 0, 0xff, 2, 3]);
        expect(input.opaque).toEqual(Uint8Array.of(0xa1, 0, 0xff, 2));
        expect(output.buffer).not.toBe(input.opaque.buffer);
        output[28] = 7;
        expect(input.opaque[0]).toBe(0xa1);
        input.opaque[1] = 9;
        expect(output[29]).toBe(0);
        // Reference implementation hardcodes 8001 at offset 3 and differs in
        // its client/opaque layout; this golden models the separate target path.
        expect(view.getUint16(3)).not.toBe(8001);
    });

    it('accepts empty and maximum opaque data and rejects total overflow', () => {
        const empty = encode({ ...fixture(), opaque: new Uint8Array() });
        expect(empty).toHaveLength(29);
        expect(new DataView(empty.buffer).getUint16(1)).toBe(29);
        expect(empty[28]).toBe(3);
        const input = new Uint8Array(MAX_TARGET_WT_OICQ_OPAQUE_BYTES);
        input[0] = 0xa1;
        input[input.length - 1] = 0xb2;
        const output = encode({ ...fixture(), opaque: input });
        expect(output).toHaveLength(65535);
        expect(new DataView(output.buffer).getUint16(1)).toBe(65535);
        expect(output[28]).toBe(0xa1);
        expect(output[65533]).toBe(0xb2);
        expect(output[65534]).toBe(3);
        expect(input[0]).toBe(0xa1);
        expect(() => encode({ ...fixture(), opaque: new Uint8Array(65507) })).toThrow(failure);
    });

    it('accepts integer endpoints and rejects invalid numeric types and bounds', () => {
        const max = encode({
            version: 65535,
            command: 65535,
            sequence: 65535,
            uin: 0xffffffff,
            clientType: 65535,
            pubno: 0xffffffff,
            opaque: new Uint8Array(),
        });
        const view = new DataView(max.buffer);

        for (const start of [3, 5, 7]) {
            expect(view.getUint16(start)).toBe(65535);
        }

        expect(view.getUint32(9)).toBe(0xffffffff);
        expect(view.getUint32(16)).toBe(65535);
        expect(view.getUint32(20)).toBe(0xffffffff);
        const zero = encode({
            version: 0,
            command: 0,
            sequence: 0,
            uin: 0,
            clientType: 0,
            pubno: 0,
            opaque: new Uint8Array(),
        });
        expect(new DataView(zero.buffer).getUint32(16)).toBe(0);

        for (const name of [
            'version',
            'command',
            'sequence',
            'clientType',
            'uin',
            'pubno',
        ] as const) {
            const overflow = name === 'uin' || name === 'pubno' ? 0x100000000 : 65536;

            for (const bad of [-1, overflow, 1.5, NaN, Infinity, '1', null, 1n]) {
                const input = fixture();
                Object.assign(input, { [name]: bad });
                expect(() => encode(input)).toThrow(failure);
            }
        }
    });

    it('uses actual byte slots from foreign views and ignores shadow accessors', () => {
        const input = fixture();
        input.opaque = runInNewContext(
            'new Uint8Array([9,161,0,255,2,8]).subarray(1,5)',
        ) as Uint8Array;
        let calls = 0;

        const bad = () => {
            calls++;
            throw new Error('secret');
        };

        for (const name of [
            'buffer',
            'byteLength',
            'byteOffset',
            'length',
            Symbol.toStringTag,
            Symbol.iterator,
        ]) {
            Object.defineProperty(input.opaque, name, { get: bad });
        }

        expect(Buffer.from(encode(input)).toString('hex')).toBe(
            '02002112340812567889abcdef0387000000abcd1020304000000000a100ff0203',
        );
        expect(calls).toBe(0);
    });

    it('rejects accessors and proxies without calling traps', () => {
        let calls = 0;

        const bad = () => {
            calls++;
            throw new Error('SECRET');
        };

        const input = fixture();
        const extra = fixture();
        Object.defineProperty(extra, 'extra', { get: bad });
        const getter = fixture();
        Object.defineProperty(getter, 'opaque', { get: bad });
        const prototypeProxy = fixture();
        Object.setPrototypeOf(
            prototypeProxy,
            new Proxy(Object.prototype, { getPrototypeOf: bad, get: bad }),
        );
        const badByteProto = Uint8Array.of(1);
        Object.setPrototypeOf(
            badByteProto,
            new Proxy(Uint8Array.prototype, { getPrototypeOf: bad, get: bad }),
        );
        const revoked = Proxy.revocable(Uint8Array.of(1), { get: bad });
        revoked.revoke();

        for (const candidate of [
            new Proxy(input, { get: bad, getPrototypeOf: bad }),
            extra,
            getter,
            prototypeProxy,
            { ...input, opaque: new Proxy(input.opaque, { get: bad }) },
            { ...input, opaque: badByteProto },
            { ...input, opaque: revoked.proxy },
        ]) {
            expect(() => encode(candidate)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it('rejects shared, detached, OOB and non-Uint8 byte views', () => {
        const detached = Uint8Array.of(1);
        structuredClone(detached, { transfer: [detached.buffer] });
        const rab = new ArrayBuffer(2, { maxByteLength: 4 });
        const oob = new Uint8Array(rab, 1, 1);
        rab.resize(0);
        const foreignShared = runInNewContext(
            'new Uint8Array(new SharedArrayBuffer(1))',
        ) as Uint8Array;

        for (const value of [
            new Uint8Array(new SharedArrayBuffer(1)),
            foreignShared,
            detached,
            oob,
            new Uint16Array(1),
            new DataView(new ArrayBuffer(1)),
            null,
        ]) {
            expect(() => encode({ ...fixture(), opaque: value as Uint8Array })).toThrow(failure);
        }
    });

    it('clears snapshot and partial output independently when copy and cleanup fail', async () => {
        vi.resetModules();
        const input = fixture();
        const originalSet = Uint8Array.prototype.set;
        const originalFill = Uint8Array.prototype.fill;
        const cleaned: Uint8Array[] = [];
        let copies = 0;
        vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
            this: Uint8Array,
            source,
            at,
        ) {
            originalSet.call(this, source, at);

            if (++copies === 2) {
                throw new Error('secret payload');
            }
        });
        vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value,
            start,
            end,
        ) {
            cleaned.push(this);

            if (cleaned.length === 1) {
                throw new Error('secret cleanup');
            }

            return originalFill.call(this, value, start, end);
        });
        const isolated = await import('../../src/direct/target-wt-oicq');
        let thrown: unknown;

        try {
            isolated.encodeTargetWtOicq(input);
        } catch (error) {
            thrown = error;
        }

        vi.restoreAllMocks();
        expect((thrown as Error).message).toBe(failure);
        expect(cleaned).toHaveLength(2);
        expect(cleaned[1]).toEqual(new Uint8Array(33));
        expect(input.opaque).toEqual(Uint8Array.of(0xa1, 0, 0xff, 2));
    });

    it('retains captured constructors after global replacement', () => {
        const input = fixture();
        const hostile = vi.fn(function () {
            return input.opaque;
        });
        vi.stubGlobal('Uint8Array', hostile);
        let output: Uint8Array;

        try {
            output = encode(input);
        } finally {
            vi.unstubAllGlobals();
        }

        expect(hostile).not.toHaveBeenCalled();
        expect(Buffer.from(output).toString('hex')).toBe(
            '02002112340812567889abcdef0387000000abcd1020304000000000a100ff0203',
        );
        expect(input.opaque).toEqual(Uint8Array.of(0xa1, 0, 0xff, 2));
    });
});
