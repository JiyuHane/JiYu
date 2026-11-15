import { EventEmitter } from 'node:events';
import type { DirectThirdPartyLoginResponse } from '@snowluma/proto-defs/direct-login';
import type { PushMsg } from '@snowluma/proto-defs/message';
import type { GroupChange } from '@snowluma/proto-defs/notify';
import type { SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import { createWtMultiplexReference } from '../../src/direct/wt-multiplex-reference';
import { encodeWtTlv } from '../../src/direct/wt-tlv';
import { BridgeEventBus } from '../../src/event-bus';
import type { QQEventVariant } from '../../src/events';
import { GroupInviteTracker } from '../../src/group-invite-tracker';
import { IdentityService } from '../../src/identity-service';
import { parseDirectMsgPushOrThrow, SysMsgDedup } from '../../src/msg-push';
import { IncomingPacketPipeline } from '../../src/packet-pipeline';
import { fetchBody, parseWt, peer, pollBody, replyWt } from './fixtures/wt-sso-synthetic';

// Synthetic EventEmitter peers and memory-only dependencies. No application wiring.
const COMMAND = 'trpc.msg.olpush.OlPushService.MsgPush';
const zeroKey = new Uint8Array(16);
const ticketKey = new Uint8Array(16).fill(4);

const word = (n: number) => {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(n >>> 0);
    return result;
};

const field = (bytes: Uint8Array) => Buffer.concat([word(bytes.length + 4), bytes]);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function deadline<T>(promise: PromiseLike<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            Promise.resolve(promise),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`deadline: ${label}`)), 3000);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

async function waitFor(check: () => boolean, label: string) {
    const end = performance.now() + 3000;

    while (!check()) {
        if (performance.now() >= end) {
            throw new Error(`deadline: ${label}`);
        }

        await turn();
    }
}

function loginBody(key: Uint8Array) {
    const projection = protobuf_encode<DirectThirdPartyLoginResponse>({
        commonInfo: { rspNT: { uid: 'synthetic-uid' } },
    });
    const inner = encodeWtTlv([
        { tag: 0x143, value: Uint8Array.of(9) },
        { tag: 0x305, value: key },
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

function response(
    sequence: number,
    command: string,
    body: Uint8Array,
    account: string,
    key: Uint8Array,
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
    const payload = qqTeaEncrypt(inner, key);
    inner.fill(0);
    return Buffer.concat([
        word(14 + Buffer.byteLength(account) + payload.length),
        word(12),
        Buffer.of(1, 0),
        field(Buffer.from(account)),
        payload,
    ]);
}

function textBody(sequence: number, account: string, group: boolean, text: string) {
    return protobuf_encode<PushMsg>({
        message: {
            responseHead: {
                fromUin: 456,
                fromUid: `synthetic-sender-${account}`,
                toUin: Number(account),
                ...(group ? { grp: { groupUin: 789 } } : {}),
            },
            contentHead: {
                msgType: group ? 82 : 166,
                sequence,
                ntMsgSeq: sequence + 1000,
                timestamp: 1700000000,
                msgId: 99,
            },
            body: { richText: { elems: [{ text: { str: text } }] } },
        },
    });
}

function joinBody() {
    return protobuf_encode<PushMsg>({
        message: {
            responseHead: { fromUin: 789, fromUid: '' },
            contentHead: {
                msgType: 33,
                subType: 0,
                sequence: 800,
                timestamp: 1700000000,
                msgId: 555,
            },
            body: {
                msgContent: protobuf_encode<GroupChange>({
                    groupUin: 789,
                    memberUid: 'synthetic-new',
                }),
            },
        },
    });
}

function wtReply(request: ReturnType<typeof parseWt>, body: Uint8Array, account: string) {
    const original = replyWt(request, body);

    if (request.kind !== 0x810 || account === '123') {
        return original;
    }

    const oldEnd = 10 + original.readUInt32BE(10);
    const sso = Buffer.from(qqTeaDecrypt(original.subarray(oldEnd), zeroKey));
    const headerEnd = sso.readUInt32BE(0);
    const packet = Buffer.from(sso.subarray(headerEnd + 4));
    packet.writeUInt32BE(Number(account), 9);
    const rebuilt = Buffer.concat([sso.subarray(0, headerEnd), field(packet)]);
    const encrypted = qqTeaEncrypt(rebuilt, zeroKey);
    sso.fill(0);
    packet.fill(0);
    rebuilt.fill(0);
    return Buffer.concat([
        word(14 + Buffer.byteLength(account) + encrypted.length),
        word(12),
        Buffer.of(2, 0),
        field(Buffer.from(account)),
        encrypted,
    ]);
}

function registrationSequence(frame: Uint8Array, key: Uint8Array) {
    const bytes = Buffer.from(frame);
    const accountStart = 10 + bytes.readUInt32BE(9);
    const accountEnd = accountStart + bytes.readUInt32BE(accountStart);
    const inner = Buffer.from(qqTeaDecrypt(bytes.subarray(accountEnd), key));
    const sequence = inner.readUInt32BE(4);
    inner.fill(0);
    return sequence;
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

type Settings = {
    account?: string;
    identityAccount?: string;
    keyByte?: number;
    holdRegister?: boolean;
    registrationPushes?: boolean;
    holdHandler?: boolean;
};

function setup(settings: Settings = {}) {
    const account = settings.account ?? '123';
    const key = new Uint8Array(16).fill(settings.keyByte ?? 10);
    const identity = IdentityService.memory(settings.identityAccount ?? account);
    const dedup = new SysMsgDedup();
    const bus = new BridgeEventBus();
    const captured: QQEventVariant[] = [];
    bus.onAny((event) => {
        captured.push(event);
    });
    const pipeline = new IncomingPacketPipeline({
        identity,
        events: bus,
        fetchGroupList: async () => {},
        fetchGroupMemberList: async () => {},
        resolveGroupJoinRequest: async () => null,
        groupInvites: new GroupInviteTracker(),
    });
    const dispatch = vi.spyOn(pipeline, 'processDecodedDirectEvents');
    const stream = new FakeStream();
    const registerEntered = deferred<void>();
    const allowRegister = deferred<void>();
    const handlerEntered = deferred<void>();
    const allowHandler = deferred<void>();
    const failures: unknown[] = [];
    const parseErrors: unknown[] = [];
    const borrowed: Uint8Array[] = [];
    const handled: number[] = [];
    const handlerStarted: number[] = [];
    const handlerSettled: number[] = [];
    const handlerErrors: unknown[] = [];
    const pendingHandlers = new Set<Promise<void>>();
    let calls = 0;
    stream.on('error', (error) => failures.push(error));
    const baseline = new Map(
        ['data', 'error', 'end', 'close', 'pause'].map((name) => [name, stream.listeners(name)]),
    );
    const session = createWtMultiplexReference(stream, {
        exclusiveConnected: true,
        transportUin: '0',
        initialSequence: 50,
        maxFrameBytes: 65536,
        maxBufferedBytes: 262144,
        maxFrames: 16,
        maxPushFrames: 8,
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
            buildRegisterReserved: ({ sequence }) => Uint8Array.of(sequence),
            verifyRegisterRaw: async () => {
                if (settings.holdRegister) {
                    registerEntered.resolve();
                    await allowRegister.promise;
                }

                return true;
            },
        },
        verifyPushRaw: () => true,
        onPush: () => {},
        onPushBody: (body, meta) => {
            handlerStarted.push(meta.sequence);
            const task = (async () => {
                try {
                    borrowed.push(body);
                    handled.push(meta.sequence);
                    let parsed: QQEventVariant[];

                    try {
                        parsed = parseDirectMsgPushOrThrow({ ...meta, body }, identity, dedup);
                    } catch (error) {
                        parseErrors.push(error);
                        return;
                    }

                    await pipeline.processDecodedDirectEvents(
                        { serviceCmd: meta.command, seqId: meta.sequence },
                        parsed,
                    );

                    if (settings.holdHandler) {
                        handlerEntered.resolve();
                        await allowHandler.promise;
                    }
                } finally {
                    handlerSettled.push(meta.sequence);
                }
            })();
            pendingHandlers.add(task);
            void task.then(
                () => pendingHandlers.delete(task),
                (error) => {
                    handlerErrors.push(error);
                    pendingHandlers.delete(task);
                },
            );
            return task;
        },
    });
    const push = (sequence: number, body: Uint8Array) =>
        response(sequence, COMMAND, body, account, key);

    stream.onWrite = (bytes) => {
        try {
            calls++;

            if (calls <= 3) {
                const request = parseWt(bytes);
                const body =
                    request.kind === 0x31
                        ? fetchBody()
                        : request.kind === 0x12
                          ? pollBody(0, BigInt(account))
                          : loginBody(key);
                const candidate = wtReply(request, body, account);
                body.fill(0);
                request.shared.fill(0);
                request.business.fill(0);

                if (calls === 3) {
                    stream.emit(
                        'data',
                        Buffer.concat([
                            candidate,
                            push(52, textBody(152, account, false, `friend ${account}`)),
                        ]),
                    );
                } else {
                    stream.emit('data', candidate);
                }
            } else {
                const sequence = registrationSequence(bytes, key);
                const body = protobuf_encode<SsoRegisterResponse>({
                    register: { message: 'register success' },
                });
                const candidate = response(sequence, SSO_INFO_SYNC_COMMAND, body, account, key);
                body.fill(0);

                if (settings.registrationPushes) {
                    stream.emit(
                        'data',
                        Buffer.concat([
                            push(sequence, textBody(153, account, true, `group ${account}`)),
                            candidate,
                        ]),
                    );
                } else {
                    stream.emit('data', candidate);
                }
            }
        } catch (error) {
            failures.push(error);
            stream.emit('error', error);
        } finally {
            bytes.fill(0);
        }
    };

    async function start() {
        expect((await deadline(session.fetch(fetchFields), 'fetch')).qrUrl).toBe(
            'https://example.invalid/qr',
        );
        expect(await deadline(session.poll(), 'poll')).toEqual({ status: 'confirmed' });
    }

    async function cleanup() {
        session.close();
        allowRegister.resolve();
        allowHandler.resolve();
        stream.finishClose();
        await deadline(session.whenClosed, 'close');
        // whenClosed is only logical closure. Drain our own onPushBody tasks.
        await deadline(Promise.allSettled([...pendingHandlers]), 'synthetic handlers settle');
        expect(handlerSettled).toEqual(handlerStarted);
        expect(handlerErrors).toEqual([]);
        await turn();

        for (const [name, listeners] of baseline) {
            expect(stream.listeners(name)).toEqual(listeners);
        }

        dispatch.mockRestore();
    }

    return {
        account,
        identity,
        dedup,
        bus,
        captured,
        pipeline,
        dispatch,
        stream,
        session,
        push,
        borrowed,
        handled,
        handlerStarted,
        handlerSettled,
        failures,
        parseErrors,
        registerEntered,
        allowRegister,
        handlerEntered,
        allowHandler,
        start,
        cleanup,
    };
}

describe('synthetic WT producer through direct parser and memory pipeline', () => {
    it('releases queued friend and group through the bus after registration, then wipes bodies', async () => {
        const f = setup({ holdRegister: true, registrationPushes: true });
        const release = deferred<void>();
        const asyncText: string[] = [];
        f.bus.onAny(async (event) => {
            await release.promise;

            if (event.kind === 'friend_message' || event.kind === 'group_message') {
                const element = event.elements[0];

                if (element?.type === 'text') {
                    asyncText.push(element.text);
                }
            }
        });

        try {
            await f.start();
            const work = f.session.loginAndRegister(loginFields);
            await deadline(f.registerEntered.promise, 'registration entered');
            expect(f.captured).toEqual([]);
            expect(f.borrowed).toEqual([]);
            expect(f.dispatch).not.toHaveBeenCalled();
            f.allowRegister.resolve();
            expect(await deadline(work, 'registration')).toEqual({ status: 'success' });
            await waitFor(() => f.captured.length === 2 && f.borrowed.length === 2, 'both pushes');
            await waitFor(
                () =>
                    f.borrowed.length === 2 &&
                    f.borrowed.every((body) => body.length > 0 && body.every((byte) => byte === 0)),
                'both borrowed bodies wiped',
            );
            expect(f.handled).toEqual([52, 53]);
            expect(f.dispatch.mock.calls.map(([trace]) => trace)).toEqual([
                { serviceCmd: COMMAND, seqId: 52 },
                { serviceCmd: COMMAND, seqId: 53 },
            ]);
            expect(f.captured).toMatchObject([
                {
                    kind: 'friend_message',
                    selfUin: 123,
                    senderUin: 456,
                    msgSeq: 152,
                    elements: [{ type: 'text', text: 'friend 123' }],
                },
                {
                    kind: 'group_message',
                    selfUin: 123,
                    groupId: 789,
                    msgSeq: 153,
                    elements: [{ type: 'text', text: 'group 123' }],
                },
            ]);
            expect(
                f.borrowed.every((body) => body.length > 0 && body.every((byte) => byte === 0)),
            ).toBe(true);
            expect(asyncText).toEqual([]);
            release.resolve();
            await waitFor(() => asyncText.length === 2, 'asynchronous text observations');
            expect(asyncText).toEqual(['friend 123', 'group 123']);
            expect(f.parseErrors).toEqual([]);
            expect(f.failures).toEqual([]);
        } finally {
            release.resolve();
            await f.cleanup();
        }
    });

    it('does not dispatch when the parser identity differs from the delivered account', async () => {
        const f = setup({ identityAccount: '234' });

        try {
            await f.start();
            expect(await deadline(f.session.loginAndRegister(loginFields), 'registration')).toEqual(
                { status: 'success' },
            );
            await waitFor(() => f.parseErrors.length === 1, 'identity mismatch');
            expect(f.parseErrors[0]).toBeInstanceOf(TypeError);
            expect(String(f.parseErrors[0])).toMatch(/identity UIN mismatch/);
            expect(f.dispatch).not.toHaveBeenCalled();
            expect(f.captured).toEqual([]);
            expect(f.identity.findUinByUid('synthetic-sender-123')).toBeNull();
        } finally {
            await f.cleanup();
        }
    });

    it('isolates account identity and actual system-message dedup state', async () => {
        const a = setup({ account: '123', keyByte: 0x21 });
        const b = setup({ account: '234', keyByte: 0x43 });

        try {
            await Promise.all([a.start(), b.start()]);
            expect(
                await Promise.all([
                    deadline(a.session.loginAndRegister(loginFields), 'register A'),
                    deadline(b.session.loginAndRegister(loginFields), 'register B'),
                ]),
            ).toEqual([{ status: 'success' }, { status: 'success' }]);
            await waitFor(
                () => a.captured.length === 1 && b.captured.length === 1,
                'account messages',
            );
            expect(a.dedup).not.toBe(b.dedup);
            expect(a.identity.findUinByUid('synthetic-sender-123')).toBe(456);
            expect(b.identity.findUinByUid('synthetic-sender-234')).toBe(456);
            expect(a.identity.findUinByUid('synthetic-sender-234')).toBeNull();
            expect(b.identity.findUinByUid('synthetic-sender-123')).toBeNull();
            expect(a.captured[0]).toMatchObject({
                selfUin: 123,
                elements: [{ text: 'friend 123' }],
            });
            expect(b.captured[0]).toMatchObject({
                selfUin: 234,
                elements: [{ text: 'friend 234' }],
            });
            const body = joinBody();
            a.stream.emit('data', Buffer.concat([a.push(201, body), a.push(202, body)]));
            b.stream.emit('data', Buffer.concat([b.push(201, body), b.push(202, body)]));
            await waitFor(
                () => a.handlerSettled.length === 3 && b.handlerSettled.length === 3,
                'dedup handlers settle',
            );
            expect(a.handlerStarted).toEqual([52, 201, 202]);
            expect(b.handlerStarted).toEqual([52, 201, 202]);
            expect(a.handlerSettled).toEqual(a.handlerStarted);
            expect(b.handlerSettled).toEqual(b.handlerStarted);
            expect(a.dispatch).toHaveBeenCalledTimes(3);
            expect(b.dispatch).toHaveBeenCalledTimes(3);
            expect(a.captured).toHaveLength(2);
            expect(b.captured).toHaveLength(2);
            expect(a.captured.filter((event) => event.kind === 'group_member_join')).toHaveLength(
                1,
            );
            expect(b.captured.filter((event) => event.kind === 'group_member_join')).toHaveLength(
                1,
            );
            expect(a.captured[1]).toMatchObject({
                selfUin: 123,
                groupId: 789,
                userUid: 'synthetic-new',
            });
            expect(b.captured[1]).toMatchObject({
                selfUin: 234,
                groupId: 789,
                userUid: 'synthetic-new',
            });
            expect(a.parseErrors).toEqual([]);
            expect(b.parseErrors).toEqual([]);
        } finally {
            await Promise.all([a.cleanup(), b.cleanup()]);
        }
    });

    it('wipes during a pending handler on close; an async text subscriber has its own completion', async () => {
        const f = setup({ holdHandler: true });
        const entered = deferred<void>();
        const release = deferred<void>();
        const completed = deferred<void>();
        let observedText: string | undefined;
        f.bus.on('friend_message', async (event) => {
            entered.resolve();
            await release.promise;
            observedText = event.elements[0]?.type === 'text' ? event.elements[0].text : undefined;
            completed.resolve();
        });

        try {
            await f.start();
            expect(await deadline(f.session.loginAndRegister(loginFields), 'registration')).toEqual(
                { status: 'success' },
            );
            await deadline(entered.promise, 'subscriber entered');
            await deadline(f.handlerEntered.promise, 'pipeline finished inside handler');
            expect(f.handlerStarted).toEqual([52]);
            expect(f.handlerSettled).toEqual([]);
            expect(f.borrowed[0]?.some((byte) => byte !== 0)).toBe(true);
            f.session.close();
            await deadline(f.session.whenClosed, 'closed while handler pending');
            expect(f.borrowed[0]?.every((byte) => byte === 0)).toBe(true);
            expect(f.handlerSettled).toEqual([]);
            expect(observedText).toBeUndefined();
            f.allowHandler.resolve();
            await waitFor(() => f.handlerSettled.length === 1, 'handler settles after release');
            expect(f.handlerSettled).toEqual([52]);
            expect(observedText).toBeUndefined();
            release.resolve();
            await deadline(completed.promise, 'subscriber completion');
            // This assertion concerns this text fixture, not all decoded binary fields.
            expect(observedText).toBe('friend 123');
            expect(f.handled).toEqual([52]);
        } finally {
            release.resolve();
            await f.cleanup();
        }
    });
});
