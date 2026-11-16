import { createCipheriv } from 'node:crypto';
import type { NTLoginForwardRequest } from '@snowluma/proto-defs/direct-login';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';
import {
    createLinuxEasyKeyCapability,
    decodeLinuxEasyServiceResponse,
    linuxEasyKeyState,
    revokeLinuxEasyKey,
} from '../../src/direct/linux-easy-key-capability';
import { decodeLinuxNTEasyLoginReferenceResponse } from '../../src/direct/nt-linux-easy-login-reference';
import { qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawMultiplexClient } from '../../src/direct/raw-multiplex-client';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import type {
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';
import {
    LINUX_EASY_LOGIN_COMMAND,
    referenceLinuxEasyLoginOnTransport,
    referenceLinuxEasyLoginWithKeyCapability,
} from '../../src/direct/sso-reference-linux-easy-login-flow';

// All identities, keys, frames and callbacks are synthetic, in-memory fixtures.
// A tentative key or a parsed frame is not a registration or authenticated push.
const SEQUENCE = 0xf0000001;
const PUSH_SEQUENCE = 0x80000002;
const PUSH_COMMAND = 'Synthetic.FollowingFrame';
const ZERO = new Uint8Array(16);
const SESSION_KEY = Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i);
const D2_KEY = Uint8Array.from({ length: 16 }, (_, i) => 0x70 + i);

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

const word = (value: number) => {
    const output = Buffer.alloc(4);
    output.writeUInt32BE(value >>> 0);
    return output;
};

const field = (value: Uint8Array) => Buffer.concat([word(value.length + 4), value]);

// The small protobuf fields here deliberately preserve present-empty versus absent.
function pbField(number: number, value: Uint8Array): Buffer {
    if (value.length >= 128) {
        throw new Error('fixture field too large');
    }

    return Buffer.concat([Buffer.of(number * 8 + 2, value.length), value]);
}

type Fault = 'none' | 'nonzero' | 'missing-code' | 'missing-body' | 'missing-d2' | 'bad-key';

function plain(fault: Fault): Buffer {
    const errorInfo =
        fault === 'missing-code' ? Buffer.alloc(0) : Buffer.of(8, fault === 'nonzero' ? 1 : 0);
    const head = pbField(1, pbField(4, errorInfo));

    if (fault === 'missing-body') {
        return head;
    }

    const tickets = Buffer.concat([
        pbField(3, Buffer.alloc(0)),
        pbField(4, Buffer.alloc(0)),
        ...(fault === 'missing-d2' ? [] : [pbField(5, Buffer.of(0x41, 0x42))]),
        pbField(6, fault === 'bad-key' ? D2_KEY.subarray(0, 15) : D2_KEY),
    ]);
    return Buffer.concat([head, pbField(2, pbField(1, tickets))]);
}

function sso(sequence: number, command: string, body: Uint8Array): Buffer {
    const header = Buffer.concat([
        word(sequence),
        word(0),
        field(Buffer.alloc(0)),
        field(Buffer.from(command)),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    return Buffer.concat([field(header), field(body)]);
}

function frame(
    uin: string,
    sequence: number,
    command: string,
    body: Uint8Array,
    key: Uint8Array,
): Uint8Array {
    const inner = sso(sequence, command, body);
    const encrypted = qqTeaEncrypt(inner, key, (length) => new Uint8Array(length).fill(0x35));
    const result = Buffer.concat([
        word(0),
        word(12),
        Buffer.of(key === ZERO ? 2 : 1, 0),
        field(Buffer.from(uin)),
        encrypted,
    ]);
    result.writeUInt32BE(result.length);
    return Uint8Array.from(result);
}

function easyResponse(uin: string, fault: Fault): Uint8Array {
    const nonce = Buffer.alloc(12, 0x51);
    const cipher = createCipheriv('aes-128-gcm', SESSION_KEY, nonce);
    const encrypted = Buffer.concat([
        nonce,
        cipher.update(plain(fault)),
        cipher.final(),
        cipher.getAuthTag(),
    ]);
    const body = protobuf_encode<NTLoginForwardRequest>({
        sessionTicket: Uint8Array.of(0x42),
        buffer: encrypted,
        type: 1,
    });
    return frame(uin, SEQUENCE, LINUX_EASY_LOGIN_COMMAND, body, ZERO);
}

function fixture(uin = '123456', fault: Fault = 'none', transportUin = uin) {
    const wrote = deferred<void>();
    const verifyEntered = deferred<void>();
    const verifyGate = deferred<boolean>();
    const followingEntered = deferred<void>();
    const followingGate = deferred<void>();
    const abort = new AbortController();
    const classified: string[] = [];
    const buffered: number[] = [];
    const authenticated: number[] = [];
    let registrationCommitted = false;
    let settled = false;
    let lease!: ReturnType<ReturnType<typeof createRawSessionBroker>['acquire']>;
    let token!: ReturnType<typeof createLinuxEasyKeyCapability>;
    const hold = vi.fn(({ uin: identityUin, sequence }: { uin: string; sequence: number }) => {
        expect({ uin: identityUin, sequence }).toEqual({ uin, sequence: SEQUENCE });
        return true; // This fixture has only the Easy response transaction.
    });
    const client = createRawMultiplexClient({
        uin: transportUin,
        initialSequence: SEQUENCE,
        defaultTimeoutMs: 5000,
        maxFrameBytes: 8192,
        maxBufferedBytes: 16384,
        maxFrames: 4,
        maxPushFrames: 4,
        maxPushBytes: 8192,
        write: () => wrote.resolve(),
        holdFollowingFrames: hold,
        classify: async (bytes, identity) => {
            expect(identity.uin).toBe(uin);

            if (bytes[8] === 2) {
                classified.push('easy');
                return { kind: 'response', sequence: SEQUENCE };
            }

            classified.push('following');
            expect(linuxEasyKeyState(token)).toBe('tentative');
            expect(registrationCommitted).toBe(false);
            expect(settled).toBe(false);
            const decoded = decodeLinuxEasyServiceResponse({ token, lease, uin, frame: bytes });

            try {
                expect(decoded).toMatchObject({
                    uin,
                    sequence: PUSH_SEQUENCE,
                    command: PUSH_COMMAND,
                    retCode: 0,
                });
            } finally {
                decoded.body.fill(0);
            }

            followingEntered.resolve();
            await followingGate.promise;
            return { kind: 'push', name: 'synthetic-pending-registration', id: PUSH_SEQUENCE };
        },
        verifyPush: () => true,
        onPush: (_bytes, route) => {
            // The fixture owner buffers provisional observations, never dispatches them as authenticated.
            if (registrationCommitted) {
                authenticated.push(route.id);
            } else {
                buffered.push(route.id);
            }
        },
    });
    lease = createRawSessionBroker(client, {
        trustedSuccessQuiescence: true,
        isUsable: () => !client.closed,
    }).acquire({ deadline: performance.now() + 10000 });
    token = createLinuxEasyKeyCapability({ lease, uin, generation: {} });
    const sign = vi.fn(
        (input: { uin: string; sequence: number; command: string; body: Uint8Array }) => {
            expect(Object.keys(input).sort()).toEqual(['body', 'command', 'sequence', 'uin']);
            expect(input).toMatchObject({
                uin,
                sequence: SEQUENCE,
                command: LINUX_EASY_LOGIN_COMMAND,
            });
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
            expect(input).toMatchObject({
                uin,
                sequence: SEQUENCE,
                command: LINUX_EASY_LOGIN_COMMAND,
            });
            expect(linuxEasyKeyState(token)).toBe('empty');
            verifyEntered.resolve();
            return await verifyGate.promise;
        },
    );
    const options: Parameters<typeof referenceLinuxEasyLoginOnTransport>[1] = {
        uin,
        sessionKey: Uint8Array.from(SESSION_KEY),
        sessionTicket: Uint8Array.of(0x11),
        a1: Uint8Array.of(0x12),
        nonce: new Uint8Array(12),
        guid: Uint8Array.of(1, 2),
        version: 'fixture-version',
        subAppId: 42,
        deviceName: 'fixture-device',
        deviceType: 'fixture-pc',
        appId: 42,
        appName: 'fixture-app',
        qua: 'fixture-qua',
        timeoutMs: 5000,
        signal: abort.signal,
        buildReserved: sign,
        verifyRaw: verify,
    };
    const following = frame(uin, PUSH_SEQUENCE, PUSH_COMMAND, Uint8Array.of(1, 2), D2_KEY);
    const feed = () => client.feed(Buffer.concat([easyResponse(uin, fault), following]));
    const feedEasy = () => client.feed(easyResponse(uin, fault));

    const start = () => {
        const pending = referenceLinuxEasyLoginWithKeyCapability(lease, options, { token, lease });
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

    const cleanup = () => {
        verifyGate.resolve(true);
        followingGate.resolve();
        lease.release();
        client.close();
        revokeLinuxEasyKey(token);
    };

    return {
        client,
        lease,
        token,
        options,
        abort,
        wrote,
        verifyEntered,
        verifyGate,
        followingEntered,
        followingGate,
        classified,
        buffered,
        authenticated,
        hold,
        sign,
        verify,
        feed,
        feedEasy,
        start,
        cleanup,
        isSettled: () => settled,
    };
}

describe('EasyLogin key staging with coalesced synthetic memory frames', () => {
    it('holds the following D2 frame until verified consumption stages the key, before login settles', async () => {
        const f = fixture();
        const pending = f.start();

        try {
            await f.wrote.promise;
            f.feed();
            await f.verifyEntered.promise;
            await turn();
            expect(f.classified).toEqual(['easy']);
            expect(linuxEasyKeyState(f.token)).toBe('empty');
            expect(f.isSettled()).toBe(false);
            expect(f.authenticated).toEqual([]);
            f.verifyGate.resolve(true);
            await f.followingEntered.promise;
            expect(f.classified).toEqual(['easy', 'following']);
            expect(linuxEasyKeyState(f.token)).toBe('tentative');
            expect(f.isSettled()).toBe(false);
            expect(f.buffered).toEqual([]);
            expect(f.authenticated).toEqual([]);
            f.followingGate.resolve();
            const result = await pending;
            expect(result).toMatchObject({ kind: 'response', sequence: SEQUENCE });
            expect(linuxEasyKeyState(f.token)).toBe('tentative');
            expect(f.hold).toHaveBeenCalledOnce();
            expect(f.sign).toHaveBeenCalledOnce();
            expect(f.verify).toHaveBeenCalledOnce();
            expect(f.authenticated).toEqual([]);

            if (result.kind !== 'response' || result.value.body === null) {
                throw new Error('expected owned synthetic ticket body');
            }

            const ownedBody = result.value.body;

            try {
                await turn();
                const tickets = decodeLinuxNTEasyLoginReferenceResponse(ownedBody);

                try {
                    expect(tickets).toEqual({
                        ticketsPresent: true,
                        a1: new Uint8Array(),
                        a2: new Uint8Array(),
                        d2: Uint8Array.of(0x41, 0x42),
                        d2Key: D2_KEY,
                    });
                } finally {
                    tickets.a1?.fill(0);
                    tickets.a2?.fill(0);
                    tickets.d2?.fill(0);
                    tickets.d2Key?.fill(0);
                }
            } finally {
                ownedBody.fill(0);
            }
        } finally {
            f.cleanup();
        }
    });

    it.each(['nonzero', 'missing-code', 'missing-body', 'missing-d2', 'bad-key'] as const)(
        'revokes %s before the following frame can be classified',
        async (fault) => {
            const f = fixture('123456', fault);
            const pending = f.start();

            try {
                await f.wrote.promise;
                f.feed();
                await f.verifyEntered.promise;
                expect(f.classified).toEqual(['easy']);
                f.verifyGate.resolve(true);
                const result = await pending.catch(() => ({ kind: 'rejected' as const }));
                expect(result.kind).not.toBe('response');
                expect(linuxEasyKeyState(f.token)).toBe('revoked');
                await turn();
                expect(f.classified).toEqual(['easy']);
                expect(f.buffered).toEqual([]);
                expect(f.authenticated).toEqual([]);
            } finally {
                f.cleanup();
            }
        },
    );

    it('revokes on verifier rejection without processing the held frame', async () => {
        const f = fixture();
        const pending = f.start();

        try {
            await f.wrote.promise;
            f.feed();
            await f.verifyEntered.promise;
            f.verifyGate.resolve(false);
            expect((await pending).kind).toBe('failure');
            expect(linuxEasyKeyState(f.token)).toBe('revoked');
            await turn();
            expect(f.classified).toEqual(['easy']);
            expect(f.authenticated).toEqual([]);
        } finally {
            f.cleanup();
        }
    });

    it('revokes on abort and fences a late successful verifier', async () => {
        const f = fixture();
        const pending = f.start();

        try {
            await f.wrote.promise;
            f.feed();
            await f.verifyEntered.promise;
            f.abort.abort();
            expect((await pending).kind).toBe('failure');
            expect(linuxEasyKeyState(f.token)).toBe('revoked');
            f.verifyGate.resolve(true);
            await turn();
            expect(linuxEasyKeyState(f.token)).toBe('revoked');
            expect(f.classified).toEqual(['easy']);
            expect(f.authenticated).toEqual([]);
        } finally {
            f.cleanup();
        }
    });

    it.each(['sequence', 'opaque-result', 'failure', 'throw'] as const)(
        'revokes after a staged candidate when the transport settles with %s',
        async (mode) => {
            const f = fixture();
            const staged = deferred<void>();
            const settleGate = deferred<void>();
            const identity = { uin: '123456', sequence: SEQUENCE };
            const transport: Sso12RawTransport = {
                async transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                    const built = await raw.buildRequest(identity);
                    const candidate = easyResponse(identity.uin, 'none');
                    const accepted = await raw.verifyCandidate(candidate, built.context, identity);
                    expect(accepted).toBe(true);
                    const opaque = await raw.consumeCandidate(candidate, built.context, identity);
                    expect(linuxEasyKeyState(f.token)).toBe('tentative');
                    staged.resolve();
                    await settleGate.promise;

                    if (mode === 'throw') {
                        throw new Error('synthetic transport failure');
                    }

                    if (mode === 'failure') {
                        return {
                            kind: 'failure',
                            code: 'synthetic-failure',
                            writeState: 'unknown',
                        };
                    }

                    return {
                        kind: 'response',
                        sequence: mode === 'sequence' ? SEQUENCE + 1 : SEQUENCE,
                        value: mode === 'opaque-result' ? ({} as T) : opaque,
                        writeState: 'written',
                    };
                },
            };
            const pending = referenceLinuxEasyLoginWithKeyCapability(transport, f.options, {
                token: f.token,
                lease: f.lease,
            });

            try {
                await f.verifyEntered.promise;
                f.verifyGate.resolve(true);
                await staged.promise;
                expect(linuxEasyKeyState(f.token)).toBe('tentative');
                settleGate.resolve();
                const result = await pending.catch(() => ({ kind: 'rejected' as const }));
                expect(result.kind).not.toBe('response');
                expect(linuxEasyKeyState(f.token)).toBe('revoked');
                expect(f.authenticated).toEqual([]);
            } finally {
                settleGate.resolve();
                f.cleanup();
            }
        },
    );

    it('revokes after staging when a partial next-frame prefix is interrupted', async () => {
        const f = fixture();
        const staged = deferred<void>();
        const transport: Sso12RawTransport = {
            transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                return f.lease.transactRaw({
                    ...raw,
                    consumeCandidate: async (...args) => {
                        const result = await raw.consumeCandidate(...args);
                        staged.resolve();
                        return result;
                    },
                });
            },
        };
        const pending = referenceLinuxEasyLoginWithKeyCapability(transport, f.options, {
            token: f.token,
            lease: f.lease,
        });
        const following = frame('123456', PUSH_SEQUENCE, PUSH_COMMAND, Uint8Array.of(1, 2), D2_KEY);

        try {
            await f.wrote.promise;
            f.client.feed(
                Buffer.concat([easyResponse('123456', 'none'), following.subarray(0, 2)]),
            );
            await f.verifyEntered.promise;
            f.verifyGate.resolve(true);
            await staged.promise;
            expect(linuxEasyKeyState(f.token)).toBe('tentative');
            expect(f.classified).toEqual(['easy']);
            f.abort.abort();
            expect((await pending).kind).toBe('failure');
            expect(linuxEasyKeyState(f.token)).toBe('revoked');
            expect(() => f.client.feed(following.subarray(2))).toThrow();
            await turn();
            expect(linuxEasyKeyState(f.token)).toBe('revoked');
            expect(f.classified).toEqual(['easy']);
            expect(f.authenticated).toEqual([]);
        } finally {
            f.cleanup();
        }
    });

    it('rejects a foreign binding lease without changing the unclaimed slot or invoking callbacks', async () => {
        const f = fixture();
        const pending = referenceLinuxEasyLoginWithKeyCapability(f.lease, f.options, {
            token: f.token,
            lease: {},
        });

        try {
            const result = await pending.catch(() => ({ kind: 'rejected' as const }));
            expect(result.kind).not.toBe('response');
            expect(linuxEasyKeyState(f.token)).toBe('empty');
            expect(f.sign).not.toHaveBeenCalled();
            expect(f.verify).not.toHaveBeenCalled();
            expect(f.classified).toEqual([]);
            expect(f.authenticated).toEqual([]);
        } finally {
            f.cleanup();
        }
    });

    it('revokes on a mismatched transport identity before signing or writing', async () => {
        const f = fixture('123456', 'none', '234567');
        const pending = f.start();

        try {
            const result = await pending.catch(() => ({ kind: 'rejected' as const }));
            expect(result.kind).not.toBe('response');
            expect(linuxEasyKeyState(f.token)).toBe('revoked');
            expect(f.sign).not.toHaveBeenCalled();
            expect(f.verify).not.toHaveBeenCalled();
            expect(f.classified).toEqual([]);
            expect(f.authenticated).toEqual([]);
        } finally {
            f.cleanup();
        }
    });

    it('preserves the public entry behavior for an explicit nonzero response', async () => {
        const f = fixture('123456', 'nonzero');
        const pending = referenceLinuxEasyLoginOnTransport(f.lease, f.options);

        try {
            await f.wrote.promise;
            f.feedEasy();
            await f.verifyEntered.promise;
            f.verifyGate.resolve(true);
            const result = await pending;
            expect(result).toMatchObject({
                kind: 'response',
                sequence: SEQUENCE,
                value: { status: { kind: 'code', codePresent: true, code: 1n } },
            });
            expect(linuxEasyKeyState(f.token)).toBe('empty');
            expect(f.classified).toEqual(['easy']);
            expect(f.authenticated).toEqual([]);

            if (result.kind === 'response') {
                result.value.body?.fill(0);
            }
        } finally {
            f.cleanup();
        }
    });

    it('keeps a successful second account tentative while the first account fails', async () => {
        const a = fixture('123456', 'nonzero');
        const b = fixture('234567');
        const first = a.start();
        const second = b.start();

        try {
            await Promise.all([a.wrote.promise, b.wrote.promise]);
            a.feed();
            b.feed();
            await Promise.all([a.verifyEntered.promise, b.verifyEntered.promise]);
            a.verifyGate.resolve(true);
            expect((await first).kind).toBe('failure');
            expect(linuxEasyKeyState(a.token)).toBe('revoked');
            expect(linuxEasyKeyState(b.token)).toBe('empty');
            b.verifyGate.resolve(true);
            await b.followingEntered.promise;
            expect(linuxEasyKeyState(b.token)).toBe('tentative');
            expect(a.classified).toEqual(['easy']);
            expect(a.authenticated).toEqual([]);
            expect(b.authenticated).toEqual([]);
            b.followingGate.resolve();
            const result = await second;
            expect(result.kind).toBe('response');
            expect(linuxEasyKeyState(a.token)).toBe('revoked');
            expect(linuxEasyKeyState(b.token)).toBe('tentative');

            if (result.kind === 'response') {
                result.value.body?.fill(0);
            }
        } finally {
            a.cleanup();
            b.cleanup();
        }
    });
});
