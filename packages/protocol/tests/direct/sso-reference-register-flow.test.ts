import { once } from 'node:events';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { SsoRegisterRequest, SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as service from '../../src/direct/service-frame';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { ServiceFrameDecoder } from '../../src/direct/service-stream';
import { SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import {
    referenceRegister,
    type SsoReferenceRegisterOptions,
} from '../../src/direct/sso-reference-register-flow';

// All identifiers and keys are synthetic; the local exchange makes no server trust claim.
const key = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const sockets: Socket[] = [];
const servers: Server[] = [];

const word = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    return b;
};

const field = (b: Uint8Array): Buffer => Buffer.concat([word(b.length + 4), b]);

type ReplyOptions = {
    uin?: string;
    command?: string;
    sequence?: number;
    flag?: number;
    protocol?: number;
    code?: number;
    message?: string | null;
};

function reply(options: ReplyOptions = {}): Buffer {
    const body = protobuf_encode<SsoRegisterResponse>(
        options.message === null
            ? {}
            : { register: { message: options.message ?? 'register success' } },
    );
    const inner = Buffer.concat([
        field(
            Buffer.concat([
                word(options.sequence ?? 0xf0000001),
                word(options.code ?? 0),
                field(Buffer.alloc(0)),
                field(Buffer.from(options.command ?? SSO_INFO_SYNC_COMMAND)),
                field(Buffer.alloc(0)),
                word(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(body),
    ]);
    const flag = options.flag ?? 1;
    const payload = flag === 0 ? inner : qqTeaEncrypt(inner, flag === 1 ? key : new Uint8Array(16));
    const account = Buffer.from(options.uin ?? '123');
    return Buffer.concat([
        word(14 + account.length + payload.length),
        word(options.protocol ?? 12),
        Buffer.of(flag, 0),
        field(account),
        payload,
    ]);
}

function parse(frame: Uint8Array) {
    const b = Buffer.from(frame);
    const ticketLength = b.readUInt32BE(9);
    const ticket = Buffer.from(b.subarray(13, 9 + ticketLength));
    const uinStart = 10 + ticketLength;
    const uinEnd = uinStart + b.readUInt32BE(uinStart);
    const uin = b.subarray(uinStart + 4, uinEnd).toString();
    const inner = Buffer.from(qqTeaDecrypt(b.subarray(uinEnd), key));
    let offset = 28;

    const read = () => {
        const length = inner.readUInt32BE(offset);
        const out = inner.subarray(offset + 4, offset + length);
        offset += length;
        return out;
    };

    const a2 = Buffer.from(read());
    const command = read().toString();
    read();
    const guid = read().toString();
    read();
    const len = inner.readUInt16BE(offset);
    const version = inner.subarray(offset + 2, offset + len).toString();
    offset += len;
    const reserved = Buffer.from(read());
    const body = Buffer.from(inner.subarray(inner.readUInt32BE(0) + 4));
    const decoded = protobuf_decode<SsoRegisterRequest>(body);
    return {
        flag: b[8],
        ticket,
        uin,
        a2,
        command,
        guid,
        version,
        reserved,
        body,
        decoded,
        sequence: inner.readUInt32BE(4),
    };
}

async function setup(handler: (socket: Socket, frame: Uint8Array) => void) {
    const server = createServer();
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const addr = server.address();

    if (!addr || typeof addr === 'string') {
        throw new Error('address');
    }

    const accepted = once(server, 'connection');
    const socket = createConnection({ host: '127.0.0.1', port: addr.port });
    sockets.push(socket);
    await once(socket, 'connect');
    const [peer] = (await accepted) as [Socket];
    sockets.push(peer);
    const decoder = new ServiceFrameDecoder();
    peer.on('data', (chunk) => {
        for (const frame of decoder.push(chunk)) {
            handler(peer, frame);
        }
    });
    return socket;
}

const config = (socket: Socket): SsoReferenceRegisterOptions => ({
    socket,
    login: {
        status: 'tickets',
        uin: '123',
        tickets: {
            d2: Uint8Array.of(3, 4),
            d2Key: Uint8Array.from(key),
            a1: Uint8Array.of(5),
            a2: Uint8Array.of(6, 7),
        },
    },
    profile: { subAppId: 42, guid: Uint8Array.of(0xab, 0xcd), version: 'header-v' },
    registration: {
        uid: 'uid-only-for-signer',
        version: 'build-v',
        deviceName: 'name',
        deviceType: 'type',
        vendorOs: 'os',
        random: 4,
    },
    sequence: 0xf0000001,
    timeoutMs: 1000,
    buildReserved: () => Uint8Array.of(8, 9),
    verifyRaw: () => true,
});
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.destroy());
    await Promise.all(
        servers
            .splice(0)
            .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    vi.restoreAllMocks();
});

describe('single synthetic reference registration', () => {
    it('signs the actual protobuf and verifies raw evidence before decoding a D2 response', async () => {
        let request!: ReturnType<typeof parse>;
        const socket = await setup((peer, frame) => {
            request = parse(frame);
            peer.write(reply());
        });
        const options = config(socket);
        let signerBody!: Uint8Array, verifierRequest!: Uint8Array, verifierResponse!: Uint8Array;
        let signedBody!: Buffer;
        const decode = vi.spyOn(service, 'decodeServiceResponse');

        options.buildReserved = (input) => {
            expect(input.uin).toBe('123');
            expect(input.uid).toBe('uid-only-for-signer');
            expect(input.sequence).toBe(0xf0000001);
            expect(input.command).toBe(SSO_INFO_SYNC_COMMAND);
            signerBody = input.body;
            signedBody = Buffer.from(input.body);
            return input.body; // Returned bytes alias the signer input.
        };

        options.verifyRaw = (input) => {
            expect(decode).not.toHaveBeenCalled();
            expect(input.uin).toBe('123');
            expect(input.sequence).toBe(0xf0000001);
            expect(input.command).toBe(SSO_INFO_SYNC_COMMAND);
            verifierRequest = input.requestFrame;
            verifierResponse = input.responseFrame;
            input.responseFrame.fill(0);
            return true;
        };

        expect(await referenceRegister(options)).toEqual({
            kind: 'response',
            sequence: 0xf0000001,
            value: 'success',
            writeState: 'written',
        });
        expect(decode).toHaveBeenCalledOnce();
        expect(request).toMatchObject({
            flag: 1,
            ticket: Buffer.of(3, 4),
            uin: '123',
            a2: Buffer.of(6, 7),
            command: SSO_INFO_SYNC_COMMAND,
            guid: 'abcd',
            version: 'header-v',
            sequence: 0xf0000001,
        });
        expect(request.reserved).toEqual(signedBody);
        expect(request.body).toEqual(signedBody);
        expect(request.decoded.register).toMatchObject({ guid: 'ABCD', buildVersion: 'build-v' });
        expect(request.body.includes(Buffer.from(options.registration.uid))).toBe(false);
        expect(signerBody.every((b) => b === 0)).toBe(true);
        expect(verifierRequest.every((b) => b === 0)).toBe(true);
        expect(verifierResponse.every((b) => b === 0)).toBe(true);
        expect(options.login.tickets.d2Key).toEqual(key);
        expect(socket.destroyed).toBe(true);
    });
    it.each(['false', 'throw'] as const)(
        'does not decode when verifier returns %s',
        async (mode) => {
            const socket = await setup((peer) => peer.write(reply()));
            const options = config(socket);
            const decode = vi.spyOn(service, 'decodeServiceResponse');
            options.verifyRaw = vi.fn(() => {
                if (mode === 'throw') {
                    throw new Error('secret');
                }

                return false;
            });
            const result = await referenceRegister(options);
            expect(result).toMatchObject({
                kind: 'failure',
                code: mode === 'throw' ? 'raw-callback-failed' : 'raw-rejected',
                writeState: 'unknown',
            });
            expect(options.verifyRaw).toHaveBeenCalledOnce();
            expect(decode).not.toHaveBeenCalled();
            expect(JSON.stringify(result)).not.toContain('secret');
        },
    );
    it.each([
        ['account', { uin: '456' }],
        ['command', { command: 'wrong' }],
        ['sequence', { sequence: 1 }],
        ['encryption', { flag: 0 }],
        ['protocol', { protocol: 13 }],
    ] as const)('rejects mismatched %s', async (_name, override) => {
        const socket = await setup((peer) => peer.write(reply(override)));
        expect(await referenceRegister(config(socket))).toMatchObject({
            kind: 'failure',
            writeState: 'unknown',
        });
    });
    it.each([
        [{ code: -7 }, 'sso-error'],
        [{ message: 'no' }, 'rejected'],
        [{ message: null }, 'missing-result'],
    ] as const)('preserves reference outcome %s', async (override, expected) => {
        const socket = await setup((peer) => peer.write(reply(override)));
        expect(await referenceRegister(config(socket))).toMatchObject({
            kind: 'response',
            value: expected,
        });
    });
    it.each(['timeout', 'abort'] as const)(
        'cleans a stopped signer after %s and never writes its late result',
        async (mode) => {
            let release!: (v: Uint8Array) => void;
            let input!: Uint8Array;
            const socket = await setup(() => {});
            const options = config(socket);
            const controller = new AbortController();
            options.timeoutMs = mode === 'timeout' ? 30 : 1000;
            options.signal = controller.signal;

            options.buildReserved = ({ body }) => {
                input = body;
                return new Promise((resolve) => {
                    release = resolve;
                });
            };

            const write = vi.spyOn(socket, 'write');
            const pending = referenceRegister(options);

            if (mode === 'abort') {
                controller.abort();
            }

            expect(await pending).toMatchObject({
                kind: 'failure',
                code: mode === 'abort' ? 'raw-cancelled' : 'raw-timeout',
                writeState: 'not-written',
            });
            expect(input.every((b) => b === 0)).toBe(true);
            release(input);
            await turn();
            expect(input.every((b) => b === 0)).toBe(true);
            expect(write).not.toHaveBeenCalled();
        },
    );
    it.each(['timeout', 'abort'] as const)(
        'stops a late verifier after %s without decoding or replay',
        async (mode) => {
            let release!: (value: boolean) => void, entered!: () => void;
            let verifierCopy!: Uint8Array;
            let count = 0;
            const gate = new Promise<void>((resolve) => {
                entered = resolve;
            });
            const socket = await setup((peer) => {
                count++;
                peer.write(reply());
            });
            const options = config(socket);
            const controller = new AbortController();
            options.signal = controller.signal;
            options.timeoutMs = mode === 'timeout' ? 60 : 1000;

            options.verifyRaw = ({ responseFrame }) => {
                verifierCopy = responseFrame;
                entered();
                return new Promise((resolve) => {
                    release = resolve;
                });
            };

            const decode = vi.spyOn(service, 'decodeServiceResponse');
            const pending = referenceRegister(options);
            await gate;

            if (mode === 'abort') {
                controller.abort();
            }

            expect(await pending).toMatchObject({
                kind: 'failure',
                code: mode === 'abort' ? 'raw-cancelled' : 'raw-timeout',
                writeState: 'unknown',
            });
            expect(verifierCopy.every((b) => b === 0)).toBe(true);
            release(true);
            await turn();
            expect(verifierCopy.every((b) => b === 0)).toBe(true);
            expect(decode).not.toHaveBeenCalled();
            expect(count).toBe(1);
        },
    );
    it('cleans earlier private copies when a later builder allocation fails', async () => {
        const socket = await setup(() => {});
        const options = config(socket);
        const copies: Uint8Array[] = [];
        const native = Uint8Array.from.bind(Uint8Array);
        let calls = 0;

        options.buildReserved = ({ body }) => {
            vi.spyOn(Uint8Array, 'from').mockImplementation(((source: ArrayLike<number>) => {
                calls++;

                if (calls === 4) {
                    throw new Error('fixture allocation failure');
                }

                const copy = native(source);
                copies.push(copy);
                return copy;
            }) as typeof Uint8Array.from);
            return body;
        };

        try {
            expect(await referenceRegister(options)).toMatchObject({
                kind: 'failure',
                code: 'raw-build-failed',
                writeState: 'not-written',
            });
            expect(copies).toHaveLength(3);
            expect(copies.every((copy) => copy.every((v) => v === 0))).toBe(true);
        } finally {
            vi.restoreAllMocks();
        }
    });
    it('wipes remaining verifier evidence even when one copy is detached and fill is overridden', async () => {
        let request!: Uint8Array, response!: Uint8Array, entered!: () => void;
        const gate = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const socket = await setup((peer) => peer.write(reply()));
        const options = config(socket);
        const controller = new AbortController();
        options.signal = controller.signal;

        options.verifyRaw = (input) => {
            request = input.requestFrame;
            response = input.responseFrame;
            expect(response.some((v) => v !== 0)).toBe(true);
            structuredClone(request.buffer, { transfer: [request.buffer] });
            Object.defineProperty(response, 'fill', {
                get() {
                    throw new Error('bad fill');
                },
            });
            entered();
            return new Promise<boolean>(() => {});
        };

        const pending = referenceRegister(options);
        await gate;
        controller.abort();
        expect(await pending).toMatchObject({
            kind: 'failure',
            code: 'raw-cancelled',
            writeState: 'unknown',
        });
        expect(request.byteLength).toBe(0);
        expect(response.every((v) => v === 0)).toBe(true);
        expect(options.login.tickets.d2Key).toEqual(key);
    });
    it('rejects invalid and aliased exotic inputs before claiming the socket', async () => {
        const socket = await setup(() => {});
        const original = config(socket);
        const invalids: SsoReferenceRegisterOptions[] = [];

        for (const uin of ['0123', '0', '4294967296']) {
            invalids.push({ ...original, login: { ...original.login, uin } });
        }

        invalids.push({
            ...original,
            login: {
                ...original.login,
                tickets: {
                    ...original.login.tickets,
                    d2: new Uint8Array(new SharedArrayBuffer(2)),
                },
            },
        });
        const detached = new Uint8Array(2);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        invalids.push({ ...original, profile: { ...original.profile, guid: detached } });
        const getter = Object.defineProperty({ ...original.profile }, 'version', {
            get() {
                throw new Error('ran getter');
            },
        });
        invalids.push({ ...original, profile: getter });
        invalids.push({
            ...original,
            registration: new Proxy(original.registration, {
                get() {
                    throw new Error('ran proxy');
                },
            }),
        });

        for (const options of invalids) {
            await expect(referenceRegister(options)).rejects.toThrow();
            expect(socket.destroyed).toBe(false);
        }
    });
});
