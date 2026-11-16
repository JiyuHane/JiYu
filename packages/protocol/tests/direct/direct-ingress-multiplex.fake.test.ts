import type { PushMsg } from '@snowluma/proto-defs/message';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';

import {
    createDirectPushIngress,
    type DirectIngressResult,
} from '../../src/direct/direct-push-ingress';
import { createRawMultiplexClient } from '../../src/direct/raw-multiplex-client';
import { decodeServiceResponse } from '../../src/direct/service-frame';
import { BridgeEventBus } from '../../src/event-bus';
import type { QQEventVariant } from '../../src/events';
import { GroupInviteTracker } from '../../src/group-invite-tracker';
import { IdentityService } from '../../src/identity-service';
import { IncomingPacketPipeline } from '../../src/packet-pipeline';

// Test-only synthetic source and decryptor stand-in, not a service-layer wire format,
// peer authentication, online session or evidence of interoperability.
const COMMAND = 'trpc.msg.olpush.OlPushService.MsgPush';
const A = '2000000001';
const B = '2000000002';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
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
                timer = setTimeout(() => reject(new Error('synthetic multiplex watchdog')), 2000);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

const word = (n: number) => {
    const value = Buffer.alloc(4);
    value.writeUInt32BE(n >>> 0);
    return value;
};

function incoming(uin: string, sequence: number, text: string): Uint8Array {
    const account = Buffer.from(uin);
    const message = protobuf_encode<PushMsg>({
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
    // The fixture payload is marker + sequence + typed protobuf, not a real SSO body.
    const body = Buffer.concat([Buffer.of(2), word(sequence), message]);
    return Buffer.concat([
        word(14 + account.length + body.length),
        word(12),
        Buffer.of(0, 0),
        word(4 + account.length),
        account,
        body,
    ]);
}

function setup(uin: string, accept = true, holdPipeline = false) {
    const identity = IdentityService.memory(uin);
    const events = new BridgeEventBus();
    const captured: QQEventVariant[] = [];
    const subscriberEntered = deferred<void>();
    const subscriberGate = deferred<void>();
    const subscriberDone = deferred<void>();
    events.onAny((event) => {
        captured.push(event);
    });
    events.on('friend_message', async () => {
        subscriberEntered.resolve();
        await subscriberGate.promise;
        subscriberDone.resolve();
    });
    const pipeline = new IncomingPacketPipeline({
        identity,
        events,
        fetchGroupList: async () => {},
        fetchGroupMemberList: async () => {},
        resolveGroupJoinRequest: async () => null,
        groupInvites: new GroupInviteTracker(),
    });
    const entered = deferred<void>();
    const gate = deferred<void>();

    if (holdPipeline) {
        const original = pipeline.processDecodedDirectEvents.bind(pipeline);
        vi.spyOn(pipeline, 'processDecodedDirectEvents').mockImplementation(
            async (trace, decoded) => {
                entered.resolve();
                await gate.promise;
                await original(trace, decoded);
            },
        );
    }

    const ingress = createDirectPushIngress({
        uin,
        identity,
        pipeline,
        pipelineIdentityBound: true,
        sourceAuthenticationHandled: true,
        maxBodyBytes: 65536,
        maxPendingBytes: 262144,
        maxPending: 8,
        maxEventsPerPush: 16,
    });
    expect(ingress.activate()).toBe(true);
    const submit = vi.spyOn(ingress, 'submit');
    const receipts: DirectIngressResult[] = [];
    const received = deferred<void>();
    const writes: Uint8Array[] = [];
    const borrowed: Uint8Array[] = [];
    const extracted: Uint8Array[] = [];
    const verify = vi.fn(() => accept); // Caller policy stub, not actual authentication.
    const client = createRawMultiplexClient({
        uin,
        initialSequence: 17,
        maxFrameBytes: 65536,
        maxBufferedBytes: 262144,
        maxFrames: 8,
        maxPushFrames: 8,
        maxPushBytes: 65536,
        write: (frame) => {
            writes.push(Uint8Array.from(frame));
        },
        classify: (frame) => {
            const payload = decodeServiceResponse(frame).body;
            const data = Buffer.from(payload);
            const sequence = data.readUInt32BE(1);
            return data[0] === 2
                ? { kind: 'push', name: 'synthetic', id: sequence }
                : { kind: 'reject' };
        },
        verifyPush: verify,
        onPush: async (frame) => {
            borrowed.push(frame);
            const outer = decodeServiceResponse(frame);
            const payload = Buffer.from(outer.body);
            const sequence = payload.readUInt32BE(1);
            const body = outer.body.subarray(5);
            extracted.push(body);
            const work = ingress.submit(body, {
                uin: outer.uin,
                sequence,
                command: COMMAND,
                retCode: 0,
            });
            // submit owns its snapshot; erase this fake decryptor's source immediately.
            outer.body.fill(0);
            receipts.push(await work);
            received.resolve();
            // No result object may escape: the multiplex contract requires undefined.
            return undefined;
        },
    });
    return {
        client,
        ingress,
        submit,
        verify,
        captured,
        receipts,
        received,
        entered,
        gate,
        subscriberEntered,
        subscriberGate,
        subscriberDone,
        borrowed,
        extracted,
        writes,
    };
}

describe('synthetic raw multiplex to direct ingress, memory only', () => {
    it('isolates accounts and drains each ingress independently of the other and subscribers', async () => {
        const a = setup(A, true, true);
        const b = setup(B);
        const frameA = incoming(A, 41, 'only A');
        const frameB = incoming(B, 42, 'only B');

        try {
            // Feed owns a copy, including across a fragmented frame.
            a.client.feed(frameA.subarray(0, 3));
            a.client.feed(frameA.subarray(3));
            frameA.fill(0);
            await bounded(a.entered.promise);
            b.client.feed(frameB);
            frameB.fill(0);
            await bounded(b.received.promise);
            await bounded(b.subscriberEntered.promise);
            expect(b.receipts).toEqual([{ kind: 'settled', events: 1 }]);
            expect(b.captured).toMatchObject([
                {
                    kind: 'friend_message',
                    selfUin: Number(B),
                    senderUin: 10001,
                    elements: [{ type: 'text', text: 'only B' }],
                },
            ]);
            expect(a.captured).toEqual([]);
            expect(b.client.closed).toBe(false);

            a.client.close();
            a.ingress.stop();
            let aDrained = false;
            const drainA = a.ingress.drain().then(() => {
                aDrained = true;
            });
            b.client.close();
            b.ingress.stop();
            await bounded(b.ingress.drain());
            expect(aDrained).toBe(false);
            let bSubscriberSettled = false;
            void b.subscriberDone.promise.then(() => {
                bSubscriberSettled = true;
            });
            await Promise.resolve();
            expect(bSubscriberSettled).toBe(false);

            a.gate.resolve();
            await bounded(drainA);
            await bounded(a.received.promise);
            await bounded(a.subscriberEntered.promise);
            expect(a.receipts).toEqual([{ kind: 'settled', events: 1 }]);
            expect(a.captured).toMatchObject([
                {
                    kind: 'friend_message',
                    selfUin: Number(A),
                    senderUin: 10001,
                    elements: [{ type: 'text', text: 'only A' }],
                },
            ]);
            expect(b.captured).toHaveLength(1);
            await turn();
            expect(a.borrowed[0].every((byte) => byte === 0)).toBe(true);
            expect(b.borrowed[0].every((byte) => byte === 0)).toBe(true);
            expect(a.extracted[0].every((byte) => byte === 0)).toBe(true);
            expect(b.extracted[0].every((byte) => byte === 0)).toBe(true);
            expect(a.writes).toEqual([]);
            expect(b.writes).toEqual([]);
        } finally {
            a.gate.resolve();
            a.subscriberGate.resolve();
            b.subscriberGate.resolve();
            a.client.close();
            b.client.close();
            a.ingress.stop();
            b.ingress.stop();
            await bounded(Promise.all([a.ingress.drain(), b.ingress.drain()]));
        }

        await bounded(Promise.all([a.subscriberDone.promise, b.subscriberDone.promise]));
    });

    it('rejects a mismatched fixture UIN before dispatch to the other account', async () => {
        const a = setup(A);
        const b = setup(B);

        try {
            a.client.feed(incoming(B, 9, 'wrong account'));
            await bounded(a.received.promise);
            expect(a.receipts).toEqual([{ kind: 'rejected', reason: 'invalid' }]);
            expect(a.captured).toEqual([]);
            expect(b.captured).toEqual([]);
            expect(b.submit).not.toHaveBeenCalled();
            expect(a.client.closed).toBe(false);
        } finally {
            a.client.close();
            b.client.close();
            a.ingress.stop();
            b.ingress.stop();
            await bounded(Promise.all([a.ingress.drain(), b.ingress.drain()]));
        }
    });

    it('does not submit or dispatch when the caller verification stub returns false', async () => {
        const a = setup(A, false);

        try {
            a.client.feed(incoming(A, 10, 'unverified'));
            expect(await bounded(a.client.whenClosed)).toMatchObject({
                kind: 'protocol-error',
                code: 'push-rejected',
            });
            expect(a.verify).toHaveBeenCalledOnce();
            expect(a.submit).not.toHaveBeenCalled();
            expect(a.receipts).toEqual([]);
            expect(a.captured).toEqual([]);
        } finally {
            a.client.close();
            a.ingress.stop();
            await bounded(a.ingress.drain());
        }
    });
});
