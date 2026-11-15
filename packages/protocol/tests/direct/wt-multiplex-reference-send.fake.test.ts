import { EventEmitter } from 'node:events';
import type { DirectThirdPartyLoginResponse } from '@snowluma/proto-defs/direct-login';
import type {
    DirectSendMessageRequest,
    DirectSendMessageResponse,
} from '@snowluma/proto-defs/direct-send-message';
import type { PushMsg } from '@snowluma/proto-defs/message';
import type { SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import { createWtMultiplexReference } from '../../src/direct/wt-multiplex-reference';
import type { WtReferenceSessionOptions } from '../../src/direct/wt-reference-session';
import { encodeWtTlv } from '../../src/direct/wt-tlv';
import { fetchBody, parseWt, peer, pollBody, replyWt } from './fixtures/wt-sso-synthetic';

// Synthetic, in-memory policies and data: no socket, server authentication or
// delivery claim. Callback-owned copies and codec allocations remain caller-owned.
const sendCommand = 'MessageSvc.PbSendMsg';
const pushCommand = 'trpc.msg.olpush.OlPushService.MsgPush';
const account = '123';
const uid = 'synthetic-uid';
const ticketKey = new Uint8Array(16).fill(4);
const d2Key = new Uint8Array(16).fill(10);
const clientSequence = 9007199254740993n;

type SignerInput = Parameters<WtReferenceSessionOptions['buildRegisterReserved']>[0];
type VerifyInput = Parameters<WtReferenceSessionOptions['verifyRegisterRaw']>[0];
type Request = {
    route:
        { kind: 'private'; peerUin: bigint; peerUid: string } | { kind: 'group'; groupUin: bigint };
    text: string;
    clientSequence: bigint;
    random: number;
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

class FixtureDeadlineError extends Error {
    constructor(label: string) {
        super(`fixture deadline: ${label}`);
        this.name = 'FixtureDeadlineError';
    }
}

async function bounded<T>(value: PromiseLike<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            Promise.resolve(value),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new FixtureDeadlineError(label)), 3000);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

async function expectRejected(operation: PromiseLike<unknown>, label: string, message: RegExp) {
    // The watchdog remains outside the observed operation, so expiry fails this
    // assertion instead of being mistaken for the operation's own rejection.
    const outcome = await bounded(
        Promise.resolve(operation).then(
            (value) => ({ kind: 'returned' as const, value }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
        ),
        label,
    );
    expect(outcome.kind).toBe('rejected');

    if (outcome.kind !== 'rejected') {
        throw new Error(`operation unexpectedly returned: ${label}`);
    }

    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error).not.toBeInstanceOf(FixtureDeadlineError);
    expect(String(outcome.error)).not.toContain('fixture deadline:');
    expect(String(outcome.error)).toMatch(message);
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitFor(check: () => boolean, label: string): Promise<void> {
    const end = performance.now() + 3000;

    while (!check()) {
        if (performance.now() >= end) {
            throw new Error(`fixture deadline: ${label}`);
        }

        await turn();
    }
}

async function reached(gate: Promise<void>, operation: Promise<unknown>, label: string) {
    await bounded(
        Promise.race([
            gate,
            operation.then(
                () => Promise.reject(new Error(`operation finished before ${label}`)),
                () => Promise.reject(new Error(`operation failed before ${label}`)),
            ),
        ]),
        label,
    );
}

const word = (value: number) => {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value >>> 0);
    return result;
};

const field = (bytes: Uint8Array) => Buffer.concat([word(bytes.length + 4), bytes]);

function loginBody() {
    const projection = protobuf_encode<DirectThirdPartyLoginResponse>({
        commonInfo: { rspNT: { uid } },
    });
    const inner = encodeWtTlv([
        { tag: 0x143, value: Uint8Array.of(9) },
        { tag: 0x305, value: d2Key },
        { tag: 0x10a, value: Uint8Array.of(11) },
        { tag: 0x106, value: Uint8Array.of(12) },
        { tag: 0x543, value: projection },
    ]);
    const cipher = qqTeaEncrypt(inner, ticketKey);
    const result = Buffer.concat([
        Buffer.of(0, 9, 0),
        encodeWtTlv([{ tag: 0x119, value: cipher }]),
    ]);
    inner.fill(0);
    projection.fill(0);
    return result;
}

function response(sequence: number, command: string, body: Uint8Array, retCode = 0) {
    const inner = Buffer.concat([
        field(
            Buffer.concat([
                word(sequence),
                word(retCode),
                field(Buffer.alloc(0)),
                field(Buffer.from(command)),
                field(Buffer.alloc(0)),
                word(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(body),
    ]);
    const cipher = qqTeaEncrypt(inner, d2Key);
    inner.fill(0);
    return Buffer.concat([
        word(14 + Buffer.byteLength(account) + cipher.length),
        word(12),
        Buffer.of(1, 0),
        field(Buffer.from(account)),
        cipher,
    ]);
}

function push(sequence: number) {
    const body = protobuf_encode<PushMsg>({
        message: {
            responseHead: { fromUin: 456, fromUid: 'synthetic-sender', toUin: 123 },
            contentHead: { msgType: 166, sequence },
            body: { msgContent: Uint8Array.of(1, 2, 3) },
        },
    });
    const result = response(sequence, pushCommand, body);
    body.fill(0);
    return result;
}

function inspectRequest(frame: Uint8Array) {
    const wire = Buffer.from(frame);
    const ticketEnd = 9 + wire.readUInt32BE(9);
    const accountStart = ticketEnd + 1;
    const accountEnd = accountStart + wire.readUInt32BE(accountStart);
    const inner = Buffer.from(qqTeaDecrypt(wire.subarray(accountEnd), d2Key));
    const headerEnd = inner.readUInt32BE(0);
    let position = 28;

    const readField = () => {
        const end = position + inner.readUInt32BE(position);
        const result = inner.subarray(position + 4, end);
        position = end;
        return result;
    };

    const a2 = Uint8Array.from(readField());
    const command = readField().toString();
    readField();
    const guid = Uint8Array.from(readField());
    readField();
    position += inner.readUInt16BE(position);
    const reserved = Uint8Array.from(readField());
    const observed = {
        account: wire.subarray(accountStart + 4, accountEnd).toString(),
        sequence: inner.readUInt32BE(4),
        command,
        d2: Uint8Array.from(wire.subarray(13, ticketEnd)),
        a2,
        guid,
        reserved,
        body: Uint8Array.from(inner.subarray(headerEnd + 4)),
    };
    inner.fill(0);
    return observed;
}

class FakeStream extends EventEmitter {
    readable = true;
    writable = true;
    destroyed = false;
    readableFlowing: boolean | null = null;
    writableLength = 0;
    writableNeedDrain = false;
    onWrite: (bytes: Uint8Array) => void = () => {};

    write(bytes: Uint8Array, callback: (error?: Error | null) => void): boolean {
        const copy = Uint8Array.from(bytes);
        queueMicrotask(() => {
            callback();
            this.onWrite(copy);
        });
        return true;
    }

    destroy(): this {
        this.destroyed = true;
        this.readable = false;
        this.writable = false;
        return this;
    }

    finishClose() {
        this.destroy();
        this.emit('close');
    }
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
const request = (kind: 'private' | 'group' = 'private'): Request => ({
    route:
        kind === 'private'
            ? { kind: 'private', peerUin: 456n, peerUid: 'synthetic-peer' }
            : { kind: 'group', groupUin: 789n },
    text: 'synthetic text 中🙂',
    clientSequence,
    random: 0x12345678,
});

function setup() {
    const stream = new FakeStream();
    const errors: unknown[] = [];
    const requests: Array<ReturnType<typeof inspectRequest>> = [];
    const wtRequests: Array<{ account: string; sequence: number; command: string }> = [];
    const signed: Array<{
        uin: string;
        uid: string;
        sequence: number;
        command: string;
        body: Uint8Array;
    }> = [];
    const verified: Array<{ uin: string; sequence: number; command: string }> = [];
    const delivered: string[] = [];
    const gates: Array<() => void> = [];
    const pending = new Set<Promise<unknown>>();
    let calls = 0;
    let sendRetCode = 0;
    let sendResult = 0;
    let signerHook: ((input: SignerInput) => Uint8Array | Promise<Uint8Array>) | undefined;
    let verifyHook: ((input: VerifyInput) => boolean | Promise<boolean>) | undefined;
    let pushVerifyHook: ((sequence: number) => boolean | Promise<boolean>) | undefined;
    let pushHook: ((sequence: number) => void | Promise<void>) | undefined;
    let bodyHook: ((sequence: number) => void | Promise<void>) | undefined;
    stream.on('error', (error) => errors.push(error));
    const baseline = new Map(
        ['data', 'error', 'end', 'close', 'pause'].map((name) => [name, stream.listeners(name)]),
    );

    const track = <T>(operation: Promise<T>): Promise<T> => {
        pending.add(operation);
        void operation.then(
            () => pending.delete(operation),
            () => pending.delete(operation),
        );
        return operation;
    };

    const gate = <T>(releaseValue: T) => {
        const result = deferred<T>();
        gates.push(() => result.resolve(releaseValue));
        return result;
    };

    const controller = new AbortController();
    const session = createWtMultiplexReference(stream, {
        exclusiveConnected: true,
        transportUin: '0',
        initialSequence: 50,
        maxFrameBytes: 65536,
        maxBufferedBytes: 262144,
        maxFrames: 64,
        maxPushFrames: 64,
        maxPushBytes: 262144,
        maxWriteBufferBytes: 262144,
        maxPushBodyBytes: 65536,
        leaseTimeoutMs: 10000,
        session: {
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
            timeoutMs: 1500,
            attemptTimeoutMs: 7000,
            signal: controller.signal,
            getTimestamp: () => 10,
            buildWtReserved: () => new Uint8Array(),
            verifyRaw: () => true,
            verifyContext: ({ requestUin, responseUin }) => responseUin === requestUin,
            sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
            registration: {
                version: 'build-v',
                deviceName: 'name',
                deviceType: 'type',
                vendorOs: 'os',
                random: 4,
            },
            buildRegisterReserved: (input) => {
                if (input.command === sendCommand) {
                    signed.push({
                        uin: input.uin,
                        uid: input.uid,
                        sequence: input.sequence,
                        command: input.command,
                        body: Uint8Array.from(input.body),
                    });
                    return track(Promise.resolve(signerHook?.(input) ?? Uint8Array.of(8)));
                }

                return Uint8Array.of(input.sequence);
            },
            verifyRegisterRaw: (input) => {
                if (input.command === sendCommand) {
                    verified.push({
                        uin: input.uin,
                        sequence: input.sequence,
                        command: input.command,
                    });
                    return track(Promise.resolve(verifyHook?.(input) ?? true));
                }

                return true;
            },
        },
        verifyPushRaw: (_frame, meta) => {
            delivered.push(`verify:${meta.sequence}`);
            return track(Promise.resolve(pushVerifyHook?.(meta.sequence) ?? true));
        },
        onPush: (_frame, meta) => {
            delivered.push(`push:${meta.sequence}`);
            return track(Promise.resolve(pushHook?.(meta.sequence)));
        },
        onPushBody: (_body, meta) => {
            delivered.push(`body:${meta.sequence}`);
            return track(Promise.resolve(bodyHook?.(meta.sequence)));
        },
    });

    stream.onWrite = (bytes) => {
        try {
            calls++;

            if (calls <= 3) {
                const wt = parseWt(bytes);
                wtRequests.push({ account: wt.account, sequence: wt.seq, command: wt.command });
                const body =
                    wt.kind === 0x31 ? fetchBody() : wt.kind === 0x12 ? pollBody(0) : loginBody();
                const candidate = replyWt(wt, body);
                body.fill(0);
                wt.shared.fill(0);
                wt.business.fill(0);
                stream.emit('data', candidate);
                return;
            }

            const current = inspectRequest(bytes);
            requests.push(current);
            let body: Uint8Array;

            if (current.command === SSO_INFO_SYNC_COMMAND) {
                body = protobuf_encode<SsoRegisterResponse>({
                    register: { message: 'register success' },
                });
            } else if (current.command === sendCommand) {
                body = protobuf_encode<DirectSendMessageResponse>({
                    result: sendResult,
                    sequence: 99n,
                    clientSequence: 88n,
                });
            } else {
                throw new Error('unexpected synthetic request');
            }

            const candidate = response(
                current.sequence,
                current.command,
                body,
                sendRetCode && current.command === sendCommand ? sendRetCode : 0,
            );
            body.fill(0);
            stream.emit('data', candidate);
        } catch (error) {
            errors.push(error);
            stream.emit('error', error);
        } finally {
            bytes.fill(0);
        }
    };

    const confirm = async () => {
        expect((await bounded(session.fetch(fetchFields), 'fetch')).qrUrl).toBe(
            'https://example.invalid/qr',
        );
        expect(await bounded(session.poll(), 'poll')).toEqual({ status: 'confirmed' });
    };

    const register = async () => {
        await confirm();
        expect(await bounded(session.loginAndRegister(loginFields), 'register')).toEqual({
            status: 'success',
        });
    };

    const send = (input: Request = request(), maxResponseBodyBytes = 65536) =>
        track(session.sendText({ request: input, maxResponseBodyBytes }));

    const cleanup = async () => {
        session.close();
        gates.forEach((release) => release());
        stream.finishClose();
        await bounded(session.whenClosed, 'logical close');
        await bounded(Promise.allSettled([...pending]), 'pending operations');
        await turn();

        for (const [event, listeners] of baseline) {
            expect(stream.listeners(event)).toEqual(listeners);
        }
    };

    return {
        session,
        stream,
        controller,
        errors,
        requests,
        wtRequests,
        signed,
        verified,
        delivered,
        confirm,
        register,
        send,
        cleanup,
        gate,
        track,
        injectPush: (sequence: number) => stream.emit('data', push(sequence)),
        setSigner: (hook: typeof signerHook) => {
            signerHook = hook;
        },
        setVerifier: (hook: typeof verifyHook) => {
            verifyHook = hook;
        },
        setPushVerifier: (hook: typeof pushVerifyHook) => {
            pushVerifyHook = hook;
        },
        setPushHandler: (hook: typeof pushHook) => {
            pushHook = hook;
        },
        setBodyHandler: (hook: typeof bodyHook) => {
            bodyHook = hook;
        },
        setRetCode: (code: number) => {
            sendRetCode = code;
        },
        setSendResult: (value: number) => {
            sendResult = value;
        },
    };
}

type Fixture = ReturnType<typeof setup>;

async function withFixture(test: (fixture: Fixture) => Promise<void>) {
    const fixture = setup();
    let failed = false;
    let failure: unknown;

    try {
        await test(fixture);
    } catch (error) {
        failed = true;
        failure = error;
    } finally {
        try {
            await fixture.cleanup();
        } catch (error) {
            if (!failed) {
                failed = true;
                failure = error;
            } else {
                console.error('fixture cleanup failed after test failure', error);
            }
        }
    }

    if (failed) {
        throw failure;
    }
}

describe('WT multiplex reference send with synthetic memory-only peer', () => {
    it('registers and sends private and group messages with independent sequences', () =>
        withFixture(async (f) => {
            await f.register();
            const privateResult = await bounded(f.send(request('private')), 'private send');
            const groupResult = await bounded(f.send(request('group')), 'group send');

            for (const result of [privateResult, groupResult]) {
                expect(result).toMatchObject({
                    status: 'response',
                    response: {
                        result: 0,
                        sequence: 99n,
                        clientSequence: 88n,
                        selectedSequence: 88n,
                    },
                });
            }

            expect(f.wtRequests).toEqual([
                { account: '999', sequence: 50, command: 'fixture.qr' },
                { account: '999', sequence: 51, command: 'fixture.qr' },
                { account: '123', sequence: 52, command: 'fixture.login' },
            ]);
            expect(
                f.requests.map(({ account: uin, sequence, command }) => ({
                    uin,
                    sequence,
                    command,
                })),
            ).toEqual([
                { uin: account, sequence: 53, command: SSO_INFO_SYNC_COMMAND },
                { uin: account, sequence: 54, command: sendCommand },
                { uin: account, sequence: 55, command: sendCommand },
            ]);
            expect(
                f.signed.map(({ uin, uid: actualUid, sequence, command }) => ({
                    uin,
                    uid: actualUid,
                    sequence,
                    command,
                })),
            ).toEqual([
                { uin: account, uid, sequence: 54, command: sendCommand },
                { uin: account, uid, sequence: 55, command: sendCommand },
            ]);
            expect(f.verified).toEqual(
                [54, 55].map((sequence) => ({ uin: account, sequence, command: sendCommand })),
            );

            for (const [index, written] of f.requests.slice(1).entries()) {
                expect(written).toMatchObject({
                    d2: Uint8Array.of(9),
                    a2: Uint8Array.of(11),
                    guid: Uint8Array.from(Buffer.from('0102')),
                    reserved: Uint8Array.of(8),
                });
                expect(written.body).toEqual(f.signed[index].body);
                const decoded = protobuf_decode<DirectSendMessageRequest>(written.body);
                expect(decoded.clientSequence).toBe(clientSequence);
                expect(decoded.random).toBe(0x12345678);
                expect(decoded.messageBody.richText.elems[0].text.text).toBe('synthetic text 中🙂');

                if (index === 0) {
                    expect(decoded.routingHead.c2c).toEqual({
                        peerUin: 456n,
                        peerUid: 'synthetic-peer',
                    });
                    expect(decoded.routingHead.group).toBeNull();
                } else {
                    expect(decoded.routingHead.group).toEqual({ groupUin: 789n });
                    expect(decoded.routingHead.c2c).toBeNull();
                }
            }

            const exposed = Reflect.ownKeys(f.session).map(String).join(' ');
            expect(exposed).not.toMatch(/ticket|d2key|querykey|capability/i);

            for (const result of [privateResult, groupResult]) {
                expect(Object.keys(result)).toEqual(expect.arrayContaining(['status', 'response']));

                for (const secretField of ['tickets', 'd2Key', 'queryKey']) {
                    expect(Object.keys(result)).not.toContain(secretField);
                }
            }

            expect(f.errors).toEqual([]);
        }));

    it('projects a nonzero business result without treating it as receipt or transport failure', () =>
        withFixture(async (f) => {
            await f.register();
            f.setSendResult(37);
            expect(await bounded(f.send(), 'nonzero result')).toMatchObject({
                status: 'response',
                response: { result: 37, sequence: 99n, clientSequence: 88n, selectedSequence: 88n },
            });
            f.setSendResult(0);
            expect(await bounded(f.send(), 'send after projected result')).toMatchObject({
                status: 'response',
            });
        }));

    it('isolates signer body and verifier frame copies from the actual request and candidate', () =>
        withFixture(async (f) => {
            await f.register();
            let signerBorrowed: Uint8Array | undefined;
            let verifierRequest: Uint8Array | undefined;
            let verifierResponse: Uint8Array | undefined;
            let responseCopy = new Uint8Array();
            f.setSigner((input) => {
                signerBorrowed = input.body;
                input.body.fill(0);
                return Uint8Array.of(8);
            });
            f.setVerifier((input) => {
                verifierRequest = input.requestFrame;
                verifierResponse = input.responseFrame;
                responseCopy = Uint8Array.from(input.responseFrame);
                input.requestFrame.fill(0);
                input.responseFrame.fill(0);
                return true;
            });
            expect(await bounded(f.send(), 'independent copies')).toMatchObject({
                status: 'response',
                response: { result: 0, selectedSequence: 88n },
            });
            const decoded = protobuf_decode<DirectSendMessageRequest>(f.requests[1].body);
            expect(decoded.messageBody.richText.elems[0].text.text).toBe('synthetic text 中🙂');
            expect(signerBorrowed?.every((byte) => byte === 0)).toBe(true);
            expect(verifierRequest?.every((byte) => byte === 0)).toBe(true);
            expect(verifierResponse?.every((byte) => byte === 0)).toBe(true);
            expect(responseCopy.some((byte) => byte !== 0)).toBe(true);
        }));

    it('queues push verification and delivery FIFO until a pending signer and send settle', () =>
        withFixture(async (f) => {
            await f.register();
            const entered = deferred<void>();
            const allow = f.gate(Uint8Array.of(8));
            f.setSigner(() => {
                entered.resolve();
                return allow.promise;
            });
            const send = f.send();
            await reached(entered.promise, send, 'send signer');
            f.injectPush(54);
            f.injectPush(140);
            await turn();
            await turn();
            expect(f.delivered).toEqual([]);
            expect(f.requests).toHaveLength(1);
            allow.resolve(Uint8Array.of(8));
            expect(await bounded(send, 'send after signer')).toMatchObject({ status: 'response' });
            await waitFor(() => f.delivered.length === 6, 'queued push callbacks');
            expect(f.delivered).toEqual(
                [54, 140].flatMap((sequence) => [
                    `verify:${sequence}`,
                    `push:${sequence}`,
                    `body:${sequence}`,
                ]),
            );
        }));

    it('rechecks a scheduled push drain after send wins the next turn', () =>
        withFixture(async (f) => {
            await f.register();
            // Registration schedules an empty drain; let that earlier turn finish
            // before intercepting the push-specific drain below.
            await turn();
            await turn();
            const scheduled = deferred<void>();
            const signerEntered = deferred<void>();
            const allowSigner = f.gate(Uint8Array.of(8));
            const original = globalThis.setImmediate;
            let scheduledDrain: (() => void) | undefined;
            let invoked = false;
            const immediateSpy = vi
                .spyOn(globalThis, 'setImmediate')
                .mockImplementation((callback, ...args) => {
                    scheduledDrain = () => {
                        invoked = true;
                        callback(...args);
                    };

                    immediateSpy.mockRestore();
                    scheduled.resolve();
                    return original(() => {});
                });

            try {
                f.injectPush(210);
                await bounded(scheduled.promise, 'drain scheduled');
                expect(f.delivered).toEqual([]);
                f.setSigner(() => {
                    signerEntered.resolve();
                    return allowSigner.promise;
                });
                const send = f.send();
                await reached(signerEntered.promise, send, 'send wins scheduled drain');
                expect(scheduledDrain).toBeDefined();
                scheduledDrain!();
                await turn();
                expect(f.delivered).toEqual([]);
                allowSigner.resolve(Uint8Array.of(8));
                expect(await bounded(send, 'scheduled drain send')).toMatchObject({
                    status: 'response',
                });
                await waitFor(() => f.delivered.length === 3, 'scheduled drain released');
                expect(f.delivered).toEqual(['verify:210', 'push:210', 'body:210']);
                await turn();
                expect(f.delivered).toHaveLength(3);
            } finally {
                immediateSpy.mockRestore();

                if (scheduledDrain && !invoked) {
                    scheduledDrain();
                }
            }
        }));

    it('rechecks the send gate after the 32-frame fairness yield before shifting another push', () =>
        withFixture(async (f) => {
            await f.register();
            const verifyEntered = deferred<void>();
            const allowVerify = f.gate(true);
            const yieldScheduled = deferred<void>();
            const signerEntered = deferred<void>();
            const allowSigner = f.gate(Uint8Array.of(8));
            const original = globalThis.setImmediate;
            let resumeYield: (() => void) | undefined;
            let yieldResumed = false;
            let immediateSpy: ReturnType<typeof vi.spyOn> | undefined;
            f.setPushVerifier((sequence) => {
                if (sequence === 300) {
                    verifyEntered.resolve();
                    return allowVerify.promise;
                }

                return true;
            });
            f.setBodyHandler((sequence) => {
                if (sequence === 330) {
                    immediateSpy = vi
                        .spyOn(globalThis, 'setImmediate')
                        .mockImplementation((callback, ...args) => {
                            resumeYield = () => {
                                yieldResumed = true;
                                callback(...args);
                            };

                            immediateSpy?.mockRestore();
                            yieldScheduled.resolve();
                            return original(() => {});
                        });
                }
            });

            try {
                f.injectPush(300);
                await bounded(verifyEntered.promise, 'first push held');

                for (let sequence = 301; sequence < 340; sequence++) {
                    f.injectPush(sequence);
                }

                // Allow the raw multiplexer to process its own fairness turn while
                // the first user verifier remains gated.
                await turn();
                await turn();
                await turn();
                allowVerify.resolve(true);
                await bounded(yieldScheduled.promise, '32-frame fairness yield');
                expect(f.delivered).toHaveLength(31 * 3);
                f.setSigner(() => {
                    signerEntered.resolve();
                    return allowSigner.promise;
                });
                const send = f.send();
                await reached(signerEntered.promise, send, 'send during push yield');
                expect(resumeYield).toBeDefined();
                resumeYield!();
                await turn();
                expect(f.delivered).toHaveLength(31 * 3);
                allowSigner.resolve(Uint8Array.of(8));
                expect(await bounded(send, 'send during fairness yield')).toMatchObject({
                    status: 'response',
                });
                await waitFor(() => f.delivered.length === 40 * 3, 'remaining queued pushes');
                expect(f.delivered).toEqual(
                    Array.from({ length: 40 }, (_, i) => 300 + i).flatMap((sequence) => [
                        `verify:${sequence}`,
                        `push:${sequence}`,
                        `body:${sequence}`,
                    ]),
                );
            } finally {
                immediateSpy?.mockRestore();

                if (resumeYield && !yieldResumed) {
                    resumeYield();
                }
            }
        }));

    it.each(['verify', 'push', 'body'] as const)(
        'rejects an awaited send reentered from push %s without stopping the owner',
        (phase) =>
            withFixture(async (f) => {
                await f.register();
                const done = deferred<void>();
                let nestedWrites = -1;

                const reenter = async () => {
                    const before = f.requests.length;
                    await expectRejected(f.send(), 'nested send', /multiplex session busy/);
                    nestedWrites = f.requests.length - before;
                    done.resolve();
                };

                if (phase === 'verify') {
                    f.setPushVerifier(async () => {
                        await reenter();
                        return true;
                    });
                } else if (phase === 'push') {
                    f.setPushHandler(reenter);
                } else {
                    f.setBodyHandler(reenter);
                }

                f.injectPush(200);
                await bounded(done.promise, 'push reentry');
                await waitFor(() => f.delivered.includes('body:200'), 'push completion');
                await turn();
                expect(nestedWrites).toBe(0);
                expect(await bounded(f.send(), 'send after push')).toMatchObject({
                    status: 'response',
                });
            }),
    );

    it('rejects signer reentry and a concurrent send without poisoning the first send', () =>
        withFixture(async (f) => {
            await f.register();
            const entered = deferred<void>();
            const allow = f.gate(Uint8Array.of(8));
            let nested: Promise<unknown> | undefined;
            f.setSigner(() => {
                nested = f.send();
                entered.resolve();
                return allow.promise;
            });
            const first = f.send();
            await reached(entered.promise, first, 'first signer');
            await expectRejected(nested!, 'signer reentry', /multiplex session busy/);
            await expectRejected(f.send(), 'concurrent send', /multiplex session busy/);
            expect(f.requests).toHaveLength(1);
            f.setSigner(undefined);
            allow.resolve(Uint8Array.of(8));
            expect(await bounded(first, 'first send')).toMatchObject({ status: 'response' });
            expect(await bounded(f.send(), 'next send')).toMatchObject({ status: 'response' });
        }));

    it('rejects before registration and remains usable for registration', () =>
        withFixture(async (f) => {
            await expectRejected(
                f.send(),
                'before registration',
                /multiplex session not registered/,
            );
            let getterCalls = 0;
            const malformed = Object.defineProperty({}, 'request', {
                enumerable: true,
                get: () => {
                    getterCalls++;
                    throw new Error('unexpected getter');
                },
            });
            await expectRejected(
                f.track(f.session.sendText(malformed as Parameters<typeof f.session.sendText>[0])),
                'malformed before registration',
                /invalid send-text input/,
            );
            expect(getterCalls).toBe(0);
            expect(f.signed).toHaveLength(0);
            expect(f.requests).toHaveLength(0);
            await f.register();
            expect(await bounded(f.send(), 'after registration')).toMatchObject({
                status: 'response',
            });
        }));

    it('rejects accessors and proxies at each send boundary without callbacks or poisoning', () =>
        withFixture(async (f) => {
            await f.register();
            let invoked = 0;

            const trap = () => {
                invoked++;
                throw new Error('unexpected trap');
            };

            const proxy = <T extends object>(value: T): T =>
                new Proxy(value, {
                    get: trap,
                    ownKeys: trap,
                    getPrototypeOf: trap,
                    getOwnPropertyDescriptor: trap,
                });

            const accessor = (key: string, value: object) => {
                const copy = { ...value };
                Object.defineProperty(copy, key, { enumerable: true, get: trap });
                return copy;
            };

            const valid = request();
            const cases: unknown[] = [
                proxy({ request: valid, maxResponseBodyBytes: 65536 }),
                accessor('maxResponseBodyBytes', { request: valid, maxResponseBodyBytes: 65536 }),
                { request: proxy(valid), maxResponseBodyBytes: 65536 },
                { request: accessor('text', valid), maxResponseBodyBytes: 65536 },
                { request: { ...valid, route: proxy(valid.route) }, maxResponseBodyBytes: 65536 },
                {
                    request: { ...valid, route: accessor('kind', valid.route) },
                    maxResponseBodyBytes: 65536,
                },
                { request: { ...valid, clientSequence: -1n }, maxResponseBodyBytes: 65536 },
                { request: valid, maxResponseBodyBytes: -1 },
            ];

            for (const input of cases) {
                await expectRejected(
                    f.track(f.session.sendText(input as Parameters<typeof f.session.sendText>[0])),
                    'invalid input',
                    /invalid/,
                );
            }

            expect(invoked).toBe(0);
            expect(f.signed).toHaveLength(0);
            expect(f.verified).toHaveLength(0);
            expect(f.requests).toHaveLength(1);
            expect(await bounded(f.send(), 'send after invalid input')).toMatchObject({
                status: 'response',
            });
        }));

    it('snapshots the caller request before a pending signer resumes', () =>
        withFixture(async (f) => {
            await f.register();
            const input = request();
            const entered = deferred<void>();
            const allow = f.gate(Uint8Array.of(8));
            f.setSigner(() => {
                entered.resolve();
                return allow.promise;
            });
            const pending = f.send(input);
            await reached(entered.promise, pending, 'snapshot signer');
            Reflect.set(input.route, 'peerUin', 999n);
            Reflect.set(input.route, 'peerUid', 'changed');
            Reflect.set(input, 'text', 'changed');
            Reflect.set(input, 'clientSequence', 1n);
            Reflect.set(input, 'random', 2);
            Reflect.set(input, 'route', { kind: 'group', groupUin: 999n });
            allow.resolve(Uint8Array.of(8));
            expect(await bounded(pending, 'snapshotted send')).toMatchObject({
                status: 'response',
            });
            const written = f.requests[1];
            const decoded = protobuf_decode<DirectSendMessageRequest>(written.body);
            expect(decoded.routingHead.c2c).toEqual({ peerUin: 456n, peerUid: 'synthetic-peer' });
            expect(decoded.messageBody.richText.elems[0].text.text).toBe('synthetic text 中🙂');
            expect(decoded.clientSequence).toBe(clientSequence);
            expect(decoded.random).toBe(0x12345678);
            expect(written.body).toEqual(f.signed[0].body);
        }));

    it.each(['close', 'abort'] as const)(
        'revokes a retained send handle after %s and suppresses subsequent callbacks and writes',
        (mode) =>
            withFixture(async (f) => {
                await f.register();
                const retained = f.session.sendText;
                expect(await bounded(f.send(), 'initial send')).toMatchObject({
                    status: 'response',
                });

                if (mode === 'close') {
                    f.session.close();
                } else {
                    f.controller.abort();
                }

                await bounded(f.session.whenClosed, 'revoked close');
                const before = {
                    writes: f.requests.length,
                    signed: f.signed.length,
                    verified: f.verified.length,
                };
                await expectRejected(
                    f.track(retained({ request: request(), maxResponseBodyBytes: 65536 })),
                    'revoked send',
                    /invalid send session/,
                );
                expect({
                    writes: f.requests.length,
                    signed: f.signed.length,
                    verified: f.verified.length,
                }).toEqual(before);
            }),
    );

    it.each(['close', 'abort'] as const)(
        'suppresses a write after %s while the signer is pending',
        (mode) =>
            withFixture(async (f) => {
                await f.register();
                const entered = deferred<void>();
                const settled = deferred<void>();
                let callbackSettled = false;
                const allow = f.gate(Uint8Array.of(8));
                f.setSigner(async () => {
                    entered.resolve();

                    try {
                        return await allow.promise;
                    } finally {
                        callbackSettled = true;
                        settled.resolve();
                    }
                });
                const pending = f.send();
                await reached(entered.promise, pending, 'pending signer');

                if (mode === 'close') {
                    f.session.close();
                } else {
                    f.controller.abort();
                }

                await bounded(f.session.whenClosed, 'cancelled close while signer pending');
                expect(callbackSettled).toBe(false);
                await expectRejected(
                    pending,
                    'cancelled send',
                    /session send failed|send session stopped/,
                );
                allow.resolve(Uint8Array.of(8));
                await bounded(settled.promise, 'test signer callback settles');
                expect(callbackSettled).toBe(true);
                expect(f.requests).toHaveLength(1);
                expect(f.verified).toHaveLength(0);
            }),
    );

    it('keeps the successful session past attempt expiry but fences it at the lease deadline', async () => {
        let now = performance.now();
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);

        try {
            await withFixture(async (f) => {
                await f.register();
                now += 7100;
                expect(await bounded(f.send(), 'send after attempt lifetime')).toMatchObject({
                    status: 'response',
                });
                const writes = f.requests.length;
                now += 3000;
                await expectRejected(f.send(), 'expired lease send', /invalid send session/);
                await bounded(f.session.whenClosed, 'expired lease closes');
                expect(f.requests).toHaveLength(writes);
            });
        } finally {
            clock.mockRestore();
        }
    });

    it.each(['control', 'close', 'deadline'] as const)(
        'fences pending send delivery at its final queued-push liveness check: %s',
        (mode) =>
            withFixture(async (f) => {
                await f.register();
                const signerEntered = deferred<void>();
                const allowSigner = f.gate(Uint8Array.of(8));
                let armed = false;
                let directChecks = 0;
                let triggered = false;
                const nativeNow = performance.now.bind(performance);
                const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
                    const now = nativeNow();

                    if (armed) {
                        const frames = new Error().stack?.split('\n') ?? [];
                        const liveFrame = frames.findIndex((line) => /\bat live\b/.test(line));

                        if (liveFrame >= 0 && /\bsendText\b/.test(frames[liveFrame + 1] ?? '')) {
                            directChecks++;

                            // The first direct live check guards the response; the second
                            // is the queued-push wakeup in sendText's finally block.
                            if (directChecks === 2 && mode !== 'control') {
                                triggered = true;

                                if (mode === 'close') {
                                    f.session.close();
                                } else {
                                    return now + 20000;
                                }
                            }
                        }
                    }

                    return now;
                });

                try {
                    f.setSigner(() => {
                        signerEntered.resolve();
                        return allowSigner.promise;
                    });
                    f.setVerifier(() => {
                        armed = true;
                        return true;
                    });
                    const pending = f.send();
                    await reached(signerEntered.promise, pending, 'final fence signer');
                    f.injectPush(250);
                    await turn();
                    await turn();
                    expect(f.delivered).toEqual([]);
                    allowSigner.resolve(Uint8Array.of(8));

                    if (mode === 'control') {
                        expect(await bounded(pending, 'final fence control')).toMatchObject({
                            status: 'response',
                        });
                        await waitFor(() => f.delivered.length === 3, 'control queued push');
                        expect(f.delivered).toEqual(['verify:250', 'push:250', 'body:250']);
                        expect(triggered).toBe(false);
                    } else {
                        await expectRejected(
                            pending,
                            'final fence interrupted',
                            /send session stopped/,
                        );
                        await bounded(f.session.whenClosed, 'final fence closes');
                        await turn();
                        expect(triggered).toBe(true);
                        expect(f.delivered).toEqual([]);
                    }

                    expect(directChecks).toBeGreaterThanOrEqual(2);
                } finally {
                    clock.mockRestore();
                }
            }),
    );

    it.each(['normal', 'deadline', 'throw'] as const)(
        'preserves or closes a reentrant new send at the old send final fence: %s',
        (mode) =>
            withFixture(async (f) => {
                await f.register();
                const firstSignerEntered = deferred<void>();
                const secondSignerEntered = deferred<void>();
                const releaseFirst = f.gate(Uint8Array.of(8));
                const releaseSecond = f.gate(Uint8Array.of(8));
                let signerCalls = 0;
                let armed = false;
                let directChecks = 0;
                let triggered = false;
                let second: Promise<unknown> | undefined;
                const nativeNow = performance.now.bind(performance);
                const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
                    const now = nativeNow();

                    if (armed && !triggered) {
                        const frames = new Error().stack?.split('\n') ?? [];
                        const liveFrame = frames.findIndex((line) => /\bat live\b/.test(line));

                        if (liveFrame >= 0 && /\bsendText\b/.test(frames[liveFrame + 1] ?? '')) {
                            directChecks++;

                            // The first direct check guards the old response. The second
                            // wakes its queued push after releasing the old send gate.
                            if (directChecks === 2) {
                                triggered = true;
                                second = f.send(request('group'));

                                if (mode === 'throw') {
                                    throw new Error('synthetic final clock fault');
                                }

                                if (mode === 'deadline') {
                                    return now + 20000;
                                }
                            }
                        }
                    }

                    return now;
                });

                try {
                    f.setSigner(() => {
                        signerCalls++;

                        if (signerCalls === 1) {
                            firstSignerEntered.resolve();
                            return releaseFirst.promise;
                        }

                        secondSignerEntered.resolve();
                        return releaseSecond.promise;
                    });
                    f.setVerifier(() => {
                        armed = true;
                        return true;
                    });
                    const first = f.send();
                    await reached(firstSignerEntered.promise, first, 'old send signer');
                    f.injectPush(260);
                    await turn();
                    await turn();
                    expect(f.delivered).toEqual([]);
                    releaseFirst.resolve(Uint8Array.of(8));

                    if (mode === 'normal') {
                        expect(await bounded(first, 'old reentrant send')).toMatchObject({
                            status: 'response',
                        });
                        expect(triggered).toBe(true);
                        expect(second).toBeDefined();
                        await reached(secondSignerEntered.promise, second!, 'new reentrant signer');
                        expect(f.delivered).toEqual([]);
                        releaseSecond.resolve(Uint8Array.of(8));
                        expect(await bounded(second!, 'new reentrant send')).toMatchObject({
                            status: 'response',
                        });
                        await waitFor(() => f.delivered.length === 3, 'reentrant push release');
                        expect(f.delivered).toEqual(['verify:260', 'push:260', 'body:260']);
                        expect(f.requests.slice(1).map(({ sequence }) => sequence)).toEqual([
                            54, 55,
                        ]);
                    } else {
                        await expectRejected(
                            first,
                            'old reentrant failure',
                            /send session stopped|synthetic final clock fault/,
                        );
                        expect(triggered).toBe(true);
                        expect(second).toBeDefined();
                        await bounded(
                            f.session.whenClosed,
                            'reentrant failure closes before second gate',
                        );
                        await expectRejected(
                            second!,
                            'new reentrant failure',
                            /session send failed|send session stopped|invalid send session|^Error: session stopped$/,
                        );
                        releaseSecond.resolve(Uint8Array.of(8));
                        await turn();
                        expect(f.requests).toHaveLength(2);
                        expect(f.delivered).toEqual([]);
                    }

                    expect(directChecks).toBe(2);
                } finally {
                    clock.mockRestore();
                }
            }),
    );

    it('holds push callbacks while a response verifier is pending, then drains FIFO', () =>
        withFixture(async (f) => {
            await f.register();
            const entered = deferred<void>();
            const allow = f.gate(true);
            f.setVerifier(() => {
                entered.resolve();
                return allow.promise;
            });
            const pending = f.send();
            await reached(entered.promise, pending, 'response verifier');
            f.injectPush(54);
            f.injectPush(141);
            await turn();
            await turn();
            expect(f.delivered).toEqual([]);
            allow.resolve(true);
            expect(await bounded(pending, 'verified send')).toMatchObject({ status: 'response' });
            await waitFor(() => f.delivered.length === 6, 'verified send push queue');
            expect(f.delivered).toEqual(
                [54, 141].flatMap((sequence) => [
                    `verify:${sequence}`,
                    `push:${sequence}`,
                    `body:${sequence}`,
                ]),
            );
        }));

    it('fences a pending verifier on close and wipes only the borrowed callback buffers', () =>
        withFixture(async (f) => {
            await f.register();
            const entered = deferred<void>();
            const settled = deferred<void>();
            let callbackSettled = false;
            const allow = f.gate(true);
            let borrowed: Uint8Array[] = [];
            let retainedCopy = new Uint8Array();
            f.setVerifier(async (input) => {
                borrowed = [input.requestFrame, input.responseFrame];
                retainedCopy = Uint8Array.from(input.responseFrame);
                entered.resolve();

                try {
                    return await allow.promise;
                } finally {
                    callbackSettled = true;
                    settled.resolve();
                }
            });
            const pending = f.send();
            await reached(entered.promise, pending, 'pending response verifier');
            expect(retainedCopy.some((byte) => byte !== 0)).toBe(true);
            f.session.close();
            await bounded(f.session.whenClosed, 'closed owner while verifier pending');
            expect(callbackSettled).toBe(false);
            await expectRejected(
                pending,
                'closed response verifier',
                /session send failed|send session stopped/,
            );
            allow.resolve(true);
            await bounded(settled.promise, 'test verifier callback settles');
            expect(callbackSettled).toBe(true);
            await turn();
            expect(borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
            // An independently retained callback copy remains under callback ownership.
            expect(retainedCopy.some((byte) => byte !== 0)).toBe(true);
        }));

    it('accepts an exact response body limit and fails closed one byte below it', async () => {
        const payload = protobuf_encode<DirectSendMessageResponse>({
            result: 0,
            sequence: 99n,
            clientSequence: 88n,
        });
        const size = payload.byteLength;
        payload.fill(0);
        await withFixture(async (f) => {
            await f.register();
            expect(await bounded(f.send(request(), size), 'exact body limit')).toMatchObject({
                status: 'response',
            });
        });
        await withFixture(async (f) => {
            await f.register();
            await expectRejected(
                f.send(request(), size - 1),
                'small body limit',
                /session send failed/,
            );
            await bounded(f.session.whenClosed, 'small limit closes');
            const writes = f.requests.length;
            await expectRejected(f.send(), 'send after body limit', /invalid send session/);
            expect(f.requests).toHaveLength(writes);
        });
    });

    it('fails closed on an SSO error without exposing response content', () =>
        withFixture(async (f) => {
            await f.register();
            f.setRetCode(42);
            const outcome = await bounded(
                f.send().then(
                    (value) => ({ value }),
                    (error: unknown) => ({ error }),
                ),
                'sso error',
            );
            expect(outcome).toHaveProperty('error');
            expect(String((outcome as { error: unknown }).error)).toMatch(/session send failed/);
            expect(String((outcome as { error: unknown }).error)).not.toContain('42');
            await bounded(f.session.whenClosed, 'sso error closes');
            const count = f.requests.length;
            await expectRejected(f.send(), 'send after error', /invalid send session/);
            expect(f.requests).toHaveLength(count);
        }));

    it('fails closed after the send response verifier rejects the synthetic candidate', () =>
        withFixture(async (f) => {
            await f.register();
            f.setVerifier(() => false);
            await expectRejected(f.send(), 'rejected candidate', /session send failed/);
            await bounded(f.session.whenClosed, 'rejected candidate closes');
            const count = f.requests.length;
            await expectRejected(
                f.send(),
                'send after verification failure',
                /invalid send session/,
            );
            expect(f.requests).toHaveLength(count);
        }));
});
