import { describe, expect, it } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { bytes, pb } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbUserInfoRequest } from '@snowluma/proto-defs/oidb-actions/base';

import { makeOidbEnvelope } from '../../../src/bridge-oidb';
import { FetchUserProfile } from '../../../src/oidb-services/contacts/fetch-user-profile';

// Field 4 is the same length-delimited body as in OidbBase, exposed as
// bytes so its field-1 tag and value can be checked independently of decoding.
interface RawEnvelope {
    body?: pb<4, bytes>;
}

function encodeRequest(uin: number): Uint8Array {
    // serialize currently ignores its context; no sender is created or called.
    const body = FetchUserProfile.serialize(undefined as unknown as FetchUserProfile.Deps, { uin });
    expect(body.uin).toBe(uin);
    return FetchUserProfile.encode(
        makeOidbEnvelope(
            FetchUserProfile.command,
            FetchUserProfile.subCommand,
            body,
            FetchUserProfile.uinForm,
        ),
    );
}

describe('FetchUserProfile local UIN uint32 encoding', () => {
    it.each([
        [1, 1, [0x08, 0x01]],
        [4_294_967_295, 4_294_967_295, [0x08, 0xff, 0xff, 0xff, 0xff, 0x0f]],
        [4_294_967_296, 0, [0x08, 0x00]],
        [4_294_967_297, 1, [0x08, 0x01]],
    ])('encodes input %i as field 1 value %i', (input, expected, prefix) => {
        const encoded = encodeRequest(input);
        const envelope = protobuf_decode<OidbBase<OidbUserInfoRequest>>(encoded);
        const raw = protobuf_decode<RawEnvelope>(encoded);

        expect(envelope.command).toBe(FetchUserProfile.command);
        expect(envelope.subCommand).toBe(FetchUserProfile.subCommand);
        expect(envelope.reserved).toBe(1);
        expect(envelope.body?.uin).toBe(expected);
        expect(raw.body).toBeDefined();
        expect(Array.from(raw.body!.slice(0, prefix.length))).toEqual(prefix);
    });

    it('omits a literal zero field while the wrapped zero remains present', () => {
        const zeroBytes = encodeRequest(0);
        const wrappedBytes = encodeRequest(4_294_967_296);
        const zero = protobuf_decode<OidbBase<OidbUserInfoRequest>>(zeroBytes);
        const wrapped = protobuf_decode<OidbBase<OidbUserInfoRequest>>(wrappedBytes);
        const zeroBody = protobuf_decode<RawEnvelope>(zeroBytes).body;
        const wrappedBody = protobuf_decode<RawEnvelope>(wrappedBytes).body;

        // The next body field is the first repeated key (field 3, wire type 2).
        expect(zeroBody?.[0]).toBe(0x1a);
        expect(Array.from(wrappedBody!.slice(0, 2))).toEqual([0x08, 0x00]);
        expect(zero.body?.uin == null).toBe(true);
        expect(wrapped.body?.uin).toBe(0);
        expect(Array.from(wrappedBody!.slice(2))).toEqual(Array.from(zeroBody!));
    });

    it('produces identical bytes for 1 and 2^32 + 1', () => {
        expect(encodeRequest(4_294_967_297)).toEqual(encodeRequest(1));
    });
});
