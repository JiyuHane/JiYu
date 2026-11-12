import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Sso12PacketClient } from '../../src/direct/sso12-packet-client';
import { ServiceFrameDecoder } from '../../src/direct/service-stream';
import { qqTeaDecrypt } from '../../src/direct/qq-tea';
import { createWtEcdh } from '../../src/direct/wt-ecdh';
import { buildWtQrFrame, buildWtQrOicq, type WtQrFrameContext } from '../../src/direct/wt-qr-frame';
import { encodeWtQrFetchBody, encodeWtQrPollBody } from '../../src/direct/wt-qr-request';

function key(n: number): Uint8Array {
    const value = new Uint8Array(24);
    value[23] = n;
    return value;
}

function readField(data: Buffer, offset: number): { value: Buffer; next: number } {
    const length = data.readUInt32BE(offset);
    return { value: data.subarray(offset + 4, offset + length), next: offset + length };
}

function unpackOicq(packet: Uint8Array, ecdh: ReturnType<typeof createWtEcdh>, peer: Uint8Array) {
    const oicq = Buffer.from(packet);
    expect(oicq[0]).toBe(2);
    expect(oicq.readUInt16BE(1)).toBe(oicq.length);
    expect(oicq.readUInt16BE(5)).toBe(0x812);
    expect(oicq[14]).toBe(0x87);
    const publicLength = oicq.readUInt16BE(46);
    expect(publicLength).toBe(25);
    expect(oicq.subarray(48, 48 + publicLength)).toEqual(Buffer.from(ecdh.publicKey));
    const encrypted = oicq.subarray(48 + publicLength, oicq.length - 1);
    const plaintext = Buffer.from(qqTeaDecrypt(encrypted, ecdh.deriveTeaKey(peer)));
    const inner = plaintext.subarray(14);
    expect(inner[4]).toBe(2);
    expect(inner.readUInt16BE(5)).toBe(inner.length - 4);
    return { oicq, plaintext, inner };
}

function unpack(frame: Uint8Array, ecdh: ReturnType<typeof createWtEcdh>, peer: Uint8Array) {
    const service = Buffer.from(frame);
    expect(service.readUInt32BE(0)).toBe(service.length);
    expect(service.readInt32BE(4)).toBe(12);
    expect(service[8]).toBe(2);
    expect(service.readUInt32BE(9)).toBe(4);
    const uinField = readField(service, 14);
    const sso = Buffer.from(qqTeaDecrypt(service.subarray(uinField.next), new Uint8Array(16)));
    const headLength = sso.readUInt32BE(0);
    const sequence = sso.readInt32BE(4);
    const subAppId = sso.readInt32BE(8);
    let offset = 28;
    const a2 = readField(sso, offset);
    offset = a2.next;
    const command = readField(sso, offset);
    offset = command.next;
    const unknown = readField(sso, offset);
    offset = unknown.next;
    const guid = readField(sso, offset);
    offset = guid.next;
    const unknown2 = readField(sso, offset);
    offset = unknown2.next;
    const versionLength = sso.readUInt16BE(offset);
    const version = sso.subarray(offset + 2, offset + versionLength).toString();
    offset += versionLength;
    const reserved = readField(sso, offset);
    expect(reserved.next).toBe(headLength);
    const body = readField(sso, headLength);
    const { oicq, inner } = unpackOicq(body.value, ecdh, peer);
    return {
        account: uinField.value.toString(),
        sequence,
        subAppId,
        command: command.value.toString(),
        guid: guid.value.toString(),
        version,
        reserved: reserved.value,
        header: sso.subarray(0, headLength),
        oicq,
        inner,
    };
}

function makeContext(): WtQrFrameContext {
    const local = createWtEcdh(key(1));
    const peer = createWtEcdh(key(2));
    return {
        uin: '0',
        sequence: -1,
        timestamp: 1234,
        appId: 1600001615,
        subAppId: 537345891,
        clientVersion: 46494,
        ssoVersion: '3.2.26',
        guid: Uint8Array.of(1, 2),
        unknown21: Uint8Array.from({ length: 21 }, (_, i) => i),
        randomKey: new Uint8Array(16),
        ecdh: local,
        peerPublicKey: peer.publicKey,
        serviceCommand: 'wtlogin.trans_emp',
        buildReserved: async () => Uint8Array.of(7, 8),
    };
}

const fetchFields = {
    packageName: 'test.app',
    ptVersion: '2.0.0',
    miscBitMap: 32764,
    ssoVersion: 19,
    d1: Uint8Array.of(8, 1),
};

describe('WT QR request composition', () => {
    it('builds a standalone poll OICQ without SSO or signer inputs', () => {
        const source = makeContext();
        const context = {
            uin: '72623859790382856',
            timestamp: 1234,
            appId: 0x01020304,
            subAppId: 0x11223344,
            clientVersion: 46494,
            guid: Uint8Array.of(0xab, 0xcd),
            unknown21: source.unknown21,
            randomKey: source.randomKey,
            ecdh: source.ecdh,
            peerPublicKey: source.peerPublicKey,
        };
        const result = buildWtQrOicq(context, {
            type: 'poll',
            qrSig: Uint8Array.of(0xaa, 0xbb, 0xcc),
        });
        const { oicq, plaintext, inner } = unpackOicq(result, context.ecdh, context.peerPublicKey);
        expect(oicq.subarray(0, 26).toString('hex')).toBe(
            '0200aa1f410812000005060708038700000000020000b59e0000',
        );
        expect(plaintext.subarray(0, 14).toString('hex')).toBe('0000480102030400000072000000');
        expect(inner.toString('hex')).toBe(
            '000004d20200440012' +
                '000102030405060708090a0b0c0d0e0f1011121314' +
                '0300000032000000000102030405060708' +
                '0000010203040003aabbcc00000000000000000000000000' +
                '03',
        );
    });

    it('builds the standalone fetch from source-derived synthetic business bytes', () => {
        const context = makeContext();
        context.appId = 0x01020304;
        context.subAppId = 0x11223344;
        context.guid = Uint8Array.of(0xab, 0xcd);
        const fields = {
            packageName: 'é',
            ptVersion: 'x',
            miscBitMap: 0x11223344,
            ssoVersion: 0x55667788,
            d1: Uint8Array.of(8, 1, 0x96),
        };
        const result = buildWtQrOicq(context, { type: 'fetch', fields });
        const { inner } = unpackOicq(result, context.ecdh, context.peerPublicKey);
        expect(inner.readUInt16BE(7)).toBe(0x31);
        expect(inner.subarray(47, -1).toString('hex')).toBe(
            '00000102030400000000000000000000000007' +
                '00160019000000000102030411223344abcd0002c3a90001780002c3a9' +
                '001b001e000000000000000000000003000000040000004800000002000000020000' +
                '001d000a01112233440000000000' +
                '00330002abcd0035000455667788006600045566778800d10003080196',
        );
    });

    it('keeps a constructed OICQ stable and independent from all later input mutations', () => {
        const context = makeContext();
        const qrSig = Uint8Array.of(0xaa, 0xbb, 0xcc);
        const peer = Uint8Array.from(context.peerPublicKey);
        const packet = buildWtQrOicq(context, { type: 'poll', qrSig });
        const snapshot = Uint8Array.from(packet);
        context.guid.fill(0);
        context.unknown21.fill(0xff);
        context.randomKey.fill(0xff);
        context.peerPublicKey.fill(0);
        context.ecdh.publicKey.fill(0);
        qrSig.fill(0);
        expect(Uint8Array.from(packet)).toEqual(snapshot);
        const decoded = unpackOicq(packet, createWtEcdh(key(1)), peer);
        expect(decoded.inner.subarray(9, 30)).toEqual(
            Buffer.from(Array.from({ length: 21 }, (_, i) => i)),
        );
        expect(decoded.inner.subarray(47, -1)).toEqual(
            Buffer.from(
                encodeWtQrPollBody({ appId: 1600001615, qrSig: Uint8Array.of(0xaa, 0xbb, 0xcc) }),
            ),
        );
    });

    it('shares the same plaintext layout between standalone and signed frame construction', async () => {
        const context = makeContext();
        const operation = { type: 'poll' as const, qrSig: Uint8Array.of(9, 8) };
        const standalone = unpackOicq(
            buildWtQrOicq(context, operation),
            context.ecdh,
            context.peerPublicKey,
        );
        let signed = new Uint8Array();

        context.buildReserved = async ({ body }) => {
            signed = Uint8Array.from(body);
            body.fill(0);
            return Uint8Array.of(7, 8);
        };

        const wrapped = unpack(
            await buildWtQrFrame(context, operation),
            context.ecdh,
            context.peerPublicKey,
        );
        expect(wrapped.oicq).toEqual(Buffer.from(signed));
        expect(wrapped.inner).toEqual(standalone.inner);
    });

    it('passes one exact standalone OICQ through the SSO12 client and signer', async () => {
        // The only socket is a synthetic loopback peer; no QQ service is contacted.
        const server = createServer();
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();

        if (!address || typeof address === 'string') {
            throw new Error('invalid test listener');
        }

        const accepted = once(server, 'connection');
        const socket = createConnection({ host: '127.0.0.1', port: address.port });
        const connected = once(socket, 'connect');
        const [peer] = await accepted;
        await connected;
        const decoder = new ServiceFrameDecoder();
        const received = new Promise<Uint8Array>((resolve, reject) => {
            peer.once('close', () => reject(new Error('peer closed before receiving frame')));
            peer.on('data', (chunk: Buffer) => {
                const frames = decoder.push(chunk);

                if (frames.length > 0) {
                    resolve(frames[0]);
                }
            });
        });
        const context = makeContext();
        context.uin = '123';
        const input = buildWtQrOicq(context, { type: 'poll', qrSig: Uint8Array.of(0xaa, 0xbb) });
        const expected = Uint8Array.from(input);
        let signed = Buffer.alloc(0);
        const client = new Sso12PacketClient({
            socket,
            uin: context.uin,
            encryption: { type: 'zero' },
            subAppId: context.subAppId,
            guid: context.guid,
            version: context.ssoVersion,
            a2: new Uint8Array(),
            initialSequence: 15,
            defaultTimeoutMs: 3000,
            classifyIncoming: () => 'response',
            buildReserved: async ({ body }) => {
                signed = Buffer.from(body);
                body.fill(0);
                return Uint8Array.of(7, 8);
            },
        });

        try {
            const pending = client.sendPacket('wtlogin.trans_emp', input);
            input.fill(0);
            const frame = await received;
            const parsed = unpack(frame, context.ecdh, context.peerPublicKey);
            expect(Uint8Array.from(signed)).toEqual(expected);
            expect(Uint8Array.from(parsed.oicq)).toEqual(expected);
            expect(parsed.sequence).toBe(15);
            expect(parsed.account).toBe('123');
            expect(parsed.inner.readUInt16BE(7)).toBe(0x12);
            client.close();
            expect((await pending).success).toBe(false);
        } finally {
            client.close();
            socket.destroy();
            peer.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it('validates standalone inputs and returns an independent writable result', () => {
        const context = makeContext();
        const before = Uint8Array.from(context.unknown21);
        const qrSig = Uint8Array.of(1, 2, 3);
        expect(() =>
            buildWtQrOicq({ ...context, uin: 123 as unknown as string }, { type: 'poll', qrSig }),
        ).toThrow(/account/);
        expect(() =>
            buildWtQrOicq({ ...context, unknown21: new Uint8Array(20) }, { type: 'poll', qrSig }),
        ).toThrow(/unknown/);
        expect(() => buildWtQrOicq(context, { type: 'other' } as never)).toThrow(/operation/);
        const packet = buildWtQrOicq(context, { type: 'poll', qrSig });
        packet.fill(0);
        expect(context.unknown21).toEqual(before);
        expect(qrSig).toEqual(Uint8Array.of(1, 2, 3));
    });

    it('encodes fetch OICQ, signs that exact body, and wraps it in SSO 12', async () => {
        const context = makeContext();
        let before = Buffer.alloc(0);
        const signer = vi.fn(async ({ body }: { body: Uint8Array }) => {
            before = Buffer.from(body);
            body.fill(0);
            context.guid.fill(0);
            context.ssoVersion = 'changed';
            return Uint8Array.of(7, 8);
        });
        context.buildReserved = signer;
        const parsed = unpack(
            await buildWtQrFrame(context, { type: 'fetch', fields: fetchFields }),
            context.ecdh,
            context.peerPublicKey,
        );
        expect(parsed.account).toBe('0');
        expect(parsed.sequence).toBe(-1);
        expect(parsed.subAppId).toBe(537345891);
        expect(parsed.command).toBe('wtlogin.trans_emp');
        expect(parsed.guid).toBe('0102');
        expect(parsed.version).toBe('3.2.26');
        expect(parsed.reserved).toEqual(Buffer.of(7, 8));
        expect(parsed.oicq).toEqual(before);
        expect(signer.mock.calls[0][0]).toMatchObject({
            uin: '0',
            command: 'wtlogin.trans_emp',
            sequence: 0xffffffff,
        });
        expect(parsed.inner.readUInt16BE(7)).toBe(0x31);
        expect(parsed.inner.subarray(9, 30)).toEqual(
            Buffer.from(Array.from({ length: 21 }, (_, i) => i)),
        );
        expect(parsed.inner.subarray(47, -1)).toEqual(
            Buffer.from(
                encodeWtQrFetchBody({
                    ...fetchFields,
                    appId: context.appId,
                    subAppId: context.subAppId,
                    guid: Uint8Array.of(1, 2),
                }),
            ),
        );
    });

    it('encodes the poll body using its distinct command and ticket', async () => {
        const context = makeContext();
        const qrSig = Uint8Array.of(0, 0xff, 7);
        const parsed = unpack(
            await buildWtQrFrame(context, { type: 'poll', qrSig }),
            context.ecdh,
            context.peerPublicKey,
        );
        expect(parsed.inner.readUInt16BE(7)).toBe(0x12);
        expect(parsed.inner.subarray(47, -1)).toEqual(
            Buffer.from(encodeWtQrPollBody({ appId: context.appId, qrSig })),
        );
    });

    it('matches independent synthetic poll, code2d and SSO header byte layouts', async () => {
        const context = makeContext();
        context.uin = '72623859790382856'; // 0x0102030405060708
        context.appId = 0x01020304;
        context.subAppId = 0x11223344;
        context.guid = Uint8Array.of(0xab, 0xcd);
        const parsed = unpack(
            await buildWtQrFrame(context, { type: 'poll', qrSig: Uint8Array.of(0xaa, 0xbb, 0xcc) }),
            context.ecdh,
            context.peerPublicKey,
        );
        // Hand-assembled from WtLogin, BinaryPacket, SsoPacker and ServicePacker.
        // Neither this fixture nor its random ciphertext is real QQ evidence.
        expect(parsed.inner.toString('hex')).toBe(
            '000004d20200440012' +
                '000102030405060708090a0b0c0d0e0f1011121314' +
                '0300000032000000000102030405060708' +
                '0000010203040003aabbcc00000000000000000000000000' +
                '03',
        );
        expect(parsed.oicq.subarray(0, 26).toString('hex')).toBe(
            '0200aa1f410812000005060708038700000000020000b59e0000',
        );
        expect(parsed.account).toBe('72623859790382856');
        expect(parsed.header.toString('hex')).toBe(
            '00000053ffffffff1122334400000804' +
                '020000000000000000000000' +
                '00000004' +
                '0000001577746c6f67696e2e7472616e735f656d70' +
                '00000004' +
                '0000000861626364' +
                '00000004' +
                '0008332e322e3236' +
                '000000060708',
        );
    });

    it('rejects malformed profiles before calling the signer', async () => {
        const context = makeContext();
        const signer = vi.fn(async () => Uint8Array.of(1));
        context.buildReserved = signer;

        for (const bad of [
            { uin: '01' },
            { uin: 123 as unknown as string },
            { uin: 123n as unknown as string },
            { uin: '9223372036854775808' },
            { sequence: 0x80000000 },
            { subAppId: 0x80000000 },
            { ssoVersion: '' },
            { guid: new Uint8Array() },
            { serviceCommand: '' },
            { ecdh: { ...context.ecdh, publicKey: new Uint8Array() } },
        ]) {
            await expect(
                buildWtQrFrame({ ...context, ...bad }, { type: 'poll', qrSig: Uint8Array.of(1) }),
            ).rejects.toThrow();
        }

        expect(signer).not.toHaveBeenCalled();
    });

    it('retains the original account and bytes while the signer is pending', async () => {
        const context = makeContext();
        context.uin = '123';
        context.sequence = 42;
        const qrSig = Uint8Array.of(0xaa, 0xbb, 0xcc);
        const originalKey = Uint8Array.from(context.randomKey);
        const originalUnknown = Uint8Array.from(context.unknown21);
        const before = {
            guid: Uint8Array.from(context.guid),
            peer: Uint8Array.from(context.peerPublicKey),
            qrSig: Uint8Array.from(qrSig),
        };
        let release!: (value: Uint8Array) => void;
        let signed = new Uint8Array();

        context.buildReserved = (request) => {
            signed = Uint8Array.from(request.body);
            return new Promise((resolve) => {
                release = resolve;
            });
        };

        const pending = buildWtQrFrame(context, { type: 'poll', qrSig });
        context.uin = '456';
        context.sequence = 99;
        context.subAppId = 1;
        context.serviceCommand = 'changed';
        context.ssoVersion = 'changed';
        context.guid.fill(0);
        context.unknown21.fill(0xff);
        context.randomKey.fill(0xff);
        context.peerPublicKey.fill(0);
        context.ecdh.publicKey.fill(0);
        qrSig.fill(0);
        release(Uint8Array.of(7, 8));
        const parsed = unpack(await pending, createWtEcdh(key(1)), before.peer);
        expect(parsed.account).toBe('123');
        expect(parsed.sequence).toBe(42);
        expect(parsed.command).toBe('wtlogin.trans_emp');
        expect(parsed.subAppId).toBe(537345891);
        expect(parsed.guid).toBe(Buffer.from(before.guid).toString('hex'));
        expect(parsed.version).toBe('3.2.26');
        expect(parsed.oicq).toEqual(Buffer.from(signed));
        expect(parsed.oicq.subarray(28, 44)).toEqual(Buffer.from(originalKey));
        expect(parsed.inner.subarray(9, 30)).toEqual(Buffer.from(originalUnknown));
        expect(parsed.inner.subarray(47, -1)).toEqual(
            Buffer.from(encodeWtQrPollBody({ appId: 1600001615, qrSig: before.qrSig })),
        );
    });

    it('propagates signer failures and rejects non-byte reserved results', async () => {
        const context = makeContext();

        context.buildReserved = async () => {
            throw new Error('signer error');
        };

        await expect(
            buildWtQrFrame(context, { type: 'poll', qrSig: Uint8Array.of(1) }),
        ).rejects.toThrow('signer error');
        context.buildReserved = async () => 'invalid' as never;
        await expect(
            buildWtQrFrame(context, { type: 'poll', qrSig: Uint8Array.of(1) }),
        ).rejects.toThrow(/reserved/);
    });
});
