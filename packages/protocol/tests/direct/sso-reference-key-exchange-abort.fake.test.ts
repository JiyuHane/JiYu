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

// In-memory fixture only: this transport does not create a socket or connection.
const uin = '123456';
const sequence = 123;
const identity = { uin, sequence };
type Options = Parameters<typeof referenceKeyExchangeOnTransport>[1];

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function config(signal: AbortSignal): Options {
    const peer = createECDH('prime256v1');
    const privateKey = Buffer.alloc(32);
    privateKey[31] = 1;
    peer.setPrivateKey(privateKey);
    return {
        uin,
        guid: Uint8Array.from({ length: 16 }, (_, i) => i + 1),
        version: 'synthetic-version',
        subAppId: 42,
        a2: Uint8Array.of(7, 8),
        serverPublicKey: Uint8Array.from(peer.getPublicKey()),
        verifyKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
        timestamp: 1700000000,
        buildReserved: () => Uint8Array.of(3),
        verifyRaw: () => true,
        verifyServerResponse: () => true,
        timeoutMs: 0x7fffffff,
        signal,
    };
}

function word(value: number): Buffer {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value >>> 0);
    return result;
}

function field(value: Uint8Array): Buffer {
    return Buffer.concat([word(value.length + 4), value]);
}

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
    const encrypted = qqTeaEncrypt(
        Buffer.concat([field(header), field(Buffer.alloc(0))]),
        new Uint8Array(16),
    );
    const account = Buffer.from(uin);
    return Buffer.concat([
        word(14 + account.length + encrypted.length),
        word(12),
        Buffer.of(2, 0),
        field(account),
        encrypted,
    ]);
}

// Settlement is controlled separately from the deliberately uncooperative worker.
class MemoryTransport implements Sso12RawTransport {
    readonly result = deferred<Sso12RawResult<never>>();
    readonly done = deferred<void>();
    readonly candidate = candidate();
    calls = 0;
    writeAttempts = 0;
    writes = 0;
    verifyAttempts = 0;
    verified = 0;
    consumeAttempts = 0;
    consumed = 0;
    forceLateCallbacks = false;

    transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        this.calls++;

        const work = async () => {
            let context = {} as C;
            let built = false;

            try {
                const request = await raw.buildRequest(identity);
                context = request.context;
                built = true;
                this.writeAttempts++;
                this.writes++;
            } catch {
                // The fake still tries its later phases when requested by the test.
                this.writeAttempts++;
            }

            let accepted = false;

            if (built || this.forceLateCallbacks) {
                this.verifyAttempts++;

                try {
                    accepted = await raw.verifyCandidate(this.candidate, context, identity);

                    if (accepted) {
                        this.verified++;
                    }
                } catch {
                    // A revoked callback is the expected outcome after cancellation.
                }
            }

            if (accepted || this.forceLateCallbacks) {
                this.consumeAttempts++;

                try {
                    await raw.consumeCandidate(this.candidate, context, identity);
                    this.consumed++;
                } catch {
                    // No fake success is committed on a rejected callback.
                }
            }

            this.done.resolve();
        };

        void work();
        return this.result.promise;
    }
}

// A short watchdog detects a stuck cancellation without waiting for the long
// transaction deadline. The test releases all gates in finally on either path.
async function settledWithin<T>(
    promise: Promise<T>,
): Promise<{ settled: true; value: T } | { settled: false }> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise.then((value) => ({ settled: true as const, value })),
            new Promise<{ settled: false }>((resolve) => {
                timer = setTimeout(() => resolve({ settled: false }), 500);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function suppressAbort(controller: AbortController): void {
    controller.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
}

function wiped(value: Uint8Array): boolean {
    return value.length > 0 && value.every((byte) => byte === 0);
}

describe('reference key exchange suppressed abort events (memory only)', () => {
    it('cancels and wipes a pending signer even when an earlier listener stops propagation', async () => {
        const controller = new AbortController();
        suppressAbort(controller);
        const fake = new MemoryTransport();
        fake.forceLateCallbacks = true;
        const entered = deferred<void>();
        const signer = deferred<Uint8Array>();
        const options = config(controller.signal);
        let body!: Uint8Array;
        options.buildReserved = vi.fn((input) => {
            body = input.body;
            entered.resolve();
            return signer.promise;
        });
        options.verifyRaw = vi.fn(() => true);
        options.verifyServerResponse = vi.fn(() => true);
        const pending = referenceKeyExchangeOnTransport(fake, options);
        void pending.then(
            () => {},
            () => {},
        );

        let stopped:
            { settled: true; value: Awaited<typeof pending> } | { settled: false } | undefined;
        let clearedAtStop = false;
        let countsAtStop: number[] = [];

        try {
            await entered.promise;
            expect(body.length).toBeGreaterThan(0);
            expect(body.some((byte) => byte !== 0)).toBe(true);
            controller.abort();
            stopped = await settledWithin(pending);
            clearedAtStop = wiped(body);
            countsAtStop = [fake.calls, fake.writes, fake.verifyAttempts, fake.consumeAttempts];
        } finally {
            signer.resolve(Uint8Array.of(0xa1, 0xb2));
            await fake.done.promise;
            fake.result.resolve({
                kind: 'failure',
                code: 'fixture-finished',
                writeState: 'unknown',
            });
            await pending;
        }

        expect(stopped).toEqual({
            settled: true,
            value: { kind: 'failure', code: 'raw-cancelled', writeState: 'unknown' },
        });
        expect(clearedAtStop).toBe(true);
        expect(countsAtStop).toEqual([1, 0, 0, 0]);
        expect([fake.writeAttempts, fake.verifyAttempts, fake.consumeAttempts]).toEqual([1, 1, 1]);
        expect([fake.writes, fake.verified, fake.consumed]).toEqual([0, 0, 0]);
        expect(options.verifyRaw).not.toHaveBeenCalled();
        expect(options.verifyServerResponse).not.toHaveBeenCalled();
        expect(wiped(body)).toBe(true);
    });

    it('detects a suppressed abort synchronously triggered by the transport getter', async () => {
        const controller = new AbortController();
        suppressAbort(controller);
        const fake = new MemoryTransport();
        let getterCalls = 0;
        const transport: Sso12RawTransport = {
            get transactRaw(): Sso12RawTransport['transactRaw'] {
                getterCalls++;
                controller.abort();
                return fake.transactRaw.bind(fake);
            },
        };
        const options = config(controller.signal);
        options.buildReserved = vi.fn(options.buildReserved);
        options.verifyRaw = vi.fn(options.verifyRaw);
        const result = await referenceKeyExchangeOnTransport(transport, options);
        expect(result).toEqual({
            kind: 'failure',
            code: 'raw-cancelled',
            writeState: 'not-written',
        });
        expect(getterCalls).toBe(1);
        expect([fake.calls, fake.writes, fake.verified, fake.consumed]).toEqual([0, 0, 0, 0]);
        expect(options.buildReserved).not.toHaveBeenCalled();
        expect(options.verifyRaw).not.toHaveBeenCalled();
    });

    it.each([false, true])(
        'blocks consumption when a synchronous verifier aborts and returns true (suppressed=%s)',
        async (suppressed) => {
            const controller = new AbortController();

            if (suppressed) {
                suppressAbort(controller);
            }

            const fake = new MemoryTransport();
            const options = config(controller.signal);
            let request!: Uint8Array;
            let response!: Uint8Array;
            options.verifyRaw = vi.fn((input) => {
                request = input.requestFrame;
                response = input.responseFrame;
                controller.abort();
                return true;
            });
            options.verifyServerResponse = vi.fn(() => true);
            const pending = referenceKeyExchangeOnTransport(fake, options);
            void pending.then(
                () => {},
                () => {},
            );
            let result: Awaited<typeof pending>;

            try {
                await fake.done.promise;
            } finally {
                fake.result.resolve({
                    kind: 'failure',
                    code: 'fixture-finished',
                    writeState: 'unknown',
                });
                result = await pending;
            }

            expect(result).toEqual({
                kind: 'failure',
                code: 'raw-cancelled',
                writeState: 'unknown',
            });
            expect(options.verifyRaw).toHaveBeenCalledOnce();
            expect([fake.calls, fake.writes, fake.verifyAttempts]).toEqual([1, 1, 1]);
            expect([fake.verified, fake.consumeAttempts, fake.consumed]).toEqual([0, 0, 0]);
            expect(options.verifyServerResponse).not.toHaveBeenCalled();
            expect(wiped(request)).toBe(true);
            expect(wiped(response)).toBe(true);
        },
    );
});
