import { createConnection, createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import type { DirectSsoReserve } from '@snowluma/proto-defs/sso-reserve';
import { protobuf_decode } from '@snowluma/proton';
import { expect, it, vi } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createSsoReserveBuilder, type SsoSigningRequest } from '../../src/direct/sso-reserve';
import { ServiceFrameDecoder } from '../../src/direct/service-stream';
import { TcpPacketClient } from '../../src/direct/tcp-packet-client';

const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const uin = '123456';

function field(data: Uint8Array): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length + 4);
    return Buffer.concat([length, data]);
}

function int(value: number): Buffer {
    const data = Buffer.alloc(4);
    data.writeInt32BE(value);
    return data;
}

function response(sequence: number, command: string): Buffer {
    const header = Buffer.concat([
        int(sequence),
        int(0),
        field(Buffer.alloc(0)),
        field(Buffer.from(command)),
        field(Buffer.alloc(0)),
        int(0),
        field(Buffer.alloc(0)),
    ]);
    const body = Buffer.concat([field(header), field(Buffer.from('ok'))]);
    const encrypted = qqTeaEncrypt(body, key);
    const uinBytes = Buffer.from(uin);
    return Buffer.concat([
        int(14 + uinBytes.length + encrypted.length),
        int(13),
        Buffer.of(1, 0),
        field(uinBytes),
        encrypted,
    ]);
}

it('places caller-signed metadata in an isolated TCP request', async () => {
    const observed: DirectSsoReserve[] = [];
    const observedBodies: Buffer[] = [];
    const peers: Socket[] = [];
    const server = createServer((peer) => {
        peers.push(peer);
        const decoder = new ServiceFrameDecoder();
        peer.on('data', (chunk) => {
            for (const frame of decoder.push(chunk)) {
                const wire = Buffer.from(frame);
                const sequence = wire.readInt32BE(9);
                const accountLength = wire.readUInt32BE(14);
                const plain = Buffer.from(qqTeaDecrypt(wire.subarray(14 + accountLength), key));
                const headerLength = plain.readUInt32BE(0);
                const commandLength = plain.readUInt32BE(4);
                const command = plain.subarray(8, 4 + commandLength).toString();
                const cookieOffset = 4 + commandLength;
                const reserveOffset = cookieOffset + plain.readUInt32BE(cookieOffset);
                const reserveLength = plain.readUInt32BE(reserveOffset);
                observed.push(
                    protobuf_decode<DirectSsoReserve>(
                        plain.subarray(reserveOffset + 4, reserveOffset + reserveLength),
                    ),
                );
                observedBodies.push(Buffer.from(plain.subarray(headerLength + 4)));
                peer.write(response(sequence, command));
            }
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();

    if (!address || typeof address === 'string') {
        throw new Error('missing address');
    }

    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    await once(socket, 'connect');
    const signer = vi.fn(async (_request: SsoSigningRequest) => ({
        sign: Uint8Array.of(1),
        token: Uint8Array.of(2),
        extra: Uint8Array.of(3),
    }));
    const client = new TcpPacketClient({
        socket,
        uin,
        d2Key: key,
        buildReserved: createSsoReserveBuilder({
            uin,
            uid: 'u',
            classifySigning: () => 'sign',
            sign: signer,
            createTraceParent: () => 't',
        }),
        classifyIncoming: () => 'response',
    });

    try {
        expect(await client.sendPacket('demo', Buffer.from([0xde, 0xad]))).toMatchObject({
            success: true,
            responseData: Buffer.from('ok'),
        });
        expect(signer).toHaveBeenCalledOnce();
        expect(signer.mock.calls[0][0]).toMatchObject({
            uin,
            command: 'demo',
            sequence: 1,
            body: Uint8Array.of(0xde, 0xad),
        });
        expect(observed).toHaveLength(1);
        expect(observed[0].uid).toBe('u');
        expect(Buffer.from(observed[0].secureInfo?.sign ?? [])).toEqual(Buffer.from([1]));
        expect(observedBodies).toEqual([Buffer.from([0xde, 0xad])]);
    } finally {
        client.close();

        for (const peer of peers) {
            peer.destroy();
        }

        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
