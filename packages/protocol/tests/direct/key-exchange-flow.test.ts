import { createCipheriv, createDecipheriv, createECDH, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createKeyExchangeFlow, KEY_EXCHANGE_COMMAND } from '../../src/direct/key-exchange-flow';
import {
    decodeKeyExchangeRequest,
    decodeKeyExchangeRequestBuf,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
} from '../../src/direct/key-exchange-protobuf';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';

// All peers and credentials below are generated in-process; no network or QQ client is used.
const uin = '123456';
const sequence = 123;
const guid = Uint8Array.of(1, 2, 3, 4);
const timestamp = 1700000000;

function field(data: Uint8Array): Buffer {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length + 4);
    return Buffer.concat([head, data]);
}

function int(value: number): Buffer {
    const result = Buffer.alloc(4);
    result.writeInt32BE(value);
    return result;
}

function decrypt(encoded: Uint8Array, key: Uint8Array): Buffer {
    const data = Buffer.from(encoded);
    const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]);
}

function encrypt(plain: Uint8Array, key: Uint8Array): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function fixture() {
    const server = createECDH('prime256v1');
    server.generateKeys();
    const verifyKey = randomBytes(32);
    const input = {
        uin,
        guid,
        version: 'fixture-version',
        subAppId: 1234,
        reserved: Uint8Array.of(5, 6),
        sequence,
        serverPublicKey: server.getPublicKey(),
        verifyKey,
        timestamp,
        // Synthetic-only trust policy: this test peer has no server identity proof.
        verifyServerResponse: () => true,
    };
    const flow = createKeyExchangeFlow(input);
    const request = Buffer.from(flow.request);
    expect(request.readUInt32BE(0)).toBe(request.length);
    expect(request.readInt32BE(4)).toBe(12);
    expect(request[8]).toBe(2);
    expect(request.readUInt32BE(9)).toBe(4);
    expect(request[13]).toBe(0);
    const accountLength = request.readUInt32BE(14);
    expect(request.subarray(18, 14 + accountLength).toString()).toBe(uin);
    const sso = Buffer.from(qqTeaDecrypt(request.subarray(14 + accountLength), new Uint8Array(16)));
    let position = 4;
    expect(sso.readInt32BE(position)).toBe(sequence);
    position += 4;
    expect(sso.readInt32BE(position)).toBe(input.subAppId);
    position += 4;
    expect(sso.readInt32BE(position)).toBe(2052);
    position += 4 + 12;

    const readField = (width: 2 | 4 = 4): Buffer => {
        const length = width === 2 ? sso.readUInt16BE(position) : sso.readUInt32BE(position);
        const result = sso.subarray(position + width, position + length);
        position += length;
        return result;
    };

    expect(readField()).toHaveLength(0);
    expect(readField().toString()).toBe(KEY_EXCHANGE_COMMAND);
    expect(readField()).toHaveLength(0);
    expect(readField().toString()).toBe(Buffer.from(guid).toString('hex'));
    expect(readField()).toHaveLength(0);
    expect(readField(2).toString()).toBe(input.version);
    expect(readField()).toEqual(Buffer.from(input.reserved));
    expect(position).toBe(sso.readUInt32BE(0));
    const requestBody = decodeKeyExchangeRequest(readField());
    expect(position).toBe(sso.length);
    expect(requestBody.type).toBe(1);
    expect(requestBody.timestamp).toBe(BigInt(timestamp));
    const clientPublic = requestBody.publicKey!;
    const requestShared = server.computeSecret(clientPublic);
    expect(decodeKeyExchangeRequestBuf(decrypt(requestBody.secret!, requestShared))).toMatchObject({
        uin,
        guid: Buffer.from(guid),
    });
    const time = Buffer.alloc(4);
    time.writeUInt32BE(timestamp);
    const digest = createHash('sha256')
        .update(clientPublic)
        .update(int(1))
        .update(requestBody.secret!)
        .update(int(0))
        .update(time)
        .digest();
    expect(decrypt(requestBody.verifyHash!, verifyKey)).toEqual(digest);
    const responsePeer = createECDH('prime256v1');
    responsePeer.generateKeys();
    const responseKey = responsePeer.computeSecret(clientPublic);
    const sessionKey = randomBytes(16);
    const sessionTicket = randomBytes(24);

    function response(
        options: {
            account?: string;
            seq?: number;
            command?: string;
            code?: number;
            flag?: number;
            protocol?: number;
            tamper?: boolean;
            secret?: Uint8Array;
        } = {},
    ): Buffer {
        const plain =
            options.secret ??
            encodeKeyExchangeResponseSecret({ sessionKey, sessionTicket, expiration: 300 });
        const encrypted = encrypt(plain, responseKey);

        if (options.tamper) {
            encrypted[encrypted.length - 1] ^= 1;
        }

        const body = encodeKeyExchangeResponse({
            publicKey: responsePeer.getPublicKey(),
            secret: encrypted,
        });
        const head = Buffer.concat([
            int(options.seq ?? sequence),
            int(options.code ?? 0),
            field(Buffer.alloc(0)),
            field(Buffer.from(options.command ?? KEY_EXCHANGE_COMMAND)),
            field(Buffer.alloc(0)),
            int(0),
            field(Buffer.alloc(0)),
        ]);
        const ssoResponse = Buffer.concat([field(head), field(body)]);
        const flag = options.flag ?? 2;
        const payload =
            flag === 0 ? ssoResponse : Buffer.from(qqTeaEncrypt(ssoResponse, new Uint8Array(16)));
        const account = Buffer.from(options.account ?? uin);
        const result = Buffer.concat([
            int(0),
            int(options.protocol ?? 12),
            Buffer.from([flag, 0]),
            field(account),
            payload,
        ]);
        result.writeUInt32BE(result.length);
        return result;
    }

    return { flow, input, response, sessionKey, sessionTicket, requestBody };
}

describe('offline key exchange flow', () => {
    it('composes a complete request and consumes an independently encrypted response once', () => {
        const f = fixture();
        expect(f.flow.complete(f.response())).toEqual({
            sessionKey: Uint8Array.from(f.sessionKey),
            sessionTicket: Uint8Array.from(f.sessionTicket),
            expiration: 300,
        });
        expect(() => f.flow.complete(f.response())).toThrow(/consumed/);
    });

    it.each([
        ['account', { account: '654321' }, /account/],
        ['sequence', { seq: 124 }, /sequence/],
        ['command', { command: 'wrong' }, /command/],
        ['server error', { code: -42 }, /server error: -42/],
        ['authentication tag', { tamper: true }, /./],
        ['frame encryption', { flag: 0 }, /service frame/],
        ['frame protocol', { protocol: 13 }, /service frame/],
        ['missing key and ticket', { secret: Uint8Array.of() }, /sessionKey/],
        ['missing ticket', { secret: Uint8Array.of(0x0a, 1, 1) }, /sessionTicket/],
        ['missing key', { secret: Uint8Array.of(0x12, 1, 1) }, /sessionKey/],
    ])('rejects %s and consumes the attempt', (_name, options, error) => {
        const f = fixture();
        expect(() => f.flow.complete(f.response(options))).toThrow(error);
        expect(() => f.flow.complete(f.response())).toThrow(/consumed/);
    });

    it('requires the caller to verify the server response and supports cancellation', () => {
        const f = fixture();
        const rejected = createKeyExchangeFlow({ ...f.input, verifyServerResponse: () => false });
        expect(() => rejected.complete(f.response())).toThrow(/verification failed/);
        expect(() => rejected.complete(f.response())).toThrow(/consumed/);
        const cancelled = createKeyExchangeFlow(f.input);
        cancelled.cancel();
        expect(() => cancelled.complete(f.response())).toThrow(/consumed/);
        expect(() =>
            createKeyExchangeFlow({ ...f.input, verifyServerResponse: undefined as never }),
        ).toThrow(/verifier/);
    });

    it('validates caller inputs and generates fresh request keys and nonces', () => {
        const f = fixture();

        for (const change of [
            { uin: 'invalid' },
            { guid: new Uint8Array() },
            { reserved: null },
            { version: '' },
            { subAppId: -1 },
            { sequence: 0x80000000 },
            { timestamp: -1 },
            { serverPublicKey: new Uint8Array(65) },
            { verifyKey: new Uint8Array(31) },
        ]) {
            expect(() =>
                createKeyExchangeFlow({ ...f.input, ...change } as typeof f.input),
            ).toThrow();
        }

        const second = fixture();
        expect(f.requestBody.publicKey).not.toEqual(second.requestBody.publicKey);
        expect(f.requestBody.secret!.subarray(0, 12)).not.toEqual(
            second.requestBody.secret!.subarray(0, 12),
        );
        expect(f.requestBody.verifyHash!.subarray(0, 12)).not.toEqual(
            second.requestBody.verifyHash!.subarray(0, 12),
        );
    });
});
