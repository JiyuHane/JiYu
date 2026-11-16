import { createCipheriv, createECDH } from 'node:crypto';
import type {
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
    runLinuxEasyLoginSession,
    type LinuxEasyLoginSessionOptions,
    type LinuxEasyLoginSessionResult,
} from '../../src/direct/linux-easy-login-session';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import type { RawSessionLease } from '../../src/direct/raw-session-broker';
import { LINUX_EASY_LOGIN_COMMAND } from '../../src/direct/sso-reference-linux-easy-login-flow';
import type { Sso12RawOptions, Sso12RawResult } from '../../src/direct/sso12-packet-client';

// Synthetic in-memory responses only. These tests make no claim about a real
// first-stage key, the second-stage request body, a peer, or online login.
const UIN = '123456';
const ZERO = new Uint8Array(16);
const KEY = Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i);
const TICKET = Uint8Array.from({ length: 24 }, (_, i) => 0x60 + i);
const BODY = Uint8Array.of(0xff, 0, 0xc3, 0x28);
const SEQUENCES = [0x80000001, 0xf0000002] as const;

function word(n: number): Buffer {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(n >>> 0);
    return result;
}

function field(data: Uint8Array): Buffer {
    return Buffer.concat([word(data.length + 4), data]);
}

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

function unpack(frameBytes: Uint8Array): { command: string; body: Uint8Array } {
    const frame = Buffer.from(frameBytes);
    const end = 14 + frame.readUInt32BE(14);
    const sso = Buffer.from(qqTeaDecrypt(frame.subarray(end), ZERO));
    let offset = 28;

    const take = (width: 2 | 4 = 4): Buffer => {
        const length = width === 2 ? sso.readUInt16BE(offset) : sso.readUInt32BE(offset);
        const data = sso.subarray(offset + width, offset + length);
        offset += length;
        return data;
    };

    take();
    const command = take().toString();
    take();
    take();
    take();
    take(2);
    take();
    return { command, body: take() };
}

function response(sequence: number, command: string, body: Uint8Array): Uint8Array {
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
    const frame = Buffer.concat([
        word(0),
        word(12),
        Buffer.of(2, 0),
        field(Buffer.from(UIN)),
        Buffer.from(qqTeaEncrypt(inner, ZERO)),
    ]);
    frame.writeUInt32BE(frame.length);
    return Uint8Array.from(frame);
}

function options(): LinuxEasyLoginSessionOptions {
    return {
        uin: UIN,
        guid: Uint8Array.of(1, 2, 3, 4),
        version: 'synthetic-version',
        subAppId: 1234,
        a2: Uint8Array.of(0x81, 0, 0xfe),
        a1: Uint8Array.of(0x10, 0, 0xff, 0x20),
        nonce: Uint8Array.from({ length: 12 }, (_, i) => i),
        deviceName: 'fixture-device',
        deviceType: 'fixture-pc',
        appId: 42,
        appName: 'fixture-app',
        qua: 'fixture-qua',
        serverPublicKey: Uint8Array.from(peer(1).getPublicKey()),
        verifyKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
        timestamp: 1700000000,
        timeoutMs: 5000,
        buildReserved: vi.fn(() => Uint8Array.of(0xaa, 0, 0xfe)),
        verifyRaw: vi.fn(() => true),
        verifyServerResponse: vi.fn(() => true),
        acceptKeyExchange: vi.fn(() => true),
    };
}

function setup() {
    const calls: string[] = [];
    const errors: unknown[] = [];
    let transactionCount = 0;
    let onPoison: (() => void) | undefined;
    const poison = vi.fn(() => onPoison?.());
    const lease: RawSessionLease = {
        // Keep lifecycle independent of poison so the exact-object WeakSet is
        // exercised even after a failed winner, rather than broker retirement.
        whenClosed: new Promise<'released' | 'poisoned'>(() => {}),
        poison,
        release: vi.fn(),
        close: vi.fn(),
        async transactRaw<C, T>(raw: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
            const index = transactionCount++;
            const sequence = SEQUENCES[index];

            try {
                if (sequence === undefined) {
                    throw new Error('unexpected extra transaction');
                }

                const identity = { uin: UIN, sequence };
                const built = await raw.buildRequest(identity);
                const request = unpack(built.frame);
                calls.push(request.command);
                let body: Uint8Array;

                if (index === 0) {
                    if (request.command !== KEY_EXCHANGE_COMMAND) {
                        throw new Error('unexpected first command');
                    }

                    const decoded = decodeKeyExchangeRequest(request.body);
                    const ephemeral = peer(2);
                    const shared = ephemeral.computeSecret(decoded.publicKey!);
                    const secret = encodeKeyExchangeResponseSecret({
                        sessionKey: KEY,
                        sessionTicket: TICKET,
                        expiration: 300,
                    });
                    body = encodeKeyExchangeResponse({
                        publicKey: ephemeral.getPublicKey(),
                        secret: seal(secret, shared, Buffer.alloc(12, 0x42)),
                    });
                } else {
                    if (request.command !== LINUX_EASY_LOGIN_COMMAND) {
                        throw new Error('unexpected second command');
                    }

                    const common = protobuf_encode<LinuxNTLoginReferenceResponseCommon>({
                        head: { errorInfo: { code: 0n } },
                        body: BODY,
                    });
                    body = protobuf_encode<NTLoginForwardRequest>({
                        sessionTicket: Uint8Array.of(0x42),
                        buffer: seal(common, KEY, Buffer.from('101112131415161718191a1b', 'hex')),
                        type: 1,
                    });
                }

                const candidate = response(sequence, request.command, body);

                if (!(await raw.verifyCandidate(candidate, built.context, identity))) {
                    return { kind: 'failure', code: 'rejected', writeState: 'unknown' };
                }

                const value = await raw.consumeCandidate(candidate, built.context, identity);
                return { kind: 'response', sequence, value, writeState: 'written' };
            } catch (error) {
                errors.push(error);
                return { kind: 'failure', code: 'fake-error', writeState: 'unknown' };
            }
        },
    };
    return {
        lease,
        poison,
        calls,
        errors,
        count: () => transactionCount,
        setOnPoison: (fn: () => void) => {
            onPoison = fn;
        },
    };
}

function expectUnavailable(result: LinuxEasyLoginSessionResult): void {
    expect(result).toEqual({
        kind: 'failure',
        stage: 'session',
        code: 'lease-unavailable',
        keyExchangeWrite: 'not-started',
        easyLoginWrite: 'not-started',
        poison: 'not-requested',
    });
}

function expectNoCallbacks(input: LinuxEasyLoginSessionOptions): void {
    expect(input.buildReserved).not.toHaveBeenCalled();
    expect(input.verifyRaw).not.toHaveBeenCalled();
    expect(input.verifyServerResponse).not.toHaveBeenCalled();
    expect(input.acceptKeyExchange).not.toHaveBeenCalled();
}

function expectSuccess(result: LinuxEasyLoginSessionResult): void {
    expect(result.kind).toBe('response');

    if (result.kind !== 'response') {
        throw new Error('expected controlled synthetic response');
    }

    expect(result.keyExchangeSequence).toBe(SEQUENCES[0]);
    expect(result.easyLoginSequence).toBe(SEQUENCES[1]);
    expect(result.value.status).toEqual({ kind: 'code', code: 0n, codePresent: true });
    expect(result.value.body).toEqual(BODY);
}

describe('same-module exact-lease reentry on an in-memory fake', () => {
    it('rejects synchronous first signer reentry without disturbing the winner, including after success', async () => {
        const f = setup();
        const winner = options();
        const duplicate = options();
        let nested: Promise<LinuxEasyLoginSessionResult> | undefined;
        let countAtReentry = -1;
        let countAfterReentry = -1;
        winner.buildReserved = vi.fn((input) => {
            if (input.command === KEY_EXCHANGE_COMMAND) {
                countAtReentry = f.count();
                nested = runLinuxEasyLoginSession(f.lease, duplicate);
                countAfterReentry = f.count();
            }

            return Uint8Array.of(0xaa, 0, 0xfe);
        });

        const result = await runLinuxEasyLoginSession(f.lease, winner);
        expect(nested).toBeDefined();
        expectUnavailable(await nested!);
        expect([countAtReentry, countAfterReentry]).toEqual([1, 1]);
        expectSuccess(result);
        expect(f.calls).toEqual([KEY_EXCHANGE_COMMAND, LINUX_EASY_LOGIN_COMMAND]);
        expect(f.count()).toBe(2);
        expect(f.poison).not.toHaveBeenCalled();
        expect(f.errors).toEqual([]);
        expect(winner.buildReserved).toHaveBeenCalledTimes(2);
        expect(winner.verifyRaw).toHaveBeenCalledTimes(2);
        expect(winner.verifyServerResponse).toHaveBeenCalledOnce();
        expect(winner.acceptKeyExchange).toHaveBeenCalledOnce();
        expectNoCallbacks(duplicate);

        const after = options();
        expectUnavailable(await runLinuxEasyLoginSession(f.lease, after));
        expectNoCallbacks(after);
        expect(f.count()).toBe(2);
        expect(f.poison).not.toHaveBeenCalled();
    });

    it('rejects synchronous key-policy reentry before any additional transaction', async () => {
        const f = setup();
        const winner = options();
        const duplicate = options();
        let nested: Promise<LinuxEasyLoginSessionResult> | undefined;
        let before = -1;
        let after = -1;
        winner.acceptKeyExchange = vi.fn(() => {
            before = f.count();
            nested = runLinuxEasyLoginSession(f.lease, duplicate);
            after = f.count();
            return true;
        });

        const result = await runLinuxEasyLoginSession(f.lease, winner);
        expect(nested).toBeDefined();
        expectUnavailable(await nested!);
        expect([before, after]).toEqual([1, 1]);
        expectSuccess(result);
        expect(f.calls).toEqual([KEY_EXCHANGE_COMMAND, LINUX_EASY_LOGIN_COMMAND]);
        expect(f.count()).toBe(2);
        expect(f.poison).not.toHaveBeenCalled();
        expect(f.errors).toEqual([]);
        expect(winner.acceptKeyExchange).toHaveBeenCalledOnce();
        expectNoCallbacks(duplicate);
    });

    it('stops before Easy when policy aborts synchronously and then returns true', async () => {
        const f = setup();
        const winner = options();
        const controller = new AbortController();
        winner.signal = controller.signal;
        winner.acceptKeyExchange = vi.fn(() => {
            controller.abort();
            return true;
        });

        const result = await runLinuxEasyLoginSession(f.lease, winner);
        expect(result).toEqual({
            kind: 'failure',
            stage: 'key-policy',
            code: 'cancelled',
            keyExchangeWrite: 'written',
            easyLoginWrite: 'not-started',
            poison: 'requested',
        });
        expect(f.calls).toEqual([KEY_EXCHANGE_COMMAND]);
        expect(f.count()).toBe(1);
        expect(f.poison).toHaveBeenCalledOnce();
        expect(winner.buildReserved).toHaveBeenCalledOnce();
        expect(winner.acceptKeyExchange).toHaveBeenCalledOnce();
        expect(f.errors).toEqual([]);
        const after = options();
        expectUnavailable(await runLinuxEasyLoginSession(f.lease, after));
        expectNoCallbacks(after);
        expect(f.count()).toBe(1);
        expect(f.poison).toHaveBeenCalledOnce();
    });

    it('rejects synchronous poison reentry and retains the claim after failure', async () => {
        const f = setup();
        const winner = options();
        const duplicate = options();
        let nested: Promise<LinuxEasyLoginSessionResult> | undefined;
        let before = -1;
        let after = -1;
        f.setOnPoison(() => {
            before = f.count();
            nested = runLinuxEasyLoginSession(f.lease, duplicate);
            after = f.count();
        });
        winner.acceptKeyExchange = vi.fn(() => false);

        const result = await runLinuxEasyLoginSession(f.lease, winner);
        expect(result).toEqual({
            kind: 'failure',
            stage: 'key-policy',
            code: 'key-policy-rejected',
            keyExchangeWrite: 'written',
            easyLoginWrite: 'not-started',
            poison: 'requested',
        });
        expect(nested).toBeDefined();
        expectUnavailable(await nested!);
        expect([before, after]).toEqual([1, 1]);
        expect(f.calls).toEqual([KEY_EXCHANGE_COMMAND]);
        expect(f.count()).toBe(1);
        expect(f.poison).toHaveBeenCalledOnce();
        expect(f.errors).toEqual([]);
        expect(winner.acceptKeyExchange).toHaveBeenCalledOnce();
        expectNoCallbacks(duplicate);

        const afterFailure = options();
        expectUnavailable(await runLinuxEasyLoginSession(f.lease, afterFailure));
        expectNoCallbacks(afterFailure);
        expect(f.count()).toBe(1);
        expect(f.poison).toHaveBeenCalledOnce();
    });
});
