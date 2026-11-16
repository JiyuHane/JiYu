import { describe, expect, it, vi } from 'vitest';
import { createRawSessionBroker, type RawSessionLease } from '../../src/direct/raw-session-broker';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
} from '../../src/direct/sso12-packet-client';

const identity = { uin: 'fixture', sequence: 7 };
const response = { kind: 'response', sequence: 7, value: 'ok', writeState: 'written' } as const;

class FakeClient implements Sso12RawClient {
    resolveClosed!: (reason: Sso12CloseReason) => void;
    readonly whenClosed = new Promise<Sso12CloseReason>((resolve) => {
        this.resolveClosed = resolve;
    });
    readonly close = vi.fn();
    readonly getter = vi.fn();
    effect: () => void = () => {};
    readonly returnedMethod = vi.fn(async function (
        this: FakeClient,
        options: Sso12RawOptions<number, string>,
    ) {
        const request = await options.buildRequest(identity);
        const candidate = Uint8Array.of(2);
        const matches = await options.verifyCandidate(candidate, request.context, identity);

        if (!matches) {
            throw new Error('fixture mismatch');
        }

        const value = await options.consumeCandidate(candidate, request.context, identity);
        return {
            kind: 'response' as const,
            sequence: identity.sequence,
            value,
            writeState: 'written' as const,
        };
    });

    get transactRaw(): Sso12RawClient['transactRaw'] {
        this.getter();
        this.effect();
        return this.returnedMethod as Sso12RawClient['transactRaw'];
    }
}

const options = (
    extra: Partial<Sso12RawOptions<number, string>> = {},
): Sso12RawOptions<number, string> => ({
    buildRequest: () => ({ frame: Uint8Array.of(1), context: 42 }),
    verifyCandidate: () => true,
    consumeCandidate: () => 'ok',
    ...extra,
});

const fixture = (signal?: AbortSignal, deadline = performance.now() + 10_000) => {
    const client = new FakeClient();
    const broker = createRawSessionBroker(client, {
        trustedSuccessQuiescence: true,
        isUsable: () => true,
    });
    const lease = broker.acquire({ deadline, signal });
    return { client, broker, lease };
};

function cleanup(client: FakeClient, lease: RawSessionLease): void {
    lease.release();
    client.resolveClosed({ kind: 'local', code: 'fixture-cleanup' });
}

describe('raw session broker transactRaw getter reentry: pure fakes', () => {
    it.each(['poison', 'session abort', 'operation abort'] as const)(
        'does not invoke the returned method after getter triggers %s',
        async (mode) => {
            const session = new AbortController();
            const operation = new AbortController();
            const { client, lease } = fixture(session.signal);

            try {
                client.effect = () => {
                    if (mode === 'poison') {
                        lease.poison();
                    } else if (mode === 'session abort') {
                        session.abort();
                    } else {
                        operation.abort();
                    }
                };

                const result = await lease.transactRaw(options({ signal: operation.signal }));
                expect(client.getter).toHaveBeenCalledTimes(1);
                expect(client.returnedMethod).not.toHaveBeenCalled();
                expect(result).toMatchObject({
                    kind: 'failure',
                    code: 'interrupted',
                    writeState: 'unknown',
                });
                expect(await lease.whenClosed).toBe('poisoned');
                expect(client.close).toHaveBeenCalledTimes(1);
            } finally {
                cleanup(client, lease);
            }
        },
    );

    it.each(['session', 'operation'] as const)(
        'does not invoke the returned method after getter passes the %s deadline',
        async (mode) => {
            const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
            let client: FakeClient | undefined;
            let lease: RawSessionLease | undefined;

            try {
                ({ client, lease } = fixture(undefined, 2000));
                client.effect = () => clock.mockReturnValue(mode === 'session' ? 2001 : 1021);
                // All clock substitution and the getter run synchronously before this returns.
                const pending = lease.transactRaw(options({ timeoutMs: 20 }));
                clock.mockRestore();
                const result = await pending;
                expect(client.getter).toHaveBeenCalledTimes(1);
                expect(client.returnedMethod).not.toHaveBeenCalled();
                expect(result).toMatchObject({
                    kind: 'failure',
                    code: 'interrupted',
                    writeState: 'unknown',
                });
                expect(await lease.whenClosed).toBe('poisoned');
                expect(client.close).toHaveBeenCalledTimes(1);
            } finally {
                clock.mockRestore();

                if (client && lease) {
                    cleanup(client, lease);
                }
            }
        },
    );

    it('sanitizes a throwing getter and retires the lease without invoking its method', async () => {
        const { client, lease } = fixture();

        try {
            client.effect = () => {
                throw new Error('getter fixture secret');
            };

            const result = await lease.transactRaw(options());
            expect(client.getter).toHaveBeenCalledTimes(1);
            expect(client.returnedMethod).not.toHaveBeenCalled();
            expect(result).toEqual({
                kind: 'failure',
                code: 'transport-failed',
                writeState: 'unknown',
            });
            expect(JSON.stringify(result)).not.toContain('getter fixture secret');
            expect(await lease.whenClosed).toBe('poisoned');
            expect(client.close).toHaveBeenCalledTimes(1);
        } finally {
            cleanup(client, lease);
        }
    });

    it('preserves claim and busy ordering, receiver, callbacks and serial successes', async () => {
        const { client, broker, lease } = fixture();
        const events: string[] = [];
        let nested: ReturnType<RawSessionLease['transactRaw']> | undefined;

        try {
            client.effect = () => {
                events.push('getter');
                expect(() => broker.acquire({ deadline: performance.now() + 1000 })).toThrow();
                nested = lease.transactRaw(options());
            };

            const request = options({
                buildRequest: (value) => {
                    expect(value).toEqual(identity);
                    events.push('build');
                    return { frame: Uint8Array.of(1), context: 42 };
                },
                verifyCandidate: (candidate, context, value) => {
                    expect(candidate).toEqual(Uint8Array.of(2));
                    expect(context).toBe(42);
                    expect(value).toEqual(identity);
                    events.push('verify');
                    return true;
                },
                consumeCandidate: (candidate, context, value) => {
                    expect(candidate).toEqual(Uint8Array.of(2));
                    expect(context).toBe(42);
                    expect(value).toEqual(identity);
                    events.push('consume');
                    return 'ok';
                },
            });
            expect(await lease.transactRaw(request)).toEqual(response);
            expect(await nested).toEqual({
                kind: 'failure',
                code: 'busy',
                writeState: 'not-written',
            });
            expect(events).toEqual(['getter', 'build', 'verify', 'consume']);
            expect(client.returnedMethod).toHaveBeenCalledTimes(1);
            expect(client.returnedMethod.mock.contexts[0]).toBe(client);

            client.effect = () => {};

            expect(await lease.transactRaw(options())).toEqual(response);
            expect(client.getter).toHaveBeenCalledTimes(2);
            expect(client.returnedMethod).toHaveBeenCalledTimes(2);
            expect(client.returnedMethod.mock.contexts[1]).toBe(client);
            lease.release();
            expect(await lease.whenClosed).toBe('released');
            expect(client.close).not.toHaveBeenCalled();
            expect(() => broker.acquire({ deadline: performance.now() + 1000 })).toThrow();
        } finally {
            cleanup(client, lease);
        }
    });
});
