import { describe, expect, it } from 'vitest';
import {
    buildKeyExchange,
    createP256KeyExchange,
    decryptKeyExchangeBytes,
    encryptKeyExchangeBytes,
} from '../../src/direct/key-exchange';
import {
    decodeKeyExchangeResponse,
    decodeKeyExchangeResponseSecret,
    encodeKeyExchangeRequest,
    encodeKeyExchangeRequestBuf,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
} from '../../src/direct/key-exchange-protobuf';

// Synthetic cryptographic test data and a manually derived protobuf fixture.
// The reference client was not run and this is not a captured QQ exchange.
const bytes = (hex: string) => Buffer.from(hex, 'hex');
const scalar = bytes('0000000000000000000000000000000000000000000000000000000000000001');
const server = bytes(
    '049d1423332735980edabe7e9ea451b3395b6f35250db8fc56f25889f628cbae3e' +
        '8e73077914071eeebc108f4e0170057792bb17aa303af652313d17c1ac815e79',
);
const verifyKey = bytes('e2733bf403149913cbf80c7a95168bd4ca6935ee53cd39764beebe2e007e3aee');

describe('offline key-exchange composition', () => {
    it('encodes the fixed request and decrypts a synthetic peer response', () => {
        const timestamp = 0x01020304;
        const secret = encodeKeyExchangeRequestBuf({ uin: '0', guid: bytes('00010203') });
        const request = buildKeyExchange(secret, server, verifyKey, timestamp, {
            privateKey: scalar,
            secretNonce: bytes('000102030405060708090a0b'),
            verifyNonce: bytes('101112131415161718191a1b'),
        });
        const wire = encodeKeyExchangeRequest({
            publicKey: request.publicKey,
            type: 1,
            secret: request.secret,
            timestamp: BigInt(timestamp),
            verifyHash: request.verifyHash,
        });
        expect(Buffer.from(wire).toString('hex')).toBe(
            '0a41046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296' +
                '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f510011a250001020304' +
                '05060708090a0b8b808eb03ee2c4151cc380c7b1b36e7c602fa9e5e05911c9eb' +
                '20848688082a3c101112131415161718191a1be39360d333c674395e7cd76d08' +
                'cee071a6732cf1639f6433ff9d507874c14ce711f10c9e3b87398e3c107e216d785648',
        );

        const peer = createP256KeyExchange(
            bytes('0000000000000000000000000000000000000000000000000000000000000002'),
        );
        const peerShared = peer.sharedSecret(request.publicKey);
        const contents = {
            sessionKey: bytes('01020304'),
            sessionTicket: bytes('aabbcc'),
            expiration: 300,
        };
        const encrypted = encryptKeyExchangeBytes(
            encodeKeyExchangeResponseSecret(contents),
            peerShared,
            bytes('202122232425262728292a2b'),
        );
        const encodedResponse = encodeKeyExchangeResponse({
            publicKey: peer.publicKey,
            secret: encrypted,
        });
        const decodedResponse = decodeKeyExchangeResponse(encodedResponse);
        expect(decodedResponse.publicKey).toBeDefined();
        expect(decodedResponse.secret).toBeDefined();
        const responseKey = request.deriveResponseSecret(decodedResponse.publicKey!);
        const decoded = decodeKeyExchangeResponseSecret(
            decryptKeyExchangeBytes(decodedResponse.secret!, responseKey),
        );
        expect(Buffer.from(decoded.sessionKey!)).toEqual(contents.sessionKey);
        expect(Buffer.from(decoded.sessionTicket!)).toEqual(contents.sessionTicket);
        expect(decoded.expiration).toBe(contents.expiration);
    });
});
