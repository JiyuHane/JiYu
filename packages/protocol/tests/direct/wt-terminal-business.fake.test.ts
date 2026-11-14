import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createRawMultiplexStream } from '../../src/direct/raw-multiplex-stream';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import { decodeServiceResponse } from '../../src/direct/service-frame';
import { decodeSsoResponse } from '../../src/direct/sso';
import { createWtMultiplexReference } from '../../src/direct/wt-multiplex-reference';
import { createBorrowedWtReferenceLoginAttempt } from '../../src/direct/wt-reference-login-attempt';
import * as referenceSessionPrivate from '../../src/direct/wt-reference-session-private';
import * as referenceTerminalPrivate from '../../src/direct/wt-reference-terminal-private';
import { encodeWtTlv } from '../../src/direct/wt-tlv';
import { fetchBody, parseWt, peer, pollBody, replyWt } from './fixtures/wt-sso-synthetic';

// Synthetic peer only; production codecs and the real stream/broker/guard are exercised.
const fetchFields = {
    packageName: 'p',
    ptVersion: 'v',
    miscBitMap: 1,
    ssoVersion: 1,
    d1: Uint8Array.of(1),
};
const loginFields = {
    mainSigMap: 1,
    miscBitMap: 2,
    subSigMap: 3,
    packageName: 'p',
    ptVersion: 'v',
    sdkVersion: 's',
    os: 'x',
    deviceName: 'd',
    apkSignature: Uint8Array.of(3),
    tlv124Value: new Uint8Array(12),
};
const profile = () => ({
    uin: '999',
    appId: 42,
    subAppId: 43,
    clientVersion: 44,
    guid: Uint8Array.of(1, 2),
    unknown21: new Uint8Array(21),
    randomKey: new Uint8Array(16).fill(7),
    peerPublicKey: peer.publicKey,
    ssoVersion: 'header-v',
    qrCommand: 'fixture.qr',
    loginCommand: 'fixture.login',
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function deadline<T>(promise: PromiseLike<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            Promise.resolve(promise),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`deadline: ${label}`)), 3000);
            }),
        ]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

function loginBody(state: number, errorCode?: number): Uint8Array {
    const code = Buffer.alloc(4);
    code.writeUInt32BE(errorCode ?? 0);
    return Buffer.concat([
        Buffer.of(0, 9, state),
        encodeWtTlv(
            errorCode === undefined
                ? []
                : [
                      {
                          tag: 0x146,
                          value: Buffer.concat([
                              code,
                              Buffer.of(0, 5),
                              Buffer.from('title'),
                              Buffer.of(0, 6),
                              Buffer.from('detail'),
                          ]),
                      },
                  ],
        ),
    ]);
}

class FakeStream extends EventEmitter {
    readable = true;
    writable = true;
    destroyed = false;
    readableFlowing: boolean | null = null;
    writableLength = 0;
    writableNeedDrain = false;
    writes = 0;
    destroys = 0;
    requests: Array<{ command: string; kind: number; sequence: number }> = [];
    pollCode = 0;
    loginState = 0;
    loginError: number | undefined;
    closeAfterReply = false;
    onDestroy: () => void = () => {};
    errors: unknown[] = [];

    constructor() {
        super();
        this.on('error', (error) => this.errors.push(error));
    }

    write(bytes: Uint8Array, callback: (error?: Error | null) => void): boolean {
        const copy = Uint8Array.from(bytes);
        queueMicrotask(() => {
            callback();
            this.writes++;
            let wt: ReturnType<typeof parseWt> | undefined;
            let body: Uint8Array | undefined;

            try {
                wt = parseWt(copy);
                this.requests.push({ command: wt.command, kind: wt.kind, sequence: wt.seq });
                body =
                    wt.kind === 0x31
                        ? fetchBody()
                        : wt.kind === 0x12
                          ? pollBody(this.pollCode)
                          : loginBody(this.loginState, this.loginError);
                const candidate = replyWt(wt, body);
                this.emit('data', candidate);

                if (this.closeAfterReply) {
                    this.finishClose();
                }
            } catch (error) {
                this.errors.push(error);
                this.emit('error', error);
            } finally {
                copy.fill(0);
                body?.fill(0);
                wt?.shared.fill(0);
                wt?.business.fill(0);
            }
        });
        return true;
    }

    destroy(): this {
        this.destroys++;
        this.destroyed = true;
        this.readable = false;
        this.writable = false;
        this.onDestroy();
        return this;
    }

    finishClose(): void {
        if (!this.destroyed) {
            this.destroy();
        }

        this.emit('close');
    }
}

type Phase = 'poll' | 'login';
type Gate = 'raw' | 'context';

function setup(
    options: {
        pollCode?: number;
        loginState?: number;
        loginError?: number;
        signal?: AbortSignal;
        gate?: { phase: Phase; kind: Gate; entered: () => void; wait: Promise<void> };
        reject?: { phase: Phase; kind: Gate };
        timeoutMs?: number;
        attemptTimeoutMs?: number;
        leaseTimeoutMs?: number;
    } = {},
) {
    const stream = new FakeStream();
    stream.pollCode = options.pollCode ?? 0;
    stream.loginState = options.loginState ?? 0;
    stream.loginError = options.loginError;
    const pushed: string[] = [];
    let pushVerification = 0;
    let registerSignatures = 0;
    const session = createWtMultiplexReference(stream, {
        exclusiveConnected: true,
        transportUin: '0',
        initialSequence: 50,
        maxFrameBytes: 65536,
        maxBufferedBytes: 262144,
        maxFrames: 16,
        maxPushFrames: 8,
        maxPushBytes: 262144,
        maxWriteBufferBytes: 262144,
        leaseTimeoutMs: options.leaseTimeoutMs ?? 20000,
        session: {
            profile: profile(),
            timeoutMs: options.timeoutMs ?? 10000,
            attemptTimeoutMs: options.attemptTimeoutMs ?? 15000,
            signal: options.signal,
            getTimestamp: () => 10,
            buildWtReserved: () => new Uint8Array(),
            verifyRaw: async ({ operation }) => {
                if (options.gate?.kind === 'raw' && options.gate.phase === operation) {
                    options.gate.entered();
                    await options.gate.wait;
                }

                return !(options.reject?.kind === 'raw' && options.reject.phase === operation);
            },
            verifyContext: async ({ operation, requestUin, responseUin }) => {
                if (options.gate?.kind === 'context' && options.gate.phase === operation) {
                    options.gate.entered();
                    await options.gate.wait;
                }

                return (
                    !(options.reject?.kind === 'context' && options.reject.phase === operation) &&
                    responseUin === requestUin
                );
            },
            sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
            registration: {
                version: 'build-v',
                deviceName: 'name',
                deviceType: 'type',
                vendorOs: 'os',
                random: 4,
            },
            buildRegisterReserved: () => {
                registerSignatures++;
                return new Uint8Array();
            },
            verifyRegisterRaw: () => true,
        },
        verifyPushRaw: () => {
            pushVerification++;
            return true;
        },
        onPush: (_frame, meta) => {
            pushed.push(meta.command);
        },
    });

    async function fetch() {
        expect((await deadline(session.fetch(fetchFields), 'fetch')).qrUrl).toBe(
            'https://example.invalid/qr',
        );
    }

    async function confirm() {
        await fetch();
        expect(await deadline(session.poll(), 'confirm')).toEqual({ status: 'confirmed' });
    }

    function noSideEffects(expectedCommands: string[]) {
        expect(stream.requests.map((request) => request.command)).toEqual(expectedCommands);
        expect(registerSignatures).toBe(0);
        expect(pushVerification).toBe(0);
        expect(pushed).toEqual([]);
        expect(stream.errors).toEqual([]);
    }

    async function cleanup() {
        session.close();
        stream.finishClose();
        await deadline(session.whenClosed, 'closed');
    }

    return { stream, session, fetch, confirm, noSideEffects, cleanup };
}

describe('WT terminal business results through a synthetic complete stream', () => {
    it.each([
        [17, 'expired'],
        [54, 'canceled'],
        [144, 'invalid'],
        [7, 'unknown'],
    ] as const)('retains poll code %i as %s', async (code, status) => {
        const fixture = setup({ pollCode: code });

        try {
            await fixture.fetch();
            expect(await deadline(fixture.session.poll(), 'terminal poll')).toEqual({
                status,
                code,
            });
            await deadline(fixture.session.whenClosed, 'terminal poll close');
            fixture.noSideEffects(['fixture.qr', 'fixture.qr']);
            await expect(fixture.session.poll()).rejects.toThrow();
            expect(fixture.stream.destroys).toBe(1);
        } finally {
            await fixture.cleanup();
        }
    });

    it.each([
        { state: 2, expected: { status: 'verification-required', state: 2 } },
        { state: 1, expected: { status: 'nonzero', state: 1 } },
        { state: 0, expected: { status: 'incomplete', state: 0 } },
        { state: 1, error: 42, expected: { status: 'error', state: 1, code: 42 } },
    ] as const)('retains login business result $expected.status', async (sample) => {
        const fixture = setup({
            loginState: sample.state,
            loginError: 'error' in sample ? sample.error : undefined,
        });

        try {
            await fixture.confirm();
            expect(
                await deadline(fixture.session.loginAndRegister(loginFields), 'terminal login'),
            ).toEqual(sample.expected);
            await deadline(fixture.session.whenClosed, 'terminal login close');
            fixture.noSideEffects(['fixture.qr', 'fixture.qr', 'fixture.login']);
            await expect(fixture.session.loginAndRegister(loginFields)).rejects.toThrow();
            expect(fixture.stream.destroys).toBe(1);
        } finally {
            await fixture.cleanup();
        }
    });

    it.each([
        ['poll', 'raw', 'close'],
        ['poll', 'raw', 'abort'],
        ['poll', 'raw', 'deadline'],
        ['poll', 'context', 'close'],
        ['poll', 'context', 'abort'],
        ['poll', 'context', 'deadline'],
        ['login', 'raw', 'close'],
        ['login', 'raw', 'abort'],
        ['login', 'raw', 'deadline'],
        ['login', 'context', 'close'],
        ['login', 'context', 'abort'],
        ['login', 'context', 'deadline'],
    ] as const)(
        'rejects %s business output when %s gate loses to %s',
        async (phase, kind, stop) => {
            const abort = new AbortController();
            let now = performance.now();
            const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
            const entered = deferred<void>();
            const release = deferred<void>();
            const fixture = setup({
                pollCode: phase === 'poll' ? 17 : 0,
                loginState: 2,
                signal: abort.signal,
                gate: { phase, kind, entered: () => entered.resolve(), wait: release.promise },
            });

            try {
                if (phase === 'poll') {
                    await fixture.fetch();
                } else {
                    await fixture.confirm();
                }

                const work =
                    phase === 'poll'
                        ? fixture.session.poll()
                        : fixture.session.loginAndRegister(loginFields);
                const rejected = expect(work).rejects.toThrow();
                await deadline(entered.promise, 'verifier entered');

                if (stop === 'close') {
                    fixture.session.close();
                } else if (stop === 'abort') {
                    abort.abort();
                } else {
                    now += 30000;
                }

                release.resolve();
                await deadline(rejected, 'race rejection');
                fixture.noSideEffects(
                    phase === 'poll'
                        ? ['fixture.qr', 'fixture.qr']
                        : ['fixture.qr', 'fixture.qr', 'fixture.login'],
                );
            } finally {
                release.resolve();

                try {
                    await fixture.cleanup();
                } finally {
                    clock.mockRestore();
                }
            }
        },
    );

    it.each([
        ['poll', 'raw'],
        ['poll', 'context'],
        ['login', 'raw'],
        ['login', 'context'],
    ] as const)(
        'does not turn a %s %s verification failure into a business result',
        async (phase, kind) => {
            const fixture = setup({
                pollCode: phase === 'poll' ? 17 : 0,
                loginState: 2,
                reject: { phase, kind },
            });

            try {
                if (phase === 'poll') {
                    await fixture.fetch();
                } else {
                    await fixture.confirm();
                }

                const work =
                    phase === 'poll'
                        ? fixture.session.poll()
                        : fixture.session.loginAndRegister(loginFields);
                await expect(deadline(work, 'verification failure')).rejects.toThrow();
                await deadline(fixture.session.whenClosed, 'verification failure close');
                fixture.noSideEffects(
                    phase === 'poll'
                        ? ['fixture.qr', 'fixture.qr']
                        : ['fixture.qr', 'fixture.qr', 'fixture.login'],
                );
            } finally {
                await fixture.cleanup();
            }
        },
    );

    it('does not preserve a business result when the stream closes in the reply stack', async () => {
        const fixture = setup({ pollCode: 17 });

        try {
            await fixture.fetch();
            fixture.stream.closeAfterReply = true;
            await expect(deadline(fixture.session.poll(), 'closed stream poll')).rejects.toThrow();
            fixture.noSideEffects(['fixture.qr', 'fixture.qr']);
        } finally {
            await fixture.cleanup();
        }
    });
});

// Instrumented fixture: spies pass through to the real private functions. This is
// a deliberate scheduling probe, not an uninstrumented production-path test.
describe('WT terminal stage-to-mux deadline scheduling probe', () => {
    it.each([
        ['poll', 'transaction', 'cross'],
        ['poll', 'transaction', 'control'],
        ['login', 'transaction', 'cross'],
        ['login', 'transaction', 'control'],
        ['poll', 'attempt-and-session', 'cross'],
        ['poll', 'attempt-and-session', 'control'],
        ['login', 'attempt-and-session', 'cross'],
        ['login', 'attempt-and-session', 'control'],
    ] as const)(
        '%s %s deadline: %s after real stage before mux continuation',
        async (phase, boundary, mode) => {
            const events: string[] = [];
            const leaseMs = 10000;
            const started = performance.now();
            const timeoutMs = boundary === 'transaction' ? 500 : 3000;
            const attemptTimeoutMs = boundary === 'transaction' ? 3000 : 600;
            const realTake = referenceTerminalPrivate.takeReferenceTerminal;
            const realStage = referenceSessionPrivate.stageReferenceBusinessFailure;
            let receipt: ReturnType<typeof realTake>;
            let stageTime = 0;
            let microStart = 0;
            let microEnd = 0;
            let target = 0;
            let stageResult: object | undefined;
            const take = vi
                .spyOn(referenceTerminalPrivate, 'takeReferenceTerminal')
                .mockImplementation((...args) => {
                    const actual = realTake(...args);
                    receipt = actual;
                    events.push(actual ? 'receipt' : 'missing-receipt');
                    return actual;
                });
            const stage = vi
                .spyOn(referenceSessionPrivate, 'stageReferenceBusinessFailure')
                .mockImplementation((...args) => {
                    realStage(...args);
                    stageResult = args[3];
                    stageTime = performance.now();
                    events.push('stage');
                    queueMicrotask(() => {
                        microStart = performance.now();
                        events.push('microtask');

                        if (receipt) {
                            target =
                                boundary === 'transaction'
                                    ? receipt.transactionDeadline
                                    : receipt.attemptDeadline;
                            const spinLimit = microStart + 1200;

                            if (mode === 'cross') {
                                while (
                                    performance.now() < target + 1 &&
                                    performance.now() < spinLimit
                                ) {
                                    // Bounded wall-clock scheduling probe; no global clock replacement.
                                }
                            }
                        }

                        microEnd = performance.now();
                    });
                });
            const fixture = setup({
                pollCode: phase === 'poll' ? 17 : 0,
                loginState: 2,
                timeoutMs,
                attemptTimeoutMs,
                leaseTimeoutMs: leaseMs,
            });

            try {
                if (phase === 'poll') {
                    await fixture.fetch();
                } else {
                    await fixture.confirm();
                }

                const work =
                    phase === 'poll'
                        ? fixture.session.poll()
                        : fixture.session.loginAndRegister(loginFields);
                const observed = work.then(
                    (value) => {
                        events.push('mux-resolved');
                        return value;
                    },
                    (error: unknown) => {
                        events.push('mux-rejected');
                        throw error;
                    },
                );

                if (mode === 'cross') {
                    await expect(deadline(observed, 'deadline probe')).rejects.toThrow();
                } else {
                    expect(await deadline(observed, 'deadline control')).toEqual(
                        phase === 'poll'
                            ? { status: 'expired', code: 17 }
                            : { status: 'verification-required', state: 2 },
                    );
                }

                expect(take).toHaveBeenCalledTimes(1);
                expect(stage).toHaveBeenCalledTimes(1);
                expect(receipt).toBeDefined();
                expect(stageResult).toBeDefined();
                expect(stage.mock.calls[0][1]).toBe(phase === 'poll' ? 'poll' : 'login-register');
                expect(stage.mock.calls[0][2]).toBe(
                    phase === 'poll' ? 'expired' : 'verification-required',
                );
                expect(events).toEqual([
                    'receipt',
                    'stage',
                    'microtask',
                    mode === 'cross' ? 'mux-rejected' : 'mux-resolved',
                ]);
                expect(target).toBeGreaterThan(stageTime);
                expect(microStart).toBeGreaterThanOrEqual(stageTime);
                expect(microEnd - microStart).toBeLessThan(1500);
                expect(microEnd).toBeLessThan(started + leaseMs);

                if (mode === 'cross') {
                    expect(microEnd).toBeGreaterThanOrEqual(target);
                } else {
                    expect(microEnd).toBeLessThan(target);
                }

                if (boundary === 'transaction') {
                    expect(receipt!.attemptDeadline).toBeGreaterThan(microEnd);
                } else {
                    // The owner deadline is earlier than or equal to the attempt
                    // deadline; this probe crosses both, not attempt in isolation.
                    expect(receipt!.transactionDeadline).toBeGreaterThan(microEnd);
                }

                fixture.noSideEffects(
                    phase === 'poll'
                        ? ['fixture.qr', 'fixture.qr']
                        : ['fixture.qr', 'fixture.qr', 'fixture.login'],
                );
            } finally {
                try {
                    await fixture.cleanup();
                } finally {
                    stage.mockRestore();
                    take.mockRestore();
                }
            }
        },
    );
});

describe('standalone borrowed WT attempt poison ordering', () => {
    it('poisons the genuine broker lease before resolving a terminal poll', async () => {
        const stream = new FakeStream();
        stream.pollCode = 17;
        const client = createRawMultiplexStream(stream, {
            exclusiveConnected: true,
            uin: '0',
            initialSequence: 50,
            defaultTimeoutMs: 10000,
            maxFrameBytes: 65536,
            maxBufferedBytes: 262144,
            maxFrames: 16,
            maxPushFrames: 8,
            maxPushBytes: 262144,
            maxWriteBufferBytes: 262144,
            classify: (frame) => ({
                kind: 'response',
                sequence:
                    decodeSsoResponse(decodeServiceResponse(frame, new Uint8Array(16)).body)
                        .sequence >>> 0,
            }),
            verifyPush: () => true,
            onPush: () => {},
        });
        const lease = createRawSessionBroker(client, {
            trustedSuccessQuiescence: true,
            isUsable: () => !client.closed,
        }).acquire({ deadline: performance.now() + 20000 });
        const events: string[] = [];
        const originalPoison = lease.poison;
        const poison = vi.spyOn(lease, 'poison').mockImplementation(() => {
            events.push('poison');
            originalPoison();
        });
        const attempt = createBorrowedWtReferenceLoginAttempt(lease, {
            profile: profile(),
            timeoutMs: 10000,
            attemptTimeoutMs: 15000,
            getTimestamp: () => 10,
            buildReserved: () => new Uint8Array(),
            verifyRaw: () => true,
            verifyContext: ({ requestUin, responseUin }) => requestUin === responseUin,
            sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
        });

        try {
            await deadline(attempt.fetch(fetchFields), 'borrowed fetch');
            const result = await deadline(
                attempt.poll().then((value) => {
                    events.push('resolved');
                    return value;
                }),
                'borrowed terminal poll',
            );
            expect(result).toEqual({ status: 'expired', code: 17 });
            expect(events).toEqual(['poison', 'resolved']);
            expect(await lease.whenClosed).toBe('poisoned');
            expect(attempt.getState()).toBe('failed');
            expect(poison).toHaveBeenCalledTimes(1);
            expect(stream.requests.map((request) => request.command)).toEqual([
                'fixture.qr',
                'fixture.qr',
            ]);
        } finally {
            attempt.close();
            lease.poison();
            client.close();
            stream.finishClose();
            await deadline(client.whenClosed, 'borrowed close');
            poison.mockRestore();
        }
    });
});
