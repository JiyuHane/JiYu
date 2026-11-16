import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createLinuxEasyKeyCapability,
    linuxEasyKeyState,
    revokeLinuxEasyKey,
    stageLinuxEasyKey,
} from '../../src/direct/linux-easy-key-capability';
import {
    createRawSessionBroker,
    createRawSessionBrokerInternal,
} from '../../src/direct/raw-session-broker';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
} from '../../src/direct/sso12-packet-client';

// Entirely synthetic, in memory: no network transport, account, or signer.
const UIN = '123456';
const OTHER_UIN = '234567';
const SEQUENCE = 42;
const config = () => ({ trustedSuccessQuiescence: true as const, isUsable: () => true });

class FakeClient implements Sso12RawClient {
    resolveClosed!: (reason: Sso12CloseReason) => void;
    rejectClosed!: (reason: unknown) => void;
    readonly whenClosed = new Promise<Sso12CloseReason>((resolve, reject) => {
        this.resolveClosed = resolve;
        this.rejectClosed = reject;
    });
    readonly close = vi.fn();
    operationSignal: AbortSignal | undefined;

    transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        this.operationSignal = options.signal;
        return new Promise(() => {});
    }
}

const options = (signal?: AbortSignal): Sso12RawOptions<number, string> => ({
    buildRequest: () => ({ frame: Uint8Array.of(1), context: 1 }),
    verifyCandidate: () => true,
    consumeCandidate: () => 'synthetic',
    signal,
});

function fixture(signal?: AbortSignal, duration = 1000) {
    const client = new FakeClient();
    const { broker, terminal, keyBinding } = createRawSessionBrokerInternal(client, config());
    const lease = broker.acquire({ deadline: performance.now() + duration, signal });
    const token = createLinuxEasyKeyCapability({ lease, uin: UIN, generation: {} });
    return { client, broker, terminal, keyBinding, lease, token };
}

function stage(f: ReturnType<typeof fixture>) {
    const key = Uint8Array.from({ length: 16 }, (_, index) => index + 1);

    try {
        stageLinuxEasyKey({ token: f.token, lease: f.lease, uin: UIN, sequence: SEQUENCE, key });
        expect(linuxEasyKeyState(f.token)).toBe('tentative');
    } finally {
        // The capability owns its copy; the caller owns these fixture bytes.
        key.fill(0);
    }
}

function bindAndStage(f: ReturnType<typeof fixture>) {
    expect(linuxEasyKeyState(f.token)).toBe('empty');
    expect(f.keyBinding.bind(f.lease, f.token, UIN)).toBe(true);
    stage(f);
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('raw session key binding: synthetic in-memory fakes', () => {
    it.each(['poison', 'close', 'release'] as const)(
        'revokes before synchronous cleanup on lease.%s',
        async (method) => {
            const f = fixture();
            bindAndStage(f);
            const observations: string[] = [];
            let secondProof: unknown = 'not called';
            f.client.close.mockImplementation(() => {
                observations.push(linuxEasyKeyState(f.token));
                secondProof = f.terminal.poison(f.lease);
                f.lease.release();
            });
            f.lease[method]();
            expect(linuxEasyKeyState(f.token)).toBe('revoked');
            expect(await f.lease.whenClosed).toBe(method === 'release' ? 'released' : 'poisoned');
            expect(f.client.close).toHaveBeenCalledTimes(method === 'release' ? 0 : 1);

            if (method !== 'release') {
                expect(observations).toEqual(['revoked']);
                expect(secondProof).toBeUndefined();
            }

            expect(f.keyBinding.bind(f.lease, f.token, UIN)).toBe(false);
            expect(f.terminal.poison(f.lease)).toBeUndefined();
        },
    );

    it('records terminal proof and revokes before operation abort and client close reentry', async () => {
        const f = fixture();
        bindAndStage(f);
        const work = f.lease.transactRaw(options());
        const seen: string[] = [];
        const nested: unknown[] = [];
        expect(f.client.operationSignal).toBeDefined();
        f.client.operationSignal!.addEventListener('abort', () => {
            seen.push(`abort:${linuxEasyKeyState(f.token)}`);
            nested.push(f.terminal.poison(f.lease));
            f.lease.close();
        });
        f.client.close.mockImplementation(() => {
            seen.push(`close:${linuxEasyKeyState(f.token)}`);
            nested.push(f.terminal.poison(f.lease));
        });
        const proof = f.terminal.poison(f.lease);
        expect(proof).toBeDefined();
        expect(seen).toEqual(['abort:revoked', 'close:revoked']);
        expect(nested).toEqual([undefined, undefined]);
        expect(f.terminal.consume(f.lease, proof)).toBe(true);
        expect(f.terminal.consume(f.lease, proof)).toBe(false);
        expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
        expect(await f.lease.whenClosed).toBe('poisoned');
        expect(f.client.close).toHaveBeenCalledTimes(1);
    });

    it.each(['operation-abort', 'session-abort', 'timer', 'operation-timer'] as const)(
        'revokes before operation and close callbacks on %s',
        async (mode) => {
            vi.useFakeTimers();
            const sessionAbort = new AbortController();
            const operationAbort = new AbortController();
            const f = fixture(sessionAbort.signal, mode === 'timer' ? 50 : 1000);
            bindAndStage(f);
            const work = f.lease.transactRaw({
                ...options(operationAbort.signal),
                timeoutMs: mode === 'operation-timer' ? 50 : 1000,
            });
            const seen: string[] = [];
            expect(f.client.operationSignal).toBeDefined();
            f.client.operationSignal!.addEventListener('abort', () => {
                seen.push(`abort:${linuxEasyKeyState(f.token)}`);
            });
            f.client.close.mockImplementation(() => {
                seen.push(`close:${linuxEasyKeyState(f.token)}`);
            });

            if (mode === 'operation-abort') {
                operationAbort.abort();
            } else if (mode === 'session-abort') {
                sessionAbort.abort();
            } else {
                vi.advanceTimersByTime(50);
            }

            expect(seen).toEqual(['abort:revoked', 'close:revoked']);
            expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            expect(await f.lease.whenClosed).toBe('poisoned');
            expect(f.terminal.poison(f.lease)).toBeUndefined();
            expect(f.client.close).toHaveBeenCalledTimes(1);
        },
    );

    it.each(['resolve', 'reject'] as const)(
        'revokes during asynchronous genuine whenClosed %s observation',
        async (mode) => {
            const f = fixture();
            bindAndStage(f);
            const work = f.lease.transactRaw(options());
            const seen: string[] = [];
            f.client.operationSignal!.addEventListener('abort', () => {
                seen.push(`abort:${linuxEasyKeyState(f.token)}`);
            });
            f.client.close.mockImplementation(() => {
                seen.push(`close:${linuxEasyKeyState(f.token)}`);
            });

            if (mode === 'resolve') {
                f.client.resolveClosed({ kind: 'remote', code: 'synthetic' });
            } else {
                f.client.rejectClosed(new Error('synthetic'));
            }

            // Promise settlement itself is synchronous, broker observation is not.
            expect(linuxEasyKeyState(f.token)).toBe('tentative');
            expect(seen).toEqual([]);
            expect(await f.lease.whenClosed).toBe('poisoned');
            expect(seen).toEqual(['abort:revoked', 'close:revoked']);
            expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            expect(f.terminal.poison(f.lease)).toBeUndefined();
        },
    );

    it('rejects wrong lease, account, broker, forged identities and proxies without effects', () => {
        const a = fixture();
        const b = fixture();
        const traps = vi.fn(() => {
            throw new Error('unexpected proxy trap');
        });
        const proxy = new Proxy(
            {},
            {
                get: traps,
                getPrototypeOf: traps,
                ownKeys: traps,
                getOwnPropertyDescriptor: traps,
            },
        );
        const accessor = Object.defineProperty({}, 'value', { get: traps });
        expect(a.keyBinding.bind(a.lease, a.token, OTHER_UIN)).toBe(false);
        expect(a.keyBinding.bind(b.lease, a.token, UIN)).toBe(false);
        expect(a.keyBinding.bind(a.lease, b.token, UIN)).toBe(false);
        expect(b.keyBinding.bind(a.lease, a.token, UIN)).toBe(false);
        expect(a.keyBinding.bind(a.lease, {}, UIN)).toBe(false);
        expect(a.keyBinding.bind(proxy, a.token, UIN)).toBe(false);
        expect(a.keyBinding.bind(a.lease, proxy, UIN)).toBe(false);
        expect(a.keyBinding.bind(a.lease, a.token, proxy)).toBe(false);
        expect(a.keyBinding.bind(accessor, a.token, UIN)).toBe(false);
        expect(a.keyBinding.bind(a.lease, accessor, UIN)).toBe(false);
        expect(traps).not.toHaveBeenCalled();
        expect(linuxEasyKeyState(a.token)).toBe('empty');
        expect(linuxEasyKeyState(b.token)).toBe('empty');
        expect(a.keyBinding.bind(a.lease, a.token, UIN)).toBe(true);
        expect(b.keyBinding.bind(b.lease, b.token, UIN)).toBe(true);
        stage(a);
        stage(b);
        a.lease.poison();
        expect(linuxEasyKeyState(a.token)).toBe('revoked');
        expect(linuxEasyKeyState(b.token)).toBe('tentative');
        b.lease.release();
        expect(linuxEasyKeyState(b.token)).toBe('revoked');
    });

    it('does not bind a revoked or non-empty token, and failed attempts do not reserve a lease', () => {
        const revoked = fixture();
        revokeLinuxEasyKey(revoked.token);
        expect(revoked.keyBinding.bind(revoked.lease, revoked.token, UIN)).toBe(false);
        revoked.lease.release();
        expect(linuxEasyKeyState(revoked.token)).toBe('revoked');

        const staged = fixture();
        stage(staged);
        expect(staged.keyBinding.bind(staged.lease, staged.token, UIN)).toBe(false);
        staged.lease.poison();
        expect(linuxEasyKeyState(staged.token)).toBe('tentative');
        revokeLinuxEasyKey(staged.token);
    });

    it('binds only once and never revokes an unrelated token after a rejected bind', () => {
        const a = fixture();
        const b = fixture();
        expect(a.keyBinding.bind(a.lease, a.token, UIN)).toBe(true);
        expect(a.keyBinding.bind(a.lease, a.token, UIN)).toBe(false);
        expect(a.keyBinding.bind(a.lease, b.token, UIN)).toBe(false);
        stage(a);
        stage(b);
        a.lease.close();
        expect(linuxEasyKeyState(a.token)).toBe('revoked');
        expect(linuxEasyKeyState(b.token)).toBe('tentative');
        b.lease.release();
        expect(linuxEasyKeyState(b.token)).toBe('tentative');
        revokeLinuxEasyKey(b.token);
    });

    it('rejects an expired deadline without claiming or revoking the token', () => {
        const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
        const f = fixture(undefined, 50);

        try {
            clock.mockReturnValue(150);
            expect(f.keyBinding.bind(f.lease, f.token, UIN)).toBe(false);
            expect(linuxEasyKeyState(f.token)).toBe('empty');
            expect(f.client.close).not.toHaveBeenCalled();
        } finally {
            clock.mockReturnValue(100);
            f.lease.release();
            clock.mockRestore();
            revokeLinuxEasyKey(f.token);
        }
    });

    it('rechecks binding after clock reentry terminates or revokes the candidate', () => {
        for (const action of ['terminate', 'revoke'] as const) {
            const f = fixture();
            const now = performance.now();
            const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
                clock.mockReturnValue(now);

                if (action === 'terminate') {
                    f.lease.poison();
                } else {
                    revokeLinuxEasyKey(f.token);
                }

                return now;
            });

            try {
                expect(f.keyBinding.bind(f.lease, f.token, UIN)).toBe(false);
                expect(clock).toHaveBeenCalled();
                expect(linuxEasyKeyState(f.token)).toBe(
                    action === 'terminate' ? 'empty' : 'revoked',
                );
            } finally {
                clock.mockRestore();
                f.lease.release();
                revokeLinuxEasyKey(f.token);
            }
        }
    });

    it('lets only the nested binding win when the clock reenters bind', () => {
        const f = fixture();
        const now = performance.now();
        let nested: boolean | undefined;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
            clock.mockReturnValue(now);
            nested = f.keyBinding.bind(f.lease, f.token, UIN);
            return now;
        });

        try {
            expect(f.keyBinding.bind(f.lease, f.token, UIN)).toBe(false);
            expect(nested).toBe(true);
            expect(clock).toHaveBeenCalled();
        } finally {
            clock.mockRestore();
        }

        stage(f);
        f.lease.poison();
        expect(linuxEasyKeyState(f.token)).toBe('revoked');
    });

    it('rejects binding a lease terminated synchronously during acquire', async () => {
        const client = new FakeClient();
        const { broker, keyBinding } = createRawSessionBrokerInternal(client, {
            trustedSuccessQuiescence: true,
            isUsable: () => false,
        });
        const lease = broker.acquire({ deadline: performance.now() + 1000 });
        const token = createLinuxEasyKeyCapability({ lease, uin: UIN, generation: {} });
        expect(await lease.whenClosed).toBe('poisoned');
        expect(keyBinding.bind(lease, token, UIN)).toBe(false);
        expect(linuxEasyKeyState(token)).toBe('empty');
        expect(client.close).toHaveBeenCalledTimes(1);
        revokeLinuxEasyKey(token);
    });

    it('retains public broker configuration and terminal contract', async () => {
        const client = new FakeClient();
        expect(() =>
            createRawSessionBroker(client, {
                ...config(),
                trustedSuccessQuiescence: false,
            } as never),
        ).toThrow();
        const broker = createRawSessionBroker(client, config());
        expect(Object.keys(broker)).toEqual(['acquire']);
        const lease = broker.acquire({ deadline: performance.now() + 1000 });
        lease.release();
        expect(await lease.whenClosed).toBe('released');
        expect(client.close).not.toHaveBeenCalled();
    });
});
