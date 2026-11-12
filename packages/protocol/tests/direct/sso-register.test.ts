import { protobuf_getUnknownFields } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';
import { decodeSsoResponse, type SsoResponse } from '../../src/direct/sso';
import {
    classifySsoRegisterResponse,
    decodeSsoHeartbeatResponse,
    decodeSsoRegisterResponse,
    encodeSsoHeartbeatReference,
    encodeSsoRegisterReference,
    SSO_INFO_SYNC_COMMAND,
} from '../../src/direct/sso-register';

// Synthetic vectors manually derived from the pinned reference and protobuf wire rules.
// They are not captures and establish no target or server compatibility.
const bytes = (hex: string): Uint8Array => Buffer.from(hex, 'hex');
const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');
const response = (body: Uint8Array, retCode = 0): SsoResponse => ({
    sequence: 42,
    retCode,
    extra: '',
    command: SSO_INFO_SYNC_COMMAND,
    cookie: new Uint8Array(),
    dataFlag: 0,
    reserved: new Uint8Array(),
    body,
    headerExtension: new Uint8Array(),
});

const validRegistration = bytes('3a12121072656769737465722073756363657373');

describe('offline reference SSO registration', () => {
    it('encodes the PC reference including present zero and empty fields', () => {
        const body = encodeSsoRegisterReference({
            uid: 'example-uid',
            version: 'V',
            guid: bytes('abcd'),
            deviceName: 'N',
            deviceType: 'T',
            vendorOs: 'O',
            random: 0,
        });
        expect(hex(body)).toBe(
            '08df05100020022800320a0a02080010001a0208004200' +
                '4a2f0a044142434410001a01562001288410320d0a014e1201541a0022002a014f' +
                '38004006480052040801100158006001' +
                '5204080010025a06080010001800',
        );
    });

    it('only reports success when SSO return code and exact message both succeed', () => {
        expect(decodeSsoRegisterResponse(validRegistration).register?.message).toBe(
            'register success',
        );
        expect(classifySsoRegisterResponse(response(validRegistration))).toBe('success');
        expect(classifySsoRegisterResponse(response(validRegistration, -1))).toBe('sso-error');
        expect(classifySsoRegisterResponse(response(bytes('')))).toBe('missing-result');
        expect(classifySsoRegisterResponse(response(bytes('3a00')))).toBe('missing-result');
        expect(classifySsoRegisterResponse(response(bytes('3a03120178')))).toBe('rejected');
        expect(() =>
            classifySsoRegisterResponse({ ...response(validRegistration), command: 'other' }),
        ).toThrow(/command/);
        expect(() =>
            classifySsoRegisterResponse({
                ...response(validRegistration),
                retCode: undefined as never,
            }),
        ).toThrow(/retCode/);
    });

    it('classifies the return code read from an actual synthetic SSO frame', () => {
        const command = Buffer.from(SSO_INFO_SYNC_COMMAND, 'utf8');

        const word = (n: number): Buffer => {
            const value = Buffer.alloc(4);
            value.writeInt32BE(n);
            return value;
        };

        const field = (value: Uint8Array): Buffer => Buffer.concat([word(value.length + 4), value]);

        const frame = (retCode: number): Uint8Array => {
            const head = Buffer.concat([
                word(42),
                word(retCode),
                field(Buffer.alloc(0)),
                field(command),
                field(Buffer.alloc(0)),
                word(0),
                field(Buffer.alloc(0)),
            ]);
            return Buffer.concat([field(head), field(validRegistration)]);
        };

        expect(classifySsoRegisterResponse(decodeSsoResponse(frame(0)))).toBe('success');
        expect(classifySsoRegisterResponse(decodeSsoResponse(frame(-1)))).toBe('sso-error');
    });

    it('preserves unknown-field diagnostics and rejects malformed fields', () => {
        const result = decodeSsoRegisterResponse(
            bytes('3a121210726567697374657220737563636573734807'),
        );
        expect(protobuf_getUnknownFields(result)).toEqual([
            { fieldNumber: 9, wireType: 0, count: 1, totalByteLength: 1 },
        ]);

        for (const wire of ['3a12', '3a021204', '0880', '00', '0b14']) {
            expect(() => decodeSsoRegisterResponse(bytes(wire))).toThrow();
        }

        expect(() => decodeSsoRegisterResponse(null as never)).toThrow(/bytes/);
    });

    it('validates caller-owned profile data without echoing values', () => {
        const input = {
            uid: 'uid',
            version: 'V',
            guid: bytes('ab'),
            deviceName: '',
            deviceType: '',
            vendorOs: '',
            random: 0,
        };
        expect(() => encodeSsoRegisterReference({ ...input, random: -1 })).toThrow(/random/);
        expect(() => encodeSsoRegisterReference({ ...input, random: 0x7fffffff })).toThrow(
            /random/,
        );
        expect(() => encodeSsoRegisterReference({ ...input, uid: '' })).toThrow(/uid/);
        expect(() => encodeSsoRegisterReference({ ...input, guid: bytes('') })).toThrow(/guid/);
    });
});

describe('offline reference SSO heartbeat', () => {
    it('encodes PC reference fields including initialized silence and default values', () => {
        expect(hex(encodeSsoHeartbeatReference())).toBe('08011202080018002000');
    });

    it('parses the interval without scheduling or inferring state', () => {
        expect(decodeSsoHeartbeatResponse(bytes('188e02')).interval).toBe(270n);
        expect(decodeSsoHeartbeatResponse(bytes('')).interval).toBeUndefined();
        const result = decodeSsoHeartbeatResponse(bytes('188e024807'));
        expect(protobuf_getUnknownFields(result)).toEqual([
            { fieldNumber: 9, wireType: 0, count: 1, totalByteLength: 1 },
        ]);
        expect(() => decodeSsoHeartbeatResponse(bytes('1880'))).toThrow();
    });
});
