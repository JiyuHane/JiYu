import type { PushMsg, PushMsgBody } from '@snowluma/proto-defs/message';
import type { GroupChange } from '@snowluma/proto-defs/notify';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';

import {
    createDirectPushIngress,
    createGuardedDirectPushIngress,
    type DirectPushIngress,
} from '../../src/direct/direct-push-ingress';
import { BridgeEventBus } from '../../src/event-bus';
import type { QQEventVariant } from '../../src/events';
import { GroupInviteTracker } from '../../src/group-invite-tracker';
import { IdentityService } from '../../src/identity-service';
import { IncomingPacketPipeline } from '../../src/packet-pipeline';

// Synthetic protobuf and memory-only dependencies. Run this file in a single process:
// the admission-wipe test briefly instruments an intrinsic before a dynamic import.
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
        body: { richText: { elems: [{ text: { str: 'synthetic guard' } }] } },
    });
}

function join(): Uint8Array {
    return encode({
        responseHead: { fromUin: 700, fromUid: '' },
        contentHead: { msgType: 33, subType: 0, sequence: 800, timestamp: 1700000000, msgId: 555 },
        body: {
            msgContent: protobuf_encode<GroupChange>({
                groupUin: 700,
                memberUid: 'synthetic_member',
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
    const dispatch = vi.spyOn(pipeline, 'processDecodedDirectEvents');
    const options = {
        uin: UIN,
        identity,
        pipeline,
        pipelineIdentityBound: true as const,
        sourceAuthenticationHandled: true as const,
        maxBodyBytes: 65536,
        maxPendingBytes: 262144,
        maxPending: 8,
        maxEventsPerPush: 16,
    };
    return { identity, pipeline, captured, dispatch, options };
}

async function finish(ingress: DirectPushIngress, identity: IdentityService) {
    ingress.stop();
    await bounded(ingress.drain());
    await bounded(identity.close());
}

describe.sequential('guarded direct ingress, synthetic dependencies', () => {
    it('preserves the legacy factory without a guard', async () => {
        const f = setup();
        const ingress = createDirectPushIngress(f.options);

        try {
            expect(await ingress.submit(friend(), meta())).toEqual({
                kind: 'rejected',
                reason: 'not-active',
            });
            expect(ingress.activate()).toBe(true);
            expect(await bounded(ingress.submit(friend(), meta()))).toEqual({
                kind: 'settled',
                events: 1,
            });
            expect(f.dispatch).toHaveBeenCalledTimes(1);
            expect(f.captured).toHaveLength(1);
        } finally {
            await finish(ingress, f.identity);
        }
    });

    it('rejects non-function guards and does not call the guard for disabled submit', async () => {
        const f = setup();
        expect(() =>
            createGuardedDirectPushIngress(f.options, null as unknown as () => boolean),
        ).toThrow(TypeError);
        const guard = vi.fn(() => true);
        const ingress = createGuardedDirectPushIngress(f.options, guard);

        try {
            expect(await ingress.submit(new Uint8Array([1]), meta())).toEqual({
                kind: 'rejected',
                reason: 'not-active',
            });
            expect(guard).not.toHaveBeenCalled();
            expect(ingress.activate()).toBe(true);
            expect(guard).toHaveBeenCalled();
        } finally {
            await finish(ingress, f.identity);
        }
    });

    it('calls the guard synchronously with undefined receiver and no arguments', async () => {
        const f = setup();
        const calls: Array<{ receiver: unknown; args: unknown[] }> = [];

        const guard = function (this: unknown, ...args: unknown[]) {
            calls.push({ receiver: this, args });
            return true;
        };

        const ingress = createGuardedDirectPushIngress(f.options, guard);

        try {
            expect(ingress.activate()).toBe(true);
            expect(calls.length).toBeGreaterThan(0);
            expect(await bounded(ingress.submit(friend(), meta()))).toEqual({
                kind: 'settled',
                events: 1,
            });
            expect(f.dispatch).toHaveBeenCalledTimes(1);
            expect(calls.length).toBeGreaterThan(1);
            expect(
                calls.every(({ receiver, args }) => receiver === undefined && args.length === 0),
            ).toBe(true);
        } finally {
            await finish(ingress, f.identity);
        }
    });

    it.each([
        ['false', () => false],
        ['truthy number', () => 1],
        ['truthy object', () => ({})],
        [
            'throw',
            () => {
                throw new Error('synthetic guard failure');
            },
        ],
        ['fulfilled promise', () => Promise.resolve(true)],
        ['rejected promise', () => Promise.reject(new Error('synthetic rejected guard'))],
    ])('strictly rejects %s during activation and stops synchronously', async (_label, guard) => {
        const f = setup();
        const ingress = createGuardedDirectPushIngress(f.options, guard as () => boolean);

        try {
            expect(ingress.activate()).toBe(false);
            expect(ingress.activate()).toBe(false);
            expect(await bounded(ingress.submit(new Uint8Array([1]), meta()))).toEqual({
                kind: 'rejected',
                reason: 'stopped',
            });
            await bounded(ingress.drain());
            expect(f.dispatch).not.toHaveBeenCalled();
            // Let a rejected native Promise report itself if it was not observed.
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        } finally {
            await finish(ingress, f.identity);
        }
    });

    it('does not inspect or assimilate a guard return thenable', async () => {
        const f = setup();
        let reads = 0;
        const thenable = Object.defineProperty({}, 'then', {
            get() {
                reads++;
                throw new Error('then getter must not run');
            },
        });
        const ingress = createGuardedDirectPushIngress(
            f.options,
            (() => thenable) as unknown as () => boolean,
        );

        try {
            expect(ingress.activate()).toBe(false);
            expect(reads).toBe(0);
            expect(await ingress.submit(new Uint8Array([1]), meta())).toEqual({
                kind: 'rejected',
                reason: 'stopped',
            });
            await bounded(ingress.drain());
        } finally {
            await finish(ingress, f.identity);
        }
    });

    it('stops if the guard itself stops during activation or admission', async () => {
        for (const during of ['activation', 'admission'] as const) {
            const f = setup();
            let ingress!: DirectPushIngress;
            let stopNow = during === 'activation';
            ingress = createGuardedDirectPushIngress(f.options, () => {
                if (stopNow) {
                    ingress.stop();
                }

                return true;
            });

            try {
                expect(ingress.activate()).toBe(during !== 'activation');
                stopNow = true;
                expect(await bounded(ingress.submit(friend(), meta()))).toEqual({
                    kind: 'rejected',
                    reason: 'stopped',
                });
                expect(f.dispatch).not.toHaveBeenCalled();
                await bounded(ingress.drain());
            } finally {
                await finish(ingress, f.identity);
            }
        }
    });

    it('fences synchronous guard reentry instead of admitting nested work', async () => {
        const f = setup();
        let reenter = false;
        let ingress!: DirectPushIngress;
        let nested: Promise<unknown> | undefined;
        ingress = createGuardedDirectPushIngress(f.options, () => {
            if (reenter) {
                reenter = false;
                nested = ingress.submit(friend(), meta(2));
            }

            return true;
        });
        expect(ingress.activate()).toBe(true);

        try {
            reenter = true;
            const outer = ingress.submit(friend(), meta(1));
            expect(nested).toBeDefined();
            expect(await bounded(nested!)).toEqual({ kind: 'rejected', reason: 'stopped' });
            expect(await bounded(outer)).toEqual({ kind: 'rejected', reason: 'stopped' });
            expect(f.dispatch).not.toHaveBeenCalled();
            await bounded(ingress.drain());
        } finally {
            await finish(ingress, f.identity);
        }
    });

    it('rechecks after held initialization and keeps queued work out of the pipeline', async () => {
        const init = deferred<void>();
        const f = setup(init.promise);
        let valid = true;
        const ingress = createGuardedDirectPushIngress(f.options, () => valid);
        const parseObservation = vi.spyOn(f.identity, 'findFriend');
        expect(ingress.activate()).toBe(true);

        try {
            const first = ingress.submit(friend(), meta(1));
            await Promise.resolve();
            const queued = ingress.submit(friend(), meta(2));
            valid = false;
            init.resolve();
            expect(await bounded(Promise.all([first, queued]))).toEqual([
                { kind: 'rejected', reason: 'stopped' },
                { kind: 'rejected', reason: 'stopped' },
            ]);
            expect(parseObservation).not.toHaveBeenCalled();
            expect(f.dispatch).not.toHaveBeenCalled();
            expect(f.captured).toEqual([]);
            await bounded(ingress.drain());
        } finally {
            init.resolve();
            await finish(ingress, f.identity);
        }
    });

    it.each(['expire', 'stop'] as const)(
        'checks state after identity getter during admission: %s',
        async (action) => {
            const f = setup();
            let valid = true;
            let duringSubmit = false;
            let ingress!: DirectPushIngress;
            vi.spyOn(f.identity, 'uin', 'get').mockImplementation(() => {
                if (duringSubmit) {
                    if (action === 'expire') {
                        valid = false;
                    } else {
                        ingress.stop();
                    }
                }

                return UIN;
            });
            ingress = createGuardedDirectPushIngress(f.options, () => valid);
            expect(ingress.activate()).toBe(true);

            try {
                duringSubmit = true;
                const result = ingress.submit(friend(), meta());
                duringSubmit = false;
                expect(await bounded(result)).toEqual({ kind: 'rejected', reason: 'stopped' });
                expect(f.dispatch).not.toHaveBeenCalled();
                expect(f.captured).toEqual([]);
                await bounded(ingress.drain());
            } finally {
                await finish(ingress, f.identity);
            }
        },
    );

    it.each(['returned', 'thrown'] as const)(
        'observes a rejected native Promise %s by the identity getter without assimilation',
        async (kind) => {
            const f = setup();
            const ingress = createGuardedDirectPushIngress(f.options, () => true);
            expect(ingress.activate()).toBe(true);
            let thenReads = 0;
            const promise = Promise.reject(new Error('synthetic identity rejection'));
            Object.defineProperty(promise, 'then', {
                get() {
                    thenReads++;
                    throw new Error('own then getter must not run');
                },
            });
            // Vitest's mock wrapper reads returned Promise.then itself; use a native getter
            // to observe only the ingress handling of this intentionally hostile property.
            const original = Object.getOwnPropertyDescriptor(f.identity, 'uin');
            Object.defineProperty(f.identity, 'uin', {
                configurable: true,
                get() {
                    if (kind === 'thrown') {
                        throw promise;
                    }

                    return promise;
                },
            });

            try {
                expect(await bounded(ingress.submit(friend(), meta()))).toEqual({
                    kind: 'rejected',
                    reason: 'identity-changed',
                });
                expect(thenReads).toBe(0);
                expect(f.dispatch).not.toHaveBeenCalled();
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
            } finally {
                if (original) {
                    Object.defineProperty(f.identity, 'uin', original);
                } else {
                    Reflect.deleteProperty(f.identity, 'uin');
                }

                await finish(ingress, f.identity);
            }
        },
    );

    it('expires after a parser callback without claiming parser side effects were rolled back', async () => {
        const f = setup();
        let valid = true;
        const lookup = vi.spyOn(f.identity, 'findUinByUid').mockImplementation(() => {
            valid = false;
            return 12345;
        });
        const ingress = createGuardedDirectPushIngress(f.options, () => valid);
        expect(ingress.activate()).toBe(true);

        try {
            expect(await bounded(ingress.submit(join(), meta()))).toEqual({
                kind: 'rejected',
                reason: 'stopped',
            });
            expect(lookup).toHaveBeenCalled();
            expect(f.dispatch).not.toHaveBeenCalled();
            await bounded(ingress.drain());
        } finally {
            await finish(ingress, f.identity);
        }
    });

    it('rechecks a late identity getter immediately before pipeline entry', async () => {
        const f = setup();
        let valid = true;
        let parserLookupCompleted = false;
        let lateReads = 0;
        const findFriend = f.identity.findFriend.bind(f.identity);
        vi.spyOn(f.identity, 'findFriend').mockImplementation((uin) => {
            const result = findFriend(uin);
            parserLookupCompleted = true;
            return result;
        });
        const ingress = createGuardedDirectPushIngress(f.options, () => valid);
        vi.spyOn(f.identity, 'uin', 'get').mockImplementation(() => {
            if (parserLookupCompleted) {
                lateReads++;
                valid = false;
            }

            return UIN;
        });
        expect(ingress.activate()).toBe(true);

        try {
            expect(await bounded(ingress.submit(friend(), meta()))).toEqual({
                kind: 'rejected',
                reason: 'stopped',
            });
            expect(lateReads).toBe(1);
            expect(f.dispatch).not.toHaveBeenCalled();
            await bounded(ingress.drain());
        } finally {
            await finish(ingress, f.identity);
        }
    });

    it('expires after a structured-clone getter before pipeline entry', async () => {
        const f = setup();
        let valid = true;
        let getterCalls = 0;
        const value = Object.defineProperty({}, 'synthetic', {
            enumerable: true,
            get() {
                getterCalls++;
                valid = false;
                return 12345;
            },
        });
        vi.spyOn(f.identity, 'findUinByUid').mockReturnValue(value as unknown as number);
        const ingress = createGuardedDirectPushIngress(f.options, () => valid);
        expect(ingress.activate()).toBe(true);

        try {
            expect(await bounded(ingress.submit(join(), meta()))).toEqual({
                kind: 'rejected',
                reason: 'stopped',
            });
            expect(getterCalls).toBeGreaterThan(0);
            expect(f.dispatch).not.toHaveBeenCalled();
            await bounded(ingress.drain());
        } finally {
            await finish(ingress, f.identity);
        }
    });

    it('stops after an entered pipeline settles with an expired guard without rolling back effects', async () => {
        const f = setup();
        const entered = deferred<void>();
        const gate = deferred<void>();
        const effects: number[] = [];
        f.dispatch.mockImplementation(async (trace) => {
            effects.push(trace.seqId);
            entered.resolve();
            await gate.promise;
        });
        let valid = true;
        const ingress = createGuardedDirectPushIngress(f.options, () => valid);
        expect(ingress.activate()).toBe(true);

        try {
            const work = ingress.submit(friend(), meta(1));
            await bounded(entered.promise);
            const queued = ingress.submit(friend(), meta(2));
            valid = false;
            gate.resolve();
            expect(await bounded(work)).toEqual({ kind: 'rejected', reason: 'stopped' });
            expect(await bounded(queued)).toEqual({ kind: 'rejected', reason: 'stopped' });
            expect(f.dispatch).toHaveBeenCalledTimes(1);
            expect(effects).toEqual([1]);
            await bounded(ingress.drain());
        } finally {
            gate.resolve();
            await finish(ingress, f.identity);
        }
    });

    it('wipes the private admitting copy synchronously inside the identity getter on stop', async () => {
        const source = new Uint8Array([91, 3, 57, 99, 11, 231, 8, 71, 42, 120, 2]);
        const original = Uint8Array.prototype.set;
        let copy: Uint8Array | undefined;
        let observedInGetter = false;
        let ingress!: DirectPushIngress;
        const f = setup();
        let insideSubmit = false;
        vi.resetModules();

        try {
            Uint8Array.prototype.set = function (this: Uint8Array, input, offset) {
                Reflect.apply(original, this, [input, offset]);

                if (
                    input instanceof Uint8Array &&
                    input.length === source.length &&
                    this.length === source.length &&
                    input.every((byte, index) => byte === source[index])
                ) {
                    copy = this;
                }
            };

            let factory: typeof createGuardedDirectPushIngress;

            try {
                ({ createGuardedDirectPushIngress: factory } =
                    await import('../../src/direct/direct-push-ingress'));
            } finally {
                Uint8Array.prototype.set = original;
            }

            vi.spyOn(f.identity, 'uin', 'get').mockImplementation(() => {
                if (insideSubmit) {
                    expect(copy).toBeDefined();
                    ingress.stop();
                    expect(Array.from(copy!)).toEqual(Array(source.length).fill(0));
                    expect(Array.from(source)).toEqual([91, 3, 57, 99, 11, 231, 8, 71, 42, 120, 2]);
                    observedInGetter = true;
                }

                return UIN;
            });
            ingress = factory(f.options, () => true);
            expect(ingress.activate()).toBe(true);
            insideSubmit = true;
            const work = ingress.submit(source, meta());
            insideSubmit = false;
            expect(await bounded(work)).toEqual({ kind: 'rejected', reason: 'stopped' });
            expect(observedInGetter).toBe(true);
            expect(f.dispatch).not.toHaveBeenCalled();
            await bounded(ingress.drain());
        } finally {
            Uint8Array.prototype.set = original;
            vi.resetModules();

            if (ingress) {
                await finish(ingress, f.identity);
            } else {
                await bounded(f.identity.close());
            }
        }
    });
});
