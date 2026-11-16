import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { IncomingPacketPipeline } from '@snowluma/protocol/packet-pipeline';
import { describe, expect, it, vi } from 'vitest';

import { Bridge } from '../src/bridge/bridge';

const UIN = '10001';
const COMMAND = 'synthetic.packet.reservation';

function deferred() {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('packet reservation watchdog')), 2000);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

async function flushMicrotasks() {
    for (let i = 0; i < 8; i++) {
        await Promise.resolve();
    }
}

function packet(): PacketInfo {
    return {
        pid: 123,
        uin: UIN,
        serviceCmd: COMMAND,
        seqId: 17,
        retCode: 0,
        fromClient: false,
        body: new Uint8Array(),
    };
}

function restore(object: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined) {
    if (descriptor) {
        Object.defineProperty(object, key, descriptor);
    } else {
        Reflect.deleteProperty(object, key);
    }
}

function setup() {
    const identity = IdentityService.memory(UIN);
    const bridge = new Bridge(identity);
    const events: QQEventVariant[] = [];
    bridge.events.onAny((event) => {
        events.push(event);
    });
    const close = vi.spyOn(identity, 'close');
    const clear = vi.spyOn(bridge.events, 'clear');

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
    const event = {
        kind: 'online_devices_changed',
        time: 1710000000,
        selfUin: Number(UIN),
        devices: [],
    } satisfies QQEventVariant;
    const parser = vi.fn((_packet: PacketInfo, _identity: IdentityService) => [event]);
    bridge.registerCmd(COMMAND, parser);
    return { identity, bridge, events, close, clear, external, parser, event };
}

type Fixture = ReturnType<typeof setup>;

function expectIdle(f: Fixture) {
    expect(f.bridge.empty).toBe(true);
    expect(f.bridge.activePid).toBeNull();

    for (const spy of f.external) {
        expect(spy).not.toHaveBeenCalled();
    }
}

function delayRealPipeline() {
    const gate = deferred();
    const entered = deferred();
    const original = IncomingPacketPipeline.prototype.process;
    const process = vi
        .spyOn(IncomingPacketPipeline.prototype, 'process')
        .mockImplementation(async function (this: IncomingPacketPipeline, pkt) {
            entered.resolve();
            await gate.promise;
            await original.call(this, pkt);
        });
    return { gate, entered, process };
}

async function cleanup(f: Fixture, release: () => void, reset: () => void = () => {}) {
    release();
    reset();

    try {
        await bounded(f.bridge.dispose());
    } finally {
        vi.restoreAllMocks();
    }
}

describe('Bridge packet reservations with memory-only synthetic inputs', () => {
    it('reserves before a packet pid getter reenters dispose and drains the real pipeline', async () => {
        const f = setup();
        const delayed = delayRealPipeline();
        const pkt = packet();
        const descriptor = Object.getOwnPropertyDescriptor(pkt, 'pid');
        let closing: Promise<void> | undefined;
        let reads = 0;
        Object.defineProperty(pkt, 'pid', {
            configurable: true,
            get() {
                reads++;
                closing = f.bridge.dispose();
                return 123;
            },
        });

        try {
            const work = f.bridge.onPacket(pkt);
            expect(reads).toBe(1);
            expect(closing).toBeDefined();
            expect(f.bridge.dispose()).toBe(closing);
            await bounded(delayed.entered.promise);
            await flushMicrotasks();
            expect(f.close).not.toHaveBeenCalled();
            expect(f.clear).not.toHaveBeenCalled();
            expect(f.bridge.events.has('online_devices_changed')).toBe(true);
            expect(f.parser).not.toHaveBeenCalled();
            expect(f.events).toEqual([]);
            delayed.gate.resolve();
            await bounded(work);
            expect(f.parser).toHaveBeenCalledTimes(1);
            expect(f.parser).toHaveBeenCalledWith(pkt, f.identity);
            expect(f.events).toEqual([f.event]);
            await bounded(closing!);
            expect(f.close).toHaveBeenCalledTimes(1);
            expect(f.clear).toHaveBeenCalledTimes(1);
            expect(f.bridge.dispose()).toBe(closing);
            expectIdle(f);
        } finally {
            await cleanup(f, delayed.gate.resolve, () => restore(pkt, 'pid', descriptor));
        }
    });

    it('reserves before initialization getter reentry and waits for initialization and pipeline', async () => {
        const f = setup();
        const delayed = delayRealPipeline();
        const init = deferred();
        const descriptor = Object.getOwnPropertyDescriptor(f.identity, 'initialization');
        let closing: Promise<void> | undefined;
        let reads = 0;
        Object.defineProperty(f.identity, 'initialization', {
            configurable: true,
            get() {
                reads++;
                closing = f.bridge.dispose();
                return init.promise;
            },
        });

        try {
            const pkt = packet();
            const work = f.bridge.onPacket(pkt);
            expect(reads).toBe(1);
            expect(closing).toBeDefined();
            expect(f.bridge.dispose()).toBe(closing);
            await flushMicrotasks();
            expect(delayed.process).not.toHaveBeenCalled();
            expect(f.close).not.toHaveBeenCalled();
            expect(f.clear).not.toHaveBeenCalled();
            init.resolve();
            await bounded(delayed.entered.promise);
            await flushMicrotasks();
            expect(f.close).not.toHaveBeenCalled();
            expect(f.clear).not.toHaveBeenCalled();
            expect(f.parser).not.toHaveBeenCalled();
            delayed.gate.resolve();
            await bounded(work);
            expect(f.events).toEqual([f.event]);
            expect(f.parser).toHaveBeenCalledWith(pkt, f.identity);
            await bounded(closing!);
            expect(f.close).toHaveBeenCalledTimes(1);
            expect(f.clear).toHaveBeenCalledTimes(1);
            expectIdle(f);
        } finally {
            await cleanup(
                f,
                () => {
                    init.resolve();
                    delayed.gate.resolve();
                },
                () => restore(f.identity, 'initialization', descriptor),
            );
        }
    });

    it('releases the reservation when the pid getter synchronously throws', async () => {
        const f = setup();
        const pkt = packet();
        const descriptor = Object.getOwnPropertyDescriptor(pkt, 'pid');
        const marker = new Error('synthetic pid getter failure');
        Object.defineProperty(pkt, 'pid', {
            configurable: true,
            get() {
                throw marker;
            },
        });

        try {
            try {
                f.bridge.onPacket(pkt);
                throw new Error('expected the pid getter to throw');
            } catch (error) {
                expect(error).toBe(marker);
            }

            const closing = f.bridge.dispose();
            expect(f.bridge.dispose()).toBe(closing);
            await bounded(closing);
            expect(f.parser).not.toHaveBeenCalled();
            expect(f.events).toEqual([]);
            expect(f.close).toHaveBeenCalledTimes(1);
            expect(f.clear).toHaveBeenCalledTimes(1);
            expectIdle(f);
        } finally {
            await cleanup(
                f,
                () => {},
                () => restore(pkt, 'pid', descriptor),
            );
        }
    });

    it('does not inspect the public work promise constructor while draining', async () => {
        const f = setup();
        const delayed = delayRealPipeline();
        let work: Promise<void> | undefined;
        let descriptor: PropertyDescriptor | undefined;
        let reads = 0;

        try {
            work = f.bridge.onPacket(packet());
            const observed = work.then(() => 'settled');
            await bounded(delayed.entered.promise);
            descriptor = Object.getOwnPropertyDescriptor(work, 'constructor');
            Object.defineProperty(work, 'constructor', {
                configurable: true,
                get() {
                    reads++;
                    throw new Error('synthetic public work constructor access');
                },
            });
            const closing = f.bridge.dispose();
            await flushMicrotasks();
            expect(reads).toBe(0);
            expect(f.close).not.toHaveBeenCalled();
            expect(f.clear).not.toHaveBeenCalled();
            delayed.gate.resolve();
            expect(await bounded(observed)).toBe('settled');
            await bounded(closing);
            expect(reads).toBe(0);
            expect(f.events).toEqual([f.event]);
            expect(f.close).toHaveBeenCalledTimes(1);
            expect(f.clear).toHaveBeenCalledTimes(1);
            expectIdle(f);
        } finally {
            await cleanup(f, delayed.gate.resolve, () => {
                if (work) {
                    restore(work, 'constructor', descriptor);
                }
            });
        }
    });

    it('preserves a rejected work reason and disposes after work settles', async () => {
        const f = setup();
        const init = deferred();
        const descriptor = Object.getOwnPropertyDescriptor(f.identity, 'initialization');
        const marker = new Error('synthetic initialization rejection');
        const order: string[] = [];
        const originalClose = IdentityService.prototype.close;
        f.close.mockImplementation(() => {
            order.push('close');
            return originalClose.call(f.identity);
        });
        Object.defineProperty(f.identity, 'initialization', {
            configurable: true,
            get() {
                return init.promise;
            },
        });

        try {
            const work = f.bridge.onPacket(packet());
            const observed = work.then(
                () => ({ status: 'fulfilled' as const }),
                (reason: unknown) => {
                    order.push('work-rejected');
                    return { status: 'rejected' as const, reason };
                },
            );
            const closing = f.bridge.dispose();
            expect(f.bridge.dispose()).toBe(closing);
            await flushMicrotasks();
            expect(f.close).not.toHaveBeenCalled();
            expect(f.clear).not.toHaveBeenCalled();
            // Identity close must use its original, successfully initialized memory state.
            restore(f.identity, 'initialization', descriptor);
            init.reject(marker);
            expect(await bounded(observed)).toEqual({ status: 'rejected', reason: marker });
            await bounded(closing);
            expect(order).toEqual(['work-rejected', 'close']);
            expect(f.parser).not.toHaveBeenCalled();
            expect(f.events).toEqual([]);
            expect(f.close).toHaveBeenCalledTimes(1);
            expect(f.clear).toHaveBeenCalledTimes(1);
            expectIdle(f);
        } finally {
            await cleanup(f, init.resolve, () => restore(f.identity, 'initialization', descriptor));
        }
    });
});
