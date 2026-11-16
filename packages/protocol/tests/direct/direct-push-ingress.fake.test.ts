import type { PushMsg, PushMsgBody } from '@snowluma/proto-defs/message';
import type { GroupChange } from '@snowluma/proto-defs/notify';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';

import { createDirectPushIngress } from '../../src/direct/direct-push-ingress';
import { BridgeEventBus } from '../../src/event-bus';
import type { QQEventVariant } from '../../src/events';
import { GroupInviteTracker } from '../../src/group-invite-tracker';
import { IdentityService } from '../../src/identity-service';
import { IncomingPacketPipeline } from '../../src/packet-pipeline';

// Synthetic in-memory inputs only: no account, network, or transport lifecycle.
const A = '2000000001';
const B = '2000000002';
const COMMAND = 'trpc.msg.olpush.OlPushService.MsgPush';

type Meta = Parameters<ReturnType<typeof createDirectPushIngress>['submit']>[1];

function meta(uin = A, sequence = 1): Meta {
    return { uin, sequence, command: COMMAND, retCode: 0 };
}

function encode(message: PushMsgBody): Uint8Array {
    return protobuf_encode<PushMsg>({ message });
}

function friend(text: string): Uint8Array {
    return encode({
        responseHead: { fromUin: 10001, fromUid: 'synthetic_peer' },
        contentHead: {
            msgType: 166,
            sequence: 32743,
            ntMsgSeq: 63214,
            timestamp: 1700000000,
            msgId: 1,
        },
        body: { richText: { elems: [{ text: { str: text } }] } },
    });
}

function group(text: string): Uint8Array {
    return encode({
        responseHead: { fromUin: 222, grp: { groupUin: 9999, memberName: 'Synthetic Bob' } },
        contentHead: { msgType: 82, sequence: 120, timestamp: 1700000120, msgId: 5120 },
        body: { richText: { elems: [{ text: { str: text } }] } },
    });
}

function join(): Uint8Array {
    return encode({
        responseHead: { fromUin: 700, fromUid: '' },
        contentHead: { msgType: 33, subType: 0, sequence: 800, timestamp: 1700000000, msgId: 555 },
        body: {
            msgContent: protobuf_encode<GroupChange>({ groupUin: 700, memberUid: 'u_joiner' }),
        },
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

// Every deliberately blocked operation has a finite watchdog, with gate release in finally.
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

function setup(
    uin = A,
    limits: {
        maxBodyBytes?: number;
        maxPendingBytes?: number;
        maxPending?: number;
        maxEventsPerPush?: number;
    } = {},
) {
    const identity = IdentityService.memory(uin);
    const events = new BridgeEventBus();
    const captured: QQEventVariant[] = [];
    events.onAny((event) => {
        captured.push(event);
    });
    const pipeline = new IncomingPacketPipeline({
        identity,
        events,
        fetchGroupList: async () => {},
        fetchGroupMemberList: async () => {},
        resolveGroupJoinRequest: async () => null,
        groupInvites: new GroupInviteTracker(),
    });
    let ingress: ReturnType<typeof createDirectPushIngress> | undefined;
    return {
        identity,
        events,
        captured,
        pipeline,
        // The factory binds both initialization and the pipeline method at construction.
        get ingress() {
            ingress ??= createDirectPushIngress({
                uin,
                identity,
                pipeline,
                pipelineIdentityBound: true,
                sourceAuthenticationHandled: true,
                maxBodyBytes: 65536,
                maxPendingBytes: 262144,
                maxPending: 8,
                maxEventsPerPush: 16,
                ...limits,
            });
            return ingress;
        },
    };
}

describe('direct push ingress with synthetic protobuf and memory-only dependencies', () => {
    it('requires explicit activation, snapshots input immediately, and dispatches decoded friend and group events', async () => {
        const f = setup();
        expect(await f.ingress.submit(friend('not active'), meta())).toMatchObject({
            kind: 'rejected',
            reason: 'not-active',
        });
        expect(f.captured).toEqual([]);
        expect(f.ingress.activate()).toBe(true);
        const data = friend('survives wipe');
        const work = f.ingress.submit(data, meta(A, 17));
        data.fill(0);
        expect(await bounded(work)).toMatchObject({ kind: 'settled', events: 1 });
        expect(f.captured).toMatchObject([
            {
                kind: 'friend_message',
                selfUin: Number(A),
                senderUin: 10001,
                elements: [{ type: 'text', text: 'survives wipe' }],
            },
        ]);
        expect(await bounded(f.ingress.submit(group('group payload'), meta(A, 18)))).toMatchObject({
            kind: 'settled',
            events: 1,
        });
        expect(f.captured[1]).toMatchObject({
            kind: 'group_message',
            selfUin: Number(A),
            groupId: 9999,
            elements: [{ type: 'text', text: 'group payload' }],
        });
        f.ingress.stop();
        await bounded(f.ingress.drain());
        expect(await f.ingress.submit(friend('stopped'), meta())).toMatchObject({
            kind: 'rejected',
            reason: 'stopped',
        });
        expect(f.ingress.activate()).toBe(false);
    });

    it('validates account, sequence, command, and return code before dispatch', async () => {
        const f = setup();
        const dispatch = vi.spyOn(f.pipeline, 'processDecodedDirectEvents');
        f.ingress.activate();

        for (const bad of [
            { ...meta(), uin: B },
            ...[-1, 4294967296, 1.5, NaN, Infinity].map((sequence) => ({ ...meta(), sequence })),
            { ...meta(), command: 'other' },
            { ...meta(), retCode: 1 },
        ]) {
            expect(await f.ingress.submit(friend('invalid'), bad)).toMatchObject({
                kind: 'rejected',
            });
        }

        expect(dispatch).not.toHaveBeenCalled();
        expect(f.captured).toEqual([]);

        for (const sequence of [0, 4294967295]) {
            expect(
                await bounded(f.ingress.submit(friend('boundary'), meta(A, sequence))),
            ).toMatchObject({ kind: 'settled', events: 1 });
        }

        f.ingress.stop();
        await bounded(f.ingress.drain());
    });

    it('rejects proxies, getters, unsupported storage, detached views and oversize input', async () => {
        const f = setup(A, { maxBodyBytes: 256 });
        f.ingress.activate();
        let traps = 0;
        const proxy = new Proxy(meta(), {
            get() {
                traps++;
                throw new Error('meta trap');
            },
            ownKeys() {
                traps++;
                throw new Error('meta trap');
            },
            getPrototypeOf() {
                traps++;
                throw new Error('meta trap');
            },
        });
        const getter = { ...meta() };
        Object.defineProperty(getter, 'sequence', {
            get() {
                traps++;
                throw new Error('getter');
            },
        });
        const bodyProxy = new Proxy(new Uint8Array([1]), {
            get() {
                traps++;
                throw new Error('view trap');
            },
        });
        const detached = new Uint8Array([1]);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        const shared = new Uint8Array(new SharedArrayBuffer(8));
        const resizable = new Uint8Array(new ArrayBuffer(8, { maxByteLength: 16 }));

        for (const [body, metadata] of [
            [friend('x'), proxy],
            [friend('x'), getter],
            [bodyProxy, meta()],
            [detached, meta()],
            [shared, meta()],
            [resizable, meta()],
            [new Uint8Array(257), meta()],
        ] as Array<[Uint8Array, Meta]>) {
            expect(await f.ingress.submit(body, metadata)).toMatchObject({
                kind: 'rejected',
                reason: 'invalid',
            });
        }

        expect(traps).toBe(0);
        expect(f.captured).toEqual([]);
        f.ingress.stop();
        await bounded(f.ingress.drain());
    });

    it('treats empty and unsupported pushes as empty and marks parser exceptions', async () => {
        const f = setup();
        const dispatch = vi.spyOn(f.pipeline, 'processDecodedDirectEvents');
        f.ingress.activate();
        expect(await bounded(f.ingress.submit(new Uint8Array(), meta()))).toMatchObject({
            kind: 'empty',
        });
        const unsupported = encode({ contentHead: { msgType: 65535, sequence: 1, msgId: 1 } });
        expect(await bounded(f.ingress.submit(unsupported, meta()))).toMatchObject({
            kind: 'empty',
        });
        expect(await bounded(f.ingress.submit(new Uint8Array([0x0a, 0x80]), meta()))).toMatchObject(
            { kind: 'failed', reason: 'parse' },
        );
        expect(dispatch).not.toHaveBeenCalled();
        expect(f.captured).toEqual([]);
        f.ingress.stop();
        await bounded(f.ingress.drain());
    });

    it('enforces capacity while the pipeline promise is pending', async () => {
        const f = setup(A, { maxPending: 1 });
        const entered = deferred<void>();
        const gate = deferred<void>();
        const original = f.pipeline.processDecodedDirectEvents.bind(f.pipeline);
        vi.spyOn(f.pipeline, 'processDecodedDirectEvents').mockImplementation(
            async (trace, events) => {
                entered.resolve();
                await gate.promise;
                await original(trace, events);
            },
        );
        f.ingress.activate();

        try {
            const first = f.ingress.submit(friend('first'), meta());
            await bounded(entered.promise);
            expect(await bounded(f.ingress.submit(friend('second'), meta()))).toMatchObject({
                kind: 'rejected',
                reason: 'capacity',
            });
            gate.resolve();
            expect(await bounded(first)).toMatchObject({ kind: 'settled', events: 1 });
        } finally {
            gate.resolve();
            f.ingress.stop();
            await bounded(f.ingress.drain());
        }
    });

    it('enforces the pending byte budget while a prior pipeline call is pending', async () => {
        const body = friend('byte budget');
        const f = setup(A, {
            maxBodyBytes: body.length,
            maxPendingBytes: body.length,
            maxPending: 3,
        });
        const entered = deferred<void>();
        const gate = deferred<void>();
        const original = f.pipeline.processDecodedDirectEvents.bind(f.pipeline);
        vi.spyOn(f.pipeline, 'processDecodedDirectEvents').mockImplementation(
            async (trace, events) => {
                entered.resolve();
                await gate.promise;
                await original(trace, events);
            },
        );
        f.ingress.activate();

        try {
            const first = f.ingress.submit(body, meta());
            await bounded(entered.promise);
            expect(await bounded(f.ingress.submit(body, meta(A, 2)))).toMatchObject({
                kind: 'rejected',
                reason: 'capacity',
            });
            gate.resolve();
            expect(await bounded(first)).toMatchObject({ kind: 'settled', events: 1 });
            expect(await bounded(f.ingress.submit(body, meta(A, 3)))).toMatchObject({
                kind: 'settled',
                events: 1,
            });
        } finally {
            gate.resolve();
            f.ingress.stop();
            await bounded(f.ingress.drain());
        }
    });

    it('runs one worker in FIFO order and snapshots queued bodies at submit', async () => {
        const f = setup(A, { maxPending: 4 });
        const entered = deferred<void>();
        const gate = deferred<void>();
        const original = f.pipeline.processDecodedDirectEvents.bind(f.pipeline);
        const calls: number[] = [];
        vi.spyOn(f.pipeline, 'processDecodedDirectEvents').mockImplementation(
            async (trace, events) => {
                calls.push(trace.seqId);

                if (trace.seqId === 1) {
                    entered.resolve();
                    await gate.promise;
                }

                await original(trace, events);
            },
        );
        f.ingress.activate();

        try {
            const first = f.ingress.submit(friend('one'), meta(A, 1));
            await bounded(entered.promise);
            const secondBody = friend('two');
            const second = f.ingress.submit(secondBody, meta(A, 2));
            secondBody.fill(0);
            const third = f.ingress.submit(group('three'), meta(A, 3));
            expect(calls).toEqual([1]);
            gate.resolve();
            expect(await bounded(Promise.all([first, second, third]))).toMatchObject([
                { kind: 'settled', events: 1 },
                { kind: 'settled', events: 1 },
                { kind: 'settled', events: 1 },
            ]);
            expect(calls).toEqual([1, 2, 3]);
            expect(f.captured).toMatchObject([
                { elements: [{ text: 'one' }] },
                { elements: [{ text: 'two' }] },
                { elements: [{ text: 'three' }] },
            ]);
        } finally {
            gate.resolve();
            f.ingress.stop();
            await bounded(f.ingress.drain());
        }
    });

    it('stops queued work synchronously while allowing an entered pipeline to finish', async () => {
        const f = setup(A, { maxPending: 4 });
        const entered = deferred<void>();
        const gate = deferred<void>();
        const original = f.pipeline.processDecodedDirectEvents.bind(f.pipeline);
        const dispatch = vi
            .spyOn(f.pipeline, 'processDecodedDirectEvents')
            .mockImplementation(async (trace, events) => {
                entered.resolve();
                await gate.promise;
                await original(trace, events);
            });
        const findFriend = vi.spyOn(f.identity, 'findFriend');
        f.ingress.activate();

        try {
            const first = f.ingress.submit(friend('first'), meta());
            await bounded(entered.promise);
            const parsedBefore = findFriend.mock.calls.length;
            const queued = f.ingress.submit(friend('never parsed'), meta(A, 2));
            f.ingress.stop();
            expect(await bounded(queued)).toMatchObject({ kind: 'rejected', reason: 'stopped' });
            expect(await f.ingress.submit(friend('later'), meta())).toMatchObject({
                kind: 'rejected',
                reason: 'stopped',
            });
            let drained = false;
            const drain = f.ingress.drain().then(() => {
                drained = true;
            });
            await Promise.resolve();
            expect(drained).toBe(false);
            gate.resolve();
            expect(await bounded(first)).toMatchObject({ kind: 'settled', events: 1 });
            await bounded(drain);
            expect(findFriend).toHaveBeenCalledTimes(parsedBefore);
            expect(dispatch).toHaveBeenCalledTimes(1);
            expect(f.captured).toMatchObject([{ elements: [{ text: 'first' }] }]);
        } finally {
            gate.resolve();
            f.ingress.stop();
            await bounded(f.ingress.drain());
        }
    });

    it('reports pipeline and initialization failures separately', async () => {
        const pipelineFailure = setup();
        vi.spyOn(pipelineFailure.pipeline, 'processDecodedDirectEvents').mockRejectedValue(
            new Error('synthetic pipeline failure'),
        );
        pipelineFailure.ingress.activate();

        try {
            expect(
                await bounded(pipelineFailure.ingress.submit(friend('pipeline'), meta())),
            ).toMatchObject({ kind: 'failed', reason: 'pipeline' });
            expect(pipelineFailure.captured).toEqual([]);
        } finally {
            pipelineFailure.ingress.stop();
            await bounded(pipelineFailure.ingress.drain());
        }

        const initializationFailure = setup();
        const init = deferred<void>();
        Object.defineProperty(initializationFailure.identity, 'initialization', {
            value: init.promise,
            configurable: true,
        });
        const dispatch = vi.spyOn(initializationFailure.pipeline, 'processDecodedDirectEvents');
        initializationFailure.ingress.activate();

        try {
            const work = initializationFailure.ingress.submit(friend('initialization'), meta());
            init.reject(new Error('synthetic initialization failure'));
            expect(await bounded(work)).toMatchObject({ kind: 'failed', reason: 'initialization' });
            expect(dispatch).not.toHaveBeenCalled();
            expect(initializationFailure.captured).toEqual([]);
        } finally {
            initializationFailure.ingress.stop();
            await bounded(initializationFailure.ingress.drain());
        }
    });

    it('rechecks the account after initialization before parsing', async () => {
        const f = setup();
        const init = deferred<void>();
        Object.defineProperty(f.identity, 'initialization', {
            value: init.promise,
            configurable: true,
        });
        let current = A;
        vi.spyOn(f.identity, 'uin', 'get').mockImplementation(() => current);
        const parseObservation = vi.spyOn(f.identity, 'findFriend');
        const dispatch = vi.spyOn(f.pipeline, 'processDecodedDirectEvents');
        f.ingress.activate();

        try {
            const work = f.ingress.submit(friend('identity change'), meta());
            current = B;
            init.resolve();
            expect(await bounded(work)).toMatchObject({
                kind: 'rejected',
                reason: 'identity-changed',
            });
            expect(parseObservation).not.toHaveBeenCalled();
            expect(dispatch).not.toHaveBeenCalled();
            expect(f.captured).toEqual([]);
        } finally {
            init.resolve();
            f.ingress.stop();
            await bounded(f.ingress.drain());
        }
    });

    it('does not share identity state or system-message dedup across instances', async () => {
        const a = setup(A);
        const b = setup(B);
        a.identity.rememberRequestIdentity({ uid: 'u_joiner', uin: 23456 });
        b.identity.rememberRequestIdentity({ uid: 'u_joiner', uin: 34567 });
        a.ingress.activate();
        b.ingress.activate();

        try {
            expect(await bounded(a.ingress.submit(join(), meta(A)))).toMatchObject({
                kind: 'settled',
                events: 1,
            });
            expect(await bounded(b.ingress.submit(join(), meta(B)))).toMatchObject({
                kind: 'settled',
                events: 1,
            });
            expect(a.captured).toMatchObject([
                { kind: 'group_member_join', selfUin: Number(A), userUin: 23456 },
            ]);
            expect(b.captured).toMatchObject([
                { kind: 'group_member_join', selfUin: Number(B), userUin: 34567 },
            ]);
            expect(await bounded(a.ingress.submit(join(), meta(A)))).toMatchObject({
                kind: 'empty',
            });
            expect(await bounded(b.ingress.submit(join(), meta(B)))).toMatchObject({
                kind: 'empty',
            });
        } finally {
            a.ingress.stop();
            b.ingress.stop();
            await bounded(Promise.all([a.ingress.drain(), b.ingress.drain()]));
        }
    });

    it('drain excludes async bus subscribers, which retain their own lifetime', async () => {
        const f = setup();
        const entered = deferred<void>();
        const gate = deferred<void>();
        let settled = false;
        f.events.on('friend_message', async () => {
            entered.resolve();
            await gate.promise;
            settled = true;
        });
        f.ingress.activate();

        try {
            const work = f.ingress.submit(friend('subscriber'), meta());
            await bounded(entered.promise);
            expect(await bounded(work)).toMatchObject({ kind: 'settled', events: 1 });
            f.ingress.stop();
            await bounded(f.ingress.drain());
            expect(settled).toBe(false);
        } finally {
            gate.resolve();
            f.ingress.stop();
            await bounded(f.ingress.drain());
        }

        await bounded(gate.promise);
        await Promise.resolve();
        expect(settled).toBe(true);
    });

    it('waits for initialization even after stop and never starts queued work later', async () => {
        const f = setup(A, { maxPending: 3 });
        const init = deferred<void>();
        Object.defineProperty(f.identity, 'initialization', {
            value: init.promise,
            configurable: true,
        });
        const dispatch = vi.spyOn(f.pipeline, 'processDecodedDirectEvents');
        f.ingress.activate();

        try {
            const first = f.ingress.submit(friend('initializing'), meta());
            // Give the worker the opportunity to enter initialization.
            await Promise.resolve();
            const queued = f.ingress.submit(friend('queued'), meta(A, 2));
            f.ingress.stop();
            expect(await bounded(queued)).toMatchObject({ kind: 'rejected', reason: 'stopped' });
            let drained = false;
            const drain = f.ingress.drain().then(() => {
                drained = true;
            });
            await Promise.resolve();
            await Promise.resolve();
            expect(drained).toBe(false);
            init.resolve();
            expect(await bounded(first)).toMatchObject({ kind: 'rejected', reason: 'stopped' });
            await bounded(drain);
            expect(dispatch).not.toHaveBeenCalled();
            expect(f.captured).toEqual([]);
        } finally {
            init.resolve();
            f.ingress.stop();
            await bounded(f.ingress.drain());
        }
    });
});
