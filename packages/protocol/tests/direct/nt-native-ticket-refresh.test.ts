import { createECDH, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import {
    disposeNativeTicketRefreshResult,
    refreshNativeTicketsOnTransport,
    NativeTicketRefreshError,
    type NativeTicketRefreshOptions,
} from '../../src/direct/nt-native-ticket-refresh';
import {
    NATIVE_KEY_EXCHANGE_COMMAND,
    type NativeKeyExchangeRequestWire,
    type NativeKeyExchangeResponseWire,
    type NativeKeyExchangeSecretWire,
} from '../../src/direct/nt-native-key-exchange';
import {
    NATIVE_TICKET_REFRESH_COMMAND,
    type NativeForwardWire,
    type NativeRefreshRequestWire,
    type NativeRefreshResponseWire,
} from '../../src/direct/nt-native-ticket-codec';
import { decryptKeyExchangeBytes, encryptKeyExchangeBytes } from '../../src/direct/key-exchange';
import * as primitives from '../../src/direct/key-exchange';
import * as privateSession from '../../src/direct/wt-reference-session-private';
import * as persistedSession from '../../src/direct/wt-persisted-session';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import type {
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';

const trust = vi.hoisted(() => ({ fixtureKey: undefined as KeyObject | undefined, calls: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:crypto')>();
    return {
        ...actual,
        verify: (
            algorithm: string | null,
            data: Uint8Array,
            key: { key: KeyObject; dsaEncoding: 'der' },
            signature: Uint8Array,
        ) => {
            trust.calls++;
            return actual.verify(
                algorithm,
                data,
                { ...key, key: trust.fixtureKey ?? key.key },
                signature,
            );
        },
    };
});
afterEach(() => {
    trust.fixtureKey = undefined;
    trust.calls = 0;
    vi.restoreAllMocks();
    vi.useRealTimers();
});
const KEY_COMMAND = NATIVE_KEY_EXCHANGE_COMMAND;
const REFRESH_COMMAND = NATIVE_TICKET_REFRESH_COMMAND;

const word = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    return b;
};

const field = (b: Uint8Array) => Buffer.concat([word(b.length + 4), b]);
const key = new Uint8Array(16).fill(11);
const newKey = new Uint8Array(16).fill(22);
const sessionKey = new Uint8Array(32).fill(33);
const sessionTicket = new Uint8Array(24).fill(44);

function options(): NativeTicketRefreshOptions {
    return {
        persisted: {
            version: 1,
            uin: '123',
            uid: 'uid-123',
            guid: new Uint8Array(16).fill(1),
            tickets: {
                d2: Uint8Array.of(2),
                d2Key: key.slice(),
                a1: Uint8Array.of(3),
                a2: Uint8Array.of(4),
            },
        },
        profile: { subAppId: 537391511, version: '3.2.35-54395' },
        deviceName: 'fixture-linux',
        serverNowSeconds: 1700000000n,
        timeoutMs: 5000,
        buildReserved: () => Uint8Array.of(5),
        verifyRaw: () => true,
    };
}

function inspect(frame: Uint8Array) {
    const outer = Buffer.from(frame);
    const start = 10 + outer.readUInt32BE(9);
    const end = start + outer.readUInt32BE(start);
    const inner = Buffer.from(qqTeaDecrypt(outer.subarray(end), key));
    const commandStart = 28 + inner.readUInt32BE(28);
    const commandEnd = commandStart + inner.readUInt32BE(commandStart);
    return {
        command: inner.subarray(commandStart + 4, commandEnd).toString(),
        sequence: inner.readUInt32BE(4),
        uin: outer.subarray(start + 4, end).toString(),
        subAppId: inner.readUInt32BE(8),
        body: Uint8Array.from(inner.subarray(inner.readUInt32BE(0) + 4)),
    };
}

function wrap(
    body: Uint8Array,
    command: string,
    sequence: number,
    changes: {
        uin?: string;
        command?: string;
        sequence?: number;
        retCode?: number;
        encryption?: number;
        protocol?: number;
    } = {},
) {
    const header = Buffer.concat([
        word(changes.sequence ?? sequence),
        word(changes.retCode ?? 0),
        field(new Uint8Array()),
        field(Buffer.from(changes.command ?? command)),
        field(new Uint8Array()),
        word(0),
        field(new Uint8Array()),
    ]);
    const cipher = qqTeaEncrypt(Buffer.concat([field(header), field(body)]), key);
    const account = Buffer.from(changes.uin ?? '123');
    return Buffer.concat([
        word(14 + account.length + cipher.length),
        word(changes.protocol ?? 12),
        Buffer.of(changes.encryption ?? 1, 0),
        field(account),
        cipher,
    ]);
}

function ticketsResponse(): NativeRefreshResponseWire {
    return {
        head: {},
        body: {
            tickets: {
                a1: Uint8Array.of(13),
                a2: Uint8Array.of(14),
                d2: Uint8Array.of(12),
                d2Key: newKey,
                a2RefreshTime: { next: 1700000001n, expires: 1700000002n },
                a1RefreshTime: { next: 1700604800n, expires: 1702592000n },
            },
            account: { uin: 123n, uid: 'uid-123' },
        },
    };
}

type Config = {
    nativeTrust?: boolean;
    response?: NativeRefreshResponseWire;
    envelope?: Parameters<typeof wrap>[3];
    corruptTag?: boolean;
    delayKeyMs?: number;
    hangRefresh?: boolean;
    afterKey?: () => void;
};

// Raw clients own I/O settlement (the existing guard intentionally delegates it).
// Match that contract: abort settles the borrowed transport even if a callback stalls.
async function settleRaw<T>(
    signal: AbortSignal,
    work: () => Promise<Sso12RawResult<T>>,
): Promise<Sso12RawResult<T>> {
    let listener: ReturnType<typeof addAbortListener> | undefined;
    const stopped = new Promise<Sso12RawResult<T>>((resolve) => {
        const stop = () =>
            resolve({ kind: 'failure', code: 'raw-cancelled', writeState: 'unknown' });
        listener = addAbortListener(signal, stop);

        if (signal.aborted) {
            stop();
        }
    });

    try {
        return await Promise.race([work(), stopped]);
    } finally {
        listener?.[Symbol.dispose]();
    }
}

function fixture(config: Config = {}) {
    const signing = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    trust.fixtureKey = config.nativeTrust ? undefined : signing.publicKey;
    const requests: ReturnType<typeof inspect>[] = [];
    const borrowed: Uint8Array[] = [];
    const budgets: number[] = [];
    const rawCallbacks: Sso12RawOptions<unknown, unknown>[] = [];
    let refreshPlain: NativeRefreshRequestWire | undefined;
    const transport: Sso12RawTransport = {
        async transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
            return settleRaw(raw.signal!, async () => {
                budgets.push(raw.timeoutMs!);
                rawCallbacks.push(raw as Sso12RawOptions<unknown, unknown>);
                const identity = { uin: '123', sequence: 100 + requests.length };
                const built = await raw.buildRequest(identity);
                borrowed.push(built.frame);
                const request = inspect(built.frame);
                requests.push(request);
                let body: Uint8Array;

                if (request.command === KEY_COMMAND) {
                    const exchange = protobuf_decode<NativeKeyExchangeRequestWire>(request.body);
                    const peer = createECDH('prime256v1');
                    peer.generateKeys();
                    const publicKey = peer.getPublicKey();
                    const secret = encryptKeyExchangeBytes(
                        protobuf_encode<NativeKeyExchangeSecretWire>({
                            sessionKey,
                            sessionTicket,
                            expiresInSeconds: 60n,
                        }),
                        peer.computeSecret(exchange.publicKey),
                    );
                    const signature = sign(
                        'sha256',
                        Buffer.concat([exchange.publicKey, publicKey, secret]),
                        signing.privateKey,
                    );
                    body = protobuf_encode<NativeKeyExchangeResponseWire>({
                        secret,
                        signature,
                        publicKey,
                    });

                    if (config.delayKeyMs) {
                        await new Promise((resolve) => setTimeout(resolve, config.delayKeyMs));
                    }
                } else {
                    expect(request.command).toBe(REFRESH_COMMAND);
                    const forward = protobuf_decode<NativeForwardWire>(request.body);
                    expect(forward.sessionTicket).toEqual(sessionTicket);
                    expect(forward.type).toBe(1);
                    const plain = decryptKeyExchangeBytes(forward.buffer!, sessionKey);
                    refreshPlain = protobuf_decode<NativeRefreshRequestWire>(plain);

                    if (config.hangRefresh) {
                        return await new Promise(() => {});
                    }

                    const encrypted = encryptKeyExchangeBytes(
                        protobuf_encode<NativeRefreshResponseWire>(
                            config.response ?? ticketsResponse(),
                        ),
                        sessionKey,
                    );

                    if (config.corruptTag) {
                        encrypted[encrypted.length - 1]! ^= 1;
                    }

                    body = protobuf_encode<NativeForwardWire>({ buffer: encrypted });
                }

                const candidate = wrap(body, request.command, identity.sequence, config.envelope);

                if (!(await raw.verifyCandidate(candidate, built.context, identity))) {
                    return {
                        kind: 'failure',
                        code: 'fixture-verifier-failed',
                        writeState: 'unknown',
                    };
                }

                const result = await raw.consumeCandidate(candidate, built.context, identity);

                if (request.command === KEY_COMMAND) {
                    config.afterKey?.();
                }

                return {
                    kind: 'response',
                    value: result,
                    sequence: identity.sequence,
                    writeState: 'written',
                };
            });
        },
    };
    return {
        transport,
        requests,
        borrowed,
        budgets,
        rawCallbacks,
        get refreshPlain() {
            return refreshPlain;
        },
    };
}

function capability(lease: Sso12RawTransport) {
    const attempt = { state: 'new', busy: false };
    const token = privateSession.createReferenceKeyCapability();
    const reservation = privateSession.reserveReferenceKeyCapability(token);
    privateSession.registerReferenceBorrowedAttempt(attempt, lease);
    privateSession.bindReferenceKeyAttemptOwnerLease(token, attempt, reservation, lease);
    privateSession.stageReferenceConfirmed(token, attempt, '123', '123', 100);
    privateSession.stageReferenceKey(token, attempt, '123', '123', 100, key);
    privateSession.commitReferenceKey(token);
    return { token, attempt, lease };
}

// No sockets, accounts or server captures. Positive authentication tests substitute
// a local signing key at the test crypto adapter, never through the production API.
describe('native ticket refresh borrowed transport', () => {
    it('performs exactly two signed SSO12/D2 exchanges and returns an owned V1 candidate + metadata', async () => {
        const f = fixture();
        const opts = options();
        const signInputs: Uint8Array[] = [];
        const verifyInputs: Uint8Array[] = [];
        const candidate = await refreshNativeTicketsOnTransport(f.transport, {
            ...opts,
            buildReserved: (input) => {
                signInputs.push(input.body);
                return Uint8Array.of(5);
            },
            verifyRaw: (input) => {
                verifyInputs.push(input.requestFrame, input.responseFrame);
                return true;
            },
        });
        expect(f.requests.map((x) => x.command)).toEqual([KEY_COMMAND, REFRESH_COMMAND]);
        expect(f.requests.map((x) => x.sequence)).toEqual([100, 101]);
        expect(f.requests.every((x) => x.uin === '123' && x.subAppId === 537391511)).toBe(true);
        expect(f.refreshPlain?.head.app.appId).toBe(1600001615n);
        expect(f.refreshPlain?.body.a1).toEqual(Uint8Array.of(3));
        expect(candidate).toMatchObject({
            kind: 'refreshed',
            metadata: { nextRefreshAtSeconds: 1700604800n, expiresAtSeconds: 1702592000n },
            persisted: {
                version: 1,
                uin: '123',
                uid: 'uid-123',
                tickets: { d2Key: newKey, a1: Uint8Array.of(13) },
            },
        });
        expect(opts.persisted.tickets.d2Key).toEqual(key);
        expect(trust.calls).toBe(1);

        for (const bytes of [...signInputs, ...verifyInputs, ...f.borrowed]) {
            expect(bytes.every((x) => x === 0)).toBe(true);
        }

        disposeNativeTicketRefreshResult(candidate);

        if (candidate.kind !== 'refreshed') {
            throw new Error('fixture');
        }

        expect(candidate.persisted.tickets.d2Key).toEqual(new Uint8Array(16));
        expect(opts.persisted.tickets.d2Key).toEqual(key);
    });

    it('snapshots credentials before the first callback and does not retain caller objects across awaits', async () => {
        const f = fixture();
        const opts = options();
        const result = await refreshNativeTicketsOnTransport(f.transport, {
            ...opts,
            buildReserved: () => {
                opts.persisted.tickets.a1.fill(99);
                opts.persisted.tickets.d2Key.fill(99);
                opts.persisted.guid.fill(99);
                return Uint8Array.of(5);
            },
        });
        expect(result.kind).toBe('refreshed');
        expect(f.refreshPlain?.body.a1).toEqual(Uint8Array.of(3));
        expect(f.refreshPlain?.head.client.guid).toEqual(new Uint8Array(16).fill(1));
        disposeNativeTicketRefreshResult(result);
    });

    it('uses the actual native trust key unless the TEST adapter is substituted', async () => {
        const f = fixture({ nativeTrust: true });
        await expect(refreshNativeTicketsOnTransport(f.transport, options())).rejects.toMatchObject(
            { stage: 'key-exchange', code: 'invalid-response', writeState: 'written' },
        );
        expect(f.requests).toHaveLength(1);
    });

    it('requires both outer verifier and inner fixed ECDSA; an outer rejection stops without replay', async () => {
        const f = fixture();
        await expect(
            refreshNativeTicketsOnTransport(f.transport, { ...options(), verifyRaw: () => false }),
        ).rejects.toBeInstanceOf(NativeTicketRefreshError);
        expect(f.requests).toHaveLength(1);
        expect(trust.calls).toBe(0);
    });

    it.each([
        { uin: '124' },
        { command: 'other' },
        { sequence: 99 },
        { protocol: 13 },
        { encryption: 0 },
    ])('rejects a mismatched outer binding %j', async (envelope) => {
        const f = fixture({ envelope });
        await expect(
            refreshNativeTicketsOnTransport(f.transport, options()),
        ).rejects.toBeInstanceOf(NativeTicketRefreshError);
        expect(f.requests).toHaveLength(1);
    });

    it('preserves SSO failures separately from NT protocol errors', async () => {
        const f = fixture({ envelope: { retCode: 17 } });
        await expect(refreshNativeTicketsOnTransport(f.transport, options())).rejects.toMatchObject(
            { stage: 'key-exchange', code: 'sso-error', retCode: 17, writeState: 'written' },
        );
        expect(f.requests).toHaveLength(1);
    });

    it.each([true, false])(
        'returns native protocol failure and needsLogin=%s without constructing credentials',
        async (needsLogin) => {
            const f = fixture({ response: { head: { error: { code: 140022014n, needsLogin } } } });
            await expect(refreshNativeTicketsOnTransport(f.transport, options())).resolves.toEqual({
                kind: 'protocol-error',
                code: 140022014n,
                needsLogin,
            });
            expect(f.requests).toHaveLength(2);
        },
    );

    it('reports empty A1 distinctly so the owner does not increase the native protocol failure counter', async () => {
        const f = fixture({ response: { head: {} } });
        await expect(refreshNativeTicketsOnTransport(f.transport, options())).resolves.toEqual({
            kind: 'empty-a1',
        });
    });

    it('rejects a validly encrypted reply for another account', async () => {
        const response = ticketsResponse();
        response.body!.account!.uin = 124n;
        const f = fixture({ response });
        await expect(refreshNativeTicketsOnTransport(f.transport, options())).rejects.toMatchObject(
            { stage: 'refresh', code: 'invalid-response' },
        );
        expect(f.requests).toHaveLength(2);
    });

    it('rejects a changed GCM tag and wipes cryptographic working keys/plaintext', async () => {
        const original = primitives.decryptKeyExchangeBytes;
        const keys: Uint8Array[] = [];
        const plains: Uint8Array[] = [];
        vi.spyOn(primitives, 'decryptKeyExchangeBytes').mockImplementation((bytes, key) => {
            keys.push(key);
            const plain = original(bytes, key);
            plains.push(plain);
            return plain;
        });
        const f = fixture({ corruptTag: true });
        await expect(refreshNativeTicketsOnTransport(f.transport, options())).rejects.toMatchObject(
            { stage: 'refresh', code: 'invalid-response' },
        );

        // Fixture decrypt uses the shared sessionKey constant; production passes owned copies.
        for (const owned of keys.filter((x) => x !== sessionKey)) {
            expect(owned.every((x) => x === 0)).toBe(true);
        }

        expect(plains[0]?.every((x) => x === 0)).toBe(true);
        expect(f.borrowed.every((x) => x.every((b) => b === 0))).toBe(true);
    });

    it('uses one deadline for both steps and stops a never-settling second transport', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        const f = fixture({ delayKeyMs: 600, hangRefresh: true });
        const pending = refreshNativeTicketsOnTransport(f.transport, {
            ...options(),
            timeoutMs: 1000,
        }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(600);
        expect(f.requests).toHaveLength(2);
        expect(f.budgets[1]).toBeLessThanOrEqual(400);
        await vi.advanceTimersByTimeAsync(400);
        expect(await pending).toBeInstanceOf(NativeTicketRefreshError);
        expect(f.requests).toHaveLength(2);
        expect(f.borrowed.every((x) => x.every((b) => b === 0))).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops a hung signer within the same total deadline without writing a frame', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        const f = fixture();
        const pending = refreshNativeTicketsOnTransport(f.transport, {
            ...options(),
            timeoutMs: 100,
            buildReserved: () => new Promise(() => {}),
        }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(100);
        expect(await pending).toBeInstanceOf(NativeTicketRefreshError);
        expect(f.requests).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('honors pre-abort and abort between steps; no automatic retry', async () => {
        const controller = new AbortController();
        controller.abort();
        const first = fixture();
        await expect(
            refreshNativeTicketsOnTransport(first.transport, {
                ...options(),
                signal: controller.signal,
            }),
        ).rejects.toMatchObject({ code: 'operation-stopped', writeState: 'not-written' });
        expect(first.budgets).toHaveLength(0);
        const between = new AbortController();
        const second = fixture({ afterKey: () => between.abort() });
        await expect(
            refreshNativeTicketsOnTransport(second.transport, {
                ...options(),
                signal: between.signal,
            }),
        ).rejects.toBeInstanceOf(NativeTicketRefreshError);
        expect(second.requests).toHaveLength(1);
    });

    it('uses two distinct child runs of the same capability, releasing both without rotating it', async () => {
        const f = fixture();
        const binding = capability(f.transport);
        const begin = vi.spyOn(privateSession, 'beginReferenceSend');

        try {
            const result = await refreshNativeTicketsOnTransport(f.transport, options(), binding);
            expect(result.kind).toBe('refreshed');
            expect(begin).toHaveBeenCalledTimes(2);
            const first = begin.mock.calls[0]![3];
            const second = begin.mock.calls[1]![3];
            expect(first).not.toBe(second);
            expect(() =>
                privateSession.beginReferenceSend(
                    binding.token,
                    binding.attempt,
                    binding.lease,
                    first,
                ),
            ).toThrow();
            const next = {};
            privateSession.beginReferenceSend(binding.token, binding.attempt, binding.lease, next);
            privateSession.assertReferenceSendKey(
                binding.token,
                binding.attempt,
                binding.lease,
                next,
                key,
            );
            privateSession.endReferenceSend(binding.token, binding.attempt, binding.lease, next);
            disposeNativeTicketRefreshResult(result);
        } finally {
            privateSession.revokeReferenceKey(binding.token);
        }
    });

    it('rejects mismatched capability key, foreign lease, and revocation between steps', async () => {
        const f = fixture();
        const binding = capability(f.transport);

        try {
            const opts = options();
            opts.persisted.tickets.d2Key.fill(99);
            await expect(
                refreshNativeTicketsOnTransport(f.transport, opts, binding),
            ).rejects.toBeInstanceOf(NativeTicketRefreshError);
            expect(f.requests).toHaveLength(0);
            const foreign = fixture();
            await expect(
                refreshNativeTicketsOnTransport(foreign.transport, options(), binding),
            ).rejects.toMatchObject({ code: 'invalid-input' });
        } finally {
            privateSession.revokeReferenceKey(binding.token);
        }

        let token: object;
        const revoked = fixture({ afterKey: () => privateSession.revokeReferenceKey(token) });
        const other = capability(revoked.transport);
        token = other.token;
        await expect(
            refreshNativeTicketsOnTransport(revoked.transport, options(), other),
        ).rejects.toBeInstanceOf(NativeTicketRefreshError);
        expect(revoked.requests).toHaveLength(1);
    });

    it.each(['abort', 'throw'] as const)(
        'erases the candidate rather than publishing success if final cleanup %s occurs',
        async (mode) => {
            const controller = new AbortController();
            const clone = persistedSession.cloneWtPersistedSession;
            const snapshots: ReturnType<typeof clone>[] = [];
            vi.spyOn(persistedSession, 'cloneWtPersistedSession').mockImplementation((value) => {
                const result = clone(value);
                snapshots.push(result);
                return result;
            });
            const clear = globalThis.clearTimeout;
            vi.spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
                clear(handle);

                if (snapshots.length >= 2) {
                    if (mode === 'abort') {
                        controller.abort();
                    } else {
                        throw new Error('fixture cleanup error');
                    }
                }
            });
            const f = fixture();
            await expect(
                refreshNativeTicketsOnTransport(f.transport, {
                    ...options(),
                    signal: controller.signal,
                }),
            ).rejects.toMatchObject({ code: 'operation-stopped' });
            expect(snapshots).toHaveLength(2);

            for (const snapshot of snapshots) {
                for (const bytes of [snapshot.guid, ...Object.values(snapshot.tickets)]) {
                    expect(bytes.every((x) => x === 0)).toBe(true);
                }
            }
        },
    );

    it('revokes retained raw callbacks after success instead of replaying requests', async () => {
        const f = fixture();
        const result = await refreshNativeTicketsOnTransport(f.transport, options());
        const before = f.requests.length;

        for (const raw of f.rawCallbacks) {
            await expect(raw.buildRequest({ uin: '123', sequence: 999 })).rejects.toThrow();
        }

        expect(f.requests).toHaveLength(before);
        disposeNativeTicketRefreshResult(result);
    });

    it('rejects unknown trust/command parameters and getter-based config before invoking transport', async () => {
        const f = fixture();

        for (const extra of [
            { command: 'arbitrary' },
            { verifyServerResponse: () => true },
            { serverPublicKey: new Uint8Array(65) },
        ]) {
            await expect(
                refreshNativeTicketsOnTransport(f.transport, { ...options(), ...extra } as never),
            ).rejects.toMatchObject({ code: 'invalid-input', writeState: 'not-written' });
        }

        const getter = {
            ...options(),
            get timeoutMs(): number {
                throw new Error('getter ran');
            },
        };
        await expect(refreshNativeTicketsOnTransport(f.transport, getter)).rejects.toMatchObject({
            code: 'invalid-input',
        });
        expect(f.requests).toHaveLength(0);
    });
});
