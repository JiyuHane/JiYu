import { describe, expect, it } from 'vitest';
import { protobuf_decode, protobuf_encode, type pb_optional, type bytes } from '@snowluma/proton';
import {
    decodeNativeTicketForward,
    decodeNativeTicketRefresh,
    disposeNativeTicketResponse,
    encodeNativeTicketForward,
    encodeNativeTicketRefresh,
    NATIVE_NT_APP_ID,
    type NativeForwardWire,
    type NativeRefreshRequestWire,
    type NativeRefreshResponseWire,
    type NativeTicketsWire,
} from '../../src/direct/nt-native-ticket-codec';
import { decryptKeyExchangeBytes, encryptKeyExchangeBytes } from '../../src/direct/key-exchange';

const input = () => ({
    uin: '123',
    guid: new Uint8Array(16).fill(3),
    version: '3.2.35-54395',
    deviceName: 'fixture-linux',
    a1: Uint8Array.of(4, 5, 6),
});
const tickets = (): NativeTicketsWire => ({
    a1: Uint8Array.of(1),
    a2: Uint8Array.of(2),
    d2: Uint8Array.of(3),
    d2Key: new Uint8Array(16).fill(4),
    a2RefreshTime: { next: 1700000000n, expires: 1701000000n },
});

function response(t = tickets()) {
    return protobuf_encode<NativeRefreshResponseWire>({ head: {}, body: { tickets: t } });
}

interface UnexpectedApp {
    qua?: pb_optional<5, string>;
}
interface UnexpectedClient {
    extra?: pb_optional<5, bytes>;
}
interface InspectHead {
    app?: pb_optional<3, UnexpectedApp>;
    client?: pb_optional<2, UnexpectedClient>;
    cookie?: pb_optional<5, bytes>;
}
interface InspectRequest {
    head?: pb_optional<1, InspectHead>;
}

// The real Proton plugin transforms both schemas and production calls in these fixtures.
describe('Linux native ticket codecs', () => {
    it('encodes exact native header, inner appId and A1 without mutating input', () => {
        const source = input();
        const wire = encodeNativeTicketRefresh(source);
        const decoded = protobuf_decode<NativeRefreshRequestWire>(wire);
        expect(decoded).toEqual({
            head: {
                user: { account: '123' },
                client: {
                    deviceType: 'Linux',
                    deviceName: 'fixture-linux',
                    platform: 7,
                    guid: source.guid,
                },
                app: {
                    version: source.version,
                    appId: NATIVE_NT_APP_ID,
                    appName: 'com.tencent.qq',
                },
                cookie: null,
                sdk: { version: 1 },
            },
            body: { a1: source.a1 },
        });
        const other = protobuf_decode<InspectRequest>(wire);
        expect(other.head?.app?.qua).toBeNull();
        expect(other.head?.client?.extra).toBeNull();
        expect(other.head?.cookie).toBeNull();
        expect(source.a1).toEqual(Uint8Array.of(4, 5, 6));
        expect(source.guid).toEqual(new Uint8Array(16).fill(3));
    });

    it('omits empty cookies but preserves nonempty cookie bytes', () => {
        expect(
            protobuf_decode<NativeRefreshRequestWire>(
                encodeNativeTicketRefresh({ ...input(), cookie: new Uint8Array() }),
            ).head.cookie,
        ).toBeNull();
        expect(
            protobuf_decode<NativeRefreshRequestWire>(
                encodeNativeTicketRefresh({ ...input(), cookie: Uint8Array.of(255, 0) }),
            ).head.cookie?.value,
        ).toEqual(Uint8Array.of(255, 0));
    });

    it('rejects empty A1, malformed GUID, fields, getters and mutable shared input', () => {
        expect(() => encodeNativeTicketRefresh({ ...input(), a1: new Uint8Array() })).toThrow();
        expect(() => encodeNativeTicketRefresh({ ...input(), guid: new Uint8Array(15) })).toThrow();
        expect(() =>
            encodeNativeTicketRefresh({ ...input(), a1: new Uint8Array(new SharedArrayBuffer(8)) }),
        ).toThrow();
        expect(() => encodeNativeTicketRefresh({ ...input(), uin: '0' })).toThrow();
        const getter = {
            ...input(),
            get cookie(): Uint8Array {
                throw new Error('getter ran');
            },
        };
        expect(() => encodeNativeTicketRefresh(getter)).toThrow('invalid native message input');
        expect(() => encodeNativeTicketRefresh({ ...input(), qua: 'extra' } as never)).toThrow();
    });

    it('reads field16 then field12 irrespective of on-wire ordering, as absolute uint64 seconds', () => {
        const time = (1n << 63n) + 123n;
        const decoded = decodeNativeTicketRefresh(
            response({ ...tickets(), a1RefreshTime: { next: time, expires: time + 99n } }),
        );
        expect(decoded.kind).toBe('tickets');

        if (decoded.kind !== 'tickets') {
            throw new Error('fixture');
        }

        expect(decoded.metadata).toEqual({
            nextRefreshAtSeconds: time,
            expiresAtSeconds: time + 99n,
        });
        disposeNativeTicketResponse(decoded);
        expect(decoded.tickets.d2Key).toEqual(new Uint8Array(16));
    });

    it('field12 present-empty overwrites field16, and absent times stay zero', () => {
        for (const t of [
            { ...tickets(), a1RefreshTime: {} },
            { ...tickets(), a2RefreshTime: undefined },
        ]) {
            const decoded = decodeNativeTicketRefresh(response(t));
            expect(decoded).toMatchObject({
                kind: 'tickets',
                metadata: { nextRefreshAtSeconds: 0n, expiresAtSeconds: 0n },
            });
            disposeNativeTicketResponse(decoded);
        }
    });

    it('owns projections independently of parser input and preserves account binding values', () => {
        const wire = protobuf_encode<NativeRefreshResponseWire>({
            head: {},
            body: { tickets: tickets(), account: { uin: 123n, uid: 'uid-123' } },
        });
        const before = Uint8Array.from(wire);
        const decoded = decodeNativeTicketRefresh(wire);
        expect(wire).toEqual(before);
        wire.fill(0);
        expect(decoded).toMatchObject({ kind: 'tickets', account: { uin: 123n, uid: 'uid-123' } });

        if (decoded.kind !== 'tickets') {
            throw new Error('fixture');
        }

        expect(decoded.tickets.a1).toEqual(Uint8Array.of(1));
        disposeNativeTicketResponse(decoded);
        disposeNativeTicketResponse(decoded);
        expect(decoded.tickets.a1).toEqual(Uint8Array.of(0));
    });

    it('separates protocol errors including kick flag from the native empty-A1 local failure', () => {
        expect(
            decodeNativeTicketRefresh(
                protobuf_encode<NativeRefreshResponseWire>({
                    head: { error: { code: 140022014n, needsLogin: true } },
                }),
            ),
        ).toEqual({ kind: 'protocol-error', code: 140022014n, needsLogin: true });
        expect(decodeNativeTicketRefresh(response({ a1: new Uint8Array() }))).toEqual({
            kind: 'empty-a1',
        });
        expect(
            decodeNativeTicketRefresh(protobuf_encode<NativeRefreshResponseWire>({ head: {} })),
        ).toEqual({ kind: 'empty-a1' });
        expect(() => decodeNativeTicketRefresh(Uint8Array.of(18, 0))).toThrow(
            'missing native response header',
        );
        expect(() => decodeNativeTicketRefresh(Uint8Array.of(10, 255))).toThrow();
    });

    it.each(['a2', 'd2', 'd2Key'] as const)(
        'rejects an incomplete or malformed replacement %s',
        (field) => {
            const value = { ...tickets(), [field]: new Uint8Array() };
            expect(() => decodeNativeTicketRefresh(response(value))).toThrow();

            if (field === 'd2Key') {
                expect(() =>
                    decodeNativeTicketRefresh(
                        response({ ...tickets(), d2Key: new Uint8Array(32) }),
                    ),
                ).toThrow();
            }
        },
    );

    it('uses AES256 GCM IV12/ciphertext/tag16 and forward field3, not field1', () => {
        const key = new Uint8Array(32).fill(7);
        const ticket = Uint8Array.of(9, 9);
        const plain = encodeNativeTicketRefresh(input());
        const wire = encodeNativeTicketForward(key, ticket, plain);
        const envelope = protobuf_decode<NativeForwardWire>(wire);
        expect(envelope.sessionTicket).toEqual(ticket);
        expect(envelope.type).toBe(1);
        expect(envelope.buffer?.length).toBe(plain.length + 28);
        expect(decryptKeyExchangeBytes(envelope.buffer!, key)).toEqual(plain);
        const responseWire = protobuf_encode<NativeForwardWire>({
            buffer: encryptKeyExchangeBytes(response(), key),
        });
        const decoded = decodeNativeTicketForward(key, responseWire);
        expect(decoded.kind).toBe('tickets');
        disposeNativeTicketResponse(decoded);
        expect(() =>
            decodeNativeTicketForward(
                key,
                protobuf_encode<NativeForwardWire>({ sessionTicket: envelope.buffer! }),
            ),
        ).toThrow();
        expect(() => encodeNativeTicketForward(new Uint8Array(16), ticket, plain)).toThrow();
        expect(() =>
            decodeNativeTicketForward(
                key,
                protobuf_encode<NativeForwardWire>({ buffer: new Uint8Array(28) }),
            ),
        ).toThrow();
        const tampered = encryptKeyExchangeBytes(response(), key);
        tampered[tampered.length - 1]! ^= 1;
        expect(() =>
            decodeNativeTicketForward(
                key,
                protobuf_encode<NativeForwardWire>({ buffer: tampered }),
            ),
        ).toThrow();
    });
});
