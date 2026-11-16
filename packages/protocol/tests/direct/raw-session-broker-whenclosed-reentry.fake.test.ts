import { describe, expect, it, vi } from 'vitest';
import { createRawSessionBroker, type RawSessionLease } from '../../src/direct/raw-session-broker';
import type { Sso12CloseReason, Sso12RawClient } from '../../src/direct/sso12-packet-client';

const reason: Sso12CloseReason = { kind: 'local', code: 'fixture' };

class FakeClient implements Sso12RawClient {
    readonly close = vi.fn();
    readonly readClosed = vi.fn();
    read: () => Promise<Sso12CloseReason> = () => new Promise(() => {});

    get whenClosed(): Promise<Sso12CloseReason> {
        this.readClosed();
        return this.read();
    }

    transactRaw(): never {
        throw new Error('unexpected fake transport call');
    }
}

function foreignThenable(then: unknown, readThen: () => void): Promise<Sso12CloseReason> {
    return Object.defineProperty({}, 'then', {
        get() {
            readThen();
            return then;
        },
    }) as Promise<Sso12CloseReason>;
}

describe('raw session broker whenClosed reentry: pure fakes', () => {
    it.each(['abort in clock', 'deadline in clock'] as const)(
        'stops after tick encounters %s without a getter read or orphan timer',
        async (mode) => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const controller = new AbortController();
            let calls = 0;
            const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
                calls++;

                if (calls === 2 && mode === 'abort in clock') {
                    controller.abort();
                }

                return calls >= 2 && mode === 'deadline in clock' ? 1000 : 100;
            });
            const client = new FakeClient();
            const isUsable = vi.fn(() => true);
            let lease: RawSessionLease | undefined;

            try {
                const broker = createRawSessionBroker(client, {
                    trustedSuccessQuiescence: true,
                    isUsable,
                });
                lease = broker.acquire({ deadline: 1000, signal: controller.signal });
                expect(await lease.whenClosed).toBe('poisoned');
                expect(client.readClosed).not.toHaveBeenCalled();
                expect(isUsable).not.toHaveBeenCalled();
                expect(client.close).toHaveBeenCalledTimes(1);
                expect(vi.getTimerCount()).toBe(0);
                lease.close();
                lease.poison();
                expect(client.close).toHaveBeenCalledTimes(1);
            } finally {
                lease?.close();
                vi.clearAllTimers();
                clock.mockRestore();
                vi.useRealTimers();
            }
        },
    );

    it.each(['abort', 'deadline', 'timer poison'] as const)(
        'does not inspect a foreign thenable after getter triggers %s',
        async (mode) => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            let now = 100;
            const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
            const controller = new AbortController();
            const client = new FakeClient();
            const isUsable = vi.fn(() => true);
            const readThen = vi.fn();
            const invokeThen = vi.fn();
            const returned = foreignThenable(invokeThen, readThen);
            let lease: RawSessionLease | undefined;

            try {
                client.read = () => {
                    if (mode === 'abort') {
                        controller.abort();
                    } else {
                        now = 1000;

                        if (mode === 'timer poison') {
                            vi.advanceTimersByTime(900);
                        }
                    }

                    return returned;
                };

                const broker = createRawSessionBroker(client, {
                    trustedSuccessQuiescence: true,
                    isUsable,
                });
                lease = broker.acquire({ deadline: 1000, signal: controller.signal });
                expect(await lease.whenClosed).toBe('poisoned');
                await Promise.resolve();
                expect(client.readClosed).toHaveBeenCalledTimes(1);
                expect(readThen).not.toHaveBeenCalled();
                expect(invokeThen).not.toHaveBeenCalled();
                expect(isUsable).not.toHaveBeenCalled();
                expect(client.close).toHaveBeenCalledTimes(1);
                expect(vi.getTimerCount()).toBe(0);
                lease.close();
                expect(client.close).toHaveBeenCalledTimes(1);
            } finally {
                lease?.close();
                vi.clearAllTimers();
                clock.mockRestore();
                vi.useRealTimers();
            }
        },
    );

    it.each(['abort', 'deadline'] as const)(
        'observes a genuine rejected promise returned after getter triggers %s',
        async (mode) => {
            let now = 100;
            const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
            const controller = new AbortController();
            const client = new FakeClient();
            const isUsable = vi.fn(() => true);
            const readThen = vi.fn(() => {
                throw new Error('own then getter must not be read');
            });
            const rejected = Promise.reject<Sso12CloseReason>(new Error('fixture rejection'));
            Object.defineProperty(rejected, 'then', { get: readThen });
            let lease: RawSessionLease | undefined;

            try {
                client.read = () => {
                    if (mode === 'abort') {
                        controller.abort();
                    } else {
                        now = 1000;
                    }

                    return rejected;
                };

                lease = createRawSessionBroker(client, {
                    trustedSuccessQuiescence: true,
                    isUsable,
                }).acquire({ deadline: 1000, signal: controller.signal });
                expect(await lease.whenClosed).toBe('poisoned');
                // Cross a real event-loop turn so the runner can detect an unhandled rejection.
                await new Promise<void>((resolve) => setImmediate(resolve));
                expect(readThen).not.toHaveBeenCalled();
                expect(isUsable).not.toHaveBeenCalled();
                expect(client.close).toHaveBeenCalledTimes(1);
            } finally {
                lease?.close();
                void Promise.prototype.then.call(rejected, undefined, () => {});
                clock.mockRestore();
            }
        },
    );

    it('poisons when the whenClosed getter throws', async () => {
        const client = new FakeClient();
        const isUsable = vi.fn(() => true);
        let lease: RawSessionLease | undefined;

        try {
            client.read = () => {
                throw new Error('fixture getter error');
            };

            lease = createRawSessionBroker(client, {
                trustedSuccessQuiescence: true,
                isUsable,
            }).acquire({ deadline: performance.now() + 10_000 });
            expect(await lease.whenClosed).toBe('poisoned');
            expect(client.readClosed).toHaveBeenCalledTimes(1);
            expect(isUsable).not.toHaveBeenCalled();
            expect(client.close).toHaveBeenCalledTimes(1);
        } finally {
            lease?.close();
        }
    });

    it.each(['resolve', 'reject'] as const)(
        'continues accepting an active foreign thenable and poisons on %s',
        async (outcome) => {
            const client = new FakeClient();
            const isUsable = vi.fn(() => true);
            const readThen = vi.fn();
            const invokeThen = vi.fn(
                (resolve: (value: Sso12CloseReason) => void, reject: (error: unknown) => void) => {
                    if (outcome === 'resolve') {
                        resolve(reason);
                    } else {
                        reject(new Error('fixture thenable rejection'));
                    }
                },
            );
            client.read = () => foreignThenable(invokeThen, readThen);
            let lease: RawSessionLease | undefined;

            try {
                lease = createRawSessionBroker(client, {
                    trustedSuccessQuiescence: true,
                    isUsable,
                }).acquire({ deadline: performance.now() + 10_000 });
                expect(isUsable).toHaveBeenCalledTimes(1);
                expect(await lease.whenClosed).toBe('poisoned');
                expect(client.readClosed).toHaveBeenCalledTimes(1);
                expect(readThen).toHaveBeenCalledTimes(1);
                expect(invokeThen).toHaveBeenCalledTimes(1);
                expect(client.close).toHaveBeenCalledTimes(1);
            } finally {
                lease?.close();
            }
        },
    );
});
