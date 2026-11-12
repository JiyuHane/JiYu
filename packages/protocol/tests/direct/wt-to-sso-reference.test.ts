import { once } from 'node:events';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import type { SsoRegisterRequest, SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as service from '../../src/direct/service-frame';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { ServiceFrameDecoder } from '../../src/direct/service-stream';
import { SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import { referenceRegister } from '../../src/direct/sso-reference-register-flow';
import { WtReferenceLoginAttempt } from '../../src/direct/wt-reference-login-attempt';
import {
    fetchBody,
    loginReply,
    parseWt,
    peer,
    pollBody,
    replyWt,
} from './fixtures/wt-sso-synthetic';

// This verifier is a synthetic fixture policy, not peer authentication or QQ compatibility.
const sockets: Socket[] = [];
const servers: Server[] = [];
const sensitive: Uint8Array[] = [];
const attempts: WtReferenceLoginAttempt[] = [];
const key = () => new Uint8Array(16).fill(10); // Preselected before any request.

const word = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    return b;
};

const field = (b: Uint8Array) => Buffer.concat([word(b.length + 4), b]);
const sequence = 0xf0000001;

afterEach(async () => {
    attempts.splice(0).forEach((attempt) => attempt.close());
    sockets.splice(0).forEach((socket) => socket.destroy());
    await Promise.all(
        servers
            .splice(0)
            .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    sensitive.splice(0).forEach((value) => value.fill(0));
    vi.restoreAllMocks();
});

async function connect(handler: (socket: Socket, frame: Uint8Array) => void, failure: () => void) {
    const server = createServer((socket) => {
        sockets.push(socket);
        socket.on('error', failure);
        const decoder = new ServiceFrameDecoder();
        socket.on('data', (chunk) => {
            try {
                for (const frame of decoder.push(chunk)) {
                    try {
                        handler(socket, frame);
                    } finally {
                        frame.fill(0);
                    }
                }
            } catch {
                failure();
                socket.destroy();
            }
        });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();

    if (!address || typeof address === 'string') {
        throw new Error('fixture address');
    }

    const client = createConnection({ host: '127.0.0.1', port: address.port });
    sockets.push(client);
    await once(client, 'connect');
    return client;
}

function registerReply(): Uint8Array {
    const body = protobuf_encode<SsoRegisterResponse>({
        register: { message: 'register success' },
    });
    const inner = Buffer.concat([
        field(
            Buffer.concat([
                word(sequence),
                word(0),
                field(Buffer.alloc(0)),
                field(Buffer.from(SSO_INFO_SYNC_COMMAND)),
                field(Buffer.alloc(0)),
                word(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(body),
    ]);
    const fixtureKey = key();

    try {
        const payload = qqTeaEncrypt(inner, fixtureKey);
        const account = Buffer.from('123');
        return Buffer.concat([
            word(14 + account.length + payload.length),
            word(12),
            Buffer.of(1, 0),
            field(account),
            payload,
        ]);
    } finally {
        fixtureKey.fill(0);
        inner.fill(0);
        body.fill(0);
    }
}

function inspectRegister(frame: Uint8Array, signedBody: Uint8Array): boolean {
    const b = Buffer.from(frame);
    const d2Length = b.readUInt32BE(9);
    const d2 = b.subarray(13, 9 + d2Length);
    const start = 10 + d2Length;
    const end = start + b.readUInt32BE(start);
    const fixtureKey = key();
    let inner: Buffer | undefined;

    try {
        inner = Buffer.from(qqTeaDecrypt(b.subarray(end), fixtureKey));
        let offset = 28;

        const read = () => {
            const n = inner!.readUInt32BE(offset);
            const value = inner!.subarray(offset + 4, offset + n);
            offset += n;
            return value;
        };

        const a2 = read();
        const command = read().toString();
        read();
        read();
        read();
        offset += inner.readUInt16BE(offset);
        const reserved = read();
        const body = inner.subarray(inner.readUInt32BE(0) + 4);
        const decoded = protobuf_decode<SsoRegisterRequest>(body);
        return (
            b.readUInt32BE(4) === 12 &&
            b[8] === 1 &&
            d2.equals(Buffer.of(9)) &&
            b.subarray(start + 4, end).toString() === '123' &&
            a2.equals(Buffer.of(11)) &&
            command === SSO_INFO_SYNC_COMMAND &&
            inner.readUInt32BE(4) === sequence &&
            reserved.equals(body) &&
            body.equals(signedBody) &&
            decoded.register?.guid === 'ABCD' &&
            decoded.register?.buildVersion === 'build-v'
        );
    } finally {
        fixtureKey.fill(0);
        inner?.fill(0);
        b.fill(0);
    }
}

describe('synthetic WT to SSO reference handoff', () => {
    it.each([true, false])(
        'uses a fresh registration socket; raw policy accepts=%s',
        async (accept) => {
            let failed = false;

            const fail = () => {
                failed = true;
            };

            let wtCount = 0;
            let wtValid = true;
            const socketA = await connect((socket, frame) => {
                const req = parseWt(frame);

                try {
                    wtCount++;
                    const expectedKind = [0x31, 0x12, 0x810][wtCount - 1];
                    const expectedAccount = wtCount === 3 ? '123' : '999';
                    wtValid &&=
                        req.kind === expectedKind &&
                        req.account === expectedAccount &&
                        req.seq === wtCount &&
                        req.command === (wtCount === 3 ? 'fixture.login' : 'fixture.qr') &&
                        req.reserved.equals(req.oicq);
                    const body =
                        req.kind === 0x31
                            ? fetchBody()
                            : req.kind === 0x810
                              ? loginReply()
                              : pollBody(0);
                    const response = replyWt(req, body);
                    socket.write(response, () => response.fill(0));
                    body.fill(0);
                } finally {
                    [req.reserved, req.oicq, req.point, req.shared, req.business].forEach((v) =>
                        v.fill(0),
                    );
                }
            }, fail);
            const signerInputs: Uint8Array[] = [];
            const attempt = new WtReferenceLoginAttempt({
                socket: socketA,
                profile: {
                    uin: '999',
                    appId: 42,
                    subAppId: 43,
                    clientVersion: 44,
                    guid: Uint8Array.of(1, 2),
                    unknown21: new Uint8Array(21),
                    randomKey: new Uint8Array(16).fill(7),
                    peerPublicKey: peer.publicKey,
                    ssoVersion: 'v',
                    qrCommand: 'fixture.qr',
                    loginCommand: 'fixture.login',
                },
                timeoutMs: 1000,
                attemptTimeoutMs: 5000,
                getTimestamp: () => 10,
                buildReserved: ({ body }) => {
                    signerInputs.push(body);
                    return body;
                },
                verifyRaw: ({ requestUin, transportUin }) =>
                    transportUin === '999' && (requestUin === '999' || requestUin === '123'),
                verifyContext: ({ operation, requestUin, responseUin, businessUin }) =>
                    requestUin === responseUin &&
                    (operation !== 'poll' || businessUin === 123n) &&
                    (operation !== 'login' || requestUin === '123'),
                sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
            });
            attempts.push(attempt);
            const fetched = await attempt.fetch({
                packageName: 'p',
                ptVersion: 'v',
                miscBitMap: 1,
                ssoVersion: 1,
                d1: Uint8Array.of(1),
            });
            expect(fetched.qrUrl === 'https://example.invalid/qr').toBe(true);
            expect((await attempt.poll()).status === 'confirmed').toBe(true);
            const loginResult = await attempt.login({
                mainSigMap: 1,
                miscBitMap: 2,
                subSigMap: 3,
                packageName: 'p',
                ptVersion: 'v',
                sdkVersion: 's',
                os: 'x',
                deviceName: 'd',
                apkSignature: Uint8Array.of(3),
                tlv124Value: new Uint8Array(12),
            });
            expect(loginResult.status === 'tickets').toBe(true);

            if (loginResult.status !== 'tickets') {
                throw new Error('fixture login result');
            }

            sensitive.push(...Object.values(loginResult.tickets));
            expect(
                loginResult.uin === '123' &&
                    loginResult.tickets.d2.length === 1 &&
                    loginResult.tickets.d2[0] === 9 &&
                    loginResult.tickets.d2Key.length === 16 &&
                    loginResult.tickets.d2Key.every((v) => v === 10) &&
                    loginResult.tickets.a2.length === 1 &&
                    loginResult.tickets.a2[0] === 11 &&
                    loginResult.tickets.a1.length === 1 &&
                    loginResult.tickets.a1[0] === 12,
            ).toBe(true);

            if (!socketA.closed) {
                await once(socketA, 'close', { signal: AbortSignal.timeout(4000) });
            }

            expect(socketA.closed && wtCount === 3 && wtValid && !failed).toBe(true);
            expect(signerInputs.every((input) => input.every((byte) => byte === 0))).toBe(true);
            let registerCount = 0;
            let registerValid = false;
            let signedBody = new Uint8Array();
            sensitive.push(signedBody);
            const socketB = await connect((socket, frame) => {
                registerCount++;
                registerValid = inspectRegister(frame, signedBody);
                const response = registerReply();
                socket.write(response, () => response.fill(0));
            }, fail);
            let signerInput = new Uint8Array();
            let verifyRequest = new Uint8Array();
            let verifyResponse = new Uint8Array();
            let policyValid = false;
            const decode = vi.spyOn(service, 'decodeServiceResponse');
            const write = vi.spyOn(socketB, 'write');
            const result = await referenceRegister({
                socket: socketB,
                login: loginResult,
                profile: { subAppId: 42, guid: Uint8Array.of(0xab, 0xcd), version: 'header-v' },
                registration: {
                    uid: 'fixture-only',
                    version: 'build-v',
                    deviceName: 'name',
                    deviceType: 'type',
                    vendorOs: 'os',
                    random: 4,
                },
                sequence,
                timeoutMs: 1500,
                buildReserved: (input) => {
                    signerInput = input.body;
                    signedBody = Uint8Array.from(input.body);
                    sensitive.push(signedBody);
                    return input.body;
                },
                verifyRaw: (input) => {
                    verifyRequest = input.requestFrame;
                    verifyResponse = input.responseFrame;
                    policyValid =
                        input.uin === '123' &&
                        input.sequence === sequence &&
                        input.command === SSO_INFO_SYNC_COMMAND &&
                        decode.mock.calls.length === 0;
                    input.responseFrame.fill(0);
                    return accept && policyValid;
                },
            });
            expect(
                accept
                    ? result.kind === 'response' &&
                          result.value === 'success' &&
                          result.writeState === 'written'
                    : result.kind === 'failure' &&
                          result.code === 'raw-rejected' &&
                          result.writeState === 'unknown',
            ).toBe(true);
            expect(
                registerCount === 1 &&
                    registerValid &&
                    policyValid &&
                    !failed &&
                    write.mock.calls.length === 1 &&
                    socketB.closed,
            ).toBe(true);
            expect(decode.mock.calls.length === (accept ? 1 : 0)).toBe(true);
            expect(
                [signerInput, verifyRequest, verifyResponse].every(
                    (v) => v.length > 0 && v.every((byte) => byte === 0),
                ),
            ).toBe(true);
        },
        10000,
    );
});
