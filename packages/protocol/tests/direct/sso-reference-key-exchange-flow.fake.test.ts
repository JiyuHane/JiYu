import { createCipheriv, createDecipheriv, createECDH, createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { KEY_EXCHANGE_COMMAND } from '../../src/direct/key-exchange-flow';
import {
    decodeKeyExchangeRequest,
    decodeKeyExchangeRequestBuf,
    encodeKeyExchangeResponse,
    encodeKeyExchangeResponseSecret,
} from '../../src/direct/key-exchange-protobuf';
import { qqTeaDecrypt, qqTeaEncrypt } from '../../src/direct/qq-tea';
import { referenceKeyExchangeOnTransport } from '../../src/direct/sso-reference-key-exchange-flow';
import type {
    Sso12RawOptions,
    Sso12RawResult,
    Sso12RawTransport,
} from '../../src/direct/sso12-packet-client';

// Synthetic peers and memory-only transport. This does not test network writes,
// authentication, replay resistance, a real account, or a live server.
const account = '123456';
const zeroKey = new Uint8Array(16);
const sessionKey = Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i);
const sessionTicket = Uint8Array.from({ length: 24 }, (_, i) => 0x60 + i);

const word = (n: number): Buffer => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(n >>> 0);
    return out;
};

const field = (data: Uint8Array): Buffer => Buffer.concat([word(data.length + 4), data]);
const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
const wiped = (value: Uint8Array): boolean => value.every((byte) => byte === 0);

type Options = Parameters<typeof referenceKeyExchangeOnTransport>[1];
type FailureCase =
    | 'account'
    | 'sequence'
    | 'command'
    | 'retCode'
    | 'dummy'
    | 'tea'
    | 'tag'
    | 'truncated'
    | 'protocol';

function peer(scalar: number) {
    const ecdh = createECDH('prime256v1');
    const key = Buffer.alloc(32);
    key[31] = scalar;
    ecdh.setPrivateKey(key);
    return ecdh;
}

function encryptGcm(plain: Uint8Array, key: Uint8Array): Buffer {
    const nonce = Buffer.alloc(12, 0x42);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function decryptGcm(encoded: Uint8Array, key: Uint8Array): Buffer {
    const input = Buffer.from(encoded);
    const decipher = createDecipheriv('aes-256-gcm', key, input.subarray(0, 12));
    decipher.setAuthTag(input.subarray(-16));
    return Buffer.concat([decipher.update(input.subarray(12, -16)), decipher.final()]);
}

function unpack(frameBytes: Uint8Array) {
    const frame = Buffer.from(frameBytes);
    expect(frame.readUInt32BE(0)).toBe(frame.length);
    expect(frame.readUInt32BE(4)).toBe(12);
    expect(frame[8]).toBe(2);
    expect(frame.readUInt32BE(9)).toBe(4);
    expect(frame[13]).toBe(0);
    const accountEnd = 14 + frame.readUInt32BE(14);
    const uin = frame.subarray(18, accountEnd).toString();
    const sso = Buffer.from(qqTeaDecrypt(frame.subarray(accountEnd), zeroKey));
    const seq = sso.readInt32BE(4);
    const subAppId = sso.readInt32BE(8);
    let offset = 4 + 4 + 4 + 4 + 12;

    const take = (width: 2 | 4 = 4): Buffer => {
        const size = width === 2 ? sso.readUInt16BE(offset) : sso.readUInt32BE(offset);
        expect(size).toBeGreaterThanOrEqual(width);
        expect(offset + size).toBeLessThanOrEqual(sso.length);
        const value = sso.subarray(offset + width, offset + size);
        offset += size;
        return value;
    };

    const a2 = take();
    const command = take().toString();
    take();
    const guid = take().toString();
    take();
    const version = take(2).toString();
    const reserved = take();
    expect(offset).toBe(sso.readUInt32BE(0));
    const body = take();
    expect(offset).toBe(sso.length);
    return { uin, seq, subAppId, a2, command, guid, version, reserved, body };
}

function reply(requestBody: Uint8Array, sequence: number, fault?: FailureCase): Uint8Array {
    const request = decodeKeyExchangeRequest(requestBody);
    const responsePeer = peer(2);
    const shared = responsePeer.computeSecret(request.publicKey!);
    const secret = encodeKeyExchangeResponseSecret({ sessionKey, sessionTicket, expiration: 300 });
    const encrypted = encryptGcm(secret, shared);

    if (fault === 'tag') {
        encrypted[encrypted.length - 1] ^= 0x80;
    }

    const body = encodeKeyExchangeResponse({
        publicKey: responsePeer.getPublicKey(),
        secret: encrypted,
    });
    const header = Buffer.concat([
        word(fault === 'sequence' ? sequence + 1 : sequence),
        word(fault === 'retCode' ? 1 : 0),
        field(Buffer.alloc(0)),
        field(Buffer.from(fault === 'command' ? 'wrong-command' : KEY_EXCHANGE_COMMAND)),
        field(Buffer.alloc(0)),
        word(0),
        field(Buffer.alloc(0)),
    ]);
    const inner = Buffer.concat([field(header), field(body)]);
    const encryptedInner = Buffer.from(qqTeaEncrypt(inner, zeroKey));

    if (fault === 'tea') {
        encryptedInner.fill(0);
    }

    const frame = Buffer.concat([
        word(0),
        word(fault === 'protocol' ? 11 : 12),
        Buffer.of(2, fault === 'dummy' ? 1 : 0),
        field(Buffer.from(fault === 'account' ? '654321' : account)),
        encryptedInner,
    ]);
    frame.writeUInt32BE(frame.length);
    return Uint8Array.from(fault === 'truncated' ? frame.subarray(0, frame.length - 3) : frame);
}

function fixture() {
    const server = peer(1);
    const reserved = Uint8Array.of(0xaa, 0, 0xfe);
    const options: Options = {
        uin: account,
        guid: Uint8Array.of(1, 2, 3, 4),
        a2: Uint8Array.of(0, 0xff, 0x80, 3),
        version: 'synthetic-version',
        subAppId: 1234,
        serverPublicKey: Uint8Array.from(server.getPublicKey()),
        verifyKey: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
        timestamp: 1700000000,
        timeoutMs: 5000,
        buildReserved: () => reserved,
        verifyRaw: () => true,
        verifyServerResponse: () => true,
    };
    return { options, server, reserved };
}

class Fake implements Sso12RawTransport {
    calls = 0;
    close = vi.fn();
    sequence = 123;
    mode:
        | 'normal'
        | 'initialUin'
        | 'identityUin'
        | 'identitySequence'
        | 'duplicateBuild'
        | 'duplicateVerify'
        | 'duplicateConsume'
        | 'skip'
        | 'swap' = 'normal';
    fault?: FailureCase;
    frame?: Uint8Array;
    candidate?: Uint8Array;
    candidateBefore?: Uint8Array;
    consumeCalls = 0;
    beforeBuild?: () => Promise<void>;

    async transactRaw<C, T>(o: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
        this.calls++;
        const identity = {
            uin: this.mode === 'initialUin' ? '987654' : account,
            sequence: this.sequence,
        };

        try {
            await this.beforeBuild?.();
            const built = await o.buildRequest(identity);
            this.frame = Uint8Array.from(built.frame);

            if (this.mode === 'skip') {
                return {
                    kind: 'response',
                    sequence: this.sequence,
                    value: 'forged' as T,
                    writeState: 'written',
                };
            }

            if (this.mode === 'duplicateBuild') {
                await o.buildRequest(identity);
            }

            this.candidate = reply(unpack(this.frame).body, this.sequence, this.fault);
            this.candidateBefore = Uint8Array.from(this.candidate);
            const observed =
                this.mode === 'identityUin'
                    ? { ...identity, uin: '123' }
                    : this.mode === 'identitySequence'
                      ? { ...identity, sequence: 5 }
                      : identity;
            const accepted = await o.verifyCandidate(this.candidate, built.context, observed);

            if (!accepted) {
                return { kind: 'failure', code: 'rejected', writeState: 'unknown' };
            }

            if (this.mode === 'duplicateVerify') {
                await o.verifyCandidate(this.candidate, built.context, identity);
            }

            const candidate = this.mode === 'swap' ? Uint8Array.of(1, 2, 3) : this.candidate;
            this.consumeCalls++;
            const value = await o.consumeCandidate(candidate, built.context, identity);

            if (this.mode === 'duplicateConsume') {
                await o.consumeCandidate(candidate, built.context, identity);
            }

            return { kind: 'response', sequence: this.sequence, value, writeState: 'written' };
        } catch {
            return { kind: 'failure', code: 'callback-failed', writeState: 'unknown' };
        }
    }
}

async function nonSuccess(
    promise: ReturnType<typeof referenceKeyExchangeOnTransport>,
): Promise<void> {
    const result = await promise.catch(() => ({ kind: 'rejected' as const }));
    expect(result.kind).not.toBe('response');
}

describe('borrowed reference key exchange with synthetic transport', () => {
    it.each([123, 0x80000000, 0xffffffff])(
        'binds uint32 sequence %#, snapshots inputs and wipes borrowed copies',
        async (sequence) => {
            const { options, server, reserved } = fixture();
            const fake = new Fake();
            fake.sequence = sequence;
            const original = {
                guid: Uint8Array.from(options.guid),
                a2: Uint8Array.from(options.a2!),
                server: Uint8Array.from(options.serverPublicKey),
                verify: Uint8Array.from(options.verifyKey),
            };
            let release!: () => void;
            let entered!: () => void;
            const ready = new Promise<void>((resolve) => {
                entered = resolve;
            });
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });

            fake.beforeBuild = async () => {
                entered();
                await gate;
            };

            let signing!: Uint8Array;
            let signedBody!: Uint8Array;
            let verifyingRequest!: Uint8Array;
            let verifyingResponse!: Uint8Array;
            const serverVerify = vi.fn(
                (_input: Parameters<Options['verifyServerResponse']>[0]) => true,
            );
            options.verifyServerResponse = serverVerify;

            options.buildReserved = async (input) => {
                expect(input).toMatchObject({
                    uin: account,
                    sequence,
                    command: KEY_EXCHANGE_COMMAND,
                });
                signing = input.body;
                signedBody = Uint8Array.from(input.body);
                await Promise.resolve();
                return reserved;
            };

            options.verifyRaw = async (input) => {
                expect(input).toMatchObject({
                    uin: account,
                    sequence,
                    command: KEY_EXCHANGE_COMMAND,
                });
                verifyingRequest = input.requestFrame;
                verifyingResponse = input.responseFrame;
                expect(equalBytes(input.requestFrame, fake.frame!)).toBe(true);
                expect(equalBytes(input.responseFrame, fake.candidateBefore!)).toBe(true);
                // Both are callback copies; even a hostile verifier must not alter the candidate.
                input.requestFrame.fill(0x11);
                input.responseFrame.fill(0x22);
                await Promise.resolve();
                return true;
            };

            const pending = referenceKeyExchangeOnTransport(fake, options);
            await ready;
            options.guid.fill(0xee);
            options.a2!.fill(0xdd);
            options.serverPublicKey.fill(0xcc);
            options.verifyKey.fill(0xbb);
            options.uin = '987654';
            options.version = 'changed';
            options.subAppId = 9;
            options.timestamp = 1;
            options.verifyServerResponse = () => false;
            release();
            const result = await pending;
            expect(result.kind).toBe('response');

            if (result.kind !== 'response') {
                return;
            }

            expect(result.sequence).toBe(sequence);
            expect(equalBytes(result.value.sessionKey, sessionKey)).toBe(true);
            expect(equalBytes(result.value.sessionTicket, sessionTicket)).toBe(true);
            expect(result.value.expiration).toBe(300);
            const parsed = unpack(fake.frame!);
            expect(parsed).toMatchObject({
                uin: account,
                seq: sequence | 0,
                subAppId: 1234,
                command: KEY_EXCHANGE_COMMAND,
                guid: Buffer.from(original.guid).toString('hex'),
                version: 'synthetic-version',
            });
            expect(equalBytes(parsed.a2, original.a2)).toBe(true);
            expect(equalBytes(parsed.reserved, reserved)).toBe(true);
            expect(equalBytes(parsed.body, signedBody)).toBe(true);
            const request = decodeKeyExchangeRequest(parsed.body);
            expect(request.timestamp).toBe(1700000000n);
            const expectedHash = createHash('sha256')
                .update(request.publicKey!)
                .update(word(1))
                .update(request.secret!)
                .update(word(0))
                .update(word(1700000000))
                .digest();
            expect(equalBytes(decryptGcm(request.verifyHash!, original.verify), expectedHash)).toBe(
                true,
            );
            const secret = decodeKeyExchangeRequestBuf(
                decryptGcm(request.secret!, server.computeSecret(request.publicKey!)),
            );
            expect(secret.uin).toBe(account);
            expect(equalBytes(secret.guid!, original.guid)).toBe(true);
            expect(serverVerify).toHaveBeenCalledOnce();
            expect(serverVerify.mock.calls[0]![0]).toMatchObject({ uin: account, sequence });
            expect(equalBytes(fake.candidate!, fake.candidateBefore!)).toBe(true);
            expect([signing, verifyingRequest, verifyingResponse].every(wiped)).toBe(true);
            expect(equalBytes(reserved, Uint8Array.of(0xaa, 0, 0xfe))).toBe(true);
            expect(options.guid.every((v) => v === 0xee)).toBe(true);
            expect(options.a2!.every((v) => v === 0xdd)).toBe(true);
            expect(options.serverPublicKey.every((v) => v === 0xcc)).toBe(true);
            expect(options.verifyKey.every((v) => v === 0xbb)).toBe(true);

            for (const returned of [result.value.sessionKey, result.value.sessionTicket]) {
                for (const borrowed of [
                    signing,
                    verifyingRequest,
                    verifyingResponse,
                    fake.frame!,
                    fake.candidate!,
                    signedBody,
                ]) {
                    expect(returned.buffer).not.toBe(borrowed.buffer);
                }
            }

            expect(result.value.sessionKey.buffer).not.toBe(result.value.sessionTicket.buffer);
            expect(fake.calls).toBe(1);
            expect(fake.close).not.toHaveBeenCalled();
        },
    );

    it('rejects a signer that changes its borrowed body before returning reserved bytes', async () => {
        const fake = new Fake();
        const { options, reserved } = fixture();
        let borrowed!: Uint8Array;
        options.buildReserved = vi.fn(({ body }) => {
            borrowed = body;
            body[0] ^= 0xff;
            return reserved;
        });
        options.verifyRaw = vi.fn(() => true);
        options.verifyServerResponse = vi.fn(() => true);
        await nonSuccess(referenceKeyExchangeOnTransport(fake, options));
        expect(options.buildReserved).toHaveBeenCalledOnce();
        expect(fake.frame).toBeUndefined();
        expect(fake.consumeCalls).toBe(0);
        expect(options.verifyRaw).not.toHaveBeenCalled();
        expect(options.verifyServerResponse).not.toHaveBeenCalled();
        expect(wiped(borrowed)).toBe(true);
        expect(equalBytes(reserved, Uint8Array.of(0xaa, 0, 0xfe))).toBe(true);
    });

    it('rejects an initial transport identity mismatch before invoking the signer', async () => {
        const fake = new Fake();
        fake.mode = 'initialUin';
        const { options } = fixture();
        options.buildReserved = vi.fn(() => Uint8Array.of(1));
        await nonSuccess(referenceKeyExchangeOnTransport(fake, options));
        expect(options.buildReserved).not.toHaveBeenCalled();
        expect(fake.frame).toBeUndefined();
    });

    it.each([
        'identityUin',
        'identitySequence',
        'duplicateBuild',
        'duplicateVerify',
        'duplicateConsume',
        'skip',
        'swap',
    ] as const)('rejects a transport that violates callback guard: %s', async (mode) => {
        const fake = new Fake();
        fake.mode = mode;
        await nonSuccess(referenceKeyExchangeOnTransport(fake, fixture().options));
        expect(fake.calls).toBe(1);
        expect(fake.close).not.toHaveBeenCalled();
    });

    it.each(['false', 'throw'] as const)(
        'does not consume when verifyRaw returns %s',
        async (mode) => {
            const fake = new Fake();
            const { options } = fixture();
            let request!: Uint8Array;
            let response!: Uint8Array;
            options.verifyRaw = vi.fn((input) => {
                request = input.requestFrame;
                response = input.responseFrame;
                input.requestFrame.fill(1);
                input.responseFrame.fill(2);

                if (mode === 'throw') {
                    throw new Error('synthetic raw failure');
                }

                return false;
            });
            await nonSuccess(referenceKeyExchangeOnTransport(fake, options));
            expect(options.verifyRaw).toHaveBeenCalledOnce();
            expect(fake.consumeCalls).toBe(0);
            expect(equalBytes(fake.candidate!, fake.candidateBefore!)).toBe(true);
            expect(wiped(request)).toBe(true);
            expect(wiped(response)).toBe(true);
        },
    );

    it.each(['false', 'throw'] as const)(
        'does not commit tickets when server verifier returns %s',
        async (mode) => {
            const fake = new Fake();
            const { options } = fixture();
            options.verifyServerResponse = vi.fn(() => {
                if (mode === 'throw') {
                    throw new Error('synthetic server verification failure');
                }

                return false;
            });
            await nonSuccess(referenceKeyExchangeOnTransport(fake, options));
            expect(options.verifyServerResponse).toHaveBeenCalledOnce();
        },
    );

    it.each([
        'account',
        'sequence',
        'command',
        'retCode',
        'dummy',
        'tea',
        'tag',
        'truncated',
        'protocol',
    ] as const)('does not commit tickets from invalid response: %s', async (fault) => {
        const fake = new Fake();
        fake.fault = fault;
        await nonSuccess(referenceKeyExchangeOnTransport(fake, fixture().options));
    });

    it('revokes and wipes a pending signer after transport settles early', async () => {
        const { options } = fixture();
        let signing!: Uint8Array;
        let release!: (bytes: Uint8Array) => void;
        let background!: Promise<unknown>;

        options.buildReserved = ({ body }) => {
            signing = body;
            return new Promise((resolve) => {
                release = resolve;
            });
        };

        const transport: Sso12RawTransport = {
            async transactRaw<C, T>(o: Sso12RawOptions<C, T>): Promise<Sso12RawResult<T>> {
                background = Promise.resolve(o.buildRequest({ uin: account, sequence: 123 })).catch(
                    () => undefined,
                );
                return { kind: 'failure', code: 'early', writeState: 'not-written' };
            },
        };
        await nonSuccess(referenceKeyExchangeOnTransport(transport, options));
        expect(wiped(signing)).toBe(true);
        release(Uint8Array.of(1));
        await background;
        expect(wiped(signing)).toBe(true);
    });

    it('returns a pre-abort failure without entering the fake transport', async () => {
        const fake = new Fake();
        const { options } = fixture();
        const controller = new AbortController();
        controller.abort();
        options.signal = controller.signal;
        await nonSuccess(referenceKeyExchangeOnTransport(fake, options));
        expect(fake.calls).toBe(0);
    });

    it('copies a large byte view without evaluating its extra accessor', async () => {
        const { options } = fixture();
        const getter = vi.fn(() => {
            throw new Error('must not read extra property');
        });
        options.guid = new Uint8Array(512 * 1024).fill(0x5a);
        Object.defineProperty(options.guid, 'unrelated', { get: getter });
        const original = options.guid;
        const transport: Sso12RawTransport = {
            async transactRaw() {
                return { kind: 'failure', code: 'synthetic-stop', writeState: 'not-written' };
            },
        };
        await nonSuccess(referenceKeyExchangeOnTransport(transport, options));
        expect(getter).not.toHaveBeenCalled();
        expect(original[0]).toBe(0x5a);
        expect(original[original.length - 1]).toBe(0x5a);
    });

    it.each([
        [
            'empty guid',
            (o: Options) => {
                o.guid = new Uint8Array();
            },
        ],
        [
            'invalid verification key',
            (o: Options) => {
                o.verifyKey = new Uint8Array(31);
            },
        ],
        [
            'invalid server key',
            (o: Options) => {
                o.serverPublicKey = new Uint8Array(65);
            },
        ],
        [
            'invalid timestamp',
            (o: Options) => {
                o.timestamp = -1;
            },
        ],
        [
            'invalid uin',
            (o: Options) => {
                o.uin = 'invalid';
            },
        ],
    ] as const)('normalizes invalid configuration: %s', async (_name, mutate) => {
        const fake = new Fake();
        const { options } = fixture();
        mutate(options);
        await nonSuccess(referenceKeyExchangeOnTransport(fake, options));
    });
});
