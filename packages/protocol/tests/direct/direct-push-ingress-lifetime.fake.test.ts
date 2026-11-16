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

// Only synthetic protobuf and in-memory dependencies; no transport or account.
const UIN = '2000000001';
const COMMAND = 'trpc.msg.olpush.OlPushService.MsgPush';
type Meta = Parameters<ReturnType<typeof createDirectPushIngress>['submit']>[1];

function meta(sequence = 1): Meta {
    return { uin: UIN, sequence, command: COMMAND, retCode: 0 };
}

function encode(message: PushMsgBody): Uint8Array {
    return protobuf_encode<PushMsg>({ message });
}

function join(): Uint8Array {
    return encode({
        responseHead: { fromUin: 700, fromUid: '' },
        contentHead: { msgType: 33, subType: 0, sequence: 800, timestamp: 1700000000, msgId: 555 },
        body: {
            msgContent: protobuf_encode<GroupChange>({
                groupUin: 700,
                memberUid: 'synthetic_member',
                operatorBytes: new TextEncoder().encode('synthetic_operator'),
            }),
        },
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

function setup(initialization?: Promise<void>) {
    const identity = IdentityService.memory(UIN);

    if (initialization) {
        // The factory captures this promise, so install the gate before construction.
        Object.defineProperty(identity, 'initialization', {
            value: initialization,
            configurable: true,
        });
    }

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
    // The factory also captures this method; attach the spy first.
    const dispatch = vi.spyOn(pipeline, 'processDecodedDirectEvents');
    const ingress = createDirectPushIngress({
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
    return { identity, captured, dispatch, ingress };
}

describe('direct push ingress synthetic parser lifetime', () => {
    it('finishes synchronous parsing after stop without entering the pipeline', async () => {
        const f = setup();
        let stoppedDuringFirstLookup = false;
        const lookup = vi.spyOn(f.identity, 'findUinByUid').mockImplementation((uid) => {
            if (uid === 'synthetic_member') {
                f.ingress.stop();
                stoppedDuringFirstLookup = true;
                return 12345;
            }

            expect(stoppedDuringFirstLookup).toBe(true);
            return 23456;
        });

        try {
            expect(await f.ingress.submit(join(), meta())).toMatchObject({
                kind: 'rejected',
                reason: 'not-active',
            });
            expect(f.ingress.activate()).toBe(true);
            expect(await bounded(f.ingress.submit(join(), meta()))).toMatchObject({
                kind: 'rejected',
                reason: 'stopped',
            });
            // stop cannot interrupt this synchronous decoder: both lookups occurred.
            expect(lookup.mock.calls).toEqual([
                ['synthetic_member', 700],
                ['synthetic_operator', 700],
            ]);
            expect(f.dispatch).not.toHaveBeenCalled();
            expect(f.captured).toEqual([]);
            await bounded(f.ingress.drain());
        } finally {
            f.ingress.stop();
            await bounded(f.ingress.drain());
            lookup.mockRestore();
            f.dispatch.mockRestore();
            await bounded(f.identity.close());
        }
    });

    it('settles queued work on stop but drain waits for held initialization', async () => {
        const init = deferred<void>();
        const f = setup(init.promise);
        const lookup = vi.spyOn(f.identity, 'findUinByUid');
        expect(f.ingress.activate()).toBe(true);

        try {
            const first = f.ingress.submit(join(), meta(1));
            // start() schedules the worker in a microtask; it then awaits the held promise.
            await Promise.resolve();
            const queued = f.ingress.submit(join(), meta(2));
            let firstSettled = false;
            void first.then(() => {
                firstSettled = true;
            });
            f.ingress.stop();
            expect(await bounded(queued)).toMatchObject({ kind: 'rejected', reason: 'stopped' });
            let drained = false;
            const sharedDrain = f.ingress.drain();
            expect(f.ingress.drain()).toBe(sharedDrain);
            const drain = sharedDrain.then(() => {
                drained = true;
            });
            await Promise.resolve();
            await Promise.resolve();
            expect(firstSettled).toBe(false);
            expect(drained).toBe(false);
            expect(lookup).not.toHaveBeenCalled();
            expect(f.dispatch).not.toHaveBeenCalled();
            init.resolve();
            expect(await bounded(first)).toMatchObject({ kind: 'rejected', reason: 'stopped' });
            await bounded(drain);
            expect(lookup).not.toHaveBeenCalled();
            expect(f.dispatch).not.toHaveBeenCalled();
            expect(f.captured).toEqual([]);
        } finally {
            init.resolve();
            f.ingress.stop();
            await bounded(f.ingress.drain());
            lookup.mockRestore();
            f.dispatch.mockRestore();
            await bounded(f.identity.close());
        }
    });

    it.each(['function', 'throwing getter'] as const)(
        'reports clone failure for a %s returned by a misbehaving identity',
        async (kind) => {
            const f = setup();
            let getterCalls = 0;
            const invalid =
                kind === 'function'
                    ? () => 1
                    : Object.defineProperty({}, 'value', {
                          enumerable: true,
                          get() {
                              getterCalls++;
                              throw new Error('synthetic clone getter');
                          },
                      });
            // Deliberately violates the identity return type; this is not a wire claim.
            const lookup = vi
                .spyOn(f.identity, 'findUinByUid')
                .mockImplementation((uid) =>
                    uid === 'synthetic_member' ? (invalid as unknown as number) : 23456,
                );
            expect(f.ingress.activate()).toBe(true);

            try {
                expect(await bounded(f.ingress.submit(join(), meta()))).toMatchObject({
                    kind: 'failed',
                    reason: 'clone',
                });
                expect(lookup.mock.calls).toEqual([
                    ['synthetic_member', 700],
                    ['synthetic_operator', 700],
                ]);

                if (kind === 'throwing getter') {
                    expect(getterCalls).toBe(1);
                }

                expect(f.dispatch).not.toHaveBeenCalled();
                expect(f.captured).toEqual([]);
            } finally {
                f.ingress.stop();
                await bounded(f.ingress.drain());
                lookup.mockRestore();
                f.dispatch.mockRestore();
                await bounded(f.identity.close());
            }
        },
    );
});
