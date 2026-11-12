import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
    decodeTargetServiceResponseBasic,
    MAX_TARGET_SERVICE_RESPONSE_BASIC_BYTES,
} from '../../src/direct/target-service-response-basic';

const failure = 'target service response basic decoding failed';

describe('target-static service response basic', () => {
    it('clears an allocated opaque copy when constructing the source view fails', () => {
        const NativeBytes = Uint8Array;
        const input = NativeBytes.of(0, 0, 0, 1, 0, 0, 0, 2, 3, 4, 0, 0, 0, 7, 10, 11, 12);
        const before = NativeBytes.from(input);
        let allocated: Uint8Array | undefined;
        let thrown: unknown;
        const injected = new Proxy(NativeBytes, {
            construct(target, args, newTarget) {
                if (args[0] === input.buffer) {
                    throw new Error('injected source failure');
                }

                const result = Reflect.construct(target, args, newTarget) as Uint8Array;

                if (args.length === 1 && args[0] === 3) {
                    allocated = result;
                    allocated.fill(0xa5);
                    Object.defineProperty(allocated, 'fill', {
                        value: () => {
                            throw new Error('shadow fill');
                        },
                    });
                }

                return result;
            },
        });

        vi.stubGlobal('Uint8Array', injected);

        try {
            decodeTargetServiceResponseBasic(input);
        } catch (error) {
            thrown = error;
        } finally {
            vi.unstubAllGlobals();
        }

        expect(thrown).toEqual(new Error(failure));
        expect(input).toEqual(before);
        expect(allocated).toBeInstanceOf(NativeBytes);
        expect(allocated!.buffer).not.toBe(input.buffer);
        expect(allocated).toEqual(NativeBytes.of(0, 0, 0));
    });

    it('clears an allocated opaque copy when copying fails', () => {
        const NativeBytes = Uint8Array;
        const input = NativeBytes.of(0, 0, 0, 1, 0, 0, 0, 2, 3, 4, 0, 0, 0, 7, 10, 11, 12);
        const before = NativeBytes.from(input);
        let allocated: Uint8Array | undefined;
        let thrown: unknown;
        const injected = new Proxy(NativeBytes, {
            construct(target, args, newTarget) {
                if (args.length === 1 && args[0] === 3) {
                    allocated = NativeBytes.of(0xa5, 0xa5);
                    return allocated;
                }

                return Reflect.construct(target, args, newTarget);
            },
        });

        vi.stubGlobal('Uint8Array', injected);

        try {
            decodeTargetServiceResponseBasic(input);
        } catch (error) {
            thrown = error;
        } finally {
            vi.unstubAllGlobals();
        }

        expect(thrown).toEqual(new Error(failure));
        expect(input).toEqual(before);
        expect(allocated).toBeInstanceOf(NativeBytes);
        expect(allocated!.buffer).not.toBe(input.buffer);
        expect(allocated).toEqual(NativeBytes.of(0, 0));
    });

    it('reads unsigned words and both bytes without treating word0 as total length', () => {
        const input = Uint8Array.of(
            0xff,
            0xff,
            0xff,
            0xff,
            0x80,
            0,
            0,
            1,
            0xfe,
            0x81,
            0,
            0,
            0,
            7,
            0xff,
            0,
            0x80,
        );
        expect(decodeTargetServiceResponseBasic(input)).toEqual({
            word0: 0xffffffff,
            word4: 0x80000001,
            selector: 0xfe,
            flag9: 0x81,
            opaque: Uint8Array.of(0xff, 0, 0x80),
            nextOffset: 17,
        });
    });

    it('reads at an offset within a subview and returns an independent copy', () => {
        const backing = Uint8Array.of(
            99,
            88,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            2,
            3,
            4,
            0,
            0,
            0,
            6,
            0xaa,
            0xbb,
            0xcc,
            77,
        );
        const input = backing.subarray(1, 19);
        const before = Uint8Array.from(backing);
        const result = decodeTargetServiceResponseBasic(input, 1);
        expect(result).toEqual({
            word0: 1,
            word4: 2,
            selector: 3,
            flag9: 4,
            opaque: Uint8Array.of(0xaa, 0xbb),
            nextOffset: 17,
        });
        expect(backing).toEqual(before);
        expect(result.opaque.buffer).not.toBe(backing.buffer);
        backing[16] = 0x11;
        expect(result.opaque[0]).toBe(0xaa);
        result.opaque[1] = 0x22;
        expect(backing[17]).toBe(0xbb);
        expect(input[result.nextOffset]).toBe(0xcc);
    });

    it('rejects lengths below four and truncated input but accepts empty exact-end basic', () => {
        for (let length = 0; length < 4; length++) {
            const input = new Uint8Array(14);
            new DataView(input.buffer).setUint32(10, length);
            expect(() => decodeTargetServiceResponseBasic(input)).toThrow(failure);
        }

        for (let length = 0; length < 14; length++) {
            expect(() => decodeTargetServiceResponseBasic(new Uint8Array(length))).toThrow(failure);
        }

        const input = new Uint8Array(15);
        const view = new DataView(input.buffer);
        view.setUint32(10, 4);
        const empty = decodeTargetServiceResponseBasic(input.subarray(0, 14));
        expect(empty.opaque).toEqual(new Uint8Array());
        expect(empty.nextOffset).toBe(14);
        expect(empty.nextOffset).toBe(input.subarray(0, 14).length);
        view.setUint32(10, 6);
        expect(() => decodeTargetServiceResponseBasic(input)).toThrow(failure);
        view.setUint32(10, 0xffffffff);
        expect(() => decodeTargetServiceResponseBasic(input)).toThrow(failure);
    });

    it('leaves caller fields untouched and reports where they start', () => {
        const input = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 1, 7, 0, 0, 0, 5, 0xaa, 3, 4);
        const basic = decodeTargetServiceResponseBasic(input);
        expect(basic.nextOffset).toBe(15);
        expect(input.slice(basic.nextOffset)).toEqual(Uint8Array.of(3, 4));
        expect(basic.selector).toBe(1);
        expect(basic.flag9).toBe(7);
    });

    it('caps the entire basic field locally, independently of trailing bytes', () => {
        const cap = MAX_TARGET_SERVICE_RESPONSE_BASIC_BYTES;
        const input = new Uint8Array(cap + 1);
        const view = new DataView(input.buffer);
        view.setUint32(10, cap - 10);
        input[14] = 0xaa;
        input[cap - 1] = 0xbb;
        input[cap] = 0xcc;
        const result = decodeTargetServiceResponseBasic(input);
        expect(result.opaque.length).toBe(cap - 14);
        expect(result.opaque[0]).toBe(0xaa);
        expect(result.opaque[cap - 15]).toBe(0xbb);
        expect(result.nextOffset).toBe(cap);
        expect(input[cap]).toBe(0xcc);
        view.setUint32(10, cap - 9);
        expect(() => decodeTargetServiceResponseBasic(input)).toThrow(failure);
    });

    it('uses intrinsic slots instead of shadow getters and accepts foreign Uint8Array', () => {
        const input = Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 2, 3, 4, 0, 0, 0, 5, 0x80);
        let calls = 0;

        for (const name of [
            'length',
            'byteLength',
            'byteOffset',
            'buffer',
            Symbol.iterator,
            Symbol.toStringTag,
        ]) {
            Object.defineProperty(input, name, {
                get() {
                    calls++;
                    throw new Error('SECRET');
                },
            });
        }

        expect(decodeTargetServiceResponseBasic(input).opaque).toEqual(Uint8Array.of(0x80));
        const foreign = runInNewContext(
            'new Uint8Array([0,0,0,1,0,0,0,2,3,4,0,0,0,4])',
        ) as Uint8Array;
        expect(decodeTargetServiceResponseBasic(foreign).word4).toBe(2);
        expect(calls).toBe(0);
    });

    it('rejects invalid offsets and proxied, shared, detached or out-of-bounds inputs', () => {
        for (const offset of [-1, 0.5, NaN, Infinity, 1, 15, Number.MAX_SAFE_INTEGER + 1, '0']) {
            expect(() =>
                decodeTargetServiceResponseBasic(new Uint8Array(14), offset as number),
            ).toThrow(failure);
        }

        let calls = 0;
        const proxy = new Proxy(new Uint8Array(14), {
            get() {
                calls++;
                throw new Error('SECRET');
            },
        });
        const revoked = Proxy.revocable(new Uint8Array(14), {});
        revoked.revoke();
        const fake = Object.defineProperty({}, 'byteLength', {
            get() {
                calls++;
                throw new Error('SECRET');
            },
        });
        const detached = new Uint8Array(14);
        structuredClone(detached, { transfer: [detached.buffer] });
        const resizable = new ArrayBuffer(20, { maxByteLength: 32 });
        const outOfBounds = new Uint8Array(resizable, 4, 14);
        resizable.resize(4);
        const foreignShared = runInNewContext(
            'new Uint8Array(new SharedArrayBuffer(14))',
        ) as Uint8Array;

        for (const value of [
            proxy,
            revoked.proxy,
            fake,
            new Uint8Array(new SharedArrayBuffer(14)),
            foreignShared,
            detached,
            outOfBounds,
            new Uint16Array(14),
            new DataView(new ArrayBuffer(14)),
            null,
        ]) {
            expect(() => decodeTargetServiceResponseBasic(value as never)).toThrow(failure);
        }

        expect(calls).toBe(0);
    });
});
