import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import type { RawSessionLease } from '../../src/direct/raw-session-broker';
import {
    referenceUnregisterOnTransport,
    referenceUnregisterWithCapability,
    type SsoReferenceUnregisterOptions,
} from '../../src/direct/sso-reference-unregister-flow';
import type { Sso12RawOptions, Sso12RawResult } from '../../src/direct/sso12-packet-client';
import { SSO_UNREGISTER_REFERENCE_COMMAND as command } from '../../src/direct/sso-unregister';
import { createWtEcdh } from '../../src/direct/wt-ecdh';
import {
    bindReferenceKeyCapability,
    createBorrowedWtReferenceLoginAttempt,
} from '../../src/direct/wt-reference-login-attempt';
import {
    assertReferenceSendIdentity,
    beginReferenceSend,
    commitReferenceKey,
    createReferenceKeyCapability,
    endReferenceSend,
    reserveReferenceKeyCapability,
    revokeReferenceKey,
    stageReferenceConfirmed,
    stageReferenceKey,
} from '../../src/direct/wt-reference-session-private';

// Private staging is performed directly by this synthetic fixture: it does not
// exercise WT login. Local callback results do not establish peer identity or delivery.
const key = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const sequence = 0xf0000001;
const bodyHex = '0801120a0a0012001a0022002a001801';
const peer = createWtEcdh(Buffer.concat([Buffer.alloc(23), Buffer.of(2)]));
const cancelled = { kind: 'failure', code: 'raw-cancelled', writeState: 'not-written' };

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function word(value: number): Buffer {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value >>> 0);
    return bytes;
}

const field = (bytes: Uint8Array) => Buffer.concat([word(bytes.length + 4), bytes]);

function response(retCode = 0, body: Uint8Array = new Uint8Array()): Uint8Array {
    const header = Buffer.concat([
        word(sequence),
        word(retCode),
        field(Buffer.alloc(0)),
        field(Buffer.from(command)),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    const encrypted = qqTeaEncrypt(Buffer.concat([field(header), field(body)]), key);
    const uin = Buffer.from('123');
    return Buffer.concat([
        word(14 + uin.length + encrypted.length),
        word(12),
        Buffer.of(1, 0),
        field(uin),
        encrypted,
    ]);
}

function inspectRequest(bytes: Uint8Array) {
    const frame = Buffer.from(bytes);
    const ticketEnd = 9 + frame.readUInt32BE(9);
    const accountStart = ticketEnd + 1;
    const accountEnd = accountStart + frame.readUInt32BE(accountStart);
    const inner = Buffer.from(qqTeaDecrypt(frame.subarray(accountEnd), key));
    const headerEnd = inner.readUInt32BE(0);
    let offset = 28;

    const readField = () => {
        const end = offset + inner.readUInt32BE(offset);
        const value = inner.subarray(offset + 4, end);
        offset = end;
        return value;
    };

    readField();
    const cmd = readField().toString();
    readField();
    readField();
    readField();
    offset += inner.readUInt16BE(offset);
    const reserved = Uint8Array.from(readField());
    return {
        uin: frame.subarray(accountStart + 4, accountEnd).toString(),
        sequence: inner.readUInt32BE(4),
        command: cmd,
        reserved,
        body: inner.subarray(headerEnd + 4).toString('hex'),
    };
}

function options(): SsoReferenceUnregisterOptions {
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
        uid: 'fixture-uid',
        timeoutMs: 3000,
        maxResponseBodyBytes: 65536,
        buildReserved: () => Uint8Array.of(8),
        verifyRaw: () => true,
    };
}

type Mode =
    | 'normal'
    | 'identity'
    | 'swap'
    | 'context'
    | 'skip'
    | 'double-build'
    | 'double-verify'
    | 'double-consume'
    | 'wrong-result';
type Phase = 'build' | 'verify' | 'consume' | 'result';

function fixture() {
    const frames: Uint8Array[] = [];
    const phases: Phase[] = [];
    const callbackSettlements: Array<{ phase: Phase; state: 'fulfilled' | 'rejected' }> = [];
    const callbackErrors: Array<{ phase: Phase; error: unknown }> = [];
    const caught: unknown[] = [];
    const transportRejections: unknown[] = [];
    const gates: Array<() => void> = [];
    const pending = new Set<Promise<unknown>>();
    const entered = {
        build: deferred<void>(),
        verify: deferred<void>(),
        consume: deferred<void>(),
        result: deferred<void>(),
    };
    const callbackDone = {
        build: deferred<void>(),
        verify: deferred<void>(),
        consume: deferred<void>(),
        result: deferred<void>(),
    };
    let candidate = response();
    let detachOnAbort = false;
    let mode: Mode = 'normal';
    let transportUin = '0';

    let onGetter = () => {};

    let reads = 0;
    let calls = 0;
    let beforeConsume: (() => Promise<void>) | undefined;
    let beforeResult: (() => Promise<void>) | undefined;

    const track = <T>(promise: Promise<T>): Promise<T> => {
        pending.add(promise);
        void promise.then(
            () => pending.delete(promise),
            () => pending.delete(promise),
        );
        return promise;
    };

    const callback = <T>(phase: Phase, operation: () => T | Promise<T>): Promise<T> => {
        const promise = Promise.resolve()
            .then(operation)
            .then(
                (result) => {
                    callbackSettlements.push({ phase, state: 'fulfilled' });
                    callbackDone[phase].resolve();
                    return result;
                },
                (error: unknown) => {
                    callbackSettlements.push({ phase, state: 'rejected' });
                    callbackErrors.push({ phase, error });
                    callbackDone[phase].resolve();
                    throw error;
                },
            );
        return track(promise);
    };

    const gate = <T>(value: T) => {
        const item = deferred<T>();
        gates.push(() => item.resolve(value));
        return item;
    };

    const transact = async <C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> => {
        calls++;

        const awaitCallback = async <V>(operation: Promise<V>): Promise<V> => {
            if (!detachOnAbort || !raw.signal) {
                return operation;
            }

            const signal = raw.signal;
            let onAbort!: () => void;
            const stopped = new Promise<never>((_resolve, reject) => {
                onAbort = () => reject(new Error('synthetic owner stopped'));

                if (signal.aborted) {
                    onAbort();
                } else {
                    signal.addEventListener('abort', onAbort, { once: true });
                }
            });

            try {
                return await Promise.race([operation, stopped]);
            } finally {
                signal.removeEventListener('abort', onAbort);
            }
        };

        const identity = { uin: transportUin, sequence };

        try {
            if (mode === 'skip') {
                return { kind: 'response', sequence, value: {} as T, writeState: 'written' };
            }

            phases.push('build');
            entered.build.resolve();
            const built = await awaitCallback(callback('build', () => raw.buildRequest(identity)));
            frames.push(Uint8Array.from(built.frame));

            if (mode === 'double-build') {
                await raw.buildRequest(identity);
            }

            phases.push('verify');
            entered.verify.resolve();
            const id = mode === 'identity' ? { ...identity, sequence: sequence + 1 } : identity;
            const context = mode === 'context' ? ({} as C) : built.context;
            const accepted = await awaitCallback(
                callback('verify', () => raw.verifyCandidate(candidate, context, id)),
            );

            if (!accepted) {
                return { kind: 'failure', code: 'synthetic', writeState: 'unknown' };
            }

            if (mode === 'double-verify') {
                await raw.verifyCandidate(candidate, built.context, identity);
            }

            phases.push('consume');
            entered.consume.resolve();
            await beforeConsume?.();
            const altered = mode === 'swap' ? Uint8Array.from(candidate) : candidate;

            if (mode === 'swap') {
                altered[altered.length - 1] ^= 1;
            }

            const value = await callback('consume', () =>
                raw.consumeCandidate(altered, built.context, identity),
            );

            if (mode === 'double-consume') {
                await raw.consumeCandidate(candidate, built.context, identity);
            }

            phases.push('result');
            entered.result.resolve();
            await beforeResult?.();
            return {
                kind: 'response',
                sequence: mode === 'wrong-result' ? 7 : sequence,
                value,
                writeState: 'written',
            };
        } catch (error) {
            caught.push(error);
            return { kind: 'failure', code: 'fixture-callback-failed', writeState: 'unknown' };
        }
    };

    const trackedTransact = <C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> => {
        const operation = transact(raw).catch((error: unknown) => {
            transportRejections.push(error);
            throw error;
        });
        return track(operation);
    };

    const lease: RawSessionLease = {
        whenClosed: new Promise(() => {}),
        close: vi.fn(),
        poison: vi.fn(),
        release: vi.fn(),
        get transactRaw() {
            reads++;
            onGetter();
            return trackedTransact;
        },
    };
    const attempt = createBorrowedWtReferenceLoginAttempt(lease, {
        profile: {
            uin: '999',
            appId: 42,
            subAppId: 43,
            clientVersion: 44,
            guid: Uint8Array.of(1, 2),
            unknown21: new Uint8Array(21),
            randomKey: new Uint8Array(16).fill(7),
            peerPublicKey: peer.publicKey,
            ssoVersion: 'fixture',
            qrCommand: 'fixture.qr',
            loginCommand: 'fixture.login',
        },
        timeoutMs: 3000,
        attemptTimeoutMs: 30000,
        getTimestamp: () => 10,
        buildReserved: () => new Uint8Array(),
        verifyRaw: () => true,
        verifyContext: () => true,
        sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
    });
    let token!: object;

    try {
        token = createReferenceKeyCapability();
        const reservation = reserveReferenceKeyCapability(token);
        bindReferenceKeyCapability(attempt, token, reservation);
    } catch (error) {
        const failures: unknown[] = [error];

        try {
            attempt.close();
        } catch (cleanup) {
            failures.push(cleanup);
        }

        if (token !== undefined) {
            try {
                revokeReferenceKey(token);
            } catch (cleanup) {
                failures.push(cleanup);
            }
        }

        if (failures.length > 1) {
            throw new AggregateError(failures, 'fixture setup and cleanup failed');
        }

        throw error;
    }

    const activate = (stagedTransport = '0', confirmed = '123') => {
        stageReferenceConfirmed(token, attempt, stagedTransport, confirmed, 41);
        const temporary = Uint8Array.from(key);
        stageReferenceKey(token, attempt, stagedTransport, confirmed, 42, temporary);
        temporary.fill(0);
        commitReferenceKey(token);
    };

    return {
        token,
        attempt,
        lease,
        frames,
        phases,
        callbackSettlements,
        callbackErrors,
        caught,
        callbackDone,
        get candidate() {
            return candidate;
        },
        setResponse(retCode: number, body: Uint8Array) {
            candidate = response(retCode, body);
        },
        detachOnAbort() {
            detachOnAbort = true;
        },
        entered,
        track,
        gate,
        activate,
        get reads() {
            return reads;
        },
        get calls() {
            return calls;
        },
        mode(value: Mode) {
            mode = value;
        },
        transportUin(value: string) {
            transportUin = value;
        },
        getter(callback: () => void) {
            onGetter = callback;
        },
        holdConsume(callback: () => Promise<void>) {
            beforeConsume = callback;
        },
        holdResult(callback: () => Promise<void>) {
            beforeResult = callback;
        },
        send(input = options(), run: object = {}) {
            return track(referenceUnregisterWithCapability({ token, attempt, lease, run }, input));
        },
        async close() {
            const errors: unknown[] = [];

            for (const release of gates) {
                try {
                    release();
                } catch (error) {
                    errors.push(error);
                }
            }

            try {
                attempt.close();
            } catch (error) {
                errors.push(error);
            }

            try {
                revokeReferenceKey(token);
            } catch (error) {
                errors.push(error);
            }

            try {
                for (let round = 0; pending.size && round < 32; round++) {
                    const outcome = await watched(Promise.allSettled([...pending]));

                    if (outcome.tag === 'alarm') {
                        errors.push(new Error('fixture cleanup watchdog alarm'));
                        break;
                    }
                }

                if (pending.size && !errors.length) {
                    errors.push(new Error('fixture cleanup did not settle within 32 rounds'));
                }
            } catch (error) {
                errors.push(error);
            }

            errors.push(...transportRejections);

            if (errors.length) {
                throw new AggregateError(errors, 'fixture cleanup failed');
            }
        },
    };
}

type Fixture = ReturnType<typeof fixture>;

// The timeout is a tagged outcome, never a rejected promise accepted as business failure.
async function watched<T>(
    promise: Promise<T>,
): Promise<{ tag: 'value'; value: T } | { tag: 'alarm' }> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise.then((value) => ({ tag: 'value' as const, value })),
            new Promise<{ tag: 'alarm' }>((resolve) => {
                timer = setTimeout(() => resolve({ tag: 'alarm' }), 5000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function value<T>(promise: Promise<T>): Promise<T> {
    const result = await watched(promise);

    if (result.tag === 'alarm') {
        throw new Error('fixture watchdog alarm');
    }

    return result.value;
}

async function failed(promise: Promise<unknown>) {
    const result = await value(
        promise.then(
            (actual) => ({ tag: 'returned' as const, actual }),
            (error: unknown) => ({ tag: 'threw' as const, error }),
        ),
    );

    if (result.tag === 'returned') {
        expect(result.actual).toEqual({
            kind: 'failure',
            code: 'borrowed-transaction-failed',
            writeState: 'unknown',
        });
    } else if (
        !(result.error instanceof Error) ||
        result.error.message !== 'invalid reference send binding'
    ) {
        throw result.error;
    }
}

async function rejected(promise: Promise<unknown>, expectedMessage: string) {
    const result = await value(
        promise.then(
            (actual) => ({ tag: 'returned' as const, actual }),
            (error: unknown) => ({ tag: 'threw' as const, error }),
        ),
    );
    expect(result.tag).toBe('threw');

    if (result.tag === 'threw') {
        expect(result.error).toBeInstanceOf(TypeError);
        expect((result.error as Error).message).toBe(expectedMessage);
    }
}

async function withFixture(test: (f: Fixture) => Promise<void>) {
    const f = fixture();
    let primary: unknown;
    let failed = false;

    try {
        await test(f);
    } catch (error) {
        failed = true;
        primary = error;
    }

    try {
        await f.close();
    } catch (error) {
        if (failed) {
            throw new AggregateError([primary, error], 'test and fixture cleanup failed');
        }

        throw error;
    }

    if (failed) {
        throw primary;
    }
}

const observed = {
    kind: 'response',
    sequence,
    writeState: 'written',
    value: { status: 'observed', message: { presence: 'absent' } },
};

describe('reference unregister capability using synthetic transport', () => {
    // Leave enough time for both tagged watchdog failures and bounded cleanup.
    beforeAll(() => vi.setConfig({ testTimeout: 180000 }));
    afterAll(() => vi.resetConfig());
    it('preserves the public async function shape and rejects invalid options asynchronously', () =>
        withFixture(async (f) => {
            expect(Object.getPrototypeOf(referenceUnregisterOnTransport)).toBe(
                Object.getPrototypeOf(async function () {}),
            );
            expect(referenceUnregisterOnTransport.name).toBe('referenceUnregisterOnTransport');
            expect(referenceUnregisterOnTransport.length).toBe(2);
            expect(Object.hasOwn(referenceUnregisterOnTransport, 'prototype')).toBe(false);
            expect(() =>
                Reflect.construct(referenceUnregisterOnTransport, [f.lease, options()]),
            ).toThrow(TypeError);
            const input = options();
            input.timeoutMs = 0;
            let pending!: Promise<unknown>;
            expect(() => {
                pending = referenceUnregisterOnTransport(f.lease, input);
            }).not.toThrow();
            expect(pending).toBeInstanceOf(Promise);
            await rejected(pending, 'invalid unregister configuration');
            expect(f.calls).toBe(0);
        }));

    it('ignores an extra third argument on the public helper', () =>
        withFixture(async (f) => {
            f.transportUin('123');
            const third = new Proxy(
                {},
                {
                    get: () => {
                        throw new Error('unexpected third argument');
                    },
                },
            );
            const pending = Reflect.apply(referenceUnregisterOnTransport, undefined, [
                f.lease,
                options(),
                third,
            ]) as Promise<unknown>;
            expect(await value(pending)).toEqual(observed);
            expect(f.frames).toHaveLength(1);
        }));
    it('uses raw identity 0 but the staged 123 for envelope and signer', () =>
        withFixture(async (f) => {
            f.activate();
            const input = options();
            const originals = [
                input.login.tickets.d2,
                input.login.tickets.d2Key,
                input.login.tickets.a1,
                input.login.tickets.a2,
                input.profile.guid,
                f.candidate,
            ];
            const snapshots = originals.map((b) => Uint8Array.from(b));
            let signer!: Uint8Array;
            let request!: Uint8Array;
            let responseView!: Uint8Array;
            input.buildReserved = vi.fn((args) => {
                expect(args).toMatchObject({ uin: '123', uid: 'fixture-uid', sequence, command });
                expect(Buffer.from(args.body).toString('hex')).toBe(bodyHex);
                signer = args.body;
                args.body.fill(0xee);
                return Uint8Array.of(8);
            });
            input.verifyRaw = vi.fn((args) => {
                expect(args).toMatchObject({ uin: '123', sequence, command });
                request = args.requestFrame;
                responseView = args.responseFrame;
                expect(responseView).not.toBe(f.candidate);
                request.fill(0xaa);
                responseView.fill(0xbb);
                return true;
            });
            expect(await value(f.send(input))).toEqual(observed);
            expect(f.phases).toEqual(['build', 'verify', 'consume', 'result']);
            expect(f.frames).toHaveLength(1);
            expect(inspectRequest(f.frames[0])).toEqual({
                uin: '123',
                sequence,
                command,
                reserved: Uint8Array.of(8),
                body: bodyHex,
            });

            for (const view of [signer, request, responseView]) {
                expect(view.length).toBeGreaterThan(0);
                expect(view.every((b) => b === 0)).toBe(true);
            }

            originals.forEach((bytes, index) =>
                expect(Uint8Array.from(bytes)).toEqual(snapshots[index]),
            );
            expect(input.buildReserved).toHaveBeenCalledOnce();
            expect(input.verifyRaw).toHaveBeenCalledOnce();
        }));

    it('returns nonzero SSO retCode without decoding or capping malformed business bytes', () =>
        withFixture(async (f) => {
            f.activate();
            f.setResponse(7, Uint8Array.of(0x08, 0x80));
            const input = options();
            input.maxResponseBodyBytes = 0;
            input.verifyRaw = vi.fn(input.verifyRaw);
            expect(await value(f.send(input))).toEqual({
                kind: 'response',
                sequence,
                writeState: 'written',
                value: { status: 'sso-error', retCode: 7 },
            });
            expect(input.verifyRaw).toHaveBeenCalledOnce();
            expect(f.phases).toEqual(['build', 'verify', 'consume', 'result']);
            expect(f.callbackSettlements).toContainEqual({ phase: 'consume', state: 'fulfilled' });
            expect(f.caught).toEqual([]);
            expect(f.frames).toHaveLength(1);
        }));

    it.each([
        ['body exceeds cap', Uint8Array.of(0x08, 0), 0],
        ['malformed protobuf', Uint8Array.of(0x08, 0x80), 65536],
    ] as const)('rejects retCode-zero %s only after verify and consume', (_label, body, cap) =>
        withFixture(async (f) => {
            f.activate();
            f.setResponse(0, body);
            const input = options();
            input.maxResponseBodyBytes = cap;
            input.verifyRaw = vi.fn(input.verifyRaw);
            expect(await value(f.send(input))).toEqual({
                kind: 'failure',
                code: 'borrowed-transaction-failed',
                writeState: 'unknown',
            });
            expect(input.verifyRaw).toHaveBeenCalledOnce();
            expect(f.phases).toEqual(['build', 'verify', 'consume']);
            expect(f.callbackSettlements).toContainEqual({ phase: 'consume', state: 'rejected' });
            expect(f.callbackErrors).toHaveLength(1);
            expect(f.callbackErrors[0].phase).toBe('consume');
            expect(f.callbackErrors[0].error).toBeInstanceOf(Error);
            expect((f.callbackErrors[0].error as Error).message).toBe(
                'invalid unregister response',
            );
            expect(f.frames).toHaveLength(1);
        }),
    );

    it('suppresses a nonzero SSO error if the capability is revoked before final delivery', () =>
        withFixture(async (f) => {
            f.activate();
            f.setResponse(7, Uint8Array.of(0x08, 0x80));
            const release = f.gate<void>(undefined);
            f.holdResult(() => release.promise);
            const pending = f.send();
            await value(f.entered.result.promise);
            expect(f.phases).toEqual(['build', 'verify', 'consume', 'result']);
            expect(f.callbackSettlements).toContainEqual({ phase: 'consume', state: 'fulfilled' });
            revokeReferenceKey(f.token);
            release.resolve();
            expect(await value(pending)).toEqual({
                kind: 'failure',
                code: 'borrowed-transaction-failed',
                writeState: 'unknown',
            });
            expect(f.frames).toHaveLength(1);
        }));

    it.each(['0', '456', '0123'])('keeps the public helper strict for raw UIN %s', (uin) =>
        withFixture(async (f) => {
            f.transportUin(uin);
            const input = options();
            input.buildReserved = vi.fn(input.buildReserved);
            await failed(f.track(referenceUnregisterOnTransport(f.lease, input)));
            expect(f.calls).toBe(1);
            expect(f.phases).toEqual(['build']);
            expect(f.caught).toHaveLength(1);
            expect((f.caught[0] as Error).message).toBe('invalid transaction identity');
            expect(input.buildReserved).not.toHaveBeenCalled();
            expect(f.frames).toHaveLength(0);
        }),
    );

    it.each(['token', 'attempt', 'lease', 'key', 'transport', 'confirmed'] as const)(
        'rejects different %s without signer or frame',
        (kind) =>
            withFixture(async (a) =>
                withFixture(async (b) => {
                    a.activate();
                    b.activate();
                    const input = options();
                    input.buildReserved = vi.fn(input.buildReserved);
                    input.verifyRaw = vi.fn(input.verifyRaw);
                    const binding = { token: a.token, attempt: a.attempt, lease: a.lease, run: {} };

                    if (kind === 'token') {
                        binding.token = b.token;
                    }

                    if (kind === 'attempt') {
                        binding.attempt = b.attempt;
                    }

                    if (kind === 'lease') {
                        binding.lease = b.lease;
                    }

                    if (kind === 'key') {
                        input.login.tickets.d2Key[0] ^= 1;
                    }

                    if (kind === 'transport') {
                        a.transportUin('123');
                    }

                    if (kind === 'confirmed') {
                        Reflect.set(input.login, 'uin', '124');
                    }

                    await failed(a.track(referenceUnregisterWithCapability(binding, input)));
                    const entersBuild = ['transport', 'confirmed'].includes(kind);
                    expect(a.calls).toBe(entersBuild ? 1 : 0);
                    expect(a.phases).toEqual(entersBuild ? ['build'] : []);
                    expect(b.calls).toBe(0);

                    if (entersBuild) {
                        expect(a.caught).toHaveLength(1);
                        expect((a.caught[0] as Error).message).toBe(
                            'invalid reference send binding',
                        );
                    }

                    expect(input.buildReserved).not.toHaveBeenCalled();
                    expect(input.verifyRaw).not.toHaveBeenCalled();
                    expect(a.frames).toHaveLength(0);
                    expect(b.frames).toHaveLength(0);
                }),
            ),
    );

    it('shares the active slot with send and burns the exact run', () =>
        withFixture(async (f) => {
            f.activate();
            const active = {};
            const used = {};
            beginReferenceSend(f.token, f.attempt, f.lease, active);
            const input = options();
            input.buildReserved = vi.fn(input.buildReserved);
            await failed(f.send(input, used));
            expect(
                assertReferenceSendIdentity(f.token, f.attempt, f.lease, active, '0', '123'),
            ).toBeUndefined();
            endReferenceSend(f.token, f.attempt, f.lease, active);
            expect(await value(f.send(input, used))).toEqual(observed);
            const count = f.frames.length;
            await failed(f.send(input, used));
            expect(f.frames).toHaveLength(count);
            expect(input.buildReserved).toHaveBeenCalledOnce();
        }));

    it('holds the slot while unregister is pending and rejects a send-slot acquisition', () =>
        withFixture(async (f) => {
            f.activate();
            const gate = f.gate(Uint8Array.of(8));
            const entered = deferred<void>();
            const input = options();

            input.buildReserved = () => {
                entered.resolve();
                return gate.promise;
            };

            const run = {};
            const pending = f.send(input, run);
            await value(entered.promise);
            expect(() => beginReferenceSend(f.token, f.attempt, f.lease, {})).toThrow();
            gate.resolve(Uint8Array.of(8));
            expect(await value(pending)).toEqual(observed);
            const next = {};
            beginReferenceSend(f.token, f.attempt, f.lease, next);
            endReferenceSend(f.token, f.attempt, f.lease, next);
        }));

    it.each([
        'identity',
        'swap',
        'context',
        'skip',
        'double-build',
        'double-verify',
        'double-consume',
        'wrong-result',
    ] as const)('guard rejects %s callback interference', (mode) =>
        withFixture(async (f) => {
            f.activate();
            f.mode(mode);
            expect(await value(f.send())).toEqual({
                kind: 'failure',
                code: 'borrowed-transaction-failed',
                writeState: 'unknown',
            });
            const expectedPhases: Record<Mode, Phase[]> = {
                normal: ['build', 'verify', 'consume', 'result'],
                skip: [],
                identity: ['build', 'verify'],
                context: ['build', 'verify'],
                swap: ['build', 'verify', 'consume'],
                'double-build': ['build'],
                'double-verify': ['build', 'verify'],
                'double-consume': ['build', 'verify', 'consume'],
                'wrong-result': ['build', 'verify', 'consume', 'result'],
            };
            expect(f.calls).toBe(1);
            expect(f.phases).toEqual(expectedPhases[mode]);
            expect(f.frames).toHaveLength(mode === 'skip' ? 0 : 1);

            if (mode === 'skip' || mode === 'wrong-result') {
                expect(f.caught).toEqual([]);
            } else {
                expect(f.caught).toHaveLength(1);
                expect(f.caught[0]).toBeInstanceOf(Error);
                expect((f.caught[0] as Error).message).toBe('invalid borrowed raw transaction');
            }
        }),
    );

    it.each(
        (['signer', 'verifier', 'consume', 'result'] as const).flatMap((phase) =>
            (['token', 'attempt'] as const).map((stop) => [phase, stop] as const),
        ),
    )('suppresses observed result on %s pending %s stop', (phase, stop) =>
        withFixture(async (f) => {
            f.activate();
            const input = options();
            const entered = deferred<void>();
            const release = f.gate<void>(undefined);

            if (phase === 'signer') {
                input.buildReserved = async () => {
                    entered.resolve();
                    await release.promise;
                    return Uint8Array.of(8);
                };
            }

            if (phase === 'verifier') {
                input.verifyRaw = async () => {
                    entered.resolve();
                    await release.promise;
                    return true;
                };
            }

            if (phase === 'consume') {
                f.holdConsume(async () => {
                    entered.resolve();
                    await release.promise;
                });
            }

            if (phase === 'result') {
                f.holdResult(async () => {
                    entered.resolve();
                    await release.promise;
                });
            }

            const pending = f.send(input);
            await value(entered.promise);

            if (stop === 'token') {
                revokeReferenceKey(f.token);
            } else {
                f.attempt.close();
            }

            release.resolve();
            expect(await value(pending)).toMatchObject({ kind: 'failure' });
            expect(f.frames).toHaveLength(phase === 'signer' ? 0 : 1);
        }),
    );

    it('checks the slot again before invoking the borrowed transport', () =>
        withFixture(async (f) => {
            f.activate();
            const input = options();
            const run = {};
            const realNow = performance.now.bind(performance);
            let hits = 0;
            const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
                if (!hits && new Error().stack?.includes('withinDeadline')) {
                    try {
                        assertReferenceSendIdentity(f.token, f.attempt, f.lease, run, '0', '123');
                        hits++;
                        revokeReferenceKey(f.token);
                    } catch {
                        /* the slot may not yet have been acquired */
                    }
                }

                return realNow();
            });

            try {
                expect(await value(f.send(input, run))).toMatchObject({ kind: 'failure' });
                expect(hits).toBe(1);
                expect(f.calls).toBe(0);
                expect(f.frames).toHaveLength(0);
            } finally {
                clock.mockRestore();
            }
        }));

    it('checks revocation during the final delivery clock after consume', () =>
        withFixture(async (f) => {
            f.activate();
            const input = options();
            const realNow = performance.now.bind(performance);
            let hits = 0;
            const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
                const stack = new Error().stack ?? '';

                if (
                    !hits &&
                    f.phases.includes('result') &&
                    /at referenceUnregisterOnTransport \(/.test(stack)
                ) {
                    hits++;
                    revokeReferenceKey(f.token);
                }

                return realNow();
            });

            try {
                expect(await value(f.send(input))).toMatchObject({ kind: 'failure' });
                expect(hits).toBe(1);
                expect(f.phases).toContain('consume');
                expect(f.frames).toHaveLength(1);
            } finally {
                clock.mockRestore();
            }
        }));

    it.each(['revoke', 'abort'] as const)(
        'suppresses delivery when abort-listener disposal triggers %s',
        (action) =>
            withFixture(async (f) => {
                f.activate();
                const controller = new AbortController();
                const input = options();
                input.signal = controller.signal;
                const original = AbortSignal.prototype.removeEventListener;
                let hits = 0;
                const spy = vi
                    .spyOn(AbortSignal.prototype, 'removeEventListener')
                    .mockImplementation(function (
                        this: AbortSignal,
                        ...args: Parameters<AbortSignal['removeEventListener']>
                    ) {
                        if (
                            this === controller.signal &&
                            args[0] === 'abort' &&
                            f.phases.includes('result') &&
                            !hits
                        ) {
                            hits++;

                            if (action === 'revoke') {
                                revokeReferenceKey(f.token);
                            } else {
                                controller.abort();
                            }
                        }

                        return Reflect.apply(original, this, args);
                    });

                try {
                    expect(await value(f.send(input))).toMatchObject({ kind: 'failure' });
                    expect(hits).toBe(1);
                    expect(f.phases).toEqual(['build', 'verify', 'consume', 'result']);
                    expect(f.frames).toHaveLength(1);
                } finally {
                    spy.mockRestore();
                    controller.abort();
                }
            }),
    );

    it.each(['signer', 'verifier'] as const)('rejects synchronous revocation within %s', (phase) =>
        withFixture(async (f) => {
            f.activate();
            const input = options();

            if (phase === 'signer') {
                input.buildReserved = () => {
                    revokeReferenceKey(f.token);
                    return Uint8Array.of(8);
                };
            } else {
                input.verifyRaw = () => {
                    revokeReferenceKey(f.token);
                    return true;
                };
            }

            expect(await value(f.send(input))).toMatchObject({ kind: 'failure' });
            expect(f.frames).toHaveLength(phase === 'signer' ? 0 : 1);
        }),
    );

    it.each(['signer', 'verifier'] as const)(
        'keeps a replacement run on synchronous %s reentry',
        (phase) =>
            withFixture(async (f) => {
                f.activate();
                const first = {};
                const replacement = {};
                const input = options();

                const reenter = () => {
                    endReferenceSend(f.token, f.attempt, f.lease, first);
                    beginReferenceSend(f.token, f.attempt, f.lease, replacement);
                };

                if (phase === 'signer') {
                    input.buildReserved = () => {
                        reenter();
                        return Uint8Array.of(8);
                    };
                } else {
                    input.verifyRaw = () => {
                        reenter();
                        return true;
                    };
                }

                expect(await value(f.send(input, first))).toMatchObject({ kind: 'failure' });
                expect(
                    assertReferenceSendIdentity(
                        f.token,
                        f.attempt,
                        f.lease,
                        replacement,
                        '0',
                        '123',
                    ),
                ).toBeUndefined();
                endReferenceSend(f.token, f.attempt, f.lease, replacement);
            }),
    );

    it.each(['signer', 'verifier'] as const)(
        'wipes temporary %s views after cancellation and late settlement',
        (phase) =>
            withFixture(async (f) => {
                f.activate();
                const input = options();
                const abort = new AbortController();
                input.signal = abort.signal;
                const entered = deferred<void>();
                const release = f.gate<void>(undefined);
                const views: Uint8Array[] = [];
                const original = [input.login.tickets.d2Key, input.profile.guid, f.candidate];
                const snapshots = original.map((b) => Uint8Array.from(b));

                if (phase === 'signer') {
                    input.buildReserved = async ({ body }) => {
                        views.push(body);
                        entered.resolve();
                        await release.promise;
                        return Uint8Array.of(8);
                    };
                } else {
                    input.verifyRaw = async ({ requestFrame, responseFrame }) => {
                        views.push(requestFrame, responseFrame);
                        entered.resolve();
                        await release.promise;
                        return true;
                    };
                }

                f.detachOnAbort();
                const pending = f.send(input);

                try {
                    await value(entered.promise);
                    abort.abort();
                    expect(await value(pending)).toMatchObject({ kind: 'failure' });

                    for (const view of views) {
                        expect(view.length).toBeGreaterThan(0);
                        expect(view.every((b) => b === 0)).toBe(true);
                    }

                    release.resolve();
                    const callbackPhase = phase === 'signer' ? 'build' : 'verify';
                    await value(f.callbackDone[callbackPhase].promise);
                    expect(f.callbackSettlements).toContainEqual({
                        phase: callbackPhase,
                        state: 'rejected',
                    });
                    expect(f.callbackErrors).toHaveLength(1);
                    expect(f.callbackErrors[0].phase).toBe(callbackPhase);
                    expect(f.callbackErrors[0].error).toBeInstanceOf(Error);
                    expect((f.callbackErrors[0].error as Error).message).toBe(
                        'invalid reference send binding',
                    );

                    for (const view of views) {
                        expect(view.every((b) => b === 0)).toBe(true);
                    }

                    original.forEach((bytes, index) =>
                        expect(Uint8Array.from(bytes)).toEqual(snapshots[index]),
                    );
                    expect(f.frames).toHaveLength(phase === 'signer' ? 0 : 1);
                } finally {
                    abort.abort();
                    release.resolve();
                }
            }),
    );

    it('returns cancellation before beginning a run when the import is pending', () =>
        withFixture(async (f) => {
            f.activate();
            const controller = new AbortController();
            const input = options();
            input.signal = controller.signal;
            input.buildReserved = vi.fn(input.buildReserved);
            input.verifyRaw = vi.fn(input.verifyRaw);
            const run = {};
            const readsBefore = f.reads;

            try {
                const pending = f.send(input, run);
                controller.abort();
                expect(await value(pending)).toEqual(cancelled);
                expect(f.reads - readsBefore).toBe(1);
                expect(f.calls).toBe(0);
                expect(f.phases).toEqual([]);
                expect(f.frames).toHaveLength(0);
                expect(input.buildReserved).not.toHaveBeenCalled();
                expect(input.verifyRaw).not.toHaveBeenCalled();
                beginReferenceSend(f.token, f.attempt, f.lease, run);
                endReferenceSend(f.token, f.attempt, f.lease, run);
            } finally {
                controller.abort();
            }
        }));

    it('returns pre-abort before getter and capability validation', () =>
        withFixture(async (f) => {
            f.activate();
            const abort = new AbortController();
            abort.abort();
            const input = options();
            input.signal = abort.signal;
            const before = f.reads;
            expect(
                await value(
                    f.track(
                        referenceUnregisterWithCapability(
                            { token: {}, attempt: f.attempt, lease: f.lease, run: {} },
                            input,
                        ),
                    ),
                ),
            ).toEqual(cancelled);
            expect(f.reads).toBe(before);
            expect(f.calls).toBe(0);
        }));

    it('honors abort from the initial clock before reading the getter', () =>
        withFixture(async (f) => {
            f.activate();
            const abort = new AbortController();
            const input = options();
            input.signal = abort.signal;
            const before = f.reads;
            const clock = vi.spyOn(performance, 'now').mockImplementationOnce(() => {
                abort.abort();
                return 1;
            });

            try {
                expect(await value(f.send(input))).toEqual(cancelled);
                expect(f.reads).toBe(before);
            } finally {
                clock.mockRestore();
            }
        }));

    it('rechecks captured signal after the getter, including signal deletion', () =>
        withFixture(async (f) => {
            f.activate();
            const abort = new AbortController();
            const input = options();
            input.signal = abort.signal;
            f.getter(() => {
                abort.abort();
                delete input.signal;
            });
            expect(await value(f.send(input))).toEqual(cancelled);
            expect(f.calls).toBe(0);
            expect(f.frames).toHaveLength(0);
        }));

    it('preserves getter exception precedence over its abort', () =>
        withFixture(async (f) => {
            f.activate();
            const abort = new AbortController();
            const input = options();
            input.signal = abort.signal;
            f.getter(() => {
                abort.abort();
                throw new Error('synthetic getter');
            });
            await rejected(f.send(input), 'invalid borrowed transport');
            expect(f.calls).toBe(0);
        }));

    it('captures top-level options before getter even without a signal', () =>
        withFixture(async (f) => {
            f.activate();
            const abort = new AbortController();
            abort.abort();
            const input = options();
            f.getter(() => {
                input.signal = abort.signal;
                input.uid = '';
            });
            expect(await value(f.send(input))).toEqual(observed);
            expect(f.calls).toBe(1);
        }));

    it('snapshots nested options after the getter even when a signal is present', () =>
        withFixture(async (f) => {
            f.activate();
            const input = options();
            input.signal = new AbortController().signal;
            input.buildReserved = vi.fn(input.buildReserved);
            const readsBefore = f.reads;
            f.getter(() => {
                input.login.tickets.d2Key[0] ^= 1;
            });
            await failed(f.send(input));
            expect(f.reads - readsBefore).toBe(1);
            expect(input.login.tickets.d2Key[0]).toBe(key[0] ^ 1);
            expect(f.calls).toBe(0);
            expect(f.phases).toEqual([]);
            expect(input.buildReserved).not.toHaveBeenCalled();
            expect(f.frames).toHaveLength(0);
        }));

    it('keeps the public getter before the options snapshot', () =>
        withFixture(async (f) => {
            const abort = new AbortController();
            abort.abort();
            const input = options();
            f.getter(() => {
                input.signal = abort.signal;
            });
            expect(await value(f.track(referenceUnregisterOnTransport(f.lease, input)))).toEqual(
                cancelled,
            );
            expect(f.calls).toBe(0);
        }));

    it('captures top-level fields with signal before the getter, but nested values afterwards', () =>
        withFixture(async (f) => {
            f.activate();
            const input = options();
            input.signal = new AbortController().signal;
            f.getter(() => {
                input.uid = '';
            });
            expect(await value(f.send(input))).toEqual(observed);
            expect(f.calls).toBe(1);
        }));
});
