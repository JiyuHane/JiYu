import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
} from '../../src/direct/sso12-packet-client';
import type { WtLoginResponse } from '../../src/direct/wt-login-response';
import {
    createBorrowedWtReferenceLoginAttempt,
    type BorrowedWtReferenceLoginAttemptOptions,
} from '../../src/direct/wt-reference-login-attempt';
import {
    fetchBody,
    loginReply,
    parseWt,
    peer,
    pollBody,
    replyWt,
} from './fixtures/wt-sso-synthetic';

// Only this decoder export is wrapped: it still parses the real synthetic response.
// The captured references are the exact returned arrays, not invented observations.
const decoderCapture = vi.hoisted(() => ({ login: undefined as WtLoginResponse | undefined }));
vi.mock('../../src/direct/wt-login-response', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/direct/wt-login-response')>();
    return {
        ...actual,
        decodeWtLoginResponse: (...args: Parameters<typeof actual.decodeWtLoginResponse>) => {
            const result = actual.decodeWtLoginResponse(...args);
            decoderCapture.login = result;
            return result;
        },
    };
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

// A raw client entirely in memory: no stream, listener, socket, or connect call.
// Frames are produced and parsed with the same real codecs as the neighboring fixtures.
class MemoryClient implements Sso12RawClient {
    readonly closed = deferred<Sso12CloseReason>();
    readonly whenClosed = this.closed.promise;
    readonly tasks: Promise<unknown>[] = [];
    readonly frames: Uint8Array[] = [];
    readonly frameCopies: Uint8Array[] = [];
    readonly requests: Uint8Array[] = [];
    readonly requestOicqs: Uint8Array[] = [];
    readonly close = vi.fn(() => this.closed.resolve({ kind: 'local', code: 'fixture' }));
    writes = 0;
    sequence = 50;

    transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        const work = this.exchange(options);
        this.tasks.push(work);
        return work;
    }

    private async exchange<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        const sequence = this.sequence++;
        const identity = { uin: '0', sequence };

        try {
            const built = await options.buildRequest(identity);
            this.writes++;
            const request = parseWt(built.frame);
            this.requests.push(Uint8Array.from(built.frame));
            this.requestOicqs.push(Uint8Array.from(request.oicq));
            let candidate: Uint8Array;

            try {
                const body =
                    request.kind === 0x31
                        ? fetchBody()
                        : request.kind === 0x12
                          ? pollBody(0)
                          : loginReply();
                candidate = replyWt(request, body);
                body.fill(0);
            } finally {
                request.shared.fill(0);
                request.business.fill(0);
            }

            this.frames.push(candidate);
            this.frameCopies.push(Uint8Array.from(candidate));

            if (!(await options.verifyCandidate(candidate, built.context, identity))) {
                return { kind: 'failure', code: 'fixture-denied', writeState: 'unknown' };
            }

            const value = await options.consumeCandidate(candidate, built.context, identity);
            return { kind: 'response', sequence, value, writeState: 'written' };
        } catch {
            return { kind: 'failure', code: 'fixture-callback', writeState: 'unknown' };
        }
    }
}

const fetchFields = {
    packageName: 'p',
    ptVersion: 'v',
    miscBitMap: 1,
    ssoVersion: 1,
    d1: Uint8Array.of(1, 2),
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
    apkSignature: Uint8Array.of(3, 4),
    tlv124Value: new Uint8Array(12).fill(8),
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) {
        await dispose();
    }

    decoderCapture.login = undefined;
});

function setup(overrides: Partial<BorrowedWtReferenceLoginAttemptOptions> = {}) {
    const client = new MemoryClient();
    const lease = createRawSessionBroker(client, {
        trustedSuccessQuiescence: true,
        isUsable: () => true,
    }).acquire({ deadline: performance.now() + 60000 });
    const options: BorrowedWtReferenceLoginAttemptOptions = {
        profile: {
            uin: '999',
            appId: 42,
            subAppId: 43,
            clientVersion: 44,
            guid: Uint8Array.of(1, 2),
            unknown21: new Uint8Array(21).fill(6),
            randomKey: new Uint8Array(16).fill(7),
            peerPublicKey: peer.publicKey,
            ssoVersion: 'v',
            qrCommand: 'fixture.qr',
            loginCommand: 'fixture.login',
        },
        timeoutMs: 30000,
        attemptTimeoutMs: 60000,
        getTimestamp: () => 10,
        buildReserved: () => new Uint8Array(),
        verifyRaw: () => true,
        verifyContext: () => true,
        sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
        ...overrides,
    };
    const caller = [
        options.profile.guid,
        options.profile.unknown21,
        options.profile.randomKey,
        options.profile.peerPublicKey,
        fetchFields.d1,
        loginFields.apkSignature,
        loginFields.tlv124Value,
    ].map((bytes) => ({ bytes, before: Uint8Array.from(bytes) }));
    const attempt = createBorrowedWtReferenceLoginAttempt(lease, options);
    cleanup.push(async () => {
        attempt.close();
        lease.poison();
        await Promise.allSettled(client.tasks);

        for (const bytes of [
            ...client.frames,
            ...client.frameCopies,
            ...client.requests,
            ...client.requestOicqs,
        ]) {
            bytes.fill(0);
        }
    });
    return { attempt, client, lease, caller };
}

function assertCallerUnchanged(caller: ReturnType<typeof setup>['caller']) {
    for (const { bytes, before } of caller) {
        expect(bytes).toEqual(before);
    }
}

function assertNonzero(bytes: Uint8Array[]) {
    expect(bytes.length).toBeGreaterThan(0);

    for (const value of bytes) {
        expect(value.length).toBeGreaterThan(0);
        expect(value.some((byte) => byte !== 0)).toBe(true);
    }
}

function assertZero(bytes: Uint8Array[]) {
    for (const value of bytes) {
        expect(value.length).toBeGreaterThan(0);
        expect(value.every((byte) => byte === 0)).toBe(true);
    }
}

async function reached(entered: Promise<void>, operation: Promise<string>) {
    const first = await Promise.race([
        entered.then(() => 'entered' as const),
        operation.then(() => 'finished' as const),
    ]);
    expect(first).toBe('entered');

    if (first !== 'entered') {
        throw new Error('attempt settled before reaching the gated callback');
    }
}

async function confirm(attempt: ReturnType<typeof createBorrowedWtReferenceLoginAttempt>) {
    expect((await attempt.fetch(fetchFields)).qrUrl).toBe('https://example.invalid/qr');
    expect(await attempt.poll()).toEqual({ status: 'confirmed' });
}

const outcome = (promise: Promise<unknown>) =>
    promise.then(
        () => 'resolved',
        () => 'rejected',
    );

describe('borrowed WT attempt pending owned-byte cleanup (memory-only)', () => {
    it.each([
        ['close', 'resolve'],
        ['close', 'reject'],
        ['abort', 'resolve'],
        ['abort', 'reject'],
    ] as const)('wipes the exact signer loan on %s before late %s', async (mode, late) => {
        const controller = new AbortController();
        const gate = deferred<Uint8Array>();
        const entered = deferred<void>();
        let loan: Uint8Array | undefined;
        let externalCopy: Uint8Array | undefined;
        const fixture = setup({
            signal: controller.signal,
            buildReserved: ({ body }) => {
                loan = body;
                externalCopy = Uint8Array.from(body);
                entered.resolve();
                return gate.promise;
            },
        });
        cleanup.push(async () => {
            gate.resolve(Uint8Array.of(8));
            externalCopy?.fill(0);
        });
        const pending = outcome(fixture.attempt.fetch(fetchFields));
        await reached(entered.promise, pending);
        expect(loan).toBeDefined();
        assertNonzero([loan!, externalCopy!]);
        expect(fixture.client.writes).toBe(0);

        if (mode === 'close') {
            fixture.attempt.close();
        } else {
            controller.abort();
        }

        assertZero([loan!]);
        assertNonzero([externalCopy!]);
        assertCallerUnchanged(fixture.caller);
        expect(await pending).toBe('rejected');
        expect(await fixture.lease.whenClosed).toBe('poisoned');
        expect(fixture.client.writes).toBe(0);

        if (late === 'reject') {
            gate.reject(new Error('synthetic late signer rejection'));
        } else {
            gate.resolve(Uint8Array.of(8));
        }

        await Promise.allSettled(fixture.client.tasks);
        assertZero([loan!]);
        expect(fixture.client.writes).toBe(0);
    });

    it.each([
        ['close', 'resolve'],
        ['close', 'reject'],
        ['abort', 'resolve'],
        ['abort', 'reject'],
    ] as const)('wipes the three raw verifier loans on %s before late %s', async (mode, late) => {
        const controller = new AbortController();
        const gate = deferred<boolean>();
        const entered = deferred<void>();
        let loan: Uint8Array[] = [];
        let retained: Uint8Array | undefined;
        const fixture = setup({
            signal: controller.signal,
            verifyRaw: ({ requestFrame, requestOicq, responseFrame }) => {
                loan = [requestFrame, requestOicq, responseFrame];
                retained = Uint8Array.from(responseFrame);
                entered.resolve();
                return gate.promise;
            },
        });
        cleanup.push(async () => {
            gate.resolve(true);
            retained?.fill(0);
        });
        const pending = outcome(fixture.attempt.fetch(fetchFields));
        await reached(entered.promise, pending);
        expect(loan).toHaveLength(3);
        assertNonzero(loan);
        assertNonzero([retained!]);
        expect(fixture.client.writes).toBe(1);
        expect(loan[0]).toEqual(fixture.client.requests[0]);
        expect(loan[1]).toEqual(fixture.client.requestOicqs[0]);
        expect(Array.from(loan[2])).toEqual(Array.from(fixture.client.frames[0]));
        expect(Array.from(fixture.client.frames[0])).toEqual(
            Array.from(fixture.client.frameCopies[0]),
        );

        if (mode === 'close') {
            fixture.attempt.close();
        } else {
            controller.abort();
        }

        assertZero(loan);
        assertNonzero([retained!]);
        assertCallerUnchanged(fixture.caller);
        expect(Array.from(fixture.client.frames[0])).toEqual(
            Array.from(fixture.client.frameCopies[0]),
        );
        expect(await pending).toBe('rejected');

        if (late === 'reject') {
            gate.reject(new Error('synthetic late verifier rejection'));
        } else {
            gate.resolve(true);
        }

        await Promise.allSettled(fixture.client.tasks);
        assertZero(loan);
        expect(fixture.client.writes).toBe(1);
    });

    it.each([
        ['close', 'resolve'],
        ['close', 'reject'],
        ['abort', 'resolve'],
        ['abort', 'reject'],
    ] as const)(
        'wipes real parsed tickets and TLVs on %s before late context %s',
        async (mode, late) => {
            const controller = new AbortController();
            const gate = deferred<boolean>();
            const entered = deferred<void>();
            const fixture = setup({
                signal: controller.signal,
                verifyContext: ({ operation }) => {
                    if (operation === 'login') {
                        entered.resolve();
                        return gate.promise;
                    }

                    return true;
                },
            });
            cleanup.push(async () => {
                gate.resolve(true);
            });
            await confirm(fixture.attempt);
            const pending = outcome(fixture.attempt.login(loginFields));
            await reached(entered.promise, pending);
            const parsed = decoderCapture.login;
            expect(parsed?.status).toBe('tickets');

            if (!parsed || parsed.status !== 'tickets') {
                throw new Error('synthetic login did not produce decoder tickets');
            }

            const tickets = Object.values(parsed.tickets);
            const outer = parsed.outerTlvs.map((entry) => entry.value);
            const inner = parsed.innerTlvs.map((entry) => entry.value);
            expect(tickets).toHaveLength(4);
            expect(outer.length).toBeGreaterThan(0);
            expect(inner.length).toBeGreaterThan(0);
            const observed = [...tickets, ...outer, ...inner];
            assertNonzero(observed);
            expect(fixture.client.writes).toBe(3);
            expect(Array.from(fixture.client.frames[2])).toEqual(
                Array.from(fixture.client.frameCopies[2]),
            );

            if (mode === 'close') {
                fixture.attempt.close();
            } else {
                controller.abort();
            }

            assertZero(observed);
            assertCallerUnchanged(fixture.caller);
            expect(Array.from(fixture.client.frames[2])).toEqual(
                Array.from(fixture.client.frameCopies[2]),
            );
            expect(await pending).toBe('rejected');

            if (late === 'reject') {
                gate.reject(new Error('synthetic late context rejection'));
            } else {
                gate.resolve(true);
            }

            await Promise.allSettled(fixture.client.tasks);
            assertZero(observed);
            expect(fixture.client.writes).toBe(3);
        },
    );
});
