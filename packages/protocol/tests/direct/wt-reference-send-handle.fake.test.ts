import { getEventListeners } from 'node:events';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
} from '../../src/direct/sso12-packet-client';
import {
    createWtReferenceSession,
    createWtReferenceSessionWithCapability,
    type WtReferenceSession,
    type WtReferenceSessionOptions,
} from '../../src/direct/wt-reference-session';
import type { RawSessionLease } from '../../src/direct/raw-session-broker';
import {
    createReferenceKeyCapability,
    referenceKeyState,
    revokeReferenceKey,
    takeReferenceSessionSend,
    type ReferenceSessionSendInput,
} from '../../src/direct/wt-reference-session-private';
import * as privateModule from '../../src/direct/wt-reference-session-private';
import { fetchBody, parseWt, peer, replyWt } from './fixtures/wt-sso-synthetic';

// In-memory fixture only. No network transport or external signer is used.
// The synthetic fetch reply exercises the existing peer fixture, not online login.
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

class MemoryClient implements Sso12RawClient {
    readonly closed = deferred<Sso12CloseReason>();
    readonly whenClosed = this.closed.promise;
    readonly entered = deferred<void>();
    readonly resume = deferred<void>();
    readonly events: string[] = [];
    readonly close = vi.fn(() => {
        this.events.push('close');
        this.closed.resolve({ kind: 'local', code: 'fixture' });
    });
    gate = false;
    external = false;
    sequence = 50;

    async transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        this.events.push('transact');
        const sequence = this.sequence++;
        const identity = { uin: '0', sequence };

        try {
            const built = await options.buildRequest(identity);
            this.events.push('build');
            this.entered.resolve();

            if (this.gate) {
                await this.resume.promise;
            }

            if (this.external) {
                const candidate = Uint8Array.of(3, 4);

                if (!(await options.verifyCandidate(candidate, built.context, identity))) {
                    return { kind: 'failure', code: 'fixture-rejection', writeState: 'unknown' };
                }

                const value = await options.consumeCandidate(candidate, built.context, identity);
                return { kind: 'response', sequence, value, writeState: 'written' };
            }

            const request = parseWt(built.frame);

            try {
                if (request.kind !== 0x31) {
                    throw new Error('fixture only supports synthetic fetch');
                }

                const body = fetchBody();
                const candidate = replyWt(request, body);
                body.fill(0);
                this.events.push('candidate');

                if (!(await options.verifyCandidate(candidate, built.context, identity))) {
                    return { kind: 'failure', code: 'fixture-rejection', writeState: 'unknown' };
                }

                const value = await options.consumeCandidate(candidate, built.context, identity);
                return { kind: 'response', sequence, value, writeState: 'written' };
            } finally {
                request.shared.fill(0);
                request.business.fill(0);
            }
        } catch {
            return { kind: 'failure', code: 'fixture-failure', writeState: 'unknown' };
        }
    }
}

const fetchFields = {
    packageName: 'p',
    ptVersion: 'v',
    miscBitMap: 1,
    ssoVersion: 1,
    d1: Uint8Array.of(1),
};

function fixture(signal?: AbortSignal) {
    const client = new MemoryClient();
    const broker = createRawSessionBroker(client, {
        trustedSuccessQuiescence: true,
        isUsable: () => true,
    });
    const lease = broker.acquire({ deadline: performance.now() + 10000 });
    const token = createReferenceKeyCapability();
    const effects = {
        wtSigner: vi.fn(() => new Uint8Array()),
        wtVerifier: vi.fn(() => true),
        registerSigner: vi.fn(() => Uint8Array.of(8)),
        registerVerifier: vi.fn(() => true),
    };
    const options: WtReferenceSessionOptions = {
        profile: {
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
        },
        timeoutMs: 1000,
        attemptTimeoutMs: 5000,
        signal,
        getTimestamp: () => 10,
        buildWtReserved: effects.wtSigner,
        verifyRaw: effects.wtVerifier,
        verifyContext: ({ requestUin, responseUin }) => requestUin === responseUin,
        sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
        registration: {
            version: 'build-v',
            deviceName: 'name',
            deviceType: 'type',
            vendorOs: 'os',
            random: 4,
        },
        buildRegisterReserved: effects.registerSigner,
        verifyRegisterRaw: effects.registerVerifier,
    };

    const cleanup = () => {
        client.resume.resolve();
        revokeReferenceKey(token);
        lease.release();
        client.close();
    };

    fixtures.push(cleanup);
    return { client, broker, lease, token, options, effects, fetchFields };
}

const fixtures: Array<() => void> = [];
const owners: WtReferenceSession[] = [];

function createOwner(value: ReturnType<typeof fixture>, lease = value.lease) {
    const owner = createWtReferenceSessionWithCapability(lease, value.options, value.token);
    owners.push(owner);
    return owner;
}

const input: ReferenceSessionSendInput = {
    request: {
        route: { kind: 'group', groupUin: 123n },
        text: 'fixture',
        clientSequence: 1n,
        random: 1,
    },
    maxResponseBodyBytes: 1024,
};

function handleFor(value: ReturnType<typeof fixture>, owner: WtReferenceSession) {
    const handle = takeReferenceSessionSend(value.token, owner, value.lease);
    expect(handle).toBeTypeOf('function');

    if (!handle) {
        throw new Error('missing send handle');
    }

    return handle;
}

function expectNoEffects(value: ReturnType<typeof fixture>) {
    expect(value.client.events).toEqual([]);
    expect(value.effects.wtSigner).not.toHaveBeenCalled();
    expect(value.effects.wtVerifier).not.toHaveBeenCalled();
    expect(value.effects.registerSigner).not.toHaveBeenCalled();
    expect(value.effects.registerVerifier).not.toHaveBeenCalled();
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function ownerClosureLease(value: ReturnType<typeof fixture>, second: () => unknown) {
    let reads = 0;
    const lease: RawSessionLease = {
        get whenClosed() {
            reads++;
            return (
                reads === 1 ? value.lease.whenClosed : second()
            ) as RawSessionLease['whenClosed'];
        },
        transactRaw: (options) => value.lease.transactRaw(options),
        release: () => value.lease.release(),
        poison: () => value.lease.poison(),
        close: () => value.lease.close(),
    };
    return { lease, reads: () => reads };
}

afterEach(() => {
    for (const owner of owners.splice(0)) {
        owner.close();
    }

    for (const cleanup of fixtures.splice(0)) {
        cleanup();
    }
});

describe('WT reference owner send handle (in-memory fixture)', () => {
    it('constructs an empty real capability and an independently borrowed lease', () => {
        const value = fixture();
        expect(referenceKeyState(value.token)).toBe('empty');
        expect(value.client.events).toEqual([]);
        expect(() => value.broker.acquire({ deadline: performance.now() + 1000 })).toThrow();
    });

    it('takes once using the exact token, owner and borrowed lease', () => {
        const value = fixture();
        const owner = createOwner(value);
        const handle = handleFor(value, owner);
        expect(handle).toBeTypeOf('function');
        expect(takeReferenceSessionSend(value.token, owner, value.lease)).toBeUndefined();
        expectNoEffects(value);
    });

    it('does not burn either exact claim for wrong token, owner or lease', () => {
        const a = fixture();
        const b = fixture();
        const ownerA = createOwner(a);
        const ownerB = createOwner(b);
        const otherToken = createReferenceKeyCapability();

        try {
            expect(takeReferenceSessionSend({}, ownerA, a.lease)).toBeUndefined();
            expect(takeReferenceSessionSend(otherToken, ownerA, a.lease)).toBeUndefined();
            expect(takeReferenceSessionSend(b.token, ownerA, a.lease)).toBeUndefined();
            expect(takeReferenceSessionSend(a.token, ownerB, a.lease)).toBeUndefined();
            expect(takeReferenceSessionSend(a.token, ownerA, b.lease)).toBeUndefined();
            expect(handleFor(a, ownerA)).not.toBe(handleFor(b, ownerB));
            expect(takeReferenceSessionSend(a.token, ownerA, a.lease)).toBeUndefined();
            expect(takeReferenceSessionSend(b.token, ownerB, b.lease)).toBeUndefined();
            expectNoEffects(a);
            expectNoEffects(b);
        } finally {
            revokeReferenceKey(otherToken);
        }
    });

    it('revokes a retained handle synchronously on idle close without effects', async () => {
        const value = fixture();
        const owner = createOwner(value);
        const handle = handleFor(value, owner);
        const poison = vi.spyOn(value.lease, 'poison');
        owner.close();
        expect(referenceKeyState(value.token)).toBe('revoked');
        expect(owner.getState()).toBe('closed');
        expect(takeReferenceSessionSend(value.token, owner, value.lease)).toBeUndefined();
        const result = handle(input);
        expect(result).toBeInstanceOf(Promise);
        await expect(result).rejects.toThrow();
        await expect(handle(input)).rejects.toThrow();
        expectNoEffects(value);
        expect(poison).not.toHaveBeenCalled();
        value.lease.release();
        expect(await value.lease.whenClosed).toBe('released');
    });

    it('cannot disturb a later borrowed-lease transaction through a retained old handle', async () => {
        const value = fixture();
        const owner = createOwner(value);
        const send = handleFor(value, owner);
        const poison = vi.spyOn(value.lease, 'poison');
        owner.close();
        value.client.gate = true;
        value.client.external = true;
        const external = value.lease.transactRaw({
            timeoutMs: 1000,
            buildRequest: () => ({ frame: Uint8Array.of(1), context: null }),
            verifyCandidate: () => true,
            consumeCandidate: () => 'external-result',
        });
        await value.client.entered.promise;
        await expect(send(input)).rejects.toThrow();
        expect(value.client.events.filter((event) => event === 'transact')).toHaveLength(1);
        expect(poison).not.toHaveBeenCalled();
        expect(value.effects.registerSigner).not.toHaveBeenCalled();
        expect(value.effects.registerVerifier).not.toHaveBeenCalled();
        value.client.resume.resolve();
        expect(await external).toMatchObject({ kind: 'response', value: 'external-result' });
        expect(poison).not.toHaveBeenCalled();
        value.lease.release();
        expect(await value.lease.whenClosed).toBe('released');
    });

    it('keeps two owner handles isolated after one owner closes', async () => {
        const a = fixture();
        const b = fixture();
        const ownerA = createOwner(a);
        const ownerB = createOwner(b);
        const sendA = handleFor(a, ownerA);
        const sendB = handleFor(b, ownerB);
        ownerA.close();
        await expect(sendA(input)).rejects.toThrow();
        expect(referenceKeyState(a.token)).toBe('revoked');
        expect(referenceKeyState(b.token)).toBe('empty');
        await expect(sendB(input)).rejects.toThrow('session not registered');
        expect(ownerB.getState()).toBe('new');
        expectNoEffects(a);
        expectNoEffects(b);
        expect((await ownerB.fetch(b.fetchFields)).qrUrl).toBe('https://example.invalid/qr');
        expect(ownerB.getState()).toBe('qr-ready');
        expect(a.client.events).toEqual([]);
    });

    it('rejects before login without a transaction or poisoning a later fetch', async () => {
        const value = fixture();
        const owner = createOwner(value);
        const send = handleFor(value, owner);
        const poison = vi.spyOn(value.lease, 'poison');
        await expect(send(input)).rejects.toThrow('session not registered');
        expect(owner.getState()).toBe('new');
        expect(referenceKeyState(value.token)).toBe('empty');
        expectNoEffects(value);
        expect(poison).not.toHaveBeenCalled();
        expect((await owner.fetch(value.fetchFields)).qrUrl).toBe('https://example.invalid/qr');
        expect(owner.getState()).toBe('qr-ready');
        expect(value.client.events.filter((event) => event === 'transact')).toHaveLength(1);
        expect(poison).not.toHaveBeenCalled();
    });

    it('gates hostile inputs before reading them while pre-login, then permits fetch', async () => {
        const value = fixture();
        const owner = createOwner(value);
        const send = handleFor(value, owner);
        let traps = 0;
        const proxy = new Proxy(input, {
            get() {
                traps++;
                throw new Error('unexpected get');
            },
            ownKeys() {
                traps++;
                throw new Error('unexpected ownKeys');
            },
            getPrototypeOf() {
                traps++;
                throw new Error('unexpected getPrototypeOf');
            },
        });
        const accessor = Object.defineProperty({}, 'request', {
            get() {
                traps++;
                throw new Error('unexpected accessor');
            },
        }) as ReferenceSessionSendInput;
        const invalidLimits = [-1, 65537, NaN, Infinity, 0.5];

        for (const hostile of [
            proxy,
            accessor,
            ...invalidLimits.map((maxResponseBodyBytes) => ({ ...input, maxResponseBodyBytes })),
        ]) {
            await expect(send(hostile)).rejects.toThrow('session not registered');
        }

        expect(traps).toBe(0);
        expect(owner.getState()).toBe('new');
        expectNoEffects(value);
        expect((await owner.fetch(value.fetchFields)).qrUrl).toBe('https://example.invalid/qr');
    });

    it('rejects a concurrent pre-login handle call while a synthetic fetch is gated', async () => {
        const value = fixture();
        const owner = createOwner(value);
        const send = handleFor(value, owner);
        value.client.gate = true;
        const fetching = owner.fetch(value.fetchFields);
        await value.client.entered.promise;
        await expect(send(input)).rejects.toThrow('session not registered');
        expect(value.client.events.filter((event) => event === 'transact')).toHaveLength(1);
        expect(value.effects.registerSigner).not.toHaveBeenCalled();
        expect(value.effects.registerVerifier).not.toHaveBeenCalled();
        value.client.resume.resolve();
        expect((await fetching).qrUrl).toBe('https://example.invalid/qr');
        expect(owner.getState()).toBe('qr-ready');
    });

    it('fails construction for a pre-aborted signal and poisons the borrowed lease', async () => {
        const controller = new AbortController();
        controller.abort();
        const value = fixture(controller.signal);
        expect(() => createOwner(value)).toThrow();
        expect(referenceKeyState(value.token)).toBe('revoked');
        expect(await value.lease.whenClosed).toBe('poisoned');
        expect(value.client.events).toEqual(['close']);
        expect(value.effects.registerSigner).not.toHaveBeenCalled();
        expect(value.effects.registerVerifier).not.toHaveBeenCalled();
    });

    it.each(['abort', 'revoke'] as const)(
        'stops before borrowing when the first deadline clock triggers %s',
        async (reason) => {
            const controller = new AbortController();
            const value = fixture(controller.signal);
            let transactReads = 0;
            let closedReads = 0;
            let poisonCalls = 0;
            const lease: RawSessionLease = {
                get whenClosed() {
                    closedReads++;
                    return value.lease.whenClosed;
                },
                get transactRaw() {
                    transactReads++;
                    return value.lease.transactRaw;
                },
                release: () => value.lease.release(),
                poison: () => {
                    poisonCalls++;
                    value.lease.poison();
                },
                close: () => value.lease.close(),
            };
            const originalNow = performance.now.bind(performance);
            let triggered = false;
            let listenerCount = -1;
            const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
                if (!triggered) {
                    triggered = true;
                    listenerCount = getEventListeners(controller.signal, 'abort').length;

                    if (reason === 'abort') {
                        controller.abort();
                    } else {
                        revokeReferenceKey(value.token);
                    }
                }

                return originalNow();
            });

            try {
                expect(() => createOwner(value, lease)).toThrow();
                expect(triggered).toBe(true);
                expect(listenerCount).toBe(0);
                expect(transactReads).toBe(0);
                expect(closedReads).toBe(0);
                expect(poisonCalls).toBe(1);
                expect(referenceKeyState(value.token)).toBe('revoked');
                expect(value.client.events.filter((event) => event === 'transact')).toHaveLength(0);
                expect(value.effects.wtSigner).not.toHaveBeenCalled();
                expect(value.effects.wtVerifier).not.toHaveBeenCalled();
                expect(value.effects.registerSigner).not.toHaveBeenCalled();
                expect(value.effects.registerVerifier).not.toHaveBeenCalled();
            } finally {
                clock.mockRestore();
            }

            expect(await value.lease.whenClosed).toBe('poisoned');
        },
    );

    it('stops construction after a clock-triggered abort before rereading whenClosed', async () => {
        const controller = new AbortController();
        const value = fixture(controller.signal);
        const getterStates: boolean[] = [];
        const lease: RawSessionLease = {
            get whenClosed() {
                getterStates.push(controller.signal.aborted);
                return value.lease.whenClosed;
            },
            transactRaw: (options) => value.lease.transactRaw(options),
            release: () => value.lease.release(),
            poison: () => value.lease.poison(),
            close: () => value.lease.close(),
        };
        const originalNow = performance.now.bind(performance);
        let triggered = false;
        let abortClockRead = 0;
        let clockReads = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
            clockReads++;

            // The borrowed attempt observes its own signal, not this outer signal.
            // Wait for the owner listener, then abort during its next clock read.
            if (!triggered && getEventListeners(controller.signal, 'abort').length > 0) {
                triggered = true;
                abortClockRead = clockReads;
                controller.abort();
            }

            return originalNow();
        });
        const timers = vi.spyOn(globalThis, 'setTimeout');
        const clears = vi.spyOn(globalThis, 'clearTimeout');

        try {
            expect(() => createOwner(value, lease)).toThrow();
            expect(triggered).toBe(true);
            expect(abortClockRead).toBeGreaterThan(0);
            // The first access is the borrowed attempt's pre-abort observation.
            expect(getterStates).toEqual([false]);
            expect(referenceKeyState(value.token)).toBe('revoked');
            expect(
                takeReferenceSessionSend(value.token, {} as WtReferenceSession, lease),
            ).toBeUndefined();
            expect(value.client.events.filter((event) => event === 'transact')).toHaveLength(0);
            expect(value.effects.wtSigner).not.toHaveBeenCalled();
            expect(value.effects.wtVerifier).not.toHaveBeenCalled();
            expect(value.effects.registerSigner).not.toHaveBeenCalled();
            expect(value.effects.registerVerifier).not.toHaveBeenCalled();

            const cleared = new Set(clears.mock.calls.map(([timer]) => timer));

            for (const result of timers.mock.results) {
                expect(result.type).toBe('return');

                if (result.type === 'return') {
                    expect(cleared.has(result.value)).toBe(true);
                }
            }
        } finally {
            clock.mockRestore();
            timers.mockRestore();
            clears.mockRestore();
        }

        expect(await value.lease.whenClosed).toBe('poisoned');
    });

    it('clears a timer whose creation synchronously aborts before returning its handle', async () => {
        const controller = new AbortController();
        const value = fixture(controller.signal);
        const getterStates: boolean[] = [];
        const lease: RawSessionLease = {
            get whenClosed() {
                getterStates.push(controller.signal.aborted);
                return value.lease.whenClosed;
            },
            transactRaw: (options) => value.lease.transactRaw(options),
            release: () => value.lease.release(),
            poison: () => value.lease.poison(),
            close: () => value.lease.close(),
        };
        const originalSetTimeout = globalThis.setTimeout;
        let ownerTimer: ReturnType<typeof setTimeout> | undefined;
        let triggered = false;
        const clears = vi.spyOn(globalThis, 'clearTimeout');
        const timers = vi
            .spyOn(globalThis, 'setTimeout')
            .mockImplementation((callback, delay, ...args) => {
                const handle = originalSetTimeout(callback, delay, ...args);

                if (!triggered && getEventListeners(controller.signal, 'abort').length > 0) {
                    triggered = true;
                    ownerTimer = handle;
                    controller.abort();
                }

                return handle;
            });

        try {
            expect(() => createOwner(value, lease)).toThrow();
            expect(triggered).toBe(true);
            expect(ownerTimer).toBeDefined();
            expect(clears.mock.calls.some(([timer]) => timer === ownerTimer)).toBe(true);
            expect(getterStates).toEqual([false]);
            expect(referenceKeyState(value.token)).toBe('revoked');
            expect(value.client.events.filter((event) => event === 'transact')).toHaveLength(0);
            expect(value.effects.wtSigner).not.toHaveBeenCalled();
            expect(value.effects.wtVerifier).not.toHaveBeenCalled();
            expect(value.effects.registerSigner).not.toHaveBeenCalled();
            expect(value.effects.registerVerifier).not.toHaveBeenCalled();
        } finally {
            timers.mockRestore();
            clears.mockRestore();
        }

        expect(await value.lease.whenClosed).toBe('poisoned');
    });

    it('makes a retained timer callback inert when timer creation throws', async () => {
        const controller = new AbortController();
        const value = fixture(controller.signal);
        const getterStates: boolean[] = [];
        const lease: RawSessionLease = {
            get whenClosed() {
                getterStates.push(controller.signal.aborted);
                return value.lease.whenClosed;
            },
            transactRaw: (options) => value.lease.transactRaw(options),
            release: () => value.lease.release(),
            poison: () => value.lease.poison(),
            close: () => value.lease.close(),
        };
        const originalSetTimeout = globalThis.setTimeout;
        let retained: (() => void) | undefined;
        const revoke = vi.spyOn(privateModule, 'revokeReferenceKey');
        const timers = vi
            .spyOn(globalThis, 'setTimeout')
            .mockImplementation((callback, delay, ...args) => {
                if (getEventListeners(controller.signal, 'abort').length > 0) {
                    retained = () => callback(...args);
                    throw new Error('fixture retained callback before timer creation failed');
                }

                return originalSetTimeout(callback, delay, ...args);
            });

        try {
            expect(() => createOwner(value, lease)).toThrow();
            expect(retained).toBeDefined();
            expect(getterStates).toEqual([false]);
            expect(referenceKeyState(value.token)).toBe('revoked');
            expect(revoke).toHaveBeenCalled();
            const revocations = revoke.mock.calls.length;
            const events = [...value.client.events];
            retained!();
            retained!();
            expect(revoke).toHaveBeenCalledTimes(revocations);
            expect(value.client.events).toEqual(events);
            expect(value.effects.wtSigner).not.toHaveBeenCalled();
            expect(value.effects.wtVerifier).not.toHaveBeenCalled();
            expect(value.effects.registerSigner).not.toHaveBeenCalled();
            expect(value.effects.registerVerifier).not.toHaveBeenCalled();
        } finally {
            timers.mockRestore();
            revoke.mockRestore();
        }

        expect(await value.lease.whenClosed).toBe('poisoned');
    });

    it('fences abort during the second whenClosed getter before inspecting its thenable', async () => {
        const controller = new AbortController();
        const value = fixture(controller.signal);
        let thenReads = 0;
        let thenCalls = 0;
        const thenable = {
            get then() {
                thenReads++;

                return () => {
                    thenCalls++;
                };
            },
        };
        const wrapped = ownerClosureLease(value, () => {
            controller.abort();
            return thenable;
        });
        expect(() => createOwner(value, wrapped.lease)).toThrow();
        expect(wrapped.reads()).toBe(2);
        expect(thenReads).toBe(0);
        expect(thenCalls).toBe(0);
        expect(referenceKeyState(value.token)).toBe('revoked');
        expect(value.client.events.filter((event) => event === 'transact')).toHaveLength(0);
        expect(await value.lease.whenClosed).toBe('poisoned');
    });

    it('rejects a second whenClosed thenable without reading its then getter', async () => {
        const value = fixture();
        let thenReads = 0;
        let thenCalls = 0;
        const thenable = {
            get then() {
                thenReads++;

                return () => {
                    thenCalls++;
                };
            },
        };
        const wrapped = ownerClosureLease(value, () => thenable);
        expect(() => createOwner(value, wrapped.lease)).toThrow();
        expect(wrapped.reads()).toBe(2);
        expect(thenReads).toBe(0);
        expect(thenCalls).toBe(0);
        expect(referenceKeyState(value.token)).toBe('revoked');
        expect(value.client.events.filter((event) => event === 'transact')).toHaveLength(0);
        expect(await value.lease.whenClosed).toBe('poisoned');
    });

    it.each(['cross-realm', 'subclass', 'own-constructor', 'proxy'] as const)(
        'rejects a %s second whenClosed promise without executing user accessors',
        async (kind) => {
            const value = fixture();
            let traps = 0;
            let candidate: unknown;

            if (kind === 'cross-realm') {
                candidate = runInNewContext('new Promise(() => {})');
            } else if (kind === 'subclass') {
                class DerivedPromise extends Promise<never> {}
                candidate = new DerivedPromise(() => {});
            } else if (kind === 'own-constructor') {
                candidate = Object.defineProperty(new Promise(() => {}), 'constructor', {
                    get() {
                        traps++;
                        throw new Error('unexpected constructor getter');
                    },
                });
            } else {
                candidate = new Proxy(new Promise(() => {}), {
                    get() {
                        traps++;
                        throw new Error('unexpected proxy get');
                    },
                    getPrototypeOf() {
                        traps++;
                        throw new Error('unexpected proxy prototype');
                    },
                    getOwnPropertyDescriptor() {
                        traps++;
                        throw new Error('unexpected proxy descriptor');
                    },
                });
            }

            const wrapped = ownerClosureLease(value, () => candidate);
            expect(() => createOwner(value, wrapped.lease)).toThrow();
            expect(wrapped.reads()).toBe(2);
            expect(traps).toBe(0);
            expect(referenceKeyState(value.token)).toBe('revoked');
            expect(value.client.events.filter((event) => event === 'transact')).toHaveLength(0);
            expect(await value.lease.whenClosed).toBe('poisoned');
        },
    );

    it('keeps the public non-capability owner compatible with a second whenClosed thenable', async () => {
        const value = fixture();
        let thenReads = 0;
        let thenCalls = 0;
        const thenable = {
            get then() {
                thenReads++;

                return () => {
                    thenCalls++;
                };
            },
        };
        const wrapped = ownerClosureLease(value, () => thenable);
        const owner = createWtReferenceSession(wrapped.lease, value.options);
        owners.push(owner);
        await nextTurn();
        expect(wrapped.reads()).toBe(2);
        expect(thenReads).toBe(1);
        expect(thenCalls).toBe(1);
        expect(owner.getState()).toBe('new');
        owner.close();
        value.lease.release();
        expect(await value.lease.whenClosed).toBe('released');
    });

    it('fences a gated fetch and the retained handle after an abort', async () => {
        const controller = new AbortController();
        const value = fixture(controller.signal);
        const owner = createOwner(value);
        const send = handleFor(value, owner);
        value.client.gate = true;
        const fetching = owner.fetch(value.fetchFields).then(
            () => 'resolved',
            () => 'rejected',
        );

        try {
            await value.client.entered.promise;
            controller.abort();
            expect(await value.lease.whenClosed).toBe('poisoned');
            expect(await fetching).toBe('rejected');
            expect(referenceKeyState(value.token)).toBe('revoked');
            await expect(send(input)).rejects.toThrow();
            expect(value.effects.wtVerifier).not.toHaveBeenCalled();
            expect(value.effects.registerSigner).not.toHaveBeenCalled();
            expect(value.effects.registerVerifier).not.toHaveBeenCalled();
            value.client.resume.resolve();
            await nextTurn();
            expect(value.effects.wtVerifier).not.toHaveBeenCalled();
            expect(value.client.events.filter((event) => event === 'transact')).toHaveLength(1);
        } finally {
            value.client.resume.resolve();
        }
    });

    it('settles whenClosed before testing a retained handle after transport closure', async () => {
        const value = fixture();
        const owner = createOwner(value);
        const send = handleFor(value, owner);
        value.client.closed.resolve({ kind: 'local', code: 'fixture-external-close' });
        expect(await value.lease.whenClosed).toBe('poisoned');
        await nextTurn();
        expect(owner.getState()).toBe('failed');
        expect(referenceKeyState(value.token)).toBe('revoked');
        await expect(send(input)).rejects.toThrow();
        expect(value.client.events.filter((event) => event === 'transact')).toHaveLength(0);
        expect(value.effects.registerSigner).not.toHaveBeenCalled();
        expect(value.effects.registerVerifier).not.toHaveBeenCalled();
    });

    it('holds the exact reservation across a reentrant lease whenClosed getter', () => {
        const value = fixture();
        const other = fixture();
        const otherOwner = createOwner(other);
        const challenger = fixture();
        let reads = 0;
        let rejected = 0;
        const lease: RawSessionLease = {
            get whenClosed() {
                reads++;

                if (reads === 1) {
                    try {
                        createWtReferenceSessionWithCapability(
                            challenger.lease,
                            challenger.options,
                            value.token,
                        );
                    } catch {
                        rejected++;
                    }

                    expect(
                        takeReferenceSessionSend(value.token, otherOwner, other.lease),
                    ).toBeUndefined();
                }

                return value.lease.whenClosed;
            },
            transactRaw: (options) => value.lease.transactRaw(options),
            release: () => value.lease.release(),
            poison: () => value.lease.poison(),
            close: () => value.lease.close(),
        };
        const owner = createOwner(value, lease);
        expect(reads).toBeGreaterThan(0);
        expect(rejected).toBe(1);
        expect(takeReferenceSessionSend(value.token, owner, value.lease)).toBeUndefined();
        expect(takeReferenceSessionSend(value.token, owner, lease)).toBeTypeOf('function');
        expect(takeReferenceSessionSend(value.token, owner, lease)).toBeUndefined();
        const challengerOwner = createOwner(challenger);
        expect(handleFor(challenger, challengerOwner)).toBeTypeOf('function');
        expectNoEffects(value);
        expectNoEffects(other);
        expectNoEffects(challenger);
    });
});
