import { describe, expect, it, vi } from 'vitest';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import { qqTeaEncrypt } from '../../src/direct/qq-tea';
import type {
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
} from '../../src/direct/sso12-packet-client';
import {
    referenceSendTextOnTransport,
    referenceSendTextWithCapability,
    type SsoReferenceSendTextOptions,
} from '../../src/direct/sso-reference-send-text-flow';
import { createWtEcdh } from '../../src/direct/wt-ecdh';
import {
    bindReferenceKeyCapability,
    createBorrowedWtReferenceLoginAttempt,
} from '../../src/direct/wt-reference-login-attempt';
import {
    commitReferenceKey,
    createReferenceKeyCapability,
    reserveReferenceKeyCapability,
    revokeReferenceKey,
    referenceKeyState,
    stageReferenceConfirmed,
    stageReferenceKey,
} from '../../src/direct/wt-reference-session-private';

const cancelled = { kind: 'failure', code: 'raw-cancelled', writeState: 'not-written' };
const key = new Uint8Array(16).fill(1);

function responseFrame(sequence: number): Uint8Array {
    const word = (value: number) => {
        const bytes = Buffer.alloc(4);
        bytes.writeUInt32BE(value >>> 0);
        return bytes;
    };

    const field = (value: Uint8Array) => Buffer.concat([word(value.length + 4), value]);
    const header = Buffer.concat([
        word(sequence),
        word(0),
        field(Buffer.alloc(0)),
        field(Buffer.from('MessageSvc.PbSendMsg')),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    const cipher = qqTeaEncrypt(Buffer.concat([field(header), field(Buffer.alloc(0))]), key);
    const uin = Buffer.from('123');
    return Buffer.concat([
        word(14 + uin.length + cipher.length),
        word(12),
        Buffer.of(1, 0),
        field(uin),
        cipher,
    ]);
}

function fixture() {
    const write = vi.fn();
    const sign = vi.fn(() => Uint8Array.of(8));
    const verify = vi.fn(() => true);
    const transact = vi.fn(
        async <C, T>(_raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> => {
            write();
            return { kind: 'failure', code: 'synthetic', writeState: 'not-written' };
        },
    );
    let closeClient!: (value: unknown) => void;
    const client = {
        transactRaw: transact,
        close: vi.fn(() => closeClient('closed')),
        whenClosed: new Promise<unknown>((resolve) => {
            closeClient = resolve;
        }),
    } as unknown as Sso12RawClient;
    const broker = createRawSessionBroker(client, {
        trustedSuccessQuiescence: true,
        isUsable: () => true,
    });
    const lease = broker.acquire({ deadline: performance.now() + 30000 });
    const peer = createWtEcdh(Buffer.concat([Buffer.alloc(23), Buffer.of(2)]));
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
    const token = createReferenceKeyCapability();
    const reservation = reserveReferenceKeyCapability(token);
    bindReferenceKeyCapability(attempt, token, reservation);
    stageReferenceConfirmed(token, attempt, '0', '123', 41);
    stageReferenceKey(token, attempt, '0', '123', 42, Uint8Array.from(key));
    commitReferenceKey(token);
    const options: SsoReferenceSendTextOptions = {
        login: {
            status: 'tickets',
            uin: '123',
            tickets: {
                d2: Uint8Array.of(1),
                d2Key: Uint8Array.from(key),
                a1: Uint8Array.of(2),
                a2: Uint8Array.of(3),
            },
        },
        profile: { subAppId: 42, guid: Uint8Array.of(1), version: 'fixture' },
        uid: 'uid',
        request: {
            route: { kind: 'private', peerUin: 456n, peerUid: 'peer' },
            text: 'fixture',
            clientSequence: 1n,
            random: 1,
        },
        timeoutMs: 3000,
        maxResponseBodyBytes: 65536,
        buildReserved: sign,
        verifyRaw: verify,
    };
    const method = lease.transactRaw;
    let reads = 0;

    let onRead = () => {};

    Object.defineProperty(lease, 'transactRaw', {
        configurable: true,
        get() {
            reads++;
            onRead();
            return method;
        },
    });
    return {
        lease,
        token,
        attempt,
        options,
        sign,
        verify,
        write,
        transact,
        get reads() {
            return reads;
        },
        onRead(fn: () => void) {
            onRead = fn;
        },
        send(input = options) {
            return referenceSendTextWithCapability({ token, attempt, lease, run: {} }, input);
        },
        close() {
            attempt.close();
            revokeReferenceKey(token);
            lease.close();
        },
    };
}

describe('capability signal preflight (synthetic)', () => {
    it('observes abort in the initial clock before reading the lease getter', async () => {
        const f = fixture();
        const controller = new AbortController();
        f.options.signal = controller.signal;
        const clock = vi.spyOn(performance, 'now').mockImplementationOnce(() => {
            controller.abort();
            return 1;
        });

        try {
            const pending = f.send();
            expect(pending).toBeInstanceOf(Promise);
            expect(await pending).toEqual(cancelled);
            expect(f.reads).toBe(0);
            expect(f.sign).not.toHaveBeenCalled();
            expect(f.write).not.toHaveBeenCalled();
        } finally {
            clock.mockRestore();
            f.close();
        }
    });

    it('blocks signing when the assertActive clock synchronously aborts the signal', async () => {
        const f = fixture();
        const controller = new AbortController();
        f.options.signal = controller.signal;
        let clockHits = 0;
        let stateAtClock: ReturnType<typeof referenceKeyState> | undefined;
        const realNow = performance.now.bind(performance);
        f.transact.mockImplementation(async (raw) => {
            await raw.buildRequest({ uin: '0', sequence: 1 });
            return { kind: 'failure', code: 'synthetic', writeState: 'not-written' };
        });
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
            if (!clockHits && new Error().stack?.includes('assertActive')) {
                clockHits++;
                stateAtClock = referenceKeyState(f.token);
                controller.abort();
            }

            return realNow();
        });

        try {
            const result = await f.send();
            expect(result.kind).toBe('failure');
            expect(clockHits).toBe(1);
            expect(stateAtClock).toBe('active');
            expect(f.sign).not.toHaveBeenCalled();
            expect(f.write).not.toHaveBeenCalled();
        } finally {
            clock.mockRestore();
            f.close();
        }
    });

    it('suppresses a completed response when the final clock aborts its signal', async () => {
        const f = fixture();
        const controller = new AbortController();
        f.options.signal = controller.signal;
        const identity = { uin: '0', sequence: 1 };
        const response = responseFrame(identity.sequence);
        let clientReturned = false;
        let stateAtClock: ReturnType<typeof referenceKeyState> | undefined;
        let verifiedAtClock = 0;
        let hits = 0;
        f.transact.mockImplementation(async (raw) => {
            const built = await raw.buildRequest(identity);
            f.write();

            if (!(await raw.verifyCandidate(response, built.context, identity))) {
                throw new Error('synthetic verification failure');
            }

            const value = await raw.consumeCandidate(response, built.context, identity);
            clientReturned = true;
            return { kind: 'response', sequence: identity.sequence, value, writeState: 'written' };
        });
        const now = performance.now.bind(performance);
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
            const stack = new Error().stack ?? '';

            if (
                clientReturned &&
                !hits &&
                /Performance\.now[^\n]*\n\s*at exchangeCore \(/.test(stack)
            ) {
                hits++;
                stateAtClock = referenceKeyState(f.token);
                verifiedAtClock = f.verify.mock.calls.length;
                controller.abort();
            }

            return now();
        });

        try {
            const result = await f.send();
            expect(hits).toBe(1);
            expect(stateAtClock).toBe('active');
            expect(verifiedAtClock).toBe(1);
            expect(f.sign).toHaveBeenCalledOnce();
            expect(f.write).toHaveBeenCalledOnce();
            expect(result).toEqual({
                kind: 'failure',
                code: 'borrowed-transaction-failed',
                writeState: 'unknown',
            });
        } finally {
            clock.mockRestore();
            f.close();
        }
    });

    it('rechecks the captured signal after the getter aborts', async () => {
        const f = fixture();
        const controller = new AbortController();
        f.options.signal = controller.signal;
        f.onRead(() => {
            controller.abort();
            delete f.options.signal;
        });

        try {
            expect(await f.send()).toEqual(cancelled);
            expect(f.reads).toBe(1);
            expect(f.transact).not.toHaveBeenCalled();
            expect(f.sign).not.toHaveBeenCalled();
            expect(f.write).not.toHaveBeenCalled();
        } finally {
            f.close();
        }
    });

    it('preserves the transport error if its getter aborts and throws', async () => {
        const f = fixture();
        const controller = new AbortController();
        f.options.signal = controller.signal;
        f.onRead(() => {
            controller.abort();
            throw new Error('synthetic getter');
        });

        try {
            await expect(f.send()).rejects.toThrow('invalid borrowed transport');
            expect(f.reads).toBe(1);
            expect(f.transact).not.toHaveBeenCalled();
            expect(f.sign).not.toHaveBeenCalled();
            expect(f.write).not.toHaveBeenCalled();
        } finally {
            f.close();
        }
    });

    it.each(['key', 'uin'] as const)(
        'rejects a getter mutation of the nested %s against the active slot before signing',
        async (field) => {
            const f = fixture();
            f.options.signal = new AbortController().signal;
            let buildCalls = 0;
            f.transact.mockImplementation(async (raw) => {
                buildCalls++;
                await raw.buildRequest({ uin: '0', sequence: 1 });
                f.write();
                return { kind: 'failure', code: 'synthetic', writeState: 'not-written' };
            });
            f.onRead(() => {
                expect(referenceKeyState(f.token)).toBe('active');

                if (field === 'key') {
                    f.options.login.tickets.d2Key.fill(2);
                } else {
                    Reflect.set(f.options.login, 'uin', '124');
                }
            });

            try {
                const result = await f.send();
                expect(result.kind).toBe('failure');
                expect(f.reads).toBe(1);
                expect(buildCalls).toBe(1);
                expect(f.sign).not.toHaveBeenCalled();
                expect(f.verify).not.toHaveBeenCalled();
                expect(f.write).not.toHaveBeenCalled();
            } finally {
                f.close();
            }
        },
    );

    it.each(['accessor', 'proxy-options', 'proxy-signal'] as const)(
        'fails %s without evaluating caller traps',
        async (kind) => {
            const f = fixture();
            const trap = vi.fn(() => {
                throw new Error('unexpected trap');
            });
            let input = f.options;

            if (kind === 'accessor') {
                Object.defineProperty(input, 'signal', { get: trap, configurable: true });
            }

            if (kind === 'proxy-options') {
                input = new Proxy(input, { get: trap, ownKeys: trap, getPrototypeOf: trap });
            }

            if (kind === 'proxy-signal') {
                input.signal = new Proxy(new AbortController().signal, {
                    get: trap,
                    getPrototypeOf: trap,
                });
            }

            try {
                await expect(f.send(input)).rejects.toThrow(TypeError);
                expect(trap).not.toHaveBeenCalled();
                expect(f.reads).toBe(0);
                expect(f.sign).not.toHaveBeenCalled();
                expect(f.write).not.toHaveBeenCalled();
            } finally {
                f.close();
            }
        },
    );

    it('keeps the post-getter options snapshot when signal was absent', async () => {
        const f = fixture();
        const controller = new AbortController();
        controller.abort();
        f.onRead(() => {
            f.options.signal = controller.signal;
        });

        try {
            expect(await f.send()).toEqual(cancelled);
            expect(f.reads).toBe(1);
            expect(f.transact).not.toHaveBeenCalled();
            expect(f.sign).not.toHaveBeenCalled();
            expect(f.write).not.toHaveBeenCalled();
        } finally {
            f.close();
        }
    });

    it('captures outer fields with signal, but validates nested fields after the getter', async () => {
        const outer = fixture();
        outer.options.signal = new AbortController().signal;
        outer.onRead(() => {
            outer.options.uid = '';
        });

        try {
            await outer.send();
            expect(outer.reads).toBe(1);
            expect(outer.transact).toHaveBeenCalledOnce();
            expect(outer.sign).not.toHaveBeenCalled();
        } finally {
            outer.close();
        }

        const nested = fixture();
        nested.options.signal = new AbortController().signal;
        nested.onRead(() => {
            Reflect.set(nested.options.login, 'uin', 'invalid');
        });

        try {
            await expect(nested.send()).rejects.toThrow('invalid send-text configuration');
            expect(nested.reads).toBe(1);
            expect(nested.transact).not.toHaveBeenCalled();
            expect(nested.sign).not.toHaveBeenCalled();
            expect(nested.write).not.toHaveBeenCalled();
        } finally {
            nested.close();
        }
    });

    it('does not infer signal cancellation from token-only revocation in the clock', async () => {
        const f = fixture();
        f.options.signal = new AbortController().signal;
        const started = performance.now();
        const clock = vi.spyOn(performance, 'now').mockImplementationOnce(() => {
            revokeReferenceKey(f.token);
            return started;
        });

        try {
            await expect(f.send()).rejects.toThrow();
            expect(f.reads).toBe(1);
            expect(f.transact).not.toHaveBeenCalled();
            expect(f.sign).not.toHaveBeenCalled();
            expect(f.write).not.toHaveBeenCalled();
        } finally {
            clock.mockRestore();
            f.close();
        }
    });

    it('reports pre-abort before capability ownership is validated', async () => {
        const f = fixture();
        const controller = new AbortController();
        controller.abort();
        f.options.signal = controller.signal;

        try {
            const result = await referenceSendTextWithCapability(
                { token: {}, attempt: f.attempt, lease: f.lease, run: {} },
                f.options,
            );
            expect(result).toEqual(cancelled);
            expect(f.reads).toBe(0);
            expect(f.transact).not.toHaveBeenCalled();
        } finally {
            f.close();
        }
    });

    it('retains public clock then getter then options ordering and one promise', async () => {
        const f = fixture();
        const controller = new AbortController();
        const order: string[] = [];
        f.options.signal = controller.signal;
        f.onRead(() => {
            order.push('getter');
        });
        const clock = vi.spyOn(performance, 'now').mockImplementationOnce(() => {
            order.push('clock');
            controller.abort();
            return 1;
        });

        try {
            const pending = referenceSendTextOnTransport(f.lease, f.options);
            expect(pending).toBeInstanceOf(Promise);
            expect(await pending).toEqual(cancelled);
            expect(order).toEqual(['clock', 'getter']);
            expect(f.reads).toBe(1);
            expect(f.transact).not.toHaveBeenCalled();
        } finally {
            clock.mockRestore();
            f.close();
        }
    });
});
