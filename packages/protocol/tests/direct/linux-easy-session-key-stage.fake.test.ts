import { createCipheriv, createECDH } from 'node:crypto';
import type {
    LinuxNTEasyLoginReferenceResponseBody,
    LinuxNTLoginReferenceResponseCommon,
    NTLoginForwardRequest,
} from '@snowluma/proto-defs/direct-login';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import { KEY_EXCHANGE_COMMAND } from '../../src/direct/key-exchange-flow';
import {
    decodeKeyExchangeRequest,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
} from '../../src/direct/key-exchange-protobuf';
import {
    createLinuxEasyKeyCapability,
    decodeLinuxEasyServiceResponse,
    linuxEasyKeyState,
    revokeLinuxEasyKey,
    stageLinuxEasyKey,
} from '../../src/direct/linux-easy-key-capability';
import { runLinuxEasyLoginSessionWithKeyCapability } from '../../src/direct/linux-easy-login-session';
import { decodeLinuxNTEasyLoginReferenceResponse } from '../../src/direct/nt-linux-easy-login-reference';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawMultiplexClient } from '../../src/direct/raw-multiplex-client';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import { decodeSsoResponse } from '../../src/direct/sso';
import { LINUX_EASY_LOGIN_COMMAND } from '../../src/direct/sso-reference-linux-easy-login-flow';

// Synthetic, in-memory fixtures. Callback acceptance and parsing do not establish peer identity.
const UIN = '123456';
const KE = 0x80000001;
const EASY = 0x80000002;
const PUSH = 0x80000003;
const PUSH_COMMAND = 'Synthetic.FollowingFrame';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

const word = (value: number): Buffer => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value >>> 0);
    return bytes;
};

const field = (bytes: Uint8Array) => Buffer.concat([word(bytes.length + 4), bytes]);

function fixtureKey(scalar: number) {
    const ecdh = createECDH('prime256v1');
    const key = Buffer.alloc(32);
    key[31] = scalar;

    try {
        ecdh.setPrivateKey(key);
        return ecdh;
    } finally {
        key.fill(0);
    }
}

function seal(plain: Uint8Array, key: Uint8Array, nonce: Uint8Array): Buffer {
    const cipher = createCipheriv(key.length === 32 ? 'aes-256-gcm' : 'aes-128-gcm', key, nonce);
    return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

// Decode the actual request frame supplied to write, not the signer callback's body.
function requestBody(frame: Uint8Array): Uint8Array {
    const bytes = Buffer.from(frame);
    const d2End = 9 + bytes.readUInt32BE(9);
    const accountStart = d2End + 1;
    const accountEnd = accountStart + bytes.readUInt32BE(accountStart);
    expect(bytes.subarray(accountStart + 4, accountEnd).toString()).toBe(UIN);
    const inner = Buffer.from(qqTeaDecrypt(bytes.subarray(accountEnd), new Uint8Array(16)));

    try {
        expect(inner.readUInt32BE(4)).toBe(KE);
        let offset = 28;

        const take = (width: 2 | 4 = 4): Buffer => {
            const size = width === 2 ? inner.readUInt16BE(offset) : inner.readUInt32BE(offset);
            expect(size).toBeGreaterThanOrEqual(width);
            expect(offset + size).toBeLessThanOrEqual(inner.length);
            const value = inner.subarray(offset + width, offset + size);
            offset += size;
            return value;
        };

        take();
        expect(take().toString()).toBe(KEY_EXCHANGE_COMMAND);
        take();
        take();
        take();
        take(2);
        take();
        expect(offset).toBe(inner.readUInt32BE(0));
        const body = Uint8Array.from(take());
        expect(offset).toBe(inner.length);
        return body;
    } finally {
        inner.fill(0);
        bytes.fill(0);
    }
}

function response(
    sequence: number,
    command: string,
    body: Uint8Array,
    key: Uint8Array,
    d2: boolean,
) {
    const header = Buffer.concat([
        word(sequence),
        word(0),
        field(Buffer.alloc(0)),
        field(Buffer.from(command)),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    const inner = Buffer.concat([field(header), field(body)]);
    const encrypted = qqTeaEncrypt(inner, key, (length) => new Uint8Array(length).fill(0x35));
    const frame = Buffer.concat([
        word(0),
        word(12),
        Buffer.of(d2 ? 1 : 2, 0),
        field(Buffer.from(UIN)),
        encrypted,
    ]);
    frame.writeUInt32BE(frame.length);
    inner.fill(0);
    encrypted.fill(0);
    header.fill(0);
    return frame;
}

function fixture() {
    const owned: Uint8Array[] = [];

    const own = <T extends Uint8Array>(bytes: T): T => {
        owned.push(bytes);
        return bytes;
    };

    const zero = own(new Uint8Array(16));
    const sessionKey = own(Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i));
    const sessionTicket = own(Uint8Array.from({ length: 24 }, (_, i) => 0x60 + i));
    const d2Key = own(Uint8Array.from({ length: 16 }, (_, i) => 0x80 + i));
    const d2 = own(Uint8Array.of(0x31, 0, 0x33));
    const a1 = own(Uint8Array.of(0x11, 0, 0x12));
    const a2 = own(Uint8Array.of(0x21, 0, 0x22));
    const wrote = [deferred<void>(), deferred<void>()];
    const verifyEntered = deferred<void>();
    const verifyGate = deferred<boolean>();
    const followingEntered = deferred<void>();
    const followingGate = deferred<void>();
    const signerEntered = deferred<void>();
    const signerGate = deferred<void>();
    const abort = new AbortController();
    const frames: Uint8Array[] = [];
    const classified: string[] = [];
    let settled = false;
    let holdSigner = false;
    let lease!: ReturnType<ReturnType<typeof createRawSessionBroker>['acquire']>;
    let token!: ReturnType<typeof createLinuxEasyKeyCapability>;
    const hold = vi.fn(({ sequence }: { uin: string; sequence: number }) => sequence === EASY);
    const client = createRawMultiplexClient({
        uin: UIN,
        initialSequence: KE,
        defaultTimeoutMs: 5000,
        maxFrameBytes: 8192,
        maxBufferedBytes: 16384,
        maxFrames: 4,
        maxPushFrames: 4,
        maxPushBytes: 8192,
        write: (bytes) => {
            const index = frames.length;
            frames.push(own(Uint8Array.from(bytes)));
            wrote[index]?.resolve();
        },
        holdFollowingFrames: hold,
        classify: async (bytes, identity) => {
            expect(identity.uin).toBe(UIN);

            if (bytes[8] === 2) {
                expect(identity.sequence === KE || identity.sequence === EASY).toBe(true);
                classified.push(identity.sequence === KE ? 'key-exchange' : 'easy');
                return { kind: 'response', sequence: identity.sequence! };
            }

            classified.push('following');
            expect(linuxEasyKeyState(token)).toBe('tentative');
            expect(settled).toBe(false);
            const decoded = decodeLinuxEasyServiceResponse({
                token,
                lease,
                uin: UIN,
                frame: bytes,
            });

            try {
                expect(decoded).toMatchObject({
                    uin: UIN,
                    sequence: PUSH,
                    command: PUSH_COMMAND,
                    retCode: 0,
                });
                const parsed = decodeSsoResponse(decoded.body);

                try {
                    expect(parsed.body).toEqual(Uint8Array.of(1, 2));
                } finally {
                    parsed.body.fill(0);
                    parsed.cookie.fill(0);
                    parsed.reserved.fill(0);
                    parsed.headerExtension.fill(0);
                }
            } finally {
                decoded.body.fill(0);
            }

            followingEntered.resolve();
            await followingGate.promise;
            return { kind: 'push', name: 'synthetic-pending-registration', id: PUSH };
        },
        verifyPush: () => true,
        onPush: () => {},
    });
    lease = createRawSessionBroker(client, {
        trustedSuccessQuiescence: true,
        isUsable: () => !client.closed,
    }).acquire({ deadline: performance.now() + 10000 });
    token = createLinuxEasyKeyCapability({ lease, uin: UIN, generation: {} });
    const sign = vi.fn(
        async (input: { uin: string; sequence: number; command: string; body: Uint8Array }) => {
            expect(Object.keys(input).sort()).toEqual(['body', 'command', 'sequence', 'uin']);
            expect(input.uin).toBe(UIN);

            if (holdSigner && input.sequence === KE) {
                signerEntered.resolve();
                await signerGate.promise;
            }

            return Uint8Array.of(0x55);
        },
    );
    const verify = vi.fn(
        async (input: {
            uin: string;
            sequence: number;
            command: string;
            requestFrame: Uint8Array;
            responseFrame: Uint8Array;
        }) => {
            expect(Object.keys(input).sort()).toEqual([
                'command',
                'requestFrame',
                'responseFrame',
                'sequence',
                'uin',
            ]);
            expect(input.uin).toBe(UIN);

            if (input.sequence === EASY) {
                expect(input.command).toBe(LINUX_EASY_LOGIN_COMMAND);
                expect(linuxEasyKeyState(token)).toBe('empty');
                verifyEntered.resolve();
                return await verifyGate.promise;
            }

            expect(input.sequence).toBe(KE);
            expect(input.command).toBe(KEY_EXCHANGE_COMMAND);
            return true;
        },
    );
    const options = {
        uin: UIN,
        guid: own(Uint8Array.of(0xab, 0xcd)),
        a2,
        version: 'fixture-version',
        subAppId: 42,
        serverPublicKey: own(Uint8Array.from(fixtureKey(1).getPublicKey())),
        verifyKey: own(Uint8Array.from({ length: 32 }, (_, i) => i + 1)),
        timestamp: 1700000000,
        a1,
        nonce: own(Uint8Array.from({ length: 12 }, (_, i) => i)),
        deviceName: 'fixture-device',
        deviceType: 'fixture-pc',
        appId: 42,
        appName: 'fixture-app',
        qua: 'fixture-qua',
        timeoutMs: 5000,
        signal: abort.signal,
        buildReserved: sign,
        verifyRaw: verify,
        verifyServerResponse: vi.fn(
            (input: {
                publicKey: Uint8Array;
                field2?: Uint8Array;
                secret: Uint8Array;
                requestPublicKey: Uint8Array;
                uin: string;
                sequence: number;
            }) => {
                expect(Object.keys(input).sort()).toEqual([
                    'field2',
                    'publicKey',
                    'requestPublicKey',
                    'secret',
                    'sequence',
                    'uin',
                ]);
                return true;
            },
        ),
        acceptKeyExchange: vi.fn(
            ({ uin, expiration }: { uin: string; expiration: number | undefined }) =>
                uin === UIN && expiration === 300,
        ),
    };

    const start = () => {
        const pending = runLinuxEasyLoginSessionWithKeyCapability(lease, options, token);
        void pending.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        return pending;
    };

    const feedKey = () => {
        const body = own(requestBody(frames[0]!));
        const decoded = decodeKeyExchangeRequest(body);

        if (!decoded.publicKey) {
            throw new Error('missing synthetic request public key');
        }

        own(decoded.publicKey);

        if (decoded.secret) {
            own(decoded.secret);
        }

        if (decoded.verifyHash) {
            own(decoded.verifyHash);
        }

        const server = fixtureKey(2);
        const shared = own(server.computeSecret(decoded.publicKey));
        const secret = own(
            encodeKeyExchangeResponseSecret({ sessionKey, sessionTicket, expiration: 300 }),
        );
        const encrypted = own(seal(secret, shared, Buffer.alloc(12, 0x42)));
        const reply = own(
            encodeKeyExchangeResponse({ publicKey: server.getPublicKey(), secret: encrypted }),
        );
        client.feed(own(response(KE, KEY_EXCHANGE_COMMAND, reply, zero, false)));
    };

    const feedEasyAndFollowing = () => {
        const tickets = own(
            protobuf_encode<LinuxNTEasyLoginReferenceResponseBody>({
                tickets: { a1, a2, d2, d2Key },
            }),
        );
        const plain = own(
            protobuf_encode<LinuxNTLoginReferenceResponseCommon>({
                head: { errorInfo: { code: 0n } },
                body: tickets,
            }),
        );
        const sealed = own(seal(plain, sessionKey, Buffer.alloc(12, 0x51)));
        const body = own(
            protobuf_encode<NTLoginForwardRequest>({
                sessionTicket: Uint8Array.of(0x42),
                buffer: sealed,
                type: 1,
            }),
        );
        const easy = own(response(EASY, LINUX_EASY_LOGIN_COMMAND, body, zero, false));
        const following = own(response(PUSH, PUSH_COMMAND, Uint8Array.of(1, 2), d2Key, true));
        client.feed(own(Buffer.concat([easy, following])));
    };

    const cleanup = () => {
        verifyGate.resolve(true);
        followingGate.resolve();
        signerGate.resolve();
        abort.abort();
        revokeLinuxEasyKey(token);
        lease.release();
        client.close();

        for (const bytes of owned) {
            bytes.fill(0);
        }
    };

    return {
        lease,
        token,
        client,
        options,
        start,
        feedKey,
        feedEasyAndFollowing,
        cleanup,
        wrote,
        frames,
        classified,
        hold,
        sign,
        verify,
        verifyEntered,
        verifyGate,
        followingEntered,
        followingGate,
        signerEntered,
        signerGate,
        abort,
        holdSigner: () => {
            holdSigner = true;
        },
        isSettled: () => settled,
        expected: { a1, a2, d2, d2Key },
    };
}

describe('synthetic session key staging on one multiplex broker lease', () => {
    it('stages before classifying the coalesced following frame and returns an owned tentative result', async () => {
        const f = fixture();
        const pending = f.start();
        let result: Awaited<typeof pending> | undefined;

        try {
            await f.wrote[0]!.promise;
            f.feedKey();
            await f.wrote[1]!.promise;
            f.feedEasyAndFollowing();
            await f.verifyEntered.promise;
            await turn();
            expect(f.classified).toEqual(['key-exchange', 'easy']);
            expect(linuxEasyKeyState(f.token)).toBe('empty');
            expect(f.isSettled()).toBe(false);
            f.verifyGate.resolve(true);
            await f.followingEntered.promise;
            expect(f.classified).toEqual(['key-exchange', 'easy', 'following']);
            expect(linuxEasyKeyState(f.token)).toBe('tentative');
            expect(f.isSettled()).toBe(false);
            f.followingGate.resolve();
            result = await pending;
            expect(result).toMatchObject({
                kind: 'response',
                keyExchangeSequence: KE,
                easyLoginSequence: EASY,
                value: { status: { kind: 'code', codePresent: true, code: 0n } },
            });
            expect(linuxEasyKeyState(f.token)).toBe('tentative');
            expect(f.hold.mock.calls.map(([identity]) => identity.sequence)).toEqual([KE, EASY]);
            expect(f.sign).toHaveBeenCalledTimes(2);
            expect(f.verify).toHaveBeenCalledTimes(2);
            expect(f.options.verifyServerResponse).toHaveBeenCalledOnce();

            if (result.kind !== 'response' || result.value.body === null) {
                throw new Error('expected owned synthetic response body');
            }

            const tickets = decodeLinuxNTEasyLoginReferenceResponse(result.value.body);

            try {
                expect(tickets).toEqual({ ticketsPresent: true, ...f.expected });
            } finally {
                tickets.a1?.fill(0);
                tickets.a2?.fill(0);
                tickets.d2?.fill(0);
                tickets.d2Key?.fill(0);
            }
        } finally {
            if (result?.kind === 'response') {
                result.value.body?.fill(0);
            }

            f.cleanup();
        }
    });

    it('rejects wrong account and duplicate claims without disturbing the winner', async () => {
        const f = fixture();
        let result: Awaited<ReturnType<typeof f.start>> | undefined;

        try {
            const wrong = await runLinuxEasyLoginSessionWithKeyCapability(
                f.lease,
                { ...f.options, uin: '234567' },
                f.token,
            ).catch(() => ({ kind: 'rejected' as const }));
            expect(wrong.kind).not.toBe('response');
            expect(linuxEasyKeyState(f.token)).toBe('empty');
            expect(f.sign).not.toHaveBeenCalled();
            const pending = f.start();
            await f.wrote[0]!.promise;
            const duplicate = await runLinuxEasyLoginSessionWithKeyCapability(
                f.lease,
                f.options,
                f.token,
            ).catch(() => ({ kind: 'rejected' as const }));
            expect(duplicate.kind).not.toBe('response');
            expect(linuxEasyKeyState(f.token)).toBe('empty');
            expect(f.frames).toHaveLength(1);
            f.feedKey();
            await f.wrote[1]!.promise;
            f.feedEasyAndFollowing();
            await f.verifyEntered.promise;
            f.verifyGate.resolve(true);
            await f.followingEntered.promise;
            f.followingGate.resolve();
            result = await pending;
            expect(result.kind).toBe('response');
            expect(linuxEasyKeyState(f.token)).toBe('tentative');
        } finally {
            if (result?.kind === 'response') {
                result.value.body?.fill(0);
            }

            f.cleanup();
        }
    });

    it('rejects a token bound to another lease before invoking the signer', async () => {
        const winner = fixture();
        const other = fixture();

        try {
            const result = await runLinuxEasyLoginSessionWithKeyCapability(
                other.lease,
                other.options,
                winner.token,
            ).catch(() => ({ kind: 'rejected' as const }));
            expect(result.kind).not.toBe('response');
            expect(linuxEasyKeyState(winner.token)).toBe('empty');
            expect(linuxEasyKeyState(other.token)).toBe('empty');
            expect(other.sign).not.toHaveBeenCalled();
            expect(other.frames).toHaveLength(0);
            const pending = winner.start();
            await winner.wrote[0]!.promise;
            winner.feedKey();
            await winner.wrote[1]!.promise;
            winner.feedEasyAndFollowing();
            await winner.verifyEntered.promise;
            winner.verifyGate.resolve(true);
            await winner.followingEntered.promise;
            winner.followingGate.resolve();
            const success = await pending;

            try {
                expect(success.kind).toBe('response');
                expect(linuxEasyKeyState(winner.token)).toBe('tentative');
            } finally {
                if (success.kind === 'response') {
                    success.value.body?.fill(0);
                }
            }
        } finally {
            winner.cleanup();
            other.cleanup();
        }
    });

    it('stops before key exchange when observing whenClosed revokes the reserved token', async () => {
        const f = fixture();
        const whenClosed = new Promise<'released' | 'poisoned'>(() => {});
        const transactRaw = vi.fn(async () => ({
            kind: 'failure' as const,
            code: 'synthetic-unexpected-transport',
            writeState: 'not-written' as const,
        }));
        const poison = vi.fn();
        const lease = { whenClosed, transactRaw, poison, release: vi.fn(), close: vi.fn() };
        const token = createLinuxEasyKeyCapability({ lease, uin: UIN, generation: {} });
        const getter = vi.fn(() => {
            revokeLinuxEasyKey(token);
            return Promise;
        });
        Object.defineProperty(whenClosed, 'constructor', { configurable: true, get: getter });

        try {
            const result = await runLinuxEasyLoginSessionWithKeyCapability(lease, f.options, token);
            expect(getter).toHaveBeenCalledOnce();
            expect(result).toMatchObject({
                kind: 'failure',
                stage: 'session',
                code: 'lease-unavailable',
                keyExchangeWrite: 'not-started',
                easyLoginWrite: 'not-started',
                poison: 'requested',
            });
            expect(linuxEasyKeyState(token)).toBe('revoked');
            expect(f.sign).not.toHaveBeenCalled();
            expect(transactRaw).not.toHaveBeenCalled();
            expect(poison).toHaveBeenCalledOnce();
            expect(poison.mock.contexts[0]).toBe(lease);
        } finally {
            delete (whenClosed as unknown as { constructor?: unknown }).constructor;
            revokeLinuxEasyKey(token);
            f.cleanup();
        }
    });

    it('rejects a key staged prematurely by the whenClosed constructor getter', async () => {
        const f = fixture();
        const whenClosed = new Promise<'released' | 'poisoned'>(() => {});
        const transactRaw = vi.fn(async () => ({
            kind: 'failure' as const,
            code: 'synthetic-unexpected-transport',
            writeState: 'not-written' as const,
        }));
        const poison = vi.fn();
        const lease = { whenClosed, transactRaw, poison, release: vi.fn(), close: vi.fn() };
        const token = createLinuxEasyKeyCapability({ lease, uin: UIN, generation: {} });
        const key = Uint8Array.from({ length: 16 }, (_, i) => 0x90 + i);
        let stateInGetter: ReturnType<typeof linuxEasyKeyState> | undefined;
        const getter = vi.fn(() => {
            stageLinuxEasyKey({ token, lease, uin: UIN, sequence: 1, key });
            stateInGetter = linuxEasyKeyState(token);
            return Promise;
        });
        Object.defineProperty(whenClosed, 'constructor', { configurable: true, get: getter });

        try {
            const result = await runLinuxEasyLoginSessionWithKeyCapability(lease, f.options, token);
            expect(getter).toHaveBeenCalledOnce();
            expect(stateInGetter).toBe('tentative');
            expect(result).toMatchObject({
                kind: 'failure',
                stage: 'session',
                keyExchangeWrite: 'not-started',
                easyLoginWrite: 'not-started',
                poison: 'requested',
            });
            expect(linuxEasyKeyState(token)).toBe('revoked');
            expect(f.sign).not.toHaveBeenCalled();
            expect(transactRaw).not.toHaveBeenCalled();
            expect(poison).toHaveBeenCalledOnce();
            expect(poison.mock.contexts[0]).toBe(lease);
        } finally {
            delete (whenClosed as unknown as { constructor?: unknown }).constructor;
            key.fill(0);
            revokeLinuxEasyKey(token);
            f.cleanup();
        }
    });

    it('revokes a reserved token when the key-exchange signer fails', async () => {
        const f = fixture();
        f.sign.mockRejectedValueOnce(new Error('synthetic signer failure'));
        const pending = f.start();

        try {
            expect((await pending).kind).toBe('failure');
            expect(linuxEasyKeyState(f.token)).toBe('revoked');
            expect(f.frames).toHaveLength(0);
        } finally {
            f.cleanup();
        }
    });

    it('revokes a reserved token when the key-exchange verifier rejects', async () => {
        const f = fixture();
        f.options.verifyServerResponse.mockReturnValue(false);
        const pending = f.start();

        try {
            await f.wrote[0]!.promise;
            f.feedKey();
            expect((await pending).kind).toBe('failure');
            expect(linuxEasyKeyState(f.token)).toBe('revoked');
            expect(f.frames).toHaveLength(1);
        } finally {
            f.cleanup();
        }
    });

    it('revokes on abort during the key-exchange signer and fences its late completion', async () => {
        const f = fixture();
        f.holdSigner();
        const pending = f.start();

        try {
            await f.signerEntered.promise;
            f.abort.abort();
            expect((await pending).kind).toBe('failure');
            expect(linuxEasyKeyState(f.token)).toBe('revoked');
            f.signerGate.resolve();
            await turn();
            expect(linuxEasyKeyState(f.token)).toBe('revoked');
            expect(f.frames).toHaveLength(0);
        } finally {
            f.cleanup();
        }
    });
});
