import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    Sso12CloseReason,
    Sso12RawClient,
    Sso12RawOptions,
    Sso12RawResult,
} from '../../src/direct/sso12-packet-client';
import {
    WtReferenceLoginAttempt,
    type WtReferenceLoginAttemptOptions,
    type WtReferenceLoginResult,
} from '../../src/direct/wt-reference-login-attempt';
import {
    fetchBody,
    loginReply,
    parseWt,
    peer,
    pollBody,
    replyWt,
} from './fixtures/wt-sso-synthetic';

// Replace the constructor itself, without importing its actual implementation.
// The attempt receives a plain object and only this in-memory raw client.
const transportMock = vi.hoisted(() => ({
    next: undefined as Sso12RawClient | undefined,
    constructed: 0,
}));
vi.mock('../../src/direct/sso12-packet-client', () => ({
    Sso12PacketClient: class {
        constructor() {
            const client = transportMock.next;

            if (!client) {
                throw new Error('missing synthetic raw client');
            }

            transportMock.next = undefined;
            transportMock.constructed++;
            return client as never;
        }
    },
}));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

type LoginExchange = { type: 'login'; result: WtReferenceLoginResult };

class MemoryClient implements Sso12RawClient {
    readonly closed = deferred<Sso12CloseReason>();
    readonly whenClosed = this.closed.promise;
    readonly requests: Array<{ kind: number; account: string; command: string; sequence: number }> =
        [];
    readonly tasks: Promise<unknown>[] = [];
    readonly frames: Uint8Array[] = [];
    sequence = 50;
    writes = 0;
    closeCalls = 0;
    closedFlag = false;
    stagedLogin?: WtReferenceLoginResult;
    onClose?: () => void;

    close(): void {
        this.closeCalls++;

        if (this.closedFlag) {
            return;
        }

        // Disarm before reentry: attempt.close() calls client.close() again.
        this.closedFlag = true;
        this.onClose?.();
        this.closed.resolve({ kind: 'local', code: 'synthetic' });
    }

    transactRaw<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        const work = this.exchange(options);
        this.tasks.push(work);
        return work;
    }

    private async exchange<C, T>(options: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        const sequence = this.sequence++;
        const identity = { uin: '999', sequence };

        try {
            const built = await options.buildRequest(identity);
            this.writes++;
            const request = parseWt(built.frame);
            this.requests.push({
                kind: request.kind,
                account: request.account,
                command: request.command,
                sequence: request.seq,
            });
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

            if (!(await options.verifyCandidate(candidate, built.context, identity))) {
                return { kind: 'failure', code: 'synthetic-denial', writeState: 'unknown' };
            }

            const value = await options.consumeCandidate(candidate, built.context, identity);
            const exchange = value as LoginExchange;

            if (exchange.type === 'login') {
                // This is the real callback result offered to the fake transport.
                this.stagedLogin = exchange.result;
            }

            return { kind: 'response', sequence, value, writeState: 'written' };
        } catch {
            return { kind: 'failure', code: 'synthetic-callback', writeState: 'unknown' };
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

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const dispose of disposers.splice(0).reverse()) {
        await dispose();
    }

    transportMock.next = undefined;
});

function setup() {
    const client = new MemoryClient();
    const controller = new AbortController();
    const fakeSocket = { destroyed: false };
    const options: WtReferenceLoginAttemptOptions = {
        socket: fakeSocket as unknown as WtReferenceLoginAttemptOptions['socket'],
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
        signal: controller.signal,
        getTimestamp: () => 10,
        buildReserved: async () => new Uint8Array(),
        verifyRaw: () => true,
        verifyContext: () => true,
        sliceBusiness: ({ bodyLength }) => ({ start: 0, end: bodyLength }),
    };
    const constructorsBefore = transportMock.constructed;
    transportMock.next = client;
    const attempt = new WtReferenceLoginAttempt(options);
    disposers.push(async () => {
        client.onClose = undefined;
        attempt.close();
        await Promise.allSettled(client.tasks);

        for (const frame of client.frames) {
            frame.fill(0);
        }

        if (client.stagedLogin?.status === 'tickets') {
            for (const bytes of Object.values(client.stagedLogin.tickets)) {
                bytes.fill(0);
            }
        }
    });
    return { client, attempt, controller, constructorsBefore };
}

async function prepare(attempt: WtReferenceLoginAttempt) {
    expect((await attempt.fetch(fetchFields)).qrUrl).toBe('https://example.invalid/qr');
    expect(await attempt.poll()).toEqual({ status: 'confirmed' });
    expect(attempt.getState()).toBe('confirmed-held');
}

function expectThreeRequests(client: MemoryClient) {
    expect(client.writes).toBe(3);
    expect(client.requests).toEqual([
        { kind: 0x31, account: '999', command: 'fixture.qr', sequence: 50 },
        { kind: 0x12, account: '999', command: 'fixture.qr', sequence: 51 },
        { kind: 0x810, account: '123', command: 'fixture.login', sequence: 52 },
    ]);
}

describe('standalone WT login final cleanup with synthetic raw client', () => {
    it('commits tickets only after normal cleanup and keeps returned bytes intact', async () => {
        const fixture = setup();
        expect(transportMock.constructed).toBe(fixture.constructorsBefore + 1);
        await prepare(fixture.attempt);
        expect(fixture.client.closeCalls).toBe(0);
        const result = await fixture.attempt.login(loginFields);
        expect(result.status).toBe('tickets');

        if (result.status !== 'tickets') {
            throw new Error('expected synthetic tickets');
        }

        expect(result).toBe(fixture.client.stagedLogin);
        expect(fixture.attempt.getState()).toBe('tickets');
        expect(fixture.client.closeCalls).toBe(1);
        expectThreeRequests(fixture.client);
        expect(Object.keys(result.tickets).sort()).toEqual(['a1', 'a2', 'd2', 'd2Key']);

        for (const bytes of Object.values(result.tickets)) {
            expect(bytes.length).toBeGreaterThan(0);
            expect(bytes.some((byte) => byte !== 0)).toBe(true);
        }
    });

    it.each(['abort', 'close'] as const)(
        'does not commit staged tickets after synchronous %s during final client close',
        async (mode) => {
            const fixture = setup();
            await prepare(fixture.attempt);
            expect(fixture.client.closeCalls).toBe(0);
            let hookCalls = 0;
            const observed: { stagedAtClose?: WtReferenceLoginResult } = {};
            let ticketSnapshots: Uint8Array[] = [];
            disposers.push(async () => {
                for (const bytes of ticketSnapshots) {
                    bytes.fill(0);
                }
            });
            let writesAtClose = -1;

            fixture.client.onClose = () => {
                hookCalls++;
                observed.stagedAtClose = fixture.client.stagedLogin;
                writesAtClose = fixture.client.writes;

                if (observed.stagedAtClose?.status === 'tickets') {
                    ticketSnapshots = Object.values(observed.stagedAtClose.tickets).map((bytes) =>
                        Uint8Array.from(bytes),
                    );
                }

                if (mode === 'abort') {
                    fixture.controller.abort();
                } else {
                    fixture.attempt.close();
                }
            };

            const outcome = await fixture.attempt.login(loginFields).then(
                (value) => ({ kind: 'resolved' as const, value }),
                (error: unknown) => ({ kind: 'rejected' as const, error }),
            );
            expect(outcome.kind).toBe('rejected');

            if (outcome.kind !== 'rejected') {
                throw new Error('login unexpectedly returned tickets');
            }

            expect(outcome.error).toBeInstanceOf(Error);
            expect(hookCalls).toBe(1);
            expect(writesAtClose).toBe(3);
            const stagedAtClose = observed.stagedAtClose;
            expect(stagedAtClose?.status).toBe('tickets');
            expect(ticketSnapshots).toHaveLength(4);

            for (const bytes of ticketSnapshots) {
                expect(bytes.length).toBeGreaterThan(0);
                expect(bytes.some((byte) => byte !== 0)).toBe(true);
                bytes.fill(0);
            }

            if (!stagedAtClose || stagedAtClose.status !== 'tickets') {
                throw new Error('missing staged synthetic ticket references');
            }

            for (const bytes of Object.values(stagedAtClose.tickets)) {
                expect(bytes.length).toBeGreaterThan(0);
                expect(bytes.every((byte) => byte === 0)).toBe(true);
            }

            expect(fixture.attempt.getState()).toBe(mode === 'abort' ? 'failed' : 'closed');
            expectThreeRequests(fixture.client);
            await Promise.resolve();
            await Promise.resolve();
            expectThreeRequests(fixture.client);
        },
    );
});
