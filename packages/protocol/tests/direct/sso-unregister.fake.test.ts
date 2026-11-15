import type { SsoRegisterDevice } from '@snowluma/proto-defs/sso-register';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { int_32, pb_optional } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';
import {
    decodeSsoUnregisterReference,
    encodeSsoUnregisterReference,
    SSO_UNREGISTER_REFERENCE_COMMAND,
} from '../../src/direct/sso-unregister';

// Synthetic bytes derived from LagrangeV2 7011cdf87368cc0fb77273c1508e779a52328165,
// its generator and protobuf framing; these are not captured server messages.
const wire = (values: number[]): Uint8Array => Uint8Array.from(values);
const request = wire([8, 1, 18, 10, 10, 0, 18, 0, 26, 0, 34, 0, 42, 0, 24, 1]);
interface OptionalScalarFixture {
    value?: pb_optional<1, int_32>;
}
const decode = (values: number[]) => decodeSsoUnregisterReference(wire(values), 65536);

describe('synthetic reference-only unregister codec', () => {
    it('constructs the pinned fields and keeps each output independently transferable', () => {
        expect(SSO_UNREGISTER_REFERENCE_COMMAND).toBe(
            'trpc.qq_new_tech.status_svc.StatusService.UnRegister',
        );
        const first = encodeSsoUnregisterReference();
        const second = encodeSsoUnregisterReference();
        expect(first).toEqual(request);
        expect(second).toEqual(request);
        expect(first.buffer).not.toBe(second.buffer);
        expect(first.byteOffset).toBe(0);
        expect(first.buffer.byteLength).toBe(first.byteLength);
        first[0] ^= 0xff;
        expect(second).toEqual(request);
        structuredClone(first, { transfer: [first.buffer] });
        expect(second).toEqual(request);
        expect(encodeSsoUnregisterReference()).toEqual(request);
    });

    it('tests existing device optional presence independently of the request', () => {
        const empty = protobuf_encode<SsoRegisterDevice>({
            name: '',
            type: '',
            osVersion: '',
            brand: '',
            vendorOs: '',
        });
        expect(Array.from(empty)).toEqual([10, 0, 18, 0, 26, 0, 34, 0, 42, 0]);
        const single = protobuf_encode<SsoRegisterDevice>({ brand: '' });
        expect(Array.from(single)).toEqual([34, 0]);
        expect(protobuf_decode<SsoRegisterDevice>(single).brand).toBe('');
        expect(protobuf_decode<SsoRegisterDevice>(wire([])).brand).toBeNull();
    });

    it('distinguishes a present integer zero from absence', () => {
        const encoded = protobuf_encode<OptionalScalarFixture>({ value: 0 });
        expect(Array.from(encoded)).toEqual([8, 0]);
        expect(protobuf_decode<OptionalScalarFixture>(encoded).value).toBe(0);
        expect(protobuf_decode<OptionalScalarFixture>(wire([])).value).toBeNull();
    });

    it('observes top-level tag 2 including empty and absent, not tag 7', () => {
        expect(decode([])).toEqual({ presence: 'absent' });
        expect(decode([18, 0])).toEqual({ presence: 'present', text: '' });
        expect(decode([18, 1, 120])).toEqual({ presence: 'present', text: 'x' });
        expect(decode([58, 3, 18, 1, 120])).toEqual({ presence: 'absent' });
    });

    it('reflects Proton unknown and duplicate semantics without success inference', () => {
        expect(decode([72, 7])).toEqual({ presence: 'absent' });
        expect(decode([16, 1])).toEqual({ presence: 'absent' });
        expect(decode([18, 1, 97, 72, 7, 18, 1, 98])).toEqual({ presence: 'present', text: 'b' });
        expect(decode([18, 1, 97, 18, 0])).toEqual({ presence: 'present', text: '' });
        expect(decode([18, 2, 0xc3, 0x28])).toEqual({ presence: 'present', text: '\ufffd(' });
    });

    it('does not mutate input and rejects malformed framing with fixed errors', () => {
        const input = wire([18, 1, 120, 72, 7]);
        const before = input.slice();
        expect(decodeSsoUnregisterReference(input, input.length)).toEqual({
            presence: 'present',
            text: 'x',
        });
        expect(input).toEqual(before);
        const buffer = Buffer.from([18, 1, 121]);
        const bufferBefore = Uint8Array.from(buffer);
        expect(decodeSsoUnregisterReference(buffer, buffer.length)).toEqual({
            presence: 'present',
            text: 'y',
        });
        expect(Uint8Array.from(buffer)).toEqual(bufferBefore);

        for (const value of [[18], [18, 2, 97], [8, 128], [0], [11, 20]]) {
            expect(() => decode(value)).toThrowError('invalid unregister response');
        }
    });

    it('decodes nonzero-offset views without changing any backing bytes', () => {
        const backingArray = wire([0xa1, 0xa2, 18, 1, 120, 0xb1, 0xb2]);
        const backingBuffer = Buffer.allocUnsafeSlow(7);
        backingBuffer.set([0xc1, 0xc2, 18, 1, 121, 0xd1, 0xd2]);
        const fixtures = [
            { backing: backingArray, view: backingArray.subarray(2, 5), text: 'x' },
            { backing: backingBuffer, view: backingBuffer.subarray(2, 5), text: 'y' },
        ];

        for (const { backing, view, text } of fixtures) {
            expect(view.byteOffset).toBeGreaterThan(0);
            const fullBacking = new Uint8Array(backing.buffer);
            const before = Uint8Array.from(fullBacking);
            expect(decodeSsoUnregisterReference(view, 3)).toEqual({ presence: 'present', text });
            expect(fullBacking).toEqual(before);
        }
    });

    it('requires an explicit bounded cap and ordinary non-detached bytes', () => {
        for (const cap of [-1, 1.1, 65537, NaN, Infinity, undefined]) {
            expect(() => decodeSsoUnregisterReference(wire([]), cap as number)).toThrowError(
                'invalid unregister response',
            );
        }

        expect(() => decodeSsoUnregisterReference(wire([18, 0]), 1)).toThrowError(
            'invalid unregister response',
        );
        expect(decodeSsoUnregisterReference(wire([]), 0)).toEqual({ presence: 'absent' });
        expect(() => decodeSsoUnregisterReference(new Proxy(wire([]), {}), 0)).toThrowError(
            'invalid unregister response',
        );
        const revoked = Proxy.revocable(wire([]), {});
        revoked.revoke();
        expect(() => decodeSsoUnregisterReference(revoked.proxy, 0)).toThrowError(
            'invalid unregister response',
        );
        expect(() =>
            decodeSsoUnregisterReference(new Uint8Array(new SharedArrayBuffer(0)), 0),
        ).toThrowError('invalid unregister response');
        const detached = wire([18, 0]);
        structuredClone(detached, { transfer: [detached.buffer] });
        expect(() => decodeSsoUnregisterReference(detached, 0)).toThrowError(
            'invalid unregister response',
        );
        const resizable = new ArrayBuffer(4, { maxByteLength: 8 });
        const inBounds = new Uint8Array(resizable, 1, 2);
        expect(() => decodeSsoUnregisterReference(inBounds, 2)).toThrowError(
            'invalid unregister response',
        );
        const outOfBounds = new Uint8Array(resizable, 2, 2);
        resizable.resize(1);
        expect(() => decodeSsoUnregisterReference(outOfBounds, 0)).toThrowError(
            'invalid unregister response',
        );
        expect(() => decodeSsoUnregisterReference(new Uint8Array(resizable, 0, 0), 0)).toThrowError(
            'invalid unregister response',
        );
        expect(decodeSsoUnregisterReference(new Uint8Array(0), 0)).toEqual({ presence: 'absent' });
    });
});
