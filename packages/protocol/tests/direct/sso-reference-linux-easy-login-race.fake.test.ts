import { createCipheriv } from 'node:crypto';
import type { NTLoginForwardRequest } from '@snowluma/proto-defs/direct-login';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { qqTeaEncrypt } from '../../src/direct/qq-tea';
import { referenceLinuxEasyLoginOnTransport } from '../../src/direct/sso-reference-linux-easy-login-flow';
import type {
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';

// Synthetic bytes and in-memory callbacks only: no socket, listener or connection.
// Matching transport identity to uin is a caller obligation, not authentication.
// A fresh nonce for each encryption under the same key is the caller's obligation.
// Timers test eventual cancellation, not a hard real-time deadline.
const uin = '123456';
const sequence = 123;
const identity = { uin, sequence };
type Options = Parameters<typeof referenceLinuxEasyLoginOnTransport>[1];

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
    return {
        uin,
        sessionKey: Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i),
        sessionTicket: Uint8Array.of(0xaa, 0x01),
        a1: Uint8Array.of(0x10, 0x20, 0x30),
        a2: Uint8Array.of(0x07, 0x08),
        nonce: Uint8Array.from({ length: 12 }, (_, i) => i),
        guid: Uint8Array.from({ length: 16 }, (_, i) => i + 1),
        version: 'fixture-version',
        subAppId: 42,
        deviceName: 'fixture-device',
        deviceType: 'fixture-pc',
        appId: 42,
        appName: 'fixture-app',
        qua: 'fixture-qua',
        cookie: 'fixture-cookie',
        timeoutMs: 3000,
        buildReserved: () => Uint8Array.of(3),
        verifyRaw: () => true,
    };
}

function word(value: number): Buffer {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value >>> 0);
    return out;
}

function framed(value: Uint8Array): Buffer {
    return Buffer.concat([word(value.length + 4), value]);
}

function protoField(number: number, value: Uint8Array): Buffer {
    // All fixture fields and lengths are deliberately below 128.
    return Buffer.concat([Buffer.of(number * 8 + 2, value.length), value]);
}

function candidate(command: string, key: Uint8Array, code: number, body: Uint8Array): Uint8Array {
    const common = Buffer.concat([
        protoField(1, protoField(4, Buffer.of(8, code))),
        protoField(2, body),
    ]);
    const responseNonce = Uint8Array.from({ length: 12 }, (_, i) => 0x80 + i);
    const cipher = createCipheriv('aes-128-gcm', key, responseNonce);
    const encrypted = Buffer.concat([
        responseNonce,
        cipher.update(common),
        cipher.final(),
        cipher.getAuthTag(),
    ]);
    const loginForward = protobuf_encode<NTLoginForwardRequest>({ buffer: encrypted });
    const header = Buffer.concat([
        word(sequence),
        word(0),
        framed(Buffer.alloc(0)),
        framed(Buffer.from(command)),
        framed(Buffer.alloc(0)),
        word(0),
        framed(Buffer.alloc(0)),
    ]);
    const inner = Buffer.concat([framed(header), framed(loginForward)]);
    const tea = qqTeaEncrypt(inner, new Uint8Array(16));
    const account = Buffer.from(uin);
    return Buffer.concat([
        word(14 + account.length + tea.length),
        word(12),
        Buffer.of(2, 0),
        framed(account),
        tea,
    ]);
}

// An uncooperative borrowed owner: settlement is independent of its worker and
// can remain pending forever. Counters represent fake events, never real I/O.
class MemoryTransport implements Sso12RawTransport {
    readonly result = deferred<Sso12RawResult<never>>();
    readonly done = deferred<void>();
    calls = 0;
    writes = 0;
    verifies = 0;
    consumes = 0;
    outcome: 'finished' | 'rejected' | undefined;
    autoResult = false;
    command = '';
    code = 1;
    body = Uint8Array.of(0x0a, 0x00, 0xf8, 0x07, 0x01);
    key = config().sessionKey;

    transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        this.calls++;

        const work = async () => {
            try {
                const built = await raw.buildRequest(identity);
                this.writes++;
                const response = candidate(this.command, this.key, this.code, this.body);
                this.verifies++;
                const accepted = await raw.verifyCandidate(response, built.context, identity);

                if (accepted) {
                    this.consumes++;
                    const value = await raw.consumeCandidate(response, built.context, identity);

                    if (this.autoResult) {
                        // Generic T is supplied by the callbacks, not fabricated by the fixture.
                        return {
                            kind: 'response',
                            sequence,
                            value,
                            writeState: 'written',
                        } as const;
                    }
                }

                this.outcome = 'finished';
            } catch {
                this.outcome = 'rejected';
            } finally {
                this.done.resolve();
            }

            return undefined;
        };

        const worker = work();

        if (this.autoResult) {
            return worker.then(
                (value) =>
                    value ??
                    ({
                        kind: 'failure',
                        code: 'fixture-worker-failed',
                        writeState: 'unknown',
                    } as const),
            );
        }

        return this.result.promise;
    }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('synthetic watchdog')), 2000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function counts(fake: MemoryTransport): number[] {
    return [fake.calls, fake.writes, fake.verifies, fake.consumes];
}

function expectCleared(value: Uint8Array): void {
    expect(value.length).toBeGreaterThan(0);
    expect(value.every((byte) => byte === 0)).toBe(true);
}

function suppressAbort(controller: AbortController): void {
    controller.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
}

describe('Linux EasyLogin reference stop races (synthetic memory transport)', () => {
    it.each(['abort', 'timeout', 'early transport failure'] as const)(
        'clears a pending signer after %s and revokes its late result',
        async (mode) => {
            const fake = new MemoryTransport();
            const entered = deferred<void>();
            const signer = deferred<Uint8Array>();
            const controller = new AbortController();
            const options = config();
            options.signal = controller.signal;
            options.timeoutMs = mode === 'timeout' ? 150 : 3000;
            const inputs = [
                options.sessionKey,
                options.sessionTicket,
                options.a1,
                options.a2!,
                options.nonce,
                options.guid,
            ];
            const snapshots = inputs.map((value) => Uint8Array.from(value));
            const reserved = Uint8Array.of(0xa1, 0xb2, 0xc3);
            let borrowed!: Uint8Array;
            options.buildReserved = vi.fn((input) => {
                expect(input).toMatchObject({ uin, sequence });
                fake.command = input.command;
                borrowed = input.body;
                entered.resolve();
                return signer.promise;
            });
            options.verifyRaw = vi.fn(() => true);
            const pending = referenceLinuxEasyLoginOnTransport(fake, options);
            void pending.then(
                () => {},
                () => {},
            );

            try {
                await bounded(entered.promise);
                expect(borrowed.some((byte) => byte !== 0)).toBe(true);

                if (mode === 'abort') {
                    controller.abort();
                } else if (mode === 'early transport failure') {
                    fake.result.resolve({
                        kind: 'failure',
                        code: 'fixture-secret',
                        writeState: 'unknown',
                    });
                }

                const result = await bounded(pending);
                expect(result).toMatchObject({ kind: 'failure', writeState: 'unknown' });
                expect(JSON.stringify(result)).not.toContain('fixture-secret');
                expectCleared(borrowed);
                expect(counts(fake)).toEqual([1, 0, 0, 0]);
                inputs.forEach((input, index) => expect(input).toEqual(snapshots[index]));
                signer.resolve(reserved);
                await bounded(fake.done.promise);
                expect(fake.outcome).toBe('rejected');
                expect(counts(fake)).toEqual([1, 0, 0, 0]);
                expect(options.verifyRaw).not.toHaveBeenCalled();
                expect(reserved).toEqual(Uint8Array.of(0xa1, 0xb2, 0xc3));
                expectCleared(borrowed);
            } finally {
                controller.abort();
                signer.resolve(reserved);
                fake.result.resolve({
                    kind: 'failure',
                    code: 'fixture-cleanup',
                    writeState: 'unknown',
                });
            }
        },
    );

    it('observes late signer and transport rejection without an unhandled rejection', async () => {
        const fake = new MemoryTransport();
        const entered = deferred<void>();
        const signer = deferred<Uint8Array>();
        const controller = new AbortController();
        const options = config();
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        options.signal = controller.signal;
        let borrowed!: Uint8Array;

        options.buildReserved = ({ body }) => {
            borrowed = body;
            entered.resolve();
            return signer.promise;
        };

        const pending = referenceLinuxEasyLoginOnTransport(fake, options);
        void pending.then(
            () => {},
            () => {},
        );

        try {
            await bounded(entered.promise);
            controller.abort();
            const result = await bounded(pending);
            expect(result).toMatchObject({ kind: 'failure', writeState: 'unknown' });
            expectCleared(borrowed);
            signer.reject(new Error('late-signer-secret'));
            await bounded(fake.done.promise);
            fake.result.reject(new Error('late-owner-secret'));
            await bounded(new Promise<void>((resolve) => setImmediate(resolve)));
            expect(unhandled).toEqual([]);
            expect(counts(fake)).toEqual([1, 0, 0, 0]);
            expect(JSON.stringify(result)).not.toContain('secret');
        } finally {
            controller.abort();
            signer.resolve(Uint8Array.of(1));
            fake.result.resolve({
                kind: 'failure',
                code: 'fixture-cleanup',
                writeState: 'unknown',
            });
            process.removeListener('unhandledRejection', onUnhandled);
        }
    });

    it('clears both verifier borrows on abort and ignores late true', async () => {
        const fake = new MemoryTransport();
        const entered = deferred<void>();
        const verifier = deferred<boolean>();
        const controller = new AbortController();
        const options = config();
        options.signal = controller.signal;
        let request!: Uint8Array;
        let response!: Uint8Array;

        options.buildReserved = ({ command }) => {
            fake.command = command;
            return Uint8Array.of(3);
        };

        options.verifyRaw = vi.fn((input) => {
            request = input.requestFrame;
            response = input.responseFrame;
            entered.resolve();
            return verifier.promise;
        });
        const pending = referenceLinuxEasyLoginOnTransport(fake, options);
        void pending.then(
            () => {},
            () => {},
        );

        try {
            await bounded(entered.promise);
            expect(request.some((byte) => byte !== 0)).toBe(true);
            expect(response.some((byte) => byte !== 0)).toBe(true);
            controller.abort();
            expect(await bounded(pending)).toMatchObject({
                kind: 'failure',
                writeState: 'unknown',
            });
            expectCleared(request);
            expectCleared(response);
            expect(counts(fake)).toEqual([1, 1, 1, 0]);
            verifier.resolve(true);
            await bounded(fake.done.promise);
            expect(counts(fake)).toEqual([1, 1, 1, 0]);
            expectCleared(request);
            expectCleared(response);
        } finally {
            controller.abort();
            verifier.resolve(true);
            fake.result.resolve({
                kind: 'failure',
                code: 'fixture-cleanup',
                writeState: 'unknown',
            });
        }
    });

    it('returns a pre-abort failure before calling transport', async () => {
        const fake = new MemoryTransport();
        const controller = new AbortController();
        controller.abort();
        const options = config();
        options.signal = controller.signal;
        options.buildReserved = vi.fn(options.buildReserved);
        options.verifyRaw = vi.fn(options.verifyRaw);
        expect(await bounded(referenceLinuxEasyLoginOnTransport(fake, options))).toMatchObject({
            kind: 'failure',
            writeState: 'not-written',
        });
        expect(counts(fake)).toEqual([0, 0, 0, 0]);
        expect(options.buildReserved).not.toHaveBeenCalled();
        expect(options.verifyRaw).not.toHaveBeenCalled();
    });

    it('cancels despite an earlier stopImmediatePropagation listener', async () => {
        const fake = new MemoryTransport();
        const entered = deferred<void>();
        const signer = deferred<Uint8Array>();
        const controller = new AbortController();
        suppressAbort(controller);
        const options = config();
        options.signal = controller.signal;
        let body!: Uint8Array;

        options.buildReserved = (input) => {
            body = input.body;
            entered.resolve();
            return signer.promise;
        };

        const pending = referenceLinuxEasyLoginOnTransport(fake, options);
        void pending.then(
            () => {},
            () => {},
        );

        try {
            await bounded(entered.promise);
            controller.abort();
            expect(await bounded(pending)).toMatchObject({
                kind: 'failure',
                writeState: 'unknown',
            });
            expectCleared(body);
            signer.resolve(Uint8Array.of(3));
            await bounded(fake.done.promise);
            expect(counts(fake)).toEqual([1, 0, 0, 0]);
        } finally {
            controller.abort();
            signer.resolve(Uint8Array.of(3));
            fake.result.resolve({
                kind: 'failure',
                code: 'fixture-cleanup',
                writeState: 'unknown',
            });
        }
    });

    it('stops when the transport getter aborts synchronously', async () => {
        const fake = new MemoryTransport();
        const controller = new AbortController();
        suppressAbort(controller);
        let getters = 0;
        const transport: Sso12RawTransport = {
            get transactRaw(): Sso12RawTransport['transactRaw'] {
                getters++;
                controller.abort();
                return fake.transactRaw.bind(fake);
            },
        };
        const options = config();
        options.signal = controller.signal;
        options.buildReserved = vi.fn(options.buildReserved);
        expect(await bounded(referenceLinuxEasyLoginOnTransport(transport, options))).toMatchObject(
            {
                kind: 'failure',
                writeState: 'not-written',
            },
        );
        expect(getters).toBe(1);
        expect(counts(fake)).toEqual([0, 0, 0, 0]);
        expect(options.buildReserved).not.toHaveBeenCalled();
    });

    it.each(['signer', 'verifier'] as const)(
        'rejects synchronous abort inside %s before the next fake phase',
        async (phase) => {
            const fake = new MemoryTransport();
            const controller = new AbortController();
            suppressAbort(controller);
            const options = config();
            options.signal = controller.signal;
            let borrowed!: Uint8Array;
            let request: Uint8Array | undefined;
            let response: Uint8Array | undefined;

            options.buildReserved = ({ body, command }) => {
                borrowed = body;
                fake.command = command;

                if (phase === 'signer') {
                    controller.abort();
                }

                return Uint8Array.of(3);
            };

            options.verifyRaw = vi.fn((input) => {
                request = input.requestFrame;
                response = input.responseFrame;
                controller.abort();
                return true;
            });
            const pending = referenceLinuxEasyLoginOnTransport(fake, options);
            void pending.then(
                () => {},
                () => {},
            );
            expect(await bounded(pending)).toMatchObject({
                kind: 'failure',
                writeState: 'unknown',
            });
            await bounded(fake.done.promise);
            expectCleared(borrowed);

            if (phase === 'signer') {
                expect(counts(fake)).toEqual([1, 0, 0, 0]);
                expect(options.verifyRaw).not.toHaveBeenCalled();
            } else {
                expect(counts(fake)).toEqual([1, 1, 1, 0]);
                expectCleared(request!);
                expectCleared(response!);
            }
        },
    );

    it.each([0, 1])(
        'preserves status %i and the opaque raw body in the response result',
        async (code) => {
            const fake = new MemoryTransport();
            fake.autoResult = true;
            fake.code = code;
            const options = config();

            options.buildReserved = ({ command }) => {
                fake.command = command;
                return Uint8Array.of(3);
            };

            const result = await bounded(referenceLinuxEasyLoginOnTransport(fake, options));
            expect(result).toEqual({
                kind: 'response',
                sequence,
                writeState: 'written',
                value: {
                    status: { kind: 'code', code: BigInt(code), codePresent: true },
                    body: fake.body,
                },
            });
            expect(counts(fake)).toEqual([1, 1, 1, 1]);
        },
    );
});
