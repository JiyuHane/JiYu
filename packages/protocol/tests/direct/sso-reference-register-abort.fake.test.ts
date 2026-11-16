import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { SsoRegisterResponse } from '@snowluma/proto-defs/sso-register';
import { qqTeaEncrypt } from '../../src/direct/qq-tea';
import * as serviceFrame from '../../src/direct/service-frame';
import * as sso from '../../src/direct/sso';
import { SSO_INFO_SYNC_COMMAND } from '../../src/direct/sso-register';
import {
    referenceRegisterOnTransport,
    type SsoReferenceRegisterBorrowedOptions,
} from '../../src/direct/sso-reference-register-flow';
import type {
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';

// Synthetic inputs only; these tests never construct a socket or invoke a live service.
const key = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const identity = { uin: '0', sequence: 0xf0000001 };

function config(): SsoReferenceRegisterBorrowedOptions {
    return {
        login: {
            status: 'tickets',
            uin: '123',
            tickets: {
                d2: Uint8Array.of(3, 4),
                d2Key: Uint8Array.from(key),
                a1: Uint8Array.of(5),
                a2: Uint8Array.of(6, 7),
            },
        },
        profile: { subAppId: 42, guid: Uint8Array.of(0xab, 0xcd), version: 'header-v' },
        registration: {
            uid: 'fixture-uid',
            version: 'build-v',
            deviceName: 'name',
            deviceType: 'type',
            vendorOs: 'os',
            random: 4,
        },
        timeoutMs: 1000,
        buildReserved: () => Uint8Array.of(8),
        verifyRaw: () => true,
    };
}

function word(n: number): Buffer {
    const value = Buffer.alloc(4);
    value.writeUInt32BE(n >>> 0);
    return value;
}

const field = (value: Uint8Array): Buffer => Buffer.concat([word(value.length + 4), value]);

function reply(): Buffer {
    const body = protobuf_encode<SsoRegisterResponse>({
        register: { message: 'register success' },
    });
    const inner = Buffer.concat([
        field(
            Buffer.concat([
                word(identity.sequence),
                word(0),
                field(Buffer.alloc(0)),
                field(Buffer.from(SSO_INFO_SYNC_COMMAND)),
                field(Buffer.alloc(0)),
                word(0),
                field(Buffer.alloc(0)),
            ]),
        ),
        field(body),
    ]);
    const payload = qqTeaEncrypt(inner, key);
    const uin = Buffer.from('123');
    return Buffer.concat([
        word(14 + uin.length + payload.length),
        word(12),
        Buffer.of(1, 0),
        field(uin),
        payload,
    ]);
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`watchdog: ${label}`)), 1500);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const zeroed = (bytes: Uint8Array): boolean => bytes.every((value) => value === 0);

describe('borrowed reference registration cancellation (synthetic memory only)', () => {
    it('observes synchronous abort despite an earlier propagation-stopping listener', async () => {
        const candidate = reply();
        const controller = new AbortController();
        controller.signal.addEventListener('abort', (event) => event.stopImmediatePropagation(), {
            once: true,
        });
        const options = config();
        options.signal = controller.signal;
        let signing: Uint8Array | undefined;
        let writes = 0;
        let calls = 0;
        const verifier = vi.fn(() => true);
        options.verifyRaw = verifier;

        options.buildReserved = ({ body }) => {
            signing = body;
            controller.abort();
            return Uint8Array.of(8);
        };

        const innerEncoder = vi.spyOn(sso, 'encodeSso12Request');
        const outerEncoder = vi.spyOn(serviceFrame, 'encodeServiceRequest');
        const transport: Sso12RawTransport = {
            async transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                calls++;

                try {
                    const built = await raw.buildRequest(identity);
                    writes++;

                    if (await raw.verifyCandidate(candidate, built.context, identity)) {
                        const value = await raw.consumeCandidate(
                            candidate,
                            built.context,
                            identity,
                        );
                        return {
                            kind: 'response',
                            sequence: identity.sequence,
                            value,
                            writeState: 'written',
                        };
                    }
                } catch {
                    // Deliberately claim success even if the callback rejects.
                }

                return {
                    kind: 'response',
                    sequence: identity.sequence,
                    value: 'success' as T,
                    writeState: 'written',
                };
            },
        };

        try {
            const result = await bounded(
                referenceRegisterOnTransport(transport, options),
                'sync abort',
            );
            expect(result.kind).toBe('failure');
            expect(calls).toBe(1);
            expect(signing).toBeDefined();
            expect(zeroed(signing!)).toBe(true);
            expect(innerEncoder).not.toHaveBeenCalled();
            expect(outerEncoder).not.toHaveBeenCalled();
            expect(writes).toBe(0);
            expect(verifier).not.toHaveBeenCalled();
        } finally {
            innerEncoder.mockRestore();
            outerEncoder.mockRestore();
        }
    });

    it.each(['abort', 'timeout'] as const)(
        'settles locally with unknown write state when transport never calls back (%s)',
        async (mode) => {
            const controller = new AbortController();
            const options = config();
            options.signal = controller.signal;
            options.timeoutMs = mode === 'timeout' ? 60 : 1000;
            const entered = deferred<void>();
            let calls = 0;
            const transport: Sso12RawTransport = {
                transactRaw<_C, T>(): Promise<Sso12RawResult<T>> {
                    calls++;
                    entered.resolve();
                    return new Promise<Sso12RawResult<T>>(() => {});
                },
            };
            const operation = referenceRegisterOnTransport(transport, options);
            await bounded(entered.promise, 'transport entry');

            if (mode === 'abort') {
                controller.abort();
            }

            expect(await bounded(operation, `stalled transport ${mode}`)).toMatchObject({
                kind: 'failure',
                writeState: 'unknown',
            });
            expect(calls).toBe(1);
        },
    );

    it.each(['abort', 'timeout'] as const)(
        'wipes the observed signer input when a callback and transport stall (%s)',
        async (mode) => {
            const controller = new AbortController();
            const options = config();
            options.signal = controller.signal;
            options.timeoutMs = mode === 'timeout' ? 60 : 1000;
            const entered = deferred<void>();
            const signer = deferred<Uint8Array>();
            let signing: Uint8Array | undefined;
            let writes = 0;

            options.buildReserved = ({ body }) => {
                signing = body;
                entered.resolve();
                return signer.promise;
            };

            const transport: Sso12RawTransport = {
                async transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                    try {
                        await raw.buildRequest(identity);
                        writes++;
                    } catch {
                        // The transport owns this callback's eventual rejection.
                    }

                    return new Promise<Sso12RawResult<T>>(() => {});
                },
            };
            const operation = referenceRegisterOnTransport(transport, options);
            await bounded(entered.promise, 'signer entry');
            expect(signing!.some((value) => value !== 0)).toBe(true);

            if (mode === 'abort') {
                controller.abort();
            }

            expect(await bounded(operation, `stalled signer ${mode}`)).toMatchObject({
                kind: 'failure',
                writeState: 'unknown',
            });
            expect(zeroed(signing!)).toBe(true);
            signer.resolve(Uint8Array.of(8));
            await nextTurn();
            expect(zeroed(signing!)).toBe(true);
            expect(writes).toBe(0);
        },
    );

    it.each(['resolve', 'reject'] as const)(
        'ignores a late signer %s after abort without an unhandled rejection',
        async (settlement) => {
            const controller = new AbortController();
            const options = config();
            options.signal = controller.signal;
            const entered = deferred<void>();
            const signer = deferred<Uint8Array>();
            const callbackDone = deferred<void>();
            const unhandled: unknown[] = [];

            const onUnhandled = (reason: unknown): void => {
                unhandled.push(reason);
            };

            let signing: Uint8Array | undefined;
            let writes = 0;

            options.buildReserved = ({ body }) => {
                signing = body;
                entered.resolve();
                return signer.promise;
            };

            const verifier = vi.fn(() => true);
            options.verifyRaw = verifier;
            const transport: Sso12RawTransport = {
                async transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                    try {
                        await raw.buildRequest(identity);
                        writes++;
                    } catch {
                        // Preserve the detached operation's eventual rejection handling.
                    } finally {
                        callbackDone.resolve();
                    }

                    return { kind: 'failure', code: 'fixture', writeState: 'unknown' };
                },
            };
            process.on('unhandledRejection', onUnhandled);

            try {
                const operation = referenceRegisterOnTransport(transport, options);
                await bounded(entered.promise, 'late signer entry');
                controller.abort();
                expect(await bounded(operation, 'late signer abort')).toMatchObject({
                    kind: 'failure',
                    writeState: 'unknown',
                });
                expect(zeroed(signing!)).toBe(true);

                if (settlement === 'resolve') {
                    signer.resolve(Uint8Array.of(8));
                } else {
                    signer.reject(new Error('synthetic late signer rejection'));
                }

                await bounded(callbackDone.promise, 'late signer callback cleanup');
                await nextTurn();
                expect(unhandled).toEqual([]);
                expect(zeroed(signing!)).toBe(true);
                expect(writes).toBe(0);
                expect(verifier).not.toHaveBeenCalled();
            } finally {
                process.removeListener('unhandledRejection', onUnhandled);
            }
        },
    );

    it('observes a transport rejection that arrives after local abort settlement', async () => {
        const controller = new AbortController();
        const options = { ...config(), signal: controller.signal };
        const entered = deferred<void>();
        const rawResult = deferred<Sso12RawResult<never>>();
        const unhandled: unknown[] = [];

        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason);
        };

        const transport: Sso12RawTransport = {
            transactRaw<_C, T>(): Promise<Sso12RawResult<T>> {
                entered.resolve();
                return rawResult.promise;
            },
        };
        process.on('unhandledRejection', onUnhandled);

        try {
            const operation = referenceRegisterOnTransport(transport, options);
            await bounded(entered.promise, 'rejecting transport entry');
            controller.abort();
            expect(await bounded(operation, 'rejecting transport abort')).toMatchObject({
                kind: 'failure',
                writeState: 'unknown',
            });
            rawResult.reject(new Error('synthetic late transport rejection'));
            await nextTurn();
            await nextTurn();
            expect(unhandled).toEqual([]);
        } finally {
            process.removeListener('unhandledRejection', onUnhandled);
        }
    });

    it('returns not-written for a pre-aborted signal without invoking transport', async () => {
        const controller = new AbortController();
        controller.abort();
        const options = { ...config(), signal: controller.signal };
        const transactRaw = vi.fn();
        const transport = { transactRaw } as Sso12RawTransport;
        expect(
            await bounded(referenceRegisterOnTransport(transport, options), 'pre-abort'),
        ).toMatchObject({
            kind: 'failure',
            writeState: 'not-written',
        });
        expect(transactRaw).not.toHaveBeenCalled();
    });
});
