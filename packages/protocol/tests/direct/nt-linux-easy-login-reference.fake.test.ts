import { createCipheriv, createDecipheriv } from 'node:crypto';
import type {
    LinuxNTEasyLoginReferenceRequestBody,
    LinuxNTEasyLoginReferenceResponseBody,
    LinuxNTLoginReferenceCommon,
    LinuxNTLoginReferenceForward,
    NTLoginForwardRequest,
} from '@snowluma/proto-defs/direct-login';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';
import {
    decodeLinuxNTEasyLoginReferenceResponse,
    encodeLinuxNTEasyLoginReferenceRequest,
} from '../../src/direct/nt-linux-easy-login-reference';
import { encodeLinuxNTLoginReferenceRequest } from '../../src/direct/nt-linux-login-reference';
import { decodeLinuxNTLoginReferenceResponse } from '../../src/direct/nt-linux-login-response-reference';

// Synthetic fixtures only. V2 reference revision 7011cdf: EasyLoginService.cs
// request A1 #1; NTLogin.cs response tickets #1 and ticket bytes #3, #4, #5, #6.
// Local strict wire/input rules are not claims about the upstream decoder.
const h = (value: string): Buffer => Buffer.from(value, 'hex');
const join = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);
const limit = 1024 * 1024;
const absent = { ticketsPresent: false, a1: null, a2: null, d2: null, d2Key: null };
const emptyTickets = { ...absent, ticketsPresent: true };

function varint(value: number): Buffer {
    const output: number[] = [];

    do {
        const low = value % 128;
        value = Math.floor(value / 128);
        output.push(low | (value ? 0x80 : 0));
    } while (value);

    return Buffer.from(output);
}

function field(number: number, value: Uint8Array): Buffer {
    return join(varint(number * 8 + 2), varint(value.length), value);
}

function expectRejected(input: Uint8Array): void {
    const before = Uint8Array.from(input);
    expect(() => decodeLinuxNTEasyLoginReferenceResponse(input)).toThrow();
    expect(Uint8Array.from(input)).toEqual(before);
}

describe('Linux NT EasyLogin reference projection (synthetic offline fixtures)', () => {
    it('encodes exactly request field 1, matches Proton and a literal wire vector, and leaves input untouched', () => {
        const backing = h('aa00ff1020bb');
        const a1 = backing.subarray(1, 5);
        const before = Buffer.from(backing);
        const request = encodeLinuxNTEasyLoginReferenceRequest(a1);
        expect(Buffer.from(request)).toEqual(h('0a0400ff1020'));
        expect(request).toEqual(protobuf_encode<LinuxNTEasyLoginReferenceRequestBody>({ a1 }));
        expect(protobuf_decode<LinuxNTEasyLoginReferenceRequestBody>(request).a1).toEqual(
            Uint8Array.from(a1),
        );
        expect(backing).toEqual(before);
        request.fill(0);
        expect(backing).toEqual(before);
        expect(Buffer.from(encodeLinuxNTEasyLoginReferenceRequest(a1))).toEqual(h('0a0400ff1020'));
        expect(() => encodeLinuxNTEasyLoginReferenceRequest(new Uint8Array())).toThrow();
        const largest = new Uint8Array(limit - 4).fill(0x5a);
        const largestBefore = Uint8Array.from(largest);
        const maxRequest = encodeLinuxNTEasyLoginReferenceRequest(largest);
        expect(maxRequest.length).toBe(limit);
        expect(Buffer.from(maxRequest.subarray(0, 4))).toEqual(h('0afcff3f'));
        expect(largest).toEqual(largestBefore);
        expect(() => encodeLinuxNTEasyLoginReferenceRequest(new Uint8Array(limit - 3))).toThrow();
        expect(() => encodeLinuxNTEasyLoginReferenceRequest(new Uint8Array(limit + 1))).toThrow();
    });

    it('distinguishes missing tickets, an empty tickets message and each present-empty ticket', () => {
        expect(decodeLinuxNTEasyLoginReferenceResponse(h(''))).toEqual(absent);
        expect(decodeLinuxNTEasyLoginReferenceResponse(h('0a00'))).toEqual(emptyTickets);
        const cases = [
            ['0a021a00', 'a1'],
            ['0a022200', 'a2'],
            ['0a022a00', 'd2'],
            ['0a023200', 'd2Key'],
        ] as const;

        for (const [wire, name] of cases) {
            expect(decodeLinuxNTEasyLoginReferenceResponse(h(wire))).toEqual({
                ...emptyTickets,
                [name]: new Uint8Array(),
            });
        }

        const wire = h('0a0e1a02000122002a01ff3203aabbcc');
        const expected = {
            ticketsPresent: true,
            a1: Uint8Array.of(0, 1),
            a2: new Uint8Array(),
            d2: Uint8Array.of(0xff),
            d2Key: Uint8Array.of(0xaa, 0xbb, 0xcc),
        };
        expect(decodeLinuxNTEasyLoginReferenceResponse(wire)).toEqual(expected);
        expect(
            Buffer.from(
                protobuf_encode<LinuxNTEasyLoginReferenceResponseBody>({
                    tickets: {
                        a1: expected.a1,
                        a2: expected.a2,
                        d2: expected.d2,
                        d2Key: expected.d2Key,
                    },
                }),
            ),
        ).toEqual(wire);
    });

    it('accepts repeated unknown byte payloads as opaque, including invalid UTF-8 and protobuf', () => {
        const inner = join(h('1a01aa'), field(7, h('ff00')), field(7, h('c328')), h('4001'));
        const wire = join(field(1, inner), field(8, h('ff')), field(8, h('0b00')));
        expect(decodeLinuxNTEasyLoginReferenceResponse(wire)).toEqual({
            ...emptyTickets,
            a1: Uint8Array.of(0xaa),
        });
    });

    it('rejects wrong wires and duplicate singular fields at both levels', () => {
        for (const wire of ['0801', '0a000a00', '0a000801', '08010a00']) {
            expectRejected(h(wire));
        }

        for (const number of [3, 4, 5, 6]) {
            const proper = field(number, h('aa'));
            const wrong = join(varint(number * 8), h('01'));

            for (const inner of [
                wrong,
                join(proper, proper),
                join(proper, wrong),
                join(wrong, proper),
            ]) {
                expectRejected(field(1, inner));
            }
        }
    });

    it('rejects noncanonical tags, lengths and values, overflow, field zero, groups and truncation', () => {
        for (const wire of [
            '00',
            '03',
            '04',
            '0b',
            '0c',
            '0f',
            '8a0000',
            '0a800000',
            '388000',
            '38ffffffffffffffffff02',
            'ffffffffffffffffffff02',
            '80',
            '0a',
            '0a01',
            '0a0201',
            '0a011a',
            '0a021a01',
            '0a031a0201',
            '0a031a02011200', // the following outer field is outside the nested frame
            '0a020b0c',
            '0a020000',
            '0a023880',
        ]) {
            expectRejected(h(wire));
        }
    });

    it('accepts 256 fields per frame independently and rejects field 257', () => {
        const unknown = (count: number) => h('3800'.repeat(count));
        expect(decodeLinuxNTEasyLoginReferenceResponse(unknown(256))).toEqual(absent);
        expectRejected(unknown(257));
        const nested = field(1, unknown(256));
        expect(decodeLinuxNTEasyLoginReferenceResponse(nested)).toEqual(emptyTickets);
        expectRejected(field(1, unknown(257)));
        expect(
            decodeLinuxNTEasyLoginReferenceResponse(join(field(1, unknown(256)), unknown(255))),
        ).toEqual(emptyTickets);
        expectRejected(join(field(1, unknown(256)), unknown(256)));
    });

    it('accepts exactly one MiB of response input and rejects larger input', () => {
        // field #7 with 3-byte length prefix plus one-byte tag.
        const atLimit = field(7, new Uint8Array(limit - 4));
        expect(atLimit.length).toBe(limit);
        expect(decodeLinuxNTEasyLoginReferenceResponse(atLimit)).toEqual(absent);
        expectRejected(join(atLimit, h('3800')));
    });

    it('rejects proxy, shared, detached and resizable views in both APIs without invoking traps', () => {
        let called = 0;
        const proxy = new Proxy(Uint8Array.of(1), {
            get() {
                called++;
                throw new Error('trap');
            },
        });
        const detachedBuffer = new ArrayBuffer(4);
        const detached = new Uint8Array(detachedBuffer);
        structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
        const resizable = new Uint8Array(new ArrayBuffer(4, { maxByteLength: 8 }));
        const shared = new Uint8Array(new SharedArrayBuffer(4));

        for (const candidate of [proxy, shared, detached, resizable]) {
            expect(() => encodeLinuxNTEasyLoginReferenceRequest(candidate)).toThrow();
            expect(() => decodeLinuxNTEasyLoginReferenceResponse(candidate)).toThrow();
        }

        expect(called).toBe(0);
        expect(Buffer.from(encodeLinuxNTEasyLoginReferenceRequest(Uint8Array.of(1)))).toEqual(
            h('0a0101'),
        );
        expect(decodeLinuxNTEasyLoginReferenceResponse(h('0a00'))).toEqual(emptyTickets);
    });

    it('respects Buffer offsets, preserves caller storage on success and failure, and returns independent outputs', () => {
        const wire = h('0a0c1a01aa2201bb2a01cc3201dd');
        const backing = join(h('abcd'), wire, h('ef'));
        const view = backing.subarray(2, -1);
        const before = Buffer.from(backing);
        const first = decodeLinuxNTEasyLoginReferenceResponse(view);
        const second = decodeLinuxNTEasyLoginReferenceResponse(view);
        expect(backing).toEqual(before);
        expect(first).toEqual({
            ticketsPresent: true,
            a1: Uint8Array.of(0xaa),
            a2: Uint8Array.of(0xbb),
            d2: Uint8Array.of(0xcc),
            d2Key: Uint8Array.of(0xdd),
        });
        first.a1![0] = 0;
        expect(first.a2).toEqual(Uint8Array.of(0xbb));
        expect(second.a1).toEqual(Uint8Array.of(0xaa));
        expect(backing).toEqual(before);
        backing.fill(0);
        expect(second.d2Key).toEqual(Uint8Array.of(0xdd));
        const malformed = h('aa0a021a01bb');
        const snapshot = Buffer.from(malformed);
        expectRejected(malformed.subarray(1, -1));
        expect(malformed).toEqual(snapshot);
    });

    it.each([0, 1])(
        'composes request and explicitly consumes decrypted body for status %i',
        (code) => {
            const secret = Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i);
            const requestNonce = h('000102030405060708090a0b');
            const responseNonce = h('101112131415161718191a1b');
            const a1 = h('00ff1020');
            const loginBody = encodeLinuxNTEasyLoginReferenceRequest(a1);
            expect(Buffer.from(loginBody)).toEqual(h('0a0400ff1020'));
            const input = {
                sessionKey: secret,
                sessionTicket: h('aa01'),
                nonce: requestNonce,
                loginBody,
                account: '123456',
                deviceName: 'fixture-device',
                deviceType: 'fixture-pc',
                guid: h('01020304'),
                version: '1.2.3',
                appId: 42,
                appName: 'fixture-app',
                qua: 'fixture-qua',
            };
            const snapshots = [
                secret,
                requestNonce,
                a1,
                loginBody,
                input.sessionTicket,
                input.guid,
            ].map((value) => Uint8Array.from(value));
            const request = encodeLinuxNTLoginReferenceRequest(input);
            const forward = protobuf_decode<LinuxNTLoginReferenceForward>(request);
            const wrapped = forward.buffer;
            const decipher = createDecipheriv('aes-128-gcm', secret, wrapped.subarray(0, 12));
            decipher.setAuthTag(wrapped.subarray(-16));
            const requestPlain = join(decipher.update(wrapped.subarray(12, -16)), decipher.final());
            expect(
                Uint8Array.from(protobuf_decode<LinuxNTLoginReferenceCommon>(requestPlain).body),
            ).toEqual(loginBody);

            const responseBody = h('0a0c1a01aa2201bb2a01cc3201dd');
            const error = h(code === 0 ? '0800' : '0801');
            const common = join(field(1, field(4, error)), field(2, responseBody));
            const cipher = createCipheriv('aes-128-gcm', secret, responseNonce);
            const encrypted = join(
                responseNonce,
                cipher.update(common),
                cipher.final(),
                cipher.getAuthTag(),
            );
            const outer = protobuf_encode<NTLoginForwardRequest>({ buffer: encrypted });
            const response = decodeLinuxNTLoginReferenceResponse({
                forward: outer,
                sessionKey: secret,
            });
            expect(response.status).toEqual({
                kind: 'code',
                code: BigInt(code),
                codePresent: true,
            });
            expect(response.body).toEqual(Uint8Array.from(responseBody));

            if (response.body === null) {
                throw new Error('fixture body must be present');
            }

            // Explicit consumer policy: inspect body only for code 0; nonzero is a
            // separate error path and never establishes authenticated login state.
            let consumed = false;

            if (response.status.kind === 'code' && response.status.code === 0n) {
                const projected = decodeLinuxNTEasyLoginReferenceResponse(response.body);
                consumed = true;
                expect(projected).toEqual({
                    ticketsPresent: true,
                    a1: Uint8Array.of(0xaa),
                    a2: Uint8Array.of(0xbb),
                    d2: Uint8Array.of(0xcc),
                    d2Key: Uint8Array.of(0xdd),
                });
                response.body.fill(0);
                expect(projected.a1).toEqual(Uint8Array.of(0xaa));
            }

            expect(consumed).toBe(code === 0);
            expect(
                [secret, requestNonce, a1, loginBody, input.sessionTicket, input.guid].map(
                    (value) => Uint8Array.from(value),
                ),
            ).toEqual(snapshots);
            // GCM validates this synthetic ciphertext only; the outer ticket, peer
            // identity, expiry and ticket acceptance have not been authenticated.
        },
    );
});
