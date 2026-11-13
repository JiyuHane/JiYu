import { getLogLevel, setLogLevel, subscribeLogs } from '@snowluma/common/logger';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '../src/bridge/bridge';
import { BridgeManager } from '../src/bridge/manager';

const previousLevel = getLogLevel();
const sender = () => ({
    sendPacket: vi.fn(async () => ({
        success: false,
        gotResponse: false,
        errorCode: -1,
        errorMessage: '',
        responseData: Buffer.alloc(0),
    })),
});
const packet = (pid: number, uin: string): PacketInfo => ({
    pid,
    uin,
    serviceCmd: 'Test.Health',
    seqId: 1,
    retCode: 0,
    fromClient: false,
    body: Buffer.alloc(0),
});

describe('BridgeManager aggregate receive health', () => {
    let manager: BridgeManager;
    beforeEach(() => {
        vi.spyOn(IdentityService, 'openForUin').mockImplementation((uin) =>
            IdentityService.memory(uin),
        );
        manager = new BridgeManager();
    });
    afterEach(async () => {
        await manager.dispose();
        setLogLevel(previousLevel);
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('observes only aggregate changes, bind resets, non-final detach and final close', () => {
        const events: Array<{ uin: string; bridge: unknown; healthy: boolean }> = [];
        const closed = vi.fn();
        manager.subscribeSessions({
            receiveHealthChanged: (uin, bridge) =>
                events.push({ uin, bridge, healthy: bridge.receiveHealthy }),
            closed,
        });
        const first = sender();
        manager.onHookLogin(101, '10001', first);
        const bridge = manager.getBridge('10001')!;
        expect(events).toEqual([{ uin: '10001', bridge, healthy: true }]);
        manager.onHookLogin(202, '10001', sender());
        manager.onPidReceiveHealthChanged(101, false);
        expect(events).toHaveLength(1);
        manager.onPidReceiveHealthChanged(202, false);
        manager.onPidReceiveHealthChanged(202, false);
        expect(events.map((event) => event.healthy)).toEqual([true, false]);
        manager.onHookLogin(101, '10001', first);
        expect(events.map((event) => event.healthy)).toEqual([true, false, true]);
        manager.onPidDisconnected(101);
        expect(events.map((event) => event.healthy)).toEqual([true, false, true, false]);
        manager.onPidDisconnected(202);
        expect(events).toHaveLength(4);
        expect(closed).toHaveBeenCalledOnce();
        expect(closed).toHaveBeenCalledWith('10001', bridge, 202);
    });

    it('holds nested started health until every started listener has completed', () => {
        const order: string[] = [];
        manager.subscribeSessions({
            started: () => {
                order.push('started-a');
                manager.onPidReceiveHealthChanged(101, false);
                order.push('started-a-end');
            },
        });
        manager.subscribeSessions({
            started: (_uin, bridge) => order.push(`started-b:${bridge.receiveHealthy}`),
            receiveHealthChanged: (_uin, bridge) => order.push(`health:${bridge.receiveHealthy}`),
        });
        manager.onHookLogin(101, '10001', sender());
        expect(order).toEqual(['started-a', 'started-a-end', 'started-b:false', 'health:false']);
    });

    it('keeps the started boundary for an initially empty packet-created bridge', () => {
        const order: string[] = [];
        vi.spyOn(Bridge.prototype, 'onPacket').mockImplementation(() => {
            order.push('accepted');
            return Promise.resolve();
        });
        manager.subscribeSessions({
            started: (uin, bridge) => {
                if (uin === '10001') {
                    order.push(`started-a:${bridge.receiveHealthy}`);
                    manager.onHookLogin(101, uin, sender());
                }
            },
        });
        manager.subscribeSessions({
            started: (uin, bridge) => {
                if (uin === '10001') {
                    order.push(`started-b:${bridge.receiveHealthy}`);
                    manager.onPidReceiveHealthChanged(101, false);
                }
            },
            receiveHealthChanged: (uin, bridge) =>
                order.push(`health:${uin}:${bridge.receiveHealthy}`),
        });
        manager.onPacket(packet(0, '10001'));
        expect(order).toEqual([
            'started-a:false',
            'started-b:true',
            'accepted',
            'health:10001:false',
        ]);
        order.length = 0;
        manager.onPacket(packet(0, '20002'));
        expect(order).toEqual(['accepted']);
    });

    it('waits for packet acceptance after nested started and preserves ownership when notified', () => {
        const order: string[] = [];
        manager.onHookLogin(101, '10001', sender());
        const old = manager.getBridge('10001')!;
        const onPacket = vi.spyOn(Bridge.prototype, 'onPacket').mockImplementation(() => {
            order.push('accepted');
            return Promise.resolve();
        });
        manager.subscribeSessions({
            started: (uin) => {
                if (uin === '20002') {
                    order.push('started');
                    manager.onPidReceiveHealthChanged(101, false);
                }
            },
            receiveHealthChanged: (uin, bridge) => {
                order.push(`health:${uin}:${bridge.receiveHealthy}`);
                manager.onPidDisconnected(101);
            },
        });
        manager.onPacket(packet(101, '20002'));
        expect(order).toEqual(['started', 'accepted', 'health:20002:false']);
        expect(onPacket).toHaveBeenCalledOnce();
        expect(old.hasPid(101)).toBe(false);
        expect(manager.getBridge('20002')).toBeNull();
    });

    it('coalesces ordinary same-batch ABA without misreporting an edge', () => {
        manager.onHookLogin(101, '10001', sender());
        const seen = vi.fn();
        manager.subscribeSessions({
            started: (uin) => {
                if (uin === '20002') {
                    manager.onPidReceiveHealthChanged(101, false);
                    manager.onPidReceiveHealthChanged(101, true);
                }
            },
            receiveHealthChanged: seen,
        });
        manager.onHookLogin(202, '20002', sender());
        expect(seen).toHaveBeenCalledTimes(1);
        expect(seen).toHaveBeenCalledWith('20002', manager.getBridge('20002'));
    });

    it('keeps a final in-flight ABA candidate for listeners not yet called', () => {
        manager.onHookLogin(101, '10001', sender());
        const seenA: boolean[] = [];
        const seenB: boolean[] = [];
        let once = false;
        manager.subscribeSessions({
            receiveHealthChanged: (_uin, bridge) => {
                seenA.push(bridge.receiveHealthy);

                if (!once) {
                    once = true;
                    manager.onPidReceiveHealthChanged(101, true);
                    manager.onPidReceiveHealthChanged(101, false);
                }
            },
        });
        manager.subscribeSessions({
            receiveHealthChanged: (_uin, bridge) => seenB.push(bridge.receiveHealthy),
        });
        manager.onPidReceiveHealthChanged(101, false);
        expect(seenA).toEqual([false, false]);
        expect(seenB).toEqual([false]);
    });

    it('uses batch-start baseline when an existing logger reenters bind after mutation', () => {
        const first = sender();
        manager.onHookLogin(101, '10001', first);
        manager.onHookLogin(202, '10001', sender());
        manager.onPidReceiveHealthChanged(101, false);
        manager.onPidReceiveHealthChanged(202, false);
        const seen = vi.fn();
        manager.subscribeSessions({ receiveHealthChanged: seen });
        setLogLevel('trace');
        let entered = false;
        const unsubscribe = subscribeLogs((entry) => {
            if (
                !entered &&
                entry.scope === 'Bridge.Runtime' &&
                entry.message.startsWith('bridge_sender_fact event=selected') &&
                entry.message.includes('pid=101')
            ) {
                entered = true;
                manager.onPidReceiveHealthChanged(101, false);
            }
        });

        try {
            manager.onHookLogin(101, '10001', first);
            expect(entered).toBe(true);
            expect(manager.getBridge('10001')!.receiveHealthy).toBe(false);
            expect(seen).not.toHaveBeenCalled();
        } finally {
            unsubscribe();
        }
    });

    it.each([false, true])(
        'retains a bind logger failure and records only a completed owned reset, record throws=%s',
        async (recordThrows) => {
            const first = sender();
            manager.onHookLogin(101, '10001', first);
            manager.onHookLogin(202, '10001', sender());
            manager.onPidReceiveHealthChanged(101, false);
            manager.onPidReceiveHealthChanged(202, false);
            const bridge = manager.getBridge('10001')!;
            const seen = vi.fn();
            manager.subscribeSessions({ receiveHealthChanged: seen });

            if (recordThrows) {
                vi.spyOn(
                    manager as unknown as { recordHealthChange: () => void },
                    'recordHealthChange',
                ).mockImplementation(() => {
                    throw Error('record private');
                });
            }

            setLogLevel('trace');
            const original = Error('synthetic selected trace failure');
            let thrown = false;
            const unsubscribe = subscribeLogs((entry) => {
                if (
                    !thrown &&
                    entry.scope === 'Bridge.Runtime' &&
                    entry.message.startsWith('bridge_sender_fact event=selected') &&
                    entry.message.includes('pid=101')
                ) {
                    thrown = true;
                    throw original;
                }
            });

            try {
                let caught: unknown;

                try {
                    manager.onHookLogin(101, '10001', first);
                } catch (error) {
                    caught = error;
                }

                expect(thrown).toBe(true);
                expect(caught).toBe(original);
                expect(bridge.receiveHealthy).toBe(true);
                expect(bridge.hasPid(101)).toBe(true);
                expect(seen).not.toHaveBeenCalled();
                await new Promise<void>((resolve) => setImmediate(resolve));

                if (recordThrows) {
                    expect(seen).not.toHaveBeenCalled();
                } else {
                    expect(seen).toHaveBeenCalledExactlyOnceWith('10001', bridge);
                }
            } finally {
                unsubscribe();
            }
        },
    );

    it('does not report a new PID whose bind fails before manager ownership is committed', async () => {
        manager.onHookLogin(101, '10001', sender());
        manager.onPidReceiveHealthChanged(101, false);
        const bridge = manager.getBridge('10001')!;
        const seen = vi.fn();
        manager.subscribeSessions({ receiveHealthChanged: seen });
        setLogLevel('trace');
        const original = Error('new bind failed');
        let thrown = false;
        const unsubscribe = subscribeLogs((entry) => {
            if (
                !thrown &&
                entry.scope === 'Bridge.Runtime' &&
                entry.message.startsWith('bridge_sender_fact event=selected') &&
                entry.message.includes('pid=202')
            ) {
                thrown = true;
                throw original;
            }
        });

        try {
            let caught: unknown;

            try {
                manager.onHookLogin(202, '10001', sender());
            } catch (error) {
                caught = error;
            }

            expect(caught).toBe(original);
            expect(bridge.hasPid(202)).toBe(true);
            expect(seen).not.toHaveBeenCalled();
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(seen).not.toHaveBeenCalled();
            expect(() => manager.onPidReceiveHealthChanged(202, false)).toThrow(
                'receive health for unmapped PID=202',
            );
        } finally {
            unsubscribe();
        }
    });

    it.each(['disconnect', 'rebind'] as const)(
        'reports completed non-final detach after one-shot logger failure during %s',
        async (mode) => {
            manager.onHookLogin(202, '10001', sender());
            manager.onPidReceiveHealthChanged(202, false);
            manager.onHookLogin(101, '10001', sender());
            const bridge = manager.getBridge('10001')!;
            const seen = vi.fn();
            manager.subscribeSessions({ receiveHealthChanged: seen });
            setLogLevel('trace');
            const original = Error('synthetic fallback trace failure');
            let thrown = false;
            const unsubscribe = subscribeLogs((entry) => {
                if (
                    !thrown &&
                    entry.scope === 'Bridge.Runtime' &&
                    entry.message.startsWith('bridge_sender_fact event=fallback')
                ) {
                    thrown = true;
                    throw original;
                }
            });

            try {
                let caught: unknown;

                try {
                    if (mode === 'disconnect') {
                        manager.onPidDisconnected(101);
                    } else {
                        manager.onHookLogin(101, '20002', sender());
                    }
                } catch (error) {
                    caught = error;
                }

                expect(thrown).toBe(true);
                expect(caught).toBe(original);
                expect(bridge.receiveHealthy).toBe(false);
                expect(bridge.hasPid(101)).toBe(false);
                expect(bridge.hasPid(202)).toBe(true);
                expect(manager.getBridge('20002')).toBeNull();
                expect(seen).not.toHaveBeenCalled();
                await new Promise<void>((resolve) => setImmediate(resolve));
                expect(seen).toHaveBeenCalledExactlyOnceWith('10001', bridge);
                manager.onPidReceiveHealthChanged(202, false);
                expect(seen).toHaveBeenCalledOnce();
                expect(() => manager.onPidReceiveHealthChanged(101, false)).toThrow(
                    'receive health for unmapped PID=101',
                );
            } finally {
                unsubscribe();
            }
        },
    );

    it.each([false, true])(
        'checks the new owner after reentrant rebind during failed detach, inconsistent=%s',
        async (inconsistent) => {
            manager.onHookLogin(202, '10001', sender());
            manager.onPidReceiveHealthChanged(202, false);
            manager.onHookLogin(101, '10001', sender());
            const oldBridge = manager.getBridge('10001')!;
            const events: Array<{ uin: string; bridge: unknown; healthy: boolean }> = [];
            manager.subscribeSessions({
                receiveHealthChanged: (uin, bridge) =>
                    events.push({ uin, bridge, healthy: bridge.receiveHealthy }),
            });
            setLogLevel('trace');
            const original = Error('synthetic fallback after rebind');
            let entered = false;
            const unsubscribe = subscribeLogs((entry) => {
                if (
                    !entered &&
                    entry.scope === 'Bridge.Runtime' &&
                    entry.message.startsWith('bridge_sender_fact event=fallback')
                ) {
                    entered = true;
                    manager.onHookLogin(101, '20002', sender());

                    // Deliberate synthetic corruption: direct Bridge mutation bypasses
                    // manager ownership and is not a supported normal lifecycle.
                    if (inconsistent) {
                        manager.getBridge('20002')!.detachPid(101);
                    }

                    throw original;
                }
            });

            try {
                let caught: unknown;

                try {
                    manager.onPidDisconnected(101);
                } catch (error) {
                    caught = error;
                }

                const newBridge = manager.getBridge('20002')!;
                expect(entered).toBe(true);
                expect(caught).toBe(original);
                expect(oldBridge.hasPid(101)).toBe(false);
                expect(oldBridge.hasPid(202)).toBe(true);
                expect(oldBridge.receiveHealthy).toBe(false);
                expect(newBridge.hasPid(101)).toBe(!inconsistent);
                expect(events).toEqual([]);
                await new Promise<void>((resolve) => setImmediate(resolve));

                if (inconsistent) {
                    expect(events).toEqual([]);
                    expect(() => manager.onPidReceiveHealthChanged(101, false)).toThrow(
                        'receive health PID=101 is not owned by UIN=20002',
                    );
                } else {
                    expect(events).toHaveLength(2);
                    expect(events).toContainEqual({
                        uin: '10001',
                        bridge: oldBridge,
                        healthy: false,
                    });
                    expect(events).toContainEqual({
                        uin: '20002',
                        bridge: newBridge,
                        healthy: true,
                    });
                    expect(() => manager.onPidReceiveHealthChanged(101, true)).not.toThrow();
                    expect(events).toHaveLength(2);
                }
            } finally {
                unsubscribe();
            }
        },
    );

    it('retains the original packet failure and defers completed ownership changes', async () => {
        manager.onHookLogin(101, '10001', sender());
        manager.onHookLogin(102, '10001', sender());
        manager.onPidReceiveHealthChanged(102, false);
        manager.onHookLogin(201, '20002', sender());
        manager.onPidReceiveHealthChanged(201, false);
        const old = manager.getBridge('10001')!;
        const target = manager.getBridge('20002')!;
        const events: string[] = [];
        manager.subscribeSessions({
            receiveHealthChanged: (uin, bridge) => events.push(`${uin}:${bridge.receiveHealthy}`),
        });
        const problem = Error('synthetic packet failure');
        vi.spyOn(target, 'onPacket').mockImplementation(() => {
            throw problem;
        });
        expect(() => manager.onPacket(packet(101, '20002'))).toThrow(problem);
        expect(events).toEqual([]);
        expect(old.hasPid(101)).toBe(false);
        expect(target.hasPid(101)).toBe(true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(events).toEqual(['10001:false', '20002:true']);
    });

    it('isolates listener and diagnostic exceptions without exposing data', () => {
        manager.onHookLogin(101, '10001', sender());
        const delivered = vi.fn();
        const logged: string[] = [];
        manager.subscribeSessions({
            receiveHealthChanged: () => {
                throw Error('private/secret');
            },
        });
        manager.subscribeSessions({ receiveHealthChanged: delivered });
        const un = subscribeLogs((entry) => {
            if (entry.message === 'receive health listener failed') {
                logged.push(entry.message);
                throw Error('subscriber secret');
            }
        });

        try {
            expect(() => manager.onPidReceiveHealthChanged(101, false)).not.toThrow();
            expect(delivered).toHaveBeenCalledOnce();
            expect(logged).toEqual(['receive health listener failed']);
        } finally {
            un();
        }
    });

    it('preserves subscription snapshots and ignores callbacks after disposal', async () => {
        manager.onHookLogin(101, '10001', sender());
        const order: string[] = [];

        let remove = () => {};

        manager.subscribeSessions({
            receiveHealthChanged: () => {
                order.push('first');
                remove();
                manager.subscribeSessions({ receiveHealthChanged: () => order.push('later') });
            },
        });
        remove = manager.subscribeSessions({ receiveHealthChanged: () => order.push('second') });
        manager.onPidReceiveHealthChanged(101, false);
        expect(order).toEqual(['first', 'second']);
        order.length = 0;
        manager.onPidReceiveHealthChanged(101, true);
        expect(order).toEqual(['first', 'later']);
        await manager.dispose();
        manager.onPidReceiveHealthChanged(101, false);
        expect(order).toEqual(['first', 'later']);
    });

    it('retains an in-flight candidate when a listener triggers a routing exception', async () => {
        manager.onHookLogin(101, '10001', sender());
        const events: boolean[] = [];
        let once = false;
        manager.subscribeSessions({
            receiveHealthChanged: () => {
                if (!once) {
                    once = true;
                    expect(() => manager.onPidReceiveHealthChanged(404, false)).toThrow();
                }
            },
        });
        manager.subscribeSessions({
            receiveHealthChanged: (_uin, bridge) => events.push(bridge.receiveHealthy),
        });
        manager.onPidReceiveHealthChanged(101, false);
        expect(events).toEqual([]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(events).toEqual([false]);
    });

    it('lets another bridge progress within the bounded reentrant drain', async () => {
        vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] });
        manager.onHookLogin(101, '10001', sender());
        manager.onHookLogin(201, '20002', sender());
        let count = 0;
        const other: boolean[] = [];
        manager.subscribeSessions({
            receiveHealthChanged: (uin, bridge) => {
                if (uin === '10001') {
                    count++;

                    if (count === 1) {
                        manager.onPidReceiveHealthChanged(201, false);
                    }

                    if (count < 40) {
                        manager.onPidReceiveHealthChanged(101, !bridge.receiveHealthy);
                    }
                } else {
                    other.push(bridge.receiveHealthy);
                }
            },
        });
        manager.onPidReceiveHealthChanged(101, false);
        expect(other).toEqual([false]);
        expect(count).toBeLessThanOrEqual(32);
        await vi.runAllTimersAsync();
        expect(count).toBe(40);
    });

    it('yields after 32 reentrant notifications and cancels scheduled work on dispose', async () => {
        vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] });
        manager.onHookLogin(101, '10001', sender());
        const schedule = vi.spyOn(globalThis, 'setImmediate');
        const cancel = vi.spyOn(globalThis, 'clearImmediate');
        let count = 0;
        manager.subscribeSessions({
            receiveHealthChanged: (_uin, bridge) => {
                count++;

                if (count < 100) {
                    manager.onPidReceiveHealthChanged(101, !bridge.receiveHealthy);
                }
            },
        });
        manager.onPidReceiveHealthChanged(101, false);
        expect(count).toBe(32);
        expect(schedule).toHaveBeenCalledOnce();
        const handle = schedule.mock.results[0]!.value;
        const disposing = manager.dispose();
        expect(cancel).toHaveBeenCalledWith(handle);
        expect(vi.getTimerCount()).toBe(0);
        await disposing;
        expect(schedule).toHaveBeenCalledOnce();
        await vi.runAllTimersAsync();
        expect(count).toBe(32);
    });

    it('preserves unknown PID invariants and does not deliver stale closed bridges', () => {
        const seen = vi.fn();
        manager.subscribeSessions({ receiveHealthChanged: seen });
        expect(() => manager.onPidReceiveHealthChanged(404, false)).toThrow(
            'receive health for unmapped PID=404',
        );
        expect(seen).not.toHaveBeenCalled();
        manager.onHookLogin(101, '10001', sender());
        seen.mockClear();
        manager.onPidDisconnected(101);
        expect(seen).not.toHaveBeenCalled();
    });
});
