import { describe, expect, it } from 'vitest';
import { qqTeaDecrypt } from '../../src/direct/qq-tea';
import { createWtEcdh } from '../../src/direct/wt-ecdh';
import {
    encodeWtLoginRequestBody,
    type WtLoginRequestBody,
} from '../../src/direct/wt-login-request';
import { encodeWtPcLoginOicqRequest } from '../../src/direct/wt-oicq';
import { decodeWtTlv } from '../../src/direct/wt-tlv';

// Synthetic local fixture, not a capture or proof of compatibility with the
// target client/server. Business bytes are independently hand-assembled in
// wt-login-request.test.ts; its nested ciphertext uses a separate TEA oracle.
const nestedCipher =
    '955abf5506096bacac66692532a868cf9a458f0e4e1550f29969d3780269e28c' +
    '901f9640f813df993361ec495f4aecbbd7fd0ce9b7c5b05dd6bc3d261f9a2abb' +
    '06b497ce0a6cf78a';
const expectedBody = Buffer.from(
    [
        '0009000f',
        '01060002dead',
        '01440048' + nestedCipher,
        '0116000a00010203040506070800',
        '014200050000000170',
        '01450002aabb',
        '001800160000000000050000000000001f410102030400000000',
        '0141000f00000007556e6b6e6f776e00000000',
        '017700080100000000000173',
        '0191000100',
        '01000016000000000005112233445566778800001234090a0b0c',
        '0107000600010d000001',
        '03180000',
        '016a0002beef',
        '0166000105',
        '0521000d0000001300076261736963696d',
    ].join(''),
    'hex',
);
const nestedBody = Buffer.from(
    '0004016e0001440147000b112233440001760002ccdd' +
        '0128001200000000000000000000014c0002aabb0000' +
        '0124000c000102030405060708090a0b',
    'hex',
);
const tgtgtKey = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const randomKey = Buffer.from('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff', 'hex');

function fixtureRandom(length: number): Uint8Array {
    const result = new Uint8Array(length);
    result[0] = 0xf8;
    return result;
}

function scalar(value: number): Uint8Array {
    const result = new Uint8Array(24);
    result[23] = value;
    return result;
}

function fixture(): WtLoginRequestBody {
    return {
        uin: 0x01020304,
        appId: 0x11223344,
        subAppId: 0x55667788,
        appClientVersion: 0x1234,
        mainSigMap: 0x090a0b0c,
        miscBitMap: 0x01020304,
        subSigMap: 0x05060708,
        packageName: 'p',
        ptVersion: 'v',
        sdkVersion: 's',
        os: 'L',
        deviceName: 'D',
        guid: Buffer.from('aabb', 'hex'),
        apkSignature: Buffer.from('ccdd', 'hex'),
        temporaryA1: Buffer.from('dead', 'hex'),
        noPicSig: Buffer.from('beef', 'hex'),
        tgtgtKey: Buffer.from(tgtgtKey),
        tlv124Value: Buffer.from('000102030405060708090a0b', 'hex'),
        randomSource: fixtureRandom,
    };
}

describe('offline PC login body and OICQ composition', () => {
    it('encodes the complete body and opens the 0x810 envelope with the peer ECDH context', () => {
        const input = fixture();
        const client = createWtEcdh(scalar(1));
        const peer = createWtEcdh(scalar(2));
        const business = encodeWtLoginRequestBody(input);
        expect(Buffer.from(business)).toEqual(expectedBody);
        const oicq = Buffer.from(
            encodeWtPcLoginOicqRequest({
                uin: BigInt(input.uin),
                clientVersion: input.appClientVersion,
                body: business,
                ecdh: client,
                peerPublicKey: peer.publicKey,
                randomKey,
                randomSource: fixtureRandom,
            }),
        );
        const cipherLength = Math.ceil((expectedBody.length + 10) / 8) * 8;
        expect(oicq.length).toBe(74 + cipherLength);
        expect(oicq.readUInt16BE(1)).toBe(oicq.length);
        expect(oicq.subarray(0, 26).toString('hex')).toBe(
            '02' +
                oicq.length.toString(16).padStart(4, '0') +
                '1f41081000000102030403870000000002000012340000',
        );
        expect(oicq.at(-1)).toBe(3);
        expect(oicq.subarray(26, 28)).toEqual(Buffer.from([1, 1]));
        expect(oicq.subarray(28, 44)).toEqual(randomKey);
        expect(oicq.readUInt16BE(44)).toBe(0x102);
        expect(oicq.readUInt16BE(46)).toBe(25);
        const clientPoint = oicq.subarray(48, 73);
        expect(clientPoint).toEqual(Buffer.from(client.publicKey));
        const peerKey = peer.deriveTeaKey(clientPoint);
        expect(peerKey).toEqual(client.deriveTeaKey(peer.publicKey));
        const decoded = qqTeaDecrypt(oicq.subarray(73, -1), peerKey);
        expect(Buffer.from(decoded)).toEqual(expectedBody);
        expect(Buffer.from(decoded.subarray(0, 4)).toString('hex')).toBe('0009000f');
        const entries = decodeWtTlv(decoded.subarray(2));
        expect(entries.map(({ tag }) => tag)).toEqual([
            0x106, 0x144, 0x116, 0x142, 0x145, 0x018, 0x141, 0x177, 0x191, 0x100, 0x107, 0x318,
            0x16a, 0x166, 0x521,
        ]);
        expect(Buffer.from(entries[0].value)).toEqual(Buffer.from('dead', 'hex')); // temporary A1, not returned A1
        expect(Buffer.from(entries[12].value)).toEqual(Buffer.from('beef', 'hex')); // temporary noPicSig
        expect(Buffer.from(qqTeaDecrypt(entries[1].value, tgtgtKey))).toEqual(nestedBody);
    });

    it('retains snapshots across both stages and randomized outer padding', () => {
        const input = fixture();
        const client = createWtEcdh(scalar(1));
        const peer = createWtEcdh(scalar(2));
        const peerPoint = peer.publicKey;
        const peerCopy = Uint8Array.from(peerPoint);
        const body = encodeWtLoginRequestBody(input);
        const bodyBefore = Uint8Array.from(body);
        const originalA1 = Uint8Array.from(input.temporaryA1);
        const originalNoPic = Uint8Array.from(input.noPicSig);
        const originalKey = Uint8Array.from(input.tgtgtKey);
        const outerKey = Uint8Array.from(randomKey);
        const peerForRequest = Uint8Array.from(peerPoint);
        const first = encodeWtPcLoginOicqRequest({
            uin: BigInt(input.uin),
            clientVersion: input.appClientVersion,
            body,
            randomKey: outerKey,
            ecdh: client,
            peerPublicKey: peerForRequest,
            randomSource: (n) => new Uint8Array(n).fill(0x11),
        });
        const saved = Uint8Array.from(first);
        const second = encodeWtPcLoginOicqRequest({
            uin: BigInt(input.uin),
            clientVersion: input.appClientVersion,
            body,
            randomKey: outerKey,
            ecdh: client,
            peerPublicKey: peerForRequest,
            randomSource: (n) => new Uint8Array(n).fill(0x22),
        });
        expect(first).not.toEqual(second);
        expect(Uint8Array.from(body)).toEqual(bodyBefore);
        expect(input.temporaryA1).toEqual(Buffer.from(originalA1));
        expect(input.noPicSig).toEqual(Buffer.from(originalNoPic));
        expect(input.tgtgtKey).toEqual(Buffer.from(originalKey));
        input.temporaryA1.fill(0);
        input.noPicSig.fill(0);
        input.tgtgtKey.fill(0);
        input.guid.fill(0);
        input.tlv124Value.fill(0);
        body.fill(0);
        outerKey.fill(0);
        peerForRequest.fill(0);
        client.publicKey.fill(0);
        expect(Uint8Array.from(first)).toEqual(saved);

        for (const packet of [first, second]) {
            const frame = Buffer.from(packet);
            const payload = qqTeaDecrypt(
                frame.subarray(73, -1),
                peer.deriveTeaKey(frame.subarray(48, 73)),
            );
            expect(Buffer.from(payload)).toEqual(expectedBody);
            const entries = decodeWtTlv(payload.subarray(2));
            expect(entries[0].value).toEqual(originalA1);
            expect(entries[12].value).toEqual(originalNoPic);
            expect(Buffer.from(qqTeaDecrypt(entries[1].value, originalKey))).toEqual(nestedBody);
        }

        expect(peerPoint).toEqual(peerCopy);
    });
});
