import { once } from 'node:events';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { ServiceFrameDecoder } from '../../src/direct/service-stream';
import { Sso12PacketClient } from '../../src/direct/sso12-packet-client';
import { composeTargetResponseCandidateWithLookup } from '../../src/direct/target-response-candidate';
import { encodeTargetServiceBusiness } from '../../src/direct/target-service-business';
import { encodeTargetServiceRequest } from '../../src/direct/target-service-request';
import { encodeTargetSso12Head } from '../../src/direct/target-sso12-head';
import { encodeTargetSso12Reserve } from '../../src/direct/target-sso12-reserve';

// Synthetic loopback only: this key, verifier, and response are not QQ material,
// authentication, request/response sequence binding, or interoperability evidence.
const key = Uint8Array.from({ length: 16 }, (_, i) => i);
const random = (length: number) => new Uint8Array(length).fill(0x51);
const field2 = Uint8Array.of(0xff, 0, 0x80);
const sockets: Socket[] = [];
const servers: Server[] = [];
const clients: Sso12PacketClient[] = [];
const errors: Error[] = [];
type Candidate = ReturnType<typeof composeTargetResponseCandidateWithLookup>;

function clearCandidate(value: Candidate): void {
    for (const bytes of [
        value.basic.opaque,
        value.head.field1,
        value.head.field2,
        value.head.field3,
        value.head.reserve,
        value.head.tail,
        value.body,
        value.trailing,
    ]) {
        bytes.fill(0);
        expect(bytes.every((byte) => byte === 0)).toBe(true);
    }
}

function request(sequence: number): Uint8Array {
    const reserved = encodeTargetSso12Reserve({
        field13: new Uint8Array(),
        field23: [{ field1: new Uint8Array(), field2: new Uint8Array() }],
    });
    const head = encodeTargetSso12Head({
        sequence,
        arg0: 0xa1a2a3a4,
        arg4: 0x11223344,
        arg8: 0x7f,
        a2: Uint8Array.of(0xaa, 0xbb),
        requestCommand: Uint8Array.of(0, 0xff, 0x41),
        this8: Uint8Array.of(0x80),
        arg28: new Uint8Array(),
        this20: Uint8Array.of(0x11, 0x22),
        versionArg10: Uint8Array.of(0, 1),
        reserved,
    });
    return encodeTargetServiceRequest({
        sourceCommand: 'wtlogin64.login',
        virtualProtocol: 0x01020304,
        basicBranch: { virtualResultByte: 0, kind: 'span', span: Uint8Array.of(0xaa, 0xbb, 0xcc) },
        requestObjectByte: 0x7f,
        uin: '42é',
        head,
        busi: encodeTargetServiceBusiness(Uint8Array.of(1, 0xff, 0, 0x72, 0x90)),
        targetTeaKey: key,
        randomSource: random,
    });
}

function checkRequest(frame: Uint8Array): void {
    const wire = Buffer.from(frame);
    expect(wire.length).toBe(121);
    expect(wire.readUInt32BE(0)).toBe(121);
    expect(wire.readUInt32BE(4)).toBe(0x01020304);
    expect(wire[8]).toBe(2);
    expect(wire.readUInt32BE(9)).toBe(7);
    expect(wire.subarray(13, 16).toString('hex')).toBe('aabbcc');
    expect(wire[16]).toBe(0x7f);
    expect(wire.readUInt32BE(17)).toBe(8);
    expect(wire.subarray(21, 25).toString('hex')).toBe('3432c3a9');
    const plain = Buffer.from(qqTeaDecrypt(wire.subarray(25), key));
    expect(plain.length).toBe(82);
    expect(plain.readUInt32BE(0)).toBe(73);
    expect(plain.readUInt32BE(4)).toBe(1);
    expect(plain.readUInt32BE(8)).toBe(0xa1a2a3a4);
    expect(plain.readUInt32BE(12)).toBe(0x11223344);
    expect(plain.subarray(16, 28).toString('hex')).toBe('000000000000000000007f00');
    expect(plain.subarray(28, 34).toString('hex')).toBe('00000006aabb');
    expect(plain.subarray(34, 41).toString('hex')).toBe('0000000700ff41');
    expect(plain.subarray(41, 46).toString('hex')).toBe('0000000580');
    expect(plain.subarray(46, 50).toString('hex')).toBe('00000004');
    expect(plain.subarray(50, 56).toString('hex')).toBe('000000061122');
    expect(plain.subarray(56, 60).toString('hex')).toBe('00040001');
    expect(plain.subarray(60, 73).toString('hex')).toBe('0000000d6a00ba01040a001200');
    expect(plain.subarray(73).toString('hex')).toBe('0000000901ff007290');
}

function response(hit: boolean): Buffer {
    // Entire response plaintext is a literal, including an empty reserve and
    // binary field2. The optional four bytes are synthetic lookup fixture data.
    const head = Buffer.from(
        '0000002880000001fedcba9800000006ff0000000007ff008000000005420000000000000004dead',
        'hex',
    );
    const business = Buffer.from(
        hit ? 'aabbccdd0000000811223344cafe' : '0000000811223344cafe',
        'hex',
    );
    const ciphertext = qqTeaEncrypt(Buffer.concat([head, business]), key, random);
    // The leading word equals frame length only for the local stream decoder.
    const frame = Buffer.concat([
        Buffer.from('000000008765432101a500000006beef', 'hex'),
        ciphertext,
    ]);
    frame.writeUInt32BE(frame.length, 0);
    return frame;
}

async function setup(hit: boolean, order: string[]) {
    const server = createServer();
    servers.push(server);
    server.on('error', (error) => errors.push(error));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();

    if (!address || typeof address === 'string') {
        throw new Error('missing loopback address');
    }

    const incoming = once(server, 'connection');
    const socket = createConnection({ host: '127.0.0.1', port: address.port });
    sockets.push(socket);
    socket.on('error', (error) => errors.push(error));
    await once(socket, 'connect');
    const [peer] = (await incoming) as [Socket];
    sockets.push(peer);
    peer.on('error', (error) => errors.push(error));
    const decoder = new ServiceFrameDecoder();
    const fixture = response(hit);
    const responseHex = fixture.toString('hex');
    let requestHex = '';
    peer.on('data', (chunk) => {
        try {
            for (const frame of decoder.push(chunk)) {
                checkRequest(frame);
                requestHex = Buffer.from(frame).toString('hex');
                order.push('peer-received');
                peer.write(fixture.subarray(0, 3));
                peer.write(fixture.subarray(3));
                order.push('peer-wrote');
            }
        } catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
            peer.destroy();
        }
    });
    const classify = vi.fn(() => 'response' as const);
    const verifyUin = vi.fn(() => true);
    const client = new Sso12PacketClient({
        socket,
        uin: '123456',
        encryption: { type: 'zero' },
        subAppId: 42,
        guid: Uint8Array.of(1, 2),
        version: 'fixture',
        a2: new Uint8Array(),
        buildReserved: async () => new Uint8Array(),
        classifyIncoming: classify,
        verifyResponseUin: verifyUin,
    });
    clients.push(client);
    return {
        client,
        classify,
        verifyUin,
        responseHex,
        getRequestHex: () => requestHex,
        frameLength: fixture.length,
    };
}

afterEach(async () => {
    for (const client of clients.splice(0)) {
        client.close();
    }

    for (const socket of sockets.splice(0)) {
        socket.destroy();
    }

    await Promise.all(
        servers.splice(0).map(
            (server) =>
                new Promise<void>((resolve, reject) => {
                    server.close((error) => (error ? reject(error) : resolve()));
                }),
        ),
    );
    expect(errors.splice(0)).toEqual([]);
}, 5000);

describe('synthetic target request and lookup over raw loopback', () => {
    it.each([true, false])(
        'publishes the verified lookup candidate after raw success (hit=%s)',
        async (hit) => {
            const order: string[] = [];
            const peer = await setup(hit, order);
            let verified: Uint8Array | undefined;
            let consumed: Uint8Array | undefined;
            const published: Candidate[] = [];
            const compose = vi.fn(composeTargetResponseCandidateWithLookup);
            const result = await peer.client.transactRaw({
                timeoutMs: 2000,
                buildRequest: (identity) => {
                    expect(identity).toEqual({ uin: '123456', sequence: 1 });
                    const frame = request(identity.sequence);
                    return { frame, context: { frameHex: Buffer.from(frame).toString('hex') } };
                },
                verifyCandidate: (bytes, context) => {
                    order.push('verify');
                    verified = bytes;
                    expect(context.frameHex).toBe(peer.getRequestHex());
                    expect(Buffer.from(bytes).toString('hex')).toBe(peer.responseHex);
                    bytes.fill(0x44);
                    return true;
                },
                consumeCandidate: (bytes, context) => {
                    order.push('consume');
                    consumed = bytes;
                    expect(bytes).not.toBe(verified);
                    expect(context.frameHex).toBe(peer.getRequestHex());
                    expect(Buffer.from(bytes).toString('hex')).toBe(peer.responseHex);
                    return compose(
                        bytes,
                        hit ? [Uint8Array.of(9), field2] : [Uint8Array.of(0xff, 0, 0x81)],
                        'reject',
                        16,
                        key,
                    );
                },
            });
            expect(result.kind).toBe('response');

            if (result.kind !== 'response') {
                throw new Error('expected response');
            }

            try {
                expect(published).toEqual([]);
                published.push(result.value);
                expect(result.sequence).toBe(1);
                expect(result.writeState).toBe('written');
                expect(result.value).toEqual({
                    kind: 'unverified-response-candidate',
                    basic: {
                        word0: peer.frameLength,
                        word4: 0x87654321,
                        selector: 1,
                        flag9: 0xa5,
                        opaque: Uint8Array.of(0xbe, 0xef),
                        nextOffset: 16,
                    },
                    head: {
                        headLength: 40,
                        sequenceBits: 0x80000001,
                        followingWord: 0xfedcba98,
                        field1: Uint8Array.of(0xff, 0),
                        field2,
                        field3: Uint8Array.of(0x42),
                        flagsWord: 0,
                        reserve: new Uint8Array(),
                        tail: Uint8Array.of(0xde, 0xad),
                        nextOffset: 40,
                    },
                    lookupMatched: hit,
                    skip: hit ? 4 : 0,
                    businessOffset: hit ? 44 : 40,
                    nextOffset: hit ? 52 : 48,
                    compression: 'none',
                    body: Uint8Array.of(0x11, 0x22, 0x33, 0x44),
                    trailing: Uint8Array.of(0xca, 0xfe),
                });
                expect(compose).toHaveBeenCalledOnce();
                expect(verified?.every((byte) => byte === 0)).toBe(true);
                expect(consumed?.every((byte) => byte === 0)).toBe(true);
                expect(peer.classify).not.toHaveBeenCalled();
                expect(peer.verifyUin).not.toHaveBeenCalled();
                expect(order).toEqual(['peer-received', 'peer-wrote', 'verify', 'consume']);
            } finally {
                clearCandidate(result.value);
            }
        },
        10000,
    );

    it.each([false, 'truthy'] as const)(
        'rejects verifier verdict %s before consumer/composer',
        async (verdict) => {
            const order: string[] = [];
            const peer = await setup(true, order);
            let verified: Uint8Array | undefined;
            const published: Candidate[] = [];
            const compose = vi.fn(composeTargetResponseCandidateWithLookup);
            const consume = vi.fn((bytes: Uint8Array) =>
                compose(bytes, [field2], 'reject', 16, key),
            );
            const result = await peer.client.transactRaw({
                timeoutMs: 2000,
                buildRequest: (identity) => {
                    const frame = request(identity.sequence);
                    return { frame, context: { frameHex: Buffer.from(frame).toString('hex') } };
                },
                verifyCandidate: (bytes, context) => {
                    verified = bytes;
                    expect(context.frameHex).toBe(peer.getRequestHex());
                    expect(Buffer.from(bytes).toString('hex')).toBe(peer.responseHex);
                    return verdict as unknown as boolean;
                },
                consumeCandidate: consume,
            });

            if (result.kind === 'response') {
                published.push(result.value);
            }

            expect(result).toEqual({
                kind: 'failure',
                code: 'raw-rejected',
                writeState: 'unknown',
            });
            expect(verified?.every((byte) => byte === 0)).toBe(true);
            expect(consume).not.toHaveBeenCalled();
            expect(compose).not.toHaveBeenCalled();
            expect(published).toEqual([]);
            expect(peer.classify).not.toHaveBeenCalled();
            expect(peer.verifyUin).not.toHaveBeenCalled();
            expect(order).toEqual(['peer-received', 'peer-wrote']);
            expect((await peer.client.whenClosed).code).toBe('raw-rejected');
        },
        10000,
    );

    it('discards a privately staged lookup result on abort during the consumer', async () => {
        const order: string[] = [];
        const peer = await setup(true, order);
        const controller = new AbortController();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let markEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
            markEntered = resolve;
        });
        let markSettled!: () => void;
        const settled = new Promise<void>((resolve) => {
            markSettled = resolve;
        });
        let verified: Uint8Array | undefined;
        let consumed: Uint8Array | undefined;
        let staged: Candidate | undefined;
        const published: Candidate[] = [];
        const compose = vi.fn(composeTargetResponseCandidateWithLookup);
        const consume = vi.fn(async (bytes: Uint8Array) => {
            consumed = bytes;

            try {
                expect(bytes).not.toBe(verified);
                expect(Buffer.from(bytes).toString('hex')).toBe(peer.responseHex);
                staged = compose(bytes, [field2], 'reject', 16, key);
                markEntered();
                await gate;
                return staged;
            } finally {
                markSettled();
            }
        });
        const transaction = peer.client.transactRaw({
            timeoutMs: 2000,
            signal: controller.signal,
            buildRequest: (identity) => {
                const frame = request(identity.sequence);
                return { frame, context: { frameHex: Buffer.from(frame).toString('hex') } };
            },
            verifyCandidate: (bytes, context) => {
                verified = bytes;
                expect(context.frameHex).toBe(peer.getRequestHex());
                expect(Buffer.from(bytes).toString('hex')).toBe(peer.responseHex);
                bytes.fill(0x44);
                return true;
            },
            consumeCandidate: consume,
        });

        try {
            await Promise.race([
                entered,
                transaction.then(() => {
                    throw new Error('transaction ended before consumer entered');
                }),
            ]);
            expect(staged?.skip).toBe(4);
            expect(staged?.body).toEqual(Uint8Array.of(0x11, 0x22, 0x33, 0x44));
            controller.abort();
            const result = await transaction;

            if (result.kind === 'response') {
                published.push(result.value);
            }

            expect(result).toEqual({
                kind: 'failure',
                code: 'raw-cancelled',
                writeState: 'unknown',
            });
            expect(published).toEqual([]);
            // Observe transport-owned callback copies before any caller cleanup.
            expect(verified?.every((byte) => byte === 0)).toBe(true);
            expect(consumed?.every((byte) => byte === 0)).toBe(true);
            expect(compose).toHaveBeenCalledOnce();
            expect(consume).toHaveBeenCalledOnce();
            expect(peer.classify).not.toHaveBeenCalled();
            expect(peer.verifyUin).not.toHaveBeenCalled();
            expect(order).toEqual(['peer-received', 'peer-wrote']);
            expect((await peer.client.whenClosed).code).toBe('raw-cancelled');
        } finally {
            controller.abort();
            release();
            await transaction;

            if (consume.mock.calls.length) {
                await settled;
            }

            if (staged) {
                clearCandidate(staged);
            }

            expect(published).toEqual([]);
        }
    }, 10000);
});
