import { createECDH, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createKeyExchangeFlow } from '../../src/direct/key-exchange-flow';
import { qqTeaDecrypt } from '../../src/direct/qq-tea';

// Synthetic fixtures only: no client, service, or network connection is created.
function fixture() {
    const server = createECDH('prime256v1');
    server.generateKeys();

    return {
        uin: '123456',
        guid: Uint8Array.of(1, 2, 3, 4),
        version: 'fixture-version',
        subAppId: 1234,
        reserved: Uint8Array.of(5, 6),
        sequence: 123,
        serverPublicKey: server.getPublicKey(),
        verifyKey: randomBytes(32),
        timestamp: 1700000000,
        verifyServerResponse: () => true,
    };
}

function requestA2(frameBytes: Uint8Array, uin: string): Buffer {
    const frame = Buffer.from(frameBytes);
    expect(frame.readUInt32BE(0)).toBe(frame.length);
    expect(frame.readInt32BE(4)).toBe(12);
    expect(frame[8]).toBe(2);

    const d2Length = frame.readUInt32BE(9);
    expect(d2Length).toBe(4);
    const dummyOffset = 9 + d2Length;
    expect(frame[dummyOffset]).toBe(0);
    const uinOffset = dummyOffset + 1;
    const uinLength = frame.readUInt32BE(uinOffset);
    expect(uinLength).toBe(Buffer.byteLength(uin, 'ascii') + 4);
    const bodyOffset = uinOffset + uinLength;
    expect(frame.subarray(uinOffset + 4, bodyOffset).toString('ascii')).toBe(uin);
    expect(bodyOffset).toBeLessThan(frame.length);

    const sso = Buffer.from(qqTeaDecrypt(frame.subarray(bodyOffset), new Uint8Array(16)));
    const headerLength = sso.readUInt32BE(0);
    expect(headerLength).toBeLessThanOrEqual(sso.length);
    expect(headerLength).toBeGreaterThanOrEqual(32);
    const a2Length = sso.readUInt32BE(28);
    expect(a2Length).toBeGreaterThanOrEqual(4);
    expect(28 + a2Length).toBeLessThanOrEqual(headerLength);
    return sso.subarray(32, 28 + a2Length);
}

describe('synthetic key exchange request A2', () => {
    const cases: [string, Uint8Array | undefined][] = [
        ['omitted', undefined],
        ['empty', Uint8Array.of()],
        ['one zero byte', Uint8Array.of(0)],
        ['one nonzero byte', Uint8Array.of(0xff)],
        ['binary bytes', Uint8Array.of(0, 0xff, 0x80, 1, 0, 0x7f)],
    ];

    it.each(cases)('encodes %s A2 inside the zero-key request', (_name, a2) => {
        const base = fixture();
        const input = a2 === undefined ? base : { ...base, a2 };
        const guid = Uint8Array.from(base.guid);
        const reserved = Uint8Array.from(base.reserved);
        const serverPublicKey = Uint8Array.from(base.serverPublicKey);
        const verifyKey = Uint8Array.from(base.verifyKey);
        const expectedA2 = Uint8Array.from(a2 ?? []);
        const originalValues = {
            uin: base.uin,
            version: base.version,
            subAppId: base.subAppId,
            sequence: base.sequence,
            timestamp: base.timestamp,
            verifyServerResponse: base.verifyServerResponse,
        };

        const flow = createKeyExchangeFlow(input);
        expect(requestA2(flow.request, base.uin)).toEqual(Buffer.from(expectedA2));
        expect(base).toMatchObject(originalValues);
        expect(base.guid).toEqual(guid);
        expect(base.reserved).toEqual(reserved);
        expect(Uint8Array.from(base.serverPublicKey)).toEqual(serverPublicKey);
        expect(Uint8Array.from(base.verifyKey)).toEqual(verifyKey);

        if (a2 !== undefined) {
            expect(a2).toEqual(expectedA2);
        }
    });

    it.each([null, 'a2', 1, [], {}, new ArrayBuffer(1)])(
        'rejects non-Uint8Array A2 immediately: %s',
        (a2) => {
            expect(() =>
                createKeyExchangeFlow({ ...fixture(), a2: a2 as unknown as Uint8Array }),
            ).toThrow();
        },
    );
});
