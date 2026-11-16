import type { DirectPushMeta } from '@snowluma/protocol/direct/direct-push-ingress';
import {
    createLinuxEasyAccountOwnerWithKeyCapability,
    type LinuxEasyAccountOwner,
} from '@snowluma/protocol/direct/linux-easy-account-owner';
import * as processorModule from '@snowluma/protocol/direct/linux-easy-push-processor';
import type { LinuxEasyPushProcessor } from '@snowluma/protocol/direct/linux-easy-push-processor';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { IncomingPacketPipeline } from '@snowluma/protocol/packet-pipeline';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Bridge } from '../src/bridge/bridge';

// All accounts, bytes and callbacks are synthetic. No owner session is started.
// The authentication flag and verifier are test inputs, not evidence about a peer.
const A = '4000000001';
const B = '4000000002';
const COMMAND = 'trpc.msg.olpush.OlPushService.MsgPush';
const ingress = {
    sourceAuthenticationHandled: true,
    maxBodyBytes: 65536,
    maxPendingBytes: 262144,
    maxPending: 8,
    maxEventsPerPush: 16,
} as const;
const queue = { maxFrameBytes: 65536, maxQueuedFrames: 8, maxQueuedBytes: 262144 };

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
                timer = setTimeout(() => reject(new Error('synthetic processor watchdog')), 2000);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

const cleanupItems: {
    bridge: Bridge;
    identity: IdentityService;
    owner: LinuxEasyAccountOwner;
    expectDisposalRejection: boolean;
}[] = [];

function setup(uin = A) {
    const identity = IdentityService.memory(uin);
    const bridge = new Bridge(identity);
    const owner = createLinuxEasyAccountOwnerWithKeyCapability();
    const events: QQEventVariant[] = [];
    bridge.events.onAny((event) => {
        events.push(event);
    });
    const verifyRaw = vi.fn((_frame: Uint8Array, _meta: Readonly<DirectPushMeta>) => true);
    const start = vi.spyOn(owner, 'start').mockImplementation(async () => {
        throw new Error('unexpected synthetic session start');
    });
    const ownerClose = vi.spyOn(owner, 'close');
    const close = vi.spyOn(identity, 'close');

    const unexpected = async (): Promise<never> => {
        throw new Error('unexpected synthetic external activity');
    };

    const external = [
        vi.spyOn(bridge, 'sendRawPacket').mockImplementation(unexpected),
        vi.spyOn(bridge.apis.contacts, 'fetchFriendList').mockImplementation(unexpected),
        vi.spyOn(bridge.apis.contacts, 'fetchGroupList').mockImplementation(unexpected),
        vi.spyOn(bridge.apis.contacts, 'fetchGroupMemberList').mockImplementation(unexpected),
        vi.spyOn(bridge.apis.contacts, 'fetchUserProfile').mockImplementation(unexpected),
        vi.spyOn(bridge.apis.contacts, 'fetchUserProfileByUid').mockImplementation(unexpected),
        vi.spyOn(bridge.apis.contacts, 'resolveGroupJoinRequest').mockImplementation(unexpected),
    ];
    const options = { owner, verifyRaw, queue: { ...queue }, ingress: { ...ingress } };
    const cleanup = { bridge, identity, owner, expectDisposalRejection: false };
    cleanupItems.push(cleanup);
    return {
        identity,
        bridge,
        owner,
        events,
        verifyRaw,
        start,
        ownerClose,
        close,
        external,
        options,
        expectDisposalRejection: () => {
            cleanup.expectDisposalRejection = true;
        },
    };
}

type Fixture = ReturnType<typeof setup>;

function expectNoExternalActivity(f: Fixture) {
    expect(f.bridge.empty).toBe(true);
    expect(f.bridge.activePid).toBeNull();
    expect(f.start).not.toHaveBeenCalled();

    for (const spy of f.external) {
        expect(spy).not.toHaveBeenCalled();
    }
}

function route(id: number) {
    return { kind: 'push' as const, name: COMMAND, id };
}

// Only lifecycle observation is replaced; the wrapped product is the real processor.
function interceptProcessor(onStatusRead?: () => void) {
    const create = processorModule.createLinuxEasyPushProcessor;
    const gate = deferred();
    const entered = deferred();
    let real: LinuxEasyPushProcessor | undefined;
    const stop = vi.fn(() => {
        real!.stop();
    });
    const drain = vi.fn(async () => {
        entered.resolve();
        await gate.promise;
        await real!.drain();
    });
    const factory = vi
        .spyOn(processorModule, 'createLinuxEasyPushProcessor')
        .mockImplementation((options) => {
            real = create(options);
            const processor = real;
            return {
                onPush: processor.onPush,
                activate: processor.activate,
                get status() {
                    onStatusRead?.();
                    return processor.status;
                },
                stop,
                drain,
            };
        });
    return { factory, stop, drain, gate, entered };
}

afterEach(async () => {
    const items = cleanupItems.splice(0);

    try {
        const results = await Promise.allSettled(
            items.map(async ({ bridge, identity, owner, expectDisposalRejection }) => {
                try {
                    // Convert rejection before the watchdog so a timeout is never mistaken
                    // for the specifically expected failed disposal.
                    const outcome = await bounded(
                        bridge.dispose().then(
                            () => ({ kind: 'resolved' as const }),
                            (error: unknown) => ({ kind: 'rejected' as const, error }),
                        ),
                    );

                    if (expectDisposalRejection) {
                        expect(outcome.kind).toBe('rejected');
                    } else if (outcome.kind === 'rejected') {
                        throw outcome.error;
                    }
                } finally {
                    // Failed Bridge disposal can exit before its normal contact cleanup.
                    if (expectDisposalRejection) {
                        bridge.apis.contacts.dispose();
                    }

                    // The caller still owns an owner when creation did not deliver a handle.
                    owner.close();
                    await bounded(identity.close());
                }

                expect(identity.persistenceStatus.state).toBe('closed');
            }),
        );

        for (const result of results) {
            if (result.status === 'rejected') {
                throw result.reason;
            }
        }
    } finally {
        vi.restoreAllMocks();
    }
});

describe('Bridge Linux Easy processor with memory-only synthetic inputs', () => {
    it('keeps an unstarted owner inactive and exposes only local status and lifecycle', async () => {
        const f = setup();
        const business = vi
            .spyOn(IncomingPacketPipeline.prototype, 'processDecodedDirectEvents')
            .mockImplementation(async () => {
                throw new Error('unexpected synthetic business processing');
            });
        const canary = 'synthetic-key-canary-not-a-real-key';
        Object.defineProperty(f.owner, 'syntheticKeyCanary', { value: canary });
        const factory = vi.spyOn(processorModule, 'createLinuxEasyPushProcessor');
        const processor = f.bridge.openLinuxEasyPushProcessor(f.options);
        const result = factory.mock.results[0];

        if (!result || result.type !== 'return') {
            throw new Error('synthetic processor factory did not return');
        }

        expect(factory).toHaveBeenCalledTimes(1);
        expect(Object.isFrozen(result.value)).toBe(true);

        for (const key of ['activate', 'drain', 'onPush', 'status', 'stop']) {
            const descriptor = Object.getOwnPropertyDescriptor(result.value, key);
            expect(
                descriptor && 'value' in descriptor && typeof descriptor.value === 'function',
            ).toBe(true);
        }

        expect(Object.isFrozen(processor)).toBe(true);
        expect(Reflect.ownKeys(processor).sort()).toEqual(
            ['activate', 'drain', 'onPush', 'status', 'stop'].sort(),
        );
        expect(processor.status()).toBe('buffering');
        expect(processor.activate()).toBe(false);
        processor.onPush(Uint8Array.of(1, 2, 3), route(1));
        expect(processor.activate()).toBe(false);
        expect(processor.status()).toBe('buffering');
        await Promise.resolve();
        expect(f.verifyRaw).not.toHaveBeenCalled();
        expect(business).not.toHaveBeenCalled();
        expect(f.events).toEqual([]);
        const stopResult = processor.stop();
        expect(stopResult).toBeUndefined();
        expect(processor.status()).toBe('stopped');
        expect(f.ownerClose).toHaveBeenCalledTimes(1);
        await bounded(processor.drain());
        expect(f.verifyRaw).not.toHaveBeenCalled();
        expect(business).not.toHaveBeenCalled();
        expect(f.events).toEqual([]);
        expect(JSON.stringify({ status: processor.status(), stopResult, processor })).not.toContain(
            canary,
        );
        expectNoExternalActivity(f);
    });

    it.each(['processor-first', 'ingress-first'] as const)(
        'shares one permanent claim with direct ingress: %s',
        async (order) => {
            const f = setup();
            const factory = vi.spyOn(processorModule, 'createLinuxEasyPushProcessor');

            if (order === 'processor-first') {
                const processor = f.bridge.openLinuxEasyPushProcessor(f.options);
                expect(() => f.bridge.openDirectPushIngress(ingress)).toThrow(
                    'Direct push ingress already claimed',
                );
                processor.stop();
                await bounded(processor.drain());
                expect(() => f.bridge.openDirectPushIngress(ingress)).toThrow(
                    'Direct push ingress already claimed',
                );
                expect(() => f.bridge.openLinuxEasyPushProcessor(f.options)).toThrow(
                    'Direct push ingress already claimed',
                );
                expect(factory).toHaveBeenCalledTimes(1);
            } else {
                const direct = f.bridge.openDirectPushIngress(ingress);
                expect(() => f.bridge.openLinuxEasyPushProcessor(f.options)).toThrow(
                    'Direct push ingress already claimed',
                );
                direct.stop();
                await bounded(direct.drain());
                expect(() => f.bridge.openLinuxEasyPushProcessor(f.options)).toThrow(
                    'Direct push ingress already claimed',
                );
                expect(factory).not.toHaveBeenCalled();
            }

            expect(f.events).toEqual([]);
            expectNoExternalActivity(f);
        },
    );

    it.each(['getter', 'factory'] as const)(
        'retains the shared claim after a synchronous %s failure',
        async (failure) => {
            const f = setup();
            const marker = new Error('synthetic construction failure');
            const factory = vi.spyOn(processorModule, 'createLinuxEasyPushProcessor');

            if (failure === 'factory') {
                factory.mockImplementationOnce(() => {
                    throw marker;
                });
            }

            const options =
                failure === 'getter'
                    ? {
                          ...f.options,
                          get owner(): LinuxEasyAccountOwner {
                              throw marker;
                          },
                      }
                    : f.options;
            expect(() => f.bridge.openLinuxEasyPushProcessor(options)).toThrow(marker);
            expect(factory).toHaveBeenCalledTimes(failure === 'getter' ? 0 : 1);
            expect(() => f.bridge.openLinuxEasyPushProcessor(f.options)).toThrow(
                'Direct push ingress already claimed',
            );
            expect(() => f.bridge.openDirectPushIngress(ingress)).toThrow(
                'Direct push ingress already claimed',
            );
            expect(f.ownerClose).not.toHaveBeenCalled();
            const closing = f.bridge.dispose();
            expect(f.bridge.dispose()).toBe(closing);
            await bounded(closing);
            expect(f.close).toHaveBeenCalledTimes(1);
            expect(f.identity.persistenceStatus.state).toBe('closed');
            expectNoExternalActivity(f);
        },
    );

    it('retains a stop-getter failure and rejects disposal when stop was never acquired', async () => {
        const f = setup();
        f.expectDisposalRejection();
        const marker = new Error('synthetic stop getter failure');
        const order: string[] = [];
        const state: { real?: LinuxEasyPushProcessor } = {};
        const create = processorModule.createLinuxEasyPushProcessor;
        const factory = vi
            .spyOn(processorModule, 'createLinuxEasyPushProcessor')
            .mockImplementation((options) => {
                const real = create(options);
                state.real = real;
                return {
                    onPush: real.onPush,
                    activate: real.activate,
                    status: real.status,
                    get stop(): LinuxEasyPushProcessor['stop'] {
                        order.push('stop');
                        throw marker;
                    },
                    get drain(): LinuxEasyPushProcessor['drain'] {
                        order.push('drain');
                        return real.drain;
                    },
                };
            });

        try {
            let failure: unknown;

            try {
                f.bridge.openLinuxEasyPushProcessor(f.options);
            } catch (error) {
                failure = error;
            }

            expect(factory).toHaveBeenCalledTimes(1);
            expect(failure).toBeInstanceOf(AggregateError);
            const errors: unknown[] = (failure as AggregateError).errors;
            expect(errors).toHaveLength(2);
            expect(errors[0]).toBe(marker);
            expect(errors[1]).toMatchObject({ message: 'Direct push processor stop unavailable' });
            expect(order[0]).toBe('stop');

            if (order.includes('drain')) {
                expect(order.indexOf('stop')).toBeLessThan(order.indexOf('drain'));
            }

            expect(() => f.bridge.openDirectPushIngress(ingress)).toThrow(
                'Direct push ingress already claimed',
            );
            await expect(bounded(f.bridge.dispose())).rejects.toThrow(
                'Direct push processor stop unavailable',
            );
            expect(f.ownerClose).not.toHaveBeenCalled();
            expectNoExternalActivity(f);
        } finally {
            // The synthetic getter hid stop from Bridge; clean up our retained real product.
            const real = state.real;

            if (real) {
                real.stop();
                await bounded(real.drain());
            }
        }
    });

    it('waits for a reentrant stop getter failure before rejecting disposal', async () => {
        const f = setup();
        f.expectDisposalRejection();
        const marker = new Error('synthetic reentrant stop getter failure');
        const state: { real?: LinuxEasyPushProcessor } = {};
        const create = processorModule.createLinuxEasyPushProcessor;
        const clear = vi.spyOn(f.bridge.events, 'clear');
        let closing: Promise<void> | undefined;
        let clearedInsideGetter = false;
        let closedInsideGetter = false;
        vi.spyOn(processorModule, 'createLinuxEasyPushProcessor').mockImplementation((options) => {
            const real = create(options);
            state.real = real;
            return {
                onPush: real.onPush,
                activate: real.activate,
                status: real.status,
                get stop(): LinuxEasyPushProcessor['stop'] {
                    closing = f.bridge.dispose();
                    void closing.catch(() => undefined);
                    clearedInsideGetter = clear.mock.calls.length > 0;
                    closedInsideGetter = f.close.mock.calls.length > 0;
                    throw marker;
                },
                drain: real.drain,
            };
        });

        try {
            let failure: unknown;

            try {
                f.bridge.openLinuxEasyPushProcessor(f.options);
            } catch (error) {
                failure = error;
            }

            expect(failure).toBeInstanceOf(AggregateError);
            const errors: unknown[] = (failure as AggregateError).errors;
            expect(errors).toHaveLength(2);
            expect(errors[0]).toBe(marker);
            expect(errors[1]).toMatchObject({ message: 'Direct push processor stop unavailable' });
            expect(closing).toBeDefined();
            expect(clearedInsideGetter).toBe(false);
            expect(closedInsideGetter).toBe(false);
            await expect(bounded(closing!)).rejects.toThrow(
                'Direct push processor stop unavailable',
            );
            expect(clear).toHaveBeenCalledTimes(1);
            expect(f.close).not.toHaveBeenCalled();
            expectNoExternalActivity(f);
        } finally {
            const real = state.real;

            if (real) {
                real.stop();
                await bounded(real.drain());
            }
        }
    });

    it('reads stop before drain, stops on a drain-getter error and rejects disposal', async () => {
        const f = setup();
        f.expectDisposalRejection();
        const marker = new Error('synthetic drain getter failure');
        const order: string[] = [];
        const state: { real?: LinuxEasyPushProcessor } = {};
        const create = processorModule.createLinuxEasyPushProcessor;
        const stop = vi.fn(() => state.real!.stop());
        vi.spyOn(processorModule, 'createLinuxEasyPushProcessor').mockImplementation((options) => {
            const real = create(options);
            state.real = real;
            return {
                onPush: real.onPush,
                activate: real.activate,
                status: real.status,
                get stop(): LinuxEasyPushProcessor['stop'] {
                    order.push('stop');
                    return stop;
                },
                get drain(): LinuxEasyPushProcessor['drain'] {
                    order.push('drain');
                    throw marker;
                },
            };
        });

        try {
            expect(() => f.bridge.openLinuxEasyPushProcessor(f.options)).toThrow(marker);
            expect(order).toEqual(['stop', 'drain']);
            expect(stop).toHaveBeenCalledTimes(1);
            expect(f.ownerClose).toHaveBeenCalledTimes(1);
            expect(() => f.bridge.openLinuxEasyPushProcessor(f.options)).toThrow(
                'Direct push ingress already claimed',
            );
            await expect(bounded(f.bridge.dispose())).rejects.toThrow(
                'Direct push processor drain unavailable',
            );
            expect(stop).toHaveBeenCalledTimes(2);
            expect(f.ownerClose).toHaveBeenCalledTimes(1);
            expectNoExternalActivity(f);
        } finally {
            const real = state.real;

            if (real) {
                real.stop();
                await bounded(real.drain());
            }
        }
    });

    it('waits for creation and drain when the stop getter reenters disposal', async () => {
        const f = setup();
        const order: string[] = [];
        const state: { real?: LinuxEasyPushProcessor } = {};
        const create = processorModule.createLinuxEasyPushProcessor;
        const gate = deferred();
        const entered = deferred();
        const clear = vi.spyOn(f.bridge.events, 'clear');
        const stop = vi.fn(() => state.real!.stop());
        let closing: Promise<void> | undefined;
        let settled = false;
        let stoppedInsideGetter = false;
        vi.spyOn(processorModule, 'createLinuxEasyPushProcessor').mockImplementation((options) => {
            const real = create(options);
            state.real = real;
            return {
                onPush: real.onPush,
                activate: real.activate,
                status: real.status,
                get stop(): LinuxEasyPushProcessor['stop'] {
                    order.push('stop');
                    closing = f.bridge.dispose();
                    void closing.then(
                        () => {
                            settled = true;
                        },
                        () => {
                            settled = true;
                        },
                    );
                    stoppedInsideGetter = stop.mock.calls.length > 0;
                    return stop;
                },
                get drain(): LinuxEasyPushProcessor['drain'] {
                    order.push('drain');

                    return async () => {
                        entered.resolve();
                        await gate.promise;
                        await real.drain();
                    };
                },
            };
        });

        try {
            expect(() => f.bridge.openLinuxEasyPushProcessor(f.options)).toThrow(
                'Bridge is disposed',
            );
            expect(order).toEqual(['stop', 'drain']);
            expect(stoppedInsideGetter).toBe(false);
            expect(stop).toHaveBeenCalled();
            expect(f.ownerClose).toHaveBeenCalledTimes(1);
            expect(closing).toBeDefined();
            expect(f.bridge.dispose()).toBe(closing);
            await bounded(entered.promise);
            expect(settled).toBe(false);
            expect(f.close).not.toHaveBeenCalled();
            expect(clear).not.toHaveBeenCalled();
            gate.resolve();
            await bounded(closing!);
            expect(f.close).toHaveBeenCalledTimes(1);
            expect(clear).toHaveBeenCalledTimes(1);
            expect(f.identity.persistenceStatus.state).toBe('closed');
            expectNoExternalActivity(f);
        } finally {
            gate.resolve();
            const real = state.real;

            if (real) {
                real.stop();
                await bounded(real.drain());
            }
        }
    });

    it('rejects disposal if the drain getter reenters it and then throws', async () => {
        const f = setup();
        f.expectDisposalRejection();
        const marker = new Error('synthetic reentrant drain getter failure');
        const order: string[] = [];
        const state: { real?: LinuxEasyPushProcessor } = {};
        const create = processorModule.createLinuxEasyPushProcessor;
        const stop = vi.fn(() => state.real!.stop());
        let closing: Promise<void> | undefined;
        let stoppedInsideGetter = false;
        vi.spyOn(processorModule, 'createLinuxEasyPushProcessor').mockImplementation((options) => {
            const real = create(options);
            state.real = real;
            return {
                onPush: real.onPush,
                activate: real.activate,
                status: real.status,
                get stop(): LinuxEasyPushProcessor['stop'] {
                    order.push('stop');
                    return stop;
                },
                get drain(): LinuxEasyPushProcessor['drain'] {
                    order.push('drain');
                    closing = f.bridge.dispose();
                    void closing.catch(() => undefined);
                    stoppedInsideGetter = stop.mock.calls.length > 0;
                    throw marker;
                },
            };
        });

        try {
            expect(() => f.bridge.openLinuxEasyPushProcessor(f.options)).toThrow(marker);
            expect(order).toEqual(['stop', 'drain']);
            expect(stoppedInsideGetter).toBe(true);
            expect(stop.mock.calls.length).toBeGreaterThanOrEqual(2);
            expect(f.ownerClose).toHaveBeenCalledTimes(1);
            expect(closing).toBeDefined();
            await expect(bounded(closing!)).rejects.toThrow(
                'Direct push processor drain unavailable',
            );
            expectNoExternalActivity(f);
        } finally {
            const real = state.real;

            if (real) {
                real.stop();
                await bounded(real.drain());
            }
        }
    });

    it('waits for drain when the drain getter reenters disposal and returns normally', async () => {
        const f = setup();
        const gate = deferred();
        const entered = deferred();
        const order: string[] = [];
        const state: { real?: LinuxEasyPushProcessor } = {};
        const create = processorModule.createLinuxEasyPushProcessor;
        const stop = vi.fn(() => state.real!.stop());
        let closing: Promise<void> | undefined;
        let stoppedInsideGetter = false;
        vi.spyOn(processorModule, 'createLinuxEasyPushProcessor').mockImplementation((options) => {
            const real = create(options);
            state.real = real;
            return {
                onPush: real.onPush,
                activate: real.activate,
                status: real.status,
                get stop(): LinuxEasyPushProcessor['stop'] {
                    order.push('stop');
                    return stop;
                },
                get drain(): LinuxEasyPushProcessor['drain'] {
                    order.push('drain');
                    closing = f.bridge.dispose();
                    stoppedInsideGetter = stop.mock.calls.length > 0;

                    return async () => {
                        entered.resolve();
                        await gate.promise;
                        await real.drain();
                    };
                },
            };
        });

        try {
            expect(() => f.bridge.openLinuxEasyPushProcessor(f.options)).toThrow(
                'Bridge is disposed',
            );
            expect(order).toEqual(['stop', 'drain']);
            expect(stoppedInsideGetter).toBe(true);
            expect(f.ownerClose).toHaveBeenCalledTimes(1);
            expect(closing).toBeDefined();
            await bounded(entered.promise);
            expect(f.close).not.toHaveBeenCalled();
            gate.resolve();
            await bounded(closing!);
            expect(f.close).toHaveBeenCalledTimes(1);
            expectNoExternalActivity(f);
        } finally {
            gate.resolve();
            const real = state.real;

            if (real) {
                real.stop();
                await bounded(real.drain());
            }
        }
    });

    it.each(['undefined', 'thenable'] as const)(
        'rejects a non-Promise %s drain result without reading then',
        async (kind) => {
            const f = setup();
            f.expectDisposalRejection();
            const state: { real?: LinuxEasyPushProcessor } = {};
            const create = processorModule.createLinuxEasyPushProcessor;
            let thenReads = 0;
            const thenable = {
                get then() {
                    thenReads++;
                    throw new Error('unexpected thenable inspection');
                },
            };
            // Deliberately violate the return type to exercise the runtime boundary.
            const invalid: unknown = kind === 'thenable' ? thenable : undefined;
            const drain = vi.fn(() => invalid as Promise<void>);
            vi.spyOn(processorModule, 'createLinuxEasyPushProcessor').mockImplementation(
                (options) => {
                    const real = create(options);
                    state.real = real;
                    return { ...real, drain };
                },
            );

            try {
                const processor = f.bridge.openLinuxEasyPushProcessor(f.options);
                processor.stop();
                expect(f.ownerClose).toHaveBeenCalledTimes(1);
                await expect(bounded(processor.drain())).rejects.toThrow(
                    'Direct push processor drain unavailable',
                );
                expect(thenReads).toBe(0);
                await expect(bounded(f.bridge.dispose())).rejects.toThrow(
                    'Direct push processor drain unavailable',
                );
                expect(drain).toHaveBeenCalledTimes(2);
                expect(thenReads).toBe(0);
                expectNoExternalActivity(f);
            } finally {
                const real = state.real;

                if (real) {
                    real.stop();
                    await bounded(real.drain());
                }
            }
        },
    );

    it('drains a native Promise without reading its overridden then property', async () => {
        const f = setup();
        const pending = deferred();
        const entered = deferred();
        const state: { real?: LinuxEasyPushProcessor } = {};
        const create = processorModule.createLinuxEasyPushProcessor;
        let thenReads = 0;
        Object.defineProperty(pending.promise, 'then', {
            get() {
                thenReads++;
                throw new Error('unexpected native promise then inspection');
            },
        });
        // A Vitest spy inspects returned thenables itself, which would exercise
        // the test harness rather than Bridge's native-Promise handling.
        let drainCalls = 0;

        const drain = () => {
            drainCalls++;
            entered.resolve();
            return pending.promise;
        };

        vi.spyOn(processorModule, 'createLinuxEasyPushProcessor').mockImplementation((options) => {
            const real = create(options);
            state.real = real;
            return { ...real, drain };
        });

        try {
            const processor = f.bridge.openLinuxEasyPushProcessor(f.options);
            processor.stop();
            const exposed = processor.drain();
            const closing = f.bridge.dispose();
            await bounded(entered.promise);
            await Promise.resolve();
            expect(f.close).not.toHaveBeenCalled();
            expect(thenReads).toBe(0);
            pending.resolve();
            await bounded(Promise.all([exposed, closing]));
            expect(drainCalls).toBe(2);
            expect(thenReads).toBe(0);
            expect(f.close).toHaveBeenCalledTimes(1);
            expectNoExternalActivity(f);
        } finally {
            pending.resolve();
            const real = state.real;

            if (real) {
                real.stop();
                await bounded(real.drain());
            }
        }
    });

    it.each(['value', 'rejected-promise'] as const)(
        'observes a non-void %s stop as a lifecycle failure',
        async (kind) => {
            const f = setup();
            f.expectDisposalRejection();
            const marker = new Error('synthetic rejected stop promise');
            const state: { real?: LinuxEasyPushProcessor } = {};
            const create = processorModule.createLinuxEasyPushProcessor;
            // Deliberately return invalid values from a method whose contract is void.
            const stop = vi.fn(() => {
                state.real!.stop();
                return kind === 'rejected-promise' ? Promise.reject(marker) : 1;
            });
            vi.spyOn(processorModule, 'createLinuxEasyPushProcessor').mockImplementation(
                (options) => {
                    const real = create(options);
                    state.real = real;
                    return { ...real, stop };
                },
            );

            try {
                const processor = f.bridge.openLinuxEasyPushProcessor(f.options);
                let stopFailure: unknown;

                try {
                    processor.stop();
                } catch (error) {
                    stopFailure = error;
                }

                expect(stopFailure).toBeInstanceOf(Error);
                expect(f.ownerClose).toHaveBeenCalledTimes(1);
                expect(processor.status()).toBe('stopped');
                const closing = f.bridge.dispose();
                expect(f.close).not.toHaveBeenCalled();
                const outcome = await bounded(
                    closing.then(
                        () => ({ kind: 'resolved' as const }),
                        (error: unknown) => ({ kind: 'rejected' as const, error }),
                    ),
                );
                expect(outcome.kind).toBe('rejected');

                if (outcome.kind === 'rejected') {
                    expect(outcome.error).toBeInstanceOf(Error);
                }

                expect(f.close).not.toHaveBeenCalled();
                expect(stop).toHaveBeenCalledTimes(2);
                // Allow the runner to observe any unhandled rejection from the
                // deliberately rejected native promises before this test ends.
                await bounded(new Promise<void>((resolve) => setImmediate(resolve)));
                expectNoExternalActivity(f);
            } finally {
                const real = state.real;

                if (real) {
                    real.stop();
                    await bounded(real.drain());
                }
            }
        },
    );

    it('observes a rejected stop promise during reentrant construction before rejecting disposal', async () => {
        const f = setup();
        f.expectDisposalRejection();
        const marker = new Error('synthetic creation-time rejected stop promise');
        const state: { real?: LinuxEasyPushProcessor } = {};
        const create = processorModule.createLinuxEasyPushProcessor;
        const clear = vi.spyOn(f.bridge.events, 'clear');
        const stop = vi.fn(() => {
            state.real!.stop();
            return Promise.reject(marker);
        });
        let closing: Promise<void> | undefined;
        let clearedInsideGetter = false;
        vi.spyOn(processorModule, 'createLinuxEasyPushProcessor').mockImplementation((options) => {
            const real = create(options);
            state.real = real;
            return {
                onPush: real.onPush,
                activate: real.activate,
                status: real.status,
                get stop(): LinuxEasyPushProcessor['stop'] {
                    closing = f.bridge.dispose();
                    void closing.catch(() => undefined);
                    clearedInsideGetter = clear.mock.calls.length > 0;
                    return stop;
                },
                drain: real.drain,
            };
        });

        try {
            let failure: unknown;

            try {
                f.bridge.openLinuxEasyPushProcessor(f.options);
            } catch (error) {
                failure = error;
            }

            expect(failure).toBeInstanceOf(AggregateError);
            const errors: unknown[] = (failure as AggregateError).errors;
            expect(errors).toHaveLength(2);
            expect(errors[0]).toMatchObject({ message: 'Bridge is disposed' });
            expect(errors[1]).toMatchObject({ message: 'Direct push processor stop unavailable' });
            expect(stop).toHaveBeenCalledTimes(1);
            expect(f.ownerClose).toHaveBeenCalledTimes(1);
            expect(clearedInsideGetter).toBe(false);
            expect(f.close).not.toHaveBeenCalled();
            expect(closing).toBeDefined();
            await expect(bounded(closing!)).rejects.toThrow(
                'Direct push processor stop unavailable',
            );
            expect(f.close).not.toHaveBeenCalled();
            await bounded(new Promise<void>((resolve) => setImmediate(resolve)));
            expectNoExternalActivity(f);
        } finally {
            const real = state.real;

            if (real) {
                real.stop();
                await bounded(real.drain());
            }
        }
    });

    it('preserves both a handle getter error and a throwing stop error', async () => {
        const f = setup();
        f.expectDisposalRejection();
        const getterError = new Error('synthetic handle getter failure');
        const stopError = new Error('synthetic stop failure');
        const state: { real?: LinuxEasyPushProcessor } = {};
        const create = processorModule.createLinuxEasyPushProcessor;
        const stop = vi.fn(() => {
            throw stopError;
        });
        vi.spyOn(processorModule, 'createLinuxEasyPushProcessor').mockImplementation((options) => {
            const real = create(options);
            state.real = real;
            return {
                onPush: real.onPush,
                activate: real.activate,
                get status(): LinuxEasyPushProcessor['status'] {
                    throw getterError;
                },
                stop,
                drain: real.drain,
            };
        });

        try {
            let failure: unknown;

            try {
                f.bridge.openLinuxEasyPushProcessor(f.options);
            } catch (error) {
                failure = error;
            }

            expect(failure).toBeInstanceOf(AggregateError);
            expect((failure as AggregateError).errors).toEqual([getterError, stopError]);
            expect(stop).toHaveBeenCalledTimes(1);
            await expect(bounded(f.bridge.dispose())).rejects.toBe(stopError);
            expect(stop).toHaveBeenCalledTimes(2);
            expectNoExternalActivity(f);
        } finally {
            const real = state.real;

            if (real) {
                real.stop();
                await bounded(real.drain());
            }
        }
    });

    it('stops a produced processor if a handle getter throws and later drains it', async () => {
        const f = setup();
        const marker = new Error('synthetic handle getter failure');
        const h = interceptProcessor(() => {
            throw marker;
        });

        try {
            expect(() => f.bridge.openLinuxEasyPushProcessor(f.options)).toThrow(marker);
            expect(h.factory).toHaveBeenCalledTimes(1);
            expect(h.stop).toHaveBeenCalled();
            expect(f.ownerClose).toHaveBeenCalledTimes(1);
            expect(() => f.bridge.openDirectPushIngress(ingress)).toThrow(
                'Direct push ingress already claimed',
            );
            expect(() => f.bridge.openLinuxEasyPushProcessor(f.options)).toThrow(
                'Direct push ingress already claimed',
            );
            const closing = f.bridge.dispose();
            await bounded(h.entered.promise);
            expect(f.close).not.toHaveBeenCalled();
            h.gate.resolve();
            await bounded(closing);
            expect(h.drain).toHaveBeenCalledTimes(1);
            expect(f.close).toHaveBeenCalledTimes(1);
            expectNoExternalActivity(f);
        } finally {
            h.gate.resolve();
        }
    });

    it.each([
        { trigger: 'stop', fails: false },
        { trigger: 'stop', fails: true },
        { trigger: 'dispose', fails: false },
        { trigger: 'dispose', fails: true },
    ] as const)(
        'fences further calls after $trigger when stop fails=$fails',
        async ({ trigger, fails }) => {
            const f = setup();

            if (fails) {
                f.expectDisposalRejection();
            }

            const marker = new Error('synthetic processor stop failure');
            const state: { real?: LinuxEasyPushProcessor } = {};
            const create = processorModule.createLinuxEasyPushProcessor;
            const onPush = vi.fn((...args: Parameters<LinuxEasyPushProcessor['onPush']>) => {
                state.real!.onPush(...args);
            });
            const activate = vi.fn(() => state.real!.activate());
            const status = vi.fn(() => state.real!.status());
            const drain = vi.fn(() => state.real!.drain());
            const stop = vi.fn(() => {
                if (fails) {
                    throw marker;
                }

                state.real!.stop();
            });
            vi.spyOn(processorModule, 'createLinuxEasyPushProcessor').mockImplementation(
                (options) => {
                    const real = create(options);
                    state.real = real;
                    return { onPush, activate, status, drain, stop };
                },
            );

            try {
                const processor = f.bridge.openLinuxEasyPushProcessor(f.options);
                expect(processor.activate()).toBe(false);
                processor.onPush(Uint8Array.of(1), route(1));
                expect(activate).toHaveBeenCalledTimes(1);
                expect(onPush).toHaveBeenCalledTimes(1);
                let closing: Promise<void> | undefined;

                if (trigger === 'stop') {
                    if (fails) {
                        expect(() => processor.stop()).toThrow(marker);
                    } else {
                        processor.stop();
                    }
                } else {
                    closing = f.bridge.dispose();
                    void closing.catch(() => undefined);
                }

                expect(processor.activate()).toBe(false);
                expect(() => processor.onPush(Uint8Array.of(2), route(2))).toThrow(
                    'direct push processor stopped',
                );
                expect(activate).toHaveBeenCalledTimes(1);
                expect(onPush).toHaveBeenCalledTimes(1);
                expect(processor.status()).toBe(fails ? 'buffering' : 'stopped');
                expect(status).toHaveBeenCalled();

                if (fails) {
                    await expect(bounded(processor.drain())).rejects.toThrow(
                        'Direct push processor stop unavailable',
                    );
                    expect(drain).not.toHaveBeenCalled();
                } else {
                    await bounded(processor.drain());
                    expect(drain).toHaveBeenCalled();
                }

                closing ??= f.bridge.dispose();

                if (fails) {
                    await expect(bounded(closing)).rejects.toBe(marker);
                } else {
                    await bounded(closing);
                }

                expect(f.verifyRaw).not.toHaveBeenCalled();
                expect(f.events).toEqual([]);
                expectNoExternalActivity(f);
            } finally {
                const real = state.real;

                if (real) {
                    real.stop();
                    await bounded(real.drain());
                }
            }
        },
    );

    it('returns false when a synthetic activate reenters disposal before returning true', async () => {
        const f = setup();
        const state: { real?: LinuxEasyPushProcessor } = {};
        const create = processorModule.createLinuxEasyPushProcessor;
        let closing: Promise<void> | undefined;
        // This artificial boolean is not an authentication or online-state assertion.
        const activate = vi.fn(() => {
            closing = f.bridge.dispose();
            return true;
        });
        const onPush = vi.fn((...args: Parameters<LinuxEasyPushProcessor['onPush']>) => {
            state.real!.onPush(...args);
        });
        vi.spyOn(processorModule, 'createLinuxEasyPushProcessor').mockImplementation((options) => {
            const real = create(options);
            state.real = real;
            return { ...real, onPush, activate };
        });

        try {
            const processor = f.bridge.openLinuxEasyPushProcessor(f.options);
            expect(processor.activate()).toBe(false);
            expect(activate).toHaveBeenCalledTimes(1);
            expect(f.ownerClose).toHaveBeenCalledTimes(1);
            expect(processor.activate()).toBe(false);
            expect(activate).toHaveBeenCalledTimes(1);
            expect(() => processor.onPush(Uint8Array.of(1), route(1))).toThrow(
                'direct push processor stopped',
            );
            expect(onPush).not.toHaveBeenCalled();
            expect(closing).toBeDefined();
            await bounded(closing!);
            expect(f.close).toHaveBeenCalledTimes(1);
            expectNoExternalActivity(f);
        } finally {
            const real = state.real;

            if (real) {
                real.stop();
                await bounded(real.drain());
            }
        }
    });

    it('rejects reentrant disposal when the stop callback then throws despite a successful fake drain', async () => {
        const f = setup();
        f.expectDisposalRejection();
        const state: { real?: LinuxEasyPushProcessor } = {};
        const create = processorModule.createLinuxEasyPushProcessor;
        const marker = new Error('synthetic reentrant stop failure');
        const clear = vi.spyOn(f.bridge.events, 'clear');
        const drain = vi.fn(async () => undefined);
        let closing: Promise<void> | undefined;
        let clearedInsideStop = false;
        const stop = vi.fn(() => {
            closing = f.bridge.dispose();
            void closing.catch(() => undefined);
            clearedInsideStop = clear.mock.calls.length > 0;
            throw marker;
        });
        vi.spyOn(processorModule, 'createLinuxEasyPushProcessor').mockImplementation((options) => {
            const real = create(options);
            state.real = real;
            return { ...real, stop, drain };
        });

        try {
            const processor = f.bridge.openLinuxEasyPushProcessor(f.options);
            expect(() => processor.stop()).toThrow(marker);
            expect(stop).toHaveBeenCalledTimes(1);
            expect(clearedInsideStop).toBe(false);
            expect(closing).toBeDefined();
            expect(f.bridge.dispose()).toBe(closing);
            expect(f.close).not.toHaveBeenCalled();
            await expect(bounded(closing!)).rejects.toMatchObject({
                message: 'Direct push processor stop unavailable',
                cause: marker,
            });
            expect(drain).not.toHaveBeenCalled();
            expect(f.close).not.toHaveBeenCalled();
            expectNoExternalActivity(f);
        } finally {
            const real = state.real;

            if (real) {
                real.stop();
                await bounded(real.drain());
            }
        }
    });

    it('synchronously stops the processor and waits for its drain before closing identity', async () => {
        const f = setup();
        const h = interceptProcessor();

        try {
            const processor = f.bridge.openLinuxEasyPushProcessor(f.options);
            expect(h.factory).toHaveBeenCalledTimes(1);
            const input = h.factory.mock.calls[0]![0];
            expect(input.owner).toBe(f.owner);
            expect(input.uin).toBe(A);
            expect(input.ingress.identity).toBe(f.identity);
            expect(input.ingress.pipeline).toBeInstanceOf(IncomingPacketPipeline);
            expect(input.ingress.pipelineIdentityBound).toBe(true);
            expect(input.ingress.sourceAuthenticationHandled).toBe(true);
            expect(processor.status()).toBe('buffering');
            const closing = f.bridge.dispose();
            expect(f.bridge.dispose()).toBe(closing);
            expect(h.stop).toHaveBeenCalledTimes(1);
            expect(f.ownerClose).toHaveBeenCalledTimes(1);
            expect(processor.status()).toBe('stopped');
            let settled = false;
            void closing.then(() => {
                settled = true;
            });
            await bounded(h.entered.promise);
            await Promise.resolve();
            expect(h.drain).toHaveBeenCalledTimes(1);
            expect(settled).toBe(false);
            expect(f.close).not.toHaveBeenCalled();
            h.gate.resolve();
            await bounded(closing);
            expect(settled).toBe(true);
            expect(f.close).toHaveBeenCalledTimes(1);
            expect(f.identity.persistenceStatus.state).toBe('closed');
            expectNoExternalActivity(f);
        } finally {
            h.gate.resolve();
        }
    });

    it('publishes the claim before an options getter reenters dispose, without creating a processor', async () => {
        const f = setup();
        const factory = vi.spyOn(processorModule, 'createLinuxEasyPushProcessor');
        let closing: Promise<void> | undefined;
        let nestedFailure: unknown;
        let getterReads = 0;
        const options = {
            ...f.options,
            get queue() {
                getterReads++;

                try {
                    f.bridge.openDirectPushIngress(ingress);
                } catch (error) {
                    nestedFailure = error;
                }

                closing = f.bridge.dispose();
                return f.options.queue;
            },
        };

        expect(() => f.bridge.openLinuxEasyPushProcessor(options)).toThrow('Bridge is disposed');
        expect(getterReads).toBe(1);
        expect(nestedFailure).toMatchObject({ message: 'Direct push ingress already claimed' });
        expect(factory).not.toHaveBeenCalled();
        expect(f.ownerClose).not.toHaveBeenCalled();
        expect(closing).toBeDefined();
        expect(f.bridge.dispose()).toBe(closing);
        await bounded(closing!);
        expect(f.close).toHaveBeenCalledTimes(1);
        expect(f.identity.persistenceStatus.state).toBe('closed');
        expectNoExternalActivity(f);
    });

    it('stops a produced processor when its getter reenters dispose, then awaits its drain', async () => {
        const f = setup();
        let closing: Promise<void> | undefined;
        let ownerClosedInsideGetter = false;
        let reads = 0;
        const h = interceptProcessor(() => {
            reads++;
            closing = f.bridge.dispose();
            ownerClosedInsideGetter = f.ownerClose.mock.calls.length > 0;
        });

        try {
            expect(() => f.bridge.openLinuxEasyPushProcessor(f.options)).toThrow(
                'Bridge is disposed',
            );
            expect(h.factory).toHaveBeenCalledTimes(1);
            expect(reads).toBe(1);
            expect(ownerClosedInsideGetter).toBe(true);
            expect(h.stop).toHaveBeenCalled();
            expect(f.ownerClose).toHaveBeenCalledTimes(1);
            expect(closing).toBeDefined();
            expect(f.bridge.dispose()).toBe(closing);
            await bounded(h.entered.promise);
            expect(f.close).not.toHaveBeenCalled();
            h.gate.resolve();
            await bounded(closing!);
            expect(h.drain).toHaveBeenCalledTimes(1);
            expect(f.close).toHaveBeenCalledTimes(1);
            expect(f.identity.persistenceStatus.state).toBe('closed');
            expectNoExternalActivity(f);
        } finally {
            h.gate.resolve();
        }
    });

    it('isolates different accounts and separate Bridge instances of the same account', async () => {
        const first = setup(A);
        const sameAccount = setup(A);
        const otherAccount = setup(B);
        const factory = vi.spyOn(processorModule, 'createLinuxEasyPushProcessor');
        const business = vi
            .spyOn(IncomingPacketPipeline.prototype, 'processDecodedDirectEvents')
            .mockImplementation(async () => {
                throw new Error('unexpected synthetic business processing');
            });
        const p1 = first.bridge.openLinuxEasyPushProcessor(first.options);
        const p2 = sameAccount.bridge.openLinuxEasyPushProcessor(sameAccount.options);
        const p3 = otherAccount.bridge.openLinuxEasyPushProcessor(otherAccount.options);
        const inputs = factory.mock.calls.map(([input]) => input);

        expect(inputs).toHaveLength(3);
        expect(inputs.map((input) => input.uin)).toEqual([A, A, B]);
        expect(inputs.map((input) => input.owner)).toEqual([
            first.owner,
            sameAccount.owner,
            otherAccount.owner,
        ]);
        expect(inputs.map((input) => input.ingress.identity)).toEqual([
            first.identity,
            sameAccount.identity,
            otherAccount.identity,
        ]);
        expect(inputs[0]!.ingress.pipeline).not.toBe(inputs[1]!.ingress.pipeline);
        expect(inputs[1]!.ingress.pipeline).not.toBe(inputs[2]!.ingress.pipeline);
        p1.onPush(Uint8Array.of(1), route(1));
        p2.onPush(Uint8Array.of(2), route(2));
        p3.onPush(Uint8Array.of(3), route(3));
        expect(p1.activate()).toBe(false);
        expect(p2.activate()).toBe(false);
        expect(p3.activate()).toBe(false);
        const closing = first.bridge.dispose();
        expect(p1.status()).toBe('stopped');
        expect(p2.status()).toBe('buffering');
        expect(p3.status()).toBe('buffering');
        expect(first.ownerClose).toHaveBeenCalledTimes(1);
        expect(sameAccount.ownerClose).not.toHaveBeenCalled();
        expect(otherAccount.ownerClose).not.toHaveBeenCalled();
        await bounded(closing);
        expect(first.identity.persistenceStatus.state).toBe('closed');
        expect(sameAccount.identity.persistenceStatus.state).toBe('memory-only');
        expect(otherAccount.identity.persistenceStatus.state).toBe('memory-only');
        p3.stop();
        await bounded(p3.drain());
        expect(p2.status()).toBe('buffering');
        expect(sameAccount.ownerClose).not.toHaveBeenCalled();
        p2.onPush(Uint8Array.of(4), route(4));
        expect(first.verifyRaw).not.toHaveBeenCalled();
        expect(sameAccount.verifyRaw).not.toHaveBeenCalled();
        expect(otherAccount.verifyRaw).not.toHaveBeenCalled();
        expect(business).not.toHaveBeenCalled();

        for (const f of [first, sameAccount, otherAccount]) {
            expect(f.events).toEqual([]);
            expectNoExternalActivity(f);
        }
    });
});
