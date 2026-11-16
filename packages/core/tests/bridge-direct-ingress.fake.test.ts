import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { PushMsg } from '@snowluma/proto-defs/message';
import { protobuf_encode } from '@snowluma/proton';
import type {
    DirectPushIngress,
    DirectPushMeta,
} from '@snowluma/protocol/direct/direct-push-ingress';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { IncomingPacketPipeline } from '@snowluma/protocol/packet-pipeline';
import { describe, expect, it, vi } from 'vitest';

import { Bridge } from '../src/bridge/bridge';

// Synthetic, in-memory fixtures. Activation is not peer authentication.
const A = '2000000001';
const B = '2000000002';
const COMMAND = 'trpc.msg.olpush.OlPushService.MsgPush';
const options = {
    sourceAuthenticationHandled: true,
    maxBodyBytes: 65536,
    maxPendingBytes: 262144,
    maxPending: 8,
    maxEventsPerPush: 16,
} as const;

function friend(text: string): Uint8Array {
    return protobuf_encode<PushMsg>({
        message: {
            responseHead: { fromUin: 10001, fromUid: 'synthetic_peer' },
            contentHead: {
                msgType: 166,
                sequence: 32743,
                ntMsgSeq: 63214,
                timestamp: 1700000000,
                msgId: 1,
            },
            body: { richText: { elems: [{ text: { str: text } }] } },
        },
    });
}

function meta(uin: string, sequence = 1): DirectPushMeta {
    return { uin, sequence, command: COMMAND, retCode: 0 };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('synthetic ingress watchdog')), 2000);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

function setup(uin: string) {
    const identity = IdentityService.memory(uin);
    const bridge = new Bridge(identity);
    const captured: QQEventVariant[] = [];
    bridge.events.onAny((event) => {
        captured.push(event);
    });

    const unexpected = async (): Promise<never> => {
        throw new Error('unexpected synthetic external activity');
    };

    const send = vi.spyOn(bridge, 'sendRawPacket').mockImplementation(unexpected);
    const friends = vi
        .spyOn(bridge.apis.contacts, 'fetchFriendList')
        .mockImplementation(unexpected);
    const groups = vi.spyOn(bridge.apis.contacts, 'fetchGroupList').mockImplementation(unexpected);
    const members = vi
        .spyOn(bridge.apis.contacts, 'fetchGroupMemberList')
        .mockImplementation(unexpected);
    return { bridge, identity, captured, send, friends, groups, members };
}

function expectNoExternalActivity(f: ReturnType<typeof setup>) {
    expect(f.bridge.empty).toBe(true);
    expect(f.bridge.activePid).toBeNull();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.friends).not.toHaveBeenCalled();
    expect(f.groups).not.toHaveBeenCalled();
    expect(f.members).not.toHaveBeenCalled();
}

async function cleanup(bridge: Bridge, ingress?: DirectPushIngress) {
    ingress?.stop();

    try {
        if (ingress) {
            await bounded(ingress.drain());
        }
    } finally {
        await bounded(bridge.dispose());
    }
}

describe('Bridge direct ingress with memory-only synthetic inputs', () => {
    it('is opt-in, claims once, snapshots bytes, and isolates parallel accounts', async () => {
        const a = setup(A);
        const b = setup(B);
        let ingressA: DirectPushIngress | undefined;
        let ingressB: DirectPushIngress | undefined;

        try {
            expectNoExternalActivity(a);
            expectNoExternalActivity(b);
            expect(a.captured).toEqual([]);
            expect(b.captured).toEqual([]);
            ingressA = a.bridge.openDirectPushIngress(options);
            ingressB = b.bridge.openDirectPushIngress(options);
            expect(Object.isFrozen(ingressA)).toBe(true);
            expect(await ingressA.submit(friend('disabled'), meta(A))).toEqual({
                kind: 'rejected',
                reason: 'not-active',
            });
            expect(a.captured).toEqual([]);
            expect(b.captured).toEqual([]);
            expect(() => a.bridge.openDirectPushIngress(options)).toThrow();
            expect(ingressA.activate()).toBe(true);
            expect(ingressB.activate()).toBe(true);
            expect(await ingressA.submit(friend('wrong account'), meta(B))).toEqual({
                kind: 'rejected',
                reason: 'invalid',
            });
            const bodyA = friend('snapshot A');
            const bodyB = friend('snapshot B');
            const submissionA = ingressA.submit(bodyA, meta(A, 11));
            const submissionB = ingressB.submit(bodyB, meta(B, 12));
            bodyA.fill(0);
            bodyB.fill(0);
            expect(await bounded(Promise.all([submissionA, submissionB]))).toEqual([
                { kind: 'settled', events: 1 },
                { kind: 'settled', events: 1 },
            ]);
            expect(a.captured).toMatchObject([
                {
                    kind: 'friend_message',
                    selfUin: Number(A),
                    senderUin: 10001,
                    elements: [{ type: 'text', text: 'snapshot A' }],
                },
            ]);
            expect(b.captured).toMatchObject([
                {
                    kind: 'friend_message',
                    selfUin: Number(B),
                    senderUin: 10001,
                    elements: [{ type: 'text', text: 'snapshot B' }],
                },
            ]);
            expectNoExternalActivity(a);
            expectNoExternalActivity(b);
            ingressA.stop();
            await bounded(ingressA.drain());
            expect(() => a.bridge.openDirectPushIngress(options)).toThrow();
            expect(ingressA.activate()).toBe(false);
            expect(await ingressA.submit(friend('stopped'), meta(A))).toEqual({
                kind: 'rejected',
                reason: 'stopped',
            });
        } finally {
            try {
                await Promise.all([cleanup(a.bridge, ingressA), cleanup(b.bridge, ingressB)]);
            } finally {
                vi.restoreAllMocks();
            }
        }
    });

    it('stops ingress before disposing, drains actual pipeline work, and closes exactly once', async () => {
        const gate = deferred();
        const entered = deferred();
        const original = IncomingPacketPipeline.prototype.processDecodedDirectEvents;
        const pipeline = vi
            .spyOn(IncomingPacketPipeline.prototype, 'processDecodedDirectEvents')
            .mockImplementation(async function (this: IncomingPacketPipeline, trace, events) {
                entered.resolve();
                await gate.promise;
                await original.call(this, trace, events);
            });
        const f = setup(A);
        const close = vi.spyOn(f.identity, 'close');
        const clear = vi.spyOn(f.bridge.events, 'clear');
        let ingress: DirectPushIngress | undefined;
        let submission: Promise<unknown> | undefined;
        let closing: Promise<void> | undefined;

        try {
            ingress = f.bridge.openDirectPushIngress(options);
            expect(ingress.activate()).toBe(true);
            submission = ingress.submit(friend('draining'), meta(A, 44));
            await bounded(entered.promise);
            expect(pipeline).toHaveBeenCalledTimes(1);
            closing = f.bridge.dispose();
            expect(f.bridge.dispose()).toBe(closing);
            expect(ingress.activate()).toBe(false);
            expect(await ingress.submit(friend('after stop'), meta(A))).toEqual({
                kind: 'rejected',
                reason: 'stopped',
            });
            expect(() => f.bridge.openDirectPushIngress(options)).toThrow();
            await Promise.resolve();
            expect(close).not.toHaveBeenCalled();
            expect(clear).not.toHaveBeenCalled();
            expect(f.captured).toEqual([]);
            gate.resolve();
            expect(await bounded(submission)).toEqual({ kind: 'settled', events: 1 });
            await bounded(closing);
            expect(f.captured).toMatchObject([
                {
                    kind: 'friend_message',
                    selfUin: Number(A),
                    elements: [{ type: 'text', text: 'draining' }],
                },
            ]);
            expect(close).toHaveBeenCalledTimes(1);
            expect(clear).toHaveBeenCalledTimes(1);
            expect(close.mock.invocationCallOrder[0]).toBeLessThan(
                clear.mock.invocationCallOrder[0],
            );
            expect(f.bridge.dispose()).toBe(closing);
            expect(() => f.bridge.openDirectPushIngress(options)).toThrow();
            expect(await ingress.submit(friend('closed'), meta(A))).toEqual({
                kind: 'rejected',
                reason: 'stopped',
            });
            expectNoExternalActivity(f);
        } finally {
            gate.resolve();

            try {
                try {
                    if (submission) {
                        await bounded(submission);
                    }
                } finally {
                    await cleanup(f.bridge, ingress);
                }
            } finally {
                vi.restoreAllMocks();
            }
        }
    });

    it('keeps the internal drain private if an exposed drain promise is modified', async () => {
        const gate = deferred();
        const entered = deferred();
        const original = IncomingPacketPipeline.prototype.processDecodedDirectEvents;
        vi.spyOn(IncomingPacketPipeline.prototype, 'processDecodedDirectEvents').mockImplementation(
            async function (this: IncomingPacketPipeline, trace, events) {
                entered.resolve();
                await gate.promise;
                await original.call(this, trace, events);
            },
        );
        const f = setup(A);
        const close = vi.spyOn(f.identity, 'close');
        let ingress: DirectPushIngress | undefined;

        try {
            ingress = f.bridge.openDirectPushIngress(options);
            expect(ingress.activate()).toBe(true);
            const submission = ingress.submit(friend('drain isolation'), meta(A));
            await bounded(entered.promise);
            ingress.stop();
            const exposed = ingress.drain();
            const observed = exposed.then(() => undefined);
            Object.defineProperty(exposed, 'constructor', {
                configurable: true,
                get() {
                    throw new Error('synthetic public promise mutation');
                },
            });
            const closing = f.bridge.dispose();
            await Promise.resolve();
            expect(close).not.toHaveBeenCalled();
            gate.resolve();
            expect(await bounded(submission)).toEqual({ kind: 'settled', events: 1 });
            await bounded(Promise.all([observed, closing]));
            expect(close).toHaveBeenCalledTimes(1);
        } finally {
            gate.resolve();

            try {
                await cleanup(f.bridge, ingress);
            } finally {
                vi.restoreAllMocks();
            }
        }
    });

    it('settles a synchronous factory failure so the Bridge remains disposable', async () => {
        const f = setup(A);
        const descriptor = Object.getOwnPropertyDescriptor(f.identity, 'uin');
        const marker = new Error('synthetic factory failure');
        Object.defineProperty(f.identity, 'uin', {
            configurable: true,
            get() {
                throw marker;
            },
        });

        try {
            expect(() => f.bridge.openDirectPushIngress(options)).toThrow(marker);
        } finally {
            if (descriptor) {
                Object.defineProperty(f.identity, 'uin', descriptor);
            } else {
                Reflect.deleteProperty(f.identity, 'uin');
            }

            try {
                expect(() => f.bridge.openDirectPushIngress(options)).toThrow(
                    'Direct push ingress already claimed',
                );
                const closing = f.bridge.dispose();
                expect(f.bridge.dispose()).toBe(closing);
                await bounded(closing);
                expect(() => f.bridge.openDirectPushIngress(options)).toThrow();
                expectNoExternalActivity(f);
            } finally {
                vi.restoreAllMocks();
            }
        }
    });

    it('handles synchronous dispose reentry during factory construction', async () => {
        const f = setup(A);
        const descriptor = Object.getOwnPropertyDescriptor(f.identity, 'uin');
        let closing: Promise<void> | undefined;
        let reads = 0;
        Object.defineProperty(f.identity, 'uin', {
            configurable: true,
            get() {
                reads++;
                closing ??= f.bridge.dispose();
                return A;
            },
        });

        try {
            expect(() => f.bridge.openDirectPushIngress(options)).toThrow();
            expect(reads).toBeGreaterThan(0);
            expect(closing).toBeDefined();
            expect(f.bridge.dispose()).toBe(closing);
        } finally {
            if (descriptor) {
                Object.defineProperty(f.identity, 'uin', descriptor);
            } else {
                Reflect.deleteProperty(f.identity, 'uin');
            }

            try {
                await bounded(closing ?? f.bridge.dispose());
                expect(() => f.bridge.openDirectPushIngress(options)).toThrow();
                expect(f.captured).toEqual([]);
                expectNoExternalActivity(f);
            } finally {
                vi.restoreAllMocks();
            }
        }
    });

    it('keeps a creation reservation during options getter reentry', async () => {
        const f = setup(A);
        let closing: Promise<void> | undefined;
        let nestedRejected = false;
        const reentrantOptions = {
            ...options,
            get sourceAuthenticationHandled(): true {
                try {
                    f.bridge.openDirectPushIngress(options);
                } catch {
                    nestedRejected = true;
                }

                closing = f.bridge.dispose();
                return true;
            },
        };

        try {
            expect(() => f.bridge.openDirectPushIngress(reentrantOptions)).toThrow(
                'Bridge is disposed',
            );
            expect(nestedRejected).toBe(true);
            expect(closing).toBeDefined();
            expect(f.bridge.dispose()).toBe(closing);
            await bounded(closing!);
            expectNoExternalActivity(f);
        } finally {
            try {
                await bounded(closing ?? f.bridge.dispose());
            } finally {
                vi.restoreAllMocks();
            }
        }
    });

    it('preserves the existing onPacket route alongside a claimed direct ingress', async () => {
        const f = setup(A);
        let ingress: DirectPushIngress | undefined;
        const parser = vi.fn((_packet: PacketInfo, _identity: IdentityService) => []);
        f.bridge.registerCmd('synthetic.legacy', parser);
        const packet = {
            pid: 1,
            uin: A,
            serviceCmd: 'synthetic.legacy',
            seqId: 7,
            retCode: 0,
            fromClient: false,
            body: new Uint8Array(),
        };

        try {
            await bounded(f.bridge.onPacket(packet));
            ingress = f.bridge.openDirectPushIngress(options);
            expect(ingress.activate()).toBe(true);
            await bounded(f.bridge.onPacket({ ...packet, seqId: 8 }));
            expect(parser).toHaveBeenCalledTimes(2);
            expect(parser.mock.calls.map(([pkt]) => pkt.seqId)).toEqual([7, 8]);
            expect(await bounded(ingress.submit(friend('direct'), meta(A, 9)))).toEqual({
                kind: 'settled',
                events: 1,
            });
            expect(f.captured).toMatchObject([{ kind: 'friend_message', selfUin: Number(A) }]);
            expectNoExternalActivity(f);
        } finally {
            try {
                await cleanup(f.bridge, ingress);
            } finally {
                vi.restoreAllMocks();
            }
        }
    });
});
