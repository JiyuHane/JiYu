import { createECDH } from 'node:crypto';
import { protobuf_decode } from '@snowluma/proton';
import type { DirectSsoReserve } from '@snowluma/proto-defs/sso-reserve';
import { describe, expect, it, vi } from 'vitest';
import {
    KEY_EXCHANGE_COMMAND,
    prepareKeyExchangeFlow,
    type KeyExchangeFlowInput,
} from '../../src/direct/key-exchange-flow';
import { decodeKeyExchangeRequest } from '../../src/direct/key-exchange-protobuf';
import {
    createLagrangeV2MilkySigner,
    type LagrangeV2MilkyRequest,
} from '../../src/direct/lagrange-v2-milky-signer';
import { qqTeaDecrypt } from '../../src/direct/qq-tea';
import { createSsoReserveBuilder } from '../../src/direct/sso-reserve';

// All peers, signatures and transport responses are synthetic and in-process.
function fixture(sequence: number): Omit<KeyExchangeFlowInput, 'reserved'> {
    const server = createECDH('prime256v1');
    const privateKey = Buffer.alloc(32);
    privateKey[31] = 1;
    server.setPrivateKey(privateKey);

    return {
        uin: '123456',
        guid: Uint8Array.from({ length: 16 }, (_, index) => index),
        a2: Uint8Array.of(0, 0xff, 0x80, 3),
        version: 'synthetic-version',
        subAppId: 1234,
        sequence,
        serverPublicKey: Uint8Array.from(server.getPublicKey()),
        verifyKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
        timestamp: 1700000000,
        verifyServerResponse: () => true,
    };
}

function unpackRequest(frameBytes: Uint8Array) {
    const frame = Buffer.from(frameBytes);
    expect(frame.readUInt32BE(0)).toBe(frame.length);
    expect(frame.readInt32BE(4)).toBe(12);
    expect(frame[8]).toBe(2);
    expect(frame.readUInt32BE(9)).toBe(4);
    expect(frame[13]).toBe(0);
    const accountLength = frame.readUInt32BE(14);
    expect(accountLength).toBeGreaterThanOrEqual(4);
    expect(14 + accountLength).toBeLessThan(frame.length);
    const uin = frame.subarray(18, 14 + accountLength).toString();
    const sso = Buffer.from(qqTeaDecrypt(frame.subarray(14 + accountLength), new Uint8Array(16)));
    let pos = 4;
    const sequence = sso.readInt32BE(pos);
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
    const bodyPrefixOffset = pos;
    const body = readField();
    expect(pos).toBe(sso.length);
    return {
        uin,
        sequence,
        subAppId,
        a2,
        command,
        guid,
        version,
        reserved,
        body,
        prefixedBody: sso.subarray(bodyPrefixOffset),
    };
}

describe('prepared key exchange with the real signer adapter and reserve builder', () => {
    it.each([
        [123, 123],
        [0x80000000, -0x80000000],
    ])(
        'binds raw sequence %i to signed SSO sequence %i and the exact body',
        async (raw, signed) => {
            const input = fixture(signed);
            const originalGuid = Uint8Array.from(input.guid);
            const originalA2 = Uint8Array.from(input.a2!);
            const prepared = prepareKeyExchangeFlow(input);
            const borrowed = prepared.body;
            const callerBody = Uint8Array.from(borrowed);
            const expectedBodyHex = Buffer.from(callerBody).toString('hex');
            expect(Object.isFrozen(prepared)).toBe(true);
            expect(callerBody.length).toBeGreaterThan(0);

            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const transport = vi.fn(async (_dto: LagrangeV2MilkyRequest) => {
                await gate;
                return {
                    code: 0,
                    message: null,
                    value: { sec_sign: '00aBff', sec_token: '1020', sec_extra: '30' },
                };
            });
            const signer = createLagrangeV2MilkySigner({
                uin: input.uin,
                guid: originalGuid,
                qua: 'synthetic-qua',
                transport,
            });
            const classifySigning = vi.fn(() => 'sign' as const);
            const buildReserved = createSsoReserveBuilder({
                uin: input.uin,
                classifySigning,
                sign: signer,
                createTraceParent: () => 'synthetic-trace',
            });
            const pending = buildReserved({
                uin: input.uin,
                command: KEY_EXCHANGE_COMMAND,
                sequence: raw,
                body: callerBody,
            });
            expect(transport).toHaveBeenCalledOnce();
            const dto = transport.mock.calls[0]![0];
            expect(Object.isFrozen(dto)).toBe(true);
            expect(dto).toEqual({
                uin: 123456,
                command: KEY_EXCHANGE_COMMAND,
                seq: signed,
                body: expectedBodyHex,
                guid: Buffer.from(originalGuid).toString('hex'),
                qua: 'synthetic-qua',
            });
            expect(classifySigning).toHaveBeenCalledExactlyOnceWith(KEY_EXCHANGE_COMMAND);

            // The prepared state was snapshotted before the asynchronous signing step.
            input.uin = '999999';
            input.sequence = 42;
            input.subAppId = 77;
            input.version = 'changed';
            input.guid.fill(0xee);
            input.a2!.fill(0xdd);
            release();
            const reserved = await pending;
            const reservedCopy = Uint8Array.from(reserved);
            const flow = prepared.finish(reserved);
            expect(borrowed).toEqual(new Uint8Array(borrowed.length));
            expect(Buffer.from(callerBody).toString('hex')).toBe(expectedBodyHex);
            expect(reserved).toEqual(reservedCopy);

            const unpacked = unpackRequest(flow.request);
            expect(unpacked).toMatchObject({
                uin: '123456',
                sequence: signed,
                subAppId: 1234,
                a2: Buffer.from(originalA2),
                command: KEY_EXCHANGE_COMMAND,
                guid: Buffer.from(originalGuid).toString('hex'),
                version: 'synthetic-version',
                reserved: Buffer.from(reservedCopy),
            });
            expect(unpacked.sequence >>> 0).toBe(raw);
            expect(dto.body).toBe(unpacked.body.toString('hex'));
            expect(dto.body).not.toBe(unpacked.prefixedBody.toString('hex'));
            expect(unpacked.prefixedBody.readUInt32BE(0)).toBe(unpacked.body.length + 4);
            expect(decodeKeyExchangeRequest(unpacked.body)).toMatchObject({
                type: 1,
                timestamp: 1700000000n,
            });
            expect(protobuf_decode<DirectSsoReserve>(unpacked.reserved).secureInfo).toMatchObject({
                sign: Buffer.from([0, 0xab, 0xff]),
                token: Buffer.from([0x10, 0x20]),
                extra: Buffer.from([0x30]),
            });
            expect(() => prepared.finish(reserved)).toThrow();
            flow.cancel();

            // finish clears its borrow, not copies or reserved bytes owned by this caller.
            callerBody.fill(0);
            reserved.fill(0);
            reservedCopy.fill(0);
            expect(callerBody).toEqual(new Uint8Array(callerBody.length));
            expect(reserved).toEqual(new Uint8Array(reserved.length));
        },
    );
});
