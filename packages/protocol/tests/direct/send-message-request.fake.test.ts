import type {
    DirectSendMessageRequest,
    DirectSendRoutingHead,
} from '@snowluma/proto-defs/direct-send-message';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';

import {
    encodeDirectSendMessageRequest,
    type DirectSendMessageRequestInput,
} from '../../src/direct/send-message-request';

// Static candidates derived from LagrangeV2 7011cdf87368cc0fb77273c1508e779a52328165:
// NTSendMessage.cs, NTMessageCommon.cs, Elem.cs and MessagePacker.cs. The hex
// below is independently hand-assembled from field tags/lengths, not captured or
// independently validated against C# output or a live server.
const PRIVATE_WIRE = '0a070a050801120175120808011000180020001a0b0a0912070a050a0141620020012800';
const GROUP_WIRE = '0a0412020801120808011000180020001a0b0a0912070a050a0141620020012800';
const hex = (wire: Uint8Array) => Buffer.from(wire).toString('hex');
const bytes = (wire: string) => Uint8Array.from(Buffer.from(wire, 'hex'));

function privateInput(): DirectSendMessageRequestInput {
    return {
        route: { kind: 'private', peerUin: 1n, peerUid: 'u' },
        text: 'A',
        clientSequence: 1n,
        random: 0,
    };
}

function groupInput(): DirectSendMessageRequestInput {
    return { route: { kind: 'group', groupUin: 1n }, text: 'A', clientSequence: 1n, random: 0 };
}

function decode(wire: Uint8Array): DirectSendMessageRequest {
    return protobuf_decode<DirectSendMessageRequest>(wire);
}

function expectBody(
    wire: Uint8Array,
    text: string,
    sequence: bigint,
    random: number,
): DirectSendMessageRequest {
    const decoded = decode(wire);
    expect(decoded.contentHead).toEqual({ pkgNum: 1, pkgIndex: 0, divSeq: 0, autoReply: 0 });
    expect(decoded.clientSequence).toBe(sequence);
    expect(decoded.random).toBe(random);
    expect(decoded.messageBody.richText.elems).toHaveLength(1);
    expect(decoded.messageBody.richText.elems[0].text.text).toBe(text);
    expect(decoded.messageBody.richText.elems[0].text.pbReserve).toEqual(new Uint8Array());
    return decoded;
}

// Invalid ordinary data only; no security contract is assumed for hostile getters/proxies.
function invalid(value: unknown): void {
    const before = structuredClone(value);
    expect(() => encodeDirectSendMessageRequest(value as DirectSendMessageRequestInput)).toThrow();
    expect(value).toEqual(before);
}

describe('reference-only PbSendMsg text request', () => {
    it.each([
        ['private', privateInput, PRIVATE_WIRE],
        ['group', groupInput, GROUP_WIRE],
    ] as const)(
        'matches the independently hand-assembled %s wire and real Proton decode',
        (kind, make, expected) => {
            const input = make();
            const before = structuredClone(input);
            const wire = encodeDirectSendMessageRequest(input);
            expect(hex(wire)).toBe(expected);
            const decoded = expectBody(wire, 'A', 1n, 0);

            if (kind === 'private') {
                expect(decoded.routingHead.c2c).toEqual({ peerUin: 1n, peerUid: 'u' });
                expect(decoded.routingHead.group).toBeNull();
            } else {
                expect(decoded.routingHead.c2c).toBeNull();
                expect(decoded.routingHead.group).toEqual({ groupUin: 1n });
            }

            expect(input).toEqual(before);
            expect(decode(bytes(expected))).toEqual(decoded);
        },
    );

    it('preserves empty strings and explicit scalar zero fields in the private wire', () => {
        const input = {
            route: { kind: 'private' as const, peerUin: 1n, peerUid: '' },
            text: '',
            clientSequence: 0n,
            random: 0,
        };
        // Includes uid=empty, text=empty, reserve=empty, sequence=0, random=0.
        const expected = '0a060a0408011200120808011000180020001a0a0a0812060a040a00620020002800';
        const wire = encodeDirectSendMessageRequest(input);
        expect(hex(wire)).toBe(expected);
        const decoded = expectBody(wire, '', 0n, 0);
        expect(decoded.routingHead.c2c).toEqual({ peerUin: 1n, peerUid: '' });
        expect(decoded.routingHead.group).toBeNull();
    });

    it('round-trips both empty nested route messages through the real schema', () => {
        // Direct schema probe: an empty nested message is not an absent branch.
        for (const [value, expected, branch, other] of [
            [{ c2c: {} }, '0a00', 'c2c', 'group'],
            [{ group: {} }, '1200', 'group', 'c2c'],
        ] as const) {
            const wire = protobuf_encode<DirectSendRoutingHead>(value as DirectSendRoutingHead);
            expect(hex(wire)).toBe(expected);
            const decoded = protobuf_decode<DirectSendRoutingHead>(wire);
            expect(decoded[branch]).not.toBeNull();
            expect(decoded[other]).toBeNull();

            // Proton reports default scalar values for an empty nested message;
            // the exact empty wire above, rather than these values, establishes absence.
            if (branch === 'c2c') {
                expect(decoded.c2c).toEqual({ peerUin: 0n, peerUid: '' });
            } else {
                expect(decoded.group).toEqual({ groupUin: 0n });
            }
        }
    });

    it.each(['private', 'group'] as const)(
        'retains signed-int64 maximum route and uint64/uint32 maximum for %s',
        (kind) => {
            const route =
                kind === 'private'
                    ? { kind: 'private' as const, peerUin: 0x7fffffffffffffffn, peerUid: '账号🙂' }
                    : { kind: 'group' as const, groupUin: 0x7fffffffffffffffn };
            const input = {
                route,
                text: '中🙂\u0000',
                clientSequence: 0xffffffffffffffffn,
                random: 0xffffffff,
            };
            const before = structuredClone(input);
            const decoded = expectBody(
                encodeDirectSendMessageRequest(input),
                input.text,
                input.clientSequence,
                input.random,
            );

            if (kind === 'private') {
                expect(decoded.routingHead.c2c).toEqual({
                    peerUin: 0x7fffffffffffffffn,
                    peerUid: '账号🙂',
                });
                expect(decoded.routingHead.group).toBeNull();
            } else {
                expect(decoded.routingHead.group).toEqual({ groupUin: 0x7fffffffffffffffn });
                expect(decoded.routingHead.c2c).toBeNull();
            }

            expect(input).toEqual(before);
        },
    );

    it.each([
        ['text ASCII limit', 'text', 'a'.repeat(65536), true],
        ['text ASCII over limit', 'text', 'a'.repeat(65537), false],
        ['text UTF-8 limit', 'text', '🙂'.repeat(16384), true],
        ['text UTF-8 over limit', 'text', '🙂'.repeat(16384) + 'a', false],
        ['UID ASCII limit', 'peerUid', 'a'.repeat(1024), true],
        ['UID ASCII over limit', 'peerUid', 'a'.repeat(1025), false],
        ['UID UTF-8 limit', 'peerUid', '🙂'.repeat(256), true],
        ['UID UTF-8 over limit', 'peerUid', '🙂'.repeat(256) + 'a', false],
    ] as const)('validates %s by UTF-8 byte length', (_name, field, value, valid) => {
        const input = {
            route: {
                kind: 'private' as const,
                peerUin: 1n,
                peerUid: field === 'peerUid' ? value : 'u',
            },
            text: field === 'text' ? value : 'A',
            clientSequence: 1n,
            random: 0,
        };
        const before = structuredClone(input);

        if (valid) {
            const decoded = expectBody(encodeDirectSendMessageRequest(input), input.text, 1n, 0);

            if (input.route.kind === 'private') {
                expect(decoded.routingHead.c2c?.peerUid).toBe(input.route.peerUid);
            }
        } else {
            invalid(input);
        }

        expect(input).toEqual(before);
    });

    it.each(['\ud800', '\udfff', 'x\ud800y', '\udc00\ud800', '\ud800\ud800', '\udfff\udfff'])(
        'rejects unpaired surrogate in text or peer UID',
        (value) => {
            invalid({ ...privateInput(), text: value });
            invalid({ ...privateInput(), route: { kind: 'private', peerUin: 1n, peerUid: value } });
        },
    );

    it('rejects wrong scalar types, missing fields and values outside the specified ranges', () => {
        for (const bad of [
            null,
            undefined,
            1,
            'input',
            [],
            {},
            { ...privateInput(), route: null },
            { ...privateInput(), route: {} },
            { ...privateInput(), route: { kind: 'other', peerUin: 1n, peerUid: 'u' } },
        ]) {
            invalid(bad);
        }

        for (const value of [undefined, null, -1n, 0n, 0x8000000000000000n, 1, '1', NaN]) {
            invalid({
                ...privateInput(),
                route: { kind: 'private', peerUin: value, peerUid: 'u' },
            });
            invalid({ ...groupInput(), route: { kind: 'group', groupUin: value } });
        }

        for (const value of [undefined, null, -1n, 0x10000000000000000n, 1, '1', NaN]) {
            invalid({ ...privateInput(), clientSequence: value });
        }

        for (const value of [
            undefined,
            null,
            -1,
            0x100000000,
            1.5,
            NaN,
            Infinity,
            -Infinity,
            1n,
            '1',
        ]) {
            invalid({ ...privateInput(), random: value });
        }

        for (const value of [undefined, null, 1, 1n, {}, []]) {
            invalid({ ...privateInput(), text: value });
            invalid({ ...privateInput(), route: { kind: 'private', peerUin: 1n, peerUid: value } });
        }
    });

    it('does not mutate ordinary input or expose account/text contents in errors', () => {
        const uid = 'UID_SECRET_fixture';
        const text = 'TEXT_SECRET_fixture';
        const input = {
            route: { kind: 'private' as const, peerUin: 123456789n, peerUid: uid },
            text,
            clientSequence: 1n,
            random: -1,
        };
        const before = structuredClone(input);
        let error: unknown;

        try {
            encodeDirectSendMessageRequest(input);
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(Error);
        const message = String(error);
        expect(message).not.toContain(uid);
        expect(message).not.toContain(text);
        expect(message).not.toContain('123456789');
        expect(input).toEqual(before);
    });

    it('returns independent full backing buffers across adjacent synthetic requests', () => {
        const inputA = { ...privateInput(), text: 'synthetic A '.repeat(24), clientSequence: 11n };
        const inputB = { ...groupInput(), text: 'synthetic B '.repeat(24), clientSequence: 12n };
        const beforeA = structuredClone(inputA);
        const beforeB = structuredClone(inputB);
        const first = encodeDirectSendMessageRequest(inputA);
        const second = encodeDirectSendMessageRequest(inputB);

        for (const result of [first, second]) {
            expect(result.byteLength).toBeGreaterThanOrEqual(65);
            expect(result.byteLength).toBeLessThan(4096);
            expect(result.buffer).toBeInstanceOf(ArrayBuffer);
            expect(result.byteOffset).toBe(0);
            expect(result.buffer.byteLength).toBe(result.byteLength);
        }

        expect(first.buffer).not.toBe(second.buffer);
        const decodedA = expectBody(first, inputA.text, 11n, 0);
        const decodedB = expectBody(second, inputB.text, 12n, 0);
        expect(decodedA.routingHead.c2c).toEqual({ peerUin: 1n, peerUid: 'u' });
        expect(decodedA.routingHead.group).toBeNull();
        expect(decodedB.routingHead.c2c).toBeNull();
        expect(decodedB.routingHead.group).toEqual({ groupUin: 1n });
        const secondBefore = Uint8Array.from(second);
        const firstBuffer = first.buffer as ArrayBuffer;
        const firstLength = first.byteLength;

        // Mutate the entire backing buffer, not merely the returned view.
        new Uint8Array(firstBuffer).fill(0xa5);
        expect(second).toEqual(secondBefore);
        expectBody(second, inputB.text, 12n, 0);

        const transferred = structuredClone(firstBuffer, { transfer: [firstBuffer] });
        expect(firstBuffer.byteLength).toBe(0);
        expect(first.byteLength).toBe(0);
        expect(transferred.byteLength).toBe(firstLength);
        expect(second.buffer.byteLength).toBe(secondBefore.byteLength);
        expect(second).toEqual(secondBefore);
        expectBody(second, inputB.text, 12n, 0);
        expect(inputA).toEqual(beforeA);
        expect(inputB).toEqual(beforeB);
    });

    it('is deterministic and returns caller-owned bytes across repeated calls', () => {
        const input = privateInput();
        const before = structuredClone(input);
        const first = encodeDirectSendMessageRequest(input);
        const second = encodeDirectSendMessageRequest(input);
        expect(first).toEqual(second);
        expect(first).not.toBe(second);
        first[0] ^= 0xff;
        expect(hex(second)).toBe(PRIVATE_WIRE);
        expect(hex(encodeDirectSendMessageRequest(input))).toBe(PRIVATE_WIRE);
        expect(input).toEqual(before);
    });
});
