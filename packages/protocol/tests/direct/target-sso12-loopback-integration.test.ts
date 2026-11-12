import { once } from 'node:events';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qqTeaEncrypt } from '../../src/direct/qq-tea';
import { ServiceFrameDecoder } from '../../src/direct/service-stream';
import { Sso12PacketClient } from '../../src/direct/sso12-packet-client';
import { decodeTargetServiceResponseBasic } from '../../src/direct/target-service-response-basic';
import { decodeTargetServiceDecryptCandidate } from '../../src/direct/target-service-decrypt-candidate';
import { decodeTargetSso12ResponseHead } from '../../src/direct/target-sso12-response-head';
import { decodeTargetServiceBusinessResponse } from '../../src/direct/target-service-business-response';
import { inflateTargetZlibCandidate } from '../../src/direct/target-zlib-candidate';
import { composeTargetResponseCandidate } from '../../src/direct/target-response-candidate';

// Synthetic loopback composition, not peer authentication or QQ compatibility.
// ServiceFrameDecoder requires the first BE32 to be the full frame length, so
// basic.word0 is set to that length solely for transport. The observed native
// basic parser does not compare that word to the input length. This fixture does
// not model ReserveFields or the conditional +4 path; it chooses no extra offset.
// The head tail stays opaque and is not automatically authenticated. The compare
// callback below is a synthetic fixture policy, not real identity verification.
const key = Uint8Array.from({ length: 16 }, (_, i) => i);
const request = Buffer.from('000000120102030405060708090a0b0c0d0e', 'hex');
const payload = Uint8Array.of(0, 0xff, 0x42, 0x80);
const compressed = Uint8Array.from(deflateSync(payload));
const sockets: Socket[] = [];
const servers: Server[] = [];
const clients: Sso12PacketClient[] = [];
const errors: Error[] = [];

function word(value: number): Buffer {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value);
    return result;
}

function field(bytes: Uint8Array): Buffer {
    return Buffer.concat([word(bytes.length + 4), bytes]);
}

function response(corruption: 'none' | 'cipher' | 'head' = 'none'): Buffer {
    const fields = Buffer.concat([
        word(0x80000001),
        word(0xfedcba98),
        field(Uint8Array.of(0xff, 0)),
        field(Uint8Array.of(0x80)),
        field(Uint8Array.of(1, 2, 3)),
        word(0xfedcba99),
        field(Uint8Array.of(0x81, 0x82)),
        Buffer.from([0xde, 0xad, 0x7e]),
    ]);
    const head = Buffer.concat([word(fields.length + 4), fields]);

    if (corruption === 'head') {
        head.writeUInt32BE(3, 12);
    }

    const plaintext = Buffer.concat([head, field(compressed), Buffer.from([0xca, 0xfe])]);
    let ciphertext = qqTeaEncrypt(plaintext, key, (length) => new Uint8Array(length).fill(0x5a));

    if (corruption === 'cipher') {
        ciphertext = ciphertext.slice(0, -1); // Invalid alignment, deterministically rejected.
    }

    const basic = Buffer.concat([
        word(0),
        word(0x87654321),
        Buffer.from([1, 0xa5]),
        field(Uint8Array.of(0xbe, 0xef)),
    ]);
    const frame = Buffer.concat([basic, ciphertext]);
    frame.writeUInt32BE(frame.length);
    return frame;
}

async function setup(candidate: Buffer, order: string[]): Promise<Sso12PacketClient> {
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
    peer.on('data', (chunk) => {
        try {
            for (const received of decoder.push(chunk)) {
                order.push(
                    Buffer.from(received).equals(request) ? 'peer-received' : 'wrong-request',
                );
                peer.write(candidate.subarray(0, 3));
                peer.write(candidate.subarray(3));
                order.push('peer-wrote');
            }
        } catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
            peer.destroy();
        }
    });
    const client = new Sso12PacketClient({
        socket,
        uin: '123456',
        encryption: { type: 'zero' },
        subAppId: 42,
        guid: Uint8Array.of(1, 2),
        version: 'fixture',
        a2: new Uint8Array(),
        buildReserved: async () => new Uint8Array(),
        classifyIncoming: () => 'response',
    });
    clients.push(client);
    return client;
}

afterEach(async () => {
    for (const client of clients.splice(0)) {
        client.close();
    }

    for (const socket of sockets.splice(0)) {
        socket.destroy();
    }

    await Promise.all(
        servers
            .splice(0)
            .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    expect(errors.splice(0)).toEqual([]);
}, 5000);

describe('synthetic target response over SSO12 raw loopback', () => {
    it('composes the independently checked candidate before publishing the raw response', async () => {
        const candidate = response();
        const expectedHex = candidate.toString('hex');
        const order: string[] = [];
        const client = await setup(candidate, order);
        let verifiedCopy: Uint8Array | undefined;
        let consumedCopy: Uint8Array | undefined;
        const published: ReturnType<typeof composeTargetResponseCandidate>[] = [];
        const result = await client.transactRaw({
            timeoutMs: 2000,
            buildRequest: () => ({ frame: request, context: null }),
            verifyCandidate: (bytes) => {
                verifiedCopy = bytes;
                expect(Buffer.from(bytes).toString('hex')).toBe(expectedHex);
                bytes.fill(0x44);
                return true;
            },
            consumeCandidate: (bytes) => {
                consumedCopy = bytes;
                expect(Buffer.from(bytes).toString('hex')).toBe(expectedHex);
                return composeTargetResponseCandidate(
                    bytes,
                    0,
                    'node-zlib-strict',
                    payload.length,
                    key,
                );
            },
        });
        expect(result.kind).toBe('response');

        if (result.kind !== 'response') {
            throw new Error('expected synthetic response');
        }

        try {
            published.push(result.value);
            expect(published).toHaveLength(1);
            expect(result.value).toEqual({
                kind: 'unverified-response-candidate',
                basic: {
                    word0: candidate.length,
                    word4: 0x87654321,
                    selector: 1,
                    flag9: 0xa5,
                    opaque: Uint8Array.of(0xbe, 0xef),
                    nextOffset: 16,
                },
                head: {
                    headLength: 43,
                    sequenceBits: 0x80000001,
                    followingWord: 0xfedcba98,
                    field1: Uint8Array.of(0xff, 0),
                    field2: Uint8Array.of(0x80),
                    field3: Uint8Array.of(1, 2, 3),
                    flagsWord: 0xfedcba99,
                    reserve: Uint8Array.of(0x81, 0x82),
                    tail: Uint8Array.of(0xde, 0xad, 0x7e),
                    nextOffset: 43,
                },
                businessOffset: 43,
                nextOffset: 47 + compressed.length,
                compression: 'node-zlib-strict',
                body: payload,
                trailing: Uint8Array.of(0xca, 0xfe),
            });
            expect(result.writeState).toBe('written');
            expect(verifiedCopy?.every((byte) => byte === 0)).toBe(true);
            expect(consumedCopy?.every((byte) => byte === 0)).toBe(true);
            expect(order).toEqual(['peer-received', 'peer-wrote']);
        } finally {
            for (const bytes of [
                result.value.basic.opaque,
                result.value.head.field1,
                result.value.head.field2,
                result.value.head.field3,
                result.value.head.reserve,
                result.value.head.tail,
                result.value.body,
                result.value.trailing,
            ]) {
                bytes.fill(0);
            }
        }
    }, 10000);

    it.each([false, 'truthy'] as const)(
        'short-circuits consumer and real composer when verifier returns %s',
        async (verdict) => {
            const candidate = response();
            const expectedHex = candidate.toString('hex');
            const order: string[] = [];
            const client = await setup(candidate, order);
            const compose = vi.fn(composeTargetResponseCandidate);
            const consume = vi.fn((bytes: Uint8Array) =>
                compose(bytes, 0, 'node-zlib-strict', payload.length, key),
            );
            const verify = vi.fn((bytes: Uint8Array) => {
                expect(Buffer.from(bytes).toString('hex')).toBe(expectedHex);
                return verdict as unknown as boolean;
            });
            const result = await client.transactRaw({
                timeoutMs: 2000,
                buildRequest: () => ({ frame: request, context: null }),
                verifyCandidate: verify,
                consumeCandidate: consume,
            });
            expect(result).toEqual({
                kind: 'failure',
                code: 'raw-rejected',
                writeState: 'unknown',
            });
            expect(verify).toHaveBeenCalledOnce();
            expect(consume).not.toHaveBeenCalled();
            expect(compose).not.toHaveBeenCalled();
            expect(order).toEqual(['peer-received', 'peer-wrote']);
            expect((await client.whenClosed).code).toBe('raw-rejected');
        },
        10000,
    );

    it('discards caller-staged composition after cancellation during an asynchronous consumer', async () => {
        const candidate = response();
        const expectedHex = candidate.toString('hex');
        const order: string[] = [];
        const client = await setup(candidate, order);
        const write = vi.spyOn(sockets[sockets.length - 2], 'write');
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
        let verifiedCopy: Uint8Array | undefined;
        let consumedCopy: Uint8Array | undefined;
        let staged: ReturnType<typeof composeTargetResponseCandidate> | undefined;
        const published: ReturnType<typeof composeTargetResponseCandidate>[] = [];
        const compose = vi.fn(composeTargetResponseCandidate);
        const consume = vi.fn(async (bytes: Uint8Array) => {
            consumedCopy = bytes;

            try {
                expect(Buffer.from(bytes).toString('hex')).toBe(expectedHex);
                staged = compose(bytes, 0, 'node-zlib-strict', payload.length, key);
                markEntered();
                await gate;
                return staged;
            } finally {
                markSettled();
            }
        });
        const transaction = client.transactRaw({
            timeoutMs: 2000,
            signal: controller.signal,
            buildRequest: () => ({ frame: request, context: null }),
            verifyCandidate: (bytes) => {
                verifiedCopy = bytes;
                expect(Buffer.from(bytes).toString('hex')).toBe(expectedHex);
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
            expect(compose).toHaveBeenCalledOnce();
            expect(staged?.body).toEqual(payload);
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
            // Observe transport-owned callback copies before caller cleanup.
            expect(verifiedCopy?.every((byte) => byte === 0)).toBe(true);
            expect(consumedCopy?.every((byte) => byte === 0)).toBe(true);
            expect(write).toHaveBeenCalledOnce();
            expect(consume).toHaveBeenCalledOnce();
            expect(order).toEqual(['peer-received', 'peer-wrote']);
            expect((await client.whenClosed).code).toBe('raw-cancelled');
        } finally {
            controller.abort();
            release();
            await transaction;

            if (consume.mock.calls.length > 0) {
                await settled;
            }

            if (staged) {
                for (const bytes of [
                    staged.basic.opaque,
                    staged.head.field1,
                    staged.head.field2,
                    staged.head.field3,
                    staged.head.reserve,
                    staged.head.tail,
                    staged.body,
                    staged.trailing,
                ]) {
                    bytes.fill(0);
                    expect(bytes.every((byte) => byte === 0)).toBe(true);
                }
            }

            verifiedCopy?.fill(0);
            consumedCopy?.fill(0);
            expect(published).toEqual([]);
            expect(write).toHaveBeenCalledOnce();
            expect(consume).toHaveBeenCalledOnce();
        }
    }, 10000);

    it('writes the fake request before fixture comparison and real decoding', async () => {
        const candidate = response();
        const order: string[] = [];
        const client = await setup(candidate, order);
        let verifiedCopy: Uint8Array | undefined;
        let consumedCopy: Uint8Array | undefined;
        const result = await client.transactRaw({
            timeoutMs: 2000,
            buildRequest: (identity) => {
                order.push('build');
                expect(identity.sequence).toBe(1);
                return { frame: request, context: { marker: 7 } };
            },
            verifyCandidate: (bytes, context) => {
                order.push('verify');
                verifiedCopy = bytes;
                const matches = Buffer.from(bytes).equals(candidate) && context.marker === 7;
                bytes.fill(0x44); // Consumer receives a separate copy.
                return matches;
            },
            consumeCandidate: (bytes) => {
                order.push('consume');
                consumedCopy = bytes;
                expect(Buffer.from(bytes)).toEqual(candidate);
                const basic = decodeTargetServiceResponseBasic(bytes);
                const decoded = decodeTargetServiceDecryptCandidate(
                    basic.selector,
                    bytes.subarray(basic.nextOffset),
                    key,
                );
                const head = decodeTargetSso12ResponseHead(decoded.data);
                const business = decodeTargetServiceBusinessResponse(decoded.data, head.nextOffset);
                const inflated = inflateTargetZlibCandidate(business.body, payload.length);
                return {
                    basic,
                    head,
                    business,
                    inflated,
                    trailing: decoded.data.slice(business.nextOffset),
                };
            },
        });
        expect(order).toEqual(['build', 'peer-received', 'peer-wrote', 'verify', 'consume']);
        expect(result.kind).toBe('response');

        if (result.kind !== 'response') {
            throw new Error('expected synthetic response');
        }

        expect(result.sequence).toBe(1);
        expect(result.writeState).toBe('written');
        expect(result.value.basic).toEqual({
            word0: candidate.length,
            word4: 0x87654321,
            selector: 1,
            flag9: 0xa5,
            opaque: Uint8Array.of(0xbe, 0xef),
            nextOffset: 16,
        });
        expect(result.value.head).toEqual({
            headLength: 43,
            sequenceBits: 0x80000001,
            followingWord: 0xfedcba98,
            field1: Uint8Array.of(0xff, 0),
            field2: Uint8Array.of(0x80),
            field3: Uint8Array.of(1, 2, 3),
            flagsWord: 0xfedcba99,
            reserve: Uint8Array.of(0x81, 0x82),
            tail: Uint8Array.of(0xde, 0xad, 0x7e),
            nextOffset: 43,
        });
        expect(result.value.business).toEqual({
            body: compressed,
            nextOffset: 47 + compressed.length,
        });
        expect(result.value.inflated).toEqual(payload);
        expect(result.value.trailing).toEqual(Uint8Array.of(0xca, 0xfe));
        expect(verifiedCopy?.every((byte) => byte === 0)).toBe(true);
        expect(consumedCopy?.every((byte) => byte === 0)).toBe(true);
        client.close();
        await client.whenClosed;
        expect(result.value.head.field1).toEqual(Uint8Array.of(0xff, 0));
        expect(result.value.inflated).toEqual(payload);
    }, 10000);

    it('rejects a failed synthetic comparison before consume or decrypt', async () => {
        const candidate = response();
        const order: string[] = [];
        const client = await setup(candidate, order);
        const decrypt = vi.fn(decodeTargetServiceDecryptCandidate);
        const consume = vi.fn((bytes: Uint8Array) => {
            const basic = decodeTargetServiceResponseBasic(bytes);
            return decrypt(basic.selector, bytes.subarray(basic.nextOffset), key);
        });
        const result = await client.transactRaw({
            timeoutMs: 2000,
            buildRequest: () => {
                order.push('build');
                return { frame: request, context: null };
            },
            verifyCandidate: (bytes) => {
                order.push('verify');
                return Buffer.from(bytes).equals(Buffer.from('synthetic mismatch'));
            },
            consumeCandidate: consume,
        });
        expect(result).toMatchObject({
            kind: 'failure',
            code: 'raw-rejected',
            writeState: 'unknown',
        });
        expect(order).toEqual(['build', 'peer-received', 'peer-wrote', 'verify']);
        expect(consume).not.toHaveBeenCalled();
        expect(decrypt).not.toHaveBeenCalled();
        expect((await client.whenClosed).code).toBe('raw-rejected');
    }, 10000);

    it.each(['cipher', 'head'] as const)(
        'rejects malformed %s after the fixture comparison',
        async (corruption) => {
            const candidate = response(corruption);
            const order: string[] = [];
            const client = await setup(candidate, order);
            const consume = vi.fn((bytes: Uint8Array) => {
                order.push('consume');
                const basic = decodeTargetServiceResponseBasic(bytes);
                const plaintext = decodeTargetServiceDecryptCandidate(
                    basic.selector,
                    bytes.subarray(basic.nextOffset),
                    key,
                );
                return decodeTargetSso12ResponseHead(plaintext.data);
            });
            const result = await client.transactRaw({
                timeoutMs: 2000,
                buildRequest: () => {
                    order.push('build');
                    return { frame: request, context: null };
                },
                verifyCandidate: (bytes) => {
                    order.push('verify');
                    return Buffer.from(bytes).equals(candidate);
                },
                consumeCandidate: consume,
            });
            expect(result).toMatchObject({
                kind: 'failure',
                code: 'raw-callback-failed',
                writeState: 'unknown',
            });
            expect(order).toEqual(['build', 'peer-received', 'peer-wrote', 'verify', 'consume']);
            expect(consume).toHaveBeenCalledOnce();
            expect((await client.whenClosed).code).toBe('raw-callback-failed');
        },
        10000,
    );
});
