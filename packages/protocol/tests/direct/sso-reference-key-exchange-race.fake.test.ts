import { createECDH } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { KEY_EXCHANGE_COMMAND } from '../../src/direct/key-exchange-flow';
import { qqTeaEncrypt } from '../../src/direct/qq-tea';
import { referenceKeyExchangeOnTransport } from '../../src/direct/sso-reference-key-exchange-flow';
import type {
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';

// All peers, policy callbacks and transport events are synthetic, in-process fixtures.
const uin = '123456';
const sequence = 123;
const identity = { uin, sequence };

type Options = Parameters<typeof referenceKeyExchangeOnTransport>[1];

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function config(): Options {
    const server = createECDH('prime256v1');
    const secret = Buffer.alloc(32);
    secret[31] = 1;
    server.setPrivateKey(secret);
    return {
        uin,
        guid: Uint8Array.from({ length: 16 }, (_, i) => i + 1),
        version: 'synthetic-version',
        subAppId: 42,
        a2: Uint8Array.of(7, 8),
        serverPublicKey: Uint8Array.from(server.getPublicKey()),
        verifyKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
        timestamp: 1700000000,
        buildReserved: () => Uint8Array.of(3),
        verifyRaw: () => true,
        verifyServerResponse: () => true,
        timeoutMs: 3000,
    };
}

function word(n: number): Buffer {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(n >>> 0);
    return result;
}

function field(data: Uint8Array): Buffer {
    return Buffer.concat([word(data.length + 4), data]);
}

// A well-formed synthetic envelope is sufficient: verifyRaw is intentionally
// suspended before any response interpretation or server-key verification.
function candidate(): Uint8Array {
    const header = Buffer.concat([
        word(sequence),
        word(0),
        field(Buffer.alloc(0)),
        field(Buffer.from(KEY_EXCHANGE_COMMAND)),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    const body = Buffer.concat([field(header), field(Buffer.alloc(0))]);
    const encrypted = qqTeaEncrypt(body, new Uint8Array(16));
    const account = Buffer.from(uin);
    return Buffer.concat([
        word(14 + account.length + encrypted.length),
        word(12),
        Buffer.of(2, 0),
        field(account),
        encrypted,
    ]);
}

// The fake owner is deliberately independent of timeout and AbortSignal. Its
// returned promise stays pending until the test explicitly supplies a result.
// Only fake writes and callback invocations are counted; no I/O takes place.
class DeferredTransport implements Sso12RawTransport {
    readonly result = deferred<Sso12RawResult<never>>();
    readonly workerDone = deferred<void>();
    readonly candidate = candidate();
    calls = 0;
    writes = 0;
    verifies = 0;
    consumes = 0;
    workerOutcome: 'finished' | 'rejected' | undefined;

    transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        this.calls++;

        const work = async () => {
            try {
                const built = await raw.buildRequest(identity);
                this.writes++;
                this.verifies++;
                const accepted = await raw.verifyCandidate(this.candidate, built.context, identity);

                if (accepted) {
                    this.consumes++;
                    await raw.consumeCandidate(this.candidate, built.context, identity);
                }

                this.workerOutcome = 'finished';
            } catch {
                this.workerOutcome = 'rejected';
            } finally {
                this.workerDone.resolve();
            }
        };

        void work();
        return this.result.promise;
    }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('synthetic fixture watchdog')), 2000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function expectCleared(bytes: Uint8Array): void {
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
}

function eventCounts(fake: DeferredTransport) {
    return [fake.calls, fake.writes, fake.verifies, fake.consumes];
}

describe('reference key exchange local stop races (synthetic only)', () => {
    it.each(['abort', 'timeout', 'early transport failure'] as const)(
        'revokes a pending signer after %s and never submits its late result',
        async (mode) => {
            const fake = new DeferredTransport();
            const entered = deferred<void>();
            const signer = deferred<Uint8Array>();
            const controller = new AbortController();
            const options = config();
            options.signal = controller.signal;
            options.timeoutMs = mode === 'timeout' ? 150 : 3000;
            let borrowed!: Uint8Array;
            const callerInputs = [
                options.guid,
                options.a2!,
                options.serverPublicKey,
                options.verifyKey,
            ];
            const snapshots = callerInputs.map((bytes) => Uint8Array.from(bytes));
            const ownedReserved = Uint8Array.of(0xa1, 0xb2, 0xc3);
            options.buildReserved = vi.fn((input) => {
                expect(input).toMatchObject({ uin, sequence, command: KEY_EXCHANGE_COMMAND });
                borrowed = input.body;
                entered.resolve();
                return signer.promise;
            });
            options.verifyRaw = vi.fn(() => true);
            options.verifyServerResponse = vi.fn(() => true);
            const pending = referenceKeyExchangeOnTransport(fake, options);
            // Observe both branches immediately, even if a later assertion fails.
            void pending.then(
                () => {},
                () => {},
            );

            try {
                await bounded(entered.promise);
                expect(borrowed.length).toBeGreaterThan(0);
                expect(borrowed.some((byte) => byte !== 0)).toBe(true);

                if (mode === 'abort') {
                    controller.abort();
                } else if (mode === 'early transport failure') {
                    fake.result.resolve({
                        kind: 'failure',
                        code: 'synthetic-secret',
                        writeState: 'unknown',
                    });
                }

                const result = await bounded(pending);
                expect(result).toMatchObject({ kind: 'failure', writeState: 'unknown' });
                expect(JSON.stringify(result)).not.toContain('synthetic-secret');
                expectCleared(borrowed);
                expect(eventCounts(fake)).toEqual([1, 0, 0, 0]);
                callerInputs.forEach((bytes, index) => expect(bytes).toEqual(snapshots[index]));
                const before = eventCounts(fake);
                signer.resolve(ownedReserved);
                await bounded(fake.workerDone.promise);
                expect(fake.workerOutcome).toBe('rejected');
                expect(eventCounts(fake)).toEqual(before);
                expect(options.buildReserved).toHaveBeenCalledOnce();
                expect(options.verifyRaw).not.toHaveBeenCalled();
                expect(options.verifyServerResponse).not.toHaveBeenCalled();
                expect(ownedReserved).toEqual(Uint8Array.of(0xa1, 0xb2, 0xc3));
                expectCleared(borrowed);
            } finally {
                signer.resolve(ownedReserved);
            }
        },
    );

    it('clears both verifier borrows on abort and ignores late true', async () => {
        const fake = new DeferredTransport();
        const entered = deferred<void>();
        const verifier = deferred<boolean>();
        const controller = new AbortController();
        const options = config();
        options.signal = controller.signal;
        options.verifyServerResponse = vi.fn(() => true);
        let request!: Uint8Array;
        let response!: Uint8Array;
        options.verifyRaw = vi.fn((input) => {
            expect(input).toMatchObject({ uin, sequence, command: KEY_EXCHANGE_COMMAND });
            request = input.requestFrame;
            response = input.responseFrame;
            entered.resolve();
            return verifier.promise;
        });
        const pending = referenceKeyExchangeOnTransport(fake, options);
        void pending.then(
            () => {},
            () => {},
        );

        try {
            await bounded(entered.promise);
            expect(request.length).toBeGreaterThan(0);
            expect(response.length).toBeGreaterThan(0);
            expect(request.some((byte) => byte !== 0)).toBe(true);
            expect(response.some((byte) => byte !== 0)).toBe(true);
            controller.abort();
            const result = await bounded(pending);
            expect(result).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            expectCleared(request);
            expectCleared(response);
            expect(eventCounts(fake)).toEqual([1, 1, 1, 0]);
            const before = eventCounts(fake);
            verifier.resolve(true);
            await bounded(fake.workerDone.promise);
            expect(eventCounts(fake)).toEqual(before);
            expect(options.verifyRaw).toHaveBeenCalledOnce();
            expect(options.verifyServerResponse).not.toHaveBeenCalled();
            expectCleared(request);
            expectCleared(response);
        } finally {
            verifier.resolve(true);
        }
    });

    it('observes a late signer rejection after abort without retry or result leakage', async () => {
        const fake = new DeferredTransport();
        const entered = deferred<void>();
        const signer = deferred<Uint8Array>();
        const controller = new AbortController();
        const options = config();
        options.signal = controller.signal;
        let body!: Uint8Array;

        options.buildReserved = ({ body: value }) => {
            body = value;
            entered.resolve();
            return signer.promise;
        };

        const pending = referenceKeyExchangeOnTransport(fake, options);
        void pending.then(
            () => {},
            () => {},
        );

        try {
            await bounded(entered.promise);
            controller.abort();
            const result = await bounded(pending);
            expect(result).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            expectCleared(body);
            signer.reject(new Error('late-synthetic-secret'));
            await bounded(fake.workerDone.promise);
            expect(fake.workerOutcome).toBe('rejected');
            expect(eventCounts(fake)).toEqual([1, 0, 0, 0]);
            // The independently owned transport may settle much later as well.
            // Its rejection must also be observed without changing the result.
            fake.result.reject(new Error('late-transport-secret'));
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(eventCounts(fake)).toEqual([1, 0, 0, 0]);
            expect(JSON.stringify(result)).not.toContain('late-synthetic-secret');
            expect(JSON.stringify(result)).not.toContain('late-transport-secret');
        } finally {
            signer.resolve(Uint8Array.of(1));
        }
    });

    it('does not invoke transport for a pre-aborted signal', async () => {
        const fake = new DeferredTransport();
        const controller = new AbortController();
        controller.abort();
        const options = config();
        options.signal = controller.signal;
        options.buildReserved = vi.fn(options.buildReserved);
        options.verifyRaw = vi.fn(options.verifyRaw);
        const result = await bounded(referenceKeyExchangeOnTransport(fake, options));
        expect(result).toMatchObject({ kind: 'failure', writeState: 'not-written' });
        expect(eventCounts(fake)).toEqual([0, 0, 0, 0]);
        expect(options.buildReserved).not.toHaveBeenCalled();
        expect(options.verifyRaw).not.toHaveBeenCalled();
    });
});
