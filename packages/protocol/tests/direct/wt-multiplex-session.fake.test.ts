import type { DirectThirdPartyLoginResponse } from '@snowluma/proto-defs/direct-login';
import type { PushMsg } from '@snowluma/proto-defs/message';
import type { SsoHeartbeatResponse, SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawMultiplexClient } from '../../src/direct/raw-multiplex-client';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import { decodeServiceResponse } from '../../src/direct/service-frame';
import { decodeSsoResponse } from '../../src/direct/sso';
import { SSO_HEARTBEAT_COMMAND, SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import { createWtReferenceSession } from '../../src/direct/wt-reference-session';
import { encodeWtTlv } from '../../src/direct/wt-tlv';
import { fetchBody, parseWt, peer, pollBody, replyWt } from './fixtures/wt-sso-synthetic';

// Pure memory synthetic peer. Its known D2 key is injected into the classifier;
// WtReferenceSession does not supply its private D2 key to this classifier. This
// does not demonstrate production post-login push decryption, authentication,
// an event bridge, a live service, or any socket transport.
const key = new Uint8Array(16).fill(10);
const pushCommand = 'trpc.msg.olpush.OlPushService.MsgPush';
const uid = 'fixture-uid-from-543';

const word = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    return b;
};

const field = (b: Uint8Array) => Buffer.concat([word(b.length + 4), b]);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

async function until(predicate: () => boolean) {
    for (let i = 0; i < 100 && !predicate(); i++) {
        await turn();
    }

    expect(predicate()).toBe(true);
}

function loginBody() {
    const projection = protobuf_encode<DirectThirdPartyLoginResponse>({
        commonInfo: { rspNT: { uid } },
    });
    const inner = encodeWtTlv([
        { tag: 0x143, value: Uint8Array.of(9) },
        { tag: 0x305, value: key },
        { tag: 0x10a, value: Uint8Array.of(11) },
        { tag: 0x106, value: Uint8Array.of(12) },
        { tag: 0x543, value: projection },
    ]);
    const body = Buffer.concat([
        Buffer.of(0, 9, 0),
        encodeWtTlv([{ tag: 0x119, value: qqTeaEncrypt(inner, new Uint8Array(16).fill(4)) }]),
    ]);
    inner.fill(0);
    projection.fill(0);
    return body;
}

function response(
    sequence: number,
    command: string,
    body: Uint8Array,
    account: string,
    d2: boolean,
) {
    const inner = Buffer.concat([
        field(
            Buffer.concat([
                word(sequence),
                word(0),
                field(Buffer.alloc(0)),
                field(Buffer.from(command)),
                field(Buffer.alloc(0)),
                word(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(body),
    ]);
    const cipher = qqTeaEncrypt(inner, d2 ? key : new Uint8Array(16));
    inner.fill(0);
    return Buffer.concat([
        word(14 + account.length + cipher.length),
        word(12),
        Buffer.of(d2 ? 1 : 2, 0),
        field(Buffer.from(account)),
        cipher,
    ]);
}

function push(sequence: number, account: string, d2: boolean) {
    const body = protobuf_encode<PushMsg>({
        message: {
            responseHead: { fromUin: 456, fromUid: 'sender-fixture', toUin: 123 },
            contentHead: { msgType: 166, sequence: 700 },
            body: { msgContent: Uint8Array.of(1, 2, 3) },
        },
    });
    return response(sequence, pushCommand, body, account, d2);
}

function inspect(frame: Uint8Array) {
    const service = decodeServiceResponse(frame, key);
    const sso = decodeSsoResponse(service.body);
    return { service, sso };
}

const fetchFields = {
    packageName: 'p',
    ptVersion: 'v',
    miscBitMap: 1,
    ssoVersion: 1,
    d1: Uint8Array.of(1),
};
const loginFields = {
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
};

type Request = { sequence: number; account: string; command: string };

function setup() {
    const enteredBuild = deferred<void>();
    const allowBuild = deferred<void>();
    const blockedPush = deferred<void>();
    const enteredPush = deferred<void>();
    const requests: Request[] = [];
    const signed: Array<{ uin: string; uid: string; sequence: number; command: string }> = [];
    const seen: Array<{ seq: number; account: string; messageSequence: number }> = [];
    const classified: Array<{
        seq: number;
        active: number | undefined;
        transport: string;
        command: string;
    }> = [];
    let writesFinished = 0;
    let wtSignCount = 0;
    let wtVerifyCount = 0;
    let registerVerifyCount = 0;
    let pushFinished = 0;
    let holdHeartbeat = false;
    let client!: ReturnType<typeof createRawMultiplexClient>;
    client = createRawMultiplexClient({
        uin: '0',
        initialSequence: 50,
        defaultTimeoutMs: 2000,
        maxFrameBytes: 65536,
        maxBufferedBytes: 262144,
        maxFrames: 16,
        maxPushFrames: 16,
        maxPushBytes: 262144,
        write(frame) {
            const call = requests.length + 1;
            let candidate: Uint8Array;
            let sequence: number;
            let account: string;

            if (call <= 3) {
                const wt = parseWt(frame);
                sequence = wt.seq;
                account = wt.account;
                requests.push({ sequence, account, command: wt.command });
                const body =
                    wt.kind === 0x31 ? fetchBody() : wt.kind === 0x12 ? pollBody(0) : loginBody();
                candidate = replyWt(wt, body);
                body.fill(0);
                wt.shared.fill(0);
                wt.business.fill(0);
            } else {
                const b = Buffer.from(frame);
                const ticketEnd = 9 + b.readUInt32BE(9);
                const accountStart = ticketEnd + 1;
                const accountEnd = accountStart + b.readUInt32BE(accountStart);
                account = b.subarray(accountStart + 4, accountEnd).toString();
                const inner = Buffer.from(qqTeaDecrypt(b.subarray(accountEnd), key));
                sequence = inner.readUInt32BE(4);
                let position = 28;

                const read = () => {
                    const end = position + inner.readUInt32BE(position);
                    const out = inner.subarray(position + 4, end);
                    position = end;
                    return out;
                };

                read();
                const command = read().toString();
                requests.push({ sequence, account, command });
                const body =
                    command === SSO_INFO_SYNC_COMMAND
                        ? protobuf_encode<SsoRegisterResponse>({
                              register: { message: 'register success' },
                          })
                        : protobuf_encode<SsoHeartbeatResponse>({ interval: 270n });
                candidate = response(sequence, command, body, account, true);
                inner.fill(0);
                body.fill(0);
            }

            const notification = push(sequence, account, call > 3);
            // Both orders, including same-sequence pushes: command classification precedes response matching.
            const joined =
                call % 2
                    ? Buffer.concat([notification, candidate])
                    : Buffer.concat([candidate, notification]);
            client.feed(joined.subarray(0, 2));
            client.feed(joined.subarray(2, 9));
            client.feed(joined.subarray(9));
            writesFinished++;
        },
        classify(frame, identity) {
            const { service, sso } = inspect(frame);
            classified.push({
                seq: sso.sequence >>> 0,
                active: identity.sequence,
                transport: identity.uin,
                command: sso.command,
            });
            expect(service.protocol).toBe(12);

            if (sso.command === pushCommand) {
                return { kind: 'push', name: sso.command, id: sso.sequence >>> 0 };
            }

            return { kind: 'response', sequence: sso.sequence >>> 0 };
        },
        verifyPush(frame, route) {
            const { service, sso } = inspect(frame);
            const body = protobuf_decode<PushMsg>(sso.body);
            expect(route.name).toBe(pushCommand);
            expect(route.id).toBe(sso.sequence >>> 0);
            expect(service.uin).toBe(route.id < 52 ? '999' : '123');
            expect(body.message?.responseHead?.fromUid).toBe('sender-fixture');
            expect(body.message?.contentHead?.sequence).toBe(700);
            return true;
        },
        async onPush(frame, route) {
            const { service, sso } = inspect(frame);
            const body = protobuf_decode<PushMsg>(sso.body);
            seen.push({
                seq: route.id,
                account: service.uin,
                messageSequence: body.message!.contentHead!.sequence!,
            });

            if (holdHeartbeat && route.id === 54) {
                enteredPush.resolve();
                await blockedPush.promise;
            }

            pushFinished++;
        },
    });
    // This assertion is justified by the frozen mux's transaction-only invariant:
    // successful settle follows build/write/verify/consume completion and clears
    // that transaction's callbacks. Independent push callbacks can still run/fail.
    const broker = createRawSessionBroker(client, {
        trustedSuccessQuiescence: true,
        isUsable: () => !client.closed,
    });
    const lease = broker.acquire({ deadline: performance.now() + 15000 });
    const session = createWtReferenceSession(lease, {
        profile: {
            uin: '999',
            appId: 42,
            subAppId: 43,
            clientVersion: 44,
            guid: Uint8Array.of(1, 2),
            unknown21: new Uint8Array(21),
            randomKey: new Uint8Array(16).fill(7),
            peerPublicKey: peer.publicKey,
            ssoVersion: 'header-v',
            qrCommand: 'fixture.qr',
            loginCommand: 'fixture.login',
        },
        timeoutMs: 2000,
        attemptTimeoutMs: 10000,
        getTimestamp: () => 10,
        async buildWtReserved() {
            if (wtSignCount++ === 0) {
                enteredBuild.resolve();
                await allowBuild.promise;
            }

            return new Uint8Array();
        },
        verifyRaw: () => {
            wtVerifyCount++;
            return true;
        },
        verifyContext: ({ requestUin, responseUin }) => responseUin === requestUin,
        sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
        registration: {
            version: 'build-v',
            deviceName: 'name',
            deviceType: 'type',
            vendorOs: 'os',
            random: 4,
        },
        buildRegisterReserved: ({ uin, uid, sequence, command }) => {
            signed.push({ uin, uid, sequence, command });
            return Uint8Array.of(sequence);
        },
        verifyRegisterRaw: ({ sequence, command, responseFrame }) => {
            registerVerifyCount++;
            const { service, sso } = inspect(responseFrame);
            return (
                service.uin === '123' && sso.sequence >>> 0 === sequence && sso.command === command
            );
        },
    });
    return {
        client,
        lease,
        session,
        requests,
        signed,
        seen,
        classified,
        enteredBuild,
        allowBuild,
        blockedPush,
        enteredPush,
        setHold: () => {
            holdHeartbeat = true;
        },
        getPushFinished: () => pushFinished,
        getWritesFinished: () => writesFinished,
        getCallbackCounts: () => [
            wtSignCount,
            wtVerifyCount,
            signed.length,
            registerVerifyCount,
            writesFinished,
        ],
    };
}

async function login(f: ReturnType<typeof setup>) {
    const fetch = f.session.fetch(fetchFields);
    await f.enteredBuild.promise;
    const duringBuild = push(50, '999', false);
    f.client.feed(duringBuild.subarray(0, 3));
    f.client.feed(duringBuild.subarray(3));
    await until(() => f.seen.length === 1);
    expect(f.requests).toHaveLength(0);
    f.allowBuild.resolve();
    expect((await fetch).qrUrl).toBe('https://example.invalid/qr');
    expect(await f.session.poll()).toEqual({ status: 'confirmed' });
    expect(await f.session.loginAndRegister(loginFields)).toEqual({ status: 'success' });
}

describe('WT session over an in-memory multiplexed synthetic peer', () => {
    it('keeps one lease through pushes, registration, idle and two heartbeats', async () => {
        const f = setup();

        try {
            await login(f);
            await until(() => f.seen.length === 5);
            f.client.feed(push(800, '123', true));
            await until(() => f.seen.length === 6);
            f.setHold();
            const first = f.session.heartbeat();
            await f.enteredPush.promise;
            expect(await first).toEqual({ status: 'success', interval: 270n });
            expect(f.getPushFinished()).toBe(6);
            expect(f.client.closed).toBe(false);
            f.blockedPush.resolve();
            await until(() => f.getPushFinished() === 7);
            expect(await f.session.heartbeat()).toEqual({ status: 'success', interval: 270n });
            await until(() => f.seen.length === 8 && f.getPushFinished() === 8);
            expect(f.requests).toEqual([
                { sequence: 50, account: '999', command: 'fixture.qr' },
                { sequence: 51, account: '999', command: 'fixture.qr' },
                { sequence: 52, account: '123', command: 'fixture.login' },
                { sequence: 53, account: '123', command: SSO_INFO_SYNC_COMMAND },
                { sequence: 54, account: '123', command: SSO_HEARTBEAT_COMMAND },
                { sequence: 55, account: '123', command: SSO_HEARTBEAT_COMMAND },
            ]);
            expect(f.signed).toEqual(
                [53, 54, 55].map((sequence) => ({
                    uin: '123',
                    uid,
                    sequence,
                    command: sequence === 53 ? SSO_INFO_SYNC_COMMAND : SSO_HEARTBEAT_COMMAND,
                })),
            );
            expect(f.seen.map((v) => [v.seq, v.account, v.messageSequence])).toEqual([
                [50, '999', 700],
                [50, '999', 700],
                [51, '999', 700],
                [52, '123', 700],
                [53, '123', 700],
                [800, '123', 700],
                [54, '123', 700],
                [55, '123', 700],
            ]);
            expect(f.classified.every((v) => v.transport === '0')).toBe(true);

            for (const seq of [50, 51, 52, 53, 54, 55]) {
                expect(
                    f.classified.some(
                        (v) => v.seq === seq && v.active === seq && v.command === pushCommand,
                    ),
                ).toBe(true);
                expect(
                    f.classified.some(
                        (v) => v.seq === seq && v.active === seq && v.command !== pushCommand,
                    ),
                ).toBe(true);
            }

            expect(f.classified.some((v) => v.seq === 800 && v.active === undefined)).toBe(true);
            expect(f.getCallbackCounts()).toEqual([3, 3, 3, 3, 6]);
            await turn();
            await turn();
            expect(f.getCallbackCounts()).toEqual([3, 3, 3, 3, 6]);
            expect(f.requests).toHaveLength(6);
            expect(f.client.closed).toBe(false);
            expect(f.session.getState()).toBe('success');
            f.session.close();
            f.lease.release();
            expect(await f.lease.whenClosed).toBe('released');
            expect(f.client.closed).toBe(false);
        } finally {
            f.allowBuild.resolve();
            f.blockedPush.resolve();
            f.session.close();
            f.lease.release();
            f.client.close();
        }
    });

    it('observes later independent push failure after the heartbeat already succeeded', async () => {
        const f = setup();

        try {
            await login(f);
            await until(() => f.seen.length === 5);
            f.setHold();
            const heartbeat = f.session.heartbeat();
            await f.enteredPush.promise;
            expect(await heartbeat).toEqual({ status: 'success', interval: 270n });
            expect(f.client.closed).toBe(false);
            f.blockedPush.reject(new Error('synthetic push handler failure'));
            expect(await f.client.whenClosed).toEqual({
                kind: 'handler-error',
                code: 'push-handler-failed',
            });
            expect(await f.lease.whenClosed).toBe('poisoned');
            await until(() => f.session.getState() === 'failed');
        } finally {
            f.allowBuild.resolve();
            f.blockedPush.resolve();
            f.session.close();
            f.lease.release();
            f.client.close();
        }
    });
});
