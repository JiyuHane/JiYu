import { createCipheriv, createECDH, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeyExchangeFlow, KEY_EXCHANGE_COMMAND } from '../../src/direct/key-exchange-flow';
import {
    decodeKeyExchangeRequest,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
} from '../../src/direct/key-exchange-protobuf';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';

// Observe only actual return values; neither wrapper changes the real codec or crypto output.
const captured = vi.hoisted(() => ({
    requests: [] as { value: Uint8Array; before: Uint8Array }[],
    plaintexts: [] as { value: Uint8Array; before: Uint8Array }[],
    decoded: [] as {
        value: { sessionKey?: Uint8Array; sessionTicket?: Uint8Array; expiration?: number };
        keyBefore: Uint8Array | undefined;
        ticketBefore: Uint8Array | undefined;
    }[],
}));

vi.mock('../../src/direct/key-exchange-protobuf', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/direct/key-exchange-protobuf')>();
    return {
        ...actual,
        encodeKeyExchangeRequestBuf(
            value: Parameters<typeof actual.encodeKeyExchangeRequestBuf>[0],
        ) {
            const result = actual.encodeKeyExchangeRequestBuf(value);
            captured.requests.push({ value: result, before: Uint8Array.from(result) });
            return result;
        },
        decodeKeyExchangeResponseSecret(bytes: Uint8Array) {
            const result = actual.decodeKeyExchangeResponseSecret(bytes);
            captured.decoded.push({
                value: result,
                keyBefore: result.sessionKey && Uint8Array.from(result.sessionKey),
                ticketBefore: result.sessionTicket && Uint8Array.from(result.sessionTicket),
            });
            return result;
        },
    };
});

vi.mock('../../src/direct/key-exchange', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/direct/key-exchange')>();
    return {
        ...actual,
        decryptKeyExchangeBytes(encoded: Uint8Array, key: Uint8Array) {
            const result = actual.decryptKeyExchangeBytes(encoded, key);
            captured.plaintexts.push({ value: result, before: Uint8Array.from(result) });
            return result;
        },
    };
});

const uin = '123456';
const sequence = 123;

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

function encrypt(plain: Uint8Array, key: Uint8Array): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function assertWiped(entry: { value: Uint8Array; before: Uint8Array }): void {
    expect(entry.before.length).toBeGreaterThan(0);
    expect(entry.before.some((byte) => byte !== 0)).toBe(true);
    expect(entry.value).toEqual(new Uint8Array(entry.before.length));
}

// Synthetic peer and frames stay entirely in-process; no socket or listener is created.
function fixture(verifyServerResponse: () => boolean = () => true) {
    const server = createECDH('prime256v1');
    server.generateKeys();
    const input = {
        uin,
        guid: Uint8Array.of(1, 2, 3, 4),
        version: 'fixture-version',
        subAppId: 1234,
        reserved: Uint8Array.of(5, 6),
        sequence,
        serverPublicKey: server.getPublicKey(),
        verifyKey: randomBytes(32),
        timestamp: 1700000000,
        verifyServerResponse,
    };
    const inputSnapshot = {
        guid: Uint8Array.from(input.guid),
        reserved: Uint8Array.from(input.reserved),
        serverPublicKey: Uint8Array.from(input.serverPublicKey),
        verifyKey: Uint8Array.from(input.verifyKey),
    };
    const flow = createKeyExchangeFlow(input);
    const request = Buffer.from(flow.request);
    const accountLength = request.readUInt32BE(14);
    const sso = Buffer.from(qqTeaDecrypt(request.subarray(14 + accountLength), new Uint8Array(16)));
    let position = 4 + 4 + 4 + 4 + 12;

    const readField = (width: 2 | 4 = 4): Buffer => {
        const length = width === 2 ? sso.readUInt16BE(position) : sso.readUInt32BE(position);
        const value = sso.subarray(position + width, position + length);
        position += length;
        return value;
    };

    readField();
    expect(readField().toString()).toBe(KEY_EXCHANGE_COMMAND);
    readField();
    readField();
    readField();
    readField(2);
    readField();
    expect(position).toBe(sso.readUInt32BE(0));
    const requestBody = decodeKeyExchangeRequest(readField());
    expect(position).toBe(sso.length);
    expect(requestBody.publicKey).toBeDefined();
    const peer = createECDH('prime256v1');
    peer.generateKeys();
    const responseKey = peer.computeSecret(requestBody.publicKey!);
    const sessionKey = randomBytes(16);
    const sessionTicket = randomBytes(24);
    const sessionKeySnapshot = Uint8Array.from(sessionKey);
    const sessionTicketSnapshot = Uint8Array.from(sessionTicket);

    function response(plain: Uint8Array): Buffer {
        const body = encodeKeyExchangeResponse({
            publicKey: peer.getPublicKey(),
            secret: encrypt(plain, responseKey),
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
        const payload = qqTeaEncrypt(Buffer.concat([field(head), field(body)]), new Uint8Array(16));
        const frame = Buffer.concat([
            int(0),
            int(12),
            Buffer.from([2, 0]),
            field(Buffer.from(uin)),
            payload,
        ]);
        frame.writeUInt32BE(frame.length);
        return frame;
    }

    return {
        input,
        inputSnapshot,
        flow,
        response,
        sessionKey,
        sessionTicket,
        sessionKeySnapshot,
        sessionTicketSnapshot,
    };
}

function assertInputUnchanged(f: ReturnType<typeof fixture>): void {
    expect(f.input.guid).toEqual(f.inputSnapshot.guid);
    expect(f.input.reserved).toEqual(f.inputSnapshot.reserved);
    expect(Uint8Array.from(f.input.serverPublicKey)).toEqual(f.inputSnapshot.serverPublicKey);
    expect(Uint8Array.from(f.input.verifyKey)).toEqual(f.inputSnapshot.verifyKey);
    expect(Uint8Array.from(f.sessionKey)).toEqual(f.sessionKeySnapshot);
    expect(Uint8Array.from(f.sessionTicket)).toEqual(f.sessionTicketSnapshot);
}

beforeEach(() => {
    captured.requests.length = 0;
    captured.plaintexts.length = 0;
    captured.decoded.length = 0;
});

describe('offline key exchange temporary byte ownership', () => {
    it('wipes request and response plaintext while transferring decoded bytes to the caller', () => {
        const f = fixture();
        const plain = encodeKeyExchangeResponseSecret({
            sessionKey: f.sessionKey,
            sessionTicket: f.sessionTicket,
            expiration: 300,
        });
        const plainSnapshot = Uint8Array.from(plain);
        const response = f.response(plain);
        const responseSnapshot = Uint8Array.from(response);
        const result = f.flow.complete(response);

        expect(captured.requests).toHaveLength(1);
        expect(captured.plaintexts).toHaveLength(1);
        expect(captured.decoded).toHaveLength(1);
        assertWiped(captured.requests[0]);
        expect(captured.plaintexts[0].before).toEqual(plainSnapshot);
        assertWiped(captured.plaintexts[0]);
        expect(captured.decoded[0].keyBefore).toEqual(f.sessionKeySnapshot);
        expect(captured.decoded[0].ticketBefore).toEqual(f.sessionTicketSnapshot);
        expect(result.sessionKey).toBe(captured.decoded[0].value.sessionKey);
        expect(result.sessionTicket).toBe(captured.decoded[0].value.sessionTicket);
        expect(result.sessionKey.buffer).not.toBe(captured.plaintexts[0].value.buffer);
        expect(result.sessionTicket.buffer).not.toBe(captured.plaintexts[0].value.buffer);
        expect(result.sessionKey).toEqual(f.sessionKeySnapshot);
        expect(result.sessionTicket).toEqual(f.sessionTicketSnapshot);
        expect(result.expiration).toBe(300);
        expect(plain).toEqual(plainSnapshot);
        expect(Uint8Array.from(response)).toEqual(responseSnapshot);
        assertInputUnchanged(f);
    });

    it.each([
        ['ticket', Uint8Array.of(0x0a, 3, 1, 2, 3), /sessionTicket/],
        ['key', Uint8Array.of(0x12, 3, 4, 5, 6), /sessionKey/],
    ])(
        'wipes captured plaintext when the real decoder rejects a missing %s',
        (_name, plain, error) => {
            const f = fixture();
            const plainSnapshot = Uint8Array.from(plain);
            const response = f.response(plain);
            const responseSnapshot = Uint8Array.from(response);
            expect(() => f.flow.complete(response)).toThrow(error);
            expect(captured.requests).toHaveLength(1);
            expect(captured.plaintexts).toHaveLength(1);
            // The validating decoder throws before returning its Proton object to the wrapper.
            expect(captured.decoded).toHaveLength(0);
            assertWiped(captured.requests[0]);
            expect(captured.plaintexts[0].before).toEqual(plainSnapshot);
            assertWiped(captured.plaintexts[0]);
            expect(plain).toEqual(plainSnapshot);
            expect(Uint8Array.from(response)).toEqual(responseSnapshot);
            assertInputUnchanged(f);
        },
    );

    it('wipes the encoded request if server public-key validation throws', () => {
        const f = fixture();
        captured.requests.length = 0;
        const invalidPoint = new Uint8Array(65);
        const invalidSnapshot = Uint8Array.from(invalidPoint);
        expect(() =>
            createKeyExchangeFlow({ ...f.input, serverPublicKey: invalidPoint }),
        ).toThrow();
        expect(captured.requests).toHaveLength(1);
        assertWiped(captured.requests[0]);
        expect(invalidPoint).toEqual(invalidSnapshot);
        assertInputUnchanged(f);
    });

    it('wipes the request and never decrypts when verification rejects the response', () => {
        const f = fixture(() => false);
        const plain = encodeKeyExchangeResponseSecret({
            sessionKey: f.sessionKey,
            sessionTicket: f.sessionTicket,
        });
        const response = f.response(plain);
        const responseSnapshot = Uint8Array.from(response);
        expect(() => f.flow.complete(response)).toThrow(/verification failed/);
        expect(captured.requests).toHaveLength(1);
        assertWiped(captured.requests[0]);
        expect(captured.plaintexts).toHaveLength(0);
        expect(captured.decoded).toHaveLength(0);
        expect(Uint8Array.from(response)).toEqual(responseSnapshot);
        assertInputUnchanged(f);
    });
});
