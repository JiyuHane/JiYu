import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

class Fake extends EventEmitter implements Sso12RawClient {
    resolveClosed!: (reason: Sso12CloseReason) => void;
    readonly whenClosed = new Promise<Sso12CloseReason>((resolve) => {
        this.resolveClosed = resolve;
    });
    readonly close = vi.fn(() => {
        this.emit('close');
    });
    operationSignal: AbortSignal | undefined;

    transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        this.operationSignal = options.signal;
        return new Promise(() => {});
    }
}

const config = () => ({ trustedSuccessQuiescence: true as const, isUsable: () => true });

const fixture = (signal?: AbortSignal, duration = 1000) => {
    const client = new Fake();
    const { broker, terminal } = createRawSessionBrokerInternal(client, config());
    const lease = broker.acquire({ deadline: performance.now() + duration, signal });
    return { client, broker, terminal, lease };
};

const options = (): Sso12RawOptions<number, string> => ({
    buildRequest: () => ({ frame: Uint8Array.of(1), context: 1 }),
    verifyCandidate: () => true,
    consumeCandidate: () => 'fixture',
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('raw session terminal provenance: synthetic fakes', () => {
    it('proves first owned poison once and keeps public terminal behavior', async () => {
        const { client, terminal, lease } = fixture();
        const proof = terminal.poison(lease);
        expect(proof).toBeDefined();
        expect(client.close).toHaveBeenCalledTimes(1);
        expect(await lease.whenClosed).toBe('poisoned');
        expect(terminal.poison(lease)).toBeUndefined();
        expect(terminal.consume(lease, proof)).toBe(true);
        expect(terminal.consume(lease, proof)).toBe(false);
        lease.poison();
        lease.release();
        expect(client.close).toHaveBeenCalledTimes(1);
    });

    it('burns proofs on cross-lease, cross-owner, and invalid-lease consumption', () => {
        const a = fixture();
        const b = fixture();
        const first = a.terminal.poison(a.lease);
        expect(a.terminal.consume(b.lease, first)).toBe(false);
        expect(a.terminal.consume(a.lease, first)).toBe(false);
        const second = b.terminal.poison(b.lease);
        expect(a.terminal.consume(b.lease, second)).toBe(false);
        expect(b.terminal.consume(b.lease, second)).toBe(false);
        const c = fixture();
        const third = c.terminal.poison(c.lease);
        expect(c.terminal.consume(null, third)).toBe(false);
        expect(c.terminal.consume(c.lease, third)).toBe(false);
        expect(a.client.close).toHaveBeenCalledTimes(1);
        expect(b.client.close).toHaveBeenCalledTimes(1);
        expect(c.client.close).toHaveBeenCalledTimes(1);
    });

    it('rejects foreign leases and proofs without invoking getters or proxy traps', async () => {
        const a = fixture();
        const traps = vi.fn(() => {
            throw Error('unexpected trap');
        });
        const foreign = new Proxy({}, { get: traps, getPrototypeOf: traps, ownKeys: traps });
        const foreignProof = new Proxy({}, { get: traps, getPrototypeOf: traps, ownKeys: traps });
        expect(a.terminal.poison(foreign)).toBeUndefined();
        expect(a.terminal.poison(null)).toBeUndefined();
        expect(a.terminal.consume(foreign, foreignProof)).toBe(false);
        expect(traps).not.toHaveBeenCalled();
        expect(a.client.close).not.toHaveBeenCalled();
        const ordinary = new Fake();
        const old = createRawSessionBroker(ordinary, config()).acquire({
            deadline: performance.now() + 1000,
        });
        expect(a.terminal.poison(old)).toBeUndefined();
        expect(ordinary.close).not.toHaveBeenCalled();
        old.release();
        a.lease.release();
        expect(await old.whenClosed).toBe('released');
        expect(await a.lease.whenClosed).toBe('released');
    });

    it.each(['poison', 'close', 'release'] as const)(
        'ordinary %s wins without manufacturing owned proof',
        async (method) => {
            const { client, terminal, lease } = fixture();
            lease[method]();
            expect(terminal.poison(lease)).toBeUndefined();
            expect(await lease.whenClosed).toBe(method === 'release' ? 'released' : 'poisoned');
            expect(client.close).toHaveBeenCalledTimes(method === 'release' ? 0 : 1);
        },
    );

    it('proves only broker-local ordering when client close resolves before observation', async () => {
        const a = fixture();
        a.client.resolveClosed({ kind: 'remote', code: 'fixture' });

        // Promise observation has not run yet, despite the earlier local resolution.
        const proof = a.terminal.poison(a.lease);
        expect(proof).toBeDefined();
        expect(a.terminal.consume(a.lease, proof)).toBe(true);
        expect(await a.lease.whenClosed).toBe('poisoned');
        await Promise.resolve();
        await Promise.resolve();
        expect(a.terminal.poison(a.lease)).toBeUndefined();
        expect(a.client.close).toHaveBeenCalledTimes(1);
    });

    it('fails after abort or timeout wins first', async () => {
        vi.useFakeTimers();
        const abort = new AbortController();
        const a = fixture(abort.signal);
        abort.abort();
        expect(a.terminal.poison(a.lease)).toBeUndefined();
        expect(await a.lease.whenClosed).toBe('poisoned');
        const b = fixture(undefined, 50);
        vi.advanceTimersByTime(50);
        expect(b.terminal.poison(b.lease)).toBeUndefined();
        expect(await b.lease.whenClosed).toBe('poisoned');
        expect(a.client.close).toHaveBeenCalledTimes(1);
        expect(b.client.close).toHaveBeenCalledTimes(1);
    });

    it('checks deadline before claim even if timeout callback has not run', () => {
        const now = vi.spyOn(performance, 'now').mockReturnValue(100);
        const a = fixture(undefined, 50);
        now.mockReturnValue(150);
        expect(a.terminal.poison(a.lease)).toBeUndefined();
        expect(a.client.close).not.toHaveBeenCalled();
        now.mockReturnValue(100);
        a.lease.release();
    });

    it('burns proof when deadline passes or original signal aborts during cleanup', () => {
        const now = vi.spyOn(performance, 'now').mockReturnValue(100);
        const a = fixture(undefined, 50);
        a.client.on('close', () => now.mockReturnValue(150));
        const proofA = a.terminal.poison(a.lease);
        expect(proofA).toBeDefined();
        expect(a.terminal.consume(a.lease, proofA)).toBe(false);
        now.mockReturnValue(100);
        expect(a.terminal.consume(a.lease, proofA)).toBe(false);

        const abort = new AbortController();
        const b = fixture(abort.signal);
        b.client.on('close', () => abort.abort());
        const proofB = b.terminal.poison(b.lease);
        expect(proofB).toBeDefined();
        expect(b.terminal.consume(b.lease, proofB)).toBe(false);
        expect(b.terminal.consume(b.lease, proofB)).toBe(false);
    });

    it('keeps provenance despite a throwing client cleanup', async () => {
        const a = fixture();
        a.client.close.mockImplementation(() => {
            throw Error('fixture secret');
        });
        const proof = a.terminal.poison(a.lease);
        expect(a.terminal.consume(a.lease, proof)).toBe(true);
        expect(await a.lease.whenClosed).toBe('poisoned');
        expect(a.client.close).toHaveBeenCalledTimes(1);
    });

    it('linearizes before synchronous operation-abort and client-close reentry', async () => {
        const a = fixture();
        const work = a.lease.transactRaw(options());
        const attempts: unknown[] = [];
        a.client.operationSignal!.addEventListener('abort', () => {
            attempts.push(a.terminal.poison(a.lease));
            a.lease.poison();
        });
        a.client.on('close', () => {
            attempts.push(a.terminal.poison(a.lease));
            a.lease.release();
        });
        const proof = a.terminal.poison(a.lease);
        expect(attempts).toEqual([undefined, undefined]);
        expect(a.terminal.consume(a.lease, proof)).toBe(true);
        expect(await work).toMatchObject({ kind: 'failure', writeState: 'unknown' });
        expect(await a.lease.whenClosed).toBe('poisoned');
        expect(a.client.close).toHaveBeenCalledTimes(1);
    });

    it('rechecks terminal after reentry during the clock read', () => {
        const a = fixture();
        const now = performance.now();
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
            clock.mockReturnValue(now);
            a.lease.poison();
            return now;
        });
        expect(a.terminal.poison(a.lease)).toBeUndefined();
        expect(a.client.close).toHaveBeenCalledTimes(1);
    });

    it('burns before reentrant consume and fences signal after clock reentry', () => {
        const abort = new AbortController();
        const a = fixture(abort.signal);
        const proof = a.terminal.poison(a.lease);
        const now = performance.now();
        let nested: boolean | undefined;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
            clock.mockReturnValue(now);
            nested = a.terminal.consume(a.lease, proof);
            abort.abort();
            return now;
        });
        expect(a.terminal.consume(a.lease, proof)).toBe(false);
        expect(nested).toBe(false);
        expect(a.terminal.consume(a.lease, proof)).toBe(false);
    });
});
