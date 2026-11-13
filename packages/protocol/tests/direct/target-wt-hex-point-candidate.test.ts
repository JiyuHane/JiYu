import { createECDH, randomBytes } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeTargetWtHexPointCandidate as decode } from '../../src/direct/target-wt-hex-point-candidate';

const failure = 'target WT hex point candidate failed';
const ascii = (text: string) => Buffer.from(text, 'ascii');

function fixture(width: number): { text: Buffer; point: Buffer } {
    const point = Buffer.concat([Buffer.of(4), randomBytes(width * 2)]);
    return { point, text: ascii(point.toString('hex')) };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('local unverified WT hex point format candidate', () => {
    it('handles exact width one and both letter cases', () => {
        for (const text of ['04abEF', '04ABef', '04aBeF']) {
            const input = ascii(text);
            const result = decode(input, 1);
            expect(result).toEqual({
                kind: 'unverified-wt-point-candidate',
                bytes: Uint8Array.of(4, 0xab, 0xef),
            });
            expect(input).toEqual(ascii(text));
        }
    });

    it('handles synthetic Node secp192k1 public point without validating the curve', () => {
        const ecdh = createECDH('secp192k1');
        const syntheticPrivate = Buffer.alloc(24);
        syntheticPrivate[23] = 1;
        ecdh.setPrivateKey(syntheticPrivate);
        const point = ecdh.getPublicKey(undefined, 'uncompressed');
        const candidate = decode(ascii(point.toString('hex')), 24);
        expect(candidate.bytes).toEqual(Uint8Array.from(point));
    });

    it('accepts the local maximum width and random byte patterns', () => {
        for (const width of [1, 2, 24, 256]) {
            const { point, text } = fixture(width);
            expect(decode(text, width).bytes).toEqual(Uint8Array.from(point));
        }

        expect(fixture(256).text.length).toBe(1026);
    });

    it('accepts foreign-realm subviews and ignores byte-object shadow getters', () => {
        let calls = 0;

        const forbidden = () => {
            calls++;
            throw new Error('secret');
        };

        const foreign = runInNewContext(
            'new Uint8Array([99,48,52,97,66,69,102,99]).subarray(1,7)',
        ) as Uint8Array;

        for (const name of [
            'buffer',
            'byteLength',
            'byteOffset',
            'length',
            Symbol.toStringTag,
            Symbol.iterator,
            'slice',
            'fill',
        ]) {
            Object.defineProperty(foreign, name, { get: forbidden });
        }

        expect(decode(foreign, 1).bytes).toEqual(Uint8Array.of(4, 0xab, 0xef));
        expect(calls).toBe(0);
    });

    it('keeps input and output independently owned in both directions', () => {
        const input = ascii('04aBcD');
        const expected = Buffer.from(input);
        const output = decode(input, 1).bytes;
        expect(output.buffer).not.toBe(input.buffer);
        expect(input).toEqual(expected);
        input[2] = 0x30;
        expect(output).toEqual(Uint8Array.of(4, 0xab, 0xcd));
        output[2] = 0x11;
        expect(input[4]).toBe(0x63);
    });

    it('rejects invalid widths, lengths, odd lengths and invalid hex or prefix', () => {
        const valid = ascii('040001');

        for (const width of [0, -1, 257, 1.5, NaN, Infinity, '1', null, undefined]) {
            expect(() => decode(valid, width as number)).toThrow(failure);
        }

        for (const text of [
            '',
            '04',
            '04000',
            '0400010',
            '04000100',
            '050001',
            '020001',
            '04g001',
            '0400/1',
            '04 001',
            '0400é1',
        ]) {
            expect(() => decode(ascii(text), 1)).toThrow(failure);
        }

        expect(() => decode(new Uint8Array(1027), 256)).toThrow(failure);
        expect(valid).toEqual(ascii('040001'));
    });

    it('rejects proxy and proxy prototypes without running traps', () => {
        let calls = 0;

        const trap = () => {
            calls++;
            throw new Error('secret');
        };

        const input = ascii('040001');
        const proxy = new Proxy(input, { get: trap, getPrototypeOf: trap });
        const revoked = Proxy.revocable(input, {});
        revoked.revoke();
        const prototypeProxy = ascii('040001');
        Object.setPrototypeOf(
            prototypeProxy,
            new Proxy(Uint8Array.prototype, { get: trap, getPrototypeOf: trap }),
        );

        for (const value of [proxy, revoked.proxy, prototypeProxy]) {
            expect(() => decode(value, 1)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });

    it('rejects shared, foreign shared, detached, OOB and non-byte views', () => {
        const detached = ascii('040001');
        const detachedBytes = Uint8Array.from(detached);
        structuredClone(detachedBytes, { transfer: [detachedBytes.buffer] });
        const backing = new ArrayBuffer(8, { maxByteLength: 16 });
        const outOfBounds = new Uint8Array(backing, 1, 6);
        backing.resize(0);
        const foreignShared = runInNewContext(
            'new Uint8Array(new SharedArrayBuffer(6))',
        ) as Uint8Array;

        for (const value of [
            new Uint8Array(new SharedArrayBuffer(6)),
            foreignShared,
            detachedBytes,
            outOfBounds,
            new Uint16Array(6),
            new DataView(new ArrayBuffer(6)),
            {},
            null,
        ]) {
            expect(() => decode(value as Uint8Array, 1)).toThrow(failure);
        }
    });

    it('captures byte constructor at import and ignores subsequent replacement', () => {
        const input = ascii('040001');
        const original = Buffer.from(input);
        const Native = Uint8Array;
        const hostile = vi.fn(function () {
            return input;
        });
        vi.stubGlobal('Uint8Array', hostile);
        let result: ReturnType<typeof decode>;

        try {
            result = decode(input, 1);
        } finally {
            vi.unstubAllGlobals();
        }

        expect(hostile).not.toHaveBeenCalled();
        expect(result.bytes).toEqual(new Native([4, 0, 1]));
        expect(input).toEqual(original);
    });

    it('clears snapshot on success and both allocations after a late failure', async () => {
        vi.resetModules();
        const Native = Uint8Array;
        const allocations: Uint8Array[] = [];
        vi.stubGlobal(
            'Uint8Array',
            new Proxy(Native, {
                construct(target, args) {
                    const value = Reflect.construct(target, args, target) as Uint8Array;

                    if (typeof args[0] === 'number') {
                        allocations.push(value);
                    }

                    return value;
                },
            }),
        );
        const isolated = await import('../../src/direct/target-wt-hex-point-candidate');
        vi.unstubAllGlobals();
        const input = ascii('040001');
        const result = isolated.decodeTargetWtHexPointCandidate(input, 1);
        expect(allocations[0]).toEqual(new Native(6));
        expect(allocations[1]).toBe(result.bytes);
        expect(result.bytes).toEqual(Native.of(4, 0, 1));
        expect(() => isolated.decodeTargetWtHexPointCandidate(ascii('0400g1'), 1)).toThrow(failure);
        expect(allocations[2]).toEqual(new Native(6));
        expect(allocations[3]).toEqual(new Native(3));
        expect(input).toEqual(ascii('040001'));
    });

    it('continues clearing partial output if clearing the snapshot throws', async () => {
        vi.resetModules();
        const originalFill = Uint8Array.prototype.fill;
        const cleaned: Uint8Array[] = [];
        vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
            this: Uint8Array,
            value: number,
            start?: number,
            end?: number,
        ) {
            cleaned.push(this);

            if (cleaned.length === 1) {
                throw new Error('secret');
            }

            return originalFill.call(this, value, start, end);
        });
        const isolated = await import('../../src/direct/target-wt-hex-point-candidate');
        expect(() => isolated.decodeTargetWtHexPointCandidate(ascii('0400g1'), 1)).toThrow(failure);
        vi.restoreAllMocks();
        expect(cleaned).toHaveLength(2);
        expect(cleaned[1]).toEqual(Uint8Array.of(0, 0, 0));
    });
});
