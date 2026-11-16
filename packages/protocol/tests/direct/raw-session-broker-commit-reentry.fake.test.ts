import { describe, expect, it, vi } from 'vitest';
import { createRawSessionBroker, type RawSessionLease } from '../../src/direct/raw-session-broker';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
} from '../../src/direct/sso12-packet-client';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const identity = { uin: 'fixture', sequence: 7 };
const response = { kind: 'response', sequence: 7, value: 'ok', writeState: 'written' } as const;

class FakeClient implements Sso12RawClient {
    readonly whenClosed = new Promise<Sso12CloseReason>(() => {});
    readonly close = vi.fn();
    readonly pending = deferred<Sso12RawResult<unknown>>();
    readonly receivers: unknown[] = [];
    seen?: Sso12RawOptions<number, string>;
    settled = false;

    transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        this.receivers.push(this);
        this.seen = options as unknown as Sso12RawOptions<number, string>;
        return this.pending.promise as Promise<Sso12RawResult<T>>;
    }

    settleSuccess(): void {
        // Resolve the exact promise returned to the broker before enabling the commit gate.
        this.pending.resolve(response);
        this.settled = true;
    }
}

const options = (): Sso12RawOptions<number, string> => ({
    timeoutMs: 5000,
    buildRequest: () => ({ frame: Uint8Array.of(1), context: 42 }),
    verifyCandidate: (candidate, context, info) =>
        candidate[0] === 2 && context === 42 && info.sequence === identity.sequence,
    consumeCandidate: () => 'ok',
});

async function exerciseCallbacks(client: FakeClient): Promise<void> {
    expect(client.seen).toBeDefined();
    const callbacks = client.seen!;
    const request = await callbacks.buildRequest(identity);
    expect(request).toEqual({ frame: Uint8Array.of(1), context: 42 });
    const candidate = Uint8Array.of(2);
    expect(await callbacks.verifyCandidate(candidate, request.context, identity)).toBe(true);
    expect(await callbacks.consumeCandidate(candidate, request.context, identity)).toBe('ok');
}

describe('raw session broker success commit reentry: in-memory client', () => {
    it.each(['poison', 'session abort'] as const)(
        'does not commit success when the second armed clock causes %s',
        async (effect) => {
            const controller = new AbortController();
            const client = new FakeClient();
            let lease: RawSessionLease | undefined;
            let armed = false;
            let armedCalls = 0;
            let triggered = false;
            const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
                if (armed && !triggered) {
                    armedCalls++;

                    if (armedCalls === 2) {
                        // Disarm before reentry: poison/abort cleanup may itself read the clock.
                        triggered = true;

                        if (effect === 'poison') {
                            lease!.poison();
                        } else {
                            controller.abort();
                        }
                    }
                }

                // Both session and operation deadlines remain in the future.
                return 1000;
            });

            try {
                const broker = createRawSessionBroker(client, {
                    trustedSuccessQuiescence: true,
                    isUsable: () => {
                        // Exact armed event: the first isUsable invocation after the
                        // fake's underlying success promise has already been resolved.
                        if (client.settled && !armed) {
                            armed = true;
                        }

                        return true;
                    },
                });
                lease = broker.acquire({ deadline: 10_000, signal: controller.signal });
                const work = lease.transactRaw(options());
                await exerciseCallbacks(client);
                expect(client.receivers).toEqual([client]);
                expect(armed).toBe(false);
                client.settleSuccess();
                const result = await work;

                // If either assertion fails, the selected clock site was not reached;
                // that is a fixture/implementation-shape mismatch, not proof of the bug.
                expect(armed).toBe(true);
                expect(triggered).toBe(true);
                expect(armedCalls).toBe(2);
                expect(result).toMatchObject({ kind: 'failure', code: 'interrupted' });
                expect(result.kind).not.toBe('response');
                expect(await lease.whenClosed).toBe('poisoned');
                expect(client.close).toHaveBeenCalledTimes(1);
            } finally {
                triggered = true;
                lease?.close();
                clock.mockRestore();
            }
        },
    );

    it('commits a normal fake exchange with the original client receiver', async () => {
        const client = new FakeClient();
        let lease: RawSessionLease | undefined;
        const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);

        try {
            const broker = createRawSessionBroker(client, {
                trustedSuccessQuiescence: true,
                isUsable: () => true,
            });
            lease = broker.acquire({ deadline: 10_000 });
            const work = lease.transactRaw(options());
            await exerciseCallbacks(client);
            expect(client.receivers).toEqual([client]);
            client.settleSuccess();
            expect(await work).toEqual(response);
            lease.release();
            expect(await lease.whenClosed).toBe('released');
            expect(client.close).not.toHaveBeenCalled();
        } finally {
            lease?.close();
            clock.mockRestore();
        }
    });
});
