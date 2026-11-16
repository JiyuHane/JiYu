import { createCipheriv, createECDH } from 'node:crypto';
import type { NTLoginForwardRequest } from '@snowluma/proto-defs/direct-login';
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
    linuxEasyKeyState,
    revokeLinuxEasyKey,
} from '../../src/direct/linux-easy-key-capability';
import { runLinuxEasyLoginSessionWithKeyCapability } from '../../src/direct/linux-easy-login-session';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { createRawMultiplexClient } from '../../src/direct/raw-multiplex-client';
import { createRawSessionBroker } from '../../src/direct/raw-session-broker';
import { LINUX_EASY_LOGIN_COMMAND } from '../../src/direct/sso-reference-linux-easy-login-flow';

// Wrap the real stage, not the flow or decoder: time advances only after the
// actual key has been staged inside the real verified response consumer.
const race = vi.hoisted(() => ({
    advance: undefined as undefined | (() => void),
    commitCalls: 0,
}));
vi.mock('../../src/direct/linux-easy-key-capability', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('../../src/direct/linux-easy-key-capability')>();
    return {
        ...actual,
        stageLinuxEasyKey: (input: Parameters<typeof actual.stageLinuxEasyKey>[0]) => {
            actual.stageLinuxEasyKey(input);
            race.advance?.();
        },
        commitLinuxEasyKey: (input: Parameters<typeof actual.commitLinuxEasyKey>[0]) => {
            race.commitCalls++;
            actual.commitLinuxEasyKey(input);
        },
    };
});

// Synthetic bytes, synchronous memory-only write and in-memory mux; no network.
const UIN = '123456';
const FIRST = 123;
const EASY = FIRST + 1;
const PUSH = FIRST + 2;
const ZERO = new Uint8Array(16);
const SESSION_KEY = Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i);
const D2_KEY = Uint8Array.from({ length: 16 }, (_, i) => 0x70 + i);
const TICKET = Uint8Array.from({ length: 24 }, (_, i) => 0x60 + i);

function peer(scalar: number) {
    const ecdh = createECDH('prime256v1');
    const privateKey = Buffer.alloc(32);
    privateKey[31] = scalar;
    ecdh.setPrivateKey(privateKey);
    return ecdh;
}

function seal(plain: Uint8Array, key: Uint8Array, nonce: Uint8Array): Buffer {
    const cipher = createCipheriv(key.length === 32 ? 'aes-256-gcm' : 'aes-128-gcm', key, nonce);
    return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function word(value: number): Buffer {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value >>> 0);
    return out;
}

const field = (value: Uint8Array): Buffer => Buffer.concat([word(value.length + 4), value]);

function pbField(number: number, value: Uint8Array): Buffer {
    if (value.length >= 128) {
        throw new Error('fixture field too large');
    }

    return Buffer.concat([Buffer.of(number * 8 + 2, value.length), value]);
}

function ticketBody(): Buffer {
    const tickets = Buffer.concat([
        pbField(3, Buffer.alloc(0)),
        pbField(4, Buffer.alloc(0)),
        pbField(5, Buffer.of(0x41, 0x42)),
        pbField(6, D2_KEY),
    ]);
    return pbField(1, tickets);
}

function response(sequence: number, command: string, body: Uint8Array, key = ZERO): Uint8Array {
    const header = Buffer.concat([
        word(sequence),
        word(0),
        field(Buffer.alloc(0)),
        field(Buffer.from(command)),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    const sso = Buffer.concat([field(header), field(body)]);
    const encrypted = qqTeaEncrypt(sso, key, (length) => new Uint8Array(length).fill(0x35));
    const frame = Buffer.concat([
        word(0),
        word(12),
        Buffer.of(key === ZERO ? 2 : 1, 0),
        field(Buffer.from(UIN)),
        encrypted,
    ]);
    frame.writeUInt32BE(frame.length);
    return Uint8Array.from(frame);
}

function requestBody(frame: Uint8Array): Uint8Array {
    const bytes = Buffer.from(frame);
    const end = 14 + bytes.readUInt32BE(14);
    const sso = Buffer.from(qqTeaDecrypt(bytes.subarray(end), ZERO));
    const headerLength = sso.readUInt32BE(0);
    const bodyLength = sso.readUInt32BE(headerLength);
    return sso.subarray(headerLength + 4, headerLength + bodyLength);
}

function setup() {
    const writes: number[] = [];
    const classified: string[] = [];
    const buffered: number[] = [];
    const delivered: number[] = [];
    const registered = false;
    let stageState = '';
    let timersAtStage = 0;
    let now = 1000.25;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    let token!: ReturnType<typeof createLinuxEasyKeyCapability>;
    const verify = vi.fn(({ command }: { command: string }) => {
        if (command === KEY_EXCHANGE_COMMAND || command === LINUX_EASY_LOGIN_COMMAND) {
            return true;
        }

        throw new Error('unexpected verifier command');
    });
    const accept = vi.fn(() => {
        // ceil(99.75) gives the Easy child a deadline of 1100.5, while the
        // outer session's unrounded absolute deadline remains 1100.25.
        now = 1000.5;
        return true;
    });
    const client = createRawMultiplexClient({
        uin: UIN,
        initialSequence: FIRST,
        defaultTimeoutMs: 5000,
        maxFrameBytes: 8192,
        maxBufferedBytes: 16384,
        maxFrames: 4,
        maxPushFrames: 4,
        maxPushBytes: 8192,
        write: (bytes) => {
            const index = writes.length;
            writes.push(index);

            if (index === 0) {
                const request = decodeKeyExchangeRequest(requestBody(bytes));

                if (!request.publicKey) {
                    throw new Error('missing synthetic public key');
                }

                const ephemeral = peer(2);
                const secret = encodeKeyExchangeResponseSecret({
                    sessionKey: SESSION_KEY,
                    sessionTicket: TICKET,
                    expiration: 300,
                });
                const body = encodeKeyExchangeResponse({
                    publicKey: ephemeral.getPublicKey(),
                    secret: seal(
                        secret,
                        ephemeral.computeSecret(request.publicKey),
                        Buffer.alloc(12, 0x42),
                    ),
                });
                client.feed(response(FIRST, KEY_EXCHANGE_COMMAND, body));
                return;
            }

            if (index !== 1) {
                throw new Error('unexpected write');
            }

            // Encode an explicitly present zero status and present-empty tickets.
            const common = Buffer.concat([
                pbField(1, pbField(4, Buffer.of(8, 0))),
                pbField(2, ticketBody()),
            ]);
            const body = protobuf_encode<NTLoginForwardRequest>({
                sessionTicket: Uint8Array.of(0x42),
                buffer: seal(common, SESSION_KEY, Buffer.alloc(12, 0x51)),
                type: 1,
            });
            const easy = response(EASY, LINUX_EASY_LOGIN_COMMAND, body);
            const following = response(
                PUSH,
                'Synthetic.FollowingFrame',
                Uint8Array.of(1, 2),
                D2_KEY,
            );
            client.feed(Buffer.concat([easy, following]));
        },
        classify: (bytes, identity) => {
            if (bytes[8] === 1) {
                classified.push('following');
                return { kind: 'push', name: 'synthetic', id: PUSH };
            }

            classified.push(identity.sequence === FIRST ? 'key' : 'easy');
            return { kind: 'response', sequence: identity.sequence! };
        },
        holdFollowingFrames: ({ sequence }) => sequence === EASY,
        verifyPush: () => true,
        onPush: (_bytes, route) => {
            if (registered) {
                delivered.push(route.id);
            } else {
                buffered.push(route.id);
            }
        },
    });
    const lease = createRawSessionBroker(client, {
        trustedSuccessQuiescence: true,
        isUsable: () => !client.closed,
    }).acquire({ deadline: 5000 });
    token = createLinuxEasyKeyCapability({ lease, uin: UIN, generation: {} });
    const originalPoison = lease.poison;
    const poisonStates: string[] = [];
    const poison = vi.spyOn(lease, 'poison').mockImplementation(() => {
        poisonStates.push(linuxEasyKeyState(token));
        originalPoison.call(lease);
    });
    const options: Parameters<typeof runLinuxEasyLoginSessionWithKeyCapability>[1] = {
        uin: UIN,
        guid: Uint8Array.of(1, 2, 3, 4),
        version: 'synthetic-version',
        subAppId: 1234,
        a1: Uint8Array.of(0x10, 0xff),
        nonce: Uint8Array.from({ length: 12 }, (_, i) => i),
        deviceName: 'fixture-device',
        deviceType: 'fixture-pc',
        appId: 42,
        appName: 'fixture-app',
        qua: 'fixture-qua',
        serverPublicKey: Uint8Array.from(peer(1).getPublicKey()),
        verifyKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
        timestamp: 1700000000,
        timeoutMs: 100,
        buildReserved: () => Uint8Array.of(0xaa),
        verifyRaw: verify,
        verifyServerResponse: () => true,
        acceptKeyExchange: accept,
    };

    return {
        client,
        lease,
        token,
        options,
        writes,
        classified,
        buffered,
        delivered,
        poison,
        poisonStates,
        verify,
        accept,
        clock,
        observeStage(crossDeadline: boolean) {
            race.advance = () => {
                stageState = linuxEasyKeyState(token);
                timersAtStage = vi.getTimerCount();

                if (crossDeadline) {
                    now = 1100.3;
                }
            };
        },
        stageState: () => stageState,
        timersAtStage: () => timersAtStage,
    };
}

describe('capability session absolute deadline during Easy consumption', () => {
    it.each([false, true])(
        'stages a real decoded key with deadline crossing=%s',
        async (crossDeadline) => {
            // Do not fake performance or setImmediate. Timers stay pending throughout
            // this scenario; only our monotonic clock spy moves, inside real staging.
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            const f = setup();
            race.commitCalls = 0;
            f.observeStage(crossDeadline);

            try {
                const result = await runLinuxEasyLoginSessionWithKeyCapability(
                    f.lease,
                    f.options,
                    f.token,
                );
                expect(f.writes).toEqual([0, 1]);
                expect(f.verify).toHaveBeenCalledTimes(2);
                expect(f.accept).toHaveBeenCalledOnce();
                expect(f.stageState()).toBe('tentative');
                expect(f.timersAtStage()).toBeGreaterThan(0);
                expect(race.commitCalls).toBe(0);

                if (crossDeadline) {
                    expect(result).toMatchObject({
                        kind: 'failure',
                        stage: 'easy-login',
                        code: 'timeout',
                        keyExchangeWrite: 'written',
                        poison: 'requested',
                    });
                    expect(result).not.toHaveProperty('value');
                    expect(linuxEasyKeyState(f.token)).toBe('revoked');
                    expect(f.poison).toHaveBeenCalledOnce();
                    expect(f.poisonStates).toEqual(['revoked']);
                    expect(f.client.closed).toBe(true);
                    expect(f.classified).toEqual(['key', 'easy']);
                    expect(f.buffered).toEqual([]);
                    expect(f.delivered).toEqual([]);
                } else {
                    expect(result.kind).toBe('response');
                    expect(linuxEasyKeyState(f.token)).toBe('tentative');
                    expect(f.poison).not.toHaveBeenCalled();
                    expect(f.classified).toEqual(['key', 'easy', 'following']);
                    expect(f.buffered).toEqual([PUSH]);
                    expect(f.delivered).toEqual([]);

                    if (result.kind === 'response') {
                        result.value.body?.fill(0);
                    }
                }
            } finally {
                race.advance = undefined;
                revokeLinuxEasyKey(f.token);
                f.lease.poison();
                f.client.close();
                f.clock.mockRestore();
                vi.useRealTimers();
            }
        },
    );
});
