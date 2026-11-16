import { createCipheriv, createDecipheriv, createECDH, createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    KEY_EXCHANGE_COMMAND,
    prepareKeyExchangeFlow,
    type KeyExchangeFlowInput,
} from '../../src/direct/key-exchange-flow';
import {
    decodeKeyExchangeRequest,
    decodeKeyExchangeRequestBuf,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
} from '../../src/direct/key-exchange-protobuf';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';

// Synthetic in-process peers and bytes only. No transport or signer service is constructed.
type PreparedInput = Omit<KeyExchangeFlowInput, 'reserved'>;
const uin = '123456';
const sequence = 123;
const timestamp = 1700000000;

function peer(scalar: number) {
    const ecdh = createECDH('prime256v1');
    const key = Buffer.alloc(32);
    key[31] = scalar;
    ecdh.setPrivateKey(key);
    return ecdh;
}

function fixture() {
    const server = peer(1);
    const verify = vi.fn((_response: Parameters<PreparedInput['verifyServerResponse']>[0]) => true);
    const input: PreparedInput = {
        uin,
        guid: Uint8Array.of(1, 2, 3, 4),
        a2: Uint8Array.of(0, 0xff, 0x80, 3),
        version: 'synthetic-version',
        subAppId: 1234,
        sequence,
        serverPublicKey: Uint8Array.from(server.getPublicKey()),
        verifyKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
        timestamp,
        verifyServerResponse: verify,
    };
    return { input, server, verify };
}

function field(data: Uint8Array): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length + 4);
    return Buffer.concat([length, data]);
}

function int(value: number): Buffer {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32BE(value);
    return bytes;
}

function decryptGcm(encoded: Uint8Array, key: Uint8Array): Buffer {
    const bytes = Buffer.from(encoded);
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
}

function encryptGcm(plain: Uint8Array, key: Uint8Array): Buffer {
    const nonce = Buffer.alloc(12, 0x42);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function unpackRequest(frameBytes: Uint8Array) {
    const frame = Buffer.from(frameBytes);
    expect(frame.readUInt32BE(0)).toBe(frame.length);
    expect(frame.readInt32BE(4)).toBe(12);
    expect(frame[8]).toBe(2);
    expect(frame.readUInt32BE(9)).toBe(4); // outer D2 is empty
    expect(frame[13]).toBe(0);
    const accountLength = frame.readUInt32BE(14);
    expect(frame.subarray(18, 14 + accountLength).toString()).toBe(uin);
    const sso = Buffer.from(qqTeaDecrypt(frame.subarray(14 + accountLength), new Uint8Array(16)));
    let pos = 4;
    const seq = sso.readInt32BE(pos);
    pos += 4;
    const subAppId = sso.readInt32BE(pos);
    pos += 4;
    expect(sso.readInt32BE(pos)).toBe(2052);
    pos += 4 + 12;

    const readField = (width: 2 | 4 = 4): Buffer => {
        const length = width === 2 ? sso.readUInt16BE(pos) : sso.readUInt32BE(pos);
        expect(length).toBeGreaterThanOrEqual(width);
        expect(pos + length).toBeLessThanOrEqual(sso.length);
        const result = sso.subarray(pos + width, pos + length);
        pos += length;
        return result;
    };

    const a2 = readField();
    const command = readField().toString();
    expect(readField()).toHaveLength(0);
    const guid = readField().toString();
    expect(readField()).toHaveLength(0);
    const version = readField(2).toString();
    const reserved = readField();
    expect(pos).toBe(sso.readUInt32BE(0));
    const body = readField();
    expect(pos).toBe(sso.length);
    return { seq, subAppId, a2, command, guid, version, reserved, body };
}

function responseFor(requestBody: Uint8Array) {
    const request = decodeKeyExchangeRequest(requestBody);
    const responsePeer = peer(2);
    const responseKey = responsePeer.computeSecret(request.publicKey!);
    const sessionKey = Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i);
    const sessionTicket = Uint8Array.from({ length: 24 }, (_, i) => 0x60 + i);
    const secret = encodeKeyExchangeResponseSecret({ sessionKey, sessionTicket, expiration: 300 });
    const body = encodeKeyExchangeResponse({
        publicKey: responsePeer.getPublicKey(),
        secret: encryptGcm(secret, responseKey),
    });
    const head = Buffer.concat([
        int(sequence),
        int(0),
        field(Buffer.alloc(0)),
        field(Buffer.from(KEY_EXCHANGE_COMMAND)),
        field(Buffer.alloc(0)),
        int(0),
        field(Buffer.alloc(0)),
    ]);
    const sso = Buffer.concat([field(head), field(body)]);
    const frame = Buffer.concat([
        int(0),
        int(12),
        Buffer.from([2, 0]),
        field(Buffer.from(uin)),
        qqTeaEncrypt(sso, new Uint8Array(16)),
    ]);
    frame.writeUInt32BE(frame.length);
    return { frame, sessionKey, sessionTicket, publicKey: responsePeer.getPublicKey() };
}

function detachedBytes(): Uint8Array {
    const bytes = Uint8Array.of(9, 8, 7);
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    return bytes;
}

function resizableBytes(): Uint8Array {
    return new Uint8Array(new ArrayBuffer(4, { maxByteLength: 8 }));
}

function expectWiped(bytes: Uint8Array): void {
    expect(bytes).toEqual(new Uint8Array(bytes.length));
}

describe('prepared key exchange with synthetic peers', () => {
    it('freezes inputs across an asynchronous signer and binds the exact signed body to SSO', async () => {
        const { input, server, verify } = fixture();
        const originalGuid = Uint8Array.from(input.guid);
        const originalA2 = Uint8Array.from(input.a2!);
        const originalServerKey = Uint8Array.from(input.serverPublicKey);
        const originalVerifyKey = Uint8Array.from(input.verifyKey);
        const prepared = prepareKeyExchangeFlow(input);
        const signerBody = prepared.body;
        const signer = vi.fn(async (body: Uint8Array) => {
            const observed = Uint8Array.from(body);
            await Promise.resolve();
            return { observed, reserved: Uint8Array.of(0xaa, 0, 0xfe) };
        });
        const pending = signer(signerBody);
        input.guid.fill(0xee);
        input.a2!.fill(0xdd);
        input.serverPublicKey.fill(0xcc);
        input.verifyKey.fill(0xbb);
        input.uin = '987654';
        input.sequence = 999;
        input.version = 'changed';
        input.subAppId = 42;
        input.timestamp = 0;
        input.verifyServerResponse = () => false;
        const { observed, reserved } = await pending;
        const reservedCopy = Uint8Array.from(reserved);
        const flow = prepared.finish(reserved);
        expect(signer).toHaveBeenCalledOnce();
        expectWiped(signerBody);
        expect(reserved).toEqual(reservedCopy);
        expect(input.guid).toEqual(new Uint8Array(originalGuid.length).fill(0xee));
        expect(input.a2).toEqual(new Uint8Array(originalA2.length).fill(0xdd));
        expect(input.serverPublicKey).toEqual(new Uint8Array(originalServerKey.length).fill(0xcc));
        expect(input.verifyKey).toEqual(new Uint8Array(originalVerifyKey.length).fill(0xbb));
        const unpacked = unpackRequest(flow.request);
        expect(unpacked).toMatchObject({
            seq: sequence,
            subAppId: 1234,
            a2: Buffer.from(originalA2),
            command: KEY_EXCHANGE_COMMAND,
            guid: Buffer.from(originalGuid).toString('hex'),
            version: 'synthetic-version',
            reserved: Buffer.from(reservedCopy),
            body: Buffer.from(observed),
        });
        const decoded = decodeKeyExchangeRequest(unpacked.body);
        expect(decoded.type).toBe(1);
        expect(decoded.timestamp).toBe(BigInt(timestamp));
        const shared = server.computeSecret(decoded.publicKey!);
        expect(decodeKeyExchangeRequestBuf(decryptGcm(decoded.secret!, shared))).toMatchObject({
            uin,
            guid: Buffer.from(originalGuid),
        });
        const time = Buffer.alloc(4);
        time.writeUInt32BE(timestamp);
        const digest = createHash('sha256')
            .update(decoded.publicKey!)
            .update(int(1))
            .update(decoded.secret!)
            .update(int(0))
            .update(time)
            .digest();
        expect(decryptGcm(decoded.verifyHash!, originalVerifyKey)).toEqual(digest);
        const response = responseFor(observed);
        expect(flow.complete(response.frame)).toEqual({
            sessionKey: response.sessionKey,
            sessionTicket: response.sessionTicket,
            expiration: 300,
        });
        expect(verify).toHaveBeenCalledOnce();
        expect(verify.mock.calls[0]![0]).toMatchObject({
            publicKey: Uint8Array.from(response.publicKey),
            requestPublicKey: Uint8Array.from(decoded.publicKey!),
            uin,
            sequence,
        });
        expect(() => flow.complete(response.frame)).toThrow();
        expect(() => prepared.finish(reserved)).toThrow();
        prepared.cancel();
    });

    it('keeps the borrowed body property bound to its original view', () => {
        const prepared = prepareKeyExchangeFlow(fixture().input);
        const original = prepared.body;
        const replacement = Uint8Array.of(9, 8, 7);
        expect(Object.isFrozen(prepared)).toBe(true);
        expect(Reflect.set(prepared, 'body', replacement)).toBe(false);
        expect(Reflect.defineProperty(prepared, 'body', { value: replacement })).toBe(false);
        expect(prepared.body).toBe(original);
        prepared.cancel();
        expectWiped(original);
        expect(replacement).toEqual(Uint8Array.of(9, 8, 7));
    });

    it.each(['modify', 'zero'] as const)('fails closed after signer body %s', (operation) => {
        const prepared = prepareKeyExchangeFlow(fixture().input);
        const borrowed = prepared.body;

        if (operation === 'modify') {
            borrowed[0] ^= 0xff;
        } else {
            borrowed.fill(0);
        }

        const reserved = Uint8Array.of(7, 8);
        expect(() => prepared.finish(reserved)).toThrow();
        expectWiped(borrowed);
        expect(reserved).toEqual(Uint8Array.of(7, 8));
        expect(() => prepared.finish(reserved)).toThrow();
        prepared.cancel();
    });

    it('fails closed when the exposed body is transferred and detached', () => {
        const prepared = prepareKeyExchangeFlow(fixture().input);
        const borrowed = prepared.body;
        const moved = structuredClone(borrowed.buffer, { transfer: [borrowed.buffer] });
        expect(borrowed.byteLength).toBe(0);
        expect(moved.byteLength).toBeGreaterThan(0);
        expect(() => prepared.finish(Uint8Array.of(1))).toThrow();
        expect(() => prepared.finish(Uint8Array.of(1))).toThrow();
        prepared.cancel();
    });

    it('wipes and consumes a cancelled preparation; repeated cancellation is harmless', () => {
        const input = fixture().input;
        const original = Uint8Array.from(input.guid);
        const prepared = prepareKeyExchangeFlow(input);
        const borrowed = prepared.body;
        prepared.cancel();
        expectWiped(borrowed);
        expect(input.guid).toEqual(original);
        expect(() => prepared.cancel()).not.toThrow();
        expect(() => prepared.finish(Uint8Array.of(1))).toThrow();
    });

    it.each([
        ['null', () => null],
        ['string', () => 'reserved'],
        ['plain array', () => [1, 2]],
        ['proxy', () => new Proxy(Uint8Array.of(1, 2), {})],
        ['shared', () => new Uint8Array(new SharedArrayBuffer(4))],
        ['resizable', () => resizableBytes()],
        ['detached', () => detachedBytes()],
        ['oversized', () => new Uint8Array(16 * 1024 * 1024 + 1).fill(0x5a)],
    ])('consumes and wipes on invalid reserved: %s', (_name, makeValue) => {
        const input = fixture().input;
        const guid = Uint8Array.from(input.guid);
        const prepared = prepareKeyExchangeFlow(input);
        const borrowed = prepared.body;
        const value = makeValue();
        let before: Uint8Array | undefined;

        if (value instanceof Uint8Array && !(_name === 'proxy' || _name === 'detached')) {
            before = Uint8Array.from(value);
        }

        expect(() => prepared.finish(value as Uint8Array)).toThrow();
        expectWiped(borrowed);
        expect(input.guid).toEqual(guid);

        if (before !== undefined) {
            expect(Buffer.from(value as Uint8Array).equals(Buffer.from(before))).toBe(true);
        }

        expect(() => prepared.finish(Uint8Array.of(1))).toThrow();
        expect(() => prepared.cancel()).not.toThrow();
    });

    it.each([
        ['null input', () => null],
        ['proxy input', () => new Proxy(fixture().input, {})],
        ['invalid uin', () => ({ ...fixture().input, uin: 'not-an-account' })],
        ['empty guid', () => ({ ...fixture().input, guid: new Uint8Array() })],
        ['invalid a2', () => ({ ...fixture().input, a2: 'not-bytes' })],
        ['proxy guid', () => ({ ...fixture().input, guid: new Proxy(Uint8Array.of(1), {}) })],
        ['shared a2', () => ({ ...fixture().input, a2: new Uint8Array(new SharedArrayBuffer(4)) })],
        ['resizable guid', () => ({ ...fixture().input, guid: resizableBytes() })],
        ['detached guid', () => ({ ...fixture().input, guid: detachedBytes() })],
        ['invalid public key', () => ({ ...fixture().input, serverPublicKey: new Uint8Array(65) })],
        ['invalid verification key', () => ({ ...fixture().input, verifyKey: new Uint8Array(31) })],
        ['missing verifier', () => ({ ...fixture().input, verifyServerResponse: undefined })],
    ])('rejects invalid prepared input: %s', (_name, makeInput) => {
        expect(() => prepareKeyExchangeFlow(makeInput() as PreparedInput)).toThrow();
    });

    it.each(['guid', 'a2', 'serverPublicKey', 'verifyKey'] as const)(
        'rejects unsafe byte storage for %s while preserving other caller arrays',
        (name) => {
            for (const makeUnsafe of [
                () => new Proxy(Uint8Array.of(1), {}),
                () => new Uint8Array(new SharedArrayBuffer(4)),
                () => resizableBytes(),
                () => detachedBytes(),
            ]) {
                const input = fixture().input;
                const originalGuid = Uint8Array.from(input.guid);
                const originalA2 = Uint8Array.from(input.a2!);
                const originalPublicKey = Uint8Array.from(input.serverPublicKey);
                const originalVerifyKey = Uint8Array.from(input.verifyKey);
                const unsafe = makeUnsafe();
                expect(() => prepareKeyExchangeFlow({ ...input, [name]: unsafe })).toThrow();
                expect(input.guid).toEqual(originalGuid);
                expect(input.a2).toEqual(originalA2);
                expect(input.serverPublicKey).toEqual(originalPublicKey);
                expect(input.verifyKey).toEqual(originalVerifyKey);
            }
        },
    );

    it('does not evaluate traps on a proxy input or wipe proxy-backed reserved bytes', () => {
        const input = fixture().input;
        const get = vi.fn(Reflect.get);
        expect(() => prepareKeyExchangeFlow(new Proxy(input, { get }))).toThrow();
        expect(get).not.toHaveBeenCalled();
        const bytes = Uint8Array.of(1, 2, 3);
        const reserved = new Proxy(bytes, {});
        const prepared = prepareKeyExchangeFlow(input);
        expect(() => prepared.finish(reserved)).toThrow();
        expect(bytes).toEqual(Uint8Array.of(1, 2, 3));
        expectWiped(prepared.body);
    });

    it('rejects accessor properties without invoking them or changing caller bytes', () => {
        const input = fixture().input;
        const guid = Uint8Array.from(input.guid);
        const getter = vi.fn(() => input.guid);
        Object.defineProperty(input, 'a2', { get: getter, enumerable: true });
        expect(() => prepareKeyExchangeFlow(input)).toThrow();
        expect(getter).not.toHaveBeenCalled();
        expect(input.guid).toEqual(guid);
    });

    it.each(['reject', 'throw'] as const)(
        'consumes response when the bound verifier chooses to %s',
        (mode) => {
            const { input } = fixture();
            const verify = vi.fn(() => {
                if (mode === 'throw') {
                    throw new Error('synthetic verifier error');
                }

                return false;
            });
            input.verifyServerResponse = verify;
            const prepared = prepareKeyExchangeFlow(input);
            const observed = Uint8Array.from(prepared.body);
            const response = responseFor(observed);
            const flow = prepared.finish(Uint8Array.of(9));
            expect(() => flow.complete(response.frame)).toThrow();
            expect(verify).toHaveBeenCalledOnce();
            expect(() => flow.complete(response.frame)).toThrow();
        },
    );

    it('does not commit tickets when the verifier synchronously cancels', () => {
        const { input } = fixture();
        let flow!: ReturnType<ReturnType<typeof prepareKeyExchangeFlow>['finish']>;

        input.verifyServerResponse = () => {
            flow.cancel();
            return true;
        };

        const prepared = prepareKeyExchangeFlow(input);
        const response = responseFor(Uint8Array.from(prepared.body));
        flow = prepared.finish(Uint8Array.of(1));
        expect(() => flow.complete(response.frame)).toThrow();
        expect(() => flow.complete(response.frame)).toThrow();
    });

    it('rejects recursive complete without disrupting the outer response', () => {
        const { input } = fixture();
        let flow!: ReturnType<ReturnType<typeof prepareKeyExchangeFlow>['finish']>;
        let frame!: Uint8Array;
        let recursionRejected = false;

        input.verifyServerResponse = () => {
            try {
                flow.complete(frame);
            } catch {
                recursionRejected = true;
            }

            return true;
        };

        const prepared = prepareKeyExchangeFlow(input);
        const response = responseFor(Uint8Array.from(prepared.body));
        frame = response.frame;
        flow = prepared.finish(Uint8Array.of(1));
        expect(flow.complete(frame)).toEqual({
            sessionKey: response.sessionKey,
            sessionTicket: response.sessionTicket,
            expiration: 300,
        });
        expect(recursionRejected).toBe(true);
        expect(() => flow.complete(frame)).toThrow();
    });

    it('consumes malformed responses and supports cancellation after finish', () => {
        const first = prepareKeyExchangeFlow(fixture().input);
        const firstBody = Uint8Array.from(first.body);
        const flow = first.finish(Uint8Array.of(1));
        const response = responseFor(firstBody);
        expect(() => flow.complete(Uint8Array.of(0))).toThrow();
        expect(() => flow.complete(response.frame)).toThrow();

        const second = prepareKeyExchangeFlow(fixture().input);
        const secondBody = Uint8Array.from(second.body);
        const cancelled = second.finish(Uint8Array.of(1));
        cancelled.cancel();
        expect(() => cancelled.cancel()).not.toThrow();
        expect(() => cancelled.complete(responseFor(secondBody).frame)).toThrow();
    });
});
