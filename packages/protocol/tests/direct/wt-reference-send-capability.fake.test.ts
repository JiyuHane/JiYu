import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RawSessionLease } from '../../src/direct/raw-session-broker';
import { createWtEcdh } from '../../src/direct/wt-ecdh';
import {
    bindReferenceKeyCapability,
    createBorrowedWtReferenceLoginAttempt,
    type BorrowedWtReferenceLoginAttempt,
} from '../../src/direct/wt-reference-login-attempt';
import {
    assertReferenceSendIdentity,
    beginReferenceSend,
    bindReferenceKeyAttempt,
    commitReferenceKey,
    createReferenceKeyCapability,
    endReferenceSend,
    referenceKeyState,
    reserveReferenceKeyCapability,
    revokeReferenceKey,
    stageReferenceConfirmed,
    stageReferenceKey,
} from '../../src/direct/wt-reference-session-private';

// Synthetic in-process identities and key only. No traffic or real signer runs.
// This is local capability coordination, not peer authentication or isolation
// against arbitrary code within this process.
const attempts: BorrowedWtReferenceLoginAttempt[] = [];
const peer = createWtEcdh(Buffer.concat([Buffer.alloc(23), Buffer.of(2)]));

function unboundOwner(signal?: AbortSignal) {
    const lease: RawSessionLease = {
        whenClosed: new Promise(() => {}),
        transactRaw: vi.fn(() => {
            throw new Error('unexpected fixture transaction');
        }),
        release: vi.fn(),
        poison: vi.fn(),
        close: vi.fn(),
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
        timeoutMs: 1000,
        attemptTimeoutMs: 10000,
        signal,
        getTimestamp: () => 10,
        buildReserved: () => new Uint8Array(),
        verifyRaw: () => true,
        verifyContext: () => true,
        sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
    });
    attempts.push(attempt);
    const token = createReferenceKeyCapability();
    const reservation = reserveReferenceKeyCapability(token);
    return { token, attempt, lease, reservation };
}

function owner() {
    const value = unboundOwner();
    bindReferenceKeyCapability(value.attempt, value.token, value.reservation);
    return value;
}

function stage(value: ReturnType<typeof owner>) {
    const key = new Uint8Array(16).fill(0x5a);
    stageReferenceConfirmed(value.token, value.attempt, '0', '123', 41);
    stageReferenceKey(value.token, value.attempt, '0', '123', 42, key);
    key.fill(0);
}

function activate(value: ReturnType<typeof owner>) {
    stage(value);
    commitReferenceKey(value.token);
}

afterEach(() => {
    for (const attempt of attempts.splice(0)) {
        attempt.close();
    }
});

describe('WT reference send capability (in-memory fixture)', () => {
    it('stages and commits the real private slot without exposing a key', () => {
        const value = owner();
        expect(referenceKeyState(value.token)).toBe('empty');
        stage(value);
        expect(referenceKeyState(value.token)).toBe('tentative');
        expect(commitReferenceKey(value.token)).toBeUndefined();
        expect(referenceKeyState(value.token)).toBe('active');
        revokeReferenceKey(value.token);
        expect(referenceKeyState(value.token)).toBe('revoked');
        expect(value.lease.transactRaw).not.toHaveBeenCalled();
    });

    it('rejects binding a borrowed attempt already closed', () => {
        const value = unboundOwner();
        value.attempt.close();
        expect(value.attempt.getState()).toBe('closed');
        expect(() =>
            bindReferenceKeyCapability(value.attempt, value.token, value.reservation),
        ).toThrow();
        expect(() => beginReferenceSend(value.token, value.attempt, value.lease, {})).toThrow();
        expect(value.lease.transactRaw).not.toHaveBeenCalled();
    });

    it('rejects binding a borrowed attempt failed by a pre-aborted signal', () => {
        const controller = new AbortController();
        controller.abort();
        const value = unboundOwner(controller.signal);
        expect(value.attempt.getState()).toBe('failed');
        expect(() =>
            bindReferenceKeyCapability(value.attempt, value.token, value.reservation),
        ).toThrow();
        expect(() => beginReferenceSend(value.token, value.attempt, value.lease, {})).toThrow();
        expect(value.lease.transactRaw).not.toHaveBeenCalled();
    });

    it('rejects binding while a borrowed fetch is pending on a fake lease', async () => {
        const value = unboundOwner();
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.mocked(value.lease.transactRaw).mockImplementation(async () => {
            entered();
            await gate;
            return { kind: 'failure', code: 'fixture', writeState: 'not-written' };
        });
        const pending = value.attempt
            .fetch({
                packageName: 'p',
                ptVersion: 'v',
                miscBitMap: 1,
                ssoVersion: 1,
                d1: Uint8Array.of(1),
            })
            .then(
                () => 'resolved',
                () => 'rejected',
            );

        try {
            const reachedLease = await Promise.race([
                started.then(() => true),
                pending.then(() => false),
            ]);
            expect(reachedLease).toBe(true);
            expect(() =>
                bindReferenceKeyCapability(value.attempt, value.token, value.reservation),
            ).toThrow();
            expect(() => beginReferenceSend(value.token, value.attempt, value.lease, {})).toThrow();
        } finally {
            release();
            await pending;
            value.attempt.close();
        }

        expect(await pending).toBe('rejected');
        expect(value.lease.transactRaw).toHaveBeenCalledTimes(1);
    });

    it.each(['state', 'busy'] as const)(
        'rejects a borrowed attempt with an own %s accessor without reading it',
        (property) => {
            const value = unboundOwner();
            const descriptor = Object.getOwnPropertyDescriptor(value.attempt, property);
            let reads = 0;
            Object.defineProperty(value.attempt, property, {
                configurable: true,
                get() {
                    reads++;
                    throw new Error('unexpected accessor');
                },
            });

            try {
                expect(() =>
                    bindReferenceKeyCapability(value.attempt, value.token, value.reservation),
                ).toThrow();
                expect(() =>
                    beginReferenceSend(value.token, value.attempt, value.lease, {}),
                ).toThrow();
                expect(reads).toBe(0);
            } finally {
                if (descriptor) {
                    Object.defineProperty(value.attempt, property, descriptor);
                } else {
                    Reflect.deleteProperty(value.attempt, property);
                }
            }

            expect(value.lease.transactRaw).not.toHaveBeenCalled();
        },
    );

    it('does not invoke an overridden getState getter during binding', () => {
        const value = unboundOwner();
        let reads = 0;
        Object.defineProperty(value.attempt, 'getState', {
            configurable: true,
            get() {
                reads++;
                throw new Error('unexpected accessor');
            },
        });

        try {
            // Binding may either reject the override or rely on guarded own state.
            try {
                bindReferenceKeyCapability(value.attempt, value.token, value.reservation);
            } catch {
                // Both outcomes are acceptable only if the getter was never invoked.
            }

            expect(reads).toBe(0);
        } finally {
            Reflect.deleteProperty(value.attempt, 'getState');
        }

        expect(value.lease.transactRaw).not.toHaveBeenCalled();
    });

    it('does not grant a send lease through the legacy three-argument binding', () => {
        const token = createReferenceKeyCapability();
        const attempt = {};
        const lease = {};
        const reservation = reserveReferenceKeyCapability(token);
        bindReferenceKeyAttempt(token, attempt, reservation);
        stageReferenceConfirmed(token, attempt, '0', '123', 41);
        stageReferenceKey(token, attempt, '0', '123', 42, new Uint8Array(16).fill(0x5a));
        commitReferenceKey(token);
        expect(() => beginReferenceSend(token, attempt, lease, {})).toThrow();
        expect(referenceKeyState(token)).toBe('active');
        revokeReferenceKey(token);
    });

    it('rejects begin while empty or tentative without changing phase', () => {
        const value = owner();
        const run = {};
        expect(() => beginReferenceSend(value.token, value.attempt, value.lease, run)).toThrow();
        expect(referenceKeyState(value.token)).toBe('empty');
        stage(value);
        expect(() => beginReferenceSend(value.token, value.attempt, value.lease, run)).toThrow();
        expect(referenceKeyState(value.token)).toBe('tentative');
        commitReferenceKey(value.token);
        expect(beginReferenceSend(value.token, value.attempt, value.lease, run)).toBeUndefined();
        expect(endReferenceSend(value.token, value.attempt, value.lease, run)).toBeUndefined();
    });

    it('binds transport and confirmed identities and serializes distinct runs', () => {
        const value = owner();
        activate(value);
        const first = {};
        const second = {};
        expect(beginReferenceSend(value.token, value.attempt, value.lease, first)).toBeUndefined();
        expect(
            assertReferenceSendIdentity(value.token, value.attempt, value.lease, first, '0', '123'),
        ).toBeUndefined();
        expect(() => beginReferenceSend(value.token, value.attempt, value.lease, first)).toThrow();
        expect(() => beginReferenceSend(value.token, value.attempt, value.lease, second)).toThrow();
        expect(() => endReferenceSend(value.token, value.attempt, value.lease, second)).toThrow();
        expect(
            assertReferenceSendIdentity(value.token, value.attempt, value.lease, first, '0', '123'),
        ).toBeUndefined();
        expect(endReferenceSend(value.token, value.attempt, value.lease, first)).toBeUndefined();
        expect(() =>
            assertReferenceSendIdentity(value.token, value.attempt, value.lease, first, '0', '123'),
        ).toThrow();
        expect(() => beginReferenceSend(value.token, value.attempt, value.lease, first)).toThrow();
        expect(beginReferenceSend(value.token, value.attempt, value.lease, second)).toBeUndefined();
        expect(() => beginReferenceSend(value.token, value.attempt, value.lease, first)).toThrow();
        expect(() => endReferenceSend(value.token, value.attempt, value.lease, first)).toThrow();
        expect(
            assertReferenceSendIdentity(
                value.token,
                value.attempt,
                value.lease,
                second,
                '0',
                '123',
            ),
        ).toBeUndefined();
        expect(endReferenceSend(value.token, value.attempt, value.lease, second)).toBeUndefined();
        expect(value.lease.transactRaw).not.toHaveBeenCalled();
    });

    it('holds a real capability run behind a fake gate until it ends', async () => {
        const value = owner();
        activate(value);
        const first = {};
        const second = {};
        const events: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const firstTask = (async () => {
            beginReferenceSend(value.token, value.attempt, value.lease, first);
            events.push('first begin');
            await gate;
            assertReferenceSendIdentity(value.token, value.attempt, value.lease, first, '0', '123');
            endReferenceSend(value.token, value.attempt, value.lease, first);
            events.push('first end');
        })();

        try {
            expect(() =>
                beginReferenceSend(value.token, value.attempt, value.lease, second),
            ).toThrow();
        } finally {
            release();
        }

        await firstTask;
        beginReferenceSend(value.token, value.attempt, value.lease, second);
        events.push('second begin');
        assertReferenceSendIdentity(value.token, value.attempt, value.lease, second, '0', '123');
        endReferenceSend(value.token, value.attempt, value.lease, second);
        events.push('second end');
        expect(events).toEqual(['first begin', 'first end', 'second begin', 'second end']);
        expect(value.lease.transactRaw).not.toHaveBeenCalled();
    });

    it('rejects token, attempt, lease, run and cross-owner substitution', () => {
        const a = owner();
        const b = owner();
        activate(a);
        activate(b);
        const run = {};
        const otherRun = {};
        expect(() => beginReferenceSend({}, a.attempt, a.lease, run)).toThrow();
        expect(() => beginReferenceSend(a.token, b.attempt, a.lease, run)).toThrow();
        expect(() => beginReferenceSend(a.token, a.attempt, b.lease, run)).toThrow();
        expect(() => beginReferenceSend(b.token, a.attempt, a.lease, run)).toThrow();
        beginReferenceSend(a.token, a.attempt, a.lease, run);
        beginReferenceSend(b.token, b.attempt, b.lease, otherRun);
        expect(() =>
            assertReferenceSendIdentity(a.token, a.attempt, a.lease, otherRun, '0', '123'),
        ).toThrow();
        expect(() =>
            assertReferenceSendIdentity(b.token, a.attempt, a.lease, run, '0', '123'),
        ).toThrow();
        expect(() => endReferenceSend(a.token, b.attempt, a.lease, run)).toThrow();
        expect(() => endReferenceSend(a.token, a.attempt, b.lease, run)).toThrow();
        expect(() => endReferenceSend(a.token, a.attempt, a.lease, otherRun)).toThrow();
        expect(
            assertReferenceSendIdentity(a.token, a.attempt, a.lease, run, '0', '123'),
        ).toBeUndefined();
        expect(
            assertReferenceSendIdentity(b.token, b.attempt, b.lease, otherRun, '0', '123'),
        ).toBeUndefined();
        endReferenceSend(a.token, a.attempt, a.lease, run);
        endReferenceSend(b.token, b.attempt, b.lease, otherRun);
    });

    it('matches account identifiers literally rather than normalizing them', () => {
        const value = owner();
        activate(value);
        const run = {};
        beginReferenceSend(value.token, value.attempt, value.lease, run);

        for (const [transport, confirmed] of [
            ['00', '123'],
            ['0', '0123'],
            ['1', '123'],
            ['0', '124'],
            ['ABC', '123'],
            ['abc', '123'],
            ['0', 'ABC'],
            ['0', 'abc'],
        ]) {
            expect(() =>
                assertReferenceSendIdentity(
                    value.token,
                    value.attempt,
                    value.lease,
                    run,
                    transport,
                    confirmed,
                ),
            ).toThrow();
        }

        expect(
            assertReferenceSendIdentity(value.token, value.attempt, value.lease, run, '0', '123'),
        ).toBeUndefined();
        endReferenceSend(value.token, value.attempt, value.lease, run);
    });

    it('fences checks and new runs after revoke while allowing old-run cleanup', () => {
        const value = owner();
        activate(value);
        const run = {};
        beginReferenceSend(value.token, value.attempt, value.lease, run);
        expect(
            assertReferenceSendIdentity(value.token, value.attempt, value.lease, run, '0', '123'),
        ).toBeUndefined();
        revokeReferenceKey(value.token);
        expect(referenceKeyState(value.token)).toBe('revoked');
        expect(() =>
            assertReferenceSendIdentity(value.token, value.attempt, value.lease, run, '0', '123'),
        ).toThrow();
        expect(endReferenceSend(value.token, value.attempt, value.lease, run)).toBeUndefined();
        expect(() => beginReferenceSend(value.token, value.attempt, value.lease, {})).toThrow();
        expect(referenceKeyState(value.token)).toBe('revoked');
    });

    it('rejects proxy and accessor arguments without invoking them', () => {
        const value = owner();
        activate(value);
        let traps = 0;
        const proxy = new Proxy(
            {},
            {
                get() {
                    traps++;
                    throw new Error('proxy get');
                },
                getPrototypeOf() {
                    traps++;
                    throw new Error('proxy prototype');
                },
                ownKeys() {
                    traps++;
                    throw new Error('proxy keys');
                },
            },
        );
        const accessor = Object.defineProperty({}, 'uin', {
            get() {
                traps++;
                throw new Error('accessor');
            },
        });
        const run = {};
        expect(() => beginReferenceSend(proxy, value.attempt, value.lease, run)).toThrow();
        expect(() => beginReferenceSend(value.token, proxy, value.lease, run)).toThrow();
        expect(() => beginReferenceSend(value.token, value.attempt, proxy, run)).toThrow();
        expect(() => beginReferenceSend(value.token, value.attempt, value.lease, proxy)).toThrow();
        beginReferenceSend(value.token, value.attempt, value.lease, run);

        for (const hostile of [proxy, accessor]) {
            expect(() =>
                assertReferenceSendIdentity(
                    value.token,
                    value.attempt,
                    value.lease,
                    run,
                    hostile as unknown as string,
                    '123',
                ),
            ).toThrow();
            expect(() =>
                assertReferenceSendIdentity(
                    value.token,
                    value.attempt,
                    value.lease,
                    run,
                    '0',
                    hostile as unknown as string,
                ),
            ).toThrow();
        }

        expect(traps).toBe(0);
        expect(
            assertReferenceSendIdentity(value.token, value.attempt, value.lease, run, '0', '123'),
        ).toBeUndefined();
        endReferenceSend(value.token, value.attempt, value.lease, run);
    });
});
