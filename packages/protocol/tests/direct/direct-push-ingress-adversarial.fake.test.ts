import type { PushMsg, PushMsgBody } from '@snowluma/proto-defs/message';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';

import { createDirectPushIngress } from '../../src/direct/direct-push-ingress';
import { BridgeEventBus } from '../../src/event-bus';
import type { QQEventVariant } from '../../src/events';
import { GroupInviteTracker } from '../../src/group-invite-tracker';
import { IdentityService } from '../../src/identity-service';
import { IncomingPacketPipeline } from '../../src/packet-pipeline';

// All identities, payloads, and dependencies are synthetic and memory-only.
const UIN = '2000000001';
const COMMAND = 'trpc.msg.olpush.OlPushService.MsgPush';

function meta(sequence = 1) {
    return { uin: UIN, sequence, command: COMMAND, retCode: 0 };
}

function encode(message: PushMsgBody): Uint8Array {
    return protobuf_encode<PushMsg>({ message });
}

function friend(): Uint8Array {
    return encode({
        responseHead: { fromUin: 10001, fromUid: 'synthetic_peer' },
        contentHead: {
            msgType: 166,
            sequence: 32743,
            ntMsgSeq: 63214,
            timestamp: 1700000000,
            msgId: 1,
        },
        body: { richText: { elems: [{ text: { str: 'synthetic' } }] } },
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => {
        resolve = yes;
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

function setup() {
    const identity = IdentityService.memory(UIN);
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
    const create = () =>
        createDirectPushIngress({
            uin: UIN,
            identity,
            pipeline,
            pipelineIdentityBound: true,
            sourceAuthenticationHandled: true,
            maxBodyBytes: 65536,
            maxPendingBytes: 262144,
            maxPending: 8,
            maxEventsPerPush: 16,
        });
    return { identity, pipeline, captured, create };
}

describe('direct push ingress adversarial synthetic lifetimes', () => {
    it('reports only pipeline settlement when the real pipeline swallows a side-effect error', async () => {
        const f = setup();
        await f.identity.close();
        const observation = vi.spyOn(f.identity, 'rememberRequestIdentity');
        const dispatch = vi.spyOn(f.pipeline, 'processDecodedDirectEvents');
        const ingress = f.create();
        ingress.activate();

        try {
            expect(await bounded(ingress.submit(friend(), meta()))).toEqual({
                kind: 'settled',
                events: 1,
            });
            expect(observation).toHaveBeenCalledTimes(1);
            expect(observation.mock.results[0].type).toBe('throw');
            expect(dispatch).toHaveBeenCalledTimes(1);
            expect(f.captured).toEqual([]);
        } finally {
            ingress.stop();
            await bounded(ingress.drain());
            await f.identity.close();
        }
    });

    it('requires a pipeline dependency not to await another submission to the same FIFO', async () => {
        const f = setup();
        const entered = deferred<void>();
        let nested: Promise<unknown> | undefined;
        let completed = false;
        let ingress: ReturnType<typeof f.create>;
        vi.spyOn(f.pipeline, 'processDecodedDirectEvents').mockImplementation(async () => {
            nested = ingress.submit(friend(), meta(2));
            entered.resolve();
            await nested;
            completed = true;
        });
        ingress = f.create();
        ingress.activate();

        try {
            const first = ingress.submit(friend(), meta(1));
            await bounded(entered.promise);
            await Promise.resolve();
            expect(completed).toBe(false);
            // Stopping rejects the queued nested item, breaking this synthetic cycle.
            ingress.stop();
            expect(await bounded(nested!)).toMatchObject({ kind: 'rejected', reason: 'stopped' });
            expect(await bounded(first)).toEqual({ kind: 'settled', events: 1 });
            await bounded(ingress.drain());
            expect(completed).toBe(true);
        } finally {
            ingress.stop();
            await bounded(ingress.drain());
            await f.identity.close();
        }
    });

    it('settles a pre-registered submit reaction before drain and stops every queued receipt', async () => {
        const f = setup();
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
        const ingress = f.create();
        ingress.activate();
        const reactions: string[] = [];

        try {
            const first = ingress.submit(friend(), meta(1));
            const firstReaction = first.then(() => {
                reactions.push('submit');
            });
            await bounded(entered.promise);
            const queued = [ingress.submit(friend(), meta(2)), ingress.submit(friend(), meta(3))];
            ingress.stop();
            const drainReaction = ingress.drain().then(() => {
                reactions.push('drain');
            });
            expect(await bounded(Promise.all(queued))).toEqual([
                { kind: 'rejected', reason: 'stopped' },
                { kind: 'rejected', reason: 'stopped' },
            ]);
            expect(reactions).toEqual([]);
            gate.resolve();
            expect(await bounded(first)).toEqual({ kind: 'settled', events: 1 });
            await bounded(Promise.all([firstReaction, drainReaction]));
            expect(reactions).toEqual(['submit', 'drain']);
            expect(dispatch).toHaveBeenCalledTimes(1);
            expect(f.captured).toHaveLength(1);
        } finally {
            gate.resolve();
            ingress.stop();
            await bounded(ingress.drain());
            await f.identity.close();
        }
    });
});
